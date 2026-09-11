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
import { TmuxDriver, sanitizeSocketName } from './tmux.js'
import {
  appendAudit, auditDirFor, auditPaths as buildAuditPaths, dayKey, ensureAuditDir,
  listOutputFiles, outputFileFor, outputSize, pruneAuditFiles, readAudit, readConsent,
  readOwners, summarizeRecord, writeConsent, writeOwners,
} from './audit.js'
import { homedir } from 'node:os'

export const name = 'dsh-agent-shell'

/** 只硬依赖 tools（工具注册）；其余服务全部探测。 */
export const inject = ['tools']

/**
 * 浏览器面闸门 —— 这一组路由**没有任何鉴权**，而「HTTP」是每个网页都能发请求的地方。
 *
 * 威胁模型（三条都真实可达，逐条对应一条检查）：
 *
 *   1. **跨站请求伪造**：随便哪个你访问的网页都能 `fetch('http://127.0.0.1:3080/plugins/shell/keys')`
 *      往你正在用的 shell 里灌命令。只要请求是「简单请求」（`text/plain`、表单），浏览器**不预检**，
 *      响应读不到但副作用已经发生 —— 而本插件的请求体解析**不看 Content-Type**，所以今天就能打通。
 *   2. **DNS rebinding**：攻击者域名解析到 127.0.0.1，浏览器视为同源 → 可读 `/list`、`/screen`
 *      （终端内容、路径），也能写。Host 校验是唯一能挡住它的东西。
 *   3. **本机其它进程**：同机任意用户/进程都能连 127.0.0.1。这条只能靠 DSH 自己的会话鉴权兜住
 *      （见下），本插件自身无法区分「你的浏览器」和「本机别的程序」。
 *
 * 检查顺序：先问 DSH 自己的围栏（若部署挂了 `connection` 服务，它同时做 Host/Origin 围栏与
 * 浏览器会话校验，是权威判断），再用本地等价检查兜底（纵深防御，也覆盖没挂该服务的部署）。
 *
 * @returns {string|null} 拒绝原因；null 表示放行。
 */
export function fenceReason(req, options = {}) {
  const header = (name) => {
    const raw = req?.headers?.[name]
    return Array.isArray(raw) ? raw[0] : (raw === undefined || raw === null ? undefined : String(raw))
  }

  // A. DSH 权威围栏（有就信它：它知道部署配置的 trustedHosts，也能验浏览器会话）
  const connection = options.connection
  if (connection !== undefined && typeof connection.requestRejection === 'function') {
    let code
    try { code = connection.requestRejection(req) } catch { code = 403 }
    if (code === 403) return 'rejected by the DSH host/origin fence'
    if (code === 401) return 'browser session is not authenticated'
  }

  const host = header('host')
  if (host === undefined || host.trim() === '') return 'missing Host header'
  let hostUrl
  try { hostUrl = new URL('http://' + host) } catch { return 'malformed Host header' }

  // B. Host 必须是本机（挡 DNS rebinding）。服务绑在 127.0.0.1 时才强制；
  //    绑 0.0.0.0（有意对外服务）时无法据此判断，改为明确告知用户该围栏不可用。
  const loopback = hostUrl.hostname === '127.0.0.1' || hostUrl.hostname === 'localhost' ||
    hostUrl.hostname === '::1' || hostUrl.hostname === '[::1]'
  const trusted = trustedHostMatch(hostUrl, options.allowedHosts)
  if (options.requireLoopback !== false && !trusted) {
    if (!loopback) return 'Host is not loopback: ' + hostUrl.hostname
    if (options.port !== undefined && hostUrl.port !== '' && hostUrl.port !== String(options.port)) {
      return 'Host port does not match the listening port'
    }
  }

  // C. 现代浏览器的跨站标记：直接拒绝（这条挡住上面威胁 1）
  if (header('sec-fetch-site') === 'cross-site') return 'cross-site request rejected'

  // D. 带 Origin 时必须与 Host 同源（老浏览器兜底）；`Origin: null` 来自沙箱 iframe / file://
  const origin = header('origin')
  if (origin !== undefined) {
    if (origin === 'null') return 'opaque Origin rejected'
    try {
      if (new URL(origin).host !== hostUrl.host) return 'Origin does not match Host'
    } catch { return 'malformed Origin header' }
  }

  // E. 会改状态的请求必须是 JSON：跨站「简单请求」只能发 text/plain / 表单 / multipart，
  //    要求 application/json 会强制预检，而本插件不返回任何 CORS 头 → 浏览器发不出去。
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const type = String(header('content-type') ?? '').toLowerCase()
    if (!type.startsWith('application/json')) {
      return 'state-changing requests must send Content-Type: application/json'
    }
  }
  return null
}

/**
 * 判断 Host 是否命中 `allowedHosts`（反向代理部署用）。
 *
 * 语义刻意与 DSH 的 trustedHosts 一致：带端口的条目要求**精确**匹配 `host:port`，
 * 不带端口的条目按**主机名**匹配任意端口（代理常把 443 省掉）。`*` 不被接受 ——
 * 那等于悄悄关掉 DNS rebinding 防护；真要放开就把服务绑 0.0.0.0（那条降级路径会明说风险）。
 */
export function trustedHostMatch(hostUrl, allowedHosts) {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) return false
  return allowedHosts.some((entry) => {
    const raw = String(entry).trim()
    if (raw === '' || raw === '*') return false
    let entryUrl
    try { entryUrl = new URL('http://' + raw) } catch { return false }
    const hasPort = raw.includes(':') && entryUrl.port !== ''
    return hasPort ? entryUrl.host === hostUrl.host : entryUrl.hostname === hostUrl.hostname
  })
}

/**
 * tmux 缺失时该说的话。
 *
 * 「开箱即用」的第一条不是"能跑"，而是**缺什么就说清什么**。tmux 是系统依赖，
 * 包管理器不会提醒，所以由插件在启动时体检一次、并在每个失败点复述可执行的修法。
 *
 * @returns {string} 可直接展示的提示；tmux 正常时返回空串。
 */
export function tmuxRequirementMessage(probe) {
  if (probe === null || probe === undefined || probe.ok === true) return ''
  const detail = probe.error === undefined || probe.error === '' ? '（没有更多信息）' : probe.error
  return 'tmux is required but not usable: ' + detail +
    '。安装：Debian/Ubuntu `apt install tmux`，macOS `brew install tmux`，' +
    'Windows 需在 WSL 里运行（原生 Windows 没有 tmux）。'
}

/** 确认门的问题与选项文案；集中一处，测试与文档引用同一份措辞。 */
const CONSENT_QUESTION_ID = 'agent-shell-consent'
const CONSENT_GRANT_LABEL = '允许本对话使用（授权执行任意命令）'
const CONSENT_DENIED = '用户拒绝了本对话使用持久化 shell。不要再尝试；如果确实需要，请让用户在对话里明确要求后再确认一次。'
const CONSENT_UNKNOWN_CALLER = '无法确定这次调用来自哪个对话，因此不能把它算作已授权。这个 shell 需要由对话内的用户确认后使用。'
const CONSENT_NO_ASKER = '本插件开启了"首次使用需用户确认"，但这个部署没有可用的提问服务（ctx.userQuestions），问不到人就不能算得到授权。请让用户在面板里确认，或由部署方设置 requireConsent: false（等于放弃这道闸门）。'
const CONSENT_DELEGATED = '这次调用来自子代理：DSH 的提问服务不会向子代理转发问题（问了会永久阻塞），而本进程里还没有任何人类确认过。请先让用户在主对话里确认一次，之后子代理会继承该授权。'
const CONSENT_ASK_FAILED = '确认失败：'

/** 设置了需要重启才生效的键（与 applyResolved 的判定保持一致，卡片据此打标记）。 */
export const RESTART_REQUIRED_KEYS = [
  'socket', 'httpBase', 'exposeHttp', 'exposeTools', 'defaultTerminal', 'historyLimit', 'extendedKeys',
]

/**
 * 把 Config schema 摊平成设置卡片要用的字段表。
 *
 * 卡片是**浏览器端**渲染的，它拿不到 schemastery 对象，所以这里把描述文字、类型、当前值与
 * "是否需重启"一起发给它 —— 描述文字本来就写在 schema 上（那是设置页唯一的说明来源）。
 */
