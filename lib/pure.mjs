/**
 * lib/pure.mjs —— 零依赖纯函数集合（从 index.js 抽出的无状态工具）。
 *
 * 抽取动机：index.js 是 ~2400 行的闭包单体，纯函数与其混在一起既难测也难复用。
 * 这些函数不碰任何宿主对象/状态，可以离线穷举。
 */

/** 会话前缀（tmux 会话名=稳定 id 与此前缀绑定；显示 label 也用它规范化）。 */
export const NAME_PREFIX = 'dsh-'

/**
 * 危险命令规则表（守卫的主判据）。
 *
 * ⚠ 这是权限模型的一部分：改动必须同步 SECURITY.md 与测试（test-consent / test-pure 都断言它）。
 * 前 10 条是通用危险模式；中间是**本插件自己的命门**（私有 tmux 服务端与状态目录）；
 * 最后是发布纪律（发版是维护者的决定，不代跑）。
 */
export const DANGEROUS = [
  { pattern: /\brm\s+(-\S+\s+)*(--\s+)?(\/\*?|~\/?|\$HOME\/?|\*)(\s|$)/, reason: 'recursive delete of a root, home, or wildcard target' },
  { pattern: /--no-preserve-root/, reason: 'disabling the rm root-delete failsafe' },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: 'filesystem format' },
  { pattern: /\bdd\b[^;&|]*\bof=\/dev\//, reason: 'raw write to a block device' },
  { pattern: />\s*\/dev\/(sd|nvme|vd|hd|mmcblk)/, reason: 'overwrite of a block device' },
  { pattern: /:\s*\(\s*\)\s*\{.*:\s*\|\s*:.*\}/, reason: 'fork bomb' },
  { pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*7{3,4}\s+\//, reason: 'world-writable root permissions' },
  { pattern: /\b(shutdown|reboot|poweroff|halt)\b/, reason: 'machine shutdown or reboot' },
  { pattern: /\b(curl|wget)\b[^;&|]*\|\s*(ba|z|da|k)?sh\b/, reason: 'pipe a download straight into a shell' },

  // ── 以下是为**本插件自身的命门**加的规则（此前这部分完全没有保护）───────────────
  // 插件的一切都跑在私有 tmux 服务端上；杀掉它 = 把 AI 与用户的所有 shell 一起端掉。
  // （0.2.2：sudo/doas/su 与状态目录组已删 —— 提权是本插件的主场景（sudo 提权/远程运维），
  // 且原生 bash 旁路存在，拦"写自己家目录"纯属误伤；留痕完整性由哈希链以"可检测"承担。）
  { pattern: /\btmux\b[^;&|]*\bkill-server\b/, reason: 'killing a tmux server (the plugin\'s shells live on one; so may your own tmux work)' },
  { pattern: /\btmux\b[^;&|]*\bkill-session\b/, reason: 'killing tmux sessions (the plugin\'s shells ARE tmux sessions)' },
  { pattern: /\b(pkill|killall)\b[^;&|]*\btmux\b/, reason: 'killing tmux processes (takes the plugin\'s shells with them)' },
  { pattern: /\b(pkill|killall)\b[^;&|]*\bnode\b/, reason: 'killing node processes (the harness is one; ending it ends every shell)' },

  // 发布纪律：发版是维护者的决定，不能由 AI 在 shell 里代跑（见 PUBLISHING.md 的铁律）。
  { pattern: /\bnpm\s+(publish|unpublish|deprecate|dist-tag|owner|token)\b/, reason: 'changing the npm package (releasing is the maintainer\'s decision, not the agent\'s)' },
  { pattern: /\bgit\s+push\b(?![^;&|]*\bbackup\b)[^;&|]*(--force\b|-f\b|--mirror\b|--all\b|--tags\b)/, reason: 'force/mirror/tags push to the public repo (it only moves at release, via scripts/release-prepare.sh; pushing old tags can re-publish deleted versions)' },
]

/** 守卫主判据：命中任一危险模式即返回理由，否则 null。 */
export function scanDanger(candidate, rules = DANGEROUS) {
  for (const entry of rules) {
    if (entry.pattern.test(candidate)) return entry.reason
  }
  return null
}

/**
 * 把用户输入的名字净化成 tmux 能原样接受的形式（label 与旧式名字共用）。
 * 允许任何语言字母数字（\p{L}\p{N}）；`.`/`:` 折成 `-`（tmux 目标语法的分隔符）；
 * 其余折连字符；按码点截断 40；统一带 NAME_PREFIX（已有则不再加）。
 * **净化的语义是收窄字符集，绝不静默改写** —— 调用方据此如实告知"输入被改写过"。
 */
export function sanitizeName(raw, prefix = NAME_PREFIX) {
  const cleaned = String(raw)
    .trim()
    .replace(/[.:]/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  if (cleaned.length === 0) return ''
  const capped = Array.from(cleaned).slice(0, 40).join('')
  return capped.startsWith(prefix) ? capped : prefix + capped
}

/** 数值夹取：非有限值回退 fallback，否则取整后夹进 [min, max]（几何用）。 */
export function clamp(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}


/**
 * tmux 会话名的**白名单校验**（注入修复的核心判据）。
 *
 * 为什么要白名单而不是转义：`lib/tmux.js` 的 control 路径把命令拼成**一行字符串**
 * 写进 tmux stdin，`has-session -t ${name}` / `capture-pane -p -t ${name}` / `send-keys …`
 * 里的名字直接插值 —— 若名字含 `;`（tmux 命令分隔符）、换行、引号、`$()` 等，就会变成
 * 第二条命令执行（实测过 `list-sessions` 可直连，注入面真实）。转义在 tmux 语法里有
 * 反语义的坑（`\`、`;`、`(` 等行为不一），**白名单收窄到插件自己生成的 id 形状最可靠**：
 *
 *   · 稳定 id = `dsh-<6 位小写字母数字>`（永远命中）；
 *   · 兼容 `dsh-` 前缀用户 label 规范化产物（`[A-Za-z0-9_-]`）、纯数字 tmux 默认会话名。
 *
 * @param {unknown} name
 * @returns {boolean} 通过白名单才能作为 tmux 的会话目标
 */
export function isSafeSessionName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(name)
}

/**
 * tmux 键名白名单：只允许字母数字 `_` `-`（`C-c`/`Enter`/`Escape`/`Tab`/`Up`…都命中）。
 * control 路径里 `send-keys -t ${target} ${keyList.join(' ')}` 的键名也是字符串插值，
 * 含空格/分号/引号的键名同样构成注入面 —— 一律拒绝而不是转义。
 */
export function isSafeKeyName(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 32 &&
    /^[A-Za-z0-9_-]+$/.test(key)
}

/**
 * 解析 `tmux -V` 输出 → `[major, minor]`（如 "tmux 3.6b" → [3, 6]）。
 * 版本决定行为（extended-keys 需要 ≥3.2），解析不出返回 null —— 能力未知，调用方按保守降级。
 */
export function parseTmuxVersion(text) {
  const m = /tmux\s+(\d+)\.(\d+)/i.exec(String(text ?? ''))
  if (m === null) return null
  const major = Number(m[1])
  const minor = Number(m[2])
  return Number.isFinite(major) && Number.isFinite(minor) ? [major, minor] : null
}

/**
 * 闲置自动关闭的候选会话（纯决策，便于离线单测）。
 *
 * 判定只依赖喂进来的数据（归属表的 lastUsedAt / idleMinutes），不做任何 IO：
 * 会话必须「有归属条目、有可用的闲置时长、且 lastUsedAt 距今 ≥ 时长」才算到期。
 * 防御性规则：缺失 lastUsedAt（0）一律不算到期（宁可少关，不可误关一个刚打开的会话）。
 * 时长单位统一为**分钟**（所有工具的约定）。
 *
 * @param {Array<{name: string}>} sessions 当前在世会话
 * @param {Record<string, {lastUsedAt?: number, idleMinutes?: number}>} owners 归属表
 * @param {{now?: number, defaultMinutes?: number, skip?: Set<string>}} [opts]
 * @returns {string[]} 应关闭的会话 id（按传入顺序）
 */
export function idleClosable(sessions, owners, { now = Date.now(), defaultMinutes = 60, skip = null } = {}) {
  const out = []
  const skipSet = skip instanceof Set ? skip : new Set()
  for (const session of sessions) {
    if (skipSet.has(session.name)) continue
    const entry = owners[session.name]
    if (entry === undefined || entry === null) continue
    const minutes = Number(entry.idleMinutes ?? defaultMinutes)
    if (!Number.isFinite(minutes) || minutes <= 0) continue
    const last = Number(entry.lastUsedAt ?? 0)
    if (last > 0 && now - last >= minutes * 60000) out.push(session.name)
  }
  return out
}

/* ── 结构化命令结果（A）：包装决策 / 退出码解析 ─────────────────────────────── */

/** 交互式/特殊命令白名单：包装 EXIT 标记会破坏它们，一律原样发送。 */
const NO_WRAP_LEAD = new Set([
  'vim', 'nvim', 'vi', 'emacs', 'nano', 'less', 'more', 'man', 'top', 'htop', 'btop', 'glances',
  'ssh', 'telnet', 'sftp', 'mysql', 'psql', 'sqlite3', 'redis-cli', 'mongosh', 'python', 'python3',
  'ipython', 'node', 'bun', 'deno', 'ruby', 'irb', 'fish', 'zsh', 'bash', 'sh', 'dash', 'ksh',
  'gdb', 'lldb', 'sudo', 'su', 'docker attach', 'kubectl exec', 'kubectl run', 'watch', 'tig',
  'less', 'bc', 'dc', 'sqlsh', 'mysqlsh', 'tsh', 'expect', 'script', 'exit', 'logout',
])

/**
 * 是否给一条 `shell_run` 命令包一层退出码捕获？
 * 规则（保守优先）：多行/heredoc、以 `&` 结尾（后台化）、以交互/全屏程序开头的一律不包。
 * @returns {{wrap: boolean, reason?: string}}
 */
export function shouldWrapExit(command) {
  const cmd = String(command ?? '').trim()
  if (cmd === '') return { wrap: false, reason: 'empty' }
  if (cmd.includes('\n')) return { wrap: false, reason: 'multiline' }
  if (/<<|<<</.test(cmd)) return { wrap: false, reason: 'heredoc' }
  if (/[;&|]\s*&$/.test(cmd) || /\s&$/.test(cmd)) return { wrap: false, reason: 'background' }
  const lead = cmd.split(/\s+/)[0]
  if (NO_WRAP_LEAD.has(lead)) return { wrap: false, reason: `interactive:${lead}` }
  if (NO_WRAP_LEAD.has(cmd.split(/\s+/).slice(0, 2).join(' '))) return { wrap: false, reason: 'interactive-cmd' }
  return { wrap: true }
}

/** 把一条命令包成"执行 + 取退出码"；只应在 shouldWrapExit 返回 wrap 时调用。 */
export function wrapExitCommand(command) {
  return `${String(command).trimEnd()} ; _dsh_x=$?; printf '\\n__DSH_EXIT__=%s\\n' "$_dsh_x"`
}

/** 从输出尾部解析退出码：返回 {found, exit}；未找到 → {found:false}。 */
export function parseExitFromTail(tail) {
  // 滚动缓冲里可能残留上一条命令的标记：必须取**最后**一处（本命令写的那条），
  // 不能用不带 /g 的 exec（那只会拿到第一处）。
  const re = /__DSH_EXIT__=(-?\d+)/g
  let hit = null
  let m = null
  const text = String(tail ?? '')
  while ((m = re.exec(text)) !== null) hit = m
  if (hit === null) return { found: false, exit: null }
  return { found: true, exit: Number(hit[1]) }
}

/** 屏幕增量：返回 `cur` 里相对 `last` **新出现**的内容（`until/waitFor match`、`since` 模式共用）。
 * 终端模型是"底部追加、顶部滚出"：旧帧整体（或其尾部）仍作为连续块出现在新帧**顶部区域**；
 * 找到旧帧最长的可复现尾部（整行对齐、第一次出现），把该块之后的内容当新。命令回显、屏上残留
 * 的历史行都在旧帧里，天然不会被误判成新输出。旧帧完全不可见（整屏滚出 / 最后一行被重绘覆盖）
 * 时保守视为全屏皆新。注意必须取"第一次"出现 —— 新帧末尾的同形行（如命令结束后的新提示符）
 * 是**新**内容，取最后一次出现会把真输出整段吞掉。
 */
export function diffSince (last, cur) {
  const a = String(last ?? '').split('\n')
  const b = String(cur ?? '').split('\n')
  // 底部空行是定高窗格的填充（trim:false 会带回），不参与匹配
  while (a.length > 0 && a[a.length - 1].trim() === '') a.pop()
  while (b.length > 0 && b[b.length - 1].trim() === '') b.pop()
  if (a.length === 0) return b.join('\n')
  if (b.length === 0) return ''
  if (a.length === b.length && a.every((line, i) => line === b[i])) return ''
  // ① 整帧对齐：旧帧最长尾部块（整行对齐、第一次出现）+ 其后必须真留有新内容
  const full = tailOverlap(a, b)
  if (full !== null && full.i + full.k < b.length) return b.slice(full.i + full.k).join('\n')
  // ② 回退：基线最后一行是"光标所在行"，输入/重绘会改写它（`└─$` → `└─$ <命令>`），
  //    不作锚点再对一次 —— 否则旧帧在新帧里唯一完整的副本是**底部新提示符**，
  //    会误判成"旧帧还在屏底"而把真正的输出整段吞掉。
  const stable = a.slice(0, a.length - 1)
  const relaxed = stable.length > 0 ? tailOverlap(stable, b) : null
  if (relaxed !== null && relaxed.i + relaxed.k < b.length) return b.slice(relaxed.i + relaxed.k).join('\n')
  // ③ 旧帧完整复现到屏底（只有光标行可能变）→ 没有新内容
  if (full !== null) return ''
  // ④ 旧帧痕迹完全不可见（整屏滚出）→ 保守视为全屏皆新
  return b.join('\n')
}

/** 旧帧尾部块在新帧里的位置：返回 `{ i, k }`（整行对齐、第一次出现），找不到返回 null。
 * 只用于 {@link diffSince} —— 滚动模型里旧帧出现在新帧**顶部区域**，所以取第一次出现；
 * 取最后一次会被"新帧末尾的同形行"（如新提示符与基线提示符同形）骗到。
 */
function tailOverlap (baseLines, screenLines) {
  const maxK = Math.min(baseLines.length, screenLines.length)
  for (let k = maxK; k >= 1; k -= 1) {
    const block = baseLines.slice(baseLines.length - k)
    for (let i = 0; i + k <= screenLines.length; i += 1) {
      let same = true
      for (let j = 0; j < k; j += 1) {
        if (screenLines[i + j] !== block[j]) { same = false; break }
      }
      if (same) return { i, k }
    }
  }
  return null
}

/** 从"新输出"里剥掉**命令自身的回显**：终端会把发出的命令原样回显在屏上，里面可能恰好
 * 包含等待词；基线设在"发送前"时这些回显行会被算进新内容造成自匹配。规则：只剥开头
 * 连续属于命令文本的行（去空白后拼接，兼容长命令折行把单词劈成两半）；一旦偏离命令
 * 文本立即停手 —— 命令真正的输出行不受影响。
 */
export function stripCommandEcho (fresh, sent) {
  const flat = (s) => String(s).replace(/\s+/g, '')
  const cmd = flat(sent)
  if (cmd === '') return String(fresh ?? '')
  const lines = String(fresh ?? '').split('\n')
  let acc = ''
  let i = 0
  for (; i < lines.length; i += 1) {
    // 回显行的行首常带提示符（`└─$ <命令>`）—— 带与不带提示符两种形态都试
    const noPrompt = lines[i].replace(/^[^\n]*?[$#❯%>]\s/, '')
    const variants = noPrompt === lines[i] ? [lines[i]] : [noPrompt, lines[i]]
    let advanced = false
    for (const variant of variants) {
      const piece = flat(variant)
      if (piece === '') continue
      const next = acc + piece
      if (cmd.startsWith(next)) { acc = next; advanced = true; break }
    }
    if (!advanced) break
  }
  return lines.slice(i).join('\n')
}

/* ── 敏感信息脱敏（G）：把"看起来是密钥"的字面量从可见面抹掉 ────────────────── */

const SECRET_PATTERNS = [
  /\b(token|api[_-]?key|secret|passwd|password|pwd|private[_-]?key|access[_-]?key|client[_-]?secret|refresh[_-]?token|auth)['"]?\s*[:=]\s*['"]?[A-Za-z0-9_\-./+]{6,}/gi,
  /\b(Authorization|Proxy-Authorization)\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bssh-[a-z]+\s+AAAA[A-Za-z0-9+/=]+/g,
  /\bBEGIN\s+(?:RSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY\b[\s\S]{0,400}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bglpat-[A-Za-z0-9_-]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /[a-z][a-z0-9+.-]*:\/\/[^/@\s]+@/g,   // URL 里内嵌的 user:password@
]

/**
 * 把命中密钥样式的字面量替换为 `[redacted]`（保长度不变，便于对齐）。
 * 只做"形状匹配"，不做语义判断 —— 宁可误报也不让密钥躺进审计/面板/工具输出。
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return text
  let out = text
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m) => `[redacted${'x'.repeat(Math.max(0, m.length - 9))}]`).slice(0, out.length)
  }
  // private key 块可能跨行被上面截断，这里兜底一次
  out = out.replace(/BEGIN [A-Z ]*PRIVATE KEY/g, 'BEGIN [redacted] PRIVATE KEY')
  return out
}

/* ── AI 精准四件套（0.2.3）：条件等待解析 / 失败摘要 / 会话自检建议 ───────────── */

/**
 * 解析 `shell_run` 的 `waitFor` 规格。
 * 支持 `match:<正则>`（新输出匹配）、`file:<路径>`（文件出现）、`port:<1-65535>`（端口可连）。
 * @returns {{error: string} | {kind: 'match'|'file'|'port', value: string|number, re?: RegExp}}
 */
export function parseWaitFor(spec) {
  const s = String(spec ?? '').trim()
  if (s === '') return { error: 'waitFor 不能为空' }
  if (s.startsWith('match:')) {
    const pattern = s.slice(6)
    if (pattern === '') return { error: 'match: 后面缺少正则' }
    try {
      return { kind: 'match', value: pattern, re: new RegExp(pattern) }
    } catch (error) {
      return { error: `match 正则不合法（${String(error && error.message ? error.message : error)}）` }
    }
  }
  if (s.startsWith('file:')) {
    const path = s.slice(5).trim()
    return path === '' ? { error: 'file: 后面缺少路径' } : { kind: 'file', value: path }
  }
  if (s.startsWith('port:')) {
    const port = Number(s.slice(5).trim())
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'port: 需要 1–65535 的整数' }
    return { kind: 'port', value: port }
  }
  return { error: `无法识别 waitFor="${s}"（支持 match:<正则> / file:<路径> / port:<1-65535>）` }
}

/**
 * 从命令尾部输出提炼一句**失败摘要**：优先挑像错误的行；没有错误行且只剩提示符就返回空串。
 * 只做形状匹配（宁可少说，不要把整屏塞给 AI）。
 */
export function summarizeFailure(tail, { maxLines = 2, maxChars = 160 } = {}) {
  const all = String(tail ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
  const rx = /(error|failed|failure|panic|traceback|denied|refused|not found|no such file|fatal|exception|✗|❌)/i
  // 提示符形态要认全：本仓真实提示符是 `┌──(user㉿host)-[cwd]` / `└─$`（含框线与 ㉿），
  // 早先只认"以 $/# 结尾"，于是失败摘要有时候摘要的就是提示符本身（实测冒烟里看到）。
  const promptish = /^[┌└╭╰]|㉿|^[^\s]{0,80}[$#]\s*$/
  const meaningful = all.filter((line) => !promptish.test(line))
  const hits = meaningful.filter((line) => rx.test(line))
  const picked = (hits.length > 0 ? hits : meaningful.slice(-1)).slice(-maxLines)
  const text = picked.join(' | ').replace(/\s+/g, ' ')
  if (text === '') return ''
  return text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text
}

/**
 * 会话自检建议（`shell_manage action=doctor`）。输入是调用方采集到的状态，输出是"怎么办"。
 * 只给可执行建议，不给"可能有问题"这种含糊话。
 */
export function doctorAdvice (state = {}) {
  const out = []
  const idleSec = Number(state.idleSec ?? 0)
  const fg = String(state.foreground ?? '')
  if (state.userBusy === true) out.push('人在操作（面板已解锁）：AI 的发送/改名/关闭会一律让路，只读不受影响')
  if (fg !== '' && state.isShell === false && idleSec > 600) {
    out.push(`前台是 ${fg} 且已无活动 ${Math.round(idleSec / 60)} 分钟：可能卡住 —— 可 shell_send { keys: ["C-c"] } 打断，或 shell_manage close 重开`)
  }
  const bufferPct = Number(state.bufferPct ?? 0)
  if (bufferPct >= 90) out.push(`滚动缓冲已用 ${Math.round(bufferPct)}%（接近上限）：可调大设置 historyLimit，或关掉后重开这个会话`)
  if (state.captureStopped === true) out.push('输出留痕已停止（达到 captureMaxBytes 上限）—— 后续输出不再写入 output/')
  if (Number(state.idleMinutes) > 0 && idleSec > Number(state.idleMinutes) * 60) {
    out.push(`已超过闲置时长（${state.idleMinutes} 分钟）：下一次扫描会被自动关闭；不想关就 shell_manage action=idle minutes=0`)
  }
  return out
}
