#!/usr/bin/env node
/**
 * bench-runtime.mjs —— 0.3.0 运行时性能回归防线（M0）。
 *
 * 为什么：bench-startup.mjs 只管启动；open/send/capture/读屏这些**每次工具调用都走**的
 * 热路径此前只有手测数字。本脚本对打包产物 + 真 tmux（私有 socket）做 N 轮采样，
 * 报 p50/p95，并对红线给 PASS/WARN（红线是"体感悬崖"的经验值，不是硬失败）。
 *
 * 采样项：
 *   open    shell_open（含 create + capture 首屏）
 *   run     shell_run 'echo tick-N'（发送 + idle 等待 + 尾部读取全链路）
 *   send    shell_send 纯键入（无等待语义的最小写路径）
 *   cap     driver.captureWithMeta（control 通 / 断两态各测）
 *   screen  HTTP /screen 路由（面板 700ms 轮询打的就是它）
 *   list    HTTP /list 路由（面板每轮都拉）
 *   read    shell_read mode=summary（0.3.0 态势摘要）
 *
 * 用法：DSH_PEERS_DIR=… node scripts/bench-runtime.mjs [轮数=25]
 * 退出码恒 0（信息性基准；红线越界打 WARN 不拦 CI —— 机器差异太大，趋势比绝对值有用）。
 */

import { makeHarness, resolvePeers, packIntoTemp, skipOrFail } from './lib/kit.mjs'

const peersDir = resolvePeers(process.argv[3])
if (peersDir === null) skipOrFail('运行时基准')
const ROUNDS = Number.isFinite(Number(process.argv[2])) && Number(process.argv[2]) > 2
  ? Math.min(200, Math.floor(Number(process.argv[2]))) : 25

const tgz = packIntoTemp()
const h = await makeHarness({ tgz, peersDir, socket: 'dsh-bench' })

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
const fmt = (ms) => `${ms.toFixed(1)}ms`

async function bench(label, fn, rounds = ROUNDS) {
  const samples = []
  for (let i = 0; i < rounds; i += 1) {
    const t0 = process.hrtime.bigint()
    await fn(i)
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const row = { label, p50: pct(samples, 0.5), p95: pct(samples, 0.95), min: samples[0], max: samples[samples.length - 1] }
  console.log(`  ${label.padEnd(22)} p50=${fmt(row.p50).padStart(9)}  p95=${fmt(row.p95).padStart(9)}  min=${fmt(row.min).padStart(9)}  max=${fmt(row.max).padStart(9)}`)
  return row
}

console.log(`dsh-agent-shell bench-runtime — ${ROUNDS} 轮/项 · socket dsh-bench · tmux ${h.tmux ?? '?'}`)
console.log('（control 通 = 长驻客户端热路径；control 断 = 每 op 一次 spawn 的降级路径）\n')

const results = []

// ── 会话级 ──────────────────────────────────────────────────────────────
{
  const t0 = Date.now()
  const opened = await h.run('shell_open', { name: 'bench', cols: 100, rows: 30 })
  console.log(`  冷 open（首个会话，含服务端启动）: ${Date.now() - t0}ms`)
  const id = String(opened).match(/session (\S+)/)[1]

  results.push(await bench('run echo', async (i) => { await h.run('shell_run', { session: id, command: `echo tick-${i}` }) }, Math.min(ROUNDS, 15)))
  results.push(await bench('send keys (settle150)', async () => { await h.run('shell_send', { session: id, text: 'x', lines: 0, settleMs: 150 }) }, Math.min(ROUNDS, 15)))
  results.push(await bench('read summary', async () => { await h.run('shell_read', { session: id, mode: 'summary' }) }, Math.min(ROUNDS, 15)))

  // capture：control 通
  results.push(await bench('capture (control)', async () => { await h.driver.captureWithMeta(id, undefined, { trim: false }) }))
  // capture：control 断（每次 op 前重新 markControlDown 压住退避窗）
  results.push(await bench('capture (one-shot)', async () => { h.driver.markControlDown(); await h.driver.captureWithMeta(id, undefined, { trim: false }) }))
  h.driver.noteControlOk?.()

  // HTTP 路由（面板轮询面）
  if (typeof h.call === 'function') {
    results.push(await bench('GET /screen', async () => { await h.call(`/screen?name=${id}`, 'GET') }, Math.min(ROUNDS, 20)))
    results.push(await bench('GET /list', async () => { await h.call('/list', 'GET') }, Math.min(ROUNDS, 20)))
    // 面板逐键路径（含 sendKeys 的默认 400ms settle —— 那是渲染窗口的刻意设计，不是回归）
    results.push(await bench('POST /keys', async () => { await h.call('/keys', 'POST', { name: id, text: 'y' }) }, Math.min(ROUNDS, 10)))
  } else {
    console.log('  (harness 未暴露 HTTP call —— 跳过 /screen /list)')
  }

  await h.run('shell_manage', { action: 'close', session: id })
}

// ── 红线（体感悬崖经验值）──────────────────────────────────────────────────
// 面板轮询面（/screen /list）与 capture 是"每次交互都付"的税 → 严红线；
// 工具往返（run/send）含**刻意**的渲染 settle（回车后 250ms + 空闲后 150ms），预算放宽。
console.log('\n红线核对（体感悬崖经验值，机器差异大 —— 看趋势别抠绝对值）:')
const redlines = [
  ['GET /screen', 20], ['GET /list', 30], ['capture (control)', 15], ['capture (one-shot)', 25],
  ['read summary', 150], ['send keys (settle150)', 250], ['run echo', 600], ['POST /keys', 550],
]
for (const [label, budget] of redlines) {
  const row = results.find((r) => r.label === label)
  if (row === undefined) continue
  const verdict = row.p95 <= budget ? 'PASS' : 'WARN'
  console.log(`  ${verdict === 'PASS' ? '✓' : '⚠'} ${label.padEnd(20)} p95=${fmt(row.p95).padStart(9)} / 预算 ${budget}ms`)
}

await h.cleanup()
process.exit(0)
