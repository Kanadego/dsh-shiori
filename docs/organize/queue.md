# P3 K 槽位 · 候选队列与审阅草案（src/organize/queue.mjs）

内存中的可恢复候选队列与确定性审阅 diff 草案。**队列里的 `reviewed` 只表示
「已审阅」，不是批准、不是已执行**；本模块不产生任何业务写入、不持久化任何
用户文件、不 import 任何冻结 src 模块或其他槽位（J/L）的文件（stable/digest
按共同契约独立实现，仅依赖 `node:crypto`）。

## 公开 API

### `createCandidateQueue({ scopeId, snapshot? }) -> queue`

- `scopeId`：显式 scope（factory-only，必填；不从 cwd/HOME/global 猜测）。
- `snapshot`：可选快照；提供时执行下文「恢复契约」的严格校验，任何不一致直接抛错，绝不静默接受。
- 返回 `queue = { snapshot(), enqueue(candidates, opts), review(candidateId, opts) }`（全部同步）。

### `queue.snapshot() -> { version, scopeId, revision, items, operations }`

- 初始 `revision = 0`；`items` 按入队顺序排列，每条 `{ candidate, status }`，
  `status ∈ { pending, reviewed, dismissed }`。
- 每次返回全新深克隆：修改返回值不影响队列内部状态（无 alias 泄漏）。

### `queue.enqueue(candidates, { expectedRevision, operationId }) -> snapshot`

- `candidates`：非空数组；每条按 J 槽契约形状校验并**重算
  `id = digest({kind,scopeId,sources,evidence})`** 防篡改；`scopeId` 必须与队列一致。
- **幂等按 operationId 先于 CAS**：同 `operationId` 同语义请求（stable 后相同）直接
  重放首次业务结果（附当前 `operations` 克隆），此时 `expectedRevision` 不参与检查；
  同 `operationId` 不同 payload → `INVALID_INPUT`。
- 新事务走 CAS：`expectedRevision !== 当前 revision` → `REVISION_CONFLICT`，队列原样。
- 相同候选 id 相同 payload 不重复入队（去重 no-op）；**去重 no-op 也算一次队列事务，
  revision+1**。
- 同一批内重复候选 id → `INVALID_INPUT`。

### `queue.review(candidateId, { decision, expectedRevision, operationId }) -> snapshot`

- `decision ∈ { reviewed, dismissed }`；只有 `pending` 可 review。
- 候选不在队列 → `NOT_FOUND`；非 pending → `INVALID_STATE`；decision 非法 → `INVALID_INPUT`。
- 幂等/CAS 语义与 enqueue 相同（先 operationId 后 CAS）；失败队列原样。
- 不产生任何业务写入；不存在 approved/executed 状态。

## 快照编码与恢复契约（K 文档声明）

```
snapshot = { version:1, scopeId, revision, items, operations }
items[i] = { candidate, status }
operations[operationId] = {
  kind: 'enqueue' | 'review',
  fingerprint: <64hex>,                 // digest(request)，请求语义指纹
  request: { kind:'enqueue', candidates:[...] } | { kind:'review', candidateId, decision },
  result:  { version:1, scopeId, revision, items }   // 不含 operations 的业务快照
}
```

- `result` 是**不含 operations** 的业务快照（避免递归指数膨胀，契约 §5）；
  重放命中幂等时返回「首次业务 result + 当前 operations 的克隆」。
- `request` 原样保留，用于恢复时从空队列做**确定性全量重放**。

### operations 安全字典（a2）

`operations` 在内存状态与每次快照输出中都是 **null 原型安全字典**，键的读取
一律按 own-property 语义：

- `constructor` / `toString` / `hasOwnProperty` 等 Object.prototype 继承属性名
  是**合法 operationId**，首次使用正常执行；绝不与继承属性混淆而被误判为
  「已被不同语义的请求使用」。
- `__proto__` 形态的键在字典上只是普通 own 数据属性，不触发原型 setter
  （防原型污染/账项丢失）。不过 `__proto__` 本身不满足 operationId 规则
  （须字母/数字开头），作为 `opts.operationId` 或快照 operations 键一律
  `INVALID_INPUT` 拒绝。
- 消费方检查某 operationId 是否存在时应使用 `Object.hasOwn(operations, id)`
  （或 `Object.keys`），不要用 `in` / 直接索引普通对象。
- 该语义在写入、克隆、快照输出与 JSON 往返恢复后保持一致。

恢复（`createCandidateQueue({scopeId, snapshot})`）严格校验，层层设防：

1. 结构校验：`version===1`、`scopeId` 与工厂一致、items/operations 逐条形状校验，
   每个候选重算 digest 防篡改，每条 operation 的 `fingerprint` 必须等于 `digest(request)`。
