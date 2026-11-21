// Shiori 0.5 批次 4 · D 线：L2 投递诊断账本（纯函数 + 注入式读取）。
//
// 职责（任务书硬要求 1/2/5 + 评审 q-50d63bd04a86684e 拍板）：
// - buildRoundRecord：把一轮 pre-step 的召回/投递结果折叠成一条「不含正文」的
//   诊断记录（version: 1，字段名严格白名单 RECORD_FIELDS / REJECT_KEYS），并做
//   逐卡未投递归因（为什么这张卡这轮没出现）。记录只存 id 与计数，绝不存
//   message/user 文本、标题、summary、triggers、正文片段——卡内容只在 spark
//   store 一处存在，账本只记 id 与数字证据（测试以已知 content 卡做子串检查）。
// - trimRecords：7 天滚动裁旧 + 硬上限（先按天裁再按条数裁，两边都留最新）。
// - readDiagnostics({ scopeId, days, ... })：按窗口聚合出每卡覆盖率（窗口内投递
//   次数 / used 次数 / 最后命中）与两张清单「从未投递」「高频投递但低使用」；
//   从未投递再归因（rounds 为该卡 createdAt 之后的有效召回轮次——评审 R2）：
//     · no-recall-rounds       该卡创建以来还没有任何有效召回轮次（「那段时间
//                              没聊到」；记录只在召回真正跑过时才落账）；
//     · matched-not-delivered  有命中轮次但从未投出（slot_full / seen_cooldown：
//                              命中或达标却被 3+2 槽位/预算挤掉或冷却——含被
//                              seedCap/MAX_ANCHORS 截断的字面命中，评审 R1）；
//     · below-threshold        有轮次且被语义评分过、全部低于阈值（「聊到了但
//                              没识别出来」。证明 = scoredRounds 与 topScore——
//                              逐轮记录的余弦分最大值恒 < 阈值）；
//     · not-scored            评审 R14：有轮次但从未被语义评分（scoredRounds=0、
//                              topScore=null——没有 below-threshold 的证明，不得
//                              冒用该归因）。semanticEnabled 标注语义开关：关闭
//                              （默认 provider=none）时面板不得建议「重建向量」
//                              （状态页该按钮在 provider=none 下是禁用的）；
//     · evidence-truncated     评审 R6：无任何逐卡证据、但有明细被截断的轮次
//                              （封顶的代价）——证据不足，不默认 below-threshold。
//
// 归因取值形态（评审拍板 + 封顶修正）：
//   rejectReasons.literal_miss            本轮完全无信号卡片的数量（number；基线
//                                         归因不逐卡记，控制账本体积）
//   rejectReasons.semantic_below_threshold{ total, scores: { sparkId: 余弦分 } }，
//                                         scores 取「最高分的至多 20 张」——越接
//                                         近阈值的卡越有诊断价值（差一点就命中），
//                                         是「分数始终低于阈值」最高分证明的数据源
//   rejectReasons.seen_cooldown           { total, ids: [...] }，ids 至多 50 条
//                                         （seen 冷却：字面命中进 anchors 的 +
//                                         语义可行但被 seen 预过滤的）
//   rejectReasons.slot_full               { total, ids: [...] }，ids 至多 50 条
//                                         （命中/达标但没投出：种子槽满、附件预算
//                                         挤掉（含缺摘要整卡跳过））
//   semanticBuckets                       { hit, near, cold }：本轮被语义评分卡片
//                                         按余弦分桶计数（hit = ≥阈值，near = 距
//                                         阈值 NEAR_MARGIN 以内，cold = 其余）
//   封顶代价（如实声明）：超出封顶的卡该轮没有逐卡分数证据，跨轮归因里这些轮
//   不计入 scoredRounds / 不抬高 topScore（total 保留总数可见）。小 scope（
//   active 卡 ≤ 20 张）不受影响；大 scope 的长尾低分卡归因退化为基线口径。
//
// 边界：零 IO、零时钟读取——落盘由 state.mjs 的 diagnostics 账本承担（非阻塞
// 写、失败只告警），readDiagnostics 的 records / 卡片统计由调用方注入
// （controller 接 state.diagnosticsStore.readRecords 与 sparkStore.listActive；
// 测试注入夹具）。本模块不改 match/delivery/semantic-recall 的任何判定。

import { fail, isPlainRecord, describe } from "../core/errors.mjs";

/** 诊断记录滚动窗口（天）：裁掉 at 早于 now-7d 的记录。 */
export const DIAGNOSTICS_RETENTION_DAYS = 7;

