#!/usr/bin/env bash
# 配置自检：输出「是否为空 / 位数」，并按敏感程度采用不同的展示方式。
#
#     SECRET_NAMES    敏感项 → 只输出 HMAC 指纹（值本身不可见）
#     VARIABLE_NAMES  非敏感项 → 直接输出明文值（本来就是公开配置，明文更直观）
#
# 为什么 secrets 用 HMAC 而不是 MD5：
#   仓库若是公开的，Actions 日志任何人都能读。裸 MD5 等于公开一个验证预言机，
#   可被离线枚举爆破；而且 GitHub 的自动脱敏基于原值字符串匹配，对 MD5 完全失效。
#   HMAC-SHA256 指纹带密钥，外部拿到日志也反推不出原值，但仍可稳定用于
#   「同一 secret 在不同运行 / 不同 Environment 之间是否一致」的比对。
#
# 输入环境变量：
#     SECRET_NAMES             空格分隔的敏感项名称（与 VARIABLE_NAMES 至少有一个）
#     VARIABLE_NAMES           空格分隔的非敏感项名称（可选）
#     ENV_NAME                 Environment 名，仅用于显示（可选）
#     COMMON_FINGERPRINT_KEY   指纹密钥，自身不会被打印（可选，缺失则跳过指纹）
#     以及上述名称对应的环境变量本身
#
# 用法：在 job 的 env 里挂好 secrets / variables，
#       然后 `bash common/check-secrets.sh`

set -uo pipefail

env_name="${ENV_NAME:-unknown}"
secret_names="${SECRET_NAMES:-}"
variable_names="${VARIABLE_NAMES:-}"

if [ -z "$secret_names" ] && [ -z "$variable_names" ]; then
  echo "::error::SECRET_NAMES 与 VARIABLE_NAMES 都未设置，没有可检查的项"
  exit 1
fi

echo "Environment : $env_name"
echo
printf '%-24s %-9s %-7s %-9s %s\n' "NAME" "TYPE" "EMPTY" "LENGTH" "VALUE / FINGERPRINT"
printf '%-24s %-9s %-7s %-9s %s\n' \
       "------------------------" "---------" "-------" "---------" "--------------------"

# 同时写一份到 Actions 运行摘要
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Config — \`$env_name\`"
    echo ""
    echo "| Name | Type | Empty | Length | Value / Fingerprint |"
    echo "|---|---|---|---|---|"
  } >> "$GITHUB_STEP_SUMMARY"
fi

missing=0

show_item() {
  # $1 = 变量名   $2 = 类型（secret / variable）
  local name="$1" kind="$2"
  local value="${!name-}"
  local empty length display

  if [ -z "$value" ]; then
    empty="yes"
    length="0"
    display="-"
    missing=$((missing + 1))
  else
    empty="no"
    length="${#value}"

    if [ "$kind" = "variable" ]; then
      # 非敏感项：明文展示，方便直接确认配置内容。
      # 过长的值（如 SSH 公钥、base64 证书）截断显示，避免把表格撑爆；
      # LENGTH 列仍然给出完整长度，不影响判断是否配错。
      if [ "$length" -gt 60 ]; then
        display="${value:0:57}...（已截断）"
      else
        display="$value"
      fi
    elif [ -n "${COMMON_FINGERPRINT_KEY:-}" ]; then
      display=$(printf '%s' "$value" \
              | openssl dgst -sha256 -hmac "$COMMON_FINGERPRINT_KEY" -r \
              | cut -d' ' -f1 | cut -c1-12)
      [ -n "$display" ] || display="(err)"
    else
      display="(skip: no key)"
    fi
  fi

  printf '%-24s %-9s %-7s %-9s %s\n' "$name" "$kind" "$empty" "$length" "$display"

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "| \`$name\` | $kind | $empty | $length | \`$display\` |" >> "$GITHUB_STEP_SUMMARY"
  fi
}

for name in $secret_names;   do show_item "$name" "secret";   done
for name in $variable_names; do show_item "$name" "variable"; done

if [ "$missing" -gt 0 ]; then
  echo
  echo "::warning::$env_name 中有 $missing 项为空（可能未配置，也可能本项目用不到）"
fi
