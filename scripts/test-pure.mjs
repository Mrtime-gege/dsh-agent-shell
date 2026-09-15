/** test-pure.mjs —— lib/pure.mjs 纯函数离线穷举（无宿主，秒级）。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NAME_PREFIX, DANGEROUS, scanDanger, sanitizeName, clamp, parseTmuxVersion,
} from '../lib/pure.mjs'
// tmux.js 零 DSH 依赖（只引 node:fs/promises 与 node:child_process）—— 纯逻辑可离线测
import { drillForeground, normalizeReply, readDescendantProcs } from '../lib/tmux.js'

let failed = 0
const pass = (ok, label) => {
  if (!ok) { failed += 1; console.log('✗', label) }
}

/* ── sanitizeName ─────────────────────────────────────────────────────────── */
pass(sanitizeName('测试') === 'dsh-测试', '纯中文 label 原样保留并带前缀')
pass(sanitizeName('测试abc') === 'dsh-测试abc', '中英混合保留中文（不再静默清掉）')
pass(sanitizeName('a b/c') === 'dsh-a-b-c', '空格/斜杠折成连字符')
pass(sanitizeName('x.y:z') === 'dsh-x-y-z', '点与冒号显式折掉（tmux 目标语法分隔符）')
pass(sanitizeName('!!!') === '', '全是非法字符 → 空串（上层据此报"名字至少一个字母"）')
pass(sanitizeName('dsh-build-a') === 'dsh-build-a', '已有前缀不重复加')
pass(sanitizeName('    ') === '', '空白串 → 空串')
pass(NAME_PREFIX === 'dsh-', 'NAME_PREFIX 常量正确')

/* ── clamp ────────────────────────────────────────────────────────────────── */
pass(clamp(100000, 80, 20, 1000) === 1000, '超大值夹到上限')
pass(clamp(-5, 24, 20, 1000) === 20, '负值夹到下限')
pass(clamp(50, 24, 20, 1000) === 50, '合法值原样（取整）')
pass(clamp(Number.NaN, 24, 20, 1000) === 24, '非有限值回退 fallback')
pass(clamp('80', 24, 20, 1000) === 24, '数字字符串按非有限值回退（正确的语义）')

/* ── scanDanger ──────────────────────────────────────────────────────────── */
pass(scanDanger('rm -rf /') !== null, 'rm -rf / 命中')
pass(scanDanger('echo hello') === null, '普通命令放行')
pass(scanDanger('sudo apt install tmux') === null, 'sudo 不再命中（0.2.2 起提权是主场景，规则已删）')
pass(scanDanger('echo hello > ~/.dsh/agent-shell/audit-2026-01-01.jsonl') === null, '写状态目录不再被拦（误伤；留痕完整性由哈希链承担）')
pass(scanDanger('rm -rf ~/.dsh/agent-shell') === null, '删状态目录不再被拦（原生 bash 旁路存在，不做假边界；哈希链负责可检测）')
pass(scanDanger('tmux kill-server') !== null, '杀私有服务端命中（插件命门）')
pass(scanDanger('tmux kill-session -t nest') !== null, 'kill-session 命中')
pass(scanDanger('unset TMUX; tmux attach -t nest') === null, '嵌套 tmux 的正常操作放行')
pass(scanDanger('echo hello', []) === null, '空规则表 → 放行')
pass(scanDanger('x', [{ pattern: /x/, reason: 'r' }]) === 'r', '自定义规则生效')
pass(scanDanger('', ) === null, '空文本放行')

/* ── DANGEROUS 数量锚定（加规则必须显式更新这里，防静默增删）────────────── */
pass(DANGEROUS.length === 15, `危险规则数稳定（${DANGEROUS.length}）—— 增删需同步 SECURITY.md 与测试`)

