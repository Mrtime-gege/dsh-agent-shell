/**
 * 测试工具包：给 `smoke.mjs`、`test-edge.mjs` 共用的装载与调用脚手架。
 *
 * 目标是把「把真实打包产物装进一个假宿主里跑起来」这件事做一次，两个测试各自只写断言。
 *
 * 关键点：
 *   * **只解包 `npm pack` 的产物**，并且**只链宿主 peer**（`@deepseek-ai/*`）——
 *     这样测的才是用户真正会装到的东西，而不是源码目录；
 *   * 假 ctx 只提供插件真正会用到的服务（subprocess / timer / webServer / tools），
 *     其余 `ctx.get()` 一律返回 undefined，顺便验证插件的降级路径；
 *   * 所有 tmux 都跑在**私有 socket**上，收尾一定 `kill-server`，不碰用户自己的 tmux。
 */

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

export const PEER_PACKAGES = ['dsh-tools', 'cordis', 'schemastery']

/* ── peer 定位 ─────────────────────────────────────────────────────────────── */

function peersFrom (target) {
  for (const candidate of [join(target, 'node_modules'), target]) {
    if (PEER_PACKAGES.every(p => existsSync(join(candidate, '@deepseek-ai', p)))) return candidate
  }
  return null
}

/** argv[2] → 环境变量 → 从当前目录向上用 Node 解析。找不到返回 null。 */
export function resolvePeers (extra) {
  if (extra !== undefined) return peersFrom(extra)
  if (process.env.DSH_PEERS_DIR !== undefined) return peersFrom(process.env.DSH_PEERS_DIR)
  try {
    const require = createRequire(join(process.cwd(), 'noop.js'))
    return dirname(dirname(dirname(require.resolve('@deepseek-ai/dsh-tools/package.json'))))
  } catch { return null }
}

/** 找不到 peer 时的统一话术；`SMOKE_REQUIRE=1` 时视为失败而不是跳过。 */
export function skipOrFail (what) {
  const message = [
    `跳过${what}：找不到宿主 peer（@deepseek-ai/{dsh-tools,cordis,schemastery}）。`,
    '  · 用 DSH 部署目录跑：DSH_PEERS_DIR=/path/to/dsh-webui node <script>',
    '  · 或先装 peer：npm i --no-save @deepseek-ai/dsh-tools@0.1.2-rc.1 @deepseek-ai/cordis@4.0.2 @deepseek-ai/schemastery@3.18.2',
  ].join('\n')
  if (process.env.SMOKE_REQUIRE === '1') { console.error(message); process.exit(1) }
  console.log(message)
  process.exit(0)
}

/* ── 打包产物 ──────────────────────────────────────────────────────────────── */

