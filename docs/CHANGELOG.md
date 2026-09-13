# Changelog

本文件记录 `dsh-agent-shell` 的版本变化。

## 0.1.6 — control-mode 四十倍提速 + 权限模型 + 安全修复 + 发布卫生

### 新增

- **兼容 DSH 0.1.5**：`subprocess` 改为**声明式硬依赖**（`inject: ['tools','subprocess']`）。
  它是抽象服务、provider 由 dsh-base 挂载，新版组合顺序让 provider 晚于本插件挂载，
  原先 apply 期的一次性 `ctx.get` 会拿到 undefined 并早退 —— 工具、HTTP 路由、面板**全部静默消失**。
  同时修掉审批情报的同类问题：改为调用时读取，并修好一个**从未定义**的 `approvalService`
  （被 try/catch 吞掉，导致"会话级策略覆盖"从未生效）。`release:check` 新增两条不变量守住它们。
- **权限模型：时间 × 能力两个维度**（取代原来的"授权/不授权"两态）。能力三档 —— 完全控制 /
  只读（能看不能输入）/ 完全禁止（碰不到插件功能，但查授权状态不受影响）；时间五档 —— 10 分钟 /
  30 分钟 / 2 小时 / 永久 / 自定义（1 分钟–30 天）。能力门的映射表在 `lib/consent.js`（唯一事实来源），
  工具注册统一包了一层 `guardedTool`，**新增工具自动被管住**（未登记的工具按"需要完全控制"处理）。
  面板头部的盾牌按钮改为授权**浮层**：上半部选档位与有效期并应用，下半部是已授权会话列表
  （**按最近使用排序**、显示会话标题与剩余时间、可逐条撤销）。
- **不会被反复询问**：拒绝或超时后进入**冷却期**（`consentRetryCooldownSeconds`，默认 600 秒），
  期间同一对话不再询问、直接拒绝，并明确要求模型不要再问；「完全禁止」档是持久的"别再问"。
- **归属规则（对 AI 的硬性要求）**：`shell_list` 仍列出所有会话的 shell（可见性保留），每条带 `owner`；
  但**除非用户明确要求，AI 不得对不是它创建的 shell 做任何操作**（不输入、不读取、不关闭、不改尺寸/名字），
  只能如实汇报。规则写进系统提示与 `shell_list`/`shell_send`/`shell_read`/`shell_close` 四个工具描述，
  并由 `release:check` 守着不许被删。用户问过是否做强制隔离，最终选择不做（保活与隔离本质互斥），
  判断权留在用户手里；面板不受此限制。
- **面板顶部的授权按钮（盾牌）**：首次使用确认门的状态一眼可见，也能主动操作 —— 两下即「授权给所有
  对话」（此后不再逐对话询问），已授权时**一下即立即撤销**（通配与逐对话授权一起清掉）。两者都**立刻
  落盘**（`consent.json`）并立刻生效；落盘失败如实报错，而不是界面显示成功、重启后复活。面板跑在
  浏览器侧、不知道「当前是哪个对话」，所以面板能表达的主动授权就是通配语义，撤销也由此成为唯一能
  一次清空的地方。
- **更严格的拦截策略**：危险命令规则 10 条 → 20 条，新增两组此前完全没有保护的规则 ——
  插件自身的命门（`tmux kill-server`/`kill-session`、`pkill|killall tmux`、`pkill|killall node`、
  删除或覆盖 `~/.dsh/agent-shell`、`find -delete` 删状态目录、`rm -rf ~/.dsh`）与发布纪律
  （`npm publish|unpublish|dist-tag|owner|token`、带 `--force|--mirror|--all|--tags` 的 `git push`）。
  同时把"不该误伤"的一侧钉进测试：`npm run release:check`、`npm pack --dry-run`、`git push origin main`、
  `git push backup --force`、发版与备份脚本全部照旧放行。

### 修复

