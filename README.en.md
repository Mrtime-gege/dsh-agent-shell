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
  `consent` / `panel-lock` / `env-degraded` / `capture` all in `audit-YYYY-MM-DD.jsonl`, each
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