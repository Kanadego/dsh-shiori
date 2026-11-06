# dsh-shiori 客户端 / RPC 说明

## 形态

- 包声明 `dsh.client = { platform: "web" }` 与 `exports["./client"]`；`client/index.js` 是**手写 ModuleLoader bundle**（`window.__ModuleLoader__.load({ id: "dsh-shiori", factory(require) { ... } })`），随包可执行，无安装后构建、无网络 CDN、无 `innerHTML`（记忆文本一律 textContent 渲染）。
- 客户端导出 `{ apply, inject }`，`inject = ["remote", "slots", "configForms"]`；`apply(ctx)` 先 `await ctx.remote.$mount(TYPERT_REMOTE)`（真实 Typert contribution），收集 disposer，再注册 `plugins.bundle.config` 槽位（插件管理器 → 本包详情页）。卸载逆序释放全部 disposer。
- `createTypertRemoteInfo` 按生态惯例从 `@deepseek-ai/dsh-typert-protocol` 内联（与官方生成 client 一致——浏览器侧不能 import 宿主服务端模块）。

## wire（冻结，CONTRACTS §6）

namespace `shiori`，方法集与 P 的 `src/plugin/protocol.mjs` `MANAGEMENT_METHODS` 一致（10 个：原 9 个 + `getTimeline`）：

```
getStatus / getMemoryView / getGraph / executeTool / listCandidates /
analyze / reviewCandidate / previewPlan / executePlan / getTimeline
```

每个方法 wire 为 `(sessionId, payload)`：参数名 `session` 命中宿主 session lookup（wire 字段 `sessionId`，服务端解析为真实 Session 对象，未知 session 由 Gateway 拒绝）；`payload` 顶层闭键校验在服务端用 P 的 `validateManagementPayload`；末位 `signal` 为真实调用取消信号。

## 授权与 trustedContext

- 服务端（`src/plugin/client-rpc.mjs`）挂载真实 `TypertRemoteService`（service key `shiori.panel`，wire namespace `shiori`），由宿主 Gateway 以 source-mode 发现导出。
- 每次调用读取 `this.ctx.invocation.peer.principal`：本批仅 `principal.kind === "owner"` 放行；非 owner / 无 invocation 一律 `shiori/unauthorized`。payload 永不携带 trustedContext，`sessionId` 存在不等于授权。
- `trustedContext` 固定形状 `{ agent, session, principal, source: "panel-rpc", signal }`：agent 由宿主 `agents` 注册表按 session.id 解析（可能缺省）；无真实调用信号时由服务端创建并随 stop 撤销。
- management 抛出的 `Error.code` 经 `RemoteError` 原样过线（`RemoteResult` 的 `ok:false/error.code`），客户端如实展示，不伪装成功。

## getTimeline（时间线，F4）

