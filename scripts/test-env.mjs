#!/usr/bin/env node
/**
 * 能力探测与降级矩阵（0.2.2 / B 流）。
 *
 * 两段：
 *   1. **纯逻辑四组合**：mock IO 喂给 detectEnv，断言 planFor 的决议与 describeEnv 的人话承诺
 *      （每条降级必须有明确收缩的承诺，不能是"可能受限"）。
 *   2. **降级路径真跑主干**：把 driver 拨到降级档（plain-detach / raw-foreground），真实跑
 *      open → send → capture → close —— 保证每条降级路径都有人测（不是纸面计划）。
 *
 * 用法：node scripts/test-env.mjs [peer 目录]
 */

import { resolvePeers, skipOrFail, packIntoTemp, makeHarness, makeChecker } from './lib/kit.mjs'

const peersDir = resolvePeers(process.argv[2])
if (peersDir === null) skipOrFail('环境矩阵测试')

const { detectEnv, planFor, describeEnv } = await import('../lib/env.mjs')
const { check, report } = makeChecker()

/* ── 1. 纯逻辑：四张能力组合 ─────────────────────────────────────────────── */

const mkIO = ({ tmuxV = 'tmux 3.6b', tmuxOk = true, systemdRun = true, systemdDir = true, xdg = '/run/user/1000', proc = true, prefix = '' }) => ({
  env: { PREFIX: prefix, XDG_RUNTIME_DIR: xdg },
  exists: (p) => (p === '/run/systemd/system' ? systemdDir : false),
  read: async (p) => {
    if (String(p).startsWith('/proc/') && proc) return 'state\n'
    throw new Error('ENOENT')
  },
  tmp: () => '/data/data/com.termux/files/usr/tmp',
  pid: '1234',
  exec: async (cmd, args) => {
    if (cmd === 'tmux') return tmuxOk ? { code: 0, out: `${tmuxV}\n`, err: '' } : { code: 127, out: '', err: 'tmux: not found' }
    if (cmd === 'sh') {
      const probe = String(args?.[1] ?? '')
      if (probe.includes('systemd-run')) return { code: 0, out: systemdRun ? 'yes\n' : 'no\n', err: '' }
      return { code: 0, out: 'no\n', err: '' }
    }
    return { code: 1, out: '', err: 'unexpected' }
  },
})

{
  // A：全能力（Linux + systemd + /proc + tmux 3.6）
  const envA = await detectEnv(mkIO({}))
  const planA = planFor(envA)
  check(envA.hasTmux === true && envA.hasSystemdUser === true && envA.procReadable === true,
    `A 全能力：tmux=${envA.hasTmux} systemd=${envA.hasSystemdUser} proc=${envA.procReadable}`)
  check(planA.serverLaunch === 'systemd-scope' && planA.foreground === 'drill' && planA.extendedKeys === true,
    `A 决议：${planA.serverLaunch} / ${planA.foreground} / extendedKeys=${planA.extendedKeys}`)

  // B：无 systemd 用户会话（WSL 无 systemd 典型）→ 普通 detach + 收缩承诺
  const envB = await detectEnv(mkIO({ systemdRun: false }))
  const planB = planFor(envB)
  check(planB.serverLaunch === 'plain-detach', `B 无 systemd → ${planB.serverLaunch}`)
  const notesB = describeEnv(envB, planB).join('\n')
  check(notesB.includes('干净重启') && notesB.includes('不再存活'),
    'B 降级有一句明确承诺（"dsh 干净重启后会话不再存活"）')

  // C：读不到 /proc（macOS/受限容器）→ raw 前台 + self-only + tmux 3.1 压制 extended-keys
  const envC = await detectEnv(mkIO({ proc: false, tmuxV: 'tmux 3.1a' }))
  const planC = planFor(envC)
  check(planC.foreground === 'raw' && planC.harnessPid === 'self-only',
    `C 无 /proc → foreground=${planC.foreground} / harnessPid=${planC.harnessPid}`)
  check(planC.extendedKeys === false, `C tmux 3.1 → extended-keys ${planC.extendedKeys}（应压制）`)
  const notesC = describeEnv(envC, planC).join('\n')
  check(notesC.includes('嵌套 tmux') && notesC.includes('不准'), 'C 降级承诺写明嵌套 tmux 忙闲判定退化')

  // D：无 tmux + Termux 环境
  const envD = await detectEnv(mkIO({ tmuxOk: false, tmuxV: 'tmux 3.6b', systemdRun: false, systemdDir: false, xdg: '', proc: false, prefix: '/data/data/com.termux/files/usr' }))
  const planD = planFor(envD)
  check(envD.hasTmux === false && envD.isTermux === true, `D：hasTmux=${envD.hasTmux} isTermux=${envD.isTermux}`)
  check(planD.watchdog === 'off' && planD.extendedKeys === false, `D 无 tmux → watchdog=${planD.watchdog} extendedKeys=${planD.extendedKeys}`)
  check(describeEnv(envD, planD).some((l) => l.includes('Termux')), 'D 描述里点明 Termux（依赖走 pkg）')
  check(envD.tmpDir.includes('termux'), `D tmpDir 走 os.tmpdir（Android 无 /tmp）：${envD.tmpDir}`)
}

/* ── 1b. 宿主预置（io.tmux）优先于直连探测：修复 env.mjs:76 的回归 ────────────── */

