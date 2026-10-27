# L2 Sparks · 确定性检索与受控投递（H 槽）

本文描述 `src/sparks/match.mjs` 与 `src/sparks/delivery.mjs` 的行为契约。两者都是
**纯函数**：不读写磁盘、不调用 store、不注册工具/host、不写 seen 状态，也不猜测
compress 成功（contextEpoch 只接收参数，由 P1 成功压缩证据推进）。

## 接口

```js
import { matchSparks, seenKeyFor } from "../sparks/match.mjs";
import { buildSparkAttachment, commitDelivery } from "../sparks/delivery.mjs";

const match = matchSparks({ scopeId, userText, sparks, seenKeys, sessionId, contextEpoch, maxSeeds = 3, maxRelated = 2 });
const delivery = buildSparkAttachment({ scopeId, sessionId, contextEpoch, match, maxChars = 600 });
const committed = commitDelivery({ delivery, accepted });
```

`match` 返回 `{ scopeId, sessionId, contextEpoch, seeds, related, anchors }`；
`delivery` 返回 `{ kind: "spark-attachment", scopeId, sessionId, contextEpoch, maxChars, text, chars, delivered, dropped }`；
`committed` 返回 `{ accepted, seenWrites, hitUpdates }`，其中 `seenWrites[].key`
由 `seenKeyFor` 构造，写入由 store 层（G 槽）执行。

**固定硬上限**：种子 ≤3（`MAX_SEEDS`）、关联 ≤2（`MAX_RELATED`），合计 ≤5 张卡
（`spark.maxCards`）。`maxSeeds`/`maxRelated` 校验为非负整数后**按硬上限钳制**，
调用方传更大值无法突破 3+2；小于上限的值仍被尊重。

### userText 的两种形态

- **字符串**：调用方已确认的用户正文，直接扫描。
- **`{ role, text }` 消息对象**：仅 `role === "user"` 扫描；`system` / `assistant` /
  `tool` / 历史 / 插件附件角色一律返回空结果（无扫描），**不报错**。
- 其他类型（数字、数组等）为编程错误，按 `INVALID_INPUT` 拒绝。

## 匹配规则（DESIGN §4.3.2 / §4.3.3）

### 0 跳种子（最多 3 个未 seen）

1. 只扫描一条用户正文；文本与触发词都先做 NFC 归一化再比较，**原文不改**
   （结果中的 `trigger` 返回卡片上的原始写法）。
2. 英文大小写折叠；纯 ASCII 字母数字触发词按**词边界**匹配（`cat` 不命中
   `concatenate`，可命中 `a cat!`）；含空格/连字符/中日韩的触发词按子串匹配。
   谐音只接受显式别名（即 `triggers[]` 里写明的词），不做模糊扩散。
3. 资格筛选：本 `scopeId`、`state === "active"`、非 redirect（`mergedInto` 或
   `supersededBy` 已设置的条目排除；`supersedes` 指向他人不算自身失效）。
4. **先过滤 seen，再截取 top-3**：已 seen 的直接命中不占种子名额，因此前三张
   已冷却不会饿死第四张未 seen 的种子。
5. 排序确定：每卡取其最长命中触发词（按归一化长度），最长优先；平局按 `id`
   升序（码点序）。

### 已 seen 锚点（最多 3 个）

已 seen 的直接命中按同样排序取前 3 个作锚点：**自身绝不重复投递**（不进
seeds/related），但可参与 1 跳扩散。seen 判定按当前 `revision` 构造键整体比较
（见下文键格式），换 session / epoch / revision 即视为未 seen。

### 1 跳扩散（关联最多 2 个）

- 扩散源 = 种子 + 锚点，**只扩散一次**；关联卡自己的 links 不再展开（禁两跳）。
- **候选选择与输入顺序无关**：先从全部扩散源收集 link/entity 候选并按卡片 id
  去重（同一卡多条路径保留稳定键最小者），再按稳定键排序后截取前
  `maxRelated`（钳制到 2）个。稳定键逐位升序：`kind`（显式 link=0 < entity=1）、
  卡片 id、扩散源 id、rel/entity 字符串——显式 links 因此始终优先于 entity 共现。
