// Shiori F1b · 语义召回合并（字面命中优先，向量只做补位）。
//
// 边界（F1b 任务书 d 条）：
// - 现有 matchSparks（src/sparks/match.mjs，白名单外）的语义一字不改：字面
//   结果原样保留。本模块不改 match.mjs、不复制它的闸门逻辑——向量补位候选
//   以「合成 trigger」的卡片形状再次送入 matchSparks 本体，让它过完全相同的
//   四道闸门（seen 冷却 / 泛化实体排除 / maxSeeds 3 / maxRelated 2），
//   不存在旁路。
// - provider 为 null，或 embed 失败（SEMANTIC_UNAVAILABLE 等），或向量索引为
//   空时：返回值与纯字面 matchSparks 结果逐字节等价（同一个对象、不深拷贝），
//   且不触碰向量索引（不产生任何向量文件）。
// - 纯同步 match.mjs + 异步 embed：本模块唯一 await 是 provider.embed(text)。
//
// 合并算法（为什么用「第二次 matchSparks」而不是手写补位）：
//   1. literal = matchSparks(原始参数) —— 字面结果，原样保留。
//   2. 种子槽已满（literal.seeds.length ≥ maxSeeds）或正文为空 ⇒ 向量无位可补，
//      直接返回 literal（此时连 embed 都不做，零开销）。
//   3. query = await provider.embed(userText)；对索引里有「新鲜向量」的合格卡
//      片算 cosine，≥ 阈值者按（相似度降序，id 升序）取前 (剩余种子槽) 个。
//      新鲜 = 索引 revision 与卡片当前 revision 一致；过期/缺失一律不补
//      （补齐是「重建向量」按钮的职责，召回路径不隐式写索引）。
//   4. 把原始 sparks 数组送入第二次 matchSparks，但做两类改写：选中的补位卡
//      浅拷贝、triggers 替换为 [userText]（保证命中）；已被字面结果占用的卡
//      （seeds/anchors/related）triggers 置空（保证不再命中、不再占槽，但仍可
//      作为 1 跳扩散的目标出现）。其余卡片原样——它们的 trigger 判定与第一次
//      完全一致（第一次没命中的这次也不会命中），只是进入完整的扩散宇宙。
//      seen 过滤（第二次）、泛化实体排除、种子截断、1 跳关联全部由 matchSparks
//      本体执行——与字面命中走完全相同的闸门代码，扩散目标不缩水。
//   5. 合并：seeds = literal 种子 + 向量种子（槽位上限由第 4 步保证）；
//      related = literal 关联优先，向量种子扩散出的关联只填剩余名额；
//      anchors 只保留 literal 的（向量候选已预过滤 seen，不产生新锚点）。
//      向量种子内部的排序是 id 升序（合成 trigger 等长，matchSparks 平局规则
//      生效）——「选哪些卡」由相似度决定，「同批内的展示序」用 id 保证确定性。
//
// 阈值拍板（SEMANTIC_SIMILARITY_THRESHOLD = 0.45，实测校准）：
//   模型 Xenova/bge-small-zh-v1.5（512 维，MIT）。用 F1a 的 24 条夹具
//   （test/semantic/eval-fixtures.json，卡片仅以 title 作被嵌文本——这是
//   最弱表示；真实卡片还有 summary/content，分界只会更宽）实测余弦分布：
//     负样本（24 句 × 9 张非目标卡）：p50≈0.31–0.34，p95≈0.41–0.43，max≈0.51；
//     正样本（目标卡）：p25≈0.48，转述对（paraphrase 12 条）q8 0.417–0.711、
//     fp32 0.415–0.694。
//   0.45 取两分布之间的实测谷底（负样本 p95 之上、正样本 p25 之下）。
//   校准脚本对 0.40–0.75 扫描：q8 在 0.45 处向量 recall@5 = 22/24，0.50 处
//   掉到 18/24；再低（0.40）就会放进成批 p90 段负样本。偏保守的代价是漏补
//   （字面兜底仍在），放太开的代价是误投占满 3+2 名额——取谷底偏上。
//   实测数据随 dtype/模型版本会漂移；换模型后应重跑 scripts/eval-recall.mjs
//   重新校准。该常量只在召回层生效，不影响 matchSparks 任何行为。

