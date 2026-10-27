/**
 * Shiori P1-RUNTIME · 隔离运行时装配（slot D 交付）。
 *
 *     export async function createShioriRuntime(options, dependencies = {})
 *       -> { start(), stop(), refresh(), diagnostics(), service, bridge, host }
 *
 * 契约见 ../../CONTRACTS.md §D。核心边界：
 * - scope/root 只来自 factory 可信参数（activeScopeId / dataRoot / stateRoot），
 *   工具 payload 不可能改变它们（tools 层 rejectScope，service 层 noScope，本模块不引入新入口）；
 * - dataRoot 与 stateRoot 必须是不同的绝对路径且互不嵌套（含 junction/symlink 解析后判定）；
 * - shadow：构造/start/stop 全程不调用有写副作用的 factory（createShioriService/createFileStore
 *   构造即 mkdir 磁盘）。未显式注入只读 service 时使用「诚实的 UNSUPPORTED 门面」：
 *   读与写全部抛 UNSUPPORTED 并计入诊断，绝不用空文本冒充真实读取；
 * - active：必须显式 config.hostBridge.allowActive === true（本模块绝不代为设置/篡改）；
 *   service 用注入 factory 以 dataRoot 为 root 创建；host 用 createHost(pluginCtx,
 *   {trustedScopeId, loadDshTools}) 创建；E 的 handle.sink 作为 probeSink 交给 bridge；
 * - openCompletionState 必须显式注入（E 的工厂；基线没有实现，本模块不假造内存持久化）。
 *   缺失即 UNSUPPORTED，不静默降级为 memory-only；
 * - 传给 service 的 config 剥离 hostBridge 段（core 的 validateConfig 拒绝未知顶层键；
 *   hostBridge 属 bridge 专属段，剥离不改变 allowActive 的语义——bridge 仍拿原始 config）。
 *
 * 生命周期（全部可 await；start/stop 串行化，语义明确）：
 * - start 前不创建 host/bridge/service/handle，host 上零注册；
 * - start：open handle -> create host（事件排空包装）-> service（active：createService 或
 *   显式注入；shadow：注入或 UNSUPPORTED 门面）-> create bridge(probeSink=handle.sink)
 *   -> await bridge.start()。任一步失败：回收本代（bridge.stop -> 排空已派发事件 ->
 *   host.flushCompletedTools? -> handle.flush -> handle.close），再抛原错误；
 * - stop（幂等）：bridge.stop()（撤销订阅＝禁止新事件）-> 排空在途完成事件 ->
 *   host.flushCompletedTools?() -> handle.flush() -> handle.close()。只调同步 bridge.stop
 *   不等于排空，本模块的 stop 必须等在途任务落盘后才返回；
 * - stop 进行中调用 start：串行化后等待 stop 完成，再开始全新一代（不与旧代句柄重叠）；
 *   start 进行中再 start：INVALID_STATE；已 start 再 start：INVALID_STATE；
 * - 每代独立 drain 跟踪器与 handle；旧代迟到回调由 bridge 的代际机制隔离，本模块
 *   不让旧代清理覆盖新代实例。
 */
import path from "node:path";
import { realpath } from "node:fs/promises";
import { createShioriService } from "../service/index.mjs";
import { createDshHostAbstraction } from "../host/dsh-adapter.mjs";
import { createHostBridge } from "../host/index.mjs";
import { INVALID_INPUT, INVALID_STATE, UNSUPPORTED } from "../host/errors.mjs";

const HISTORY_LIMIT = 20;

/** Windows 路径大小写不敏感：比较时折叠；POSIX 保持原样。 */
const foldForCompare = process.platform === "win32"
  ? (p) => path.resolve(p).toLowerCase()
  : (p) => path.resolve(p);

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * 解析路径的「既有前缀 realpath + 剩余尾部」形式：
 * 根目录可能尚不存在，但已存在部分的符号链接/junction 必须先解析，否则
 * dataRoot/stateRoot 可借助未解析的链接互相嵌套（契约：拒绝越根 link）。
 */
async function resolveThroughLinks(p) {
  let current = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...tail);
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.join(current, ...tail); // 到达文件系统根
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * 校验 dataRoot/stateRoot：均为绝对路径、互不相同、互不嵌套。
 * 双重判定：原始 resolve 路径 + 穿透既有链接的 realpath 路径（防 junction/symlink 逃逸）。
 * （P5 导出：plugin controller 与 runtime 共用同一根校验语义。）
 */
