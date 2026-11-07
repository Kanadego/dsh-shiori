# 只读审计报告：存储层 + 服务层 + 核心渲染（task-faffef9b64781399-s1）

- 审计人：agent:zcode-auda
- 日期：2026-11-07
- 基线：D:/AIagent/wt-shiori-audita @ dd27150（工作树未做任何源码/测试/配置改动，唯一产物为本报告）
- 范围：src/storage/*.mjs、src/service/index.mjs、src/core/*.mjs、src/sparks/*.mjs、src/forgetting/*.mjs 及对应 test/
- 方法：全量通读目标源码（26 文件 / 7797 行）→ grep 交叉验证 → node --test 全量 → 临时目录复现脚本逐条验证（脚本留在 %TEMP%\wb-audit-repro\，未进仓库）

---

## 一、结论摘要

**P0（会丢数据 / 写坏状态 / 安全边界破口）：无。**

**P1：无。**

**P2（口径 / 一致性 / 卫生问题，均有 `路径:行号` 与复现）：**

| # | 一行结论 |
|---|---|
| P2-1 | `archivedAt` 的 ISO 校验是宽松口径：`"March 5, 2026"`、`"2026"`、`"Feb 30, 2026"` 等非 ISO 串被 service 与 storage 两层接受并原样落盘，与错误文案承诺的 ISO 8601 不符 |
| P2-2 | 读路径对手改的 `archivedAt` 任意垃圾串照单全收并标记 archived，与「summary 超 60 进 shadow」的防线强度不一致 |
| P2-3 | `updated` 元数据完全无格式校验，任意非日期串可落盘，与 `archivedAt` 的校验强度不对称 |
| P2-4 | storage 层文件系统 IO 异常以裸 fs 错误冒泡（如 `EPERM`），不带稳定业务码也不是 StorageError，与 sparks 层 `IO_ERROR` 包装约定不一致 |
| P2-5 | revision token 的摘要是无密钥 SHA-256，可被任意持有者重签；配合 `checkSources` 对 `projectionHash` 的「有值才校验」，带投影哈希的 core token 可被剥掉该字段绕过「渲染视图未变」检查（威胁模型部分待核） |
| P2-6 | `journal.mjs` 的 readJournal 损坏包装用的是裸 `Error`+code，不是 StorageError（当前调用序下基本不可达，属形状不一致的死防御分支） |
| P2-7 | 死代码 7 处：`storage/errors.mjs unsupported()`、`storage/store.mjs export{sleep}`、`sparks/errors.mjs lockBusy()` 为零调用；`holdsLock`/`legacyReport`/`diagnostics`/`isSparkToolError`/`selectVisibleTopics` 为仅测试引用 |

---

## 二、逐条详述

### P2-1 `archivedAt` ISO 校验宽松，非 ISO 日期串混过（双层）

- **现象**：service 层用 `new Date(value)` 判合法性，storage 层用 `Number.isNaN(Date.parse(value))`——两者都是 V8 宽松解析，接受英文日期、裸年份、甚至滚动出来的假日期；而两处的报错文案都自称「ISO 8601」。
- **位置**：
  - `src/service/index.mjs:228`（`Number.isNaN(new Date(value).getTime())`）；
  - `src/storage/store.mjs:772-774`（`Date.parse`）；
  - `src/storage/frontmatter.mjs:68`（`Date.parse`，直连序列化路径）。
- **为什么是问题**：归档时间戳的语义失真——后续面板排序/展示（L3 规划中）拿到的不是可比较的 ISO 串；且与 forgetting 层的规范口径（`forgetting/decay.mjs:221-233` 要求 `new Date(v).toISOString()===v`）不一致，同一仓库三种时间校验强度。
- **最小复现**（已在临时脚本验证，实测输出）：
  ```
  A1  service.mutate(... archivedAt:'March 5, 2026')        → 成功落盘，回读 archivedAt="March 5, 2026"，listTopics archived=true
  F1  store.commit(... topic.archivedAt:'2026')             → 成功，front-matter 落盘 archivedAt: "2026"
  F2  store.commit(... topic.archivedAt:'Feb 30, 2026')     → 成功（3 月 2 日滚动通过）
  ```
  对照：`test/service/archived-topic.test.mjs:114-129` 只测了 `'not-a-date'`/`''`/`123`，宽松日期恰是盲区。
- **修复方向**：三层统一改用规范校验 `typeof v==='string' && new Date(v).toISOString()===v`（同 `cold-search.mjs:37-41 isCanonicalIso`）；若决定保留宽松口径，则同步修改报错文案与契约描述，不再声称 ISO。

### P2-2 读路径信任手改的 `archivedAt` 垃圾串（防线不对称）

- **现象**：`#effectiveView`/`readTopic` 对手改文件的校验有 summary 超 60 进 shadow、summary 含换行进 shadow、key/scopeId 不一致进 shadow，唯独 `archivedAt` 只判「非空即归档」，任意串直接当归档时间采信。
- **位置**：`src/storage/store.mjs:302-306`（`...(meta.archivedAt ? { archivedAt: meta.archivedAt } : {})`）与 `src/storage/store.mjs:360-364`；`src/storage/frontmatter.mjs:171-182`（parse 侧必填/非空校验清单不含 archivedAt 格式）。
- **为什么是问题**：本仓库对「手改无效」数据的统一姿态是进 `lastScan.shadow` 或抛 INVALID_STATE（如 summary）；archivedAt 是唯一被无校验信任的元数据字段，P2-1 的宽松写入加上这里的零校验，垃圾值可长期驻留并向上游（`service.listTopics` 的 `archived` 布尔，`src/service/index.mjs:154-156`）扩散。
- **最小复现**（实测）：手写 topics/plan-f.md，front-matter 带 `archivedAt: "totally-garbage"` → `store.readTopic` 返回 `archivedAt:"totally-garbage"`，`listTopics` 标记 archived；无 shadow 记录。
- **修复方向**：读路径对 `archivedAt` 非空时做与 P2-1 相同的 ISO 校验，违规进 shadow（与 summary 同等待遇）或抛 INVALID_STATE。

### P2-3 `updated` 无任何格式校验

- **现象**：service mutate 的元数据白名单里，`archivedAt` 有日期校验，`updated` 只要通过 `text()`（非空由 storage 层兜底）就原样落盘；storage 层 `#validateTopicMeta` 对 updated 也只查非空。
- **位置**：`src/service/index.mjs:243`（`updated: text(c.topic.updated ?? token?.issuedAt, 'updated')`）；`src/storage/store.mjs:768-770`（仅 `meta.updated.length === 0` 拒绝）。
- **为什么是问题**：同一白名单四个字段两种校验强度；`updated: "garbage-not-a-date"` 可落盘（实测），后续任何按时间排序/展示的消费方拿到不可解析字符串。core 层 `topics.mjs:86-93` 甚至允许 number/Date，三层口径互不一致。
- **最小复现**（实测）：`service.mutate({changes:[{kind:'topic', expectedRevision:<token>, key:'plan-a', topic:{ updated:'garbage-not-a-date' }, text:…}]})` → 成功，回读 `updated="garbage-not-a-date"`。
- **修复方向**：service 层对 caller 提供的 `updated` 做与 archivedAt 同款（建议规范 ISO）校验；token 继承路径（issuedAt 本身已是 ISO）不受影响。

### P2-4 storage 层 IO 异常裸抛，破坏「错误一律带稳定 code」契约

- **现象**：`store.commit` 全程的文件写入/读取异常（staging 写、备份写、rename、`readFileOrNull` 的非 ENOENT 分支）直接冒泡 libuv 原始错误：`name="Error"`、`code="EPERM"` 等，既不是 StorageError，也不在契约码表（INVALID_INPUT/INVALID_STATE/REVISION_CONFLICT/BUDGET_REJECTED/NOT_FOUND/LOCK_BUSY/UNSUPPORTED）内。sparks 层同样场景有 `wrapIoError` 包装成 `IO_ERROR`+ioCode+cause，lockfile 层全线包装成 LOCK_BUSY，唯独 storage 主体没有。
- **位置**：`src/storage/fsutil.mjs:57-64`（readFileOrNull 直接 rethrow）、`src/storage/fsutil.mjs:78-86`（writeFileSynced 的 open/write/sync 裸抛）、`src/storage/store.mjs:620-622`（staging 写）、`src/storage/store.mjs:640-644`（备份写）、`src/storage/store.mjs:660`（rename）；对照 `src/sparks/errors.mjs:56-63`。
- **为什么是问题**：调用方（service/host 工具按 `e.code` 分派）无法把「磁盘满/权限被拒」与用户输入错误区分开；同一类失败在 sparks 是 IO_ERROR、在 storage 是裸 EPERM，行为不可预期。失败本身的 fail-closed 语义没问题（journal 停在 prepared，下次 reconcile aborted-clean，实测残留 `journal/op-deny.json` 被正确按 prepared 处理）。
- **最小复现**（实测）：对 `<root>/scopes/amber/topics` 执行 `icacls /deny *S-1-1-0:(WD,AD,DC)` 后提交 topic 变更 → 捕获 `name=Error code=EPERM msg="EPERM: operation not permitted, open '<root>\scopes\amber\topics\.t1.md.tmp-…'"`。
- **修复方向**：在 fsutil/store 边界加与 sparks `wrapIoError` 等价的包装（建议 `IO_ERROR` 或 `INVALID_STATE`+`ioCode` details），保持 cause 链。

### P2-5 revision token 无密钥可重签；projectionHash 可被剥离（部分待核）

- **现象**：token 编码 `PREFIX + base64url(json) + '.' + sha256(body)`，摘要无密钥；`checkSources` 仅在 `t.projectionHash !== null` 时才校验渲染快照。
- **位置**：`src/service/index.mjs:26-29`（encode）、`src/service/index.mjs:33`（裸 sha256 摘要）、`src/service/index.mjs:109-114`（条件校验）。
- **为什么是问题**：任何拿到 token 的调用方都能改动 body 后重算摘要造出「合法」token。伪造 token 的实际增益有限——`checkSources` 会把 sourceRevision/meta 与磁盘真值比对（`src/service/index.mjs:103-121`），伪造等价于真 token；但**剥掉 `projectionHash` 字段重签**即可绕过 readCoreView 的「渲染视图未变」乐观锁（最后一次写入者获胜）。面板/外部编辑流若依赖该检查防覆盖，防线形同虚设。
- **待核部分**：威胁模型取决于谁能直接调 `service.mutate` 而不经过 host 工具门面（host 侧 read-then-CAS 用的是 `readCore()` 裸哈希 token，不带 projectionHash，见 `src/host/tools.mjs:318`）；若 projectionHash 仅服务本机面板且 mutate 只经 host 门面暴露，则为低危设计取舍。给不出直接可达的攻击路径，故按「待核」降级处理，不当结论。
- **修复方向**：若确认面板路径暴露 mutate：摘要改 HMAC（密钥进程内生成）或将 projectionHash 纳入 token 必填校验（kind=core 且来自 readCoreView 时不得为 null）。

### P2-6 readJournal 损坏包装的错误形状不一致（基本不可达）

- **现象**：`journal.mjs:42-45` 对损坏 journal 构造的是 `new Error(...)` + `code='INVALID_STATE'`，不是 `StorageError` 实例（`err.name` 为 "Error"）。
- **位置**：`src/storage/journal.mjs:34-47`。
- **为什么是问题**：错误形状与模块其余部分（`storage/errors.mjs StorageError`）不一致；按 `instanceof StorageError` 判定的调用方会失手。当前调用序下基本不可达：commit 先跑 `#reconcileLocked` → `listJournals` 的形状校验（`journal.mjs:59-77`）会把损坏记录标 blocked，`store.mjs:456-462` 先抛出正规 StorageError（实测 IO2：损坏 journal 场景捕获 `name=StorageError code=INVALID_STATE instanceof StorageError=true`），readJournal 的裸 Error 只在同锁内二次竞态才可能触达。
- **最小复现**：构造 root，将 `journal/seed.json` 写成 `{broken json` 后 `store.commit(...)` → 实际抛出的是 reconcile 的 StorageError（证明 readJournal 分支被前置拦截）；该函数自身的裸 Error 形状以代码为准（静态可见）。
- **修复方向**：改用 `invalidState(...)` 工厂保持形状一致；或删除该包装、信任 listJournals 的统一处理。

### P2-7 死代码 / 仅测试引用的导出（7 处）

判定口径：全仓 `grep -w`（src+test，含动态 import 扫描）后仍无生产调用方。以下路径:行号均为定义处：

| 符号 | 位置 | 生产调用 | 测试调用 |
|---|---|---|---|
| `unsupported()` | `src/storage/errors.mjs:36` | 0 | 0（sparks 同名工厂有使用，storage 版全仓零调用） |
| `export { sleep }` 再导出 | `src/storage/store.mjs:1066-1067` | 0（store.mjs 仅被 `storage/index.mjs` 引用且只再导出 createFileStore，无人从 store.mjs 导入 sleep） | 0（测试直接 import fsutil） |
| `lockBusy()` | `src/sparks/errors.mjs:40-44` | 0（注释自认「保留工厂保证码表完整」） | 0 |
| `holdsLock()` | `src/storage/lockfile.mjs:225-228` | 0 | `test/storage/guard-lock.test.mjs:10,125-132` |
| `legacyReport()` / `diagnostics()` | `src/storage/store.mjs:383-389 / 391-405` | 0 | `test/storage/basic.test.mjs:161,197,299` |
| `isSparkToolError()` | `src/sparks/tools.mjs:474-477` | 0 | `test/sparks/tools.test.mjs:6,538-545` |
| `selectVisibleTopics()` | `src/core/topics.mjs:110-146`（`core/index.mjs:17` 契约再导出） | 0（生产可见性去重实际由 `store.mjs #effectiveView` 自行实现） | `test/core/topics.test.mjs` 全文件 |

- **为什么是问题**：`unsupported`/`sleep` 再导出是纯死代码；其余是「生产零调用、仅测试引用」——要么是契约保留面（selectVisibleTopics 注释自称公共契约导出），要么是事实上的 test-only API。混在公共面上会误导下一轮审计/维护（本次审计即为其付出了核对成本）。
- **最小复现**：`grep -rn --include="*.mjs" -w unsupported src test`（storage 版仅命中定义行），其余符号同法。
- **修复方向**：`unsupported`/`sleep` 再导出/`lockBusy` 直接删除（lockBusy 删除需同步改注释）；其余逐个与 CONTRACTS §B/§G 核对契约地位后删除，或在 JSDoc 标注 `@visibleForTesting` 并说明契约依据。**不做任何未经确认的删除，本报告只记录。**

---

### 修复建议涉及的测试落点（具体到文件与用例，非空话）

- `test/service/archived-topic.test.mjs` 的「非法 archivedAt 报 INVALID_INPUT…」用例（:114-129）的 bad 值表增加 `'March 5, 2026'`、`'2026'`、`'Feb 30, 2026'`（若采纳 P2-1 的规范 ISO 口径，这三个用例预期翻红即守住修复）。
- `test/storage/basic.test.mjs` 增加一条手改 `archivedAt` 垃圾串进 shadow 的用例（若采纳 P2-2）。
- `test/service/integration.test.mjs` 的元数据写路径用例补 `updated: 'garbage-not-a-date'` 拒绝断言（若采纳 P2-3）。

---

## 三、已核查但不算问题的点（防下一轮重复劳动）

1. **CAS 三路径（undefined 继承 / null 清除 / 字符串原样）完整无漏**。链路：`service/index.mjs:247-248`（undefined→`token.meta.archivedAt`、null→`''`、字符串原样）→ `store.mjs:725-730`（undefined 不写、''/非空进 meta）→ `frontmatter.mjs:60-73`（空串整行省略=未归档）。token 侧 `service/index.mjs:69-70,90-94` 保证 meta.archivedAt 只能是 undefined 或非空串。实测 C1（undefined 继承归档标记）、C2（null 清除后 `readTopic.archivedAt===undefined`）均符合设计；`test/service/archived-topic.test.mjs` 六个用例全覆盖。
2. **并发两次 mutate 不会互相覆盖**。全部写走 `store.withLock` 串行（`store.mjs:452`），逐文件 CAS（`store.mjs:542-557`）+ rename 前复核（`store.mjs:652-659`）。实测：同 token 两个并发 mutate，一个 fulfilled、一个 `REVISION_CONFLICT`。`test/storage/concurrency.test.mjs` 在套件内。
3. **memory_search 冷搜不泄漏正文**。`service/index.mjs:159-181`：score 计算虽含 body，但归档命中只返回 `{key,title,summary,scopeId,score:0,state:'archived'}`（:173）。实测搜正文密语 `SECRET-COLD-BODY-42`：命中键集不含 body/content 字段，输出字符串不含密语。sparks 冷搜同口径：`cold-search.mjs:272-279` items 不含 content/triggers/entities/links。
4. **mutate 元数据白名单与 scope 走私无口子**。白名单硬校验 `service/index.mjs:222-224`；request/change/topic 三层 `noScope`（:24,186,189,221，`in` 语义连原型链键都拒）；JSON.parse 产生的自有 `__proto__` 键会被白名单拒绝；structuredClone 冻结请求身份（:188）。实测 B1（topic.scopeId='global'）、B2（change.scopeId='global'）均 `INVALID_INPUT: scope is factory-only`。
5. **archivedAt 空串 / 纯空格路径已封死（by design 或拒绝）**。空串=显式取消归档是契约语义（`service/index.mjs:229-230` 文案、`test/service/integration.test.mjs:199-203`）；纯空格实测被两层拒绝：service `new Date('  ')→NaN`（A2），storage frontmatter `Date.parse(' ')→NaN`（F3）。
6. **备份 fail-closed 名副其实**。备份写在 journal(prepared) 之后、phase=committing 与任何 rename 之前（`store.mjs:640-648`）：备份失败即整单失败，目标零改动，journal 留在 prepared → 下次任意操作前 reconcile 按 `prepared+无应用痕迹` aborted-clean（`store.mjs:930-938`）；恢复补完用 staging 字节前先 sha256 复核（`store.mjs:943-951`）。
7. **锁协议 fail-closed 且无自动抢占**。guard 目录原子创建、崩溃残留不自动回收（`lockfile.mjs:111-127`）；死主回收仅在确认 pid ESRCH 后进行（:36-43,153-158）；畸形/无法读取的锁一律拒绝获取而非清障（:69-87）；`inspectExternalHolder` 只读探针不越权删锁（:240-269）。
8. **写入原子性与 fsync**。单文件落盘=临时文件+fsync+rename（`fsutil.mjs:78-103`）；journal 三阶段 prepared/committing/committed 全走 atomicReplace（`journal.mjs:49-52`）；目录 fsync 在 Windows 跳过属已知限制，由 journal 协议兜底（`fsutil.mjs:105-117` 头注释）。崩溃中途最坏留下：未完成的 journal（reconcile 处理）、孤儿 staging（按 blocked/conflict 证据保留或清除，`store.mjs:1005-1030`）、孤儿 `.key.md.tmp-*`（见第 10 条）。
9. **路径逃逸防线成立**。`assertNoEscapeViaSymlink` 逐级 lstat、越根 symlink/junction 拒绝、根内链接按 realpath 续查、不存在后缀段提前止步（`paths.mjs:166-196`，ENOENT break 在 :179）；创建后 realpath 复核防 TOCTOU（`store.mjs:124-130`）；UNC/盘符由 `path.relative`+`joinUnder` 兜底（`paths.mjs:209-216`）；Windows 大小写碰撞入口拒绝（`paths.mjs:140-158`；`test/storage/paths.test.mjs` 的 junction/大小写用例在套件内通过）。
10. **崩溃残留的孤儿 tmp 文件无害**。`atomicReplace` 在 tmp 写完与 rename 之间崩溃会留下 `.<name>.md.tmp-<hex>`；它不以 `.md` 结尾，`#effectiveView` 只会把它记进 shadow 报告（`store.mjs:247-249`），永不被当数据读；reconcile 只清 `staging/` 不清它——属 cosmetics（磁盘 litter + shadow 噪音），不构成数据/状态问题，不单独立项。
11. **`service.searchArchived`「缺失」不是缺陷**。`host/tools.mjs:275-282` 引用的方法由 `plugin/controller.mjs:276-279` 以 Proxy 显式补齐（注释在案），冻结基线 service 有意不带。
12. **forgetting 执行器 fail-closed 属实**。每次 execute（含重放）重新 authorize（`executor.mjs:322-328`）、时钟回拨拒绝且重放不豁免（:329-340）；plan.policy 必须与 factory 规范值精确一致（:201-209）。decay 的 60 天冷却 + score 严格小于阈值的边界自洽（恰 60 天 score=0.25 不归档，`decay.mjs:489-495`），与 sparks 侧复算（`sparks/store.mjs:1068-1071`）同口径。
13. **sparks 双写一致性防线有效**。supersedes/supersededBy 双向一致 + replacement 必须 active 的 G1 加载校验（`sparks/store.mjs:636-647`）；承接卡不可再被归档/替代（:1326-1332）；feedback 桶/事件全部 own-property 语义（D-3，:1083-1112）。

---

## 四、测试与命令记录

| 命令 | 结果 |
|---|---|
| `node --check`（26 个目标文件逐一） | 全部无输出=语法 OK（0 fail） |
| `node --test test/core/*.test.mjs test/host/*.test.mjs test/storage/*.test.mjs test/service/*.test.mjs test/integration/*.test.mjs test/runtime/*.test.mjs test/completion/*.test.mjs test/acceptance/*.test.mjs test/sparks/*.test.mjs test/organize/*.test.mjs test/forgetting/*.test.mjs test/plugin/*.test.mjs test/semantic/*.test.mjs`（package.json `test` 脚本原口径） | **tests 1303 / suites 87 / pass 1303 / fail 0 / cancelled 0 / skipped 0 / duration ≈107.96s**，与基线数字一致；单次运行无 flaky 表现（并发/崩溃用例均在套件内通过） |
| 临时复现脚本 `%TEMP%\wb-audit-repro\repro.mjs / repro2.mjs / repro3.mjs`（node 直接运行，工作目录为仓库外） | 产出本报告 A1/A2/A3/B1/B2/C1/C2/D/E/F1-F5/IO1/IO2 全部实测结论；脚本与临时数据均在系统临时目录，未进仓库 |

**口径警告（给下一轮）**：裸 `node --test`（不带 glob）会把 `test/storage/bin/{lock-racer,racer,writer}.mjs`（crash/concurrency 用例的子进程辅助脚本）当测试文件执行，报 3 个假失败（`'test failed'`）。跑全量必须用 package.json 的显式 glob 口径。

**审计纪律自述**：本次为只读审计，工作树仅新增本报告一个文件（白名单内），未改任何源码/测试/配置/CSS，未 commit，未触碰主仓 D:/AIagent/shiori；复现脚本全部写在系统临时目录。
