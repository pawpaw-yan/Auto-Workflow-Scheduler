// ==UserScript==
// @name         api_checkin 助手（行格式 ↔ JSON + 账号提取）
// @namespace    https://github.com/pawpaw-yan/Auto-Workflow-Scheduler
// @version      1.0.0
// @description  GitHub 派发页：把「一行一个账号」的行格式转成 SITES JSON 并一键填入输入框。new-api / one-api 站点：一键提取 cookie / 用户 ID / 访问令牌，没有可用令牌就调接口新建一个。
// @match        https://github.com/*/*/actions*
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @run-at       document-idle
//
// ─────────────────────────────────────────────────────────────────────────
// 配套：python/api_checkin/index.py 的 SITES 格式。
// 校验口径与 index.py 的 parse_sites() 一致（4 段、站点必须带 http(s):// 且
// 大小写敏感、类型只能 cookie / token、凭证非空、空行与 # 跳过），
// 所以这里不报错 = api_checkin 跑得起来。改动格式请同步 index.py。
//
// ⚠️ `@match *://*/*` 是为了能在你自己的 new-api 站点上跑。要更安静就把这行
//    换成你的站点域名，例如 `// @match https://example.com/*`。
//    脚本在普通页面上**什么都不做**（先看便宜的信号，再探一次 /api/status），
//    也可以从篡改猴菜单里手动唤起。
// ─────────────────────────────────────────────────────────────────────────
// ==/UserScript==