2. 计数不变量：每个成功队列事务恰好 `revision+1` 并记录一条 operation，因此
   **`revision` 必须等于 operations 条数**，且各 `result.revision` 恰好覆盖 `1..N`
   ——顶层 revision 不被单独信任。
3. 重放不变量：按 `result.revision` 升序从空队列重放全部 request，每步中间业务快照
   必须与记录的 `result` 完全一致，最终状态必须与顶层 `items/revision` 完全一致；
   任何不一致 → `INVALID_STATE`（快照历史被篡改）。

## `buildDraft({ candidate, records, proposal }) -> { plan, digest, diff, changedItems }`

- `candidate`：重新核验 id（digest 重算）与 scope；`sources` 为精确 `SourceRef`
  （`{id,revision}`、revision≥1、唯一、按 id UTF-16 升序）。
- `records`：完整 active 卡记录（`store.listActive()` 形状，`{target,rel}` links 形状）。
  全部记录 `scopeId` 必须与候选一致且 `state==='active'`；候选源缺失 → `NOT_FOUND`，
  revision 不吻合（陈旧源）→ `REVISION_CONFLICT`。
- `plan` 通用形状 `{ version:1, scopeId, candidateId, kind, sources, ... }`；
  **不含 digest/approval/operationId，禁止未知字段**（构造后自检）。
- `digest = digestPlan(plan)`；`diff` 是 `{path, oldText, newText}[]` 纯展示内容，
  不注册真实 UI、不注入批准/执行状态。

### kind = `link`

- `proposal = { kind:'link', links:[{ id, after:[{target,rel},...] }] }`。
- 被改源 `id` 必须在 `candidate.sources` 中；`target` 必须在传入 records 中
  （同 scope、active）→ 缺失 `NOT_FOUND`。
- 拒绝：自环、after 内重复 `(target,rel)`（**规范化前**拒绝，不静默去重）、
  重复被改源、被改源不在候选源、无新增边（拒绝无变化）、合并后单卡 links 超过
  存储上限 32（镜像冻结 store LIMITS，保证草案可执行）。
- `before` 保留记录现有全部边；`after = before ∪ 新增`，按 target 再 rel 排序；
  不允许借织网删除边。
- **既有边（before）目标同样必须在传入 records 中**（a2）：active 卡的入边指向
  已退休/未随行传入的卡是合法数据形态（store 的 archive 只改目标状态、不改入边），
  隐式保留的旧边目标缺失时返回 `NOT_FOUND`（不静默丢边、不抛原生 TypeError）；
  显式把缺失目标写进 `after` 同样 `NOT_FOUND`，两条路径行为一致。
- `plan.links = [{ id, expectedRevision, before, after }]`（按 id 升序）；
  `plan.sources` = 候选全部源 ∪ 被改源 ∪ 全部引用目标（按 id 升序，绑定 records 当前 revision）。
- `changedItems = links.length`，上限 20（21 条拒绝）。
- diff：每个被改源 `{ path:'spark:<id>', oldText:stable(before), newText:stable(after) }`。

### kind = `merge-topic`

- `proposal = { kind:'merge-topic', topic:{ key, expectedRevision, before, after, title, summary, updated } }`；
  `before/after` 是 topic 正文文本；`expectedRevision` 是 service 不透明 token（只校验
  非空字符串，不解析）；`title/summary/updated` 为冻结文本（镜像 P0 topic 元数据规则：
  summary ≤60 且无换行、title 非空、updated 非空字符串；key 镜像 core/keys.mjs 文件名规则）。
- 要求 `candidate.kind === 'cluster'` 且源数量 **8..19**（`changedItems = sources+1 ≤ 20`）。
- append-only：`after` 必须以 `before` 全文为前缀。
- **源保全块**（自动追加）：

  ```
  '\n<!-- shiori-p3-sources -->\n' +
  stable(records 按 id 排序映射为 {id,scopeId,revision,title,summary,content,triggers,entities,links,vitality}) +
  '\n<!-- /shiori-p3-sources -->\n'
  ```

  - 只包含**本次 sources**（不是 records 全集）；triggers/entities/links 保持原数组顺序。
  - `after` 已含完全相同块 → 不重复追加（幂等）；已含**不同内容**的源块标记 →
    `INVALID_INPUT`（拒绝叠加第二个块，需人工处理）。
  - 最终 `plan.topic.after` 为追加后的最终正文，**审批与 digest 绑定最终正文**；
    完整原文块是数据，不是提示或指令。
- `plan.sources` 精确等于候选源；`changedItems = sources.length + 1`。
- 目标 topic 的 scope/存在性由 L 执行器验证，K 不验证。
- diff：`{ path:'topic:<key>', oldText: before, newText: 最终 after }` + 每张源卡
  `active → merged` 草案（`path:'spark:<id>'`，投影含十字段 + `state`，newText 为
  `state:'merged'`、`revision+1`；`mergedInto` 的 topic 文件 sha/bodyHash 由执行期决定，
  不在草案中伪造）。

