# Shiori host bridge · 宿主适配文档（P0）

> 模块：`src/host/index.mjs`（createHostBridge 主入口）、`src/host/tools.mjs`（兼容工具）、
> `src/host/compress-probe.mjs`（压缩完成事件探针）、`src/host/dsh-adapter.mjs`（真实 DSH 薄适配）、
> `src/host/errors.mjs`（coded errors）。
> 依据：`collab/CONTRACTS.md`「C：宿主适配接口」、`DESIGN.md` §5.2 / §11.2、`collab/tasks/C.md`。
> 本文档行号为 2026-10-24 本机核对值；包更新后必须重新核对，不能沿用旧版印象。

## 1. 宿主源码只读核对记录

以下均为只读核对，未修改任何源码文件。

### 1.1 dsh-soul-md（section 注册与工具形状的参照实现）

`C:/Users/you/.dsh/profiles/web/node_modules/dsh-soul-md/index.js`

| 行号 | 证据 |
| --- | --- |
| 19–21 | section `text` 为**函数**，dsh-system-prompt 每次 assemble 求值（本注释来自插件自述） |
| 46 | `inject = ["systemPrompt", "tools"]` |
| 51–52 | section 名 `soul:persona` / `soul:memory`（Shiori 用 `shiori:persona` / `shiori:core`，不同名以便唯一写者判定） |
| 152–159 | 工具执行内取会话：`exec.agent.session.id` |
| 161–168 | 取工作区：`agent.session.header.cwd` |
| 272–277 | `ctx.on("session/event", (session, event) => …)`；`compaction/prune`、`compaction/end`（`event.data.error`）是持久会话事件 |
| 288–312 | 渲染：`rendered = [text, index].filter(Boolean).join("\n\n")`，同步函数 |
| 337–372 | `ctx.systemPrompt.section({ name, order, text, interpolate, complete? })` → disposer；persona order 0、memory order 0.5 |
| 374–390 | `ctx.effect(fn, name)`：注册/卸载生命周期，返回函数为 disposer |
| 579–630 | `ctx.tools.register(defineTool({ name, description, parameters, output, isConcurrencySafe, execute(args, exec), presentCall }))` |
| 669–681 | soul-md `memory_read` 在 20000 字符处截断（Shiori **有意不截断**，见 REPORT.md 分歧清单） |
| 785–820 | `soul_update` 经 `ctx.get("settings").update(NS, …)` 写 persona——**不是文件 CAS**，是设置命名空间写 |

### 1.2 dsh-agent-loop（system 投影与完成事件接口）

`C:/Users/you/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`

| 行号 | 证据 |
| --- | --- |
| 239–296 | `SystemPromptProjection.project(rendered, { inHistory, startsSeries })`：扫描 `session.surface.nodes` 中 `system/message`，`latest.text === rendered` 才跳过；`!inHistory || startsSeries || rendered===""` 走 head 替换并清空后续非空 system |
| 682–689 | `session.append("tool/call", { turn, step, callId, name, arguments })` |
| 691–704 | `session.append("tool/result", { turn, step, message: { callId, content, isError }, error?, meta? }, { sourceEventSeqs: [callSeq] })` —— **tool/result 不含工具名**，必须用 tool/call 的 callId 归因 |
| 903 | `await loopCtx.systemPrompt.assemble(assembleContextFor(agent, signal))`（preStep） |
| 977–982 | `const stopRecovery = this.ctx.on("session/event", …)`；`ctx.on` 返回 disposer |
| 1049–1065 | step()：`inHistory: preparedCall?.systemPromptUpdate === "in-history"`；`startsSeries` 关联 `startsRequestSeries`、`session.surface.contentGeneration`、`toolsChanged`；commits 以 `system/message` 落 surface |

### 1.3 billion-context（bili 压缩回执与工具注册）

`C:/Users/you/.dsh/profiles/web/node_modules/billion-context/dist/agent/dsh-native.js`（压缩过的 dist；行内位置深，用 grep 定位）

| 行号 | 证据 |
| --- | --- |
| 128 | `forwardTool(proxyBase, conversationId, tool, args, signal, nativeCaller=false)`；`parseBlocksCreated` 只接受 **≥0 整数**；`partialOutcomeNote(blocksCreated)` 固定文本 `[acp-result: PARTIAL — N block(s) created; some requested range(s) were NOT folded…` |
| 128–129 | 回执形状 `{ text, failed: outcome==="failure"\|\|outcome==="refused", outcome?, blocksCreated? }`；outcome 观测值 `partial / failure / refused / unrestorable / adopted` |
| 131 | `registerTools(ctx)`：`target.tools.register(toolDefinition(tool))`；同名冲突错误含 `already registered`（被计为 adopted）；工具 execute 用 `exec.agent?.session?.id`，`forwardTool(base, sid, tool.name, args, exec.signal, true)` |

