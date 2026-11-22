// 0.5 批次 4 · D 线：投递诊断账本测试。
//
// 覆盖（任务书硬要求 5 + 评审 q-50d63bd04a86684e 四条硬要求）：
// 1. 记录字段白名单（version:1 + 8 字段）与「不含正文」子串检查（标题/摘要/
//    正文/触发词都不出现在记录文本里）；
// 2. 7 天滚动裁旧 + 硬上限（纯函数层 + state 账本层）；
// 3. 一轮多卡归因完整性 + 逐卡明细封顶（below-threshold 最高分 20 / 冷却与槽满 50）；
// 4. 两类未投递归因夹具（no-recall-rounds / below-threshold）+ matched-not-delivered；
// 5. shadow / 只读宿主（HOST_LOCKED）零写入（fs 断言）；
// 6. controller 接线：pre-step 落账（非阻塞）+ getStatus.diagnostics.delivery 注入；
// 7. 写失败只告警（stateRoot 指向普通文件 → {ok:false} + writer 计数，不抛）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildRoundRecord,
  trimRecords,
  analyzeCoverage,
  readDiagnostics,
  assertRecordShape,
  RECORD_FIELDS,
  REJECT_KEYS,
  BUCKET_KEYS,
  DIAGNOSTICS_RECORD_VERSION,
  DIAGNOSTICS_RETENTION_DAYS,
  DIAGNOSTICS_MAX_RECORDS,
  SCORE_DETAIL_CAP,
  ID_DETAIL_CAP,
  NEAR_MARGIN,
} from "../../src/sparks/diagnostics.mjs";
import { createStateStore } from "../../src/plugin/state.mjs";
import { createShioriPluginController } from "../../src/plugin/controller.mjs";
import { openSparkStore } from "../../src/sparks/store.mjs";
import { matchSparks } from "../../src/sparks/match.mjs";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 10, 15, 0, 0, 0); // 2026-11-15
const iso = (ms) => new Date(ms).toISOString();

/** 一张内容可识别的卡（子串检查用：正文含绝密标记）。 */
function secretCard(overrides = {}) {
  return {
    id: "spark-secret",
    revision: 3,
    title: "洋葱卡标题标记",
    summary: "洋葱卡摘要标记",
    content: "洋葱卡正文绝密内容标记 xyz123",
    triggers: ["洋葱触发词"],
    ...overrides,
  };
}

const disabledSemantic = (overrides = {}) => ({
  enabled: false, used: false, threshold: 0.55, candidates: 0, error: null,
  topScore: null, scored: {}, cooledIds: [],
  ...overrides,
});

function cardList(...ids) {
  return ids.map((id, i) => ({ id, revision: i + 1 }));
}

// ---------------------------------------------------------------------------
// 1. 记录字段白名单 + 不含正文
// ---------------------------------------------------------------------------

test("记录字段白名单：严格 8 字段 + version:1 + reject/buckets 子字段严格", () => {
  const card = secretCard();
  const record = buildRoundRecord({
    at: iso(T0),
    scopeId: "amber",
    cards: [card],
    match: { seeds: [{ id: card.id, revision: card.revision, trigger: "洋葱触发词" }], related: [], anchors: [] },
    semantic: disabledSemantic(),
    delivery: { delivered: [{ id: card.id, revision: card.revision }], dropped: [] },
    threshold: 0.55,
  });
  // 评审 R10：规格钉死在测试里的字面值（实现与常量一起漂移时这里必须红），
  // 桥接断言保证导出常量与字面值一致。
  assert.deepEqual(Object.keys(record).sort(), [
    "at", "deliveredIds", "literalHits", "rejectReasons", "scopeId", "semanticBuckets", "semanticTopScore", "version",
  ]);
  assert.equal(record.version, 1);
  assert.deepEqual(Object.keys(record.rejectReasons).sort(), [
    "literal_miss", "seen_cooldown", "semantic_below_threshold", "slot_full",
  ]);
  assert.deepEqual(Object.keys(record.semanticBuckets).sort(), ["cold", "hit", "near"]);
  // 桥接：导出常量必须与上面的字面值一致（防止有人改常量不改断言）。
  assert.deepEqual([...RECORD_FIELDS].sort(), [
    "at", "deliveredIds", "literalHits", "rejectReasons", "scopeId", "semanticBuckets", "semanticTopScore", "version",
  ]);
  assert.equal(DIAGNOSTICS_RECORD_VERSION, 1);
  assert.deepEqual([...REJECT_KEYS].sort(), ["literal_miss", "seen_cooldown", "semantic_below_threshold", "slot_full"]);
  assert.deepEqual([...BUCKET_KEYS].sort(), ["cold", "hit", "near"]);
  // 不抛即形状合法（含 total ≥ 明细数等口径）。
  assertRecordShape(record);
  // 逐卡明细桶都带 total（封顶口径的可见面）。
  for (const key of ["semantic_below_threshold", "seen_cooldown", "slot_full"]) {
    assert.ok(Number.isInteger(record.rejectReasons[key].total));
  }
});

test("记录不含正文：标题/摘要/正文/触发词子串检查全部不出现", () => {
  const card = secretCard();
  const record = buildRoundRecord({
    at: iso(T0),
    scopeId: "amber",
    cards: [card],
    match: { seeds: [{ id: card.id, revision: card.revision, trigger: card.triggers[0] }], related: [], anchors: [] },
    semantic: disabledSemantic(),
    delivery: { delivered: [{ id: card.id, revision: card.revision }], dropped: [] },
    threshold: 0.55,
  });
  const text = JSON.stringify(record);
  assert.ok(!text.includes(card.title), "标题不得进记录");
  assert.ok(!text.includes(card.summary), "摘要不得进记录");
  assert.ok(!text.includes(card.content), "正文不得进记录");
  assert.ok(!text.includes("xyz123"), "正文片段不得进记录");
  assert.ok(!text.includes(card.triggers[0]), "触发词不得进记录");
  assert.ok(text.includes(card.id), "卡 id 允许出现（归因键）");
});

