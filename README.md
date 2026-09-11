# dsh-agent-shell

> Persistent, conversation-decoupled multi-shell terminal panel for DeepSeek Harness — 9 model tools plus a draggable floating panel you can actually type into.

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![tmux](https://img.shields.io/badge/tmux-3.x-blue.svg)](https://github.com/tmux/tmux)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-6f42c1.svg)](https://www.npmjs.com/package/@deepseek-ai/dsh-web)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

**中文**（本文件） · [**English**](./README.en.md)

> **本插件由 AI 开发**：设计与实现（含测试）全部由 AI 完成，已有 **157 条自动化断言**
> （51 客户端纯函数 + 79 宿主边界/错误路径 + 27 打包产物冒烟）与真机验证，并已被它自己的
> 测试套件挖出并修掉过 6 个真实缺陷；但**未经人工安全审计**。请把这一点计入你的风险判断。

---

## ⚠️ 使用前必读：这是一个真实的 shell，没有任何审批防护

**这不是沙箱，也不是受限工具。装上它，就等于把一台真机器的终端交给 AI。**

* **AI 能执行任意命令**：`shell_*` 工具直接驱动真实 tmux 会话中的真实 `bash`，
  以**你自己的用户权限**运行。AI 想跑什么就能跑什么 —— 读你的文件、改你的配置、
  发网络请求、装东西、删东西，全都不会被拦。
* **没有任何审批弹窗**。DSH 官方审批（`dsh-user-approval`）在**本插件唯一能工作的模式
  `danger-full-access` 下策略是 `never`** —— 按平台设计，该模式下审批被整体关闭
  （这正是会话里那句「approval prompts are disabled」的含义）。本插件**没有接入**该审批缝，
  所以模型执行命令时**不会**有任何「允许 / 拒绝」的询问。
* **唯一的防线是启发式护栏**（`guardDangerousCommands`，默认开启）：它用 10 条正则匹配
  `rm -rf /`、`mkfs`、`dd of=/dev/*`、`sudo` 等文本。**它可被拼接、变量、脚本文件轻易绕过，
  也会误报**，而且只在「文本里出现关键词」时起作用。**它是减速带，不是防护措施。**
* **HTTP 端点无鉴权**：面板通过宿主 web 服务的 `/plugins/shell/*` 发按键，
  这些路由不校验独立凭据（详见[安全说明](#安全说明)）。
* **面板上的「审批」标记是如实告知，不是开关**：`审批 never` 表示官方审批关闭、
  AI 的命令不会有人问过你。

**请据此决定能不能用**：

| 场景 | 建议 |
|---|---|
| 你自己的开发机，且你接受「AI 可能执行任意命令」 | 可以用，但**重要数据先备份**，且别在里面输入长期凭据 |
| 有不可替代的数据、生产环境、多人在用的机器 | **不要用**。或在容器 / 虚拟机里跑，把爆炸半径限制住 |
| 不受信任的代码或提示注入风险高的场景 | **不要用** |

一个私有 tmux 服务端（`-L dsh-agent`）持有多个命名会话；宿主侧注册 `shell_*` 工具，
并暴露同源 HTTP；客户端在 `shell.overlay`（root 作用域）加一个悬浮面板。

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

## 目录

- [⚠️ 使用前必读：这是一个真实的 shell，没有任何审批防护](#️-使用前必读这是一个真实的-shell没有任何审批防护)
- [特性](#特性)
- [环境要求与兼容性](#环境要求与兼容性)
- [安装](#安装)
  - [⚠️ 两条路只能选一条](#️-两条路只能选一条这条踩过代价是启动直接失败)
  - [配置项](#配置项)
  - [什么时候需要重启](#什么时候需要重启)
- [快速上手](#快速上手)
- [使用：面板（人）](#使用面板人)
- [使用：工具（AI）](#使用工具ai)
- [HTTP API](#http-api)
- [生命周期与孤儿治理](#生命周期与孤儿治理)
- [安全说明](#安全说明)
- [已知限制](#已知限制)
- [版本与发布](#版本与发布)
- [开发与验证](#开发与验证)
- [关键实现注记](#关键实现注记都踩过坑)
- [贡献](#贡献)
- [许可证](#许可证)

## 特性

* **持久化**：shell 活在宿主进程里，**不属于任何一次对话** —— 新开对话、切会话、
  **同进程热重载**（改配置、重挂插件）都不会丢；**重启 `dsh web` 通常也能保住**
  （看门狗会发现新宿主而不收服务端，新宿主直接复用）。
  只有宿主**停得比较久**（超过约 6 秒）或崩溃时才由看门狗收掉，见
  [生命周期与孤儿治理](#生命周期与孤儿治理)。
* **多 shell 并存**：一个私有 tmux 服务端上挂多个命名会话，面板直接切换；
  shell 很多时用选择器（每行带状态点、尺寸、前台命令、缓冲用量），**从 1 跳到 50 是两次点击**。
* **真·终端输入模型**：**没有任何本地缓冲**，每个按键直接进 shell —— 补全、历史、行内光标、
  `Ctrl-R` 全部由 shell 自己的 readline 处理。**兼容中文输入法**（组字状态自己维护，见下文）。
* **悬浮窗**：可拖动、八向缩放、位置与尺寸存 localStorage；**默认锁死**防误触，失焦自动重新上锁。
* **256 色 + 历史回看**：默认取可见屏 + 向上 200 行，`更多历史` 每点一次翻倍（上限 5000 行），
  贴底自动跟随。
* **9 个模型工具**：任何对话的 agent 都能驱动同一批 shell —— **面板看到的和 AI 用的是同一份**。
* **孤儿治理**：刻意脱离进程树的看门狗，harness 被 `kill -9` 或崩溃后也能收掉 tmux 服务端。

> 与内置的行式命令工具的区别：内置工具每次调用独立执行、不开交互式 TTY。
> 需要 `sudo` 交互输密码、`ssh` 登录、`vim` 编辑、`python` REPL 这类**真交互**时，用本插件。

## 环境要求与兼容性

本版本（`0.1.0`）实测通过的组合：

| 项 | 要求 / 实测版本 |
|---|---|
| DSH | `0.1.2-rc.1` 系列 |
| peer：`@deepseek-ai/cordis` | `^4.0.2`（实测 4.0.2） |
| peer：`@deepseek-ai/dsh-tools` | `^0.1.2-rc.1`（实测 0.1.2-rc.1） |
| peer：`@deepseek-ai/schemastery` | `^3.18.0`（实测 3.18.2） |
| peer：`react`（客户端由宿主 web app 提供） | `^18.2.0`（实测 18.3.1） |
| Node | ≥ 20（实测 24.19.0） |
| tmux | 3.x（开发与验证环境 3.6b） |
| 操作系统 | Linux 或 macOS（WSL 亦可）—— 需要有可用的 tmux |
| 会话沙箱 | **必须 `danger-full-access`** —— 受限模式下 tmux 服务端无法跨调用共享，原因见[安全说明](#安全说明) |
| 浏览器端 | **无额外依赖**：面板是手写 JS + 内联 SVG，不走打包、不需要构建步骤 |

> ⚠️ **peer 版本的一个坑**：npm 上 `@deepseek-ai/dsh-tools` 的 `latest` dist-tag 仍指向很旧的
> `0.0.1-rc.1`（实际在用的是 `0.1.x-rc.*`）。所以不要用 `npm view ... version` 判断版本，
> 要看 `dist-tags` 或直接看安装树里 `node_modules/@deepseek-ai/dsh-tools/package.json`。

## 安装

从 npm：

```sh
dsh plugin --profile web add dsh-agent-shell
```

或从本地路径 / git：

```sh
dsh plugin --profile web add file:/path/to/dsh-agent-shell
```

`dsh plugin add` 会因为本包在 `dsh.bundle` 里声明了 `./cordis.patch.yml`
而**自动把包名写进 `dsh.profile.bundles`** —— 走这一条就够了，**不需要再手工改任何文件**。

装完**重启一次 `dsh web`**（`dsh.client` 的扫描发生在宿主启动时）。

### ⚠️ 两条路只能选一条（这条踩过，代价是启动直接失败）

本包自带 bundle patch，其中 `insert` 了 `id: agent-shell` 这一行。所以**再手工往用户 patch 层
插一行同 id 的行，就会重复**：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
       duplicate loader entry id: agent-shell
```

这不是警告级别的配置问题 —— 它会让 `dsh web` **完全起不来**。两条路是：

| 路线 | 做法 | 特点 |
|---|---|---|
| **bundle（推荐，`dsh plugin add` 的默认行为）** | 只保留 `dsh.profile.bundles` 里的包名 | 零手工编辑，最不容易出错；改动需重启 |
| 用户 patch 层 | 从 `bundles` 里删掉包名，改为在 `profiles/<name>/cordis.patch.yml` 里 `insert` 一行 | 该文件热加载，**改配置**不必重启；但要手工维护，且极易与 bundle 声明撞车 |

无论选哪条，**同一个 `id` 在整份组合里只能出现一次**。改完可以这样自检：

```sh
node -e "console.log(require('$HOME/.dsh/profiles/web/package.json').dsh.profile.bundles)"
grep -n 'agent-shell' "$HOME/.dsh/profiles/web/cordis.patch.yml"   # 走 bundle 时这里应当没有输出
```

### 配置项

`id: agent-shell` 那一行的 `config`（全部可选，下面是默认值）：

```yaml
config:
  socket: dsh-agent                     # 私有 tmux 服务端 socket 名（与用户自己的 tmux 隔离）
  httpBase: /plugins/shell              # 同源 HTTP 前缀
  exposeHttp: true                      # 是否暴露 HTTP（面板依赖它）
  exposeTools: true                     # 是否注册 shell_* 工具
  watchdog: true                        # 脱离进程树的孤儿看门狗
  shell: bash                           # 每个会话启动的程序
  defaultTerminal: tmux-256color        # 写进服务端启动配置的 TERM
  cols: 120                             # 新会话默认列数（夹到 20–1000）
  rows: 32                              # 新会话默认行数（夹到 5–500）
  historyLimit: 100000                  # 每会话滚动缓冲上限（行）
  maxSessions: 8                        # 同时在世的会话数上限
  defaultCwd: ''                        # 新会话起始目录；留空取 $HOME
  guardDangerousCommands: true          # 高危命令启发式拦截（减速带，不是沙箱）
  extendedKeys: false                   # 服务端开启 extended-keys（需 tmux ≥ 3.2，见下）
```

**`extendedKeys`**（默认关）：打开后服务端配置里会多一行 `set -g extended-keys on`，
TUI 程序（pi、codex 之类）才能收到 `Shift+Enter` 这类**带修饰键**的按键；不开时它们会打印
`Warning: tmux extended-keys is off. Modified Enter keys may not work.`。

默认关闭是刻意的：`extended-keys` 需要 **tmux ≥ 3.2**，而它写在服务端启动读的 `-f` 配置里 ——
**未知选项会让服务端起不来**，那种故障很难当场反应过来。已在 tmux 3.6b 上实测开启后
建会话、按键投递、会话存活都正常（`npm run smoke` 覆盖了这条路径）。

### 什么时候需要重启

**ESM 按 file URL 缓存模块**，所以：

* **宿主半（`lib/index.js` / `lib/tmux.js`）改代码**：必须重启 `dsh web`。实测确认，
  改配置能生效、改代码不生效 —— 连换入口文件名都没用（解析出的 URL 不变）。
* **客户端半（`lib/client.js`）改代码**：**热重载**。宿主会监视客户端产物并重新哈希，
  实测同步文件后 entry 的 `rev` 随即变化（`b9b89a09…` → `d0aa09b0…`），刷新页面即可看到。
* **首次安装**：需要重启一次 —— `dsh.client` 的扫描发生在宿主启动时。

## 快速上手

1. 装好并重启后，页面右下角出现胶囊 **`>_ N 🔒`**（N 是 shell 数）。
2. 点胶囊展开面板 → 点 **`＋`** 新建一个 shell。
3. 点右上角**锁图标**解锁 → 直接打字，按键实时进入 shell（`Ctrl-C` 可打断）。
4. 让 AI 干活时它用的是同一批 shell，`shell_list` 就能看到你刚开的那个。

```jsonc
// AI 侧一次调用完成「开 shell → 跑命令 → 读结果」
shell_open  { "name": "build" }                                       // name 是新建时的可选标签
shell_send  { "session": "dsh-build", "text": "make -j8", "keys": ["Enter"] }
shell_read  { "session": "dsh-build" }
```

> **字段名不一样，别混**：只有 `shell_open` 用 `name`（新建时的可选标签），**其余工具一律用 `session`**。
> 参数 schema 里 `session` 是 required，写错会直接收到
> `ToolArgsError: missing required property "session"`。
> 而下面 HTTP API 的请求体**统一用 `name`**。

## 使用：面板（人）

右下角胶囊点开。要点：

* **锁**：默认锁死，输入框禁用并显示「输入已锁定」。点锁图标解锁后才能输入；
  **焦点离开面板会自动重新上锁**，避免误触把内容打进正在跑的 shell。
* **缩放**：面板四边四角共 **8 个缩放手柄**（把鼠标放到边缘即可，右下角有小斜线提示），
  最小 360×220，夹在视口内。**一旦拖动或缩放，面板就完全由自己的矩形决定、不再跟随胶囊** ——
  否则调好的位置会在下次拖胶囊时被打乱。位置与尺寸都存 localStorage，跨刷新保留。
* **重命名 shell**：选择器每行的 `✎`。回车确认、`Esc` 取消、失焦取消；
  名字会自动净化（只留字母数字下划线连字符）并补上 `dsh-` 前缀 ——
  **tmux 会偷偷把 `.` 和 `:` 换成 `_`**，不先净化的话 UI 显示的名字和真实名字就对不上，
  之后按名字操作会找不到会话。重名会被拒绝。

* **切换 shell**：`‹` `›` 挨个切；**shell 很多时点中间的名字（带 ▾）打开选择器** ——
  列出全部 shell，每行带状态点（绿＝停在提示符，琥珀＝有东西在跑）、尺寸、前台命令、
  缓冲用量，点击直接跳过去；行尾悬停出现 `✎`/`✕`；底部一行 `＋ 新建 shell`。
  于是「100 个 shell 从 1 跳到 50」是两次点击，而不是 50 次。
  内部按**名字**而非下标记录当前项：改名或增删都会让列表重排，下标一旦错位面板就会跳错 shell。
* **主动推送**：输入框最右侧的 `⤒` 按钮。这套模型下输入框**本应始终为空**，一旦出现残留
  （自动提交漏了一次），点它就把残留内容送进终端。**检测到残留时按钮会变成琥珀色**提醒你。
  锁定时该按钮禁用 —— 它的作用正是「往终端里送东西」，与锁的语义冲突。
* **输入框**：**真·终端模型，没有任何本地缓冲** —— 每个按键都直接送进 shell，
  于是补全、历史、行内光标、`Ctrl-R` 全部由 shell 自己的 readline 处理，行为与真终端一致。

  | 键 | 行为 |
  |---|---|
  | 可打印字符 | 交给浏览器/输入法写入 → 由 `input` 事件交付给终端 |
  | `Enter` | 回车 |
  | `Tab` / `Shift+Tab` | 补全 / 反向补全 |
  | `↑` `↓` | 历史上下条 |
  | `←` `→` `Home` `End` `Delete` | 行内移动与删除 |
  | `Backspace` | 删字符 |
  | `Ctrl-R` | 反向搜索历史 |
  | `Ctrl-A/E/B/F/K/U/Y/P` | readline 行内操作 |
  | `Ctrl-C/D/L/Z` | 中断 / EOF / 清屏 / 挂起 |
  | `Esc` | 送给终端（例如退出选单） |

  * `Ctrl+V` `Ctrl+X` 等**放行给浏览器**（粘贴/剪切），不抢；
  * 有选中文本时 `Ctrl+C` 也让浏览器复制，不会误发 `SIGINT` 打断正在跑的命令；
  * 粘贴走 `onPaste`，直接送剪贴板文本并**保留换行**（多行粘贴＝逐行执行，与真终端一致）。

  #### 输入法（IME）：为什么可打印字符**不能**在 keydown 里拦

  这是这套输入模型最容易写错的地方。**中文/日文输入法的组字，依赖浏览器对按键的默认处理** ——
  如果在 keydown 里对每个字母都 `preventDefault()` 并直接发送，IME 可能根本收不到那次按键、
  组字起不来。所以这里的规则是：

  * **可打印字符一律不拦**，交给浏览器与输入法，再由 `input` 事件交付给终端；
  * **组字中间态一律放行、且不发送** —— 否则 `n` `ni` `nih` 会被逐个送进终端，
    而不是等 `你好` 提交后整段送出；
  * 组字中的 `Enter`/空格/`Tab`/方向键都是在给输入法选词，**一个都不能抢**；
  * 提交后读走输入框内容并立即清空，让它始终只是「按键捕获面」。

  #### 组字状态必须**自己维护**，不能信事件的 `isComposing`

  这是第二个必须踩过才会信的坑。**Chrome 在组字提交时补的那个 `input` 事件里，
  `isComposing` 常常仍是 `true`**（已知的浏览器不一致），而且各浏览器的事件顺序也不同：

  ```
  Chrome 常见： compositionstart → input(正文, isComposing=true) → compositionend
  Safari 常见： compositionstart → compositionend(正文已在) → input(isComposing=false)
  实测还遇到过： compositionstart → compositionend(此刻值为空!) → input(正文, isComposing=true)
  ```

  只按事件字段判断，第三种顺序就会漏掉整次提交 —— 症状很具体：**提交的汉字滞留在输入框里，
  直到敲下一个字符（比如数字）才和后面的字一起被送走**。

  所以改成 `compositionend` 置位/清位、`input` **只看自己维护的标志**，并叠加两条保险：

  * 事件明确说 `isComposing === false` 时以它为准清标志（防 `compositionend` 缺席导致标志卡死）；
  * 非组字的 `keydown` 顺手清标志；
  * 另挂一个**原生** `compositionend` 监听兜底（React 的合成 composition 事件并非处处可靠）。

  `compositionend` 与 `input` 共用同一套「读走 → 清空 → 发送」，**谁先读到谁生效**，
  因此上面三种顺序都只发一次。

  `decideKey()` / `decideComposition()` 是两个**纯函数**，承载全部上述判断，并作为
  `__decideKey` / `__decideComposition` 暴露出来供离线断言 —— 输入法没法在无 DOM 的环境里
  真跑，只能靠纯函数的单元测试覆盖分支与事件顺序（见[开发与验证](#开发与验证)）。

  > 代价：每次按键是一次 HTTP 往返（已用队列串行化，顺序不会乱），并且屏幕靠轮询更新，
  > 所以每次发送后会额外触发一次**立即刷新**（去抖到约 14 次/秒）—— 否则自己打的字要等到
  > 下一次轮询才看得见，手感会很差。

  > **锁**的意义在这里变得更重要：每一个按键都会直接进终端，所以默认锁死、且**焦点离开面板
  > 自动重新上锁**，避免误触往正在跑的 shell 里灌字符。

* **`＋`** 新建 shell，**`✕`** 关闭当前 shell，**`—`** 收起。
* **拖动**：胶囊可拖动（位置存 localStorage）；面板标题栏同样可拖，拖动整体平移。
  位移 ≤4px 算点击、超过算拖动，拖动后紧跟的那次 click 会被吞掉，不会误展开。
* **看历史**：屏幕区默认取**可见屏 + 向上 200 行**，可滚动。指标行里的
  **`⤒ 更多历史`** 每点一次把取景窗口翻倍（200 → 400 → … → 上限 5000 行）；
  往上翻之后会出现 **`⤓ 回到最新`** 一键回底。**贴底时自动跟随，翻上去就不再打扰你**
  （早先的版本每次刷新都强制滚到底，会把人拽回来）。
* 指标行：名称、尺寸、前台进程、**缓冲 已用/上限 行数**、**已用字节**、是否有人接入、
  **取景窗口**、起始目录、**插件版本**（`v0.1.0 · c11`，报障时直接报这行）。

## 使用：工具（AI）

| 工具 | 参数（★ = required） | 作用 |
|---|---|---|
| `shell_open` | `name?` `cols?` `rows?` `cwd?` | 新建后台 shell，返回首屏（`cwd` 不存在会明确报错，不会静默换目录） |
| `shell_send` | ★`session` `text?` `preKeys?` `keys?` `confirm?` `settleMs?` | 像人一样输入：`preKeys` → `text` → `keys`，一次调用可完成「进插入模式→打字→退出」 |
| `shell_read` | ★`session` | 读当前可见屏 |
| `shell_history` | ★`session` `lines?` | 读滚动缓冲（滚出屏幕的输出） |
| `shell_list` | — | 列出全部 shell 与指标 |
| `shell_resize` | ★`session` ★`cols` ★`rows` | 改尺寸 |
| `shell_rename` | ★`session` ★`newName` | 重命名 shell（自动净化名字并补 `dsh-` 前缀） |
| `shell_close` | ★`session` | 关闭（**幂等**：已经没了也返回成功，并说明没关到） |
| `shell_diagnose` | — | 服务端 / 看门狗 / 起始目录状态 |

`shell_send` 的 `preKeys` / `keys` 收的是 tmux 键名（`Escape`、`C-c`、`Enter`、`Up`…），
`text` 是**原样输入**（不做任何解释）。所以「进 vim 插入模式 → 打字 → 保存退出」是一次调用：

```jsonc
shell_send { "session": "dsh-edit", "preKeys": ["i"], "text": "print('hi')", "keys": ["Escape"] }
```

## HTTP API

面板用它，你也可以用（同源、`127.0.0.1`，**无独立鉴权**，见[安全说明](#安全说明)）：

```
GET  /plugins/shell/list                     会话列表 + 服务端信息
GET  /plugins/shell/screen?name=&lines=      当前屏 + 该会话指标
POST /plugins/shell/keys                     {name, text?, preKeys?, keys?, confirm?}
POST /plugins/shell/new                      {name?, cols?, rows?, cwd?}
POST /plugins/shell/kill                     {name}
POST /plugins/shell/resize                   {name, cols, rows}
POST /plugins/shell/rename                   {name, to}
GET  /plugins/shell/diagnose
```

## 生命周期与孤儿治理

tmux 服务端会 setsid 并 reparent，**harness 退出时的托管进程清理够不到它**（实测：
服务端 `ppid` 不是 harness、`pgid`/`sid` 都是它自己）。所以：

1. **看门狗**（`watchdog: true`）：一个**刻意脱离进程树**的守护进程（`setsid -f`），
   轮询 harness 进程；它消失后杀掉本服务端。这是唯一能覆盖 `kill -9` / 崩溃的手段 ——
   那种情况下进程内任何代码都不会执行。
2. **启动时只做两件事：收养，或重新布防**。pid 文件记着 `"<看门狗pid> <harness pid>"`：
   第二个字段就是**本进程**且看门狗还活着 → **收养**，什么都不动；其余情况 → 只重新布防，
   **绝不清理会话**。
3. **启动时不清会话**（0.1.1 起的行为改动）。旧实现把「pid 文件不是本进程」当作
   「上次崩溃的残留」并清掉会话，但 pid 文件根本区分不出下面三种情况，而它们的正确处置并不相同：

   | 情况 | pid 文件里的 harness | 现在的结果 |
   |---|---|---|
   | 同进程热重载（改配置、重挂插件） | 就是本进程 | 收养，**shell 全保留** |
   | 重启 `dsh web`（快速） | 上一个进程（已消失） | 看门狗守卫发现新宿主 → 不收服务端；新宿主**保留全部 shell** |
   | 宿主停了很久 / 被 `kill -9` | 已消失的进程 | 看门狗收掉服务端 → shell 丢失（这正是孤儿兜底的目的） |

   判断依据是「**会话是用户的，服务端是无状态的**」：多留一个 tmux 服务端几乎无害
   （下次建会话直接复用），而清掉用户正在跑的东西不可逆。想要干净重来请显式
   `killServer()` 或逐个 `shell_close`。

   另外旧实现在这里还依赖「认对 harness pid」，而认错一次就足以误清会话 ——
   所以 0.1.1 把 pid 的取得方式改成了直接使用本进程 pid（插件与 harness 同进程），
   详见 `lib/tmux.js` 里 `harnessPid()` 的注释。
4. **看门狗会自愈**：它会因为一次误判而退出（旧实现的存活判定只容一次失败），退出后
   插件的内存状态却仍是旧值 —— 等于**静默失去全部兜底**。现在每次操作（5 秒节流）都会
   确认它还在，不在就重新布防并把这件事写进日志。

**卸载时刻意什么都不做**：dispose 会在每次配置热重载时执行，若在那里 `kill-server`，
用户每改一行配置都会丢掉全部 shell。真正需要收尾的时刻是 harness 进程结束，那是看门狗的职责。

### 与对话解耦：三个轴都切断

一开始的实现是「跑在某个会话里的动态插件」，那和对话绑死：会话一没，shell 和工具全没。
这里把三个轴逐个切断：

| 轴 | 耦合的做法 | 本插件的做法 |
|---|---|---|
| **生命周期** | 会话内动态插件 | 挂在 **profile（Host 平面）**：tmux 服务端归插件所有，随 harness 进程启停 |
| **UI 作用域** | 会话语义槽位 | **`shell.overlay`**，实测 `scope: root`，切会话乃至无会话时都在 |
| **数据通道** | `harness.handle` / `host.call`（绑定某次 plugin run） | **同源 HTTP**（`ctx.inject(['webServer'])`），浏览器直连宿主 |

再加一条：`shell_*` 工具注册在 Host 层，于是**任何对话的 agent 都能驱动同一批 shell**。

## 安全说明

请在使用前读完这一节。本插件**是有意做成「能在你机器上为所欲为」的工具**，
它适合你信任的个人工作站，不适合多租户或不可信环境。

> 本插件**由 AI 开发、未经人工安全审计**。下面的说明是自述，不是第三方评估结论。

### 为什么这里没有官方审批（这一条最容易被误解）

DSH 自带官方审批：`@deepseek-ai/dsh-user-approval`（服务 `ctx.approval`）＋ 工具管线的
`tools/pre-execute` waterfall —— 任何工具都能返回 `{kind:'ask'}`，由官方 UI 弹出
「允许一次 / 拒绝」，结果记入会话审计日志。**本插件没有接入它**，原因是平台设计上的互斥：

| 会话权限模式 | 官方沙箱 | 官方审批策略 |
|---|---|---|
| `read-only` | read-only | `ask` |
| `workspace-write` | workspace-write | `ask` |
| **`danger-full-access`** | danger-full-access | **`never`（确定性拒绝，不弹 UI）** |

而**本插件必须 `danger-full-access`**（受限模式下 tmux 服务端无法跨调用共享）。
也就是说：本插件能工作的唯一模式，恰好是官方审批被整体关闭的模式。
即使把审批缝接进来，得到的也只会是「自动拒绝」而不是「弹框让你点允许」。

结论：**模型的每一条命令都不会有人问你**。面板状态行上的 `审批 never` 就是在如实标注这件事。
唯一的「确认」是启发式护栏拦下后的 `confirm: true` —— 那要求模型先向你取得口头同意，
但它依赖模型的配合，不是强制机制。

* **HTTP 端点没有独立鉴权**。所有 `/plugins/shell/*` 路由都注册在宿主 web 服务上，
  监听 `127.0.0.1`，与首页的登录门**不是同一套机制**。也就是说：
  能访问你本机这个端口的人（本机其它用户、被 XSS 的页面发起的同源请求、
  任何浏览器里打开的恶意同源页面）就能对你的 shell 发按键。
  缓解：不要改 `httpBase` 之外的暴露方式；不要把它反代到公网；不用时把 `exposeHttp: false`。
* **危险命令护栏不是沙箱**。`guardDangerousCommands` 只是一层**启发式减速带** ——
  它扫的是「你正要输入的文本 + 待提交的那一行」，用词边界匹配
  `rm -rf /`、`mkfs`、`dd of=/dev/*`、`--no-preserve-root` 等模式。
  它**可以被拼接、变量、脚本文件轻易绕过，也会误报**（例如正文里出现 `sudo` 的普通文本、
  或 `[sudo] password for ...` 这类回显）。真正要隔离，请依赖沙箱，而不是它。
* **需要 `danger-full-access`**。受限模式（bwrap、私有 PID 命名空间）下每次调用各自一个沙箱，
  tmux 服务端无法跨调用共享，实测报 `error connecting to /tmp/tmux-1000/... (No such file or directory)`。
  也就是说：**要让它工作，就得放开沙箱**。这是本插件最大的安全代价，请自己权衡。
* **与用户自己的 tmux 隔离**：本插件只用私有 socket（默认 `-L dsh-agent`），
  不会看到、也不会碰你的默认 tmux 会话；反过来它也**看不到**你手工开的 tmux 会话（有意设计）。
* **密码会经过工具参数**：用 `shell_send` 输入 `sudo` 密码时，密码会出现在对话记录与
  工具调用参数里。需要保密的场景请自己改用 `ssh` 密钥、`sudo` 免密等方式。

## 已知限制

* **没有任何官方审批**：模型的命令不会被询问（原因见[安全说明](#安全说明)）。
  本插件能工作的 `danger-full-access` 模式恰好是官方审批关闭的模式。
* **高危命令拦截是启发式减速带，不是沙箱**（同上）。
* **宿主停机超过约 6 秒时，全部 shell 会被看门狗收掉**（崩溃、慢重启都属于这一类）。
  快速重启与热重载则能保留（见[生命周期与孤儿治理](#生命周期与孤儿治理)）。
* 面板是**文本渲染**而非终端仿真：`capture-pane -p` 给出的是渲染后的字符，颜色与属性会丢。
  若要真终端观感，需要浏览器端的 xterm（本部署只有 Node 侧的 `@xterm/headless`）。
* `sudo -i` 这类**登录 shell 里，`pane_current_command` 会一直是 `sudo`**，
  于是面板的状态点会一直显示「有东西在跑」，不会回到绿色空闲态。
* 面板显示的是**客户端构建戳记**（`c11`）与版本号；两者对不上说明浏览器跑的是旧 bundle，
  刷新页面即可。
* 本插件**只显示自己创建的 shell**（有意为之）：它不枚举默认 socket，因此接不进你已有的 tmux 会话。

## 版本与发布

* 版本号遵循 **semver**，当前 `0.x`：**`0.x` 的 minor 可以包含破坏性改动**，
  patch 只做修 bug。UI 与工具名在同一 minor 内保持稳定。
* 每个版本必须有对应的 `CHANGELOG.md` 段落；`npm run release:check` 会强制校验
  **版本号 ⟷ CHANGELOG ⟷ 客户端面板版本戳记**三者一致，不一致直接失败。
* 面板指标行会显示 `v<版本> · <构建号>`，用户报障时直接报这一行即可。
* dist-tag：正式版走 `latest`；预发布用 `npm publish --tag next`，不会污染 `latest`。
* 发布流程（npm + GitHub、provenance、回滚策略）见 [PUBLISHING.md](./PUBLISHING.md)。

## 开发与验证

```sh
npm run check          # node --check 三个文件（语法）
npm test               # 客户端纯函数 + 宿主边界与错误路径（下面两行）
npm run test:client    # 51 条断言：keydown 判定与输入法组字状态机（零依赖，永远可跑）
npm run test:edge      # 67 条断言：参数边界/错误路径/护栏/HTTP 畸形输入（需 peer + tmux）
npm run smoke          # 打包产物冒烟：解包 → 假 ctx → 真实 tmux 跑通主流程（需 peer + tmux）
npm run release:check  # 发版不变量：版本/CHANGELOG/files 白名单/peer/泄漏/客户端形态
scripts/dev-sync.sh    # 把源码同步到 profile 的安装位置
```

三层测试各管一段，缺一层就会漏掉一类问题：

| 测试 | 管什么 | 需要什么 |
|---|---|---|
| `test:client` | 面板里最容易写错、最难复现的两块纯逻辑（按键判定、输入法组字），含三种浏览器事件顺序 | 无（连 React 与 tmux 都不需要） |
| `test:edge` | 输入边界与错误路径：名字净化、尺寸夹取、不存在的会话/目录、护栏真阳假阳、HTTP 畸形请求 | peer + tmux |
| `smoke` | 真实打包产物的主流程与生命周期（收养/自愈） | peer + tmux |

必须同步的原因：pnpm 对 `file:` 依赖是**拷贝**而非符号链接；而符号链接又行不通 ——
Node 的 ESM 解析走 realpath，一旦链到本包目录，插件自己的 `@deepseek-ai/*` 依赖就解析不到了
（那些装在 `.dsh/profiles/node_modules` 下）。

同步之后：**客户端改动静刷新页面**，**宿主改动要重启 `dsh web`**（ESM 模块缓存）。

### `npm run smoke`：对着真实发布物测

它验证的不是源码目录，而是**用户真正装到的东西**：自己 `npm pack` 到临时目录 → 解包 →
链上宿主 peer → 用一个假 `ctx`（包一层 `child_process.spawn` 当 `subprocess`、假 timer、
假 `webServer`）调 `apply()` → 然后**同时**走工具路径与 HTTP 路径驱动一个私有 socket 上的
真 tmux：建会话、发按键、读屏、读历史、改名、缩放、关闭，最后确认会话清空。

peer 目录按 `argv[3]` → `DSH_PEERS_DIR` → Node 向上解析的顺序查找，找不到就**跳过**
（退出码 0）并打印怎么补；CI 里用 `SMOKE_REQUIRE=1` 把它变成硬失败，免得静默通过。

```sh
DSH_PEERS_DIR=~/dsh-webui npm run smoke
```

三个可用于离线验证的抓手：

* **发布物整体**：上面的 `npm run smoke`。
* **宿主半**可以脱离 DSH 验证：用一个假 ctx 直接调 `apply()`，把工具注册、HTTP 路由、生命周期、
  看门狗全跑一遍，这样在重启前就能排掉 `apply()` 的运行期错误。

  ```js
  import { apply, name, inject } from '<安装位置>/lib/index.js'
  // 用假 subprocess（包一层 child_process.spawn）/ timer / webServer 构造 ctx
  // 注意：ctx.effect 必须**立即调用**回调并保存其返回的 disposer（Cordis 语义）
  apply(ctx, { socket: 'probe', httpBase: '/plugins/shell', watchdog: false })
  ```

  `lib/tmux.js` 的驱动层也可以单独测：同样包一层 `subprocess` 桩，直接调 `TmuxDriver` 的方法。
* **输入法逻辑**：`lib/client.js` 把两个纯函数 `__decideKey` / `__decideComposition`
  挂在插件对象上，可以在无 DOM 的 `node:vm` 里加载后直接断言事件顺序。

## 关键实现注记（都踩过坑）

* **`history-limit` 必须放进 `-f` 读的配置文件**。事后 `set-option -g` 不生效 —— 服务端是被
  第一条 `new-session` 启动的，之前 `set-option` 会因「没有服务端」失败，会话上限停在默认 2000。
  而事后 `set-option -w` 也改不动已存在窗格的上限（实测仍是 2000）。
* **绝对不要设置 `window-size manual`**（tmux 3.6b 的坑，代价很大）。设为 `manual` 之后
  **服务端会在随后退出**：下一条 `new-session` 报 `server exited unexpectedly`，其上的全部
  会话一并消失；放进 `-f` 配置文件里则直接让服务端起不来。逐项二分确认过 ——
  `status` / `mouse` / `escape-time` / `window-size latest` 都无害，只有 `manual` 致命。
  注意这个坑的隐蔽处：设置当时返回 `exit=0`、`show-options` 也能读出新值，**只有等到下一次
  建会话才会暴露**。不设它就沿用 tmux 默认的 `window-size latest`：detached 时保持创建尺寸，
  有人 attach 围观时窗格跟随对方终端尺寸（可接受；需要时用 `shell_resize` 改回来）。
* **`capture-pane` 不带 `-S` 只返回可见屏**，也就是窗格高度那么多行。要历史必须显式给行数，
  否则表现就是「历史记录很短」—— 而 tmux 里其实囤着（实测：窗格 32 行、历史 157 行、上限 10 万）。
  `/screen` 在缺省 `lines` 时正是这个行为，所以客户端必须传 `&lines=N`。
* **`#{history_size}` 要等输出滚完再读**：命令刚发出 0.8s 时可能仍是 0，1.2s 后才正确。
  面板按 700ms 轮询，会自动收敛。
* **`shell.overlay` 整层默认点击穿透**，条目必须显式 `pointerEvents: 'auto'`。
* **`#{session_width}` 不是合法格式变量**（会渲染成字面量），尺寸要用
  `#{window_width}x#{window_height}`。

## 贡献

欢迎 Issue 与 PR，见 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全检查清单在
[SECURITY.md](./SECURITY.md)。

## 许可证

[MIT](./LICENSE) © Mrtime-gege
