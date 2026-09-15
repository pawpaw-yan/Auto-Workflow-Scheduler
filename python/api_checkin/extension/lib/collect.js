/* collect.js —— 提取一个站点的全部要素：cookie（含 httpOnly）→ 用户 ID → 会话 → 访问令牌。
   用户 ID 三级自举：站点 localStorage（v0.x 系）→ new-api v1.x 的 auth/refresh
   （浏览器自动带 httpOnly 刷新 cookie，与站点前端同一逻辑）→ 手填兜底。
   每一步的失败都记进 errors，绝不因为一步失败丢掉已拿到的值。 */

"use strict";

async function collectSite(site, manualUserId) {
  const result = {
    site: site, userId: "", me: null,
    cookie: "", cookieNames: [], cookieCount: 0, sessionValid: false,
    accessToken: "", accessTokenSource: "", accessTokenNote: "",
    testDetail: null, testLoose: false, errors: [],
  };

  // 1. Cookie：chrome.cookies 直接读（含 httpOnly）
  const jar = await readCookies(site);
  if (!jar.ok) result.errors.push("读 cookie 失败：" + jar.error);
  result.cookie = cookieHeader(jar.cookies);
  result.cookieNames = jar.cookies.map((c) => c.name);
  result.cookieCount = result.cookieNames.length;

  // 2. 用户 ID：手填 → 站点 localStorage（注入）→ new-api v1.x 自举
  let userId = String(manualUserId || "").trim();
  let bundle = null;
  if (!userId) {
    const cached = await readSiteLocalStorage(site);
    if (cached && cached.id) userId = cached.id;
  }
  if (!userId) {
    bundle = await bootstrapV1Auth(site);
    if (bundle && bundle.user && bundle.user.id) userId = String(bundle.user.id);
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
  }
  if (!result.me) return result;

  // 4. 访问令牌：字段直取 → 候选验证 → GET /api/user/token → v1.x 轮换令牌兜底
  const resolved = await resolveAccessToken(site, result.me, result.userId);
  if (!resolved.token && bundle && bundle.access_token) {
    const v = await tryVerify(bundle.access_token, result.userId, site);
    if (v.ok) {
      resolved.token = bundle.access_token;
      resolved.source = "v1.x auth/refresh 的轮换令牌（短期有效，建议在站点生成系统访问令牌长期用）";
      resolved.result = v;
    }
  }
  result.accessToken = resolved.token;
  result.accessTokenSource = resolved.source;
  result.accessTokenNote = resolved.note || "";
  if (resolved.result) {
    result.testDetail = resolved.result.detail;
    result.testLoose = !!resolved.result.loose;
  }
  return result;
}