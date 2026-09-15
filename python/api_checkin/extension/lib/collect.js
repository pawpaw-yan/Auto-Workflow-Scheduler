/* collect.js —— 提取一个站点的全部要素：cookie（含 httpOnly）→ 用户 ID → 会话 → 访问令牌。
   用户 ID 三级自举：站点 localStorage（v0.x 系）→ new-api v1.x 的 auth/refresh
   （浏览器自动带 httpOnly 刷新 cookie，与站点前端同一逻辑）→ 手填兜底。
   每一步的失败都记进 errors，绝不因为一步失败丢掉已拿到的值。 */

"use strict";

/** 错误文本像不像「凭证不被接受」—— v1.x 站用 cookie 调管理接口必然是这类报文 */
function isAuthFailure(text) {
  return /HTTP 401|HTTP 403|AUTH_UNAUTHORIZED|access token|unauthorized|未登录|请先登录|无效/i.test(text || "");
}

async function collectSite(site, manualUserId) {
  const result = {
    site: site, userId: "", me: null, siteType: "",
    cookie: "", cookieNames: [], cookieCount: 0, sessionValid: false,
    accessToken: "", accessTokenSource: "", accessTokenNote: "",
    testDetail: null, testLoose: false, errors: [], v1x: false,
  };

  // 1. Cookie：chrome.cookies 直接读（含 httpOnly）
  const jar = await readCookies(site);
  if (!jar.ok) result.errors.push("读 cookie 失败：" + jar.error);
  result.cookie = cookieHeader(jar.cookies);
  result.cookieNames = jar.cookies.map((c) => c.name);
  result.cookieCount = result.cookieNames.length;

  // 2. 用户 ID：手填 → 站点 localStorage（注入）→ new-api v1.x 自举
  let userId = String(manualUserId || "").trim();
  // 名字里带 refresh 的 cookie 是 v1.x 的标志（各 fork 命名不一，不写死 new_api_refresh）——
  // 它在就必须走自举（v1.x 接口不认 cookie，哪怕 ID 是手填的，标准会话检查也必然 401）
  const hasV1Refresh = result.cookieNames.some((n) => /refresh/i.test(n));
  let bundle = null;
  let triedBoot = false;
  if (!userId) {
    const cached = await readSiteLocalStorage(site);
    if (cached && cached.id) userId = cached.id;
  }
  if (hasV1Refresh || !userId) {
    triedBoot = true;
    const boot = await bootstrapV1Auth(site);
    if (boot && boot.ok) {
      bundle = { user: boot.user, access_token: boot.access_token || "" };
      if (boot.user && boot.user.id) userId = String(boot.user.id);
      result.v1x = true;
      result.siteType = "v1x";
    } else if (boot && boot.reason) {
      result.errors.push("v1.x 自举失败：" + boot.reason);
    }
  }
  if (!userId) {
    result.errors.push(
      "读不到用户 ID。检查：① 浏览器已登录该站点；" +
      "② new-api v1.x 站把用户信息只放在内存里，自动读不到 —— 在下面手填用户 ID" +
      "（站点「个人设置」页可查），或生成系统访问令牌后改用令牌方式"
    );
    return result;
  }
  result.userId = userId;

  // 3. 会话：v1.x 自举结果自带用户对象；否则带 cookie 调 /api/user/self（顺带过 WAF）
  if (bundle) {
    result.me = bundle.user;
    result.sessionValid = true;
    result.v1x = true;   // new-api v1.x：接口只认 Bearer 令牌，cookie 方式不适用
  } else {
    try {
      const me = userFromSelf(await callApi(site + "/api/user/self", { userId: userId }));
      if (me) {
        result.me = me;
        result.sessionValid = true;
        if (me.id) result.userId = String(me.id);   // 以服务端为准
      } else {
        result.errors.push("读 /api/user/self：success=false（没登录？）");
      }
    } catch (e) {
      result.errors.push("读 /api/user/self 失败：" + e.message);
    }
    // 会话没过、且还没试过自举 —— 刷新 cookie 名字里不带 refresh 的 v1.x 站会走到这里，
    // 表现就是「打开面板直接 401」。补一次自举，换出 Bearer 令牌再往下走。
    if (!result.me && !triedBoot && isAuthFailure(result.errors.join(" "))) {
      triedBoot = true;
      const boot = await bootstrapV1Auth(site);
      if (boot && boot.ok) {
        bundle = { user: boot.user, access_token: boot.access_token || "" };
        if (boot.user && boot.user.id) result.userId = String(boot.user.id);
        result.me = bundle.user;
        result.sessionValid = true;
        result.v1x = true;
        result.siteType = "v1x";
        result.errors.push("该站是 new-api v1.x：已改用自举换出的令牌，请按 token 方式配置");
      } else if (boot && boot.reason && !/HTTP 404/.test(boot.reason)) {
        // 自举端点 404 = 这就是个 v0.x 站，不用把这条噪音报告给用户
        result.errors.push("v1.x 自举也没过：" + boot.reason);
      }
    }
  }
  if (!result.me) return result;

  // 4. 访问令牌：临时令牌只是钥匙 —— 先用它换长效系统访问令牌（GET /api/user/token），
  //    换不到再走原有兜底链（/api/user/self 字段 → 候选验证 → GET /api/user/token），
  //    最后才是临时轮换令牌兜底（标注短期）。
  const temp = (bundle && bundle.access_token) || "";
  let resolved = null;
  if (temp) {
    const long = await fetchLongLivedToken(site, temp, result.userId);
    if (long.token) {
      resolved = { token: long.token, source: long.source, result: long.result };
    } else if (long.note) {
      result.errors.push(long.note);
    }
  }
  if (!resolved) {
    const r = await resolveAccessToken(site, result.me, result.userId);
    if (r.token) {
      resolved = r;
    } else if (r.note) {
      // 「为什么没读到访问令牌」—— 兜底链给的原因别丢，面板要显示
      result.accessTokenNote = r.note;
      result.errors.push(r.note);
    }
  }
  if (!resolved && temp) {
    const v = await tryVerify(temp, result.userId, site);
    if (v.ok) {
      resolved = {
        token: temp,
        source: "v1.x auth/refresh 的轮换令牌（短期有效，仅兜底 —— 建议生成系统访问令牌）",
        result: v,
      };
    }
  }
  resolved = resolved || { token: "", source: "", note: "" };
  result.accessToken = resolved.token;
  result.accessTokenSource = resolved.source;
  result.accessTokenNote = resolved.note || "";
  if (resolved.result) {
    result.testDetail = resolved.result.detail;
    result.testLoose = !!resolved.result.loose;
  }
  return result;
}