- **跟手：tmux control-mode 长驻客户端（"复用同一个进程"落地）**：把"每个操作 spawn 一个
  tmux 客户端（经 subprocess 服务 ~100ms 固定开销，裸 tmux 只要 4.5ms）"变成"一个长驻
  `tmux -C` 客户端，命令走管道 ≈1ms"。`/screen`、`/list`、守卫扫屏、前台探测、`send-keys`
  （面板逐键）全部优先走它，失败自动退避 60 秒并回退一次性路径。实现中实测钉死了六条 tmux
  3.6b 行为（接入噪声会偷走首条响应、`;` 串联各自成帧、`%output` 只发给 attach 的窗格、
  幻影会话不能杀、`%output` 必须先于帧累积、async 少个 return）—— 详见 docs/更新记录.md。
  测试基建顺带修了两个老 bug：kit 假 subprocess 不支持管道（control 测试永远起不来）；
  kit settings 源缺 socket（带 `__withSettings` 的测试跑在生产服务端上）。
- **审计不再落明文密码**：擦掉历史 3 条（真实密码字样 → `[redacted:password]`），并断源头
  —— 审计输入按"最近观测的前台命令名"脱敏：前台是 shell 照记（命令审计的正主），前台不是
  shell 且非回显型 TUI（vim/nano/less）时不回显、可能是密码，只记脱敏摘要。判据来自
  /screen 与守卫本来就取的 foreground，**不为它多 spawn 任何进程**。
- **面板改名"不生效"**：一个症状、三个独立原因 —— ① `sanitizeName` 只认 ASCII，纯中文名被清成
  空串（400，报错还是英文的），中英混合名（`测试abc`）则**返回 200「成功」但名字静默变成
  `dsh-abc`**；② 报错纯英文，中文界面上看不出所以然；③ 面板改名框的 `onBlur` 是**取消**而不是
  提交，输完名字点一下别处改动就没了。现在净化保留**任何语言的字母与数字**（`\p{L}\p{N}`，
  实测 tmux 对中文会话名的建/定位/改名全部正常），只显式折掉 `.` 与 `:`（tmux 目标语法的分隔符，
  它会把这两个字符**自己归一成 `_`**，留着会让显示名与真实名对不上），长度按码点截断；
  净化改写了输入时宿主返回 `altered`，面板给中性提示、工具回一句说明 —— **不再静默换名**；
  `onBlur` 改为提交，Esc 仍是取消。连带修掉两个由改名触发的缺陷：`owners` 不跟着搬家
  （→ `shell_list` 报 `owner=unknown`，且 `enforceCaptureCap` 找不到留痕文件，
  **该 shell 的输出上限从此不再执行**）；改名**完全没有审计**（而它恰恰改变了审计的主键）。
- **输入 sudo 密码被守卫拦下**：守卫的第二道网（"提交前再看一眼当前输入行"，用来拦分片拼装）
  取的是**整屏最后一个非空行**，这隐含"输入会被回显"的前提 —— 而密码提示**不回显**，
  于是 `[sudo] password for <用户>:` 被当成命令、匹配上提权规则，密码只能靠 `confirm` 才送得进去。
  ssh 的提示语不含危险字样，所以只有 sudo 中招，这也让它一直没被发现。现在给这道网补上前提：
  **只在前台确实是 shell 时才扫屏**（探测失败时跳过，取舍写在代码注释里）；`preKeys` 里带 Enter
  同样算一次提交；拒绝文案改为如实说明是在"待提交输入行"里发现的。
  顺带修掉一条**空断言** —— 原来的分片拼装断言以 `|| typeof x === 'string'` 结尾，恒为真，
  等于没有断言；现要求真的被拦下。
- **`sudo -i` 之后前台探测失效**：tmux 的 `#{pane_current_command}` 在 `use_pty` 下报的是 **sudo**
  （它自己在中间转发 I/O），于是整个 root 会话里每次都报 `foreground: sudo - not the shell`，
  idle 判定整段失灵 —— 它也是上一条的帮凶（前台判定不准，"能不能扫屏"就无从谈起）。
  现在从 `#{pane_pid}` 沿 `/proc` 往下钻穿后转进程（`sudo`/`su`/`doas`/`pkexec`/`runuser`/`setpriv`）
  找到真正持有终端的进程；`ssh`/`wsl`/`docker exec` **刻意不钻**（子进程不在本地树里，报成 ssh 才如实），
  包装器有多个子进程时不猜。进程树只读 `/proc`（不用 `ps`：这条路径每次 send/read 都走，
  经 subprocess 服务起进程实测 60–70ms）；已经是 shell 时直接返回，一次 /proc 都不读。
