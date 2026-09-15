/* panel-cron.js —— 「定时任务」面板：把已填入的 SITES 一键绑成 cron-job.org 的定时任务。
   填的 API key 与 GitHub PAT 存在本机 chrome.storage.local，只发往 cron-job.org 与 GitHub。 */

"use strict";

const CRON_CFG_KEY = "apiCheckin.cron";

async function loadCronCfg() {
  const data = await chrome.storage.local.get(CRON_CFG_KEY);
  const cfg = data[CRON_CFG_KEY] || {};
  byId("cronKey").value = cfg.key || "";
  byId("cronRepo").value = cfg.repo || "";
  byId("cronPat").value = cfg.pat || "";
  byId("cronHour").value = String(cfg.hour == null ? 9 : cfg.hour);
  byId("cronMinute").value = String(cfg.minute == null ? 0 : cfg.minute);
  byId("cronTz").value = cfg.timezone || "Asia/Shanghai";
}

function saveCronCfg() {
  return chrome.storage.local.set({
    [CRON_CFG_KEY]: {
      key: byId("cronKey").value.trim(),
      repo: byId("cronRepo").value.trim(),
      pat: byId("cronPat").value.trim(),
      hour: parseInt(byId("cronHour").value, 10),
      minute: parseInt(byId("cronMinute").value, 10),
      timezone: byId("cronTz").value.trim() || "UTC",
    },
  });
}

function cronTimeText() {
  const hh = String(byId("cronHour").value).padStart(2, "0");
  const mm = String(byId("cronMinute").value).padStart(2, "0");
  return hh + ":" + mm + " " + (byId("cronTz").value.trim() || "UTC");
}

/** 建 / 更新定时任务：已存在同名任务就更新，不会重复建 */
async function bindCronJob() {
  const apiKey = byId("cronKey").value.trim();
  const repo = byId("cronRepo").value.trim();
  const pat = byId("cronPat").value.trim();
  if (!apiKey) { setStatus("cronResult", "先填 cron-job.org 的 API key（控制台 → Settings 生成）", true); return; }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) { setStatus("cronResult", "仓库要写成 owner/repo", true); return; }
  if (!pat) { setStatus("cronResult", "先填 GitHub PAT（要能派发 workflow：Actions 写权限）", true); return; }

  const current = await currentSites();
  if (current.errors) { setStatus("cronResult", current.errors.join("；"), true); return; }
  const count = countAccounts(current.sites);
  if (!count) { setStatus("cronResult", "还没有账号 —— 先去「提取签到信息」把站点填进 SITES", true); return; }

  await saveCronCfg();
  setStatus("cronResult", "正在创建 / 更新定时任务…");
  try {
    const job = buildCronJob(
      repo,
      pat,
      byId("refInput").value.trim() || DEFAULT_REF,
      render(current.sites, "sites"),
      parseInt(byId("cronHour").value, 10),
      parseInt(byId("cronMinute").value, 10),
      byId("cronTz").value.trim()
    );
    const r = await upsertCronJob(apiKey, job);
    setStatus(
      "cronResult",
      "✅ 已" + (r.action === "created" ? "创建" : "更新") + "任务 #" + r.jobId
        + "（" + count + " 个账号，每天 " + cronTimeText() + " 触发）"
    );
  } catch (e) {
    setStatus("cronResult", "❌ 失败：" + e.message, true);
  }
}

/** 列出账号里已有的任务 —— 用来确认「到底建上没有 / 建重了没有」 */
async function showCronJobs() {
  const apiKey = byId("cronKey").value.trim();
  if (!apiKey) { setStatus("cronResult", "先填 cron-job.org 的 API key", true); return; }
  setStatus("cronResult", "正在读取任务列表…");
  try {
    const jobs = await listCronJobs(apiKey);
    if (!jobs.length) { setStatus("cronResult", "该账号下还没有任何任务"); return; }
    const lines = jobs.map((j) => "#" + j.jobId + " " + (j.title || "(无标题)")
      + (j.enabled ? "" : "（已停用）") + " → " + (j.url || ""));
    setStatus("cronResult", "共 " + jobs.length + " 个任务：\n" + lines.join("\n"));
  } catch (e) {
    setStatus("cronResult", "❌ 读取失败：" + e.message, true);
  }
}

byId("cronBtn").addEventListener("click", bindCronJob);
byId("cronListBtn").addEventListener("click", showCronJobs);
["cronKey", "cronRepo", "cronPat", "cronHour", "cronMinute", "cronTz"].forEach((id) => {
  byId(id).addEventListener("change", saveCronCfg);
});
loadCronCfg();
