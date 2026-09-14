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

    # 日志里含 emoji。Windows 上当 stdout 被重定向（管道、写文件、IDE 捕获）时，
    # Python 会退回 locale 编码（GBK），打印 emoji 会抛 UnicodeEncodeError。
    # 这里强制 stdout 走 UTF-8，本地跑和 CI 跑行为一致。
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
