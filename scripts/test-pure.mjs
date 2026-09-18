/** test-pure.mjs —— lib/pure.mjs 纯函数离线穷举（无宿主，秒级）。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  NAME_PREFIX, DANGEROUS, scanDanger, dangerCode, sanitizeName, clamp, parseTmuxVersion, idleClosable,
  shouldWrapExit, wrapExitCommand, parseExitFromTail, diffSince, stripCommandEcho, redactSecrets,
  parseWaitFor, summarizeFailure, doctorAdvice,
  extractRefs, applyRefs, macroVisible, macroSubmitWantsEnter, vaultConsumeNow, maskVaultLine, REF_KEY_RE,
  expandHome, inspectSecretStrength, vaultExpired, parseDomainFile,
} from '../lib/pure.mjs'
// tmux.js 零 DSH 依赖（只引 node:fs/promises 与 node:child_process）—— 纯逻辑可离线测
import { drillForeground, normalizeReply, readDescendantProcs } from '../lib/tmux.js'

let checked = 0
let failed = 0
const pass = (ok, label) => {
  checked += 1
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

/* ── dangerCode：错误码化（0.3.0，调用方按稳定码分支而不是按文案猜） ────────── */
pass(dangerCode('filesystem format') === 'guard:mkfs', 'mkfs 理由 → guard:mkfs 稳定码')
pass(dangerCode(scanDanger('rm -rf /')) === 'guard:rm-root', '从命中结果反查码（rm -rf / → guard:rm-root）')
pass(dangerCode('没这条规则') === 'guard:unknown', '查不到的理由 → guard:unknown（不抛错）')
pass(DANGEROUS.every((r) => typeof r.id === 'string' && r.id.length > 0), '每条规则都有 id（错误码不能漏）')

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
// 0.3.0 回归锁：undefined 字段在**写入方**（记录里带键）与**校验方**（落盘 JSON 丢键后 parse 回来）
// 必须得到同一摘要 —— 否则链从该条起全部失验（实测踩中：open 带 idleMinutes:undefined "断链于第 4 条"）
const sUndef = sealRecord(s1.hash, { ts: 3, event: 'open', shell: 'dsh-u', idleMinutes: undefined })
const roundTripped = JSON.parse(JSON.stringify(sUndef))   // 模拟落盘 → 读回
pass(hashRecord(roundTripped.prevHash, roundTripped) === sUndef.hash,
  '含 undefined 字段的记录：落盘往返后摘要一致（canonicalize 与 JSON.stringify 同口径）')
pass(verifyChain([s1, roundTripped]).ok === true, 'undefined 字段记录落盘读回后链仍完整')
pass(canonicalize({ a: 1, b: undefined }) === '{"a":1}', 'canonicalize 丢弃 undefined 键（不是变 null）')
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


/* ── parseTmuxVersion（extended-keys ≥3.2 压制的判据）──────────────────────── */
pass(JSON.stringify(parseTmuxVersion('tmux 3.6b')) === '[3,6]', 'tmux 3.6b → [3,6]')
pass(JSON.stringify(parseTmuxVersion('tmux 3.2')) === '[3,2]', 'tmux 3.2 → [3,2]')
pass(JSON.stringify(parseTmuxVersion('tmux 3.1a')) === '[3,1]', 'tmux 3.1a → [3,1]（<3.2 应压制 extended-keys）')
pass(JSON.stringify(parseTmuxVersion('tmux 4.9')) === '[4,9]', '未来大版本照常解析')
pass(parseTmuxVersion('command not found: tmux') === null, '非 tmux 输出 → null（能力未知）')
pass(parseTmuxVersion('') === null, '空输出 → null')
pass(parseTmuxVersion(undefined) === null, 'undefined → null')

/* ── 并发封链不得断链（0.2.2 真机抓到：capture 与 open 并发都读旧 head → 双写 genesis → prev-mismatch）── */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { appendAudit, readAudit, summarizeRecord, GENESIS as AUDIT_GENESIS } from '../lib/audit.js'   // verifyChain 已在头部导入
{
  const dir = mkdtempSync(join(tmpdir(), 'audit-race-'))
  const paths = { dir, input: (d) => join(dir, `audit-${d}.jsonl`) }
  const chain = { head: AUDIT_GENESIS, seq: 0 }
  // Promise.all 并发 5 条：修复前两条会都写 prevHash=genesis → 断链；串行化后必须完整
  await Promise.all([1, 2, 3, 4, 5].map((i) => appendAudit(paths, '2026-01-01', { event: 'race-' + i, ts: i }, chain)))
  const recs = await readAudit(paths, '2026-01-01')
  const verdict = verifyChain(recs)
  pass(recs.length === 5 && verdict.ok === true,
    `并发 5 条封链不断链（${recs.length} 条，${verdict.ok ? '链完整' : JSON.stringify(verdict.brokenAt)}）`)
  const chainTail = chain.head
  pass(chainTail === recs[recs.length - 1].hash, '链头推进到最后一条的 hash')
  // 展示层：tool-call 必须打出工具名（"AI 调过哪些工具"全靠这个字段）
  pass(summarizeRecord({ ts: 0, event: 'tool-call', tool: 'shell_state', session: 'mine' }).includes('shell_state'),
    'tool-call 摘要带工具名与 session')
  pass(summarizeRecord({ ts: 0, event: 'env-degraded', capability: 'systemd-user', fallback: 'plain-detach' }).includes('plain-detach'),
    'env-degraded 摘要带降级去向')
}


