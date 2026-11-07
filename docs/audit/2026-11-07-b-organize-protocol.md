# 审计报告 B：整理与计划链路 + 插件协议（0.2.3 @ dd27150）

- 审计者：agent:zcode-audb（task-faffef9b64781399-s2）
- 日期：2026-11-07
- 范围：`src/organize/*.mjs`（analyze / executor / queue）、`src/plugin/*.mjs`（14 个文件）及 `test/organize/`、`test/plugin/` 对应用例
- 基线：主仓 dd27150，全量 1303 tests / 87 suites / 0 fail（本次实跑复核一致）
- 性质：只读审计。除本报告外未改动任何文件；验证用临时脚本均写在系统临时目录并已清理。

---

## 一、结论摘要

无 P0（未发现丢数据 / 写坏状态 / 安全边界破口）。

- **P1-1** buildDraft 能产出执行器必然拒绝的 plan：link / thin-core 草案的 `sources` 组装无 64 上限，预览成功、executePlan 必败，计划永久滞留 open。
- **P1-2** thin-core 无变化计划（`before === after`）首跑即回 `replayed: true`：replay 内容判定把「计划本身就是 no-op」误判成「本 round 已完成过」，回执语义失真。
- **P2-1** executePlan 在 `markExecuted` 之后的队列收敛若抛错，客户端收到失败回执但计划实际已执行；重试撞「already executed」REVISION_CONFLICT，回执与账目矛盾。
- **P2-2** previewPlan 的 wire inputSchema 比 buildDraft 宽松：link proposal 的 `rel` 可缺省/为 null、merge-topic 的 `expectedRevision` 可为 null——按 schema 合法构造的请求在草案层一律 INVALID_INPUT。
- **P2-3** organize analyze 的 `supersedeOpen` 把 archive-topic 计划一并作废（同挂 kind "organize"），archive-topic 与候选队列无关，属误伤。
- **P2-4** executor.mjs 头注释声称「生产 caller management.mjs 未传 stateRoot，线上一定走 skipped」已过时（management.mjs:833 已传），误导维护判断。
- **P2-5** buildDraft 对 `proposal.kind === 'archive-topic'` 的拒绝文案漏列 archive-topic（且先撞上该文案的会是其他 kind 的拼写错误），排查误导。

---

## 二、逐条详述

### P1-1 buildDraft 产出的 link / thin-core plan 可超执行器 sources 上限，preview 成功、execute 必败

- **现象**：`buildDraft` 组装 `plan.sources` 时没有任何数量上限；`validateRoundPlan` 对 link 与 thin-core 都要求 `plan.sources` 数量在 1..64。超限计划在 previewPlan 落账成功，executePlan 每次都在 schema 校验处抛 INVALID_INPUT，永远无法执行。
- **位置**：
  - link：sources = 候选源 ∪ 被改源 ∪ 全部 after 目标，组装处 `src/organize/queue.mjs:1301-1316`（无上限）；`validateSourceRefs`（`src/organize/queue.mjs:276-299`）与 `validatePlanShape` 的 link 分支（`src/organize/queue.mjs:1141-1170`）均不设上限。执行器侧 `src/organize/executor.mjs:221`（`checkPlanSources(plan.sources, { min: 1, max: LINK_SOURCES_MAX })`，LINK_SOURCES_MAX=64 见 `src/organize/executor.mjs:51`；`src/sparks/store.mjs:347` 同值）。
  - thin-core：`buildThinCoreDraft` 原样克隆 `candidate.sources`（`src/organize/queue.mjs:1463-1480`，无上限）；cluster 候选成员数在 analyze 侧也无上限（`src/organize/analyze.mjs:514-529`，516 行注释明说「成员 >= 20 的 cluster 照常产出」）。执行器侧 `src/organize/executor.mjs:347`（thin-core 同样要求 sources 1..64）。
- **为什么是问题**：`src/organize/queue.mjs:984` 的注释明确声明 CARD_LIMITS 镜像是为了「保证草案可被执行器接受」，但恰恰漏了 sources 总量这一项。后果是用户在面板上能预览并确认一个永远执行不了的计划，计划账里永久留一条 open（只能靠下一次 analyze 作废）。
- **最小复现**（实测，临时脚本已清理）：构造 link 候选 `{a,b}`，`proposal.links` 两条目各带 32 个新目标（每目标都是 records 内 active 卡），`buildDraft` 返回 `plan.sources.length = 66`；把同一 plan 交给 `executor.executeRound` 得：
  ```
  [1] buildDraft(预览) 成功：plan.sources.length = 66
  [2] executeRound 拒绝： INVALID_INPUT | plan.sources 数量必须在 1..64（实际 66）
  ```
  thin-core 路径同理：65+ 张卡共享同一实体 → cluster 候选 65 源 → thin-core 草案预览成功、执行被 `executor.mjs:347` 拒绝。
