# CONTRACTS.md — Shiori 写实契约索引

> **本文件是什么**：仓库历史上有大量源码注释引用「CONTRACTS.md §X」，但该文档从未存在于仓库（0.4 收口审计 #2 确认 git 全历史无此文件）。本文件是 0.4「文档与注释对齐」任务按以下纪律重建的契约索引：**只写能从当前代码验证的事实，逐条标出处（文件:行号）；查不到实现依据的条目明确写「未定义」**。
>
> **编号说明**：历史协作注释按开发槽位（slot A–Q、1–8）复用了 §A–§I 与 §1–§8 两套编号，同一编号在不同槽位语境下指不同契约（如 §2 在 P 槽指 plugin 装配、在 J 槽指 organize 分析职责）。本文件按槽位分节，每节标注该槽注释使用的编号；源码注释里的引用按「槽位 + 编号」对号入座。
>
> **行号有效性**：行号以 0.4 分支（基线 61854b5 及其后）为准；后续代码移动只影响行号不影响事实本身。

---

## A · Core 层（注释编号 §A）

被引用处：`src/core/render.mjs:4`、`src/core/topics.mjs:5`、`src/core/budget.mjs:8`、`test/storage/helpers.mjs:2`。

- **公共入口仅导出六个成员**：`DEFAULT_CONFIG` / `validateConfig` / `renderL1` / `evaluateMutation` 等（完整清单见模块头注释）。出处：`src/core/index.mjs:2-10`。
- **L1 渲染索引格式固定**：磁盘 `core.md` 只存人工正文，`renderL1` 在读取时派生索引、禁止回写。索引标题行 `## 主题记忆索引`（/ `Topic memory index`），条目行 `- key [scopeId] — summary`，归档钩子行仅在存在冷专题时出现；`chars` 按 UTF-16 码元计、`bytes` 为 UTF-8 字节数（仅诊断），标题/换行/来源标记全部计入 chars。出处：`src/core/render.mjs:3-10`。
- **Topic 可见性规则**：`scopeId === activeScopeId` 或 `"global"` 可见；同 key 时 active 覆盖 global；其他 scope 一律不可见；同 scope 内重复 key 是数据错误；输出按 key 的 UTF-16 码元序稳定排序，不依赖 locale。出处：`src/core/topics.mjs:5-12`。
- **预算闸门规则（双水位 + 绝对硬顶）**：唯一水位基数 `config.core.hardCapChars`（默认 10000），`softAt=floor(cap×softRatio)`、`hardAt=floor(cap×hardRatio)`；占用按完整渲染文本的 UTF-16 码元数计。规则：当前 < hardAt 时候选可首次跨入 ≥hardAt 但候选 ≤ cap；hardAt ≤ 当前 ≤ cap 时禁止净增长；当前 > cap 时只允许净减少修复；当前正常时候选 > cap 则写盘前拒绝。出处：`src/core/budget.mjs:3-13`。
- `test/storage/helpers.mjs:2,29` 声明其 stub 语义按 §A/§B 文字实现（A 模块合并后已由真实 `evaluateMutation` 替换 stub，注释为历史留痕）。

## B · Storage 文件仓库（注释编号 §B）

被引用处：`src/storage/index.mjs:2`、`docs/audit/2026-11-07-a-storage-service.md:106`、`test/storage/helpers.mjs:2`。

- 公共入口导出 `createFileStore` 与 `StorageError`；`groupsFilePath`（0.4 S3 组清单物理路径助手）一并从入口导出。出处：`src/storage/index.mjs:4`（createFileStore）、`:5`（StorageError）、`:8`（groupsFilePath）——文件共 8 行。
- 详细协议（两阶段事务日志 / CAS / 跨进程锁 / staging 自愈）与已知限制见 `docs/storage/README.md`（`src/storage/index.mjs:2` 显式指向）。DESIGN.md §3.2 有同口径摘要。
- 写路径统一走 journal 两阶段提交 + 原子替换 + 版本哈希 CAS；Core/Topic 锁文件为 `<dataRoot>/.shiori-lock`。出处：`src/storage/`（`store.mjs` / `journal.mjs` / `lockfile.mjs`）；落盘清单见 DESIGN.md §2.2。