/* ── idleClosable：闲置自动关闭的纯决策 ───────────────────────────────────── */

{
  const T0 = 1_000_000
  const mkSession = (name) => ({ name })
  const owners = (over = {}) => ({ a: { lastUsedAt: T0, idleMinutes: 60 }, ...over })
  // 已到期：lastUsedAt 距今 ≥ 时长
  pass(idleClosable([mkSession('a')], owners(), { now: T0 + 3600_000 }).join(',') === 'a',
    '闲置超过时长 → 到期候选')
  // 未到期：还差一点
  pass(idleClosable([mkSession('a')], owners(), { now: T0 + 3599_000 }).length === 0,
    '未到时长 → 不闭（差 1 秒也不行）')
  // 恰好等于时长 → 到期（>= 语义）
  pass(idleClosable([mkSession('a')], owners(), { now: T0 + 3600_000 }).length === 1,
    '恰好等于时长 → 到期')
  // 每会话覆盖：idleMinutes=0 永不关（即便很久没动）
  pass(idleClosable([mkSession('a')], owners({ a: { lastUsedAt: T0, idleMinutes: 0 } }), { now: T0 + 86400_000 }).length === 0,
    '会话级 idleMinutes=0 → 永不自动关闭')
  // 每会话覆盖：小的覆盖默认值
  pass(idleClosable([mkSession('a')], owners({ a: { lastUsedAt: T0, idleMinutes: 5 } }), { now: T0 + 6 * 60000 }).length === 1,
    '会话级短的时长覆盖默认（5 分钟 → 6 分钟已到期）')
  pass(idleClosable([mkSession('a')], owners({ a: { lastUsedAt: T0, idleMinutes: 5 } }), { now: T0 + 4 * 60000 }).length === 0,
    '会话级短的时长未到期不闭')
  // 默认值兜底（0.3.0 语义翻转：总开关默认关，兜底必须显式开）
  pass(idleClosable([mkSession('a')], owners({ a: { lastUsedAt: T0 } }), { now: T0 + 65 * 60000, defaultMinutes: 60, globalEnabled: true }).length === 1,
    '总开关开 + 无会话级时长 → 吃默认 60 分钟兜底')
  pass(idleClosable([mkSession('a')], owners({ a: { lastUsedAt: T0 } }), { now: T0 + 86400_000, globalEnabled: false }).length === 0,
    '0.3.0 默认：未指定时长 + 总开关关 → 永久保留（不扫）')
  pass(idleClosable([mkSession('a')], owners({ a: { lastUsedAt: T0, idleMinutes: -1 } }), { now: T0 + 86400_000, globalEnabled: true }).length === 0,
    '0.3.0：-1（及任何负数）= 本会话显式豁免，总开关开着也永不')
  pass(idleClosable([mkSession('a')], owners({ a: { lastUsedAt: T0, idleMinutes: 10 } }), { now: T0 + 11 * 60000, globalEnabled: false }).length === 1,
    '0.3.0：全局关着，显式正值的会话照样按自己的时长到期')
  pass(idleClosable([mkSession('a')], owners({ a: { lastUsedAt: T0, idleMinutes: 30 } }), { now: T0 + 6 * 60000, globalEnabled: true, defaultMinutes: 5 }).length === 0,
    '显式会话级时长优先于全局兜底（30m 会话不因 5m 兜底在 6 分钟被误关）')
  pass(idleClosable([mkSession('a')], owners({ a: { lastUsedAt: T0, idleMinutes: 30 } }), { now: T0 + 31 * 60000, globalEnabled: true, defaultMinutes: 5 }).length === 1,
    '同一会话按**自己的** 30 分钟到期（优先级的正面一半）')
  // skip：人在操作的会话不扫
  pass(idleClosable([mkSession('a')], owners(), { now: T0 + 3600_000, skip: new Set(['a']) }).length === 0,
    'skip 集合里的会话不扫（面板解锁/手动豁免）')
  // 防御：缺失归属 / 缺失 lastUsedAt 一律不闭
  pass(idleClosable([mkSession('ghost')], owners(), { now: T0 + 86400_000 }).length === 0,
    '无归属条目 → 不闭（宁可少关）')
  pass(idleClosable([mkSession('a')], owners({ a: { idleMinutes: 60 } }), { now: T0 + 86400_000 }).length === 0,
    'lastUsedAt 缺失 → 不闭（没有活动记录不敢收）')
  // 多会话混合：只关到期的
  const mix = idleClosable([mkSession('old'), mkSession('new'), mkSession('never')], owners({
    old: { lastUsedAt: T0, idleMinutes: 60 },
    new: { lastUsedAt: Date.now(), idleMinutes: 60 },
    never: { lastUsedAt: T0, idleMinutes: 0 },
  }), { now: T0 + 3600_000 })
  pass(mix.join(',') === 'old', `多会话只关到期的（${mix.join(',') || '(空)'}）`)
}


