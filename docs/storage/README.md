# P0-STORAGE 文件仓库 · 设计与运维说明

模块：`src/storage`（公共入口 `src/storage/index.mjs`，导出 `createFileStore`）
契约：`collab/CONTRACTS.md` §B。P0 不做 SQLite、跨库沉降、真实迁移、撤销（undo）。

## 1. 磁盘布局

```
<root>/                         root 必须由宿主显式提供（绝对路径），无隐式 home 默认值
├── scopes/
│   ├── global/core.md, topics/<key>.md     共享 scope；仅 active=global 时可写
│   └── <scopeId>/core.md, topics/<key>.md  私有 scope；提交永远只写 active scope
├── journal/<operationId>.json  持久 prepare/commit/recovery 日志（提交协议真相源）
├── state/current.json          {generation, lastOperationId} 提交代指针（缓存，可由 journal 推导）
├── staging/<operationId>/      提交暂存（after 字节 + 目标备份字节）
├── .shiori-lock                跨进程业务持有者文件
└── .shiori-lock.guard/          短元数据互斥目录；残留时不自动抢占
```

root 内其余条目（persona/、config.json、sparks.db 等）不归本模块管，不读不写。

## 2. 关键语义

- **revision** = SHA256(目标文件在磁盘上的实际 UTF-8 字节)；文件不存在为 `null`。
  手改文件会改变 revision，下一次提交的 CAS 会如实拒绝——不存在"绕过哈希"的路径。
- **generation** = per-root 的提交代号（从 0 递增的整数）。同 root 的所有实例
  （含不同 activeScopeId）共享同一序列；`expectedGeneration` 不一致即 REVISION_CONFLICT。
- **操作身份（幂等键）** = 可信 `activeScopeId` + `expectedGeneration` + `changes`
  的稳定序列化哈希（R1）。同 scope 同 payload 重放幂等；跨 scope 用同一
  operationId 不得命中彼此的成功结果。
- **CAS 语义**：`expectedRevision` 针对将被写入的那个文件（active scope 内），不是
  fallback 视图来源的文件。active core 缺失、global 存在时，首次写 core 必须传
  `expectedRevision: null`（详见 TROUBLESHOOTING "fallback 首写冲突"）。
- **预算**：policy 收到的 `currentText/candidateText` 由注入的 renderL1 对"完整可见
  快照"（core 有效投影 + 可见 topics 索引）渲染生成，绝不只量 core 正文。
  拒绝时抛 BUDGET_REJECTED，发生在任何磁盘写入之前。
- **key 规则与 A 逐条对齐（R9）**：Unicode 合法（如中文专题）、128 UTF-16 上限、
  拒绝孤立代理码元/控制字符/Windows 禁用文件名字符/全点串/首空格/尾点尾空格/
  保留设备名/core 别名；B 另在物理层拒绝 Windows 大小写别名碰撞（含 scopeId
  与 global 的大小写互斥）。summary 允许空串但不得含换行（与 A.validateTopic 一致）。
- **写入 scope 校验（B a8）**：对象和裸 text 的 front-matter scopeId 均须等于可信 activeScopeId；不一致返回 INVALID_INPUT，目标文件和 generation 不变。
- **无损编码（R5/R6）**：写入侧拒绝含孤立 UTF-16 代理码元的字符串（INVALID_INPUT）；
  读取侧严格 UTF-8 解码，磁盘字节损坏显式 INVALID_STATE，不静默替换、不改写原文件。
- **读取一致性**：所有读操作持锁并先补账（见 §4），然后读完整已提交状态；
  不会读到一半 rename 的混合代。锁被其他进程长持有时读会等待，超时抛 LOCK_BUSY。
- **幂等**：同 `operationId` + 同 payload（含 scopeId/expectedGeneration/changes）
  重放 → 返回已记录结果；不同 payload → REVISION_CONFLICT。
  aborted 操作允许同 payload 全新尝试。
- **损坏 journal 阻塞写入（R3）**：存在损坏/无法校验的 journal 时，commit 显式
  抛 INVALID_STATE 拒绝写入；其 staging 证据保留，直到人工核验后处理。读取仍可用。

## 3. 提交协议（全程持跨进程锁）

当前根目录采用独立审阅的 guard-lock 修复（详见 [LOCK-PROTOCOL.md](LOCK-PROTOCOL.md)）。B a4 的旧 moving-marker 协议在 K3 回归中确定复现双 owner 竞态，未被验收；原始封包和失败证据保留。B a8 现已独立验收 accepted；根选择性合入其 store.mjs 的裸 text scopeId 校验及 commit 回归，其余生产模块与 a8 相同，但保留 guard 协议及配套测试/文档，未混入 a8 v6.2 meta-lock。集成清单见 [B8-root-integration-20261024.md](../../collab/reviews/B8-root-integration-20261024.md)。

