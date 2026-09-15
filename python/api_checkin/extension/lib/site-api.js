/* site-api.js —— 站点 API 的统一调用（不碰 DOM）。
   credentials 默认 "include"：扩展上下文有 host 权限，会把该站全部 cookie
   （含 httpOnly 的 session 和 WAF 的 acw_*）一起带出去 —— 油猴做不到，
   这是扩展能过阿里云 WAF 的关键。验证令牌时传 "omit" 排除假阳性。
   命中阿里云 WAF 的 acw_sc__v2 挑战时自动求解重试 —— 算法与
   ../../index.py 的实现保持一致（ACW_UNSBOX / ACW_MASK 改动必须两边同步）。 */

"use strict";

const ACW_COOKIE = "acw_sc__v2";
const ACW_MASK = "3000176000856006061501533003690027800375";
const ACW_UNSBOX = [
  15, 35, 29, 24, 33, 16, 1, 38, 10, 9, 19, 31, 40, 27, 22, 23,
  25, 13, 6, 11, 39, 18, 20, 8, 14, 21, 32, 26, 2, 30, 7, 4, 17,
  5, 3, 28, 34, 37, 12, 36,
];
const ACW_ARG1_RE = /arg1=['"]([0-9A-Fa-f]{40})['"]/;

/** 按挑战页的算法由 arg1 算出 acw_sc__v2（与 index.py 逐字节一致） */
function acwScV2Of(arg1) {
  let order = "";
  for (const pos of ACW_UNSBOX) order += arg1[pos - 1];
  let out = "";
  for (let i = 0; i < order.length; i += 2) {
    const x = parseInt(order.slice(i, i + 2), 16) ^ parseInt(ACW_MASK.slice(i, i + 2), 16);
    out += x.toString(16).padStart(2, "0");
  }
  return out;
}

/** 响应体是挑战页时取出 arg1；普通响应返回 null */
function acwChallengeArg1(body) {
  const m = ACW_ARG1_RE.exec(body || "");
  return m ? m[1] : null;
}

/**
 * 把该站点除 acw_* / cdn_sec_tc 外的 cookie 暂时挪出浏览器罐，跑完 fn 原样放回。
 * 严格验证（omit）连 WAF cookie 都不发，必被拦；挪开 session 后用 include 重试，
 * 就只剩 acw_* 出门 —— 与 index.py 的令牌流程等价：WAF cookie 只用于过墙，
 * 认证仍然必须靠令牌自己。
 */
async function parkSessionCookies(origin, fn) {
  const all = await chrome.cookies.getAll({ url: origin });
  const isWaf = (c) => /^(acw_|cdn_sec_tc)/i.test(c.name);
  const parked = all.filter((c) => !isWaf(c));
  for (const c of parked) {
    await chrome.cookies.remove({ url: origin, name: c.name });
  }
  try {
    return await fn();
  } finally {
    for (const c of parked) {
      const details = {
        url: origin,
        name: c.name,
        value: c.value,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
      };
      if (!c.hostOnly) details.domain = c.domain;
      try { await chrome.cookies.set(details); } catch (e) { /* 恢复失败只能重新登录 */ }
    }
  }
}

async function callApi(url, options) {
  const opts = options || {};
  const headers = Object.assign(
    { Accept: "application/json" },
    opts.userId ? { "New-Api-User": String(opts.userId) } : {},
    opts.headers || {}
  );
  const init = {
    method: opts.method || "GET",
    credentials: opts.credentials || "include",
    headers: headers,
    body: opts.body,
  };

  let res = await fetch(url, init);
  let text = await res.text();

  // 命中 WAF 挑战：算出 acw_sc__v2 种进浏览器真正的 cookie 罐再重试。
  // 严格模式（omit）连 acw_* 都发不出去 —— 改成 include + 挪走会话 cookie，
  // 重试只带 WAF cookie；挑战响应下发的 acw_tc 也会被罐接住，最多三轮。
  for (let round = 0; round < 3; round++) {
    const arg1 = acwChallengeArg1(text);
    if (!arg1) break;
    const origin = new URL(url).origin;
    await chrome.cookies.set({ url: origin, name: ACW_COOKIE, value: acwScV2Of(arg1) });
    if ((init.credentials || "include") === "omit") {
      const retry = Object.assign({}, init, { credentials: "include" });
      const out = await parkSessionCookies(origin, async () => {
        const r = await fetch(url, retry);
        return { r: r, t: await r.text() };
      });
      res = out.r;
      text = out.t;
    } else {
      res = await fetch(url, init);
      text = await res.text();
    }
  }

  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }

  if (!res.ok) throw new Error("HTTP " + res.status + " " + text.slice(0, 120));
  if (data === null) {
    throw new Error("响应不是 JSON（可能是 WAF / 反爬的挑战页）：" + text.slice(0, 100));
  }
  return data;
}

/** /api/user/self 的成功响应 → data 里的用户对象；形态不对就返回 null */
function userFromSelf(data) {
  return (data && data.success === true && data.data && typeof data.data === "object") ? data.data : null;
}

/** cookie 列表 → "name=value; name2=value2"（会话 cookie 排最前，贴近 DevTools 复制出来的顺序） */
function cookieHeader(cookies) {
  const rank = (name) => (/^(session|new-api-session)$/i.test(name) ? 0 : 1);
  return (cookies || [])
    .slice()
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((c) => c.name + "=" + c.value)
    .join("; ");
}

/** 读某站点的全部 cookie —— chrome.cookies 拿得到 httpOnly，油猴的 document.cookie 拿不到 */
async function readCookies(site) {
  try {
    const url = /^https?:\/\//.test(site) ? site : "https://" + site;
    const cookies = await chrome.cookies.getAll({ url: url });
    return { ok: true, cookies: cookies || [] };
  } catch (e) {
    return { ok: false, cookies: [], error: e.message };
  }
}
/** new-api v1.x 自举：POST /api/user/auth/refresh —— 与站点前端同一逻辑，
    浏览器自动带上 httpOnly 的刷新 cookie，返回 { access_token, user, session }。
    v0.x 站没有这个端点，任何失败都静默返回 null。 */
async function bootstrapV1Auth(site) {
  try {
    const data = await callApi(site + "/api/user/auth/refresh", { method: "POST", credentials: "include" });
    const d = data && data.data;
    return d && d.user && d.user.id ? d : null;
  } catch (e) {
    return null;
  }
}