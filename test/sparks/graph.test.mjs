// Slot I · src/sparks/graph.mjs 安全图谱投影测试（node:test，合成数据）。
// 不依赖 G 的真实 store：全部用内存构造的 public record。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  projectGraph,
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

test("node payload is metadata only: id/title/summary/vitality/revision/degree", () => {
  const p = projectGraph({ scopeId: SCOPE, records: [mk("a", { revision: 9 })] });
  assert.deepEqual(Object.keys(p.nodes[0]).sort(),
    ["degree", "id", "revision", "summary", "title", "vitality"]);
  assert.equal(p.nodes[0].revision, 9);
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
