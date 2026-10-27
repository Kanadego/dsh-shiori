/**
 * Shiori host bridge — 真实 DSH 宿主的薄适配层（P0）。
 *
 * 只做形状映射，不做业务：把 cordis 插件上下文（ctx.systemPrompt.section /
 * ctx.tools.register(defineTool) / ctx.on("session/event")）适配为桥所需的 host 抽象。
 *
 * 只读源码依据（2026-10-24 重新实测，行号与 SHA256 记录在 docs/completion/README.md §1）：
 * - dsh-soul-md 0.10.2 index.js:351  section({name, order, text, interpolate})，text 为同步函数；
 * - dsh-soul-md 0.10.2 index.js:579  tools.register(defineTool({name, description, parameters,
 *   execute(args, exec), isConcurrencySafe}))；
 * - dsh-agent-loop 0.2.1-rc.2 lib/index.js:682/697  tool/call {callId,name} 与
 *   tool/result {message:{callId,isError}}（tool/result 不含工具名，须按 callId 归因）；
 * - dsh-agent-loop 0.2.1-rc.2 lib/index.js:976  ctx.on("session/event", ...) 返回 disposer；
 * - dsh-session 0.2.1-rc.2 lib/index.js:133-134  "tool/ptc-dispatch(-start)" 为持久会话事件类型；
 * - billion-context 0.1.206 dsh-native.js:128  回执 {text, failed, outcome?, blocksCreated?}、
 *   partialOutcomeNote 固定文本、parseBlocksCreated 只接受 ≥0 整数、exec.agent.session.id、
 *   同名注册冲突（"already registered"）。
 *
 * P1-COMPLETION 新增语义：
 * - 归一化事件附带 callId（direct: tool/result 的调用身份，容错优先级
 *   message.callId → message.toolCallId → message.source.callId，只取非空字符串；
 *   真实 desktop 宿主的 tool message 只有 toolCallId + source.callId，没有 message.callId
 *   ——2026-10-26 对真实 session.v4.jsonl.zstd seq=124 核实；PTC: parentCallId，
 *   缺失时退化 rootCallId/subCallId）。探针用它做同一底层调用 direct/PTC 双报告去重；
 *   关联规则与局限（跨路径无法关联时的如实诊断）见模块头与 docs/completion/README.md。
 * - 数值元数据与文本证据同时存在且矛盾 → metaConflict:true 且不带 blocksCreated
 *   （探针保守不推进）；一致则任取其一。
 * - subscribeCompletedTools 的监听器可返回 Promise：适配层跟踪在途回调，
 *   flushCompletedTools() 等待全部已派发回调（含失败）并报告失败清单；
 *   订阅仍返回 disposer（旧签名不变）。
 * - assembleDshShioriHost 新增可选 probeSink：原样转交 createHostBridge（不解释、不缓存），
 *   供 D 的运行时注入 openCompletionState 句柄的 sink。
 *
 * 能力现状（不可证实的一律 UNSUPPORTED / 不假设，不写 mock 冒充联调）：
 * - 真实宿主 section text 只见到同步用法 ⇒ 本适配声明 asyncSectionText=false，
 *   桥走「同步快照 + 事件后刷新」；快照刷新时机：start / mutate 提交后 / 完成事件后 / 手动 refresh。
 *   手改磁盘到下一次事件之间的不可见窗口是已知限制（REPORT.md）。
 * - 直接模式的 tool/result 事件里数值 meta.blocksCreated 仍不可证实（不假设）；块证据改由
 *   content 中**整行锚定**的成功文本回执采信（与 PTC 共用 blocksFromReceiptText）：
 *   2026-10-26 真机 seq=124 的 direct tool/result content 即 `[Compressed m00020–…, m00041–
 *   m00042 → 5 block(s), ~57512 tokens saved. Excluded …]` ⇒ blocksCreated=5 ⇒ 探针推进
 *   （实测 advanced, epoch 0→1）。只有无法归因（callId 缺失/名字查不到）或无块证据时
 *   才不推进。
 * - PTC 模式（本机 code-mode）块证据（2026-10-24 对本机会话 session.v4.jsonl.zstd
 *   只读解码 5 个 compress 样本核实，data keys = rootCallId,parentCallId,subCallId,
 *   name,arguments,isError,content，**无 blocksCreated 字段**）：
 *   · 成功回执首行固定 `[Compressed m…–m…, m…–m… → N block(s), ~M tokens saved.]`
 *     —— `→ N block(s)` 即实际创建块数证据；
 *   · PARTIAL 回执为 `[acp-result: PARTIAL — N block(s) created; some requested range(s)
 *     were NOT folded. Retry ONLY the failed range(s) listed above; do not re-fold the
 *     ranges that were applied.]`（dsh-native.js:128 partialOutcomeNote 固定全文，
 *     整行端到端锚定，见 compress-probe.mjs PARTIAL_BLOCKS_PATTERN）。
 *   两种已证实格式之外的文本不解析（不猜 COMPRESSED 字样即成功）。
 * - 归一化事件附带 `seq`（宿主会话事件的单调序号），供探针做跨重启去重水位。
 */