test("assertRecordShape：未知字段/缺字段/错 version 一律 INVALID_INPUT", () => {
  const base = buildRoundRecord({
    at: iso(T0), scopeId: "amber", cards: [], match: null, semantic: disabledSemantic(), delivery: null, threshold: 0.55,
  });
  assertRecordShape(base);
  const extra = { ...base, sneaky: 1 };
  assert.throws(() => assertRecordShape(extra), (e) => e.code === "INVALID_INPUT" && /sneaky/.test(e.message));
  const { version, ...missingVersion } = base;
  assert.throws(() => assertRecordShape(missingVersion), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => assertRecordShape({ ...base, version: 2 }), (e) => e.code === "INVALID_INPUT" && /version/.test(e.message));
});

// ---------------------------------------------------------------------------
// 2. buildRoundRecord：一轮多卡归因完整性
// ---------------------------------------------------------------------------

test("一轮多卡归因：投出/冷却/槽满/低于阈值/无信号 各归其位，buckets 按 NEAR_MARGIN 分桶", () => {
  const threshold = 0.55;
  const record = buildRoundRecord({
    at: iso(T0),
    scopeId: "amber",
    cards: cardList("d", "s", "sc", "c2", "b", "sc2", "f", "m"),
    match: {
      seeds: [{ id: "d", revision: 1, trigger: "t" }],
      related: [],
      anchors: [{ id: "s", revision: 2, trigger: "t" }], // 字面命中但已 seen
    },
    semantic: disabledSemantic({
      enabled: true,
      used: false,
      threshold,
      scored: { b: 0.5, c2: 0.7, sc2: 0.3 }, // b 贴近阈值（near），sc2 深 cold，c2 达标
      cooledIds: ["sc"], // 语义可行但被 seen 预过滤
      topScore: 0.7,
      candidates: 1,
    }),
    delivery: {
      delivered: [{ id: "d", revision: 1 }],
      dropped: [{ id: "f", reason: "budget" }],
    },
    threshold,
  });
  assert.equal(record.literalHits, 2); // seeds + anchors
  assert.equal(record.semanticTopScore, 0.7);
  assert.deepEqual(record.semanticBuckets, { hit: 1, near: 1, cold: 1 });
  assert.deepEqual(record.deliveredIds, ["d"]);
  const reject = record.rejectReasons;
  assert.equal(reject.literal_miss, 1); // 只有 m 完全无信号
  assert.deepEqual(reject.semantic_below_threshold, { total: 2, scores: { b: 0.5, sc2: 0.3 } });
  assert.deepEqual(reject.seen_cooldown, { total: 2, ids: ["s", "sc"] });
  assert.deepEqual(reject.slot_full, { total: 2, ids: ["c2", "f"] });
});

test("分桶边界：恰好 NEAR_MARGIN 内算 near；threshold 缺省（语义未启用）三桶恒 0", () => {
  const threshold = 0.5;
  const nearEdge = threshold - NEAR_MARGIN; // 恰好贴边 → near
  const record = buildRoundRecord({
    at: iso(T0), scopeId: "amber",
    cards: [],
    match: null,
    semantic: disabledSemantic({ enabled: true, threshold, scored: { edge: nearEdge, low: nearEdge - 0.001, hit: threshold } }),
    delivery: null,
    threshold,
  });
  assert.deepEqual(record.semanticBuckets, { hit: 1, near: 1, cold: 1 });
  const disabled = buildRoundRecord({
    at: iso(T0), scopeId: "amber", cards: [], match: null, semantic: disabledSemantic(), delivery: null,
  });
  assert.deepEqual(disabled.semanticBuckets, { hit: 0, near: 0, cold: 0 });
  assert.equal(disabled.semanticTopScore, null);
});

// ---------------------------------------------------------------------------
// 评审 R1：被 seedCap 截断的字面命中 → slot_full（命中但没进槽），绝不落
// literal_miss；matchSparks 暴露的 literalHitIds（含截断候选）由诊断消费。
// ---------------------------------------------------------------------------

test("R1 夹具：4 张卡命中同一触发词、maxSeeds=3 → 第 4 张进 slot_full，覆盖率归因 matched-not-delivered", () => {
  // 真实 matchSparks：4 张卡都命中「洋葱」，种子槽只放 3 张。
  const hitCards = ["h1", "h2", "h3", "h4"].map((id, i) => ({
    id, revision: i + 1, title: id, summary: "", content: "", triggers: ["洋葱"],
    entities: [], links: [], scopeId: "amber", state: "active",
  }));
  const match = matchSparks({
    scopeId: "amber", userText: "切洋葱了吗", sparks: hitCards,
    seenKeys: [], sessionId: "s-1", contextEpoch: 0, maxSeeds: 3, maxRelated: 2,
  });
  assert.deepEqual(match.seeds.map((s) => s.id), ["h1", "h2", "h3"]);
  assert.deepEqual(match.literalHitIds, ["h1", "h2", "h3", "h4"], "matchSparks 必须暴露全量字面命中 id");
  const record = buildRoundRecord({
    at: iso(T0), scopeId: "amber",
    cards: hitCards,
    match,
    semantic: disabledSemantic(),
    delivery: { delivered: match.seeds.map((s) => ({ id: s.id, revision: s.revision })), dropped: [] },
    threshold: 0.55,
  });
  assert.equal(record.literalHits, 4, "字面命中数 = 全量命中（不再被 3 截断低估）");
  assert.deepEqual(record.deliveredIds, ["h1", "h2", "h3"]);
  assert.equal(record.rejectReasons.literal_miss, 0, "截断的第 4 张绝不落 literal_miss");
  assert.deepEqual(record.rejectReasons.slot_full.ids, ["h4"], "被截断的字面命中落「命中但没进槽」桶");

  // 覆盖率归因：h4 从未投出 → matched-not-delivered（不是 below-threshold）。
  const result = analyzeCoverage({
    records: [record],
    cards: hitCards,
    days: 7,
    now: T0,
  });
  const h4 = result.neverDelivered.find((entry) => entry.id === "h4");
  assert.ok(h4, "h4 在从未投递清单");
  assert.equal(h4.attribution.kind, "matched-not-delivered");
  assert.equal(h4.attribution.slotFullRounds, 1);
});

