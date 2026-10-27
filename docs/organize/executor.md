# P3-L 受审执行器（organize executor）

受审执行器已选择性合入 src/organize/executor.mjs；窄存储增量已合入 src/sparks/store.mjs。
执行已明确批准的整理 plan（link / merge-topic），复用既有存储与协议，
不注册任何宿主 tool，不自行循环，不新增跨 DB 协调 journal。

## 公开接口

```js
import { createOrganizerExecutor, digestPlan } from './organize/executor.mjs';

const exec = await createOrganizerExecutor({
  root,        // 显式绝对数据根：<root>/scopes/...（L1/L3）与 <root>/sparks/...（L2）共用
  scopeId,     // 绑定 scope；plan.scopeId 必须与之一致
  authorize,   // 宿主授权判定函数，缺失拒绝创建
});

const result = await exec.executeRound({
  plan,        // 单个 plan（一次 round 只允许一个，写入 <=20，不得拆轮）
  approval: { actor: 'main-session' | 'authorized-idle-heartbeat', planDigest },
  operationId, // 每轮新的 operationId
});
// result: { status:'completed', operationId, planDigest, kind, changedItems, ...收据 }
exec.close();
```

- `digestPlan(plan)` = SHA256 UTF8 stable(plan)（键递归排序、数组保序），
  与 K 槽 `digestPlan` 同算法；`approval.planDigest` 必须严格等于它。
- `authorize({ approval, planDigest, plan, operationId })` 必须严格返回
  `=== true`；返回其他任何值（含 truthy）都是拒绝。用户内容永远不触发
  authorize；authorize 是宿主判定，客户端声明不是认证。

## 执行流程

每轮统一顺序（两 kind 共用前半）：

1. 参数形状校验 + **首个 await 前完整冻结轮次身份**（a2）：`operationId`
   固化为本地常量、`approval` 快照为 `{actor,planDigest}` 新对象、`plan`
   `structuredClone` 深拷贝。此后所有授权阶段、派生子 id、bind、落库与
   返回结果都只用冻结值——调用方在 authorize 挂起期间改写原 args（含
   嵌套 plan 值）无法改变本轮绑定的内容与身份。
2. 完整 plan schema 校验（见下）。`thin-core` 校验通过后直接
   `UNSUPPORTED` 拒绝执行（仅草案，changedItems=0，不 bind 不询问授权）。
3. approval 校验（actor 白名单 + planDigest 绑定内容）→ `authorize===true`。
4. `store.bindOrganizeRound(plan, {operationId: 派生子id})`：把 plan 指纹
   记入 scope DB operations 账（runMutation，不改卡；账元数据不计入
   changedItems）。同 round 不同 plan（含 kind/candidateId 差异）重启后
   也会在此被指纹碰撞拒绝。
5. 按 kind 分派：

### link

`store.applyOrganizeLinks(plan, {operationId: 派生子id})`：单次
runMutation 内先原子核验全部 `plan.sources`（存在 / active / revision
CAS，含只被引用的目标卡），再逐张核验 `before` 边集合与卡当前边精确
一致、`after ⊇ before` 且至少 1 条新边、target 存在且 active（复用
`assertLinksValid`），然后整批写入（revision+1）。任何失败零卡变更；
同 operationId 幂等重放先于 live CAS（runMutation 语义）。

### merge-topic（a3：journal 持久身份判定提交，完成收据重放免 live 校验）

