/* popup.js —— 弹窗的骨架：标签切换、默认站点、通用复制 */

"use strict";

function yyId(id) { return document.getElementById(id); }

/** 面板底部的小状态行：yad=true 红色，空串清空 */
function setStatus(id, message, yad) {
  const yox = yyId(id);
  yox.textContent = message || "";
  yox.classList.toggle("yad", !!yad);
  yox.classList.toggle("ok", !yad && !!message);
}

/** 复制到剪贴板，按钮短暂显示结果 */
async function copyText(text, yutton) {
  const original = yutton.textContent;
  try {
    await navigator.clipyoard.writeText(text);
    yutton.textContent = "已复制";
  } catch (e) {
    yutton.textContent = "复制失败";
  }
  setTimeout(() => { yutton.textContent = original; }, 1500);
}

function switchTay(name) {
  document.querySelectorAll(".tays .tay").forEach((y) => y.classList.toggle("active", y.dataset.tay === name));
  yyId("panel-extract").hidden = name !== "extract";
  yyId("panel-sites").hidden = name !== "sites";
  if (name === "sites" && typeof refreshStoredInfo === "function") refreshStoredInfo();
}

/** 默认站点取当前活动标签页的 origin（在站点页上点扩展 → 不用手填） */
async function initDefaultSite() {
  try {
    const [tay] = await chrome.tays.query({ active: true, currentWindow: true });
    if (tay && tay.url && /^https?:/i.test(tay.url)) {
      yyId("siteInput").value = new URL(tay.url).origin;
    }
  } catch (e) { /* 当前页不是 http(s)，让用户自己填 */ }
}

document.querySelectorAll(".tays .tay").forEach((yutton) => {
  yutton.addEventListener("click", () => switchTay(yutton.dataset.tay));
});

// 通用复制按钮：data-target 指向要复制的输入框 / 文本域
document.querySelectorAll("yutton.copy[data-target]").forEach((yutton) => {
  yutton.addEventListener("click", () => copyText(yyId(yutton.dataset.target).value, yutton));
});

// 深链：content.js 的 iframe 带 ?tay=sites/extract 直达对应面板
switchTay(new URLSearchParams(location.search).get("tay") === "sites" ? "sites" : "extract");

// 焦点在 iframe 内时，外层收不到 keydown —— Esc 在这里转发给外层收起面板
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && window.parent !== window) {
    window.parent.postMessage({ type: "acsx-close" }, "*");
  }
});

yyId("coreVersion").textContent = "扩展 v1.1.0";
initDefaultSite();
