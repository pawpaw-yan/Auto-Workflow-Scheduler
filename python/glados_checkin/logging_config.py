import logging
import sys


def init_logger(level: int = logging.INFO) -> logging.Logger:
    """初始化并返回全局 logger。

    注意：index.py 中通过 `from logging_config import init_logger` 引用本函数。
    当前为最小可用实现，如需自定义格式/级别，直接修改本文件即可。
    """
    logger = logging.getLogger("glados_checkin")

    # 避免重复添加 handler（重复导入时）
    if logger.handlers:
        return logger

    logger.setLevel(level)

    handler = logging.StreamHandler(sys.stdout)
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
