// Shiori P2-L2 · Spark 附件装配与投递提交（纯函数）。
//
// 边界（CONTRACTS §H）：不读写磁盘、不注册 host、不写 seen 状态；
// commitDelivery 只在 accepted === true 时返回「要写入的 seen/hit 变更」，
// 写入由 store 层执行。失败、预算挤掉、工具步骤、system/历史/插件附件
// 输入都不会出现在 delivered 中，因而不会标 seen。
//
// 设计依据：DESIGN §4.3.2 第 3/4 条与 §4.3.3：
//  - 最终附件文本（含 id、标题、来源、分隔符）<= maxChars（默认 600）
//    个 UTF-16 字符；
//  - 正文 <= 100 字符才直接带出，否则用预存 summary + id；
//  - 装不下就降为摘要或跳过低优先级卡，绝不截半句话（不产出部分正文）；
//  - seen 键至少含 scopeId + sessionId + contextEpoch + sparkId + revision；
//    只有成功提交为本轮 user 侧附件的卡才入 seen；hitCount/lastHitAt 只
//    代表成功投递，关联曝光不代表 used（used 只由 spark_feedback 记）。

import { fail, isPlainRecord, describe } from "../core/errors.mjs";
import { seenKeyFor } from "./match.mjs";

export const SPARK_INLINE_MAX_CHARS = 100;
export const SPARK_DEFAULT_MAX_CHARS = 600;
// 块间分隔符，计入 600 预算。
const BLOCK_SEPARATOR = "\n---\n";
const DELIVERY_KIND = "spark-attachment";

// ---------------------------------------------------------------------------
// 入参校验（与 match.mjs 同规则）
// ---------------------------------------------------------------------------

function requireScopeId(scopeId) {
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    fail("INVALID_INPUT", `scopeId must be a non-empty string, got ${describe(scopeId)}`);
  }
  return scopeId;
}

function requireSessionId(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("INVALID_INPUT", `sessionId must be a non-empty string, got ${describe(sessionId)}`);
  }
  return sessionId;
}

function requireContextEpoch(contextEpoch) {
  if (!Number.isInteger(contextEpoch) || contextEpoch < 0) {
    fail("INVALID_INPUT", `contextEpoch must be a non-negative integer, got ${describe(contextEpoch)}`);
  }
  return contextEpoch;
}

// ---------------------------------------------------------------------------
// buildSparkAttachment
// ---------------------------------------------------------------------------

// 候选条目兼容 matchSparks 的 { spark, ... } 包装与裸卡片记录。
function resolveCard(item) {
  const card = isPlainRecord(item) && isPlainRecord(item.spark) ? item.spark : item;
  if (!isPlainRecord(card)) return null;
  if (typeof card.id !== "string" || card.id.length === 0) return null;
  if (!Number.isInteger(card.revision) || card.revision < 0) return null;
  return card;
}

// 正文候选序列：<=100 的正文直接带出，装不下时降为摘要；超过 100 字（或
// 正文缺失）的卡只允许 summary + id（DESIGN §4.3.2 第 3 条）。summary 缺失、
// 为 null 或仅含空白字符（trim 后为空，评审 H2 边缘）都视为没有可用摘要，
// 必须整卡跳过（skipReason "missing-summary"）——绝不产出仅元数据头部或
// 以空白充当正文的"空投递"，更不截半句话。
function bodyOptions(card) {
  const content = typeof card.content === "string" ? card.content : "";
  const rawSummary = typeof card.summary === "string" ? card.summary : "";
  const summary = rawSummary.trim().length > 0 ? rawSummary : "";
  if (content.length > 0 && content.length <= SPARK_INLINE_MAX_CHARS) {
    const options = [content];
    if (summary.length > 0 && summary !== content) options.push(summary);
    return { options, skipReason: null };
  }
  if (summary.length === 0) {
    return { options: [], skipReason: "missing-summary" };
  }
  return { options: [summary], skipReason: null };
}

// 单卡块：头部含 id/revision/标题（来源存在时附加），正文一行。
function renderBlock(card, body) {
  const head = `[spark:${card.id} rev${card.revision}] ${typeof card.title === "string" ? card.title : ""}`
    + (typeof card.source === "string" && card.source.length > 0 ? ` · ${card.source}` : "");
  return body.length > 0 ? `${head}\n${body}` : head;
}

