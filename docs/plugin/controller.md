# Shiori P5 controller — 可信宿主与业务 controller（slot P）

状态：P5-HOST-CONTROLLER attempt 3（a2 审查 REWORK 后返工；owner 审查前；未经真实
P+Q 组合与真实宿主 runner 验收）。

## 入口

```js
import { createShioriPluginController } from "../src/plugin/controller.mjs";

const controller = await createShioriPluginController(ctx, settings, dependencies);
// → { start(), stop(), diagnostics(), management }
```

- 构造**不自动 start**；`start()`/`stop()` 幂等；start 失败逆序清理，不残留工具 /
  section / 完成状态锁。
- **start/stop 互锁（a2）**：`stop()` 先置 `stopRequested` + `banned` 再 `await`
  在途 start（start 体内检查点见到即中止并零残留清理）；stop 返回时宿主资源必然
  已全部撤销，可立即重启（不 LOCK_BUSY）。cleanupGeneration 串行化，start 失败
  路径与 stop 并发到达也幂等。
- `settings` 由 Q 的 `normalizePluginConfig` 归一化后传入；P 在
  `scope.mjs#validateControllerSettings` 完整再校验（未知键拒绝、root 成对绝对且
  disjoint 不嵌套、active 必须 allowActive、预算 validateConfig + 生产安全上限、
  forgetting policy normalizeForgetPolicy）。
- `dependencies` 只用于可信程序注入/测试（createService / createSparkStore /
  openState / bindings / createPersona / createState / now / loadDshTools /
  loadDshLlm），不进入可序列化 Config。

## 挂载形态

| 形态 | 条件 | 行为 |
| --- | --- | --- |
| inert | shadow 且 dataRoot/stateRoot 皆 null | 不启 runtime、不注册任何宿主资源；management 仅 getStatus，其余 NOT_CONFIGURED |
| shadow + roots | shadow 且显式双 root | **纯内存只读（a2）**：注册零工具/零 section/waterfall/pre-step；不打开 completion 锁 / scope 资源 / receipt（shadow 抢独占锁会把真的 active 挤成 LOCK_BUSY）；getStatus 仅纯内存（scope 解析可用、occupancy 恒 null）；其余方法 UNSUPPORTED |
| active | mode=active 且 allowActive | 16 工具 + 2 section + assemble waterfall +（l2.enabled 时）pre-step；完成事件订阅（压缩探针）；全部配置 persona 启动预校验（坏卡 fail-fast 可操作错误） |

shadow（含 inert）全程不触盘（stateRoot 零文件）；所有触数据根的门面集中在
active。真实宿主接线只经 `bindings.mjs`（ctx.systemPrompt / ctx.tools /
ctx.on）；ctx.baseUrl 不是 profileRoot，P 不猜 profileRoot，并列
shiori-data/shiori-state 由 Q 的 apply 显式计算并传入。

## 宿主 complete section（a2 实测结论 + a3 诚实度）

宿主 dsh-system-prompt 在 waterfall **之前**按本次 assembly 的 scope 合并
sectionDefinitions 并快照 complete section，waterfall 之后若有快照则用
`[completeSection]` 整体替换 sections（lib/index.js:380-403）——**该 scope 的
本次装配**里本包 L0/L1 的改写会被丢弃。关键事实：complete 遮蔽只对「它所属的
那一次 assembly」成立；别的 scope（如 desktop/web 的 preset minimal）注册
`complete: true` 的 persona 与全局 L0/L1 无关（a3 实机缺陷：旧实现遍历
`layers.scoped` 全量探测，导致真机 L0/L1 永不注入）。行为：

- **启动探测（三态，a3 返工）**：`detectCompletePromptSections` 只读
  `layers.global`（**绝不**扫描 scoped 层），返回
  `{ state: "ok" | "none" | "unavailable", sections }`：可读且命中 / 可读未命中 /
  注册表不可读（不可判定；systemPrompt 缺失视为 none）。diagnostics 暴露
  `completeProbe`；不可判定时 L0/L1 照常注册（无法证明会被丢弃），但
  `l0l1Effective` 如实报 **"unknown"**，不报 true。
