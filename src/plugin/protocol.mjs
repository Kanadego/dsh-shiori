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
// - organize proposal 严格沿用 buildDraft 形状（link / merge-topic 两种 kind）；
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
    // 真实计划类型（link / merge-topic / archive-topic）：kind 恒为
    // 家族名（organize / forgetting），客户端文案按 proposalKind 出。可选字段，
    // 老服务端与 forgetting 预览不带。
    proposalKind: { enum: ["link", "merge-topic", "archive-topic"] },
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
                    // B2（audit B P2-2）：与 buildDraft 同口径（queue.mjs
                    // assertExactKeys(pair, ['target','rel']) + checkText rel
                    // 1..CARD_LIMITS.relChars=64）——rel 缺省/null/超限在 wire
                    // 层即拒（INVALID_INPUT），不再放行草案层必拒的形状。
                    rel: { type: "string", minLength: 1, maxLength: 64 },
                  },
                  required: ["target", "rel"],
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
            // B2（audit B P2-2）：与 buildDraft 的 validatePlanTopic 同口径
            // （checkText 1..16384）——expectedRevision 为 null 放行 wire、
            // 草案层必拒的矛盾消除。
            expectedRevision: { type: "string", minLength: 1, maxLength: 16384 },
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

// 0.4-S7 getGraph 三条路径的共用 schema 片段：缺省全量 / level=1 分簇 /
// level=2 簇内。节点与边的形状三条路径一致（level=2 节点仍带命中字段），
// 输出用 oneOf 表达（三支互斥：level 分支 required level，全量分支 required nodes）。
const getGraphNodeItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: nonEmptyString,
    title: { oneOf: [{ type: "string" }, { type: "null" }] },
    summary: { oneOf: [{ type: "string" }, { type: "null" }] },
    vitality: { oneOf: [{ type: "string" }, { type: "null" }] },
    revision: { oneOf: [{ type: "integer" }, { type: "null" }] },
    // 0.4 收尾（reviewer attempt-1 必修 1）：补 entities 契约。nodeOut 三条路径
    // （全量 / level=2）恒输出该字段（projectGraph 的 normalizeEntities 已规范化：
    // trim 非空、去重保序、上限 MAX_NODE_ENTITIES=4，脏数据退化为 []），此前
    // additionalProperties:false 下它属于「实现返回契约外字段」的矛盾，谁加一道
    // 输出校验就会炸。客户端 entityKeyOf 按 raw.entities[0] 做实体聚类着色。
    entities: { type: "array", items: nonEmptyString, maxItems: 4 },
    // 0.4 收尾补 degree：management.mjs 的 nodeOut 在全量与 level=2 两条路径恒输出
    // （graph.mjs 的 projectGraph / clusterProjection 已把度算好，nodeOut 兜底 0）。
    // 客户端 nodeRadiusOf 按 raw.degree 放大节点半径。additionalProperties:false
    // 下不声明即「实现返回契约外字段」。两条带节点的路径（全量 / level=2）恒输出，故进 required。
    degree: { type: "integer", minimum: 0 },
    hitCount: { type: "integer", minimum: 0 },
    lastHitAt: { oneOf: [{ type: "string" }, { type: "null" }] },
    createdAt: { oneOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["id", "vitality", "entities", "degree"],
};
const getGraphEdgeItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: nonEmptyString,
    target: nonEmptyString,
    rel: { oneOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["source", "target"],
};
const getGraphDeliveries = {
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    additionalProperties: false,
    properties: {
      deliveryId: nonEmptyString,
      at: nonEmptyString,
      sessionId: nonEmptyString,
      // 0.5-5C：投递触发消息的稳定 id（controller.recordPending 落账的
      // sourceMessageId；§11.5 turnRef 投影）。旧账本记录没有该字段时输出 null，
      // 因此声明为 nullable 且恒输出（required）。
      sourceMessageId: { oneOf: [nonEmptyString, { type: "null" }] },
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
    required: ["deliveryId", "at", "sessionId", "sourceMessageId", "cards"],
  },
};
const getGraphDeliveryStats = {
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
};
// level=1 的簇：key = 主实体（trim 非空）或 __unclustered__；label 展示名；
// count ≥ 1（没有卡片的簇不会出现在输出里）；samples 最多 3 个标题。
const getGraphClusterItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: nonEmptyString,
    label: { type: "string" },
    count: { type: "integer", minimum: 1 },
    samples: { type: "array", maxItems: 3, items: { type: "string" } },
  },
  required: ["key", "label", "count", "samples"],
};
// level=2 顶部的簇头：key/label 与 level=1 同口径；未知簇 count=0、nodes/edges 空。
const getGraphClusterHeader = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: { type: "string" },
    label: { type: "string" },
    count: { type: "integer", minimum: 0 },
  },
  required: ["key", "label", "count"],
};

