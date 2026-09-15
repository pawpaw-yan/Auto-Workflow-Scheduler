#!/usr/bin/env python3
# ═══════════════════════════════════════════════════════════════════════
# api_checkin —— new-api / one-api 站点每日签到
#
# 支持：多站点、一个站点挂多个账号、每个账号用 cookie 或访问令牌。
#
# 认证（每个账号二选一）：
#   cookie —— 浏览器登录后的会话 Cookie，形如 `session=xxx` 或 `new-api-session=xxx`
#   token  —— 「个人设置 → 安全设置 → 系统访问令牌」生成的那一串
#
#   ⚠️ **系统访问令牌不一定是 `sk-` 开头。** 新版生成的是 `aNSC...Y/8` 这类随机串；
#      `sk-` 开头的通常只是「模型调用 key」，老 one-api / 部分 fork 的 sk- 不能用于管理接口。
#      下面的自动判断只认 `sk-` 前缀，所以**令牌请一律显式写** `token:<值>`
#      或 `{"token":"..."}` —— 否则要么直接报错，要么因含 `=` 被误判成 cookie。
#
# 用到的两个接口（new-api / one-api 通用）：
#   GET  /api/user/self     校验凭证 + 读额度
#   POST /api/user/checkin  签到
#
#   令牌鉴权时「部分接口」还要求带一个用户标识头 `New-Api-User: <用户ID>`，
#   所以账号配置里支持一个可选的用户 ID（见 .env.example）。
#
# 额度展示方式：签到前后各读一次 /api/user/self，用差值表示这次签到领到多少额度。
# 这样不依赖各站自定义的返回字段，比猜 `data` 的结构稳得多。
#
# 账号配置 SITES 支持两种写法（以 `{` 开头就当 JSON，否则按行格式解析）：
#
#   ① JSON —— 用 ref 传参时推荐。值是「按类型分桶」（推荐）或「扁平数组」（早期写法）
#        // 分桶：桶名即类型，桶内元素**一律是对象**，所以不做任何猜测 ——
#        //      非 sk- 开头的令牌也能直接用；user_id / label 总有地方放。
#        {"https://a.com": {"cookies": [{"cookie": "session=xxx"}],
#                           "tokens":  [{"token": "aNSC...Y/8", "user_id": "38798",
#                                        "label": "备用"}]},
#         "https://b.com": {"tokens": [{"token": "sk-zzz"}]}}
#        // 扁平数组（早期写法）：靠自动判断类型，非 sk- 令牌必须写 `token:` 前缀
#        {"https://a.com": ["session=xxx", "sk-yyy"]}
#
#   ② 行格式 —— 写进 Environment secret 时推荐（类型是独立一段，天然无歧义）
#        <站点地址>|<账号标签>|<cookie 或 token[=用户ID]>|<凭证>
#
# 配置来源（优先级从高到低）：ref > vars / secrets > <项目目录>/.env
# ref 层由 workflow 里那行 `KEY: ${{ inputs.KEY || secrets.KEY }}` 实现 ——
# 本脚本不做任何特殊处理，ref / vars / secrets / .env 全都以普通环境变量到达。
#
# ⚠️ 用 ref 传凭证等同于公开：workflow_dispatch 的 inputs 不受脱敏保护，
#    公开仓库的 run 详情页任何人都能看到。详见 README 的「用 ref 传账号」。
#    但**告警由通用层统一发** —— common/report-inputs.sh 会检查被传入的项里
#    有没有登记在 SECRET_NAMES 的，本脚本不做任何 ref 相关的特殊处理。
#
# 退出码：
#   0  跑完了（含签到失败、重复签到这类业务结果）
#   1  配置写错 / 无法解析 —— 这类问题必须让人看见
# ═══════════════════════════════════════════════════════════════════════

from __future__ import annotations

import json
import os
import re
import sys
import traceback
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# python/common/ 是 Python 的语言级共享包。本文件位于 python/<项目>/，
# 要把上层目录（python/）加入 sys.path 才能 `from common.xxx import ...`。
# 项目目录放在最前，允许项目用同名模块覆盖共享实现。
# 这样无论从哪个目录启动（execute.sh 会 cd 到项目目录、也可从仓库根直接跑），
# import 都能解析。
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))  # python/
sys.path.insert(0, _HERE)                   # 项目自身

