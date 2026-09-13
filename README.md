# dsh-agent-shell

> 给 DeepSeek Harness 的持久化多 shell 终端：9 个模型工具 + 右下角一个可拖动、可直接打字的悬浮面板。

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

**中文**（本文件） · [**English**](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/README.en.md)

## ⚠️ 使用前必读：这是一个真实的 shell，没有任何审批防护

**本插件由 AI 开发**：设计、实现与测试全部由 AI 完成（157 条自动化断言 + 真机验证，
并靠这套测试挖出并修掉过 6 个真实缺陷），但**未经人工安全审计**。

**它不是沙箱，也不是受限工具。装上它，等于把一台真机器的终端交给 AI。**

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
* 面板状态行上的 **`无审批`** 标记是如实告知，不是开关。

| 场景 | 建议 |
|---|---|
| 自己的开发机，接受「AI 可能执行任意命令」 | 可以用；**重要数据先备份**，别在里面输入长期凭据 |
| 生产环境、有不可替代数据的机器、多人共用 | **不要用**；要试就放进容器 / 虚拟机，限制爆炸半径 |
| 提示注入风险高的场景（AI 在读不可信内容） | **不要用** |

## 它是什么

一个私有 tmux 服务端（`-L dsh-agent`）持有多个命名会话；宿主侧注册 `shell_*` 工具并暴露同源 HTTP；
客户端在 `shell.overlay`（root 作用域）加一个悬浮面板。三者解耦，所以 **shell 不属于任何一次对话**：
新开对话、切会话、热重载、快速重启都不丢，而且面板看到的和 AI 用的是同一批 shell。

## 工作原理（简述）

插件在你自己的机器上运行一个**私有 tmux 服务端**，面板与 AI 工具都只是往它读写：

1. **服务端（一个常驻 daemon）**：首次建 shell 时由插件**直接用 `systemd-run --user --scope`
   创建**（`env -i` 干净最小环境）—— **不经过 DSH 的 subprocess 服务**。原因要如实说清：
   DSH 的 subprocess 服务在宿主**正常退出时会 dispose 所有托管 scope**（scope 拥有
   setsid 后代），若 tmux 服务端在它里面，`dsh web` 一重启/升级，全部会话就会被连带清掉。
   服务端是常驻 daemon、不是"一次命令"，所以它单独放进**独立 user scope**：重启后服务端与
   会话**存活**；宿主崩溃（清理执行不到）时的孤儿由插件自己的**看门狗**约 60 秒收尾。
2. **命令（每次操作）**：读屏、发键、列表等仍全部走 DSH 的 `subprocess` 服务（每命令一个
   systemd scope：记账、限额、退出清理都归它），并叠加一个**长驻 `tmux -C` 控制客户端**
   （经 subprocess 服务管理、重启后自动重生）复用进程 —— 逐键/读屏延迟 ~5ms（对比早期
   ~140ms 的每命令一次 spawn）。
3. **为什么需要 `danger-full-access`**：tmux 服务端要**跨调用共享**，受限沙箱下做不到
   （这也是唯一绕开 subprocess 服务的一处——只有服务端这一个 daemon，命令级隔离不受影响）。

```
┌─ 折叠态 ─────────────────────────────┐
│  >_ 3 🔒                             │   ← 右下角胶囊：shell 数量 + 锁状态
└──────────────────────────────────────┘
┌─ 展开态 ─────────────────────────────────────────────────────────────┐
│ ◀   dsh-build   ▶   2/3   🔒  ＋  ✕  —                              │
├──────────────────────────────────────────────────────────────────────┤
│ $ make -j8                                                           │  ← 等宽渲染当前屏
│ [ 42%] Building CXX object ...                                        │     每 700ms 刷新
│ ...                                                                   │
├──────────────────────────────────────────────────────────────────────┤
│ 名称 dsh-build  尺寸 120×32  前台 make  缓冲 178/100000 行  已用 40 KB │  ← 指标行
├──────────────────────────────────────────────────────────────────────┤
│ 🔒 输入已锁定 —— 点击右上角锁图标解锁后输入                            │  ← 锁定时输入无效
└──────────────────────────────────────────────────────────────────────┘
```

