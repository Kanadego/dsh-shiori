# 隔离会话验收清单 · Shiori host bridge（P0 → 切换前门槛）

> 目的：把 DESIGN.md §11.2 的「完整 system 与缓存回归矩阵」「压缩检测探针」从
> 静态核对推进到**隔离会话实测**。全部通过之前，不得宣称 Shiori 可替代 soul-md，
> 也不得在真实 profile 启用 active 模式。
> 原则：不自动发模型请求、不改路由、不重启 DSH —— 由操作者执行每一步，本清单供逐步打勾。

## 0. 准备（人工操作）

1. **备份**：快照 `~/.dsh/settings.yaml`、soul-md 设置命名空间、`~/.dsh/soul-md/memory/<persona>/`（文件数 + SHA256 清单）。
2. **隔离**：新建测试 profile / 测试工作区（不指向 `~/.dsh/profiles/web` 的真实记忆）；确认 bili 版本号与探针时的 `0.1.204` 是否一致，不一致需重跑 §11.2 探针。
3. **部署物**：以 shadow 模式装载桥（或仅注入事件探针），确认 `node --test test/host/*.test.mjs` 全绿后再进入实测。
4. **哨兵**：在测试 core.md 写入唯一哨兵字符串（如 `SHIORI-PROBE-V1-<随机串>`），用于出站请求比对；抓包只记录哨兵命中与否 / hash / 计数。

## 1. 宿主 surface 检查（无需模型请求）

- [ ] shadow 启动后：零同名工具注册、零 section 注册、零资料写入（对照 `bridge.diagnostics()`）。
- [ ] 隔离会话内以 active 启动（`allowActive:true`）；宿主未卸载 soul-md 时必须被唯一写者校验拒绝（INVALID_STATE）。
- [ ] 卸载 soul-md 后 active 启动成功：`shiori:persona`(order 0)、`shiori:core`(order 0.5) 在宿主 assemble 结果中出现；工具面板出现 9 个兼容工具且仅此提供者。
- [ ] 会话 decode（`session.v4.jsonl.zstd`，只读）确认 `system/message` 节点含哨兵与索引行，无 L2/spark 内容。

## 2. 压缩事件探针（§11.2 P0）

- [ ] 测试会话放入可压缩内容，执行一次成功 compress（人工触发）。
- [ ] 解码会话事件：确认出现 `tool/ptc-dispatch`（name=compress）；核对 `bridge.diagnostics().probe.epoch` 是否 +1，且与回包实际创建块数一致。
- [ ] 若本机模式为直接调用（无 PTC）：核对 `tool/call` + `tool/result` 是否可见、`meta.blocksCreated` 是否携带数值；若都不携带，记录「直接模式块证据缺失」为兼容受限——epoch 不推进是**预期行为**，不是缺陷。
- [ ] 失败 compress（断代理/零内容）与零块 compress：epoch 必须不变。
- [ ] 同一 eventId 重放（重启 DSH 后重放会话）：epoch 不再推进（持久化文件 `seenEventIds` 生效）。
- [ ] token 用量骤降但 compress 失败的场景：epoch 不变（证明不靠 token 推断）。

## 3. 完整 system 与缓存回归矩阵（§11.2 P0，逐项打勾）

对每项记录：宿主 surface decode 结果 + 实际出站请求（抓包哨兵命中）+ usage（input/cached/uncached；无 cached 字段标「未知」）。

- [ ] **M1 baseline→V1**：修改 L1（哨兵 V1）→ 下一次请求最新完整 system 同时含 persona、core V1、index、宿主其他 section；历史稳定前缀逐字可比较。
- [ ] **M2 压缩后不改**：成功压缩一轮 → 不改 L1 → 发请求：最新完整 system 未丢失、可重建。
- [ ] **M3 压缩后再改**：成功压缩一轮 → 改 L1 为 V2 → 发请求：宿主 surface、出站请求、模型复述三处一致。
- [ ] **M4 连续修改**：连续修改 ≥5 次，量测历史中完整 system 副本数与字符增长；随后新系列 / 恢复会话 / 切换 in-history 支持/不支持路由，检查旧副本逻辑清空与最新版有效性。
- [ ] **M5 缓存记录**：每次请求记录 input / cached / uncached；服务端无 cached usage 时写「未知」，禁止写「缓存不破」。

## 4. 通过判据

- §2 全部符合预期（含「不推进」的反向用例）。
- §3 M1–M5 无一失败；M4 中 in-history 与非 in-history 路由分别有记录。
- 任何一项失败：记录失败项 + 证据（decode 片段/抓包计数），阻止该路由/bili 组合的切换验收，按 DESIGN.md §5.2(3) 处理，不假装已修复。

## 5. 证据留存

- 每项打勾附：日期、DSH/bili 版本、会话 id、decode 关键 seq、哨兵命中结果。
- 抓包与 decode 产物放临时目录，验收后删除，不进仓库；报告只留 hash/计数。
