/* popup.js —— 弹窗的骨架：标签切换、默认站点、通用复制 */

"use strict";

function byId(id) { return document.getElementById(id); }

/** 面板底部的小状态行：bad=true 红色，空串清空 */
function setStatus(id, message, bad) {
  const box = byId(id);
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

function switchTab(name) {
  document.querySelectorAll(".tabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  byId("panel-extract").hidden = name !== "extract";
  byId("panel-sites").hidden = name !== "sites";
  if (name === "sites" && typeof refreshStoredInfo === "function") refreshStoredInfo();
}

/** 默认站点取当前活动标签页的 origin（在站点页上点扩展 → 不用手填） */
async function initDefaultSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      byId("siteInput").value = new URL(tab.url).origin;
    }
  } catch (e) { /* 当前页不是 http(s)，让用户自己填 */ }
}

document.querySelectorAll(".tabs .tab").forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tab));
});

// 通用复制按钮：data-target 指向要复制的输入框 / 文本域
document.querySelectorAll("button.copy[data-target]").forEach((button) => {
  button.addEventListener("click", () => copyText(byId(button.dataset.target).value, button));
});

// 深链：content.js 的 iframe 带 ?tab=sites/extract 直达对应面板
switchTab(new URLSearchParams(location.search).get("tab") === "sites" ? "sites" : "extract");

// 焦点在 iframe 内时，外层收不到 keydown —— Esc 在这里转发给外层收起面板
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && window.parent !== window) {
    window.parent.postMessage({ type: "acsx-close" }, "*");
  }
});

byId("coreVersion").textContent = "扩展 v1.3.0";