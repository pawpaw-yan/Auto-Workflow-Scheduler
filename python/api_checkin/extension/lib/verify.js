/* verify.js —— 令牌验证：严格一次（不带任何会话 cookie）。没过就是无效或被 WAF 拦截。 */

"use strict";

/** 用 token 调 GET /api/user/self（带 New-Api-User 头）。credentials 决定带不带会话 cookie。 */
async function verifyToken(token, userId, site, credentials) {
  const detail = { site: site, status: null, message: "", ok: false };
  try {
    const data = await callApi(site + "/api/user/self", {
      credentials: credentials || "omit",
      headers: { Authorization: "Bearer " + token },
      userId: userId,
    });
    if (data && data.success === true) {
      detail.ok = true;
      detail.message = "令牌有效";
    } else {
      detail.status = 200;
      detail.message = (data && data.message) || "success=false";
    }
  } catch (e) {
    detail.message = e.message;
  }
  return detail;
}

/** 严格验证一次：不带任何会话 cookie。没过就是没过（无效或被 WAF 拦截），不做带 cookie 的重试。 */
async function tryVerify(token, userId, site) {
  return verifyToken(token, userId, site, "omit");
}
