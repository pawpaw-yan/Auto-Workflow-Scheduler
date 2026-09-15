/* verify.js —— 两级令牌验证：先严格（不带 cookie），被 WAF 拦下才带 cookie 重试。
   严格模式过了才算「真能用」；带 cookie 才过的只算 🟡（浏览器语境可用）。 */

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

/**
 * 两级验证。第一级严格（omit）；失败且响应像被 WAF 拦（403/405 或非 JSON）时，
 * 第二级带 cookie 重试。返回 { ok, loose, detail }。
 */
async function tryVerify(token, userId, site) {
  const strict = await verifyToken(token, userId, site, "omit");
  if (strict.ok) return { ok: true, loose: false, detail: strict };

  const wafLike = /HTTP 40[35]|挑战页/.test(strict.message);
  if (!wafLike) return { ok: false, loose: false, detail: strict };

  const loose = await verifyToken(token, userId, site, "include");
  if (loose.ok) return { ok: true, loose: true, detail: loose };
  return { ok: false, loose: true, detail: loose };
}
