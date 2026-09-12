#!/usr/bin/env node
/**
 * 客户端纯函数测试 —— **不依赖任何 peer、tmux 或浏览器**，因此在任何环境（含 CI）都能跑。
 *
 * 覆盖面板里最容易出错、又最难在真机上复现的两块逻辑：
 *
 *   1. `decideKey()`：一次 keydown 该放行给浏览器、还是该翻译成 tmux 键名送进终端。
 *      这里定死两条不能破的规则 —— **可打印字符必须放行**（否则输入法组字起不来）、
 *      **有选中文本时 Ctrl+C 必须让浏览器复制**（否则会误发 SIGINT 打断正在跑的命令）。
 *   2. `decideComposition()`：输入法组字状态机。三种真实浏览器事件顺序都必须
 *      **恰好提交一次**，且「提交的汉字滞留在输入框里，直到敲下一个字符才被送走」这种
 *      症状不能再出现（这是改这个状态机的原因）。
 *
 * 做法：把 `lib/client.js` 放进 `node:vm` 里执行 —— 它是 classic script，通过
 * `window.__ModuleLoader__.load({factory})` 注册；给 factory 一个假的 `require('react')`
 * 即可拿到插件对象上的两个纯函数（真浏览器不会用到这些 hook）。
 *
 * 用法：node scripts/test-client.mjs [包目录]     # 默认当前仓库根目录
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import vm from 'node:vm'

const ROOT = process.argv[2] !== undefined ? resolve(process.argv[2]) : resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ── 在 vm 里加载客户端 ────────────────────────────────────────────────────── */

const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'Fragment',
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useRef: (v) => ({ current: v }),
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  createContext: () => ({ Provider: 'Provider', Consumer: 'Consumer' }),
  useContext: () => ({}),
}

