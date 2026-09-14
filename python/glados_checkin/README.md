# glados_checkin

GLaDOS（glados.cloud）自动签到，支持多账号、自动兑换、结果推送。

每个 Cookie（账号）依次执行 **查状态 → 签到 → 查积分 → 兑换**，最后把汇总结果推送到 PushDeer。

---

## 目录结构

```
python/
├── requirements.txt              # 语言级公共依赖（pypushdeer）
├── logging_config.py             # 语言级共享日志初始化（所有 Python 项目共用）
└── glados_checkin/
    ├── index.py                  # 入口脚本
    ├── requirements.txt          # 项目独有依赖（requests）
    └── README.md
```

> `logging_config.py` 是**所有 Python 项目共用**的模块，放在 `python/` 下（与 `requirements.txt` 同级）。
> 项目脚本位于 `python/<项目>/`，比它深一层，因此 `index.py` 开头会先把上层目录加入 `sys.path` 再 import——
> 这样无论从仓库根目录还是项目目录启动都能解析。

对应 workflow：`.github/workflows/glados_checkin.yml`
对应 Environment：`python_glados_checkin`

---

## 配置

### Environment secrets

在 **Settings → Environments → `python_glados_checkin` → Environment secrets** 中添加：

| 名称 | 必填 | 说明 |
|---|---|---|
| `GLADOS_COOKIES` | ✅ | 账号 Cookie，多账号用 `&` 分隔 |
| `PUSHDEER_SENDKEY` | 选填 | 不填则跳过推送，仅输出日志 |

### Environment variables

在 **Settings → Environments → `python_glados_checkin` → Environment variables** 中添加：

| 名称 | 默认值 | 可选值 | 说明 |
|---|---|---|---|
| `GLADOS_EXCHANGE_PLAN` | `plan500` | `plan100` / `plan200` / `plan500` | 兑换计划 |
| `GLADOS_VERBOSE` | `false` | `true`/`1`/`yes`/`y`、`false`/`0`/`no`/`n` | 是否输出详细日志 |

> **这两个是非敏感配置，故意放在 Variables 而不是 Secrets**——Variables 在日志里明文可见，排查时能直接确认值有没有生效。
>
> ⚠️ 如果误建成 Secret，或者 workflow 里的引用前缀写错（该用 `vars.` 却写了 `secrets.`），会**静默解析成空字符串**并回退到默认值——**不会报错**。用下面的"验证配置是否生效"一节确认。

### 仓库级 secret

在 **Settings → Secrets and variables → Actions → Secrets** 中添加：

| 名称 | 必填 | 说明 |
|---|---|---|
| `COMMON_FINGERPRINT_KEY` | 选填 | 供 `common/check-secrets.sh` 生成 HMAC 指纹，自身绝不打印。不填则该列显示 `(skip: no key)` |

任意随机字符串即可，生成方式（PowerShell）：

```powershell
(New-Guid).ToString('N') + (New-Guid).ToString('N')
```

---

## Cookie 格式

1. 浏览器登录 glados.cloud
2. 按 `F12` → **Application**（应用）→ **Cookies** → `https://glados.cloud`
3. 复制**完整**的 cookie 字符串，形如：

```
koa:sess=xxx; koa:sess.sig=yyy
```

**多账号用 `&` 分隔**（脚本按 `&` 切分）：

```
koa:sess=AAA; koa:sess.sig=BBB&koa:sess=CCC; koa:sess.sig=DDD
```

每个片段会自动 `strip()`，所以 `&` 两边加不加空格都可以。

---

## 触发方式

### 1. 通过总入口（推荐）

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/run-project.yml/dispatches
Authorization: Bearer <PAT>
Content-Type: application/json

{"ref":"main","inputs":{"project":"glados_checkin"}}
```

### 2. 直达本项目

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/glados_checkin.yml/dispatches
Authorization: Bearer <PAT>
Content-Type: application/json

{"ref":"main"}
```

### 3. Actions 页面手动

**Actions** → **glados_checkin** → **Run workflow**

---

## 执行流程

```
读取 GLADOS_COOKIES，按 & 切分成 N 个账号
        ↓
对每个账号依次执行：
   1. GET  /api/user/status     查询剩余天数
   2. POST /api/user/checkin    执行签到
   3. GET  /api/user/points     查询总积分
   4. POST /api/user/exchange   按 GLADOS_EXCHANGE_PLAN 兑换
        ↓
汇总所有账号结果 → 推送 PushDeer
```

**接口细节**（域名固定为 `glados.cloud`）：

