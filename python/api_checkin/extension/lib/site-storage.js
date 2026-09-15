/* site-storage.js —— 注进站点标签页读它的 localStorage（拿缓存的 user.id）。
   扩展上下文访问不到页面自己的 localStorage，必须用 chrome.scripting 注入。 */

"use strict";

async function readSiteLocalStorage(site) {
  try {
    const [tab] = await chrome.tabs.query({ url: site.replace(/\/+$/, "") + "/*" });
    if (!tab || tab.id === undefined) return null;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          const raw = window.localStorage.getItem("user");
          if (!raw) return null;
          const user = JSON.parse(raw);
          return user && user.id ? { id: String(user.id), name: String(user.username || "") } : null;
        } catch (e) { return null; }
      },
    });
    return (result && result.result) || null;
  } catch (e) {
    return null;
  }
}
