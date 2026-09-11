# Changelog

本文件记录 `dsh-agent-shell` 的版本变化。

## 0.1.1 — 生命周期修复：不再误清会话

0.1.0 发布后在真机上观察到一次「看门狗静默死亡 + 会话被清」的事故，根因是两个用
**进程命令行字符串匹配**认人的判断。本次修掉它们，并补上自愈与回归测试。

### 修复

- **不再靠字符串匹配认 harness**：`harnessPid()` 原先向上找「cmdline 里含 `dsh` 的祖先进程」，
  实测会被**任何**命令行里提到 dsh 的中间进程骗到（真实踩到：一条内容含 "dsh" 字样的
  `bash -c "…"` 被当成了 harness）。改用本进程 pid（插件与 harness 同进程），
  只在非常规部署下才退回向上遍历，且取**最上层**匹配项。
- **启动时不再清理会话**：pid 文件对不上时旧实现会清掉服务端上的全部会话，而它区分不出
  「上次崩溃的残留」与「热重载/重启后幸存的会话」。现在只在「收养已有看门狗」与
  「重新布防」之间选择，**一只会话都不动**。
- **看门狗守卫真的生效了**：原来的 `pgrep -f "dsh web"` 会匹配到看门狗**自己**（脚本文本里
  就含这个字面量），导致守卫恒为真、`kill-server` 永不执行 —— 孤儿兜底等于完全失效。
  现在排除自身 pid，并已用「有/无其它实例」两种情形分别验证。
- **存活判定容忍连续失败**：旧写法一次读取失败就让看门狗**永久退出**，从此再无兜底且无人知晓；
  现在连续 3 次（约 6 秒）失败才判定 harness 消失 —— 顺便给快速重启留出窗口。
- **看门狗自愈**：每次操作（5 秒节流）确认看门狗仍在，不在就重新布防并写日志。

### 行为变化

- **重启 `dsh web` 现在通常能保住 shell**：快速重启时看门狗会发现新宿主而不收服务端，
  新宿主复用已有服务端。宿主停机超过约 6 秒（崩溃、慢重启）则仍会被看门狗收掉。
- 启动时不再有任何「清孤儿」动作；想清空请显式 `killServer()` / `shell_close`。

### 面板融入 DSH 原生主题

面板之前**没有跟随 DSH 主题**：代码里写的 `var(--dsw-alias-bg-primary, #16181d)` /
`var(--dsw-alias-border-primary, #2a2f3a)` 这两个令牌**在 DSH 里根本不存在**，
于是永远落到硬编码的深色上 —— 深色主题里色偏，**浅色主题里就是一块突兀的黑板子**。

本次按 DSH 的真实设计语言重做配色（令牌名与取值取自 `dsh-client-ui-theme`）：

- 表面层级：面板 `bg-layer-1`、弹层（选择器 / ⓘ）`bg-layer-3`、终端区
  `markdown-code-segment-unselected`、输入框 `bg-layer-2`；
- 文字三级：`label-primary` / `label-secondary` / `label-tertiary`；
- 描边统一 **0.5px 发丝线**（DSH 全库只用 .5px）`border-l1` / `border-l2`；
- 按钮改用专用令牌：标题栏 `button-tool-bar-fill/hover`、悬浮胶囊 `button-floating-fill`、
  开关态 `button-ghost-active-fill/border`、主操作（＋）`button-primary-fill` +
  `label-primary-inverted`、危险 hover `interactive-bg-hover-danger`；
- 行 hover / 选中：`interactive-bg-hover` / `interactive-bg-active`；
- **去掉全部装饰性彩色**（原来的蓝色强调）—— DSH 的原生强调是单色的（`brand-primary`
  在亮色下近黑、暗色下近白），彩色只保留给状态：`state-success/warn/error-primary`；
- 投影由 `0 16px 48px rgba(0,0,0,.5)` 改为轻量的 `0 6px 20px bg-mask-1`。

现在**零硬编码颜色**，亮色/深色两套主题都自动跟随。

`npm run release:check` 新增两条不变量防止复发：客户端引用的每个 `--dsw-*` 令牌必须在
官方令牌表内（写错名字会静默回落到 fallback 颜色，浅色主题下必然出错），且不允许出现
硬编码颜色字面量。

### 安全与知情（如实告知，而不是加一层防护）

