/**
 * Shiori host bridge — 兼容工具（P0）。
 *
 * 覆盖 CONTRACTS.md 要求的最小集合：soul_read / soul_update、memory_read / search /
 * append / rewrite、core_write、topic_append、memory_list_topics。
 *
 * 硬边界：
 * - 读 payload 一律不接受 scope 参数（scope 只能来自宿主可信来源注入 service 的 factory）；
 * - 所有写都委托 service.mutate（即 B 的 commit），携带 expectedRevision 做 CAS，绝不绕过；
 * - 旧工具（soul_update / memory_append / memory_rewrite / topic_append）没有 expectedRevision
 *   入参：执行时先经 service 读当前版本，再以读到的真实 revision 发起 CAS（read-then-CAS），
 *   不假造 revision。读与 CAS 之间的窗口由 B 的跨进程锁 + CAS 兜底（冲突即 REVISION_CONFLICT）。
 * - persona 的独立 CAS 持久化由后续集成 service 实现；本模块只以 kind:"persona" 委托并
 *   用测试 stub 验证（已知依赖，见 REPORT.md）。
 * - 工具回执的投影状态恒为 "written-pending-projection"（已落盘、待下一次请求投影）：
 *   桥不预测下一次请求，不提前回报「已生效」。
 * - 不静默截断：memory_read 返回全文，无 truncated 逻辑（与 soul-md 的 20000 字符截断不同，
 *   属有意分歧，见 REPORT.md）。
 */
import { randomUUID } from "node:crypto";
import { INVALID_INPUT, UNSUPPORTED } from "./errors.mjs";
import { TOOL_OUTPUT_SCHEMAS, renderToolOutput } from "../plugin/tool-schemas.mjs";

/** 宿主 system 的 section 名（与 soul-md 的 soul:persona/soul:memory 不同名，便于唯一写者判定）。 */
export const SECTION_PERSONA = "shiori:persona";
export const SECTION_CORE = "shiori:core";

/** config 缺省时的 persona 上限兜底；正式值以注入的已校验 config 为准。 */
const FALLBACK_PERSONA_MAX_CHARS = 12000;

function requireObject(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw INVALID_INPUT("tool arguments must be an object", { received: typeof args });
  }
  return args;
}

/** 读 payload 不接受任意 scope：schema 不暴露，payload 混入也拒绝。 */
function rejectScope(args) {
  if (args.scope !== undefined) {
    throw INVALID_INPUT("scope cannot be passed in tool payloads; scope comes from the trusted host factory", {});
  }
}

function requireString(args, field, { allowEmpty = false } = {}) {
  const value = args[field];
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw INVALID_INPUT(`\`${field}\` must be a non-empty string`, { field });
  }
  return value;
}

function optionalString(args, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw INVALID_INPUT(`\`${field}\` must be a string when present`, { field });
  }
  return value;
}

