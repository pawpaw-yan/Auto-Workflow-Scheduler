"""语言级共享的日志初始化模块。

位置：`python/common/logging_config.py`
被 `python/<项目>/index.py` 通过 `from common.logging_config import init_logger` 引用。

**目录约定**：

    common/                     跨语言共享：shell 脚本，按路径调用（bash common/xxx.sh）
    python/requirements.txt     语言级公共依赖
    python/common/              语言级共享代码：Python 模块，被 import      ← 本模块
    python/<项目>/index.py      各项目入口

与仓库根的 `common/` 对称——根 `common/` 装跨语言的 shell 脚本，
`<语言>/common/` 装该语言的共享模块。以后加 PHP 项目即 `php/common/`。

**项目如何找到它**：本模块属于 `python/common` 包，而项目位于 `python/<项目>/`，
比包根 `python/` 深一层，因此各项目 `index.py` 开头会把 `python/` 加入 `sys.path`
（见各项目的 bootstrap 段落）。这样无论从哪个目录启动都能 import 到。
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