- **光标被画到本行末尾**：横向位置用 `Range` 实测前缀宽度是对的，但区间取的是"屏幕第一行 → 光标"，
  跨多行时 `getBoundingClientRect()` 返回**并集包围盒**，宽度≈最宽的一行（通常就是整屏宽），
  插入点因此被推到行尾。现在把区间限定在**光标所在的那一行**（行首 → 光标，行首绝对下标 =
  `offset - charIndex`，抽成纯函数 `prefixRangeOffsets`）；没有改用 `getClientRects()` 取最后一片，
  因为那在"光标正好在行首"时有歧义。客户端改动，**刷新页面**即生效。
- **面板刷新不跟手**：先量后改 —— 裸调 `tmux capture-pane` 只要 4.5ms，但经 DSH subprocess 服务
  起一个进程实测 **60–70ms**（每命令一个 systemd scope），而 `/screen` 每次要起两个
  （`capture-pane` + `list-panes`），`/audit` 这种不碰 tmux 的只要 5–12ms —— 延迟来自**调用次数**，
  与载荷大小无关（`lines=0` 与 `lines=200` 耗时相同）。两处改动：① 用 tmux 的 `;` 把
  meta 与屏幕**合并成一次调用**（`captureWithMeta`，meta 走首行、屏幕走其余，切分无歧义），
  守卫的扫屏也走它（否则补"前台是不是 shell"这个前提要给每次 Enter 再加一次 spawn）；
  ② 轮询改**自适应**：屏幕在变（或刚发过按键）走快档 200ms，静满 1.5 秒退回慢档 800ms。
  **没有**绕过 subprocess 服务直调 `child_process`（那会丢掉孤儿回收、超时升级、输出上界与 spill、
  环境清理、可执行文件校验与进程树归属性）；更彻底的做法是 tmux control mode 推送，已记录为后续项。
- **设置卡片与同页原生卡片错位**：三处独立原因 —— ① 三列网格有约 342px 的最小宽度，面板窄时溢出
  卡片边框；② 错误/只读提示是网格子项却没有 `grid-column:1/-1`，挤进第 1 列并把**其后每一行推移一格**；
  ③ 页脚是 body 的兄弟而非子节点，不吃 body 的 16px 内缩。现改为官方 `PluginCard` 的结构与几何
  （根节点 `<li>`、字段纵向堆叠、布尔项走 `toggleRow`、页脚在 body 内、提示是整行 `<p role=status>`），
  外观取值逐项照官方编译产物（16px 圆角、15px/600 标题、`.5px` border-l4、输入框高 34px、
  按钮 5px 14px）—— 早前一版是"凭印象对齐"（12px / 14px / 1px / 8px 12px），逐项都与真值不同。
  顺带删掉一段无引用的死 CSS，并修正官方 `.failed` 用的 `--dsw-alias-label-error` 在部分皮肤里
  **未定义**的问题（改用 `--dsw-alias-state-error-primary`）。测试新增**渲染树结构断言**。
  客户端改动，**刷新页面**即生效，不需要重启。
- **面板横向缩到最小时，头部按钮溢出浮窗**：根因是最小宽度（`MIN_W = 360`）小于头部固定内容之和
  （约 397px）。现在按实际宽度进入**紧凑模式**：先隐藏抓手、计数、标题文字与分隔线 ——
  宁可少显示次要信息，也不让「关闭 / 收起」跑到浮窗外面。

### 安全

- **浏览器面闸门**：这组 HTTP 路由无鉴权，此前任何网页都能对它发跨站「简单请求」——而请求体解析
  **不看 Content-Type**，于是 `POST /plugins/shell/keys` 等于任意网页可使用的远程命令执行（响应读不到，
  但命令已执行）。现在：拒绝 `Sec-Fetch-Site: cross-site`、`Origin` 必须与 `Host` 同源（含拒绝
  `Origin: null`）、写请求必须是 `application/json`（强制预检）、`Host` 必须为回环且端口一致
  （挡 DNS rebinding）。闸门在**路由注册处统一包裹**，新路由不会漏；部署若挂了 DSH 的
  `connection` 服务则优先采用它的围栏与会话校验，否则本地等价实现。