注意：`DESIGN.md` 附录记录的行号（dsh-native.js:131 toolDefinition）与当前构建一致，但行内容已随版本漂移；本次核对以 grep 实测为准。

### 1.4 本机会话 PTC compress 回执实测（2026-10-24，脱敏）

对 `C:/Users/you/.dsh/sessions/--D-work--/session-11aab7ab-e2b1-46cd-bd17-ca360233140b/session.v4.jsonl.zstd`
（zstd 只读解码，同一文件即 DESIGN.md §11.2 探针所用）抽样 5 个 `tool/ptc-dispatch`（name=compress）事件：

- `data` keys = `rootCallId, parentCallId, subCallId, name, arguments, isError, content`；
  **`data.blocksCreated` 字段在本机构建中不存在**（宿主事件层不透出数值）。
- 成功回执（`isError:false`）content 首行固定为：
  `[Compressed m00004–m00010, m00011–m00018 → 2 block(s), ~41854 tokens saved.]`
  —— `→ N block(s)` 即实际创建块数（5 个样本分别为 2/3/2/2/2 块，b1…b15 编号连续递增）。
- PARTIAL 回执（源码格式）：`[acp-result: PARTIAL — N block(s) created; …]`。
- 结论：适配层把这两种**已证实格式**作为「实际创建块证据」解析；数值字段若未来版本提供则优先；
  其余文本一律不解析（不猜「Compressed」字样即成功）。证据仅为形状与计数，未保留任何会话正文。

### 1.5 会话事件类型与 PTC

- `C:/Users/you/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:133-134`
  与 `lib/types/known-event-types.js:75-76`：`tool/ptc-dispatch`、`tool/ptc-dispatch-start` 是持久会话事件类型。
- `…/dsh-api-session-controller/lib/client.js:191-192`：同一事件类型清单；`lib/index.js:1156`：`tool/ptc-dispatch` 的 `data.content` 携带块内容。
- `…/dsh-harness-dev-context/lib/index.js:98-120`：另一处 section 注册实例，`text: (context) => string` 同步。

### 1.6 DESIGN.md §11.2 已完成的探针事实（引用，非本次产出）

会话 `session-11aab7ab-…` 的 `session.v4.jsonl.zstd` 解码：compress 位于 `tool/ptc-dispatch-start` seq=138、`tool/ptc-dispatch` seq=139，`name=compress`、`isError=false`，回包创建 b1/b2；无原生 compaction 事件。⇒ PTC 子调用完成在宿主会话事件流可见，是本模块事件探针的事实依据。

## 2. host 抽象与 service 契约

### 2.1 host 抽象（注入给 createHostBridge）

```js
registerSystemSection({ name, order, text }) -> disposer          // text: () => string | Promise<string>
registerTool({ name, description, inputSchema, execute }) -> disposer | Promise<disposer>
subscribeCompletedTools(listener) -> disposer              // listener 收到【已归一化】完成事件
getSessionInfo() -> { sessionId, scopeId, capabilities }
```

- 注册约定（第一轮 R1 的修复）：`registerTool` 允许返回 disposer **或** Promise\<disposer\>（真实
  DSH 适配层因动态 import `@deepseek-ai/dsh-tools` 为 async）；桥统一 await，注册期间发生
  stop()/start 失败回收时，迟到的 disposer 会被立即调用，杜绝异步注册泄漏。
- 生命周期（第二轮 L1–L3 的修复）：每次 start 捕获本地代际 token；所有 await 后验证 token，
  已取消的 start 返回 `{cancelled:true}` 回执且不订阅/不注册/不改 started；注册与启动代绑定，
  非当前代的迟到注册只撤销自身；start 失败只回收失败代的注册，旧代迟到失败不影响新代；
  start 进行中拒绝并发 start（INVALID_STATE）；cordis 同名注册抛错（dsh-native.js:131），
  迟到注册在真实宿主上走失败路径而非覆盖新代。
- 状态交错把守（第三轮 S1/S2 的修复）：同步快照刷新绑定发起调用的代际，读取结果作为候选值、
  提交共享状态前先核对代际与刷新序号——旧代的迟到读取/工具写后刷新/完成事件刷新都不得
  覆盖新代快照，同代并发刷新时较早读取让位于较新读取；`probe.restore({isCurrent})` 在候选
  校验通过后、提交 epoch/去重/水位之前由桥核对代际，旧代的迟到恢复不回滚新代状态。
