// F4 · 最近变更时间线数据层测试：双源合并、去重、倒序、分页边界、scope 过滤；
// 另覆盖损坏记录跳过与非内容写 kind 排除。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTimelineReader } from "../../src/timeline/index.mjs";
import { createManagement } from "../../src/plugin/management.mjs";
import { MANAGEMENT_METHODS } from "../../src/plugin/protocol.mjs";
import { createStateStore } from "../../src/plugin/state.mjs";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function iso(minuteOffset) {
  return new Date(T0 + minuteOffset * 60 * 1000).toISOString();
}

async function setup(t) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-timeline-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

function committedJournal({ operationId, scopeId, at, changes }) {
  return {
    version: 1,
    operationId,
    scopeId,
    payloadHash: "a".repeat(64),
    phase: "committed",
    generationBefore: 1,
    generationAfter: 2,
    createdAt: at,
    updatedAt: at,
    changes: changes.map((change, index) => ({
      index,
      kind: change.kind,
      key: change.key,
      file: `staging-${index}`,
      stagingFile: `staging-${index}`,
      backupFile: `backup-${index}`,
      beforeRevision: null,
      afterRevision: "b".repeat(64),
    })),
  };
}

function sparkDb(scopeId, ops) {
  return {
    kind: "shiori-sparks-scope",
    schemaVersion: 1,
    scopeId,
    generation: Object.keys(ops).length,
    cards: {},
    ops,
    feedback: {},
  };
}

