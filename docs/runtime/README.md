# Shiori Runtime（P1-RUNTIME · slot D）

`src/runtime/index.mjs` 的唯一公开入口：

```js
export async function createShioriRuntime(options, dependencies = {})
// -> { start(), stop(), refresh(), diagnostics(), service, bridge, host }
```

运行时把「冻结的 service / host 桥 / 完成状态」组装成一代可完整回收的运行实例；
不改存储、不改锁、不重写 service——只做装配、生命周期与边界校验。

## options

| 字段 | 说明 |
| --- | --- |
| `pluginCtx` | 宿主插件上下文，原样交 `createHost`（默认 `createDshHostAbstraction`） |
| `dataRoot` | 记忆数据根，绝对路径；active 模式由 service 初始化，shadow 全程不触碰 |
| `stateRoot` | E 完成状态根，绝对路径；必须与 dataRoot 不同且互不嵌套（含 junction/symlink 解析后判定） |
| `activeScopeId` | 可信 scope，只来自 factory 参数；工具 payload 携带 scope 一律 INVALID_INPUT |
| `mode` | `"shadow"`（默认，零注册零写）/ `"active"`（需显式 `config.hostBridge.allowActive === true`） |
| `config` | 原样传 bridge；剥离 `hostBridge` 段后传 service（core 的 validateConfig 拒绝未知顶层键）。运行时绝不代为设置/篡改 `allowActive` |
| `personaAdapter?` | 交 service；缺省时魂卡保持 UNSUPPORTED（不读真实卡） |
| `loadDshTools?` | 交 `createHost`，隔离测试注入 `defineTool` |
| `service?` | 显式注入合成/只读 service（shadow 观测或隔离测试）；缺省 shadow 用「UNSUPPORTED 门面」 |

## dependencies

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `createService` | 基线 `createShioriService` | 仅 active 且未注入 service 时调用（构造有磁盘初始化副作用，shadow 绝不调用） |
| `createHost` | 基线 `createDshHostAbstraction` | `createHost(pluginCtx, { trustedScopeId, loadDshTools })` |
| `createBridge` | 基线 `createHostBridge` | 收 `{ host(排空包装), service, mode, config, probeSink: handle.sink }` |
| `openCompletionState` | **无（必须显式注入）** | E 的工厂；缺失即 `UNSUPPORTED`，绝不假造内存持久化或静默降级 memory-only |

## 生命周期语义

- `start()`：open handle → create host → service → bridge(probeSink=sink) → `await bridge.start()`。
  任一步失败：回收本代（`bridge.stop` → 排空在途事件 → `host.flushCompletedTools?` → `handle.flush` → `handle.close`）后抛原错误；
- `stop()`（幂等）：`bridge.stop()`（撤销订阅＝禁止新事件）→ 排空在途完成事件 → `host.flushCompletedTools?()` → `handle.flush()` → `handle.close()`。
  只调同步 `bridge.stop` 不等于排空——runtime 的 stop 必须等在途任务落盘后才返回；
- 并发语义（`start`/`stop` 串行化）：`starting`/`started` 再 `start` 立即 `INVALID_STATE`；
  stop 进行中到达的 start **等待 stop 完成后开始全新一代**（旧句柄先 close、新句柄后 open，所有权不重叠）；
  start 进行中到达的 stop 在 start 结算后执行；重复 stop 串行化为 no-op；
- 每代独立 drain 跟踪与句柄；重启（stop→start）开新 handle，probe 经 sink 先恢复（重启去重由 E 的水位保证）；
- `service`/`bridge`/`host` 为当前代访问器，start 前与 stop 后为 `null`。

## shadow 的零写保证

- 构造/start/stop 全程不调用 `createShioriService`/`createFileStore`（二者构造即 mkdir 磁盘）；
- 不注册 section、不注册同名工具、不注入 system，只订阅完成事件（只读观测）；
- 未注入只读 service 时使用「诚实门面」：所有读/写抛 `UNSUPPORTED` 并计入
  `diagnostics().service.facade`（readAttempts/lastError），绝不用空文本冒充真实读取；
