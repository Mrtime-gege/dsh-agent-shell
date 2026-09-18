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

/**
 * 某个会话是否**正在前台跑东西**（前台进程不是 shell 自己）。
 *
 * 抽出来是为了让面板与折叠胶囊用同一套判定 —— 之前胶囊那边把 shell 名写死成 `'bash'`，
 * 配置成 zsh 或登录 shell（`-bash`）时会把空闲误判成忙碌。
 */
/** 判定「贴底」的容差（像素）：轮询与滚动事件之间的小误差不该把跟随状态抖掉。 */
const AT_BOTTOM_PX = 24

/**
 * 屏幕区上下内边距之和（像素）。样式与滚动补偿共用它：
 * 补偿要按「行高 × 位移行数」算，而行高只能由 (scrollHeight - padding) / 行数 得到，
 * 两边分头写死必然会漂。
 */
const SCREEN_PAD_Y = 20

/** 屏幕区左右内边距（单侧）。光标是绝对定位的，偏移量必须把它算进去。 */
const SCREEN_PAD_X = 12

/**
 * 屏幕轮询的三档节奏（毫秒）。
 *
 * 为什么是自适应而不是一个固定值：每次请求在宿主侧都是**一次真实 tmux 调用**（经 DSH 的
 * subprocess 服务起进程实测约 60–70ms，裸调 tmux 只要 4.5ms），所以"调快"是有成本的；
 * 但固定慢档又会让跑命令时的输出滞后到肉眼可见（用户报的"不跟手"）。
 *
 * 于是：屏幕内容一变（或刚发过按键）就切到快档，静满 {@link SCREEN_FAST_WINDOW_MS} 后退回慢档。
 * 快档 200ms 的取值依据是"一次请求 ~80ms（合并 tmux 调用后）+ 一点余量"，不会让请求首尾相接。
 */
const SCREEN_IDLE_MS = 800      // 兜底（宿主设置里可调 panelPollMs；快档自动取它的 1/4）
const SCREEN_FAST_WINDOW_MS = 1500

/** 比较两个行数组的区间是否逐行相同（内部工具）。 */
function linesEqual(a, ai, b, bi, count) {
  if (count <= 0) return false
  for (let i = 0; i < count; i += 1) {
    if (a[ai + i] !== b[bi + i]) return false
  }
  return true
}

/**
 * 旧内容在新文档坐标里**整体位移了几行**（正数=下移，负数=上移）。
 *
 * 为什么需要它：面板显示的是「最后 N 行」的窗口，新输出会把**最上面的行挤掉**，
 * 于是同样的文字在新文档里整体上移了 K 行。scrollTop 不变 ≠ 阅读位置不变。
 *
 * 只处理两种可靠可辨的形态，判不准就返回 0（宁可不补偿，也不要乱跳）：
 *   A. 前面插入了行（例如点了「更多历史」把窗口翻倍）→ 整段旧内容成为新内容的后缀；
 *   B. 顶部被挤掉（窗口向下滑动 K 行）→ 新内容的第一行等于旧内容的第 K 行。
 */
function contentShift(prevLines, nextLines) {
  const m = prevLines.length
  const n = nextLines.length
  if (m === 0 || n === 0) return 0

  // A. 前面插入：旧内容整体落在新内容的末尾
  if (n > m && linesEqual(nextLines, n - m, prevLines, 0, m)) return n - m

  // B. 顶部被挤掉：新内容的首行在旧内容里的位置就是滑动量。
  //    验证时多比几行，避免内容里重复行导致的巧合误判；
  //    单次轮询不可能滑掉几百行，所以扫描范围有上限（也保证 700ms 轮询下开销可忽略）。
  const probe = Math.min(48, m, n)
  const limit = Math.min(m - 1, 600)
  // 重叠不足 3 行就没法把「窗口滑动」和「内容被换掉」区分开（例如整屏都是同一字符的进度条），
  // 此时不补偿更安全。
  const minOverlap = Math.min(3, m, n)
  for (let k = 0; k <= limit; k += 1) {
    if (m - k < minOverlap) break
    if (prevLines[k] !== nextLines[0]) continue
    if (linesEqual(prevLines, k, nextLines, 0, Math.min(probe, m - k, n))) return -k
  }
  return 0
}

/**
 * 新内容到达后该怎么滚 —— **纯函数**，因此「读历史时被顶上去」这类问题可以离线复现。
 *
 * 规则就是用户要的那两条：**贴底则跟随，否则保持阅读位置不动**。
 * 「保持不动」不是什么都不做，而是按 {@link contentShift} 补偿内容位移。
 *
 * @param {string} prevText - 上一次渲染的屏幕文本
 * @param {string} nextText - 本次拿到的屏幕文本
 * @param {{scrollTop: number, scrollHeight: number, clientHeight: number, pinned?: boolean,
 *          padding?: number}} view - `padding` 是屏幕区上下内边距之和（默认 0）
 * @returns {{scrollTop: number, pinned: boolean, shift: number, reason: 'follow'|'anchor'}}
 */
function scrollAnchor(prevText, nextText, view) {
  const prevLines = String(prevText ?? '').split('\n')
  const nextLines = String(nextText ?? '').split('\n')
  const scrollTop = Number.isFinite(view?.scrollTop) ? view.scrollTop : 0
  const scrollHeight = Number.isFinite(view?.scrollHeight) ? view.scrollHeight : 0
  const clientHeight = Number.isFinite(view?.clientHeight) ? view.clientHeight : 0
  const maxScroll = Math.max(0, scrollHeight - clientHeight)

  // 贴底（显式跟随，或数值上已经在底部容差内）→ 跟随到底
  const atBottom = view?.pinned === true || scrollTop >= maxScroll - AT_BOTTOM_PX
  if (atBottom) return { scrollTop: maxScroll, pinned: true, shift: 0, reason: 'follow' }

  // 行高必须扣掉上下内边距：scrollHeight 含 padding，直接除会每行略大一点（几十行一趟下来就偏几像素）
  const padY = Number.isFinite(view?.padding) ? view.padding : 0
  // 首选调用方量出来的行高；没有才退回旧推导（旧推导在"内容比视口矮"时会高估，见 resolveLineHeight）
  const measured = Number.isFinite(view?.lineHeight) && view.lineHeight > 0 ? view.lineHeight : 0
  const lineHeight = measured > 0
    ? measured
    : (nextLines.length > 0 ? Math.max(0, scrollHeight - padY) / nextLines.length : 0)
  const shift = contentShift(prevLines, nextLines)
  const wanted = Math.max(0, Math.min(maxScroll, scrollTop + shift * lineHeight))
  return { scrollTop: wanted, pinned: false, shift, reason: 'anchor' }
}

function sessionBusy(session, shellName) {
  if (session === null || typeof session !== 'object') return false
  const foreground = typeof session.foreground === 'string' ? session.foreground : ''
  if (foreground === '') return false
  const shell = typeof shellName === 'string' && shellName !== '' ? shellName : 'bash'
  return foreground !== shell && foreground !== '-' + shell
}

/**
 * 相对时间（授权目录的「最近使用」提示）：毫秒时间戳 → 「刚刚 / N 分钟前 / N 小时前 / N 天前」。
 * 非有限值返回空串（未知时间就不显示，别写一个吓人的 NaN）。
 */
function timeAgoText(ts) {
  if (!Number.isFinite(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 60 * 1000) return '刚刚'
  if (diff < 3600 * 1000) return Math.floor(diff / 60000) + ' 分钟前'
  if (diff < 86400 * 1000) return Math.floor(diff / 3600000) + ' 小时前'
  return Math.floor(diff / 86400000) + ' 天前'
}

/**
 * 折叠态胶囊的显示模型 —— **纯函数**，因此显示逻辑可以脱离浏览器单测。
 *
 * 原来的胶囊是 `>_ 3 🔒`：那个 3 没说是什么、看不到在跑什么，而且**颜色语义反了** ——
 * 锁定（安全默认）被标成琥珀色警告，解锁（每个按键直接进终端）反而是绿色。
 *
 * 这里定死四件事：
 *   1. 显示**当前 shell 的名字**（去掉统一的 `dsh-` 前缀省宽度，超长截断），而不是一个裸数字；
 *   2. 只有一个 shell 时不显示 `1/1`（没有信息量的角标是噪音）；
 *   3. **锁：锁定时安静（tertiary），解锁时才用注意色**（warn）；
 *   4. 状态点反映「当前 shell 在不在跑」，工具提示里再给出「共几个在跑」。
 *
 * @param {{sessions?: Array, currentName?: string, locked?: boolean, shellName?: string}} input
 */
function pillModel(input) {
  const sessions = Array.isArray(input?.sessions) ? input.sessions.filter((s) => s !== null && typeof s === 'object') : []
  const currentName = String(input?.currentName || '')
  const shellName = typeof input?.shellName === 'string' && input.shellName !== '' ? input.shellName : 'bash'
  const locked = input?.locked === true

  const current = sessions.find((s) => s.name === currentName) ?? null
  const index = current === null ? 0 : sessions.indexOf(current) + 1
  const total = sessions.length
  const busy = sessionBusy(current, shellName)
  const running = sessions.filter((s) => sessionBusy(s, shellName)).length

  const fullName = current === null ? '' : String(current.name)
  // 显示名优先用户起的 label（@dsh-label，可改名）；没起名才回退稳定 id（去掉 dsh- 前缀）
  const labelName = current !== null && typeof current.label === 'string' && current.label.trim() !== ''
    ? current.label.trim()
    : fullName
  const withoutPrefix = labelName.startsWith('dsh-') ? labelName.slice(4) : labelName
  const label = current === null ? '无 shell' : (withoutPrefix.length > 16 ? withoutPrefix.slice(0, 15) + '…' : withoutPrefix)
  const counter = total > 1 && current !== null ? index + '/' + total : ''

  const lines = []
  if (current === null) {
    lines.push('还没有 shell —— 点击展开面板，用 ＋ 新建一个')
  } else {
    lines.push(fullName + (counter === '' ? '' : '（' + counter + '）'))
    lines.push(busy ? '有命令在前台运行：' + String(current.foreground) : '停在提示符（空闲）')
    if (running > 1) lines.push('全部 ' + String(total) + ' 个 shell 里有 ' + String(running) + ' 个在运行')
  }
  lines.push(locked ? '输入已锁定（点锁图标解锁；解锁后每个按键都会直接进终端）' : '⚠ 输入已解锁：每个按键都会直接进终端')
  lines.push('本插件未接入官方审批：模型的命令不会弹任何询问')
  lines.push('点击展开面板 · 按住拖动可移动')

  return {
    empty: current === null,
    label,
    fullName,
    counter,
    busy,
    running,
    total,
    /** 锁的颜色语义：锁定=安静，解锁=注意。 */
    lockTone: locked ? 'dim' : 'warn',
    dotTone: current === null ? 'none' : (busy ? 'busy' : 'idle'),
    title: lines.join('\n'),
  }
}

/**
 * 设置页在详情层里的显示值。
 *
 * 三种状态必须分开：**注册成功**才叫「已接入」；服务挂了但注册被拒是「未注册」并带上原因；
 * 老宿主（0.1.2 之前）压根不上报 `settings` —— 那就写「未知」，不能猜成「已接入」。
 */
function settingsRowValue(server) {
  const s = server?.settings
  if (s === undefined || s === null) return '未知（宿主未上报，需重启 dsh web）'
  if (s.registered === true || (s.registered === undefined && s.live === true)) return '已接入（DSH 设置 → 插件里改）'
  return '未注册：' + String(s.note ?? '原因未上报')
}

/** 设置页那一行鼠标悬停的说明；没有额外信息时返回空串（不编造）。 */
function settingsRowTitle(server) {
  const s = server?.settings
  if (s === undefined || s === null || s.registered === true) return ''
  return String(s.note ?? '')
}

/**
 * 闸门那一行的显示值。
 *
 * 闸门是这组 HTTP 路由的唯一防线（它们没有鉴权），所以状态必须**如实**展示：
 * 谁在把关、被拒过几次、有没有降级成「Host 无法判定」。老宿主不上报就写「未知」。
 */
function fenceRowValue(server) {
  const fence = server?.fence
  if (fence === null || fence === undefined) return '未知（宿主未上报，需重启 dsh web）'
  const authority = fence.authority === 'dsh-connection' ? 'DSH connection 服务' : '本地围栏'
  const blocked = Array.isArray(server.fenceBlocked) ? server.fenceBlocked.length : 0
  const base = authority + ' · ' + String(fence.boundHost ?? '?') + (fence.port === null || fence.port === undefined ? '' : ':' + String(fence.port))
  if (String(fence.note ?? '').startsWith('⚠')) return '⚠ ' + base + '（Host 围栏不可用）'
  return base + (blocked > 0 ? ' · 已拒 ' + String(blocked) + ' 次' : '')
}

/** 闸门行的悬停说明：降级原因或被拒记录，没有就返回空串（不编造）。 */
function fenceRowTitle(server) {
  const fence = server?.fence
  if (fence === null || fence === undefined) return ''
  const blocked = Array.isArray(server.fenceBlocked) ? server.fenceBlocked : []
  const parts = [String(fence.note ?? '')]
  if (blocked.length > 0) {
    const last = blocked[blocked.length - 1]
    parts.push('最近一次拒绝：' + String(last?.path ?? '?') + ' —— ' + String(last?.why ?? '?'))
  }
  return parts.filter((p) => p !== '').join('\n')
}

/** 审计那一行：开/关、保留多少天、目录在哪、链完整性、加锁状态、有没有写失败。 */
function auditRowValue(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined) return '未知（宿主未上报，需重启 dsh web）'
  if (audit.enabled !== true) return '已关闭（config.audit=false）'
  const note = String(audit.note ?? '')
  const base = `开 · 保留 ${String(audit.retentionDays ?? '?')} 天 · ${String(audit.dir ?? '?')}`
  // 链完整性：必须展示（校验结论不展示 = 没做）。null = 还没校验（启动未完成）。
  const chain = audit.chain ?? null
  const chainTag = chain === null ? '链未校验'
    : chain.ok ? `链✓(${String(chain.sealed)}条)`
      : '链⚠断(' + String(chain.brokenAt === null ? '?' : chain.brokenAt.index + 1) + '条)'
  const lockTag = audit.locked === 'append-only' ? '🔒已加锁'
    : audit.locked === 'writable' ? '未加锁' : '锁未知'
  let value = base + ' · ' + chainTag + ' · ' + lockTag
  if (note !== '') value = '⚠ ' + value + ' · ' + note
  return value
}

function auditRowTitle(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined || audit.enabled !== true) return ''
  const lines = []
  lines.push('所有进入终端的输入都会记在这里（模型发起的 shell_send 与面板里人敲的键），含来源、发起会话与护栏决策。')
  const chain = audit?.chain ?? null
  if (chain !== null) {
    if (chain.ok) {
      lines.push(`哈希链校验通过：${String(chain.sealed)} 条封链${chain.startUnknown ? '（起点未知：更早的文件没读到）' : ''}；头 ${String(chain.head ?? '')}`)
    } else {
      lines.push('⚠ 哈希链断链于第 ' + String(chain.brokenAt === null ? '?' : chain.brokenAt.index + 1) + ' 条（' + String(chain.brokenAt?.reason ?? '?') + '）—— 审计可能被篡改或写坏。')
    }
  }
  const lock = audit?.locked ?? 'unknown'
  if (lock === 'append-only') lines.push('📦 目录已加锁（chattr +a）：内核级只追加，任何人都不能删/改 —— 过期日志需人工 sudo 归档。')
  else if (lock === 'writable') lines.push('📦 目录未加锁：篡改可检测（哈希链），但物理上可改。要不可篡改，跑 install-deps.sh --audit-lock 加锁。')
  else lines.push('📦 目录锁定状态未知（lsattr 不可用）。')
  return lines.join('\n')
}

/** 审计链校验那一行：通过/断链/未校验 —— 篡改可见的结论必须展示。 */
function chainRowValue(server) {
  const chain = server?.audit?.chain ?? null
  if (chain === null) return chainUnknownText(server)
  if (chain.ok === true) {
    const extra = []

    if (chain.startUnknown === true) extra.push('起点未知')
    return '✓ 通过 · ' + String(chain.sealed) + ' 条封链' + (extra.length > 0 ? '（' + extra.join('，') + '）' : '')
  }
  const at = chain.brokenAt === null || chain.brokenAt === undefined ? '?' : String(chain.brokenAt.index + 1)
  return '⚠ 断链 · 第 ' + at + ' 条（' + String(chain.brokenAt?.reason ?? '?') + '）'
}

function chainUnknownText(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined) return '未知（宿主未上报，需重启 dsh web）'
  if (audit.enabled !== true) return '未启用（config.audit=false）'
  return '未校验（宿主尚未完成校验）；链完整性由每条记录的 prevHash/hash 保证'
}

function chainRowTitle(server) {
  const chain = server?.audit?.chain ?? null
  if (chain !== null && chain.ok === false) {
    return '审计哈希链出现断点：第 ' + String((chain.brokenAt?.index ?? 0) + 1) + ' 条记录与前一条对不上 —— '
      + '可能被人改过、删过或写坏了。请核对 shell_audit 与审计目录。'
  }
  return '每条审计记录都携带前一条的摘要（SHA-256 哈希链）：删一条、改一个字节、调换顺序都会断链。'
    + '这里显示的就是最近一次整链校验的结论' + (chain !== null && chain.checkedAt ? '（检查于 ' + new Date(chain.checkedAt).toLocaleString() + '）' : '') + '。'
}

/** 审计目录锁定那一行：内核级只追加（chattr +a）还是仅可检测。 */
function lockRowValue(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined) return '未知（宿主未上报，需重启 dsh web）'
  if (audit.enabled !== true) return '未启用（config.audit=false）'
  const locked = audit.locked
  if (locked === 'append-only') return '🔒 已加锁（chattr +a）· 不可删/改，只能追加'
  if (locked === 'writable') return '未加锁 · 篡改可检测但物理可改'
  return '未知（lsattr 不可用）；加锁方法见 install-deps.sh --audit-lock'
}

function lockRowTitle(server) {
  const locked = server?.audit?.locked
  if (locked === 'append-only') {
    return '审计目录是内核级 append-only（chattr +a）：任何人都不能在其中删除/改名文件，只能追加。'
      + '代价：插件无法自动清理过期日志，需要人工用 sudo 归档。解除：sudo chattr -a <审计目录>。'
  }
  if (locked === 'writable') {
    return '审计目录是普通目录：篡改会被哈希链发现（可检测），但物理上仍可改。'
      + '要升级为「不可篡改」，跑 ./install-deps.sh --audit-lock（需要一次 sudo）。'
  }
  return '无法判断目录锁定状态（lsattr 不可用）。加锁是可选项，见 install-deps.sh --audit-lock。'
}

/** 输出留痕那一行：开关、上限、以及触顶被停掉的会话（停掉这件事本身也是信息）。 */
function captureRowValue(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined) return '未知（宿主未上报，需重启 dsh web）'
  if (audit.capture !== true) return '已关闭（config.captureOutput=false）'
  const mb = Number.isFinite(audit.captureMaxBytes) ? Math.round(audit.captureMaxBytes / (1024 * 1024)) + ' MiB' : '?'
  const stopped = Array.isArray(audit.captureStopped) ? audit.captureStopped : []
  const base = `开 · 单会话上限 ${mb} · output/`
  return stopped.length === 0 ? base : `⚠ ${base} · 已停 ${stopped.length} 个会话（触顶）`
}