export function settingsFieldList(values, toJson) {
  const root = toJson !== null && toJson !== undefined && typeof toJson.uid === 'number'
    ? toJson.refs?.[String(toJson.uid)]
    : toJson
  const dict = root?.dict ?? {}
  const out = []
  for (const [key, ref] of Object.entries(dict)) {
    const meta = (typeof ref === 'number' ? toJson.refs?.[String(ref)]?.meta : ref?.meta) ?? {}
    const value = values?.[key]
    out.push({
      key,
      type: typeof value === 'boolean' ? 'boolean' : Array.isArray(value) ? 'array' : typeof value === 'number' ? 'number' : 'string',
      value: value === undefined ? null : value,
      description: typeof meta.description === 'string' ? meta.description : '',
      restartRequired: RESTART_REQUIRED_KEYS.includes(key),
    })
  }
  return out
}

/** 会话名自身前缀，避免与任何手工 tmux 会话混淆。 */
const NAME_PREFIX = 'dsh-'

/**
 * 插件参数。字段上的 `.description()` 不是注释 —— 设置页的表单**就是**由它生成的：
 * 没有 description 的字段在用户眼里只是一个光秃秃的键名（`httpBase` 是干什么的？）。
 * 所以每个字段都必须有说明，并且要写清楚**改完是否立即生效**。
 * 一条机械不变式在 `scripts/test-edge.mjs` 里守着：任何新增字段漏了说明就 fail。
 */
export const Config = z.object({
  socket: z.string().default('dsh-agent')
    .description('私有 tmux 服务端名（`tmux -L` 的 socket 名）。与用户自己的 tmux 完全隔离；换名字等于换一个独立服务端。改动需重启 dsh web。'),
  httpBase: z.string().default('/plugins/shell')
    .description('面板使用的同源 HTTP 前缀（仅在 exposeHttp 打开时有意义）。改动需重启 dsh web。'),
  exposeHttp: z.boolean().default(true)
    .description('是否暴露 HTTP 接口。面板靠它读屏幕与投递按键，关掉之后面板就废了。改动需重启 dsh web。'),
  exposeTools: z.boolean().default(true)
    .description('是否注册 shell_* 工具。关掉之后模型完全看不到这套工具（只保留面板）。改动需重启 dsh web。'),
  watchdog: z.boolean().default(true)
    .description('孤儿看门狗：harness 进程消失后自动收掉服务端，避免留下没人管的 tmux。立即生效。'),
  shell: z.string().default('bash')
    .description('每个会话里启动的程序（bash / zsh / python3 …）。立即生效，只影响之后新建的会话。'),
  defaultTerminal: z.string().default('tmux-256color')
    .description('写进 tmux 服务端启动配置的 TERM。颜色/键位不对时先看这里。改动需重启 dsh web。'),
  cols: z.number().default(120)
    .description('新建会话的默认列数（可用范围 20–1000）。立即生效。'),
  rows: z.number().default(32)
    .description('新建会话的默认行数（可用范围 5–500）。立即生效。'),
  historyLimit: z.number().default(100000)
    .description('每个会话的滚动缓冲上限（行）。它写在服务端启动配置里：调大之后历史能留更久，改动需重启 dsh web。'),
  maxSessions: z.number().default(8)
    .description('同时在世的会话数上限（每个会话是一个 tmux session）。到顶后再开会报 "session limit reached"。立即生效。'),
  defaultCwd: z.string().default('')
    .description('新建会话的起始目录；留空表示取 $HOME。填不存在的目录会被拒绝。立即生效。'),
  guardDangerousCommands: z.boolean().default(true)
    .description('高危命令启发式拦截（rm -rf /、mkfs、dd 写块设备、curl | sh、sudo 之类）。注意：这是减速带不是沙箱，绕过方式很多，真正的防线是权限模式。立即生效。'),
  auditDir: z.string().default('')
    .description('审计与留痕的存放目录。留空 = ${DSH_HOME:-~/.dsh}/agent-shell。想放到别处（例如加密卷）就填绝对路径。改动立即生效，但**已在进行的会话**仍写在原目录。'),
  requireConsent: z.boolean().default(true)
    .description('首次使用确认门：一个对话**第一次**要用本插件的工具时，先弹一个问题请你手动确认；同意就等于授权该对话里的 AI 在这些 shell 上执行任意命令（等同你的用户权限），之后不再逐条询问。关掉它（false）等于放弃这道闸门 —— 那意味着 AI 可以在你不知情时开 shell 并执行命令。立即生效。'),
  audit: z.boolean().default(true)
    .description('审计：把**所有进入终端的输入**（模型发起的 shell_send 与面板里人敲的键）连同来源、发起会话、护栏决策写进 append-only 日志。这是「这台机器上谁在什么时候让 shell 干了什么」的唯一完整记录 —— 因为进入终端只有这两个入口。立即生效。'),
  auditRetentionDays: z.number().default(30)
    .description('审计日志按天轮转，保留多少天（越界会被设置页拒绝：1–3650）。立即生效。'),
  captureOutput: z.boolean().default(true)
    .description('留痕：每个会话用 tmux pipe-pane 把**终端输出**（含回显的命令、程序输出、TUI 画面）原样追加到 ~/.dsh/agent-shell/output/，会话关闭后文件仍在。注意：终端里出现过的敏感内容（密码、令牌、打印的密钥）也会被一起记下来。立即生效（只影响之后新建的会话）。'),
  captureMaxBytes: z.number().default(67108864)
    .description('单个会话留痕文件的上限（字节，默认 64 MiB）。触顶会自动停止该会话的留痕并记一条审计 —— 全屏 TUI 程序一小时可能吐出几十 MB，不设上限会悄悄吃满磁盘。立即生效。'),
  allowedHosts: z.array(z.string()).default([])
    .description('额外信任的 Host（写 host 或 host:port）。仅当把 DSH 放在反向代理之后、用别的域名访问时才需要 —— 代理转发过来的 Host 不是回环地址，会被浏览器面闸门拒绝。警告：每加一条就削弱一分 DNS rebinding 防护（该 Host 不再被要求是回环）。'),
  extendedKeys: z.boolean().default(false)
    .description('服务端开启 extended-keys，让 TUI（pi、codex 之类）收到 Shift+Enter 这类带修饰键的按键。需要 tmux ≥ 3.2，且写在服务端启动配置里 —— 改后需重启 dsh web，老版本 tmux 上开了会导致服务端起不来。'),
})

/**
 * 设置页的取值校验。
 *
 * 只挂在 settings 缝上（`installSection` 的 `validate`），**schema 本身保持宽松**：
 * 组合配置（cordis.patch.yml）里写了越界值仍按老规矩在用时夹住，不会因为一条 YAML
 * 就让插件装不上；而在设置页里填越界值会被**当场拒绝**并给出原因，而不是悄悄改小。
 */
const RANGES = { cols: [20, 1000], rows: [5, 500], historyLimit: [100, 1000000], maxSessions: [1, 64], auditRetentionDays: [1, 3650], captureMaxBytes: [4096, 2 ** 40] }

export function validateSettings(value) {
  const problems = []
  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const n = value[key]
    if (!Number.isFinite(n) || n < min || n > max) {
      problems.push(`${key} 必须在 ${min}–${max} 之间（现在是 ${String(n)}）`)
    }
  }
  if (typeof value.socket !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.socket)) {
    problems.push('socket 只能包含字母、数字、下划线和短横线，且不能为空')
  }
  if (typeof value.httpBase !== 'string' || !value.httpBase.startsWith('/')) {
    problems.push('httpBase 必须以 / 开头')
  }
  if (typeof value.shell !== 'string' || value.shell.trim() === '') problems.push('shell 不能为空')
  if (value.allowedHosts !== undefined) {
    if (!Array.isArray(value.allowedHosts)) {
      problems.push('allowedHosts 必须是字符串数组')
    } else {
      const bad = value.allowedHosts.filter((entry) => !/^[A-Za-z0-9.\-\[\]:]+$/.test(String(entry).trim()) || String(entry).trim() === '*')
      if (bad.length > 0) problems.push(`allowedHosts 只能是 host 或 host:port（不接受协议前缀、路径或 *）：${bad.join('、')}`)
    }
  }
  if (problems.length > 0) throw new Error(problems.join('；'))
}

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

/**
 * 把插件配置解析成运行期形态。
 *
 * 之所以抽成函数而不是一次性对象：用户可以在 DSH 设置页里改配置（官方 ctx.settings 缝），
 * 改完要能重新解析并**立刻**应用到可热更的项上，而不必重启。
 */
