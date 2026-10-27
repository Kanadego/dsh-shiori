# Shiori P0-CORE · 纯规则接口文档

> slot A 交付。公共入口：`src/core/index.mjs`（Node 原生 ESM，无依赖）。
> 契约依据：`collab/CONTRACTS.md §A`、`DESIGN.md §4.2、§5.1.1、§7.1、§10`。
> 全部为纯函数：无 I/O、无共享可变状态、无网络调用；输入不变时输出逐字稳定。

## 导出一览

| 导出 | 签名 | 作用 |
| --- | --- | --- |
| `DEFAULT_CONFIG` | 冻结对象 | 契约规定的默认配置（core/persona/spark 三段） |
| `validateConfig(config)` | `(object) → config` | 整体校验配置；返回全新冻结的完整配置，不修改输入；非法抛 `INVALID_INPUT` |
| `renderL1({coreText, topics})` | `→ {text, chars, bytes, indexText}` | L1 完整渲染：core 正文 + 派生索引 |
| `evaluateMutation({currentText, candidateText, config})` | `→ {allowed, promotable, reason, level, currentChars, candidateChars, softAt, hardAt}` | 双水位 + 绝对硬顶闸门 |
| `selectVisibleTopics({activeScopeId, topics})` | `→ Topic[]` | 作用域可见性：active 覆盖 global，其他 scope 不可见，按 key 稳定排序 |
| `validateKey(key)` | `(string) → key` | 安全 key（文件名级）校验；有效原样返回，非法抛 `INVALID_INPUT` |

错误统一为 `Error`，带稳定机器可读 `code`（本模块只产生 `INVALID_INPUT`；`REVISION_CONFLICT`、`BUDGET_REJECTED`、`INVALID_STATE`、`UNSUPPORTED` 由 B/C 层在对应场景使用）。`error.name === "ShioriError"`。不静默截断、不自动以空字符串/零掩盖错误。

## 1. 配置：`DEFAULT_CONFIG` / `validateConfig`

```
core:   { targetChars 8000, hardCapChars 10000, softRatio 0.75, hardRatio 0.90, cacheLockFallback false }
persona:{ maxChars 12000 }
spark:  { maxChars 600, inlineMaxChars 100, maxCards 5, seedCount 3, linkCount 2 }
```

- 推导水位：`softAt = floor(hardCapChars×softRatio)`、`hardAt = floor(hardCapChars×hardRatio)`（默认 7500 / 9000）。`validateConfig` 返回值不含推导字段，由 `evaluateMutation` 每次计算并随结果返回。
- 校验规则（整体生效，非法不部分提交）：
  - `0 < softRatio < hardRatio < 1`；
  - `softAt ≤ targetChars < hardAt < hardCapChars`；
  - 字符数与卡片数为正整数，`linkCount` 可为 0；`inlineMaxChars ≤ maxChars`；`seedCount + linkCount ≤ maxCards`；
  - `cacheLockFallback` 必须是布尔。
- 缺省段/缺省键用默认值补齐后返回完整配置（新对象、深冻结）；**未知属性一律拒绝**（顶层与段内均是），防拼写错误。
- 配置对象与各段必须是**普通记录对象**：原型为 `Object.prototype` 或 `null`（`Object.create(null)` 合法）；`Date`/`Map`/`Set`/`RegExp`/类实例等一律拒绝，不会被当成缺省静默通过。
- 传入的 `config` 对象不会被修改；`DEFAULT_CONFIG` 本身深冻结，防止共享状态被污染。

## 2. 渲染：`renderL1`

- 磁盘 core.md 只存人工正文；索引在渲染时派生，**禁止回写**（本模块无任何写操作）。
- 索引格式（固定，标题与来源全部计入预算）：

  ```
  ## 主题记忆索引 / Topic memory index
  - key [scopeId] — summary
  ```

