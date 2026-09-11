# dsh-agent-shell

> Persistent, conversation-decoupled multi-shell terminal panel for DeepSeek Harness —
> 9 model tools plus a draggable floating panel you can actually type into.

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![tmux](https://img.shields.io/badge/tmux-3.x-blue.svg)](https://github.com/tmux/tmux)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

[中文（主文档）](./README.md) · **English**

## What it is

A DSH plugin that owns a **private tmux server** (`-L dsh-agent`) with several named sessions on
top of it. The host half registers `shell_*` tools for the model and exposes same-origin HTTP;
the client half mounts a floating panel into the `shell.overlay` slot.

The point is **decoupling**: your shells do not belong to a conversation. Start a long build,
close the chat, open a new one — the shell is still there, and the agent in *any* conversation
drives the same shells you see in the panel.

| Axis | Coupled design | This plugin |
|---|---|---|
| Lifetime | dynamic plugin inside one session | a **profile bundle on the Host plane**; tmux lives as long as the harness process |
| UI scope | session-scoped slot | **`shell.overlay`** (`scope: root`) — visible with or without a conversation |
| Data channel | `harness.handle` / `host.call` bound to one plugin run | **same-origin HTTP** via the host web server |

Unlike the built-in line-oriented command tool, which runs each call in a fresh non-interactive
process, this plugin keeps a real interactive TTY — so `sudo` password prompts, `ssh`, `vim`,
`python` REPLs and `Ctrl-C` all behave the way they do in a terminal you are sitting at.

## Requirements

| Item | Version |
|---|---|
| DSH | `0.1.2-rc.1` line |
| `@deepseek-ai/cordis` (peer) | `^4.0.2` |
| `@deepseek-ai/dsh-tools` (peer) | `^0.1.2-rc.1` |
| `@deepseek-ai/schemastery` (peer) | `^3.18.0` |
| `react` (peer, provided by the host web app) | `^18.2.0` |
| Node | ≥ 20 |
| tmux | 3.x (developed and verified on 3.6b) |
| OS | Linux or macOS (WSL works) — a working `tmux` is required |
| Session sandbox | **`danger-full-access` is required** — see [Security](#security) |

## Install

```sh
dsh plugin --profile web add dsh-agent-shell
```

Because the package declares `./cordis.patch.yml` under `dsh.bundle`, this inserts the plugin row
for you and writes the package name into `dsh.profile.bundles`. **Do not also add an `insert` row
by hand** — the id `agent-shell` may only appear once in the composition, and a duplicate makes
`dsh web` fail at startup with `duplicate loader entry id: agent-shell`.

Then **restart `dsh web`** once (client scanning happens at host startup).

Configuration lives on the `id: agent-shell` row and is fully optional — see the
[Chinese README](./README.md#配置项) for the annotated defaults (`socket`, `httpBase`, `shell`,
`cols`/`rows`, `historyLimit`, `maxSessions`, `defaultCwd`, `watchdog`,
`guardDangerousCommands`, …).

## Use it

**Panel (human).** Click the `>_ N 🔒` pill in the bottom-right corner. The panel is draggable and
resizable (8 handles, geometry persisted in `localStorage`). Input is **locked by default**;
click the lock to type, and it re-locks automatically when focus leaves the panel. There is **no
local input buffer** — every keystroke goes straight to the shell, so completion, history, inline
cursor motion and `Ctrl-R` are handled by the shell's own readline. CJK input methods are
supported (composition state is tracked explicitly because browsers disagree about
`isComposing`). Switching shells uses a picker with per-shell status dots, size, foreground
command and buffer usage — jumping from shell 1 to shell 50 is two clicks.

**Tools (model).**

| Tool | Parameters (★ = required) | Purpose |
|---|---|---|
| `shell_open` | `name?` `cols?` `rows?` `cwd?` | create a background shell, return its first screen |
| `shell_send` | ★`session` `text?` `preKeys?` `keys?` `confirm?` `settleMs?` | type like a human: `preKeys` → `text` → `keys` in one call |
| `shell_read` | ★`session` | read the visible screen |
| `shell_history` | ★`session` `lines?` | read the scrollback |
| `shell_list` | — | list shells with metrics |
| `shell_resize` | ★`session` ★`cols` ★`rows` | resize a shell |
| `shell_rename` | ★`session` ★`newName` | rename a shell (name is sanitized, `dsh-` prefix added) |
| `shell_close` | ★`session` | close a shell |
| `shell_diagnose` | — | server / watchdog / cwd status |

Note the field names: only `shell_open` takes `name` (an optional label at creation time); every
other tool takes **`session`**, and it is `required` in the schema — passing `name` there fails
argument validation with `ToolArgsError: missing required property "session"`. The HTTP API below,
by contrast, uses `name` in every request body.

```jsonc
shell_send { "session": "dsh-edit", "preKeys": ["i"], "text": "print('hi')", "keys": ["Escape"] }
```

## Lifetime and orphan handling

The tmux server setsids and reparents itself, so the harness's managed-process cleanup cannot
reach it. This plugin therefore arms a **detached watchdog** (`setsid -f`) that polls the harness
pid and runs `kill-server` once the harness is gone — the only mechanism that survives
`kill -9` or a crash. On startup the watchdog is **adopted** (pid file records
`"<watchdog pid> <harness pid>"`), so hot reloads keep every shell. Unload is deliberately a
no-op: dispose runs on every config reload, and killing the server there would throw away your
shells on every edit.

## Security

Read this before using it. **This plugin is intentionally a tool that lets an agent (and any
local process that can reach the endpoint) do whatever you can do on your machine.**

* **The HTTP endpoints have no separate authentication.** `/plugins/shell/*` is served by the
  host web server on `127.0.0.1` and is *not* behind the SPA's login gate. Anything that can
  reach that port — another local user, a same-origin page, a browser you left open — can send
  keystrokes to your shells. Do not reverse-proxy it; set `exposeHttp: false` when you don't
  need it.
* **`guardDangerousCommands` is a heuristic speed bump, not a sandbox.** It pattern-matches the
  text you are about to send (`rm -rf /`, `mkfs`, `dd of=/dev/*`, `--no-preserve-root`, …). It is
  trivially bypassable through concatenation, variables or script files, and it produces false
  positives (e.g. a `[sudo] password for …` prompt echo). Use a real sandbox for real isolation.
* **`danger-full-access` is required.** Under restricted modes (bwrap, private PID namespace)
  each call gets its own sandbox and the tmux server cannot be shared across calls; the failure
  looks like `error connecting to /tmp/tmux-1000/... (No such file or directory)`. Making it work
  means opening the sandbox — weigh that yourself.
* **Session isolation:** only the private socket is used, so your own `tmux` sessions are
  untouched. The flip side: this plugin also does not show the tmux sessions you started by hand.
* **Secrets pass through tool arguments.** Typing a `sudo` password with `shell_send` puts it in
  the conversation log. Prefer keys or passwordless `sudo` for anything sensitive.

## Versioning and releases

Semver, currently `0.x` — minor releases may contain breaking changes, patches are fixes.
Every release must have a matching `CHANGELOG.md` section; `npm run release:check` enforces
version ⟷ CHANGELOG ⟷ the version stamp shown in the panel. The full release procedure (npm +
GitHub, provenance, rollback) is in [PUBLISHING.md](./PUBLISHING.md) (Chinese).

## License

[MIT](./LICENSE) © Mrtime-gege