try:
    import requests
except ImportError as exc:
    print(
        f"::error::缺少依赖 requests（{exc}）；"
        "请先执行 pip install -r python/api_checkin/requirements.txt",
        file=sys.stderr,
        flush=True,
    )
    sys.exit(1)

from common.dotenv import load_dotenv  # noqa: E402
from common.logging_config import init_logger  # noqa: E402

logger = init_logger("api_checkin")


# ─────────────────────────── 常量 ───────────────────────────
ENV_SITES = "SITES"
ENV_PUSH_KEY = "PUSHDEER_SENDKEY"
ENV_VERBOSE = "API_VERBOSE"
ENV_TIMEOUT = "API_TIMEOUT"

SELF_PATH = "/api/user/self"
CHECKIN_PATH = "/api/user/checkin"

AUTH_COOKIE = "cookie"
AUTH_TOKEN = "token"
VALID_AUTH_KINDS = (AUTH_COOKIE, AUTH_TOKEN)

DEFAULT_TIMEOUT = 15
DEFAULT_VERBOSE = False

# 账号配置每行 4 段，用 | 分隔。凭证放在**最后一段**，所以凭证里出现 | 也不会被切断。
SITES_FIELDS = 4
SITES_FORMAT_HINT = (
    "每行格式：<站点地址>|<账号标签>|<cookie 或 token[=用户ID]>|<凭证>\n"
    "  例：https://api.example.com|主号|cookie|session=abc; new-api-session=def\n"
    "  例：https://api.example.com|小号|token=42|sk-abcdefghijklmn"
)

# 判定「今天已经签过」用的关键词（各站文案不统一，尽量都覆盖）
REPEAT_KEYWORDS = ("已签", "重复", "already")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)


class LogEmoji:
    """日志 Emoji 常量（和 glados_checkin 保持一致，日志读起来一个风格）"""

    SUCCESS = "✅"
    FAIL = "❌"
    REPEAT = "🔄"
    CHECKIN = "🎫"
    STATUS = "📊"
    POINTS = "💰"
    START = "🚀"
    END = "🏁"
    ACCOUNT = "👤"
    SITE = "🌐"
    WARNING = "⚠️ "
    ERROR = "🔴"
    INFO = "ℹ️ "


# ─────────────────────────── 输出工具 ───────────────────────────
def register_masks(values: List[str]) -> None:
    """在 GitHub Actions 里把敏感值注册进日志遮蔽列表。

    GitHub 的脱敏只按「完整机密值」做字面匹配，而每个凭证只是多行机密
    SITES 里的一小段，属于片段 —— 不主动注册的话，日志里出现就是明文。
    本地运行（无 GITHUB_ACTIONS）直接跳过，避免往 stdout 打噪音。
    """
    if not os.environ.get("GITHUB_ACTIONS"):
        return

    for value in values:
        value = (value or "").strip()
        # 太短的值 GitHub 会拒绝遮蔽，注册了也没用
        if len(value) >= 4:
            print(f"::add-mask::{value}", flush=True)


# ─────────────────────────── 配置 ───────────────────────────
@dataclass
class Account:
    """一个「站点 + 账号」任务"""

    site: str            # 站点根地址，已去掉结尾的 /
    label: str           # 账号标签，只用于日志
    kind: str            # cookie / token
    secret: str          # 凭证本身
    user_id: str = ""    # 可选。token 鉴权时部分接口要求带 New-Api-User

    @property
    def display(self) -> str:
        return f"{self.site} [{self.label}]"


class ConfigError(Exception):
    """配置写错 —— 这类问题直接退出 1，不能悄悄跳过"""


