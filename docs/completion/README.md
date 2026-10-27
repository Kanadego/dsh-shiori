# Shiori P1-COMPLETION · 完成事件与持久状态文档（slot E）

> 模块：`src/completion/index.mjs`（openCompletionState 主入口）、`src/completion/errors.mjs`、
> `src/host/compress-probe.mjs`（探针，slot E 独占修改）、`src/host/dsh-adapter.mjs`（适配层，slot E 独占修改）。
> 契约依据：`collab/CONTRACTS.md`「E：完成事件与持久接口」；任务：`collab/tasks/E.md`。

## 1. 只读源码证据（2026-10-24 重新实测，未修改任何宿主文件）

### 1.1 包版本与 SHA256

| 包 | 版本 | 文件 | SHA256（前16位） | 字节 |
| --- | --- | --- | --- | --- |
| dsh-soul-md | 0.10.2 | index.js | `eec62a4006453200` | 38013 |
| billion-context | 0.1.206 | dist/agent/dsh-native.js | `8dab83288dbbc46d` | 2389937 |
| @deepseek-ai/dsh-agent-loop | 0.2.1-rc.2 | lib/index.js | `cf57e3ecd487ac5c` | 74599 |
| @deepseek-ai/dsh-session | 0.2.1-rc.2 | lib/index.js | `2f5dd07cb5c744a2` | 94982 |

（完整 SHA256 见本批 REPORT.md；路径为只读宿主安装，不在本工作区内。）

### 1.2 行号抽查（当前构建实测值）

| 位置 | 行号 | 证据 |
| --- | --- | --- |
| dsh-soul-md index.js | 351 | `ctx.systemPrompt.section({`（section 注册） |
| dsh-soul-md index.js | 579 | `ctx.tools.register(defineTool({`（工具注册） |
| dsh-agent-loop lib/index.js | 682 | `session.append("tool/call", {` |
| dsh-agent-loop lib/index.js | 697 | `session.append("tool/result", {` |
| dsh-agent-loop lib/index.js | 976 | `const stopRecovery = this.ctx.on("session/event", (session, event) => {`（返回 disposer；旧文档写 977-982，本构建前移 1 行） |
| dsh-session lib/index.js | 133-134 | `"tool/ptc-dispatch"`、`"tool/ptc-dispatch-start"` 持久事件类型 |
| billion-context dsh-native.js | 128 | `forwardTool(proxyBase,conversationId,…)`、`parseBlocksCreated` 只接受 ≥0 整数、`partialOutcomeNote` 固定全文 `[acp-result: PARTIAL — N block(s) created; some requested range(s) were NOT folded. Retry ONLY the failed range(s) listed above; do not re-fold the ranges that were applied.]`（模板端到端确定，2026-10-25 复核；blocksCreated 为 undefined 的变体不携带块数、不解析） |

### 1.3 证据分类（哪些是源码证据 / synthetic / 真正运行）

| 项 | 类别 | 说明 |
| --- | --- | --- |
| 回执格式 `[Compressed … → N block(s), ~M tokens saved.]` 与 PARTIAL 格式 | 源码证据（dsh-native.js:128）+ 既有本机会话 5 样本（docs/host/README.md §1.4，2026-10-24 核对） | 本批未重新解码会话文件，沿用已验收的形状记录；样本只含消息区间与块计数，无正文 |
| direct `tool/result.meta.blocksCreated` 是否存在 | 未证实 | 适配层仅在 meta 携带 ≥0 整数时采信；文本仅接受整行锚定的两种已证格式 |
| PTC `parentCallId` ↔ direct `tool/call.callId` 同一底层调用 | 关联规则（声明） | 事件字段真实存在（本机样本含 rootCallId/parentCallId/subCallId）；"parentCallId 即 direct callId" 是本模块声明的关联规则，无法从静态源码 100% 证明，故无 callId 的推进在 diagnostics 中如实计数（advancesWithoutCallIdentity） |
| 持久化 / 互斥 / 崩溃恢复 | 真正运行 | test/completion/ 用真实子进程与真实文件系统验证（无同进程冒充重启） |
| 桥组合（probeSink） | 真正运行（合成 service/host） | createHostBridge 为冻结契约；D 的 src/runtime 未交付不阻塞 |

