/**
 * dsh-agent-shell —— 客户端侧（browser half）
 *
 * 只往 list 槽位加法注册一处 UI：`shell.overlay` 悬浮面板。
 *
 * 为什么用 `shell.overlay`：它是 root 作用域的整框浮层，**不绑定任何会话** ——
 * 切会话、开着别的会话、乃至没有会话时，面板都在。这就是「与对话解耦」在 UI 侧
 * 的落点。
 *
 * 数据不走 package-private RPC，而是同源 HTTP 直连宿主：
 *   GET  <base>/list              会话列表 + 服务端信息
 *   GET  <base>/screen?name=&lines=  可见屏 + 向上 lines 行历史 + 该会话指标
 *       ⚠️ `lines` 必须显式传：缺省时宿主只返回**可见屏**（capture-pane 不带 -S），
 *          也就是窗格高度那么多行 —— 历史一直在 tmux 里，只是没人去取。
 *   POST <base>/keys  /new  /kill  /resize
 * 因此浏览器不经过任何会话即可操作后台 shell。
 *
 * 拖动：胶囊与面板共用**同一个位置锚点**（胶囊的左上角）。拖胶囊用偏移量跟手；
 * 拖面板标题栏用位移量整体平移。位置存 localStorage，跨刷新保留。
 * 拖动与点击靠位移阈值（4px）区分，拖动结束后抑制随之而来的 click。
 *
 * 输入模型（重要）：**真终端模型，没有任何本地缓冲** —— 每个按键都直接送进 shell。
 * 分两条路：
 *   * 特殊键（Tab/↑↓←→/Backspace/Home End/Ctrl-X/Esc）在 keydown 里翻译成 tmux 键名；
 *   * 可打印字符**不拦**，交给浏览器与输入法，再由 `input` 事件交付。
 *
 * 第二条是**中文/日文输入（IME）能用的前提**：输入法的组字由浏览器对按键的默认处理
 * 驱动，一旦把所有字母都 preventDefault 掉，IME 就起不来。组字中间态（isComposing）
 * 必须跳过，否则 "n"/"ni"/"nih" 会被逐个送进终端而不是等"你好"整段提交。
 *
 * 注意：`shell.overlay` 整层默认点击穿透，条目必须显式 opt-in 指针事件。
 */
/**
 * Ctrl+字母白名单：交给终端 readline。
 *
 * 其余组合键放行给浏览器：V/X 是粘贴剪切，W/T/N 关标签开标签等系统快捷键 ——
 * 在输入框里抢这些键会很难用。
 */
const CTRL_KEYS = {
  a: 'C-a', b: 'C-b', c: 'C-c', d: 'C-d', e: 'C-e', f: 'C-f', k: 'C-k',
  l: 'C-l', p: 'C-p', r: 'C-r', u: 'C-u', y: 'C-y', z: 'C-z',
}

/**
 * 一次 keydown 该怎么处理（纯函数，便于脱离浏览器验证）。
 *
 * **最重要的规则：可打印字符一律放行给浏览器，绝不在 keydown 里 preventDefault。**
 * 输入法（IME）的组字是由浏览器对按键的**默认处理**驱动的 —— 抢掉按键会让中文/日文
 * 输入直接失效。字符最终由 `input` 事件交付（组字状态见 {@link decideComposition}）。
 *
 * @param {object} e - `{ key, ctrlKey, metaKey, altKey, shiftKey, isComposing, keyCode, hasSelection }`
 * @returns {{ action: 'key', key: string } | { action: 'pass' }}
 */
/**
 * 组装 ⓘ 详情层要显示的分组键值行 —— **纯函数**，因此可以脱离浏览器单测。
 *
 * 之所以单独抽出来：面板里最容易出错的不是样式而是「某个字段没拿到就直接读」，
 * 而这类错误只有打开面板那一刻才会暴露。纯函数可以在测试里把所有缺字段的组合喂一遍。
 *
 * @param {object} input - { server, meta, sessions, historyWindow, maxWindow, pkgVersion, build, locked }
 * @returns {Array<{group: string, rows: Array<{k: string, v: string, tone?: string, title?: string}>}>}
 */
/**
 * 人类可读的字节数。**放在模块顶层**：`buildInfoRows` 也要用，
 * 而它定义在组件之外 —— 留在组件里会变成「打开面板才报 ReferenceError」的隐藏 bug
 * （这类问题已经被 buildInfoRows 的离线测试抓到过一次）。
 */
function fmtBytes(n) {
  if (!Number.isFinite(n)) return '-'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

/**
 * 把 {@link buildInfoRows} 的结果拍成**纯文本**，用于「复制诊断信息」。
 *
 * 报障时最烦的就是来回问「你什么版本、什么配置、看门狗在不在」——一键复制这整段，
 * 对方一眼就能看出环境。纯函数，因此格式与边界都能单测。
 *
 * @param {Array<{group: string, rows: Array<{k: string, v: string}>}>} sections
 * @param {string} [header] - 首行（版本/构建/时间）
 * @returns {string}
 */
function infoRowsToText(sections, header) {
  const lines = []
  if (typeof header === 'string' && header.length > 0) lines.push(header)
  for (const section of Array.isArray(sections) ? sections : []) {
    if (section === null || typeof section !== 'object') continue
    lines.push('')
    lines.push('## ' + String(section.group === undefined ? '?' : section.group))
    for (const row of Array.isArray(section.rows) ? section.rows : []) {
      if (row === null || typeof row !== 'object') continue
      lines.push(String(row.k === undefined ? '?' : row.k) + ': ' + String(row.v === undefined ? '-' : row.v))
    }
  }
  return lines.join('\n') + '\n'
}

/**
 * 写剪贴板：优先 `navigator.clipboard`（localhost 属于安全上下文，一般可用），
 * 失败再退到「临时 textarea + execCommand」—— 某些浏览器/权限设置会拒绝前者。
 * 两条都失败就把错误交给调用方显示，**不静默失败**。
 *
 * @param {string} text
 * @param {() => void} onDone
 * @param {(message: string) => void} onError
 */
function writeClipboard(text, onDone, onError) {
  const fallback = () => {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.select()
      const ok = document.execCommand !== undefined && document.execCommand('copy')
      document.body.removeChild(area)
      if (ok) onDone()
      else onError('复制失败：浏览器拒绝了剪贴板访问，请手动选中内容后复制')
    } catch (error) {
      onError('复制失败：' + String(error && error.message ? error.message : error))
    }
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined &&
        typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(onDone, fallback)
      return
    }
  } catch (error) { /* 落到 fallback */ }
  fallback()
}

