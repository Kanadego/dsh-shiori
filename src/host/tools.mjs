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
import { INVALID_INPUT, INVALID_STATE, UNSUPPORTED } from "./errors.mjs";
import { TOOL_OUTPUT_SCHEMAS, renderToolOutput } from "../plugin/tool-schemas.mjs";
import { assertNotHostLocked, validateReadonlyGuard } from "./readonly-guard.mjs";
// S3：group 软上限提示文案（超限只 warning 不报错，与 A 层口径一致）。
import { groupSoftLimitWarning } from "../core/topics.mjs";
// S3 group_manage：组清单数据层（groups.json 读写 / CAS / 迁移计划 / 条目校验）。
import {
  readGroups, writeGroups, deleteGroup, planGroupMigration, validateGroupEntry,
} from "../core/groups.mjs";

/** 派生索引标题（= src/core/render.mjs 的 INDEX_HEADER）。正文与索引在读取时拼接，正文里不得自带。 */
const DERIVED_INDEX_HEADER = "## 主题记忆索引";

/** core 正文禁止自带派生索引：否则读取渲染时会再拼一份，索引重复。 */
function rejectDerivedIndex(content, toolName) {
  if (typeof content === "string" && content.includes(DERIVED_INDEX_HEADER)) {
    throw INVALID_INPUT(
      `${toolName}: core body must not contain the derived topic index (found "${DERIVED_INDEX_HEADER}"); pass only the body, the index is generated on read`,
      { header: DERIVED_INDEX_HEADER },
    );
  }
}

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
 * @param {object} [deps.readonlyGuard] F7 只读守卫（createReadonlyGuard 产物；可选，
 *   缺省时写行为与 0.1 完全一致）。外部写锁持续持有进入只读态后，本工厂的写工具
 *   （soul_update / memory_append / memory_rewrite / core_write / topic_append）
 *   抛 code="HOST_LOCKED"；读工具与 L0/L1 注入不受影响。
 */
