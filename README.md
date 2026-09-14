# dsh-agent-shell

> 给 DeepSeek Harness 的持久化多 shell 终端：10 个模型工具 + 右下角一个可拖动、可直接打字的悬浮面板。

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

**中文**（本文件） · [**English**](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/README.en.md)

## 声明（读这三句，再决定要不要装）

1. **本插件由 AI 开发，且没有进行人工审计。** 设计与实现出自 AI，配套 450+ 条自动化断言与真机验证（靠这套测试挖出并修掉过 6 个真实缺陷），但**没有任何人做过安全审计**。
2. **授权之后，即意味着可以执行任意命令。** 本插件**没有任何审批防护** —— 某个对话被授权后，它的 AI 就能以**你自己的用户权限**读文件、改配置、发网络请求、装东西、删东西，全程不会有人问你。
3. **本插件只提供「便捷调用」的能力，不负责因此产生的后果。** 它不是沙箱、也不是受限工具；用不用、用到什么范围、数据要不要先备份，由你自行评估并承担风险。

> 详细的"能挡什么、挡不住什么"见下方「[安全边界](#安全边界)」；完整安全模型见 [SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md)。

## 它是什么

一个私有 tmux 服务端（`-L dsh-agent`）持有多个命名会话；宿主侧注册 `shell_*` 工具并暴露同源 HTTP；
客户端在 `shell.overlay`（root 作用域）加一个悬浮面板。三者解耦，所以 **shell 不属于任何一次对话**：
新开对话、切会话、热重载、快速重启都不丢，而且面板看到的和 AI 用的是同一批 shell。

## 什么时候值得用它（典型场景）

它解决两类问题：**需要真 TTY 的交互式工作**，以及**反复起进程的开销**。

### 1. 交互式命令行工具

DSH 内置的行式命令工具每次调用都是**新进程、没有 TTY** —— 需要输密码、进交互界面、按 `Ctrl-C` 的活儿它做不了。
本插件给的是真 tmux 里的真 `bash`，所以下面这些都能直接在会话里做：

| 场景 | 为什么必须"持久化 + TTY" |
|---|---|
| **`sudo` 提权** | 密码提示只在 TTY 上出现；把密码送进会话后，后续命令已是 root 上下文，不必每条都拼一遍 `sudo` |
| **`ssh` 登录另一台设备** | 登录后是远端交互 shell，同一会话里继续操作远端（远端屏幕输出会进留痕，属"录像级"、不是效果级） |
| **`gdb` / `pdb` 调试** | 断点、单步、查看变量都是有状态的交互流程，命令之间必须待在同一个调试会话里 |
| **`vim` / `nano` 编辑** | 全屏编辑要 TTY 与按键序列（`Esc`、`:wq`、模式切换） |
| **REPL / 数据库客户端** | `python` / `node` / `psql` 的会话状态（变量、事务、连接）要在多次调用之间保留 |
| **TUI 程序** | `htop`、`top`、`tmux` 之类需要全屏与真实窗口尺寸 |
| **`Ctrl-C` 打断 / 长任务后台跑** | 训练、编译、服务可以留在会话里继续跑；切对话、热重载、快速重启都不丢，之后还能回来看输出 |

### 2. 避免反复起进程的开销

* **会话是长驻的**：后续操作只是往同一个会话里送输入，不必每次重新 `cd`、`export`、`source venv/bin/activate` ——
  工作目录、环境变量、已激活的虚拟环境、后台任务都是连续继承的。
* **插件内部走 tmux control-mode 长驻客户端**（实测 ~1ms 级管道往返），而不是每次操作新 spawn 一个客户端
  （那条路径每次约 100ms 固定开销）；对"逐键输入 + 频繁读屏"的面板交互差别尤其明显。
* 相比"每条命令都新起一个进程再退出"，省掉的是进程启动与环境重新初始化的那部分成本。

> 反过来也成立：**一次性的、无交互的命令**（读文件、跑个测试、`git status`）用 DSH 内置的行式工具更合适 ——
> 它起停快、也不需要你在旁边看着。这个插件的定位是"需要真终端"的那部分工作；
> AI 侧的系统提示里也写明了这条分工，不会因为有这套工具就到处开 shell。

## 安全边界

下面是几条如实说明 —— 每一条都写清"能挡什么、挡不住什么"：

* **AI 能执行任意命令**：`shell_*` 工具驱动真实 tmux 里真实的 `bash`，以**你自己的用户权限**运行 ——
  读文件、改配置、发网络请求、装东西、删东西，都不会被拦。
* **没有任何审批弹窗**：DSH 官方审批（`dsh-user-approval`）在**本插件唯一能工作的模式
  `danger-full-access` 下策略是 `never`**（平台设计如此），而本插件**没有接入**该审批缝，
  所以模型的每一条命令都不会有人问你。详见 [SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md)。
* **唯一的防线是启发式护栏**（`guardDangerousCommands`，默认开）：10 条正则匹配
  `rm -rf /`、`mkfs`、`dd of=/dev/*`、`sudo` 等文本。**可被拼接、变量、脚本文件轻易绕过，也会误报。**
  它是减速带，不是防护措施。
* **HTTP 端点无独立鉴权**，面板走的就是这条同源 HTTP 通道。已加**浏览器面闸门**挡住三条真实可达的
  攻击路径（跨站请求伪造 / DNS rebinding / 写请求非 JSON），但**它不是鉴权**：本机其它进程仍可驱动
  这些 shell。详见 [SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md) 第 1 与第 8 条。
* **首次使用需要你手动确认**：一个对话第一次要用本插件的工具时，会先问你一次；同意就等于授权
  该对话里的 AI 执行任意命令（只授权当前对话，之后不再逐条询问）。拒绝就真的执行不了。
  想彻底关掉这道闸门得显式设置 `requireConsent: false` —— 那等于放弃它。
* **人机互斥（面板解锁 = 人在操作）**：解锁面板输入框后，AI 对本插件的**写**工具
  （`shell_send` / `shell_run` 的发送）会被宿主暂停，直到你重新上锁 —— 防止"人机混合输入"
  （你推了一半命令，AI 又补个回车）。**只作用于面板当前前台的那根 shell**，其它 shell 不受影响；
  切走某个 shell 会自动上锁，切过来的新 shell 默认也是锁着的；解锁后没有超时、不会自动释放。
  只读工具（`shell_read` / `shell_state` / `shell_audit`）不受影响。**注意这不是安全边界**：
  它只是"同一根终端不要两个人同时敲"，拦不住 AI 通过其它途径执行命令（那仍由授权门负责）。
  人的操作如实留痕：**解锁/上锁**各记一条审计（`event:'panel-lock'`），**输入**在 `/keys`
  已记（`event:'input', source:'panel'`）—— 不额外记其它细节。
* 面板状态行上的 **`无审批`** 标记是如实告知，不是开关。

| 场景 | 建议 |
|---|---|
| 自己的开发机，接受「AI 可能执行任意命令」 | 可以用；**重要数据先备份**，别在里面输入长期凭据 |
| 生产环境、有不可替代数据的机器、多人共用 | **不要用**；要试就放进容器 / 虚拟机，限制爆炸半径 |
| 提示注入风险高的场景（AI 在读不可信内容） | **不要用** |

## 环境要求

> ### ⚙️ DSH 版本兼容性（破坏性更新）
>
> 本插件（**0.2.0**）面向 **DSH 0.1.5（开发者预览版）** 开发并在其上验证（实测 `0.1.5-rc.1`）。
>
> **DSH 0.1.5 是一次破坏性更新**（官方文档明示，属开发者预览版的语义）：`subprocess` 服务改为
> **晚挂载** —— 在本插件 `apply()` 之后才就位。0.1.5 之前的插件代码在 `apply()` 期一次性
> `ctx.get('subprocess')` 会拿到 `undefined` 并**静默早退**：工具、HTTP 路由、面板全部消失，
> 且没有任何报错（升级后"插件不见了"多半是这一条）。0.1.6 起已适配：`subprocess` 改为声明式
> 硬依赖（`inject: ['tools', 'subprocess']`），连同审批情报等两处同类问题一起修掉
> （详见 [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.md)
> 的 0.1.5 兼容一节）。
>
> **可运行版本**：`DSH 0.1.5.x`（dev 预览版；`0.1.5-rc.1` 实测通过）。旧版（≤0.1.4）未在本
> 版本验证；若你在其它版本遇到问题，先对照上述兼容一节，并带上 DSH 版本号与现象一起报告。

**DSH 由你自己安装，本插件不额外要求** —— 装上 DSH 就有了 node/npm 与全部对等依赖
（`@deepseek-ai/*` 由 DSH 的模块代理提供，本包声明为 optional peer，不会被重复安装）。
唯一要留意的是**权限预设需为 `danger-full-access`**（受限沙箱下 tmux 服务端无法跨调用共享）。

> ### 🐧 支持平台：仅 Linux（含 WSL2 / 容器）
>
> **本插件只支持 Linux**，不支持 macOS / Windows 原生 —— 这不是"还没适配"，而是核心机制本身就
> 依赖 Linux：
> · `tmux`（持久化 shell 的本体）只有 Unix 生态，Windows 原生没有；
> · 嵌套 tmux 的前台判定读 `/proc/<pid>` 进程树（Linux 专有）；
> · 看门狗用 `systemd-run --user --scope`（systemd 专有）；
> · 审计目录加锁用 `chattr +a`（Linux 专有）。
>
> macOS 即使装了 tmux，`/proc`、systemd、`chattr` 三项也缺 —— 属**未测试、不保证**；
> Windows 请在 **WSL2** 里运行 DSH（那里就是 Linux，完全可用）。

**需要你（或 AI）单独安装的只有一个系统依赖：**

| 依赖 | 为什么需要 | 怎么装 |
|---|---|---|
| **tmux ≥ 3.x**（3.6b 上验证） | 持久化 shell 的本体；没有它插件完全不能用 | `./install-deps.sh --yes`（自动识别发行版），或 `apt install tmux`；**仅 Linux**（Windows 请用 WSL2，macOS 不受支持） |

> 不想手工检查就用脚本：`./install-deps.sh --check` 只读体检、给出确切安装命令；
> `./install-deps.sh --yes` 装上缺的。缺 tmux 时插件自身也会说清楚（启动日志、`shell_state`、
> `shell_open` 的报错、面板 ⓘ 的「tmux」一行都会给安装指引），不会让你看一个莫名其妙的 spawn 错误。

> peer 版本有个坑：npm 上 `@deepseek-ai/dsh-tools` 的 `latest` 仍指向很旧的 `0.0.1-rc.1`，
> 别用 `npm view ... version` 判断版本，看 `dist-tags` 或安装树里的 `package.json`。

## 安装

```sh
dsh plugin --profile web add dsh-agent-shell    # 或 file:/path/to/dsh-agent-shell
```

`dsh plugin add` 会读到本包的 `cordis.patch.yml`，自动把那段 patch 写进 profile 的组合，
**不需要再手工改任何文件**。装完**重启一次 `dsh web`**。

### 装之前/之后先跑依赖自检

```sh
./install-deps.sh --check    # 只读体检：缺什么、对应的安装命令（不 sudo、不改系统）
./install-deps.sh --yes      # 装上缺的（会 sudo，只装缺的）
```

> **给 AI 的指令**（用户只说一句「帮我装 dsh-agent-shell」时按这个来）：
> 1. `git clone`/`npm pack` 拿到本包，读本 README；
> 2. 跑 `./install-deps.sh --check`；缺什么就 `./install-deps.sh --yes`（或按它打印的命令装）；
> 3. 把结论告诉用户：装了什么、版本多少、**还需要他做什么**（重启 `dsh web`、确认权限预设是
>    `danger-full-access`、在对话里点一次授权确认）。
> 脚本退出码：0 = 齐备（或已装好），1 = 仍缺。缺 `tmux` 时插件自己也会在启动日志、
> `shell_state`、`shell_open` 报错与面板 ⓘ 里给出同一条安装指引。

> ⚠️ **不要同时再手工插一行 patch**：本包自带的 bundle patch 已经 `insert` 了 `id: agent-shell`，
> 同一个 `id` 在整份组合里只能出现一次，重复会让 `dsh web` 直接起不来
> （`duplicate loader entry id: agent-shell`）。详见 [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md)。

## 快速上手

1. 装好并重启后，页面右下角出现胶囊 **`>_ N 🔒`**（N 是 shell 数）。
2. 点胶囊展开面板 → 点 **`＋`** 新建一个 shell。
3. 点右上角**锁图标**解锁 → 直接打字，按键实时进入 shell（`Ctrl-C` 可打断）。
4. 让 AI 干活时用的是同一批 shell，`shell_state` 就能看到你刚开的那个。

```jsonc
// AI 侧：开 shell → 跑命令 → 读结果（注意字段名：只有 shell_open 用 name，其余用 session）
shell_open  { "name": "build" }
shell_send  { "session": "dsh-build", "text": "make -j8", "keys": ["Enter"] }
shell_read  { "session": "dsh-build" }
```

## 审计：可检测 vs 不可篡改（可选加锁）

**设计思路**：本插件只保证两件事 —— **授权必须来自人类**，且**一切留痕不可抵赖**。同用户
权限模型下"让 AI 改不了"这件事做不到（拿到 shell 就能改文件/调接口），所以策略是**不追"改不了"，
只追"改了必被发现"**：每一次输入、输出、授权/撤销、**解锁/上锁**都进审计，审计是哈希链（每条记录携带前一条的
摘要），删一条、改一个字节、调换顺序都会断链，`shell_audit` 与面板 ⓘ 会如实显示「链✓」或
「链⚠断」。

审计目录默认是普通目录（`~/.dsh/agent-shell`），**默认路径 = 篡改可检测**。想要升级为
**不可篡改**，可选加锁（内核级 append-only，需要 root 一次性执行）：

> **数据目录**：审计与留痕默认都在 `${DSH_HOME:-~/.dsh}/agent-shell/` 下 —— `audit-YYYY-MM-DD.jsonl`
> 是每天的审计（哈希链日志，按保留期自动清理），`output/` 放各会话的终端输出留痕（开启「输出留痕」后，
> 按会话 id 命名，会话关闭后文件仍在）。想挪走（例如加密卷）就在设置里改 `auditDir`
> （绝对路径，改动需重启 `dsh web` 生效）。

```sh
./install-deps.sh --audit-lock      # 预览命令 → 确认 → sudo chattr +a 审计目录
sudo chattr -a ~/.dsh/agent-shell   # 后悔时解除（同样需要 sudo）
```

| | **不加锁（默认）** | **加锁（--audit-lock）** |
|---|---|---|
| 审计保护 | 哈希链：**篡改必可检测**（断链即报警） | `chattr +a`：**删除/改名不可为**，只有追加 —— 篡改被阻止而非仅被发现 |
| 自动维护 | 插件按保留期**自动清理**过期日志 | **无法自动清理**：过期日志需人工 sudo 归档/删除 |
| 代价 | 无 | 一次性 root 授权；多一条人工维护义务 |
| 适合 | 默认、不想多管 | 审计是硬要求、能接受定期人工归档时 |

> 加锁是**提示不是强制**：两条路都能用，面板 ⓘ 的「审计」行和 `shell_audit` 会如实显示
> 「🔒已加锁 / 未加锁」与链校验结果。注意 `chattr` 只防"没有 root 的主体" —— 如果 AI 能拿到
> root，它同样能解锁；在那种前提下本插件的审计保障就是"必可检测"这一层。

## 最近更新（0.2.2）

- **批处理一键发送**：输入框旁「发送到全部」按钮（≥2 个 shell）—— 输入一次，命令依次发到全部
  shell（工具层 `shell_send`/`shell_run` 也接受逗号列表/`*`）。
- **人机互斥跨面板可见**：`/list` 带 `userBusy`，`shell_state` 标注「⚠用户正在操作」—— AI/别的
  面板 list 一下就知道谁被人在用。
- **shell_wait 增量匹配**：`match:<regex>` 只匹配等待开始后**新出现**的输出（屏上旧词不再假成功），
  默认 30s 超时、可传 `timeout`。
- **授权菜单**：目录按**最近活跃**排序（不再是按创建），每项显示相对时间（刚刚/N 分钟前/…/天前）。
- **通知 A**：命令跑完状态点闪 3 秒「刚结束」，新输出亮 `+N 行` 徽标 —— 纯面板内视觉，不打扰。
- **UI**：无 shell 时下拉按钮保持两排（父容器不跳高）；下拉菜单与触发按钮左对齐。
- **仅支持 Linux**（含 WSL2/容器）：详见上方「环境要求」的平台声明。

## 最近更新（0.2.1）

### 工具面 v2 + 稳定 id 会话身份（0.2.0）
- **会话身份 = 稳定 id**：tmux 会话名 = 生成的内部 id（永不变），名字只是可改的 label，一切寻址（send/read/run/kill/审计/归属）都以 id 为键。
- **工具面（10 个原子工具）**：`shell_open` / `shell_run`（发命令→等空闲→只收新输出）/ `shell_send` / `shell_read`（tail/screen/history/since 增量）/ `shell_wait` / `shell_check`（守卫预检）/ `shell_manage`（改名=改label/改尺寸/关闭/回收）/ `shell_state` / `shell_audit` / `shell_consent`。`session` 选择器统一：单 id / 逗号列表 / `mine` / `*`。
- **破坏性**：旧工具名（shell_history/list/resize/close/rename/diagnose）已移除；`shell_consent` 保留但改为**纯报告型**（授权/撤销改走面板或 HTTP `/consent`）。

### 实机修复（嵌套 tmux 与工程质量）（0.2.0）
- **嵌套 tmux 前台赛跑修复**：窗格前台组在 bash 与嵌套客户端之间真·赛跑（`pane_current_command` 只是随机采样）—— 以 `/proc` 进程树稳定判定（有嵌套客户端即 busy），面板/守卫/shell_run 不再被采样带偏；控制回复归一化。
- **dev-sync .mjs 事故 + 双层免疫**：新增 `lib/pure.mjs` 后 dev-sync 的 `*.js` glob 曾漏拷 `.mjs` 致 crash-loop；补 glob 并加"按实际相对导入核验"（dev-sync）与"相对导入可解析"（release:check）两道机械兜底。
- **重构**：`lib/pure.mjs` 零依赖纯函数抽取 + `test-pure` 45 项；边界套件瘦身。

### UI（0.1.6 经典样式 + 本次细化）（0.2.0）
- 面板回到 0.1.6 经典样式。头部简化：去掉左右切换箭头（切换只留下拉）、去掉标题栏 grip（整条可拖）、锁与新建移到下拉右侧、关闭按钮只在下拉菜单的会话行（两步确认）。
- **下拉行信息完整化**：每行两排 —— 第一排「名字（label，可改名）+ 创建它的会话（owner）」，第二排「稳定 id + 尺寸/前台/字节」。顶部下拉触发按钮同样两排显示（名字 + 创建者 + id + 尺寸），折叠胶囊优先显示 label —— 面板任何一处看到的都是同一套身份信息。
- **详情与授权浮层按 DSH 设计语言重绘**：菜单面用 `--dsw-specific-menu` + `--dsw-elevation-prominent` + 20px 圆角，授权档位/有效期改为 DSH 分段控件，详情分组成小字标题、kv 悬停行、危险横幅去左边框。
- **三浮层互斥**：shell 下拉 / 详情 / 授权任何时候只开一个（打开即自动关掉另外两个），收起面板时全部复位。
- 实机验证：两个 shell 同时各自完成 10 层 `ssh → Windows 宿主 → wsl → Kali` 嵌套往返（20 个存活 ssh 进程），全程保留未关闭。

### 安全与审计（哈希链 + 注入修复 + 不可篡改选项）（0.2.1 新增）

- **审计哈希链**：每条审计记录携带 `prevHash`+`hash`（SHA-256，键排序规范化，纯 JS 跨平台）—— 删一条、改一个字节、调换顺序都会断链并**必可发现**。启动时整链校验一次并恢复链头续写；`shell_audit` 与面板 ⓘ 如实显示「链✓(N条) / 链⚠断(第K条)」与锁状态（校验结论不展示等于没做）。授权事件（授权/撤销/过期/继承/拒绝）全部在链上。
- **注入修复**：control 路径的会话名/键名插值全部过白名单（`isSafeSessionName`/`isSafeKeyName`），非法直接抛错、不转义放行 —— 堵住 `session: "x; pipe-pane -o …"` 这类经 tmux 执行任意命令的通道。
- **安全配置不可热改**：`requireConsent` / `auditDir` / `guardDangerousCommands` 的改动被**拒绝应用、保留旧值、要求重启**，并记一条 `event:config` 审计 —— 堵住"HTTP 保存即关掉授权门/审计"的即时通道。**注意：只有改这三个配置项需要重启；新建会话、授权新对话、撤销授权全部即时生效。**
- **审计与授权设计**：详情见上方「[审计：可检测 vs 不可篡改（可选加锁）](#审计可检测-vs-不可篡改可选加锁)」；设计稿见 [docs/设计-授权与审计重构.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/设计-授权与审计重构.md)。

### 详情整合与按对话授权（UI）（0.2.1 新增）
- **详情页 4 张可折叠卡片**：原来 7 个分组平铺 37 行，现在归到 **会话 / 安全 / 系统 / 关于** 四张卡，默认只展开高频的「会话」「安全」，首屏约 8 行；点卡片标题展开/收起。审计链、加锁状态、留痕、护栏、审批集中进「安全」卡。
- **按对话授权**：授权浮层新增「按对话授权」分区 —— 搜索活跃对话（标题 / id / 子代理）→ 选中 → 档位 × 有效期 → 「授予这个对话」。**只给这一个对话授权，不写成通配、不波及其它对话**；已授权项在列表里带「已授权」标记。
- **菜单互斥完善**：面板内点任何浮层以外的地方即关闭全部浮层；点头部按钮不误关；**点插件之外的页面区域不关**。

### 装机后修复（0.2.1 → 0.2.1 修订）
- **点胶囊打不开面板**：localStorage 为空（新环境/清过数据）时 `rect` 为 null，旧代码直接读
  `rect.w` 抛 TypeError，整个浮层崩掉、点胶囊毫无反应（真实 Chrome 复现）。改为从 `panelRect`
  （rect 为 null 时回退到胶囊锚点）取宽 —— 新装、清缓存后照常显示。
- **「按对话授权」拉不到对话**：界面、状态、宿主接口全在，唯独**缺了拉取的 effect** —— 菜单永远
  停在「正在读取对话列表…」，功能是死的（装机后打开才发现）。现在打开菜单即拉 `/actors`，
  授权/撤销后自动刷新（`granted` 标记与「已授权的会话」列表实时更新）；宿主没有对话目录时，
  给出承诺过但从未实现的「手工填会话 id」降级入口。

## 版本与发布

发版流程、发布纪律与自动推送配置见 [docs/PUBLISHING.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/PUBLISHING.md) 与 [docs/发布自动推送.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/%E5%8F%91%E5%B8%83%E8%87%AA%E5%8A%A8%E6%8E%A8%E9%80%81.md)；公开仓只在发版时前移。

## 详细文档

| 文件 | 内容 |
|---|---|
| [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md) | 配置项全表、面板完整行为、工具与 HTTP 参数细节、已知限制、工作原理（含 README 拆入章节） |
| [docs/设计与实现.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/设计与实现.md) | 设计与重构路线 |
| [docs/SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md) | 完整安全模型（无审批 / 无鉴权 / 护栏边界） |
| [docs/PUBLISHING.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/PUBLISHING.md) | 发布教程（provenance / Trusted Publisher / 回滚 / 版本与发布） |
| [docs/发布自动推送.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/%E5%8F%91%E5%B8%83%E8%87%AA%E5%8A%A8%E6%8E%A8%E9%80%81.md) | 推 tag 即自动发 npm 的配置步骤 |
| [docs/CONTRIBUTING.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CONTRIBUTING.md) | 开发环境、代码约定、测试 |
| [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/更新记录.md) | 完整改动记录（每版根因与验证） |
| [docs/CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md) | 每版简短发布说明 |
| [install-deps.sh](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/install-deps.sh) | 依赖自检与安装脚本 |

## 许可证

MIT。

