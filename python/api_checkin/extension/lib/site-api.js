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
    返回 { ok: true, user, access_token } 或 { ok: false, reason }；v0.x 站静默 ok:false。

    只要换出了 access_token 就算成功 —— 用户 ID 优先取响应的 user，取不到再从令牌的
    JWT payload 里读，都没有也照样返回（ID 可以由手填 / localStorage 补），
    免得「换到了令牌却因为没解析出 ID 而整体判失败」。 */
async function bootstrapV1Auth(site) {
  // 站点串可能带路径（https://x.com/sub）—— 标签页匹配只能用 origin，先归一
  let origin = String(site || "").replace(/\/+$/, "");
  try { origin = new URL(origin).origin; } catch (e) { /* 解析不了就按原样试 */ }
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
          // 注进页面里执行，不能引用扩展侧的函数 —— 需要的工具全部内联
          const payloadOf = (tok) => {
            try {
              const seg = String(tok || "").split(".")[1];
              if (!seg) return {};
              const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
              const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
              const o = JSON.parse(json);
              return o && typeof o === "object" ? o : {};
            } catch (e) {
              return {};
            }
          };
          try {
            const res = await fetch("/api/user/auth/refresh", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
            });
            const data = await res.json().catch(() => null);
            const d = data && data.data;
            const token = String((d && (d.access_token || d.token)) || "");
            if (res.ok && data && data.success === true && d && token) {
              const p = payloadOf(token);
              const u = d.user || {};
              const id = String(u.id || u.user_id || d.user_id || d.id || p.id || p.user_id || p.sub || "");
              const username = String(u.username || u.name || d.username || p.username || p.name || "");
              return { ok: true, id: id, username: username, access_token: token };
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

/* ── 签到入口：探测 / 试打 / 账号密码登录 ── */

/** 候选签到路径：标准 new-api 是第一个，其余是各 fork 的改法（按命中率排序） */
const CHECKIN_CANDIDATES = [
  "/api/user/checkin",
  "/api/checkin",
  "/api/user/sign_in",
  "/api/user/signin",
  "/api/user/attendance",
];

function authHeaders(credential) {
  return credential && credential.kind === "token" && credential.value
    ? { Authorization: "Bearer " + credential.value }
    : {};
}

/**
 * 探测站点真实的签到入口：逐个 POST 候选路径，返回第一个「存在」的。
 * 404 = 这个路径不存在，换下一个；401/403/405/200 都说明路径在，只是凭证或方法的问题；
 * 撞到 WAF 挑战页时判断不了 —— 标成 certain:false，让面板把话说清楚。
 * 返回 { path, certain, message } 或 null（全都 404）。
 */
async function probeCheckinPath(site, credential) {
  for (const path of CHECKIN_CANDIDATES) {
    try {
      const data = await callApi(site + path, {
        method: "POST",
        userId: credential.userId,
        headers: authHeaders(credential),
      });
      return { path: path, certain: true, message: String((data && data.message) || "") };
    } catch (e) {
      const msg = String((e && e.message) || "");
      if (/HTTP 404/.test(msg)) continue;
      if (/响应不是 JSON/.test(msg)) return { path: path, certain: false, message: msg };
      return { path: path, certain: true, message: msg };
    }
  }
  return null;
}

/** 真的打一次签到接口：站点自己的文案原样带回（成功 / 今日已签到 / 失败原因） */
async function tryCheckin(site, path, credential) {
  const data = await callApi(site + path, {
    method: "POST",
    userId: credential.userId,
    headers: authHeaders(credential),
  });
  return { success: data.success === true, message: String((data && data.message) || "") };
}

/** 用户名 + 密码登录（new-api 的 POST /api/user/login）→ 拿会话 cookie 或令牌。
    成功后浏览器会自动存下 Set-Cookie，所以直接从 cookie 罐里读回来就行。 */
async function loginWithPassword(site, username, password) {
  const data = await callApi(site + "/api/user/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: username, password: password }),
  });
  if (!data || data.success !== true) {
    return { ok: false, reason: String((data && data.message) || "登录失败") };
  }
  const d = data.data || {};
  const token = String(d.access_token || d.token || "");
  const jar = await readCookies(site);
  const cookie = cookieHeader(jar.cookies);
  if (!token && !cookie) {
    return { ok: false, reason: "登录接口返回成功，但既没拿到令牌也没拿到会话 cookie" };
  }
  return { ok: true, token: token, cookie: cookie, userId: String(d.user_id || d.id || "") };
}