// Shiori 0.5 · 语义向量写后增量维护（队列本体 + 单飞闸 + spark store 写钩子包装）。
//
// 背景（为什么要有这个模块）：
// - 0.4 及以前，向量只在 runSemanticRebuild（plugin/controller.mjs）里建，调用点
//   只有手动 semantic_rebuild 与模型下载后的 force 重建——spark_save / spark_update /
//   spark_forget 的写路径没有向量维护钩子。结果：语义召回只对「上次重建时已存在」
//   的卡有效，新卡与改过的卡永久落选（召回新鲜度判据 entry.revision !== card.revision
//   即跳过，见 sparks/semantic-recall.mjs），只能靠用户手动点「重建向量」补。
// - 本模块交付三件事（controller.mjs 接线，任务书硬要求 1/2/3）：
//   ① 写后增量：spark 写工具成功后 markDirty(id)——同步零 IO，绝不阻塞工具返回；
//      ~300ms 防抖合并，批量 embed → store.upsert → saveIfDirty 落盘；forget 后
//      索引同步剔除（flush 时读卡真值：读不到 / 非 active 一律 remove）。失败静默
//      重试一次，仍失败保留 pending + 诊断可见，绝不外溢打断写工具。
//   ② 单飞并发防线：flush / 启动差集 / runSemanticRebuild 共用同一把
//      createSemanticGate（保守全局单飞，与现有全局 rebuild 状态同口径）——重建
//      全程（含开头 store.clear() 与收尾 retainOnly+save）持锁，增量索引写只在
//      锁外发生，严禁交错；重建期间 markDirty 只标 dirty，锁释放后的下一轮 flush
//      按差集补齐（差集 = 读卡真值 revision 与索引比对，新鲜的零成本跳过）。
//   ③ 启动差集兜底：scope 首次打开索引时 kickStartupSync 异步比对 active 卡
//      revision 与索引条目——不一致的后台增量重建，残留条目 retainOnly 剔除；
//      不阻塞召回（kick 即返回，差集在后台跑）。
//
// 边界（任务书 + 既有契约）：
// - 不改卡片存储格式、不改向量索引磁盘格式（src/semantic/store.mjs 的 upsert /
//   remove / retainOnly / save 契约原样使用）；召回侧（match.mjs /
//   semantic-recall.mjs）一字不动——本模块只保证「索引新鲜」，新鲜度判定仍由
//   召回层执行。
// - 降级（任务书硬要求 5）：canWrite=false（HOST_LOCKED）/ canEmbed=false（模型
//   未装）/ openVectorStore 为 null（provider 关闭）时写路径零报错——flush 只记
//   lastSkipReason、保留 pending 等下次触发，绝不抛向工具调用方。
// - 嵌入文本口径由调用方注入（controller 的 cardEmbedText：title/summary/content
//   按行拼接），本模块不自行拼口径——改口径必须同步重建路径，那是 controller 的
//   职责（同一个函数对象传进来，两条路径天然一致）。
// - embed 顺序按 dirty 插入序（确定性）；每 batchSize 张 saveIfDirty 一次（中断
//   后进度可续），轮末再兜底 saveIfDirty 一次。
// - close() 后一切静默：停防抖 timer、markDirty 变 no-op。stop 场景下未处理的
//   pending 由下一次 start 的启动差集兜底补齐（索引是派生数据，允许滞后）。

/** 生产缺省防抖（任务书 ~300ms）；测试经 controller 的依赖 seam 注入更短值。 */
export const SEMANTIC_INCREMENTAL_DEBOUNCE_MS = 300;

/** 每批嵌入后落盘一次（与 runSemanticRebuild 的 SEMANTIC_REBUILD_BATCH 同量级）。 */
const DEFAULT_BATCH_SIZE = 20;

function invalidInput(message, details) {
  const error = new Error(message);
  error.name = "ShioriError";
  error.code = "INVALID_INPUT";
  if (details !== undefined) error.details = details;
  throw error;
}

/**
 * 单飞闸：串行化所有语义索引写者（写后增量 flush / 启动差集 / runSemanticRebuild）。
 * 链式 promise 实现——后到者在先到者完全收场（含收尾写）之后才开始，FIFO 无饥饿。
 * 用法：`gate.run(async () => { ...独占段... })`；fn 的错误原样传给调用方，
 * 不阻断后续排队者（chain 吞掉链上的 rejection，只传播结果）。
 * 保守全局单飞（与现有全局 rebuild 状态同口径）：跨 scope 也串行——增量批都很
 * 短（几张卡），换来的「与 clear()/retainOnly() 零交错」是硬要求。
 */
