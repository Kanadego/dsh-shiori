// Shiori P5-PLUGIN · 管理 API 冻结 wire 契约（slot P；Q 只使用本文件）。
//
// 契约（CONTRACTS §6）：导出 MANAGEMENT_METHODS（纯 JSON：方法名 →
// {inputSchema, outputSchema}）与 validateManagementPayload(name, payload)，
// 精确实现 P management 的 DTO；Q 只用这份定义为 RPC 绑定/校验。本模块不
// import controller / 宿主 / 业务模块（零副作用）；Q 的并行测试 stub 只用于
// temp 测试，owner 组合必须真实 P。
//
// 规则：
// - queueRevision 为非负整数；operationId 沿现校验（1..128 可见 ASCII）；
//   planId 不透明稳定字符串；planDigest 小写 64 hex；
// - organize proposal 严格沿用 buildDraft 形状；thin-core 明确 UNSUPPORTED；
// - 所有顶层 payload 闭合拒绝未知键；
// - Error.code 词表：INVALID_INPUT / NOT_CONFIGURED / UNSUPPORTED /
//   UNAUTHORIZED / NOT_FOUND / REVISION_CONFLICT / BUDGET_EXCEEDED。

const HEX64 = /^[0-9a-f]{64}$/;

function failInvalid(message, details) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  if (details !== undefined) error.details = details;
  throw error;
}

// ─────────────────────────────────────────────────────────────
// schema 片段（DSH JSON Schema 子集：闭合 object / oneOf / 完整 items）
// ─────────────────────────────────────────────────────────────

const queueRevision = { type: "integer", minimum: 0 };
const operationId = { type: "string", minLength: 1, maxLength: 128, pattern: "^[\\x21-\\x7e]+$" };
const planId = { type: "string", minLength: 1, maxLength: 128 };
const planDigest = { type: "string", pattern: "^[a-f0-9]{64}$" };
const nonEmptyString = { type: "string", minLength: 1 };

const queueItemEntry = {
  type: "object",
  additionalProperties: true,
};

const planSummary = {
  type: "object",
  additionalProperties: false,
  properties: {
    planId,
    kind: { enum: ["organize", "forgetting"] },
    planDigest,
    queueRevision: { oneOf: [queueRevision, { type: "null" }] },
    changedItems: { type: "integer" },
    summary: { type: "string" },
    createdAt: { type: "string" },
    executed: { type: "boolean" },
    // P-A 计划收敛：仍 open 且被更新计划取代的条目如实标注（可选字段；客户端据此禁用执行）。
    superseded: { type: "boolean" },
  },
  required: ["planId", "kind", "planDigest", "changedItems", "summary", "createdAt", "executed"],
};

const diffEntry = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string" },
    oldText: { type: "string" },
    newText: { type: "string" },
  },
  required: ["path", "oldText", "newText"],
};

const planView = {
  type: "object",
  additionalProperties: false,
  properties: {
    planId,
    kind: { enum: ["organize", "forgetting"] },
    planDigest,
    queueRevision: { oneOf: [queueRevision, { type: "null" }] },
    diff: { type: "array", items: diffEntry },
    changedItems: { type: "integer" },
    summary: { type: "string" },
  },
  required: ["planId", "kind", "planDigest", "queueRevision", "diff", "changedItems", "summary"],
};

const organizeProposal = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["link"] },
        links: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: nonEmptyString,
              after: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    target: nonEmptyString,
                    rel: { oneOf: [{ type: "string" }, { type: "null" }] },
                  },
                  required: ["target"],
                },
              },
            },
            required: ["id", "after"],
          },
        },
      },
      required: ["kind", "links"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["merge-topic"] },
        topic: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: nonEmptyString,
            expectedRevision: { oneOf: [{ type: "string" }, { type: "null" }] },
            before: { type: "string" },
            after: { type: "string" },
            title: nonEmptyString,
            summary: { type: "string" },
            updated: nonEmptyString,
          },
          required: ["key", "expectedRevision", "before", "after", "title", "summary", "updated"],
        },
      },
      required: ["kind", "topic"],
    },
  ],
};

