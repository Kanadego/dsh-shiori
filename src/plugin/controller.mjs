// Shiori P5-PLUGIN · 可信宿主与业务 controller（slot P；CONTRACTS §2）。
//
//   export async function createShioriPluginController(ctx, settings, dependencies = {})
//     → {start(), stop(), diagnostics(), management}
//
// 生命周期（冻结契约）：
// - 构造不自动 start；start/stop 幂等、失败逆序清理；stop 禁新请求 → 撤订阅 /
//   timer / 注册 → 排空工具 / 事件 / RPC → flush → close；部分 start 失败不残留
//   工具 / section / 锁；同一 scope 资源复用（不每会话另开同 scope 独占锁）；
// - inert：shadow 且 dataRoot/stateRoot 皆 null → 不启 runtime、不接管工具 /
//   section、不读写业务数据；仅 management.getStatus 可用，其余 NOT_CONFIGURED；
// - active：16 工具（10 兼容 + topic_create + 6 Spark）经真实 defineTool 注册；
//   L0/L1 真实 async system-prompt/assemble waterfall 刷新；L2 经 agent/pre-step
//   投递（仅 l2.enabled）；压缩探针订阅完成事件（同 callId direct/PTC 仅推进一次）；
// - shadow（配置了 root）：纯内存只读挂载 —— 不注册工具 / section / waterfall /
//   pre-step，不打开 completion 锁 / scope 资源 / receipt（抢独占锁会把真的
//   active 实例挤成 LOCK_BUSY）；management 仅纯内存 getStatus。
//
// 宿主 complete section（如 dsh-persona preset complete:true）会在 waterfall 后
// 整体替换 sections —— 启动时探测；命中则不注册 L0/L1 并如实诊断（不谎报刷新）。
//
// 每次工具 / waterfall / pre-step / management 从可信证据解析并固定
// {sessionId, workspace, scopeId, ownerId, generation}，跨 await 不改写请求目标；
// payload 中危险身份字段显式拒绝。workspace 一律取自宿主 workingDirectory
// 服务（只读 get；绝不调用 ensure()——那会追加 working-directory/change 事件）。

import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { createShioriService } from "../service/index.mjs";
import { openSparkStore } from "../sparks/store.mjs";
import { createCompatTools, createTopicCreateTool } from "../host/tools.mjs";
import { createSparkTools } from "../sparks/tools.mjs";
import { createCompressProbe } from "../host/compress-probe.mjs";
import { mapRawSessionEvent } from "../host/dsh-adapter.mjs";
import { openCompletionState } from "../completion/index.mjs";
import { evaluateMutation } from "../core/index.mjs";
import { matchSparks } from "../sparks/match.mjs";
import { buildSparkAttachment, commitDelivery } from "../sparks/delivery.mjs";
import { createColdSearch } from "../forgetting/cold-search.mjs";
import { createPersonaAdapter } from "./persona.mjs";
import { createStateStore } from "./state.mjs";
import { createDshBindings, detectCompletePromptSections, detectCompleteSectionsForScope } from "./bindings.mjs";
import { createManagement } from "./management.mjs";
import { registerShioriTypert, readOptionalCordisService } from "./typert-descriptors.mjs";
import {
  validateControllerSettings, pinScope, sessionEvidenceFromExec,
  sessionEvidenceFromAgent, rejectIdentityFields, NULL_PERSONA_SCOPE, scopeIdForPersona,
} from "./scope.mjs";
import { TOOL_OUTPUT_SCHEMAS, renderToolOutput } from "./tool-schemas.mjs";
import { validateRoots } from "../runtime/index.mjs";

const SECTION_PERSONA = "shiori:persona";
const SECTION_CORE = "shiori:core";
const SECTION_ORDER = { persona: 0, core: 0.5 };

/** 写工具名（operationId 绑定 + 并发不安全）。 */
const WRITE_TOOL_NAMES = new Set([
  "soul_update", "memory_append", "memory_rewrite", "core_write",
  "topic_append", "topic_create",
  "spark_save", "spark_update", "spark_forget", "spark_feedback",
]);

/** 16 工具全名（契约清单）。 */
const ALL_TOOL_NAMES = Object.freeze([
  "soul_read", "soul_update", "memory_read", "memory_search",
  "memory_append", "memory_rewrite", "core_write", "topic_append",
  "topic_create", "memory_list_topics",
  "spark_save", "spark_read", "spark_update", "spark_forget",
  "spark_feedback", "spark_graph",
]);

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

