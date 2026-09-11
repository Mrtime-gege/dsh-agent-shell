# dsh-agent-shell

> 给 DeepSeek Harness 的持久化多 shell 终端：9 个模型工具 + 右下角一个可拖动、可直接打字的悬浮面板。

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

**中文**（本文件） · [**English**](./README.en.md)

## ⚠️ 使用前必读：这是一个真实的 shell，没有任何审批防护

**本插件由 AI 开发**：设计、实现与测试全部由 AI 完成（157 条自动化断言 + 真机验证，
并靠这套测试挖出并修掉过 6 个真实缺陷），但**未经人工安全审计**。

**它不是沙箱，也不是受限工具。装上它，等于把一台真机器的终端交给 AI。**

* **AI 能执行任意命令**：`shell_*` 工具驱动真实 tmux 里真实的 `bash`，以**你自己的用户权限**运行 ——
  读文件、改配置、发网络请求、装东西、删东西，都不会被拦。
* **没有任何审批弹窗**：DSH 官方审批（`dsh-user-approval`）在**本插件唯一能工作的模式
  `danger-full-access` 下策略是 `never`**（平台设计如此），而本插件**没有接入**该审批缝，
  所以模型的每一条命令都不会有人问你。详见 [SECURITY.md](./SECURITY.md)。
* **唯一的防线是启发式护栏**（`guardDangerousCommands`，默认开）：10 条正则匹配
  `rm -rf /`、`mkfs`、`dd of=/dev/*`、`sudo` 等文本。**可被拼接、变量、脚本文件轻易绕过，也会误报。**
  它是减速带，不是防护措施。
* **HTTP 端点无独立鉴权**，面板走的就是这条同源 HTTP 通道。已加**浏览器面闸门**挡住三条真实可达的
  攻击路径（跨站请求伪造 / DNS rebinding / 写请求非 JSON），但**它不是鉴权**：本机其它进程仍可驱动
  这些 shell。详见 [SECURITY.md](./SECURITY.md) 第 1 与第 8 条。
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

`dsh plugin add` 会读到本包的 `dsh.bundle.patch`，自动把包名写进 `dsh.profile.bundles`，
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
> （`duplicate loader entry id: agent-shell`）。详见 [docs/使用细节.md](./docs/使用细节.md)。

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

20 个参数：`socket` `httpBase` `exposeHttp` `exposeTools` `watchdog` `shell` `defaultTerminal`
`cols` `rows` `historyLimit` `maxSessions` `defaultCwd` `guardDangerousCommands` `allowedHosts`
`extendedKeys` `auditDir` `audit` `auditRetentionDays` `captureOutput` `captureMaxBytes`。
**哪些立即生效、哪些要重启**在设置页的字段说明里逐条写明，插件也会在改完后如实回报
（「已保存，并已立即生效」/「下列项要重启 dsh web 才生效：historyLimit」），面板的 ⓘ 详情能看到。
设置页里填越界值会被**当场拒绝并给出范围**（例如 `cols 必须在 20–1000 之间（现在是 5000）`），
而不是悄悄改小。完整表格见 [docs/使用细节.md](./docs/使用细节.md)。

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
GET  /plugins/shell/audit?name=&actor=&source=&lines=&days=   审计流水 + 留痕文件清单
```

## 已知限制

* **没有官方审批，命令不会被询问**（原因见上面「使用前必读」与 [SECURITY.md](./SECURITY.md)）。
* **护栏是启发式减速带，不是沙箱**：会误报（正文里出现 `sudo` 之类），也能被绕过。
* **必须 `danger-full-access`**；受限模式下建 shell 会失败（`error connecting to /tmp/tmux-1000/...`）。
* **宿主半改代码要重启 `dsh web`**（ESM 模块缓存），客户端半改代码刷新页面即可。
* 面板是**文本渲染**而非终端仿真：`capture-pane -p` 给出的是渲染后的字符，颜色与属性会丢。
* `sudo -i` 这类登录 shell 里 `pane_current_command` 会一直是 `sudo`，状态点不会回到空闲。
* 只看得到本插件自己创建的 shell（有意设计）：不枚举默认 socket，也接不进你已有的 tmux 会话。
* **宿主停机超过约 6 秒**时，全部 shell 会被孤儿看门狗收掉（崩溃、慢重启属于这一类）。
* **审计日志是本机文件**：能读你 home 的进程就能改它 —— 它解决"事后查得清"，不解决"防抵赖"
  （要后者需要 hash 链或只读归档）。面板侧的人类输入只能记到 `panel` 这一粒度，无法区分是谁。
* **输出留痕会把终端里出现过的敏感内容一起记下来**（密码、令牌、打印的密钥）。不需要就
  `captureOutput: false`；需要可随时回看的就留着，目录 0600 且可 `auditDir` 指到加密卷。
* **HTTP 服务绑到 `0.0.0.0` 时闸门会降级**：`Host` 无法用于判定是否本机，DNS rebinding 那条路径
  不再被挡住。面板 ⓘ 的「浏览器面闸门」会以 `⚠` 明确标出。

## 最近更新（0.1.5）

完整历史（每个版本的根因与验证方式）见 **[docs/更新记录.md](./docs/更新记录.md)**。

### 新增：首次使用需用户手动确认（授权门）

一个对话**第一次**要用本插件的工具时，会先弹一个问题请你确认 —— 同意就等于授权该对话里的
AI 在这些 shell 上执行**任意命令**（权限等同你自己），之后同对话不再询问。

- 只授权**当前对话**；换一个对话要各自确认一次（授权落盘，热重载/重启不重复问）。
- 面板不受影响：那是你自己在操作，不会问你"允不允许自己"（但仍会留一条审计）。
- **拒绝就是真的挡住**：不创建 shell、不发送任何输入（测试断言了这一点，而不只是"回了一句话"）。
- 子代理没有人可以问（DSH 的提问服务不会向子代理转发问题，问了会永久阻塞）：若本进程里已有
  人类授权则**继承**并如实记录；否则明确拒绝并说清该怎么办。
- 没有可用的提问服务时**拒绝**（问不到人就不算得到授权），并指出配置出口 `requireConsent: false`。
  ⚠ 关掉它意味着放弃这道闸门 —— 那正是"AI 可以在你不知情时开 shell 并执行命令"。
- 每次确认与拒绝都进审计日志（谁问的、谁答的、答了什么）。

### 新增：依赖自检脚本（给 AI 用的安装入口）

```sh
./install-deps.sh --check    # 只读体检：缺什么、装它的确切命令（不 sudo、不改系统）
./install-deps.sh --yes      # 装上缺的（会 sudo；只装缺的）
```

脚本按发行版识别包管理器（apt/dnf/yum/pacman/zypper/apk/brew），退出码 0 = 齐备、1 = 仍缺。
**用户只要说一句「帮我装 dsh-agent-shell 这个插件」，AI 读到本 README 就能跑这个脚本** ——
这正是它存在的理由：`tmux` 是系统依赖，包管理器装完一个字都不会说。

### 新增：真实光标（解锁后显示）

面板以前是纯文本快照，**不画插入点** —— 打空格/Tab 时你根本不知道下一个字符落在哪一列，
只能靠记忆。现在读 tmux 自己的光标坐标（`#{cursor_x}` / `#{cursor_y}` / `#{cursor_flag}`，
顺带在已有的 `list-panes` 里取，**不额外起进程**）并在屏幕上画一个会闪的插入点：

