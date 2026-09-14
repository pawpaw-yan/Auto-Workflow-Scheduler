#!/usr/bin/env bash
# 按入口文件的扩展名执行项目脚本。
#
# 输入环境变量：
#     ENTRY   入口文件路径，如 python/glados_checkin/index.py

set -euo pipefail

: "${ENTRY:?ENTRY 未设置}"

workdir=$(dirname "$ENTRY")
base=$(basename "$ENTRY")
ext="${base##*.}"

# 切到项目目录再执行，保证项目内的相对导入 / 相对路径正常工作
# （例如 index.py 里的 from logging_config import init_logger）
cd "$workdir"

echo "======== 运行 $ENTRY （工作目录: $workdir） ========"

case "$ext" in
  py)  python "$base" ;;
  sh)  bash   "$base" ;;
  php) php    "$base" ;;
  *)   echo "::error::不支持的入口类型: $ENTRY" ; exit 1 ;;
esac
