# P1-ACCEPTANCE 使用说明（F / zcode-F）

本目录是出站捕获与验收工具（`src/acceptance/`）的入口文档。所有命令零付费、离线
（仅绑定 127.0.0.1 loopback），不启动替代 GUI、不调用付费 provider、不动真实 profile。

## 1. 离线命令（在 F 工作区根目录运行）

```sh
# 用 synthetic 注入替身完整跑一遍 13 项矩阵（loopback 捕获 + 证据落盘）：
node src/acceptance/cli.mjs matrix --evidence-root evidence/local --run-id demo-1

# 缺 completionFactory 的对比运行（restart-dedup=not-run 附重跑步骤；进程边界参考 case 照常）：
node src/acceptance/cli.mjs matrix --no-completion --evidence-root evidence/nocompletion

# 声明 replay 等级（仅当事件/请求确实来自已捕获流量的回放；isolated-dsh 不能由此声明）：
node src/acceptance/cli.mjs matrix --case-evidence-type replay --evidence-root evidence/replay

# 校验证据 bundle 的结构/语义；带 --evidence-root 时同时核验磁盘 artifact：
node src/acceptance/cli.mjs validate --bundle evidence/local/bundle.json --evidence-root evidence/local

# 只跑测试：
node --test test/acceptance/*.test.mjs
```

`matrix` 会把 `bundle.json` 写进 `--evidence-root`，每个 case 的证据在
`<evidenceRoot>/<caseId>/` 下。CLI 默认使用 synthetic 工厂（`src/acceptance/synthetic.mjs`）。

## 2. 采集 / 校验入口（编程接口）

`src/acceptance/index.mjs`：

- `validateEvidenceBundle(bundle)` → `{valid, cases, errors}`：结构 + 语义校验。
- `runAcceptanceMatrix({runtimeFactory, completionFactory, capture, fixtureRoot, evidenceRoot, runId, caseTimeoutMs})`
  → schemaVersion=1 的 bundle。runner 在采信任何 passed 之前对 artifact 做**磁盘核验**
  （存在、普通文件、symlink 拒绝、字节数、SHA256、越根路径拒绝），核验不过即 failed。
- `verifyArtifactsOnDisk(bundle, evidenceRoot)`：可独立调用的磁盘核验。
- `writeArtifact(evidenceRoot, caseId, fileName, content, kind)`：证据写入 helper。

`src/acceptance/loopback-capture.mjs`：

- `createLoopbackCapture({requestTimeoutMs, maxRequests})`：本地假 provider。
  绑定 127.0.0.1 随机空闲端口；`start()/stop()` 显式；停止后请求显式失败；
  请求超时销毁连接并记入 `errors`（不吞）；凭证头只记名字不记值。
- `sendProviderRequest({capture, host, hostOwnSystem, model, messages})`：把宿主投影的
  **完整序列化请求**真实 POST 到捕获端，返回 captureIndex 与 raw/system SHA256。
- `assembleCompleteSystem(host, hostOwnSystem)`：投影契约 —— 宿主自有正文在前，
  其后 section 按 `(order, 注册先后)` 稳定排序，`\n\n` 连接。宿主自有内容必须保留。

注入契约（由调用方实现，D/E accepted 后由负责人注入真实实现）：

- `runtimeFactory(options)`：options 含 `{mode, config, completionHandle?, preOwnedTools?,
  includeTopics?, fixture?}`；返回 D 契约形状 `{start, stop, refresh, diagnostics, service, bridge, host}`。
  矩阵另要求 host 暴露 `listSections()` / `listToolNames()` / `getTool(name)`（投影与工具读取）；
  host 建议暴露 `resources()`（可观测资源计数器，stop-cleanup 用它断言真实 dispose；
  缺失时相关断言退化为观测值 null 并记录）；service 建议暴露 `getWriteCount()`
  （shadow 零写断言；缺失时该项断言退化为观测值 null 并记录）。
