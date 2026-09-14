#!/usr/bin/env bash
# 配置自检：输出「是否为空 / 位数」，并按敏感程度采用不同的展示方式。
#
#     SECRET_NAMES    敏感项 → 只输出 HMAC 指纹。无论任何开关，永不打印明文
#     VARIABLE_NAMES  非敏感项 → 默认只输出「空 / 长度」；
#                                开启调试开关后才输出明文值
#
# 为什么 variables 默认不打印明文：
#   仓库若是公开的，Actions 日志（含 Job Summary）任何人都能读，且会保留一段时间。
#   Variables **完全不受 GitHub 自动脱敏保护**（脱敏只对 Secret 生效），
#   打印出来等于把你的区域 / 隔间 / 子网 OCID 等标识公开。
#   这些值本身不足以认证（OCI 需要私钥签名），但公开它们会抹掉纵深防御的缓冲。
#
# 调试开关（两级，Environment 覆盖仓库级，与 GitHub 变量优先级一致）：
#     DEBUG_MODE            当前 Environment 的开关（workflow 里 → vars.DEBUG_MODE）
#     COMMON_DEBUG_MODE     仓库级全局开关   （workflow 里 → vars.COMMON_DEBUG_MODE）
#
#   判定规则：
#     DEBUG_MODE 有值        → 以它为准（因此可用 false 单独关掉某个已全局开启的环境）
#     DEBUG_MODE 未设        → 回落到 COMMON_DEBUG_MODE
#     两者都未设             → 关闭（fail-closed，默认隐藏）
#   真值：true / 1 / yes / on（大小写不敏感）；其余值一律视为关闭。
#
#   ⚠️ 注意：这是一个「公开日志的限流阀」，**不是安全边界**。
#      能修改仓库 Variables 的人，本来就能在 GitHub 界面上直接读到这些值；
#      这个开关只控制「要不要把它们写进公开日志」。
#
# 为什么 secrets 用 HMAC 而不是 MD5：
#   同上——裸 MD5 等于公开一个验证预言机，可被离线枚举爆破，
#   而且 GitHub 的自动脱敏基于原值字符串匹配，对 MD5 完全失效。
#   HMAC-SHA256 指纹带密钥，外部拿到日志也反推不出原值，但仍可稳定用于
#   「同一 secret 在不同运行 / 不同 Environment 之间是否一致」的比对。
#
# 输入环境变量：
#     SECRET_NAMES             空格分隔的敏感项名称（与 VARIABLE_NAMES 至少有一个）
#     VARIABLE_NAMES           空格分隔的非敏感项名称（可选）
#     ENV_NAME                 Environment 名，仅用于显示（可选）
#     COMMON_FINGERPRINT_KEY   指纹密钥，自身不会被打印（可选，缺失则跳过指纹）
#     DEBUG_MODE / COMMON_DEBUG_MODE   调试开关，见上（可选，默认关闭）
#     以及上述名称对应的环境变量本身
#
# 用法：在 job 的 env 里挂好 secrets / variables，
#       然后 `bash common/check-secrets.sh`

set -uo pipefail

env_name="${ENV_NAME:-unknown}"
secret_names="${SECRET_NAMES:-}"
variable_names="${VARIABLE_NAMES:-}"

# ── 两级调试开关：DEBUG_MODE（Environment 级）优先于 COMMON_DEBUG_MODE（仓库级）──
# 默认关闭是刻意的（fail-closed）：想打印明文必须显式开启。
is_true() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    true | 1 | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

if [ -n "${DEBUG_MODE:-}" ]; then
  debug_source="DEBUG_MODE"
  debug_raw="$DEBUG_MODE"
elif [ -n "${COMMON_DEBUG_MODE:-}" ]; then
  debug_source="COMMON_DEBUG_MODE"
  debug_raw="$COMMON_DEBUG_MODE"
else
  debug_source=""
  debug_raw=""
fi

show_values=0
if [ -n "$debug_source" ] && is_true "$debug_raw"; then
  show_values=1
fi

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
    echo ""
    if [ "$show_values" = "1" ]; then
      echo "> 调试开关已开启（\`${debug_source}=${debug_raw}\`）：variables 输出明文；secrets 仍只输出 HMAC 指纹。"
    else
      echo "> 配置明文已隐藏。只调试本项目 → Environment \`$env_name\` 的 Variables 里设 \`DEBUG_MODE=true\`；调试全部项目 → 仓库级 Variables 设 \`COMMON_DEBUG_MODE=true\`。"
    fi
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
      if [ "$show_values" != "1" ]; then
        # 默认：只给「有没有配 / 多长」，不输出内容（公开仓库日志任何人可读）
        display="(hidden)"
      elif [ "$length" -gt 60 ]; then
        # 调试模式 + 超长值（如 SSH 公钥、base64 证书）：截断显示，避免撑爆表格。
        # LENGTH 列仍给出完整长度，不影响判断是否配错。
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

echo
if [ "$show_values" = "1" ]; then
  echo "调试开关：已开启（$debug_source=$debug_raw）—— variables 明文可见；secrets 仍只输出指纹。"
else
  echo "调试开关：关闭 —— variables 明文已隐藏（VALUE 列显示 (hidden)）。"
  echo "  只调试本项目：Environment '$env_name' → Variables → DEBUG_MODE=true"
  echo "  调试全部项目：仓库级 Variables → COMMON_DEBUG_MODE=true"
fi
