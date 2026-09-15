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

**呼出**：任意页面右上角有可拖动的「账号小助手」按钮，点开是二级菜单：
「🔑 签到配置」/「📤 SITES 输出」/「⏰ 定时任务」，弹出居中的毛玻璃面板（Esc / 点遮罩 / × 关闭）。
工具栏图标点开的是同一份 UI，两条入口等价。

> **拖动的位置是全局的** —— 存在扩展的 `chrome.storage` 里，不是页面的 `localStorage`。
> 所以在 A 站拖到哪儿，B 站打开也在哪儿（`localStorage` 是按站点隔离的，做不到这件事）。

### 面板长什么样

**主表单就一屏**，配置项两列排开：

```
🔗 站点        [https://example.com        ] [🔄 读取]
👤 用户 id     [                 ]  🛡 鉴权类型 [访问令牌 ▾]
🏳 登录类型    [读取浏览器会话 ▾]  ⤴ 签到入口  [/api/user/checkin]
🔑 访问令牌    [                 ]  [复制] [验证]
🛡 是否开启 Turnstile  (未开启)   当前未开启 Turnstile 验证
[▶ 测试签到]                    [💾 保存]
```

设计原则是**一个值只出现一处** —— 展示和编辑是同一组控件。所以没有「信息表」，
也不会出现「用户 ID 在这里显示一次、在那里又填一次」。

| 控件 | 作用 |
|---|---|
| **站点 + 读取** | 读取 = 读 cookie / 用户 ID / 会话 / 凭证，**顺带把签到入口探出来**（站点地址取自当前标签页） |
| **用户 id** | 自动读不到时手填（new-api 的 `New-Api-User` 头要它） |
| **鉴权类型** | `访问令牌` / `Cookie` —— 决定下面露哪一块，以及写进 SITES 的字段名 |
| **登录类型** | `读取浏览器会话`（用浏览器已登录的会话）/ `账号密码登录`（填账号密码 → `POST /api/user/login`） |
| **签到入口** | 读取时自动探测，也可手填。「▶ 测试签到」**真的打一次**，把站点自己的话带回来 |
| **凭证块** | 按鉴权类型只显示一块：访问令牌（长效，推荐）或 Cookie（含 httpOnly）。标题右侧的「验证」走严格模式真发一次请求 |
| **Turnstile** | `未检测` / `未开启` / `已开启`，测签到时顺带判断 —— 已开启就说明只能去浏览器手动签到 |

**签到入口**怎么探：读到凭证后自动扫一遍候选路径（`/api/user/checkin` → `/api/checkin`
→ `/api/user/sign_in` → `/api/user/signin` → `/api/user/attendance`），
第一个不是 404 的就是这个站的签到入口。

> 探到的路径会写进 SITES JSON 的 `checkin_path` 字段 —— `index.py` 拿到它就直接请求、
> **一次都不用回退探测**，日志也清爽。撞到 WAF 挑战页时探不准，面板会标「疑似入口」并提示再测一次。

**SITES 输出**与**定时任务**收在下面的折叠区里（不展开不占地方）；
从页面菜单点「📤 SITES 输出」/「⏰ 定时任务」会直接展开对应那块。

**new-api v1.x 站**（`/api/status` 里 version 是 `v1.*`）：这类站的接口**只认 Bearer 令牌、
不认会话 cookie**，用 cookie 调管理接口必然 401。面板的处理：

1. 读到名字里带 `refresh` 的 cookie（各 fork 命名不一）就认定是 v1.x，直接走自举；
   没读到但 cookie 流程撞上 401 / 403 /「access token 无效」时，也会补一次自举。
2. 自举 = 在**站点自己的标签页里**调 `POST /api/user/auth/refresh`（该端点校验 Origin，
   从扩展页发会被 `AUTH_ORIGIN_FORBIDDEN` 拒掉），换出短期 access_token。
3. 拿到短期令牌后立刻去 `GET /api/user/token` 换**长效系统访问令牌** ——
   填进 SITES 的是这个长效令牌，不是那个会轮换的短期令牌。