def _build_account(site: str, label: str, kind_field: str, secret: str, lineno: int) -> Account:
    if not site:
        raise ConfigError(f"SITES 第 {lineno} 行：站点地址为空")
    if not re.match(r"^https?://", site):
        raise ConfigError(
            f"SITES 第 {lineno} 行：站点地址必须以 http:// 或 https:// 开头，当前是 '{site}'"
        )

    # 类型字段允许带一个可选参数：`token=42` 表示令牌 + 用户 ID 42
    kind, _, user_id = kind_field.partition("=")
    kind = kind.strip().lower()
    if kind not in VALID_AUTH_KINDS:
        raise ConfigError(
            f"SITES 第 {lineno} 行：认证类型只能是 {' / '.join(VALID_AUTH_KINDS)}，"
            f"当前是 '{kind}'"
        )

    if not secret:
        raise ConfigError(f"SITES 第 {lineno} 行：凭证为空")

    return Account(
        site=site.rstrip("/"),
        label=label or f"第 {lineno} 行",
        kind=kind,
        secret=secret,
        user_id=user_id.strip(),
    )


def parse_sites(raw: str) -> List[Account]:
    """把多行 SITES 解析成账号列表。

    空行与 `#` 开头的注释行会被忽略。
    """
    accounts: List[Account] = []

    for lineno, raw_line in enumerate(raw.splitlines(), 1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue

        # maxsplit：凭证是最后一段，所以凭证里带 | 也不会被切坏
        parts = line.split("|", SITES_FIELDS - 1)
        if len(parts) != SITES_FIELDS:
            raise ConfigError(
                f"SITES 第 {lineno} 行字段数不对（需要 {SITES_FIELDS} 段）：{SITES_FORMAT_HINT}"
            )

        accounts.append(
            _build_account(
                site=parts[0].strip(),
                label=parts[1].strip(),
                kind_field=parts[2].strip(),
                secret=parts[3].strip(),
                lineno=lineno,
            )
        )

    return accounts


def _detect_credential(text: str, where: str) -> Tuple[str, str]:
    """判断一个凭证是 cookie 还是访问令牌。

    规则按顺序：
      1. `token:` / `cookie:` 前缀 → 显式指定，优先级最高（**令牌推荐走这条**）
      2. 以 `sk-` 开头 → 令牌
      3. 含 `=` → cookie（cookie 天然是 `名字=值`）
      4. 都判断不出来 → 报错，让人加前缀，**不猜**

    ⚠️ 第 2、3 条只是**启发式**，对「系统访问令牌」并不可靠：新版令牌形如
    `aNSC...Y/8`，既不以 `sk-` 开头（→ 落到第 4 条报错），
    也可能因 base64 填充以 `=` 结尾（→ 被第 3 条**误判成 cookie**，请求头发错 → 401）。
    所以令牌一律显式写 `token:<值>`。
    """
    for prefix, kind in (("token:", AUTH_TOKEN), ("cookie:", AUTH_COOKIE)):
        if text.startswith(prefix):
            return kind, text[len(prefix):].strip()

    if text.startswith("sk-"):
        return AUTH_TOKEN, text
    if "=" in text:
        return AUTH_COOKIE, text

    raise ConfigError(
        f"{where}：判断不出这是 cookie 还是令牌（'{text[:24]}…'）。"
        "cookie 是 `名字=值` 的形式；令牌只在以 `sk-` 开头时才能自动识别 ——"
        "系统访问令牌常常不以 `sk-` 开头，请显式写成 `token:<值>`"
    )


def _account_from_json(
    site: str,
    entry: object,
    index: int,
    where: str,
    force_kind: str = "",
) -> Account:
    """JSON 形式里的单个账号。entry 允许是字符串，也允许是对象。

    `force_kind` 非空时（**分桶写法**）跳过自动判断，直接按它定类型 ——
    这正是分桶的意义：桶名已经声明了类型，桶内裸写就没有歧义，
    `token:` 前缀、`sk-` 启发式、base64 结尾 `=` 被误判成 cookie 这些问题统统用不上。
    """
    label = ""
    user_id = ""

    if isinstance(entry, str):
        if force_kind:
            # 分桶写法要求元素**一律是对象**：只有一种形态，
            # 不用再记「什么时候该包成对象」，user_id / label 也总有地方放。
            raise ConfigError(
                f"{where}：分桶里的元素必须写成对象，例如 "
                f'{{"{force_kind}":"<凭证>","user_id":"<用户ID>","label":"<标签>"}}'
                "（后两个可省略）"
            )
        kind, secret = _detect_credential(entry.strip(), where)
    elif isinstance(entry, dict):
        label = str(entry.get("label") or "")
        user_id = str(entry.get("user_id") or "")
        if entry.get("token"):
            kind, secret = AUTH_TOKEN, str(entry["token"]).strip()
        elif entry.get("cookie"):
            kind, secret = AUTH_COOKIE, str(entry["cookie"]).strip()
        else:
            raise ConfigError(
                f"{where}：对象里必须有 `token` 或 `cookie` 字段之一，当前是 {sorted(entry)}"
            )
        if force_kind and kind != force_kind:
            raise ConfigError(
                f"{where}：放在 `{force_kind}s` 桶里，对象里却写的是 `{kind}` —— 两边保持一致"
            )
    else:
        raise ConfigError(f"{where}：只能是字符串或对象，当前是 {type(entry).__name__}")

    if not secret:
        raise ConfigError(f"{where}：凭证为空")

    return Account(
        site=site, label=label or f"#{index}", kind=kind, secret=secret, user_id=user_id
    )


def parse_sites_json(raw: str) -> List[Account]:
    """解析 JSON 形式的 SITES —— 用 ref 传参时用这种。

    值的写法有两种，**推荐分桶**：

    ① 分桶（推荐）—— 桶名即类型，桶内元素**一律是对象**：

        {
          "https://站点A": {
            "cookies": [{"cookie": "session=xxx"}],
            "tokens":  [{"token": "aNSC...Y/8", "user_id": "38798", "label": "备用"}]
          },
          "https://站点B": {"tokens": [{"token": "sk-qqq"}]}
        }

    ② 扁平数组（早期写法，继续支持）—— 靠自动判断类型：

        {
          "https://站点A": ["cookie1", "sk-令牌1", "cookie3"],
          "https://站点C": ["session=yyy", {"token": "sk-zzz", "user_id": "1001"}]
        }

    两种写法共同的规则：
    - 键是站点地址，必须带 `http://` 或 `https://`
    - 站点只挂一个账号时，值可以写字符串：`{"https://a.com": "session=xx"}`

    分桶专属规则：
    - 桶名只认 `cookies`（一律当 cookie）和 `tokens`（一律当令牌）—— 桶内**不做自动判断**
    - 桶内元素**必须是对象**，不能裸写字符串；对象里的字段名要与桶名一致
      （`cookies` 里写 `cookie`、`tokens` 里写 `token`），`user_id` / `label` 可省略
    - 两个桶可任选，至少一个非空；`[]` 或省略都行
    - `oauth` 允许存在但**必须为空**（不确定它该发什么请求头，宁可不做也不静默 401）
    """
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ConfigError(
            f"SITES 看着像 JSON 但解析失败：{exc}。"
            "提示：在 .env 里写 JSON 时不要套外层双引号"
        ) from exc

    if not isinstance(data, dict):
        raise ConfigError(
            'SITES 的 JSON 形式必须是对象：{"站点地址": ["凭证1", "凭证2"], ...}'
        )

    accounts: List[Account] = []

    for site, entries in data.items():
        where = f"站点 '{site}'"
        if not re.match(r"^https?://", site.strip()):
            raise ConfigError(f"{where}：地址必须以 http:// 或 https:// 开头")

        if isinstance(entries, str):
            entries = [entries]  # 只挂一个账号时允许写成字符串

        # 分桶写法：{"cookies": [...], "tokens": [...]}
        if isinstance(entries, dict):
            accounts.extend(_accounts_from_buckets(site.strip().rstrip("/"), entries, where))
            continue

        if not isinstance(entries, list) or not entries:
            raise ConfigError(
                f"{where}：值必须是数组或分桶对象 —— "
                '数组 ["session=xxx", "sk-yyy"]，或分桶 {"cookies": [...], "tokens": [...]}'
            )

        for index, entry in enumerate(entries, 1):
            accounts.append(
                _account_from_json(
                    site.strip().rstrip("/"), entry, index, f"{where} 第 {index} 个账号"
                )
            )

    return accounts


# 分桶写法认的键：桶名（复数）→ 强制类型。dict 插入顺序就是遍历顺序
BUCKET_KINDS = {f"{AUTH_COOKIE}s": AUTH_COOKIE, f"{AUTH_TOKEN}s": AUTH_TOKEN}

# 认得出、但暂不支持的桶：允许存在，但必须为空
BUCKET_UNSUPPORTED = ("oauth",)


def _accounts_from_buckets(site: str, buckets: dict, where: str) -> List[Account]:
    """解析「按类型分桶」的写法：`{"cookies": [...], "tokens": [...]}`。

    桶内元素**一律是对象**：

        {"tokens": [{"token": "aN9...Y/8", "user_id": "38798", "label": "备用"}]}

    `user_id` / `label` 可省略。只有一种元素形态，不用再记「什么时候该包成对象」；
    桶名 + 对象字段名两处都声明了类型，所以也**不做任何猜测** ——
    不会出现「非 `sk-` 开头认不出」「base64 结尾的 `=` 被误判成 cookie」这类问题。
    """
    unknown = [
        key for key in buckets
        if key not in BUCKET_KINDS and key not in BUCKET_UNSUPPORTED
    ]
    if unknown:
        # 最常见的错法是把**账号级**字段（user_id / label）放到站点级 —— 顺手点明
        hint = ""
        if any(key in ("user_id", "label") for key in unknown):
            hint = (
                "。⚠️ `user_id` / `label` 是**单个账号**的字段，不能放在这一层，"
                '要写成桶内的对象元素：{"tokens":[{"token":"...","user_id":"38798"}]}'
            )
        raise ConfigError(
            f"{where}：不认识的分桶 {unknown}。只支持 `cookies` / `tokens`"
            '（只有一个账号就写成 {"cookies": [{"cookie": "session=xxx"}]}）'
            + hint
        )

    for key in BUCKET_UNSUPPORTED:
        if buckets.get(key):
            raise ConfigError(
                f"{where}：`{key}` 暂不支持 —— 不确定这类令牌该发什么请求头，"
                "宁可不做也不让你踩静默 401。"
                "用 OAuth 登录站点后拿到的仍是会话 cookie，请放进 `cookies`"
            )

    accounts: List[Account] = []
    seq = 0
    for key, kind in BUCKET_KINDS.items():
        entries = buckets.get(key)
        if entries is None:
            continue
        if not isinstance(entries, list):
            raise ConfigError(
                f"{where}：`{key}` 必须是数组，元素是对象，"
                f'例如 {{"{kind}":"<凭证>","user_id":"<用户ID>"}}'
                f"（当前是 {type(entries).__name__}）"
            )

        for nth, entry in enumerate(entries, 1):
            seq += 1
            accounts.append(
                _account_from_json(
                    site, entry, seq, f"{where} 的 `{key}` 第 {nth} 个", force_kind=kind
                )
            )

    if not accounts:
        raise ConfigError(
            f"{where}：分桶里一个账号都没有（`cookies` / `tokens` 至少一个非空）"
        )

    return accounts


@dataclass
class Config:
    """应用配置"""

    accounts: List[Account] = field(default_factory=list)
    push_key: str = ""
    timeout: int = DEFAULT_TIMEOUT
    verbose: bool = DEFAULT_VERBOSE

    @classmethod
    def load(cls) -> "Config":
        config = cls()

        # 直接读进程环境：ref / vars / secrets / .env 已在 workflow 的 env: 里合并好，
        # 走到这里全都躺在 os.environ 里了。
        raw_sites = (os.environ.get(ENV_SITES) or "").strip()
        if not raw_sites:
            logger.warning(
                f"{LogEmoji.WARNING} 配置项 '{ENV_SITES}' 为空"
                "（ref / vars / secrets / .env 都没给）。"
            )

        # 以 { 开头就当 JSON 形式（ref 传参推荐这种，见 README）；
        # 否则按「一行一个账号」解析（secret 里推荐的写法）。
        if raw_sites.lstrip().startswith("{"):
            config.accounts = parse_sites_json(raw_sites)
        else:
            config.accounts = parse_sites(raw_sites)

        # 凭证只是多行 SITES 的片段，不主动注册就会以明文出现在日志里
        register_masks([account.secret for account in config.accounts])

        config.push_key = (os.environ.get(ENV_PUSH_KEY) or "").strip()

        raw_timeout = (os.environ.get(ENV_TIMEOUT) or "").strip()
        if raw_timeout:
            if not raw_timeout.isdigit() or int(raw_timeout) <= 0:
                raise ConfigError(f"{ENV_TIMEOUT} 必须是正整数秒数，当前值：'{raw_timeout}'")
            config.timeout = int(raw_timeout)

        verbose_env = (os.environ.get(ENV_VERBOSE) or "").strip()
        if verbose_env:
            lowered = verbose_env.lower()
            if lowered in ("true", "1", "yes", "y"):
                config.verbose = True
            elif lowered in ("false", "0", "no", "n"):
                config.verbose = False
            else:
                logger.warning(
                    f"{LogEmoji.WARNING} 配置项 '{ENV_VERBOSE}' 的值 '{verbose_env}' 无效，"
                    f"将使用默认值 {DEFAULT_VERBOSE}。"
                )

        # 只打印站点与账号标签，绝不打印凭证
        logger.info(f"{LogEmoji.INFO} 共加载了 {len(config.accounts)} 个账号：")
        for idx, account in enumerate(config.accounts, 1):
            logger.info(
                f"{LogEmoji.INFO}   #{idx} {LogEmoji.SITE} {account.site} "
                f"{LogEmoji.ACCOUNT} {account.label}（{account.kind}）"
            )
        logger.info(f"{LogEmoji.INFO} 当前 {ENV_PUSH_KEY} {'已设置' if config.push_key else '未设置'}。")
        logger.info(f"{LogEmoji.INFO} 当前 {ENV_VERBOSE}: {config.verbose}。")

        return config


# ─────────────────────────── 请求层 ───────────────────────────
class RequestError(Exception):
    """请求失败。消息里**只带状态码与截断后的响应片段**，不带凭证。"""


class AuthError(Exception):
    """凭证不被接受。

    消息只保留**短结论**（形如 `HTTP 401`），用于汇总和推送；
    详细的排查方向放在 `hint` 里，只进日志 —— 免得推送到手机上是一大段。
    """

    def __init__(self, summary: str, hint: str = ""):
        super().__init__(summary)
        self.hint = hint


class SiteClient:
    """一个账号的 HTTP 会话。请求头按认证方式拼装。"""

    def __init__(self, account: Account, timeout: int, verbose: bool):
        self.account = account
        self.timeout = timeout
        self.verbose = verbose
        self.session = requests.Session()
        self.session.headers.update(self._build_headers())

    def __enter__(self) -> "SiteClient":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        self.session.close()
        return False

    def _build_headers(self) -> Dict[str, str]:
        headers = {
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }

        if self.account.kind == AUTH_COOKIE:
            headers["Cookie"] = self.account.secret
        else:
            headers["Authorization"] = f"Bearer {self.account.secret}"

        # 部分接口要求带用户标识；没配就不带（多数站点 cookie 模式下也不需要）
        if self.account.user_id:
            headers["New-Api-User"] = self.account.user_id

        return headers

    def _log(self, emoji: str, message: str, force: bool = False) -> None:
        logger.info(f"{LogEmoji.SITE}[{self.account.site}] {emoji} {message}")

    def request(self, method: str, path: str) -> dict:
        """发一个请求并返回解析后的 JSON。失败一律抛异常，由上层归类。"""
        url = f"{self.account.site}{path}"

        try:
            response = self.session.request(method, url, timeout=self.timeout)
        except requests.exceptions.RequestException as exc:
            raise RequestError(f"网络错误：{exc}") from exc

        body = (response.text or "").strip()

        if response.status_code in (401, 403):
            raise AuthError(
                f"HTTP {response.status_code}",
                self._auth_hint(response.status_code),
            )

        if not response.ok:
            raise RequestError(f"HTTP {response.status_code}：{body[:200] or '（空响应）'}")

        try:
            parsed = response.json()
        except ValueError as exc:
            # 典型情况：Cloudflare 人机校验、WAF 拦截、反向代理返回 HTML
            raise RequestError(
                f"响应不是 JSON（可能是 Cloudflare 人机校验 / WAF / 反代页面）：{body[:200]}"
            ) from exc

        if not isinstance(parsed, dict):
            raise RequestError(f"响应 JSON 不是对象：{str(parsed)[:200]}")

        if self.verbose:
            self._log(LogEmoji.STATUS, f"{path} → {body[:200]}")

        return parsed

    def _auth_hint(self, status_code: int) -> str:
        suffix = (
            "。也可能是令牌被禁用/删除了，去站点个人设置里确认一下"
            if status_code in (401, 403)
            else ""
        )
        if self.account.kind == AUTH_TOKEN:
            return (
                "① 令牌是否复制完整；"
                "② 站点要求用户标识头时，把类型段写成 `token=<用户ID>` 再试；"
                "③ 该站是不是老 one-api / 部分 fork —— 那类站的 `sk-` 只是模型调用 key，"
                "不能用于管理接口，得改用 cookie 认证"
                + suffix
            )
        return "会话 Cookie 可能已过期，重新登录后按 README 的「方式二」再复制一份" + suffix

    def get_self(self) -> dict:
        body = self.request("GET", SELF_PATH)
        return _unwrap(body)

    def checkin(self) -> Tuple[bool, str, object]:
        """执行签到，返回 (是否成功, 服务端消息, 原始 data)"""
        body = self.request("POST", CHECKIN_PATH)
        success = bool(body.get("success"))
        message = str(body.get("message") or "")
        return success, message, body.get("data")


def _unwrap(body: dict) -> dict:
    """取出响应里的用户对象。

    new-api / one-api 都是 `{"success":true,"data":{...}}`，
    但个别 fork 会把用户对象直接放在顶层，所以这里两种都认。
    """
    data = body.get("data")
    if isinstance(data, dict):
        return data
    return body


def _quota_of(user: dict) -> Optional[float]:
    """取额度。字段名各 fork 基本一致，是 `quota`。"""
    for key in ("quota", "remain_quota", "balance"):
        value = user.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


# ─────────────────────────── 签到 ───────────────────────────
class Status:
    SUCCESS = "ok"
    REPEAT = "repeat"
    FAILURE = "fail"


@dataclass
class CheckinResult:
    site: str
    label: str
    kind: str
    status: str = Status.FAILURE
    username: str = ""
    quota_before: Optional[float] = None
    quota_after: Optional[float] = None
    message: str = ""

    @property
    def earned(self) -> Optional[float]:
        if self.quota_before is None or self.quota_after is None:
            return None
        return self.quota_after - self.quota_before


def check_account(account: Account, timeout: int, verbose: bool) -> CheckinResult:
    """跑完一个账号的「查额度 → 签到 → 再查额度」"""
    result = CheckinResult(site=account.site, label=account.label, kind=account.kind)

    try:
        with SiteClient(account, timeout, verbose) as client:
            # 1. 校验凭证 + 记下签到前的额度
            user = client.get_self()
            result.username = str(user.get("username") or user.get("display_name") or "")

            # 顺手把用户 ID 打出来：令牌认证要带 `New-Api-User` 头时填的就是它，
            # 而站点页面上并不总显示这个数字 —— 用 cookie 跑一次就能看到。
            user_id = user.get("id")
            if user_id is not None:
                logger.info(
                    f"{LogEmoji.INFO} {account.display} 用户 ID：{user_id}"
                    "（令牌认证若报 401，把它填进配置里的 user_id）"
                )
            result.quota_before = _quota_of(user)
            logger.info(
                f"{LogEmoji.STATUS} {account.display} 凭证有效"
                + (f"，账号 {result.username}" if result.username else "")
                + (
                    f"，当前额度 {_fmt_quota(result.quota_before)}"
                    if result.quota_before is not None
                    else ""
                )
            )

            # 2. 签到
            success, message, _data = client.checkin()

            if success:
                result.status = Status.SUCCESS
                result.message = message or "签到成功"
                logger.info(f"{LogEmoji.CHECKIN} {account.display} 签到成功：{result.message}")
            elif _is_repeat(message):
                result.status = Status.REPEAT
                result.message = message or "今日已签到"
                logger.info(f"{LogEmoji.REPEAT} {account.display} 今日已签到，跳过")
            else:
                result.status = Status.FAILURE
                result.message = message or "服务端返回 success=false"
                logger.warning(
                    f"{LogEmoji.WARNING} {account.display} 签到未成功：{result.message}"
                )
                return result

            # 3. 只有真的签到成功才值得再读一次额度
            if result.status == Status.SUCCESS:
                result.quota_after = _quota_of(client.get_self())

    except AuthError as exc:
        result.status = Status.FAILURE
        result.message = f"认证失败：{exc}"  # 短结论，进汇总与推送
        logger.error(f"{LogEmoji.ERROR} {account.display} 认证失败：{exc}")
        if exc.hint:
            logger.error(f"{LogEmoji.INFO}   排查方向：{exc.hint}")
    except RequestError as exc:
        result.status = Status.FAILURE
        result.message = str(exc)
        logger.error(f"{LogEmoji.ERROR} {account.display} 请求失败：{exc}")

    return result


def _is_repeat(message: str) -> bool:
    lowered = message.lower()
    return any(keyword in lowered for keyword in REPEAT_KEYWORDS)


def _fmt_quota(value: Optional[float]) -> str:
    if value is None:
        return "?"
    return f"{int(value):,}"


# ─────────────────────────── 汇总与推送 ───────────────────────────
def format_results(results: List[CheckinResult]) -> Tuple[str, str, str]:
    """返回 (推送标题, 推送正文, 日志正文)"""
    success = sum(1 for item in results if item.status == Status.SUCCESS)
    repeat = sum(1 for item in results if item.status == Status.REPEAT)
    failure = sum(1 for item in results if item.status == Status.FAILURE)

    title = f"API 签到, 成功{success}, 重复{repeat}, 失败{failure}"

    send_lines: List[str] = []
    log_lines: List[str] = []

    for idx, item in enumerate(results, 1):
        earned = item.earned
        parts = [f"#{idx} [{item.label}] {item.kind}"]

        if earned is not None:
            parts.append(f"+{_fmt_quota(earned)}")
        if item.quota_after is not None:
            parts.append(f"余额 {_fmt_quota(item.quota_after)}")
        parts.append(item.status)
        if item.status != Status.SUCCESS:
            parts.append(item.message[:60])

        send_lines.append(f"{item.site} " + " | ".join(parts))
        log_lines.append(f"#{idx} [{item.site}] [{item.label}] {item.status}")

    return title, "\n".join(send_lines), "\n".join(log_lines)


class PushService:
    """PushDeer 推送。没配密钥就静默跳过。"""

    def __init__(self, push_key: str):
        self.push_key = push_key

    def send(self, title: str, content: str) -> bool:
        if not self.push_key:
            logger.info(f"{LogEmoji.WARNING} 未设置推送密钥，跳过推送通知。")
            return False

        try:
            from pypushdeer import PushDeer

            PushDeer(pushkey=self.push_key).send_text(title, desp=content)
            logger.info(f"{LogEmoji.SUCCESS} 推送通知发送成功。")
            return True
        except Exception as exc:  # noqa: BLE001 - 推送失败不该影响主流程
            logger.error(f"{LogEmoji.ERROR} 发送推送通知失败: {exc}")
            return False


# ─────────────────────────── 主流程 ───────────────────────────
def main() -> int:
    logger.info("════════ api_checkin 启动 ════════")

    # .env 是最低优先级的一层：只填补 ref / vars / secrets 都没提供的键。
    # 必须排在 Config.load() 之前 —— 它读的就是 os.environ。
    load_dotenv(os.path.join(_HERE, ".env"), logger=logger)

    try:
        config = Config.load()
    except ConfigError as exc:
        # 配置错必须变红，不能像「没抢到容量」那样当作正常结果
        logger.error(f"{LogEmoji.ERROR} 配置有误：{exc}")
        return 1

    if not config.accounts:
        logger.error(f"{LogEmoji.ERROR} 未找到任何可用的账号，退出程序。")
        return 1

    logger.info("")
    results: List[CheckinResult] = []
    for account in config.accounts:
        logger.info(f"{LogEmoji.START} ── 处理 {account.display} ──")
        results.append(check_account(account, config.timeout, config.verbose))

    title, content, log_content = format_results(results)
    logger.info("")
    logger.info(f"\n{LogEmoji.END}========== 签到总结 ==========\n{title}\n{log_content}")

    PushService(config.push_key).send(title, content)
    logger.info(f"{LogEmoji.END} 签到完成")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001 - 兜底：任何未预期异常都必须让 job 变红
        traceback.print_exc()
        print("::error::执行过程中出现未预期的错误，详见上方堆栈", file=sys.stderr, flush=True)
        sys.exit(1)
