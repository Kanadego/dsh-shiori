# dsh-shiori 使用指南

> 面向「使用者 + 维护者」：怎么装、怎么配、面板怎么看、工具怎么用、坏了查哪里，以及协作台怎么跑。
> 开发过程见 DEV-REPORT.md；接手写代码见 HANDOFF-TO-AMBER.md。

## 0. 速查

| 我想…… | 怎么做 |
| --- | --- |
| 现在装在哪 | 真 desktop profile：`C:/Users/you/.dsh/profiles/desktop`，依赖 `dist/dsh-shiori-0.1.0-alpha.1.tgz` |
| 记忆存在哪 | `D:/work/shiori/phase6/collab/reviews/desktop-live/data`（业务数据）与 `…/state`（运行账本） |
| 改配置 | profile 的 `cordis.patch.yml` 里 `- id: shiori` 的 `config:` 块；只改预算也可用面板「预算」tab |
| 跑测试 | `npm test`（全量）或 `npm run test:p5`（只插件） |
| 重新打包 | `npm pack` → 拷进 `dist/` |
| 看故障 | §A9 故障速查；日志与账本位置在 §A7、§A9 |

---

# A. 插件使用

## A1 它是什么、现在装在哪

分层记忆插件：L0 人设卡 / L1 core + 派生索引 / L2 Spark 闪回 / L3 topics，外加 organize（整理）与 forgetting（遗忘）。以 DSH 原生 bundle 形式挂载，提供 16 个模型工具、9 个面板 RPC、1 个 Web 面板。

当前部署（2026-10-27）：

| 项 | 值 |
| --- | --- |
| profile | `desktop`（Electron app 专用；CLI 被 `rejectElectronProfile` 拦住，见 §A2） |
| 包 | `dist/dsh-shiori-0.1.0-alpha.1.tgz`（sha256 25f37f0d…），`node_modules/dsh-shiori` 已解包 |
| 配置 | `mode: active` + `allowActive: true` + 两个绝对根 + `defaultPersona: amber` + l2/organize/forgetting 全开 + 自定义 budgets |
| 数据 | `D:/work/shiori/phase6/collab/reviews/desktop-live/data` |
| 状态 | `…/desktop-live/state`（completion-state / l2 / plans / queues / tool-ops / projections） |
| 端口 | 3080 = 日常 web 端（**不要碰**）；3082 = 隔离沙盒 desktop-copy（已拆，需要时重建）；1116 = Electron app 自己的 web 面 |

## A2 安装 / 升级 / 卸载

### 普通 profile（架构同 desktop 但不叫 desktop）

~~~bash
cd D:/work/shiori
npm pack                                   # 产出 dsh-shiori-0.1.0-alpha.1.tgz
dsh plugin --profile <name> add D:/绝对路径/dsh-shiori-0.1.0-alpha.1.tgz
dsh --profile <name> --dump-config          # EXIT=0 且组合树里有 "- id: shiori / name: dsh-shiori"
dsh plugin --profile <name> remove dsh-shiori   # 卸载，数据保留
~~~

安装成功会：profile 的 `package.json` 里 `dependencies.dsh-shiori` 加 `file:…tgz`、`dsh.profile.bundles` 追加 `dsh-shiori`、`node_modules/dsh-shiori` 就位。只有声明了 `dsh.bundle.patch` 的包才会作为 bundle 激活，普通依赖不激活。

### 真 desktop profile 的特殊性

宿主 `lib/bin.js:35-37` 对 profile 名 `desktop` 直接 `program.error('error: profile "desktop" is managed exclusively by the Electron application')`——命令行根本不能 `add/remove`。三条可行路径：

1. 在 Electron app 的插件市场里本地安装 `.tgz`（推荐，app 自带 pnpm runner）；
2. 手动：编辑 `C:/Users/you/.dsh/profiles/desktop/package.json` 的 `dependencies.dsh-shiori` 指向新 tgz，再把 tgz 用 `tar -xzf … --strip-components=1` 解到 `node_modules/dsh-shiori`（**不要跑 pnpm**，pnpm 会把 `sidor-ui / dshmarket` 挪进 `node_modules/.ignored`，装完要手工 `mv` 回来）；
3. 用副本 profile 验证（见下），确认无误再同步真 desktop。

