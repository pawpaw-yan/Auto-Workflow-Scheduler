#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════
# oracle-abc —— 抢占 OCI Ampere A1 实例并分步升级规格
#
# 实现方式：OCI Python SDK（不再依赖 oci CLI，也不再依赖 jq）
#
# 流程（幂等，可反复执行）：
#   1. 按 display-name 查找实例（排除 TERMINATED / TERMINATING）
#   2. 不存在 → 尝试创建「GRAB_OCPUS / GRAB_MEMORY_GB」的 A1 实例
#                容量不足 → 打 ::warning:: 并退出 0，等外部调度器下次重试
#   3. 存在   → 升级循环（每轮重新读取一次当前状态）：
#                ┌─ 读当前 OCPU
#                │  已达到 TARGET → 结束
#                │  否则 → 停止 → 升级到「当前 × STEP_FACTOR」→ 启动
#                └─ 升级成功后立刻回到开头重新判断
#
#   例：GRAB_OCPUS=1 TARGET_OCPUS=4，默认 STEP_FACTOR=2，升级路径为
#         1c/6g  →  2c/12g  →  4c/24g        （跳过 3c/18g）
#
#   分步升级而不是一次跳到位，是为了让每一步都有独立的成功机会；
#   如果某一步失败，至少还能停在上一档已经成功的规格上。
#
# 退出码：
#   0  成功；或「没有容量，稍后重试」这类预期内结果；或已达标无需操作
#   1  真正的错误（配置缺失、认证失败、OCI 调用异常、升级未生效）
#
# 关于认证：
#   本脚本不读 ~/.oci/config，直接读环境变量：
#     OCI_CLI_USER / OCI_CLI_FINGERPRINT / OCI_CLI_TENANCY / OCI_CLI_REGION
#     OCI_CLI_KEY_CONTENT（私钥内容）或 OCI_CLI_KEY_FILE（私钥路径）
#     OCI_CLI_PASSPHRASE（可选，仅当私钥带口令加密时需要）
# ═══════════════════════════════════════════════════════════════════════

from __future__ import annotations

import os
import sys
import traceback
from types import SimpleNamespace
from typing import NoReturn

# python/logging_config.py 是语言级共享模块。本文件位于 python/<项目>/，
# 比共享模块深一层，因此要先把上层目录加入 sys.path 才能 import 到它。
# 项目目录放在最前，允许项目用同名模块覆盖共享实现。
# 这样无论从哪个目录启动（execute.sh 会 cd 到项目目录、也可从仓库根直接跑），
# import 都能解析。
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))  # python/
sys.path.insert(0, _HERE)                   # 项目自身

try:
    from oci import pagination
    from oci.core import ComputeClient, ComputeClientCompositeOperations
    from oci.core.models import (
        CreateVnicDetails,
        InstanceSourceViaImageDetails,
        LaunchInstanceDetails,
        LaunchInstanceShapeConfigDetails,
        UpdateInstanceDetails,
        UpdateInstanceShapeConfigDetails,
    )
    from oci.exceptions import ServiceError, WaiterError
except ImportError as exc:
    print(
        f"::error::缺少依赖 oci（{exc}）；"
        "请先执行 pip install -r python/oracle-abc/requirements.txt",
        file=sys.stderr,
        flush=True,
    )
    sys.exit(1)

from logging_config import init_logger

logger = init_logger("oracle_abc")

SHAPE = os.environ.get("OCI_SHAPE") or "VM.Standard.A1.Flex"

DEFAULT_INSTANCE_NAME = "oracle-abc"

# 等待实例状态迁移的上限
WAIT_MAX_SECONDS = 900
WAIT_INTERVAL_SECONDS = 15

LIFECYCLE_RUNNING = "RUNNING"
LIFECYCLE_STOPPED = "STOPPED"
# 已终结 / 正在终结的实例不视为「已存在」，否则会永远删不掉也升级不了
LIFECYCLE_DEAD = ("TERMINATED", "TERMINATING")

# STOP_ACTION 白名单：本任务只需要「停下来改规格」，不需要 reset 之类
VALID_STOP_ACTIONS = ("SOFTSTOP", "STOP")

