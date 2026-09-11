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
* **HTTP 端点无独立鉴权**，面板走的就是这条同源 HTTP 通道。
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

| 项 | 要求 |
|---|---|
| DSH | `0.1.2-rc.1` 系列 |
| peer | `@deepseek-ai/cordis` ^4.0.2、`dsh-tools` ^0.1.2-rc.1、`schemastery` ^3.18.0、`react` ^18.2.0 |
| Node | ≥ 20 |
| tmux | 3.x（开发与验证环境 3.6b） |
| 操作系统 | Linux 或 macOS（WSL 亦可） |
| 会话沙箱 | **必须 `danger-full-access`** —— 受限模式下 tmux 服务端无法跨调用共享 |
| 浏览器端 | 无额外依赖：手写 JS + 内联 SVG，不走打包、无需构建 |

> peer 版本有个坑：npm 上 `@deepseek-ai/dsh-tools` 的 `latest` 仍指向很旧的 `0.0.1-rc.1`，
> 别用 `npm view ... version` 判断版本，看 `dist-tags` 或安装树里的 `package.json`。

## 安装

```sh
dsh plugin --profile web add dsh-agent-shell    # 或 file:/path/to/dsh-agent-shell
```

`dsh plugin add` 会读到本包的 `dsh.bundle.patch`，自动把包名写进 `dsh.profile.bundles`，
**不需要再手工改任何文件**。装完**重启一次 `dsh web`**。

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

14 个参数：`socket` `httpBase` `exposeHttp` `exposeTools` `watchdog` `shell` `defaultTerminal`
`cols` `rows` `historyLimit` `maxSessions` `defaultCwd` `guardDangerousCommands` `extendedKeys`。
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
| `shell_diagnose` | — | 服务端 / 看门狗 / 起始目录 / **审批状态** |

`shell_send` 的 `preKeys` / `keys` 收 tmux 键名（`Escape`、`C-c`、`Enter`、`Up`…），`text` 原样输入：

```jsonc
shell_send { "session": "dsh-edit", "preKeys": ["i"], "text": "print('hi')", "keys": ["Escape"] }
```

> **字段名差别**：只有 `shell_open` 用 `name`（新建时的可选标签），**其余工具一律用 `session`**，
> 写错会直接收到 `ToolArgsError`。而 HTTP 请求体**统一用 `name`**。

## HTTP 端点

面板用它，你也可以用（同源、`127.0.0.1`、**无独立鉴权**）：

