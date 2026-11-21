// 0.5-5C · getGraph deliveries 投影测试（独立文件：避免与 5A 的 management.test.mjs
// 冲突）。覆盖：
// - recordPending 落账的 sourceMessageId 随 deliveries[] 出线（§11.5 turnRef 投影）；
// - 旧账本记录无 sourceMessageId 字段 → 输出 null，不崩（完成判据）；
// - deliveries 形状与既有口径一致（cards 富化、截断、排序不受影响）；
// - 别名表（dataRoot/aliases.json）与人工分簇覆盖 sidecar
//   （dataRoot/spark-clusters.json）在 getGraph 上的生效（模块 1 读取侧接线）。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import { createManagement } from "../../src/plugin/management.mjs";

// scopeFromTrustedContext 在 defaultPersona=null 的直构 settings 下派生 "global"
// （同 management.test.mjs S7 夹具口径）。
const SCOPE = "global";
const TRUSTED = { session: { id: "s-panel" }, source: "panel-rpc" };

function card(id, overrides = {}) {
  return {
    id, scopeId: SCOPE, state: "active", title: `标题-${id}`, summary: null,
    vitality: "evergreen", revision: 1, triggers: [], entities: [], links: [],
    content: "c", hitCount: 0, lastHitAt: null, createdAt: null,
    ...overrides,
  };
}

/** 直构 management 门面（同 management.test.mjs S7 的口径：fixture 不触盘）。 */
function build({ cards = [], ledger = null, dataRoot = null } = {}) {
  return createManagement({
    settings: {
      mode: "active", ownerId: "local", defaultPersona: null, sessionPersonas: [], workspacePersonas: [],
      organize: { enabled: false }, forgetting: { enabled: false }, l2: { enabled: true, clustersVersion: 1 },
      dataRoot: dataRoot ?? path.join(tmpdir(), "shiori-5c-graph-nonexistent-data"),
      stateRoot: path.join(tmpdir(), "shiori-5c-graph-nonexistent-state"),
      budgets: {},
    },
    dataRoot: dataRoot ?? path.join(tmpdir(), "shiori-5c-graph-nonexistent-data"),
    state: { l2Store: { diagnostics: async () => ledger ?? { pending: {}, accepted: {}, committed: {}, hits: {} } } },
    resourcesFor: async () => ({ sparkStore: { listActive: async () => cards } }),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: () => ({}),
    executeToolForScope: async () => ({}),
  }).management;
}

function pendingEntry({ deliveryId, sourceMessageId, cards: deliveredCards, createdAt = "2026-11-22T00:00:00.000Z" }) {
  return {
    deliveryId,
    messageId: `msg-${deliveryId}`,
    ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
    session: "session-A",
    epoch: 0,
    createdAt,
    delivery: { delivered: deliveredCards.map((id) => ({ id })), hitMeta: {} },
  };
}

function ledgerOf(pendings) {
  const ledger = { pending: {}, accepted: {}, committed: {}, hits: {} };
  for (const entry of pendings) {
    ledger.pending[entry.deliveryId] = entry;
    // 只有进入会话的投递才出线（有 accepted receipt 或 committed 终态）
    ledger.accepted[entry.deliveryId] = { deliveryId: entry.deliveryId, messageId: entry.messageId, acceptedAt: entry.createdAt };
  }
  return ledger;
}

test("deliveries 投影 sourceMessageId：新记录带触发消息 id，cards 富化与排序不变", async () => {
  const ledger = ledgerOf([
    pendingEntry({ deliveryId: "d-new", sourceMessageId: "evt-user-42", cards: ["s1", "s2"], createdAt: "2026-11-22T10:00:00.000Z" }),
    pendingEntry({ deliveryId: "d-old", sourceMessageId: "evt-user-7", cards: ["s1"], createdAt: "2026-11-22T09:00:00.000Z" }),
  ]);
  const graph = await build({ cards: [card("s1"), card("s2")], ledger }).getGraph(TRUSTED, {});
  assert.equal(graph.deliveries.length, 2, "崩溃悬挂之外：两条已 accepted 的投递都出线");
  // 按 at 降序：d-new 在前
  assert.equal(graph.deliveries[0].deliveryId, "d-new");
  assert.equal(graph.deliveries[0].sourceMessageId, "evt-user-42", "sourceMessageId 恒出线（字段名固定）");
  assert.equal(graph.deliveries[1].deliveryId, "d-old");
  assert.equal(graph.deliveries[1].sourceMessageId, "evt-user-7");
  // cards 形状与既有口径一致（sparkId/trigger/source 富化不受影响）
  assert.deepEqual(graph.deliveries[0].cards, [
    { sparkId: "s1", trigger: null, source: null },
    { sparkId: "s2", trigger: null, source: null },
  ]);
});

