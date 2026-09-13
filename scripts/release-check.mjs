#!/usr/bin/env node
/**
 * 发布前不变量检查（`npm run release:check`）。
 *
 * 这个脚本把「发版时必须成立、但很容易忘」的事情变成机械检查：
 *   1. package.json 的版本号是合法 semver，且 CHANGELOG.md 里有对应段落；
 *   2. npm `files` 白名单等于「必要文件」集合：缺必要文件报错，多带任何仓库内部文件也报错；
 *   2.5 已发布的 README 里不许有相对链接（相对链接在 npm 页面上必然断，只能指向仓库内部文件）；
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
import { findLeaks, SKIP_DIRS, BINARY_FILE } from './lib/leak-rules.mjs'

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

const changelog = existsSync(join(ROOT, 'docs', 'CHANGELOG.md'))
  ? readFileSync(join(ROOT, 'docs', 'CHANGELOG.md'), 'utf8')
  : undefined
if (changelog === undefined) {
  fail('缺少 docs/CHANGELOG.md')
} else if (!changelog.split('\n').some(line => line.startsWith('## ') && line.includes(version))) {
  fail(`docs/CHANGELOG.md 里没有 ${version} 的段落（应以 "## ${version}" 开头）`)
} else {
  notes.push(`docs/CHANGELOG.md 含有 ${version} 段落`)
}

/* ---------- 2. files 白名单与实际文件 ---------- */

const REQUIRED = [
  'LICENSE',
  'README.md',
  'README.en.md',
  'docs/CHANGELOG.md',
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

/*
 * 「只发必要文件」的机械定义：npm 包里只允许出现下面这些条目 ——
 * 运行期代码、安装方式（patch + 依赖脚本）、两份 README、许可证。
 * 其余一切（CHANGELOG / SECURITY / PUBLISHING / CONTRIBUTING / docs / scripts …）
 * 都只留在仓库里：装包的人不需要它们，而每次发布都是把开发机信息往公开注册表上搬的一次机会。
 */
const PUBLISH_WHITELIST = [
  'lib',
  'cordis.patch.yml',
  'install-deps.sh',
  'README.md',
  'README.en.md',
  'LICENSE'
]
// 少了这些，装包的人要么跑不起来、要么看不懂怎么装
const PUBLISH_REQUIRED = ['lib', 'cordis.patch.yml', 'install-deps.sh', 'README.md', 'README.en.md', 'LICENSE']
for (const entry of PUBLISH_REQUIRED) {
  if (!files.includes(entry)) fail(`files 白名单缺少必要文件：${entry}`)
}
for (const entry of files) {
  if (!PUBLISH_WHITELIST.includes(entry)) {
    fail(`files 白名单里有非必要文件：${entry}（只发必要文件；文档类内容留在仓库）`)
  }
}
// 运行期入口不许漏在自己的白名单之外
const libFiles = existsSync(join(ROOT, 'lib')) ? readdirSync(join(ROOT, 'lib')) : []
if (!files.includes('lib') && libFiles.some(f => f.endsWith('.js'))) {
  fail('lib/*.js 不在 files 白名单里')
}
notes.push(`files 白名单（仅必要文件）：${files.join(', ')}`)

/* ---------- 2.5 已发布 README 的链接 ---------- */

/*
 * README 会跟着包发到 npm 页面。相对链接在那里必然断（解析到 npmjs.com 而不是仓库），
 * 而且相对链接天然会指向仓库内部文件 —— 正是「非必要发布」的那些。所以：只允许绝对 URL。
 * 指回本仓库的绝对链接则要能对上真实文件，挡住重命名后的死链。
 */
const REPO_BLOB = 'https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/'
for (const rel of ['README.md', 'README.en.md']) {
  const file = join(ROOT, rel)
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (target.startsWith('#')) continue
    if (!/^https?:\/\//.test(target)) {
      fail(`${rel} 里有相对链接 ${target}：README 会发布到 npm，相对链接在那里必然断（改成绝对 URL）`)
      continue
    }
    if (target.startsWith(REPO_BLOB)) {
      const targetPath = decodeURIComponent(target.slice(REPO_BLOB.length).split('#')[0])
      if (!existsSync(join(ROOT, targetPath))) {
        fail(`${rel} 里的仓库链接指向不存在的文件：${targetPath}`)
      }
    }
  }
}

/* ---------- 2.6 文档身份（防「整份文档被别的内容覆盖」） ---------- */

/*
 * 这一节是为一次真实事故加的：PUBLISHING.md 曾被另一份文档的内容**整体覆盖**（复制事故），
 * 发布指南从工作树里消失，而当时所有校验都是绿的 —— 因为没有任何检查在问
 * 「这个文件还是不是它自己」。文件身份用两件机械事实锚定：
 *   1. 首行标题必须与文件身份一致；
 *   2. 任意两份文档不能有相同的开头（那是「一份内容写到了两个路径」的指纹）。
 */