```
GET  /plugins/shell/list                     会话列表 + 服务端信息（含 approval 情报）
GET  /plugins/shell/screen?name=&lines=      当前屏 + 该会话指标
POST /plugins/shell/keys                     {name, text?, preKeys?, keys?, confirm?}
POST /plugins/shell/new                      {name?, cols?, rows?, cwd?}
POST /plugins/shell/kill                     {name}
POST /plugins/shell/resize                   {name, cols, rows}
POST /plugins/shell/rename                   {name, newName}
GET  /plugins/shell/diagnose
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

## 更新与修复记录

这里是**全部**改动记录，每条都写明**根因**与**验证方式** —— 只写「修了什么」而不写「为什么坏、
怎么确认修好了」，下次还会踩同一个坑。逐版本的发布说明另见 [CHANGELOG.md](./CHANGELOG.md)。

### 0.1.2 — 设置页真正可用（并修掉一个静默失效）

#### 修复

- **设置功能此前一直是坏的：卡片看着注册上了，改设置却永远不生效。**
  根因：`state` 被声明在设置注册**之后**，而官方 `installSection` 在注册时会**同步**回调一次
  `onChange` → `applyResolved` → 读 `state` → TDZ `ReferenceError`，异常被注册用的 `try/catch`
  吞掉。后果不是「报错」而是**静默失效**：`scope.watch` 根本没挂上，之后的写入不再触发回调。
  改法：把 `state` 提到注册之前，并在代码里写清这个顺序为什么不能动。
  这个 bug 能藏住的原因值得记一笔 —— 旧断言只检查「注册桩被调用过」，而这些在崩溃**之前**
  就已经成立。现在断言的是**结果**：注册日志里不该有异常、面板 note 必须是成功文案、
  `validate` 必须收到套过默认值的完整配置、组合配置越界时必须不崩且如实告知。
- **`/list` 的 `settings.live` 不再谎报**：它原先只表示「设置服务挂载了」。现在
  `live` = 用户**真的能在设置页改**（注册成功），并分开报告 `service` / `registered`；
  组合配置越界时面板写「设置页未注册：<原因>（插件仍按组合配置运行）」，
  而不是谎称可用、让用户去设置页找一张不存在的卡片。
- **看历史时不再被新输出顶上去**：屏幕取景窗口是「最后 N 行」，新输出会把**最上面**的行挤掉，
  所以「`scrollTop` 没变」并不等于「阅读位置没变」。旧实现只在贴底时才滚 —— 翻上去之后确实
  不滚了，但内容整体上移仍会把你正在读的那几行顶走。现在：**贴底照旧跟随；非贴底按内容
  整体位移补偿**（窗口下滑 K 行补 K 行高度；点「更多历史」在顶部插入 P 行则反向补偿 P 行）。
  判定抽成纯函数 `scrollAnchor()` / `contentShift()`，判不准（内容被整屏换掉、整屏都是重复行、
  重叠不足 3 行）时**宁可不补偿也不乱跳**。行高按 `(scrollHeight − padding) / 行数` 精确计算，
  内边距由 `SCREEN_PAD_Y` 同时供给样式与补偿，避免两边各自写死而漂移。
- **切换 shell 时回到「跟随最新」**：在 A 会话翻着历史（已脱离底部）再切到 B 会话时，
  阅读位置被带了过去 —— 新会话停在半空、不跟随。现在 `expanded` / `currentName` 变化即重置为
  跟随；「更多历史」翻倍窗口**不会**重置（那是同一个视图，位置要保持）。

#### 新增

- **设置页真正可用**：`ctx.settings.installSection` 注册 `dsh-agent-shell` namespace，
  在 **DSH 设置 → 插件**里直接改 **14 个参数**，不必改 `cordis.patch.yml`、多数项也不必重启。
  **每个字段都带 `.description()`** —— 设置页的表单就是由 schema 生成的，没有说明的字段在
  用户眼里只是一个光秃秃的键名（`httpBase` 是干什么的？），所以说明里逐条写明**立即生效**还是
  **需重启**。两条机械不变式守着它：新增字段漏了说明 fail；说明没写清生效时机也 fail。
- **设置页取值校验**（`validateSettings`）：`cols` 20–1000、`rows` 5–500、`historyLimit`
  100–1000000、`maxSessions` 1–64、`socket` 只允许字母数字下划线短横线、`httpBase` 必须以 `/`
  开头、`shell` 不能为空 —— 越界**当场拒绝并给出范围**（`cols 必须在 20–1000 之间（现在是 5000）`），
  不再悄悄改小。schema 本身保持宽松：`cordis.patch.yml` 里的越界值仍按老规矩在用时夹住，
  不会因为一条 YAML 就让插件装不上。
- **面板 ⓘ 详情层新增「参数设置」一行**，三态如实分开：

  | 显示 | 含义 |
  |---|---|
  | `已接入（DSH 设置 → 插件里改）` | 注册成功，现在就能去设置页改 |
  | `未注册：<原因>` | 服务在、但注册被拒（例如 `shell 不能为空`）；悬停看完整原因 |
  | `未知（宿主未上报，需重启 dsh web）` | 老宿主（0.1.2 之前）的 `/list` 里没有这个字段 —— 如实说不知道，不猜成「已接入」 |

#### 测试（本次）

- 断言总数：客户端 **183**、宿主边界 **127**、冒烟 **27**，加 `check` 与 `release:check` 全绿。
- 两个测试能力缺口被补上（它们正是上面两个 bug 藏住的原因）：
  假 React 现在会**真的执行**滚动 effect（按源码特征只挑那一个跑，避免触发 `/list`、`/screen` 的真实轮询）——
  effect 内部的接线错误以前根本测不出来；设置测试桩现在**忠实于真实 `resolve()` 语义**
  （先套 schema 默认值再 `validate`、保存时真的走校验）—— 这才炸出了 TDZ 那条路径。
- 新增的关键不变式：每个参数必须有说明、说明必须写清生效时机、注册必须真的成功（而非
  「桩被调用过」）、越界值必须被拒且信息里带范围、组合配置越界时插件必须照常工作且如实告知。
- 修掉测试自身造出来的假象：遍历事件处理器时 `onScroll` 拿到一个没有滚动几何的假事件，
  `NaN >= NaN` 为假把 `pinned` 误关掉，导致一条「失败」其实是测试的错。

### 0.1.1 — 生命周期修复：不再误清会话

0.1.0 发布后在真机上观察到一次「看门狗静默死亡 + 会话被清」的事故，根因是两个用**进程命令行
字符串匹配**认人的判断。本次修掉它们，并补上自愈与回归测试。

**修复**

- **不再靠字符串匹配认 harness**：`harnessPid()` 原先向上找「cmdline 里含 `dsh` 的祖先进程」，
  实测会被**任何**命令行里提到 dsh 的中间进程骗到（真实踩到：一条内容含 "dsh" 字样的
  `bash -c "…"` 被当成了 harness）。改用本进程 pid（插件与 harness 同进程），只在非常规部署下
  才退回向上遍历，且取**最上层**匹配项。
- **启动时不再清理会话**：pid 文件对不上时旧实现会清掉服务端上的全部会话，而它区分不出
  「上次崩溃的残留」与「热重载/重启后幸存的会话」。现在只在「收养已有看门狗」与「重新布防」
  之间选择，**一只会话都不动**。
- **看门狗守卫真的生效了**：原来的 `pgrep -f "dsh web"` 会匹配到看门狗**自己**（脚本文本里就含
  这个字面量），导致守卫恒为真、`kill-server` 永不执行 —— 孤儿兜底等于完全失效。现在排除自身
  pid，并已用「有/无其它实例」两种情形分别验证。
- **存活判定容忍连续失败**：旧写法一次读取失败就让看门狗**永久退出**，从此再无兜底且无人知晓；
  现在连续 3 次（约 6 秒）失败才判定 harness 消失 —— 顺便给快速重启留出窗口。
- **看门狗自愈**：每次操作（5 秒节流）确认看门狗仍在，不在就重新布防并写日志。

**行为变化**

- **重启 `dsh web` 现在通常能保住 shell**：快速重启时看门狗会发现新宿主而不收服务端，新宿主
  复用已有服务端。宿主停机超过约 6 秒（崩溃、慢重启）则仍会被看门狗收掉。
- 启动时不再有任何「清孤儿」动作；想清空请显式 `killServer()` / `shell_close`。

**面板融入 DSH 原生主题**（之前是**一块突兀的黑板子**）

面板原先引用的 `--dsw-alias-bg-primary` / `--dsw-alias-border-primary` 这两个令牌**在 DSH 里
根本不存在**，于是永远落到硬编码的深色上 —— 深色主题色偏，**浅色主题下就是黑板**。按 DSH 的
真实设计语言重做（令牌名与取值取自 `dsh-client-ui-theme`）：

- 表面层级：面板 `bg-layer-1`、弹层（选择器 / ⓘ）`bg-layer-3`、终端区
  `markdown-code-segment-unselected`、输入框 `bg-layer-2`；
- 文字三级：`label-primary` / `label-secondary` / `label-tertiary`；
- 描边统一 **0.5px 发丝线**（DSH 全库只用 .5px）`border-l1` / `border-l2`；
- 按钮改用专用令牌：标题栏 `button-tool-bar-fill/hover`、悬浮胶囊 `button-floating-fill`、
  开关态 `button-ghost-active-fill/border`、主操作（＋）`button-primary-fill` +
  `label-primary-inverted`、危险 hover `interactive-bg-hover-danger`；
- 行 hover / 选中：`interactive-bg-hover` / `interactive-bg-active`；
- **去掉全部装饰性彩色**（原来的蓝色强调）—— DSH 的原生强调是单色的（`brand-primary` 在亮色下
  近黑、暗色下近白），彩色只保留给状态：`state-success/warn/error-primary`；
- 投影由 `0 16px 48px rgba(0,0,0,.5)` 改为轻量的 `0 6px 20px bg-mask-1`。

现在**零硬编码颜色**，亮色/深色两套主题都自动跟随。`npm run release:check` 新增两条不变量
防止复发：客户端引用的每个 `--dsw-*` 令牌必须在官方令牌表内（写错名字会静默回落到 fallback
颜色，浅色主题下必然出错），且不允许出现硬编码颜色字面量。

**安全与知情**（如实告知，而不是加一层防护）

本插件没有接入 DSH 官方审批（`dsh-user-approval` / `tools/pre-execute` → `ctx.approval.request`）。
原因是平台设计上的互斥：官方权限预设把 `danger-full-access` 的策略定为 `never`，而本插件**必须**
`danger-full-access` 才能工作（受限模式下 tmux 服务端无法跨调用共享）。所以不去假装接入，
而是**把这件事如实暴露**：

- `/list` 与 `/diagnose` 新增 `approval` 字段：审批缝是否挂载、权限模式、以及按官方公式推出的
  策略（`never`/`ask`）与一句风险说明。
- 面板状态行新增 **`审批 never`** 标记（`never` 时标红），悬停给出完整风险说明；版本号悬停里
  注明「本插件由 AI 开发，未经人工安全审计」。
- README 顶部醒目告警章节：这是真实 shell、AI 可执行任意命令、没有任何审批弹窗、唯一防线是
  可被绕过的启发式护栏，并给出「什么场景不要用」的对照表；`SECURITY.md` 同步加入
  「没有接入官方审批，而且在这个模式下也接不进来」一条。
- 明确声明：**本插件由 AI 开发，未经人工安全审计。**

**边界与错误路径**（由新增的边界测试套件发现，六个真 bug）

- **会话名里带 `.` 会导致会话彻底失联**：`shell_open` 的净化规则与 `shell_rename` 不一致
  （前者保留点号），而 **tmux 会把名字里的 `.` / `:` 悄悄换成 `_`** —— 于是插件以为叫
  `dsh-a.b`、tmux 里却叫 `dsh-a_b`，之后所有按名字的操作都以 `can't find pane` 失败。
  现在两条路径共用同一套净化规则。