function buildInfoRows(input) {
  const server = input.server !== null && typeof input.server === 'object' ? input.server : {};
  const meta = input.meta !== null && typeof input.meta === 'object' ? input.meta : null;
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const approval = server.approval !== null && typeof server.approval === 'object' ? server.approval : null;
  const bytes = (n) => (typeof n === 'number' && n >= 0 ? fmtBytes(n) : '-');
  const text = (v, fallback) => (v === undefined || v === null || v === '' ? (fallback === undefined ? '-' : fallback) : String(v));

  // 注意：meta 可能是 `null`，也可能是「存在但字段不全」的对象（旧宿主/请求失败）。
  // 因此每个字段都单独判有无 —— 只判断 `meta === null` 会渲染出 `undefined × undefined`。
  const num = (v) => (Number.isFinite(v) ? String(v) : '')
  const pair = (a, b, suffix) => {
    const left = num(a)
    const right = num(b)
    if (left === '' && right === '') return '-'
    return (left === '' ? '?' : left) + ' / ' + (right === '' ? '?' : right) + (suffix === undefined ? '' : suffix)
  }

  const session = [
    { k: '名称', v: text(meta && meta.name, '(无 shell)') },
    { k: '尺寸', v: meta && Number.isFinite(meta.cols) && Number.isFinite(meta.rows) ? String(meta.cols) + ' × ' + String(meta.rows) : '-' },
    { k: '前台进程', v: text(meta && meta.foreground, '(空闲)') },
    { k: '有人接入', v: meta && typeof meta.attached === 'boolean' ? (meta.attached ? '是（有外部终端在看）' : '否') : '-' },
    { k: '输入', v: input.locked === true ? '已锁定' : '已解锁（按键直接进终端）', tone: input.locked === true ? 'dim' : 'ok' },
  ]

  const buffer = [
    { k: '已用行数', v: pair(meta && meta.historySize, meta && meta.historyLimit, ' 行') },
    { k: '已用字节', v: bytes(meta && meta.historyBytes) },
    { k: '取景窗口', v: String(input.historyWindow === undefined ? 200 : input.historyWindow) + ' 行（上限 ' + String(input.maxWindow === undefined ? 5000 : input.maxWindow) + '）' },
  ]

  const serverRows = [
    { k: 'socket', v: '-L ' + text(server.socket, '?'), title: '本插件私有的 tmux 服务端，与你自己开的 tmux 隔离' },
    { k: '会话数', v: String(sessions.length) + ' / ' + text(server.maxSessions, '?') },
    { k: '起始目录', v: text(server.defaultCwd) },
    { k: '默认 shell', v: text(server.shell) },
    { k: 'TERM', v: text(server.defaultTerminal) },
    { k: '滚动缓冲上限', v: text(server.historyLimit) + ' 行' },
    // 这三个字段是 0.1.2 才加进 /list 的：旧宿主不会上报。
    // 缺了就如实写「未知」—— 不能把「没上报」显示成「关」，那是编造状态。
    { k: 'extended-keys', v: server.extendedKeys === true ? '开（TUI 能收到 Shift+Enter 等）'
        : server.extendedKeys === false ? '关（默认；需 tmux ≥ 3.2）' : '未知（宿主未上报，需重启 dsh web）' },
    { k: '危险命令护栏', v: server.guardDangerousCommands === false ? '已关闭'
        : server.guardDangerousCommands === true ? '开（启发式减速带，不是沙箱）' : '未知（宿主未上报）',
      tone: server.guardDangerousCommands === false ? 'warn' : 'dim' },
  ]

  const watchdog = [
    { k: '看门狗', v: server.watchdogEnabled === false ? '未启用'
        : text(server.watchdogPid, '') !== '' ? 'pid ' + String(server.watchdogPid)
        : '未布防（下一次操作会自动重布防）',
      tone: text(server.watchdogPid, '') === '' ? 'warn' : 'ok' },
    { k: '被监视', v: text(server.watchedPid, '(未知)') + '（harness）' },
    { k: '接管方式', v: server.adoptedWatchdog === true ? '收养了已有看门狗' : '本次重新布防' },
    { k: '启动时保住', v: Array.isArray(server.keptAtBoot) && server.keptAtBoot.length > 0 ? server.keptAtBoot.join(', ') : '无（启动时没有会话）' },
  ]

  const approvalRows = [
    { k: '官方审批', v: '未接入 —— 模型的命令不会弹任何询问', tone: 'warn', title: approval ? String(approval.warning || '') : '' },
    { k: '审批缝', v: approval ? text(approval.seam) : '-' },
    { k: '会话策略', v: approval ? text(approval.policy) + '（来源：' + text(approval.policySource) + '）' : '-', tone: 'warn' },
    { k: '部署默认', v: approval ? text(approval.deploymentPolicy) + '（DSH_PERMISSION_MODE=' + text(approval.permissionMode) + '）' : '-' },
  ]

  const version = [
    { k: '插件版本', v: text(input.pkgVersion, '?') },
    { k: '客户端构建', v: text(input.build, '?') },
    { k: '来源', v: '本插件由 AI 开发，未经人工安全审计', tone: 'dim' },
  ]

  const keys = [
    { k: '可打印字符', v: '交给输入法 → 由 input 事件送进终端' },
    { k: 'Enter / Tab', v: '回车 / 补全（Shift+Tab 反向补全）' },
    { k: '↑ ↓ / ← →', v: '历史上下条 / 行内移动' },
    { k: 'Ctrl-A/E/B/F', v: '行首 / 行尾 / 左移 / 右移' },
    { k: 'Ctrl-R', v: '反向搜索历史' },
    { k: 'Ctrl-C/D/L/Z', v: '中断 / EOF / 清屏 / 挂起' },
    { k: 'Esc', v: '送给终端（例如退出选单）' },
    { k: 'Ctrl-V / Ctrl-X', v: '放行给浏览器：粘贴 / 剪切' },
    { k: 'Ctrl+C（有选中）', v: '让浏览器复制，不会误发 SIGINT' },
  ]

  return [
    { group: '当前会话', rows: session },
    { group: '缓冲与取景', rows: buffer },
    { group: '服务端', rows: serverRows },
    { group: '孤儿看门狗', rows: watchdog },
    { group: '审批与安全', rows: approvalRows },
    { group: '版本', rows: version },
    { group: '键位表', rows: keys },
  ]
}

function decideKey(e) {
  // 组字中：回车/空格/Tab/方向键都在给输入法选词，一个都不能抢。
  if (e.isComposing === true || e.keyCode === 229) return { action: 'pass' }

  if (e.ctrlKey === true || e.metaKey === true || e.altKey === true) {
    if (e.ctrlKey !== true || e.altKey === true || e.metaKey === true) return { action: 'pass' }
    if (typeof e.key !== 'string' || e.key.length !== 1) return { action: 'pass' }
    const mapped = CTRL_KEYS[e.key.toLowerCase()]
    if (mapped === undefined) return { action: 'pass' }
    // 有选中文本时 Ctrl+C 让浏览器复制，而不是往终端送 SIGINT 打断正在跑的命令
    if (mapped === 'C-c' && e.hasSelection === true) return { action: 'pass' }
    return { action: 'key', key: mapped }
  }

  const named = {
    Tab: e.shiftKey === true ? 'BTab' : 'Tab',
    Enter: 'Enter',
    Backspace: 'BSpace',
    Delete: 'Delete',
    Escape: 'Escape',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  }
  const hit = named[e.key]
  if (hit !== undefined) return { action: 'key', key: hit }
  return { action: 'pass' }
}

/**
 * 组字状态机（纯函数，便于脱离浏览器验证）。
 *
 * **为什么不用事件的 `isComposing` 判断**：Chrome 在组字提交时补的那个 `input` 事件里
 * `isComposing` 常常仍是 `true`（已知的浏览器不一致），而且各浏览器的 `input` /
 * `compositionend` **顺序也不同**（Chrome 多为 input 先、Safari 多为 compositionend 先）。
 * 只按事件字段判断会漏掉整次提交，表现就是「提交的汉字滞留在输入框里，直到敲下一个字符
 * 才和后面的字一起被送走」。
 *
 * 所以改成自己维护状态：`compositionstart` 置位、`compositionend` 清位，
 * `input` **只看自己这个标志**。对三种顺序都成立，且「谁先读到谁清空」避免重复发送。
 *
 * @param {string} kind - `'compositionstart'` | `'compositionend'` | `'input'` | `'keydown'`
 * @param {{ composing: boolean, value?: string, eventIsComposing?: boolean }} state
 * @returns {{ composing: boolean, commit: string }} 新状态，以及本次要送进终端的文本
 */
function decideComposition(kind, state) {
  if (kind === 'compositionstart') return { composing: true, commit: '' }
  if (kind === 'compositionend') {
    return { composing: false, commit: typeof state.value === 'string' ? state.value : '' }
  }
  if (kind === 'keydown') {
    // 非组字的按键说明组字已经结束：顺手清位，避免标志被卡住
    return { composing: state.eventIsComposing === true, commit: '' }
  }
  // input：
  //  * 事件明确说「非组字」（isComposing === false）时以它为准 —— 万一 compositionend
  //    没触发，也不至于让标志永久卡住、把之后所有输入都吞掉；
  //  * 否则只信自己维护的标志。
  const value = typeof state.value === 'string' ? state.value : ''
  if (state.eventIsComposing !== false && state.composing === true) return { composing: true, commit: '' }
  return { composing: false, commit: value }
}

/** 图标路径（24×24 视口，描边式）。用 SVG 而不是 emoji —— emoji 在各平台渲染差异太大。 */
const ICON_PATHS = {
  prev: 'M15 18l-6-6 6-6',
  next: 'M9 18l6-6-6-6',
  down: 'M6 9l6 6 6-6',
  lock: 'M8 11V7a4 4 0 018 0v4M6 11h12v9H6z',
  unlock: 'M8 11V7a4 4 0 017.5-2M6 11h12v9H6z',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6L6 18',
  min: 'M5 12h14',
  push: 'M12 19V5M5 12l7-7 7 7',
  more: 'M12 5v14M7 10l5-5 5 5',
  latest: 'M12 5v14M7 14l5 5 5-5',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  pencil: 'M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17zM14 6l3 3',
  info: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5M12 7.6h.01',
}

/**
 * 面板样式。
 *
 * 为什么要注入 <style>：内联样式表达不了 `:hover` / `:active` / 过渡，而这些正是
 * 「按钮看着不丑」的关键。`apply()` 里插一次并在 `ctx.effect` 的清理里移除。
 */
