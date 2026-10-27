# dsh-shiori 客户端 / RPC 说明

## 形态

- 包声明 `dsh.client = { platform: "web" }` 与 `exports["./client"]`；`client/index.js` 是**手写 ModuleLoader bundle**（`window.__ModuleLoader__.load({ id: "dsh-shiori", factory(require) { ... } })`），随包可执行，无安装后构建、无网络 CDN、无 `innerHTML`（记忆文本一律 textContent 渲染）。
- 客户端导出 `{ apply, inject }`，`inject = ["remote", "slots", "configForms"]`；`apply(ctx)` 先 `await ctx.remote.$mount(TYPERT_REMOTE)`（真实 Typert contribution），收集 disposer，再注册 `plugins.bundle.config` 槽位（插件管理器 → 本包详情页）。卸载逆序释放全部 disposer。
- `createTypertRemoteInfo` 按生态惯例从 `@deepseek-ai/dsh-typert-protocol` 内联（与官方生成 client 一致——浏览器侧不能 import 宿主服务端模块）。

## wire（冻结，CONTRACTS §6）

namespace `shiori`，方法集与 P 的 `src/plugin/protocol.mjs` `MANAGEMENT_METHODS` 一致：

```
getStatus / getMemoryView / getGraph / executeTool / listCandidates /
analyze / reviewCandidate / previewPlan / executePlan
```

每个方法 wire 为 `(sessionId, payload)`：参数名 `session` 命中宿主 session lookup（wire 字段 `sessionId`，服务端解析为真实 Session 对象，未知 session 由 Gateway 拒绝）；`payload` 顶层闭键校验在服务端用 P 的 `validateManagementPayload`；末位 `signal` 为真实调用取消信号。

## 授权与 trustedContext

- 服务端（`src/plugin/client-rpc.mjs`）挂载真实 `TypertRemoteService`（service key `shiori.panel`，wire namespace `shiori`），由宿主 Gateway 以 source-mode 发现导出。
- 每次调用读取 `this.ctx.invocation.peer.principal`：本批仅 `principal.kind === "owner"` 放行；非 owner / 无 invocation 一律 `shiori/unauthorized`。payload 永不携带 trustedContext，`sessionId` 存在不等于授权。
- `trustedContext` 固定形状 `{ agent, session, principal, source: "panel-rpc", signal }`：agent 由宿主 `agents` 注册表按 session.id 解析（可能缺省）；无真实调用信号时由服务端创建并随 stop 撤销。
- management 抛出的 `Error.code` 经 `RemoteError` 原样过线（`RemoteResult` 的 `ok:false/error.code`），客户端如实展示，不伪装成功。

## 面板功能

