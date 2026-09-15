# oracle-abc

抢占 OCI（Oracle Cloud）Ampere A1 免费实例，抢到后自动停止并升级规格。

> **本文件只讲这个项目自己的东西** —— OCI 怎么配、抢购策略、专属的坑。
>
> 通用机制（项目结构、配置三层优先级、怎么触发、参数覆盖、`.env`、摘要与配置自检、本地运行）
> 全部写在[仓库根 README](../../README.md) 里，这里不重复。

| | |
|---|---|
| 对应 workflow | `.github/workflows/oracle-abc.yml` |
| 对应 Environment | `python_oracle_abc` |
| 入口脚本 | `python/oracle-abc/index.py` |
| 建议调度频率 | 每 1~5 分钟 |

---

## 这个项目做什么

A1 常年缺货，**申请的规格越小越容易命中容量**。所以策略是：

1. 先抢一台小规格（默认 `1 OCPU / 6 GB`）
2. 抢到后**分步升级** —— 每轮把规格放大 `STEP_FACTOR` 倍（默认 ×2）
3. 每升完一轮**立刻重新判断**，直到达到目标 `TARGET`

默认升级路径：

```
1c6g  →  2c12g  →  4c24g          （跳过 3c18g）
```

**为什么分步而不是一次跳到位**：每一步都有独立的成功机会。
直接跳到大规格如果失败，前面的努力就白费了；分步升则至少能停在某个已经成功的规格上。

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

