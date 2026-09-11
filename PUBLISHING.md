# 发布指南

本文件是 `dsh-agent-shell` 的完整发布教程：**发到 GitHub** 与 **发到 npm** 的全流程，
包含版本策略、自动化检查、provenance、回滚，以及会踩的坑。

按顺序做完即可。第一次发布约 20 分钟，后续每次发版约 3 分钟（见[第 7 节](#7-后续版本发布清单)）。

---

## 0. 一次性准备

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node / npm | ≥ 20（实测 Node 24 / npm 12） | `node -v && npm -v` |
| npm 账号 | 已注册 + **已验邮箱** + 已开 2FA | `npm whoami` |
| 包名 | **`dsh-agent-shell` 在公共 npm 上无人占用**（已核实） | `npm view dsh-agent-shell version` → 期望 `E404` |
| git 身份 | 用于 commit 署名 | `git config user.name && git config user.email` |
| GitHub | 账号；有 `gh` CLI 更省事 | `gh auth status` |

> npm 现在对发布强制要求 **2FA**：`npm publish` 会要一次性验证码（OTP）。
> 如果你在 CI 里发布，用 **Trusted Publisher**（推荐，见 [4.4](#44-可选但推荐在-npm-上绑定-trusted-publisher)）
> 或粒度 access token，不要用账号密码。

**npm 与 GitHub 的关系**：两者互相独立。GitHub 放源码，npm 放可分发的包。
本指南两条都做，npm 上的 `repository` 字段会让 npm 页面显示「源码在 GitHub」。

---

## 1. 发布前自检（已自动化，务必跑）

```sh
npm run check           # 语法：node --check 三个入口文件
npm run release:check   # 发版不变量（见下）
npm pack --dry-run      # 真实打包清单，看有没有漏文件/多文件
```

`release:check` 会机械地卡住这几类事故：

| 检查 | 不通过会怎样 |
|---|---|
| `package.json` 版本号是合法 semver、且**不是 `private`** | 发不出去 / 发出去了也装不上 |
| `CHANGELOG.md` 里有 `## <当前版本>` 段落 | 版本记不住改了什么 |
| `files` 白名单覆盖 `lib`、`cordis.patch.yml`、两份 README、CHANGELOG、LICENSE | 装完之后插件起不来（patch 或入口不在包里） |
| `main` / `exports` 指向的文件**存在且在白名单内** | 用户 `import` 直接 404 |
| `peerDependencies` 覆盖 `@deepseek-ai/cordis`、`dsh-tools`、`schemastery`、`react` | 用户在别的 DSH 版本上炸 |
| `lib/client.js` 仍是 **classic script**（没有 `import`/`export`） | 面板在浏览器里整体崩掉 |
| `lib/client.js` 的 `PKG_VERSION` 与 `package.json` **一致** | 用户报障时报错版本 |
| 源码里没有泄漏 `/home/<user>/` 路径、私钥、npm/GitHub token | 隐私与凭据事故 |
| `cordis.patch.yml` 仍在 insert `id: agent-shell` | 装了但什么也不做 |

`npm publish` 会自动先跑一遍（`prepublishOnly`），所以这一步是双保险；
但**在打 tag 之前**手动跑一次，能避免打出「代码有问题」的 tag。

---

## 2. 决定版本号（版本策略）

### 2.1 语义

当前处于 **`0.x`**：

| 变更 | 版本 | 例子 |
|---|---|---|
| 修 bug、文档、不影响行为的重构 | **patch** `0.1.0 → 0.1.1` | 修 IME 提交时序 |
| 新功能、**`0.x` 下允许的破坏性改动**（改工具名/参数、改 UI 结构、改 HTTP 路由、提高 peer 下限） | **minor** `0.1.1 → 0.2.0` | 新增 `shell_rename` |
| 预发布 | `0.2.0-rc.1` / `0.2.0-beta.2` | 先让少数人试 |

> `1.0.0` 之后语义反转：破坏性改动才升 major。在 `0.x` 阶段请把**破坏性改动写进 CHANGELOG 的醒目位置**。

### 2.2 一次发版必须同步三处（不要漏）

```sh
# 1) 版本号（会顺带打 git tag，见 3.3）
npm version patch --no-git-tag-version     # 或 minor / major，或 npm version 0.2.0-rc.1

# 2) CHANGELOG.md —— 手工加一段，标题必须是 "## <版本>"

# 3) lib/client.js 里的版本戳记（面板会显示给用户看）
```

第 3 步是唯一需要手工改代码的地方，`release:check` 会强制它与 `package.json` 一致：

```sh
grep -n "PKG_VERSION = " lib/client.js     # 改完再跑一次 npm run release:check
```

面板指标行显示 `v0.1.0 · c11` —— 用户报障时直接报这一行，你就能判断他跑的是哪一版。

### 2.3 预发布不要污染 `latest`

```sh
npm version 0.2.0-rc.1 --no-git-tag-version
npm publish --tag next        # 装到 next 上；latest 仍是 0.1.x
# 转正式：改回 0.2.0、更新 CHANGELOG，然后 npm publish
```

---

## 3. 发布到 GitHub

### 3.1 首次：建立仓库

这台机器上**已经**执行过 `git init -b main` 与 `git add -A`（24 个文件已暂存，未提交），
所以下面第 1 步之后可以直接提交。

```sh
cd ~/dsh-agent-shell

# 1) 先配提交署名 —— 没配过身份时 git 会直接拒绝提交（"Please tell me who you are"）。
#    只在没配过的时候需要；配过就跳过。
git config --global user.name  "你的名字"
git config --global user.email "you@example.com"

# 2) 首次提交
git commit -m "feat: dsh-agent-shell 0.1.0 — 持久化多 shell 终端面板"
```

> 想用不同身份提交这个仓库，把 `--global` 换成不带参数（只写入本仓库的 `.git/config`）。
> 提交之后再改身份不会改历史，改历史要 `git commit --amend --reset-author`（未推送时可用）。

用 `gh` CLI（最省事）：

```sh
gh auth status
gh repo create dsh-agent-shell --public --source=. --push
```

> 本机**没有装 `gh`**（`command -v gh` 无输出）。要装：`sudo apt install gh` 后 `gh auth login`；
> 不想装就走下面的手工路线，效果一样。

或者手工：在 GitHub 上新建一个**空仓库**（**不要**勾选 README / .gitignore / LICENSE，
否则会和本地已有的冲突，push 会被拒），然后：

```sh
git remote add origin git@github.com:Mrtime-gege/dsh-agent-shell.git
git push -u origin main
```

### 3.2 仓库专属的占位内容（本仓库已填好）

本仓库的地址已经按实际归属 **`Mrtime-gege/dsh-agent-shell`** 填进去了，这一步通常**不用再做**，
只在换用户/组织名时才需要复查一遍：

```sh
grep -rn "OWNER\|<你的用户名>" . --include="*.md" --include="*.yml"   # 应当只剩 PUBLISHING.md 自己
```

已经就位的位置：

* `README.md` / `README.en.md` 顶部的 **CI 徽章**（指向 `github.com/Mrtime-gege/...`）；
* `.github/ISSUE_TEMPLATE/config.yml` 里的 Discussions 与私有漏洞报告链接；
* `package.json` 的 `author` / `repository` / `homepage` / `bugs`
  —— 用的是 GitHub 的 **noreply 邮箱**（`<数字ID>+<用户名>@users.noreply.github.com`），
  不把真实邮箱写进公开的包元数据与提交历史。数字 ID 可以用
  `curl -s https://api.github.com/users/<用户名> | grep '"id"'` 取到（本项目是 `327958341`）；
* `LICENSE` 的版权行 `Copyright (c) 2026 Mrtime-gege`
  （MIT 保留年份与版权人即可，改这一行不影响其余条款）。

改完 `npm run release:check` 再跑一次，然后提交：

```sh
git add -A && git commit -m "chore: 填上仓库地址与作者元数据"
```

### 3.3 打标签（tag 是「发布」的扳机）

```sh
git tag -a v0.1.0 -m "dsh-agent-shell 0.1.0"
git push origin v0.1.0
```

tag 名必须是 **`v<package.json 里的 version>`**：`release.yml` 会校验两者一致，不一致直接失败 ——
这样能挡住「tag 打了 v0.2.0 但包还是 0.1.0」这种最常见的事故。

打了 tag 会触发 GitHub Actions 的发布工作流：它跑检查 → `npm publish --provenance` →
用对应版本的 CHANGELOG 段落创建 GitHub Release。
**这需要先在仓库里配置 `NPM_TOKEN`**（见 4.1）；没配的话工作流会失败，但 tag 本身没坏，
按 [4.2 本地发布](#42-手工发布本地-npm-publish) 补发即可。

---

## 4. 发布到 npm

有两条路：CI 自动发（推荐，带 provenance）和本地手工发（第一次最直观）。
**任选一条**，不要对同一个版本两条都跑（会撞 `E403: cannot publish over existing version`）。

### 4.1 路线 A：GitHub Actions 自动发布（推荐）

1. 在 npm 上创建 **Granular Access Token**：npmjs.com → Access Tokens → Generate New Token →
   **Granular**，权限选 `Read and write`，**Packages 限定为 `dsh-agent-shell`**，有效期尽量短。
2. GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，
   名字填 **`NPM_TOKEN`**，值粘贴上一步的 token。
3. 推送 tag（3.3），工作流自动完成发布与 Release 创建。

CI 发布的最大好处是 **provenance**：npm 页面会显示「由 GitHub Actions 在某个 commit 上构建」，
用户可以用 `npm audit signatures` 验证。**手工发布没有这个。**

### 4.2 路线 B：手工发布（本地 `npm publish`）

```sh
npm login            # 浏览器/OTP 流程；npm 12 默认走 web 登录
npm whoami           # 必须打印出你的用户名，否则后面必然 401

npm run release:check    # 最后一次自检
npm publish              # package.json 里 publishConfig.access=public，不用再加 --access

# 预发布则用：npm publish --tag next
```

发布成功后会打印 `+ dsh-agent-shell@0.1.0`。

### 4.3 发布后立刻验证（不要只看「成功」两个字）

```sh
npm view dsh-agent-shell version                 # 期望 0.1.0
npm view dsh-agent-shell dist-tags               # latest 指向 0.1.0（预发布则看 next）
npm view dsh-agent-shell files --json            # 期望看到 lib/ 与 cordis.patch.yml

mkdir -p /tmp/pkgcheck && cd /tmp/pkgcheck
npm pack dsh-agent-shell@0.1.0 && tar -tzf dsh-agent-shell-0.1.0.tgz | head -20
```

最后做一次**真实安装**验证（这是唯一能证明 patch 与客户端产物都在包里的办法）：

```sh
dsh plugin --profile web add dsh-agent-shell@0.1.0
# 重启 dsh web，确认：右下角出现胶囊；面板指标行显示 v0.1.0
```

### 4.4 （可选但推荐）在 npm 上绑定 Trusted Publisher

绑定之后，CI 用 **OIDC** 直接发布，**不再需要 `NPM_TOKEN`**，也就没有长期密钥可泄漏：

1. npm 包页面 → Settings → **Trusted Publisher** → 选 GitHub Actions；
2. 填组织/用户名、仓库名 `dsh-agent-shell`、workflow 文件名 `release.yml`（本仓库已就绪）；
3. 之后可以把仓库 Secret 里的 `NPM_TOKEN` 删掉，`release.yml` 里已具备
   `id-token: write` 权限，无需改动。

> 绑定只对**新版本**生效，已发布的旧版本不受影响。

---

## 5. 每个版本的发布清单

```sh
# 1. 改代码、跑检查
npm run check && npm run release:check

# 2. 定版本（三处同步：package.json / CHANGELOG.md / lib/client.js 的 PKG_VERSION）
npm version patch --no-git-tag-version
$EDITOR CHANGELOG.md
$EDITOR lib/client.js            # 只改 PKG_VERSION 那一行
npm run release:check            # 必须通过

# 3. 提交并推到 GitHub
git add -A && git commit -m "release: 0.1.1"
git push

# 4. 打 tag 并推送（触发 CI 发布；若走手工路线则本地 npm publish）
git tag -a v0.1.1 -m "0.1.1"
git push origin v0.1.1

# 5. 验证
npm view dsh-agent-shell version
```

---

## 6. 出问题怎么办（回滚与补救）

| 情况 | 做法 | 注意 |
|---|---|---|
| 刚发的版本有 bug | **发一个 patch**（`0.1.1`），这是最正常的路径 | 用户会按 semver 自动升级到它 |
| 严重问题，必须撤下 | `npm unpublish dsh-agent-shell@0.1.0` | **72 小时内**才允许，且**同一版本号再也发不了**；有依赖者会直接装不上，慎用 |
| 想劝退但保留可安装 | `npm deprecate dsh-agent-shell@0.1.0 "严重 bug，请升到 0.1.1"` | 首选，代价最小 |
| `latest` 指错了版本 | `npm dist-tag add dsh-agent-shell@0.1.1 latest` | 只动标签，不动包内容 |
| tag 打错了 | `git push --delete origin v0.1.0 && git tag -d v0.1.0` | 若 CI 已经发布成功，删 tag 不能让 npm 回滚 |
| GitHub Release 有误 | `gh release delete v0.1.0` | 与 npm 无关 |
| 包内容缺文件 | 修 `files` 白名单 → 升 patch → 重新发布 | 已发布的版本无法原地修改 |

### 常见报错对照

| 报错 | 原因 | 处理 |
|---|---|---|
| `E401 Unauthorized` / `ENEEDAUTH` | 没登录或 token 失效 | `npm login` / `npm whoami` |
| `E403 cannot publish over existing version` | 该版本号已存在 | 升版本号，**不要**重复发同一版本 |
| `E403 ... 2FA` | 没提供 OTP | 交互式发布，或用带 `--otp=123456` / automation token |
| `E402 Payment Required` | registry 配成了私有源 | `npm config get registry` 应为 `https://registry.npmjs.org/` |
| `EPUBLISHCONFLICT` | 包名被别人占了 | `npm view dsh-agent-shell` 确认 |
| `E422` / `EOTP` | 2FA / OTP 相关 | 检查账号 2FA 设置 |
| CI 里 `npm publish` 401 | `NPM_TOKEN` 没配或过期 | 重新生成 granular token；或改用 Trusted Publisher |
| 启动报 `duplicate loader entry id: agent-shell` | 同时用了 bundle 和手工 patch 行 | 见 `docs/使用细节.md`「两条路只能选一条」 |

---

## 7. 关于「第一次发布」的特别提醒

* **第一次发布不可逆的只有包名**：`dsh-agent-shell` 一旦发布就是你的（同名后来者无法发布）。
  版本号可以不断加，所以**不要**为了「完美」推迟——0.1.0 有瑕疵，发 0.1.1 就好。
* **先发 GitHub、再发 npm**：npm 页面需要仓库地址才有意义，而仓库先建好还能让 CI 路线一次跑通。
* **元数据可以后补**：`author` / `repository` 缺失只是 npm 页面难看，不影响安装；
  补完之后升一个 patch 版本即可生效（npm 页面上的元数据以最新版本为准）。
* **发布前最后一道人工检查**：`git status` 干净、`npm pack --dry-run` 的文件清单符合预期、
  `CHANGELOG.md` 读起来像人写的（用户就是靠它决定要不要升级）。
