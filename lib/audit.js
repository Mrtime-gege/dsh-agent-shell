/**
 * 审计：**输入流水** + **终端输出留痕**。
 *
 * 为什么这两个面合起来才叫"可审计"：
 *
 *   * 进入终端的**每一个字节**都只经过两个入口 —— 工具 `shell_send` 与面板的 HTTP `/keys`
 *     （没有第三条路）。所以在这两个入口记账，输入面就是**完整**的：谁、什么时间、往哪个
 *     shell、发了什么、有没有被护栏拦下、结果如何。
 *   * 但输入不等于现场。`pipe-pane` 记的是窗格**输出**（含回显的命令、程序输出、
 *     TUI 画面），它回答"实际发生了什么"，而且在会话被关掉之后**文件依然在** ——
 *     这正是"关闭会话后依然可见"。
 *
 * 本文件只放**纯函数与落盘原语**，不含任何 Cordis/宿主依赖，因此可以离线测试：
 * 行格式、轮转计划、上限判定、记录裁剪都在这里定死。
 *
 * @module dsh-agent-shell/audit
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

/** 单条记录里 `text` 字段的落盘上限：超过就截断并标记，避免一条 heredoc 撑爆日志。 */
export const TEXT_LIMIT = 16 * 1024

/** 哈希链的创世前驱：第一条封链记录的 `prevHash` 就是它。 */
export const GENESIS = 'genesis'

/** 链上使用的摘要算法（纯 JS，跨平台一致；不依赖任何外部工具）。 */
export const HASH_ALGO = 'sha256'

/** 审计目录：`${DSH_HOME:-~/.dsh}/agent-shell`。 */
export function auditDirFor(env = {}, home = '') {
  const base = typeof env.DSH_HOME === 'string' && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : join(home === '' ? '.' : home, '.dsh')
  return join(base, 'agent-shell')
}

/** 审计目录下的固定布局。 */
export function auditPaths(dir) {
  return {
    dir,
    input: (day) => join(dir, `audit-${day}.jsonl`),
    owners: join(dir, 'sessions.json'),
    consent: join(dir, 'consent.json'),
    outputDir: join(dir, 'output'),
  }
}

/** `YYYY-MM-DD`（本地时区：人看日志时按本地日记事最自然）。 */
export function dayKey(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 把一条记录裁剪到可安全落盘的大小。
 *
 * `text` 可能是一整段 heredoc，原样写进去会让日志迅速膨胀且难以阅读；截断后仍保留
 * 字节数与 `truncated` 标记 —— **删掉信息要留痕**，否则审计本身就在撒谎。
 */
export function trimRecord(record, limit = TEXT_LIMIT) {
  const out = { ...record }
  for (const key of ['text', 'newName']) {
    const value = out[key]
    if (typeof value === 'string' && value.length > limit) {
      out[key] = value.slice(0, limit)
      out[key + 'Truncated'] = true
      out[key + 'Bytes'] = Buffer.byteLength(value, 'utf8')
    }
  }
  if (typeof out.text === 'string' && out.textBytes === undefined) {
    out.textBytes = Buffer.byteLength(out.text, 'utf8')
  }
  return out
}

/** 一行 JSONL。序列化失败绝不抛 —— 审计不能反过来把 shell 弄坏。 */
export function formatAuditLine(record) {
  try {
    return JSON.stringify(trimRecord(record)) + '\n'
  } catch {
    return JSON.stringify({ ts: Date.now(), event: 'audit-serialize-failed' }) + '\n'
  }
}

/* ── 哈希链（审计不可篡改的地基）─────────────────────────────────────────────
 *
 * 目标（维护者定）：**审计可审计且不可篡改**。做法不是在写入路径上做权限（同用户模型下
 * 拦不住），而是让"改动过"这件事**无法隐藏**：
 *
 *   · 每条记录携带 `prevHash`（前一条的摘要）与 `hash`（自身的摘要）；
 *   · 摘要覆盖整条记录（键排序后的规范化 JSON），并链上前一条的摘要；
 *   · 删一条、改一个字节、调换顺序 —— 都会让后续所有 `prevHash`/`hash` 对不上。
 *
 * 校验只读、纯函数、零依赖（node:crypto 内建），因此可离线单测。
 * 没有 `hash`/`prevHash` 的历史记录视为"未封链"，跳过而不判为断链（老日志仍可读）。
 */

/** 规范化值：对象按键排序，数组保序；`undefined`/函数等不可序列化值统一成 null。 */
function stableValue(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(stableValue)
  if (typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key])
    return out
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return String(value)
  return value
}