- `subscribeCompletedTools` 的 listener 收到的是 `{eventId, sessionId, name, success, blocksCreated?, seq?}`；
  **原始会话事件 → 归一化事件的映射属于薄适配层**（`dsh-adapter.mjs` 的 `mapRawSessionEvent`），
  `seq` 为适配层扩展（宿主会话事件单调序号，跨重启去重水位）。
- 可选探测方法：`listRegisteredTools()` / `listRegisteredSections()`（存在时用于唯一写者预检）。
- `capabilities.asyncSectionText === true` 时 section text 可返回 Promise；false（真实 DSH 现状）时桥用同步快照。

### 2.2 service 契约（C 期望注入的对象；实装由 B/集成服务提供）

| 方法 | 语义 |
| --- | --- |
| `readPersona()` | `{ name, text, revision } \| { name: null, text: null }`；persona 独立 CAS 持久化由**后续集成 service** 实现（P0 依赖缺口，见 REPORT.md） |
| `readCoreView()` | `{ text, body, revision, scopeId }`；text = **完整渲染 L1**（core 正文 + 派生索引），由 B 用注入的 A.renderL1 生成；body = 磁盘 core 正文（不含索引），面板编辑与任何回写只能用 body |
| `readCore()` | `{ text, revision, scopeId }`；text = **磁盘 core.md 正文（不含索引）**。核心写路径必需——渲染视图绝不回写。B 的 store.readCore 即此语义 |
| `readTopic(key)` | Topic（含 `body`、`revision`）；不存在时**显式报错** |
| `listTopics()` | 当前可见去重 Topic[] |
| `search(query)` | `[{ key, title, summary, scopeId, score }]` |
| `mutate(request)` | 透传 B 的 commit：`{ operationId, changes: [{ kind: "core"\|"topic"\|"persona", key?, expectedRevision, text?, topic? }] }` → `{ operationId, generation, changes:[{ kind, key?, beforeRevision, afterRevision }], budget }` |

`kind:"persona"` 是 C 侧扩展（B 的 P0 契约只有 core/topic）：persona 写入走后续集成 service 的独立 CAS；测试以 stub 验证委托路径。`text` 对 topic 变更表示**候选正文**（front-matter 元数据经 `topic` 字段透传，由 B 序列化）。

桥内部用 **Proxy 委托**包装 service（mutate 后刷新快照）：不复制属性，class 原型方法、私有字段与依赖 `this` 的普通方法都保持原 receiver（第一轮 R3 的修复）；调用方无需把 service 改写成闭包对象。

## 3. 能力探测矩阵（2026-10-24 静态核对结论）

| 能力 | 结论 | 依据 / 理由 |
| --- | --- | --- |
| `ctx.systemPrompt.section` 函数式 text，逐次求值 | **可用（同步）** | soul-md index.js:337-372、harness-dev-context:98-120；`assemble()` 为 async（agent-loop:903） |
| section text 支持 Promise | **未证实** | 所有现存用法均为同步；适配层声明 `asyncSectionText:false`，桥退化为「同步快照 + 事件后刷新」 |
| `ctx.tools.register(defineTool(...))` | **可用** | soul-md index.js:579-630；`exec.agent.session.id` 取会话 |
| 同名工具重复注册被拒 | **可用** | dsh-native.js:131 `already registered` 错误（bili 将其计为 adopted） |
| `ctx.on("session/event", …)` 返回 disposer | **可用** | agent-loop index.js:977-982 同款用法 |
| `tool/ptc-dispatch` 事件可见 compress 完成 | **可用（本机 code-mode 已实测）** | DESIGN.md §11.2 探针 seq=138/139；dsh-session 事件类型注册 |
| 直接模式 tool/result 的数值 blocksCreated | **未证实** | tool/result 只带 `{callId, content, isError, meta?}`；`meta.blocksCreated` 是否承载该值静态不可证实 ⇒ 适配层仅在 meta 携带数值时透传，否则 `blocksCreated=undefined` ⇒ 探针不推进 |
| PTC 模式块证据（本机 code-mode） | **已实测证实（文本格式）** | 见 §1.4：`data.blocksCreated` 字段不存在；成功回执固定 `→ N block(s)`、PARTIAL 固定 `N block(s) created`。适配层按这两种已证实格式解析；除此之外（含其他部署模式）不推进、诊断标注 |
| 完成事件跨重启去重 | **已实现（不淘汰的会话水位 + 显式会话归档）** | 序号来源：宿主持久会话事件的单调 `seq`（§1.4 decode 与 dsh-session 事件结构）；适配层把 seq 附在归一化事件上。去重依据 = 每 session 持久水位，**不因其他会话/事件数量淘汰**（第二轮 L4 反例的修复）；`forgetSession(sessionId)` 显式归档会话，归档后该会话压缩事件一律拒绝（reason "expired-session"，fail-safe：宁可漏推进不误判为新压缩）。乱序策略：会话流内 seq 单调到达；跨重启后迟到的 seq ≤ 水位事件按已处理处理。资源边界：watermarks/expiredSessions 随不同会话数线性增长（千级会话 ≈ 数十 KB），无 seq 兜底集合固定 ≤4096 条；恢复为原子（损坏即报错且保留旧状态）。 |
| `preparedCall.systemPromptUpdate === "in-history"` 实际取值 | **未证实（运行时才定）** | agent-loop:1057-1060 取决于 preparedCall；必须 §11.2 矩阵实测 |
| 用户侧附件（L2 投递）真实 API | **不支持** | 无已证实 API；桥对 `l2Delivery` 配置直接抛 UNSUPPORTED，不伪造消息 |
| epoch 按 scope/session 分区（DESIGN.md §4.3.4 seenIds 键） | **P0 未做（明确缺口）** | P0 探针为单一全局 epoch + 每 session 水位，仅服务压缩事件去重；L2 的 `scopeId+sessionId+contextEpoch+sparkId+revision` seenIds 键与按 scope 推进属 P1，本批未实现 |

