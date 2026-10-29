# dsh-shiori 使用指南

> 面向使用与维护：怎么装、怎么配、面板怎么看、工具怎么用、坏了查哪里。

## 0. 速查

| 我想…… | 怎么做 |
| --- | --- |
| 装上 | `dsh plugin --profile <名称> add dsh-shiori` |
| 看它是不是真在跑 | 面板「状态」tab：五条中文摘要 + 能力标记 |
| 改配置 | profile 的 `cordis.patch.yml` 里 `- id: shiori` 的 `config:` 块；只改预算也可以用面板「预算」tab |
| 记忆存在哪 | `dataRoot`（记忆本身）与 `stateRoot`（运行账本），两个都要备份 |
| 跑测试 | `npm test`（全量）或 `npm run test:p5`（只插件层） |
| 重新打包 | `npm pack` |
| 出故障 | §8 故障速查；日志与账本位置见 §6、§8 |

---

## 1. 安装 / 升级 / 卸载

本插件是 DSH 原生 bundle：包内声明了 `dsh.bundle.patch`（`cordis.patch.yml`），`dsh plugin` 安装后自动作为 bundle 挂载，不需要手改宿主配置。

### 从 npm 安装（推荐）

~~~bash
dsh plugin --profile <名称> add dsh-shiori
dsh --profile <名称> --dump-config      # EXIT=0，且组合树里有 "- id: shiori / name: dsh-shiori"
~~~

### 从本地包或源码安装

~~~bash
npm pack                                                # 产出 dsh-shiori-<版本>.tgz
dsh plugin --profile <名称> add /绝对路径/dsh-shiori-<版本>.tgz
~~~

安装会做三件事：profile 的 `package.json` 里加依赖、`dsh.profile.bundles` 追加 `dsh-shiori`、把包装进 `node_modules/dsh-shiori`。只有声明了 `dsh.bundle.patch` 的包才会被激活，普通依赖不会。

### 前置条件

- Node `>=24`，DSH `>=0.2.1-rc.2 <0.3.0`，`pnpm` 在 PATH 上（`dsh plugin` 把参数转发给 profile 内的 pnpm）。
- 与 `dsh-soul-md` **不能同时启用**：两者都提供 `soul_read` / `memory_append` 等 9 个同名工具，宿主的工具唯一提供者校验会直接拒绝。停用其中一个，或换独立 profile。

### `desktop` profile 的特殊性

宿主把名为 `desktop` 的 profile 交给 Electron 应用独占管理，命令行不能对它 `add` / `remove`。三条可行路径：

1. 在应用内的插件市场里本地安装 `.tgz`（应用自带 pnpm runner）；
2. 手动改 profile 的 `package.json` 依赖指向新包，再把包解到 `node_modules/dsh-shiori`（不要对它跑 pnpm，可能会把别的插件挪进 `.ignored`）；
3. 先复制一个副本 profile 验证，确认无误再同步。

### 升级（不丢数据）

~~~bash
npm pack                       # 或直接 dsh plugin add 新版本
dsh plugin --profile <名称> remove dsh-shiori
dsh plugin --profile <名称> add <新包>
# 重启宿主（Electron 应用要完全退出再开，不是关窗口）
~~~

升级后到面板「状态」tab 看 generation 是否递增、mode 是否 active。记忆数据在 `dataRoot` / `stateRoot`，升级不会碰。

### 卸载

~~~bash
dsh plugin --profile <名称> remove dsh-shiori
~~~

只移除包与挂载，记忆数据原样保留。插件不会替你删任何数据。

## 2. 配置参数

配置在 profile 的 `cordis.patch.yml`：

~~~yaml
- id: shiori
  name: dsh-shiori
  config:
    mode: active
    allowActive: true
    dataRoot: 'D:/memory/data'
    stateRoot: 'D:/memory/state'
    defaultPersona: main
    l2:
      enabled: true
    organize:
      enabled: true
    forgetting:
      enabled: true
    budgets:
      core: { targetChars: 10000, hardCapChars: 14000, softRatio: 0.7, hardRatio: 0.9 }
~~~