/** 账本硬上限（条）：先按 7 天裁再按此裁，防高频会话把文件撑爆（水线同款思路）。 */
export const DIAGNOSTICS_MAX_RECORDS = 2000;

/** 记录 schema 版本（前向兼容：读取侧按 version 识别形状演化）。 */
export const DIAGNOSTICS_RECORD_VERSION = 1;

/** near 桶宽度常量（评审硬要求：不许写死魔数）：距阈值 NEAR_MARGIN 以内的低分
 *  卡算「贴近阈值」。桶划分随传入阈值走（阈值可配时跟着配置走）。 */
export const NEAR_MARGIN = 0.1;

/** 「高频投递但低使用」的窗口内投递次数下限。 */
export const DELIVERY_LOW_USE_MIN_DELIVERIES = 3;

/** 逐卡明细封顶：below-threshold 保留最高分至多 20 张（差一点就命中的卡最有
 *  诊断价值）；seen_cooldown / slot_full 各至多 50 条。超出只记总数。 */
export const SCORE_DETAIL_CAP = 20;
export const ID_DETAIL_CAP = 50;

/** 诊断记录字段白名单（严格 8 项；测试逐字段断言）。 */
export const RECORD_FIELDS = Object.freeze([
  "version", "at", "scopeId", "literalHits", "semanticTopScore", "semanticBuckets", "deliveredIds", "rejectReasons",
]);

/** rejectReasons 子字段白名单（严格 4 项）。 */
export const REJECT_KEYS = Object.freeze([
  "literal_miss", "semantic_below_threshold", "seen_cooldown", "slot_full",
]);

/** semanticBuckets 子字段白名单（严格 3 项）。 */
export const BUCKET_KEYS = Object.freeze(["hit", "near", "cold"]);

// ---------------------------------------------------------------------------
// 入参校验
// ---------------------------------------------------------------------------

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_INPUT", `${name} must be a non-empty string, got ${describe(value)}`);
  }
  return value;
}

function requireFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_INPUT", `${name} must be a finite number, got ${describe(value)}`);
  }
  return value;
}

/** 记录里的 at：非空字符串且可解析（写侧由调用方 nowIso() 产出；容忍毫秒数便于测试）。 */
function recordAtToMs(at) {
  if (typeof at === "number") return Number.isFinite(at) ? at : null;
  if (typeof at !== "string" || at.length === 0) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** 卡片 id 提取：接受 {id} 条目（seeds/anchors/delivered 都带 id）。 */
function idOf(item, where) {
  const id = item && typeof item === "object" ? item.id : undefined;
  if (typeof id !== "string" || id.length === 0) {
    fail("INVALID_INPUT", `${where} entries must carry a non-empty string id`);
  }
  return id;
}

function idArrayOf(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("INVALID_INPUT", `${name} must be an array, got ${describe(value)}`);
  return value.map((item) => idOf(item, name));
}

/** 纯字符串 id 数组（semantic.cooledIds 的产出形状：语义召回直接 push card.id）。 */
function stringIdArrayOf(value, name) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("INVALID_INPUT", `${name} must be an array, got ${describe(value)}`);
  return value.map((id) => requireNonEmptyString(id, `${name} entry`));
}

/** semantic.scored 形状校验：{ sparkId: 余弦分 }，值必须有限数。 */
function requireScoredMap(value, name) {
  if (value === undefined || value === null) return {};
  if (!isPlainRecord(value)) fail("INVALID_INPUT", `${name} must be a plain object, got ${describe(value)}`);
  const scored = {};
  for (const [id, cos] of Object.entries(value)) {
    requireNonEmptyString(id, `${name} key`);
    if (typeof cos !== "number" || !Number.isFinite(cos)) {
      fail("INVALID_INPUT", `${name}[${JSON.stringify(id)}] must be a finite number`);
    }
    scored[id] = cos;
  }
  return scored;
}

// ---------------------------------------------------------------------------
// buildRoundRecord：一轮召回/投递 → 一条诊断记录
// ---------------------------------------------------------------------------

