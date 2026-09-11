#!/usr/bin/env node
/**
 * 发布前不变量检查（`npm run release:check`）。
 *
 * 这个脚本把「发版时必须成立、但很容易忘」的事情变成机械检查：
 *   1. package.json 的版本号是合法 semver，且 CHANGELOG.md 里有对应段落；
 *   2. npm `files` 白名单真的覆盖了运行期需要的文件，且这些文件都存在；
 *   3. main / exports 指向的文件存在（发布出去的包必须能 import）；
 *   4. peerDependencies 覆盖了代码里真正 import 的宿主包；
 *   5. lib/client.js 保持 classic script（一旦误加 import/export，浏览器端会整体崩掉）；
 *   6. 源码里没有泄漏开发机的绝对路径或口令；
 *   7. cordis.patch.yml 仍在插入插件行。
 *
 * 只依赖 Node 标准库，退出码非 0 表示有阻塞项。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const notes = []

function fail (message) {
  failures.push(message)
}

function readJson (rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) {
    fail(`缺少文件：${rel}`)
    return undefined
  }
  try {
    return JSON.parse(readFileSync(abs, 'utf8'))
  } catch (error) {
    fail(`${rel} 不是合法 JSON：${error.message}`)
    return undefined
  }
}

/* ---------- 1. 版本号与 CHANGELOG ---------- */

const pkg = readJson('package.json')
if (!pkg) {
  report()
  process.exit(1)
}

const version = pkg.version
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
if (typeof version !== 'string' || !SEMVER.test(version)) {
  fail(`package.json version 不是合法 semver：${JSON.stringify(version)}`)
}
if (pkg.private === true) {
  fail('package.json 里 private: true 会让 npm publish 直接失败')
}

const changelog = existsSync(join(ROOT, 'CHANGELOG.md'))
  ? readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  : undefined
if (changelog === undefined) {
  fail('缺少 CHANGELOG.md')
} else if (!changelog.split('\n').some(line => line.startsWith('## ') && line.includes(version))) {
  fail(`CHANGELOG.md 里没有 ${version} 的段落（应以 "## ${version}" 开头）`)
} else {
  notes.push(`CHANGELOG.md 含有 ${version} 段落`)
}

/* ---------- 2. files 白名单与实际文件 ---------- */

const REQUIRED = [
  'LICENSE',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/tmux.js',
  'lib/client.js'
]

for (const rel of REQUIRED) {
  if (!existsSync(join(ROOT, rel))) fail(`缺少运行期/发布必需文件：${rel}`)
}

const files = Array.isArray(pkg.files) ? pkg.files : []
if (files.length === 0) {
  fail('package.json 没有 files 白名单：会把开发文件一起发出去')
}
for (const entry of ['lib', 'cordis.patch.yml', 'README.md', 'README.en.md', 'CHANGELOG.md', 'LICENSE']) {
  if (!files.includes(entry)) fail(`files 白名单缺少 ${entry}`)
}
// 运行期入口不许漏在自己的白名单之外
const libFiles = existsSync(join(ROOT, 'lib')) ? readdirSync(join(ROOT, 'lib')) : []
if (!files.includes('lib') && libFiles.some(f => f.endsWith('.js'))) {
  fail('lib/*.js 不在 files 白名单里')
}
notes.push(`files 白名单：${files.join(', ')}`)

/* ---------- 3. 入口文件存在 ---------- */