### 顶层参数

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `mode` | `shadow` | `shadow` 只读影子；`active` 才注册工具、写数据、装配 L0/L1 |
| `allowActive` | `false` | `mode: active` 时必须显式 `true`，否则 INVALID_INPUT |
| `dataRoot` | `null` | 业务数据根（绝对路径），与 `stateRoot` 互不嵌套 |
| `stateRoot` | `null` | 运行状态根（绝对路径） |
| `ownerId` | `local` | 可信单用户标识，模型不可传 |
| `defaultPersona` | `null` | 默认人设卡名；`null` = 用 `global` 记忆 |
| `sessionPersonas` | `[]` | `[{sessionId, persona}]`，优先级最高 |
| `workspacePersonas` | `[]` | `[{workspace: 绝对路径, persona}]`，按最长路径边界匹配 |
| `budgets` | 见下 | **volatile** 字段：面板保存是热提交，但插件用启动快照，**重启/重载后生效** |
| `l2.enabled` | `false` | Spark 自动投递总开关 |
| `organize.enabled` | `false` | 整理（候选 / 计划 / 执行）开关 |
| `forgetting.enabled` | `false` | 遗忘开关；显式 `includeArchived` 的冷检索不受它限制 |
| `forgetting.policy` | `30 / 240 / 0.25` | baseHalfLifeDays / maxHalfLifeDays / archiveScore |

**根目录铁律**：两个根都 `null` 且是 shadow ⇒ inert 挂载（只报 `needs-configuration`，不读写任何文件）；一旦给了任一根或开了 active，两个根都必须显式给、绝对、互不嵌套（盘符根单独保护）。

### budgets（十个数字）

| 字段 | 默认 | 上限 | 含义 |
| --- | --- | --- | --- |
| `core.targetChars` | 8000 | — | L1 软目标，超过后提示压缩 |
| `core.hardCapChars` | 10000 | — | L1 硬上限，超过改用上次可用投影 |
| `core.softRatio` | 0.75 | — | softAt = floor(hardCap × softRatio) |
| `core.hardRatio` | 0.90 | — | hardAt = floor(hardCap × hardRatio) |
| `core.cacheLockFallback` | false | — | 锁失败时的降级开关 |
| `persona.maxChars` | 12000 | 60000 | 人设卡正文长度上限（UTF-16 码元） |
| `spark.maxChars` | 600 | 600 | 单次投递附件总长度 |
| `spark.inlineMaxChars` | 100 | 100 | 单卡正文 ≤ 此值内联全文，否则只给摘要 |
| `spark.maxCards` | 5 | 5 | 单次投递最多卡片（种子 + 关联） |
| `spark.seedCount` | 3 | 3 | 触发词命中的种子上限 |
| `spark.linkCount` | 2 | 2 | 一跳关联上限 |

关系必须同时满足：`0 < softRatio < hardRatio < 1`、`softAt ≤ targetChars < hardAt < hardCapChars`、`inlineMaxChars ≤ maxChars`、`seedCount + linkCount ≤ maxCards`。任一不满足直接 INVALID_INPUT，**整份配置不生效**（不做部分提交）。

## 3. 面板怎么用

入口：插件管理器 → `dsh-shiori` 详情页（宿主槽位 `plugins.bundle.config`）。六个 tab：

| tab | 内容 | 说明 |
| --- | --- | --- |
| 状态 | 五行中文摘要（运行模式 / 作用域 / 服务启动 / 人设卡占用 / 记忆核心占用）+ 能力标记；原始字段在「技术细节」折叠区 | 判断「插件是否真的在跑」的第一现场 |
| 记忆 L0/L1 | L0 人设卡全文、L1 渲染（core + 索引）、占用字符，两层都可就地编辑 | 预览的是模型真实看到的内容；L1 编辑框里是磁盘正文，保存带 revision 校验 |
| 图谱 | Spark 卡片节点与边，拖拽平移、滚轮缩放、点开详情；卡片内容与连线都能改 | 卡多时布局会变密；连线改动可「撤销修改」 |
| 候选 / 计划 | 跑 analyze、候选列表、reviewed / dismissed、preview / 执行、计划列表 | 合并记忆的主战场，见下 |
| L3 / topic | 专题列表（默认只显示 key / 标题 / 字数），展开读正文、整篇编辑保存 | 旧版写入的专题只读 |
| 预算 | 十个中文字段（带参数名与上限提示） | 空输入=不改；非法值中止整批；保存后需重启生效 |

### 会话选择（所有 tab 共用）

