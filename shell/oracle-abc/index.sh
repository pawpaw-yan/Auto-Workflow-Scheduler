#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# oracle-abc —— 抢占 OCI Ampere A1 实例并分步升级规格
#
# 流程（幂等，可反复执行）：
#   1. 按 display-name 查找实例
#   2. 不存在 → 尝试创建「OCPU / MEMORY」的 A1 实例
#                容量不足则退出 0，等外部调度器下次重试
#   3. 存在   → 进入升级循环：
#                ┌─ 读当前 OCPU
#                │  已达到 TARGET → 结束
#                │  否则 → 停止 → 升级到「当前 ×STEP_FACTOR」→ 启动
#                └─ 升级成功后立刻回到开头重新判断
#
#   例：OCPU=1 TARGET=4，默认 STEP_FACTOR=2，升级路径为
#         1c/6g  →  2c/12g  →  4c/24g        （跳过 3c/18g）
#       每升一轮都重新判断，达到 TARGET 才结束。
#
#   分步升级而不是一次跳到位，是为了让每一步都有独立的成功机会；
#   如果某一步失败，至少还能停在上一档已经成功的规格上。
#
# 退出码：
#   0  成功；或「没有容量，稍后重试」这类预期内结果
#   1  真正的错误（配置缺失、认证失败、OCI 调用异常、升级未生效）
#
# 依赖：oci CLI、jq
#
# 关于认证：
#   本脚本不读 ~/.oci/config，直接依赖 OCI CLI 原生支持的环境变量：
#     OCI_CLI_USER / OCI_CLI_FINGERPRINT / OCI_CLI_TENANCY / OCI_CLI_REGION
#     OCI_CLI_KEY_CONTENT（私钥内容）或 OCI_CLI_KEY_FILE（私钥路径）
#   优先级：命令行选项 > 环境变量 > config 文件
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─────────────────────────── 参数 ───────────────────────────
SHAPE="${OCI_SHAPE:-VM.Standard.A1.Flex}"

GRAB_OCPUS="${GRAB_OCPUS:-1}"          # 抢占时申请的 OCPU 数（越小越容易抢到）
GRAB_MEMORY_GB="${GRAB_MEMORY_GB:-6}"  # 抢占时申请的内存

TARGET_OCPUS="${TARGET_OCPUS:-2}"      # 升级的最终目标 OCPU 数

# 每轮升级的放大倍数。默认 2 → 1c/2c/4c/8c…（1→2→4 会跳过 3）
# 设为 1 则退化成逐级 +1（1→2→3→4）
STEP_FACTOR="${STEP_FACTOR:-2}"

INSTANCE_NAME="${OCI_INSTANCE_NAME:-oracle-abc}"
BOOT_VOLUME_GB="${OCI_BOOT_VOLUME_GB:-50}"
STOP_ACTION="${STOP_ACTION:-SOFTSTOP}" # SOFTSTOP = 优雅关机（推荐，避免数据损坏）

# MEMORY_PER_OCPU（每个 OCPU 配多少内存）在前置校验之后计算，见下方

# ─────────────────────────── 工具函数 ───────────────────────────
log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { echo "::error::$*" >&2; exit 1; }

need() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    die "缺少必填环境变量 $name"
  fi
}

# 校验为正整数
need_positive_int() {
  local name="$1" value="$2"
  case "$value" in
    ''|*[!0-9]*) die "$name 必须是正整数，当前值：'$value'" ;;
  esac
  [ "$value" -gt 0 ] || die "$name 必须大于 0，当前值：$value"
}

# 计算从 from 升到 target 的下一档（保证一定前进，且不超过 target）
next_step() {
  local from="$1" target="$2" nxt
  nxt=$(( from * STEP_FACTOR ))
  [ "$nxt" -le "$from" ] && nxt=$(( from + 1 ))   # 防止 STEP_FACTOR=1 时原地打转
  [ "$nxt" -gt "$target" ] && nxt="$target"       # 不越过目标
  echo "$nxt"
}

# ─────────────────────────── 前置检查 ───────────────────────────
command -v oci >/dev/null 2>&1 || die "未找到 oci CLI，请先安装（pip install oci-cli）"
command -v jq  >/dev/null 2>&1 || die "未找到 jq"

need OCI_COMPARTMENT_ID

need_positive_int GRAB_OCPUS     "$GRAB_OCPUS"
need_positive_int GRAB_MEMORY_GB "$GRAB_MEMORY_GB"
need_positive_int TARGET_OCPUS   "$TARGET_OCPUS"
need_positive_int STEP_FACTOR    "$STEP_FACTOR"

