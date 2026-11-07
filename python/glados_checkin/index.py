import hashlib
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from enum import Enum
from typing import Dict, List, Optional, Tuple, Union

import requests
from pypushdeer import PushDeer

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))
sys.path.insert(0, _HERE)

from common.dotenv import load_dotenv  # noqa: E402
from common.logging_config import init_logger  # noqa: E402

logger = init_logger("glados_checkin")

DEFAULT_CHECKIN_TOKEN = "glados.cloud"
CHALLENGE_SALT = "glados-observe-v1"
CHALLENGE_DOMAIN = "glados.cloud"


class CheckinStatus(Enum):
    SUCCESS = 0
    REPEAT = 1
    FAILURE = -2


class ExchangePlan(Enum):
    PLAN100 = "plan100"
    PLAN200 = "plan200"
    PLAN500 = "plan500"


class APIEndpoint(Enum):
    CHALLENGE = "/api/user/checkin/challenge"
    CHECKIN = "/api/user/checkin"
    STATUS = "/api/user/status"
    POINTS = "/api/user/points"
    EXCHANGE = "/api/user/exchange"


class LogEmoji:
    SUCCESS = "✅"
    FAIL = "❌"
    REPEAT = "🔄"
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


def register_masks(values: List[str]) -> None:
    """将各 Cookie 注册到 GitHub Actions 的日志遮蔽列表。"""
    if not os.environ.get("GITHUB_ACTIONS"):
        return
    for value in values:
        value = (value or "").strip()
        if len(value) >= 4:
            print(f"::add-mask::{value}", flush=True)


def detect_debug_mode() -> Tuple[bool, str]:
    for name in ("DEBUG_MODE", "COMMON_DEBUG_MODE"):
        raw = os.environ.get(name)
        if raw:
            return raw.lower() in ("true", "1", "yes", "on"), name
    return False, ""


class Config:
    ENV_PUSH_KEY = "PUSHDEER_SENDKEY"
    ENV_COOKIES = "COOKIES"
    ENV_DOMAINS = "DOMAINS"
    ENV_EXCHANGE_PLAN = "GLADOS_EXCHANGE_PLAN"
    ENV_VERBOSE = "GLADOS_VERBOSE"
    ENV_CHECKIN_TOKEN = "GLADOS_CHECKIN_TOKEN"
    ENV_CHALLENGE_SALT = "GLADOS_CHALLENGE_SALT"
    NO_EXCHANGE = ""
    NO_EXCHANGE_ALIASES = ("none", "off", "no", "false")
    DEFAULT_VERBOSE = False
    EXCHANGE_PLANS = {
        ExchangePlan.PLAN100.value: 100,
        ExchangePlan.PLAN200.value: 200,
        ExchangePlan.PLAN500.value: 500,
    }

    def __init__(self):
        self.push_key = ""
        self.checkin_token = DEFAULT_CHECKIN_TOKEN
        self.challenge_salt = CHALLENGE_SALT
        self.accounts: List[Tuple[str, str]] = []
        self.exchange_plan = self.NO_EXCHANGE
        self.verbose = self.DEFAULT_VERBOSE
        self._load_config()

    def _load_config(self) -> None:
        push_key = os.environ.get(self.ENV_PUSH_KEY)
        raw_domains = os.environ.get(self.ENV_DOMAINS)
        raw_cookies = os.environ.get(self.ENV_COOKIES)
        plan_env = os.environ.get(self.ENV_EXCHANGE_PLAN)
        verbose_env = os.environ.get(self.ENV_VERBOSE)
        self.checkin_token = (os.environ.get(self.ENV_CHECKIN_TOKEN) or DEFAULT_CHECKIN_TOKEN).strip() or DEFAULT_CHECKIN_TOKEN
        self.challenge_salt = (os.environ.get(self.ENV_CHALLENGE_SALT) or CHALLENGE_SALT).strip() or CHALLENGE_SALT
        self.push_key = push_key or ""
        if not push_key:
            logger.warning(f"{LogEmoji.WARNING} 环境变量 '{self.ENV_PUSH_KEY}' 未设置。")

        domains = [x for x in re.split(r"[\s,]+", (raw_domains or "").strip()) if x]
        cookies = [x.strip() for x in (raw_cookies or "").splitlines() if x.strip()]
        if not domains:
            logger.warning(f"{LogEmoji.WARNING} 环境变量 '{self.ENV_DOMAINS}' 未设置。")
        if raw_cookies and not cookies:
            raise ValueError(f"环境变量 '{self.ENV_COOKIES}' 已设置，但未包含任何有效的 Cookie。")
        if len(domains) != len(cookies):
            raise ValueError(
                f"域名与 Cookie 数量不一致：'{self.ENV_DOMAINS}' 有 {len(domains)} 行、"
                f"'{self.ENV_COOKIES}' 有 {len(cookies)} 行，两者必须按行一一对应"
                "（同一个域名有多个账号时，重复写域名即可）。"
            )
        self.accounts = list(zip(domains, cookies))
        register_masks([cookie for _, cookie in self.accounts])

        plan = (plan_env or "").strip().lower()
        if plan in self.NO_EXCHANGE_ALIASES or not plan:
            self.exchange_plan = self.NO_EXCHANGE
            logger.info(f"{LogEmoji.INFO} 本次不执行兑换。")
        elif plan in self.EXCHANGE_PLANS:
            self.exchange_plan = plan
            logger.info(f"{LogEmoji.SUCCESS} 使用指定的兑换计划: {plan}")
        else:
            self.exchange_plan = self.NO_EXCHANGE
            logger.warning(f"{LogEmoji.WARNING} 环境变量 '{self.ENV_EXCHANGE_PLAN}' 的值无效，本次不执行兑换。")

        logger.info(f"{LogEmoji.INFO} 共加载了 {len(self.accounts)} 组 域名 / Cookie 用于签到。")
        for idx, (domain, _) in enumerate(self.accounts, 1):
            logger.info(f"{LogEmoji.INFO}   #{idx} {LogEmoji.DOMAIN} {domain}")
        logger.info(f"{LogEmoji.INFO} 当前 {self.ENV_EXCHANGE_PLAN}: {self.exchange_plan or '（不兑换）'}。")
        if verbose_env is not None:
            value = verbose_env.lower()
            if value in ("true", "1", "yes", "y"):
                self.verbose = True
            elif value in ("false", "0", "no", "n"):
                self.verbose = False
            else:
                logger.warning(f"{LogEmoji.WARNING} 环境变量 '{self.ENV_VERBOSE}' 的值无效，将使用默认值 {self.DEFAULT_VERBOSE}。")
        logger.info(f"{LogEmoji.INFO} 当前 {self.ENV_VERBOSE}: {self.verbose}。")