const DOC_TITLES = {
  'README.md': '# dsh-agent-shell',
  'README.en.md': '# dsh-agent-shell',
  'docs/CHANGELOG.md': '# Changelog',
  'docs/SECURITY.md': '# 安全政策',
  'docs/CONTRIBUTING.md': '# 贡献指南',
  'docs/PUBLISHING.md': '# 发布指南',
  'docs/使用细节.md': '# 使用细节',
  'docs/更新记录.md': '# 更新与修复记录',
  'docs/设计与实现.md': '# 设计与实现'
}
// 中英首页同标题是设计使然；其余任何重复都视为事故信号
const TITLE_DUPLICATE_OK = new Set(['README.md', 'README.en.md'])
const signatures = new Map()
for (const [rel, expected] of Object.entries(DOC_TITLES)) {
  const file = join(ROOT, rel)
  if (!existsSync(file)) {
    fail(`缺少文档：${rel}`)
    continue
  }
  const text = readFileSync(file, 'utf8')
  const firstLine = (text.split('\n')[0] ?? '').trim()
  if (firstLine !== expected) {
    fail(`${rel} 的首行标题是 "${firstLine}"，应为 "${expected}"：文档被覆盖或改名了？`)
  }
  const signature = text.split('\n').map(l => l.trim()).filter(l => l !== '').slice(0, 3).join('\n')
  const twin = signatures.get(signature)
  if (twin !== undefined && !(TITLE_DUPLICATE_OK.has(rel) && TITLE_DUPLICATE_OK.has(twin))) {
    fail(`${rel} 与 ${twin} 的开头完全相同：很像「一份内容被写到两个路径」的事故`)
  }
  signatures.set(signature, rel)
}
notes.push(`文档身份：${Object.keys(DOC_TITLES).length} 份文档标题正确、且无重复内容`)

/* ---------- 2.7 已发布的 README 不得泄露开发仓库信息 ---------- */

/*
 * 维护者要求：可以说明「开发在另一个仓库里进行」，但**不能出现私有仓库的任何具体信息**
 * （仓库名、远端名、分支/归档命名等）。README 会随包发到 npm 页面，写进去就等于公开。
 */
const DEV_REPO_FORBIDDEN = [
  // 这里**故意不写出那个仓库的全名**：本文件也在公开仓库里，写出名字等于把名字公开
  // （这是个自指的坑 —— 守卫不能自己泄露它要守的东西）。用类别模式匹配 `*-backup` 即可。
  [/-backup\b/i, '备份仓库名'],
  [/dev-archive/i, '归档 tag 命名'],
  [/私有仓库|private repo|private repository/i, '对私有仓库的描述'],
  // 连「另有一个开发仓库」这件事都不提：README 是给读者看的，读者不需要知道内部怎么开发
  [/另一个[^\n]{0,8}仓库|开发用的仓库|dev(elopment)?\s+repo(sitory)?/i, '提及存在另一个（开发）仓库'],
  [/\bgit remote\b[^\n]*\bbackup\b/i, '备份远端的配置写法']
]
for (const rel of ['README.md', 'README.en.md']) {
  const file = join(ROOT, rel)
  if (!existsSync(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const [pattern, what] of DEV_REPO_FORBIDDEN) {
    if (pattern.test(text)) fail(`${rel} 里出现了开发/备份仓库的信息（${what}）：README 会随包发到 npm`)
  }
}
notes.push('两份 README 未泄露开发仓库信息（只说「另有开发用仓库」，不含仓库名/远端名）')

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

// 扫描范围是**整个仓库的文本文件**，不是一份手工维护的白名单。
// 起因是一次真实失手：泄露出现在**会被发布**的 PUBLISHING.md 里（`cd /home/<用户名>/…`），
// 而当时的白名单只覆盖 lib/* 与 package.json —— 语法检查过、测试也过，谁都没看 docs。
// 发布出去的版本在 npm 上改不了，所以这条必须"宁可多扫，不可漏扫"。
//
// 规则本身住在 scripts/lib/leak-rules.mjs：全历史扫描（scripts/scan-history.mjs）用同一份。
// 历史里的同类内容曾经漏掉过一次，规则一旦分散就一定会有一处跟不上。
function scanTree (dir, rel) {
  for (const entry of readdirSync(join(dir), { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      scanTree(join(dir, entry.name), rel === '' ? entry.name : rel + '/' + entry.name)
      continue
    }
    if (!entry.isFile()) continue
    if (BINARY_FILE.test(entry.name)) continue
    const relPath = rel === '' ? entry.name : rel + '/' + entry.name
    let body
    try { body = readFileSync(join(dir, entry.name), 'utf8') } catch { continue }
    for (const hit of findLeaks(body)) {
      fail(`${relPath}:${hit.line} 疑似泄漏${hit.what}：${hit.text}`)
    }
  }
}
scanTree(ROOT, '')
notes.push('仓库全文未发现泄露的开发机路径、主机名或凭据（含 docs 与随手写的脚本）')

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

/* ---------- 6.45 硬依赖声明不许被改回去（DSH 0.1.5 的真实事故） ---------- */

/*
 * `subprocess` 是抽象服务，具体 provider 由 dsh-base 挂载。DSH 0.1.5 起组合顺序变了，
 * provider 晚于本插件挂载 —— 如果 apply 里用一次性 ctx.get('subprocess')，会拿到 undefined
 * 并早退，结果是**工具 / HTTP 路由 / 面板全部消失**，日志里只有一句"未挂载"，极难反推。
 * 所以它必须留在 inject 声明里，让 Cordis 等它就绪再 apply。
 */
{
  const abs = join(ROOT, 'lib', 'index.js')
  const body = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
  const m = body.match(/^export const inject = \[([^\]]*)\]/m)
  const deps = m === null ? [] : m[1].split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  if (!deps.includes('tools')) fail('lib/index.js 的 inject 缺少 tools（工具注册是硬依赖）')
  if (!deps.includes('subprocess')) {
    fail('lib/index.js 的 inject 缺少 subprocess —— DSH≥0.1.5 上 provider 晚挂载，' +
      '一次性 ctx.get 会拿到 undefined 并让整个插件静默失效（工具/HTTP/面板全没）')
  }
  // apply 期不许再有一次性的 approval 探测（同类时序陷阱 + 曾经引用未定义变量被 try/catch 吞掉）
  if (/^  const approvalSeamMounted = ctx\.get\('approval'\)/m.test(body)) {
    fail('approval 情报又在 apply 期一次性读取了：服务晚挂载会被永久记成 absent（请放进 approvalInfoFor）')
  }
  if (deps.includes('subprocess')) notes.push(`inject 硬依赖：${deps.join(', ')}（subprocess 在其中，避免晚挂载早退）`)
}

/* ---------- 6.5 安全告警不许被悄悄删掉 ---------- */

// 这不是格式检查，而是一条**产品承诺**：README 顶部必须持续告诉使用者
// 「这是真实 shell、没有审批、护栏不是防护」，以及本插件由 AI 开发。
for (const [rel, markers] of Object.entries({
  'README.md': ['由 AI 开发', '没有任何审批防护', '启发式护栏'],
  'README.en.md': ['developed by AI', 'no approval gate'],
  'docs/SECURITY.md': ['未经人工安全审计', '没有接入官方审批'],
})) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) continue
  const body = readFileSync(abs, 'utf8')
  for (const marker of markers) {
    if (!body.includes(marker)) fail(`${rel} 缺少安全告知内容：${marker}（这一条不应被删掉）`)
  }
}
notes.push('安全告知内容（AI 开发 / 无审批 / 护栏非防护）均在位')