// ---------------------------------------------------------------------------
// 评审 R2：coverage 暴露 createdAt；统计只计 at >= createdAt 的轮次——刚创建
// 的卡不得冒出「分数始终低于阈值 / 向量索引过期」的误导归因。
// ---------------------------------------------------------------------------

test("R2 夹具：创建前的旧轮次证据不计入 → 新卡归因 no-recall-rounds，面板不推荐重建索引", async () => {
  // 旧身份（同 id 的已被删卡）在创建前留过一条 below-threshold 记录。
  const stale = blankRecord(iso(T0 - 2 * DAY_MS), {
    rejectReasons: {
      literal_miss: 0,
      semantic_below_threshold: { total: 1, scores: { "spark-secret": 0.4 } },
      seen_cooldown: { total: 0, ids: [] },
      slot_full: { total: 0, ids: [] },
    },
  });
  const card = { ...secretCard(), createdAt: iso(T0 - DAY_MS) }; // 窗口中途创建
  const result = await readDiagnostics({
    scopeId: "amber", days: 7, now: T0,
    readRecords: async () => [stale],
    listCards: async () => [card],
  });
  assert.equal(result.rounds, 1, "全局窗口轮次照常（不含 createdAt 过滤）");
  assert.equal(result.coverage[0].createdAt, iso(T0 - DAY_MS), "coverage 暴露 createdAt");
  const attribution = result.neverDelivered[0].attribution;
  assert.equal(attribution.kind, "no-recall-rounds", "创建后没有任何轮次 → 没聊到");
  assert.equal(attribution.rounds, 0);
  assert.equal(attribution.topScore, undefined, "不携带任何分数证据（不冒充 below-threshold）");

  // 创建后有轮次但从未被评分 → 评审 R14：not-scored（不再冒用 below-threshold
  // ——该归因的证明 = scoredRounds + topScore，这里两样都没有）。
  const fresh = blankRecord(iso(T0));
  const after = await readDiagnostics({
    scopeId: "amber", days: 7, now: T0,
    readRecords: async () => [stale, fresh],
    listCards: async () => [card],
    semanticEnabled: true,
  });
  const attribution2 = after.neverDelivered[0].attribution;
  assert.equal(attribution2.kind, "not-scored");
  assert.equal(attribution2.rounds, 1, "只计 createdAt 之后的轮次");
  assert.equal(attribution2.scoredRounds, 0);
  assert.equal(attribution2.topScore, null);
  assert.equal(attribution2.semanticEnabled, true);

  // 默认 provider=none（语义未开启）→ semanticEnabled false：面板不得建议「重建
  // 向量」（状态页该按钮此时是禁用的）。
  const disabled = await readDiagnostics({
    scopeId: "amber", days: 7, now: T0,
    readRecords: async () => [stale, fresh],
    listCards: async () => [card],
  });
  assert.equal(disabled.neverDelivered[0].attribution.kind, "not-scored");
  assert.equal(disabled.neverDelivered[0].attribution.semanticEnabled, false, "缺省注入 = 语义未开启");
});

// ---------------------------------------------------------------------------
// 评审 R6：明细截断（total > 明细条数）且无该卡逐卡证据 → evidence-truncated，
// 不默认 below-threshold。
// ---------------------------------------------------------------------------

test("R6 夹具：明细封顶截断的轮次 → 无证据卡归因 evidence-truncated", async () => {
  const record = blankRecord(iso(T0), {
    rejectReasons: {
      literal_miss: 0,
      // total=3 但明细只留 1 张（模拟 50 条封顶截断后的形状）。
      semantic_below_threshold: { total: 2, scores: { "b": 0.3 } },
      seen_cooldown: { total: 0, ids: [] },
      slot_full: { total: 3, ids: ["a"] },
    },
  });
  const cards = cardList("a", "b", "c");
  const result = await readDiagnostics({
    scopeId: "amber", days: 7, now: T0,
    readRecords: async () => [record],
    listCards: async () => cards,
  });
  const kinds = Object.fromEntries(result.neverDelivered.map((entry) => [entry.id, entry.attribution.kind]));
  assert.equal(kinds.a, "matched-not-delivered", "有明细证据的卡照常归因");
  assert.equal(kinds.b, "below-threshold", "有分数证据的卡照常归因");
  assert.equal(kinds.c, "evidence-truncated", "无证据但落在截断轮次的卡 → 证据不足");
});

// ---------------------------------------------------------------------------
// 评审 R4（单元口径）：appendedIds 与 delivery.delivered 解耦——deliveredIds
// 只收真正附加的卡，构建未追加的候选落 slot_full；非候选 id 拒绝。
// ---------------------------------------------------------------------------