function captureRowTitle(server) {
  const audit = server?.audit
  if (audit === null || audit === undefined || audit.capture !== true) return ''
  return '终端输出（含回显的命令与程序输出）原样写到 audit 目录的 output/ 下，会话关掉后文件仍在。注意：终端里出现过的敏感内容也会被一起记下来。'
}

/** tmux 那一行：版本，或者「缺什么、怎么装」。 */
function tmuxRowValue(server) {
  const tmux = server?.tmux
  if (tmux === null || tmux === undefined) return '未知（宿主未上报或体检未完成）'
  if (tmux.ok === true) return String(tmux.version ?? 'available')
  return '⚠ 不可用：' + String(tmux.error ?? '未知原因') + '（需安装 tmux；Windows 请在 WSL 里运行）'
}

/**
 * 「关闭 shell」为什么要两步。
 *
 * 它紧挨着「收起」按钮，而两者后果完全不同：收起只是把面板变回胶囊，关闭会**连同里面
 * 正在跑的进程一起结束**（不可撤销）。相邻 + 一步执行 = 误触就丢工作。所以：第一次点
 * 只是**进入待确认**（按钮变红并提示"再点一次"），第二次才真的关；3 秒内没有第二次就自动复位。
 */
/**
 * 头部要不要进入紧凑模式。
 *
 * 起因是一个真实的 UI bug：面板最小宽度（MIN_W=360）小于头部固定内容之和，横向缩到最小时
 * 关闭/收起按钮会被挤到浮窗外面。宁可先隐藏次要信息（计数、标题文字、抓手、分隔线），
 * 也不能让按钮跑出面板。阈值是实测估的：9 个按钮 ×26px + 名称 + 间隔 + 内边距。
 */
const HEAD_FULL_W = 470
function headCompact(width) {
  return !(typeof width === 'number' && Number.isFinite(width) && width >= HEAD_FULL_W)
}

/**
 * 授权按钮的状态模型（纯函数，便于离线测）。
 *
 * 语义：面板是在浏览器侧跑的，它不知道「当前是哪个对话」，所以面板能表达的主动授权就是
 * 「所有对话都放行」；撤销则同时清掉通配与逐对话授权（面板是唯一能表达这个意图的地方）。
 */
function consentButtonModel(consent) {
  const known = consent !== null && typeof consent === 'object' ? consent : {}
  const enabled = known.enabled !== false
  const allowAll = known.allowAll === true
  const count = Array.isArray(known.granted) ? known.granted.length : 0
  return {
    enabled,
    allowAll,
    count,
    icon: 'shield',
    className: 'dshsh-btn' + (allowAll ? ' on' : ''),
    label: allowAll ? '已授权' : '未授权',
    title: !enabled
      ? '首次使用确认门已被配置关闭（requireConsent: false），这个按钮不影响它'
      : allowAll
        ? '已授权：所有对话都能直接使用（另有 ' + String(count) + ' 个对话单独授权过）。点击可立即撤销'
        : '未授权：新对话第一次使用时会问你一次。点击可主动授权给所有对话（再点一次确认）',
  }
}

/** 档位的中文名（宿主也会给目录，这里只是渲染与测试用的兜底）。 */
const CONSENT_SCOPE_LABELS = { full: '完全控制', read: '只读', deny: '完全禁止' }

/**
 * 每个档位的**后果**一句话（成熟授权界面的共同点：不只给名字，还讲清"同意之后会发生什么"）。
 * 这三句与宿主侧 SECURITY 口径一致，改文案时两边一起改。
 */
const CONSENT_SCOPE_HINTS = {
  full: 'AI 以你的用户权限执行任意命令：读写文件、装软件、发网络请求，包括删除',
  read: '只能看：列会话、读屏、查审计。不能发送输入、不能开关或改会话',
  deny: '拒绝这个对话使用本插件；之后不再询问（撤销可恢复）',
}

/** 授权复核句：把"给谁 · 什么档位 · 多久"合成一句，点按钮前一眼看清。 */
function consentReviewText (who, scope, ttlLabel) {
  const name = String(who ?? '').trim() || '(未选择)'
  const s = CONSENT_SCOPE_LABELS[scope] ?? String(scope ?? '?')
  return `将授权「${name}」· ${s} · ${String(ttlLabel ?? '')}`
}

/** 授权浮层顶部的状态徽标（当前全局档位）。tone: 'on' | 'off' | 'warn'。 */
function consentStatusChip (wildcard) {
  if (wildcard === null || wildcard === undefined) return { label: '当前：未设置全局授权', tone: 'off' }
  const scope = CONSENT_SCOPE_LABELS[wildcard.scope] ?? String(wildcard.scope ?? '?')
  const ttl = typeof wildcard.expiresAt === 'number' && wildcard.expiresAt > 0
    ? '限期' : '永久'
  return { label: `当前：所有对话 · ${scope} · ${ttl}`, tone: wildcard.scope === 'deny' ? 'warn' : 'on' }
}

/**
 * 详情页的卡片归属（方案 A）：把 buildInfoRows 的**逻辑分组**映射到 4 张**可折叠卡片**。
 *
 * 为什么在渲染层映射而不是改 buildInfoRows：分组是数据语义（测试也按它断言），
 * 卡片是展示结构 —— 两者分开后，改动展示不必动数据、也不会破坏既有断言。
 *   · 会话 —— 当前会话 + 缓冲（最常看的）
 *   · 安全 —— 审计链/加锁/留痕/护栏 + 审批（"可信"相关的都在这）
 *   · 系统 —— 服务端 + 孤儿看门狗
 *   · 关于 —— 版本 + 键位表
 */
const INFO_CARD_OF = {
  当前会话: '会话', 缓冲与取景: '会话',
  审批与安全: '安全',
  服务端: '系统', 孤儿看门狗: '系统',
  版本: '关于', 键位表: '关于',
}
const INFO_CARD_ORDER = ['会话', '安全', '系统', '关于']
/** 默认展开的卡片：高频两张；缺省折叠的卡片点标题展开。 */
const INFO_CARD_DEFAULT_OPEN = { 会话: true, 安全: true, 系统: false, 关于: false }
/** 时间档的兜底目录（宿主 GET /consent 会带 catalogs，优先用它，避免两边不一致）。 */
const CONSENT_TTL_FALLBACK = [
  { key: '10m', seconds: 600, label: '10 分钟' },
  { key: '30m', seconds: 1800, label: '30 分钟' },
  { key: '2h', seconds: 7200, label: '2 小时' },
  { key: 'forever', seconds: null, label: '永久' },
  { key: 'custom', seconds: null, label: '自定义' },
]

/** 到期时间的可读描述。永久 = null。 */
function consentRemainingLabel (expiresAt, now) {
  if (expiresAt === null || expiresAt === undefined) return '永久'
  const left = expiresAt - now
  if (left <= 0) return '已过期'
  const minutes = Math.ceil(left / 60000)
  if (minutes < 60) return '剩 ' + String(minutes) + ' 分'
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return '剩 ' + String(hours) + ' 小时'
  return '剩 ' + String(Math.round(hours / 24)) + ' 天'
}

/**
 * 已授权会话列表的行模型（纯函数）。
 *
 * 两个刻意的显示决定：
 *   * 按**最近使用**倒序 —— 用户最常见的困惑是"会话多了找不到当前那个"，
 *     而当前对话几乎总是最近用过的那个，排第一最好找；
 *   * 没有任何条目时给一句明确的空状态，而不是渲染一片空白。
 */
function consentEntryRows (entries, now) {
  const list = Array.isArray(entries) ? entries : []
  return list.map((entry, index) => {
    const title = typeof entry.title === 'string' && entry.title !== '' ? entry.title : ''
    const shortId = String(entry.actor ?? '').slice(0, 8)
    return {
      actor: String(entry.actor ?? ''),
      // 没标题就退化成短 id：不编造名字，但也不能显示空白
      label: title !== '' ? title : '会话 ' + shortId,
      hasTitle: title !== '',
      shortId,
      scope: entry.scope,
      scopeLabel: CONSENT_SCOPE_LABELS[entry.scope] ?? String(entry.scope ?? '?'),
      remaining: consentRemainingLabel(entry.expiresAt, now),
      uses: Number.isFinite(entry.uses) ? entry.uses : 0,
      lastUsedAt: entry.lastUsedAt ?? null,
      // 第一行（最近使用）标注出来：那就是用户最可能想操作的那个
      isRecent: index === 0,
    }
  })
}

/** 授权按钮的悬浮提示：一句话说清当前档位与全局默认。 */
function consentSummaryText (wildcard) {
  if (wildcard === null || wildcard === undefined) return '当前没有全局授权：每个对话各自确认'
  const scope = CONSENT_SCOPE_LABELS[wildcard.scope] ?? String(wildcard.scope)
  return '全局默认：' + scope + ' · ' + consentRemainingLabel(wildcard.expiresAt, Date.now())
}

/** 时间档 → 秒数。自定义档用输入框的分钟数（越界交给宿主拒绝并回报，不在这里偷偷夹取）。 */
function consentTtlSeconds (key, customMinutes) {
  if (key === 'forever') return null
  if (key === 'custom') {
    const minutes = Number(customMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) return null
    return Math.floor(minutes * 60)
  }
  const hit = CONSENT_TTL_FALLBACK.find((level) => level.key === key)
  return hit === undefined ? null : hit.seconds
}

function closeActionFor(armed) {
  return armed === true ? 'close' : 'arm'
}

/** 关闭按钮在两种状态下的外观（纯函数，便于离线断言文案与配色令牌）。 */
function closeButtonModel(armed) {
  return armed === true
    ? { className: 'dshsh-btn danger armed', icon: 'x', size: 15, label: '确认关闭',
        title: '再点一次即关闭（会连同其中运行的进程一起结束）' }
    : { className: 'dshsh-btn danger', icon: 'x', size: 14, label: '关闭',
        title: '关闭当前 shell（需再点一次确认；会连同其中运行的进程一起结束）' }
}

/**
 * 画「真实光标」前必须解决的一件事：tmux 给的是**单元格列**，不是字符下标。
 *
 * 中文/日文/emoji 占 2 格、组合符占 0 格 —— 直接拿 `cursor_x` 当字符下标去切字符串，
 * 中文行里光标必然偏。所以这里先把单元格坐标映射成字符下标（纯函数、可离线断言）。
 */

/**
 * 行高必须**量**出来，不能从 `scrollHeight` 推。
 *
 * 踩过的坑：`scrollHeight` 取的是「内容高度」与「可视高度」中的**较大者** —— 文本少时
 * （内容比视口矮）它等于视口高度，拿它除行数会得到一个大得离谱的"行高"，光标就被画到下面去了；
 * 文本多时内容高于视口才是真值，所以"文本多了反而正常"。行高只能来自计算样式。
 *
 * @param {{lineHeight?: string, fontSize?: string}} computed - `getComputedStyle(el)` 的取值
 * @returns {number} 像素行高；解析不出来返回 0（调用方据此**不画**）
 */
function resolveLineHeight(computed) {
  const raw = computed === null || computed === undefined ? undefined : computed.lineHeight
  const parsed = Number.parseFloat(String(raw ?? ''))
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  // `line-height: normal` 时浏览器不给数值：按字号的常规比例（1.2）估一个
  const fontSize = Number.parseFloat(String(computed?.fontSize ?? ''))
  if (Number.isFinite(fontSize) && fontSize > 0) return fontSize * 1.2
  return 0
}

/** 一个字符占几个终端单元格。 */
function charCellWidth(ch) {
  const code = ch.codePointAt(0)
  if (code === undefined) return 0
  // 组合符（含变体选择符、零宽连接符）不占格
  if ((code >= 0x0300 && code <= 0x036f) || (code >= 0xfe00 && code <= 0xfe0f) ||
      (code >= 0x1ab0 && code <= 0x1aff) || code === 0x200d || code === 0x200b) return 0
  // 东亚宽/全角、假名、谚文、CJK 符号与汉字、常见 emoji 区间
  if ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) || (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x1f900 && code <= 0x1f9ff) ||
      (code >= 0x20000 && code <= 0x3fffd)) return 2
  return 1
}

/** 含 `cell` 这一格的那个字符的下标；超出整行宽度则返回行尾（光标停在行尾空白处的情形）。 */
function cellsToCharIndex(line, cell) {
  const text = String(line ?? '')
  if (cell <= 0) return 0
  let cells = 0
  let index = 0
  for (const ch of text) {
    const width = charCellWidth(ch)
    if (cell < cells + width) return index
    cells += width
    index += ch.length   // 代理对占两个 code unit
  }
  return text.length
}

/**
 * 把 tmux 的光标坐标换算成「在我们渲染的这份文本里」的位置。
 *
 * 关键点：`cursor_y` 是相对**可见窗格**的，而我们的文本是「历史 + 可见窗格」，且可见窗格
 * 永远贴底 —— 所以行下标 = 总行数 − paneHeight + cursor_y。算不出来就返回 null（**不画**），
 * 宁可没有光标，也不要画在错误的位置。
 */
function caretPlacement(input) {
  const screen = typeof input?.screen === 'string' ? input.screen : ''
  const meta = input?.meta ?? null
  if (screen === '' || meta === null) return null
  const paneHeight = Number.isFinite(meta.paneHeight) ? meta.paneHeight : 0
  const cursorY = Number.isFinite(meta.cursorY) ? meta.cursorY : 0
  const cursorX = Number.isFinite(meta.cursorX) ? meta.cursorX : 0
  if (paneHeight <= 0) return null
  const lines = screen.split('\n')
  const lineIndex = lines.length - paneHeight + cursorY
  if (lineIndex < 0 || lineIndex >= lines.length) return null
  const line = lines[lineIndex]
  if (line === undefined) return null
  const charIndex = cellsToCharIndex(line, cursorX)
  // 绝对下标：插入点要直接**切在文本里**（见 caretSplit），所以要的是整段文本里的位置，
  // 不只是行内位置。行长度用行自身算，换行符各占 1。
  let offset = 0
  for (let i = 0; i < lineIndex; i += 1) offset += lines[i].length + 1
  offset += charIndex
  return { lineIndex, cell: cursorX, charIndex, offset }
}

/**
 * 实测前缀宽度时，Range 应该覆盖哪一段。**纯函数**（便于离线断言）。
 *
 * 关键：只覆盖**光标所在的那一行**（行首 → 光标），而不是"屏幕开头 → 光标"。
 *
 * 踩过的坑（用户报的"光标被渲染到了本行的最后"就是这个）：多行区间的
 * `getBoundingClientRect()` 返回的是**并集包围盒** —— 从屏幕第一行一直拉到光标处时，
 * 那个 `width` 约等于最宽的一行（通常就是整屏宽），于是插入点被推到行尾。
 * 单行区间的包围盒才等于该行前缀的真实宽度；光标在行首时区间折叠、宽度天然是 0，
 * 也没有 `getClientRects()` 在行首处"最后一片其实属于上一行"的歧义。
 *
 * @param {{offset?: number, charIndex?: number}|null} placement - {@link caretPlacement} 的结果
 * @returns {{from: number, to: number}|null} 数据不自洽时返回 null（调用方退回估算或不画）
 */
function prefixRangeOffsets(placement) {
  if (placement === null || placement === undefined) return null
  const to = Number(placement.offset)
  const charIndex = Number(placement.charIndex)
  if (!Number.isFinite(to) || !Number.isFinite(charIndex)) return null
  // offset 是"整段文本里的绝对下标"，charIndex 是"行内下标"，两者相减就是本行行首
  const from = to - charIndex
  if (from < 0 || from > to) return null
  return { from, to }
}

/**
 * 实测「某一行上、光标前那段文本」的渲染宽度。
 *
 * 这是横向定位的正解：用 `Range` 量真实排版结果 —— 中文由回退字体渲染时 advance 与
 * 等宽 ASCII 不同，任何"单元格 × 字符宽度"的算法都会偏；而 `Range` 直接给出浏览器的答案。
 *
 * 关键：**不改动 DOM 结构**（早先用"把插入点插进文本流"的办法，空白字符处会出问题）——
 * 这里只是在**已有文本节点**上取一个区间，量完即弃。区间由 {@link prefixRangeOffsets} 给出，
 * 必须限定在光标所在的那一行（原因见那里）。
 *
 * @param {*} scope - 含 `.dshsh-screen-text` 的容器元素
 * @param {number} from - 行首在整段文本里的下标
 * @param {number} to - 光标在整段文本里的下标
 * @returns {number} 像素宽度；量不出来返回 NaN（调用方退回单元格估算，再不行就不画）
 */
function measurePrefixWidth(scope, from, to) {
  try {
    if (scope === null || scope === undefined || typeof scope.querySelector !== 'function') return Number.NaN
    const node = scope.querySelector('.dshsh-screen-text')
    const textNode = node === null || node === undefined ? null : node.firstChild
    if (textNode === null || textNode === undefined || typeof textNode.textContent !== 'string') return Number.NaN
    if (typeof window === 'undefined' || typeof window.document === 'undefined' ||
        typeof window.document.createRange !== 'function') return Number.NaN
    const range = window.document.createRange()
    const length = textNode.textContent.length
    const start = Math.max(0, Math.min(length, Number(from)))
    const end = Math.max(start, Math.min(length, Number(to)))
    range.setStart(textNode, start)
    range.setEnd(textNode, end)
    const rect = range.getBoundingClientRect()
    return Number.isFinite(rect?.width) ? rect.width : Number.NaN
  } catch {
    return Number.NaN
  }
}

/**
 * 光标在内容坐标里的位置。
 *
 * 横向优先用**实测**的前缀宽度（`measuredLeft`，见 measurePrefixWidth），量不到才退回
 * 「单元格列 × 实测 ASCII 字符宽」的估算；两者都没有就返回 null（**不画**，不画偏的）。
 * 纵向用实测行高 —— 它绝不能从 `scrollHeight` 推（内容比视口矮时那个值是视口高度）。
 */
function caretStyle(placement, lineHeight, cellWidth, padX, padY, measuredLeft) {
  if (placement === null || !Number.isFinite(lineHeight) || lineHeight <= 0) return null
  let left = Number.NaN
  if (Number.isFinite(measuredLeft)) left = padX + measuredLeft
  else if (Number.isFinite(cellWidth) && cellWidth > 0) left = padX + placement.cell * cellWidth
  if (!Number.isFinite(left)) return null
  return {
    position: 'absolute',
    top: padY + placement.lineIndex * lineHeight,
    left,
    width: 2,
    height: lineHeight,
    background: 'currentColor',
    opacity: .8,
    pointerEvents: 'none',
    borderRadius: 1,
  }
}

/**
 * 该不该画光标。
 *
 * 只在**用户手动输入**（解锁）时画：锁定状态代表按键不会进终端，屏幕上那个位置并不代表
 * "下一个字符会出现在这"；AI 通过工具发输入时同理不该画。程序自己隐藏了光标（TUI）也不画。
 */
