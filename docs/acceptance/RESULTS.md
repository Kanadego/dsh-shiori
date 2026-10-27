# P1-ACCEPTANCE 结果（F / zcode-F，attempt 4）

记录日期：2026-10-25。Node v24.22.1，Windows 10 x64。**全部为 synthetic/replay 等级证据；
本文件不声称真实宿主（isolated-dsh）通过，也不声称实时联调成功。**

attempt 4 = 对负责人反馈（reviews/r-ad8ca735-d83d-4351-ba85-523ca31ebc7e.md）的返工：
F1 全部 runtime stop 改 await（异步拒绝不得漏）、F2 artifact 磁盘核验逐级拒绝
symlink/junction 父目录、F3 restart-dedup 回归消费注入工厂（缺 E → not-run）并把进程
边界参考实现独立命名为 restart-dedup-process。

## 1. 测试与回归（实际命令，日志在 docs/acceptance/logs/）

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `node --test test/acceptance/*.test.mjs` | **50/50 pass，0 fail，0 skipped**（attempt 3 为 48；+异步 stop 拒绝回归、+链接父目录负样本） | `acceptance-module-20261025-r4.log` |
| 全量 `node --test test/core/*.test.mjs test/host/*.test.mjs test/storage/*.test.mjs test/service/*.test.mjs test/integration/*.test.mjs test/acceptance/*.test.mjs` | **390/390 pass，0 fail，32 suites，一次通过** | `full-regression-20261025-r4.log` |
| `node src/acceptance/cli.mjs matrix --evidence-root docs/acceptance/evidence-demo --run-id cli-demo-r4` | exit 0，**13/13 passed**，bundle evidenceType=synthetic，validate+磁盘核验通过 | `cli-matrix-demo-20261025-r4.log` |
| `node src/acceptance/cli.mjs matrix --no-completion --evidence-root docs/acceptance/evidence-demo-nocompletion --run-id cli-demo-r4-nocompletion` | exit 0；**restart-dedup=not-run**（reason 含 completionFactory 缺失与重跑步骤），其余 12 项 passed —— not-run 语义可见（反馈 F3·attempt 4 恢复） | `cli-matrix-nocompletion-20261025-r4.log` |
| `node src/acceptance/cli.mjs matrix --case-evidence-type replay --evidence-root docs/acceptance/evidence-demo-replay --run-id cli-demo-r4-replay` | exit 0，**13/13 passed，bundle evidenceType=replay**；事件/生命周期 case 带 raw-event、出站 case 带 raw-request | `cli-matrix-replay-20261025-r4.log` |

历史日志全保留：attempt 1 全量 381/382（storage LOCK_BUSY，根因未定未修）+ 复跑 382/382；
attempt 2 全量 385/385；attempt 3 首跑 387/388（F3 纪律抓到超时遗留工作与清理的
ENOTEMPTY 竞态，随后加有界 settle+删除重试）+ 复跑 388/388。

## 2. 矩阵 case 结果（synthetic 全绿运行，runId=cli-demo-r4）

证据落盘 `docs/acceptance/evidence-demo/`；bundle `evidenceType=synthetic`，validate 通过。
**期望字节全部来自矩阵独立夹具 `MATRIX_FIXTURE`（不经 service 返回值反推）。**

