/**
 * dsh-agent-shell —— 宿主侧（host half）
 *
 * 持久的后台 shell，与 DSH 的对话**解耦**：
 *
 *   1. 生命周期 —— 本插件挂在 profile（Host 平面），tmux 服务端归它所有，
 *      随 harness 进程启停，不随任何会话建立或销毁。
 *   2. 面板块位 —— 客户端注册进 `shell.overlay`（root 作用域），切会话、乃至
 *      无会话时都在。
 *   3. 数据通道 —— 同源 HTTP（`ctx.inject(['webServer'])`），浏览器直连宿主，
 *      不经过任何会话，也不用绑定 plugin run 的 package-private RPC。
 *
 * 另有两条兜底：`bootstrap()` 在启动时清孤儿并布防脱离进程树的看门狗；
 * `ctx.effect` 的 dispose 在卸载时停看门狗并杀服务端。
 *
 * 兼容性红线：不 provide 任何单实现服务；除 `tools` 外全部 ctx.get() 探测，缺了就降级。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { TmuxDriver } from './tmux.js'

export const name = 'dsh-agent-shell'

/** 只硬依赖 tools（工具注册）；其余服务全部探测。 */
export const inject = ['tools']

/** 会话名自身前缀，避免与任何手工 tmux 会话混淆。 */
const NAME_PREFIX = 'dsh-'

export const Config = z.object({
  socket: z.string().default('dsh-agent'),
  httpBase: z.string().default('/plugins/shell'),
  exposeHttp: z.boolean().default(true),
  exposeTools: z.boolean().default(true),
  watchdog: z.boolean().default(true),
  shell: z.string().default('bash'),
  defaultTerminal: z.string().default('tmux-256color'),
  cols: z.number().default(120),
  rows: z.number().default(32),
  historyLimit: z.number().default(100000),
  maxSessions: z.number().default(8),
  defaultCwd: z.string().default(''),
  guardDangerousCommands: z.boolean().default(true),
  /**
   * 服务端开启 `extended-keys`（默认关）。
   *
   * 需要 tmux ≥ 3.2；开了之后 TUI（pi、codex 之类）才能收到 Shift+Enter 这类**带修饰键**
   * 的按键（不开时它们会打印 "tmux extended-keys is off … modified Enter keys may not work"）。
   * 默认关闭是刻意的：老版本 tmux 不认这个选项，而它写在 `-f` 启动配置里 ——
   * 未知选项会让**服务端起不来**。要用就自己确认版本后再开。
   */
  extendedKeys: z.boolean().default(false),
})

/** 高危命令模式：启发式减速带，不是沙箱。 */
const DANGEROUS = [
  { pattern: /\brm\s+(-\S+\s+)*(--\s+)?(\/\*?|~\/?|\$HOME\/?|\*)(\s|$)/, reason: 'recursive delete of a root, home, or wildcard target' },
  { pattern: /--no-preserve-root/, reason: 'disabling the rm root-delete failsafe' },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: 'filesystem format' },
  { pattern: /\bdd\b[^;&|]*\bof=\/dev\//, reason: 'raw write to a block device' },
  { pattern: />\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: 'overwrite of a block device' },
  { pattern: /:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*\}/, reason: 'fork bomb' },
  { pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*7{3,4}\s+\//, reason: 'world-writable root permissions' },
  { pattern: /\b(sudo|doas|su)\b/, reason: 'privilege escalation' },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/, reason: 'machine shutdown or reboot' },
  { pattern: /\b(curl|wget)\b[^;&|]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, reason: 'pipe a download straight into a shell' },
]

function scanDanger(candidate) {
  for (const entry of DANGEROUS) {
    if (entry.pattern.test(candidate)) return entry.reason
  }
  return null
}

/** 立刻可写进 UI 的会话快照（只取标量，不带任何宿主对象）。 */
function toSnapshot(session, screen, previous) {
  return {
    ...session,
    screen,
    revision: previous === undefined ? 1 : previous.revision + 1,
  }
}