/* ── 审计封链的冷启动闸门（0.2.3 修复：热重载/重启窗口期别封在 genesis 上） ─────── */

{
  const dir2 = mkdtempSync(join(tmpdir(), 'audit-race-'))
  const paths2 = { dir: dir2, input: (d) => join(dir2, `audit-${d}.jsonl`) }
  // 磁盘上已有一条正常封链的记录
  const chain0 = { head: AUDIT_GENESIS, seq: 0, verify: null }
  await appendAudit(paths2, '2026-01-01', { event: 'first', ts: 1 }, chain0)
  // 模拟"新实例启动、链头还没读回"：chain.head 仍是创世，但给了 ready 闸门（稍后才 resolve）。
  // 与生产一致：启动流程**先**把链头读到 chain.head，**再**放行闸门 —— 队列里的早到写入
  // 等到那一刻才封链，于是接在磁盘链头之后而不是创世。
  let boot
  const chainBoot = { head: AUDIT_GENESIS, seq: 0, ready: new Promise((resolve) => { boot = resolve }) }
  const appending = appendAudit(paths2, '2026-01-01', { event: 'early-arrival', ts: 2 }, chainBoot)
  // 闸门未放行时，"早到"的记录不应落盘（排队中）
  await new Promise((r) => setTimeout(r, 60))
  const linesBeforeRelease = (await import('node:fs')).readFileSync(paths2.input('2026-01-01'), 'utf8').trim().split('\n').length
  pass(linesBeforeRelease === 1, `闸门未放行时早到记录排队不落盘（${linesBeforeRelease} 行）`)
  // 链头读回完成：先赋值、再放行
  chainBoot.head = chain0.head
  boot()
  await appending
  const recs = await readAudit(paths2, '2026-01-01')
  pass(recs[1].prevHash === chain0.head,
    `冷启动闸门：早到记录接在磁盘链头之后（prev=${recs[1].prevHash.slice(0, 12)}，非 genesis）—— 修复前会封在创世上断链`)
  pass(verifyChain(recs).ok === true, '闸门后整链校验通过')
}

/* ── 断链诊断提示：prevHash=genesis 且前一条存在 → cold-start-genesis ────────── */

{
  const R1a = sealRecord(AUDIT_GENESIS, { event: 'a', ts: 1 })
  const R2a = sealRecord(AUDIT_GENESIS, { event: 'b', ts: 2 })   // 模拟冷启动窗口的坏封链
  const verdict = verifyChain([R1a, R2a])
  pass(verdict.ok === false && verdict.brokenAt?.reason === 'prev-mismatch' &&
    verdict.brokenAt?.hint === 'cold-start-genesis',
    'prev-mismatch 且 prevHash=genesis → 诊断提示 cold-start-genesis（而不是笼统的"被篡改"）')
  pass(verifyChain([R1a]).ok === true, '单条正常链仍通过')
}


/* ── 结构化命令结果（A）：包装决策 / 退出码解析 ───────────────────────────── */

{
  pass(shouldWrapExit('ls -la').wrap === true, '普通命令可包装取退出码')
  pass(shouldWrapExit('cd /tmp && pwd').wrap === true, '含 && 的命令可包装')
  pass(shouldWrapExit('vim file.txt').wrap === false && shouldWrapExit('vim file.txt').reason.startsWith('interactive'),
    '交互式程序（vim）不包装')
  pass(shouldWrapExit('ssh host').wrap === false, 'ssh 不包装（要交互）')
  pass(shouldWrapExit('sudo apt update').wrap === false, 'sudo 不包装（可能要密码）')
  pass(shouldWrapExit('exit 3').wrap === false, 'exit 不包装（包装会让 shell 先退出、取不到码）')
  pass(shouldWrapExit('echo a\necho b').reason === 'multiline', '多行命令不包装')
  pass(shouldWrapExit('cat <<EOF').reason === 'heredoc', 'heredoc 不包装')
  pass(shouldWrapExit('sleep 100 &').reason === 'background', '后台化（& 结尾）不包装')
  pass(shouldWrapExit('   ').wrap === false, '空命令不包装')
  const wrapped = wrapExitCommand('false')
  pass(wrapped.startsWith('false ;') && wrapped.includes('__DSH_EXIT__'), `包装串形状正确：${wrapped.slice(0, 40)}…`)
  pass(parseExitFromTail('out\n__DSH_EXIT__=1\n').exit === 1, '从尾部解析退出码 1')
  pass(parseExitFromTail('out\n__DSH_EXIT__=0\n__DSH_EXIT__=1\n').exit === 1,
    '滚动缓冲残留旧标记时取**最后**一条（0.2.3 修复：非全局 exec 会拿到旧标记）')
  pass(parseExitFromTail('out\n__DSH_EXIT__=0\n').found === true, '解析到 0 也算 found（不能当假值丢掉）')
  pass(parseExitFromTail('no marker').found === false, '没有标记 → found=false')
}

