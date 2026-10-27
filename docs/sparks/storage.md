# L2 Sparks 存储（G 槽位）· 实现说明

对应 `src/sparks/store.mjs` 与 `src/sparks/errors.mjs`。本批次为**合成开发**：
不接触真实 DSH / profile / 用户记忆；`node:sqlite` 未在真实宿主验证前不做任何
sqlite 假设，本实现是零第三方依赖的纯文件方案，并发与恢复边界见下文。

## 1. 磁盘布局

```
<root>/                                  调用方显式提供的 sparks 数据根（绝对路径）
  sparks/
    .shiori-lock / .shiori-lock.guard    跨进程写锁（复用 P1 lockfile 协议）
    scopes/
      <scopeId>/sparks.json              单文件 scope 数据库
```

- 锁域只在 `<root>/sparks` 子树内，与 P1 storage 的根互不影响；即便把 P1
  的 dataRoot 当作 root 传入，两层的锁文件与数据也各自独立。
- 一个 scope 一个 `sparks.json`，scope 之间物理隔离，跨 scope 只能靠
  「另一个 store 实例 + 另一个 scopeId」访问，本 store 的任何 id /
  links / replacementId 引用都只在本 scope 内解析。

## 2. 数据模型

每张卡的 public record（`read/save/update/forget/feedback` 返回值、
`listActive()` 元素）恒含：

| 字段 | 说明 |
| --- | --- |
| `id` | 显式提供或自动生成（`spk-` + 16 hex）；`^[A-Za-z0-9][A-Za-z0-9._-]*$`，≤64 字符，拒绝 Windows 保留名与 `__proto__` 等对象键保留名 |
| `scopeId` | 恒等于 openSparkStore 绑定值，payload 无权改写 |
| `revision` | 从 1 起的整数；内容/状态写 +1，feedback 统计写不动 |
| `title` / `summary` / `content` | ≤80 / ≤120 / ≤2000 UTF-16；content 非空 |
| `triggers` / `entities` | 字符串数组（≤32 项，每项 1..64），原样保留仅去重 |
| `links` | `{target, rel}[]`（≤32 项）；target 必须已存在于**本 scope**、必须是 **active** 卡，且不得 self-link |
| `vitality` | `evergreen` / `ephemeral` |
| `state` | `active` / `archived` / `superseded`（`merged` 仅作为加载时的已知值，本批次无写入路径） |

另有统计与关系字段：`createdAt/updatedAt/archivedAt`、`hitCount/lastHitAt`、
`useCount/lastUsedAt`、`supersedes/supersededBy`（有向替代关系，双向可读）。

## 2.1 Active-only 契约与替代链完整性（rework attempt 2 强化）

- **links 只能指向 active 卡**（save 与 update 双路径校验）。建链后目标被
  归档属合法时序，此时边不可见但**不静默消失**——graph 会逐条上报到
  `filteredEdges`（见 §2.2）。
- **feedback 只能发给 active 卡**（used=true / used=false 一视同仁）：
  已退休的卡不再参与匹配与投递，统计入口同步关闭；先反馈后退休。
- **替代链不允许嵌套**：承接了替代关系的 replacement（`supersedes !== null`）
  不能再被 archive 或 supersede，否则原卡 `supersededBy` 会指向一张退休卡。
  如需「换替代品」，应在初次 supersede 时就选定最终版。
- **加载校验双向闭环**：`supersedes` ↔ `supersededBy` 必须互指一致，且
  original 处于 `superseded`、replacement 处于 `active`；任何单侧缺失、
  状态不符或 replacement 已退休的库都判 `INVALID_STATE`，fail-closed。

### 2.2 graph 的 filteredEdges 契约

`graph()` 返回 `{scopeId, nodeCount, edgeCount, filteredEdgeCount, nodes,
edges, filteredEdges}`。可见边（edges）仅含两端 active 的关系；因一端退休
而不可见的已接受关系逐条列入 `filteredEdges`，带原因：

- `source-retired`：边源（卡片本身）已退休，其全部出边不可见；
- `target-retired`：源 active 但目标已退休。

两类均去重并按 (source, target, rel) 稳定排序；`read(id).links` 与该报告
永远一致，graph 不得静默吞掉任何已接受的关系。

## 3. 写协议与并发模型（明确边界）

- **写操作**（save / update / forget / feedback）全程持跨进程锁后串行执行：
  持锁加载库 → 幂等检查 → 语义检查（存在性 / CAS / 状态 / links）→
  内存变更 → 记录 operationId → **单次原子替换**落盘（临时文件 + fsync +
  rename，字节为键排序后的稳定 JSON）。
- **锁**：复用 P1 `src/storage/lockfile.mjs` 的 guard-lock 协议（含崩溃锁
  回收语义）；等待超时抛 `LOCK_BUSY`。同进程多个 store 实例由 withLock 的
  进程内队列串行。
- **读操作**（read / listActive / graph）**不持锁**：依赖 rename 的原子性，
  永远读到旧库或新库二者之一，无撕裂读；代价是「读到的是加载瞬间的快照」。
- 这是**单写者、多读者**模型；不提供多写者无协调并发（那需要 sqlite 级
  事务，见 §8 未验证项）。

## 4. 恢复规则

- 每次变更是单次原子替换：崩溃后库要么是旧版要么是新版，不存在半写状态，
  因此无需 journal。