- **服务端刚退出时建会话有约 50% 概率失败**：关掉最后一个 shell（或显式 kill-server）之后立刻
  `new-session`，tmux 会报 `server exited unexpectedly`（实测 8 次失败 4 次，加 300ms 延迟则
  0 次失败）。`create()` 现在按 300/600ms 退避重试，最多 3 次。
- **`cols`/`rows` 没有上限**：荒谬尺寸（如 `cols: 100000`）会把 tmux 的 `width too large`
  原样抛给调用方。现在统一夹到 `1000×500`（下界仍是 20×5）。
- **不存在的 `cwd` 会让工具谎报工作目录**：tmux 对 `-c <不存在的目录>` **不报错**，只会静默
  回落到用户 home（实测 `pwd` 是 `/home/<user>`），而插件把请求的路径当作实际 cwd 报回去。
  现在先验证目录存在，否则明确报 `no such directory: <path>`。
- **关闭会话不幂等**：会话已经不在（或服务端已自行退出）时，`shell_close` 抛 tmux 原始错误、
  HTTP `/kill` 返回 500。面板列表稍旧时用户点 ✕ 就会撞上。现在关闭是幂等的，返回
  `closed:false, reason:'not-found'`，HTTP 仍为 200。
- **HTTP 错误码分不清「调用方写错」与「插件坏了」**：非法 JSON 请求体、缺少 `name` 都返回 500。
  现在统一映射：参数类错误 400，其余 500。

