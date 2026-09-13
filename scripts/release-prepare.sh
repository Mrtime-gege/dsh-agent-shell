#!/usr/bin/env bash
# 发版：把「自上个版本以来的全部开发改动」压成**一个**提交推给公开仓库，并打 tag 触发发布。
#
# 这个仓库的发布模型（维护者要求）：
#   * 公开仓库只应该看到版本级的提交 —— 中间的粒度、commit message、半成品状态都不应该可见；
#   * 私有备份仓库（scripts/backup-push.sh）持续收下全部小提交，供开发中随时回滚；
#   * 推 `v<版本>` tag 就是「发布」的扳机（.github/workflows/release.yml 用 OIDC 发布到 npm）。
#
# 用法：
#   bash scripts/release-prepare.sh 0.1.6            # 预演：只打印会做什么，不改动任何东西
#   bash scripts/release-prepare.sh 0.1.6 --push     # 真的执行（会力推公开仓库 main + 推 tag = 发布）
#
# ⚠️ `--push` 等于**发布**。按仓库铁律，只有维护者本人可以下这个决定 —— 不要代跑。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

VERSION="${1:-}"
PUSH="${2:-}"
BACKUP_REMOTE="${BACKUP_REMOTE:-backup}"
ORIGIN_REMOTE="${ORIGIN_REMOTE:-origin}"

if [ -z "$VERSION" ]; then
  echo "用法: bash scripts/release-prepare.sh <版本号> [--push]"
  echo "例:   bash scripts/release-prepare.sh 0.1.6"
  exit 2
fi
if [ "$PUSH" != "" ] && [ "$PUSH" != "--push" ]; then
  echo "✗ 第二个参数只接受 --push（当前：$PUSH）"
  exit 2
fi

say() { printf '%s\n' "$*"; }
step() { printf '\n── %s\n' "$*"; }

step "0. 前置检查"
[ -z "$(git status --porcelain)" ] || { echo "✗ 工作树不干净，先提交或清理"; exit 1; }
echo "  ✓ 工作树干净"

current="$(node -p "require('./package.json').version")"
if [ "$current" != "$VERSION" ]; then
  echo "✗ package.json 的版本是 ${current}，与要发布的 ${VERSION} 不一致"
  echo "  先把版本号三处同步（package.json / CHANGELOG.md / lib/client.js 的 PKG_VERSION），再跑本脚本"
  exit 1
fi
echo "  ✓ package.json 版本 = ${VERSION}"

if git rev-parse -q --verify "refs/tags/v${VERSION}" >/dev/null; then
  echo "✗ tag v${VERSION} 已存在（发布过的版本不能重发）"
  exit 1
fi
echo "  ✓ tag v${VERSION} 尚未存在"

echo "  · 跑发布不变量检查…"
npm run release:check >/tmp/release-check.out 2>&1 || { tail -20 /tmp/release-check.out; exit 1; }
echo "  ✓ release:check 通过"

BASE_TAG="$(git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null || true)"
[ -n "$BASE_TAG" ] || { echo "✗ 找不到上一个版本 tag，无法确定压缩的起点"; exit 1; }
echo "  ✓ 压缩起点（上个版本）= ${BASE_TAG}"

PENDING="$(git rev-list --count "${BASE_TAG}..HEAD")"
echo "  · 自 ${BASE_TAG} 以来有 ${PENDING} 个提交将被压成 1 个"
[ "$PENDING" -gt 0 ] || { echo "✗ 自 ${BASE_TAG} 以来没有任何提交，没什么可发的"; exit 1; }

step "1. 备份完整粒度到私有远端（${BACKUP_REMOTE}）"
if git remote get-url "$BACKUP_REMOTE" >/dev/null 2>&1; then
  echo "  预演：git push ${BACKUP_REMOTE} main:refs/heads/main --force"
  echo "        （并把上一轮的 wip 顶端打一个归档 tag，避免被覆盖后彻底丢失）"
else
  echo "  ⚠️  没有 ${BACKUP_REMOTE} 远端 —— 粒度历史只存在于本机"
  echo "     先按 scripts/backup-push.sh 的提示建一个**私有**仓库；"
  echo "     如果继续，压缩后这些粒度提交就只剩本机 reflog（几天后会被回收）"
fi

step "2. 在临时分支上把 ${BASE_TAG}..HEAD 压成一个发布提交"
echo "  预演：git checkout -B release-tmp ${BASE_TAG}"
echo "        git merge --squash main        # 取来整棵树（含删除/改名）"
echo "        git commit -m 'release: ${VERSION}'"
echo "        git tag -a v${VERSION}"

step "3. 推公开仓库（只多一个提交）"
echo "  预演：git push --force ${ORIGIN_REMOTE} release-tmp:main"
echo "  预演：git push ${ORIGIN_REMOTE} v${VERSION}     # ← 这一条就是「发布」，CI 用 OIDC 发到 npm"

step "4. 本地 main 归位到发布提交"
echo "  预演：git checkout main && git reset --hard v${VERSION}"

if [ "$PUSH" != "--push" ]; then
  say ""
  say "（预演结束：什么都没改。确认无误后加 --push 真正执行 —— 那一步等于发布。）"
  exit 0
fi

step "执行中（--push）"
if git remote get-url "$BACKUP_REMOTE" >/dev/null 2>&1; then
  old_wip="$(git ls-remote "$BACKUP_REMOTE" refs/heads/main 2>/dev/null | awk '{print $1}')"
  if [ -n "$old_wip" ]; then
    archive="dev-archive-$(date -u +%Y%m%dT%H%M%SZ)"
    git push "$BACKUP_REMOTE" "${old_wip}:refs/tags/${archive}" >/dev/null 2>&1 \
      && echo "  ✓ 上一轮开发线顶端已归档为 tag ${archive}"
  fi
  git push "$BACKUP_REMOTE" main:refs/heads/main --force
  echo "  ✓ 完整粒度已备份到 ${BACKUP_REMOTE}:main"
else
  echo "  ⚠️  跳过备份（没有 ${BACKUP_REMOTE} 远端）"
fi

git checkout -B release-tmp "$BASE_TAG"
git merge --squash main >/dev/null
git commit -q -m "release: ${VERSION}"
git tag -a "v${VERSION}" -m "${VERSION}"
echo "  ✓ 已生成发布提交 $(git rev-parse --short HEAD) 与 tag v${VERSION}"

echo "  · 校验：发布提交的树与开发树逐字节相同"
if [ "$(git rev-parse "v${VERSION}^{tree}")" = "$(git rev-parse "main^{tree}")" ]; then
  echo "  ✓ 树一致 —— 发布出去的正是你测试过的那份代码"
else
  echo "  ✗ 树不一致！中止，未推送任何东西"
  exit 1
fi

git push --force "$ORIGIN_REMOTE" release-tmp:main
git push "$ORIGIN_REMOTE" "v${VERSION}"
echo "  ✓ 已推送 main 与 tag v${VERSION}（CI 将用 OIDC 发布到 npm）"

git checkout -q main
git reset --hard -q "v${VERSION}"
echo "  ✓ 本地 main 已归位到发布提交；完整粒度在 ${BACKUP_REMOTE}:main"

say ""
say "完成。接下来看 GitHub Actions 的 Release 工作流："
say "  * 成功 → npm 上出现 ${VERSION}，并创建 GitHub Release"
say "  * 失败（例如 OIDC 受信发布者未匹配）→ tag 存在但什么都没发出去，修好后重推同一 tag 即可补发"
