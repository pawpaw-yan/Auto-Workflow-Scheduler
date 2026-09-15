#!/usr/bin/env bash
# 参数覆盖：把 workflow_dispatch 传来的 overrides 应用到「本次运行」的环境变量上，
# 临时替换仓库里配置的 vars / secrets，并在 Job Summary 里声明「替换了哪些名字」。
#
# 只声明名字，永不输出值：登记在 SECRET_NAMES 里的项，其单行值会注册进日志遮蔽列表
# （::add-mask::）；非敏感项不遮蔽，保证域名 / 开关在日志里依旧可读。
#
# 输入环境变量：
#     OVERRIDES       JSON 对象（单行字符串），如 {"DOMAINS":"glados.cloud","GLADOS_VERBOSE":"true"}
#                     为空 / 未设置 → 本步直接跳过
#     OVERRIDE_NAMES  可选，空格分隔的可覆盖项白名单；
#                     留空则回落到 SECRET_NAMES + VARIABLE_NAMES（复用已有的自检清单）
#     SECRET_NAMES / VARIABLE_NAMES / ENV_NAME    见 check-secrets.sh
#
# 用法：作为独立 step，放在 checkout 之后、其余业务 step 之前。
#       值写入 GITHUB_ENV，因此对后续**所有** step 生效（含 check-secrets.sh）。
#
# 输出（供业务脚本读取，都只列名字、不含值）：
#     OVERRIDE_APPLIED          本次被替换的全部项
#     OVERRIDE_APPLIED_SECRETS  其中登记为机密的项（本脚本已就此打过 ::warning::）
#       机密项被 ref 替换 = 把这些值公开，所以告警由本步统一发出，
#       业务脚本不需要再判断「我这个键要不要提醒」。
#
# ⚠️ 安全边界：
#     workflow_dispatch 的 inputs 不是机密 —— 它会出现在 run 的详情页和事件负载里。
#     这个入口适合「临时替换非敏感配置」（域名、开关、计划、目标规格）；
#     拿它传 cookie / 私钥等于把这些值公开（公开仓库尤其）。
#     需要长期生效的配置请放 vars / secrets。

set -uo pipefail

raw="${OVERRIDES:-}"

# 只有空白字符等同于没传
if [ -z "${raw//[[:space:]]/}" ]; then
  echo "未传入 overrides，本步跳过（继续使用仓库配置的 vars / secrets）"
  exit 0
fi

command -v jq >/dev/null 2>&1 || {
  echo "::error::未找到 jq，无法解析 OVERRIDES"
  exit 1
}

if ! printf '%s' "$raw" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "::error::OVERRIDES 必须是 JSON 对象，例如 {\"DOMAINS\":\"glados.cloud\"}"
  exit 1
fi

# 白名单：显式 OVERRIDE_NAMES 优先，否则复用项目已登记的 SECRET_NAMES + VARIABLE_NAMES。
# 没有白名单就拒绝覆盖（fail-closed），避免误改 PATH / NODE_OPTIONS 这类运行时变量。
allow="${OVERRIDE_NAMES:-}"
[ -n "${allow//[[:space:]]/}" ] || allow="${SECRET_NAMES:-} ${VARIABLE_NAMES:-}"

if [ -z "${allow//[[:space:]]/}" ]; then
  echo "::error::未声明可覆盖项（OVERRIDE_NAMES / SECRET_NAMES / VARIABLE_NAMES 均为空），拒绝覆盖"
  exit 1
fi

is_allowed() {
  local name="$1" item
  for item in $allow; do
    [ "$item" = "$name" ] && return 0
  done
  return 1
}

# 只有登记在 SECRET_NAMES 里的项才注册遮蔽。
# 不加区分地把每个值都遮蔽，会让 DOMAINS / 开关这类**本来就不敏感**的值也变成
# ***（`::add-mask::true` 能把日志里所有 "true" 吃掉），排查时反而更难。
is_secret() {
  local name="$1" item
  for item in ${SECRET_NAMES:-}; do
    [ "$item" = "$name" ] && return 0
  done
  return 1
}

applied=""
applied_secrets=""
failed=0

