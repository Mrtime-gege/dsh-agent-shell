/**
 * 环境能力探测与降级决议（0.2.2 / B 流）。
 *
 * 原则（来自设计公理）：**探测能力，不探测平台**。平台名会骗人（WSL 有无 systemd、Termux 的
 * process.platform 是 'linux' 还是 'android'、macOS 的变体……），而且枚举不完；能力信号
 * （有/无、支持/不支持）是穷的、可以直接查表。所以本文件只回答：tmux 能不能用、systemd 用户
 * 会话在不在、/proc 读不读得到 —— 然后把答案交给 {@link planFor} 决议成一张表。
 *
 * 刻意**不**探测：`setsid`（C 流用 `detached:true` 程序化等价，无需探测）、平台名、包管理器。
 *
 * 全部 IO 都可注入（`io`），因此可离线单测（scripts/test-env.mjs 用 mock 跑四种组合）。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { parseTmuxVersion } from './pure.mjs'

const defaultExec = (cmd, args, timeoutMs = 4000) => new Promise((resolve) => {
  try {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      const code = error === null || error === undefined
        ? 0
        : (typeof error.code === 'number' ? error.code : 1)
      resolve({ code, out: String(stdout ?? ''), err: String(stderr ?? '') })
    })
  } catch (error) {
    resolve({ code: 1, out: '', err: String(error?.message ?? error) })
  }
})

/**
 * 一次真实探测。任何探测失败都向"能力少"保守降级（探测不到 = 当作没有）。
 *
 * @param {object} [io] 可注入的 IO 桩（测试用）：{ env, exists, read, exec, tmp, pid }
 */
export async function detectEnv(io = {}) {
  const env = io.env ?? process.env
  const exists = io.exists ?? existsSync
  const read = io.read ?? ((p) => readFile(p, 'utf8'))
  const exec = io.exec ?? defaultExec
  const tmp = io.tmp ?? tmpdir
  const pid = io.pid ?? String(process.ppid)

  const probe = await exec('tmux', ['-V'])
  const text = `${probe.out}${probe.err}`.trim()
  const okText = probe.code === 0 && /^tmux /i.test(text)
  // 宿主预置结果（io.tmux: { ok, version }）优先 —— 真实运行环境里 driver 的 tmux 探测走
  // subprocess 服务（可靠），本模块直连 execFile 在部分受限 harness 里会失败、误判"没有 tmux"
  // （实测：dsh web 沙箱里 tmux -V 直连失败，而 driver 探测正常）。直连结果只作兜底。
  const preset = io.tmux
  const hasTmux = preset !== undefined && preset !== null
    ? preset.ok === true
    : okText
  const tmuxVer = preset !== undefined && preset !== null
    ? (preset.ok === true ? parseTmuxVersion(preset.version) : null)
    : (okText ? parseTmuxVersion(text) : null)

  const commandExists = async (bin) => {
    const r = await exec('sh', ['-c', `command -v ${bin} >/dev/null 2>&1 && echo yes || echo no`])
    return r.out.trim() === 'yes'
  }

  const hasSystemdUser = (await commandExists('systemd-run')) &&
    exists('/run/systemd/system') &&
    typeof env.XDG_RUNTIME_DIR === 'string' && env.XDG_RUNTIME_DIR !== ''

  let procReadable = false
  try {
    await read(`/proc/${pid}/stat`)
    procReadable = true
  } catch { procReadable = false }

  return {
    hasTmux: okText,
    tmuxVer,                       // [major, minor] | null
    hasSystemdUser,
    procReadable,
    tmpDir: tmp(),
    isTermux: String(env.PREFIX ?? '').includes('com.termux'),
  }
}

/** 能力 → 决议表。每项都是"用哪条路"，不是"什么平台"。 */
export const planFor = (env) => ({
  // 有 systemd 用户会话 → 独立 scope（dsh 干净重启后会话存活）；否则普通 detach
  serverLaunch: env.hasSystemdUser ? 'systemd-scope' : 'plain-detach',
  // 看门狗由租约驱动的独立 Node 进程承担（C 流）；没有 tmux 就没有会话可守
  watchdog: env.hasTmux ? 'lease-node' : 'off',
  // 能读 /proc 就爬进程链找 harness；否则只看自身（C 流里由 lease 兜底）
  harnessPid: env.procReadable ? 'proc-chain' : 'self-only',
  // extended-keys 需要 tmux ≥ 3.2（未知一律压制）
  extendedKeys: env.tmuxVer !== null && (env.tmuxVer[0] > 3 || (env.tmuxVer[0] === 3 && env.tmuxVer[1] >= 2)),
  // 前台判定：能读 /proc 就钻穿包装器；否则原值显示（嵌套 tmux 的忙闲判定退化）
  foreground: env.procReadable ? 'drill' : 'raw',
})

/**
 * 人话列表：每条降级都必须有一句**明确收缩的承诺**（供 /diagnose、面板 ⓘ 显示），
 * 而不是含糊的"可能受限"。
 */
export const describeEnv = (env, plan) => {
  const lines = []
  lines.push(plan.serverLaunch === 'systemd-scope'
    ? '服务器启动：systemd 用户 scope（dsh 干净重启后会话仍存活）'
    : '服务器启动：普通 detach —— 承诺收缩：dsh 干净重启（systemctl restart）后本插件的会话不再存活')
  lines.push(plan.harnessPid === 'proc-chain'
    ? 'harness 定位：/proc 进程链'
    : 'harness 定位：self-only（读不到 /proc）—— 看门狗退化为租约单条件判定')
  lines.push(plan.foreground === 'drill'
    ? '前台判定：/proc 钻穿（嵌套 tmux 的忙闲判定准确）'
    : '前台判定：原值显示（读不到 /proc）—— 嵌套 tmux 下忙闲状态可能判不准')
  lines.push(plan.extendedKeys
    ? 'extended-keys：启用（tmux ≥ 3.2）'
    : `extended-keys：压制（tmux ${env.tmuxVer === null ? '版本未知' : env.tmuxVer.join('.')} < 3.2）`)
  lines.push(plan.watchdog === 'off'
    ? '看门狗：关闭（没有 tmux）'
    : '看门狗：租约驱动的独立 Node 进程')
  if (env.isTermux) lines.push('检测到 Termux（$PREFIX 命中）—— 依赖安装走 pkg，不要求 root')
  return lines
}