/* ── 敏感信息脱敏（G） ───────────────────────────────────────────────────── */

{
  pass(!redactSecrets('API_KEY=abcd1234efgh').includes('abcd1234efgh'), 'API_KEY=… 被脱敏')
  pass(!redactSecrets('password: hunter2secret').includes('hunter2secret'), 'password: … 被脱敏（同行）')
  // 0.3.2 跨行修复：`password:` 提示后的下一行是真实输出时，不得被吞（ssh 排障实锤的假失败根因）
  pass(redactSecrets("s1mple@host's password:\nSSH-LR-OK\nnext").includes('SSH-LR-OK'),
    'password: 提示**下一行**的成功输出不被跨行吞掉')
  pass(!redactSecrets('password:\thunter2secret').includes('hunter2secret'), 'password: 制表符同行仍脱敏')
  pass(redactSecrets('Authorization: Bearer abcdefghijklmn').includes('[redacted'), 'Bearer 令牌被脱敏')
  pass(redactSecrets('https://user:s3cr3tpw@example.com/repo').includes('***@') ||
    redactSecrets('https://user:s3cr3tpw@example.com/repo').includes('[redacted'), 'URL 内嵌口令被脱敏')
  pass(redactSecrets('ghp_' + 'abcdefghijklmnopqrstuvwxyz012345').includes('[redacted'), 'GitHub 令牌样式被脱敏（字面量拆开构造，避免触发仓库密钥扫描的误报）')
  pass(redactSecrets('hello world, nothing secret here') === 'hello world, nothing secret here',
    '普通文本原样返回（不误伤）')
  pass(redactSecrets('') === '' && redactSecrets(null) === null, '空值/非字符串安全返回')
}


/* ── 条件等待 waitFor（1 流） ────────────────────────────────────────────── */

{
  const m = parseWaitFor('match:listening on')
  pass(m.kind === 'match' && m.re instanceof RegExp && m.re.test('listening on :3000'), 'match: 解析成增量正则')
  const f = parseWaitFor('file:/tmp/ready.flag')
  pass(f.kind === 'file' && f.value === '/tmp/ready.flag', 'file: 解析出路径')
  const p = parseWaitFor('port:8080')
  pass(p.kind === 'port' && p.value === 8080, 'port: 解析出端口号')
  pass(parseWaitFor('port:0').error !== undefined && parseWaitFor('port:99999').error !== undefined,
    '端口越界 → 明确报错（不静默接受）')
  pass(parseWaitFor('match:[').error !== undefined, '非法正则 → 明确报错')
  pass(parseWaitFor('whatever').error !== undefined, '未知形式 → 明确报错并说明支持哪些')
  pass(parseWaitFor('').error !== undefined, '空串 → 报错')
}

/* ── 屏幕增量 diffSince（until/waitFor match、since 模式的新内容判定） ───────── */