### 升级（不丢数据）

~~~bash
# 1. 打新包
npm pack
# 2. 普通 profile：remove + add；desktop：按上面路径 1 或 2
# 3. 重启宿主（Electron app 要完全退出再开，不是关窗口）
# 4. 验证：面板「状态」tab 的 generation 递增、mode active；或 --dump-config
~~~

### 隔离验证副本（不改真 desktop）

复制 `desktop` 的 `package.json / pnpm-lock.yaml / pnpm-workspace.yaml / cordis.yml / cordis.patch.yml` 到 `desktop-dumpcheck`，把 `node_modules` 做成 junction 指向原目录，临时把 `dataRoot/stateRoot` 指到测试目录，然后 `dsh --profile desktop-dumpcheck --no-open --port 3083`。验证完删副本（junction 用 `cmd /c rmdir` 删，别递归删）。

### 与 dsh-soul-md 冲突

两者都提供 9 个同名工具（soul_read / memory_append 等），宿主「工具唯一提供者」校验会直接拒绝。**不要同时启用**：先停用 soul-md，或换独立 profile。

## A3 配置参数

配置在 profile 的 `cordis.patch.yml`：

~~~yaml
- id: shiori
  name: dsh-shiori
  config:
    mode: active
    allowActive: true
    dataRoot: 'D:/work/shiori/phase6/collab/reviews/desktop-live/data'
    stateRoot: 'D:/work/shiori/phase6/collab/reviews/desktop-live/state'
    defaultPersona: amber
    l2:
      enabled: true
    organize:
      enabled: true
    forgetting:
      enabled: true
    budgets:
      core: { targetChars: 14000, hardCapChars: 20000, softRatio: 0.6, hardRatio: 0.9 }
~~~

### 顶层参数

| 键 | 默认 | 规则与说明 |
| --- | --- | --- |
| `mode` | `shadow` | `shadow` 只读影子；`active` 才注册工具、写数据、装配 L0/L1 |
| `allowActive` | `false` | `mode: active` 时必须显式 `true`，否则 INVALID_INPUT |
| `dataRoot` | `null` | 业务数据根（绝对路径）。与 stateRoot **互不嵌套** |
| `stateRoot` | `null` | 运行状态根（绝对路径） |
| `ownerId` | `local` | 可信单用户标识；模型不可传。completion 文件名为 `shiori-plugin-<ownerId>` |
| `defaultPersona` | `null` | 默认人设卡名；`null` = global 记忆 |
| `sessionPersonas` | `[]` | `[{sessionId, persona}]`，优先级最高 |
| `workspacePersonas` | `[]` | `[{workspace: 绝对路径, persona}]`，按最长路径边界匹配 |
| `budgets` | 见下 | **volatile** 字段：面板保存是热提交，但插件用启动快照，**重启/重载后生效** |
| `l2.enabled` | `false` | Spark 自动投递总开关 |
| `organize.enabled` | `false` | 整理（候选/计划/执行）开关 |
| `forgetting.enabled` | `false` | 遗忘开关；显式 `includeArchived` 冷检索不受此开关限制 |
| `forgetting.policy` | `30 / 240 / 0.25` | baseHalfLifeDays / maxHalfLifeDays / archiveScore |

根目录铁律：两个根都 `null` 且 `shadow` ⇒ **inert 挂载**（只给 needs-configuration 诊断，不读写任何文件）；一旦给了任一根本或 `mode: active`，两个根都必须显式给且绝对、互不嵌套（会给盘符根单独保护）。

### budgets（10 个数字）

