/* popup.js —— 面板骨架：通用状态行、复制、默认站点、折叠区跳转 */

"use strict";

function byId(id) { return document.getElementById(id); }

/** 状态行：bad=true 红色，空串清空 */
function setStatus(id, message, bad) {
  const box = byId(id);
  if (!box) return;
  box.textContent = message || "";
  box.classList.toggle("bad", !!bad);
  box.classList.toggle("ok", !bad && !!message);
}

/** 复制到剪贴板，按钮短暂显示结果 */
async function copyText(text, button) {
  const original = button.textContent;
  let done = false;
  try {
    await navigator.clipboard.writeText(text);
    done = true;
  } catch (e) { /* iframe 里 Permissions-Policy 会拦 Clipboard API，走兜底 */ }
  if (!done) {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.cssText = "position:fixed;top:-999px;left:-999px;opacity:0;";
      document.body.appendChild(area);
      area.select();
      done = document.execCommand("copy");
      area.remove();
    } catch (e) { done = false; }
  }
  button.textContent = done ? "已复制" : "复制失败";
  setTimeout(() => { button.textContent = original; }, 1500);
}

/** GitHub 不是 API 站：面板会在派发页上呼出，别把它的 origin 当站点（否则会去读 GitHub 的 cookie） */
function isGithubHost(site) {
  try { return /(^|\.)github\.com$/i.test(new URL(site).hostname); }
  catch (e) { return false; }
}

/** 默认站点取当前活动标签页的 origin（在站点页上点扩展 → 不用手填） */
async function initDefaultSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      const origin = new URL(tab.url).origin;
      if (isGithubHost(origin)) return;   // 留空，等用户自己填
      byId("siteInput").value = origin;
    }
  } catch (e) { /* 当前页不是 http(s)，让用户自己填 */ }
}

/** 深链：content.js 的 iframe 带 ?tab=sites / ?tab=cron 时直接展开对应的折叠区 */
function switchTab(name) {
  if (name !== "sites" && name !== "cron") return;
  const fold = byId(name === "sites" ? "foldSites" : "foldCron");
  if (!fold) return;
  fold.open = true;
  if (name === "sites" && typeof refreshStoredInfo === "function") refreshStoredInfo();
  fold.scrollIntoView({ block: "start" });
}

// 通用复制按钮：data-target 指向要复制的输入框 / 文本域
document.querySelectorAll("button.copy[data-target]").forEach((button) => {
  button.addEventListener("click", () => copyText(byId(button.dataset.target).value, button));
});

switchTab(new URLSearchParams(location.search).get("tab"));

// 焦点在 iframe 内时，外层收不到 keydown —— Esc 在这里转发给外层收起面板
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && window.parent !== window) {
    window.parent.postMessage({ type: "acsx-close" }, "*");
  }
});

// 版本号直接读 manifest，免得每次发版都漏改这里
try { byId("coreVersion").textContent = "扩展 v" + chrome.runtime.getManifest().version; }
catch (e) { byId("coreVersion").textContent = ""; }
