# dsh-shiori — 开发者设计与维护手册

> **当前版本**：v0.3.0 · **宿主兼容**：DSH `>=0.2.1-rc.2 <0.3.0` · **平台**：Windows / Linux / macOS
>
> 本文档面向插件维护者与二次开发者，提供：**架构与核心功能全景**、**源码与双根磁盘文件索引**、**全量参数速查表**、以及 **状态/时间线审计与错误码排障指南**。

---

## 1. 核心架构与设计原则

### 1.1 四层记忆分工与双根隔离

Shiori 把角色记忆按注入频率拆成四层，并将**长期业务数据**与**可再生运行状态**拆进两个互不嵌套的根目录：

1. **四层记忆分工**
   - **L0 人设卡（Persona）**：存放在宿主 `personas/<name>.md`，每轮常驻系统提示词最顶部（`shiori:persona`）。
   - **L1 记忆核心与专题索引（Core + Index）**：`core.md` 正文加上自动派生的专题一句话目录，每轮常驻系统提示词（`shiori:core`）。
   - **L2 闪回卡（Sparks）**：平时不占上下文；仅在用户当轮发言命中触发词或本地向量语义时，作为当轮附件临时浮回。
   - **L3 专题档案（Topics）**：长篇资料与实操记录，平时只在 L1 露出标题与摘要，由模型按需调用 `memory_read(topic)` 展开。
2. **双根物理隔离（`dataRoot` vs `stateRoot`）**
   - **业务数据根（`dataRoot`）**：存放 `core.md`、`topics/*.md`、`sparks.json` 与写入事务日志，需要定期备份。
   - **运行状态根（`stateRoot`）**：存放幂等重放账、L2 投递账、L1 快照回退缓存与本地向量索引；全部可由业务数据重建，删掉也能自愈。

### 1.2 三条核心铁律

- **先来者可写，后来者自动只读（F7 座位心跳）**：当多个宿主（如 Web 与 Desktop）指向同一个 `dataRoot` 时，先启动的宿主持有写权；后启动的宿主自动进入只读模式（读与注入照常，写操作返回 `HOST_LOCKED`）。
- **绝不静默截断**：L1 写入前必须通过完整快照预算校验，超限直接拒绝报错；外部手改文件导致超限时，自动回退到最近一次合法的 L1 快照，绝不暗中掐头去尾。
- **身份与作用域由宿主绑定**：工具与面板请求一律不接受模型自传 `scope`；当前用哪张人设卡，完全由宿主按「会话绑定 → 工作区最长前缀匹配 → 默认人设卡 → `global`」顺序决定。

---

## 2. 源码目录与数据落盘索引

### 2.1 源码结构（`src/` & `client/`）

| 目录 / 文件 | 核心职责 |
|---|---|
| `index.mjs` | 插件主入口：声明配置 Schema、挂载控制器生命周期与 Web 面板 RPC 通道 |
| `client/index.js` | 浏览器端原生 React 面板（单文件零构建，含总览、人设与核心、专题、闪回图谱、整理与遗忘、时间线） |
| `src/core/` | 纯函数核心规则：预算与水位计算（`budget.mjs`）、配置校验（`config.mjs`）、L1 渲染（`render.mjs`）、命名校验（`keys.mjs`） |
| `src/storage/` | L1/L3 文件仓库（`store.mjs`）：跨进程锁（`lockfile.mjs`）、两阶段事务日志（`journal.mjs`）、YAML 头解析（`frontmatter.mjs`） |
| `src/service/index.mjs` | 组合 Core 与 Storage 的高层读写服务（提供 `read` / `mutate` / `search` / `listTopics`） |
| `src/sparks/` | L2 闪回卡子系统：单文件存储（`store.mjs`）、字面匹配（`match.mjs`）、投递状态机（`delivery.mjs`）、关系图（`graph.mjs`）、6 个工具（`tools.mjs`） |
| `src/semantic/` | 本地语义补召回：ONNX 模型懒加载推理（`local.mjs`）与派生句向量库（`store.mjs`） |
| `src/organize/` | 记忆整理子系统：聚类与孤岛分析（`analyze.mjs`）、候选队列（`queue.mjs`）、受审计划执行器（`executor.mjs`） |
| `src/forgetting/` | 双轨遗忘子系统：半衰期衰减计算（`decay.mjs`）、批量归档执行器（`executor.mjs`）、冷库只读检索（`cold-search.mjs`） |
| `src/timeline/index.mjs` | 最近变更时间线：将 Core/Topic 事务日志与 Spark 操作账按时间倒序归并分页 |
| `src/completion/index.mjs` | 上下文压缩探针状态存储：记录各会话的压缩世代（`epoch`）与消息扫描水位 |
| `src/host/` | 宿主桥接层：11 个核心与专题工具（`tools.mjs`）、多宿主座位心跳（`seat.mjs`）、压缩事件探针（`compress-probe.mjs`） |
| `src/plugin/` | 插件装配层：控制器主流程（`controller.mjs`）、配置归一化（`config.mjs`）、面板管理 API（`management.mjs` / `protocol.mjs`）、状态账本（`state.mjs`） |

