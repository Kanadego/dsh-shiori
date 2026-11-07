# 审计索引（docs/audit/）

2026-11-07 对 shiori 0.2.x（基线 `dd27150`，含 0.2.2 全部功能与 0.2.3 planView.proposalKind）做的全量只读审计，共三份报告，均由独立审计席在工作树中完成、未改动任何源码。

- **怎么用**：排查问题先查下面对照表定位到报告与编号，再进报告正文看「位置 / 为什么是问题 / 最小复现 / 修复方向」；报告里的行号是审计当日 grep 过的，动手前先重新核对。
- **分级口径**：P0 = 丢数据 / 写坏状态 / 安全边界破口；P1 = 功能错误、跨会话状态污染、协议不一致；P2 = 口径 / 一致性 / 性能 / 卫生。
- **状态说明**：0.2.3 收尾批（thin-core 裁撤 + 服务端/客户端修复单 + 本文档）已合入 main，下表状态即合入后的实际状态。状态列只有三种取值：**已修 / 待修 / 随 thin-core 裁撤消失**。

## 一、报告索引

| 报告 | 覆盖范围 | 一句话结论 |
| --- | --- | --- |
| [2026-11-07-a-storage-service.md](./2026-11-07-a-storage-service.md) | `src/storage/*.mjs`、`src/service/index.mjs`、`src/core/*.mjs`、`src/sparks/*.mjs`、`src/forgetting/*.mjs` 及对应 test/ | 0 个 P0、0 条 P1、7 条 P2（元数据校验口径、IO 错误形状、死代码等卫生问题；CAS/锁/崩溃恢复等核心防线全部核查成立） |
| [2026-11-07-b-organize-protocol.md](./2026-11-07-b-organize-protocol.md) | `src/organize/*.mjs`（analyze / executor / queue）、`src/plugin/*.mjs`（14 个文件）及 `test/organize/`、`test/plugin/` 对应用例 | 0 个 P0、2 条 P1（草案 sources 无上限、thin-core no-op 回执误报）、5 条 P2 |
| [2026-11-07-c-client.md](./2026-11-07-c-client.md) | `client/index.js`（5101 行）、`client/shiori.css`、`docs/GLOSSARY.md`、`test/plugin/client.test.mjs`、`test/plugin/ui-*.test.mjs` | 0 个 P0、4 条 P1（三处会话切换竞态 + thin-core 三方不一致）、8 条 P2 |

**总账：0 个 P0，4 条 P1，20 条 P2**（审计原始发现 P1 共 6 条，其中 thin-core 相关的 2 条随 0.2.3 整块裁撤一并消失，见下表）。

## 二、P1 清单与状态

| 编号 | 报告 | 一句话 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| P1-B1 | B | buildDraft 组装 link / thin-core 草案的 `sources` 无 64 上限，预览成功、执行必败，计划永久滞留 open | 已修 | 0.2.3（服务端单）：queue 侧新增 `LINK_SOURCES_MAX=64` 自查，与执行器同口径，超限报 INVALID_INPUT |
| P1-B2 | B | thin-core 无变化计划（before === after）首跑即回 `replayed: true`，回执语义失真 | 随 thin-core 裁撤消失 | 0.2.3 整块裁撤 thin-core（协议 / 草案 / 执行器 / 测试），该分支不复存在 |
| P1-C1 | C | StatusTab「重建向量」轮询的会话切换守卫失效（闭包捕获旧 props），轮询跨会话不停并污染新会话视图 | 已修 | 0.2.3（客户端单）：改用渲染体同步的 sidRef + 卸载置假的 pollAliveRef，附回归用例 |
| P1-C2 | C | 六个数据 tab 的 `load` 无过期响应守卫，快速切会话时旧响应后到覆盖新会话数据 | 已修 | 0.2.3（客户端单）：`makeTabSessionGuard` 的 mark/isStale，六个 tab 全部接入，过期请求不动 busy |
| P1-C3 | C | TopicsTab 详情读取竞态：`readTopic` 不校验 key 可串卡，`save()` 可能写错目标专题 | 已修 | 0.2.3（客户端单）：读请求序号 + openedRef 丢弃晚到响应；`save()` 只认 opened，detail.topic 不一致直接拒写 |
| P1-C4 | C | thin-core 计划三方不一致：服务端收、客户端本地校验拒、UI 无发起入口，预览卡渲染分支不可达 | 随 thin-core 裁撤消失 | 0.2.3 客户端单同步删除 thin-core 协议面、本地校验与预览卡渲染分支 |