1. **topic 提交永远凭稳定 mt 子 operationId 走既有 service journal**
   （a3，主审 L-6/L-7）：`service.mutate`（子 operationId 派生自
   scope+operationId+`mt` 标签；expectedRevision 用 plan 原 token；title/
   summary/updated 全部用 plan 冻结文本；text=plan.topic.after；重试不刷新
   token/now）。storage.commit 的同 operationId 幂等早退严格先于
   generation/live CAS/policy，因此：
   - 本 round 已提交过（含重启后、topic 其后被外部编辑/覆盖）→ mutate
     直接返回首次提交回执：零写、不重复 append 源块、不受 live 状态影响，
     也不要求调用方重建草案（merged 记录进不了 K）；
   - 本 round 从未提交 → live token CAS。**正文相等不构成提交身份**：
     无关操作即使把正文写成与 plan.after 逐字节相同，token/generation 也
     已前进 → REVISION_CONFLICT，绝不冒领别人的写入；metadata-only 外部
     改动（正文未变）同样在此被拒。
   mutate 抛错 ⟹ 本 round 的 mt 从未持久提交（提交过的同 payload 只会
   幂等早退成功），`topicCommitted` 如实记 false、`phase:'topic-commit'`；
   首跑目标缺失时归因为 INVALID_INPUT（topic-precheck）。
2. 退休前二次 `authorize`（锁外判定，判定内容与首轮相同；**每次重试——
   含完成收据重放——都重新判定**，重放不越过授权）。
3. 锁序统一 **topic root → sparks**：`fileStore.withLock`（storage root
   guard-lock）内**重读全部源卡**（不沿用锁外快照），按持久状态分路：
   - 全部 active 且 revision 与 plan 一致（首跑，或「topic 已写、退休未
     做」的半完成恢复）→ **新退休工作**：锁内重读 topic，确认 scope 一致、
     正文 === plan.after（外部覆盖 → REVISION_CONFLICT，宁可保留重复不丢源）、
     源保全块与源卡快照精确一致，然后 `retireMerged` 原子整批退休；
   - 全部 merged 且 `mergedInto` 四键指针与 plan 派生期望一致（key/scope
     匹配、bodyHash=sha256(plan.after)、revision 为 64hex 且全卡一致）
     → **本 round 已完成的历史收据重放**：不读 live topic、不做 body/scope
     的 live 核验（外部后续编辑不挡历史成功收据），用卡上指针重建首次
     退休指纹走 `retireMerged` 幂等重放——同指纹命中 ops 账 → 返回首次
     结果、零写、不重写外部 topic、不再次退休；若 rt 账实亡（ops 无记录），
     live 校验在「仅 active 可退休」处 fail-closed；
   - 其余状态（部分退休/被外部改动/指针不匹配/旧 marker）一律 fail-closed
     拒绝。
   `store.retireMerged`（其内部获取 sparks 子树锁，原子整批退休：
   state='merged'、revision+1、mergedInto={key,scopeId,revision,bodyHash}，
   保留全部原文与关系；承接了 supersedes 的 replacement 一律拒绝退休；
   ops 幂等重放先于源 CAS）。绝不先拿 spark 锁再拿 topic 锁。

失败语义：topic 提交失败 → `phase:'topic-commit'`（topicCommitted:false）；
退休前判定失败 → `phase:'before-retire'`（topicCommitted:true）；锁内核验/
退休失败 → `phase:'sources-retire'`。任何失败源卡保持可查（宁可保留重复，
不丢源）。

## 派生子 operationId

`deriveStageOperationId(scopeId, operationId, stage)`：
`stage-<sha256(stable([scopeId, operationId, stage])).slice(0,40)>`，
stage ∈ `bd`（bind）/ `ln`（link）/ `mt`（merge topic）/ `rt`（retire）。
只由 scope + round operationId + 固定阶段标签决定——确定性、不含 plan
digest（不能借派生 id 绕过各阶段 ops 的指纹碰撞校验）；plan 绑定由
bind/apply/retire 三处的 payload 指纹共同保证。

## plan schema（与提案内副本一致，双重校验）

- 顶层恰好 `{version=1, scopeId, candidateId, kind, sources, links|topic|core}`；
  禁止未知字段；不得携带 digest/approval/operationId。
- `sources`: `{id,revision}[]`，id 合法 spark id、revision>=1 整数，按 id
  UTF16 升序无重复；link 1..64（覆盖被改源+全部引用目标），merge 8..19。