- 启动探测命中（global 有 complete section）则不注册 L0/L1 section/waterfall，
  `completeShadowed=[…]`、`l0l1Effective=false`（工具与 L2 不受影响）。
- **运行期按本次装配判定（a3 返工）**：宿主交给 waterfall 的 assembly.sections
  已被映射为 `{name,text[,interpolate]}` 且**剥掉 complete 标记**
  （lib/index.js:385-393），故不能用入口 section 推断；改为
  `detectCompleteSectionsForScope(systemPrompt, context.scope)` 用宿主同一份
  `layers.merge(scope, …)` 在本 scope 内判定。命中即原样返回：不刷新、
  不进 assemblies/assembliesRefreshed 计数，仅
  `counters.assemblyCompleteShadowed += 1` 并在 `counters.assemblySkips`
  记一条 `complete(<name>@<scope>): …` 原因。运行期注册表不可读时
  照常尽力刷新，但记 `assemblyProbeUnverified`，`l0l1Effective` 报 "unknown"。
  diagnostics 另暴露 `assemblyCompleteProbe`（三态）与
  `assemblyCompleteShadowed`——不可判定 ≠ 有效，绝不谎报 true。

## 可信 scope

- 工具：`exec.agent.session.id`（HOST-API-NOTES 与 dsh-native.js:131 同款）。
- assemble/pre-step：`context.agent` / `payload.agent`；无 agent（诊断装配）不读业务。
- RPC：`trustedContext.session.id`（Q resolver 按 invocation.peer.principal 授权后
  服务端绑定；source 必须 panel-rpc）。
- **workspace（a2/a3）**：以上四处**与压缩事件归属（a3）**统一经
  `ctx.workingDirectory.get(session)`（只读投影读；绝不调用会追加
  working-directory/change 事件的 `ensure()`）解析 workspace，传入
  `pinScope` —— workspacePersonas 生产可达，面板 scope / L2 压缩 epoch 不再串
  default 卡。a3 起压缩事件不再读 session.header.cwd（与工具路径分叉时以投影
  为准）。diagnostics.counters.workingDirectoryLookups 记录查询次数；服务缺失时
  null（回落 defaultPersona，不猜）。
- 每次 `pinScope` 冻结 `{sessionId, workspace, scopeId, ownerId, generation}`，
  跨 await 不改写。
- payload 中 `scope/scopeId/persona/authorize/ownerId/root/trustedContext` 显式拒绝。
- 选卡：sessionPersonas 精确 → workspacePersonas 规范路径最长边界匹配 →
  defaultPersona；null = global memory。active 启动预热全部配置 persona 的 scope
  资源（工具描述/schema 来源 + epoch 账本按正确 scope 建立）。

## 16 工具

9 兼容（soul_read/soul_update/memory_read/memory_search/memory_append/
memory_rewrite/core_write/topic_append/memory_list_topics）+ topic_create +
6 Spark（spark_save/read/update/forget/feedback/graph）。全部经真实
`@deepseek-ai/dsh-tools` defineTool 注册，`output:{schema,render}` 必备（
lib/index.js:842 直接读取；runner 按编译后 schema 校验成功输出）。

- 输出 schema 唯一权威 `tool-schemas.mjs`：value schema DSL 形状（属性级
  required:true、oneOf 联合、显式 additionalProperties；经真实 defineTool 编译验证）。
- 所有写工具支持 `operationId`（缺省生成）；重放账持久于 stateRoot
  （scope+业务 payload 指纹），同 op 同 payload 重放首结果、先于任何新 read /
  时间生成；异 payload 拒绝。store/journal 层幂等保持不变。
- topic_create 走 service.mutate（kind:topic + expectedRevision null 的创建语义，
  本次在 service/index.mjs 显式放行且要求 title/summary），派生目录 / 索引增长 /
  完整 L1 预算由 store policy 在候选快照上统一裁决；active 已存在同 key →
  INVALID_INPUT（不静默改写）；仅 global 同 key → 创建 active shadow。
