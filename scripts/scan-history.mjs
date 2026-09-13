#!/usr/bin/env node
/**
 * 全历史泄露扫描（`npm run leak:history`）。
 *
 * 为什么需要它：`release:check` 只扫**工作树**，而「工作树里修好」不等于修好 ——
 * 泄露会留在历史提交、旧标签里，而它们照样能被任何人取到
 * （实测：工作树修好之后 `raw.githubusercontent.com/<repo>/v0.1.4/PUBLISHING.md` 仍返回 200）。
 * 一次真实事故就是如此：开发机绝对路径在 `PUBLISHING.md` 与 `scripts/test-client.mjs` 里，
 * 一直躺在**已发布版本**和整部历史中。
 *
 * 用法：
 *   node scripts/scan-history.mjs              # 扫当前仓库的全部历史 + 全部标签
 *   node scripts/scan-history.mjs <repo-path>  # 扫另一个仓库（例如改写前的备份镜像）
 *
 * 规则与工作树扫描共用 scripts/lib/leak-rules.mjs，避免两处漂移。退出码非 0 表示有命中。
 */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { findLeaks } from './lib/leak-rules.mjs'

const REPO = resolve(process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'))

function git (...args) {
  const result = spawnSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  return result.stdout ?? ''
}

try {
  git('rev-parse', '--git-dir')
} catch (error) {
  console.error(`不是 git 仓库：${REPO}（${error.message}）`)
  process.exit(2)
}

// 每个对象都要记录「它出现在哪些路径上」：同一个 blob 可能被多个路径引用
const objects = new Map()
for (const line of git('rev-list', '--objects', '--all').split('\n')) {
  const space = line.indexOf(' ')
  if (space === -1) continue
  const sha = line.slice(0, space)
  const path = line.slice(space + 1)
  if (path === '') continue
  if (!objects.has(sha)) objects.set(sha, new Set())
  objects.get(sha).add(path)
}

const BINARY_PATH = /\.(?:tgz|png|jpg|jpeg|webp|gif|ico|zst|woff2?|wasm)$/i
const hits = []
let blobs = 0
let skipped = 0

for (const [sha, paths] of objects) {
  const type = spawnSync('git', ['-C', REPO, 'cat-file', '-t', sha], { encoding: 'utf8' }).stdout?.trim()
  if (type !== 'blob') continue
  blobs += 1
  const textPaths = [...paths].filter((p) => !BINARY_PATH.test(p))
  if (textPaths.length === 0) {
    skipped += 1
    continue
  }
  const content = spawnSync('git', ['-C', REPO, 'cat-file', '-p', sha], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).stdout
  if (typeof content !== 'string') continue
  for (const hit of findLeaks(content)) {
    hits.push({ sha, paths: textPaths, ...hit })
  }
}

// 命中的 blob 出现在哪些提交上？—— 报错要直接告诉人「该改哪些提交」，而不是只给一个 SHA
const commitsTouching = new Map()
for (const hit of hits) {
  if (commitsTouching.has(hit.sha)) continue
  const revs = git('log', '--all', '--format=%h %s', '--find-object=' + hit.sha).trim().split('\n').filter(Boolean)
  commitsTouching.set(hit.sha, revs.slice(0, 5))
}

console.log(`扫描 ${REPO}`)
console.log(`  blob 总数：${blobs}${skipped > 0 ? `（其中 ${skipped} 个只在二进制路径上，已跳过）` : ''}`)
console.log(`  标签：${git('tag').trim().split('\n').filter(Boolean).join(' ') || '（无）'}`)

if (hits.length === 0) {
  console.log('  ✓ 全历史（含所有标签）未发现泄露的开发机路径、主机名或凭据')
  process.exit(0)
}

console.log(`  ✗ 命中 ${hits.length} 处：\n`)
for (const hit of hits) {
  console.log(`  [${hit.sha.slice(0, 8)}] ${hit.paths.join(', ')}:${hit.line}`)
  console.log(`      ${hit.what}：${hit.text}`)
}
console.log('\n  出现在这些提交上：')
for (const [sha, revs] of commitsTouching) {
  console.log(`  ${sha.slice(0, 8)}:`)
  for (const rev of revs) console.log(`      ${rev}`)
}
console.log('\n  处理步骤见 PUBLISHING.md 第 8 节（改写历史 + 强推 + 清理旧对象）。')
process.exit(1)
