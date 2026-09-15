/* panel-sites.js —— 「SITES JSON」面板：
   已填入栏目（账号数组，可单条删除 / 清空）← 行格式追加 ← 生成（来源可选：已填入 / 行格式） */

"use strict";

const ACCOUNTS_KEY = "apiCheckin.accounts";
const LEGACY_SITES_KEY = "apiCheckin.sites";

const FORMATS = [
  { value: "sites", name: "SITES 值（粘输入框）", hint: "直接粘进 GitHub 派发页的 SITES 输入框。" },
  { value: "gh", name: "gh 命令", hint: "整行复制到终端执行（零转义）。" },
  { value: "body", name: "HTTP body（curl / cron-job.org）", hint: "自己拼请求体用；SITES 是字符串要先序列化。" },
  { value: "pretty", name: "格式化预览（只看结构）", hint: "缩进版只用于检查结构，别直接粘出去。" },
];

function maskSecret(secret) {
  const s = String(secret || "");
  return s.length <= 14 ? s.slice(0, 4) + "…" : s.slice(0, 10) + "…" + s.slice(-4);
}

/** 旧版存的是 sites JSON —— 第一次读到就迁移成账号数组 */
async function getStoredAccounts() {
  const data = await chrome.storage.local.get([ACCOUNTS_KEY, LEGACY_SITES_KEY]);
  if (Array.isArray(data[ACCOUNTS_KEY])) return data[ACCOUNTS_KEY];
  const legacy = data[LEGACY_SITES_KEY];
  if (legacy && Object.keys(legacy).length) {
    const accounts = flattenSites(legacy);
    await chrome.storage.local.set({ [ACCOUNTS_KEY]: accounts });
    await chrome.storage.local.remove(LEGACY_SITES_KEY);
    return accounts;
  }
  return [];
}

async function setStoredAccounts(list) {
  await chrome.storage.local.set({ [ACCOUNTS_KEY]: list || [] });
  renderStoredList();
  updateSitesPanel();
}

/** 去重口径：站点 + 类型 + 凭证值都相同才算同一条 */
function sameAccount(a, b) {
  return a.site === b.site && a.kind === b.kind && a.secret === b.secret;
}

/** 追加（去重），返回 { added, dup, total } */
async function appendAccounts(incoming) {
  const stored = await getStoredAccounts();
  let added = 0;
  (incoming || []).forEach((acc) => {
    if (!stored.some((x) => sameAccount(x, acc))) { stored.push(acc); added++; }
  });
  await setStoredAccounts(stored);
  return { added: added, dup: (incoming || []).length - added, total: stored.length };
}

/** 旧版 {站点:{桶:[凭证对象]}} → 账号数组 */
function flattenSites(sites) {
  const accounts = [];
  Object.keys(sites || {}).forEach((site) => {
    Object.keys(sites[site] || {}).forEach((bucket) => {
      (sites[site][bucket] || []).forEach((entry) => {
        accounts.push({
          site: site,
          label: entry.label || "",
          kind: bucket === "tokens" ? "token" : "cookie",
          secret: entry.cookie || entry.token || "",
          userId: entry.user_id || "",
        });
      });
    });
  });
  return accounts;
}

/** 已填入栏目：每条一行，可单条删除 */
function renderStoredList() {
  getStoredAccounts().then((accounts) => {
    byId("storedCount").textContent = accounts.length ? "（" + accounts.length + " 条）" : "（空）";
    const list = byId("storedList");
    list.textContent = "";
    if (!accounts.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "还没有账号 —— 从「提取账号」面板填入，或在下面粘贴行格式追加";
      list.appendChild(empty);
      return;
    }
    accounts.forEach((acc, i) => {
      const item = document.createElement("div");
      item.className = "stored-item";

      const meta = document.createElement("div");
      meta.className = "meta";
      const site = document.createElement("div");
      site.className = "site";
      site.textContent = acc.site + (acc.label ? " · " + acc.label : "");
      const secret = document.createElement("div");
      secret.className = "secret";
      secret.textContent = maskSecret(acc.secret);
      meta.appendChild(site);
      meta.appendChild(secret);

      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = acc.kind + (acc.userId ? "=" + acc.userId : "");

      const del = document.createElement("button");
      del.type = "button";
      del.className = "del";
      del.textContent = "删除";
      del.addEventListener("click", async () => {
        const cur = await getStoredAccounts();
        cur.splice(i, 1);
        await setStoredAccounts(cur);
      });

      item.appendChild(meta);
      item.appendChild(tag);
      item.appendChild(del);
      list.appendChild(item);
    });
  });
}

function refreshStoredInfo() { renderStoredList(); }   // popup.js 的 switchTab 调这个

/** 生成来源：已填入栏目 / 上面的行格式 */
function currentSites() {
  if (byId("sourceSelect").value === "lines") {
    const parsed = parseLines(byId("linesInput").value);
    if (parsed.errors.length) return Promise.resolve({ errors: parsed.errors });
    return Promise.resolve({ sites: buildSites(parsed.accounts) });
  }
  return getStoredAccounts().then((accounts) => ({ sites: buildSites(accounts) }));
}

async function updateSitesPanel() {
  const format = byId("formatSelect").value;
  const ref = byId("refInput").value.trim() || DEFAULT_REF;

  byId("refRow").hidden = !(format === "gh" || format === "body");
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

async function appendFromLines() {
  const parsed = parseLines(byId("linesInput").value);
  if (parsed.errors.length) {
    setStatus("appendResult", parsed.errors.join("；"), true);
    return;
  }
  const res = await appendAccounts(parsed.accounts);
  byId("linesInput").value = "";
  setStatus("appendResult", "✅ 追加 " + res.added + " 条" + (res.dup ? "，跳过重复 " + res.dup + " 条" : "") + "，共 " + res.total + " 条");
}

byId("formatSelect").innerHTML = FORMATS.map((f) => '<option value="' + f.value + '">' + f.name + "</option>").join("");
byId("appendBtn").addEventListener("click", appendFromLines);
byId("linesInput").addEventListener("input", updateSitesPanel);
byId("sourceSelect").addEventListener("change", updateSitesPanel);
byId("formatSelect").addEventListener("change", updateSitesPanel);
byId("refInput").addEventListener("input", updateSitesPanel);
byId("copyBtn").addEventListener("click", () => copyText(byId("preview").value, byId("copyBtn")));
byId("clearStoredBtn").addEventListener("click", async () => {
  await setStoredAccounts([]);
  setStatus("appendResult", "已清空已填入的账号");
});
renderStoredList();
updateSitesPanel();