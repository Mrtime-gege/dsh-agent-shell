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
  }
}

export class TmuxDriver {
  /**
   * @param {object} options - subprocess/timer 服务与本插件的配置。
   */
  constructor(options) {
    this.subprocess = options.subprocess
    this.timer = options.timer
    this.socket = options.socket
    this.historyLimit = options.historyLimit
    this.shell = options.shell
    this.cwd = options.cwd
    this.pidFile = options.pidFile
    this.confFile = `/tmp/${options.socket}-tmux.conf`
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
    const script = `printf '%s\\n' ${lines.map((l) => `'${l.replace(/'/g, "'\\''")}'`).join(' ')} > ${this.confFile}`
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
  async screen(name, lines) {
    const args = lines === undefined
      ? ['capture-pane', '-p', '-t', name]
      : ['capture-pane', '-p', '-S', `-${lines}`, '-t', name]
    const result = await this.probe(args, { cap: lines === undefined ? 4 * 1024 * 1024 : 16 * 1024 * 1024 })
    if (result.code !== 0) {
      const detail = (result.err || result.out || '').trim()
      throw new Error(`cannot read session "${name}": ${detail}`)
    }
    return result.out.replace(/\n+$/, '')
  }

  /** 建一个新会话并启动交互式 shell。 */
  async create({ name, cols, rows, cwd }) {
    await this.tmux([
      'new-session', '-d', '-s', name,
      '-x', String(cols), '-y', String(rows),
      '-c', cwd,
      this.shell,
    ])
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

  async kill(name) {
    await this.tmux(['kill-session', '-t', name])
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
   * 沿 /proc 向上找到 harness 进程自身的 pid。
   *
   * 不依赖 `$PPID`：subprocess 之间可能夹着包装进程，向上找到 cmdline 里含 `dsh`
   * 的那个祖先才可靠。
   */
  async harnessPid() {
    const script = [
      'p=$PPID',
      'while [ -n "$p" ] && [ "$p" != "1" ] && [ "$p" != "0" ]; do',
      '  if [ -r "/proc/$p/cmdline" ] && grep -qa dsh "/proc/$p/cmdline"; then echo "$p"; exit 0; fi',
      '  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
      'done',
      'echo ""',
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
      `echo "$$ ${pid}" > ${this.pidFile}`,
      `DPID=${pid}`,
      `if [ ! -r "/proc/$DPID/cmdline" ]; then rm -f ${this.pidFile}; exit 0; fi`,
      'while [ -r "/proc/$DPID/cmdline" ] && grep -qa dsh "/proc/$DPID/cmdline"; do sleep 2; done',
      // 守卫：若还有别的 dsh 实例活着（快速重启），不要杀它的服务端
      `if ! pgrep -f "dsh web" >/dev/null 2>&1; then tmux -L ${this.socket} kill-server 2>/dev/null; fi`,
      `rm -f ${this.pidFile}`,
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
    const result = await this.run(['sh', '-c', `cat ${this.pidFile} 2>/dev/null`], { cap: 4096 })
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
      ? `p=$(cut -d' ' -f1 ${this.pidFile} 2>/dev/null); if [ "$p" = "${pid}" ]; then kill "${pid}" 2>/dev/null; rm -f ${this.pidFile}; fi; exit 0`
      : `p=$(cut -d' ' -f1 ${this.pidFile} 2>/dev/null); if [ -n "$p" ]; then kill "$p" 2>/dev/null; fi; rm -f ${this.pidFile}; exit 0`
    await this.run(['sh', '-c', script], { cap: 4096 })
  }

  /**
   * 启动时的收尾。
   *
   * 关键判断：pid 文件里记的若是**本进程**，说明只是热重载 —— 此时**收养**已有看门狗
   * 并保留全部会话，绝不重建。否则（上次运行崩溃残留）才清孤儿并重新布防。
   *
   * 这条规则同时解决两个实测问题：热重载会把用户所有 shell 清空；以及旧实例的
   * dispose 会杀掉新实例的看门狗。
   *
   * @returns {Promise<{adopted: boolean, cleaned: string[], watchdogPid: string, harnessPid: string}>}
   */
  async bootstrap() {
    // 配置文件要先落地：服务端由接下来第一条 tmux 命令启动时就会读它。
    await this.writeServerConfig()
    const harness = await this.harnessPid()
    const prior = await this.readWatchdogState()
    if (prior.harnessPid !== '' && prior.harnessPid === harness && prior.watchdogPid !== '') {
      if (await this.isAlive(prior.watchdogPid)) {
        return { adopted: true, cleaned: [], watchdogPid: prior.watchdogPid, harnessPid: harness }
      }
    }
    await this.disarmWatchdog()
    await this.pause(300)
    const cleaned = await this.cleanupOrphans()
    const watched = await this.armWatchdog()
    return { adopted: false, cleaned, watchdogPid: watched === '' ? '' : await this.watchdogPid(), harnessPid: harness }
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
