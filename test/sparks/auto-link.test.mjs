// 0.5-5C · src/sparks/auto-link.mjs 自动连线器测试（node:test，全部合成）。
// 覆盖：阈值/上限/排序确定性/去重/excludeId/新鲜度判据/降级跳过（provider 不可用、
// 索引不可用、embed 抛错、canEmbed=false）——零报错零补写是任务书硬要求。
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createAutoLinker,
  AUTO_LINK_REL,
  AUTO_LINK_THRESHOLD,
  AUTO_LINK_MAX,
} from "../../src/sparks/auto-link.mjs";

const SCOPE = "amber";
const EMBED_TEXT = (card) => [card.title, card.summary, card.content]
  .filter((part) => typeof part === "string" && part.length > 0)
  .join("\n");

/** 合成卡：id/revision/scopeId/state 齐全的 active 卡。 */
function card(id, { revision = 1, state = "active", scopeId = SCOPE, title = `卡${id}` } = {}) {
  return { id, scopeId, revision, state, title, summary: null, content: `正文-${id}`, vitality: "evergreen", links: [] };
}

/** 假向量索引：entries 为 Map<id, {revision, vec}>；vec 用 [seed] 单维可分辨。 */
function fakeVectorStore(entries) {
  return {
    get(id) {
      const entry = entries.get(id);
      return entry === undefined ? null : { revision: entry.revision, vec: entry.vec };
    },
  };
}

test("常量与任务书拍板值一致（阈值 0.80 / 上限 3 / rel auto:similar）", () => {
  assert.equal(AUTO_LINK_REL, "auto:similar");
  assert.equal(AUTO_LINK_THRESHOLD, 0.8);
  assert.equal(AUTO_LINK_MAX, 3);
});

test("createAutoLinker rejects wiring errors fail-fast (scopeId/openVectorStore/listActive/embedText/threshold/max)", () => {
  const ok = () => async () => {};
  assert.throws(() => createAutoLinker({ scopeId: "", provider: {}, openVectorStore: ok, listActive: ok, embedText: ok }), TypeError);
  assert.throws(() => createAutoLinker({ scopeId: SCOPE, provider: {}, openVectorStore: null, listActive: ok, embedText: ok }), TypeError);
  assert.throws(() => createAutoLinker({ scopeId: SCOPE, provider: {}, openVectorStore: ok, listActive: null, embedText: ok }), TypeError);
  assert.throws(() => createAutoLinker({ scopeId: SCOPE, provider: {}, openVectorStore: ok, listActive: ok, embedText: null }), TypeError);
  assert.throws(() => createAutoLinker({ scopeId: SCOPE, provider: {}, openVectorStore: ok, listActive: ok, embedText: ok, threshold: 0 }), TypeError);
  assert.throws(() => createAutoLinker({ scopeId: SCOPE, provider: {}, openVectorStore: ok, listActive: ok, embedText: ok, threshold: 1.2 }), TypeError);
  assert.throws(() => createAutoLinker({ scopeId: SCOPE, provider: {}, openVectorStore: ok, listActive: ok, embedText: ok, max: -1 }), TypeError);
});

test("top-k 排序：相似度降序、平局按 id 升序；上限 3 截断；结果带 rel/score", async () => {
  // query 向量 = [1]；老卡向量 [cos, 1] 归一化后余弦可分辨（cosineSimilarity 自带归一化）。
  const cards = [
    card("c1"), card("c2"), card("c3"), card("c4"), card("c5"),
  ];
  const entries = new Map([
    ["c1", { revision: 1, vec: Float32Array.from([1, 0.5]) }],   // 高分
    ["c2", { revision: 1, vec: Float32Array.from([1, 0.6]) }],   // 次高
    ["c3", { revision: 1, vec: Float32Array.from([1, 0.7]) }],   // 第三
    ["c4", { revision: 1, vec: Float32Array.from([0.1, 1]) }],   // 低于阈值
    ["c5", { revision: 1, vec: Float32Array.from([1, 0.7]) }],   // 与 c3 同分（平局 → id 升序 c3 在前）
  ]);
  const linker = createAutoLinker({
    scopeId: SCOPE,
    provider: { embed: async () => Float32Array.from([1, 0]) },
    openVectorStore: async () => fakeVectorStore(entries),
    listActive: async () => cards,
    embedText: EMBED_TEXT,
  });
  const result = await linker({ title: "新卡", content: "正文" });
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 3, "每卡上限 3（c1/c2/c3+c5 中取 3）");
  for (const edge of result) {
    assert.equal(edge.rel, AUTO_LINK_REL);
    assert.ok(typeof edge.score === "number" && edge.score >= AUTO_LINK_THRESHOLD && edge.score <= 1);
    assert.ok(!Object.hasOwn(edge, "note"), "边结构只带 target/rel/score");
  }
  // score 单调不升（排序确定性；c3 与 c5 同分时 id 升序决定谁进前 3）
  for (let i = 1; i < result.length; i += 1) {
    assert.ok(result[i - 1].score >= result[i].score);
  }
  const ids = result.map((e) => e.target);
  assert.ok(!ids.includes("c4"), "低于阈值的卡不参与候选");
  assert.ok(ids.includes("c3"), "平局按 id 升序：c3 在 c5 前");
});

