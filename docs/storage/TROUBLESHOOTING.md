# P0-STORAGE 故障 / 报错速查表

按错误码定位。所有错误都是 `StorageError`（`err.code` 可编程判断，`err.details`
带结构化上下文）。原始 Node fs 错误（ENOENT 等）如非预期路径会原样上抛，
见本表末尾。

## 错误码对照

### INVALID_INPUT — 参数/格式不合法，调用方改参数重试

| 触发场景 | 处置 |
| --- | --- |
| root 缺失 / 相对路径 | 宿主显式传绝对路径 |
| policy / renderL1 / config 未注入或缺结构 | 按 CONTRACTS §B 注入；config 至少含 core 四项数值 |
| topic key 非法（路径符、盘符冒号、`< > : " / \ \| ? *`、孤立代理码元、控制字符、全点串、首空格、尾点尾空格、保留名 con/nul/com1-9/lpt1-9（含首段）、>128 UTF16、与 core 别名冲突） | key 规则与 A 逐条对齐（R9）：Unicode/中文/内部空格/大写均合法；只改真正违规的部分 |
| summary 超 60 UTF16 或含换行 / title 空 / updated 空 | 压缩摘要后重提；summary 允许空串（R7） |
| 字符串含孤立 UTF-16 代理码元（如 `'a\uD800b'`） | 无损编码守卫（R5）：修正字符串；成对 emoji 合法 |
| change 缺 expectedRevision（未显式给） | 新文件补 `null`，已有文件补当前哈希 |
| changes 为空 / kind 非法 / 双 core / 同批重复目标 / payload 携带 scopeId / topic 的 text+topic 并存 | 修 change 结构 |
| operationId 非法（分隔符、保留名、>128） | 换合规 id |
| 大小写碰撞（目录已有 `abc.md` 时提交 `ABC`，或 scopeId `Amber`/`Global`） | 换 key/scope；Windows 大小写互斥在物理层拒绝（R9） |
| 越根 symlink/junction（factory 预检或运行期遍历发现，R4） | 检查 `err.details.link/resolved`，删除越界链接后重试；外部目录不会被写入 |
| renderL1/policy 返回形状不符契约 | 修注入实现 |
| faultAfter 取值不在五个故障点内 | 测试专用参数，查 README §5 |

### REVISION_CONFLICT — 版本冲突，先读当前状态再决定

| 触发场景 | 处置 |
| --- | --- |
| expectedRevision ≠ 磁盘哈希（含他人/手改） | 重读 snapshot，基于新 revision 重新构造候选 |
| 已有文件传 expectedRevision:null；缺失文件传非 null | 修正 null 语义（null 只表示"新建"） |
| expectedGeneration 落后 | 用 snapshot().generation 重试 |
| 同 operationId 换 payload 重放 | operationId 与 payload 一一绑定：新内容换新 id |
| 提交期间目标被外部修改（自动回滚，staging 保留） | 读 `err.details.stagingKept` 与 recover 报告，人工比对手改与候选后重提 |

### BUDGET_REJECTED — 预算策略拒绝，磁盘未变

| 触发场景 | 处置 |
| --- | --- |
| 候选完整渲染 > hardCap | 压缩候选；目录增长（topic 摘要）同样计入 |
| 当前 ≥ 增长闸门仍净增长 | 先下沉（demote 到 topic/spark）再写 |
| 超限后未净减少 | 修复提交必须净减少 |
| details.budget.reason / currentChars / candidateChars | 用于精确提示差额 |

### INVALID_STATE — 磁盘/环境状态非法

| 触发场景 | 处置 |
| --- | --- |
| topic 文件 front-matter 损坏（BOM、块标量、缺字段、重复字段、双引号非 JSON、解析值含孤立代理） | 人工修复文件为严格格式后重试；列表场景会跳过并记入 shadow 报告 |
| front-matter key/scopeId 与文件位置不一致 | 改文件头或移动文件 |
| core/topic 文件字节不是合法 UTF-8（如 61 C3 28） | 严格解码拒绝（R6）：人工修复文件；本模块绝不改写损坏文件 |
| **损坏/无法校验的 journal 存在（写入被阻塞）** | commit 抛此错（R3）：staging 证据已保留；人工核验磁盘状态后修复或移除 `journal/<opId>.json`，再重试即可 |
| journal 引用路径与 (scopeId,kind,key,index) 推导不一致或越根 | 同上按"不可校验事务"阻塞（R4）；确认为恶意/残留后人工移除 |

### UNSUPPORTED — 明确不支持（预留码，当前主路径未使用）

后续如遇不支持的操作形态（如跨 scope 写请求）会落在此码。

### NOT_FOUND — 可见范围内不存在

| 触发场景 | 处置 |
| --- | --- |
| readTopic 的 key 在 active 与 global 都无文件 | 确认 key 与 activeScopeId；该 key 可能属于其他不可见 scope |

### LOCK_BUSY — 跨进程锁超时

| 触发场景 | 处置 |
| --- | --- |
| 其他进程长持锁（长事务/卡死进程） | 查看 `err.details.phase/lock/guard`，核对持有者状态；等待或按实际负载配置 lockTimeoutMs |
| 业务锁持有者明确 ESRCH，且 guard 无残留 | 下一次获取在 guard 内回收业务锁，再按 journal 恢复 |
| 持有者 pid 存活（含与本进程同 PID 的锁，如 pid 复用残留） | 不接管：等待或按负载配置超时；若需人工恢复，先停全部使用者、备份 root，再核对所有者与残留，见 LOCK-PROTOCOL.md |
| guard 被占用/残留、锁内容不可读，或旧 moving/takenover 残留 | 保守拒绝；先停止全部存储使用者并备份整个 root，再人工核对 guard、业务锁与 journal/staging/state。未知内容保留调查，不按时间强删，见 LOCK-PROTOCOL.md |

## 常见非常规故障

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| fallback 首写 core 报 REVISION_CONFLICT（readCore 明明拿到了 global 哈希） | CAS 针对 active scope 目标文件（此时不存在），必须传 `expectedRevision: null` | 见 docs/storage/README.md §2 |
| listTopics 少了某个手改过的 topic | 该文件 front-matter 解析失败/summary 超限/key 不一致，被跳过 | `store.legacyReport().shadow` 查原因，修复文件 |
| snapshot generation 与文件内容"对不上" | 发生过手改（手改不推进 generation，由 revision CAS 反映） | 正常语义；提交前以 readCore/topic 返回的 revision 做 CAS |
| journal 目录有 `*.json` 但对应 staging 没了 | committed/aborted 终态 journal 正常保留；仅未完成 journal 才依赖 staging | 无需处理；`recover()` 报告可读 |
| staging 残留 op 目录 | aborted-with-conflicts 或 kept-no-backup 的操作刻意保留 | 人工比对后删除，或整目录留档 |
| 子进程测试被 SIGKILL 后锁未释放 | 业务 fn 内终止可回收死 PID 锁；guard 短 I/O 内终止会残留 guard | 前者下次操作恢复；后者停止全部使用者、备份并人工核对 |

## 诊断工具

```js
const d = await store.diagnostics();   // root/scope/generation/journal 数/影子清单
const r = await store.recover();       // 补账并返回逐操作恢复报告
const lr = await store.legacyReport(); // shadow（跳过的异常文件）+ legacy（旧格式）
```