- **入参** `{ offset?, limit? }`，`additionalProperties: false`：`offset` 默认 0、非负整数；`limit` 默认 100、取值 1..500（数据层 `TIMELINE_DEFAULT_LIMIT` / `TIMELINE_MAX_LIMIT`，见 `src/timeline/index.mjs`）。**payload 不带 scope**：时间线恒出本会话 scope，服务端在 `src/plugin/management.mjs` 用 `scopeFromTrustedContext` 重新 pin（与其它方法同一套 trustedContext 授权），payload 里的 scope 字段不被读取、inputSchema 也不收。
- **返回** `{ scope, items, hasMore, skippedCorrupted, scanLimited }`，五个键全部 required、`additionalProperties: false`。`items[i] = { at, action, source, scope, target, detail }`：`at` 是 ISO 时间串，`source` 为 `"journal"` / `"spark"`，`target = { type: "core" | "topic" | "spark", id, title }`（`title` 可为 null），`detail.operationId` 必有、`detail.dedupedWith` 在去重时出现。
- **双源合并**：① `<dataRoot>/journal/<operationId>.json` 里 `phase: "committed"` 的事务记录（覆盖 core / topic 写入，一条 change 一条目，action 为 `core.write` / `topic.write`）；② `<dataRoot>/sparks/scopes/<scopeId>/sparks.json` 的 `ops` 账（覆盖存卡 / 改卡 / 归档 / 替代 / 反馈 / 织网 / merge 退休，action 以 `spark.` 开头）。spark 的 `delivery-hit`、`organize-bind` 属非内容写，不上时间线。两源各自按 `at` 倒序，再归并成一条倒序流（时间相等时 journal 优先）。
- **去重**：同一 `operationId` 在两边都出现时视为同一操作——保留 journal 版本，spark 版本丢弃，并在 journal 条目的 `detail.dedupedWith = ["spark"]` 标注。
- **分页语义**：先跨整窗口去重、再按 `offset + limit` 切片，`hasMore = 合并后总数 > offset + limit`。去重不只看当前页：重复项不会占掉窗口名额把 `hasMore` 提前压成 `false`（旧实现先把两源并入、再按窗口截断才去重，重复项会占掉名额；现实现已在数据层改成先跨窗口去重再切片）。
- **`scanLimited`（扫描窗口截断标记，必读）**：journal 长期堆积、无轮转，数据层单次最多读入最新 `TIMELINE_JOURNAL_SCAN_LIMIT = 4000` 个 journal 文件（按 mtime 取最新，见 `src/timeline/index.mjs`）。当目录里 journal 文件数超过这一上限时 `scanLimited: true`——此时 `items` 只来自最新窗口，**`hasMore: false` 只代表「窗口内到底」，更早的历史本次不可达**。调用方必须把「真到底」与「窗口截断」分开：`hasMore: false && scanLimited: true` 不等于时间线完整，不要据此宣称「没有更多」，也不要靠加深分页去「补全」（更深的分页读的还是同一个窗口）。要拿到更早历史，得先扩大扫描上限或减少 journal 堆积。**边界**：窗口按文件 mtime 取最新，若 journal 目录被整体复制 / 备份恢复 / 迁移（mtime 被批量刷新），真正的最新事务可能落选窗口，而 `scanLimited` 只看数量、不会为这种异常置位——被搬动过的目录不适合直接当时间线读。
- **`skippedCorrupted`**：被跳过的损坏记录数（journal JSON 解析失败 / 形状非法 / phase 未知 / spark 库不可读）。损坏项不炸整个视图；调用方可据该值提示「部分记录损坏，时间线可能缺项」。
- 与其它数据方法一致：shadow（含 inert）下 `getTimeline` 返回 `UNSUPPORTED`，永不触盘。
- **面板入口**：面板「最近变更」tab 就是这条时间线的视图（F4 页），分页 100 条、来源徽章、`scanLimited` / `skippedCorrupted` 都有对应提示，点 core / 主题 / 卡片条目可跳到对应 tab 定位（core 条目只跳「记忆 L0/L1」，不定位到具体段落）。
- **只读宿主的覆盖面（F7 座位判据）**：后启动的宿主持读权——写工具与面板写方法（`analyze` / `reviewCandidate` / `previewPlan` / `executePlan`）都抛 `HOST_LOCKED`；装配期仍会写本端自己的派生账本（L1 投影缓存、水位采样、L2 投递去重账），这批写经文件锁串行化、不碰记忆正文，所以「只读」是「不许改记忆」，不是「零写盘」。

## 面板功能

> 全面板统一术语以 `docs/GLOSSARY.md`（U0 定稿）为准：中文名主位、层号为辅，
> tab 栏名称随 U3–U8 各页改版改为目标名。