- **修复方向**：在 `buildLinkDraft`/`buildThinCoreDraft` 产出前对 `plan.sources.length` 套用与执行器相同的 64 上限（超限报 INVALID_INPUT 并提示拆轮），或在 `validatePlanShape` 统一收口。

### P1-2 thin-core 无变化计划首跑回执 `replayed: true`（replay 判定误报）

- **现象**：`before === after` 的 thin-core 计划（且当前 core 正文恰等于该文本）在**从未执行过**的首跑上返回 `status:'completed' + replayed:true + backup:null`，与「replayed 表示本 round 已完成过的重放」的回执契约不符。
- **位置**：`src/organize/executor.mjs:730-753`——先判 `current.text !== before && !== after` 拒绝，再判 `current.text === after` 即返回 replayed 回执；`before === after` 时两个条件同时成立，永远走 replay 分支。而 `validateRoundPlan` 的 thin-core 分支（`src/organize/executor.mjs:338-348`）与草案层 `buildThinCoreDraft`（`src/organize/queue.mjs:1463-1480`）都不拒绝 `before === after`。对照同文件其他 kind 的「拒绝无变化」：link 在 `executor.mjs:259`、merge-topic 在 `executor.mjs:295-297`（草案层 merge 因恒追加源保全块不可能无变化，见第三节第 2 条）。
- **为什么是问题**：thin-core 是三 kind 中唯一允许 no-op 计划的；回执谎报 replayed（首跑并无「首次回执」可重放），审计/对账时无法区分「用户提交了空计划」与「计划已被执行过」。无数据破坏（本来就零写），故 P1 下限、不升 P0。
- **最小复现**（实测，临时脚本已清理）：临时 root 上 `service.mutate` 种 core 正文 `'X'`，执行 `core:{before:'X',after:'X'}` 的 thin-core plan（无 stateRoot），首次 `executeRound` 即返回：
  ```json
  { "status": "completed", "kind": "thin-core", "changedItems": 1,
    "replayed": true, "backup": null, ... }
  ```
- **修复方向**：在 `validateRoundPlan` 的 thin-core 分支（或 buildThinCoreDraft）拒绝 `before === after`（与 merge-topic 的「拒绝无变化」对齐）；若产品上有意允许 no-op，则 replay 分支需另带回执字段区分「计划本身无变化」与「真重放」。

### P2-1 executePlan：markExecuted 之后的队列收敛抛错时，回执与账目矛盾

- **现象**：`executePlan` 先 `markExecuted`（`src/plugin/management.mjs:867`），随后执行后的队列收敛在 `try { ... } finally { grant.revoke(); }` 中进行（`src/plugin/management.mjs:884-898`）——**只有 finally，没有 catch**。converge 的 CAS（`expectedRevision: snapshot.revision`）或 `queueStore.save` 一旦抛错，错误向上传播，客户端收到失败；但 plan 已执行且已落账。客户端按惯例重试同 operationId，会在 `management.mjs:783-788` 撞上「already executed」REVISION_CONFLICT——第一次调用的执行回执（`result`）永久丢失。
- **为什么是问题**：窗口来自 `management.mjs:886`（取 snapshot）与 `management.mjs:887`（`await listActive()`）之间——两次 await 之间另一个面板 RPC（如 reviewCandidate / analyze）推进队列 revision，converge 的 CAS 即失败。执行成功却报错，用户可能重复预览重做同一操作（虽被一次性闸挡住，不会双写，但回执丢失违反「不把失败伪装成功」的反面：把成功伪装成失败）。
- **最小复现**：并发窗口复现（代码路径确定）：RPC-1 executePlan（merge 计划）走到 `management.mjs:887` 的 `await listActive()` 挂起；此时 RPC-2 reviewCandidate 完成一次 review（revision+1）；RPC-1 恢复后 `queue.converge(..., expectedRevision: snapshot.revision)` 在 `src/organize/queue.mjs:817-821` 抛 REVISION_CONFLICT → executePlan 整体报错，而 plan 已 executed。单线程确定性复现可用「queueStore.save 注入失败」达到同一矛盾。
- **修复方向**：把执行后收敛包进 catch（收敛失败只降级为「队列待下次 analyze 清理」的诊断，不影响已成功的执行回执），或把 markExecuted 移到收敛成功之后并接受「收敛失败重试时 converge 幂等」的现状。