(function () {
  "use strict";

  /* ═══════════════════════════════════════════════════════════════════════
     1. 转换核心 —— 不碰 DOM，可单独抽出来测（见 ==CORE-BEGIN/END==）
     ═══════════════════════════════════════════════════════════════════════ */

  /* ==CORE-BEGIN== */
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

  /** 账号 → 行格式（parseLines 的逆运算，用于回填和复制） */
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
  /* ==CORE-END== */

  /* ═══════════════════════════════════════════════════════════════════════
     2. 通用：样式、toast、面板外壳、剪贴板
     ═══════════════════════════════════════════════════════════════════════ */

  const CSS = `
    .acs-panel, .acs-panel * { box-sizing: border-box; }

    /* 遮罩：压暗页面 + 毛玻璃，把注意力收到卡片上 */
    .acs-backdrop {
      position: fixed; inset: 0; z-index: 2147482998;
      background: rgba(12, 15, 20, .30);
      -webkit-backdrop-filter: blur(7px) saturate(140%);
      backdrop-filter: blur(7px) saturate(140%);
    }

    /* 卡片：页面正中间，半透明 + 毛玻璃 */
    .acs-panel {
      position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
      z-index: 2147482999;
      width: min(640px, calc(100vw - 32px)); max-height: 85vh; overflow: auto;
      background: var(--acs-card); color: var(--acs-fg);
      -webkit-backdrop-filter: blur(20px) saturate(170%);
      backdrop-filter: blur(20px) saturate(170%);
      border: 1px solid var(--acs-bd); border-radius: 16px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .38);
      font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      padding: 0;
    }
    .acs-panel, .acs-panel input, .acs-panel textarea, .acs-panel button, .acs-panel select {
      font-family: inherit;
    }
    .acs-head {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 12px 16px; border-bottom: 1px solid var(--acs-bd); position: sticky; top: 0;
      background: var(--acs-cardhead); border-radius: 16px 16px 0 0;
      -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
    }
    .acs-panel ::-webkit-scrollbar { width: 10px; height: 10px; }
    .acs-panel ::-webkit-scrollbar-thumb {
      background: var(--acs-bd); border-radius: 6px;
    }

    /* 轻提示：不挡视线，同样毛玻璃 */
    .acs-toast {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: auto; max-width: 460px; padding: 10px 14px; border-radius: 12px;
      background: var(--acs-card); color: var(--acs-fg);
      -webkit-backdrop-filter: blur(16px) saturate(160%);
      backdrop-filter: blur(16px) saturate(160%);
      border: 1px solid var(--acs-bd);
      box-shadow: 0 10px 30px rgba(0, 0, 0, .30);
      font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .acs-head strong { font-size: 13.5px; }
    .acs-body { padding: 12px 14px 14px; }
    .acs-x {
      border: 0; background: transparent; color: var(--acs-mut); cursor: pointer;
      font-size: 18px; line-height: 1; padding: 0 4px;
    }
    .acs-x:hover { color: var(--acs-fg); }
    .acs-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 9px; }
    .acs-row > label { color: var(--acs-mut); min-width: 62px; }
    .acs-kv { color: var(--acs-mut); }
    .acs-kv b { color: var(--acs-fg); font-weight: 600; }
    .acs-panel textarea, .acs-panel input[type="text"], .acs-panel select {
      width: 100%; background: var(--acs-in); color: var(--acs-fg);
      border: 1px solid var(--acs-bd); border-radius: 8px; padding: 7px 9px;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12.5px;
    }
    .acs-panel textarea { white-space: pre; overflow: auto; resize: vertical; tab-size: 2; }
    .acs-panel textarea:focus, .acs-panel input:focus, .acs-panel select:focus {
      outline: 2px solid var(--acs-acc); outline-offset: -1px;
    }
    .acs-panel button {
      background: var(--acs-bg); color: var(--acs-fg); border: 1px solid var(--acs-bd);
      border-radius: 8px; padding: 6px 11px; cursor: pointer; font-size: 12.5px;
    }
    .acs-panel button:hover { border-color: var(--acs-acc); color: var(--acs-acc); }
    .acs-panel button.acs-primary { background: var(--acs-acc); border-color: var(--acs-acc); color: #fff; }
    .acs-panel button.acs-primary:hover { opacity: .88; color: #fff; }
    .acs-panel button:disabled { opacity: .5; cursor: default; }
    .acs-status { margin-top: 8px; font-size: 12.5px; }
    .acs-status.ok { color: var(--acs-ok); }
    .acs-status.err {
      color: var(--acs-err); background: var(--acs-errbg); border-radius: 8px;
      padding: 8px 10px; white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px;
    }
    .acs-hint { margin: 6px 0 0; color: var(--acs-mut); font-size: 12px; }
    .acs-hint code { background: var(--acs-in); border-radius: 4px; padding: 1px 5px; }
    .acs-inline-btn {
      margin-top: 6px; background: var(--acs-acc) !important; color: #fff !important;
      border: 1px solid var(--acs-acc) !important; border-radius: 8px; padding: 5px 11px;
      font-size: 12.5px; cursor: pointer;
    }
    .acs-launcher {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      background: var(--acs-acc); color: #fff; border: 0; border-radius: 999px;
      padding: 9px 15px; cursor: pointer; font-size: 13px;
      box-shadow: 0 8px 24px rgba(0,0,0,.26);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .acs-flash { outline: 3px solid var(--acs-acc) !important; outline-offset: 1px; }
  `;

  function injectCss() {
    if (typeof GM_addStyle === "function") { GM_addStyle(CSS); return; }
    const style = document.createElement("style");
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  /** 面板自带配色：不继承宿主的 CSS 变量，免得被站点样式带跑 */
  function palette(panel) {
    const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    // 卡片 / 输入框都带透明度 —— 毛玻璃得有东西透出来才像玻璃
    panel.style.setProperty("--acs-card", dark ? "rgba(23, 27, 35, .82)" : "rgba(255, 255, 255, .84)");
    panel.style.setProperty("--acs-cardhead", dark ? "rgba(23, 27, 35, .74)" : "rgba(255, 255, 255, .74)");
    panel.style.setProperty("--acs-fg", dark ? "#e8ebf0" : "#1d2330");
    panel.style.setProperty("--acs-bd", dark ? "rgba(255,255,255,.16)" : "rgba(15,23,42,.14)");
    panel.style.setProperty("--acs-mut", dark ? "#9aa4b4" : "#5f6672");
    panel.style.setProperty("--acs-in", dark ? "rgba(8, 11, 16, .55)" : "rgba(255, 255, 255, .78)");
    panel.style.setProperty("--acs-acc", dark ? "#6ea8fe" : "#2563eb");
    panel.style.setProperty("--acs-ok", dark ? "#34d399" : "#047857");
    panel.style.setProperty("--acs-err", dark ? "#f99090" : "#c02626");
    panel.style.setProperty("--acs-errbg", dark ? "rgba(120, 30, 34, .55)" : "rgba(253, 236, 236, .9)");
  }

  /* 用 createElement 拼 DOM，绝不把站点的用户名 / 令牌塞进 innerHTML */
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach((key) => {
      if (key === "class") node.className = attrs[key];
      else if (key === "text") node.textContent = attrs[key];
      else if (key.indexOf("on") === 0) node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach((child) => node.appendChild(child));
    return node;
  }

  function toast(message, bad) {
    const box = el("div", { class: "acs-toast", text: message });
    palette(box);
    if (bad) {
      box.style.color = "var(--acs-err)";
      box.style.maxWidth = "560px";
      box.style.whiteSpace = "pre-wrap";
    }
    document.body.appendChild(box);
    setTimeout(() => box.remove(), bad ? 8000 : 2600);
  }

  function copyText(text) {
    return new Promise((resolve) => {
      if (typeof GM_setClipboard === "function") {
        try { GM_setClipboard(text, "text"); resolve(true); return; } catch (e) { /* 落下面 */ }
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => resolve(true), () => resolve(false));
        return;
      }
      resolve(false);
    });
  }

  let openPanel = null;
  let openBackdrop = null;

  /** 共用的居中卡片外壳（遮罩 + 毛玻璃），返回 { panel, body, close } */
  function makePanel(title) {
    if (openPanel) openPanel.remove();
    if (openBackdrop) openBackdrop.remove();

    const body = el("div", { class: "acs-body" });
    const backdrop = el("div", { class: "acs-backdrop" });
    const panel = el("div", { class: "acs-panel", role: "dialog", "aria-modal": "true" }, [
      el("div", { class: "acs-head" }, [
        el("strong", { text: title }),
        el("button", { class: "acs-x", text: "×", title: "关闭（Esc）", onclick: () => close() }),
      ]),
      body,
    ]);
    palette(panel);

    function close() {
      panel.remove();
      backdrop.remove();
      document.removeEventListener("keydown", onKey, true);
      if (openPanel === panel) openPanel = null;
      if (openBackdrop === backdrop) openBackdrop = null;
    }

    function onKey(event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }

    // 别让宿主页面的「点击外部就关」逻辑把下拉 / 表单收走
    ["click", "mousedown", "pointerdown", "keydown"].forEach((type) => {
      panel.addEventListener(type, (event) => event.stopPropagation());
      backdrop.addEventListener(type, (event) => event.stopPropagation());
    });
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);

    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    openPanel = panel;
    openBackdrop = backdrop;
    return { panel: panel, body: body, close: close };
  }

  function statusLine(parent, text, cls) {
    const node = el("div", { class: "acs-status " + (cls || ""), text: text });
    parent.appendChild(node);
    return node;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     3. GitHub 派发页：行格式 → SITES JSON，一键填入
     ═══════════════════════════════════════════════════════════════════════ */

  const IS_GITHUB_ACTIONS =
    location.hostname === "github.com" && /\/actions(\/|$)/.test(location.pathname);

  /** 找到派发表单里名为 SITES 的输入框（input 或 textarea 都认） */
  function findSiteInputs() {
    return Array.prototype.slice.call(
      document.querySelectorAll('input[name="SITES"], textarea[name="SITES"]')
    );
  }

  function fillInput(input, value) {
    input.focus();
    input.value = value;
    // GitHub 的表单是普通 HTML 表单，但为保险起见把事件也发一遍
    ["input", "change"].forEach((type) => {
      input.dispatchEvent(new Event(type, { bubbles: true }));
    });
    input.scrollIntoView({ block: "center", behavior: "smooth" });
    input.classList.add("acs-flash");
    setTimeout(() => input.classList.remove("acs-flash"), 1600);
  }

  function openConverter(targetInput) {
    const ui = makePanel("行格式 → SITES JSON");
    const body = ui.body;

    const inputArea = el("textarea", { rows: "7", spellcheck: "false", placeholder: FORMAT_HINT });
    const errorBox = el("div", { class: "acs-status" });
    const preview = el("textarea", {
      rows: "4", readonly: "readonly", spellcheck: "false", placeholder: "上面一旦有内容，这里实时显示结果",
    });
    const fillBtn = el("button", { class: "acs-primary", text: "填入 SITES 输入框", disabled: "disabled" });
    const copyBtn = el("button", { text: "复制 JSON", disabled: "disabled" });

    let currentJson = "";

    function update() {
      const parsed = parseLines(inputArea.value);

      if (parsed.errors.length) {
        currentJson = "";
        errorBox.className = "acs-status err";
        errorBox.textContent = parsed.errors.join("\n");
        preview.value = "";
      } else {
        const sites = buildSites(parsed.accounts);
        currentJson = render(sites, "sites", "main");
        preview.value = currentJson;

        const cookies = parsed.accounts.filter((a) => a.kind === "cookie").length;
        errorBox.className = "acs-status ok";
        errorBox.textContent = Object.keys(sites).length + " 个站点 / " + parsed.accounts.length
          + " 个账号（cookie " + cookies + "，token " + (parsed.accounts.length - cookies) + "）";
      }

      const ok = Boolean(currentJson);
      fillBtn.disabled = !ok;
      copyBtn.disabled = !ok;
    }

    inputArea.addEventListener("input", update);
    fillBtn.addEventListener("click", () => {
      if (!currentJson) return;
      fillInput(targetInput, currentJson);
      ui.close();   // 遮罩挡着表单，填完就收起来让人看得见
      toast("已填入 SITES，接着点 GitHub 自己的 Run workflow 就行");
    });
    copyBtn.addEventListener("click", () => {
      copyText(currentJson).then((ok) => {
        if (!ok) { toast("复制失败，请手动全选复制", true); return; }
        toast("JSON 已复制");
      });
    });

    body.appendChild(el("div", { class: "acs-row" }, [inputArea]));
    body.appendChild(errorBox);
    body.appendChild(el("p", { class: "acs-hint", text: "每行 4 段；空行与 # 开头的行会跳过；凭证放最后一段，所以凭证里带 | 也不会被切断。" }));
    body.appendChild(el("div", { class: "acs-row", style: "margin:10px 0 6px" }, [
      el("label", { text: "生成的 JSON" }),
    ]));
    body.appendChild(preview);
    body.appendChild(el("div", { class: "acs-row", style: "margin-top:10px" }, [fillBtn, copyBtn]));

    update();
    inputArea.focus();
  }

  function hookGithub() {
    if (!IS_GITHUB_ACTIONS) return;

    const scan = () => {
      findSiteInputs().forEach((input) => {
        if (input.dataset.acsHooked) return;
        input.dataset.acsHooked = "1";

        const btn = el("button", { class: "acs-inline-btn", text: "⇄ 行格式转换", type: "button" });
        btn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openConverter(input);
        });
        input.insertAdjacentElement("afterend", btn);
      });
    };

    scan();
    // 「Run workflow」下拉里的表单可能是后渲染出来的
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     4. new-api / one-api 站点：提取 cookie / 用户 ID / 令牌
     ═══════════════════════════════════════════════════════════════════════ */

  /* new-api 的 UserAuth 中间件**强制要求** New-Api-User 头 —— 会话认证也一样，
     缺了直接回 401「无权进行此操作，未提供 New-Api-User」。
     站点前端自己也是从 localStorage 的 user 里读出 id 拼上去的，这里照做。 */
  let currentUserId = "";

  function userIdFromLocalStorage() {
    try {
      const raw = window.localStorage.getItem("user");
      if (raw) {
        const user = JSON.parse(raw);
        if (user && user.id) return String(user.id);
      }
    } catch (e) { /* 隐私模式 / 值不是 JSON，忽略 */ }
    return "";
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = Object.assign(
      { Accept: "application/json" },
      currentUserId ? { "New-Api-User": currentUserId } : {},
      opts.headers || {}
    );
    const response = await fetch(path, {
      method: opts.method || "GET",
      credentials: opts.omitCookie ? "omit" : "same-origin",
      headers: headers,
      body: opts.body,
    });

    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = null; }

    if (!response.ok) {
      throw new Error("HTTP " + response.status + " " + (text || "").slice(0, 120));
    }
    if (data === null) {
      throw new Error("响应不是 JSON：" + (text || "").slice(0, 120));
    }
    return data;
  }

  /** new-api / one-api 的 /api/status 是免鉴权的，用它确认「这就是那种站点」 */
  async function probeNewApi() {
    try {
      const data = await api("/api/status");
      if (data && data.success === true && data.data && typeof data.data === "object") {
        return data.data;
      }
    } catch (e) { /* 不是目标站点，静默 */ }
    return null;
  }

  /** 便宜信号：标题或 localStorage 像 new-api / one-api。过了才去发那一次探测请求 */
  function cheapSignal() {
    if (/new\s*-?\s*api|one\s*-?\s*api/i.test(document.title || "")) return true;
    try {
      const raw = window.localStorage.getItem("user");
      if (raw) {
        const user = JSON.parse(raw);
        if (user && (user.id || user.username)) return true;
      }
    } catch (e) { /* 隐私模式等，忽略 */ }
    return false;
  }

  function tokenKeyOf(token) {
    const raw = token.key || token.token || token.value || "";
    if (!raw) return "";
    return String(raw).indexOf("sk-") === 0 ? String(raw) : "sk-" + raw;
  }

  function listOfTokens(data) {
    if (!data) return [];
    if (Array.isArray(data.data)) return data.data;              // 老 one-api
    if (data.data && Array.isArray(data.data.items)) return data.data.items;  // 新 new-api
    return [];
  }

  /** 从站点侧收集：站点、账号、cookie、令牌列表。userId 用于 localStorage 读不到时手动兜底 */
  async function collect(userId) {
    const result = {
      origin: location.origin,
      status: null,
      me: null,
      tokens: [],
      cookie: document.cookie || "",
      sessionVisible: false,
      errors: [],
    };

    result.status = await probeNewApi();
    if (!result.status) throw new Error("这个站点看起来不是 new-api / one-api（/api/status 不符合预期）");

    // New-Api-User 是硬要求，必须在任何鉴权请求之前定下来
    currentUserId = String(userId || "").trim() || userIdFromLocalStorage();
    if (!currentUserId) {
      throw new Error(
        "读不到用户 ID：localStorage 里没有 user.id，而 new-api 的接口强制要求 New-Api-User 头。\n"
        + "先确认已登录站点；还不行就把下面「用户 ID」手填进去再点「重试」。"
      );
    }

    const me = await api("/api/user/self");
    if (!me || me.success !== true || !me.data) {
      throw new Error(
        "读 /api/user/self 失败（可能没登录，或用户 ID 不对）：" + JSON.stringify(me).slice(0, 160)
      );
    }
    result.me = me.data;
    if (result.me.id) currentUserId = String(result.me.id);   // 以服务端返回的为准

    try {
      const listed = await api("/api/token/?p=0&size=100");
      result.tokens = listOfTokens(listed).filter((token) => token && (token.key || token.token || token.value));
    } catch (e) {
      result.errors.push("读令牌列表失败（" + e.message + "），可以点「新建令牌」试一个");
    }

    // document.cookie 读不到 httpOnly 的会话 cookie —— 这时只能让用户从 F12 复制
    result.sessionVisible = /(^|;\s*)(session|new-api-session)=/.test(result.cookie);
    return result;
  }

  /** 用令牌自己发一次请求验证可用性：credentials=omit，避免被会话 cookie「救活」造成假阳性 */
  async function verifyToken(key, userId) {
    try {
      const data = await api("/api/user/self", {
        omitCookie: true,
        headers: { Authorization: "Bearer " + key, "New-Api-User": String(userId) },
      });
      return Boolean(data && data.success === true);
    } catch (e) {
      return false;
    }
  }

  async function createToken(name, userId) {
    // 形态对齐 one-api / new-api 的 AddToken：永不过期 + 不限额
    const body = JSON.stringify({
      name: name,
      remain_quota: 0,
      expired_time: -1,
      unlimited_quota: true,
      model_limits_enabled: false,
      model_limits: "",
      allow_ips: "",
      group: "",
    });
    const data = await api("/api/token/", {
      method: "POST",
      headers: { "Content-Type": "application/json", "New-Api-User": String(userId) },
      body: body,
    });
    if (!data || data.success !== true) {
      throw new Error((data && data.message) ? data.message : "创建失败（响应里没有 success）");
    }
  }

  function openExtractor() {
    const ui = makePanel("api_checkin：提取账号");
    const body = ui.body;

    const info = el("div", { class: "acs-kv" });
    const errorBox = el("div", { class: "acs-status" });
    const idInput = el("input", { type: "text", spellcheck: "false", placeholder: "用户 ID" });
    idInput.style.maxWidth = "150px";
    idInput.value = userIdFromLocalStorage();
    const retryBtn = el("button", { text: "重试" });
    const tokenSelect = el("select");
    const createBtn = el("button", { text: "＋ 新建令牌" });
    const useCookie = el("input", { type: "radio", name: "acs-mode", value: "cookie" });
    const useToken = el("input", { type: "radio", name: "acs-mode", value: "token", checked: "checked" });
    const outLine = el("textarea", { rows: "3", readonly: "readonly", spellcheck: "false" });
    const outJson = el("textarea", { rows: "3", readonly: "readonly", spellcheck: "false" });
    const copyLine = el("button", { class: "acs-primary", text: "复制行格式" });
    const copyJson = el("button", { text: "复制 SITES JSON" });

    let state = null;

    function siteAccounts() {
      if (!state) return [];
      const label = (state.me && (state.me.username || state.me.display_name)) || location.hostname;
      const token = siteAccounts.picked;
      const accounts = [];

      if (useToken.checked && token && token.key) {
        accounts.push({
          site: state.origin, label: label,
          kind: AUTH_TOKEN, secret: token.key, userId: String(state.me.id || ""),
        });
      }
      if (useCookie.checked && state.cookie) {
        accounts.push({ site: state.origin, label: label, kind: AUTH_COOKIE, secret: state.cookie, userId: "" });
      }
      return accounts;
    }

    function refreshOutput() {
      const accounts = siteAccounts();
      if (!accounts.length) {
        outLine.value = "";
        outJson.value = "";
        return;
      }
      outLine.value = toLines(accounts);
      outJson.value = render(buildSites(accounts), "sites", "main");
    }

    function renderTokenOptions() {
      tokenSelect.textContent = "";
      if (!state.tokens.length) {
        tokenSelect.appendChild(el("option", { value: "", text: "（没有令牌）" }));
        return;
      }
      state.tokens.forEach((token, i) => {
        const name = token.name || ("#" + (token.id || i + 1));
        const off = token.status !== 1 ? "（已禁用）" : "";
        tokenSelect.appendChild(el("option", { value: String(i), text: name + off + "  " + tokenKeyOf(token).slice(0, 14) + "…" }));
      });
      tokenSelect.value = "0";
    }

    async function pickToken() {
      if (!state || !state.tokens.length) return;
      const index = Number(tokenSelect.value || 0);
      const token = state.tokens[index];
      if (!token) return;

      token.key = tokenKeyOf(token);
      siteAccounts.picked = token;

      const ok = await verifyToken(token.key, state.me.id);
      const line = ok ? "✅ 令牌已验证可用" : "⚠️ 令牌验证没通过（可能被禁用或站点不认这个前缀）";
      info.querySelector("[data-acs-token-verify]").textContent = line;
      refreshOutput();
    }

    function renderInfo(message) {
      info.textContent = "";
      if (!state) {
        info.appendChild(el("div", { text: message || "" }));
        return;
      }
      const me = state.me || {};
      const rows = [
        ["站点", state.origin],
        ["账号", "#" + (me.id || "?") + " " + (me.username || me.display_name || "")],
        ["版本", (state.status && (state.status.version || state.status.system_name)) || "?"],
        ["会话", "✅ 有效（已用 /api/user/self 验证）"],
        ["Cookie", state.sessionVisible
          ? "✅ JS 读到了会话 cookie"
          : "⚠️ JS 读不到会话 cookie（httpOnly）—— 要用 cookie 认证请按 F12 → Network 复制 Cookie 头"],
      ];
      rows.forEach((row) => {
        info.appendChild(el("div", { class: "acs-kv" }, [
          el("b", { text: row[0] + "　" }),
          el("span", { text: String(row[1]) }),
        ]));
      });
      info.appendChild(el("div", { class: "acs-kv" }, [
        el("b", { text: "令牌　" }),
        el("span", { "data-acs-token-verify": "1", text: "选取后自动验证" }),
      ]));
      if (state.errors.length) {
        state.errors.forEach((message2) => info.appendChild(el("div", { text: "⚠️ " + message2 })));
      }
    }

    async function load() {
      errorBox.className = "acs-status";
      errorBox.textContent = "正在读取…";
      try {
        state = await collect(idInput.value);
        renderInfo();
        renderTokenOptions();
        errorBox.className = "acs-status ok";
        errorBox.textContent = state.tokens.length
          ? "读到 " + state.tokens.length + " 个令牌"
          : "这个账号还没有令牌，点「＋ 新建令牌」建一个";
        await pickToken();
      } catch (e) {
        state = null;
        renderInfo();
        errorBox.className = "acs-status err";
        errorBox.textContent = e.message;
      }
    }

    createBtn.addEventListener("click", async () => {
      if (!state) return;
      createBtn.disabled = true;
      errorBox.className = "acs-status";
      errorBox.textContent = "正在创建…";
      try {
        const name = "api_checkin " + new Date().toISOString().slice(0, 10);
        await createToken(name, state.me.id);
        const listed = await api("/api/token/?p=0&size=100");
        state.tokens = listOfTokens(listed).filter((token) => token && (token.key || token.token || token.value));
        renderTokenOptions();
        // 刚建的排最后，直接选中它
        tokenSelect.value = String(Math.max(0, state.tokens.length - 1));
        await pickToken();
        errorBox.className = "acs-status ok";
        errorBox.textContent = "已新建令牌：" + name;
      } catch (e) {
        errorBox.className = "acs-status err";
        errorBox.textContent = "新建失败：" + e.message;
      } finally {
        createBtn.disabled = false;
      }
    });

    tokenSelect.addEventListener("change", pickToken);
    retryBtn.addEventListener("click", load);
    [useToken, useCookie].forEach((radio) => radio.addEventListener("change", refreshOutput));

    copyLine.addEventListener("click", () => {
      copyText(outLine.value).then((ok) => toast(ok ? "行格式已复制" : "复制失败，请手动复制", !ok));
    });
    copyJson.addEventListener("click", () => {
      copyText(outJson.value).then((ok) => toast(ok ? "SITES JSON 已复制" : "复制失败，请手动复制", !ok));
    });

    body.appendChild(info);
    body.appendChild(errorBox);
    // new-api 强制要 New-Api-User，自动读不到时这里是唯一的兜底
    body.appendChild(el("div", { class: "acs-row" }, [
      el("label", { text: "用户 ID" }), idInput, retryBtn,
    ]));
    body.appendChild(el("div", { class: "acs-row" }, [
      el("label", { text: "令牌" }), tokenSelect, createBtn,
    ]));
    body.appendChild(el("div", { class: "acs-row" }, [
      el("label", { text: "凭证来源" }),
      el("label", {}, [useToken, el("span", { text: " 令牌（推荐，不过期）" })]),
      el("label", {}, [useCookie, el("span", { text: " Cookie" })]),
    ]));
    body.appendChild(el("div", { class: "acs-row", style: "margin:10px 0 6px" }, [el("label", { text: "行格式" })]));
    body.appendChild(outLine);
    body.appendChild(el("div", { class: "acs-row", style: "margin:8px 0 6px" }, [el("label", { text: "SITES JSON" })]));
    body.appendChild(outJson);
    body.appendChild(el("div", { class: "acs-row", style: "margin-top:10px" }, [copyLine, copyJson]));
    body.appendChild(el("p", { class: "acs-hint", text: "全部在本机浏览器里完成；账号表只会进剪贴板，不会发往任何第三方。" }));

    load();
  }

  function injectLauncher() {
    if (document.getElementById("acs-launcher")) return;
    const btn = el("button", { class: "acs-launcher", id: "acs-launcher", text: "🍪 提取账号", type: "button" });
    palette(btn);
    btn.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); openExtractor(); });
    document.body.appendChild(btn);
  }

  async function bootSite(force) {
    if (!force && !cheapSignal()) return;
    const status = await probeNewApi();
    if (!status) {
      if (force) toast("这个站点看起来不是 new-api / one-api", true);
      return;
    }
    injectLauncher();
    if (force) openExtractor();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     5. 启动
     ═══════════════════════════════════════════════════════════════════════ */

  injectCss();
  hookGithub();

  if (typeof GM_registerMenuCommand === "function") {
    GM_registerMenuCommand("在当前站点提取 cookie / 令牌 / 用户ID", () => bootSite(true));
  }

  if (!IS_GITHUB_ACTIONS) bootSite(false);
})();