function resolveConfig(cfg) {
  const source = cfg !== null && typeof cfg === 'object' ? cfg : {}
  return {
    // socket 会被派生成 /tmp/<name>-*.{conf,pid} 并拼进 shell 命令，所以在**解析处**就收敛：
    // 这样 pidFile / 服务端名 / 面板显示三处用的是同一个值，不会出现「驱动里改了名、
    // 上层还在用原名」的不一致。被改写时如实记进 socketNote，由面板与诊断显示。
    socket: sanitizeSocketName(source.socket ?? 'dsh-agent'),
    audit: source.audit !== false,
    requireConsent: source.requireConsent !== false,
    auditDir: typeof source.auditDir === 'string' ? source.auditDir : '',
    // 组合配置路径不经过设置页校验，所以在解析处夹住；面板显示生效值，不假装接受越界输入
    auditRetentionDays: Number.isFinite(source.auditRetentionDays)
      ? Math.min(3650, Math.max(1, Math.floor(source.auditRetentionDays))) : 30,
    captureOutput: source.captureOutput !== false,
    captureMaxBytes: Number.isFinite(source.captureMaxBytes)
      ? Math.min(2 ** 40, Math.max(4096, Math.floor(source.captureMaxBytes))) : 67108864,
    // 只保留形状合法的条目（host 或 host:port，不含协议/路径），非法项直接丢弃
    allowedHosts: (Array.isArray(source.allowedHosts) ? source.allowedHosts : [])
      .map((entry) => String(entry).trim())
      .filter((entry) => /^[A-Za-z0-9.\-\[\]:]+$/.test(entry) && entry !== '*'),
    httpBase: String(source.httpBase ?? '/plugins/shell').replace(/\/+$/, ''),
    exposeHttp: source.exposeHttp !== false,
    exposeTools: source.exposeTools !== false,
    watchdog: source.watchdog !== false,
    shell: source.shell ?? 'bash',
    defaultTerminal: source.defaultTerminal ?? 'tmux-256color',
    cols: source.cols ?? 120,
    rows: source.rows ?? 32,
    historyLimit: source.historyLimit ?? 100000,
    maxSessions: source.maxSessions ?? 8,
    defaultCwd: String(source.defaultCwd ?? ''),
    guard: source.guardDangerousCommands !== false,
    extendedKeys: source.extendedKeys === true,
  }
}

