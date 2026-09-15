/* panel-extract.js —— 「提取签到信息」面板：读站点 → 展示。测试与写入在 extract-actions.js */

"use strict";

let extractState = null;   // collectSite 的结果，面板内按钮共享

function normSite() {
  return byId("siteInput").value.trim().replace(/\/+$/, "");
}

/** 当前拿得出手的凭证：优先按「认证方式」选，没有就退到另一个（令牌优先） */
function currentCredential() {
  const userId = byId("idField").value.trim()
    || (extractState && extractState.userId)
    || byId("userIdInput").value.trim();
  const token = byId("tokenField").value.trim();
  const cookie = byId("cookieField").value.trim();
  const mode = byId("authMode").value;
  if (mode === "cookie" && cookie) return { kind: "cookie", value: cookie, userId: userId };
  if (token) return { kind: "token", value: token, userId: userId };
  if (cookie) return { kind: "cookie", value: cookie, userId: userId };
  return { kind: "token", value: "", userId: userId };
}

async function loadSite() {
  const site = normSite();
  if (!/^https?:\/\//.test(site)) {
    setStatus("extractError", "站点地址要以 http:// 或 https:// 开头", true);
    return;
  }
  if (isGithubHost(site)) {
    setStatus("extractError", "这是 GitHub，不是 API 站点 —— 填你的 new-api / one-api 站点地址", true);
    return;
  }
  byId("loadBtn").disabled = true;
  setStatus("extractError", "正在读取（cookie / 用户 ID / 会话 / 令牌 / 签到入口）…");
  try {
    extractState = await collectSite(site, byId("userIdInput").value);
    renderExtractInfo();
    setStatus("extractError", extractState.errors.join("；"), extractState.errors.length > 0);
    // 读到凭证就顺手把签到入口探出来 —— 这正是「提取签到信息」要拿的东西
    if (currentCredential().value && typeof scanCheckin === "function") {
      await scanCheckin(true);
    }
  } catch (e) {
    setStatus("extractError", "读取失败：" + e.message, true);
  } finally {
    byId("loadBtn").disabled = false;
  }
}

/** 展示提取结果；info 用 DOM 拼接，站点数据不进 innerHTML */
function renderExtractInfo() {
  const state = extractState || {};
  const rows = [
    ["站点", state.site || "-"],
    ["用户 ID", state.userId || "（未取到）"],
    ["会话", state.sessionValid ? "有效" : "无效（没登录或被 WAF 拦）"],
    ["Cookie 数", String(state.cookieCount || 0)],
    ["站点类型", state.v1x ? "new-api v1.x（接口只认令牌 —— 用下面的令牌配 token 方式）" : "new-api / one-api（cookie 或令牌均可）"],
    ["访问令牌", state.accessToken
      ? (state.accessTokenSource + "（已验证可用）")
      : (state.accessTokenNote || "（未取到）")],
    ["签到入口", state.checkinPath || "（未探测 —— 点「扫描」）"],
  ];

  const info = byId("info");
  info.textContent = "";
  rows.forEach((pair) => {
    const row = document.createElement("div");
    const key = document.createElement("b");
    key.textContent = pair[0];
    const val = document.createElement("span");
    val.textContent = pair[1];
    row.appendChild(key);
    row.appendChild(val);
    info.appendChild(row);
  });

  byId("idField").value = state.userId || "";
  byId("tokenField").value = state.accessToken || "";
  byId("cookieField").value = state.cookie || "";
  byId("checkinPath").value = state.checkinPath || "";

  // 认证方式默认选「有值的那个」：拿到长效令牌就用令牌，否则退到 cookie
  byId("authMode").value = state.accessToken ? "token" : "cookie";
  byId("passwordRow").hidden = true;

  // 读取时已经验证过的令牌，结果一并显示
  if (state.testDetail) {
    setStatus("testResult", "访问令牌：验证通过 —— 真能用");
  }
}

byId("loadBtn").addEventListener("click", loadSite);
byId("retryBtn").addEventListener("click", loadSite);

// 手改令牌 / cookie 后同步回 state，后续测试与写入用的是改后的值
byId("tokenField").addEventListener("change", () => {
  if (extractState) extractState.accessToken = byId("tokenField").value.trim();
});
byId("cookieField").addEventListener("change", () => {
  if (extractState) extractState.cookie = byId("cookieField").value.trim();
});
byId("checkinPath").addEventListener("change", () => {
  if (extractState) extractState.checkinPath = byId("checkinPath").value.trim();
});

// 认证方式：选「账号 + 密码」时展开登录行
byId("authMode").addEventListener("change", () => {
  byId("passwordRow").hidden = byId("authMode").value !== "password";
});

// Open panel: auto-read the current site (status line explains when the user id is unreadable)
initDefaultSite().then(() => {
  const site = byId("siteInput").value.trim();
  if (/^https?:\/\//.test(site) && !isGithubHost(site)) loadSite();
});