### 2.2 业务数据根（`dataRoot`）文件清单

推荐路径：`~/.dsh/shiori-data/`。

| 相对路径 | 读写模块 | 用途说明 |
|---|---|---|
| `.shiori-lock` | `storage/lockfile.mjs` | Core 与 Topic 写入专用的跨进程文件锁 |
| `.shiori-seats/<pid>-<id>.json` | `host/seat.mjs` | 多宿主座位心跳文件（每 2 秒刷新一次修改时间，用于选举唯一写者） |
| `scopes/global/core.md` | `storage/store.mjs` | 全局共享 Core 记忆正文（当前人设无私有 `core.md` 时自动回落读它） |
| `scopes/global/topics/<key>.md` | `storage/store.mjs` | 全局共享专题文件（与当前人设专题合并展示，同名时人设专题优先） |
| `scopes/<scopeId>/core.md` | `storage/store.mjs` | 指定人设卡的私有 Core 记忆正文 |
| `scopes/<scopeId>/topics/<key>.md` | `storage/store.mjs` | 指定人设卡的私有专题文件（含 YAML 头 `title` / `summary` / `archived`） |
| `journal/<operationId>.json` | `storage/journal.mjs` | Core/Topic 两阶段提交事务日志（提交后长期保留，供崩溃恢复与时间线查询） |
| `staging/<operationId>/` | `storage/store.mjs` | 写入事务暂存区（保存新内容与原文件备份，提交完成后自动删除） |
| `state/current.json` | `storage/store.mjs` | 当前提交代序号 `{ generation }` |
| `sparks/.shiori-lock` | `sparks/store.mjs` | Spark 卡片库专用的跨进程文件锁（与 Core/Topic 锁互不阻塞） |
| `sparks/scopes/<scopeId>/sparks.json` | `sparks/store.mjs` | 单文件 Spark 数据库：包含卡片表 `records` 与写操作审计账 `ops` |

> **注**：L0 人设卡存放在宿主 Profile 目录下的 `personas/<name>.md`，由 `src/plugin/persona.mjs` 直接读写并校验版本哈希。

### 2.3 运行状态根（`stateRoot`）文件清单

推荐路径：`~/.dsh/shiori-state/`（其中 `<scopeHex>` 为 `scopeId` 的 UTF-8 十六进制编码）。