{
  const d = (l, c) => diffSince(l, c)
  pass(d('', '') === '', '空帧对空帧 → 空')
  pass(d('old line', 'old line') === '', '完全相同 → 空')
  pass(d('p\nc1\nc2\ns1', 'p\nc1\nc2\ns1\ns2\ns3') === 's2\ns3', '底部追加：旧帧整体被识别为旧，只有追加行算新')
  pass(d('└─$ echo [TASK] COMPLETED\n[TASK] step 1', '└─$ echo [TASK] COMPLETED\n[TASK] step 1\n[TASK] step 2') === '[TASK] step 2',
    '自匹配防护：等待词出现在"自己发的命令回显"里不算新输出')
  const a = Array.from({ length: 20 }, (_, i) => `line ${i}`)
  const b = [...a, 'line 20', 'line 21']
  pass(d(a.join('\n'), b.join('\n')) === 'line 20\nline 21', '流式滚动：旧帧尾部仍是新帧前缀 → 只返回滚出的新行')
  pass(d('a\nb\n\n\n', 'a\nb\nc\n\n\n') === 'c', '底部空行填充（trim:false 带回）不干扰匹配')
  const alt = d('x\nbusy-line', 'x\nbusy-line2\ndone')
  pass(alt === 'busy-line2\ndone', '最后一行被重绘覆盖（进度条/提示符刷新）→ 去掉光标行再对齐，新内容完整保留')
  pass(d('t\nR\nR', 't\nR\nR\nR\nN') === 'R\nN', '重复内容：旧块之后的全算新（含重复本身之后的真实新增）')
  pass(d('old content', 'brand\nnew\nscreen') === 'brand\nnew\nscreen', '旧帧完全滚出 → 全屏算新（无旧可依）')
  pass(d('same\ncontent', 'same\ncontent\nmore') === 'more', '旧帧等长前缀 + 追加 → 只有追加算新')
  pass(d('P', 'P\necho READY\nREADY\nP') === 'echo READY\nREADY\nP',
    '旧提示符在顶部、同形新提示符在末尾 → 取第一次出现：命令输出完整保留（末尾提示符是新内容）')
  const promptRewrite = '┌──(u㉿h)-[~]\n└─$'
  const afterCmd = '┌──(u㉿h)-[~]\n└─$ sleep 0.4; echo READY-MARK-9\nREADY-MARK-9\n\n┌──(u㉿h)-[~]\n└─$'
  pass(d(promptRewrite, afterCmd) === '└─$ sleep 0.4; echo READY-MARK-9\nREADY-MARK-9\n\n┌──(u㉿h)-[~]\n└─$',
    '真机形态：光标行被输入改写、底部新提示符同形 → 回显与输出都在"新内容"里（不被吞）')
  pass(d('A\nB\nC', 'A\nB\nC2') === 'C2', '只有光标行被改写 → 只有该行算新（旧帧其余部分不重复报）')
}

/* ── 命令回显剥离 stripCommandEcho（waitFor match 的自匹配防护） ────────────── */

{
  const s = (fresh, sent) => stripCommandEcho(fresh, sent)
  pass(s('', 'echo x') === '', '空输入 → 空')
  pass(s('hello\nworld', 'echo other') === 'hello\nworld', '与命令无关的新输出原样返回')
  pass(s('sleep 0.4; echo READY\nREADY\n$', 'sleep 0.4; echo READY') === 'READY\n$',
    '剥掉回显整行，命令真输出保留')
  pass(s('x=SMK-1; date +%s\n1789\n$', 'x=SMK-1; date +%s') === '1789\n$', '简单命令回显剥离')
  pass(s('echo [TASK] COMPLETED\n[TASK] step 1\n[TASK] COMPLETED', 'echo [TASK] COMPLETED') === '[TASK] step 1\n[TASK] COMPLETED',
    '回显含等待词但输出后到 → 剥离后仍等真输出（自匹配防护的核心场景）')
  pass(s('x=SMK-9; dat\ne +%s\n1789\n$', 'x=SMK-9; date +%s') === '1789\n$',
    '折行把单词劈开（去空白拼接判定）也能剥干净')
  pass(s('sleep 1; echo READY\nREADY\n$', 'sleep 1; echo READY') === 'READY\n$',
    '输出行恰好是命令子串时不被误剥（前缀判据在命令结束时停手）')
  pass(s('└─$ sleep 0.4; echo READY-MARK-9\nREADY-MARK-9\n└─$', 'sleep 0.4; echo READY-MARK-9') === 'READY-MARK-9\n└─$',
    '回显行带提示符前缀（└─$ <命令>）也能剥干净')
  pass(s('anything at all', '') === 'anything at all', '空命令文本 → 原样返回')
}

/* ── 失败摘要（2 流） ───────────────────────────────────────────────────── */

{
  const s = summarizeFailure('some line\nmake: *** [build] Error 1\n$')
  pass(s.includes('Error 1'), `失败摘要挑出错误行：${s}`)
  const multi = summarizeFailure('Traceback (most recent call last):\n  File "x.py"\nModuleNotFoundError: No module named foo\n$')
  pass(multi.includes('ModuleNotFoundError'), `多行错误取像错误的那行：${multi}`)
  pass(summarizeFailure('just output\n$') === 'just output',
    '没有错误关键词时回退到最后一条有内容的行（失败常常只是一句 "Segmentation fault"）')
  pass(summarizeFailure('just output\n\n$') === 'just output', '空行与提示符都被过滤掉，不会拿它们当摘要')
  pass(summarizeFailure('') === '', '空输入 → 空摘要')
  const long = summarizeFailure('error: ' + 'x'.repeat(500))
  pass(long.length <= 160, `摘要按上限截断（${long.length} 字符）`)
  pass(summarizeFailure('$') === '', '只剩提示符 → 空摘要')
  const boxPrompt = 'echo x\n┌──(user' + '\u3299' + 'host)-[/tmp]\n└─$'   // 主机名用占位（避免仓库密钥/主机名扫描误报）
  pass(!summarizeFailure(boxPrompt).includes('┌') && !summarizeFailure(boxPrompt).includes('㉿'),
    `框线/㉿ 提示符不会被当成失败摘要（实得：${JSON.stringify(summarizeFailure(boxPrompt))}）`)
  const realErr = 'ls: cannot access /nope: No such file or directory\n┌──(user' + '\u3299' + 'host)-[/tmp]\n└─$'
  pass(summarizeFailure(realErr).includes('No such file'), '有真错误行时优先取错误行（提示符被过滤）')
}

