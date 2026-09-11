/**
 * dsh-agent-shell —— tmux 驱动
 *
 * 一个**私有** tmux 服务端（`-L <socket>`），上面挂多个命名会话，与用户自己的
 * tmux（默认 socket）完全隔离，互不干扰。
 *
 * 所有外部命令都经 `ctx.subprocess` 发出，因此沿用调用时的沙箱模式。受限模式下
 * 每次调用各自一个 bwrap、私有 PID 命名空间，tmux 服务端无法跨调用共享，所以这套
 * 能力需要 danger-full-access；`diagnose()` 会实测并报告这一点。
 *
 * 生命周期：`armWatchdog()` 布防一个**脱离进程树**的守护进程（setsid），
 * 它在 harness 进程消失后杀掉本服务端 —— 这是唯一能覆盖 `kill -9` / 崩溃的手段。
 */

/** list-panes 的字段分隔符。tab 不会出现在会话名或命令名里。 */
const SEP = '\t'

/** list-panes 的格式串：一行一个会话（本插件每个会话只有一个 pane）。 */
const LIST_FORMAT = [
  '#{session_name}',
  '#{window_width}',
  '#{window_height}',
  '#{session_windows}',
  '#{session_attached}',
  '#{pane_current_command}',
  '#{pane_pid}',
  '#{history_size}',
  '#{history_limit}',
  '#{history_bytes}',
  '#{session_created}',
  // 光标（画插入点用）：tmux 自己就知道光标在哪，之前只是没取。
  // `cursor_flag` 为 0 表示程序把光标藏了 —— 那种情况下我们也不该画（不画终端不会画的东西）。
  '#{cursor_x}',
  '#{cursor_y}',
  '#{cursor_flag}',
  '#{pane_height}',
].join(SEP)

/** 一个 shell 会话在 UI 侧需要的全部标量。 */
function toSession(row) {
  const f = row.split(SEP)
  const num = (v) => {
    const n = Number.parseInt(v ?? '', 10)
    return Number.isFinite(n) ? n : 0
  }
  return {
    name: f[0] ?? '',
    cols: num(f[1]),
    rows: num(f[2]),
    windows: num(f[3]),
    attached: num(f[4]) > 0,
    foreground: f[5] ?? '',
    pid: num(f[6]),
    historySize: num(f[7]),
    historyLimit: num(f[8]),
    historyBytes: num(f[9]),
    createdAt: num(f[10]),
    // 光标在**可见窗格**里的单元格坐标（不是字符下标：中文占 2 格，映射交给客户端）
    cursorX: num(f[11]),
    cursorY: num(f[12]),
    cursorVisible: num(f[13]) !== 0,
    paneHeight: num(f[14]),
  }
}

/**
 * POSIX shell 单引号转义。
 *
 * 存在的理由很具体：本文件里有 6 处把**配置派生的值**（socket 名 → pid/conf 文件路径）
 * 拼进 `sh -c` 字符串，而 `socket` 来自用户配置 —— 拼不对就是命令注入。即使上层已经
 * 校验过，这里也必须再引一次（纵深防御；顺带修好带空格的路径）。
 */
export function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
}

/**
 * 把 socket 名收敛到安全字符集。
 *
 * socket 决定 `-L <name>`、`/tmp/<name>-tmux.conf`、`/tmp/<name>-watchdog.pid` —— 后两个会被
 * 拼进 shell 命令，所以它**不能**是任意字符串。非法字符直接剔除；全被剔除或过长时退回
 * 默认名 `dsh-agent`（宁可换一个干净的服务端，也不要执行注入）。
 */
export function sanitizeSocketName(value) {
  const cleaned = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '')
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'dsh-agent'   // 纯点号（含 .. / ...）一律退回默认名
  return cleaned.slice(0, 64)
}

