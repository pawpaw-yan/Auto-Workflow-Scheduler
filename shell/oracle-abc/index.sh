#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# oracle-abc —— 抢占 OCI Ampere A1 实例并升级规格
#
# 流程（幂等，可反复执行）：
#   1. 按 display-name 查找实例
#   2. 不存在  → 尝试创建「1 OCPU / 6 GB」的 A1 实例
#                容量不足则退出 0，等外部调度器下次重试
#   3. 存在    → 读取当前规格，已是目标规格就直接结束
#   4. 否则    → 停止 → 更新 shape 为「2 OCPU / 12 GB」→ 启动
#
# 退出码：
#   0  成功；或「没有容量，稍后重试」这类预期内结果
#   1  真正的错误（配置缺失、认证失败、OCI 调用异常）
#
# 依赖：oci CLI、jq
#
# 关于「为什么先抢 1c6g」：
#   A1 常年缺货，申请的规格越小越容易命中；抢到后再升到目标规格。
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

GRAB_OCPUS="${GRAB_OCPUS:-1}"          # 抢占时申请的规格，越小越容易抢到
GRAB_MEMORY_GB="${GRAB_MEMORY_GB:-6}"

TARGET_OCPUS="${TARGET_OCPUS:-2}"      # 抢到后升级到的目标规格
TARGET_MEMORY_GB="${TARGET_MEMORY_GB:-12}"

INSTANCE_NAME="${OCI_INSTANCE_NAME:-oracle-abc}"
BOOT_VOLUME_GB="${OCI_BOOT_VOLUME_GB:-50}"
STOP_ACTION="${STOP_ACTION:-SOFTSTOP}" # SOFTSTOP = 优雅关机（推荐，避免数据损坏）

# ─────────────────────────── 工具函数 ───────────────────────────
log() { echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { echo "::error::$*" >&2; exit 1; }

need() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    die "缺少必填环境变量 $name"
  fi
}

# ─────────────────────────── 前置检查 ───────────────────────────
command -v oci >/dev/null 2>&1 || die "未找到 oci CLI，请先安装（pip install oci-cli）"
command -v jq  >/dev/null 2>&1 || die "未找到 jq"

need OCI_COMPARTMENT_ID

log "════════ oracle-abc 启动 ════════"
log "实例名   : $INSTANCE_NAME"
log "抢占规格 : ${GRAB_OCPUS} OCPU / ${GRAB_MEMORY_GB} GB"
log "目标规格 : ${TARGET_OCPUS} OCPU / ${TARGET_MEMORY_GB} GB"
log "Shape    : $SHAPE"
log "区域     : ${OCI_CLI_REGION:-（未设置，将读 ~/.oci/config）}"
log "可用域   : ${OCI_AVAILABILITY_DOMAIN:-（未设置，仅在创建时需要）}"
echo

# ─────────────────────── 步骤 1：查找实例 ───────────────────────
log "步骤 1/4  查找已存在的实例"

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
  log "步骤 2/4  未找到实例，尝试创建 ${GRAB_OCPUS} OCPU / ${GRAB_MEMORY_GB} GB"

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
  log "步骤 2/4  已存在实例，跳过创建"
fi

log "  instance-id = $instance_id"
echo

# ─────────────────────── 步骤 3：检查规格 ───────────────────────
log "步骤 3/4  检查当前规格"

instance_json=$(oci compute instance get --instance-id "$instance_id" --output json)

cur_state=$(jq -r '.data."lifecycle-state"'                <<< "$instance_json")
cur_shape=$(jq -r '.data.shape'                            <<< "$instance_json")
cur_ocpus=$(jq -r '.data."shape-config".ocpus  // "?"'     <<< "$instance_json")
cur_mem=$(jq -r '.data."shape-config".memoryInGBs // "?"'  <<< "$instance_json")

log "  当前状态 : $cur_state"
log "  当前规格 : $cur_shape ${cur_ocpus} OCPU / ${cur_mem} GB"

already_target=$(
  jq -r --argjson o "$TARGET_OCPUS" --argjson m "$TARGET_MEMORY_GB" '
    ((.data."shape-config".ocpus         == $o)
     and (.data."shape-config".memoryInGBs == $m))' <<< "$instance_json"
)

if [ "$already_target" = "true" ]; then
  log "  ✅ 已经是目标规格，无需升级"
  log "════════ 结束：无需操作 ════════"
  exit 0
fi
echo

# ───────────────────── 步骤 4：停止 → 升级 → 启动 ─────────────────────
log "步骤 4/4  升级规格：${cur_ocpus} OCPU / ${cur_mem} GB  →  ${TARGET_OCPUS} OCPU / ${TARGET_MEMORY_GB} GB"

if [ "$cur_state" != "STOPPED" ]; then
  log "  停止实例（$STOP_ACTION，等待 STOPPED，最长 15 分钟）"
  oci compute instance action \
    --action               "$STOP_ACTION" \
    --instance-id          "$instance_id" \
    --wait-for-state       STOPPED \
    --max-wait-seconds     900 \
    --wait-interval-seconds 15 \
    >/dev/null
  log "  ✅ 已停止"
else
  log "  实例已是 STOPPED，跳过停止"
fi

log "  更新 shape 为 ${TARGET_OCPUS} OCPU / ${TARGET_MEMORY_GB} GB"
oci compute instance update \
  --instance-id  "$instance_id" \
  --shape        "$SHAPE" \
  --shape-config "{\"ocpus\":${TARGET_OCPUS},\"memoryInGBs\":${TARGET_MEMORY_GB}}" \
  >/dev/null
log "  ✅ shape 已更新"

log "  启动实例（等待 RUNNING，最长 15 分钟）"
oci compute instance action \
  --action               START \
  --instance-id          "$instance_id" \
  --wait-for-state       RUNNING \
  --max-wait-seconds     900 \
  --wait-interval-seconds 15 \
  >/dev/null

# ───────────────────────── 复核 ─────────────────────────
final_json=$(oci compute instance get --instance-id "$instance_id" --output json)
final_state=$(jq -r '.data."lifecycle-state"'               <<< "$final_json")
final_ocpus=$(jq -r '.data."shape-config".ocpus  // "?"'    <<< "$final_json")
final_mem=$(jq -r '.data."shape-config".memoryInGBs // "?"' <<< "$final_json")

log "  ✅ 启动完成"
echo
log "════════ 完成 ════════"
log "instance-id : $instance_id"
log "状态        : $final_state"
log "规格        : ${final_ocpus} OCPU / ${final_mem} GB"
