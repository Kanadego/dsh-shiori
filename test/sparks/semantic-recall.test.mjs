// Shiori F1b · 语义召回合并测试（假 provider 固定向量，不碰真实模型）。
//
// 覆盖（F1b 任务书 h 条）：
// 1. provider=null：结果与纯字面 matchSparks 完全一致（deepEqual），embed 零调用；
// 2. 假 provider 固定向量：合并顺序（字面种子在前、向量补位在后）、cosine
//    top-k、阈值以下不补；
// 3. 四道闸门逐一验证（不许绕过）：
//    - seen 冷却：向量相似的已冷却卡绝不入种子；
//    - 泛化实体排除：>5 张卡共享的实体不参与向量种子的 1 跳扩散；
//    - maxSeeds 3：向量补位只填字面剩下的名额，总数恒 ≤3；
//    - maxRelated 2：关联合并字面优先，总数恒 ≤2；
// 4. provider 不可用（embed 抛 SEMANTIC_UNAVAILABLE）：与纯字面 deepEqual，
//    错误进 semantic.error 诊断，不外溢；
// 5. revision 过期 / 缺失向量不补位（召回路径不隐式写索引）；
// 6. 字面种子已满 → 不做 embed（零开销短路）。

import test from "node:test";
import assert from "node:assert/strict";
import { matchSparks, seenKeyFor } from "../../src/sparks/match.mjs";
import { mergeSemanticRecall, SEMANTIC_SIMILARITY_THRESHOLD } from "../../src/sparks/semantic-recall.mjs";

const SCOPE = "amber";
const SESSION = "sess-1";
const EPOCH = 0;

/** 构造 active 卡片记录（与 sparks store 记录形状一致的最小投影）。 */
function card(id, { triggers = [], entities = [], links = [], revision = 1 } = {}) {
  return { id, title: id, summary: "", content: "", triggers, entities, links, scopeId: SCOPE, state: "active", revision };
}

/** 假 provider：query 向量固定为 [1,0,0,0]；embed 调用计数可断言。 */
function fakeProvider(queryVec = [1, 0, 0, 0]) {
  const calls = [];
  return {
    calls,
    kind: "local",
    dims: queryVec.length,
    async embed(text) {
      calls.push(text);
      return Float32Array.from(queryVec);
    },
  };
}

/** vectorsFor：sparkId → {revision, vec}（threshold 判定用 2/4 维小向量即可，
 *  cosineSimilarity 自带归一化，任意同维度向量都成立）。 */
function vectorIndex(map) {
  return (sparkId) => map.get(sparkId) ?? null;
}

function seenKey(sparkId, revision = 1) {
  // 冷却键用 match.mjs 的权威构造器（不手拼字符串，防止格式漂移）。
  return seenKeyFor({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH, sparkId, revision,
  });
}

test("provider=null：与纯字面逐字节等价，embed 零调用，不触碰向量索引", async () => {
  const cards = [card("a", { triggers: ["咖啡"] }), card("b", { triggers: ["奶茶"] })];
  const args = {
    scopeId: SCOPE,
    userText: "给我讲讲手冲咖啡",
    sparks: cards,
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
  };
  const provider = fakeProvider();
  const outcome = await mergeSemanticRecall({ ...args, provider, vectorsFor: null });
  const literal = matchSparks(args);
  assert.deepEqual(outcome.match, literal, "merge result must equal pure literal match");
  assert.deepEqual(outcome.match.seeds.map((s) => s.id), ["a"]);
  assert.equal(outcome.semantic.enabled, false);
  assert.equal(outcome.semantic.used, false);
  assert.equal(provider.calls.length, 0, "provider must not be consulted");

  // vectorsFor 有、provider 无：同样不碰索引（enabled=false 由 provider 决定）
  const outcome2 = await mergeSemanticRecall({
    ...args, provider: null, vectorsFor: vectorIndex(new Map([["b", { revision: 1, vec: Float32Array.from([1, 0, 0, 0]) }]])),
  });
  assert.deepEqual(outcome2.match, literal);
});

test("向量补位：字面种子在前、向量按 cos 降序补足剩余槽位", async () => {
  // a 命中字面 trigger；b/c 无 trigger 但向量相似（b 更近）；d 相似度低于阈值。
  const cards = [
    card("a", { triggers: ["咖啡"] }),
    card("b"),
    card("c"),
    card("d"),
  ];
  const index = new Map([
    ["b", { revision: 1, vec: Float32Array.from([0.99, 0.1, 0, 0]) }],  // cos≈0.995
    ["c", { revision: 1, vec: Float32Array.from([0.7, 0.7, 0, 0]) }],   // cos≈0.707
    ["d", { revision: 1, vec: Float32Array.from([0.3, 0.9, 0, 0]) }],   // cos≈0.316 < 0.45
  ]);
  const outcome = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "来杯手冲咖啡",
    sparks: cards,
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider: fakeProvider(),
    vectorsFor: vectorIndex(index),
  });
  assert.deepEqual(outcome.match.seeds.map((s) => s.id), ["a", "b", "c"], "literal first, then vector by cosine desc");
  assert.equal(outcome.semantic.used, true);
  assert.equal(outcome.semantic.candidates, 2, "d 在阈值之下不进入候选");
  assert.equal(outcome.semantic.error, null);
});

