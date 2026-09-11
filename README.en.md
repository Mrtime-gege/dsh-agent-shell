# dsh-agent-shell

> Persistent, conversation-decoupled multi-shell terminal panel for DeepSeek Harness — 9 model tools plus a draggable floating panel you can actually type into.

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

[中文（主文档）](./README.md) · **English**

> **This plugin was developed by AI.** Design, implementation and tests were all done by an AI
> (157 automated assertions plus real-machine verification, which found and fixed six real bugs) —
> but **no human security audit**. Factor that into your risk assessment.

## ⚠️ Read this first: it is a real shell, with no approval gate

**This is not a sandbox and not a restricted tool. Installing it hands a real machine's terminal to an AI.**

* **The model can run arbitrary commands.** The `shell_*` tools drive a real `bash` inside a real
  tmux session, **with your own user privileges** — read files, rewrite config, make network calls,
  install things, delete things; nothing stops it.
* **There is no approval prompt.** DSH ships an approval seam (`dsh-user-approval`), but in
  `danger-full-access` — **the only mode this plugin can work in** — the platform sets its policy to
  `never` (deterministic reject, no UI). This plugin does **not** integrate that seam, so a command
  the model runs is never offered to you for allow/reject. See [SECURITY.md](./SECURITY.md).
* **The only defence is a heuristic guard** (`guardDangerousCommands`, on by default): ten regexes
  matching `rm -rf /`, `mkfs`, `dd of=/dev/*`, `sudo` and friends. **Trivially bypassed** through
  concatenation, variables or script files; it also **false-positives** on innocent text. It is a
  speed bump, **not a protection**.
* **The HTTP endpoints are unauthenticated**, and the panel talks over exactly that channel.
* The `无审批` tag on the panel is **a truthful notice, not a switch**.

Use it on your own dev box and accept that the model may run anything there. Do **not** use it on
machines holding irreplaceable data, in production, or anywhere prompt injection is plausible —
or run it inside a container/VM to bound the blast radius.

## What it is

A private tmux server (`-L dsh-agent`) holds several named sessions; the host half registers `shell_*`
tools and exposes same-origin HTTP; the client half mounts a floating panel into the `shell.overlay`
slot. The three are decoupled, so **shells do not belong to any conversation** — new chats, session
switches, hot reloads and quick restarts keep them alive, and the panel and the model drive the same
shells.

Unlike the built-in line-oriented command tool (each call runs in a fresh non-interactive process),
this plugin keeps a real interactive TTY — so `sudo` password prompts, `ssh`, `vim`, `python` REPLs
and `Ctrl-C` behave the way they do in a terminal you are sitting at.

## Requirements

| Item | Version / note |
|---|---|
| DSH | `0.1.2-rc.1` line |
| Peers | `@deepseek-ai/cordis` ^4.0.2, `dsh-tools` ^0.1.2-rc.1, `schemastery` ^3.18.0, `react` ^18.2.0 |
| Node / tmux / OS | ≥ 20 / 3.x / Linux or macOS (WSL works) |
| Session sandbox | **`danger-full-access` is required** — restricted modes cannot share the tmux server across calls |
| Browser | no extra deps: hand-written JS + inline SVG, no build step |

> Peer gotcha: on npm, `@deepseek-ai/dsh-tools`'s `latest` still points at a very old `0.0.1-rc.1`;
> check `dist-tags`, not `npm view … version`.

## Install

```sh
dsh plugin --profile web add dsh-agent-shell    # or file:/path/to/dsh-agent-shell
```

`dsh plugin add` reads this package's `dsh.bundle.patch` and writes the name into
`dsh.profile.bundles` for you. Restart `dsh web` once.

> ⚠️ Do **not** also insert a patch row by hand: the bundled patch already inserts `id: agent-shell`,
> and the id may only appear once — a duplicate makes `dsh web` fail at startup with
> `duplicate loader entry id: agent-shell`.

## Panel & tools

Panel: a lock (input is locked by default and re-locks on focus loss), a true no-buffer input model
(every keystroke goes straight to the shell; CJK IMEs are supported), drag/8-handle resize with
persistent geometry, a picker for switching many shells, `⤒` to push any residual text, and history
view (default 200 lines, "more" doubles up to 5000).

| Tool | Parameters (★ = required) | Purpose |
|---|---|---|
| `shell_open` | `name?` `cols?` `rows?` `cwd?` | create a shell, return its first screen (`cwd` that doesn't exist errors out instead of silently landing elsewhere) |
| `shell_send` | ★`session` `text?` `preKeys?` `keys?` `confirm?` `settleMs?` | type like a human: `preKeys` → `text` → `keys` |
| `shell_read` / `shell_history` | ★`session` (`lines?`) | visible screen / scrollback |
| `shell_list` | — | list shells with metrics |
| `shell_resize` | ★`session` ★`cols` ★`rows` | resize (clamped to 20–1000 × 5–500) |
| `shell_rename` | ★`session` ★`newName` | rename (sanitized, `dsh-` prefix added) |
| `shell_close` | ★`session` | close (idempotent: already-gone is success with `closed:false`) |
| `shell_diagnose` | — | server / watchdog / cwd / **approval status** |

Field names differ on purpose: only `shell_open` takes `name`; every other tool takes **`session`**
(required in the schema). HTTP request bodies use `name`.

```jsonc
shell_send { "session": "dsh-edit", "preKeys": ["i"], "text": "print('hi')", "keys": ["Escape"] }
```

## HTTP endpoints

Same-origin, `127.0.0.1`, **unauthenticated**: `GET /plugins/shell/{list, screen, diagnose}`,
`POST /plugins/shell/{keys, new, kill, resize, rename}`.

## Known limits

* **No approval gate** — the model's commands are never offered for allow/reject (see above).
* **The guard is a heuristic speed bump, not a sandbox** — false positives and trivially bypassable.
* **`danger-full-access` required**; restricted modes fail with `error connecting to /tmp/tmux-1000/...`.
* Host-half code changes need a `dsh web` restart; client-half changes need a page refresh.
* Text rendering, not terminal emulation (`capture-pane -p` drops colour/attributes).
* Only shows shells this plugin created (it never touches your own `tmux`).
* If the host is down for more than ~6 seconds, the orphan watchdog collects all shells.

## More detail

| File | Contents |
|---|---|
| [README.md](./README.md) | 中文首页（本文档的中文主版）；含 `更新与修复记录`（每次修了什么、根因、怎么验证） |
| [docs/使用细节.md](./docs/使用细节.md) | 配置项全表、面板/输入法细节、工具与 HTTP 参数（中文） |
| [docs/设计与实现.md](./docs/设计与实现.md) | 解耦设计、生命周期与孤儿治理、踩坑注记、测试与发布（中文） |
| [SECURITY.md](./SECURITY.md) | full security model: why there is no approval, unauthenticated HTTP, guard boundaries |
| [PUBLISHING.md](./PUBLISHING.md) | release how-to (npm + GitHub, provenance, rollback; 中文) |
| [CHANGELOG.md](./CHANGELOG.md) | per-version changes |

## License

[MIT](./LICENSE) © Mrtime-gege
