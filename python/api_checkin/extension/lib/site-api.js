/* site-api.js —— 站点 API 的统一调用（不碰 DOM）。
   credentials 默认 "include"：扩展上下文有 host 权限，会把该站全部 cookie
   （含 httpOnly 的 session 和 WAF 的 acw_*）一起带出去 —— 油猴做不到，
   这是扩展能过阿里云 WAF 的关键。验证令牌时传 "omit" 排除假阳性。 */

"use strict";

async function callApi(url, options) {
  const opts = options || {};
  const headers = Object.assign(
    { Accept: "application/json" },
    opts.userId ? { "New-Api-User": String(opts.userId) } : {},
    opts.headers || {}
  );

  const res = await fetch(url, {
    method: opts.method || "GET",
    credentials: opts.credentials || "include",
    headers: headers,
    body: opts.body,
  });

  const text = await res.text();
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