- **配置值 → 命令注入**：`socket` 派生的 conf/pid 路径此前无引号拼进 `sh -c`（6 处）。现在 socket 在
  解析处收敛到 `[A-Za-z0-9._-]` 并如实报告改写，所有 shell 插值统一走 `shQuote`。
- 新增 `allowedHosts`（默认空）：只放宽 `Host` 判定，供反向代理部署使用（否则面板会被自己的闸门
 403）；跨站与 JSON 检查照旧，不接受 `*`，改完立即生效。
- 面板 ⓘ 新增「浏览器面闸门」行；`/list` 与 `shell_diagnose` 上报闸门形态、被拒记录与 socket 收敛提示。
- `SECURITY.md` 重写第 1 条并新增第 8（攻击面清单）、第 9（配置注入面）条，明确区分「已挡住」与
  「接受的风险」。
- **全历史清理**：开发机绝对路径（`/home/<用户名>/…`）与内网地址此前仍留在**已发布版本**和**整部
  git 历史**里（`PUBLISHING.md`、`scripts/test-client.mjs`、`scripts/test-edge.mjs`）。现在把这两个
  标识从全部提交与标签中替换掉并强推（本地对象库 gc 后复查无残留）；0.1.0–0.1.4 的 npm 版本一并撤销。
  注意：GitHub 对「不再被任何引用指向」的旧对象仍可能按 commit SHA 直接取到。本仓库最终用
  **删库重建**解决了这一点（旧对象实测 404，不需要找 Support），代价已核实为 0（0 fork / 0 star /
  0 issue）。npm 侧则把 0.1.0–0.1.4 **全部撤销**：只剩干净的 0.1.5，五个旧 tarball 全部 404。
- 新增 `npm run leak:history`：扫描**全部历史 blob 与全部标签**（此前只有工作树扫描，所以「工作树修好
  了、历史里还留着」这条一直没人拦）。规则与工作树扫描共用 `scripts/lib/leak-rules.mjs`，避免两处
  漂移；顺带补掉规则本身的一个洞 —— 旧规则要求路径结尾带斜杠，于是历史里「测试夹具中一行裸路径」
  这类写法被整类漏掉（拿改写前的镜像跑一遍才发现）。

### 变更

- **看门狗的重启窗口 6 秒 → 60 秒**（`WATCHDOG_MISS_LIMIT` 3 → 30，探测间隔仍 2 秒）。
  这两个常量决定的是"重启 `dsh web` 会不会把用户的 shell 全杀掉"：`systemctl restart` 期间有一段
  **没有任何 dsh 进程**的真空期，脚本末尾那道 `pgrep -f "dsh web"` 守卫只挡得住"新宿主已经起来"，
  挡不住"恰好落在真空期里"的那一次 —— 落在里面就会 `kill-server` 连带清掉所有会话。
  代价如实记下：harness 被 `kill -9` 或崩溃后，孤儿服务端会**多活约 60 秒**才被收掉
  （误杀丢的是用户数据，晚收 60 秒只多占一点内存，选前者）。顺带把钉这个行为的弱断言修实 ——
  原来写的是 `includes('-lt 3')`，而 `'-lt 3'` 是 `'-lt 30'` 的**子串**，改了阈值也照样通过。
- **发布模型：公开仓库只看到版本级提交。** 平时在本地积累提交、用 `scripts/backup-push.sh` 备份到私有
  远端（开发中随时回滚，粒度与 commit message 都在）；发版时用 `scripts/release-prepare.sh` 把自上个 tag
  以来的全部提交**压成一个** `release:` 提交再推，并打 tag 触发发布。压缩不改变工作树内容（脚本校验
  「发布提交的树 == 开发树」，不一致则中止且不推）。中间过程因此对外不可见。
- **只发必要文件**：npm 包里只保留运行与安装真正需要的内容 —— `lib/`、`cordis.patch.yml`、
  `install-deps.sh`、两份 README、`LICENSE`（17 个文件 → 10 个）。`CHANGELOG.md`、`SECURITY.md`、
  `PUBLISHING.md`、`CONTRIBUTING.md`、`docs/` 一律留在仓库：装包的人不需要它们，而每次发布都是把
  开发机信息往公开注册表上搬的一次机会。`release:check` 把这条政策变成机械检查：白名单之外多带
  任何一个文件就 fail。