# 每个 OCPU 配多少内存。默认沿用抢占时的比例（如 1c6g → 每 OCPU 6GB），
# 于是 2c 配 12GB、4c 配 24GB。可用 MEMORY_PER_OCPU 显式覆盖。
# 放在校验之后计算，避免非法输入直接让算术表达式报错。
if [ -n "${MEMORY_PER_OCPU:-}" ]; then
  need_positive_int MEMORY_PER_OCPU "$MEMORY_PER_OCPU"
else
  MEMORY_PER_OCPU=$(( GRAB_MEMORY_GB / GRAB_OCPUS ))
  [ "$MEMORY_PER_OCPU" -gt 0 ] || MEMORY_PER_OCPU=1
fi

# 预览升级路径（仅用于日志，方便一眼核对配置是否符合预期）
preview="${GRAB_OCPUS}c"
prev="$GRAB_OCPUS"
cur="$GRAB_OCPUS"
for _ in $(seq 1 32); do
  [ "$cur" -ge "$TARGET_OCPUS" ] && break
  cur=$(next_step "$prev" "$TARGET_OCPUS")
  preview="$preview → ${cur}c"
  prev="$cur"
done

log "════════ oracle-abc 启动 ════════"
log "实例名        : $INSTANCE_NAME"
log "抢占规格      : ${GRAB_OCPUS} OCPU / ${GRAB_MEMORY_GB} GB"
log "升级目标      : ${TARGET_OCPUS} OCPU"
log "放大倍数      : ×${STEP_FACTOR}"
log "升级路径      : $preview"
log "每 OCPU 内存  : ${MEMORY_PER_OCPU} GB"
log "Shape         : $SHAPE"
log "区域          : ${OCI_CLI_REGION:-（未设置，将读 ~/.oci/config）}"
log "可用域        : ${OCI_AVAILABILITY_DOMAIN:-（未设置，仅在创建时需要）}"
echo

# ─────────────────────── 步骤 1：查找实例 ───────────────────────
log "步骤 1/3  查找已存在的实例"