### P2-2 previewPlan wire inputSchema 比 buildDraft 宽松（link.rel / merge-topic.expectedRevision）

- **现象与位置**：
  - link proposal：wire 允许 `after[i].rel` 缺省或为 null（`src/plugin/protocol.mjs:140-143`，`rel: { oneOf: [string, null] }`、item `required: ["target"]`）；而 buildDraft 对每个 pair 走 `assertExactKeys(pair, ['target','rel'])` + `checkText(pair.rel, { min: 1, max: 64 })`（`src/organize/queue.mjs:1242-1247`），rel 缺省或 null 一律 INVALID_INPUT。
  - merge-topic proposal：wire 允许 `topic.expectedRevision` 为 null（`src/plugin/protocol.mjs:162`）；草案层 `validatePlanTopic` 要求非空字符串（`src/organize/queue.mjs:1187`，`checkText(..., { min: 1, max: 16384 })`）。
- **为什么是问题**：协议注释声称 organize proposal「严格沿用 buildDraft 形状」（`src/plugin/protocol.mjs:12-13`），但以上两处 schema 放行了草案层必拒的形状；客户端照 schema 构造请求会得到与 schema 矛盾的 INVALID_INPUT。方向是「wire 松、handler 紧」，无安全后果，故 P2。
- **最小复现**（实测）：`validateManagementPayload('previewPlan', { kind:'organize', candidateId:<64hex>, proposal:{ kind:'link', links:[{ id:'a', after:[{ target:'b' }] }] }, expectedQueueRevision:1, operationId:'op1' })` 通过 wire 校验（rel 缺省）；同一 proposal 进 `buildDraft` 即抛 `INVALID_INPUT rel 必须是字符串`。`expectedRevision: null` 的 merge-topic proposal 同样过 wire、必被草案层拒。
- **修复方向**：把 `protocol.mjs` link 分支的 `rel` 改为 `required: ["target","rel"]` + 纯 string（1..64），merge-topic 的 `expectedRevision` 收为纯 string；或反向放宽 buildDraft（不建议，执行器也要同样放宽）。

### P2-3 organize analyze 的 supersedeOpen 误伤 archive-topic 计划

- **现象**：organize 分析收敛计划账时按 `kind: "organize"` 作废全部 open 计划（`src/plugin/management.mjs:529-533`，`keepPlanId: null`）；而 archive-topic 预览存的计划 kind 同为 `"organize"`（`src/plugin/management.mjs:684`）。于是与候选队列毫无关系的「归档/恢复某专题」计划，会因任何人跑一次 organize analyze 而被标记 superseded、不可执行（`management.mjs:791-796` 硬闸）。
- **为什么是问题**：archive-topic 计划不引用候选、不受队列重建影响（其正确性由 topic revision token CAS 保证），把它挂进「引用旧候选集」的作废理由属于误伤；用户刚预览好的归档操作会静默失效。无数据损失，执行闸本身工作正常，故 P2。
- **最小复现**：对 topic T previewPlan `archive-topic`（得 planId op-D1）→ 跑一次 `analyze kind=organize` → `planStore.get(op-D1).supersededWith !== undefined`，executePlan 报 REVISION_CONFLICT "was superseded"。
- **修复方向**：plan 账增加细分 family（如 `proposalKind`）或在 supersedeOpen 排除 `plan.kind === 'archive-topic'` 的条目（organize analyze 的收敛语义只针对引用候选集的计划）。

### P2-4 executor 头注释声称 management 未传 stateRoot，与现实现相反

- **现象与位置**：`src/organize/executor.mjs:673-675` 写「已知缺口（主审 q-b40eda3bfee42fa0）：0.2.2 生产 caller management.mjs 未传 stateRoot，线上一定走 skipped，下一批接线补齐」；但当前生产调用已传：`src/plugin/management.mjs:828-834`（`stateRoot: settings.stateRoot`）。配置层保证 active 模式 stateRoot 为绝对路径（`src/plugin/scope.mjs:140-144` 双 root 成对校验）。
- **为什么是问题**：文档性缺陷：维护者按注释会误判「线上 thin-core 备份永远不落盘」，可能据此做出错误的容量/恢复决策，或重复「补接线」。
- **最小复现**：直接对照两处代码即可（`executor.mjs:673-675` vs `management.mjs:833`）。
- **修复方向**：删除或改写该注释为「已接线（management.mjs 执行器工厂传入 settings.stateRoot）」。