所以 v1.x 站唯一的要求是**站点标签页开着**（面板本来就开在站点页上，正常不会缺）。
面板读到 `refresh` cookie 时会按 v1.x 处理，凭证直接给令牌。

**SITES 输出**（折叠区）：左边贴行格式（或留空，用主表单「保存」进去的内容），选输出形式
（SITES 值 / gh 命令 / HTTP body / 格式化预览）。「追加到已填入」会把新账号按凭证值
去重后并进 `chrome.storage.local`；「→ 跨标签页填进 GitHub」把结果填进所有已打开的
`…/actions/workflows/api_checkin.yml` 派发表单（自动触发 input 事件，React 表单认）。

**保存**（主表单）：把当前配置追加进「已填入」，保存时会带上探测到的 `checkin_path`。
行格式只有 4 段装不下签到入口，所以路径是挂在账号对象上、只在生成 JSON 时写出来。

**定时任务**：填一次 cron-job.org 的 API key、GitHub 仓库（`owner/repo`）和 PAT，
点「⏰ 创建 / 更新定时任务」，扩展调 cron-job.org 的 REST API 建一个每天定点触发的
POST 任务 —— 目标就是 GitHub 的 `workflow_dispatch` 接口，SITES 放在请求体里。
同名任务已存在就 **PATCH 更新**，不会重复建；「查看已有任务」列一遍确认。

| 配置项 | 从哪来 |
|---|---|
| cron-job.org API key | 登录 cron-job.org → 控制台 **Settings** 里生成 |
| GitHub 仓库 | 形如 `owner/repo` |
| GitHub PAT | 需要 **Actions 写权限**（fine-grained 或 classic 都行） |

> 为什么绕这一层：GitHub 自带的 `schedule` 对**公共仓库超过 60 天无活动会静默停掉**，
> 外部定时触发更稳。API key / PAT 只存在本机 `chrome.storage.local`，
> 只发往 cron-job.org 与 GitHub 两家。

## 文件

| 文件 | 职责 |
|---|---|
| `manifest.json` | MV3 清单：cookies / storage / scripting / tabs |
| `lib/core.js` | 转换核心（校验口径与 `../index.py` 的 `parse_sites()` 一致） |
| `lib/site-api.js` | 站点 API 调用（自动带全部 cookie，过 WAF 的关键）+ 读 cookie |
| `lib/site-storage.js` | 注入站点标签页读 localStorage（用户 ID 的兜底） |
| `lib/verify.js` | 令牌验证：严格一次（`credentials:"omit"`，不带会话 cookie），没过就是没过 |
| `lib/access-token.js` | 访问令牌的三级来源，全程真验证 |
| `lib/collect.js` | 单站点提取主流程（每步失败都记进 errors，不丢已拿到的值） |
| `lib/cronjob.js` | cron-job.org REST API 封装（列 / 建 / 改任务） |
| `popup/panel-cron.js` | 「定时任务」面板：一键把 SITES 绑成 cron-job.org 的定时任务 |
| `popup/popup.html` + `popup.css` | 面板结构（单页主表单 + 两个折叠区）与样式 |
| `popup/panel-extract.js` | 主表单：读取 → 灌字段 → 鉴权/登录类型决定露哪一块 |
| `popup/extract-actions.js` | 主表单的动作：登录 / 验证 / 扫描 / 测试签到 / 保存 |
| `content/content.js` | 页面内注入：可拖动呼出按钮 + 二级菜单 + 居中面板（内嵌 popup.html 的 iframe，扩展权限完整保留） |
| `content/content.css` | 注入元素的样式（类名全部带 acsx- 前缀，不碰宿主页面） |

## 隐私

**WAF 挑战自动求解**：命中阿里云 WAF 的 `acw_sc__v2` 挑战页时，扩展会在本地算出
cookie（算法与 `../../index.py` 完全一致，交叉验证逐字节相同）、经 `chrome.cookies`
种进浏览器真实的 cookie 罐后重试 —— 严格令牌验证也过得了 WAF：重试前暂时挪开会话
cookie、只带 `acw_*`，令牌仍然必须自己扛认证。

所有请求只发往站点本身或 GitHub 本身；存储只用本机 `chrome.storage.local`。
代码里没有任何第三方上报。
