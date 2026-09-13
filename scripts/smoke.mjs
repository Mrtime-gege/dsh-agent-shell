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
// 假 userQuestions：确认门的真实契约（ask({questions,agent}) → {answers:[{id,selected}]}）。
// 冒烟要覆盖「打包产物里确认门真的会问一次」，所以桩必须提供它。
const consentAsks = []
const userQuestions = {
  ask: async (request) => {
    consentAsks.push(request)
    const id = request?.questions?.[0]?.id ?? 'unknown'
    // 选第一个选项，不写死文案（措辞会随权限模型演进）
    const opts = Array.isArray(request?.questions?.[0]?.options) ? request.questions[0].options : []
    return { answers: [{ id, selected: [opts[0]?.label ?? '允许'] }] }
  },
}
const ctx = {
  get: (name) => ({ subprocess, timer, userQuestions })[name],
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
// 真实工具管线一定带调用方 agent；确认门与归属都依赖它，冒烟桩必须一样。
const SMOKE_EXEC = { agent: { session: { id: 'smoke-conversation' } } }
const run = async (name, args) => {
  const tool = tools.get(name)
  if (tool === undefined) throw new Error(`工具不存在：${name}`)
  const value = await tool.execute(args, SMOKE_EXEC)
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/* ---------- 走一遍 ---------- */

const mod = await import(join(pkgDir, 'lib', 'index.js'))
console.log(`导出：${Object.keys(mod).sort().join(', ')}\n`)
check(mod.name === 'dsh-agent-shell', `插件名 = ${mod.name}`)

// 审计/授权/归属一律落到临时目录：测试跑出来的记录**绝不**能进用户的真实目录
// （实测踩到过：上一次冒烟把 smoke-conversation 的授权写进 ~/.dsh/agent-shell/consent.json，
//  下一次冒烟直接"已授权"、确认门整条路径等于没测）。
mod.apply(ctx, {
  socket: SOCKET, httpBase: BASE, watchdog: true, exposeHttp: true, exposeTools: true,
  extendedKeys: true, auditDir: join(root, 'audit'),
})

check(tools.size === 10, `注册工具数 = ${tools.size}（期望 10——v2 工具面）`)
check(routes.size === 11, `注册 HTTP 路由数 = ${routes.size}（期望 11）`)

// 4.5 依赖自检脚本（随包发布：AI 靠它判断要不要装 tmux）
{
  const scriptPath = join(pkgDir, 'install-deps.sh')
  check(existsSync(scriptPath), 'install-deps.sh 在发布产物里')
  const probe = execFileSync('bash', [scriptPath, '--check'], { encoding: 'utf8' })
  check(probe.includes('tmux'), `--check 报告 tmux 状态：${(probe.split('\n').find((l) => l.includes('tmux')) ?? '').trim()}`)
  check(probe.includes('[ok]') || probe.includes('[missing]'), '输出用 [ok]/[missing] 标注（人读得懂，AI 也好解析）')
  check(probe.includes('结论：'), `给出明确结论：${probe.split('\n').filter((l) => l.startsWith('结论')).join(' ')}`)
}

await new Promise(r => setTimeout(r, 300))
const conf = readFileSync(`/tmp/${SOCKET}-tmux.conf`, 'utf8')
check(conf.includes('extended-keys on'), 'extendedKeys: true 已写进服务端启动配置')

const opened = await run('shell_open', { name: 'smoke', cols: 90, rows: 24 })
const session = (opened.match(/session (\S+)/) ?? [])[1]
check(/^dsh-[a-z0-9]+$/.test(session) && String(opened).includes('(dsh-smoke)'),
  `shell_open → id=${session} label=dsh-smoke（寻址用 id）`)

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

const hist = await run('shell_read', { session, mode: 'history', lines: 60 })
check(hist.includes('SMOKE-42'), 'shell_read history 能读到滚出屏幕的内容')

const listed = await run('shell_state', { scope: '*' })
check(listed.includes('dsh-smoke'), 'shell_state 列出该会话（label=dsh-smoke）')

const renamed = await run('shell_manage', { action: 'rename', session, newName: 'renamed' })
check(renamed.includes('dsh-renamed'), `shell_manage rename → ${renamed.trim()}`)

const resized = await run('shell_manage', { action: 'resize', session, cols: 100, rows: 30 })
check(resized.length > 0, 'shell_manage resize 有返回')

check((await run('shell_state', { scope: '*' })).length > 0, 'shell_state 有输出')

const created = await call('/new', 'POST', { name: 'http', cols: 80, rows: 24 })
check(created.code === 200 && /^dsh-[a-z0-9]+$/.test(String(created.body?.name ?? '')),
  `POST /new → ${created.code} id=${created.body?.name}（label=dsh-http）`)

const list = await call('/list', 'GET')
check(list.body?.sessions?.length === 2, `GET /list → ${list.body?.sessions?.length} 个会话`)

const viaHttp = await call('/rename', 'POST', { name: created.body.name, newName: 'http2' })
check(viaHttp.body?.name === created.body.name && viaHttp.body?.label === 'dsh-http2',
  `POST /rename 只改 label：id=${viaHttp.body?.name} label=${viaHttp.body?.label}`)

check((await run('shell_manage', { action: 'close', session })).includes('closed'), 'shell_manage close 生效')
check((await run('shell_manage', { action: 'close', session: created.body.name })).includes('closed'),
  'shell_manage close 第二个会话')

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
await run('shell_manage', { action: 'close', session: keepmeId })

// (3) 看门狗静默死亡 → 下一次操作必须自愈重布防（节流窗口 5 秒，故先等过去）
if (hasHarness) {
  await driver.disarmWatchdog()
  check(await driver.watchdogPid() === '', '看门狗已停掉（模拟静默死亡）')
  await new Promise(r => setTimeout(r, 5200))
  await run('shell_state', { scope: '*' })
  await new Promise(r => setTimeout(r, 1000))
  const rearmed = await driver.watchdogPid()
  check(rearmed !== '', `自愈生效：看门狗重新布防为 pid ${rearmed || '(无)'}`)
  await driver.disarmWatchdog()
} else {
  console.log('  · 无 harness 祖先，跳过看门狗自愈断言')
}

// (4) 看门狗脚本的关键修正（静态断言，防止以后被改回去）
const tmuxSrc = readFileSync(join(pkgDir, 'lib', 'tmux.js'), 'utf8')
check(tmuxSrc.includes('grep -qv "^$$$"'), '守卫排除了看门狗自身 pid（旧写法会匹配到自己，导致 kill-server 永不执行）')
check(tmuxSrc.includes('miss=$((miss+1))'), '存活判定容忍连续失败（旧写法一次失败就永久退出）')
// 重启窗口：这两个常量决定「重启 dsh web 会不会把用户的 shell 全杀掉」。
// 旧断言写的是 includes('-lt 3') —— 而 '-lt 3' 是 '-lt 30' 的**子串**，阈值改了也照样通过，
// 属于弱断言；这里改成解析常量并断言乘积，顺便要求脚本确实引用了常量（不与脚本脱节）。
const missLimit = Number(/WATCHDOG_MISS_LIMIT\s*=\s*([0-9]+)/.exec(tmuxSrc)?.[1] ?? 0)
const probeSeconds = Number(/WATCHDOG_PROBE_SECONDS\s*=\s*([0-9]+)/.exec(tmuxSrc)?.[1] ?? 0)
check(missLimit > 0 && probeSeconds > 0,
  `看门狗窗口是具名常量（${missLimit} 次 × ${probeSeconds}s）而不是散在脚本里的魔数`)
check(missLimit * probeSeconds >= 60,
  `重启窗口 ≥ 60 秒（实到 ${missLimit * probeSeconds} 秒）—— 短于 systemctl restart 的真空期就会误杀整个 tmux 服务端`)
check(tmuxSrc.includes('-lt ${WATCHDOG_MISS_LIMIT}') && tmuxSrc.includes('sleep ${WATCHDOG_PROBE_SECONDS}'),
  '脚本引用的就是这两个常量（改常量即改行为，不会与脚本脱节）')

const empty = await call('/list', 'GET')
check(empty.body?.sessions?.length === 0, `收尾：剩 ${empty.body?.sessions?.length} 个会话`)

// 4.4 首次使用确认门（打包产物里必须真的生效）
{
  check(consentAsks.length >= 1, `首次调用工具时问了用户一次（${consentAsks.length} 次）`)
  const q = consentAsks[0]?.questions?.[0]
  check(q !== undefined && String(q.detail ?? '').includes('任意命令'), '确认问题写明「授权执行任意命令」')
  check(consentAsks.length === 1, `同对话后续调用不再重复询问（共 ${consentAsks.length} 次）`)
}

console.log(problems.length === 0
  ? '\n冒烟测试通过：打包产物可加载、可注册、可驱动真实 tmux。'
  : `\n冒烟测试失败，共 ${problems.length} 项：\n  - ${problems.join('\n  - ')}`)
process.exit(problems.length === 0 ? 0 : 1)