test("旧账本记录无 sourceMessageId 字段 → 输出 null 不崩（完成判据）", async () => {
  const ledger = ledgerOf([
    pendingEntry({ deliveryId: "d-legacy", cards: ["s1"] }), // 旧记录：没有 sourceMessageId 键
  ]);
  const graph = await build({ cards: [card("s1")], ledger }).getGraph(TRUSTED, {});
  assert.equal(graph.deliveries.length, 1);
  assert.equal(graph.deliveries[0].deliveryId, "d-legacy");
  assert.equal(graph.deliveries[0].sourceMessageId, null, "缺字段降级 null，绝不为旧记录崩");
  // 非字符串脏值同样降级 null
  const dirty = ledgerOf([pendingEntry({ deliveryId: "d-dirty", sourceMessageId: 42, cards: ["s1"] })]);
  const graph2 = await build({ cards: [card("s1")], ledger: dirty }).getGraph(TRUSTED, {});
  assert.equal(graph2.deliveries[0].sourceMessageId, null);
});

test("level=1 / level=2 路径的 deliveries 同样带 sourceMessageId（三条路径口径一致）", async () => {
  const ledger = ledgerOf([
    pendingEntry({ deliveryId: "d-l1", sourceMessageId: "evt-l1", cards: ["s1"] }),
  ]);
  const cards = [card("s1", { entities: ["项目甲"] }), card("s2", { entities: [] })];
  const mgmt = build({ cards, ledger });
  const l1 = await mgmt.getGraph(TRUSTED, { level: 1 });
  assert.equal(l1.deliveries[0].sourceMessageId, "evt-l1");
  const l2 = await mgmt.getGraph(TRUSTED, { level: 2, cluster: "项目甲" });
  assert.equal(l2.deliveries[0].sourceMessageId, "evt-l1");
});

test("getGraph 接线别名表与分簇覆盖 sidecar：大小写归一归同簇、覆盖生效（模块 1 读取侧）", async (t) => {
  const base = await mkdir(path.join(tmpdir(), `shiori-5c-graph-${Math.random().toString(16).slice(2, 8)}`), { recursive: true });
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 3 }));
  // 手写别名表：GPU → graphics-card（canonical）
  await writeFile(path.join(base, "aliases.json"), JSON.stringify({
    version: 1,
    aliases: [{ alias: "GPU", canonical: "graphics-card", source: "manual" }],
  }), "utf8");
  // 人工分簇覆盖：把 s2 从派生簇改挂到「手工簇」
  await writeFile(path.join(base, "spark-clusters.json"), JSON.stringify({
    version: 1,
    scopes: { [SCOPE]: { s2: "手工簇" } },
  }), "utf8");

  const cards = [
    card("s1", { entities: ["gpu"] }),   // 归一后 canonical = graphics-card
    card("s2", { entities: ["视频卡"] }), // 派生簇「视频卡」→ 覆盖为「手工簇」
  ];
  const graph = await build({ cards, dataRoot: base }).getGraph(TRUSTED, { level: 1 });
  const keys = Object.fromEntries(graph.clusters.map((c) => [c.key, c.count]));
  assert.equal(keys["graphics-card"], 1, "gpu 经手写别名表归一到 canonical 簇");
  assert.equal(keys["手工簇"], 1, "spark-clusters.json 覆盖派生簇");
  assert.equal(keys["视频卡"], undefined, "被覆盖的派生簇不再出现");
});