与内置的行式命令工具的区别：内置工具每次调用独立执行、不开交互式 TTY。需要 `sudo` 输密码、
`ssh` 登录、`vim` 编辑、`python` REPL 这类**真交互**时用本插件。

## 环境要求

> ### ⚙️ DSH 版本兼容性（破坏性更新）
>
> 本插件 **0.1.6** 面向 **DSH 0.1.5（开发者预览版）** 开发并在其上验证（实测 `0.1.5-rc.1`）。
>
> **DSH 0.1.5 是一次破坏性更新**（官方文档明示，属开发者预览版的语义）：`subprocess` 服务改为
> **晚挂载** —— 在本插件 `apply()` 之后才就位。0.1.5 之前的插件代码在 `apply()` 期一次性
> `ctx.get('subprocess')` 会拿到 `undefined` 并**静默早退**：工具、HTTP 路由、面板全部消失，
> 且没有任何报错（升级后"插件不见了"多半是这一条）。0.1.6 已适配：`subprocess` 改为声明式
> 硬依赖（`inject: ['tools', 'subprocess']`），连同审批情报等两处同类问题一起修掉
> （详见 [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.md)
> 的 0.1.5 兼容一节）。
>
> **可运行版本**：`DSH 0.1.5.x`（dev 预览版；`0.1.5-rc.1` 实测通过）。旧版（≤0.1.4）未在本
> 版本验证；若你在其它版本遇到问题，先对照上述兼容一节，并带上 DSH 版本号与现象一起报告。

**DSH 由你自己安装，本插件不额外要求** —— 装上 DSH 就有了 node/npm 与全部对等依赖
（`@deepseek-ai/*` 由 DSH 的模块代理提供，本包声明为 optional peer，不会被重复安装）。
唯一要留意的是**权限预设需为 `danger-full-access`**（受限沙箱下 tmux 服务端无法跨调用共享）。

**需要你（或 AI）单独安装的只有一个系统依赖：**

| 依赖 | 为什么需要 | 怎么装 |
|---|---|---|
| **tmux ≥ 3.x**（3.6b 上验证） | 持久化 shell 的本体；没有它插件完全不能用 | `./install-deps.sh --yes`（自动识别发行版），或 `apt install tmux` / `brew install tmux`；**Windows 请在 WSL 里运行 DSH**（原生 Windows 没有 tmux） |

> 不想手工检查就用脚本：`./install-deps.sh --check` 只读体检、给出确切安装命令；
> `./install-deps.sh --yes` 装上缺的。缺 tmux 时插件自身也会说清楚（启动日志、`shell_diagnose`、
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
> `shell_diagnose`、`shell_open` 报错与面板 ⓘ 里给出同一条安装指引。

> ⚠️ **不要同时再手工插一行 patch**：本包自带的 bundle patch 已经 `insert` 了 `id: agent-shell`，
> 同一个 `id` 在整份组合里只能出现一次，重复会让 `dsh web` 直接起不来
> （`duplicate loader entry id: agent-shell`）。详见 [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md)。

## 改参数：两种方式

| 方式 | 怎么改 | 适合 |
|---|---|---|
| **设置页**（推荐） | 打开 **DSH 设置 → 插件 → `dsh-agent-shell`**，表单由 schema 直接生成，每个参数都带说明 | 日常调整；**大多数项改完立即生效**，不用动任何文件 |
| `cordis.patch.yml` | 给 `id: agent-shell` 那一行写 `config` | 首次部署、或要写进版本管理 |

```yaml
- id: agent-shell
  config:
    maxSessions: 16         # 会话数上限（立即生效）
    shell: zsh              # 新会话用 zsh（立即生效）
    extendedKeys: true      # 需要 tmux ≥ 3.2，改完要重启
```