- 两份 README 里指向仓库文件的相对链接全部改成绝对 URL —— 相对链接在 npm 页面上必然断（解析到
  npmjs.com 而不是仓库），而且它天然指向仓库内部文件，正是「非必要发布」的那些。`release:check`
  现在会拦住新的相对链接，并校验仓库绝对链接指向的文件真实存在。

### 修复

- **`PUBLISHING.md` 曾被别的文档整份覆盖**：发布指南（首行 `# 发布指南`）在 0.1.4 之后被「使用细节」
  的内容整体覆盖，工作树里只剩一份与 `docs/使用细节.md` 近乎相同的文件；而当时所有检查都是绿的 ——
  因为没有任何检查在问「这个文件还是不是它自己」。现在：从 0.1.4 恢复发布指南，被覆盖版本里独有的
  段落（新 shell 的工作目录、`shell_consent` 说明、`✕` 需要点两次）合并回 `docs/使用细节.md`，
  并新增**文档身份检查**：九份文档的首行标题必须与身份一致，且任意两份文档不得有相同的开头。

## 0.1.5 — 首次使用需用户确认（授权门）+ 依赖自检脚本

### 安全

- **泄露排查与根因修复**：`release:check` 的扫描范围此前只覆盖 `lib/*` 与 `package.json`，
  因此漏掉了会被发布的 docs（已发布版本的 `PUBLISHING.md` 里就带着开发机绝对路径，npm 版本不可变）。
  现在扫描整个仓库文本文件，新增主机名/`sk-`/`AKIA` 形态与占位符白名单，并已反向验证；
  生成的 shell 片段统一 `umask 077`（tmux 临时配置、pid 文件、终端留痕文件 644 → 600）。

### 修复

- **光标在空白字符处位置异常**：回退「零宽内联锚点」方案（它会改变文本排版），改回
  「单文本节点 + 绝对定位」；横向用 `Range` 实测光标前缀宽度（DOM 不变 ⇒ 空白字符正常、
  中文也不偏），实测失败才退回单元格估算。
- **设置卡片外观**：按同页原生卡片的实际取值重做（12px 圆角、层背景、旋转 chevron 头部、
  ghost+primary 页脚、原生输入框内边距）。

- **设置页里不出现这一项**：DSH 设置页渲染「宿主 namespace ∩ 注册进 `settings.plugin.item` 的卡片」，
  且插槽 keyed、key 必须等于 namespace（不一致静默不渲染）。现补客户端卡片（读写走 `/settings`，
  宿主侧再走官方 settings 服务），21 项分 4 组、带描述与「需重启」标记、越界当场拒绝、保存后显示结论。
- **光标输入中文后偏后**：不再用「单元格列 × ASCII 宽度」算像素（回退字体下必然偏），
  改为把插入点作为零宽内联元素插入文本流，位置交给浏览器排版。
- **光标在文本少时不显示**：`/screen` 现在保留完整窗格（含结尾空行），工具路径仍裁空行。

### 新增

- **授权门**（`requireConsent`，默认开）：一个对话第一次使用本插件时先向用户确认，同意即授权该
  对话执行任意命令；按对话授权、落盘、热重载不重复问；拒绝时**真的不执行**（不建 shell、不发输入）；
  子代理继承已有授权并如实记录；无提问服务时**拒绝**并指出配置出口；每次确认/拒绝都进审计。
- **`install-deps.sh`**：依赖自检与安装（`--check` 只读、`--yes` 安装），按发行版识别包管理器，
  退出码 0/1 语义明确 —— 给 AI 当作"安装本插件"的入口。
- 面板 ⓘ 新增「首次授权」信息（授权门状态与已授权对话数）。

### 新增

- **真实光标**：读 tmux 光标坐标（并入已有的 `list-panes`，零额外进程）并绘制插入点；
  **只在解锁后显示**（AI 输入/未解锁不画，程序隐藏光标时不画）；单元格→字符映射保证中文行不偏；
  坐标算不出来时**不画**而不是画偏；绝对定位在内容坐标里随内容滚动。

### 修复

- **光标在文本少时不显示**：`screen()` 默认裁掉结尾空行，光标行号「文本行数 − paneHeight + cursorY」
  于是算成负数。现在面板路径保留完整窗格（含空行），工具路径仍裁掉空行。