- 压缩诊断状态只写 stateRoot（经 E 的 sink），dataRoot 保持不存在。

## refresh 诊断

`refresh()` 返回 `{ refreshed: true }` 或 `{ refreshed: false, reason?|error }`；
失败（读取异常/序号被抢先/代际失效）一律显式记录进 `diagnostics().refresh`，
绝不把失败回写为成功，也不清空既有快照。bridge.refresh() 因此扩展为返回提交布尔值（原为 undefined，兼容增强）。

## active 直写投影包装（review-D-a1 修复）

默认真实适配层是同步快照模式（`asyncSectionText=false`），section 文本读桥快照；桥工具路径的
mutate 自带提交后刷新，但**绕过工具的直接 `runtime.service.mutate(...)` 原先不会**，导致下次
assemble 读到陈旧投影。现 active 模式下 `runtime.service` 是投影刷新包装（中性 target 的 Proxy
转发冻结 service，与桥的 serviceForTools 同款避开 Proxy invariant）：

- 任何经 `runtime.service.mutate` 的提交（直写或工具写）成功后刷新**当前代**桥快照，
  下一次 assemble 即当前值，无需手动 refresh；桥与外部拿到的是同一对象；
- 刷新失败不否定已提交的 mutate（与桥工具路径一致），错误记入
  `diagnostics().service.refreshErrors` 与 `diagnostics().refresh`；
- 代际保护：包装只在「调用时仍是当前代且 runtime 处于 started」时刷新——stop/重启后的旧引用
  静默跳过，不触碰新代桥；已提交数据在新代快照照常可见（真实数据语义）；
- shadow 不包装（门面 mutate 仍 UNSUPPORTED，零写边界不变）；
- 工具写路径会多一次刷新读取（包装刷新 + 桥自身按 S1 序号的刷新）：额外只读开销，正确性由序号屏障保证。

## 监听器返回形状说明（review-D-a1 非阻断项）

- 桥的完成事件监听器返回**永不 reject**的处理 Promise：处理失败记入 `eventErrors` 后以
  `{advanced:false, epoch, reason:"handler-error"}` 收尾——`reason:"handler-error"` 是桥本地
  回执形状（非探针 reason 枚举），调用方判读时应视为「该事件处理失败」，epoch 为失败时刻的值；
- 基线 `dsh-adapter.subscribeCompletedTools` 的底层 session 回调不转发该 Promise——运行时的
  排空 Proxy 在 `subscribeCompletedTools` 层跟踪监听器返回的 Promise，排空语义不依赖适配层
  转发（适配层转发属 E 的归属文件，可后续独立增强）。

## 对基线的最小增强（src/host/index.mjs，slot D 归属文件）

1. 完成事件监听器改为**返回对应处理 Promise**（错误记入 `eventErrors` 后以失败回执收尾，
   Promise 永不 reject）——契约 D「完成事件监听器须返回对应处理 Promise」；宿主/运行时据此排空；
2. `bridge.refresh()` 返回 `refreshSnapshot` 的提交布尔值，供运行时判定投影是否真的更新。

## 已知边界（见 REPORT.md）

- Windows junction 越根拒绝已实测；POSIX symlink 路径仅代码评审（本机 win32）；
- E 的 `openCompletionState` 在本工作区只有 synthetic 替身（测试内联，标注 synthetic）；
  与真实 E 工厂的组合、真实隔离 DSH 链路为 not-run，由负责人后续组合验收；
- 刷新「被更新的同代刷新抢先提交」（refreshSnapshot 返回 false 的一种）在运行时层只经返回值
  覆盖，竞争时序本体由既有 `test/host/stale-state.test.mjs` 覆盖。