test("R4 单元：appendedIds=[] → deliveredIds 空、候选落 slot_full；非候选 id INVALID_INPUT", () => {
  const cards = cardList("d", "f");
  const delivery = {
    delivered: [{ id: "d", revision: 1 }],
    dropped: [{ id: "f", reason: "budget" }],
  };
  const record = buildRoundRecord({
    at: iso(T0), scopeId: "amber", cards,
    match: { seeds: [{ id: "d", revision: 1, trigger: "t" }], related: [], anchors: [] },
    semantic: disabledSemantic(),
    delivery,
    appendedIds: [],
    threshold: 0.55,
  });
  assert.deepEqual(record.deliveredIds, [], "包构建了但未追加 → deliveredIds 恒空");
  assert.deepEqual(record.rejectReasons.slot_full.ids, ["d", "f"], "未追加候选与预算挤掉同落 slot_full");
  assert.equal(record.rejectReasons.literal_miss, 0);
  assert.throws(
    () => buildRoundRecord({
      at: iso(T0), scopeId: "amber", cards, match: null, semantic: disabledSemantic(), delivery,
      appendedIds: ["ghost"], threshold: 0.55,
    }),
    (e) => e.code === "INVALID_INPUT" && /ghost/.test(e.message),
    "appendedIds 必须是 delivery.delivered 子集",
  );
});

// ---------------------------------------------------------------------------
// 评审 R7：assertRecordShape 必须真的校验 total ≥ 明细条数。
// ---------------------------------------------------------------------------

test("R7：total < 明细条数（total=0 但明细 2 条）→ INVALID_INPUT", () => {
  const base = buildRoundRecord({
    at: iso(T0), scopeId: "amber", cards: [], match: null, semantic: disabledSemantic(), delivery: null, threshold: 0.55,
  });
  const broken = structuredClone(base);
  broken.rejectReasons.seen_cooldown = { total: 0, ids: ["x1", "x2"] };
  assert.throws(() => assertRecordShape(broken), (e) => e.code === "INVALID_INPUT" && /total/.test(e.message));
});

// ---------------------------------------------------------------------------
// 3. 逐卡明细封顶
// ---------------------------------------------------------------------------

test("封顶：below-threshold 保留最高分 20 张；seen_cooldown/slot_full 各 50 条；total 恒全量", () => {
  // 评审 R10：封顶数字钉死字面值（20/50），桥接断言防止实现与常量一起漂移。
  assert.equal(SCORE_DETAIL_CAP, 20);
  assert.equal(ID_DETAIL_CAP, 50);
  const many = Array.from({ length: 25 }, (_, i) => [`low-${String(i).padStart(2, "0")}`, 0.1 + i * 0.001]);
  const record = buildRoundRecord({
    at: iso(T0), scopeId: "amber",
    cards: many.map(([id]) => ({ id, revision: 1 })),
    match: null,
    semantic: disabledSemantic({ enabled: true, threshold: 0.55, scored: Object.fromEntries(many) }),
    delivery: null,
    threshold: 0.55,
  });
  const below = record.rejectReasons.semantic_below_threshold;
  assert.equal(below.total, 25);
  assert.equal(Object.keys(below.scores).length, 20);
  // 保留的是最高分：0.1 + 0.001*i 的最大 20 个 = i 从 5..24。
  const kept = Object.entries(below.scores);
  assert.equal(Math.min(...kept.map(([, cos]) => cos)), 0.1 + 5 * 0.001);
  assert.equal(Math.max(...kept.map(([, cos]) => cos)), 0.1 + 24 * 0.001);

  // seen_cooldown 超过 50：ids 取前 50（id 码点序），total 全量。
  const cooled = Array.from({ length: 57 }, (_, i) => `c${String(i).padStart(3, "0")}`);
  const record2 = buildRoundRecord({
    at: iso(T0), scopeId: "amber",
    cards: cooled.map((id) => ({ id, revision: 1 })),
    match: null,
    semantic: disabledSemantic({ enabled: true, threshold: 0.55, cooledIds: cooled }),
    delivery: null,
    threshold: 0.55,
  });
  assert.equal(record2.rejectReasons.seen_cooldown.total, 57);
  assert.equal(record2.rejectReasons.seen_cooldown.ids.length, 50);
  assert.deepEqual(record2.rejectReasons.seen_cooldown.ids[0], "c000");
  assert.deepEqual(record2.rejectReasons.seen_cooldown.ids[49], "c049");
});

// ---------------------------------------------------------------------------
// 4. trimRecords：7 天滚动 + 硬上限（纯函数层）
// ---------------------------------------------------------------------------

test("trimRecords：7 天窗口裁旧（边界保留）+ 硬上限留最新", () => {
  const records = [
    { version: 1, at: iso(T0 - 8 * DAY_MS) },  // 8 天前：裁
    { version: 1, at: iso(T0 - 7 * DAY_MS) },  // 恰好 7 天：保留（含边界）
    { version: 1, at: iso(T0 - DAY_MS) },
    { version: 1, at: iso(T0) },
    { version: 1, at: "not-a-time" },          // 崩溃残行同款：at 非法整条丢
  ];
  const kept = trimRecords(records, { days: 7, now: T0 });
  assert.deepEqual(kept.map((r) => r.at), [iso(T0 - 7 * DAY_MS), iso(T0 - DAY_MS), iso(T0)]);

  const numbered = Array.from({ length: DIAGNOSTICS_MAX_RECORDS + 10 }, (_, i) => ({ version: 1, at: iso(T0 + i) }));
  const capped = trimRecords(numbered, { days: 7, now: T0 + DIAGNOSTICS_MAX_RECORDS + 10 });
  assert.equal(capped.length, DIAGNOSTICS_MAX_RECORDS);
  assert.equal(capped[capped.length - 1].at, iso(T0 + DIAGNOSTICS_MAX_RECORDS + 9));

  // 评审 R10：默认 7 天钉死——不显式传 days 时必须裁掉 8 天前的记录；
  // 桥接断言保证常量与字面值一致。
  assert.equal(DIAGNOSTICS_RETENTION_DAYS, 7);
  assert.equal(DIAGNOSTICS_MAX_RECORDS, 2000);
  const defaultDays = trimRecords([
    { version: 1, at: iso(T0 - 8 * DAY_MS) },
    { version: 1, at: iso(T0) },
  ], { now: T0 });
  assert.deepEqual(defaultDays.map((r) => r.at), [iso(T0)], "缺省 days = 7 天滚动");
});

