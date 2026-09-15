/* panel-sites.js —— 「SITES JSON」面板：行格式 → 输出；内容存 chrome.storage（弹窗关了也在） */

"use strict";

const SITES_STORE_KEY = "apiCheckin.sites";

const FORMATS = [
  { value: "sites", name: "SITES 值（粘输入框）", hint: "直接粘进 GitHub 派发页的 SITES 输入框。" },
  { value: "gh", name: "gh 命令", hint: "整行复制到终端执行（零转义）。" },
  { value: "body", name: "HTTP body（curl / cron-job.org）", hint: "自己拼请求体用；SITES 是字符串要先序列化。" },
  { value: "pretty", name: "格式化预览（只看结构）", hint: "缩进版只用于检查结构，别直接粘出去。" },
];

async function getStoredSites() {
  const data = await chrome.storage.local.get(SITES_STORE_KEY);
  return data[SITES_STORE_KEY] || {};
}

async function setStoredSites(sites) {
  await chrome.storage.local.set({ [SITES_STORE_KEY]: sites || {} });
  refreshStoredInfo();
  updateSitesPanel();
}

function refreshStoredInfo() {
  getStoredSites().then((sites) => {
    const count = countAccounts(sites);
    byId("storedInfo").textContent = count
      ? "已存：" + count + " 个账号（" + Object.keys(sites).length + " 个站点）"
      : "已存：空";
  });
}

/** 当前应输出的 SITES：输入框有内容用输入的（追加模式会先并入已存），否则用已存的 */
async function currentSites() {
  const raw = byId("linesInput").value;
  if (raw.trim()) {
    const parsed = parseLines(raw);
    if (parsed.errors.length) return { errors: parsed.errors };
    const mode = document.querySelector('input[name="writeMode"]:checked').value;
    const built = buildSites(parsed.accounts);
    if (mode === "append") return { sites: mergeSites(await getStoredSites(), built) };
    return { sites: built };
  }
  const stored = await getStoredSites();
  return { sites: countAccounts(stored) ? stored : {} };
}

async function updateSitesPanel() {
  const format = byId("formatSelect").value;
  const ref = byId("refInput").value.trim() || DEFAULT_REF;

  const needRef = format === "gh" || format === "body";
  byId("refLabel").hidden = !needRef;
  byId("refInput").hidden = !needRef;
  const chosen = FORMATS.find((f) => f.value === format);
  byId("formatHint").textContent = chosen ? chosen.hint : "";

  const current = await currentSites();
  const preview = byId("preview");
  const copyBtn = byId("copyBtn");
  const fillBtn = byId("fillGithubBtn");

  if (current.errors) {
    preview.value = "";
    copyBtn.disabled = true;
    fillBtn.disabled = true;
    setStatus("fillResult", current.errors.join("；"), true);
    return;
  }

  const count = countAccounts(current.sites);
  preview.value = count ? render(current.sites, format, ref) : "";
  copyBtn.disabled = !count;
  fillBtn.disabled = !count;
  setStatus("fillResult", count ? count + " 个账号 · " + (chosen ? chosen.name : "") : "", false);
}

byId("formatSelect").innerHTML = FORMATS.map((f) => '<option value="' + f.value + '">' + f.name + "</option>").join("");
byId("linesInput").addEventListener("input", updateSitesPanel);
byId("formatSelect").addEventListener("change", updateSitesPanel);
byId("refInput").addEventListener("input", updateSitesPanel);
document.querySelectorAll('input[name="writeMode"]').forEach((radio) => {
  radio.addEventListener("change", updateSitesPanel);
});
byId("copyBtn").addEventListener("click", () => copyText(byId("preview").value, byId("copyBtn")));
byId("clearStoredBtn").addEventListener("click", async () => {
  await chrome.storage.local.remove(SITES_STORE_KEY);
  refreshStoredInfo();
  updateSitesPanel();
});
refreshStoredInfo();
updateSitesPanel();