// ─────────────────────────────────────────────────────────────
// 0.5 批次 4 · C 线：整理向导（首启引导 + 纯规则候选组）
//
// wire 11 → 14 的契约扩展（评审拍板：独立三方法，不动 previewPlan/executePlan；
// 见子任务问答 q-1d92bbf96c2eb618）。语义：
// - onboardingPreview：状态 + 规则提案（无参，零写入）/ 用户编辑后的提案预览
//   （带 proposal，零写入——L1 投影 / historical 清单 / 冷却候选 / diff）；
// - onboardingApply：确认应用。confirmed 必须显式 true；hash 与服务端重算的
//   proposalHash 绑定（不符 REVISION_CONFLICT）；已 completed 拒（INVALID_STATE，
//   一次性）；写入走 service.mutate 单事务（组清单 + topic 元数据）；
// - onboardingMark：「以后再说」（dismissedAt）/「重新开始」（清 dismissedAt）。
//
// 提案形状的深层校验（成员不重不漏、overrides 键 ⊆ 组成员、值级枚举）由
// src/organize/onboarding.mjs 的 validateProposal / assertProposalCoversTopics
// 在 management 层 fail-closed 执行；wire 层的 overrides 放行未知键——本文件的
// DSH 子集校验器不支持 additionalProperties 值约束（同 executeTool.args 口径），
// 不把实现层校验伪装进 schema。
// ─────────────────────────────────────────────────────────────

// 向导提案的组条目（onboardingPreview 输入 / 输出、onboardingApply 输入共用）。
const onboardingProposalGroupItem = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: nonEmptyString,
    title: nonEmptyString,
    members: { type: "array", minItems: 1, items: nonEmptyString },
    defaultRetention: { enum: ["standing", "historical"] },
    // 逐条 retention 调整（可选）：键 = topic key，值 = retention 枚举；键/值级
    // 校验在 validateProposal（见上注：wire 层放行未知键，不复制实现层校验）。
    overrides: { type: "object", additionalProperties: true },
  },
  required: ["key", "title", "members", "defaultRetention"],
};

// 向导提案整体（用户确认/编辑后的形态；groups 1..6 的数量与成员完整性同样
// 由 validateProposal 执行，wire 只约束形状）。
const onboardingProposalShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    groups: { type: "array", minItems: 1, maxItems: 6, items: onboardingProposalGroupItem },
    ungrouped: { type: "array", items: nonEmptyString },
  },
  required: ["groups"],
};

// stateRoot/onboarding.json 标记位的 wire 形状（读取侧归一化后出线；损坏/
// 版本不识别时整块为 null，诊断摘要进 diagnostics）。
const onboardingFlagShape = {
  oneOf: [
    { type: "null" },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        version: { type: "integer" },
        dismissedAt: { oneOf: [nonEmptyString, { type: "null" }] },
        completedAt: { oneOf: [nonEmptyString, { type: "null" }] },
        proposalHash: { oneOf: [nonEmptyString, { type: "null" }] },
      },
      required: ["version", "dismissedAt", "completedAt", "proposalHash"],
    },
  ],
};