## 2. openCompletionState 接口

```js
const handle = await openCompletionState({ root, scopeId });
// root：显式绝对 stateRoot（不存在则创建；拒绝相对路径、home、symlink）
// scopeId：可信 factory 提供的非空字符串（绝不来自工具 payload）
handle.sink.load()        // -> snapshot | null（仅文件不存在时 null）；空/目录/symlink/损坏/权限 → 抛错
handle.sink.save(snapshot)// 原子：O_EXCL 临时文件 → fsync → rename；失败保持上次已提交快照
handle.flush()            // 等待进行中的保存排空
handle.close()            // 幂等；先排空再释放自己的锁；之后 save/load 拒绝（INVALID_STATE）
handle.diagnostics()      // root/scope/initialLoad/lock/persistence/saves/durable/...
```

快照字段与 `createCompressProbe` 兼容：`epoch, compressSeenIds, watermarks, expiredSessionIds, lastAdvance, updatedAt`。

## 3. 互斥与崩溃恢复协议（保守）

- 锁文件：`<root>/completion-lock-<encodedScopeId>.json`，内容 `{pid, scopeId, ownerToken, acquiredAt}`，`O_EXCL` 创建。
- 已有锁：读出 pid 后 `process.kill(pid, 0)` 判活——**只有 ESRCH 才证明死亡**（与根 guard-lock 协议同款）；
  活着或活性未知（EPERM 等）→ `LOCK_BUSY`，绝不触碰他人锁。
- 接管（仅 ESRCH）：残留锁 rename 为 `*.residue-<ts>-<rand>.json` 保留证据（不删除），`diagnostics.lock.residueRecovered` 如实记录。
- 释放：close 时核对 `ownerToken`+`pid`，只删除自己的锁；不匹配则保留并记录 `lockReleaseError`。
- **没有多写者模式**：各自的原子 rename 不构成无丢失多写者保证，本模块用互斥从根上排除。

## 4. 块证据与去重规则（探针）

- 文本证据**整行端到端锚定**：仅接受 `[Compressed … → N block(s), ~M tokens saved.]`（整行）与
  `[acp-result: PARTIAL — N block(s) created; some requested range(s) were NOT folded. Retry ONLY the
  failed range(s) listed above; do not re-fold the ranges that were applied.]`（dsh-native.js:128
  partialOutcomeNote 固定全文，行尾锚定到真实尾缀——attempt 3 修复：前缀匹配会接受带矛盾尾缀的伪造行）。
  无关文本夹带 `→ N block(s)`、PARTIAL 截断/改写尾缀一律不解析。
- 推进条件：name=compress ∧ success ∧ 整数 blocksCreated>0 ∧ 无 metaConflict；partial 有实际块推进一次；
  失败/拒绝/零块/无证据/开始事件/meta 矛盾不推进（已记为处理过，重放不得改判）。
- call identity 去重：direct（callId 取 message.callId → message.toolCallId → message.source.callId
  中第一个非空字符串；2026-10-26 真机 tool message 只有后两者）与 PTC（callId=parentCallId，退化
  rootCallId/subCallId）同 identity 只推进一次（reason `duplicate-call`）；内存 FIFO 上限 4096，
  跨重启由 seq 水位兜底。
- **无法关联时如实披露**：无 callId 的推进计入 `diagnostics.advancesWithoutCallIdentity`，
  不谎称跨路径 exactly-once。

## 5. 持久化边界与 Windows 限制

- 原子保存含**文件 fsync**；Windows/NTFS **无目录 fsync**——rename 后目录项落盘依赖文件系统日志。
  崩溃窗口内最后一次保存可能回退到上一快照；随后重放的事件会被重新处理（fail-safe 方向：可能重复处理，
  不会丢事件）。`diagnostics.persistence.windowsLimitation` 与 `durableExactlyOnceAcrossRestart` 明示。
- 同进程去重（eventId 环 + 会话水位，内存）与持久保证分开陈述；save 失败后 `durable: "degraded"`，
  此时**不得声称跨重启 exactly-once**（diagnostics 字段直接给出 false）。
- save 失败不覆盖上次已提交快照；失败期间的临时文件被清理；重试不吞故障（每次失败都进 lastSaveError）。

