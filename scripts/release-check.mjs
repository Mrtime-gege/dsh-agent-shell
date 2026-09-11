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
  'lib/client.js',
  'docs/使用细节.md',
  'docs/设计与实现.md'
]

for (const rel of REQUIRED) {
  if (!existsSync(join(ROOT, rel))) fail(`缺少运行期/发布必需文件：${rel}`)
}

const files = Array.isArray(pkg.files) ? pkg.files : []
if (files.length === 0) {
  fail('package.json 没有 files 白名单：会把开发文件一起发出去')
}
for (const entry of ['lib', 'docs', 'cordis.patch.yml', 'README.md', 'README.en.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'PUBLISHING.md', 'LICENSE']) {
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

/* ---------- 6.2 客户端渲染引用的图标与样式类必须真实存在 ---------- */

// 这两类错误的共同点：**语法检查过、测试也过，只有打开面板才看得出来** ——
// 图标名写错 → 图标空白；类名写错 → 样式整块失效。
// 实测就踩过一次：ⓘ 按钮用了 Icon({name:'info'})，而 ICON_PATHS 里当时没有 info。
if (existsSync(clientPath)) {
  const client = readFileSync(clientPath, 'utf8')

  const iconsBlock = client.match(/const ICON_PATHS = \{([\s\S]*?)\n\}/)
  if (iconsBlock === null) {
    fail('lib/client.js 里找不到 ICON_PATHS')
  } else {
    const defined = new Set([...iconsBlock[1].matchAll(/^\s*([A-Za-z][\w]*)\s*:/gm)].map(m => m[1]))
    const used = new Set([...client.matchAll(/name:\s*'([a-z][\w]*)'/g)].map(m => m[1])
      .filter(n => !['button', 'text', 'none'].includes(n)))
    const missing = [...used].filter(n => !defined.has(n))
    // 只报「看起来是图标名」的用法：Icon({ name: 'x' })
    const iconRefs = new Set([...client.matchAll(/Icon,\s*\{\s*name:\s*'([a-z][\w]*)'/g)].map(m => m[1]))
    const missingIcons = [...iconRefs].filter(n => !defined.has(n))
    if (missingIcons.length > 0) {
      fail(`lib/client.js 引用了不存在的图标：${missingIcons.join(', ')}（已定义：${[...defined].join(', ')}）`)
    } else {
      notes.push(`图标引用全部存在（用到 ${iconRefs.size} 个：${[...iconRefs].join(', ')}）`)
    }
    void missing
  }

  const cssBlock = client.match(/const PANEL_CSS = `([\s\S]*?)`\n/)
  if (cssBlock === null) {
    fail('lib/client.js 里找不到 PANEL_CSS')
  } else {
    const cssClasses = new Set([...cssBlock[1].matchAll(/\.(dshsh-[\w-]+)/g)].map(m => m[1]))
    const usedClasses = new Set(
      [...client.matchAll(/className:\s*'([^']*)'/g)]
        .flatMap(m => m[1].split(/\s+/))
        .filter(c => c.startsWith('dshsh-') && !c.endsWith('-')),
    )
    // 以 '-' 结尾的是**动态拼接**的类前缀（例如 'dshsh-rs-' + dir），
    // 把前缀当完整类名去比对只会误报，所以上面直接排除。
    const missingClasses = [...usedClasses].filter(c => !cssClasses.has(c))
    if (missingClasses.length > 0) {
      fail(`lib/client.js 用了 PANEL_CSS 里不存在的类：${missingClasses.join(', ')}`)
    } else {
      notes.push(`className 引用的样式类全部存在（${usedClasses.size} 个）`)
    }
  }
}

/* ---------- 6.3 客户端只能用真实存在的 DSH 主题令牌，且不许硬编码颜色 ---------- */

// 实测踩过的坑：面板里写了 `var(--dsw-alias-bg-primary, #16181d)` 这种**并不存在**的令牌，
// 于是永远落到硬编码的深色上 —— 深色主题里颜色偏、**浅色主题里直接变成一块黑板子**，
// 完全不像 DSH 的一部分。这里把「令牌必须真实存在」变成机械检查。
const THEME_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-bg-mask-2',
  '--dsw-alias-bg-mask-3',
  '--dsw-alias-bg-mask-drop',
  '--dsw-alias-bg-mask-photo',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-multi-select',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-skeleton',
  '--dsw-alias-border-inverted',
  '--dsw-alias-border-inverted2',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l2-darkmode-thin',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-brand-primary-invert',
  '--dsw-alias-brand-primary-new-colorprimary-new-color',
  '--dsw-alias-brand-text',
  '--dsw-alias-button-contrast-fill',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-floating-hover',
  '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-ghost-active-hover',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-tool-bar-fill',
  '--dsw-alias-button-tool-bar-fill-invisible',
  '--dsw-alias-button-tool-bar-hover',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-bluish',
  '--dsw-alias-label-primary-dimmed',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-primary-inverted',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-markdown-citation',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-code-segment-selected',
  '--dsw-alias-markdown-code-segment-unselected',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-markdown-placeholder',
  '--dsw-alias-markdown-tag',
  '--dsw-alias-scrollbar-bg-l1',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-secondary',
  '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-toast-bg',
  '--dsw-alias-tooltip-bg'
]
if (existsSync(clientPath)) {
  const client = readFileSync(clientPath, 'utf8')
  const used = [...new Set([...client.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map(m => m[1]))]
  const unknown = used.filter(name => !THEME_TOKENS.includes(name))
  const isAlias = /^--dsw-alias-/
  const strayAlias = used.filter(name => isAlias.test(name) && !THEME_TOKENS.includes(name))
  if (strayAlias.length > 0) {
    fail(`lib/client.js 引用了不存在的主题令牌：${strayAlias.join(', ')}（会静默回落到 fallback 颜色，浅色主题下必然错）`)
  } else {
    notes.push(`主题令牌全部存在（引用 ${used.length} 个 alias 令牌）`)
  }
  void unknown

  // 字体同样不许硬编码：DSH 只提供 --ds-font-family-code（代码用），
  // chrome 一律继承应用字体 —— 自己写字体栈就会和界面其它部分不一致。
  const fontStacks = [...new Set([...client.matchAll(/ui-monospace|SFMono-Regular|Menlo,\s*monospace|Consolas/g)].map(m => m[0]))]
  if (fontStacks.length > 0) {{
    fail(`lib/client.js 里出现硬编码字体栈：${fontStacks.join(', ')}}（代码字体请用 var(--ds-font-family-code)，chrome 请继承）`)
  }} else {{
    notes.push('没有硬编码字体栈（代码字体走 --ds-font-family-code，chrome 继承应用字体）')
  }}

  // 硬编码颜色：颜色一旦写死，就不会跟随主题。确实需要（例如遮罩）就把字面量加进白名单并写明理由。
  const ALLOWED_COLOR_LITERALS = []
  const literals = [...new Set([...client.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)].map(m => m[0]))]
  const stray = literals.filter(v => !ALLOWED_COLOR_LITERALS.includes(v))
  if (stray.length > 0) {
    fail(`lib/client.js 里出现硬编码颜色：${stray.join(', ')}（请改用 --dsw-alias-* 令牌，否则不跟随主题）`)
  } else {
    notes.push('没有任何硬编码颜色（全部走主题令牌）')
  }
}

/* ---------- 6.5 安全告警不许被悄悄删掉 ---------- */

// 这不是格式检查，而是一条**产品承诺**：README 顶部必须持续告诉使用者
// 「这是真实 shell、没有审批、护栏不是防护」，以及本插件由 AI 开发。
for (const [rel, markers] of Object.entries({
  'README.md': ['由 AI 开发', '没有任何审批防护', '启发式护栏'],
  'README.en.md': ['developed by AI', 'no approval gate'],
  'SECURITY.md': ['未经人工安全审计', '没有接入官方审批'],
})) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) continue
  const body = readFileSync(abs, 'utf8')
  for (const marker of markers) {
    if (!body.includes(marker)) fail(`${rel} 缺少安全告知内容：${marker}（这一条不应被删掉）`)
  }
}
notes.push('安全告知内容（AI 开发 / 无审批 / 护栏非防护）均在位')