export function packIntoTemp () {
  const destination = mkdtempSync(join(tmpdir(), 'dsh-kit-tgz-'))
  const name = execFileSync('npm', ['pack', '--pack-destination', destination, '--silent'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim().split('\n').pop()
  return join(destination, name)
}

/* ── 假宿主 ────────────────────────────────────────────────────────────────── */

/**
 * 把打包产物解包、链上 peer，并装进一个假 ctx 里。
 *
 * @returns {Promise<{pkgDir, tools, routes, run, call, driver, tmux, cleanup, logs}>}
 */
export async function makeHarness ({ tgz, peersDir, socket, config = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-kit-'))
  const linkDir = join(root, 'node_modules', '@deepseek-ai')
  mkdirSync(linkDir, { recursive: true })
  for (const p of PEER_PACKAGES) symlinkSync(join(peersDir, '@deepseek-ai', p), join(linkDir, p), 'dir')
  execFileSync('tar', ['-xzf', tgz, '-C', root])
  const pkgDir = join(root, 'package')

  const subprocess = {
    spawn ({ argv, cwd }) {
      const [cmd, ...rest] = argv
      const child = spawn(cmd, rest, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
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
  const logs = []

  // 可选：假的 ctx.settings（官方 installSection 契约）。用来验证「服务在 → 注册并热更；
  // 服务不在 → 退回组合配置仍能工作」两条路径，而不必真去起一个 DSH。
  let settingsSource = () => config
  const settingsChanges = []
  const settingsRegistrations = []
  // 可选：假的 ctx.systemPrompt（验证「注册了使用策略段落」而不必真起 DSH）
  const systemPromptContexts = []
  const systemPrompt = config.__withSystemPrompt === true
    ? {
        context: (contribution) => { systemPromptContexts.push(contribution); return () => {} },
        getContextOrder: () => 100,
      }
    : undefined

  let settingsHooks = null
  const settings = config.__withSettings === true
    ? {
        installSection (owner, ns, schema, entry, hooks) {
          // 真实服务的 resolve() 会**先套上 schema 默认值**再调 validate，这里照做：
          // 否则 validate 收到的是缺字段的原始 entry，会误判成非法值。
          const resolved = typeof schema === 'function' ? schema(entry) : entry
          if (typeof hooks.validate === 'function') hooks.validate(resolved)
          settingsRegistrations.push({ ns, entry, resolved, schema, validate: hooks.validate })
          settingsHooks = hooks
          hooks.setSource(() => settingsSource())
          hooks.onChange()
          return () => {}
        },
      }
    : undefined
  const webServer = { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } }
  const effect = (cb) => cb()
  const base = String(config.httpBase ?? '/plugins/shell')
  const services = { subprocess, timer }
  if (settings !== undefined) services.settings = settings
  const ctx = {
    get: (name) => ({ subprocess, timer, settings, systemPrompt })[name],
    effect,
    on: () => () => {},
    logger: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    tools: { register: (def) => { tools.set(def.name, def); return () => {} } },
    inject: (names, cb) => {
      if (names.includes('webServer')) {
        cb({ get: (n) => (n === 'webServer' ? webServer : undefined), webServer, effect })
      }
      if (names.includes('systemPrompt') && systemPrompt !== undefined) {
        cb({ get: (n) => (n === 'systemPrompt' ? systemPrompt : undefined), systemPrompt, effect })
      }
    },
  }

  const mod = await import(join(pkgDir, 'lib', 'index.js'))
  mod.apply(ctx, { socket, httpBase: base, watchdog: false, exposeHttp: true, exposeTools: true, ...config })

  const run = async (name, args) => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`工具不存在：${name}`)
    const value = await tool.execute(args ?? {}, {})
    return typeof value === 'string' ? value : JSON.stringify(value)
  }

  const call = async (path, method = 'GET', body) => {
    const routePath = `${base}${path.split('?')[0]}`
    const handler = routes.get(routePath)
    if (handler === undefined) throw new Error(`路由不存在：${routePath}`)
    const req = { url: path, method, headers: {}, socket: { remoteAddress: '127.0.0.1' }, on: () => {}, destroy () {} }
    if (method !== 'GET') {
      // 传 `raw` 时按原始字节送（用来测非法 JSON）
      const payload = body !== undefined && body !== null && body.__raw !== undefined
        ? String(body.__raw)
        : JSON.stringify(body ?? {})
      req.on = (ev, fn) => {
        if (ev === 'data') fn(Buffer.from(payload))
        if (ev === 'end') fn()
      }
    }
    const res = { _code: 0, _body: '', writeHead (c) { this._code = c }, end (p) { this._body = p ?? '' } }
    await handler(req, res)
    let parsed; try { parsed = JSON.parse(res._body) } catch { parsed = res._body }
    return { code: res._code, body: parsed }
  }

  const tmux = (args) => {
    try { return execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }) } catch (error) { return error.stdout ?? '' }
  }
  const cleanup = () => {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }
    try { execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' }) } catch { /* 已无服务端 */ }
    try { rmSync(`/tmp/${socket}-watchdog.pid`, { force: true }) } catch { /* 忽略 */ }
    try { rmSync(`/tmp/${socket}-tmux.conf`, { force: true }) } catch { /* 忽略 */ }
  }
  process.on('exit', cleanup)

  const { TmuxDriver } = await import(join(pkgDir, 'lib', 'tmux.js'))
  const driver = new TmuxDriver({
    subprocess, timer, socket, historyLimit: 5000, shell: 'bash',
    defaultTerminal: 'tmux-256color', cwd: '/', pidFile: `/tmp/${socket}-watchdog.pid`,
  })

  /**
   * 模拟用户在 DSH 设置页改了配置：换掉 source 并触发 onChange。
   * 只在 `config.__withSettings === true` 时可用。
   */
  const changeSettings = (next) => {
    if (settings === undefined || settingsHooks === null) {
      throw new Error('测试未启用假 settings 服务（传 __withSettings: true）')
    }
    const raw = { ...config, ...next, __withSettings: true }
    const schema = settingsRegistrations[0]?.schema
    const candidate = typeof schema === 'function' ? schema(raw) : raw
    if (typeof settingsHooks.validate === 'function') settingsHooks.validate(candidate)
    settingsSource = () => candidate
    settingsChanges.push(next)
    settingsHooks.onChange()      // 等价于用户在设置页保存后服务发出的通知
    return settings
  }

  return { pkgDir, tools, routes, run, call, driver, tmux, cleanup, logs, subprocess, timer,
    settings, settingsRegistrations, changeSettings, reloadConfig: () => config,
    systemPromptContexts, mod }
}

/** 断言器：收集失败而不是立刻抛出，跑完一次性汇报。 */
export function makeChecker () {
  const problems = []
  const check = (ok, label) => {
    console.log(`${ok ? '✓' : '✗'} ${label}`)
    if (!ok) problems.push(label)
    return ok
  }
  /** 期望抛错：tool 抛 / 路由返回非 2xx 都算「被拒绝」。 */
  const rejects = async (fn, label, expect = null) => {
    try {
      const value = await fn()
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      const refused = typeof value === 'object' && value !== null && (value.refused === true || value.code >= 400)
      if (!refused) return check(false, `${label} —— 期望被拒绝，却成功返回：${text.slice(0, 120)}`)
      if (expect !== null && !text.includes(expect)) return check(false, `${label} —— 错误信息里没有 ${JSON.stringify(expect)}：${text.slice(0, 160)}`)
      return check(true, `${label} → ${text.slice(0, 100)}`)
    } catch (error) {
      const message = String(error?.message ?? error)
      if (expect !== null && !message.includes(expect)) return check(false, `${label} —— 抛错了但信息里没有 ${JSON.stringify(expect)}：${message.slice(0, 160)}`)
      return check(true, `${label} → ${message.slice(0, 100)}`)
    }
  }
  const report = (title) => {
    console.log(problems.length === 0 ? `\n${title}：全部通过` : `\n${title}：${problems.length} 项失败\n  - ${problems.join('\n  - ')}`)
    return problems.length === 0 ? 0 : 1
  }
  return { check, rejects, report, problems }
}

export { readFileSync }