- 原子 `mkdir(.shiori-lock.guard)` 串行覆盖锁读取、确认死亡者回收、硬链接发布与所有者校验后释放。锁文件发布前已写入完整 pid/token 并 fsync。
- 只有 `process.kill(pid, 0)` 返回 ESRCH 才确认死亡；存活 PID（包括同 PID）、未知/损坏内容、权限或枚举错误都不会触发抢占。
- guard 只覆盖短元数据操作，业务临界区由 `.shiori-lock` 持有者保证排他。竞争者可短暂持 guard 读取活 owner，不能进入其业务临界区。
- guard 永不自动回收；guard 操作内崩溃会拒绝后续访问，须停止全部使用者、先备份再人工核对。业务 fn 内崩溃且无 guard 残留时，死 PID 业务锁可自动回收并执行 journal 恢复。
- 所有参与者必须停用旧锁后统一升级；旧 moving/takenover 残留会阻塞获取。没有“错移后 rename 覆盖恢复”的分支。

```
CAS 校验（expectedGeneration + 每笔 expectedRevision，rename 前还会复核）
  → 注入 policy 预算评估（拒绝则抛 BUDGET_REJECTED，磁盘零写入）
  → staging 写 after 字节 + fsync
  → journal(prepared) + fsync                      ← 持久化开始
  → 备份每个已存在目标的当前字节 + fsync
  → journal(committing)
  → 逐文件 rename（原子替换；rename 前复核哈希，发现第三方改动立即中止回滚）
  → journal(committed)（含 result，幂等重放的来源）
  → state/current.json 推进 generation
  → 清理 staging，释放锁
```

Windows 说明：单文件原子替换用 Node `rename`（MoveFileExW + REPLACE_EXISTING）。
多文件提交的原子性由 journal 协议 + 恢复补账保证，不依赖单条 rename 的原子性。

## 4. 崩溃恢复（recover() 或任意操作前自动补账）

对每个未完成 journal（phase = prepared / committing）逐条决策。**journal 枚举
先做协议形状校验（J1）**：非 plain object、缺 operationId/scopeId/payloadHash/
generation、phase 非法、changes 非数组、operationId 与文件名不一致等一律记为
`blocked-corrupted-journal`（含原因）——合法 JSON 的坏记录同样不得静默遗漏，
其路径字段不可信、不使用；校验先于一切清理/恢复/指针推导。

| 磁盘现状（逐目标比对哈希） | 动作 |
| --- | --- |
| = afterRevision | 视为已应用 |
| = beforeRevision（或缺失且 before=null） | prepared → 干净中止；committing → 从 staging 补完 rename |
| 其他（第三方新内容/手改） | **冲突：绝不覆盖**；已应用条目从备份回滚，operation 记 aborted-with-conflicts |

- journal 内引用的每个路径都按 (scopeId, kind, key, index) 重新推导并比对，
  不一致或越根的一律视为"不可校验事务"阻塞（不执行、不清理证据）（R4）；
- 全部目标回到 before 态 → 干净中止（aborted-clean），staging 删除；
- 全部补完 → 补写 committed 标记、推进 generation 指针；
- journal 已 committed 但指针落后（崩溃在两者之间）→ 指针推进到已提交代；
- 指针文件缺失/损坏 → 从 committed journal 推导重建；
- 孤儿 staging（无未完成 journal 且非冲突保留）→ 删除；
- **aborted-with-conflicts / kept-no-backup / blocked（损坏 journal）的 staging 保留**
  （含 after 字节与备份），供人工挽回，不自动清（R3）；
- **损坏/不可校验 journal 存在期间写入被阻塞**（commit 抛 INVALID_STATE），
  人工核验磁盘状态后修复或移除该 journal 文件即可恢复（R3）。

### 数据丢失判据（测试与验收一致口径）

恢复完成后，每个提交涉及的目标文件必须处于且仅处于 before 态或 after 态；
不存在第三种"半写入"状态。判据成立的边界：

1. 只有本模块（持锁协议）与"手改文件的人"两类写者时，任何时点强杀进程都不丢已提交数据；
2. 恢复永不覆盖第三方新内容（哈希既非 before 也非 after 的文件原样保留并在报告中列出）；
3. 若外部程序绕过锁直接写文件，则只能保证"不覆盖它"，不保证时序（见 §6 限制 8）。

