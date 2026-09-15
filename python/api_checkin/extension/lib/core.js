/* ═══════════════════════════════════════════════════════════════════════
   core.js —— 转换核心（popup 与 background 共用，也可以单独抽出来测）

   校验口径与 python/api_checkin/index.py 的 parse_sites() 一致：
   4 段、站点必须带 http(s)://（大小写敏感）、类型只能 cookie / token、
   凭证非空、空行与 # 注释跳过。改动格式请同步 index.py。
   ═══════════════════════════════════════════════════════════════════════ */

const SITES_FIELDS = 4;
const AUTH_COOKIE = "cookie";
const AUTH_TOKEN = "token";
const VALID_KINDS = [AUTH_COOKIE, AUTH_TOKEN];
const DEFAULT_REF = "main";
const WORKFLOW = "api_checkin.yml";
const FORMAT_HINT = "<站点地址>|<账号标签>|<cookie 或 token[=用户ID]>|<凭证>";

/* 记事本另存为「UTF-8 带 BOM」时 BOM 会粘在第一行开头，让站点地址校验失败 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 解析多行账号表 → { accounts, errors }；errors 非空时 accounts 不可用 */
function parseLines(raw) {
  const accounts = [];
  const errors = [];

  stripBom(raw).split(/\r\n|\r|\n/).forEach((rawLine, i) => {
    const lineno = i + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;

    // 等价于 Python 的 line.split("|", 3)：只切前 3 个 |，剩下的都算凭证
    const seg = line.split("|");
    if (seg.length < SITES_FIELDS) {
      errors.push("第 " + lineno + " 行只有 " + seg.length + " 段，需要 " + SITES_FIELDS + " 段：" + FORMAT_HINT);
      return;
    }
    const parts = [seg[0], seg[1], seg[2], seg.slice(3).join("|")];

    const site = parts[0].trim();
    const label = parts[1].trim();
    const kindField = parts[2].trim();
    const secret = parts[3].trim();

    if (!site) { errors.push("第 " + lineno + " 行：站点地址为空"); return; }
    if (!/^https?:\/\//.test(site)) {
      // index.py 用的是 re.match(r"^https?://")，同样大小写敏感
      const tail = /^https?:\/\//i.test(site) ? "（协议部分要小写）" : "";
      errors.push("第 " + lineno + " 行：站点地址必须以 http:// 或 https:// 开头，当前是 '" + site + "'" + tail);
      return;
    }

    // 类型段允许带一个可选参数：`token=42` 表示令牌 + 用户 ID 42
    const eq = kindField.indexOf("=");
    const kind = (eq === -1 ? kindField : kindField.slice(0, eq)).trim().toLowerCase();
    const userId = eq === -1 ? "" : kindField.slice(eq + 1).trim();

    if (VALID_KINDS.indexOf(kind) === -1) {
      errors.push("第 " + lineno + " 行：认证类型只能是 " + VALID_KINDS.join(" / ") + "，当前是 '" + kind + "'");
      return;
    }
    if (!secret) { errors.push("第 " + lineno + " 行：凭证为空"); return; }

    accounts.push({
      site: site.replace(/\/+$/, ""),   // 同 index.py：去掉结尾的 /
      label: label,
      kind: kind,
      secret: secret,
      userId: userId,
    });
  });

  if (!errors.length && !accounts.length) {
    errors.push("没解析出任何账号（内容是空的？还是全是空行 / 注释行？）");
  }
  return { accounts: accounts, errors: errors };
}

/** 账号 → 行格式（parseLines 的逆运算） */
function toLines(accounts) {
  return accounts.map((a) => {
    return a.site + "|" + a.label + "|" + a.kind + (a.userId ? "=" + a.userId : "") + "|" + a.secret;
  }).join("\n");
}

/** 折叠成 {站点: {桶: [凭证对象]}}；站点与桶都按首次出现排列 */
function buildSites(accounts) {
  const sites = {};
  accounts.forEach((account) => {
    if (!sites[account.site]) sites[account.site] = {};
    const buckets = sites[account.site];

    // 字段名与桶名一致：cookies 里写 cookie、tokens 里写 token
    const entry = {};
    entry[account.kind] = account.secret;
    if (account.userId) entry.user_id = account.userId;
    if (account.label) entry.label = account.label;

    const bucket = account.kind + "s";
    if (!buckets[bucket]) buckets[bucket] = [];
    buckets[bucket].push(entry);
  });
  return sites;
}

/**
 * 追加模式：把 incoming 并进 existing。
 * 按站点合并、同站点同桶里**按凭证值去重**（同一份凭证不会出现两次）。
 * 不改入参，返回新对象 —— existing 的内容排前面，incoming 排后面。
 */
function mergeSites(existing, incoming) {
  const merged = {};
  [existing, incoming].forEach((source) => {
    Object.keys(source || {}).forEach((site) => {
      if (!merged[site]) merged[site] = {};
      const buckets = source[site] || {};
      Object.keys(buckets).forEach((bucket) => {
        if (!merged[site][bucket]) merged[site][bucket] = [];
        (buckets[bucket] || []).forEach((entry) => {
          const secret = entry[AUTH_COOKIE] || entry[AUTH_TOKEN] || "";
          const dup = merged[site][bucket].some((other) => {
            return (other[AUTH_COOKIE] || other[AUTH_TOKEN] || "") === secret;
          });
          if (!dup) merged[site][bucket].push(entry);
        });
      });
    });
  });
  return merged;
}

/** 按选定形式渲染输出（JSON.stringify 默认紧凑单行、不转义非 ASCII） */
function render(sites, format, ref) {
  const sitesJson = JSON.stringify(sites);
  const branch = ref || DEFAULT_REF;

  if (format === "sites") return sitesJson;
  if (format === "pretty") return JSON.stringify(sites, null, 2);
  if (format === "body") {
    // SITES 的 input 类型是字符串，所以整段 JSON 要先序列化再嵌进 body
    return JSON.stringify({ ref: branch, inputs: { SITES: sitesJson } });
  }
  if (format === "gh") {
    if (sitesJson.indexOf("'") !== -1) {
      return "# 值里含单引号，不能写成 -f SITES='...'；先存成文件再传：\n"
        + 'gh workflow run ' + WORKFLOW + ' --ref ' + branch
        + ' -f SITES="$(cat sites.json)"';
    }
    const refFlag = branch === DEFAULT_REF ? "" : " --ref " + branch;
    return "gh workflow run " + WORKFLOW + refFlag + " -f SITES='" + sitesJson + "'";
  }
  return "";
}

/** 令牌值是不是「掩码」（形如 sk-abc1********WXYZ）。列表接口可能只给掩码，那种值必然 401 */
function looksMasked(key) {
  return String(key || "").indexOf("*") !== -1;
}

/** 把 user 对象里所有「名字带 token 的字符串字段」捞出来当候选（字段名各版本不一，不猜） */
function tokenCandidates(user) {
  const found = [];
  if (!user || typeof user !== "object") return found;

  Object.keys(user).forEach((key) => {
    if (!/token/i.test(key)) return;
    const value = user[key];
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length < 8) return;
    if (!found.some((item) => item.value === trimmed)) found.push({ key: key, value: trimmed });
  });
  return found;
}

  /** 统计 {站点: {桶: [...]}} 里的账号总数 */
  function countAccounts(sites) {
    let count = 0;
    Object.keys(sites || {}).forEach((site) => {
      Object.keys(sites[site] || {}).forEach((bucket) => {
        count += (sites[site][bucket] || []).length;
      });
    });
    return count;
  }