| case | 状态 | 说明 | 证据 |
| --- | --- | --- | --- |
| shadow-clean | passed | 出站 system 与夹具 host-own 常量字节一致（零注入）；零 section/工具/写入 | raw×1 + normalized×1 |
| active-ownership-conflict | passed | 预置同名工具时 active start 拒绝，注册全回收（含订阅 dispose），零写入；start 错误留档 | raw-event |
| full-system-first | passed | 首请求 = 夹具常量拼出的 L0+完整 L1（含矩阵自渲染派生索引）字节级比对 | raw×1 + normalized×1 |
| write-next-request | passed | core_write 写入夹具常量正文后，下一请求与夹具派生期望字节一致；窗口内全部请求留档 | raw×2 + normalized×2 |
| route-switch | passed | route-a/route-b 完整投影均与夹具期望字节一致，宿主自有内容保留 | raw×2 + normalized×2 |
| compress-direct | passed | 直接模式（meta.blocksCreated）推进一次，同 seq 重放去重；raw 事件经基线 mapRawSessionEvent | raw-event |
| compress-ptc | passed | PTC 已证实回执格式推进一次；PARTIAL 有块推进一次；重放去重 | raw-event |
| compress-negative | passed | 失败/零块/无证据/开始事件/普通工具文本含「→ N block(s)」均不推进，epoch 恒 0 | raw-event |
| restart-dedup（attempt 4 回归注入消费） | passed | **消费注入 completionFactory/runtimeFactory**：同 root/scope 二次打开恢复水位、重放 duplicate 不推进、新事件推进到 2；三次派发回执留档；stop 全 await | raw-event |
| restart-dedup-process（独立参考 case） | passed | 两个独立 node 子进程先后打开同一持久 root/scope：advance 推进 epoch=1 落盘退出；replay 进程 restoredFromSink、重放不推进、新事件推进到 2；pid 互异留档 | raw-event |
| operation-replay | passed | 同 operationId+同 payload 回执稳定，正文只落一次；跨进程变体在 global-fallback | raw-event |
| stop-cleanup | passed | **全部 stop await**（含二次幂等 stop 的 await 与异步拒绝捕获）；资源计数器断言订阅 dispose/注册全回收/restart 复原；失败 start 探针零残留 | raw-event |
| global-fallback | passed | 真实基线 service/store：active 无 core 逐字节回落 global；core_write 提交活动域副本、global 不变、active 遮蔽回落；same-operationId 同进程幂等 + 独立子进程重放回执一致不二次应用 | raw-event |

## 3. failed / not-run 项

- synthetic 全绿运行：无 failed、无 not-run（13/13）。
- `--no-completion` 对比运行：**restart-dedup=not-run**（缺注入 completionFactory，附重跑
  步骤）；restart-dedup-process / global-fallback 自带边界照常通过；bundle 保持 synthetic、
  validate 通过。缺 runtimeFactory 的 not-run（11 项）由单测覆盖。
- 异步 stop 拒绝负样本（单测）：注入 stop 返回宏任务后拒绝的 runtime → stop-cleanup 与
  full-system-first 如实 failed（reason 含 async stop rejected），无静默通过。
- 链接父目录负样本（单测）：artifact 文件移出 root、经 junction 父目录回指、字节与
  SHA256 全部"正确" → 磁盘核验拒绝（ARTIFACT_PARENT_LINK）。
- teardown 纪律（attempt 3 保留）：捕获停止后仍报 started / stop 抛错 / 清理失败 →
  整次运行 INVALID_STATE（phase=teardown），不产出 bundle；主流程异常不被掩盖。

## 4. replay 等级路径（注入式，可运行）

`--case-evidence-type replay`（`docs/acceptance/evidence-demo-replay/`）：13/13 passed、
case 级与 bundle 级均为 replay、事件/生命周期 case 携带 raw-event、出站 case 携带
raw-request、validate 通过。**注入声明的回放等级，不等于实时联调成功，也不是 isolated-dsh。**

## 5. 未覆盖 / 缺口（不在 synthetic/replay 能力内，标 P1b）

- **isolated-dsh：0 项**。真实 DSH 出站、真实 direct/PTC 完成事件、真实宿主路由，均需负责人
  在隔离测试 profile 下运行（`docs/HOST-ACCEPTANCE.md`）。runner 拒绝 `caseEvidenceType`
  自我声明 isolated-dsh（INVALID_INPUT）。
- restart-dedup-process 是**参考 synthetic 句柄**（无跨进程互斥 owner）的进程边界证据，不
  消费注入工厂、不声称 E 集成；真实 E handle 互斥与真实 DSH 宿主跨进程组合属 E 契约与
  负责人 P1b 边界。
- 超时 case 的遗留工作不取消（JS promise 无法取消）：runner 有界等待（20s）其 settle 后再
  清理；超预算则清理按 teardown 失败显式上报（不静默）。
- Windows 目录 fsync 未声称（见 README §5）。
- 付费 provider 实时联调：未运行、不允许由本工具触发。