- **光标在文本少时画偏**：行高此前从 `scrollHeight` 推，而 `scrollHeight` 取「内容高度」与
  「可视高度」中的较大者 —— 内容比视口矮时等于视口高度，行高被高估数十像素（现象：文本少偏、
  文本多正常）。现在行高取自计算样式（`normal` → 字号 ×1.2），量不到就不画；滚动补偿同样
  改用实测行高。

### 修复与改进

- **新 shell 默认在当前对话的工作目录**（`agent.session.header.cwd`）：显式 `cwd` > 对话目录 >
  `defaultCwd`/`$HOME`，返回值标注来源，目录不存在时明确报错。
- **`shell_consent` 工具**：报告本对话是否已授权（含闸门状态/授权列表/撤销方式），描述要求不要例行查询。
- **修掉设置页菜单项不出现**：`ctx.get('settings')` 在 apply 时服务尚未挂载 → 改 `ctx.inject(['settings'])`；
  `approval` / `connection` 同样改为动态读取。
- **面板「关闭」两步确认 + 与「收起」之间加分隔线**（避免误触结束正在跑的进程）。
- `PUBLISHING.md` 新增铁律：**没有维护者明确要求，绝不发布**。

### 变更

- 完整更新与修复记录移入 `docs/更新记录.md`；README 只保留**最近一次**更新。
- 「环境要求」重写：DSH 自身一笔带过，需要单独安装的系统依赖（tmux）重点写。

## 0.1.4 — 可审计与开箱即用

### 新增：审计（L1 输入流水 / L2 输出留痕 / L3 归属标注）

- 输入流水：工具 `shell_send` 与面板 `/keys` 两个唯一入口全部记账（时间、shell、来源、
  发起会话 id、text/keys、护栏决策、结果），**被拦下的企图也记**；`shell_audit` 工具与
  `GET /audit` 提供查询；面板 ⓘ 新增「审计」「输出留痕」两行（含写失败告警）。
- 输出留痕：`pipe-pane` 把终端字节流写到 `output/<shell>-<起始>.log`，**会话关闭后仍在**；
  单会话上限（默认 64 MiB）触顶自动停止并留痕。
- 归属标注 D1：`shell_open` 记录发起会话，`shell_list` 显示 `owner=…`；只标注不拦截
  （测试刻意钉住"非 owner 仍可操作"，防止以后被误改成隔离）。
- 新增配置 `auditDir` / `audit` / `auditRetentionDays` / `captureOutput` / `captureMaxBytes`
  （全部带说明，设置页可改；审计目录 0700、文件 0600、按天轮转）。

### 修复：开箱即用

- **peer 声明改 optional**：profile 的 pnpm 是 `autoInstallPeers: false`，peer 由 DSH 模块代理
  提供；必装声明会导致 pnpm 报警告，npm 更会装进**第二实例**的 cordis/dsh-tools。现在
  `pnpm peers check` 干净。
- **tmux 体检**：启动时探一次版本；缺失时控制台 / `shell_diagnose` / `shell_open` / 面板 ⓘ
  都给出可执行的安装指引，而不是 spawn 的原始错误。
- 修掉 `setOwner()` 覆盖 `owners[name]` 导致 `captureFile` 丢失的 bug（会让留痕上限检查失效）。
- 测试侧：新增 `auditDir` 配置并让测试桩把审计目录指到临时目录 —— 测试不再写进用户真实目录。

## 0.1.3 — 发布链路自动化：推 tag 即发布（带 provenance）

把发布从「本地 `npm publish` + 手工授权」改成 **推 tag → CI 用 OIDC 身份自动发布**。

- 配好 npm **Trusted Publisher**（`npm trust github dsh-agent-shell --file release.yml
  --repo Mrtime-gege/dsh-agent-shell --allow-publish`），仓库里**不再需要 `NPM_TOKEN`**
  —— 没有长期密钥可泄漏，也就不存在密钥轮换这件事。
- 副作用是升级：CI 发布会带上 **provenance 签名**。0.1.0 / 0.1.1 / 0.1.2 都是本地发布，
  `dist.attestations` 为「无」；从本版起为「有」，任何人可以用 `npm audit signatures` 验证
  「这个包确实由这个仓库的这个 commit 构建」。**一条命令就能分辨某次发布是 CI 发的还是手工发的。**
