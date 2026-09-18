/*
 * test-longrun.mjs —— 长任务 + 5 路并行 + 常见 Linux 工具 + 提权/SSH + oneShot 并发竞态
 * 的可复用固定套件（与 smoke/edge 同族：打包产物 → 独立 socket/审计目录 → 真 tmux）。
 *
 * 用法：
 *   DSH_PEERS_DIR=<peers> node scripts/test-longrun.mjs [peersDir] \
 *     [--vault <path>] [--sudo-key kalipsd] [--ssh-key simplepsd] [--stream 160]
 *
 * --vault：把指定的 vault.json 拷进本套件私有审计目录（0600，跑完连留痕一起删除）。
 *   给了且键为可重复 → 跑**真** sudo/ssh 提权链路（值全程走引用，脚本不读值）；
 *   否则这些阶段自动降级为模拟器或直接 SKIP——CI 上无凭据也能绿。
 * 其余阶段（流式长任务/工具链/交互/并发竞态/审计复验）无需凭据，永远真实执行。
 *
 * 退出码：0=全过（含 SKIP），1=有失败。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHarness, makeChecker, resolvePeers, packIntoTemp } from './lib/kit.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const flag = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const has = (name) => argv.includes('--' + name)
const peersDir = resolvePeers(undefined)
const vaultSource = flag('vault')
const sudoKey = flag('sudo-key') ?? 'kalipsd'
const sshKey = flag('ssh-key') ?? 'simplepsd'
const streamSteps = Number(flag('stream') ?? 160)

const { check, report } = makeChecker()
const skip = (label, why) => console.log(`– SKIP ${label}（${why}）`)
const EXEC = { agent: { session: { id: 'longrun-session' } } }
const tgz = packIntoTemp()
const auditDir = mkdtempSync(join(tmpdir(), 'dsh-longrun-'))
const SOCKET = `dsh-lr-${process.pid % 9999}`

const h = await makeHarness({
  tgz, peersDir, socket: SOCKET,
  config: { watchdog: false, maxSessions: 12, auditDir, __actor: 'longrun-session' },
})
const run = (tool, args) => h.run(tool, args, EXEC)
const idOf = (text) => String(text).match(/session (\S+)/)[1]
const ts = Date.now()
let vaultKeys = {}
try { vaultKeys = JSON.parse(readFileSync(join(auditDir, 'vault.json'), 'utf8')) } catch { /* 无 */ }

/* ── P0 预备：私有 vault 副本（真密钥只在临时目录里活着，跑完即焚） ─────────── */
let realSudoOk = false; let realSshOk = false
const sudoProbe = spawnSync('bash', ['-c', 'command -v sudo'], { encoding: 'utf8' })
if (typeof vaultSource === 'string' && existsSync(vaultSource)) {
  try { copyFileSync(vaultSource, join(auditDir, 'vault.json')) } catch (error) {
    console.log('  （--vault 复制失败，按无凭据降级：' + String(error?.message ?? error) + '）')
  }
  try { vaultKeys = JSON.parse(readFileSync(join(auditDir, 'vault.json'), 'utf8')) } catch { /* 下面判损坏 */ }
  const usable = (k) => vaultKeys[k] !== undefined && vaultKeys[k].oneShot !== true && String(vaultKeys[k].value ?? '').length > 0
  realSudoOk = sudoProbe.status === 0 && usable(sudoKey)
  realSshOk = usable(sshKey) && spawnSync('bash', ['-c', 'timeout 2 bash -c "</dev/tcp/127.0.0.1/22"'], { encoding: 'utf8' }).status === 0
} else {
  // 无 --vault：造模拟器一次性键供 oneShot/竞态阶段使用（不碰任何真凭据）
  vaultKeys['lr-oneshot'] = { value: 'Race-Longrun-032', oneShot: true }
}
// 竞态阶段总要用一个一次性键：直接写进临时库（不依赖真库）
vaultKeys['lr-oneshot'] = { value: 'Race-Longrun-032', oneShot: true }
writeFileSync(join(auditDir, 'vault.json'), JSON.stringify(vaultKeys, null, 2) + '\n', { mode: 0o600 })
check(true, `P0 预备完成（真sudo=${realSudoOk ? '可用' : '模拟/SKIP'}·真ssh=${realSshOk ? '可用' : 'SKIP'}）`)

