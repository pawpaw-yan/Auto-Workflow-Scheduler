# oracle-abc

抢占 OCI（Oracle Cloud）Ampere A1 实例，抢到后自动停止并升级规格。

**流程**：先抢一台小规格（默认 `1 OCPU / 6 GB`）的 A1；抢到后**分步升级**——每轮把规格放大 `STEP_FACTOR` 倍（默认 ×2），升完立刻重新判断，直到达到目标 `TARGET`。

默认升级路径：

```
1c6g  →  2c12g  →  4c24g          （跳过 3c18g）
```

**为什么先抢小的**：A1 常年缺货，申请的规格越小越容易命中容量；抢到后再一路升上去。

**为什么分步而不是一次跳到位**：每一步都有独立的成功机会。直接跳到大规格如果失败，前面的努力就白费了；分步升则至少能停在某个已经成功的规格上。

---

## 目录结构

```
python/
├── requirements.txt        # 语言级公共依赖
├── common/                 # 语言级共享代码包
│   ├── __init__.py
│   └── logging_config.py   #   日志初始化（所有 Python 项目共用）
└── oracle-abc/
    ├── index.py            # 入口脚本
    ├── requirements.txt    # oci（OCI Python SDK）
    └── README.md
```

> `python/common/` 是 **Python 语言级共享代码包**，与仓库根的 `common/`（跨语言 shell 脚本）对称。
> 项目脚本位于 `python/<项目>/`，比包根 `python/` 深一层，因此 `index.py` 开头会先把 `python/`
> 加入 `sys.path`，再用 `from common.logging_config import init_logger` 引用——
> 这样无论从仓库根目录还是项目目录启动都能解析。

对应 workflow：`.github/workflows/oracle-abc.yml`
对应 Environment：`python_oracle_abc`

---

## 实现方式

用 **OCI Python SDK**（`oci` 包）实现，而不是调用 `oci` CLI：

| | oci CLI | OCI Python SDK（当前） |
|---|---|---|
| 额外安装 | 需要 `pip install oci-cli` | 随 `requirements.txt` 安装 `oci` |
| 解析输出 | 依赖 `jq`，靠文本 grep 判定 | 直接拿对象属性，靠异常类型判定 |
| 容量不足判定 | `grep -i capacity` 匹配 stderr 文本 | `ServiceError` 的 `code` / `message` / `status` |
| 等待状态迁移 | `--wait-for-state` | `*_and_wait_for_state` + waiter |

好处是**没有外部命令依赖**，错误判定不再依赖文本匹配，逻辑更稳。

---

## 配置

### Environment secret

在 **Settings → Environments → `python_oracle_abc` → Environment secrets** 中添加：

| 名称 | 必填 | 说明 |
|---|---|---|
| `OCI_CLI_KEY_CONTENT` | ✅ | OCI API 私钥的**完整内容**（PEM 全文，含 `-----BEGIN PRIVATE KEY-----` 和结尾行） |

> 这是**唯一**的真凭据。其余都是 OCID / 标识符，单独泄露无法用于认证。

### Environment variables

在 **Settings → Environments → `python_oracle_abc` → Environment variables** 中添加：

| 名称 | 必填 | 示例 / 获取方式 |
|---|---|---|
| `OCI_CLI_USER` | ✅ | 控制台右上角头像 → **My profile** → User information → OCID |
| `OCI_CLI_FINGERPRINT` | ✅ | My profile → **API keys** → 添加 key 后显示的指纹，形如 `20:3b:97:13:...` |
| `OCI_CLI_TENANCY` | ✅ | 控制台 → **Tenancy** 页 → OCID |
| `OCI_CLI_REGION` | ✅ | 区域标识，如 `ap-singapore-1`、`ap-tokyo-1` |
| `OCI_COMPARTMENT_ID` | ✅ | Identity → **Compartments** → 选中隔间 → OCID |
| `OCI_AVAILABILITY_DOMAIN` | ✅ | 如 `ocid1.availabilitydomain.oc1..xxx` 或 `xxxx:AP-SINGAPORE-1-AD-1` |
| `OCI_SUBNET_ID` | ✅ | Networking → VCN → 子网 → OCID（仅创建实例时需要） |
| `OCI_IMAGE_ID` | ✅ | 见下方「如何拿镜像 OCID」（仅创建实例时需要） |
| `OCI_INSTANCE_NAME` | 选填 | 默认 `oracle-abc`。查找和创建都用这个 display-name |
| `OCI_SSH_PUBLIC_KEY` | 选填 | 公钥内容（`~/.ssh/id_ed25519.pub`），用于创建时注入免密登录 |

另外还有三个控制「抢占 + 升级」的参数 `OCPU` / `MEMORY` / `TARGET`，同样放在这个 Environment 下，详见下方「可调参数」。

> 如果私钥带口令加密，需要额外加一个 secret `OCI_CLI_PASSPHRASE`，并在 `oracle-abc.yml` 里取消对应那行的注释。**私钥未加密时不要设置这个值**，否则会干扰解析。