| 字段 | 默认 | 上限 | 含义 |
| --- | --- | --- | --- |
| `core.targetChars` | 8000 | 无 | L1 软目标；超过后提示压缩 |
| `core.hardCapChars` | 10000 | 无 | L1 硬上限；超过则用 last-valid，没有就输出英文诊断占位 |
| `core.softRatio` | 0.75 | — | 软阈值占比：softAt = floor(hardCap × softRatio) |
| `core.hardRatio` | 0.90 | — | 硬阈值占比：hardAt = floor(hardCap × hardRatio) |
| `core.cacheLockFallback` | false | — | 锁失败时的降级开关 |
| `persona.maxChars` | 12000 | 12000 | 人设卡正文长度上限（UTF-16 码元） |
| `spark.maxChars` | 600 | 600 | 单次投递附件总长度 |
| `spark.inlineMaxChars` | 100 | 100 | 单卡正文 ≤ 此值内联全文，否则只给摘要 |
| `spark.maxCards` | 5 | 5 | 单次投递最多卡片（种子 + 关联） |
| `spark.seedCount` | 3 | 3 | 触发词命中的种子上限 |
| `spark.linkCount` | 2 | 2 | 1 跳关联上限 |

关系必须同时满足：`0 < softRatio < hardRatio < 1`；`softAt ≤ targetChars < hardAt < hardCapChars`；`inlineMaxChars ≤ maxChars`；`seedCount + linkCount ≤ maxCards`。任一不满足直接 INVALID_INPUT，整份配置不生效（不做部分提交）。

> 为什么本机把 core 抬到 14000/20000：从 soul-md 迁入后 core 9,645 字符 + 36 条索引 = L1 约 12,397 字符，超过旧 hardCap 10000 就会整段变占位符。

## A4 面板怎么用

入口：插件管理器 → `dsh-shiori` 详情页（宿主槽位 `plugins.bundle.config`）。五个 tab：

| tab | 内容 | 说明 |
| --- | --- | --- |
| 状态 | mode / scope / ownerId / generation / started / 占用与能力 / diagnostics | 判断「插件是否真的在跑」的第一现场 |
| 记忆 | L0 人设卡全文、L1 渲染（core + 索引）、占用字符 | 预览的是模型真实看到的内容 |
| 图谱 | Spark 卡片节点与边，可拖拽缩放、点开详情、CAS 编辑 | 超过 30 张卡时布局会变密 |
| 候选 / 计划 | analyze organize / analyze forgetting、候选列表、reviewed / dismissed、preview / 执行、plans 列表 | 合并记忆的主战场，见下 |
| 预算 | 10 个中文字段（含参数名与上限提示） | 空输入=不改；非法值中止整批；保存后需重启生效 |

### 会话选择（所有 tab 共用）

- 下拉显示会话标题，没有标题回落到 sessionId；子代理会话、已归档会话、空壳会话（`blank:true`）都会被过滤，**当前会话即使空壳也保留**。
- 打开面板时最多探测前 5 个候选会话的 `getStatus`，遇到宿主不可用（写句柄被占用等）自动跳过并给出中文提示；全部不可用时不发任何数据请求。
- 会话下拉第一次没拿到列表时会自动重试 3 次（300ms / 900ms 退避）；仍失败才退回手填输入框，并给「刷新」按钮。

### 合并 Memory 的三步（cluster 候选才有「合并进主题」按钮）

1. 候选 tab 点 `analyze organize`，cluster 行出现「合并进主题」；
2. 点开后就地展开合并卡：选一个已有主题（必须**非 legacy**）或新建主题（key / 标题 / 摘要），点「创建并选择」；
3. 选定目标后才会出现合并表单和「预览 diff（previewPlan）」，确认 diff 与 `changedItems` 后点「确认执行」。执行后 8 张源卡变 `state: merged`，主题正文末尾自动追加源保全块。

### 计划与状态徽章

`待执行 / 已执行 / 已作废`（open / executed / superseded）。已执行的计划不能重复预览或执行；想再整理请重新 analyze。

## A5 模型侧 16 个工具

