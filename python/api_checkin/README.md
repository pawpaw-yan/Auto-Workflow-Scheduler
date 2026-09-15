# api_checkin

new-api / one-api 站点每日自动签到，支持**多站点**、**一个站点挂多个账号**，
每个账号可以用**会话 Cookie** 或**访问令牌**认证。

> **本文件只讲这个项目自己的东西** —— 要配哪些名字、账号格式、凭证怎么拿、专属的坑。
>
> 通用机制（项目结构、配置三层优先级、怎么触发、参数覆盖、`.env`、摘要与自检、本地运行）
> 全部写在[仓库根 README](../../README.md) 里，这里不重复。

| | |
|---|---|
| 对应 workflow | `.github/workflows/api_checkin.yml` |
| 对应 Environment | `python_api_checkin` |
| 入口脚本 | `python/api_checkin/index.py` |
| 建议调度频率 | 每天 1~2 次 |

---

## 这个项目做什么

new-api 与 one-api 是同一套 LLM API 网关的两个分支，**管理接口完全一致**，
所以一个脚本能同时覆盖两者。

对每个账号依次执行：

```
GET  /api/user/self     校验凭证 + 读签到前的额度
POST /api/user/checkin  签到
GET  /api/user/self     签到成功后再读一次
```

**为什么要读两次额度**：各站签到接口返回的 `data` 结构不统一（有的给额度、有的给积分、
有的只给一句话），与其猜字段名，不如用「签前余额 → 签后余额」的差值，
任何 fork 上都准。

---

## 配置