/**
 * 折叠一轮 pre-step 的召回与投递结果。
 *
 * @param {object} args
 * @param {string} args.at 本轮时间（调用方 nowIso() 产出）
 * @param {string} args.scopeId
 * @param {Array<object>} args.cards 本轮参与召回的卡片清单（sparkStore.listActive 结果，
 *   只读 id 做归因，绝不读内容字段）
 * @param {object|null} [args.match] mergeSemanticRecall 的合并结果（seeds/related/anchors，
 *   0.5-4D 起另带 literalHitIds = 全量字面命中 id，含被 seedCap/MAX_ANCHORS 截断的
 *   候选；旧结果缺该字段时回落 seeds ∪ anchors 截断后口径）
 * @param {object|null} [args.semantic] 扩展语义诊断块 { enabled, used, threshold,
 *   candidates, error, topScore, scored, cooledIds }（scored = { sparkId: 余弦分 }，
 *   cooledIds = 语义可行但被 seen 预过滤的卡）
 * @param {object|null} [args.delivery] buildSparkAttachment 结果（delivered/dropped）
 * @param {string[]} [args.appendedIds] 本轮真正附加进对话的卡 id（评审 R4：与
 *   delivery.delivered 解耦——包构建后可能因去重/宿主中止未追加）。缺省 = 全部
 *   候选（「构建即投」旧口径）；给出时必须是候选子集，未追加的候选落 slot_full
 *   （命中/达标但没投出），record.deliveredIds 只收真正附加的卡
 * @param {number} [args.threshold] 语义阈值（与 semantic.threshold 一致；分桶用）
 * @returns {object} version:1、字段白名单严格的诊断记录
 */