| 工具 | 作用 | 必填 | 注意 |
| --- | --- | --- | --- |
| `soul_read` | 读当前 scope 人设卡 | — | 返回 exists/正文/revision |
| `soul_update` | 整卡替换 | content | CAS；带新正文前先 soul_read |
| `memory_read` | 无参=渲染 L1；带 topic=该主题全文 | — | scope 不可传，由宿主固定 |
| `memory_search` | 主题词法检索（只回 key/title/summary） | query | 最多 20 条；可 `includeArchived` |
| `memory_append` | 往 core 或某主题追加带日期小块 | section、content | 最常用；带 operationId 可重放 |
| `memory_rewrite` | 整段替换 core 或某主题正文 | content | 主题 front-matter 由服务保留 |
| `core_write` | 只替换磁盘 core 正文（无派生索引） | content、expectedRevision | expectedRevision 用 memory_read 的 token |
| `topic_append` | 追加到指定主题 | topic、section、content | 主题不存在会报错，先用 topic_create |
| `memory_list_topics` | 列主题（含 revision token） | — | 合并/编辑前拿权威 token |
| `topic_create` | 新建主题 | topic、title | 已存在返回 alreadyExists |
| `spark_save` | 存 Spark 卡 | content、title、triggers | triggers 必填（空数组=不唤醒）；内容/摘要/触发词有长度上限 |
| `spark_read` | 读卡 | id | 可读归档卡 |
| `spark_update` | 改卡（含 links） | id + 变更字段 | links 的 target 必须在库内 |
| `spark_forget` | 归档 / 被替代 | id、mode | 物理不删卡 |
| `spark_feedback` | 标记「用了」 | id、used | used=true 会抬半衰期 |
| `spark_graph` | 图谱 | — | 只读 |

所有写工具都收 `operationId`（幂等键）：同 id 重试返回首次结果，不会重复写。

## A6 记忆机制（知道这些才能判断「为什么没生效」）

### 选卡优先级

`sessionPersonas`（精确 sessionId）> `workspacePersonas`（绝对路径最长边界匹配，前缀边界不会把 `D:/a` 匹配到 `D:/ab`）> `defaultPersona` > `global`。工作区路径取宿主的 `workingDirectory` 投影（不是 `session.header.cwd`），会话中途换目录会换 scope。

### L0 / L1

- L0 = 人设卡正文，写入超过 `persona.maxChars` 直接被拒。
- L1 = core 正文 + 由 topics 派生的目录索引（`- key [scope] — summary`），每轮注入。
- 超过 `hardCapChars`：先用 `stateRoot/projections` 里的 last-valid；没有 last-valid 就输出英文诊断占位——**绝不截断规则**。
- 宿主如果启用 `complete: true` 的 section（如 dsh-persona 的 minimal 预设），宿主会在 waterfall 前快照、之后强制回填，本包的 L0/L1 改写必被丢弃。插件启动时探测到这种情况就**零注册**，diagnostics 里报 `completeShadowed` 与 `l0l1Effective: false`（探测不可判定时报 `"unknown"`，不谎报 true）。

### L2 投递时序（为什么有时「提到了却没投」）

1. 每次模型调用前（`agent/pre-step`），只看 `role=user` 且 `source.kind=user` 且未 scanned 的人类消息（插件注入、子代理报告、历史都不扫）；
2. 用消息正文跑确定性匹配：触发词命中做 0 跳种子（≤ seedCount），再沿显式 links → entities 扩一跳（entity 在可见 active 卡里出现 > 5 次视为泛化标签，不扩散；关联 ≤ linkCount）；总数 ≤ maxCards；
3. 组装一条独立附件消息（`source.kind=shiori-sparks`，form=recall），先写 pending 账再追加到历史；
4. 宿主真正把它写入会话后回 `user/message` 事件，且 `event.data.id == 我们的 message.id` 才算 accepted，随后 store 记 hit（hitCount+1）、记 hits 账、写 seen、置 committed；
5. 崩溃恢复会回查会话日志补 accepted，不重复发送。

匹配规则细节：字面匹配（不做语义/同义词）、NFC 归一化、英文大小写折叠；纯 ASCII 单词按词边界（`cat` 不命中 `concatenate`），含空格/中文等按子串；同一张卡取最长命中的触发词。