- 先选工作区、再选会话：工作区下拉显示标题与「N 个会话」，会话下拉只列该工作区的；当前会话始终保留。
- 下拉显示会话标题，没有标题回落到 sessionId；子代理会话、归档会话、空壳会话都会被过滤，**当前会话即使空壳也保留**。
- 打开面板时最多探测前 5 个候选会话的 `getStatus`，遇到宿主不可用（写句柄被占用等）自动跳过并给中文提示；全部不可用时不发任何数据请求。
- 会话下拉第一次没拿到列表会自动重试 3 次（300ms / 900ms 退避）；仍失败才退回手填框，并给「刷新」按钮。

### 合并记忆的三步（只有 cluster 候选有「合并进主题」）

1. 候选 tab 点 `analyze organize`，cluster 行出现「合并进主题」；
2. 展开合并卡：选一个已有专题（必须**非 legacy**）或新建专题（key / 标题 / 摘要），点「创建并选择」；
3. 选定目标后才出现合并表单与「预览 diff」，确认 diff 与 `changedItems` 后点「确认执行」。执行后源卡变 `state: merged`，专题正文末尾追加源保全块。

### 计划与状态徽章

`待执行 / 已执行 / 已作废`（open / executed / superseded）。已执行的计划不能重复预览或执行；想再整理请重新 analyze。

## 4. 模型侧十六个工具

| 工具 | 作用 | 必填 | 注意 |
| --- | --- | --- | --- |
| `soul_read` | 读当前 scope 人设卡 | — | 返回 exists / 正文 / revision |
| `soul_update` | 整卡替换 | content | CAS；带新正文前先 soul_read |
| `memory_read` | 无参=渲染 L1；带 topic=该专题全文 | — | scope 不可传，由宿主固定 |
| `memory_search` | 专题词法检索（只回 key / 标题 / 摘要） | query | 最多 20 条；可 `includeArchived` |
| `memory_append` | 往 core 或某专题追加带日期小块 | section、content | 最常用；带 operationId 可重放 |
| `memory_rewrite` | 整段替换 core 或某专题正文 | content | 专题 front-matter 由服务保留 |
| `core_write` | 只替换磁盘 core 正文（无派生索引） | content、expectedRevision | expectedRevision 用 memory_read 的 token |
| `topic_append` | 追加到指定专题 | topic、section、content | 专题不存在会报错，先用 topic_create |
| `memory_list_topics` | 列专题（含 revision token） | — | 合并 / 编辑前拿权威 token |
| `topic_create` | 新建专题 | topic、title | 已存在返回 alreadyExists |
| `spark_save` | 存 Spark 卡 | content、title、triggers | triggers 必填（空数组 = 不唤醒） |
| `spark_read` | 读卡 | id | 可读归档卡 |
| `spark_update` | 改卡（含 links） | id + 变更字段 | links 的 target 必须在库内 |
| `spark_forget` | 归档 / 被替代 | id、mode | 物理不删卡 |
| `spark_feedback` | 标记「用了」 | id、used | used=true 会抬半衰期 |
| `spark_graph` | 读图谱 | — | 只读 |

所有写工具都收 `operationId`（幂等键）：同 id 重试返回首次结果，不会重复写。

## 5. 记忆机制

知道这些才能判断「为什么没生效」。

### 选卡优先级

`sessionPersonas`（精确 sessionId）> `workspacePersonas`（绝对路径最长边界匹配，前缀边界不会把 `D:/a` 匹配到 `D:/ab`）> `defaultPersona` > `global`。工作区路径取宿主的 `workingDirectory` 投影（不是 `session.header.cwd`），会话中途换目录会换 scope。

### L0 / L1

- L0 = 人设卡正文，超过 `persona.maxChars` 直接被拒。
- L1 = core 正文 + 由专题派生的目录索引（`- key [scope] — summary`），每轮注入。
- 超过 `hardCapChars`：先用 `stateRoot/projections` 里的上次可用投影；没有就输出英文诊断占位——**绝不截断规则**。
- 宿主如果启用了 `complete: true` 的 section，它会在 waterfall 前快照、之后强制回填，本包的 L0/L1 改写必被丢弃。插件启动探测到这种情况就**零注册**，诊断里报 `completeShadowed` 与 `l0l1Effective: false`（不可判定时报 `"unknown"`，不谎报 true）。

### L2 投递时序