| 相对路径 | 读写模块 | 用途说明 |
|---|---|---|
| `tool-ops/<scopeHex>.json` | `plugin/state.mjs` | 写工具幂等重放账（相同 `operationId` 重试时直接返回首次结果） |
| `l2/<scopeHex>.json` | `plugin/state.mjs` | L2 闪回投递账本（记录已扫描消息、已投递卡片、命中次数与会话压缩世代） |
| `projections/<scopeHex>.json` | `plugin/state.mjs` | 最近一次合法的 L1 渲染快照（供磁盘文件手改超限时安全回退） |
| `waterline/<scopeHex>.json` | `plugin/state.mjs` | L1 字符水位低频采样历史（供面板绘制水位趋势） |
| `queues/<scopeHex>.json` | `plugin/state.mjs` | 记忆整理候选队列快照（待审 / 已审 / 已忽略） |
| `plans/<scopeHex>.json` | `plugin/state.mjs` | 整理与遗忘生成的待执行计划账本 |
| `analyze-ops/<scopeHex>.json` | `plugin/state.mjs` | 面板触发分析操作的幂等重放账 |
| `completion-state-<scope>.json` | `completion/index.mjs` | 上下文压缩探针持久化状态 |
| `semantic/<scopeId>.json` | `semantic/store.mjs` | 本地模型生成的 Spark 句向量索引（支持在面板一键全量重建） |
| `semantic/models/` | `semantic/local.mjs` | 本地 ONNX 向量模型的默认下载缓存目录 |

---

## 3. 核心流水线与子系统机制

### 3.1 单轮对话记忆装配与闪回流水线

每次用户在会话中发起一轮对话时，`src/plugin/controller.mjs` 按以下顺序工作：

```text
[1. 解析可信作用域 (Scope)]
       └─► 按「会话绑定 → 工作区最长路径匹配 → 默认人设卡 → global」锁定本轮 scopeId
       │
[2. 系统提示词瀑布流装配 (system-prompt/assemble)]
       ├─► 注入 shiori:persona (order: 0)   ──► 读取 personas/<name>.md 作为 L0 人设卡
       └─► 注入 shiori:core    (order: 0.5) ──► 拼装 L1（core.md 正文 + 合并后的 Topics 一句话索引）
                                               （若磁盘文件被手改超硬顶，自动回退 projections/ 快照）
       │
[3. L2 闪回前置钩子 (agent/pre-step，仅 l2.enabled=true 时运行)]
       ├─► 提取本轮新增的用户文本消息（过滤已扫描 eventId 与系统注入块）
       ├─► 0 跳种子召回：先跑触发词字面匹配；若未满额且开启本地向量，再用余弦相似度补召回
       ├─► 1 跳关系扩散：顺着种子卡的 links 与同实体标签向外扩一跳，按字符与张数预算截断
       ├─► 同世代去重：过滤当前会话同一压缩世代（epoch）内已投递过的卡片
       └─► 三阶段落账：写 pending → 注入【记忆卡·非用户发言】附件并记 accepted → 更新命中计数并记 committed
       │
[4. 会话运行与压缩探针]
       └─► 若本轮触发了上下文压缩（compress 完成事件），自动推进该会话的 epoch，解锁此前已投递过的卡片
```

### 3.2 关键子系统约定

- **Core / Topic 两阶段写入与自愈（`src/storage/store.mjs`）**
  - 写入流程：校验版本哈希（CAS）与渲染后总字数 → 新内容与旧备份写入 `staging/` → 记 `journal(prepared)` → 记 `journal(committing)` 并逐个原子替换文件 → 记 `journal(committed)` 并清理 `staging/`。
  - 崩溃自愈：进程在任意步骤中断，下次启动会自动扫描未完成的 `journal`，安全回滚或补完提交；若替换前发现目标文件被外部手改，立即中止回滚，绝不覆盖用户手改内容。
- **整理与遗忘的三步受审流（`src/organize/` & `src/forgetting/`）**
  - 插件绝不在后台自动合并或删除卡片，所有整理与遗忘操作都必须经过：**① 分析生成候选 → ② 预览生成带签名摘要（`planDigest`）的不可变计划 → ③ 用户在面板点击确认执行**。
  - **双轨遗忘规则**：`evergreen`（常青）卡片永久免疫衰减；`ephemeral`（短期）卡片按年龄与被调用次数（`useCount`）计算半衰期保持率，用得越多衰减越慢。归档后的冷卡仅退出日常触发池，仍可通过 `memory_search(includeArchived: true)` 随时找回。
