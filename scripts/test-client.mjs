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
const check = (ok, label) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) problems.push(label) }

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

console.log(problems.length === 0
  ? `\n客户端纯函数测试：全部通过（${keyCases.length + orders.length + 9} 项断言）`
  : `\n客户端纯函数测试：${problems.length} 项失败\n  - ${problems.join('\n  - ')}`)
process.exit(problems.length === 0 ? 0 : 1)