export function createCompatTools({ service, getSessionInfo, config, now, readonlyGuard } = {}) {
  if (!service || typeof service.mutate !== "function") {
    throw INVALID_INPUT("service with mutate() is required", {});
  }
  validateReadonlyGuard(readonlyGuard);
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
        assertNotHostLocked(readonlyGuard);
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
            // core 无分组概念，给确定缺省形状（与 topic 读分支同形状，方便消费方）。
            group: [],
            pinned: false,
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
          // S3：分组元数据随读返回（fake/旧 service 缺字段时按缺省口径补齐）。
          group: Array.isArray(t.group) ? t.group : [],
          pinned: t.pinned === true,
        };
      },
    },

    // ── L2/L3 检索 ────────────────────────────────────────────────────────
    {
      name: "memory_search",
      description: "Keyword search over visible topics; archived (cold) topics are included by default but return summary-level entries only (state='archived', score=0, listed after active hits) — never full text; use memory_read(topic) for full text. Returns keys, titles and summaries only. Lexical search, not semantic matching.",
      inputSchema: {
        query: { type: "string", required: true, description: "Keywords or a short question." },
        limit: { type: "integer", description: "Maximum results, 1–20 (default 5)." },
        includeArchived: { type: "boolean", description: "Explicitly include archived (cold) spark cards; only affects spark cold cards — topic archives are always included as summary entries. Always read-only; archived cards are never revived or re-matched automatically." },
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
        assertNotHostLocked(readonlyGuard);
        const section = requireString(a, "section");
        const content = requireString(a, "content");
        const topic = resolveTopicArg(optionalString(a, "topic")); // core / core.md / 空 → core 路径
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        if (topic === null) {
          rejectDerivedIndex(content, "memory_append");
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
        assertNotHostLocked(readonlyGuard);
        const content = requireString(a, "content", { allowEmpty: true });
        const topic = resolveTopicArg(optionalString(a, "topic")); // core / core.md / 空 → core 路径
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        if (topic === null) {
          rejectDerivedIndex(content, "memory_rewrite");
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
        assertNotHostLocked(readonlyGuard);
        const content = requireString(a, "content", { allowEmpty: true });
        const section = optionalString(a, "section");
        if (section !== undefined && section.length > 0) {
          throw UNSUPPORTED("core_write(section) is not supported in P0; rewrite the whole body instead", { section });
        }
        rejectDerivedIndex(content, "core_write");
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
        group: { type: "array", items: { type: "string" }, description: "Optional group keys (first is primary). Omit to keep the topic's existing groups; every key must already exist in the scope's group list. More than 3 groups only yields a warning." },
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
        assertNotHostLocked(readonlyGuard);
        const current = await service.readTopic(topic);
        const candidate = appendBlock(current.body ?? "", section, content, clock());
        // S3：可选 group——缺省不传（继承 token 里的原组，append 不改组）；
        // 显式给出则改挂组（组存在性由 store 校验）。超软上限只给 warning。
        const group = a.group;
        const effectiveGroup = group !== undefined ? group : (Array.isArray(current.group) ? current.group : []);
        const warning = groupSoftLimitWarning({ key: current.key, group: effectiveGroup });
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        const result = await service.mutate({
          operationId,
          changes: [{
            kind: "topic",
            key: current.key,
            text: candidate,
            expectedRevision: current.revision,
            topic: {
              title: current.title,
              summary: current.summary,
              ...(group !== undefined ? { group } : {}),
            },
          }],
        });
        return { ...writeReceipt(result, current.scopeId), ...(warning !== null ? { warning } : {}) };
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
            // S3：分组元数据随列表返回（L1 索引保持平铺，这里只做数据透传）。
            group: Array.isArray(t.group) ? t.group : [],
            pinned: t.pinned === true,
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
 * controller 负责把 topic_create、group_manage 与 6 个 Spark 工具一起追加成 17 工具全集）。
 * 创建走 service.mutate（kind:topic + expectedRevision null）：派生目录 / 索引
 * 增长 / 完整 L1 预算由底层 policy 在候选快照上统一裁决，绝不绕 policy 直接 fs 写。
 *
 * @param {object} deps
 * @param {object} deps.service 见 docs/host/README.md 的 service 契约
 * @param {() => {sessionId:string|null, scopeId:string|null}} [deps.getSessionInfo]
 * @param {() => Date} [deps.now] 时钟注入
 * @param {object} [deps.readonlyGuard] F7 只读守卫（可选；只读态下 topic_create 抛 HOST_LOCKED）
 */
export function createTopicCreateTool({ service, getSessionInfo, now, readonlyGuard } = {}) {
  if (!service || typeof service.mutate !== "function") {
    throw INVALID_INPUT("service with mutate() is required", {});
  }
  validateReadonlyGuard(readonlyGuard);
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
    group: { type: "array", items: { type: "string" }, description: "Optional group keys (first is primary). Every key must already exist in the scope's group list (create groups via group_manage). More than 3 groups only yields a warning." },
    operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry." },
  },
  outputSchema: TOOL_OUTPUT_SCHEMAS["topic_create"],
  outputRender: renderToolOutput,
  async execute(args) {
    const a = requireObject(args);
    rejectScope(a);
    assertNotHostLocked(readonlyGuard);
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
    // S3：可选 group（缺省 [] = 未分组）；组存在性由 store.commit 校验，
    // 超软上限只给 warning 文本不报错。
    const group = a.group;
    const result = await service.mutate({
      operationId,
      changes: [{
        kind: "topic",
        key: topicArg,
        expectedRevision: null, // active scope 内创建（store 对新文件执行 null CAS）
        text: "",
        topic: { title, summary, updated, ...(group !== undefined ? { group } : {}) },
      }],
    });
    const receipt = writeReceipt(result, await scopeIdOf());
    const warning = groupSoftLimitWarning({ key: topicArg, group: Array.isArray(group) ? group : [] });
    return {
      ...receipt,
      created: true,
      alreadyExists: false,
      topic: topicArg,
      ...(warning !== null ? { warning } : {}),
    };
  },
};
};

/**
 * S3 group_manage 工具（第 17 个宿主工具，agent 可调；action=list/create/update/delete）。
 * 组清单数据层复用 S3-a 的 src/core/groups.mjs（groups.json 读写 / CAS / 迁移计划），
 * topic 文件的组迁移改写走 service.mutate（store 提交协议：journal/CAS/预算），
 * 绝不绕过存储层直写。
 *
 * 删除语义（§S3.5）：组空直接删；非空必须给 migrateTo（漏给报 INVALID_STATE 并
 * 列出成员）；迁移与删组是两次独立提交、顺序固定——第一步先在单次 store 提交里
 * 改挂组内全部 topic（该提交原子：失败整体回滚，组与成员关系原样保留），第二步
 * 再删组条目（groups.json CAS 防并发改动）。已知边界：两次提交之间的窗口内，并发
 * 提交把新 topic 挂入被删组时不在保护范围——该成员的迁移计划（deleteGroup 返回
 * 的 migration）会被丢弃而组条目仍被删除，留下悬空 key；commit 侧组存在性校验与
 * deleteGroup 的 CAS 只能把窗口压到最小，完全闭合需要跨文件单事务，超出本单范围。
 *
 * @param {object} deps
 * @param {object} deps.service 见 docs/host/README.md 的 service 契约（mutate/readTopic/listTopics）
 * @param {string} deps.dataRoot 数据根（绝对路径；groups.json 位于 <dataRoot>/scopes/<scopeId>/）
 * @param {string} deps.scopeId 当前工具面绑定的 scope（宿主可信来源，不接受 payload 指定）
 * @param {() => Date} [deps.now] 时钟注入
 * @param {object} [deps.readonlyGuard] F7 只读守卫（可选；只读态下 create/update/delete 抛 HOST_LOCKED）
 */
export function createGroupManageTool({ service, dataRoot, scopeId, now, readonlyGuard } = {}) {
  if (!service || typeof service.mutate !== "function") {
    throw INVALID_INPUT("service with mutate() is required", {});
  }
  if (typeof dataRoot !== "string" || dataRoot.length === 0) {
    throw INVALID_INPUT("group_manage requires an explicit dataRoot (groups.json location)", {});
  }
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    throw INVALID_INPUT("group_manage requires the trusted scopeId", {});
  }
  validateReadonlyGuard(readonlyGuard);

  function topicSnapshotOf(topics) {
    return (Array.isArray(topics) ? topics : []).map((t) => ({
      key: String(t?.key ?? ""),
      group: Array.isArray(t?.group) ? t.group : [],
    }));
  }

  async function readGroupsOrEmpty() {
    try {
      return await readGroups({ dataRoot, scopeId });
    } catch (error) {
      if (error?.code === "NOT_FOUND") {
        // 组清单缺失：等价「无任何组」（ensureGroupsFile 由宿主激活路径负责，
        // 这里不静默初始化——读路径绝不写盘）。
        return { revision: null, data: { version: 1, groups: [] } };
      }
      throw error;
    }
  }

  return {
    name: "group_manage",
    description: "Manage topic groups for the current scope: list groups (with per-group topic counts), create/update group metadata (key/title/summary/order), or delete a group. Deleting a non-empty group requires migrateTo: the group's topics are re-grouped in one commit first, and the group entry is removed afterwards as a second, separate step. A topic newly attached to the group between the two commits is NOT protected and may be left with a dangling key (concurrency edge; see the known-limitation note in createGroupManageTool). Groups are per-scope and referenced from topic front-matter; a topic's first group is its primary group (soft limit: 3 groups per topic, more only yields a warning).",
    inputSchema: {
      action: { type: "string", required: true, description: "One of: list, create, update, delete." },
      key: { type: "string", description: "Group key (create/update/delete)." },
      title: { type: "string", description: "Group title (required for create; optional for update)." },
      summary: { type: "string", description: "Group summary (required for create; optional for update)." },
      order: { type: "number", description: "Sort order (required for create; optional for update)." },
      migrateTo: { type: "string", description: "delete: move this group's topics into an existing group; required when the group is not empty." },
      operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry." },
    },
    outputSchema: TOOL_OUTPUT_SCHEMAS["group_manage"],
    outputRender: renderToolOutput,
    async execute(args) {
      const a = requireObject(args);
      rejectScope(a);
      const action = requireString(a, "action");
      if (action === "list") {
        const { revision, data } = await readGroupsOrEmpty();
        // 主组口径（0.4 审查 P0#2，用户 2026-11-14 拍板）：一个 topic 可以挂多组，
        // 但计数只认主组 t.group[0]，多组 topic 不在非主组重复计数——否则组行计数
        // 总和会虚高，且与面板成员列表（row.group[0] === key）口径不一致。
        const counts = new Map();
        for (const t of await service.listTopics()) {
          const primary = Array.isArray(t?.group) && t.group.length > 0 ? t.group[0] : null;
          if (primary !== null) counts.set(primary, (counts.get(primary) ?? 0) + 1);
        }
        return {
          scope: scopeId,
          action,
          revision,
          groups: data.groups.map((g) => ({ ...g, topics: counts.get(g.key) ?? 0 })),
        };
      }
      // 以下三个 action 都是写：只读态直接拒绝（与既有写工具同一守卫）。
      assertNotHostLocked(readonlyGuard);
      const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
      if (action === "create") {
        const entry = validateGroupEntry({
          key: requireString(a, "key"),
          title: requireString(a, "title"),
          summary: optionalString(a, "summary") ?? "",
          order: a.order,
        }, "group_manage.create");
        const { revision, data } = await readGroupsOrEmpty();
        if (data.groups.some((g) => g.key === entry.key)) {
          throw INVALID_INPUT(
            `group_manage: group "${entry.key}" already exists (use action=update to change its metadata)`,
            { key: entry.key, known: data.groups.map((g) => g.key) },
          );
        }
        const written = await writeGroups({
          dataRoot, scopeId, groups: [...data.groups, entry], expectedRevision: revision,
        });
        return { scope: scopeId, action, key: entry.key, created: true, revision: written.revision };
      }
      if (action === "update") {
        const key = requireString(a, "key");
        const { revision, data } = await readGroupsOrEmpty();
        const existing = data.groups.find((g) => g.key === key);
        if (!existing) {
          throw INVALID_INPUT(
            `group_manage: group "${key}" does not exist（现有组: ${data.groups.map((g) => g.key).join(", ") || "无"}）`,
            { key, known: data.groups.map((g) => g.key) },
          );
        }
        const title = optionalString(a, "title") ?? existing.title;
        const summary = optionalString(a, "summary") ?? existing.summary;
        const order = a.order === undefined ? existing.order : a.order;
        const entry = validateGroupEntry({ key, title, summary, order }, "group_manage.update");
        const next = data.groups.map((g) => (g.key === key ? entry : g));
        const written = await writeGroups({
          dataRoot, scopeId, groups: next, expectedRevision: revision,
        });
        return { scope: scopeId, action, key, updated: true, revision: written.revision };
      }
      if (action === "delete") {
        const key = requireString(a, "key");
        const migrateTo = optionalString(a, "migrateTo");
        const { revision, data } = await readGroupsOrEmpty();
        if (!data.groups.some((g) => g.key === key)) {
          throw INVALID_INPUT(
            `group_manage: group "${key}" does not exist（现有组: ${data.groups.map((g) => g.key).join(", ") || "无"}）`,
            { key, known: data.groups.map((g) => g.key) },
          );
        }
        if (migrateTo !== undefined) {
          if (migrateTo === key) {
            throw INVALID_INPUT("group_manage: migrateTo 不能等于被删除的组 key", { key, migrateTo });
          }
          if (!data.groups.some((g) => g.key === migrateTo)) {
            throw INVALID_INPUT(
              `group_manage: migrateTo 指向的组 "${migrateTo}" 不存在，请先建组`
              + `（现有组: ${data.groups.map((g) => g.key).join(", ") || "无"}）`,
              { key, migrateTo, known: data.groups.map((g) => g.key) },
            );
          }
        }
        // 成员判定用当前可见 topic 快照（组已存在，读到的 group 都可对照清单）。
        const snapshot = topicSnapshotOf(await service.listTopics());
        const members = snapshot.filter((t) => t.group.includes(key)).map((t) => t.key);
        if (members.length > 0 && migrateTo === undefined) {
          throw INVALID_STATE(
            `group_manage: 组 "${key}" 内仍有 ${members.length} 个 topic（${members.join(", ")}），拒绝删除；`
            + "请提供 migrateTo 指定迁移目标组，或先把组内 topic 迁出",
            { key, members },
          );
        }
        let migrated = [];
        if (members.length > 0) {
          // 同一提交里完成全部组内 topic 的改挂（此刻组仍在清单里，中途失败
          // 组与成员关系原样保留，绝不留悬空 key）。
          const plan = planGroupMigration(snapshot, key, migrateTo);
          const changes = [];
          for (const item of plan) {
            const current = await service.readTopic(item.topicKey);
            changes.push({
              kind: "topic",
              key: item.topicKey,
              expectedRevision: current.revision,
              text: current.body ?? "",
              topic: { title: current.title, summary: current.summary, group: item.group },
            });
          }
          await service.mutate({ operationId, changes });
          migrated = plan;
        }
        // 组条目删除（CAS：revision 取本 action 开头的清单读取；topic 迁移不改
        // groups.json，CAS 仍成立）。
        const postSnapshot = topicSnapshotOf(await service.listTopics());
        let deleted;
        try {
          deleted = await deleteGroup({
            dataRoot, scopeId, key, migrateTo, topics: postSnapshot, expectedRevision: revision,
          });
        } catch (error) {
          // 迁移提交与组条目删除之间存在并发窗口：topic 改挂已经生效、只是
          // groups.json 被并发改动导致 CAS 失败。此时不能让调用方误判成整体
          // 失败——错误文案写明「迁移已生效，重试幂等」（重跑本 action 时组内
          // topic 已不在组内，只会补删组条目，不会二次迁移）。
          if (error?.code === "REVISION_CONFLICT" && migrated.length > 0) {
            error.message += `（迁移已生效，重试幂等：组内 topic 已迁至 "${migrateTo}"，重试只需补删组条目）`;
          }
          throw error;
        }
        return { scope: scopeId, action, key, deleted: true, migrated, revision: deleted.revision };
      }
      throw INVALID_INPUT(
        `group_manage: action 必须是 list / create / update / delete，收到 "${action}"`,
        { action },
      );
    },
  };
}