/* ── 会话自检建议（5 流） ───────────────────────────────────────────────── */

{
  const stuck = doctorAdvice({ foreground: 'vim', isShell: false, idleSec: 3600 })
  pass(stuck.length === 1 && stuck[0].includes('可能卡住') && stuck[0].includes('C-c'),
    `前台非 shell 且久无活动 → 给"怎么办"：${stuck[0].slice(0, 40)}…`)
  pass(doctorAdvice({ foreground: 'bash', isShell: true, idleSec: 10 }).length === 0, '正常空闲会话 → 无建议')
  pass(doctorAdvice({ foreground: 'bash', isShell: true, idleSec: 10, bufferPct: 95 })[0].includes('缓冲'),
    '缓冲接近上限 → 提示调大 historyLimit')
  pass(doctorAdvice({ foreground: 'bash', isShell: true, idleSec: 10, captureStopped: true })[0].includes('留痕'),
    '留痕已停 → 如实提示')
  pass(doctorAdvice({ foreground: 'bash', isShell: true, idleSec: 4000, idleMinutes: 60 })[0].includes('闲置'),
    '超过闲置时长 → 提示即将被自动关闭')
  pass(doctorAdvice({ foreground: 'bash', isShell: true, idleSec: 10, userBusy: true })[0].includes('人在操作'),
    '人在操作 → 说明 AI 写操作会让路')
}

/* ── 0.3.2：expandHome / inspectSecretStrength / vaultExpired / parseDomainFile ── */
{
  pass(expandHome('~/a', '/home/u') === '/home/u/a' && expandHome('~', '/home/u') === '/home/u',
    'expandHome：整串 ~ 与前缀 ~/ 展开')
  pass(expandHome('a/~/b', '/home/u') === 'a/~/b' && expandHome('~/x', '') === '~/x',
    'expandHome：只认开头；无 home 原样（纯函数不碰 os）')
  pass(parseWaitFor('file:~/done.flag', '/home/u').value === '/home/u/done.flag',
    'waitFor file: 支持 ~/ 展开（0.3.2 ⑨）')
  const w1 = inspectSecretStrength('123456', { username: 'root' })
  pass(w1.length >= 2, '弱口令：纯数字常见串命中多条理由')
  const w2 = inspectSecretStrength('Kal1', { username: 'Kal1' })
  pass(w2.some((x) => x.includes('用户名')), '值=用户名必须点名（本轮实测教训的形状）')
  const w3 = inspectSecretStrength('Xk9#mQ2$ev7!zR4', { username: 'kal1' })
  pass(w3.length === 0, '强随机串：零告警（不误伤）')
  const now = 1789600000000
  pass(vaultExpired({ entry: { ttlDays: 7, createdAt: now - 8 * 86400000 }, now }) === true, 'TTL：超龄过期')
  pass(vaultExpired({ entry: { ttlDays: 7, createdAt: now - 8 * 86400000, lastUsedAt: now - 86400000 }, now }) === false,
    'TTL 从最后使用起算：近期用过不过期')
  pass(vaultExpired({ entry: { createdAt: now - 99 * 86400000 }, now }) === false, '无 ttlDays 永不过期')
  pass(parseDomainFile('', 'vault').ok === true, '空/缺失文件 = 合法空库')
  pass(parseDomainFile('{ oops', 'vault').corrupt === true, '坏 JSON 判损坏（不再静默空库）')
  pass(parseDomainFile('[1,2]', 'macros').corrupt === true, '数组/标量也判损坏（形状不对别当空库用）')
}

/* ── 0.3.0 双域引用：extractRefs / applyRefs / macroVisible / submit / oneShot ── */