export function createSemanticGate() {
  let chain = Promise.resolve();
  return {
    /** 排队执行 fn；返回 fn 的 promise（含其错误）。绝不 reject 出链外。 */
    run(fn) {
      const result = chain.then(() => fn(), () => fn());
      chain = result.then(() => {}, () => {});
      return result;
    },
  };
}

/**
 * spark store 写钩子包装：仅拦截 save / update / forget 的【成功】路径，把变更卡
 * id 交给 queue.markDirty（同步零 IO）。失败路径不挂钩子——写失败本就无新状态
 * 可索引。其余一切方法/属性经 Proxy 原样透传（含 this 绑定到裸 store），对消费方
 * （spark 工具门面 / 冷搜 / 遗忘执行器 / management）完全透明：isPlainRecord 等
 * 结构判定不受影响（Proxy 的 getPrototypeOf 与 target 一致）。
 *
 * - save / update：返回卡记录（buildCard 形状），取 result.id 入队。
 * - forget：原卡入队（archive→剔除；supersede→剔除）；supersede 还会把替代卡
 *   入队（result.supersededBy）——替代卡 revision +1 但正文未变，flush 按差集
 *   用新 revision 重嵌（索引新鲜度判据按 revision 比对，不重嵌会永久落选）。
 * - 形状异常的返回值（无 id）静默跳过，绝不因钩子让工具调用失败。
 *
 * @param {object} store 裸 spark store（openSparkStore 产物或测试假体）
 * @param {{markDirty(id:string):void}} queue createSemanticIncrementalQueue 产物
 */
export function wrapSparkStoreWithIncrementalHooks(store, queue) {
  if (store === null || typeof store !== "object") {
    invalidInput("wrapSparkStoreWithIncrementalHooks: store must be an object", { store: typeof store });
  }
  if (queue === null || typeof queue !== "object" || typeof queue.markDirty !== "function") {
    invalidInput("wrapSparkStoreWithIncrementalHooks: queue must expose markDirty()", {});
  }
  const overrides = {
    async save(input, opts) {
      const result = await store.save(input, opts);
      if (result !== null && typeof result === "object" && typeof result.id === "string" && result.id.length > 0) {
        queue.markDirty(result.id);
      }
      return result;
    },
    async update(id, patch, opts) {
      const result = await store.update(id, patch, opts);
      if (result !== null && typeof result === "object" && typeof result.id === "string" && result.id.length > 0) {
        queue.markDirty(result.id);
      }
      return result;
    },
    async forget(id, opts) {
      const result = await store.forget(id, opts);
      if (result !== null && typeof result === "object" && typeof result.id === "string" && result.id.length > 0) {
        queue.markDirty(result.id);
        // supersede：替代卡 revision 已 +1（store.forget 内部），同样入队重嵌。
        if (typeof result.supersededBy === "string" && result.supersededBy.length > 0) {
          queue.markDirty(result.supersededBy);
        }
      }
      return result;
    },
  };
  const boundCache = new Map();
  return new Proxy(store, {
    get(_target, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const value = Reflect.get(store, prop, store);
      if (typeof value !== "function") return value;
      // 绑定到裸 store 并缓存：保持方法引用稳定（每次 get 新建 bound 会破坏恒等比较）。
      if (!boundCache.has(prop)) boundCache.set(prop, value.bind(store));
      return boundCache.get(prop);
    },
  });
}