- **状态**：`getStatus`——标题「运行状态」，先用五行中文摘要讲清楚运行模式 / 作用域 / 服务启动 / 人设卡占用 / 记忆核心占用，再列能力 badge；原始字段（mode / ownerId / diagnostics 等）收进「技术细节（原始字段，一般不用看）」折叠区，完整 DTO 仍可展开核对（第 8 轮起不把参数直接铺在页面上）。
- **shadow / inert 门控（P shadow 收窄后的 UI 一致性）**：面板选会话后先以 `getStatus` 探测模式。`inert`（未配置根目录）或 `shadow` 时，记忆 / 图谱 / 候选三个数据界面渲染**「未配置」占位**——不挂载数据组件、不发出数据请求，用户不会点进去吃 `UNSUPPORTED` / `NOT_CONFIGURED` 错误；占位文案写明「shadow 只用于装配期探活，不提供数据浏览」。`getStatus` 与「预算配置」（原生 configForms，不经 management RPC）不受影响。`getStatus` 本身不可用时回退旧行为（数据 tab 照常挂载，由各 tab 如实报错）。服务端对 shadow 的 9 个数据方法一律拒绝且永不触盘（8 个经 `requireActiveDataAccess`，`executePlan` 经 `requireActive` 同样拒），只留 `getStatus`——UI 门控与服务端两层防御语义一致。
- **记忆 L0/L1**：`getMemoryView`——L0 persona 与完整 L1（含派生索引）预览、UTF-16 占用条（对照 budgets）、revision。两层都能**就地编辑**（第 8 轮）：L0 走 `executeTool soul_update {content}`，L1 走 `core_write {content, expectedRevision}`；L1 的编辑初值取 `l1.body`（磁盘正文），不是含派生索引的 `l1.text`——否则保存会把索引固化进 core。revision 是 `shiori-r1.<base64url>.<sha256>` 的长 token，标题行只显示 12 字符前缀 + 省略号，完整值放 `title` 属性与「完整 DTO」折叠区。
- **图谱**：`getGraph`——SVG 拖拽平移；缩放支持按钮与**鼠标滚轮**（原生 `addEventListener("wheel", {passive:false})`，React 的 onWheel 在宿主里是 passive、preventDefault 无效；以指针为锚点、scale 夹在 0.3~3）。节点按 evergreen / ephemeral / 非 active 异色，边中性；点击节点看详情。详情里的**「卡片内容」只编辑 spark 卡片本身**（标题 / 摘要 / 正文 / 触发词 / 实体 / 重要度，保存走 `spark_update` 且只提交改动字段，带 expectedRevision）；人设卡 / 记忆核心在「记忆 L0/L1」页改，主题在「L3/topic 记忆管理」页改。关联连线同样在详情里增删：改动先留在本地，点「保存连线」才写 `spark_update {links}`（整体替换），删错点「撤销修改」退回读取时的快照，不发请求。不经模型消息返回整图。
- **L3/topic 记忆管理（第 8 轮新增，位于「候选 / 计划」之后）**：`executeTool memory_list_topics` 拉主题列表，默认只显示 key / title / 字符数，**点「展开」才 `memory_read` 读正文**（不预读全文）；编辑整篇覆盖走 `memory_rewrite {topic, content, expectedRevision}`，保存后重读 detail 与列表。`updated === "legacy-unknown"` 的 legacy 主题标「legacy 只读」，不渲染编辑按钮（服务端拒 `UNSUPPORTED`）。
- **整理与遗忘（原「候选 / 计划」，tab 名随 U5 改版落地）**：数据流不变——`listCandidates`（queueRevision + items + plans）、`analyze`（organize / forgetting）、`reviewCandidate`（reviewed / dismissed）、`previewPlan`（organize proposal JSON 按 buildDraft 形状 / forgetting planId）→ 展示 `PlanView` diff 后**明确确认**才 `executePlan { confirmed: true }`。页面形态（分组折叠 / 筛选搜索 / 就地预览 / 三种状态可见性 / 错误口径）见文末「整理与遗忘」章节，其中「本次目标」小节在改版合入前不得当作已完成。
- **候选行取值（第 5 轮返工，对齐宿主真实 queueDto）**：`listCandidates` 返回的 items 是**嵌套形状** `items[i] = { candidate: {id, kind, scopeId, sources, evidence}, status }`（src/organize/queue.mjs item 结构 / src/plugin/management.mjs queueDto）——id / kind / sources / evidence 都在 `item.candidate` 里。面板统一经 `queueItemCandidate(item)` 取值（兼容旧扁平形状 `{candidateId|id, kind, …}`）；候选与 plans 两个列表里，**数组下标只用作渲染 key**：拿不到业务 id 的行显示「（缺少 candidate.id）」并禁用全部动作按钮，绝不把下标当 candidateId / planId 发 RPC。
- **organize proposal 本地校验与预填（第 5 轮 Q-B，第 6 轮完善）**：proposal 文本框**默认留空**（不再预置必红死值）。点候选行「preview organize」时：空 proposal 先按候选 kind 预填——link 候选给带真实源卡 id 的骨架 `{"kind":"link","links":[{"id":"<sources[0]>","after":[{"target":"<另一张卡>","rel":"related"}]}]}`（骨架即可发送，target 需确认为另一张真实卡 id）；cluster 候选不预填、指引走「合并进主题」（merge-topic 需服务端签发的 revision token，文本框手写必然失败）。发送前经 `validateOrganizeProposalLocal` 预检（服务端 protocol.mjs `organizeProposal` 仍是权威）：未知 kind、空 `links`、link 每项 `id` / `after[{target,rel}]` 非空与 rel 类型、merge-topic `topic` 七键齐全与 append-only、以及**各层多余键**（协议 additionalProperties:false）都在本地拦下并给中文指引。注定 INVALID_INPUT 的 payload 不发往服务端。（U5 改版后页面级 proposal 文本框移除，骨架预填与本地预检逻辑转入行内就地预览，预检规则继续有效，见文末「整理与遗忘」章节——属本次目标。）
- **合并进主题（cluster 候选的一键流程，第 4 轮 Q-A）**：候选行对 `item.candidate.kind === "cluster"` 提供「合并进主题」入口，流程全部经 `executeTool` / `previewPlan` / `executePlan` 完成，不再要求手写 proposal JSON：
  0. **步骤引导（纯展示）**：卡片顶部按当前进度高亮编号步骤——① 选目标主题（点某行「合并到这个主题」或在下方新建）→ ② 选定后自动载入 before 正文与 revision token、出现「合并表单」→ ③ 在表单里编辑 after → 点「预览 diff（previewPlan）」→ 下方确认卡「确认执行」。未选目标主题时 ① 标「进行中」（`dshi_badge`，其余 dim），并在主题列表与「或新建主题」之间渲染一条中性提示（`dshi_hint` 加粗，非 ErrorBox/红色）：「还没有选择目标主题……选定之后才会出现合并表单和预览 diff 按钮」；选定后同位置换成「已在合并表单中：编辑 after 后点预览 diff，再在下方确认卡里确认执行」。legacy 行的「合并到这个主题」按钮带 `title`「legacy 主题只读，不能作为合并目标」（列表通常已在 `loadTopics` 过滤，保留防御性提示，按钮不禁用）。
  1. `executeTool memory_list_topics` 拉当前 scope 主题列表，展示 key / title / updated / revision 前缀；**`updated === "legacy-unknown"` 的 legacy 主题被过滤**（服务端拒 `UNSUPPORTED legacy topics remain read-only`）；列表里没有可用主题时提示新建。
  2. 「新建主题」走 `executeTool topic_create {topic,title,summary,operationId}`，成功后**重新 `memory_list_topics` 取服务端权威 revision token**（形如 `shiori-r1.<base64url>.<sha256>`，不自行构造），再自动进入合并表单。
  3. 选中主题后 `executeTool memory_read {topic}` 拉当前正文作 `before`、返回的 revision 作 `expectedRevision`——**before 绝不传空串**：执行端以 `plan.topic.after` 整体替换正文（executor 锁内重读一致性校验），空 before 会截断既有正文。`after` = before + 默认合并草稿（evidence.sharedTerm + 源卡 id 清单），标题 / 摘要 / updated 自动填、可编辑；发送前本地轻量预检（append-only、单行摘要 ≤60、非空变化），服务端 `buildMergeTopicDraft` 仍是权威（源数 8..19、源保全块自动追加）。
  4. `previewPlan`（kind=organize，带 candidateId + proposal + expectedQueueRevision + operationId）返回的 diff（`topic:<key>` 与 `spark:<id>`）渲染成可视确认，`executePlan`（confirmed: true + planDigest）执行；成功后收起合并流程并刷新队列（图谱 / 记忆 L1 在切到对应 tab 时按会话重新拉取）。