### P2-5 buildDraft 拒绝 archive-topic 的文案与 PLAN_KINDS 不一致

- **现象与位置**：`src/organize/queue.mjs:1532-1534`——`proposal.kind` 校验用的集合是 `PLAN_KINDS`（含 archive-topic，`queue.mjs:983`），但报错文案写「proposal.kind 必须是 link/merge-topic/thin-core」。archive-topic 随后在 `queue.mjs:1535-1539` 被显式拒绝（行为正确）。
- **为什么是问题**：仅文案问题：客户端传错 kind 时看到的合法值清单与实际校验集合不一致，排查误导；也让「一处认、另一处不认」的人工核对变难。
- **最小复现**：`buildDraft({ candidate, records, proposal: { kind: 'arhive-topic' } })`（拼写错）→ 报错文案缺 archive-topic，而传 `archive-topic` 会命中下一条专门报错。
- **修复方向**：文案改为「link/merge-topic/thin-core（archive-topic 走 buildArchiveTopicPlan）」或把 kind 检查收敛到显式三分支。

---

## 三、已核查但不算问题的点（防下一轮重复劳动）

1. **计划族五集合两两一致**：执行器 `PLAN_KEYS`（`src/organize/executor.mjs:72-77`）、草案层 `PLAN_KINDS`（`src/organize/queue.mjs:983`）、`validateRoundPlan` 的 kind 白名单（`src/organize/executor.mjs:192`）、wire `organizeProposal` oneOf 三分支（`src/plugin/protocol.mjs:117-189`，与 buildDraft 接受的 proposal kind 严格对应）、`planView.proposalKind` enum 四值（`src/plugin/protocol.mjs:107`）全部对齐；archive-topic 在 buildDraft 显式短路（`queue.mjs:1535-1539`），不会误入 thin-core 分支。除 P2-5 的文案外无「一处认、另一处不认」。
2. **merge-topic 不可能无变化**：`buildMergeTopicDraft` 恒追加源保全块（`queue.mjs:1355-1365`，同块已存在时不重复追加但 then `after` 已含块、仍 ≠ before），执行器再拒 `after === before`（`executor.mjs:295-297`）与缺块（`executor.mjs:298-300`）；sources 8..19 三处同值（`queue.mjs:1345-1347`、`executor.mjs:52-53,274`、`sparks/store.mjs:349-350`）。
3. **thin-core core 文本未过 assertEncodableUtf8 无害**：`validateRoundPlan` thin-core 分支对 `core.before/after` 只查 typeof（`executor.mjs:344`，比 merge-topic 宽），但 `service.mutate` 的 text 校验兜底（`src/service/index.mjs:20` isWellFormed；`src/storage/store.mjs:520,698` assertEncodableUtf8）→ 孤立代理在 core-commit 前以 INVALID_INPUT 拒绝，附 `coreCommitted:false`，无写坏路径；digest 用 JSON.stringify 转义表示，仍确定。
4. **executed / superseded 硬闸闭环**：executePlan 双闸（`management.mjs:783-796`）；`planStore.save` 同 planId 同 digest 幂等且不改 executed 标志（`src/plugin/state.mjs:524-529`），已执行计划不可能被重新预览「复活」；archive-topic 预览缺省 `operationId ?? null` 落 `supersededWith: null`，仍被 `!== undefined` 闸住（`management.mjs:695-699, 791`，注释与实现一致）。
5. **executedCandidateId 无副作用**：archive-topic 的 candidateId 是 `"archive-topic:<key>"` 别名（`queue.mjs:1447`），而队列项 candidate.id 恒为 64hex（`queue.mjs:320-322` 强制）→ 执行后收敛的 `it.candidate.id !== executedCandidateId` 过滤（`management.mjs:889`）不可能命中任何队列项；归档不动卡 → active 过滤集不变 → `survivors.length === items.length` → 不产生队列事务（`management.mjs:892`）。forgetting 计划无 candidateId → null，同路径（`management.mjs:883`）。
6. **RemoteError 透传完整**：`client-rpc.mjs:153-157` 非 RemoteError 的业务错误按 `error.code` 原样包装透传，details 恒为 record（`client-rpc.mjs:67-79`，规避宿主解码层「invalid server-response failure」）；organize/executor/management 各层 details 均为 plain record（含 phase/topicCommitted/coreCommitted/topicKey/topicSubOperationId）。`MANAGEMENT_ERROR_CODES`（`protocol.mjs:734-742`）只是测试断言词表（`test/plugin/management.test.mjs:108`），运行时不收敛——超词表 code（INVALID_STATE / APPROVAL_REQUIRED / HOST_LOCKED 等）也原样过线，不会伪装成功；但消费方若按词表白名单渲染需知晓这些额外 code 的存在（信息项，非缺陷）。
7. **backup / binding skipped 回执诚实**：stateRoot 缺失 → `{skipped:true, reason:'stateRoot not provided by caller'}`（`executor.mjs:678-680`）、备份失败 fail-closed 拒写 core（`executor.mjs:689-694`）、备份成功 `{skipped:false, path, bytes}`（`executor.mjs:695`）、重放回执 `backup:null` 且带 `replayed:true`（`executor.mjs:739-753`）——三种形态互不混淆；全仓 grep 确认 src 内无按 `backup.path` 判成功的消费方。binding skipped（thin-core/archive-topic）在首跑与重放回执中均显式出现（`executor.mjs:58-68, 752, 788, 844`）。
8. **merge 恢复语义完整**：topic 提交凭 mt 子 operationId 走 journal 幂等早退（`executor.mjs:500-545`）；锁内重读源卡按 all-active / all-merged-收据 两路 fail-closed（`executor.mjs:562-641`）；退休前二次授权（`executor.mjs:549-557`）；派生子 id 不含 plan digest（`executor.mjs:107-112`）。对应 `test/organize/executor.test.mjs` 覆盖。
9. **archive-topic 链路**：scope 校验在 preview（`management.mjs:659-665`）与执行（`executor.mjs:808-813`）双层；topic 恰三键（`executor.mjs:317-321`、`queue.mjs:1100`）；`archivedAt` null/可 Date.parse 双处校验（`executor.mjs:328-333`、`queue.mjs:1104-1109`）；执行 text 取 `fresh.body` 原样回写（`executor.mjs:824`）；REVISION_CONFLICT 附 phase/topicKey/topicSubOperationId（`executor.mjs:827-832`）。preview 侧 already-in-state 判定（`management.mjs:667-673`）与草案层双保险（`queue.mjs:1441-1443`）方向一致，不误伤（「本来就是该状态」本就应拒）。
10. **queueRevision 语义**：`planStore.save` 仅落预览时快照 revision（`state.mjs:535`，forgetting/archive-topic 恒 null），执行侧不拿它做 CAS——计划正确性由 `plan.sources` 的 revision 绑定 + analyze 的 supersedeOpen 收敛兜底，展示字段陈旧无安全后果。analyze 的 CAS 先于 journal（`management.mjs:508-514` 注释与实现一致），operationId 不被毒化。
11. **plugin ↔ service 边界**：`src/service`、`src/core` 无任何反向 import plugin（grep 证实）；plugin 侧经 `createShioriService` 组装资源并只读包装（controller.mjs:277-295 的 Proxy 仅补 `searchArchived`），计划链路的 topic 读写全部经 service/storage 既有校验，执行器不自己重写 topic 文件 / sparks.json（`executor.mjs:3-6` 职责声明与实现一致）。