1. 每次模型调用前（`agent/pre-step`），只看 `role=user`、`source.kind=user`、未扫描过的人类消息（插件注入、子代理报告、历史都不扫）；
2. 用正文跑确定性匹配：触发词命中做 0 跳种子（≤ seedCount），再沿显式 links → entities 扩一跳（某实体在可见 active 卡里出现 > 5 次视为泛化标签，不扩散；关联 ≤ linkCount）；总数 ≤ maxCards；
3. 组装一条独立附件消息（`source.kind=shiori-sparks`，form=recall），先写 pending 账再追加到历史；
4. 宿主真正写入会话后回 `user/message` 事件，且 `event.data.id == 我们的 message.id` 才算 accepted，随后记 hit（hitCount+1）、写 seen、置 committed；
5. 崩溃恢复会回查会话日志补 accepted，不重复发送。

匹配细节：字面匹配（不做语义 / 同义词）、NFC 归一化、英文大小写折叠；纯 ASCII 单词按词边界（`cat` 不命中 `concatenate`），含空格或中文等按子串；同一张卡取最长命中的触发词。

**seen 冷却**：键是 `spark:seen:<scope>:<session>:<epoch>:<id>:<revision>`。同一会话同一 epoch 内同一张卡只投一次；**压缩成功后 epoch + 1，旧冷却全部失效**，所以压缩后同一张卡可以再出现。

### L3 专题

一个主题一个文件，front-matter 存 key / title / summary / updated / scopeId，正文随意。不占提示词预算，只在索引里占一行，模型需要时 `memory_read(topic)` 取全文。

### organize（整理）

三类候选：`cluster`（同一实体 / 触发词下 ≥ 8 张唯一卡）、`isolated`（active 但入出度皆 0）、`link`（共享词且两卡之间还没有任一方向链接）。执行后队列收敛（旧候选被清掉），计划不可变，`executePlan` 只认 owner 面板当前会话 + digest + `confirmed`；stop / 断连 / 换卡即撤销授权。合并目标如果是 legacy 专题（`updated: "legacy-unknown"`）会被拒——就地新建专题再合并。

### forgetting（遗忘）

`score = 2^(-elapsedDays / halfLifeDays)`，半衰期 `min(base × 2^useCount, max)`（默认 30 → 240 天）。归档资格四条全满足：`state=active` ∧ `vitality=ephemeral` ∧ `supersedes 为空` ∧ 距 `lastUsedAt ?? createdAt` ≥ 60 天且 score < archiveScore(0.25)。恰 60 天 score 正好 0.25 **不算**，61 天才归档。`spark_feedback(used:true)` 会续命。冷库检索（`includeArchived`）不受开关限制。

## 6. 数据与状态文件

```
<dataRoot>/
  persona/<scope>.md                    人设卡
  scopes/<scope>/core.md                L1 正文
  scopes/<scope>/topics/<key>.md        L3 专题（front-matter + 正文）
  scopes/global/…                       global 记忆（无人设卡时）
  sparks/scopes/<scope>/sparks.json     Spark 卡片库（cards/ops/feedback/generation）
  journal/                              跨目录事务日志
  staging/                              事务暂存
  state/                                当前 scope 指针等状态投影

<stateRoot>/
  tool-ops/<hex>.json                   工具 operationId 重放账
  l2/<hex>.json                         L2 账：scanned/pending/accepted/committed/seen/hits/sessionEpochs
  plans/<hex>.json                      整理 / 遗忘计划账（不可变）
  queues/<hex>.json                     候选队列快照
  analyze-ops/<hex>.json                analyze 幂等账
  projections/<hex>.json                last-valid L1 等投影
  completion-state-shiori-plugin-<owner>.json   压缩探针水位 / epoch / seen（含 pid）
  completion-lock-shiori-plugin-<owner>.json    单写者锁（含 pid / ownerToken）
```

`<hex>` 是 scopeId 的 UTF-8 hex（`global` = `676c6f62616c`）。

读这些文件判断状态：

- 插件到底起没起：`completion-lock-*.json` 的 pid 是否是当前宿主进程；
- L2 有没有投递：`l2/<hex>.json` 的 pending / accepted / committed 与 `seen`；
- 压缩有没有被识别：`completion-state-*.json` 的 `epoch`、`compressSeenIds`、`watermarks`、`lastAdvance.blocksCreated`；
- 某次工具调用是否落盘：`tool-ops/<hex>.json` 的 operations 键。

## 7. 日常维护

**备份**（数据 + 状态一起，缺一不可）：

~~~bash
tar -czf shiori-backup-$(date +%Y%m%d%H%M%S).tar.gz -C /path/to/memory data state
~~~

