/**
 * Shiori P1-ACCEPTANCE — 标明 synthetic 的注入替身（D/E 未接入时的可运行参考实现）。
 *
 * 【synthetic 边界 —— 不得冒充真实宿主】
 * - createSyntheticRuntimeFactory 组合的是【真实基线】createHostBridge 与合成 host/service，
 *   事件是手造的，宿主是假的：它验证的是矩阵/桥/探针逻辑，绝不是真实 DSH 出站。
 * - createSyntheticCompletionFactory 只做「同进程二次打开」级别的持久化（JSON 文件），
 *   没有 E 的跨进程互斥 owner；用它产出的证据永远 evidenceType=synthetic。
 * - 任何由本文件工厂产出的 bundle 都不得把 isolated-dsh 写进 case；validateEvidenceBundle
 *   也会拒绝这种越级标签。
 */
import { INVALID_INPUT, INVALID_STATE, REVISION_CONFLICT } from "../host/errors.mjs";
import { createHostBridge } from "../host/index.mjs";
import { createJsonFileSink } from "../host/compress-probe.mjs";
import path from "node:path";

/** 计算合成 revision：内容变化则 revision 变化（与 test/host 夹具同思路）。 */
function rev(text, generation) {
  return text === "" ? null : `synth-rev-${generation}-${text.length}`;
}

/**
 * 合成 service：CAS 写 + operationId 幂等重放 + 派生主题索引。
 * 仅为矩阵提供可注入的真实语义形状；不含磁盘存储/跨进程锁。
 */
export function createSyntheticService(initial = {}) {
  let personaGen = 0;
  let coreGen = 0;
  let topicGen = 0;
  let writeCount = 0;

  const persona = {
    name: initial.personaName ?? "合成人设（synthetic）",
    text: initial.personaText ?? "# 合成人设\n这是验收矩阵的合成 L0 文本，不含真实记忆。",
  };
  persona.revision = rev(persona.text, ++personaGen);

  const core = {
    scopeId: initial.scopeId ?? "scope-matrix",
    text: initial.coreText ?? "## 合成铁律\n这是验收矩阵的合成 L1 正文。",
  };
  core.revision = rev(core.text, ++coreGen);

  const topics = new Map();
  for (const topic of initial.topics ?? []) {
    topics.set(topic.key, {
      scopeId: core.scopeId,
      updated: "2026-10-24",
      ...topic,
      revision: rev(topic.body ?? "", ++topicGen),
    });
  }

  const operationLog = new Map(); // operationId -> {payloadKey, result}
  const mutateLog = [];

  function indexFor() {
    if (topics.size === 0) return "";
    const lines = [...topics.values()]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((t) => `- ${t.key} [${t.scopeId}] — ${t.summary}`);
    return `## 主题记忆索引 / Topic memory index\n${lines.join("\n")}`;
  }

  async function mutate(request) {
    if (!request || typeof request !== "object" || !Array.isArray(request.changes) || typeof request.operationId !== "string" || request.operationId.length === 0) {
      throw INVALID_INPUT("synthetic service: request requires operationId and changes[]", {});
    }
    // 同 operationId + 同 payload → 稳定重放；同 operationId + 不同 payload → 拒绝（身份漂移）。
    const payloadKey = JSON.stringify(request.changes);
    const previous = operationLog.get(request.operationId);
    if (previous) {
      if (previous.payloadKey !== payloadKey) {
        throw INVALID_STATE(`operationId "${request.operationId}" was already used with a different payload; durable replay identity drift`, {});
      }
      return previous.result;
    }
    writeCount += 1;
    const applied = [];
    const checked = request.changes.map((change) => {
      if (change.kind === "persona") {
        if ((change.expectedRevision ?? null) !== (persona.text === "" ? null : persona.revision)) {
          throw REVISION_CONFLICT(`persona revision mismatch: expected ${change.expectedRevision}, current ${persona.revision}`, {});
        }
        return change;
      }
      if (change.kind === "core") {
        if ((change.expectedRevision ?? null) !== core.revision) {
          throw REVISION_CONFLICT(`core revision mismatch: expected ${change.expectedRevision}, current ${core.revision}`, {});
        }
        return change;
      }
      if (change.kind === "topic") {
        const current = topics.get(change.key)?.revision ?? null;
        if ((change.expectedRevision ?? null) !== current) {
          throw REVISION_CONFLICT(`topic ${change.key} revision mismatch: expected ${change.expectedRevision}, current ${current}`, {});
        }
        return change;
      }
      throw INVALID_INPUT(`synthetic service: unsupported change kind ${change.kind}`, {});
    });
    for (const change of checked) {
      if (change.kind === "persona") {
        const before = persona.revision;
        persona.text = change.text;
        persona.revision = rev(persona.text, ++personaGen);
        applied.push({ kind: "persona", beforeRevision: before, afterRevision: persona.revision, scope: core.scopeId });
      } else if (change.kind === "core") {
        const before = core.revision;
        core.text = change.text;
        core.revision = rev(core.text, ++coreGen);
        applied.push({ kind: "core", beforeRevision: before, afterRevision: core.revision, scope: core.scopeId });
      } else if (change.kind === "topic") {
        const existing = topics.get(change.key);
        const next = {
          ...(existing ?? { key: change.key, title: change.topic?.title ?? change.key, summary: change.topic?.summary ?? "", updated: "2026-10-24" }),
          ...(change.topic ?? {}),
          body: change.text,
          revision: rev(change.text, ++topicGen),
        };
        topics.set(change.key, next);
        applied.push({ kind: "topic", key: change.key, beforeRevision: existing?.revision ?? null, afterRevision: next.revision, scope: next.scopeId });
      }
    }
    mutateLog.push({ operationId: request.operationId, applied });
    const result = {
      operationId: request.operationId,
      generation: `synth-gen-${mutateLog.length}`,
      changes: applied,
      budget: { evaluated: true },
    };
    operationLog.set(request.operationId, { payloadKey, result });
    return result;
  }

  return {
    async readPersona() {
      return { name: persona.name, text: persona.text, revision: persona.revision };
    },
    async readCoreView() {
      const view = core.text.length > 0 && indexFor().length > 0
        ? `${core.text}\n\n${indexFor()}`
        : `${core.text}${indexFor()}`;
      return { text: view, revision: core.revision, scopeId: core.scopeId };
    },
    async readTopic(key) {
      const topic = topics.get(key);
      if (!topic) throw INVALID_STATE(`topic "${key}" does not exist`, { key });
      return { ...topic };
    },
    async listTopics() {
      return [...topics.values()].map((t) => ({ ...t }));
    },
    async search(query) {
      const hits = [];
      for (const t of topics.values()) {
        if (`${t.title}${t.summary}${t.body}`.includes(query)) {
          hits.push({ key: t.key, title: t.title, summary: t.summary, scopeId: t.scopeId, score: 1 });
        }
      }
      return hits;
    },
    mutate,
    async readCore() {
      return { text: core.text, revision: core.revision, scopeId: core.scopeId };
    },
    getWriteCount() {
      return writeCount;
    },
    mutateLog,
  };
}

