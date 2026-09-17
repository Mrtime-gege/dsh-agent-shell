# dsh-agent-shell

> 给 DeepSeek Harness 的持久化多 shell 终端：7 个模型工具 + 右下角一个可拖动、可直接打字的悬浮面板。

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
7. **闲置自动关闭（0.3.0 起默认关 = 会话永久保留）**：默认**不会**有任何会话被自动回收。只有显式启用才会关——单个会话 `shell_open idleMinutes=30`（正数分钟）或打开全局开关 `idleClose`（给未指定时长的会话兜底 `idleCloseMinutes`）；`0`/`-1`/不指定 = 永不自动关闭。启用后的判定：连续无**输入或运行**（AI 工具与面板输入含被拦企图都算活动；只读屏/查询不算，否则面板开着永不关），到点关闭并记审计 `reason=idle-timeout`。
8. **整机重启会丢会话**：`dsh` 自身重启会话存活（systemd 用户 scope）；但**整机/虚拟机重启**（如 WSL2 VM 休眠/重启）会连 tmux 一起带走——tmux 会话不落盘，属于平台层限制。重要工作先落盘文件。
9. **不要放进生产/多用户/有不可替代数据的机器**；内部测试、可重建的环境、你想清楚后果的自用机器才合适。重要数据先备份。

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
- **7 个模型工具**（0.2.3 精简）：`shell_open / shell_run / shell_send / shell_read / shell_manage / shell_state / shell_audit`；等待并入了 `shell_read`（传 `until`），护栏预演并入了 `shell_run`/`shell_send`（传 `dryrun`），授权状态在 `shell_state` 里一并汇报；寻址用**稳定 id**（`dsh-…`，名字只是可改的 label）。
- 面板（右下角胶囊）：真终端 —— `sudo` 密码提示、`vim` 全屏、REPL、补全、历史全都通，输入即进终端。
- **审计一条链管全部**：`tool-call`（调了哪些工具）/`input`（送进终端的键）/`open`/`close`/`rename`/`consent`/`panel-lock`/`env-degraded`/`capture`/`idle`（闲置关闭）/`config`（设置变更） 全在 `audit-YYYY-MM-DD.jsonl`，逐事件即时封链（写入算一次 SHA-256），删一条/改一字节/调顺序 → 断链即报警。

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

然后对 AI 说「接管 mywork」。AI 执行 `shell_manage action=claim session=mywork`：记归属、开始输出留痕（此前没有）、之后照常 `shell_run`/`shell_read` 驱动。干完想还给人：AI `release`，你再 attach 回去。
（别人对话名下的壳，AI 不能随手 claim —— 需要你明确同意，AI 带 `override:true` 才行。）

**③ 秘密不过 AI 手（vault，配合双域引用）**

面板 ⚙ 菜单 →「秘密与宏」页签录入键值；或 CLI（人这一侧）：

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

值不进 AI 上下文、不进审计文本、不上工具输出（此后该会话读屏里这个值持续显示为 `[vault:{{v:sudo-pw}}]`）。**诚实边界**：`output/` 留痕是 tmux 原始字节流，值进过 pane 就在里面——vault 防的是 AI 与审计/显示面，不防本机磁盘（详见 SECURITY）。

**④ 宏（可复用命令片段，人和 AI 都能写）**

```sh
dsh-agent-shell macros set deploy 'cd /srv/app && git pull && make restart'   # CLI
```

或在面板「秘密与宏」里写，或让 AI `shell_manage action=macro-set`。之后任何一方发 `{{m:deploy}}` 即展开执行；宏内容可嵌 `{{v:键}}`（发送时才展开，值不落脚本）。**所有宏写入全量进审计封链**——防止提示词注入把持久化命令偷渡进你的环境。

## 审计：哈希链 + 可选加锁