- 打开与每次读写都会重新加载并**严格校验**数据库（kind / schemaVersion /
  scopeId / generation / 卡片逐字段形状 / links 与 supersedes 引用闭合 /
  ops 与 feedback 记录形状）。任何不一致：
  - 非法 UTF-8、空文件、坏 JSON、字段损坏、悬空引用、scopeId/kind 不符 →
    `INVALID_STATE`（fail-closed，**绝不静默归零或重建**）；
  - schemaVersion 来自更新版本 → `UNSUPPORTED`；
  - 底层 fs 错误（权限 / 设备 / ENOTDIR 等）→ `IO_ERROR`（保留 cause）。
- 人工恢复路径：备份 `sparks.json` 后修复或删除该文件（删除等于放弃该
  scope 数据，由人工决策，程序不会替你做）。

## 5. 幂等

两层、互相独立：

1. **operationId**（save / update / forget / feedback 均可带）：
   - 首次成功时记录 `{kind, fingerprint, at, result}`，与数据变更同一次
     原子落盘（崩溃后二者要么都在要么都不在，无半幂等态）；
   - 同 key 重放：比对请求指纹（规范化后的完整语义，含 expectedRevision），
     一致 → 返回**首次结果快照**（不反映后续变更），不一致 → `INVALID_INPUT`
     （同 key 不同语义拒绝）；
   - 失败的操作不占用 opId，可修正后用同 key 重试。
2. **feedback sourceEventId**：按 `(cardId, sourceEventId)` 事件去重，
   同一事件重复反馈不重复计数；同事件改报不同 `used` → `INVALID_INPUT`。
   与 operationId 可叠加使用。

## 6. CAS 与错误码

- `save` 语义上期望目标不存在（revision 0）：id 已存在 → `REVISION_CONFLICT`
  （details 带 currentRevision）；`expectedRevision` 只接受 0。
- `update` / `forget`：`expectedRevision` 不等于当前 revision →
  `REVISION_CONFLICT`；省略则不做 CAS 检查（调用方自担）。
- 错误码全集：`INVALID_INPUT`、`INVALID_STATE`、`REVISION_CONFLICT`、
  `NOT_FOUND`、`LOCK_BUSY`（由锁协议冒泡）、`UNSUPPORTED`、`IO_ERROR`。
  所有错误都带稳定 `code`，绝不吞错回成功。

## 7. 越权与隔离要点

- scope 只由 `openSparkStore({root, scopeId})` 决定；save input / patch /
  opts 中出现 `scopeId` / `scope` / `root` / `dataRoot` 一律 `INVALID_INPUT`。
- patch 只能改 7 个可变字段；`id/revision/state/统计字段` 等系统字段拒绝。
- links / replacementId 只在本 scope 解析：跨 scope 同名 id 不串读、不串链。
- scopes 目录大小写互斥（Windows 语义），卡 id 亦拒绝大小写碰撞。
- 管理路径（root/sparks/scopes/<scopeId>）不得被符号链接或非目录占用，
  数据库文件不得是符号链接/目录。

## 8. 已知限制与未验证项（诚实边界）

- **node:sqlite 未探测**：本实现与其无关；若未来切换 sqlite，必须在真实
  DSH 宿主进程验证导入与 API 后才可启用，缺能力时 `UNSUPPORTED`。
- **单文件库规模**：每写全量重写 + fsync，按设计规模（几百卡）实测无压力；
  上千卡高频写需要分片或 sqlite（未实现、未测）。
- **ops / feedback 事件记录无修剪**：无限增长，重启不清理（本批次不提供
  prune API，避免误删幂等证据）。
- **merged 状态无写入路径**：加载校验接受、投影排除，供后续批次使用。
- **feedback 不动 revision**：统计写与内容写分离；seen/冷却键若依赖 revision
  （H 槽位）不会被反馈扰动。
- **跨进程并发测试覆盖**：LOCK_BUSY 用真实子进程持锁验证；崩溃恢复依赖
  原子替换论证 + 损坏注入测试，未做断电级故障注入。
- **替代链不可嵌套的代价**：replacement 一旦承接关系即不可退休（拒绝式，
  不做级联改写）；需要「换替代品」时必须重新规划初次 supersede。

## 9. 故障速查

| 现象 / 错误码 | 常见原因 | 处置 |
| --- | --- | --- |
| `INVALID_INPUT` + “仅 active 卡可被链接” | link 目标已归档/被替代 | 换 active 目标，或先恢复目标（本批次无 unarchive） |
| `INVALID_STATE` + “承接” | 试图退休承接了替代关系的 replacement | 替代链不可嵌套；重新规划替代关系 |
| `INVALID_STATE` + “feedback” | 对退休卡反馈 | 先反馈后退休 |
| `INVALID_STATE` + “对侧替代关系不一致” | 磁盘链条被外部破坏 | 备份后人工修复 sparks.json |
| `INVALID_INPUT` + “不能携带 scopeId/root” | payload 试图越权 | 由 openSparkStore 绑定 scope，去掉字段 |
| `INVALID_INPUT` + “不同语义” | operationId 复用于不同请求 | 换新 opId 或还原请求内容 |
| `REVISION_CONFLICT` | expectedRevision 过期或 save 撞 id | 重读当前 revision 后重试 |
| `INVALID_STATE` + “仅 active 卡” | 对 archived/superseded 卡 update/forget | 只操作 active 卡；恢复走业务流程 |
| `INVALID_STATE` + “拒绝静默归零” | 库文件损坏/被占用 | 备份后人工检查 sparks.json；勿删除重建了事 |
| `UNSUPPORTED` | 更新版本的 schema | 升级实现后再打开 |
| `LOCK_BUSY` | 他进程持锁超时 | 稍后重试；长期占用查 `.shiori-lock` 属主 |
| `IO_ERROR` | 权限/磁盘/路径异常 | 看 `details.ioCode` 与 cause |