const PANEL_CSS = `
.dshsh-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;
  border:1px solid var(--dsw-alias-border-primary,#2a2f3a);border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary,#94a3b8);cursor:pointer;flex:0 0 auto;
  transition:background .12s ease,color .12s ease,border-color .12s ease,transform .06s ease}
.dshsh-btn:hover:not(:disabled){background:rgba(148,163,184,.16);color:var(--dsw-alias-label-primary,#e2e8f0)}
.dshsh-btn:active:not(:disabled){transform:translateY(1px)}
.dshsh-btn:focus-visible{outline:2px solid #3b82f6;outline-offset:1px}
.dshsh-btn:disabled{opacity:.3;cursor:not-allowed}
.dshsh-btn.on{border-color:#22c55e;color:#22c55e;background:rgba(34,197,94,.14)}
.dshsh-btn.locked{border-color:#f59e0b;color:#f59e0b;background:rgba(245,158,11,.14)}
.dshsh-btn.danger:hover:not(:disabled){border-color:#ef4444;color:#ef4444;background:rgba(239,68,68,.14)}
.dshsh-btn.accent:hover:not(:disabled){border-color:#3b82f6;color:#3b82f6;background:rgba(59,130,246,.16)}
.dshsh-btn.hot{border-color:#f59e0b;color:#f59e0b;background:rgba(245,158,11,.18)}

.dshsh-grip{color:var(--dsw-alias-label-secondary,#64748b);cursor:grab;display:inline-flex;align-items:center;
  padding:0 2px;flex:0 0 auto;letter-spacing:-1px;user-select:none}

.dshsh-name{display:inline-flex;align-items:center;gap:5px;height:26px;max-width:280px;padding:0 7px 0 10px;
  border:1px solid transparent;border-radius:7px;background:transparent;cursor:pointer;flex:0 1 auto;
  color:var(--dsw-alias-label-primary,#e2e8f0);font:inherit;font-size:12px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  transition:background .12s ease,border-color .12s ease}
.dshsh-name:hover{background:rgba(148,163,184,.16);border-color:var(--dsw-alias-border-primary,#2a2f3a)}
.dshsh-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.dshsh-count{font-size:11px;color:var(--dsw-alias-label-secondary,#94a3b8);font-variant-numeric:tabular-nums;flex:0 0 auto}
.dshsh-spacer{flex:1 1 auto}

.dshsh-info{position:absolute;top:40px;right:8px;z-index:41;width:min(440px,calc(100% - 16px));
  max-height:calc(100% - 84px);overflow:auto;overscroll-behavior:contain;padding:0 12px 12px;
  border:1px solid var(--dsw-alias-border-primary,#2a2f3a);border-radius:12px;
  background:var(--dsw-alias-bg-primary,#16181d);box-shadow:0 18px 44px rgba(0,0,0,.62);
  font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-primary,#e2e8f0)}
/* 头部条吸顶：滚长列表时「复制/关闭」始终在手边 */
.dshsh-info-bar{display:flex;align-items:center;gap:8px;padding:9px 0 8px;margin:0 0 8px;
  border-bottom:1px solid rgba(148,163,184,.16);position:sticky;top:0;z-index:2;
  background:var(--dsw-alias-bg-primary,#16181d)}
.dshsh-info-bar>t{flex:1 1 auto;font-size:12px;font-weight:600;letter-spacing:.01em}
/* 风险横幅：最要紧的一条放在最上面，而不是埋进第 N 组 */
.dshsh-info-alert{display:flex;gap:8px;align-items:flex-start;margin:0 0 10px;padding:7px 9px;border-radius:8px;
  border-left:3px solid #f87171;background:rgba(248,113,113,.10);color:#fca5a5;font-size:11px;line-height:1.55}
.dshsh-info-alert b{color:#fca5a5}
.dshsh-info-group{display:flex;align-items:baseline;gap:6px;margin:12px 0 4px;padding-bottom:3px;
  border-bottom:1px solid rgba(148,163,184,.16);font-size:10.5px;letter-spacing:.05em;color:#94a3b8;
  text-transform:uppercase;font-weight:600}
.dshsh-info-group:first-of-type{margin-top:2px}
.dshsh-info-group>c{margin-left:auto;font-size:10px;color:#64748b;letter-spacing:0;text-transform:none;font-weight:400}
.dshsh-kv{display:flex;gap:10px;align-items:baseline;padding:3px 6px;border-radius:5px;cursor:default}
.dshsh-kv:hover{background:rgba(148,163,184,.09)}
.dshsh-kv>k{flex:0 0 104px;color:#8b97a8;font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 值用等宽：路径、pid、版本号这类东西对齐了才好读 */
.dshsh-kv>v{flex:1 1 auto;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  font-size:11px;word-break:break-word;font-variant-numeric:tabular-nums}
.dshsh-kv>v.dim{color:#8b97a8}
.dshsh-kv>v.warn{color:#f87171}
.dshsh-kv>v.ok{color:#4ade80}
.dshsh-kv[data-copy]{cursor:pointer}
.dshsh-kv[data-copy]:hover>v{text-decoration:underline dotted;text-underline-offset:2px}
.dshsh-kv>v>i{font-style:normal;opacity:.55;margin-left:6px;font-size:10px}
.dshsh-badge{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:999px;
  border:1px solid rgba(248,113,113,.45);color:#f87171;font-size:10px;font-family:ui-monospace,Menlo,monospace}
.dshsh-native{font-family:inherit;font-size:11px;color:inherit;background:transparent;border:0;padding:0;cursor:pointer;
  text-decoration:underline dotted;text-underline-offset:2px}
.dshsh-native:hover{color:var(--dsw-alias-label-primary,#e2e8f0)}
.dshsh-err{display:flex;gap:7px;align-items:flex-start;margin:0 10px 8px;padding:6px 8px;border-radius:7px;
  border-left:3px solid #ef4444;background:rgba(239,68,68,.12);color:#fca5a5;font-size:11px;line-height:1.5}
.dshsh-err span:last-child{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dshsh-picker{position:absolute;top:40px;left:34px;z-index:40;width:min(360px,calc(100% - 44px));
  max-height:320px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-primary,#2a2f3a);
  border-radius:10px;background:var(--dsw-alias-bg-primary,#16181d);box-shadow:0 14px 36px rgba(0,0,0,.55)}
.dshsh-row{display:flex;align-items:center;gap:4px;border-radius:7px}
.dshsh-row:hover{background:rgba(148,163,184,.14)}
.dshsh-row.current{background:rgba(59,130,246,.18)}
.dshsh-item{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;padding:6px 4px 6px 8px;
  border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary,#e2e8f0);
  font:inherit;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
  text-align:left;cursor:pointer}
.dshsh-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
.dshsh-meta{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary,#94a3b8);flex:0 0 auto;
  font-variant-numeric:tabular-nums}
.dshsh-row-x{opacity:0;margin-right:3px;width:22px;height:22px;transition:opacity .12s ease}
.dshsh-row:hover .dshsh-row-x{opacity:1}
.dshsh-new{display:flex;align-items:center;gap:7px;width:100%;margin-top:4px;padding:6px 8px;
  border:1px dashed var(--dsw-alias-border-primary,#2a2f3a);border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary,#94a3b8);font:inherit;font-size:12px;cursor:pointer;
  transition:background .12s ease,color .12s ease,border-color .12s ease}
.dshsh-new:hover{background:rgba(148,163,184,.16);color:var(--dsw-alias-label-primary,#e2e8f0);border-color:#3b82f6}
.dshsh-stat-btn{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 7px;border-radius:6px;
  border:1px solid var(--dsw-alias-border-primary,#2a2f3a);background:transparent;
  color:var(--dsw-alias-label-secondary,#94a3b8);font:inherit;font-size:11px;cursor:pointer;
  transition:background .12s ease,color .12s ease,border-color .12s ease}
.dshsh-stat-btn:hover:not(:disabled){background:rgba(148,163,184,.16);color:var(--dsw-alias-label-primary,#e2e8f0)}
.dshsh-stat-btn:disabled{opacity:.35;cursor:not-allowed}
.dshsh-stat-btn.go{border-color:#22c55e;color:#22c55e;background:rgba(34,197,94,.14)}
.dshsh-picker::-webkit-scrollbar,.dshsh-screen::-webkit-scrollbar{width:9px;height:9px}
.dshsh-picker::-webkit-scrollbar-thumb,.dshsh-screen::-webkit-scrollbar-thumb{
  background:rgba(148,163,184,.28);border-radius:9px}
.dshsh-picker::-webkit-scrollbar-thumb:hover,.dshsh-screen::-webkit-scrollbar-thumb:hover{
  background:rgba(148,163,184,.45)}

/* 八向缩放手柄：贴边而略微外扩，鼠标容易抓 */
.dshsh-rs{position:absolute;z-index:20;touch-action:none}
.dshsh-rs-n{top:-3px;left:12px;right:12px;height:7px;cursor:ns-resize}
.dshsh-rs-s{bottom:-3px;left:12px;right:12px;height:7px;cursor:ns-resize}
.dshsh-rs-w{left:-3px;top:12px;bottom:12px;width:7px;cursor:ew-resize}
.dshsh-rs-e{right:-3px;top:12px;bottom:12px;width:7px;cursor:ew-resize}
.dshsh-rs-nw{top:-3px;left:-3px;width:14px;height:14px;cursor:nwse-resize}
.dshsh-rs-ne{top:-3px;right:-3px;width:14px;height:14px;cursor:nesw-resize}
.dshsh-rs-sw{bottom:-3px;left:-3px;width:14px;height:14px;cursor:nesw-resize}
.dshsh-rs-se{bottom:-3px;right:-3px;width:15px;height:15px;cursor:nwse-resize}
/* 右下角画一个小斜线作为「可缩放」的视觉提示 */
.dshsh-rs-se::after{content:'';position:absolute;right:4px;bottom:4px;width:7px;height:7px;
  border-right:2px solid var(--dsw-alias-label-secondary,#64748b);
  border-bottom:2px solid var(--dsw-alias-label-secondary,#64748b);
  border-radius:0 0 2px 0;opacity:.75}

.dshsh-rename{display:flex;align-items:center;gap:5px;flex:1 1 auto;min-width:0;padding:3px 6px}
.dshsh-rename input{flex:1 1 auto;min-width:0;height:24px;padding:0 7px;border-radius:6px;
  border:1px solid #3b82f6;background:rgba(0,0,0,.3);color:var(--dsw-alias-label-primary,#e2e8f0);
  font:inherit;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;outline:none}
`

