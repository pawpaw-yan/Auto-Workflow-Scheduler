"""语言级共享的 `.env` 加载模块。

位置：`python/common/dotenv.py`
被 `python/<项目>/index.py` 通过 `from common.dotenv import load_dotenv` 引用。

与 `logging_config.py` 一样属于 **Python 语言级共享代码**，
和仓库根的 `common/`（跨语言 shell 脚本）对称。

**它解决什么**：把「项目目录下的 `.env`」作为**最低优先级**的配置来源。

最终优先级（高 → 低）：

    ref（inputs.overrides）  >  vars / secrets（workflow env）  >  .env

落地方式就一条规则：**只填补当前环境里「未设置或为空」的项**。
业务脚本跑到这里时，上面两层都已经在 `os.environ` 里了，所以 `.env` 天然只能捡剩下的空位。
这条规则顺带保证了 `.env` 改不坏 `PATH` / `GITHUB_*` 这类运行时变量（它们永远非空）。

**格式**（`.env.example` 里有同样的说明）：

    KEY=VALUE              原样
    KEY="VALUE\\nVALUE"    双引号内 \\n 还原成真换行（多行值靠它），首尾引号去掉
    KEY='VALUE'            单引号内完全字面，不做任何转义
    export KEY=VALUE       export 前缀可有可无
    # 注释 / 空行会被忽略

**注意**：

- 不负责注册日志遮蔽。哪些值是敏感的需要业务脚本自己判断
  （见 `glados_checkin/index.py` 里的 `register_masks`）。
- ⚠️ `.env` 已加入 `.gitignore`，**不要提交**：它通常装的是 cookie / 私钥这类真凭据。
  原因见仓库根 README 的「郑重提示」。
"""

from __future__ import annotations

import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Union

# shell 变量名格式。挡掉 `BAD-NAME=x` 这类会被静默忽略的写法
_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# `export ` 前缀
_EXPORT_PREFIX = "export "


@dataclass
class DotenvResult:
    """加载结果，供调用方打日志。

    **只记录名字，绝不保存值** —— 免得哪天顺手把它整个打进日志。
    """

    path: Path
    exists: bool = False
    applied: List[str] = field(default_factory=list)   # 本次由 .env 补上的项
    skipped: List[str] = field(default_factory=list)   # 已被上层提供、被忽略的项
    invalid: List[str] = field(default_factory=list)   # 格式有问题的行，形如 "12 行：..."

    @property
    def loaded_anything(self) -> bool:
        return bool(self.applied)


def _parse_value(raw: str) -> str:
    """按 `.env` 约定处理一个值：去首尾空白、剥成对引号、双引号内还原 ``\\n``。"""
    value = raw.strip()

    if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
        # 只把两字符序列 \n 换成真换行。
        # 不用 unicode_escape / codecs：那会顺带解释 \t \\ \x 等一堆转义，语义太宽，
        # 容易把 cookie 里的反斜杠序列改掉。
        return value[1:-1].replace("\\n", "\n")

    if len(value) >= 2 and value.startswith("'") and value.endswith("'"):
        return value[1:-1]

    return value


def load_dotenv(
    path: Union[str, Path],
    logger: Optional[logging.Logger] = None,
) -> DotenvResult:
    """读取 `path` 指向的 `.env`，把「未设置或为空」的项写进 `os.environ`。

    参数：
        path     `.env` 文件路径（一般是 `<项目目录>/.env`）。不存在则什么都不做。
        logger   可选。传了就输出一条加载摘要，否则静默。

    返回：
        `DotenvResult`，包含「补上了哪些名字 / 忽略了哪些名字 / 哪些行有问题」。

    只输出**名字**，不输出值 —— 调用方也不该把值打出来。
    """
    result = DotenvResult(path=Path(path))

    if not result.path.is_file():
        return result

    result.exists = True

    # utf-8-sig：编辑器（尤其 Windows）存 UTF-8 时可能带 BOM，用它一并吃掉
    content = result.path.read_text(encoding="utf-8-sig")

    for lineno, raw_line in enumerate(content.splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        if line.startswith(_EXPORT_PREFIX):
            line = line[len(_EXPORT_PREFIX):].strip()

        name, sep, raw_value = line.partition("=")
        if not sep:
            result.invalid.append(f"{lineno} 行不是 KEY=VALUE 形式")
            continue

        name = name.strip()
        if not _NAME_RE.match(name):
            result.invalid.append(f"{lineno} 行名称 '{name}' 非法（只允许字母/数字/下划线）")
            continue

        # 核心规则：非空 = 已被 ref 或 vars / secrets 提供，保持不动
        if os.environ.get(name):
            result.skipped.append(name)
            continue

        os.environ[name] = _parse_value(raw_value)
        result.applied.append(name)

    if logger is not None:
        _log_result(logger, result)

    return result


def _log_result(logger: logging.Logger, result: DotenvResult) -> None:
    """把加载结果写进日志。只列名字，不列值。"""
    if result.applied:
        logger.info(
            f"ℹ️  {result.path} 补入了 {len(result.applied)} 项默认配置："
            f"{' '.join(result.applied)}"
        )

    if result.skipped:
        logger.info(
            f"ℹ️  {result.path} 里有 {len(result.skipped)} 项已被更高优先级"
            f"（ref / vars / secrets）提供，忽略：{' '.join(result.skipped)}"
        )

    for message in result.invalid:
        logger.warning(f"⚠️  {result.path}:{message}，已忽略")

    if not result.applied and not result.skipped and not result.invalid:
        logger.info(f"ℹ️  {result.path} 存在，但没有可用的配置项")