export function buildSparkAttachment({
  scopeId,
  sessionId,
  contextEpoch,
  match,
  maxChars = SPARK_DEFAULT_MAX_CHARS,
} = {}) {
  requireScopeId(scopeId);
  requireSessionId(sessionId);
  requireContextEpoch(contextEpoch);
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    fail("INVALID_INPUT", `maxChars must be a positive integer, got ${describe(maxChars)}`);
  }
  const seeds = match === null || match === undefined ? [] : match.seeds;
  const related = match === null || match === undefined ? [] : match.related;
  if (match !== null && match !== undefined && !isPlainRecord(match)) {
    fail("INVALID_INPUT", `match must be a plain object or null, got ${describe(match)}`);
  }
  if (seeds !== undefined && !Array.isArray(seeds)) {
    fail("INVALID_INPUT", `match.seeds must be an array, got ${describe(seeds)}`);
  }
  if (related !== undefined && !Array.isArray(related)) {
    fail("INVALID_INPUT", `match.related must be an array, got ${describe(related)}`);
  }

  const delivered = [];
  const dropped = [];
  const blocks = [];
  let chars = 0;

  // 种子优先，再用余量装关联（DESIGN §4.3.2 第 3 条）；逐卡二次量测，
  // 元数据（id/标题/来源/分隔符）全部计入。
  for (const item of [...(seeds ?? []), ...(related ?? [])]) {
    const card = resolveCard(item);
    if (!card) {
      fail("INVALID_INPUT", "attachment candidates must reference cards with string id and integer revision");
    }
    if (delivered.some((d) => d.id === card.id)) continue;

    const { options, skipReason } = bodyOptions(card);
    if (options.length === 0) {
      dropped.push({ id: card.id, reason: skipReason });
      continue;
    }
    let placed = false;
    for (const body of options) {
      const block = renderBlock(card, body);
      const extra = blocks.length === 0 ? block.length : BLOCK_SEPARATOR.length + block.length;
      if (chars + extra <= maxChars) {
        blocks.push(block);
        chars += extra;
        delivered.push({ id: card.id, revision: card.revision });
        placed = true;
        break;
      }
    }
    if (!placed) {
      dropped.push({ id: card.id, reason: "budget" });
    }
  }

  const text = blocks.join(BLOCK_SEPARATOR);
  return {
    kind: DELIVERY_KIND,
    scopeId,
    sessionId,
    contextEpoch,
    maxChars,
    text,
    chars: text.length,
    delivered,
    dropped,
  };
}

// ---------------------------------------------------------------------------
// commitDelivery
// ---------------------------------------------------------------------------

// accepted !== true（包括 false）都不产生任何 seen/hit 变更。
// 返回的 seenWrites 键由 match.mjs 的 seenKeyFor 构造，含
// scope/session/contextEpoch/spark/revision 五个成分；hitUpdates 供 store
// 对成功投递的卡 hitCount+1 / 记 lastHitAt（关联曝光不记 used）。
export function commitDelivery({ delivery, accepted } = {}) {
  if (typeof accepted !== "boolean") {
    fail("INVALID_INPUT", `accepted must be a boolean, got ${describe(accepted)}`);
  }
  if (!isPlainRecord(delivery)) {
    fail("INVALID_INPUT", `delivery must be a plain object, got ${describe(delivery)}`);
  }
  if (delivery.kind !== DELIVERY_KIND) {
    fail("INVALID_INPUT", `delivery.kind must be "${DELIVERY_KIND}", got ${describe(delivery.kind)}`);
  }
  const scopeId = requireScopeId(delivery.scopeId);
  const sessionId = requireSessionId(delivery.sessionId);
  const contextEpoch = requireContextEpoch(delivery.contextEpoch);
  if (!Array.isArray(delivery.delivered)) {
    fail("INVALID_INPUT", `delivery.delivered must be an array, got ${describe(delivery.delivered)}`);
  }

  if (accepted !== true) {
    return { accepted: false, seenWrites: [], hitUpdates: [] };
  }

  const seenWrites = [];
  const hitUpdates = [];
  for (const entry of delivery.delivered) {
    const card = resolveCard(entry);
    if (!card) {
      fail("INVALID_INPUT", "delivery.delivered entries must carry string id and integer revision");
    }
    seenWrites.push({
      key: seenKeyFor({ scopeId, sessionId, contextEpoch, sparkId: card.id, revision: card.revision }),
      scopeId,
      sessionId,
      contextEpoch,
      sparkId: card.id,
      revision: card.revision,
    });
    hitUpdates.push({ sparkId: card.id, revision: card.revision });
  }

  return { accepted: true, seenWrites, hitUpdates };
}