### kind = `thin-core`

- `proposal = { kind:'thin-core', before, after }`（L1 正文文本）。
- `plan.core = { before, after }`；`changedItems = 0`；diff `{ path:'core', ... }` 仅展示。
- K 不读写真实 L1、不做自动删减；执行器必须拒绝执行 thin-core（契约 §3，由 L 保证）。

## `digestPlan(plan) -> hex`

对外部传入的 plan 先做完整结构校验（version/kind/精确字段/SourceRef 规则）再返回
`SHA256(UTF8(stable(plan)))` 小写 64 hex；与 `buildDraft().digest` 完全一致。

## stable / digest 语义（契约 §1）

`stable(value)` = JSON.stringify 递归对普通对象键按 UTF-16 码元序排序（数组顺序保持）；
`digest = SHA256(UTF8(stable(value)))`。输入先经协议 JSON 校验：`undefined / NaN /
Infinity / 循环 / 函数 / symbol / bigint / 稀疏数组 / 类实例 / 孤立代理码元字符串`一律
`INVALID_INPUT`。**对象键与值同属协议文本**：键含孤立代理码元同样拒绝（a2；
`JSON.stringify` 会把孤立代理码元转义成 `\ud800` 文本，掩盖有损事实，故显式校验）；
合法非 ASCII 键（如 `标题`/`café`）与配对代理键（如 `😀`）照常接受。该校验覆盖
candidate（含 evidence）、records、proposal、plan（`digestPlan` 入口）与快照恢复
（operations 的 request/result 递归在内）。排序全部使用 UTF-16 二进制比较，
不依赖 locale/时间/随机。

## 错误码

| code | 场景 |
| --- | --- |
| `INVALID_INPUT` | 形状/未知字段/非法值/候选篡改/同 key 异 payload/违反 link 与 merge 约束/对象键或值含孤立代理码元/`__proto__` 等非法 operationId |
| `REVISION_CONFLICT` | 队列 CAS 失败；候选源 revision 与 records 不吻合（陈旧源） |
| `NOT_FOUND` | review 未知候选；候选源、link 新增目标或隐式保留的既有边目标不在 records 中 |
| `INVALID_STATE` | review 非 pending；恢复重放与快照不一致（历史被篡改） |

`APPROVED/EXECUTED` 等状态不存在；执行授权（`APPROVAL_REQUIRED`）属于 L 执行器。

## 限制与边界

- 队列本身在内存中；持久化由宿主保存 snapshot JSON 完成（本模块不写用户文件）。
- 队列长度无显式上限；每轮写入量 ≤20 的约束由 plan 级校验保证（link ≤20 条被改源、
  merge 源 8..19 → changedItems ≤ 20、thin-core 恒 0）。
- K 不验证目标 topic 的存在性/scope/token 有效性（expectedRevision 作为不透明字符串透传，
  由 L 执行器与 service 校验）。
- **merge-topic 草案不可从执行后状态重建**：部分执行后（某源已 `merged` 或 revision+1）
  用同一 `(candidate, records)` 重建草案会分别得到 `INVALID_INPUT`（state 非 active）/
  `REVISION_CONFLICT`（revision 陈旧）——重启重试必须依赖 L 的 operationId 重放，
  而不是重新 buildDraft。
- scopeId 校验镜像 `core/topics.mjs`（A 级）规则；写盘层 `storage/paths.mjs` 更严
  （如反斜杠/冒号等），两口径之间的 scopeId 可建队列但会在执行器写盘侧被拒——
  scope 合法性最终以服务层写盘校验为准。
- 协议 JSON 校验覆盖普通对象/数组/原始值结构；symbol 键、不可枚举属性、数组非索引
  属性不属于协议输入（`deepClone` 会丢弃，等同于不存在），不要把本模块当作
  「任意 JS 结构无损序列化」工具。
- 记录校验镜像冻结 sparks/store.mjs 的字段限额（title 80/summary 120/content 2000/
  单词 64/rel 64/triggers 32/entities 32/links 32）与 P0 topic 元数据规则
  （summary ≤60 无换行）、core/keys.mjs 的 key 文件名规则、storage/paths.mjs 的
  operationId 规则——仅镜像规则，不 import 对应模块。

## 修订记录

- a2（返工修复）：① operations 安全字典——继承属性名 operationId（`constructor`/
  `toString` 等）首次使用正常执行，`__proto__` 不触发原型 setter（K-1）；
  ② 协议 JSON 对象键与值同样要求无损 UTF-8，覆盖 candidate/records/proposal/
  plan/快照恢复（K-2）；③ link 隐式保留的既有边目标缺失返回 `NOT_FOUND`，
  不再原生 TypeError、不静默丢边（K-3）。源保全块维持按 id 排序的十字段
  记录数组编码（主审裁定，L 侧对齐）。
- a1：初版交付。