**seen 冷却**：键是 `spark:seen:<scope>:<session>:<epoch>:<id>:<revision>`。同一会话同一 epoch 内同一张卡只投一次；**压缩成功后 epoch + 1，旧冷却全部失效**，所以压缩后同一张卡可以再出现。

### L3 topics

每个主题一个文件，front-matter 存 key/title/summary/updated/scopeId，正文随意。不占提示词预算，只在索引里占一行，模型需要时 `memory_read(topic)` 取全文。

### organize（整理）

三类候选：`cluster`（同一实体/触发词下 ≥ 8 张唯一卡）、`isolated`（active 但入出度皆 0）、`link`（共享词且两卡之间还没有任一方向链接）。执行后队列收敛（旧候选会被清掉），计划不可变，`executePlan` 只认 owner 面板当前会话 + digest + `confirmed`；stop / 断连 / 换卡即撤销授权。合并目标如果是 legacy 主题（`updated: "legacy-unknown"`）会被拒——就地新建主题再合并。

### forgetting（遗忘）

`score = 2^(-elapsedDays / halfLifeDays)`，半衰期 `min(base × 2^useCount, max)`（默认 30 → 240 天）。归档资格四条全满足：`state=active` ∧ `vitality=ephemeral` ∧ `supersedes 为空` ∧ 距 `lastUsedAt ?? createdAt` ≥ 60 天且 score < archiveScore(0.25)。恰 60 天 score 正好 0.25 **不算**，61 天才归档。`spark_feedback(used:true)` 会续命。冷库检索（`includeArchived`）不受开关限制。

## A7 数据与状态文件

~~~
<dataRoot>/
  persona/<scope>.md                    人设卡（本机 amber.md）
  scopes/<scope>/core.md                L1 正文（人格/规则/待办）
  scopes/<scope>/topics/<key>.md        L3 专题（front-matter + 正文）
  scopes/global/…                       global 记忆（无人设卡时）
  sparks/scopes/<scope>/sparks.json     Spark 卡片库（cards/ops/feedback/generation）
  journal/                              跨目录事务日志
  staging/                              事务暂存
  state/                                当前 scope 指针等（dataRoot 内的状态投影）

<stateRoot>/
  tool-ops/<hex>.json                   工具 operationId 重放账
  l2/<hex>.json                         L2 账：scanned/pending/accepted/committed/seen/hits/sessionEpochs
  plans/<hex>.json                      organize/forgetting 计划账（不可变）
  queues/<hex>.json                     候选队列快照
  analyze-ops/<hex>.json                analyze 幂等账
  projections/<hex>.json                last-valid L1 等投影
  completion-state-shiori-plugin-local.json   压缩探针水位/epoch/seen（含 pid）
  completion-lock-shiori-plugin-local.json    单写者锁（含 pid / ownerToken）
~~~

`<hex>` 是 scopeId 的 UTF-8 hex：本机 `amber` = `616d626572`；`global` = `676c6f62616c`。

读这些文件判断状态：

- 插件到底起没起：`completion-lock-*.json` 的 pid 是否是当前宿主进程；
- L2 有没有投递：`l2/<hex>.json` 的 pending/accepted/committed 与 `seen`；
- 压缩有没有被识别：`completion-state-*.json` 的 `epoch`、`compressSeenIds`、`watermarks`、`lastAdvance.blocksCreated`；
- 某次工具调用是否落盘：`tool-ops/<hex>.json` 的 operations 键。

## A8 日常维护

**备份**（数据 + 状态一起，缺一不可）：

~~~bash
cd D:/work/shiori/phase6/collab/reviews
tar -czf desktop-live-backup-$(date +%Y%m%d%H%M%S).tar.gz desktop-live/data desktop-live/state
~~~

**清空测试数据**：先停宿主，备份，然后只删两个目录内容（保留目录本身）。scope 目录会被自动重建。

**迁到新机器**：拷 `data`+`state` 两个目录 → 装包 → 写同样配置（根目录改成新路径）→ 启动。`completion-lock` 里是旧 pid，会被自动判定失效；有 `.residue-*` 残留可忽略。

