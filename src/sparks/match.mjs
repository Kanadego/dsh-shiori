// Shiori P2-L2 · Spark 确定性检索（纯函数）。
//
// 边界（CONTRACTS §H）：只处理传入的卡片/消息/会话状态；不读写磁盘、
// 不注册 host/工具、不写 seen 状态，也不猜测 compress 成功（contextEpoch
// 只由 P1 成功压缩证据推进，这里只接收参数）。
//
// 设计依据：DESIGN §4.3（四道硬闸门）与 §4.3.3（pre-step 触发流程）。
//  1. 0 跳种子：只匹配 triggers；先做 scope/active/非重定向/seen 筛选，
//     再截取最多 maxSeeds(默认 3) 个 —— seen 过滤发生在截断之前，
//     因此前三张已冷却不会饿死第四张未 seen 的种子。
//  2. 只许 1 跳：从种子与已 seen 直接命中锚点扩散一次；显式 links 优先，
//     其次合格 entities；entity 在可见 active 卡中出现超过 5 次视为
//     泛化标签，不扩散；关联先过滤 seen 再取最多 maxRelated(默认 2) 个。
//  3. 排序确定性：归一化后最长匹配 trigger 优先，平局按 id 升序；
//     NFC 归一化、英文大小写折叠、纯 ASCII 词用词边界匹配，原文不改。

import { fail, isPlainRecord, describe } from "../core/errors.mjs";

// 已 seen 直接命中锚点上限（DESIGN §4.3.3：最多 3 个稳定选出的锚点）。
export const MAX_ANCHORS = 3;
// 固定硬上限（CONTRACTS §H / DESIGN §4.3.2）：最多 3 个未 seen 种子、
// 2 个 1 跳关联，合计 ≤5（spark.maxCards）。调用方传更大值时按上限钳制。
export const MAX_SEEDS = 3;
export const MAX_RELATED = 2;
// 泛化 entity  exclusion 门槛：可见 active 卡中出现次数 >5 即不参与扩散。
export const ENTITY_GENERALIZED_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// seen key：commitDelivery 与 matchSparks 共用的确定性键格式。
// 键是整体比较的不透明字符串（id 可能含分隔符字符，不做反向解析）。
// ---------------------------------------------------------------------------

export function seenKeyFor({ scopeId, sessionId, contextEpoch, sparkId, revision }) {
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    fail("INVALID_INPUT", "seenKeyFor: scopeId must be a non-empty string");
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("INVALID_INPUT", "seenKeyFor: sessionId must be a non-empty string");
  }
  if (!Number.isInteger(contextEpoch) || contextEpoch < 0) {
    fail("INVALID_INPUT", "seenKeyFor: contextEpoch must be a non-negative integer");
  }
  if (typeof sparkId !== "string" || sparkId.length === 0) {
    fail("INVALID_INPUT", "seenKeyFor: sparkId must be a non-empty string");
  }
  if (!Number.isInteger(revision) || revision < 0) {
    fail("INVALID_INPUT", "seenKeyFor: revision must be a non-negative integer");
  }
  return `spark:seen:${scopeId}:${sessionId}:${contextEpoch}:${sparkId}:${revision}`;
}

// ---------------------------------------------------------------------------
// 入参校验
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

function requireCount(value, name, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) {
    fail("INVALID_INPUT", `${name} must be a non-negative integer, got ${describe(value)}`);
  }
  return value;
}

// userText：字符串 = 调用方已确认的用户正文；{ role, text } 形态 = 消息对象，
// 仅 role === "user" 才扫描（system/assistant/tool/历史/插件附件一律无扫描结果）。
// 其余类型是编程错误，按 INVALID_INPUT 拒绝。
function resolveUserText(userText) {
  if (typeof userText === "string") {
    return userText;
  }
  if (isPlainRecord(userText)) {
    if (typeof userText.role !== "string" || typeof userText.text !== "string") {
      fail("INVALID_INPUT", "userText object form requires string properties role and text");
    }
    if (userText.role !== "user") {
      return null;
    }
    return userText.text;
  }
  fail("INVALID_INPUT", `userText must be a string or { role, text } object, got ${describe(userText)}`);
}

