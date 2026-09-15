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