## C · 宿主适配接口：压缩事件探针（注释编号 §C「宿主适配接口」）

被引用处：`src/host/compress-probe.mjs:4`。

- 完成事件归一化为 `{eventId, sessionId, name, success, blocksCreated}`（`seq` 为适配层扩展）；只有 `name === COMPRESS_TOOL` 且 `success` 且 `blocksCreated` 为 >0 整数才推进 `contextEpoch`；失败/零块/无块证据不推进；一次 batch/partial 只要创建块只推进一次；重复 `eventId` 不重复推进；不得靠 token 骤降推断（模块不接受 token 信号）；epoch 与去重持久化，重启重放不再推进。出处：`src/host/compress-probe.mjs:4-12`。

## D · 运行时装配与宿主桥（注释编号 §D）

被引用处：`src/runtime/index.mjs:7`（引作 `../../docs/CONTRACTS.md §D`）、`src/host/dsh-adapter.mjs:303,366`、`src/acceptance/index.mjs:16`。

- `createShioriRuntime(options, dependencies)` → `{start, stop, refresh, diagnostics, service, bridge, host}`。核心边界：scope/root 只来自 factory 可信参数，工具 payload 不能改变它们（tools 层 `rejectScope`、service 层 `noScope`）；`dataRoot` 与 `stateRoot` 必须是不同绝对路径且互不嵌套（含 junction/symlink 解析后判定）；shadow 全程不调用有写副作用的 factory，未注入只读 service 时用「诚实的 UNSUPPORTED 门面」（绝不以空文本冒充读取）；active 必须显式 `config.hostBridge.allowActive === true`，本模块绝不代设。出处：`src/runtime/index.mjs:5-19`。
- 宿主事件监听器必须返回对应处理 Promise；不返回的派发无法被排空，如实计数并在 flush 报告 `untrackedDispatches`，不静默。出处：`src/host/dsh-adapter.mjs:303-305`。
- `openCompletionState` 句柄的 `sink` 作为 `probeSink` 原样转交 `createHostBridge`，装配函数不解释、不缓存、不落盘。出处：`src/host/dsh-adapter.mjs:366-367`。
- 注：`src/runtime/index.mjs:7` 的契约路径早期写作 `../../CONTRACTS.md`（本文件落位 `docs/` 之前），现为 `../../docs/CONTRACTS.md`，按路径解析即指向本文件。

## E · completion state 句柄（注释编号 §E）

被引用处：`test/runtime/_helpers.mjs:4`、`src/acceptance/index.mjs:18`。

- `openCompletionState({root, scopeId})` 的返回句柄带 `sink`（作为 D 的 probeSink 注入）；runtime/acceptance 的工厂注入形状以此为准。出处：`src/acceptance/index.mjs:16-19`、`src/runtime/index.mjs:16`。
- 错误码至少区分 `INVALID_INPUT / INVALID_STATE / UNSUPPORTED / REVISION_CONFLICT / LOCK_BUSY`（completion 需要独立错误工厂，因 `src/host/errors.mjs` 的 CODES 集不含 LOCK_BUSY）。出处：`src/completion/errors.mjs:4-12`。

## F · 出站证据与验收矩阵（注释编号 §F「出站证据与矩阵接口」）

被引用处：`src/acceptance/index.mjs:2,28`。

- 公开接口：`validateEvidenceBundle(bundle) → {valid, cases, errors}`（无效不得 valid=true）；`runAcceptanceMatrix({...}) → schemaVersion=1` 的 bundle；runner 写报告前独立核验 artifact 存在、字节与 SHA256，拒绝越根路径与 symlink。出处：`src/acceptance/index.mjs:5-10`。
- 矩阵 case 固定至少 11 项 + 反馈增补项，bundle 必须包含全部 id（`REQUIRED_CASE_IDS`）。出处：`src/acceptance/index.mjs:28-45`。
- 证据等级纪律：普通 HTTP 客户端自发请求只能是 synthetic；bundle 级 evidenceType 只能由全部 passed case 的 case 级 evidenceType 推导且强制一致；缺真实环境的组合 → not-run 附重跑步骤，不可 skip 后总通过。出处：`src/acceptance/index.mjs:11-16`。