// ─────────────────────────────────────────────────────────────
// MANAGEMENT_METHODS：方法名 → {inputSchema, outputSchema}
// ─────────────────────────────────────────────────────────────

export const MANAGEMENT_METHODS = Object.freeze({
  getStatus: {
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mode: { enum: ["shadow", "active", "inert"] },
        configured: { type: "boolean" },
        scope: { oneOf: [{ type: "string" }, { type: "null" }] },
        occupancy: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                l0Chars: { type: "integer" },
                l1Chars: { type: "integer" },
                l0Budget: { type: "integer" },
                l1HardCap: { type: "integer" },
              },
              required: ["l0Chars", "l1Chars", "l0Budget", "l1HardCap"],
            },
            { type: "null" },
          ],
        },
        capabilities: {
          type: "object",
          additionalProperties: false,
          properties: {
            l2: { type: "boolean" },
            organize: { type: "boolean" },
            forgetting: { type: "boolean" },
            tools: { type: "boolean" },
            sections: { type: "boolean" },
          },
          required: ["l2", "organize", "forgetting", "tools", "sections"],
        },
        diagnostics: { type: "object", additionalProperties: true },
      },
      required: ["mode", "configured", "scope", "occupancy", "capabilities", "diagnostics"],
    },
  },

  getMemoryView: {
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: nonEmptyString,
        l0: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                text: { oneOf: [{ type: "string" }, { type: "null" }] },
                revision: { oneOf: [{ type: "string" }, { type: "null" }] },
                chars: { type: "integer" },
                budget: { type: "integer" },
                stale: { type: "boolean" },
              },
              required: ["text", "revision", "chars", "budget", "stale"],
            },
            { type: "null" },
          ],
        },
        l1: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            revision: { oneOf: [{ type: "string" }, { type: "null" }] },
            chars: { type: "integer" },
            budget: { type: "integer" },
            hardCap: { type: "integer" },
          },
          required: ["text", "revision", "chars", "budget", "hardCap"],
        },
      },
      required: ["scope", "l0", "l1"],
    },
  },

  getGraph: {
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: nonEmptyString,
        nodes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: nonEmptyString,
              title: { oneOf: [{ type: "string" }, { type: "null" }] },
              summary: { oneOf: [{ type: "string" }, { type: "null" }] },
              vitality: { oneOf: [{ type: "string" }, { type: "null" }] },
              revision: { oneOf: [{ type: "integer" }, { type: "null" }] },
            },
            required: ["id", "vitality"],
          },
        },
        edges: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: nonEmptyString,
              target: nonEmptyString,
              rel: { oneOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["source", "target"],
          },
        },
      },
      required: ["scope", "nodes", "edges"],
    },
  },

  executeTool: {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: nonEmptyString,
        args: { type: "object", additionalProperties: true },
      },
      required: ["name"],
    },
    outputSchema: { type: "object", additionalProperties: true },
  },

  listCandidates: {
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        queueRevision,
        items: { type: "array", items: queueItemEntry },
        plans: { type: "array", items: planSummary },
      },
      required: ["queueRevision", "items", "plans"],
    },
  },

  analyze: {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["organize", "forgetting"] },
        operationId,
        expectedQueueRevision: { oneOf: [queueRevision, { type: "null" }] },
      },
      required: ["kind", "operationId"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        queueRevision: { oneOf: [queueRevision, { type: "null" }] },
        items: { type: "array", items: queueItemEntry },
        plans: { type: "array", items: planSummary },
        analysis: { type: "object", additionalProperties: true },
      },
      required: ["queueRevision", "items", "plans", "analysis"],
    },
  },

  reviewCandidate: {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        candidateId: { type: "string", pattern: "^[0-9a-f]{64}$" },
        decision: { enum: ["reviewed", "dismissed"] },
        expectedQueueRevision: queueRevision,
        operationId,
      },
      required: ["candidateId", "decision", "expectedQueueRevision", "operationId"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        queueRevision,
        items: { type: "array", items: queueItemEntry },
        plans: { type: "array", items: planSummary },
      },
      required: ["queueRevision", "items", "plans"],
    },
  },

  previewPlan: {
    inputSchema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { enum: ["organize"] },
            candidateId: { type: "string", pattern: "^[0-9a-f]{64}$" },
            proposal: organizeProposal,
            expectedQueueRevision: queueRevision,
            operationId,
          },
          required: ["kind", "candidateId", "proposal", "expectedQueueRevision", "operationId"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { enum: ["forgetting"] },
            planId,
          },
          required: ["kind", "planId"],
        },
      ],
    },
    outputSchema: planView,
  },

  executePlan: {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        planId,
        planDigest,
        operationId,
        confirmed: { enum: [true] },
      },
      required: ["planId", "planDigest", "operationId", "confirmed"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        planId,
        planDigest,
        operationId,
        result: { type: "object", additionalProperties: true },
      },
      required: ["planId", "planDigest", "operationId", "result"],
    },
  },
});