**测试**

- 新增 `npm run test:edge` 与 `npm run test:client`，CI 分别覆盖；`npm test` 一次跑完两者。
- `npm run smoke` 新增 4 组生命周期断言：harnessPid 必须落在本进程祖先链上、pid 文件指向别的
  harness 时会话必须存活、看门狗被杀后必须自愈重布防，以及两条防回归的静态断言
  （守卫排除自身、存活判定有容错）。
- 冒烟测试的清理逻辑补上「回收本次布防的看门狗」，失败路径也不会留守护进程。

### 0.1.0 — 首次发布

**持久化终端**

- 基于私有 tmux socket（默认 `-L dsh-agent`）提供**跨对话存活**的持久 shell：会话由宿主进程
  持有，不属于任何一次对话，新开对话、切会话与**同进程热重载**都不会丢。
- 服务端配置通过 `-f` 在**启动时**写入：`history-limit`、`default-terminal`、关闭
  status / mouse、`escape-time`，避免事后 `set-option` 无法生效的坑。

**9 个模型工具**

- `shell_open` / `shell_send` / `shell_read` / `shell_history` / `shell_list` / `shell_resize` /
  `shell_rename` / `shell_close` / `shell_diagnose`。
- `shell_send` 同时支持一次性输入整条命令与「按键 + 文本 + 按键」的仿真序列
  （`preKeys` / `text` / `keys`），因此 vim 编辑、多行文本、`Ctrl-C` 打断都能在一次调用里完成。