export function buildRoundRecord({
  at,
  scopeId,
  cards,
  match = null,
  semantic = null,
  delivery = null,
  appendedIds,
  threshold,
} = {}) {
  requireNonEmptyString(at, "at");
  if (recordAtToMs(at) === null) fail("INVALID_INPUT", "at must be a parseable timestamp");
  requireNonEmptyString(scopeId, "scopeId");
  if (!Array.isArray(cards)) fail("INVALID_INPUT", `cards must be an array, got ${describe(cards)}`);

  const seedIds = idArrayOf(match?.seeds, "match.seeds");
  const anchorIds = idArrayOf(match?.anchors, "match.anchors");
  // R1：全量字面命中 id（含被截断的 seed/anchor 候选）；旧 match 结果缺字段时
  // 回落 seeds ∪ anchors（截断后口径，并在 returned.literalHits 上如实反映）。
  const literalHitIds = match !== null && isPlainRecord(match) && Array.isArray(match.literalHitIds)
    ? stringIdArrayOf(match.literalHitIds, "match.literalHitIds")
    : [...new Set([...seedIds, ...anchorIds])];
  const candidateIds = idArrayOf(delivery?.delivered, "delivery.delivered");
  const droppedIds = idArrayOf(delivery?.dropped, "delivery.dropped");
  const scored = requireScoredMap(semantic?.scored, "semantic.scored");
  const cooledIds = stringIdArrayOf(semantic?.cooledIds, "semantic.cooledIds");

  const resolvedThreshold = threshold === undefined ? semantic?.threshold : threshold;
  if (resolvedThreshold !== undefined && resolvedThreshold !== null) {
    requireFiniteNumber(resolvedThreshold, "threshold");
  }

  // R4：deliveredIds = 真正附加进本轮的卡（appendedIds）；构建了但未追加的候选
  // 落 slot_full（命中/达标但没投出——包被去重/中止挡下），不得虚增投递次数。
  let appendedList = candidateIds;
  if (appendedIds !== undefined) {
    const list = stringIdArrayOf(appendedIds, "appendedIds");
    const candidates = new Set(candidateIds);
    for (const id of list) {
      if (!candidates.has(id)) {
        fail("INVALID_INPUT", `appendedIds entry ${JSON.stringify(id)} is not in delivery.delivered candidates`);
      }
    }
    appendedList = list;
  }

  // 逐轮归因集合。优先级：delivered > seen_cooldown > slot_full >
  // semantic_below_threshold > literal_miss；四个 reject 桶互斥（每卡每轮至多
  // 记入一个桶），构造时显式从后续桶剔除前面桶的成员。
  const delivered = new Set(appendedList);
  const seedSet = new Set(seedIds);
  const anchorSet = new Set(anchorIds);
  const seenCooldown = new Set([...anchorIds, ...cooledIds].filter((id) => !delivered.has(id)));

  const highIds = new Set();   // cos >= threshold（命中语义阈值）
  const lowScores = {};        // cos < threshold
  for (const [id, cos] of Object.entries(scored)) {
    const above = resolvedThreshold === undefined || resolvedThreshold === null
      ? false
      : cos >= resolvedThreshold;
    if (above) highIds.add(id);
    else lowScores[id] = cos;
  }
  // slot_full（命中/达标但没投出）：附件层挤掉（budget / missing-summary）∪
  // 构建了但本轮未追加的候选（R4）∪ 语义达标但没进 attachment 的（种子槽满截断）
  // ∪ 字面命中被 seedCap/MAX_ANCHORS 截断的（R1：literalHitIds − seeds − anchors，
  // 含截断的 seen 命中——「种子槽满 / 已冷却」同属此桶）。已投出与已在冷却桶的
  // 不重复记。
  const notAppended = candidateIds.filter((id) => !delivered.has(id));
  const truncatedHits = literalHitIds.filter((id) => !seedSet.has(id) && !anchorSet.has(id));
  const slotFull = new Set(
    [...droppedIds, ...notAppended, ...highIds, ...truncatedHits]
      .filter((id) => !delivered.has(id) && !seenCooldown.has(id)),
  );
  const belowAll = {};
  for (const [id, cos] of Object.entries(lowScores)) {
    if (delivered.has(id) || seenCooldown.has(id) || slotFull.has(id)) continue;
    belowAll[id] = cos;
  }
  // literal_miss：无任何信号的基线（非字面命中、未被语义评分、不在前三个桶）。
  const attributed = new Set([...delivered, ...seenCooldown, ...slotFull, ...Object.keys(belowAll)]);
  let literalMiss = 0;
  for (const card of cards) {
    const id = idOf(card, "cards");
    if (!attributed.has(id)) literalMiss += 1;
  }

  // 字面命中数：全量字面命中（R1 起不再被 3+3 截断口径低估；旧 match 结果回落
  // seeds ∪ anchors 截断后口径）。
  const literalHits = literalHitIds.length;

  // 语义最高分：诊断块自带 topScore 优先（与评分路径同源），缺省从 scored 现算。
  let semanticTopScore = null;
  if (semantic !== null && isPlainRecord(semantic)) {
    if (typeof semantic.topScore === "number" && Number.isFinite(semantic.topScore)) {
      semanticTopScore = semantic.topScore;
    } else if (Object.keys(scored).length > 0) {
      semanticTopScore = Math.max(...Object.values(scored));
    }
  }

  // 分桶（对全部被评分的卡）：hit = ≥阈值（与诊断块 candidates 同口径）；
  // near = 距阈值 NEAR_MARGIN 以内；cold = 其余。无阈值（语义未启用）时三桶恒 0。
  const buckets = { hit: 0, near: 0, cold: 0 };
  if (resolvedThreshold !== undefined && resolvedThreshold !== null) {
    for (const cos of Object.values(scored)) {
      if (cos >= resolvedThreshold) buckets.hit += 1;
      else if (cos >= resolvedThreshold - NEAR_MARGIN) buckets.near += 1;
      else buckets.cold += 1;
    }
  }

  // 逐卡明细封顶（评审硬要求）：below-threshold 保留最高分 SCORE_DETAIL_CAP 张
  // （余弦降序，平局按 id 升序——确定性）；seen_cooldown / slot_full 保留 id
  // 码点序前 ID_DETAIL_CAP 条。total 恒为全量计数，超出封顶只体现为 total > 明细数。
  const cappedBelowScores = {};
  for (const id of Object.keys(belowAll)
    .sort((a, b) => (belowAll[b] !== belowAll[a] ? belowAll[b] - belowAll[a] : (a < b ? -1 : a > b ? 1 : 0)))
    .slice(0, SCORE_DETAIL_CAP)) {
    cappedBelowScores[id] = belowAll[id];
  }
  const cappedIds = (set) => [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, ID_DETAIL_CAP);

  return {
    version: DIAGNOSTICS_RECORD_VERSION,
    at,
    scopeId,
    literalHits,
    semanticTopScore,
    semanticBuckets: buckets,
    deliveredIds: [...delivered],
    rejectReasons: {
      literal_miss: literalMiss,
      semantic_below_threshold: { total: Object.keys(belowAll).length, scores: cappedBelowScores },
      seen_cooldown: { total: seenCooldown.size, ids: cappedIds(seenCooldown) },
      slot_full: { total: slotFull.size, ids: cappedIds(slotFull) },
    },
  };
}

/** 明细桶形状断言：{ total, ... }，total 为非负整数且 ≥ 明细条数（评审 R7：
 *  注释承诺的口径必须真的校验——可构造 total=0 但明细 N 条通不过）。 */
function assertCappedDetail(value, name, detailCheck) {
  if (!isPlainRecord(value)) fail("INVALID_INPUT", `${name} must be a plain object, got ${describe(value)}`);
  for (const key of Object.keys(value)) {
    if (key !== "total" && !detailCheck.keys.includes(key)) {
      fail("INVALID_INPUT", `${name} has unknown field "${key}" (allowed: total, ${detailCheck.keys.join(", ")})`);
    }
  }
  if (!Number.isInteger(value.total) || value.total < 0) {
    fail("INVALID_INPUT", `${name}.total must be a non-negative integer`);
  }
  detailCheck.check(value);
  const detailCount = detailCheck.count(value);
  if (value.total < detailCount) {
    fail("INVALID_INPUT", `${name}.total (${value.total}) must be >= 明细条数 (${detailCount})`);
  }
  return value;
}

