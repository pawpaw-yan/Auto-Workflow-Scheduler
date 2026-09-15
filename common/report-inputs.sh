#!/usr/bin/env bash
# 报告「本次通过 ref 传了哪些配置」，并对机密项告警。
#
# 为什么需要这一步：`workflow_dispatch` 的 inputs **不是机密，也不受脱敏保护** ——
# GitHub 会把它们原样存进本次 run 的记录，公开仓库任何人打开 run 详情页都能看到。
# 所以「用 ref 传了机密项」这件事必须集中提醒一次，业务脚本不需要关心。
#
# ⚠️ 它**不修改任何配置**。值的生效靠 workflow 里那几行：
#         KEY: ${{ inputs.KEY || vars.KEY }}      # 或 secrets.KEY
#    本步只负责两件事：告诉人 + 把机密值注册进日志遮蔽列表。
#
# 输入环境变量：
#     REF_INPUTS    本次 inputs 的原样 JSON，由 workflow 里
#                   `REF_INPUTS: ${{ toJSON(inputs) }}` 提供。
#                   只看名字和长度，**永不打印值**。
#     SECRET_NAMES  空格分隔的机密项名单。被 ref 传了的会打 ::warning::，
#                   同时也决定要不要 ::add-mask::（见 check-secrets.sh）
#
# 用法：作为独立 step，紧跟 checkout，排在其余业务 step 之前。
#       没有传参数时整步跳过。

set -uo pipefail

raw="${REF_INPUTS:-}"

# 没传参：GitHub 会把未填的 input 渲染成空字符串，所以可能是 {}、也可能是全空
if [ -z "${raw//[[:space:]]/}" ] || [ "$raw" = "{}" ]; then
  echo "本次没有通过 ref 传入参数，本步跳过（继续使用仓库配置的 vars / secrets）"
  exit 0
fi

command -v jq >/dev/null 2>&1 || {
  echo "::error::未找到 jq，无法解析 REF_INPUTS"
  exit 1
}

if ! printf '%s' "$raw" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "::error::REF_INPUTS 不是 JSON 对象"
  exit 1
fi

is_secret() {
  local name="$1" item
  for item in ${SECRET_NAMES:-}; do
    [ "$item" = "$name" ] && return 0
  done
  return 1
}

applied=""
applied_secrets=""
declare -A applied_len=()   # 名称 → 值的长度。摘要里用它代替值本身

# jq -c：每条 entry 一行紧凑 JSON，多行值会被转义成 \n，read 不会截断。
# 用两个 select 而不是 and：jq 的 and 不做短路求值，非字符串值上取 length 会报错。
# 用进程替换而不是管道，while 循环留在当前 shell，变量才能保留。
while IFS= read -r entry; do
  name=$(printf '%s' "$entry" | jq -r '.key')
  len=$(printf '%s' "$entry" | jq -r '.value | length')

  applied="${applied}${applied:+$'\n'}${name}"
  applied_len["$name"]="$len"

  if is_secret "$name"; then
    applied_secrets="${applied_secrets}${applied_secrets:+$'\n'}${name}"
    # 遮蔽：只处理单行值。多行值（如按行存放的 cookie）交给业务脚本逐条注册，
    # 整串注册在这里也不会生效。
    value=$(printf '%s' "$entry" | jq -r '.value')
    case "$value" in
      *$'\n'*) ;;
      *) [ "$len" -ge 4 ] && printf '::add-mask::%s\n' "$value" ;;
    esac
  fi
done < <(printf '%s' "$raw" \
           | jq -c 'to_entries[] | select(.value | type == "string") | select(.value | length > 0)')

if [ -z "$applied" ]; then
  echo "ref 没有传入任何非空参数，本步跳过"
  exit 0
fi

count=$(printf '%s\n' "$applied" | grep -c .)

# 通知里带长度：一眼看出「值有没有传进来」「是不是被截断」
notice_items=""
while IFS= read -r applied_name; do
  [ -n "$applied_name" ] || continue
  notice_items="${notice_items}${notice_items:+, }${applied_name}(${applied_len[$applied_name]:-?})"
done <<< "$applied"

echo "::notice::本次运行通过 ref 传入了 ${count} 项配置：${notice_items}"

# 机密项被 ref 传进来 = 把这些值公开。告警在这里统一发出，
# 业务脚本不需要再各自判断「我这个键要不要提醒」。
if [ -n "$applied_secrets" ]; then
  secret_names=$(printf '%s' "$applied_secrets" | tr '\n' ' ')
  printf '::warning::本次运行通过 ref 传入了机密项 %s —— workflow_dispatch 的 inputs 不是机密、也不受脱敏保护，公开仓库的 run 详情页任何人都能看到，请确认这些值可以公开。\n' "$secret_names"
fi

# 写进 Job Summary：只列名称和长度，绝不列值。
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ⚠️ 本次运行替换了配置项"
    echo ""
    echo "本次通过 \`ref\` 派发时传入的参数（\`workflow_dispatch\` 的 inputs）**替换了以下配置项**，"
    echo "它们**没有使用仓库里配置的 \`vars\` / \`secrets\`**："
    echo ""
    echo "| 被替换的配置项 | 长度 | 类型 |"
    echo "|---|---|---|"
    printf '%s\n' "$applied" | while IFS= read -r applied_name; do
      [ -n "$applied_name" ] || continue
      if is_secret "$applied_name"; then
        printf '| `%s` | %s | ⚠️ **机密** |\n' "$applied_name" "${applied_len[$applied_name]:-?}"
      else
        printf '| `%s` | %s | 普通 |\n' "$applied_name" "${applied_len[$applied_name]:-?}"
      fi
    done
    echo ""
    echo "> **只显示名称和长度，不显示值。** 长度拿来对照预期：值没传进来会是 0，"
    echo "> 被截断或复制漏字符会比预期短。排查配置问题时，请先确认本次是否传了参数。"
    if [ -n "$applied_secrets" ]; then
      echo ">"
      echo "> ⚠️ **标记为机密的项是用 \`ref\` 传进来的** —— workflow_dispatch 的 inputs 不受脱敏保护，"
      echo "> 公开仓库的 run 详情页任何人都能看到。长期配置请放 \`vars\` / \`secrets\`。"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi
