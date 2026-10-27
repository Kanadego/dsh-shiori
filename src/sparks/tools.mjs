// Shiori P2 · L2 Sparks 工具门面（Slot I）。
//
// 纯 host-agnostic 门面：接收【可信】的 scopeId 与 store 实例（来自宿主工厂，
// 见 CONTRACTS.md §G 的 openSparkStore），暴露 DESIGN.md §6 的六个 L2 工具的
// 无 host 描述与执行函数。真实 DSH client panel 注册 / GenUI 渲染是后续集成
// （not-run，见 docs/sparks/tools-graph.md）。
//
// 硬边界：
// - payload 永远不能改变 root/scope：`scope`、`scopeId`、`root` 三个键在任何
//   工具的 payload 中出现即 INVALID_INPUT（即便值恰好等于可信 scope）；
// - 写工具一律拒绝未知键（防拼写漂移与 scope 变体走私），expectedRevision /
//   operationId 原样透传给 store，CAS 与幂等语义由 store 裁决；
//   未提供 operationId 时门面生成一个 UUID（重试须复用同一 id 才能幂等）；
// - store 抛出的 coded error（REVISION_CONFLICT / LOCK_BUSY / NOT_FOUND / …）
//   原样上抛，绝不吞错回 success；门面自身只用 INVALID_INPUT / INVALID_STATE /
//   NOT_FOUND / UNSUPPORTED；
// - spark_read 是 L2 正文唯一展开路径（不是 memory_read）：只回当前 scope 的
//   记录，store 若返回异 scope 记录按 NOT_FOUND 处理（不泄露跨 scope 存在性）；
// - spark_graph 的模型侧回执只有面板句柄与规模摘要（graph.mjs graphSummary），
//   不含任何节点 id / 标题 / 正文。数据源是 store.listActive() 的完整 active
//   public record —— 绝不读 store.graph()：那是 G 的有向诊断平面（节点缺
//   scopeId/state/links，另带 filteredEdges），当作记录解析会被防御性过滤成
//   空图（GI 组合评审的阻断性教训）。整图投影供 host 面板直连使用。
//
// 本模块除同目录 graph.mjs 外仅 import 纯 JSON 数据文件 plugin/tool-schemas.mjs（P5 输出 schema 唯一权威，无任何业务/宿主依赖）。

import { randomUUID } from "node:crypto";
import { projectGraph, normalizeGraphRecords, graphSummary } from "./graph.mjs";
// P5：输出 schema 唯一权威（纯 JSON 数据，无循环依赖；spark 工具必须声明
// 真实成功分支的 output schema，宿主 runner 会按其校验成功输出）。
import { TOOL_OUTPUT_SCHEMAS, renderToolOutput } from "../plugin/tool-schemas.mjs";

const ERROR_CODES = new Set([
  "INVALID_INPUT",
  "INVALID_STATE",
  "REVISION_CONFLICT",
  "NOT_FOUND",
  "LOCK_BUSY",
  "UNSUPPORTED",
]);

/** 门面自造错误（store 错误不经此函数，直接上抛）。 */
function fail(code, message, details) {
  const error = new Error(message);
  error.name = "ShioriError";
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

const isPlainRecord = (value) => {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};

const nonEmptyString = (value) => typeof value === "string" && value.length > 0;

function requireObject(args, tool) {
  if (args === undefined || args === null) return {};
  if (!isPlainRecord(args)) {
    return fail("INVALID_INPUT", `${tool}: payload must be a plain object`, { tool, received: typeof args });
  }
  return args;
}

/** scope/root 只能来自可信工厂，payload 出现即拒绝（与 P1 host 工具同规则）。 */
function rejectTrustedKeys(args, tool) {
  for (const key of ["scope", "scopeId", "root"]) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      return fail("INVALID_INPUT", `${tool}: \`${key}\` cannot be passed in tool payloads; scope comes from the trusted host factory`, { tool, key });
    }
  }
}

function rejectUnknownKeys(args, tool, known) {
  for (const key of Object.keys(args)) {
    if (!known.includes(key)) {
      return fail("INVALID_INPUT", `${tool}: unknown payload key "${key}" (allowed: ${known.join(", ")})`, { tool, key });
    }
  }
}

function requireString(args, tool, field, { allowEmpty = false } = {}) {
  const value = args[field];
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    return fail("INVALID_INPUT", `${tool}: \`${field}\` must be a non-empty string`, { tool, field, received: typeof value });
  }
  if (!value.isWellFormed()) {
    return fail("INVALID_INPUT", `${tool}: \`${field}\` contains unpaired surrogates and would not survive lossless UTF-8 encoding`, { tool, field });
  }
  return value;
}

function optionalString(args, tool, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  return requireString(args, tool, field);
}

/** 字符串数组校验（triggers/entities）：undefined → undefined；空数组合法（显式选择）。 */
function optionalStringArray(args, tool, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    return fail("INVALID_INPUT", `${tool}: \`${field}\` must be an array of non-empty strings`, { tool, field, received: typeof value });
  }
  for (const item of value) {
    if (!nonEmptyString(item) || !item.isWellFormed()) {
      return fail("INVALID_INPUT", `${tool}: \`${field}\` entries must be non-empty well-formed strings`, { tool, field, item: nonEmptyString(item) ? "unpaired-surrogate" : typeof item });
    }
  }
  return value;
}

/** links 数组校验：每项 { target: 非空 string, rel?: string }；id 合法性与跨 scope 由 store 裁决。 */
function optionalLinks(args, tool, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    return fail("INVALID_INPUT", `${tool}: \`${field}\` must be an array of { target, rel? }`, { tool, field, received: typeof value });
  }
  for (const link of value) {
    if (!isPlainRecord(link) || !nonEmptyString(link.target)) {
      return fail("INVALID_INPUT", `${tool}: each link needs a non-empty string \`target\` (rel is optional)`, { tool, field });
    }
    if (link.rel !== undefined && link.rel !== null && typeof link.rel !== "string") {
      return fail("INVALID_INPUT", `${tool}: link \`rel\` must be a string when present`, { tool, field });
    }
  }
  return value;
}

function requireVitality(args, tool) {
  const value = args.vitality;
  if (value !== "evergreen" && value !== "ephemeral") {
    return fail("INVALID_INPUT", `${tool}: \`vitality\` must be "evergreen" or "ephemeral"`, { tool, vitality: value === null ? "null" : typeof value });
  }
  return value;
}

/**
 * expectedRevision：缺省不传；出现即必须是不透明 JSON 标量（非空 string / 有限
 * number / null——DESIGN §4.3.1 的 revision 示例即数字），其余类型拒绝。
 * 门面不解释其语义，比对与 REVISION_CONFLICT 判定完全交给 store。
 */
function optionalExpectedRevision(args, tool) {
  if (!Object.prototype.hasOwnProperty.call(args, "expectedRevision")) return undefined;
  const value = args.expectedRevision;
  if (value === null) return value;
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fail("INVALID_INPUT", `${tool}: \`expectedRevision\` must be an opaque revision scalar (non-empty string, finite number, or null) when present`, { tool, received: typeof value });
}

function optionalOperationId(args, tool) {
  const value = args.operationId;
  if (value === undefined || value === null) return randomUUID();
  if (!nonEmptyString(value)) {
    return fail("INVALID_INPUT", `${tool}: \`operationId\` must be a non-empty string when present`, { tool });
  }
  return value;
}

/** vitality 补丁校验（update 允许单字段补丁，vitality 出现时必须合法）。 */
function optionalVitality(args, tool) {
  if (!Object.prototype.hasOwnProperty.call(args, "vitality")) return undefined;
  return requireVitality(args, tool);
}

/**
 * 从 store 写回执提取公共字段。store 未交付前以 public record 形状为契约假设：
 * 返回值至少含 id/revision 时原样回显；形状不符时字段降级为 null，绝不虚构成功数据。
 */
function receipt(tool, scopeId, operationId, result, extra = {}) {
  const record = isPlainRecord(result) ? result : {};
  return {
    ok: true,
    tool,
    scope: scopeId,
    operationId,
    id: nonEmptyString(record.id) ? record.id : null,
    revision: record.revision ?? null,
    state: nonEmptyString(record.state) ? record.state : null,
    vitality: nonEmptyString(record.vitality) ? record.vitality : null,
    ...extra,
  };
}

/**
 * 构造 L2 spark 工具门面。
 *
 * @param {object} deps
 * @param {string} deps.scopeId 可信 scope（宿主工厂注入；payload 无法改变）
 * @param {object} deps.store G 契约 store（save/read/update/forget/feedback/graph/listActive/close）
 * @returns {{scopeId:string, tools:Array, names:string[], list:()=>Array, execute:(name:string,payload:object)=>Promise<object>}}
 */
export function createSparkTools({ scopeId, store } = {}) {
  if (!nonEmptyString(scopeId)) {
    return fail("INVALID_INPUT", "createSparkTools requires a non-empty string scopeId from a trusted source", { scopeId: typeof scopeId });
  }
  if (!isPlainRecord(store)) {
    return fail("INVALID_INPUT", "createSparkTools requires a spark store instance", { store: typeof store });
  }
  for (const method of ["save", "read", "update", "forget", "feedback", "listActive"]) {
    if (typeof store[method] !== "function") {
      return fail("INVALID_INPUT", `createSparkTools: store is missing required method "${method}()" per CONTRACTS.md §G`, { method });
    }
  }

  const tools = [
    {
      name: "spark_save",
      description: "Save one atomic L2 spark card (meme, nickname, atomic fact) in the CURRENT scope. Scope is fixed by the trusted host factory and cannot be passed. id/revision are generated by the store; retry with the same operationId for idempotency. Pass expectedRevision only for store-defined create-CAS semantics.",
      inputSchema: {
        content: { type: "string", required: true, description: "The card body (short atomic memory, 50–150 chars recommended)." },
        title: { type: "string", required: true, description: "Short card title." },
        triggers: { type: "array", required: true, description: "Exact wake phrases (aliases allowed); only these can trigger the card. Empty array = never auto-delivered, still readable." },
        summary: { type: "string", description: "Optional pre-stored summary (≤60 chars recommended) used when content exceeds the inline threshold." },
        entities: { type: "array", description: "Optional soft co-occurrence tags (strings)." },
        links: { type: "array", description: "Optional explicit links: { target: sparkId, rel?: string }. Same-scope active targets only." },
        vitality: { type: "string", required: true, description: '"evergreen" (immune to time decay) or "ephemeral" (time-decayed).' },
        expectedRevision: { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }], description: "Opaque CAS revision; omit unless retrying a guided create." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["spark_save"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args, "spark_save");
        rejectTrustedKeys(a, "spark_save");
        rejectUnknownKeys(a, "spark_save", ["content", "title", "triggers", "summary", "entities", "links", "vitality", "expectedRevision", "operationId"]);
        const content = requireString(a, "spark_save", "content");
        const title = requireString(a, "spark_save", "title");
        const triggers = optionalStringArray(a, "spark_save", "triggers");
        if (triggers === undefined) {
          return fail("INVALID_INPUT", "spark_save: `triggers` is required (use an empty array to explicitly opt out of wake words)", { tool: "spark_save", field: "triggers" });
        }
        const summary = optionalString(a, "spark_save", "summary");
        const entities = optionalStringArray(a, "spark_save", "entities");
        const links = optionalLinks(a, "spark_save", "links");
        const vitality = requireVitality(a, "spark_save");
        const operationId = optionalOperationId(a, "spark_save");
        const expectedRevision = optionalExpectedRevision(a, "spark_save");

        const input = { content, title, triggers, vitality };
        if (summary !== undefined) input.summary = summary;
        if (entities !== undefined) input.entities = entities;
        if (links !== undefined) input.links = links;
        const options = { operationId };
        if (expectedRevision !== undefined) options.expectedRevision = expectedRevision;
        const result = await store.save(input, options);
        return receipt("spark_save", scopeId, operationId, result);
      },
    },
    {
      name: "spark_read",
      description: "Read one L2 spark card's full text (including long bodies) from the CURRENT scope. This is the L2 detail path — NOT memory_read(topic). Archived/superseded history stays readable in-scope with its state echoed; cross-scope ids are not disclosed.",
      inputSchema: {
        id: { type: "string", required: true, description: "Spark id from spark_save receipt, an attachment, or the graph panel." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["spark_read"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args, "spark_read");
        rejectTrustedKeys(a, "spark_read");
        rejectUnknownKeys(a, "spark_read", ["id"]);
        const id = requireString(a, "spark_read", "id");
        const record = await store.read(id);
        if (!isPlainRecord(record)) {
          return fail("INVALID_STATE", "spark_read: store returned a non-record payload; refusing to fabricate a card", { tool: "spark_read", id });
        }
        if (nonEmptyString(record.scopeId) && record.scopeId !== scopeId) {
          return fail("NOT_FOUND", "spark_read: no such spark in the current scope", { tool: "spark_read", id });
        }
        if (nonEmptyString(record.id) && record.id !== id) {
          return fail("INVALID_STATE", "spark_read: store returned a record whose id differs from the requested one", { tool: "spark_read", requested: id, returned: record.id });
        }
        return {
          ok: true,
          tool: "spark_read",
          scope: scopeId,
          id,
          revision: record.revision ?? null,
          title: typeof record.title === "string" ? record.title : null,
          summary: typeof record.summary === "string" ? record.summary : null,
          triggers: Array.isArray(record.triggers) ? record.triggers : [],
          entities: Array.isArray(record.entities) ? record.entities : [],
          links: Array.isArray(record.links) ? record.links : [],
          content: typeof record.content === "string" ? record.content : null,
          vitality: nonEmptyString(record.vitality) ? record.vitality : null,
          state: nonEmptyString(record.state) ? record.state : null,
        };
      },
    },
    {
      name: "spark_update",
      description: "Patch one spark card in the CURRENT scope (title/summary/content/triggers/entities/links/vitality). id, scope and state are never patchable here — use spark_forget for lifecycle. CAS: pass the revision from spark_read/spark_save; mismatch returns REVISION_CONFLICT. Retry with the same operationId.",
      inputSchema: {
        id: { type: "string", required: true, description: "Spark id to patch." },
        patch: { type: "object", required: true, additionalProperties: true, description: "Fields to replace: title?, summary?, content?, triggers?, entities?, links?, vitality? (at least one)." },
        expectedRevision: { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }], description: "Opaque revision for CAS from the latest read." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["spark_update"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args, "spark_update");
        rejectTrustedKeys(a, "spark_update");
        rejectUnknownKeys(a, "spark_update", ["id", "patch", "expectedRevision", "operationId"]);
        const id = requireString(a, "spark_update", "id");
        if (!isPlainRecord(a.patch)) {
          return fail("INVALID_INPUT", "spark_update: `patch` must be a plain object", { tool: "spark_update", received: typeof a.patch });
        }
        rejectTrustedKeys(a.patch, "spark_update(patch)");
        const PATCH_KEYS = ["title", "summary", "content", "triggers", "entities", "links", "vitality"];
        rejectUnknownKeys(a.patch, "spark_update(patch)", PATCH_KEYS);
        if (Object.keys(a.patch).length === 0) {
          return fail("INVALID_INPUT", "spark_update: `patch` must contain at least one field", { tool: "spark_update" });
        }
        if (a.patch.title !== undefined) requireString(a.patch, "spark_update(patch)", "title");
        if (a.patch.summary !== undefined) optionalString(a.patch, "spark_update(patch)", "summary");
        if (a.patch.content !== undefined) requireString(a.patch, "spark_update(patch)", "content");
        optionalStringArray(a.patch, "spark_update(patch)", "triggers");
        optionalStringArray(a.patch, "spark_update(patch)", "entities");
        optionalLinks(a.patch, "spark_update(patch)", "links");
        optionalVitality(a.patch, "spark_update(patch)");
        const operationId = optionalOperationId(a, "spark_update");
        const expectedRevision = optionalExpectedRevision(a, "spark_update");

        const options = { operationId };
        if (expectedRevision !== undefined) options.expectedRevision = expectedRevision;
        const result = await store.update(id, a.patch, options);
        return receipt("spark_update", scopeId, operationId, result);
      },
    },
    {
      name: "spark_forget",
      description: "Retire one spark card in the CURRENT scope. mode=archive soft-archives (history kept, leaves the trigger/entity spread pool). mode=supersede requires replacementId (the new card id) and keeps the old card with a directed relation; the replacement must already exist in the same scope. Physical deletion is a separate privacy flow, not this tool.",
      inputSchema: {
        id: { type: "string", required: true, description: "Spark id to retire." },
        mode: { type: "string", required: true, description: '"archive" or "supersede".' },
        replacementId: { type: "string", description: 'Required when mode="supersede"; must differ from id.' },
        expectedRevision: { oneOf: [{ type: "string" }, { type: "number" }, { type: "null" }], description: "Opaque revision for CAS from the latest read." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["spark_forget"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args, "spark_forget");
        rejectTrustedKeys(a, "spark_forget");
        rejectUnknownKeys(a, "spark_forget", ["id", "mode", "replacementId", "expectedRevision", "operationId"]);
        const id = requireString(a, "spark_forget", "id");
        const mode = a.mode;
        if (mode !== "archive" && mode !== "supersede") {
          return fail("INVALID_INPUT", 'spark_forget: `mode` must be "archive" or "supersede"', { tool: "spark_forget", mode: typeof mode });
        }
        let replacementId;
        if (mode === "supersede") {
          replacementId = requireString(a, "spark_forget", "replacementId");
          if (replacementId === id) {
            return fail("INVALID_INPUT", "spark_forget: a card cannot supersede itself", { tool: "spark_forget", id });
          }
        } else if (Object.prototype.hasOwnProperty.call(a, "replacementId") && a.replacementId !== undefined && a.replacementId !== null) {
          return fail("INVALID_INPUT", 'spark_forget: replacementId is only valid with mode="supersede"', { tool: "spark_forget" });
        }
        const operationId = optionalOperationId(a, "spark_forget");
        const expectedRevision = optionalExpectedRevision(a, "spark_forget");

        const options = { mode, operationId };
        if (replacementId !== undefined) options.replacementId = replacementId;
        if (expectedRevision !== undefined) options.expectedRevision = expectedRevision;
        const result = await store.forget(id, options);
        return receipt("spark_forget", scopeId, operationId, result, { mode, replacementId: replacementId ?? null });
      },
    },
    {
      name: "spark_feedback",
      description: "Record explicit usefulness feedback for one delivered spark (passive delivery does not extend life). Idempotent per sourceEventId (the delivery event that actually used the card). used must be an explicit boolean.",
      inputSchema: {
        id: { type: "string", required: true, description: "Spark id that was used." },
        used: { type: "boolean", required: true, description: "Explicit user/model confirmation that the card was useful." },
        sourceEventId: { type: "string", description: "Delivery event id; recommended for idempotency." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["spark_feedback"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args, "spark_feedback");
        rejectTrustedKeys(a, "spark_feedback");
        rejectUnknownKeys(a, "spark_feedback", ["id", "used", "sourceEventId", "operationId"]);
        const id = requireString(a, "spark_feedback", "id");
        if (typeof a.used !== "boolean") {
          return fail("INVALID_INPUT", "spark_feedback: `used` must be an explicit boolean", { tool: "spark_feedback", received: typeof a.used });
        }
        const sourceEventId = optionalString(a, "spark_feedback", "sourceEventId");
        const operationId = optionalOperationId(a, "spark_feedback");

        const options = { used: a.used, operationId };
        if (sourceEventId !== undefined) options.sourceEventId = sourceEventId;
        const result = await store.feedback(id, options);
        return receipt("spark_feedback", scopeId, operationId, result, { used: a.used, sourceEventId: sourceEventId ?? null });
      },
    },
    {
      name: "spark_graph",
      description: "Overview of the CURRENT scope's active spark graph for the model: panel handle plus node/edge scale summary ONLY — no card ids, titles or bodies come back. Read a card's full text with spark_read(id); the graph panel renders from the host-side projection, not from this tool.",
      inputSchema: {},
      outputSchema: TOOL_OUTPUT_SCHEMAS["spark_graph"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args, "spark_graph");
        rejectTrustedKeys(a, "spark_graph");
        rejectUnknownKeys(a, "spark_graph", []);
        // 边界（GI 组合评审拍板）：G 的 store.graph() 是有向诊断平面
        // （节点仅 id/title/vitality/revision + filteredEdges），不是 public
        // record；喂给投影会被防御性过滤成空图。UI 投影的唯一数据源是
        // listActive() 的完整 active 记录，边由记录自身 links 派生（graph.mjs）。
        const records = await store.listActive();
        const normalized = normalizeGraphRecords(records);
        const projection = projectGraph({ scopeId, records: normalized });
        const summary = graphSummary(projection);
        return {
          ok: true,
          tool: "spark_graph",
          scope: scopeId,
          handle: summary.handle,
          summary: {
            nodes: summary.nodes,
            edges: summary.edges,
            vitality: summary.vitality,
            droppedRecords: summary.droppedRecords,
            droppedEdges: summary.droppedEdges,
          },
          hint: summary.hint,
        };
      },
    },
  ];

  const names = tools.map((t) => t.name);

  return {
    scopeId,
    /** P1 风格的工具描述数组（name/description/inputSchema/execute）。 */
    tools,
    names,
    /** 无执行函数的纯描述列表（注册给宿主 schema 用）。 */
    list() {
      return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    },
    /** 按 name 分发；未知名字 INVALID_INPUT。store 错误原样上抛。 */
    async execute(name, payload) {
      if (!nonEmptyString(name) || !names.includes(name)) {
        return fail("INVALID_INPUT", `unknown spark tool "${String(name)}"`, { known: names });
      }
      return tools.find((t) => t.name === name).execute(payload);
    },
  };
}

/** 供宿主/测试判定错误是否为本体系 coded error。 */
export function isSparkToolError(value) {
  return value instanceof Error && typeof value.code === "string" && ERROR_CODES.has(value.code);
}
