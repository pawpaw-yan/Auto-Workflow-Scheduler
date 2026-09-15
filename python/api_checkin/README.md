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
| 凭证 | cookie 或令牌本身。⚠️ **令牌不以 `sk-` 开头也完全正常** —— 类型段写了 `token` 就按令牌处理 |

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

派发时把整个账号表塞进 `inputs.overrides.SITES`，就不用去网页改 Secret 了。

**你真正要写的就是下面这段**（这就是 `overrides` 的值）：

```json
{
  "SITES": {
    "https://a.com": {
      "cookies": ["session=xxx"],
      "tokens":  ["aNSC....Y/8", {"token": "sk-zzz", "user_id": "1001", "label": "小号"}]
    },
    "https://b.com": {"tokens": ["sk-qqq"]}
  }
}
```

**结构：站点 → 分桶 → 凭证数组。** 桶名就是类型：

| 桶 | 桶内元素一律当 |
|---|---|
| `cookies` | **cookie** |
| `tokens` | **令牌** |

两个桶都可选，至少一个非空（写 `[]` 或直接省略都行）；一个站点挂几个号就放几个元素。

> **分桶的意义**：桶名已经声明了类型，所以**桶内裸写凭证，不做任何猜测** ——
> 令牌不以 `sk-` 开头也无所谓，更不需要写 `token:` 前缀。

### 桶内什么时候要写成对象？

**只有两个需求**：带用户 ID，或带标签。

```json
{"token": "sk-zzz", "user_id": "1001", "label": "小号"}
```

| 字段 | 是什么 | 从哪来 / 什么时候要 |
|---|---|---|
| `token` | **就是页面上那一串** | 「个人设置 → 安全设置 → 系统访问令牌」，原样复制。**没有别的附加内容** |
| `user_id` | 你的**用户 ID**，是一个**数字**，不是令牌的一部分 | 令牌认证时 new-api 管理接口要求 `New-Api-User: <用户ID>`，官方文档原文是「**{user_id} 必须与当前登录用户匹配**」。不填有的站点直接 401，而报错看着像「令牌错了」，极难排查。**cookie 认证用不上它** |
| `label` | **你自己起的备注名** —— 站点上根本没有这个概念 | **纯展示**，出现在日志和推送里（`#1 [主号] token \| +500 \| 余额 12,345 \| ok`）。一个站点只挂一个号时完全不用写 |

> **`user_id` 在哪找？** ①「个人设置」页（有的版本会显示）；② 管理员在「用户管理」列表里能看到；
> ③ **最省事**：先用 cookie 认证跑一次 —— 脚本调 `/api/user/self` 时会顺手把你的用户 ID 打进日志。

所以**页面上你能拿到的只有那串字符串**。只挂一个号、又不需要 `user_id` 时，桶内全是裸字符串：

```json
{"SITES":{"https://你的站点":{"tokens":["粘贴页面那一串"]}}}
```

**怎么把它送进去 —— 三种入口，前两种不需要你手写任何转义：**

**① `gh` CLI（推荐，最省事）**

```bash
gh workflow run api_checkin.yml \
  -f overrides='{"SITES":{"https://a.com":{"tokens":["aNSC....Y/8"]}}}'
```

外层单引号让 shell 原样传递，`gh` 自己负责编码成合法的 JSON body。
走总入口就把工作流换成 `run-project.yml` 并加 `-f project=api_checkin`。

> ⚠️ 单引号里不能再出现 `'`。cookie 和令牌都不会有它；
> 真遇到就从文件读：`gh workflow run api_checkin.yml -f overrides="$(jq -c '{SITES:.}' sites.json)"`。

**② Actions 页面 → Run workflow**

`overrides` 输入框里**直接粘上面那段**，不转义、不带外层。就是纯文本框，你输入什么就是什么。

**③ 只能自己拼 HTTP body 时（cron-job.org 这类）**

这种场景**避不开转义**，因为 `inputs.overrides` 在 workflow 里声明的是 `type: string`：

```json
{"ref":"main","inputs":{"overrides":"{\"SITES\":{\"https://a.com\":{\"tokens\":[\"aNSC....Y/8\"]}}}"}}
```

别手写，交给 `jq` 生成：

```bash
body=$(jq -nc --argjson sites '{"https://a.com":{"tokens":["aNSC....Y/8"]}}' \
        '{ref:"main", inputs:{overrides: ({SITES:$sites} | tojson)}}')
curl -X POST -H "Authorization: Bearer <PAT>" -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/actions/workflows/api_checkin.yml/dispatches \
  -d "$body"
```

> ⚠️ **必须写成一行**。HTTP body 的 JSON 字符串内部不能出现真换行，
> 为可读性折行再粘贴，GitHub 会直接返回 **400**（要换行只能写 `\n`）。

> **为什么 ③ 一定要套两层？** 不是文档写得麻烦，是接口本身如此：
> `workflow_dispatch` 的 inputs 是**字符串通道**，workflow 里那行
> `OVERRIDES: ${{ inputs.overrides }}` 拿到的只会是字符串 —— 所以对象必须先序列化一遍，
> 再嵌进 HTTP body。① 和 ② 之所以不用转义，就是因为 `gh` / 网页帮你做了这一步。

### 早期写法：扁平数组（继续支持）

不分桶，cookie 和令牌混在一个数组里，靠自动判断类型 —— 早期文档用的这种：

