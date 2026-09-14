"""Python 的语言级共享模块包。

放在本目录下的模块可以被任意 `python/<项目>/index.py` 引用，例如：

    from common.logging_config import init_logger

目录约定（与仓库根的 `common/` 对称）：

    common/                 跨语言共享（shell 脚本，按路径调用）
    python/common/           Python 语言级共享（被 import）  ← 本目录
    python/<项目>/index.py    各项目入口

以后加 PHP 项目即 `php/common/`，保持同一套结构。
"""