**从 dsh-soul-md 迁入**：参考 `phase6/collab/reviews/migrate-soul-md/migrate.mjs`：把 soul-md 的人设卡正文写成 `persona/<scope>.md`，core 写成 `scopes/<scope>/core.md`，`topics/*.md` 加 shiori 的 front-matter（key/title/summary/updated/scopeId）。**迁完必须抬高 budgets.core**，否则 L1 超 hardCap 会变占位符。

**批量改卡/加卡**：不要手改 `sparks.json`。写一个 node 脚本调插件自己的 store：
`openSparkStore({root:'<dataRoot>', scopeId:'<scope>'})` → `store.save({...},{operationId})` / `store.update(id,{...})` / `store.forget(id,{mode:'archive'})`。脚本样例：`phase6/collab/reviews/sparks-curate/curate.mjs`。

**换人设卡**：改配置 `defaultPersona` 或加 `sessionPersonas` / `workspacePersonas`，重启生效。人设卡文件在 `dataRoot/persona/<name>.md`。

## A9 故障速查

先看三个地方：**面板「状态」tab 的 diagnostics**、**`stateRoot` 下的 completion-state / l2 账**、**宿主日志（Electron app 日志或 `dsh --profile … --no-open` 的输出）**。

| 症状 | 最可能原因 | 查哪里 / 怎么办 |
| --- | --- | --- |
| 插件列表没有 / 面板 404 / 面板显示「shadow 模式——数据界面停用」 | 插件没激活：启动时抛错、或配置已是 shadow/inert | 看宿主日志有没有 shiori 报错（历史案例：`cannot get property "typert" without inject`）；`cordis.patch.yml` 是否 `mode: active` + `allowActive: true` + 两根齐全 |
| 面板整块空白 | 前端渲染抛错（历史：读 `diagnostics.some` 崩） | 浏览器控制台（`F12`）；换版本或回报 owner |
| 每个 tab 都顶一行红字 | 会话被宿主标不可用（写句柄被占用） | 换一个会话；或看提示里的 code：`session/writer-held` / `session/agent-busy` |
| 会话下拉变成手填框 | `remote.session` 未就绪 / `session.list` 瞬时失败 | 点「刷新」（已内置 3 次重试）；仍失败就整页刷新 |
| `[INVALID_STATE] 候选已 reviewed` | 重复点 reviewed/dismissed | 重新 analyze 生成新一轮候选 |
| `REVISION_CONFLICT` | 卡/主题/计划被外部改过，revision 过期 | 重新 `memory_read` / `memory_list_topics` 取新 token |
| `LOCK_BUSY` / `live owner or unknown lock content` | 同一 DSH_HOME 有第二个宿主（web + app）持有写句柄 | 只留一个宿主；残留锁手工确认后删 |
| `UNSUPPORTED module is disabled…` | l2 / organize / forgetting 开关没开 | 改配置重启 |
| `plan "…" was already executed` | 计划不可重复执行 | 重新 analyze → preview 新计划 |
| `legacy topics remain read-only` | 目标是 legacy 主题 | 新建主题再合并 |
| 面板 `l0l1Effective: "unknown"` 或 `false` | 宿主有 complete 预设（如 dsh-persona minimal），本包 L0/L1 被宿主回填覆盖 | 属如实诊断：想让人设卡进提示词，就让 persona 由本包管理（别同时开对方的 complete 预设） |
| 图标不显示 | 图标超 256KB、格式不支持、`files` 没打包 | `icon.png` 必须 ≤ 256×1024 字节上限、png/jpg/webp/svg |
| 预算改了没效果 / 保存没反应 | 数值非法（如比率填 1.2）；或只热提交，未重启 | 空输入=不改；保存成功会有「已保存…」；**重启/重载后生效** |
| Spark 明明提到却不投递 | L2 关；触发词是字面匹配但说法不同；已 seen；被实体泛化阈值挡掉 | 查 `l2/<hex>.json` 的 seen 与 hits；触发词加同义说法；压缩后 epoch 会重置冷却 |
| 工具报 `tool ownership conflict … soul-md` | 与 dsh-soul-md 同装，9 个同名工具冲突 | 停用 soul-md |
| 插件没反应但没报错 | 看 `completion-lock` 的 pid 是不是还活着；宿主重启后锁未释放会自愈 | 删 `*.residue-*` 不影响运行 |

