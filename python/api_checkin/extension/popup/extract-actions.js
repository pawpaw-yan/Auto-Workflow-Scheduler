/* extract-actions.js —— 「提取签到信息」面板的按钮动作：
   登录 / 测试令牌 / 测试 Cookie / 扫描签到入口 / 测试签到入口 / 写入 SITES */

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

async function runCookieTest() {
  // v1.x 站（名字带 refresh 的 cookie 是标志，各 fork 命名不一）：接口不认 cookie，
  // cookie 测试的真实含义是「刷新令牌能不能换出新的访问令牌」—— 直接走一次自举来验证
  if ((extractState && extractState.v1x) || /(^|;\s*)[^=]*refresh=[^;]/.test(byId("cookieField").value)) {
    const site = normSite();
    setStatus("testResult", "正在用刷新令牌自举（在站点标签页内发请求）…");
    const boot = await bootstrapV1Auth(site);
    if (boot && boot.ok) {
      setStatus("testResult", "✅ 刷新令牌有效：已换出新的访问令牌（用户 " + (boot.user.username || boot.user.id) + "）");
    } else {
      setStatus("testResult", "❌ 刷新令牌没过：" + ((boot && boot.reason) || "未知原因"), true);
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

/** 扫描签到入口：逐个 POST 候选路径，把第一个「存在」的填进输入框。
    quiet=true 是读取流程里的自动扫描，只在真探到时才动界面。 */
async function scanCheckin(quiet) {
  const site = normSite();
  const cred = currentCredential();
  if (!cred.value) {
    if (!quiet) {
      setStatus("testResult", "先拿到令牌或 Cookie 再扫描 —— 没有凭证时 401 和 404 分不清", true);
    }
    return null;
  }
  if (!quiet) setStatus("testResult", "正在扫描签到入口…");
  const found = await probeCheckinPath(site, cred);
  if (!found) {
    if (!quiet) {
      setStatus("testResult", "❌ 没探到签到入口（候选路径全是 404）—— 该站可能不提供签到接口，也可手填一个路径", true);
    }
    return null;
  }
  byId("checkinPath").value = found.path;
  if (extractState) extractState.checkinPath = found.path;
  if (!quiet) {
    setStatus(
      "testResult",
      found.certain
        ? "✅ 签到入口：" + found.path
        : "⚠️ 疑似入口 " + found.path + "（撞到 WAF 挑战页，没确认 —— 可点「🎫 测试签到入口」再试）",
      !found.certain
    );
  }
  return found;
}

/** 真打一次签到接口：成功 / 今日已签到 / 失败原因，全是站点自己给的话 */
async function testCheckin() {
  const site = normSite();
  const path = byId("checkinPath").value.trim();
  if (!path) { setStatus("testResult", "签到入口是空的 —— 先点「扫描」或手填", true); return; }
  const cred = currentCredential();
  if (!cred.value) { setStatus("testResult", "没有可用凭证（令牌和 Cookie 都是空的）", true); return; }
  setStatus("testResult", "正在请求 POST " + path + " …");
  try {
    const r = await tryCheckin(site, path, cred);
    if (r.success) {
      setStatus("testResult", "✅ 签到成功：" + (r.message || "（站点没给消息）"));
    } else if (/已签|重复|already/i.test(r.message)) {
      setStatus("testResult", "🔄 今日已签到：" + r.message);
    } else {
      setStatus("testResult", "❌ 签到没过：" + (r.message || "success=false"), true);
    }
  } catch (e) {
    setStatus("testResult", "❌ 签到请求失败：" + e.message, true);
  }
}

/** 账号 + 密码登录（POST /api/user/login）→ 拿会话 cookie 或令牌，填回下面的框 */
async function runLogin() {
  const site = normSite();
  const username = byId("loginUser").value.trim();
  const password = byId("loginPass").value;
  if (!username || !password) { setStatus("testResult", "账号和密码都要填", true); return; }
  setStatus("testResult", "正在登录…");
  try {
    const r = await loginWithPassword(site, username, password);
    if (!r.ok) { setStatus("testResult", "❌ 登录失败：" + r.reason, true); return; }
    if (extractState) {
      if (r.cookie) extractState.cookie = r.cookie;
      if (r.token) extractState.accessToken = r.token;
      if (r.userId) extractState.userId = r.userId;
    }
    if (r.cookie) byId("cookieField").value = r.cookie;
    if (r.token) byId("tokenField").value = r.token;
    if (r.userId) byId("idField").value = r.userId;
    byId("authMode").value = r.token ? "token" : "cookie";
    byId("passwordRow").hidden = true;
    setStatus("testResult", "✅ 登录成功（" + (r.token ? "拿到令牌" : "拿到会话 cookie") + "）—— 接着点「扫描」探签到入口");
  } catch (e) {
    setStatus("testResult", "❌ 登录请求失败：" + e.message, true);
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

/** 把提取结果写进 SITES 存储（追加），切到 SITES 标签即可复制或跨标签页填写。
    行格式只有 4 段装不下签到入口 —— 探测到的路径单独挂到账号对象上，
    生成 JSON 时会写成 checkin_path（index.py 拿到就不再逐个回退探测）。 */
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
  const path = byId("checkinPath").value.trim();
  if (path) parsed.accounts.forEach((acc) => { acc.checkinPath = path; });
  const res = await appendAccounts(parsed.accounts);
  setStatus("testResult", "✅ 已追加进 SITES（本次 " + res.added + " 条" + (res.dup ? "，跳过重复 " + res.dup + " 条" : "") + "，共 " + res.total + " 条）"
    + (path ? "，签到入口 " + path : "") + " —— 切到「SITES JSON」查看或生成");
}

byId("testTokenBtn").addEventListener("click", runTokenTest);
byId("testCookieBtn").addEventListener("click", runCookieTest);
byId("scanCheckinBtn").addEventListener("click", () => scanCheckin(false));
byId("testCheckinBtn").addEventListener("click", testCheckin);
byId("loginBtn").addEventListener("click", runLogin);
byId("toSitesBtn").addEventListener("click", toSites);
