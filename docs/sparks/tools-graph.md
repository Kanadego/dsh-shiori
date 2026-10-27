# L2 Sparks · 工具门面与安全图谱投影（Slot I / P2）

`src/sparks/tools.mjs` + `src/sparks/graph.mjs`：纯 host-agnostic 的六个 L2 工具
（DESIGN.md §6）与图谱投影。唯一外部依赖是 CONTRACTS.md §G 的 store 公开接口
（`openSparkStore` 返回的实例，宿主工厂注入）；不 import G/H/P1 的任何文件，
因此两个模块在提交包内自包含。

## 快速上手

```js
import { openSparkStore } from "./store.mjs";            // G 交付并已验收
import { createSparkTools } from "./sparks/tools.mjs";   // 本模块

const store = await openSparkStore({ root: dataRoot, scopeId: "amber" });
const facade = createSparkTools({ scopeId: "amber", store }); // scopeId 只来自可信工厂
// 工厂要求 store 提供 save/read/update/forget/feedback/listActive（§G 公开契约）

facade.names;            // ["spark_save","spark_read","spark_update","spark_forget","spark_feedback","spark_graph"]
facade.list();           // 无 execute 的 { name, description, inputSchema }[]（宿主注册用）
facade.tools;            // P1 风格完整描述符数组
await facade.execute("spark_save", { content, title, triggers, vitality }); // 分发；未知名 INVALID_INPUT
```

## 六个工具与回执

| 工具 | 关键入参 | 门面行为 |
| --- | --- | --- |
| `spark_save` | `content`*、`title`*、`triggers`*（空数组=不自动唤醒）、`vitality`*（evergreen/ephemeral）、`summary?`、`entities?`、`links?`、`expectedRevision?`、`operationId?` | id/revision 由 store 生成；payload 不得带 `id` |
| `spark_read` | `id`* | L2 正文唯一展开路径（不是 memory_read）；异 scope 记录按 NOT_FOUND 处理；archived/superseded 历史在 scope 内可读并回显 `state` |
| `spark_update` | `id`*、`patch`*（title/summary/content/triggers/entities/links/vitality 至少一项）、`expectedRevision?`、`operationId?` | `id`/`state`/`scopeId`/`revision` 不可补丁 |
| `spark_forget` | `id`*、`mode`*（archive/supersede）、`replacementId?`（supersede 必填且 ≠ id）、`expectedRevision?`、`operationId?` | archive 不接受 replacementId |
| `spark_feedback` | `id`*、`used`*（显式 boolean）、`sourceEventId?`、`operationId?` | 按 sourceEventId/operationId 幂等由 store 裁决 |
| `spark_graph` | 无 | 模型回执只有 `handle` + 规模摘要，详见下文 |

成功回执统一含 `ok:true, tool, scope(=可信 scopeId), operationId` 与 store 写回
的 `id/revision/state/vitality`（字段缺失时降级为 `null`，绝不虚构）。
`expectedRevision` 是不透明 JSON 标量（非空 string / 有限 number / null），门面只
透传，CAS 比对与 `REVISION_CONFLICT` 完全由 store 判定；`operationId` 缺省时门面
生成 UUID，重试必须复用同一 id 才能命中 store 幂等。

## 安全边界（为什么这样设计）

1. **payload 不能改变 root/scope**：`scope` / `scopeId` / `root` 三个键出现在任何
   工具（含 `spark_update` 的 patch）即 `INVALID_INPUT`，即便值恰好等于可信 scope。
   scope 只来自宿主工厂注入 `createSparkTools({ scopeId, store })`。
2. **写工具拒绝未知键**：拼写漂移与 scope 变体走私在门面层拦下，store 不会被
   触碰（测试断言被拒 payload 的 call log 为空）。
3. **store 错误原样上抛**：`REVISION_CONFLICT` / `LOCK_BUSY` / `NOT_FOUND` /
   `INVALID_INPUT` / `INVALID_STATE` / `UNSUPPORTED` 不吞、不降级、不伪造
   `ok:true`。门面自造错误只用 `INVALID_INPUT`（入参）、`INVALID_STATE`
   （store 返回形状与请求不符）、`NOT_FOUND`（异 scope 记录按不存在处理，不泄露
   跨 scope 存在性）。
4. **spark_read 防御**：store 返回异 scope 记录 → `NOT_FOUND`；返回 id 与请求
   不符的记录 → `INVALID_STATE`（宁可失败不回错卡）。
5. **spark_graph 模型侧最小化**（DESIGN §4.3.5）：回执 = 面板句柄
   `spark-graph:<scopeId>` + nodes/edges/vitality/dropped 计数 + 提示语，不含任何
   节点 id、标题、正文。整图投影（`projectGraph` 结果）只供宿主面板直连取数，
   不作为模型工具回包；正文必须显式 `spark_read(id)`。

### spark_graph 数据源边界（GI 组合评审拍板）

`spark_graph` 的数据源**只有** `await store.listActive()`（完整 active public
record）；门面绝不调用 `store.graph()`。两个平面不混用：