instance_id=$(
  oci compute instance list \
    --compartment-id "$OCI_COMPARTMENT_ID" \
    --display-name "$INSTANCE_NAME" \
    --output json \
  | jq -r --arg n "$INSTANCE_NAME" '
      [ .data[]
        | select(."display-name" == $n)
        | select(."lifecycle-state" != "TERMINATED" and ."lifecycle-state" != "TERMINATING")
      ]
      | sort_by(."time-created") | reverse
      | (.[0]."id" // empty)'
) || die "调用 oci compute instance list 失败，请检查认证配置"

# ───────────────────────── 步骤 2：抢占 ─────────────────────────
if [ -z "$instance_id" ]; then
  log "步骤 2/3  未找到实例，尝试创建 ${GRAB_OCPUS} OCPU / ${GRAB_MEMORY_GB} GB"

  need OCI_AVAILABILITY_DOMAIN
  need OCI_SUBNET_ID
  need OCI_IMAGE_ID

  launch_args=(
    --availability-domain    "$OCI_AVAILABILITY_DOMAIN"
    --compartment-id         "$OCI_COMPARTMENT_ID"
    --display-name           "$INSTANCE_NAME"
    --shape                  "$SHAPE"
    --shape-config           "{\"ocpus\":${GRAB_OCPUS},\"memoryInGBs\":${GRAB_MEMORY_GB}}"
    --image-id               "$OCI_IMAGE_ID"
    --subnet-id              "$OCI_SUBNET_ID"
    --assign-public-ip       true
    --boot-volume-size-in-gbs "$BOOT_VOLUME_GB"
    --wait-for-state         RUNNING
    --max-wait-seconds       900
    --wait-interval-seconds  15
  )

  if [ -n "${OCI_SSH_PUBLIC_KEY:-}" ]; then
    launch_args+=(--metadata "{\"ssh_authorized_keys\":\"${OCI_SSH_PUBLIC_KEY}\"}")
  fi

  if launch_out=$(oci compute instance launch "${launch_args[@]}" --output json 2>&1); then
    instance_id=$(jq -r '.data.id' <<< "$launch_out")
    log "  ✅ 抢到了！instance-id = $instance_id"
  else
    # 「没有容量」是本任务最常见的正常结果，不作为失败处理
    if grep -qiE 'out of host capacity|outofcapacity|capacity' <<< "$launch_out"; then
      echo "::warning::没有可用容量，本次未抢到，等待调度器下次重试"
      log "  OCI 返回：$(tr '\n' ' ' <<< "$launch_out" | cut -c1-300)"
      log "════════ 结束：未抢到（预期内）════════"
      exit 0
    fi
    echo "::error::创建实例失败（非容量原因）"
    log "$launch_out"
    exit 1
  fi
else
  log "步骤 2/3  已存在实例，跳过创建"
fi

log "  instance-id = $instance_id"
echo

# ───────────────────── 步骤 3：分步升级到 TARGET ─────────────────────
log "步骤 3/3  分步升级到 ${TARGET_OCPUS} OCPU（每轮 ×${STEP_FACTOR}）"

if [ "$GRAB_OCPUS" -ge "$TARGET_OCPUS" ]; then
  log "  抢占规格($GRAB_OCPUS) 已达/超过目标($TARGET_OCPUS)，无需升级"
  log "════════ 结束：无需升级 ════════"
  exit 0
fi

# 兜底：防止因升级未生效（cur_ocpus 不前进）导致死循环
max_rounds=$(( TARGET_OCPUS - GRAB_OCPUS + 2 ))
[ "$max_rounds" -lt 3 ] && max_rounds=3

round=0

while true; do
  round=$(( round + 1 ))

  if [ "$round" -gt "$max_rounds" ]; then
    echo "::error::升级轮数超过上限 $max_rounds，疑似升级未生效，中止"
    exit 1
  fi

  # ── 每轮都重新读取当前状态（这就是「升级完立刻重新判断」）──
  cur_json=$(oci compute instance get --instance-id "$instance_id" --output json)
  cur_state=$(jq -r '.data."lifecycle-state"'               <<< "$cur_json")
  cur_ocpus=$(jq -r '.data."shape-config".ocpus  // 0'      <<< "$cur_json")
  cur_mem=$(jq -r '.data."shape-config".memoryInGBs // "?"' <<< "$cur_json")

  log "── 第 $round 轮：当前 ${cur_ocpus} OCPU / ${cur_mem} GB，状态 $cur_state"

  # ── 已达到目标 → 结束 ──
  if [ "$cur_ocpus" -ge "$TARGET_OCPUS" ]; then
    log "  ✅ 已达到目标 ${TARGET_OCPUS} OCPU，升级结束"
    break
  fi

  # ── 本轮升级到「当前 × STEP_FACTOR」，且不超过目标 ──
  next_ocpus=$(next_step "$cur_ocpus" "$TARGET_OCPUS")
  next_memory=$(( next_ocpus * MEMORY_PER_OCPU ))

  log "  升级 ${cur_ocpus}c → ${next_ocpus}c（${next_memory} GB）"

  if [ "$cur_state" != "STOPPED" ]; then
    log "    停止实例（$STOP_ACTION，等待 STOPPED，最长 15 分钟）"
    oci compute instance action \
      --action               "$STOP_ACTION" \
      --instance-id          "$instance_id" \
      --wait-for-state       STOPPED \
      --max-wait-seconds     900 \
      --wait-interval-seconds 15 \
      >/dev/null
    log "    已停止"
  else
    log "    实例已是 STOPPED，跳过停止"
  fi

  log "    更新 shape"
  oci compute instance update \
    --instance-id  "$instance_id" \
    --shape        "$SHAPE" \
    --shape-config "{\"ocpus\":${next_ocpus},\"memoryInGBs\":${next_memory}}" \
    >/dev/null
  log "    shape 已更新"

  log "    启动实例（等待 RUNNING，最长 15 分钟）"
  oci compute instance action \
    --action               START \
    --instance-id          "$instance_id" \
    --wait-for-state       RUNNING \
    --max-wait-seconds     900 \
    --wait-interval-seconds 15 \
    >/dev/null
  log "    启动完成 → 回到顶部重新判断是否需要继续升级"
done

# ───────────────────────── 复核 ─────────────────────────
final_json=$(oci compute instance get --instance-id "$instance_id" --output json)
final_state=$(jq -r '.data."lifecycle-state"'               <<< "$final_json")
final_ocpus=$(jq -r '.data."shape-config".ocpus  // "?"'    <<< "$final_json")
final_mem=$(jq -r '.data."shape-config".memoryInGBs // "?"' <<< "$final_json")

echo
log "════════ 完成 ════════"
log "instance-id : $instance_id"
log "共升级轮数  : $(( round - 1 ))"
log "状态        : $final_state"
log "规格        : ${final_ocpus} OCPU / ${final_mem} GB"
