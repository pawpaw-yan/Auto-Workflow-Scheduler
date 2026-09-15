/* extract-actions.js —— 主表单的按钮动作：
   登录 / 验证凭证 / 扫描签到入口 / 测试签到 / 保存进 SITES */

"use strict";

/** 表单是唯一的真相来源 —— 没点过「读取」就直接手填时，这里补一个空 state */
function ensureState() {
  if (!extractState) {
    extractState = {
      site: normSite(), userId: currentUserId(), me: null, siteType: "",
      cookie: byId("cookieField").value.trim(), cookieNames: [], cookieCount: 0, sessionValid: false,
      accessToken: byId("tokenField").value.trim(), accessTokenSource: "", accessTokenNote: "",
      testDetail: null, testLoose: false, errors: [], v1x: false,
      checkinPath: byId("checkinPath").value.trim(),
    };
  }
  return extractState;
}

/** 验证访问令牌：严格一次（不带任何浏览器 cookie），没过就是没过 */
async function verifyTokenNow() {
  const site = normSite();
  const token = byId("tokenField").value.trim();
  const userId = currentUserId();
  if (!token) { setStatus("formStatus", "访问令牌是空的", true); return; }
  if (!userId) { setStatus("formStatus", "用户 ID 是空的（new-api 需要 New-Api-User 头）", true); return; }
  setStatus("formStatus", "正在验证令牌（严格模式，不带浏览器 cookie）…");
  const r = await tryVerify(token, userId, site);
  if (r.ok) setStatus("formStatus", "✅ 令牌有效");
  else setStatus("formStatus", "❌ 令牌没过（无效或被 WAF 拦截）：" + r.detail.message, true);
}

/** 验证 Cookie —— v1.x 站（名字带 refresh 的 cookie）的真含义是「刷新令牌能不能换出访问令牌」 */
async function verifyCookieNow() {
  const site = normSite();
  if ((extractState && extractState.v1x) || /(^|;\s*)[^=]*refresh=[^;]/.test(byId("cookieField").value)) {
    setStatus("formStatus", "正在用刷新令牌自举（在站点标签页内发请求）…");
    const boot = await bootstrapV1Auth(site);
    if (boot && boot.ok) {
      setStatus("formStatus", "✅ 刷新令牌有效：已换出新的访问令牌（用户 " + (boot.user.username || boot.user.id) + "）");
    } else {
      setStatus("formStatus", "❌ 刷新令牌没过：" + ((boot && boot.reason) || "未知原因"), true);
    }
    return;
  }
  let userId = currentUserId();
  if (!userId) {
    const cached = await readSiteLocalStorage(site);
    if (cached && cached.id) userId = cached.id;
  }
  setStatus("formStatus", "正在用扩展的 cookie 权限带全部 cookie 请求 /api/user/self …");
  try {
    const me = userFromSelf(await callApi(site + "/api/user/self", { userId: userId || undefined }));
    if (me) {
      setStatus("formStatus", "✅ Cookie 能过：会话有效（用户 " + (me.username || me.id) + "），WAF 也没拦");
    } else {
      setStatus("formStatus", "❌ Cookie 没过：success=false（可能没登录）", true);
    }
  } catch (e) {
    let msg = "❌ Cookie 没过：" + e.message;
    if (/AUTH_UNAUTHORIZED|access token/i.test(e.message)) {
      msg += "\n该站是 new-api v1.x：接口只认 Bearer 令牌、不认 cookie —— 把「鉴权类型」改成访问令牌";
    }
    setStatus("formStatus", msg, true);
  }
}

/** 扫描签到入口：逐个 POST 候选路径，第一个不是 404 的就是它。
    quiet=true 是「读取」里的自动扫描，只在真探到时才写界面。 */
async function scanCheckin(quiet) {
  const site = normSite();
  const cred = currentCredential();
  if (!cred.value) {
    if (!quiet) setStatus("formStatus", "先拿到令牌或 Cookie 再扫描 —— 没有凭证时 401 和 404 分不清", true);
    return null;
  }
  if (!quiet) setStatus("formStatus", "正在扫描签到入口…");
  const found = await probeCheckinPath(site, cred);
  if (!found) {
    if (!quiet) {
      setStatus("formStatus", "❌ 没探到签到入口（候选路径全是 404）—— 该站可能不提供签到接口，也可手填一个路径", true);
    }
    return null;
  }
  byId("checkinPath").value = found.path;
  ensureState().checkinPath = found.path;
  if (!quiet) {
    setStatus(
      "formStatus",
      found.certain
        ? "✅ 签到入口：" + found.path
        : "⚠️ 疑似入口 " + found.path + "（撞到 WAF 挑战页，没确认 —— 可点「▶ 测试签到」再试）",
      !found.certain
    );
  }
  return found;
}