- **16 个模型工具分组（仅在 `active` 模式下注册）**
  - **L0 人设卡（2 个）**：`soul_read`、`soul_update`
  - **L1 核心与 L3 专题（8 个）**：`memory_read`、`memory_search`、`memory_append`、`memory_rewrite`、`core_write`、`topic_append`、`topic_create`、`memory_list_topics`
  - **L2 闪回卡（6 个）**：`spark_save`、`spark_read`、`spark_update`、`spark_forget`、`spark_feedback`、`spark_graph`

---

## 4. 参数与配置去哪里查

插件参数分为三层：**宿主基础与功能开关**、**容量预算与水位（`budgets`）**、以及 **源码内部常量**。

### 4.1 第一层：宿主基础与功能开关（`cordis.patch.yml` / 插件设置页）

定义在 `src/plugin/config.mjs:170-218`：

| 参数路径 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `mode` | `"shadow" \| "active"` | `"shadow"` | 运行模式：`shadow` 为只读影子；设为 `active` 才挂载工具与提示词注入 |
| `allowActive` | `boolean` | `false` | 启用 `active` 模式的双重确认开关（`mode: "active"` 时必须设为 `true`） |
| `dataRoot` | `string \| null` | `null` | 业务数据根目录绝对路径（不能与 `stateRoot` 相同或互相嵌套） |
| `stateRoot` | `string \| null` | `null` | 运行状态根目录绝对路径（不能与 `dataRoot` 相同或互相嵌套） |
| `defaultPersona` | `string \| null` | `null` | 默认人设卡名（对应 `personas/<name>.md`）；`null` 表示默认使用 `global` |
| `sessionPersonas` | `Array<{sessionId, persona}>` | `[]` | 会话级人设卡指定列表（优先级最高） |
| `workspacePersonas` | `Array<{workspace, persona}>` | `[]` | 工作区目录绑定的人设卡列表（按最长路径前缀匹配） |
| `l2.enabled` | `boolean` | `false` | 是否开启每轮对话前的 L2 Spark 自动闪回投递 |
| `organize.enabled` | `boolean` | `false` | 是否开启面板「记忆整理」分析、预览与执行功能 |
| `forgetting.enabled` | `boolean` | `false` | 是否开启面板「双轨遗忘」分析、预览与归档功能 |
| `forgetting.policy.baseHalfLifeDays` | `number` | `30` | `ephemeral` 短期卡片的基础半衰期天数 |
| `forgetting.policy.maxHalfLifeDays` | `number` | `240` | 经使用次数加成后的最大半衰期天数上限 |
| `forgetting.policy.archiveScore` | `number` | `0.25` | 保持率低于该分值时进入归档提议名单（范围 `0–1`） |
| `semantic.provider` | `"none" \| "local" \| "api"` | `"none"` | L2 语义补召回方式：`none` 关闭；`local` 使用本地 ONNX 模型 |
| `semantic.minSimilarity` | `number` | `0.55` | 本地语义补召回的余弦相似度门槛（范围 `0.01–1`） |
| `semantic.local.model` | `string` | `"Xenova/bge-small-zh-v1.5"` | 本地向量模型的 HuggingFace 仓库 ID（首次开启时按需下载） |
| `semantic.local.dims` | `number` | `512` | 向量维度（需与模型输出维度一致） |
| `semantic.local.dtype` | `"fp32" \| "fp16" \| "q8"` | `"fp32"` | 模型推理精度（`fp32` 约 91MB；`q8` 约 23MB 速度最快） |
| `semantic.local.cacheDir` | `string` | `""` | 模型缓存路径（留空则存放在 `<stateRoot>/semantic/models`） |
| `semantic.local.mirror` | `string` | `"https://hf-mirror.com/"` | 模型下载镜像站地址 |

### 4.2 第二层：容量预算与水位参数（`budgets.*`）

- **去哪里查定义与默认出厂值**：`src/core/config.mjs:9-27`（`DEFAULT_CONFIG`）
- **去哪里查生产上限与水位派生**：`src/plugin/config.mjs:125-154` 及 `280-285`（`BUDGET_CEILINGS`）
- **水位校验关系**：整体必须满足 `softAt <= targetChars < hardAt < hardCapChars`，以及 `seedCount + linkCount <= maxCards`。