- **候选 / 计划脏数据的面板表现（第 4 轮 Q-B，第 5/6 轮扩展）**：过期候选（源卡已 merged / archived）的 preview 报 NOT_FOUND / INVALID_INPUT 时给出具体中文提示（"该候选或计划已过期……请点「分析整理候选」重新分析"，原 code 保留）；`REVISION_CONFLICT` / `UNSUPPORTED`（如 legacy 主题只读）同样有专属文案。preview 钉定 `{sessionId, queueRevision, plan}`：会话切换（既有 R4 守卫）与**队列 revision 前进**都会使旧 preview 失效，拒绝拿旧 preview 去 execute（`shiori/ui-stale-preview`）。plans 列表区分 open / executed / superseded：executed 行不渲染预览按钮；superseded（被新预览作废，P a4 起投影提供该布尔）行渲染但**禁用**预览按钮并提示「该计划已被新预览作废……请使用最新计划」；预览对应计划若已 executed / superseded，确认执行按钮禁用。
- **RPC 错误 details 契约（第 6 轮 B-Q3，该文件属本槽已修）**：`src/plugin/client-rpc.mjs` 全部 6 个 `RemoteError` 出口的 `details` **恒为对象**——业务错误优先透传 P protocol `failInvalid` 携带的 details（如 `{ violations }`、`{ planId }`），没有则给 `{ code }`（守卫出口附 `method` / `principalKind`）。此前 details 为 undefined，gateway 原样搬运丢键后，宿主客户端判据 `isRecord(error.details)` 不成立，**任何业务错误都被显示成 `connection: invalid server-response failure`**——第 5 轮的中文错误映射在真机上被这条传输层拒绝遮断，修好后自然生效。回归测试用宿主真实判据（gateway `rpcFailure` 搬运 + JSON 往返 + `parseConnectionResponseFailure`）断言各出口 details 为 record 且 violations 可达。
- **diagnostics 容错（第 4 轮 Q-C）**：状态 tab 对 P 新增的 codec / transport 等字段按 key: value 照常渲染，未知未来字段容忍，值为 undefined 的键忽略（不显示 undefined、不伪装成 null），序列化异常降级 String()，不崩。
- **记忆预算（0.2 U2 重写，标杆页）**：`ctx.configForms.get("shiori")` 原生设置作用域（命名空间能被 settings 服务收录，靠的是 schema 里 volatile 的 `budgets` 字段），整段 budgets 单 revision fence 写入。命名三层分离：界面名主位、技术名进 tooltip 与页尾「技术细节」折叠区、机制说明写成后果描述。顶部**实时水位条**：`当前占用 ─ 软水位 · 硬闸 · 硬顶`，占用取 `getStatus` 返回的真实 `occupancy.l1Chars`（取不到如实显示「占用数据不可用」），填充色随水位分安全绿 / 警告黄 / 危险红。`softRatio` / `hardRatio` 不再直接编辑，改为 `softChars` / `hardChars` 字符数水位滑杆 + 数字联动，软/硬互相钳制（软 ≤ 硬-1 < 硬顶）。按人设卡（L0）/ 记忆核心（L1）/ 闪回卡片（L2）三组分组卡片（层号已按 U0 纠错：core 是 L1 不是 L0）。已修改字段标「已修改」徽章 + 单字段恢复默认；越界校验全部就地中文提示并禁用保存按钮。`targetChars` 不在界面出现（D3）——它不能反过来当用户改不动的硬约束：草稿里的 `clampCoreWater` 随硬顶/软/硬把 `targetChars` 收敛进 `softChars ≤ targetChars < hardChars-1`，保存时按收敛值写回（调小硬顶不会因为一个看不见的字段禁用保存）；越界文案点名界面上看得见的中文字段名，不出现隐藏的技术名。保存时同时清掉旧 ratio 字段避免双源真相。`budgets` 为 volatile：宿主热提交、不触发插件重载；运行中的 controller 仍持启动时快照，新预算在下次插件重载或宿主重启后生效。`persona.maxChars` 输入上限 60000（与服务端 `BUDGET_CEILINGS` 同步）。
- **设计 token（U1）**：全部样式变量挂在 `.dshi_root` 的 `--dshi-*` 上（主色 accent、语义色 safe/warn/danger、四层标识淡色 l0/l1/l2/l3-soft、两档灰底 bg-panel/bg-card、描边 stroke、圆角 radius、间距 space、字号 font），token 回退到宿主 `--dsw-alias` 变量；预算页样式只引用 token、不写裸色值，其余页面在 U3–U8 改版时对齐。
- **最近变更（F4 页）**：`getTimeline`——倒序时间线，每页 100 条（`TIMELINE_PAGE_SIZE`），来源徽章区分 core / 主题 / 卡片；`scanLimited: true` 时页顶提示「更早的历史本次不可达」，`skippedCorrupted > 0` 提示部分记录损坏；点 topic / spark 条目「定位」跳到对应 tab（`focusTarget` 带 seq 识别重复跳转），core 条目只跳「记忆 L0/L1」不定位段落，目标已删除时如实提示「可能已删除或已归档」。`hasMore: false` 只是窗口内到底，别据此宣称时间线完整。
- **闪回命中（F2 页）**：`getGraph` 的 `nodes.hitCount/lastHitAt/createdAt` + `deliveries` + `deliveryStats`——三组内容：从未命中（含存续天数）、命中 top10（降序，平局按最近命中时间再按 id）、投递吞吐（总投递张数 / 轮次 / 重复投递率 = 1 − 去重卡片数 ÷ 总投递张数）。口径如实标注：命中＝进入投递包、不代表被采用；统计只覆盖 L2 开启期间。消息底部另有「闪回」按钮走 `conversation.chat.assistant-actions` 槽位，按「本会话最近一次投递（限 10 分钟内）」近似关联并明确标注，不做精确到消息的假装。
- **会话选择优先取宿主 `ctx.remote.session.list`（owner 可见集）；不可用时退回手动输入 session id（如实提示）。

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