// ---------------------------------------------------------------------------
// 5. state 账本：7 天滚动裁旧（落盘层）+ 写失败只告警
// ---------------------------------------------------------------------------

function hexFileName(scopeId) {
  return `${Buffer.from(scopeId, "utf8").toString("hex")}.json`;
}

test("state 账本：appendRecord 逐条落账，7 天前旧记录在后续写入时被裁掉", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-diag-ledger-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  let nowMs = T0;
  const store = createStateStore({ stateRoot: base, now: () => new Date(nowMs) });

  await store.diagnosticsStore.appendRecord("amber", {
    version: 1, at: iso(T0), scopeId: "amber", literalHits: 0, semanticTopScore: null,
    semanticBuckets: { hit: 0, near: 0, cold: 0 }, deliveredIds: [],
    rejectReasons: { literal_miss: 0, semantic_below_threshold: { total: 0, scores: {} }, seen_cooldown: { total: 0, ids: [] }, slot_full: { total: 0, ids: [] } },
  });
  nowMs = T0 + 8 * DAY_MS; // 8 天后：第一条已出窗
  await store.diagnosticsStore.appendRecord("amber", {
    version: 1, at: iso(nowMs), scopeId: "amber", literalHits: 1, semanticTopScore: null,
    semanticBuckets: { hit: 0, near: 0, cold: 0 }, deliveredIds: ["x"],
    rejectReasons: { literal_miss: 0, semantic_below_threshold: { total: 0, scores: {} }, seen_cooldown: { total: 0, ids: [] }, slot_full: { total: 0, ids: [] } },
  });
  const records = await store.diagnosticsStore.readRecords("amber");
  assert.equal(records.length, 1, "7 天前的记录必须被滚动裁掉");
  assert.equal(records[0].deliveredIds[0], "x");
  const writer = store.diagnosticsStore.writerStats("amber");
  assert.equal(writer.appended, 2);
  assert.equal(writer.failed, 0);
});

test("state 账本：形状白名单违规直接抛（编程错误严格口径）", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-diag-ledger2-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const store = createStateStore({ stateRoot: base, now: () => new Date(T0) });
  await assert.rejects(
    () => store.diagnosticsStore.appendRecord("amber", { version: 1, at: iso(T0), content: "正文泄漏" }),
    (e) => e.code === "INVALID_INPUT",
  );
});

test("评审 R17：writerStats 按 scope 记数——多 scope 各读各账；无参/空 scopeId 抛 INVALID_INPUT", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-diag-scope-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  let nowMs = T0;
  const store = createStateStore({ stateRoot: base, now: () => new Date(nowMs) });
  const rec = (scopeId) => ({ version: 1, at: iso(nowMs), scopeId, literalHits: 0, semanticTopScore: null, semanticBuckets: { hit: 0, near: 0, cold: 0 }, deliveredIds: [], rejectReasons: { literal_miss: 0, semantic_below_threshold: { total: 0, scores: {} }, seen_cooldown: { total: 0, ids: [] }, slot_full: { total: 0, ids: [] } } });
  await store.diagnosticsStore.appendRecord("amber", rec("amber"));
  nowMs += 1000;
  await store.diagnosticsStore.appendRecord("amber", rec("amber"));
  nowMs += 1000;
  await store.diagnosticsStore.appendRecord("beta", rec("beta"));
  const amber = store.diagnosticsStore.writerStats("amber");
  const beta = store.diagnosticsStore.writerStats("beta");
  assert.equal(amber.appended, 2, "amber 记自己的 2 次");
  assert.equal(beta.appended, 1, "beta 记自己的 1 次（不串号）");
  assert.equal(amber.failed, 0);
  assert.equal(beta.failed, 0);
  assert.throws(() => store.diagnosticsStore.writerStats(), (e) => e.code === "INVALID_INPUT", "无参拒绝");
  assert.throws(() => store.diagnosticsStore.writerStats(""), (e) => e.code === "INVALID_INPUT", "空 scopeId 拒绝");
});

test("写失败只告警：stateRoot 指向普通文件 → {ok:false} + writer 计数，绝不抛", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-diag-fail-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fileRoot = path.join(base, "not-a-dir");
  await writeFile(fileRoot, "I am a file", "utf8"); // mkdir 会在此路径下失败
  const store = createStateStore({ stateRoot: fileRoot, now: () => new Date(T0) });
  const result = await store.diagnosticsStore.appendRecord("amber", {
    version: 1, at: iso(T0), scopeId: "amber", literalHits: 0, semanticTopScore: null,
    semanticBuckets: { hit: 0, near: 0, cold: 0 }, deliveredIds: [],
    rejectReasons: { literal_miss: 0, semantic_below_threshold: { total: 0, scores: {} }, seen_cooldown: { total: 0, ids: [] }, slot_full: { total: 0, ids: [] } },
  });
  assert.equal(result.ok, false);
  assert.ok(typeof result.error === "string" && result.error.length > 0);
  const writer = store.diagnosticsStore.writerStats("amber");
  assert.equal(writer.failed, 1);
  assert.ok(writer.lastError);
});

// ---------------------------------------------------------------------------
// 6. readDiagnostics / analyzeCoverage：两类未投递归因夹具 + 每卡覆盖率
// ---------------------------------------------------------------------------

const blankRecord = (at, overrides = {}) => ({
  version: 1, at, scopeId: "amber", literalHits: 0, semanticTopScore: null,
  semanticBuckets: { hit: 0, near: 0, cold: 0 }, deliveredIds: [],
  rejectReasons: { literal_miss: 0, semantic_below_threshold: { total: 0, scores: {} }, seen_cooldown: { total: 0, ids: [] }, slot_full: { total: 0, ids: [] } },
  ...overrides,
});