### 如何拿镜像 OCID

任选其一：

**控制台**：Create Instance 页面选好镜像，页面底部会显示对应的 OCID。

**OCI CLI**（本机或 Cloud Shell）：

```bash
oci compute image list \
  --compartment-id <你的 tenancy OCID> \
  --operating-system "Canonical Ubuntu" \
  --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output
```

**Python SDK**：

```python
import oci
config = oci.config.from_file()
data = oci.core.ComputeClient(config).list_images(
    compartment_id="<tenancy OCID>",
    operating_system="Canonical Ubuntu",
    sort_by="TIMECREATED",
    sort_order="DESC",
).data
print(data[0].id)
```

---

## 触发方式

### 1. 通过总入口（推荐）

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/run-project.yml/dispatches
Authorization: Bearer <PAT>
Content-Type: application/json

{"ref":"main","inputs":{"project":"oracle-abc"}}
```

### 2. 直达本项目

```
POST https://api.github.com/repos/<owner>/<repo>/actions/workflows/oracle-abc.yml/dispatches
Authorization: Bearer <PAT>
Content-Type: application/json

{"ref":"main"}
```

### 3. Actions 页面手动

**Actions** → **oracle-abc** → **Run workflow**

### 建议的调度方式

用外部调度器（cron-job.org 等）**每 5 分钟**打一次上面的 URL。因为 A1 缺货是常态，单次抢不到很正常，靠高频重试提高命中率——**不要**指望 GitHub 自带的 cron，实测极不可靠。

---

## 执行流程

```
步骤 1  按 display-name 查找实例（排除 TERMINATED / TERMINATING）
步骤 2  不存在 → 尝试创建 OCPU / MEMORY 规格的 A1
            成功     → 继续
            容量不足 → 打警告，退出 0（等下次重试）
        已存在   → 跳过创建

步骤 3  升级循环（每轮都重新读取一次当前状态）
        ┌──────────────────────────────────────────────┐
        │  读当前 OCPU                                  │
        │    ≥ TARGET → 结束                            │
        │    否则 → 停止                                │
        │         → 升级到「当前 × STEP_FACTOR」        │
        │         → 启动                                │
        │         ↑ 升完立刻回到顶部重新判断            │
        └──────────────────────────────────────────────┘
