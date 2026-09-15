/* extract-actions.js —— 「提取账号」面板的按钮动作：测试令牌 / 测试 Cookie / 写入 SITES */

"use strict";

async function runTokenTest() {
  const site = normSite();
  const token = byId("tokenField").value.trim();
  const userId = (extractState && extractState.userId) || byId("userIdInput").value.trim();
  if (!token) { setStatus("testResult", "访问令牌是空的", true); return; }
  if (!userId) { setStatus("testResult", "用户 ID 是空的（new-api 需要 New-Api-User 头）", true); return; }
  setStatus("testResult", "正在验证令牌（严格模式，不带浏览器 cookie）…");
  const result = await tryVerify(token, userId, site);
  if (result.ok) {
    setStatus("testResult", result.loose
      ? "🟡 令牌可用，但严格模式被 WAF 拦 —— 是带浏览器 cookie 才通过的"
      : "✅ 令牌有效（严格模式通过，不带任何会话也能用）");
  } else {
    setStatus("testResult", "❌ 令牌无效：" + result.detail.message, true);
  }
}

async function runCookieTest() {
  const site = normSite();
  let userId = (extractState && extractState.userId) || byId("userIdInput").value.trim();
  if (!userId) {
    const cached = await readSiteLocalStorage(site);
    if (cached && cached.id) userId = cached.id;
  }
  setStatus("testResult", "正在用扩展的 cookie 权限带全部 cookie 请求 /api/user/self …");
  try {
    const me = userFromSelf(await callApi(site + "/api/user/self", { userId: userId || undefined }));
    if (me) {
      setStatus("testResult", "✅ Cookie 能过：会话有效（用户 " + (me.username || me.id) + "），WAF 也没拦");
    } else {
      setStatus("testResult", "❌ Cookie 没过：success=false（可能没登录）", true);
    }
  } catch (e) {
    setStatus("testResult", "❌ Cookie 没过：" + e.message, true);
  }
}

/** 提取结果 → 一行账号（行格式）；parseLines 会原样走一遍校验 */
function buildLineFromState(state) {
  const label = (state.me && (state.me.username || state.me.display_name)) || "账号";
  if (state.accessToken) {
    return state.site + "|" + label + "|token=" + state.userId + "|" + state.accessToken;
  }
  return state.site + "|" + label + "|cookie|" + state.cookie;
}

/** 把提取结果写进 SITES 存储（替换 / 追加），切到 SITES 标签即可复制或跨标签页填写 */
async function toSites() {
  if (!extractState) return;
  if (!extractState.accessToken && !extractState.cookie) {
    setStatus("testResult", "没有可用的凭证（令牌和 cookie 都是空的）", true);
    return;
  }
  const parsed = parseLines(buildLineFromState(extractState));
  if (parsed.errors.length) {
    setStatus("testResult", parsed.errors.join("；"), true);
    return;
  }
  const sites = buildSites(parsed.accounts);
  const mode = document.querySelector('input[name="writeMode"]:checked').value;
  await setStoredSites(mode === "append" ? mergeSites(await getStoredSites(), sites) : sites);
  setStatus("testResult", "✅ 已写入（" + mode + " 模式，本次 " + countAccounts(sites) + " 个账号）—— 切到「SITES JSON」标签复制或跨标签页填写");
}

byId("testTokenBtn").addEventListener("click", runTokenTest);
byId("testCookieBtn").addEventListener("click", runCookieTest);
byId("toSitesBtn").addEventListener("click", toSites);
