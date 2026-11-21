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
// - active：19 工具（9 兼容 + topic_create + group_manage + 8 Spark，0.5-5C 17→19）经真实 defineTool 注册；
//   L0/L1 真实 async system-prompt/assemble waterfall 刷新；L2 经 agent/pre-step
//   投递（仅 l2.enabled）；压缩探针订阅完成事件（同 callId direct/PTC 仅推进一次）；
// - 0.5：语义向量写后增量维护——spark 写工具成功 → 防抖批量 embed/upsert（forget
//   同步剔除），与 runSemanticRebuild 共用单飞闸（clear/retainOnly 零交错），scope
//   首次打开索引时启动差集兜底；provider 关闭时逐字节保持 0.4 行为。见
//   src/semantic/incremental.mjs 头注释；
// - shadow（配置了 root）：纯内存只读挂载 —— 不注册工具 / section / waterfall /
//   pre-step，不打开 completion 锁 / scope 资源 / receipt（抢独占锁会把真的
//   active 实例挤成 LOCK_BUSY）；management 仅纯内存 getStatus。
// - degraded（P1#8：active 但任一根 mkdir 失败）：只读/内存态降级挂载 —— 19 工具
//   照常注册但执行一律 UNSUPPORTED（宿主工具入口 registeredToolDefs 的降级闸 +
//   management.executeTool 的降级前置检查——面板路径不再先撞 requireStarted 的
//   INVALID_STATE），跳过一切触盘步骤，started 不宣称；诊断经
//   getStatus.diagnostics.roots / diagnostics().roots 透出。重启只支持
//   stop()→start()（降级态已注册工具，直接再 start 会二次注册同名工具）。
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
import { join } from "node:path";
import { createShioriService } from "../service/index.mjs";
import { openSparkStore } from "../sparks/store.mjs";
import { createCompatTools, createTopicCreateTool, createGroupManageTool } from "../host/tools.mjs";
// S3：scope 首次进 active 时初始化组清单（幂等；shadow/inert 不建资源不写盘）。
import { ensureGroupsFile } from "../storage/groups.mjs";
// 0.5-2B：topic-activity 事件账本（非阻塞入账；事件按 targetScopeId 归属，
// 落 <stateRoot>/topic-activity.jsonl，供 0.5 阶段 B 温度引擎回放）。
import { createTopicActivityLedger } from "../storage/topic-activity.mjs";
// 0.5 批次 4 · B 线：热度参数热读（liveRefs.temperature → normalize；失败回落冻结快照）。
import { normalizeTemperatureParams, validateTemperatureParams } from "../forgetting/params.mjs";
import { createSeatGuard } from "../host/seat.mjs";
import { createSparkTools } from "../sparks/tools.mjs";
import { createAutoLinker } from "../sparks/auto-link.mjs";
import { createCompressProbe } from "../host/compress-probe.mjs";
import { mapRawSessionEvent } from "../host/dsh-adapter.mjs";
import { openCompletionState } from "../completion/index.mjs";
import { evaluateMutation } from "../core/index.mjs";
import { buildSparkAttachment, commitDelivery } from "../sparks/delivery.mjs";
// 0.5 批次 4 D 线：投递诊断账本（每轮 pre-step 一条不含正文的记录）与
// 面板「投递体检」数据聚合。纯函数聚合在 diagnostics.mjs，账本在 state.mjs。
import { buildRoundRecord, readDiagnostics, DIAGNOSTICS_RETENTION_DAYS } from "../sparks/diagnostics.mjs";
import { createColdSearch } from "../forgetting/cold-search.mjs";
// 0.5 批次 5 · A 线：auto 冷却/恢复引擎（评估/执行/撤销）与只读装配源。
// 单实例供 management 四个 auto RPC 与本文件 pre-step 调度共用；持久状态落
// state.mjs 的 autoStore，内存只留调度单飞闸。
import { createAutoEngine, createAutoReplaySource } from "../forgetting/auto.mjs";
import { createEmbeddingProvider } from "../semantic/index.mjs";
// S5：模型下载与安装校验（与 provider 同住 semantic/local.mjs；controller 只做
// 任务编排——单飞、取消、诊断落点，不自己写下载器）。
import {
  createLocalModelDownloader,
  isLocalModelInstalled,
  localModelDir,
  expectedModelFiles,
  DOWNLOAD_DEPENDENCY_MISSING,
  DOWNLOAD_RUNTIME_LOAD_FAILED,
} from "../semantic/local.mjs";
import { openSemanticVectorStore } from "../semantic/store.mjs";
// 0.5 写后增量：队列本体 + 单飞闸 + spark store 写钩子包装（语义与边界见模块头注释）。
import {
  createSemanticGate,
  createSemanticIncrementalQueue,
  wrapSparkStoreWithIncrementalHooks,
  SEMANTIC_INCREMENTAL_DEBOUNCE_MS,
} from "../semantic/incremental.mjs";
import { mergeSemanticRecall } from "../sparks/semantic-recall.mjs";
import { createPersonaAdapter } from "./persona.mjs";
import { coreBudgetsOf, probeRootsWritable } from "./config.mjs";
import { createStateStore } from "./state.mjs";
import { createDshBindings, detectCompletePromptSections, detectCompleteSectionsForScope } from "./bindings.mjs";
import { createManagement } from "./management.mjs";
import { CONTRACT_METHODS, methodSetMismatch } from "./client-rpc.mjs";
import { registerShioriTypert, readOptionalCordisService } from "./typert-descriptors.mjs";
import {
  validateControllerSettings, pinScope, sessionEvidenceFromExec,
  sessionEvidenceFromAgent, rejectIdentityFields, NULL_PERSONA_SCOPE, scopeIdForPersona,
  liveSettingsForScope, readLiveRefs,
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
  "group_manage",
  "spark_save", "spark_update", "spark_forget", "spark_feedback",
  "spark_link", "spark_unlink",
]);

/** 19 工具全名（契约清单；0.5-5C 起含 spark_link/spark_unlink，工具面 17→19）。 */
const ALL_TOOL_NAMES = Object.freeze([
  "soul_read", "soul_update", "memory_read", "memory_search",
  "memory_append", "memory_rewrite", "core_write", "topic_append",
  "topic_create", "memory_list_topics",
  "group_manage",
  "spark_save", "spark_read", "spark_update", "spark_forget",
  "spark_feedback", "spark_graph",
  "spark_link", "spark_unlink",
]);

// F1b：语义向量重建的保留名。它不是宿主工具——绝不加入 ALL_TOOL_NAMES、绝不
// 经 defineTool 注册；只经 management.executeTool（wire 的 name 是自由字符串，
// protocol.mjs 未收缩枚举）在本文件内部分发拦截，供面板「重建向量」按钮调用。
// dispatchTool 在 ALL_TOOL_NAMES 检查之前识别它（见该函数），宿主工具面保持 19 个不变。
const SEMANTIC_REBUILD_TOOL = "semantic_rebuild";

// S5：模型下载的保留名（与 semantic_rebuild 同一通道：不是宿主工具，绝不加入
// ALL_TOOL_NAMES、绝不经 defineTool 注册；只经 management.executeTool 在
// dispatchTool 内部拦截，供面板「下载模型」按钮与取消按钮调用）。
const SEMANTIC_DOWNLOAD_TOOL = "semantic_download";

// S5：下载源回退（镜像失败后的兜底官方源；源顺序＝配置 mirror 先、官方源后，
// 去重后逐源尝试）。与服务端配置默认镜像保持同一写法（带尾斜杠）。
const SEMANTIC_FALLBACK_SOURCE = "https://huggingface.co/";

