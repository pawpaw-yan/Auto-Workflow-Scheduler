/* panel-extract.js —— 主表单：读取站点 → 把结果灌进字段 → 探测签到入口。
   原则：一个值只出现一次。所以没有「信息表」，展示和编辑是同一组控件。
   按钮动作在 extract-actions.js。 */

"use strict";

let extractState = null;
let turnstileState = "unknown";   // unknown | on | off

function normSite() {
  return byId("siteInput").value.trim().replace(/\/+$/, "");
}

function authKind() { return byId("authKind").value; }      // token | cookie
function loginType() { return byId("loginType").value; }    // session | password

function currentUserId() {
  return byId("userIdInput").value.trim() || (extractState && extractState.userId) || "";
}

/** 当前拿得出手的凭证：按「鉴权类型」选，没有就退到另一个 */
function currentCredential() {
  const userId = currentUserId();
  const token = byId("tokenField").value.trim();
  const cookie = byId("cookieField").value.trim();
  if (authKind() === "cookie" && cookie) return { kind: "cookie", value: cookie, userId: userId };
  if (token) return { kind: "token", value: token, userId: userId };
  if (cookie) return { kind: "cookie", value: cookie, userId: userId };
  return { kind: "token", value: "", userId: userId };
}

/** 鉴权类型 / 登录类型决定露哪一块 —— 一次只露一块，不把两套并排堆着 */
function syncBoxes() {
  byId("tokenBox").hidden = authKind() === "cookie";
  byId("cookieBox").hidden = authKind() !== "cookie";
  byId("passwordBox").hidden = loginType() !== "password";
}

function setTurnstile(state, note) {
  const badge = byId("tsBadge");
  badge.textContent = state === "on" ? "已开启" : state === "off" ? "未开启" : "未检测";
  badge.classList.toggle("warn", state === "on");
  badge.classList.toggle("ok", state === "off");
  byId("tsHint").textContent = note || "";
}

/** 从站点返回的文案判断 Turnstile；definite=true 表示这次拿到了确定结论 */
function noteTurnstile(message, definite) {
  if (/turnstile|人机验证|验证码/i.test(message || "")) {
    turnstileState = "on";
    setTurnstile("on", "该站签到启用了 Turnstile —— 脚本签到会被拒，需在浏览器手动完成");
    return;
  }
  if (definite && turnstileState !== "on") {
    turnstileState = "off";
    setTurnstile("off", "当前未开启 Turnstile 验证");
  }
}

async function loadSite() {
  const site = normSite();
  if (!/^https?:\/\//.test(site)) {
    setStatus("formStatus", "站点地址要以 http:// 或 https:// 开头", true);
    return;
  }
  if (isGithubHost(site)) {
    setStatus("formStatus", "这是 GitHub，不是 API 站点 —— 填你的 new-api / one-api 站点地址", true);
    return;
  }
  byId("loadBtn").disabled = true;
  setStatus("formStatus", "正在读取（cookie / 用户 ID / 会话 / 凭证 / 签到入口）…");
  try {
    extractState = await collectSite(site, byId("userIdInput").value);
    renderForm();
    setStatus("formStatus", extractState.errors.join("；"), extractState.errors.length > 0);
    // 读到凭证就顺手把签到入口探出来 —— 这正是「提取签到信息」要拿的东西
    if (currentCredential().value && typeof scanCheckin === "function") {
      await scanCheckin(true);
    }
  } catch (e) {
    setStatus("formStatus", "读取失败：" + e.message, true);
  } finally {
    byId("loadBtn").disabled = false;
  }
}

/** 把读取结果灌进表单 —— 展示与编辑共用同一组控件，所以每个值只有一处 */
function renderForm() {
  const s = extractState || {};
  byId("userIdInput").value = s.userId || "";
  byId("tokenField").value = s.accessToken || "";
  byId("cookieField").value = s.cookie || "";
  byId("checkinPath").value = s.checkinPath || "";
  byId("authKind").value = s.accessToken ? "token" : "cookie";
  syncBoxes();

  byId("tokenSource").textContent = s.accessToken
    ? (s.accessTokenSource || "已验证可用")
    : (s.accessTokenNote || "读取后自动填入");
  if (s.testDetail) setStatus("formStatus", "凭证验证通过 —— 真能用");
}

byId("loadBtn").addEventListener("click", loadSite);

// 手改之后同步回 state，测试与保存用的是改后的值
byId("userIdInput").addEventListener("change", () => {
  if (extractState) extractState.userId = byId("userIdInput").value.trim();
});
byId("tokenField").addEventListener("change", () => {
  if (extractState) extractState.accessToken = byId("tokenField").value.trim();
});
byId("cookieField").addEventListener("change", () => {
  if (extractState) extractState.cookie = byId("cookieField").value.trim();
});
byId("checkinPath").addEventListener("change", () => {
  if (extractState) extractState.checkinPath = byId("checkinPath").value.trim();
});

byId("authKind").addEventListener("change", syncBoxes);
byId("loginType").addEventListener("change", syncBoxes);

// 密码框的眼睛：明文 / 掩码切换
byId("loginEye").addEventListener("click", () => {
  const box = byId("loginPass");
  box.type = box.type === "password" ? "text" : "password";
});

syncBoxes();
setTurnstile("unknown", "点「测试签到」会顺带判断");

// 打开面板就自动读当前站点
initDefaultSite().then(() => {
  const site = byId("siteInput").value.trim();
  if (/^https?:\/\//.test(site) && !isGithubHost(site)) loadSite();
});
