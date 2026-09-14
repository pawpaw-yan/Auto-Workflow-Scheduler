#!/usr/bin/env bash
# 配置自检：把 secrets / variables 的「是否为空 / 位数 / 值」打成一张表。
#
# **默认完全跳过**——这一步什么都不输出。只有调试开关打开时才会真正执行：
#
#     DEBUG_MODE            当前 Environment 的开关（workflow 里 → vars.DEBUG_MODE）
#     COMMON_DEBUG_MODE     仓库级全局开关   （workflow 里 → vars.COMMON_DEBUG_MODE）
#
#   判定规则（Environment 覆盖仓库级，与 GitHub 变量优先级一致）：
#     DEBUG_MODE 有值        → 以它为准（因此可用 false 单独关掉某个已全局开启的环境）
#     DEBUG_MODE 未设        → 回落到 COMMON_DEBUG_MODE
#     两者都未设 / 非真值     → 跳过
#   真值：true / 1 / yes / on（大小写不敏感）；其余值一律视为关闭。
#
# 为什么默认跳过、且一旦开启就直接输出明文：
#   仓库若是公开的，Actions 日志（含 Job Summary）任何人都能读，且会保留一段时间。
#   Variables **完全不受 GitHub 自动脱敏保护**（脱敏只对 Secret 生效），
#   打出来等于把区域 / 隔间 / 子网 OCID 等标识公开。所以默认连表都不打；
#   而你主动打开开关时，目的本来就是排查——此时输出明文才有意义，
#   再叠一层「隐藏值」只会让排查变得别扭。
#
#   ⚠️ 这是「公开日志的限流阀」，**不是安全边界**：能修改仓库 Variables 的人，
#      本来就能在 GitHub 界面上直接读到这些值。它只控制「要不要写进公开日志」。
#
# SECRETS 无论开关如何都只输出 HMAC 指纹（前 12 位），永不打印明文。
# 为什么用 HMAC 而不是 MD5：
#   裸 MD5 等于公开一个验证预言机，可被离线枚举爆破，
#   而且 GitHub 的自动脱敏基于原值字符串匹配，对 MD5 完全失效。
#   HMAC-SHA256 指纹带密钥，外部拿到日志也反推不出原值，但仍可稳定用于
#   「同一 secret 在不同运行 / 不同 Environment 之间是否一致」的比对。
#
# 输入环境变量：
#     SECRET_NAMES             空格分隔的敏感项名称（与 VARIABLE_NAMES 至少有一个）
#     VARIABLE_NAMES           空格分隔的非敏感项名称（可选）
#     ENV_NAME                 Environment 名，仅用于显示（可选）
#     COMMON_FINGERPRINT_KEY   指纹密钥，自身不会被打印（可选，缺失则跳过指纹）
#     DEBUG_MODE / COMMON_DEBUG_MODE   调试开关，见上（可选，未开启则整体跳过）
#     以及上述名称对应的环境变量本身
#
# 用法：在 job 的 env 里挂好 secrets / variables，
#       然后 `bash common/check-secrets.sh`

set -uo pipefail

env_name="${ENV_NAME:-unknown}"
secret_names="${SECRET_NAMES:-}"
variable_names="${VARIABLE_NAMES:-}"

# ── 两级调试开关：DEBUG_MODE（Environment 级）优先于 COMMON_DEBUG_MODE（仓库级）──
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

# ── 未开启调试开关 → 整体跳过，不输出任何配置内容 ──
if [ -z "$debug_source" ] || ! is_true "$debug_raw"; then
  echo "配置自检已跳过（未开启调试开关）"

  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### Config — \`$env_name\`"
      echo ""
      echo "> 配置自检已跳过（未开启调试开关）。需要查看时："
      echo "> 只调试本项目 → Environment \`$env_name\` 的 Variables 设 \`DEBUG_MODE=true\`；"
      echo "> 调试全部项目 → 仓库级 Variables 设 \`COMMON_DEBUG_MODE=true\`。"
    } >> "$GITHUB_STEP_SUMMARY"
  fi

  exit 0
fi

# ── 以下只在调试开关开启时执行 ──
if [ -z "$secret_names" ] && [ -z "$variable_names" ]; then
  echo "::error::SECRET_NAMES 与 VARIABLE_NAMES 都未设置，没有可检查的项"
  exit 1
fi

echo "配置自检（调试模式已开启：$debug_source=$debug_raw）"
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
    echo "> ⚠️ 调试模式已开启（\`${debug_source}=${debug_raw}\`）：variables 输出明文，仅用于排查，用完请关掉。"
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
      # 调试模式下输出明文。超长值（如 SSH 公钥、base64 证书）截断显示，
      # 避免把表格撑爆；LENGTH 列仍给出完整长度，不影响判断是否配错。
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

echo
echo "调试模式已开启：variables 输出明文；secrets 仍只输出 HMAC 指纹。用完请关掉开关。"
