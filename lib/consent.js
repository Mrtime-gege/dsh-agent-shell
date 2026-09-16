/**
 * 授权模型（纯函数，零依赖）—— 时间 × 能力两个维度。
 *
 * 为什么要单独一个模块：这套判定同时被宿主（工具门、路由）与前端（授权浮层）需要，
 * 而且它包含大量"边界必须一致"的规则（时间档位、能力映射、过期语义）。
 * 把它写成纯函数，就能在**不启动 tmux、不启动 DSH** 的情况下逐一断言 ——
 * 权限模型的边界搞错会直接变成安全问题，不能只靠手工点。
 *
 * 设计定稿见 docs/设计与实现.md「权限模型」一节。
 */

/** 能力三档。deny = 完全禁止接触插件功能。 */
export const SCOPES = ['full', 'read', 'deny']

/** 时间五档。seconds = null 表示永久。 */
export const TIME_LEVELS = [
  { key: '10m', seconds: 600, label: '10 分钟' },
  { key: '30m', seconds: 1800, label: '30 分钟' },
  { key: '2h', seconds: 7200, label: '2 小时' },
  { key: 'forever', seconds: null, label: '永久' },
  { key: 'custom', seconds: null, label: '自定义' },
]

/** 自定义时间的允许范围：1 分钟 – 30 天（用户拍板）。 */
export const CUSTOM_TTL_RANGE = [60, 30 * 86400]

/**
 * 工具 → 所需能力。**这是权限模型的边界，改动必须同步 SECURITY.md 与测试。**
 *
 * 注意两个刻意的决定（都由用户拍板）：
 *   * `shell_close` 需要 full —— 关闭会杀掉里面的进程，不算"只看看"；
 *   * `shell_state` 任何档位都允许 —— 它吸收了 shell_consent 的职责（授权状态一并在其中汇报），
 *     与"完全禁止也能查授权状态"同一个理由：被挡住的对话也得能问出"为什么被挡"。
 *
 * 0.2.3 精简合并：shell_wait → shell_read(mode wait)，shell_check → shell_run/shell_send(dryrun)，
 * shell_consent → shell_state（不再单列，避免能力表与实际工具脱节）。
 */
export const TOOL_CAPABILITY = {
  shell_state: 'none',
  shell_read: 'read',
  shell_audit: 'read',
  shell_open: 'full',
  shell_run: 'full',
  shell_send: 'full',
  shell_manage: 'full',
}

/** 某个工具需要的能力（未知工具按最严格处理：full）。 */
export function capabilityForTool (name) {
  return Object.prototype.hasOwnProperty.call(TOOL_CAPABILITY, name) ? TOOL_CAPABILITY[name] : 'full'
}

/** 该能力档是否允许做要求 cap 的操作。 */
export function scopeAllows (scope, cap) {
  if (cap === 'none') return true
  if (scope === 'full') return true
  if (scope === 'read') return cap === 'read'
  return false   // deny 与未知档位一律拒绝（fail closed）
}

export function normalizeScope (value) {
  return SCOPES.includes(value) ? value : null
}

/** 把秒数收敛到合法范围；null / undefined 表示永久（自定义档由调用方显式给秒数）。 */
export function normalizeTtl (seconds) {
  if (seconds === null || seconds === undefined) return null
  const n = Number(seconds)
  if (!Number.isFinite(n)) return null
  const rounded = Math.floor(n)
  if (rounded < CUSTOM_TTL_RANGE[0] || rounded > CUSTOM_TTL_RANGE[1]) return null
  return rounded
}

/** 授权是否仍然有效（支持限期）。 */
export function isActive (entry, now) {
  if (entry === null || typeof entry !== 'object') return false
  // 旧格式（本模型之前的 consent.json）没有 scope 字段：那时授权就等于"完全控制"，
  // 所以按 full 解读是**兼容读法**而不是放宽 —— 否则升级后所有旧授权会突然失效、人被重新问一遍。
  // 而"有 scope 但值非法"则一律拒绝（fail closed）。
  const scope = entry.scope === undefined ? 'full' : normalizeScope(entry.scope)
  if (scope === null) return false
  if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) return false
  return true
}

/** 由档位算出 expiresAt（null = 永久）。 */
export function expiresAtFor (seconds, now) {
  return seconds === null ? null : now + seconds * 1000
}

/**
 * 列表用：把授权记录整理成前端要的行（按最近使用倒序）。
 * @param {Record<string, object>} consent 授权表（含 '*' 通配）
 * @param {number} now 当前时间（注入以便测试）
 * @param {(actor: string) => string} titleOf 取会话标题（可为空串）
 */
export function summarizeEntries (consent, now, titleOf = () => '') {
  const rows = []
  for (const [actor, entry] of Object.entries(consent ?? {})) {
    if (actor === '*') continue
    if (!isActive(entry, now)) continue
    rows.push({
      actor,
      title: typeof entry.title === 'string' ? entry.title : '',
      scope: normalizeScope(entry.scope),
      expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : null,
      lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : (entry.at ?? null),
      uses: Number.isFinite(entry.uses) ? entry.uses : 0,
      source: entry.source === 'panel' ? 'panel' : 'prompt',
    })
  }
  return rows.sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
}