/* ── P1 五路并行开会话 ────────────────────────────────────────────────────── */
const opens = await Promise.all([
  run('shell_open', { name: 'lr-endurance', cwd: '/tmp' }),
  run('shell_open', { name: 'lr-tools', cwd: '/tmp' }),
  run('shell_open', { name: 'lr-interactive', cwd: '/tmp' }),
  run('shell_open', { name: 'lr-sudo', cwd: '/tmp' }),
  run('shell_open', { name: 'lr-ssh', cwd: '/tmp' }),
])
const [sEnd, sTools, sTty, sSudo, sSsh] = opens.map(idOf)
check(opens.every((o, i) => String(o).includes('lr-')), 'P1 五个会话并行开启成功')

/* 会话①：流式长任务（后台跑着，后续阶段与它并发） */
const doneFile = `/tmp/lr-done-${ts}`
const streamCmd = `for i in $(seq 1 ${streamSteps}); do echo "[LR] step $i/$((${streamSteps})) $(date +%T)"; sleep 0.5; done; echo "[LR] ALL-DONE"; touch ${doneFile}`
void run('shell_run', { session: sEnd, command: streamCmd, timeout: 1500, lines: 1 })

const W = `/tmp/lr-w-${ts}`
let markN = 0
// wrap:true（默认）= 命令被取码包装，必须 ✅ exit 0 且输出含期望串；
// wrap:false = 首命令在交互白名单（python3/top/http.server…）不包装——用尾部哨兵 echo 证明跑完。
const tool = async (cmd, mustIn, label, wrap = true) => {
  const mark = `LRP${++markN}`
  const command = wrap ? cmd : `${cmd}; echo ${mark}-END`
  const r = String(await run('shell_run', { session: sTools, command, lines: 8 }))
  const okExit = wrap ? r.includes('✅ exit 0') : r.includes(`${mark}-END`)
  const okOut = mustIn === null || r.includes(mustIn)
  check(okExit && okOut, `P2 ${label}${okExit && okOut ? '' : ` —— ${r.slice(0, 140)}`}`)
}
await tool(`mkdir -p ${W}/pkg && echo hello-lr > ${W}/pkg/a.txt && echo junk > ${W}/pkg/b.md && tar -C ${W} -czf ${W}/p.tgz pkg && tar -tzf ${W}/p.tgz | sort | tr '\n' ' '`, 'pkg/a.txt', 'tar 打包/清单')
await tool(`gzip -kf ${W}/pkg/a.txt && gunzip -f ${W}/pkg/a.txt.gz && cat ${W}/pkg/a.txt`, 'hello-lr', 'gzip 往返')
await tool(`seq 1 10 | awk '{s+=$1} END {print s}'`, '55', 'awk 求和')
await tool(`sed 's/$/!/' ${W}/pkg/b.md`, 'junk!', 'sed 就地变换')
await tool(`printf 'foo bar\nbaz\n' | sed 's/o/0/g' | tr 'a-z' 'A-Z' | sort | uniq | paste -sd, -`, 'F00 BAR,BAZ', 'sed/tr/sort/uniq/paste 管线')
await tool(`find ${W}/pkg -name '*.txt' | xargs grep -l hello-lr`, 'a.txt', 'find|xargs grep')
await tool(`printf 'abc123' | base64 -w0 | base64 -d`, 'abc123', 'base64 往返')
await tool(`printf 'x' | sha256sum | grep -cE '^[0-9a-f]{64}'`, '1', 'sha256sum 形状')
await tool(`bash -c "python3 -c 'import json; print(json.dumps({\'ok\':True}))'"`, '"ok": true', 'python3 单行')
await tool(`git init -q ${W}/repo && cd ${W}/repo && git -c user.email=l@r -c user.name=lr commit -q --allow-empty -m lr-032 && git log --oneline | grep -c lr-032`, '1', 'git init/commit/log')
await tool(`ss -ltn | head -3 | wc -l | tr -d ' '`, null, 'ss 列表')
await tool(`df -hT / | tail -1 | grep -cE 'ext4|xfs|btrfs|overlay'`, '1', 'df 文件系统')
await tool(`bash -c "top -bn1 | head -5 | grep -c '%Cpu'"`, '1', 'top 批量模式')
await tool(`dd if=/dev/zero of=${W}/1k bs=1024 count=1 2>/dev/null && wc -c < ${W}/1k | tr -d ' '`, '1024', 'dd 1KB')
await tool(`(python3 -m http.server 8631 >/dev/null 2>&1 & SRV=$!; sleep 0.8; curl -sS -m 4 -o /dev/null -w 'HTTP:%{http_code}\n' http://127.0.0.1:8631/; kill $SRV 2>/dev/null) 2>/dev/null`, 'HTTP:200', 'http.server+curl 环回', false)
await tool(`seq 1 300 | awk '$1%7==0' | head -4 | tr '\n' ' '`, '7 14 21 28', '管道组合')
await tool(`bash -c "echo outer | tee ${W}/tee.txt >/dev/null && grep -c outer ${W}/tee.txt"`, '1', 'tee/管道')