## 4. 当前不能验证的出站矩阵（P0 未完成项）

以下必须按 DESIGN.md §11.2 在隔离会话实测，**mock/单测通过不代表完成**；未通过前不得切换替代 soul-md：

1. baseline → 修改 L1 哨兵 V1 → 下一次请求的最新完整 system 同时含 persona / core V1 / index / 宿主其他 section；历史稳定前缀逐字可比较。
2. 成功压缩一轮 → 不改 L1 再发请求：最新完整 system 未丢、可重建（防「渲染没变但下游消失」）。
3. 成功压缩一轮 → 再改 L1 为 V2 → 发请求：同时核对宿主 surface、实际出站请求、模型复述哨兵；不能只看模型自报。
4. 连续修改 ≥5 次：量测完整 system 副本 / 历史增长；再测新系列、恢复会话、支持/不支持 in-history 路由的旧副本清理。
5. input / cached / uncached usage 记录；服务端未返回 cached usage 时标「未知」，不写「缓存不破」。抓包只留哨兵/hash/计数，不落人设正文与凭据。

详细步骤见 `docs/host/acceptance-checklist.md`。

## 5. 部署边界（P0 不装载）

- 桥默认 shadow；active 需要同时 `mode:"active"` + `config.hostBridge.allowActive === true`，且启动前过唯一写者校验。
- **不在真实 profile 启用**：`assembleDshShioriHost()` 不自动 start、不写 profile、不重启 DSH、不发模型请求。装载/切换由操作者按 DESIGN.md §11.1 单次切换流程人工执行。
- 与 soul-md 并存时：同名工具只能启用一个提供者（唯一写者校验会在 soul-md 未卸载时以 INVALID_STATE 拒绝 active 启动）。

## 6. 已知限制（与 REPORT.md 一致）

1. 同步快照窗口：真实宿主 section text 只支持同步 ⇒ 手改磁盘到下一个完成事件/写入提交之间，section 显示旧快照（soul-md 因同步读文件无此窗口）。缓解：完成事件与 mutate 后自动刷新；根治需集成 service 提供同步快照读。
2. 直接模式 compress 的块证据未证实 ⇒ epoch 只认 PTC 已证实格式（§1.4）；直接模式仅观测诊断。
3. persona 的 CAS 持久化依赖后续集成 service（soul-md 走 settings 命名空间，非文件 CAS）。
4. `memory_rewrite(topic)` 把内容解释为「候选正文、元数据保留」，依赖 B 的 topic 序列化语义；需在合并验收时与 B 对表。
5. `core_write(section)` 未实现（显式 UNSUPPORTED）；topic_create / memory_demote 不在 P0 兼容清单。
6. 旧工具的 read-then-CAS 是**读取版本后 CAS**，不等于「同一 coordinator 内版本读取」：读与 CAS 之间存在窗口，靠 B 的跨进程锁 + CAS 兜底（冲突即 REVISION_CONFLICT，调用方重试）。集成 service 若提供内部读改写一体请求形状（如 `mutate` 支持 `readThenWrite` 回调），桥应迁移过去；本批不改公共契约、不假造版本。
7. epoch 为全局单调值，未按 scope/session 分区（见 §3 矩阵行）；L2 生命周期（seenIds、冷却）不在本批。