export async function createShioriPluginController(ctx, rawSettings, dependencies = {}) {
  if (ctx === null || typeof ctx !== "object") {
    fail("INVALID_INPUT", "ctx must be an object (host plugin context)", {});
  }
  const settings = validateControllerSettings(rawSettings ?? {});
  if (dependencies === null || typeof dependencies !== "object") {
    fail("INVALID_INPUT", "dependencies must be an object", {});
  }
  const {
    createService = createShioriService,
    createSparkStore = openSparkStore,
    openState = openCompletionState,
    bindings: bindingsFactory = createDshBindings,
    createPersona = createPersonaAdapter,
    createState = createStateStore,
    now = () => new Date(),
    loadDshTools,
    loadDshLlm,
  } = dependencies;

  const isInert = settings.mode === "shadow" && settings.dataRoot === null && settings.stateRoot === null;
  const nowIso = () => now().toISOString();

  // 路径校验：active 或配置了任一 root 时必须显式提供两个绝对 root、disjoint、
  // 互不嵌套（含真实 link 解析）。ctx.baseUrl 不是 profileRoot；这里不猜 profileRoot，
  // 并列计算 shiori-data/shiori-state 仅由调用方（Q apply）显式给出。
  if (!isInert) {
    await validateRoots({ dataRoot: settings.dataRoot, stateRoot: settings.stateRoot });
  }

  const state = createState({ stateRoot: settings.stateRoot ?? "/nonexistent-shiori-inert" });
  const bindings = bindingsFactory(ctx, settings, { loadDshTools, loadDshLlm });

  const ctrl = {
    started: false,
    starting: false,
    /** 在途 start promise（B4：stop 必须先等它收场）。 */
    startingPromise: null,
    /** B4：stop 先置位；start 体内检查点见到即中止。 */
    stopRequested: false,
    startCount: 0,
    stopCount: 0,
    generation: 0,
    banned: false,
    /** 本代注册 disposer（逆序撤销）。 */
    disposers: [],
    /** scope 资源缓存：scopeId → {service, sparkStore, personaAdapter, tools, toolByName} */
    scopes: new Map(),
    /** 完成状态句柄（compress 探针持久化；单插件级锁，不按会话开）。 */
    completion: null,
    probe: null,
    /** 在途异步工作（排空用）。 */
    inFlight: new Set(),
    /** tool/result 归因表（callId → name；direct 模式归因用）。 */
    callNames: new Map(),
    /** 仅本次调用的 executePlan 授权。 */
    grants: new Set(),
    /** L0/L1 同步 section 缓存（waterfall 前的安全占位；waterfall 刷新）。 */
    sectionCache: new Map(),
    /** L2 投递消息创建器（start 时装载）。 */
    createUserMessage: null,
    /** M2：写工具按 (scope, tool) 串行化的 promise 尾。 */
    dispatchChains: new Map(),
    /** B2：启动时探测到的 **global 层** complete section（存在即 L0/L1 不注册）。 */
    completeShadowed: [],
    /** B2 诚实度：启动期探测三态 "ok"（global 可读且命中）/"none"（可读未命中）/"unavailable"（不可判定）。 */
    completeProbe: "none",
    /** B2 运行期：最近一次 assembly 所属 scope 的 complete 探测三态（同样三态）。 */
    assemblyProbe: "none",
    /** B2 诚实度：运行期出现过不可判定的装配（注册表不可读）——不得据此宣称 L0/L1 有效。 */
    assemblyProbeUnverified: false,
    /** P-C：Gateway 严格 codec 描述符注册状态（失败回退 SRC，不阻断启动）。 */
    typertRpc: { codec: "src", reason: "not registered", disposer: null },
    diag: {
      toolCalls: 0,
      toolReplays: 0,
      assemblies: 0,
      assembliesRefreshed: 0,
      assembliesDiagnosticOnly: 0,
      assemblyErrors: [],
      assemblySkips: [],
      /** B2 运行期：本次 assembly 入口含 foreign complete:true section（宿主会用快照整体替换 sections）的次数。 */
      assemblyCompleteShadowed: 0,
      completeSectionUnsupported: 0,
      l1OverBudget: 0,
      preSteps: 0,
      preStepDeliveries: 0,
      preStepEmpty: 0,
      acceptedReceipts: 0,
      l2Recoveries: 0,
      l2RecoveredFromSessionLog: 0,
      workingDirectoryLookups: 0,
      startFailures: [],
    },
  };

  // M3：工具执行期间的真实会话证据（getSessionInfo 经此取 sessionId）。
  const toolSessionContext = new AsyncLocalStorage();

  // B1：宿主 workingDirectory 服务只读解析（get 纯投影读；绝不 ensure()）。
  // B1-c：所有 scope 归属（工具/装配/管理/压缩事件）共用这一个 projection 读。
  function workspaceForSession(session) {
    try {
      if (session === undefined || session === null) return null;
      // B-P2 同类面：workingDirectory 不在入口 inject 里，属性访问在真机
      // Cordis fiber 会直接抛——走可选读取（ctx.get 优先），缺席仍回落 null。
      const service = readOptionalCordisService(ctx, "workingDirectory");
      if (service === null || typeof service !== "object" || typeof service.get !== "function") return null;
      const dir = service.get(session);
      if (typeof dir !== "string" || dir.length === 0) return null;
      ctrl.diag.workingDirectoryLookups += 1;
      return dir;
    } catch {
      return null;
    }
  }

  function workspaceForAgent(agent) {
    return workspaceForSession(agent?.session);
  }

  function trackInFlight(promise) {
    ctrl.inFlight.add(promise);
    promise.then(
      () => ctrl.inFlight.delete(promise),
      () => ctrl.inFlight.delete(promise),
    );
    return promise;
  }

  // ─────────────────────────────────────────────────────────
  // scope 资源（同 scope 复用）
  // ─────────────────────────────────────────────────────────

  async function resourcesFor(scopeId) {
    const cached = ctrl.scopes.get(scopeId);
    if (cached !== undefined) return cached;
    const personaAdapter = createPersona({
      dir: `${settings.dataRoot}/persona`,
      scopeId,
      maxChars: settings.budgets.persona.maxChars,
    }, { nowIso });
    const service = await createService({
      root: settings.dataRoot,
      activeScopeId: scopeId,
      config: settings.budgets,
      personaAdapter,
      now,
    });
    const sparkStore = await createSparkStore({ root: settings.dataRoot, scopeId });
    // 冷搜门面（显式 includeArchived 专用；只读、不复活、不自动匹配）。
    const coldSearch = createColdSearch({ store: sparkStore, scopeId });
    // service 包装：补 searchArchived（基线 service 冻结对象，中性 target Proxy）。
    const serviceForTools = new Proxy(Object.create(null), {
      get(_target, prop) {
        if (prop === "searchArchived") {
          return async (query) => {
            const result = await coldSearch.search({ query, limit: 20 });
            return result.items.map((item) => ({
              key: item.id,
              title: item.title,
              summary: item.summary,
              scopeId: item.scopeId ?? scopeId,
              score: 0,
              state: "archived",
            }));
          };
        }
        const value = Reflect.get(service, prop, service);
        return typeof value === "function" ? value.bind(service) : value;
      },
    });
    // 每 scope 工具集：与真实工具路径同校验 / coordinator / CAS。
    // 9 兼容 + topic_create + 6 Spark = 16（契约清单）。
    // M3：sessionId 取自 dispatchTool 的 AsyncLocalStorage 证据（真实会话 id，
    // 供工具侧「当前会话锁定」身份校验），不再固定 null。
    const getSessionInfo = () => ({
      sessionId: toolSessionContext.getStore()?.sessionId ?? null,
      scopeId,
    });
    const compatTools = [
      ...createCompatTools({
        service: serviceForTools,
        getSessionInfo,
        config: settings.budgets,
        now,
      }),
      createTopicCreateTool({
        service: serviceForTools,
        getSessionInfo,
        now,
      }),
    ];
    const sparkTools = createSparkTools({ scopeId, store: sparkStore }).tools;
    const all = [...compatTools, ...sparkTools];
    const toolByName = new Map(all.map((t) => [t.name, t]));
    const resources = {
      scopeId,
      personaAdapter,
      service,
      sparkStore,
      tools: all,
      toolByName,
      l2Recovered: false,
    };
    ctrl.scopes.set(scopeId, resources);
    return resources;
  }

  async function closeAllScopes() {
    const errors = [];
    for (const [scopeId, resources] of ctrl.scopes) {
      try {
        resources.sparkStore.close();
      } catch (error) {
        errors.push(`sparkStore.close(${scopeId}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    ctrl.scopes.clear();
    return errors;
  }

  // ─────────────────────────────────────────────────────────
  // 工具执行（真实工具路径与 management.executeTool 共用）
  // ─────────────────────────────────────────────────────────

  /** M2：写工具按 (scope, tool) 串行化——lookup → execute → record 窗口不并发。 */
  function serializeDispatch(key, fn) {
    const prev = ctrl.dispatchChains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {}).then(() => {
      if (ctrl.dispatchChains.get(key) === tail) ctrl.dispatchChains.delete(key);
    });
    ctrl.dispatchChains.set(key, tail);
    return run;
  }

  async function dispatchTool(scope, name, args, exec) {
    if (!ALL_TOOL_NAMES.includes(name)) {
      fail("INVALID_INPUT", `unknown shiori tool "${String(name)}"`, {});
    }
    // B4：禁新请求（stop 后）不再执行任何工具。
    if (ctrl.banned || !ctrl.started) {
      fail("INVALID_STATE", "controller is stopped or not started; tool dispatch refused", {});
    }
    rejectIdentityFields(args ?? {}, `tool:${name}`);
    const run = async () => {
      const resources = await resourcesFor(scope.scopeId);
      const tool = resources.toolByName.get(name);
      if (tool === undefined) {
        fail("INVALID_INPUT", `tool "${name}" is not available in scope "${scope.scopeId}"`, {});
      }
      let payload = { ...(args ?? {}) };
      let operationId = null;
      const fingerprintPayload = () => {
        const copy = { ...payload };
        delete copy.operationId;
        return copy;
      };
      if (WRITE_TOOL_NAMES.has(name)) {
        if (typeof payload.operationId === "string" && payload.operationId.length > 0) {
          operationId = payload.operationId;
        } else if (payload.operationId === undefined || payload.operationId === null) {
          operationId = randomUUID();
        } else {
          fail("INVALID_INPUT", `tool "${name}" operationId must be a non-empty string`, {});
        }
        payload.operationId = operationId;
        // 显式同 operationId 同请求重放首结果；先于任何新 read / 时间生成。
        const prior = await state.toolOpStore.lookup(scope.scopeId, name, operationId, fingerprintPayload());
        if (prior !== null) {
          ctrl.diag.toolReplays += 1;
          return prior;
        }
      }
      ctrl.diag.toolCalls += 1;
      // M3：真实会话证据注入 AsyncLocalStorage（getSessionInfo 消费）。
      const result = await toolSessionContext.run(
        { sessionId: scope.sessionId },
        () => tool.execute(payload, exec),
      );
      if (WRITE_TOOL_NAMES.has(name)) {
        await state.toolOpStore.record(scope.scopeId, name, operationId, fingerprintPayload(), result);
      }
      return result;
    };
    return WRITE_TOOL_NAMES.has(name)
      ? serializeDispatch(`${scope.scopeId}\u0000${name}`, run)
      : run();
  }

  /** 工具注册形态（真实 defineTool 之外的统一执行入口）。 */
  function registeredToolDefs() {
    return ALL_TOOL_NAMES.map((name) => ({
      name,
      description: toolDescription(name),
      inputSchema: toolInputSchema(name),
      outputSchema: TOOL_OUTPUT_SCHEMAS[name],
      outputRender: renderToolOutput,
      isConcurrencySafe: () => !WRITE_TOOL_NAMES.has(name),
      async execute(args, exec) {
        const evidence = sessionEvidenceFromExec(exec);
        // B4：代际与禁用检查在 pin 之前（stop 后不再受理新工具请求）。
        if (ctrl.banned || !ctrl.started) {
          fail("INVALID_STATE", "controller is stopped or not started; tool dispatch refused", {});
        }
        const scope = pinScope({
          settings,
          sessionId: evidence.sessionId,
          workspace: workspaceForAgent(evidence.agent),
          generation: ctrl.generation,
          source: "tool-exec",
        });
        return trackInFlight(dispatchTool(scope, name, args, exec));
      },
      presentCall: (args) => ({ card: "generic", title: name, kind: "other", rawInput: args }),
    }));
  }

  /** 工具描述 / 输入 schema 取自每 scope 资源的原型定义（惰性创建最小资源描述）。 */
  function toolDescription(name) {
    for (const resources of ctrl.scopes.values()) {
      const tool = resources.toolByName.get(name);
      if (tool !== undefined) return tool.description;
    }
    return `Shiori tool ${name}`;
  }

  function toolInputSchema(name) {
    for (const resources of ctrl.scopes.values()) {
      const tool = resources.toolByName.get(name);
      if (tool !== undefined) return tool.inputSchema;
    }
    return {};
  }

  /**
   * 确保描述/schema 可用：active 启动时预建资源（工具描述/schema 来源 + 启用
   * 探测）。B1：覆盖 defaultPersona 以及全部 sessionPersonas / workspacePersonas
   * 映射到的 scope（workspace 卡此前在生产不可达，预热保证面板与 L2 epoch
   * 账本按正确 scope 建立）。
   */
  function configuredScopeIds() {
    const personas = new Set();
    if (settings.defaultPersona !== null) personas.add(settings.defaultPersona);
    for (const e of settings.sessionPersonas) if (e.persona !== null) personas.add(e.persona);
    for (const e of settings.workspacePersonas) if (e.persona !== null) personas.add(e.persona);
    return [...personas].map((p) => scopeIdForPersona(p));
  }

  async function primeDefaultScope() {
    const scopeIds = configuredScopeIds();
    let last = null;
    for (const scopeId of scopeIds) {
      last = await resourcesFor(scopeId);
    }
    // 无任何配置 persona → global memory scope。
    return last ?? resourcesFor(NULL_PERSONA_SCOPE);
  }

  // ─────────────────────────────────────────────────────────
  // system-prompt/assemble waterfall（L0/L1 真实刷新）
  // ─────────────────────────────────────────────────────────

  function sectionEntryOf(assembly, name) {
    return assembly.sections.find((s) => s?.name === name);
  }

  async function assembleWaterfall(assembly, context, next) {
    const result = await next();
    // B4：代际/禁用检查——stop 后或旧代的装配不再读业务（宿主每轮必经路径，
    // 本函数注册后可能与 stop 并发）。
    if (ctrl.banned || !ctrl.started) {
      return result;
    }
    // B2：启动期 global 探测已命中时本包不注册 waterfall——此为竞态兜底。
    if (ctrl.completeShadowed.length > 0) {
      return result;
    }
    // B2 运行期语义（关键）：complete section 的遮蔽只对**它所属的那一次
    // assembly** 成立（宿主 dsh-system-prompt lib/index.js:380-403：assemble 前
    // 按本次 scope 合并 definitions 并收集 completeSections，waterfall 后若有快照
    // 则用 [completeSection] 整体替换 sections）。两个事实决定了运行期判定的写法：
    // 1) 传给 waterfall 的 assembly.sections 已被映射为 {name,text[,interpolate]}，
    //    **不再携带 complete 标记**（:385-393）——查入口 section 的 complete 永远不命中；
    // 2) 别的 scope 的 complete section 与本 scope 的装配无关（真机缺陷：preset-minimal
    //    的 complete persona 曾让全局 L0/L1 永不注入）。
    // 因此用宿主同一份合并结果在本 scope 内判定；命中即如实记账并原样返回：
    // 不刷新、不进 assembliesRefreshed、不谎报注入成功。
    const entrySections = Array.isArray(assembly?.sections) ? assembly.sections : [];
    const entryComplete = entrySections.filter(
      (s) => s?.complete === true && s?.name !== SECTION_PERSONA && s?.name !== SECTION_CORE,
    );
    const scopedProbe = detectCompleteSectionsForScope(ctx?.systemPrompt, context?.scope);
    ctrl.assemblyProbe = scopedProbe.state;
    const shadowSections = entryComplete.length > 0
      ? entryComplete.map((s) => ({ name: String(s?.name), scope: "entry" }))
      : scopedProbe.state === "ok" ? scopedProbe.sections : [];
    if (shadowSections.length > 0) {
      ctrl.diag.assemblyCompleteShadowed += 1;
      ctrl.diag.assemblySkips.push(
        `complete(${shadowSections.map((s) => `${s.name}@${s.scope}`).join(",")}): `
        + "this assembly's sections are replaced by a complete-section snapshot; "
        + "shiori L0/L1 not delivered",
      );
      if (ctrl.diag.assemblySkips.length > 50) ctrl.diag.assemblySkips.shift();
      return result;
    }
    if (scopedProbe.state === "unavailable") {
      // 注册表不可读 ≠ 有效：照常尽力刷新，但 diagnostics 不得宣称 L0/L1 有效。
      ctrl.assemblyProbeUnverified = true;
    }
    // 同步 provider 已先求值；waterfall 后固定可信 scope，await 刷新并仅替换本包 section。
    const evidence = sessionEvidenceFromAgent(context?.agent);
    if (evidence === null) {
      // 诊断装配：不读业务、不用上一次 agent。
      ctrl.diag.assembliesDiagnosticOnly += 1;
      return result;
    }
    try {
      ctrl.diag.assemblies += 1;
      const scope = pinScope({
        settings,
        sessionId: evidence.sessionId,
        workspace: workspaceForAgent(evidence.agent),
        generation: ctrl.generation,
        source: "assemble",
      });
      const resources = await resourcesFor(scope.scopeId);

      // B7：逐段错误隔离——一张坏卡只降级自己，不打挂整轮提示词装配。
      // 只替换成功读取的 section；读取失败的保留宿主原样并计诊断。
      const readable = new Map();
      try {
        const persona = await resources.service.readPersona();
        // L0：persona adapter 已保 lastvalid；stale 由 read() 标注并诊断。
        readable.set(SECTION_PERSONA, persona?.text ?? "");
      } catch (error) {
        // 非法卡且无 lastvalid：跳过 persona section（保留宿主原样），计诊断。
        ctrl.diag.assemblySkips.push(`persona(${scope.scopeId}): ${error instanceof Error ? error.message : String(error)}`);
        if (ctrl.diag.assemblySkips.length > 50) ctrl.diag.assemblySkips.shift();
      }

      // L1：完整渲染（含派生目录全预算）；超限保留 lastvalid 并告警，不截断铁律。
      try {
        const view = await resources.service.readCoreView();
        let coreText = view?.text ?? "";
        const hardCap = settings.budgets.core.hardCapChars;
        if (coreText.length > hardCap) {
          const lastvalid = await state.projectionStore.loadL1(scope.scopeId);
          ctrl.diag.l1OverBudget += 1;
          if (lastvalid !== null && lastvalid.text.length <= hardCap) {
            coreText = lastvalid.text;
          } else {
            coreText = "[shiori] L1 core view exceeds the configured hard cap and no last-valid "
              + "projection exists; delivering diagnostic placeholder instead of truncated rules. "
              + "Repair the core file (net reduction) before the next request.";
          }
        } else if (coreText.length > 0) {
          await state.projectionStore.saveL1(scope.scopeId, { text: coreText, revision: view?.revision ?? null });
        }
        readable.set(SECTION_CORE, coreText);
      } catch (error) {
        ctrl.diag.assemblySkips.push(`core(${scope.scopeId}): ${error instanceof Error ? error.message : String(error)}`);
        if (ctrl.diag.assemblySkips.length > 50) ctrl.diag.assemblySkips.shift();
      }

      if (readable.has(SECTION_PERSONA) || readable.has(SECTION_CORE)) {
        // 同步 section provider 的本 scope 缓存（waterfall 前的占位来源）。
        ctrl.sectionCache.set(scope.scopeId, {
          persona: readable.get(SECTION_PERSONA) ?? "",
          core: readable.get(SECTION_CORE) ?? "",
        });
      }
      let replaced = 0;
      for (const name of [SECTION_PERSONA, SECTION_CORE]) {
        if (!readable.has(name)) continue; // B7：坏卡 section 保留宿主原样
        const entry = sectionEntryOf(result, name);
        if (entry === undefined) {
          // complete-prompt composition 在 waterfall 后强制恢复原 scope section：
          // 本包不保证可附加 L1 —— 明确 UNSUPPORTED 诊断，不 monkey-patch。
          ctrl.diag.completeSectionUnsupported += 1;
          continue;
        }
        entry.text = readable.get(name);
        replaced += 1;
      }
      if (replaced > 0) ctrl.diag.assembliesRefreshed += 1;
    } catch (error) {
      // B7：本包刷新失败绝不外抛（宿主 waterfall 是每轮必经路径）；
      // 降级为「本轮无本包改写」，保留错误诊断供面板查看。
      ctrl.diag.assemblyErrors.push(`${error?.code ?? "UNCODED"}: ${error instanceof Error ? error.message : String(error)}`);
      if (ctrl.diag.assemblyErrors.length > 50) ctrl.diag.assemblyErrors.shift();
    }
    // 保留其他 section / tools / contexts / variables 及其他插件 waterfall 结果。
    return result;
  }

  // ─────────────────────────────────────────────────────────
  // 完成事件（压缩探针）与 L2 accepted receipt
  // ─────────────────────────────────────────────────────────

  function sessionEventListener() {
    return (session, event) => {
      const promise = (async () => {
        // 1) 压缩探针（direct/PTC 归一化 + 同 callId 去重；同 callId 仅推进一次，
        //    重放/未知/错误/零块/证据冲突均不推进——探针已实现，P1 验收语义）。
        if (ctrl.probe !== null) {
          const normalized = mapRawSessionEvent(session, event, ctrl.callNames);
          if (normalized !== null) {
            const observation = await ctrl.probe.observe(normalized);
            // 压缩状态按 session 隔离：只有压缩事件归属会话的 epoch 前进，
            // 其他会话（A/B 异卡或同卡异会话）的 seen 冷却不受影响。
            if (observation.advanced === true && typeof normalized.sessionId === "string") {
              // B1-c：scope 归属与工具/装配同源——取 workingDirectory 投影，
              // 不读 session.header.cwd（两者分叉时以投影为准）；无服务回落
              // defaultPersona（workspace=null 的选卡规则）。
              const scopeOfSession = currentScopeIdForSession(normalized.sessionId, workspaceForSession(session));
              if (scopeOfSession !== null) {
                await state.l2Store.bumpSessionEpoch(scopeOfSession, normalized.sessionId);
              }
            }
          }
        }
        // 2) L2 accepted receipt：真实 surface append（session/event user/message
        //    且 event.data.id === 我们的 messageId）才算 accepted。
        if (event?.type === "user/message") {
          const message = event.data;
          if (message?.source?.kind !== "shiori-sparks" || typeof message?.id !== "string") return;
          const scopeId = typeof message.source.scopeId === "string" ? message.source.scopeId : null;
          if (scopeId === null || !ctrl.scopes.has(scopeId)) return;
          const hit = await state.l2Store.recordAccepted(scopeId, { messageId: message.id });
          if (hit === null) return;
          ctrl.diag.acceptedReceipts += 1;
          await finalizeDelivery(scopeId, hit.deliveryId);
        }
      })();
      return trackInFlight(promise.catch((error) => {
        ctrl.diag.eventErrors = ctrl.diag.eventErrors ?? [];
        ctrl.diag.eventErrors.push(`session event failed: ${error instanceof Error ? error.message : String(error)}`);
      }));
    };
  }

  /** 会话 → 当前 scope（仅用于把压缩事件归属到已打开的 scope 账本）。
   *  B1/B1-c：workspace 由调用方传入 workingDirectory 投影（与工具/装配同源）；
   *  null workspace 走 defaultPersona 选卡规则。 */
  function currentScopeIdForSession(sessionId, workspace = null) {
    // 压缩事件只推进其归属 scope 的会话 epoch；scope 由会话选卡规则解析。
    // 多 scope 打开时按选卡规则找第一个匹配 scope（本批单用户本地 profile）。
    try {
      const persona = pinScope({
        settings,
        sessionId,
        workspace: typeof workspace === "string" && workspace.length > 0 ? workspace : null,
        generation: ctrl.generation,
        source: "session-event",
      }).persona;
      const scopeId = persona === null ? NULL_PERSONA_SCOPE : persona;
      return ctrl.scopes.has(scopeId) ? scopeId : null;
    } catch {
      return null;
    }
  }

  /**
   * 投递收尾（崩溃恢复补齐共用）：accepted receipt 已持久 → store 幂等 hit →
   * 持久 hit 账 → 持久 seen → committed 终态。任一点崩溃由 recoverL2 补齐；
   * 不因 stats 失败重新追加附件。
   */
  async function finalizeDelivery(scopeId, deliveryId) {
    const diag = await state.l2Store.diagnostics(scopeId);
    const entry = diag.pending[deliveryId];
    if (entry === undefined || entry.delivery === undefined) return;
    if (diag.committed[deliveryId] !== undefined) return;
    const resources = ctrl.scopes.get(scopeId);
    if (resources === undefined) return;
    const delivery = entry.delivery;
    const { seenWrites, hitUpdates } = commitDelivery({ delivery, accepted: true });
    // store 幂等 hit（同 deliveryId 重放零写）。
    if (hitUpdates.length > 0) {
      await resources.sparkStore.recordDeliveryHits(hitUpdates, { operationId: deliveryId });
    }
    await state.l2Store.recordHits(scopeId, deliveryId, hitUpdates);
    if (seenWrites.length > 0) {
      await state.l2Store.addSeenKeys(scopeId, delivery.sessionId, delivery.contextEpoch, seenWrites.map((w) => w.key));
    }
    await state.l2Store.recordCommitted(scopeId, deliveryId);
  }

  /**
   * B6：按 Message.id 回查真实会话派生历史——append 成功但 accepted receipt
   * 事件丢失（崩溃窗口）时，deriveMessages 里已有我们的消息，补写 accepted
   * 并收尾，不重发；查不到才保持 pending（禁重发铁律不破）。
   */
  function sessionLogHasMessage(agent, sessionId, messageId) {
    try {
      if (agent === null || typeof agent !== "object") return false;
      if (agent.session?.id !== sessionId) return false;
      if (typeof agent.session.deriveMessages !== "function") return false;
      const messages = agent.session.deriveMessages();
      if (!Array.isArray(messages)) return false;
      return messages.some((m) => m?.id === messageId);
    } catch {
      return false; // 会话已关闭 / 派生失败：按无证据处理，不误标 accepted
    }
  }

  /** 启动 / 首次打开 scope 时的崩溃恢复：accepted 未 committed 的投递补齐。 */
  async function recoverL2(scopeId, agent = null) {
    const resources = ctrl.scopes.get(scopeId);
    if (resources === undefined || resources.l2Recovered) return;
    resources.l2Recovered = true;
    const pendings = await state.l2Store.pendingUnfinalized(scopeId);
    for (const p of pendings) {
      if (p.accepted) {
        ctrl.diag.l2Recoveries += 1;
        await finalizeDelivery(scopeId, p.deliveryId);
        continue;
      }
      // 无 event receipt：回查真实会话日志（B6）。append 已入历史 → 补 accepted。
      if (
        typeof p.messageId === "string" && p.messageId.length > 0
        && sessionLogHasMessage(agent, p.session, p.messageId)
      ) {
        const hit = await state.l2Store.recordAccepted(scopeId, { messageId: p.messageId });
        if (hit !== null) {
          ctrl.diag.l2RecoveredFromSessionLog += 1;
          ctrl.diag.l2Recoveries += 1;
          await finalizeDelivery(scopeId, p.deliveryId);
          continue;
        }
      }
      // 无历史 receipt 且会话日志无证据：保持 pending 且禁重发（不盲目重发原 event）。
    }
  }

  // ─────────────────────────────────────────────────────────
  // L2 pre-step 投递
  // ─────────────────────────────────────────────────────────

  async function preStepHandler(payload, next) {
    ctrl.diag.preSteps += 1;
    if (!settings.l2.enabled) return next();
    if (ctrl.banned || !ctrl.started) return next();
    const evidence = sessionEvidenceFromAgent(payload?.agent);
    if (evidence === null) return next();
    const scope = pinScope({
      settings,
      sessionId: evidence.sessionId,
      workspace: workspaceForAgent(evidence.agent),
      generation: ctrl.generation,
      source: "pre-step",
    });
    // 仅扫描可信新的人类用户输入：source.kind=user 且 role=user；不扫历史 /
    // 插件附件 / tool / subagent 报告 / 心跳注入。稳定原始 eventId = Message.id。
    const human = (Array.isArray(payload?.messages) ? payload.messages : [])
      .filter((m) => m?.role === "user" && m?.source?.kind === "user" && typeof m?.id === "string");
    const fresh = [];
    for (const m of human) {
      if (!(await state.l2Store.isScanned(scope.scopeId, m.id))) fresh.push(m);
    }
    if (fresh.length === 0) return next();
    const userText = fresh
      .map((m) => (Array.isArray(m.content) ? m.content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n") : ""))
      .join("\n").trim();
    const resources = await resourcesFor(scope.scopeId);
    await recoverL2(scope.scopeId, evidence.agent);
    // 每 session 独立 epoch（A 成功压缩不清 B 冷却）。
    const epoch = await state.l2Store.sessionEpoch(scope.scopeId, scope.sessionId);
    const seenKeys = await state.l2Store.seenKeys(scope.scopeId, scope.sessionId, epoch);
    const records = await resources.sparkStore.listActive();
    const match = matchSparks({
      scopeId: scope.scopeId,
      userText,
      sparks: records,
      seenKeys,
      sessionId: scope.sessionId,
      contextEpoch: epoch,
      maxSeeds: settings.budgets.spark.seedCount,
      maxRelated: settings.budgets.spark.linkCount,
    });
    const delivery = buildSparkAttachment({
      scopeId: scope.scopeId,
      sessionId: scope.sessionId,
      contextEpoch: epoch,
      match,
      maxChars: settings.budgets.spark.maxChars,
    });

    const markAllScanned = async () => {
      // B6：扫批标记后置于 recordPending/决策之后——「已扫」只记录已定局的消息。
      for (const m of fresh) {
        await state.l2Store.markScanned(scope.scopeId, m.id);
      }
    };

    if (delivery.delivered.length === 0) {
      ctrl.diag.preStepEmpty += 1;
      await markAllScanned();
      const decision = await next();
      return decision;
    }
    const deliveryId = state.l2Store.deliveryIdFor({
      scopeId: scope.scopeId,
      sessionId: scope.sessionId,
      sourceMessageId: fresh[0].id,
      contextEpoch: epoch,
    });
    if (await state.l2Store.isCommitted(scope.scopeId, deliveryId)) {
      await markAllScanned();
      const decision = await next();
      return decision;
    }
    // 崩溃窗口去重（B6）：同 deliveryId 的 pending 已存在（上一次 recordPending
    // 之后、事件回执之前崩溃）→ 不再追加第二条消息；回查会话日志确认已入历史
    // 则补 accepted，否则保持 pending 并跳过本轮追加。
    const existing = await state.l2Store.pendingById(scope.scopeId, deliveryId);
    if (existing !== null) {
      if (!existing.committed) {
        if (existing.accepted) {
          // receipt 已持久、收尾被崩溃打断：补收尾。
          ctrl.diag.l2Recoveries += 1;
          await finalizeDelivery(scope.scopeId, deliveryId);
        } else if (
          typeof existing.messageId === "string"
          && sessionLogHasMessage(evidence.agent, scope.sessionId, existing.messageId)
        ) {
          // append 已入历史但 receipt 丢失（B6）：回查补 accepted，不重发。
          const hit = await state.l2Store.recordAccepted(scope.scopeId, { messageId: existing.messageId });
          if (hit !== null) {
            ctrl.diag.l2RecoveredFromSessionLog += 1;
            await finalizeDelivery(scope.scopeId, hit.deliveryId);
          }
        }
      }
      await markAllScanned();
      const decision = await next();
      return decision;
    }
    // 独立 text context message（source.kind=shiori-sparks/form=recall）；不使用
    // blob API、不修改原文、不冒充 human。稳定 id 由冻结 message 承载并持久 pending。
    const message = ctrl.createUserMessage({
      content: [{ type: "text", text: delivery.text }],
      source: {
        kind: "shiori-sparks",
        form: "recall",
        deliveryId,
        scopeId: scope.scopeId,
        sparkIds: delivery.delivered.map((d) => d.id),
      },
    });
    // 投递先落账（含完整快照），再标记扫描；await next() 并保留其 messages，
    // 再追加本包独立消息。
    await state.l2Store.recordPending(scope.scopeId, {
      deliveryId,
      messageId: message.id,
      sourceMessageId: fresh[0].id,
      sessionId: scope.sessionId,
      contextEpoch: epoch,
      delivery,
    });
    await markAllScanned();
    ctrl.diag.preStepDeliveries += 1;
    const decision = await next();
    if (decision?.kind !== "enter") return decision;
    return {
      kind: "enter",
      messages: [...decision.messages, message],
      ...(decision.startsRequestSeries === true ? { startsRequestSeries: true } : {}),
    };
  }

  // ─────────────────────────────────────────────────────────
  // 授权（executePlan 仅本次调用）
  // ─────────────────────────────────────────────────────────

  function registerGrant(grant) {
    const entry = { ...grant, revoked: false, revoke() { entry.revoked = true; ctrl.grants.delete(entry); } };
    ctrl.grants.add(entry);
    // B-abort：已 abort 的 signal 上挂 abort 监听永远不会触发——注册入口先查
    // aborted，已取消的调用当场撤销授权（management 的注册后核验随即失败）。
    if (entry.signal?.aborted === true) entry.revoke();
    if (entry.signal !== null && typeof entry.signal?.addEventListener === "function") {
      entry.signal.addEventListener("abort", () => entry.revoke(), { once: true });
    }
    return entry;
  }

  // ─────────────────────────────────────────────────────────
  // management
  // ─────────────────────────────────────────────────────────

  const { management: managementFacade } = createManagement({
    settings,
    dataRoot: settings.dataRoot,
    state,
    resourcesFor: async (scopeId, agent = null) => {
      const resources = await resourcesFor(scopeId);
      await recoverL2(scopeId, agent);
      return resources;
    },
    isStarted: () => ctrl.started,
    generation: () => ctrl.generation,
    registerGrant,
    workspaceForAgent,
    executeToolForScope: (scope, name, args) => trackInFlight(dispatchTool(scope, name, args, null)),
    nowIso,
    // P-C 诚实度：getStatus.diagnostics 暴露 typertRpc（wire 契约的
    // diagnostics 块为 additionalProperties:true，纯增量），真实入口 boot
    // 与面板都能观察到严格 codec 的实际状态。
    typertRpcInfo: () => ({ codec: ctrl.typertRpc.codec, reason: ctrl.typertRpc.reason }),
  });

  // M4-drain：management 数据方法全部纳入在途排空——stop 等待收场（带上限），
  // 不得在 store 关闭后让在途 RPC 撞 INVALID_STATE。getStatus 为纯内存投影，
  // 不占在途。
  const DRAINED_MANAGEMENT_METHODS = [
    "getMemoryView", "getGraph", "listCandidates", "analyze",
    "reviewCandidate", "previewPlan", "executePlan", "executeTool",
  ];
  const management = { ...managementFacade };
  for (const name of DRAINED_MANAGEMENT_METHODS) {
    const method = managementFacade[name];
    if (typeof method === "function") {
      management[name] = (...args) => trackInFlight(method.apply(managementFacade, args));
    }
  }

  // ─────────────────────────────────────────────────────────
  // 生命周期
  // ─────────────────────────────────────────────────────────

  function requireStartable() {
    if (ctrl.starting) fail("INVALID_STATE", "controller start already in progress", {});
    if (ctrl.started) fail("INVALID_STATE", "controller already started; call stop() first", {});
  }

  /** B7：active 启动前对配置的全部 persona 做预校验（坏卡 fail-fast 可操作）。 */
  async function prevalidateConfiguredPersonas() {
    const problems = [];
    const entries = [
      ["defaultPersona", settings.defaultPersona],
      ...settings.sessionPersonas.map((e) => [`sessionPersonas:${e.sessionId}`, e.persona]),
      ...settings.workspacePersonas.map((e) => [`workspacePersonas:${e.workspace}`, e.persona]),
    ];
    for (const [label, persona] of entries) {
      if (persona === null) continue;
      const adapter = createPersona({
        dir: `${settings.dataRoot}/persona`,
        scopeId: scopeIdForPersona(persona),
        maxChars: settings.budgets.persona.maxChars,
      }, { nowIso });
      const probe = await adapter.probe();
      if (probe.ok !== true) {
        problems.push({ persona, label, state: probe.state, reason: probe.reason ?? null });
      }
    }
    if (problems.length > 0) {
      fail("INVALID_STATE", "configured persona card(s) are invalid and cannot be enabled; repair the card file(s) or provide a last-valid snapshot", {
        problems,
      });
    }
  }

  async function start() {
    requireStartable();
    ctrl.startCount += 1;
    ctrl.generation += 1;
    const generation = ctrl.generation;
    ctrl.stopRequested = false;
    ctrl.banned = false;
    ctrl.starting = true;
    /** B4：start 体内检查点——stop 已请求即中止（不注册任何新宿主资源）。 */
    const checkNotStopped = (at) => {
      if (ctrl.stopRequested) {
        fail("INVALID_STATE", `start aborted: stop requested during startup (at ${at})`, { at });
      }
    };
    const run = (async () => {
      if (isInert) {
        // inert：不启 runtime、不注册任何宿主资源；needs-configuration 诊断。
        return { mode: "inert", needsConfiguration: true, sections: [], tools: [] };
      }

      // 完成状态（单插件级；同 scope 资源复用，不按会话开锁）。
      // B3：仅 active 打开——shadow 永不创建 completion 锁。
      if (settings.mode !== "active") {
        return {
          mode: settings.mode,
          sections: [],
          tools: [],
          completeShadowed: [],
        };
      }
      ctrl.completion = await openState({ root: settings.stateRoot, scopeId: `shiori-plugin-${settings.ownerId}` });
      ctrl.probe = createCompressProbe({ now: nowIso, sink: ctrl.completion.sink });
      checkNotStopped("completion-state");

      // B7：全部配置 persona 预校验（fail-fast，可操作错误）。
      await prevalidateConfiguredPersonas();
      checkNotStopped("persona-prevalidation");

      // session 事件：压缩探针 + L2 accepted receipt。
      const listener = sessionEventListener();
      bindings.subscribeSessionEvents(listener);
      checkNotStopped("session-events");

      // 恢复重放：探针恢复已见事件（代际校验内）。
      if (ctrl.probe.restore !== undefined) {
        await ctrl.probe.restore({ isCurrent: () => !ctrl.banned && generation === ctrl.generation });
      }
      checkNotStopped("probe-restore");

      // 预建全部配置 scope 资源（工具描述/schema 来源 + 启用探测；B1 覆盖
      // workspace 映射卡）。
      const resources = await primeDefaultScope();
      const personaProbe = await resources.personaAdapter.probe();
      if (personaProbe.ok !== true) {
        fail("INVALID_STATE", `scope "${resources.scopeId}" cannot be enabled: ${personaProbe.reason}`, {
          scopeId: resources.scopeId, state: personaProbe.state,
        });
      }
      checkNotStopped("scope-priming");

      // P-C：Gateway 严格 codec 描述符注册。typert 服务经可选读取解析
      // （B-P2：真机 Cordis 对未 inject 服务的属性访问直接抛，见
      // readOptionalCordisService），这里再兜一层 try/catch：任何异常收敛成
      // {codec:"src", reason}，不得让 start 失败；diagnostics.typertRpc 如实报告。
      try {
        ctrl.typertRpc = registerShioriTypert(ctx);
      } catch (error) {
        ctrl.typertRpc = {
          codec: "src",
          reason: `typert registration threw: ${error instanceof Error ? error.message : String(error)}`,
          disposer: null,
        };
      }
      checkNotStopped("typert-registration");

      // B2/诚实度：三态探测只扫 **global 层**——命中（本包 section 会被宿主
      // complete 快照整体替换，故不注册）/ 未命中 / 不可判定（layers 不可读）。
      // 别的 scope 的 complete section 只影响其自身那次 assembly，不在启动期
      // 参与全局判定（运行期由 assembleWaterfall 按本次入口判定并记账）。
      // 不可判定时照常注册（无法证明会被丢弃），但 l0l1Effective 如实报 "unknown"。
      const completeProbe = detectCompletePromptSections(ctx?.systemPrompt);
      ctrl.completeProbe = completeProbe.state;
      ctrl.completeShadowed = completeProbe.state === "ok" ? [...completeProbe.sections] : [];

      if (ctrl.completeShadowed.length > 0) {
        // L0/L1 不达模型：跳过 section/waterfall 注册；工具与 L2 不受影响。
        for (const def of registeredToolDefs()) {
          await bindings.registerTool(def);
        }
        if (settings.l2.enabled) {
          ctrl.createUserMessage = await bindings.loadCreateUserMessage();
          bindings.registerPreStep((payload, next) => trackInFlight(preStepHandler(payload, next)));
        }
        checkNotStopped("complete-shadowed-registration");
        return {
          mode: settings.mode,
          sections: [],
          tools: [...bindings.diagnostics.registeredTools],
          completeShadowed: [...ctrl.completeShadowed],
          completeProbe: ctrl.completeProbe,
          l0l1Effective: false,
        };
      }

      // L0/L1 同步 section（waterfall 前的安全占位 / 本 scope 缓存）。
      bindings.registerSystemSection({
        name: SECTION_PERSONA,
        order: SECTION_ORDER.persona,
        text: (context) => {
          const evidence = sessionEvidenceFromAgent(context?.agent);
          if (evidence === null) return "";
          const scope = pinScope({
            settings,
            sessionId: evidence.sessionId,
            workspace: workspaceForAgent(evidence.agent),
            generation: ctrl.generation,
            source: "section",
          });
          return ctrl.sectionCache.get(scope.scopeId)?.persona ?? "";
        },
      });
      bindings.registerSystemSection({
        name: SECTION_CORE,
        order: SECTION_ORDER.core,
        text: (context) => {
          const evidence = sessionEvidenceFromAgent(context?.agent);
          if (evidence === null) return "";
          const scope = pinScope({
            settings,
            sessionId: evidence.sessionId,
            workspace: workspaceForAgent(evidence.agent),
            generation: ctrl.generation,
            source: "section",
          });
          return ctrl.sectionCache.get(scope.scopeId)?.core ?? "";
        },
      });
      // 真实 async waterfall：固定可信 scope → await 刷新/校验 → 仅替换本包
      // section。B4：入口排空追踪；B7：体内错误隔离。
      bindings.registerAssembleWaterfall((assembly, context, next) => trackInFlight(assembleWaterfall(assembly, context, next)));
      // 16 工具经真实 defineTool 注册。
      for (const def of registeredToolDefs()) {
        await bindings.registerTool(def);
      }
      if (settings.l2.enabled) {
        ctrl.createUserMessage = await bindings.loadCreateUserMessage();
        bindings.registerPreStep((payload, next) => trackInFlight(preStepHandler(payload, next)));
      }
      checkNotStopped("active-registration");

      return {
        mode: settings.mode,
        sections: [...bindings.diagnostics.registeredSections],
        tools: [...bindings.diagnostics.registeredTools],
        completeShadowed: [],
        completeProbe: ctrl.completeProbe,
        // 诚实度：探测不可判定时不得宣称 true。
        l0l1Effective: ctrl.completeProbe === "unavailable" ? "unknown" : true,
      };
    })();

    ctrl.startingPromise = run;
    try {
      const result = await run;
      if (ctrl.stopRequested) {
        // B4：start 期间收到 stop——本 promise 已注册完整，但不宣布 started；
        // 清理交给 stop()（其正在 await 本 promise）。这里直接以失败收场。
        fail("INVALID_STATE", "start aborted: stop requested during startup", {});
      }
      ctrl.started = true;
      return result;
    } catch (error) {
      ctrl.diag.startFailures.push(`${error?.code ?? "UNCODED"}: ${error instanceof Error ? error.message : String(error)}`);
      await cleanupGeneration("start-failure");
      throw error;
    } finally {
      ctrl.starting = false;
      if (ctrl.startingPromise === run) ctrl.startingPromise = null;
    }
  }

  /** 逆序清理：撤注册 / 订阅 → 排空在途 → flush → close → 关 store → 清缓存。
   *  B4：串行化——start 失败路径与 stop 可能并发到达，二次清理必须幂等。 */
  let cleanupChain = Promise.resolve();
  function cleanupGeneration(phase) {
    const run = cleanupChain.then(() => cleanupGenerationInner(phase), () => cleanupGenerationInner(phase));
    cleanupChain = run.then(() => {}, () => {});
    return run;
  }

  async function cleanupGenerationInner(phase) {
    const errors = [];
    // 1) 撤销注册与订阅（bindings 逆序 dispose）。
    try {
      const disposed = bindings.disposeAll();
      errors.push(...disposed.errors.map((e) => `bindings.dispose (${phase}): ${e}`));
    } catch (error) {
      errors.push(`bindings.dispose (${phase}): ${error instanceof Error ? error.message : String(error)}`);
    }
    // 2) 撤销 grants（stop/断连撤销）。
    for (const grant of [...ctrl.grants]) grant.revoke();
    // 3) 排空在途工具 / 事件 / management RPC。M4-drain：带上限等待；超限的
    //    未收场任务如实写进 errors（不静默截断——调用方自己决定处置）。
    if (ctrl.inFlight.size > 0) {
      const drainCapMs = 10_000;
      const settled = await Promise.race([
        Promise.allSettled([...ctrl.inFlight]).then(() => true),
        new Promise((resolve) => setTimeout(resolve, drainCapMs).unref?.()).then(() => false),
      ]);
      if (settled !== true) {
        errors.push(`drain (${phase}): ${ctrl.inFlight.size} in-flight task(s) did not settle within ${drainCapMs}ms`);
      }
    }
    // 4) flush + close 完成状态。
    if (ctrl.completion !== null) {
      try {
        await ctrl.completion.flush();
      } catch (error) {
        errors.push(`completion.flush (${phase}): ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await ctrl.completion.close();
      } catch (error) {
        errors.push(`completion.close (${phase}): ${error instanceof Error ? error.message : String(error)}`);
      }
      ctrl.completion = null;
    }
    ctrl.probe = null;
    // 5) P-C：撤严格描述符（withdraw → 下代干净重注册；stop→再启窗口内
    //    gateway 报 definition-unavailable，与「服务不在场」同窗，见 REPORT）。
    if (ctrl.typertRpc?.disposer) {
      try {
        ctrl.typertRpc.disposer();
      } catch (error) {
        errors.push(`typert.dispose (${phase}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    ctrl.typertRpc = { codec: "src", reason: "controller stopped", disposer: null };
    // 6) 关闭 spark stores、清缓存。
    errors.push(...(await closeAllScopes()));
    ctrl.sectionCache.clear();
    return errors;
  }

  async function stop() {
    // B4：先置禁新请求 + stopRequested，再等在途 start 收场（其见到 stopRequested
    // 即中止或完整让位），随后统一清理——stop 返回时宿主资源必然已全部撤销。
    ctrl.banned = true;
    ctrl.stopRequested = true;
    ctrl.stopCount += 1;
    if (ctrl.startingPromise !== null) {
      await ctrl.startingPromise.catch(() => {});
    }
    const errors = await cleanupGeneration("stop");
    ctrl.started = false;
    ctrl.starting = false;
    ctrl.startingPromise = null;
    return { stopped: true, generation: ctrl.generation, errors };
  }

  function diagnostics() {
    const scopeDiags = [...ctrl.scopsDiagSafe()];
    return {
      mode: isInert ? "inert" : settings.mode,
      configured: !isInert,
      needsConfiguration: isInert,
      started: ctrl.started,
      starting: ctrl.starting,
      banned: ctrl.banned,
      startCount: ctrl.startCount,
      stopCount: ctrl.stopCount,
      generation: ctrl.generation,
      ownerId: settings.ownerId,
      budgets: settings.budgets,
      modules: { l2: settings.l2.enabled, organize: settings.organize.enabled, forgetting: settings.forgetting.enabled },
      scopes: scopeDiags,
      bindings: bindings.diagnostics,
      probe: ctrl.probe?.diagnostics() ?? null,
      completion: ctrl.completion?.diagnostics?.() ?? { status: "not-open" },
      counters: { ...ctrl.diag },
      // B2：启动期 global 探测（三态）+ 本次装配遮蔽计数，L0/L1 有效性不谎报。
      completeShadowed: [...ctrl.completeShadowed],
      completeProbe: ctrl.completeProbe,
      /** 运行期探测三态：最近一次 assembly 所属 scope 的 complete 情况。 */
      assemblyCompleteProbe: ctrl.assemblyProbe,
      /** 运行期已观察到「本次 assembly 被 foreign complete section 遮蔽」的装配次数。 */
      assemblyCompleteShadowed: ctrl.diag.assemblyCompleteShadowed,
      // P-C：Gateway 严格 codec 描述符状态（strict=已注册生效；src=回退现状，reason 给原因）。
      typertRpc: { codec: ctrl.typertRpc.codec, reason: ctrl.typertRpc.reason },
      // 诚实度：以下任一情况都不报 true——
      // - 启动期 global 探测命中（本包 section 未注册）→ false；
      // - 探测不可判定（layers 不可读）→ "unknown"；
      // - 运行期至少一次装配被 foreign complete 快照整体替换（那次 L0/L1 未送达）→ "unknown"；
      // 非 active 模式 L0/L1 从未注册，恒 false。
      l0l1Effective: settings.mode === "active"
        ? (ctrl.completeShadowed.length > 0
          ? false
          : ctrl.completeProbe === "unavailable"
            || ctrl.assemblyProbeUnverified
            || ctrl.diag.assemblyCompleteShadowed > 0
            ? "unknown"
            : true)
        : false,
      workspaceRouting: {
        // B1：宿主 workingDirectory 服务是否可用（决定 workspacePersonas 选卡）。
        workingDirectoryAvailable: (() => {
          try {
            const service = readOptionalCordisService(ctx, "workingDirectory");
            return service !== null && typeof service === "object" && typeof service.get === "function";
          } catch {
            return false;
          }
        })(),
      },
      l2Unsupported: settings.mode !== "active" ? "l2 delivery only in active mode" : null,
    };
  }

  // diagnostics 辅助：scope 摘要（不读业务正文）。
  ctrl.scopsDiagSafe = () => [...ctrl.scopes.keys()].map((scopeId) => ({
    scopeId,
    persona: ctrl.scopes.get(scopeId).personaAdapter.diagnostics(),
    l2Recovered: ctrl.scopes.get(scopeId).l2Recovered,
  }));

  return {
    start,
    stop,
    diagnostics,
    management,
  };
}