export function apply(ctx, config) {
  const resolved = {
    socket: config.socket ?? 'dsh-agent',
    httpBase: String(config.httpBase ?? '/plugins/shell').replace(/\/+$/, ''),
    exposeHttp: config.exposeHttp !== false,
    exposeTools: config.exposeTools !== false,
    watchdog: config.watchdog !== false,
    shell: config.shell ?? 'bash',
    defaultTerminal: config.defaultTerminal ?? 'tmux-256color',
    cols: config.cols ?? 120,
    rows: config.rows ?? 32,
    historyLimit: config.historyLimit ?? 100000,
    maxSessions: config.maxSessions ?? 8,
    defaultCwd: String(config.defaultCwd ?? ''),
    guard: config.guardDangerousCommands !== false,
    extendedKeys: config.extendedKeys === true,
  }

  const subprocess = ctx.get('subprocess')
  const timer = ctx.get('timer')
  if (subprocess === undefined) {
    console.error('dsh-agent-shell: the subprocess service is not mounted; the shell panel is inactive')
    return
  }

  const driver = new TmuxDriver({
    subprocess,
    timer,
    socket: resolved.socket,
    historyLimit: resolved.historyLimit,
    shell: resolved.shell,
    defaultTerminal: resolved.defaultTerminal,
    extendedKeys: resolved.extendedKeys,
    cwd: '/',
    pidFile: `/tmp/${resolved.socket}-watchdog.pid`,
  })

  const state = {
    cwd: resolved.defaultCwd,
    watchdogPid: '',
    watchedPid: '',
    /** 启动时保住（而不是清掉）的会话名 —— 见 TmuxDriver#bootstrap。 */
    keptOnBoot: [],
    adopted: false,
    ready: false,
  }

  // ── 启动收尾：布防看门狗（**不清理任何会话**）───────────────────────────────
  ;(async function start() {
    try {
      if (state.cwd === '') {
        const home = await driver.run(['sh', '-c', 'echo $HOME'], { cwd: '/', cap: 4096 })
        state.cwd = home.out.trim() || '/'
      }
      // 配置文件必须先落地：服务端由后续第一条 tmux 命令启动，启动时读它。
      await driver.writeServerConfig()
      if (resolved.watchdog) {
        const result = await driver.bootstrap()
        state.watchedPid = result.harnessPid
        state.watchdogPid = result.watchdogPid
        state.adopted = result.adopted
        state.keptOnBoot = result.kept
        if (result.adopted) {
          console.log(`dsh-agent-shell: adopted the existing watchdog (pid ${result.watchdogPid}) for harness pid ${result.harnessPid}`)
        } else if (result.kept.length > 0) {
          console.log(`dsh-agent-shell: re-armed watchdog as pid ${result.watchdogPid}; kept ${result.kept.length} session(s): ${result.kept.join(', ')}`)
        } else {
          console.log(`dsh-agent-shell: watchdog armed as pid ${result.watchdogPid} (harness ${result.harnessPid})`)
        }
      }
      state.ready = true
    } catch (error) {
      console.error(`dsh-agent-shell: startup failed: ${String(error)}`)
      state.ready = true
    }
  })()

  // ── 看门狗自愈 ──────────────────────────────────────────────────────────────
  //
  // 实测过一种静默失效：看门狗进程自己退出（它的存活判定当时只容一次失败），此后
  // 插件的内存状态仍是旧值，**再没有任何孤儿兜底，而且没有任何人知道**。
  // 所以每次操作顺手检查一次「看门狗还在不在」，不在就重新布防。
  //
  // 用时间戳节流：面板每 700ms 轮询一次 /list，而 /keys 是**每次按键**一次请求，
  // 不节流就等于每次敲键都 spawn 两个子进程去读 pid 文件。5 秒是折中 ——
  // 面板开着时约每 5 秒两次极轻的子进程调用，而保护最多失效 5 秒。
  const WATCHDOG_RECHECK_MS = 5000
  let watchdogCheckedAt = 0
  let watchdogUnavailableLogged = false
  async function ensureWatchdog() {
    if (!resolved.watchdog) return
    const now = Date.now()
    if (now - watchdogCheckedAt < WATCHDOG_RECHECK_MS) return
    watchdogCheckedAt = now
    try {
      const alive = await driver.watchdogPid()
      if (alive !== '') {
        // 已被新实例接管时同步一下内存状态，免得 /list 一直报旧 pid
        if (alive !== state.watchdogPid) {
          state.watchdogPid = alive
          state.adopted = true
        }
        return
      }
      const watched = await driver.armWatchdog()
      state.watchedPid = watched
      state.watchdogPid = await driver.watchdogPid()
      state.adopted = false
      if (state.watchdogPid !== '') {
        console.log(`dsh-agent-shell: watchdog was gone; re-armed as pid ${state.watchdogPid} (harness ${watched})`)
      } else if (!watchdogUnavailableLogged) {
        // 找不到 harness 进程（例如插件被独立加载去做测试）时无法布防。只提醒一次，
        // 免得每 5 秒刷一行 —— 但必须说出来，静默失去孤儿兜底正是 0.1.1 修的毛病。
        watchdogUnavailableLogged = true
        console.error('dsh-agent-shell: no harness process found; the orphan watchdog is not armed')
      }
    } catch (error) {
      console.error(`dsh-agent-shell: watchdog check failed: ${String(error)}`)
    }
  }

  // ── 卸载：刻意什么都不做 ────────────────────────────────────────────────────
  //
  // dispose 会在**每一次配置热重载**时执行。若在这里 kill-server，用户每次改一行
  // 配置都会丢掉全部 shell —— 实测确认过这个顺序：重载时新实例先 apply、旧实例后
  // dispose，所以旧 dispose 还会连带杀掉新实例刚布防的看门狗。
  //
  // 会话本该在热重载中存活。真正需要收尾的时刻是 harness 进程结束，那是看门狗的
  // 职责。要主动清空请用 POST <httpBase>/kill 逐个关，或调用 shell_close。
  ctx.effect(() => () => {
    console.log('dsh-agent-shell: unloading — sessions and the watchdog are intentionally kept')
  }, 'dsh-agent-shell: keep sessions across reloads')

  // ── 共享逻辑（HTTP 与工具都走它）──────────────────────────────────────────

  async function openShell(args = {}) {
    await ensureWatchdog()
    const sessions = await driver.list()
    if (sessions.length >= resolved.maxSessions) {
      throw new Error(`session limit reached (${resolved.maxSessions}); close one first`)
    }
    // 名字**必须**与 rename 共用同一套净化规则（sanitizeName）。
    // 这不是洁癖：tmux 会把名字里的 `.` 和 `:` 悄悄换成 `_`，而插件记的是自己算出来的名字 ——
    // 一旦名字里带点（旧实现允许），插件眼中的名字与 tmux 里的真实名字就不一致，
    // 之后所有按名字的操作都会以 `can't find pane: …` 失败（实测踩到，会话直接失联）。
    const requested = typeof args.name === 'string' && args.name.trim().length > 0
      ? sanitizeName(args.name)
      : ''
    const base = requested !== ''
      ? requested
      : NAME_PREFIX + Math.random().toString(36).slice(2, 8)
    let name = base
    let n = 2
    while (await driver.has(name)) {
      name = `${base}-${n}`
      n += 1
    }
    const cols = clampCols(args.cols, resolved.cols)
    const rows = clampRows(args.rows, resolved.rows)
    const cwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : state.cwd
    // tmux 对不存在的 -c **不报错**，只会静默回落到 home —— 那样返回的 cwd 就是假的，
    // 调用方会以为自己在目标目录里跑命令。所以自己先挡一道，给出可执行的错误。
    if (cwd !== '' && !(await driver.isDirectory(cwd))) {
      throw new Error(`no such directory: ${cwd}`)
    }
    // 服务端由 create() 启动，启动时读 -f 指定的配置文件（history-limit 由此生效）。
    await driver.create({ name, cols, rows, cwd })
    await driver.pause(600)
    return { name, cols, rows, cwd, screen: await driver.screen(name) }
  }

  /**
   * 把用户输入的名字净化成 tmux 能原样接受的形式。
   *
   * tmux 会把 `.` 和 `:` 悄悄替换掉，那样 UI 显示的名字和真实名字就对不上了（后续
   * 按名字 kill / send 会找不到会话）。所以在这里一次性换掉，并统一带上 `dsh-` 前缀。
   */
  function sanitizeName(raw) {
    const cleaned = String(raw)
      .trim()
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40)
    if (cleaned.length === 0) return ''
    return cleaned.startsWith(NAME_PREFIX) ? cleaned : NAME_PREFIX + cleaned
  }

  /**
   * 统一的「这个会话必须存在」检查。
   *
   * 存在的意义只有一个：**错误信息一致且可读**。直接让 tmux 去报，用户会拿到
   * `cannot read session "x": can't find pane: x` 这类内部措辞；模型读到它也不知道
   * 该改成什么。所有按名字操作的工具都从这里过一遍。
   */
  async function requireSession (name) {
    if (String(name).length === 0) throw new Error('name must be a non-empty string')
    if (!(await driver.has(name))) throw new Error(`no such session: ${name}`)
    return name
  }

  /**
   * 终端尺寸的上下界夹取。
   *
   * 下界是为了 tmux 能建出可用窗格；**上界同样必要**：tmux 对 `-x/-y` 并非无限制，
   * 超大值会直接以 `tmux new-session failed: width too large` 失败，而那条错误对
   * 调用方毫无指导意义（实测 cols=100000 就是这样）。1000×500 远超任何真实显示器，
   * 夹到它既不会误伤正常请求，也把「荒谬输入」变成可预期的结果。
   */
  const MAX_COLS = 1000
  const MAX_ROWS = 500
  function clampCols (value, fallback) {
    if (!Number.isFinite(value)) return fallback
    return Math.min(MAX_COLS, Math.max(20, Math.floor(value)))
  }
  function clampRows (value, fallback) {
    if (!Number.isFinite(value)) return fallback
    return Math.min(MAX_ROWS, Math.max(5, Math.floor(value)))
  }

  /** 重命名一个 shell，并返回最终采用的（净化后的）名字。 */
  async function renameShell(args = {}) {
    const from = String(args.name ?? '')
    if (from.length === 0) throw new Error('name is required')
    const to = sanitizeName(args.newName ?? '')
    if (to === '') throw new Error('newName must contain at least one letter, digit, underscore or dash')
    if (to === from) return { ok: true, name: to, changed: false }
    if (!(await driver.has(from))) throw new Error(`no such session: ${from}`)
    if (await driver.has(to)) throw new Error(`a shell named ${to} already exists`)
    await driver.rename(from, to)
    return { ok: true, name: to, changed: true }
  }

  function checkGuard(name, text, keys, confirm) {
    if (!resolved.guard || confirm === true) return null
    const submits = Array.isArray(keys) && (keys.includes('Enter') || keys.includes('C-m'))
    const candidates = []
    if (typeof text === 'string' && text.trim().length > 0) candidates.push(text.trim())
    for (const candidate of candidates) {
      const reason = scanDanger(candidate)
      if (reason !== null) return { reason, candidate }
    }
    return submits ? { pending: true } : null
  }

  async function guardOrRefuse(name, text, keys, confirm) {
    const verdict = checkGuard(name, text, keys, confirm)
    if (verdict === null) return null
    if (verdict.reason !== undefined) {
      return {
        refused: true,
        message:
          `REFUSED (${verdict.reason}).\nDetected in the line about to be submitted:\n  ${verdict.candidate}\n` +
          'Nothing was sent. This check is a heuristic speed bump, not a sandbox - it can be missed by obfuscation ' +
          'and can false-positive on text that merely mentions a pattern.\n' +
          'If this is genuinely intended, get explicit approval from the user and retry with confirm.',
      }
    }
    // 提交时再看一眼当前输入行，拦住分片拼装的命令
    if (verdict.pending === true) {
      let pending = ''
      try { pending = (await driver.screen(name)).split('\n').filter((l) => l.trim().length > 0).pop() ?? '' } catch { pending = '' }
      const reason = pending.trim().length > 0 ? scanDanger(pending.trim()) : null
      if (reason !== null) {
        return {
          refused: true,
          message:
            `REFUSED (${reason}).\nDetected in the line about to be submitted:\n  ${pending.trim()}\n` +
            'Nothing was sent. Retry with confirm after obtaining explicit approval from the user.',
        }
      }
    }
    return null
  }

  async function sendKeys(args) {
    await ensureWatchdog()
    const name = await requireSession(sessionOf(args))
    const text = typeof args.text === 'string' ? args.text : ''
    const preKeys = Array.isArray(args.preKeys) ? args.preKeys : []
    const keys = Array.isArray(args.keys) ? args.keys : []

    const refusal = await guardOrRefuse(name, text, keys, args.confirm)
    if (refusal !== null) return refusal

    await driver.send(name, '', preKeys)
    await driver.send(name, text, keys)
    return { ok: true }
  }

  // ── HTTP：同源，浏览器直连宿主 ─────────────────────────────────────────────
  if (resolved.exposeHttp) {
    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer ?? webCtx.get('webServer')
      if (webServer?.register === undefined) return
      const base = resolved.httpBase

      const json = (res, code, body) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }

      /**
       * 把共享逻辑抛出的错误映射成 HTTP 状态码。
       *
       * 必须区分「调用方写错了」与「插件自己坏了」：前者是 4xx，后者才是 5xx。
       * 实测踩到过：请求体不是合法 JSON、或少了 name 字段，两条都被当成 500 ——
       * 面板与运维会把一次笔误读成服务端故障。
       */
      const errorCode = (error) => {
        const message = String(error?.message ?? error)
        if (/^(name must be|no such session|no such directory|newName must be|session limit reached)/.test(message)) return 400
        return 500
      }

      const readBody = (req) => new Promise((resolve) => {
        const chunks = []
        let size = 0
        req.on('data', (chunk) => {
          size += chunk.length
          if (size > 1024 * 1024) { resolve({}); req.destroy(); return }
          chunks.push(chunk)
        })
        req.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
        })
        req.on('error', () => resolve({}))
      })

      const route = (path, handler) => {
        webCtx.effect(() => webServer.register({ kind: 'exact', path: `${base}${path}`, handler }))
      }

      route('/list', async (_req, res) => {
        try {
          await ensureWatchdog()
          const sessions = await driver.list()
          json(res, 200, {
            sessions,
            server: {
              socket: resolved.socket,
              maxSessions: resolved.maxSessions,
              defaultCwd: state.cwd,
              historyLimit: resolved.historyLimit,
              watchdogPid: state.watchdogPid,
              watchedPid: state.watchedPid,
              adoptedWatchdog: state.adopted,
              keptAtBoot: state.keptOnBoot,
            },
          })
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
        }
      })

      route('/screen', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const name = url.searchParams.get('name') ?? ''
          const lines = Number.parseInt(url.searchParams.get('lines') ?? '', 10)
          if (name.length === 0) { json(res, 400, { error: 'name is required' }); return }
          const screen = await driver.screen(name, Number.isFinite(lines) && lines > 0 ? lines : undefined)
          const sessions = await driver.list()
          const meta = sessions.find((s) => s.name === name)
          json(res, 200, { name, screen, meta: meta ?? null })
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
        }
      })

      route('/keys', async (req, res) => {
        try {
          const body = await readBody(req)
          const result = await sendKeys(body)
          json(res, result.refused === true ? 409 : 200, result)
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
        }
      })

      route('/new', async (req, res) => {
        try {
          const body = await readBody(req)
          json(res, 200, await openShell(body))
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
        }
      })

      route('/kill', async (req, res) => {
        try {
          const body = await readBody(req)
          const name = String(body.name ?? '')
          if (name.length === 0) { json(res, 400, { error: 'name is required' }); return }
          const result = await driver.kill(name)
          // 同样幂等：面板的列表可能稍旧，点 ✕ 时 shell 可能已经自己结束了
          json(res, 200, { ok: true, name, closed: result.closed, reason: result.reason })
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
        }
      })

      route('/resize', async (req, res) => {
        try {
          const body = await readBody(req)
          const name = String(body.name ?? '')
          const cols = clampCols(Number(body.cols), resolved.cols)
          const rows = clampRows(Number(body.rows), resolved.rows)
          if (name.length === 0 || !Number.isFinite(cols) || !Number.isFinite(rows)) {
            json(res, 400, { error: 'name, cols and rows are required' })
            return
          }
          await driver.resize(name, cols, rows)
          json(res, 200, { ok: true })
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
        }
      })

      route('/rename', async (req, res) => {
        try {
          const body = await readBody(req)
          const result = await renameShell(body)
          json(res, 200, result)
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) })
        }
      })

      route('/diagnose', async (_req, res) => {
        try {
          const result = await driver.probe(['list-sessions', '-F', '#{session_name}'])
          json(res, 200, {
            socket: resolved.socket,
            serverRunning: result.code === 0,
            sessionCount: result.code === 0 ? result.out.split('\n').filter((l) => l.length > 0).length : 0,
            harnessPid: await driver.harnessPid(),
            watchdogPid: await driver.watchdogPid(),
            defaultCwd: state.cwd,
            ready: state.ready,
          })
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
        }
      })
    })
  }

  if (!resolved.exposeTools) return

  // ── Agent 工具：任何会话的 agent 都能驱动同一批 shell ─────────────────────
  const text = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
  }

  /**
   * 读出「要操作哪个会话」。
   *
   * 两种调用方用的字段名不同，这里统一收口：
   *   * **模型工具**用 `session` —— 参数 schema 里是 required，`defineTool` 在 execute 之前
   *     就会校验，缺了直接抛 `ToolArgsError`（所以工具路径上 `name` 到不了这里）；
   *   * **HTTP 路由**（面板用它）用 `name` —— 请求体是 `{name, ...}`，直接透传给同样的函数。
   *
   * 优先 `session`（工具语义），退回 `name`（HTTP 语义）。
   */
  const sessionOf = (args = {}) => String(args.session ?? args.name ?? '')

  ctx.tools.register(defineTool({
    name: 'shell_open',
    description: 'Open a persistent background bash and return its first screen. The shell outlives every conversation: it belongs to the harness process, not to this session. Drive it with shell_send and read it with shell_read or shell_history.',
    parameters: {
      name: { type: 'string', description: 'Optional label; a short unique id is generated when omitted.' },
      cols: { type: 'number', description: 'Terminal width in columns.' },
      rows: { type: 'number', description: 'Terminal height in rows.' },
      cwd: { type: 'string', description: 'Initial working directory (defaults to the configured start directory).' },
    },
    output: text,
    async execute(args) {
      const opened = await openShell(args)
      return `session ${opened.name} | ${opened.cols}x${opened.rows} | cwd ${opened.cwd}\n${opened.screen}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_send',
    description: 'Type into a background shell exactly like a human: preKeys first, then the literal text, then keys. Text does NOT submit by itself - pass keys:["Enter"] to run a command. Named keys accept tmux key names (Enter, Tab, Escape, Up, C-c, C-d, F1). A high-risk command is refused unless confirm is true; that check is a heuristic speed bump, not a sandbox.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session name from shell_open or shell_list.' },
      text: { type: 'string', description: 'Literal text, sent after preKeys and before keys.' },
      preKeys: { type: 'array', items: { type: 'string' }, description: 'Keys pressed before the text, e.g. ["i"] for vim insert mode.' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Keys pressed after the text, e.g. ["Enter"].' },
      confirm: { type: 'boolean', description: 'Acknowledge a refused high-risk command after obtaining explicit user approval.' },
      settleMs: { type: 'number', description: 'Milliseconds to wait for the screen to settle (default 900).' },
    },
    output: text,
    async execute(args) {
      const name = sessionOf(args)
      const result = await sendKeys({
        name,
        text: args.text,
        preKeys: args.preKeys,
        keys: args.keys,
        confirm: args.confirm,
      })
      if (result.refused === true) return result.message
      const settleMs = Number.isFinite(args.settleMs) ? Math.max(150, Math.floor(args.settleMs)) : 900
      await driver.pause(settleMs)
      const screen = await driver.screen(name)
      const foreground = await driver.foregroundOf(name)
      const note = foreground === resolved.shell || foreground === `-${resolved.shell}`
        ? '[idle: shell prompt is back]'
        : `[foreground: ${foreground || 'unknown'} - not the shell; it may be waiting for input or still working]`
      return `${note}\n${screen}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_read',
    description: 'Read the current visible screen of a background shell without sending anything.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session name.' },
    },
    output: text,
    async execute(args) {
      const name = await requireSession(sessionOf(args))
      const screen = await driver.screen(name)
      const foreground = await driver.foregroundOf(name)
      const busy = foreground === '' || foreground === resolved.shell ? '' : `\n[foreground: ${foreground} - not the shell]`
      return screen + busy
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_history',
    description: 'Read scrollback above the visible screen, for output that has already scrolled off.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session name.' },
      lines: { type: 'number', description: 'How many lines to read back from the top of the visible screen (default 200).' },
    },
    output: text,
    async execute(args) {
      const name = await requireSession(sessionOf(args))
      const lines = Number.isFinite(args.lines) ? Math.min(100000, Math.max(1, Math.floor(args.lines))) : 200
      return await driver.screen(name, lines)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_list',
    description: 'List every background shell, with size, foreground command and history-buffer usage.',
    parameters: {},
    output: text,
    async execute() {
      await ensureWatchdog()
      const sessions = await driver.list()
      if (sessions.length === 0) return '(no shells)'
      return sessions
        .map((s) => `${s.name}  ${s.cols}x${s.rows}  fg=${s.foreground || '?'}  attached=${s.attached ? 'yes' : 'no'}  buffer=${s.historySize}/${s.historyLimit} lines, ${s.historyBytes}B`)
        .join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_resize',
    description: 'Resize a background shell and return the re-rendered screen.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session name.' },
      cols: { type: 'number', required: true, description: 'New width in columns.' },
      rows: { type: 'number', required: true, description: 'New height in rows.' },
    },
    output: text,
    async execute(args) {
      const name = await requireSession(sessionOf(args))
      const cols = clampCols(Number(args.cols), resolved.cols)
      const rows = clampRows(Number(args.rows), resolved.rows)
      await driver.resize(name, cols, rows)
      await driver.pause(300)
      return await driver.screen(name)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_close',
    description: 'Close a background shell and everything running inside it.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session name.' },
    },
    output: text,
    async execute(args) {
      const name = sessionOf(args)
      const result = await driver.kill(name)
      // 幂等：已经没了就说清楚，而不是报一个吓人的 tmux 原始错误
      return result.closed ? `closed ${name}` : `${name} was already gone (nothing to close)`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_rename',
    description: 'Rename a background shell. The name is sanitized to letters, digits, underscore and dash, and gets the dsh- prefix; the final name is returned.',
    parameters: {
      session: { type: 'string', required: true, description: 'Current session name.' },
      newName: { type: 'string', required: true, description: 'Wanted name; the dsh- prefix is added automatically if missing.' },
    },
    output: text,
    async execute(args) {
      const from = sessionOf(args)
      const result = await renameShell({ name: from, newName: String(args.newName ?? '') })
      return result.changed ? `renamed ${from} -> ${result.name}` : `unchanged: ${result.name}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_diagnose',
    description: 'Report the state of the background-shell capability: private tmux server, session count, orphan watchdog, and the start directory.',
    parameters: {},
    output: text,
    async execute() {
      const probe = await driver.probe(['list-sessions', '-F', '#{session_name}'])
      const names = probe.code === 0 ? probe.out.split('\n').filter((l) => l.length > 0) : []
      const lines = [
        `private tmux server: ${probe.code === 0 ? `running, ${names.length} session(s)` : 'not running'}  (socket -L ${resolved.socket})`,
        `harness pid: ${(await driver.harnessPid()) || 'NOT DETECTED'}`,
        `orphan watchdog pid: ${(await driver.watchdogPid()) || 'not armed'}`,
        `watched pid: ${state.watchedPid || '-'}`,
        `start directory: ${state.cwd}`,
        `max sessions: ${resolved.maxSessions}`,
        `history limit: ${resolved.historyLimit} lines`,
        `sessions: ${names.length > 0 ? names.join(', ') : '(none)'}`,
      ]
      return lines.join('\n')
    },
  }))
}