---

## 四、测试与命令记录

| 命令 | 结果 |
|---|---|
| `npm test`（node --test 全量） | **1303 tests / 87 suites / pass 1303 / fail 0 / skipped 0**，166.5s —— 与基线声明一致 |
| `node --test test/organize/*.test.mjs` | 164 tests / 19 suites / 0 fail，24.7s |
| `node --test test/plugin/*.test.mjs` | 295 tests / 0 fail，60.4s |
| `node --check src/organize/*.mjs src/plugin/*.mjs`（14 个文件） | 全部语法 OK |
| 临时验证脚本 ×3（系统临时目录，验证后已删除） | P1-1/P1-2/P2-2 的实测复现（输出见第二节） |

- flaky：本轮未观察到（全量单跑通过；organize/plugin 子集复跑通过）。
- 覆盖缺口（对应上文结论，非空话）：
  - `test/organize/executor-thin-core.test.mjs` 无 `before === after` 用例（P1-2 现网不可发现）；
  - `test/organize/queue.test.mjs` / `test/plugin/management.test.mjs` 无「link/thin-core 草案 sources > 64」用例（P1-1 现网不可发现）；
  - `test/plugin/management.test.mjs` 无「executePlan 执行后收敛失败」注入用例（P2-1）。

## 附：审计过程说明

- 全程未改动白名单外文件；`git status` 仅本报告为新增。
- 三份验证脚本写在 `%TEMP%`（`auditb-thincore-repro.mjs`、`auditb-sources-repro.mjs` 等），跑完即删，仓库内零残留。