test("新鲜度判据：索引 revision 与卡片不一致的卡不参与候选（不隐式重建索引）", async () => {
  const cards = [card("fresh"), card("stale", { revision: 3 })];
  const entries = new Map([
    ["fresh", { revision: 1, vec: Float32Array.from([1]) }],
    ["stale", { revision: 2, vec: Float32Array.from([1]) }], // 落后于卡的 revision 3
  ]);
  const linker = createAutoLinker({
    scopeId: SCOPE,
    provider: { embed: async () => Float32Array.from([1]) },
    openVectorStore: async () => fakeVectorStore(entries),
    listActive: async () => cards,
    embedText: EMBED_TEXT,
  });
  const result = await linker({ title: "新卡", content: "正文" });
  assert.deepEqual(result.map((e) => e.target), ["fresh"], "过期向量不补写不重建");
});

test("excludeId / 资格筛选：不与自己连边；异 scope / 非 active / 重定向卡不参与", async () => {
  const cards = [
    card("self", { revision: 1 }),
    card("archived", { state: "archived" }),
    card("other-scope", { scopeId: "elsewhere" }),
    card("merged", { title: "m" }),
    card("ok", { revision: 1 }),
  ];
  cards[3].mergedInto = { key: "k" };
  const entries = new Map([
    ["self", { revision: 1, vec: Float32Array.from([1]) }],
    ["archived", { revision: 1, vec: Float32Array.from([1]) }],
    ["other-scope", { revision: 1, vec: Float32Array.from([1]) }],
    ["merged", { revision: 1, vec: Float32Array.from([1]) }],
    ["ok", { revision: 1, vec: Float32Array.from([1]) }],
  ]);
  const linker = createAutoLinker({
    scopeId: SCOPE,
    provider: { embed: async () => Float32Array.from([1]) },
    openVectorStore: async () => fakeVectorStore(entries),
    listActive: async () => cards,
    embedText: EMBED_TEXT,
  });
  const result = await linker({ title: "新卡", content: "正文", excludeId: "self" });
  assert.deepEqual(result.map((e) => e.target), ["ok"]);
});

test("降级零报错：provider null / embed 抛错 / 索引 null / listActive 抛错 / 文本为空 → 全部返回 null", async () => {
  const base = { scopeId: SCOPE, embedText: EMBED_TEXT };
  const off = createAutoLinker({ ...base, provider: null, openVectorStore: async () => null, listActive: async () => [] });
  assert.equal(await off({ title: "t", content: "c" }), null);

  const embedBoom = createAutoLinker({
    ...base,
    provider: { embed: async () => { throw new Error("model missing"); } },
    openVectorStore: async () => { throw new Error("should not be reached"); },
    listActive: async () => [],
  });
  assert.equal(await embedBoom({ title: "t", content: "c" }), null, "embed 失败：跳过且不触碰索引");

  const noIndex = createAutoLinker({
    ...base,
    provider: { embed: async () => Float32Array.from([1]) },
    openVectorStore: async () => null,
    listActive: async () => { throw new Error("should not be reached"); },
  });
  assert.equal(await noIndex({ title: "t", content: "c" }), null, "索引不可用：跳过");

  const listBoom = createAutoLinker({
    ...base,
    provider: { embed: async () => Float32Array.from([1]) },
    openVectorStore: async () => fakeVectorStore(new Map()),
    listActive: async () => { throw new Error("io down"); },
  });
  assert.equal(await listBoom({ title: "t", content: "c" }), null, "listActive 失败：收敛为 null 不外溢");

  const emptyText = createAutoLinker({
    ...base,
    provider: { embed: async () => { throw new Error("should not embed empty text"); } },
    openVectorStore: async () => null,
    listActive: async () => [],
  });
  assert.equal(await emptyText({ title: "", content: "" }), null, "空文本不浪费嵌入调用");
});

test("canEmbed=false（模型未装）→ 跳过且不触碰 provider.embed（写路径绝不触发下载）", async () => {
  let embedCalls = 0;
  const linker = createAutoLinker({
    scopeId: SCOPE,
    provider: { embed: async () => { embedCalls += 1; return Float32Array.from([1]); } },
    openVectorStore: async () => { throw new Error("should not be reached"); },
    listActive: async () => [],
    embedText: EMBED_TEXT,
    canEmbed: () => false,
  });
  assert.equal(await linker({ title: "t", content: "c" }), null);
  assert.equal(embedCalls, 0, "canEmbed 闸在 provider.embed 之前");
});

test("维度错配 / 坏向量：单条跳过不炸整批", async () => {
  const cards = [card("good"), card("wrong-dims"), card("nan")];
  const entries = new Map([
    ["good", { revision: 1, vec: Float32Array.from([1]) }],
    ["wrong-dims", { revision: 1, vec: Float32Array.from([1, 2, 3]) }],
    ["nan", { revision: 1, vec: [Number.NaN] }],
  ]);
  const linker = createAutoLinker({
    scopeId: SCOPE,
    provider: { embed: async () => Float32Array.from([1]) },
    openVectorStore: async () => fakeVectorStore(entries),
    listActive: async () => cards,
    embedText: EMBED_TEXT,
  });
  const result = await linker({ title: "t", content: "c" });
  assert.deepEqual(result.map((e) => e.target), ["good"]);
});