- **泛化 entity 排除**：某 entity 在可见 active 卡中出现次数 > 5（严格大于），
  不参与扩散；正好 5 张仍允许。
- 关联候选同样要求合格（scope/active/非 redirect）、未 seen、未与种子/锚点重复，
  先过滤再截取。self-link 与指向不存在/不合格卡片的 link 忽略，不报错。

### seen key 格式

```
spark:seen:<scopeId>:<sessionId>:<contextEpoch>:<sparkId>:<revision>
```

键是**不透明字符串，只做整体比较**（id 可能含分隔符字符，不做反向解析），
至少含 scope/session/contextEpoch/spark/revision 五个成分（DESIGN §4.3.2 第 4 条）。

## 附件装配（buildSparkAttachment）

- 预算 `maxChars` 默认 600 个 **UTF-16 字符**（`text.length` 口径），标题、id、
  revision、来源、分隔符全部计入；逐卡二次量测。
- 单卡块格式：`[spark:<id> rev<revision>] <title>[ · <source>]` + 换行 + 正文；
  块间分隔符 `\n---\n`（5 字符，计入预算）。
- **正文 ≤ 100 字符**才直接带出；装不下时降级为预存 `summary`。正文 > 100（或
  正文缺失）的卡只允许 `summary + id`；**summary 缺失、为 null 或仅含空白字符
  （trim 后为空）时整卡跳过**，`dropped` 记
  `{ id, reason: "missing-summary" }`——绝不产出仅元数据头部或以空白充当正文
  的"空投递"，也不会进入 delivered/seen/hit。
- **绝不截半句话**：任何正文/摘要都不会被部分输出；装不下唯一出路是降级或
  整卡跳过（`dropped: [{ id, reason: "budget" }]`）。
- 种子优先占用预算，再用余量装关联；条数是上限，不承诺凑满。
- 空 match / 无命中产出 `text: ""`，调用方不应附加。

## 提交语义（commitDelivery）

- `accepted !== true`（含 `false`）→ 返回 `{ accepted: false, seenWrites: [], hitUpdates: [] }`，
  **不产生任何 seen/hit 变更**。
- `accepted === true` 时只对 `delivery.delivered` 里的卡（即真正进入附件文本的卡）
  产生：
  - `seenWrites`：`{ key, scopeId, sessionId, contextEpoch, sparkId, revision }`；
  - `hitUpdates`：`{ sparkId, revision }`，供 store 记 hitCount/lastHitAt。
- 预算挤掉的卡只出现在 `dropped`，不会进 seen。失败/工具步骤/非 user 输入在
  上游就产不出 delivered 条目，自然不会标 seen。
- `hitCount/lastHitAt` 只代表成功投递；关联曝光不代表 used，`useCount` 只由
  `spark_feedback(used=true)` 更新（G 槽职责，本模块不判定"有用"）。

## 错误码

纯函数使用与基线一致的 `ShioriError`：入参不合法（类型、空串、负数、非整数、
delivery 形态不符）抛 `INVALID_INPUT`；不静默吞错回空成功。

## 边界与已知限制

- 本模块只处理**传入**的卡片数组；卡片合法性依赖 G 槽 store 的持久层校验，
  这里只做匹配所需的防御性过滤（scope/state/redirect/revision）。
- `sparks` 数据库本身（并发、幂等、恢复）由 G 槽实现；本模块无 I/O。
- contextEpoch 不会由本模块推进；真实 DSH 接入、P0 探针通过后的 compress
  联动属后续批次（当前全部为 synthetic，未接真实宿主）。
- 见 REPORT.md 的 checks 与 knownLimitations。