> 三层优先级规则、什么该放 Secret 什么该放 Variable、Environment 怎么建，
> 见[根 README「配置体系」](../../README.md#6-配置体系通用)。
> 这里只列**名称和取值范围**。

### Environment secrets

在 **Settings → Environments → `python_api_checkin` → Environment secrets** 中添加：

| 名称 | 必填 | 说明 |
|---|---|---|
| `SITES` | ✅ | 账号列表，**多行**，格式见下一节。**里面含凭证，只能放 Secret** |
| `PUSHDEER_SENDKEY` | 选填 | 不填则跳过推送，仅输出日志 |

### Environment variables

在 **Settings → Environments → `python_api_checkin` → Environment variables** 中添加：

| 名称 | 默认 | 说明 |
|---|---|---|
| `API_VERBOSE` | `false` | 打印接口原始响应，排查用；凭证不会被打印 |
| `API_TIMEOUT` | `15` | 单次请求超时（秒） |

---

## 账号格式（重点）

每行 4 段，用 `|` 分隔：

```
<站点地址>|<账号标签>|<cookie 或 token[=用户ID]>|<凭证>
```

**`SITES` 的值**（Secret 里直接回车换行）：

```
https://api.example.com|主号|token=1001|sk-abcdefghijklmnopqrstuvwxyz
https://api.example.com|小号|token|sk-zyxwvutsrqponmlkjihgfedcba
https://another-site.org|dav|cookie|session=eyJhbGciOi...; new-api-session=abc123
```

| 段 | 说明 |
|---|---|
| 站点地址 | 必须带 `http://` 或 `https://`；结尾的 `/` 可有可无 |
| 账号标签 | 自己起的名字，只出现在日志和推送里，用来区分同一个站点的多个号 |
| 认证类型 | `cookie` 或 `token`；写成 `token=<用户ID>` 会额外带上 `New-Api-User` 头 |
| 凭证 | cookie 或 `sk-` 令牌本身 |

**凭证放最后一段是刻意的** —— 解析时对它只做一次 `split("|", 3)`，
所以凭证里真的出现 `|` 也不会被切断。

空行、`#` 开头的注释行会被忽略。

### 一个站点多个账号

重复写站点地址即可：

```
https://api.example.com|主号|token|sk-aaa
https://api.example.com|小号|token|sk-bbb
https://api.example.com|三号|cookie|session=ccc
```

### `.env` 里的写法不一样

`.env` 是按行解析的，所以整个 `SITES` 要写成**一行**，换行用 `\n` 转义：

```
SITES="https://a.com|主号|token|sk-aaa\nhttps://a.com|小号|cookie|session=bbb"
```

> 想省事就直接 `cp .env.example .env`，模板里已经写好了。
> ⚠️ 但这个文件里含凭证，**别提交、别外发**。

---

## 用 ref 传账号（可选，但请先读警告）

派发时把整个账号表塞进 `inputs.overrides.SITES`，就不用去网页改 Secret 了：

```json
{"ref":"main","inputs":{"overrides":"{\"SITES\":{\"https://a.com\":[\"session=xxx\",\"sk-yyy\"],\"https://b.com\":[{\"token\":\"sk-zzz\",\"user_id\":\"1001\"}]}}"}}
```

**结构就是「站点 → 账号数组」**，数组里 cookie 和令牌可以混着写：

| 数组元素 | 含义 |
|---|---|
| `"session=xxx"` | 字符串。含 `=` 且不以 `sk-` 开头 → 当 **cookie** |
| `"sk-yyy"` | 字符串，`sk-` 开头 → 当**令牌** |
| `"cookie:任意值"` | 加前缀**强制**当 cookie（自动判断不出来时用） |
| `"token:任意值"` | 加前缀**强制**当令牌 |
| `{"token": "sk-zzz", "user_id": "1001", "label": "小号"}` | 对象，可以带用户 ID 和标签 |

站点只挂一个账号时，值也可以直接写成字符串：`{"https://a.com": "sk-xxx"}`。

### ⚠️ 用 ref 传凭证 = 公开这些凭证

`workflow_dispatch` 的 **inputs 不是机密，也不受脱敏保护** —— GitHub 会把它原样存进
本次 run 的记录，而**本仓库是公开的**，所以任何人打开 run 详情页就能看到你传的 cookie / 令牌。
脚本里的 `::add-mask::` 只遮日志，**遮不住 inputs 本身**。

| 你的取舍 | 做法 |
|---|---|
| 只图省事，不在乎这些免费站账号被人看到 | 用 ref 传，接着往下看 |
| 想保密 | 把账号表写进 Environment secret `SITES`（就是上面「一行一个账号」那种格式） |

脚本一旦发现 `SITES` 来自 ref，会主动打一条 `::warning::` 提醒，不会让你忘了这回事。

### ref 一定赢

`ref > vars/secrets > .env` 这个顺序是**脚本自己保证**的，不依赖
「`GITHUB_ENV` 能不能覆盖 workflow `env:` 同名变量」—— 那是 runner 的**未文档化行为**
（官方只说 GITHUB_ENV 对后续步骤可见，没说冲突时谁赢），不能拿来当保证。

---

## 凭证怎么拿

### 方式一：访问令牌（推荐，不会过期）

1. 浏览器登录站点
2. 进 **个人设置 → 安全设置 → 系统访问令牌**
3. 生成并复制得到的 `sk-...`

对应请求头 `Authorization: Bearer sk-...`。

> ⚠️ **只有 New API 新版支持这么用。**
> 老 one-api 和部分 fork 里的 `sk-...` 只是「模型调用 key」，鉴权中间件不认，
> 拿它签到会 **401**。这类站点只能用下面的 Cookie 方式。

### 方式二：会话 Cookie（通用，但会过期）

1. 浏览器登录站点
2. `F12` 打开开发者工具 → **Network**
3. 随便点一个站内请求，看 **Request Headers** 里的 `Cookie:`
4. 把 `Cookie:` 后面**整段**复制下来

**站点有多个 cookie 怎么办？** 直接整段贴进凭证段，**不用挑、不用转义**：

```
session=eyJhbGciOi...; new-api-session=abc123; cf_clearance=xyz.789; _ga=GA1.2.3
```

> 凭证是「每行的最后一段」，解析时只对它做一次 `split("|", 3)`，
> 所以 `;`、空格、`=`、`|` 全部原样保留，直接当成 `Cookie:` 头送出去。
> **凭证段里没有任何需要转义的字符。**
>
> 多余的 cookie（比如 `_ga` 这类统计用的）留着也不影响，服务端只认它需要的那些。

> 有效期一般几天到几周，过期后重新复制一份。
> 签到脚本**不会调用登出接口**，所以复用的会话不会被主动作废。

### 什么时候需要填用户 ID

New API 官方文档写明：`New-Api-User: <用户ID>` 这个头**部分接口要求携带**，
且值必须和当前登录用户一致。

所以如果令牌方式报 401 / 403，把类型段改成 `token=<用户ID>` 再试：

```
https://api.example.com|主号|token=1001|sk-abcdefghijklmnopqrstuvwxyz
```

用户 ID 可以在站点**个人设置**页面看到，或调 `GET /api/user/self` 看返回的 `id` 字段。

---

## 执行流程

```
解析 SITES，得到 N 个「站点 + 账号」任务
        ↓
对每个任务依次执行：
   1. GET  /api/user/self     校验凭证，记下签到前额度
   2. POST /api/user/checkin  签到
        成功   → 再读一次 /api/user/self，差值就是本次领到的额度
        重复   → 标记「今日已签到」，不再读第二次
        失败   → 记下服务端给的 message
        ↓
汇总所有任务 → 输出日志 + 推送 PushDeer
```

**结果分三类**：签到成功 / 今日已签到 / 失败。

**凭证失效会被单独识别**：401 / 403 不会和普通请求错误混在一起，
日志里会直接给出排查方向（令牌类型用错？cookie 过期？要补用户 ID？）。

---

## 日志与推送

日志格式与摘要机制见[根 README「跑完以后看什么」](../../README.md#8-跑完以后看什么)。
`API_VERBOSE` 控制是否打印接口原始响应：

| 输出位置 | `false`（默认） | `true` |
|---|---|---|
| 接口原始响应 | 隐藏 | 显示（截断到 200 字符） |
| 失败 / 认证错误 | **始终显示** | **始终显示** |
| 每个账号的结果 | 只显示状态 | 状态 + 误差 + 余额 |

**凭证永远不会被打印**。另外运行时会把每个凭证注册进日志遮蔽列表，
万一将来有代码把它打出来也会是 `***`。

### 推送内容

```
标题：API 签到, 成功1, 重复1, 失败0

https://api.example.com #1 [主号] token | +5,000 | 余额 120,000 | ok
https://api.example.com #2 [小号] cookie | repeat
```

---

## 常见问题

> 通用问题（变量没生效、Summary 是空的、调度器没触发……）见
> [根 README「常见问题（通用）」](../../README.md#10-常见问题通用)。下面是本项目专属的。

### 令牌认证报 401 / 403

按顺序排查：

1. **令牌复制是否完整** —— `sk-` 后面那一长串都要，别漏字符
2. **这个站是不是 New API 新版** —— 老 one-api / 部分 fork 的 `sk-` 只是模型调用 key，
   不能用管理接口，**这类站请改用 cookie**
3. **补上用户 ID** —— 把类型段写成 `token=<用户ID>`，会多带一个 `New-Api-User` 头
4. **令牌是否被禁用 / 删除** —— 去站点个人设置里看一眼

### Cookie 认证报 401 / 403

会话过期了。重新登录站点，按上面「方式二」再复制一次。这是 Cookie 方式的固有缺点，
所以才推荐优先用令牌。

### `响应不是 JSON（可能是 Cloudflare 人机校验 / WAF / 反代页面）`

有站点在签到接口前面挂了 **Cloudflare Turnstile 人机校验**。这种情况脚本无法通过 ——
它只做纯 HTTP 请求，不跑浏览器。这类站只能手动签到。

也可能是站点临时故障或反代返回了 HTML 错误页，可以过一会儿重跑一次确认。

### 服务端提示「签到功能未开启」

签到是站点的**管理端开关**（不在用户侧）。该站点没开这个功能，脚本也没办法。

### 所有账号都失败，但 workflow 是绿的

本脚本在「签到失败」时**返回退出码 0**（跟 `glados_checkin` 一致）——
因为「今天已经签过」「站点没开签到」都算预期内结果，全变红反而看不清真正的问题。

**只有配置写错时才会退出 1 变红**（比如 `SITES` 字段数不够、站点地址没带 `https://`）。

所以**不要只看红绿**，要看日志里的 `========== 签到总结 ==========` 那一段。

### 本地怎么跑

```bash
pip install -r python/api_checkin/requirements.txt
cd python/api_checkin
```

**方式一：临时 export**（不落盘）

```bash
export SITES='https://api.example.com|主号|token|sk-aaa
https://api.example.com|小号|cookie|session=bbb'
export API_VERBOSE=true
python index.py
```

Windows PowerShell：

```powershell
$env:SITES = @"
https://api.example.com|主号|token|sk-aaa
https://api.example.com|小号|cookie|session=bbb
"@
python index.py
```

**方式二：`.env`**（推荐，填一次长期用）

```bash
cp .env.example .env
# 按注释填，注意换行要写成 \n
python index.py
```

> 💡 `index.py` 启动时会自己读同目录的 `.env`，把没设置或为空的项补上。

### 站点用了自签证书怎么办

脚本走 `requests` 的默认校验，自签证书会直接报 SSL 错误。建议给站点配好证书，
或改用 `cloudflared` / `nginx` 之类加一层正常证书的反代，**不建议关掉证书校验**。

---

## 本项目相关文件

| 文件 | 作用 |
|---|---|
| `python/api_checkin/index.py` | 入口脚本 |
| `python/api_checkin/.env.example` | `.env` 模板（提交；只放占位符）。同目录的 `.env` 才是实际生效的那个，已被 gitignore |
| `.github/workflows/api_checkin.yml` | 项目 workflow |
| `python/common/dotenv.py` | Python 语言级共享的 `.env` 读取 |
| `python/common/logging_config.py` | Python 语言级共享的日志初始化 |

> 通用层的 shell 脚本、总入口 workflow、`.gitignore` 等，见
> [根 README「文件速查」](../../README.md#11-文件速查)。
