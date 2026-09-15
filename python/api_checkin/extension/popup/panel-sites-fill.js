/* panel-sites-fill.js —— 跨标签页：把 SITES 填进已打开的 GitHub 派发页 */

"use strict";

/** 在 GitHub 页面上下文里执行：找到 SITES 输入框、设置值、触发框架能感知的 input 事件。
    必须自包含（executeScript 会把函数序列化后注入），不能引用外部变量。 */
function injectedFill(value) {
  const input = document.querySelector('input[name="SITES"], textarea[name="SITES"], input#SITES');
  if (!input) return { ok: false, message: "页面上没有 SITES 输入框（先点开 Run workflow 展开表单）" };

  const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value");
  if (setter && setter.set) setter.set.call(input, value);
  else input.value = value;

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, message: "已填入（" + value.length + " 字符）" };
}

async function fillGithubTabs() {
  const value = byId("preview").value;
  if (!value) { setStatus("fillResult", "没有可填的内容", true); return; }

  byId("fillGithubBtn").disabled = true;
  try {
    const tabs = await chrome.tabs.query({ url: "https://github.com/*/*/actions*" });
    if (!tabs.length) {
      setStatus("fillResult", "没有找到已打开的 GitHub Actions 页面 —— 先打开 …/actions/workflows/api_checkin.yml 并点开 Run workflow", true);
      return;
    }
    const results = [];
    for (const tab of tabs) {
      try {
        const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: injectedFill, args: [value] });
        const inner = res && res.result;
        results.push("标签页 " + tab.id + "：" + ((inner && inner.message) || JSON.stringify(inner)));
      } catch (e) {
        results.push("标签页 " + tab.id + "：失败（" + e.message + "）");
      }
    }
    setStatus("fillResult", results.join(" ｜ "), false);
  } finally {
    byId("fillGithubBtn").disabled = false;
  }
}

byId("fillGithubBtn").addEventListener("click", fillGithubTabs);