- **状态**：`getStatus`——mode / 可信 scope / 占用 / 诊断（含 needs-configuration）；完整 DTO 可展开核对。
- **shadow / inert 门控（P shadow 收窄后的 UI 一致性）**：面板选会话后先以 `getStatus` 探测模式。`inert`（未配置根目录）或 `shadow` 时，记忆 / 图谱 / 候选三个数据界面渲染**「未配置」占位**——不挂载数据组件、不发出数据请求，用户不会点进去吃 `UNSUPPORTED` / `NOT_CONFIGURED` 错误；占位文案写明「shadow 只用于装配期探活，不提供数据浏览」。`getStatus` 与「预算配置」（原生 configForms，不经 management RPC）不受影响。`getStatus` 本身不可用时回退旧行为（数据 tab 照常挂载，由各 tab 如实报错）。服务端对 shadow 的 8 个数据方法一律拒绝且永不触盘——UI 门控与服务端两层防御语义一致。
- **记忆 L0/L1**：`getMemoryView`——L0 persona 与完整 L1（含派生索引）预览、UTF-16 占用条（对照 budgets）、revision。
- **图谱**：`getGraph`——SVG 拖拽平移 / 缩放；节点按 evergreen / ephemeral / 非 active 异色，边中性；点击节点看详情并做 **CAS 编辑**（`executeTool`：topic_append / memory_rewrite / core_write / soul_update，可带 expectedRevision / operationId；服务端严格校验）。不经模型消息返回整图。
- **候选 / 计划**：`listCandidates`（queueRevision + items + plans）、`analyze`（organize / forgetting）、`reviewCandidate`（reviewed / dismissed）、`previewPlan`（organize proposal JSON 按 buildDraft 形状 / forgetting planId）→ 展示 `PlanView` diff 后**明确确认**才 `executePlan { confirmed: true }`。
- **候选行取值（第 5 轮返工，对齐宿主真实 queueDto）**：`listCandidates` 返回的 items 是**嵌套形状** `items[i] = { candidate: {id, kind, scopeId, sources, evidence}, status }`（src/organize/queue.mjs item 结构 / src/plugin/management.mjs queueDto）——id / kind / sources / evidence 都在 `item.candidate` 里。面板统一经 `queueItemCandidate(item)` 取值（兼容旧扁平形状 `{candidateId|id, kind, …}`）；候选与 plans 两个列表里，**数组下标只用作渲染 key**：拿不到业务 id 的行显示「（缺少 candidate.id）」并禁用全部动作按钮，绝不把下标当 candidateId / planId 发 RPC。
- **organize proposal 本地校验与预填（第 5 轮 Q-B，第 6 轮完善）**：proposal 文本框**默认留空**（不再预置必红死值）。点候选行「preview organize」时：空 proposal 先按候选 kind 预填——link 候选给带真实源卡 id 的骨架 `{"kind":"link","links":[{"id":"<sources[0]>","after":[{"target":"<另一张卡>","rel":"related"}]}]}`（骨架即可发送，target 需确认为另一张真实卡 id）；cluster 候选不预填、指引走「合并进主题」（merge-topic 需服务端签发的 revision token，文本框手写必然失败）。发送前经 `validateOrganizeProposalLocal` 预检（服务端 protocol.mjs `organizeProposal` 仍是权威）：未知 kind、空 `links`、link 每项 `id` / `after[{target,rel}]` 非空与 rel 类型、merge-topic `topic` 七键齐全与 append-only、以及**各层多余键**（协议 additionalProperties:false）都在本地拦下并给中文指引。注定 INVALID_INPUT 的 payload 不发往服务端。
- **合并进主题（cluster 候选的一键流程，第 4 轮 Q-A）**：候选行对 `item.candidate.kind === "cluster"` 提供「合并进主题」入口，流程全部经 `executeTool` / `previewPlan` / `executePlan` 完成，不再要求手写 proposal JSON：
  0. **步骤引导（纯展示）**：卡片顶部按当前进度高亮编号步骤——① 选目标主题（点某行「合并到这个主题」或在下方新建）→ ② 选定后自动载入 before 正文与 revision token、出现「合并表单」→ ③ 在表单里编辑 after → 点「预览 diff（previewPlan）」→ 下方确认卡「确认执行」。未选目标主题时 ① 标「进行中」（`dshi_badge`，其余 dim），并在主题列表与「或新建主题」之间渲染一条中性提示（`dshi_hint` 加粗，非 ErrorBox/红色）：「还没有选择目标主题……选定之后才会出现合并表单和预览 diff 按钮」；选定后同位置换成「已在合并表单中：编辑 after 后点预览 diff，再在下方确认卡里确认执行」。legacy 行的「合并到这个主题」按钮带 `title`「legacy 主题只读，不能作为合并目标」（列表通常已在 `loadTopics` 过滤，保留防御性提示，按钮不禁用）。
  1. `executeTool memory_list_topics` 拉当前 scope 主题列表，展示 key / title / updated / revision 前缀；**`updated === "legacy-unknown"` 的 legacy 主题被过滤**（服务端拒 `UNSUPPORTED legacy topics remain read-only`）；列表里没有可用主题时提示新建。
  2. 「新建主题」走 `executeTool topic_create {topic,title,summary,operationId}`，成功后**重新 `memory_list_topics` 取服务端权威 revision token**（形如 `shiori-r1.<base64url>.<sha256>`，不自行构造），再自动进入合并表单。
  3. 选中主题后 `executeTool memory_read {topic}` 拉当前正文作 `before`、返回的 revision 作 `expectedRevision`——**before 绝不传空串**：执行端以 `plan.topic.after` 整体替换正文（executor 锁内重读一致性校验），空 before 会截断既有正文。`after` = before + 默认合并草稿（evidence.sharedTerm + 源卡 id 清单），标题 / 摘要 / updated 自动填、可编辑；发送前本地轻量预检（append-only、单行摘要 ≤60、非空变化），服务端 `buildMergeTopicDraft` 仍是权威（源数 8..19、源保全块自动追加）。
  4. `previewPlan`（kind=organize，带 candidateId + proposal + expectedQueueRevision + operationId）返回的 diff（`topic:<key>` 与 `spark:<id>`）渲染成可视确认，`executePlan`（confirmed: true + planDigest）执行；成功后收起合并流程并刷新队列（图谱 / 记忆 L1 在切到对应 tab 时按会话重新拉取）。