/** 记录形状白名单断言（写侧与测试共用）：字段名严格白名单，值形状合法。 */
export function assertRecordShape(record) {
  if (!isPlainRecord(record)) fail("INVALID_INPUT", `diagnostics record must be a plain object, got ${describe(record)}`);
  for (const key of Object.keys(record)) {
    if (!RECORD_FIELDS.includes(key)) {
      fail("INVALID_INPUT", `diagnostics record has unknown field "${key}" (allowed: ${RECORD_FIELDS.join(", ")})`);
    }
  }
  for (const key of RECORD_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      fail("INVALID_INPUT", `diagnostics record is missing field "${key}"`);
    }
  }
  if (record.version !== DIAGNOSTICS_RECORD_VERSION) {
    fail("INVALID_INPUT", `record.version must be ${DIAGNOSTICS_RECORD_VERSION}`);
  }
  requireNonEmptyString(record.at, "record.at");
  if (recordAtToMs(record.at) === null) fail("INVALID_INPUT", "record.at must be a parseable timestamp");
  requireNonEmptyString(record.scopeId, "record.scopeId");
  if (!Number.isInteger(record.literalHits) || record.literalHits < 0) {
    fail("INVALID_INPUT", "record.literalHits must be a non-negative integer");
  }
  if (record.semanticTopScore !== null && (typeof record.semanticTopScore !== "number" || !Number.isFinite(record.semanticTopScore))) {
    fail("INVALID_INPUT", "record.semanticTopScore must be a finite number or null");
  }
  if (!isPlainRecord(record.semanticBuckets)) {
    fail("INVALID_INPUT", "record.semanticBuckets must be a plain object");
  }
  for (const key of Object.keys(record.semanticBuckets)) {
    if (!BUCKET_KEYS.includes(key)) {
      fail("INVALID_INPUT", `record.semanticBuckets has unknown field "${key}" (allowed: ${BUCKET_KEYS.join(", ")})`);
    }
  }
  for (const key of BUCKET_KEYS) {
    const value = record.semanticBuckets[key];
    if (!Number.isInteger(value) || value < 0) {
      fail("INVALID_INPUT", `record.semanticBuckets.${key} must be a non-negative integer`);
    }
  }
  if (!Array.isArray(record.deliveredIds) || record.deliveredIds.some((id) => typeof id !== "string" || id.length === 0)) {
    fail("INVALID_INPUT", "record.deliveredIds must be an array of non-empty strings");
  }
  if (!isPlainRecord(record.rejectReasons)) {
    fail("INVALID_INPUT", "record.rejectReasons must be a plain object");
  }
  for (const key of Object.keys(record.rejectReasons)) {
    if (!REJECT_KEYS.includes(key)) {
      fail("INVALID_INPUT", `record.rejectReasons has unknown field "${key}" (allowed: ${REJECT_KEYS.join(", ")})`);
    }
  }
  for (const key of REJECT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record.rejectReasons, key)) {
      fail("INVALID_INPUT", `record.rejectReasons is missing field "${key}"`);
    }
  }
  const reject = record.rejectReasons;
  if (!Number.isInteger(reject.literal_miss) || reject.literal_miss < 0) {
    fail("INVALID_INPUT", "rejectReasons.literal_miss must be a non-negative integer");
  }
  assertCappedDetail(reject.semantic_below_threshold, "rejectReasons.semantic_below_threshold", {
    keys: ["scores"],
    count: (value) => Object.keys(value.scores).length,
    check: (value) => {
      if (!isPlainRecord(value.scores)) {
        fail("INVALID_INPUT", "rejectReasons.semantic_below_threshold.scores must be a plain object");
      }
      for (const [id, cos] of Object.entries(value.scores)) {
        requireNonEmptyString(id, "rejectReasons.semantic_below_threshold.scores key");
        if (typeof cos !== "number" || !Number.isFinite(cos)) {
          fail("INVALID_INPUT", `rejectReasons.semantic_below_threshold.scores[${JSON.stringify(id)}] must be a finite number`);
        }
      }
    },
  });
  assertCappedDetail(reject.seen_cooldown, "rejectReasons.seen_cooldown", {
    keys: ["ids"],
    count: (value) => value.ids.length,
    check: (value) => {
      if (!Array.isArray(value.ids) || value.ids.some((id) => typeof id !== "string" || id.length === 0)) {
        fail("INVALID_INPUT", "rejectReasons.seen_cooldown.ids must be an array of non-empty strings");
      }
    },
  });
  assertCappedDetail(reject.slot_full, "rejectReasons.slot_full", {
    keys: ["ids"],
    count: (value) => value.ids.length,
    check: (value) => {
      if (!Array.isArray(value.ids) || value.ids.some((id) => typeof id !== "string" || id.length === 0)) {
        fail("INVALID_INPUT", "rejectReasons.slot_full.ids must be an array of non-empty strings");
      }
    },
  });
  return record;
}

