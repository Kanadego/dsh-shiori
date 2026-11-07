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
// - organize proposal 严格沿用 buildDraft 形状（link / merge-topic / thin-core
//   三种 kind；thin-core 字段照 queue.buildThinCoreDraft：{kind,before,after}）；
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

// F4 时间线条目（getTimeline.items[]；面板渲染字段：时间 / 动作 / 来源 /
// scope / 对象 / 可回跳 id）。
const timelineTarget = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { enum: ["core", "topic", "spark"] },
    id: nonEmptyString,
    title: { oneOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["type", "id", "title"],
};

const timelineItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    at: nonEmptyString,
    action: nonEmptyString,
    source: { enum: ["journal", "spark"] },
    scope: nonEmptyString,
    target: timelineTarget,
    detail: { type: "object", additionalProperties: true },
  },
  required: ["at", "action", "source", "scope", "target", "detail"],
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
    {
      // thin-core proposal：与 queue.buildThinCoreDraft 的 proposal 入参同形
      // （exact keys {kind, before, after}；before/after 为 core 正文全文，
      // 允许空串——初始 L1 core 即空文本）。执行器 executeThinCoreRound 首跑
      // 要求当前 core 正文逐字节等于 before，重放判定 after。
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["thin-core"] },
        before: { type: "string" },
        after: { type: "string" },
      },
      required: ["kind", "before", "after"],
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
            body: { type: "string" },
            revision: { oneOf: [{ type: "string" }, { type: "null" }] },
            chars: { type: "integer" },
            budget: { type: "integer" },
            hardCap: { type: "integer" },
          },
          required: ["text", "body", "revision", "chars", "budget", "hardCap"],
        },
      },
      required: ["scope", "l0", "l1"],
    },
  },

  // F2 闪回命中可见性：nodes 追加 hitCount / lastHitAt / createdAt（可选字段，
  // 旧客户端忽略即可）；顶层追加 deliveries（最近投递明细，上限 20 条——
  // 只含投递元数据，绝不含卡片正文 / 摘要）与 deliveryStats（L2 投递账本
  // 全量口径的吞吐统计：轮次 / 总投递张数 / 去重后卡片数；重复投递率由
  // 1 - uniqueCards/totalDelivered 计算，账本只覆盖 L2 开启期间）。
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
              hitCount: { type: "integer", minimum: 0 },
              lastHitAt: { oneOf: [{ type: "string" }, { type: "null" }] },
              createdAt: { oneOf: [{ type: "string" }, { type: "null" }] },
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
        deliveries: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              deliveryId: nonEmptyString,
              at: nonEmptyString,
              sessionId: nonEmptyString,
              cards: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    sparkId: nonEmptyString,
                    // 命中触发词：老投递（富化字段落账前）如实给 null。
                    trigger: { oneOf: [{ type: "string" }, { type: "null" }] },
                    // 来源：seed=0 跳种子 / related=一跳关联；老投递给 null。
                    source: { oneOf: [{ enum: ["seed", "related"] }, { type: "null" }] },
                  },
                  required: ["sparkId", "trigger", "source"],
                },
              },
            },
            required: ["deliveryId", "at", "sessionId", "cards"],
          },
        },
        deliveryStats: {
          type: "object",
          additionalProperties: false,
          properties: {
            // 投递轮次：committed 终态的投递包数。
            rounds: { type: "integer", minimum: 0 },
            // 总投递张数：各投递包 delivered 卡片数之和（同一张卡重复进包会重复计）。
            totalDelivered: { type: "integer", minimum: 0 },
            // 去重后卡片数：全周期出现过的不同 sparkId 数。
            uniqueCards: { type: "integer", minimum: 0 },
          },
          required: ["rounds", "totalDelivered", "uniqueCards"],
        },
      },
      required: ["scope", "nodes", "edges", "deliveries", "deliveryStats"],
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
    // 可选 limit / offset 分页（缺省都不传 = 不分页，行为与旧版一致）。
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 0 },
        offset: { type: "integer", minimum: 0 },
      },
    },
    // total/groups/statusCounts/staleCount 为增量字段（groups/statusCounts/
    // staleCount 按分页前全量 items 计数）；items 内 candidate.sources 增量补
    // title、条目增量补 stale（该候选任一源的 revision 与 records 不一致、
    // 源卡已不在 records 或 ref.revision 缺失/非整数即过期，fail-closed；
    // queueItemEntry 为 additionalProperties:true，无需改条目形状）。
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        queueRevision,
        items: { type: "array", items: queueItemEntry },
        plans: { type: "array", items: planSummary },
        total: { type: "integer", minimum: 0 },
        staleCount: { type: "integer", minimum: 0 },
        groups: {
          type: "object",
          additionalProperties: false,
          properties: {
            cluster: { type: "integer", minimum: 0 },
            link: { type: "integer", minimum: 0 },
            isolated: { type: "integer", minimum: 0 },
          },
          required: ["cluster", "link", "isolated"],
        },
        statusCounts: {
          type: "object",
          additionalProperties: false,
          properties: {
            pending: { type: "integer", minimum: 0 },
            reviewed: { type: "integer", minimum: 0 },
            dismissed: { type: "integer", minimum: 0 },
          },
          required: ["pending", "reviewed", "dismissed"],
        },
      },
      required: ["queueRevision", "items", "plans", "total", "groups", "statusCounts", "staleCount"],
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
        {
          // 0.2.2 专题归档/恢复：archive:true = 归档，false = 恢复。
          // 无候选/无队列事务，required 三键；operationId 可选——P-A 作废
          // 标记（supersedeOpen）用它，缺省落 null，executePlan 硬闸仍生效。
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { enum: ["archive-topic"] },
            topicKey: nonEmptyString,
            archive: { type: "boolean" },
            operationId,
          },
          required: ["kind", "topicKey", "archive"],
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

  // F4 最近变更时间线：双源（journal committed + spark 写操作账）合并后
  // 倒序分页；scope 恒取自 trustedContext 解析出的可信 scope（不收 payload
  // 的 scope 字段，不泄露别 scope）。hasMore 供面板渲染下一页按钮；
  // skippedCorrupted 如实上报被跳过的损坏 journal / spark 库数量；
  // scanLimited 如实上报「扫描窗口被截断」，此时 hasMore:false 只代表窗口内到底，
  // 不代表更早的历史不存在。
  getTimeline: {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: nonEmptyString,
        items: { type: "array", items: timelineItem },
        hasMore: { type: "boolean" },
        skippedCorrupted: { type: "integer", minimum: 0 },
        scanLimited: { type: "boolean" },
      },
      required: ["scope", "items", "hasMore", "skippedCorrupted", "scanLimited"],
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
 * organize proposal 三种 kind（link / merge-topic / thin-core）全部照
 * schema 校验，无额外早退。
 */
export function validateManagementPayload(name, payload) {
  const method = MANAGEMENT_METHODS[name];
  if (method === undefined) {
    const error = new Error(`unknown management method "${String(name)}"`);
    error.code = "INVALID_INPUT";
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