**清空测试数据**：先停宿主、备份，然后只删两个目录里的内容（保留目录本身）。scope 目录会自动重建。

**迁到新机器**：拷 `data` + `state` → 装包 → 写同样配置（根目录改成新路径）→ 启动。`completion-lock` 里是旧 pid，会被自动判定失效；`.residue-*` 残留可忽略。

**批量改卡 / 加卡**：不要手改 `sparks.json`。写一个 node 脚本调插件自己的 store：

~~~js
import { openSparkStore } from 'dsh-shiori/src/sparks/store.mjs';
const store = openSparkStore({ root: '<dataRoot>', scopeId: '<scope>' });
store.save({ /* … */ }, { operationId: 'batch-001' });
~~~

**换人设卡**：改 `defaultPersona`，或加 `sessionPersonas` / `workspacePersonas`，重启生效。人设卡文件在 `dataRoot/persona/<name>.md`。

## 8. 故障速查

先看三处：**面板「状态」tab 的诊断**、**`stateRoot` 下的 completion-state 与 l2 账**、**宿主日志**。

| 症状 | 最可能原因 | 查哪里 / 怎么办 |
| --- | --- | --- |
| 插件列表里没有 / 面板 404 / 显示「shadow 模式——数据界面停用」 | 插件没激活：启动抛错，或配置还是 shadow / inert | 看宿主日志有没有 shiori 报错；确认 `mode: active` + `allowActive: true` + 两根齐全 |
| 面板整块空白 | 前端渲染抛错 | 浏览器控制台（F12） |
| 每个 tab 都顶一行红字 | 会话被宿主标记不可用（写句柄被占用） | 换一个会话；看提示里的 code：`session/writer-held` / `session/agent-busy` |
| 会话下拉变成手填框 | `session.list` 瞬时失败 | 点「刷新」（内置 3 次重试）；仍失败就整页刷新 |
| `[INVALID_STATE] 候选已 reviewed` | 重复点 reviewed / dismissed | 重新 analyze 生成新一轮候选 |
| `REVISION_CONFLICT` | 卡片 / 专题 / 计划被外部改过，revision 过期 | 重新 `memory_read` / `memory_list_topics` 取新 token |
| `LOCK_BUSY` / `live owner or unknown lock content` | 同一 DSH_HOME 有两个宿主持有写句柄 | 只留一个宿主；残留锁手工确认后删 |
| `UNSUPPORTED module is disabled…` | l2 / organize / forgetting 开关没开 | 改配置重启 |
| `plan "…" was already executed` | 计划不可重复执行 | 重新 analyze → preview 新计划 |
| `legacy topics remain read-only` | 目标是 legacy 专题 | 新建专题再合并 |
| 面板 `l0l1Effective` 是 `"unknown"` 或 `false` | 宿主有 complete 预设，本包 L0/L1 被回填覆盖 | 属实诊断：想让人设卡进提示词，就让 persona 由本包管理 |
| 图标不显示 | 图标过大或格式不支持 | `icon.png` ≤ 256KB，png / jpg / webp / svg |
| 预算改了没效果 | 数值非法；或只热提交未重启 | 空输入=不改；保存成功会有提示；**重启 / 重载后生效** |
| Spark 明明提到却不投递 | L2 关；触发词字面不匹配；已 seen；被实体泛化阈值挡掉 | 查 `l2/<hex>.json` 的 seen 与 hits；触发词加同义说法；压缩后 epoch 会重置冷却 |
| 工具报 `tool ownership conflict … soul-md` | 与 dsh-soul-md 同装，9 个同名工具冲突 | 停用 soul-md |
| 插件没反应但没报错 | 看 `completion-lock` 的 pid 是否还活着 | 宿主重启后锁会自愈；`*.residue-*` 残留不影响运行 |

## 9. 开发备注（踩过的坑）

1. 面板「预算」保存是 volatile：热提交，但运行中的插件用启动快照，**必须重启 / 重载**才生效。
2. 不要手改 `sparks.json`：卡库有 generation CAS，和运行中的宿主冲突会丢写。走 store API。
3. `node --test test/plugin/`（目录形式）在 Node 24 Windows 会报 Cannot find module，必须用 glob。
4. git-bash 的 `tar` 不认 `D:/…` 这种写盘路径，要写 `/d/…`。
5. 大文件用 `edit` 或分块写，不要用 heredoc 整段覆盖中文长文。