- **独立夹具契约（反馈 B1 修复的核心）**：矩阵自带固定夹具常量 `MATRIX_FIXTURE`
  （`src/acceptance/index.mjs` 导出：hostOwnSystem/personaText/coreText/coreWrittenText/topics），
  并通过 `options.fixture` 传给工厂；工厂必须按夹具**原样**播种 service。期望的完整出站
  system 字节由矩阵用 `renderTopicIndex()`（文档化的派生索引格式：标题行 + 按 key 升序的
  `- <key> [<scopeId>] — <summary>` 行）独立拼出（`expectedCoreView` /
  `expectedCompleteSystemFromFixture`），与捕获的 raw wire 字节做 `Buffer.compare`。
  期望**绝不**从 service 返回值反推 —— 注入 service 的派生索引若不符合文档格式，
  full-system-first 会如实 failed。
- `completionFactory({root, scopeId})`：E 契约 `openCompletionState` 形状
  `{sink:{load,save}, flush, close, diagnostics}`；其 `sink` 被作为 `createHostBridge` 的
  `probeSink`。
- `capture`：返回 `{start, stop, url, requests, diagnostics}` 的捕获会话工厂；缺省用内置
  loopback 捕获。runner 结束时会校验捕获会话停止后不再报告 started（server 资源回收）。
  具体 capture factory 可在本文档追加定义，但不得要求 D/E 私改契约。
- `caseEvidenceType`：调用方对本次运行证据来源的显式声明，仅接受 `"synthetic"`（默认）或
  `"replay"`；`"isolated-dsh"` 会被 runner 直接拒绝（INVALID_INPUT）—— 该等级只能由负责人
  P1b 授予，工具不提供自我声明通道。

## 3. bundle 证据字段

```jsonc
{
  "schemaVersion": 1,
  "runId": "matrix-…",
  "evidenceType": "synthetic | replay | isolated-dsh",
  "source": { "runtimeVersion": "v24.22.1", "sourceHashes": { "<相对路径>": "<sha256>" }, "profileKind": "synthetic-fixture" },
  "cases": [
    { "id": "…", "status": "passed | failed | not-run", "evidenceType": "synthetic | replay | isolated-dsh",
      "artifacts": [{ "path": "<caseId>/<file>", "sha256": "…64hex", "bytes": 123,
                      "kind": "raw-request | normalized-system | raw-event | case-log" }],
      "reason": "failed/not-run 必填；not-run 须含重跑步骤" }
  ]
}
```

artifact kind 语义：

- `raw-request`：真实发给捕获 provider 的完整序列化请求体（逐字节落盘）。
- `normalized-system`：解析后的 system 视图（与 raw 分开，二者不得混用）。
- `raw-event`：原始捕获的宿主交互记录 —— 会话事件（经 `mapRawSessionEvent` 的原始输入）
  或生命周期 case 的实际回执/错误（如 start 冲突错误、stop/restart 回执、写工具回执）。
- `case-log`：case 的断言明细与结果。

13 个固定 case：契约 11 项 `shadow-clean`、`active-ownership-conflict`、`full-system-first`、
`write-next-request`、`route-switch`、`compress-direct`、`compress-ptc`、`compress-negative`、
`restart-dedup`、`operation-replay`、`stop-cleanup`，加 `restart-dedup-process`（进程边界
参考实现）与 `global-fallback`。

进程边界与注入消费的分工（反馈 F1/F2/F3 迭代结果）：

- `restart-dedup` **消费注入的 completionFactory/runtimeFactory**：同 root/scope 二次打开、
  恢复持久去重状态、重放去重、新事件推进。缺任一工厂 → **not-run**（E 的持久化实现缺席
  不能被参考替身冒充）。所有 stop 均 await。
- `restart-dedup-process` 是**独立命名**的参考实现进程边界 case：两个独立 node 子进程
  先后打开同一持久 root/scope（`src/acceptance/restart-child.mjs`，advance/replay 两阶段，
  子进程 pid 记入证据）。注入工厂是闭包、无法跨进程传递，故此 case 不消费注入工厂、
  不声称 E 集成；synthetic 句柄无跨进程互斥，两个子进程顺序执行。
