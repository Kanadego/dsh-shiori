/**
 * Shiori host bridge — 宿主适配桥（P0 主入口）。
 *
 * createHostBridge({host, service, mode="shadow", config})
 *   -> {start(), stop(), onCompletedTool(event), diagnostics(), refresh()}
 *
 * mode：
 * - "shadow"（默认）：不注册同名工具、不注入 system section、不修改任何资料；
 *   仅订阅完成事件产诊断（只读观测，事件探针工作）。
 * - "active"：必须同时显式 config.hostBridge.allowActive === true；启动前做唯一写者 /
 *   工具所有者校验（宿主名单或注册冲突检测），冲突即中止并回收全部注册。
 *   不在真实 profile 启用（启用属于部署决策，见 docs/host/README.md）。
 *
 * L0/L1 以 section 函数逐次读取（宿主声明 asyncSectionText 时每次渲染直接读 service；
 * 否则用同步快照，快照在写入提交与完成事件后刷新）。完整宿主 system 的投影永远交宿主。
 * L2 永远不注册 section、不追加短 system；user 侧附件真实 API 未支持 —— 显式 UNSUPPORTED。
 *
 * 生命周期（第二轮 L1–L3 的修复）：
 * - 每次 start() 捕获本地代际 token（monotonic generation）；所有 await 之后验证 token，
 *   已取消/被替换的 start 不得订阅、注册或改 started，返回取消回执；
 * - 注册（含异步 registerTool 的 Promise<disposer>）与所属启动代绑定：非当前代的迟到
 *   注册只撤销自身，不进入当前代记录；
 * - start 失败只回收失败代拥有的注册；旧代迟到失败不影响新代的 token、快照、started
 *   或任何资源；
 * - start 进行中（starting）拒绝并发 start；stop() 推进代际使 in-flight start 在下一个
 *   检查点自取消，并回收当前全部注册。
 */
import { createCompressProbe } from "./compress-probe.mjs";
import { INVALID_INPUT, INVALID_STATE, UNSUPPORTED, isCodedError } from "./errors.mjs";
import { SECTION_CORE, SECTION_PERSONA, createCompatTools } from "./tools.mjs";

export { SECTION_CORE, SECTION_PERSONA };
export { COMPRESS_TOOL, normalizeCompletionEvent } from "./compress-probe.mjs";

const HOST_SECTION_NAMES = [SECTION_PERSONA, SECTION_CORE];

function requireFunction(obj, field, label) {
  const value = obj?.[field];
  if (typeof value !== "function") {
    throw INVALID_INPUT(`${label} must provide ${field}()`, { field, received: typeof value });
  }
  return value;
}

function validateHost(host) {
  if (host === null || typeof host !== "object") {
    throw INVALID_INPUT("host must be an object", { received: typeof host });
  }
  requireFunction(host, "registerSystemSection", "host");
  requireFunction(host, "registerTool", "host");
  requireFunction(host, "subscribeCompletedTools", "host");
  requireFunction(host, "getSessionInfo", "host");
  return host;
}

function validateService(service) {
  if (service === null || typeof service !== "object") {
    throw INVALID_INPUT("service must be an object", { received: typeof service });
  }
  for (const field of ["readPersona", "readCoreView", "readTopic", "listTopics", "search", "mutate"]) {
    requireFunction(service, field, "service");
  }
  return service;
}

function validateMode(mode, config) {
  if (mode !== "shadow" && mode !== "active") {
    throw INVALID_INPUT(`mode must be "shadow" or "active", got ${JSON.stringify(mode)}`, {});
  }
  if (mode === "active" && config?.hostBridge?.allowActive !== true) {
    throw INVALID_INPUT(
      'active mode requires explicit config.hostBridge.allowActive === true '
      + "(unique-writer opt-in; never enable on a real profile in P0)",
      {},
    );
  }
  return mode;
}

function registrationConflictError(error) {
  if (!isCodedError(error) && /already registered|duplicate|conflict/i.test(error?.message ?? "")) {
    return INVALID_STATE(`tool/section owner already exists: ${error.message}`, {});
  }
  return null;
}