export async function validateRoots({ dataRoot, stateRoot }) {
  for (const [name, value] of [["dataRoot", dataRoot], ["stateRoot", stateRoot]]) {
    if (!isNonEmptyString(value) || !path.isAbsolute(value)) {
      throw INVALID_INPUT(`${name} must be an explicit absolute path (no home/memory defaults)`, {
        field: name,
        received: typeof value,
      });
    }
  }
  const rawPairs = [[foldForCompare(dataRoot), foldForCompare(stateRoot)]];
  const realData = await resolveThroughLinks(dataRoot);
  const realState = await resolveThroughLinks(stateRoot);
  rawPairs.push([foldForCompare(realData), foldForCompare(realState)]);

  for (const [a, b] of rawPairs) {
    if (a === b) {
      throw INVALID_INPUT("dataRoot and stateRoot must be different paths (they resolve to the same location)", {
        dataRoot,
        stateRoot,
      });
    }
    const sep = path.sep;
    if (a.startsWith(b + sep) || b.startsWith(a + sep)) {
      throw INVALID_INPUT(
        "dataRoot and stateRoot must not nest inside each other (checked on raw and link-resolved paths; "
        + "out-of-root links are rejected)",
        { dataRoot, stateRoot, resolved: { dataRoot: realData, stateRoot: realState } },
      );
    }
  }
  return { realData, realState };
}

/** bridge 所需的 service 形状（与 src/host/index.mjs validateService 一致）。 */
function hasServiceShape(service) {
  if (service === null || typeof service !== "object") return false;
  for (const field of ["readPersona", "readCoreView", "readTopic", "listTopics", "search", "mutate"]) {
    if (typeof service[field] !== "function") return false;
  }
  return true;
}

/**
 * shadow 的「诚实门面」：具备 bridge 要求的全部方法形状，但任何读/写都抛 UNSUPPORTED
 * 并留下诊断痕迹。绝不能返回空字符串冒充真实读取（契约 D 明文）。
 */
function createShadowUnsupportedFacade() {
  const stats = { kind: "shadow-unsupported-facade", readAttempts: 0, mutateAttempts: 0, lastError: null };
  const refuse = (operation) => {
    stats.lastError = {
      operation,
      code: "UNSUPPORTED",
      message: `shadow runtime has no read-only service injected; ${operation}() is UNSUPPORTED `
        + "(no fabricated reads or writes in shadow mode)",
    };
    throw UNSUPPORTED(stats.lastError.message, { operation });
  };
  const read = (operation) => async () => {
    stats.readAttempts += 1;
    refuse(operation);
  };
  const service = {
    readPersona: read("readPersona"),
    readCoreView: read("readCoreView"),
    readTopic: read("readTopic"),
    listTopics: read("listTopics"),
    search: read("search"),
    mutate: async () => {
      stats.mutateAttempts += 1;
      refuse("mutate");
    },
  };
  return { service, stats };
}

/**
 * 事件排空跟踪：包装 host.subscribeCompletedTools，记录每次监听器调用返回的
 * 处理 Promise（bridge 的监听器按契约返回对应 Promise）。stop 时 allSettled 排空。
 */
function createDrainTracker() {
  const inflight = new Set();
  let drainedTotal = 0;
  const errors = [];
  return {
    track(promise) {
      inflight.add(promise);
      promise.then(
        () => inflight.delete(promise),
        () => inflight.delete(promise),
      );
    },
    /** 记录监听器派发路径上的同步失败（防御路径；正常路径经 track 的 rejected promise 汇入）。 */
    note(message) {
      errors.push(message);
    },
    get inflightCount() {
      return inflight.size;
    },
    get drainedTotal() {
      return drainedTotal;
    },
    get errors() {
      return [...errors];
    },
    async drain() {
      // 新事件可能由 host 内部在途队列继续派发给已注册监听器：循环到排空为止。
      while (inflight.size > 0) {
        const batch = [...inflight];
        const settled = await Promise.allSettled(batch);
        drainedTotal += batch.length;
        for (const result of settled) {
          if (result.status === "rejected") {
            const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
            errors.push(`drained listener rejected: ${reason}`);
          }
        }
      }
      return { drainedTotal, errors: [...errors] };
    },
  };
}

