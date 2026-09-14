#!/usr/bin/env bash
# 按入口文件的扩展名执行项目脚本。
#
# 执行期间 stdout/stderr 会同时写入「日志」和「输出文件」，
# 后者由 common/render-summary.sh 渲染进 GitHub Job Summary。
# 日志流不受影响，仍然实时可见。
#
# 输入环境变量：
#     ENTRY         入口文件路径，如 python/glados_checkin/index.py
#     OUTPUT_FILE   输出文件名（相对入口所在目录），默认 output.log

set -euo pipefail

: "${ENTRY:?ENTRY 未设置}"

workdir=$(dirname "$ENTRY")
base=$(basename "$ENTRY")
ext="${base##*.}"
output_name="${OUTPUT_FILE:-output.log}"

# 切到项目目录再执行，保证项目内的相对导入 / 相对路径正常工作
cd "$workdir"

# 之后所有输出同时进日志和文件。
# tee 不加 -a：每次运行都是新文件，避免上一次的残留混进来。
exec > >(tee "$output_name") 2>&1

echo "======== 运行 $ENTRY （工作目录: $workdir） ========"

case "$ext" in
  py)  python "$base" ;;
  sh)  bash   "$base" ;;
  php) php    "$base" ;;
  *)   echo "::error::不支持的入口类型: $ENTRY" ; exit 1 ;;
esac
