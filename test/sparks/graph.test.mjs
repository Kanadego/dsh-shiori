// Slot I · src/sparks/graph.mjs 安全图谱投影测试（node:test，合成数据）。
// 不依赖 G 的真实 store：全部用内存构造的 public record。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectGraph,
  clusterProjection,
  graphSummary,
  normalizeGraphRecords,
} from "../../src/sparks/graph.mjs";

const SCOPE = "scope-main";

/** 构造一条 public record（CONTRACTS.md §G 字段集），默认当前 scope、active。 */
function mk(id, overrides = {}) {
  return {
    id,
    scopeId: SCOPE,
    revision: 1,
    title: `title-${id}`,
    summary: `summary-${id}`,
    triggers: [`t-${id}`],
    entities: [],
    links: [],
    content: `SECRET-BODY-${id}`,
    vitality: "evergreen",
    state: "active",
    ...overrides,
  };
}

function codedOf(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("expected INVALID_INPUT to be thrown");
}

// ── 入参校验 ─────────────────────────────────────────────────────────────

test("projectGraph rejects bad scopeId / non-array records with INVALID_INPUT", () => {
  for (const bad of [undefined, "", 42, null]) {
    const error = codedOf(() => projectGraph({ scopeId: bad, records: [] }));
    assert.equal(error.code, "INVALID_INPUT");
  }
  const error = codedOf(() => projectGraph({ scopeId: SCOPE, records: "nope" }));
  assert.equal(error.code, "INVALID_INPUT");
});

// ── 节点过滤（必测反例：异 scope / archived / superseded / merged）──────────

