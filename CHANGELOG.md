# Changelog

本文件记录 `dsh-agent-shell` 的版本变化。

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