23 个参数：`socket` `httpBase` `exposeHttp` `exposeTools` `watchdog` `shell` `defaultTerminal`
`cols` `rows` `historyLimit` `maxSessions` `defaultCwd` `guardDangerousCommands` `allowedHosts`
`extendedKeys` `requireConsent` `consentRetryCooldownSeconds` `consentTimeoutSeconds`
`auditDir` `audit` `auditRetentionDays` `captureOutput` `captureMaxBytes`。
**哪些立即生效、哪些要重启**在设置页的字段说明里逐条写明，插件也会在改完后如实回报
（「已保存，并已立即生效」/「下列项要重启 dsh web 才生效：historyLimit」），面板的 ⓘ 详情能看到。
设置页里填越界值会被**当场拒绝并给出范围**（例如 `cols 必须在 20–1000 之间（现在是 5000）`），
而不是悄悄改小。完整表格见 [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md)。

## 快速上手

1. 装好并重启后，页面右下角出现胶囊 **`>_ N 🔒`**（N 是 shell 数）。
2. 点胶囊展开面板 → 点 **`＋`** 新建一个 shell。
3. 点右上角**锁图标**解锁 → 直接打字，按键实时进入 shell（`Ctrl-C` 可打断）。
4. 让 AI 干活时用的是同一批 shell，`shell_list` 就能看到你刚开的那个。

```jsonc
// AI 侧：开 shell → 跑命令 → 读结果（注意字段名：只有 shell_open 用 name，其余用 session）
shell_open  { "name": "build" }
shell_send  { "session": "dsh-build", "text": "make -j8", "keys": ["Enter"] }
shell_read  { "session": "dsh-build" }
```

## 面板要点

* **锁**：默认锁死，点锁图标才能输入；**焦点离开面板会自动重新上锁**，避免误触往正在跑的 shell 里灌字符。
* **真·终端输入模型**：**没有任何本地缓冲** —— 每个按键直接进 shell，补全、历史、行内光标、
  `Ctrl-R` 全由 shell 自己的 readline 处理；**兼容中文输入法**（组字状态自己维护）。
* **缩放与拖动**：面板 8 个缩放手柄、标题栏可拖，位置与尺寸存 localStorage，跨刷新保留。
  面板很窄时头部会**自动进入紧凑模式**（收起计数、标题文字与分隔线），保证按钮不会被挤出浮窗。
* **授权浮层（盾牌按钮）**：点开后可把授权设成**时间 × 能力**两个维度 —— 能力三档
  （完全控制 / 只读 / 完全禁止）、时间五档（10 分钟 / 30 分钟 / 2 小时 / 永久 / 自定义 1 分钟–30 天），
  再用「应用」作用于所有对话。浮层下半部是**已授权的会话列表**（按最近使用排序、显示会话标题与剩余
  时间、可逐条撤销）；拒绝或超时后会进入冷却期，不会再被反复询问。详见
  [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md)。
* **切换 shell**：`‹` `›` 挨个切；点中间的名字（带 ▾）打开选择器，列出全部 shell（状态点、尺寸、
  前台命令、缓冲用量），**从 1 跳到 50 是两次点击**；选择器里可以 `✎` 重命名、`✕` 关闭。
* **主动推送 `⤒`**：这套模型下输入框本应始终为空，一旦出现残留（自动提交漏了一次），
  点它就把残留内容送进终端；检测到残留时按钮变琥珀色。
* **看历史**：默认取可见屏 + 向上 200 行，`⤒ 更多历史` 每点一次翻倍（上限 5000 行），
  贴底自动跟随，翻上去就不再打扰你。

| 键 | 行为 |
|---|---|
| 可打印字符 | 交给浏览器/输入法 → 由 `input` 事件交付给终端 |
| `Enter` / `Tab` / `Shift+Tab` | 回车 / 补全 / 反向补全 |
| `↑` `↓` `←` `→` `Home` `End` `Delete` `Backspace` | 历史与行内编辑 |
| `Ctrl-A/E/B/F/K/U/Y/P` | readline 行内操作 |
| `Ctrl-C/D/L/Z` · `Esc` | 中断 / EOF / 清屏 / 挂起 / 送给终端 |
| `Ctrl-R` | 反向搜索历史 |
| `Ctrl-V` `Ctrl-X` | 放行给浏览器（粘贴/剪切）；有选中文本时 `Ctrl+C` 也让浏览器复制 |