## G · L2 Sparks 存储与工具（注释编号 §G）

被引用处：`src/sparks/errors.mjs:2`、`src/sparks/graph.mjs:16`、`src/sparks/tools.mjs:4,216`、`src/host/errors.mjs:4`、`test/sparks/tools.test.mjs:2`。

- 错误码至少区分 `INVALID_INPUT / INVALID_STATE / REVISION_CONFLICT / NOT_FOUND / LOCK_BUSY / UNSUPPORTED`；`IO_ERROR` 为 sparks 模块补充（底层文件系统失败时显式抛出并保留 cause）。错误形状与 `src/storage/errors.mjs` 的 StorageError 对齐（name/code/details）但刻意不继承。出处：`src/sparks/errors.mjs:2-12`。
- host 桥错误（`src/host/errors.mjs`）要求带 code 的 Error，至少区分 `INVALID_INPUT / REVISION_CONFLICT / BUDGET_REJECTED / INVALID_STATE / UNSUPPORTED`，不静默截断。出处：`src/host/errors.mjs:4-6`。
- 可信 store 入口 `openSparkStore({root, scopeId, ...})`：`src/sparks/store.mjs:1155`。
- public record 字段集：`id, scopeId, revision, title, summary, triggers, entities, links, content, vitality, state`（图谱投影的消费形状依据）。出处：`src/sparks/graph.mjs:15-16`。
- 工具门面是纯 host-agnostic 门面，接收可信 scopeId 与 store 实例；payload 中出现 `scope` / `scopeId` / `root` 键一律 INVALID_INPUT。出处：`src/sparks/tools.mjs:3-10`；store 缺必需方法时报 INVALID_INPUT（`src/sparks/tools.mjs:216`）。

## H · L2 检索与投递纯函数边界（注释编号 §H）

被引用处：`src/sparks/match.mjs:3,21`、`src/sparks/delivery.mjs:3`。

- 两个模块同为纯函数边界：只处理传入的卡片/消息/会话状态；不读写磁盘、不注册 host/工具、不写 seen 状态、不猜测 compress 成功（`contextEpoch` 只由 P1 成功压缩证据推进，这里只接收参数）。出处：`src/sparks/match.mjs:3-5`、`src/sparks/delivery.mjs:3-8`。
- `commitDelivery` 只在 `accepted === true` 时返回「要写入的 seen/hit 变更」，写入由 store 层执行；失败、预算挤掉、工具步骤、system/历史/插件附件输入不会进入 delivered、不会标 seen。出处：`src/sparks/delivery.mjs:4-8`。
- 固定硬上限：`MAX_SEEDS=3`、`MAX_RELATED=2`、`MAX_ANCHORS=3`、`ENTITY_GENERALIZED_THRESHOLD=5`；合计投递 ≤ `spark.maxCards`（5）。出处：`src/sparks/match.mjs:19-26`。
- seen 键至少含 `scopeId + sessionId + contextEpoch + sparkId + revision`；只有成功提交为本轮 user 侧附件的卡才入 seen；`hitCount/lastHitAt` 只代表成功投递，`used` 只由 `spark_feedback` 记。出处：`src/sparks/delivery.mjs:13-15`。
- 附件预算：整包文本 ≤ `maxChars`（默认 600）；正文 ≤ `SPARK_INLINE_MAX_CHARS`（100）才带全文，否则只注入 `summary + id`；装不下降级为摘要或跳过，绝不截半句。出处：`src/sparks/delivery.mjs:9-12,20-21`。

## I · L2 图谱投影（注释编号 §I）

被引用处：`src/sparks/graph.mjs:3`。

- 只投影当前可信 scope 的 active 节点（archived / 其他 scope / superseded / merged 一律过滤，防御 store 缺陷）；边只从节点自身 `links` 派生（supersedes/mergedInto 是有向关系不属可投影边），悬空边、自环、重复边、跨 scope 边丢弃并计数；输出绝不携带 content/triggers 正文；全部排序用 UTF-16 code-unit 比较，不含时间戳、结果可复现。出处：`src/sparks/graph.mjs:3-14`。

