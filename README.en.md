# dsh-agent-shell

> Persistent multi-shell terminal for DeepSeek Harness: 7 model tools + a draggable, type-able floating panel.

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

[**English**](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/README.en.md) · [**中文**](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/README.md)

## ⚠️ Version advisory (2026-09-18): `0.3.0` is unsafe — fixed in `0.3.1` (published)

**Do not use `0.3.0`.** It ships four confirmed issues: (1) vault secret values leaked
in cleartext through the `shell_read` `history`/`screen`/`since`/`summary` exits; (2)
value masking was global string replacement — an inclusion oracle enabling char-by-char
secret guessing; (3) one-shot "burn on success" keyed off the send return value (a
failed-but-delivered send spared the key; duplicate refs injected twice); (4) concurrent
`shell_open` races could drop ownership records from `sessions.json`. **All four are
fixed in `0.3.1` (2026-09-18, published to npm)** with regression locks; if `latest`
is still mid-propagation, install explicitly: `npx -y dsh-agent-shell@0.3.1 install`.
0.3.1 additionally introduces an AI-side bare-reference rule (`{{v:}}` may only be sent
as the entire input — a stdin password prompt; command-line/pipe forms are refused to
kill transform-based exfiltration; see SECURITY §10). If you stayed on 0.3.0, stop using
vault / `{{v:}}` references until you upgrade. npm freezes READMEs per version; this
advisory lives in the GitHub repo and supersedes the published one.


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
npx -y dsh-agent-shell install [--profile web]   # current 0.3.1 (⚠️ never use 0.3.0 — see advisory)
```

Registers the dependency and bundle into the profile → installs via pnpm/npm → checks tmux →
tells you to restart `dsh web`. `--dry-run` previews; `doctor` checks tmux / install state / data
dir; `uninstall` removes. npm releases are published by GitHub Actions on `v*` tags (CLI ships
from 0.2.2).

## What it is

- Persistent shells on a private tmux server — survive closing the page, switching chats,
  hot reload and DSH restarts (watchdog claims/orphans them).
- **7 model tools**: `shell_open / shell_run / shell_send / shell_read / shell_wait /
  shell_check / shell_manage / shell_state / shell_audit / shell_consent`, addressed by **stable
  id** (the user-facing name is a renameable label).
- The panel is a real terminal: sudo password prompts, full-screen vim, REPLs, completion.
- **Audit: one hash chain for everything** — `tool-call` / `input` / `open` / `close` / `rename` /
  `consent` / `panel-lock` / `env-degraded` / `capture` / `idle` (idle-close) / `config`
  (setting changes) / `claim` (take-over & hand-back) / `macro` (every macro write, full text) /
  `vault` (secret consumption, key names only) all in `audit-YYYY-MM-DD.jsonl`, each
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

### 0.3.1 (2026-09-18) — vault security rework (fixes all four 0.3.0 issues; do not use 0.3.0)

- **Vault masking reworked to line identity**: only the lines the injection itself
  produced get masked (value occupying the line / ending the line / a line containing the
  full expanded command). No more collateral hits, and the char-by-char growth oracle
  ("echo a guess, watch whether it masks") is dead — regression-locked as pure functions
  plus live locks.
- **One-shot burns at send-attempt time**: the key is marked spent synchronously after the
  guard passes, before bytes hit the pipe — a "send errored but actually delivered" case
  can no longer spare it; guard-refused commands never burn the key; referencing the same
  one-shot key twice in one send (including a second copy hidden inside a macro) is now
  refused wholesale at the expansion layer.
- **Four read exits rewired through masking**: `shell_read`
  `history`/`screen`/`since`/`summary` used to return vault values in cleartext (a latent
  0.2.3-era gap the new vault feature turned into a guaranteed leak) — fixed, one
  regression lock per exit.
- **Ownership-table race fixed**: `sessions.json` writes serialized (concurrent opens
  could land out of order and drop entries, losing "who owns this shell" across
  restarts), silent write failures now log a warning, and the idle-sweeper log reports
  the actual per-session timeout.
- **Panel**: third ⚙ tab renamed to **引用库 (Refs)** with `{{v: 秘密键}}` / `{{m: 宏命令}}`
  sub-tabs; data re-fetches on every tab entry (externally burned keys no longer linger);
  the `+N lines` badge was removed from the header (it wrapped and stretched the title
  bar; the dot pulse still signals new output).
- **Docs**: bash-history exposure for command-line injection (use the `sudo -S`/`read -s`
  stdin form for real secrets) + cleanup guidance; "a hash of the value is also a leak"
  (truncated sha256 dictionary-cracks weak values; the plugin itself never hashes).

> This README keeps only the latest batch. 0.3.0 (human⇄AI handover, vault/macros,
> steps/expect, permanent-by-default sessions), 0.2.3 (tools 10→7, AI precision kit,
> panel redo) and earlier: see [docs/CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md)
> and [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/更新记录.md).

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