class API:
    CHECKIN_URL = APIEndpoint.CHECKIN.value
    CHALLENGE_URL = APIEndpoint.CHALLENGE.value
    STATUS_URL = APIEndpoint.STATUS.value
    POINTS_URL = APIEndpoint.POINTS.value
    EXCHANGE_URL = APIEndpoint.EXCHANGE.value

    def __init__(self, domain: str, cookie_index: int = 0, verbose: bool = False):
        self.domain = domain
        self.cookie_index = cookie_index
        self.verbose = verbose
        self.headers = {
            "origin": f"https://{domain}",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/102.0.0.0 Safari/537.36",
        }
        self.session = requests.Session()
        self.session.headers.update(self.headers)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.close()
        return False

    def __del__(self):
        self.close()

    def close(self) -> None:
        if hasattr(self, "session"):
            try:
                self.session.close()
            except Exception as e:
                logger.error(f"{LogEmoji.ERROR} 关闭 session 时发生错误: {e}")

    def _log(self, level: str, emoji: str, message: str, force: bool = False) -> None:
        if not (force or self.verbose):
            return
        text = f"{LogEmoji.COOKIE}[{self.cookie_index}] {LogEmoji.DOMAIN}[{self.domain}] {emoji} {message}"
        getattr(logger, level if level in ("info", "warning", "error") else "info")(text)

    def _get_full_url(self, path: str) -> str:
        return f"https://{self.domain}{path}"

    def _make_request(
        self, url: str, method: str, data: Optional[Dict] = None,
        cookies: str = "", json_body: bool = False,
    ) -> Optional[requests.Response]:
        headers = self.headers.copy()
        headers["cookie"] = cookies
        try:
            if method.upper() == "POST":
                if json_body:
                    headers["Content-Type"] = "application/json;charset=UTF-8"
                    headers["Accept"] = "application/json, text/plain, */*"
                    response = self.session.post(url, headers=headers, json=data, timeout=(60, 120))
                else:
                    response = self.session.post(url, headers=headers, data=data, timeout=(60, 120))
            elif method.upper() == "GET":
                response = self.session.get(url, headers=headers, timeout=(60, 120))
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

    def _parse_checkin_response(self, response: Optional[requests.Response]) -> Dict[str, Union[str, CheckinStatus]]:
        result: Dict[str, Union[str, CheckinStatus]] = {
            "status": "签到失败", "points": "0", "message": "", "code": CheckinStatus.FAILURE,
        }
        if response is None:
            self._log("warning", LogEmoji.WARNING, "签到失败", force=True)
            result["message"] = "网络请求失败"
            return result
        data = response.json()
        code = data.get("code", -2)
        message = data.get("message", "无消息字段")
        points = str(data.get("points", 0))
        result["message"] = message
        if code == CheckinStatus.SUCCESS.value:
            self._log("info", LogEmoji.SUCCESS, f"{{ code : {code}, points : {points}, message : {message} }}")
            result.update(code=CheckinStatus.SUCCESS, status="签到成功", points=points)
        elif code == CheckinStatus.REPEAT.value:
            self._log("info", LogEmoji.REPEAT, f"{{ code : {code}, message : {message} }}", force=True)
            result.update(code=CheckinStatus.REPEAT, status="重复签到", points="0")
        else:
            self._log("info", LogEmoji.FAIL, f"{{ code : {code}, message : {message} }}", force=True)
            result.update(code=CheckinStatus.FAILURE, status="签到失败", points="0")
        return result

    def checkin(
        self, cookies: str, token: str = DEFAULT_CHECKIN_TOKEN,
        challenge_salt: str = CHALLENGE_SALT,
    ) -> Dict[str, Union[str, CheckinStatus]]:
        """仅 glados.cloud 使用 challenge；其他域名沿用旧的表单签到请求。"""
        is_challenge_domain = self.domain.strip().lower().rstrip(".") == CHALLENGE_DOMAIN
        if not is_challenge_domain:
            # 保留旧接口行为：以当前域名作为 token，application/x-www-form-urlencoded。
            return self._parse_checkin_response(
                self._make_request(self._get_full_url(self.CHECKIN_URL), "POST", {"token": self.domain}, cookies)
            )

        challenge = self._make_request(self._get_full_url(self.CHALLENGE_URL), "GET", cookies=cookies)
        if challenge is None:
            self._log("warning", LogEmoji.WARNING, "获取签到 challenge 失败，跳过签到。", force=True)
            return {"status": "签到失败", "points": "0", "message": "获取 nonce 失败", "code": CheckinStatus.FAILURE}
        try:
            challenge_data = challenge.json()
            nonce = challenge_data.get("nonce") or (challenge_data.get("data") or {}).get("nonce")
        except (ValueError, AttributeError):
            nonce = None
            challenge_data = {}
        if not nonce:
            message = challenge_data.get("message", "未获取到 nonce")
            self._log("warning", LogEmoji.WARNING, f"挑战接口未返回 nonce: {message}", force=True)
            return {"status": "签到失败", "points": "0", "message": str(message), "code": CheckinStatus.FAILURE}

        time.sleep(2.6)
        proof = hashlib.sha256(f"{nonce}.{challenge_salt}".encode("utf-8")).hexdigest()
        payload = {"token": token, "nonce": nonce, "proof": proof}
        response = self._make_request(
            self._get_full_url(self.CHECKIN_URL), "POST", payload, cookies, json_body=True,
        )
        return self._parse_checkin_response(response)

    def get_status(self, cookies: str) -> Tuple[str, int]:
        response = self._make_request(self._get_full_url(self.STATUS_URL), "GET", cookies=cookies)
        if response:
            data = response.json()
            code = data.get("code", -2)
            left_days = (data.get("data") or {}).get("leftDays")
            if left_days is not None:
                days = int(float(left_days))
                self._log("info", LogEmoji.SUCCESS, f"{{ code : {code}, leftDays : {days} 天}}")
                return f"{days} 天", code
            self._log("info", LogEmoji.FAIL, f"{{ code : {code}, leftDays : None 天}}", force=True)
            return "None 天", code
        self._log("warning", LogEmoji.WARNING, "获取状态失败", force=True)
        return "None 天", -2

    def get_points(self, cookies: str) -> Tuple[str, int]:
        response = self._make_request(self._get_full_url(self.POINTS_URL), "GET", cookies=cookies)
        if response:
            data = response.json()
            points = data.get("points")
            if points is not None:
                value = int(float(points))
                self._log("info", LogEmoji.SUCCESS, f"{{ code : {data.get('code', -2)}, points : {value} 积分}}")
                return f"{value} 积分", value
            self._log("info", LogEmoji.FAIL, "积分字段为空", force=True)
        else:
            self._log("warning", LogEmoji.WARNING, "获取积分失败", force=True)
        return "None 积分", 0

    def exchange(self, cookies: str, plan: str, required_points: int) -> str:
        # 保持旧版兑换请求的表单编码方式。
        response = self._make_request(self._get_full_url(self.EXCHANGE_URL), "POST", {"planType": plan}, cookies)
        if response:
            data = response.json()
            if data.get("code", -2) == 0:
                self._log("info", LogEmoji.SUCCESS, f"{{ code : 0, message : {data.get('message', '')} }}")
                return f"兑换成功: {plan}"
            message = data.get("message", "未知错误")
            self._log("info", LogEmoji.FAIL, f"{{ code : {data.get('code', -2)}, message : {message} }}", force=True)
            return f"兑换失败: {message}"
        self._log("warning", LogEmoji.WARNING, "兑换失败", force=True)
        return "兑换失败"