## J/K/L 槽 · 记忆整理（注释编号 §1/§2/§4/§5-J）

被引用处：`src/organize/analyze.mjs:3,21,361,364-368`、`src/organize/executor.mjs:3`、`test/organize/analyze.test.mjs:2`。

- **§2（analyze 职责）**：从调用方传入的完整 active 卡快照（`store.listActive`）同步生成 isolated / link / cluster 三类候选，全程零写入零副作用；不 import node:fs/node:path、不改传入 records；候选只是建议，不含批准或执行语义；evidence 为确定性协议 JSON（无时间戳、无随机值、无 LLM 建议）。出处：`src/organize/analyze.mjs:3-19`。
- **§1（确定性公式）**：所有匹配按 trim+toLowerCase 归一化，去重并按 UTF16 码点二进制序排序；digest = SHA256(UTF8 stable({kind, scopeId, sources, evidence}))，stable 按「递归对普通对象键排序序列化」的字面公式实现，数组顺序保持；相同输入（含任意排列/键序差异）产出完全相同的候选集。出处：`src/organize/analyze.mjs:21-24,361,364-368`。
- **§4（executor 职责）**：只执行调用方每轮显式提交的单个已批准 plan（link / merge-topic / archive-topic），复用既有 service/store/spark store 的锁、CAS、journal、operation 幂等，不重写底层文件、不新增通用跨 DB 协调 journal；`authorize(...)` 必须严格 `=== true` 才继续。出处：`src/organize/executor.mjs:3-9`。
- **§5-J（测试覆盖口径）**：排列稳定、跨 scope/重复/非法输入、入边孤立等覆盖项。出处：`test/organize/analyze.test.mjs:2`。
- queue（K 槽）：`reviewed` 是「已审阅」不是「已批准/已执行」，队列不产生任何业务写入。出处：`src/organize/queue.mjs:3-6`。

## M/N 槽 · 双轨遗忘（注释编号 §1/§2/§3/§4/§5/§7）

被引用处：`src/forgetting/decay.mjs:3`、`src/sparks/store.mjs:74,966,1000,1023,1749,1875`、`src/forgetting/executor.mjs:10`、`test/forgetting/*.test.mjs`。

- **§1（衰减公式）**：`score = 2**(−elapsedDays/halfLifeDays)`；`halfLifeDays = min(baseHalfLifeDays × 2**useCount, maxHalfLifeDays)`；`elapsedDays = max(0, (now − (lastUsedAt ?? createdAt)) / 86400000)`；归档资格：active、ephemeral、`supersedes===null`、`elapsedDays >= 60` 且 `score < archiveScore`；默认 policy 恰为 `{baseHalfLifeDays:30, maxHalfLifeDays:240, archiveScore:0.25}`。出处：`src/sparks/store.mjs:74-81`、`src/forgetting/decay.mjs:9-13`。
- **§2（policy 规范化）**：`normalizeForgetPolicy` 对三字段做「部分覆盖 + 默认补全」的严格规范化。出处：`src/forgetting/decay.mjs:3-5`。
- **§1/§3（store 严格校验）**：forget policy 必须恰好三字段、拒绝未知键，base ∈ [1,365]、max ∈ [base,3650]、archiveScore ∈ (0,1)（`src/sparks/store.mjs:966-997`）；forget Source 恰好 `id/revision/createdAt/lastUsedAt/useCount` 五个自有键（`src/sparks/store.mjs:1000-1008`）；forget plan 严格校验（恰好六键等，`src/sparks/store.mjs:1023`）。
- **§3/§4（store 三提案）**：`store.archiveEphemeralBatch(...)` 批量软归档 1..20 张 active ephemeral 卡、任一失败零卡变化（`src/sparks/store.mjs:1749`）；`store.listArchived()` 当前 scope 恰好 archived 的完整卡、只读无 global fallback；`store.recordUsefulFeedback(id, {used, sourceEventId, operationId?})` 按 (scope,id,event) 去重、仅 `used=true` 时 useCount+1（`src/sparks/store.mjs:1875`）。完整描述见 `src/sparks/store.mjs:60-72` 头注释。
- **§7（fail-closed 授权）**：每次 execute（含底层可重放的尝试）都重新 authorize 并采样可信 now；`now < plan.now` 时即使同 operationId 已有持久收据也拒绝且不触碰 store。出处：`src/forgetting/executor.mjs:10-12`。

