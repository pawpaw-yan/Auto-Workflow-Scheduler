"""语言级共享的日志初始化模块。

位置：`python/logging_config.py`
被 `python/<项目>/index.py` 通过 `from logging_config import init_logger` 引用。

**为什么放在 `python/` 而不是 `common/`**：
`common/` 装的是「按路径调用」的跨语言 shell 脚本（`bash common/xxx.sh`），
而本模块是「被 import」的 Python 模块，属于**语言级**共享资源，
与同目录的 `python/requirements.txt` 对称。
以后若加 `php/` 公共库，同样放 `php/` 下。

**项目如何找到它**：项目位于 `python/<项目>/`，比共享模块深一层，
因此各项目 `index.py` 开头会把上层目录加入 `sys.path`（见各项目的 bootstrap 段落）。
"""

import logging
import sys


def init_logger(name: str, level: int = logging.INFO) -> logging.Logger:
    """初始化并返回指定名称的 logger。

    name 传项目名（如 `glados_checkin` / `oracle_abc`），这样：
      - 日志来源清晰，不同项目不会复用同一个 logger 实例
      - 各项目的 handler 互不干扰

    行为：
      - 输出到 stdout（GitHub Actions 的日志即 stdout）
      - 强制 UTF-8：Windows 或输出被管道/文件重定向时，Python 会退回 locale
        编码（GBK），打印 emoji 会抛 UnicodeEncodeError
      - 若 logger 已有 handler（重复导入）则直接返回，不重复添加

    如需自定义日志格式/级别，直接修改本文件即可（所有 Python 项目同步生效）。
    """
    logger = logging.getLogger(name)

    # 避免重复添加 handler（重复导入时）
    if logger.handlers:
        return logger

    stream = sys.stdout
    if hasattr(stream, "reconfigure"):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, OSError, ValueError):
            pass

    logger.setLevel(level)

    handler = logging.StreamHandler(stream)
    handler.setLevel(level)
    handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s | %(levelname)-7s | %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )

    logger.addHandler(handler)
    logger.propagate = False
    return logger
