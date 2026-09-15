/* collect.js —— 提取一个站点的全部要素：cookie（含 httpOnly）→ 用户 ID → 会话 → 访问令牌。
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

  // 2. 用户 ID：手填 → 站点 localStorage（注入）。new-api 的接口强制要求 New-Api-User 头
  let userId = String(manualUserId || "").trim();
  if (!userId) {
    const cached = await readSiteLocalStorage(site);
    if (cached && cached.id) userId = cached.id;
  }
  if (!userId) {
    result.errors.push("读不到用户 ID（new-api 强制要求 New-Api-User 头）—— 先登录站点，或在下面手填一个");
    return result;
  }
  result.userId = userId;

  // 3. 会话：带全部 cookie 调 /api/user/self（顺带过一遍 WAF）
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
  if (!result.me) return result;

  // 4. 访问令牌：字段直取 → 候选验证 → GET /api/user/token
  const resolved = await resolveAccessToken(site, result.me, result.userId);
  result.accessToken = resolved.token;
  result.accessTokenSource = resolved.source;
  result.accessTokenNote = resolved.note || "";
  if (resolved.result) {
    result.testDetail = resolved.result.detail;
    result.testLoose = !!resolved.result.loose;
  }
  return result;
}