@dataclass
class CheckinResult:
    cookie_index: int
    domain: str
    status: str = "签到失败"
    points: str = "0"
    days: str = "None"
    points_total: str = "None"
    exchange: str = "未兑换"
    code: CheckinStatus = CheckinStatus.FAILURE
    message: str = ""

    def to_dict(self):
        return asdict(self)


class PushService:
    def __init__(self, config: Config):
        self.config = config

    def send(self, title: str, content: str) -> bool:
        if not self.config.push_key:
            logger.info(f"{LogEmoji.WARNING} 未设置推送密钥，跳过推送通知。")
            return False
        try:
            PushDeer(pushkey=self.config.push_key).send_text(title, desp=content)
            logger.info(f"{LogEmoji.SUCCESS} 推送通知发送成功。")
            return True
        except Exception as e:
            logger.error(f"{LogEmoji.ERROR} 发送推送通知失败: {e}")
            return False


class TelegramNotifier:
    ENV_BOT_TOKEN = "TELEGRAM_BOT_TOKEN"
    ENV_CHAT_ID = "TELEGRAM_CHAT_ID"

    def __init__(self):
        self.bot_token = (os.environ.get(self.ENV_BOT_TOKEN) or "").strip()
        self.chat_id = (os.environ.get(self.ENV_CHAT_ID) or "").strip()

    def _scrub(self, text: str) -> str:
        return text.replace(self.bot_token, "***") if self.bot_token else text

    def send(self, title: str, content: str) -> bool:
        if not (self.bot_token and self.chat_id):
            logger.warning(f"{LogEmoji.WARNING} 未设置 {self.ENV_BOT_TOKEN} / {self.ENV_CHAT_ID}，跳过 Telegram 失败提醒。")
            return False
        url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        try:
            response = requests.post(url, json={
                "chat_id": self.chat_id,
                "text": f"{title}\n\n{content}" if content else title,
                "disable_web_page_preview": True,
            }, timeout=(60, 120))
        except requests.exceptions.RequestException as e:
            logger.error(f"{LogEmoji.ERROR} 发送 Telegram 失败提醒时发生网络错误: {self._scrub(str(e))}")
            return False
        if not response.ok:
            logger.error(f"{LogEmoji.ERROR} Telegram 发送失败，状态码 {response.status_code}: {self._scrub(response.text)}")
            return False
        try:
            data = response.json()
        except ValueError:
            data = {}
        if not data.get("ok", False):
            logger.error(f"{LogEmoji.ERROR} Telegram 发送失败: {self._scrub(str(data.get('description') or response.text))}")
            return False
        logger.info(f"{LogEmoji.SUCCESS} Telegram 失败提醒发送成功。")
        return True