// ---------------------------------------------------------------------------
// trimRecords：7 天滚动裁旧 + 硬上限
// ---------------------------------------------------------------------------

/**
 * 滚动裁旧：先按 7 天窗口裁（at 早于 now-days 的整条丢弃），再按硬上限裁
 * （只留最新 maxRecords 条）。保持输入顺序（账本按落账顺序追加，不重排）。
 *
 * @param {Array<object>} records 账本记录（at 非法的条目整条丢弃——崩溃残行同款防线）
 * @param {object} [opts] { days, now, maxRecords }（now：毫秒数/Date/ISO 串）
 */
export function trimRecords(records, { days = DIAGNOSTICS_RETENTION_DAYS, now, maxRecords = DIAGNOSTICS_MAX_RECORDS } = {}) {
  if (!Array.isArray(records)) fail("INVALID_INPUT", `records must be an array, got ${describe(records)}`);
  requireFiniteNumber(days, "days");
  if (days <= 0) fail("INVALID_INPUT", "days must be positive");
  if (!Number.isInteger(maxRecords) || maxRecords <= 0) fail("INVALID_INPUT", "maxRecords must be a positive integer");
  const nowMs = typeof now === "number" ? now : now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : NaN;
  requireFiniteNumber(nowMs, "now");
  const cutoff = nowMs - days * 86_400_000;
  const kept = records.filter((record) => {
    const ms = isPlainRecord(record) ? recordAtToMs(record?.at) : null;
    return ms !== null && ms >= cutoff;
  });
  return kept.length > maxRecords ? kept.slice(kept.length - maxRecords) : kept;
}

// ---------------------------------------------------------------------------
// analyzeCoverage / readDiagnostics：每卡覆盖率 + 两张清单
// ---------------------------------------------------------------------------

const byIdAsc = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * 窗口聚合（纯函数；records / cards 由调用方注入）。
 *
 * @param {object} args
 * @param {Array<object>} args.records 窗口内诊断记录（已裁旧）
 * @param {Array<object>} args.cards 当前 active 卡（id/title/revision/triggers/
 *   hitCount/lastHitAt/useCount/lastUsedAt；used 次数取 useCount——store 未暴露
 *   窗口内 feedback 事件，口径为累计值并在覆盖率里如实标注 usedScope。
 *   revision/triggers 只进面板聚合结果，账本记录里没有它们）
 * @param {number} [args.days] 报告窗口（与裁旧同源）
 * @param {number|Date|string} [args.now] 报告基准时间
 */
