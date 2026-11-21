// Shiori P5-PLUGIN · 17 工具输出 schema 唯一权威（slot P）。
//
// 契约（CONTRACTS §4）：所有宿主工具提供 output:{schema,render}；输出 schema
// 覆盖所有读分支 / nullable / changes / 写回执；严禁空对象闭合 schema；实际
// 9 兼容工具 + topic_create + group_manage（S3）+ 6 Spark 工具共 17 个。
//
// schema 形状按真实 DSH dsh-tools 0.2.1-rc.2 的 author-facing value schema DSL
// 编写（lib/index.js compileValueSchema，本文件形状已经真实 defineTool 编译验证）：
// - object 必须 explicit additionalProperties: true|false；
// - 必填以属性级 required: true 表达（DSL 不支持顶层 required 数组）；
// - 联合用 oneOf（不可与 type 同用）；字符串只支持 type/enum/const + 注解；
// - nullable 字段用 oneOf [{type:"x"},{type:"null"}]。
//
// 本模块是纯 JSON 数据 + 纯 render 函数：不 import controller/宿主/业务模块。

const hexRev = { oneOf: [{ type: "string" }, { type: "null" }] };

const changeEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { type: "string", required: true },
    key: { oneOf: [{ type: "string" }, { type: "null" }] },
    scope: { oneOf: [{ type: "string" }, { type: "null" }] },
    beforeRevision: hexRev,
    afterRevision: hexRev,
  },
};

const writeReceiptSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    operationId: { type: "string", required: true },
    generation: { type: "integer", required: true },
    revision: { ...hexRev, required: true },
    scope: { ...hexRev, required: true },
    projection: { type: "string", required: true },
    changes: { type: "array", items: changeEntry, required: true },
    replayed: { type: "boolean" },
    // S3：group 超软上限（>3）时的提示文本（只 warning 不报错）。
    warning: { type: "string" },
    // topic_create 附加回执字段
    created: { type: "boolean" },
    alreadyExists: { type: "boolean" },
    topic: { type: "string" },
  },
};

const topicEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", required: true },
    title: { oneOf: [{ type: "string" }, { type: "null" }] },
    summary: { oneOf: [{ type: "string" }, { type: "null" }] },
    scopeId: { oneOf: [{ type: "string" }, { type: "null" }] },
    revision: { ...hexRev, required: true },
    updated: { oneOf: [{ type: "string" }, { type: "null" }] },
    // S3：分组元数据（group 缺省 []，pinned 缺省 false）。
    group: { type: "array", items: { type: "string" } },
    pinned: { type: "boolean" },
    chars: { type: "integer" },
    bytes: { type: "integer" },
  },
};

const matchEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", required: true },
    title: { oneOf: [{ type: "string" }, { type: "null" }] },
    summary: { oneOf: [{ type: "string" }, { type: "null" }] },
    scopeId: { oneOf: [{ type: "string" }, { type: "null" }] },
    score: { type: "integer", required: true },
    state: { oneOf: [{ type: "string" }, { type: "null" }] },
  },
};

// 0.5-2B：memory_read 组目录读分支（kind:"group"）的成员条目——key/title/summary/
// retention/archived/updated/chars，绝不含正文（正文体积只以 chars 计数体现）。
const groupMemberEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", required: true },
    title: { oneOf: [{ type: "string" }, { type: "null" }] },
    summary: { oneOf: [{ type: "string" }, { type: "null" }] },
    retention: { type: "string" },
    archived: { type: "boolean" },
    updated: { oneOf: [{ type: "string" }, { type: "null" }] },
    chars: { type: "integer" },
  },
};

// S3 group_manage 输出条目：组清单行（list 的 groups 元素）与迁移计划行（delete
// 的 migrated 元素）。order 用 number（DSL 不限整数，模板用整数但 update 可改）。
const groupEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string", required: true },
    title: { type: "string", required: true },
    summary: { type: "string", required: true },
    order: { type: "number", required: true },
    topics: { type: "integer" },
  },
};

const groupMigrationEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    topicKey: { type: "string", required: true },
    group: { type: "array", items: { type: "string" }, required: true },
  },
};

// 0.4 收尾：list 的悬空引用条目（topic.group 指向不存在组的 (topicKey, group) 对，
// 按对去重；repair 清理后正常归零）。
const groupDanglingEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    topicKey: { type: "string", required: true },
    group: { type: "string", required: true },
  },
};

const sparkReceiptProperties = {
  ok: { type: "boolean", required: true },
  tool: { type: "string", required: true },
  scope: { ...hexRev, required: true },
  operationId: { type: "string", required: true },
  id: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  revision: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
  state: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
  vitality: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
};