/** 管理 API 方法名集合。 */
export const MANAGEMENT_METHOD_NAMES = Object.freeze(Object.keys(MANAGEMENT_METHODS));

function validateClosedObject(payload, schema, where) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    failInvalid(`${where}: payload must be a plain object`, { where });
  }
  const properties = schema.properties ?? {};
  for (const key of Object.keys(payload)) {
    if (!Object.hasOwn(properties, key)) {
      failInvalid(`${where}: unknown payload key "${key}" (closed object)`, { where, key });
    }
  }
}

function checkEnum(value, spec, where, field) {
  if (!spec.enum.includes(value)) {
    failInvalid(`${where}.${field} must be one of ${JSON.stringify(spec.enum)}`, { where, field, value });
  }
}

function checkBasicType(value, spec, where, field) {
  if (spec.type === "string") {
    if (typeof value !== "string") failInvalid(`${where}.${field} must be a string`, { where, field });
    if (spec.minLength !== undefined && value.length < spec.minLength) {
      failInvalid(`${where}.${field} must have at least ${spec.minLength} chars`, { where, field });
    }
    if (spec.maxLength !== undefined && value.length > spec.maxLength) {
      failInvalid(`${where}.${field} must have at most ${spec.maxLength} chars`, { where, field });
    }
    if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) {
      failInvalid(`${where}.${field} does not match the required pattern`, { where, field });
    }
    return;
  }
  if (spec.type === "integer") {
    if (!Number.isInteger(value)) failInvalid(`${where}.${field} must be an integer`, { where, field });
    if (spec.minimum !== undefined && value < spec.minimum) {
      failInvalid(`${where}.${field} must be >= ${spec.minimum}`, { where, field });
    }
    if (spec.maximum !== undefined && value > spec.maximum) {
      failInvalid(`${where}.${field} must be <= ${spec.maximum}`, { where, field });
    }
    return;
  }
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") failInvalid(`${where}.${field} must be a boolean`, { where, field });
    return;
  }
  failInvalid(`${where}.${field}: unsupported schema node (contract bug)`, { where, field });
}