本插件没有接入 DSH 官方审批（`dsh-user-approval` / `tools/pre-execute` → `ctx.approval.request`）。
原因是平台设计上的互斥：官方权限预设把 `danger-full-access` 的策略定为 `never`，
而本插件**必须** `danger-full-access` 才能工作（受限模式下 tmux 服务端无法跨调用共享）。
所以本次不去假装接入，而是**把这件事如实暴露**：

- `/list` 与 `/diagnose` 新增 `approval` 字段：审批缝是否挂载、权限模式、以及按官方公式
  推出的策略（`never`/`ask`）与一句风险说明。
- 面板状态行新增 **`审批 never`** 标记（`never` 时标红），悬停给出完整风险说明；
  版本号悬停里注明「本插件由 AI 开发，未经人工安全审计」。
- README 顶部新增**醒目告警章节**：这是真实 shell、AI 可执行任意命令、没有任何审批弹窗、
  唯一防线是可被绕过的启发式护栏，并给出「什么场景不要用」的对照表；`SECURITY.md`
  同步加入「没有接入官方审批，而且在这个模式下也接不进来」一条。
- 明确声明：**本插件由 AI 开发，未经人工安全审计。**

### 边界与错误路径（由新增的边界测试套件发现）

`npm run test:edge`（67 条断言）专打输入边界与错误路径，一上来就挖出六个真 bug：

- **会话名里带 `.` 会导致会话彻底失联**：`shell_open` 的净化规则与 `shell_rename` 不一致
  （前者保留点号），而 **tmux 会把名字里的 `.` / `:` 悄悄换成 `_`** —— 于是插件以为叫
  `dsh-a.b`、tmux 里却叫 `dsh-a_b`，之后所有按名字的操作都以 `can't find pane` 失败。
  现在两条路径共用同一套净化规则。
- **服务端刚退出时建会话有约 50% 概率失败**：关掉最后一个 shell（或显式 kill-server）之后
  立刻 `new-session`，tmux 会报 `server exited unexpectedly`（实测 8 次失败 4 次，加 300ms
  延迟则 0 次失败）。`create()` 现在按 300/600ms 退避重试，最多 3 次。
- **`cols`/`rows` 没有上限**：荒谬尺寸（如 `cols: 100000`）会把 tmux 的
  `width too large` 原样抛给调用方。现在统一夹到 `1000×500`（下界仍是 20×5）。
- **不存在的 `cwd` 会让工具谎报工作目录**：tmux 对 `-c <不存在的目录>` **不报错**，
  只会静默回落到用户 home（实测 `pwd` 是 `/home/<user>`），而插件把请求的路径当作实际
  cwd 报回去。现在先验证目录存在，否则明确报 `no such directory: <path>`。
- **关闭会话不幂等**：会话已经不在（或服务端已自行退出）时，`shell_close` 抛 tmux 原始
  错误、HTTP `/kill` 返回 500。面板列表稍旧时用户点 ✕ 就会撞上。现在关闭是幂等的，
  返回 `closed:false, reason:'not-found'`，HTTP 仍为 200。
- **HTTP 错误码分不清「调用方写错」与「插件坏了」**：非法 JSON 请求体、缺少 `name`
  都返回 500。现在统一映射：参数类错误 400，其余 500。

### 测试

- 新增 `npm run test:edge`（67 条断言）与 `npm run test:client`（51 条断言），
  CI 分别覆盖；`npm test` 一次跑完两者。
- `npm run smoke` 新增 4 组生命周期断言：harnessPid 必须落在本进程祖先链上、
  pid 文件指向别的 harness 时会话必须存活、看门狗被杀后必须自愈重布防、
  以及两条防回归的静态断言（守卫排除自身、存活判定有容错）。
- 冒烟测试的清理逻辑补上「回收本次布防的看门狗」，失败路径也不会留守护进程。

## 0.1.0 — 首次发布

### 持久化终端

- 基于私有 tmux socket（默认 `-L dsh-agent`）提供**跨对话存活**的持久 shell：会话由宿主进程持有，不属于任何一次对话，新开对话、切会话与**同进程热重载**都不会丢。（**重启 `dsh web` 会结束全部 shell**，详见 README 的生命周期一节。）
- 服务端配置通过 `-f` 在**启动时**写入：`history-limit`、`default-terminal`、关闭 status / mouse、`escape-time`，避免事后 `set-option` 无法生效的坑。

