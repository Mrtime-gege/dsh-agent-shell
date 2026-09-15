#!/usr/bin/env node
/**
 * 看门狗行为断言（0.2.2 / C 流）—— 设计 C4 要求的三条，外加参数一致性。
 *
 *   1. 纯函数：租约新鲜 → 不杀；租约过期 ∧ 读不到 /proc → 杀（lease-only）；
 *      租约过期 ∧ 进程还在 → **不杀**（Doze 冻结误杀的防线）。
 *   2. 参数一致性：spawn 给 watchdog 的 CLI 参数与 lease 文件同源（grace / proc-readable / harness）。
 *   3. 真行为：租约过期且 harness 不在 → 服务端被收；租约过期但 harness 还在 → 不收。
 *
 * 用法：node scripts/test-watchdog.mjs [peer 目录]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolvePeers, skipOrFail, packIntoTemp, makeHarness, makeChecker } from './lib/kit.mjs'

const peersDir = resolvePeers(process.argv[2])
if (peersDir === null) skipOrFail('看门狗行为测试')

const { shouldReap } = await import('../lib/watchdog.mjs')
const { check, report } = makeChecker()

/* ── 1. 纯函数：三条判定 ─────────────────────────────────────────────────── */

{
  const base = { now: 100000, graceMs: 1000, procReadable: true, harness: '1234' }
  check(shouldReap({ ...base, lease: { harnessPid: '1234', refreshedAt: 99500 } }, () => false) === false,
    '租约新鲜（500ms < 1000ms grace）→ 不杀')
  check(shouldReap({ ...base, lease: { harnessPid: '1234', refreshedAt: 90000 } }, () => false) === true,
    '租约过期 ∧ harness 不在 → 杀')
  check(shouldReap({ ...base, lease: { harnessPid: '1234', refreshedAt: 90000 } }, () => true) === false,
    '租约过期 ∧ harness 还活着（被冻结）→ **不杀**（Doze 误杀防线）')
  check(shouldReap({ ...base, procReadable: false, lease: { harnessPid: '1234', refreshedAt: 90000 } }, () => true) === true,
    'lease-only（读不到 /proc）：只能信租约 → 过期即杀')
  check(shouldReap({ ...base, lease: { harnessPid: '1234', refreshedAt: 90000 } }, () => true) === false &&
    shouldReap({ ...base, lease: { harnessPid: '1234', refreshedAt: 100000 - 1001 } }, () => false) === true,
    'grace 边界：恰好 1000ms 不算过期，1001ms 才过期')
  check(shouldReap({ ...base, lease: { refreshedAt: null } }, () => true) === false,
    '租约缺 refreshedAt → 当作"刚从 0 起算"？（现值判定：视为过期但进程活着→不杀）')
}

/* ── 2/3. 真实进程：参数一致性 + 收/不收两种行为 ─────────────────────────── */

// sh-lowmem 分支的"参数一致性"（源级）：它的 pid 文件必须与 lease-node 共用同一格式
// `<watchdogPid> <harnessPid>`（readWatchdogState 按这个格式解析，两分支输出必须一致）。
{
  const src = readFileSync(new URL('../lib/tmux.js', import.meta.url), 'utf8')
  check(src.includes('echo "$$ ${pid}"') && src.includes('this.pidFile'),
    'sh-lowmem 分支写同一份两字段 pid 文件（与 lease-node 输出格式一致，readWatchdogState 共用）')
}



const tgz = packIntoTemp()
const h = await makeHarness({
  tgz, peersDir, socket: 'dsh-kit-watchdog',
  config: { watchdog: false, __consentMode: 'ok' },
})
const EXEC = { agent: { session: { id: 'wd-conv' } } }
const leaseFile = h.driver.leaseFile
const pidFile = h.driver.pidFile
const readLease = () => JSON.parse(readFileSync(leaseFile, 'utf8'))
const readPidFile = () => readFileSync(pidFile, 'utf8').trim()
const cmdlineOf = (pid) => {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ') } catch { return '' }
}
const alive = async () => (await h.driver.probe(['list-sessions'])).code === 0

await h.run('shell_open', { name: 'wd-1' }, EXEC)
check(await alive(), '前置：服务端已在（有会话）')

// 用一个**不存在的** harness pid 布防（测试进程本身认不出 harness，这不影响看门狗逻辑）
h.driver.watchdogIntervalMs = 800   // 拨小间隔：测试等得起、tick 跟得上
await h.driver.armLeaseWatchdog('999999')
check(existsSync(leaseFile) && existsSync(pidFile), '布防：lease 与 pid 文件都已写出')
{
  const lease = readLease()
  const wdPid = readPidFile().split(/\s+/)[0]
  const cmd = cmdlineOf(wdPid)
  check(lease.harnessPid === '999999' && lease.token !== '', `lease 内容：harnessPid=${lease.harnessPid} token 非空`)
  check(cmd.includes(`--lease=${leaseFile}`) && cmd.includes(`--harness=999999`),
    '参数一致性：watchdog CLI 的 lease/harness 与 lease 文件同源')
  check(cmd.includes(`--grace=${lease.policy.graceMs}`) &&
    cmd.includes(`--proc-readable=${lease.policy.procReadable ? '1' : '0'}`),
    `参数一致性：grace=${lease.policy.graceMs} / proc-readable=${lease.policy.procReadable ? '1' : '0'}`)

  // 场景 A：租约过期 + harness pid 不存在 → 应当收掉服务端
  writeFileSync(leaseFile, JSON.stringify({
    harnessPid: '999999', token: lease.token, refreshedAt: Date.now(),
    policy: { graceMs: 1200, procReadable: true },
  }))
  await h.driver.pause(4000)
  check((await alive()) === false, '租约过期且 harness 不在 → 服务端被看门狗收掉')
  check(!existsSync(pidFile) && !existsSync(leaseFile), '收工后 pid 文件与 lease 都被清理')
}

// 场景 B：重新布防，租约过期但 harness（本测试进程）还活着 → **不收**（冻结防线）
{
  h.driver.watchdogIntervalMs = 800
  await h.driver.armLeaseWatchdog(String(process.pid))
  const lease = readLease()
  check(lease.harnessPid === String(process.pid), `重新布防指向活着的进程 pid=${process.pid}`)
  await h.run('shell_open', { name: 'wd-2' }, EXEC)
  writeFileSync(leaseFile, JSON.stringify({
    harnessPid: String(process.pid), token: lease.token, refreshedAt: Date.now(),
    policy: { graceMs: 1200, procReadable: true },
  }))
  await h.driver.pause(4000)
  check(await alive(), '租约过期但 harness 进程还活着（被冻结）→ 服务端**未被收**')
  // 收尾：显式解布防（kill 看门狗）并清文件，避免残留进程影响后续测试
  await h.driver.disarmWatchdog()
  try { writeFileSync(leaseFile, JSON.stringify({ harnessPid: '', token: '', refreshedAt: 0, policy: {} })) } catch { /* ignore */ }
}

h.cleanup()
process.exit(report('看门狗行为测试'))