<div align="center">

# Auto-Workflow-Scheduler

把各种「需要定时跑一次」的小任务，塞进 GitHub Actions 的免费额度里自动执行。

[![stars](https://img.shields.io/github/stars/pawpaw-yan/Auto-Workflow-Scheduler?style=flat&label=stars&color=yellow&logo=github)](https://github.com/pawpaw-yan/Auto-Workflow-Scheduler/stargazers)
[![forks](https://img.shields.io/github/forks/pawpaw-yan/Auto-Workflow-Scheduler?style=flat&label=forks&color=orange&logo=github)](https://github.com/pawpaw-yan/Auto-Workflow-Scheduler/forks)
[![issues](https://img.shields.io/github/issues/pawpaw-yan/Auto-Workflow-Scheduler?style=flat&label=issues&color=red&logo=github)](https://github.com/pawpaw-yan/Auto-Workflow-Scheduler/issues)
[![last commit](https://img.shields.io/github/last-commit/pawpaw-yan/Auto-Workflow-Scheduler?style=flat&label=last%20commit&color=green&logo=git)](https://github.com/pawpaw-yan/Auto-Workflow-Scheduler/commits/main)
[![code size](https://img.shields.io/github/languages/code-size/pawpaw-yan/Auto-Workflow-Scheduler?style=flat&label=code%20size&color=blue)](https://github.com/pawpaw-yan/Auto-Workflow-Scheduler)
[![license](https://img.shields.io/github/license/pawpaw-yan/Auto-Workflow-Scheduler?style=flat&label=license&color=green&logo=opensourceinitiative&logoColor=white)](https://github.com/pawpaw-yan/Auto-Workflow-Scheduler/blob/main/LICENSE)
[![Python](https://img.shields.io/badge/Python-3.13-3776AB?style=flat&logo=python&logoColor=white)](https://www.python.org/)
[![Shell](https://img.shields.io/badge/Shell-bash-4EAA25?style=flat&logo=gnubash&logoColor=white)](https://www.gnu.org/software/bash/)
[![Actions](https://img.shields.io/badge/GitHub%20Actions-enabled-2088FF?style=flat&logo=githubactions&logoColor=white)](https://github.com/pawpaw-yan/Auto-Workflow-Scheduler/actions)

</div>

比如：每天自动签到领积分、盯着一台总是缺货的免费云服务器一直抢。
它们都只需要偶尔跑一下、跑完就结束，用一台常驻服务器太浪费 —— 这个仓库就是干这个的。

---

## 目录

- [郑重提示：不要把机密写进 .env](#郑重提示不要把机密写进-env)
- [1. 这个仓库解决什么问题](#1-这个仓库解决什么问题)
- [2. 目前有哪些任务](#2-目前有哪些任务)
- [3. 整体结构](#3-整体结构)
- [4. 一次运行到底发生了什么（流程图）](#4-一次运行到底发生了什么流程图)
- [5. 快速开始（手把手）](#5-快速开始手把手)
- [6. 配置体系（通用）](#6-配置体系通用)
- [7. 怎么触发一次运行](#7-怎么触发一次运行)
- [8. 跑完以后看什么](#8-跑完以后看什么)
- [9. 新增一个任务](#9-新增一个任务)
- [10. 常见问题（通用）](#10-常见问题通用)
- [11. 文件速查](#11-文件速查)

---

## 郑重提示：不要把机密写进 .env

**cookie、API 私钥、token 这类凭据一律放 Secrets，不要写进 `.env`。**

`.env` 是明文文件，提交了就进 git 历史、删不干净；GitHub 的日志脱敏也只认 Secrets 的值，`.env` 里的不会被打码。

> 临时改配置请用[参数覆盖](#64-参数覆盖临时替换一次配置)。

---

## 1. 这个仓库解决什么问题

GitHub 自带的定时任务不准、还会被自动停用，所以改用**外部调度器定时打 API** 来触发 Actions 跑脚本 —— 服务器不用自己维护，每个任务互相隔离。

---

## 2. 目前有哪些任务

| 项目 | 语言 | 做什么 | 建议调度频率 |
|---|---|---|---|
| [`glados_checkin`](python/glados_checkin/README.md) | Python | GLaDOS / Railgun 自动签到（多域名多账号），可选自动兑换套餐 | 每天 1~2 次 |
| [`oracle-abc`](python/oracle-abc/README.md) | Python | 抢 Oracle Cloud 的免费 Ampere A1 实例，抢到后分步升级到目标规格 | 每 1~5 分钟 |

点项目名进各自的 README 看业务细节（要配哪些参数、脚本怎么跑、专属的常见问题）。

---

## 3. 整体结构

```
Auto-Workflow-Scheduler/
│
├── README.md                        通用说明（本文件）
├── common/                          ★ 跨语言共享的通用逻辑（shell 脚本）
├── .github/workflows/               run-project.yml 总入口 + 每个项目一个 workflow
└── python/                          ★ Python 语言目录
    ├── common/                      语言级共享代码
    ├── glados_checkin/              项目目录：GLaDOS / Railgun 签到
    └── oracle-abc/                  项目目录：抢 OCI Ampere A1
```

### 3.1 三个概念别搞混

| 概念 | 是什么 | 在哪 |
|---|---|---|
| **仓库根的 `common/`** | **跨语言**通用逻辑，shell 脚本，所有语言的项目都用 | `common/*.sh` |
| **`python/common/`** | **Python 语言级**共享代码，只有 Python 项目用 | `python/common/*.py` |
| **`python/<项目>/`** | 单个任务的全部内容（脚本 + 依赖 + 说明） | 一个任务一个目录 |

### 3.2 命名约定

- `.github/workflows/` 下**不以 `run-` 开头**的 `.yml` 就是一个项目，**文件名（去掉 `.yml`）就是项目名**
- `run-` 前缀保留给基础设施（目前只有总入口 `run-project.yml`）
- 项目名统一小写下划线（`glados_checkin`、`oracle-abc`），派发时会自动归一化（`glados-checkin` / `GLADOS_CHECKIN` / `glados_checkin.yml` 都认）

---

## 4. 一次运行到底发生了什么（流程图）

### 4.1 整体流程

```
外部调度器 / 手动 / API
      ↓
run-project.yml（总入口，把 project 参数解析成具体 workflow）
      ↓
<项目>.yml（只做声明：配置 + 调用 common/*.sh）
      ↓
① Apply overrides   → 把 inputs.overrides 写进环境
② Check secrets     → 配置自检（默认跳过，调试开关打开才跑）
③ Install deps      → 按语言装依赖
④ Run               → execute.sh 执行 index.py，输出同时进日志和 output.log
                      index.py 启动时自己读 .env，补上前两层空着的键
⑤ Job Summary       → render-summary.sh 把 output.log 渲染成摘要
```

### 4.2 配置是怎么一层层叠上去的

```
┌───────────────────────────────────────────────┐
│ ① ref      inputs.overrides（派发时传的 JSON） │  ← 最高优先级
├───────────────────────────────────────────────┤
│ ② vars / secrets   GitHub Environment 配置     │
├───────────────────────────────────────────────┤
│ ③ .env     <项目目录>/.env（本地兜底）         │  ← 最低优先级
└───────────────────────────────────────────────┘
                     ↓
        规则：下面两层只能填补上面空着的键
                     ↓
        最终进程环境变量（业务脚本读到的就是它）
```

对应到脚本：

| 层 | 由谁实现 | 怎么生效 |
|---|---|---|
| ① ref | `common/apply-overrides.sh` | 写进 `$GITHUB_ENV`，后续所有 step 都能读到 |
| ② vars / secrets | 项目 workflow 的 `env:` 块 | GitHub 一开始就注入到进程环境 |
| ③ .env | `python/common/dotenv.py` | 业务脚本**启动时自己读**，只在①②都为空时才写进 `os.environ` |

### 4.3 业务脚本内部（以签到为例）

```
读取配置，把「域名」和「Cookie」按行配成 N 个任务
      ↓
对每个任务依次执行：
  1. 查剩余天数
  2. 执行签到
  3. 查总积分
  4. （可选）兑换
      ↓
汇总所有任务结果 → 输出日志 + 推送
```

每个项目自己的流程图写在各自的 README 里。

---

## 5. 快速开始（手把手）

假设你已经把这个仓库 **fork** 到了自己的账号下，或者直接用了原仓库。下面以 `glados_checkin` 为例，`oracle-abc` 同理，只是配置项不同。

### 5.1 第一步：建一个 Environment

Environment 的作用是**把不同任务的真凭据隔离开** —— 签到用不到 OCI 私钥，抢服务器也用不到你的 cookie。

1. 打开你的仓库页面，点顶部的 **Settings**（设置）
2. 左侧菜单找到 **Environments**（环境）
3. 点 **New environment**
4. 名字填 **`python_glados_checkin`**（必须一字不差，workflow 里写死了这个名字）
5. 点 **Configure environment**

> 为什么要按项目建 Environment 而不是直接放仓库级？
> 因为 Environment 的 secrets 只在引用了这个 Environment 的 job 里可见，
> 万一哪个 workflow 被改坏了，也拿不到别的项目的凭据。

### 5.2 第二步：加 Secrets（敏感值）

在刚建好的 `python_glados_checkin` 页面里，找到 **Environment secrets**，点 **Add secret**。

以 `glados_checkin` 为例：

| Secret 名称 | 必填 | 填什么 |
|---|---|---|
| `COOKIES` | ✅ | 你的账号 Cookie，**每行一个**，和 `DOMAINS` 按行一一对应 |
| `PUSHDEER_SENDKEY` | 选填 | 推送密钥，不填就只输出日志、不推送 |

**Cookie 怎么拿**（`COOKIES` 的值）：

1. 浏览器登录对应站点
2. 按 `F12` 打开开发者工具
3. 切到 **Application**（应用）标签页
4. 左侧展开 **Cookies**，点中该站点
5. 找到并复制形如下面这一整串：

   ```
   koa:sess=xxxxx; koa:sess.sig=yyyyy
   ```

6. 如果有多个账号，**一行一个**粘进 Secret 输入框（Secret 支持多行）

> ⚠️ Cookie 就是你的登录凭据，**等同于账号密码**。所以它必须放 Secret，绝不能进 `.env`、不能提交进仓库。

### 5.3 第三步：加 Variables（非敏感值）

同一个页面往下找到 **Environment variables**，点 **Add variable**。

| Variable 名称 | 必填 | 填什么 | 示例 |
|---|---|---|---|
| `DOMAINS` | ✅ | 要签到的域名，**每行一个**，行数必须和 `COOKIES` 一致 | `glados.cloud` |
| `GLADOS_EXCHANGE_PLAN` | 选填 | 兑换计划。**留空 = 不兑换** | `plan500` |
| `GLADOS_VERBOSE` | 选填 | 是否输出详细日志 | `false` |

> **为什么这些放 Variables 而不是 Secrets？**
> 因为它们不是凭据 —— 域名、开关、计划名，就算被人看到也登不了你的账号。
> 放 Variables 的好处是排查问题时能直接明文看到实际值，非常省事。

### 5.4 第四步：跑一次验证

1. 打开仓库的 **Actions** 标签页
2. 左侧列表点 **glados_checkin**
3. 右边点 **Run workflow** 按钮，再点绿色的 **Run workflow**
4. 等十几秒，列表里会出现一次新的运行，点进去

**怎么判断成功了：**

- 点进运行详情，看 **Summary** 页 —— 应该能看到标题 + 一个默认展开的「完整输出」折叠块
- 展开折叠块，找有没有 `========== 签到总结 ==========` 这一段
- 有这一段，就说明脚本正常跑完了

> ⚠️ **重要**：这个项目的脚本**永远返回退出码 0**，所以即使全部账号签到失败，Actions 页面也是**绿色**的。
> **不要只看红绿**，一定要看日志内容。

### 5.5 第五步：挂上外部调度器

GitHub 自带的 cron 不可靠（见 1.1），所以用外部调度器来定时敲门。

以 **cron-job.org** 为例：

1. 注册并登录 cron-job.org
2. 点 **Create cronjob**
3. **Title** 随便填，比如 `glados-checkin`
4. **URL** 填：

   ```
   https://api.github.com/repos/<你的用户名>/<仓库名>/actions/workflows/run-project.yml/dispatches
   ```

5. **Schedule** 按需设置（签到每天 1~2 次即可；抢服务器建议每 1~5 分钟）
6. 展开 **Advanced** → **Request method** 选 **POST**
7. 在 **Headers** 里加两条：

   | Key | Value |
   |---|---|
   | `Authorization` | `Bearer <你的 GitHub PAT>` |
   | `Accept` | `application/vnd.github+json` |

8. 在 **Request body** 里填：

   ```json
   {"ref":"main","inputs":{"project":"glados_checkin"}}
   ```

9. 保存，点 **Test run** 验证一下

**PAT（Personal Access Token）怎么拿：**

1. GitHub 右上角头像 → **Settings**
2. 左下角 **Developer settings**
3. **Personal access tokens** → **Fine-grained tokens** → **Generate new token**
4. 权限只需要 **Actions: Read and write**（`fine-grained` 的 Repository permissions 里找）
5. 生成后**只显示一次**，马上复制保存

> 调度器会定期帮你打这个请求，所以 PAT 泄露等于别人能触发你的 workflow（但读不到你的 secrets）。
> 因此 token 权限给到最小即可，不要给 `repo` 全权限。

---

## 6. 配置体系（通用）

这一节是所有项目都适用的规则。各项目**要配哪些名字**，在各自的 README 里。

### 6.1 三层优先级

| 层 | 来源 | 典型用途 | 生效范围 |
|---|---|---|---|
| ①（最高） | 派发时的 `inputs.overrides`（JSON） | 临时试一次，不动仓库配置 | 仅本次运行 |
| ② | Environment 的 `secrets` / `vars` | 正式配置 | 长期 |
| ③（最低） | `<项目目录>/.env` | 运行期兜底默认值 | 本次运行 |

**规则一句话：下面两层只能填补上面空着的键，同名项一旦被上层提供了值，下层就失效。**

实现上就是 `python/common/dotenv.py` 那条「只填未设置或为空的键」：

```bash
if [ -n "${!name:-}" ]; then   # 上层已经给了非空值
  continue                     # → 跳过，不动
fi                             # 空 / 未设置 → 由 .env 补上
```

因为 ①② 走到这一步都已经在进程环境里了，「只填空位」天然就等于这个优先级，不需要额外排序。
附带好处：`.env` 不可能改坏 `PATH`、`GITHUB_*` 这类运行时变量（它们永远非空）。

> ⚠️ **「空字符串」被当作「没配置」**：GitHub 上把某个 Variable 留空或不建时，`${{ vars.X }}` 会展开成空字符串，
> 这个键就交给 `.env` 了。代价是**没法显式表达「这个键就是要空着」**。
> 只在本地跑（或自建 runner 保留了 `.env`）时才需要留意 —— CI 是干净检出，根本没有这个文件。

### 6.2 什么放 Secret、什么放 Variable

| 判断标准 | 放哪 |
|---|---|
| 拿到它就能**登录、调用、冒用你的身份** | **Secret** |
| 只是个名字 / 开关 / 数字，被人看到也无所谓 | **Variable** |

举例：

- cookie、API 私钥、token、密码 → **Secret**
- 域名、用户名、邮箱、开关、目标数量、计划名 → **Variable**

> ⚠️ **常见坑**：如果误把某个 Variable 建成了 Secret（或反过来，把引用前缀写错 —— 该用 `vars.` 却写了 `secrets.`），
> GitHub **不会报错**，只会静默解析成**空字符串**，然后代码回退到默认值。
> 表现就是「我明明配了，怎么没生效」。用第 8 节的配置自检来确认。

### 6.3 仓库级 vs Environment 级

| 级别 | 建在哪 | 谁可见 | 什么时候用 |
|---|---|---|---|
| **Environment 级** | Settings → Environments → `<环境名>` | 只在该 Environment 里 | **项目自己的配置**，默认都放这里 |
| **仓库级** | Settings → Secrets and variables → Actions | 所有 workflow | 多个项目共用的东西 |

本仓库目前只有一项**仓库级 secret**：

| 名称 | 必填 | 说明 |
|---|---|---|
| `COMMON_FINGERPRINT_KEY` | 选填 | 只供 `common/check-secrets.sh` 生成 HMAC 指纹，**自身永远不会被打印**。不填则自检表该列显示 `(skip: no key)` |

任意长随机字符串即可，生成方式（PowerShell）：

```powershell
(New-Guid).ToString('N') + (New-Guid).ToString('N')
```

> 为什么需要它？自检时 secret 不能明文输出，但又想判断「两次运行的 secret 是不是同一个」。
> 用带密钥的 HMAC 指纹就能做到：值不可见、不能离线爆破，但可稳定比对。

### 6.4 参数覆盖：临时替换一次配置

**场景**：想试试换个域名、换个目标规格，但不想改动仓库里已经配好的东西。

**怎么做**：派发时多传一个 `inputs.overrides`，值是一个 **JSON 对象**：

```json
{"ref":"main","inputs":{"overrides":"{\"DOMAINS\":\"glados.cloud\",\"GLADOS_VERBOSE\":\"true\"}"}}
```

如果值本身是多行（比如 cookie 列表、域名列表），在 JSON 里用 `\n` 转义：

```json
{"COOKIES": "koa:sess=AAA; koa:sess.sig=BBB\nkoa:sess=CCC; koa:sess.sig=DDD",
 "DOMAINS": "glados.cloud\nrailgun.info"}
```

**行为约定：**

| 点 | 说明 |
|---|---|
| 生效范围 | **只影响这一次运行**，仓库里的配置一个字节都不动 |
| 怎么实现的 | `common/apply-overrides.sh`，排在 checkout 之后、其余 step 之前，写进 `$GITHUB_ENV` |
| 白名单 | 只能覆盖 workflow 里登记过的项（默认取 `SECRET_NAMES` + `VARIABLE_NAMES`，可用 `OVERRIDE_NAMES` 单独指定）。越界直接报错 |
| 拒绝项 | `GITHUB_*` / `RUNNER_*` 一律拒绝 —— 防止有人通过覆盖把 runner 环境搞坏 |
| 值不回显 | 日志和摘要里**只列被替换的项名**，绝不显示值 |
| 摘要提示 | Job Summary 最上方会出现「本次运行替换了配置项」表格 |
| 留空 | 不传 / 传空串 / 传 `{}` → 整步跳过，完全使用仓库配置 |

> ⚠️ **`workflow_dispatch` 的 inputs 不是机密** —— 它会出现在 run 的详情页和事件详情里，公开仓库等于公开。
> 所以这个入口适合临时换域名、开关、目标数量这类**非敏感**配置；
> **不要拿它传 cookie / 私钥**。长期配置请老老实实放 `vars` / `secrets`。

**通过总入口传参**：`run-project.yml` 会把 `overrides` **原样转发**给被派发的项目。

```json
{"ref":"main","inputs":{"project":"glados_checkin","overrides":"{\"GLADOS_VERBOSE\":\"true\"}"}}
```

> 被派发的项目 workflow 必须声明 `inputs.overrides`，否则 GitHub 会返回 422。

### 6.5 本地 `.env` 层

**再次强调：这一层只用来放非敏感项，不要放凭据（见开头的郑重提示）。**

每个项目目录下都有一个 `.env.example` 模板（**提交进仓库**，只放占位符）。
想用的时候复制一份：

```bash
cp python/glados_checkin/.env.example python/glados_checkin/.env
```

同目录下的 `.env` 才是实际生效的那个，**已被 `.gitignore` 忽略**。

> ✅ 这一层由**业务脚本自己在启动时读取**（`python/common/dotenv.py`），本地和 CI 都生效。
> 因为它跑在最后，天生只能捡前两层剩下的空位。
>
> 它**只用来放非敏感项** —— 原因见开头的[郑重提示](#郑重提示不要把机密写进-env)。

**格式**：

| 写法 | 结果 |
|---|---|
| `KEY=VALUE` | 原样 |
| `KEY="A\nB"` | 双引号内的 `\n` 还原成**真换行**（多行值就靠它），首尾引号会被去掉 |
| `KEY='A\nB'` | 单引号内完全字面，不做任何转义 |
| `export KEY=VALUE` | `export` 前缀可有可无 |
| `# 注释` / 空行 | 会被忽略 |

> ⚠️ `.env` 里必须写**脚本真正读取的变量名**，不是 GitHub 上那个 Variable 的显示名。
> 有些项目两者不同名（workflow 里做了一层映射），写错**不会报错**，只是配置不生效。
> 具体对应关系看各项目 `.env.example` 里的注释。

---

## 7. 怎么触发一次运行

### 7.1 方式一：通过总入口（推荐）

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/run-project.yml/dispatches
Authorization: Bearer <PAT>
Content-Type: application/json

{"ref":"main","inputs":{"project":"glados_checkin"}}
```

好处：外部调度器只需要配**一个** URL，通过改 `project` 参数就能跑不同任务。

### 7.2 方式二：直达单个项目

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/<项目名>.yml/dispatches
Authorization: Bearer <PAT>
Content-Type: application/json

{"ref":"main"}
```

### 7.3 方式三：Actions 页面手动

**Actions** → 左侧选项目 → **Run workflow**（可以顺便填 `overrides`）

手动触发不需要 PAT，适合调试。

### 7.4 建议的调度方式

| 项目类型 | 建议频率 | 原因 |
|---|---|---|
| 签到类 | 每天 1~2 次 | 一天签一次就够了，多打无益 |
| 抢购类（如 oracle-abc） | 每 1~5 分钟 | 缺货是常态，靠高频重试提高命中率 |

---

## 8. 跑完以后看什么

- **日志**：格式统一为 `时间 | 级别 | 内容`；执行完 `render-summary.sh` 会把输出渲染进 **Job Summary**，不用点日志 Tab。
- **配置没生效**：把 `DEBUG_MODE` 设为 `true` 重跑，`Check secrets` 会打印自检表 —— `EMPTY=yes` 或 `LENGTH=0` 就是没注进去（secret 只显示 HMAC 指纹，不打明文）。用完关掉。

---

## 9. 新增一个任务

以新增 `python/xxx_checkin` 为例：

### 9.1 建目录和脚本

```
python/xxx_checkin/
├── index.py            入口脚本（业务逻辑）
├── requirements.txt    项目独有依赖（没有就空着）
├── .env.example        .env 模板（只放占位符）
└── README.md           业务说明
```

`index.py` 开头记得插 `sys.path`，才能用语言级共享包：

```python
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(_HERE))  # python/
sys.path.insert(0, _HERE)                   # 项目自身

from common.logging_config import init_logger

logger = init_logger("xxx_checkin")
```

### 9.2 复制一个 workflow

复制 `.github/workflows/glados_checkin.yml`，改**四处**：

| 改什么 | 改成 |
|---|---|
| `name:` | 项目名（比如 `xxx_checkin`） |
| `concurrency.group:` | 项目名（保证同一个任务不会并发跑） |
| `environment.name:` | 你要用的 Environment 名 |
| `env: ENV_NAME / PROJECT / ENTRY` | 对应的环境名 / 项目目录名 / 入口脚本路径 |

### 9.3 别漏掉这几行

复制完检查一下有没有这些（它们是「通用层」生效的前提）：

```yaml
# 1. 声明 inputs.overrides，否则总入口转发参数会 422
on:
  workflow_dispatch:
    inputs:
      overrides:
        required: false
        default: ''
        type: string

# 2. 调试开关的桥接（漏了会出现「设了开关没反应」）
DEBUG_MODE:        ${{ vars.DEBUG_MODE }}
COMMON_DEBUG_MODE: ${{ vars.COMMON_DEBUG_MODE }}

# 3. 参数覆盖的入口
OVERRIDES: ${{ inputs.overrides }}

# 4. 自检清单（同时也是参数覆盖的白名单）
SECRET_NAMES:   "..."
VARIABLE_NAMES: "..."
```

### 9.4 加 step

`.env` 不用管 —— 它由业务脚本自己在启动时读取（`python/common/dotenv.py`），workflow 里不需要额外步骤。

```yaml
steps:
  - uses: actions/checkout@v4

  - name: Apply overrides          # 必须在最前面
    run: bash common/apply-overrides.sh

  # ... 中间的 setup / install / check ...

  - name: Run
    run: bash common/execute.sh
```

### 9.5 建 Environment 并配好 secrets / variables

见[第 5 章](#5-快速开始手把手)。名字要和 workflow 里写的一致。

### 9.6 验证清单

- [ ] Actions 页面能看到这个 workflow
- [ ] 手动跑一次，**Apply overrides** 这个 step 显示跳过（绿色）而不是报错
- [ ] `Run` 有输出，`Job Summary` 有内容
- [ ] 打开 `DEBUG_MODE` 重跑一次，自检表里每一项 `EMPTY` 都是 `no`

---

## 10. 常见问题（通用）

### 10.1 我在 GitHub 上配了变量，但脚本没读到

按顺序排查：

1. **名字对不对** —— 大小写不敏感，但拼写必须一致
2. **放对地方了吗** —— 是建在对应的 Environment 下，还是建成了仓库级？
3. **workflow 里有没有那行 `env:` 桥接** —— 脚本只认进程环境变量，GitHub 的 Variables 必须靠 `env:` 那一行映射进来，漏了就是空的
4. **前缀写错了吗** —— 该用 `vars.` 却写了 `secrets.`（或反过来），GitHub **不报错**，只会给空字符串
5. **打开 `DEBUG_MODE` 重跑**，看自检表的 `EMPTY` / `LENGTH` 列（见第 8 节）

### 10.2 任务失败但 workflow 显示绿色

**这是本仓库的已知设计行为。**

业务脚本的 `main()` 捕获了所有异常并正常返回，**从不调用 `sys.exit(1)`**。
所以即使业务全部失败，退出码也是 `0`，workflow 会显示成功。

**原因**：签到这类任务的「没抢到 / 已签过」都是预期内结果，如果变成红色，
Actions 页面会满屏红色，真正的异常反而看不出来。

**所以不要只看红绿，要看内容：**

1. Summary 页或日志里，有没有业务脚本自己的「总结」段
2. 推送内容里的成功 / 失败数量

> 例外：`oracle-abc` 对**任何未预期异常**都会 `sys.exit(1)`，所以「配置错 / 认证失败 / 调用异常」是会变红的，
> 只有「没抢到容量」才是绿色。

### 10.3 怎么确认配置真的生效了

**方法一**：打开调试开关（`DEBUG_MODE=true`）重跑，看 `Check secrets` 输出的表格（见第 8 节）

**方法二**：看脚本自己的启动日志。好的脚本会把最终生效值打出来，比如：

```
ℹ️  共加载了 2 组 域名 / Cookie 用于签到。
ℹ️    #1 🌐 glados.cloud
ℹ️    #2 🌐 railgun.info
```

只打域名这类非敏感信息，**不打凭据**。

### 10.4 Summary 页是空的

1. `Run` 这个 step 是否真的产生了输出？（点进日志看）
2. `Job Summary` 这个 step 有没有 `if: always()`？（漏了的话 `Run` 失败时摘要不会写）
3. 本地跑时没有 `GITHUB_STEP_SUMMARY` 环境变量，摘要会自动跳过 —— 这是正常的

### 10.5 外部调度器一直没触发

1. 在调度器里点 **Test run**，看返回的 HTTP 状态码
2. `401` / `403` → PAT 无效、过期，或权限不够（需要 `Actions: Read and write`）
3. `404` → URL 里的用户名 / 仓库名写错
4. `422` → 请求体格式不对，或者项目 workflow 没声明对应的 `inputs`
5. 都是 `200` / `204` 但 Actions 没新运行 → 去仓库的 **Settings → Actions → General** 检查有没有被限制

### 10.6 不小心把机密提交进仓库了

1. **第一件事：立刻去对应的服务改密码 / 重新生成 token** —— 撤销泄露的那个凭据
2. 再去处理 git 历史（`git filter-repo`、BFG 等）
3. **不要只做第 2 步**：历史清理很麻烦且不保证彻底，撤销凭据才是唯一有效的补救

---

## 11. 文件速查

### 11.1 通用层 `common/`

| 文件 | 作用 | 什么时候跑 |
|---|---|---|
| `install-deps.sh` | 按语言装依赖（语言级公共 + 项目独有，两级） | 每个项目都跑 |
| `check-secrets.sh` | 配置自检：secret 出 HMAC 指纹，variable 出明文 | **默认跳过**，开调试开关才跑 |
| `apply-overrides.sh` | 参数覆盖（最高优先级）：把 `inputs.overrides` 注入本次运行 | 每个项目都跑（没传参数则跳过） |
| `execute.sh` | 按入口扩展名执行脚本，输出 `tee` 到 `output.log` | 每个项目都跑 |
| `render-summary.sh` | 把 `output.log` 渲染成 Job Summary | 每个项目都跑（建议 `if: always()`） |

### 11.2 workflow

| 文件 | 作用 |
|---|---|
| `run-project.yml` | 总入口，按 `project` 参数派发到具体项目（同时也是 `overrides` 的转发者） |
| `<项目名>.yml` | 项目 workflow，只做「声明」：配置 + 调用 `common/*.sh` |

### 11.3 各项目

| 项目 | 说明文档 |
|---|---|
| `glados_checkin` | [python/glados_checkin/README.md](python/glados_checkin/README.md) |
| `oracle-abc` | [python/oracle-abc/README.md](python/oracle-abc/README.md) |

### 11.4 其他

| 文件 | 作用 |
|---|---|
| `python/common/logging_config.py` | Python 语言级共享的日志初始化（stdout、UTF-8、统一格式） |
| `python/common/dotenv.py` | Python 语言级共享的 `.env` 读取（最低优先级配置层） |
| `.gitignore` | 忽略 `output.log` 和 `.env`（**不**忽略 `.env.example`） |