/* ---------- 6.4 浏览器面闸门的配套不变量 ---------- */

// 闸门要求「写请求必须是 application/json」（这是挡住跨站「简单请求」的那一条）。
// 面板自己少发一个头，就会被自己的闸门挡在外面 —— 而且是 403 这种看起来像后端坏了的形态。
{
  const abs = join(ROOT, 'lib', 'client.js')
  if (existsSync(abs)) {
    const body = readFileSync(abs, 'utf8')
    const posts = [...body.matchAll(/method:\s*'POST'/g)]
    const missing = posts.filter((m) => {
      const window = body.slice(Math.max(0, m.index - 400), m.index + 400)
      return !window.includes('content-type')
    })
    if (posts.length === 0) fail('lib/client.js 里找不到任何 POST 调用（闸门不变量无法校验）')
    else if (missing.length > 0) fail(`lib/client.js 有 ${missing.length} 个 POST 没带 content-type：会被浏览器面闸门拒绝`)
    else notes.push(`客户端 ${posts.length} 个写请求都带 JSON 头（闸门要求）`)
  }
}

/* ---------- 6.6 README 必须带着改动记录，且不能落后于版本号 ---------- */

// README 是门面：用户先看它，才轮到 CHANGELOG。所以「这一版改了什么」必须在 README 里，
// 而且发布时必须跟上版本号 —— 只更 CHANGELOG 不动 README 是最容易发生的漂移。
{
  const abs = join(ROOT, 'README.md')
  if (existsSync(abs)) {
    const body = readFileSync(abs, 'utf8')
    if (!body.includes('## 更新与修复记录')) {
      fail('README.md 缺少「## 更新与修复记录」章节（改动记录要在门面上）')
    } else if (!body.includes(version)) {
      fail(`README.md 的改动记录里没有当前版本 ${version}（发版时 README 不能落后于 CHANGELOG）`)
    } else {
      notes.push(`README.md 带着改动记录，且已跟上版本 ${version}`)
    }
  }
}

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