{
  // 真实运行里 driver 的 tmux 探测走 subprocess 服务（可靠），本模块直连 execFile 在
  // 受限 harness 里会失败（实测：dsh web 沙箱 tmux -V 直连失败而 driver 正常）。
  // 修复前 detectEnv 返回的是直连原始结果 hasTmux: okText，把 preset 感知值丢掉 →
  // 看门狗被误关（planFor.watchdog = 'off'）。以下两条就是那个场景的回归断言。
  const directFail = mkIO({ tmuxOk: false, tmuxV: 'tmux 3.6b' })

  // preset 说 tmux ok、直连失败 → 必须按 preset 判 hasTmux=true、看门狗照常
  const envPresetOk = await detectEnv({ ...directFail, tmux: { ok: true, version: 'tmux 3.6b' } })
  const planPresetOk = planFor(envPresetOk)
  check(envPresetOk.hasTmux === true && envPresetOk.tmuxVer?.[0] === 3,
    `preset ok + 直连失败 → hasTmux=${envPresetOk.hasTmux} ver=${JSON.stringify(envPresetOk.tmuxVer)}（修复前会是 false）`)
  check(planPresetOk.watchdog === 'lease-node' && planPresetOk.extendedKeys === true,
    `preset ok + 直连失败 → 看门狗照常：${planPresetOk.watchdog} / extendedKeys=${planPresetOk.extendedKeys}`)

  // 反方向：直连 ok、preset 说没有 → preset 仍优先（能力保守）
  const envPresetNo = await detectEnv({ ...mkIO({ tmuxOk: true }), tmux: { ok: false, version: null } })
  const planPresetNo = planFor(envPresetNo)
  check(envPresetNo.hasTmux === false, `preset no + 直连 ok → hasTmux=${envPresetNo.hasTmux}（preset 优先）`)
  check(planPresetNo.watchdog === 'off', `preset no → 看门狗 ${planPresetNo.watchdog}（按 preset 保守关闭）`)
}

/* ── 2. 降级路径真跑主干（driver 拨档后 open→send→capture→close）────────────── */

const tgz = packIntoTemp()
const h = await makeHarness({ tgz, peersDir, socket: process.env.DSH_TEST_SOCKET_ENV ?? 'dsh-kit-env', config: {
  watchdog: false, __consentMode: 'ok',
  // 用户可调参数的真实消费（0.2.2）：会话环境变量 / 启动参数 / 面板轮询档 / 审计加锁提醒开关
  sessionEnv: ['DSH_TEST_ENV=hello42'], shellArgs: ['--norc', '--noprofile'], panelPollMs: 500, auditLockReminder: true,
} })

{
  // 可调参数消费：会话里能看到 sessionEnv；shellArgs 不影响基本使用
  const envShell = await h.run('shell_open', { name: 'env-cfg' }, { agent: { session: { id: 'env-conv' } } })
  const envId = (String(envShell).match(/session (\S+)/) ?? [])[1]
  const envOut = await h.run('shell_run', { session: envId, command: 'echo GOT=$DSH_TEST_ENV' }, { agent: { session: { id: 'env-conv' } } })
  check(String(envOut).includes('GOT=hello42'), `sessionEnv 注入到新会话环境（${String(envOut).split('\n').slice(-2)[0] ?? ''}）`)
  const uiInfo = (await h.call('/list', 'GET')).body.server
  check(uiInfo?.ui?.pollMs === 500, `panelPollMs 经 /list 下发（ui.pollMs=${uiInfo?.ui?.pollMs}）`)
  check(uiInfo?.auditLockReminder === true, 'auditLockReminder 下发到面板（开）')
  await h.run('shell_manage', { action: 'close', session: envId }, { agent: { session: { id: 'env-conv' } } })
}
{
  // 降级档 1：plain-detach（不开 systemd scope）——真实 spawm tmux 普通路径
  h.driver.serverLaunch = 'plain-detach'
  const opened = await h.run('shell_open', { name: 'env-plain' }, { agent: { session: { id: 'env-conv' } } })
  const id = (String(opened).match(/session (\S+)/) ?? [])[1]
  check(id !== undefined && id !== '', `降级档 plain-detach：仍能开 shell（${id}）`)
  const sent = await h.run('shell_send', { session: id, text: 'echo env-plain-ok', keys: ['Enter'] }, { agent: { session: { id: 'env-conv' } } })
  check(String(sent).includes('sent'), '降级档 plain-detach：send 主干可用')
  const read = await h.run('shell_read', { session: id, mode: 'tail', lines: 5 }, { agent: { session: { id: 'env-conv' } } })
  check(String(read).includes('env-plain-ok'), `降级档 plain-detach：capture 读回输出（${String(read).split('\n').slice(-2)[0] ?? ''}）`)
  const closed = await h.run('shell_manage', { action: 'close', session: id }, { agent: { session: { id: 'env-conv' } } })
  check(String(closed).includes('closed'), '降级档 plain-detach：close 主干可用')

  // 降级档 2：raw foreground（不读 /proc）——打开一个 shell，断言前台判定退化为原值
  h.driver.serverLaunch = 'systemd-scope'
  h.driver.foregroundStrategy = 'raw'
  const opened2 = await h.run('shell_open', { name: 'env-raw' }, { agent: { session: { id: 'env-conv' } } })
  const id2 = (String(opened2).match(/session (\S+)/) ?? [])[1]
  const state2 = await h.run('shell_state', { scope: 'mine' }, { agent: { session: { id: 'env-conv' } } })
  check(id2 !== undefined && String(state2).includes(id2), '降级档 raw-foreground：shell_state 主干可用')
  const resolved = await h.driver.resolveForeground('tmux: client', '1')
  check(resolved === 'tmux: client', `raw 档前台判定原值返回（不钻穿）：${resolved}`)
  const drillBack = await h.driver.resolveForeground('bash', '1')
  check(drillBack === 'bash', 'raw 档下已是 shell 时同样原值返回')
  await h.run('shell_manage', { action: 'close', session: id2 }, { agent: { session: { id: 'env-conv' } } })
}

h.cleanup()
process.exit(report('环境矩阵测试'))