## 三、P2 清单与状态

| 编号 | 报告 | 一句话 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| P2-A1 | A | `archivedAt` 的 ISO 校验是宽松口径，非 ISO 日期串被 service 与 storage 两层接受落盘 | 待修 | |
| P2-A2 | A | 读路径对手改的 `archivedAt` 垃圾串照单全收并标记 archived，与 summary 的 shadow 防线强度不一致 | 待修 | |
| P2-A3 | A | `updated` 元数据完全无格式校验，与 `archivedAt` 校验强度不对称 | 待修 | |
| P2-A4 | A | storage 层文件系统 IO 异常以裸 fs 错误冒泡，不带稳定业务码，与 sparks 层 `IO_ERROR` 约定不一致 | 待修 | |
| P2-A5 | A | revision token 摘要无密钥可重签；`projectionHash` 可剥离绕过渲染视图乐观锁（威胁模型部分待核） | 待修 | |
| P2-A6 | A | `journal.mjs` readJournal 损坏包装是裸 `Error` 而非 StorageError（当前调用序基本不可达） | 待修 | |
| P2-A7 | A | 死代码 / 仅测试引用导出 7 处 | 待修 | 删除需先与契约核对，报告只记录未动手 |
| P2-B1 | B | executePlan 在 `markExecuted` 之后的队列收敛若抛错，客户端收到失败回执但计划实际已执行 | 待修 | |
| P2-B2 | B | previewPlan 的 wire inputSchema 比 buildDraft 宽松（link 的 `rel`、merge-topic 的 `expectedRevision`） | 待修 | |
| P2-B3 | B | organize analyze 的 `supersedeOpen` 把 archive-topic 计划一并误作废 | 待修 | 0.2.3 从本批撤回：需改 `src/plugin/state.mjs:586-604`，已转后续单（archive-topic 独立计划族） |
| P2-B4 | B | executor 注释声称「生产 caller 未传 stateRoot，线上一定走 skipped」已过时 | 随 thin-core 裁撤消失 | 该注释描述的是 thin-core 备份链路，随整块裁撤一并移除 |
| P2-B5 | B | buildDraft 拒绝 archive-topic 的报错文案漏列 archive-topic，与 PLAN_KINDS 不一致 | 已修 | 0.2.3：文案改为与 buildDraft 实际接受集一致（link / merge-topic）；archive-topic 走独立的 buildArchiveTopicPlan，不经 buildDraft |
| P2-C1 | C | GLOSSARY 第三章 tab 对照表只有 6 行，实际 tab 栏有 8 个 | 待修 | 归入下一批「GLOSSARY 与文案统一」 |
| P2-C2 | C | 计划区同一规则两处文案不一致（「预览 / 合并进主题」vs「预览整理计划 / 合并进主题」） | 已修 | 0.2.3（客户端单）：两处统一为「预览整理计划 / 合并进主题」 |
| P2-C3 | C | 力导向布局 O(n²)×120 轮 + 两两分离，无节点上限，大库长时间阻塞主线程 | 待修 | 下一批 |
| P2-C4 | C | 候选行每次渲染执行 `stableStringify(item)`，搜索逐键输入即全量重序列化 | 待修 | 下一批 |
| P2-C5 | C | 两处错误文案直接拼 `e.message`，异常对象无 message 时把字面量 `undefined` 拼上屏 | 待修 | 下一批 |
| P2-C6 | C | TopicsTab 的 load / readTopic / save 错误不走 `reportSessionUnavailable`，与其他 tab 口径不一 | 待修 | 下一批 |
| P2-C7 | C | CandidatesTab useState 下标被测试按下标注入，测试注释仍写「7 个 useState」（实际 17 个） | 待修 | |
| P2-C8 | C | 图谱节点仅指针操作，无 tabIndex / 键盘事件，键盘用户无法选中节点 | 待修 | 下一批 |

## 四、与记账的关系

- 剩余待办（下一批）口径见仓库根 `HANDOFF.md`「下一批」小节：图谱布局 O(n*n) 与节点上限、候选行 stableStringify 性能、图谱键盘可达、错误文案可能拼出 undefined、TopicsTab 会话不可用口径、GLOSSARY 与文案统一。
- 0.2.3 收尾批的裁撤与修复决策（thin-core 裁撤理由、P1 修复安排）见 `HANDOFF.md` 与 `DESIGN.md` 对应小节。