test("闸门一（seen 冷却）：向量相似的已冷却卡绝不入种子", async () => {
  const cards = [card("a", { triggers: ["咖啡"] }), card("b"), card("c")];
  const index = new Map([
    ["b", { revision: 1, vec: Float32Array.from([1, 0, 0, 0]) }],
    ["c", { revision: 1, vec: Float32Array.from([0.95, 0.3, 0, 0]) }],
  ]);
  const outcome = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "来杯手冲咖啡",
    sparks: cards,
    seenKeys: [seenKey("b", 1)], // b 已冷却（同 revision）
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider: fakeProvider(),
    vectorsFor: vectorIndex(index),
  });
  const ids = outcome.match.seeds.map((s) => s.id);
  assert.ok(!ids.includes("b"), "seen card must stay cooled off despite high cosine");
  assert.deepEqual(ids, ["a", "c"]);
  // revision 变了 = 新内容，可再次补位（seen 键含 revision 的既有语义）
  const fresh = card("b", { revision: 2 });
  const outcome2 = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "来杯手冲咖啡",
    sparks: [card("a", { triggers: ["咖啡"] }), fresh],
    seenKeys: [seenKey("b", 1)],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider: fakeProvider(),
    vectorsFor: vectorIndex(new Map([["b", { revision: 2, vec: Float32Array.from([1, 0, 0, 0]) }]])),
  });
  assert.ok(outcome2.match.seeds.some((s) => s.id === "b"), "revision-bumped card may re-enter");
});

test("闸门三（maxSeeds 3）：字面占 1 时向量最多补 2，总数恒 ≤3", async () => {
  const cards = [
    card("lit", { triggers: ["咖啡"] }),
    ...["v1", "v2", "v3", "v4"].map((id) => card(id)),
  ];
  const index = new Map(
    ["v1", "v2", "v3", "v4"].map((id, i) => [id, { revision: 1, vec: Float32Array.from([1 - i * 0.05, i * 0.05, 0, 0]) }]),
  );
  const outcome = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "咖啡",
    sparks: cards,
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider: fakeProvider(),
    vectorsFor: vectorIndex(index),
  });
  assert.equal(outcome.match.seeds.length, 3, "hard cap 3");
  assert.equal(outcome.match.seeds[0].id, "lit");
  assert.deepEqual(outcome.match.seeds.slice(1).map((s) => s.id), ["v1", "v2"], "cosine desc fills remaining slots only");

  // 字面已满 3 → 无位可补，连 embed 都不发生
  const fullCards = [
    card("l1", { triggers: ["咖啡"] }),
    card("l2", { triggers: ["手冲"] }),
    card("l3", { triggers: ["磨豆"] }),
    card("v1"),
  ];
  const provider = fakeProvider();
  const outcome2 = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "咖啡 手冲 磨豆",
    sparks: fullCards,
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider,
    vectorsFor: vectorIndex(new Map([["v1", { revision: 1, vec: Float32Array.from([1, 0, 0, 0]) }]])),
  });
  assert.equal(outcome2.match.seeds.length, 3);
  assert.deepEqual(outcome2.match.seeds.map((s) => s.id), ["l1", "l2", "l3"]);
  assert.equal(provider.calls.length, 0, "slots full → embed must not even run");
});