window.__ModuleLoader__.load({
  id: 'dsh-agent-shell',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    /** 描边式 SVG 图标。用 SVG 而不是 emoji —— emoji 在各平台渲染差异太大。 */
    function Icon(props) {
      const size = props.size !== undefined ? props.size : 15
      const path = ICON_PATHS[props.name] !== undefined ? ICON_PATHS[props.name] : ''
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: props.weight !== undefined ? props.weight : 2,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }, h('path', { d: path }))
    }

    const BASE = '/plugins/shell'
    const POS_KEY = 'dsh-agent-shell:pos'
    const RECT_KEY = 'dsh-agent-shell:rect'
    /** 面板尺寸下限。 */
    const MIN_W = 360
    const MIN_H = 220

    /**
     * 构建标识。每次改客户端就 +1 —— 面板指标行会显示它。
     *
     * 存在的理由：客户端 bundle 的 URL 带 `&rev=<hash>`，只有**重新加载页面**才会取到新版；
     * 没有这个可见标记，根本分不清「修复没生效」和「浏览器跑的还是旧代码」。
     */
    const BUILD = 'c14'
    /**
     * 包版本号，必须与 package.json 的 `version` 完全一致。
     *
     * 这里刻意冗余一次：面板指标行会把版本显示出来，用户报障时不必去翻
     * `node_modules/dsh-agent-shell/package.json` 就能说清跑的是哪一版。
     * 两边一旦漂移，`npm run release:check` 会直接失败，所以不会长期不同步。
     */
    const PKG_VERSION = '0.1.1'
    /** 注入样式表的元素 id（卸载时按它精确移除）。 */
    const CSS_ID = 'dsh-agent-shell-style'

    /** 胶囊尺寸（与样式保持一致，用于定位与夹取）。 */
    const PILL_W = 132
    const PILL_H = 34
    /** 面板尺寸（与样式保持一致）。 */
    const PANEL_W = 760
    const PANEL_H = 460
    /** 距视口边缘的留白。 */
    const MARGIN = 8
    /** 超过这个位移就算拖动而不是点击。 */
    const DRAG_THRESHOLD = 4
    /** 面板一次最多向上取多少行历史（宿主侧上限是 100000）。 */
    const MAX_WINDOW = 5000

    const S = {
      pill: {
        position: 'fixed',
        pointerEvents: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        height: PILL_H + 'px',
        padding: '0 12px',
        borderRadius: '17px',
        border: '1px solid var(--dsw-alias-border-primary, #2a2f3a)',
        background: 'var(--dsw-alias-bg-primary, #16181d)',
        color: 'var(--dsw-alias-label-primary, #e2e8f0)',
        boxShadow: '0 8px 24px rgba(0,0,0,.35)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
        zIndex: 9998,
      },
      panel: {
        position: 'fixed',
        width: PANEL_W + 'px',
        maxWidth: 'calc(100vw - 16px)',
        height: PANEL_H + 'px',
        maxHeight: 'calc(100vh - 16px)',
        pointerEvents: 'auto',
        display: 'flex',
        flexDirection: 'column',
        borderRadius: '12px',
        border: '1px solid var(--dsw-alias-border-primary, #2a2f3a)',
        background: 'var(--dsw-alias-bg-primary, #16181d)',
        boxShadow: '0 16px 48px rgba(0,0,0,.5)',
        overflow: 'hidden',
        zIndex: 9999,
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 10px',
        borderBottom: '1px solid var(--dsw-alias-border-primary, #2a2f3a)',
        fontSize: '12px',
        cursor: 'grab',
        userSelect: 'none',
        touchAction: 'none',
        // 面板 overflow 是 visible（选择器不能被裁掉），所以圆角要自己补
        borderRadius: '11px 11px 0 0',
      },
      btn: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: '26px',
        height: '26px',
        padding: '0 7px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-primary, #2a2f3a)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #e2e8f0)',
        fontSize: '12px',
        cursor: 'pointer',
        lineHeight: 1,
      },
      btnOff: {
        opacity: 0.4,
        cursor: 'not-allowed',
      },
      /** 指标行里的迷你按钮。 */
      miniBtn: {
        display: 'inline-flex',
        alignItems: 'center',
        height: '18px',
        padding: '0 6px',
        borderRadius: '5px',
        border: '1px solid var(--dsw-alias-border-primary, #2a2f3a)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #94a3b8)',
        fontFamily: 'inherit',
        fontSize: '11px',
        lineHeight: 1,
        cursor: 'pointer',
      },
      lockOn: {
        borderColor: '#f59e0b',
        color: '#f59e0b',
      },
      lockOff: {
        borderColor: '#22c55e',
        color: '#22c55e',
      },
      grip: {
        color: 'var(--dsw-alias-label-secondary, #64748b)',
        fontSize: '11px',
        letterSpacing: '-1px',
      },
      name: {
        flex: 1,
        textAlign: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      screen: {
        flex: 1,
        margin: 0,
        padding: '10px 12px',
        overflow: 'auto',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        lineHeight: 1.35,
        whiteSpace: 'pre',
        color: 'var(--dsw-alias-label-primary, #e2e8f0)',
        background: 'rgba(0,0,0,.18)',
        tabSize: 4,
      },
      /** 状态行里的分隔符与数字（数字要 tabular-nums，否则刷新时宽度会抖）。 */
      sep: {
        opacity: 0.35,
      },
      num: {
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      stats: {
        display: 'flex',
        // 方案 B 要求「永远一行」：不换行，靠名字省略号吸收宽度变化
        flexWrap: 'nowrap',
        overflow: 'hidden',
        alignItems: 'center',
        gap: '6px',
        padding: '5px 10px',
        borderTop: '1px solid var(--dsw-alias-border-primary, #2a2f3a)',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, #94a3b8)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      inputRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        borderTop: '1px solid var(--dsw-alias-border-primary, #2a2f3a)',
        borderRadius: '0 0 11px 11px',
      },
      input: {
        flex: 1,
        height: '30px',
        padding: '0 9px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-primary, #2a2f3a)',
        background: 'rgba(0,0,0,.25)',
        color: 'var(--dsw-alias-label-primary, #e2e8f0)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
        outline: 'none',
      },
      inputLocked: {
        opacity: 0.55,
        cursor: 'not-allowed',
      },
    }

    function clamp(value, lo, hi) {
      if (hi < lo) return lo
      return value < lo ? lo : value > hi ? hi : value
    }

    /** 视口尺寸（对非浏览器环境也安全）。 */
    function viewport() {
      const w = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280
      const h = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800
      return { w: w, h: h }
    }

    /** 把胶囊左上角夹进视口。 */
    function clampPoint(x, y) {
      const vp = viewport()
      return {
        x: clamp(Math.round(x), MARGIN, Math.max(MARGIN, vp.w - PILL_W - MARGIN)),
        y: clamp(Math.round(y), MARGIN, Math.max(MARGIN, vp.h - PILL_H - MARGIN)),
      }
    }

    /** 默认位置：右下角。 */
    function defaultPos() {
      const vp = viewport()
      return clampPoint(vp.w - PILL_W - 18, vp.h - PILL_H - 18)
    }

    function loadPos() {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(POS_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (!Number.isFinite(parsed?.x) || !Number.isFinite(parsed?.y)) return null
        return clampPoint(parsed.x, parsed.y)
      } catch {
        return null
      }
    }

    function savePos(pos) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(POS_KEY, JSON.stringify(pos))
      } catch {
        /* 隐私模式等场景下忽略 */
      }
    }

    /** 把面板矩形夹进视口，并保证不小于最小尺寸。 */
    function clampRect(rect) {
      const vp = viewport()
      const w = clamp(rect.w, MIN_W, Math.max(MIN_W, vp.w - MARGIN * 2))
      const h = clamp(rect.h, MIN_H, Math.max(MIN_H, vp.h - MARGIN * 2))
      return {
        w,
        h,
        left: clamp(rect.left, MARGIN, Math.max(MARGIN, vp.w - w - MARGIN)),
        top: clamp(rect.top, MARGIN, Math.max(MARGIN, vp.h - h - MARGIN)),
      }
    }

    /**
     * 按拖动方向计算新矩形。
     *
     * 从西/北侧缩小时，左上角必须跟着挪，且到达最小尺寸后要停止跟随 —— 否则面板会
     * 「一边缩小一边跑」，手感很怪。
     */
    function applyResize(base, dir, dx, dy) {
      let left = base.left
      let top = base.top
      let w = base.w
      let h = base.h
      if (dir.indexOf('e') >= 0) w = base.w + dx
      if (dir.indexOf('s') >= 0) h = base.h + dy
      if (dir.indexOf('w') >= 0) { w = base.w - dx; left = base.left + dx }
      if (dir.indexOf('n') >= 0) { h = base.h - dy; top = base.top + dy }
      if (w < MIN_W) {
        if (dir.indexOf('w') >= 0) left = base.left + base.w - MIN_W
        w = MIN_W
      }
      if (h < MIN_H) {
        if (dir.indexOf('n') >= 0) top = base.top + base.h - MIN_H
        h = MIN_H
      }
      return clampRect({ left, top, w, h })
    }

    function loadRect() {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(RECT_KEY)
        if (raw === null) return null
        const parsed = JSON.parse(raw)
        if (![parsed?.left, parsed?.top, parsed?.w, parsed?.h].every(Number.isFinite)) return null
        return clampRect(parsed)
      } catch {
        return null
      }
    }

    function saveRect(rect) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(RECT_KEY, JSON.stringify(rect))
      } catch {
        /* 忽略 */
      }
    }

    async function api(path, options) {
      const response = await fetch(BASE + path, options)
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = { error: text } }
      return { ok: response.ok, status: response.status, body }
    }

    function ShellPanel() {
      const [expanded, setExpanded] = react.useState(false)
      const [sessions, setSessions] = react.useState([])
      const [server, setServer] = react.useState(null)
      // 用**名字**而不是下标标记当前 shell：改名或增删都会让列表重排，
      // 下标一旦错位，面板就会莫名其妙跳到另一个 shell 上。
      const [selected, setSelected] = react.useState('')
      const [renaming, setRenaming] = react.useState('')
      const [renameDraft, setRenameDraft] = react.useState('')
      const [screen, setScreen] = react.useState('')
      const [meta, setMeta] = react.useState(null)
      const [locked, setLocked] = react.useState(true)
      const [error, setError] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      // 输入框里是否有残留文本（正常情况下它应始终为空；有残留说明自动提交漏了一次）
      const [residual, setResidual] = react.useState(false)
      // shell 选择器（多 shell 时用来直接跳转，而不是一次次点箭头）
      const [pickerOpen, setPickerOpen] = react.useState(false)
      // ⓘ 详情层：与选择器互斥（两个浮层同时开着会叠在一起）
      const [infoOpen, setInfoOpen] = react.useState(false)
      // 「复制全部」的短暂反馈；定时器要清掉，否则收起面板后还会 setState
      const [copied, setCopied] = react.useState(false)
      // 单值复制的行内反馈（"已复制"），与整段复制的按钮反馈分开
      const [copiedValue, setCopiedValue] = react.useState('')
      const copiedTimer = react.useRef(null)
      react.useEffect(() => () => { if (copiedTimer.current !== null) clearTimeout(copiedTimer.current) }, [])
      // 取多少行：面板必须显式要历史，否则宿主只回可见屏（等于窗格高度）
      const [historyWindow, setHistoryWindow] = react.useState(200)
      // 是否贴着底部；用户往上翻时不要把他拽回来
      const [pinned, setPinned] = react.useState(true)
      const [pos, setPos] = react.useState(() => loadPos() ?? defaultPos())
      const [dragging, setDragging] = react.useState(false)

      const panelRef = react.useRef(null)
      const screenRef = react.useRef(null)
      const inputRef = react.useRef(null)
      const dragRef = react.useRef(null)
      const suppressClickRef = react.useRef(false)
      /** 当前那次「读屏幕」的函数；按键后立即调它，不然自己打的字要等最多 0.7s 才显示。 */
      const screenFetchRef = react.useRef(null)
      /** 立即刷新的去抖计时器：连打时合并成最多约 14 次/秒。 */
      const fastRefreshRef = react.useRef(null)
      /**
       * 组字状态（自己维护，不信事件的 `isComposing`）。
       *
       * Chrome 在组字提交时补的 `input` 事件里 `isComposing` 常仍是 true，各浏览器的
       * `input` / `compositionend` 顺序也不一致 —— 只按事件字段判断会漏掉整次提交，
       * 汉字就会滞留在输入框里。详见 {@link decideComposition}。
       */
      const composingRef = react.useRef(false)

      const current = sessions.length === 0
        ? null
        : (sessions.find((s) => s.name === selected) || sessions[0])
      const currentName = current === null ? '' : current.name

      // ── 面板矩形（位置 + 尺寸）：持久化 + 视口变化时夹回 ───────────────────
      //
      // 面板一旦被拖动或缩放，就**完全由 rect 决定**，不再跟着胶囊锚点走；否则你调好的
      // 位置会在下次拖胶囊时被打乱。rect 为 null 时按胶囊锚点推导初始矩形。
      const [rect, setRect] = react.useState(() => loadRect())
      react.useEffect(() => {
        if (rect !== null) saveRect(rect)
      }, [rect])

      const anchorRect = clampRect({
        w: PANEL_W,
        h: PANEL_H,
        left: pos.x + PILL_W - PANEL_W,
        top: pos.y + PILL_H - PANEL_H,
      })
      const panelRect = rect === null ? anchorRect : rect

      react.useEffect(() => { savePos(pos) }, [pos])

      react.useEffect(() => {
        const onResize = () => {
          setPos((prev) => clampPoint(prev.x, prev.y))
          setRect((prev) => (prev === null ? prev : clampRect(prev)))
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      // 卸载时清掉去抖计时器，避免回调打在已卸载的组件上。
      react.useEffect(() => () => {
        if (fastRefreshRef.current !== null) clearTimeout(fastRefreshRef.current)
      }, [])

      // ── 拖动与缩放 ────────────────────────────────────────────────────────
      // 胶囊用「偏移量」跟手：指针始终抓住按下时的那一点。
      const beginPillDrag = (event) => {
        if (event.button !== 0) return
        dragRef.current = {
          mode: 'offset',
          pointerId: event.pointerId,
          offsetX: event.clientX - pos.x,
          offsetY: event.clientY - pos.y,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
        event.preventDefault()
      }

      // 面板标题栏：平移整个面板矩形（首次拖动会把锚点推导值「落实」成显式矩形）。
      const beginPanelDrag = (event) => {
        if (event.button !== 0) return
        if (event.target !== null && typeof event.target.closest === 'function' && event.target.closest('button') !== null) return
        dragRef.current = {
          mode: 'move',
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          base: panelRect,
          moved: false,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
        event.preventDefault()
      }

      /** 八个方向的缩放手柄共用一套拖动逻辑，用方向字符串区分。 */
      const beginResize = (dir) => (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        // 手柄在标题栏之外，但保险起见别让其它拖动接手这次指针
        event.stopPropagation()
        dragRef.current = {
          mode: 'resize',
          dir,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          base: panelRect,
          moved: false,
        }
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* 忽略 */ }
      }

      const moveDrag = (event) => {
        const d = dragRef.current
        if (d === null || d.pointerId !== event.pointerId) return
        if (!d.moved) {
          const distance = Math.abs(event.clientX - d.startX) + Math.abs(event.clientY - d.startY)
          if (distance <= DRAG_THRESHOLD) return
          d.moved = true
          setDragging(true)
        }
        const dx = event.clientX - d.startX
        const dy = event.clientY - d.startY
        if (d.mode === 'offset') {
          setPos(clampPoint(event.clientX - d.offsetX, event.clientY - d.offsetY))
          return
        }
        if (d.mode === 'resize') {
          setRect(applyResize(d.base, d.dir, dx, dy))
          return
        }
        setRect(clampRect({ w: d.base.w, h: d.base.h, left: d.base.left + dx, top: d.base.top + dy }))
      }

      const endDrag = (event) => {
        const d = dragRef.current
        if (d === null || d.pointerId !== event.pointerId) return
        dragRef.current = null
        setDragging(false)
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* 忽略 */ }
        if (d.moved) {
          // 拖动结束后的那次 click 要吞掉，否则会被当成「点击展开」
          suppressClickRef.current = true
          setTimeout(() => { suppressClickRef.current = false }, 0)
        }
      }

      // ── 会话列表：折叠时也轮询，用于胶囊上的数量 ──────────────────────────
      react.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const result = await api('/list')
            if (!alive) return
            if (result.ok) {
              setSessions(result.body.sessions || [])
              setServer(result.body.server || null)
            }
          } catch { /* 宿主暂时不可达 */ }
        }
        tick()
        const id = setInterval(tick, 2500)
        return () => { alive = false; clearInterval(id) }
      }, [])

      // ── 当前屏 + 历史：展开时按较快节奏轮询 ──────────────────────────────
      //
      // 必须显式带上 `lines`：宿主侧的读取在缺省时返回**可见屏**（capture-pane 不带 -S），
      // 那只有窗格高度那么多行。历史一直存在 tmux 里（historyLimit 10 万行），只是没人去取。
      react.useEffect(() => {
        if (!expanded || currentName === '') { setScreen(''); return undefined }
        let alive = true
        const tick = async () => {
          try {
            const result = await api('/screen?name=' + encodeURIComponent(currentName) + '&lines=' + String(historyWindow))
            if (!alive) return
            if (result.ok) {
              setScreen(result.body.screen || '')
              setMeta(result.body.meta || null)
              setError('')
            } else {
              setError(String(result.body.error || 'read failed'))
            }
          } catch (e) {
            if (alive) setError(String(e && e.message ? e.message : e))
          }
        }
        tick()
        screenFetchRef.current = tick
        const id = setInterval(tick, 700)
        return () => {
          alive = false
          screenFetchRef.current = null
          clearInterval(id)
        }
      }, [expanded, currentName, historyWindow])

      // 只在「贴着底部」时自动跟随；用户翻到上面就不打扰他。
      react.useEffect(() => {
        const el = screenRef.current
        if (el === null || !pinned) return
        el.scrollTop = el.scrollHeight
      }, [screen, pinned, historyWindow])

      const onScreenScroll = (event) => {
        const el = event.currentTarget
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
        setPinned(atBottom)
      }

      const switchBy = (delta) => {
        if (sessions.length === 0) return
        const at = sessions.findIndex((s) => s.name === currentName)
        const from = at < 0 ? 0 : at
        const next = sessions[(from + delta + sessions.length) % sessions.length]
        setSelected(next.name)
      }

      // ── 发送：串行化，避免逐键发送与其它请求互相插队 ──────────────────────
      const queueRef = react.useRef(Promise.resolve())
      const enqueue = (task) => {
        const next = queueRef.current.then(task, task)
        queueRef.current = next.then(() => undefined, () => undefined)
        return next
      }

      const sendKeys = async (payload) => {
        if (currentName === '') return
        const result = await api('/keys', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: currentName, ...payload }),
        })
        if (result.body && result.body.refused === true) {
          setError(result.body.message || 'refused')
          return
        }
        if (!result.ok) setError(String((result.body && result.body.error) || 'send failed'))
        else setError('')
      }

      /** 是否在屏幕上有选中文本（决定 Ctrl+C 是复制还是 SIGINT）。 */
      const hasSelection = () => {
        if (typeof window === 'undefined' || typeof window.getSelection !== 'function') return false
        const selection = window.getSelection()
        return selection !== null && String(selection).length > 0
      }

      /** 按键后立刻把屏幕拉一次：否则自己打的字要等轮询（最多 0.7s）才出现。 */
      const scheduleFastRefresh = () => {
        if (fastRefreshRef.current !== null) return
        fastRefreshRef.current = setTimeout(() => {
          fastRefreshRef.current = null
          if (screenFetchRef.current !== null) void screenFetchRef.current()
        }, 70)
      }

      /** 排队发送；发完立刻刷新屏幕（去抖）。 */
      const send = (payload) => {
        void enqueue(async () => {
          await sendKeys(payload)
          scheduleFastRefresh()
        })
      }

      /**
       * 按键处理：**真·终端模型，没有任何本地缓冲**。
       *
       * 分两条路：
       *  * **特殊键**（Tab/↑↓←→/Backspace/Home/End/Ctrl-X/Esc…）在 keydown 里就地翻译成
       *    tmux 键名送走 —— 补全、历史、行内光标、Ctrl-R 全部由 shell 自己的 readline 处理；
       *  * **可打印字符**一律不拦，交给浏览器与输入法，再由 `input` 事件交付（见
       *    {@link onInputChanged}）。这一条是中文/日文输入能用的前提：输入法的组字依赖
       *    浏览器对按键的默认处理，抢掉按键 IME 就起不来。
       *
       * 代价与配套：每次按键是一次 HTTP 往返（队列串行化，顺序不会乱），而屏幕靠轮询
       * 更新，所以每次发送后额外触发一次立即刷新（去抖到约 14 次/秒）。
       */
      /**
       * 兜底：把输入框里任何残留文本立刻送走。
       *
       * 为什么需要：这套模型假设输入框在两次事件之间**始终是空的**（字符一进来就被送走）。
       * 一旦有文本留在这里，说明「提交时刻」没被识别到 —— 而 `compositionend` 正是那个
       * 可能不来的信号（实测遇到过：提交的汉字滞留在输入框，直到敲下一个字符才被一起送走）。
       * 所以把「输入框里有残留」本身当作异常，在每次非组字的 keydown 时清一次。
       *
       * 位置很重要：必须在发送这个键**之前**调用，否则执行顺序会反过来（先回车、后正文）。
       */
      const commitPending = () => {
        const element = inputRef.current
        if (element === null) return
        if (element.value === '') return
        const text = element.value
        element.value = ''
        setResidual(false)
        send({ text })
      }

      /** 轮询输入框是否有残留，用于给「主动推送」按钮加提示状态。 */
      react.useEffect(() => {
        const id = setInterval(() => {
          const element = inputRef.current
          const has = element !== null && element.value.length > 0
          setResidual((prev) => (prev === has ? prev : has))
        }, 400)
        return () => clearInterval(id)
      }, [])

      const onInputKeyDown = (event) => {
        const native = event.nativeEvent !== undefined ? event.nativeEvent : {}
        const eventComposing = native.isComposing === true
        if (!eventComposing) {
          // 非组字的按键说明组字已经结束：清标志 + 把可能滞留的正文送走（顺序：正文先、键后）
          composingRef.current = false
          commitPending()
        }
        if (locked) return
        const decision = decideKey({
          key: event.key,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: eventComposing,
          keyCode: event.keyCode,
          hasSelection: hasSelection(),
        })
        if (decision.action !== 'key') return
        event.preventDefault()
        send({ keys: [decision.key] })
      }

      /**
       * 把输入框里的内容读走送进终端，并清空它。
       *
       * 「谁先读到谁清空、后到者看到空值即返回」是这里的防重发机制：提交时
       * `compositionend` 与 `input` 往往会各来一次，两边共用这个函数即可只发一次。
       */
      const commitInputText = (element) => {
        if (element === null || element === undefined) return
        const next = decideComposition('input', { composing: false, value: element.value })
        if (next.commit === '') return
        element.value = ''
        send({ text: next.commit })
      }

      /**
       * 文本通道：普通按键、输入法提交、粘贴等最终都在这里落进终端。
       *
       * **关键**：这里只信自己维护的组字标志，不看事件的 `isComposing` —— Chrome 在提交
       * 时补的那个 `input` 事件的 `isComposing` 常常仍是 `true`，信它就会漏掉整次提交，
       * 汉字会滞留在输入框里、直到敲下一个字符才被一起送走。
       */
      const onInputChanged = (event) => {
        if (locked) return
        const native = event.nativeEvent !== undefined ? event.nativeEvent : {}
        const next = decideComposition('input', {
          composing: composingRef.current,
          value: typeof event.currentTarget?.value === 'string' ? event.currentTarget.value : '',
          eventIsComposing: native.isComposing === true,
        })
        composingRef.current = next.composing
        if (next.commit === '') return
        event.currentTarget.value = ''
        send({ text: next.commit })
      }
      const onCompositionStart = () => {
        composingRef.current = decideComposition('compositionstart', { composing: composingRef.current }).composing
      }

      /**
       * 输入法提交。
       *
       * 顺序在各浏览器并不一致（有的 `input` 先、有的 `compositionend` 先），而且有的
       * `compositionend` 触发时输入框的值**还没写进来**。所以这里做的只有两件事：清掉组字
       * 标志、把当前已有的内容送走；真正的正文无论哪一次事件先到，都会被
       * 「谁先读到谁清空」的机制恰好送一次。
       */
      const onCompositionEnd = (event) => {
        composingRef.current = decideComposition('compositionend', {
          composing: composingRef.current,
          value: typeof event.currentTarget?.value === 'string' ? event.currentTarget.value : '',
        }).composing
        if (locked) return
        commitInputText(event.currentTarget)
      }

      /**
       * 原生 `compositionend` 兜底。
       *
       * React 的合成 composition 事件在部分浏览器/输入法组合下并不可靠，而漏掉这次提交的
       * 后果很显眼：提交的汉字会滞留在输入框里。这里挂在 **document 的捕获阶段**，比挂在
       * 元素上更能兜住（不受 React 委托机制与元素重挂影响），但必须过滤事件源 —— 页面里
       * 别的输入框（比如聊天输入框）也会组字，不能被我们接管。
       */
      react.useEffect(() => {
        const handler = (event) => {
          const element = inputRef.current
          if (element === null) return
          if (event.target !== element) return
          composingRef.current = false
          if (locked) return
          commitInputText(element)
        }
        document.addEventListener('compositionend', handler, true)
        return () => document.removeEventListener('compositionend', handler, true)
      }, [expanded, currentName, locked])

      /** 粘贴：直接送剪贴板文本，保留换行（多行粘贴＝逐行执行，与真终端一致）。 */
      const onInputPaste = (event) => {
        if (locked) return
        const clipboard = event.clipboardData
        if (clipboard === null || clipboard === undefined) return
        const text = clipboard.getData('text')
        if (text.length === 0) return
        event.preventDefault()
        if (inputRef.current !== null) inputRef.current.value = ''
        send({ text })
      }

      const onPanelBlur = (event) => {
        const next = event.relatedTarget
        if (next !== null && panelRef.current !== null && panelRef.current.contains(next)) return
        setLocked(true)
      }

      const toggleLock = async () => {
        const next = !locked
        setLocked(next)
        if (next) { setError(''); return }
        await Promise.resolve()
        if (inputRef.current !== null) inputRef.current.focus()
      }

      const newShell = async () => {
        setBusy(true)
        try {
          const result = await api('/new', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({}),
          })
          if (!result.ok) setError(String((result.body && result.body.error) || 'failed to open a shell'))
          else setError('')
        } finally {
          setBusy(false)
        }
      }

      const closeShell = async () => {
        if (currentName === '') return
        setBusy(true)
        try {
          await api('/kill', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: currentName }),
          })
        } finally {
          setBusy(false)
        }
      }

      /** 改名：成功后把选中项也跟着换到新名字，否则面板会掉回第一个 shell。 */
      const submitRename = async (from) => {
        const newName = renameDraft.trim()
        setRenaming('')
        if (newName === '' || newName === from) return
        try {
          const result = await api('/rename', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: from, newName }),
          })
          if (!result.ok) {
            // 405/404 说明宿主还是旧代码：/rename 是新加的端点，宿主代码改动必须重启才生效。
            // 把原因直接写清楚，别甩一个裸错误码给用户猜。
            if (result.status === 404 || result.status === 405) {
              setError('改名需要重启 dsh web：/plugins/shell/rename 是新端点，宿主代码改动必须重启才生效')
              return
            }
            setError(String((result.body && result.body.error) || 'rename failed'))
            return
          }
          setError('')
          setSelected(String(result.body.name))
        } catch (e) {
          setError(String(e && e.message ? e.message : e))
        }
      }

      const dragHandlers = {
        onPointerDown: beginPillDrag,
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
      }

      const panelDragHandlers = {
        onPointerDown: beginPanelDrag,
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
      }

      /** 状态点：前台还是 shell 本体＝空闲（绿），否则说明有东西在跑（琥珀）。 */
      /** 复制单个值（点 ⓘ 里任意一行）。复用同一套剪贴板降级逻辑。 */
      const copyOne = (value) => {
        const write = (text) => writeClipboard(text, () => {
          setCopiedValue(String(value))
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => setCopiedValue(''), 1400)
        }, setError)
        write(String(value))
      }

      /**
       * 复制整段诊断信息到剪贴板。
       *
       * 优先用 `navigator.clipboard`（localhost 属于安全上下文，正常可用）；
       * 失败时退回到「临时 textarea + execCommand」—— 某些浏览器/权限设置下前者会被拒。
       * 两条路都失败就把错误显示在面板里，而不是静默什么都不做。
       */
      const copyInfo = () => {
        const header = 'dsh-agent-shell ' + PKG_VERSION + ' · 客户端构建 ' + BUILD + ' · ' + new Date().toLocaleString()
        writeClipboard(infoRowsToText(infoSections, header), () => {
          setCopied(true)
          setError('')
          if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
          copiedTimer.current = setTimeout(() => setCopied(false), 1600)
        }, setError)
      }

      const dotColor = (session) => {
        if (session === null) return '#64748b'
        const foreground = session.foreground !== undefined ? session.foreground : ''
        return foreground === '' || foreground === 'bash' || foreground === '-bash' ? '#22c55e' : '#f59e0b'
      }

      const selectShell = (name) => {
        setSelected(name)
        setPickerOpen(false)
      }

      // ── 折叠态：可拖动的悬浮胶囊 ──────────────────────────────────────────
      if (!expanded) {
        return h('button', {
          key: 'pill',
          type: 'button',
          style: {
            ...S.pill,
            left: pos.x + 'px',
            top: pos.y + 'px',
            cursor: dragging ? 'grabbing' : 'grab',
          },
          title: '拖动可移动；点击展开后台 shell 面板',
          ...dragHandlers,
          onClick: () => {
            if (suppressClickRef.current) return
            setExpanded(true)
          },
        }, [
          h('span', { key: 'grip', className: 'dshsh-grip' }, h(Icon, { name: 'grip', size: 14 })),
          h('span', { key: 'i' }, '>_'),
          h('span', { key: 'n', className: 'dshsh-count' }, String(sessions.length)),
          h('span', {
            key: 'l',
            style: { display: 'inline-flex', color: locked ? '#f59e0b' : '#22c55e' },
          }, h(Icon, { name: locked ? 'lock' : 'unlock', size: 13 })),
        ])
      }

      // ── 展开态：锚定在胶囊位置（夹进视口），标题栏也可拖 ──────────────────
      const position = current === null ? 0 : sessions.findIndex((s) => s.name === currentName) + 1

      const head = h('div', {
        key: 'head',
        style: { ...S.head, cursor: dragging ? 'grabbing' : 'grab' },
        ...panelDragHandlers,
      }, [
        h('span', { key: 'grip', className: 'dshsh-grip' }, h(Icon, { name: 'grip', size: 14 })),
        h('button', {
          key: 'prev',
          type: 'button',
          className: 'dshsh-btn',
          onClick: () => switchBy(-1),
          disabled: sessions.length < 2,
          title: '上一个 shell',
        }, h(Icon, { name: 'prev' })),
        h('button', {
          key: 'name',
          type: 'button',
          className: 'dshsh-name',
          onClick: () => { setPickerOpen((prev) => !prev); setInfoOpen(false) },
          title: sessions.length > 1 ? '点击选择 shell（共 ' + String(sessions.length) + ' 个）' : '新建 shell 后在这里切换',
        }, [
          h('span', { key: 'dot', className: 'dshsh-dot', style: { background: dotColor(current) } }),
          h('span', { key: 't', className: 'dshsh-name-text' }, currentName === '' ? '(无 shell)' : currentName),
          h(Icon, { key: 'c', name: 'down', size: 13 }),
        ]),
        h('button', {
          key: 'next',
          type: 'button',
          className: 'dshsh-btn',
          onClick: () => switchBy(1),
          disabled: sessions.length < 2,
          title: '下一个 shell',
        }, h(Icon, { name: 'next' })),
        h('span', { key: 'count', className: 'dshsh-count' },
          sessions.length === 0 ? '0 / 0' : String(position) + ' / ' + String(sessions.length)),
        h('span', { key: 'sp', className: 'dshsh-spacer' }),
        h('button', {
          key: 'info',
          type: 'button',
          className: 'dshsh-btn' + (infoOpen ? ' on' : ''),
          onClick: () => { setInfoOpen((prev) => !prev); setPickerOpen(false) },
          title: '详情：会话/缓冲/服务端/看门狗/审批/版本/键位表',
        }, h(Icon, { name: 'info', size: 14 })),
        h('button', {
          key: 'lock',
          type: 'button',
          className: 'dshsh-btn ' + (locked ? 'locked' : 'on'),
          onClick: toggleLock,
          title: locked ? '已锁定：输入无效。点击解锁' : '已解锁：每个按键都会直接进终端。点击上锁',
        }, h(Icon, { name: locked ? 'lock' : 'unlock' })),
        h('button', {
          key: 'new',
          type: 'button',
          className: 'dshsh-btn accent',
          onClick: newShell,
          disabled: busy,
          title: '新建 shell',
        }, h(Icon, { name: 'plus' })),
        h('button', {
          key: 'close',
          type: 'button',
          className: 'dshsh-btn danger',
          onClick: closeShell,
          disabled: currentName === '' || busy,
          title: '关闭当前 shell（连同其中运行的进程）',
        }, h(Icon, { name: 'x' })),
        h('button', {
          key: 'hide',
          type: 'button',
          className: 'dshsh-btn',
          onClick: () => { setLocked(true); setPickerOpen(false); setExpanded(false) },
          title: '收起（会自动上锁）',
        }, h(Icon, { name: 'min' })),
      ])

      // ── shell 选择器：多 shell 时直接跳转，而不是一次次点箭头 ─────────────
      const picker = pickerOpen ? h('div', { key: 'picker', className: 'dshsh-picker' }, [
        ...sessions.map((session) => {
          const isCurrent = session.name === currentName
          // 改名中就地把这一行换成输入框：回车确认、Esc 取消、失焦取消
          if (renaming === session.name) {
            return h('div', { key: 'r-' + session.name, className: 'dshsh-row current' }, [
              h('div', { key: 'edit', className: 'dshsh-rename' }, [
                h('span', { key: 'd', className: 'dshsh-dot', style: { background: dotColor(session) } }),
                h('input', {
                  key: 'in',
                  type: 'text',
                  autoFocus: true,
                  value: renameDraft,
                  onChange: (event) => setRenameDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void submitRename(session.name) }
                    if (event.key === 'Escape') { event.preventDefault(); setRenaming('') }
                  },
                  onBlur: () => setRenaming(''),
                  title: '回车确认 · Esc 取消（会自动加上 dsh- 前缀）',
                }),
              ]),
            ])
          }
          return h('div', {
            key: 'r-' + session.name,
            className: 'dshsh-row' + (isCurrent ? ' current' : ''),
          }, [
            h('button', {
              key: 'it',
              type: 'button',
              className: 'dshsh-item',
              onClick: () => selectShell(session.name),
              title: '切到 ' + session.name,
            }, [
              h('span', { key: 'd', className: 'dshsh-dot', style: { background: dotColor(session) } }),
              h('span', { key: 'n' }, session.name),
              h('span', { key: 'm', className: 'dshsh-meta' },
                String(session.cols) + '×' + String(session.rows) + ' · ' + (session.foreground || '?') +
                ' · ' + fmtBytes(session.historyBytes)),
            ]),
            h('button', {
              key: 'rn',
              type: 'button',
              className: 'dshsh-btn dshsh-row-x',
              onClick: () => {
                setRenaming(session.name)
                setRenameDraft(session.name.startsWith('dsh-') ? session.name.slice(4) : session.name)
              },
              title: '重命名 ' + session.name,
            }, h(Icon, { name: 'pencil', size: 13 })),
            h('button', {
              key: 'x',
              type: 'button',
              className: 'dshsh-btn danger dshsh-row-x',
              onClick: () => {
                void api('/kill', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ name: session.name }),
                })
              },
              title: '关闭 ' + session.name,
            }, h(Icon, { name: 'x', size: 13 })),
          ])
        }),
        sessions.length === 0
          ? h('div', { key: 'empty', style: { padding: '10px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #94a3b8)' } }, '还没有 shell')
          : null,
        h('button', {
          key: 'mk',
          type: 'button',
          className: 'dshsh-new',
          onClick: () => { setPickerOpen(false); void newShell() },
          disabled: busy,
        }, [h(Icon, { key: 'p', name: 'plus', size: 13 }), h('span', { key: 't' }, '新建 shell')]),
      ].filter(Boolean)) : null

      const body = h('pre', {
        key: 'screen',
        ref: screenRef,
        className: 'dshsh-screen',
        style: S.screen,
        onScroll: onScreenScroll,
      }, screen === '' ? '(无输出)' : screen)

      // ── ⓘ 详情层：把 README 里那些「说明书级」信息搬到面板内 ──────────────
      const infoSections = buildInfoRows({
          server,
          meta,
          sessions,
          historyWindow,
          maxWindow: MAX_WINDOW,
          pkgVersion: PKG_VERSION,
          build: BUILD,
        locked,
      })
      const info = infoOpen ? h('div', { key: 'info', className: 'dshsh-info' }, [
        // 头部条：一键复制整段诊断信息 —— 报障时不必再逐项口述
        h('div', { key: 'bar', className: 'dshsh-info-bar' }, [
          h('t', { key: 't' }, '详情'),
          h('button', {
            key: 'copy',
            type: 'button',
            className: 'dshsh-stat-btn' + (copied ? ' go' : ''),
            onClick: copyInfo,
            title: '复制上面全部信息（版本/会话/服务端/看门狗/审批/键位）到剪贴板，粘贴给他人即可排查',
          }, copied ? '已复制' : '复制全部'),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dshsh-btn',
            style: { minWidth: '22px', height: '22px' },
            onClick: () => setInfoOpen(false),
            title: '关闭详情',
          }, '✕'),
        ]),
        // 最要紧的一条（没有官方审批）提到最上面，而不是埋在第 5 组里
        h('div', { key: 'alert', className: 'dshsh-info-alert' }, [
          h('span', { key: 'i' }, '⚠'),
          h('span', { key: 't' }, [
            h('b', { key: 'b' }, '没有官方审批：'),
            '模型的命令会直接执行，不会弹「允许 / 拒绝」。护栏只是启发式减速带，不是沙箱。',
          ]),
        ]),
        ...infoSections.flatMap((section) => [
          h('div', { key: 'g-' + section.group, className: 'dshsh-info-group' }, [
            h('span', { key: 'n' }, section.group),
            h('c', { key: 'c' }, String(section.rows.length)),
          ]),
          ...section.rows.map((row) => h('div', {
            key: section.group + '-' + row.k,
            className: 'dshsh-kv',
            // 可复制的行：点一下只复制这个值（路径、pid、版本号最常用）
            'data-copy': row.v === '-' || row.v === '' ? undefined : 'v',
            onClick: row.v === '-' || row.v === '' ? undefined : () => copyOne(row.v),
            title: row.title === undefined || row.title === '' ? '点击复制：' + row.v : row.title,
          }, [
            h('k', { key: 'k' }, row.k),
            h('v', { key: 'v', className: row.tone === undefined ? '' : row.tone }, [
              row.v,
              copiedValue === row.v ? h('i', { key: 'c' }, '已复制') : null,
            ]),
          ])),
        ]),
      ]) : null

      // ── 状态行（方案 B：永远一行）──────────────────────────────────────────
      //
      // 只放「一眼要看」的：状态点、名字、尺寸、前台、缓冲、已用字节、审批徽章，
      // 右侧是操作按钮。其余（接入/取景/cwd/版本/服务端/看门狗/键位表）全部进 ⓘ ——
      // 之前 13 项平级混装会折成 2–3 行，折行位置还随名字长度变化。
      // 忙闲：前台进程不是 shell 自己，就说明有东西在跑。
      // shell 名优先取服务端上报的（旧宿主可能没有这个字段），再退回插件默认的 bash。
      const shellName = server !== null && typeof server.shell === 'string' && server.shell !== '' ? server.shell : 'bash'
      const running = meta !== null && meta.foreground !== '' && meta.foreground !== shellName && meta.foreground !== '-' + shellName
      const stats = h('div', { key: 'stats', style: S.stats }, [
        h('span', { key: 'dot', className: 'dshsh-dot', style: { background: dotColor(current) }, title: running ? '有进程在前台运行' : '停在提示符（空闲）' }),
        h('span', { key: 'n', style: { color: 'var(--dsw-alias-label-primary, #e2e8f0)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
          currentName === '' ? '(无 shell)' : currentName),
        meta === null ? null : h('span', { key: 'sep1', style: S.sep }, '·'),
        meta === null ? null : h('span', { key: 's', style: S.num }, String(meta.cols) + '×' + String(meta.rows)),
        meta === null ? null : h('span', { key: 'sep2', style: S.sep }, '·'),
        meta === null ? null : h('span', { key: 'f', style: { whiteSpace: 'nowrap' } }, meta.foreground === '' ? '空闲' : meta.foreground),
        meta === null ? null : h('span', { key: 'sep3', style: S.sep }, '·'),
        meta === null ? null : h('span', { key: 'b', style: S.num, title: '滚动缓冲：已用 / 上限（行）' },
          String(meta.historySize) + '/' + String(meta.historyLimit)),
        meta === null ? null : h('span', { key: 'sep4', style: S.sep }, '·'),
        meta === null ? null : h('span', { key: 'by', style: S.num }, fmtBytes(meta.historyBytes)),
        server !== null && server.approval !== undefined
          ? h('span', {
            key: 'ap',
            className: 'dshsh-badge',
            style: { marginLeft: '2px' },
            title: '⚠ 本插件未接入官方审批：模型执行的命令不会弹出「允许 / 拒绝」询问。'
              + '审批缝：' + String(server.approval.seam)
              + '；部署默认策略：' + String(server.approval.deploymentPolicy)
              + '（DSH_PERMISSION_MODE=' + String(server.approval.permissionMode) + '，单会话可覆盖）。'
              + ' ' + String(server.approval.warning || ''),
          }, '无审批')
          : null,
        h('span', { key: 'sp', style: { flex: '1 1 auto' } }),
        // 回到最新：只在翻上去之后出现
        pinned ? null : h('button', {
          key: 'latest',
          type: 'button',
          className: 'dshsh-stat-btn go',
          onClick: () => {
            setPinned(true)
            const el = screenRef.current
            if (el !== null) el.scrollTop = el.scrollHeight
          },
          title: '回到最新输出',
        }, '回到最新'),
        h('button', {
          key: 'more',
          type: 'button',
          className: 'dshsh-stat-btn',
          onClick: () => setHistoryWindow((prev) => Math.min(MAX_WINDOW, prev * 2)),
          disabled: historyWindow >= MAX_WINDOW,
          title: '向上多取一倍历史（当前 ' + String(historyWindow) + ' 行，上限 ' + String(MAX_WINDOW) + ' 行）',
        }, '更多历史'),
      ].filter(Boolean))

      const inputRow = h('div', { key: 'input', style: S.inputRow }, [
        h('input', {
          key: 'field',
          ref: inputRef,
          type: 'text',
          // 非受控：这里只是**按键捕获面**，不持有任何文本（真·终端模型）。
          // 你打的字直接进 shell，显示在上方屏幕里。
          defaultValue: '',
          autoComplete: 'off',
          autoCorrect: 'off',
          autoCapitalize: 'off',
          spellCheck: false,
          style: { ...S.input, ...(locked ? S.inputLocked : {}) },
          disabled: locked || currentName === '',
          placeholder: locked
            ? '🔒 已锁定 —— 点右上角锁图标解锁'
            : '输入即进终端 · Tab 补全 · ↑↓ 历史 · Ctrl-R 搜索（完整键位见 ⓘ）',
          onKeyDown: onInputKeyDown,
          onInput: onInputChanged,
          onCompositionStart: onCompositionStart,
          onCompositionEnd: onCompositionEnd,
          onPaste: onInputPaste,
        }),
        h('button', {
          key: 'push',
          type: 'button',
          className: 'dshsh-btn ' + (residual ? 'hot' : 'accent'),
          // 锁定时不放行：这个按钮的作用正是「往终端里送东西」，与锁的语义冲突
          disabled: locked || currentName === '',
          onClick: () => { commitPending(); scheduleFastRefresh() },
          title: residual
            ? '输入框里有残留文本 —— 点击主动推送到终端（正常情况下它应始终为空）'
            : '主动推送输入框里的内容到终端（当前为空，点了也没事）',
        }, h(Icon, { name: 'push', size: 14 })),
      ])

      const children = [picker, info, head, body, stats, inputRow]
      if (error !== '') {
        children.push(h('div', { key: 'err', className: 'dshsh-err', title: error }, [
          h('span', { key: 'i' }, '⚠'),
          h('span', { key: 't' }, error),
        ]))
      }

      const RESIZE_DIRS = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se']
      const resizeHandles = RESIZE_DIRS.map((dir) => h('div', {
        key: 'rs-' + dir,
        className: 'dshsh-rs dshsh-rs-' + dir,
        onPointerDown: beginResize(dir),
        onPointerMove: moveDrag,
        onPointerUp: endDrag,
        onPointerCancel: endDrag,
      }))

      return h('div', {
        key: 'panel',
        ref: panelRef,
        // overflow 必须可见，否则选择器与缩放手柄会被面板裁掉
        style: {
          ...S.panel,
          overflow: 'visible',
          left: panelRect.left + 'px',
          top: panelRect.top + 'px',
          width: panelRect.w + 'px',
          height: panelRect.h + 'px',
        },
        tabIndex: -1,
        onBlur: onPanelBlur,
      }, children.concat(resizeHandles))
    }

    const inject = ['slots']

    function apply(ctx) {
      // 注入面板样式；随插件卸载一并移除
      ctx.effect(() => {
        const existing = document.getElementById(CSS_ID)
        if (existing !== null) existing.remove()
        const style = document.createElement('style')
        style.id = CSS_ID
        style.textContent = PANEL_CSS
        document.head.appendChild(style)
        return () => {
          const mine = document.getElementById(CSS_ID)
          if (mine !== null) mine.remove()
        }
      }, 'dsh-agent-shell: panel stylesheet')

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'agent-shell-panel',
        order: 20,
      }, ShellPanel))
    }

    // `__decideKey` / `__decideComposition` 是**纯函数**，只为离线验证暴露（浏览器不使用）：
    // 输入法的分支没法在无 DOM 的环境里真跑，只能靠对这两个纯函数做断言来覆盖。
    return {
      apply,
      inject,
      name: 'dsh-agent-shell',
      __decideKey: decideKey,
      __decideComposition: decideComposition,
      // ⓘ 详情层的内容组装与文本导出都是纯函数 —— 缺字段的组合可以在测试里穷举
      // 组件本身也暴露出来：测试里用「假 React」把它渲染一遍并调用每个事件处理器，
      // 这是唯一能抓住「某个 helper 忘了定义 / 某处读了 null」这类只在打开面板时才炸的错误的手段。
      __ShellPanel: ShellPanel,
      __infoRows: buildInfoRows,
      __infoText: infoRowsToText,
      __writeClipboard: writeClipboard,
    }
  },
})
