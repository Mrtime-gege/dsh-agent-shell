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

cp -f "$SRC/package.json" "$DST/package.json"
cp -f "$SRC/cordis.patch.yml" "$DST/cordis.patch.yml" 2>/dev/null || true
mkdir -p "$DST/lib"
# pnpm 可能把某些文件做成硬链接，此时 cp 会报 "are the same file" —— 内容本就一样，
# 忽略即可。
for f in "$SRC"/lib/*.js; do
  cp -f "$f" "$DST/lib/" 2>/dev/null || true
done

echo "synced $SRC -> $DST"