| 步骤 | 方法 | 路径 | 请求体 |
|---|---|---|---|
| 查状态 | GET | `/api/user/status` | — |
| 签到 | POST | `/api/user/checkin` | `{"token": "glados.cloud"}` |
| 查积分 | GET | `/api/user/points` | — |
| 兑换 | POST | `/api/user/exchange` | `{"planType": "<兑换计划>"}` |

Cookie 通过请求头 `cookie` 传递，超时设置为连接 60 秒 / 读取 120 秒。

**签到返回码含义**：

| code | 含义 |
|---|---|
| `0` | 签到成功 |
| `1` | 重复签到（今天已经签过） |
| `-2` | 签到失败 |

---

## 输出

### 日志

格式：`YYYY-MM-DD HH:MM:SS | LEVEL   | message`

`GLADOS_VERBOSE` 控制详细程度：

| 输出位置 | `false`（默认） | `true` |
|---|---|---|
| 接口成功响应详情 | 隐藏 | 显示原始 `{ code, points, message }` |
| 接口失败 / 异常 | **始终显示** | **始终显示** |
| 每个账号的成功结果 | 只显示状态 | 状态 + 积分 + 天数 + 兑换 |
| 最终日志总结块 | `#1 签到成功` | 完整一行 |

**注意**：失败信息**不受** `GLADOS_VERBOSE` 影响，一定输出，所以平时用 `false` 不会漏掉问题。

### 推送

推送到 PushDeer，内容**始终是完整的**，不受 `GLADOS_VERBOSE` 影响：

```
标题：GLaDOS 签到, 成功1, 失败0, 重复0

#1 P:10 剩余:180 天 总积分:2100 积分 | 签到成功 | 兑换成功: plan500
```

### 执行摘要（Job Summary）

`index.py` **不需要做任何改动**——它照常往 stdout 打日志。摘要由 workflow 层负责，分两步：

| 步骤 | 脚本 | 做什么 |
|---|---|---|
| `Run` | `common/execute.sh` | 执行 `index.py`，用 `tee` 把输出**同时**写进日志和 `<项目目录>/output.log`（日志仍实时可见） |
| `Job Summary` | `common/render-summary.sh` | 读取 `output.log`，包成 Markdown 写进 `$GITHUB_STEP_SUMMARY`，显示在 run 的 Summary 页 |

对应的 workflow 片段：

```yaml
- name: Run
  run: bash common/execute.sh

- name: Job Summary
  if: always()          # 失败时也要把已产生的输出带出来
  env:
    SUMMARY_TITLE: GLaDOS 签到
  run: bash common/render-summary.sh
```

Summary 页顶部会出现「GLaDOS 签到」标题 + 一个**默认展开**的「完整输出（N 行）」折叠块，内容是 `index.py` 的原始日志。这样不用点进日志 Tab，在 run 列表页就能直接看到输出。

**设计要点：**

| 点 | 说明 |
|---|---|
| 业务脚本零耦合 | `index.py` 完全不知道 GitHub Actions 的存在，本地与 CI 行为一致 |
| 通用 | 任何项目只要经 `execute.sh` 执行，就能用 `render-summary.sh` 出摘要 |
| 失败也有摘要 | 独立 step + `if: always()`，`Run` 失败时已产生的输出不会丢 |
| 本地静默跳过 | 没有 `GITHUB_STEP_SUMMARY` 时直接跳过，不报错 |

`output.log` 已加入 `.gitignore`。

### 配置自检

`common/check-secrets.sh` 会输出一张自检表，**并按类型采用不同展示方式**：

```
Environment : python_glados_checkin

NAME                     TYPE      EMPTY   LENGTH    VALUE / FINGERPRINT
------------------------ --------- ------- --------- --------------------
GLADOS_COOKIES           secret    no      135       fdc2b45c76e7
PUSHDEER_SENDKEY         secret    yes     0         -
GLADOS_EXCHANGE_PLAN     variable  no      7         plan500
GLADOS_VERBOSE           variable  no      4         true
```

| 类型 | 展示内容 | 原因 |
|---|---|---|
| `secret` | HMAC-SHA256 指纹（前 12 位） | 值本身不可见，指纹可以跨环境 / 跨运行比对，且没有密钥无法离线爆破 |
| `variable` | **明文值** | 本来就是公开配置，直接看值比看指纹直观，指纹对它没有意义 |

**指纹的用途**：同一 secret 在不同环境里指纹相同 → 配的是同一个值；同一环境跨运行指纹变了 → 说明有人改过这个 secret。

