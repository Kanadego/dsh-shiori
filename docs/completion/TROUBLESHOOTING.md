# Shiori completion 状态 · 故障速查表（slot E）

适用：`src/completion/index.mjs`（openCompletionState）及接入它的桥/运行时。
所有错误都是带 `code` 的 Error；先看 `code` 再看 `details`。

## 错误速查

| code / 现象 | 含义 | 处理 |
| --- | --- | --- |
| `LOCK_BUSY`（"another live owner holds this completion state"） | 同 root+scope 已有活 owner（含同进程二次打开、其他进程） | 找到并停止旧 owner；不要删锁。pid 在 error.details.ownerPid |
| `LOCK_BUSY`（"owner liveness … could not be proven dead"） | 残留锁存在但无法证明 owner 死亡（EPERM 等） | 人工确认 owner 进程已死后再试一次；仍失败则人工备份后删锁（见下） |
| `LOCK_BUSY`（"unreadable / no usable owner pid"） | 锁文件损坏或半写 | 人工核对 `completion-lock-*.json` 内容；确认无活 owner 后备份再删 |
| `INVALID_INPUT`（root 相关） | root 非绝对路径 / 是 home / 是 symlink / 非目录 | 换专用 stateRoot；不要用用户 home |
| `INVALID_INPUT`（"state file is empty / not valid JSON"） | 状态文件空或损坏（不得自动归零） | **不要删除**：先备份文件，人工检查内容（可能含最后水位），确认后删除或修复再重启 |
| `INVALID_STATE`（"state file is a symlink / is a directory"） | 状态路径被替换成链接/目录 | 排查是谁写的；删除异物前备份 |
| `INVALID_STATE`（"completion state is closed"） | close 之后调用 save/load | 编程错误：句柄生命周期管理；重新 openCompletionState |
| `diagnostics.durable === "degraded"` | 上一次 save 失败（磁盘满/权限/只读等）或存在丢失的保存 | 查 `lastSaveError`；内存仍在推进但**跨重启去重不完整**，恢复后重放可能重新推进（fail-safe 方向） |
| `diagnostics.lostSaves > 0`（`advancedButNotDurable`） | close 完成后才到达的 save 被拒：有推进已报告但未持久化 | 调用方未按协议排空（先撤订阅 → `flushCompletedTools()` → `handle.flush()` → `handle.close()`）；核对重启后重放是否重复推进 |

## 残留文件

| 文件 | 来源 | 处理 |
| --- | --- | --- |
| `completion-lock-<scope>.json` | 当前/残留锁 | 有 ownerToken+pid；活 owner 不要动；确认死亡后可由接管逻辑自动处理（ESRCH）或人工删 |
| `completion-lock-<scope>.json.residue-<ts>-<rand>.json` | 崩溃接管时保留的证据 | 仅审计用，确认无误后可人工清理 |
| `completion-state-<scope>.json.tmp-<pid>-<uuid>` | 崩溃/失败残留的临时文件 | 不影响正确性（rename 原子）；确认无写者后可人工清理 |

## 诊断入口

```js
const diag = handle.diagnostics();
// diag.durable / diag.lastSaveError / diag.lock.residueRecovered /
// diag.persistence.windowsLimitation / diag.saves / diag.savesFailed
bridge.diagnostics().probe.sinkError   // 桥侧观察持久化失败（不吞故障）
bridge.diagnostics().probe.duplicateCallEvents        // call identity 去重次数
bridge.diagnostics().probe.advancesWithoutCallIdentity // 无法关联的双路径推进（不谎称 exactly-once）
bridge.diagnostics().probe.metaConflictEvents          // 元数据与文本矛盾次数
host.flushCompletedTools() // -> { waited, failures, dispatched } 排空并报告监听器失败
```

## 已知 Windows 限制

- 无目录 fsync：崩溃可能使 rename 回退到上一快照（见 README §5）；这是声明过的限制，不是 bug。
- 文件只读属性（FILE_ATTRIBUTE_READONLY）会让 rename 替换失败（EPERM）——测试用该特性注入保存失败。
- symlink/junction 创建需要管理员或开发者模式；`test/completion/open-state.test.mjs` 的 symlink 用例在无权限环境会显式 skip。