export function analyzeCoverage({ records, cards, days = DIAGNOSTICS_RETENTION_DAYS, now, semanticEnabled = false } = {}) {
  if (!Array.isArray(records)) fail("INVALID_INPUT", `records must be an array, got ${describe(records)}`);
  if (!Array.isArray(cards)) fail("INVALID_INPUT", `cards must be an array, got ${describe(cards)}`);
  requireFiniteNumber(days, "days");
  const nowMs = typeof now === "number" ? now : now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : Date.now();
  if (!Number.isFinite(nowMs)) fail("INVALID_INPUT", "now must be a parseable timestamp");

  const rounds = records.length;
  const windows = { from: new Date(nowMs - days * 86_400_000).toISOString(), to: new Date(nowMs).toISOString() };

  // 逐记录解析时间（at 非法整条跳过——与 trimRecords 崩溃残行同款防线）。
  const parsed = [];
  for (const record of records) {
    if (!isPlainRecord(record)) continue;
    const atMs = recordAtToMs(record.at);
    if (atMs === null) continue;
    parsed.push({ atMs, at: record.at, record });
  }

  // 逐卡折叠（评审 R2：只计 at >= createdAt 的轮次——窗口内刚创建、创建后还没
  // 发生召回轮次的卡必须归「无有效召回轮次」，不得冒出「分数始终低于阈值/
  // 向量索引过期」的误导建议；评审 R6：明细被截断的轮次若无该卡逐卡证据，
  // 记 truncatedRounds，归因降级为 evidence-truncated 而不是默认 below-threshold）。
  // stats：id → { rounds, deliveries, lastDeliveryAt, scoredRounds, topScore,
  //         slotFullRounds, seenCooldownRounds, truncatedRounds }
  const stats = new Map();
  const statFor = (id) => {
    let entry = stats.get(id);
    if (entry === undefined) {
      entry = { rounds: 0, deliveries: 0, lastDeliveryAt: null, scoredRounds: 0, topScore: null, slotFullRounds: 0, seenCooldownRounds: 0, truncatedRounds: 0 };
      stats.set(id, entry);
    }
    return entry;
  };
  for (const card of cards) {
    const id = idOf(card, "cards");
    const entry = statFor(id);
    const createdAtMs = typeof card.createdAt === "string" ? recordAtToMs(card.createdAt) : null;
    for (const { atMs, at, record } of parsed) {
      if (createdAtMs !== null && Number.isFinite(createdAtMs) && atMs < createdAtMs) continue;
      entry.rounds += 1;
      const deliveredIds = Array.isArray(record.deliveredIds) ? record.deliveredIds : [];
      if (deliveredIds.includes(id)) {
        entry.deliveries += 1;
        // 记录顺序无关：lastDeliveryAt 恒取时间最大者（崩溃恢复/回放可能乱序）。
        if (entry.lastDeliveryAt === null || atMs > recordAtToMs(entry.lastDeliveryAt)) {
          entry.lastDeliveryAt = at;
        }
      }
      const reject = isPlainRecord(record.rejectReasons) ? record.rejectReasons : {};
      const belowObj = isPlainRecord(reject.semantic_below_threshold) ? reject.semantic_below_threshold : {};
      const below = isPlainRecord(belowObj.scores) ? belowObj.scores : {};
      const hasScored = Object.hasOwn(below, id) && typeof below[id] === "number" && Number.isFinite(below[id]);
      const slotObj = isPlainRecord(reject.slot_full) ? reject.slot_full : {};
      const slotIds = Array.isArray(slotObj.ids) ? slotObj.ids : [];
      const hasSlot = slotIds.includes(id);
      const cooledObj = isPlainRecord(reject.seen_cooldown) ? reject.seen_cooldown : {};
      const cooledIds = Array.isArray(cooledObj.ids) ? cooledObj.ids : [];
      const hasCooled = cooledIds.includes(id);
      if (hasScored) {
        entry.scoredRounds += 1;
        entry.topScore = entry.topScore === null ? below[id] : Math.max(entry.topScore, below[id]);
      }
      if (hasSlot) entry.slotFullRounds += 1;
      if (hasCooled) entry.seenCooldownRounds += 1;
      // R6：明细截断（total > 明细条数）且该卡在本轮没有任何逐卡证据 →
      // 它可能正落在被截断的集合里，归因证据不足。
      const scoreTruncated = Number.isInteger(belowObj.total) && belowObj.total > Object.keys(below).length;
      const slotTruncated = Number.isInteger(slotObj.total) && slotObj.total > slotIds.length;
      const cooledTruncated = Number.isInteger(cooledObj.total) && cooledObj.total > cooledIds.length;
      if (!hasScored && !hasSlot && !hasCooled && (scoreTruncated || slotTruncated || cooledTruncated)) {
        entry.truncatedRounds += 1;
      }
    }
  }

  // 每卡覆盖率（只覆盖当前 active 卡；窗口内投过但现已退休的 id 不进覆盖率，
  // 记录里残留的 id 引用被自然忽略）。revision/triggers 供面板「一键生成
  // spark_update 补丁」用（元数据非正文；账本记录里依然没有它们）。
  const coverage = cards.map((card) => {
    const id = idOf(card, "cards");
    const entry = stats.get(id) ?? statFor(id);
    return {
      id,
      title: typeof card.title === "string" ? card.title : null,
      revision: Number.isInteger(card.revision) && card.revision >= 0 ? card.revision : null,
      triggers: Array.isArray(card.triggers) ? card.triggers.filter((t) => typeof t === "string" && t.length > 0) : [],
      createdAt: typeof card.createdAt === "string" ? card.createdAt : null,
      deliveries: entry.deliveries,
      used: typeof card.useCount === "number" && Number.isFinite(card.useCount) ? card.useCount : 0,
      usedScope: "all-time",
      lastHitAt: typeof card.lastHitAt === "string" ? card.lastHitAt : null,
      lastDeliveryAt: entry.lastDeliveryAt,
    };
  }).sort(byIdAsc);

  // 清单一：「从未投递」+ 归因（口径见模块头；rounds 为该卡 createdAt 之后的
  // 有效召回轮次，非全局窗口轮次——评审 R2）。
  const neverDelivered = coverage
    .filter((entry) => entry.deliveries === 0)
    .map((entry) => {
      const detail = stats.get(entry.id) ?? statFor(entry.id);
      let attribution;
      if (detail.rounds === 0) {
        // 卡创建以来还没有任何召回轮次（含刚创建/期间整窗无输入）→「没聊到」。
        attribution = { kind: "no-recall-rounds", rounds: 0 };
      } else if (detail.slotFullRounds > 0 || detail.seenCooldownRounds > 0) {
        // 有命中轮次但从未投出：被槽位/预算挤掉或冷却。分数证据照带（若也被评分过）。
        attribution = {
          kind: "matched-not-delivered",
          rounds: detail.rounds,
          slotFullRounds: detail.slotFullRounds,
          seenCooldownRounds: detail.seenCooldownRounds,
          scoredRounds: detail.scoredRounds,
          topScore: detail.topScore,
        };
      } else if (detail.scoredRounds > 0) {
        // 有召回轮次且被语义评分过、全部低于阈值（topScore = 逐轮最高分）。
        attribution = {
          kind: "below-threshold",
          rounds: detail.rounds,
          scoredRounds: detail.scoredRounds,
          topScore: detail.topScore,
        };
      } else if (detail.truncatedRounds > 0) {
        // R6：无任何逐卡证据、但有明细被截断的轮次——证据不足，不默认 below-threshold。
        attribution = {
          kind: "evidence-truncated",
          rounds: detail.rounds,
          truncatedRounds: detail.truncatedRounds,
        };
      } else {
        // 评审 R14：从未被语义评分 ≠ 分数不达标——below-threshold 的证明 =
        // scoredRounds + topScore（逐轮余弦最大值恒 < 阈值），这里两样都没有，
        // 不得冒用该归因。语义未开启（默认 provider=none）时状态页「重建向量」
        // 按钮是禁用的，更不得把用户指过去。semanticEnabled 由调用方注入
        // （controller 传 semanticProvider !== null），面板据此区分建议。
        attribution = {
          kind: "not-scored",
          rounds: detail.rounds,
          scoredRounds: 0,
          topScore: null,
          semanticEnabled: semanticEnabled === true,
        };
      }
      return { ...entry, attribution };
    })
    .sort(byIdAsc);

  // 清单二：「高频投递但低使用」——窗口内投递 ≥ 下限且累计 used === 0
  // （useCount 全程为 0：模型从未标记过有用；窗口口径见 coverage.usedScope）。
  const highDeliveryLowUsage = coverage
    .filter((entry) => entry.deliveries >= DELIVERY_LOW_USE_MIN_DELIVERIES && entry.used === 0)
    .sort((a, b) => (b.deliveries !== a.deliveries ? b.deliveries - a.deliveries : byIdAsc(a, b)));

  return { days, window: windows, rounds, coverage, neverDelivered, highDeliveryLowUsage };
}