/** 真打一次签到接口：成功 / 今日已签到 / 失败原因，全是站点自己给的话 */
async function testCheckin() {
  const site = normSite();
  const path = byId("checkinPath").value.trim();
  if (!path) {
    setStatus("formStatus", "还没有签到入口 —— 先点「读取」自动探测，或手填一个路径（如 /api/user/checkin）", true);
    return;
  }
  const cred = currentCredential();
  if (!cred.value) {
    setStatus("formStatus", "还没有凭证 —— 先「读取」拿到，或直接填令牌 / Cookie", true);
    return;
  }
  setStatus("formStatus", "正在请求 POST " + path + " …");
  try {
    const r = await tryCheckin(site, path, cred);
    if (r.success) {
      noteTurnstile(r.message, true);
      setStatus("formStatus", "✅ 签到成功：" + (r.message || "（站点没给消息）"));
    } else if (/已签|重复|already/i.test(r.message)) {
      noteTurnstile(r.message, true);
      setStatus("formStatus", "🔄 今日已签到：" + r.message);
    } else {
      noteTurnstile(r.message, false);
      setStatus("formStatus", "❌ 签到没过：" + (r.message || "success=false"), true);
    }
  } catch (e) {
    noteTurnstile(e.message, false);
    setStatus("formStatus", "❌ 签到请求失败：" + e.message, true);
  }
}

/** 账号 + 密码登录（POST /api/user/login）→ 拿会话 cookie 或令牌，填回表单 */
async function runLogin() {
  const site = normSite();
  const username = byId("loginUser").value.trim();
  const password = byId("loginPass").value;
  if (!/^https?:\/\//.test(site)) { setStatus("formStatus", "站点地址要以 http:// 或 https:// 开头", true); return; }
  if (!username || !password) { setStatus("formStatus", "账号和密码都要填", true); return; }
  setStatus("formStatus", "正在登录…");
  try {
    const r = await loginWithPassword(site, username, password);
    if (!r.ok) { setStatus("formStatus", "❌ 登录失败：" + r.reason, true); return; }
    const state = ensureState();
    if (r.cookie) { byId("cookieField").value = r.cookie; state.cookie = r.cookie; }
    if (r.token) { byId("tokenField").value = r.token; state.accessToken = r.token; }
    if (r.userId) { byId("userIdInput").value = r.userId; state.userId = r.userId; }
    byId("authKind").value = r.token ? "token" : "cookie";
    syncBoxes();
    setStatus("formStatus", "✅ 登录成功（" + (r.token ? "拿到访问令牌" : "拿到会话 Cookie") + "）");
    if (currentCredential().value) await scanCheckin(true);
  } catch (e) {
    setStatus("formStatus", "❌ 登录请求失败：" + e.message, true);
  }
}

/** 表单 → 一条账号。用 parseLines 原样走一遍校验，保证与 index.py 口径一致。 */
function accountFromForm() {
  const site = normSite();
  const userId = currentUserId();
  const kind = authKind();
  const secret = kind === "cookie" ? byId("cookieField").value.trim() : byId("tokenField").value.trim();
  if (!secret) return { errors: ["「" + (kind === "cookie" ? "Cookie" : "访问令牌") + "」是空的 —— 读取或粘贴后再保存"] };

  const label = (extractState && extractState.me && (extractState.me.username || extractState.me.display_name)) || "账号";
  const line = site + "|" + label + "|" + kind + (userId ? "=" + userId : "") + "|" + secret;
  const parsed = parseLines(line);
  if (parsed.errors.length) return { errors: parsed.errors };

  const path = byId("checkinPath").value.trim();
  if (path) parsed.accounts.forEach((acc) => { acc.checkinPath = path; });
  return { accounts: parsed.accounts };
}

/** 保存：把当前配置追加进 SITES 存储（生成 JSON 时会带上 checkin_path）。
    行格式只有 4 段装不下签到入口，所以路径是单独挂在账号对象上的。 */
async function saveToSites() {
  const built = accountFromForm();
  if (built.errors) { setStatus("formStatus", built.errors.join("；"), true); return; }
  const res = await appendAccounts(built.accounts);
  setStatus(
    "formStatus",
    "✅ 已保存（新增 " + res.added + " 条" + (res.dup ? "，跳过重复 " + res.dup + " 条" : "") + "，共 " + res.total + " 条）"
      + " —— 展开下面「SITES 输出」可生成配置"
  );
}

byId("loginBtn").addEventListener("click", runLogin);
byId("verifyBtn").addEventListener("click", verifyTokenNow);
byId("verifyCookieBtn").addEventListener("click", verifyCookieNow);
byId("testCheckinBtn").addEventListener("click", testCheckin);
byId("saveBtn").addEventListener("click", saveToSites);