- 输出稳定性检测：`shell_send` 默认等待画面稳定后再返回，避免读到半截输出。

**WebUI 悬浮面板**

- `shell.overlay` 悬浮面板，可拖动、八向缩放、位置与尺寸持久化，支持 256 色。
- 每个按键**实时透传**到 shell，不做缓冲区；配合输入法（IME）状态机正确处理中文上屏。
- 锁定按钮防止误触；失焦自动重新锁定；多 shell 切换（下拉选择）、新建 / 重命名 / 结束 / 最小化。
- 历史回看（`更多历史` 可扩到 5000 行）并带 pinned 感知的自动滚动；主动推送按钮可把当前画面推给模型。

**安全与生命周期**

- 危险命令护栏（默认开启）：作为**启发式减速带**拦截 `rm -rf /`、`mkfs`、`dd of=/dev/*`、
  `--no-preserve-root` 一类模式；明确说明它**不是沙箱**。
- 低权限模式：在 `workspace-write` 等受限模式下会明确报错，建议以 `danger-full-access` 运行。
- 孤儿 tmux 治理：tmux server 会 setsid 脱离宿主，因此额外拉起 detached watchdog 轮询宿主 pid，
  宿主消失即 `kill-server`；watchdog 支持被新宿主**收养**，同进程热重载不会杀掉用户正在用的 shell。

**解耦说明**

- 插件位于 **host 平面**（profile bundle），UI 注册在 `shell.overlay`（root scope），数据走同源
  HTTP。因此 shell 的生命周期与对话解耦：对话结束、插件重载都不影响正在运行的 shell。

**配置与测试**

- `extendedKeys`（默认 `false`）：置 `true` 时服务端启动配置会多一行
  `set -g extended-keys on`，TUI 程序（pi、codex 等）才能收到 `Shift+Enter` 这类带修饰键的按键。
  默认关闭 —— 该选项需要 tmux ≥ 3.2，且写在 `-f` 启动配置里，老版本 tmux 遇到未知选项会导致
  服务端起不来。已在 tmux 3.6b 实测开启后建会话、按键投递、会话存活均正常。
- `npm run smoke`：对**真实打包产物**做端到端冒烟 —— 自行 `npm pack`、解包、只链宿主 peer、
  用假 `ctx` 调 `apply()`，再同时经**工具路径**与**HTTP 路径**在私有 socket 的真 tmux 上建会话 /
  发按键 / 读屏 / 读历史 / 改名 / 缩放 / 关闭。CI 有独立 job 跑它。
- 面板指标行显示 **`v<版本> · <构建号>`**（如 `v0.1.0 · c11`），报障时直接报这一行即可定位版本。
- `npm run release:check`：机械校验**版本号 ⟷ CHANGELOG ⟷ 面板版本戳记**三者一致、`files`
  白名单覆盖运行期文件、入口可达、客户端仍是 classic script、源码未泄漏开发机路径或凭据；
  `npm publish` 前由 `prepublishOnly` 自动执行。

## 详细文档

| 文件 | 内容 |
|---|---|
| [docs/使用细节.md](./docs/使用细节.md) | 配置项全表、何时需要重启、面板完整行为（含输入法的两个坑）、工具与 HTTP 参数细节 |
| [docs/设计与实现.md](./docs/设计与实现.md) | 与对话解耦的设计、生命周期与孤儿治理、关键实现注记、测试与验证、版本与发布策略 |
| [SECURITY.md](./SECURITY.md) | 完整安全模型：为什么没有官方审批、HTTP 无鉴权、护栏边界、凭据风险 |
| [PUBLISHING.md](./PUBLISHING.md) | npm + GitHub 发布教程（含 provenance、Trusted Publisher、回滚） |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 开发环境、代码约定、三层测试、PR 要求 |
| [CHANGELOG.md](./CHANGELOG.md) | 每个版本的发布说明（上面的「更新与修复记录」是同一份内容的门面版） |

## 许可证

[MIT](./LICENSE) © Mrtime-gege