# jq -c：每条 entry 输出成一行紧凑 JSON，多行值会被转义成 \n，不会被 read 截断。
# 用进程替换而不是管道，while 循环留在当前 shell，failed / applied 才能保留。
while IFS= read -r entry; do
  [ -n "$entry" ] || continue

  name=$(printf '%s' "$entry" | jq -r '.key')
  value=$(printf '%s' "$entry" | jq -r '.value | tostring')

  # 名称合法性：shell 变量名格式，且不许碰 runner 运行时变量
  if ! printf '%s' "$name" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
    echo "::error::非法的配置项名称 '$name'（只允许字母/数字/下划线，且不能以数字开头）"
    failed=1
    continue
  fi
  case "$name" in
    GITHUB_*|RUNNER_*)
      echo "::error::'$name' 是 runner 运行时变量，不允许覆盖"
      failed=1
      continue
      ;;
  esac

  if ! is_allowed "$name"; then
    echo "::error::'$name' 不在可覆盖清单内。本项目允许：${allow}"
    failed=1
    continue
  fi

  # 注入环境：GITHUB_ENV 对后续 step 生效；多行值必须用 heredoc 形式写入
  if [ -n "${GITHUB_ENV:-}" ]; then
    case "$value" in
      *$'\n'*)
        delim="GHADELIM_${RANDOM}_${RANDOM}_$$"
        {
          printf '%s<<%s\n' "$name" "$delim"
          printf '%s\n' "$value"
          printf '%s\n' "$delim"
        } >> "$GITHUB_ENV"
        ;;
      *)
        printf '%s=%s\n' "$name" "$value" >> "$GITHUB_ENV"
        ;;
    esac
  fi
  export "$name=$value"

  # 遮蔽：只处理「登记为机密」且「单行」的值。
  # 多行值（如按行存放的 cookie）交给业务脚本逐条注册；整串注册在这里也不会生效。
  case "$value" in
    *$'\n'*) ;;
    *)
      if [ "${#value}" -ge 4 ] && is_secret "$name"; then
        printf '::add-mask::%s\n' "$value"
      fi
      ;;
  esac

  applied="${applied}${applied:+$'\n'}${name}"
  if is_secret "$name"; then
    applied_secrets="${applied_secrets}${applied_secrets:+$'\n'}${name}"
  fi
done < <(printf '%s' "$raw" | jq -c 'to_entries[]')

if [ "$failed" -ne 0 ]; then
  echo "::error::存在非法的覆盖项，已中止本次运行"
  exit 1
fi

if [ -z "$applied" ]; then
  echo "overrides 中没有有效项，本步跳过"
  exit 0
fi

count=$(printf '%s\n' "$applied" | grep -c .)
names=$(printf '%s' "$applied" | tr '\n' ' ')

# 告诉后续业务脚本「本次被覆盖了哪些项」（只列名字，不含值）。
if [ -n "${GITHUB_ENV:-}" ]; then
  printf 'OVERRIDE_APPLIED=%s\n' "$names" >> "$GITHUB_ENV"
fi

echo "::notice::本次运行通过 ref 传入参数替换了 ${count} 项配置：${names}"

# 机密项被 ref 替换 = 把这些值公开。告警在这里统一发出，
# 业务脚本不需要再各自判断「我这个键要不要提醒」。
if [ -n "$applied_secrets" ]; then
  secret_names=$(printf '%s' "$applied_secrets" | tr '\n' ' ')
  if [ -n "${GITHUB_ENV:-}" ]; then
    printf 'OVERRIDE_APPLIED_SECRETS=%s\n' "$secret_names" >> "$GITHUB_ENV"
  fi
  printf '::warning::本次运行通过 ref（inputs.overrides）替换了机密项 %s —— workflow_dispatch 的 inputs 不是机密、也不受脱敏保护，公开仓库的 run 详情页任何人都能看到，请确认这些值可以公开。\n' "$secret_names"
fi

# 写进 Job Summary：只列名称，不列值。
# 本步排在 check-secrets.sh 之前，所以这段提示出现在摘要最上方。
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ⚠️ 本次运行替换了配置项"
    echo ""
    echo "本次通过 \`ref\` 派发时传入的参数（\`inputs.overrides\`）**替换了以下配置项**，"
    echo "它们**没有使用仓库里配置的 \`vars\` / \`secrets\`**："
    echo ""
    echo "| 被替换的配置项 | 类型 |"
    echo "|---|---|"
    printf '%s\n' "$applied" | while IFS= read -r applied_name; do
      [ -n "$applied_name" ] || continue
      if is_secret "$applied_name"; then
        printf '| `%s` | ⚠️ **机密** |\n' "$applied_name"
      else
        printf '| `%s` | 普通 |\n' "$applied_name"
      fi
    done
    echo ""
    echo "> 只显示名称，不显示值。排查配置问题时，请先确认本次是否传了参数。"
    if [ -n "$applied_secrets" ]; then
      echo ">"
      echo "> ⚠️ **标记为机密的项是用 \`ref\` 传进来的** —— workflow_dispatch 的 inputs 不受脱敏保护，"
      echo "> 公开仓库的 run 详情页任何人都能看到。长期配置请放 \`vars\` / \`secrets\`。"
    fi
  } >> "$GITHUB_STEP_SUMMARY"
fi
