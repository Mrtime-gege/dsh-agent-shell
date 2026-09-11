#!/usr/bin/env node
/**
 * 发布物冒烟测试：把**真实打包产物**解包，用一个假宿主 ctx 跑起来。
 *
 * 与「读源码」或「起一个 DSH」都不同，它验证的是**用户真正会装到的东西**：
 *
 *   1. `npm pack` 的产物里该有的文件都在（漏了 `cordis.patch.yml` 或入口，用户就装不起来）；
 *   2. 包在「不带自己的 node_modules、依赖靠上层解析」的真实形态下能 import；
 *   3. `apply()` 在假 ctx 上不抛错，且真的注册出 9 个工具与 8 条 HTTP 路由；
 *   4. 工具与 HTTP 两条路径都能驱动**真实 tmux**：建会话、发按键、读屏、改名、关闭；
 *   5. `extendedKeys` 之类的配置真的写进了服务端启动配置，且不影响服务端存活；
 *   6. 生命周期保护：harness pid 认的是本进程、启动时**不会**误清用户会话、看门狗死了会自愈。
 *
 * 用法：
 *
 *   npm run smoke                      # 自己 npm pack 到临时目录再测（最省事）
 *   node scripts/smoke.mjs <tgz> [peer 目录]
 *   node scripts/smoke.mjs - [peer 目录]   # 显式要求自动打包
 *
 * peer 目录（含 `@deepseek-ai/dsh-tools`、`cordis`、`schemastery` 的 `node_modules` 的父目录，
 * 通常就是 DSH 部署根或某个 profile 的 node_modules）按以下顺序确定：
 *   argv[3] → 环境变量 `DSH_PEERS_DIR` → 从当前目录向上用 Node 解析。
 *
 * 找不到 peer 时**跳过**（退出码 0），除非设了 `SMOKE_REQUIRE=1` —— 那时视为失败，
 * 免得 CI 因为没装 peer 而「静默通过」。
 *
 * 会在私有 socket（默认 `dsh-smoke`）上起真 tmux，结束时一定清掉；不碰你自己的 tmux。
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const SOCKET = 'dsh-smoke'
const BASE = '/plugins/shell'
const PEER_PACKAGES = ['dsh-tools', 'cordis', 'schemastery']

/* ---------- 取打包产物（不给就自己打一个） ---------- */

function packIntoTemp () {
  const destination = mkdtempSync(join(tmpdir(), 'dsh-smoke-tgz-'))
  const name = execFileSync('npm', ['pack', '--pack-destination', destination, '--silent'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim().split('\n').pop()
  return join(destination, name)
}

const givenTgz = process.argv[2]
const tgz = (givenTgz === undefined || givenTgz === '-') ? packIntoTemp() : givenTgz
if (!existsSync(tgz)) {
  console.error(`找不到打包产物：${tgz}\n先执行 npm pack，或不带参数运行本脚本让它自己打包。`)
  process.exit(2)
}

/* ---------- 定位 peer ---------- */

function peersFrom (target) {
  // target 是某个 node_modules 的父目录，或 node_modules 自身
  for (const candidate of [join(target, 'node_modules'), target]) {
    if (PEER_PACKAGES.every(p => existsSync(join(candidate, '@deepseek-ai', p)))) return candidate
  }
  return null
}

function resolvePeers () {
  if (process.argv[3] !== undefined) return peersFrom(process.argv[3])
  if (process.env.DSH_PEERS_DIR !== undefined) return peersFrom(process.env.DSH_PEERS_DIR)
  try {
    const require = createRequire(join(process.cwd(), 'noop.js'))
    const found = require.resolve('@deepseek-ai/dsh-tools/package.json')
    // .../node_modules/@deepseek-ai/dsh-tools/package.json → .../node_modules
    return dirname(dirname(dirname(found)))
  } catch { return null }
}

const peers = resolvePeers()
if (peers === null) {
  const message = [
    '跳过冒烟测试：找不到宿主 peer（@deepseek-ai/{dsh-tools,cordis,schemastery}）。',
    '  · 用 DSH 部署目录跑：node scripts/smoke.mjs <tgz> /path/to/dsh-webui',
    '  · 或先装 peer：npm i --no-save @deepseek-ai/dsh-tools@0.1.2-rc.1 @deepseek-ai/cordis@4.0.2 @deepseek-ai/schemastery@3.18.2',
  ].join('\n')
  if (process.env.SMOKE_REQUIRE === '1') { console.error(message); process.exit(1) }
  console.log(message)
  process.exit(0)
}

/* ---------- 解包到临时目录，只链 peer ---------- */

try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }) } catch { /* 本来就没起 */ }

const root = mkdtempSync(join(tmpdir(), 'dsh-smoke-'))
const linkDir = join(root, 'node_modules', '@deepseek-ai')
mkdirSync(linkDir, { recursive: true })
for (const p of PEER_PACKAGES) symlinkSync(join(peers, '@deepseek-ai', p), join(linkDir, p), 'dir')
execFileSync('tar', ['-xzf', tgz, '-C', root])
const pkgDir = join(root, 'package')
console.log(`peer 来自 ${peers}\n解包到 ${pkgDir}\n`)

const cleanup = () => {
  // 先把本次可能布防的看门狗收掉 —— 失败路径上不会走到显式 disarm，
  // 漏掉它就会在开发机留一个永远在 sleep 的守护进程。
  try {
    const [watchdog] = readFileSync(`/tmp/${SOCKET}-watchdog.pid`, 'utf8').trim().split(/\s+/)
    if (/^[0-9]+$/.test(watchdog ?? '')) process.kill(Number(watchdog), 'SIGTERM')
  } catch { /* 没有 pid 文件就没有看门狗 */ }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
  try { rmSync(`/tmp/${SOCKET}-watchdog.pid`, { force: true }) } catch { /* 忽略 */ }
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }) } catch { /* 已无服务端 */ }
  try { rmSync(`/tmp/${SOCKET}-tmux.conf`, { force: true }) } catch { /* 忽略 */ }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

/* ---------- 假宿主 ctx ---------- */

const subprocess = {
  spawn ({ argv, cwd }) {
    const [cmd, ...args] = argv
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []; const err = []
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))
    const done = new Promise((resolve) => {
      child.on('close', code => resolve({ exitCode: code ?? -1 }))
      child.on('error', () => resolve({ exitCode: -1 }))
    })
    return {
      done,
      collected: {
        stdout: { readFrom: () => ({ text: Buffer.concat(out).toString('utf8') }) },
        stderr: { readFrom: () => ({ text: Buffer.concat(err).toString('utf8') }) },
      },
    }
  },
}
const timer = { timeout: (ms) => new Promise(resolve => setTimeout(resolve, ms)) }

const tools = new Map()
const routes = new Map()
// 真 webServer 有 host/port getter（闸门据此判断是否本机），冒烟桩同样提供，
// 这样冒烟走的是**和面板一致**的请求形状 —— 否则闸门会（正确地）把它当成本机之外的东西拦掉。
const webServer = {
  host: '127.0.0.1',
  port: 3080,
  register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
}
const effect = (cb) => cb()
const ctx = {
  get: (name) => ({ subprocess, timer })[name],
  effect,
  on: () => () => {},
  logger: console,
  tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
  inject: (names, cb) => {
    if (!names.includes('webServer')) return
    cb({ get: (n) => (n === 'webServer' ? webServer : undefined), webServer, effect })
  },
}

/* ---------- 断言 ---------- */

const problems = []
const check = (ok, label) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) problems.push(label) }
const call = async (path, method, body) => {
  const routePath = `${BASE}${path.split('?')[0]}`
  const handler = routes.get(routePath)
  if (handler === undefined) throw new Error(`路由不存在：${routePath}`)
  const reqHeaders = { host: '127.0.0.1:3080' }
  if (method !== 'GET') reqHeaders['content-type'] = 'application/json'
  const req = { url: path, method, headers: reqHeaders, socket: { remoteAddress: '127.0.0.1' }, on: () => {}, destroy () {} }
  if (method !== 'GET') {
    req.on = (ev, fn) => {
      if (ev === 'data') fn(Buffer.from(JSON.stringify(body ?? {})))
      if (ev === 'end') fn()
    }
  }
  const res = { _code: 0, _body: '', writeHead (c) { this._code = c }, end (p) { this._body = p ?? '' } }
  await handler(req, res)
  let parsed; try { parsed = JSON.parse(res._body) } catch { parsed = res._body }
  return { code: res._code, body: parsed }
}
const run = async (name, args) => {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`工具不存在：${name}`)
  const value = await tool.execute(args, {})
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/* ---------- 走一遍 ---------- */