- **只在解锁后显示**：锁定时（AI 在发输入、或你还没解锁）不画 —— 那时那个位置并不代表
  "你下一个字符会出现在这"。程序自己隐藏了光标（TUI）时也不画。
- **坐标换算不是把 `cursor_x` 当字符下标**：中文/日文/emoji 占 2 格、组合符占 0 格，
  所以做了单元格 → 字符的映射表；`cursor_y` 是相对可见窗格的，按"可见窗格永远贴底"换算成
  我们这份文本里的行号。
- **换算不出来就不画**：没有 meta、`paneHeight` 缺失、量不到字符宽度、光标在我们窗口之外 ——
  一律不画。宁可没有光标，也不要画在错误的位置。
- 实现方式是 `<pre>` 内容坐标里的绝对定位元素，因此它**随内容一起滚动**，不需要额同步。

### 其他修复与改进

- **新 shell 默认在当前对话的工作目录**（`agent.session.header.cwd`，与平台注册 `cwd` 变量用的是
  同一条路径）；显式 `cwd` 参数仍最优先，面板建的会话才回退到 `defaultCwd`/`$HOME`。返回值里写明
  来源（`(conversation)` / `(explicit)` / `(configured-fallback)`）。
- **`shell_consent` 工具**：模型可以查"本对话是否已授权"（含闸门状态、本进程授权列表、撤销方式）。
  工具描述明确要求**不要例行查询**，只在需要时或调用失败原因不明时查。
- **修掉设置页菜单项不出现的真问题**：此前用一次性 `ctx.get('settings')`，而设置服务在本插件
  apply 时**还没挂载** —— 于是走了静默分支：重启后菜单里没有这一项，日志里也什么都没有。
  现在改用 `ctx.inject(['settings'])` 惰性注册（服务晚挂载也能注册上），并在服务从未出现时如实说明。
  同类问题一并修掉：`approval`、`connection`（闸门）也改为运行时动态读取。
- **面板「关闭」不再容易误触**：与「收起」之间加分隔线，且关闭改为**点两次确认**（第一次变红提示
  「再点一次」，3 秒后自动复位）。

### 文档结构调整

- 完整更新与修复记录移入 [docs/更新记录.md](./docs/更新记录.md)，README 只留最近一次。
- 环境要求重写：DSH 自身（含 node/npm、对等依赖）只做**一句话说明**，需要用户单独安装的
  系统依赖（tmux）才重点写。

## 详细文档

| 文件 | 内容 |
|---|---|
| [docs/使用细节.md](./docs/使用细节.md) | 配置项全表、何时需要重启、面板完整行为（含输入法的两个坑）、工具与 HTTP 参数细节 |
| [docs/设计与实现.md](./docs/设计与实现.md) | 与对话解耦的设计、生命周期与孤儿治理、关键实现注记、测试与验证、版本与发布策略 |
| [SECURITY.md](./SECURITY.md) | 完整安全模型：为什么没有官方审批、HTTP 无鉴权、护栏边界、凭据风险 |
| [PUBLISHING.md](./PUBLISHING.md) | npm + GitHub 发布教程（含 provenance、Trusted Publisher、回滚） |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 开发环境、代码约定、三层测试、PR 要求 |
| [docs/更新记录.md](./docs/更新记录.md) | **完整**改动记录：每个版本修了什么、根因、怎么验证（README 只留最近一次） |
| [CHANGELOG.md](./CHANGELOG.md) | 每个版本的简短发布说明（发版时与 git tag 一起用） |
| [install-deps.sh](./install-deps.sh) | 依赖自检与安装脚本（给人和 AI 用） |

## 许可证

[MIT](./LICENSE) © Mrtime-gege