function requireSeenKeys(seenKeys) {
  if (seenKeys === undefined || seenKeys === null) {
    return new Set();
  }
  if (Array.isArray(seenKeys)) {
    for (const key of seenKeys) {
      if (typeof key !== "string") {
        fail("INVALID_INPUT", `seenKeys entries must be strings, got ${describe(key)}`);
      }
    }
    return new Set(seenKeys);
  }
  if (seenKeys instanceof Set) {
    for (const key of seenKeys) {
      if (typeof key !== "string") {
        fail("INVALID_INPUT", `seenKeys entries must be strings, got ${describe(key)}`);
      }
    }
    return seenKeys;
  }
  fail("INVALID_INPUT", `seenKeys must be an array or Set, got ${describe(seenKeys)}`);
}

// ---------------------------------------------------------------------------
// 卡片资格与归一化
// ---------------------------------------------------------------------------

// 可参与匹配/扩散的卡片：本 scope、active、未被 redirect（mergedInto /
// supersededBy 已设置的重定向条目一律排除）。supersedes 指向他人不代表
// 自身失效，不算 redirect。
function isEligible(card, scopeId) {
  return isPlainRecord(card)
    && typeof card.id === "string"
    && card.id.length > 0
    && card.scopeId === scopeId
    && card.state === "active"
    && !card.mergedInto
    && !card.supersededBy;
}

function triggerList(card) {
  if (!Array.isArray(card.triggers)) return [];
  return card.triggers.filter((t) => typeof t === "string" && t.length > 0);
}

function entityList(card) {
  if (!Array.isArray(card.entities)) return [];
  return card.entities.filter((e) => typeof e === "string" && e.length > 0);
}