/* ── 前台钻穿（drillForeground：sudo/su 包装器，纯进程表穷举）────────────────── */
const tree = (spec) => {
  const m = new Map()
  for (const [pid, [comm, ...children]] of Object.entries(spec)) m.set(pid, { comm, children })
  return m
}
pass(drillForeground('sudo', '1', tree({ 1: ['bash', '2'], 2: ['sudo', '3'], 3: ['bash', []] })) === 'bash', 'sudo -i → 钻穿出 root shell')
pass(drillForeground('sudo', '1', tree({ 1: ['bash', '2'], 2: ['sudo', '3'], 3: ['-bash', []] })) === '-bash', '登录 shell -bash 原样返回')
pass(drillForeground('sudo', '1', tree({ 1: ['bash', '2'], 2: ['sudo', '3'], 3: ['vim', []] })) === 'vim', 'sudo vim → vim')
pass(drillForeground('su', '1', tree({ 1: ['zsh', '2'], 2: ['su', '3'], 3: ['sh', []] })) === 'sh', 'su 同样钻穿')
pass(drillForeground('pkexec', '1', tree({ 1: ['bash', '2'], 2: ['pkexec', '3'], 3: ['bash', []] })) === 'bash', 'pkexec 钻穿')
pass(drillForeground('ssh', '1', tree({ 1: ['bash', '2'], 2: ['ssh', '3'], 3: ['bash', []] })) === 'ssh', 'ssh 不钻（远端无法判定）')
pass(drillForeground('wsl', '1', tree({ 1: ['bash', '2'], 2: ['wsl', '3'], 3: ['bash', []] })) === 'wsl', 'wsl 不钻（进了另一个系统）')
pass(drillForeground('sudo', '1', tree({ 1: ['bash', '2'], 2: ['sudo', '3', '4'], 3: ['bash', []], 4: ['cat', []] })) === 'sudo', '多子进程不猜，退回原值')
pass(drillForeground('sudo', '1', tree({ 1: ['bash', '2'], 2: ['sudo', []] })) === 'sudo', '无子进程退回原值')
pass(drillForeground('bash', '1', tree({ 1: ['bash', []] })) === 'bash', '空闲 shell 原样')
pass(drillForeground('bash', '1', tree({ 1: ['bash', '2'], 2: ['sudo', '3'], 3: ['bash', []] })) === 'bash', '同名后代取最深')
pass(drillForeground('sudo', '1', null) === 'sudo' && drillForeground('sudo', '1', new Map()) === 'sudo', '读不到进程表退回原值')
pass(drillForeground('sudo', '999', tree({ 1: ['bash', '2'], 2: ['sudo', []] })) === 'sudo', 'pid 不在表里退回原值')
pass(drillForeground('sudo', '1', tree({ 1: ['sudo', '2'], 2: ['sudo', '1'] })) === 'sudo', '进程表有环终止')
pass(drillForeground('', '1', tree({ 1: ['bash', []] })) === '', '空命令名 → 空串')

/* ── 控制回复归一化 ─────────────────────────────────────────────────────────── */
pass(normalizeReply('"a\\tb\\tc"') === 'a\tb\tc', '引号+\\t 转义还原为真实 tab')
pass(normalizeReply('a\tb') === 'a\tb', '真实 tab 原样不误改')
pass(normalizeReply('   ') === '   ', '空白原样（trim 只用于判引号）')

/* ── /proc 进程树读取（本机真实路径）────────────────────────────────────────── */
const selfProcs = await readDescendantProcs(String(process.pid))
pass(selfProcs.has(String(process.pid)), 'readDescendantProcs 读到自己的进程树')
pass((selfProcs.get(String(process.pid))?.comm ?? '') !== '', 'comm 读出来了')
const badProcs = await readDescendantProcs('not-a-pid')
pass(badProcs instanceof Map && badProcs.size === 0, '非法 pid → 空表（不抛错）')