## P/Q 槽 · plugin 装配与面板 wire（注释编号 §2/§3/§4/§5/§6/§7）

被引用处：`index.mjs:3`、`src/plugin/{bindings,controller,config,scope,persona,state,tool-schemas,client-rpc,management}.mjs` 头注释、`client/index.js:11`、`docs/plugin/client.md:9`、`test/plugin/client.test.mjs:218`。

- **§2（Q/P 装配边界）**：插件入口 `apply` 固定顺序 `normalizePluginConfig → verifyPluginRoots → createShioriPluginController → controller.start → mountShioriRpc`，返回 async cleanup（RPC stop → controller.stop），部分启动失败逆序清理（`index.mjs:3-9`）；controller 生命周期冻结契约——构造不自动 start、start/stop 幂等、失败逆序清理、部分 start 不残留工具/section/锁（`src/plugin/controller.mjs:5-14`）；config 职责边界——Config 只证明可序列化结构 + 默认值，权威规范化在 `normalizePluginConfig`（未知键拒绝；0.4-S1 起 dataRoot/stateRoot 为 null 时解析为 DSH_HOME 默认根），路径安全由 `verifyPluginRoots` 真实校验（`src/plugin/config.mjs:3-10`；`verifyPluginRoots` 实现见 `:16-17`）；生产 bindings 来自 ctx（`src/plugin/bindings.mjs:1-3`）；scope 只能从可信证据解析，payload 中的 ownerId/scopeId/persona/authorize/root 一律拒绝（`src/plugin/scope.mjs:3-7`）；management 为面板管理 API 生产实现（`src/plugin/management.mjs:1`）。
- **§3（persona adapter）**：L0 persona 持久化到 `dataRoot/persona`；read/commit 与 service 契约一致（文件锁、CAS、原子写、持久 operationId 重放先于 liveCAS）；上限 12000 UTF-16；外改坏格式/超限不覆盖原文件。出处：`src/plugin/persona.mjs:3-8`。
- **§4（工具输出 schema）**：所有宿主工具提供 `output:{schema,render}`；输出 schema 覆盖所有读分支 / nullable / changes / 写回执；严禁空对象闭合 schema；实际 9 兼容工具 + topic_create + group_manage + 6 Spark 工具共 **17 个**（`TOOL_NAMES` / `TOOL_OUTPUT_SCHEMAS` 为唯一权威）。出处：`src/plugin/tool-schemas.mjs:3-5,127,304`。
- **§4/§5/§6（stateRoot 账本）**：工具 operationId 重放账（重放先于新 liveCAS）、L2 投递账（pending/accepted/committed 三阶段 + journal 可恢复提交）、L1 投影快照等；`src/plugin/state.mjs:3-9,187-225`（其中「§5」的历史原文未定义，此处按模块实际职责记录）。
- **§6（wire 冻结）**：面板 RPC wire 为 namespace `shiori` 的 management 方法 `(sessionId, payload)`；方法清单冻结为 **11 个**：`getStatus / getMemoryView / getGraph / executeTool / listCandidates / analyze / reviewCandidate / previewPlan / executePlan / getTimeline / destroyData`，由 `MANAGEMENT_METHODS`（`src/plugin/protocol.mjs`）唯一权威定义并 `validateManagementPayload` 校验；Q 侧挂载时若与冻结清单不一致立刻失败（`src/plugin/client-rpc.mjs:43-49`）；client 按同一冻结 wire 消费（`client/index.js:11-13`，测试镜像 `test/plugin/client.test.mjs:218`）。
- **§6.1（destroyData，0.4 S6 新增，wire 唯一一次增项）**：焚毁整个 dataRoot（目录本身一并移除）。输入闭合 `{ confirm: string }`（required，additionalProperties:false），语义是 `confirm` 必须等于当前 `settings.dataRoot` 原文（逐字符相等，不等抛 `INVALID_INPUT`）；输出闭合 `{ deleted: boolean, files: integer, bytes: integer, dataRoot: string }`（additionalProperties:false），目录不存在返回 `deleted:false` 而不是抛错。实现走共享模块 `src/storage/purge.mjs`（`purgeDataRoot(root, { expectedRoot, stateRoot })`）——与命令行 `bin/admin.mjs destroy` 同一份校验与删除代码，行为一致。安全边界（fail-closed，任一不满足抛 `PurgeSafetyError`，`details.rule` 记规则名）：目标必须绝对路径、不含 `..` 段、真实 link 解析后与 stateRoot 互不相交（相等/互相嵌套都拒绝）、非盘符根 / POSIX 根、非用户主目录（或其祖先；目标位于主目录之内允许——默认根 `<~/.dsh>/shiori-data` 本就在主目录内）、非仓库根（或其祖先；仓库根之内允许）、目标存在时必须是普通目录（symlink/junction 一律拒绝）；删除实现逐项 lstat——symlink/junction 只删链接本身，绝不递归删软链目标；IO 失败原样上抛，绝不忽略错误后继续。门面守门顺序：schema 校验 → inert（NOT_CONFIGURED）→ shadow/未 start（UNSUPPORTED / INVALID_STATE）→ 只读宿主（HOST_LOCKED）→ owner principal 二次核验（UNAUTHORIZED）→ confirm 比对（INVALID_INPUT）→ purge 安全校验 → 删除。出处：`src/plugin/protocol.mjs`（destroyData schema）、`src/plugin/management.mjs`（destroyData 实现）、`src/storage/purge.mjs`、`bin/admin.mjs`。
- **§7（RPC 授权）**：授权只认服务端绑定身份 `ctx.invocation.peer.principal`（本批仅 `principal.kind === "owner"`）；payload / wire 永不携带 trustedContext；存在 sessionId 不等于获授权。出处：`src/plugin/client-rpc.mjs:5-13`。

