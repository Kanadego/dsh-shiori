# dsh-shiori 开发报告

> 包：`dsh-shiori` `0.1.0-alpha.1`（`private: true`，未发布 npm）· 目标宿主：DSH `0.2.1-rc.2` · 报告时间：2026-10-27
> 本文记录「做了什么、为什么这么做、怎么验的、还剩什么」。使用与运维见 USAGE-GUIDE.md，接手维护见 HANDOFF-TO-AMBER.md。

## 0. 一页速览

| 项目 | 内容 |
| --- | --- |
| 交付物 | DSH 原生插件包 `dsh-shiori`：分层记忆（L0 人设 / L1 core+索引 / L2 Spark 闪回 / L3 topics）+ 整理（organize）+ 双轨遗忘（forgetting）+ Web 面板 |
| 交付形态 | 本地 tgz `dist/dsh-shiori-0.1.0-alpha.1.tgz`（373,215 字节，67 个文件），经 `dsh plugin --profile <p> add` 安装，以 `dsh.bundle.patch` 作为 bundle 挂载 |
| 当前状态 | 已装进真 desktop profile 并在 Electron app 内实机跑通；本机 scope `amber` 正在被实际使用 |
| 代码规模 | `src/` 11 个模块目录、16 个宿主工具、9 个面板 RPC 方法；测试 1046 例 / 83 套件 |
| 验证结论 | 模块测试、真实 CLI 安装卸载、真实 Cordis 装配、真实 agent 轮次工具调用、L0/L1 注入、L2 投递回执、压缩 epoch、organize/forgetting 执行、面板九方法全部取证（§5） |
| 主要遗留 | Gateway 严格 codec 只到「参数级严格、消息面走 SRC 回退」；实机阶段的客户端修补未走协作台返工轮次（§8） |

## 1. 要解决什么问题

DSH 默认记忆是单文件 + 手动维护：人设卡、规则、待办、偏好全塞在一份 Markdown 里，越写越长，每轮整段注入，既烧 token 又拖慢 KV 缓存。目标是把记忆变成**分层、可预算、可自动投递、可整理可遗忘**的系统：

| 层 | 内容 | 注入方式 |
| --- | --- | --- |
| L0 | 人设卡（persona） | 每轮 system prompt 的一个 section，按会话/工作区选卡 |
| L1 | core 正文 + 由 topics 派生的索引 | 每轮注入；超硬上限用 last-valid 或诊断占位，绝不截断规则 |
| L2 | Spark 卡片图谱 | **不常驻**：只在用户消息字面命中触发词时，按「0 跳种子 + 1 跳关联」投递一条独立附件消息 |
| L3 | topics 长文 | 不进提示词，模型按需 `memory_read(topic)` 取全文 |

三条工程约束贯穿全程：**注入内容逐轮稳定**（否则废掉 KV cache）、**写入必须 CAS 可重放**（崩溃不半写）、**shadow 模式绝不碰业务数据**（装错也不能污染）。

## 2. 开发历史（简版）

| 阶段 | 时间 | 做了什么 | 验收 |
| --- | --- | --- | --- |
| P0 核心与存储 | 10/23–10/24 | 配置与预算水位、CAS 写入、锁文件协议、journal 事务、front-matter、路径安全 | 单元测试 + 跨进程并发测试 |
| P1 运行时与完成探测 | 10/24–10/25 | system-prompt waterfall、agent/pre-step、压缩完成探针（callId 去重）、验收脚手架 | 合成宿主 + 真实宿主形状对照 |
| P2 Spark（L2） | 10/25 | 卡片库、确定性匹配（0 跳/1 跳、seen 冷却）、投递与回执三段账、图谱 | 纯函数测试 + 回执链路测试 |
| P3 整理（organize） | 10/25 | 候选生成（cluster/isolated/link）、队列收敛、计划草稿/执行（link、merge-topic）、CAS 先于 journal | organize 测试套件 |
| P4 遗忘（forgetting） | 10/25 | 双轨衰减（score = 2^(-elapsedDays/halfLifeDays)，半衰期随使用次数 30→240 天）、归档计划与执行 | forgetting 测试套件 |
| P5 插件化 + 客户端 + 实机 | 10/25–10/27 | Cordis 插件入口、16 个 defineTool、9 个 RPC、Web 面板、真 CLI 安装链、真机验证与打磨 | §3–§5 |

P0–P4 结束时基线：**878 例测试 / 83 套件全绿**。P5 在其上加插件层与面板，最终 **1046 例**。

## 3. P5 是怎么做的

### 3.1 双槽协作 + owner 只审不写