## 整理与遗忘（候选 / 计划页，U5 改版）

> 本页正在重做（实现由另一会话进行）。本章区分两套口径：**现状（0.2.0）** 是
> 已合入的形态；**本次目标** 是改版落地后的形态，**在合入之前不得当作已完成
> 引用**。两版都成立的协议事实（DTO 形状、decision 值、守卫行为）不重复标注。
> 术语以 `docs/GLOSSARY.md` 为准（「整理与遗忘」「稍后再说（已阅）」两条已收录）。

### 现状（0.2.0，第 7 轮布局）

- tab 名「候选 / 计划」，页面为两个平铺列表（候选、plans）+ 页面级 proposal 文本框。
- **合并卡就地展开**：点候选行「合并进主题」后，合并卡渲染在**该行正下方、同一个 `dshi_items` 容器内**（外层 `dshi_itemMerge` 包一层 `dshi_card`，缩进 12px），不再排在候选列表 / plans / proposal 文本框之后。状态机（openMerge / closeMerge / openTopicForMerge / submitNewTopic / doMergePreview 等）逻辑不变，只搬渲染位置。标题只显示候选 id 前 8 位（`slice(0, 8) + "…"`），完整 id 放 `title` 属性。
- **按钮与徽章中文化**（只改显示文案，协议值一律不变）：`analyze organize` → 「分析整理候选」、`analyze forgetting` → 「分析遗忘候选」、`reviewed` → 「标记已阅」、`dismissed` → 「忽略」、`preview organize` → 「预览整理计划」、`preview forgetting` → 「预览遗忘计划」；候选 kind 徽章 cluster / isolated / link → 集群 / 孤立卡 / 可建链接（未知保留原文），status 徽章 pending / reviewed / dismissed → 待处理 / 已阅 / 已忽略；plans 徽章 open / executed / superseded → 待执行 / 已执行 / 已作废；plans 行首的计划类型徽章 organize / forgetting → 整理 / 遗忘（`plan.kind` 协议值仍用于逻辑判断与 PlanView 预览标题）。**`reviewCandidate` 的 decision 仍发 reviewed / dismissed，`previewPlan` 的 kind 仍发 organize / forgetting**。
- **两处 dshi_hint 说明**：「候选（n）」标题下说明候选来源与三类 kind 各自的可用流程；「计划（n）」标题下说明计划 = `previewPlan` 生成的待执行变更（含 diff 与 planDigest）、执行后标「已执行」、被新预览作废标「已作废」，以及整理类 / 遗忘类计划各自的发起入口。
- **原始 JSON 折叠**：候选行与计划行的 `stableStringify` 结果包进 `<details class="dshi_details">` + `<summary class="dshi_hint">原始数据（JSON）</summary>`，默认不展开（不写 open），需要核对 DTO 时手动点开。
- **回归**：`test/plugin/client.test.mjs`「第 7 轮」三条用例分别断言就地展开的 DOM 顺序（容器直接子节点为 候选行 / 合并卡 / 候选行）、旧英文按钮文案不再出现且「标记已阅」仍发 `decision: "reviewed"`、以及 details 无 open 属性。U5 改版落地时这三条回归需同步更新断言文案（按钮改名后仍断言 decision 值不变），验收语义不变。
- **0.2.0 没有的东西（别看错版本）**：候选行**没有理由行**（evidence 不会被渲染成人话，只能展开「原始数据（JSON）」核对）；预览卡**没有分 kind 的人话文案**；确认按钮**不分 kind 统一**「确认执行（不可撤销）」。理由行 / 预览卡人话文案 / 确认按钮文案对照表都是下面「本次目标」的内容，在合入之前不得当作已完成。