- **候选 / 计划脏数据的面板表现（第 4 轮 Q-B，第 5/6 轮扩展）**：过期候选（源卡已 merged / archived）的 preview 报 NOT_FOUND / INVALID_INPUT 时给出具体中文提示（"该候选或计划已过期……请点刷新重新分析"，原 code 保留）；`REVISION_CONFLICT` / `UNSUPPORTED`（如 legacy 主题只读）同样有专属文案。preview 钉定 `{sessionId, queueRevision, plan}`：会话切换（既有 R4 守卫）与**队列 revision 前进**都会使旧 preview 失效，拒绝拿旧 preview 去 execute（`shiori/ui-stale-preview`）。plans 列表区分 open / executed / superseded：executed 行不渲染预览按钮；superseded（被新预览作废，P a4 起投影提供该布尔）行渲染但**禁用**预览按钮并提示「该计划已被新预览作废……请使用最新计划」；预览对应计划若已 executed / superseded，确认执行按钮禁用。
- **RPC 错误 details 契约（第 6 轮 B-Q3，该文件属本槽已修）**：`src/plugin/client-rpc.mjs` 全部 6 个 `RemoteError` 出口的 `details` **恒为对象**——业务错误优先透传 P protocol `failInvalid` 携带的 details（如 `{ violations }`、`{ planId }`），没有则给 `{ code }`（守卫出口附 `method` / `principalKind`）。此前 details 为 undefined，gateway 原样搬运丢键后，宿主客户端判据 `isRecord(error.details)` 不成立，**任何业务错误都被显示成 `connection: invalid server-response failure`**——第 5 轮的中文错误映射在真机上被这条传输层拒绝遮断，修好后自然生效。回归测试用宿主真实判据（gateway `rpcFailure` 搬运 + JSON 往返 + `parseConnectionResponseFailure`）断言各出口 details 为 record 且 violations 可达。
- **diagnostics 容错（第 4 轮 Q-C）**：状态 tab 对 P 新增的 codec / transport 等字段按 key: value 照常渲染，未知未来字段容忍，值为 undefined 的键忽略（不显示 undefined、不伪装成 null），序列化异常降级 String()，不崩。
- **预算配置**：`ctx.configForms.get("shiori")` 原生设置作用域（命名空间能被 settings 服务收录，靠的是 schema 里 volatile 的 `budgets` 字段），整段 budgets 单 revision fence 写入。`budgets` 为 volatile：宿主热提交、不触发插件重载；运行中的 controller 仍持启动时快照，新预算在下次插件重载或宿主重启后生效。留空的输入框不写入（保留服务端现值），非法数字/比率中止整批写入并显示错误。UI 顶部如实提示。
- 会话选择优先取宿主 `ctx.remote.session.list`（owner 可见集）；不可用时退回手动输入 session id（如实提示）。

## 宿主能力缺失时