test("归因夹具一：期间无有效召回轮次（窗口零记录）", async () => {
  const result = await readDiagnostics({
    scopeId: "amber",
    days: 7,
    now: T0,
    readRecords: async () => [],
    listCards: async () => [secretCard()],
  });
  assert.equal(result.rounds, 0);
  assert.equal(result.neverDelivered.length, 1);
  assert.equal(result.neverDelivered[0].attribution.kind, "no-recall-rounds");
  assert.equal(result.neverDelivered[0].attribution.rounds, 0);
});

test("归因夹具二：有轮次但分数始终低于阈值（轮次计数 + 最高分证明）", async () => {
  const records = [
    blankRecord(iso(T0 - DAY_MS), {
      literalHits: 0,
      semanticTopScore: 0.5,
      semanticBuckets: { hit: 0, near: 1, cold: 0 },
      rejectReasons: {
        literal_miss: 0,
        semantic_below_threshold: { total: 1, scores: { "spark-secret": 0.5 } },
        seen_cooldown: { total: 0, ids: [] },
        slot_full: { total: 0, ids: [] },
      },
    }),
    blankRecord(iso(T0), {
      literalHits: 0,
      semanticTopScore: 0.44,
      semanticBuckets: { hit: 0, near: 0, cold: 1 },
      rejectReasons: {
        literal_miss: 0,
        semantic_below_threshold: { total: 1, scores: { "spark-secret": 0.44 } },
        seen_cooldown: { total: 0, ids: [] },
        slot_full: { total: 0, ids: [] },
      },
    }),
  ];
  const result = await readDiagnostics({
    scopeId: "amber", days: 7, now: T0,
    readRecords: async () => records,
    listCards: async () => [secretCard()],
  });
  assert.equal(result.rounds, 2);
  assert.equal(result.neverDelivered.length, 1);
  const attribution = result.neverDelivered[0].attribution;
  assert.equal(attribution.kind, "below-threshold");
  assert.equal(attribution.rounds, 2);
  assert.equal(attribution.scoredRounds, 2);
  assert.equal(attribution.topScore, 0.5, "最高分 = 逐轮余弦分最大值（两轮都低于阈值）");
});

test("归因夹具三（补充）：有命中轮次但从未投出 → matched-not-delivered，不冒充 below-threshold", async () => {
  const records = [
    blankRecord(iso(T0), {
      literalHits: 1,
      rejectReasons: {
        literal_miss: 0,
        semantic_below_threshold: { total: 0, scores: {} },
        seen_cooldown: { total: 1, ids: ["spark-secret"] },
        slot_full: { total: 0, ids: [] },
      },
    }),
  ];
  const result = await readDiagnostics({
    scopeId: "amber", days: 7, now: T0,
    readRecords: async () => records,
    listCards: async () => [secretCard()],
  });
  assert.equal(result.rounds, 1);
  assert.equal(result.neverDelivered[0].attribution.kind, "matched-not-delivered");
  assert.equal(result.neverDelivered[0].attribution.seenCooldownRounds, 1);
});

test("每卡覆盖率：窗口内投递次数 / used（累计口径如实标注）/ 最后命中；高频投递低使用清单", async () => {
  const records = [
    blankRecord(iso(T0 - DAY_MS), { deliveredIds: ["spark-secret"] }),
    blankRecord(iso(T0 - 2 * DAY_MS), { deliveredIds: ["spark-secret"] }),
    blankRecord(iso(T0 - 3 * DAY_MS), { deliveredIds: ["spark-secret"] }),
    blankRecord(iso(T0 - 4 * DAY_MS), { deliveredIds: ["spark-secret"] }),
  ];
  const card = { ...secretCard(), useCount: 0, lastHitAt: iso(T0 - DAY_MS) };
  const result = await readDiagnostics({
    scopeId: "amber", days: 7, now: T0,
    readRecords: async () => records,
    listCards: async () => [card],
  });
  assert.equal(result.coverage.length, 1);
  const coverage = result.coverage[0];
  assert.equal(coverage.deliveries, 4);
  assert.equal(coverage.used, 0);
  assert.equal(coverage.usedScope, "all-time");
  assert.equal(coverage.lastHitAt, iso(T0 - DAY_MS));
  assert.equal(coverage.lastDeliveryAt, iso(T0 - DAY_MS));
  assert.equal(result.highDeliveryLowUsage.length, 1, "窗口内 4 次投递且 used === 0 → 入清单");
  assert.equal(result.neverDelivered.length, 0);

  // used > 0：同一张卡退出「高频投递但低使用」清单。
  const used = await readDiagnostics({
    scopeId: "amber", days: 7, now: T0,
    readRecords: async () => records,
    listCards: async () => [{ ...card, useCount: 1 }],
  });
  assert.equal(used.highDeliveryLowUsage.length, 0);
});

test("readDiagnostics：读取侧再裁一次 7 天窗口（防账本里残留超窗旧记录）", async () => {
  const records = [
    blankRecord(iso(T0 - 30 * DAY_MS), { deliveredIds: ["spark-secret"] }),
    blankRecord(iso(T0), { deliveredIds: ["spark-secret"] }),
  ];
  const result = await readDiagnostics({
    scopeId: "amber", days: 7, now: T0,
    readRecords: async () => records,
    listCards: async () => [],
  });
  assert.equal(result.rounds, 1, "30 天前的记录不进 7 天窗口");
});

// ---------------------------------------------------------------------------
// 7. controller 接线：pre-step 落账（非阻塞）+ shadow / HOST_LOCKED 零写入
// ---------------------------------------------------------------------------