## host 桥工具最小集合（`src/host/tools.mjs:4-5` 引用）

- `createCompatTools` 覆盖契约要求的最小集合：`soul_read` / `soul_update` / `memory_read` / `memory_search` / `memory_append` / `memory_rewrite` / `core_write` / `topic_append` / `memory_list_topics`（9 个）；`topic_create`（独立工厂，`src/host/tools.mjs:542`）、`group_manage`（`src/host/tools.mjs:672`）与 6 个 Spark 工具（`src/sparks/tools.mjs`）由 controller 一并注册成 17 工具全集（`src/plugin/controller.mjs:82`）。

## §8 · 真实宿主证据（注释编号 §8）

被引用处：`test/plugin/host-contract.test.mjs:3`、`test/plugin/dsh-smoke.test.mjs:5`。

- 真实 DSH 工具 runner 必须检查全部成功输出（特别 topic_append 写成功后返回成功）；禁止只 mock `defineTool` 成功就称输出校验通过。出处：`test/plugin/host-contract.test.mjs:3-6`。
- 证据级别如实标注：synthetic 路径必须注明 stub；combined 路径（无 stub 替换）依赖 owner 归档的 immutable 提交，不存在时如实 not-run。出处：`test/plugin/dsh-smoke.test.mjs:5-14`。

---

## 未定义 / 历史编号无对应实现

- 各槽测试注释中的 `phase5/collab/CONTRACTS.md`、`phase6/collab/CONTRACTS.md` 等带目录前缀的引用指向历史协作目录中的同名文档，从未进入本仓库；其内容口径由上文对应槽位小节如实承载。
- P 槽注释引用的 `§5`（`src/plugin/state.mjs:3`）与 organize 测试引用的 `§5-J` 之外，未发现其他编号在该槽位有可验证的独立实现依据；如需补充请先在代码中落实事实再修订本文件。
