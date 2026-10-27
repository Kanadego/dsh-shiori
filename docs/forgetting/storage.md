# P4 遗忘 · 窄存储（N 槽：批量软归档、冷库列表与明确有用反馈）

实现位置：`src/sparks/store.mjs`。主审将已审核 N a3 提交的完整窄增量
逐字节映射到生产位置；不保留 proposals 运行入口。原始提交与其评审记录
保留在 phase5/collab 中。集成只调整测试装配与本说明，不改已审核生产代码。

## 边界

- Node >= 24、ESM、`node:test`、零新增依赖；仅合成临时 dataRoot。
- 窄增量落在 `src/sparks/store.mjs`；保留 B8 guard-lock、P3 organize 三方法
  （`bindOrganizeRound` / `applyOrganizeLinks` / `retireMerged`）、schema 1 与
  旧库加载校验、跨进程锁与单次原子落盘；不重写通用存储。
- 衰减复算为 N 私有实现（与 M 槽契约同公式同参数），不 import 未提交的 M/O。

## 新增 API（挂在 `openSparkStore(...)` 返回的 store 上）

### 1. `store.archiveEphemeral(plan, { operationId, executedAt })`

批量软归档 1..20 张卡。`plan` 为 CONTRACTS §3 的 `archive-ephemeral` plan：
恰好 `version/kind/scopeId/now/policy/sources` 六自有键；`policy` 必须完整三字段
（不接受部分覆盖）；`sources` 每项恰好 `id/revision/createdAt/lastUsedAt/useCount`
五自有键、id 唯一。`opts` 两字段必需，`executedAt` 为可信调用方本次采样的
规范 UTC ISO（`new Date(v).toISOString() === v`）。

固定执行顺序（CONTRACTS §7）：

1. 入口同步形状/类型校验并取独立快照（首次 await 前）；
2. 锁内 load（复用 runMutation，与 feedback 等同锁域）；
3. **持久同 op 重放先于一切 live 检查**：同 operationId 同语义指纹（规范化
   plan；`executedAt` 不属指纹）返回首次持久结果快照，不采用本次 executedAt，
   不改 generation/revision/统计/文件；不同 plan → `INVALID_INPUT`；
4. `executedAt < plan.now` → `INVALID_STATE`（已完成同 op 的回拨重放不受影响，
   该比较只在重放之后）；
5. 逐卡按 id 顺序：存在性（`NOT_FOUND`）→ active/ephemeral/承接检查
   （`INVALID_STATE`）→ 五字段全量 CAS `revision/createdAt/lastUsedAt/useCount`
   （`REVISION_CONFLICT`；feedback 不增 revision，故不能只核 revision）→
   按 `plan.now` 与 `executedAt` 双重复算资格（`INVALID_STATE`）；
6. 全批验证成功后统一修改：仅 `state='archived'`、`archivedAt=executedAt`、
   `updatedAt=executedAt`、`revision+1`，其余正文/链接/统计原样；其他卡不重写。
   任一卡失败 → 整批零卡变化、不落新 op、原文件字节不变。

资格复算（与 M 同公式）：`score = 2^(-elapsedDays/halfLifeDays)`，
`halfLifeDays = min(base * 2^useCount, max)`（useCount 大指数封顶，防
`2**useCount` 溢出为 Infinity 污染 score），`elapsedDays = max(0,
(now - (lastUsedAt ?? createdAt)) / 86400000)`；归档须 `elapsedDays >= 60`
且 `score < archiveScore`（严格低于；默认策略下第 60 天整 score 恰为 0.25
不归档，61 天可归档）。evergreen 免疫、退休状态不候选、承接替代关系
（`supersedes !== null`）的 replacement 保护；匹配/曝光/hitCount/lastHitAt
不续期。时钟回拨 elapsed 夹 0（在 N 层表现为未达资格的 `INVALID_STATE`）。

返回恰好 `{ version:1, kind:'forget-archive-result', scopeId, operationId,
archivedAt: executedAt, items: [完整归档卡按 id 排序] }`。

入口在首个 await 前同步捕获独立的 opts 标量快照（`operationId`/`executedAt`）
与规范化 plan 快照：持久日志键、返回回执及全部锁内代码只用快照值，调用方在
调用后篡改原 opts/plan 对象不影响首次结果、日志键、`archivedAt` 与重放回执。

### 2. `store.listArchived()`

当前 scope 恰好 `state==='archived'` 的完整卡，按 id UTF-16 升序并逐张 clone。
不含 active/superseded/merged；无 global fallback（绑定 global 时返回 global
自己的）；只读不写库。

### 3. `store.recordUsefulFeedback(id, { used, sourceEventId, operationId? })`