- memory_search 新增 `includeArchived`（显式冷搜，只读、不复活、不自动匹配；
  经 createColdSearch 门面，organize/forgetting 开关不影响）。
- host/tools.mjs 保持 `createCompatTools` 恒为 9 个；topic_create 独立工厂
  `createTopicCreateTool`（基线测试不动）。

## L0/L1 投影

- 同步 section（shiori:persona order 0 / shiori:core order 0.5）给安全占位
  （本 scope 缓存）；真实刷新经 `system-prompt/assemble` async waterfall：
  await next() 保留其他插件结果 → 从 context.agent 固定可信 scope → await
  readPersona/readCoreView → 仅替换本包两条 section.text。其他 section / tools /
  contexts / variables 不动；无 agent 的装配只计数不读业务；section 缺失
  （complete-prompt composition）计 UNSUPPORTED 诊断、不 monkey-patch。
- **错误隔离（a2）**：waterfall 体内 try/catch——一张坏卡只降级自己（读取失败的
  section 保留宿主原样、`counters.assemblySkips` 记录），绝不外抛打挂整轮装配；
  外层兜底捕获记 `counters.assemblyErrors`。
- L0：persona adapter 持久化 dataRoot/persona；坏外改保留 lastvalid（stale 标注）、
  无 lastvalid 时 start 阻止该 scope 启用（probe；a2 起对**全部**配置 persona
  启动预校验，坏卡 fail-fast 并列出可操作修复信息）。
- L1：完整渲染超 hardCap → 保留 lastvalid 并告警（不截断铁律）；无 lastvalid 投递
  诊断占位（不抛错阻断 hook，写入修复由工具路径的预算闸门约束）。
- 涵盖所有 tool continuation 请求（宿主每次请求都 assemble）。

## L2 投递（l2.enabled）

1. `agent/pre-step` 仅扫 `role==='user' && source.kind==='user'` 的新消息；稳定
   原始 eventId = `Message.id`；scanned 账去重（重试不重复投递）。
2. `matchSparks` → `buildSparkAttachment`（3+2≤5、maxChars/inlineMaxChars 等预算
   全部来自 settings.budgets.spark，无硬编码）→ 0 投递则透传。
3. `createUserMessage`（dsh-llm）产独立 text context message：
   `source.kind='shiori-sparks' / form='recall'` + deliveryId/scopeId/sparkIds；
   不用 blob API、不改原文、不冒充 human。
4. pending（含完整 delivery 快照）先于返回落账 → `await next()` 保留其 messages →
   追加本包消息。
5. accepted 仅认真实 surface append：`session/event user/message` 且
   `event.data.id === messageId` 且 `source.kind==='shiori-sparks'`；claimed /
   inject-return / pre-step enter 均不算。
6. 逻辑提交：持久 accepted receipt → store 幂等 hit（`recordDeliveryHits`，同
   deliveryId 重放零写、不重复计数）→ 持久 hit 账 → 持久 seen → committed 终态。
   任一点崩溃由 `recoverL2` 补齐（按 accepted 证据）；**a2**：无 receipt 的 pending
   按 `Message.id` 回查真实会话派生历史（`agent.session.deriveMessages()`，只读）
   ——消息已在历史（append 成功后崩溃）→ 补 accepted 并收尾（hitCount 恰好 1），
   不重发；日志无证据才保持 pending 禁重发（不盲目重发原 event）。
7. **崩溃窗口去重（a2）**：同 deliveryId 的 pending 已存在（recordPending 后、
   回执前崩溃）→ 不再追加第二条消息，回查会话日志补 accepted；扫批标记
   （markScanned）后置于 recordPending / 决策之后，「已扫」只记录已定局的消息。
8. epoch 每 session 隔离（压缩成功仅推进归属会话的 epoch；A 不清 B 冷却）；压缩
   探针沿 compress-probe（同 callId direct/PTC 仅推进一次）。

## 管理 API（management）

DTO 与校验唯一权威 `protocol.mjs`（纯 JSON；Q 只使用该文件）。9 方法：
getStatus / getMemoryView / getGraph / executeTool / listCandidates / analyze /
reviewCandidate / previewPlan / executePlan。

