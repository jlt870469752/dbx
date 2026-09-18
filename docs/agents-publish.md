# Agent 发布操作手册（fork 分发）

> 适用：把某个数据库驱动 agent 的新版本发布到自建 fork，供本地 DBX 应用"严格更大版本号"自动升级。
> 本次以 Kafka agent `0.1.14 → 0.1.15` 为实例说明。

## 0. 概念与术语

| 名称 | 含义 |
| --- | --- |
| `agents-v0.1.xx` | 版本化 release tag，按版本号各一个，存放该版本 agent jar |
| `agents-latest` | 常驻 release tag，存放 `agent-registry.json`，是应用拉取的唯一入口 |
| `agents/versions.json` | 工作区里各 driver 的"当前版本"清单，发布前先改这里 |
| `agent-registry.json` | 驱动清单：版本、标签、JRE、jar 的 url + sha256 + size |
| 升级语义 | 应用按 `version` **严格大于**当前已装版本才重装，不看哈希 |

### 本次实例数据（Kafka 0.1.15）

- fork：`jlt870469752/dbx`
- 版本 tag：`agents-v0.1.15`
- 资产名：`dbx-agent-kafka-0.1.15.jar`
- jar sha256：`e89374d41937b7d7ef1d88d939b8e9f50dc3e2f3d201e52e76b3b9589c330497`
- jar size：`23867121` 字节
- registry URL 前缀：`https://github.com/jlt870469752/dbx/releases/download/`

## 1. 前置条件

- 已配置 `gh` CLI 且已登录（`gh auth status`），对目标 fork 有写权限。
- 准备产物与目录：`/tmp/dbx-fork-release/`（示例目录，可自选）。
- 本机可能直连 github.com 超时（走代理），**验证环节优先用 `gh`，不要用 `curl`**。

## 2. 改版本号

编辑 `agents/versions.json`，把目标 driver 的版本 +0.0.1（例如 `"kafka": "0.1.14"` → `"0.1.15"`）。
版本是"严格更大才升级"的唯一依据，重复版本不会触发重装。

## 3. 构建并校验产物

```bash
# 在 agents/ 目录
./gradlew :kafka:shadowJar --console=plain
shasum -a 256 drivers/kafka/build/libs/dbx-agent-kafka.jar
stat -f%z drivers/kafka/build/libs/dbx-agent-kafka.jar   # macOS；Linux 用 stat -c%s
```

记录输出的 sha256 与 size，稍后写入 registry，必须完全一致。

## 4. 准备发布目录（版本命名）

```bash
mkdir -p /tmp/dbx-fork-release
cp agents/drivers/kafka/build/libs/dbx-agent-kafka.jar \
   /tmp/dbx-fork-release/dbx-agent-kafka-<版本>.jar
```

资产名必须遵循 `dbx-agent-<driver>-<版本>.jar`，否则 registry 里的 URL 对不上。

## 5. 编写 agent-registry.json

参考 schema（`crates/dbx-core/src/agent_service.rs` 生成逻辑）：

```json
{
  "jres": {},
  "drivers": {
    "kafka": {
      "version": "0.1.15",
      "label": "Apache Kafka",
      "min_app_version": "0.5.93",
      "jre": "21",
      "external_driver_required": false,
      "jar": {
        "url": "https://github.com/<fork>/dbx/releases/download/agents-v0.1.15/dbx-agent-kafka-0.1.15.jar",
        "sha256": "<第 3 步的 sha256>",
        "size": <第 3 步的 size>
      }
    }
  }
}
```

关键约束：

- `jar.url` 的 tag 段、资产名段必须分别等于第 4 步的 tag 与文件名。
- `sha256`/`size` 是应用校验下载完整性的依据，写错会导致校验失败而拒绝安装。
- 字段缺失或类型不对会导致整个 registry 解析失败，连带其它驱动不可安装。

## 6. 创建版本 release 并上传 jar

```bash
cd /tmp/dbx-fork-release
gh release create agents-v0.1.15 \
  dbx-agent-kafka-0.1.15.jar \
  --repo <fork>/dbx \
  --title "agents-v0.1.15" \
  --notes "<变更说明，例如：fix read-session batches skipping tail records>"
```

成功后返回 release URL。若需覆盖同名 asset（例如修 bug 后重发同版本），用：

```bash
gh release upload agents-v0.1.15 <jar> --repo <fork>/dbx --clobber
```

> 注意：重发**同版本**不会触发已安装该版本的应用重新下载，需要升级就升版本号。

## 7. 覆盖上传 registry 到 agents-latest

```bash
gh release upload agents-latest agent-registry.json \
  --repo <fork>/dbx --clobber
```

`--clobber` 必须加：`agents-latest` 上只允许一个 `agent-registry.json`。

## 8. 验证

三处必须相互一致，缺一不可：

```bash
# 1) 版本 release 的 asset 摘要（GitHub 服务端计算的 sha256）
gh release view agents-v0.1.15 --repo <fork>/dbx --json assets

# 2) agents-latest 上的 registry 内容
gh api repos/<fork>/dbx/releases/tags/agents-latest \
  --jq '.assets[].name'   # 应只有 agent-registry.json

# 3) 真实下载 jar 并本地比对哈希/大小
gh release download agents-v0.1.15 \
  --pattern dbx-agent-kafka-0.1.15.jar \
  --repo <fork>/dbx --dir /tmp/verify
shasum -a 256 /tmp/verify/dbx-agent-kafka-0.1.15.jar
```

校验点：

- GitHub digest == registry 里 `sha256`。
- 下载的 size == registry 里 `size`。
- registry 的 `jar.url` 不带 `\u` 转义、可直接访问。

## 9. 应用侧升级确认

- 运行时 agent 落在 `~/.dbx/agents/drivers/<driver>/agent.jar`，由应用按 registry 安装/覆盖。
- 开发模式下（`pnpm tauri dev`）若 registry 安装失败，会回退用工作区本地 jar：
  `agents/drivers/<driver>/build/libs/dbx-agent-kafka.jar`（见 `agent_service.rs` 中
  `find_local_agent_jar`，回退点 :1101/:1126/:1339）。
- agent 进程在"连接驱动"时拉起；替换 jar 后必须**断开并重连连接**（或重启应用），
  才可能启动新版本进程。

## 10. 常见坑

| 坑 | 症状 | 对策 |
| --- | --- | --- |
| jar.url 的 tag 或文件名写错 | 应用下载 404 | 严格按第 4 步命名 |
| sha256/size 写错 | 校验失败拒绝安装 | 用第 3/8 步的真实值 |
| 忘加 `--clobber` | gh upload 报 asset 已存在 | 补 `--clobber` |
| 版本号没涨 | 应用判定"非更新"不重装 | versions.json 升 +0.0.1 |
| curl 直连超时 | 拿不到内容 | 一律用 `gh api`/`gh release download` |