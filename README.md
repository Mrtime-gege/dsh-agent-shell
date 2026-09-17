# dsh-agent-shell

> 给 DeepSeek Harness 的持久化多 shell 终端：7 个模型工具 + 右下角一个可拖动、可直接打字的悬浮面板。

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

**中文**（本文件） · [**English**](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/README.en.md)

## ⚠️ 版本公告（2026-09-18）：`0.3.0` 不可用，修复版 `0.3.1` 已发布

**`0.3.0` 不要使用**——它带四个已确认的问题（0.3.1 全部修复并有回归锁）：

1. **vault 秘密值泄露**：`shell_read` 的 `history` / `screen` / `since` / `summary` 四个读屏出口绕过打码层，把秘密值明文吐给 AI（用 0.3.0 的 vault 功能必中）。
2. **打码机制可被逐字符猜密**：值遮蔽是全局字符串替换，构成"包含预言机"——发 `echo 猜串` 观察是否被遮即可增长猜出秘密；还会连坐误伤无关文本。
3. **oneShot"注入即焚"可被绕过**：烧键绑在发送返回值上，"报错但字节已进管道"的形态让键幸存可反复注入；同一条命令重复引用还能一次拿双份。
4. **并发开壳丢归属记录**：`sessions.json` 落盘竞态会丢条目，dsh 重启后"这个壳是谁开的"记录缺失。

**`0.3.1`（2026-09-18）已发布到 npm**：正常安装即得（若 `latest` 尚在注册表传播窗口内，可显式 `npx -y dsh-agent-shell@0.3.1 install`）。已装 0.3.0 的直接重装升级；升级前**先不要用 vault / `{{v:}}` 引用**（其余功能不受这四条影响）。0.3.1 同时新增 **AI 侧裸引用规则**（`{{v:}}` 只能整条喂密码提示，命令行/管道形态一律拒绝——防"转换外泄"，见 SECURITY §10）。npm 页面 README 随版本冻结，本公告以 GitHub 仓库为准。

## ⚠️ 风险，先读清楚再决定装不装

**这工具能把你的机器交给 AI。** 它不是玩具，也不是"受限执行环境"。