// 重建分批大小（F1b 任务书 g 条：每批 20 张，批间 setTimeout 让出事件循环）。
const SEMANTIC_REBUILD_BATCH = 20;

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
  // 选卡三字段（defaultPersona / sessionPersonas / workspacePersonas）在宿主侧是 volatile
  // 引用：settings 面板写入后宿主就地更新引用值、不重载插件（cordis-plugin-loader
  // entry.ts 的 _commitVolatile）。这里保留引用，pinScope 每次实时解包，切卡才会在
  // 会话进行中立即生效；引用缺失时 liveSettingsForScope 回落装配期快照。
  const rawConfig = rawSettings ?? {};
  const liveRefs = readLiveRefs(rawConfig.liveRefs);
  // liveRefs 是本插件自己的热读通道，不属于冻结 settings 契约（validateControllerSettings
  // 对未知顶层键 fail-closed），所以先摘掉再校验，校验通过后合回运行期对象。
  const sanitized = { ...rawConfig };
  delete sanitized.liveRefs;
  const settings = Object.freeze({ ...validateControllerSettings(sanitized), liveRefs });
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
    // S5：模型下载器工厂（默认真实实现；测试注入假下载器，绝不真下载）。
    createDownloader = createLocalModelDownloader,
    // S5 复审：座位守卫工厂（默认真实实现；测试注入只读/可写桩，不占真实座位）。
    createSeatGuardFactory = createSeatGuard,
    // 0.4 收尾（reviewer attempt-1 必修 2）：embedding provider 工厂 seam，与
    // createDownloader 同款——缺省真实实现（生产行为零变化）；测试注入计数桩，
    // 使 force/增量分叉的断言与可选依赖（@huggingface/transformers）装没装彻底解耦。
    createEmbeddingProvider: createEmbeddingProviderImpl = createEmbeddingProvider,
    // 0.5 写后增量的防抖毫秒（任务书 ~300ms）。只作依赖 seam 供测试缩短等待，
    // 不进 settings 冻结契约（config.mjs 不在本次白名单）；非法值回落缺省。
    semanticIncrementalDebounceMs = SEMANTIC_INCREMENTAL_DEBOUNCE_MS,
    // R4②：人设卡目录读取注入点（仅测试注入 EACCES 桩；生产不传 → 门面缺省用
    // node:fs readdir，正常路径行为逐字不变）。用于端到端验证
    // diagnostics.personasError 与 diagnostics.roots 在面板 getStatus 上并存。
    personasReaddir,
  } = dependencies;

  // inert 判定（0.4-S1 起，reviewer P2① 口径）：仅由 mode 与根校验共同决定——
  // shadow 且双根 null。normalize 已保证 apply 路径双根必非 null（缺失走 DSH_HOME
  // 默认），故生产 apply 不会进入 inert；本分支是**直构/嵌入方兼容路径**（测试、
  // 桌面宿主内嵌 service 以 null 根挂载），由 controller.test.mjs 的直构 inert 用例
  // 覆盖，不是死代码。inert 下不启 runtime、不触盘，仅 management.getStatus 可用。
  const isInert = settings.mode === "shadow" && settings.dataRoot === null && settings.stateRoot === null;
  const nowIso = () => now().toISOString();

  // 0.5 批次 4 · B 线（评审授权）：12 项热度参数的热读入口。temperature 是宿主
  // volatile 引用（index.mjs 透传进 liveRefs），面板 scope.mutate 保存后引用值
  // 就地更新、不重载插件。与 liveSettingsForScope 同款兜底口径：引用缺失 / get()
  // 抛错 / 值非法一律回落装配期冻结快照，绝不因热读失败拒绝请求。
  function liveTemperature() {
    const ref = settings.liveRefs && settings.liveRefs.temperature;
    if (ref !== null && ref !== undefined && typeof ref === "object" && typeof ref.get === "function") {
      try {
        const raw = ref.get();
        if (raw !== undefined) {
          const normalized = normalizeTemperatureParams(raw);
          validateTemperatureParams(normalized);
          return normalized;
        }
      } catch {
        /* 回落冻结快照 */
      }
    }
    return normalizeTemperatureParams(settings.temperature);
  }

  // 0.5-2B：topic-activity 事件账本（每实例一个；事件自带 targetScopeId 归属，
  // 全 scope 共享同一 <stateRoot>/topic-activity.jsonl）。构造零 IO（尾部探测与
  // 落盘都惰性到首次 append）；工具层成功路径 fire-and-forget 入账，写失败只记
  // 账本诊断（diagnostics().topicActivity 可观测），绝不阻塞/影响工具返回。
  // inert 直构（stateRoot null）不建账本，diagnostics 透出 null。
  const topicActivity = settings.stateRoot !== null
    ? createTopicActivityLedger({ stateRoot: settings.stateRoot, now })
    : null;

  // F1b：语义 provider。provider="local" 时构造是零 IO 的（懒加载契约：
  // transformers 运行时推迟到首次 embed 才 import，见 semantic/local.mjs）；
  // "none" → null（行为与 0.1 逐字节一致）；"api" 不在此创建（本期未实现，
  // createEmbeddingProvider 会抛 NOT_IMPLEMENTED，配置在 normalize 层就该被拦）。
  // S5 口径变更：cacheDir 空字符串在此兑现配置承诺（config.mjs 契约），解析为
  // <dataRoot>/models——模型跟业务数据走（0.4-S5）：dataRoot 随业务数据备份/迁移，
  // 升级插件、重装包都不用重下模型；旧的 <stateRoot>/semantic/models 落点退役。
  // dataRoot 为 null（inert 直构）时保持空串：local provider 在 inert 下永远
  // 不会被使用（pre-step / executeTool 均不可达）。
  function modelDirResolved() {
    const local = settings.semantic.local;
    if (local.cacheDir !== "") return local.cacheDir;
    if (settings.dataRoot === null) return null;
    return join(settings.dataRoot, "models");
  }
  function semanticProviderConfig() {
    const semantic = settings.semantic;
    if (semantic.provider !== "local") return semantic;
    const modelDir = modelDirResolved();
    if (modelDir === null) return semantic;
    return { ...semantic, local: { ...semantic.local, cacheDir: modelDir } };
  }
  const semanticProvider = settings.semantic.provider === "local"
    ? createEmbeddingProviderImpl(semanticProviderConfig())
    : null;

  // 0.5 单飞并发防线（任务书硬要求 2）：语义索引所有写者共用的闸——写后增量
  // flush、启动差集兜底、runSemanticRebuild 全部经此串行。现有 rebuild 是全局
  // 单飞状态（ctrl.semantic.rebuild），按现状保守共用同一把全局闸：重建全程
  // （含 clear 与 retainOnly 收尾）持锁，增量写只在锁外发生，严禁交错。
  const semanticGate = createSemanticGate();

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
    /** S5 复审 P1：下载任务代次计数器。start/stop/新任务各自 +1；旧任务
     *  收尾时发现代次不匹配即退场，不许覆写新代次的状态。 */
    downloadGeneration: 0,
    /** 本代注册 disposer（逆序撤销）。 */
    disposers: [],
    /** scope 资源缓存：scopeId → {service, sparkStore, personaAdapter, tools, toolByName} */
    scopes: new Map(),
    /** 完成状态句柄（compress 探针持久化；单插件级锁，不按会话开）。 */
    completion: null,
    probe: null,
    /** F7 座位守卫（占座 + 只读判定；active 态 start 时创建；inert/shadow 恒 null）。 */
    seatGuard: null,
    /** 工具层守门的合流入口（= seatGuard.guard；只读态抛 HOST_LOCKED）。 */
    readonlyGuard: null,
    /** P1#8：根目录 mkdir 失败的结构化诊断（{root, path, reason, code}）。
     *  空数组 = 两根就绪（正常路径）；非空 = start 降级为只读/内存态挂载，
     *  工具一律 UNSUPPORTED（宿主入口 + management.executeTool 两道同源闸），
     *  getStatus.diagnostics.roots 透出面板可见。
     *  每次 start 重算（修复权限 stop→start 后自动恢复完整挂载）。 */
    rootDiagnostics: [],
    /** R3：降级挂载是否已把 19 工具注册进宿主（started 仍为 false）。真实
     *  bindings 上不 stop 再 start 会二次注册同名工具——requireStartable 以此
     *  拦下并给出明确错误；cleanupGeneration 的 disposeAll 之后复位。 */
    degradedRegistered: false,
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
      /** 0.5-4D 投递诊断账本写侧计数：appended=成功落账；failed=IO 失败（账本
       *  层折叠为 {ok:false} 只计数）；skipped=记录构造/形状校验/守卫读取异常
       *  （评审 R8：只读宿主与 stateRoot 未配置属正常静默跳过，不计入 skipped）。
       *  诊断数据路径绝不阻塞投递，全部只在这里留痕。 */
      deliveryDiagAppended: 0,
      deliveryDiagFailed: 0,
      deliveryDiagSkipped: 0,
      /** 0.5 批次 5 · A 线：auto 冷却/恢复调度计数（fire-and-forget，失败静默——
       *  只在 diagnostics().counters 与 getStatus.diagnostics.auto 留痕，绝不打断
       *  pre-step/主回答）。 */
      autoEvaluationFailures: 0,
      acceptedReceipts: 0,
      l2Recoveries: 0,
      l2RecoveredFromSessionLog: 0,
      workingDirectoryLookups: 0,
      startFailures: [],
      /** P0#3：下载完成后自动 rebuild 的触发次数（diagnostics().counters 可观测；
       *  同代次重复完成事件被触发闸拦下时不计数，「恰好一次」可断言）。 */
      autoRebuildAttempts: 0,
    },
    /** 0.5 批次 5 · A 线：auto 冷却/恢复调度诊断（getStatus.diagnostics.auto 的
     *  数据源）。evaluations=成功评估次数；runs=执行轮数；applied/failedOps=逐条
     *  执行成败计数；undoRuns=撤销轮数；notDue=未到期跳过；busy=单飞闸跳过；
     *  fused=熔断评估次数；lastEvaluatedAt/lastRunAt/lastRunId/lastError=最近事件。
     *  全部由 autoEngine 的 onDiagnostics 汇维护，绝不外溢打断主流程。 */
    auto: {
      evaluations: 0,
      runs: 0,
      applied: 0,
      failedOps: 0,
      undoRuns: 0,
      notDue: 0,
      busy: 0,
      fused: 0,
      failures: 0,
      lastEvaluatedAt: null,
      lastRunAt: null,
      lastRunId: null,
      lastError: null,
    },
    /** F1b 语义召回运行态（getStatus.diagnostics.semantic 的数据源）：
     *  ready=provider 至少一次 embed 成功；rebuild 是面板「重建向量」的单飞进度。
     *  S5：download 是面板「下载模型」的单飞任务态（进度/取消都放诊断，前端
     *  轮询既有 getStatus 读，不新增 RPC、不新开宿主工具）。 */
    semantic: {
      ready: false,
      lastError: null,
      lastRecallAt: null,
      rebuild: { running: false, phase: "idle", total: 0, done: 0, error: null },
      download: {
        running: false,
        phase: "idle", // idle | starting | downloading | verifying | done | error | cancelled
        percent: null,
        loadedBytes: 0,
        totalBytes: 0,
        filesDone: 0,
        filesTotal: 0,
        source: null,
        error: null,
        /** S5 复审 P1 + 0.4 收账遗留 1：失败归因码（DOWNLOAD_DEPENDENCY_MISSING =
         *  缺可选依赖；DOWNLOAD_RUNTIME_LOAD_FAILED = 依赖已装但运行时加载失败；
         *  两者都与网络无关；null = 其余失败按网络/源故障归因）。 */
        code: null,
        installHint: null,
        cancelRequested: false,
      },
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
      config: coreBudgetsOf(settings.budgets),
      personaAdapter,
      now,
    });
    const sparkStore = await createSparkStore({ root: settings.dataRoot, scopeId });
    // ── 0.5 写后增量向量维护（任务书硬要求 1/2/3；provider 关闭时整段跳过，
    //    sparkStoreForScope 与裸 store 是同一对象——0.4 行为逐字节不变）──────
    let semanticQueue = null;
    let sparkStoreForScope = sparkStore;
    /**
     * 惰性打开本 scope 向量索引的共享入口（缓存进 resources.vectorStore；并发
     * 首开共用同一 promise 防双开——两个写者各开一个实例会互相覆盖落盘）。
     * vectorStoreFor（召回路径）与增量队列共用这一个入口。打开失败不缓存
     * rejection，下次调用重试；首次打开成功即 kick 一次启动差集兜底。
     */
    let openVectorStorePromise = null;
    let startupSyncKicked = false;
    const openVectorStore = async () => {
      if (semanticProvider === null || settings.stateRoot === null) return null;
      if (resources.vectorStore !== null) return resources.vectorStore;
      if (openVectorStorePromise === null) {
        openVectorStorePromise = openSemanticVectorStore({
          stateRoot: settings.stateRoot,
          scopeId,
          model: settings.semantic.local.model,
          dims: settings.semantic.local.dims,
        }).then(
          (store) => {
            resources.vectorStore = store;
            return store;
          },
          (error) => {
            openVectorStorePromise = null; // 不缓存 rejection：下次调用重试
            throw error;
          },
        );
      }
      const store = await openVectorStorePromise;
      // 首次打开成功 → 启动差集兜底（任务书硬要求 3）：异步比对 active 卡
      // revision 与索引条目，不一致后台补齐、残留 retainOnly 剔除。kick 自带
      // 错误收敛（进队列 stats），fire-and-forget，不阻塞召回/写路径。
      // 一次性闩：并发首开（写后 flush 与召回路径同时到达）共用同一 promise，
      // 只 kick 一次（差集幂等，重复 kick 只是无谓的第二轮）。
      if (!startupSyncKicked) {
        startupSyncKicked = true;
        semanticQueue?.kickStartupSync();
      }
      return store;
    };
    if (semanticProvider !== null && settings.stateRoot !== null) {
      semanticQueue = createSemanticIncrementalQueue({
        scopeId,
        provider: semanticProvider,
        openVectorStore,
        // 读卡真值：NOT_FOUND 归一成 null（物理消失的卡 → 差集剔除），其余错误
        // 抛回队列按单卡失败计（重试一次 + 保留 pending + 诊断）。
        readCard: async (id) => {
          try {
            return await sparkStore.read(id);
          } catch (error) {
            if (error?.code === "NOT_FOUND") return null;
            throw error;
          }
        },
        listActive: () => sparkStore.listActive(),
        // 嵌入文本口径与重建路径共用同一个 cardEmbedText（title/summary/content
        // 按行拼接）——改口径两处同步，不会分叉（任务书硬要求 6）。
        embedText: cardEmbedText,
        gate: semanticGate,
        // 模型未装 → 挂起不 embed（写路径零报错；诊断见 lastSkipReason）。
        canEmbed: () => {
          const dir = modelDirResolved();
          return dir !== null && isLocalModelInstalled({
            cacheDir: dir,
            model: settings.semantic.local.model,
            dtype: settings.semantic.local.dtype,
          });
        },
        // HOST_LOCKED（写权被其他实例持有）→ 挂起不写索引，避免与持写实例的
        // 落盘互相踩踏；判定与 resourcesFor 的 groups 写入口同口径（fail-open）。
        canWrite: () => (ctrl.readonlyGuard?.status?.().writable ?? true) === true,
        // stop/banned 收场检查：轮次在每卡前后查，stop 后立即收场不耗嵌入调用。
        shouldAbort: () => ctrl.banned || !ctrl.started,
        debounceMs: semanticIncrementalDebounceMs,
        nowIso,
      });
      // 写后增量（任务书硬要求 1）：save/update/forget 成功 → markDirty(id)
      // （同步零 IO，不阻塞工具返回；失败的写不挂钩子）。包装对工具门面/冷搜/
      // 遗忘执行器/management 完全透明（读路径与其余方法原样透传）。
      sparkStoreForScope = wrapSparkStoreWithIncrementalHooks(sparkStore, semanticQueue);
    }
    // ── 0.5-5C 自动连线器（模块 2）：spark_save / spark_update 提交时取相似
    //    top-k（阈值 0.80、每卡上限 3、去重），候选与卡片本体同一次 mutate 只写
    //    当前卡自身 links（auto:similar + 独立 score）。provider 关闭时 null：
    //    门面不传 store 的 autoLinks，行为与 0.4 逐字节一致；embed/索引失败在
    //    linker 内部收敛为跳过（null），零报错、绝不异步补写。嵌入文本口径复用
    //    同一个 cardEmbedText（与增量队列/重建同源）。
    let autoLinker = null;
    if (semanticProvider !== null && settings.stateRoot !== null) {
      autoLinker = createAutoLinker({
        scopeId,
        provider: semanticProvider,
        openVectorStore,
        listActive: () => sparkStore.listActive(),
        embedText: cardEmbedText,
        // 与增量队列同一把模型闸：模型未装时自动连线静默跳过，绝不经
        // provider.embed 的懒加载触发真实下载（写路径零下载副作用）。
        canEmbed: () => {
          const dir = modelDirResolved();
          return dir !== null && isLocalModelInstalled({
            cacheDir: dir,
            model: settings.semantic.local.model,
            dtype: settings.semantic.local.dtype,
          });
        },
      });
    }
    // 冷搜门面（显式 includeArchived 专用；只读、不复活、不自动匹配）。
    const coldSearch = createColdSearch({ store: sparkStoreForScope, scopeId });
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
    // 9 兼容 + topic_create + group_manage（S3）+ 8 Spark = 19（契约清单；0.5-5C 17→19）。
    // M3：sessionId 取自 dispatchTool 的 AsyncLocalStorage 证据（真实会话 id，
    // 供工具侧「当前会话锁定」身份校验），不再固定 null。
    const getSessionInfo = () => ({
      sessionId: toolSessionContext.getStore()?.sessionId ?? null,
      scopeId,
    });
    // S3：scope 首次进 active 即初始化组清单（幂等，缺文件才写默认模板）。
    // 已存在时只校验不改动；shadow/inert 不建 scope 资源，不会走到这里，
    // 「shadow 不写盘」与「读路径绝不写盘」的约束都不被破坏。
    // 0.4 补丁（账本 #22e213）：只读实例（座位被先启动的宿主持有，F7 判据）
    // 不写 groups.json——建文件归持写权的那台；重启后首次开 scope 时补
    // （ensureGroupsFile 幂等；resourcesFor 的结果按 scope 缓存进
    // ctrl.scopes，同进程内不会再次进入这条路）。座位判定在
    // createSeatGuard 创建时已 poll 一次（SEAT_HOLD_MS=0 命中即只读），
    // 此处读 status 即为当前事实。
    if ((ctrl.readonlyGuard?.status?.().writable ?? true) === true) {
      await ensureGroupsFile({ dataRoot: settings.dataRoot, scopeId });
    }
    const compatTools = [
      ...createCompatTools({
        service: serviceForTools,
        getSessionInfo,
        config: coreBudgetsOf(settings.budgets),
        now,
        readonlyGuard: ctrl.readonlyGuard ?? undefined,
        // 0.5-2B R1：组目录读法的数据来源（groups.json 按 scope 落 <dataRoot>/scopes/）。
        dataRoot: settings.dataRoot,
        // 0.5-2B R3：事件账本（memory_read 正文→read、组目录→group_list、
        // memory_search 命中→search_hit、memory_append/rewrite 成功→updated）。
        activity: topicActivity,
      }),
      createTopicCreateTool({
        service: serviceForTools,
        getSessionInfo,
        now,
        readonlyGuard: ctrl.readonlyGuard ?? undefined,
        // 0.5-2B R3：topic_create 成功→updated。
        activity: topicActivity,
      }),
      // S3：组清单管理工具（topic 组迁移经 service.mutate 走
      // store 提交协议，不绕存储层）。
      createGroupManageTool({
        service: serviceForTools,
        dataRoot: settings.dataRoot,
        scopeId,
        now,
        readonlyGuard: ctrl.readonlyGuard ?? undefined,
      }),
    ];
    const sparkTools = createSparkTools({
      scopeId,
      store: sparkStoreForScope,
      readonlyGuard: ctrl.readonlyGuard ?? undefined,
      autoLinker,
    }).tools;
    const all = [...compatTools, ...sparkTools];
    const toolByName = new Map(all.map((t) => [t.name, t]));
    const resources = {
      scopeId,
      personaAdapter,
      service,
      /** 0.5：provider 启用时是带写钩子的包装（save/update/forget 成功 → 增量
       *  入队）；provider 关闭时与裸 store 同一对象（0.4 行为逐字节不变）。 */
      sparkStore: sparkStoreForScope,
      tools: all,
      toolByName,
      l2Recovered: false,
      /** F1b：语义向量索引（<stateRoot>/semantic/<scopeId>.json）。
       *  惰性打开：仅在 semantic provider 已启用且召回/重建真需要时创建；
       *  provider 关闭时恒 null（绝不产生向量文件）。 */
      vectorStore: null,
      /** 0.5：本 scope 的写后增量队列（provider 关闭时 null；诊断 stats()）。 */
      semanticQueue,
      /** 0.5：向量索引共享惰性打开入口（vectorStoreFor 与增量队列共用）。 */
      openVectorStore,
    };
    ctrl.scopes.set(scopeId, resources);
    return resources;
  }

  /**
   * F1b：取（并惰性打开）scope 的向量索引。semantic 关闭或未配置 stateRoot 时
   * 返回 null——调用方据此走纯字面路径。打开即从磁盘加载，损坏/model 变更
   * 都在 store 内部容错（见 semantic/store.mjs），不会抛到召回路径。
   */
  async function vectorStoreFor(scopeId) {
    if (semanticProvider === null || settings.stateRoot === null) return null;
    const resources = await resourcesFor(scopeId);
    // 0.5：打开收敛到共享入口（并发首开共用同一 promise 防双开；首次打开成功
    // 即 kick 启动差集兜底——召回路径不阻塞，差集在后台跑）。
    return resources.openVectorStore();
  }

  async function closeAllScopes() {
    const errors = [];
    for (const [scopeId, resources] of ctrl.scopes) {
      // 0.5：先停写后增量队列（清防抖 timer、丢 pending——stop 场景下未处理的
      // 卡由下次 start 的启动差集兜底补齐；在途轮次靠 shouldAbort 检查点收场）。
      try {
        resources.semanticQueue?.close();
      } catch (error) {
        errors.push(`semanticQueue.close(${scopeId}): ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        resources.sparkStore.close();
      } catch (error) {
        errors.push(`sparkStore.close(${scopeId}): ${error instanceof Error ? error.message : String(error)}`);
      }
      // F1b：向量索引没有后台资源，close 只丢内存态（未落盘变更此前已按批落盘）。
      try {
        resources.vectorStore?.close();
      } catch (error) {
        errors.push(`vectorStore.close(${scopeId}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    ctrl.scopes.clear();
    // 评审 R16：焚毁（destroyData → invalidateScopeResources = 本函数）后必须
    // 失效投递体检的内存快照与重算链——否则下一次 getStatus 经兜底重开 scope
    // 前命中旧快照，会把已焚毁卡片的 title/triggers/覆盖率继续返回面板（S6
    // 同类隐私/陈旧数据回归）。此处运行时调用，两 Map 的 const 初始化早已完成
    // （无 TDZ）；清空后下一次 getStatus 走兜底重算（scope 已关 → available:
    // false / scope-not-open，重开后从零开始）。
    deliveryCheckupSnapshots.clear();
    deliveryCheckupRefreshChains.clear();
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

  // ─────────────────────────────────────────────────────────
  // F1b：语义向量重建（面板「重建向量」按钮的保留名通道）
  // ─────────────────────────────────────────────────────────

  /** 重建进度快照（返回值与 getStatus.diagnostics.semantic.rebuild 同形状）。 */
  function rebuildSnapshot() {
    const rebuild = ctrl.semantic.rebuild;
    return { running: rebuild.running, phase: rebuild.phase, total: rebuild.total, done: rebuild.done, error: rebuild.error };
  }

  /** 卡片 embedding 文本：标题/摘要/正文按行拼接（缺段跳过；全空得到空串）。 */
  function cardEmbedText(card) {
    return [card.title, card.summary, card.content]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join("\n");
  }

  /**
   * 后台分批重建（0.5：经 semanticGate 单飞闸进入——见下）。
   */
  async function runSemanticRebuild(scopeId, records, force) {
    // 0.5 单飞并发防线（任务书硬要求 2）：与写后增量 flush / 启动差集共用同一把
    // semanticGate。重建全程持锁——从开头 store.clear() 到收尾 retainOnly+save
    // 都在闸内，增量索引写只在锁外发生，严禁交错；重建期间 markDirty 只标
    // dirty，锁释放后的下一轮 flush 按差集补齐。锁等待计入 rebuild.running
    // （置位在 semanticRebuild 同步段），面板可见「排队中」；单飞判定仍由
    // rebuild.running 承担（语义不变）。
    return semanticGate.run(() => runSemanticRebuildLocked(scopeId, records, force));
  }

  /**
   * 重建主体（必须在 semanticGate 闸内调用）。每批 SEMANTIC_REBUILD_BATCH 张，
   * 批间 setTimeout 让出事件循环；每批原子落盘（中断/失败后进度可恢复，重试走
   * 增量续传）。逐批检查 ctrl.banned / started——stop 后立即中止，不再消耗嵌入
   * 调用。不进 trackInFlight：重建可能长达数十秒，stop 的排空窗口（10s 上限）
   * 不该被它拖满；中止语义由批间检查保证。
   */
  async function runSemanticRebuildLocked(scopeId, records, force) {
    const rebuild = ctrl.semantic.rebuild;
    const store = await vectorStoreFor(scopeId);
    if (store === null) {
      fail("INVALID_STATE", "向量索引不可用（语义召回未启用或 stateRoot 未配置）", {});
    }
    // force 全量：丢弃现有索引从头算。副作用取舍（0.4 收尾 reviewer 记录项，不改
    // 行为）：store.clear() 只清内存态（src/semantic/store.mjs clear 契约），磁盘
    // 上仍是旧向量，直到首批 embed 成功后才按批覆盖落盘（每批收尾的 store.save）。因此——
    // ① 首个 embed 失败或批间中止时，磁盘保持旧索引不回滚，但进程内索引已空，
    //   重建期间语义召回静默退化为字面匹配（召回质量下降，不报错，重建完即恢复）；
    // ② 中途 abort 也会按批把部分新索引覆盖旧盘（断点续传契约的一部分，非 bug），
    //   「换模型维度变了」的场景下这些部分新向量本就该替换旧向量，方向正确。
    // 彻底消除要做成「影子索引 + 原子切换」，属结构性改动，0.5 再议。
    if (force === true) store.clear();
    for (let i = 0; i < records.length; i += SEMANTIC_REBUILD_BATCH) {
      if (ctrl.banned || !ctrl.started) {
        rebuild.phase = "aborted";
        return;
      }
      for (const card of records.slice(i, i + SEMANTIC_REBUILD_BATCH)) {
        // 增量（默认）：revision 未变的卡片直接沿用现有向量。
        if (force !== true) {
          const have = store.get(card.id);
          if (have !== null && have.revision === card.revision) {
            rebuild.done += 1;
            continue;
          }
        }
        try {
          const vec = await semanticProvider.embed(cardEmbedText(card));
          store.upsert(card.id, card.revision, vec);
          ctrl.semantic.ready = true;
        } catch (error) {
          throw new Error(
            `重建向量失败（${rebuild.done + 1}/${records.length}，卡片「${card.title ?? card.id}」）：`
            + (error instanceof Error ? error.message : String(error))
            + "。已完成的部分已按批保存，稍后可直接重试续传。",
            { cause: error },
          );
        }
        rebuild.done += 1;
      }
      await store.save(); // 每批原子落盘：崩溃/中止后重试从断点续传
      await new Promise((resolve) => setTimeout(resolve, 0)); // 让出事件循环
    }
    // S5 复审 P2：收尾写（retainOnly + save）前再查一次中止——批间检查挡不住
    // 「最后一批 save 刚过、stop 到达」的窗口；stop 后不该再碰 state/semantic。
    if (ctrl.banned || !ctrl.started) {
      rebuild.phase = "aborted";
      return;
    }
    // 剔除：索引中已不在 active 集的条目（卡片删除/归档后的残留向量）。
    // ── 0.4 收账遗留 3（已知残余窗口，本批只记录不修）────────────────────
    // 残余窗口：从这里进入 store.retainOnly(ids) 之后、直到下方 await
    // store.save() 完成——期间若 stop（banned / !started）到达，收尾写不会被
    // 中止，save 会与 stop 的清理并发进行。在测试里表现为 Windows EBUSY：
    // teardown 的 rm（删除 stateRoot）撞上还没写完的 store.save。
    // 为什么不在此处修：彻底消除要把 save 拆成「可中止的两段提交」
    // （先写影子文件、停后再择机提交），属于结构性改动，超出本批范围，
    // 留给 0.5。调用方规避方式：stop 前先等到 rebuild.running === false
    // （见 test/plugin/controller.test.mjs 建索引门禁用例的 waitFor）。
    store.retainOnly(records.map((r) => r.id));
    await store.save();
  }

  /**
   * semantic_rebuild 保留名入口（dispatchTool 在工具表检查之前拦截到此）。
   * 单飞：已有重建在跑时直接返回当前进度快照，不排队不重跑。
   * @returns 进度快照 {started, running, phase, total, done, error}。
   */
  async function semanticRebuild(scope, args) {
    // 只读态拒绝：与写工具同口径（assertWritable 抛 HOST_LOCKED）；向量是
    // 派生数据、落 stateRoot，只读宿主不应触发对 stateRoot 的成批写入。
    if (ctrl.readonlyGuard !== null) {
      try {
        ctrl.readonlyGuard.assertWritable();
      } catch (error) {
        fail(error?.code ?? "HOST_LOCKED",
          "当前宿主处于只读态（写权被其他实例持有），不能重建向量。向量是派生数据，落 stateRoot；等持有写权的实例退出后可重试。",
          { holder: error?.details ?? error?.message ?? null });
      }
    }
    if (semanticProvider === null) {
      fail("INVALID_STATE",
        `语义召回未开启（semantic.provider="${settings.semantic.provider}"），没有可重建的向量索引；`
        + "请先把 semantic.provider 设为 \"local\" 并重启插件。", {});
    }
    // S5：模型必须已安装（期望文件齐全）才允许建索引。维度校验在下载收尾的
    // 真实推理里做（local.mjs），这里拦的是「根本没下模型 / 半截下载」。
    const rebuildModelDir = modelDirResolved();
    if (rebuildModelDir === null
      || !isLocalModelInstalled({
        cacheDir: rebuildModelDir,
        model: settings.semantic.local.model,
        dtype: settings.semantic.local.dtype,
      })) {
      fail("INVALID_STATE",
        "本地语义模型尚未安装（或下载不完整）：请先在状态页点「下载模型」，"
        + `安装目录 ${rebuildModelDir ?? "（未解析，dataRoot 未配置）"} 下必须齐备 `
        + expectedModelFiles(settings.semantic.local.dtype).join("、") + "。", {});
    }
    if (args !== undefined && args !== null
      && (typeof args !== "object" || Array.isArray(args))) {
      fail("INVALID_INPUT", "semantic_rebuild args must be an object or undefined", {});
    }
    const force = args?.force;
    if (force !== undefined && typeof force !== "boolean") {
      fail("INVALID_INPUT", `semantic_rebuild args.force must be a boolean or undefined, got ${String(force)}`, {});
    }

    const rebuild = ctrl.semantic.rebuild;
    // 单飞检查与置位必须同步完成（首个 await 之前），并发第二次调用只会拿到快照。
    if (rebuild.running) {
      return { started: false, ...rebuildSnapshot() };
    }
    rebuild.running = true;
    rebuild.phase = "starting";
    rebuild.error = null;
    let recordsRef = null;
    try {
      // 预取总量（快速只读）后再交后台批处理；此后本函数返回，不阻塞面板 RPC。
      const resources = await resourcesFor(scope.scopeId);
      recordsRef = await resources.sparkStore.listActive();
      rebuild.total = recordsRef.length;
      rebuild.done = 0;
      rebuild.phase = "running";
    } catch (error) {
      // 预取失败：恢复空闲态并把错误如实上报（面板可重试）。
      rebuild.running = false;
      rebuild.phase = "error";
      rebuild.error = `重建向量启动失败：${error instanceof Error ? error.message : String(error)}`;
      ctrl.semantic.lastError = rebuild.error;
      throw error;
    }
    const kickoff = runSemanticRebuild(scope.scopeId, recordsRef, force === true)
      .then(() => {
        if (rebuild.phase === "running") rebuild.phase = "done";
      })
      .catch((error) => {
        rebuild.phase = "error";
        rebuild.error = error instanceof Error ? error.message : String(error);
        ctrl.semantic.lastError = rebuild.error;
      })
      .finally(() => {
        rebuild.running = false;
      });
    kickoff.catch(() => {}); // 错误已收进 rebuild.error；detached 不进 stop 排空
    return { started: true, ...rebuildSnapshot() };
  }

  // ─────────────────────────────────────────────────────────
  // S5：语义模型下载（面板「下载模型」按钮的保留名通道）
  // ─────────────────────────────────────────────────────────

  /** 下载任务快照（返回值与 getStatus.diagnostics.semantic.download 同形状）。 */
  function downloadSnapshot() {
    const dl = ctrl.semantic.download;
    return {
      running: dl.running,
      phase: dl.phase,
      percent: dl.percent,
      loadedBytes: dl.loadedBytes,
      totalBytes: dl.totalBytes,
      filesDone: dl.filesDone,
      filesTotal: dl.filesTotal,
      source: dl.source,
      error: dl.error,
      code: dl.code ?? null,
      installHint: dl.installHint,
    };
  }

  /** 下载源顺序：配置镜像先、官方源兜底；重复源去重（配置可能已填官方源）。 */
  function downloadMirrors() {
    const mirrors = [settings.semantic.local.mirror, SEMANTIC_FALLBACK_SOURCE]
      .filter((m) => typeof m === "string" && m.length > 0);
    return [...new Set(mirrors)];
  }

  /**
   * 全源失败时的可复制安装提示词（面板一键复制）：写清模型 repo id、规范目录
   * 写法（<缓存根>/<org>/<model>/）、必须齐备的文件清单与各下载源。
   * 0.4 收账遗留 1：依赖说明按归因码分流——只有缺依赖（DOWNLOAD_DEPENDENCY_MISSING）
   * 挂「npm i 装依赖」提示；运行时加载失败（DOWNLOAD_RUNTIME_LOAD_FAILED）依赖
   * 已装、装了也没用，提示改为先看错误信息修好依赖再重试。
   */
  function downloadInstallHint(cacheDir, mirrors, code = null) {
    const model = settings.semantic.local.model;
    const dtype = settings.semantic.local.dtype;
    const modelDir = localModelDir(cacheDir, model);
    const dependencyNote = code === DOWNLOAD_RUNTIME_LOAD_FAILED
      ? "依赖说明：可选依赖 @huggingface/transformers 已安装，但本次运行时加载失败（不是网络问题）。"
        + "请先看上方错误信息，修复依赖环境（文件权限、版本兼容等）后重试——直接 npm i 不会解决问题。"
      : "依赖说明：本功能依赖可选依赖 @huggingface/transformers；若报错是「缺少可选依赖」，"
        + "这不是网络问题——先在插件目录执行 npm i @huggingface/transformers 再重试。";
    return [
      "请把 HuggingFace 模型 " + model + " 安装到本机以下目录（目录结构必须保持「<缓存根>/<org>/<model>/」）：",
      modelDir,
      "该目录下必须齐备这些文件：" + expectedModelFiles(dtype).join("、"),
      dependencyNote,
      "可用任一下载源：",
      mirrors.join("\n"),
      "示例（huggingface-cli，可在任意可联网环境执行后整目录拷回）：",
      "huggingface-cli download " + model + " --local-dir \"" + modelDir + "\"",
      "安装完成后回到本页点「下载模型」即可（已存在的文件不会重下）。",
    ].join("\n");
  }

  /**
   * 下载任务态整体复位成空闲（S5 复审 P1）：start / stop（清理路径）各调一次，
   * 保证跨 stop/restart 不残留「下载中」——否则重启后面板一直转圈、点下载只得到
   * started:false、取消也没人消费。error/installHint 一并清空：跨代次的旧报错
   * 不许冒充新代次的诊断。
   */
  function resetDownloadIdle() {
    const dl = ctrl.semantic.download;
    dl.running = false;
    dl.phase = "idle";
    dl.percent = null;
    dl.loadedBytes = 0;
    dl.totalBytes = 0;
    dl.filesDone = 0;
    dl.filesTotal = 0;
    dl.source = null;
    dl.error = null;
    dl.code = null;
    dl.installHint = null;
    dl.cancelRequested = false;
  }

  /** 复位下载任务态并进入新一轮（semanticDownload 入口专用）。 */
  function resetDownloadState() {
    resetDownloadIdle();
    const dl = ctrl.semantic.download;
    dl.running = true;
    dl.phase = "starting";
  }

  /**
   * 下载完成后自动 rebuild 的触发（P0#3，0.4 审查报告）：下载成功即替用户
   * 点一次「重建向量」，不必再手动操作。防重不靠这里——runSemanticDownload
   * 的 done 分支结构上只走一次（stale/running 检查在前，running 先翻 false），
   * semanticRebuild 自身单飞（已有 rebuild 在跑 → started:false 快照）；本函数
   * 只做两道纵深防御（主防线在 stop 的同步段：0.4 收尾已把代次 +1 与下载态复位
   * 挪到 banned 置位的同一个同步段，原来那个微任务窗口不复存在）：
   * ① banned/started 闸——纵深防御：防 stop 之后仍被拉起的调用形态，不许拉起
   *    resourcesFor/vectorStoreFor（历史窗口由 test「banned 窗口内迟到 done」的
   *    thenable 构造钉住，现在先被同步段的代次失效拦下）；
   * ② 代次闸——兜底，防未来的重放/重复投递形态（当前结构不可达，不写成主防线）。
   * 计数器 autoRebuildAttempts 经 diagnostics().counters 可观测（恰好一次可断言）。
   * 失败不静默：运行期错误本就落 rebuild.error + lastError；触发期同步抛错
   * （只读态 / 门禁 / 目录无法解析等）在 catch 里落 lastError，面板可见。
   *
   * 0.4 收尾：强制全量（force: true）。换模型通常意味着维度变了，旧模型留下的
   * 向量继续留在库里参与检索会串味——增量分支只算新增/变化（revision 未变直接
   * 沿用旧向量），清不掉换模型前的存量。下载完成的场景必然是新模型首次就位，
   * 走 runSemanticRebuild 的 force 分支（先 store.clear() 再从头算）才干净。
   * 面板手动「重建向量」仍走增量，不受此影响。
   */
  let autoRebuildTriggeredGen = -1;
  function triggerAutoRebuildAfterDownload(scope, gen) {
    if (ctrl.banned || !ctrl.started) return; // stop 之后（含 banned/gen+1 窗口）：不触发
    if (gen === autoRebuildTriggeredGen) return; // 纵深防御：同代次重复投递兜底
    autoRebuildTriggeredGen = gen;
    ctrl.diag.autoRebuildAttempts += 1;
    semanticRebuild(scope, { force: true })
      .catch((error) => {
        ctrl.semantic.lastError =
          `下载后自动重建向量失败：${error instanceof Error ? error.message : String(error)}`;
      });
  }

  /**
   * 后台下载主体（detached，不进 stop 排空——与 rebuild 同取舍；中止语义由
   * isCancelled 检查保证：stop/取消后 progress_callback 立即抛哨兵收场）。
   * S5 复审 P1：所有写回都带代次防护——gen 与 ctrl.downloadGeneration 不匹配
   * （stop/restart 已复位、或已有新任务接管）时静默退场，旧任务绝不覆写新状态。
   */
  async function runSemanticDownload(scope, downloader, dl, gen) {
    const stale = () => gen !== ctrl.downloadGeneration;
    const result = await downloader.download({
      onProgress: (snap) => {
        if (stale()) return; // 旧代次任务的迟到进度不许覆写当前状态
        dl.percent = snap.percent;
        dl.loadedBytes = snap.loadedBytes;
        dl.totalBytes = snap.totalBytes;
        dl.filesDone = snap.filesDone;
        dl.filesTotal = snap.filesTotal;
      },
      onSource: (source) => { if (stale()) return; dl.source = source; },
      onPhase: (phase) => { if (stale()) return; dl.phase = phase; },
      // stop（banned）同样视为取消：不与宿主关闭竞速。
      isCancelled: () => dl.cancelRequested === true || ctrl.banned || !ctrl.started,
    });
    // 代次不匹配（已被 stop/restart 复位，或新任务已接管）：直接退场不写回。
    if (stale() || dl.running !== true) return;
    // running 先翻 false：done 分支只走一次——触发天然在「恰一次」的窗口里
    // （stop 的同步段已换代次，迟到 done 在这里就 stale 退场；trigger 内的闸是纵深防御）。
    dl.running = false;
    if (result.ok === "done") {
      dl.phase = "done";
      dl.code = null;
      dl.installHint = null;
      // 下载收尾已含真实推理校验（local.mjs）：provider 就绪语义与 embed 成功同口径。
      ctrl.semantic.ready = true;
      ctrl.semantic.lastError = null;
      // P0#3：done = 文件齐全 + 维度校验通过（真实推理），自动串一次 rebuild。
      // 0.4 收尾：这里走 force 全量——换模型后旧向量的维度已变，增量分支会沿用
      // 存量旧向量；面板手动按钮仍走增量（args:{}）。文件门禁正常放行，真实下载
      // 的收尾校验已保证文件齐备。
      triggerAutoRebuildAfterDownload(scope, gen);
    } else if (result.ok === "cancelled") {
      dl.phase = "cancelled";
      dl.error = null;
    } else {
      dl.phase = "error";
      dl.error = result.error;
      dl.code = result.code ?? null;
      dl.installHint = downloadInstallHint(modelDirResolved() ?? "", downloadMirrors(), dl.code);
      ctrl.semantic.lastError = result.code === DOWNLOAD_DEPENDENCY_MISSING
        ? result.error // 依赖缺失如实归因（不改写「模型下载失败：」前缀混入网络暗示）
        : `模型下载失败：${result.error}`;
    }
  }

  /**
   * semantic_download 保留名入口（dispatchTool 在工具表检查之前拦截到此）。
   * 单飞：已有下载在跑时直接返回当前快照；args.cancel=true 请求协作取消。
   * @returns {started?: boolean, cancelled?: boolean, ...downloadSnapshot()}
   */
  async function semanticDownload(scope, args) {
    // 只读态拒绝：与 semantic_rebuild 同口径——模型文件落 <dataRoot>/models，
    // 只读宿主不应触发对 dataRoot 的写入。
    if (ctrl.readonlyGuard !== null) {
      try {
        ctrl.readonlyGuard.assertWritable();
      } catch (error) {
        fail(error?.code ?? "HOST_LOCKED",
          "当前宿主处于只读态（写权被其他实例持有），不能下载模型。模型落 <dataRoot>/models；等持有写权的实例退出后可重试。",
          { holder: error?.details ?? error?.message ?? null });
      }
    }
    if (semanticProvider === null) {
      fail("INVALID_STATE",
        `语义召回未开启（semantic.provider="${settings.semantic.provider}"），没有可下载的本地模型；`
        + "请先把 semantic.provider 设为 \"local\" 并重启插件。", {});
    }
    if (args !== undefined && args !== null
      && (typeof args !== "object" || Array.isArray(args))) {
      fail("INVALID_INPUT", "semantic_download args must be an object or undefined", {});
    }
    const dl = ctrl.semantic.download;
    if (args?.cancel === true) {
      if (!dl.running) {
        return { cancelled: false, ...downloadSnapshot() }; // 幂等：没有在跑的任务，原样返回
      }
      dl.cancelRequested = true; // 协作取消：后台任务在下一个 progress_callback 检查点收场
      return { cancelled: true, ...downloadSnapshot() };
    }
    if (typeof args?.cancel !== "undefined" && typeof args?.cancel !== "boolean") {
      fail("INVALID_INPUT", `semantic_download args.cancel must be a boolean or undefined, got ${String(args.cancel)}`, {});
    }
    // 单飞检查与置位必须同步完成（首个 await 之前），并发第二次调用只会拿到快照。
    if (dl.running) {
      return { started: false, ...downloadSnapshot() };
    }
    const cacheDir = modelDirResolved();
    if (cacheDir === null) {
      fail("INVALID_STATE",
        "模型缓存目录无法解析（semantic.local.cacheDir 为空且 dataRoot 未配置）："
        + "请配置 dataRoot 或显式指定 semantic.local.cacheDir。", {});
    }
    // S5 复审 P1：新任务先 +1 代次再置位——旧任务（含正在收尾的）看到代次不匹配
    // 即静默退场，其迟到进度/收尾写不会污染本任务的状态。
    ctrl.downloadGeneration += 1;
    const gen = ctrl.downloadGeneration;
    resetDownloadState();
    const mirrors = downloadMirrors();
    const downloader = createDownloader({
      model: settings.semantic.local.model,
      dims: settings.semantic.local.dims,
      dtype: settings.semantic.local.dtype,
      cacheDir,
      mirrors,
    });
    const kickoff = runSemanticDownload(scope, downloader, dl, gen)
      .catch((error) => {
        // 下载器本身抛错（不该发生：download 吞实现错误只返回结果）——如实落 error 态。
        if (gen !== ctrl.downloadGeneration || dl.running !== true) return; // 代次已换/已复位
        dl.running = false;
        dl.phase = "error";
        dl.error = `模型下载任务异常：${error instanceof Error ? error.message : String(error)}`;
        dl.code = null;
        // 复审 P3-3：显式传 code（此处恒为 null，与上行对应），不许依赖参数默认值兜底。
        dl.installHint = downloadInstallHint(cacheDir, mirrors, dl.code);
        ctrl.semantic.lastError = dl.error;
      });
    kickoff.catch(() => {}); // 错误已收进 download.error；detached 不进 stop 排空
    return { started: true, ...downloadSnapshot() };
  }

  async function dispatchTool(scope, name, args, exec) {
    // R2（0.5 批次 3 变异审计 M2）：这里不再放降级闸——它此前就是死代码。
    // 宿主工具走 registeredToolDefs().execute 里更早的同款闸；面板路径走
    // management.executeTool，那里已在 requireStarted 之前用注入的
    // getRootDegradation 判定（否则会先撞 INVALID_STATE「尚未启动」）。
    // 两条入口都在 dispatchTool 之前拦截，本函数在降级态不可达。
    // B4：禁新请求（stop 后）不再执行任何工具。
    if (ctrl.banned || !ctrl.started) {
      fail("INVALID_STATE", "controller is stopped or not started; tool dispatch refused", {});
    }
    // F1b：semantic_rebuild 保留名拦截（必须位于 ALL_TOOL_NAMES 检查之前——
    // 它不是宿主工具，见 SEMANTIC_REBUILD_TOOL 处注释）。
    if (name === SEMANTIC_REBUILD_TOOL) {
      return semanticRebuild(scope, args);
    }
    // S5：semantic_download 保留名拦截（同上；args.cancel=true 为协作取消）。
    if (name === SEMANTIC_DOWNLOAD_TOOL) {
      return semanticDownload(scope, args);
    }
    if (!ALL_TOOL_NAMES.includes(name)) {
      fail("INVALID_INPUT", `unknown shiori tool "${String(name)}"`, {});
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
        // P1#8 降级闸（R2 起是宿主工具路径上唯一的一道，dispatchTool 里的重复
        // 死代码已删）：降级挂载不宣称 started，这里的 started 检查会先把调用
        // 错报成 INVALID_STATE——降级必须先于它判定，工具执行统一 UNSUPPORTED
        // （details.roots 带逐根诊断）。面板路径由 management.executeTool 的
        // getRootDegradation 前置检查承担同一口径。
        if (ctrl.rootDiagnostics.length > 0) {
          fail("UNSUPPORTED", `shiori root directories are not writable; tool "${name}" is unavailable (degraded read-only mount). 修复目录权限或显式改配 dataRoot/stateRoot 后重启插件即可恢复`, {
            roots: [...ctrl.rootDiagnostics],
          });
        }
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
          // F5 前置：水位采样随投影落盘低频记一条（节流在 state.mjs 内部）。
          // softChars/hardChars 按显式字段读，尚未升级（ budgets 只有 ratio ）时
          // 按 hardCapChars × ratio 回退换算；配置 schema 的升级由 config 线负责，
          // 这里不改 config.mjs。
          const coreBudget = settings.budgets.core;
          const waterline = {
            softChars: Number.isInteger(coreBudget.softChars) && coreBudget.softChars >= 0
              ? coreBudget.softChars
              : Math.round(hardCap * coreBudget.softRatio),
            hardChars: Number.isInteger(coreBudget.hardChars) && coreBudget.hardChars >= 0
              ? coreBudget.hardChars
              : Math.round(hardCap * coreBudget.hardRatio),
            hardCapChars: hardCap,
          };
          // 遥测与注入解耦：采样/落盘失败只记诊断，绝不让本轮 SECTION_CORE 整段缺失。
          try {
            await state.projectionStore.saveL1(scope.scopeId, {
              text: coreText,
              revision: view?.revision ?? null,
              waterline,
            });
          } catch (error) {
            ctrl.diag.assemblySkips.push(`core-waterline(${scope.scopeId}): ${error instanceof Error ? error.message : String(error)}`);
            if (ctrl.diag.assemblySkips.length > 50) ctrl.diag.assemblySkips.shift();
          }
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
    // F2：l2 hits 账写富化副本（附命中触发词 / 来源）。投递快照落账时带的
    // hitMeta 在此取回；老投递无 hitMeta → trigger/source 为 null（如实未记录）。
    // sparkStore.recordDeliveryHits 收到的仍是不带附加字段的原始 hitUpdates。
    const hitMeta = delivery && typeof delivery.hitMeta === "object" && delivery.hitMeta !== null ? delivery.hitMeta : {};
    const ledgerHitUpdates = hitUpdates.map((h) => {
      const meta = typeof h?.sparkId === "string" && hitMeta[h.sparkId] !== null && typeof hitMeta[h.sparkId] === "object"
        ? hitMeta[h.sparkId]
        : {};
      return {
        ...h,
        trigger: typeof meta.trigger === "string" ? meta.trigger : null,
        source: meta.source === "seed" || meta.source === "related" ? meta.source : null,
      };
    });
    await state.l2Store.recordHits(scopeId, deliveryId, ledgerHitUpdates);
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

  /**
   * 0.5 批次 5 · A 线：auto 冷却/恢复调度（pre-step 人类轮入口，§11.2.1）。
   *
   * 人类轮判据：本轮上下文存在 source.kind === "user" 的消息——与心跳插件
   * turnOriginIsUserSplice 同一套口径；心跳投递 / 引擎室轮的 source 不是 user，
   * 天然跳过（心跳轮不触发）。挂在 L2 开关之前：L2 关闭时 auto 调度照常可用。
   *
   * 绝不阻塞主回答：调度构造同步、引擎调用 fire-and-forget（trackInFlight 登记
   * 供 stop 排空）；评估/执行/撤销的全部失败在引擎内部转诊断汇（ctrl.auto /
   * ctrl.diag.autoEvaluationFailures），这里只做兜底 catch——pre-step 的返回值
   * 与耗时都不受 auto 影响。off / 未 start / 被封禁 / 无可信会话证据一律静默跳过。
   */
  function scheduleAutoEvaluationSafely(payload) {
    try {
      if (settings.forgetting?.enabled !== true) return;
      if (ctrl.banned || !ctrl.started) return;
      const humanTurn = (Array.isArray(payload?.messages) ? payload.messages : [])
        .some((m) => m?.source?.kind === "user");
      if (!humanTurn) return; // 心跳轮/引擎室轮不触发
      const evidence = sessionEvidenceFromAgent(payload?.agent);
      if (evidence === null) return;
      const scope = pinScope({
        settings,
        sessionId: evidence.sessionId,
        workspace: workspaceForAgent(evidence.agent),
        generation: ctrl.generation,
        source: "pre-step",
      });
      const pending = Promise.resolve(autoEngine.onHumanTurn({ scopeId: scope.scopeId }));
      trackInFlight(pending).catch(() => {
        // onHumanTurn 理论上不 reject（内部已兜底转诊断）；防御一层防未处理 rejection。
        ctrl.diag.autoEvaluationFailures += 1;
      });
    } catch {
      // 调度构造失败（evidence/scope 异常等）：计数留痕，绝不打断 pre-step。
      ctrl.diag.autoEvaluationFailures += 1;
    }
  }

  /**
   * 0.5 批次 5 · A 线：L2 关闭但 auto 开启时的专用人类轮入口（只在 l2.enabled=false
   * 且 forgetting.enabled=true 时注册）。仅观察 payload 后原样放行——不投递、
   * 不建消息、不计 preSteps 计数（那属于 L2 投递语义）。
   */
  async function autoOnlyPreStep(payload, next) {
    scheduleAutoEvaluationSafely(payload);
    return next();
  }

  async function preStepHandler(payload, next) {
    ctrl.diag.preSteps += 1;
    // 0.5 批次 5 · A 线：auto 调度先行（fire-and-forget，绝不阻塞主回答；
    // L2 关闭时也照常调度）。详见 scheduleAutoEvaluationSafely 头注释。
    scheduleAutoEvaluationSafely(payload);
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
    // F1b：字面优先 + 向量补位合并召回。semanticProvider 为 null 时
    // mergeSemanticRecall 内部就是一次原样 matchSparks 调用——行为与 0.1
    // 逐字节等价，且不触碰向量索引（不产生任何向量文件）。provider 不可用
    // （embed 抛错）同样在合并层收敛为纯字面，错误进 ctrl.semantic 诊断。
    let vectorsFor = null;
    if (semanticProvider !== null) {
      const store = await vectorStoreFor(scope.scopeId);
      if (store !== null) vectorsFor = (sparkId) => store.get(sparkId);
    }
    const recall = await mergeSemanticRecall({
      scopeId: scope.scopeId,
      userText,
      sparks: records,
      seenKeys,
      sessionId: scope.sessionId,
      contextEpoch: epoch,
      maxSeeds: settings.budgets.spark.seedCount,
      maxRelated: settings.budgets.spark.linkCount,
      provider: semanticProvider,
      vectorsFor,
      // 置信度下限走配置（semantic.minSimilarity，默认 0.55）：改配置即可调松紧，
      // 不需要改代码重新打包。
      threshold: settings.semantic.minSimilarity,
    });
    const match = recall.match;
    // 语义诊断转存（getStatus.diagnostics.semantic 消费）：embed 成功即视为
    // provider 就绪；失败记 lastError（面板「上次错误」），绝不外溢打断投递。
    if (recall.semantic.enabled) {
      ctrl.semantic.lastRecallAt = nowIso();
      if (recall.semantic.error !== null) {
        ctrl.semantic.lastError = recall.semantic.error;
      } else {
        ctrl.semantic.lastError = null;
        ctrl.semantic.ready = true;
      }
    }
    const delivery = buildSparkAttachment({
      scopeId: scope.scopeId,
      sessionId: scope.sessionId,
      contextEpoch: epoch,
      match,
      maxChars: settings.budgets.spark.maxChars,
    });
    // F2 闪回命中可见性：match 里的命中触发词与来源（种子 / 一跳关联）在
    // buildSparkAttachment 的 delivered（{id, revision}）中被丢弃，而
    // delivery.mjs / state.mjs 不在本任务白名单内——这里在投递快照上附加
    // hitMeta（sparkId → {trigger, source}），随 recordPending 持久进 l2 账本，
    // finalizeDelivery 写 hits 账时用富化副本。只含元数据，不含卡片正文。
    // 老投递（无 hitMeta）在面板/按钮上如实显示「未记录」。
    const hitMeta = {};
    for (const seed of match?.seeds ?? []) {
      if (seed && typeof seed.id === "string") {
        hitMeta[seed.id] = { trigger: typeof seed.trigger === "string" ? seed.trigger : null, source: "seed" };
      }
    }
    for (const related of match?.related ?? []) {
      if (related && typeof related.id === "string" && !Object.hasOwn(hitMeta, related.id)) {
        hitMeta[related.id] = { trigger: null, source: "related" };
      }
    }
    delivery.hitMeta = hitMeta;

    // ── 0.5-4D：投递诊断账本——每轮召回后追加一条不含正文的记录 ──────────
    // 记录字段严格白名单（diagnostics.mjs assertRecordShape），只含 id 与数字
    // 证据，绝不携带 title/summary/content。写入口径（评审 R4/R9 修订）：
    //  - R4：写延后到投递定局之后——deliveredIds 只收真正附加进本轮的卡
    //    （appendedIds）；空投、已 committed、pending 去重、next 非 enter 的
    //    轮次写 deliveredIds: []，已构建未追加的候选落 slot_full（命中/达标
    //    但没投出），不虚增「窗口投递次数」；
    //  - R9：判定 + 构造整体包进 try——readonlyGuard.status() 抛错也只计数，
    //    绝不冒泡打断 pre-step/投递；
    //  - shadow：pre-step 根本不注册（只有 active 挂 pre-step），天然不写；
    //  - 只读宿主（HOST_LOCKED，写权被其他实例持有）与 stateRoot 未配置：
    //    正常静默跳过（不计 skipped，R8 口径）；
    //  - 非阻塞：appendRecord 不 await（topic-activity 同款异步缓冲；账本层
    //    IO 失败折叠为 {ok:false} 只计数），写失败只进 ctrl.diag 计数。
    const writeDiagnosticsRecord = (appendedIds) => {
      try {
        if (settings.stateRoot === null) return;
        if ((ctrl.readonlyGuard?.status?.().writable ?? true) !== true) return;
        const diagnosticsRecord = buildRoundRecord({
          at: nowIso(),
          scopeId: scope.scopeId,
          cards: records,
          match,
          semantic: recall.semantic,
          delivery,
          appendedIds,
          threshold: settings.semantic.minSimilarity,
        });
        const writePromise = state.diagnosticsStore.appendRecord(scope.scopeId, diagnosticsRecord).then(
          (result) => {
            if (result?.ok === false) {
              ctrl.diag.deliveryDiagFailed += 1;
              return;
            }
            ctrl.diag.deliveryDiagAppended += 1;
            // R5：落账成功即异步刷新面板内存快照（后台串行，不阻塞投递）。
            void refreshDeliveryCheckupSnapshot(scope.scopeId);
          },
          () => {
            // appendRecord 理论上不 reject（IO 已折叠）；防御一层防止未处理 rejection。
            ctrl.diag.deliveryDiagFailed += 1;
          },
        );
        // 不 await（诊断路径绝不阻塞投递），但登记在途 promise：stop 时统一排空，
        // 避免迟到写盘与「store 关闭 / 临时目录删除」竞态（attempt-3 ENOTEMPTY 根因）。
        deliveryDiagWrites.add(writePromise);
        void writePromise.then(
          () => deliveryDiagWrites.delete(writePromise),
          () => deliveryDiagWrites.delete(writePromise),
        );
      } catch {
        // 记录构造/形状校验/守卫读取异常：计数留痕，诊断路径不炸投递（R9）。
        ctrl.diag.deliveryDiagSkipped += 1;
      }
    };

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
      // R4：空投轮也落账（归因数据源），deliveredIds 恒空。
      writeDiagnosticsRecord([]);
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
      // R4：包早已在此前轮次投出（deliveryId 去重命中）→ 本轮不虚增投递。
      writeDiagnosticsRecord([]);
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
      // R4：pending 去重命中（上一轮已落账待回执）→ 本轮不虚增投递。
      writeDiagnosticsRecord([]);
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
    if (decision?.kind !== "enter") {
      // R4：宿主未放行本轮（非 enter）→ 包没有真正附加，deliveredIds 恒空；
      // 已构建的候选落 slot_full（命中/达标但没投出）。
      writeDiagnosticsRecord([]);
      return decision;
    }
    writeDiagnosticsRecord(delivery.delivered.map((d) => d.id));
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

  // ─────────────────────────────────────────────────────────
  // 0.5 批次 5 · A 线：auto 冷却/恢复引擎（§11.2 触发/评估/执行/撤销）
  // ─────────────────────────────────────────────────────────
  //
  // 单实例：management 的四个 auto RPC（getAutoStatus/runAutoEvaluation/
  // applyAutoChanges/undoAutoRun）与本文件 pre-step 的人类轮调度共用；全部持久
  // 状态落 state.autoStore（<stateRoot>/auto-organize.json），内存只有单飞闸。
  // 评估只读（HOST_LOCKED 也允许——只读宿主「不执行 auto，评估只读展示」）；
  // 执行/撤销经 assertWritableForAuto（座位守卫）+ service.mutate（CAS + journal
  // operationId 幂等）。诊断汇只更新 ctrl.auto / ctrl.diag，绝不外溢打断主流程。
  const autoReplaySource = createAutoReplaySource({ dataRoot: settings.dataRoot, stateRoot: settings.stateRoot });
  const autoEngine = createAutoEngine({
    nowIso,
    // 三档模式现读（§7 off/suggest/auto）：模块开关关闭时按 off 处理（只记账，
    // 调度不评估）。settings.forgetting 非 volatile——改档需重载插件，引擎每次
    // 调用现读以便未来热切换不改这里。
    mode: () => (settings.forgetting.enabled === true ? settings.forgetting.autoMode : "off"),
    params: () => liveTemperature(),
    replaySource: autoReplaySource,
    serviceFor: async (scopeId) => (await resourcesFor(scopeId)).service,
    store: state.autoStore ?? null,
    isStarted: () => ctrl.started,
    readonlyGuard: () => ctrl.readonlyGuard,
    // L1 软水位（§11.2.1 辅助入口）：读水位采样侧表最新一条，l1Chars 逼近
    // softChars 即武装。只触发分析，绝不缩短 S、绝不降低冷却阈值。采样缺失
    // （低频节流）或读失败按未武装降级——水位是尽力而为的辅助信号。
    watermark: async (scopeId) => {
      if (settings.stateRoot === null) return false;
      const softChars = settings.budgets.core.softChars;
      if (!(typeof softChars === "number" && softChars > 0)) return false;
      const entries = await state.readWaterline(settings.stateRoot, scopeId);
      const last = entries.length > 0 ? entries[entries.length - 1] : null;
      return last !== null && typeof last.l1Chars === "number" && last.l1Chars >= softChars;
    },
    onDiagnostics: (entry) => {
      try {
        switch (entry.kind) {
          case "auto-eval":
            ctrl.auto.evaluations += 1;
            ctrl.auto.lastEvaluatedAt = entry.at;
            break;
          case "auto-eval-fused":
            ctrl.auto.fused += 1;
            break;
          case "auto-run":
            ctrl.auto.runs += 1;
            ctrl.auto.applied += entry.applied ?? 0;
            ctrl.auto.lastRunAt = entry.at;
            ctrl.auto.lastRunId = entry.runId;
            break;
          case "auto-undo":
            ctrl.auto.undoRuns += 1;
            ctrl.auto.failedOps += entry.failed ?? 0;
            break;
          case "auto-schedule-not-due":
            ctrl.auto.notDue += 1;
            break;
          case "auto-schedule-skipped-busy":
            ctrl.auto.busy += 1;
            break;
          case "auto-schedule-failed":
            ctrl.auto.failures += 1;
            ctrl.diag.autoEvaluationFailures += 1;
            ctrl.auto.lastError = entry.error ?? null;
            break;
          default:
            break;
        }
      } catch { /* 诊断汇维护失败静默（绝不影响调度链） */ }
    },
  });

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
    // R1（0.5 批次 3）：降级诊断注入。降级挂载时 started 恒 false，面板
    // management.executeTool 若先走 requireStarted 只会报 INVALID_STATE
    // 「尚未启动」——把 mount 的逐根诊断交给门面，让它先判降级、返回带
    // details.roots 的 UNSUPPORTED。读 ctrl 是纯内存投影，不可能抛。
    getRootDegradation: () => [...ctrl.rootDiagnostics],
    // R4②：人设卡目录读取注入点（仅测试注入 EACCES 桩验证 personasError 与
    // diagnostics.roots 并存；生产不传，门面缺省用 node:fs readdir）。
    readdir: personasReaddir,
    // 0.5 批次 4 · B 线：热度参数三方法的数据源。liveTemperature 热读 volatile
    // 引用（见上方定义）；审计事件复用本插件唯一 topic-activity 账本实例 append
    // （评审拍板：不在 state.mjs 另开第二个 writer 写同一文件）。
    liveTemperature,
    appendTemperatureAudit: (event) => (topicActivity !== null
      ? topicActivity.append(event)
      : Promise.resolve({ ok: false, code: "NOT_CONFIGURED", error: "topic-activity ledger unavailable" })),
    // P-C 诚实度：getStatus.diagnostics 暴露 typertRpc（wire 契约的
    // diagnostics 块为 additionalProperties:true，纯增量），真实入口 boot
    // 与面板都能观察到严格 codec 的实际状态。
    typertRpcInfo: () => ({ codec: ctrl.typertRpc.codec, reason: ctrl.typertRpc.reason }),
    // F7：门面构造早于座位守卫（守卫在 start 里先占座），这里给取值函数。
    // 只读态下面板写方法（analyze / reviewCandidate / previewPlan /
    // executePlan）抛 HOST_LOCKED，与写工具同口径。
    readonlyGuard: () => ctrl.readonlyGuard,
    // 0.5 批次 5 · A 线：auto 冷却/恢复引擎（四个 auto RPC 的业务唯一入口；
    // pre-step 人类轮调度共用同一实例）与调度诊断数据源（getStatus.diagnostics
    // 的 auto 块，wire 上 additionalProperties:true 纯增量）。
    autoEngine,
    autoDiagnostics: () => ({ ...ctrl.auto }),
    // 0.4 S6（review-rework a1 中-2）：仅 destroyData 使用的 scope 资源缓存
    // 失效入口——复用 stop 的清理路径 closeAllScopes（async，返回 Promise<string[]>
    // 的 close 错误数组；调用方 management.destroyData 必须 await），不新造缓存
    // 语义。焚毁 dataRoot 后，缓存的 scope 资源全部指向已删目录；不清掉，后续
    // 访问会拿到旧缓存（内存里还有已焚毁的卡片记录，甚至写回旧数据）。下一次
    // 访问按需重建空资源。
    invalidateScopeResources: () => closeAllScopes(),
  });

  // M4-drain：management 数据方法全部纳入在途排空——stop 等待收场（带上限），
  // 不得在 store 关闭后让在途 RPC 撞 INVALID_STATE。getStatus 稳态读 pre-step
  // 快照（纯内存）；首轮/快照重算失败兜底读盘（错误折叠），不占在途（评审 R15
  // 注释同步：本路径并非全程纯内存，如实口径见 deliveryCheckupFor）。
  // 0.5 批次 4 · C 线：契约扩展 11 → 14（+ 整理向导 onboardingPreview/Apply/Mark；
  // 评审拍板独立三方法，previewPlan/executePlan 不动）。
  // 0.5 批次 4 · B 线：契约扩展 14 → 17（+ 热度参数三方法 getTemperatureSettings /
  // simulateTemperature / recordTemperatureChange，追加在 onboardingMark 之后）。
  // 0.5 批次 5 · A 线：契约扩展 17 → 21（+ auto 冷却/恢复四方法 getAutoStatus /
  // runAutoEvaluation / applyAutoChanges / undoAutoRun，追加在 recordTemperatureChange
  // 之后；DRAINED 清单 16 → 20）。
  const DRAINED_MANAGEMENT_METHODS = [
    "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze",
    "reviewCandidate", "previewPlan", "executePlan", "getTimeline",
    "destroyData",
    "onboardingPreview", "onboardingApply", "onboardingMark",
    "getTemperatureSettings", "simulateTemperature", "recordTemperatureChange",
    "getAutoStatus", "runAutoEvaluation", "applyAutoChanges", "undoAutoRun",
  ];
  // 三处清单逐字一致断言（评审要求，错位即启动失败）：CONTRACT_METHODS（Q 挂载
  // 闸已断言它与 protocol.MANAGEMENT_METHODS 集合一致）去掉纯内存 getStatus 后
  // 必须与 DRAINED 逐字同集合——新增管理方法漏进任何一处都在这里显式炸出。
  const drainedMismatch = methodSetMismatch(
    DRAINED_MANAGEMENT_METHODS,
    CONTRACT_METHODS.filter((name) => name !== "getStatus"),
  );
  if (drainedMismatch) {
    throw new Error(`shiori management drain list out of sync with the frozen wire contract: ${drainedMismatch}`);
  }
  const management = { ...managementFacade };
  for (const name of DRAINED_MANAGEMENT_METHODS) {
    const method = managementFacade[name];
    if (typeof method === "function") {
      management[name] = (...args) => trackInFlight(method.apply(managementFacade, args));
    }
  }

  // F1b：getStatus.diagnostics.semantic（wire 的 diagnostics 块为
  // additionalProperties:true，纯增量注入；不改方法数、不改描述符）。
  // 面板状态页的语义召回只读状态与「重建向量」按钮进度都从这里读。
  // S5 纯增量：download（下载任务态）+ modelDir（解析后的模型缓存目录）
  // + modelInstalled（期望文件是否齐备，供「下载模型」按钮高亮）。
  function semanticDiagnostics(scopeId) {
    const rebuild = ctrl.semantic.rebuild;
    const diag = {
      provider: settings.semantic.provider,
      enabled: semanticProvider !== null,
      ready: ctrl.semantic.ready,
      model: settings.semantic.local.model,
      dims: settings.semantic.local.dims,
      dtype: settings.semantic.local.dtype,
      /** 当前 scope 已建向量数；scope 未打开（shadow/inert）时为 null。 */
      vectors: null,
      lastError: ctrl.semantic.lastError,
      lastRecallAt: ctrl.semantic.lastRecallAt,
      rebuild: { ...rebuild },
      /** S5：模型缓存目录（cacheDir 显式配置优先，空串兑现为 <dataRoot>/models；
       *  inert（dataRoot null）时为 null）。 */
      modelDir: modelDirResolved(),
      /** S5：模型是否已完整安装（期望文件齐备；目录未解析时恒 false）。 */
      modelInstalled: false,
      /** S5：面板「下载模型」的单飞任务态（进度/取消/报错卡片数据源）。
       *  cancelRequested 是内部取消旗标，不进 wire 快照。 */
      download: (() => {
        const { cancelRequested, ...publicDownload } = ctrl.semantic.download;
        void cancelRequested;
        return publicDownload;
      })(),
      /** 0.5 写后增量诊断（任务书硬要求 5「诊断可见」）：pending=本 scope 待补卡
       *  数（scope 未打开为 null）；running=有 flush/差集轮在跑（含闸上排队）；
       *  lastSkipReason 记降级原因（host-readonly / model-not-installed /
       *  vector-store-unavailable，写路径零报错的可见面）；lastError 记最近一次
       *  增量失败（静默重试仍失败才留痕，成功不回填）。provider 关闭时
       *  enabled=false 且恒为空转快照（行为与 0.4 一致：无队列无钩子）。 */
      incremental: (() => {
        const idle = {
          enabled: semanticProvider !== null,
          pending: null,
          running: false,
          flushes: 0,
          embedded: 0,
          removed: 0,
          startupSyncs: 0,
          lastFlushAt: null,
          lastSyncAt: null,
          lastError: null,
          lastSkipReason: null,
        };
        if (semanticProvider === null) return idle;
        if (typeof scopeId === "string" && ctrl.scopes.has(scopeId)) {
          const queue = ctrl.scopes.get(scopeId).semanticQueue;
          if (queue !== null && queue !== undefined) return { ...idle, ...queue.stats() };
        }
        return idle;
      })(),
    };
    if (diag.modelDir !== null) {
      diag.modelInstalled = isLocalModelInstalled({
        cacheDir: diag.modelDir,
        model: settings.semantic.local.model,
        dtype: settings.semantic.local.dtype,
      });
    }
    if (typeof scopeId === "string" && ctrl.scopes.has(scopeId)) {
      const store = ctrl.scopes.get(scopeId).vectorStore;
      diag.vectors = store === null ? 0 : store.size();
    }
    return diag;
  }
  // ── 0.5-4D：面板「投递体检」数据源（getStatus.diagnostics.delivery）──────
  // wire 的 diagnostics 块 additionalProperties:true，纯增量注入（与 roots /
  // semantic 同款：不改方法数、不改描述符、不加 RPC 方法）。内容 = readDiagnostics
  // 聚合（每卡覆盖率 + 「从未投递」「高频投递但低使用」两清单）+ 账本写侧计数。
  //
  // 评审 R5 内存快照方案（如实口径，本路径不是纯内存投影）：pre-step 每轮落账
  // 成功后异步重算并刷新快照（按 scope 串行、后台执行，不阻塞投递）；getStatus
  // 稳态只读内存快照。磁盘只在两种兜底时机被读：① 实例启动后该 scope 还没有
  // 任何快照（首次 getStatus 算一次并缓存）；② 快照重算失败后的下一次读取重试
  // （失败不缓存）。账本只被 appendRecord（pre-step 路径）变化、写后即刷新，
  // 快照与账本一致；其他实例持写锁写同一账本的跨进程窗口不在保证内（只读态
  // 本就不落账）。重算与 stop 的竞态由折叠兜住：store 关闭后 listActive 抛
  // INVALID_STATE → 保持旧快照/返回 { available:false }，绝不外溢打断 getStatus。
  const deliveryCheckupSnapshots = new Map();     // scopeId → { at, value }
  const deliveryCheckupRefreshChains = new Map(); // scopeId → Promise（重算串行化）
  // 在途投递诊断写 promise（fire-and-forget 落账的登记处）：stop 时统一排空，
  // 避免「store 已关 / 临时目录已删」与迟到写盘竞态（attempt-3 观察到的
  // ENOTEMPTY 竞态根因）。
  const deliveryDiagWrites = new Set();
  async function computeDeliveryCheckup(scopeId) {
    const resources = ctrl.scopes.get(scopeId);
    const checkup = await readDiagnostics({
      scopeId,
      days: DIAGNOSTICS_RETENTION_DAYS,
      readRecords: (sid) => state.diagnosticsStore.readRecords(sid),
      listCards: () => resources.sparkStore.listActive(),
      now: now(),
      // 评审 R14：语义开关注入归因——provider=none（默认）时 not-scored 卡的
      // 面板文案不得建议「重建向量」（状态页该按钮此时是禁用的）。
      semanticEnabled: semanticProvider !== null,
    });
    return { available: true, ...checkup, writer: state.diagnosticsStore.writerStats(scopeId) };
  }
  function refreshDeliveryCheckupSnapshot(scopeId) {
    const previous = deliveryCheckupRefreshChains.get(scopeId) ?? Promise.resolve();
    const next = previous
      .then(() => computeDeliveryCheckup(scopeId))
      .then(
        (value) => { deliveryCheckupSnapshots.set(scopeId, { at: Date.now(), value }); },
        () => { /* 重算失败：保留旧快照；下次写/读兜底重试，诊断路径绝不外溢 */ },
      );
    deliveryCheckupRefreshChains.set(scopeId, next);
    return next;
  }
  function deliveryCheckupFor(scopeId) {
    // R13③：stateRoot 未配置（inert/降级）给明确 reason，面板文案可区分。
    if (settings.stateRoot === null) {
      return Promise.resolve({ available: false, reason: "state-root-missing" });
    }
    if (typeof scopeId !== "string" || !ctrl.scopes.has(scopeId)) {
      return Promise.resolve({ available: false, reason: "scope-not-open" });
    }
    const snapshot = deliveryCheckupSnapshots.get(scopeId);
    if (snapshot) return Promise.resolve(snapshot.value);
    // 兜底：首轮 getStatus 算一次并缓存（之后稳态恒纯内存）。
    return computeDeliveryCheckup(scopeId).then(
      (value) => {
        deliveryCheckupSnapshots.set(scopeId, { at: Date.now(), value });
        return value;
      },
      (error) => ({ available: false, error: error instanceof Error ? error.message : String(error) }),
    );
  }

  const baseGetStatus = managementFacade.getStatus;
  management.getStatus = async function getStatusWithSemantic(trustedContext, payload) {
    const status = await baseGetStatus.call(managementFacade, trustedContext, payload);
    // P1#8：diagnostics.roots 注入（wire 的 diagnostics 块 additionalProperties:true，
    // 纯增量）。逐根 mkdir 失败的结构化诊断（{root, path, reason, code}）——降级
    // 只读/内存态挂载的可见证据（空数组 = 两根就绪）。纯内存读 ctrl，不可能抛。
    status.diagnostics = { ...(status.diagnostics ?? {}), roots: [...ctrl.rootDiagnostics] };
    // F1b：diagnostics.semantic 注入（wire 的 diagnostics 块 additionalProperties:true，
    // 纯增量；不改方法数、不改描述符）。semanticDiagnostics 是纯内存投影，正常
    // 不可能抛；一旦抛（未来字段演化引入缺陷），这里显式把 reason 写进
    // diagnostics.semantic.error——绝不静默吞掉让语义状态凭空消失、排查无门。
    try {
      status.diagnostics = { ...(status.diagnostics ?? {}), semantic: semanticDiagnostics(status.scope) };
    } catch (error) {
      status.diagnostics = {
        ...(status.diagnostics ?? {}),
        semantic: { error: `语义诊断注入失败: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
    // 0.5-4D：diagnostics.delivery 注入（纯增量，同上口径）。体检聚合带磁盘读，
    // 失败折叠为 { available:false, error }，绝不打断 getStatus。
    try {
      status.diagnostics = {
        ...(status.diagnostics ?? {}),
        delivery: await deliveryCheckupFor(status.scope),
      };
    } catch (error) {
      status.diagnostics = {
        ...(status.diagnostics ?? {}),
        delivery: { available: false, error: `投递体检注入失败: ${error instanceof Error ? error.message : String(error)}` },
      };
    }
    return status;
  };

  // ─────────────────────────────────────────────────────────
  // 生命周期
  // ─────────────────────────────────────────────────────────

  function requireStartable() {
    if (ctrl.starting) fail("INVALID_STATE", "controller start already in progress", {});
    if (ctrl.started) fail("INVALID_STATE", "controller already started; call stop() first", {});
    // R3：降级挂载不宣称 started，但 19 个宿主工具已经注册。此时不 stop 直接
    // 再 start 会在真实 bindings 上二次注册同名工具（撞名抛错，且依赖底层报错
    // 文本才看得懂）。重启的唯一合法路径是 stop()→start()；这里给出明确错误，
    // 不让「直接重启」这句旧注释继续骗人。
    if (ctrl.degradedRegistered) {
      fail("INVALID_STATE", "previous degraded start already registered host tools; call stop() before start() to retry (restarting without stop would re-register duplicate tool names)", {});
    }
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
    // S5 复审 P1：新代次作废旧下载任务的收尾写；下载态复位成空闲——
    // 跨 stop/restart 不残留「下载中」（面板轮询/按钮态都读 diagnostics.semantic.download）。
    ctrl.downloadGeneration += 1;
    resetDownloadIdle();
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
      // P1#8：挂载期根可写性二次裁决（mkdir -p 幂等；与 verifyPluginRoots 的
      // degradeOnMkdirFailure 降级模式共用 probeRootsWritable，失败逐根记结构化
      // 诊断）。apply 的 verify 降级调用不再因 mkdir 失败 throw——这里以磁盘真值
      // 决定挂载形态：任一根不可写 → 降级只读/内存态（零落盘：不建组清单 / 锁 /
      // 索引 / 座位文件）：
      // 19 工具照常注册（宿主工具面不变，执行统一 UNSUPPORTED：宿主工具走
      // registeredToolDefs 的入口降级闸，面板走 management.executeTool 的降级
      // 前置检查），跳过一切触盘步骤（completion 锁 / 座位 / persona 预校验 /
      // scope 资源 / L0/L1 / L2）；started 不宣称（getStatus 走纯内存投影，
      // 诊断面板可见）。用户修复权限（或改配根路径）后重启插件即恢复完整挂载。
      ctrl.rootDiagnostics = probeRootsWritable({ dataRoot: settings.dataRoot, stateRoot: settings.stateRoot });
      if (ctrl.rootDiagnostics.length > 0) {
        for (const def of registeredToolDefs()) {
          await bindings.registerTool(def);
        }
        checkNotStopped("degraded-registration");
        // R3：工具已进宿主注册表——标记出来，requireStartable 据此拦「不 stop
        // 再 start」的二次注册；stop/start 失败的 cleanupGeneration 负责复位。
        ctrl.degradedRegistered = true;
        return {
          mode: settings.mode,
          degraded: true,
          roots: [...ctrl.rootDiagnostics],
          sections: [],
          tools: [...bindings.diagnostics.registeredTools],
        };
      }
      ctrl.completion = await openState({ root: settings.stateRoot, scopeId: `shiori-plugin-${settings.ownerId}` });
      ctrl.probe = createCompressProbe({ now: nowIso, sink: ctrl.completion.sink });
      checkNotStopped("completion-state");

      // F7：座位心跳判据。先启动的宿主持写权，后启动的（更早的活座位存在）
      // 一律只读。只读判定必须落在工具层——面板置灰挡不住模型。
      // 座位目录不可写时 fail-open 保持可写（见 host/seat.mjs 顶部取舍说明），
      // 原因留在 diagnostics.readonly.seat.degraded / lastError。
      ctrl.seatGuard = await createSeatGuardFactory({ dataRoot: settings.dataRoot });
      ctrl.readonlyGuard = ctrl.seatGuard.guard;
      checkNotStopped("readonly-seat");

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
        } else if (settings.forgetting?.enabled === true) {
          // 0.5 批次 5 · A 线：重启路径同款（L2 关闭 + auto 开启的人类轮入口）。
          bindings.registerPreStep((payload, next) => trackInFlight(autoOnlyPreStep(payload, next)));
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
      // 19 工具经真实 defineTool 注册。
      for (const def of registeredToolDefs()) {
        await bindings.registerTool(def);
      }
      if (settings.l2.enabled) {
        ctrl.createUserMessage = await bindings.loadCreateUserMessage();
        bindings.registerPreStep((payload, next) => trackInFlight(preStepHandler(payload, next)));
      } else if (settings.forgetting?.enabled === true) {
        // 0.5 批次 5 · A 线：L2 关闭但 auto 冷却开启——仍需 pre-step 人类轮入口
        //（§11.2.1）。该入口只观察 payload（人类轮判定 + fire-and-forget 调度）后
        // 原样放行，绝不投递、不建消息；l2.enabled=true 时由完整 preStepHandler
        // 顶部同款调度覆盖，不重复注册。
        bindings.registerPreStep((payload, next) => trackInFlight(autoOnlyPreStep(payload, next)));
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
      // P1#8：降级挂载不宣称 started——getStatus 保持纯内存投影（management 的
      // 触数据方法按 INVALID_STATE 拒绝，与未启动同口径），工具层经宿主工具入口
      // 的降级闸 / management.executeTool 的降级前置检查返回 UNSUPPORTED。
      // R3（语义修正）：started 留 false，但修复权限后**只有 stop()→start()**
      // 才是合法重启——降级态已把 19 个工具注册进宿主，不 stop 再 start 会二次
      // 注册同名工具；requireStartable 以 degradedRegistered 给出明确 INVALID_STATE。
      if (result?.degraded !== true) {
        ctrl.started = true;
      }
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
  /** 契约：传 downloadsInvalidated: true 的调用方**必须**已在自己的同步段调过
   *  invalidateDownloadGeneration()，否则这一代会静默漏一次代次失效。目前只有
   *  stop()（:2014 调、:2018 传参）一个调用点用这个标志。 */
  function cleanupGeneration(phase, { downloadsInvalidated = false } = {}) {
    const run = cleanupChain.then(
      () => cleanupGenerationInner(phase, downloadsInvalidated),
      () => cleanupGenerationInner(phase, downloadsInvalidated),
    );
    cleanupChain = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 代次失效 + 下载态复位（0.4 收尾：从 cleanupGenerationInner 抽出，stop 的同步段
   * 也调一次）。为什么可以挪：读 ctrl.downloadGeneration 的只有 detached 下载任务
   * 自己的 stale()（runSemanticDownload 及其进度/源/phase 写回）与下载完成后的
   * triggerAutoRebuildAfterDownload——两者都只读这个计数、不依赖清理链时序。stop()
   * 在首个 await 之前调本函数，banned 置位与代次失效落在同一个同步段，窗口关闭；
   * triggerAutoRebuildAfterDownload 里的 banned/started 闸随之降级为纵深防御。
   * 代次只 +1 一次：stop 路径在自己的同步段 +1，并以 downloadsInvalidated=true
   * 让 cleanupGeneration 跳过；start 失败等非 stop 路径仍由 inner 补做。
   */
  function invalidateDownloadGeneration() {
    ctrl.downloadGeneration += 1;
    resetDownloadIdle();
  }

  async function cleanupGenerationInner(phase, downloadsInvalidated = false) {
    const errors = [];
    // S5 复审 P1：清理路径（stop / start 失败）同步复位下载任务态并 +1 代次——
    // 下载任务是 detached，不进排空；靠代次失效收尾写 + 状态复位保证
    // stop 之后 diagnostics.semantic.download 不残留 running=true。
    // 0.4 收尾：stop 已在同步段调过 invalidateDownloadGeneration()（关掉 banned 与
    // 代次之间的微任务窗口），这里按标志跳过，同一代清理不会 +2 次。
    if (!downloadsInvalidated) invalidateDownloadGeneration();
    // 1) 撤销注册与订阅（bindings 逆序 dispose）。
    try {
      const disposed = bindings.disposeAll();
      const disposeErrors = Array.isArray(disposed?.errors) ? disposed.errors : [];
      errors.push(...disposeErrors.map((e) => `bindings.dispose (${phase}): ${e}`));
      // R3：只有确认注册表干净撤销后才解除二次注册闸。生产 bindings 的
      // disposeAll 不抛、失败走 errors 数组——按「有没有抛」判断不够：有报错
      // 时注册表可能残留，仍须拦住后续 start。
      if (disposeErrors.length === 0) ctrl.degradedRegistered = false;
    } catch (error) {
      // R3：撤销本身失败时保留 degradedRegistered——宁可继续拦住 start（二次
      // 注册同名工具），也不放行撞名。
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
    // 3.5) 0.5-4D：排空在途投递诊断写（评审 R18：唯一排空点）。必须在 in-flight
    // drain 之后——此刻全部 preStep 已收场、其诊断写均已登记；早于它排空会漏掉
    // 「stop 时 preStep 仍在途、drain 期间才登记」的写（实测 stop 返回后 400ms
    // 才落盘）。放在 closeAllScopes 之前，账本仍可用；in-flight 超限未收场的
    // 任务已在 errors 如实记录（其迟到写由 appendRecord 自身失败折叠兜底，不抛）。
    if (deliveryDiagWrites.size > 0) {
      await Promise.allSettled([...deliveryDiagWrites]);
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
    if (ctrl.readonlyGuard !== null) {
      try {
        ctrl.readonlyGuard.stop();
      } catch (error) {
        errors.push(`readonly-guard.stop (${phase}): ${error instanceof Error ? error.message : String(error)}`);
      }
      ctrl.readonlyGuard = null;
    }
    // 让座：删座位文件（删不掉也不报错，其他宿主靠心跳老化自愈）。
    if (ctrl.seatGuard !== null) {
      try {
        await ctrl.seatGuard.stop();
      } catch (error) {
        errors.push(`seat.withdraw (${phase}): ${error instanceof Error ? error.message : String(error)}`);
      }
      ctrl.seatGuard = null;
    }
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
    // 0.4 收尾：代次失效与下载态复位放进同步段（第一个 await 之前）。读代次的是
    // detached 下载任务的 stale() / 迟到进度写回，以及下载完成后的
    // triggerAutoRebuildAfterDownload；原先它们排在 cleanupGeneration →
    // cleanupChain.then(...) 的微任务里，banned 置位与代次 +1 之间留了一个窗口
    // （见 test「banned 窗口内迟到 done」的 thenable 构造），只能靠 banned 闸兜底。
    // 挪到这里后窗口关闭；cleanupGeneration 收到 downloadsInvalidated 标记，
    // 同一代清理不再 +1 第二次。
    invalidateDownloadGeneration();
    if (ctrl.startingPromise !== null) {
      await ctrl.startingPromise.catch(() => {});
    }
    const errors = await cleanupGeneration("stop", { downloadsInvalidated: true });
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
      // 0.4-S1（纯增量）：apply 阶段解析后的两个根（null=inert 直构时保持 null）、
      // 根来源（explicit=用户显式配置 / default=DSH_HOME 缺省解析）与配置完成度信号，
      // 与面板初始化卡片三行（根路径 / 模式 / 人设卡）逐行对齐，前端不必自行推断：
      //   needs-persona：人设卡未配置（defaultPersona null，最优先）；
      //   needs-active：人设卡已配置但 mode 非 active（shadow 只读，等用户点「启用」）；
      //   configured：active 且人设卡已配置。
      dataRoot: settings.dataRoot,
      stateRoot: settings.stateRoot,
      rootsSource: settings.rootsSource,
      // P1#8（纯增量）：逐根 mkdir 失败诊断（降级挂载证据；空数组 = 两根就绪）。
      roots: [...ctrl.rootDiagnostics],
      configurationState: liveSettingsForScope(settings).defaultPersona === null
        ? "needs-persona"
        : (settings.mode === "active" ? "configured" : "needs-active"),
      started: ctrl.started,
      starting: ctrl.starting,
      banned: ctrl.banned,
      startCount: ctrl.startCount,
      stopCount: ctrl.stopCount,
      generation: ctrl.generation,
      /** S5 下载任务代次：stop 的同步段即 +1（失效在途 detached 下载的收尾写），
       *  与 generation 分开记——下载任务跨 start/stop 的失效口径只认这一条。 */
      downloadGeneration: ctrl.downloadGeneration,
      ownerId: settings.ownerId,
      budgets: settings.budgets,
      modules: { l2: settings.l2.enabled, organize: settings.organize.enabled, forgetting: settings.forgetting.enabled },
      scopes: scopeDiags,
      bindings: bindings.diagnostics,
      probe: ctrl.probe?.diagnostics() ?? null,
      completion: ctrl.completion?.diagnostics?.() ?? { status: "not-open" },
      /** F7 只读状态（writable/readonly + 持有者 + 座位心跳细节）；未启动恒 null。 */
      readonly: ctrl.seatGuard?.status() ?? null,
      counters: { ...ctrl.diag },
      // 0.5-2B：topic-activity 账本诊断（appended/failed/lastError/pending；
      // null = 无账本——inert 直构或 stateRoot 未配置）。写失败只进这里的诊断，
      // 绝不影响工具返回。
      topicActivity: topicActivity?.stats() ?? null,
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