/**
 * 合成 host：记录全部注册并暴露 listSections/getTool/listToolNames（矩阵投影契约）。
 * capabilities.asyncSectionText=true：section 每次渲染直接读 service（无同步快照窗口）。
 * 另维护可观测资源计数器（resources()）：stop-cleanup 案例据此断言真实 dispose，
 * 而不只是看注册表 Map 还剩什么。
 */
export function createSyntheticHost({ preOwnedTools = [], includeTopics = false } = {}) {
  const sections = new Map();
  const tools = new Map();
  const listeners = new Set();
  const owned = new Set(preOwnedTools);
  const resourceCounters = {
    sectionsRegistered: 0,
    sectionsDisposed: 0,
    toolsRegistered: 0,
    toolsDisposed: 0,
    subscriptionsAdded: 0,
    subscriptionsDisposed: 0,
  };

  return {
    capabilities: {
      asyncSectionText: true,
      synthetic: true,
      includeTopics,
    },
    registerSystemSection({ name, order, text }) {
      sections.set(name, { name, order, text });
      resourceCounters.sectionsRegistered += 1;
      return () => {
        const existed = sections.delete(name);
        if (existed) resourceCounters.sectionsDisposed += 1;
        return existed;
      };
    },
    registerTool(tool) {
      if (owned.has(tool.name)) {
        const error = new Error(`${tool.name} already registered by another provider`);
        throw error;
      }
      tools.set(tool.name, tool);
      resourceCounters.toolsRegistered += 1;
      return () => {
        const existed = tools.delete(tool.name);
        if (existed) resourceCounters.toolsDisposed += 1;
        return existed;
      };
    },
    subscribeCompletedTools(listener) {
      listeners.add(listener);
      resourceCounters.subscriptionsAdded += 1;
      return () => {
        const existed = listeners.delete(listener);
        if (existed) resourceCounters.subscriptionsDisposed += 1;
        return existed;
      };
    },
    getSessionInfo() {
      return { sessionId: "sess-synthetic", scopeId: "scope-matrix", capabilities: { asyncSectionText: true } };
    },
    // —— 矩阵投影契约（docs/acceptance/README.md）——
    listSections() {
      return [...sections.values()];
    },
    listToolNames() {
      return [...tools.keys()];
    },
    getTool(name) {
      return tools.get(name);
    },
    // —— 可观测资源计数器（stop-cleanup 与失败 start 清理的断言依据）——
    resources() {
      return {
        ...resourceCounters,
        activeSections: sections.size,
        activeTools: tools.size,
        activeListeners: listeners.size,
      };
    },
    // 测试辅助
    listenerCount: () => listeners.size,
  };
}