/**
 * 规范化 JSON（不含 `hash` 与 `prevHash`）：**同一记录在任何环境下得到同一字符串**，这是摘要可复算的前提。
 * 键排序保证对象字面量顺序不影响结果；`undefined` 归一成 null 保证"缺字段"与"显式 null"一致。
 * `prevHash` 不参与摘要：它是**链接参数**（连接前一条），写进记录里只是为了校验时能复算；
 * 若把它规范进内容，排序/别名会影响摘要，反而失去"仅凭内容可复算"的性质。
 */
export function canonicalize(record) {
  const clean = {}
  for (const key of Object.keys(record ?? {}).sort()) {
    if (key === 'hash' || key === 'prevHash') continue
    clean[key] = stableValue(record[key])
  }
  return JSON.stringify(clean)
}

/** 计算一条记录的摘要：`H(prevHash + '\n' + canonical(record))`。 */
export function hashRecord(prevHash, record) {
  return createHash(HASH_ALGO)
    .update(String(prevHash) + '\n' + canonicalize(record), 'utf8')
    .digest('hex')
}

/** 封链：补上 `prevHash` 与 `hash`，返回可直接落盘的新对象（不改原对象）。 */
export function sealRecord(prevHash, record) {
  const trimmed = trimRecord(record)
  const withPrev = { ...trimmed, prevHash: String(prevHash) }
  return { ...withPrev, hash: hashRecord(withPrev.prevHash, withPrev) }
}

/**
 * 校验一条链（按时间顺序的记录数组）。
 *
 * @param {Array<object>} records
 * @param {{startHead?: string, allowLegacy?: boolean}} [options]
 * @returns {{ok: boolean, brokenAt: null|{index:number, ts?:number, reason:string}, sealed:number,
 *            legacy:number, startUnknown:boolean, head:string, checked:number}}
 */
export function verifyChain(records, options = {}) {
  const list = Array.isArray(records) ? records : []
  const allowLegacy = options.allowLegacy !== false
  const startHead = typeof options.startHead === 'string' && options.startHead !== '' ? options.startHead : GENESIS
  let head = startHead
  let sealed = 0
  let legacy = 0
  let startUnknown = false
  let broken = null

  for (let i = 0; i < list.length; i += 1) {
    const rec = list[i]
    const hasHash = rec !== null && typeof rec === 'object' && typeof rec.hash === 'string' && rec.hash !== ''
    const hasPrev = rec !== null && typeof rec === 'object' && typeof rec.prevHash === 'string' && rec.prevHash !== ''
    if (!hasHash || !hasPrev) {
      if (!allowLegacy) { broken = { index: i, reason: 'unsealed' }; break }
      legacy += 1
      continue
    }
    // 起点未知：更早的文件没读到（被删/超范围），第一条 sealed 的 prevHash 对不上创世 ——
    // 这本身值得提示，但不应冒充"断链"（我们无法证明它断）。
    if (sealed === 0 && head === GENESIS && rec.prevHash !== GENESIS) {
      startUnknown = true
      head = rec.hash
      sealed += 1
      continue
    }
    if (rec.prevHash !== head) {
      broken = { index: i, ts: typeof rec.ts === 'number' ? rec.ts : undefined, reason: 'prev-mismatch' }
      break
    }
    const expected = hashRecord(rec.prevHash, rec)
    if (expected !== rec.hash) {
      broken = { index: i, ts: typeof rec.ts === 'number' ? rec.ts : undefined, reason: 'hash-mismatch' }
      break
    }
    head = rec.hash
    sealed += 1
  }

  return { ok: broken === null, brokenAt: broken, sealed, legacy, startUnknown, head, checked: list.length }
}