```json
{"SITES":{"https://a.com":["session=xxx","sk-yyy"],"https://b.com":[{"token":"sk-zzz","user_id":"1001"}]}}
```

自动判断是**启发式**，只对 `sk-` 开头的令牌可靠：

| 元素写法 | 判定 |
|---|---|
| `"session=xxx"` | 含 `=` → cookie |
| `"sk-yyy"` | `sk-` 开头 → 令牌 |
| `"aNSC....Y/8"` | 都不沾 → **报错**，必须写 `token:` 前缀 |
| `"aNSC...8="` | 含 `=` → **被误判成 cookie**，请求头整个发错 → 401 |
| `"token:任意值"` / `"cookie:任意值"` | 前缀强制指定 |
| `{"token": "..."}` / `{"cookie": "..."}` | 对象显式指定 |

> **新配置请用分桶写法** —— 它就是为绕开这张表的坑而存在的。
> 尤其后两行：新版 New API 的系统访问令牌是随机串，裸写会直接报错，
> base64 填充结尾的还会被**静默误判**。

站点只挂一个账号时，扁平写法可以省掉数组：`{"https://a.com": "session=xx"}`。
⚠️ 这个简写走自动判断，非 `sk-` 令牌仍需 `token:` 前缀 —— 那种情况就写
`{"https://a.com": {"tokens": ["aNSC....Y/8"]}}`。

### ⚠️ 用 ref 传凭证 = 公开这些凭证

`workflow_dispatch` 的 **inputs 不是机密，也不受脱敏保护** —— GitHub 会把它原样存进
本次 run 的记录，而**本仓库是公开的**，所以任何人打开 run 详情页就能看到你传的 cookie / 令牌。
脚本里的 `::add-mask::` 只遮日志，**遮不住 inputs 本身**。

| 你的取舍 | 做法 |
|---|---|
| 只图省事，不在乎这些免费站账号被人看到 | 用 ref 传，接着往下看 |
| 想保密 | 把账号表写进 Environment secret `SITES`（就是上面「一行一个账号」那种格式） |

用 ref 传 `SITES` 时，run 顶部会**自动出现一条 `::warning::`**，不会让你忘了这回事。

> 这条告警来自**通用层** `common/apply-overrides.sh`，不是本项目的特殊逻辑：
> 它检查被替换的项里有没有登记在 `SECRET_NAMES` 里的（`SITES` 在里面），有就打。
> 所以以后给这个项目加任何新的机密项，告警会自动跟着生效，一行代码都不用改。

### ref 一定赢

`ref > vars/secrets > .env` 由 `common/apply-overrides.sh` 统一实现，**本项目没有任何特殊处理** ——
它把 ref 的值写进 `$GITHUB_ENV`，后续所有 step 读到的就是新值，和另外两个项目走的是同一条路。

> **为什么 `$GITHUB_ENV` 能压掉 workflow `env:` 里的同名变量？** 官方文档没写这条，
> 但从 runner 源码可以确认：job 级 `env:` 和 `$GITHUB_ENV` 写的是**同一个**
> `Global.EnvironmentVariables` 字典，而 `$GITHUB_ENV` 在该 step **结束后**才处理 → 后写覆盖先写。
>
> ⚠️ 唯一能压过 `$GITHUB_ENV` 的是 **step 级 `env:`**（组装 step 环境时最后合并）。
> 所以**不要在 `Run` 那一步写 `env: {SITES: ...}`**，否则参数覆盖会被**静默吃掉**。

---

## 凭证怎么拿

### 方式一：访问令牌（推荐，不会过期）

1. 浏览器登录站点
2. 进 **个人设置 → 安全设置 → 系统访问令牌**
3. 生成并复制那一串（形如 `aNSC...Y/8` 的随机串**也可能**是 `sk-...`，两种都正常）

对应请求头 `Authorization: Bearer <令牌>`。

> ⚠️ **这个令牌不一定以 `sk-` 开头** —— 新版 New API 生成的就是随机串。
> 脚本的自动判断只认 `sk-` 前缀，所以**令牌必须显式指定类型**，否则：
>
> | 写法 | 结果 |
> |---|---|
> | `"token:aNSC....Y/8"` | ✅ 当令牌（推荐） |
> | `{"token":"aNSC....Y/8"}` | ✅ 当令牌，还能顺带带 `user_id` |
> | `"aNSC....Y/8"` 裸写 | ❌ **报错**：判断不出类型 |
> | `"aNSC...8="` 裸写、恰好以 `=` 结尾 | ❌ **被误判成 cookie**，请求头整个发错 → 401 |
>
> 最后一行是真实风险：base64 令牌经常以 `=` 结尾。**别省那几个字符。**

> ⚠️ 另外，**只有 New API 新版支持用访问令牌调用管理接口。**
> 老 one-api 和部分 fork 里的 `sk-` 只是「模型调用 key」，鉴权中间件不认，
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

1. **令牌复制是否完整** —— 那一长串都要，别漏字符
2. **类型有没有指定** —— 令牌请显式写 `token:<值>`。裸写且恰好含 `=` 时会被当成 cookie，
   请求头整个发错，现象同样是 401
3. **补上用户 ID** —— 把类型段写成 `token=<用户ID>`，会多带一个 `New-Api-User` 头
4. **这个站是不是 New API 新版** —— 老 one-api / 部分 fork 的 `sk-` 只是模型调用 key，
   不能用管理接口，**这类站请改用 cookie**
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