/** 递归校验（子集：object 闭合 / string / integer / boolean / enum / oneOf / array / type:null）。 */
function validateNode(value, spec, where, field) {
  if (spec.oneOf !== undefined) {
    const violations = [];
    for (const branch of spec.oneOf) {
      try {
        validateNode(value, branch, where, field);
        return; // 恰一分支通过（尝试按序；分支形状互斥由契约保证）
      } catch (error) {
        violations.push(error instanceof Error ? error.message : String(error));
      }
    }
    failInvalid(`${where}.${field} does not match any allowed shape`, { where, field, violations });
  }
  if (spec.enum !== undefined) {
    checkEnum(value, spec, where, field);
    return;
  }
  if (spec.type === "object") {
    // additionalProperties:true（如 executeTool.args 的工具原样 payload）放行未知键；
    // 其余管理 DTO 顶层一律闭合拒绝。
    if (spec.additionalProperties !== true) {
      validateClosedObject(value, spec, `${where}${field ? `.${field}` : ""}`);
    }
    for (const [key, sub] of Object.entries(spec.properties ?? {})) {
      if (Object.hasOwn(value, key)) {
        validateNode(value[key], sub, where, field ? `${field}.${key}` : key);
      }
    }
    return;
  }
  if (spec.type === "array") {
    if (!Array.isArray(value)) failInvalid(`${where}.${field} must be an array`, { where, field });
    if (spec.minItems !== undefined && value.length < spec.minItems) {
      failInvalid(`${where}.${field} must have at least ${spec.minItems} items`, { where, field });
    }
    if (spec.items !== undefined) {
      value.forEach((item, index) => validateNode(item, spec.items, where, `${field}[${index}]`));
    }
    return;
  }
  if (spec.type === "null") {
    if (value !== null) failInvalid(`${where}.${field} must be null`, { where, field });
    return;
  }
  checkBasicType(value, spec, where, field);
}

/**
 * 校验管理 payload（wire 层闭包校验；Q 在 RPC 入口调用，P 在 management
 * 入口再调用一次）。通过返回 payload 原引用；失败抛 code=INVALID_INPUT。
 * thin-core proposal 在此被拒绝（UNSUPPORTED，不以 INVALID_INPUT 冒名）。
 */
export function validateManagementPayload(name, payload) {
  const method = MANAGEMENT_METHODS[name];
  if (method === undefined) {
    const error = new Error(`unknown management method "${String(name)}"`);
    error.code = "INVALID_INPUT";
    throw error;
  }
  // thin-core 明确 UNSUPPORTED（先于形状匹配，避免被误报 INVALID_INPUT）。
  if (name === "previewPlan" && payload?.proposal?.kind === "thin-core") {
    const error = new Error("thin-core proposals are not executable and unsupported by previewPlan");
    error.code = "UNSUPPORTED";
    throw error;
  }
  const schema = method.inputSchema;
  if (schema.oneOf !== undefined) {
    const violations = [];
    let matched = false;
    for (const branch of schema.oneOf) {
      try {
        validateClosedObject(payload, branch, name);
        for (const [key, sub] of Object.entries(branch.properties ?? {})) {
          if (Object.hasOwn(payload, key)) validateNode(payload[key], sub, name, key);
        }
        for (const required of branch.required ?? []) {
          if (!Object.hasOwn(payload, required)) {
            failInvalid(`${name}.${required} is required`, { method: name, field: required });
          }
        }
        matched = true;
        break;
      } catch (error) {
        violations.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (!matched) {
      const error = new Error(`${name}: payload does not match any allowed shape`);
      error.code = "INVALID_INPUT";
      error.details = { violations };
      throw error;
    }
  } else {
    validateClosedObject(payload, schema, name);
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(payload, key)) validateNode(payload[key], sub, name, key);
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(payload, required)) {
        failInvalid(`${name}.${required} is required`, { method: name, field: required });
      }
    }
  }
  // thin-core 已在上方拦截（UNSUPPORTED）。
  return payload;
}

/** Error.code 词表（Q 用宿主 RemoteResult 保留 code，不把失败伪装成功）。 */
export const MANAGEMENT_ERROR_CODES = Object.freeze([
  "INVALID_INPUT",
  "NOT_CONFIGURED",
  "UNSUPPORTED",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "REVISION_CONFLICT",
  "BUDGET_EXCEEDED",
]);