class Checker:
    def __init__(self, config: Config):
        self.config = config
        self.results: List[CheckinResult] = []

    def checkin_all(self) -> None:
        logger.info(f"{LogEmoji.INFO} 共 {len(self.config.accounts)} 组 域名 / Cookie")
        for idx, (domain, cookie) in enumerate(self.config.accounts, 1):
            logger.info(f"{LogEmoji.START} ========== 开始处理第 {idx} 组 ==========")
            with API(domain, idx, self.config.verbose) as api:
                result = CheckinResult(idx, domain)
                result.days = api.get_status(cookie)[0]
                checkin = api.checkin(cookie, self.config.checkin_token, self.config.challenge_salt)
                result.status = str(checkin["status"])
                result.code = checkin.get("code", CheckinStatus.FAILURE)
                result.message = str(checkin.get("message", ""))
                result.points_total = api.get_points(cookie)[0]
                if self.config.exchange_plan:
                    required = self.config.EXCHANGE_PLANS.get(self.config.exchange_plan, 0)
                    result.exchange = api.exchange(cookie, self.config.exchange_plan, required)
            self.results.append(result)
            logger.info(f"{LogEmoji.COOKIE}[{idx}] {LogEmoji.DOMAIN}[{domain}] 结果: {result.status}")

    def get_results(self):
        return [r.to_dict() for r in self.results]

    def has_failure(self) -> bool:
        return any(r.code == CheckinStatus.FAILURE for r in self.results)

    def format_failure_alert(self) -> Tuple[str, str]:
        failed = [r for r in self.results if r.code == CheckinStatus.FAILURE]
        success = sum(r.code == CheckinStatus.SUCCESS for r in self.results)
        repeat = sum(r.code == CheckinStatus.REPEAT for r in self.results)
        lines = [f"成功 {success} / 失败 {len(failed)} / 重复 {repeat}", "", "失败明细："]
        for r in failed:
            line = f"#{r.cookie_index} [{r.domain}] {r.status}"
            if r.message:
                line += f"：{r.message}"
            lines.append(line)
        return f"{LogEmoji.FAIL} GLaDOS 签到失败（失败 {len(failed)} / 共 {len(self.results)}）", "\n".join(lines)

    def format_results(self) -> Tuple[str, str, str]:
        success = sum(r.code == CheckinStatus.SUCCESS for r in self.results)
        repeat = sum(r.code == CheckinStatus.REPEAT for r in self.results)
        fail = sum(r.code == CheckinStatus.FAILURE for r in self.results)
        title = f"GLaDOS 签到, 成功{success}, 失败{fail}, 重复{repeat}"
        send_lines, log_lines = [], []
        for i, r in enumerate(self.results, 1):
            line = f"#{i} [{r.domain}] P:{r.points} 剩余:{r.days} 总积分:{r.points_total} | {r.status} | {r.exchange}"
            send_lines.append(line)
            log_lines.append(line if self.config.verbose else f"#{i} [{r.domain}] {r.status}")
        return title, "\n".join(send_lines), "\n".join(log_lines)