### 本次目标：页面形态

tab 名改「整理与遗忘」（GLOSSARY「三、tab 名称对照」的目标名随本页落地）。
数据流与协议不变：仍是 `listCandidates` → `analyze` → `reviewCandidate` /
`previewPlan` → `executePlan`。

#### 分组逻辑（待处理候选）

- 待处理候选按 kind 分三组折叠：**集群（cluster）** / **可建链接（link）** / **孤立卡（isolated）**；未知 kind 兜底「其他」组并保留原文徽章。
- 组头 = 中文组名 + 数量徽标；**集群、可建链接默认展开，孤立卡默认折叠**——孤立卡是没有可执行动作的一类，默认收起以减少首屏噪音，需要时点组头展开。点任意组头切换折叠。
- plans 列表不参与 kind 分组，保持单一列表，用状态徽章区分待执行 / 已执行 / 已作废。
- 空组不渲染，不占屏。

#### 筛选与搜索

- **状态筛选**：默认「待处理」，可切「已阅」「已忽略」「全部」；作用于候选列表，plans 列表不受影响。
- **搜索**：只做客户端本地过滤、不新增 RPC；匹配当前行渲染出的**标题与短 id**，不猜正文。与状态筛选叠加生效。
- 无结果时显示「没有匹配的候选」空态，不渲染空白列表。

#### 三种状态的可见性

| 状态 | 默认视图 | 可见时能做什么 | 口径 |
| --- | --- | --- | --- |
| 待处理（pending） | 三组折叠展示，占组头数量 | 全部动作：稍后再说 / 忽略；可建链接与集群行另有就地预览（集群推荐走「合并进主题」），孤立卡没有预览入口 | 唯一默认展示的状态 |
| 已阅（reviewed） | 收起，不占组头数量 | 切「已阅」筛选可见；可建链接与集群行可就地预览查看（孤立卡无预览入口） | 只是收起，**不删除任何记忆** |
| 已忽略（dismissed） | 收起，不占组头数量 | 切「已忽略」筛选可见；可建链接与集群行可就地预览查看（孤立卡无预览入口） | 同上，不删除任何记忆 |

- `reviewed` / `dismissed` 都是**收起而非删除**：人设卡、记忆核心、闪回卡片、专题一概不动；被收起的候选不消失，可随时通过筛选找回。
- 协议没有「取消已阅 / 取消忽略」，界面**不提供**恢复待处理的入口，也不假装可以撤销；如后续协议支持改标，再补界面。

#### 「稍后再说」（原「标记已阅」）

- 改名原因：「已阅」读起来像「这条已经处理完了」，实际语义只是**这条先不看**。
- 点击后该行立即从待处理视图收起，不弹确认框；`reviewCandidate` 仍发 `decision: "reviewed"`。
- 明确口径：**稍后再说不删除任何记忆**，只影响这条候选在页面上的可见性。

#### 候选行的理由行（本次目标）

候选行**标题行结束后的下方单独一行**（`dshi_hint` 小字，前缀「理由：」），把 `item.candidate.evidence`（`src/organize/analyze.mjs` 产出的机械证据）翻成人话，不新发 RPC、不猜正文；这一行之下才是「原始数据（JSON）」折叠。三种 kind 各显示什么：

| kind | 理由行内容（实现文案） | 数据来源（evidence 键） |
| --- | --- | --- |
| link（可建链接） | 「两张卡都提到实体「a」「b」；都带触发词「c」」——两组各自只在非空时出现；两组都空时整句为「两张卡有共同关键词」 | `evidence.sharedEntities` / `evidence.sharedTriggers`（数组，逐项列出） |
| cluster（集群） | 「N 张卡都共享实体「term」，可以合并成一个主题」（N = `candidate.sources.length`；`evidence.field` 为 `"triggers"` 时写「触发词」而不是「实体」） | `evidence.sharedTerm` + `evidence.field` |
| isolated（孤立卡） | 「这张卡没有和任何卡相连」；`ignoredRetiredTargets` 非空时追加「（另有 N 条指向已退休卡的旧连线）」 | `evidence.inDegree` + `evidence.outDegree` + `evidence.ignoredRetiredTargets`（孤立卡两者恒为 0，只作 DTO 字段保留、不进文案；文案只取 `ignoredRetiredTargets` 的条数） |