## 模型工具（AI）

> **什么时候才该用**：优先用常规的命令行与文件工具。只有下面几种情况才开持久化 shell ——
> ① 需要**真交互式 TTY**（`sudo` / `ssh` 密码提示、`vim`、REPL、TUI 程序）；
> ② 工作需要**跨调用甚至跨对话保活**（长构建、服务进程，稍后还要回来看）；
> ③ **用户明确要求**用持久化 shell。
> 不要为了跑一条一次性命令就开 shell，也别把空闲 shell 留着 —— 用完 `shell_close` 关掉。

> **归属规则（对 AI 的硬性要求）**：`shell_list` 会列出**所有**会话创建的 shell（这是有意的可见性），
> 每条都带 `owner`。shell 是跨对话共享的（它们比创建它的对话活得久），所以 `owner` 是唯一能告诉 AI
> "哪个是它自己的"的东西。**除非你明确要求，AI 不应该对你没让它创建的 shell 做任何操作** ——
> 不发送输入、不读取内容、不关闭、不改尺寸/名字；它可以告诉你它看到了什么，由你决定。
> 你自己在面板里不受这条限制（面板是人，不是 AI）。
>
> 这条策略不只写在文档里：它同时进了**工具描述**（模型逐个看 schema 时可见）与
> **系统提示**（`agent-shell:usage` 段落，位于 approval 策略之后），所以模型是被明确告知的。

| 工具 | 参数（★ = required） | 作用 |
|---|---|---|
| `shell_open` | `name?` `cols?` `rows?` `cwd?` | 新建后台 shell，返回首屏（`cwd` 不存在会明确报错，不会静默换目录） |
| `shell_send` | ★`session` `text?` `preKeys?` `keys?` `confirm?` `settleMs?` | 像人一样输入：`preKeys` → `text` → `keys`，一次调用可完成「进插入模式→打字→退出」 |
| `shell_read` | ★`session` | 读当前可见屏 |
| `shell_history` | ★`session` `lines?` | 读滚动缓冲（滚出屏幕的输出） |
| `shell_list` | — | 列出全部 shell 与指标 |
| `shell_resize` | ★`session` ★`cols` ★`rows` | 改尺寸（夹到 20–1000 × 5–500） |
| `shell_rename` | ★`session` ★`newName` | 重命名（自动净化名字并补 `dsh-` 前缀） |
| `shell_close` | ★`session` | 关闭（**幂等**：已经没了也返回成功并说明没关到） |
| `shell_audit` | `session?` `actor?` `source?` `lines?` `days?` | 读审计流水：谁在什么时候往哪个 shell 发了什么（含**已关闭**的会话）；同时报告留痕文件 |
| `shell_diagnose` | — | 服务端 / 看门狗 / 起始目录 / tmux / 闸门 / 审计 / **审批状态** |

`shell_send` 的 `preKeys` / `keys` 收 tmux 键名（`Escape`、`C-c`、`Enter`、`Up`…），`text` 原样输入：

```jsonc
shell_send { "session": "dsh-edit", "preKeys": ["i"], "text": "print('hi')", "keys": ["Escape"] }
```

> **字段名差别**：只有 `shell_open` 用 `name`（新建时的可选标签），**其余工具一律用 `session`**，
> 写错会直接收到 `ToolArgsError`。而 HTTP 请求体**统一用 `name`**。

## HTTP 端点

面板用它，你也可以用（同源、`127.0.0.1`、**无独立鉴权**）。**经浏览器调用时**要满足闸门要求：
`Host` 为回环且端口一致、不带 `Sec-Fetch-Site: cross-site`、`Origin` 与 `Host` 同源、
写请求带 `Content-Type: application/json`。用 `curl` 之类的本机工具直接调不受影响（但仍请勿把
端口暴露到不可信网络）：