export class TmuxDriver {
  /**
   * @param {object} options - subprocess/timer 服务与本插件的配置。
   */
  constructor(options) {
    this.subprocess = options.subprocess
    this.timer = options.timer
    // socket 决定 conf/pid 文件路径，而那两个会被拼进 shell 命令 —— 在这里一次性收敛，
    // 后续派生值（confFile / pidFile）自然安全。被改写过时记下原值，由上层如实提示用户。
    this.socket = sanitizeSocketName(options.socket)
    this.socketRewrittenFrom = String(options.socket ?? '') !== this.socket ? String(options.socket ?? '') : ''
    this.historyLimit = options.historyLimit
    this.shell = options.shell
    this.cwd = options.cwd
    this.pidFile = options.pidFile
    this.confFile = `/tmp/${this.socket}-tmux.conf`
    this.defaultTerminal = options.defaultTerminal ?? 'tmux-256color'
    /** 是否在服务端配置里加 `extended-keys on`（需要 tmux ≥ 3.2，默认关，见 index.js 的注释）。 */
    this.extendedKeys = options.extendedKeys === true
  }

  /** 跑一条命令并收回完整输出。 */
  async run(argv, options = {}) {
    const handle = this.subprocess.spawn({
      argv,
      cwd: options.cwd ?? this.cwd,
      stdio: {
        stdin: options.stdin ?? 'ignore',
        stdout: { maxBytes: options.cap ?? 4 * 1024 * 1024 },
        stderr: { maxBytes: options.cap ?? 1024 * 1024 },
      },
      graceMs: options.graceMs ?? 15000,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout === undefined ? '' : handle.collected.stdout.readFrom(0).text
    const err = handle.collected.stderr === undefined ? '' : handle.collected.stderr.readFrom(0).text
    return { code: outcome.exitCode, out, err }
  }

  /**
   * 所有 tmux 调用的公共前缀。
   *
   * 同时带上 `-L <socket>`（私有服务端）与 `-f <conf>`。`-f` **必须**出现在每条
   * 命令上：服务端是被第一条命令启动的，而启动期才会读这个配置文件 —— 只有把
   * `history-limit` 放进这里，新建窗口才会采用它（实测：事后 `set-option -w` 改不动
   * 已存在窗格的上限，仍是 2000）。
   */
  tmuxArgv(args) {
    return ['tmux', '-L', this.socket, '-f', this.confFile, ...args]
  }

  /** 带公共前缀的 tmux 调用；非零退出抛错。 */
  async tmux(args, options) {
    const result = await this.run(this.tmuxArgv(args), options)
    if (result.code !== 0) {
      const detail = (result.err || result.out || '').trim()
      throw new Error(`tmux ${args[0]} failed: ${detail}`)
    }
    return result.out
  }

  /**
   * 开工前的体检：tmux 在不在、版本多少。
   *
   * tmux 是**系统依赖**，不在 package.json 里，包管理器一句话都不会说。装了插件却没有 tmux 的
   * 机器（Windows 原生、精简容器、刚装好的 Mac）会一路"装成功"，然后在第一次开会话时抛一个
   * 谁也看不懂的 spawn 错误。所以这里探一次，把结论如实交给上层去显示 —— 开箱即用首先要能
   * **说清缺什么**。
   *
   * @returns {Promise<{ok: boolean, version: string, error: string}>}
   */
  async probeTmux() {
    try {
      const result = await this.run(['tmux', '-V'], { cap: 1024, graceMs: 10000 })
      const text = `${result.out}${result.err}`.trim()
      if (result.code === 0 && /^tmux /i.test(text)) {
        // 版本号决定若干行为（extended-keys 需要 ≥3.2；更老的版本用法也可能不同）
        return { ok: true, version: text, error: '' }
      }
      return { ok: false, version: '', error: text === '' ? `exit code ${String(result.code)}` : text.slice(0, 200) }
    } catch (error) {
      // ENOENT 会以异常形式出现（可执行文件不存在时 spawn 直接失败）
      return { ok: false, version: '', error: String(error?.message ?? error).slice(0, 200) }
    }
  }

  /** 同 `tmux()`，但不因非零退出抛错 —— 用于探测。 */
  probe(args, options) {
    return this.run(this.tmuxArgv(args), options)
  }

  /** 等待若干毫秒（计时器服务缺失时退化为立即返回）。 */
  async pause(ms) {
    if (this.timer === undefined || ms <= 0) return
    await this.timer.timeout(ms)
  }

  // ── 服务端选项 ─────────────────────────────────────────────────────────────

  /**
   * 写服务端启动期配置文件。
   *
   * 这些选项在**服务端启动时**生效，因此必须放进 `-f` 读到的文件里，而不是事后
   * `set-option -g`（那时服务端还没起来，`set-option` 会失败 —— 实测踩过，
   * 结果是会话上限停在默认 2000）。
   *
   * 注意 `window-size` **不能**放在这里：放在启动期配置里会让服务端起不来
   * （tmux 直接 "server exited unexpectedly"，已逐项二分确认）。它在运行期设置
   * 没问题，所以归 `applyRuntimeOptions()`。
   */
  async writeServerConfig() {
    const lines = [
      `set -g history-limit ${this.historyLimit}`,
      `set -g default-terminal ${this.defaultTerminal}`,
      'set -g status off',
      'set -g mouse off',
      'set -g escape-time 10',
      // 必须在 `-f` 读的这份配置里：服务端启动后 `set -g` 也能改，但选项本身要在这里就位。
      // 实测（tmux 3.6b）加上它不影响建会话与按键投递；老版本 tmux 不认这个选项，故默认关闭。
      ...(this.extendedKeys ? ['set -g extended-keys on'] : []),
    ]
    const script = `printf '%s\\n' ${lines.map((l) => `'${l.replace(/'/g, "'\\''")}'`).join(' ')} > ${shQuote(this.confFile)}`
    await this.run(['sh', '-c', script], { cap: 4096 })
  }

