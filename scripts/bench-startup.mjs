#!/usr/bin/env node
/**
 * 启动性能基准：把**真实打包产物**装进一个假宿主 ctx 跑 apply()，测：
 *   · apply → "startup ready" 的墙钟耗时；
 *   · 启动期间 spawn 的子进程次数（这是启动成本的大头：tmux/sh/lsattr/看门狗 Node…）；
 *   · 看门狗是"启动即布防"还是"延迟到首个会话"；
 *   · 审计链校验耗时（读全部按天文件）。
 *
 * 用私有 socket（默认 dsh-bench）与临时 auditDir，跑完一定清理，不碰你自己的 tmux/审计。
 *
 * 用法：
 *   node scripts/bench-startup.mjs                 # 自己 npm pack 到临时目录
 *   node scripts/bench-startup.mjs <tgz> <peer目录>
 * 对比版本：改完代码跑一次，git stash 再跑一次即可（脚本本身不受影响）。
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SOCKET = 'dsh-bench'
const PEER_PACKAGES = ['dsh-tools', 'cordis', 'schemastery']

function peersFrom (candidate) {
  if (candidate === undefined) return null
  return PEER_PACKAGES.every((p) => existsSync(join(candidate, '@deepseek-ai', p))) ? candidate : null
}
function packIntoTemp () {
  const dest = mkdtempSync(join(tmpdir(), 'dsh-bench-tgz-'))
  const name = execFileSync('npm', ['pack', '--pack-destination', dest, '--silent'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim().split('\n').pop()
  return join(dest, name)
}

const tgz = process.argv[2] !== undefined && process.argv[2] !== '-' ? process.argv[2] : packIntoTemp()
const peers = peersFrom(process.argv[3]) ?? peersFrom(process.env.DSH_PEERS_DIR)
if (peers === null) {
  console.error('找不到宿主 peer（@deepseek-ai/{dsh-tools,cordis,schemastery}）。传第 3 个参数或设 DSH_PEERS_DIR')
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), 'dsh-bench-'))
const linkDir = join(root, 'node_modules', '@deepseek-ai')
mkdirSync(linkDir, { recursive: true })
for (const p of PEER_PACKAGES) symlinkSync(join(peers, '@deepseek-ai', p), join(linkDir, p), 'dir')
execFileSync('tar', ['-xzf', tgz, '-C', root])
const pkgDir = join(root, 'package')

const cleanup = () => {
  try {
    const [pid] = readFileSync(`/tmp/${SOCKET}-watchdog.pid`, 'utf8').trim().split(/\s+/)
    if (/^[0-9]+$/.test(pid ?? '')) process.kill(Number(pid), 'SIGTERM')
  } catch { /* 无 pid 文件 */ }
  try { execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }) } catch { /* 已无 */ }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
  try { rmSync(`/tmp/${SOCKET}-watchdog.pid`, { force: true }) } catch { /* 忽略 */ }
  try { rmSync(`/tmp/${SOCKET}-tmux.conf`, { force: true }) } catch { /* 忽略 */ }
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

/* ---------- 假宿主 ctx（统计 spawn 次数） ---------- */
let spawnCount = 0
const spawnArgs = []
const subprocess = {
  spawn ({ argv, cwd }) {
    spawnCount += 1
    spawnArgs.push(argv[0])
    const [cmd, ...args] = argv
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const out = []; const err = []
    child.stdout.on('data', (c) => out.push(c))
    child.stderr.on('data', (c) => err.push(c))
    const done = new Promise((resolve) => {
      child.on('close', (code) => resolve({ exitCode: code ?? -1 }))
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
const timer = { timeout: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
const tools = new Map()
const routes = new Map()
const webServer = { host: '127.0.0.1', port: 3080, register: (route) => { routes.set(route.path, route.handler); return () => {} } }
const ctx = {
  get: (name) => ({ subprocess, timer, userQuestions: { ask: async () => ({ answers: [] }) } })[name],
  effect: (cb) => cb(),
  on: () => () => {},
  logger: { log: () => {}, warn: () => {}, error: () => {} },
  tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
  inject: (names, cb) => {
    if (!Array.isArray(names) || !names.includes('webServer')) return
    cb({ get: (n) => (n === 'webServer' ? webServer : undefined), webServer, effect: (f) => f() })
  },
}

/* ---------- 跑 ---------- */
const lines = []
const realLog = console.log
const realWarn = console.warn
const realError = console.error
const capture = (orig) => (...args) => { lines.push(String(args[0] ?? '')); orig(...args) }
console.log = capture(realLog)
console.warn = capture(realWarn)
console.error = capture(realError)

const mod = await import(join(pkgDir, 'lib', 'index.js'))
const auditDir = join(root, 'audit')
const t0 = performance.now()
mod.apply(ctx, { socket: SOCKET, httpBase: '/plugins/bench', watchdog: true, exposeHttp: false, exposeTools: true, extendedKeys: false, auditDir })

// 等 "startup ready in Xms"（或超时 15s）
const deadline = Date.now() + 15000
let readyLine = null
while (Date.now() < deadline) {
  readyLine = lines.find((l) => l.includes('startup ready in')) ?? null
  if (readyLine !== null) break
  await new Promise((r) => setTimeout(r, 20))
}
const total = performance.now() - t0
await new Promise((r) => setTimeout(r, 400))   // 让异步尾巴（审计/看门狗）落定

console.log = realLog
console.warn = realWarn
console.error = realError

const readyMs = readyLine === null ? null : Number(/startup ready in (\d+)/.exec(readyLine)?.[1])
const deferred = lines.some((l) => l.includes('watchdog deferred'))
const armed = lines.some((l) => l.includes('watchdog armed') || l.includes('adopted the existing watchdog'))
const chainMs = (() => {
  const chainLine = lines.find((l) => l.includes('审计哈希链'))
  return chainLine ?? null
})()

console.log(`发包：${tgz}`)
console.log(`peer：${peers}`)
console.log(`工具/路由：${tools.size} 个工具 / ${routes.size} 条路由`)
console.log(`apply → ready：${total.toFixed(0)} ms（插件自报 ${readyMs === null || !Number.isFinite(readyMs) ? '未打印' : String(readyMs) + ' ms'}）`)
console.log(`ready 行：${readyLine === null ? '(无)' : readyLine}`)
console.log(`启动期 spawn 子进程：${spawnCount} 次${spawnCount > 0 ? `（${[...new Set(spawnArgs)].join(', ')}）` : ''}`)
console.log(`看门狗：${deferred ? '延迟到首个会话（未在启动期 spawn）' : armed ? '启动即布防' : '未布防'}`)
console.log(`审计：${chainMs === null ? '无告警' : chainMs.trim()}`)
// 显式退出：启动期可能 spawn 了看门狗子进程（stdio 管道未关），否则父进程会被它吊住
process.exit(0)