面板不灵时可以直接在浏览器里打宿主 RPC 看真实返回（cookie 认证已就绪）：

~~~js
// 在 app / 3082 页面控制台
await (await fetch('/api/shiori/getStatus', {
  method: 'POST',
  headers: {'content-type': 'application/json'},
  body: JSON.stringify({type:'client-request', rpcId: crypto.randomUUID(),
    method:'shiori/getStatus', payload:{args:{sessionId:'<id>', payload:{}}}})
})).json()
~~~

（`executeTool` 的 payload 是 `{name, args}`，不是 `input`。）

---

# B. 协作台（phase6/collab）

## B1 它是什么

P5 的双槽实现流水线：owner 定义任务与白名单 → 外部 agent（ZCode P/Q）在各自工作副本实现 → 提交不可变封包 → owner 独立复现后 accept/rework。核心文件：

| 文件 | 作用 |
| --- | --- |
| `board.mjs` | 状态机 CLI（status/claim/submit/verify/review/wait/reopen/init） |
| `state/board.json` | 唯一状态源（tasks、events、updatedAt） |
| `task-definitions.json` | 每槽 allowed 白名单 |
| `BASELINE.json` | 144 个冻结文件的 sha256（不可改、不可删） |
| `CONTRACTS.md` | 公共契约（settings 形状、工具、RPC、L2 规则） |
| `work/P`、`work/Q` | 各槽工作副本（agent 只在这写） |
| `submissions/<slot>/<id>/files` | 提交封包（只读，永不修改） |
| `tasks/P.md`、`tasks/Q.md` | 人读任务书 |
| `reviews/` | 返工单、验收单、实机报告、owner 复现脚本 |

## B2 一轮任务的完整流程

~~~bash
cd D:/work/shiori
node phase6/collab/board.mjs status                       # 看当前状态
node phase6/collab/board.mjs claim  --slot P --agent zcode-P   # 领取（ready→working）
node phase6/collab/board.mjs wait   --slot P --agent zcode-P --seconds 50  # 可选：等外部开工
node phase6/collab/board.mjs submit --slot P --agent zcode-P   # 封包 → submitted
node phase6/collab/board.mjs verify --slot P              # 校验封包与白名单
# owner 审完：accept 或 rework（feedback 文件必须在 collab/reviews 下，≥40 字符）
node phase6/collab/board.mjs review --slot P --decision rework --feedback "D:/work/shiori/phase6/collab/reviews/P-a2-owner-rework.md"
node phase6/collab/board.mjs review --slot Q --decision accept --feedback "D:/work/shiori/phase6/collab/reviews/Q-a6-owner-accept.md"
~~~

状态流：`ready → working → submitted → accepted | rework →（rework 时 attempt+1）→ working…`。`reopen` 是 owner 专用（把 accepted/rework 退回 ready 并 attempt+1）；**不要**在 agent 正在 working 时 reopen。

## B3 规则（写死在 board.mjs 里）

- **只改白名单**：`submit` 扫描工作副本，发现「不在 allowed 且不在冻结基线」的文件直接拒绝；
- **冻结基线不可动**：144 个文件可改内容但不可删；哈希不符且有删除即报错；
- **只封变化字节**：提交只包含与基线不同的文件；
- **封包不可变**：每次 submit 生成新的 `a<N>-<uuid>` 目录，旧封包永不修改；
- **attempt 递增**：rework 后 `attempt` +1，agent 下一轮必须在新 attempt 上提交；
- **不能自 accept**：accept/rework 只有 owner 能做；agent 也不能扩白名单（需要 owner 改 `task-definitions.json` 并记 `allowed-amended` 事件）。