- `evidence` 缺失、形状不对（键存在但不是数组等）或未知 kind 时**不渲染理由行**——宁可空白，不编造理由；行本身绝不消失、绝不抛错，行内仍有「原始数据（JSON）」折叠兜底。
- 理由行是纯展示：不参与状态筛选、搜索匹配（搜索仍只匹配标题与短 id）与分组数量。

#### 就地预览

- 点行内「预览整理计划」按钮触发就地预览（该按钮只在可建链接与集群行上，见下方「各 kind 的预览入口」），在该行正下方展开预览卡——沿用现状「合并卡就地展开」的容器与缩进语义（`dshi_itemMerge` + `dshi_card`，缩进 12px）。**不做整行点击**（行内含「原始数据（JSON）」折叠，避免误触）。
- **页面级全局 proposal JSON 文本框移除**：第 5/6 轮的骨架预填与 `validateOrganizeProposalLocal` 本地预检转入行内预览卡（预检规则继续有效，服务端 `protocol.mjs` 的 `organizeProposal` 仍是权威）；需要核对 DTO 时用行内「原始数据（JSON）」折叠。
- **各 kind 的预览入口（实现口径）**：只有**可建链接（link）与集群（cluster）候选行**有「预览整理计划」按钮——按该候选的**前两张源卡**生成 link 骨架直接发 `previewPlan`（服务端校验为准），返回 diff 渲染 PlanView。**孤立卡（isolated）没有可连的第二张卡，不提供预览入口**——孤立卡行只有「稍后再说」（发 `decision: "reviewed"`）与「忽略」（发 `decision: "dismissed"`）两个动作，不假装它能发起整理。集群行在此之外另有「合并进主题」按钮走 merge-topic 流程（选主题 → 载入 before 与 revision token → 编辑 after → 预览 diff → 确认执行），是集群的推荐入口。
- **计划行**：待执行（open）的行可点开看 PlanView diff；已执行 / 已作废不渲染预览。
- 确认执行链路不变：`previewPlan` → PlanView diff → 确认卡「确认执行」→ `executePlan { confirmed: true }`（带 planDigest）；stale preview 守卫（会话切换 / queueRevision 前进使旧预览失效）不变，plans 行 executed 不渲染预览、superseded 禁用预览也不变。

#### 过期候选（U5-e）

- **产生原因**：候选队列是**分析时的快照**——「分析整理候选 / 分析遗忘候选」生成候选之后，如果它绑定的源卡在面板之外被改动（编辑 / 合并 / 归档等，卡片 revision 随之前进），这条候选就**过期（stale）**了：不重新分析就直接预览 / 执行，会因版本校验失败被服务端拒绝。服务端在每条队列候选上投影 `stale` 布尔，并在队列 DTO 顶层给出 `staleCount`（**全量口径**，不受当前状态筛选 / 搜索影响）。
- **界面表现**：
  - 过期候选行加**「卡片已改」徽章**（`dshi_badgeStale`，沿用 warn 色 token），并在行内补一行小字：「这条候选绑定的卡片在你上次分析之后被改过，重新分析后才能用」。
  - 该行的**「预览整理计划」按钮置灰**（`disabled`，`title` 写明原因）——这行点下去也只会吃 revision 校验失败，入口先收掉；「稍后再说」「忽略」**仍可用**（它们只改 status，不校验 revision）。「原始数据（JSON）」折叠保持原样。
  - `staleCount > 0` 时，页面顶部（与「刷新 / 分析整理候选 / 分析遗忘候选」同一区域）出现**提示条**（`dshi_staleBar`）：「有 N 条候选在你的卡片被改动之后过期了，重新分析后才会更新」，后跟**「重新分析」**按钮（`dshi_staleBarBtn`）。它**直接复用「分析整理候选」的 `analyze(kind: "organize")` 路径**（同样的 `expectedQueueRevision` 附带语义），不新造 RPC。
  - 提示条说的是全量 `staleCount`：当前筛选 / 搜索下没有可见的过期行时**仍然显示**。
  - 旧服务端不带回 `stale` / `staleCount` 字段时，徽章与提示条都不渲染（向后兼容，行内无徽章、顶部无提示条）。
- **恢复办法**：点「分析整理候选」，或直接点提示条上的「重新分析」——重新分析后队列按卡片当前状态重建，过期候选随之更新（消失或变成新鲜候选）；重新分析前，过期行只能「稍后再说」或「忽略」。

#### 预览卡人话文案（本次目标）

