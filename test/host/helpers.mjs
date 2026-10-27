/**
 * 测试夹具：可编程的 fake host 与带真实 CAS 语义的 fake service。
 * 只用合成数据；不读写真实记忆，不联网。
 */
import { INVALID_STATE, REVISION_CONFLICT } from "../../src/host/errors.mjs";

/** 计算 fake revision：内容变化则 revision 变化（模拟内容哈希语义，不真算 SHA256）。 */
function rev(text, generation) {
  return text === "" ? null : `rev-${generation}-${text.length}`;
}

/**
 * fake service：实现 C 桥所需的完整接口；mutate 具备真 CAS（expectedRevision 不匹配即冲突）。
 * mutateLog 记录每次调用，供「写全走 service/CAS」断言。
 */
export function createFakeService(initial = {}) {
  let personaGen = 0;
  let coreGen = 0;
  const topics = new Map(); // key -> {key,title,summary,scopeId,revision,updated,body}
  let topicGen = 0;

  const persona = {
    name: initial.personaName ?? "琥珀",
    text: initial.personaText ?? "# 琥珀\n你是琥珀。",
  };
  persona.revision = rev(persona.text, ++personaGen);

  const core = {
    scopeId: initial.scopeId ?? "amber",
    text: initial.coreText ?? "## 铁律\n不要删用户的文件。",
  };
  core.revision = rev(core.text, ++coreGen);

  for (const topic of initial.topics ?? []) {
    topics.set(topic.key, {
      scopeId: core.scopeId,
      updated: "2026-10-01",
      ...topic,
      revision: rev(topic.body ?? "", ++topicGen),
    });
  }

  const mutateLog = [];

  function indexFor() {
    if (topics.size === 0) return "";
    const lines = [...topics.values()]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((t) => `- ${t.key} [${t.scopeId}] — ${t.summary}`);
    return `## 主题记忆索引 / Topic memory index\n${lines.join("\n")}`;
  }

  async function mutate(request) {
    if (!request || typeof request !== "object" || !Array.isArray(request.changes)) {
      throw INVALID_STATE("fake service: request.changes required", {});
    }
    const applied = [];
    // 先整体校验再应用（模拟 B 的 prepare/commit）。
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
        const topic = topics.get(change.key);
        const current = topic?.revision ?? null;
        if ((change.expectedRevision ?? null) !== current) {
          throw REVISION_CONFLICT(`topic ${change.key} revision mismatch: expected ${change.expectedRevision}, current ${current}`, {});
        }
        return change;
      }
      throw INVALID_STATE(`fake service: unsupported change kind ${change.kind}`, {});
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
        const before = existing?.revision ?? null;
        const next = {
          ...(existing ?? {
            key: change.key,
            title: change.topic?.title ?? change.key,
            summary: change.topic?.summary ?? "",
            updated: "2026-10-24",
          }),
          ...(change.topic ?? {}),
          body: change.text,
          revision: rev(change.text, ++topicGen),
        };
        topics.set(change.key, next);
        applied.push({ kind: "topic", key: change.key, beforeRevision: before, afterRevision: next.revision, scope: next.scopeId });
      }
    }
    mutateLog.push({ request: JSON.parse(JSON.stringify(request)), applied });
    return {
      operationId: request.operationId,
      generation: `gen-${mutateLog.length}`,
      changes: applied,
      budget: { evaluated: true },
    };
  }

  return {
    // C 契约要求的接口
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
    // 测试辅助
    async readCore() {
      return { text: core.text, revision: core.revision, scopeId: core.scopeId };
    },
    mutateLog,
    state: {
      get persona() { return persona; },
      get core() { return core; },
      get topics() { return topics; },
    },
  };
}

/**
 * fake host：记录全部注册；emit 派发完成事件；可注入“已被他人注册”的名字制造冲突。
 */
export function createFakeHost({ asyncSectionText = true, preOwnedTools = [], preOwnedSections = [], failToolRegistration = false } = {}) {
  const sections = new Map();
  const tools = new Map();
  const listeners = new Set();

  return {
    capabilities: { asyncSectionText },
    registerSystemSection({ name, order, text }) {
      sections.set(name, { order, text });
      return () => sections.delete(name);
    },
    registerTool(tool) {
      if (failToolRegistration) {
        throw new Error(`${tool.name} already registered by another provider`);
      }
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
    subscribeCompletedTools(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSessionInfo() {
      return { sessionId: "sess-fixture", scopeId: "amber", capabilities: { asyncSectionText } };
    },
    listRegisteredTools() {
      return [...tools.keys(), ...preOwnedTools];
    },
    listRegisteredSections() {
      return [...sections.keys(), ...preOwnedSections];
    },
    // 测试辅助
    async emit(event) {
      for (const listener of [...listeners]) await listener(event);
    },
    listenerCount: () => listeners.size,
    async renderSection(name) {
      const section = sections.get(name);
      if (!section) return undefined;
      return typeof section.text === "function" ? await section.text({ agent: { session: { id: "sess-fixture" } } }) : section.text;
    },
    sections,
    tools,
  };
}

export const ACTIVE_CONFIG = { hostBridge: { allowActive: true } };