async function writeJournal(base, operationId, journal) {
  const dir = path.join(base, "journal");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${operationId}.json`), JSON.stringify(journal, null, 2), "utf8");
}

async function writeSparkDb(base, scopeId, ops) {
  const dir = path.join(base, "sparks", "scopes", scopeId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "sparks.json"), JSON.stringify(sparkDb(scopeId, ops), null, 2), "utf8");
}

// ── 双源合并 + 倒序 + 来源标注 ────────────────────────────────

test("timeline：journal 与 spark 双源合并、按时间倒序、来源标注正确", async (t) => {
  const base = await setup(t);
  const scope = "amber";
  await writeJournal(base, "op-topic-1", committedJournal({
    operationId: "op-topic-1", scopeId: scope, at: iso(10),
    changes: [{ kind: "topic", key: "梗·谐音梗" }],
  }));
  await writeJournal(base, "op-core-1", committedJournal({
    operationId: "op-core-1", scopeId: scope, at: iso(30),
    changes: [{ kind: "core", key: "core" }],
  }));
  await writeSparkDb(base, scope, {
    "op-save-1": {
      kind: "save", fingerprint: "f1", at: iso(20),
      result: { id: "spark-aaa1", title: "第一张卡", state: "active" },
    },
    "op-forget-1": {
      kind: "forget", fingerprint: "f2", at: iso(40),
      result: { id: "spark-aaa1", title: "第一张卡", state: "archived" },
    },
  });

  const reader = createTimelineReader({ dataRoot: base });
  const { items, hasMore, skippedCorrupted, scope: outScope } = await reader.read({ scope });
  assert.equal(outScope, scope);
  assert.equal(skippedCorrupted, 0);
  assert.equal(hasMore, false);
  assert.deepEqual(items.map((it) => [it.at, it.action, it.source]), [
    [iso(40), "spark.archive", "spark"],
    [iso(30), "core.write", "journal"],
    [iso(20), "spark.save", "spark"],
    [iso(10), "topic.write", "journal"],
  ]);
  assert.deepEqual(items[3].target, { type: "topic", id: "梗·谐音梗", title: null });
  assert.equal(items[3].detail.operationId, "op-topic-1");
  assert.deepEqual(items[2].target, { type: "spark", id: "spark-aaa1", title: "第一张卡" });
  assert.deepEqual(items[0].target, { type: "spark", id: "spark-aaa1", title: "第一张卡" });
});

// ── 去重：同 operationId 两边都有 → 保留 journal 版本并标注 ────

test("timeline：同 operationId 双源去重，保留 journal 版本并标注 dedupedWith", async (t) => {
  const base = await setup(t);
  const scope = "amber";
  await writeJournal(base, "op-both-1", committedJournal({
    operationId: "op-both-1", scopeId: scope, at: iso(10),
    changes: [{ kind: "core", key: "core" }],
  }));
  await writeSparkDb(base, scope, {
    "op-both-1": {
      kind: "update", fingerprint: "f1", at: iso(12),
      result: { id: "spark-bbb1", title: "改过的卡", state: "active" },
    },
    "op-spark-only": {
      kind: "save", fingerprint: "f2", at: iso(5),
      result: { id: "spark-bbb2", title: "只有 spark 有", state: "active" },
    },
  });

  const reader = createTimelineReader({ dataRoot: base });
  const { items } = await reader.read({ scope });
  assert.equal(items.length, 2);
  assert.equal(items[0].source, "journal");
  assert.equal(items[0].detail.operationId, "op-both-1");
  assert.deepEqual(items[0].detail.dedupedWith, ["spark"]);
  assert.equal(items[1].detail.operationId, "op-spark-only");
  assert.equal(Object.hasOwn(items[1].detail, "dedupedWith"), false);
});

// ── 分页边界 ────────────────────────────────────────────────

test("timeline：分页边界（limit/offset/hasMore/超界空页）", async (t) => {
  const base = await setup(t);
  const scope = "amber";
  for (let i = 0; i < 8; i += 1) {
    await writeJournal(base, `op-page-${i}`, committedJournal({
      operationId: `op-page-${i}`, scopeId: scope, at: iso(i + 1),
      changes: [{ kind: "topic", key: `topic-${i}` }],
    }));
  }
  const reader = createTimelineReader({ dataRoot: base });

  const page1 = await reader.read({ scope, offset: 0, limit: 3 });
  assert.equal(page1.items.length, 3);
  assert.equal(page1.hasMore, true);
  assert.deepEqual(page1.items.map((it) => it.target.id), ["topic-7", "topic-6", "topic-5"]);

  const page2 = await reader.read({ scope, offset: 3, limit: 3 });
  assert.deepEqual(page2.items.map((it) => it.target.id), ["topic-4", "topic-3", "topic-2"]);
  assert.equal(page2.hasMore, true);

  const page3 = await reader.read({ scope, offset: 6, limit: 3 });
  assert.deepEqual(page3.items.map((it) => it.target.id), ["topic-1", "topic-0"]);
  assert.equal(page3.hasMore, false);

  const page4 = await reader.read({ scope, offset: 9, limit: 3 });
  assert.deepEqual(page4.items, []);
  assert.equal(page4.hasMore, false);

  // 默认 limit = 100
  const defaultPage = await reader.read({ scope });
  assert.equal(defaultPage.items.length, 8);

  // 非法分页参数拒绝
  await assert.rejects(() => reader.read({ scope, offset: -1 }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => reader.read({ scope, limit: 0 }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => reader.read({ scope, limit: 501 }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => reader.read({ scope: "" }), (e) => e.code === "INVALID_INPUT");
});

test("timeline：先去重后分页——双源重复不占窗口名额（hasMore 不说谎）", async (t) => {
  const base = await setup(t);
  const scope = "amber";
  // 5 个操作两源各一份（journal 版优先），再补 2 个只在 spark 的操作。
  const ops = {};
  for (let i = 0; i < 5; i += 1) {
    await writeJournal(base, `op-dup-${i}`, committedJournal({
      operationId: `op-dup-${i}`, scopeId: scope, at: iso(i + 1),
      changes: [{ kind: "topic", key: `topic-${i}` }],
    }));
    ops[`op-dup-${i}`] = { kind: "save", fingerprint: "f", at: iso(i + 1), result: { id: `spark-${i}`, title: `卡 ${i}`, state: "active" } };
  }
  ops["op-spark-a"] = { kind: "save", fingerprint: "f", at: iso(50), result: { id: "spark-x", title: "x", state: "active" } };
  ops["op-spark-b"] = { kind: "save", fingerprint: "f", at: iso(51), result: { id: "spark-y", title: "y", state: "active" } };
  await writeSparkDb(base, scope, ops);

  const reader = createTimelineReader({ dataRoot: base });
  // 唯一 7 条；旧实现按 4 条截断再去重，整页只剩 1~2 条并提前 hasMore=false。
  const page1 = await reader.read({ scope, offset: 0, limit: 3 });
  assert.equal(page1.items.length, 3, "去重必须在截断之前，整页要满");
  assert.equal(page1.hasMore, true);
  assert.deepEqual(page1.items.map((it) => it.detail.operationId), ["op-spark-b", "op-spark-a", "op-dup-4"]);

  const page2 = await reader.read({ scope, offset: 3, limit: 3 });
  assert.equal(page2.items.length, 3);
  assert.equal(page2.hasMore, true);

  const page3 = await reader.read({ scope, offset: 6, limit: 3 });
  assert.equal(page3.items.length, 1);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.scanLimited, false);
});

test("timeline：扫描窗口被截断时 scanLimited 为真（深历史 ≠ 到底了）", async (t) => {
  const base = await setup(t);
  const scope = "amber";
  for (let i = 0; i < 4; i += 1) {
    await writeJournal(base, `op-deep-${i}`, committedJournal({
      operationId: `op-deep-${i}`, scopeId: scope, at: iso(i + 1),
      changes: [{ kind: "core", key: "core" }],
    }));
  }
  const limited = createTimelineReader({ dataRoot: base, scanLimit: 2 });
  const page = await limited.read({ scope, offset: 0, limit: 10 });
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, false, "窗口内确实到底");
  assert.equal(page.scanLimited, true, "但更早的历史没扫到，必须显式标注");

  const full = createTimelineReader({ dataRoot: base, scanLimit: 10 });
  const all = await full.read({ scope, offset: 0, limit: 10 });
  assert.equal(all.items.length, 4);
  assert.equal(all.scanLimited, false);

  assert.throws(() => createTimelineReader({ dataRoot: base, scanLimit: 0 }), (e) => e.code === "INVALID_INPUT");
});

// ── 装配层：scanLimited 必须到达 wire（数据层的诚实度标注不许被剥）──────

test("timeline：scanLimited 经 management 装配层到达 wire，且契约声明了该字段", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-timeline-wire-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const scopeId = "amber";
  for (let i = 0; i < 4; i += 1) {
    await writeJournal(dataRoot, `op-wire-${i}`, committedJournal({
      operationId: `op-wire-${i}`, scopeId, at: iso(i + 1),
      changes: [{ kind: "core", key: "core" }],
    }));
  }

  const settings = {
    mode: "active", allowActive: true, dataRoot, stateRoot,
    ownerId: "local", defaultPersona: scopeId,
    sessionPersonas: [], workspacePersonas: [],
    budgets: { persona: { maxChars: 12000 }, core: { targetChars: 2000, hardCapChars: 4000 } },
    l2: { enabled: false }, organize: { enabled: false }, forgetting: { enabled: false },
  };
  const state = createStateStore({ stateRoot });
  const { management } = createManagement({
    settings,
    dataRoot,
    state,
    resourcesFor: async () => ({}),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: () => ({ revoke() {} }),
    executeToolForScope: async () => { throw new Error("not used"); },
    // 注入 scanLimit=2 的读取器：不用造 4001 个 journal 也能走到「窗口截断」。
    timelineReader: createTimelineReader({ dataRoot, scanLimit: 2 }),
  });
  const trusted = { session: { id: "s-timeline-wire" }, source: "panel-rpc" };

  const wire = await management.getTimeline(trusted, {});
  assert.equal(wire.items.length, 2);
  assert.equal(wire.hasMore, false, "窗口内确实到底");
  assert.equal(wire.scanLimited, true, "窗口截断必须原样出现在 wire 上");

  // 契约与实现必须对得上：outputSchema 声明了 scanLimited，且 wire 的每个键都被声明。
  const spec = MANAGEMENT_METHODS.getTimeline.outputSchema;
  assert.equal(spec.properties.scanLimited.type, "boolean");
  assert.ok(spec.required.includes("scanLimited"));
  for (const key of Object.keys(wire)) {
    assert.ok(Object.hasOwn(spec.properties, key), `wire key "${key}" 未在 getTimeline outputSchema 声明`);
  }

  // 未截断时如实为 false（不是恒 true 的假标注）
  const { management: full } = createManagement({
    settings: { ...settings },
    dataRoot,
    state,
    resourcesFor: async () => ({}),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: () => ({ revoke() {} }),
    executeToolForScope: async () => { throw new Error("not used"); },
    timelineReader: createTimelineReader({ dataRoot, scanLimit: 10 }),
  });
  const fullWire = await full.getTimeline(trusted, {});
  assert.equal(fullWire.items.length, 4);
  assert.equal(fullWire.scanLimited, false);
});

// ── scope 过滤 ──────────────────────────────────────────────

test("timeline：scope 过滤只出本 scope（journal 与 spark 库双向隔离）", async (t) => {
  const base = await setup(t);
  await writeJournal(base, "op-a-1", committedJournal({
    operationId: "op-a-1", scopeId: "amber", at: iso(10),
    changes: [{ kind: "core", key: "core" }],
  }));
  await writeJournal(base, "op-b-1", committedJournal({
    operationId: "op-b-1", scopeId: "beni", at: iso(20),
    changes: [{ kind: "topic", key: "topic-b" }],
  }));
  await writeSparkDb(base, "amber", {
    "op-a-2": { kind: "save", fingerprint: "f", at: iso(30), result: { id: "spark-ccc1", title: "A 的卡", state: "active" } },
  });
  await writeSparkDb(base, "beni", {
    "op-b-2": { kind: "save", fingerprint: "f", at: iso(40), result: { id: "spark-ccc2", title: "B 的卡", state: "active" } },
  });

  const reader = createTimelineReader({ dataRoot: base });
  const amber = await reader.read({ scope: "amber" });
  assert.deepEqual(amber.items.map((it) => it.detail.operationId), ["op-a-2", "op-a-1"]);
  assert.ok(amber.items.every((it) => it.scope === "amber"));

  const beni = await reader.read({ scope: "beni" });
  assert.deepEqual(beni.items.map((it) => it.detail.operationId), ["op-b-2", "op-b-1"]);
});

// ── 损坏记录跳过 + 非内容写排除 + 空根目录 ────────────────────

test("timeline：损坏 journal 计入 skippedCorrupted 不炸视图；delivery-hit/organize-bind 不上时间线；空根返回空", async (t) => {
  const base = await setup(t);
  const scope = "amber";
  await writeJournal(base, "op-good-1", committedJournal({
    operationId: "op-good-1", scopeId: scope, at: iso(10),
    changes: [{ kind: "core", key: "core" }],
  }));
  const journalDir = path.join(base, "journal");
  await writeFile(path.join(journalDir, "op-broken.json"), "{not-json", "utf8");
  // 形状损坏（phase 非法）：同样跳过
  await writeFile(path.join(journalDir, "op-bad-phase.json"), JSON.stringify({
    operationId: "op-bad-phase", scopeId: scope, phase: "bogus", changes: [],
  }), "utf8");
  await writeSparkDb(base, scope, {
    "op-hit-1": { kind: "delivery-hit", fingerprint: "f", at: iso(20), result: { applied: 1, skipped: 0 } },
    "op-bind-1": { kind: "organize-bind", fingerprint: "f", at: iso(25), result: { bound: true, candidateId: "x" } },
    "op-links-1": {
      kind: "organize-links", fingerprint: "f", at: iso(30),
      result: { kind: "link", changedItems: 1, updated: [{ id: "spark-ddd1", beforeRevision: 1, afterRevision: 2 }] },
    },
  });

  const reader = createTimelineReader({ dataRoot: base });
  const { items, skippedCorrupted } = await reader.read({ scope });
  assert.equal(skippedCorrupted, 2);
  assert.deepEqual(items.map((it) => it.detail.operationId), ["op-links-1", "op-good-1"]);
  assert.equal(items[0].action, "spark.links");
  assert.deepEqual(items[0].detail.changedIds, ["spark-ddd1"]);

  // journal 目录不存在：空结果不报错
  const empty = await mkdtemp(path.join(tmpdir(), "shiori-timeline-empty-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const emptyReader = createTimelineReader({ dataRoot: empty });
  const emptyPage = await emptyReader.read({ scope });
  assert.deepEqual(emptyPage.items, []);
  assert.equal(emptyPage.hasMore, false);
  assert.equal(emptyPage.skippedCorrupted, 0);
});