const mod = await import(join(pkgDir, 'lib', 'index.js'))
console.log(`导出：${Object.keys(mod).sort().join(', ')}\n`)
check(mod.name === 'dsh-agent-shell', `插件名 = ${mod.name}`)

mod.apply(ctx, { socket: SOCKET, httpBase: BASE, watchdog: true, exposeHttp: true, exposeTools: true, extendedKeys: true })

check(tools.size === 9, `注册工具数 = ${tools.size}（期望 9）`)
check(routes.size === 8, `注册 HTTP 路由数 = ${routes.size}（期望 8）`)

await new Promise(r => setTimeout(r, 300))
const conf = readFileSync(`/tmp/${SOCKET}-tmux.conf`, 'utf8')
check(conf.includes('extended-keys on'), 'extendedKeys: true 已写进服务端启动配置')

const opened = await run('shell_open', { name: 'smoke', cols: 90, rows: 24 })
const session = (opened.match(/session (\S+)/) ?? [])[1]
check(session === 'dsh-smoke', `shell_open → ${session}`)

await run('shell_send', { session, text: 'echo SMOKE-$((6*7))', keys: ['Enter'], settleMs: 500 })
let read = await run('shell_read', { session })
check(read.includes('SMOKE-42'), 'shell_send + shell_read 拿到结果')

let rejected = ''
try { await run('shell_send', { name: session, text: 'echo NOPE', keys: ['Enter'] }) } catch (error) { rejected = String(error?.name ?? error) }
check(rejected === 'ToolArgsError', `工具路径传 name 被参数校验拦下（${rejected || '没拦'}）`)

await call('/keys', 'POST', { name: session, text: 'echo HTTP-$((100-58))', keys: ['Enter'] })
await new Promise(r => setTimeout(r, 900))
read = await call(`/screen?name=${session}&lines=40`, 'GET')
check(read.body?.screen?.includes('HTTP-42'), 'HTTP 路径（请求体用 name）同样可用')

const hist = await run('shell_history', { session, lines: 60 })
check(hist.includes('SMOKE-42'), 'shell_history 能读到滚出屏幕的内容')

const listed = await run('shell_list', {})
check(listed.includes('dsh-smoke'), 'shell_list 列出该会话')

const renamed = await run('shell_rename', { session, newName: 'renamed' })
check(renamed.includes('dsh-renamed'), `shell_rename → ${renamed.trim()}`)

const resized = await run('shell_resize', { session: 'dsh-renamed', cols: 100, rows: 30 })
check(resized.length > 0, 'shell_resize 有返回')

check((await run('shell_diagnose', {})).length > 0, 'shell_diagnose 有输出')

const created = await call('/new', 'POST', { name: 'http', cols: 80, rows: 24 })
check(created.code === 200 && created.body?.name === 'dsh-http', `POST /new → ${created.code} ${created.body?.name}`)

const list = await call('/list', 'GET')
check(list.body?.sessions?.length === 2, `GET /list → ${list.body?.sessions?.length} 个会话`)

const viaHttp = await call('/rename', 'POST', { name: 'dsh-http', newName: 'http2' })
check(viaHttp.body?.name === 'dsh-http2', `POST /rename → ${viaHttp.body?.name ?? JSON.stringify(viaHttp.body)}`)

check((await run('shell_close', { session: 'dsh-renamed' })).includes('closed'), 'shell_close 生效')
check((await run('shell_close', { session: 'dsh-http2' })).includes('closed'), 'shell_close 第二个会话')

/* ---------- 生命周期保护 ---------- */

const { TmuxDriver } = await import(join(pkgDir, 'lib', 'tmux.js'))
const pidFile = `/tmp/${SOCKET}-watchdog.pid`
const driver = new TmuxDriver({
  subprocess,
  timer,
  socket: SOCKET,
  historyLimit: 1000,
  shell: 'bash',
  defaultTerminal: 'tmux-256color',
  extendedKeys: false,
  cwd: '/',
  pidFile,
})