/**
 * 创建一个 scope 的写后增量队列。
 *
 * @param {object} args
 * @param {string} args.scopeId scope 标识（诊断/校验用）。
 * @param {object} args.provider embedding provider（{embed(text):Promise<Float32Array>}；
 *   调用方保证非空——provider 关闭时 controller 根本不建队列）。
 * @param {() => Promise<object|null>} args.openVectorStore 打开（并缓存）本 scope
 *   向量索引的共享入口；返回 null = 索引不可用（降级跳过）。
 * @param {(id:string) => Promise<object|null>} args.readCard 读卡真值；卡片不存在
 *   返回 null（controller 侧把 NOT_FOUND 归一成 null），其余错误抛出按失败计。
 * @param {() => Promise<Array>} args.listActive 当前 active 卡完整记录。
 * @param {(card:object) => string} args.embedText 卡 → 嵌入文本（controller 的
 *   cardEmbedText；与重建路径同一函数对象，口径天然一致）。
 * @param {object} args.gate createSemanticGate 产物（与 runSemanticRebuild 共用）。
 * @param {() => boolean} [args.canEmbed] 模型是否可用（false → 挂起不 embed）。
 * @param {() => boolean} [args.canWrite] 宿主是否可写（false → 挂起不写索引）。
 * @param {() => boolean} [args.shouldAbort] stop/banned 收场检查（检查点间轮询）。
 * @param {number} [args.debounceMs] 防抖毫秒（默认 300）。
 * @param {number} [args.batchSize] 每批嵌入后落盘间隔（默认 20）。
 * @param {() => string} [args.nowIso] 时间源（诊断时间戳；测试可注入）。
 * @returns {{markDirty, flushNow, kickStartupSync, close, stats}}
 */