| 路径 | 默认值 | 生产上限 | 作用说明 |
|---|---|---|---|
| `budgets.persona.maxChars` | `12000` | `60000` | L0 人设卡允许的最大字符数 |
| `budgets.core.hardCapChars` | `10000` | 无硬上限 | L1（`core.md` 正文 + 派生专题索引）硬顶字符数，超限拒绝写入 |
| `budgets.core.targetChars` | `8000` | `< hardAt` | L1 整理目标字符数（必须落在软水位与硬水位之间） |
| `budgets.core.softChars` | `7500` | `<= targetChars` | L1 软水位字符数（未显式配置时按 `hardCapChars × softRatio` 自动计算） |
| `budgets.core.hardChars` | `9000` | `< hardCapChars` | L1 硬水位字符数（未显式配置时按 `hardCapChars × hardRatio` 自动计算） |
| `budgets.core.softRatio` | `0.75` | `< hardRatio` | 软水位占硬顶的比例 |
| `budgets.core.hardRatio` | `0.90` | `< 1.0` | 硬水位占硬顶的比例 |
| `budgets.core.cacheLockFallback` | `false` | `boolean` | 磁盘文件被外部手改超硬顶时，是否静默使用 `projections/` 旧快照而不报错 |
| `budgets.spark.maxChars` | `600` | `600` | 单轮 L2 闪回附件允许注入的最大总字符数 |
| `budgets.spark.inlineMaxChars` | `100` | `100` | 单张 Spark 卡内联全文的字符上限（超过此长度只注入卡片摘要 `summary`） |
| `budgets.spark.maxCards` | `5` | `5` | 单轮最多投递几张 Spark 卡 |
| `budgets.spark.seedCount` | `3` | `3` | 0 跳直接命中（字面 + 语义）最多选入几张种子卡 |
| `budgets.spark.linkCount` | `2` | `2` | 1 跳关系扩散最多补充几张关联卡 |

### 4.3 第三层：源码内部硬编码常量（调优与排障查这里）

| 常量名 | 当前值 | 所在文件与行号 | 说明 |
|---|---|---|---|
| `SEAT_HEARTBEAT_MS` | `2000` (2 s) | `src/host/seat.mjs:41` | 多宿主座位文件刷新修改时间的心跳间隔 |
| `SEAT_STALE_MS` | `6000` (6 s) | `src/host/seat.mjs:42` | 座位心跳超时告警阈值（PID 仍存活时不夺权，防止短暂卡顿造成双写） |
| `SEAT_TAKEOVER_MS` | `60_000` (60 s) | `src/host/seat.mjs:45` | PID 存活但心跳停止超 60 秒时，判定为系统 PID 复用并强制接管写权 |
| `SEAT_RELEASE_MS` | `4000` (4 s) | `src/host/seat.mjs:47` | 先启动的宿主退出后，后启动宿主等待多久自动升格为可写 |
| `MAX_KEY_CHARS` | `128` | `src/storage/paths.mjs:29` | Topic key、Scope ID 与 `operationId` 的最大字符长度 |
| `ANALYZE_CANDIDATE_LIMIT` | `1000` | `src/plugin/management.mjs:36` | 单次记忆整理分析扫描的最大候选条数 |
| `SEMANTIC_REBUILD_BATCH` | `20` | `src/plugin/controller.mjs:84` | 面板点击「重建向量」时每批计算向量的卡片张数（批间让出事件循环） |
| `TIMELINE_JOURNAL_SCAN_LIMIT` | `4000` | `src/timeline/index.mjs:28` | 时间线单次按修改时间扫描的最新 journal 文件数上限 |

---

## 5. 状态、审计记录与错误码怎么看、怎么查

### 5.1 审计记录位置与常用查询命令

Shiori 的所有写入操作都留有结构化账本：Core/Topic 变更记在 `<dataRoot>/journal/`，Spark 变更记在 `sparks.json` 的 `ops` 字段，也可直接在 Web 面板「时间线」页查看合并视图。

**常用终端排查命令**：