- analyze(organize)：analyzeCandidates → **队列收敛 converge（a4；a5 收紧）**——以本次
  分析为准：仍在场候选保留原 status（reviewed 不退回）、新候选 pending 追加、本次
  不再出现的候选（源卡已 merged/archived 或派生条件消失）移除；空集合允许（清空
  队列）。**a5**：CAS 先于 journal——陈旧 expectedQueueRevision 的
  REVISION_CONFLICT 不再毒化 operationId（修正后同 operationId 重试真正收敛）；
  journal 落收敛后队列快照，journal 与队列保存之间崩溃由重放短路幂等修复（磁盘
  revision 落后才补写）；候选命中派生上限 1000（可能截断）时启用 keepAbsentIds
  保护——"不在候选集但源卡仍全部 active"的既有队列项保留原 status，源卡已
  retired 的照常移除；未截断时"不在场=移除"语义不变。**a5**：analyze(organize)
  亦作废此前 open 的 organize 计划（计划账与队列同步收敛；executed 保留审计；
  重放不补跑，避免误杀此后 previewPlan 的新计划）。
  operationId 幂等：analyzeOps 账重放返回首次派生结果，不二次收敛。
- analyze(forgetting)：analyzeForgetting（真实 now 注入；plan 非空才落 plan 账，
  planId = `fp-<digest>`；空结果不落账）。**a4**：plan 落账带真实展示 diff
  （spark:<id>，before/after 投影 + state active→archived + revision+1）；同 kind
  其他 open 计划被本次作废（superseded），只收敛到一条 open。
- executePlan（a4）：执行完成后立即收敛队列——移除引用「已不再是 active」源卡的
  候选（merge 退休 / forgetting 归档后不再画出失效条目；link 源卡仍 active 不动）。
  已 superseded 的计划执行被服务端 REVISION_CONFLICT 硬闸拒绝。
- previewPlan(organize)（a4）：新预览作废同 scope 其他 open organize 计划
  （abandoned preview 不再累积）；被作废计划不可复活（planId=digest 不可变）。
- previewPlan：organize 严格 buildDraft（planId = `op-<digest>`，diff/changedItems
  来自真实候选+records）；forgetting 从 plan 账取回；thin-core UNSUPPORTED。
- executePlan：confirmed===true + digest 绑定；**plan 一次性（a2）**——已执行的
  plan 拒绝重跑（REVISION_CONFLICT，含同 operationId；执行器层 operationId 幂等
  只覆盖底层重放，不替代管理层检查）；授权仅本次调用
  {scopeId, sessionId, generation, planDigest, operationId}，signal 断开 / stop /
  generation 变化即撤销；底层每次 authorize（含重试与 merge 退休前）重验。
  **取消核验（a3，B-abort）**：registerGrant 入口发现 signal 已 abort 即刻撤销
  （已 abort 的 signal 上挂监听永不触发）；authorize 每次核验含 signal.aborted；
  注册后（executor 之前）与 markExecuted 之前各有一次显式核验——任一命中即
  AUTHORIZATION_REQUIRED，plan 保持未执行可重新批准；executor 抛错时授权随调用
  收场撤销。organize 经 createOrganizerExecutor（budgets 透传），forgetting 经
  createForgetExecutor。approval.actor 固定 'main-session'（本批无 idle-heartbeat）。
- 队列/plan 账持久于 stateRoot，跨重启恢复（严格快照校验）。
- **写工具并发（a2）**：dispatchTool 按 (scope, tool) 串行化（lookup → execute →
  record 窗口不并发），同 scope 同写工具并发调用排队执行；读工具保持并发。
- **在途排空（a3，M4-drain）**：8 个数据方法（getMemoryView/getGraph/
  listCandidates/analyze/reviewCandidate/previewPlan/executePlan/executeTool）
  全部纳入 trackInFlight——stop 等待在途调用收场（10s 上限，超限项如实写入
  stop().errors），RPC 不再撞已关闭的 store；getStatus 纯内存不占在途。