P5 的实现不由 owner 写，而是拆成两个互不重叠的白名单槽，交给外部 agent 实现，owner 只做契约冻结、独立复现与最终验收：

| 槽 | 职责 | 白名单 |
| --- | --- | --- |
| P（`P5-HOST-CONTROLLER`） | 可信宿主桥、controller 生命周期、scope/persona 解析、L0/L1 装配、L2 投递、management、协议校验、typert 描述符 | 31 个路径 |
| Q（`P5-PACKAGE-CLIENT`） | `Config` schema 与规范化、`index.mjs` 入口、`cordis.patch.yml`、RPC 服务、Web 客户端、打包与发行核查 | 21 个路径 |

协作台在 `phase6/collab/`：`board.mjs`（状态机 + 文件指纹 + 冻结基线守卫）、`BASELINE.json`（144 个冻结文件哈希）、`task-definitions.json`（白名单）、`CONTRACTS.md`（20KB 契约）、`tasks/{P,Q}.md`。提交是不可变封包（`submissions/<slot>/<attempt-id>/files`），`submit` 只封变化字节，并校验「不在白名单内且未冻结」的文件，防止越权与夹带。

### 3.2 owner 怎么审

每个提交做三件事，不采信对方自述：

1. **自建候选树**：冻结基线 + 提交文件拼独立树，`node --test test/plugin/*.test.mjs` 与全量 `npm test` 自己跑；
2. **行为级复现**：写只属于 owner 的 repro（真实 Cordis Context / SystemPrompt / ToolRuntime）逐条复现声称修好的缺陷，并做 mutation（把旧实现换回去，确认新测试会红）；
3. **真机点检**：装进 profile，用 CDP 驱动 headless Chrome 点面板，读磁盘取证，不看「应该」。

### 3.3 返工轮次与主要缺陷

两家合计 11 轮提交、9 次退回，返工单原文都在 `phase6/collab/reviews/`（`P-a*-owner-rework*.md`、`Q-a*-owner-rework.md`、`*-owner-accept.md`）。

| 轮次 | 槽 | 结论 | 阻断项（摘要） |
| --- | --- | --- | --- |
| a1 | P | 退回 | workspacePersonas 死代码；complete-prompt 场景静默丢弃 section 却报成功；shadow 抢 completion 锁；start/stop 无互锁；persona 崩溃重放撞 REVISION_CONFLICT；L2 恢复不查会话日志；assemble 无 try/catch |
| a1 | Q | 退回 | 盘符根嵌套判漏；Cordis receiver 下 9 个方法全 TypeError；analyze 发 undefined 字段破坏无损 JSON；跨会话 stale preview 可执行；package gate 无法在 P 在场时存活 |
| a2 | P | 退回 | 已取消的 executePlan 仍完整执行；management RPC 不随 stop 排空；压缩事件用 header.cwd 与工具链分叉；探测失败被当成「无 complete」 |
| a2 | Q | 退回 | 回归测试断言写死「必须单槽」，合并树必红（R6） |
| a3 | P/Q | **通过** | — |
| a4 | P | 退回 | typert-descriptors.mjs 在未注入时 `ctx?.typert` 直接抛，真机 `cannot get property "typert" without inject` → 插件 404（B-P2） |
| a4 | Q | 退回 | 候选 DTO 层级取错（把 item.candidate.id 当 item.id），面板显示数组下标、cluster 行没有合并按钮；proposal 默认死值 {"kind":"link","links":[]} 撞 minItems:1 |
| a5 | Q | 退回 | 五个 RemoteError 出口缺 details，宿主 client.browser.js:1301 判非法响应 → 面板所有失败都显示 connection: invalid server-response failure（B-Q3） |
| a5 | P | **通过** | — |
| a6 | Q | **通过** | — |

最有价值的三条缺陷都属于「单测用合成形状掩盖真机形状」：

1. **压缩 receipt 的 callId 不在 message.callId**。真机 tool/result 的键是 [role,source,toolCallId,content,isError,id]，callId 实际在 message.source.callId。只读第一个来源 → 探针永不推进 → epoch 永远 0。修法：三来源容错（callId / toolCallId / source.callId），三者皆无则不猜。
2. **成功回执正则要求行尾恰为 `saved.]`**。真实回执把警告内嵌在闭合 ] 之前。修法：行首 + 闭合 ] 双向锚定，尾串不得含 ]。
3. **`ctx?.typert` 在未 inject 时是抛错不是 undefined**（Cordis 属性访问未注入服务直接 TypeError）。修法：改用 `ctx.get("typert")` + 调用点 try/catch，缺席时降级 `{codec:"src"}` 并如实写进 diagnostics。