const entries = []
if (typeof pkg.main === 'string') entries.push(pkg.main)
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  const target = typeof value === 'string' ? value : value?.default
  if (typeof target === 'string' && target.endsWith('.js')) entries.push(`${key} -> ${target}`)
}
for (const entry of entries) {
  const raw = entry.includes(' -> ') ? entry.split(' -> ')[1] : entry
  const rel = raw.replace(/^\.\//, '')
  if (!existsSync(join(ROOT, rel))) fail(`入口指向不存在的文件：${entry}`)
  if (!files.some(f => rel === f || rel.startsWith(`${f}/`))) {
    fail(`入口 ${entry} 不在 files 白名单里（发布后会 404）`)
  }
}

/* ---------- 4. peerDependencies 与真实 import 对齐 ---------- */

const PEERS = {
  '@deepseek-ai/cordis': 'host',
  '@deepseek-ai/dsh-tools': 'host',
  '@deepseek-ai/schemastery': 'host',
  react: 'client'
}
const peers = pkg.peerDependencies ?? {}
for (const name of Object.keys(PEERS)) {
  if (!(name in peers)) fail(`peerDependencies 缺少 ${name}`)
}
for (const name of Object.keys(peers)) {
  if (!(name in PEERS)) {
    notes.push(`peerDependencies 里的 ${name} 未在检查表中登记（确认是有意为之）`)
  }
}
if (pkg.license !== 'MIT') {
  fail(`license 字段应为 MIT，当前为 ${JSON.stringify(pkg.license)}`)
}
if (!existsSync(join(ROOT, 'LICENSE'))) fail('缺少 LICENSE 文件')
notes.push(`peerDependencies：${Object.keys(peers).join(', ')}`)

/* ---------- 5. client.js 必须是 classic script ---------- */

const clientPath = join(ROOT, 'lib/client.js')
if (existsSync(clientPath)) {
  const client = readFileSync(clientPath, 'utf8')
  const esmLine = client.split('\n').findIndex(line => /^\s*(import|export)\s/.test(line))
  if (esmLine !== -1) {
    fail(`lib/client.js:${esmLine + 1} 出现 ESM 语法；客户端是 classic script，只能用 require()`)
  }
  if (!client.includes('__ModuleLoader__')) {
    fail('lib/client.js 里找不到 __ModuleLoader__.load(，客户端插件可能没注册')
  }
  if (!client.includes('shell.overlay')) {
    fail('lib/client.js 里找不到 shell.overlay，面板不会挂到任何 slot 上')
  }
  // 面板显示的版本必须与 package.json 同步，否则用户报障时报的版本是错的
  const stamp = client.match(/const\s+PKG_VERSION\s*=\s*'([^']*)'/)
  if (stamp === null) {
    fail("lib/client.js 里找不到 const PKG_VERSION = '...'（面板无法显示包版本）")
  } else if (pkg.version !== undefined && stamp[1] !== pkg.version) {
    fail(`lib/client.js 的 PKG_VERSION=${stamp[1]} 与 package.json 的 ${pkg.version} 不一致`)
  } else {
    notes.push(`client.js 版本戳记 PKG_VERSION=${stamp[1]} 与 package.json 一致`)
  }
  notes.push(`client.js：${client.length} 字符，classic script 形态正常`)
}

/* ---------- 6. 不泄漏开发机信息 ---------- */

const SCAN = ['lib/index.js', 'lib/tmux.js', 'lib/client.js', 'cordis.patch.yml', 'package.json']
const LEAK = [
  [/\/home\/[A-Za-z0-9._-]+\//, '开发机 /home/<user>/ 绝对路径'],
  [/\/Users\/[A-Za-z0-9._-]+\//, '开发机 /Users/<user>/ 绝对路径'],
  [/C:\\\\Users\\\\/, '开发机 Windows 绝对路径'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥内容'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token']
]
for (const rel of SCAN) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) continue
  readFileSync(abs, 'utf8').split('\n').forEach((line, index) => {
    for (const [pattern, what] of LEAK) {
      if (pattern.test(line)) fail(`${rel}:${index + 1} 疑似泄漏${what}：${line.trim().slice(0, 80)}`)
    }
  })
}
notes.push('未发现泄漏的开发机路径或凭据')

/* ---------- 7. bundle patch ---------- */

const patchPath = join(ROOT, 'cordis.patch.yml')
if (existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8')
  if (!patch.includes('insert:')) fail('cordis.patch.yml 里没有 insert:，bundle 不会插入插件')
  if (!/^\s*- id: agent-shell\s*$/m.test(patch)) {
    fail('cordis.patch.yml 里的插件行 id 应为 agent-shell')
  }
  if (!/name:\s*'dsh-agent-shell'/.test(patch)) {
    fail("cordis.patch.yml 里的 name 应为 'dsh-agent-shell'（否则解析不到本包）")
  }
  notes.push('cordis.patch.yml 结构正常')
}

report()

function report () {
  for (const note of notes) console.log(`  · ${note}`)
  if (failures.length === 0) {
    console.log(`\nrelease:check 通过（${pkg.name}@${pkg.version}）`)
    return
  }
  console.error(`\nrelease:check 失败，共 ${failures.length} 项：`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exitCode = 1
}
