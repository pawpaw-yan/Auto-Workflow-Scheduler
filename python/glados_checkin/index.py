import requests
import json
import os
import re
import sys
import logging
from enum import Enum
from typing import Dict, List, Optional, Tuple, Union
from dataclasses import dataclass, asdict
from pypushdeer import PushDeer

# python/common/ 是 Python 的语言级共享包。本文件位于 python/<项目>/，
# 要把上层目录（python/）加入 sys.path 才能 `from common.xxx import ...`。
# 项目目录放在最前，允许项目用同名模块覆盖共享实现。
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))  # python/
sys.path.insert(0, _HERE)                   # 项目自身

from common.dotenv import load_dotenv  # noqa: E402
from common.logging_config import init_logger  # noqa: E402


class CheckinStatus(Enum):
    """签到状态"""

    SUCCESS = 0
    REPEAT = 1
    FAILURE = -2


class ExchangePlan(Enum):
    """兑换计划"""

    PLAN100 = "plan100"
    PLAN200 = "plan200"
    PLAN500 = "plan500"


class APIEndpoint(Enum):
    """API端点"""

    CHECKIN = "/api/user/checkin"
    STATUS = "/api/user/status"
    POINTS = "/api/user/points"
    EXCHANGE = "/api/user/exchange"


class LogEmoji:
    """日志 Emoji 常量"""

    SUCCESS = "✅"
    FAIL = "❌"
    REPEAT = "🔄"
    PENDING = "⏳"
    CHECKIN = "🎫"
    STATUS = "📊"
    POINTS = "💰"
    EXCHANGE = "🎁"
    START = "🚀"
    END = "🏁"
    COOKIE = "🍪"
    DOMAIN = "🌐"
    WARNING = "⚠️ "
    ERROR = "🔴"
    INFO = "ℹ️ "


def log_method(func):
    """日志装饰器"""

    def wrapper(self, *args, **kwargs):
        method_name = func.__name__
        emoji_map = {
            "checkin": LogEmoji.CHECKIN,
            "get_status": LogEmoji.STATUS,
            "get_points": LogEmoji.POINTS,
            "exchange": LogEmoji.EXCHANGE,
        }
        emoji = emoji_map.get(method_name, LogEmoji.INFO)
        try:
            result = func(self, *args, **kwargs)
            return result
        except Exception as e:
            logger.error(f"{LogEmoji.COOKIE}[{self.cookie_index}] {LogEmoji.DOMAIN}[{self.domain}] {LogEmoji.ERROR} {method_name} 执行失败: {e}")

            DEFAULT_ERRORS = {
                "checkin": {"status": "签到失败", "points": "0", "message": ""},
                "get_status": ("None 天", -2),
                "get_points": ("None 积分", 0),
                "exchange": "",
            }

            if method_name in DEFAULT_ERRORS:
                error_template = DEFAULT_ERRORS[method_name]
                if isinstance(error_template, dict):
                    error_result = error_template.copy()
                    error_result["message"] = f"执行失败: {e}"
                    return error_result
                return error_template
            raise

    return wrapper


def register_masks(values: List[str]) -> None:
    """在 GitHub Actions 里把敏感值注册进日志遮蔽列表。

    GitHub 的脱敏只按「完整机密值」做字面匹配，而每个 cookie 只是多行机密
    COOKIES 里的一行，属于片段 —— 不主动注册的话，日志里出现就是明文。
    本地运行（无 GITHUB_ACTIONS）直接跳过，避免往 stdout 打噪音。
    """
    if not os.environ.get("GITHUB_ACTIONS"):
        return

    for value in values:
        value = (value or "").strip()
        # 太短的值 GitHub 会拒绝遮蔽，注册了也没用
        if len(value) >= 4:
            print(f"::add-mask::{value}", flush=True)


