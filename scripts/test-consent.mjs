#!/usr/bin/env node
/**
 * 授权模型的纯函数测试（`node scripts/test-consent.mjs`）。
 *
 * 为什么单独一份、并且要在**不需要 tmux / 不需要 DSH** 的前提下跑：
 * 权限模型的边界写错会直接变成安全缺口（"可读"能写、"完全禁止"还能用），
 * 而这种错误在手工点界面时很难发现 —— 它们只在特定组合下暴露。所以把矩阵、档位、
 * 过期语义、列表排序全部拉平成断言，每个组合一行。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  SCOPES, TIME_LEVELS, CUSTOM_TTL_RANGE, TOOL_CAPABILITY,
  capabilityForTool, scopeAllows, normalizeScope, normalizeTtl,
  isActive, expiresAtFor, summarizeEntries,
} from '../lib/consent.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
let checks = 0
const check = (ok, label) => {
  checks += 1
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) problems.push(label)
}

/* ── 1. 能力矩阵：三档 × 三类能力 ───────────────────────────────────────── */

check(SCOPES.join(',') === 'full,read,deny', `档位定义：${SCOPES.join(' / ')}`)

// 完全控制：什么都能做
check(scopeAllows('full', 'read') && scopeAllows('full', 'full'), '完全控制：读与写都允许')
// 可读：只能读
check(scopeAllows('read', 'read') === true, '可读：允许读')
check(scopeAllows('read', 'full') === false, '可读：**不允许写**（这是这个档位的全部意义）')
// 完全禁止：什么都不允许
check(scopeAllows('deny', 'read') === false && scopeAllows('deny', 'full') === false,
  '完全禁止：读与写都不允许')
// 查询授权状态不受档位影响（用户明确要求）
check(['full', 'read', 'deny'].every((s) => scopeAllows(s, 'none')),
  '查询授权状态不受任何档位影响（用户明确要求：完全禁止也要能查）')
// 未知档位 fail closed
check(scopeAllows('whatever', 'read') === false && scopeAllows(undefined, 'full') === false,
  '未知档位一律拒绝（fail closed，而不是默认放行）')

/* ── 2. 工具 → 能力映射（改这张表就是改安全边界，所以逐项断言） ─────────── */

const expectRead = ['shell_list', 'shell_read', 'shell_history', 'shell_diagnose', 'shell_audit']
const expectFull = ['shell_open', 'shell_send', 'shell_close', 'shell_resize', 'shell_rename']
check(expectRead.every((t) => capabilityForTool(t) === 'read'),
  `只读工具：${expectRead.join(', ')}`)
check(expectFull.every((t) => capabilityForTool(t) === 'full'),
  `需要完全控制的工具：${expectFull.join(', ')}`)
check(capabilityForTool('shell_close') === 'full',
  'shell_close 需要完全控制（关会话会杀进程，用户拍板不算"只读"）')
check(capabilityForTool('shell_consent') === 'none', 'shell_consent 不受档位限制')
check(capabilityForTool('shell_something_new') === 'full',
  '未知工具按"需要完全控制"处理（新增工具忘了登记也不会被放开）')

// 表与断言不许漂移：consent.js 里登记的工具集合必须正好是这些
{
  const registered = Object.keys(TOOL_CAPABILITY).sort()
  const expected = [...expectRead, ...expectFull, 'shell_consent'].sort()
  check(JSON.stringify(registered) === JSON.stringify(expected),
    `工具映射表与预期一致（${registered.length} 个）：${registered.join(', ')}`)
  // 插件实际注册的工具也不能多出一个没登记的
  const source = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')
  const actual = [...source.matchAll(/name: '(shell_[a-z]+)'/g)].map((m) => m[1])
  const unique = [...new Set(actual)].sort()
  check(JSON.stringify(unique) === JSON.stringify(expected),
    `index.js 注册的工具与映射表一致（${unique.length} 个）：${unique.join(', ')}`)
}

