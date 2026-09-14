#!/usr/bin/env bash
# 把项目脚本的执行输出渲染成 Markdown，写入 GitHub Job Summary。
#
# 用法：在 workflow 里作为独立 step 调用。
#       建议加 `if: always()`，这样脚本失败时也能把已产生的输出带出来。
#
# 输入环境变量：
#     ENTRY           入口文件路径，用于定位输出文件所在目录（必填）
#     OUTPUT_FILE     输出文件名（相对入口所在目录），默认 output.log
#     SUMMARY_TITLE   摘要标题，默认「执行输出」
#
# 本地运行时没有 GITHUB_STEP_SUMMARY，脚本会直接跳过，不报错。

set -uo pipefail

: "${ENTRY:?ENTRY 未设置}"

title="${SUMMARY_TITLE:-执行输出}"
output_path="$(dirname "$ENTRY")/${OUTPUT_FILE:-output.log}"

# 非 GitHub Actions 环境（本地运行）直接跳过
if [ -z "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "未检测到 GITHUB_STEP_SUMMARY（本地运行），跳过摘要写入"
  exit 0
fi

if [ ! -f "$output_path" ]; then
  echo "未找到输出文件 $output_path，跳过摘要写入"
  exit 0
fi

line_count=$(wc -l < "$output_path" | tr -d ' ')

{
  echo "## $title"
  echo ""
  echo "<details open>"
  echo "<summary>完整输出（${line_count} 行）</summary>"
  echo ""
  # 用 4 个反引号包裹：输出里万一出现 ``` 也不会截断代码块
  echo '````text'
  cat "$output_path"
  echo '````'
  echo ""
  echo "</details>"
} >> "$GITHUB_STEP_SUMMARY"

echo "已写入 Job Summary（来源: $output_path，共 ${line_count} 行）"