class Config:
    """应用配置"""

    ENV_PUSH_KEY = "PUSHDEER_SENDKEY"
    ENV_COOKIES = "COOKIES"
    ENV_DOMAINS = "DOMAINS"
    ENV_EXCHANGE_PLAN = "GLADOS_EXCHANGE_PLAN"
    ENV_VERBOSE = "GLADOS_VERBOSE"

    """不兑换：GLADOS_EXCHANGE_PLAN 留空即表示明确不兑换"""
    NO_EXCHANGE = ""

    """默认是否输出详细响应"""
    DEFAULT_VERBOSE = False

    """兑换计划列表（值 = 需要多少积分，仅用于日志展示）"""
    EXCHANGE_PLANS = {
        ExchangePlan.PLAN100.value: 100,
        ExchangePlan.PLAN200.value: 200,
        ExchangePlan.PLAN500.value: 500,
    }

    def __init__(self):
        self.push_key: str = ""
        # [(域名, cookie), ...]：两个配置项按行一一对应
        self.accounts: List[Tuple[str, str]] = []
        self.exchange_plan: str = self.NO_EXCHANGE
        self.verbose: bool = self.DEFAULT_VERBOSE
        self._load_config()

    def _load_config(self) -> None:
        """加载配置"""
        push_key_env: Optional[str] = os.environ.get(self.ENV_PUSH_KEY)
        raw_domains_env: Optional[str] = os.environ.get(self.ENV_DOMAINS)
        raw_cookies_env: Optional[str] = os.environ.get(self.ENV_COOKIES)
        exchange_plan_env: Optional[str] = os.environ.get(self.ENV_EXCHANGE_PLAN)
        verbose_env: Optional[str] = os.environ.get(self.ENV_VERBOSE)

        if not push_key_env:
            logger.warning(f"{LogEmoji.WARNING} 环境变量 '{self.ENV_PUSH_KEY}' 未设置。")
            self.push_key = ""
        else:
            self.push_key = push_key_env

        # ── 域名与 Cookie：按行一一对应 ──
        # 域名用「空白 / 逗号」切分（域名里不可能出现这些字符）；
        # Cookie 严格按行切分 —— 换行是唯一保证不会出现在 cookie 里的字符
        # （HTTP header 值不允许 CR/LF）。用 splitlines() 而不是 split("\n")，
        # 这样多行 secret 里混进 CRLF 时不会残留 \r 把 cookie 弄坏。
        domains = [item for item in re.split(r"[\s,]+", (raw_domains_env or "").strip()) if item]
        cookies = [item.strip() for item in (raw_cookies_env or "").splitlines() if item.strip()]

        if not domains:
            logger.warning(f"{LogEmoji.WARNING} 环境变量 '{self.ENV_DOMAINS}' 未设置。")
        if raw_cookies_env and not cookies:
            raise ValueError(f"环境变量 '{self.ENV_COOKIES}' 已设置，但未包含任何有效的 Cookie。")
        if len(domains) != len(cookies):
            raise ValueError(
                f"域名与 Cookie 数量不一致：'{self.ENV_DOMAINS}' 有 {len(domains)} 行、"
                f"'{self.ENV_COOKIES}' 有 {len(cookies)} 行，两者必须按行一一对应"
                "（同一个域名有多个账号时，重复写域名即可）。"
            )

        self.accounts = list(zip(domains, cookies))
        # cookie 只是多行机密 COOKIES 的片段，不主动注册就会以明文出现在日志里
        register_masks([cookie for _domain, cookie in self.accounts])

        if not exchange_plan_env or not exchange_plan_env.strip():
            logger.warning(
                f"{LogEmoji.WARNING} 环境变量 '{self.ENV_EXCHANGE_PLAN}' 未设置，"
                "本次不执行兑换（留空即明确表示不兑换）。"
            )
            self.exchange_plan = self.NO_EXCHANGE
        elif exchange_plan_env in self.EXCHANGE_PLANS:
            self.exchange_plan = exchange_plan_env
            logger.info(f"{LogEmoji.SUCCESS} 使用指定的兑换计划: {self.exchange_plan}")
        else:
            logger.warning(
                f"{LogEmoji.WARNING} 环境变量 '{self.ENV_EXCHANGE_PLAN}' 的值 '{exchange_plan_env}' 无效"
                f"（可选：{' / '.join(self.EXCHANGE_PLANS)}），本次不执行兑换。"
            )
            self.exchange_plan = self.NO_EXCHANGE

        logger.info(f"{LogEmoji.INFO} 共加载了 {len(self.accounts)} 组 域名 / Cookie 用于签到。")
        for idx, (domain, _cookie) in enumerate(self.accounts, 1):
            logger.info(f"{LogEmoji.INFO}   #{idx} {LogEmoji.DOMAIN} {domain}")
        logger.info(f"{LogEmoji.INFO} 当前 {self.ENV_PUSH_KEY} {'已设置' if push_key_env else '未设置'}。")
        logger.info(f"{LogEmoji.INFO} 当前 {self.ENV_EXCHANGE_PLAN}: {self.exchange_plan or '（不兑换）'}。")

        if verbose_env is not None:
            verbose_env_lower = verbose_env.lower()
            if verbose_env_lower in ["true", "1", "yes", "y"]:
                self.verbose = True
            elif verbose_env_lower in ["false", "0", "no", "n"]:
                self.verbose = False
            else:
                logger.warning(f"{LogEmoji.WARNING} 环境变量 '{self.ENV_VERBOSE}' 的值 '{verbose_env}' 无效，将使用默认值 {self.DEFAULT_VERBOSE}。")

        logger.info(f"{LogEmoji.INFO} 当前 {self.ENV_VERBOSE}: {self.verbose}。")


