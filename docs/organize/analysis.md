# organize/analyze.mjs — 只读机械候选分析（J 槽位 / P3-CANDIDATES）

## 接口

```js
import { analyzeCandidates } from '../src/organize/analyze.mjs';

const candidates = analyzeCandidates({ scopeId, records, limit = 100 });
```

同步纯函数；零 fs / 零写入 / 零副作用；不导入宿主、队列、执行器或 store。
错误形状与 `src/sparks/errors.mjs` 的 `SparkStoreError` 对齐（`code` 字段判定）。

### 参数

| 参数 | 约束 |
| --- | --- |
| `scopeId` | 必填，显式提供；规则与冻结的 `storage/paths.mjs validateScopeId` 逐条对齐（非空、≤128 UTF16、无首尾空白、无控制字符/孤立代理、无 Windows 禁用字符、非 `global` 大小写变体、不以点/空格结尾、非保留设备名）。本模块为保持「零 fs import」边界而本地实现同一规则，未 import `storage/paths.mjs`。 |
| `records` | 必填数组；每项必须是**完整 active 卡**——冻结 `store.mjs` 能产生并加载的记录。业务字段逐一验证：`id`（同 store 规则，≤64）、`scopeId === scopeId`（跨 scope 拒绝）、`revision`（整数 ≥1）、`state === 'active'`、`title`（1..80）、`summary`（0..120）、`content`（1..2000）、`triggers`/`entities`（字符串数组，≤32 项，每项 1..64 且非纯空白）、`links`（≤32 项，仅 `target`/`rel` 键，`rel` 1..64 非纯空白，禁止 self-link）、`vitality`（`evergreen|ephemeral`）。审计字段（`createdAt`/`updatedAt`/`archivedAt`/`lastHitAt`/`lastUsedAt`/`supersedes`/`supersededBy`/`hitCount`/`useCount`）不要求在场（不扩大契约），在场时做轻量类型校验；schema 之外的未知字段拒绝。同 scope 重复 `id` 拒绝。link 目标允许指向不在 records 中的卡（对应已退休目标，`listActive` 语义下合法）。 |
| `limit` | 可选，默认 100；正整数且 ≤1000，否则 INVALID_INPUT。排序后截断，不影响候选生成顺序的确定性。 |

未知选项键（参数对象上的多余键）一律 INVALID_INPUT。

### 返回

`Candidate[]`，每项恰为 `{id, kind, scopeId, sources, evidence}`：
- `kind ∈ 'cluster' | 'isolated' | 'link'`；
- `sources` 为 `{id, revision}`（SourceRef）数组，按 id UTF16 码点序排序；
- `id = SHA256(UTF8 stable({kind, scopeId, sources, evidence}))`，小写 64 hex；`stable()`
  按 CONTRACTS §1 字面公式实现：递归对普通对象键 `Object.keys(v).sort()` 后
  `Object.fromEntries` 重建，再 `JSON.stringify`；数组顺序保持；
- 列表排序：先 `kind`（`cluster < isolated < link`）再 `id`，均为 UTF16 码点二进制序；
- 返回对象全部为新建引用，与传入 records 无共享结构。

## 候选语义与 evidence

所有实体/触发词匹配均按 **trim + toLowerCase** 归一化，去重后按 UTF16 码点排序。
（完整卡校验已拒绝空/纯空白词项，与冻结 store 一致；归一化层的空项忽略仅作防线。）
词条含 U+0000 是合法 lossless UTF8 协议文本（冻结 store 允许），完整参与匹配、
evidence 与 digest；倒排索引使用无歧义的嵌套 `Map(field -> Map(term -> cards))` 结构，
绝不用 field+NUL+term 字符串复合键截断词条（J-3）。

### link（未连接 pair）
共享至少一个归一化实体或触发词的卡对（id 升序枚举一次），且两卡之间**任一方向**均无既有
link（含互逆）。出边指向非 active 目标不构成既有边（该目标不在 active 集内）。
evidence：`{sharedEntities: string[], sharedTriggers: string[]}`（归一化、排序、去重）。

### isolated（孤立卡）
在 active 图（入边+出边都只在 active 记录之间计）中零度的卡：无 active 出边且无 active 入边。
出边只指向非 active 目标的卡仍算孤立，被忽略的目标列入证据。
evidence：`{inDegree: 0, outDegree: 0, ignoredRetiredTargets: string[]}`（排序去重）。

### cluster（同词候选组）
按字段（先 `entities` 后 `triggers`，字段内词按码点序）枚举共享单个归一化词的成员集合，
成员 **≥ 8 张唯一卡**才成立；成员集合相同的组确定性去重（保留 field→term 排序后的首个）。
不足 8 张的词绝不凑数。evidence：`{field: 'entities'|'triggers', sharedTerm: string}`。
成员 ≥ 20 的 cluster 按本槽契约照常产出——**每轮 ≤20 是执行侧业务写入配额，不是分析
快照的约束**；源数 8..19 的 merge-topic 约束由 K 把守，J 不截断、不拆分。

## 成本模型（显式声明）

分析快照的规模由调用方决定，不受 ≤20 配额约束。link 候选对每个词的成员列表物化全部
pair，时间与内存为 **O(Σ_t C(m_t,2))**（m_t 为词 t 的成员卡数）：高共现词 + 大输入时随
成员数平方增长（300 卡 × 32 个全共享词 ≈ 1.4s 量级）。cluster/isolated 枚举为线性 + 键排序。

## 协议 JSON 纪律

传入 records（含对象键）与内部 evidence 均做协议 JSON 校验：`undefined`/`NaN`/`Infinity`/
循环引用/函数/symbol/bigint/稀疏数组/孤立 UTF-16 代理码元（非 lossless UTF-8 文本）一律
INVALID_INPUT，绝不静默替换或吞错回成功。U+E000..U+FFFF 等合法 BMP 文本**必须**通过。

## 确定性保证

- 相同输入（含 records 任意排列、对象键序差异）产出深度相等的候选集（测试覆盖 5 轮乱序）。
- 不使用 locale、时间、随机值、环境状态；evidence 无时间戳、无 LLM 建议、无批准/执行语义。
- 候选只是机械建议，**不是已审阅、更不是已批准**；任何写入须由 K（草案）与 L（受审执行）链路完成。

## 已知限制与解释决定

1. 「完整 active 卡」业务字段校验与冻结 store 的 save/loader 边界一致（J-2 裁定）；审计字段不要求在场，但未知字段拒绝。
2. link pair 全量物化的 O(Σ C(m_t,2)) 成本见上文「成本模型」；未做增量/近似优化。
3. cluster 只针对「单个共享词」的成员集合；多词交集聚类不在本槽契约内。
4. scopeId 规则为本地镜像（与冻结 `paths.mjs` 逐条对齐），不 import 该模块以保持零 fs 边界。