# 预览升级路径时的迭代上限，纯粹是防御性兜底
MAX_PREVIEW_ROUNDS = 32


# ─────────────────────────── 输出工具 ───────────────────────────
def warn(message: str) -> None:
    """输出 GitHub workflow 警告。必须是行首裸文本，不能带日志前缀。"""
    print(f"::warning::{message}", flush=True)


def die(message: str) -> NoReturn:
    """输出 GitHub workflow 错误并退出 1。"""
    print(f"::error::{message}", file=sys.stderr, flush=True)
    sys.exit(1)


def fmt_num(value) -> str:
    """把 OCI 返回的浮点规格压成整数显示（1.0 → 1），非数字原样返回。"""
    if value is None:
        return "?"
    try:
        return f"{float(value):g}"
    except (TypeError, ValueError):
        return str(value)


# ─────────────────────────── 配置读取 ───────────────────────────
def require_env(name: str, when: str = "") -> str:
    value = (os.environ.get(name) or "").strip()
    if not value:
        suffix = f"（{when}）" if when else ""
        die(f"缺少必填配置 {name}{suffix}")
    return value


def positive_int(name: str, raw: str) -> int:
    text = str(raw or "").strip()
    if not text.isdigit():
        die(f"{name} 必须是正整数，当前值：'{text}'")
    value = int(text)
    if value <= 0:
        die(f"{name} 必须大于 0，当前值：{value}")
    return value