export function createSemanticIncrementalQueue({
  scopeId,
  provider,
  openVectorStore,
  readCard,
  listActive,
  embedText,
  gate,
  canEmbed = () => true,
  canWrite = () => true,
  shouldAbort = () => false,
  debounceMs = SEMANTIC_INCREMENTAL_DEBOUNCE_MS,
  batchSize = DEFAULT_BATCH_SIZE,
  nowIso = () => new Date().toISOString(),
} = {}) {
  // 接线错误 fail-fast（controller 接线是编程行为，传错当场暴露，不带病运行）。
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    invalidInput("createSemanticIncrementalQueue: scopeId must be a non-empty string", { scopeId: typeof scopeId });
  }
  if (provider === null || provider === undefined || typeof provider.embed !== "function") {
    invalidInput("createSemanticIncrementalQueue: provider with embed() is required", { provider: typeof provider });
  }
  for (const [name, fn] of [["openVectorStore", openVectorStore], ["readCard", readCard], ["listActive", listActive], ["embedText", embedText]]) {
    if (typeof fn !== "function") {
      invalidInput(`createSemanticIncrementalQueue: ${name} must be a function`, { received: typeof fn });
    }
  }
  if (gate === null || gate === undefined || typeof gate.run !== "function") {
    invalidInput("createSemanticIncrementalQueue: gate (createSemanticGate) is required", {});
  }
  if (!Number.isInteger(debounceMs) || debounceMs <= 0) {
    invalidInput(`createSemanticIncrementalQueue: debounceMs must be a positive integer, got ${String(debounceMs)}`, {});
  }
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    invalidInput(`createSemanticIncrementalQueue: batchSize must be a positive integer, got ${String(batchSize)}`, {});
  }

  /** 待处理卡 id（Set 语义用 Map 承载，保插入序 → embed 顺序确定）。 */
  const dirty = new Map();
  let timer = null;
  let closed = false;
  /** 轮次串行链：flush 与启动差集共用（闸内仍再经 gate 与重建互斥）。 */
  let cycleChain = Promise.resolve();

  const stats = {
    /** 当前待补卡数（诊断 pending）。 */
    pending: 0,
    /** 是否有 flush/差集轮在执行（含在闸上排队等待的轮次）。 */
    running: false,
    /** 完成的 flush 轮数。 */
    flushes: 0,
    /** 累计 embed+upsert 张数（flush + 差集合计）。 */
    embedded: 0,
    /** 累计索引剔除条数。 */
    removed: 0,
    /** 完成的启动差集轮数。 */
    startupSyncs: 0,
    lastFlushAt: null,
    lastSyncAt: null,
    /** 最近一次失败（重试仍失败才留痕；成功不回填——面板只见当前故障）。 */
    lastError: null,
    /** 最近一次降级原因：host-readonly | model-not-installed | vector-store-unavailable。 */
    lastSkipReason: null,
  };

  function recordError(where, error) {
    stats.lastError = `${where}：${error instanceof Error ? error.message : String(error)}`;
  }

  function scheduleDebounce() {
    if (closed) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flushNow();
    }, debounceMs);
  }

  /** 把一轮处理排上串行链（flush / 差集共用；链内错误已各自收敛，不会断链）。 */
  function enqueueCycle(runner) {
    const cycle = cycleChain.then(runner, runner);
    cycleChain = cycle.then(() => {}, () => {});
    return cycle;
  }

  /**
   * 立即触发一轮 flush（绕过防抖；多调用共享串行链）。resolve 时本轮已收场：
   * 待处理卡已写入索引并落盘，或已记 lastError / lastSkipReason。
   * 绝不 reject（错误收敛进 stats，调用方拿 promise 直接 await 即可）。
   */
  function flushNow() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return enqueueCycle(runFlushCycle);
  }

  /**
   * 启动差集兜底（scope 首次打开索引时调用）：后台比对 active 卡 revision 与
   * 索引条目，不一致的后台增量重建、残留条目 retainOnly 剔除。不阻塞调用方
   * （fire-and-forget；promise 仅供测试/诊断 await，错误已收敛进 stats）。
   */
  function kickStartupSync() {
    return enqueueCycle(runStartupSync);
  }

  /**
   * 写钩子入口（wrapSparkStoreWithIncrementalHooks 调用）：同步零 IO，绝不阻塞
   * 工具返回。closed 后静默 no-op；非法 id 静默忽略（防御性，正常路径拿到的
   * 都是 store 生成/校验过的 id）。
   */
  function markDirty(id) {
    if (closed) return;
    if (typeof id !== "string" || id.length === 0) return;
    dirty.set(id, true);
    stats.pending = dirty.size;
    scheduleDebounce();
  }

  /** 停队列：清防抖 timer、丢弃 pending（stop 场景由下次 start 的启动差集兜底）。 */
  function close() {
    closed = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    dirty.clear();
    stats.pending = 0;
  }

  function statsSnapshot() {
    return { ...stats };
  }

  /**
   * 处理一批卡 id（闸内调用）。逐卡取读卡真值：
   *   读不到 / 非 active → 索引剔除（forget 语义）；
   *   revision 与索引一致 → 差集为零，零成本跳过；
   *   否则 embed(cardEmbedText(card)) → upsert（新向量覆盖旧条目——旧表述向量
   *   不再存在，召回自然只命中新内容）。
   * 单卡失败（读卡 / embed）记入 failedOut 并记诊断，不牵连其余卡；批间落盘。
   * 中止检查点：每卡前后（stop 后立即收场，不再消耗嵌入调用）。
   */
  async function processCards(store, ids, failedOut) {
    let embedded = 0;
    for (const id of ids) {
      if (closed || shouldAbort()) return; // 中止：剩余 id 不再处理（stop 场景派生数据允许滞后）
      let card = null;
      try {
        card = await readCard(id);
      } catch (error) {
        failedOut.push(id);
        recordError(`增量 读卡 ${id}`, error);
        continue;
      }
      if (card === null || card.state !== "active") {
        // forget / 物理消失：索引剔除（remove 只在真删了时置 dirty，零残留零误写）。
        if (store.remove(id)) stats.removed += 1;
        continue;
      }
      if (!Number.isInteger(card.revision) || card.revision < 0) {
        continue; // 与召回新鲜度判据同口径：无合法 revision 的卡不入索引，也不无限重试
      }
      const have = store.get(id);
      if (have !== null && have.revision === card.revision) {
        continue; // 已新鲜：差集为零（重建刚写过的卡在这里零成本收敛）
      }
      try {
        const vec = await provider.embed(embedText(card));
        if (closed || shouldAbort()) return;
        store.upsert(id, card.revision, vec);
        stats.embedded += 1;
        embedded += 1;
      } catch (error) {
        failedOut.push(id);
        recordError(`增量 嵌入 ${id}`, error);
        continue;
      }
      if (batchSize > 0 && embedded % batchSize === 0) {
        await store.saveIfDirty(); // 批间原子落盘：中断/失败后进度可续
      }
    }
  }

  /** flush 轮主体（绝不 reject；错误进 stats.lastError）。 */
  async function runFlushCycle() {
    if (dirty.size === 0) return; // 合并去重后的空轮：直接收场
    if (closed || shouldAbort()) return;
    stats.running = true;
    try {
      await gate.run(async () => {
        if (closed || shouldAbort()) return;
        if (!canWrite()) {
          stats.lastSkipReason = "host-readonly";
          return; // pending 保留：等写权回来后的下次触发
        }
        if (!canEmbed()) {
          stats.lastSkipReason = "model-not-installed";
          return; // pending 保留：模型就绪（或下载后自动 force 重建）后收敛
        }
        const store = await openVectorStore();
        if (store === null) {
          stats.lastSkipReason = "vector-store-unavailable";
          return;
        }
        // 原子取走当前待处理集合：处理期间新到的 markDirty 落在 live dirty 里，
        // 由下一轮处理——「取走」与「新标记」互不竞态，同卡重标最多多嵌一次
        // （embed 读的是取走后的卡真值，写回仍是 upsert 覆盖，方向安全）。
        const batch = [...dirty.keys()];
        dirty.clear();
        stats.pending = 0;
        const failed = [];
        await processCards(store, batch, failed);
        if (failed.length > 0 && !closed && !shouldAbort()) {
          // 硬要求 1：失败静默重试一次（仅失败子集；成功者不重嵌）。
          const failedAgain = [];
          await processCards(store, failed, failedAgain);
          if (failedAgain.length > 0) {
            for (const id of failedAgain) dirty.set(id, true);
            stats.pending = dirty.size; // 仍失败：保留 pending 等下次触发，lastError 已留痕
          }
        }
        if (dirty.size === 0 && !closed && !shouldAbort()) {
          stats.lastError = null; // 本轮全部收敛：清掉旧失败（面板只见当前故障）
        }
        await store.saveIfDirty(); // 轮末兜底落盘（无变更时 no-op，零 IO）
      });
      stats.flushes += 1;
    } catch (error) {
      // openVectorStore / saveIfDirty 等基础设施错误：记诊断，绝不外溢打断写工具。
      recordError("增量 flush", error);
    } finally {
      stats.running = false;
      stats.lastFlushAt = nowIso();
    }
  }

  /** 启动差集轮主体（绝不 reject）。 */
  async function runStartupSync() {
    if (closed || shouldAbort()) return;
    stats.running = true;
    try {
      await gate.run(async () => {
        if (closed || shouldAbort()) return;
        if (!canWrite()) {
          stats.lastSkipReason = "host-readonly";
          return;
        }
        if (!canEmbed()) {
          stats.lastSkipReason = "model-not-installed";
          return; // 模型未装：不把全量卡标 dirty（下载完成后的 force 重建会兜住全量）
        }
        const store = await openVectorStore();
        if (store === null) {
          stats.lastSkipReason = "vector-store-unavailable";
          return;
        }
        const cards = await listActive();
        const keepIds = new Set();
        for (const card of cards) {
          if (card !== null && typeof card === "object" && typeof card.id === "string" && card.id.length > 0) {
            keepIds.add(card.id);
          }
        }
        // 残留剔除：仅当确有残留才 retainOnly——store.retainOnly 无条件置 dirty，
        // 空剔除也会引发一次无谓落盘（甚至新建空索引文件），先用快照核对避免。
        const snapshot = store.snapshot();
        let residuals = 0;
        for (const id of Object.keys(snapshot.entries)) {
          if (!keepIds.has(id)) residuals += 1;
        }
        if (residuals > 0) {
          store.retainOnly(keepIds);
          stats.removed += residuals;
        }
        // 差集补齐：active 卡 revision 与索引不一致的后台增量重建。
        let embedded = 0;
        let failed = 0;
        for (const card of cards) {
          if (closed || shouldAbort()) return;
          if (card === null || typeof card !== "object") continue;
          if (typeof card.id !== "string" || card.id.length === 0) continue;
          if (!Number.isInteger(card.revision) || card.revision < 0) continue;
          const have = store.get(card.id);
          if (have !== null && have.revision === card.revision) continue;
          try {
            const vec = await provider.embed(embedText(card));
            if (closed || shouldAbort()) return;
            store.upsert(card.id, card.revision, vec);
            stats.embedded += 1;
            embedded += 1;
          } catch (error) {
            // 单卡失败：转入 dirty 队列交给下一轮 flush 重试；继续其余卡。
            failed += 1;
            dirty.set(card.id, true);
            stats.pending = dirty.size;
            recordError(`启动差集 嵌入 ${card.id}`, error);
          }
          if (batchSize > 0 && embedded % batchSize === 0) {
            await store.saveIfDirty();
          }
        }
        if (residuals > 0 || embedded > 0) {
          await store.saveIfDirty();
        }
        if (failed > 0 && !closed && !shouldAbort()) {
          scheduleDebounce(); // 失败卡交给 flush 重试（flush 内还有一次静默重试）
        }
        stats.startupSyncs += 1;
      });
    } catch (error) {
      recordError("启动差集", error);
    } finally {
      stats.running = false;
      stats.lastSyncAt = nowIso();
    }
  }

  return { markDirty, flushNow, kickStartupSync, close, stats: statsSnapshot };
}