  /*
   * ⚠️ 切勿设置 `window-size manual`。
   *
   * 实测（tmux 3.6b）：把该全局会话选项设为 `manual` 之后，**服务端会在随后退出** ——
   * 下一条 `new-session` 报 `server exited unexpectedly`，其上的全部会话一并消失。
   * 逐项二分确认过：`status` / `mouse` / `escape-time` / `window-size latest` 都无害，
   * 只有 `manual` 致命；放进 `-f` 配置文件里同样会让服务端起不来。
   *
   * 代价与取舍：不设它，窗口就沿用 tmux 默认的 `window-size latest` —— detached 时
   * 保持创建时的尺寸；一旦有人 `tmux attach` 围观，窗格会跟随对方的终端尺寸。
   * 这可以接受（围观者能看到完整画面），需要时用 `shell_resize` 改回来。
   */

  // ── 会话 ───────────────────────────────────────────────────────────────────

  /** 全部会话及其指标。 */
  async list() {
    const result = await this.probe(['list-panes', '-a', '-F', LIST_FORMAT])
    if (result.code !== 0) return []
    return result.out
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map(toSession)
  }

  /** 会话名列表。 */
  async liveNames() {
    const result = await this.probe(['list-sessions', '-F', '#{session_name}'])
    if (result.code !== 0) return []
    return result.out.split('\n').filter((line) => line.length > 0)
  }

  async has(name) {
    const result = await this.probe(['has-session', '-t', name])
    return result.code === 0
  }

  /**
   * 读取可见屏（`lines` 给定时从可见屏顶部再向上回溯这么多行）。
   */
  /**
   * 读屏幕。
   *
   * @param options.trim - 是否去掉**结尾空行**（默认 true）。
   *   面板必须传 `false`：它要靠「行数」把 tmux 的光标坐标 `cursorY` 换算成文本行号，
   *   而 `行号 = 总行数 − paneHeight + cursorY` —— 结尾空行被吃掉时总行数不够，
   *   算出来是负数，于是**文本少时（窗格下方是空的）光标干脆不显示**（实测踩到）。
   *   工具路径要的是干净文本，所以保持默认裁剪。
   */
  async screen(name, lines, options = {}) {
    const args = lines === undefined
      ? ['capture-pane', '-p', '-t', name]
      : ['capture-pane', '-p', '-S', `-${lines}`, '-t', name]
    const result = await this.probe(args, { cap: lines === undefined ? 4 * 1024 * 1024 : 16 * 1024 * 1024 })
    if (result.code !== 0) {
      const detail = (result.err || result.out || '').trim()
      throw new Error(`cannot read session "${name}": ${detail}`)
    }
    const raw = options.trim === false ? result.out.replace(/\n$/, '') : result.out.replace(/\n+$/, '')
    return raw
  }