class API:
    """API 调用"""

    CHECKIN_URL = APIEndpoint.CHECKIN.value
    STATUS_URL = APIEndpoint.STATUS.value
    POINTS_URL = APIEndpoint.POINTS.value
    EXCHANGE_URL = APIEndpoint.EXCHANGE.value

    def __init__(self, domain: str, cookie_index: int = 0, verbose: bool = False):
        self.domain: str = domain
        self.cookie_index: int = cookie_index
        self.verbose: bool = verbose
        self.headers: Dict[str, str] = self._get_headers()
        self.session = requests.Session()
        self.session.headers.update(self.headers)

    def __del__(self):
        """关闭 session"""
        self.close()

    def close(self) -> None:
        """关闭 session"""
        if hasattr(self, "session"):
            try:
                self.session.close()
            except Exception as e:
                logger.error(f"{LogEmoji.ERROR} 关闭 session 时发生错误: {e}")

    def __enter__(self):
        """进入上下文管理器"""
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        """退出上下文管理器"""
        self.close()
        return False

    def _get_headers(self) -> Dict[str, str]:
        """获取请求头"""
        return {
            "origin": f"https://{self.domain}",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36",
        }

    def _log(self, level: str, emoji: str, message: str, force: bool = False) -> None:
        """统一日志输出方法"""

        log_message = f"{LogEmoji.COOKIE}[{self.cookie_index}] {LogEmoji.DOMAIN}[{self.domain}] {emoji} {message}"

        if force or self.verbose:
            if level == "info":
                logger.info(log_message)
            elif level == "warning":
                logger.warning(log_message)
            elif level == "error":
                logger.error(log_message)

    def _get_full_url(self, path: str) -> str:
        """获取完整 URL"""
        return f"https://{self.domain}{path}"

    def _make_request(self, url: str, method: str, data: Optional[Dict] = None, cookies: str = "") -> Optional[requests.Response]:
        """发送 HTTP 请求"""
        session_headers = self.headers.copy()
        session_headers["cookie"] = cookies

        try:
            if method.upper() == "POST":
                response = self.session.post(url, headers=session_headers, data=data, timeout=(60, 120))
            elif method.upper() == "GET":
                response = self.session.get(url, headers=session_headers, timeout=(60, 120))
            else:
                self._log("error", LogEmoji.ERROR, f"不支持的 HTTP 方法: {method}", force=True)
                return None

            if not response.ok:
                self._log("warning", LogEmoji.WARNING, f"向 {url} 发起的请求失败，状态码 {response.status_code}。响应内容: {response.text}", force=True)
                return None
            return response
        except requests.exceptions.RequestException as e:
            self._log("error", LogEmoji.ERROR, f"向 {url} 发起请求时发生网络错误: {e}", force=True)
            return None

    def _get_checkin_data(self) -> Dict[str, str]:
        """获取签到数据"""
        return {"token": self.domain}

    @log_method
    def checkin(self, cookies: str) -> Dict[str, Union[str, CheckinStatus]]:
        """执行签到"""
        url = self._get_full_url(self.CHECKIN_URL)
        checkin_data = self._get_checkin_data()
        response = self._make_request(url, "POST", checkin_data, cookies)

        result = {
            "status": "签到失败",
            "points": "0",
            "message": "",
            "code": CheckinStatus.FAILURE,
        }

        if response:
            data = response.json()
            code = data.get("code", -2)
            message = data.get("message", "无消息字段")
            points = str(data.get("points", 0))

            if code == CheckinStatus.SUCCESS.value:
                self._log("info", LogEmoji.SUCCESS, f"{{ code : {code}, points : {points}, message : {message} }}")
                result["code"] = CheckinStatus.SUCCESS
                result["status"] = "签到成功"
                result["points"] = points
                result["message"] = message
            elif code == CheckinStatus.REPEAT.value:
                self._log("info", LogEmoji.REPEAT, f"{{ code : {code}, message : {message} }}", force=True)
                result["code"] = CheckinStatus.REPEAT
                result["status"] = "重复签到"
                result["points"] = "0"
                result["message"] = message
            else:
                self._log("info", LogEmoji.FAIL, f"{{ code : {code}, message : {message} }}", force=True)
                result["code"] = CheckinStatus.FAILURE
                result["status"] = "签到失败"
                result["points"] = "0"
                result["message"] = message
        else:
            self._log("warning", LogEmoji.WARNING, "签到失败", force=True)
            result["code"] = CheckinStatus.FAILURE
            result["status"] = "签到失败"
            result["message"] = "网络请求失败"

        return result

    @log_method
    def get_status(self, cookies: str) -> Tuple[str, int]:
        """获取状态"""

        url = self._get_full_url(self.STATUS_URL)
        response = self._make_request(url, "GET", cookies=cookies)

        if response:
            data = response.json()
            code = data.get("code", -2)
            left_days = data.get("data", {}).get("leftDays", None)

            if left_days is not None:
                left_days_int = int(float(left_days))
                self._log("info", LogEmoji.SUCCESS, f"{{ code : {code}, leftDays : {left_days_int} 天}}")
                return f"{left_days_int} 天", code
            else:
                self._log("info", LogEmoji.FAIL, f"{{ code : {code}, leftDays : {left_days} 天}}", force=True)
                return "None 天", code
        else:
            self._log("warning", LogEmoji.WARNING, "获取状态失败", force=True)
            return "None 天", -2

    @log_method
    def get_points(self, cookies: str) -> Tuple[str, int]:
        """获取积分"""
        url = self._get_full_url(self.POINTS_URL)
        response = self._make_request(url, "GET", cookies=cookies)

        if response:
            data = response.json()
            code = data.get("code", -2)
            points = data.get("points", None)

            if points is not None:
                points_int = int(float(points))
                self._log("info", LogEmoji.SUCCESS, f"{{ code : {code}, points : {points_int} 积分}}")
                points_str = f"{points_int} 积分"
                points_num = points_int
                return points_str, points_num
            else:
                self._log("info", LogEmoji.FAIL, f"{{ code : {code}, points : {points} 积分}}", force=True)
                return "None 积分", 0
        else:
            self._log("warning", LogEmoji.WARNING, "获取积分失败", force=True)
            return "None 积分", 0

    @log_method
    def exchange(self, cookies: str, plan: str, required_points: int) -> str:
        """执行兑换"""
        url = self._get_full_url(self.EXCHANGE_URL)
        response = self._make_request(url, "POST", {"planType": plan}, cookies)

        if response:
            data = response.json()
            code = data.get("code", -2)
            message = data.get("message", "未知错误")

            if code == 0:
                self._log("info", LogEmoji.SUCCESS, f"{{ code : {code}, message : {message} }}")
                return f"兑换成功: {plan}"
            else:
                self._log("info", LogEmoji.FAIL, f"{{ code : {code}, message : {message} }}", force=True)
                return f"兑换失败: {message}"
        else:
            self._log("warning", LogEmoji.WARNING, "兑换失败", force=True)
            return "兑换失败"


