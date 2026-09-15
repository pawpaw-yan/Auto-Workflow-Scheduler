// ==UserScript==
// @name         api_checkin 助手（行格式 ↔ JSON + 账号提取）
// @namespace    https://github.com/pawpaw-yan/Auto-Workflow-Scheduler
// @version      1.1.0
// @description  GitHub 派发页：把「一行一个账号」的行格式转成 SITES JSON 并一键填入输入框。new-api / one-api 站点：一键提取 cookie / 用户 ID / 访问令牌，没有可用令牌就调接口新建一个。
// @match        https://github.com/*/*/actions*
// @match        *://*/*
// @grant        GM_setClipboard
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
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
    /* 小助手：默认贴右上角，可拖动，位置记在 localStorage */
    .acs-launcher {
      position: fixed; right: 16px; top: 16px; z-index: 2147483000;
      background: var(--acs-acc); color: #fff; border: 0; border-radius: 999px;
      padding: 9px 15px; cursor: grab; font-size: 13px;
      box-shadow: 0 8px 24px rgba(0,0,0,.26);
      user-select: none; touch-action: none; white-space: nowrap;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .acs-launcher:active { cursor: grabbing; }

    /* 二级菜单：毛玻璃小面板 */
    .acs-menu {
      position: fixed; z-index: 2147483001; min-width: 168px; padding: 6px;
      background: var(--acs-card); color: var(--acs-fg);
      -webkit-backdrop-filter: blur(18px) saturate(160%);
      backdrop-filter: blur(18px) saturate(160%);
      border: 1px solid var(--acs-bd); border-radius: 12px;
      box-shadow: 0 14px 40px rgba(0, 0, 0, .34);
      font: 13px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .acs-menu button {
      display: block; width: 100%; text-align: left; background: transparent;
      border: 0; border-radius: 8px; padding: 8px 10px; color: var(--acs-fg);
      cursor: pointer; font-size: 13px;
    }
    .acs-menu button:hover { background: var(--acs-in); color: var(--acs-acc); }
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

  // 输出形式。cron-job.org 要的是**带转义的完整体**，Actions 输入框要的是**不转义的值** ——
  // 复制错地方就会报错，所以做成下拉，并把「给谁用」写在界面上。
  const CONVERT_FORMATS = [
    {
      id: "sites",
      label: "SITES 值（不转义）",
      hint: "粘 Actions 页面的 SITES 输入框 —— 或者直接用下面的「填入」按钮",
    },
    {
      id: "body",
      label: "HTTP body（带转义）",
      hint: "cron-job.org / curl 的 Request body：外层 ref + inputs，SITES 的值是**转义过的字符串**",
    },
    {
      id: "gh",
      label: "gh 命令（零转义）",
      hint: "整行复制到终端即可执行，不用手写任何转义；走总入口就换成 run-project.yml 再加 -f project=",
    },
    {
      id: "pretty",
      label: "格式化预览",
      hint: "缩进版，**只看结构**，不要直接粘出去（粘到 cron-job 会 400）",
    },
  ];

  function openConverter(targetInput, initialLines) {
    const ui = makePanel(initialLines ? "行格式 → 派发内容（已从站点侧带入）" : "行格式 → 派发内容");
    const body = ui.body;

    const inputArea = el("textarea", { rows: "7", spellcheck: "false", placeholder: FORMAT_HINT });
    if (initialLines) inputArea.value = initialLines;

    const errorBox = el("div", { class: "acs-status" });
    const formatSelect = el("select");
    CONVERT_FORMATS.forEach((item) => {
      formatSelect.appendChild(el("option", { value: item.id, text: item.label }));
    });
    const refLabel = el("label", { text: "ref" });
    const refInput = el("input", { type: "text", value: DEFAULT_REF, spellcheck: "false" });
    refInput.style.maxWidth = "120px";
    const formatHint = el("p", { class: "acs-hint" });

    const preview = el("textarea", {
      rows: "5", readonly: "readonly", spellcheck: "false", placeholder: "上面一旦有内容，这里实时显示结果",
    });
    const fillBtn = el("button", { class: "acs-primary", text: "填入 SITES 输入框", disabled: "disabled" });
    const copyBtn = el("button", { text: "复制", disabled: "disabled" });

    let currentText = "";

    function currentFormat() {
      const hit = CONVERT_FORMATS.filter((item) => item.id === formatSelect.value)[0];
      return hit || CONVERT_FORMATS[0];
    }

    function update() {
      const format = currentFormat();
      formatHint.textContent = format.hint;

      // 「填入」只在输出是**裸 SITES 值**时才有意义 —— 别把 HTTP body 填进那个框
      const fillable = format.id === "sites" && Boolean(targetInput);
      const needsRef = format.id === "body" || format.id === "gh";
      refLabel.style.display = needsRef ? "" : "none";
      refInput.style.display = needsRef ? "" : "none";

      const parsed = parseLines(inputArea.value);

      if (parsed.errors.length) {
        currentText = "";
        errorBox.className = "acs-status err";
        errorBox.textContent = parsed.errors.join("\n");
        preview.value = "";
      } else {
        const sites = buildSites(parsed.accounts);
        currentText = render(sites, format.id, refInput.value.trim() || DEFAULT_REF);
        preview.value = currentText;

        const cookies = parsed.accounts.filter((a) => a.kind === "cookie").length;
        let summary = Object.keys(sites).length + " 个站点 / " + parsed.accounts.length
          + " 个账号（cookie " + cookies + "，token " + (parsed.accounts.length - cookies) + "）";

        // 同一站点同时挂 cookie 和 token = 两个账号、各跑一次；同一个号别两种都配
        const bothKinds = Object.keys(sites).filter((site) => sites[site].cookies && sites[site].tokens);
        if (bothKinds.length) {
          summary += "　⚠️ " + bothKinds.join("、") + " 同时配了 cookie 和 token —— 会当成两个账号各跑一次";
        }

        errorBox.className = "acs-status ok";
        errorBox.textContent = summary;
      }

      fillBtn.style.display = fillable ? "" : "none";
      fillBtn.disabled = !fillable || !currentText;
      copyBtn.disabled = !currentText;
    }

    inputArea.addEventListener("input", update);
    formatSelect.addEventListener("change", () => {
      update();
      preview.scrollTop = 0;
    });
    refInput.addEventListener("input", update);

    fillBtn.addEventListener("click", () => {
      if (!currentText) return;
      fillInput(targetInput, currentText);
      ui.close();   // 遮罩挡着表单，填完就收起来让人看得见
      toast("已填入 SITES，接着点 GitHub 自己的 Run workflow 就行");
    });
    copyBtn.addEventListener("click", () => {
      const label = currentFormat().label;
      copyText(currentText).then((ok) => {
        toast(ok ? label + " 已复制" : "复制失败，请手动全选复制", !ok);
      });
    });

    body.appendChild(el("div", { class: "acs-row" }, [inputArea]));
    body.appendChild(errorBox);
    body.appendChild(el("p", { class: "acs-hint", text: "每行 4 段；空行与 # 开头的行会跳过；凭证放最后一段，所以凭证里带 | 也不会被切断。" }));
    body.appendChild(el("div", { class: "acs-row", style: "margin:10px 0 6px" }, [
      el("label", { text: "输出形式" }), formatSelect, refLabel, refInput,
    ]));
    body.appendChild(formatHint);
    body.appendChild(el("div", { class: "acs-row", style: "margin:10px 0 6px" }, [el("b", { text: "生成结果" })]));
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

  function userFromLocalStorage() {
    try {
      const raw = window.localStorage.getItem("user");
      if (raw) {
        const user = JSON.parse(raw);
        if (user && typeof user === "object") return user;
      }
    } catch (e) { /* 隐私模式 / 值不是 JSON，忽略 */ }
    return null;
  }

  function userIdFromLocalStorage() {
    const user = userFromLocalStorage();
    return (user && user.id) ? String(user.id) : "";
  }

  /**
   * 「系统访问令牌」——个人设置 → 安全设置 → 系统访问令牌 里那一串，
   * 也就是**管理接口**要的凭证（api_checkin 用的就是它）。
   *
   * ⚠️ 它和 `/api/token/` 列出的东西**不是一回事**：后者是 `sk-` 开头的 **API 密钥**，
   *    给调用模型用的，签到用不上。之前把两者搞混了。
   *
   * 站点前端会把用户对象缓存在 localStorage 的 `user` 里，access_token 就在里面；
   * `/api/user/self` 有的版本也给。两边都试。
   */
  function accessTokenFromUser(user) {
    if (!user || typeof user !== "object") return "";
    const candidates = [user.access_token, user.accessToken];
    for (let i = 0; i < candidates.length; i++) {
      if (typeof candidates[i] === "string" && candidates[i].trim()) return candidates[i].trim();
    }
    return "";
  }

  /**
   * 把 user 对象里**所有**像访问令牌的字段捞出来（字段名各版本不一：access_token /
   * accessToken / token / 甚至别的），交给调用方逐个真发请求去挑 —— 不猜字段名。
   * 太短的值（<8 字符）多半是名称、状态之类，丢掉。
   */
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

  /**
   * 尽量凑出 Cookie 请求头，并把「GM_cookie 为什么用不了」一并带回去 —— 光说「读不到」
   * 没法让人修，得说清是没声明、没开权限、还是版本不支持。
   *
   * document.cookie 拿不到 httpOnly 的会话 cookie：这是浏览器强制的，任何 JS 都读不到，
   * **换 iframe 也一样**（同源 frame 的 document.cookie 里同样没有它）。
   * 唯一出路是篡改猴的浏览器 cookie 接口。两条硬性前提：
   *
   *   1. 篡改猴设置里「安全 → 允许脚本访问 Cookie」必须是「全部」
   *   2. ⚠️ 官方文档原文：httpOnly cookies are supported at the BETA versions of
   *      Tampermonkey only for now —— **正式版读不到 httpOnly**，只能换 Beta。
   *      另外它要求脚本对目标 URL 有 @match / @include 权限（本脚本声明的是全站匹配，已满足）。
   */
  function readCookieHeader() {
    const fromDocument = {
      text: document.cookie || "",
      source: "document",
      gmState: "missing",
      gmDetail: "",
    };

    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      const failed = (state, detail) => Object.assign({}, fromDocument, { gmState: state, gmDetail: detail });

      const useCookies = (cookies) => {
        if (!cookies || !cookies.length) {
          done(failed("empty", "能调用，但这条 URL 下没返回任何 cookie"));
          return;
        }
        done({
          text: cookies.map((c) => c.name + "=" + c.value).join("; "),
          source: "GM_cookie",
          gmState: "ok",
          gmDetail: "拿到 " + cookies.length + " 条 cookie",
        });
      };

      // 新版（BETA）是 Promise 风格：GM.cookie
      if (typeof GM !== "undefined" && GM && GM.cookie && typeof GM.cookie.list === "function") {
        try {
          GM.cookie.list({ url: location.href }).then(useCookies, (err) => {
            done(failed("error", "GM.cookie.list 报错：" + String((err && err.message) || err)));
          });
          return;
        } catch (e) {
          done(failed("error", "调用 GM.cookie 抛异常：" + String((e && e.message) || e)));
          return;
        }
      }

      // 老版是回调风格：GM_cookie
      if (typeof GM_cookie === "undefined" || !GM_cookie || typeof GM_cookie.list !== "function") {
        done(failed("missing", "脚本环境里没有 GM_cookie —— 没声明 @grant，或这个篡改猴版本不支持"));
        return;
      }

      // 权限没给时回调可能永远不来，兜一个超时，免得卡片一直停在「正在读取」
      setTimeout(() => done(failed("timeout", "GM_cookie.list 3 秒内没有回调")), 3000);

      try {
        GM_cookie.list({ url: location.href }, (cookies, error) => {
          if (error) {
            done(failed("error", "GM_cookie.list 报错：" + String((error && error.message) || error)));
            return;
          }
          useCookies(cookies);
        });
      } catch (e) {
        done(failed("error", "调用 GM_cookie 抛异常：" + String((e && e.message) || e)));
      }
    });
  }

  /** GM_cookie 的状态 → 一句人话，好让人知道该去改什么 */
  function gmStateLabel(state) {
    switch (state.gmState) {
      case "ok":
        return "✅ 已启用（" + state.gmDetail + "）";
      case "missing":
        return "⛔ 没启用 —— 展开下面的「怎么开启 GM_cookie」按步骤设置一次";
      case "error":
        return "⚠️ 调用失败：" + state.gmDetail;
      case "empty":
      case "timeout":
        return "⚠️ " + state.gmDetail;
      default:
        return "—";
    }
  }

  /** 从站点侧收集：站点、账号、cookie、令牌列表。userId 用于 localStorage 读不到时手动兜底 */
  async function collect(userId) {
    const result = {
      origin: location.origin,
      status: null,
      me: null,
      cookie: "",
      cookieSource: "document",
      sessionVisible: false,
      accessToken: "",
      accessTokenSource: "",
      tokenCandidates: [],
      userFields: [],
      gmState: "missing",
      gmDetail: "",
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

    const cookie = await readCookieHeader();
    result.cookie = cookie.text;
    result.cookieSource = cookie.source;
    result.gmState = cookie.gmState;
    result.gmDetail = cookie.gmDetail;

    const me = await api("/api/user/self");
    if (!me || me.success !== true || !me.data) {
      throw new Error(
        "读 /api/user/self 失败（可能没登录，或用户 ID 不对）：" + JSON.stringify(me).slice(0, 160)
      );
    }
    result.me = me.data;
    if (result.me.id) currentUserId = String(result.me.id);   // 以服务端返回的为准

    // 「系统访问令牌」：先看 /api/user/self，再退回前端缓存的 user 对象
    const localUser = userFromLocalStorage();
    result.accessToken = accessTokenFromUser(result.me) || accessTokenFromUser(localUser);
    result.accessTokenSource = result.accessToken ? "user 对象字段" : "";
    result.userFields = Object.keys(result.me);   // 诊断用：字段名不确定时看这个

    // ⚠️ GET /api/user/token 那个兜底**不在这里**做，它排在「候选扫描」之后 ——
    // 顺序是有意的：老版本的路子能用，就绝不碰新接口。见 verifyAccess()。

    // 字段名各版本不一，所以把两边的候选都收着，由验证环节去挑真正能用的那个
    result.tokenCandidates = tokenCandidates(result.me).concat(tokenCandidates(localUser));
    result.tokenCandidates = result.tokenCandidates.filter((item, index, all) => {
      return all.findIndex((other) => other.value === item.value) === index;
    });

    result.sessionVisible = /(^|;\s*)(session|new-api-session)=/.test(result.cookie);
    return result;
  }

  /** 令牌值是不是「掩码」（形如 sk-abc1********WXYZ）。列表接口可能只给掩码，那种值必然 401 */
  function looksMasked(key) {
    return String(key || "").indexOf("*") !== -1;
  }

  /**
   * 单次验证尝试。验的是「拿着这个令牌去调 /api/user/self 会不会被接受」——
   * 这正是 api_checkin 跑起来调的第一个接口，过了就说明签到也能过。
   *
   * omitCookie=true（严格）时不带站点 cookie，能排除「被浏览器会话救活」的假阳性；
   * 代价是有些站点前面挂着 WAF（阿里云 acw_* 那套），不带 cookie 会被挑战页直接拦下。
   */
  async function tryVerify(key, userId, omitCookie) {
    const how = "发请求 GET /api/user/self（"
      + (omitCookie
        ? "仅 Authorization: Bearer <令牌>，不带 cookie"
        : "带站点 cookie —— 因为不带会被 WAF 拦下")
      + "）";

    try {
      const data = await api("/api/user/self", {
        omitCookie: omitCookie,
        headers: { Authorization: "Bearer " + key, "New-Api-User": String(userId) },
      });

      if (data && data.success === true) {
        // 把返回里的账号也带上：能证明「真的调通了，而且就是我这个号」，不只是布尔值
        const who = (data.data && (data.data.username || data.data.display_name)) || "";
        const id = (data.data && data.data.id) || "";
        return {
          ok: true,
          detail: how + " → HTTP 200、success=true"
            + (who ? "，返回账号 " + who + (id ? "（#" + id + "）" : "") : ""),
        };
      }
      return { ok: false, detail: how + " → success=false：" + JSON.stringify(data).slice(0, 140) };
    } catch (e) {
      const message = String(e.message || e);
      // 「响应不是 JSON」= 多半被 WAF / 反爬的 JS 挑战页拦了，值得带上 cookie 再试一次
      const waf = message.indexOf("不是 JSON") !== -1;
      return {
        ok: false,
        waf: waf,
        detail: how + " → " + message
          + (waf ? "　← 这是 WAF / 反爬的挑战页，不是站点接口的响应" : ""),
      };
    }
  }

  /**
   * 验证令牌：**先严格**（不带 cookie），被 WAF 拦下才退一步带上 cookie。
   * 两次的证据强度不同，所以文案里必须分开写 —— 带了 cookie 那次有可能是会话让它过的，
   * 不能当成「令牌一定没问题」。
   */
  async function verifyToken(key, userId) {
    if (looksMasked(key)) {
      return { ok: false, detail: "没发请求：值是掩码（含 *），不是完整令牌" };
    }

    const strict = await tryVerify(key, userId, true);
    if (strict.ok) return strict;
    if (!strict.waf) return strict;

    const loose = await tryVerify(key, userId, false);
    if (loose.ok) {
      return {
        ok: true,
        loose: true,
        detail: loose.detail + "。⚠️ 这次带了站点 cookie，所以不能断定是令牌让它过的；"
          + "但至少说明这个站点对带 cookie 的请求响应正常",
      };
    }
    return { ok: false, detail: strict.detail + "；带 cookie 重试也失败：" + loose.detail };
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

    // 「提取到的值」。后两个可编辑 —— 接口不给明文时，把站点 / DevTools 里复制的值粘进来即可
    const idField = el("input", { type: "text", readonly: "readonly", spellcheck: "false", placeholder: "（未取到）" });
    const accessTokenField = el("input", { type: "text", spellcheck: "false", placeholder: "（没读到，可把站点上复制的值粘进来）" });
    const cookieField = el("textarea", { rows: "2", spellcheck: "false", placeholder: "（读不到，可把 F12 → Network 里的 Cookie 头粘进来）" });

    const testTokenBtn = el("button", { text: "🔍 测试访问令牌" });
    const toSitesBtn = el("button", { class: "acs-primary", text: "→ 填进 SITES JSON" });

    let state = null;

    /** 一行「标签 + 值 + 复制」 */
    function valueRow(labelText, field) {
      field.style.flex = "1";
      field.style.minWidth = "220px";
      const copyBtn = el("button", { type: "button", text: "复制" });
      copyBtn.addEventListener("click", () => {
        if (!field.value) { toast("没有内容可复制", true); return; }
        copyText(field.value).then((ok) => toast(ok ? labelText + " 已复制" : "复制失败，请手动复制", !ok));
      });
      return el("div", { class: "acs-row" }, [el("label", { text: labelText }), field, copyBtn]);
    }

    /**
     * 这里只给**原始值**：用户 ID / 访问令牌 / Cookie。
     * 后两个一旦被手工改过（粘了从站点复制来的值），就不再用自动读取的结果覆盖。
     */
    function refreshValues() {
      idField.value = (state && state.me) ? String(state.me.id || "") : "";
      if (!accessTokenField.dataset.acsManual) accessTokenField.value = (state && state.accessToken) || "";
      if (!cookieField.dataset.acsManual) cookieField.value = (state && state.cookie) || "";
    }

    /**
     * 用「当前站点 + 提取到的值」拼一行行格式，交给 SITES JSON 那边。
     * 访问令牌优先（不过期）；没有令牌才退到 Cookie；两个都没有就返回空串。
     */
    function buildLineFromState() {
      if (!state || !state.me) return "";
      const label = state.me.username || state.me.display_name || location.hostname;

      const token = accessTokenField.value.trim();
      if (token) {
        return toLines([{
          site: state.origin,
          label: label,
          kind: AUTH_TOKEN,
          secret: token,
          userId: String(state.me.id || ""),
        }]);
      }

      const cookie = cookieField.value.trim();
      if (cookie) {
        return toLines([{ site: state.origin, label: label, kind: AUTH_COOKIE, secret: cookie, userId: "" }]);
      }
      return "";
    }

    /**
     * 验证**系统访问令牌** —— 这才是 api_checkin 要用的凭证。
     * 走 credentials:'omit'（不带会话 cookie），免得被浏览器会话「救活」造成假阳性。
     */
    async function verifyAccess() {
      const verifyCell = info.querySelector("[data-acs-token-verify]");
      const setVerify = (text) => { if (verifyCell) verifyCell.textContent = text; };
      const userId = (state && state.me) ? state.me.id : currentUserId;

      /**
       * 报结果。🟡 = 站点响应正常、但令牌**没能严格验证**（请求被 WAF 挡了，只好带上 cookie 再试）。
       * detail 是实际发出的那次请求的结果 —— 和「令牌来源」分开写，别再让人以为是同一件事。
       */
      function report(result, source) {
        if (!result.ok) {
          setVerify("⚠️ 验证没通过 · " + result.detail);
          return;
        }
        setVerify((result.loose
          ? "🟡 站点响应正常，但令牌没被严格验证 · "
          : "✅ 验证通过 · ") + result.detail + " · 令牌来源：" + source);
      }

      /** 认下这个令牌：填进框、清掉「手填」标记、记住来源，再报结果 */
      function accept(value, source, result) {
        accessTokenField.value = value;
        delete accessTokenField.dataset.acsManual;
        if (state) {
          state.accessToken = value;
          state.accessTokenSource = source;
        }
        report(result, source);
      }

      refreshValues();

      // ① 已经拿到值了（老版本的字段名，或人手填的）→ 直接发请求验
      if (accessTokenField.value.trim()) {
        const key = accessTokenField.value.trim();
        const source = (state && state.accessTokenSource) || (accessTokenField.dataset.acsManual ? "手工填写" : "已读到");
        setVerify("正在发请求验证令牌…");
        report(await verifyToken(key, userId), source);
        return;
      }

      if (!state) { setVerify("⚠️ 还没读到站点信息"); return; }

      // ② 老版本可能有别的字段名：把 user 对象里所有 token 字段逐个**真发请求**去挑
      if (state.tokenCandidates.length) {
        const names = state.tokenCandidates.map((item) => "`" + item.key + "`").join("、");
        setVerify("在 " + names + " 里找可用的访问令牌（每个都真发一次请求）…");

        for (let i = 0; i < state.tokenCandidates.length; i++) {
          const candidate = state.tokenCandidates[i];
          const result = await verifyToken(candidate.value, userId);
          if (!result.ok) continue;   // 没通过就试下一个
          accept(candidate.value, "字段 `" + candidate.key + "`", result);
          return;
        }
        // 没通过也不急着退出，继续走 ③ 试新接口
      }

      // ③ 最后才用站点前端自己那个接口：GET /api/user/token
      //    （站点「访问令牌」弹窗就是靠它拿的，是「有就返回原来的、没有才生成」，当读取用安全）
      //    注意：它只负责**取**令牌，验证仍然是拿令牌去调 /api/user/self。
      setVerify("字段里都没找到，改用站点自己的接口取令牌：GET /api/user/token…");
      try {
        const payload = (await api("/api/user/token")).data;
        const fresh = typeof payload === "string"
          ? payload.trim()
          : ((payload && (payload.access_token || payload.token)) || "");

        if (fresh) {
          const result = await verifyToken(String(fresh), userId);
          if (result.ok) { accept(String(fresh), "GET /api/user/token", result); return; }
          setVerify("⚠️ 从 GET /api/user/token 取到了值，但验证没通过 · " + result.detail);
          return;
        }
        setVerify("⚠️ GET /api/user/token 没返回令牌 —— 去站点「个人设置 → 安全设置」复制后粘进下面的框");
      } catch (e) {
        setVerify("⚠️ 取令牌失败（GET /api/user/token）：" + e.message
          + " —— 去站点「个人设置 → 安全设置」复制后粘进下面的框");
      }
    }

    function renderInfo(message) {
      info.textContent = "";
      if (!state) {
        info.appendChild(el("div", { text: message || "" }));
        return;
      }
      const me = state.me || {};
      const cookieSegments = state.cookie
        ? state.cookie.split(";").map((s) => s.trim()).filter((s) => s)
        : [];
      const cookieCount = cookieSegments.length;
      // 列出**名字**：能一眼看出「为什么偏偏是这几条、缺的那几条去哪了」
      const cookieNames = cookieSegments.map((s) => s.split("=")[0]).join("、");
      const rows = [
        ["站点", state.origin],
        ["账号", "#" + (me.id || "?") + " " + (me.username || me.display_name || "")],
        ["版本", (state.status && (state.status.version || state.status.system_name)) || "?"],
        ["会话", "✅ 有效（已用 /api/user/self 验证）"],
        ["GM_cookie", gmStateLabel(state)],
        ["Cookie", state.sessionVisible
          ? "✅ 读到会话 cookie（来源 " + state.cookieSource + "，" + cookieCount + " 条：" + cookieNames + "）"
          : cookieCount
            ? "⚠️ 只读到 " + cookieCount + " 条：" + cookieNames + "（来源 " + state.cookieSource + "）。"
              + "这些是**页面 JS 写的**所以 JS 可见；session 这类是服务端 HttpOnly 写的，JS 读不到"
              + " —— 见上面 GM_cookie 那一行"
            : "⛔ 一条 cookie 都读不到（来源 " + state.cookieSource + "）—— 见上面 GM_cookie 那一行"],
      ];
      rows.forEach((row) => {
        info.appendChild(el("div", { class: "acs-kv" }, [
          el("b", { text: row[0] + "　" }),
          el("span", { text: String(row[1]) }),
        ]));
      });
      info.appendChild(el("div", { class: "acs-kv" }, [
        el("b", { text: "验证结果　" }),
        el("span", { "data-acs-token-verify": "1", text: "读取后自动验证" }),
      ]));
      if (state.errors.length) {
        state.errors.forEach((message2) => info.appendChild(el("div", { text: "⚠️ " + message2 })));
      }
      const fieldsCell = body.querySelector("[data-acs-userfields]");
      if (fieldsCell) fieldsCell.textContent = state.userFields.join(", ") || "（没拿到字段名）";

      const candCell = body.querySelector("[data-acs-candidates]");
      if (candCell) {
        candCell.textContent = state.tokenCandidates.length
          ? state.tokenCandidates.map((item) => item.key).join(", ")
          : "（user 对象里没有任何「名字带 token 的字符串字段」）";
      }
    }

    async function load() {
      errorBox.className = "acs-status";
      errorBox.textContent = "正在读取…";
      try {
        state = await collect(idInput.value);
        renderInfo();
        await verifyAccess();
        errorBox.className = "acs-status ok";
        errorBox.textContent = state.accessToken
          ? "已读到系统访问令牌（来源：" + (state.accessTokenSource || "未知") + "）"
          : "没读到系统访问令牌 —— 见上面的「验证结果」，或去站点「个人设置 → 安全设置」复制后粘进下面的框";
      } catch (e) {
        state = null;
        renderInfo();
        refreshValues();
        errorBox.className = "acs-status err";
        errorBox.textContent = e.message;
      }
    }

    retryBtn.addEventListener("click", load);

    // 手工粘进来的值标记一下，之后不再被自动读取覆盖
    accessTokenField.addEventListener("input", () => { accessTokenField.dataset.acsManual = "1"; });
    cookieField.addEventListener("input", () => { cookieField.dataset.acsManual = "1"; });

    testTokenBtn.addEventListener("click", () => { if (state) verifyAccess(); });

    toSitesBtn.addEventListener("click", () => {
      const line = buildLineFromState();
      if (!line) {
        errorBox.className = "acs-status err";
        errorBox.textContent = "访问令牌和 Cookie 至少要有一个才能拼出行格式 —— 先「🔍 测试访问令牌」，"
          + "或把站点上复制的值粘进上面的框";
        return;
      }
      ui.close();
      openConverter(null, line);   // 跳到 SITES JSON，并把行格式填好
    });

    body.appendChild(info);
    body.appendChild(errorBox);
    // new-api 强制要 New-Api-User，自动读不到时这里是唯一的兜底
    body.appendChild(el("div", { class: "acs-row" }, [
      el("label", { text: "用户 ID" }), idInput, retryBtn,
    ]));

    body.appendChild(el("div", { class: "acs-row", style: "margin:12px 0 6px" }, [
      el("b", { text: "提取到的值　" }),
      el("span", { class: "acs-kv", text: "api_checkin 要的是「访问令牌」" }),
    ]));
    body.appendChild(valueRow("用户 ID", idField));
    body.appendChild(valueRow("访问令牌", accessTokenField));
    body.appendChild(valueRow("Cookie", cookieField));
    body.appendChild(el("div", { class: "acs-row", style: "margin-top:10px" }, [
      testTokenBtn, toSitesBtn,
    ]));

    body.appendChild(el("details", { style: "margin-top:10px", "data-acs-gmguide": "1" }, [
      el("summary", { text: "怎么开启 GM_cookie（读 httpOnly 会话 cookie 的唯一办法）" }),
      el("pre", {
        class: "acs-hint",
        style: "white-space:pre-wrap;margin:8px 0 0",
        text: [
          "1. 脚本头部已经有 `// @grant GM_cookie` —— 这条不用你动。",
          "2. 点工具栏的篡改猴图标 → 管理面板 → 「设置」。",
          "3. 「通用 → 配置模式」从「新手」改成「高级」—— Cookie 开关只在高级模式下出现。",
          "4. 「安全 → 允许脚本访问 Cookie」选「全部」，然后点页面底部保存。",
          "5. ⚠️ 官方文档写明：httpOnly cookies are supported at the BETA versions of",
          "   Tampermonkey only for now —— 也就是**正式版照样读不到**会话 cookie，",
          "   要用得换成 Beta（商店里叫「篡改猴测试版」）。",
          "6. 改完刷新本页（脚本要重新运行才会拿到权限），回来点上面的「重试」。",
          "7. 还是读不到，就是这条路在你的浏览器上走不通 —— 直接用访问令牌，",
          "   或 F12 → Network 复制 Cookie 头粘进下面的框。",
        ].join("\n"),
      }),
    ]));

    body.appendChild(el("details", { style: "margin-top:10px" }, [
      el("summary", { text: "诊断：为什么读不到访问令牌" }),
      el("p", { class: "acs-hint", text: "/api/user/self 返回的全部字段名：" }),
      el("p", { class: "acs-hint" }, [el("code", { "data-acs-userfields": "1", text: "（读取后填上）" })]),
      el("p", { class: "acs-hint", text: "其中被判为「访问令牌候选」的字段（这些会被逐个真发请求验证）：" }),
      el("p", { class: "acs-hint" }, [el("code", { "data-acs-candidates": "1", text: "（读取后填上）" })]),
    ]));

    body.appendChild(el("p", { class: "acs-hint", text: "要把它们变成行格式 / SITES JSON：用菜单里的「SITES JSON」粘一遍（GitHub 派发页也有同一个按钮）。" }));
    body.appendChild(el("p", { class: "acs-hint", text: "全部在本机浏览器里完成，不会发往任何第三方。" }));

    load();
  }

  /* ── 小助手：默认右上角、可拖动、位置记在 localStorage、点开是二级菜单 ── */

  const POS_KEY = "acs-launcher-pos";

  function savedPos() {
    try { return JSON.parse(window.localStorage.getItem(POS_KEY) || "null"); } catch (e) { return null; }
  }

  function savePos(pos) {
    try { window.localStorage.setItem(POS_KEY, JSON.stringify(pos)); } catch (e) { /* 忽略 */ }
  }

  function clampToViewport(btn, left, top) {
    const maxLeft = Math.max(0, window.innerWidth - btn.offsetWidth);
    const maxTop = Math.max(0, window.innerHeight - btn.offsetHeight);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  /** 一旦落到具体坐标，就把 right 让开，免得两套定位打架 */
  function placeAt(btn, pos) {
    btn.style.left = pos.left + "px";
    btn.style.top = pos.top + "px";
    btn.style.right = "auto";
  }

  let launcherMenu = null;

  function closeLauncherMenu() {
    if (launcherMenu) { launcherMenu.remove(); launcherMenu = null; }
  }

  /** 把菜单贴在按钮下方；下方放不下就翻到上方。拖动时要实时重算，所以单独拎出来 */
  function placeMenu(btn, menu) {
    const rect = btn.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - menu.offsetWidth - 8));
    let top = rect.bottom + 6;
    if (top + menu.offsetHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - menu.offsetHeight - 6);
    }
    menu.style.left = left + "px";
    menu.style.top = top + "px";
    menu.style.right = "auto";
  }

  function openLauncherMenu(btn) {
    if (launcherMenu) { closeLauncherMenu(); return; }   // 再点一次 = 收起

    const menu = el("div", { class: "acs-menu" });
    palette(menu);
    [
      ["提取账号", () => openExtractor()],
      ["SITES JSON", () => openConverter(null)],
    ].forEach((entry) => {
      const item = el("button", { type: "button", text: entry[0] });
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeLauncherMenu();
        entry[1]();
      });
      menu.appendChild(item);
    });

    document.body.appendChild(menu);
    launcherMenu = menu;

    placeMenu(btn, menu);

    ["click", "mousedown", "pointerdown"].forEach((type) => {
      menu.addEventListener(type, (event) => event.stopPropagation());
    });
    document.addEventListener("click", closeLauncherMenu, { once: true });
  }

  function makeDraggable(btn) {
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    btn.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = btn.getBoundingClientRect();
      placeAt(btn, { left: rect.left, top: rect.top });   // 先钉住当前坐标，再跟手移动
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      if (btn.setPointerCapture) btn.setPointerCapture(event.pointerId);
      event.stopPropagation();
    });

    btn.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      placeAt(btn, clampToViewport(btn, startLeft + dx, startTop + dy));
      if (launcherMenu) placeMenu(btn, launcherMenu);   // 展开着的菜单跟着一起走
    });

    function endDrag(event) {
      if (!dragging) return;
      dragging = false;
      if (btn.releasePointerCapture && event.pointerId !== undefined) {
        try { btn.releasePointerCapture(event.pointerId); } catch (e) { /* 忽略 */ }
      }
      if (moved) {
        const rect = btn.getBoundingClientRect();
        savePos(clampToViewport(btn, rect.left, rect.top));
      }
      if (launcherMenu) placeMenu(btn, launcherMenu);
    }
    btn.addEventListener("pointerup", endDrag);
    btn.addEventListener("pointercancel", endDrag);

    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (moved) { moved = false; return; }   // 刚拖完的那一下不算点击
      openLauncherMenu(btn);
    });

    // 窗口缩小后别把按钮留在看不见的地方
    window.addEventListener("resize", () => {
      const rect = btn.getBoundingClientRect();
      const pos = clampToViewport(btn, rect.left, rect.top);
      if (pos.left !== rect.left || pos.top !== rect.top) placeAt(btn, pos);
      if (launcherMenu) placeMenu(btn, launcherMenu);
    });
  }

  function injectLauncher() {
    if (document.getElementById("acs-launcher")) return;
    const btn = el("button", {
      class: "acs-launcher",
      id: "acs-launcher",
      type: "button",
      text: "🛠 账号小助手",
      title: "点一下开菜单；按住可拖动，位置会记住",
    });
    palette(btn);
    document.body.appendChild(btn);

    const pos = savedPos();
    if (pos && typeof pos.left === "number" && typeof pos.top === "number") {
      placeAt(btn, clampToViewport(btn, pos.left, pos.top));
    }
    // 没存过位置就保持 CSS 默认值：右上角

    makeDraggable(btn);
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