```
GET  /plugins/shell/list                     会话列表 + 服务端信息（含 approval 情报）
GET  /plugins/shell/screen?name=&lines=      当前屏 + 该会话指标
POST /plugins/shell/keys                     {name, text?, preKeys?, keys?, confirm?}
POST /plugins/shell/new                      {name?, cols?, rows?, cwd?}
POST /plugins/shell/kill                     {name}
POST /plugins/shell/resize                   {name, cols, rows}
POST /plugins/shell/rename                   {name, newName}
GET  /plugins/shell/diagnose
GET  /plugins/shell/consent                  授权门状态（enabled / allowAll / 已授权的对话列表）
POST /plugins/shell/consent                  {action:"grant-all"|"revoke"} —— 面板那个授权按钮走这里
GET  /plugins/shell/audit?name=&actor=&source=&lines=&days=   审计流水 + 留痕文件清单
```

## 已知限制

* **没有官方审批，命令不会被询问**（原因见上面「使用前必读」与 [SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md)）。
* **护栏是启发式减速带，不是沙箱**：会误报（正文里出现 `sudo` 之类），也能被绕过。
* **必须 `danger-full-access`**；受限模式下建 shell 会失败（`error connecting to /tmp/tmux-1000/...`）。
* **宿主半改代码要重启 `dsh web`**（ESM 模块缓存），客户端半改代码刷新页面即可。
* 面板是**文本渲染**而非终端仿真：`capture-pane -p` 给出的是渲染后的字符，颜色与属性会丢。
* `pane_current_command` 在 `sudo -i` 里会一直报 `sudo`，但前台判定会**钻穿**它找到真正的 shell
  （0.1.6 起）：空闲时状态点能回到空闲；只是别名、别名外的包装器仍按真实进程报。
* 只看得到本插件自己创建的 shell（有意设计）：不枚举默认 socket，也接不进你已有的 tmux 会话。
* **宿主停机超过约 60 秒**时，全部 shell 会被孤儿看门狗收掉（崩溃、卡死属于这一类）。
  窗口设长是为了 `systemctl restart dsh web` 不误杀；代价是崩溃后孤儿服务端多活约 60 秒。
* **审计日志是本机文件**：能读你 home 的进程就能改它 —— 它解决"事后查得清"，不解决"防抵赖"
  （要后者需要 hash 链或只读归档）。面板侧的人类输入只能记到 `panel` 这一粒度，无法区分是谁。
* **输出留痕会把终端里出现过的敏感内容一起记下来**（密码、令牌、打印的密钥）。不需要就
  `captureOutput: false`；需要可随时回看的就留着，目录 0600 且可 `auditDir` 指到加密卷。
* **HTTP 服务绑到 `0.0.0.0` 时闸门会降级**：`Host` 无法用于判定是否本机，DNS rebinding 那条路径
  不再被挡住。面板 ⓘ 的「浏览器面闸门」会以 `⚠` 明确标出。

## 最近更新（0.1.6）

### 性能：tmux control-mode 长驻客户端（"复用同一个进程"）

面板的读屏、列表、前台探测与逐键发送，都从"每个操作 spawn 一个 tmux 客户端（经 subprocess
服务实测 ~100ms 固定开销）"变成"**一个长驻 `tmux -C` 客户端**，命令走管道 ≈1ms"。
实机实测：`/screen` 单请求 **107–177ms → 3–5ms（约 40 倍）**，面板逐键的回显同步提速。
它照样是 subprocess 服务管理的 scope 子进程（dispose / 超时 / 输出上界一条不丢），失败自动
退避 60 秒并回退一次性路径。实现细节与踩过的六个 tmux 3.6b 行为见
[docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.md) 的 control-mode 一节。

### 权限模型：时间 × 能力 + 授权浮层