/**
 * 合成 runtime 工厂：组合真实 createHostBridge 与上述合成件，返回 D 契约形状。
 * @param {object} [options]
 * @param {"shadow"|"active"} [options.mode="shadow"]
 * @param {object} [options.config]
 * @param {{sink: {load, save}, flush?, close?}} [options.completionHandle] E 形状句柄（其 sink 作 probeSink）
 * @param {string[]} [options.preOwnedTools] 预置“已被他人注册”的工具名（冲突 case）
 * @param {boolean} [options.includeTopics] 注入合成主题（派生索引）
 * @param {{personaText?: string, coreText?: string, topics?: Array<object>}} [options.fixture]
 *     矩阵独立夹具：提供时 service 的种子内容取自夹具（矩阵用它构造独立期望字节，
 *     不再从 service 返回值反推期望 —— 反馈 B1）。工厂必须按夹具原样播种。
 */
export async function createSyntheticRuntimeFactory(options = {}) {
  const {
    mode = "shadow",
    config = {},
    completionHandle,
    preOwnedTools = [],
    includeTopics = false,
    fixture,
  } = options;
  if (mode !== "shadow" && mode !== "active") {
    throw INVALID_INPUT(`synthetic runtime factory: mode must be shadow|active, got ${JSON.stringify(mode)}`, {});
  }
  if (typeof preOwnedTools === "string") {
    throw INVALID_INPUT("synthetic runtime factory: preOwnedTools must be an array of names", {});
  }
  if (fixture !== undefined && (fixture === null || typeof fixture !== "object" || Array.isArray(fixture))) {
    throw INVALID_INPUT("synthetic runtime factory: fixture must be an object when provided", {});
  }
  const service = createSyntheticService({
    personaText: fixture?.personaText,
    coreText: fixture?.coreText,
    topics: fixture?.topics
      ?? (includeTopics
        ? [
          { key: "matrix-topic-a", title: "矩阵主题A", summary: "合成主题A摘要", body: "## 2026-10-24 — 合成\n矩阵主题A的合成正文。" },
          { key: "matrix-topic-b", title: "矩阵主题B", summary: "合成主题B摘要", body: "## 2026-10-24 — 合成\n矩阵主题B的合成正文。" },
        ]
        : []),
  });
  const host = createSyntheticHost({ preOwnedTools, includeTopics });
  const probeSink = completionHandle?.sink;
  if (completionHandle && (!probeSink || typeof probeSink.load !== "function" || typeof probeSink.save !== "function")) {
    throw INVALID_INPUT("completionHandle.sink must provide load()/save() (E contract)", {});
  }
  const bridge = createHostBridge({ host, service, mode, config, probeSink });
  return {
    start: () => bridge.start(),
    stop: () => bridge.stop(),
    refresh: () => bridge.refresh(),
    diagnostics: () => bridge.diagnostics(),
    service,
    bridge,
    host,
  };
}

/**
 * 合成 completion 工厂：JSON 文件持久化（同进程二次打开级别），无跨进程互斥。
 * 返回 E 契约形状 {sink, flush, close, diagnostics}；close 后 save 明确拒绝。
 */
export function createSyntheticCompletionFactory() {
  return async function openSyntheticCompletionState({ root, scopeId }) {
    if (typeof root !== "string" || root.length === 0 || !path.isAbsolute(root)) {
      throw INVALID_INPUT("synthetic completion state requires an absolute root", { root });
    }
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      throw INVALID_INPUT("synthetic completion state requires a non-empty scopeId", {});
    }
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const filePath = path.join(root, `${scopeId}.synthetic-state.json`);
    const sink = createJsonFileSink(filePath);
    let closed = false;
    let saving = Promise.resolve();
    return {
      synthetic: true,
      sink: {
        async load() {
          if (closed) throw INVALID_STATE("completion state is closed; load is rejected", {});
          return sink.load();
        },
        async save(snapshot) {
          if (closed) throw INVALID_STATE("completion state is closed; save is rejected", {});
          saving = saving.then(() => sink.save(snapshot));
          await saving;
        },
      },
      async flush() {
        await saving;
        // Windows 无目录 fsync：此处不做、也不宣称；详见 docs/acceptance/README.md。
        return { flushed: true, directoryFsync: "unsupported-on-windows-not-claimed" };
      },
      async close() {
        if (closed) return { alreadyClosed: true };
        await saving; // 等待进行中的保存
        closed = true;
        return { closed: true };
      },
      diagnostics() {
        return { synthetic: true, root, scopeId, closed, filePath: path.basename(filePath) };
      },
    };
  };
}