export function createHostBridge({ host, service, mode = "shadow", config, now, probeSink } = {}) {
  validateHost(host);
  validateService(service);
  validateMode(mode, config);

  if (config?.hostBridge?.l2Delivery !== undefined) {
    throw UNSUPPORTED(
      "L2 spark delivery (user-side attachment) has no verified real host API in P0; "
      + "Shiori does not fake messages. Remove hostBridge.l2Delivery.",
      {},
    );
  }

  const asyncSectionText = host.capabilities?.asyncSectionText === true;
  const order = {
    persona: config?.hostBridge?.sectionOrder?.persona ?? 0,
    core: config?.hostBridge?.sectionOrder?.core ?? 0.5,
  };

  const probe = createCompressProbe({ now, sink: probeSink });

  /** 同步快照模式的 L0/L1 缓存；async 模式不使用。 */
  let snapshot = { persona: "", core: "" };
  let snapshotReady = false;
  /** 刷新尝试序号：同代并发刷新时，较早的读取迟到不得覆盖较新的快照（S1）。 */
  let snapshotSeq = 0;

  const state = {
    started: false,
    starting: false,
    startCount: 0,
    stopCount: 0,
    cancelCount: 0,
    /** 生命周期代际：stop()、start()、start 失败都推进；in-flight 启动据此自取消。 */
    generation: 0,
    /** 本代注册：{gen, fn, kind, name}。 */
    disposers: [],
    sections: [],
    tools: [],
    eventErrors: [],
    eventObservations: [],
    uniqueWriter: mode === "shadow" ? "not-required (shadow)" : "pending",
    restoredFromSink: false,
  };

  function trackDisposer(gen, disposer, kind, name) {
    if (typeof disposer !== "function") {
      throw INVALID_STATE(`host ${kind} registration for "${name}" did not return a disposer function`, {});
    }
    state.disposers.push({
      gen,
      kind,
      name,
      fn: () => {
        try {
          disposer();
          return true;
        } catch (error) {
          state.eventErrors.push(`dispose ${kind} "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
          return false;
        }
      },
    });
  }

  /** 只回收指定代际拥有的注册；gen 为当前代时同时重置本代可见状态。 */
  function disposeGeneration(gen) {
    state.disposers = state.disposers.filter((entry) => {
      if (entry.gen !== gen) return true;
      entry.fn();
      return false;
    });
    if (gen === state.generation) {
      state.sections = [];
      state.tools = [];
      state.started = false;
      snapshotReady = false;
      snapshot = { persona: "", core: "" };
    }
  }

  /** 回收当前全部注册（stop 用；代际由 stop 先推进）。 */
  function disposeAll() {
    while (state.disposers.length > 0) {
      state.disposers.pop().fn();
    }
    state.sections = [];
    state.tools = [];
    state.started = false;
    snapshotReady = false;
    snapshot = { persona: "", core: "" };
  }

  /**
   * 注册一个 section/tool；兼容同步 disposer 与 Promise<disposer>（真实 DSH 适配层的
   * registerTool 因动态 import 为 async）。注册与 gen 绑定：拿到 disposer 时若本代已被
   * stop()/新 start()/失败回收取代，立即撤销自身（不进入新代记录）。
   */
  async function registerOne(gen, registered, kind, name) {
    const disposer = await registered;
    if (gen !== state.generation) {
      try {
        disposer();
      } catch (error) {
        state.eventErrors.push(`late dispose ${kind} "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return false;
    }
    trackDisposer(gen, disposer, kind, name);
    return true;
  }

  /**
   * 刷新同步快照（S1/S3 的修复）。
   * @param {number} gen 发起调用所属的启动代际。
   * 提交纪律：
   * - 已失效代的刷新在改变任何共享刷新状态（包括序号）或发起读取之前就退出（S3）：
   *   否则旧代的迟到刷新会抢占最新序号，使新代的初始快照提交被序号屏障跳过；
   * - 读取结果先作为候选值，提交共享状态之前核对代际与序号：发起代已不是当前代 →
   *   丢弃候选；读取期间发起了更新的刷新（snapshotSeq 已前进）→ 较早读取丢弃（S1）。
   * @returns {boolean} 是否提交了候选快照（asyncSectionText 模式恒 true：无共享快照）
   */
  async function refreshSnapshot(gen) {
    if (asyncSectionText) return true;
    if (gen !== state.generation) return false; // 已失效代：不推进序号、不发起读取
    const mySeq = ++snapshotSeq;
    const [persona, view] = await Promise.all([
      service.readPersona(),
      service.readCoreView(),
    ]);
    if (gen !== state.generation) return false; // 旧代的迟到读取不得覆盖新代快照
    if (mySeq !== snapshotSeq) return false; // 已有更新的刷新在途/已提交：较早读取让位
    snapshot = {
      persona: persona?.text ?? "",
      core: view?.text ?? "",
    };
    snapshotReady = true;
    return true;
  }

  /** 工具可见的 service 视图：mutate 成功后刷新同步快照（Proxy 委托保持 receiver）。 */
  // A neutral target also supports frozen services: Proxy invariants forbid
  // replacing a frozen target method with our mutate/receiver wrapper.
  const serviceForTools = new Proxy(Object.create(null), {
    get(_target, prop) {
      const target = service;
      if (prop === "mutate") {
        return async (request) => {
          const gen = state.generation; // 刷新绑定发起工具调用的代际
          const result = await target.mutate(request);
          try {
            await refreshSnapshot(gen);
          } catch (error) {
            state.eventErrors.push(`snapshot refresh after mutate failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          return result;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  function sectionTextsAsync() {
    return {
      [SECTION_PERSONA]: async () => {
        const persona = await service.readPersona();
        return persona?.text ?? "";
      },
      [SECTION_CORE]: async () => {
        const view = await service.readCoreView();
        return view?.text ?? "";
      },
    };
  }

  function sectionTextsSync() {
    return {
      [SECTION_PERSONA]: () => {
        if (!snapshotReady) throw INVALID_STATE("shiori bridge snapshot not ready; call start() first", {});
        return snapshot.persona;
      },
      [SECTION_CORE]: () => {
        if (!snapshotReady) throw INVALID_STATE("shiori bridge snapshot not ready; call start() first", {});
        return snapshot.core;
      },
    };
  }

  /** 唯一写者 / 工具所有者校验：宿主名单优先，注册冲突兜底。 */
  function checkUniqueWriter(toolNames) {
    state.uniqueWriter = "verified-before-registration";
    const listed = typeof host.listRegisteredTools === "function"
      ? host.listRegisteredTools()
      : undefined;
    if (Array.isArray(listed)) {
      const owned = new Set(listed);
      const clash = toolNames.filter((name) => owned.has(name));
      if (clash.length > 0) {
        throw INVALID_STATE(
          `tool ownership conflict: ${clash.join(", ")} already registered by another provider `
          + "(same-name tool must have exactly one provider; is soul-md still enabled?)",
          { clash },
        );
      }
    }
    const listedSections = typeof host.listRegisteredSections === "function"
      ? host.listRegisteredSections()
      : undefined;
    if (Array.isArray(listedSections)) {
      const owned = new Set(listedSections);
      const clash = HOST_SECTION_NAMES.filter((name) => owned.has(name));
      if (clash.length > 0) {
        throw INVALID_STATE(`section ownership conflict: ${clash.join(", ")} already registered`, { clash });
      }
    }
  }

  async function start() {
    if (state.started) {
      throw INVALID_STATE("bridge already started; call stop() before start() again", {});
    }
    if (state.starting) {
      throw INVALID_STATE("start already in progress; await it before starting again", {});
    }
    state.startCount += 1;
    // 本地生命周期 token：stop() 或后续 start() 会推进 state.generation，使本代在
    // 每个 await 检查点自取消（L1/L2/L3 的核心机制）。
    const myGen = state.generation + 1;
    state.generation = myGen;
    state.starting = true;

    try {
      // 恢复重放：有持久化槽时先恢复 epoch 与已见事件（可能异步）。
      // restore 的提交由 isCurrent 代际校验把守（S2）：旧代的迟到恢复不得替换新代状态。
      if (probeSink) {
        const restored = await probe.restore({ isCurrent: () => myGen === state.generation });
        if (restored.cancelled) {
          state.cancelCount += 1;
          return { mode, cancelled: true, sections: [], tools: [] };
        }
        if (myGen !== state.generation) {
          state.cancelCount += 1;
          return { mode, cancelled: true, sections: [], tools: [] };
        }
        state.restoredFromSink = restored.restored;
      }

      // 完成事件订阅：shadow 与 active 都需要（只读观测，事件探针的来源）。
      const unsubscribe = host.subscribeCompletedTools((event) => {
        // 桥只消费已归一化事件；适配层负责把原始 session 事件映射为归一化形状。
        // 返回对应处理 Promise（契约 D）：宿主/运行时据此排空已派发监听器（含失败路径）。
        // 错误记入 eventErrors 后以失败回执收尾，返回的 Promise 永不 reject，
        // 避免不关心返回值的宿主遭遇 unhandled rejection。
        return onCompletedTool(event).catch((error) => {
          state.eventErrors.push(`completed-tool event failed: ${error instanceof Error ? error.message : String(error)}`);
          return { advanced: false, epoch: probe.diagnostics().epoch, reason: "handler-error" };
        });
      });
      trackDisposer(myGen, unsubscribe, "subscription", "completed-tools");

      if (mode === "active") {
        const tools = createCompatTools({ service: serviceForTools, getSessionInfo: () => host.getSessionInfo(), config });
        const toolNames = tools.map((t) => t.name);
        checkUniqueWriter(toolNames);

        // S3：start 只能在真实可用的初始同步快照存在时成功。refreshSnapshot 未提交
        // （被更新的同代刷新抢先提交序号）时重试取得最新序号；不用空值/默认值掩盖。
        try {
          let committed = false;
          while (!committed) {
            committed = await refreshSnapshot(myGen);
            if (myGen !== state.generation) {
              state.cancelCount += 1;
              return { mode, cancelled: true, sections: [], tools: [] };
            }
          }
        } catch (error) {
          throw INVALID_STATE(`active start failed: initial snapshot read failed: ${error instanceof Error ? error.message : String(error)}`, {});
        }
        if (myGen !== state.generation) {
          state.cancelCount += 1;
          return { mode, cancelled: true, sections: [], tools: [] };
        }

        const texts = asyncSectionText ? sectionTextsAsync() : sectionTextsSync();
        for (const [name, text] of Object.entries(texts)) {
          const sectionOrder = name === SECTION_PERSONA ? order.persona : order.core;
          const registered = await registerOne(myGen, host.registerSystemSection({ name, order: sectionOrder, text }), "section", name);
          if (!registered) {
            state.cancelCount += 1;
            return { mode, cancelled: true, sections: [], tools: [] };
          }
          state.sections.push(name);
        }
        for (const tool of tools) {
          const registered = await registerOne(myGen, host.registerTool(tool), "tool", tool.name);
          if (!registered) {
            state.cancelCount += 1;
            return { mode, cancelled: true, sections: [], tools: [] };
          }
          state.tools.push(tool.name);
        }
        state.uniqueWriter = "verified";
      }

      state.started = true;
      return { mode, sections: [...state.sections], tools: [...state.tools] };
    } catch (error) {
      // 只回收本代拥有的注册；旧代迟到失败不得影响新代（L3）。
      disposeGeneration(myGen);
      const conflict = registrationConflictError(error);
      if (conflict && myGen === state.generation) state.uniqueWriter = "conflict-detected";
      throw conflict ?? error;
    } finally {
      if (myGen === state.generation) {
        state.starting = false;
      }
    }
  }

  function stop() {
    state.stopCount += 1;
    // 推进代际：in-flight 的 start 在下一个检查点自取消；迟到的注册自撤销。
    state.generation += 1;
    state.starting = false;
    let disposed = 0;
    while (state.disposers.length > 0) {
      if (state.disposers.pop().fn()) disposed += 1;
    }
    state.sections = [];
    state.tools = [];
    state.started = false;
    snapshotReady = false;
    snapshot = { persona: "", core: "" };
    return { disposed };
  }

  /**
   * 完成事件入口（也是测试注入点）：归一化 -> 探针。
   * 只有 name=compress、success、且 blocksCreated>0（实际创建块证据）才推进 epoch。
   */
  async function onCompletedTool(rawEvent) {
    const observation = await probe.observe(rawEvent);
    state.eventObservations.push({ event: rawEvent, ...observation });
    while (state.eventObservations.length > 20) state.eventObservations.shift();
    // 完成事件可能意味着记忆文件被改动（例如兼容工具之外的手改）——刷新快照尽力而为。
    // 刷新绑定事件开始处理时的代际（S1）：等待期间被 stop/重启则丢弃候选。
    if (observation.advanced || observation.reason === "not-compress") {
      const gen = state.generation;
      try {
        await refreshSnapshot(gen);
      } catch {
        /* 诊断已由 eventErrors 之外的场景覆盖；快照刷新失败不阻断事件处理 */
      }
    }
    return observation;
  }

  /**
   * 手动刷新同步快照（async 模式下是 no-op 且恒视为已提交）。绑定调用时的代际。
   * @returns {Promise<boolean>} 是否提交了候选快照。false 表示被更新的同代刷新抢先或
   *   发起代已失效——调用方不得据此宣称投影已更新（契约 D：刷新失败须显式可判）。
   */
  async function refresh() {
    return refreshSnapshot(state.generation);
  }

  function diagnostics() {
    return {
      mode,
      started: state.started,
      starting: state.starting,
      startCount: state.startCount,
      stopCount: state.stopCount,
      cancelCount: state.cancelCount,
      asyncSectionText,
      restoredFromSink: state.restoredFromSink,
      sections: [...state.sections],
      tools: [...state.tools],
      uniqueWriter: state.uniqueWriter,
      probe: probe.diagnostics(),
      eventErrors: [...state.eventErrors],
      recentEvents: state.eventObservations.map(({ event, ...rest }) => ({ eventId: event?.eventId, ...rest })),
      l2Delivery: "unsupported-in-P0",
      projection: "host-owned",
    };
  }

  return { start, stop, onCompletedTool, diagnostics, refresh };
}
