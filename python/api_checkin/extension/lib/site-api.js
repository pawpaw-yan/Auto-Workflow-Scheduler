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

/** 读某站点的全部 cookie —— chrome.cookies 拿得到 httpOnly，油猴的 document.cookie 拿不到。
    依次试：按 URL → 按域名（兜父域 cookie）→ 按域名 + 分区键（CHIPS）。 */
async function readCookies(site) {
  const base = /^https?:\/\//.test(site) ? site : "https://" + site;
  let host = "";
  let origin = base;
  try {
    const u = new URL(base);
    host = u.hostname;
    origin = u.origin;
  } catch (e) {
    return { ok: false, cookies: [], error: "站点地址无法解析：" + base };
  }

  const tries = [
    { label: "url", q: { url: base } },
    { label: "domain", q: { domain: host } },
    { label: "partitioned", q: { url: base, partitionKey: { topFrameSite: origin } } },
  ];
  let lastError = "";
  for (const t of tries) {
    try {
      const cookies = await chrome.cookies.getAll(t.q);
      if (cookies && cookies.length) return { ok: true, cookies: cookies };
    } catch (e) {
      lastError = e.message;   // 分区键在旧版 Chrome 可能报错，继续下一档
    }
  }
  if (lastError) return { ok: false, cookies: [], error: lastError };
  return { ok: true, cookies: [] };
}
/** new-api v1.x 自举：POST /api/user/auth/refresh 换 { access_token, user, session }。
    该端点校验 Origin（CSRF 防护）—— 从扩展页发会被 403 AUTH_ORIGIN_FORBIDDEN 拒掉，
    所以把请求注进该站**已打开的标签页**里执行（同源 Origin、同 cookie 罐、同 CF 放行状态）。
    返回 { ok: true, user, access_token } 或 { ok: false, reason }；v0.x 站静默 ok:false。 */
async function bootstrapV1Auth(site) {
  const origin = site.replace(/\/+$/, "");
  let tabs = [];
  let lastReason = "";
  try {
    tabs = await chrome.tabs.query({ url: origin + "/*" });
  } catch (e) {
    return { ok: false, reason: "无法查询标签页：" + e.message };
  }
  if (!tabs.length) {
    return { ok: false, reason: "该站点的标签页没有打开 —— 自举请求必须从站点自己的页面发出（否则 Origin 校验会拒绝），先开着站点页再点读取" };
  }
  for (const tab of tabs) {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          try {
            const res = await fetch("/api/user/auth/refresh", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
            });
            const data = await res.json().catch(() => null);
            const d = data && data.data;
            if (res.ok && data && data.success === true && d && d.user && d.user.id) {
              return {
                ok: true,
                id: String(d.user.id),
                username: String(d.user.username || ""),
                access_token: String(d.access_token || ""),
              };
            }
            return { ok: false, reason: "HTTP " + res.status + " " + ((data && data.message) || "") };
          } catch (e) {
            return { ok: false, reason: e.message };
          }
        },
      });
      const r = res && res.result;
      if (r && r.ok) {
        return { ok: true, user: { id: r.id, username: r.username }, access_token: r.access_token };
      }
      lastReason = (r && r.reason) || "";
    } catch (e) {
      lastReason = e.message;   // 标签页无法注入等
    }
  }
  return { ok: false, reason: lastReason || "自举失败" };
}