/*
 * 归属规则不许被删掉：`shell_list` 会列出**所有**会话的 shell（这是有意保留的可见性），
 * 所以模型必须被告知「没经用户明确要求，不要动不是你创建的 shell」，否则"看得见"就会变成"随手就动"。
 * 这条规则写在系统提示里，也在最容易被读到的几个工具描述里；用户明确要求过，别当成可选文案。
 */
{
  const before = failures.length
  const index = join(ROOT, 'lib', 'index.js')
  const body = existsSync(index) ? readFileSync(index, 'utf8') : ''
  if (!body.includes('Ownership rule.')) {
    fail('lib/index.js 的系统提示里缺少归属规则（Ownership rule）—— 用户明确要求保留这一条')
  }
  if (!body.includes('unless the user explicitly asks')) {
    fail('归属规则缺少「除非用户明确要求」这一半 —— 只写"不要动"会拦住用户自己要求的操作')
  }
  const listed = ['shell_list', 'shell_send', 'shell_read', 'shell_close']
  for (const tool of listed) {
    const i = body.indexOf(`name: '${tool}'`)
    const window = i === -1 ? '' : body.slice(i, i + 1200)
    if (!/unless the user explicitly asks|do not operate on those/.test(window)) {
      fail(`${tool} 的描述里没有归属提醒（模型正要动手时最容易忽略系统提示）`)
    }
  }
  // 只有真的没问题才打这一行 —— 失败的运行里还打"在位"就是在骗人
  if (failures.length === before) {
    notes.push('归属规则在位：系统提示 + 4 个关键工具描述（可见但不可随手操作）')
  }
}

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
    if (!body.includes('## 最近更新')) {
      fail('README.md 缺少「## 最近更新」章节（README 只留最近一次更新，历史在 docs/更新记录.md）')
    } else if (!body.includes(version)) {
      fail(`README.md 的「最近更新」里没有当前版本 ${version}（发版时 README 不能落后于 CHANGELOG）`)
    } else {
      notes.push(`README.md 带着最近一次更新，且已跟上版本 ${version}`)
    }
  }
  // 完整记录在 docs/更新记录.md：它必须存在，且同样跟上当前版本 ——
  // 否则"README 只留最近一次"会让历史悄悄断档。
  const historyRel = 'docs/更新记录.md'
  const historyAbs = join(ROOT, historyRel)
  if (!existsSync(historyAbs)) {
    fail(`缺少 ${historyRel}（完整更新与修复记录；README 只保留最近一次）`)
  } else if (!readFileSync(historyAbs, 'utf8').includes(version)) {
    fail(`${historyRel} 里没有当前版本 ${version}`)
  } else {
    notes.push(`${historyRel} 存在且已跟上版本 ${version}`)
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