function byteLen(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 旧 soul-md 工具的 topic 参数解析（与 memory-layout.js:27-31 normalizeMemoryTopic 对齐）：
 * 缺省/空 → core；`core` / `core.md`（大小写不敏感，trim 后）→ core；其余为 topic key。
 * DESIGN.md §10：core、core.md 是保留别名，真实 topic key 不得与之冲突。
 */
export function resolveTopicArg(value) {
  const topic = String(value ?? "").trim();
  if (!topic || /^(core|core\.md)$/i.test(topic)) return null; // null = core 路径
  return topic;
}

/** 与 soul-md memory_append 一致的日期标题格式。 */
export function datedHeading(section, date) {
  const d = date ?? new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `## ${stamp} — ${section}`;
}

/** 拼接追加块；空正文不加前导换行。 */
export function appendBlock(existingText, section, content, date) {
  const block = `\n${datedHeading(section, date)}\n\n${content}\n`;
  return existingText.length === 0 ? block.replace(/^\n/, "") : existingText + block;
}

/**
 * 统一从 mutate 回执构造工具回执。
 * 投影状态恒为 written-pending-projection：已落盘、待投影，绝不提前声称已生效。
 */
function writeReceipt(mutateResult, scopeFallback) {
  const changes = mutateResult.changes ?? [];
  const first = changes[0] ?? {};
  return {
    operationId: mutateResult.operationId,
    generation: mutateResult.generation,
    revision: first.afterRevision ?? null,
    scope: first.scope ?? scopeFallback ?? null,
    projection: "written-pending-projection",
    changes,
  };
}

/**
 * 构造兼容工具定义。
 * @param {object} deps
 * @param {object} deps.service 见 docs/host/README.md 的 service 契约
 * @param {() => {sessionId:string|null, scopeId:string|null}} [deps.getSessionInfo]
 * @param {object} [deps.config] 已校验配置（persona.maxChars 等）
 * @param {() => Date} [deps.now] 时钟注入
 */
export function createCompatTools({ service, getSessionInfo, config, now } = {}) {
  if (!service || typeof service.mutate !== "function") {
    throw INVALID_INPUT("service with mutate() is required", {});
  }
  const personaMaxChars = Number.isInteger(config?.persona?.maxChars) && config.persona.maxChars > 0
    ? config.persona.maxChars
    : FALLBACK_PERSONA_MAX_CHARS;
  const clock = now ?? (() => new Date());

  async function scopeIdOf() {
    try {
      return getSessionInfo?.()?.scopeId ?? null;
    } catch {
      return null;
    }
  }

  /** 核心写路径需要磁盘正文视图；渲染视图（含派生索引）绝不能回写。 */
  async function readDiskCore() {
    if (typeof service.readCore !== "function") {
      throw UNSUPPORTED(
        "core write paths require service.readCore() (disk body without the derived index); "
        + "the injected service does not provide it. Rendered views must never be written back.",
        {},
      );
    }
    return service.readCore();
  }

  const tools = [
    // ── L0 persona ────────────────────────────────────────────────────────
    {
      name: "soul_read",
      description: "Read the persona card active for the current scope, exactly as stored (Shiori bridge; delegates to the injected memory service).",
      inputSchema: {},
      outputSchema: TOOL_OUTPUT_SCHEMAS["soul_read"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const persona = await service.readPersona();
        return {
          exists: persona?.name != null && persona?.text != null,
          persona: persona?.name ?? "none",
          content: persona?.text ?? "",
          revision: persona?.revision ?? null,
        };
      },
    },
    {
      name: "soul_update",
      description: "Replace the active persona card with new content. CAS-protected: the bridge reads the current revision and commits through service.mutate; concurrent modifications are rejected instead of overwritten.",
      inputSchema: {
        content: { type: "string", required: true, description: "The complete new persona card (markdown)." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry (P5)." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["soul_update"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const content = requireString(a, "content");
        // DESIGN.md:110：L0 上限按 UTF-16 code units（content.length）计，UTF-8 bytes 仅作诊断。
        if (!content.isWellFormed()) {
          throw INVALID_INPUT("soul_update: content contains unpaired surrogates and would not survive lossless UTF-8 encoding", {});
        }
        if (content.length > personaMaxChars) {
          throw INVALID_INPUT(`soul_update: content exceeds persona.maxChars (${personaMaxChars} UTF-16 chars)`, {
            chars: content.length,
            bytes: byteLen(content),
            limit: personaMaxChars,
          });
        }
        const current = await service.readPersona();
        const result = await service.mutate({
          operationId: typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID(),
          changes: [{
            kind: "persona",
            text: content,
            expectedRevision: current?.revision ?? null,
          }],
        });
        return writeReceipt(result, await scopeIdOf());
      },
    },

    // ── L1 core 读取 ──────────────────────────────────────────────────────
    {
      name: "memory_read",
      description: "Read long-term memory. Without arguments returns the complete rendered L1 view (core body + derived topic index). With a topic key returns that topic's full body. Scope is fixed by the host; it cannot be passed.",
      inputSchema: {
        topic: { type: "string", description: "Optional topic key. Omit or pass core/core.md for the rendered core view (legacy alias)." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_read"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const topicArg = optionalString(a, "topic");
        const topic = resolveTopicArg(topicArg); // core / core.md / 空 → core 路径
        if (topic === null) {
          const view = await service.readCoreView();
          const text = view?.text ?? "";
          return {
            exists: text.length > 0,
            bytes: byteLen(text),
            truncated: false,
            source: view?.scopeId ?? null,
            topic: "",
            content: text,
            revision: view?.revision ?? null,
          };
        }
        const t = await service.readTopic(topic);
        return {
          exists: true,
          bytes: byteLen(t.body ?? ""),
          truncated: false,
          source: t.scopeId,
          topic: t.key,
          content: t.body ?? "",
          revision: t.revision,
        };
      },
    },

    // ── L2/L3 检索 ────────────────────────────────────────────────────────
    {
      name: "memory_search",
      description: "Keyword search over visible topics (and archived entries when the service exposes them). Returns keys, titles and summaries only; use memory_read(topic) for full text. Lexical search, not semantic matching.",
      inputSchema: {
        query: { type: "string", required: true, description: "Keywords or a short question." },
        limit: { type: "integer", description: "Maximum results, 1–20 (default 5)." },
        includeArchived: { type: "boolean", description: "Explicitly include archived (cold) spark cards. Always read-only; archived cards are never revived or re-matched automatically." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_search"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const query = requireString(a, "query");
        let limit = 5;
        if (a.limit !== undefined) {
          if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 20) {
            throw INVALID_INPUT("`limit` must be an integer between 1 and 20", { limit: a.limit });
          }
          limit = a.limit;
        }
        const matches = await service.search(query);
        const result = { matches: Array.isArray(matches) ? matches.slice(0, limit) : [] };
        if (a.includeArchived === true) {
          if (typeof service.searchArchived !== "function") {
            throw UNSUPPORTED(
              "memory_search includeArchived requires service.searchArchived() (cold-store reader); "
              + "the injected service does not provide it. Archived cards are never auto-searched.",
              {},
            );
          }
          const archived = await service.searchArchived(query);
          const merged = [
            ...result.matches,
            ...(Array.isArray(archived) ? archived : []).map((m) => ({ score: 0, ...m, state: "archived" })),
          ];
          result.matches = merged.slice(0, limit);
        }
        return result;
      },
    },

    // ── 追加 / 重写（旧工具：read-then-CAS）────────────────────────────────
    {
      name: "memory_append",
      description: "Append a dated Markdown block to memory in the CURRENT scope. Omit topic for the always-visible core body; pass a topic key for that topic file. The append is committed through service.mutate with CAS.",
      inputSchema: {
        section: { type: "string", required: true, description: "Short heading for the entry." },
        content: { type: "string", required: true, description: "The markdown text to remember." },
        topic: { type: "string", description: "Optional topic key. Omit or pass core/core.md for the core body (legacy alias)." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry (P5)." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_append"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const section = requireString(a, "section");
        const content = requireString(a, "content");
        const topic = resolveTopicArg(optionalString(a, "topic")); // core / core.md / 空 → core 路径
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        if (topic === null) {
          const current = await readDiskCore();
          const candidate = appendBlock(current.text ?? "", section, content, clock());
          const result = await service.mutate({
            operationId,
            changes: [{ kind: "core", text: candidate, expectedRevision: current.revision }],
          });
          return writeReceipt(result, current.scopeId);
        }
        const current = await service.readTopic(topic);
        const candidate = appendBlock(current.body ?? "", section, content, clock());
        const result = await service.mutate({
          operationId,
          changes: [{
            kind: "topic",
            key: current.key,
            text: candidate,
            expectedRevision: current.revision,
            topic: { title: current.title, summary: current.summary },
          }],
        });
        return writeReceipt(result, current.scopeId);
      },
    },
    {
      name: "memory_rewrite",
      description: "Replace one memory body in the CURRENT scope: omit topic for the core body, or pass a topic key to replace that topic's body (topic front-matter metadata is preserved by the service). Build the new content from memory_read output unless you deliberately drop entries.",
      inputSchema: {
        content: { type: "string", required: true, description: "The new full body content (markdown)." },
        topic: { type: "string", description: "Optional topic key. Omit or pass core/core.md for the core body (legacy alias)." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry (P5)." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_rewrite"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const content = requireString(a, "content", { allowEmpty: true });
        const topic = resolveTopicArg(optionalString(a, "topic")); // core / core.md / 空 → core 路径
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        if (topic === null) {
          const current = await readDiskCore();
          const result = await service.mutate({
            operationId,
            changes: [{ kind: "core", text: content, expectedRevision: current.revision }],
          });
          return writeReceipt(result, current.scopeId);
        }
        const current = await service.readTopic(topic);
        const result = await service.mutate({
          operationId,
          changes: [{
            kind: "topic",
            key: current.key,
            text: content,
            expectedRevision: current.revision,
            topic: { title: current.title, summary: current.summary },
          }],
        });
        return writeReceipt(result, current.scopeId);
      },
    },

    // ── 新式写工具（expectedRevision 必须显式给出）─────────────────────────
    {
      name: "core_write",
      description: "Replace the disk core body (L1, without the derived index). Pass the opaque revision from memory_read(); null only when no visible core exists. Global fallback is validated before an active-scope copy is created. The service enforces the complete rendered L1 budget.",
      inputSchema: {
        content: { type: "string", required: true, description: "The new core body (markdown)." },
        expectedRevision: {
          oneOf: [{ type: "string" }, { type: "null" }],
          required: true,
          description: "Opaque revision returned by memory_read() or the service. Do not parse or construct it. Null is allowed only when no visible core exists.",
        },
        operationId: { type: "string", description: "Client-supplied operation id for idempotent retry." },
        section: { type: "string", description: "NOT supported in P0; must be omitted." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["core_write"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const content = requireString(a, "content", { allowEmpty: true });
        const section = optionalString(a, "section");
        if (section !== undefined && section.length > 0) {
          throw UNSUPPORTED("core_write(section) is not supported in P0; rewrite the whole body instead", { section });
        }
        if (!("expectedRevision" in a)) {
          throw INVALID_INPUT("core_write requires explicit expectedRevision (string, or null for first creation)", {});
        }
        const expectedRevision = a.expectedRevision;
        if (expectedRevision !== null && typeof expectedRevision !== "string") {
          throw INVALID_INPUT("`expectedRevision` must be a string or null", { expectedRevision });
        }
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        const result = await service.mutate({
          operationId,
          changes: [{ kind: "core", text: content, expectedRevision }],
        });
        return writeReceipt(result, await scopeIdOf());
      },
    },
    {
      name: "topic_append",
      description: "Append a dated section to an L3 topic body. The topic must already exist (P0 does not create topics). Committed through service.mutate with CAS.",
      inputSchema: {
        topic: { type: "string", required: true, description: "Topic key." },
        section: { type: "string", required: true, description: "Short heading for the appended section." },
        content: { type: "string", required: true, description: "The markdown text to append." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry (P5)." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["topic_append"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const topicArg = requireString(a, "topic");
        if (resolveTopicArg(topicArg) === null) {
          throw INVALID_INPUT(
            `topic_append: "${topicArg}" is a reserved core alias; use core_write or memory_append/rewrite without a topic for the core body`,
            { topic: topicArg },
          );
        }
        const topic = topicArg;
        const section = requireString(a, "section");
        const content = requireString(a, "content");
        const current = await service.readTopic(topic);
        const candidate = appendBlock(current.body ?? "", section, content, clock());
        const result = await service.mutate({
          operationId: typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID(),
          changes: [{
            kind: "topic",
            key: current.key,
            text: candidate,
            expectedRevision: current.revision,
            topic: { title: current.title, summary: current.summary },
          }],
        });
        return writeReceipt(result, current.scopeId);
      },
    },

    // ── L3 目录枚举 ───────────────────────────────────────────────────────
    {
      name: "memory_list_topics",
      description: "List visible topics with size (characters and UTF-8 bytes of the body) for consolidation workflows. Does not return bodies; use memory_read(topic).",
      inputSchema: {},
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_list_topics"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const topics = await service.listTopics();
        return {
          topics: (Array.isArray(topics) ? topics : []).map((t) => ({
            key: t.key,
            title: t.title,
            summary: t.summary,
            scopeId: t.scopeId,
            revision: t.revision,
            updated: t.updated,
            chars: (t.body ?? "").length,
            bytes: byteLen(t.body ?? ""),
          })),
        };
      },
    },
  ];

  return tools;
}

/**
 * P5 topic_create 工具（独立工厂：保持既有 createCompatTools 恒为 9 个兼容工具，
 * controller 负责把 topic_create 与 6 个 Spark 工具一起追加成 16 工具全集）。
 * 创建走 service.mutate（kind:topic + expectedRevision null）：派生目录 / 索引
 * 增长 / 完整 L1 预算由底层 policy 在候选快照上统一裁决，绝不绕 policy 直接 fs 写。
 *
 * @param {object} deps
 * @param {object} deps.service 见 docs/host/README.md 的 service 契约
 * @param {() => {sessionId:string|null, scopeId:string|null}} [deps.getSessionInfo]
 * @param {() => Date} [deps.now] 时钟注入
 */
export function createTopicCreateTool({ service, getSessionInfo, now } = {}) {
  if (!service || typeof service.mutate !== "function") {
    throw INVALID_INPUT("service with mutate() is required", {});
  }
  const clock = now ?? (() => new Date());

  async function scopeIdOf() {
    try {
      return getSessionInfo?.()?.scopeId ?? null;
    } catch {
      return null;
    }
  }

  return {
  name: "topic_create",
  description: "Create a new L3 topic in the CURRENT scope with title and summary (front-matter metadata; the body starts empty). If a topic with the same key exists in the active scope this is a conflict; if it only exists in global fallback an active-scope shadow is created so the active card gets its own copy. The complete visible L1 budget (index growth) is validated by the service before commit.",
  inputSchema: {
    topic: { type: "string", required: true, description: "Topic key (must be a safe filename; 'core' is reserved)." },
    title: { type: "string", required: true, description: "Human-readable topic title." },
    summary: { type: "string", required: true, description: "One-line summary for the derived L1 index (single line)." },
    operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry." },
  },
  outputSchema: TOOL_OUTPUT_SCHEMAS["topic_create"],
  outputRender: renderToolOutput,
  async execute(args) {
    const a = requireObject(args);
    rejectScope(a);
    const topicArg = requireString(a, "topic");
    if (resolveTopicArg(topicArg) === null) {
      throw INVALID_INPUT(
        `topic_create: "${topicArg}" is a reserved core alias; core is not a creatable topic`,
        { topic: topicArg },
      );
    }
    const title = requireString(a, "title");
    const summary = requireString(a, "summary");
    if (summary.includes("\n") || summary.includes("\r")) {
      throw INVALID_INPUT("topic_create: `summary` must be a single line (it feeds the derived L1 index)", {});
    }
    if (title.length > 200) {
      throw INVALID_INPUT("topic_create: `title` must be at most 200 UTF-16 chars", { length: title.length });
    }
    const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
    // 可见性探测：active 已存在 → conflict；仅 global 同 key → active shadow；
    // 都不存在 → 新建。创建走 service.mutate（kind:topic + expectedRevision null），
    // 派生目录 / 索引增长 / 完整 L1 预算由底层 policy 在候选快照上统一裁决。
    let visible = null;
    try {
      visible = await service.readTopic(topicArg);
    } catch (error) {
      if (error?.code !== "NOT_FOUND") throw error;
    }
    const alreadyActive = visible !== null && visible.scopeId === (await scopeIdOf());
    if (alreadyActive) {
      throw INVALID_INPUT(
        `topic_create: topic "${topicArg}" already exists in the active scope (use topic_append / memory_rewrite instead)`,
        { topic: topicArg, scope: visible.scopeId },
      );
    }
    const updated = clock().toISOString();
    const result = await service.mutate({
      operationId,
      changes: [{
        kind: "topic",
        key: topicArg,
        expectedRevision: null, // active scope 内创建（store 对新文件执行 null CAS）
        text: "",
        topic: { title, summary, updated },
      }],
    });
    const receipt = writeReceipt(result, await scopeIdOf());
    return {
      ...receipt,
      created: true,
      alreadyExists: false,
      topic: topicArg,
    };
  },
};
};
