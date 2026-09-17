# dsh-agent-shell

> Persistent multi-shell terminal for DeepSeek Harness: 10 model tools + a draggable, type-able floating panel.

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

[**English**](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/README.en.md) · [**中文**](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/README.md)

## ⚠️ Read the risks first

This hands a real shell to the AI. It is not a toy and not a sandbox.

1. **developed by AI, no human audit.** Tested, but never security-reviewed by a human.
2. **Grant = arbitrary commands.** Once a conversation is granted, its AI can read, modify, send
   network traffic, install software and **delete things** with your user privileges — there is
   **no approval gate** and nothing asks you per command. Refuse and it cannot execute.
3. **No liability.** It provides convenience plus honest recording, not a sandbox. Data loss,
   prompt-injected destructive commands, credentials showing up in a terminal — your call.
4. **The only line of defense is a heuristic keyword guard** (`guardDangerousCommands`, on by
   default): matches `rm -rf /`, `mkfs`, `dd of=/dev/*`, … and is **trivially bypassable and
   false-positives**. A speed bump, not protection.
5. **Audit is "detectable", not "immutable" (default)**: the hash chain reveals tampering, but
   same-privilege AI can modify audit files too; upgrade to append-only with `chattr +a`
   (`./install-deps.sh --audit-lock`).
6. **ssh/remote = "tunnel-level" audit only**: keys and screen in/out of the tunnel, not what the
   remote machine actually did.
7. **Not for production / multi-user / irreplaceable-data machines.** Back up first.

## One-command install

Linux (incl. WSL2/containers), Node ≥ 20, a running DSH (0.1.5+):

```sh
npx -y dsh-agent-shell install [--profile web]
```

Registers the dependency and bundle into the profile → installs via pnpm/npm → checks tmux →
tells you to restart `dsh web`. `--dry-run` previews; `doctor` checks tmux / install state / data
dir; `uninstall` removes. npm releases are published by GitHub Actions on `v*` tags (CLI ships
from 0.2.2).

## What it is

- Persistent shells on a private tmux server — survive closing the page, switching chats,
  hot reload and DSH restarts (watchdog claims/orphans them).
- **10 model tools**: `shell_open / shell_run / shell_send / shell_read / shell_wait /
  shell_check / shell_manage / shell_state / shell_audit / shell_consent`, addressed by **stable
  id** (the user-facing name is a renameable label).
- The panel is a real terminal: sudo password prompts, full-screen vim, REPLs, completion.
- **Audit: one hash chain for everything** — `tool-call` / `input` / `open` / `close` / `rename` /
  `consent` / `panel-lock` / `env-degraded` / `capture` / `idle` (idle-close) / `config`
  (setting changes) all in `audit-YYYY-MM-DD.jsonl`, each
  record sealed the moment it is written (SHA-256); altering any record breaks the chain loudly.

## Safety boundaries (summarised)

- The one-time consent gate prevents slips, not malicious agents — **native bash can do anything
  the plugin can** (it can even edit the consent file); anything enforced only inside this plugin
  is politeness, not a boundary.
- Human-in-the-loop: unlocking the panel pauses the AI's modifications to that shell (send,
  rename, resize, close); read-only tools keep working.
- Capability degradation is stated in plain words (no systemd → sessions die with `dsh` restart;
  no `/proc` → rough busy detection) — see `shell_state`, panel ⓘ, `/diagnose`.
- **Linux only** (incl. WSL2); Windows via WSL2, macOS unsupported.
- Full model: [docs/SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md).

## When it's worth it

| Case | Why |
|---|---|
| Interactive tools: `sudo` / `ssh` / `vim` / `gdb` / REPLs | real TTY — password prompts, full-screen TUIs, Ctrl-C |
| Long tasks with process-startup overhead | shells persist: paths, history, env are kept |
| "Who made this shell do what, when?" | per-event chain, tamper-evident |

## Quick start

1. After install + restart, a pill **`>_ N 🔒`** appears bottom-right.
2. Click it → **＋** to add a shell, or `shell_open` one.
3. Panel: unlock, then type (input goes straight to the terminal); AI: `shell_run` to send.
4. The first tool use asks once; after that it just works.

## Audit: hash chain + optional lock

- Default `~/.dsh/agent-shell/audit-YYYY-MM-DD.jsonl` (per-day, auto-pruned); `output/` holds raw
  terminal recordings whose paths are recorded in the chain (`open` records carry `captureFile`).
- **No backwards compatibility since 0.2.2**: every record must carry a hash, or the chain is
  reported broken — clear old logs (`rm ~/.dsh/agent-shell/audit-*.jsonl`) and restart after
  upgrading.
- Immutable upgrade: `./install-deps.sh --audit-lock` (`chattr +a`, one-time root; after locking,
  no auto-prune — archive manually).

## Recent changes

### 0.3.0 — human⇄AI handover + vault/macros + steps/expect + sessions permanent by default

- **Idle auto-close is OFF by default now**: sessions are **permanent** unless you opt in — omitted
  or `-1`/`0` = never close; an explicit positive `idleMinutes` enables per-session reaping; the
  global `idleClose` switch (default off) only backstops sessions without an explicit value.
