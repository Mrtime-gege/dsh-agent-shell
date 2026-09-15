#!/usr/bin/env node
/**
 * 注入防回归（0.2.2，零依赖）—— 补上"每个拼接点都包了校验"这一条。
 *
 * 0.2.1 的白名单（`isSafeSessionName` / `isSafeKeyName`）有单元测试，但那只证明"拒绝
 * 注入样本"，**没证明"tmux.js 里每个 control 命令拼接点都包了 safeTarget/keyList"**。
 * 新加一个拼接点忘了包校验，白名单测再多也拦不住 —— 这才是注入回归的真正的门。
 *
 * 本文件不做 AST 解析（零依赖、任何 CI 都能跑），读 lib/tmux.js 源码做三条机械断言：
 *   1. 每个 control 命令反引号模板里的 `-t ${...}` 必须紧挨着 `safeTarget(`；
 *   2. `send-keys` 模板里的键名插值只允许 ${keyList.join(' ')}（上游已 isSafeKeyName 过滤），
 *      不允许出现裸键名数组插值（如 ${keys}）或直接拼字面键名；
 *   3. 0.2.1 用过的 PoC 注入载荷对白名单仍然全 false（真·回归载荷）。
 *
 * 用法：node scripts/test-injection.mjs [包目录]     # 默认当前仓库根
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = process.argv[2] !== undefined ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')

const problems = []
let checks = 0
const check = (ok, label, detail = '') => {
  checks += 1
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ' —— ' + detail : ''}`)
  if (!ok) problems.push(label)
}

const tmux = readFileSync(join(ROOT, 'lib', 'tmux.js'), 'utf8')

/* ── 1. 每个控制命令模板里的 -t ${…} 都必须包在 safeTarget( 里 ─────────────── */

const templates = [...tmux.matchAll(/`([^`]*?)`/g)].map((m) => m[1])
let unsafeTarget = 0
for (const tpl of templates) {
  // 找每一个 `-t ${…}`：其片段必须直接含 safeTarget( ，或是已由 safeTarget 构造的 target 变量
  const tRe = /-t\s\$\{/g
  let m
  while ((m = tRe.exec(tpl)) !== null) {
    const end = tpl.indexOf('}', m.index + 4)
    const frag = tpl.slice(m.index, end === -1 ? tpl.length : end + 1)
    const ok = frag.includes('safeTarget(') || /^-t\s*\$\{\s*target\s*\}/.test(frag)
    if (!ok) {
      unsafeTarget += 1
      console.log(`   未包 safeTarget 的 -t 表达式: ${frag.slice(0, 60)}`)
    }
  }
}
check(unsafeTarget === 0, `control 模板里所有 -t ${'${…}'} 都包在 safeTarget 内（发现 ${unsafeTarget} 处）`)

/* ── 2. send-keys 键名插值只能来自 keyList.join（上游已 isSafeKeyName）────────── */

// 收集模板里 send-keys 相关的所有 ${…} 插值表达式
const sendKeyExprs = []
for (const tpl of templates) {
  if (!tpl.includes('send-keys')) continue
  for (const expr of tpl.matchAll(/\$\{([^}]+)\}/g)) sendKeyExprs.push(expr[1])
}
const badExprs = sendKeyExprs.filter((e) => !/^keyList\.join\(/.test(e.trim()))
const allowedNonKey = /^(target|tmuxQuote\(.*\))$/   // 目标恒为 safeTarget 产物；文本走 -l 字面
const forbidden = badExprs.filter((e) => !allowedNonKey.test(e.trim()))
check(forbidden.length === 0,
  `send-keys 模板的键名插值只来自 keyList.join（异常插值：${JSON.stringify([...new Set(forbidden)])}）`)

/* ── 3. 0.2.1 PoC 注入载荷对白名单仍然全 false ─────────────────────────────── */

const pure = await import(join(ROOT, 'lib', 'pure.mjs'))
const { isSafeSessionName, isSafeKeyName } = pure

const pocSessions = [
  "x; pipe-pane -o 'cat > /tmp/pwn'",
  'dsh-a; touch /tmp/pwn',
  'dsh-mine; send-keys -t dsh-mine Enter',
  'a$(rm -rf /)',
  'a`rm -rf /`',
  'dsh-normal-1',        // 对照组：合法 id
]
const pocKeys = [
  'Enter; rm -rf /',
  'C-c; kill-server',
  '"Enter"',
  'Enter',               // 对照组：合法键名
  'Escape',
]
let pocFail = 0
for (const s of pocSessions.slice(0, -1)) if (isSafeSessionName(s) !== false) { pocFail += 1; console.log(`   PoC 会话名未被拒: ${JSON.stringify(s)}`) }
for (const k of pocKeys.slice(0, -2)) if (isSafeKeyName(k) !== false) { pocFail += 1; console.log(`   PoC 键名未被拒: ${JSON.stringify(k)}`) }
check(pocFail === 0, `0.2.1 PoC 载荷全部被白名单拒绝（${pocFail} 处漏网）`)
check(isSafeSessionName(pocSessions[pocSessions.length - 1]) === true, '对照组：合法会话 id 放行')
check(isSafeKeyName('Enter') === true && isSafeKeyName('Escape') === true, '对照组：合法键名放行')

if (problems.length > 0) {
  console.log(`\n注入防回归：${checks - problems.length}/${checks} 项通过，${problems.length} 项失败`)
  process.exit(1)
}
console.log(`\n注入防回归：全部通过（${checks} 项断言）`)