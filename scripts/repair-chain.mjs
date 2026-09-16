#!/usr/bin/env node
/**
 * 修复审计哈希链的历史断点（仅限 cold-start-genesis 型）。
 *
 * 背景：0.2.2 及更早版本的冷启动/热重载竞态 —— 新实例的审计链头是异步从磁盘读回的，
 * 读回完成前到达的记录（重启/改设置后面板立刻发来的 consent/open 等）会封在创世前驱上，
 * 于是出现"第 N 条的 prevHash=genesis 而前一条不是"。这不是篡改（篡改是改 hash/删行），
 * 但会让整链校验失败。本脚本只认这一种断点，其它一律拒绝（防手滑）。
 *
 * 默认 **dry-run**：只打印将重接的区间与新旧哈希对照，不写盘。
 * `--apply` 才写盘：
 *   1. 先备份受影响的按天文件为 `<name>.before-repair-<ts>`；
 *   2. 从断点起用正确链头重算 prevHash/hash（可能跨多个按天文件）；
 *   3. 末尾追加一条链上可见的 `chain-repair` 记录（reason / before-head / after-head）；
 *   4. 重写后立即整链复验并打印结果。
 *
 * 用法：
 *   node scripts/repair-chain.mjs                      # dry-run，默认目录 ~/.dsh/agent-shell
 *   node scripts/repair-chain.mjs <审计目录> [--apply]
 */

import { readFileSync, writeFileSync, cpSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { auditPaths, readSealedChain, verifyChain, sealRecord } from '../lib/audit.js'

const dir = process.argv[2] !== undefined && !process.argv[2].startsWith('--')
  ? process.argv[2]
  : join(homedir(), '.dsh', 'agent-shell')
const apply = process.argv.includes('--apply')

if (!existsSync(dir)) {
  console.error(`✗ 审计目录不存在：${dir}`)
  process.exit(1)
}
const paths = auditPaths(dir)

// ── 读全链，同时记下每条记录来自哪个文件（重接后要按文件分组写回） ───────────
const names = readdirSync(dir).filter((n) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort()
const flat = [] // { file, line, record }
for (const name of names) {
  const raw = readFileSync(join(dir, name), 'utf8')
  for (const line of raw.split('\n')) {
    const record = JSON.parse(line.trim() === '' ? 'null' : line)
    if (record !== null && typeof record === 'object') flat.push({ file: name, line, record })
  }
}
const records = flat.map((f) => f.record)
const verdict = verifyChain(records)
if (verdict.ok) {
  console.log(`✓ 链完整（${records.length} 条封链，头 ${verdict.head.slice(0, 12)}），无需修复`)
  process.exit(0)
}
const ba = verdict.brokenAt
const broken = records[ba.index]
if (!(ba.reason === 'prev-mismatch' && ba.hint === 'cold-start-genesis')) {
  console.error(`✗ 断点不匹配 cold-start-genesis 型（reason=${ba.reason} hint=${String(ba.hint) || '无'}）—— 疑似真实篡改，不自动修复。请用 shell_audit 人工核对。`)
  process.exit(2)
}
const byFile = {}
for (let i = ba.index; i < records.length; i += 1) {
  byFile[flat[i].file] = (byFile[flat[i].file] ?? 0) + 1
}
console.log(`⚠ 第 ${ba.index + 1} 条断链：prevHash=genesis（冷启动/热重载竞态，非篡改）`)
console.log(`  断点事件：event=${broken.event ?? '?'} ts=${new Date(broken.ts ?? 0).toISOString()}`)
console.log(`  将重接 ${records.length - ba.index} 条记录（涉及文件：${Object.entries(byFile).map(([f, n]) => `${f}(${n} 条)`).join(', ') || '（无）'}）`)
console.log(`  重接起点链头：${records[ba.index - 1].hash.slice(0, 16)} (原记录 ${ba.index} 的 hash)`)

if (apply) {
  // 备份受影响文件
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  for (const file of Object.keys(byFile)) {
    cpSync(join(dir, file), join(dir, `${file}.before-repair-${ts}`))
  }
  // 从断点重接
  let head = records[ba.index - 1].hash
  const changed = []
  for (let i = ba.index; i < records.length; i += 1) {
    const before = records[i].hash
    const resealed = sealRecord(head, records[i])
    records[i] = resealed
    head = resealed.hash
    changed.push({ i, before: before.slice(0, 12), after: resealed.hash.slice(0, 12) })
  }
  // 写回（按文件分组）
  const grouped = {}
  for (let i = 0; i < flat.length; i += 1) grouped[flat[i].file] = (grouped[flat[i].file] ?? []).concat(records[i])
  for (const [file, recs] of Object.entries(grouped)) {
    writeFileSync(join(dir, file), recs.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
  }
  // 追加一条链上可见的 chain-repair 记录（说明发生了什么；先落盘再推进头）
  const repairRec = sealRecord(head, {
    event: 'chain-repair', ts: Date.now(),
    brokenAt: ba.index + 1, reason: 'cold-start-genesis',
    beforeHead: records[ba.index].hash, afterHead: head,
    note: 're-chained from cold-start genesis break (0.2.2-era race); backups saved as *.before-repair-*',
  })
  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(join(dir, `audit-${today}.jsonl`), JSON.stringify(repairRec) + '\n', { flag: 'a' })

  // 复验
  const re = await readSealedChain(paths)
  console.log(`✓ 已写入（备份 *.before-repair-${ts}）`)
  console.log(`  重接前 3 条：${changed.slice(0, 3).map((c) => `#${c.i + 1} ${c.before}→${c.after}`).join(' · ')}${changed.length > 3 ? ' …' : ''}`)
  console.log(re.verify.ok
    ? `✓ 复验通过（${re.verify.sealed} 条封链，头 ${re.verify.head.slice(0, 12)}）`
    : `✗ 复验仍失败：${JSON.stringify(re.verify.brokenAt)} —— 请检查备份，不要继续使用这批改写`)
  process.exit(re.verify.ok ? 0 : 3)
}

console.log('\n（dry-run，未写盘。加 --apply 执行：先备份 → 重接 → 追记 chain-repair → 复验）')