- 拼接规则：core 与索引都非空时以**两个 LF** 连接；core 为空时只渲染索引；**无 topic 不加索引标题**；两者皆空 → 空字符串。
- `chars = text.length`（UTF-16 码元，emoji 计 2）；`bytes` 为 UTF-8 字节数，**仅作诊断，不参与水位**。
- 排序按 key 的 UTF-16 码元序（`compareKeys`），与系统 locale 无关；相同输入重复渲染逐字一致，topics 顺序不影响结果。
- `renderL1` 是纯渲染器，**不做预算裁决**：超限文本照样渲染（修复候选需要先量出来），预算由 `evaluateMutation` 判定。
- 输入约束：`coreText`/`topics` 均必填（严格类型）；topics 必须是**已去重的可见列表**——同 key 重复（即使 scopeId 不同）抛 `INVALID_INPUT`；Topic 元数据非法（见 §4）同样抛错。
- topics 数组按索引逐项校验：**稀疏数组的孔（`new Array(1)`、混合孔）与显式 `undefined`/`null` 一律拒绝**，不会被静默当成无 topic；空数组合法。
- 输入对象必须是普通记录对象（见 §1 规则）；选项与 Topic 的必填字段按 **own-property** 判定，仅存在于原型链上的字段不算数。
- coreText 逐字保留：不 trim、不加尾换行（尾换行会与两 LF 连接叠加为三个 LF，属调用方内容）。

## 3. 闸门：`evaluateMutation`

唯一水位基数 `hardCapChars`；唯一占用 = 完整渲染文本的 UTF-16 码元数（B 注入 policy 时必须传渲染器产物，不能只量 core 正文）。

判定表（默认 7500/9000/10000）：

| 当前水位 | 条件 | allowed | promotable | reason |
| --- | --- | --- | --- | --- |
| 任意 | 当前 > cap 且候选 ≥ 当前 | false | false | `repair-only` |
| over-cap | 当前 > cap 且候选 > cap 且候选 < 当前 | true | **false** | `repair-over-cap` |
| over-cap | 当前 > cap 且候选 ≤ cap（净减少） | true | true | `repair` |
| 非 over-cap | 候选 > cap | false | false | `over-hard-cap` |
| gate | 候选 > 当前（净增长） | false | false | `net-growth-blocked` |
| gate | 候选 < 当前 | true | true | `net-reduction` |
| gate | 候选 = 当前（等长改写） | true | true | `gate-hold` |
| < gate | 候选 ≥ hardAt 且 ≤ cap（首次跨入） | true | true | `first-crossing` |
| < gate | softAt ≤ 候选 < hardAt | true | true | `soft-reminder` |
| < gate | 候选 < softAt | true | true | `ok` |

- reason 优先级：over-cap 修复规则 > 硬顶防线 > 增长闸门 > 水位提醒。当前在闸门之上而候选又超硬顶时报 `over-hard-cap`（最终防线优先，两种规则都拒绝该候选）。
- `allowed`（允许写盘）与 `promotable`（可提升为有效 L1 system 投影）是**两个独立判定**：部分修复时 `allowed=true && promotable=false`（DESIGN §7.1「仍超限时不提升为有效 system」）。
- `level` 描述**当前**所处水位区间（决策适用档位）：`normal`（<softAt）/ `soft`（≥softAt）/ `gate`（≥hardAt）/ `over-cap`（>cap）。提交后的新水位可用 `currentText=候选文本` 再求一次得到。
- 无状态：同一 current 从 <hardAt 再次跨入仍视为"首次"跨入（先降回 <9000 才可能再次跨入，语义自洽）。
- `config` 会在内部再过一遍 `validateConfig`；文本非字符串、选项缺字段/多字段都抛 `INVALID_INPUT`。

## 4. 可见性：`selectVisibleTopics` 与 Topic 校验

- Topic 形状：`{key, title, summary, scopeId, revision, updated, body?}`。除 `body` 外全部必填（**own-property 判定**，仅继承的不算）；`body` 为可选字符串。**允许未知自有字段**（数据前向兼容；Topic 是数据记录而非控制接口）。Topic 对象本身必须是普通记录对象（原型为 `Object.prototype` 或 `null`）。
- 校验规则：
  - `key` 过 `validateKey`；`title` 非空字符串；
  - `summary` 是字符串且 **≤60 UTF-16 码元**（空串允许，渲染为 `- key [scopeId] — `），不得含换行（保护索引行结构）；
  - `scopeId` 非空字符串、无首尾空白、无控制字符、无孤立代理码元、≤128 码元；
  - `revision` 非空字符串；`updated` 为非空字符串 / 有限数字 / **有效** Date（Invalid Date 拒绝；时间编码格式待与 B 统一，建议 ISO 8601 字符串）；
  - 所有输入 topics（含不可见 scope）都做完整校验——坏数据即刻显式失败，不静默跳过；稀疏数组的孔同样显式拒绝。