/** 17 个工具的输出 schema（name → schema；S3 起含 group_manage）。 */
export const TOOL_OUTPUT_SCHEMAS = Object.freeze({
  // ── L0 persona ──────────────────────────────────────────────
  soul_read: {
    type: "object",
    additionalProperties: false,
    properties: {
      exists: { type: "boolean", required: true },
      persona: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
      content: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
      revision: { ...hexRev, required: true },
      stale: { type: "boolean" },
    },
  },
  soul_update: writeReceiptSchema,

  // ── L1 core ─────────────────────────────────────────────────
  memory_read: {
    type: "object",
    additionalProperties: false,
    properties: {
      exists: { type: "boolean", required: true },
      bytes: { type: "integer", required: true },
      truncated: { type: "boolean", required: true },
      source: { oneOf: [{ type: "string" }, { type: "null" }] },
      topic: { type: "string", required: true },
      content: { type: "string", required: true },
      revision: { ...hexRev, required: true },
      // S3：topic 读分支的分组元数据（core 读分支缺省 [] / false）。
      group: { type: "array", items: { type: "string" } },
      pinned: { type: "boolean" },
      // 0.5-2B：组目录读分支（topic 参数传组 key；kind:"group" 为判别字段，
      // 正文读分支不带）。content 恒空串、bytes 恒 0（绝不含正文），members 为
      // 成员目录；revision 是组清单（groups.json）的内容哈希。
      kind: { type: "string" },
      groupTitle: { type: "string" },
      groupSummary: { type: "string" },
      members: { type: "array", items: groupMemberEntry },
      // 0.5-2B：同名组冲突提示（topic 读分支专用——key 同为 topic 与组时，
      // topic 正文优先，note 说明另有同名组）。
      note: { type: "string" },
    },
  },
  memory_search: {
    type: "object",
    additionalProperties: false,
    properties: {
      matches: { type: "array", items: matchEntry, required: true },
    },
  },
  memory_append: writeReceiptSchema,
  memory_rewrite: writeReceiptSchema,
  core_write: writeReceiptSchema,

  // ── L3 topics ───────────────────────────────────────────────
  topic_append: writeReceiptSchema,
  topic_create: writeReceiptSchema,
  memory_list_topics: {
    type: "object",
    additionalProperties: false,
    properties: {
      topics: { type: "array", items: topicEntry, required: true },
    },
  },

  // ── S3 分组 ─────────────────────────────────────────────────
  group_manage: {
    type: "object",
    additionalProperties: false,
    properties: {
      scope: { type: "string", required: true },
      action: { type: "string", required: true },
      // groups.json 的 revision（list/delete 为操作后清单哈希；清单缺失时 null；
      // repair 为提交后重读清单的 revision，与 remaining 同源；提交后重读失败时
      // 回退为提交所用快照 revision，并附 warning）。
      revision: { ...hexRev, required: true },
      groups: { type: "array", items: groupEntry },
      key: { type: "string" },
      created: { type: "boolean" },
      updated: { type: "boolean" },
      deleted: { type: "boolean" },
      migrated: { type: "array", items: groupMigrationEntry },
      // 0.4 收尾：list 返回的悬空引用清单（可选——仅 list 分组返回）。
      dangling: { type: "array", items: groupDanglingEntry },
      // 0.4 收尾：repair 返回的清理条数与清理后剩余悬空条数（可选——仅 repair 分支
      // 返回）。cleaned 只数本次实际摘除的 (topicKey, group) 对（写时已不存在的
      // 挂载不计）；remaining 按提交后重读的清单计算，重读失败时缺省并附 warning。
      cleaned: { type: "integer" },
      remaining: { type: "integer" },
      // repair 提交后重读失败时的提示（已提交的 cleaned 仍然有效，remaining 不给）。
      warning: { type: "string" },
    },
  },

  // ── L2 sparks ───────────────────────────────────────────────
  spark_save: {
    type: "object",
    additionalProperties: false,
    properties: { ...sparkReceiptProperties },
  },
  spark_read: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      tool: { type: "string", required: true },
      scope: { ...hexRev, required: true },
      id: { type: "string", required: true },
      revision: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
      title: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
      summary: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
      triggers: { type: "array", items: { type: "string" }, required: true },
      entities: { type: "array", items: { type: "string" }, required: true },
      links: {
        type: "array",
        required: true,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            target: { type: "string", required: true },
            rel: { oneOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      },
      content: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
      vitality: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
      state: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
    },
  },
  spark_update: {
    type: "object",
    additionalProperties: false,
    properties: { ...sparkReceiptProperties },
  },
  spark_forget: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...sparkReceiptProperties,
      mode: { type: "string", required: true },
      replacementId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
    },
  },
  spark_feedback: {
    type: "object",
    additionalProperties: false,
    properties: {
      ...sparkReceiptProperties,
      used: { type: "boolean", required: true },
      sourceEventId: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
    },
  },
  spark_graph: {
    type: "object",
    additionalProperties: false,
    properties: {
      ok: { type: "boolean", required: true },
      tool: { type: "string", required: true },
      scope: { ...hexRev, required: true },
      handle: { type: "string", required: true },
      summary: {
        type: "object",
        additionalProperties: false,
        required: true,
        properties: {
          nodes: { type: "integer", required: true },
          edges: { type: "integer", required: true },
          vitality: {
            type: "object",
            additionalProperties: false,
            required: true,
            properties: {
              evergreen: { type: "integer", required: true },
              ephemeral: { type: "integer", required: true },
              unknown: { type: "integer", required: true },
            },
          },
          droppedRecords: { type: "integer", required: true },
          droppedEdges: { type: "integer", required: true },
        },
      },
      hint: { type: "string", required: true },
    },
  },
});

/** 17 个工具名（契约清单；S3 起含 group_manage）。 */
export const TOOL_NAMES = Object.freeze([
  "soul_read", "soul_update",
  "memory_read", "memory_search", "memory_append", "memory_rewrite",
  "core_write", "topic_append", "topic_create", "memory_list_topics",
  "group_manage",
  "spark_save", "spark_read", "spark_update", "spark_forget", "spark_feedback", "spark_graph",
]);

/**
 * 工具输出 render：返回宿主 tool-result 的 content block 数组。
 * 宿主 createSuccessResult 直接把 render 返回值当作 result.content
 * （@deepseek-ai/dsh-tools lib/index.js:3637-3648），随后对 content 调
 * `.some((block) => block.type === "image")`（同文件 :1454）——返回字符串会
 * 直接抛 `content.some is not a function`，整条工具链失败。
 * 形状固定为 `[{ type: "text", text: <紧凑 JSON> }]`（错误对象不允许进入 render）。
 */
export function renderToolOutput(_args, value) {
  return [{ type: "text", text: JSON.stringify(value) }];
}