> 三层优先级规则、什么该放 Secret 什么该放 Variable、Environment 怎么建，
> 见[根 README「配置体系」](../../README.md#6-配置体系通用)。
> 这里只列**名称和怎么拿**。

### Environment secret

在 **Settings → Environments → `python_oracle_abc` → Environment secrets** 中添加：

| 名称 | 必填 | 说明 |
|---|---|---|
| `OCI_CLI_KEY_CONTENT` | ✅ | OCI API 私钥的**完整内容**（PEM 全文，含 `-----BEGIN PRIVATE KEY-----` 和结尾行） |

> 这是**唯一**的真凭据。其余都是 OCID / 标识符，单独泄露无法用于认证。

> 如果私钥带口令加密，需要额外加一个 secret `OCI_CLI_PASSPHRASE`，
> 并在 `oracle-abc.yml` 里取消对应那行的注释。**私钥未加密时不要设置这个值**，否则会干扰解析。

### Environment variables

在 **Settings → Environments → `python_oracle_abc` → Environment variables** 中添加：

| 名称 | 必填 | 示例 / 获取方式 |
|---|---|---|
| `OCI_CLI_USER` | ✅ | 控制台右上角头像 → **My profile** → User information → OCID |
| `OCI_CLI_FINGERPRINT` | ✅ | My profile → **API keys** → 添加 key 后显示的指纹，形如 `20:3b:97:13:...` |
| `OCI_CLI_TENANCY` | ✅ | 控制台 → **Tenancy** 页 → OCID |
| `OCI_CLI_REGION` | ✅ | 区域标识，如 `ap-singapore-1`、`ap-tokyo-1` |
| `OCI_COMPARTMENT_ID` | ✅ | Identity → **Compartments** → 选中隔间 → OCID |
| `OCI_AVAILABILITY_DOMAIN` | ✅ | 见下方「可用域怎么拿」 |
| `OCI_SUBNET_ID` | ✅ | Networking → VCN → 子网 → OCID（**仅创建实例时需要**） |
| `OCI_IMAGE_ID` | ✅ | 见下方「镜像 OCID 怎么拿」（**仅创建实例时需要**） |
| `OCI_INSTANCE_NAME` | 选填 | 默认 `oracle-abc`。查找和创建都用这个 display-name |
| `OCI_SSH_PUBLIC_KEY` | ✅ | SSH 公钥**全文**（`~/.ssh/id_ed25519.pub` 的内容，可多行）。创建时注入；**不填实例建出来无法登录** |

另外还有三个控制「抢占 + 升级」的参数 `OCPU` / `MEMORY` / `TARGET`，同样放在这个 Environment 下，
详见下方[「可调参数」](#可调参数)。

### 可用域怎么拿（`OCI_AVAILABILITY_DOMAIN`）

**不能直接填 `AP-SINGAPORE-1-AD-1`。** OCI 的可用域名字带一个**该租户特有的随机前缀**，
形如 `xxxx:AP-SINGAPORE-1-AD-1`，猜不出来，必须查。

**最省事的办法：用控制台自带的 Cloud Shell**（不用装任何东西）：

1. 登录 OCI 控制台，右上角找到终端图标 `>_`（**Developer Tools → Cloud Shell**）
2. 点开，直接粘贴：

   ```bash
   oci iam availability-domain list \
     --compartment-id <你的 tenancy OCID> \
     --query 'data[].{name:name, id:id}' --output table
   ```

   返回里的 `name` 就是可以直接填的值。

**或者纯网页操作**：

- `Compute → Instances → Create instance`，滚到 **Placement / 放置** 一栏，
  **Availability domain 下拉**里显示的就是（**注意带冒号前面的前缀**）
- 已有实例的话更准：进实例详情页 → **Instance information** → `Availability domain` 字段，
  这里显示的就是 OCI 真正认的那个完整字符串

### 镜像 OCID 怎么拿（`OCI_IMAGE_ID`）

**同样推荐用控制台自带的 Cloud Shell**：

```bash
# Oracle Linux（A1 是 ARM，必须带 --shape 过滤，否则会选到 x86 镜像）
oci compute image list \
  --compartment-id <你的 tenancy OCID> \
  --operating-system "Oracle Linux" \
  --shape VM.Standard.A1.Flex \
  --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output
```

想先看清楚有哪些版本，就把 `data[0].id` 换成一张表：

```bash
oci compute image list \
  --compartment-id <你的 tenancy OCID> \
  --operating-system "Oracle Linux" \
  --shape VM.Standard.A1.Flex \
  --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0:10].{name:"display-name", ver:"operating-system-version", created:"time-created"}' \
  --output table
```

想锁死主版本，加 `--operating-system-version "9"`（值以列表里 `ver` 列为准）。

**或者纯网页操作**：

1. `Compute → Instances → Create instance`
2. **先选 Shape**：`Ampere → VM.Standard.A1.Flex`（控制台的镜像列表会按已选 shape 自动过滤架构）
3. 再点 **Change image**，选 **Oracle Linux** 和版本
4. 选完后镜像名字是个链接，点进去 → 详情页的 **OCID** 行点复制

### 三个必须一致的约束（最容易踩的坑）

| 约束 | 说明 |
|---|---|
| 区域一致 | AD 前缀里的区域（`AP-SINGAPORE-1-AD-1`）必须和 `OCI_CLI_REGION`（`ap-singapore-1`）同区 |
| **架构一致** | `VM.Standard.A1.Flex` 是 **ARM (aarch64)**，镜像必须是 ARM 版；选成 x86 会报 shape 不兼容 |
| 隔间归属 | 实例建在 `OCI_COMPARTMENT_ID` 指定的隔间里，子网必须在该隔间可见 |

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

**跳过 `3c18g` 的原因**：每轮的目标是 `当前 × STEP_FACTOR`，超过 `TARGET` 就压到 `TARGET`，
所以不会落在中间档位上。

> 把 `STEP_FACTOR` 设为 `1` 就退化成逐级 +1（1→2→3→4）。
> 若 `TARGET=3`，则路径为 1→2→3（`2 × 2 = 4` 超过 3，被压到 3）。
>
> 内存按 `MEMORY / OCPU` 的比例自动跟随（上例为每 OCPU 6 GB），可用 `MEMORY_PER_OCPU` 显式覆盖。

### 幂等性

脚本可以无脑反复执行，调度器一直打着也不会产生副作用：

| 当前状态 | 行为 |
|---|---|
| 还没抢到 | 尝试创建；失败则退出 0 |
| 抢到了但没到 TARGET | 分步升级（每轮 ×2），直到达标 |
| 已经达到 TARGET | **什么都不做**，直接退出 0 |
| 中间某轮是 STOPPED | 跳过停止，直接升级并启动 |

**防死循环**：如果某一轮「调用成功返回但规格实际没变」（比如被平台限制），
轮数上限会兜住并报错中止。上限为 `TARGET - OCPU + 2`（至少 3）。

---

## 退出码

| 退出码 | 场景 | 说明 |
|---|---|---|
| `0` | 抢到并升级成功 | 正常 |
| `0` | **没有容量，未抢到** | **预期内结果**，只打 `::warning::`。高频调度下这是常态，用非 0 会让 Actions 页满屏红色 |
| `0` | 已经是目标规格 | 无需操作 |
| `1` | 缺配置 / 认证失败 / OCI 调用异常 / 等待超时 | 需要处理 |

> 如果你希望在「没抢到」时也变红（比如配合告警），把 `index.py` 里 `try_launch()` 中那段
> `warn(...)` 改成 `die(...)` 即可。
>
> 注意：脚本对**任何未预期异常**都会 `sys.exit(1)`，不会出现「任务实际失败但 workflow 显示绿色」的情况。
> 这点和 `glados_checkin` 不同。

---

## 可调参数

### 三个主参数

| GitHub Variable | 脚本变量 | 默认 | 说明 |
|---|---|---|---|
| `OCPU` | `GRAB_OCPUS` | `1` | 抢占时申请的 OCPU 数（越小越容易抢到） |
| `MEMORY` | `GRAB_MEMORY_GB` | `6` | 抢占时申请的内存（GB） |
| `TARGET` | `TARGET_OCPUS` | `2` | 升级的最终目标 OCPU 数 |

### 其他可选

| GitHub Variable | 脚本变量 | 默认 | 说明 |
|---|---|---|---|
| `STEP_FACTOR` | `STEP_FACTOR` | `2` | 每轮放大倍数。`2` = 翻倍（1c→2c→4c），`1` = 逐级 +1 |
| `MEMORY_PER_OCPU` | `MEMORY_PER_OCPU` | `MEMORY / OCPU` | 每个 OCPU 配多少 GB 内存 |
| — | `OCI_SHAPE` | `VM.Standard.A1.Flex` | 目标 shape |
| — | `OCI_BOOT_VOLUME_GB` | `50` | 引导卷大小 |
| — | `STOP_ACTION` | `SOFTSTOP` | `SOFTSTOP` 优雅关机 / `STOP` 直接断电 |

> Oracle Always Free 的 Ampere A1 额度是 **4 OCPU / 24 GB**（以官方为准）。
> 所以 `OCPU=1`、`MEMORY=6`、`TARGET=4` 时，最终会升到 `4c24g`，正好用满免费额度。

### ⚠️ 变量名有两套，别搞混

**GitHub Variable 名 ≠ 脚本读取的变量名。** `OCPU` / `MEMORY` / `TARGET` 只是 GitHub 界面上的显示名，
workflow 的 `env:` 里已经把三者映射成了脚本实际读取的 `GRAB_OCPUS` / `GRAB_MEMORY_GB` / `TARGET_OCPUS`。

这会影响两个地方，写错都**不会报错、只会静默失效**：

| 场景 | 该写哪个 |
|---|---|
| `.env` 文件 | 脚本变量名（`GRAB_OCPUS`），不是 `OCPU` |
| 参数覆盖的 input 名 | 也是脚本变量名（`TARGET_OCPUS`）—— input 名就是照变量名声明的 |

> 写错的现象是「覆盖明明没报错，但行为没变」。完整对应关系见
> `python/oracle-abc/.env.example` 里的注释。

参数覆盖的完整说明（白名单、值不回显、摘要提示等）见
[根 README「参数覆盖」](../../README.md#64-参数覆盖临时替换一次配置)。

---

## 常见问题

> 通用问题（变量没生效、Summary 是空的、调度器没触发……）见
> [根 README「常见问题（通用）」](../../README.md#10-常见问题通用)。下面是本项目专属的。

### `NotAuthorizedOrNotFound` / `401`

认证配置不对。按顺序检查：

1. `OCI_CLI_KEY_CONTENT` 是否是**私钥全文**（不是公钥、不是指纹）
2. `OCI_CLI_FINGERPRINT` 是否和该私钥配对（在 OCI 控制台 My profile → API keys 里核对）
3. `OCI_CLI_USER` / `OCI_CLI_TENANCY` 是否填反了
4. 打开 `DEBUG_MODE` 后重跑，看自检表：`OCI_CLI_KEY_CONTENT` 的 `LENGTH` 为 0 就是没配上；
   同时能直接看到 `OCI_CLI_USER` / `OCI_CLI_TENANCY` 的实际值，确认有没有填反

> 报错信息形如 `OCI 调用失败：[401] NotAuthenticated — ...`，
> `[403] NotAuthorizedOrNotFound` 通常是权限或 OCID 填错。

### `Out of host capacity` / 一直抢不到

这是 A1 的常态，不是脚本问题。提高命中率的办法：

- **调小抢占规格**（`GRAB_OCPUS=1`、`GRAB_MEMORY_GB=6` 已经很小了）
- **提高触发频率**（外部调度器 1~5 分钟一次）
- **换可用域**（`OCI_AVAILABILITY_DOMAIN` 试其他 AD）

> A1 缺货时 OCI 返回的形态不统一：有的区域是 500 `InternalError` + "Out of host capacity."，
> 有的区域 code 直接是 `OutOfHostCapacity`。`is_capacity_error()` 已同时覆盖这几种，
> 所以不必担心被误判为失败。

### 升级时 `LimitExceeded`

目标规格超出了账号的服务限额（Always Free 是 4 OCPU / 24 GB）。把 `TARGET_OCPUS` 调小。

### 升级后启动失败

停止再启动的过程中，实例可能重新遇到容量问题。想规避这一点，可以改成**不主动停止**、
直接 `update_instance` —— 据 Oracle 文档，运行时改 shape 会由平台自动重启实例；
代价是可能触发非优雅关机，有数据损坏风险（这也是默认走 `SOFTSTOP` 的原因）。

### 其实可以不填镜像 / 可用域 / 子网

`index.py` 第一步是「按 display-name 找实例」，找到了就直接跳过创建。
所以如果你**能在控制台手动建出一台**名字叫 `oracle-abc`（要和 `OCI_INSTANCE_NAME` 一致）的实例，
脚本接管后只会做「停止 → 改规格 → 启动」的升级，`OCI_AVAILABILITY_DOMAIN` / `OCI_IMAGE_ID` /
`OCI_SUBNET_ID` 一个都用不上。

前提是**手动创建能成功** —— A1 缺货时手动建往往也报 `Out of host capacity`。
真抢不到还是得让脚本去高频重试，那时这几项就必须填对。

### 本地怎么跑

```bash
pip install -r python/oracle-abc/requirements.txt
cd python/oracle-abc
```

**方式一：临时 export**（不落盘，关掉终端就没了）。本地没有 GitHub 的 vars / secrets，
所以下面这些都得自己 export：

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

python index.py
```

本地用 `OCI_CLI_KEY_FILE` 指定私钥路径，比把内容塞进环境变量方便。
（注意 `OCI_CLI_KEY_FILE` 没有声明成 input，所以不能用 ref 传；要临时用它，得先在 workflow 里加一个同名 input。）

> 💡 不想每次 export 的话，可以把项目目录下的 `.env.example` 复制成 `.env` 填好 ——
> `index.py` 启动时会自己读它，把没设置或为空的项补上。

---

## 建议的调度方式

用外部调度器（cron-job.org 等）**每 1~5 分钟**打一次。

因为 A1 缺货是常态，单次抢不到很正常，靠高频重试提高命中率 ——
**不要**指望 GitHub 自带的 cron，实测极不可靠。

调度器的具体配置步骤见[根 README「快速开始」第 5 步](../../README.md#55-第五步挂上外部调度器)。

---

## 本项目相关文件

| 文件 | 作用 |
|---|---|
| `python/oracle-abc/index.py` | 入口脚本 |
| `python/oracle-abc/.env.example` | `.env` 模板（提交；只放占位符）。同目录的 `.env` 才是实际生效的那个，已被 gitignore |
| `.github/workflows/oracle-abc.yml` | 项目 workflow |
| `python/common/logging_config.py` | Python 语言级共享的日志初始化 |

> 通用层的 6 个 shell 脚本、总入口 workflow、`.gitignore` 等，见
> [根 README「文件速查」](../../README.md#11-文件速查)。
