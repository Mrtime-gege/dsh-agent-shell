# dsh-agent-shell

> 给 DeepSeek Harness 的持久化多 shell 终端：10 个模型工具 + 右下角一个可拖动、可直接打字的悬浮面板。

[![npm version](https://img.shields.io/npm/v/dsh-agent-shell.svg)](https://www.npmjs.com/package/dsh-agent-shell)
[![npm license](https://img.shields.io/npm/l/dsh-agent-shell.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![CI](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrtime-gege/dsh-agent-shell/actions/workflows/ci.yml)

**中文**（本文件） · [**English**](https://github.com/Mrtime-gege/dsh-agent-shell/blob/main/README.en.md)


## ⚠️ 使用前必读：这是一个真实的 shell，没有任何审批防护

**本插件由 AI 开发**：设计、实现与测试全部由 AI 完成（450+ 条自动化断言 + 真机验证，
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

**需要你（或 AI）单独安装的只有一个系统依赖：**

| 依赖 | 为什么需要 | 怎么装 |
|---|---|---|
| **tmux ≥ 3.x**（3.6b 上验证） | 持久化 shell 的本体；没有它插件完全不能用 | `./install-deps.sh --yes`（自动识别发行版），或 `apt install tmux` / `brew install tmux`；**Windows 请在 WSL 里运行 DSH**（原生 Windows 没有 tmux） |

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
只追"改了必被发现"**：每一次输入、输出、授权/撤销都进审计，审计是哈希链（每条记录携带前一条的
摘要），删一条、改一个字节、调换顺序都会断链，`shell_audit` 与面板 ⓘ 会如实显示「链✓」或
「链⚠断」。

审计目录默认是普通目录（`~/.dsh/agent-shell`），**默认路径 = 篡改可检测**。想要升级为
**不可篡改**，可选加锁（内核级 append-only，需要 root 一次性执行）：

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