首次使用要人授权（确认门 + 冷却期，不被反复询问）；面板头部的盾牌打开授权浮层 ——
**完全控制 / 只读 / 完全禁止**三档 × **10 分钟 / 30 分钟 / 2 小时 / 永久 / 自定义**时限，
可逐条撤销、按最近使用排序，授权即刻落盘。`shell_consent` 让模型能查自己有没有授权。

### 安全：守卫修复 + 审计脱敏

- 提交前回退扫屏补上前提：**只在前台确实是 shell 时**才把"屏幕最后一行"当待提交命令扫 ——
  输入 sudo/ssh 密码不再被守卫误拦（实测的坑：密码提示不回显，提示语被当成命令匹配提权规则）；
- 前台判断钻穿 `sudo -i` 这类包装器（改前整个 root 会话的 idle 判定失效）；
- 审计**不再落明文密码**：非 shell 前台的输入（密码提示、TUI）只记脱敏摘要；既有 3 条明文已擦除；
- 看门狗重启窗口 6 秒 → 60 秒：`systemctl restart dsh web` 不再有误杀全部会话的风险。

### 兼容与修复

- **兼容 DSH 0.1.5**：`subprocess` 改为声明式硬依赖（`inject`），修复升级后插件整体静默失效；
- 设置卡片按官方 `PluginCard` 的真实几何重排（16px 圆角 / 15px 标题 / `.5px` 边框 / 纵向字段栈），
  中文名改名不再被静默吃掉、失焦即提交、归属与审计跟着改名搬家；
- 光标不再被画到行尾（Range 限定在光标所在行）；刷新改自适应轮询（变化时 200ms，静默 800ms）；
- 发布卫生（0.1.6 的其余内容）：只发必要文件、开发机信息从整部历史清掉、发布由维护者明确要求。

完整逐项根因与验证见 [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/%E6%9B%B4%E6%96%B0%E8%AE%B0%E5%BD%95.md)，发布说明见
[CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md)。

## 版本与发布

* **公开历史只保留版本级节点**：每个版本对应**一个提交**与一个 `v<版本>` tag —— 中间改动的过程、粒度与
  提交信息不在公开历史里。
* **发版由维护者决定**：推 `v<版本>` tag 是唯一的发布扳机。CI（GitHub Actions）用 npm 的
  Trusted Publisher（OIDC）发布到 npm，并自动创建对应的 GitHub Release，附带 provenance 签名证明
  （`npm audit signatures` 可验证）。
* **README 只保留最近一次更新**，完整历史（每个版本改了什么、**根因**是什么、怎么验证的）在
  [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/更新记录.md)；
  逐版本的简短发布说明在 [CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md)。
* **只发布必要文件**：npm 包里只有运行与安装需要的条目（`lib/`、`cordis.patch.yml`、`install-deps.sh`、
  两份 README、`LICENSE`）—— 文档类内容留在仓库，不随包发布。

## 详细文档

| 文件 | 内容 |
|---|---|
| [docs/使用细节.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/使用细节.md) | 配置项全表、何时需要重启、面板完整行为（含输入法的两个坑）、工具与 HTTP 参数细节 |
| [docs/设计与实现.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/设计与实现.md) | 与对话解耦的设计、生命周期与孤儿治理、关键实现注记、测试与验证、版本与发布策略 |
| [SECURITY.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/SECURITY.md) | 完整安全模型：为什么没有官方审批、HTTP 无鉴权、护栏边界、凭据风险 |
| [PUBLISHING.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/PUBLISHING.md) | npm + GitHub 发布教程（含 provenance、Trusted Publisher、回滚） |
| [CONTRIBUTING.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CONTRIBUTING.md) | 开发环境、代码约定、三层测试、PR 要求 |
| [docs/更新记录.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/更新记录.md) | **完整**改动记录：每个版本修了什么、根因、怎么验证（README 只留最近一次） |
| [CHANGELOG.md](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/docs/CHANGELOG.md) | 每个版本的简短发布说明（发版时与 git tag 一起用） |
| [install-deps.sh](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/install-deps.sh) | 依赖自检与安装脚本（给人和 AI 用） |

## 许可证

[MIT](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE) © Mrtime-gege