/* ── P3 交互式（vim 全周期 + python REPL steps） ─────────────────────────── */
await run('shell_send', { session: sTty, text: `vim ${W}/v.txt`, keys: ['Enter'], lines: 0 })
const vimUp = await run('shell_read', { session: sTty, until: 'fg:vim', timeout: 8000, lines: 1 })
check(String(vimUp).includes('reached'), `P3 vim 前台识别（${String(vimUp).split('\n')[0]}）`)
await run('shell_send', { session: sTty, text: 'lr-inserted-line', keys: ['Escape'], preKeys: ['i'], lines: 0 })
await run('shell_send', { session: sTty, text: ':wq', keys: ['Enter'], lines: 0 })
const vimOut = await run('shell_run', { session: sTty, command: `cat ${W}/v.txt`, lines: 3 })
check(String(vimOut).includes('lr-inserted-line'), 'P3 vim 写入→退出→读回全周期')
const repl = await run('shell_run', { session: sTty, steps: [
  { send: 'python3 -i -q', expect: 'match:>>>', timeout: 8000 },
  { send: 'print(6*7)', expect: 'match:42', timeout: 8000 },
  { send: 'exit()', expect: 'idle', timeout: 8000 },
] })
check(String(repl).includes('全部 3 步通过'), 'P3 python REPL steps 交互全过')

/* ── P4 sudo 提权：真键（--vault）或 SKIP ────────────────────────────────── */
if (realSudoOk) {
  const su = await run('shell_run', { session: sSudo, steps: [
    { send: 'sudo -S -k -p "[lr-sudo] password: " id -u', expect: 'match:[Pp]assword', timeout: 8000 },
    { send: `{{v:${sudoKey}}}`, expect: 'idle', timeout: 12000 },
    { send: `sudo -S -k -p "[lr-elev] password: " sh -c 'id -u > ${W}/elev'`, expect: 'match:password', timeout: 8000 },
    { send: `{{v:${sudoKey}}}`, expect: 'idle', timeout: 12000 },
  ] })
  check(String(su).includes('全部 4 步通过'), 'P4 sudo -S steps 四步过（提权两次，凭证不缓存也过）')
  const tail = await run('shell_read', { session: sSudo, search: 'lr-sudo', lines: 2 })
  check(String(tail).includes('lr-sudo'), `P4 sudo 提示行在屏可定位（${String(tail).split('\n')[0]}）`)
  const elev = await run('shell_run', { session: sSudo, command: `cat ${W}/elev`, lines: 3 })
  check(String(elev).includes('0'), 'P4 root 写的 elev 文件内容 uid=0（真提权产物）')
} else {
  skip('P4 真 sudo 提权', realSudoOk ? '' : (!vaultSource ? '未给 --vault' : sudoProbe.status !== 0 ? '无 sudo' : `库里没有可重复键 ${sudoKey}`))
}

