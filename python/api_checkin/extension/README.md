# api_checkin 账号小助手（Chrome 扩展）

油猴脚本 `../sites_from_lines.user.js` 的扩展版。油猴受页面沙箱限制，
扩展跑在浏览器扩展上下文里，多了三样油猴做不到的能力：

| 能力 | 油猴版 | 扩展版 |
|---|---|---|
| 读完整 Cookie（含 httpOnly 的 session） | ❌ `document.cookie` 读不到 | ✅ `chrome.cookies` |
| 测试 Cookie 能否过站点 WAF | ❌ | ✅ 请求自动带上全部 cookie |
| 跨标签页填写 | ❌ 只能在派发页里转换 | ✅ 从任何页面把 SITES 填进已打开的派发页 |

## 安装（加载未打包扩展）

1. Chrome / Edge 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 「加载已解压的扩展程序」→ 选**本目录**（`extension/`）
4. 固定到工具栏。当前权限是 `<all_urls>`（为了「当前标签页自动填站点」和跨标签页填写）；
   想收窄就把 `manifest.json` 的 `host_permissions` 换成你的站点与 `https://github.com/*`

## 用法

**呼出**：任意页面右上角有可拖动的「账号小助手」按钮（拖过的位置会记住），点开是二级菜单：
「🔑 提取账号」/「🧾 SITES JSON」，弹出居中的毛玻璃面板（Esc / 点遮罩 / × 关闭）。
工具栏图标点开的是同一份 UI，两条入口等价。

**提取账号**：在已登录的 new-api / one-api 站点页打开面板（站点地址自动填好）→ 读取。
依次拿到：完整 Cookie（含 httpOnly）、用户 ID（站点 localStorage 兜底 + 手填框）、
会话有效性（真发请求过 WAF）、访问令牌（`/api/user/self` 的字段 → 候选字段逐个真验证
→ `GET /api/user/token`；掩码形如 `sk-abc1****WXYZ` 的值直接跳过，绝不交给没验证过的值）。

**SITES JSON**：左边贴行格式（或留空，用「提取」面板存进去的内容），选输出形式
（SITES 值 / gh 命令 / HTTP body / 格式化预览）。「追加到已存」会把新账号按凭证值
去重后并进 `chrome.storage.local`；「→ 跨标签页填进 GitHub」把结果填进所有已打开的
`…/actions/workflows/api_checkin.yml` 派发表单（自动触发 input 事件，React 表单认）。

## 文件

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3 清单：cookies / storage / scripting / tabs |
| `lib/core.js` | 转换核心（校验口径与 `../index.py` 的 `parse_sites()` 一致） |
| `lib/site-api.js` | 站点 API 调用（自动带全部 cookie，过 WAF 的关键）+ 读 cookie |
| `lib/site-storage.js` | 注入站点标签页读 localStorage（用户 ID 的兜底） |
| `lib/verify.js` | 两级令牌验证（严格模式 → 被 WAF 拦才带 cookie 重试） |
| `lib/access-token.js` | 访问令牌的三级来源，全程真验证 |
| `lib/collect.js` | 单站点提取主流程（每步失败都记进 errors，不丢已拿到的值） |
| `popup/` | 面板 UI（工具栏图标与页面内按钮共用同一份） |
| `content/content.js` | 页面内注入：可拖动呼出按钮 + 二级菜单 + 居中面板（内嵌 popup.html 的 iframe，扩展权限完整保留） |
| `content/content.css` | 注入元素的样式（类名全部带 acsx- 前缀，不碰宿主页面） |

## 隐私

**WAF 挑战自动求解**：命中阿里云 WAF 的 `acw_sc__v2` 挑战页时，扩展会在本地算出
cookie（算法与 `../../index.py` 完全一致，交叉验证逐字节相同）、经 `chrome.cookies`
种进浏览器真实的 cookie 罐后重试 —— 严格令牌验证也过得了 WAF：重试前暂时挪开会话
cookie、只带 `acw_*`，令牌仍然必须自己扛认证。

所有请求只发往站点本身或 GitHub 本身；存储只用本机 `chrome.storage.local`。
代码里没有任何第三方上报。