```bash
# 1. 查当前哪个宿主进程占着写权座位（排查为什么报 HOST_LOCKED）
cat ~/.dsh/shiori-data/.shiori-seats/*.json

# 2. 看最近 5 笔 Core / Topic 写入事务日志
ls -t ~/.dsh/shiori-data/journal/*.json | head -n 5 | xargs tail -n +1

# 3. 查是否有未正常提交（非 committed）的残留事务
grep -rn '"phase":' ~/.dsh/shiori-data/journal/ | grep -v '"committed"'

# 4. 看某个 scope（如 amber）的 Spark 卡片总数与最近 5 次写操作记录
node -e '
  const db = JSON.parse(fs.readFileSync(process.env.HOME + "/.dsh/shiori-data/sparks/scopes/amber/sparks.json", "utf8"));
  console.log("卡片总数:", Object.keys(db.records || {}).length);
  console.log("最近操作:", Object.entries(db.ops || {}).slice(-5));
'

# 5. 看 L2 闪回账本中的会话压缩世代（epoch）与累计投递包数
node -e '
  const hex = Buffer.from("amber", "utf8").toString("hex");
  const l2 = JSON.parse(fs.readFileSync(process.env.HOME + "/.dsh/shiori-state/l2/" + hex + ".json", "utf8"));
  console.log("会话世代:", l2.sessionEpochs, "已投递包数:", Object.keys(l2.committed || {}).length);
'
```

### 5.2 标准错误码（`Error.code`）全量速查字典

Shiori 所有异常均带有稳定的 `error.code` 属性，按场景分类如下：

#### A. 写入冲突、容量超限与参数校验
| `error.code` | 触发原因 | 排障与处理办法 |
|---|---|---|
| `REVISION_CONFLICT` | **乐观锁冲突**：传入的 `expectedRevision`（或候选队列版本号）与磁盘当前版本不一致 | 先重新调用 `memory_read()`、`soul_read()` 或 `spark_read()` 拿到最新 `revision`，再基于新内容重提修改 |
| `BUDGET_REJECTED` / `BUDGET_EXCEEDED` | **字数超硬顶**：写入后完整 L1（`core.md` + 专题索引）超过 `hardCapChars`，或 L0 人设卡超过 `persona.maxChars` | 把 `core.md` 里的长篇实操记录拆进 `topics/` 专题，或在设置里调大 `hardCapChars`（注意同步调整 `targetChars`） |
| `INVALID_INPUT` | **入参不合法**：字段类型不对、传入了未定义的额外字段、尝试在工具参数里传 `scope`、或专题名触碰了 Windows 保留字/特殊字符 | 对照报错信息里的字段名修正参数；专题名不要用 `core`、`CON`/`NUL` 或斜杠等路径字符 |
| `NOT_FOUND` | **目标不存在**：对还不存在的专题调了 `topic_append`，或查询了不存在的 `sparkId` / `planId` | 新建专题必须先调 `topic_create`；查 Spark 卡时确认当前会话所在的人设作用域是否正确 |

#### B. 多宿主锁、挂载模式与权限拦截
| `error.code` | 触发原因 | 排障与处理办法 |
|---|---|---|
| `HOST_LOCKED` | **从属宿主只读保护**：已有更早启动的另一个 DSH 实例（如同时开了 Desktop 和 Web）占着写权座位 | 关掉先启动的那个 DSH 实例，等待约 4 秒后本实例会自动升格为可写；或者直接在先启动的实例上修改 |
| `LOCK_BUSY` | **文件写锁争用超时**：等待 `.shiori-lock` 超过 10 秒仍未拿到锁 | 检查是否有卡死的 Node 进程占着锁；若持锁进程已退出，锁模块会在下次操作时自动接管并把旧锁改名为 `.residue-*` |
| `NOT_CONFIGURED` | **未配置双根路径**：插件还处于默认 `inert` 状态（`dataRoot` 或 `stateRoot` 为空） | 在设置中填好 `dataRoot` 与 `stateRoot` 的绝对路径，并开启 `mode: "active"` 与 `allowActive: true` |
| `UNSUPPORTED` | **功能开关未开或处于只读模式**：在 `shadow` 模式下调了写接口，或未开启 `organize.enabled` / `forgetting.enabled` 就调用了分析与计划接口 | 将 `mode` 切到 `"active"`，并在设置里打开对应的子系统开关 |
| `UNAUTHORIZED` | **受审计划未授权或已过期**：调用 `executePlan` 时缺少面板确认标记，或计划生成后底层卡片已被改过 | 回到面板重新点一次「预览计划」，拿到最新的 `planId` 与 `planDigest` 后再点确认执行 |

