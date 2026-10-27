# P4 遗忘执行与冷库检索（O 槽）

本文档说明 `src/forgetting/`（executor / cold-search）的接口、边界与测试方式。
衰减规则见 M 槽 `decay.md`，存储接口见 N 槽 `storage.md`；三者在真实组合中的联测
见 `test/forgetting/combination.test.mjs`。

## 模块边界

- `src/forgetting/executor.mjs` — `createForgetExecutor({store,scopeId,authorize,now?,policy?})`
  → `{execute(plan,{operationId})}`。可信执行门面：只做验证、clone、授权与转发，
  不实现衰减（M）、不实现持久化/重放（N），不新建 journal/coordinator。
- `src/forgetting/cold-search.mjs` — `createColdSearch({store,scopeId})` → `{search({query,limit?})}`。
  用户显式发起的只读冷库检索门面；不自动调用、不写库、不复活/续期/写统计。
- 两模块都是独立可测门面，不接线宿主/工具注册；不改 match/delivery/host/tools/config。

## 执行门面（executor）

```
createForgetExecutor({
  store,        // 可信 spark store；必须提供 archiveEphemeral 函数（N 窄增量）
  scopeId,      // 绑定 scope；plan.scopeId 必须与其一致，请求无法覆盖
  authorize,    // 可信授权判定函数，必需；每次 execute（含重放尝试）都会被调用
  now?,         // 可信时钟：同步函数返回规范 UTC ISO；缺省 new Date().toISOString()
  policy?,      // §1 可信配置，可部分覆盖再补默认；plan.policy 必须与其精确一致
})
```

执行顺序（全部校验同步完成于首个 `await` 之前）：

1. 完整校验 plan（§3 archive-ephemeral：恰好 version/kind/scopeId/now/policy/sources，
   sources 1..20 且项恰好五字段）、opts（恰好 operationId）与 factory 参数；
2. 独立 clone plan 与授权参数——调用方或 authorize 回调在 await 后篡改不影响执行；
3. `await authorize({kind:'forget-archive',scopeId,plan:独立clone,operationId})`，
   唯 `=== true` 继续，否则 `AUTHORIZATION_REQUIRED`；authorize 抛错原样传播；
4. 采样可信 now；非规范 ISO → `INVALID_INPUT`；`now < plan.now` → `INVALID_STATE`
   （门面 fail-closed：即使底层同 operationId 已有持久收据也不调用 store，§7）；
5. 只调用一次 `store.archiveEphemeral(clone,{operationId,executedAt:now})`，
   返回其结果快照的独立 clone；store 抛错原样传播。

policy 校验（§1）：普通对象（Object.prototype/null 原型）；只接受
`baseHalfLifeDays[1,365]`、`maxHalfLifeDays[base,3650]`、`archiveScore(0,1)` 三键；
部分覆盖合法，显式 undefined / 未知键 / NaN / Infinity 拒绝。

## 冷库检索门面（cold-search）

```
createColdSearch({ store, scopeId })   // store 必须提供 listArchived 函数
  .search({ query, limit? })           // limit 整数 1..100，默认 20
```

- `query` trim 后必须 1..200 UTF-16 且可无损 UTF-8 编码；
- 匹配：`query.trim().toLowerCase()` 对 `title/summary/content` 逐字段、
  `triggers/entities` 逐元素做字面 `String.includes`；不跨字段/元素拼接、
  不用正则/代码/路径；任一命中即匹配；
- 返回恰好 `{kind:'cold-search',scopeId,query:trim后,items,truncated}`，
  条目恰好 `{id,title,summary,revision,state:'archived',archivedAt}`（不输出正文），
  按 id 升序取 limit；`truncated` 严格为过滤后命中总数 > limit；
- 每条记录核验 scope/`恰好 archived` 与摘要字段；跨 scope、非 archived、损坏记录
  → `INVALID_STATE`（fail-closed，不静默跳过）；store 抛错原样传播；
- 记录属不可信输入（主审 a1 返工 D-1 加固）：所有被读取字符串（title/summary/
  content/triggers/entities 逐元素）必须可无损 UTF-8 编码，含孤立代理码元一律
  `INVALID_STATE`；数组按索引逐位校验，稀疏数组的洞拒绝；错误文案只描述
  类型/长度（`safeDescribe`），绝不序列化不可信值（BigInt 等不会触发原生
  TypeError）；
- 检索是显式请求：不自动调用、不产生新卡/附件/统计/反馈，不查 superseded/merged。

## 错误码

统一抛 `SparkStoreError`（复用 `src/sparks/errors.mjs` 形状，name/code/details）：

| code | 场景 |
| --- | --- |
| INVALID_INPUT | 参数/plan/opts/policy/query/limit 形状或类型非法、plan.policy 与 factory 不一致 |
| AUTHORIZATION_REQUIRED | authorize 未严格返回 `=== true` |
| INVALID_STATE | 可信时钟早于 plan.now（执行门面）；冷库记录跨 scope/非 archived/损坏 |
| 其他（NOT_FOUND / REVISION_CONFLICT / LOCK_BUSY / IO_ERROR…） | 由 store 原样传播 |

## 测试

```
node --test test/forgetting/executor.test.mjs      # fake store 单测
node --test test/forgetting/cold-search.test.mjs   # fake store 单测
node --test test/forgetting/combination.test.mjs   # 真实 M/N/O 组合
```

组合测试通过 `import.meta.url` 定位当前项目根，直接加载真实
`src/forgetting/{decay,executor,cold-search}.mjs` 与 `src/sparks/store.mjs`。
不再依赖外部 stage 环境变量或 fallback，也不允许 skip；全部九项子测试
强制执行，fixture 造数失败即测试失败。仅使用合成临时 dataRoot
（系统 temp，用后清理），禁止以业务 stub 代替 M/N。

`npm test` 已包含 `test/forgetting/*.test.mjs`；`npm run test:p4` 可单独运行 P4。
