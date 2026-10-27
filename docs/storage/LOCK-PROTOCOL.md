# Guard-lock 本地集成协议

2026-10-24 根目录继续使用独立验收的 guard overlay；该协议是当前 README / TROUBLESHOOTING 的依据。存储原基底为 B a4-33db60c7-d6d0-479c-b88a-1de433e0ff2d；B a8 已独立验收 accepted，现选择性合入其 store.mjs 的 scopeId 校验及 commit 回归，其余生产模块与 a8 相同。a8 的 v6.2 meta-lock 及专属测试/文档未覆盖进根，不能混跑两种协议。guard 验收与 hash 见 collab/reviews/B-lock-repair/AMBER-ACCEPTANCE.md 与 REPORT.md；本轮集成边界见 collab/reviews/B8-root-integration-20261024.md。

所有参与者先原子 mkdir .shiori-lock.guard，然后执行读取锁、判断 PID 死亡、删除确认死亡者、硬链接发布新锁、检查 token 并释放锁中的某个短操作。guard 不覆盖业务 fn；业务期间 .shiori-lock 负责持有者排他。所有公共锁路径的修改都在同一 guard 下，旧快照不可能跨出 guard 后再据以移动新 owner。无 rename 覆盖还原分支。

只有 process.kill(pid,0) 报 ESRCH 证明进程不存在，才能回收业务锁。权限/未知 PID 错误、空/损坏锁、读取/枚举错误、旧 moving/takenover 残留都明确失败。保留同链路 ALS 重入，同进程队列；fn结束后 detached descendants 无重入权限。所有参与者必须停止旧协议再切换，不能混跑。

## 故障边界与人工恢复

业务 fn 内崩溃会留下死 PID 业务锁，下次可自动回收并按 journal 恢复。guard 短 I/O 内崩溃会留下 guard，后续 LOCK_BUSY，不自动回收 guard，这是安全换可用性的明确取舍。任何人工恢复前，先停所有存储使用者并备份整个合成/目标 root，再核对 guard、.shiori-lock、journal/staging/state；确认无存活使用者后才处理残留。不得在运行时按时间阈值强删，未知内容保留调查。本文不授权修改真实记忆目录。

Windows 目录 fsync 仍不承诺断电级持久化，PID 重用会导致 fail-closed。跨进程协议只约束采用同一实现的参与者，不防同权限恶意进程在 guard 内改盘。

## 回归

根全量 340/340（32 suites），并发/guard/commit 定向 48/48（8 suites）；本轮日志见 collab/reviews/root-B8-integration-verified-20261024.log 与 B8-focused-20261024.log。storage 覆盖 B 原有 137 项 + a8 scope 回归 1 项 + guard-lock 新增 24 项（定点强杀、真实 fs 门控 stale-read / acquire / release、异常清理等）。旧 a4 K3 故障夹具保留在 collab/reviews，不计入正常通过套件，因为它专门证明未修改的 a4 仍有缺陷。
