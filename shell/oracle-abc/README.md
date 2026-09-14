# oracle-abc

抢占 OCI（Oracle Cloud）Ampere A1 实例，抢到后自动停止并升级规格。

**流程**：先抢一台小规格（默认 `1 OCPU / 6 GB`）的 A1，抢到后停止、把 shape 改成 `2 OCPU / 12 GB`、再启动。

**为什么先抢小的**：A1 常年缺货，申请的规格越小越容易命中容量；抢到后再升到目标规格。

---

## 目录结构

```
shell/
└── oracle-abc/
    ├── index.sh      # 入口脚本
    └── README.md
```

对应 workflow：`.github/workflows/oracle-abc.yml`
对应 Environment：`shell_oracle_abc`

---

## 配置

### Environment secret

在 **Settings → Environments → `shell_oracle_abc` → Environment secrets** 中添加：

| 名称 | 必填 | 说明 |
|---|---|---|
| `OCI_CLI_KEY_CONTENT` | ✅ | OCI API 私钥的**完整内容**（PEM 全文，含 `-----BEGIN PRIVATE KEY-----` 和结尾行） |

> 这是**唯一**的真凭据。其余都是 OCID / 标识符，单独泄露无法用于认证。

### Environment variables

在 **Settings → Environments → `shell_oracle_abc` → Environment variables** 中添加：

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

> 如果私钥带口令加密，需要额外加一个 secret `OCI_CLI_PASSPHRASE`，并在 `oracle-abc.yml` 里取消对应那行的注释。

### 如何拿镜像 OCID

```bash
oci compute image list \
  --compartment-id <你的 tenancy OCID> \
  --operating-system "Canonical Ubuntu" \
  --sort-by TIMECREATED --sort-order DESC \
  --query 'data[0].id' --raw-output
```

也可以直接在控制台 Create Instance 页面选好镜像，页面底部会显示对应的 OCID。

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
步骤 2  不存在 → 尝试创建 1 OCPU / 6 GB
            成功 → 继续
            容量不足 → 打警告，退出 0（等下次重试）
        已存在 → 跳过创建
步骤 3  读取当前 shape-config
            已是目标规格 → 直接退出 0
步骤 4  停止（SOFTSTOP，等 STOPPED）
        → 更新 shape 为 2 OCPU / 12 GB
        → 启动（等 RUNNING）
```

**幂等性**：脚本可以无脑反复执行。

| 当前状态 | 行为 |
|---|---|
| 还没抢到 | 尝试创建；失败则退出 0 |
| 抢到了但规格是 1c6g | 停止 → 升级到 2c12 → 启动 |
| 已经是 2c12 | **什么都不做**，直接退出 0 |
| 实例是 STOPPED 状态 | 跳过停止，直接升级并启动 |

所以调度器可以一直打着，不会产生副作用。

---

## 退出码

| 退出码 | 场景 | 说明 |
|---|---|---|
| `0` | 抢到并升级成功 | 正常 |
| `0` | **没有容量，未抢到** | **预期内结果**，只打 `::warning::`。高频调度下这是常态，用非 0 会让 Actions 页满屏红色 |
| `0` | 已经是目标规格 | 无需操作 |
| `1` | 缺配置 / 认证失败 / OCI 调用异常 | 需要处理 |

> 如果你希望在「没抢到」时也变红（比如配合告警），把 `index.sh` 里那段 `::warning::` 改成 `::error::` 并 `exit 1` 即可。

---

## 可调参数

都可以通过 Environment variables 覆盖（`oracle-abc.yml` 里有注释掉的模板）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `OCI_SHAPE` | `VM.Standard.A1.Flex` | 目标 shape |
| `GRAB_OCPUS` | `1` | 抢占时申请的 OCPU 数 |
| `GRAB_MEMORY_GB` | `6` | 抢占时申请的内存 |
| `TARGET_OCPUS` | `2` | 升级后的 OCPU 数 |
| `TARGET_MEMORY_GB` | `12` | 升级后的内存 |
| `OCI_BOOT_VOLUME_GB` | `50` | 引导卷大小 |
| `STOP_ACTION` | `SOFTSTOP` | `SOFTSTOP` 优雅关机 / `STOP` 直接断电 |

> Oracle Always Free 的 Ampere A1 额度是 **4 OCPU / 24 GB**（以官方为准），`2c12` 在免费额度内。

---

## 常见问题

### `NotAuthorizedOrNotFound` / `401`

认证配置不对。按顺序检查：

1. `OCI_CLI_KEY_CONTENT` 是否是**私钥全文**（不是公钥、不是指纹）
2. `OCI_CLI_FINGERPRINT` 是否和该私钥配对（在 OCI 控制台 My profile → API keys 里核对）
3. `OCI_CLI_USER` / `OCI_CLI_TENANCY` 是否填反了
4. 控制台看 `check_secrets` 表格的输出：`OCI_CLI_KEY_CONTENT` 的 `LENGTH` 为 0 就是没配上

### `Out of host capacity` / 一直抢不到

这是 A1 的常态，不是脚本问题。提高命中率的办法：

- **调小抢占规格**（`GRAB_OCPUS=1`、`GRAB_MEMORY_GB=6` 已经很小了）
- **提高触发频率**（外部调度器 1~5 分钟一次）
- **换可用域**（`OCI_AVAILABILITY_DOMAIN` 试其他 AD）
- 用 `oci compute compute-capacity-report` 探测当前各 AD 的可用容量

### 升级时 `LimitExceeded`

目标规格超出了账号的服务限额（Always Free 是 4 OCPU / 24 GB）。把 `TARGET_OCPUS` / `TARGET_MEMORY_GB` 调小。

### 升级后启动失败

停止再启动的过程中，实例可能重新遇到容量问题。想规避这一点，可以改成**不主动停止**、直接 `oci compute instance update`——据 Oracle 文档，运行时改 shape 会由平台自动重启实例；代价是可能触发非优雅关机，有数据损坏风险（这也是脚本默认走 `SOFTSTOP` 的原因）。

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

cd shell/oracle-abc
bash index.sh
```

本地用 `OCI_CLI_KEY_FILE` 指定私钥路径，比把内容塞进环境变量方便。

---

## 相关文件

| 文件 | 作用 |
|---|---|
| `shell/oracle-abc/index.sh` | 入口脚本 |
| `.github/workflows/oracle-abc.yml` | 项目 workflow |
| `.github/workflows/run-project.yml` | 总入口，按参数派发 |
| `common/check-secrets.sh` | 配置自检（secret 输出指纹、variables 输出明文） |
| `common/execute.sh` | 执行入口，输出同时写入日志和 `output.log` |
| `common/render-summary.sh` | 把 `output.log` 渲染成 Job Summary |
