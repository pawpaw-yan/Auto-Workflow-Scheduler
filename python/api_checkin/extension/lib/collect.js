/* collect.js —— 提取一个站点的全部要素。支持三类站点：
   ① 标准 new-api / one-api（含 v0.x 与定制 fork）
   ② new-api v1.x（轮换 Bearer，POST /api/user/auth/refresh 自举）
   ③ 独立签到系统（LinuxDo OAuth + PoW，GET /api/info 是状态口，cookie 即凭证）
   每一步的失败都记进 errors，绝不因为一步失败丢掉已拿到的值。 */

"use strict";

async function collectSite(site, manualUserId) {
  const result = {
    site: site, userId: "", me: null, siteType: "",
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

  // 2. 用户 ID：手填 → 站点 localStorage → 独立签到系统 /api/info → v1.x 自举
  let userId = String(manualUserId || "").trim();
  let bundle = null;
  let checkinInfo = null;
  if (!userId) {
    const cached = await readSiteLocalStorage(site);
    if (cached && cached.id) userId = cached.id;
  }
  if (!userId) {
    const probe = await fetchCheckinInfo(site);
    if (probe.ok) {
      checkinInfo = probe.info;
      result.siteType = "checkin-system";
      if (checkinInfo.logged_in) {
        userId = String(checkinInfo.user_id || checkinInfo.linux_do_id || "");
      } else {
        result.errors.push(
          "未登录：该站是独立的签到系统（Linux Do OAuth）。请先在浏览器用 Linux Do 登录本站，再回来重试"
        );
      }
    }
  }
  if (!userId && !checkinInfo) {
    bundle = await bootstrapV1Auth(site);
    if (bundle && bundle.user && bundle.user.id) {
      userId = String(bundle.user.id);
      result.siteType = "v1x";
    }
  }
  if (!userId) {
    if (result.siteType !== "checkin-system") {
      result.errors.push(
        "读不到用户 ID。检查：① 浏览器已登录该站点；" +
        "② new-api v1.x 站把用户信息只放在内存里 —— 在下面手填用户 ID" +
        "（站点「个人设置」页可查），或生成系统访问令牌后改用令牌方式"
      );
    }
    return result;
  }
  result.userId = userId;

  // 3. 会话：签到系统看 info；v1.x 用自举结果；标准站带 cookie 调 /api/user/self
  if (checkinInfo) {
    result.sessionValid = !!checkinInfo.logged_in;
    // JWT 会话有效期（linuxdo_checkin_session 的 payload.exp）—— 这类站的会话约 24 小时一换
    const m = /(?:^|;\s*)linuxdo_checkin_session=([^;]+)/.exec(result.cookie);
    if (m) {
      try {
        let b64 = m[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        while (b64.length % 4) b64 += "=";
        const payload = JSON.parse(atob(b64));
        if (payload.exp) {
          result.sessionExpiresAt = payload.exp * 1000;
          if (result.sessionExpiresAt <= Date.now()) {
            result.sessionValid = false;
            result.errors.push("会话已过期（" + new Date(result.sessionExpiresAt).toLocaleString() + "）—— 重新登录本站并重新提取");
          }
        }
      } catch (e) { /* 解不出就忽略 */ }
    }
    if (result.sessionValid) {
      result.me = { id: userId, username: checkinInfo.username || "", quota: checkinInfo.quota };
    }
  } else if (bundle) {
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

  // 4. 访问令牌（独立签到系统没有令牌体系 —— cookie 即凭证）
  if (result.siteType === "checkin-system") {
    result.accessTokenNote = "独立签到系统无需访问令牌 —— cookie 即凭证（workflow 用 cookie 方式签到）";
    return result;
  }

  // 临时令牌只是钥匙：先换长效系统访问令牌，换不到再走兜底链，最后才是临时令牌
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
    if (r.token) resolved = r;
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