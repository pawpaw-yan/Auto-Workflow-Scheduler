/* access-token.js —— 访问令牌的获取：字段直取 → 候选验证 → 站点自己的令牌接口。
   每个来源都过一遍真验证（tryVerify），绝不把没验证过的值当令牌交出去。 */

"use strict";

/** /api/user/self 的 access_token 字段（有些版本没有这个字段） */
function accessTokenFromUser(user) {
  const value = user && typeof user.access_token === "string" ? user.access_token.trim() : "";
  return value || "";
}

/**
 * 依次尝试三个来源，全用真验证把关：
 *   1. /api/user/self 的 access_token 字段
 *   2. user 对象里所有名字带 token 的字符串字段（tokenCandidates），逐个验证
 *   3. GET /api/user/token（有的版本把令牌放这里）
 * 返回 { token, source, result, note }；拿不到时 token 为空串、note 说明原因。
 */
async function resolveAccessToken(site, me, userId) {
  const direct = accessTokenFromUser(me);
  if (direct) {
    const result = await tryVerify(direct, userId, site);
    if (result.ok) return { token: direct, source: "/api/user/self 的 access_token 字段", result: result };
  }

  // 掩码（形如 sk-abc1****WXYZ）必然 401，直接跳过
  for (const candidate of tokenCandidates(me)) {
    if (looksMasked(candidate.value)) continue;
    const result = await tryVerify(candidate.value, userId, site);
    if (result.ok) return { token: candidate.value, source: "user 对象的字段 `" + candidate.key + "`", result: result };
  }

  try {
    const payload = (await callApi(site + "/api/user/token", { userId: userId })).data;
    const fresh = typeof payload === "string"
      ? payload.trim()
      : String((payload && (payload.access_token || payload.token || payload.key)) || "").trim();
    if (!fresh) return { token: "", source: "", note: "GET /api/user/token 没返回令牌" };
    const result = await tryVerify(fresh, userId, site);
    if (result.ok) return { token: fresh, source: "GET /api/user/token", result: result };
    return { token: "", source: "", result: result, note: "GET /api/user/token 返回了值，但验证没通过（是不是掩码？）" };
  } catch (e) {
    return { token: "", source: "", note: "GET /api/user/token 失败：" + e.message };
  }
}
