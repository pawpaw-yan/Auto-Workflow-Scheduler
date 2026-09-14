import logging
import sys


def init_logger(level: int = logging.INFO) -> logging.Logger:
    """初始化并返回全局 logger。

    注意：index.py 中通过 `from logging_config import init_logger` 引用本函数。
    当前为最小可用实现，如需自定义格式/级别，直接修改本文件即可。
    """
    logger = logging.getLogger("oracle_abc")

    # 避免重复添加 handler（重复导入时）
    if logger.handlers:
        return logger

    # 日志走 stdout；CI 里被 tee 重定向、本地被管道捕获时，
    # 某些平台会退回 locale 编码导致输出异常，这里强制 UTF-8。
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
