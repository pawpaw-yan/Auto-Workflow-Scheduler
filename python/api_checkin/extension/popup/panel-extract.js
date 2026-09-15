/* panel-extract.js —— 「提取账号」面板：读站点 → 展示。测试与写入在 extract-actions.js */

"use strict";

let extractState = null;   // collectSite 的结果，面板内按钮共享

function normSite() {
  return byId("siteInput").value.trim().replace(/\/+$/, "");
}

async function loadSite() {
  const site = normSite();
  if (!/^https?:\/\//.test(site)) {
    setStatus("extractError", "站点地址要以 http:// 或 https:// 开头", true);
    return;
  }
  byId("loadBtn").disabled = true;
  setStatus("extractError", "正在读取（cookie / 用户 ID / 会话 / 令牌）…");
  try {
    extractState = await collectSite(site, byId("userIdInput").value);
    renderExtractInfo();
    setStatus("extractError", extractState.errors.join("；"), extractState.errors.length > 0);
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
    ["访问令牌", state.accessToken
      ? (state.accessTokenSource + (state.testLoose ? "（严格模式被 WAF 拦，带 cookie 才过）" : "（严格模式验证通过）"))
      : (state.accessTokenNote || "（未取到）")],
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

  // 读取时已经验证过的令牌，结果一并显示
  if (state.testDetail) {
    setStatus("testResult", state.testLoose
      ? "访问令牌：严格模式被 WAF 拦，带浏览器 cookie 才通过（点「测试访问令牌」可复验）"
      : "访问令牌：严格模式验证通过 —— 真能用");
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