```

**举例**：`OCPU=1`、`MEMORY=6`、`TARGET=4`（`STEP_FACTOR` 默认 2）

| 轮次 | 当前 | 升级到 | 内存 |
|---|---|---|---|
| 1 | 1c | 2c | 12 GB |
| 2 | 2c | **4c** | 24 GB |
| 3 | 4c | — | 已达 TARGET，结束 |

**跳过 `3c18g` 的原因**：每轮的目标是 `当前 × STEP_FACTOR`，超过 `TARGET` 就压到 `TARGET`，所以不会落在中间档位上。

> 把 `STEP_FACTOR` 设为 `1` 就退化成逐级 +1（1→2→3→4）。
> 若 `TARGET=3`，则路径为 1→2→3（`2 × 2 = 4` 超过 3，被压到 3）。
>
> 内存按 `MEMORY / OCPU` 的比例自动跟随（上例为每 OCPU 6 GB），可用 `MEMORY_PER_OCPU` 显式覆盖。

**幂等性**：脚本可以无脑反复执行。

| 当前状态 | 行为 |
|---|---|
| 还没抢到 | 尝试创建；失败则退出 0 |
| 抢到了但没到 TARGET | 分步升级（每轮 ×2），直到达标 |
| 已经达到 TARGET | **什么都不做**，直接退出 0 |
| 中间某轮是 STOPPED | 跳过停止，直接升级并启动 |

调度器可以一直打着，不会产生副作用。

**防死循环**：如果某一轮「调用成功返回但规格实际没变」（比如被平台限制），轮数上限会兜住并报错中止。上限为 `TARGET - OCPU + 2`（至少 3）。

---

## 退出码

| 退出码 | 场景 | 说明 |
|---|---|---|
| `0` | 抢到并升级成功 | 正常 |
| `0` | **没有容量，未抢到** | **预期内结果**，只打 `::warning::`。高频调度下这是常态，用非 0 会让 Actions 页满屏红色 |
| `0` | 已经是目标规格 | 无需操作 |
| `1` | 缺配置 / 认证失败 / OCI 调用异常 / 等待超时 | 需要处理 |

> 如果你希望在「没抢到」时也变红（比如配合告警），把 `index.py` 里 `try_launch()` 中那段 `warn(...)` 改成 `die(...)` 即可。
>
> 注意：脚本对**任何未预期异常**都会 `sys.exit(1)`，不会出现「任务实际失败但 workflow 显示绿色」的情况。

---

## 可调参数

### 三个主参数（GitHub Variables）

| GitHub Variable | 脚本变量 | 默认 | 说明 |
|---|---|---|---|
| `OCPU` | `GRAB_OCPUS` | `1` | 抢占时申请的 OCPU 数（越小越容易抢到） |
| `MEMORY` | `GRAB_MEMORY_GB` | `6` | 抢占时申请的内存（GB） |
| `TARGET` | `TARGET_OCPUS` | `2` | 升级的最终目标 OCPU 数 |

### 其他可选

| GitHub Variable | 脚本变量 | 默认 | 说明 |
|---|---|---|---|
| `STEP_FACTOR` | `STEP_FACTOR` | `2` | 每轮放大倍数。`2` = 翻倍（1c→2c→4c），`1` = 逐级 +1（1c→2c→3c→4c） |
| `MEMORY_PER_OCPU` | `MEMORY_PER_OCPU` | `MEMORY / OCPU` | 每个 OCPU 配多少 GB 内存 |
| — | `OCI_SHAPE` | `VM.Standard.A1.Flex` | 目标 shape |
| — | `OCI_BOOT_VOLUME_GB` | `50` | 引导卷大小 |
| — | `STOP_ACTION` | `SOFTSTOP` | `SOFTSTOP` 优雅关机 / `STOP` 直接断电 |

> Oracle Always Free 的 Ampere A1 额度是 **4 OCPU / 24 GB**（以官方为准）。
> 所以 `OCPU=1`、`MEMORY=6`、`TARGET=4` 时，最终会升到 `4c24g`，正好用满免费额度。

---

## 常见问题

### `NotAuthorizedOrNotFound` / `401`

认证配置不对。按顺序检查：

1. `OCI_CLI_KEY_CONTENT` 是否是**私钥全文**（不是公钥、不是指纹）
2. `OCI_CLI_FINGERPRINT` 是否和该私钥配对（在 OCI 控制台 My profile → API keys 里核对）
3. `OCI_CLI_USER` / `OCI_CLI_TENANCY` 是否填反了
4. 控制台看 `check_secrets` 表格的输出：`OCI_CLI_KEY_CONTENT` 的 `LENGTH` 为 0 就是没配上

> 报错信息形如 `OCI 调用失败：[401] NotAuthenticated — ...`，`[403] NotAuthorizedOrNotFound` 通常是权限或 OCID 填错。

### `Out of host capacity` / 一直抢不到

这是 A1 的常态，不是脚本问题。提高命中率的办法：

- **调小抢占规格**（`GRAB_OCPUS=1`、`GRAB_MEMORY_GB=6` 已经很小了）
- **提高触发频率**（外部调度器 1~5 分钟一次）
- **换可用域**（`OCI_AVAILABILITY_DOMAIN` 试其他 AD）

> A1 缺货时 OCI 返回的形态不统一：有的区域是 500 `InternalError` + "Out of host capacity."，有的区域 code 直接是 `OutOfHostCapacity`。`is_capacity_error()` 已同时覆盖这几种，所以不必担心被误判为失败。

### 升级时 `LimitExceeded`

目标规格超出了账号的服务限额（Always Free 是 4 OCPU / 24 GB）。把 `TARGET_OCPUS` 调小。

### 升级后启动失败

停止再启动的过程中，实例可能重新遇到容量问题。想规避这一点，可以改成**不主动停止**、直接 `update_instance`——据 Oracle 文档，运行时改 shape 会由平台自动重启实例；代价是可能触发非优雅关机，有数据损坏风险（这也是默认走 `SOFTSTOP` 的原因）。

### 脚本在本地怎么跑

```bash
export OCI_CLI_TENANCY=ocid1.tenancy.oc1..xxx
export OCI_CLI_USER=ocid1.user.oc1..xxx
export OCI_CLI_FINGERPRINT=xx:xx:xx:...
export OCI_CLI_KEY_FILE=~/.oci/oci_api_key.pem   # 本地用文件路径更方便
export OCI_CLI_REGION=ap-singapore-1

export OCI_COMPARTMENT_ID=ocid1.compartment.oc1..xxx
export OCI_AVAILABILITY_DOMAIN=xxxx:AP-SINGAPORE-1-AD-1
export OCI_SUBNET_ID=ocid1.subnet.oc1..xxx
export OCI_IMAGE_ID=ocid1.image.oc1..xxx
export OCI_INSTANCE_NAME=oracle-abc
export OCI_SSH_PUBLIC_KEY="$(cat ~/.ssh/id_ed25519.pub)"

pip install -r python/oracle-abc/requirements.txt
cd python/oracle-abc
python index.py
```

本地用 `OCI_CLI_KEY_FILE` 指定私钥路径，比把内容塞进环境变量方便。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `python/oracle-abc/index.py` | 入口脚本 |
| `python/common/logging_config.py` | **语言级共享**日志初始化 |
| `.github/workflows/oracle-abc.yml` | 项目 workflow |
| `.github/workflows/run-project.yml` | 总入口，按参数派发 |
| `common/install-deps.sh` | 安装依赖（公共 + 项目独有） |
| `common/check-secrets.sh` | 配置自检（secret 输出指纹、variables 输出明文） |
| `common/execute.sh` | 执行入口，输出同时写入日志和 `output.log` |
| `common/render-summary.sh` | 把 `output.log` 渲染成 Job Summary |