1. **由 AI 开发，无人审计。** 设计与实现全部出自 AI，配套一套自动化测试与真机验证，但**没有任何人做过安全审计**。
2. **授权 = 任意命令。** 一个对话被授权后，它的 AI 就能以**你自己的用户权限**：读文件、改配置、发网络请求、装软件、**删东西** —— 本插件**没有任何审批防护**，不会逐条问你。拒绝授权它就真的执行不了；想彻底关掉门需显式 `requireConsent: false`（那等于放弃防线）。
3. **不负责后果。** 它只是"便捷调用 + 如实记录"，不是沙箱：误删、被提示词注入带偏执行了危险命令、凭据被读到终端里，后果由你自己承担。
4. **唯一防线只是启发式护栏。** `guardDangerousCommands` 默认开，做关键词匹配（`rm -rf /`、`mkfs`、`dd of=/dev/*` 等）；**可被变量/脚本/拼接轻易绕过，也会误报**。它是减速带，不是防护。
5. **审计 = "可检测"，不是"不可篡改"（默认）**：哈希链能发现"删过/改过/调过序"，但**同权限的 AI 本就能改审计文件**（它能拿到 shell）；要升级到不可删/改需 `chattr +a`（见[审计](#审计哈希链--可选加锁)）。
6. **ssh/远程只有"录像级"审计**：记录的是**进出隧道的键与屏**，不是远端机器上实际执行了什么。
7. **闲置自动关闭（0.3.0 起默认关 = 会话永久保留）**：默认**不会**有任何会话被自动回收。只有显式启用才会关——单个会话 `shell_open idleMinutes=30`（正数分钟）或打开全局开关 `idleClose`（给未指定时长的会话兜底 `idleCloseMinutes`）；`0`/`-1`/不指定 = 永不自动关闭。启用后的判定：连续无**输入或运行**（AI 工具与面板输入含被拦企图都算活动；只读屏/查询不算，否则面板开着永不关），到点关闭并记审计 `reason=idle-timeout`。
8. **整机重启会丢会话**：`dsh` 自身重启会话存活（systemd 用户 scope）；但**整机/虚拟机重启**（如 WSL2 VM 休眠/重启）会连 tmux 一起带走——tmux 会话不落盘，属于平台层限制。重要工作先落盘文件。
9. **不要放进生产/多用户/有不可替代数据的机器**；内部测试、可重建的环境、你想清楚后果的自用机器才合适。重要数据先备份。

> 别在终端里长期输入真凭据——面板逐键与留痕是**如实记录**的（密码提示场景会自动脱敏为 `[redacted:password]`，但其它明文输出不保证）。

## 一条命令安装

先决条件：**Linux**（含 WSL2/容器）、Node ≥ 20、运行的 DSH（0.1.5+）。然后：

```sh
npx -y dsh-agent-shell install [--profile web]     # 当前 0.3.1（⚠️ 勿用 0.3.0，见顶部版本公告）
```

会依次：登记进 profile 的依赖与 bundle → 按 pnpm/npm 装依赖 → 检查 tmux → 提示重启 `dsh web`。
配套：`--dry-run` 只预览；`doctor` 体检（tmux / 装没装 / 数据目录）；`uninstall` 反向移除；`--profile` 指定其它 profile。
> 版本节奏：npm 发布由推 `v*` tag 的 GitHub Actions 自动完成（0.2.2 起带 CLI；更早版本没有 bin）。

## 它是什么

- 私有 tmux 服务端持有多个**持久 shell**：关页面、换对话、热重载、重启 DSH 都不丢（看门狗赛后收养/回收）。
- **7 个模型工具**（0.2.3 精简）：`shell_open / shell_run / shell_send / shell_read / shell_manage / shell_state / shell_audit`；等待并入了 `shell_read`（传 `until`），护栏预演并入了 `shell_run`/`shell_send`（传 `dryrun`），授权状态在 `shell_state` 里一并汇报；寻址用**稳定 id**（`dsh-…`，名字只是可改的 label）。
- 面板（右下角胶囊）：真终端 —— `sudo` 密码提示、`vim` 全屏、REPL、补全、历史全都通，输入即进终端。
- **审计一条链管全部**：`tool-call`（调了哪些工具）/`input`（送进终端的键）/`open`/`close`/`rename`/`consent`/`panel-lock`/`env-degraded`/`capture`/`idle`（闲置关闭）/`config`（设置变更）/`claim`（接管与交还）/`macro`（宏写入，全文入链）/`vault`（秘密消耗，只记键名） 全在 `audit-YYYY-MM-DD.jsonl`，逐事件即时封链（写入算一次 SHA-256），删一条/改一字节/调顺序 → 断链即报警。

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

## 人机双接管（0.3.0）：AI 干一半人来接，人干一半 AI 来接

AI 的终端就是普通 tmux 会话（挂在插件的**私有 socket** 上），你随时可以走进去；你自己在同一 socket 上开的终端，也能让 AI 接管。socket 名与会话 id 用 `shell_state` 查（`server: running (socket -L dsh-agent)` 那行）。

**① 人接管 AI 的壳（AI 干一半 → 人接手）**

```sh
tmux -L dsh-agent list-sessions            # 看看都有哪些壳
tmux -L dsh-agent attach -t dsh-ab12cd     # 直接走进去打字（就是普通 tmux）
# 退出但让会话继续跑：Ctrl-b 然后按 d（detach）
```

你 attach 期间 AI 仍可读写（`shell_state` 里会显示 `⚠有人已attach`，AI 知情但不停工）。想让 AI **彻底放手**：让它执行
`shell_manage action=release session=dsh-ab12cd` —— 之后 AI 的写操作一律被拒（读不受影响、闲置不回收、不出现在 AI 的 `mine` 里），现场完全归你。

**② AI 接管人建的壳（人干一半 → AI 接手）**

```sh
tmux -L dsh-agent new-session -s mywork    # 关键：用插件的私有 socket（-L dsh-agent）
```

> ⚠ 建会话**务必带 `-s 名字`**：不带名字时 tmux 会分配纯数字会话名，而插件按设计过滤纯数字名
> （它们与 tmux 给 control 客户端自动建的会话无法区分）——数字名会话在 `shell_state`/面板里不可见。

然后对 AI 说「接管 mywork」。AI 执行 `shell_manage action=claim session=mywork`：记归属、开始输出留痕（此前没有）、之后照常 `shell_run`/`shell_read` 驱动。干完想还给人：AI `release`，你再 attach 回去。
（别人对话名下的壳，AI 不能随手 claim —— 需要你明确同意，AI 带 `override:true` 才行。）

**③ 秘密不过 AI 手（vault，配合双域引用）**

面板 ⚙ 菜单 →「引用库」页签录入键值；或 CLI（人这一侧）：

```sh
dsh-agent-shell vault set sudo-pw '你的密码' --one-shot    # 一次性：注入成功即焚
dsh-agent-shell vault list                                  # AI 也能 list（只见键名，永远不见值）
```

AI 端只写引用，例如过 sudo 密码提示：

```json
{ "session": "dsh-ab12cd", "steps": [
  { "send": "sudo -S whoami", "expect": "match:[Pp]assword" },
  { "send": "{{v:sudo-pw}}",  "expect": "idle" } ] }
```

值不进 AI 上下文、不进审计文本、不上工具输出。打码按**行身份**：只遮注入所在的行（注入命令的回显行、值独占/结尾的行），无关行不误伤也不给"猜一位遮一位"的预言机留信号（0.3.1，详见 SECURITY）；oneShot 的落刀在**送出的那一刻**（护栏通过后、进管道前）——"发送报错但其实已送达"骗不过一次性。

> **AI 侧引用规则（0.3.1）**：AI 直接写 `{{v:}}` 时，整条 `send` 必须**只有这一个裸引用**（如上例喂 sudo 密码提示）。`echo {{v:pw}}`、`printf %s {{v:pw}} | base64`、`A={{v:pw}}B` 这类"把值嵌进命令"的形态**一律拒绝**——因为值一旦进入 AI 可加工的管线，任何变换输出（base64/rev/od）都能绕过打码，实测 `| base64` 就能把一次性键还原（`oneShot` 只烧第一次，救不了它）。**把秘密喂给程序的 stdin 提示是唯一合规路径。** 人从面板「引用库」旁亲自输入、或经宏闭环（`{{m:bastion}}` 内部嵌 `{{v:}}`，宏文本全量入封链）不受此限。
>
> **诚实边界**：`output/` 留痕是 tmux 原始字节流，值进过 pane 就在里面——vault 防的是 AI 与审计/显示面的**顺手泄露**，不防本机磁盘，也不防"同时控制字节与提交时序"的主动多步拼接提取（如先 `rev <<< ` 再裸注入）。**要防的就是那个不可信的 AI 本身**，就别把重要凭据放进它能引用到的会话——这是这类工具的统一边界，不是 vault 的实现缺陷。

**④ 宏（可复用命令片段，人和 AI 都能写）**

```sh
dsh-agent-shell macros set deploy 'cd /srv/app && git pull && make restart'   # CLI
```

或在面板「引用库」里写，或让 AI `shell_manage action=macro-set`。之后任何一方发 `{{m:deploy}}` 即展开执行；宏内容可嵌 `{{v:键}}`（发送时才展开，值不落脚本）。**所有宏写入全量进审计封链**——防止提示词注入把持久化命令偷渡进你的环境。

## 审计：哈希链 + 可选加锁

- 默认 `~/.dsh/agent-shell/audit-YYYY-MM-DD.jsonl`（按天，保留期自动清理）；`output/` 是终端录像（原始字节，链上 `open` 记录带它的路径）。
- **不向前兼容（0.2.2 起）**：每条必须带哈希，缺一条即判断链；升级清空旧日志再重启。
- 升级为"不可篡改"：`./install-deps.sh --audit-lock`（`chattr +a`，需一次性 root；加锁后无法自动清理、需人工归档）。
- 详细用法与实现见 [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md)。

## 最近更新

### 0.3.1（2026-09-18）— vault 安全返工（0.3.0 的四项问题在此修复，勿用 0.3.0）

- **vault 打码返工为「行身份遮蔽」**：只遮注入所在的行（值独占整行 / 值在行尾 / 含完整注入命令原文的行），无关文本不再连坐误伤；"发 `echo 猜串` 观察是否被遮"的逐字符增长预言机断死（纯函数回归锁 8 条 + 实机锁）。
- **oneShot 落刀提前到「送出那一刻」**：护栏通过后、字节进管道前同步标记消耗——"发送报错但其实已送达"骗不过一次性；护栏**拒绝**的命令不烧（键保留可再用）；同键一次发送引用 ≥2 次（含藏在宏里的第二份）在展开层**整条拒绝**。
- **四个读屏出口接回打码层**：`shell_read` 的 `history`/`screen`/`since`/`summary` 曾把 vault 值明文返回（0.2.3 脱敏体系的潜伏缺陷，被 0.3.0 的 vault 放大成必中泄露），已修 + 每出口一条回归锁。
- **并发开壳丢归属修复**：`sessions.json` 落盘改串行队列（整表快照乱序覆盖会丢新条目，重启后"谁开的壳"缺失），落盘失败从静默改为显式告警；闲置回收日志改印该会话实际生效时长。
- **面板**：⚙ 菜单第三页签更名**「引用库」**（子页签 `{{v: 秘密键}}` / `{{m: 宏命令}}`）；进入页签每次重拉数据——外部烧键/CLI 改动不再滞留旧显示；移除标题栏 `+N 行` 徽标（会换行撑高标题栏；新输出仍有点脉冲提示）。
- **文档边界补全**：命令行注入形态的明文会进 bash history（真密钥请走 `sudo -S`/`read -s` 的 stdin 提示形态）+ 清理指引；"值的哈希也算泄露"（截断 sha 对弱值秒级字典还原；插件自身从不产哈希）。

> 本 README 只保留最近一次更新。0.3.0（人机双接管 / 双域输入 / steps·expect / 闲置默认永久）、0.2.3（工具精简 10→7 / AI 精准四件套 / 面板重做）及更早内容，见 [docs/CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md)（逐版清单）与 [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/更新记录.md)（根因与验证）。

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