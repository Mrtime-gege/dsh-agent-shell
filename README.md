# dsh-agent-shell

> 给 DeepSeek Harness 的持久化多 shell 终端：10 个模型工具 + 右下角一个可拖动、可直接打字的悬浮面板。

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

**中文**（本文件） · [**English**](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/README.en.md)

## ⚠️ 风险，先读清楚再决定装不装

**这工具能把你的机器交给 AI。** 它不是玩具，也不是"受限执行环境"。

1. **由 AI 开发，无人审计。** 设计与实现全部出自 AI，配套一套自动化测试与真机验证，但**没有任何人做过安全审计**。
2. **授权 = 任意命令。** 一个对话被授权后，它的 AI 就能以**你自己的用户权限**：读文件、改配置、发网络请求、装软件、**删东西** —— 本插件**没有任何审批防护**，不会逐条问你。拒绝授权它就真的执行不了；想彻底关掉门需显式 `requireConsent: false`（那等于放弃防线）。
3. **不负责后果。** 它只是"便捷调用 + 如实记录"，不是沙箱：误删、被提示词注入带偏执行了危险命令、凭据被读到终端里，后果由你自己承担。
4. **唯一防线只是启发式护栏。** `guardDangerousCommands` 默认开，做关键词匹配（`rm -rf /`、`mkfs`、`dd of=/dev/*` 等）；**可被变量/脚本/拼接轻易绕过，也会误报**。它是减速带，不是防护。
5. **审计 = "可检测"，不是"不可篡改"（默认）**：哈希链能发现"删过/改过/调过序"，但**同权限的 AI 本就能改审计文件**（它能拿到 shell）；要升级到不可删/改需 `chattr +a`（见[审计](#审计哈希链--可选加锁)）。
6. **ssh/远程只有"录像级"审计**：记录的是**进出隧道的键与屏**，不是远端机器上实际执行了什么。
7. **不要放进生产/多用户/有不可替代数据的机器**；内部测试、可重建的环境、你想清楚后果的自用机器才合适。重要数据先备份。

> 别在终端里长期输入真凭据——面板逐键与留痕是**如实记录**的（密码提示场景会自动脱敏为 `[redacted:password]`，但其它明文输出不保证）。

## 一条命令安装

先决条件：**Linux**（含 WSL2/容器）、Node ≥ 20、运行的 DSH（0.1.5+）。然后：

```sh
npx -y dsh-agent-shell install [--profile web]
```

会依次：登记进 profile 的依赖与 bundle → 按 pnpm/npm 装依赖 → 检查 tmux → 提示重启 `dsh web`。
配套：`--dry-run` 只预览；`doctor` 体检（tmux / 装没装 / 数据目录）；`uninstall` 反向移除；`--profile` 指定其它 profile。
> 版本节奏：npm 发布由推 `v*` tag 的 GitHub Actions 自动完成（0.2.2 起带 CLI；更早版本没有 bin）。

## 它是什么

- 私有 tmux 服务端持有多个**持久 shell**：关页面、换对话、热重载、重启 DSH 都不丢（看门狗赛后收养/回收）。
- **10 个模型工具**：`shell_open / shell_run / shell_send / shell_read / shell_wait / shell_check / shell_manage / shell_state / shell_audit / shell_consent`；寻址用**稳定 id**（`dsh-…`，名字只是可改的 label）。
- 面板（右下角胶囊）：真终端 —— `sudo` 密码提示、`vim` 全屏、REPL、补全、历史全都通，输入即进终端。
- **审计一条链管全部**：`tool-call`（调了哪些工具）/`input`（送进终端的键）/`open`/`close`/`rename`/`consent`/`panel-lock`/`env-degraded`/`capture` 全在 `audit-YYYY-MM-DD.jsonl`，逐事件即时封链（写入算一次 SHA-256），删一条/改一字节/调顺序 → 断链即报警。

## 安全边界（更细的"能挡什么、挡不住什么"）

- 确认门一次过后**不再问**：防手滑与静默启动，不防蓄意 agent —— **原生 bash 能绕过本插件做它想做的一切**（包括改授权文件），任何"只在插件通道内生效"的防护都只是对这条通道的礼貌。
- 面板状态行的「无审批」是如实告知，不是开关。
- **人机互斥**：解锁面板 = 人在操作，AI 对该 shell 的一切修改（发送/改名/改尺寸/关闭）让路，只读不受影响；解锁/上锁记审计。
- **能力降级如实说**：无 systemd → 会话不随`dsh`重启存活；无 `/proc` → 嵌套 tmux 忙闲判定退化；每句都是人话，`shell_state`/面板 ⓘ/`/diagnose` 可查。
- 平台：**仅 Linux**；Windows 请用 WSL2，macOS 不支持。
- 完全安全模型见 [docs/SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md)。

## 什么时候值得用它

| 场景 | 为什么 |
|---|---|
| `sudo` / `ssh` / `vim` / `gdb` / REPL 等**交互式工具** | 真 TTY：密码提示、全屏 TUI、Ctrl-C 都通 |
| **反复起进程开销大的长任务** | shell 常驻：路径、历史、环境变量一直在 |
| 想查"谁在什么时候让 shell 干了什么" | 审计链逐事件封链、断链即报警 |

## 快速上手

1. 装好重启后，右下角出现胶囊 **`>_ N 🔒`**。
2. 点胶囊 → **＋** 新建 shell；或 `shell_open` 开一个。
3. 面板：锁图标解锁 → 直接打字；AI：`shell_run` 发命令 → `shell_state` 看会话。
4. 首次用工具会问你一次授权；之后正常使用。

## 审计：哈希链 + 可选加锁

- 默认 `~/.dsh/agent-shell/audit-YYYY-MM-DD.jsonl`（按天，保留期自动清理）；`output/` 是终端录像（原始字节，链上 `open` 记录带它的路径）。
- **不向前兼容（0.2.2 起）**：每条必须带哈希，缺一条即判断链；升级清空旧日志再重启。
- 升级为"不可篡改"：`./install-deps.sh --audit-lock`（`chattr +a`，需一次性 root；加锁后无法自动清理、需人工归档）。
- 详细用法与实现见 [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md)。

## 最近更新（0.2.2）

- **一条命令安装**：`npx -y dsh-agent-shell install`（本文件上方）。
- **设置可调参数**：`sessionEnv` / `shellArgs` / `watchdogStrategy`+`GraceMs`+`RenewMs` / `panelPollMs` / `auditLockReminder` 等，设置卡片标注"立即生效 / 需重启"。
- **审计完整性**：`shell_run` 也进审计；每次工具调用记 `tool-call`；并发封链串行化（修断链）；`shell_audit` 的 `mine/*` 选择器修复。
- **能力探测降级**：无 systemd/无 `/proc` 自动降级并人话上报。
- **AI 提示优化**：报错定位参数/会话 id（含"用 `shell_state` 查"）。
- 完整历史：[docs/CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md)。

## 详细文档

| 文档 | 内容 |
|---|---|
| [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md) | 面板/工具用法、配置项、HTTP API、工作原理 |
| [docs/SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md) | 安全模型、审计边界、已知限制 |
| [docs/CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md) | 版本变化 |
| [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/更新记录.md) | 完整改动记录（根因 + 验证） |
| [docs/设计与实现.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/设计与实现.md) | 内部结构 |
| [docs/PUBLISHING.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/PUBLISHING.md) | 发布流程 |

## 许可证

MIT（见 [LICENSE](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE)）。