function fakeBindingsFactory() {
  const registered = { sections: [], tools: [], waterfall: null, preStep: null, sessionEvents: null, disposed: 0 };
  const factory = () => ({
    registerSystemSection({ name }) { registered.sections.push(name); return true; },
    registerAssembleWaterfall(h) { registered.waterfall = h; return true; },
    registerPreStep(h) { registered.preStep = h; return true; },
    subscribeSessionEvents(l) { registered.sessionEvents = l; return true; },
    async registerTool() { registered.tools.push("t"); return true; },
    async loadCreateUserMessage() {
      return (input) => ({ id: `msg-${Math.random().toString(16).slice(2, 10)}`, role: "user", content: input.content, source: input.source });
    },
    disposeAll() {
      registered.disposed += 1;
      registered.sections = []; registered.tools = [];
      registered.waterfall = null; registered.preStep = null; registered.sessionEvents = null;
      return { disposed: true, errors: [] };
    },
    get diagnostics() {
      return { registeredSections: registered.sections, registeredTools: registered.tools, waterfall: true, preStep: true, sessionEvents: true };
    },
  });
  factory.registered = registered;
  return factory;
}

function fakeCtx() {
  return { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} };
}

function humanMessage(id, text) {
  return { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] };
}

/** 评审 R21：等 fire-and-forget 计数到位。计数在 appendRecord 的 .then 里更新，
 * 文件内容可见早于 promise 决议（waitForFile 一见文件就读计数会翻车，全量负载
 * 下顺序翻转即「本地绿、CI 红」）；固定 sleep 不许用、放宽成 >= 失去守卫意义——
 * 25ms 一步轮询，超时把当前实际值打印进断言消息。 */
async function awaitCounter(controller, key, expected, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let current = controller.diagnostics().counters[key];
  while (current !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = controller.diagnostics().counters[key];
  }
  assert.equal(current, expected, `${key} 应为 ${expected}（轮询超时，实际值 ${current}）——fire-and-forget 计数在 appendRecord 的 .then 里更新，需等待决议`);
}

/** 等待 fire-and-forget 落账出现（诊断写不阻塞 pre-step，测试轮询文件）。 */
async function waitForFile(file, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function diagnosticsFile(stateRoot, scopeId) {
  return path.join(stateRoot, "diagnostics", hexFileName(scopeId));
}

test("controller 接线：pre-step 每轮落账（不含正文）→ getStatus.diagnostics.delivery 注入两清单", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-diag-ctrl-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot, stateRoot,
    ownerId: "local", defaultPersona: "amber",
    l2: { enabled: true },
  }, { bindings });
  await controller.start();
  const trusted = { session: { id: "s-1" }, source: "panel-rpc" };
  const saved = await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: {
      title: "洋葱梗",
      content: "问眼里常含泪水，原来刚切过洋葱。",
      summary: "洋葱梗摘要",
      triggers: ["洋葱"],
      vitality: "evergreen",
    },
  });

  const agent = { session: { id: "s-1" } };
  // 第一轮：命中 → 投出。
  await bindings.registered.preStep(
    { agent, messages: [humanMessage("m-1", "今天切洋葱了吗")] },
    async () => ({ kind: "enter", messages: [humanMessage("m-1", "今天切洋葱了吗")] }),
  );
  const file = await diagnosticsFile(stateRoot, "amber");
  // 6B-2 去墙钟：完成信号门控——计数在 appendRecord 的 .then 里更新，
  // counter==1 ⇒ 第一轮记录已写盘，再读文件断言内容。
  await awaitCounter(controller, "deliveryDiagAppended", 1);
  const first = JSON.parse(await readFile(file, "utf8")).records;
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].deliveredIds, [saved.id]);
  assert.equal(first[0].literalHits, 1);
  assert.ok(!JSON.stringify(first).includes("洋葱"), "账本不含卡片标题/正文/触发词");

  // 第二轮：无命中 → 空投轮也落账（归因数据源）。
  await bindings.registered.preStep(
    { agent, messages: [humanMessage("m-2", "今天天气不错")] },
    async () => ({ kind: "enter", messages: [humanMessage("m-2", "今天天气不错")] }),
  );
  // 6B-2 去墙钟：第二轮同样以完成信号门控——counter==2 ⇒ 文件已有两条记录
  // （写盘 resolve 后计数才 +1），不再墙钟轮询文件。
  await awaitCounter(controller, "deliveryDiagAppended", 2);
  const second = JSON.parse(await readFile(file, "utf8")).records;
  assert.equal(second.length, 2, "counter==2 ⇒ 文件应有恰好两条记录");
  assert.deepEqual(second[1].deliveredIds, []);
  assert.equal(second[1].literalHits, 0);
  assert.equal(second[1].rejectReasons.literal_miss, 1, "唯一一张卡该轮无信号 → literal_miss 基线");

  // 计数器（controller 侧写成功口径；评审 R21：计数在 .then 里更新——两轮
  // 门控已前置，此处复核仍为 2、未出现第三次落账）。
  await awaitCounter(controller, "deliveryDiagAppended", 2);
  const d = controller.diagnostics();
  assert.equal(d.counters.deliveryDiagFailed, 0);

  // getStatus.diagnostics.delivery 注入（wire 纯增量块，面板「投递体检」数据源）。
  const status = await controller.management.getStatus(
    { session: { id: "s-1" }, agent, source: "panel-rpc" }, {},
  );
  const checkup = status.diagnostics?.delivery;
  assert.ok(checkup && checkup.available === true, `delivery 体检块应可用：${JSON.stringify(checkup)}`);
  assert.equal(checkup.rounds, 2);
  const entry = checkup.coverage.find((c) => c.id === saved.id);
  assert.ok(entry, "覆盖率含已投递卡");
  assert.equal(entry.deliveries, 1);
  assert.equal(checkup.neverDelivered.length, 0);
  assert.equal(checkup.highDeliveryLowUsage.length, 0, "仅 1 次投递，未达高频下限");
  assert.ok(checkup.writer.appended >= 2);
  await controller.stop();
});