/* ── 3. 时间档位与自定义范围 ────────────────────────────────────────────── */

check(TIME_LEVELS.length === 5, `时间五档：${TIME_LEVELS.map((l) => l.label).join(' / ')}`)
check(TIME_LEVELS.filter((l) => l.seconds === null).map((l) => l.key).join(',') === 'forever,custom',
  '只有"永久"与"自定义"没有固定秒数')
check(TIME_LEVELS[0].seconds === 600 && TIME_LEVELS[1].seconds === 1800 && TIME_LEVELS[2].seconds === 7200,
  '10 分钟 / 30 分钟 / 2 小时 的秒数正确')
check(CUSTOM_TTL_RANGE[0] === 60 && CUSTOM_TTL_RANGE[1] === 30 * 86400,
  '自定义范围是 1 分钟 – 30 天（用户拍板）')

check(normalizeTtl(60) === 60 && normalizeTtl(30 * 86400) === 30 * 86400, '自定义范围的边界值被接受')
check(normalizeTtl(59) === null, '低于 1 分钟被拒绝')
check(normalizeTtl(30 * 86400 + 1) === null, '超过 30 天被拒绝')
check(normalizeTtl(null) === null && normalizeTtl(undefined) === null, 'null / undefined 表示永久')
check(normalizeTtl('abc') === null && normalizeTtl(NaN) === null && normalizeTtl(Infinity) === null,
  '非数字与无穷被拒绝（不能靠 NaN 变成"永久"）')
check(normalizeTtl(600.7) === 600, '小数向下取整')

/* ── 4. 过期语义 ───────────────────────────────────────────────────────── */

const now = 1_000_000
check(isActive({ scope: 'full', expiresAt: now + 1 }, now) === true, '未到期的授权有效')
check(isActive({ scope: 'full', expiresAt: now }, now) === false, '正好到期即失效（边界：不留给"差一毫秒"）')
check(isActive({ scope: 'full', expiresAt: now - 1 }, now) === false, '已过期失效')
check(isActive({ scope: 'full' }, now) === true, '没有 expiresAt = 永久')
check(isActive({ scope: 'full', expiresAt: null }, now) === true, 'expiresAt: null = 永久')
// 兼容读法：本模型之前的 consent.json 没有 scope 字段，那时授权就等于完全控制
check(isActive({ at: 1, by: 'user' }, now) === true, '旧格式记录（无 scope）按"完全控制"兼容读取')
check(isActive({ scope: 'nonsense' }, now) === false, '有 scope 但值非法 → 拒绝（fail closed）')
check(isActive(null, now) === false && isActive(undefined, now) === false, '空记录一律无效')
check(expiresAtFor(600, now) === now + 600 * 1000 && expiresAtFor(null, now) === null,
  '由档位算 expiresAt，永久为 null')

/* ── 5. 列表：按最近使用倒序、跳过通配与过期 ────────────────────────────── */

{
  const rows = summarizeEntries({
    '*': { scope: 'full', expiresAt: null },
    old: { scope: 'read', lastUsedAt: 100, uses: 3 },
    newer: { scope: 'full', lastUsedAt: 900, uses: 1, title: '重构 tmux 探测' },
    expired: { scope: 'full', expiresAt: now - 1, lastUsedAt: 9999 },
  }, now)
  check(rows.length === 2, `列表跳过通配与过期条目（${rows.length} 行）`)
  check(rows[0].actor === 'newer' && rows[1].actor === 'old', '按最近使用倒序（最近的排第一）')
  check(rows[0].title === '重构 tmux 探测', '带上会话标题（面板靠它分辨会话）')
  check(rows[1].uses === 3 && rows[1].lastUsedAt === 100, '带出使用次数与最近使用时间')
  check(rows.every((r) => ['full', 'read', 'deny'].includes(r.scope)), '每行的档位合法')
}

console.log(`\n授权模型测试：${checks - problems.length}/${checks} 项通过`)
if (problems.length > 0) {
  console.log('失败项：')
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(1)
}