// 纯 ASCII 字母数字串（单个英文词）按词边界匹配；含空格/连字符/中日韩等
// 其他触发词按 NFC 子串匹配。
function isAsciiWord(text) {
  return /^[a-z0-9]+$/.test(text);
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 返回该 trigger 是否命中正文。英文词边界：命中位置的两侧不得紧邻
// [A-Za-z0-9]（"cat" 不命中 "concatenate"，可命中 "a cat!"）。
function triggerHits(textLower, triggerLower) {
  if (isAsciiWord(triggerLower)) {
    const re = new RegExp(`(?<![a-z0-9])${escapeRegex(triggerLower)}(?![a-z0-9])`);
    return re.test(textLower);
  }
  return textLower.includes(triggerLower);
}

// 单卡最长命中 trigger（原文返回，长度按归一化小写形式计）。
function longestHit(card, textLower) {
  let best = null;
  for (const trigger of triggerList(card)) {
    const normalized = trigger.normalize("NFC").toLowerCase();
    if (normalized.length === 0) continue;
    if (triggerHits(textLower, normalized)) {
      if (best === null || normalized.length > best.len) {
        best = { trigger, len: normalized.length };
      }
    }
  }
  return best;
}

// 确定性排序：最长命中 trigger 优先，平局按 id 升序（码点序）。
function byLongestTriggerThenId(a, b) {
  if (b.matchLen !== a.matchLen) return b.matchLen - a.matchLen;
  if (a.card.id < b.card.id) return -1;
  if (a.card.id > b.card.id) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// matchSparks
// ---------------------------------------------------------------------------

export function matchSparks({
  scopeId,
  userText,
  sparks,
  seenKeys,
  sessionId,
  contextEpoch,
  maxSeeds = 3,
  maxRelated = 2,
} = {}) {
  requireScopeId(scopeId);
  requireSessionId(sessionId);
  requireContextEpoch(contextEpoch);
  // 校验为非负整数后按固定硬上限钳制：调用方无法用更大的 maxSeeds/
  // maxRelated 突破 3+2（合计 ≤5 张卡）。
  const seedCap = Math.min(requireCount(maxSeeds, "maxSeeds", 3), MAX_SEEDS);
  const relatedCap = Math.min(requireCount(maxRelated, "maxRelated", 2), MAX_RELATED);
  if (!Array.isArray(sparks)) {
    fail("INVALID_INPUT", `sparks must be an array, got ${describe(sparks)}`);
  }
  const seen = requireSeenKeys(seenKeys);
  const text = resolveUserText(userText);

  const emptyResult = { scopeId, sessionId, contextEpoch, seeds: [], related: [], anchors: [] };
  if (text === null || text.length === 0) {
    return emptyResult;
  }

  const textLower = text.normalize("NFC").toLowerCase();

  // 资格筛选 + 直接命中候选（0 跳）。
  const eligible = sparks.filter((card) => isEligible(card, scopeId));
  const hits = [];
  for (const card of eligible) {
    const hit = longestHit(card, textLower);
    if (hit) {
      hits.push({ card, trigger: hit.trigger, matchLen: hit.len });
    }
  }
  if (hits.length === 0) {
    return emptyResult;
  }

  // key 是否已 seen：按当前 revision 构造键整体比较；换 revision 即视为
  // 新内容可再次投递（键含 revision，DESIGN §4.3.2 第 4 条）。
  const isSeen = (card) => seen.has(seenKeyFor({
    scopeId, sessionId, contextEpoch,
    sparkId: card.id, revision: card.revision,
  }));
  const hasRevision = (card) => Number.isInteger(card.revision) && card.revision >= 0;

  const hitsWithRevision = hits.filter(({ card }) => hasRevision(card));

  // 先过滤 seen，再截取种子：已 seen 的直接命中只作为锚点，不占种子名额，
  // 因此前三张已冷却不会阻止第四张未 seen 种子入选。
  const unseenHits = hitsWithRevision.filter(({ card }) => !isSeen(card));
  const seenHits = hitsWithRevision.filter(({ card }) => isSeen(card));
  unseenHits.sort(byLongestTriggerThenId);
  seenHits.sort(byLongestTriggerThenId);

  const seeds = unseenHits.slice(0, seedCap).map(({ card, trigger }) => ({
    id: card.id, revision: card.revision, spark: card, trigger,
  }));
  const anchors = seenHits.slice(0, MAX_ANCHORS).map(({ card, trigger }) => ({
    id: card.id, revision: card.revision, spark: card, trigger,
  }));

  // 1 跳扩散：种子 + 锚点，只扩散一次；显式 links 优先于 entity 共现。
  // 候选先全部收集去重，再按稳定键排序后截取 —— 选择与传入 sparks[] 及
  // 触发词的枚举顺序无关（评审 H3）。
  const taken = new Set();
  for (const item of [...seeds, ...anchors]) taken.add(item.id);
  const expanders = [...seeds, ...anchors];

  // 候选稳定键：[kind(显式 link=0 < entity=1), 卡片 id, 扩散源 id,
  // rel/entity 字符串]，逐位升序比较；同一卡片经多条路径命中时保留键最小者。
  const candidateKeys = (cardId, fromId, kindRank, viaText) =>
    [kindRank, cardId, fromId, viaText];
  function candidateKeyLess(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] < b[i];
    }
    return false;
  }
  const candidates = new Map();
  function consider(target, via, kindRank, viaText) {
    if (taken.has(target.id) || !hasRevision(target) || isSeen(target)) return;
    const key = candidateKeys(target.id, via.from, kindRank, viaText);
    const prev = candidates.get(target.id);
    if (!prev || candidateKeyLess(key, prev.key)) {
      candidates.set(target.id, { card: target, via, key });
    }
  }

  for (const expander of expanders) {
    const card = expander.spark;
    if (Array.isArray(card.links)) {
      for (const link of card.links) {
        const targetId = isPlainRecord(link) ? link.target : null;
        if (typeof targetId !== "string" || targetId === card.id) continue;
        const target = eligible.find((c) => c.id === targetId);
        if (!target) continue;
        const rel = isPlainRecord(link) && typeof link.rel === "string" ? link.rel : "";
        consider(target, { kind: "link", from: card.id, rel }, 0, rel);
      }
    }
  }
  // 泛化 entity 统计：可见 active 卡中出现次数 >5 的标签不扩散。
  const entityCount = new Map();
  for (const card of eligible) {
    for (const entity of entityList(card)) {
      entityCount.set(entity, (entityCount.get(entity) ?? 0) + 1);
    }
  }
  for (const expander of expanders) {
    for (const entity of entityList(expander.spark)) {
      if ((entityCount.get(entity) ?? 0) > ENTITY_GENERALIZED_THRESHOLD) continue;
      for (const card of eligible) {
        if (card.id === expander.spark.id) continue;
        if (!entityList(card).includes(entity)) continue;
        consider(card, { kind: "entity", from: expander.spark.id, entity }, 1, entity);
      }
    }
  }

  const related = [...candidates.values()]
    .sort((a, b) => (candidateKeyLess(a.key, b.key) ? -1 : candidateKeyLess(b.key, a.key) ? 1 : 0))
    .slice(0, relatedCap)
    .map(({ card, via }) => ({ id: card.id, revision: card.revision, spark: card, via }));

  return { scopeId, sessionId, contextEpoch, seeds, related, anchors };
}
