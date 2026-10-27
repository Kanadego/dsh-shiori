# src/forgetting — P4 遗忘模块 · M 槽位（纯衰减与只读归档候选）

P4 新增 `src/forgetting/` 目录。本文件说明 M 槽交付的 `decay.mjs`；
N（存储提案）与 O（执行/冷库检索）的文件由各自槽位说明。
本模块是**纯分析层**：无磁盘、无定时器、无 provider、无系统时钟，
不 import 未发布的 N/O 实现。

## decay.mjs

同步纯函数，供 O 的组合测试与未来执行门面消费。三个命名导出：

### DEFAULT_FORGET_POLICY

冻结的默认策略对象，恰好三字段：

```json
{ "baseHalfLifeDays": 30, "maxHalfLifeDays": 240, "archiveScore": 0.25 }
```

这是主审在 P4-KICKOFF-2026-10-25 记录的实施决策（落实 DESIGN §9.3 的待定参数），
不是用户逐项拍板值。

### normalizeForgetPolicy(policy = {})

「部分覆盖 + 默认补全」的严格规范化，返回**独立**的完整三字段普通对象：

- `policy` 必须是普通对象（`Object.prototype` 或 `null` 原型）；自定义原型、
  数组、类实例、null、原始值一律 `INVALID_INPUT`；
- 未知键拒绝；**自有键显式 `undefined` 拒绝**（不提供请省略该键）；
  继承字段一律不作输入；
- `baseHalfLifeDays` ∈ [1,365]（闭）、`maxHalfLifeDays` ∈ [base,3650]（闭，
  单独抬高 base 时注意与补默认的 max=240 的先后约束）、
  `archiveScore` ∈ (0,1)（开）；
- NaN/Infinity/非数值拒绝；所有错误统一 `SparkStoreError{code:'INVALID_INPUT'}`，
  不泄漏原生 TypeError。

### evaluateSparkDecay(card, {now, policy})

单卡衰减评估。`card` 至少含九个必需**自有**字段
`id, scopeId, revision, state, vitality, createdAt, lastUsedAt, useCount, supersedes`
（继承字段不作输入），可含冻结 store 完整卡的其余字段；schema 之外字段拒绝。
`now` 必须显式注入的规范 UTC ISO 字符串（`new Date(v).toISOString()===v`）；
不猜 Date 对象/本地日期/数字时间戳。

公式与资格（契约 §1）：

```
score        = 2 ** (-elapsedDays / halfLifeDays)
halfLifeDays = min(base * 2 ** useCount, max)      // 大指数封顶，无 Infinity/NaN
elapsedDays  = max(0, (now - (lastUsedAt ?? createdAt)) / 86400000)
资格          = active ∧ ephemeral ∧ supersedes===null ∧ elapsedDays>=60 ∧ score<archiveScore
```

- **锚点只有 `lastUsedAt ?? createdAt`**：匹配/曝光（hitCount/lastHitAt）不续期；
- **固定冷却 60 天**（毫秒差除日，不取整）：默认策略下 59 天 too-recent、
  恰 60 天 score 恰为 0.25 **不严格低于阈值 → 不归档**、61 天可归档；
  自定义阈值同样必须满 60 天冷却**且**分数**严格**低于阈值；
- **evergreen 免疫**：`halfLifeDays=null`、`score=1`，但年龄仍按同一锚点计算；
- **退休状态（archived/superseded/merged）不候选**（reason `inactive`）；
- **承接保护**：`supersedes !== null` → `replacement-protected`
  （维持已有双向替代链的加载约束）；
- **时钟回拨**（now < 锚点）：elapsedDays 夹 0，并输出结构化报警
  `[{code:'CLOCK_ROLLBACK', id, anchorAt, now}]`；非候选遇回拨同样报警。

返回恰好 `{id, revision, elapsedDays, halfLifeDays, score, eligible, reason, alarms}`。
`reason` 优先级：`inactive` > `evergreen` > `replacement-protected` >
`clock-rollback` > `too-recent` > `score-not-below-threshold` > `eligible`，
仅最后一种 `eligible=true`。输入不被修改（deep-freeze 下可计算）。

### analyzeForgetting({scopeId, sparks, now, policy, limit=20})

scope 批量分析：`sparks` ≤ 10000 卡、id 无重复、全体 `scopeId` 与入口严格一致
（跨 scope 整次报错）；`limit` 整数 1..20；坏记录整次报错、不静默跳过。
返回恰好：

```
{ version:1, kind:'forget-analysis', scopeId, now, policy,
  assessments, candidates, alarms, plan }
```

- `assessments`：全体卡评估，按 id UTF16 码点升序；
- `alarms`：各卡 CLOCK_ROLLBACK 报警按 id 合并（每卡至多一条）；
- `candidates`：eligible 卡按 `elapsedDays` 降序、并列按 id 升序，取 `limit`，
  每项为契约 §3 Source（恰好 `{id, revision, createdAt, lastUsedAt, useCount}`，
  绑定 live 同名字段）；
- `plan`：无候选为 `null`；否则完整 archive-ephemeral Plan
  `{version:1, kind:'archive-ephemeral', scopeId, now, policy, sources}`，
  `sources` 与 `candidates` 独立 clone 并改按 **id** 排序（candidates 年龄优先）。
  Plan 交由 N 的 `archiveEphemeral` 消费；文案不构成授权。

## 边界与已知限制

- 标识符规则与冻结源逐条对齐（scopeId ↔ `src/storage/paths.mjs`、
  spark id ↔ `src/sparks/store.mjs`），本地实现以保持「除
  `../sparks/errors.mjs` 错误类型外零 import」的纯函数边界（沿 J 槽先例）。
  复用 `validateScopeId` 语义前先检查类型：冻结 paths.mjs 的
  `toLowerCase()` 先于 typeof 检查，非字符串会抛原生 TypeError，
  本模块自带类型前置防线。
- 卡的可选字段（title/triggers/links/mergedInto 等）只做**轻量**类型校验；
  完整业务长度/结构校验属冻结 store 的加载职责，本模块只消费它能产生的形状。
- `limit` 的显式 `undefined` 视为未提供（沿用 store `hasField` 惯例）；
  policy 的显式 `undefined` 按契约特指拒绝——两者行为有意不同。
- 浮点说明：默认边界用例（60 天恰 0.25）落在 2 的整数幂上，浮点精确；
  一般输入的比较遵循 IEEE754 语义，不引入 epsilon。
- 本模块只产出候选与 Plan，**永不执行**：写入路径在 N，可信执行在 O。
