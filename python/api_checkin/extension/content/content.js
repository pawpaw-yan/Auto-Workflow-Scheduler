/* content.js —— 往页面里注入「账号小助手」：可拖动的呼出按钮 + 二级菜单 + 弹出面板。
   面板本体是扩展自己的 popup.html（web_accessible_resources 允许内嵌）——
   扩展页面即使在 iframe 里也拥有 chrome.cookies / chrome.tabs 等完整权限，
   所以提取 / 验证 / 跨标签页填写的逻辑一行都不用为页面上下文重写。 */

"use strict";

(function () {
  if (window.top !== window) return;                 // 只在顶层框架注入
  if (document.getElementById("acsx-launcher")) return;

  const POS_KEY = "acsLauncherPos";
  let menu = null;
  let panel = null;
  let backdrop = null;

  function savedPos() {
    try { return JSON.parse(localStorage.getItem(POS_KEY) || "null"); }
    catch (e) { return null; }
  }

  /* ── 呼出按钮：默认右上角，可拖动，位置记在 localStorage ── */
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "acsx-launcher";
  btn.className = "acsx-launcher";
  btn.textContent = "账号小助手";

  const pos = savedPos();
  if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
    btn.style.left = pos.x + "px";
    btn.style.top = pos.y + "px";
    btn.style.right = "auto";
  } // 否则吃 CSS 默认位置（右上角）

  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let baseY = 0;

  btn.addEventListener("pointerdown", (e) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const rect = btn.getBoundingClientRect();
    baseX = rect.left;
    baseY = rect.top;
    btn.setPointerCapture(e.pointerId);
  });

  btn.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;   // 几乎没动不算拖
    moved = true;
    const x = Math.min(Math.max(0, baseX + dx), window.innerWidth - btn.offsetWidth);
    const y = Math.min(Math.max(0, baseY + dy), window.innerHeight - btn.offsetHeight);
    btn.style.left = x + "px";
    btn.style.top = y + "px";
    btn.style.right = "auto";
    if (menu) placeMenu();   // 菜单开着时跟着按钮走
  });

  btn.addEventListener("pointerup", () => {
    dragging = false;
    if (moved) {
      try {
        localStorage.setItem(POS_KEY, JSON.stringify({
          x: parseFloat(btn.style.left),
          y: parseFloat(btn.style.top),
        }));
      } catch (err) { /* 隐私模式等，忽略 */ }
    } else {
      toggleMenu();
    }
  });

  document.documentElement.appendChild(btn);

  /* ── 二级菜单（跟随按钮位置，拖动时同步） ── */
  function placeMenu() {
    if (!menu) return;
    const rect = btn.getBoundingClientRect();
    let left = rect.right - menu.offsetWidth;
    if (left < 8) left = 8;
    menu.style.left = left + "px";
    const top = Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8);
    menu.style.top = Math.max(8, top) + "px";
  }

  function closeMenu() {
    if (menu) { menu.remove(); menu = null; }
  }

  function toggleMenu() {
    if (menu) { closeMenu(); return; }
    menu = document.createElement("div");
    menu.className = "acsx-menu";

    [["🔑 提取账号", "extract"], ["🧾 SITES JSON", "sites"]].forEach((pair) => {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = pair[0];
      item.addEventListener("click", () => {
        closeMenu();
        openPanel(pair[1]);
      });
      menu.appendChild(item);
    });

    document.documentElement.appendChild(menu);
    placeMenu();
  }

  /* ── 面板：居中卡片 + 遮罩，内容是扩展自己的 popup.html ── */
  function closePanel() {
    if (panel) { panel.remove(); panel = null; }
    if (backdrop) { backdrop.remove(); backdrop = null; }
  }

  function openPanel(tab) {
    closePanel();

    backdrop = document.createElement("div");
    backdrop.className = "acsx-backdrop";
    backdrop.addEventListener("click", closePanel);

    panel = document.createElement("div");
    panel.className = "acsx-panel";

    const head = document.createElement("div");
    head.className = "acsx-head";
    const title = document.createElement("strong");
    title.textContent = "账号小助手";
    const x = document.createElement("button");
    x.type = "button";
    x.className = "acsx-x";
    x.textContent = "×";
    x.title = "关闭（Esc）";
    x.addEventListener("click", closePanel);
    head.appendChild(title);
    head.appendChild(x);

    const frame = document.createElement("iframe");
    frame.className = "acsx-frame";
    frame.src = chrome.runtime.getURL("popup/popup.html") + "?tab=" + tab;

    panel.appendChild(head);
    panel.appendChild(frame);
    document.documentElement.appendChild(backdrop);
    document.documentElement.appendChild(panel);
  }

  /* ── 全局关闭：Esc / 点外面 ── */
  document.addEventListener("click", (e) => {
    if (menu && !menu.contains(e.target) && e.target !== btn) closeMenu();
  }, true);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closePanel(); closeMenu(); }
  }, true);

  // iframe 里按 Esc 时 popup.js 会 postMessage 出来（焦点在 iframe 内时收不到本页的 keydown）
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "acsx-close") closePanel();
  });
})();