明确有用反馈。`used` 必须自有 boolean，`sourceEventId` 必填且为合法事件 id
（规则同 operationId）；可带可选 `operationId`（首次结果重放语义同其他写
操作）。`operationId` 只取**自有**字段——继承字段（如被污染的
`Object.prototype.operationId`）不作输入，未提供自有值时不产生任何
operationId 日志；显式自有 `undefined` 拒绝。`used`/`sourceEventId`/自有
`operationId` 同样在首个 await 前捕获独立快照，调用后篡改原 opts 不影响
首次结果。同 `(scope, id, event)` 同 `used` 不双计数、不同 `used`
`INVALID_INPUT`；事件账与旧 `feedback` 共用（跨 API 去重；旧 feedback 的可选
`sourceEventId` 语义原样保留）。仅 `used===true` 时 `useCount+1` 且
`lastUsedAt` 更新，**revision 不变**；返回完整卡 clone。active-only：退休卡
拒绝（无 op 的事件重放也不复活）。useCount 达 safe integer 上限时
`used=true` 在任何写入前原子失败（`INVALID_STATE`）。

反馈与归档共用同一锁域；归档全量 CAS 含有用反馈引起的 `lastUsedAt/useCount`
变化（反馈后未重建的陈旧计划 → `REVISION_CONFLICT`）。

## 共享路径窄修复（契约 §7 明确要求覆盖）

- `runMutation` 的持久 op 查找与 `feedback` / `recordUsefulFeedback` 的事件
  查找改用 `Object.hasOwn` own-property 判定：`operationId` / `sourceEventId`
  为 `"constructor"` 这类合法事件 id 时，旧写法会读到 `Object.prototype`
  继承键，把全新请求误判为「已被不同语义使用/已记录」。该缺陷是已确认的
  旧缺陷（主审澄清：不能当作 P4 之前已修）；本次为窄修复，正常 id 语义
  不变。
- **bucket 级 own-property（D-3）**：feedback 事件账的 bucket 查找/初始化与
  事件写入在旧 `feedback` 与新 `recordUsefulFeedback` 共享三个辅助函数
  （`ownFeedbackBucket` / `ensureFeedbackBucket` / `writeFeedbackEvent`）：
  合法卡 id（如 `"toString"`，不在保留键名单）会命中 `db.feedback` 的继承键，
  旧写法把内置函数当 bucket、把事件写到函数对象上——不持久化、跨进程丢失
  事件去重。修复后 bucket 恒为自有普通对象、事件恒为自有可枚举键
  （defineProperty），两个 API 跨进程共享同一持久事件去重账，且不污染任何
  内置对象；普通 id 行为不变。

## 错误码映射

| 场景 | 错误码 |
| --- | --- |
| plan/opts 形状、类型、范围、未知键、复用不同语义 | INVALID_INPUT |
| 卡快照不符（五字段任一） | REVISION_CONFLICT |
| 卡不存在 | NOT_FOUND |
| 退休/免疫/承接/未达资格/executedAt 早于 plan.now/useCount 溢出/close 后调用 | INVALID_STATE |

## 测试

`test/forgetting/store.test.mjs`（51 项）：在系统 temp 建 stage（复制当前项目
`src`/`test`/`package.json`，只补入历史 G a2 loader 对照夹具），不覆盖 store，
动态 import 真实生产位置运行。覆盖：全部入口
校验与原型/普通对象边界、59/60/61 与严格阈值、useCount 半衰期与封顶、
lastUsedAt 优先、回拨、evergreen/承接/退休免疫、整批 CAS 与原子回滚、
20/21 上限、失败无新 op、持久重放先于 live CAS、executedAt 语义（回拨重放、
跨时间重试、异 plan 拒绝、reopen 幂等）、listArchived（排序/clone/只读/无
global fallback）、recordUsefulFeedback 全量语义与事件去重、D-1/D-2 输入
快照回归（调用后篡改 opts/plan 不影响首次回执、日志键与重放；继承
operationId 不作输入）、D-3 bucket 回归（卡 id `toString` 的自有 bucket 与
事件持久、新旧 API 跨进程真实双子进程去重、原型事件名自有持久、无内置对象
污染）、constructor 键修复回归、useCount 溢出、旧 feedback 兼容，以及 stage
内真实旧回归（sparks 147、organize 定向、npm test 等价全量 736/736，含
G a2 冻结 loader 对照与 P3 方法）。stage 用后清理，不混入封包。

## 已知限制

- 归档仍保留 links 与对其他卡的引用（软归档约束：不隐式改写其他卡）；
  既有 active 引用方日后的 organize/links 提交可能因目标退休而拒绝，属
  原遗忘约束，需要时由明确后续编辑清理。
- Windows fsync best-effort、guard 遗留人工恢复等 B8 已知限制原样保留。
- 真实 M/N/O 组合由 `test/forgetting/combination.test.mjs` 从当前项目根加载，
  强制运行全部子测试，不依赖环境变量且不允许 skip；`npm test` 包含全部 P4。
- 旧 `feedback` 对继承 operationId 的处理是原有、未在本轮修复的限制；
  不应把新 API 的 own-property 加固扩大解释为旧 API 的全部输入已加固。