就地预览卡（`preview.plan.kind`，与候选 kind 是两回事）改为**「标题 + 2–3 行正文」**的形态，卡片上方只留标题、正文行、按钮：

- **标题**按计划 kind 翻人话：link →「连起来」、merge-topic →「合并进主题」、thin-core →「core 瘦身」；未知 kind 原样显示 kind 原文，绝不吞掉、不崩。
- **正文**按 kind 渲染 2–3 行（`dshi_hint` 小字）：
  - **link**（三行）：①「把『A』关联到『B』」（A / B 取卡片标题，取不到退化短 id；从 diff 解析不出新增边时退化为「给两张卡新增一条连线（明细见下方「原始信息」）」）②「关系：相关」（rel 不是 `related` 时原样显示）③「执行后两张卡的内容都不变，只多一条连线；连错了到卡片详情里删掉这条连线即可。」
  - **merge-topic**（两行）：①「把 N 张卡合并进主题『KEY』」（N 取 diff 里 `spark:` 条目数，取不到用 `changedItems - 1`；主题 key 缺失时「把源卡合并进一个主题（明细见下方「原始信息」）」）②「合并后源卡会退休，这一步不可撤销。」
  - **thin-core**（一行）：「core 正文 X → Y 字」（X / Y 取 diff 首条 oldText / newText 的字符长度；无 diff 时「core 正文将瘦身（长度变化见下方「原始信息」）」）。不可执行是按钮与服务端的事，正文只报长度变化。
  - **未知 kind**：正文为空时用服务端 `plan.summary` 兜底展示，不空屏。
- **「原始信息」折叠（默认不展开）**：planId、planDigest、summary、**整个原始 diff 逐条（path / old / new）**都在折叠内——普通用户只看标题、正文与按钮，需要核对 DTO 时点开。
- 现状（0.2.0）预览卡没有这套「标题 + 正文 + 折叠」的人话形态（标题平铺「PlanView 预览（kind）」、planId / planDigest 平铺、diff 直接铺开），此条在合入前不得当作已完成。

#### 确认按钮文案对照表（本次目标）

确认按钮文案按计划 kind 区分，**可撤销性直接写进按钮**：

| 计划 kind | 确认按钮文案 | 按钮样式 | 可撤销性 | 撤销路径 / 原因 |
| --- | --- | --- | --- | --- |
| link | 就这么连起来 | 主按钮（**不是 danger 红**） | **可撤销** | 执行后到「图谱」点开任一相关卡片详情，在关联连线里删掉这条连线再「保存连线」（走 `spark_update {links}` 整体替换） |
| merge-topic | 确认合并（不可撤销） | danger 红 | **不可撤销** | 源卡转 merged 退休、主题正文整体覆盖，协议没有回退入口 |
| thin-core | 确认瘦身 | danger 红 | 不可执行，谈不上撤销 | **有按钮**，但点下去服务端一律拒 `UNSUPPORTED`（thin-core 仅草案、`changedItems = 0`，受审执行器一律拒绝执行） |
| 未知 kind | 确认执行 | danger 红 | 按协议行为 | 兜底文案，不假装认识这个 kind |

- 「取消」按钮不变：关掉预览卡不产生任何写入。
- 「执行成功后该候选会从队列移除、`queueRevision` 前进；想对同一对卡再连一次，需要点「分析整理候选」重新分析（页面上的「刷新」按钮只重新读取队列快照，不会重新分析）。
- 现状（0.2.0）确认按钮不分 kind 统一为「确认执行（不可撤销）」——上表是本次目标形态，合入前不得当作已完成。

#### 错误提示口径

全部中文、说人话、必须带**下一步动作**；原始 code / details / violations 一律收进行内「技术细节」折叠或 `title` 属性，不得把传输层裸文案（如 `connection: invalid server-response failure`）直接甩给用户。

| 场景 | 用户看到 | 原始 code（收进技术细节） |
| --- | --- | --- |
| 过期候选 / 计划 | 「该候选或计划已过期：源卡片可能已被合并或归档。点『分析整理候选』重新分析。」 | `NOT_FOUND` / `INVALID_INPUT` |
| 旧预览失效 | 「候选列表已更新，这份预览已失效，请重新点开候选预览。」 | `shiori/ui-stale-preview`（本地守卫） |
| 内容被并行修改 | 「内容刚被其他窗口改过，请重新打开预览后再试。」 | `REVISION_CONFLICT` |
| legacy 主题作合并目标 | 「legacy 主题只读，不能作为合并目标，请新建一个主题。」 | `UNSUPPORTED` |
| 无权限 | 「当前会话没有权限执行这个操作。」 | `shiori/unauthorized` |
| 只读占用 | 「记忆正被另一个窗口占用（只读中），请稍后再试。」 | `HOST_LOCKED` |
| 行缺业务 id | 行禁用并显示「（缺少 candidate.id）」，不发 RPC | — |

文案基线沿用第 4–6 轮映射并统一措辞；新增错误先落这张表再上界面，找不到现成条目的按「场景 + 下一步动作」现写，不硬翻 code。