def read_settings() -> SimpleNamespace:
    grab_ocpus = positive_int("GRAB_OCPUS", os.environ.get("GRAB_OCPUS") or "1")
    grab_memory_gb = positive_int("GRAB_MEMORY_GB", os.environ.get("GRAB_MEMORY_GB") or "6")
    target_ocpus = positive_int("TARGET_OCPUS", os.environ.get("TARGET_OCPUS") or "2")
    step_factor = positive_int("STEP_FACTOR", os.environ.get("STEP_FACTOR") or "2")
    boot_volume_gb = positive_int("OCI_BOOT_VOLUME_GB", os.environ.get("OCI_BOOT_VOLUME_GB") or "50")

    # 每个 OCPU 配多少内存。默认沿用抢占时的比例（如 1c6g → 每 OCPU 6GB），
    # 于是 2c 配 12GB、4c 配 24GB。可用 MEMORY_PER_OCPU 显式覆盖。
    raw_memory_per_ocpu = (os.environ.get("MEMORY_PER_OCPU") or "").strip()
    if raw_memory_per_ocpu:
        memory_per_ocpu = positive_int("MEMORY_PER_OCPU", raw_memory_per_ocpu)
    else:
        memory_per_ocpu = max(1, grab_memory_gb // grab_ocpus)

    stop_action = (os.environ.get("STOP_ACTION") or "SOFTSTOP").strip().upper()
    if stop_action not in VALID_STOP_ACTIONS:
        die(
            "STOP_ACTION 只支持 "
            + " / ".join(VALID_STOP_ACTIONS)
            + f"（SOFTSTOP = 优雅关机，推荐），当前值：'{stop_action}'"
        )

    return SimpleNamespace(
        instance_name=(os.environ.get("OCI_INSTANCE_NAME") or "").strip() or DEFAULT_INSTANCE_NAME,
        grab_ocpus=grab_ocpus,
        grab_memory_gb=grab_memory_gb,
        target_ocpus=target_ocpus,
        step_factor=step_factor,
        memory_per_ocpu=memory_per_ocpu,
        boot_volume_gb=boot_volume_gb,
        stop_action=stop_action,
    )


def build_oci_config() -> dict:
    """从环境变量拼出 OCI SDK 的 config（等价于 OCI CLI 的原生环境变量支持）。"""
    key_content = (os.environ.get("OCI_CLI_KEY_CONTENT") or "").strip()
    key_file = (os.environ.get("OCI_CLI_KEY_FILE") or "").strip()

    if not key_content and not key_file:
        die(
            "缺少 OCI 私钥：请配置 OCI_CLI_KEY_CONTENT（私钥内容，CI 用）"
            "或 OCI_CLI_KEY_FILE（私钥路径，本地用）"
        )

    config = {
        "user": require_env("OCI_CLI_USER"),
        "fingerprint": require_env("OCI_CLI_FINGERPRINT"),
        "tenancy": require_env("OCI_CLI_TENANCY"),
        "region": require_env("OCI_CLI_REGION"),
    }

    # SDK 要求 key_content 与 key_file 只能二选一
    if key_content:
        config["key_content"] = key_content
    else:
        config["key_file"] = key_file

    # 口令必须留空时不设置：空的 pass_phrase 会干扰未加密私钥的解析
    pass_phrase = (os.environ.get("OCI_CLI_PASSPHRASE") or "").strip()
    if pass_phrase:
        config["pass_phrase"] = pass_phrase

    return config


# ─────────────────────────── 升级路径计算 ───────────────────────────
def next_step(current: int, target: int, factor: int) -> int:
    """计算从 current 升到 target 的下一档（保证一定前进，且不超过 target）。"""
    nxt = current * factor
    if nxt <= current:  # 防止 STEP_FACTOR=1 时原地打转
        nxt = current + 1
    if nxt > target:  # 不越过目标
        nxt = target
    return nxt


def preview_path(start: int, target: int, factor: int) -> str:
    """预览升级路径，仅用于日志，方便一眼核对配置是否符合预期。"""
    parts = [f"{start}c"]
    previous = current = start
    for _ in range(MAX_PREVIEW_ROUNDS):
        if current >= target:
            break
        current = next_step(previous, target, factor)
        parts.append(f"{current}c")
        previous = current
    return " → ".join(parts)


def is_capacity_error(exc: ServiceError) -> bool:
    """判断是否「没有容量」。

    这是本任务最常见的正常结果（A1 常年缺货），不能当失败处理。
    """
    code = (exc.code or "").lower()
    message = (exc.message or "").lower()

    if "capacity" in code:
        return True
    if "out of host capacity" in message or "outofcapacity" in message:
        return True
    # 部分区域用 500 InternalError + 文本里带 capacity 的形式返回
    return exc.status == 500 and "capacity" in message


# ─────────────────────────── OCI 操作 ───────────────────────────
def find_instance_id(compute: ComputeClient, compartment_id: str, display_name: str):
    """按 display-name 查找存活实例，返回最新的那个 id；找不到返回 None。"""
    response = pagination.list_call_get_all_results(
        compute.list_instances,
        compartment_id,
        display_name=display_name,
    )

    candidates = [
        instance
        for instance in response.data
        if instance.display_name == display_name
        and instance.lifecycle_state not in LIFECYCLE_DEAD
    ]
    if not candidates:
        return None

    # 取最新创建的一台。time_created 是 datetime，转字符串比较可避免
    # 个别实例该字段为 None 时排序报错（ISO 格式的字符串排序结果一致）。
    candidates.sort(key=lambda item: str(item.time_created or ""), reverse=True)
    return candidates[0].id


def try_launch(composite: ComputeClientCompositeOperations, settings: SimpleNamespace) -> str | None:
    """尝试创建实例。

    返回 instance id；容量不足返回 None（预期内结果，由调用方按成功收尾）。
    """
    details = LaunchInstanceDetails(
        availability_domain=require_env("OCI_AVAILABILITY_DOMAIN", "仅在创建实例时需要"),
        compartment_id=require_env("OCI_COMPARTMENT_ID"),
        display_name=settings.instance_name,
        shape=SHAPE,
        shape_config=LaunchInstanceShapeConfigDetails(
            ocpus=float(settings.grab_ocpus),
            memory_in_gbs=float(settings.grab_memory_gb),
        ),
        source_details=InstanceSourceViaImageDetails(
            image_id=require_env("OCI_IMAGE_ID", "仅在创建实例时需要"),
            boot_volume_size_in_gbs=settings.boot_volume_gb,
        ),
        create_vnic_details=CreateVnicDetails(
            subnet_id=require_env("OCI_SUBNET_ID", "仅在创建实例时需要"),
            assign_public_ip=True,
        ),
    )

    ssh_public_key = (os.environ.get("OCI_SSH_PUBLIC_KEY") or "").strip()
    if ssh_public_key:
        details.metadata = {"ssh_authorized_keys": ssh_public_key}

    try:
        response = composite.launch_instance_and_wait_for_state(
            details,
            wait_for_states=[LIFECYCLE_RUNNING],
            waiter_kwargs={
                "max_wait_seconds": WAIT_MAX_SECONDS,
                "max_interval_seconds": WAIT_INTERVAL_SECONDS,
            },
        )
        return response.data.id
    except ServiceError as exc:
        if is_capacity_error(exc):
            warn("没有可用容量，本次未抢到，等待调度器下次重试")
            logger.info("  OCI 返回：[%s] %s — %s", exc.status, exc.code, exc.message)
            return None
        raise
    except WaiterError as exc:
        die(f"实例已受理但未在 {WAIT_MAX_SECONDS}s 内进入 {LIFECYCLE_RUNNING}：{exc}（下次运行会重新发现它）")


def instance_action(composite: ComputeClientCompositeOperations, instance_id: str, action: str, target_state: str) -> None:
    composite.instance_action_and_wait_for_state(
        instance_id,
        action,
        wait_for_states=[target_state],
        waiter_kwargs={
            "max_wait_seconds": WAIT_MAX_SECONDS,
            "max_interval_seconds": WAIT_INTERVAL_SECONDS,
        },
    )


def upgrade_until_target(
    compute: ComputeClient,
    composite: ComputeClientCompositeOperations,
    settings: SimpleNamespace,
    instance_id: str,
) -> int:
    """分步升级到 TARGET，返回实际执行的升级轮数。"""
    if settings.grab_ocpus >= settings.target_ocpus:
        logger.info(
            "  抢占规格(%dc) 已达/超过目标(%dc)，无需升级",
            settings.grab_ocpus,
            settings.target_ocpus,
        )
        return 0

    # 兜底：防止因升级未生效（当前规格不前进）导致死循环
    max_rounds = max(3, settings.target_ocpus - settings.grab_ocpus + 2)
    rounds = 0

    while True:
        rounds += 1
        if rounds > max_rounds:
            die(f"升级轮数超过上限 {max_rounds}，疑似升级未生效，中止")

        # ── 每轮都重新读取当前状态（这就是「升级完立刻重新判断」）──
        instance = compute.get_instance(instance_id).data
        shape_config = instance.shape_config
        current_ocpus = (shape_config.ocpus if shape_config else None) or 0
        current_memory = shape_config.memory_in_gbs if shape_config else None
        current_state = instance.lifecycle_state

        logger.info(
            "── 第 %d 轮：当前 %s OCPU / %s GB，状态 %s",
            rounds,
            fmt_num(current_ocpus),
            fmt_num(current_memory),
            current_state,
        )

        # ── 已达到目标 → 结束 ──
        if current_ocpus >= settings.target_ocpus:
            logger.info("  ✅ 已达到目标 %d OCPU，升级结束", settings.target_ocpus)
            return rounds - 1

        # ── 本轮升级到「当前 × STEP_FACTOR」，且不超过目标 ──
        wanted_ocpus = next_step(int(current_ocpus), settings.target_ocpus, settings.step_factor)
        wanted_memory = wanted_ocpus * settings.memory_per_ocpu

        logger.info(
            "  升级 %sc → %sc（%d GB）",
            fmt_num(current_ocpus),
            wanted_ocpus,
            wanted_memory,
        )

        if current_state != LIFECYCLE_STOPPED:
            logger.info(
                "    停止实例（%s，等待 %s，最长 %ds）",
                settings.stop_action,
                LIFECYCLE_STOPPED,
                WAIT_MAX_SECONDS,
            )
            instance_action(composite, instance_id, settings.stop_action, LIFECYCLE_STOPPED)
            logger.info("    已停止")
        else:
            logger.info("    实例已是 STOPPED，跳过停止")

        logger.info("    更新 shape")
        compute.update_instance(
            instance_id,
            UpdateInstanceDetails(
                shape=SHAPE,
                shape_config=UpdateInstanceShapeConfigDetails(
                    ocpus=float(wanted_ocpus),
                    memory_in_gbs=float(wanted_memory),
                ),
            ),
        )
        logger.info("    shape 已更新")

        logger.info("    启动实例（等待 %s，最长 %ds）", LIFECYCLE_RUNNING, WAIT_MAX_SECONDS)
        instance_action(composite, instance_id, "START", LIFECYCLE_RUNNING)
        logger.info("    启动完成 → 回到顶部重新判断是否需要继续升级")


# ─────────────────────────── 主流程 ───────────────────────────
def main() -> int:
    settings = read_settings()
    config = build_oci_config()
    compartment_id = require_env("OCI_COMPARTMENT_ID")

    logger.info("════════ oracle-abc 启动 ════════")
    logger.info("实例名        : %s", settings.instance_name)
    logger.info("抢占规格      : %d OCPU / %d GB", settings.grab_ocpus, settings.grab_memory_gb)
    logger.info("升级目标      : %d OCPU", settings.target_ocpus)
    logger.info("放大倍数      : ×%d", settings.step_factor)
    logger.info(
        "升级路径      : %s",
        preview_path(settings.grab_ocpus, settings.target_ocpus, settings.step_factor),
    )
    logger.info("每 OCPU 内存  : %d GB", settings.memory_per_ocpu)
    logger.info("Shape         : %s", SHAPE)
    logger.info("区域          : %s", config["region"])
    logger.info(
        "可用域        : %s",
        (os.environ.get("OCI_AVAILABILITY_DOMAIN") or "").strip()
        or "（未设置，仅在创建时需要）",
    )
    logger.info("")

    compute = ComputeClient(config)
    composite = ComputeClientCompositeOperations(compute)

    # ── 步骤 1：查找实例 ──
    logger.info("步骤 1/3  查找已存在的实例")
    instance_id = find_instance_id(compute, compartment_id, settings.instance_name)

    # ── 步骤 2：抢占 ──
    if instance_id:
        logger.info("步骤 2/3  已存在实例，跳过创建")
    else:
        logger.info(
            "步骤 2/3  未找到实例，尝试创建 %d OCPU / %d GB",
            settings.grab_ocpus,
            settings.grab_memory_gb,
        )
        instance_id = try_launch(composite, settings)
        if instance_id is None:
            logger.info("════════ 结束：未抢到（预期内）════════")
            return 0
        logger.info("  ✅ 抢到了！instance-id = %s", instance_id)

    logger.info("  instance-id = %s", instance_id)
    logger.info("")

    # ── 步骤 3：分步升级到 TARGET ──
    logger.info(
        "步骤 3/3  分步升级到 %d OCPU（每轮 ×%d）",
        settings.target_ocpus,
        settings.step_factor,
    )
    rounds = upgrade_until_target(compute, composite, settings, instance_id)

    # ── 复核 ──
    final = compute.get_instance(instance_id).data
    final_shape = final.shape_config

    logger.info("")
    logger.info("════════ 完成 ════════")
    logger.info("instance-id : %s", instance_id)
    logger.info("共升级轮数  : %d", rounds)
    logger.info("状态        : %s", final.lifecycle_state)
    logger.info(
        "规格        : %s OCPU / %s GB",
        fmt_num(final_shape.ocpus if final_shape else None),
        fmt_num(final_shape.memory_in_gbs if final_shape else None),
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except ServiceError as exc:
        die(f"OCI 调用失败：[{exc.status}] {exc.code} — {exc.message}")
    except WaiterError as exc:
        die(f"等待实例状态超时（上限 {WAIT_MAX_SECONDS}s）：{exc}")
    except Exception:  # noqa: BLE001 - 兜底：任何未预期异常都必须让 job 变红
        traceback.print_exc()
        die("执行过程中出现未预期的错误，详见上方堆栈")
