#!/usr/bin/env bash
# 把本地全部分支与标签备份到**私有**远端，用于「随时回滚」。
#
# 为什么需要它：公开仓库 main 只在发版时推一次（一次推送 = 一个版本），
# 所以两次发版之间的本地提交在公开远端是看不到的 —— 机器要是这时候坏了就丢了。
# 这条通道专做备份，与公开仓库的发布推送互不干扰。
#
# 用法：
#   bash scripts/backup-push.sh              # 备份到 backup 远端
#   bash scripts/backup-push.sh <remote>     # 指定远端名
#
# 安全前提：**备份远端必须是私有仓库**。在公开仓库开 wip/dev 分支是没用的 ——
# 分支一样公开可见，所以脚本会去问 GitHub API：能匿名读到就拒绝推送。
set -euo pipefail

REMOTE="${1:-backup}"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "✗ 还没有名为 ${REMOTE} 的远端。先在 GitHub 建一个 **Private** 仓库，然后："
  echo
  echo "    git remote add ${REMOTE} git@github.com:<你的账号>/<开发仓库名>.git"
  echo
  echo "  建好后重跑本脚本。"
  exit 1
fi

URL="$(git remote get-url "$REMOTE")"

# 从 URL 里取 owner/repo（兼容 git@github.com:owner/repo.git 与 https://…）
SLUG="$(printf '%s' "$URL" | sed -E 's#^.*[:/]([^/]+/[^/]+)$#\1#; s#\.git$##')"
if printf '%s' "$SLUG" | grep -q '/'; then
  if curl -sf -m 20 "https://api.github.com/repos/${SLUG}" >/dev/null 2>&1; then
    echo "✗ ${SLUG} 是**公开**仓库（GitHub API 不登录也能读到）。"
    echo "  备份必须用私有仓库 —— 否则本地的小提交照样公开可见，这条通道就失去意义了。"
    exit 1
  fi
  echo "· 远端 ${SLUG} 不是公开仓库 ✓（私有或尚未创建）"
else
  echo "· 远端 ${SLUG} 不是 GitHub 地址，跳过公开性检查（本地路径/其它托管）"
fi

echo "→ 备份到 ${REMOTE}（${URL}）"
git push "${REMOTE}" "refs/heads/*:refs/heads/*" --prune
git push "${REMOTE}" --tags

echo
echo "✓ 备份完成"
echo "  分支: $(git for-each-ref --format='%(refname:short)' refs/heads | tr '\n' ' ')"
echo "  标签: $(git tag | tr '\n' ' ')"
echo "  提交: $(git rev-list --count HEAD) 个（HEAD = $(git rev-parse --short HEAD)）"
echo
echo "  回滚提示：备份里有全部提交与标签，但**公开仓库的 main 只在发版时前移** ——"
echo "  要回滚到某个已发布版本，用对应的 v<版本> tag 作为锚点。"