### 9 个模型工具

- `shell_open` / `shell_send` / `shell_read` / `shell_history` / `shell_list` / `shell_resize` / `shell_rename` / `shell_close` / `shell_diagnose`。
- `shell_send` 同时支持一次性输入整条命令与「按键 + 文本 + 按键」的仿真序列（`preKeys` / `text` / `keys`），因此 vim 编辑、多行文本、`Ctrl-C` 打断都能在一次调用里完成。
- 输出稳定性检测：`shell_send` 默认等待画面稳定后再返回，避免读到半截输出。

### WebUI 悬浮面板

- `shell.overlay` 悬浮面板，可拖动、八向缩放、位置与尺寸持久化，支持 256 色。
- 每个按键**实时透传**到 shell，不做缓冲区；配合输入法（IME）状态机正确处理中文上屏，`py` + Shift 之类的残留问题已修复。
- 锁定按钮防止误触；失焦自动重新锁定。
- 多 shell 切换（下拉选择，不依赖左右逐步切换）、新建 / 重命名 / 结束 / 最小化。
- 历史回看（`更多历史` 可扩到 5000 行）并带 pinned 感知的自动滚动。
- 主动推送按钮，可把当前画面推给模型。

### 安全与生命周期

- 危险命令护栏（默认开启）：作为**启发式减速带**拦截 `rm -rf /`、`mkfs`、`dd of=/dev/*`、`--no-preserve-root` 等模式；已在 README 中明确说明它**不是沙箱**。
- 低权限模式支持：在 `workspace-write` 等受限模式下会出现明确报错，建议以 `danger-full-access` 运行（README 有说明）。
- 孤儿 tmux 治理：tmux server 会 setsid 脱离宿主，因此额外拉起 detached watchdog 轮询宿主 pid，宿主消失即 `kill-server`；watchdog 支持被新宿主**收养**，同进程热重载不会杀掉用户正在用的 shell。

### 解耦说明

- 插件位于 **host 平面**（profile bundle），UI 注册在 `shell.overlay`（root scope），数据走同源 HTTP。因此 shell 的生命周期与对话解耦：对话结束、插件重载都不影响正在运行的 shell。

### 配置

- 新增 **`extendedKeys`**（默认 `false`）：置 `true` 时服务端启动配置会多一行
  `set -g extended-keys on`，TUI 程序（pi、codex 等）才能收到 `Shift+Enter` 这类带修饰键的按键。
  默认关闭 —— 该选项需要 tmux ≥ 3.2，且写在 `-f` 启动配置里，老版本 tmux 遇到未知选项会导致
  服务端起不来。已在 tmux 3.6b 实测开启后建会话、按键投递、会话存活均正常。

### 测试与文档

- 新增 **`npm run smoke`**：对**真实打包产物**做端到端冒烟 —— 自行 `npm pack`、解包、只链宿主 peer、
  用假 `ctx` 调 `apply()`，再同时经**工具路径**与**HTTP 路径**在私有 socket 的真 tmux 上
  建会话 / 发按键 / 读屏 / 读历史 / 改名 / 缩放 / 关闭。CI 有独立 job 跑它。
- 面板指标行显示 **`v<版本> · <构建号>`**（如 `v0.1.0 · c11`），报障时直接报这一行即可定位版本。
- 新增 `npm run release:check`：机械校验**版本号 ⟷ CHANGELOG ⟷ 面板版本戳记**三者一致、
  `files` 白名单覆盖运行期文件、入口可达、客户端仍是 classic script、源码未泄漏开发机路径或凭据；
  `npm publish` 前由 `prepublishOnly` 自动执行。
- README 增加工具参数表，并明确两种路径的字段差异：**工具用 `session`，HTTP 请求体用 `name`**
  （参数的 required 校验发生在 `execute` 之前，写错会直接收到 `ToolArgsError`）。
- 文档：`README.md`（中文，含设计取舍与踩坑注记）、`README.en.md`（英文）、`SECURITY.md`（安全模型）、
  `CONTRIBUTING.md`（贡献与验证方式）、`PUBLISHING.md`（npm + GitHub 发布教程）。
- CI（语法 + 发布不变量 + 打包试运行 + 冒烟测试）与 tag 触发的发布工作流
  （`npm publish --provenance`，并用 CHANGELOG 段落自动创建 GitHub Release）。