import { blocksFromReceiptText } from "./compress-probe.mjs";

/** 直接模式写工具名集合（isConcurrencySafe=false）。 */
const WRITE_TOOLS = new Set([
  "soul_update",
  "memory_append",
  "memory_rewrite",
  "core_write",
  "topic_append",
]);

function asInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 从 PTC dispatch 的 content（文本块数组或字符串）提取已证实格式的块计数。 */
function blocksFromContent(content) {
  if (typeof content === "string") return blocksFromReceiptText(content);
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block && typeof block === "object" && typeof block.text === "string") {
      const blocks = blocksFromReceiptText(block.text);
      if (blocks !== undefined) return blocks;
    }
  }
  return undefined;
}

/**
 * 合并数值元数据与文本证据；两者同时存在且矛盾 → {metaConflict:true}（不带数值，
 * 探针保守不推进）。一致或单边存在时返回实际块数。
 */
function reconcileBlockEvidence(numeric, fromText) {
  if (numeric !== undefined && fromText !== undefined && numeric !== fromText) {
    return { metaConflict: true };
  }
  const blocks = numeric !== undefined ? numeric : fromText;
  return blocks !== undefined ? { blocksCreated: blocks } : {};
}

/**
 * 把原始 DSH 会话事件映射为桥的归一化完成事件；无法归因时返回 null（不猜测）。
 * 归一化事件附带 seq（宿主会话事件单调序号，探针跨重启去重水位用）与
 * callId（底层调用身份，direct/PTC 双报告去重用）。
 * @param {object} session 携带 id 的会话对象
 * @param {object} event   DSH 会话事件（type/seq/data）
 * @param {Map<string,string>} callNames callId -> tool name（直接模式归因用；跨事件保持）
 * @returns {object|null} {eventId, sessionId, name, success, blocksCreated?, callId?, metaConflict?, seq} 或 null
 */
export function mapRawSessionEvent(session, event, callNames) {
  if (!session || typeof session.id !== "string" || session.id.length === 0) return null;
  if (!event || typeof event.type !== "string" || !Number.isInteger(event.seq)) return null;
  const sessionId = session.id;
  const data = event.data ?? {};

  if (event.type === "tool/call") {
    if (typeof data.callId === "string" && typeof data.name === "string") {
      callNames.set(`${sessionId}:${data.callId}`, data.name);
    }
    return null; // 调用开始事件不是完成事件
  }

  if (event.type === "tool/result") {
    // 调用身份容错解析（真实 desktop 宿主的 tool message 没有 message.callId）：
    // message.callId（旧/合成形状）→ message.toolCallId（desktop 实测）→ message.source.callId。
    // 只接受非空字符串；三者都缺失/均非字符串时保持「无法归因 → null」，不猜。
    const callId = [data.message?.callId, data.message?.toolCallId, data.message?.source?.callId]
      .find((value) => typeof value === "string" && value.length > 0);
    const name = typeof callId === "string" ? callNames.get(`${sessionId}:${callId}`) : undefined;
    if (name === undefined) return null; // 无法归因（例如恢复重放缺 call 事件）：不猜
    const metaBlocks = asInt(data.meta?.blocksCreated);
    // 直接模式文本回执按同一套整行锚定格式解析（格式证据见 docs/completion/README.md §1.4；
    // 直接模式出现该格式的实测样本缺失，仅在有完整锚定回执时才采信）。
    const evidence = reconcileBlockEvidence(metaBlocks, blocksFromContent(data.message?.content));
    return {
      eventId: `${sessionId}:tool/result:${event.seq}`,
      sessionId,
      name,
      success: data.message?.isError !== true,
      callId,
      ...evidence,
      seq: event.seq,
    };
  }

  if (event.type === "tool/ptc-dispatch") {
    // PTC 子调用完成：name/isError 来自事件 data；块证据优先数值字段，
    // 其次整行锚定的已证实文本格式（成功 `[Compressed … → N block(s), …]`、PARTIAL）。
    // 数值与文本矛盾 → metaConflict（保守不推进）。
    if (typeof data.name !== "string" || data.name.length === 0) return null;
    const numeric = asInt(data.blocksCreated);
    const evidence = reconcileBlockEvidence(numeric, blocksFromContent(data.content));
    // 底层调用身份：parentCallId 关联 direct tool/call 的 callId（同一次 compress 调用
    // 的 direct 结果与 PTC 完成据此去重）；缺失时退化 rootCallId / subCallId。
    const ptcCallId = [data.parentCallId, data.rootCallId, data.subCallId]
      .find((v) => typeof v === "string" && v.length > 0);
    return {
      eventId: `${sessionId}:tool/ptc-dispatch:${event.seq}`,
      sessionId,
      name: data.name,
      success: data.isError !== true,
      ...(ptcCallId !== undefined ? { callId: ptcCallId } : {}),
      ...evidence,
      seq: event.seq,
    };
  }

  return null;
}