- 可见性：`scopeId === activeScopeId` 或 `scopeId === "global"` 可见；同 key 时 **active 覆盖 global**；其他 scope 一律不可见。`activeScopeId: "global"` 自然退化为仅全局视图。
- **同一 scope 内重复 key 抛 `INVALID_INPUT`**（存储层数据错误）；不同 scope 同 key 合法（DESIGN §10）。
- 输出按 key 码元序稳定排序；返回原对象引用（浅选择，不克隆、不改输入数组）。
- **跨 slot 约定**：全局作用域的字面量是 `"global"`（对应 DESIGN §10 目录 `scopes/global/`）。B/C 必须使用同一字面量，本模块未导出该常量（严格按契约只导出六个成员）。

## 5. 安全 key：`validateKey`

key 将成为 `topics/<key>.md` 文件名，按跨平台最严格规则：

- 必须是字符串，1–128 个 UTF-16 码元；
- **拒绝孤立代理码元**（未配对的高/低代理 U+D800–U+DFFF）：它们在 UTF-8 编码时会被替换为 U+FFFD（efbfbd），不同 key 会静默归并造成身份碰撞；合法代理对（非 BMP 字符如 😀、𠮷）继续允许；
- 拒绝控制字符（U+0000–001F、U+007F、U+0080–009F）与 Windows 非法字符 `<>:"/\|?*`（斜杠/盘符/遍历由此覆盖）；
- 拒绝纯点号名（`.`、`..`、`...`）、首空格、尾空格、尾点；
- 拒绝 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，任意大小写、任意扩展名、段尾点空格已剥离后再比对——`CON.md`、`con.x`、`CON .x` 都非法）；
- 拒绝 Shiori 保留别名 `core` / `core.md`（大小写不敏感；DESIGN §10「新 id/key 不得与 core、core.md 等保留别名冲突」）；
- 其余 Unicode（含中文、emoji、内嵌点如 `a.b`、`a..b`）允许。

## 设计决策记录（请重点复核）

> attempt 2：R1（孤立代理）、R2（稀疏数组）、R3（plain object / own-property）三项返工已修复，详见 REPORT.md §返工修复；非阻塞提示（updated 时间编码）已收紧 invalid Date，字符串格式待与 B 统一。

1. `level` 以**当前**水位计、`reason` 为稳定标识符——契约未规定词表，此处自定义并在本文档固定；若需调整请在 review 中说明。
2. 候选超硬顶的 reason 优先报 `over-hard-cap`（最终防线），即使增长闸门也同时命中。
3. summary 空串允许（契约只规定 ≤60 上限）；渲染为尾随 `— ` 的行。
4. `renderL1`/`selectVisibleTopics`/`evaluateMutation` 的选项对象**严格键集**（未知属性拒绝、必填属性缺失报错），遵循"不以空值掩盖错误"；Topic 数据对象则允许未知自有字段。
5. `updated` 接受非空字符串/有限数字/有效 Date（Invalid Date 拒绝）；统一时间编码建议与 B 约定 ISO 8601 字符串。
6. key 上限 128 码元为保守值（为 `<root>/scopes/<scopeId>/topics/<key>.md` 预留路径余量）。
7. `DEFAULT_CONFIG` 与 `validateConfig` 返回值均深冻结，防共享状态污染。
8. 超限修复路径 `11000→10500`：`allowed=true, promotable=false`——写盘允许但不得提升为有效 system（DESIGN §7.1）。
9. 控制对象（选项/配置/Topic）必须是普通记录对象（原型 `Object.prototype` 或 `null`）；必填字段按 own-property 判定，防原型继承与 `Object.prototype` 污染。scopeId 与 key 同为身份标识，同样拒绝孤立代理码元。