import { matchSparks, seenKeyFor, MAX_SEEDS, MAX_RELATED } from "./match.mjs";
import { cosineSimilarity } from "../semantic/index.mjs";

export const SEMANTIC_SIMILARITY_THRESHOLD = 0.45;

/** 与 match.mjs isEligible 完全同判据（该函数未导出，白名单外不能改）：
 *  本 scope、active、未被 redirect。 */
function isEligibleCard(card, scopeId) {
  return card !== null && typeof card === "object" && !Array.isArray(card)
    && typeof card.id === "string" && card.id.length > 0
    && card.scopeId === scopeId
    && card.state === "active"
    && !card.mergedInto
    && !card.supersededBy;
}

/** seenKeys 归一化（match.mjs requireSeenKeys 的最小镜像：array / Set / 缺省）。 */
function toSeenSet(seenKeys) {
  if (seenKeys === undefined || seenKeys === null) return new Set();
  if (Array.isArray(seenKeys)) return new Set(seenKeys);
  if (seenKeys instanceof Set) return seenKeys;
  return null; // 非法形状：matchSparks 第一步就会抛，这里不自行消化
}

/** 提取用于 embedding 的用户正文（match.mjs resolveUserText 的最小镜像）。
 *  返回 null = 无正文可嵌（非 user 消息 / 空文本），向量补位直接跳过。 */
function userTextForEmbedding(userText) {
  if (typeof userText === "string") return userText;
  if (userText !== null && typeof userText === "object" && !Array.isArray(userText)
    && typeof userText.role === "string" && typeof userText.text === "string"
    && userText.role === "user") {
    return userText.text;
  }
  return null;
}

/**
 * 字面 + 向量合并召回。
 *
 * @param {object} args 与 matchSparks 完全相同的召回参数（scopeId / userText /
 *   sparks / seenKeys / sessionId / contextEpoch / maxSeeds / maxRelated），外加：
 * @param {object|null} args.provider F1a 契约 provider（null = 语义召回关闭）。
 * @param {((sparkId: string) => {revision:number, vec:Float32Array}|null)|null} args.vectorsFor
 *   向量索引读取口（controller 注入；null = 无索引）。返回的 vec 须已归一化或
 *   至少同空间——cosineSimilarity 自带归一化处理，两种都成立。
 * @param {number} [args.threshold] 相似度阈值（默认 SEMANTIC_SIMILARITY_THRESHOLD）。
 * @returns {Promise<{match: object, semantic: object}>}
 *   match：投递层消费的合并结果（provider 为 null / 不可用时 = 纯字面结果本体）；
 *   semantic：诊断块 {enabled, used, threshold, candidates, error}（controller
 *   转存进 getStatus.diagnostics.semantic；不进入 match，不影响投递层）。
 */