test("闸门四（maxRelated 2）+ 字面优先：向量种子的扩散只填剩余名额", async () => {
  // 字面种子 a 通过 link 扩散出 r1；向量种子 b 通过 link 扩散出 r1（去重）与 r2。
  const cards = [
    card("a", { triggers: ["咖啡"], links: [{ target: "r1", rel: "related" }] }),
    card("b", { links: [{ target: "r1", rel: "related" }, { target: "r2", rel: "related" }] }),
    card("r1"),
    card("r2"),
  ];
  const index = new Map([["b", { revision: 1, vec: Float32Array.from([1, 0, 0, 0]) }]]);
  const outcome = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "咖啡",
    sparks: cards,
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider: fakeProvider(),
    vectorsFor: vectorIndex(index),
  });
  assert.deepEqual(outcome.match.seeds.map((s) => s.id), ["a", "b"]);
  assert.deepEqual(outcome.match.related.map((r) => r.id), ["r1", "r2"]);
  assert.equal(outcome.match.related.length, 2);

  // 字面 related 已占满 2 → 向量种子的扩散不加入（字面优先，总量 ≤2）
  const cardsFull = [
    card("a", { triggers: ["咖啡"], links: [{ target: "r1", rel: "related" }] }),
    card("a2", { triggers: ["手冲"], links: [{ target: "r2", rel: "related" }] }),
    card("b", { links: [{ target: "r3", rel: "related" }] }),
    card("r1"), card("r2"), card("r3"),
  ];
  const outcome2 = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "咖啡 手冲",
    sparks: cardsFull,
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider: fakeProvider(),
    vectorsFor: vectorIndex(new Map([["b", { revision: 1, vec: Float32Array.from([1, 0, 0, 0]) }]])),
  });
  assert.equal(outcome2.match.related.length, 2);
  assert.deepEqual(outcome2.match.related.map((r) => r.id), ["r1", "r2"]);
});

test("闸门二（泛化实体排除）：>5 张卡共享的实体不参与向量种子的扩散", async () => {
  // 向量种子 v 通过实体「工作」扩散；该实体被 7 张卡共享 → 泛化排除。
  const generalized = ["g1", "g2", "g3", "g4", "g5", "g6", "g7"].map((id) => card(id, { entities: ["工作"] }));
  const cards = [
    card("a", { triggers: ["咖啡"] }),
    card("v", { entities: ["工作"] }),
    ...generalized,
  ];
  const index = new Map([["v", { revision: 1, vec: Float32Array.from([1, 0, 0, 0]) }]]);
  const outcome = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "咖啡",
    sparks: cards,
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider: fakeProvider(),
    vectorsFor: vectorIndex(index),
  });
  assert.deepEqual(outcome.match.seeds.map((s) => s.id), ["a", "v"]);
  assert.equal(outcome.match.related.length, 0, "generalized entity must not expand");

  // 对照组：实体只被 2 张卡共享（含 v）→ 正常扩散
  const rare = [card("r1", { entities: ["小众"] })];
  const outcome2 = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "咖啡",
    sparks: [card("a", { triggers: ["咖啡"] }), card("v", { entities: ["小众"] }), ...rare],
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider: fakeProvider(),
    vectorsFor: vectorIndex(new Map([["v", { revision: 1, vec: Float32Array.from([1, 0, 0, 0]) }]])),
  });
  assert.deepEqual(outcome2.match.related.map((r) => r.id), ["r1"], "rare entity expands normally");
});

test("provider 不可用（embed 抛错）：与纯字面 deepEqual，错误进诊断不外溢", async () => {
  const cards = [card("a", { triggers: ["咖啡"] })];
  const args = {
    scopeId: SCOPE,
    userText: "咖啡",
    sparks: cards,
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
  };
  const brokenProvider = {
    kind: "local",
    dims: 4,
    embed: async () => {
      const error = new Error("本地 embedding 运行时加载失败");
      error.code = "SEMANTIC_UNAVAILABLE";
      throw error;
    },
  };
  const outcome = await mergeSemanticRecall({ ...args, provider: brokenProvider, vectorsFor: vectorIndex(new Map()) });
  assert.deepEqual(outcome.match, matchSparks(args));
  assert.equal(outcome.semantic.error, "本地 embedding 运行时加载失败");
  assert.equal(outcome.semantic.used, false);
});

test("过期/缺失向量不补位；索引与卡片维度不符跳过不抛", async () => {
  const cards = [card("a", { triggers: ["咖啡"] }), card("b", { revision: 2 }), card("c", { revision: 3 })];
  const index = new Map([
    ["b", { revision: 1, vec: Float32Array.from([1, 0, 0, 0]) }],  // 卡片已到 rev2 → 过期
    ["c", { revision: 3, vec: Float32Array.from([1, 0, 0]) }],     // 3 维 ≠ 查询 4 维 → 跳过
  ]);
  const outcome = await mergeSemanticRecall({
    scopeId: SCOPE,
    userText: "咖啡",
    sparks: cards,
    seenKeys: [],
    sessionId: SESSION,
    contextEpoch: EPOCH,
    maxSeeds: 3,
    maxRelated: 2,
    provider: fakeProvider(),
    vectorsFor: vectorIndex(index),
  });
  assert.deepEqual(outcome.match.seeds.map((s) => s.id), ["a"]);
  assert.equal(outcome.semantic.used, false);
  assert.equal(outcome.semantic.candidates, 0);
});

test("阈值常量 = 0.45（实测校准值，见源码注释；防止无意漂移）", () => {
  assert.equal(SEMANTIC_SIMILARITY_THRESHOLD, 0.45);
});
