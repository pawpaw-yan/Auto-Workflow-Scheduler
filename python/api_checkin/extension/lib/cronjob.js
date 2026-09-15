/* cronjob.js —— 把签到任务一键绑到 cron-job.org。

   API 契约照 https://docs.cron-job.org/rest-api.html ：
     GET   /jobs          列任务（返回 { jobs: [...] }）
     PUT   /jobs          建任务（返回 { jobId }，只有 url 必填）
     PATCH /jobs/<jobId>  改任务
   认证是 `Authorization: Bearer <API key>`；请求头与请求体放在 job.extendedData 里；
   requestMethod 1 = POST；schedule 用 { hours, minutes, mdays, months, wdays }，
   其中 -1 表示「每」。

   它只跟 cron-job.org 与 GitHub 两家通信 —— 站点凭证都在派发的 body 里，
   由 cron-job.org 原样转发给 GitHub，扩展不会把它们发给任何第三方。 */

"use strict";

const CRONJOB_API = "https://api.cron-job.org";
const CRONJOB_TITLE = "api_checkin 每日签到";

async function cronjobRequest(method, path, apiKey, body) {
  const res = await fetch(CRONJOB_API + path, {
    method: method,
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { data = null; }
  if (!res.ok) {
    throw new Error("HTTP " + res.status + " " + ((data && data.message) || text.slice(0, 120)));
  }
  return data || {};
}

async function listCronJobs(apiKey) {
  const data = await cronjobRequest("GET", "/jobs", apiKey);
  return (data && data.jobs) || [];
}

/** 建或更新：已经存在同名任务就 PATCH（不重复建），否则 PUT。返回 { jobId, action } */
async function upsertCronJob(apiKey, job) {
  const jobs = await listCronJobs(apiKey);
  const existing = jobs.filter((j) => j.title === job.title)[0];
  if (existing) {
    await cronjobRequest("PATCH", "/jobs/" + existing.jobId, apiKey, { job: job });
    return { jobId: existing.jobId, action: "updated" };
  }
  const data = await cronjobRequest("PUT", "/jobs", apiKey, { job: job });
  return { jobId: data && data.jobId, action: "created" };
}

/** 构造任务体：定时 POST GitHub 的 workflow_dispatch，SITES 作为字符串放进 inputs */
function buildCronJob(repo, pat, ref, sitesJson, hour, minute, timezone) {
  const hh = Number.isFinite(hour) ? Math.min(23, Math.max(0, hour)) : 9;
  const mm = Number.isFinite(minute) ? Math.min(59, Math.max(0, minute)) : 0;
  return {
    title: CRONJOB_TITLE,
    url: "https://api.github.com/repos/" + repo + "/actions/workflows/api_checkin.yml/dispatches",
    enabled: true,
    saveResponses: true,
    requestMethod: 1,   // 1 = POST
    schedule: {
      timezone: timezone || "UTC",
      expiresAt: 0,
      hours: [hh],
      mdays: [-1],
      minutes: [mm],
      months: [-1],
      wdays: [-1],
    },
    extendedData: {
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        Authorization: "Bearer " + pat,
        "User-Agent": "api_checkin-extension",
      },
      body: JSON.stringify({ ref: ref || "main", inputs: { SITES: sitesJson } }),
    },
  };
}