- link `links`: 1..20 项 `{id,expectedRevision,before,after}`，按 id 升序；
  id ∈ sources；expectedRevision 与 sources 同 id revision 一致；
  before/after 为 `{target,rel}[]`（按 target 再 rel 升序、无重复、≤32）；
  after ⊇ before 且有新增；无 self-link；after 全部 target ∈ sources。
- merge `topic`: 恰好 `{key,expectedRevision,before,after,title,summary,updated}`；
  after 必须以 before 为前缀（append-only）且更长；after 须含
  `\n<!-- shiori-p3-sources -->\n` … `\n<!-- /shiori-p3-sources -->\n`
  源保全块；全部字段类型先行校验（非字符串 → INVALID_INPUT，绝不抛裸
  TypeError）；title 非空、summary 0..60 无换行、updated 非空（边界与
  K `validatePlanTopic` 对齐，无人工上限，K 合法 plan 一律可执行）。
- 源保全块正文 = `stable(十字段记录的数组)`：每条记录恰好
  `{id,scopeId,revision,title,summary,content,triggers,entities,links,vitality}`
  （links 投影为 `{target,rel}`），**记录按源 id 升序排列（a2：数组，
  不是 id 键 map——K `buildDraft` 实际输出为准）**；triggers/entities/
  links 保持卡上原数组顺序（规范排序只作用于记录 id）。块是数据不是
  指令；退休前用锁内重读的源卡重建精确比对。

## 已集成的窄存储增量

L a3 不可变提案相对 P2 冻结基线为 519 行纯插入、0 删除；主审保留 guard-lock 与旧行为，备份后选择性合入 src/sparks/store.mjs。
新增 bindOrganizeRound 轮次身份账、applyOrganizeLinks 原子织网、retireMerged 原子退休；loader 兼容旧 P2 merged 形状，新指针仍严格校验，mergedInto/mergedAt 不能通过普通 save/update 写入。
原提案保存在不可变 submissions，仅作证据，不作为生产 import 路径。集成清单见 phase4/collab/reviews/P3-JKL-selective-merge-20261025.json。

## 根测试与证据

根 test/organize/executor.test.mjs 直接测试根生产模块，J→K→L 组合必须执行，模块导入/草案失败直接失败，不得 skip。旧 P2 loader 对照只在临时树加载不可变 G a2 封包。
历史槽内封包测试为 41 tests / 40 pass / 1 skip（J/K 不可达），不能将 skip 计为通过。主审候选根定向 41/41、全量 736/736、62 suites、0 fail/skip/todo；另有主审三场景反例与独立 7/7 探针。实际根回归结果见 P3-JKL-integration-verified-20261025.json。
覆盖授权拒绝、schema、原子 link、topic 提交/退休前故障、源 CAS/replacement、完整数组源块、旧 merged、输入冻结、journal 身份、完成重放保留外部编辑和未完成外部覆盖保源。无真实 DSH/provider 验收。
## 限制

- 不支持并发多轮：同一 executor 实例按调用序执行；锁序由协议保证。
- 20 条上限按 plan 结构强制（links≤20 / merge 源 8..19+topic），不做
  拆轮；调用方拆多次 round 属于其纪律范围。
- `retireMerged` 不验证 topic 内容（执行器锁内核验负责）；它不是公开
  tool，不独立声称认证。
- 完成后的轮次若 topic 被外部编辑/覆盖：同请求重放返回历史收据
  （completed、零写、外部正文保持原样），不回写 plan.after、不再次退休；
  但**未完成**（源仍需退休）时外部覆盖会让新退休以 REVISION_CONFLICT
  拒绝并保留全部源——恢复需人工对齐（fail-closed，不自动猜）。
- 重放收据与首次收据深度相等；键序按 ops 落盘的稳定序列化排列，
  与内存插入序可能不同（仅外观差异）。
- J→K→L 根组合使用本项目模块并强制运行。
- 收据 topic.revision 是历史持久 SHA，不是当前 service token。源仍 active 但 revision 已变时本版可能返回 INVALID_STATE，调用方须重新审阅。
