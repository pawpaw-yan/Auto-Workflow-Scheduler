#!/usr/bin/env bash
# secrets / variables 自检：输出「是否为空 / 位数 / HMAC 指纹」，绝不输出明文。
#
# 为什么不用 MD5：
#   仓库若是公开的，Actions 日志任何人都能读。裸 MD5 等于公开一个验证预言机，
#   可被离线枚举爆破；而且 GitHub 的自动脱敏基于原值字符串匹配，对 MD5 完全失效。
#   HMAC-SHA256 指纹带密钥，外部拿到日志也反推不出原值，但仍可稳定用于
#   「同一 secret 在不同运行 / 不同 Environment 之间是否一致」的比对。
#
# 输入环境变量：
#     SECRET_NAMES             空格分隔的待检查名称列表（secrets + variables 混合，必填）
#     ENV_NAME                 Environment 名，仅用于显示（可选）
#     COMMON_FINGERPRINT_KEY   指纹密钥，自身不会被打印（可选，缺失则跳过指纹）
#     以及 SECRET_NAMES 中每个名字对应的环境变量本身
#
# 用法：在 job 的 env 里挂好 secrets，然后 `bash common/check-secrets.sh`

set -uo pipefail

: "${SECRET_NAMES:?SECRET_NAMES 未设置}"

env_name="${ENV_NAME:-unknown}"

echo "Environment : $env_name"
echo
printf '%-24s %-7s %-9s %s\n' "NAME" "EMPTY" "LENGTH" "FINGERPRINT"
printf '%-24s %-7s %-9s %s\n' \
       "------------------------" "-------" "---------" "--------------------"

# 同时写一份到 Actions 运行摘要
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Secrets / Variables — \`$env_name\`"
    echo ""
    echo "| Name | Empty | Length | Fingerprint |"
    echo "|---|---|---|---|"
  } >> "$GITHUB_STEP_SUMMARY"
fi

missing=0
for name in $SECRET_NAMES; do
  value="${!name-}"

  if [ -z "$value" ]; then
    empty="yes"
    length="0"
    fp="-"
    missing=$((missing + 1))
  else
    empty="no"
    length="${#value}"
    if [ -n "${COMMON_FINGERPRINT_KEY:-}" ]; then
      fp=$(printf '%s' "$value" \
           | openssl dgst -sha256 -hmac "$COMMON_FINGERPRINT_KEY" -r \
           | cut -d' ' -f1 | cut -c1-12)
      [ -n "$fp" ] || fp="(err)"
    else
      fp="(skip: no key)"
    fi
  fi

  printf '%-24s %-7s %-9s %s\n' "$name" "$empty" "$length" "$fp"

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "| \`$name\` | $empty | $length | \`$fp\` |" >> "$GITHUB_STEP_SUMMARY"
  fi
done

if [ "$missing" -gt 0 ]; then
  echo
  echo "::warning::$env_name 中有 $missing 个 secret 为空（可能未配置，也可能本项目用不到）"
fi