{
  const refs = extractRefs('ssh {{m:bastion}} -p {{v:port}} 还有裸 {{only}} 与非法 {{a b}}')
  pass(refs.length === 3 && refs[0].domain === 'm' && refs[0].key === 'bastion'
    && refs[1].domain === 'v' && refs[1].key === 'port'
    && refs[2].domain === null && refs[2].key === 'only',
    `引用词法：显式 v/m 与裸键都认，非法形状 {{a b}} 不认（实得 ${refs.length} 个）`)
  pass(extractRefs('没有引用').length === 0, '无引用文本 → 空数组')

  const vault = { psd: { value: 'S3cret!', oneShot: true }, port: { value: '2222' } }
  const macros = {
    bastion: { text: 'ssh jump@10.0.0.1 -p {{v:port}}', scope: 'global' },
    mine: { text: 'echo hi', scope: 'conversation', owner: 'conv-A' },
    shellOnly: { text: 'uptime', scope: 'shell', session: 'dsh-abc123' },
  }
  const ok = applyRefs('sudo -S <<< {{v:psd}}', vault, macros, 'conv-A', 'dsh-abc123')
  pass(ok.ok === true && ok.text === 'sudo -S <<< S3cret!' && ok.usedVault.join(',') === 'psd',
    'vault 引用展开 + usedVault 记账（oneShot 消费由调用方在发送成功后做）')
  const nested = applyRefs('{{m:bastion}}', vault, macros, 'conv-A', 'dsh-abc123')
  pass(nested.ok === true && nested.text === 'ssh jump@10.0.0.1 -p 2222' && nested.usedVault.join(',') === 'port',
    '宏里嵌 {{v:}} → 第二趟展开（闭环：ssh {{m:bastion}} 自动带上端口秘密）')
  const bare = applyRefs('{{psd}}', vault, macros, 'conv-A', 'dsh-abc123')
  pass(bare.ok === true && bare.text === 'S3cret!', '裸键唯一命中 vault → 直接展开')
  const collide = applyRefs('{{dup}}', { dup: { value: 'v' } }, { dup: { text: 'm' } }, 'conv-A', 'dsh-x')
  pass(collide.ok === false && collide.error.includes('碰撞'), '裸键两域碰撞 → 拒绝并要求显式前缀（键碰撞攻击防线）')
  const missing = applyRefs('{{v:nope}}', vault, macros, 'conv-A', 'dsh-x')
  pass(missing.ok === false && missing.error.includes('nope'), '缺键 → 结构化错误（绝不把字面 {{…}} 发进终端）')
  const wrongScope = applyRefs('{{m:mine}}', vault, macros, 'conv-B', 'dsh-x')
  pass(wrongScope.ok === false && wrongScope.error.includes('可见域'), 'conversation 域宏对别的对话不可见')
  const wrongShell = applyRefs('{{m:shellOnly}}', vault, macros, 'conv-A', 'dsh-other')
  pass(wrongShell.ok === false, 'shell 域宏只能在指定终端用')
  const loopMacros = { a: { text: '{{m:b}}', scope: 'global' }, b: { text: 'x', scope: 'global' } }
  const looped = applyRefs('{{m:a}}', vault, loopMacros, 'conv-A', 'dsh-x')
  pass(looped.ok === false && looped.error.includes('一层'), '宏嵌宏 → 拒绝（只展开一层，防环防放大）')
  const big = applyRefs('{{v:psd}}', { psd: { value: 'x'.repeat(17000) } }, {}, 'conv-A', 'dsh-x')
  pass(big.ok === false && big.error.includes('16KB'), '展开后超 16KB → 拒绝')

  pass(macroVisible({ scope: 'global' }, 'anyone', 'any') === true, 'global 宏人人可见')
  pass(macroVisible({ scope: 'conversation', owner: 'A' }, 'A', 'x') === true
    && macroVisible({ scope: 'conversation', owner: 'A' }, 'B', 'x') === false, 'conversation 域按归属')
  pass(macroVisible({ scope: 'shell', session: 'dsh-1' }, 'A', 'dsh-1') === true
    && macroVisible({ scope: 'shell', session: 'dsh-1' }, 'A', 'dsh-2') === false, 'shell 域按终端')

  pass(macroSubmitWantsEnter('echo hi') === true, '单行宏 → 要 Enter')
  pass(macroSubmitWantsEnter('line1\nline2') === true, '多行宏尾部有未提交行 → 要 Enter')
  pass(macroSubmitWantsEnter('line1\nline2\n') === false, '多行宏自己以换行结尾 → 别再补 Enter（防空提交）')

  pass(vaultConsumeNow({ entry: { oneShot: true } }).consume === true, 'oneShot → 烧（0.3.1 发送前落刀：一次引用一次消耗）')
  pass(vaultConsumeNow({ entry: {} }).usesBump === true, '非 oneShot → 只计数不烧')
  pass(vaultConsumeNow({ entry: undefined }).consume === false, '键不存在 → 安全空操作')
  // 0.3.1 防绕过：oneShot 重复引用在**展开层**拒绝整条（旧版"不烧只计违规"= 双份注入还免烧）
  const rep1 = applyRefs('{{v:pw}} {{v:pw}}', { pw: { value: 'S3cr3tV', oneShot: true } }, {}, 'A', 'dsh-1')
  pass(rep1.ok === false && /只能引用一次/.test(rep1.error), 'oneShot 同条重复引用 → 展开层整条拒绝')
  const repMac = applyRefs('{{m:c}} 再补 {{v:pw}}', { pw: { value: 'S3cr3tV', oneShot: true } }, { c: { text: 'pre {{v:pw}} post', scope: 'global' } }, 'A', 'dsh-1')
  pass(repMac.ok === false, '明面一次 + 宏里一次 = 两份 → 跨趟计数同样拒绝')
  const repRe = applyRefs('{{v:ok2}} {{v:ok2}}', { ok2: { value: 'R3useV' } }, {}, 'A', 'dsh-1')
  pass(repRe.ok === true && repRe.text === 'R3useV R3useV', '非 oneShot 允许重复引用（uses 计数由发送方处理）')
  const single = applyRefs('echo {{v:pw}}', { pw: { value: 'S3cr3tV', oneShot: true } }, {}, 'A', 'dsh-1')
  pass(single.ok === true && single.text === 'echo S3cr3tV', 'oneShot 单次引用 → 正常展开')
  pass(single.directVault.length === 1 && single.directVault[0] === 'pw',
    'directVault 标记"原文直引 vault"（AI 侧裸引用规则的判据；宏内嵌不算 direct）')
  const viaMacro = applyRefs('ssh {{m:bastion}}', { psd: { value: 'S3cr3tV' } },
    { bastion: { text: 'ssh h -p {{v:psd}}', scope: 'global' } }, 'A', 'dsh-1')
  pass(viaMacro.ok === true && viaMacro.usedVault.length === 1 && viaMacro.directVault.length === 0,
    '闭环形态"ssh {{m:bastion}}"（秘密藏宏里）：usedVault 有、directVault 空 → 不受 AI 裸引用规则限制')
  const sfV = applyRefs('{{m:fill}}', { psd: { value: 'S3cr3tV' } },
    { fill: { text: 'user={{v:psd}}', scope: 'global', submit: false } }, 'A', 'dsh-1')
  pass(sfV.ok === false && /submit:false/.test(sfV.error),
    'submit:false 宏嵌 {{v:}} → 拒绝展开（值不许悬在未提交的行上等拼接）')
  const sfOk = applyRefs('{{m:fill2}}', {}, { fill2: { text: 'printf "user>"', scope: 'global', submit: false } }, 'A', 'dsh-1')
  pass(sfOk.ok === true && sfOk.text === 'printf "user>"', 'submit:false 不嵌秘密照常允许（纯填充形态）')
  // 0.3.1 行身份打码（maskVaultLine）：只遮"注入所在行"，全局串替换的包含预言机断死
  const ent = [{ sent: 'echo S3cr3tV', values: [{ v: 'S3cr3tV', key: 'pw' }] }]
  pass(maskVaultLine('└─$ echo S3cr3tV ; _dsh_x=$?', ent).includes('[vault:{{v:pw}}]'), '命令回显行含完整注入文本 → 行内遮蔽')
  pass(maskVaultLine('  S3cr3tV', ent).trim() === '[vault:{{v:pw}}]', '秘密独占整行（tty 回显形态）→ 遮蔽')
  pass(maskVaultLine('S3cr3t', ent) === 'S3cr3t', '猜前缀的输出行原样返回 —— 增长预言机不存在')
  pass(maskVaultLine('[sudo] password for S3cr3tV', ent).endsWith('[vault:{{v:pw}}]'), '值在行尾（带前缀回显）→ 尾锚定遮蔽')
  pass(maskVaultLine('S3cr3t extra', ent) === 'S3cr3t extra', '部分串（前缀+尾巴）不触发尾锚定')
  pass(maskVaultLine('S3cr3tV extra tail', ent) === 'S3cr3tV extra tail', '值在行内但不独占整行且不含注入原文 → 不遮（宁可放过串扰，不给预言机留缝）')
  pass(maskVaultLine('ps aux | grep x', ent) === 'ps aux | grep x', '无关行不动')
  const entBare = [{ sent: 'S3cr3tV', values: [{ v: 'S3cr3tV', key: 'pw' }] }]
  pass(maskVaultLine('┌──(user㉿host)─[~/S3cr3tV]', entBare) === '┌──(user㉿host)─[~/S3cr3tV]', '裸注入（sent==值）不对值做包含式连坐遮蔽（0.3.0 提示符被遮的根因）')
  pass(maskVaultLine('S3cr3tV', entBare).trim() === '[vault:{{v:pw}}]', '裸注入的值独占行仍遮蔽')
  pass(REF_KEY_RE.test('a.b_c-1') && !REF_KEY_RE.test('a b') && !REF_KEY_RE.test('a;b'), '引用键白名单（分号/空格进不了文件名与 tmux 目标）')
}

console.log(failed === 0 ? `pure 纯函数：全部通过（${checked} 项断言）` : `pure 纯函数：${failed}/${checked} 项失败`)
process.exit(failed === 0 ? 0 : 1)
