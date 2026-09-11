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

## 详细文档

| 文件 | 内容 |
|---|---|
| [docs/使用细节.md](./docs/使用细节.md) | 配置项全表、何时需要重启、面板完整行为（含输入法的两个坑）、工具与 HTTP 参数细节 |
| [docs/设计与实现.md](./docs/设计与实现.md) | 与对话解耦的设计、生命周期与孤儿治理、关键实现注记、测试与验证、版本与发布策略 |
| [SECURITY.md](./SECURITY.md) | 完整安全模型：为什么没有官方审批、HTTP 无鉴权、护栏边界、凭据风险 |
| [PUBLISHING.md](./PUBLISHING.md) | npm + GitHub 发布教程（含 provenance、Trusted Publisher、回滚） |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 开发环境、代码约定、三层测试、PR 要求 |
| [CHANGELOG.md](./CHANGELOG.md) | 每个版本的变更（0.1.1 修了什么、为什么） |

## 许可证

[MIT](./LICENSE) © Mrtime-gege