| | G `store.graph()` | I UI 投影（`spark_graph` / 面板） |
| --- | --- | --- |
| 性质 | 有向**诊断平面** | 无向 UI 投影 |
| 节点 | 仅 `{id,title,vitality,revision}` | 完整记录过滤后的元数据节点 |
| 边 | 有向 edges + `filteredEdges`（source-retired / target-retired 不静默消失） | 由记录自身 `links` 派生，互逆折叠为一条 reciprocal 边 |
| 用途 | store 侧诊断/验收 | 模型摘要 + 面板渲染 |

原因：`graph()` 节点缺 `scopeId/state/links/summary`，喂给 `projectGraph` 会被
防御性过滤成 0 节点空图——a1 轮的组合评审实测两个 active 卡 + 一条链接被静默
报成 `nodes=0, edges=0, droppedRecords=2`。测试中有金丝雀用例锁死「门面永不
调用 graph()」。

## 图谱投影（src/sparks/graph.mjs）

    normalizeGraphRecords(raw)               // store.graph() 返回值 → 记录数组
    projectGraph({ scopeId, records })       // → { scopeId, nodes, edges, stats }
    graphSummary(projection)                 // → 模型侧句柄 + 规模摘要

- **节点过滤**：只保留 `scopeId === 可信scope && state === "active"` 且无
  `mergedInto`/`supersededBy`/`replacedBy` 标记的记录。archived、异 scope、
  superseded、merged、畸形记录全部丢弃并按原因计数（`supersedes` 是新卡的出边，
  不构成排除）。同 id 重复取 revision 更大者。防御 store 缺陷，不信任上游形状。
- **边派生**：边只来自节点自身 `links`（supersedes/mergedInto 是有向关系，不属于
  投影边）。悬空端点（含跨 scope 指向）、自环、非对象 link 丢弃并计数；同向重复
  边去重（rel 取字典序最小非空值）；`A→B` 与 `B→A` 按 DESIGN「links 用于双向遍历」
  折叠为一条边（`reciprocal:true`，source 取 code-unit 较小端）。
- **排序与确定性**：全部用 UTF-16 code-unit 比较（不用 localeCompare），节点按
  id、边按 (source, target, rel) 稳定排序；输出不含时间戳——同一输入（无论顺序）
  产出逐字节一致的结果。
- **节点载荷**：`{ id, title, summary, vitality, revision, degree }`——纯元数据，
  绝无 `content`/`triggers` 正文。vitality 只认 evergreen/ephemeral，其余标注
  `unknown` 并计数，不静默猜测。
- **规模**：`stats = { nodes, edges, vitality:{evergreen,ephemeral,unknown},
  dropped:{records:{scope,state,redirected,malformed,duplicateId}, edges:{dangling,
  self,duplicate,reciprocal,malformed}} }`。500 节点链 499 边已测。

## 错误速查表

| 现象 | code | 处置 |
| --- | --- | --- |
| payload 带 scope/scopeId/root 被拒 | INVALID_INPUT | 删掉该键；scope 由宿主工厂注入 |
| 写工具报未知键 | INVALID_INPUT | 对照 inputSchema；拼写错误会被拦 |
| 改卡/归档冲突 | REVISION_CONFLICT | 重新 spark_read 拿最新 revision 再试，复用原 operationId |
| 读写时锁忙 | LOCK_BUSY | 稍后原样重试（同 operationId 幂等） |
| spark_read 找不到 | NOT_FOUND | id 属其他 scope/不存在；检查来源 |
| store 返回记录与请求 id 不符 | INVALID_STATE | store 缺陷，检查 G 的实现 |
| store.graph() 形状不符 | INVALID_INPUT | 期望记录数组或 {nodes/records/sparks} 包装 |
| 图里少了某张卡 | — | 查 stats.dropped：scope/state/redirected/dangling 计数会给原因 |

## 集成状态（attempt 2）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 门面 + 投影 + 合成测试 | ✅ synthetic | fake store（按 §G 契约内存实现），全过 |
| G 真实 store 组合 | ✅ passed | 真实 `openSparkStore`（已验收 a2 包）×`createSparkTools` 集成回归：2 节点/1 边、scope 隔离、互逆折叠、superseded 过滤、临时 root；overlay 与看板双路径均验证 |
| H 组合 | not-run（本槽位） | H 已验收；三向集成由负责人按验收流程做 |
| DSH client panel 注册 / GenUI 渲染 | ⛔ not-run | 后续集成，不得用 fake 成功冒充 |
| 真实 DSH 宿主 smoke | ⛔ not-run | 发布闸门，见 docs/HOST-ACCEPTANCE.md，须隔离 profile + 独立 dataRoot |

集成回归的 G 解析顺序：同树 overlay（`../../src/sparks/store.mjs`，根集成布局）
→ 看板已验收 G 提交包（临时目录组装一次性 overlay：G sparks 文件 + 基线
`src/storage/*`，用后即删）→ 都不可达则跳过并注明原因（跳过不冒充通过）。

已知限制：G `graph()` 诊断平面（含 `filteredEdges`）不被本模块消费（见上表，
两平面不混用）；`mergedInto`/`replacedBy` 过滤是防御外来记录的，对 G 自身
schema（`supersededBy`/`supersedes`）非必需但也无害；store 写操作返回形状以
public record 为准（G 实测即完整记录）；互逆边折叠策略（A→B + B→A = 一条
reciprocal 边）为本模块拍板；DSH 工具注册、client panel 与 GenUI 渲染本批次
未实现（not-run，不伪造）。