/**
 * 诊断读取入口（任务书口径 readDiagnostics({ scopeId, days })）：
 * records / 卡片统计由调用方注入（controller 接真实账本与 store；测试注入夹具）。
 *
 * @param {object} args
 * @param {string} args.scopeId
 * @param {number} [args.days] 窗口天数（默认 7）
 * @param {(scopeId: string) => Promise<Array<object>>|Array<object>} args.readRecords
 *   账本读取（state.diagnosticsStore.readRecords；返回裁旧前的全部记录）
 * @param {() => Promise<Array<object>>|Array<object>} [args.listCards]
 *   当前 active 卡读取（sparkStore.listActive）
 * @param {number|Date|string} [args.now] 报告基准时间（缺省取当前时间）
 */
export async function readDiagnostics({ scopeId, days = DIAGNOSTICS_RETENTION_DAYS, readRecords, listCards, now, semanticEnabled = false } = {}) {
  requireNonEmptyString(scopeId, "scopeId");
  requireFiniteNumber(days, "days");
  if (days <= 0) fail("INVALID_INPUT", "days must be positive");
  if (typeof readRecords !== "function") fail("INVALID_INPUT", "readRecords must be a function");
  const raw = await readRecords(scopeId);
  const nowMs = typeof now === "number" ? now : now instanceof Date ? now.getTime() : typeof now === "string" ? Date.parse(now) : Date.now();
  const records = trimRecords(Array.isArray(raw) ? raw : [], { days, now: nowMs });
  const cards = typeof listCards === "function" ? await listCards() : [];
  return analyzeCoverage({ records, cards: Array.isArray(cards) ? cards : [], days, now: nowMs, semanticEnabled: semanticEnabled === true });
}