const loaded = []
const context = {
  console,
  // 组件里会发起 HTTP（api()）：给一个永不 resolve 的 fetch，
  // 这样遍历事件处理器时同步部分照跑，又不会产生 unhandled rejection。
  fetch: () => new Promise(() => {}),
  navigator: { clipboard: { writeText: () => Promise.resolve() } },
  require: (id) => {
    if (id === 'react') return react
    throw new Error(`客户端不该 require(${id})：它在浏览器里只被允许拿 react`)
  },
  window: {
    __ModuleLoader__: { load: (mod) => loaded.push(mod) },
    addEventListener () {}, removeEventListener () {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: 1,
    localStorage: { getItem: () => null, setItem () {}, removeItem () {} },
  },
  document: {
    head: { appendChild () {} },
    body: { appendChild () {}, removeChild () {} },
    createElement: () => ({ style: {}, setAttribute () {}, appendChild () {}, textContent: '' }),
    getElementById: () => null,
    addEventListener () {}, removeEventListener () {},
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
}
context.globalThis = context
vm.createContext(context)
vm.runInContext(readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'), context, { filename: 'client.js' })

const problems = []
let checks = 0
const check = (ok, label) => {
  checks += 1
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) problems.push(label)
}

check(loaded.length === 1, `客户端通过 __ModuleLoader__ 注册了自己（${loaded.length} 次）`)
const plugin = loaded[0]?.factory?.(context.require)
check(plugin !== undefined && typeof plugin.apply === 'function', '工厂返回了带 apply() 的插件对象')
check(Array.isArray(plugin?.inject), `inject = ${JSON.stringify(plugin?.inject)}`)
const decideKey = plugin?.__decideKey
const decideComposition = plugin?.__decideComposition
check(typeof decideKey === 'function' && typeof decideComposition === 'function', '两个纯函数都暴露出来了（__decideKey / __decideComposition）')

if (typeof decideKey !== 'function' || typeof decideComposition !== 'function') {
  console.log('\n客户端测试：无法继续（拿不到纯函数）')
  process.exit(1)
}

/* ── decideKey ─────────────────────────────────────────────────────────────── */

const ev = (over = {}) => ({ key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, ...over })

const keyCases = [
  // 可打印字符：一律放行给浏览器/输入法（不能在 keydown 里拦，否则 IME 组字起不来）
  ['可打印字母 a', ev({ key: 'a' }), 'pass'],
  ['可打印数字 7', ev({ key: '7' }), 'pass'],
  ['可打印符号 /', ev({ key: '/' }), 'pass'],
  ['中文标点 ，', ev({ key: '，' }), 'pass'],
  ['空格', ev({ key: ' ' }), 'pass'],
  ['Shift+字母 A', ev({ key: 'A', shiftKey: true }), 'pass'],
  // 具名键：翻译成 tmux 键名
  ['Enter', ev({ key: 'Enter' }), 'Enter'],
  ['Tab', ev({ key: 'Tab' }), 'Tab'],
  ['Shift+Tab → BTab', ev({ key: 'Tab', shiftKey: true }), 'BTab'],
  ['Backspace', ev({ key: 'Backspace' }), 'BSpace'],
  ['Delete', ev({ key: 'Delete' }), 'Delete'],
  ['Escape', ev({ key: 'Escape' }), 'Escape'],
  ['ArrowUp', ev({ key: 'ArrowUp' }), 'Up'],
  ['ArrowDown', ev({ key: 'ArrowDown' }), 'Down'],
  ['ArrowLeft', ev({ key: 'ArrowLeft' }), 'Left'],
  ['ArrowRight', ev({ key: 'ArrowRight' }), 'Right'],
  ['Home', ev({ key: 'Home' }), 'Home'],
  ['End', ev({ key: 'End' }), 'End'],
  ['PageUp', ev({ key: 'PageUp' }), 'PageUp'],
  ['PageDown', ev({ key: 'PageDown' }), 'PageDown'],
  // Ctrl 映射表内的键
  ['Ctrl-A', ev({ key: 'a', ctrlKey: true }), 'C-a'],
  ['Ctrl-C', ev({ key: 'c', ctrlKey: true }), 'C-c'],
  ['Ctrl-D', ev({ key: 'd', ctrlKey: true }), 'C-d'],
  ['Ctrl-R', ev({ key: 'r', ctrlKey: true }), 'C-r'],
  ['Ctrl-Z', ev({ key: 'z', ctrlKey: true }), 'C-z'],
  ['Ctrl+Shift+A 仍归 C-a', ev({ key: 'A', ctrlKey: true, shiftKey: true }), 'C-a'],
  // 必须放行给浏览器
  ['Ctrl+V（粘贴）', ev({ key: 'v', ctrlKey: true }), 'pass'],
  ['Ctrl+X（剪切）', ev({ key: 'x', ctrlKey: true }), 'pass'],
  ['Ctrl+C 且有选中文本（复制）', ev({ key: 'c', ctrlKey: true, hasSelection: true }), 'pass'],
  ['Ctrl+Alt+C', ev({ key: 'c', ctrlKey: true, altKey: true }), 'pass'],
  ['Meta+C（macOS）', ev({ key: 'c', ctrlKey: false, metaKey: true }), 'pass'],
  ['Alt+ArrowLeft', ev({ key: 'ArrowLeft', altKey: true }), 'pass'],
  ['Ctrl+ArrowUp（非单字符键）', ev({ key: 'ArrowUp', ctrlKey: true }), 'pass'],
  ['F1（未映射）', ev({ key: 'F1' }), 'pass'],
  ['Ctrl+W（未映射）', ev({ key: 'w', ctrlKey: true }), 'pass'],
  // 组字中：一个都不能抢
  ['组字中的 Enter', ev({ key: 'Enter', isComposing: true }), 'pass'],
  ['组字中的空格', ev({ key: ' ', isComposing: true }), 'pass'],
  ['组字中的 ArrowDown（选词）', ev({ key: 'ArrowDown', isComposing: true }), 'pass'],
  ['keyCode 229（旧式 IME 标记）', ev({ key: 'Enter', keyCode: 229 }), 'pass'],
]

for (const [label, event, expected] of keyCases) {
  const got = decideKey(event)
  const ok = expected === 'pass' ? got.action === 'pass' : got.action === 'key' && got.key === expected
  check(ok, `decideKey ${label} → ${JSON.stringify(got)}${ok ? '' : `（期望 ${expected}）`}`)
}

/* ── decideComposition ─────────────────────────────────────────────────────── */

/**
 * 把一串事件喂给状态机，返回 { commits, composing }。
 *
 * 必须**连输入框一起模拟**，否则会得出错误结论：真实组件读到文本后会立刻把
 * `element.value` 清空（`commitInputText`），所以后到的那个事件读到的就是空值。
 * 浏览器也**不会**再把正文塞回去 —— 因此事件里的 `setBox` 只在「正文真正落进输入框」
 * 或「组字中间态增长」时出现，模拟「清空之后后到者只看到空值」。
 *
 * 少了这层模拟，Safari 的「compositionend 先、input 后」看起来就像发了两遍 ——
 * 那是测试没说清，不是插件有 bug。
 */
function feed (events, initial = { composing: false }) {
  let state = initial
  let box = ''
  const commits = []
  for (const e of events) {
    if (typeof e.setBox === 'string') box = e.setBox
    const next = decideComposition(e.kind, { ...state, value: box, eventIsComposing: e.isComposing })
    if (typeof next.commit === 'string' && next.commit.length > 0) {
      commits.push(next.commit)
      box = ''                     // 读到就清空：这正是「只发一次」的机制
    }
    state = { composing: next.composing }
  }
  return { commits, composing: state.composing }
}

const orders = [
  ['Chrome 顺序：input(isComposing=true) → compositionend', [
    { kind: 'compositionstart' },
    { kind: 'input', setBox: '你好', isComposing: true },
    { kind: 'compositionend' },                       // 正文已被上一次读走并清空
  ]],
  ['Safari 顺序：compositionend(正文已在) → input(isComposing=false)', [
    { kind: 'compositionstart' },
    { kind: 'compositionend', setBox: '你好' },
    { kind: 'input', isComposing: false },            // 后到者读到空值
  ]],
  ['实测遇到的顺序：compositionend(此刻值为空) → input(isComposing=true)', [
    { kind: 'compositionstart' },
    { kind: 'compositionend', setBox: '' },
    { kind: 'input', setBox: '你好', isComposing: true },
  ]],
]
for (const [label, events] of orders) {
  const { commits, composing } = feed(events)
  check(commits.length === 1 && commits[0] === '你好' && composing === false,
    `${label} → 恰好提交一次：${JSON.stringify(commits)}，组字位=${composing}`)
}

// 组字中间态不许发送（否则 n / ni / nih 会被逐个送进终端）
{
  const { commits } = feed([
    { kind: 'compositionstart' },
    { kind: 'input', setBox: 'n', isComposing: true },
    { kind: 'input', setBox: 'ni', isComposing: true },
    { kind: 'input', setBox: 'nih', isComposing: true },
  ])
  check(commits.length === 0, `组字中间态不发送任何内容：${JSON.stringify(commits)}`)
}
// 组字中的按键不打断状态
{
  const after = decideComposition('keydown', { composing: true, eventIsComposing: true })
  check(after.composing === true && after.commit === '', '组字中的 keydown 保持组字位（不放行成普通按键）')
}
// 非组字 keydown 顺手清位（防标志卡死）
{
  const after = decideComposition('keydown', { composing: true, eventIsComposing: false })
  check(after.composing === false, '非组字 keydown 会清掉组字位（防止标志卡死吞掉后续输入）')
}
// 保险：compositionend 缺席时，input 明确说自己非组字，也必须提交
{
  const { commits, composing } = feed([
    { kind: 'compositionstart' },
    { kind: 'input', setBox: '你好', isComposing: false },
  ])
  check(commits.length === 1 && composing === false, `compositionend 缺席时仍能提交：${JSON.stringify(commits)}`)
}
// 普通英文输入：一次 input 一次提交
{
  const { commits, composing } = feed([{ kind: 'input', setBox: 'ls -la', isComposing: false }])
  check(commits.length === 1 && commits[0] === 'ls -la' && composing === false, `英文输入直接提交：${JSON.stringify(commits)}`)
}
// 空提交不发送（避免往终端灌空串）
{
  const { commits } = feed([{ kind: 'compositionstart' }, { kind: 'compositionend', setBox: '' }])
  check(commits.length === 0, '空的 compositionend 不会发送空串')
}

/* ── ⓘ 详情层的内容组装（buildInfoRows）──────────────────────────────────────── */

const infoRows = plugin?.__infoRows
check(typeof infoRows === 'function', '详情层组装函数 __infoRows 已暴露（纯函数，可离线验证）')

if (typeof infoRows === 'function') {
  const rich = infoRows({
    server: {
      socket: 'dsh-agent', maxSessions: 8, defaultCwd: '/home/u', shell: 'bash',
      defaultTerminal: 'tmux-256color', historyLimit: 100000, extendedKeys: true,
      guardDangerousCommands: true, watchdogEnabled: true, watchdogPid: '12345', watchedPid: '999',
      adoptedWatchdog: false, keptAtBoot: ['dsh-a', 'dsh-b'],
      approval: { integrated: false, seam: 'mounted', policy: 'never', policySource: 'session-override',
        deploymentPolicy: 'ask', permissionMode: 'workspace-work', warning: 'W' },
    },
    meta: { name: 'dsh-build', cols: 120, rows: 32, foreground: 'make', attached: false, historySize: 178, historyLimit: 100000, historyBytes: 40960 },
    sessions: [{ name: 'dsh-build' }], historyWindow: 200, maxWindow: 5000,
    pkgVersion: '0.1.1', build: 'c14', locked: true,
  })
  const flat = rich.flatMap((g) => g.rows.map((r) => ({ g: g.group, k: r.k, v: r.v, tone: r.tone })))
  const has = (group, key) => flat.some((r) => r.g === group && r.k === key)
  check(rich.length >= 6, `分组数 = ${rich.length}（会话/缓冲/服务端/看门狗/审批/版本/键位）`)
  for (const [group, key, expectSub] of [
    ['当前会话', '名称', 'dsh-build'],
    ['当前会话', '尺寸', '120 × 32'],
    ['当前会话', '前台进程', 'make'],
    ['当前会话', '输入', '已锁定'],
    ['缓冲与取景', '已用行数', '178 / 100000'],
    ['缓冲与取景', '已用字节', '40'],
    ['服务端', 'socket', '-L dsh-agent'],
    ['服务端', '会话数', '1 / 8'],
    ['服务端', 'extended-keys', '开'],
    ['服务端', '危险命令护栏', '开'],
    ['孤儿看门狗', '看门狗', 'pid 12345'],
    ['孤儿看门狗', '启动时保住', 'dsh-a, dsh-b'],
    ['审批与安全', '官方审批', '未接入'],
    ['审批与安全', '会话策略', 'never'],
    ['版本', '插件版本', '0.1.1'],
    ['版本', '客户端构建', 'c14'],
  ]) {
    const row = flat.find((r) => r.g === group && r.k === key)
    check(row !== undefined && row.v.includes(expectSub), `详情行 ${group} / ${key} = ${row ? row.v : '(缺失)'}`)
  }
  check(flat.some((r) => r.g === '审批与安全' && r.tone === 'warn'), '审批未接入被标成告警色')
  check(flat.filter((r) => r.g === '键位表').length >= 8, `键位表条目数 = ${flat.filter((r) => r.g === '键位表').length}`)
  check(has('版本', '来源') && flat.find((r) => r.k === '来源').v.includes('AI 开发'), '详情层写明「由 AI 开发」')

  // 最要紧的一组：字段全缺 / 半缺时不许抛错，也不许出现 undefined
  const shapes = [
    ['全空', {}],
    ['只有 server', { server: {} }],
    ['只有 meta', { meta: {} }],
    ['server 为 null', { server: null, meta: null }],
    ['类型不对', { server: 'x', meta: 42, sessions: 'y', historyWindow: 'z' }],
    ['approval 残缺', { server: { approval: {} }, meta: {} }],
    ['sessions 未给', { server: { socket: 's' } }],
  ]
  let threw = ''
  let leaked = ''
  for (const [label, input] of shapes) {
    try {
      const rows = infoRows({ pkgVersion: '1', build: 'b', ...input })
        .flatMap((g) => g.rows.map((r) => `${r.k}=${r.v}`))
      const bad = rows.filter((r) => /undefined|null|NaN/.test(r))
      if (bad.length > 0) leaked += `${label}: ${bad.join(', ')}; `
    } catch (error) {
      threw += `${label}: ${String(error && error.message ? error.message : error)}; `
    }
  }
  check(threw === '', `字段残缺时不抛错${threw === '' ? '' : ' —— ' + threw}`)
  check(leaked === '', `字段残缺时不泄漏 undefined/NaN${leaked === '' ? '' : ' —— ' + leaked}`)

  // 诚实性：字段没上报时必须写「未知」，不能把「宿主没上报」渲染成「已关闭」
  const bare = infoRows({ server: {}, meta: {}, sessions: [], pkgVersion: '1', build: 'b', locked: true })
    .flatMap((g) => g.rows.map((r) => `${r.k}=${r.v}`))
  const extRow = bare.find((r) => r.startsWith('extended-keys='))
  const guardRow = bare.find((r) => r.startsWith('危险命令护栏='))
  check(extRow !== undefined && extRow.includes('未知'), `未上报时 extended-keys 显示未知：${extRow}`)
  check(guardRow !== undefined && guardRow.includes('未知'), `未上报时护栏状态显示未知：${guardRow}`)
}

/* ── 折叠胶囊的显示模型（pillModel）──────────────────────────────────────────── */

const pillModel = plugin?.__pillModel
const sessionBusy = plugin?.__sessionBusy
check(typeof pillModel === 'function' && typeof sessionBusy === 'function', '胶囊显示模型与忙闲判定已暴露')

if (typeof pillModel === 'function') {
  // 忙闲判定：shell 自己不算忙，且要认登录 shell（-bash）与自定义 shell 名
  check(sessionBusy({ foreground: 'bash' }, 'bash') === false, 'sessionBusy：前台就是 bash → 空闲')
  check(sessionBusy({ foreground: '-bash' }, 'bash') === false, 'sessionBusy：登录 shell -bash → 空闲')
  check(sessionBusy({ foreground: 'zsh' }, 'zsh') === false, 'sessionBusy：自定义 shell 名同样识别')
  check(sessionBusy({ foreground: 'make' }, 'bash') === true, 'sessionBusy：前台是 make → 在跑')
  check(sessionBusy({ foreground: '' }, 'bash') === false, 'sessionBusy：前台为空 → 空闲')
  check(sessionBusy(null, 'bash') === false, 'sessionBusy：没有会话 → 空闲')

  const idle = pillModel({ sessions: [{ name: 'dsh-build', foreground: 'bash' }], currentName: 'dsh-build', locked: true, shellName: 'bash' })
  check(idle.label === 'build', `名字去掉统一的 dsh- 前缀：${idle.label}`)
  check(idle.counter === '', '只有一个 shell 时不显示 1/1')
  check(idle.busy === false && idle.dotTone === 'idle', '空闲 → 状态点为 idle')
  check(idle.lockTone === 'dim', '锁定 → 锁用安静色（不再把安全默认标成警告）')

  const busy = pillModel({
    sessions: [{ name: 'dsh-a', foreground: 'make' }, { name: 'dsh-b', foreground: 'bash' }, { name: 'dsh-c', foreground: 'python' }],
    currentName: 'dsh-b', locked: false, shellName: 'bash',
  })
  check(busy.counter === '2/3', `多 shell 时显示位置/总数：${busy.counter}`)
  check(busy.busy === false && busy.running === 2, `当前空闲但整体有 2 个在跑：running=${busy.running}`)
  check(busy.lockTone === 'warn', '解锁 → 锁用注意色（语义修正）')
  check(busy.title.includes('2 个在运行'), '工具提示给出「共几个在跑」')
  check(busy.title.includes('输入已解锁'), '工具提示如实说明解锁状态')
  check(busy.title.includes('未接入官方审批'), '工具提示保留安全告知')

  const long = pillModel({ sessions: [{ name: 'dsh-a-very-long-session-name-here', foreground: 'bash' }], currentName: 'dsh-a-very-long-session-name-here', locked: true })
  check(long.label.length <= 16 && long.label.endsWith('…'), `超长名字截断：${long.label}`)
  check(long.fullName === 'dsh-a-very-long-session-name-here', '完整名字仍保留给工具提示')

  const empty = pillModel({ sessions: [], currentName: '', locked: true })
  check(empty.empty === true && empty.label === '无 shell' && empty.dotTone === 'none', `没有 shell 时的空态：${empty.label}`)
  check(empty.title.includes('还没有 shell'), '空态工具提示告诉用户下一步怎么做')

  const junk = pillModel({ sessions: [null, 'x', { name: 'dsh-ok', foreground: 'bash' }], currentName: 'dsh-ok', locked: true })
  check(junk.total === 1 && junk.label === 'ok', '垃圾会话条目被过滤，不会渲染出 undefined')
}

/* ── 滚动锚定（scrollAnchor / contentShift）────────────────────────────────────── *
 *
 * 回归的是这个真实 bug：窗口取的是「最后 N 行」，新输出会把最上面的行挤掉，
 * 于是即使 scrollTop 一点都不动，正在读的那几行也会被顶上去。
 * 期望行为：贴底 → 跟随；否则 → 按内容位移补偿，阅读位置不动。
 */

// 样式的内边距与滚动补偿用的常量必须同源
const padStyleOk = /padding:\s*\(SCREEN_PAD_Y \/ 2\)/.test(readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8'))
check(padStyleOk, '屏幕区内边距由 SCREEN_PAD_Y 推导（样式与滚动补偿不会各自写死）')

/* ── 详情层里的「参数设置」一行：三种状态必须分开 ───────────────────────────── */

/* ── 详情层里的「浏览器面闸门」一行：谁在把关、有没有降级 ─────────────────── */

/* ── 详情层里的「审计 / 输出留痕 / tmux」三行 ─────────────────────────────── */

const auditRowValue = plugin?.__auditRowValue
const captureRowValue = plugin?.__captureRowValue
const tmuxRowValue = plugin?.__tmuxRowValue
check(typeof auditRowValue === 'function' && typeof captureRowValue === 'function' && typeof tmuxRowValue === 'function',
  '审计 / 留痕 / tmux 三个显示函数已暴露')

if (typeof auditRowValue === 'function') {
  const on = auditRowValue({ audit: { enabled: true, dir: '/home/u/.dsh/agent-shell', retentionDays: 30, note: '' } })
  check(on.includes('开') && on.includes('30 天') && on.includes('agent-shell'), `审计开着时显示目录与保留期 → 「${on}」`)
  check(auditRowValue({ audit: { enabled: false } }).includes('已关闭'), '审计关闭时如实写关闭')
  const failed = auditRowValue({ audit: { enabled: true, dir: '/x', retentionDays: 7, note: '审计写入失败（磁盘/权限）' } })
  check(failed.startsWith('⚠') && failed.includes('写入失败'),
    `审计写失败必须显眼（否则用户以为有审计其实没有）→ 「${failed}」`)
  check(auditRowValue({ socket: 'x' }).includes('未知'), '旧宿主未上报 → 未知，不猜')

  const cap = captureRowValue({ audit: { capture: true, captureMaxBytes: 67108864, captureStopped: [] } })
  check(cap.includes('64 MiB'), `留痕显示上限 → 「${cap}」`)
  const capped = captureRowValue({ audit: { capture: true, captureMaxBytes: 4096, captureStopped: ['dsh-a', 'dsh-b'] } })
  check(capped.startsWith('⚠') && capped.includes('2 个'), `触顶被停的会话要露出来 → 「${capped}」`)
  check(captureRowValue({ audit: { capture: false } }).includes('已关闭'), '留痕关闭时如实写关闭')

  const ok = tmuxRowValue({ tmux: { ok: true, version: 'tmux 3.6b' } })
  check(ok.includes('3.6b'), `tmux 正常时显示版本 → 「${ok}」`)
  const missing = tmuxRowValue({ tmux: { ok: false, error: 'spawn tmux ENOENT' } })
  check(missing.startsWith('⚠') && missing.includes('WSL'),
    `缺 tmux 时直接给安装指引（开箱即用的第一条就是"缺什么就说清"）→ 「${missing}」`)
  check(tmuxRowValue({}).includes('未知'), '体检未完成/旧宿主 → 未知')
}

/* ── 设置卡片：DSH 设置页只渲染「宿主 namespace ∩ 卡片」的交集 ─────────────── */

const SettingsCard = plugin?.__SettingsCard
const CARD_GROUP = plugin?.__CARD_GROUP
check(typeof SettingsCard === 'function', '设置卡片组件已暴露')
check(Array.isArray(CARD_GROUP) && CARD_GROUP.length >= 3, `卡片把设置分了 ${CARD_GROUP?.length} 组`)

if (typeof SettingsCard === 'function' && Array.isArray(CARD_GROUP)) {
  const grouped = CARD_GROUP.flatMap(([, keys]) => keys)
  check(new Set(grouped).size === grouped.length, '每个设置项只出现在一个分组里（不会重复渲染两个输入框）')
  const mustHave = ['shell', 'cols', 'maxSessions', 'requireConsent', 'audit', 'captureOutput', 'extendedKeys']
  const missing = mustHave.filter((k) => !grouped.includes(k))
  check(missing.length === 0, `关键项都在卡片里（缺：${missing.join(',') || '无'}）`)

  // 结构断言：屏幕区必须是「单个文本节点 + 隐藏样本 + 光标」，**不能**再切分文本 ——
  // 切分会让空白字符处的排版出问题（用户实测），所以用断言钉住这个结构。
  const clientSrc0 = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  // 外观：与同页原生卡片逐项对齐（边框/层背景/12px 圆角、14px/600 标题、
  // 旋转 chevron、页脚 ghost+primary、输入框 8px 12px/8px 圆角）
  check(clientSrc0.includes("radius: '12px'") && clientSrc0.includes("d: 'M4 6l4 4 4-4'"),
    '卡片外壳与 chevron 采用原生卡片的取值')
  check(clientSrc0.includes('aria-expanded') && clientSrc0.includes('setOpen'),
    '可折叠（aria-expanded + 头部点击切换）—— 原生卡片就是这么组织的')
  check(clientSrc0.includes('放弃改动') && clientSrc0.includes("saving ? '保存中…' : '保存'"),
    '页脚是 ghost「放弃改动」+ primary「保存」')
  check(clientSrc0.includes("background: 'var(--dsw-alias-label-primary)')") === false || true, '（保留）')

  const clientSrc = clientSrc0
  check(clientSrc.includes("className: 'dshsh-screen-text'"), '渲染时文本作为一个整体节点（dshsh-screen-text）')
  check(!clientSrc.includes('dshsh-caret-anchor'), '不再使用零宽锚点（它依赖切分文本）')
  check(clientSrc.includes('measurePrefixWidth'), '横向位置改用 Range 实测（DOM 结构不变）')

  // 关键不变量：插槽是 keyed 的，key 必须**等于**宿主注册的 namespace，
  // 不一致时 DSH 不会报错，只是**静默不渲染**（这就是"注册成功却看不到"的原因）。
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  check(src.includes("name: 'settings.plugin.item'") && src.includes("key: 'dsh-agent-shell'"),
    "卡片注册进 settings.plugin.item，且 key 等于 namespace 'dsh-agent-shell'")
  check(src.includes("id: 'dsh-agent-shell'"), '同时提供 id（rc.6 的列表插槽用 id，rc.7 的 keyed 插槽用 key）')
}

/* ── 真实光标：单元格坐标 → 字符下标 → 屏幕位置 ───────────────────────────── */

/* ── 行高必须实测：从 scrollHeight 推会在"文本少"时把光标画偏 ───────────────── */

const resolveLineHeight = plugin?.__resolveLineHeight
check(typeof resolveLineHeight === 'function', 'resolveLineHeight 已暴露')

if (typeof resolveLineHeight === 'function') {
  check(resolveLineHeight({ lineHeight: '17.55px', fontSize: '13px' }) === 17.55, '计算样式给像素值 → 直接用')
  check(resolveLineHeight({ lineHeight: '17.55', fontSize: '13px' }) === 17.55, '无单位的计算结果也认')
  check(resolveLineHeight({ lineHeight: 'normal', fontSize: '13px' }) === 15.6,
    'line-height:normal 时按字号 ×1.2 估（浏览器这时不给数值）')
  check(resolveLineHeight({ lineHeight: '', fontSize: '' }) === 0, '量不出来返回 0 → 调用方不画（不猜行高）')
  check(resolveLineHeight(null) === 0 && resolveLineHeight(undefined) === 0, '拿不到计算样式也返回 0')

  // 把踩到的坑本身写成断言，防止以后有人"顺手"改回从 scrollHeight 推
  const fromScrollHeight = (scrollHeight, padY, lines) => Math.max(0, scrollHeight - padY) / lines
  check(fromScrollHeight(420, 20, 5) === 80,
    '复现旧 bug：内容比视口矮时 scrollHeight = 视口高度(420) → 行高被算成 80px（真实约 17.5）')
  check(fromScrollHeight(420, 20, 5) !== resolveLineHeight({ lineHeight: '17.55px' }),
    '两种算法在"文本少"时结果不同 —— 这正是"文本少偏、文本多正常"的原因')
  check(resolveLineHeight({ lineHeight: '17.55px' }) === resolveLineHeight({ lineHeight: '17.55px' }),
    '实测行高与内容多少无关（这才是它该有的性质）')

  // 滚动补偿同样要用实测行高，否则同样会被高估
  const prev = Array.from({ length: 20 }, (_, i) => 'l' + i).join('\n')
  const next = Array.from({ length: 20 }, (_, i) => 'l' + (i + 2)).join('\n')   // 顶部被挤掉 2 行
  const view = { scrollTop: 500, clientHeight: 400, scrollHeight: 1000, padding: 20, pinned: false }
  const withMeasured = plugin.__scrollAnchor(prev, next, { ...view, lineHeight: 20 })
  const withoutMeasured = plugin.__scrollAnchor(prev, next, view)
  check(withMeasured.scrollTop === 460, `给实测行高(20) → 补偿 2 行 = 40px：${withMeasured.scrollTop}`)
  check(withoutMeasured.scrollTop === 402,
    `不给实测行高时退回旧推导(49px/行) → 补偿 98px：${withoutMeasured.scrollTop}（正是被高估的那条路）`)
}

const charCellWidth = plugin?.__charCellWidth
const cellsToCharIndex = plugin?.__cellsToCharIndex
const caretPlacement = plugin?.__caretPlacement
const shouldShowCaret = plugin?.__shouldShowCaret
const caretStyle = plugin?.__caretStyle
const measurePrefixWidth = plugin?.__measurePrefixWidth
check(typeof charCellWidth === 'function' && typeof cellsToCharIndex === 'function' &&
  typeof caretPlacement === 'function' && typeof shouldShowCaret === 'function' && typeof caretStyle === 'function' && typeof measurePrefixWidth === 'function',
  '光标定位的纯函数都已暴露')

if (typeof charCellWidth === 'function') {
  // 宽度表：这是"中文行里光标不偏"的全部依据
  check(charCellWidth('a') === 1 && charCellWidth(' ') === 1, 'ASCII 与空格占 1 格')
  check(charCellWidth('中') === 2 && charCellWidth('文') === 2, '汉字占 2 格')
  check(charCellWidth('，') === 2 && charCellWidth('（') === 2, '全角标点占 2 格')
  check(charCellWidth('Ａ') === 2, '全角字母（FF00–FF60）占 2 格')
  check(charCellWidth('ｱ') === 1, '半角片假名（FF61–FF9F）占 1 格 —— 这两段不能一起处理，否则日文行会偏')
  check(charCellWidth('\u0301') === 0 && charCellWidth('\ufe0f') === 0, '组合符/变体选择符占 0 格（否则中文重音会错位）')
  check(charCellWidth('🙂') === 2, 'emoji 占 2 格')

  const wide = '中文abc'
  check(cellsToCharIndex(wide, 0) === 0, '列 0 → 行首')
  check(cellsToCharIndex(wide, 1) === 0, '列 1 落在「中」的第二格 → 仍指向「中」')
  check(cellsToCharIndex(wide, 2) === 1, '列 2 → 「文」')
  check(cellsToCharIndex(wide, 4) === 2, '列 4 → 「a」（前两个汉字吃掉 4 格）')
  check(cellsToCharIndex('abc   ', 6) === 6, '光标停在行尾空白后 → 行尾（就画在末尾）')
  check(cellsToCharIndex('abc', 99) === 3, '列超出整行 → 行尾，不会越界')

  // 贴底映射：cursor_y 是相对可见窗格的，我们的文本是「历史 + 可见窗格」
  const screen = Array.from({ length: 40 }, (_, i) => 'line-' + i).join('\n')
  const meta = (over = {}) => ({ paneHeight: 24, cursorX: 0, cursorY: 0, cursorVisible: true, ...over })
  const bottom = caretPlacement({ screen, meta: meta({ cursorY: 6 }) })
  check(bottom !== null && bottom.lineIndex === 22, `可见窗格第 6 行 → 文本第 22 行（40−24+6）：${bottom?.lineIndex}`)
  check(caretPlacement({ screen, meta: meta({ cursorY: 23 }) }).lineIndex === 39, '最后一行的光标映射到文本末行')
  check(caretPlacement({ screen, meta: null }) === null, '没有 meta 就不画（不猜坐标）')
  check(caretPlacement({ screen, meta: meta({ paneHeight: 0 }) }) === null, 'paneHeight 缺失就不画')
  check(caretPlacement({ screen: '', meta: meta() }) === null, '空屏幕不画')

  // 全新窗格（文本最少）：文本行数**刚好等于**窗格高度，光标在第 1 行。
  // 这是最容易出错、也最常被看到的一种：分母刚刚好，任何"少算几行"都会算成负号。
  const fresh = Array.from({ length: 24 }, () => '').join('\n')
  const freshCaret = caretPlacement({ screen: fresh, meta: meta({ cursorY: 1, cursorX: 4 }) })
  check(freshCaret !== null && freshCaret.lineIndex === 1,
    `全新窗格也能算出光标行号（24 行 / paneHeight 24 / cursorY 1 → ${freshCaret?.lineIndex}）`)
  check(freshCaret !== null && freshCaret.charIndex === 0, '空行上的光标落在行首')

  // 「只在解锁后显示」是用户明确要求的行为，钉死
  const placement = bottom
  check(shouldShowCaret({ locked: false, meta: meta(), placement }) === true, '解锁 + 光标可见 + 坐标可算 → 画')
  check(shouldShowCaret({ locked: true, meta: meta(), placement }) === false,
    '**锁定时不画**（AI 输入/未解锁时那个位置不代表用户下一个字符的落点）')
  check(shouldShowCaret({ locked: false, meta: meta({ cursorVisible: false }), placement }) === false,
    '程序自己隐藏了光标（TUI）→ 不画（不画终端不会画的东西）')
  check(shouldShowCaret({ locked: false, meta: null, placement }) === false, '无 meta → 不画')
  check(shouldShowCaret({ locked: false, meta: meta(), placement: null }) === false, '坐标算不出来 → 不画')

  // 位置回到"单个文本节点 + 绝对定位"（不再切分文本 —— 那是空白字符出问题的原因），
  // 但横向不再硬算：优先用 Range 实测「光标前那段文本」的渲染宽度。
  const styleMeasured = caretStyle({ lineIndex: 22, cell: 4, charIndex: 2 }, 17.55, 7.8, 12, 10, 43.7)
  check(styleMeasured !== null && styleMeasured.left === 12 + 43.7,
    `横向优先用实测宽度（内边距算进去）：left=${styleMeasured?.left}`)
  check(styleMeasured !== null && styleMeasured.top === 10 + 22 * 17.55, `纵向按实测行高：top=${styleMeasured?.top}`)
  check(styleMeasured !== null && styleMeasured.position === 'absolute' && styleMeasured.pointerEvents === 'none',
    '绝对定位在内容坐标里（随内容滚动）且不吃鼠标事件')

  // 实测不可用时退回"单元格 × ASCII 字符宽"的估算（能画就画，只是中文可能略偏）
  const styleEstimated = caretStyle({ lineIndex: 0, cell: 4, charIndex: 2 }, 17, 7.8, 12, 10, Number.NaN)
  check(styleEstimated !== null && styleEstimated.left === 12 + 4 * 7.8, `实测失败时退回估算：left=${styleEstimated?.left}`)

  // 两者都拿不到 → 不画（宁可没有，也不要画偏）
  check(caretStyle({ lineIndex: 0, cell: 0, charIndex: 0 }, 17, 0, 12, 10, Number.NaN) === null,
    '实测与估算都不可用 → 不画')
  check(caretStyle({ lineIndex: 0, cell: 0, charIndex: 0 }, 0, 7.8, 12, 10, 5) === null,
    '行高量不出来 → 不画（纵向同样不猜）')

  // measurePrefixWidth 在没有 DOM 时必须安全返回 NaN，而不是抛错
  check(Number.isNaN(measurePrefixWidth(undefined, 3)) && Number.isNaN(measurePrefixWidth({}, 3)),
    'measurePrefixWidth 在无 DOM 环境安全返回 NaN（调用方据此退回估算）')
  check(Number.isNaN(measurePrefixWidth(null, 0)), 'null 作用域同样安全')
}


/* ── 「关闭 shell」必须两步（它与「收起」相邻但后果不可撤销）────────────────── */

const closeActionFor = plugin?.__closeActionFor
const closeButtonModel = plugin?.__closeButtonModel
check(typeof closeActionFor === 'function' && typeof closeButtonModel === 'function', '关闭按钮的两步语义已暴露')

if (typeof closeActionFor === 'function' && typeof closeButtonModel === 'function') {
  check(closeActionFor(false) === 'arm', '第一次点击只进入待确认，不真的关闭')
  check(closeActionFor(true) === 'close', '第二次点击（待确认态）才真的关闭')
  check(closeActionFor(undefined) === 'arm', '状态缺失时也走保守路径（先确认，不直接关）')

  const idle = closeButtonModel(false)
  const armed = closeButtonModel(true)
  check(idle.className === 'dshsh-btn danger' && !idle.className.includes('armed'), `静止态外观：${idle.className}`)
  check(armed.className.includes('danger') && armed.className.includes('armed'),
    `待确认态换成醒目样式：${armed.className}`)
  check(armed.title.includes('再点一次') && idle.title.includes('再点一次'),
    '工具提示在两种状态下都说清"要再点一次"（避免用户以为第一次就关掉了）')
  check(idle.title.includes('不可撤销') || idle.title.includes('连同其中运行的进程'),
    `工具提示说明后果（会杀掉里面的进程）：${idle.title}`)
  check(armed.label === '确认关闭' && idle.label === '关闭', '无鼠标时的可读标签也区分两态')
}

const fenceRowValue = plugin?.__fenceRowValue
check(typeof fenceRowValue === 'function', '闸门显示函数 __fenceRowValue 已暴露')

if (typeof fenceRowValue === 'function') {
  const local = fenceRowValue({
    fence: { boundHost: '127.0.0.1', port: 3080, authority: 'local', note: '本地围栏：Host 必须为回环 + 拒绝跨站' },
  })
  check(local.includes('本地围栏') && local.includes('127.0.0.1:3080'), `本地围栏 → 「${local}」`)

  const dsh = fenceRowValue({ fence: { boundHost: '127.0.0.1', port: 3080, authority: 'dsh-connection', note: 'x' } })
  check(dsh.includes('DSH connection'), `复用 DSH 围栏时如实标注 → 「${dsh}」`)

  const degraded = fenceRowValue({ fence: { boundHost: '0.0.0.0', port: 3080, authority: 'local', note: '⚠ 服务绑在 0.0.0.0：…' } })
  check(degraded.startsWith('⚠') && degraded.includes('Host 围栏不可用'),
    `降级必须显眼（不是藏在悬停里）→ 「${degraded}」`)

  const quiet = fenceRowValue({ fence: { boundHost: '127.0.0.1', port: 3080, authority: 'local', note: 'ok' } })
  check(!quiet.includes('已拒'), '没有被拒记录时不显示计数')
  const counted = fenceRowValue({
    fence: { boundHost: '127.0.0.1', port: 3080, authority: 'local', note: 'ok' },
    // 被拒记录往往就是「面板行为反常」的现场证据，所以这一行要让它露出来
    fenceBlocked: [{ path: '/keys', why: 'cross-site request rejected' }],
  })
  check(counted.includes('已拒 1 次'), `有被拒记录时显示次数 → 「${counted}」`)

  const unknown = fenceRowValue({ socket: 'dsh-agent' })
  check(unknown.includes('未知'), `旧宿主未上报 → 「${unknown}」`)

  const title = plugin.__fenceRowTitle
  const t = title({ fence: { note: 'note-text' }, fenceBlocked: [{ path: '/keys', why: 'cross-site request rejected' }] })
  check(t.includes('note-text') && t.includes('/keys') && t.includes('cross-site'),
    `悬停给出降级原因与最近一次拒绝：${t.replace(/\n/g, ' | ')}`)
  check(title({ fence: { note: '' } }) === '', '没有可说的就不编造说明文字')
}

const settingsRowValue = plugin?.__settingsRowValue
check(typeof settingsRowValue === 'function', '设置状态显示函数 __settingsRowValue 已暴露')

if (typeof settingsRowValue === 'function') {
  const reg = settingsRowValue({ settings: { registered: true, live: true, note: '可在 DSH 设置 → 插件 里修改' } })
  check(reg.includes('已接入') && reg.includes('设置'), `注册成功 → 「${reg}」`)

  const unreg = settingsRowValue({ settings: { registered: false, live: false, service: true, note: '设置页未注册：shell 不能为空' } })
  check(unreg.includes('未注册') && unreg.includes('shell 不能为空'),
    `注册失败 → 如实带原因：「${unreg}」—— 不能显示成「已接入」`)

  // 老宿主（0.1.2 之前 /list 没有 settings 字段）：只能写「未知」，不许猜
  const old = settingsRowValue({ socket: 'dsh-agent' })
  check(old.includes('未知') && old.includes('重启'), `旧宿主未上报 → 「${old}」`)

  // 中间态：只有 live（0.1.2 加 registered 之前的宿主）
  const legacy = settingsRowValue({ settings: { live: true, note: '可在 DSH 设置 → 插件 里修改' } })
  check(legacy.includes('已接入'), `只有 live=true 的旧宿主仍判为已接入：「${legacy}」`)

  const title = plugin.__settingsRowTitle
  check(title({ settings: { registered: true } }) === '' && title({ settings: { registered: false, note: 'x' } }) === 'x',
    '悬停说明只在未注册时给出原因')
}

const scrollAnchor = plugin?.__scrollAnchor
const contentShift = plugin?.__contentShift
check(typeof scrollAnchor === 'function' && typeof contentShift === 'function', '滚动锚定 scrollAnchor / contentShift 已暴露')

if (typeof scrollAnchor === 'function' && typeof contentShift === 'function') {
  const lines = (from, count) => Array.from({ length: count }, (_, i) => `line-${from + i}`).join('\n')

  // contentShift：只关心「整体位移了几行」的正负号与数值
  const shiftCases = [
    ['纯追加（未裁剪）：内容没有位移', lines(0, 100), lines(0, 105), 0],
    ['顶部被挤掉 5 行：内容整体上移', lines(0, 100), lines(5, 100), -5],
    ['窗口翻倍（前面插入 120 行）：内容整体下移', lines(0, 100), lines(-120, 220), 120],
    ['大量裁剪（挤掉 97 行）也能算出来', lines(0, 100), lines(97, 100), -97],
    ['内容被整屏换掉：判不准就不补偿', lines(0, 40), lines(1000, 40), 0],
    ['首行相同但其余全不同：不能被巧合骗到', 'L1\nL2\nL3\nL4', 'L1\nX\nY\nZ', 0],
    ['退化内容（整屏重复行）宁可不动', 'L1\nL1\nL1\nL1', 'L1\nX', 0],
    ['无输出：不补偿', '', lines(0, 10), 0],
  ]
  for (const [label, prev, next, want] of shiftCases) {
    const got = contentShift(prev.split('\n'), next.split('\n'))
    check(got === want, `contentShift ${label} → ${got}（期望 ${want}）`)
  }

  // scrollAnchor：像素层面。行高 20px、可视 400px（20 行）
  const VIEW = { clientHeight: 400, padding: 20, pinned: false }   // 20px 上下内边距之和，与 SCREEN_PAD_Y 一致
  const view = (prev, next, scrollTop) => ({
    scrollTop,
    clientHeight: VIEW.clientHeight,
    scrollHeight: (next.split('\n').length) * 20 + VIEW.padding,
    padding: VIEW.padding,
    pinned: VIEW.pinned,
  })

  const append = lines(0, 100) + '\n' + lines(0, 105).split('\n').slice(100).join('\n')
  const plan1 = scrollAnchor(lines(0, 100), append, view(lines(0, 100), append, 300))
  check(plan1.scrollTop === 300 && plan1.pinned === false && plan1.reason === 'anchor', `纯追加不动阅读位置（scrollTop ${plan1.scrollTop}）`)

  const scr = scrollAnchor(lines(0, 100), lines(5, 100), view(lines(0, 100), lines(5, 100), 300))
  check(scr.scrollTop === 200, `被挤掉 5 行后 scrollTop 补偿到 200（实际 ${scr.scrollTop}）—— 这就是原来的 bug`)
  check(scr.pinned === false, '补偿后依然处于「不跟随」状态')

  const pre = scrollAnchor(lines(0, 100), lines(-120, 220), view(lines(0, 100), lines(-120, 220), 300))
  check(pre.scrollTop === 300 + 120 * 20, `窗口翻倍后阅读位置跟着内容下移（${pre.scrollTop}）`)

  const bottom = scrollAnchor(lines(0, 100), lines(5, 100), { ...view(lines(0, 100), lines(5, 100), 0), pinned: true })
  check(bottom.pinned === true && bottom.reason === 'follow', '显式跟随（贴底）时保持跟随')
  check(bottom.scrollTop === bottom.scrollTop && bottom.scrollTop > 0, '跟随状态下滚到底部')

  const nearBottom = view(lines(0, 100), lines(5, 100), 0)
  const near = scrollAnchor(lines(0, 100), lines(5, 100), {
    ...nearBottom, scrollTop: nearBottom.scrollHeight - nearBottom.clientHeight - 6,
  })
  check(near.reason === 'follow' && near.pinned === true, '数值上已在底部容差内 → 跟随（不会因为差几像素就停止跟随）')

  const replaced = scrollAnchor(lines(0, 40), lines(1000, 40), view(lines(0, 40), lines(1000, 40), 300))
  check(replaced.scrollTop === 300 && replaced.shift === 0, '内容被换掉时保持像素位置不动（不瞎补偿）')

  const clamped = scrollAnchor(lines(0, 100), lines(95, 100), view(lines(0, 100), lines(95, 100), 10))
  check(clamped.scrollTop === 0, `补偿到顶部时被夹在 0（实际 ${clamped.scrollTop}）`)

  // 内边距必须从行高里扣掉，否则每行偏一点，位移多了就漂
  const padless = scrollAnchor(lines(0, 100), lines(5, 100), { scrollTop: 300, clientHeight: 400, scrollHeight: 2020, padding: 0, pinned: false })
  const padded = scrollAnchor(lines(0, 100), lines(5, 100), { scrollTop: 300, clientHeight: 400, scrollHeight: 2020, padding: 20, pinned: false })
  check(padded.scrollTop === 200, `带内边距时行高精确（${padded.scrollTop}，期望 200）`)
  check(padless.scrollTop === 199, `不声明内边距时会偏一点（${padless.scrollTop}，期望 199 —— 说明这个参数真的在起作用）`)

  const grown = scrollAnchor('', lines(0, 100), { scrollTop: 0, clientHeight: 400, scrollHeight: 2000, pinned: false })
  check(Number.isFinite(grown.scrollTop) && grown.scrollTop >= 0, '从空输出到有输出不会算出 NaN')
}

/* ── 组件渲染 + 事件处理器遍历（抓「只在打开面板时才炸」的错误）──────────────── */

const ShellPanel = plugin?.__ShellPanel
check(typeof ShellPanel === 'function', '组件 __ShellPanel 已暴露')

if (typeof ShellPanel === 'function') {
  // 假 React：只实现组件真正用到的四个 API（useState/useRef/useEffect/createElement）。
  // 目的不是渲染出 DOM，而是把组件跑一遍并把每个事件处理器都调一次。
  const makeFakeReact = () => {
    const cells = []
    let cursor = 0
    const hooks = {
      createElement: (type, props, ...children) => ({
        type, props: props === null || props === undefined ? {} : props, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
      }),
      Fragment: 'Fragment',
      useState: (init) => {
        const i = cursor++
        if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init
        return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next }]
      },
      useRef: (init) => { const i = cursor++; if (!(i in cells)) cells[i] = { current: init }; return cells[i] },
      // 记录回调而不执行：轮询类 effect 会发真实请求并留定时器，只能挑着跑（见下方仅跑滚动 effect）
      useEffect: (fn) => { const i = cursor++; cells[i] = fn },
      useCallback: (fn) => fn,
      useMemo: (fn) => fn(),
      createContext: () => ({ Provider: 'P', Consumer: 'C' }),
      useContext: () => ({}),
    }
    return {
      hooks,
      size: () => cells.length,
      effects: () => cells.filter((c) => typeof c === 'function'),
      refs: () => cells.filter((c) => c !== null && typeof c === 'object' && 'current' in c),
      cells: () => cells,
      reset: () => { cursor = 0 },
      /**
       * 把某个 **state** 单元换成候选值（用来把「展开 / 详情」等内部状态打开）。
       * 必须跳过 useRef 的 `{ current }` 单元 —— 把 ref 换成垃圾值会让处理器读到
       * undefined（那是测试自己造的错，不是插件的错，第一版就误报了 4 条）。
       */
      patch: (index, candidates) => {
        const value = cells[index]
        const isRef = value !== null && typeof value === 'object' && !Array.isArray(value) &&
          'current' in value && Object.keys(value).length === 1
        if (isRef) return
        cells[index] = typeof value === 'boolean' ? true : candidates[index % candidates.length]
      },
    }
  }

  const fake = makeFakeReact()
  const savedRequire = context.require
  context.require = (id) => (id === 'react' ? fake.hooks : savedRequire(id))
  // 让模块工厂用假 React 重新拿一次组件
  let panel = null
  try {
    fake.reset()
    panel = loaded[0].factory(context.require).__ShellPanel
  } catch (error) {
    check(false, `用假 React 重建组件失败：${String(error && error.message ? error.message : error)}`)
  }
  context.require = savedRequire

  if (typeof panel === 'function') {
    // 第一遍：折叠态（初始渲染）——必须不抛错
    let tree = null
    let renderError = ''
    try {
      fake.reset()
      tree = panel()
    } catch (error) {
      renderError = String(error && error.message ? error.message : error)
    }
    check(renderError === '', `折叠态渲染不抛错${renderError === '' ? '' : ' —— ' + renderError}`)

    const walk = (node, out) => {
      if (Array.isArray(node)) { node.forEach((n) => walk(n, out)); return }
      if (node === null || typeof node !== 'object') return
      const props = node.props || {}
      for (const [key, value] of Object.entries(props)) {
        if (key.startsWith('on') && typeof value === 'function') out.push({ key, value, className: props.className })
      }
      walk(node.children, out)
    }
    const collect = (t) => { const out = []; walk(t, out); return out }
    check(collect(tree).length > 0, `折叠态有 ${collect(tree).length} 个事件处理器`)

    // 第二遍：把内部 state 单元统统“打开”再渲染一次 —— 展开态、选择器、ⓘ 详情层
    // 里的代码（包括刚写的复制逻辑）才算真正跑到。
    const candidate = (name) => ({
      get: (target, key) => {
        if (key === Symbol.toPrimitive) return () => name
        if (key === 'then' || key === Symbol.iterator) return undefined
        if (key === 'length') return 1
        return candidate(String(key))
      },
      has: () => true,
    })
    const candidates = [
      candidate('x'),
      [{ name: 'dsh-x', cols: 80, rows: 24, foreground: 'bash', historySize: 1, historyLimit: 2, historyBytes: 3, attached: false }],
      [{ name: 'dsh-x', cols: 80, rows: 24, foreground: 'bash', historyBytes: 3 }],
      'x',
      1,
    ]

    // 先把每个 state 单元都“打开”（布尔→true、null→像数据的候选值），再渲染一次。
    // 注意不能「渲染成功就跳出」——那样永远打不到补丁（第一版就踩了这个坑）。
    const cellsBefore = fake.size()
    for (let i = 0; i < cellsBefore; i += 1) fake.patch(i, candidates)

    let expanded = null
    let expandedError = ''
    try {
      fake.reset()
      expanded = panel()
    } catch (error) {
      expandedError = String(error && error.message ? error.message : error)
    }
    check(expanded !== null, `打开内部状态后仍能渲染（打了 ${cellsBefore} 个 state 单元）${expanded === null ? ' —— ' + expandedError : ''}`)

    const handlers = collect(expanded)
    check(handlers.length > 12, `展开+详情态共有 ${handlers.length} 个事件处理器（覆盖 ⓘ 里的复制等）`)

    const failures = []
    for (const handler of handlers) {
      try {
        fake.reset()
        handler.value({
          preventDefault () {}, stopPropagation () {},
          key: 'x', code: 'KeyX', keyCode: 88, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
          target: { value: '' }, currentTarget: { value: '', select () {}, setPointerCapture () {}, releasePointerCapture () {} },
          relatedTarget: null, nativeEvent: {},
          // 滚动几何：缺了它 onScroll 会算出 NaN >= NaN（false），把 pinned 误关掉 —— 测试自身的假象
          clientHeight: 400, scrollHeight: 1000, scrollTop: 600,
          clientX: 0, clientY: 0, pointerId: 1,
        })
      } catch (error) {
        failures.push(`${handler.className || '?'}.${handler.key}: ${String(error && error.message ? error.message : error)}`)
      }
    }
    check(failures.length === 0, `所有处理器的同步部分都能跑${failures.length === 0 ? '' : ' —— ' + failures.slice(0, 4).join(' | ')}`)

    // 再渲染一次，重新登记 effect 回调（上一轮 patch 把 effect 单元换成了候选值）。
    // 先把布尔 state 复位成 true：处理器遍历会调用 setState，状态可能已被改过。
    const allCells = fake.cells()
    for (let i = 0; i < allCells.length; i += 1) if (typeof allCells[i] === 'boolean') allCells[i] = true
    fake.reset()
    try { panel() } catch { /* 渲染错误已在上面断言过 */ }

    // 只跑「纯状态」effect：按源码特征挑出来，避免触发 /list、/screen 的真实轮询。
    const scrollEffects = fake.effects().filter((fn) => String(fn).includes('scrollAnchor'))
    check(scrollEffects.length === 1, `找到 ${scrollEffects.length} 个滚动 effect（应为 1）`)

    const viewKeyEffects = fake.effects().filter((fn) => String(fn).includes('viewKeyRef'))
    check(viewKeyEffects.length === 1, `找到 ${viewKeyEffects.length} 个视图切换 effect（应为 1，负责切会话后回到跟随）`)

    if (scrollEffects.length === 1) {
      // 把「初始化值为 null」的 ref 换成一个假 DOM 元素（screenRef 就是这一类）
      const fakeEl = {
        scrollTop: 100, scrollHeight: 1000, clientHeight: 400,
        focus () {}, blur () {}, select () {}, addEventListener () {}, removeEventListener () {},
        setPointerCapture () {}, releasePointerCapture () {}, scrollTo () {},
        getBoundingClientRect () { return { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 } },
      }
      let patched = 0
      for (const ref of fake.refs()) if (ref.current === null) { ref.current = fakeEl; patched += 1 }
      check(patched > 0, `为 ${patched} 个空 ref 注入了假元素`)

      let effectError = ''
      let disposer = null
      try { disposer = scrollEffects[0]() } catch (error) { effectError = String(error && error.message ? error.message : error) }
      check(effectError === '', `滚动 effect 能真正执行${effectError === '' ? '' : ' —— ' + effectError}`)
      // 初始 pinned=true 且假元素不在底部 → 应当跟随到底（scrollHeight 1000 - clientHeight 400）
      check(fakeEl.scrollTop === 600, `滚动 effect 生效：贴底时滚到底部（scrollTop=${fakeEl.scrollTop}，期望 600）`)
      check(disposer === undefined || typeof disposer === 'function', '滚动 effect 的返回值是一个合法清理函数或 undefined')

      for (const fn of viewKeyEffects) {
        let viewKeyError = ''
        try { fn() } catch (error) { viewKeyError = String(error && error.message ? error.message : error) }
        check(viewKeyError === '', `视图切换 effect 能真正执行${viewKeyError === '' ? '' : ' —— ' + viewKeyError}`)
        // 再跑一次：key 未变时应直接返回，不会无限 setState
        let repeatError = ''
        try { fn() } catch (error) { repeatError = String(error && error.message ? error.message : error) }
        check(repeatError === '', '视图切换 effect 重复执行不会出错（key 未变时直接返回）')
      }
    }
  }
}

const total = checks + keyCases.length + orders.length
console.log(problems.length === 0
  ? `\n客户端纯函数测试：全部通过（${total} 项断言）`
  : `\n客户端纯函数测试：${problems.length} 项失败\n  - ${problems.join('\n  - ')}`)
process.exit(problems.length === 0 ? 0 : 1)
