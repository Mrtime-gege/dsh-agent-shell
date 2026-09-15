#!/usr/bin/env node
/**
 * dsh-agent-shell 命令行（0.2.2）：一条命令安装/卸载/体检。
 *
 * 用法：
 *   npx -y dsh-agent-shell install   [--profile <name>] [--dry-run] [--yes]
 *   npx -y dsh-agent-shell uninstall [--profile <name>] [--dry-run]
 *   dsh-agent-shell doctor
 *   dsh-agent-shell --version | --help
 *
 * install 做什么（全部可 --dry-run 预览）：
 *   1. 在 DSH profile（默认 web）的 package.json 里登记依赖与 bundle；
 *   2. 按 profile 的包管理器（pnpm/npm/yarn）装依赖；
 *   3. 检查 tmux（跑包的 install-deps.sh --check 同款逻辑）；
 *   4. 提示重启 `dsh web` 生效。
 *
 * 零外部依赖（只用 Node 内建），可离线跑。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const PKG = 'dsh-agent-shell'
// 版本来自包自身（npx 装下来的就是它）
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const flagValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const echo = (text = '') => console.log(text)
const fail = (text) => { console.error(`\n✗ ${text}`); process.exit(1) }
const ok = (text) => console.log(`✓ ${text}`)

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}
function profilesDir() {
  return join(dshHome(), 'profiles')
}
function pickProfile(want) {
  const dir = profilesDir()
  if (!existsSync(dir)) fail(`找不到 DSH profiles 目录：${dir}（${PKG} 需要 DSH 运行环境）`)
  const available = readdirSync(dir).filter((n) => existsSync(join(dir, n, 'package.json'))).sort()
  if (available.length === 0) fail(`profiles 目录里没有可用 profile：${dir}`)
  const chosen = want !== undefined && want !== '' ? want
    : (available.length === 1 ? available[0] : (available.includes('web') ? 'web' : available[0]))
  if (!available.includes(chosen)) {
    fail(`profile「${chosen}」不存在；可用的：${available.join(', ')}（用 --profile 指定）`)
  }
  return { dir, name: chosen, root: join(dir, chosen) }
}

function readProfileJson(root) {
  const p = join(root, 'package.json')
  if (!existsSync(p)) fail(`没有 ${p}（这不是一个 DSH profile？）`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function packageManagerOf(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(root, 'package-lock.json'))) return 'npm'
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

function tmuxCheck() {
  const r = spawnSync('sh', ['-c', 'command -v tmux >/dev/null 2>&1 && tmux -V || echo MISSING'], { encoding: 'utf8' })
  const out = (r.stdout ?? '').trim()
  return out === 'MISSING' ? '' : out
}

function install() {
  const dryRun = flag('dry-run')
  const profile = pickProfile(flagValue('profile', undefined))
  const root = profile.root

  const json = readProfileJson(root)
  const dependencies = json.dependencies ?? {}
  const bundles = (json.dsh?.profile?.bundles ?? []).filter((b) => b !== PKG)
  const semver = VERSION.startsWith('0.') ? VERSION : VERSION
  echo(`\n${PKG}@${VERSION} → profile「${profile.name}」（${dryRun ? 'DRY-RUN，只预览不动手' : '实装'}）\n`)

  const before = JSON.stringify(json, null, 2)
  dependencies[PKG] = `^${semver}`
  json.dependencies = dependencies
  json.dsh = json.dsh ?? { profile: {} }
  json.dsh.profile = json.dsh.profile ?? {}
  json.dsh.profile.bundles = [...bundles, PKG]
  const after = JSON.stringify(json, null, 2)

  // 发布前置校验：远程版本存在才装（否则 pnpm 对 ^0.2.2 报 No matching version，用户看不懂）。
  // 本地开发（file: 依赖 / dev-sync）不经过本命令，所以这里放心检查 registry。
  const probe = spawnSync('npm', ['view', `${PKG}@${semver}`, 'version'], { encoding: 'utf8', timeout: 20000 })
  const remoteHas = probe.status === 0 && String(probe.stdout ?? '').split(/\s+/).filter(Boolean).length > 0
  if (dryRun) {
    echo(remoteHas ? `（npm 上已有 ${PKG}@${semver}）` : `⚠ npm 上还没有 ${PKG}@${semver} —— 推 v${semver} tag 后 CI 会自动发布`)
  } else if (!remoteHas) {
    fail(`${PKG}@${semver} 还没有发布到 npm。发布由 GitHub 自动完成：git tag v${semver} && git push origin v${semver}
    · 本地开发请用 profile 的 file: 依赖（不走本命令）`)
  }

  const pm = packageManagerOf(root)
  echo(`1) 登记依赖与 bundle`)
  echo(`   dependencies.${PKG} = ^${semver}；dsh.profile.bundles += ${PKG}`)
  if (dryRun) {
    echo(`2) 将按 ${pm} 在 ${root} 安装依赖`)
    echo(`3) tmux 检查：${tmuxCheck() || '缺 tmux（按 install-deps.sh 的指引装）'}`)
    echo(`\n（未做任何修改 —— --dry-run）`)
    return
  }
  if (before !== after) writeFileSync(join(root, 'package.json'), after + '\n')
  ok('package.json 已登记依赖与 bundle')

  echo(`2) 安装依赖（${pm} install …）`)
  const r = spawnSync(pm, ['install'], { cwd: root, stdio: 'inherit', shell: false })
  if (r.status !== 0) fail(`${pm} install 失败（exit ${r.status}）`)
  ok(`${pm} install 完成`)

  echo(`3) tmux 检查`)
  const tmux = tmuxCheck()
  if (tmux === '') {
    echo('   ⚠ 缺 tmux —— 插件本体需要它：')
    echo('     Debian/Ubuntu: sudo apt-get install -y tmux')
    echo('     Termux:        pkg install -y tmux')
  } else {
    ok(`tmux ${tmux} 在位`)
  }

  echo(`\n4) 完成。最后一步：重启 dsh web（DSH 插件列表里启用后生效）。`)
  echo(`   首次用时授权门会问你一次（同一个对话只问一次）。`)
  echo(`   体检：dsh-agent-shell doctor`)
}

function uninstall() {
  const dryRun = flag('dry-run')
  const profile = pickProfile(flagValue('profile', undefined))
  const root = profile.root
  const json = readProfileJson(root)
  const deps = json.dependencies ?? {}
  const bundles = json.dsh?.profile?.bundles ?? []
  if (deps[PKG] === undefined && !bundles.includes(PKG)) {
    echo(`${PKG} 不在 profile「${profile.name}」里（无需卸载）`)
    return
  }
  const before = JSON.stringify(json, null, 2)
  delete deps[PKG]
  json.dependencies = deps
  json.dsh.profile.bundles = bundles.filter((b) => b !== PKG)
  echo(`将从 profile「${profile.name}」移除 ${PKG} 的依赖与 bundle${dryRun ? '（DRY-RUN）' : ''}`)
  if (dryRun) return
  writeFileSync(join(root, 'package.json'), JSON.stringify(json, null, 2) + '\n')
  ok('已移除（重启 dsh web 后不再加载）')
}

function doctor() {
  echo(`\ndsh-agent-shell@${VERSION} 体检\n`)
  const tmux = tmuxCheck()
  tmux === '' ? fail('✗ 缺 tmux（apt/pacman/apk/pkg 装一下）') : ok(`tmux ${tmux}`)

  const dir = profilesDir()
  if (existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      const nm = join(dir, name, 'node_modules', PKG)
      if (existsSync(join(dir, name, 'package.json'))) {
        ok(`profile「${name}」：${existsSync(nm) ? '已安装 ' + (JSON.parse(readFileSync(join(nm, 'package.json'), 'utf8')).version ?? '?') : '未安装'}${existsSync(join(dir, name, 'cordis.patch.yml')) && readFileSync(join(dir, name, 'cordis.patch.yml'), 'utf8').includes(PKG) ? ' · patch 里已登记' : ''}`)
      }
    }
  }
  const auditFile = join(dshHome(), 'agent-shell')
  ok(`数据目录：${auditFile}${existsSync(auditFile) ? '（存在）' : '（未创建——首次使用时生成）'}`)
  echo('\n（打开页面 → 右下角胶囊即可用；详情 ⓘ 里有能力/降级/审计链状态）')
}

if (args.includes('--version') || args.includes('-V')) {
  echo(VERSION)
  process.exit(0)
}
if (args.includes('--help') || args.includes('-h') || args.length === 0) {
  echo(`dsh-agent-shell v${VERSION} —— 一个命令装好 DSH 持久化 shell 插件

用法:
  dsh-agent-shell install [--profile <name>] [--dry-run]   安装到 DSH profile（--dry-run 只预览）
  dsh-agent-shell uninstall [--profile <name>] [--dry-run]         从 profile 移除
  dsh-agent-shell doctor                                           体检：tmux / 安装状态 / 数据目录
  dsh-agent-shell --version | --help
`)
  process.exit(0)
}
if (args.includes('install')) { install(); process.exit(0) }
if (args.includes('uninstall')) { uninstall(); process.exit(0) }
if (args.includes('doctor')) { doctor(); process.exit(0) }
fail(`未知命令：${args[0] ?? ''}（用 --help 看用法）`)