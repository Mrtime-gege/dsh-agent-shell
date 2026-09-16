#!/bin/sh
# 把本包同步到 profile 的安装位置。
#
# 为什么需要：pnpm 对 `file:` 依赖是**拷贝**（不是符号链接），所以改了源码后安装
# 位置仍是旧版。而符号链接又行不通 —— Node 的 ESM 解析走 realpath，一旦链到本包
# 目录，插件自己的 `@deepseek-ai/*` 依赖就解析不到了（那些在生产装在
# `.dsh/profiles/node_modules` 下）。
#
# 用法：scripts/dev-sync.sh [目标目录]
#   默认目标：$HOME/.dsh/profiles/web/node_modules/dsh-agent-shell
#
# 同步之后：
#   * **客户端半**（lib/client.js）改动 —— 宿主会重新哈希客户端产物，**刷新页面**即可看到；
#   * **宿主半**（lib/index.js、lib/tmux.js）改动 —— 必须**重启 `dsh web`**：ESM 按 file URL
#     缓存模块，同步文件不会让已加载的模块失效（改文件名也没用，解析出的 URL 不变）。

set -e

SRC=$(cd "$(dirname "$0")/.." && pwd)
DST=${1:-"$HOME/.dsh/profiles/web/node_modules/dsh-agent-shell"}

if [ ! -d "$DST" ]; then
  echo "目标不存在：$DST" >&2
  echo "先执行：dsh plugin --profile web add file:$SRC" >&2
  exit 1
fi

# pnpm 的 `file:` 依赖可能把文件做成**硬链接**（同 inode）：此时 cp 报 "are the same file"
# 并以非 0 退出 —— 内容本就一样，忽略即可（否则 set -e 会在这里中断，后续 lib 一个都同步不了）。
cp -f "$SRC/package.json" "$DST/package.json" 2>/dev/null || true
cp -f "$SRC/cordis.patch.yml" "$DST/cordis.patch.yml" 2>/dev/null || true
mkdir -p "$DST/lib"
# pnpm 可能把某些文件做成硬链接，此时 cp 会报 "are the same file" —— 内容本就一样，
# 忽略即可。
for f in "$SRC"/lib/*.js "$SRC"/lib/*.mjs; do
  cp -f "$f" "$DST/lib/" 2>/dev/null || true
done

# ── 防复发校验（事故 2026-09-13：index.js 开始 import ./pure.mjs，而 glob 只拷 *.js，
#     .mjs 没进 profile → dsh web 加载即 ERR_MODULE_NOT_FOUND → crash-loop）────────
# 按 index.js **实际相对导入**逐条核验目标里存在对应文件：带扩展名按原名，
# 不带扩展名按 ESM 语义依次试 .js/.mjs。缺任何一个 → 同步不完整，直接失败。
MISSING_COUNT=0
for imp in $(grep -oE "from '\./[A-Za-z0-9._-]+(\.(js|mjs))?'" "$SRC/lib/index.js" | sed "s/from '//;s/'//"); do
  base=$(basename "$imp")
  found=0
  if [ -f "$DST/lib/$base" ]; then found=1
  elif [ -f "$DST/lib/$base.js" ]; then found=1
  elif [ -f "$DST/lib/$base.mjs" ]; then found=1
  fi
  if [ "$found" -ne 1 ]; then
    echo "  ✗ profile 缺少被导入模块：$imp（$DST/lib/$base(.js|.mjs) 都不存在）" >&2
    MISSING_COUNT=$((MISSING_COUNT + 1))
  fi
done
if [ "$MISSING_COUNT" -gt 0 ]; then
  echo "dev-sync 失败：$MISSING_COUNT 个被导入的模块未同步到目标 —— 禁止用当前 profile 重启 dsh web" >&2
  exit 1
fi

echo "synced $SRC -> $DST"
