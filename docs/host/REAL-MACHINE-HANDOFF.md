# Shiori 隔离实机测试交接

> 状态：待人工执行。本文是后续隔离验收的操作与记录模板，不表示真实 DSH/E 工厂联调已经完成。完成本交接前，不得在真实 profile 启用 active、宣称替代 soul-md，或进行安装/发布。

## 目的与边界

先验证真实 E 完成状态工厂与 DSH 装配链，再验证事件归因和压缩回执证据；这些都是 active 模式的前置条件。所有步骤由操作者逐项执行：不自动发模型请求、不切换路由、不重启 DSH。只使用专用测试 profile、合成数据和独立工作区；不连接真实记忆或 persona，不读写真实 soul/persona 内容。付费 provider 请求不属于本阶段；如将来需要，须先由用户明确确认账单与次数。

范围之外：L2 graph/attachment delivery、persona adapter、settlement/organize、dual-track forgetting、安装/迁移流程。未实现能力必须如实显示 UNSUPPORTED，不能以 mock 或静默降级冒充支持。

## 已知实现约束

- Runtime 入口：
  `createShioriRuntime(options, dependencies = {}) -> { start(), stop(), refresh(), diagnostics(), service, bridge, host }`
  （见 [runtime README](../runtime/README.md)）。
- `dataRoot` 与 `stateRoot` 必须是绝对路径，互不相同、互不嵌套；同时按真实文件系统解析 junction/symlink 后仍须不相交。使用全新、可丢弃的测试根目录。
- 默认 shadow；active 必须显式 `config.hostBridge.allowActive === true` 且通过唯一写者校验。运行时不会替操作者打开 active。
- `openCompletionState` 必须注入真实 E 工厂。缺失即 UNSUPPORTED；不得用内存假实现代替持久状态验收。
- `assembleDshShioriHost(pluginCtx, { service, config, mode = "shadow", trustedScopeId, loadDshTools, probeSink } = {})` 只组装、不自动 start。
- direct `tool/result` 不含工具名，必须以 `message.callId` 回连之前的 `tool/call`；PTC 事件以 `parentCallId` 关联 direct callId，缺失时才检查 rootCallId/subCallId 退化路径。direct/PTC 同一底层调用只能计一次。
- 压缩 epoch 只在工具为 compress、成功且有明确的正整数实际创建块证据时推进。失败、零块、证据缺失或冲突均不得推进；不能从 token 用量变化或单词 “Compressed” 推断成功。现有已知样本中 direct 结果和 PTC 事件均可能没有数值块字段，必须记录证据不足，不能伪造通过。

## 阶段 0：预检与隔离

人工确认并记录：

- [ ] 使用专用测试 profile / 工作区，不引用真实 profile、真实记忆目录或真实 persona；不改路由、不触发模型请求。
- [ ] 保存可回滚的测试配置备份；记录 DSH、bili、Node 版本和代码 revision。只操作测试 profile，不需要修改生产配置。
- [ ] 为 dataRoot、stateRoot 创建互不嵌套的临时专用目录；记录绝对路径并确认 junction/symlink 解析结果不相交。
- [ ] 放入合成 core 哨兵（例如随机后缀的 `SHIORI-PROBE-V1-<随机串>`）。日志、解码和抓包只保留命中/未命中、hash、计数及必要事件字段；不留真实记忆正文、persona 或凭据。
- [ ] 确认用于观察/注册的插件上下文来自隔离会话。若无法证明隔离或唯一写者，停止，不进入 active。

预检失败时：保持 shadow/未启动，记录阻断原因；不得尝试真实 profile 验证。

## 阶段 1：真实 E 工厂与 DSH 装配链（最高优先级）

目标是证明真实 E 工厂能被真实 runtime/DSH 适配链调用、持久化且可回收；不能用测试内联 synthetic factory 代替。

- [ ] 定位并记录实际 E 工厂模块、版本/revision、公开导出和打开状态文件的测试根路径。确认状态文件只落在专用 stateRoot。
- [ ] 在隔离 harness 中把真实 E 工厂显式注入 `openCompletionState`，由真实 runtime 入口组装；确认实际 DSH host adapter 与真实事件订阅/排空路径参与。仅构造/启动 shadow；不注册 active 工具、不发模型请求。
- [ ] 启动、诊断、停止，再启动新一代 runtime；确认关闭/flush 完成、无句柄重叠，且持久状态从同一隔离 stateRoot 恢复。记录 diagnostics、E 工厂调用和文件 hash/计数，不复制敏感正文。
- [ ] 对缺少 E 工厂注入的负向用例确认返回 UNSUPPORTED，而非退化成内存态；对错误根目录/无法隔离的用例确认拒绝启动或保持未启动。
- [ ] 记录 shadow 的工具注册数、section 注册数、dataRoot 写入数；预期均为 0。允许 stateRoot 中仅出现已声明的压缩诊断状态。

本阶段任一关键链路无法观察、E 工厂并非真实实现、或状态落到隔离根目录之外：判为 BLOCKED，不进入 active，也不宣称 E/DSH 联调完成。

## 阶段 2：callId 归因与去重

使用不发模型请求的合成事件夹具，先逐条确认字段来源，再在真实隔离事件流中只读观察：