## B4 命令参考

| 命令 | 参数 | 说明 |
| --- | --- | --- |
| `status` | — | 打印任务、attempt、submission、feedback 路径、updatedAt |
| `init` | — | 从 `task-definitions.json` 初始化看板（会重置，慎用） |
| `claim` | `--slot` `--agent` | ready → working |
| `submit` | `--slot` `--agent` | working → submitted，写封包 + manifestHash |
| `verify` | `--slot` | 重算封包，返回 ok/files/root |
| `wait` | `--slot` `--agent` `--seconds` | 轮询等待状态变化 |
| `review` | `--slot` `--decision accept\|rework` `--feedback` | 判定；rework 复制 feedback 进 reviews/`r-uuid`.md |
| `reopen` | `--slot` `--reason` | owner 专用，退回 ready |

## B5 证据去哪找

- 判定依据：`reviews/`owner 名字`-owner-{accept,rework}.md`；
- 每轮返工单：`reviews/P-aN-owner-rework*.md` / `Q-aN-owner-rework.md`（含机制行锚与复现命令）；
- 实机：`reviews/P5-live-verification-20261026.md`（七轮，含每条缺陷的行号与磁盘证据）；
- owner 复现脚本：`reviews/*-audit/scratch/*.mjs`、`reviews/*-audit/repro-*.mjs`；
- 提交原文：`submissions/P|Q/`attempt-id`/files`。

## B6 owner 审核清单（可复用）

1. 自建候选树（冻结基线 + 提交文件），自己跑 `node --test test/plugin/*.test.mjs` 与 `npm test`；
2. 逐条重跑返工单里声称修好的缺陷（写自己的 repro，不跑对方的脚本）；
3. mutation 验证：把旧实现换回去，确认新测试会红（防「测试跟着实现一起改」）；
4. 真机点检：装进隔离 profile → CDP 点面板 → 读磁盘；
5. 检查 REPORT/RESULT 的诚实度（not-run 项、synthetic 与真实的区分、数字与命令对得上）。

---

# C. 注意事项（都是踩过的）

1. **PowerShell 没有 `tail`**，用 `Select-Object -Last N`。
2. **不要用 bash heredoc 嵌 python 改中文长文件**（曾把 HANDOFF.md 截断到 1,276 字节）。改长文件用 `tools.write` 写一个 `.mjs` 脚本再 `node` 执行。
3. **不要直接改 `sparks.json` / `core.md` 之外的结构**：卡库有 generation CAS，手改会和运行中的宿主冲突。
4. **删带 junction 的目录不能 `rm -rf`**（会穿透删掉真实 node_modules）：用 `cmd /c rmdir` 先删链接，或用「遇到 symlink 只 unlink」的脚本。
5. **`node --test test/plugin/`（目录形式）在 Node 24 Windows 会报 Cannot find module**，必须用 glob。
6. **git-bash 的 `tar` 不认 `D:/…`**，要写 `/d/…`。
7. **大文件 `read` 默认 2000 行会静默截断**，改长文件一律用 `edit` 或分块写。
8. **3080 是日常 web 端，别动**；要调试就用 `desktop-copy` 副本 + 3082/3083。
9. **Electron app 独占 `desktop` profile**，CLI 不能 add/remove；app 运行时 node_modules 也可能被锁。
10. **面板预算保存是 volatile**：热提交但插件用启动快照，**必须重启/重载**才生效。
11. **面板里点保存要真实提交**：`el.click()` 在表单上不触发 submit，测试脚本要用真实鼠标事件或 `form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`。
12. **CDP 里改 `select` 不能 `el.click()`**：用 `HTMLSelectElement.prototype` 的 value setter + `change` 事件。
13. **触发词是字面匹配**，别指望同义词；单个英文词会按词边界，中文按子串。
14. **`dataRoot` 是真实记忆**：任何清空/迁移前先备份，`desktop-live` 目录不要提交进 git。
15. **协作台不是 git**：提交是封包不是分支；不要指望 `git status` 反映别人的工作。