test("R4 接线：宿主未放行（next 非 enter）→ 记录 deliveredIds 恒空，候选落 slot_full", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-diag-noenter-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot, stateRoot,
    ownerId: "local", defaultPersona: "amber",
    l2: { enabled: true },
  }, { bindings });
  await controller.start();
  const trusted = { session: { id: "s-1" }, source: "panel-rpc" };
  const saved = await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "洋葱梗", content: "切过洋葱。", triggers: ["洋葱"], vitality: "evergreen" },
  });
  const agent = { session: { id: "s-1" } };
  // next 返回非 enter：包构建了但宿主不放行 → 不追加。
  const decision = await bindings.registered.preStep(
    { agent, messages: [humanMessage("m-1", "切洋葱")] },
    async () => ({ kind: "blocked" }),
  );
  assert.equal(decision.kind, "blocked");
  const file = await diagnosticsFile(stateRoot, "amber");
  assert.ok(await waitForFile(file), "定局后仍要落账");
  const records = JSON.parse(await readFile(file, "utf8")).records;
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].deliveredIds, [], "未真正附加 → deliveredIds 恒空（评审 R4）");
  assert.deepEqual(records[0].rejectReasons.slot_full.ids, [saved.id], "已构建候选落「命中但没投出」桶");
  await awaitCounter(controller, "deliveryDiagAppended", 1);
  const d = controller.diagnostics();
  await controller.stop();
});

test("shadow 模式零写入：pre-step 根本不注册，diagnostics 目录不存在（fs 断言）", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-diag-shadow-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "shadow", allowActive: false,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    defaultPersona: "amber",
    l2: { enabled: true },
  }, { bindings });
  await controller.start();
  assert.equal(bindings.registered.preStep, null, "shadow 不注册 pre-step（无投递入口）");
  assert.equal(existsSync(path.join(base, "state", "diagnostics")), false, "shadow 不得创建 diagnostics 目录");
  await controller.stop();
});

test("评审 R16：destroyData 焚毁后内存快照失效 → getStatus 不得残留已焚毁卡片", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-diag-destroy-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot, stateRoot,
    ownerId: "local", defaultPersona: "amber",
    l2: { enabled: true },
  }, { bindings });
  await controller.start();
  const trusted = { session: { id: "s-1" }, source: "panel-rpc", principal: { kind: "owner" } };
  // 铺卡 + 跑一轮：内存快照填充（含卡片 title）。
  await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "洋葱梗焚毁前", content: "焚毁前内容。", triggers: ["焚毁词"], vitality: "evergreen" },
  });
  await bindings.registered.preStep(
    { agent: { session: { id: "s-1" } }, messages: [humanMessage("m-1", "焚毁词")] },
    async () => ({ kind: "enter", messages: [humanMessage("m-1", "焚毁词")] }),
  );
  assert.ok(await waitForFile(await diagnosticsFile(stateRoot, "amber")), "落账完成");
  const before = await controller.management.getStatus(trusted, {});
  assert.equal(before.diagnostics.delivery.available, true, "焚毁前体检可用");
  assert.ok(before.diagnostics.delivery.coverage.some((c) => String(c.title || "").includes("焚毁前")), "快照含卡片 title");

  // 焚毁 dataRoot + stateRoot → closeAllScopes 必须同时失效内存快照。
  await controller.management.destroyData(trusted, { confirm: dataRoot });
  const after = await controller.management.getStatus(trusted, {});
  const afterDelivery = after.diagnostics && after.diagnostics.delivery;
  const stale = afterDelivery && afterDelivery.available === true
    && Array.isArray(afterDelivery.coverage)
    && afterDelivery.coverage.some((c) => String(c.title || "").includes("焚毁前"));
  assert.ok(!stale, "不得返回已焚毁卡片的 title/覆盖率（评审 R16）");
  assert.ok(!JSON.stringify(after).includes("焚毁前"), "面板状态不得残留已焚毁卡片信息");
  await controller.stop();
});

test("只读宿主（HOST_LOCKED）零写入：座位被占时 pre-step 照常投递但不落诊断账本", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-diag-locked-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot, stateRoot,
    ownerId: "local", defaultPersona: "amber",
    l2: { enabled: true },
  }, {
    bindings,
    // 只读座位桩：guard.status().writable === false（与真实 readonly-guard 状态机同形状）。
    createSeatGuardFactory: async () => ({
      guard: {
        assertWritable() {
          const error = new Error("HOST_LOCKED: another Shiori instance holds the write lock");
          error.code = "HOST_LOCKED";
          throw error;
        },
        status: () => ({ writable: false, holder: { instanceId: "stub" } }),
      },
      status: () => ({ writable: false, seat: {} }),
      stop: async () => {},
    }),
  });
  await controller.start();
  // HOST_LOCKED 下写工具被拒 → 直接开 store 铺卡（与投递无 CAS 冲突）。
  const store = await openSparkStore({ root: dataRoot, scopeId: "amber" });
  const savedCard = await store.save({
    title: "暗号", content: "芝麻开门。", triggers: ["芝麻"], vitality: "evergreen",
  }, { operationId: "seed-locked-1" });
  store.close();

  const agent = { session: { id: "s-1" } };
  const decision = await bindings.registered.preStep(
    { agent, messages: [humanMessage("m-1", "芝麻")] },
    async () => ({ kind: "enter", messages: [humanMessage("m-1", "芝麻")] }),
  );
  assert.equal(decision.messages.length, 2, "投递主链路不受只读座位影响（既有行为）");
  await new Promise((resolve) => setTimeout(resolve, 150)); // 给（不应发生的）落账留窗口
  assert.equal(existsSync(path.join(stateRoot, "diagnostics")), false, "只读宿主不得创建 diagnostics 目录");
  const d = controller.diagnostics();
  assert.equal(d.counters.deliveryDiagAppended, 0);
  assert.equal(d.counters.deliveryDiagSkipped, 0);
  assert.equal(d.counters.deliveryDiagFailed, 0);
  void savedCard;
  await controller.stop();
});