function shouldShowCaret(input) {
  if (input?.locked === true) return false
  if (input?.meta === null || input?.meta === undefined) return false
  if (input.meta.cursorVisible !== true) return false
  return input?.placement !== null && input?.placement !== undefined
}

function buildInfoRows(input) {
  const server = input.server !== null && typeof input.server === 'object' ? input.server : {};
  const meta = input.meta !== null && typeof input.meta === 'object' ? input.meta : null;
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const approval = server.approval !== null && typeof server.approval === 'object' ? server.approval : null;
  const bytes = (n) => (typeof n === 'number' && n >= 0 ? fmtBytes(n) : '-');
  const text = (v, fallback) => (v === undefined || v === null || v === '' ? (fallback === undefined ? '-' : fallback) : String(v));

  // 环境能力与降级（host envNotes = describeEnv 的人话承诺；旧宿主没这个字段显示 —）
  const envNotesValue = (server) => {
    const notes = Array.isArray(server.envNotes) && server.envNotes.length > 0 ? server.envNotes : null
    if (notes === null) return '—'
    return notes.join(' · ')
  }
  const envNotesTitle = (server) => Array.isArray(server.envNotes) && server.envNotes.length > 0
    ? server.envNotes.join('\n')
    : '宿主未上报（旧代码；需重启 dsh web 才有）'
  const envNotesNeedsWarn = (notes) => Array.isArray(notes) && notes.some((n) => /降级|压制|不存活|不准|关闭/.test(String(n)))

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
    // 这是**回退**值：由工具新建的会话默认落在当前对话的工作目录，只有拿不到对话时（面板建的）
    // 才用它。不写清的话用户会以为新 shell 都在这里。
    { k: '起始目录', v: text(server.defaultCwd) + '（回退：拿不到对话目录时用）',
      title: 'AI 通过工具新建的 shell 默认在**当前对话的工作目录**；这一项只在没有对话信息时（例如你在面板里点＋新建）生效。' },
    { k: '默认 shell', v: text(server.shell) },
    { k: 'TERM', v: text(server.defaultTerminal) },
    { k: '滚动缓冲上限', v: text(server.historyLimit) + ' 行' },
    // 设置页是否真的能用：三态如实分开（已接入 / 未注册并给出原因 / 旧宿主未上报）。
    // 「服务挂载了但注册失败」绝不能显示成「已接入」—— 那样用户会去设置页找不到卡片。
    { k: '参数设置', v: settingsRowValue(server), title: settingsRowTitle(server),
      tone: server.settings !== undefined && server.settings.registered === false ? 'warn' : 'dim' },
    // tmux 是系统依赖，装没装决定了整个插件能用不能用 —— 缺了要在这里直接说清怎么装
    { k: 'tmux', v: tmuxRowValue(server), tone: tmuxRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
    // 浏览器面闸门：这组路由**没有鉴权**，用户有权知道现在是谁在把关、有没有降级。
    { k: '浏览器面闸门', v: fenceRowValue(server), title: fenceRowTitle(server),
      tone: fenceRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
    // 这三个字段是 0.1.2 才加进 /list 的：旧宿主不会上报。
    // 缺了就如实写「未知」—— 不能把「没上报」显示成「关」，那是编造状态。
    // extended-keys 行显示**实际生效**状态：配置开了但被版本压制（<3.2）时如实说，
    // 别让用户以为"我开了怎么没反应"（压制状态由宿主探测后写进 server.tmux.extKeys）。
    { k: 'extended-keys', v: server.extendedKeys !== true
        ? (server.extendedKeys === false ? '关（默认；需 tmux ≥ 3.2）' : '未知（宿主未上报，需重启 dsh web）')
        : (server.tmux?.extKeys === 'on' ? '开（tmux ≥ 3.2，Shift+Enter 等可用）'
          : '配置开，但' + String(server.tmux?.extKeys ?? '状态未知') + ' —— 已压制') },
    // 环境能力与降级（0.2.2）：每台机器能力不同，降级必须说人话（describeEnv 的承诺句）
    { k: '能力与降级', v: envNotesValue(server), title: envNotesTitle(server),
      tone: envNotesNeedsWarn(server.envNotes) ? 'warn' : 'dim' },
  ]

  // 安全与审计：审计/留痕/护栏/链完整性/加锁状态 —— 这些是「可信」相关的行，集中在一组
  // （从服务端组搬来，详情页按卡片展示时整组进「安全」卡，不必在系统卡里找）。
  const securityRows = [
    // 审计加锁提醒（设置项 auditLockReminder，默认关）：打开且未加锁时在安全卡首行醒目提示 ——
    // 如实告知"现在只是可检测，不是不可篡改"，而不是让用户以为已经锁上了。
    ...(server.auditLockReminder === true && server.audit?.locked !== 'append-only'
      ? [{ k: '审计加锁提醒', v: '未加锁：篡改可检测、物理可改；要"不可篡改"见 README「审计加锁」',
          tone: 'warn' }]
      : []),
    // 链完整性：篡改可见的结论必须展示（不展示 = 没做）
    { k: '审计链', v: chainRowValue(server), title: chainRowTitle(server),
      tone: chainRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
    { k: '审计锁定', v: lockRowValue(server), title: lockRowTitle(server),
      tone: lockRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
    // 审计与留痕：用户有权知道"现在记不记、记在哪、有没有写失败"——审计的价值全在可信。
    { k: '审计', v: auditRowValue(server), title: auditRowTitle(server),
      tone: auditRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
    { k: '输出留痕', v: captureRowValue(server), title: captureRowTitle(server),
      tone: captureRowValue(server).startsWith('⚠') ? 'warn' : 'dim' },
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
    { group: '审批与安全', rows: [...securityRows, ...approvalRows] },
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
  right: 'M9 6l6 6-6 6',
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
  shield: 'M12 3l7 3v5.2c0 4.1-2.9 7.6-7 9-4.1-1.4-7-4.9-7-9V6zM9.2 12.2l2 2 3.6-3.8',
}

/**
 * 面板样式。
 *
 * 为什么要注入 <style>：内联样式表达不了 `:hover` / `:active` / 过渡，而这些正是
 * 「按钮看着不丑」的关键。`apply()` 里插一次并在 `ctx.effect` 的清理里移除。
 */
const PANEL_CSS = `
.dshsh-btn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer;flex:0 0 auto;
  transition:background .12s ease,color .12s ease,border-color .12s ease,transform .06s ease}
.dshsh-btn:hover:not(:disabled){background:var(--dsw-alias-button-tool-bar-hover);color:var(--dsw-alias-label-primary)}
.dshsh-btn:active:not(:disabled){transform:translateY(1px)}
.dshsh-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:1px}
.dshsh-btn:disabled{opacity:.3;cursor:not-allowed}
.dshsh-btn.on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-btn.locked{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-button-ghost-active-fill)}
/* 关闭与收起之间的分隔：两者代价不同，视觉上也要分开 */
.dshsh-sep{width:1px;height:16px;flex:0 0 auto;margin:0 7px;background:var(--dsw-alias-border-l2)}
/* ── 设置卡片（渲染在 DSH 设置页 →「插件配置」标签页里）──────────────────────
 *
 * 每一项取值都照**官方编译产物**抄（@deepseek-ai/dsh-client-ui-settings-plugins
 * 的 PluginCard.module.css / fields.module.css / PluginsSettingsSection.module.css，
 * 它们以字符串形式内联在该包 client.js 顶部，可直接读到）：
 *   card      边框 .5px border-l4、圆角 16px、关闭 layer-3 / 展开 layer-2
 *   name      15px/600/1.4；description 13px/1.5
 *   body      border-top .5px border-l2、margin 0 16px、padding-bottom 8px
 *   field     纵向 flex、gap 6px、padding 12px 0，相邻 field 之间 .5px 上边框
 *   input     高 34px、padding 0 12px、13px、圆角 8px、边框 .5px border-l4
 *   footer    在 body **内部**，border-top .5px、右对齐、gap 8px、padding 12px 0 4px
 *   按钮      padding 5px 14px、13px、圆角 8px、disabled opacity .4
 *
 * 踩过的坑（这次修的就是它）：早前是"凭印象对齐"—— 12px 圆角、14px 标题、1px
 * border-l2、三列网格 minmax(140px,200px) / minmax(150px,220px) / minmax(0,1fr)、
 * 页脚放在 body 外面。三处后果：① 网格有 ~342px 的最小宽度，面板窄时溢出卡片边框；
 * ② 错误/只读提示是网格子项却没有 grid-column:1/-1，它挤进第 1 列并把**其后每一行
 * 都推移一格** → 整张卡片错位；③ 页脚不在 body 的 16px 内缩里，宽度和上面对不齐。
 * 纵向堆叠（官方做法）没有列宽概念，任何宽度都不会错位。
 */
.dshsh-cfg-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);
  border-radius:16px;list-style:none;transition:border-color .16s,background .16s}
.dshsh-cfg-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dshsh-cfg-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dshsh-cfg-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;
  background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dshsh-cfg-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshsh-cfg-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dshsh-cfg-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dshsh-cfg-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dshsh-cfg-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dshsh-cfg-chevron-open{transform:rotate(180deg)}
/* 官方用 Tag primitive 显示"未保存"；我们不引额外依赖，用同尺寸的静态标签 */
.dshsh-cfg-pending{flex:none;align-self:center;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;
  padding:1px 6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;white-space:nowrap}
.dshsh-cfg-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.dshsh-cfg-readonly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}
/* 分组标题：独占一行，并且**打断** .field + .field 的相邻关系，
   所以每组第一项不会带上分隔线（新分组从头开始，视觉上是干净的） */
.dshsh-cfg-group{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:1.5;
  margin:0;padding:14px 0 0}
.dshsh-cfg-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.dshsh-cfg-field+.dshsh-cfg-field{border-top:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cfg-head{align-items:center;gap:8px;display:flex}
/* 字段名就是配置键（historyLimit 这种），等宽字体更好认；字号/字重照官方 label */
.dshsh-cfg-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;
  line-height:1.5;font-family:var(--ds-font-family-code);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-cfg-badges{align-items:center;gap:8px;display:inline-flex;flex:none}
.dshsh-cfg-badge{border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);
  border-radius:6px;padding:1px 6px;font-size:11px;line-height:1.5;white-space:nowrap}
.dshsh-cfg-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;font:inherit;font-size:13px;
  line-height:1.5;font-family:var(--ds-font-family-code);color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l4);border-radius:8px}
.dshsh-cfg-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshsh-cfg-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
/* 布尔项：官方 SubagentModelSelectionCard 的 toggleRow —— 标签在左、开关在右、两端对齐 */
.dshsh-cfg-togglerow{color:var(--dsw-alias-label-primary);justify-content:space-between;align-items:flex-start;
  gap:16px;font-size:13px;line-height:1.5;display:flex}
.dshsh-cfg-togglelabel{flex:1;min-width:0;align-items:center;gap:8px;display:flex}
.dshsh-cfg-togglelabel code{min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;
  font-family:var(--ds-font-family-code);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-cfg-check{flex:none;width:16px;height:16px;margin:1px 0 0;cursor:pointer;
  accent-color:var(--dsw-alias-label-primary)}
.dshsh-cfg-check:disabled{cursor:default}
.dshsh-cfg-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.dshsh-cfg-footer{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;
  gap:8px;padding:12px 0 4px;display:flex}
.dshsh-cfg-note{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;margin:0;font-size:12px;line-height:1.5}
/* 官方 .failed 用的是 --dsw-alias-label-error，但那个令牌在部分皮肤里**没有定义**
   （实测 blue-fantasy 的皮肤样式表里查不到，官方那条颜色其实是失效的）。
   这里改用本部署确实存在的 --dsw-alias-state-error-primary，浅色/深色主题都跟着走。 */
.dshsh-cfg-failed{min-width:0;color:var(--dsw-alias-state-error-primary);
  flex:1;margin:0;font-size:12px;line-height:1.5}
.dshsh-cfg-discard,.dshsh-cfg-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;
  border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.dshsh-cfg-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.dshsh-cfg-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.dshsh-cfg-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.dshsh-cfg-discard:disabled,.dshsh-cfg-save:disabled{opacity:.4;cursor:default}
.dshsh-cfg-discard:focus-visible,.dshsh-cfg-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
/* 真实光标：绝对定位在 <pre> 的内容坐标里（随内容滚动，无需同步），
   横向宽度由 Range 实测（见 measurePrefixWidth），纵向用实测行高。 */
/* 屏幕文本：MeasurePrefixWidth 靠这个类拿到文本节点（量前缀宽度用）；
   样式本身与 <pre> 一致，保持列的严格对齐。 */
.dshsh-screen-text{white-space:pre}
.dshsh-caret{display:block;z-index:1;animation:dshsh-blink 1.1s step-end infinite}
@keyframes dshsh-blink{0%,55%{opacity:.8}56%,100%{opacity:.15}}
@media (prefers-reduced-motion: reduce){.dshsh-caret{animation:none}}
/* 待确认态：实心红，明确"再点一次就真关了" */
.dshsh-btn.danger.armed{border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-btn.danger:hover:not(:disabled){border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dshsh-btn.accent{background:var(--dsw-alias-button-primary-fill);border-color:var(--dsw-alias-border-inverted);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-btn.accent:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-btn.hot{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-button-ghost-active-fill)}

.dshsh-grip{color:var(--dsw-alias-label-tertiary);cursor:grab;display:inline-flex;align-items:center;
  padding:0 2px;flex:0 0 auto;letter-spacing:-1px;user-select:none}

.dshsh-name{display:inline-flex;align-items:center;gap:5px;max-width:280px;min-width:0;overflow:hidden;padding:2px 7px 2px 10px;
  border:1px solid transparent;border-radius:7px;background:transparent;cursor:pointer;flex:0 1 auto;
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;
  font-family:var(--ds-font-family-code);
  transition:background .12s ease,border-color .12s ease}
.dshsh-name:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dshsh-name-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 触发器两排（与下拉菜单行一致）：第一排 名字+创建者，第二排 稳定 id+尺寸 */
.dshsh-name-cell{display:flex;flex-direction:column;gap:1px;flex:1 1 auto;min-width:0;overflow:hidden}
/* 触发器里的单元格同受"可收缩 + 不换行"约束；创建者徽标收得更紧（给名字留位置） */
.dshsh-name .dshsh-cell{overflow:hidden}
.dshsh-name .dshsh-row-owner{max-width:46%}
.dshsh-name .dshsh-row-name,.dshsh-name .dshsh-row-id,.dshsh-name .dshsh-row-meta{min-width:0}
.dshsh-name-top{display:flex;align-items:center;gap:6px;min-width:0}
.dshsh-name-label{flex:0 1 auto;min-width:0;color:var(--dsw-alias-label-primary);font-weight:600;
  font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-name-owner{flex:0 0 auto;max-width:55%;margin-left:auto;padding:0 5px;border-radius:999px;
  border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);
  font-size:9.5px;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-name-sub{display:flex;align-items:baseline;gap:6px;min-width:0;font-size:10px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}

.dshsh-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;flex:0 0 auto}
.dshsh-spacer{flex:1 1 auto;display:flex;align-items:center;justify-content:center;min-width:0}
.dshsh-busybar{flex:0 0 auto;max-width:100%;padding:2px 10px;border-radius:999px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-button-ghost-active-fill);border:.5px solid var(--dsw-alias-state-warn-primary)}
.dshsh-head{min-width:0}
.dshsh-name{min-width:0}
/* 宽度不足时先隐藏次要信息，保证按钮不会被挤出浮窗（真实 bug）。
   0.2.3：触发器改用共用的 .dshsh-row-* 之后，这里要跟着换选择器 —— 否则窄面板下
   创建者/副行不会被隐藏，头部按钮仍会被挤出（旧类名已不再渲染）。 */
.dshsh-compact .dshsh-grip,.dshsh-compact .dshsh-count,
.dshsh-compact .dshsh-sep,.dshsh-compact .dshsh-name-text,
.dshsh-compact .dshsh-name-owner,.dshsh-compact .dshsh-name-sub,
.dshsh-compact .dshsh-name .dshsh-row-owner,.dshsh-compact .dshsh-name .dshsh-row-sub{display:none}

.dshsh-info{position:absolute;top:40px;right:8px;z-index:41;width:min(440px,calc(100% - 16px));
  max-height:calc(100% - 84px);overflow:auto;overscroll-behavior:contain;padding:4px;
  border:0;border-radius:20px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);
  font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-primary)}
/* 头部条吸顶：滚长列表时「复制/关闭」始终在手边 */
/* ── 折叠态胶囊 ───────────────────────────────────────────────────────────── */
.dshsh-pill{transition:background .12s ease,border-color .12s ease,transform .06s ease}
.dshsh-pill:hover{background:var(--dsw-alias-button-floating-hover)}
.dshsh-pill:active{transform:translateY(1px)}
.dshsh-pill:focus-visible{outline:2px solid var(--dsw-alias-border-l4);outline-offset:2px}
.dshsh-pill-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;display:inline-block}
/* 有命令在跑时轻微脉冲，余光能注意到，但不打扰 */
.dshsh-pill.busy .dshsh-pill-dot{animation:dshsh-pulse 1.6s ease-in-out infinite}
@keyframes dshsh-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dshsh-pill.busy .dshsh-pill-dot{animation:none}}
.dshsh-pill-mark{color:var(--dsw-alias-label-tertiary);letter-spacing:-.5px}
.dshsh-pill-name{color:var(--dsw-alias-label-primary);max-width:132px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.dshsh-pill-lock{display:inline-flex;align-items:center;flex:0 0 auto}
/* 拖动提示：悬停才出现，免得常态多一个装饰 */
.dshsh-pill .dshsh-grip{opacity:0;transition:opacity .12s ease;margin-right:-2px}
.dshsh-pill:hover .dshsh-grip{opacity:.6}
.dshsh-info-bar{display:flex;align-items:center;gap:8px;padding:8px 10px 6px;margin:0 -4px 2px;
  border-bottom:.5px solid var(--dsw-alias-border-l2);position:sticky;top:0;z-index:2;
  background:var(--dsw-specific-menu)}
.dshsh-info-bar>t{flex:1 1 auto;font-size:12.5px;font-weight:600;letter-spacing:.01em}
/* 详情页折叠卡片（方案 A：7 组 → 4 卡）。标题行可点，展开/收起带箭头。 */
.dshsh-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;margin:2px 4px 6px;
  background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dshsh-card.open{background:var(--dsw-alias-bg-layer-3)}
.dshsh-card-h{display:flex;align-items:center;gap:8px;width:100%;padding:9px 10px;
  border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;
  font-size:12.5px;font-weight:600;text-align:left;cursor:pointer}
.dshsh-card-h:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-card-h:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshsh-card-h svg{color:var(--dsw-alias-label-caption);flex:0 0 auto;transition:transform .12s ease}
.dshsh-card-name{flex:1 1 auto;min-width:0}
.dshsh-card-sub{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;
  font-variant-numeric:tabular-nums}
.dshsh-card-body{padding:0 2px 6px}
/* 风险横幅：最要紧的一条放在最上面，而不是埋进第 N 组 */
.dshsh-info-alert{display:flex;gap:7px;align-items:flex-start;margin:2px 4px 8px;padding:8px 10px;border-radius:10px;
  background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:1.6}
.dshsh-info-alert b{color:var(--dsw-alias-state-error-primary)}
.dshsh-info-group{display:flex;align-items:baseline;gap:6px;margin:8px -4px 2px;padding:5px 10px 3px;
  color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-weight:500;line-height:18px}
.dshsh-info-group:first-of-type{margin-top:2px}
.dshsh-info-group>c{margin-left:auto;font-size:10.5px;color:var(--dsw-alias-label-tertiary);letter-spacing:0;text-transform:none;font-weight:400;font-variant-numeric:tabular-nums}
.dshsh-kv{display:flex;gap:10px;align-items:baseline;padding:3px 10px;border-radius:8px;cursor:default}
.dshsh-kv:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-kv>k{flex:0 0 104px;color:var(--dsw-alias-label-tertiary);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
/* 值用等宽：路径、pid、版本号这类东西对齐了才好读 */
.dshsh-kv>v{flex:1 1 auto;min-width:0;font-family:var(--ds-font-family-code);
  font-size:11px;word-break:break-word;font-variant-numeric:tabular-nums}
.dshsh-kv>v.dim{color:var(--dsw-alias-label-tertiary)}
.dshsh-kv>v.warn{color:var(--dsw-alias-state-error-primary)}
.dshsh-kv>v.ok{color:var(--dsw-alias-state-success-primary)}
.dshsh-kv[data-copy]{cursor:pointer}
.dshsh-kv[data-copy]:hover>v{text-decoration:underline dotted;text-underline-offset:2px}
.dshsh-kv>v>i{font-style:normal;opacity:.55;margin-left:6px;font-size:10px}
.dshsh-badge{display:inline-flex;align-items:center;height:16px;padding:0 6px;border-radius:999px;
  border:.5px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);font-size:10px}
.dshsh-native{font-family:inherit;font-size:11px;color:inherit;background:transparent;border:0;padding:0;cursor:pointer;
  text-decoration:underline dotted;text-underline-offset:2px}
.dshsh-native:hover{color:var(--dsw-alias-label-primary)}
.dshsh-err{display:flex;gap:7px;align-items:flex-start;margin:0 10px 8px;padding:6px 8px;border-radius:7px;
  border-left:3px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:1.5}
.dshsh-err span:last-child{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
/* 「不是错误，但必须让你知道」—— 与 .dshsh-err 同款几何、中性配色：
   操作确实成功了（例如改名被净化改写），用红色报错是误导，用沉默则是静默改写。 */
.dshsh-note{display:flex;gap:7px;align-items:flex-start;margin:0 10px 8px;padding:6px 8px;border-radius:7px;
  border-left:3px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-tool-bar-hover);
  color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.dshsh-note span:last-child{overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dshsh-cmenu{position:absolute;top:40px;right:8px;z-index:42;width:min(525px,calc(100% - 16px));
  max-height:calc(100% - 84px);overflow:auto;overscroll-behavior:contain;padding:4px;
  border:0;border-radius:20px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);
  font-size:12px;color:var(--dsw-alias-label-primary)}
.dshsh-cmenu-h{margin:6px -4px 1px;padding:6px 10px 3px;
  background:var(--dsw-specific-menu);font-size:11.5px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshsh-cmenu-h:first-child{margin-top:2px}
/* 分段选择：整组一个平台色底槽，选中项浮起（DSH 分段的做法） */
.dshsh-cmenu-seg{display:flex;align-items:center;gap:2px;margin:0 6px 8px;padding:3px;
  border-radius:12px;background:var(--dsw-alias-bg-module-platform)}
.dshsh-cmenu-seg-btn{flex:1 1 0;min-width:0;height:28px;border:0;border-radius:9px;
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;
  line-height:1;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  transition:background .12s ease,color .12s ease}
.dshsh-cmenu-seg-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsh-cmenu-seg-btn.on{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);
  box-shadow:var(--dsw-elevation-soft);font-weight:600}
.dshsh-cmenu-row{display:flex;align-items:center;gap:8px;margin:0 6px;padding:7px 2px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cmenu-row:last-child{border-bottom:0}
.dshsh-cmenu-row>span:first-child{flex:1 1 auto;font-size:12.5px}
.dshsh-cmenu-in{width:76px;height:28px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l4);
  border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-family:var(--ds-font-family-code)}
.dshsh-cmenu-in:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshsh-cmenu-sub{font-size:11px;color:var(--dsw-alias-label-tertiary)}
/* 应用 / 全部撤销：主按钮与危险幽灵按钮（同 DSH settings 的 primary/danger 形状） */
.dshsh-cmenu-actions{display:flex;align-items:center;justify-content:flex-start;gap:6px;
  margin:0 6px 6px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cmenu-go{height:30px;padding:0 16px;border:0;border-radius:15px;
  background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);
  font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.dshsh-cmenu-go:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}
.dshsh-cmenu-clear{height:30px;padding:0 12px;border:0;border-radius:15px;background:transparent;
  color:var(--dsw-alias-state-error-primary);font:inherit;font-size:12.5px;cursor:pointer;
  display:inline-flex;align-items:center;gap:4px}
.dshsh-cmenu-clear:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}

.dshsh-cmenu-list{margin:0 2px}
/* 授权浮层重做（0.2.3）：标题条 + 状态徽标 + 页签 + 后果卡片 + 复核句 */
.dshsh-cmenu-bar{display:flex;align-items:center;gap:8px;padding:2px 2px 6px}
.dshsh-cmenu-title{flex:1 1 auto;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshsh-cmenu-chip{flex:0 0 auto;max-width:60%;padding:1px 8px;border-radius:999px;font-size:10.5px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);
  color:var(--dsw-alias-label-tertiary)}
.dshsh-cmenu-chip.on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-cmenu-chip.warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dshsh-cmenu-tabsbar{position:sticky;top:0;z-index:3;margin:0 -4px 8px;padding:6px 6px 4px;
  background:var(--dsw-specific-menu);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cmenu-tabs{display:flex;gap:4px;padding:2px;border-radius:10px;background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-cmenu-tab{flex:1 1 0;min-width:0;padding:5px 2px;border:0;border-radius:8px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-cmenu-tab.on{background:var(--dsw-special-fill-primary-fg);color:var(--dsw-label-color,var(--dsw-alias-label-primary));
  background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.dshsh-cmenu-body{display:flex;flex-direction:column;gap:6px}
.dshsh-opt{display:flex;align-items:center;gap:10px;width:100%;padding:8px 8px;border:0;
  border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;text-align:left;cursor:pointer}
.dshsh-opt:last-child{border-bottom:0}
.dshsh-opt:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-opt-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px}
.dshsh-opt-label{font-size:12.5px;font-weight:600}
.dshsh-opt.on .dshsh-opt-label{color:var(--dsw-alias-brand-primary)}
.dshsh-opt-hint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.45}
.dshsh-opt-radio{flex:0 0 auto;width:15px;height:15px;border-radius:50%;
  border:1.5px solid var(--dsw-alias-border-l4);display:flex;align-items:center;justify-content:center}
.dshsh-opt.on .dshsh-opt-radio{border-color:var(--dsw-alias-brand-primary)}
.dshsh-opt.on .dshsh-opt-radio::after{content:'';width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary)}
.dshsh-cmenu-review{margin:2px 6px 0;padding:6px 10px;border-radius:8px;font-size:11.5px;
  background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-label-secondary);
  font-variant-numeric:tabular-nums}

/* 按对话授权：搜索 + 候选列表 + 选中后的档位/有效期（沿用 DSH 菜单项观感） */
.dshsh-actors{margin:0 6px}
.dshsh-actor-list{display:flex;flex-direction:column;gap:2px}
.dshsh-actor-item{display:flex;align-items:center;gap:6px;min-width:0;min-height:30px;padding:3px 8px;
  border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dshsh-actor-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-actor-item.on{background:var(--dsw-alias-interactive-bg-active)}
.dshsh-actor-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshsh-actor-when{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshsh-actor-id{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:10.5px}
.dshsh-actor-tag{flex:0 0 auto;padding:0 6px;border-radius:999px;font-size:10px;
  border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary)}
.dshsh-actor-tag.ok{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dshsh-actor-pick{margin:6px 0 2px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dshsh-cmenu-item{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:10px;
  min-height:36px}
.dshsh-cmenu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-cmenu-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-family:var(--ds-font-family-code);font-size:11.5px}
.dshsh-stable{width:100%;border-collapse:collapse;font-size:11.5px;table-layout:fixed}
.dshsh-stable th{text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:2px 6px;
  border-bottom:.5px solid var(--dsw-alias-border-l4)}
.dshsh-stable td{padding:4px 6px;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top;
  overflow-wrap:anywhere;color:var(--dsw-alias-label-primary)}
.dshsh-stable tr:last-child td{border-bottom:0}
.dshsh-stable .k{font-weight:600}
.dshsh-stable .sub{color:var(--dsw-alias-label-tertiary);font-size:10.5px}
.dshsh-cmenu-badge{flex:0 0 auto;padding:1px 7px;border-radius:999px;font-size:10px;
  border:.5px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);
  background:var(--dsw-alias-state-success-tertiary)}
.dshsh-picker{position:absolute;top:40px;left:10px;z-index:40;width:min(360px,calc(100% - 20px));
  max-height:320px;overflow:auto;padding:4px;border:0;border-radius:20px;
  background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent);
  --dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
.dshsh-row{display:flex;align-items:center;gap:4px;border-radius:10px}
.dshsh-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshsh-row.current{background:var(--dsw-alias-interactive-bg-active)}
.dshsh-item{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;padding:6px 4px 6px 8px;
  border:0;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-family:var(--ds-font-family-code);
  text-align:left;cursor:pointer}
.dshsh-item span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 下拉一行两排：第一排「名字 + 创建者」、第二排「id + 尺寸/前台/字节」。
   覆盖上面的 .dshsh-item span 通用截断规则（cell 自身需要换行排列、不截断） */
.dshsh-item .dshsh-cell,.dshsh-name .dshsh-cell{display:flex;flex-direction:column;gap:2px;flex:1 1 auto;min-width:0;
  white-space:normal;overflow:visible}
.dshsh-item .dshsh-row-top,.dshsh-name .dshsh-row-top{display:flex;align-items:center;gap:6px;min-width:0}
.dshsh-row-name{flex:0 1 auto;min-width:0;color:var(--dsw-alias-label-primary);
  font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 创建者：**永不换行**，过长就省略号截断（完整名字在 title 悬停提示里）。
   早先这里没有 nowrap/ellipsis —— 在触发器里没有 .dshsh-item 那条截断规则兜底，
   长会话标题会把标题栏撑宽/撑成两行（用户反馈）。 */
.dshsh-row-owner{flex:0 1 auto;min-width:0;max-width:55%;margin-left:auto;padding:0 5px;
  border-radius:999px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-tertiary);
  font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshsh-item .dshsh-row-sub,.dshsh-name .dshsh-row-sub{display:flex;align-items:baseline;gap:8px;min-width:0;font-size:10.5px;
  color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dshsh-row-id{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.dshsh-row-meta{flex:1 1 auto;min-width:0}
.dshsh-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
/* 通知 A：刚跑完（busy→idle）时闪几下，3 秒后自动停（类名由面板摘掉） */
.dshsh-dot.done{animation:dshsh-flash .45s ease-in-out 4}
@keyframes dshsh-flash{0%{box-shadow:0 0 0 0 currentColor;opacity:1}60%{box-shadow:0 0 0 5px transparent;opacity:.55}100%{box-shadow:0 0 0 0 transparent;opacity:1}}
@media (prefers-reduced-motion:reduce){.dshsh-dot.done{animation:none}}
.dshsh-row-x{opacity:0;margin-right:3px;width:22px;height:22px;transition:opacity .12s ease}
.dshsh-row:hover .dshsh-row-x{opacity:1}
.dshsh-new{display:flex;align-items:center;gap:7px;width:100%;margin-top:4px;padding:6px 8px;
  border:1px dashed var(--dsw-alias-border-l2);border-radius:7px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;
  transition:background .12s ease,color .12s ease,border-color .12s ease}
.dshsh-new:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.dshsh-stat-btn{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 7px;border-radius:6px;
  border:.5px solid var(--dsw-alias-border-l2);background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;
  transition:background .12s ease,color .12s ease,border-color .12s ease}
.dshsh-stat-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshsh-stat-btn:disabled{opacity:.35;cursor:not-allowed}
.dshsh-stat-btn.go{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-button-ghost-active-fill)}
.dshsh-picker::-webkit-scrollbar,.dshsh-screen::-webkit-scrollbar{width:9px;height:9px}
.dshsh-picker::-webkit-scrollbar-thumb,.dshsh-screen::-webkit-scrollbar-thumb{
  background:var(--dsw-alias-label-tertiary);opacity:.45;border-radius:9px}
.dshsh-picker::-webkit-scrollbar-thumb:hover,.dshsh-screen::-webkit-scrollbar-thumb:hover{
  background:var(--dsw-alias-label-tertiary);opacity:.8}

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
  border-right:2px solid var(--dsw-alias-label-tertiary);
  border-bottom:2px solid var(--dsw-alias-label-tertiary);
  border-radius:0 0 2px 0;opacity:.75}

.dshsh-rename{display:flex;align-items:center;gap:5px;flex:1 1 auto;min-width:0;padding:3px 6px}
.dshsh-rename input{flex:1 1 auto;min-width:0;height:24px;padding:0 7px;border-radius:6px;
  border:1px solid var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;font-family:var(--ds-font-family-code);outline:none}
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
    const BUILD = 'c18'
    /**
     * 包版本号，必须与 package.json 的 `version` 完全一致。
     *
     * 这里刻意冗余一次：面板指标行会把版本显示出来，用户报障时不必去翻
     * `node_modules/dsh-agent-shell/package.json` 就能说清跑的是哪一版。
     * 两边一旦漂移，`npm run release:check` 会直接失败，所以不会长期不同步。
     */
    const PKG_VERSION = '0.3.2'
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
      /** 折叠态胶囊里的名字：等宽没必要，但要截断（宽度靠它吸收）。 */
      pillName: {
        maxWidth: '132px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      pill: {
        position: 'fixed',
        pointerEvents: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: PILL_H + 'px',
        padding: '0 10px 0 8px',
        borderRadius: '17px',
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-button-floating-fill)',
        color: 'var(--dsw-alias-label-primary)',
        boxShadow: '0 4px 14px var(--dsw-alias-bg-mask-1)',
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
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        boxShadow: '0 6px 20px var(--dsw-alias-bg-mask-1)',
        overflow: 'hidden',
        zIndex: 9999,
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 10px',
        borderBottom: '.5px solid var(--dsw-alias-border-l2)',
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
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
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
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'inherit',
        fontSize: '11px',
        lineHeight: 1,
        cursor: 'pointer',
      },
      lockOn: {
        borderColor: 'var(--dsw-alias-state-warn-primary)',
        color: 'var(--dsw-alias-state-warn-primary)',
      },
      lockOff: {
        borderColor: 'var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      grip: {
        color: 'var(--dsw-alias-label-tertiary)',
        fontSize: '11px',
        letterSpacing: '-1px',
      },
      name: {
        flex: 1,
        textAlign: 'center',
        fontFamily: 'var(--ds-font-family-code)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      screen: {
        flex: 1,
        // 光标是绝对定位的子元素：包含块是 padding box，所以偏移量要自己加上内边距
        position: 'relative',
        margin: 0,
        padding: (SCREEN_PAD_Y / 2) + 'px ' + String(SCREEN_PAD_X) + 'px',
        overflow: 'auto',
        fontFamily: 'var(--ds-font-family-code)',
        fontSize: '12px',
        lineHeight: 1.35,
        whiteSpace: 'pre',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-markdown-code-segment-unselected)',
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
        borderTop: '.5px solid var(--dsw-alias-border-l2)',
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'var(--ds-font-family-code)',
      },
      inputRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 10px',
        borderTop: '.5px solid var(--dsw-alias-border-l2)',
        borderRadius: '0 0 11px 11px',
      },
      input: {
        flex: 1,
        height: '30px',
        padding: '0 9px',
        borderRadius: '6px',
        border: '.5px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--ds-font-family-code)',
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
      // 关闭按钮的待确认态：3 秒内没有第二次点击就自动复位
      const [closeArmed, setCloseArmed] = react.useState(false)
      const closeArmTimer = react.useRef(null)
      // 授权按钮：主动授权是两下（第二下才真的授权），撤销是一下（安全方向无需确认）
      const [consentArmed, setConsentArmed] = react.useState(false)
      const consentArmTimer = react.useRef(null)
      const [consentBusy, setConsentBusy] = react.useState(false)
      // 授权浮层：档位 × 时间两个维度 + 已授权会话列表
      const [consentMenuOpen, setConsentMenuOpen] = react.useState(false)
      // 授权浮层两个页签：'actor'（给单个对话授权，最常用）| 'global'（所有对话的默认档）
      const [consentTab, setConsentTab] = react.useState('actor')
      const [draftScope, setDraftScope] = react.useState('full')
      const [draftTtl, setDraftTtl] = react.useState('10m')
      const [customMinutes, setCustomMinutes] = react.useState('30')
      // 「按对话授权」：候选对话列表（/actors）+ 搜索词 + 选中项 + 该项的档位/有效期草稿
      const [actors, setActors] = react.useState(null)          // null = 还没拉
      const [actorQuery, setActorQuery] = react.useState('')     // 搜索词（按 id / 标题 / 子代理）
      const [actorPick, setActorPick] = react.useState(null)     // 选中的 { id, title }
      const [actorScope, setActorScope] = react.useState('read')
      const [actorTtl, setActorTtl] = react.useState('10m')
      // 宿主没有对话目录时的「手工填 id」草稿；有目录时的搜索词在 actorQuery
      const [actorManual, setActorManual] = react.useState('')
      // 0.3.0「引用库」页签：vault 人写（AI 只见键名）；宏人+AI 可写（全量入封链）
      const [secretsTab, setSecretsTab] = react.useState('vault')  // 'vault' | 'macros'
      const [secretsData, setSecretsData] = react.useState(null)   // {vault:[],macros:[]}
      const [secretsBusy, setSecretsBusy] = react.useState(false)
      const [vKey, setVKey] = react.useState('')
      const [vVal, setVVal] = react.useState('')
      const [vOne, setVOne] = react.useState(true)
      const [vNote, setVNote] = react.useState('')
      const [vTtl, setVTtl] = react.useState('')            // 0.3.2 ③：N 天未用自动焚（空=不设）
      const [copiedKey, setCopiedKey] = react.useState('')  // 0.3.2：键名点击复制的瞬时反馈
      const [secretsWarn, setSecretsWarn] = react.useState([])  // 0.3.2 ②：弱形状黄条（录入后回显）
      const [secretsExtra, setSecretsExtra] = react.useState(null) // 0.3.2 ④⑪：{history, chain}
      const [mName, setMName] = react.useState('')
      const [mText, setMText] = react.useState('')
      const [mScope, setMScope] = react.useState('global')
      const [mSubmit, setMSubmit] = react.useState(true)
      const [mNote, setMNote] = react.useState('')
      const [renameDraft, setRenameDraft] = react.useState('')
      const [screen, setScreen] = react.useState('')
      const [meta, setMeta] = react.useState(null)
      const [locked, setLocked] = react.useState(true)
      const [error, setError] = react.useState('')
      // 「不是错误，但必须让你知道」的消息 —— 例如改名时净化改写了你输入的名字。
      // 与 error 分开：那种情况用红色报错是误导（操作确实成功了），但不说就等于静默改写。
      const [notice, setNotice] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      // 输入框里是否有残留文本（正常情况下它应始终为空；有残留说明自动提交漏了一次）
      const [residual, setResidual] = react.useState(false)
      // shell 选择器（多 shell 时用来直接跳转，而不是一次次点箭头）
      const [pickerOpen, setPickerOpen] = react.useState(false)
      // ⓘ 详情层：与选择器互斥（两个浮层同时开着会叠在一起）
      const [infoOpen, setInfoOpen] = react.useState(false)
      /**
       * 详情页的折叠卡片状态（方案 A：7 个逻辑分组 → 4 张卡片）。
       * 默认只展开高频的两张（会话 / 安全），系统与关于折起来 —— 37 行平铺缩到首屏 8 行左右。
       * 键是卡片名；缺省（undefined）按 DEFAULT_OPEN 处理。
       */
      const [infoCards, setInfoCards] = react.useState({})
      // 「复制全部」的短暂反馈；定时器要清掉，否则收起面板后还会 setState
      const [copied, setCopied] = react.useState(false)
      // 单值复制的行内反馈（"已复制"），与整段复制的按钮反馈分开
      const [copiedValue, setCopiedValue] = react.useState('')
      const copiedTimer = react.useRef(null)
      react.useEffect(() => () => {
        if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
        if (closeArmTimer.current !== null) clearTimeout(closeArmTimer.current)
        if (notifyTimer.current !== null) clearTimeout(notifyTimer.current)
      }, [])
      // 取多少行：面板必须显式要历史，否则宿主只回可见屏（等于窗格高度）
      const [historyWindow, setHistoryWindow] = react.useState(200)
      // 是否贴着底部；用户往上翻时不要把他拽回来
      const [pinned, setPinned] = react.useState(true)
      const [pos, setPos] = react.useState(() => loadPos() ?? defaultPos())
      const [dragging, setDragging] = react.useState(false)

      // ── 通知 A（面板内视觉，不打扰）：当前 shell 刚跑完 / 有新输出 ──────────
      // busy→idle 时状态点闪 3 秒「刚结束」；屏幕行数增长时出现「+N 行」徽标 3 秒。
      // ⚠ 跟随旧口径：只做面板内视觉，不弹系统通知、不出声。
      const [justIdle, setJustIdle] = react.useState(false)
      const notifyTimer = react.useRef(null)
      const prevIdleRef = react.useRef(null)   // 上一轮 /list 里当前 shell 的空闲判定（null=还没采过）
      const pulseDone = () => {
        setJustIdle(true)
        if (notifyTimer.current !== null) clearTimeout(notifyTimer.current)
        notifyTimer.current = setTimeout(() => {
          setJustIdle(false)
        }, 3000)
      }

      const panelRef = react.useRef(null)
      const screenRef = react.useRef(null)
      /** 量字符宽度的隐藏样本（横向实测失败时的退路） */
      const measureRef = react.useRef(null)
      const cellWidthRef = react.useRef(0)
      /** 量出来的行高（像素）。**不能**从 scrollHeight 推 —— 内容比视口矮时它会等于视口高度。 */
      const lineHeightRef = react.useRef(0)
      react.useEffect(() => {
        const node = measureRef.current
        if (node === null || typeof node.getBoundingClientRect !== 'function') return
        try {
          const width = node.getBoundingClientRect().width
          cellWidthRef.current = Number.isFinite(width) && width > 0 ? width / 40 : 0
        } catch { cellWidthRef.current = 0 }
      })
      react.useEffect(() => {
        const el = screenRef.current
        if (el === null || typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') return
        try {
          const computed = window.getComputedStyle(el)
          lineHeightRef.current = resolveLineHeight({ lineHeight: computed?.lineHeight, fontSize: computed?.fontSize })
        } catch { lineHeightRef.current = 0 }
      })
      const prevScreenRef = react.useRef('')
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
              // 通知 A：当前 shell 从「有命令在跑」回到空闲 → 状态点闪 3 秒「刚结束」
              const cur = (result.body.sessions || []).find((s) => s.name === currentName)
              if (cur !== undefined) {
                const idleNow = !sessionBusy(cur, shellNameOf())
                if (prevIdleRef.current === false && idleNow) pulseDone()
                prevIdleRef.current = idleNow
              }
            }
          } catch { /* 宿主暂时不可达 */ }
        }
        tick()
        const id = setInterval(tick, 2500)
        return () => { alive = false; clearInterval(id) }
      }, [])

      // ── 「按对话授权」的候选对话目录（/actors）──────────────────────────────
      //
      // 只在授权浮层打开时拉（宿主侧有 5s 缓存，成本很低）；授权/撤销之后重拉，
      // 否则 `granted` 徽标与「已授权的会话」列表会停在旧值。
      // ⚠ 曾经的 bug：这里完全没有 effect，`actors` 永远是 null —— 菜单永久卡在
      // 「正在读取对话列表…」，界面承诺的功能实际是死的。0.2.1 装机后在真浏览器里
      // 点开授权菜单才发现（/actors 接口本身一直有数据，是没人去取）。
      const loadActors = react.useCallback(async () => {
        try {
          const result = await api('/actors')
          setActors(result.ok ? result.body : { supported: false, note: result.body?.error, actors: [] })
        } catch {
          setActors({ supported: false, note: '宿主不可达', actors: [] })
        }
      }, [])
      react.useEffect(() => {
        if (!consentMenuOpen) return undefined
        void loadActors()
        return undefined
      }, [consentMenuOpen, loadActors])

      // ── 当前屏 + 历史：展开时按**自适应**节奏轮询 ──────────────────────────
      //
      // 必须显式带上 `lines`：宿主侧的读取在缺省时返回**可见屏**（capture-pane 不带 -S），
      // 那只有窗格高度那么多行。历史一直存在 tmux 里（historyLimit 10 万行），只是没人去取。
      //
      // 为什么不用固定 setInterval：固定 700ms 意味着"跑命令时输出最多滞后 0.7 秒"（用户报的
      // "不跟手"），而一味调快又会在空闲时白跑 —— 每次请求在宿主侧都是一次真实 tmux 调用。
      // 所以改成：屏幕**在变**（或刚发过按键）时走快档，静下来退回慢档。"在变"用文本比对判定，
      // 顺带也让内容没变时 React 不必重渲染（setScreen 传同值它自己会跳过）。
      // 轮询节奏可由宿主设置下发（panelPollMs = 空闲档；快档取它的 1/4）—— 用**数值**做依赖，
      // 否则 server 对象每 2.5s 换新会把轮询 effect 反复重启。
      const pollMs = server !== null && Number.isFinite(server?.ui?.pollMs)
        ? Math.max(200, Math.floor(server.ui.pollMs))
        : SCREEN_IDLE_MS
      const fastMs = Math.max(120, Math.floor(pollMs / 4))
      react.useEffect(() => {
        if (!expanded || currentName === '') { setScreen(''); return undefined }
        let alive = true
        let timer = null
        let lastText = null
        let lastChange = 0
        let lastCount = null   // 上一帧屏幕行数（null = 还没采过，首帧不报「+N」）
        const schedule = () => {
          if (!alive) return
          const fast = Date.now() - lastChange < SCREEN_FAST_WINDOW_MS
          timer = setTimeout(() => { timer = null; void tick() }, fast ? fastMs : pollMs)
        }
        const tick = async () => {
          try {
            const result = await api('/screen?name=' + encodeURIComponent(currentName) + '&lines=' + String(historyWindow))
            if (!alive) return
            if (result.ok) {
              const next = result.body.screen || ''
              if (next !== lastText) {
                lastText = next
                lastChange = Date.now()
                // 通知 A：屏幕行数增长 = 有新输出 → 亮 3 秒圆点脉冲（「+N 行」徽标已按维护者
                // 反馈移除：触发器里换行会撑高标题栏，且信息价值不如一次闪点）
                const count = next === '' ? 0 : next.split('\n').length
                if (lastCount !== null && count > lastCount) {
                  if (notifyTimer.current !== null) clearTimeout(notifyTimer.current)
                  notifyTimer.current = setTimeout(() => { setJustIdle(false) }, 3000)
                  setJustIdle(true)
                }
                lastCount = count
              }
              setScreen(next)
              setMeta(result.body.meta || null)
              setError('')
            } else {
              setError(String(result.body.error || 'read failed'))
            }
          } catch (e) {
            if (alive) setError(String(e && e.message ? e.message : e))
          }
          schedule()
        }
        void tick()
        // 发完按键后的"立刻拉一次"（见 scheduleFastRefresh）：顺带把节奏切到快档，
        // 并取消已排定的那一次，避免同一时刻并发两个请求。
        screenFetchRef.current = () => {
          if (!alive) return
          lastChange = Date.now()
          if (timer !== null) { clearTimeout(timer); timer = null }
          void tick()
        }
        return () => {
          alive = false
          if (timer !== null) { clearTimeout(timer); timer = null }
          screenFetchRef.current = null
        }
      }, [expanded, currentName, historyWindow, pollMs, fastMs])

      // 切换 shell（或收起再展开）时回到「跟随」：新会话应当看到最新输出，
      // 而不是沿用上一个会话的阅读位置。与下面的滚动 effect 收敛在同一帧之后。
      const viewKeyRef = react.useRef('')
      react.useEffect(() => {
        const key = (expanded ? '1' : '0') + '|' + currentName
        if (viewKeyRef.current === key) return
        viewKeyRef.current = key
        setPinned(true)
      }, [expanded, currentName])

      // 新内容到达后的滚动：贴底则跟随，否则**保持阅读位置不动**。
      // 「不动」不是什么都不做：窗口是「最后 N 行」，新输出会把最上面的行挤掉，
      // 不补偿 scrollTop 的话，正在读的那几行依然会被顶上去。补偿交给纯函数 scrollAnchor。
      react.useEffect(() => {
        const el = screenRef.current
        if (el === null) return
        const plan = scrollAnchor(prevScreenRef.current, screen, {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          padding: SCREEN_PAD_Y,
          lineHeight: lineHeightRef.current,
          pinned,
        })
        prevScreenRef.current = screen
        // 补偿位移（jsdom/无输出时 clientHeight 为 0，此时只在跟随状态下有意义）
        if (Math.abs(plan.scrollTop - el.scrollTop) >= 1) el.scrollTop = plan.scrollTop
        if (plan.pinned !== pinned) setPinned(plan.pinned)
      }, [screen, pinned, historyWindow])

      // 光标：只在**用户手动输入**（解锁）且程序没有隐藏光标时画；坐标换算失败就不画。
      // 它是 <pre> 的绝对定位子元素，所以随内容一起滚动，不需要监听滚动去同步。
      const caret = react.useMemo(() => {
        const placement = caretPlacement({ screen, meta })
        if (!shouldShowCaret({ locked, meta, placement })) return null
        // 横向：先问浏览器要「光标前那段文本」的真实宽度（Range 实测，DOM 不动）；
        // 量不到才退回「单元格 × ASCII 字符宽」的估算；都不行就不画。
        // 横向：先问浏览器要「光标那一行上、光标前那段文本」的真实宽度（Range 实测，DOM 不动）；
        // 区间必须限定在**本行**（见 prefixRangeOffsets —— 跨行区间的包围盒会把光标推到行尾）。
        // 量不到才退回「单元格 × ASCII 字符宽」的估算；都不行就不画。
        const span = prefixRangeOffsets(placement)
        const measured = span === null ? Number.NaN
          : measurePrefixWidth(screenRef.current, span.from, span.to)
        const style = caretStyle(
          placement, lineHeightRef.current, cellWidthRef.current,
          SCREEN_PAD_X, SCREEN_PAD_Y / 2, measured,
        )
        return style === null ? null : { placement, style }
      }, [screen, meta, locked])

      const onScreenScroll = (event) => {
        const el = event.currentTarget
        setPinned(el.scrollTop + el.clientHeight >= el.scrollHeight - AT_BOTTOM_PX)
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

      /** 把授权状态写回宿主；成功后用返回值就地更新面板状态，不必等下一次轮询。 */
      const postConsent = async (action, extra = {}) => {
        setConsentBusy(true)
        try {
          const result = await api('/consent', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action, ...extra }),
          })
          if (result.ok) {
            const next = result.body
            setServer((prev) => prev === null ? prev : {
              ...prev,
              consent: { enabled: next.enabled, allowAll: next.allowAll, granted: next.granted },
            })
            void loadActors()
          } else if (result.body && result.body.error) {
            setError(String(result.body.error))
          }
        } catch (err) {
          setError('授权状态写入失败：' + String(err && err.message ? err.message : err))
        } finally {
          setConsentBusy(false)
        }
      }

      /* ── 0.3.0 引用库（面板 = 人这一侧）──────────────────────────────────
       * vault 只有这里（和 CLI）能写：AI 的工具面没有写入口，只见键名。
       * 值输入框 type=password；列表**不回显值**（共享屏幕友好），改值 = 重新录入。 */
      const loadSecrets = async () => {
        setSecretsBusy(true)
        try {
          const [v, m, his, ch] = await Promise.all([api('/vault-list'), api('/macro-list'), api('/vault-history'), api('/chain')])
          setSecretsData({
            vault: v.ok && Array.isArray(v.body.items) ? v.body.items : [],
            macros: m.ok && Array.isArray(m.body.items) ? m.body.items : [],
            vaultCorrupt: v.ok ? String(v.body.corrupt ?? '') : '',
            macrosCorrupt: m.ok ? String(m.body.corrupt ?? '') : '',
          })
          setSecretsExtra({
            history: his.ok && Array.isArray(his.body.items) ? his.body.items : [],
            chain: ch.ok ? ch.body : null,
          })
        } catch (err) {
          setError('读取引用库失败：' + String(err && err.message ? err.message : err))
        } finally {
          setSecretsBusy(false)
        }
      }
      const secretsPost = async (path, payload, okMsg) => {
        setSecretsBusy(true)
        try {
          const result = await api(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!result.ok) setError(String((result.body && result.body.error) || path + ' 失败'))
          else {
            setError('')
            // 0.3.2 ②：vault-set 的成功响应带弱形状警告 → 黄条回显（不阻断，强度是人的决定）
            setSecretsWarn(path === '/vault-set' && Array.isArray(result.body.warn) ? result.body.warn : [])
            void loadSecrets()
          }
          return result.ok
        } catch (err) {
          setError(path + ' 失败：' + String(err && err.message ? err.message : err))
          return false
        } finally {
          setSecretsBusy(false)
        }
      }

      // 0.3.2：点键名复制**引用形态**（{{v:键}} / {{m:名}}），粘给 AI 或写命令直接用
      const copyRef = (text) => {
        writeClipboard(text, () => {
          setCopiedKey(text)
          setTimeout(() => { setCopiedKey('') }, 1400)
        }, (msg) => setError('复制失败：' + msg))
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
       * 人机互斥上报：解锁 = 告诉宿主「人正在操作这根终端」，上锁/切走 = 解除。
       * 宿主据此把 AI 的**写**（shell_send / shell_run 的发送）挡在门外，避免人机混合输入。
       *
       * 口径（与宿主 userBusy 的注释一致）：
       *   · 只针对**当前前台显示的这个 shell**，其它 shell 不受影响；
       *   · 切走的 shell 自动上锁（这里随之解除），切过来的新 shell 默认也是锁着的；
       *   · 解锁后没有超时、不会自动释放 —— 只有人自己上锁才算结束。
       *
       * 上报失败必须让用户看得见：如果 /busy 没生效，AI 根本不会被拦（危险方向）。
       * 404/405 = 宿主还是旧代码，这种端点是重启才生效的，理由要直接说清楚（参照改名的做法）。
       */
      const setUserBusy = (name, active) => {
        if (name === '') return
        void api('/busy', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: name, active }),
        }).then((result) => {
          if (result.ok) return
          if (result.status === 404 || result.status === 405) {
            setError('人机互斥需要重启 dsh web：/plugins/shell/busy 是新端点，宿主代码改动必须重启才生效')
          } else {
            setError('人机互斥状态上报失败（HTTP ' + String(result.status) + '）：AI 写暂停可能未生效')
          }
        }).catch(() => { /* 网络失败不阻断输入 */ })
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
        setUserBusy(currentName, false)   // 失焦即上锁：人的操作随之结束
      }

      /**
       * 面板内点击：**点开着的浮层以外的地方就关掉所有浮层**。
       *
       * 两条边界（都是明确要求）：
       *   · 点在浮层内部 → 不关（浮层里的交互各自处理，比如切 shell / 撤销 / 展开卡片）；
       *   · 点在头部按钮条 → 不关（头部按钮自己管开合与互斥；若这里也关，会把刚点开的菜单立刻关掉）；
       *   · 点在**面板之外**（DSH 页面其它地方）→ 事件根本不会到这里，所以不会误关。
       */
      const onPanelClick = (event) => {
        const target = event.target
        if (target === null || target === undefined || typeof target.closest !== 'function') return
        if (target.closest('.dshsh-picker,.dshsh-info,.dshsh-cmenu,.dshsh-head')) return
        closeAllMenus()
      }

      const toggleLock = async () => {
        const next = !locked
        setLocked(next)
        // 解锁 = 报告宿主「人正在操作这根终端」；上锁 = 解除（AI 的写恢复可用）
        setUserBusy(currentName, !next)
        if (next) { setError(''); return }
        await Promise.resolve()
        if (inputRef.current !== null) inputRef.current.focus()
      }

      // ── 切 shell / 改名的「人机互斥」兜底 ───────────────────────────────────
      // 口径：切走的 shell 自动上锁（busy 解除），切过来的新 shell 默认也是锁着的。
      // 统一收在这里处理，比 selectShell / switchBy / submitRename 各写一份更不容易漏。
      // submitRename 是例外：改名只是同一根终端换了个名字，「人正在操作」要跟着搬过去，
      // 不能当作「切走」把 busy 清掉（那是危险方向——人还在操作，AI 却以为可以插进来）。
      const prevNameRef = react.useRef('')
      const renamedFromRef = react.useRef(null)
      react.useEffect(() => {
        const prev = prevNameRef.current
        prevNameRef.current = currentName
        if (prev === currentName) return
        if (renamedFromRef.current === prev) {
          renamedFromRef.current = null
          // 保持当前 locked：改名前后的操作状态不该被这次改名打断
          if (!locked) setUserBusy(currentName, true)
          return
        }
        if (prev !== '') setUserBusy(prev, false)   // 切走的 shell：自动上锁 + 解除「人在操作」
        setLocked(true)                              // 切过来的新 shell：默认也是锁着的
      }, [currentName, locked])

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
        // 与「当前名字去掉前缀」比较：改成失焦即提交之后，什么都没改也会走到这里，别白跑一次请求
        const bare = from.startsWith('dsh-') ? from.slice(4) : from
        if (newName === '' || newName === bare || newName === from) { setNotice(''); return }
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
          renamedFromRef.current = from   // 改名：人机互斥要跟着新名字走（见切 shell 兜底 effect）
          setSelected(String(result.body.name))
          // 净化改写了你输入的名字时必须**说出来**：静默换成别的名字比报错更难发现
          // （实测：输入「测试abc」曾被悄悄改成 dsh-abc，而接口照样返回 200 ok）
          setNotice(result.body.altered === true
            ? `已改名为 ${String(result.body.name)} —— 你输入的名字里有不允许的字符，已折叠成连字符`
            : '')
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

      /** 本部署配置的 shell 名（服务端上报优先；旧宿主没有这个字段时退回 bash）。 */
      const shellNameOf = () => (server !== null && typeof server.shell === 'string' && server.shell !== ''
        ? server.shell
        : 'bash')

      // 忙闲判定统一走 sessionBusy（见文件顶部），避免两处逻辑漂移
      const dotColor = (session) => {
        if (session === null) return 'var(--dsw-alias-label-tertiary)'
        return sessionBusy(session, shellNameOf()) ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-success-primary)'
      }

      const selectShell = (name) => {
        setSelected(name)
        setPickerOpen(false)
        setConsentMenuOpen(false)
        setInfoOpen(false)
      }

      // ── 三个浮层（shell 下拉 / 详情 / 授权）互斥：任何时候只开一个 ──────────
      // 每次打开都要把另外两个关掉；自己若已开则关闭（toggle）。面板收起时全部复位。
      const closeAllMenus = () => {
        setPickerOpen(false)
        setConsentMenuOpen(false)
        setInfoOpen(false)
      }
      const toggleMenu = (which) => {
        const open = which === 'picker' ? pickerOpen : (which === 'consent' ? consentMenuOpen : infoOpen)
        closeAllMenus()
        if (!open) {
          if (which === 'picker') setPickerOpen(true)
          if (which === 'consent') setConsentMenuOpen(true)
          if (which === 'info') setInfoOpen(true)
        }
      }

      // 下拉行显示名：优先用户起的 label（存于 @dsh-label），没有才退回稳定 id
      const rowDisplayName = (session) => {
        const label = typeof session?.label === 'string' && session.label.trim() !== '' ? session.label.trim() : ''
        if (label !== '') return label
        const id = String(session?.name ?? '')
        return id.startsWith('dsh-') ? id.slice(4) : id
      }
      // 创建它的会话（owner）：宿主下发 ownerName（DSH 左侧列表里的会话标题 / 「面板」），
      // 拿不到才退回 owner 字段；未知写「未知」。
      const rowOwnerText = (session) => {
        const name = typeof session?.ownerName === 'string' && session.ownerName.trim() !== '' ? session.ownerName.trim() : ''
        if (name !== '') return name
        const owner = typeof session?.owner === 'string' && session.owner.trim() !== '' ? session.owner.trim() : ''
        if (owner === '' || owner === 'unknown') return '未知'
        return owner
      }

      // 会话单元格（两排：名字+创建者 / id+尺寸+前台+字节）：**触发器与下拉行共用同一个**
      // 渲染函数与同一套类 —— 表头与表内不一致的问题就从根上消失了。
      const sessionCell = (session, prefix, extraSub) => h('span', { key: prefix + 'cell', className: 'dshsh-cell' }, [
        h('span', { key: prefix + 'top', className: 'dshsh-row-top' }, [
          h('span', { key: prefix + 'n', className: 'dshsh-row-name', title: rowDisplayName(session) }, rowDisplayName(session)),
          h('span', {
            key: prefix + 'ow',
            className: 'dshsh-row-owner',
            // 截断后要能看全：悬停提示给完整名字
            title: '创建这个 shell 的会话：' + rowOwnerText(session),
          }, '创建者：' + rowOwnerText(session)),
        ]),
        h('span', { key: prefix + 'sub', className: 'dshsh-row-sub' }, [
          h('span', { key: prefix + 'id', className: 'dshsh-row-id' }, session.name),
          h('span', { key: prefix + 'm', className: 'dshsh-row-meta' },
            String(session.cols) + '×' + String(session.rows) + ' · ' + (session.foreground || '?') +
            ' · ' + fmtBytes(session.historyBytes)),
          extraSub === null || extraSub === undefined ? null : extraSub,
        ]),
      ])

      // ── 折叠态：可拖动的悬浮胶囊 ──────────────────────────────────────────
      if (!expanded) {
        const pill = pillModel({ sessions, currentName, locked, shellName: shellNameOf() })
        const tone = {
          idle: 'var(--dsw-alias-state-success-primary)',
          busy: 'var(--dsw-alias-state-warn-primary)',
          none: 'var(--dsw-alias-label-tertiary)',
        }[pill.dotTone]
        return h('button', {
          key: 'pill',
          type: 'button',
          className: 'dshsh-pill' + (pill.busy ? ' busy' : ''),
          'aria-label': (pill.empty ? '后台 shell' : pill.fullName + (pill.counter === '' ? '' : '，第 ' + pill.counter))
            + (pill.busy ? '，有命令在运行' : '，空闲')
            + (locked ? '，输入已锁定' : '，输入已解锁')
            + '。点击展开面板，按住可拖动。',
          'aria-expanded': false,
          style: {
            ...S.pill,
            left: pos.x + 'px',
            top: pos.y + 'px',
            cursor: dragging ? 'grabbing' : 'grab',
          },
          title: pill.title,
          ...dragHandlers,
          onClick: () => {
            if (suppressClickRef.current) return
            setExpanded(true)
          },
        }, [
          // 拖动把手放最左：与面板标题栏的抓取点位置一致，右手拇指也更容易按到
          h('span', { key: 'grip', className: 'dshsh-grip' }, h(Icon, { name: 'grip', size: 14 })),
          // 状态点：一眼看出当前 shell 在不在跑东西
          h('span', { key: 'dot', className: 'dshsh-pill-dot', style: { background: tone } }),
          h('span', { key: 'i', className: 'dshsh-pill-mark' }, '>_'),
          h('span', { key: 'n', className: 'dshsh-pill-name' }, pill.label),
          pill.counter === '' ? null : h('span', { key: 'c', className: 'dshsh-count' }, pill.counter),
          h('span', {
            key: 'l',
            className: 'dshsh-pill-lock',
            // 锁定 = 安全默认，安静显示；解锁才需要注意（颜色语义修正）
            style: { color: pill.lockTone === 'warn' ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-tertiary)' },
          }, h(Icon, { name: locked ? 'lock' : 'unlock', size: 13 })),
        ].filter(Boolean))
      }

      // ── 展开态：锚定在胶囊位置（夹进视口），标题栏也可拖 ──────────────────
      const position = current === null ? 0 : sessions.findIndex((s) => s.name === currentName) + 1

      // 授权状态来自 /list 的 server.consent（面板本来就在轮询，不必额外请求）
      const consentModel = consentButtonModel(server === null ? null : server.consent)

      const head = h('div', {
        key: 'head',
        className: 'dshsh-head' + (headCompact(panelRect.w) ? ' dshsh-compact' : ''),
        style: { ...S.head, cursor: dragging ? 'grabbing' : 'grab' },
        ...panelDragHandlers,
      }, [
        // 名字＝下拉（多 shell 切换的唯一入口：左右箭头语义不明，弃用）
        // 显示内容与下拉菜单的行一致：名字 + 创建者 + 稳定 id（紧凑两排）
        h('button', {
          key: 'name',
          type: 'button',
          className: 'dshsh-name',
          onClick: () => toggleMenu('picker'),
          title: sessions.length > 1 ? '点击选择 shell（共 ' + String(sessions.length) + ' 个）' : '新建 shell 后在这里切换',
        }, [
          h('span', { key: 'dot', className: 'dshsh-dot' + (justIdle ? ' done' : ''), style: { background: dotColor(current) } }),
          current === null
            ? h('span', { key: 'cell', className: 'dshsh-name-cell' }, [
                // 无 shell 也保持两排结构：高度与有 shell 时一致，父容器不会被「有/无」撑得跳来跳去
                h('span', { key: 'top', className: 'dshsh-name-top' }, [
                  h('span', { key: 'n', className: 'dshsh-name-label' }, '(无 shell)'),
                ]),
                h('span', { key: 'sub', className: 'dshsh-name-sub' }, [
                  h('span', { key: 'hint' }, '点 ＋ 新建'),
                ]),
              ])
            : sessionCell(current, 'h-'),
          h(Icon, { key: 'c', name: 'down', size: 13 }),
        ]),
        // 锁与新建：紧随下拉（都在左侧叙事里，锁=输入态、新建=扩展）
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
        h('span', { key: 'count', className: 'dshsh-count' },
          sessions.length === 0 ? '0 / 0' : String(position) + ' / ' + String(sessions.length)),
        h('span', { key: 'sp', className: 'dshsh-spacer' },
          // 解锁 = 人正在操作：AI 的写已被宿主暂停。放在头部中间这片空白里居中显示，
          // **不碰 🔒 按钮**（按钮承担「锁定状态」的语义，加东西会搅乱它）。
          locked || currentName === ''
            ? null
            : h('span', { key: 'busybar', className: 'dshsh-busybar' }, '🤖 AI 写操作已暂停 · 你正在操作这台终端')),
        h('button', {
          key: 'consent',
          type: 'button',
          className: consentModel.className,
          onClick: () => {
            // 点开授权浮层：档位（完全控制 / 只读 / 完全禁止）× 时间（10 分钟 … 永久 / 自定义）
            // + 已授权会话列表。撤销在浮层里逐条做，比"点两下就全撤"更可控。
            toggleMenu('consent')
            if (consentArmTimer.current !== null) { clearTimeout(consentArmTimer.current); consentArmTimer.current = null }
            setConsentArmed(false)
          },
          disabled: consentBusy || !consentModel.enabled,
          title: consentModel.title + ' · ' + consentSummaryText(server === null ? null : server.consent?.wildcard),
          'aria-label': consentModel.label,
        }, h(Icon, { name: consentModel.icon, size: 14 })),
        h('button', {
          key: 'info',
          type: 'button',
          className: 'dshsh-btn' + (infoOpen ? ' on' : ''),
          onClick: () => toggleMenu('info'),
          title: '详情：会话/缓冲/服务端/看门狗/审批/版本/键位表',
        }, h(Icon, { name: 'info', size: 14 })),
        h('button', {
          key: 'hide',
          type: 'button',
          className: 'dshsh-btn',
          // 收起时顺手复位：别把"没执行的关闭意图"留在按钮上；人的操作也一并结束（人机互斥解除）
          onClick: () => { setLocked(true); setUserBusy(currentName, false); closeAllMenus(); setCloseArmed(false); setExpanded(false) },
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
                  placeholder: '名字（可用中文）',
                  onChange: (event) => { setRenameDraft(event.target.value); setNotice('') },
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') { event.preventDefault(); void submitRename(session.name) }
                    if (event.key === 'Escape') { event.preventDefault(); setRenaming(''); setNotice('') }
                  },
                  // 失焦 = 提交（与主流内联改名一致），**不是**取消。
                  // 原来这里写的是 setRenaming('')，于是"输完名字顺手点一下别处"就把改动静默丢掉了 ——
                  // 用户看到的就是"改了不生效"，而且没有任何提示。要取消请用 Esc。
                  onBlur: () => { void submitRename(session.name) },
                  title: '回车或点击别处确认 · Esc 取消（会自动加上 dsh- 前缀；中文可用，空格与符号会折成连字符）',
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
              title: '切到「' + rowDisplayName(session) + '」（' + session.name + '）',
            }, [
              h('span', { key: 'd', className: 'dshsh-dot', style: { background: dotColor(session) } }),
              sessionCell(session, 'r-'),
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
          ? h('div', { key: 'empty', style: { padding: '10px 8px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' } }, '还没有 shell')
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
      }, [
        h('span', { key: 'text', className: 'dshsh-screen-text' }, screen === '' ? '(无输出)' : screen),
        // 隐藏样本：横向实测失败时用于估算单元格宽度
        h('span', {
          key: 'measure', ref: measureRef, 'aria-hidden': 'true',
          style: { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre', pointerEvents: 'none' },
        }, 'M'.repeat(40)),
        caret === null ? null : h('span', { key: 'caret', className: 'dshsh-caret', 'aria-hidden': 'true', style: caret.style }),
      ])

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
      // 卡片归属 + 折叠状态（方案 A）：7 个逻辑分组 → 4 张卡
      const infoCardsBuilt = INFO_CARD_ORDER.map((card) => ({
        card,
        sections: infoSections.filter((section) => (INFO_CARD_OF[section.group] ?? '关于') === card),
      })).filter((entry) => entry.sections.length > 0)
      const cardOpen = (card) => (infoCards[card] === undefined ? INFO_CARD_DEFAULT_OPEN[card] === true : infoCards[card] === true)
      const toggleCard = (card) => setInfoCards((prev) => ({ ...prev, [card]: !(prev[card] === undefined ? INFO_CARD_DEFAULT_OPEN[card] === true : prev[card] === true) }))
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
        // 最要紧的一条（没有官方审批）提到最上面，而不是埋在卡片里
        h('div', { key: 'alert', className: 'dshsh-info-alert' }, [
          h('span', { key: 'i' }, '⚠'),
          h('span', { key: 't' }, [
            h('b', { key: 'b' }, '没有官方审批：'),
            '模型的命令会直接执行，不会弹「允许 / 拒绝」。护栏只是启发式减速带，不是沙箱。',
          ]),
        ]),
        // 4 张可折叠卡片：标题行可点，右侧显示"组数/行数"
        ...infoCardsBuilt.map(({ card, sections }) => {
          const open = cardOpen(card)
          const rowCount = sections.reduce((sum, section) => sum + section.rows.length, 0)
          return h('div', { key: 'card-' + card, className: 'dshsh-card' + (open ? ' open' : '') }, [
            h('button', {
              key: 'h',
              type: 'button',
              className: 'dshsh-card-h',
              onClick: () => toggleCard(card),
              'aria-expanded': open,
              title: open ? '收起「' + card + '」' : '展开「' + card + '」（' + String(rowCount) + ' 项）',
            }, [
              h(Icon, { key: 'c', name: open ? 'down' : 'right', size: 12 }),
              h('span', { key: 'n', className: 'dshsh-card-name' }, card),
              h('span', { key: 's', className: 'dshsh-card-sub' }, String(rowCount) + ' 项'),
            ]),
            open
              ? h('div', { key: 'b', className: 'dshsh-card-body' }, sections.flatMap((section) => [
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
                ]))
              : null,
          ])
        }),
      ]) : null

      // ── 状态行（方案 B：永远一行）──────────────────────────────────────────
      //
      // 只放「一眼要看」的：状态点、名字、尺寸、前台、缓冲、已用字节、审批徽章，
      // 右侧是操作按钮。其余（接入/取景/cwd/版本/服务端/看门狗/键位表）全部进 ⓘ ——
      // 之前 13 项平级混装会折成 2–3 行，折行位置还随名字长度变化。
      // 忙闲判定复用 sessionBusy（与胶囊、选择器一致）
      const running = sessionBusy(meta, shellNameOf())
      const stats = h('div', { key: 'stats', style: S.stats }, [
        h('span', { key: 'dot', className: 'dshsh-dot', style: { background: dotColor(current) }, title: running ? '有进程在前台运行' : '停在提示符（空闲）' }),
        h('span', { key: 'n', style: { color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
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

      // ── 授权浮层：档位 × 时间 + 按对话授权 + 已授权会话列表 ────────────────
      // 数据来自 /list 的 server.consent（面板本来就在轮询，不必再开轮询）。
      const consentInfo = server === null ? null : server.consent
      const consentCatalog = consentInfo?.catalogs ?? null
      const consentRows = consentEntryRows(consentInfo?.entries, Date.now())
      const scopeKeys = Array.isArray(consentCatalog?.scopes) && consentCatalog.scopes.length > 0
        ? consentCatalog.scopes : ['full', 'read', 'deny']
      const ttlLevels = Array.isArray(consentCatalog?.timeLevels) && consentCatalog.timeLevels.length > 0
        ? consentCatalog.timeLevels : CONSENT_TTL_FALLBACK
      const seg = (key, label, active, onClick) => h('button', {
        key,
        type: 'button',
        className: 'dshsh-cmenu-seg-btn' + (active ? ' on' : ''),
        onClick,
        disabled: consentBusy,
      }, label)
      // 选中某个对话后的「档位 × 有效期 × 授予」控件 —— 目录点选与「手工填 id」两条路共用。
      // （手工填 id 的入口在宿主没有对话目录时才出现；两种来源都会走到同一块。）
      const actorPickBlock = actorPick !== null ? h('div', { key: 'pick', className: 'dshsh-actor-pick' }, [
        h('div', { key: 'who', className: 'dshsh-cmenu-sub' }, '授予：' + (actorPick.title || actorPick.id)),
        h('div', { key: 'scopes', className: 'dshsh-cmenu-seg' }, scopeKeys.map((key) => seg(
          'a-' + key, CONSENT_SCOPE_LABELS[key] ?? key, actorScope === key, () => setActorScope(key)))),
        h('div', { key: 'ttls', className: 'dshsh-cmenu-seg' }, ttlLevels.map((level) => seg(
          'at-' + level.key, level.label, actorTtl === level.key, () => setActorTtl(level.key)))),
        h('div', { key: 'row', className: 'dshsh-cmenu-actions' }, [
          h('button', {
            key: 'go2',
            type: 'button',
            className: 'dshsh-cmenu-go',
            disabled: consentBusy,
            onClick: () => {
              void postConsent('set', { actor: actorPick.id, scope: actorScope, ttlSeconds: consentTtlSeconds(actorTtl, customMinutes) })
              setActorPick(null)
            },
            title: '给这个对话单独授权（不影响其它对话）',
          }, '授予这个对话'),
          h('button', {
            key: 'drop2',
            type: 'button',
            className: 'dshsh-cmenu-clear',
            disabled: consentBusy,
            onClick: () => setActorPick(null),
          }, '取消'),
        ]),
      ]) : null
      const chip = consentStatusChip(consentInfo === null ? null : consentInfo.wildcard ?? null)
      const customMinutesRow = (value, setValue) => h('div', { key: 'custom', className: 'dshsh-cmenu-row' }, [
        h('span', { key: 'l' }, '分钟数'),
        h('input', {
          key: 'in', type: 'number', min: 1, max: 43200, className: 'dshsh-cmenu-in',
          value, onChange: (event) => setValue(event.target.value),
        }),
        h('span', { key: 'hint', className: 'dshsh-cmenu-sub' }, '1 分钟 – 30 天'),
      ])
      // 档位卡片（每个都要讲清后果，不是只给个名字 —— 成熟授权界面的共同点）
      // 档位选择行 —— 官方设置页的字段列表语言：整行「名称 + 后果」两行结构，右侧单选圆点，行间细线
      const scopeCards = (prefix, value, setValue) => scopeKeys.map((key) => h('button', {
        key: prefix + key,
        type: 'button',
        className: 'dshsh-opt' + (value === key ? ' on' : ''),
        onClick: () => setValue(key),
        disabled: consentBusy,
        title: CONSENT_SCOPE_HINTS[key] ?? '',
      }, [
        h('span', { key: 'm', className: 'dshsh-opt-main' }, [
          h('span', { key: 't', className: 'dshsh-opt-label' }, CONSENT_SCOPE_LABELS[key] ?? key),
          h('span', { key: 'h', className: 'dshsh-opt-hint' }, CONSENT_SCOPE_HINTS[key] ?? ''),
        ]),
        h('span', { key: 'r', className: 'dshsh-opt-radio' }),
      ]))
      // ── 0.3.0「引用库」本体：vault（人写，AI 只引用键名）/ macros（人+AI，写入全入封链）──
      const secretsBody = h('div', { key: 'secrets', className: 'dshsh-cmenu-body' }, [
        h('div', { key: 'stabs', className: 'dshsh-cmenu-seg' }, [
          seg('sec-v', '秘密域', secretsTab === 'vault', () => { setSecretsTab('vault'); void loadSecrets() }),
          seg('sec-m', '宏命令', secretsTab === 'macros', () => { setSecretsTab('macros'); void loadSecrets() }),
        ]),
        secretsData === null
          ? h('div', { key: 'ld', className: 'dshsh-cmenu-sub' }, '正在读取…')
          : secretsTab === 'vault' ? [
              h('div', { key: 'vn', className: 'dshsh-cmenu-sub' },
                '值只存宿主 vault.json（0600）；AI 只能引用 {{v:键名}}，且只许整条裸引用喂密码提示（echo/管道形态被拒，防转换外泄）。一次性 = 送出即焚。边界：output/ 留痕是原始字节流（见 SECURITY）。'),
              secretsData.vaultCorrupt !== '' ? h('div', {
                key: 'vc', className: 'dshsh-cmenu-sub',
                style: { color: 'var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-button-ghost-active-fill)', borderRadius: '8px', padding: '6px 10px', lineHeight: '1.5' },
              }, '⚠ ' + secretsData.vaultCorrupt) : null,
              secretsWarn.length > 0 ? h('div', {
                key: 'w', className: 'dshsh-cmenu-sub',
                style: { color: 'var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-button-ghost-active-fill)', borderRadius: '8px', padding: '6px 10px', lineHeight: '1.5' },
              }, '弱形状提醒（已保存，是否更换由你定）：' + secretsWarn.join('；')) : null,
              h('div', { key: 'vh', className: 'dshsh-cmenu-h' }, '新增秘密'),
              h('div', { key: 'vf1', className: 'dshsh-cmenu-row' }, [
                h('input', { key: 'k', type: 'text', className: 'dshsh-cmenu-in', placeholder: '键名（字母数字._-）', value: vKey, onChange: (e) => setVKey(e.target.value) }),
                h('input', { key: 'v', type: 'password', className: 'dshsh-cmenu-in', placeholder: '值（只存宿主，不给 AI）', value: vVal, onChange: (e) => setVVal(e.target.value) }),
              ]),
              h('div', { key: 'vf2', className: 'dshsh-cmenu-row' }, [
                h('label', { key: 'o', className: 'dshsh-cmenu-sub' }, [
                  h('input', { key: 'oc', type: 'checkbox', checked: vOne, onChange: (e) => setVOne(e.target.checked) }),
                  ' 一次性',
                ]),
                h('label', { key: 'tl', className: 'dshsh-cmenu-sub' }, [
                  h('input', { key: 'tc', type: 'number', min: '0', max: '3650', className: 'dshsh-cmenu-in', style: { width: '56px' }, value: vTtl, onChange: (e) => setVTtl(e.target.value), title: '连续 N 天没有被使用即自动焚毁（10 分钟粒度扫描，记审计 expire）；留空 = 永不过期' }),
                  ' TTL 天（未用自动焚，空=不过期）',
                ]),
                h('input', { key: 'n', type: 'text', className: 'dshsh-cmenu-in', placeholder: '备注（可选）', value: vNote, onChange: (e) => setVNote(e.target.value) }),
              ]),
              h('div', { key: 'va', className: 'dshsh-cmenu-actions' }, [
                h('button', {
                  key: 'go', type: 'button', className: 'dshsh-cmenu-go',
                  disabled: secretsBusy || vKey.trim() === '' || vVal === '',
                  onClick: () => {
                    const ttlN = Number(vTtl)
                    void secretsPost('/vault-set', {
                      key: vKey.trim(), value: vVal, oneShot: vOne, note: vNote.trim(),
                      ttlDays: Number.isFinite(ttlN) && ttlN > 0 ? Math.floor(ttlN) : 0,
                    }).then((ok) => { if (ok) { setVKey(''); setVVal(''); setVNote(''); setVTtl(''); setVOne(false); setSecretsWarn([]) } })
                  },
                }, '保存秘密'),
                secretsWarn.length > 0 ? h('button', {
                  key: 'dw', type: 'button', className: 'dshsh-cmenu-clear',
                  onClick: () => setSecretsWarn([]),
                }, '知道了') : null,
              ]),
              h('div', { key: 'lh', className: 'dshsh-cmenu-h' }, '现有秘密（' + secretsData.vault.length + '）'),
              ...(secretsData.vault.length === 0
                ? [h('div', { key: 've', className: 'dshsh-cmenu-sub' }, '（还没有键）')]
                : [h('table', { key: 'vt', className: 'dshsh-stable' }, [
                    h('thead', { key: 'h' }, h('tr', {}, [
                      h('th', { key: 'a', style: { width: '32%' }, title: '点键名即复制引用形态 {{v:键名}}，可直接粘进给 AI 的指令；值永远不可复制/不可见' }, '键名'),
                      h('th', { key: 'b', style: { width: '15%' }, title: '一次性 = 送出即焚（护栏通过后落刀）；可重复 = 不限次引用' }, '类型'),
                      h('th', { key: 'c', style: { width: '8%' }, title: '成功送出（注入）的次数' }, '次'),
                      h('th', { key: 'd', style: { width: '8%' }, title: 'TTL = 存活天数：连续 N 天没有被使用（引用注入或更新）即自动焚毁，10 分钟扫描粒度，烧掉记审计 expire 事件；— = 永不过期。设置入口在上方「新增秘密」的 TTL 输入框' }, 'TTL'),
                      h('th', { key: 'e', style: { width: '20%' }, title: '给人看的备注（AI 侧列表也可见）' }, '备注'),
                      h('th', { key: 'f', style: { width: '17%' }, title: '删除后引用处会明确报「没有该键」' }, '操作'),
                    ])),
                    h('tbody', {}, secretsData.vault.map((item) => h('tr', { key: 'vr-' + item.key }, [
                      h('td', { key: 'k', className: 'k' }, h('span', {
                        style: { cursor: 'pointer' }, title: '点击复制 {{v:' + item.key + '}}',
                        onClick: () => copyRef('{{v:' + item.key + '}}'),
                      }, item.key + '  ' + (copiedKey === '{{v:' + item.key + '}}' ? '✓ 已复制' : '⧉'))),
                      h('td', { key: 'o' }, item.oneShot ? '一次性' : '可重复'),
                      h('td', { key: 'u' }, String(item.uses)),
                      h('td', { key: 't' }, Number(item.ttlDays) > 0 ? item.ttlDays + 'd' : '—'),
                      h('td', { key: 'n', className: 'sub' }, item.note || '—'),
                      h('td', { key: 'a' }, h('button', {
                        type: 'button', className: 'dshsh-cmenu-clear', disabled: secretsBusy,
                        style: { height: '22px', padding: '0 8px', fontSize: '11px' },
                        onClick: () => void secretsPost('/vault-rm', { key: item.key }),
                        title: '删除该键（引用处会明确报「没有该键」）',
                      }, '删除')),
                    ]))),
                  ])]),
              secretsExtra !== null && secretsExtra.history.length > 0 ? [
                h('div', { key: 'hh', className: 'dshsh-cmenu-h' }, '最近键事件（只显示键名与引用原文，值永不显示）'),
                h('table', { key: 'ht', className: 'dshsh-stable' },
                  h('tbody', {}, secretsExtra.history.slice(0, 12).map((ev) => h('tr', { key: 'he-' + ev.ts + '-' + (ev.key || ev.detail) }, [
                    h('td', { key: 't', className: 'sub', style: { whiteSpace: 'nowrap', width: '96px', fontVariantNumeric: 'tabular-nums' } },
                      new Date(ev.ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })),
                    h('td', { key: 'd', style: { width: '29%' } },
                      ({ consume: '送出即焚', set: '录入/更新', rm: '删除', expire: 'TTL 过期', ref: '被引用', refused: '引用被拒', 'ref-error': '引用被拒', 'user-busy': '让位于人', released: '已交还拒写' }[String(ev.kind).replace('ref-', '')] ?? ev.kind)
                      + (ev.key !== '' ? ' · ' + ev.key : '')),
                    h('td', { key: 'w', className: 'sub', style: { width: '27%' } },
                      (ev.shell !== '' ? '@' + String(ev.shell).replace(/^dsh-/, '') : '全局')
                      + ' · ' + (ev.source === 'panel' ? '面板' : ev.source === 'auto' ? '自动' : 'AI')
                      + (ev.actor !== '' && ev.actor !== 'panel' && ev.actor !== 'sweeper' ? '(' + ev.actor + ')' : '')),
                    h('td', { key: 'x', className: 'sub' }, String(ev.detail || '').slice(0, 60) || '—'),
                  ])))),
              ] : null,
              secretsExtra !== null && secretsExtra.chain !== null ? h('div', { key: 'cc', className: 'dshsh-cmenu-row' }, [
                h('span', { key: 'l', className: 'dshsh-cmenu-sub' }, '审计链：' + (secretsExtra.chain.ok === true
                  ? '✓ ' + secretsExtra.chain.sealed + ' 条封链 · 留痕 ' + secretsExtra.chain.transcripts + ' 份'
                  : secretsExtra.chain.ok === false ? '⚠ 断链于第 ' + ((secretsExtra.chain.brokenAt?.index ?? 0) + 1) + ' 条' : '未启用')),
                h('button', {
                  key: 'r', type: 'button', className: 'dshsh-cmenu-clear', disabled: secretsBusy,
                  onClick: () => void loadSecrets(),
                  title: '重新复验整条哈希链（新鲜计算）',
                }, '复验'),
              ]) : null,
            ] : [
              h('div', { key: 'mn', className: 'dshsh-cmenu-sub' },
                '宏 = 可复用命令片段，人与 AI 都可写，写入动作全量进审计封链（防偷渡）。可嵌 {{v:键名}}（发送时才展开），不可嵌宏；AI 引用写 {{m:名字}}。'),
              secretsData.macrosCorrupt !== '' ? h('div', {
                key: 'mc', className: 'dshsh-cmenu-sub',
                style: { color: 'var(--dsw-alias-state-warn-primary)', background: 'var(--dsw-alias-button-ghost-active-fill)', borderRadius: '8px', padding: '6px 10px', lineHeight: '1.5' },
              }, '⚠ ' + secretsData.macrosCorrupt) : null,
              h('div', { key: 'mh', className: 'dshsh-cmenu-h' }, '新增宏'),
              h('div', { key: 'mf1', className: 'dshsh-cmenu-row' }, [
                h('input', { key: 'n', type: 'text', className: 'dshsh-cmenu-in', placeholder: '宏名（字母数字._-）', value: mName, onChange: (e) => setMName(e.target.value) }),
                h('select', { key: 's', className: 'dshsh-cmenu-in', value: mScope, onChange: (e) => setMScope(e.target.value) }, [
                  h('option', { key: 'g', value: 'global' }, 'global（所有对话）'),
                  h('option', { key: 'c', value: 'conversation' }, 'conversation（仅本对话）'),
                ]),
              ]),
              h('textarea', { key: 't', className: 'dshsh-cmenu-in', rows: 3, style: { width: '100%', boxSizing: 'border-box' }, placeholder: '内容（可含换行；可嵌 {{v:键名}}）', value: mText, onChange: (e) => setMText(e.target.value) }),
              h('div', { key: 'mf2', className: 'dshsh-cmenu-row' }, [
                h('label', { key: 'sb', className: 'dshsh-cmenu-sub' }, [
                  h('input', { key: 'sc', type: 'checkbox', checked: mSubmit, onChange: (e) => setMSubmit(e.target.checked) }),
                  ' submit（末尾自动 Enter）',
                ]),
                h('input', { key: 'nt', type: 'text', className: 'dshsh-cmenu-in', placeholder: '备注（可选）', value: mNote, onChange: (e) => setMNote(e.target.value) }),
              ]),
              h('div', { key: 'ma', className: 'dshsh-cmenu-actions' }, [
                h('button', {
                  key: 'go', type: 'button', className: 'dshsh-cmenu-go',
                  disabled: secretsBusy || mName.trim() === '' || mText.trim() === '',
                  onClick: () => { void secretsPost('/macro-set', { name: mName.trim(), text: mText, scope: mScope, submit: mSubmit, note: mNote.trim() }).then((ok) => { if (ok) { setMName(''); setMText(''); setMNote('') } }) },
                }, '保存宏'),
              ]),
              h('div', { key: 'lmh', className: 'dshsh-cmenu-h' }, '现有宏（' + secretsData.macros.length + '）'),
              ...(secretsData.macros.length === 0
                ? [h('div', { key: 'me', className: 'dshsh-cmenu-sub' }, '（还没有宏）')]
                : [h('table', { key: 'mt', className: 'dshsh-stable' }, [
                    h('thead', { key: 'h' }, h('tr', {}, [
                      h('th', { key: 'a', style: { width: '22%' }, title: '点宏名即复制引用形态 {{m:宏名}}' }, '宏名'),
                      h('th', { key: 'b', style: { width: '13%' }, title: 'global=所有对话可用；conversation=仅归属对话；「·不提交」= 引用时只填输入行不自动按 Enter（此类宏禁止嵌 {{v:}} 秘密）' }, '域'),
                      h('th', { key: 'c', style: { width: '50%' }, title: '发送时才展开成真实命令；可嵌 {{v:键名}}；换行整体走粘贴通道' }, '内容'),
                      h('th', { key: 'd', style: { width: '15%' }, title: '删除会记入审计封链' }, '操作'),
                    ])),
                    h('tbody', {}, secretsData.macros.map((item) => h('tr', { key: 'mr-' + item.name }, [
                      h('td', { key: 'k', className: 'k' }, h('span', {
                        style: { cursor: 'pointer' }, title: '点击复制 {{m:' + item.name + '}}',
                        onClick: () => copyRef('{{m:' + item.name + '}}'),
                      }, item.name + '  ' + (copiedKey === '{{m:' + item.name + '}}' ? '✓ 已复制' : '⧉'))),
                      h('td', { key: 's', className: 'sub' }, item.scope + (item.submit ? '' : '·不提交')),
                      h('td', { key: 'x', className: 'sub' }, String(item.text).replace(/\n/g, '⏎').slice(0, 70)),
                      h('td', { key: 'a' }, h('button', {
                        type: 'button', className: 'dshsh-cmenu-clear', disabled: secretsBusy,
                        style: { height: '22px', padding: '0 8px', fontSize: '11px' },
                        onClick: () => void secretsPost('/macro-rm', { name: item.name }),
                      }, '删除')),
                    ]))),
                  ])]),
            ],
      ])
      // 下拉排序：与草稿顺序一致（actor 标签在前）
      const consentMenu = consentMenuOpen ? h('div', { key: 'cmenu', className: 'dshsh-cmenu' }, [
        // ── 头部：标题 + 当前全局档位徽标 ──────────────────────────────
        h('div', { key: 'bar', className: 'dshsh-cmenu-bar' }, [
          h('span', { key: 't', className: 'dshsh-cmenu-title' }, '授权管理'),
          h('span', { key: 'chip', className: 'dshsh-cmenu-chip ' + chip.tone }, chip.label),
        ]),
        // ── 页签：单个对话（最常用） / 所有对话（默认档） ───────────────
        h('div', { key: 'tabsbar', className: 'dshsh-cmenu-tabsbar' },
          h('div', { key: 'tabs', className: 'dshsh-cmenu-tabs' }, [
            h('button', {
              key: 'tab-a', type: 'button', className: 'dshsh-cmenu-tab' + (consentTab === 'actor' ? ' on' : ''),
              onClick: () => setConsentTab('actor'), disabled: consentBusy,
              title: '给指定会话单独授权（不影响其它对话）',
            }, '单对话授权'),
            h('button', {
              key: 'tab-g', type: 'button', className: 'dshsh-cmenu-tab' + (consentTab === 'global' ? ' on' : ''),
              onClick: () => setConsentTab('global'), disabled: consentBusy,
              title: '对所有对话生效的默认档位',
            }, '所有对话授权'),
            h('button', {
              key: 'tab-s', type: 'button', className: 'dshsh-cmenu-tab' + (consentTab === 'secrets' ? ' on' : ''),
              onClick: () => { setConsentTab('secrets'); void loadSecrets() },   // 0.3.1：每次进入都重拉（外部烧键/CLI 改动即时可见）
              disabled: consentBusy,
              title: '引用库：秘密域（人录入的 {{v:键}}，AI 只见键名）+ 宏命令（可复用片段 {{m:名}}，写入全入审计封链）',
            }, '引用库'),
          ]),
        ),
        consentTab === 'secrets'
          ? secretsBody
          : consentTab === 'global'
          ? h('div', { key: 'global', className: 'dshsh-cmenu-body' }, [
              h('div', { key: 'note', className: 'dshsh-cmenu-sub' },
                '对所有对话生效的默认档位；已单独授权的对话不受影响。'),
              ...scopeCards('g-', draftScope, setDraftScope),
              h('div', { key: 't2', className: 'dshsh-cmenu-h' }, '有效期'),
              h('div', { key: 'ttls', className: 'dshsh-cmenu-seg' }, ttlLevels.map((level) => seg(
                'ttl-' + level.key, level.label, draftTtl === level.key, () => setDraftTtl(level.key)))),
              draftTtl === 'custom' ? customMinutesRow(customMinutes, setCustomMinutes) : null,
              h('div', { key: 'apply', className: 'dshsh-cmenu-actions' }, [
                h('button', {
                  key: 'go', type: 'button', className: 'dshsh-cmenu-go', disabled: consentBusy,
                  onClick: () => { void postConsent('set', { actor: '*', scope: draftScope, ttlSeconds: consentTtlSeconds(draftTtl, customMinutes) }) },
                  title: '把这个档位与有效期应用到所有对话（逐条授权不受影响）',
                }, '应用到所有对话'),
                h('button', {
                  key: 'clear', type: 'button', className: 'dshsh-cmenu-clear', disabled: consentBusy,
                  onClick: () => { void postConsent('revoke-all') },
                  title: '清空全部授权（通配 + 逐对话），之后每个对话都要重新确认',
                }, '全部撤销'),
              ]),
            ])
          : h('div', { key: 'actor', className: 'dshsh-cmenu-body' }, [
              // ① 选人：对话目录（搜索 / 标题 / id）；宿主没目录时降级为手工填 id
              actors === null
                ? h('div', { key: 'loading', className: 'dshsh-cmenu-sub' }, '正在读取对话列表…')
                : actors.supported !== true
                  ? h('div', { key: 'unsupported', className: 'dshsh-actors' }, [
                      h('div', { key: 'note', className: 'dshsh-cmenu-sub' },
                        (actors.note ?? '宿主未提供对话目录') + '。可以手工填会话 id：'),
                      h('input', {
                        key: 'm', type: 'text', className: 'dshsh-cmenu-in',
                        style: { width: '100%', marginBottom: '6px' },
                        placeholder: '会话 id，例如 session-…',
                        value: actorManual,
                        onChange: (event) => setActorManual(event.target.value),
                      }),
                      h('button', {
                        key: 'mg', type: 'button', className: 'dshsh-cmenu-go',
                        disabled: actorManual.trim() === '' || consentBusy,
                        onClick: () => setActorPick({ id: actorManual.trim(), title: '手工填写' }),
                      }, '选定这个 id'),
                    ])
                  : h('div', { key: 'act', className: 'dshsh-actors' }, [
                      h('input', {
                        key: 'q', type: 'text', className: 'dshsh-cmenu-in',
                        style: { width: '100%', marginBottom: '6px' },
                        placeholder: '搜索：标题 / 会话 id / 子代理',
                        value: actorQuery,
                        onChange: (event) => setActorQuery(event.target.value),
                      }),
                      h('div', {
                        key: 'list', className: 'dshsh-actor-list',
                        style: { maxHeight: '128px', overflow: 'auto' },
                      }, (Array.isArray(actors.actors) ? actors.actors : [])
                        .filter((a) => {
                          const q = actorQuery.trim().toLowerCase()
                          if (q === '') return true
                          return String(a.title ?? a.id ?? '').toLowerCase().includes(q)
                            || String(a.id ?? '').toLowerCase().includes(q)
                            || a.origin === 'subagent'
                        })
                        .map((a) => h('button', {
                          key: a.id,
                          type: 'button',
                          className: 'dshsh-actor-item' + (actorPick !== null && actorPick.id === a.id ? ' on' : '') + (a.granted ? ' granted' : ''),
                          onClick: () => setActorPick({ id: a.id, title: a.title || a.id }),
                          title: (a.title || a.id) + '（' + a.id + '）' + (a.granted ? '，已授权' : '') + (a.origin === 'subagent' ? '，子代理' : ''),
                        }, [
                          h('span', { key: 't', className: 'dshsh-actor-title' }, a.title || '(无标题)'),
                          h('span', { key: 'w', className: 'dshsh-actor-when' }, timeAgoText(a.updated ?? a.created)),
                          h('span', { key: 'i', className: 'dshsh-actor-id' }, a.id.slice(0, 12) + '…'),
                          a.origin === 'subagent' ? h('span', { key: 'o', className: 'dshsh-actor-tag' }, '子代理') : null,
                          a.granted ? h('span', { key: 'g', className: 'dshsh-actor-tag ok' }, '已授权') : null,
                        ]))),
                    ]),
              // ② 选中后：档位卡片 + 有效期 + 复核句 + 主按钮
              actorPick === null ? null : h('div', { key: 'pick', className: 'dshsh-actor-pick' }, [
                h('div', { key: 'who', className: 'dshsh-cmenu-sub' }, '授予：' + (actorPick.title || actorPick.id)),
                ...scopeCards('a-', actorScope, setActorScope),
                h('div', { key: 'ttls', className: 'dshsh-cmenu-seg' }, ttlLevels.map((level) => seg(
                  'at-' + level.key, level.label, actorTtl === level.key, () => setActorTtl(level.key)))),
                actorTtl === 'custom' ? customMinutesRow(customMinutes, setCustomMinutes) : null,
                h('div', {
                  key: 'review', className: 'dshsh-cmenu-review',
                  title: '点主按钮前先核对这一行',
                }, consentReviewText(actorPick.title || actorPick.id, actorScope,
                  (ttlLevels.find((l) => l.key === actorTtl) ?? {}).label ?? actorTtl)),
                h('div', { key: 'row', className: 'dshsh-cmenu-actions' }, [
                  h('button', {
                    key: 'go2', type: 'button', className: 'dshsh-cmenu-go', disabled: consentBusy,
                    onClick: () => {
                      void postConsent('set', { actor: actorPick.id, scope: actorScope, ttlSeconds: consentTtlSeconds(actorTtl, customMinutes) })
                      setActorPick(null)
                    },
                    title: '给这个对话单独授权（不影响其它对话）',
                  }, '授权此对话'),
                  consentRows.some((row) => row.actor === actorPick.id)
                    ? h('button', {
                        key: 'rv', type: 'button', className: 'dshsh-cmenu-clear', disabled: consentBusy,
                        onClick: () => {
                          void postConsent('revoke-one', { actor: actorPick.id })
                          setActorPick(null)
                        },
                        title: '撤销这个会话现有的授权',
                      }, '撤销此对话')
                    : null,
                  h('button', {
                    key: 'drop2', type: 'button', className: 'dshsh-btn', disabled: consentBusy,
                    onClick: () => setActorPick(null),
                  }, '取消'),
                ]),
              ]),
              // ③ 已经授权给哪些对话（含背景），便于一次看清与管理
              h('div', { key: 't4', className: 'dshsh-cmenu-h' }, '已授权的会话'),
              consentRows.length === 0
                ? h('div', { key: 'empty', className: 'dshsh-cmenu-sub' }, '还没有按对话的授权；新对话第一次用工具时会问你一次。')
                : h('div', { key: 'list', className: 'dshsh-cmenu-list' }, consentRows.map((row) => h('div', {
                    key: row.actor,
                    className: 'dshsh-cmenu-item',
                  }, [
                    h('span', { key: 'n', className: 'dshsh-cmenu-name', title: row.hasTitle ? row.label : '这个会话还没有标题，显示短 id' },
                      row.label),
                    row.isRecent ? h('span', { key: 'r', className: 'dshsh-cmenu-badge' }, '最近使用') : null,
                    h('span', { key: 's', className: 'dshsh-cmenu-sub' }, row.scopeLabel + ' · ' + row.remaining),
                    h('button', {
                      key: 'x', type: 'button', className: 'dshsh-btn', disabled: consentBusy,
                      onClick: () => { void postConsent('revoke-one', { actor: row.actor }) },
                      title: '只撤销这个会话的授权',
                    }, h(Icon, { name: 'x', size: 13 })),
                  ]))),
            ]),
      ]) : null

      const children = [picker, consentMenu, info, head, body, stats, inputRow]
      if (error !== '') {
        children.push(h('div', { key: 'err', className: 'dshsh-err', title: error }, [
          h('span', { key: 'i' }, '⚠'),
          h('span', { key: 't' }, error),
        ]))
      }
      // 与 error 分开渲染：这类消息代表"操作成功了，但结果与你输入的不完全一样"，
      // 用红色报错是误导，用沉默则是静默改写。
      if (notice !== '') {
        children.push(h('div', { key: 'note', className: 'dshsh-note', title: notice }, [
          h('span', { key: 'i' }, 'ℹ'),
          h('span', { key: 't' }, notice),
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
        onClick: onPanelClick,
      }, children.concat(resizeHandles))
    }

    /* ── 设置卡片 ──────────────────────────────────────────────────────────
     *
     * 为什么必须有这个：DSH 的设置页渲染的是**两份账本的交集** —— 宿主提供的 settings
     * namespace，以及注册进 `settings.plugin.item` 插槽的卡片。只注册 namespace 是**不够**的：
     * 原文是 "A served namespace no card claims renders nothing"。而且插槽是 keyed 的，
     * **key 必须与宿主注册的 namespace 完全一致**，否则卡片静默不渲染（连报错都没有）。
     * 这就是"宿主日志说注册成功、设置里却什么都没有"的全部原因。
     *
     * 读写都走本插件自己的同源路由（宿主侧再走官方 settings 服务），所以校验、持久化与
     * 「已立即生效 / 需重启」的结论都与宿主保持一致，卡片只负责显示。
     */
    const CARD_GROUP = [
      ['终端与会话', ['shell', 'cols', 'rows', 'defaultCwd', 'maxSessions', 'historyLimit']],
      ['审计与留痕', ['audit', 'auditRetentionDays', 'captureOutput', 'captureMaxBytes', 'auditDir']],
      ['安全', ['requireConsent', 'guardDangerousCommands', 'allowedHosts']],
      ['服务端与集成', ['socket', 'httpBase', 'exposeHttp', 'exposeTools', 'defaultTerminal', 'extendedKeys', 'watchdog']],
    ]

    /* 卡片外观全部走 PANEL_CSS 里的 `.dshsh-cfg-*` 类（取值照官方编译产物，见那段 CSS 的注释）。
     * 为什么不再用内联 style 对象：内联写不了 `:hover` / `:focus-visible` / `+` 相邻选择器 /
     * 媒体查询，而官方卡片的观感恰恰依赖它们（悬停描边、字段之间的 .5px 分隔线、键盘焦点环）。
     * 顺带也消除了"每个字段一套内联尺寸"这种最容易和同页原生卡片对不齐的写法。 */

    function SettingsCard() {
      const [open, setOpen] = react.useState(true)
      const [state, setState] = react.useState({ status: 'loading', fields: [], note: '', writable: true, error: '' })
      const [draft, setDraft] = react.useState({})
      const [saving, setSaving] = react.useState(false)

      const load = react.useCallback(async () => {
        try {
          const response = await fetch(BASE + '/settings')
          const body = await response.json()
          if (body === null || typeof body !== 'object' || !Array.isArray(body.fields)) {
            setState({ status: 'ready', fields: [], note: '', writable: false, error: '设置接口返回异常' })
            return
          }
          setState({ status: 'ready', fields: body.fields, note: String(body.note ?? ''), writable: body.writable === true, error: '' })
          setDraft({})
        } catch (error) {
          setState({ status: 'ready', fields: [], note: '', writable: false, error: String(error && error.message ? error.message : error) })
        }
      }, [])

      react.useEffect(() => { void load() }, [load])

      const valueOf = (field) => (Object.prototype.hasOwnProperty.call(draft, field.key) ? draft[field.key] : field.value)
      const mark = (key, value) => setDraft((previous) => ({ ...previous, [key]: value }))
      const dirty = Object.keys(draft).length > 0

      const save = react.useCallback(async () => {
        setSaving(true)
        try {
          const patch = {}
          for (const field of state.fields) {
            if (!Object.prototype.hasOwnProperty.call(draft, field.key)) continue
            const raw = draft[field.key]
            if (field.type === 'boolean') patch[field.key] = raw === true
            else if (field.type === 'number') patch[field.key] = Number(raw)
            else if (field.type === 'array') patch[field.key] = String(raw).split(/[\s,]+/).filter((x) => x !== '')
            else patch[field.key] = String(raw)
          }
          if (Object.keys(patch).length === 0) return
          const response = await fetch(BASE + '/settings', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ patch }),
          })
          const body = await response.json()
          if (response.ok && body?.ok === true) {
            setState((p) => ({ ...p, fields: Array.isArray(body.fields) ? body.fields : p.fields, note: String(body.note ?? '已保存'), error: '' }))
            setDraft({})
          } else {
            setState((p) => ({ ...p, error: String(body?.error ?? '保存失败'), note: '' }))
          }
        } catch (error) {
          setState((p) => ({ ...p, error: String(error && error.message ? error.message : error) }))
        } finally {
          setSaving(false)
        }
      }, [draft, state.fields])

      // 旋转 chevron：与官方 PluginCard 同款（同一个 16×16 路径 + .16s 过渡）
      const chevron = h('svg', {
        className: open ? 'dshsh-cfg-chevron dshsh-cfg-chevron-open' : 'dshsh-cfg-chevron',
        width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true',
      }, h('path', { d: 'M4 6l4 4 4-4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))

      const byKey = new Map(state.fields.map((f) => [f.key, f]))
      const rows = []
      for (const [title, keys] of CARD_GROUP) {
        const fields = keys.map((k) => byKey.get(k)).filter((f) => f !== undefined)
        if (fields.length === 0) continue
        // 分组标题独占一行；它同时打断 `.field + .field` 的相邻关系（见 CSS 注释）
        rows.push(h('p', { key: 'h-' + title, className: 'dshsh-cfg-group' }, title))
        for (const field of fields) {
          const value = valueOf(field)
          const fieldId = 'dshsh-cfg-' + field.key
          // 「需重启」徽标放在标签行的右侧（官方 badges 的位置），不挤占标签宽度
          const badges = field.restartRequired !== true ? null : h('span', { key: 'b', className: 'dshsh-cfg-badges' },
            h('span', { className: 'dshsh-cfg-badge' }, '需重启'))
          const hint = h('p', { key: 'd', className: 'dshsh-cfg-hint' }, field.description)
          if (field.type === 'boolean') {
            // 布尔项：toggleRow（标签左、开关右、两端对齐）—— 官方 SubagentModelSelectionCard 的做法
            rows.push(h('div', { key: field.key, className: 'dshsh-cfg-field' }, [
              h('div', { key: 't', className: 'dshsh-cfg-togglerow' }, [
                h('label', { key: 'l', className: 'dshsh-cfg-togglelabel', htmlFor: fieldId }, [
                  h('code', { key: 'k' }, field.key),
                  badges,
                ]),
                h('input', {
                  key: 'c', id: fieldId, type: 'checkbox', className: 'dshsh-cfg-check',
                  checked: value === true, disabled: !state.writable,
                  onChange: (event) => mark(field.key, event.target.checked),
                }),
              ]),
              hint,
            ]))
            continue
          }
          // 取值项：head（label + badges）→ input → hint，纵向三段（官方 ValueField 的做法）
          rows.push(h('div', { key: field.key, className: 'dshsh-cfg-field' }, [
            h('div', { key: 'h', className: 'dshsh-cfg-head' }, [
              h('label', { key: 'l', className: 'dshsh-cfg-label', htmlFor: fieldId }, field.key),
              badges,
            ]),
            h('input', {
              key: 'i', id: fieldId, className: 'dshsh-cfg-input',
              type: field.type === 'number' ? 'number' : 'text',
              value: value === null || value === undefined ? '' : String(value),
              disabled: !state.writable,
              onChange: (event) => mark(field.key, event.target.value),
            }),
            hint,
          ]))
        }
      }

      const summary = state.status === 'loading' ? '正在读取…'
        : state.fields.length + ' 项设置' + (state.writable ? '' : '（只读）')

      // 根节点是 <li>：官方 `.cards` 容器是 <ul>，原生卡片的根节点就是 li（且自带 list-style:none）
      return h('li', {
        className: open ? 'dshsh-cfg-card dshsh-cfg-card-open' : 'dshsh-cfg-card',
      }, [
        h('button', {
          key: 'header', type: 'button', className: 'dshsh-cfg-header', 'aria-expanded': open,
          'aria-label': (open ? '收起' : '展开') + '：持久化 shell',
          onClick: () => setOpen((previous) => !previous),
        }, [
          h('span', { key: 't', className: 'dshsh-cfg-headtext' }, [
            h('span', { key: 'name', className: 'dshsh-cfg-name' }, '持久化 shell'),
            h('span', { key: 'desc', className: 'dshsh-cfg-desc' }, summary),
          ]),
          // 有未保存草稿时在标题行右侧标明（官方卡片同款位置），收起也看得见
          dirty ? h('span', { key: 'pending', className: 'dshsh-cfg-pending' }, '未保存') : null,
          chevron,
        ]),
        open ? h('div', { key: 'body', className: 'dshsh-cfg-body' }, [
          // 只读提示与页脚都在 body 内部（官方 PluginCard 的层级），因此与字段共用 16px 内缩
          state.writable ? null : h('p', { key: 'ro', className: 'dshsh-cfg-readonly', role: 'status' },
            '这个部署没有挂载设置服务：只能读，不能在这里改（请改用 cordis.patch.yml 的 config）。'),
          ...rows,
          h('div', { key: 'footer', className: 'dshsh-cfg-footer' }, [
            // 错误优先于提示；两者都占 flex:1，把按钮推到右侧（官方 footer 的排布）
            state.error === ''
              ? (state.note === '' ? null : h('p', { key: 'note', className: 'dshsh-cfg-note' }, state.note))
              : h('p', { key: 'err', className: 'dshsh-cfg-failed', role: 'status' }, '⚠ ' + state.error),
            h('button', {
              key: 'discard', type: 'button', className: 'dshsh-cfg-discard', disabled: !dirty || saving,
              onClick: () => setDraft({}),
            }, '放弃改动'),
            h('button', {
              key: 'save', type: 'button', className: 'dshsh-cfg-save',
              disabled: !dirty || saving || !state.writable,
              onClick: () => { void save() },
            }, saving ? '保存中…' : '保存'),
          ]),
        ]) : null,
      ])
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

      // 设置卡片：不注册它，设置页里就永远没有这一项（见 SettingsCard 上方的注释）。
      // 插槽不存在时安静跳过 —— 老版本 DSH 没有这个插槽，不该因此让整个客户端插件失败。
      try {
        ctx.slots.inject('settings.plugin.item', function* () {
          yield ctx.slots.register(
            { name: 'settings.plugin.item', id: 'dsh-agent-shell', key: 'dsh-agent-shell' },
            SettingsCard,
          )
        })
      } catch (error) {
        console.error('dsh-agent-shell: settings card not registered: ' + String(error && error.message ? error.message : error))
      }
    }

    // `__decideKey` / `__decideComposition` 是**纯函数**，只为离线验证暴露（浏览器不使用）：
    // 输入法的分支没法在无 DOM 的环境里真跑，只能靠对这两个纯函数做断言来覆盖。
    return {
      apply,
      inject,
      name: 'dsh-agent-shell',
      __decideKey: decideKey,
      __decideComposition: decideComposition,
      __timeAgoText: timeAgoText,
      __consentStatusChip: consentStatusChip,
      __consentReviewText: consentReviewText,
      // ⓘ 详情层的内容组装与文本导出都是纯函数 —— 缺字段的组合可以在测试里穷举
      // 组件本身也暴露出来：测试里用「假 React」把它渲染一遍并调用每个事件处理器，
      // 这是唯一能抓住「某个 helper 忘了定义 / 某处读了 null」这类只在打开面板时才炸的错误的手段。
      __ShellPanel: ShellPanel,
      __settingsRowValue: settingsRowValue,
      __auditRowValue: auditRowValue,
      __captureRowValue: captureRowValue,
      __tmuxRowValue: tmuxRowValue,
      __resolveLineHeight: resolveLineHeight,
      __charCellWidth: charCellWidth,
      __cellsToCharIndex: cellsToCharIndex,
      __caretPlacement: caretPlacement,
      __shouldShowCaret: shouldShowCaret,
      __measurePrefixWidth: measurePrefixWidth,
      __prefixRangeOffsets: prefixRangeOffsets,
      __caretStyle: caretStyle,
      __SettingsCard: SettingsCard,
      __CARD_GROUP: CARD_GROUP,
      __closeActionFor: closeActionFor,
      __headCompact: headCompact,
      __consentButtonModel: consentButtonModel,
      __consentEntryRows: consentEntryRows,
      __consentRemainingLabel: consentRemainingLabel,
      __consentTtlSeconds: consentTtlSeconds,
      __consentSummaryText: consentSummaryText,
      __closeButtonModel: closeButtonModel,
      __fenceRowValue: fenceRowValue,
      __fenceRowTitle: fenceRowTitle,
      __settingsRowTitle: settingsRowTitle,
      __scrollAnchor: scrollAnchor,
      __contentShift: contentShift,
      __pillModel: pillModel,
      __sessionBusy: sessionBusy,
      __infoRows: buildInfoRows,
      __infoText: infoRowsToText,
      __writeClipboard: writeClipboard,
    }
  },
})