test("only current-scope active non-redirected nodes are projected", () => {
  const records = [
    mk("keep-a"),
    mk("keep-b", { vitality: "ephemeral" }),
    mk("foreign", { scopeId: "scope-other" }),
    mk("archived", { state: "archived" }),
    mk("superseded-state", { state: "superseded" }),
    mk("merged-state", { state: "merged" }),
    mk("merged-marker", { mergedInto: "keep-a" }),
    mk("superseded-marker", { supersededBy: "keep-b" }),
    mk("replaced-marker", { replacedBy: "keep-a" }),
    "not-a-record",
    { no: "id" },
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.deepEqual(p.nodes.map((n) => n.id), ["keep-a", "keep-b"]);
  assert.equal(p.stats.nodes, 2);
  assert.equal(p.stats.dropped.records.scope, 1);
  // archived/superseded/merged 三个 state 值都计入 state 桶
  assert.equal(p.stats.dropped.records.state, 3);
  assert.equal(p.stats.dropped.records.redirected, 3);
  assert.equal(p.stats.dropped.records.malformed, 2);
});

test("supersedes (this card replaces an old one) does NOT exclude the new card", () => {
  const records = [
    mk("new", { supersedes: "old" }),
    mk("old", { state: "archived" }),
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.deepEqual(p.nodes.map((n) => n.id), ["new"]);
});

test("duplicate ids collapse to the higher revision deterministically", () => {
  const records = [
    mk("dup", { revision: 3, title: "stale" }),
    mk("dup", { revision: 7, title: "fresh" }),
    mk("dup", { revision: 5, title: "middle" }),
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.equal(p.nodes.length, 1);
  assert.equal(p.nodes[0].title, "fresh");
  assert.equal(p.stats.dropped.records.duplicateId, 2);
});

// ── 边校验（悬空 / 自环 / 跨 scope / 重复 / 互逆折叠）──────────────────────

test("dangling, self and cross-scope link targets are dropped and counted", () => {
  const records = [
    mk("a", { links: [{ target: "b" }, { target: "ghost" }, { target: "a" }, { target: "foreign-id" }] }),
    mk("b"),
    mk("foreign-id", { scopeId: "scope-other" }),
    mk("ghost", { state: "archived" }), // 端点被过滤后成为悬空
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.deepEqual(p.edges, [{ source: "a", target: "b", rel: null, reciprocal: false }]);
  assert.equal(p.stats.dropped.edges.dangling, 2); // ghost + foreign-id
  assert.equal(p.stats.dropped.edges.self, 1);
});

test("malformed links are counted, not thrown", () => {
  const records = [
    mk("a", { links: ["b", 42, null, { nope: true }, { target: "" }] }),
    mk("b"),
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.equal(p.edges.length, 0);
  assert.equal(p.stats.dropped.edges.malformed, 5);
});

test("duplicate directed edges dedupe with the lexicographically smallest rel", () => {
  const records = [
    mk("a", { links: [{ target: "b", rel: "zeta" }, { target: "b", rel: "alpha" }, { target: "b" }] }),
    mk("b"),
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.deepEqual(p.edges, [{ source: "a", target: "b", rel: "alpha", reciprocal: false }]);
  assert.equal(p.stats.dropped.edges.duplicate, 2);
});

test("reciprocal A→B and B→A collapse into one edge flagged reciprocal", () => {
  const records = [
    mk("a", { links: [{ target: "b", rel: "衍生梗" }] }),
    mk("b", { links: [{ target: "a", rel: "related" }] }),
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.deepEqual(p.edges, [{ source: "a", target: "b", rel: "related", reciprocal: true }]);
  assert.equal(p.stats.dropped.edges.reciprocal, 1);
  // 度数仍按一条边计（无向渲染）
  const a = p.nodes.find((n) => n.id === "a");
  const b = p.nodes.find((n) => n.id === "b");
  assert.equal(a.degree, 1);
  assert.equal(b.degree, 1);
});

test("edges and nodes are stably sorted regardless of input order", () => {
  const chain = [];
  for (let i = 0; i < 20; i++) {
    chain.push(mk(`n${String(i).padStart(2, "0")}`, {
      vitality: i % 2 ? "ephemeral" : "evergreen",
      links: i === 0 ? [] : [{ target: `n${String(i - 1).padStart(2, "0")}`, rel: `r${i % 3}` }],
    }));
  }
  const ordered = projectGraph({ scopeId: SCOPE, records: chain });
  // 固定种子洗牌（确定性重排），输出必须逐字节一致
  const shuffled = [...chain];
  let seed = 12345;
  for (let i = shuffled.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const p = projectGraph({ scopeId: SCOPE, records: shuffled });
  assert.deepEqual(p, ordered);
});

// ── 输出形状与安全边界 ───────────────────────────────────────────────────

test("projection never carries content or trigger text", () => {
  const records = [
    mk("a", { content: "SECRET-CONTENT-A", triggers: ["SECRET-TRIGGER"] }),
    mk("b", { links: [{ target: "a" }] }),
  ];
  const text = JSON.stringify(projectGraph({ scopeId: SCOPE, records }));
  assert.ok(!text.includes("SECRET-CONTENT-A"));
  assert.ok(!text.includes("SECRET-TRIGGER"));
  assert.ok(!text.includes("SECRET-BODY"));
});

test("vitality labels: evergreen/ephemeral counted, unknown labeled not guessed", () => {
  const records = [
    mk("g", { vitality: "evergreen" }),
    mk("e", { vitality: "ephemeral" }),
    mk("u", { vitality: "weird" }),
    mk("n", { vitality: undefined }),
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.deepEqual(p.stats.vitality, { evergreen: 1, ephemeral: 1, unknown: 2 });
  assert.equal(p.nodes.find((x) => x.id === "u").vitality, "unknown");
});

test("node payload is metadata only: id/title/summary/vitality/revision/degree/entities", () => {
  const p = projectGraph({ scopeId: SCOPE, records: [mk("a", { revision: 9 })] });
  assert.deepEqual(Object.keys(p.nodes[0]).sort(),
    ["degree", "entities", "id", "revision", "summary", "title", "vitality"]);
  assert.equal(p.nodes[0].revision, 9);
});

// ── entities 投影（客户端实体聚类着色用）──────────────────────────────────

test("entities are normalized: kept in first-seen order after trim and dedupe", () => {
  const p = projectGraph({ scopeId: SCOPE, records: [
    mk("a", { entities: [" alpha", "beta", "alpha", "gamma"] }),
  ]});
  assert.deepEqual(p.nodes[0].entities, ["alpha", "beta", "gamma"]);
});

test("entities are capped at 4 entries after dedupe", () => {
  const p = projectGraph({ scopeId: SCOPE, records: [
    mk("a", { entities: ["e1", "e2", "e3", "e4", "e5", "e6"] }),
  ]});
  assert.deepEqual(p.nodes[0].entities, ["e1", "e2", "e3", "e4"]);
});

test("entities filter blank and illegal elements, degrade to [] on missing/non-array", () => {
  const records = [
    mk("blank", { entities: ["  ", "", "\t"] }),
    mk("illegal", { entities: [42, null, {}, true, [], "ok"] }),
    mk("missing", { entities: undefined }),
    mk("non-array", { entities: "nope" }),
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.deepEqual(p.nodes.find((n) => n.id === "blank").entities, []);
  assert.deepEqual(p.nodes.find((n) => n.id === "illegal").entities, ["ok"]);
  assert.deepEqual(p.nodes.find((n) => n.id === "missing").entities, []);
  assert.deepEqual(p.nodes.find((n) => n.id === "non-array").entities, []);
});

test("entities do not affect degree, edge count, stats or summary shape", () => {
  const records = [
    mk("a", { entities: ["x", "y", "z", "w", "v"], links: [{ target: "b" }] }),
    mk("b", { entities: ["x"] }),
  ];
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.equal(p.stats.nodes, 2);
  assert.equal(p.stats.edges, 1);
  assert.equal(p.nodes.find((n) => n.id === "a").degree, 1);
  assert.equal(p.nodes.find((n) => n.id === "b").degree, 1);
  // entities 是身份信息，不得泄漏进 stats / summary 输出
  const statsText = JSON.stringify(p.stats);
  for (const entity of ["x", "y", "z", "w", "v"]) assert.ok(!statsText.includes(`"${entity}"`));
  assert.ok(!JSON.stringify(graphSummary(p)).includes("entities"));
});

test("empty graph yields empty deterministic projection", () => {
  const p = projectGraph({ scopeId: SCOPE, records: [] });
  assert.deepEqual(p.nodes, []);
  assert.deepEqual(p.edges, []);
  assert.equal(p.stats.nodes, 0);
  assert.equal(p.stats.edges, 0);
  assert.deepEqual(p.stats.vitality, { evergreen: 0, ephemeral: 0, unknown: 0 });
});

test("large graph: 500-node chain counts, degrees and summary stay correct", () => {
  const records = [];
  for (let i = 0; i < 500; i++) {
    records.push(mk(`node-${String(i).padStart(3, "0")}`, {
      vitality: i % 2 ? "ephemeral" : "evergreen",
      links: i === 499 ? [] : [{ target: `node-${String(i + 1).padStart(3, "0")}` }],
    }));
  }
  const p = projectGraph({ scopeId: SCOPE, records });
  assert.equal(p.stats.nodes, 500);
  assert.equal(p.stats.edges, 499);
  assert.deepEqual(p.stats.vitality, { evergreen: 250, ephemeral: 250, unknown: 0 });
  assert.equal(p.nodes[0].degree, 1); // node-000 端点
  assert.equal(p.nodes[1].degree, 2); // 中间链
});

// ── normalizeGraphRecords ────────────────────────────────────────────────

test("normalizeGraphRecords accepts array and nodes/records/sparks wrappers", () => {
  const a = [mk("a")];
  assert.equal(normalizeGraphRecords(a), a);
  assert.deepEqual(normalizeGraphRecords({ nodes: a }), a);
  assert.deepEqual(normalizeGraphRecords({ records: a }), a);
  assert.deepEqual(normalizeGraphRecords({ sparks: a, edges: [{ source: "x" }] }), a);
  assert.deepEqual(normalizeGraphRecords(undefined), []);
  assert.deepEqual(normalizeGraphRecords(null), []);
});

test("normalizeGraphRecords rejects unsupported shapes with INVALID_INPUT", () => {
  for (const bad of ["array", 42, true, {}, { nodes: "nope" }, { edges: [] }]) {
    const error = codedOf(() => normalizeGraphRecords(bad));
    assert.equal(error.code, "INVALID_INPUT");
  }
});

// ── graphSummary（模型侧回执）────────────────────────────────────────────

test("graphSummary returns handle + scale only, no node identities", () => {
  const p = projectGraph({ scopeId: SCOPE, records: [mk("a"), mk("b", { links: [{ target: "a" }] }), mk("x", { scopeId: "other" })] });
  const s = graphSummary(p);
  assert.equal(s.handle, `spark-graph:${SCOPE}`);
  assert.equal(s.scopeId, SCOPE);
  assert.equal(s.nodes, 2);
  assert.equal(s.edges, 1);
  assert.deepEqual(s.vitality, { evergreen: 2, ephemeral: 0, unknown: 0 });
  assert.equal(s.droppedRecords, 1);
  assert.ok(s.hint.includes("spark_read"));
  const text = JSON.stringify(s);
  assert.ok(!text.includes("title-a"));
  assert.ok(!text.includes("SECRET-BODY"));
});

test("graphSummary default hint mentions spark_read; custom hint allowed", () => {
  const p = projectGraph({ scopeId: SCOPE, records: [] });
  assert.ok(graphSummary(p).hint.includes("spark_read"));
  assert.equal(graphSummary(p, { hint: "custom" }).hint, "custom");
});

test("graphSummary rejects non-projection input", () => {
  for (const bad of [undefined, {}, { nodes: [], edges: null }]) {
    const error = codedOf(() => graphSummary(bad));
    assert.equal(error.code, "INVALID_INPUT");
  }
});

// ── clusterProjection（0.4-S7 两级聚类投影）──────────────────────────────

test("clusterProjection level=1：主实体分簇、无实体归未分类、count 降序同数 key 字典序", () => {
  const records = [
    mk("a", { entities: ["项目甲"] }),
    mk("b", { entities: [" 项目甲 "] }),   // trim 后同簇
    mk("c", { entities: ["项目甲", "项目乙"] }), // 只看 entities[0]
    mk("d", { entities: ["项目乙"] }),
    mk("e"),                                   // 无实体 → __unclustered__
    mk("f", { entities: ["", "  ", 42, null] }), // 实体全是脏值 → __unclustered__
    mk("g", { entities: ["beta"] }),
    mk("h", { entities: ["alpha"] }),
  ];
  const p1 = clusterProjection({ scopeId: SCOPE, records });
  assert.equal(p1.schemaVersion, 1);
  assert.equal(p1.level, 1);
  assert.equal(p1.scopeId, SCOPE);
  assert.equal(p1.total, 8);
  // 排序：count 降序（甲 3 > 未分类 2 > 其余 1），同 count 按 key 字典序
  //（"alpha" < "beta"；汉字 key 的 code-unit 在 ASCII 之后，所以「项目乙」垫底）。
  assert.deepEqual(p1.clusters.map((c) => [c.key, c.count]), [
    ["项目甲", 3], ["__unclustered__", 2], ["alpha", 1], ["beta", 1], ["项目乙", 1],
  ]);
});

test("clusterProjection level=1：同 count 的簇按 key 字典序（ASCII 序，与输入顺序无关）", () => {
  const records = [
    mk("g1", { entities: ["gamma"] }),
    mk("a1", { entities: ["alpha"] }),
    mk("b1", { entities: ["beta"] }),
    mk("a2", { entities: ["alpha"] }),
    mk("b2", { entities: ["beta"] }),
    mk("g2", { entities: ["gamma"] }),
    // 规格连带：5C 实体归一（q-a80aab1b62b3b68f）——cluster key 输出 canonical 形
    // （大小写折叠后的实体），"Zeta" 归一为 "zeta"；排序仍按 UTF-16 code-unit
    // （a<b<g<z，zeta 只 1 张垫底），乱序输入输出不变的原断言口径保持。
    mk("z", { entities: ["Zeta"] }),
  ];
  const p = clusterProjection({ scopeId: SCOPE, records });
  // count 降序：alpha/beta/gamma 各 2 在前，zeta 只 1 张垫底；count=2 组内按 key 字典序。
  assert.deepEqual(p.clusters.map((c) => c.key), ["alpha", "beta", "gamma", "zeta"]);
  assert.equal(p.total, 7);
  // 输入乱序输出不变（纯函数可复现）
  const shuffled = [records[4], records[0], records[6], records[2], records[1], records[5], records[3]];
  assert.deepEqual(clusterProjection({ scopeId: SCOPE, records: shuffled }).clusters,
    p.clusters);
});

// 规格连带：5C 实体归一（q-a80aab1b62b3b68f 边界 3 的正向用例）——同一实体的
// 大小写/全半角变体必须落到同一簇、同一个 canonical cluster key 上。
test("clusterProjection level=1：同一实体的大小写与全半角变体归到同一簇（归一生效）", () => {
  const records = [
    mk("u1", { entities: ["GPU"] }),
    mk("u2", { entities: ["gpu"] }),
    mk("u3", { entities: ["ＧＰＵ"] }), // 全角字母 → NFKC 折叠为半角 gpu
    mk("u4", { entities: [" Gpu "]}),  // 前后空白 + 混合大小写
  ];
  const p = clusterProjection({ scopeId: SCOPE, records });
  assert.equal(p.total, 4);
  assert.deepEqual(p.clusters, [{
    key: "gpu", label: "gpu", count: 4,
    samples: ["title-u1", "title-u2", "title-u3"],
  }]);
  // 节点 entities 同步输出 canonical 形（客户端着色与分簇同源）
  const proj = projectGraph({ scopeId: SCOPE, records });
  for (const node of proj.nodes) {
    assert.deepEqual(node.entities, ["gpu"]);
  }
});

test("clusterProjection level=1：samples 最多 3 个标题，非字符串/空串标题不进 samples", () => {
  const records = [
    mk("n1", { entities: ["簇"] }), mk("n2", { entities: ["簇"] }), mk("n3", { entities: ["簇"] }),
    mk("n4", { entities: ["簇"] }), mk("n5", { entities: ["簇"], title: "标题五" }),
    mk("noTitle", { entities: ["簇"], title: null }),
    mk("emptyTitle", { entities: ["簇"], title: "" }),
  ];
  const p = clusterProjection({ scopeId: SCOPE, records });
  const bucket = p.clusters[0];
  assert.equal(bucket.count, 7);
  assert.deepEqual(bucket.samples, ["title-n1", "title-n2", "title-n3"]);
});

test("clusterProjection level=1：空输入返回空簇集，total=0", () => {
  const p = clusterProjection({ scopeId: SCOPE, records: [] });
  assert.equal(p.level, 1);
  assert.deepEqual(p.clusters, []);
  assert.equal(p.total, 0);
  // 全部被过滤（异 scope / archived）也一样
  const filtered = clusterProjection({ scopeId: SCOPE, records: [mk("x", { scopeId: "other" }), mk("y", { state: "archived" })] });
  assert.deepEqual(filtered.clusters, []);
  assert.equal(filtered.total, 0);
});

// 规格连带：5C level=2 跨簇边保留（q-2cf6750e005b6b66）——旧用例名与断言钉死
// 「边只保留两端都在簇内」的旧行为，任务书模块 6 要求跨簇边照常出线（服务端不
// 丢弃，渲染归客户端）。字段形状与簇内边完全一致（source/target/rel/reciprocal），
// rel 缺失统一 null；degree 按「视图里看得见的边都算度」口径重算（簇内 + 跨簇），
// projectGraph 的度数语义不动。
test("clusterProjection level=2：节点形状与 projectGraph 一致，跨簇边照常出线，degree 按视图边集重算", () => {
  const records = [
    mk("a", { entities: ["甲"], links: [{ target: "b" }, { target: "c" }] }),
    mk("b", { entities: ["甲"], links: [{ target: "a", rel: "related" }, { target: "c" }] }),
    mk("c", { entities: ["乙"], links: [{ target: "b" }] }),
    mk("ghost", { state: "archived", entities: ["甲"] }), // 被过滤，不进簇
  ];
  const full = projectGraph({ scopeId: SCOPE, records });
  const p = clusterProjection({ scopeId: SCOPE, records, cluster: "甲" });
  assert.equal(p.level, 2);
  assert.deepEqual(p.cluster, { key: "甲", label: "甲", count: 2 });
  // 节点形状与 projectGraph 逐字段一致（复用投影逻辑，不复制一份字段）
  for (const node of p.nodes) {
    const twin = full.nodes.find((n) => n.id === node.id);
    assert.ok(twin);
    assert.deepEqual(Object.keys(node).sort(), Object.keys(twin).sort());
  }
  assert.deepEqual(p.nodes.map((n) => n.id), ["a", "b"]);
  // 跨簇边（a-c、b-c）照常出线（指向簇外不丢弃）；a-b 互逆折叠保留；
  // 字段形状与簇内边一致，rel 缺失统一 null。
  assert.deepEqual(p.edges, [
    { source: "a", target: "b", rel: "related", reciprocal: true },
    { source: "a", target: "c", rel: null, reciprocal: false },
    { source: "b", target: "c", rel: null, reciprocal: true },
  ]);
  // degree 按本视图出线边集重算：a 触及 a-b 与 a-c 共 2 条，b 触及 a-b 与 b-c 共 2 条
  // （视图里看得见的边都算度；全图度数语义不变，见下方「全图投影不受影响」）。
  assert.equal(p.nodes.find((n) => n.id === "a").degree, 2);
  assert.equal(p.nodes.find((n) => n.id === "b").degree, 2);
  // 全图投影不受影响（projectGraph 原样不动）：a 的全图边是 a-b 与 a-c 共 2 条
  assert.equal(full.nodes.find((n) => n.id === "a").degree, 2);
});

// 规格连带：5C level=2 跨簇边保留（q-2cf6750e005b6b66 边界 4 的正向用例）——
// 两端都在本簇外的边与本簇无关，本簇视图不出线。
test("clusterProjection level=2：两端都在簇外的边不出线", () => {
  const records = [
    mk("in1", { entities: ["甲"], links: [] }),
    mk("out1", { entities: ["乙"], links: [{ target: "out2", rel: "related" }] }),
    mk("out2", { entities: ["丙"], links: [{ target: "out1", rel: "related" }] }),
  ];
  const p = clusterProjection({ scopeId: SCOPE, records, cluster: "甲" });
  assert.deepEqual(p.nodes.map((n) => n.id), ["in1"]);
  assert.deepEqual(p.edges, []); // out1-out2 两端都不在「甲」簇：不出线
  assert.equal(p.nodes[0].degree, 0);
});

test("clusterProjection level=2：未知 cluster 不抛错，空 nodes/edges + count 0", () => {
  const p = clusterProjection({ scopeId: SCOPE, records: [mk("a", { entities: ["甲"] })], cluster: "不存在" });
  assert.equal(p.level, 2);
  assert.deepEqual(p.cluster, { key: "不存在", label: "不存在", count: 0 });
  assert.deepEqual(p.nodes, []);
  assert.deepEqual(p.edges, []);
});

test("clusterProjection level=2：__unclustered__ 也是可进入的簇，label 固定「未分类」", () => {
  const records = [
    mk("a"), mk("b", { entities: [] }),
    mk("c", { entities: ["甲"] }),
    mk("d", { entities: ["甲"] }),
    mk("e", { entities: ["甲"] }),
  ];
  const p = clusterProjection({ scopeId: SCOPE, records, cluster: "__unclustered__" });
  assert.deepEqual(p.cluster, { key: "__unclustered__", label: "未分类", count: 2 });
  assert.deepEqual(p.nodes.map((n) => n.id), ["a", "b"]);
});

test("clusterProjection level=1：samples 来自同簇卡（按 id 序），单卡簇 count=1 也在列", () => {
  const records = [mk("solo", { entities: ["独苗簇"] })];
  const p = clusterProjection({ scopeId: SCOPE, records });
  assert.deepEqual(p.clusters, [{ key: "独苗簇", label: "独苗簇", count: 1, samples: ["title-solo"] }]);
  assert.equal(p.total, 1);
});

test("clusterProjection rejects bad scopeId / non-array records / non-string cluster", () => {
  for (const bad of [undefined, "", 42, null]) {
    const error = codedOf(() => clusterProjection({ scopeId: bad, records: [] }));
    assert.equal(error.code, "INVALID_INPUT");
  }
  assert.equal(codedOf(() => clusterProjection({ scopeId: SCOPE, records: "nope" })).code, "INVALID_INPUT");
  assert.equal(codedOf(() => clusterProjection({ scopeId: SCOPE, records: [], cluster: 42 })).code, "INVALID_INPUT");
  assert.equal(codedOf(() => clusterProjection({ scopeId: SCOPE, records: [], cluster: {} })).code, "INVALID_INPUT");
});