/* ── P5 ssh 口令登录：真键或 SKIP ─────────────────────────────────────────── */
if (realSshOk) {
  const sh = await run('shell_run', { session: sSsh, steps: [
    // pane 环境（systemd scope 拉起链）可能没有 USER/LOGNAME——手工全量复跑踩实，必须 $(id -un)
    { send: `ssh -o StrictHostKeyChecking=accept-new -o PubkeyAuthentication=no -o PreferredAuthentications=password $(id -un)@127.0.0.1 'echo SSH-LR-OK; id -un' 2>/dev/null`, expect: 'match:[Pp]assword', timeout: 15000 },
    { send: `{{v:${sshKey}}}`, expect: 'match:SSH-LR-OK|denied|password', timeout: 15000 },
  ] })
  const sshTail = String(await run('shell_read', { session: sSsh, lines: 14 }))
  const sshIn = sshTail.includes('SSH-LR-OK')
  const sshDenied = /Permission denied/i.test(sshTail)
  check(sshIn || sshDenied, `P5 ssh 口令通道走通（远端回传=${sshIn ? 'SSH-LR-OK' : 'Permission denied——机制OK，口令与本机不匹配'}）`)
  if (!sshIn) skip('P5 ssh 远端命令成功', '口令与本机 sshd 不匹配（不重试防 faillock 锁户）')
} else {
  skip('P5 真 ssh 口令登录', !vaultSource ? '未给 --vault' : '22 端口不可达或键不可用')
}

/* ── P6 oneShot 并发竞态：两路同时引用同一一次性键 → 恰好一个进管道 ───────── */
const raced = await Promise.all([
  run('shell_run', { session: sSudo, command: '{{v:lr-oneshot}}', lines: 1 }),
  run('shell_run', { session: sSsh, command: '{{v:lr-oneshot}}', lines: 1 }),
])
const refused = raced.filter((r) => String(r).includes('REFUSED'))
const sent = raced.filter((r) => !String(r).includes('REFUSED'))
// 恰好一个进管道；另一个被拒（竞态闸"已被并发发送消耗"或紧随其后的"没有键"，都算拦下）
check(refused.length === 1 && sent.length === 1, `P6 并发双发同一 oneShot：恰好一拒一发（拒=${refused.length} 发=${sent.length}）`)
const raceList = await run('shell_manage', { action: 'vault-list' })
check(!String(raceList).includes('lr-oneshot'), 'P6 竞态后一次性键已焚（库里消失）')

/* ── P7 长任务收尾与交叉观察（此刻 P2-P6 与流式任务全程并发） ──────────────── */
const wf = await run('shell_run', { session: sTools, command: 'echo probe-during-stream', waitFor: `file:${doneFile}`, waitTimeout: (streamSteps / 2 + 60) * 1000, lines: 1 })
check(String(wf).includes('条件达成'), 'P7 file: 等待命中流式任务的完成标志')
const endRead = await run('shell_read', { session: sEnd, search: 'ALL-DONE', context: 1, lines: 2 })
check(String(endRead).includes('>L') && String(endRead).includes('ALL-DONE'), 'P7 完成标记在滚动历史可定位（search+context）')
const state = await run('shell_state', { scope: 'mine' })
check((String(state).match(/id=dsh-/g) ?? []).length === 5, 'P7 state 五会话并行在册')

/* ── P8 收口：关闭（留痕见证）→ 链完整性 → 临时目录（含密钥副本）销毁 ────── */
for (const id of [sEnd, sTools, sTty, sSudo, sSsh]) await run('shell_manage', { action: 'close', session: id })
const dayF = join(auditDir, `audit-${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}.jsonl`)
const lines = existsSync(dayF) ? readFileSync(dayF, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []
const closedWithWitness = lines.filter((r) => r.event === 'close' && typeof r.transcriptSha256 === 'string')
check(closedWithWitness.length >= 5, `P8 五会话 close 记录都带留痕 sha256 见证（${closedWithWitness.length}）`)
check(lines.some((r) => r.event === 'vault' && r.decision === 'spend-race'), 'P8 竞态拒发已入账（spend-race 事件）')
const verify = spawnSync(process.execPath, [join(repoRoot, 'bin', 'dsh-agent-shell.mjs'), 'verify-audit', auditDir], { encoding: 'utf8' })
check(verify.status === 0 && String(verify.stdout).includes('链完整'), `P8 审计链离线复验：${String(verify.stdout).split('\n').find((l) => l.includes('链'))?.trim() ?? verify.status}`)
rmSync(auditDir, { recursive: true, force: true })
check(!existsSync(auditDir), 'P8 私有审计目录（含密钥副本与留痕）已整体销毁')

h.cleanup()   // 关套件 tmux 服务端与临时 harness 目录（不留孤儿 socket/server）
process.exit(report('长任务套件'))