  /** 建一个新会话并启动交互式 shell。 */
  async create({ name, cols, rows, cwd }) {
    const argv = [
      'new-session', '-d', '-s', name,
      '-x', String(cols), '-y', String(rows),
      '-c', cwd,
      this.shell,
    ]
    // 竞态重试：服务端刚被 kill（或最后一个会话结束、服务端自行退出）时，紧接着的
    // `new-session` 有约一半概率返回 `server exited unexpectedly` —— 实测无延迟时
    // 8 次里失败 4 次，加 300ms 延迟后 0 次失败。用户可见路径就是「关掉最后一个 shell
    // 再开一个新的」，所以这里必须自己退避重试，而不是把这个错误丢给用户。
    const RETRIES = 3
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.tmux(argv)
        return
      } catch (error) {
        const message = String(error?.message ?? error)
        const transient = /server exited unexpectedly|no server running|error connecting to/i.test(message)
        if (!transient || attempt >= RETRIES) throw error
        await this.pause(300 * attempt)
      }
    }
  }

  /**
   * 开始给一个会话做**输出留痕**：tmux 的 `pipe-pane` 把该窗格收到的字节实时追加到文件。
   *
   * 记的是窗格**输出**（含回显的命令、程序输出、TUI 画面），因此它回答的是"实际发生了什么"，
   * 与输入流水（谁发了什么）互补。会话被关掉后文件**依然在** —— 这就是"关闭会话后依然可见"。
   *
   * 两点注意：
   *   * `-o` 表示"已经开着就不再开"，重复调用安全；
   *   * 命令由 tmux 交给 `sh -c` 执行，所以路径必须引用（`shQuote`）——否则就是个注入点。
   */
  async startCapture(name, file) {
    await this.tmux(['pipe-pane', '-o', '-t', name, `cat >> ${shQuote(file)}`])
  }

  /** 停止输出留痕（不传命令即关闭管道）。会话已消失时静默忽略。 */
  async stopCapture(name) {
    try {
      await this.tmux(['pipe-pane', '-t', name])
    } catch { /* 会话已不在：管道随会话一起消失了 */ }
  }

  /** 往会话里发按键：`text` 逐字面写入，`keys` 按 tmux 按键名发送。 */
  async send(name, text, keys) {
    if (typeof text === 'string' && text.length > 0) {
      await this.tmux(['send-keys', '-l', '-t', name, text])
    }
    if (Array.isArray(keys)) {
      for (const key of keys) {
        if (typeof key === 'string' && key.length > 0) {
          await this.tmux(['send-keys', '-t', name, key])
        }
      }
    }
  }

  async resize(name, cols, rows) {
    await this.tmux(['resize-window', '-t', name, '-x', String(cols), '-y', String(rows)])
  }

  /**
   * 关闭一个会话。**幂等**：会话已经不在（或服务端已经自行退出）不算错误。
   *
   * 理由很实在：面板的列表可能比现实旧一点，用户点 ✕ 时那个 shell 可能刚好自己结束了；
   * 最后一个会话结束时 tmux 服务端还会**自行退出**，于是 `kill-session` 直接报
   * `no server running on …`。把这种情况当失败抛给用户毫无意义 —— 他要的结果
   * （这个 shell 没了）已经达成。
   *
   * @returns {Promise<{closed: boolean, reason?: string}>}
   */
  async kill(name) {
    if (!(await this.has(name))) return { closed: false, reason: 'not-found' }
    try {
      await this.tmux(['kill-session', '-t', name])
      return { closed: true }
    } catch (error) {
      const message = String(error?.message ?? error)
      // 检查与关闭之间会话可能刚好结束（TOCTOU），同样是「已经没了」
      if (/can't find session|no server running|error connecting to/i.test(message)) {
        return { closed: false, reason: 'not-found' }
      }
      throw error
    }
  }

  /**
   * 重命名会话。
   *
   * tmux 会自作主张地把名字里的 `.` 和 `:` 换成 `_`，所以调用方必须**先净化**名字，
   * 否则 UI 显示的名字会和 tmux 里的真实名字不一致（之后按名字操作就会找不到）。
   */
  async rename(from, to) {
    await this.tmux(['rename-session', '-t', from, to])
  }

  /** 前台进程名 —— 用来判断 shell 是空闲还是仍在跑东西。 */
  async foregroundOf(name) {
    const result = await this.probe(['display-message', '-p', '-t', name, '#{pane_current_command}'])
    if (result.code !== 0) return ''
    return result.out.trim()
  }

  // ── 服务端生命周期 ─────────────────────────────────────────────────────────

  /** 杀掉整个服务端（含其上全部会话）。 */
  async killServer() {
    await this.probe(['kill-server'])
  }

  /** 清理残留会话（孤儿兜底）。 */
  async cleanupOrphans() {
    const names = await this.liveNames()
    for (const name of names) await this.probe(['kill-session', '-t', name])
    return names
  }

  /**
   * 某个 pid 的命令行里是否出现某个子串（读不到就当作「不是」）。
   *
   * 读 `/proc/<pid>/cmdline`（NUL 分隔）后交给 `grep -qa`，这样不必在 JS 里处理编码。
   */
  async cmdlineMentions (pid, needle) {
    if (!/^[0-9]+$/.test(String(pid))) return false
    const result = await this.run(
      ['sh', '-c', `[ -r "/proc/${pid}/cmdline" ] && grep -qa -- ${JSON.stringify(needle)} "/proc/${pid}/cmdline" && echo yes || echo no`],
      { cap: 4096 },
    )
    return result.out.trim() === 'yes'
  }

  /**
   * 定位 harness 进程自身的 pid。
   *
   * **首选本进程**：插件作为 profile bundle 挂在 host 平面上，与 harness 同进程，
   * 所以 `process.pid` 就是答案 —— 只要确认它看起来确实是 harness（cmdline 含 `dsh`）。
   *
   * 为什么不再直接向上遍历：那条路靠「祖先 cmdline 里出现 `dsh` 字样」认人，实测会被
   * **任何**命令行里提到 dsh 的中间进程骗到。真实踩到的一次是：一条内容里含 "dsh"
   * 字样的 `bash -c "…"` 命令，让探针把那个 shell 的 pid 当成了 harness。
   * 认错的代价很大 —— `bootstrap()` 会因此走「非收养」分支，把用户正在用的会话清掉。
   *
   * 只有当本进程不像 harness（插件被放进子进程的非常规部署）时，才退回到向上遍历；
   * 遍历时取**最上层**的那个匹配项（harness 通常是整条链的最外层 dsh 进程），
   * 这比取最近的一个更不容易被中间包装进程误导。
   */
  async harnessPid () {
    if (await this.cmdlineMentions(process.pid, 'dsh')) return String(process.pid)

    const script = [
      'p=$PPID',
      'found=""',
      'while [ -n "$p" ] && [ "$p" != "1" ] && [ "$p" != "0" ]; do',
      '  if [ -r "/proc/$p/cmdline" ] && grep -qa dsh "/proc/$p/cmdline"; then',
      // 跳过 shell：一条内容里提到 dsh 的 `bash -c "…"` 同样「cmdline 含 dsh」，
      // 但它显然不是 harness（实测就是这么被骗到过）。harness 是 node 之类的长驻进程。
      '    case "$(cat "/proc/$p/comm" 2>/dev/null)" in',
      '      sh|bash|dash|zsh|fish|setsid) ;;',
      '      *) found="$p" ;;',
      '    esac',
      '  fi',
      '  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
      'done',
      'echo "$found"',
    ].join('\n')
    const result = await this.run(['sh', '-c', script], { cap: 4096 })
    if (result.code !== 0) return ''
    const pid = result.out.trim()
    return /^[0-9]+$/.test(pid) ? pid : ''
  }

  /**
   * 布防孤儿看门狗。
   *
   * tmux 服务端会 setsid 并 reparent，harness 退出时的托管进程清理**够不到它**，
   * 所以需要一个刻意脱离进程树的守护进程：harness 进程消失后杀掉本服务端。
   * `setsid -f` 让它进入新的 session/进程组，从而在被调用方被清理时幸存。
   *
   * @returns {Promise<string>} 被监视的 harness pid，未布防时为空串。
   */
  async armWatchdog() {
    const pid = await this.harnessPid()
    if (pid === '') return ''
    const script = [
      'exec >/dev/null 2>&1',
      `echo "$$ ${pid}" > ${shQuote(this.pidFile)}`,
      `DPID=${pid}`,
      `if [ ! -r "/proc/$DPID/cmdline" ]; then rm -f ${shQuote(this.pidFile)}; exit 0; fi`,
      // 存活判定必须容错：单次读 /proc 或 grep 失败**不等于** harness 死了。
      // 实测出现过一次误判就让看门狗永久退出，从此再无孤儿兜底、而且没有任何人知道。
      // 连续 3 次（约 6 秒）都失败才判定消失 —— 这也顺便给「重启 dsh web」留出了窗口。
      'miss=0',
      'while [ "$miss" -lt 3 ]; do',
      '  if [ -r "/proc/$DPID/cmdline" ] && grep -qa dsh "/proc/$DPID/cmdline"; then miss=0; else miss=$((miss+1)); fi',
      '  sleep 2',
      'done',
      // 守卫：若还有别的 harness 活着（快速重启），不要杀它的服务端。
      // ⚠ 这里必须排除自身 pid：本脚本的命令行**就含** `dsh web` 这个字面量，
      // 用光秃秃的 `pgrep -f "dsh web"` 每次都能匹配到看门狗自己，于是守卫恒为真、
      // kill-server 永不执行 —— 孤儿兜底等于完全失效（实测确认）。
      `if ! pgrep -f "dsh web" 2>/dev/null | grep -qv "^$$$"; then tmux -L ${shQuote(this.socket)} kill-server 2>/dev/null; fi`,
      `rm -f ${shQuote(this.pidFile)}`,
    ].join('\n')
    await this.run(['setsid', '-f', 'sh', '-c', script], { cap: 8192, graceMs: 5000 })
    return pid
  }

  /**
   * 读回看门狗状态。
   *
   * pid 文件内容为 `"<看门狗pid> <被监视的harness pid>"`：第二个字段让新实例能
   * 判断这项布防是不是**本进程**的，从而在热重载时收养它而不是重建。
   *
   * @returns {Promise<{watchdogPid: string, harnessPid: string}>} 两个字段都可能为空串。
   */
  async readWatchdogState() {
    const result = await this.run(['sh', '-c', `cat ${shQuote(this.pidFile)} 2>/dev/null`], { cap: 4096 })
    const parts = result.out.trim().split(/\s+/)
    return {
      watchdogPid: /^[0-9]+$/.test(parts[0] ?? '') ? parts[0] : '',
      harnessPid: /^[0-9]+$/.test(parts[1] ?? '') ? parts[1] : '',
    }
  }

  /** 读回看门狗 pid（没有则为空串）。 */
  async watchdogPid() {
    const state = await this.readWatchdogState()
    if (state.watchdogPid === '') return ''
    const alive = await this.isAlive(state.watchdogPid)
    return alive ? state.watchdogPid : ''
  }

  /**
   * 某个路径是否是**存在的目录**。
   *
   * 必须有这一道检查：`new-session -c <不存在的目录>` **不会报错**，tmux 会静默回落到
   * 用户 home 起一个 shell —— 而插件会把请求的路径当作实际 cwd 报回去，等于对调用方说谎
   * （实测确认：`-c /nonexistent` 建的会话里 `pwd` 是 /home/<user>）。
   */
  async isDirectory (path) {
    if (typeof path !== 'string' || path.length === 0) return false
    const result = await this.run(['sh', '-c', 'test -d "$1"', 'sh', path], { cap: 4096 })
    return result.code === 0
  }

  /** 某个 pid 是否还活着。 */
  async isAlive(pid) {
    const result = await this.run(['sh', '-c', `kill -0 ${pid} 2>/dev/null && echo yes || echo no`], { cap: 4096 })
    return result.out.trim() === 'yes'
  }

  /**
   * 停掉看门狗。
   *
   * `pid` 给定时**只处理本实例布防的那一个**：pid 文件里若已不是它（说明已被新
   * 实例接管），就什么都不做。否则一次热重载里旧实例的 dispose 会把新实例刚布防
   * 的看门狗清掉 —— 这个竞态实测踩过。
   *
   * @param {string} [pid] - 本实例布防的看门狗 pid；省略则清掉文件里记着的那一个。
   */
  async disarmWatchdog(pid) {
    const script = typeof pid === 'string' && pid.length > 0
      ? `p=$(cut -d' ' -f1 ${shQuote(this.pidFile)} 2>/dev/null); if [ "$p" = ${shQuote(pid)} ]; then kill "${pid}" 2>/dev/null; rm -f ${shQuote(this.pidFile)}; fi; exit 0`
      : `p=$(cut -d' ' -f1 ${shQuote(this.pidFile)} 2>/dev/null); if [ -n "$p" ]; then kill "$p" 2>/dev/null; fi; rm -f ${shQuote(this.pidFile)}; exit 0`
    await this.run(['sh', '-c', script], { cap: 4096 })
  }

  /**
   * 启动时的收尾。
   *
   * 两种结果：
   *   1. **收养**：pid 文件里记的就是本进程且看门狗还活着 → 什么都不动（热重载的常态）。
   *   2. **重新布防**：其余情况只把看门狗布好 —— **绝不清理会话**。
   *
   * 关于第 2 条为什么不再清会话（这是实测改掉的旧行为）：
   *
   * 旧实现把「pid 文件不是本进程」当作「上次崩溃的残留」，于是清会话重布防。
   * 但 pid 文件根本区分不出下面三件事，而它们的正确处置完全不同：
   *
   *   * 热重载（同进程）：pid 相同 → 收养（这条本来就对）；
   *   * 正常重启 `dsh web`：pid 是上一个已消失的进程 → **旧实现会清掉用户全部 shell**；
   *   * 上次被 kill -9：确实是残留 → 清掉是合理的。
   *
   * 更要命的是第一/三种的判定依赖「认对 harness pid」，而认错一次（见 harnessPid 的注释）
   * 就足以把用户正在跑的东西全杀掉。**会话是用户的，服务端是无状态的**：留着一个多出来的
   * tmux 服务端几乎无害（下次建会话会直接复用它），而清掉用户的 shell 是不可逆的损失。
   * 想要干净重来，用 `killServer()` 或逐个 `shell_close` 显式表达。
   *
   * @returns {Promise<{adopted: boolean, kept: string[], cleaned: string[], watchdogPid: string, harnessPid: string}>}
   */
  async bootstrap() {
    // 配置文件要先落地：服务端由接下来第一条 tmux 命令启动时就会读它。
    await this.writeServerConfig()
    const harness = await this.harnessPid()
    const prior = await this.readWatchdogState()
    if (prior.harnessPid !== '' && prior.harnessPid === harness && prior.watchdogPid !== '') {
      if (await this.isAlive(prior.watchdogPid)) {
        return { adopted: true, kept: [], cleaned: [], watchdogPid: prior.watchdogPid, harnessPid: harness }
      }
    }

    // 记录当前活着的会话（只为让调用方知道「保住了什么」），然后只重布防。
    const kept = await this.liveNames()
    await this.disarmWatchdog()
    const watched = await this.armWatchdog()
    return {
      adopted: false,
      kept,
      cleaned: [],
      watchdogPid: watched === '' ? '' : await this.watchdogPid(),
      harnessPid: harness,
    }
  }

  /**
   * 卸载时的行为：**什么都不做**。
   *
   * 这是刻意的。dispose 会在每一次配置热重载时执行，若在这里 kill-server，用户
   * 每次改配置都会丢掉全部 shell。会话本该在热重载中存活 —— 真正需要收尾的时刻是
   * harness 进程结束，那是看门狗的职责（它在 harness 消失后杀服务端）。
   *
   * 于是：想清空全部 shell 请显式调用 killServer()（或逐个 kill），移除插件后
   * 残留的会话也会在 harness 退出时由看门狗收掉。
   */
  async shutdown() {
    return undefined
  }
}