/**
 * 用 Proxy 包装 host：subscribeCompletedTools 注入跟踪，其余成员原样透传（绑定原 host）。
 * bridge 拿到的是包装对象；runtime.host 暴露原始 host。
 */
function wrapHostForDrain(host, drain) {
  return new Proxy(host, {
    get(target, prop) {
      if (prop === "subscribeCompletedTools") {
        return (listener) => target.subscribeCompletedTools((event) => {
          let result;
          try {
            result = listener(event);
          } catch (error) {
            // 防御路径：契约要求 bridge 监听器返回 Promise（不同步抛）。
            // 如实记录后返回 undefined，绝不给宿主留下 unhandled rejection。
            const reason = error instanceof Error ? error.message : String(error);
            drain.note(`listener threw synchronously: ${reason}`);
            return undefined;
          }
          if (result && typeof result.then === "function") drain.track(result);
          return result;
        });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** E 句柄的最低形状校验：缺能力即失败，不偷用残缺句柄。 */
function validateCompletionHandle(handle) {
  if (handle === null || typeof handle !== "object") {
    throw INVALID_STATE("openCompletionState must return a handle object", { received: typeof handle });
  }
  for (const method of ["flush", "close"]) {
    if (typeof handle[method] !== "function") {
      throw INVALID_STATE(`completion handle.${method}() is required by the runtime contract`, { method });
    }
  }
  if (handle.sink === null || typeof handle.sink !== "object"
    || typeof handle.sink.load !== "function" || typeof handle.sink.save !== "function") {
    throw INVALID_STATE("completion handle.sink requires load() and save()", {});
  }
  return handle;
}

/**
 * active 直写投影包装（review-D-a1 阻断项修复）：
 * 默认真实适配层为同步快照模式（asyncSectionText=false），section 文本读桥快照；
 * 桥工具路径的 mutate 自带提交后刷新，但绕过工具的直接 service.mutate 不会。
 * 本包装让所有经 runtime.service 暴露的 mutate（直写含在其中）成功后刷新当前代
 * 桥快照，保证「写后下次 assemble 可见」；下次 assemble 无需手动 refresh。
 *
 * 边界：
 * - 刷新失败不否定已提交的 mutate（与桥工具路径一致），错误如实记入诊断；
 * - 仅当调用时的包装仍属于当前代且 runtime 处于 started 才刷新——旧代引用在
 *   stop/重启后静默跳过刷新（不触碰新代桥、不产生未处理拒绝）；
 * - 用中性 target 的 Proxy 转发冻结 service（基线 createShioriService 返回冻结对象，
 *   直接代理其 mutate 属性会触发 Proxy invariant 异常，与桥的 serviceForTools 同款处理）；
 * - 桥工具路径经此包装会多一次刷新读取（随后桥自身仍按 S1 序号刷新）：额外一次
 *   只读开销，正确性由序号屏障保证。
 */
function createProjectionWrappingService(rawService, runtime) {
  const refreshErrors = [];
  const wrapped = new Proxy(Object.create(null), {
    get(_target, prop) {
      if (prop === "mutate") {
        return async (request) => {
          const result = await rawService.mutate(request);
          const attempt = runtime.current;
          if (runtime.state === "started" && attempt !== null && attempt.service === wrapped) {
            try {
              await attempt.bridge.refresh();
            } catch (error) {
              const message = `snapshot refresh after direct service.mutate failed: ${error instanceof Error ? error.message : String(error)}`;
              refreshErrors.push(message);
              runtime.lastRefresh = { refreshed: false, error: message, at: new Date().toISOString() };
            }
          }
          return result;
        };
      }
      const value = Reflect.get(rawService, prop, rawService);
      return typeof value === "function" ? value.bind(rawService) : value;
    },
  });
  return { service: wrapped, refreshErrors };
}

/**
 * @param {object} options
 * @param {object} options.pluginCtx                     宿主插件上下文（交 createHost）
 * @param {string} options.dataRoot                      记忆数据根（active 模式由 service 初始化）
 * @param {string} options.stateRoot                     E 完成状态根（独立于 dataRoot）
 * @param {string} options.activeScopeId                 可信 scope（factory 参数，绝不出自工具 payload）
 * @param {"shadow"|"active"} [options.mode="shadow"]
 * @param {object} [options.config]                      原样传 bridge；剥离 hostBridge 后传 service
 * @param {object} [options.personaAdapter]              交 service；缺省即魂卡 UNSUPPORTED
 * @param {Function} [options.loadDshTools]              交 createHost（隔离测试注入 defineTool）
 * @param {object} [options.service]                     显式注入合成/只读 service（shadow 观测或隔离测试）
 * @param {object} [dependencies]
 * @param {Function} [dependencies.createService]        默认基线 createShioriService
 * @param {Function} [dependencies.createHost]           默认基线 createDshHostAbstraction
 * @param {Function} [dependencies.createBridge]         默认基线 createHostBridge
 * @param {Function} dependencies.openCompletionState    必须显式注入（E 工厂）；缺失即 UNSUPPORTED
 */
export async function createShioriRuntime(options, dependencies = {}) {
  if (options === null || typeof options !== "object") {
    throw INVALID_INPUT("options must be an object", { received: typeof options });
  }
  if (dependencies === null || typeof dependencies !== "object") {
    throw INVALID_INPUT("dependencies must be an object", { received: typeof dependencies });
  }

  const {
    pluginCtx,
    dataRoot,
    stateRoot,
    activeScopeId,
    mode = "shadow",
    config = {},
    personaAdapter,
    loadDshTools,
    service: injectedService,
  } = options;

  if (pluginCtx === null || typeof pluginCtx !== "object") {
    throw INVALID_INPUT("pluginCtx must be an object (validated further by the host factory)", {
      received: typeof pluginCtx,
    });
  }
  if (mode !== "shadow" && mode !== "active") {
    throw INVALID_INPUT(`mode must be "shadow" or "active", got ${JSON.stringify(mode)}`, {});
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw INVALID_INPUT("config must be a plain object", {});
  }
  if (!isNonEmptyString(activeScopeId)) {
    throw INVALID_INPUT("activeScopeId must be a non-empty string from the trusted factory (never from tool payloads)", {});
  }
  if (loadDshTools !== undefined && typeof loadDshTools !== "function") {
    throw INVALID_INPUT("loadDshTools must be a function when provided", {});
  }
  if (personaAdapter !== undefined
    && (typeof personaAdapter?.read !== "function" || typeof personaAdapter?.commit !== "function")) {
    throw INVALID_INPUT("personaAdapter requires read() and commit()", {});
  }
  if (injectedService !== undefined && !hasServiceShape(injectedService)) {
    throw INVALID_INPUT(
      "options.service must satisfy the bridge service contract "
      + "(readPersona/readCoreView/readTopic/listTopics/search/mutate)",
      {},
    );
  }

  // active 的显式开关：本模块绝不代为设置 allowActive（契约 D）。
  if (mode === "active" && config?.hostBridge?.allowActive !== true) {
    throw INVALID_INPUT(
      'active mode requires explicit config.hostBridge.allowActive === true '
      + "(the runtime never sets or relaxes this switch itself)",
      {},
    );
  }

  await validateRoots({ dataRoot, stateRoot });

  // 依赖装配：前三个可换注入，openCompletionState 必须显式给出（基线无 E 实现）。
  const createService = dependencies.createService ?? createShioriService;
  const createHost = dependencies.createHost ?? createDshHostAbstraction;
  const createBridge = dependencies.createBridge ?? createHostBridge;
  const { openCompletionState } = dependencies;
  for (const [name, value] of [["createService", createService], ["createHost", createHost], ["createBridge", createBridge]]) {
    if (typeof value !== "function") {
      throw INVALID_INPUT(`dependencies.${name} must be a function when provided`, {});
    }
  }
  if (typeof openCompletionState !== "function") {
    throw UNSUPPORTED(
      "openCompletionState must be injected as an implemented completion-state factory (E); "
      + "the runtime does not fabricate in-memory persistence or silently downgrade to memory-only",
      {},
    );
  }

  // service 拿剥离 hostBridge 的浅拷贝（core validateConfig 拒绝未知顶层键；bridge 拿原始 config）。
  const serviceConfig = Object.fromEntries(
    Object.entries(config).filter(([key]) => key !== "hostBridge"),
  );

  const runtime = {
    state: "idle", // idle | starting | started | stopping
    startCount: 0,
    stopCount: 0,
    startFailures: [],
    lastStopReport: null,
    lastRefresh: null,
    current: null,
  };

  // start/stop 串行化：后到的动作等待在途动作完成后执行（含 stop 中的 start —— 明确等待语义）。
  let chain = Promise.resolve();
  function serialize(action) {
    const run = chain.then(action, action);
    chain = run.then(() => {}, () => {});
    return run;
  }

  function rememberFailure(error) {
    runtime.startFailures.push(error instanceof Error ? `${error.code ?? "UNCODED"}: ${error.message}` : String(error));
    while (runtime.startFailures.length > HISTORY_LIMIT) runtime.startFailures.shift();
  }

  /**
   * 回收一代实例：bridge 停（撤销订阅＝禁止新事件）→ 排空在途完成事件 →
   * host 侧 flush（若宿主提供）→ handle.flush → handle.close。
   * 每步尽力执行并收集错误；不因单步失败跳过后续清理。
   */
  async function recycleAttempt(attempt, phase) {
    const errors = [];
    if (attempt.bridge) {
      try {
        attempt.bridge.stop();
      } catch (error) {
        errors.push(`bridge.stop (${phase}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const drained = await attempt.drain.drain();
      for (const message of drained.errors) errors.push(`drain (${phase}): ${message}`);
    } catch (error) {
      errors.push(`drain (${phase}): ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof attempt.host?.flushCompletedTools === "function") {
      try {
        await attempt.host.flushCompletedTools();
      } catch (error) {
        errors.push(`host.flushCompletedTools (${phase}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (attempt.handle) {
      try {
        await attempt.handle.flush();
      } catch (error) {
        errors.push(`handle.flush (${phase}): ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await attempt.handle.close();
      } catch (error) {
        errors.push(`handle.close (${phase}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return errors;
  }

  async function start() {
    // 同步预检：正在 start / 已 start 立即拒绝（与桥的语义一致；不把并发 start 排队成
    // 「前一个完成后悄悄再启一代」的意外行为）。排队竞态由 serialize 段内的同款检查兜底。
    if (runtime.state === "starting") {
      throw INVALID_STATE("runtime start already in progress; await it before starting again", {});
    }
    if (runtime.state === "started") {
      throw INVALID_STATE("runtime already started; call stop() before start() again", {});
    }
    return serialize(async () => {
      if (runtime.state === "starting") {
        throw INVALID_STATE("runtime start already in progress; await it before starting again", {});
      }
      if (runtime.state === "started") {
        throw INVALID_STATE("runtime already started; call stop() before start() again", {});
      }
      // stop 进行中到达的 start：已由 serialize 等待 stop 完成，这里从 idle 正常开始全新一代。
      runtime.state = "starting";
      runtime.startCount += 1;
      const attempt = {
        generation: runtime.startCount,
        handle: null,
        host: null,
        bridge: null,
        service: null,
        serviceKind: "not-set",
        facadeStats: null,
        drain: createDrainTracker(),
        openedAt: new Date().toISOString(),
      };
      try {
        attempt.handle = validateCompletionHandle(await openCompletionState({ root: stateRoot, scopeId: activeScopeId }));
        attempt.host = createHost(pluginCtx, { trustedScopeId: activeScopeId, loadDshTools });
        if (mode === "active") {
          let rawService;
          if (injectedService !== undefined) {
            rawService = injectedService;
            attempt.serviceKind = "injected";
          } else {
            rawService = await createService({
              root: dataRoot,
              activeScopeId,
              config: serviceConfig,
              ...(personaAdapter !== undefined ? { personaAdapter } : {}),
            });
            if (!hasServiceShape(rawService)) {
              throw INVALID_STATE("createService must return an object satisfying the bridge service contract", {});
            }
            attempt.serviceKind = "created";
          }
          // 直写可见性（review-D-a1）：runtime.service 暴露投影刷新包装，直写 mutate
          // 提交后下次 assemble 即当前值；桥与外部拿到的是同一对象。
          const projection = createProjectionWrappingService(rawService, runtime);
          attempt.service = projection.service;
          attempt.projectionRefreshErrors = projection.refreshErrors;
        } else if (injectedService !== undefined) {
          attempt.service = injectedService;
          attempt.serviceKind = "injected";
        } else {
          const facade = createShadowUnsupportedFacade();
          attempt.service = facade.service;
          attempt.facadeStats = facade.stats;
          attempt.serviceKind = "shadow-unsupported-facade";
        }
        const hostForBridge = wrapHostForDrain(attempt.host, attempt.drain);
        attempt.bridge = createBridge({
          host: hostForBridge,
          service: attempt.service,
          mode,
          config,
          probeSink: attempt.handle.sink,
        });
        const started = await attempt.bridge.start();
        runtime.current = attempt;
        runtime.state = "started";
        return { mode, generation: attempt.generation, ...started };
      } catch (error) {
        rememberFailure(error);
        const recycleErrors = await recycleAttempt(attempt, "start-failure");
        attempt.recycleErrors = recycleErrors;
        runtime.state = "idle";
        runtime.current = null;
        throw error;
      }
    });
  }

  async function stop() {
    return serialize(async () => {
      if (runtime.state === "idle") {
        // 幂等：对未启动/已停止的 runtime 调 stop 是无害 no-op。
        return { stopped: false, alreadyIdle: true, generation: null, disposed: 0, drained: 0, handleClosed: false, errors: [] };
      }
      const attempt = runtime.current;
      const generation = attempt?.generation ?? null;
      runtime.state = "stopping";
      const errors = await recycleAttempt(attempt ?? { drain: createDrainTracker() }, "stop");
      runtime.current = null;
      runtime.state = "idle";
      runtime.stopCount += 1;
      const report = {
        stopped: true,
        alreadyIdle: false,
        generation,
        disposed: null,
        drained: attempt?.drain.drainedTotal ?? 0,
        handleClosed: !errors.some((message) => message.startsWith("handle.close")),
        errors,
      };
      runtime.lastStopReport = report;
      return report;
    });
  }

  /**
   * 手动刷新投影（active 的同步快照模式；asyncSectionText 模式恒成功）。
   * 绝不把失败回写成成功：返回 { refreshed:false, reason|error } 并记入 diagnostics.refresh。
   */
  async function refresh() {
    const attempt = runtime.current;
    if (runtime.state !== "started" || !attempt) {
      throw INVALID_STATE("runtime is not started; refresh() requires a running generation", {});
    }
    let committed;
    try {
      committed = await attempt.bridge.refresh();
    } catch (error) {
      const entry = {
        refreshed: false,
        error: `${error?.code ? `${error.code}: ` : ""}${error instanceof Error ? error.message : String(error)}`,
        at: new Date().toISOString(),
      };
      runtime.lastRefresh = entry;
      return { ...entry };
    }
    if (committed === false) {
      const entry = {
        refreshed: false,
        reason: "superseded-or-stale-generation (snapshot not committed; projection NOT claimed updated)",
        at: new Date().toISOString(),
      };
      runtime.lastRefresh = entry;
      return { ...entry };
    }
    const entry = { refreshed: true, at: new Date().toISOString() };
    runtime.lastRefresh = entry;
    return { ...entry };
  }

  function diagnostics() {
    const attempt = runtime.current;
    return {
      mode,
      state: runtime.state,
      startCount: runtime.startCount,
      stopCount: runtime.stopCount,
      startFailures: [...runtime.startFailures],
      roots: { dataRoot, stateRoot },
      activeScopeId,
      service: attempt
        ? {
          kind: attempt.serviceKind,
          ...(attempt.facadeStats ? { facade: attempt.facadeStats } : {}),
          ...(attempt.projectionRefreshErrors
            ? { directWriteProjection: "refresh-after-mutate", refreshErrors: [...attempt.projectionRefreshErrors] }
            : {}),
        }
        : { kind: "not-started" },
      bridge: attempt?.bridge?.diagnostics() ?? null,
      host: attempt?.host?.diagnostics?.() ?? null,
      completion: attempt?.handle?.diagnostics?.() ?? { status: "not-open" },
      drain: {
        inflight: attempt?.drain.inflightCount ?? 0,
        drainedTotal: attempt?.drain.drainedTotal ?? 0,
        errors: attempt?.drain.errors ?? [],
      },
      refresh: runtime.lastRefresh,
      lastStopReport: runtime.lastStopReport,
      dependencyProvenance: {
        createService: dependencies.createService ? "injected" : "baseline-default (createShioriService)",
        createHost: dependencies.createHost ? "injected" : "baseline-default (createDshHostAbstraction)",
        createBridge: dependencies.createBridge ? "injected" : "baseline-default (createHostBridge)",
        openCompletionState: "injected (required; no default exists in this baseline)",
      },
    };
  }

  return {
    start,
    stop,
    refresh,
    diagnostics,
    get service() { return runtime.current?.service ?? null; },
    get bridge() { return runtime.current?.bridge ?? null; },
    get host() { return runtime.current?.host ?? null; },
  };
}