自检范围由 workflow 里的两个变量控制：

```yaml
SECRET_NAMES:   "GLADOS_COOKIES PUSHDEER_SENDKEY"
VARIABLE_NAMES: "GLADOS_EXCHANGE_PLAN GLADOS_VERBOSE"
```

> 新增配置项时，记得同时把名字加到对应的这一类里，否则不会被自检。

---

## 本地运行

```powershell
cd python/glados_checkin

# 装依赖：先公共、后项目独有
pip install -r ../requirements.txt
pip install -r requirements.txt

# 设环境变量
$env:GLADOS_COOKIES       = "koa:sess=xxx; koa:sess.sig=yyy"
$env:GLADOS_EXCHANGE_PLAN = "plan500"
$env:GLADOS_VERBOSE       = "true"
$env:PUSHDEER_SENDKEY     = ""

python index.py
```

Linux / macOS：

```bash
cd python/glados_checkin
pip install -r ../requirements.txt && pip install -r requirements.txt

GLADOS_COOKIES='koa:sess=xxx; koa:sess.sig=yyy' \
GLADOS_EXCHANGE_PLAN=plan500 \
GLADOS_VERBOSE=true \
python index.py
```

本地调试建议开 `GLADOS_VERBOSE=true`，能看到每个接口的原始响应。

---

## 常见问题

### ⚠️ 任务失败但 workflow 显示绿色

**这是当前已知行为。** `index.py` 的 `main()` 捕获了所有异常并正常返回，**从不调用 `sys.exit(1)`**。所以即使签到全部失败、或者根本没找到 Cookie，脚本的退出码依然是 `0`，workflow 会显示成功。

因此**不要只看 workflow 的红绿**，要确认：

1. 日志里有没有 `========== 签到总结 ==========` 这一段
2. 推送内容里的成功 / 失败数量

如果需要让 workflow 真实反映结果，可以在 `main()` 末尾根据失败数量 `sys.exit(1)`。

### 日志出现 `环境变量 'GLADOS_VERBOSE' 的值 '' 无效`

说明该 secret / variable **没有配置**，被解析成了空字符串。

功能上**无影响**（最终用默认值 `false`），只是日志不干净。想让 warning 消失，把 `GLADOS_VERBOSE` 显式设成 `false` 即可（`GLADOS_EXCHANGE_PLAN` 同理，设成 `plan500`）。

### 日志出现 `未找到有效的 Cookie, 退出程序`

`GLADOS_COOKIES` 为空，或格式不对导致切分后没有有效片段。检查：

- secret 是否真的配置了（看 `Check secrets` 表格的 `LENGTH` 列是否为 0）
- Cookie 是否过期

### 兑换失败

兑换**完全由服务端判定**，本地不校验积分是否足够。`required_points` 只用于日志，实际请求只发送 `{"planType": "<计划>"}`。

常见原因：积分不足、该计划已兑换过、计划名不支持。

把 `GLADOS_VERBOSE` 设为 `true` 能看到服务端返回的原始 `message`。

### 怎么验证配置真的生效了

**方法一**：看 `Check secrets` 步骤输出的表格

| 现象 | 含义 |
|---|---|
| `EMPTY` 为 `yes`、`LENGTH` 为 `0` | **没注入成功**——没建、名字拼错、或引用前缀写错 |
| `variable` 行显示明文值（如 `plan500`、`true`） | 注入成功，显示的就是生效值 |
| `secret` 行有 12 位指纹 | 注入成功（值不可见，只能靠指纹比对是否被改过） |

**方法二**：看 Python 启动日志，这几行**不受 verbose 影响**，一定输出，直接打印最终生效值：

```
ℹ️  当前 GLADOS_EXCHANGE_PLAN: plan500。
ℹ️  当前 GLADOS_VERBOSE: False。
```

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `python/glados_checkin/index.py` | 入口脚本 |
| `python/logging_config.py` | **语言级共享**日志初始化（stdout，UTF-8，格式见上） |
| `.github/workflows/glados_checkin.yml` | 项目 workflow |
| `.github/workflows/run-project.yml` | 总入口，按参数派发 |
| `common/install-deps.sh` | 依赖安装 |
| `common/check-secrets.sh` | 配置自检（secrets 输出指纹、variables 输出明文） |
| `common/execute.sh` | 按入口扩展名执行，输出同时写入日志和 `output.log` |
| `common/render-summary.sh` | 把 `output.log` 渲染成 Job Summary |