def main():
    config = None
    failed = False
    alert_title = f"{LogEmoji.FAIL} GLaDOS 签到失败"
    alert_content = ""
    try:
        logger.info(f"{LogEmoji.START} 步骤 1: 加载配置")
        load_dotenv(os.path.join(_HERE, ".env"), logger=logger)
        config = Config()
        if not config.accounts:
            title, content = "# 未找到 cookies!", ""
            failed = True
            alert_title = f"{LogEmoji.FAIL} GLaDOS 签到未找到有效的 Cookie"
            alert_content = "DOMAINS / COOKIES 为空或行数不匹配，本次没有执行任何签到，请检查配置。"
        else:
            logger.info(f"{LogEmoji.START} 步骤 2: 执行签到")
            checker = Checker(config)
            checker.checkin_all()
            title, content, log_content = checker.format_results()
            logger.info(f"\n{LogEmoji.END}========== 签到总结 ==========\n{title}\n{log_content}")
            failed = checker.has_failure()
            if failed:
                alert_title, alert_content = checker.format_failure_alert()
    except Exception as e:
        logger.error(f"{LogEmoji.ERROR} 主程序执行过程中发生未预期的错误: {e}")
        failed = True
        title, content = "# 脚本执行出错", str(e)
        alert_title = f"{LogEmoji.FAIL} GLaDOS 签到脚本执行出错"
        alert_content = str(e)

    logger.info(f"{LogEmoji.START} 步骤 4: 发送推送")
    if isinstance(config, Config):
        PushService(config).send(title, content)
    else:
        logger.error(f"{LogEmoji.ERROR} 配置未成功加载，跳过推送（原因见上方日志）。")

    logger.info(f"{LogEmoji.START} 步骤 5: Telegram 提醒")
    debug_enabled, debug_source = detect_debug_mode()
    if debug_enabled:
        logger.info(f"{LogEmoji.INFO} {debug_source} 已开启：无论成败都会发送 Telegram 提醒。")
    if failed:
        TelegramNotifier().send(alert_title, alert_content)
    elif debug_enabled:
        TelegramNotifier().send(f"{LogEmoji.SUCCESS} GLaDOS 签到完成（{debug_source} 已开启，无论成败都会发送）", content)
    else:
        logger.info(f"{LogEmoji.SUCCESS} 本次没有签到失败，跳过 Telegram 提醒。")
    logger.info(f"{LogEmoji.END} 签到完成")


if __name__ == "__main__":
    main()