// 这些断言需要「有一个活着的 harness 祖先」才能完整验证：CI 的 runner 上没有任何 dsh
// 进程，harnessPid() 会返回空串，看门狗也就布不了防。那种环境下只保留不依赖 harness 的部分，
// 并明确打印跳过原因 —— 不允许静默通过。

// (1) 认 harness：必须是空串，或落在本进程的祖先链上；绝不能是无关进程。
//     旧实现靠「祖先 cmdline 里第一个含 dsh 的进程」匹配，实测会被任何命令行提到 dsh
//     的中间进程骗到（真踩过：一条含 "dsh" 字样的 bash 命令被当成了 harness）。
const ancestorChain = []
{
  let pid = String(process.pid)
  for (let hops = 0; hops < 50 && pid !== '' && pid !== '0' && pid !== '1'; hops += 1) {
    ancestorChain.push(pid)
    const parent = execFileSync('sh', ['-c', `ps -o ppid= -p ${pid} 2>/dev/null | tr -d ' '`], { encoding: 'utf8' }).trim()
    pid = /^[0-9]+$/.test(parent) ? parent : ''
  }
}
const harness = await driver.harnessPid()
const hasHarness = /^[0-9]+$/.test(harness)
if (hasHarness) {
  check(ancestorChain.includes(harness), `harnessPid() 落在本进程祖先链上（不是无关进程）：${harness}`)
} else {
  console.log('  · 当前环境没有 harness 祖先（独立运行/CI）：harnessPid() 返回空串，与预期一致')
  check(harness === '', `harnessPid() 返回空串而不是无关进程：${JSON.stringify(harness)}`)
}

// (2) pid 文件记着「别的 harness」+ 服务端上有活会话 → 必须收养，不许清
await run('shell_open', { name: 'keepme', cols: 80, rows: 24 })
execFileSync('sh', ['-c', `printf '%s\\n' '999999 424242' > ${pidFile}`])
const boot = await driver.bootstrap()
const kept = await call('/list', 'GET')
check(boot.adopted === false && boot.kept.length >= 1, `bootstrap 报告保住了 ${boot.kept.length} 个会话`)
check(kept.body?.sessions?.length === 1, `pid 文件指向别的 harness 时，会话仍在（${kept.body?.sessions?.length} 个）`)
if (hasHarness) check(boot.watchdogPid !== '', `重新布防了看门狗：pid ${boot.watchdogPid}`)
else console.log('  · 无 harness 祖先，跳过「看门狗已重新布防」断言（布防本就无法进行）')
await run('shell_close', { session: 'dsh-keepme' })

// (3) 看门狗静默死亡 → 下一次操作必须自愈重布防（节流窗口 5 秒，故先等过去）
if (hasHarness) {
  await driver.disarmWatchdog()
  check(await driver.watchdogPid() === '', '看门狗已停掉（模拟静默死亡）')
  await new Promise(r => setTimeout(r, 5200))
  await run('shell_list', {})
  await new Promise(r => setTimeout(r, 1000))
  const rearmed = await driver.watchdogPid()
  check(rearmed !== '', `自愈生效：看门狗重新布防为 pid ${rearmed || '(无)'}`)
  await driver.disarmWatchdog()
} else {
  console.log('  · 无 harness 祖先，跳过看门狗自愈断言')
}

// (4) 看门狗脚本的两个关键修正（静态断言，防止以后被改回去）
const tmuxSrc = readFileSync(join(pkgDir, 'lib', 'tmux.js'), 'utf8')
check(tmuxSrc.includes('grep -qv "^$$$"'), '守卫排除了看门狗自身 pid（旧写法会匹配到自己，导致 kill-server 永不执行）')
check(tmuxSrc.includes('miss=$((miss+1))') && tmuxSrc.includes('-lt 3'), '存活判定容忍连续失败（旧写法一次失败就永久退出）')

const empty = await call('/list', 'GET')
check(empty.body?.sessions?.length === 0, `收尾：剩 ${empty.body?.sessions?.length} 个会话`)

console.log(problems.length === 0
  ? '\n冒烟测试通过：打包产物可加载、可注册、可驱动真实 tmux。'
  : `\n冒烟测试失败，共 ${problems.length} 项：\n  - ${problems.join('\n  - ')}`)
process.exit(problems.length === 0 ? 0 : 1)