## 6. 与 D 运行时的协作点（冻结契约，D 未交付不阻塞）

- `createHostBridge({ probeSink })`：把 `handle.sink` 作为 probeSink 传入；桥 start 时 restore，事件时 save。
- **flush/close 原语的获取方式（attempt 3 补充文档）**：
  - 适配层原语：`assembleDshShioriHost()` 返回的 `host`（createDshHostAbstraction 实例）自带
    `host.flushCompletedTools()`（等待全部已派发的监听器回调并报告失败）与
    `host.capabilities.completedToolFlush === true` 能力位；
  - 状态原语：D 运行时自行 `await openCompletionState({root, scopeId})`，把 `handle.sink` 作为
    `probeSink` 转交 `createHostBridge`，并保留 `handle.flush()/close()` 自用；
  - 停流排空顺序：撤销订阅（禁止新事件）→ `await host.flushCompletedTools()` →
    `await handle.flush()` → `await handle.close()`。
- 完成事件监听器**必须返回对应处理 Promise**（契约「D」，D a2 包的 `src/host/index.mjs:336-343` 已实现
  `return onCompletedTool(event).catch(...)`）。适配层跟踪该 Promise，`host.flushCompletedTools()`
  等待全部在途回调并报告 `{waited, failures, dispatched, untrackedDispatches, normalizeFailures,
  syncListenerFailures}`（后两者为 attempt 3 新增：归一化失败 / 同步抛出两条拒绝路径显式可见）。
- **证据定级（attempt 3 修正，不得夸大）**：
  - 「契约形状监听器（返回 Promise）经真实 createHostBridge 组合可排空」——**已执行**：
    test/completion/bridge-integration.test.mjs 用真实桥 + 契约形状监听器验证 waited>0、失败可观测、
    untrackedDispatches=0、close 排空后重放不二次推进；
  - 「D 运行时内部监听器（src/host/index.mjs）与真实装配路径的端到端组合复测」——**not-run /
    blocked-on-D**：该监听器为 D 所有，E 不得修改；须在组合验收阶段由负责人对 D accepted 包复测；
  - 基线 fire-and-forget 监听器的排空缺口——**已执行的失败披露**：untrackedDispatches 计数 >0
    可观测（不是「已修复」，是「缺口如实可见」）。
- E 的排空顺序原语：撤销订阅（禁止新事件）→ `flushCompletedTools()` → `handle.flush()` → `handle.close()`。

## 6b. close 排空窗口与丢失审计（C1 修复，attempt 2/3）

- `flush()` 用计数循环等待全部已接受保存落定，**包括等待期间新入队的保存**（修复固定 Promise 引用漏排空）。
- `close()` 进入 closing 窗口：窗口内到达的 save 仍被接受并等待落定，然后才 `closed` 并释放锁；
  返回 `{closed, drainedSaves, lostSaves}`。
- **attempt 3 修复**：close 在 `closed` 置位后追加一次 `flush()`——「flush 返回 → closed 置位」的
  微任务间隙里入队的保存（如 fire-and-forget 桥派发的 persist 回调恰在此刻运行）此前不被等待；
  现在全部已接受保存落定后才释放锁。真实在途保存由门控 sink 测试确定性验证
  （test/completion/open-state.test.mjs「真实在途保存」用例）。
- close **完成后**到达的 save 显式拒绝（INVALID_STATE）并计入 `lostSaves`/`advancedButNotDurable`——
  这代表一次已报告但未持久化的推进；此时 `durable:"degraded"`、`durableExactlyOnceAcrossRestart:false`。
  调用方按上述排空顺序操作时 lostSaves 恒为 0；>0 即调用方违反协议且诊断可见。

## 7. 测试与日志

- `docs/completion/regression-module.log`：`node --test test/completion/*.test.mjs test/host/*.test.mjs`（97/97，attempt 3 实测）。
- `docs/completion/regression-full.log`：全量六目录（373/373，32 suites，attempt 3 实测；基线 340 + 新增 33）。
- 真实子进程测试：`test/completion/restart.test.mjs`（优雅重启去重 / SIGKILL 残留接管 / 崩溃前状态恢复 / 活 owner LOCK_BUSY）。