- 默认 `~/.dsh/agent-shell/audit-YYYY-MM-DD.jsonl`（按天，保留期自动清理）；`output/` 是终端录像（原始字节，链上 `open` 记录带它的路径）。
- **不向前兼容（0.2.2 起）**：每条必须带哈希，缺一条即判断链；升级清空旧日志再重启。
- 升级为"不可篡改"：`./install-deps.sh --audit-lock`（`chattr +a`，需一次性 root；加锁后无法自动清理、需人工归档）。
- 详细用法与实现见 [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md)。

## 最近更新

### 0.3.0 — 人机双接管 + 双域输入 + steps/expect + 闲置默认永久

- **闲置自动关闭默认关（语义翻转）**：默认**永久保留**会话；不指定或 `-1`/`0` = 永不自动关，显式正数分钟才启用（`shell_open idleMinutes=N` / `shell_manage action=idle minutes=N`）；全局开关 `idleClose`（默认关）打开后只给"未指定时长"的会话兜底。
- **人机双接管**：`shell_manage action=release`（AI 交还：写被拒、读不受影响、不回收）与 `action=claim`（AI 接管：人自建的壳记归属+开留痕；跨对话需 `override`）；`shell_state` 显示 `⚠有人已attach`。教程见上文[「人机双接管」](#人机双接管030ai-干一半人来接人干一半-ai-来接)。
- **双域输入系统**：`{{v:键}}` vault 秘密域（人在面板/CLI 写；AI 只见键名——值不进审计、不上工具输出、oneShot 注入即焚、进过 pane 的值在该会话读屏里持续打码）+ `{{m:名}}` 宏域（人+AI 可写，**写入全量进审计封链**防注入偷渡；scope=global/conversation/shell；宏可嵌 `{{v:}}` 不可嵌宏）。两域物理隔离防键碰撞；多行内容走 `paste-buffer` 通道（不再逐行隐性 Enter）；护栏扫**展开后**文本但拒绝消息/审计只用原文。
- **steps/expect（旗舰）**：`shell_run { steps:[{send, expect, timeout}] }` 一次调用跑完交互序列（等提示/等输出/等文件/等端口），中途不回传屏幕，失败才回现场并中止——交互式 TTY 的往返从 N 次压成 1 次。
- **语义读屏**：`shell_read mode=summary`（cwd/git/前台/缓冲/最近结果+屏尾 3 行）、`mode=diff`（增量）、`ifChanged:true`（没变只回 `unchanged`，轮询省 token）、`search` 支持 `context=±N` 与 `offset` 分页游标。
- **态势快照**：`shell_state` 每行带 `cwd=`，`withGit:true` 加 `git=分支`。
- **错误码化**：护栏拒绝带稳定码 `[code=guard:rm-root]`（15 条规则全有 id，按码分支不猜文案）。
- **control 指数退避**：tmux control 通道故障恢复 5s→10s→20s→40s→60s 封顶、成功即清零（旧版一刀切停 60s）。
- **bench-runtime**：`scripts/bench-runtime.mjs` 对热路径做 p50/p95 + 红线核对（本机基线：/screen≈12ms、/list≈9ms、capture≈10ms、POST /keys≈2ms、summary≈11ms）。

### 0.2.3 — 自 0.2.2 之后

- **工具精简 10 → 7**：`shell_wait` 并入 `shell_read`（新增 `until` 等待模式：`idle` / `fg:<命令>` / `match:<正则>`，非法值立即 REFUSED）；`shell_check` 并入 `shell_run` / `shell_send`（新增 `dryrun` 预演护栏判决、不发送）；`shell_consent` 并入 `shell_state`（授权状态/档位一并在状态里汇报，被完全禁止也能查）。工具面：`shell_open / shell_run / shell_send / shell_read / shell_manage / shell_state / shell_audit`。
- **闲置自动关闭**：新设置 `idleClose`（默认开）+ `idleCloseMinutes`（默认 60，**全工具统一分钟单位**）；`shell_open idleMinutes` 创建时定值（`0` = 永不自动关闭），`shell_manage action=idle minutes=N` 随时改；30s 一趟扫描，到点无输入/运行自动关闭并记审计 `reason=idle-timeout`（只读屏不算活动；人在操作豁免；`dsh` 重启收养的会话不会误杀——即使重启时服务端短暂不可见，第一趟扫描也会补拨，不会把"刚活过重启"的会话当闲置收掉）。⚠ 见上文风险第 7 条。
- **结构化命令结果（A 流）**：`shell_run` 默认给非交互命令包一层安全取码，返回 `✅/❌ exit N + 耗时 + 尾部`——AI 一眼看出成功还是失败，不用从文本里猜。多行/heredoc/后台/交互式程序（vim/ssh/sudo/python 等）自动跳过包装；`structured:false` 原样发送。失败结果会留在 `shell_state` 的 `last=` 里 5 分钟（B 流：长命令不用反复轮询）。
- **会话快照/复活（C 流）**：会话的 cwd / label / 尺寸 / 闲置时长在**创建、改名、改尺寸、改闲置、关闭**时自动存成快照（`<auditDir>/snapshots.json`），也能 `shell_manage action=snapshot` 手动存；`shell_open { from: <会话id> }` 一键复活场景（显式参数优先）。注意只能还原"场景"，进程/内存状态无法还原（tmux 会话不落盘）——整机重启后这是找回工作现场的唯一通道。
- **审计导出/离线验证（E 流）**：`shell_audit { export: true }` 返回**原始 JSONL**（含 prevHash/hash，可按 days 扩大范围，单次 ≤8000 行）；把导出/备份目录交给随包 CLI `dsh-agent-shell verify-audit [目录]` 即可**离线复验哈希链**（退出码 0=完整，1=断链）——"可验证的不可篡改记录"从一句承诺变成用户/CI 能自己复算的东西。
- **历史全文搜索（F 流）**：`shell_read { search: <正则> }` 在全量滚动缓冲（≤ historyLimit 行）里找匹配，返回行号 + 命中行；非法正则立即 REFUSED。
- **敏感信息脱敏（G 流，设置开关）**：新设置 `redactSecrets`（默认开，立即生效）——把"看起来是密钥"的字面量（`token=`/`password=`/`API_KEY=`/`Bearer …`/`BEGIN PRIVATE KEY`/URL 内嵌口令/GitHub/AWS 令牌样式）在**审计文本、工具输出、面板显示**里替换为 `[redacted]`；只做形状匹配宁可误报，**原始字节仍完整留在 output/ 留痕文件**（那里不脱敏）。
- **面板：下拉列表与会话信息重做（0.2.3）**：触发器与下拉行**共用同一个渲染**（`名字 + 创建者 / 稳定 id · 尺寸 · 前台 · 字节`），表头与表内彻底一致；**创建者不再显示 session 编号**，改显示 DSH 左侧列表里的**会话标题**（如「持久化交互式 bash 工具」，来自 `sessionQuery` 的标题快照；拿不到才退回短 id，面板开的标「面板」）——`shell_state` 里 AI 看到的也是同一个名字。
- **面板：授权浮层重做（0.2.3）**：双页签（**给单个对话授权** / **所有对话（默认）**）；档位改成**后果卡片**（完全控制 = "AI 以你的用户权限执行任意命令…"、只读、完全禁止各有一句明确后果）；选中后给**复核句**（`将授权「X」· 完全控制 · 10 分钟`）再点主按钮；顶部有当前全局档位徽标；已授权会话列表可逐条撤销。
- **AI 精准四件套（0.2.3）**：① `shell_run { waitFor }` **条件等待**（`match:<正则>` 新输出匹配 / `file:<路径>` 文件出现 / `port:<n>` 端口可连，`waitTimeout` 兜底）——"起服务并等它 ready"一次调用完成，不用 sleep 猜；② **失败摘要**：命令失败时自动挑出像错误的行拼进返回头与 `shell_state` 的 `last=`，AI 不必读整屏；③ **`shell_run { retry:'last-failed' }`** 一键重跑本会话最近一条失败命令（台账存完整原文，`retry:'last'` 可无视成败）；④ **`shell_manage action=doctor`** 会话自检：前台/无活动时长/缓冲占用/留痕是否已停，给出可执行建议。
- **`until`/`waitFor match:` 增量语义钉死（0.2.3 实机验证修复）**：`match` 只命中**开始等待/发送之后新出现**的输出 —— 屏上残留、命令回显里的等待词都不会 0.0s 假成功（`pure.diffSince` 整行对齐找旧帧尾部、光标行改写/同形提示符都能正确处理 + `stripCommandEcho` 剥回显，兼容折行与提示符前缀；纯函数 160 项断言 + 冒烟/边界用例覆盖）。`until` 以"开始等待"为基线；`waitFor match` 以"发送前"为基线并剥回显。
- **实机长任务验证（0.2.3）+ 已知行为**：150 步 × 1s 流式长命令全程跑完、`until=match` 只在真实完成点命中；闲置 1 分钟会话实机 76s 走完"扫描 → `idle-timeout` 关闭 → 快照落盘"；当日审计链全量封链、CLI `verify-audit` 退出码 0。**照此用更顺手**：① 以 `bash/sh/python…` 开头的命令不包退出码（交互白名单，保守）——等长任务完成用 `waitFor`/`until`，别依赖 `shell_run` 的 idle 判定（shell 循环/`bash -c` 瞬时采样可能判成"空闲"提前返回）；② `shell_run` 的 `lines` = 可见屏 + N 行滚动回看，不是"只回 N 行"；③ `waitFor match` 基线在发送前：输出在 ~250ms 内闪完的极快命令，建议用 `file:`/`port:` 判完成。
- **参数直达 AI**：`shell_state` 输出末尾附 `◈ 常用参数(JSON)` 块（会话上限 `maxSessions`/已用 `sessionsUsed`、闲置开关与时长、`shell/cols/rows/historyLimit/guard/extendedKeys/requireConsent/watchdogPid/tmux/auditDir`），AI 一次查询拿全，不用翻设置文件。
- **"mine" 幽灵归属修复**：持久化归属表（`sessions.json`）里会话已死但条目残留时，`session:"mine"` 不再带出幽灵 id 导致整批发送报 `can't find pane`——按 tmux 实际存活过滤。
- **env 探测修复**：`hasTmux` 尊重宿主预置（preset 优先于直连探测）——受限 harness 里直连 `tmux -V` 失败不再误判"没有 tmux"、看门狗不再被误关。
- **审计链加固**：链头就绪闸门消除**冷启动/热重载竞态断链**（新实例在链头从磁盘读回前写下的记录不再封在创世前驱上）；断链诊断区分「`cold-start-genesis`（竞态，非篡改）」与「疑似篡改」。历史竞态断点可用**源码仓库内**的 `scripts/repair-chain.mjs` 修复（npm 包不含 `scripts/`；只认 `cold-start-genesis` 型断点，其它一律拒绝，`--apply` 才写盘：先备份 → 重接 → 追记 `chain-repair` → 复验）：`node scripts/repair-chain.mjs [审计目录] [--apply]`
- **启动性能**：干净启动 `apply→ready` 约 135→57 ms、启动期子进程 14→3（去掉启动期重复的审计全量扫描与重复清理、`$HOME` 不再起子进程、env 跳过会被覆盖的直连 tmux 探测、无存活会话时看门狗**延迟**到首个 shell 再布防）；新增 `startup ready in Xms` 启动计时日志，仓库内 `scripts/bench-startup.mjs` 可做性能回归（不出现在 npm 包中）。
- **已知限制更新**：`dsh` 自身重启会话存活；**整机/虚拟机重启（如 WSL2 VM）会丢会话**（tmux 会话不落盘，平台层限制）。

### 0.2.2

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