## 4. 架构

~~~text
index.mjs（Cordis 插件入口 apply）
  └─ src/plugin/controller.mjs     生命周期 start/stop、generation 互锁、16 个 defineTool 注册、
     │                            system-prompt waterfall（L0/L1）、agent/pre-step（L2）、
     │                            完成事件订阅（压缩 epoch / accepted receipt）、diagnostics
     ├─ config.mjs               Schemastery Config + 权威 normalize（未知键拒绝、上限、根目录规则）
     ├─ bindings.mjs             宿主服务绑定（systemPrompt / agents / tools / settings / workingDirectory）
     ├─ scope.mjs                scopeId 解析与固定（会话 > 工作区最长边界 > 默认卡 > global）
     ├─ persona.mjs              人设卡 dataRoot/persona/*.md；prepared journal + newHash 三态重放
     ├─ state.mjs                stateRoot 账本：tool-ops / l2 / plans / queues / analyze-ops / projections
     ├─ management.mjs           9 个面板 RPC 的纯 JSON 实现（executePlan 只认 owner + digest）
     ├─ protocol.mjs             入参/出参严格校验（closed object、未知键拒绝、.code）
     ├─ client-rpc.mjs           TypertRemoteService，按 invocation.peer.principal 授权 owner
     ├─ typert-descriptors.mjs   Gateway 描述符注册（缺席降级为 SRC）
     └─ tool-schemas.mjs         16 个工具输出 schema + render
宿主侧：src/host/{dsh-adapter,tools,compress-probe}.mjs
业务：src/{core,storage,service,runtime,sparks,organize,forgetting}/
客户端：client/index.js（面板 2,100+ 行）、client/shiori.css
~~~

三条不可动摇的不变量：

1. **CAS + journal**：所有写带 operationId，重放返回首次结果；跨文件写先写 journal 再落盘，崩溃由重放收敛。
2. **生成锁（generation）**：start/stop 递增 generation，异步回调（waterfall / pre-step / 事件）都校验 generation 与 banned，stop 后旧代回调一律不写。
3. **shadow 只读**：shadow（含未配置根的 inert）不开 completion 锁、不建 scope、不写 receipt；9 个数据方法一律拒绝，只有 getStatus 可用。

## 5. 真机验证（七轮，全文见 phase6/collab/reviews/P5-live-verification-20261026.md）

| 轮次 | 目标 | 结论 |
| --- | --- | --- |
| 一 | 装进隔离 profile，看面板能不能起 | 安装链通；面板报 `cannot get property "remote.shiori" without inject` → 客户端 inject 名单少了 remote.命名空间，且自己 $mount 的服务不能声明为自己的 inject（会自锁） |
| 二 | 九个 RPC + 16 工具 | 九方法逐项返回正确 DTO；真实 agent 轮次里 soul_read / memory_append 被调用并落盘；服务端严格校验（未知键、未知工具、非法 operationId 全 INVALID_INPUT） |
| 三 | L0/L1 注入与 L2 投递 | 会话 jsonl 的 system prompt 里看到人设卡 + core + 索引；写入后下一轮重装配可见；L2 投递的独立附件进历史并被模型实际使用 |
| 四 | 压缩 epoch | 首次失败：epoch 不推进（callId 与回执正则双根因，§3.3）；修好后真实压缩让 sessionEpochs 0→1、compressSeenIds 记到 tool/result:161 |
| 五 | organize / forgetting 真实执行 | link、遗忘归档、merge-topic 三条路径全跑通（合并后 8 张卡 state:merged，topic 文件带源保全块）；同时发现队列不收敛与面板无合并入口，催生第 4 轮返工 |
| 六 | 第 4 轮返工后的合并树 | 154/154 plugin 测试；面板完整点完「合并进主题」三步（建主题 → 预览 diff → 确认执行）；Gateway 严格 codec 真机出现 {"codec":"strict","reason":null} |
| 七 | 客户端打磨与记忆迁移 | 修掉会话下拉竞态（R7）、空白会话过滤、预算 step 导致 0.75 判非法、图标透明背景、候选 tab 布局与中文化；把 web 端 dsh-soul-md 记忆整体迁入 shiori（persona 6,840 字符 + core 9,645 字符 + 36 个 topic，预算抬到 target 14000 / hardCap 20000） |

真机期间发现并修掉的 8 个客户端/宿主交互缺陷（报告里有行锚）：inject 名单缺失、volatile 预算保存清零、图标超 256KB 上限、diagnostics.some 崩溃导致整块面板消失、会话下拉首帧拿不到 list 导致永久退化手填、blank 空壳会话混入下拉、比率字段缺 step="any" 导致 0.75 被判非法、候选 DTO 层级与 proposal 死值。

## 6. 测试与证据

~~~bash
npm test               # 全量 12 个套件目录
npm run test:p5        # 仅 test/plugin/*.test.mjs
npm run verify:package # 包清单 / bundle / import 完整性静态核查
npm pack               # 产出 tgz（本次交付已放在 dist/）
~~~

| 指标 | 数值 |
| --- | --- |
| 全量测试 | 1046 例 / 83 套件全绿（98.4 秒；偶发 test/storage/concurrency.test.mjs 跨进程锁 flake，单独重跑 4/4 通过） |
| 插件测试 | 164 例（含真实 dsh plugin add/remove、真实 --dump-config 装配、真实 boot 三条真机冒烟） |
| 打包产物 | 67 文件 / 373,215 字节 / sha256 25f37f0d376da42bfece7ce871be1934fa3d94c4cc6c58fc19c3d670073462cd |
| 证据目录 | phase6/collab/reviews/：返工单、验收单、owner repro 脚本、P5-live-verification-20261026.md（七轮实机）、submissions/（不可变提交封包） |

## 7. 至今仍然成立的设计取舍

- **不截断**：L1 超硬上限用 last-valid 或占位，绝不悄悄砍规则——记忆系统最怕「看起来正常但内容被吃」。
- **L2 不常驻**：只有命中触发词才投递；seen 键含 contextEpoch，压缩后冷却重置是特性不是 bug。
- **persona 崩溃可恢复**：写卡前先记 prepared（含 newHash 与 expectedRevision），重放能区分「已写成功」与「被外部改过」。
- **complete-prompt 场景主动退让**：宿主在 waterfall 前快照 complete section，本包改写必被丢弃，所以探测到就零注册并如实上报 l0l1Effective:false，不假装成功。
- **面板不兜底错误**：服务端把 details 原样带到前端，前端只透传，避免两层语义漂移。

## 8. 已知遗留

| # | 事项 | 现状 / 建议 |
| --- | --- | --- |
| 1 | Gateway 严格 codec | 参数级已严格（真机确认 args fields do not match the descriptor 会拒绝），消息面仍走 SRC 回退；宿主 registry 只校验非空 typeSymbol + create，无 schema 解析，属宿主能力边界 |
| 2 | 实机阶段客户端修补未走协作台 | R7 会话竞态、blank 过滤、step、人设卡改名、候选 tab 布局与中文化，均由 owner 派子代理直接改根树并实机验收，**没有在 board 上留 attempt**。代码是好的，但协作台状态机与最终树有偏差（见 HANDOFF-TO-AMBER） |
| 3 | test/storage/concurrency.test.mjs flake | 并行跑全量时偶发 LOCK_BUSY（live owner or unknown lock content），单独重跑稳定；清理 %TEMP%\shiori-b-* 可提高复现稳定性 |
| 4 | types 声明 | 无 .d.ts；RPC 的 RemoteErrorDetailsMap 增广未做（项目内无任何 .d.ts，宿主也未导出该类型） |
| 5 | 发布流程 | private: true + license: UNLICENSED，从未 publish；registry spec 安装未验证；RELEASE-CHECKLIST 只有骨架 |
| 6 | 性能 | 全量测试约 110 秒；面板首次打开会话下拉最多探 5 个候选会话，会话很多时略慢（已加 3 次重试与并发守卫） |
| 7 | 多语言/多 scope | 目前单用户本地 profile、scope 由人设卡名派生（本机 amber），无跨用户隔离概念 |

## 9. 仓库地图

| 路径 | 内容 |
| --- | --- |
| src/ client/ index.mjs cordis.patch.yml package.json | 插件本体 |
| test/ | 全量测试（12 个套件目录） |
| docs/ | 分层设计文档：docs/plugin/（安装/客户端/控制器）、docs/core/、docs/storage/、docs/sparks/、docs/organize/、docs/forgetting/、docs/completion/ |
| docs/DEV-REPORT.md docs/USAGE-GUIDE.md docs/HANDOFF-TO-AMBER.md | 本次交付的三份文档 |
| dist/ | 当前交付的 tgz |
| assets/ | 图标原始素材（白底 1254×1254） |
| phase2/…phase6/ | 各阶段协作台（工作副本、提交封包、返工单、验收证据）；P5 证据最全 |
| HANDOFF.md | 开发期「下一跳会话」的滚动交接记录（历史价值 > 现状价值） |
| DESIGN.md | 原始设计（51KB，P0 前编写） |