/**
 * 构造真实 DSH 的 host 抽象。
 * @param {object} pluginCtx cordis 插件上下文（systemPrompt / tools / on）
 * @param {object} [options]
 * @param {string|null} [options.trustedScopeId] 由部署方（宿主配置）指定的可信 scope；不来自工具 payload
 * @param {() => Promise<object>} [options.loadDshTools] 注入 "@deepseek-ai/dsh-tools" 的加载器（测试用）
 */
export function createDshHostAbstraction(pluginCtx, { trustedScopeId = null, loadDshTools } = {}) {
  if (!pluginCtx || typeof pluginCtx !== "object") {
    const error = new Error("pluginCtx must be an object"); error.code = "INVALID_INPUT"; throw error;
  }
  for (const field of ["systemPrompt", "tools", "on"]) {
    if (pluginCtx[field] === undefined) {
      const error = new Error(`pluginCtx.${field} is required for the DSH adapter`);
      error.code = "INVALID_INPUT";
      throw error;
    }
  }

  /** 直接模式 tool/result 归因表（callId -> name）。 */
  const callNames = new Map();
  const droppedEvents = [];
  /** 完成事件派发：在途监听器 Promise 与失败记录（flushCompletedTools 排空用）。 */
  const inFlight = new Set();
  const listenerFailures = [];
  let dispatched = 0;
  /** 返回值不是 Promise 的派发次数：适配层无法跟踪其完成（排空缺口，如实披露）。 */
  let untrackedDispatches = 0;
  /** 归一化失败被丢弃的事件数（attempt 3：对 flush/diagnostics 可见，不再只进 droppedEvents）。 */
  let normalizeFailures = 0;
  /** 监听器同步抛出的派发次数（attempt 3：显式计数，与 failures 清单可交叉核对）。 */
  let syncListenerFailures = 0;

  const capabilities = {
    systemPromptSection: true,
    tools: true,
    sessionEvents: true,
    // 真实宿主 section text 仅见到同步用法（soul-md / harness-dev-context）⇒ 快照模式。
    asyncSectionText: false,
    ptcDispatchEvents: true,
    // 完成事件回调排空：flushCompletedTools() 可用（D 排空顺序依赖）。
    completedToolFlush: true,
    // preparedCall.systemPromptUpdate 的实际取值只能在运行时请求准备阶段确定，静态不可证实。
    inHistory: "unverified",
    // 直接模式 tool/result 无数值块证据（静态不可证实）；PTC 模式为 P0 证据路径。
    directCompressBlockEvidence: "unverified",
  };

  return {
    capabilities,

    registerSystemSection({ name, order, text }) {
      // 真实宿主：函数式 text，每次 assemble 求值（快照由桥维护，见模块注释）。
      const disposer = pluginCtx.systemPrompt.section({
        name,
        order,
        text,
        interpolate: false,
      });
      return typeof disposer === "function" ? disposer : disposer?.dispose ?? (() => {});
    },

    async registerTool(tool) {
      let defineTool;
      try {
        const mod = loadDshTools
          ? await loadDshTools()
          : await import("@deepseek-ai/dsh-tools");
        defineTool = mod.defineTool;
      } catch (error) {
        const failure = new Error(
          `DSH adapter requires "@deepseek-ai/dsh-tools" (not resolvable here): ${error instanceof Error ? error.message : String(error)}`,
        );
        failure.code = "UNSUPPORTED";
        throw failure;
      }
      const registered = pluginCtx.tools.register(defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        isConcurrencySafe: () => !WRITE_TOOLS.has(tool.name),
        // P5：真实 defineTool 直接读取 options.output.render（lib/index.js:842）；
        // 携带 outputSchema 的工具（controller 路径）透传真实 schema/render。
        ...(tool.outputSchema !== undefined
          ? {
            output: {
              schema: tool.outputSchema,
              render: typeof tool.outputRender === "function"
                ? tool.outputRender
                : (_args, value) => JSON.stringify(value),
            },
          }
          : {}),
        async execute(args, exec) {
          // 会话归属证据：exec.agent.session.id（dsh-native.js:131 同款）。
          // P0 工具不使用 per-call sessionId 定位 scope：scope 由宿主 factory 注入 service。
          return tool.execute(args, exec);
        },
        presentCall: (args) => ({ card: "generic", title: tool.name, kind: "other", rawInput: args }),
      }));
      return typeof registered === "function" ? registered : registered?.dispose ?? (() => {});
    },

    subscribeCompletedTools(listener) {
      if (typeof listener !== "function") {
        const error = new Error("listener must be a function"); error.code = "INVALID_INPUT"; throw error;
      }
      // ctx.on 返回 disposer（dsh-agent-loop lib/index.js:976 同款用法）。
      // 监听器可返回 Promise：在途回调被跟踪，flushCompletedTools() 等待并报告失败；
      // 返回值不是 Promise 的旧式监听器保持 fire-and-forget（旧签名兼容）。
      const disposer = pluginCtx.on("session/event", (session, event) => {
        let normalized;
        try {
          normalized = mapRawSessionEvent(session, event, callNames);
        } catch (error) {
          normalizeFailures += 1;
          droppedEvents.push(`normalize failed at seq=${event?.seq}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (normalized === null) return;
        dispatched += 1;
        let result;
        try {
          result = listener(normalized);
        } catch (error) {
          syncListenerFailures += 1;
          listenerFailures.push(`listener threw synchronously at seq=${normalized.seq}: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        if (result !== undefined && result !== null && typeof result.then === "function") {
          const tracked = result.then(() => {}, (error) => {
            listenerFailures.push(`listener rejected at seq=${normalized.seq}: ${error instanceof Error ? error.message : String(error)}`);
          }).finally(() => {
            inFlight.delete(tracked);
          });
          inFlight.add(tracked);
        } else {
          // 契约要求监听器返回对应处理 Promise（CONTRACTS.md「D」）。不返回的派发
          // 无法被排空 —— 如实计数，flush 报告 untrackedDispatches，不静默。
          untrackedDispatches += 1;
        }
      });
      return typeof disposer === "function" ? disposer : disposer?.dispose ?? (() => {});
    },

    /**
     * 等待全部已派发的监听器回调（含失败）排空。停流排空顺序（与 D 运行时协作）：
     * 先撤销订阅（禁止新事件）→ await host.flushCompletedTools() → 再 flush/close 状态句柄。
     * @returns {Promise<{waited:number, failures:string[], dispatched:number,
     *           untrackedDispatches:number, normalizeFailures:number, syncListenerFailures:number}>}
     *   waited：本次等待的在途回调数；failures：自上次 flush 以来的失败清单（返回后清零）；
     *   untrackedDispatches：累计的"监听器未返回 Promise"派发数（这些回调无法被本方法等待，
     *   排空不完整时必须 >0 —— 契约形状的监听器（返回 Promise）恒为可排空）；
     *   normalizeFailures / syncListenerFailures：累计的归一化失败 / 同步抛出派发数
     *   （attempt 3：两条拒绝路径对 flush 显式可见，不再只散落在 droppedEvents）。
     */
    async flushCompletedTools() {
      const pending = [...inFlight];
      await Promise.all(pending);
      const failures = [...listenerFailures];
      listenerFailures.length = 0;
      return {
        waited: pending.length,
        failures,
        dispatched,
        untrackedDispatches,
        normalizeFailures,
        syncListenerFailures,
      };
    },

    getSessionInfo() {
      // 插件级上下文没有固定会话；per-call sessionId 由 exec.agent.session.id 提供（见 execute）。
      // scopeId 只来自部署方显式配置（可信来源），绝不来自工具 payload。
      return {
        sessionId: null,
        scopeId: trustedScopeId,
        capabilities,
      };
    },

    diagnostics() {
      return {
        droppedEvents: [...droppedEvents],
        callNamesTracked: callNames.size,
        dispatchedEvents: dispatched,
        listenerFailuresPending: listenerFailures.length,
        inFlightListeners: inFlight.size,
        untrackedDispatches,
        normalizeFailures,
        syncListenerFailures,
      };
    },
  };
}

/**
 * 完整插件装配（薄封装，不自动启动、不装载进真实 profile —— 由部署方人工决策）。
 * @param {object} [options]
 * @param {object} [options.probeSink] 完成状态持久化槽（openCompletionState 句柄的 sink），
 *     原样转交 createHostBridge（见 CONTRACTS.md「D」），本函数不解释、不缓存、不落盘。
 * @returns {{host, bridge, start: () => Promise, stop: () => object}}
 */
export async function assembleDshShioriHost(pluginCtx, { service, config, mode = "shadow", trustedScopeId, loadDshTools, probeSink } = {}) {
  const { createHostBridge } = await import("./index.mjs");
  const host = createDshHostAbstraction(pluginCtx, { trustedScopeId, loadDshTools });
  const bridge = createHostBridge({ host, service, mode, config, probeSink });
  return {
    host,
    bridge,
    start: () => bridge.start(),
    stop: () => bridge.stop(),
  };
}