typert / Gateway 缺席：RPC diagnostics 返回 `transport: "unavailable"`、`ui: "unsupported-no-transport"`，插件以**仅工具模式**运行，不隐藏失败、不宣称面板通过。客户端 bundle 本身不加载（web 前端由宿主分发）。

## 停止语义

`mountShioriRpc(...).stop()`：禁新（新调用 `shiori/rpc-stopped`）→ 撤销自有取消信号 → 排空在途调用；服务注销随插件 fiber 释放链完成（顺序与「RPC stop → controller stop」一致）。

> **依赖三层语义（owner review 次要修正，对齐官方 dsh-soul-md）**
> - **ModuleLoader seeds**：Web shell 预载的模块（react、zod），client bundle 的
>   `factory(require)` 直接 `require("react")` / `require("zod")` 取用——它们**不是**
>   npm 依赖，也不进包图；`checkClientBundle` 校验的正是这一点。
> - **npm peerDependencies**：服务端（Node 侧）在 profile `node_modules` 里由 pnpm
>   解析的包图依赖（dsh-* 包、schemastery；react 依 soul-md 惯例列为 peer）。
> - **`dsh.client.inject`**：客户端**插件图**依赖（本插件包加载其他客户端插件包的
>   bundle 时才声明）。shiori 不加载其他客户端包，因此**不声明**（与 soul-md 相同，
>   `dsh.client = { platform: "web" }`）；把 seed require 编码成图依赖是语义错误，
>   verify-package 会拒绝。

## 候选面板布局与中文文案（第 7 轮）

- **合并卡就地展开**：点候选行「合并进主题」后，合并卡渲染在**该行正下方、同一个 `dshi_items` 容器内**（外层 `dshi_itemMerge` 包一层 `dshi_card`，缩进 12px），不再排在候选列表 / plans / proposal 文本框之后。三点状态机（openMerge / closeMerge / openTopicForMerge / submitNewTopic / doMergePreview 等）逻辑未改，只搬渲染位置。标题只显示候选 id 前 8 位（`slice(0, 8) + "…"`），完整 id 放 `title` 属性。
- **按钮与徽章中文化**（只改显示文案，协议值一律不变）：`analyze organize` → 「分析整理候选」、`analyze forgetting` → 「分析遗忘候选」、`reviewed` → 「标记已阅」、`dismissed` → 「忽略」、`preview organize` → 「预览整理计划」、`preview forgetting` → 「预览遗忘计划」；候选 kind 徽章 cluster / isolated / link → 集群 / 孤立卡 / 可建链接（未知保留原文），status 徽章 pending / reviewed / dismissed → 待处理 / 已阅 / 已忽略；plans 徽章 open / executed / superseded → 待执行 / 已执行 / 已作废；plans 行首的计划类型徽章 organize / forgetting → 整理 / 遗忘（`plan.kind` 协议值仍用于逻辑判断与 PlanView 预览标题）。**`reviewCandidate` 的 decision 仍发 reviewed / dismissed，`previewPlan` 的 kind 仍发 organize / forgetting**。
- **两处 dshi_hint 说明**：「候选（n）」标题下说明候选来源与三类 kind 各自的可用流程；「计划（n）」标题下说明计划 = `previewPlan` 生成的待执行变更（含 diff 与 planDigest）、执行后标「已执行」、被新预览作废标「已作废」，以及整理类 / 遗忘类计划各自的发起入口。
- **原始 JSON 折叠**：候选行与计划行的 `stableStringify` 结果包进 `<details class="dshi_details">` + `<summary class="dshi_hint">原始数据（JSON）</summary>`，默认不展开（不写 open），需要核对 DTO 时手动点开。
- **回归**：`test/plugin/client.test.mjs`「第 7 轮」三条用例分别断言就地展开的 DOM 顺序（容器直接子节点为 候选行 / 合并卡 / 候选行）、旧英文按钮文案不再出现且「标记已阅」仍发 `decision: "reviewed"`、以及 details 无 open 属性。