#### C. 磁盘状态与文件系统异常
| `error.code` | 触发原因 | 排障与处理办法 |
|---|---|---|
| `INVALID_STATE` | **落盘数据格式损坏**：JSON 账本被截断、文件编码不是合法 UTF-8、或手改专题 Markdown 时破坏了顶部 YAML 头格式 | 看 `error.details.file` 指向哪个文件：若在 `stateRoot` 下可直接删掉该文件让插件自动重建；若在 `dataRoot` 下对照备份修复格式 |
| `IO_ERROR` | **底层文件系统报错**：磁盘满（`ENOSPC`）、目录无写权限（`EACCES` / `EPERM`）等 | 检查磁盘剩余空间与目录权限（原始系统错误码保存在 `error.details.ioCode` 中） |

---

## 6. 高频故障排查速查表（Troubleshooting）

| 现象 | 第一步查什么 | 根因判据与修复办法 |
|---|---|---|
| **修改 `hardCapChars` 后插件启动报错** | 看启动日志里的 `INVALID_INPUT` 提示 | • 报错 `core.targetChars must be < derived hardAt`：因为软硬水位默认按 `hardCapChars × 0.75 / 0.90` 算出，调小硬顶或调大 `targetChars` 时必须保证 `softAt <= targetChars < hardAt < hardCapChars` |
| **面板顶部出现黄条，所有写操作报 `HOST_LOCKED`** | 面板「总览」页看只读诊断，或查 `<dataRoot>/.shiori-seats/` | • 同时运行了两个 DSH 进程（例如 Web 和 Desktop 共用同一个 `shiori-data`）<br>• 关掉先开的那个进程，等 4 秒即可恢复可写；若旧进程早已被强杀但 PID 恰好被系统其它进程复用，等满 60 秒会自动接管（也可手动删掉旧的 seat JSON 文件） |
| **手改了 `core.md`，但对话里还是旧内容** | 打开面板「人设与核心」页看字符水位与告警 | • 手改后的 `core.md` 加上专题索引总字数超过了 `hardCapChars`，触发了 `projections/` 安全快照回退 → 删减字数或调大预算即可恢复<br>• 检查宿主是否同时开启了内置 `dsh-persona` 的 `complete: true` 覆盖了系统提示词段落 |
| **存了 Spark 卡，但提到关键词没触发闪回** | 打开面板「闪回图谱」页看投递记录，或查配置 `l2.enabled` | • 设置里 `l2.enabled` 没开（默认为 `false`）<br>• 这张卡在**当前会话已经投递过一次**（同一压缩世代内不会重复塞同一张卡，等发生上下文压缩或新开会话就会重新触发）<br>• 卡片存进了别的 `scope`（例如存进了 `global`，但当前会话绑定的是 `amber`——Spark 卡在不同人设之间严格隔离，不混投） |
| **开启本地语义召回（`local`）后没有模糊命中** | 打开面板「闪回图谱」页检查语义索引状态 | • 开启开关不会在启动时阻塞计算历史旧卡的向量 → 在面板点击 **「重建向量」** 按钮即可分批补齐<br>• 若模型下载失败，检查 `semantic.local.mirror`（默认 `https://hf-mirror.com/`）在本机网络是否可达 |
| **开发改完代码怎么跑测试和发版前自检？** | 仓库根目录 `package.json` 的 `scripts` | • 跑全套单元测试：`npm test`<br>• 只跑插件与协议层测试：`npm run test:p5`<br>• 发版前检查导出文件与包结构：`npm run verify:package` |
