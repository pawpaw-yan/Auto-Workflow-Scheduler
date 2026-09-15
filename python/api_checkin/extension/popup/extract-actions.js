/* extract-actions.js —— 「提取账号」面板的按钮动作：测试令牌 / 测试 Cookie / 写入 SITES */

"use strict";

async function runTokenTest() {
  const site = normSite();
  const token = byId("tokenField").value.trim();
  const userId = (extractState && extractState.userId) || byId("userIdInput").value.trim();
  if (!token) { setStatus("testResult", "访问令牌是空的", true); return; }
  if (!userId) { setStatus("testResult", "用户 ID 是空的（new-api 需要 New-Api-User 头）", true); return; }
  setStatus("testResult", "正在验证令牌（严格模式，不带浏览器 cookie）…");
  const result = await tryVerify(token, userId, site);
  if (result.ok) {
    setStatus("testResult", "✅ 令牌有效");
  } else {
    setStatus("testResult", "❌ 令牌没过（无效或被 WAF 拦截）：" + result.detail.message, true);
  }
}

async function runCookieTestDispatch() {
  // 独立签到系统没有 /api/user/self（SPA 兜底页会被误判成 WAF）—— /api/info 才是状态口
  if (extractState && extractState.siteType === "checkin-system") {
    const site = normSite();
    try {
      const info = await callApi(site + "/api/info", { credentials: "include" });
      if (info && info.logged_in) {
        setStatus("testResult", info.can_checkin
          ? "✅ Cookie 能过：已登录，且今日可签到"
          : "✅ Cookie 能过（已登录 " + (info.username || "") + "）；站点规则：" + (info.message || "今日不可签到"));
      } else {
        setStatus("testResult", "❌ Cookie 没过：未登录（会话约 24 小时过期，重新登录后再提取）", true);
      }
    } catch (e) {
      setStatus("testResult", "❌ Cookie 没过：" + e.message, true);
    }
    return;
  }
  const site = normSite();
  let userId = (extractState && extractState.userId) || byId("userIdInput").value.trim();
  if (!userId) {
    const cached = await readSiteLocalStorage(site);
    if (cached && cached.id) userId = cached.id;
  }
  setStatus("testResult", "正在用扩展的 cookie 权限带全部 cookie 请求 /api/user/self …");
  try {
    const me = userFromSelf(await callApi(site + "/api/user/self", { userId: userId || undefined }));
    if (me) {
      setStatus("testResult", "✅ Cookie 能过：会话有效（用户 " + (me.username || me.id) + "），WAF 也没拦");
    } else {
      setStatus("testResult", "❌ Cookie 没过：success=false（可能没登录）", true);
    }
  } catch (e) {
    let msg = "❌ Cookie 没过：" + e.message;
    if (/AUTH_UNAUTHORIZED|access token/i.test(e.message)) {
      msg += "\n该站是 new-api v1.x：接口只认 Bearer 令牌、不认 cookie —— 请改用令牌方式";
    }
    setStatus("testResult", msg, true);
  }
}

/** 提取结果 → 一行账号（行格式）；parseLines 会原样走一遍校验。
    cookie 也带 =用户ID：不少 new-api 站在 cookie 会话下同样强制要 New-Api-User 头。 */
function buildLineFromState(state) {
  const label = (state.me && (state.me.username || state.me.display_name)) || "账号";
  if (state.accessToken) {
    return state.site + "|" + label + "|token=" + state.userId + "|" + state.accessToken;
  }
  const kind = state.userId ? "cookie=" + state.userId : "cookie";
  return state.site + "|" + label + "|" + kind + "|" + state.cookie;
}

/** 把提取结果写进 SITES 存储（替换 / 追加），切到 SITES 标签即可复制或跨标签页填写 */
async function toSites() {
  if (!extractState) return;
  if (!extractState.accessToken && !extractState.cookie) {
    setStatus("testResult", "没有可用的凭证（令牌和 cookie 都是空的）", true);
    return;
  }
  const parsed = parseLines(buildLineFromState(extractState));
  if (parsed.errors.length) {
    setStatus("testResult", parsed.errors.join("；"), true);
    return;
  }
  const res = await appendAccounts(parsed.accounts);
  setStatus("testResult", "✅ 已追加进 SITES（本次 " + res.added + " 条" + (res.dup ? "，跳过重复 " + res.dup + " 条" : "") + "，共 " + res.total + " 条）—— 切到「SITES JSON」查看或生成");
}

byId("testTokenBtn").addEventListener("click", runTokenTest);
byId("testCookieBtn").addEventListener("click", runCookieTestDispatch);
byId("toSitesBtn").addEventListener("click", toSites);