@dataclass()
class CheckinResult:
    """签到结果"""

    cookie_index: int
    domain: str
    status: str = "签到失败"
    points: str = "0"
    days: str = "None"
    points_total: str = "None"
    exchange: str = "未兑换"
    code: CheckinStatus = CheckinStatus.FAILURE  # 0: 成功, 1: 重复, -2: 失败

    def to_dict(self) -> Dict[str, Union[str, CheckinStatus]]:
        result_dict = asdict(self)
        return result_dict


class PushService:
    """推送服务"""

    def __init__(self, config: Config):
        self.config = config

    def send(self, title: str, content: str) -> bool:
        """发送推送"""
        if not self.config.push_key:
            logger.info(f"{LogEmoji.WARNING} 未设置推送密钥，跳过推送通知。")
            return False

        try:
            pushdeer = PushDeer(pushkey=self.config.push_key)
            pushdeer.send_text(title, desp=content)
            logger.info(f"{LogEmoji.SUCCESS} 推送通知发送成功。")
            return True
        except Exception as e:
            logger.error(f"{LogEmoji.ERROR} 发送推送通知失败: {e}")
            return False


class Checker:
    """签到"""

    def __init__(self, config: Config):
        self.config = config
        self.results = []

    def _log(self, cookie_idx: int, domain: str, emoji: str, message: str, force: bool = False) -> None:
        """统一日志输出方法"""

        if self.config.verbose or force:
            logger.info(f"{LogEmoji.COOKIE}[{cookie_idx}] {LogEmoji.DOMAIN}[{domain}] {emoji} {message}")

    def checkin_all(self):
        """执行所有签到任务"""
        accounts = self.config.accounts
        total = len(accounts)

        logger.info(f"{LogEmoji.INFO} 共 {total} 组 域名 / Cookie")

        for cookie_idx, (domain, cookie) in enumerate(accounts, 1):
            logger.info(f"{LogEmoji.START} ========== 开始处理第 {cookie_idx} 组 ==========")
            logger.info(f"{LogEmoji.INFO} ----- 任务 {cookie_idx}/{total}: {LogEmoji.COOKIE}[{cookie_idx}] on {LogEmoji.DOMAIN}[{domain}] -----")

            result = self._checkin_on_domain(cookie, cookie_idx, domain)
            self.results.append(result)

            result_message = f"结果: {result.status}"
            if result.code == CheckinStatus.SUCCESS:
                if self.config.verbose:
                    result_message = f"结果: {result.status}, 获得 {result.points} 积分, 剩余 {result.days}, 总 {result.points_total}, {result.exchange}"
                self._log(cookie_idx, domain, LogEmoji.SUCCESS, result_message, force=True)
            else:
                self._log(cookie_idx, domain, LogEmoji.WARNING, result_message, force=True)

    def _checkin_on_domain(self, cookie: str, cookie_idx: int, domain: str) -> CheckinResult:
        result = CheckinResult(cookie_idx, domain)

        with API(domain, cookie_idx, verbose=self.config.verbose) as api:
            # 1. 获取状态
            self._log(cookie_idx, domain, LogEmoji.STATUS, "查询剩余天数")
            days_str, status_code = api.get_status(cookie)
            result.days = days_str

            # 2. 签到
            self._log(cookie_idx, domain, LogEmoji.CHECKIN, "执行签到")
            checkin_result = api.checkin(cookie)
            result.status = checkin_result["status"]
            result.code = checkin_result.get("code", CheckinStatus.FAILURE)

            # 3. 获取积分
            self._log(cookie_idx, domain, LogEmoji.POINTS, "查询总积分")
            points_str, points_num = api.get_points(cookie)
            result.points_total = points_str

            # 4. 执行兑换：只有配了兑换计划才做（留空 = 明确不兑换）
            if not self.config.exchange_plan:
                self._log(cookie_idx, domain, LogEmoji.EXCHANGE, "未配置兑换计划，跳过兑换")
                result.exchange = "未兑换"
            else:
                required_points = self.config.EXCHANGE_PLANS.get(self.config.exchange_plan, 0)
                self._log(
                    cookie_idx,
                    domain,
                    LogEmoji.EXCHANGE,
                    f"开始兑换 {self.config.exchange_plan} (需要 {required_points} 积分)",
                )
                result.exchange = api.exchange(cookie, self.config.exchange_plan, required_points)

        return result

    def get_results(self) -> List[Dict[str, str]]:
        """获取所有结果"""
        return [result.to_dict() for result in self.results]

    def format_results(self) -> Tuple[str, str, str]:
        """格式化结果"""
        results = self.get_results()

        success_count = sum(1 for r in results if r["code"] == CheckinStatus.SUCCESS)
        repeat_count = sum(1 for r in results if r["code"] == CheckinStatus.REPEAT)
        fail_count = sum(1 for r in results if r["code"] == CheckinStatus.FAILURE)

        title = f"GLaDOS 签到, 成功{success_count}, 失败{fail_count}, 重复{repeat_count}"

        send_content_lines = []
        log_content_lines = []
        for i, res in enumerate(results, 1):
            # 结果可能跨多个域名，行首带上域名才分得清
            line = f"#{i} [{res['domain']}] P:{res['points']} 剩余:{res['days']} 总积分:{res['points_total']} | {res['status']} | {res['exchange']}"
            send_content_lines.append(line)

            if self.config.verbose:
                log_line = line
            else:
                log_line = f"#{i} [{res['domain']}] {res['status']}"
            log_content_lines.append(log_line)

        content = "\n".join(send_content_lines)
        log_content = "\n".join(log_content_lines)
        return title, content, log_content