// onboardingPreview 的输出（状态模式与预览模式同形状：预览模式 proposal/preview
// 非空、状态模式 preview 恒 null；proposal 在不需要触发或聚类无产出时为 null）。
const onboardingStatusShape = {
  type: "object",
  additionalProperties: false,
  properties: {
    scope: nonEmptyString,
    needed: { type: "boolean" },
    reason: { enum: ["marked", "grouped", "has-historical", "too-few-topics", "needed"] },
    markedKind: { oneOf: [{ enum: ["completed", "dismissed"] }, { type: "null" }] },
    counts: {
      type: "object",
      additionalProperties: false,
      properties: {
        topics: { type: "integer", minimum: 0 },
        groups: { type: "integer", minimum: 0 },
        historical: { type: "integer", minimum: 0 },
        proposed: { type: "integer", minimum: 0 },
      },
      required: ["topics", "groups", "historical", "proposed"],
    },
    flag: onboardingFlagShape,
    proposal: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            hash: planDigest,
            groups: { type: "array", items: onboardingProposalGroupItem },
            ungrouped: { type: "array", items: nonEmptyString },
          },
          required: ["hash", "groups", "ungrouped"],
        },
      ],
    },
    preview: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            hash: planDigest,
            diff: { type: "array", items: diffEntry },
            changedItems: { type: "integer", minimum: 0 },
            summary: { type: "string" },
            // 目标组布局投影（renderL1 纯函数现算，零写入；生产 L1 渲染尚
            // 不传 groups，客户端文案如实标注，见 0.5 批次 4 评审二轮 R2）。
            l1Preview: { type: "string" },
            // 将被标 historical 的 topic（组默认或显式 override 生效者）。
            historical: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  key: nonEmptyString,
                  title: nonEmptyString,
                  source: { enum: ["group", "override"] },
                },
                required: ["key", "title", "source"],
              },
            },
            // 冷却候选 = historical 生效清单（温度引擎的候选人群，同集合另给
            // 一份平铺 key/title，面板两段文案直接渲染）。
            coolingCandidates: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  key: nonEmptyString,
                  title: nonEmptyString,
                },
                required: ["key", "title"],
              },
            },
          },
          required: ["hash", "diff", "changedItems", "summary", "l1Preview", "historical", "coolingCandidates"],
        },
      ],
    },
    // 降级/诊断摘要（additionalProperties:true 块，同 getStatus.diagnostics 口径）：
    // flagError（onboarding.json 损坏/版本不识别的有界摘要）等。无异常不出键。
    diagnostics: { type: "object", additionalProperties: true },
  },
  required: ["scope", "needed", "reason", "markedKind", "counts", "flag", "proposal", "preview"],
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
        // 人设卡清单：<dataRoot>/persona/*.md 的 basename（去 .md），名字升序；
        // 数据根未初始化（inert）或目录不存在时为空数组（绝不报错、绝不建目录）。
        personas: { type: "array", items: { type: "string" } },
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
      required: ["mode", "configured", "personas", "scope", "occupancy", "capabilities", "diagnostics"],
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
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        // 0.4-S7 两级视图：缺省 = 全量兼容路径；1 = 分簇概览；2 = 簇内视图
        // （cluster 选簇，缺省按未知簇给空结果，不抛错）。wire 的 10 方法清单不变。
        level: { enum: [1, 2] },
        cluster: { type: "string" },
      },
    },
    outputSchema: {
      oneOf: [
        {
          // 缺省全量兼容路径：candidates 页 id→title 映射与旧客户端继续走这条。
          type: "object",
          additionalProperties: false,
          properties: {
            scope: nonEmptyString,
            nodes: { type: "array", items: getGraphNodeItem },
            edges: { type: "array", items: getGraphEdgeItem },
            deliveries: getGraphDeliveries,
            deliveryStats: getGraphDeliveryStats,
          },
          required: ["scope", "nodes", "edges", "deliveries", "deliveryStats"],
        },
        {
          // level=1 分簇概览：clusters 按数量降序、同数量按 key 字典序；
          // samples 最多 3 个标题；total = 全部入簇卡数。
          type: "object",
          additionalProperties: false,
          properties: {
            scope: nonEmptyString,
            level: { enum: [1] },
            clusters: { type: "array", items: getGraphClusterItem },
            total: { type: "integer", minimum: 0 },
            deliveries: getGraphDeliveries,
            deliveryStats: getGraphDeliveryStats,
          },
          required: ["scope", "level", "clusters", "total", "deliveries", "deliveryStats"],
        },
        {
          // level=2 簇内视图：节点形状与全量一致（仍带命中字段）；边只保留
          // 两端都在该簇内的；未知 cluster → count 0 + 空 nodes/edges。
          type: "object",
          additionalProperties: false,
          properties: {
            scope: nonEmptyString,
            level: { enum: [2] },
            cluster: getGraphClusterHeader,
            nodes: { type: "array", items: getGraphNodeItem },
            edges: { type: "array", items: getGraphEdgeItem },
            deliveries: getGraphDeliveries,
            deliveryStats: getGraphDeliveryStats,
          },
          required: ["scope", "level", "cluster", "nodes", "edges", "deliveries", "deliveryStats"],
        },
      ],
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
        // B1（audit B P2-1）：执行后的队列收敛结果——applied=false 时收敛
        // 失败但计划已执行（回执不翻转），warning 为可读告警。
        queueConvergence: {
          type: "object",
          additionalProperties: false,
          properties: {
            applied: { type: "boolean" },
            warning: { type: "string" },
          },
          required: ["applied"],
        },
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

  // 0.4 S6 卸载与焚毁（wire 冻结 10 → 11 的唯一一次增项）：焚毁整个 dataRoot。
  // 语义：confirm 必须等于当前 dataRoot 原文（面板按钮与命令行共用
  // src/storage/purge.mjs，行为一致）；只删 dataRoot，stateRoot 与 DSH 配置
  // 不动。安全校验（绝对路径 / 无 .. 段 / 与 stateRoot 不相交 / 非盘符根 /
  // 非主目录 / 非仓库根 / 存在时必须是目录）在 purge 模块 fail-closed 执行，
  // 违反按 INVALID_INPUT 拒绝；目录不存在返回 deleted:false 而不是抛错。
  destroyData: {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        confirm: { type: "string" },
      },
      required: ["confirm"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        deleted: { type: "boolean" },
        files: { type: "integer", minimum: 0 },
        bytes: { type: "integer", minimum: 0 },
        dataRoot: nonEmptyString,
      },
      required: ["deleted", "files", "bytes", "dataRoot"],
    },
  },

  // 0.5 批次 4 · C 线整理向导（wire 12/13/14；契约扩展见本文件向导段注）。
  // 状态 + 规则提案（无参）或编辑后提案预览（带 proposal）；两种模式零写入。
  onboardingPreview: {
    inputSchema: {
      oneOf: [
        {
          // 状态模式：needsOnboarding 五态 + 规则提案 + 标记位回显。
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        {
          // 预览模式：按用户编辑后的提案出预览（成员完整性/overrides 在
          // management 层经 validateProposal + assertProposalCoversTopics 校验）。
          type: "object",
          additionalProperties: false,
          properties: {
            proposal: onboardingProposalShape,
          },
          required: ["proposal"],
        },
      ],
    },
    outputSchema: onboardingStatusShape,
  },

  // 确认应用：confirmed 显式 true + hash 内容绑定 + operationId 幂等（service
  // mutate journal 层）；已 completed 拒（一次性，管理层硬闸）。
  onboardingApply: {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        proposal: onboardingProposalShape,
        hash: planDigest,
        operationId,
        confirmed: { enum: [true] },
      },
      required: ["proposal", "hash", "operationId", "confirmed"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        applied: { type: "boolean" },
        operationId,
        hash: planDigest,
        createdGroups: { type: "integer", minimum: 0 },
        mountedTopics: { type: "integer", minimum: 0 },
        historicalCount: { type: "integer", minimum: 0 },
        // service.mutate 回执摘录（store 提交协议原样片段，含 changes/groups 条目）。
        result: { type: "object", additionalProperties: true },
        completedAt: nonEmptyString,
        // 标记位写盘失败时的有界诊断摘要（数据已落地、completedAt 未写——
        // 重试同一 operationId 由 mutate journal 幂等收尾）；无异常不出键。
        warning: { type: "string" },
      },
      required: ["applied", "operationId", "hash", "createdGroups", "mountedTopics", "historicalCount", "result", "completedAt"],
    },
  },

  // 「以后再说」（写 dismissedAt，可选携带当前提案 hash 供预览与标记位比对）/
  // 「重新开始」（清 dismissedAt）。写盘失败只诊断不阻塞：warning 出摘要。
  onboardingMark: {
    inputSchema: {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            dismiss: { enum: [true] },
            hash: planDigest,
          },
          required: ["dismiss"],
        },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            restart: { enum: [true] },
          },
          required: ["restart"],
        },
      ],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { enum: ["dismiss", "restart"] },
        // 写后标记位（读回的归一化形状；损坏降级时为 null）。
        flag: onboardingFlagShape,
        // 写盘失败的诊断摘要；成功为 null。
        warning: { oneOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["action", "flag", "warning"],
    },
  },

  // 0.5 批次 4 · B 线（wire 15/16/17）：热度参数面板、回放预览与变更审计。
  // 三方法的数值字段（12 项参数、温度 T、字符净变化）在本 JSON Schema 子集里
  // 没有 number 节点可表达，统一以 additionalProperties:true 块承接；字段存在性
  // 与业务校验由 params.mjs（唯一源头）/ replay.mjs 在服务端权威把关，非法即
  // INVALID_INPUT（message 带键名与允许区间）。
  getTemperatureSettings: {
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        // 当前生效的 12 项参数（服务端 liveRefs.temperature 热读后 normalize；
        // 冻结的装配期 settings 仅在热读缺失/失败时兜底）。
        current: { type: "object", additionalProperties: true },
        // 出厂默认 12 项（DEFAULT_TEMPERATURE_PARAMS）。
        defaults: { type: "object", additionalProperties: true },
        // 12 项规格（PARAM_SPECS：min/max/unit/integer?/description），表单渲染依据。
        specs: { type: "object", additionalProperties: true },
        // 三条交叉校验规则（code/left/right/rule），面板逐条展示。
        crossChecks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              code: nonEmptyString,
              left: nonEmptyString,
              right: nonEmptyString,
              rule: { type: "string" },
            },
            required: ["code", "left", "right", "rule"],
          },
        },
        // 恢复线回差（RESTORE_HYSTERESIS）。
        hysteresis: { type: "integer", minimum: 0 },
        // 最近 settings_change 审计（新 → 旧，上限 20 条；只读回放，面板不自己拼）。
        audit: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
        // 账本损坏/读失败时的有界摘要：此时 audit 为 []，面板显示「审计暂不可读」，
        // 不让整个 getTemperatureSettings 失败（可选字段，无异常不出键）。
        auditError: { type: "string" },
      },
      required: ["current", "defaults", "specs", "crossChecks", "hysteresis", "audit"],
    },
  },

  simulateTemperature: {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        params: { type: "object", additionalProperties: true },
      },
      required: ["params"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        // base / candidate 都是 { tiers: {active,cool,cold,frozen} } 分级分布。
        base: { type: "object", additionalProperties: true },
        candidate: { type: "object", additionalProperties: true },
        // 迁级清单（只列 from !== to）：key/scopeId/from/to/T_from/T_to/reason/chars。
        transitions: { type: "array", items: { type: "object", additionalProperties: true } },
        // L1 字符净变化（预估：迁入 cold/frozen − 迁出 cold/frozen）。
        l1DeltaChars: { type: "integer" },
        alarms: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["base", "candidate", "transitions", "l1DeltaChars", "alarms"],
    },
  },

  recordTemperatureChange: {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        params: { type: "object", additionalProperties: true },
        operationId,
      },
      required: ["params", "operationId"],
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        recorded: { type: "boolean" },
        // 同 operationId 重复调用：不重复落账，回放首次结果。
        replay: { type: "boolean" },
        // 键级旧/新值（[{key,from,to}]；从服务端 live settings 取新值）。
        changes: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["recorded", "replay", "changes"],
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
    // B2：required 在嵌套层同样生效（此前只在顶层检查，嵌套 required 是
    // 死元数据——organize proposal 的 after[].required=['target','rel'] 若
    // 不在此强制，缺 rel 仍会漏到草案层才被拒）。
    for (const required of spec.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        failInvalid(`${where}${field ? `.${field}` : ""}.${required} is required`, {
          where,
          field: field ? `${field}.${required}` : required,
        });
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
 * organize proposal 两种 kind（link / merge-topic）全部照
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