- `PUBLISHING.md` 按新链路重写：4.1 变成默认路线（含本仓库的实际配置与 `npm trust` 命令）、
  4.2 降级为兜底、4.3 增加「用 `dist.attestations` 判断这次是谁发的」、4.4 补上网页等价操作
  以及**最容易踩的坑**（workflow 文件名或仓库名对不上时 CI 只会 403/404，报错不点明是这里配错）。
- 本版就是这条链路的第一次真实发布 —— 不是「配好了应该能用」，而是**让 CI 真的发一次**。

## 0.1.2 — 设置页真正可用（并修掉一个静默失效）

### 新增

- **设置页可用**：`ctx.settings.installSection` 注册 `dsh-agent-shell` namespace，DSH 设置 →
  插件里直接改 14 个参数。每个字段都带 `.description()`（表单就是由它生成的 —— 缺说明的字段
  在用户眼里只是个光秃秃的键名），说明里写明「立即生效」还是「需重启」；新增两条机械不变式：
  任何新增字段漏了说明就 fail，说明没写清生效时机也 fail。
- **设置页取值校验**（`validateSettings`）：`cols`/`rows`/`historyLimit`/`maxSessions` 越界、
  `socket` 含非法字符、`httpBase` 不以 `/` 开头、`shell` 为空 —— 当场拒绝并给出范围，
  不再悄悄改小。schema 本身保持宽松：组合配置里的越界值仍按老规矩在用时夹住，不会因为一条
  YAML 就让插件装不上（注册失败时插件照常工作，面板如实说明原因）。

- **面板 ⓘ 详情层新增「参数设置」一行**：三态分开显示（已接入 / 未注册并给出原因 / 旧宿主
  未上报），「服务挂载了但注册失败」不会被显示成「已接入」—— 否则用户会去设置页找一张不存在的卡片。

### 修复

- **设置功能此前一直是坏的**（本次排查发现）：`state` 曾被声明在设置注册**之后**，而官方
  `installSection` 在注册时会**同步**回调一次 `onChange` → `applyResolved` → 读 `state`
  → TDZ `ReferenceError`，异常被注册的 `try/catch` 吞掉。真实后果是「设置页看起来注册了，
  但 `scope.watch` 根本没挂上，改设置永远不生效」。旧测试只断言了「桩被调用过」，所以一直
  是绿的 —— 现在把 `state` 提到注册之前，并改为断言**结果**（注册日志无异常、面板 note 是
  成功文案、`validate` 收到套过默认值的完整配置、失败路径不崩且如实告知）。
- **`live` 不再谎报**：`/list` 的 `settings.live` 原先只表示「设置服务挂载了」。现在 `live`
  = 用户真的能在设置页改（注册成功），并分开报告 `service` / `registered`。组合配置越界时
  面板写「设置页未注册：<原因>（插件仍按组合配置运行）」。
- **切换 shell 时回到「跟随最新」**：在 A 会话翻着历史（已脱离底部）再切到 B 会话时，
  阅读位置被带了过去 —— 新会话停在半空、不跟随。现在 `expanded` / `currentName` 变化即重置为
  跟随；「更多历史」翻倍窗口**不会**重置（那是同一个视图，位置要保持）。
- **看历史时不再被顶上去**：屏幕取景窗口是「最后 N 行」，新输出会把**最上面**的行挤掉，
  所以「`scrollTop` 没变」并不等于「阅读位置没变」。旧实现只在贴底时才滚，
  翻上去之后虽然不滚了，但内容上移仍会把你正在读的那几行顶走。
  现在非贴底时按**内容整体位移了几行**补偿 `scrollTop`（窗口下滑 K 行补 K 行高度；
  点「更多历史」在顶部插入 P 行则反向补偿 P 行），贴底时照旧跟随。
  判定抽成纯函数 `scrollAnchor()` / `contentShift()`，判不准（内容被整屏换掉、
  整屏都是重复行）时宁可不补偿也不乱跳。新增 24 项离线断言，并让测试**真的执行一次**
  滚动 effect —— 此前假 React 不跑 effect，effect 内部的接线错误根本测不出来。

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