export async function mergeSemanticRecall({
  scopeId,
  userText,
  sparks,
  seenKeys,
  sessionId,
  contextEpoch,
  maxSeeds = 3,
  maxRelated = 2,
  provider = null,
  vectorsFor = null,
  threshold = SEMANTIC_SIMILARITY_THRESHOLD,
} = {}) {
  // 第一步永远是原样字面召回：入参非法（如 userText 形状错误）在这里按
  // matchSparks 原口径抛出——本模块不吞编程错误。
  const literal = matchSparks({
    scopeId, userText, sparks, seenKeys, sessionId, contextEpoch, maxSeeds, maxRelated,
  });

  const diag = {
    enabled: provider !== null && vectorsFor !== null,
    used: false,
    threshold,
    candidates: 0,
    error: null,
  };
  if (!diag.enabled) {
    return { match: literal, semantic: diag };
  }

  // 种子槽已满 / 无正文：无位可补（空正文嵌进来的是无意义向量，还会拖 4ms 延迟）。
  const seedCap = Math.min(Number.isInteger(maxSeeds) ? maxSeeds : 3, MAX_SEEDS);
  const text = userTextForEmbedding(userText);
  if (literal.seeds.length >= seedCap || text === null || text.length === 0) {
    return { match: literal, semantic: diag };
  }

  let query;
  try {
    query = await provider.embed(text);
  } catch (error) {
    // provider 不可用（模型没装 / 下载失败 / 推理异常）：与纯字面逐字节等价，
    // 错误经 diag 上报诊断，不外溢、不打挂 pre-step。
    diag.error = error instanceof Error ? error.message : String(error);
    return { match: literal, semantic: diag };
  }

  // 候选收集：合格卡片 + 新鲜向量 + 未 seen + 不在字面结果里。
  const seen = toSeenSet(seenKeys);
  if (seen === null) {
    // matchSparks 已在第一步校验过 seenKeys 形状，到这里不会是 null；防御分支。
    return { match: literal, semantic: diag };
  }
  const takenIds = new Set();
  for (const item of [...literal.seeds, ...literal.anchors, ...literal.related]) takenIds.add(item.id);
  const ranked = [];
  for (const card of sparks) {
    if (!isEligibleCard(card, scopeId) || takenIds.has(card.id)) continue;
    // revision 必须是合法整数（seenKeyFor / 向量新鲜度比对的前提）；
    // matchSparks 对无 revision 的卡也不给种子，这里提前跳过保持一致。
    if (!Number.isInteger(card.revision) || card.revision < 0) continue;
    const entry = vectorsFor(card.id);
    if (entry === null || entry.revision !== card.revision) continue; // 缺失/过期：重建负责
    if (entry.vec.length !== query.length) continue; // 维度不符：索引与模型错配，跳过不抛
    const seenOk = !seen.has(seenKeyFor({
      scopeId, sessionId, contextEpoch, sparkId: card.id, revision: card.revision,
    }));
    if (!seenOk) continue; // 闸门一（预过滤）：已冷却的卡绝不因相似度翻红
    let cos;
    try {
      cos = cosineSimilarity(query, entry.vec);
    } catch {
      continue; // 维度/数值异常已在上面防住；再兜一层，不让单条坏数据炸掉召回
    }
    if (cos >= threshold) ranked.push({ card, cos });
  }
  diag.candidates = ranked.length;
  if (ranked.length === 0) {
    return { match: literal, semantic: diag };
  }
  ranked.sort((a, b) => (b.cos !== a.cos ? b.cos - a.cos : (a.card.id < b.card.id ? -1 : a.card.id > b.card.id ? 1 : 0)));
  const freeSlots = seedCap - literal.seeds.length;
  const picked = ranked.slice(0, freeSlots);
  const pickedIds = new Set(picked.map(({ card }) => card.id));

  // 二次入闸：见模块头「合并算法」第 4 步。补位卡换合成 trigger；被字面占用
  // 的卡摘掉 trigger（不可再命中，仍是合法扩散目标）；其余原样透传（它们的
  // 命中判定与第一次一致，不会新增种子）。浅拷贝只改 triggers，下游
  // （buildSparkAttachment）读到的仍是真实卡片的 title/summary/content。
  const sparksForVector = sparks.map((card) => {
    if (isEligibleCard(card, scopeId) && pickedIds.has(card.id)) return { ...card, triggers: [text] };
    if (isEligibleCard(card, scopeId) && takenIds.has(card.id)) return { ...card, triggers: [] };
    return card;
  });
  const vector = matchSparks({
    scopeId,
    userText: text,
    sparks: sparksForVector,
    seenKeys,
    sessionId,
    contextEpoch,
    maxSeeds: freeSlots, // 闸门三：向量种子只填字面剩下的名额
    maxRelated,          // 闸门四：扩散上限与字面同源
  });
  // 闸门二（泛化实体排除）由 matchSparks 内部的 entityCount 逻辑执行，
  // 本函数不做任何 entity 级别的放行。

  const relatedTaken = new Set([
    ...takenIds,
    ...vector.seeds.map((s) => s.id),
  ]);
  const relatedCap = Math.min(Number.isInteger(maxRelated) ? maxRelated : 2, MAX_RELATED);
  const related = [...literal.related];
  for (const item of vector.related) {
    if (related.length >= relatedCap) break; // 字面优先，向量扩散只填剩余名额
    if (relatedTaken.has(item.id)) continue;
    relatedTaken.add(item.id);
    related.push(item);
  }

  diag.used = vector.seeds.length > 0 || related.length > literal.related.length;
  const match = {
    ...literal,
    seeds: [...literal.seeds, ...vector.seeds],
    anchors: literal.anchors, // 向量候选已预过滤 seen，不产生新锚点（见头注释第 5 步）
    related,
  };
  return { match, semantic: diag };
}