- **getSessionInfo（a2）**：工具执行期间经 AsyncLocalStorage 注入真实
  sessionId（dispatchTool 的可信 scope 证据），不再固定 null（本插件树内暂无
  sessionId 消费方，形式就绪）。
- **Gateway 严格 codec（a4，P-C；a5 修 B-P2）**：start 时经
  `typert-descriptors.mjs#registerShioriTypert` 把 9 个方法的严格 invocation
  描述符注册进宿主 typert registry（`{package:"dsh-shiori-panel", face:"host"}`，
  endpoint=`shiori/<method>`，session=lookup source、payload=json strict、
  cancellation=signal、result strict+encode JSON 安全检）。Gateway
  resolveDescriptor 严格优先——`getStatus().diagnostics.typertRpc`（a5 新增）
  与 controller diagnostics.typertRpc 如实报告 `codec:"strict"|"src"` 与 reason。
  typert 服务经 `readOptionalCordisService` 可选读取（**a5，B-P2**：Cordis
  fiber 对未 inject 服务的属性访问会直接抛 `cannot get property … without
  inject`，入口 index.mjs 只 inject tools/systemPrompt——先 `ctx.get`（缺席返回
  undefined 不抛）再兜底属性访问）；调用点另有 try/catch 收敛成
  `{codec:"src", reason:"typert registration threw: …"}`。注册/核对失败一律
  回退 SRC（现状行为），不阻断启动；payload parse 为恒等（业务校验独家在
  service 层，保持 INVALID_INPUT 错误码契约；typeSymbol 宿主不做 schema 解析
  ——严格仅名义：收益为端点唯一性/wire 绑定/cancellation/JSON 安全网）；
  stop 撤销描述符（disposer），上一代未干净 withdraw 时逐字一致则 adopt。
  **a5**：workingDirectory 的读取同样走可选读取（真机上属性访问会抛并静默
  退化 defaultPersona——修复后 B1 的 workspace 接线在真机真正生效）。

## 已知限制（如实）

- L2 accepted 的「跨重启 receipt 证据」优先按 `Message.id` 回查真实会话日志
  （a2）；会话对象不可达（诊断装配、会话已关闭）且无 receipt 时 pending 保持并
  禁重发（不伪造跨崩溃 exactly-once）。
- pre-step 的 sessionId→scope 映射依赖 settings 静态映射；本批无运行时改映射入口
  （显式切卡映射由原生配置承载，下一调用生效）。
- createOrganizerExecutor 的 budgets 参数为 P5 增量（白名单内、向后兼容；缺省行为
  与基线一致，organize 测试 41/41 通过）。
- executePlan 在「markExecuted 前二次核验 → markExecuted 落账」之间仍有纳秒级
  窗口（abort 恰落在核验后）：此时执行已真实完成且账本标记执行——与「执行完成」
  语义一致，不会重复执行；完全消除需底层事务化（超出本批）。
- complete section 探测不可判定（layers 不可读）时 L0/L1 照常注册（无法证明会被
  丢弃），有效性如实报 "unknown"；晚注册场景由 assemble 每轮只读重探兜底（a3）。
- 真实宿主端到端（DSH 进程内 mount/unmount、真机工具 runner、真模型出站）未跑，
  见 REPORT.md 证据分级。
- executePlan/previewPlan 的收敛只到「队列无失效候选、open 计划唯一」；
  planId = digest 不可变，被作废计划不可复活（重新预览同内容仍指向同
  planId、保持 superseded）。
- 严格描述符注册的 hasSeen 窗口：stop（withdraw）→ 再 start（re-register）
  之间到达的 gateway 调用报 gateway/definition-unavailable——与「服务不在场」
  同窗；崩溃未走 stop 时描述符残留至 DSH 进程结束（registry 进程内存态），
  下代注册走 adopt。
- payload 严格 codec 的 parse 为恒等：gateway 边界不做语义收窄（拒绝式
  codec 会把 INVALID_INPUT 改写成 gateway/input-invalid，破坏真机已验证
  行为）；JSON 安全检由 gateway 自身与 result encode 承担。
