# glados_checkin

GLaDOS / Railgun 自动签到，支持多域名多账号、可选自动兑换、结果推送。

> **本文件只讲这个项目自己的东西** —— 要配哪些名字、业务流程、专属的坑。
>
> 通用机制（项目结构、配置三层优先级、怎么触发、参数覆盖、`.env`、摘要与配置自检、本地运行）
> 全部写在[仓库根 README](../../README.md) 里，这里不重复。

| | |
|---|---|
| 对应 workflow | `.github/workflows/glados_checkin.yml` |
| 对应 Environment | `python_glados_checkin` |
| 入口脚本 | `python/glados_checkin/index.py` |
| 建议调度频率 | 每天 1~2 次 |

---

## 这个项目做什么

`DOMAINS` 与 `COOKIES` **按行一一对应**，每一行组成一个「域名 + 账号」任务，
依次执行 **查状态 → 签到 → 查积分 →（可选）兑换**，最后把汇总结果推送到 PushDeer。

> Railgun 就是 GLaDOS 的镜像域名，API 路径与返回码完全一致，唯一区别是签到请求体里的
> `token` 要填对应域名 —— 所以同一个脚本加一行域名就能把 railgun 一起签掉。

---

## 配置

> 三层优先级规则、什么该放 Secret 什么该放 Variable、Environment 怎么建，
> 见[根 README「配置体系」](../../README.md#6-配置体系通用)。
> 这里只列**名称和取值范围**。

### Environment secrets

在 **Settings → Environments → `python_glados_checkin` → Environment secrets** 中添加：

| 名称 | 必填 | 说明 |
|---|---|---|
| `COOKIES` | ✅ | 账号 Cookie，**每行一个**，与 `DOMAINS` 按行一一对应 |
| `PUSHDEER_SENDKEY` | 选填 | 不填则跳过推送，仅输出日志 |

### Environment variables

在 **Settings → Environments → `python_glados_checkin` → Environment variables** 中添加：

| 名称 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `DOMAINS` | ✅ | 如 `glados.cloud` / `railgun.info` | 签到域名，**每行一个**，行数必须与 `COOKIES` 一致 |
| `GLADOS_EXCHANGE_PLAN` | 选填 | `plan100` / `plan200` / `plan500` | 兑换计划。**留空 = 不兑换**；填了非法值也不兑换 |
| `GLADOS_VERBOSE` | 选填 | `true`/`1`/`yes`/`y`、`false`/`0`/`no`/`n` | 是否输出详细日志，默认 `false` |

> ⚠️ 如果误建成 Secret，或 workflow 里的引用前缀写错（该用 `vars.` 却写了 `secrets.`），
> 会**静默解析成空字符串**并回退到默认值 —— **不会报错**。
> 用[根 README 第 8 节](../../README.md#8-跑完以后看什么)确认。

---

## 域名与 Cookie 格式

两个配置项**按行一一对应**：第 1 行域名 ↔ 第 1 行 Cookie。

**`DOMAINS`（Variable，每行一个域名）：**

```
glados.cloud
railgun.info
```

**`COOKIES`（Secret，每行一个账号的 Cookie）：**

```
koa:sess=AAA; koa:sess.sig=BBB
koa:sess=CCC; koa:sess.sig=DDD
```

**Cookie 怎么拿**：浏览器登录对应域名 → `F12` → **Application**（应用）→ **Cookies** →
选中该域名 → 复制**完整**的 cookie 字符串，形如 `koa:sess=xxx; koa:sess.sig=yyy`。

**同一个域名有多个账号**时，重复写域名即可：

| `DOMAINS` | `COOKIES` |
|---|---|
| `glados.cloud` | `koa:sess=A1; koa:sess.sig=B1` |
| `glados.cloud` | `koa:sess=A2; koa:sess.sig=B2` |
| `railgun.info` | `koa:sess=A3; koa:sess.sig=B3` |

### 为什么用换行分隔，而不是 `&`

Cookie 值本身含有 `;` `:` `=` `/`（见 `koa:sess=xxx; koa:sess.sig=yyy`），这些都不能当分隔符。
换行是**唯一保证不会出现在 cookie 里**的字符（HTTP header 值不允许 CR/LF），
而 GitHub secret 原生支持多行，直接粘贴就行。

> 解析用 `splitlines()`，所以粘贴时混进 CRLF 也没关系（不会残留 `\r` 把 cookie 弄坏）。
> 空行会被忽略，但**行数必须一致** —— 不一致脚本直接报错，避免错位把 A 站的 cookie 发到 B 站。

---

## 执行流程

```
读取 DOMAINS / COOKIES，按行配对成 N 个「域名 + 账号」任务
        ↓
对每个任务依次执行（域名取自该行）：
   1. GET  /api/user/status     查询剩余天数
   2. POST /api/user/checkin    执行签到（token = 该行域名）
   3. GET  /api/user/points     查询总积分
   4. POST /api/user/exchange   仅在配置了 GLADOS_EXCHANGE_PLAN 时才执行
        ↓
汇总所有任务结果 → 推送 PushDeer
```

**接口细节**（路径对两个域名一致，域名取自 `DOMAINS` 的对应行）：

| 步骤 | 方法 | 路径 | 请求体 |
|---|---|---|---|
| 查状态 | GET | `/api/user/status` | — |
| 签到 | POST | `/api/user/checkin` | `{"token": "<该行域名>"}` |
| 查积分 | GET | `/api/user/points` | — |
| 兑换 | POST | `/api/user/exchange` | `{"planType": "<兑换计划>"}` |

Cookie 通过请求头 `cookie` 传递，超时设置为连接 60 秒 / 读取 120 秒。

**兑换是可选步骤**：`GLADOS_EXCHANGE_PLAN` 留空（或填了非法值）时**完全不发起兑换请求**。
注意脚本**不校验积分是否够**，兑换成功与否完全由服务端返回决定。

**签到返回码含义**：

| code | 含义 |
|---|---|
| `0` | 签到成功 |
| `1` | 重复签到（今天已经签过） |
| `-2` | 签到失败 |

---

## 日志的详细程度

日志格式与摘要机制见[根 README「跑完以后看什么」](../../README.md#8-跑完以后看什么)。
本项目特有的只有一个开关 `GLADOS_VERBOSE`：

| 输出位置 | `false`（默认） | `true` |
|---|---|---|
| 接口成功响应详情 | 隐藏 | 显示原始 `{ code, points, message }` |
| 接口失败 / 异常 | **始终显示** | **始终显示** |
| 每个账号的成功结果 | 只显示状态 | 状态 + 积分 + 天数 + 兑换 |
| 最终日志总结块 | `#1 [glados.cloud] 签到成功` | 完整一行 |

**注意**：失败信息**不受** `GLADOS_VERBOSE` 影响，一定输出，所以平时用 `false` 不会漏掉问题。

### 推送内容

推送到 PushDeer，内容**始终是完整的**，不受 `GLADOS_VERBOSE` 影响：

```
标题：GLaDOS 签到, 成功1, 失败0, 重复0

#1 [glados.cloud] P:10 剩余:180 天 总积分:2100 积分 | 签到成功 | 兑换成功: plan500
```

---

## 常见问题

> 通用问题（变量没生效、Summary 是空的、调度器没触发……）见
> [根 README「常见问题（通用）」](../../README.md#10-常见问题通用)。下面是本项目专属的。

### ⚠️ 任务失败但 workflow 显示绿色

**这是已知行为**：`index.py` 的 `main()` 捕获了所有异常并正常返回，**从不调用 `sys.exit(1)`**。
所以即使签到全部失败、或者根本没找到 Cookie，退出码依然是 `0`。

**不要只看红绿**，要确认：

1. 日志里有没有 `========== 签到总结 ==========` 这一段
2. 推送内容里的成功 / 失败数量

如果需要让 workflow 真实反映结果，可以在 `main()` 末尾根据失败数量 `sys.exit(1)`。

### 日志出现 `环境变量 'GLADOS_VERBOSE' 的值 '' 无效`

说明该 Variable **没有配置**，被解析成了空字符串。

功能上**无影响**（最终用默认值 `false`），只是日志不干净。想让 warning 消失，把它显式设成 `false` 即可。

`GLADOS_EXCHANGE_PLAN` 未设置时也会打一条 warning，但那条**是有效行为** ——
留空就代表「明确不兑换」，脚本会跳过整个兑换步骤。不想兑换就别设它。

### 日志出现 `未找到有效的 Cookie, 退出程序`

`COOKIES` 为空，或格式不对导致切分后没有有效片段。检查：

- Secret 是否真的配置了（打开 `DEBUG_MODE` 后看自检表的 `LENGTH` 列是否为 0）
- Cookie 是否过期

### 日志出现 `域名与 Cookie 数量不一致`

`DOMAINS` 与 `COOKIES` 的**行数**不相等。两者是按行配对的，所以：

- 每个域名都要有对应的一行 cookie，反过来也是
- 同一个域名有多个账号时，**重复写域名**（不是把 cookie 合并成一行）

```
DOMAINS          COOKIES
glados.cloud     cookie1
glados.cloud     cookie2      ← 同一个域名的第 2 个账号
railgun.info     cookie3
```

常见原因：从旧的 `&` 分隔格式迁移过来时只改了 `COOKIES`，忘了补 `DOMAINS`。

### 兑换失败

兑换**完全由服务端判定**，本地不校验积分是否足够。
`required_points` 只用于日志，实际请求只发送 `{"planType": "<计划>"}`。

常见原因：积分不足、该计划已兑换过、计划名不支持。

把 `GLADOS_VERBOSE` 设为 `true` 能看到服务端返回的原始 `message`。

### 兑换没执行（结果里是「未兑换」）

说明 `GLADOS_EXCHANGE_PLAN` 没配置、或填了非法值。脚本**没拿到有效计划时不会发起兑换请求**，
这是刻意设计 —— 避免「没配」被当成「用默认计划」，也避免非法值把计划悄悄换成别的。

日志里会留下对应的 warning：

```
⚠️  环境变量 'GLADOS_EXCHANGE_PLAN' 未设置，本次不执行兑换（留空即明确表示不兑换）。
⚠️  环境变量 'GLADOS_EXCHANGE_PLAN' 的值 'plan999' 无效（可选：plan100 / plan200 / plan500），本次不执行兑换。
```

> ⚠️ **多域名时兑换策略要自己拿主意**：配了 `plan500` 之后，**每个「域名 + 账号」任务都会各兑换一次**。
> 如果 `glados.cloud` 和 `railgun.info` 背后是同一个账号、同一份积分，那就是重复兑换。
> 建议先只在一个域名上开兑换，确认两个站点的积分是不是同一份再决定。

### 怎么验证配置真的生效了

**方法一**：打开调试开关（`DEBUG_MODE=true`）重跑，看 `Check secrets` 步骤输出的表格。

**方法二**：看脚本启动日志，这几行**不受 verbose 影响**，一定输出，直接打印最终生效值：

```
ℹ️  共加载了 2 组 域名 / Cookie 用于签到。
ℹ️    #1 🌐 glados.cloud
ℹ️    #2 🌐 railgun.info
ℹ️  当前 GLADOS_EXCHANGE_PLAN: plan500。
ℹ️  当前 GLADOS_VERBOSE: False。
```

> 只打印域名，**不打印 cookie**。另外运行时会把每个 cookie 注册进日志遮蔽列表，
> 万一将来有代码把它打出来也会是 `***`。

### 本地怎么跑

```powershell
cd python/glados_checkin

pip install -r ../requirements.txt
pip install -r requirements.txt
```

**方式一：临时 export**（不落盘，关掉终端就没了）。本地没有 GitHub 的 vars / secrets，
所以下面这些都得自己设上：

```powershell
$env:DOMAINS = @"
glados.cloud
railgun.info
"@
$env:COOKIES = @"
koa:sess=AAA; koa:sess.sig=BBB
koa:sess=CCC; koa:sess.sig=DDD
"@

$env:GLADOS_EXCHANGE_PLAN = "plan500"   # 留空 = 不兑换
$env:GLADOS_VERBOSE       = "true"

python index.py
```

Linux / macOS：

```bash
cd python/glados_checkin
pip install -r ../requirements.txt && pip install -r requirements.txt

DOMAINS='glados.cloud' \
COOKIES='koa:sess=xxx; koa:sess.sig=yyy' \
GLADOS_EXCHANGE_PLAN=plan500 \
GLADOS_VERBOSE=true \
python index.py
```

本地调试建议开 `GLADOS_VERBOSE=true`，能看到每个接口的原始响应。

> 💡 不想每次 export 的话，可以把项目目录下的 `.env.example` 复制成 `.env` 填好 ——
> `index.py` 启动时会自己读它，把没设置或为空的项补上。

---

## 本项目相关文件

| 文件 | 作用 |
|---|---|
| `python/glados_checkin/index.py` | 入口脚本 |
| `python/glados_checkin/.env.example` | `.env` 模板（提交；只放占位符）。同目录的 `.env` 才是实际生效的那个，已被 gitignore |
| `.github/workflows/glados_checkin.yml` | 项目 workflow |
| `python/common/logging_config.py` | Python 语言级共享的日志初始化 |

> 通用层的 6 个 shell 脚本、总入口 workflow、`.gitignore` 等，见
> [根 README「文件速查」](../../README.md#11-文件速查)。