- [ ] direct：先收到 `tool/call { callId, name }`，后收到不含 name 的 `tool/result { message: { callId, isError } }`；按同一 session 的 callId 归因到原工具名。
- [ ] 同时存在多个 in-flight call 时，交错 call/result，确认不会串名；新 session 的相同 callId 不得复用旧 session 映射。
- [ ] PTC：`tool/ptc-dispatch` 中的 `parentCallId` 指向 direct callId；与 direct 结果表示同一个底层调用时只产生一次压缩推进。仅在 parentCallId 缺失时单独验 rootCallId/subCallId 的退化归因。
- [ ] 缺失、未知或类型错误的 callId/name 不能猜测映射，也不能错误推进 epoch；记录 diagnostics 中去重/无身份计数。
- [ ] 停止/重启后重放同一 eventId，确认持久去重有效；eventId 与 call identity 的职责分别记录，不能互相替代。

验收证据至少包含脱敏后的事件类型、session 标识的不可逆化名、callId 对应关系、预期/实际计数和 epoch 前后值。不得保存完整会话或工具参数正文。

## 阶段 3：压缩回执证据

已知可识别文本形状（仍须验证计数与语义，不以包含关键词作为成功判据）：

- `[Compressed m…–m…, … → N block(s), ~M tokens saved.]`
- `[acp-result: PARTIAL — N block(s) created; …]`

逐项用隔离测试会话人工触发/观察；不要为制造成功而调用真实付费模型：

- [ ] 成功且明确创建 N>0 块：来源回执、解析出的块数、归因 callId、去重结果与 epoch +1 一致。
- [ ] 失败回执、零块、只有 token 用量下降、未知文本、文本与数值元数据矛盾：epoch 均不变；矛盾时记录 metaConflict/拒绝证据。
- [ ] direct 路径若没有明确数值 blocksCreated：记录“直接模式块证据缺失”，epoch 不推进是预期限制，不记为实现失败或成功压缩。
- [ ] PTC 路径若事件没有数值块字段，仅在已验证的受支持文本格式能无歧义解析创建数时才计入；未知/不完整/不一致回执不推进。
- [ ] 同一底层调用同时产生 direct 与 PTC 报告：确认只推进一次；重启后重放同一 eventId：确认不再次推进。

## 阶段 4：active 门槛（仅前三阶段通过后）

本阶段仍须人工确认后逐项操作；本文不授权代替操作者启动 active。

- [ ] 确认没有另一个 soul-md/Shiori 同名工具或 section 提供者；唯一写者检查通过。冲突必须是 INVALID_STATE 并停止。
- [ ] 确认测试 profile 和所有根目录仍隔离；只在该 profile 显式设置 `config.hostBridge.allowActive === true`，不改真实 profile。
- [ ] 验证 L0 + 完整 L1 投影、一次合成写入在下一请求前可见、CAS/operationId 稳定、重启去重、global fallback 不写入、shadow 零写，以及不支持能力明确 UNSUPPORTED。
- [ ] 完整出站 system / 缓存矩阵依 [host acceptance checklist](./acceptance-checklist.md) 执行。若需要任何真实 provider 请求，先停止并取得用户对费用与次数的明确确认；该确认不包含在本交接内。

任一失败：停止 active 测试，回到 shadow，保留测试证据与错误，不扩展到真实 profile，不宣称通过。

## 结果记录模板

每次运行另建一份不含敏感内容的记录：

| 字段 | 记录 |
| --- | --- |
| 日期 / 操作者 | |
| Git revision / DSH / bili / Node 版本 | |
| profile 化名 / 测试目录化名 | |
| E 工厂模块与版本；是否为真实工厂 | |
| runtime、adapter、事件订阅是否真实参与 | |
| shadow 注册数 / section 数 / dataRoot 写入计数 | |
| direct callId 归因 / PTC parentCallId 关联 / 去重计数 | |
| 回执类型 / 块数证据来源 / epoch 前后值 | |
| restart 后状态恢复 / eventId 重放结果 | |
| 未支持能力、失败项、错误码 | |
| 证据文件 hash、保存位置及清理确认 | |
| 结论：PASS / FAIL / BLOCKED；允许的下一阶段 | |

不得在记录或仓库中保存请求正文、真实 memory/persona、密钥、完整会话解码或原始抓包。临时解码/抓包放隔离临时目录，验收留档后按清单清除，只保留 hash、计数和必要的脱敏片段。

## 通过判据

1. 真实 E 工厂 + 隔离 DSH/runtime 链实际参与，持久化和生命周期结果可复核，且所有写入被限制在隔离根目录。
2. direct 与 PTC 事件依据 callId 正确归因，同一底层调用不会双计；重启重放不会再次推进。
3. 只有成功且可证实的正块数回执推进 epoch；失败、零、缺失、矛盾或推测证据均不推进，并明确标注 direct 无块证据这一限制。
4. 完成阶段 4 前不得启用真实 profile；上述通过也不等于安装、迁移、persona adapter、L2 或发布验收完成。

## 参考

- [总体 host 说明](./README.md)
- [隔离会话验收清单](./acceptance-checklist.md)
- [Runtime 说明](../runtime/README.md)
- [Host acceptance gate](../HOST-ACCEPTANCE.md)
- [DSH adapter implementation](../../src/host/dsh-adapter.mjs)
- [Compression probe implementation](../../src/host/compress-probe.mjs)