# 初始化日志
logger = init_logger("glados_checkin")


def main():
    """主函数"""
    config: Optional[Config] = None

    try:
        # 1. 加载配置
        logger.info(f"{LogEmoji.START} 步骤 1: 加载配置")
        # .env 是最低优先级的一层：只填补 ref / vars / secrets 都没提供的键。
        # 必须排在 Config() 之前 —— 它读的就是 os.environ。
        load_dotenv(os.path.join(_HERE, ".env"), logger=logger)
        config = Config()

        if not config.accounts:
            logger.error(f"{LogEmoji.ERROR} 未找到有效的 Cookie, 退出程序。")
            title, content = "# 未找到 cookies!", ""
        else:
            # 2. 执行签到
            logger.info(f"{LogEmoji.START} 步骤 2: 执行签到")
            checker = Checker(config)
            checker.checkin_all()

            # 3. 格式化结果
            logger.info(f"{LogEmoji.START} 步骤 3: 格式化结果")
            title, content, log_content = checker.format_results()
            logger.info(f"\n{LogEmoji.END}========== 签到总结 ==========\n{title}\n{log_content}")

    except Exception as e:
        logger.error(f"{LogEmoji.ERROR} 主程序执行过程中发生未预期的错误: {e}")
        title, content, log_content = "# 脚本执行出错", str(e), str(e)

    # 4. 发送推送
    #    Config() 本身失败时（比如域名与 Cookie 行数不一致）没有可用的 config，
    #    直接构造 PushService 会抛 AttributeError，把真正的报错盖掉。
    logger.info(f"{LogEmoji.START} 步骤 4: 发送推送")
    if isinstance(config, Config):
        PushService(config).send(title, content)
    else:
        logger.error(f"{LogEmoji.ERROR} 配置未成功加载，跳过推送（原因见上方日志）。")
    logger.info(f"{LogEmoji.END} 签到完成")


if __name__ == "__main__":
    main()