- `global-fallback` 用**真实基线 service/store**（只读 import）在临时 root 上验证：
  读路径 active 无 core 逐字节回落 global；`core_write` 经 service token 提交活动域副本且
  global 字节不变；same-operationId 重试同进程幂等 + 独立子进程
  （`src/acceptance/global-fallback-child.mjs`）跨实际重启幂等。不经注入替身 ——
  global fallback 是 B/C 基线语义，复刻一份替身反而是自证。

生命周期纪律（反馈 F1）：

- 矩阵中每一个 `runtime.stop()` 都被 await（D 契约 stop 可为异步）；case 主体与 stop 的
  错误都不吞、互不掩盖（主体错误优先，stop 错误附 details.stopError）。异步拒绝的 stop
  会让受影响 case 如实 failed（单测覆盖）。
- teardown 纪律（反馈 F3·attempt 3）：捕获会话停止后仍报告 started、或清理失败，都会让
  整次矩阵运行以 INVALID_STATE（phase=teardown）失败 —— 清理失败的运行不产出 bundle。
  超时 case 的遗留工作不会被取消：runner 在清理前有界（20s）等待其 settle，case 状态仍
  按超时记 failed；Windows delete-pending 竞态有 3 次重试，重试耗尽仍失败按 teardown
  失败上报（不吞）。

校验语义要点：

- **任何 passed case 都必须有至少一个 artifact**（synthetic 也不允许 artifacts=[];
  反馈 B2 修复）。
- `passed` 且 `evidenceType ∈ {replay, isolated-dsh}` 的 case 必须带 `raw-request` 或
  `raw-event` 捕获证据。
- bundle 级 `evidenceType` 必须与每个 passed case 的级别**完全一致**（双向），source 自报
  （runtimeVersion/profileKind）只是元数据，不能升级等级。
- artifact 路径必须相对、正斜杠、无 `..`；磁盘核验另查越根/symlink/字节/hash，且**逐级
  核验父目录必须是真实目录** —— 链接/junction 父目录下字节与 hash 都正确的文件也被拒绝
  （反馈 F2·attempt 4：`ARTIFACT_PARENT_LINK`）。
- `not-run` 必须给 reason 与重跑步骤；缺真实环境的组合是 not-run，不允许 skip 后总通过。
- 多请求 case（write-next-request/route-switch）对捕获窗口内的**每一条**请求都留档。

## 4. isolated-dsh 资格限制（重要）

- **普通 HTTP 客户端自发请求只能是 synthetic**；replay 是 replay；手造事件只能验证解析器。
- `isolated-dsh` 只能来自：真实 DSH 宿主在隔离测试 profile/data root 下的实际出站，
  经本捕获端（或等价 capture factory）抓到**真实序列化请求**，且 direct/PTC 压缩完成事件
  来自实际调用。这属于 P1b，由负责人运行（见 `docs/HOST-ACCEPTANCE.md`），不由本工具自动授予。
- synthetic 全绿不等于真实宿主通过；replay 不等于实时联调成功。

## 5. 已知边界

- synthetic completion 工厂（`createSyntheticCompletionFactory`）的 JSON 落盘没有 E 的跨进程
  互斥 owner；restart-dedup-process 的两个子进程**顺序**执行避免并发持有，真实互斥由 E 契约
  与负责人验证。restart-dedup 消费注入工厂，缺 completionFactory 时该项 not-run。
- 真实 DSH 宿主与真实 E handle 的跨进程组合属负责人 P1b 边界；`restart-dedup-process` 只是
  参考 synthetic 实现的进程边界证据，不声称 E 集成。
- Windows 无目录 fsync：synthetic sink 的 `flush()` 明确返回
  `directoryFsync: "unsupported-on-windows-not-claimed"`，不宣称目录级持久化。