export function apply(ctx, config) {
  let resolved = resolveConfig(config)

  // ⚠ state 必须**最先**声明：设置注册会同步回调 onChange → applyResolved 读它，
  // 审计/体检等块也要用。它在 apply() 里被前面的代码块引用过三次（每次都是 TDZ 崩溃），
  // 所以从结构上钉死在这里，而不是靠"记得别写太早"。
  const state = {
    cwd: resolved.defaultCwd,
    /** $HOME（设置里把 defaultCwd 清空时回退到它）。 */
    homeDir: '',
    /** 最近一次设置变更的结论（立刻生效 / 需重启），面板会显示。 */
    settingsNote: '尚未修改（当前用的是组合配置）',
    /** socket 名被收敛过时的原值说明（空串表示没有发生过），面板与诊断会如实显示。 */
    socketNote: '',
    /** 浏览器面闸门的实际形态（谁在把关、绑定地址、是否有降级），面板与诊断会如实显示。 */
    fence: null,
    /** tmux 体检结果：`{ok, version, error}`；null 表示还没探完。 */
    tmux: null,
    /** 已授权的对话：`{ <sessionId>: {at, by} }`。落盘，热重载/重启后不重复问。 */
    consent: {},
    /** 正在进行的确认（同一对话并发调用时复用同一个提问，避免弹两次）。 */
    consentPending: new Map(),
    /** 启动时的落盘读回（归属/授权）—— 确认门会 await 它，避免"刚授权又问一遍"。 */
    ready: null,
    /** 最近被闸门拒绝的请求（最多 32 条），用来让「面板突然打不开」这类问题有据可查。 */
    fenceBlocked: [],
    /** 用户设置里覆盖了哪些字段（来自 settings 描述符的 user 层）。 */
    settingsOverrides: [],
    watchdogPid: '',
    watchedPid: '',
    /** 启动时保住（而不是清掉）的会话名 —— 见 TmuxDriver#bootstrap。 */
    keptOnBoot: [],
    adopted: false,
    ready: false,
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

  /**
   * 设置变更后重新解析并应用。
   *
   * 有些项**改不了就是改不了**：`historyLimit` / `defaultTerminal` / `extendedKeys` 写在
   * tmux 服务端启动时读的那份 `-f` 配置里，`socket` 决定的是另一个服务端，`httpBase` /
   * `expose*` 是注册期就固定的路由与工具。这些如实列出来告诉用户「要重启」，而不是假装生效。
   */
  function applyResolved(next) {
    const prev = resolved
    resolved = next

    // 新会话立即用新的 shell（driver 构造时捕获过，所以这里同步一次）
    if (next.shell !== prev.shell) driver.shell = next.shell

    // 起始目录：清空则回退到 $HOME
    if (next.defaultCwd !== prev.defaultCwd) {
      state.cwd = next.defaultCwd !== '' ? next.defaultCwd : (state.homeDir !== '' ? state.homeDir : next.defaultCwd)
    }

    // 看门狗开关：开了就布防，关了就把已有的收掉
    if (next.watchdog !== prev.watchdog) {
      if (next.watchdog) void driver.armWatchdog()
      else void driver.disarmWatchdog()
    }

    const needRestart = []
    if (next.socket !== prev.socket) needRestart.push('socket')
    if (next.historyLimit !== prev.historyLimit) needRestart.push('historyLimit')
    if (next.defaultTerminal !== prev.defaultTerminal) needRestart.push('defaultTerminal')
    if (next.extendedKeys !== prev.extendedKeys) needRestart.push('extendedKeys')
    if (next.httpBase !== prev.httpBase) needRestart.push('httpBase')
    if (next.exposeHttp !== prev.exposeHttp || next.exposeTools !== prev.exposeTools) needRestart.push('exposeHttp / exposeTools')

    state.settingsNote = needRestart.length > 0
      ? '已保存；下列项要重启 dsh web 才生效：' + needRestart.join('、')
      : '已保存，并已立即生效'
    console.log(`dsh-agent-shell: settings changed — ${state.settingsNote}`)
  }

  // ── 审计与归属（B 输入流水 / C 输出留痕 / D1 owner 标注）────────────────────
  //
  // 三件事在这里落位，各自解决一个不同的问题：
  //   * 输入流水：进入终端只有两个入口（工具 shell_send 与面板 /keys），在这两处记账即完整；
  //   * 输出留痕：tmux `pipe-pane` 把窗格字节流写盘，会话关掉后文件仍在；
  //   * owner 标注：记下"谁开的"，只标注不拦截（D1）—— 跨对话保活是核心价值，不能被隔离破坏。
  // 目录可在配置里改写（测试与「放到加密卷」都用它）；留空才走默认位置
  const auditPaths = buildAuditPaths(
    resolved.auditDir !== '' ? resolved.auditDir : auditDirFor(process.env, homedir()),
  )
  /** 会话归属表：`{ <shell>: { owner, source, openedAt, lastActor, lastUsedAt } }`，落盘以便宿主重启后仍可回答。 */
  let owners = {}
  /** 触顶后已停止留痕的会话，避免每次都重复审计。 */
  const captureStopped = new Set()
  /** 审计自身出问题时的如实标注（写不进去必须让人看得见，而不是静默失败）。 */
  let auditNote = ''
  let prunedOnDay = ''

  /**
 * 当前**对话的工作目录**。
 *
 * 取法不是猜的：平台自己注册 `cwd` 系统提示变量时用的就是 `context.agent?.session.header.cwd`
 * （`@deepseek-ai/dsh-agent-loop`）。所以新开的 shell 默认落在对话的工作目录里，
 * 而不是插件的 `defaultCwd`/`$HOME` —— 后者只在拿不到对话时（面板建的、无 agent 的调用）才用。
 *
 * 防御性再取几处同义字段：这些部署之间可能有差异，但**首选必须与平台一致**，
 * 否则会静默给出错误的目录（比起报错，错误的目录更危险：命令会跑在别的地方）。
 */
function conversationCwd(exec) {
  const candidates = [
    exec?.agent?.session?.header?.cwd,
    exec?.agent?.session?.meta?.cwd,
    exec?.agent?.options?.cwd,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return ''
}

/** 调用方的身份：模型工具给 agent/session id；面板给 `panel`（浏览器侧无法区分到人）。 */
  const actorOf = (exec) => {
    const id = exec?.agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : ''
  }

  /**
   * 首次使用确认门。
   *
   * 规则（用户要求）：**一个对话第一次**要用本插件的工具时，先手动确认一次；同意就等于
   * 授权该对话里的 AI 在这些 shell 上执行任意命令。之后同对话不再询问。
   *
   * 三个必须处理的现实：
   *
   *   1. **子代理没有人可以问**。DSH 的 `userQuestions` 明确说：被别的 agent 拥有的子代理
   *      没有人类应答者，问了会**永久阻塞**（抛 `DELEGATED_CALLER`）。所以子代理的调用
   *      不能走"问"，只能**继承**：只要这个进程里已经有人类确认过一次，就放行并如实记为
   *      `inherited`；否则拒绝并说清该怎么办。
   *   2. **服务不在就拒绝**（fail closed）。问不到人就不能算得到授权 —— 想放弃这道闸门是
   *      配置项 `requireConsent: false` 的事，而不是悄悄放行。
   *   3. **并发调用只问一次**：同一对话里并行的工具调用复用同一个提问。
   *
   * @returns {Promise<{ok: boolean, reason: string, decision: string}>}
   */
  async function ensureConsent(exec, signal) {
    if (!resolved.requireConsent) return { ok: true, reason: 'consent gate disabled by config', decision: 'disabled' }
    const actor = actorOf(exec)
    if (actor === '') {
      // 拿不到会话身份就无法区分"哪个对话"，也不能把授权记到别人头上 —— 拒绝而不是默认放行
      return { ok: false, decision: 'unknown-caller', reason: CONSENT_UNKNOWN_CALLER }
    }
    // 先确保"读回已有授权"这件事完成，否则重启后的第一次调用会重复问（实测踩到）
    if (state.ready !== null) await state.ready
    const existing = state.consent[actor]
    if (existing !== undefined) return { ok: true, reason: 'already granted for this conversation', decision: 'granted' }

    const questions = ctx.get('userQuestions')
    const pendingKey = actor
    const pending = state.consentPending.get(pendingKey)
    if (pending !== undefined) return pending

    const ask = (async () => {
      if (questions === undefined || typeof questions.ask !== 'function') {
        recordAudit({ event: 'consent', shell: '', source: 'tool', actor, decision: 'unavailable' })
        return { ok: false, decision: 'unavailable', reason: CONSENT_NO_ASKER }
      }
      let answer
      try {
        answer = await questions.ask({
          agent: exec?.agent,
          signal,
          questions: [{
            id: CONSENT_QUESTION_ID,
            header: '持久化 shell 授权',
            question: '允许本对话使用持久化 shell 吗？',
            detail: '同意后：本对话里的 AI 可以创建持久化 shell 并在其中执行**任意命令**，权限等同你自己；'
              + '命令不会再有逐条询问（本插件不接入官方审批），每一次输入都会记进审计日志。'
              + '只授权这一个对话；其它对话需要各自确认一次。',
            options: [
              { label: CONSENT_GRANT_LABEL, description: '授权本对话执行任意命令（可随时关闭 shell）' },
              { label: '不允许', description: 'AI 无法创建或操作持久化 shell' },
            ],
          }],
        })
      } catch (error) {
        const code = String(error?.code ?? '')
        // 子代理没有人可以问：只要这个进程里有人类授权过，就继承；否则明确拒绝
        if (code === 'DELEGATED_CALLER' || code === 'CALLER_NOT_LIVE' || /DELEGATED_CALLER|CALLER_NOT_LIVE/.test(String(error?.message ?? ''))) {
          const anyGranted = Object.keys(state.consent).length > 0
          recordAudit({ event: 'consent', shell: '', source: 'tool', actor, decision: anyGranted ? 'inherited' : 'delegated-no-grant' })
          return anyGranted
            ? { ok: true, decision: 'inherited', reason: 'subagent inherits an existing human grant in this process' }
            : { ok: false, decision: 'delegated-no-grant', reason: CONSENT_DELEGATED }
        }
        recordAudit({ event: 'consent', shell: '', source: 'tool', actor, decision: 'ask-failed', result: String(error?.message ?? error) })
        return { ok: false, decision: 'ask-failed', reason: CONSENT_ASK_FAILED + String(error?.message ?? error) }
      }
      const chosen = Array.isArray(answer?.answers) ? answer.answers.find((a) => a?.id === CONSENT_QUESTION_ID) : undefined
      const picked = Array.isArray(chosen?.selected) ? chosen.selected[0] : undefined
      const granted = picked === CONSENT_GRANT_LABEL
      if (granted) {
        state.consent[actor] = { at: Date.now(), by: 'user' }
        // 这里必须**等**落盘：授权是一次性写入，而"重启/热重载后不重复问"完全依赖它已落盘
        await writeConsent(auditPaths, state.consent)
        recordAudit({ event: 'consent', shell: '', source: 'tool', actor, decision: 'granted', result: String(picked) })
        console.log(`dsh-agent-shell: consent granted for conversation ${actor}`)
        return { ok: true, decision: 'granted', reason: 'user granted' }
      }
      recordAudit({ event: 'consent', shell: '', source: 'tool', actor, decision: 'denied', result: String(picked ?? '(no answer)') })
      return { ok: false, decision: 'denied', reason: CONSENT_DENIED }
    })().finally(() => { state.consentPending.delete(pendingKey) })

    state.consentPending.set(pendingKey, ask)
    return ask
  }

  /** 确认门的守卫：不通过就抛一条**模型可以直接转述给用户**的错误。 */
  async function guardConsent(exec, signal, human = false) {
    // 面板是人自己在操作：不问他"允不允许自己"，但照样记一条审计 —— 授权门管的是 AI。
    if (human) {
      recordAudit({ event: 'consent', shell: '', source: 'panel', actor: 'panel', decision: 'human-panel' })
      return
    }
    const verdict = await ensureConsent(exec, signal)
    if (verdict.ok) return
    throw new Error(verdict.reason)
  }

  /** 记一条审计。**绝不抛**：审计写失败只标注，不能让 shell 操作跟着失败。 */
  function recordAudit(record) {
    if (!resolved.audit) return
    const day = dayKey(Date.now())
    void (async () => {
      if (prunedOnDay !== day) {
        prunedOnDay = day
        try { await ensureAuditDir(auditPaths.dir) } catch { /* 下面 write 会再报 */ }
        await pruneAuditFiles(auditPaths, day, resolved.auditRetentionDays).catch(() => {})
      }
      const ok = await appendAudit(auditPaths, day, { ts: Date.now(), ...record })
      if (!ok && auditNote === '') {
        auditNote = '审计写入失败（磁盘/权限）—— 正在进行的操作不受影响，但这段记录缺失'
        console.warn(`dsh-agent-shell: ${auditNote}`)
      } else if (ok && auditNote !== '') {
        auditNote = ''
      }
    })()
  }

  /** D1：记下会话归属（只标注，不拦截）。 */
  function setOwner(name, actor, source) {
    const now = Date.now()
    const previous = owners[name]
    owners[name] = {
      // 先展开旧值：captureFile 等字段是别处写进来的，**不能**因为记一次归属就丢掉
      ...previous,
      owner: actor === '' ? (previous?.owner ?? 'unknown') : actor,
      source,
      openedAt: previous?.openedAt ?? now,
      lastActor: actor === '' ? (previous?.lastActor ?? 'unknown') : actor,
      lastUsedAt: now,
    }
    void writeOwners(auditPaths, owners)
    return owners[name]
  }

  /** 新建会话后开始留痕（超上限则立刻记一条并放弃）。 */
  async function startCaptureFor(name) {
    if (!resolved.captureOutput) return ''
    const file = `${auditPaths.outputDir}/${outputFileFor(name, Date.now())}`
    try {
      await ensureAuditDir(auditPaths.outputDir)
      await driver.startCapture(name, file)
      recordAudit({ event: 'capture', shell: name, source: 'plugin', actor: '', file, result: 'started' })
      return file
    } catch (error) {
      recordAudit({ event: 'capture', shell: name, source: 'plugin', actor: '', file, result: 'failed: ' + String(error?.message ?? error) })
      return ''
    }
  }

  /**
   * 留痕上限检查。挂在面板轮询上（700ms 一次）—— 一次 stat 的开销可忽略，
   * 而比定时器更省：没人在看面板时也不会白跑。
   */
  async function enforceCaptureCap(name) {
    if (!resolved.captureOutput || captureStopped.has(name)) return
    const entry = owners[name]
    const file = entry?.captureFile
    if (typeof file !== 'string' || file === '') return
    const size = await outputSize(file)
    if (size <= resolved.captureMaxBytes) return
    captureStopped.add(name)
    await driver.stopCapture(name)
    recordAudit({
      event: 'capture', shell: name, source: 'plugin', actor: '', file,
      result: 'stopped: size cap reached', bytes: size, cap: resolved.captureMaxBytes,
    })
  }

  // tmux 体检：系统依赖不在 package.json 里，所以这里主动探一次并如实上报 ——
  // 装了插件却没有 tmux 的机器必须看到"缺什么、怎么装"，而不是一个 spawn 错误。
  void (async () => {
    try {
      state.tmux = await driver.probeTmux()
      const message = tmuxRequirementMessage(state.tmux)
      if (message !== '') console.error(`dsh-agent-shell: ${message}`)
      else console.log(`dsh-agent-shell: ${state.tmux.version} detected (socket -L ${resolved.socket})`)
    } catch (error) {
      state.tmux = { ok: false, version: '', error: String(error?.message ?? error) }
    }
  })()

  // 启动时清理过期审计 + 读回归属表与授权（宿主重启后 owner/授权仍然有效）。
  // 这个 promise 会被确认门 await：读盘是异步的，若不等它，**第一次调用**可能早于读盘完成，
  // 于是磁盘上明明有授权却还是再问一遍（实测踩到过）。
  state.ready = (async () => {
    try {
      await ensureAuditDir(auditPaths.dir)
      // ⚠ 必须**合并**而不是直接赋值：读盘是异步的，可能晚于第一次授权/第一次开会话。
      // （顺序上现在有 state.ready 兜底，但合并仍然必要：并发调用可能已经写下新的授权。）
      // 直接覆盖会把内存里刚写下的授权冲掉 —— 现象就是"用户刚确认完，下一次又问一遍"。
      // 同一 key 一律以内存为准（它更新）。
      owners = { ...(await readOwners(auditPaths)), ...owners }
      state.consent = { ...(await readConsent(auditPaths)), ...state.consent }
      if (!resolved.audit) return
      await ensureAuditDir(auditPaths.dir)
      prunedOnDay = dayKey(Date.now())
      await pruneAuditFiles(auditPaths, prunedOnDay, resolved.auditRetentionDays)
      prunedOnDay = dayKey(Date.now())
      await pruneAuditFiles(auditPaths, prunedOnDay, resolved.auditRetentionDays)
    } catch { /* 审计目录不可用时：功能照常，只是没有审计 */ }
  })()

  // ── 系统提示：什么时候**才**该用这套持久化 shell ────────────────────────────
  //
  // 工具描述能表达同样的意思，但描述是逐个工具看的；这里给模型一条整体的使用策略。
  // 目的很明确：**别因为有这个工具就随手用它** —— 普通命令行/文件工具能干的活就用那些，
  // 只有需要交互式 TTY、或需要跨调用/跨对话保活、或用户明确要求时，才开持久化 shell。
  //
  // order 放在 APPROVAL_POLICY(115) 与 SUBAGENT_DELEGATION(120) 之间：它和前者一样属于
  // 「部署策略」类告知，紧跟其后最自然。
  const USAGE_POLICY = [
    '## Persistent shell tools (dsh-agent-shell)',
    'These tools drive a long-lived interactive shell. **Prefer the ordinary command-line and file tools**;',
    'this plugin is for the cases they cannot serve:',
    '',
    '* a task needs a real interactive TTY — `sudo` / `ssh` password prompts, `vim`, a REPL, a TUI program;',
    '* work must keep running and stay inspectable across separate calls or even separate conversations;',
    '* the user explicitly asks for the persistent shell.',
    '',
    'Do not open a shell casually to run a one-off command, and do not leave idle shells behind:',
    'close them with `shell_close` when the work is done. If the regular tools can do it, use them.',
    '',
    'When you do use it, remember what it is: a real shell running as the user. This plugin does not ask',
    'DSH for approval (the session approval policy is not consulted), so a destructive command executes',
    'immediately, and the built-in dangerous-command guard is a heuristic speed bump rather than a safety',
    'net. Prefer the least destructive form of a command, and never run anything you would not want to explain.',
  ].join('\n')

  if (resolved.exposeTools) {
    ctx.inject(['systemPrompt'], (scope) => {
      if (scope.systemPrompt === undefined || typeof scope.systemPrompt.context !== 'function') return
      scope.systemPrompt.context({
        name: 'agent-shell:usage',
        order: 118,
        text: USAGE_POLICY,
      })
    })
  }

  /**
   * 进程内可变状态。
   *
   * ⚠ 必须声明在**设置注册之前**：`installSection` 在注册时会**同步**回调一次 `onChange`
   * → `applyResolved` → 读这里的字段。放在后面会撞 TDZ，而那个异常会被注册的 try/catch
   * 吞掉 —— 表现成「设置页看起来注册了，但改设置永远不生效」，极难从现象反推。
   */

  if (String(config.socket ?? '') !== '' && sanitizeSocketName(config.socket) !== String(config.socket)) {
    // 组合配置里的 socket 含非法字符：已收敛，但要告诉用户改了（静默改名会让人找不到自己的会话）
    state.socketNote = `socket 名含非法字符，已收敛为 "${resolved.socket}"（原值 "${String(config.socket)}"）`
    console.warn(`dsh-agent-shell: ${state.socketNote}`)
  }

  // ── 用户可改的设置（官方 ctx.settings 缝）──────────────────────────────────
  //
  // 注册之后，DSH 自己的设置页会给本插件渲染一张卡片（由 schema 生成表单），用户改完
  // 持久化进 settings 文件，**不必改 cordis.patch.yml、多数项也不必重启**。
  //
  // `installSection` 专门为「可选服务」设计：服务在就注册、并把组合配置当 base 层；
  // 服务不在（或没装 provider）就自动退回组合配置，插件照常工作 —— 所以这是可选项，
  // 不是硬依赖。这也符合本插件「除 tools 外全部探测」的兼容性红线。
  let readConfig = () => config
  /** 设置页是否**真的**注册成功。服务挂载 ≠ 注册成功，两者都要如实报告。 */
  let settingsRegistered = false
  /** 设置服务是否**出现过**（用于如实区分"服务没挂载"与"注册失败"）。 */
  let settingsServiceSeen = false
  /**
   * 注册设置页。
   *
   * ⚠ 必须走 `ctx.inject`，**不能**在 apply 时一次性 `ctx.get('settings')`：
   * 服务挂载顺序在我们的插件之后时，一次性探测拿到 undefined，于是"设置里没有这一项"，
   * 而且什么日志都不打 —— 实测就是这么踩到的（重启后菜单项仍不出现，日志里什么都没有）。
   * inject 会在服务可用时（哪怕是稍后）回调，这才是可选服务的正确用法。
   */
  ctx.inject(['settings'], (scope) => {
    const settingsService = scope.settings ?? scope.get('settings')
    if (settingsService === undefined || typeof settingsService.installSection !== 'function') return
    settingsServiceSeen = true
    try {
      settingsService.installSection(ctx, 'dsh-agent-shell', Config, config, {
        validate: validateSettings,
        setSource: (read) => { readConfig = typeof read === 'function' ? read : () => config },
        onChange: () => {
          try {
            const source = readConfig()
            applyResolved(resolveConfig(source))
            state.settingsOverrides = []
          } catch (error) {
            console.error(`dsh-agent-shell: applying settings failed: ${String(error)}`)
          }
        },
      })
      settingsRegistered = true
      state.settingsNote = '可在 DSH 设置 → 插件 里修改（namespace: dsh-agent-shell）'
      console.log('dsh-agent-shell: settings namespace registered — edit it in DSH settings → plugins')
    } catch (error) {
      // 如实记账：设置页不可用不是静默失败，面板的 ⓘ 详情里要能看到原因
      // （最常见的原因是组合配置里有越界值，被上面的 validate 挡住了注册）。
      const reason = error instanceof Error ? error.message : String(error)
      state.settingsNote = '设置页未注册：' + reason + '（插件仍按组合配置运行）'
      console.error(`dsh-agent-shell: settings registration failed: ${reason}`)
    }
  })

  // ── 审批情报（供面板/诊断**如实展示**，不参与任何拦截）────────────────────────
  //
  // 本插件**没有接入 DSH 官方审批**。原因不是偷懒，而是平台设计上二者互斥：
  //   * 本插件必须 danger-full-access（受限模式下 tmux 服务端无法跨调用共享）；
  //   * 官方权限预设把 danger-full-access 的审批策略定为 `never`（确定性拒绝，不弹 UI）。
  // 所以这里只把事实读出来展示，让风险可见 —— 不去假装接入，也不靠它做拦截。
  // 动态读：approval 也可能晚于本插件挂载，一次性探测会把它永久记成"未挂载"
  const approvalSeamMounted = ctx.get('approval') !== undefined
  const permissionMode = String(process.env.DSH_PERMISSION_MODE ?? 'workspace-write')
  // 优先读审批服务**实际配置的默认策略**（dsh-base 里由 DSH_PERMISSION_MODE 推导），
  // 读不到才退回同一条公式。注意这只是**默认值**：单个会话可以在运行期覆盖它，
  // 所以任何拿不到会话的地方（面板的 HTTP）都只能把它当默认值展示，不能当成事实。
  const configuredPolicy = ctx.get('approval')?.config?.policy
  const deploymentPolicy = (configuredPolicy === 'ask' || configuredPolicy === 'never')
    ? configuredPolicy
    : (permissionMode === 'danger-full-access' ? 'never' : 'ask')

  /**
   * 组装审批情报。给了 agent 就能给出**该会话的真实策略**（读会话日志里的
   * `approval/policy` 覆盖项），给不了就只能是部署默认值 —— 并如实标注来源。
   */
  function approvalInfoFor (agent) {
    let override
    if (agent?.session !== undefined) {
      try { override = approvalService?.overrideOf(agent.session) } catch { override = undefined }
    }
    const fromSession = override === 'ask' || override === 'never'
    return {
      /** 本插件是否把命令接到官方审批缝上 —— 永远是 false，这是设计决定，不是待办。 */
      integrated: false,
      seam: approvalSeamMounted ? 'mounted' : 'absent',
      policy: fromSession ? override : deploymentPolicy,
      policySource: fromSession ? 'session-override' : 'deployment-default',
      deploymentPolicy,
      permissionMode,
      warning:
        'This shell runs real commands with your privileges, and this plugin never asks the platform ' +
        'for approval: the model\'s commands execute without any allow/reject prompt. The dangerous-command ' +
        'guard is a heuristic speed bump, not protection.',
    }
  }

  // ── 启动收尾：布防看门狗（**不清理任何会话**）───────────────────────────────
  ;(async function start() {
    try {
      if (state.cwd === '') {
        const home = await driver.run(['sh', '-c', 'echo $HOME'], { cwd: '/', cap: 4096 })
        state.homeDir = home.out.trim() || '/'
        state.cwd = state.homeDir
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

  async function openShell(args = {}, meta = {}) {
    const actor = typeof meta.actor === 'string' ? meta.actor : ''
    const source = typeof meta.source === 'string' ? meta.source : 'tool'
    // 体检已知缺 tmux：直接把"缺什么、怎么装"说出来，而不是等 spawn 抛原始错误
    const missing = tmuxRequirementMessage(state.tmux)
    if (missing !== '') throw new Error(missing)
    // 首次使用确认门：一个对话第一次开 shell 之前必须由用户手动确认
    await guardConsent(meta.exec, meta.signal, meta.human === true)
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
    // 优先级：显式传入 > **当前对话的工作目录** > 配置的回退（defaultCwd，再退 $HOME）
    const explicitCwd = typeof args.cwd === 'string' && args.cwd.length > 0 ? args.cwd : ''
    const sessionCwd = conversationCwd(meta.exec)
    const cwd = explicitCwd !== '' ? explicitCwd : (sessionCwd !== '' ? sessionCwd : state.cwd)
    const cwdSource = explicitCwd !== '' ? 'explicit' : (sessionCwd !== '' ? 'conversation' : 'configured-fallback')
    // tmux 对不存在的 -c **不报错**，只会静默回落到 home —— 那样返回的 cwd 就是假的，
    // 调用方会以为自己在目标目录里跑命令。所以自己先挡一道，给出可执行的错误。
    if (cwd !== '' && !(await driver.isDirectory(cwd))) {
      throw new Error(`no such directory: ${cwd}`)
    }
    // 服务端由 create() 启动，启动时读 -f 指定的配置文件（history-limit 由此生效）。
    await driver.create({ name, cols, rows, cwd })
    // D1：记下归属（只标注不拦截）+ C：开始输出留痕。留痕文件路径也存进归属表，
    // 这样上限检查、面板展示与「关掉之后去哪找」用的是同一个来源。
    const captureFile = await startCaptureFor(name)
    if (captureFile !== '') owners[name] = { ...(owners[name] ?? {}), captureFile }
    setOwner(name, actor, source)
    recordAudit({ event: 'open', shell: name, source, actor, cols, rows, cwd, cwdSource, captureFile, result: 'ok' })
    await driver.pause(600)
    return { name, cols, rows, cwd, cwdSource, screen: await driver.screen(name) }
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

  async function sendKeys(args, meta = {}) {
    // 执行命令的能力同样要过确认门（而且要在**任何**副作用之前）
    await guardConsent(meta.exec, meta.signal, meta.human === true)
    await ensureWatchdog()
    const name = await requireSession(sessionOf(args))
    const text = typeof args.text === 'string' ? args.text : ''
    const preKeys = Array.isArray(args.preKeys) ? args.preKeys : []
    const keys = Array.isArray(args.keys) ? args.keys : []
    const actor = typeof meta.actor === 'string' ? meta.actor : ''
    const source = typeof meta.source === 'string' ? meta.source : 'tool'

    const refusal = await guardOrRefuse(name, text, keys, args.confirm)
    if (refusal !== null) {
      // 被拦下也是一次**企图**，必须留痕：只记成功的审计等于把最该看的那些藏起来。
      recordAudit({
        event: 'input', shell: name, source, actor, text, preKeys, keys,
        guard: args.confirm === true ? 'confirm-bypass-refused' : 'refused',
        result: String(refusal.message ?? refusal),
      })
      const entry = owners[name]
      if (entry !== undefined) { entry.lastUsedAt = Date.now(); entry.lastActor = actor === '' ? entry.lastActor : actor }
      return refusal
    }

    recordAudit({
      event: 'input', shell: name, source, actor, text, preKeys, keys,
      guard: args.confirm === true ? 'confirm-bypass' : 'allowed', result: 'sent',
    })
    const entry = owners[name]
    if (entry !== undefined) { entry.lastUsedAt = Date.now(); entry.lastActor = actor === '' ? entry.lastActor : actor }
    await driver.send(name, '', preKeys)
    await driver.send(name, text, keys)
    return { ok: true }
  }

  /** 设置卡片显示的"当前生效值"：以解析后的配置为准（含夹取/收敛后的真实值）。 */
  function settingsValuesForForm() {
    return { ...resolved }
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

      // 闸门在**注册处**统一包一层：以后新加路由不会因为忘记检查而漏掉（纵深防御靠结构，不靠自觉）。
      // 服务绑 0.0.0.0 时无法用 Host 判断是否本机，此时明确降级并记进 fence.note 如实告知。
      const connection = ctx.get('connection')
      const boundHost = String(webServer.host ?? '127.0.0.1')
      const requireLoopback = boundHost === '127.0.0.1'
      const fenceOptions = {
        // 不在这里冻结：请求时现读，服务晚挂载也能立刻用上更强的围栏
        connection: undefined,
        requireLoopback,
        port: Number.isFinite(webServer.port) ? webServer.port : undefined,
        // 不在这里冻结：请求时实时读 `resolved`，这样设置页改完白名单立刻生效（与其它热更项一致）
        allowedHosts: [],
      }
      state.fence = {
        authority: fenceOptions.connection !== undefined ? 'dsh-connection' : 'local',
        boundHost,
        port: Number.isFinite(webServer.port) ? webServer.port : null,
        requireLoopback,
        extraTrustedHosts: resolved.allowedHosts.length > 0 ? resolved.allowedHosts : null,
        note: fenceOptions.connection !== undefined
          ? 'Host/Origin 与浏览器会话校验由 DSH connection 服务负责'
          : requireLoopback
            ? '本地围栏：Host 必须为回环 + 拒绝跨站 + 写请求必须 JSON'
            : '⚠ 服务绑在 ' + boundHost + '：Host 围栏无法判定是否本机（DNS rebinding 未被挡住），且没有 connection 服务可用',
      }
      const blocked = state.fenceBlocked
      const route = (path, handler) => {
        const guarded = (req, res) => {
          const why = fenceReason(req, {
            ...fenceOptions,
            connection: ctx.get('connection'),
            allowedHosts: resolved.allowedHosts,
          })
          if (why !== null) {
            blocked.push({ path, why, time: Date.now() })
            if (blocked.length > 32) blocked.shift()
            json(res, 403, { error: why })
            return undefined
          }
          return handler(req, res)
        }
        webCtx.effect(() => webServer.register({ kind: 'exact', path: `${base}${path}`, handler: guarded }))
      }

      route('/list', async (_req, res) => {
        try {
          await ensureWatchdog()
          const sessions = await driver.list()
          json(res, 200, {
            sessions,
            server: {
              socket: resolved.socket,
              // 闸门形态 + socket 收敛提示：安全相关的状态必须让面板与诊断看得见，而不是只在代码里
              fence: state.fence,
              tmux: state.tmux,
              audit: {
                enabled: resolved.audit,
                dir: auditPaths.dir,
                retentionDays: resolved.auditRetentionDays,
                note: auditNote,
                capture: resolved.captureOutput,
                captureMaxBytes: resolved.captureMaxBytes,
                captureStopped: [...captureStopped],
              },
              socketNote: state.socketNote,
              fenceBlocked: state.fenceBlocked.slice(-8),
              maxSessions: resolved.maxSessions,
              defaultCwd: state.cwd,
              historyLimit: resolved.historyLimit,
              watchdogPid: state.watchdogPid,
              watchedPid: state.watchedPid,
              adoptedWatchdog: state.adopted,
              keptAtBoot: state.keptOnBoot,
              approval: approvalInfoFor(undefined),
              // 面板的 ⓘ 详情层要用到的静态配置：放在这里，客户端就不必再猜
              extendedKeys: resolved.extendedKeys,
              guardDangerousCommands: resolved.guard,
              shell: resolved.shell,
              defaultTerminal: resolved.defaultTerminal,
              watchdogEnabled: resolved.watchdog,
              settings: {
                namespace: 'dsh-agent-shell',
                note: state.settingsNote,
                // live = 用户现在真的能在设置页里改。服务挂载了但注册失败（例如组合配置越界
                // 被 validate 挡下）时这里是 false —— 不能因为「服务在」就谎报能改。
                live: settingsRegistered,
                service: settingsServiceSeen,
                registered: settingsRegistered,
                // 未注册时把原因写清：服务没出现 vs 出现了但注册失败（后者 settingsNote 里有原因）
                note: settingsRegistered ? state.settingsNote
                  : settingsServiceSeen ? state.settingsNote
                  : '设置服务尚未出现（ctx.inject 未回调）—— 若一直如此，说明这个部署没有挂载设置服务',
              },
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
          void enforceCaptureCap(name)
          // 面板这条路径要**完整窗格**（含结尾空行）：光标行号依赖「总行数 = 历史 + paneHeight」
          const screen = await driver.screen(name, Number.isFinite(lines) && lines > 0 ? lines : undefined, { trim: false })
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
          // 面板是「人」这一侧：actor 只能记到 panel（浏览器侧无法区分到具体是谁）
          const result = await sendKeys(body, { actor: 'panel', source: 'panel', human: true })
          json(res, result.refused === true ? 409 : 200, result)
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
        }
      })

      route('/new', async (req, res) => {
        try {
          const body = await readBody(req)
          json(res, 200, await openShell(body, { actor: 'panel', source: 'panel', human: true }))
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
          recordAudit({ event: 'close', shell: name, source: 'panel', actor: 'panel', result: result.closed ? 'closed' : 'not-found' })
          delete owners[name]
          void writeOwners(auditPaths, owners)
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

      route('/settings', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if (String(req.method ?? 'GET').toUpperCase() === 'GET') {
            json(res, 200, {
              namespace: 'dsh-agent-shell',
              note: settingsRegistered ? state.settingsNote
                : settingsServiceSeen ? state.settingsNote : '设置服务尚未出现 —— 只能读、不能写',
              writable: settingsServiceSeen,
              registered: settingsRegistered,
              restartRequiredKeys: RESTART_REQUIRED_KEYS,
              fields: settingsFieldList(settingsValuesForForm(), Config.toJSON()),
            })
            return
          }
          const body = await readBody(req)
          const patch = body !== null && typeof body === 'object' && body.patch !== null && typeof body.patch === 'object' ? body.patch : null
          if (patch === null) { json(res, 400, { error: 'patch object is required' }); return }
          const service = ctx.get('settings')
          if (service === undefined || typeof service.update !== 'function') {
            json(res, 503, { error: 'settings service is not mounted; this deployment can only use the composition config' })
            return
          }
          const candidate = { ...settingsValuesForForm(), ...patch }
          try {
            validateSettings(candidate)
          } catch (error) {
            json(res, 400, { error: String(error?.message ?? error) })
            return
          }
          await service.update('dsh-agent-shell', patch)
          // onChange → applyResolved 已经跑过，这里把**它给出的结论**原样回给卡片：
          // 「已保存，并已立即生效」/「下列项要重启 dsh web 才生效：…」
          json(res, 200, {
            ok: true,
            note: state.settingsNote,
            fields: settingsFieldList(settingsValuesForForm(), Config.toJSON()),
          })
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
        }
      })

      route('/audit', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const lines = Number.parseInt(url.searchParams.get('lines') ?? '', 10)
          const days = Number.parseInt(url.searchParams.get('days') ?? '', 10)
          if (!resolved.audit) { json(res, 200, { enabled: false, records: [], files: [] }); return }
          const limit = Number.isFinite(lines) ? Math.min(500, Math.max(1, lines)) : 50
          const back = Number.isFinite(days) ? Math.min(3650, Math.max(1, days)) : 1
          const collected = []
          for (let i = 0; i < back; i += 1) {
            collected.push(...await readAudit(auditPaths, dayKey(Date.now() - i * 86400000), {
              shell: url.searchParams.get('name') ?? '',
              actor: url.searchParams.get('actor') ?? '',
              source: url.searchParams.get('source') ?? '',
              limit: 0,
            }))
          }
          json(res, 200, {
            enabled: true,
            dir: auditPaths.dir,
            note: auditNote,
            capture: resolved.captureOutput,
            records: (collected.length > limit ? collected.slice(-limit) : collected).map((r) => ({
              ts: r.ts, event: r.event, shell: r.shell, source: r.source, actor: r.actor,
              text: r.text, keys: r.keys, preKeys: r.preKeys, guard: r.guard, result: r.result,
              summary: summarizeRecord(r),
            })),
            files: await listOutputFiles(auditPaths),
          })
        } catch (error) {
          json(res, errorCode(error), { error: String(error?.message ?? error) })
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
            approval: approvalInfoFor(undefined),
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
    description: 'Open a persistent interactive shell (real TTY) and return its first screen. Use this ONLY when the ordinary command-line tools cannot do the job: an interactive TTY is required (sudo/ssh password prompts, vim, a REPL, a TUI), the work must survive across calls or conversations, or the user explicitly asked for a persistent shell. Do not open one for a one-off command. The shell outlives every conversation: it belongs to the harness process, not to this session. Drive it with shell_send; read it with shell_read or shell_history; close it with shell_close when done.',
    parameters: {
      name: { type: 'string', description: 'Optional label; a short unique id is generated when omitted.' },
      cols: { type: 'number', description: 'Terminal width in columns.' },
      rows: { type: 'number', description: 'Terminal height in rows.' },
      cwd: { type: 'string', description: 'Initial working directory (defaults to the configured start directory).' },
    },
    output: text,
    async execute(args, exec) {
      const opened = await openShell(args, { actor: actorOf(exec), source: 'tool', exec, signal: exec?.signal })
      return `session ${opened.name} | ${opened.cols}x${opened.rows} | cwd ${opened.cwd} (${opened.cwdSource})\n${opened.screen}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_send',
    description: 'Type into a shell opened by shell_open, exactly like a human: preKeys first, then the literal text, then keys. Only for shells this plugin owns - for ordinary commands prefer the regular command-line tools. Text does NOT submit by itself: pass keys:["Enter"] to run a command. Named keys accept tmux key names (Enter, Tab, Escape, Up, C-c, C-d, F1). A high-risk command is refused unless confirm is true; that check is a heuristic speed bump, not a sandbox.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session name from shell_open or shell_list.' },
      text: { type: 'string', description: 'Literal text, sent after preKeys and before keys.' },
      preKeys: { type: 'array', items: { type: 'string' }, description: 'Keys pressed before the text, e.g. ["i"] for vim insert mode.' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Keys pressed after the text, e.g. ["Enter"].' },
      confirm: { type: 'boolean', description: 'Acknowledge a refused high-risk command after obtaining explicit user approval.' },
      settleMs: { type: 'number', description: 'Milliseconds to wait for the screen to settle (default 900).' },
    },
    output: text,
    async execute(args, exec) {
      const name = sessionOf(args)
      const result = await sendKeys({
        name,
        text: args.text,
        preKeys: args.preKeys,
        keys: args.keys,
        confirm: args.confirm,
      }, { actor: actorOf(exec), source: 'tool', exec, signal: exec?.signal })
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
    description: 'List every shell this plugin owns, with size, foreground command and history-buffer usage. Useful to check whether a persistent shell is still needed before closing it.',
    parameters: {},
    output: text,
    async execute() {
      await ensureWatchdog()
      const sessions = await driver.list()
      if (sessions.length === 0) return '(no shells)'
      return sessions
        .map((s) => {
          // D1：只标注归属，不做拦截 —— 跨对话保活是这套机制的核心价值，不能被「隔离」破坏。
          // owner=unknown 说明是插件之外（或本功能之前）建的会话，如实写出来而不是猜一个。
          const entry = owners[s.name]
          const owner = entry === undefined || typeof entry.owner !== 'string' ? 'unknown' : entry.owner
          const tag = entry?.source === 'panel' ? `${owner}(面板)` : owner
          return `${s.name}  ${s.cols}x${s.rows}  fg=${s.foreground || '?'}  attached=${s.attached ? 'yes' : 'no'}  buffer=${s.historySize}/${s.historyLimit} lines, ${s.historyBytes}B  owner=${tag}`
        })
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
    description: 'Close a shell opened by shell_open, and everything running inside it. Close idle shells when the work is done instead of leaving them behind.',
    parameters: {
      session: { type: 'string', required: true, description: 'Session name.' },
    },
    output: text,
    async execute(args, exec) {
      const name = sessionOf(args)
      const result = await driver.kill(name)
      // 生命周期同样留痕：审计要能回答"谁在什么时候把哪个 shell 关掉了"，
      // 否则"会话不见了"这件事永远查不出原因。
      recordAudit({
        event: 'close', shell: name, source: 'tool', actor: actorOf(exec),
        result: result.closed ? 'closed' : 'not-found',
      })
      delete owners[name]
      void writeOwners(auditPaths, owners)
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
    name: 'shell_consent',
    description: 'Report whether THIS conversation is allowed to use the persistent shell (the first-use consent gate), plus what to do if it is not. Do NOT call this routinely: the gate is enforced automatically on shell_open/shell_send, so a normal call already tells you. Query it only when you need to know before deciding something (e.g. planning whether a persistent shell is available at all), or when a shell_* call failed for an unclear reason. It never triggers the confirmation prompt by itself.',
    parameters: {},
    output: text,
    async execute(_args, exec) {
      const actor = actorOf(exec)
      const gate = resolved.requireConsent
      const own = actor !== '' ? state.consent[actor] : undefined
      const humans = Object.entries(state.consent)
        .filter(([, entry]) => entry !== null && typeof entry === 'object')
      const lines = [
        `consent gate: ${gate ? 'enabled (requireConsent: true)' : 'DISABLED by config (requireConsent: false) — no confirmation is asked'}`,
        `this conversation: ${actor === '' ? '(unknown caller — cannot be attributed)' : actor}`,
        own !== undefined
          ? `this conversation granted: yes, at ${new Date(own.at ?? 0).toISOString()} (by ${String(own.by ?? 'user')})`
          : gate
            ? 'this conversation granted: NOT YET — the next shell_open/shell_send will ask the user once'
            : 'this conversation granted: not needed (gate disabled)',
        `human grants in this process: ${humans.length}${humans.length > 0 ? ' (' + humans.map(([id]) => id).join(', ') + ')' : ''}`,
        humans.length > 0 && own === undefined
          ? 'note: a subagent has no human to ask, so it INHERITS an existing human grant; yours would be inherited too.'
          : '',
        `revoke: delete the entry in ${auditPaths.consent} (or the whole file)`,
        `every grant/denial is recorded in ${auditPaths.dir} (audit-YYYY-MM-DD.jsonl)`,
      ].filter((l) => l !== '')
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_audit',
    description: 'Read the audit trail: every input sent into a background shell (both model-driven shell_send and keys typed in the panel), with source, owning conversation, guard decision, plus open/close/rename events. Use it to answer "who ran what, when, in which shell" - including shells that were already closed (their terminal output transcripts survive under the audit directory).',
    parameters: {
      session: { type: 'string', description: 'Only records for this shell.' },
      actor: { type: 'string', description: 'Only records whose actor (conversation/session id, or "panel") matches exactly.' },
      source: { type: 'string', description: 'Only records from this source: tool or panel.' },
      lines: { type: 'number', description: 'How many records to return from the newest (default 50, max 500).' },
      days: { type: 'number', description: 'How many days back to read (default 1; each day is one file).' },
    },
    output: text,
    async execute(args) {
      if (!resolved.audit) return 'audit is disabled (set config.audit to true to record and read it)'
      const limit = Number.isFinite(args.lines) ? Math.min(500, Math.max(1, Math.floor(args.lines))) : 50
      const days = Number.isFinite(args.days) ? Math.min(3650, Math.max(1, Math.floor(args.days))) : 1
      const filter = {
        shell: typeof args.session === 'string' ? args.session : '',
        actor: typeof args.actor === 'string' ? args.actor : '',
        source: typeof args.source === 'string' ? args.source : '',
        limit: 0,
      }
      const collected = []
      for (let i = 0; i < days; i += 1) {
        const day = dayKey(Date.now() - i * 86400000)
        collected.push(...await readAudit(auditPaths, day, filter))
      }
      const records = limit > 0 && collected.length > limit ? collected.slice(-limit) : collected
      const files = await listOutputFiles(auditPaths)
      const header = [
        `audit dir: ${auditPaths.dir}${auditNote === '' ? '' : '  ⚠ ' + auditNote}`,
        `records: ${records.length}（读最近 ${days} 天，按时间升序）`,
        `output transcripts: ${files.length} 个${files.length > 0 ? '（最新 ' + files[0].name + '，' + String(files[0].bytes) + 'B）' : ''}`,
      ].join('\n')
      if (records.length === 0) return header + '\n(没有匹配的审计记录)'
      return header + '\n\n' + records.map(summarizeRecord).join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'shell_diagnose',
    description: 'Report the state of the background-shell capability: private tmux server, session count, orphan watchdog, the start directory, and the approval status (this plugin never requests DSH approval, so commands run without a prompt).',
    parameters: {},
    output: text,
    // 第二个参数是管线给的 exec，里面有 agent —— 只有这里才能知道**当前会话**的审批策略。
    // 面板那条路是 HTTP，拿不到会话，只能展示部署默认值（并如实标注来源）。
    async execute(_args, exec) {
      const probe = await driver.probe(['list-sessions', '-F', '#{session_name}'])
      const names = probe.code === 0 ? probe.out.split('\n').filter((l) => l.length > 0) : []
      const approval = approvalInfoFor(exec?.agent)
      const lines = [
        `private tmux server: ${probe.code === 0 ? `running, ${names.length} session(s)` : 'not running'}  (socket -L ${resolved.socket})`,
        `harness pid: ${(await driver.harnessPid()) || 'NOT DETECTED'}`,
        `orphan watchdog pid: ${(await driver.watchdogPid()) || 'not armed'}`,
        `watched pid: ${state.watchedPid || '-'}`,
        `start directory: ${state.cwd}`,
        `max sessions: ${resolved.maxSessions}`,
        `history limit: ${resolved.historyLimit} lines`,
        `sessions: ${names.length > 0 ? names.join(', ') : '(none)'}`,
        `settings: ${resolved.shell}/${resolved.cols}x${resolved.rows}, max ${resolved.maxSessions}, guard ${resolved.guard ? 'on' : 'off'}`,
        `settings namespace: dsh-agent-shell ${settingsServiceSeen ? '— ' + state.settingsNote : '(settings service never appeared — using composition config)'}`,
        state.fence === null
          ? '浏览器面闸门: 未启用（exposeHttp 关闭）'
          : '浏览器面闸门: ' + state.fence.authority + ' · 绑定 ' + state.fence.boundHost +
            (state.fence.port === null ? '' : ':' + String(state.fence.port)) + ' · ' + state.fence.note,
        state.socketNote === '' ? 'socket 名: 未发生收敛' : 'socket 名: ' + state.socketNote,
        resolved.requireConsent
          ? `consent gate: enabled — this conversation ${actorOf(exec) === '' ? 'unknown' : (state.consent[actorOf(exec)] !== undefined ? 'granted' : 'NOT granted yet (will ask once)')}`
          : 'consent gate: disabled by config (commands run without any confirmation)',
        state.tmux === null ? 'tmux: 体检进行中'
          : state.tmux.ok ? `tmux: ${state.tmux.version}`
          : 'tmux: 不可用 —— ' + tmuxRequirementMessage(state.tmux),
        // 审批状态必须如实写在最显眼处：模型据此决定要不要格外小心
        `approval: NOT INTEGRATED - this plugin never asks for approval; commands run without a prompt`,
        `approval policy: ${approval.policy} (${approval.policySource}); deployment default ${approval.deploymentPolicy} from DSH_PERMISSION_MODE=${approval.permissionMode}; approval seam ${approval.seam}`,
        `risk: ${approval.warning}`,
      ]
      return lines.join('\n')
    },
  }))
}