## 5. 故障注入方式（测试用，生产勿用）

- `createFileStore({..., faultAfter})`：取值
  `prepare`（journal(prepared) 落盘后）/ `backup`（备份完成后）/
  `first-rename`（第一个目标 rename 后）/ `renames`（全部 rename 后、committed 标记前）/
  `marker`（committed 标记后、指针推进前）。触发时进程对自身 SIGKILL。
- 测试经 `test/storage/bin/crash-child.mjs` 在子进程中设置 faultAfter，
  父进程验证磁盘残留与恢复结果，对应"持久阶段子进程强退恢复"要求。
- 跨进程并发用 `bin/racer.mjs`（barrier 后同窗口抢 CAS）与
  `bin/writer.mjs`（连续翻转 core 供并发读）。
- 运行：`node --test test/storage/*.test.mjs`

## 6. 已知限制（P0 边界，逐条如实声明）

1. **无目录 fsync**：Windows 不支持目录句柄 fsync。断电（非进程强杀）时 rename/
   目录项的持久顺序无保证；靠 journal 推导恢复，极端断电可能需要人工比对 staging。
2. **锁回收与可用性**：仅在 guard 内且 PID 明确 ESRCH 时回收业务锁；同 PID 缺 token 不是死亡证据。guard 崩溃残留、未知锁、旧移动/隔离残留都保守阻塞。PID 重用也可能导致超时。人工恢复须停止所有使用者并先备份，见 LOCK-PROTOCOL.md。
3. **MoveFileEx 替换的原子性**：同卷 rename 替换在 Windows 上实践原子，但微软未承诺
   与 POSIX rename 等价的崩溃语义；单文件损坏的最终防线是 staging 备份。
4. **无删除/撤销**：契约未含 topic 删除；撤销（undo）留后续任务，本批不实现不声明。
5. **legacy 只读**：无 front-matter 的旧 Markdown 可读：title/summary 推导、
   updated 用哨兵串 `legacy-unknown`（保证 DTO 可通过真实 A 校验，R8）；推导摘要
   超 60 UTF16 时影子索引按规则截断显示（全文保留在 body 与 legacySummaryFull，
   原文件不动，报告声明非无损迁移）；带 BOM / 块标量 / 列表等格式明确 INVALID_STATE。
6. **generation per-root**：不同 scope 的 store 共享同一 root 的提交代序列，
   这是刻意的（防跨 scope 丢失更新），上层编排需按 snapshot 的当前代做 CAS。
   操作身份（幂等键）包含 scopeId，跨 scope 不会命中彼此的幂等结果（R1）。
7. **测试 stub 与真实 A 并行**：单测用契约等价 stub；集成测试（test/storage/
   integration-a.test.mjs）以 A 提交包 a2-b99d1031 的 renderL1/evaluateMutation/
   DEFAULT_CONFIG/validateKey 注入实际运行（R8/R9）。
8. **绕锁写不受保护**：协议只约束走 store 的写者与可被 CAS 发现的手改；
   外部程序绕过锁高频直写文件不属于可防御范围。
9. **journal 累积**：committed/aborted journal 长期保留作审计，P0 未做归档轮转。
10. **集成测试的路径依赖**：integration-a.test.mjs 以绝对路径引用
    `collab/submissions/A/a2-b99d1031-…/files/src/core/index.mjs`（只读）；
    该提交包若被移动/清理，此测试文件会失败（其余测试不受影响）。

## 7. 文件清单

```
src/storage/
├── index.mjs        公共入口（createFileStore、StorageError）
├── store.mjs        核心实现：提交协议、恢复补账、可见视图
├── lockfile.mjs     跨进程 guard + hardlink 业务锁、PID 检查、进程队列/重入
├── journal.mjs      journal 读写/枚举/稳定 payload 哈希
├── frontmatter.mjs  topic front-matter 严格子集（JSON 双引号标量）序列化/解析
├── paths.mjs        key/scopeId/operationId 校验、大小写碰撞、symlink/junction 越根检查
├── fsutil.mjs       fsync 写、原子替换、SHA256、稳定序列化
└── errors.mjs       StorageError（INVALID_INPUT/REVISION_CONFLICT/BUDGET_REJECTED/
                      INVALID_STATE/UNSUPPORTED/NOT_FOUND/LOCK_BUSY）
```

报错与处置对照见同目录 `TROUBLESHOOTING.md`。