/* ── 审计哈希链 ────────────────────────────────────────────────────────────── */
import { GENESIS, canonicalize, hashRecord, sealRecord, verifyChain, chainHeadOf, HASH_ALGO } from '../lib/audit.js'
pass(GENESIS === 'genesis' && HASH_ALGO === 'sha256', '创世常量与算法固定（跨平台一致）')
const r1 = { ts: 1, event: 'open', shell: 'dsh-a' }
const s1 = sealRecord(GENESIS, r1)
pass(typeof s1.hash === 'string' && s1.hash.length === 64, '封链补上 64 位 hex 摘要')
pass(s1.prevHash === GENESIS, '首条记录 prevHash = 创世')
pass(hashRecord(s1.prevHash, s1) === s1.hash, '摘要可复算（键序无关）')
pass(hashRecord(s1.prevHash, { shell: 'dsh-a', event: 'open', ts: 1 }) === s1.hash, '字段顺序变化不影响摘要')
const s2 = sealRecord(s1.hash, { ts: 2, event: 'input', shell: 'dsh-a', text: 'x' })
const tampered = { ...s2, text: 'y' }
pass(hashRecord(s2.prevHash, tampered) !== s2.hash, '改一个字节 → 摘要失配（篡改可检测）')
pass(verifyChain([s1, s2]).ok === true, '完整链校验通过')
pass(verifyChain([s1, s2]).sealed === 2, '封链计数正确')
pass(verifyChain([s1, { ...s2, text: 'y' }]).ok === false, '中间篡改 → 断链')
pass(verifyChain([s1, s2]).brokenAt === null, '完整链无断点')
const legacyRec = { ts: 0, event: 'open', shell: 'old' }
// 0.2.2 起不向前兼容：未封链记录直接判断链（unsealed），不再容忍
const strict = verifyChain([legacyRec, s1, s2])
pass(strict.ok === false && strict.brokenAt?.index === 0 && strict.brokenAt?.reason === 'unsealed',
  '未封链（旧格式）记录直接判断链 —— 升级时已清空旧日志，不再向前兼容')
pass(chainHeadOf([legacyRec, s1, s2]) === s2.hash, '链头取最后一条封链摘要')
pass(chainHeadOf([]) === GENESIS, '空链 → 创世')
/* 注入白名单 */
import { isSafeSessionName, isSafeKeyName } from '../lib/pure.mjs'
pass(isSafeSessionName('dsh-ab12cd') === true, '稳定 id 通过白名单')
pass(isSafeSessionName('a;b') === false, '分号被拒（tmux 命令分隔符）')
pass(isSafeSessionName('a\tb') === false, '换行被拒')
pass(isSafeSessionName('a"b') === false, '引号被拒')
pass(isSafeSessionName('a$(id)') === false, '命令替换被拒')
pass(isSafeSessionName('') === false && isSafeSessionName(null) === false, '空/非字符串被拒')
pass(isSafeKeyName('C-c') === true && isSafeKeyName('Enter') === true, '合法键名通过')
pass(isSafeKeyName('C-c; kill-server') === false, '键名注入被拒')

console.log(failed === 0 ? `pure 纯函数：全部通过（${45 + 20} 项断言）` : `pure 纯函数：${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
/* ── parseTmuxVersion（extended-keys ≥3.2 压制的判据）──────────────────────── */
pass(JSON.stringify(parseTmuxVersion('tmux 3.6b')) === '[3,6]', 'tmux 3.6b → [3,6]')
pass(JSON.stringify(parseTmuxVersion('tmux 3.2')) === '[3,2]', 'tmux 3.2 → [3,2]')
pass(JSON.stringify(parseTmuxVersion('tmux 3.1a')) === '[3,1]', 'tmux 3.1a → [3,1]（<3.2 应压制 extended-keys）')
pass(JSON.stringify(parseTmuxVersion('tmux 4.9')) === '[4,9]', '未来大版本照常解析')
pass(parseTmuxVersion('command not found: tmux') === null, '非 tmux 输出 → null（能力未知）')
pass(parseTmuxVersion('') === null, '空输出 → null')
pass(parseTmuxVersion(undefined) === null, 'undefined → null')