/** 解析一行 JSONL；坏行返回 null（日志里可能有半截写入）。 */
export function parseAuditLine(line) {
  const trimmed = String(line).trim()
  if (trimmed === '') return null
  try {
    const parsed = JSON.parse(trimmed)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 该保留哪些按天划分的审计文件。
 *
 * 输入的纯函数：给定文件名列表与"今天"，算出要删哪些。保留期外的删掉；
 * 文件名不符合 `audit-YYYY-MM-DD.jsonl` 的一律保留（不认识的别乱删）。
 */
export function prunePlan(files, todayKey, retentionDays) {
  const keep = []
  const remove = []
  const cutoff = Date.parse(todayKey + 'T00:00:00Z') - (retentionDays - 1) * 86400000
  for (const name of files) {
    const match = /^audit-(\d{4})-(\d{2})-(\d{2})\.jsonl$/.exec(name)
    if (match === null) { keep.push(name); continue }
    const stamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`)
    if (!Number.isFinite(stamp)) { keep.push(name); continue }
    if (stamp < cutoff) remove.push(name)
    else keep.push(name)
  }
  return { keep, remove }
}

/** 输出留痕的会话文件名：`<shell>-<起始时间戳>.log`（时间戳让同一名字的复用不互相覆盖）。 */
export function outputFileFor(shell, startedAtMs) {
  const safe = String(shell).replace(/[^A-Za-z0-9._-]/g, '')
  return `${safe === '' ? 'shell' : safe}-${String(startedAtMs)}.log`
}

/** 供查询结果里展示的一行摘要（纯函数，面板与工具共用同一份措辞）。 */
export function summarizeRecord(record) {
  const time = new Date(record.ts ?? 0).toISOString().replace('T', ' ').slice(0, 19)
  const event = String(record.event ?? '?')
  const shell = String(record.shell ?? '-')
  const actor = String(record.actor ?? '-')
  const source = String(record.source ?? '-')
  let detail = ''
  if (event === 'input') {
    const parts = []
    if (typeof record.text === 'string' && record.text !== '') parts.push(JSON.stringify(record.text.length > 80 ? record.text.slice(0, 80) + '…' : record.text))
    if (Array.isArray(record.keys) && record.keys.length > 0) parts.push('keys=' + record.keys.join(','))
    if (Array.isArray(record.preKeys) && record.preKeys.length > 0) parts.push('preKeys=' + record.preKeys.join(','))
    detail = parts.join(' ') || '(空输入)'
    if (record.guard !== undefined && record.guard !== 'allowed') detail += ` [护栏:${record.guard}]`
  } else if (event === 'open' || event === 'close' || event === 'rename') {
    detail = event === 'rename' ? `→ ${String(record.newName ?? '-')}` : String(record.result ?? '')
  }
  return `${time} ${event.padEnd(6)} ${shell.padEnd(16)} ${source.padEnd(6)} ${actor.padEnd(18)} ${detail}`
}

/* ── 以下是有副作用的最小原语：全部 best-effort，失败绝不冒泡到 shell 操作 ─────────── */

/** 创建审计目录（0700：审计内容可能含敏感信息，不给同机其它用户读）。 */
export async function ensureAuditDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * 追加一条审计记录。**绝不抛**：写失败（磁盘满、权限、只读）只回报 false ——
 * 让"记不下来"变成一个可观测的事实，而不是把用户正在做的事情弄失败。
 *
 * @param {object} paths 审计目录布局
 * @param {string} day 日期键
 * @param {object} record 记录
 * @param {{head?: string, seq?: number}|null} [chain] 传入则封链（写入 `prevHash`/`hash` 并推进链头）。
 *   **先落盘成功再推进链头** —— 否则内存链头会与磁盘不一致，之后每条都会"断链"。
 */
export async function appendAudit(paths, day, record, chain = null) {
  try {
    // 目录由这里保证：调用方（工具/HTTP/授权）不该为了记一笔日志先关心 mkdir 顺序。
    // 实测踩到过：目录还没建就写 consent/owners，静默失败 → 新实例读不到授权、重复问用户。
    await ensureAuditDir(paths.dir)
    if (chain !== null && typeof chain === 'object') {
      const sealed = sealRecord(typeof chain.head === 'string' && chain.head !== '' ? chain.head : GENESIS, record)
      await appendFile(paths.input(day), JSON.stringify(sealed) + '\n', { mode: 0o600 })
      chain.head = sealed.hash
      chain.seq = (Number.isFinite(chain.seq) ? chain.seq : 0) + 1
      return true
    }
    await appendFile(paths.input(day), formatAuditLine(record), { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** 读取某天的审计记录（按天，缺文件返回空数组）。 */
export async function readAudit(paths, day, { shell = '', actor = '', source = '', limit = 200 } = {}) {
  let raw
  try {
    raw = await readFile(paths.input(day), 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of raw.split('\n')) {
    const record = parseAuditLine(line)
    if (record === null) continue
    if (shell !== '' && String(record.shell ?? '') !== shell) continue
    if (actor !== '' && String(record.actor ?? '') !== actor) continue
    if (source !== '' && String(record.source ?? '') !== source) continue
    out.push(record)
  }
  return limit > 0 && out.length > limit ? out.slice(-limit) : out
}

/** 按保留期清理旧审计文件（只删自己认识的文件名）。 */
export async function pruneAuditFiles(paths, todayKey, retentionDays) {
  let files = []
  try { files = await readdir(paths.dir) } catch { return [] }
  const { remove } = prunePlan(files, todayKey, retentionDays)
  const removed = []
  for (const name of remove) {
    try { await rm(join(paths.dir, name), { force: true }); removed.push(name) } catch { /* 忽略 */ }
  }
  return removed
}

/** 目录里按日期升序的审计文件名（只认 `audit-YYYY-MM-DD.jsonl`，不认识的别乱读）。 */
export async function auditFileNames(paths) {
  let files = []
  try { files = await readdir(paths.dir) } catch { return [] }
  return files.filter((name) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort()
}

/**
 * 读回**整条链**并校验（跨天连续：昨天的最后一条今天接着）。
 *
 * 这是"篡改可见"的读取口：返回的 `verify` 里带上断链位置与已校验条数，调用方必须把它
 * 显示出来 —— 校验结论不展示，等于没做。
 */
export async function readSealedChain(paths) {
  const names = await auditFileNames(paths)
  const records = []
  for (const name of names) {
    try {
      const raw = await readFile(join(paths.dir, name), 'utf8')
      for (const line of raw.split('\n')) {
        const record = parseAuditLine(line)
        if (record !== null) records.push(record)
      }
    } catch { /* 单个文件读失败不拖垮整链 */ }
  }
  return {
    days: names.map((name) => name.slice('audit-'.length, -'.jsonl'.length)),
    records,
    verify: verifyChain(records),
  }
}

/** 链头（最后一条封链记录的摘要），用于宿主重启后继续接链；没有则返回 GENESIS。 */
export function chainHeadOf(records) {
  for (let i = (Array.isArray(records) ? records.length : 0) - 1; i >= 0; i -= 1) {
    const rec = records[i]
    if (rec !== null && typeof rec === 'object' && typeof rec.hash === 'string' && rec.hash !== '') return rec.hash
  }
  return GENESIS
}

/**
 * 尽力检测审计目录是否已加锁（内核级 append-only，`chattr +a`）。
 *
 * 只读诊断：`lsattr` 不存在 / 非 Linux / 无权限一律返回 `'unknown'`，绝不猜。
 * 返回 `'append-only'`（已锁）| `'writable'`（未锁）| `'unknown'`。
 */
export async function detectAppendOnly(dir) {
  try {
    const { stdout } = await execFileAsync('lsattr', ['-d', dir], { timeout: 4000 })
    const flags = String(stdout).trim().split(/\s+/)[0] ?? ''
    if (flags === '' || !/^[-a-zA-Z]+$/.test(flags)) return 'unknown'
    return flags.includes('a') ? 'append-only' : 'writable'
  } catch {
    return 'unknown'
  }
}

/** 会话归属表（D1：只标注，不做拦截）—— 存盘以便宿主重启后仍能回答"谁开的"。 */
export async function readOwners(paths) {
  try {
    const parsed = JSON.parse(await readFile(paths.owners, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export async function writeConsent(paths, consent) {
  try {
    await ensureAuditDir(paths.dir)
    await writeFile(paths.consent, JSON.stringify(consent, null, 2) + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

export async function readConsent(paths) {
  try {
    const parsed = JSON.parse(await readFile(paths.consent, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export async function writeOwners(paths, owners) {
  try {
    await ensureAuditDir(paths.dir)
    await writeFile(paths.owners, JSON.stringify(owners, null, 2) + '\n', { mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/** 输出留痕文件当前的字节数（文件不存在算 0）。 */
export async function outputSize(path) {
  try {
    const info = await stat(path)
    return Number.isFinite(info.size) ? info.size : 0
  } catch {
    return 0
  }
}

/** 列出输出留痕文件（时间倒序），供面板/工具查看"关掉的会话留下了什么"。 */
export async function listOutputFiles(paths) {
  try {
    const files = await readdir(paths.outputDir)
    const withStat = await Promise.all(files.map(async (name) => {
      const info = await stat(join(paths.outputDir, name)).catch(() => null)
      return { name, bytes: info === null ? 0 : info.size, mtimeMs: info === null ? 0 : info.mtimeMs }
    }))
    return withStat.sort((a, b) => b.mtimeMs - a.mtimeMs)
  } catch {
    return []
  }
}