- **Human⇄AI handover**: `shell_manage action=release` (AI hands the shell back — its writes are
  refused, reads still work, sweeper won't touch it; the reply includes the exact
  `tmux -L <socket> attach -t <id>` command for the human) and `action=claim` (AI adopts a shell a
  human created on the same private socket — records ownership + starts output capture; claiming
  another conversation's shell needs explicit `override`). `shell_state` shows `⚠attached` and
  `[released]` markers. See the handover tutorial in the Chinese README (§ 人机双接管).
- **Dual-domain input (vault + macros)**: `{{v:key}}` secrets (human-entered via panel/CLI; the AI
  only ever sees key names — values never enter audit text or tool output, one-shot keys burn after
  a successful injection, and once a value has crossed the pane it stays masked as
  `[vault:{{v:key}}]` in that session's reads) and `{{m:name}}` macros (human+AI writable, **every
  write goes into the hash-chained audit** against prompt-injection smuggling; macros may embed
  `{{v:}}` but never other macros; multiline content rides a bracketed paste-buffer channel).
  The guard scans **expanded** text (a macro hiding `rm -rf /` is still refused) while refusals and
  audit only ever show the original. Honest boundary: `output/` capture is raw bytes — vault
  protects the AI/audit/display planes, **not local disk** (see SECURITY §10).
- **steps/expect (flagship)**: `shell_run { steps:[{send?, expect?, timeout?}] }` runs a whole
  interactive sequence in ONE call — mid-flight screens stay out of context; any timeout/guard
  refusal returns the scene and aborts. Interactive TTY round-trips collapse from N calls to 1.
- **Semantic reads**: `shell_read mode=summary` (cwd/git/fg/buffer/last-result + 3 tail lines),
  `mode=diff`, `ifChanged:true` (unchanged → one word), `search` gains `context`/`offset`.
- **Situation snapshot**: every `shell_state` row now carries `cwd=`; `withGit:true` adds branches.
- **Error codes**: guard refusals carry stable codes (`[code=guard:rm-root]`).
- **Control-channel exponential backoff** (5s→60s cap, reset on success) replaces the flat 60s freeze.
- **Audit chain latent bug fixed**: `canonicalize` treated `undefined` fields as `null` while
  `JSON.stringify` drops them → any record with an undefined field broke verification from that
  record on ("broken at #4" in tests). Canonicalization now matches serialization; regression-locked.
- **bench-runtime**: p50/p95 harness for hot paths with red lines (baseline: /screen≈12ms,
  /list≈9ms, capture≈10ms, POST /keys≈2.4ms).

### 0.2.3 — since 0.2.2

- **Tool surface slimmed 10 → 7**: `shell_wait` folded into `shell_read` (new `until` wait mode:
  `idle` / `fg:<cmd>` / `match:<regex>`); `shell_check` folded into `shell_run` / `shell_send`
  (new `dryrun` guard-preview flag); `shell_consent` folded into `shell_state` (grant state and
  scope are reported there, queryable even when fully denied). Tools: `shell_open / shell_run /
  shell_send / shell_read / shell_manage / shell_state / shell_audit`.
- **Idle auto-close**: settings `idleClose` (default on) + `idleCloseMinutes` (default 60, minutes
  everywhere); set per session at creation via `shell_open idleMinutes` (0 = never) and change it
  with `shell_manage action=idle minutes=N`; swept every 30s, closes + audits `reason=idle-timeout`.
  Surviving sessions are re-touched on `dsh` restart so a restart never instantly reaps them.
  ⚠ It really closes sessions (see risk #7 in the Chinese README).
- **Structured command results (A)**: `shell_run` wraps non-interactive commands with a safe
  exit-code capture and returns `✅/❌ exit N + elapsed + tail` (skipped automatically for
  multiline / heredoc / backgrounded / interactive programs like vim/ssh/sudo/python;
  `structured:false` sends verbatim). Failures are kept for 5 minutes per session and shown in
  `shell_state` as `last=…` (B).
- **Session snapshot / resurrection (C)**: a session's cwd/label/size/idle-timeout is auto-saved to
  `<auditDir>/snapshots.json` on open/rename/resize/idle/close (+ manual via
  `shell_manage action=snapshot`); `shell_open { from: <id> }` restores the scenario (explicit args
  win). Only the scenario is restored — process/memory state cannot be (tmux does not persist).
- **Audit export / offline verify (E)**: `shell_audit { export: true }` returns the raw JSONL
  (prevHash/hash included; ≤8000 lines per call); the shipped CLI `dsh-agent-shell verify-audit
  [dir]` re-verifies the chain offline (exit 0 = intact, 1 = broken).
- **Full-buffer search (F)**: `shell_read { search: <regex> }` greps the whole scrollback (up to
  historyLimit lines) and returns `L<line> <text>` matches; invalid regexes are REFUSED immediately.
- **Secret redaction (G, settings toggle)**: new `redactSecrets` setting (default on, hot-reload)
  masks secret-looking literals (`token=`/`password=`/`API_KEY=`/`Bearer …`/BEGIN PRIVATE KEY/
  embedded URLs/GitHub/AWS token shapes) in audit text, tool output and panel display; raw bytes
  still land untouched in `output/` capture files.
- **Params straight to the AI**: `shell_state` now ends with a `◈ 常用参数(JSON)` block
  (`maxSessions / sessionsUsed / idleClose / idleCloseMinutes / shell / cols / rows / historyLimit /
  guard / extendedKeys / requireConsent / watchdogPid / tmux / auditDir`) plus per-session `idle=Nm`.
- **"mine" ghost fix**: dead sessions lingering in the persisted owners table no longer break
  `session:"mine"` batch sends (`can't find pane`).
- **env probe fix**: `hasTmux` honors the host preset over the direct probe (sandboxed harnesses no
  longer report "no tmux" and kill the watchdog).
- **Audit chain hardening**: a chain-head readiness gate eliminates the cold-start/hot-reload race
  that sealed early records on `genesis` (real-world break at record #467); the verifier now tags
  that pattern as `cold-start-genesis` (benign) instead of "tampered"; historical benign breaks
  can be repaired with `scripts/repair-chain.mjs` from the source repo (npm packages do not ship
  `scripts/`; it only accepts the cold-start-genesis pattern and refuses everything else — `--apply`
  backs up first, re-chains, appends a `chain-repair` record, then re-verifies).
- **Startup performance**: clean-start `apply→ready` ≈ 135 → 57 ms, startup spawns 14 → 3
  (removed duplicate audit scans / prune, `$HOME` subprocess, redundant direct tmux probe; watchdog
  arming deferred until the first shell when nothing survived). Added `startup ready in Xms` log;
  `scripts/bench-startup.mjs` lives in the repo for perf regression (not in the npm package).
- **AI precision pack (0.2.3)**: ① `shell_run { waitFor }` conditional waiting (`match:<regex>` new
  output / `file:<path>` file appears / `port:<n>` local port opens, `waitTimeout` bail-out) — "start
  a service and wait until it's ready" in one call, no sleep-guessing; ② failure summary: errors
  are picked into the result head and `shell_state`'s `last=`; ③ `shell_run { retry:'last-failed' }`
  re-runs the session's last failed command (full text kept in the ledger; `retry:'last'` ignores
  success); ④ `shell_manage action=doctor` self-check: fg / idle seconds / buffer usage / capture
  status with actionable advice.
- **`until`/`waitFor match:` incremental semantics pinned (fixed during 0.2.3 live long-task
  verification)**: `match` only matches output that is **new after the wait/send** — leftovers on
  screen or the awaited word inside your own typed command echo no longer fake-succeed in 0.0s
  (`pure.diffSince` finds the old frame's tail as a line-aligned block, tolerating rewritten cursor
  lines and identical trailing prompts; `stripCommandEcho` removes the echoed command, wrapped lines
  and prompt prefixes included; 160 pure assertions + smoke/edge cases). `until` uses "wait start"
  as its baseline; `waitFor match` uses "before send" plus echo stripping.
- **Live long-task verification (0.2.3) + known behavior**: a 150-step × 1s streaming command ran
  fully; `until=match` hit only at the real completion (~80s); a 1-minute idle session was swept in
  76s (scan → `idle-timeout` close → snapshot); the day's audit chain fully sealed with
  `verify-audit` exit 0. Ergonomics: ① commands starting with `bash/sh/python…` are not
  exit-wrapped (interactive whitelist, conservative) — wait for long tasks with
  `waitFor`/`until`, not `shell_run`'s idle judgment (a `bash -c`/shell loop can sample as "idle");
  ② `shell_run`'s `lines` = visible screen + N scrollback lines, not "N lines only";
  ③ `waitFor match` baselines at send: for output that flashes within ~250ms use `file:`/`port:`.
- **Known limitation (updated)**: an OS/VM reboot (e.g. WSL2) loses all sessions — tmux does not
  persist sessions to disk; `dsh` restarts are unaffected (systemd user scope).

### 0.2.2

## Recent changes (0.2.2)

- One-command install (this file); `doctor` / `uninstall`.
- More settings: `sessionEnv` / `shellArgs` / `watchdogStrategy`+`GraceMs`+`RenewMs` /
  `panelPollMs` / `auditLockReminder`.
- Audit integrity: `shell_run` now recorded (was missing); every tool call emits `tool-call`;
  concurrent chain appends serialized (was breaking the chain); `shell_audit` `mine/*` selector
  fixed.
- Capability probing & degradation with plain-language promises.
- AI-facing messages point at the fix (unknown id → "use `shell_state` to list ids").
- Full history: [docs/CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md).

## Docs

| File | Contents |
|---|---|
| [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md) | usage, config, HTTP API, internals |
| [docs/SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md) | security model, audit boundary, limits |
| [docs/CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md) | version history |
| [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/更新记录.md) | full change log (root causes + verification) |
| [docs/PUBLISHING.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/PUBLISHING.md) | release process |

## License

MIT ([LICENSE](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE)).