// 0.5 批次 5 · A 线：auto 冷却/恢复纯函数层测试（0.5-DEV-PLAN §5 / §11.2 / §4.4）。
//
// 覆盖面（任务书完成判据 ①）：25/50 回差、minCooldownDays / minRestoreGraceDays、
// historical / pinned / manual 护栏、每轮 ≤ maxOpsPerRun、时钟回拨熔断、心跳轮
// 不触发、连组恢复不连坐。纯模块纪律：同一输入两次调用深度相等（JSON 逐字节
// 相同）；本文件不触碰磁盘、不读时钟——全部显式注入。

import { test } from "node:test";
import assert from "node:assert/strict";
import { symlink as fsSymlink } from "node:fs/promises";

import {
  AUTO_ARCHIVE_ORIGIN,
  AUTO_FUSE_CODES,
  AUTO_MODES,
  AUTO_OP_KINDS,
  AUTO_RUN_KEEP,
  assertRunShape,
  autoIdentityKey,
  buildUndoOps,
  computeAutoFuse,
  createAutoEngine,
  createAutoReplaySource,
  deriveAutoCandidates,
  planAutoOps,
  shouldTriggerAutoEvaluation,
} from "../../src/forgetting/auto.mjs";
// 批次 10-2：operationId 重放口径（scopeId 过滤 / 滚动窗口注入）需要真账本。
import { createStateStore } from "../../src/plugin/state.mjs";
import { evaluateTopics } from "../../src/forgetting/topic-temperature.mjs";
import {
  DEFAULT_TEMPERATURE_PARAMS,
  normalizeTemperatureParams,
  toFormulaParams,
} from "../../src/forgetting/params.mjs";

const NOW = "2026-11-21T00:00:00.000Z";
const DAY = 86400000;
const iso = (daysAgo) => new Date(Date.parse(NOW) - daysAgo * DAY).toISOString();

/** 12 项参数（含可调测试钩子；全部经唯一源头 normalize + 交叉校验）。 */
function params(overrides = {}) {
  return normalizeTemperatureParams({ ...DEFAULT_TEMPERATURE_PARAMS, ...overrides });
}

/** 构造一个 topic 源行 + 回放（rows 与 evaluateTopics 输入同源，保证回放/护栏用同一份数据）。 */
function buildScene(topics, { groups = [], events = [], now = NOW, params: p = params() } = {}) {
  const replay = evaluateTopics({ topics, groups, events, now, params: toFormulaParams(p) });
  return { replay, p, now };
}

// 61 天前 updated、无事件的 historical topic：种子 T0 = 100·2^(-61/30) ≈ 24.5 < 25。
const OLD_UPDATED = 61;

function row(overrides = {}) {
  return {
    key: "t1",
    scopeId: "amber",
    updated: iso(OLD_UPDATED),
    retention: "historical",
    pinned: false,
    group: [],
    ...overrides,
  };
}

/** evaluateTopics 的 topics 输入形状（与引擎 evaluatePure 的装配一致）。 */
function replayInputOf(rows) {
  return rows.map((r) => ({
    key: r.key, scopeId: r.scopeId, updated: r.updated, archivedAt: r.archivedAt,
    pinned: r.pinned, retention: r.retention, archiveOrigin: r.archiveOrigin, group: r.group,
  }));
}

function derive(rows, { p = params(), fuse = null, restoreAnchors, now = NOW, groups = [], events } = {}) {
  // 未显式给 events 时注入一条远古 search_hit 种子（不加热、只当统计起点）——
  // 账本零事件 = 缺 statsStartedAt = 熔断（fail-closed），护栏用例需要健康账本。
  const ledger = events ?? [{ at: iso(90), scopeId: "amber", kind: "search_hit", topicKey: "__seed__" }];
  const replay = evaluateTopics({ topics: replayInputOf(rows), groups, events: ledger, now, params: toFormulaParams(p) });
  return deriveAutoCandidates({
    now,
    params: p,
    replayTopics: replay.topics,
    rows,
    fuse: fuse ?? computeAutoFuse({ events: ledger, now, minCooldownDays: p.minCooldownDays }),
    restoreAnchors,
  });
}

// ── 触发判定（§11.2.1）────────────────────────────────────────────────────

test("触发：mode=off 永不触发（off 只记账不计算），心跳轮（非人类轮）天然跳过", () => {
  const base = {
    isHumanTurn: true,
    lastEvaluatedAt: iso(30),
    now: NOW,
    evaluateEveryHours: 24,
  };
  // off：即使满 24h 也不触发。
  assert.deepEqual(shouldTriggerAutoEvaluation({ ...base, mode: "off" }),
    { triggered: false, reason: "mode-off", nextDueAt: null });
  // 心跳轮 / 引擎室轮：source.kind 不是 user → 不触发（满 24h 也等下一次人类轮）。
  assert.deepEqual(shouldTriggerAutoEvaluation({ ...base, mode: "auto", isHumanTurn: false }),
    { triggered: false, reason: "not-human-turn", nextDueAt: null });
  // suggest + 人类轮 + 满 24h → 触发。
  assert.equal(shouldTriggerAutoEvaluation({ ...base, mode: "suggest" }).triggered, true);
});

test("触发：距上次成功评估满 evaluateEveryHours 才触发；未满 not-due；水位顺带触发；首评 first-run", () => {
  const base = { mode: "auto", isHumanTurn: true, now: NOW, evaluateEveryHours: 24 };
  // 23.9h → 未满。
  assert.equal(shouldTriggerAutoEvaluation({ ...base, lastEvaluatedAt: iso(0.995) }).reason, "not-due");
  // 满 24h → elapsed。
  const elapsed = shouldTriggerAutoEvaluation({ ...base, lastEvaluatedAt: iso(1) });
  assert.equal(elapsed.triggered, true);
  assert.equal(elapsed.reason, "elapsed");
  assert.equal(elapsed.nextDueAt, new Date(Date.parse(iso(1)) + 24 * 3600000).toISOString());
  // 未满 24h 但软水位已武装 → 顺带触发（只触发分析）。
  const watermark = shouldTriggerAutoEvaluation({ ...base, lastEvaluatedAt: iso(0.2), softWatermark: true });
  assert.equal(watermark.triggered, true);
  assert.equal(watermark.reason, "soft-watermark");
  // 从未评估过 → 第一次人类轮即基线评估。
  assert.deepEqual(shouldTriggerAutoEvaluation({ ...base, lastEvaluatedAt: null }),
    { triggered: true, reason: "first-run", nextDueAt: null });
  // 非法入参 fail-fast。
  assert.throws(() => shouldTriggerAutoEvaluation({ mode: "bogus", isHumanTurn: true, lastEvaluatedAt: null, now: NOW, evaluateEveryHours: 24 }),
    (e) => e.code === "INVALID_INPUT");
  assert.throws(() => shouldTriggerAutoEvaluation({ mode: "auto", isHumanTurn: "yes", lastEvaluatedAt: null, now: NOW, evaluateEveryHours: 24 }),
    (e) => e.code === "INVALID_INPUT");
});

// ── 熔断与统计健康（§5.1 statsValid / §6.2）───────────────────────────────

test("熔断：时钟回拨（now < maxEventAt）→ fused，正常读写不受影响的判定纯靠注入", () => {
  const events = [
    { at: iso(10), scopeId: "amber", kind: "search_hit", topicKey: "t1" },
    { at: iso(-2), scopeId: "amber", kind: "search_hit", topicKey: "t1" }, // 未来事件（now + 2 天）
  ];
  const fuse = computeAutoFuse({ events, now: NOW, minCooldownDays: 30 });
  assert.equal(fuse.fused, true);
  assert.deepEqual(fuse.reasons.map((r) => r.code), [AUTO_FUSE_CODES.CLOCK_ROLLBACK]);
  assert.equal(fuse.maxEventAt, iso(-2));
});

test("熔断：账本坏行（skipped>0）/ 不可读 → fused；账本零事件 → 缺 statsStartedAt 熔断", () => {
  const events = [{ at: iso(40), scopeId: "amber", kind: "search_hit", topicKey: "t1" }];
  const damaged = computeAutoFuse({ events, now: NOW, minCooldownDays: 30, ledgerSkipped: 1 });
  assert.equal(damaged.fused, true);
  assert.equal(damaged.reasons[0].code, AUTO_FUSE_CODES.LEDGER_DAMAGED);

  const unreadable = computeAutoFuse({ events, now: NOW, minCooldownDays: 30, ledgerError: "EACCES: x" });
  assert.equal(unreadable.fused, true);
  assert.equal(unreadable.reasons[0].code, AUTO_FUSE_CODES.LEDGER_UNREADABLE);

  const empty = computeAutoFuse({ events: [], now: NOW, minCooldownDays: 30 });
  assert.equal(empty.fused, true);
  assert.equal(empty.reasons[0].code, AUTO_FUSE_CODES.STATS_MISSING);
  assert.equal(empty.statsStartedAt, null);
});

test("观察期：statsStartedAt 距今 < minCooldownDays 天 → statsValid=false（只挡冷却不熔断）", () => {
  const events = [{ at: iso(10), scopeId: "amber", kind: "search_hit", topicKey: "t1" }];
  // 观察期 10 天 < 30 天：不熔断，但 statsValid=false。
  const early = computeAutoFuse({ events, now: NOW, minCooldownDays: 30 });
  assert.equal(early.fused, false);
  assert.equal(early.statsValid, false);
  assert.deepEqual(early.reasons.map((r) => r.code), [AUTO_FUSE_CODES.OBSERVATION_PERIOD]);
  assert.equal(early.statsStartedAt, iso(10));
  // 观察期达标：statsValid=true 且无 reasons。
  const ok = computeAutoFuse({ events, now: NOW, minCooldownDays: 7 });
  assert.equal(ok.statsValid, true);
  assert.deepEqual(ok.reasons, []);
});

// ── 冷却候选护栏（§5.1）────────────────────────────────────────────────────

test("回差 25/50：T<25 产冷却候选、T=25 不产；T>=50 产恢复候选、T<50 不产（同刻度防抖动）", () => {
  // T = 100·2^(-N/30)：N=61 → ≈24.5（<25 冷）；N=60 → 25 整（不冷，边界不含）。
  const coolRow = row({ key: "cool", updated: iso(61) });
  const boundaryRow = row({ key: "boundary", updated: iso(60) });
  const cool = derive([coolRow, boundaryRow]);
  assert.deepEqual(cool.cool.map((c) => c.key), ["cool"]);
  assert.ok(cool.cool[0].T < 25);

  // 恢复：T >= 50（N=30 → T=50 整，边界含；N=31 → ≈48.9 <50 不恢复）。auto-inactive 归档。
  const restoreBoundary = row({ key: "r50", updated: iso(30), archivedAt: iso(5), archiveOrigin: AUTO_ARCHIVE_ORIGIN });
  const restoreSub = row({ key: "r49", updated: iso(31), archivedAt: iso(5), archiveOrigin: AUTO_ARCHIVE_ORIGIN });
  const restore = derive([restoreBoundary, restoreSub]);
  assert.deepEqual(restore.restore.map((c) => c.key), ["r50"]);
  assert.ok(restore.restore[0].T >= 50);
});

test("minCooldownDays：age 29 天不冷、30 天可冷（create/updated 锚点口径）", () => {
  // 无事件的 topic，age = 距 updated 天数；minCooldownDays=30 默认。
  // 29 天前 updated：age 29 < 30 → 挡（且 T≈50.6 也未达冷却线，双条件都挡）。
  const young = derive([row({ key: "young", updated: iso(29) })]);
  assert.equal(young.cool.length, 0);
  // 缩短 minCooldownDays=7（交叉校验要求 minRestoreGraceDays ≤ 7，取 3）后，
  // 29 天 age 达标但 T 未达冷却线 → 仍不冷（回差挡）。
  const warm = derive([row({ key: "warm", updated: iso(29) })], { p: params({ minCooldownDays: 7, minRestoreGraceDays: 3 }) });
  assert.equal(warm.cool.length, 0, "T≈50 > coolThreshold=25：冷却线挡住");

  // minCooldownDays=7（参数可调）：61 天前的冷态 topic 出候选（age 61 ≥ 7）。
  const tuned = derive([row({ key: "ok", updated: iso(61) })], { p: params({ minCooldownDays: 7, minRestoreGraceDays: 3 }) });
  assert.deepEqual(tuned.cool.map((c) => c.key), ["ok"]);
  // 观察期 7 天时 statsValid 也必须为真（事件 8 天前）——age 与观察期独立验证。
  const events = [{ at: iso(8), scopeId: "amber", kind: "search_hit", topicKey: "ok" }];
  const withStats = derive([row({ key: "ok", updated: iso(61) })], { p: params({ minCooldownDays: 7, minRestoreGraceDays: 3 }), events });
  assert.deepEqual(withStats.cool.map((c) => c.key), ["ok"]);
});

test("historical / standing 护栏：显式 standing 不冷；组默认 historical 生效（effective retention 口径）", () => {
  const standing = derive([row({ key: "s", retention: "standing", updated: iso(61) })]);
  assert.equal(standing.cool.length, 0);
  // 未归组且未显式 retention → 缺省 standing（§5.1 注释口径）。
  const ungrouped = derive([{ ...row({ key: "u", updated: iso(61) }), retention: undefined }]);
  assert.equal(ungrouped.cool.length, 0);
  // 组默认 historical：topic 显式值 ?? 主组默认 ?? standing。
  const groups = [{ key: "g1", retention: "historical" }];
  const viaGroup = derive(
    [{ ...row({ key: "g", updated: iso(61), group: ["g1"] }), retention: undefined }],
    { groups },
  );
  assert.deepEqual(viaGroup.cool.map((c) => c.key), ["g"]);
  assert.match(viaGroup.cool[0].reason, /retention=historical/);
});

test("pinned 护栏：pinned=true 永不进冷却候选", () => {
  const pinned = derive([row({ key: "p", pinned: true, updated: iso(61) })]);
  assert.equal(pinned.cool.length, 0);
});

test("manual 护栏：手动归档（archiveOrigin=manual）永不自动恢复，auto-inactive 才可恢复", () => {
  const manual = derive([row({ key: "m", updated: iso(29), archivedAt: iso(3), archiveOrigin: "manual" })]);
  assert.equal(manual.restore.length, 0);
  const auto = derive([row({ key: "a", updated: iso(29), archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN })]);
  assert.deepEqual(auto.restore.map((c) => c.key), ["a"]);
  assert.equal(auto.cool.length, 0); // 已归档的不进冷却清单
});

test("minRestoreGraceDays：恢复锚未满保护期 → 挡冷却；满保护期放行（§5.1 手动恢复护栏）", () => {
  // 13 天前恢复过 → 14 天保护期内不冷；15 天前 → 放行。
  const anchors = new Map([[autoIdentityKey("amber", "g"), iso(13)]]);
  const blocked = derive([row({ key: "g", updated: iso(61) })], { restoreAnchors: anchors });
  assert.equal(blocked.cool.length, 0);
  const anchors15 = new Map([[autoIdentityKey("amber", "g"), iso(15)]]);
  const allowed = derive([row({ key: "g", updated: iso(61) })], { restoreAnchors: anchors15 });
  assert.deepEqual(allowed.cool.map((c) => c.key), ["g"]);
  assert.match(allowed.cool[0].reason, /minRestoreGraceDays/);
});

test("熔断联动：fused=true 时冷却与恢复候选恒空（时钟回拨场景）", () => {
  const events = [{ at: iso(-1), scopeId: "amber", kind: "search_hit", topicKey: "c" }]; // 未来事件
  const fuse = computeAutoFuse({ events, now: NOW, minCooldownDays: 30 });
  assert.equal(fuse.fused, true);
  const fused = derive(
    [
      row({ key: "c", updated: iso(61) }),
      row({ key: "r", updated: iso(29), archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN }),
    ],
    { fuse, events },
  );
  assert.deepEqual(fused.cool, []);
  assert.deepEqual(fused.restore, []);
});

test("statsValid=false（观察期未满）挡冷却、不挡恢复", () => {
  const events = [{ at: iso(3), scopeId: "amber", kind: "search_hit", topicKey: "c" }];
  const fuse = computeAutoFuse({ events, now: NOW, minCooldownDays: 30 });
  assert.equal(fuse.fused, false);
  assert.equal(fuse.statsValid, false);
  const mixed = derive(
    [
      row({ key: "c", updated: iso(61) }),
      row({ key: "r", updated: iso(29), archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN }),
    ],
    { fuse, events },
  );
  assert.deepEqual(mixed.cool.map((c) => c.key), []);
  assert.deepEqual(mixed.restore.map((c) => c.key), ["r"]);
});

// ── 执行计划（§11.2.3）────────────────────────────────────────────────────

test("每轮 ≤ maxOpsPerRun：25 个候选截断到 20，truncated=true，冷却优先恢复其次，顺序确定", () => {
  const p = params({ maxOpsPerRun: 20 });
  const coolRows = [];
  for (let i = 0; i < 25; i += 1) {
    // 递增 updated 天数 → T 递减（最冷的排前）。
    coolRows.push(row({ key: `c${String(i).padStart(2, "0")}`, updated: iso(61 + i / 100) }));
  }
  const { cool } = derive(coolRows, { p });
  assert.equal(cool.length, 25);
  const plan = planAutoOps({ cool, restore: [], rows: coolRows, maxOpsPerRun: p.maxOpsPerRun, now: NOW });
  assert.equal(plan.ops.length, 20);
  assert.equal(plan.truncated, true);
  assert.deepEqual(plan.counts, { cool: 25, restore: 0, total: 25 });
  // 全部是冷却操作且按 T 升序（最冷优先）。
  assert.ok(plan.ops.every((op) => op.operationKind === "archive-topic"));
  for (let i = 1; i < plan.ops.length; i += 1) {
    assert.ok(plan.ops[i - 1].T <= plan.ops[i].T, "冷却候选按 T 升序执行");
  }
  // 冷却优先于恢复：混合场景（19 冷 + 1 恢复、上限 20）下恢复排在最后。
  const restoreRow = [row({ key: "r", updated: iso(29), archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN })];
  const { restore } = derive(restoreRow, { p });
  const mixed = planAutoOps({ cool: cool.slice(0, 19), restore, rows: [...coolRows, ...restoreRow], maxOpsPerRun: 20, now: NOW });
  assert.equal(mixed.ops.length, 20);
  assert.equal(mixed.ops[0].operationKind, "archive-topic");
  assert.equal(mixed.ops[18].operationKind, "archive-topic");
  assert.equal(mixed.ops[19].operationKind, "unarchive-topic");
});

test("执行计划：每条 op 带非空 reason（没有 reason 的自动决策不许执行）与前后值", () => {
  const p = params();
  const rows = [
    row({ key: "c", updated: iso(61) }),
    row({ key: "r", updated: iso(29), archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN }),
  ];
  const { cool, restore } = derive(rows, { p });
  const plan = planAutoOps({ cool, restore, rows, maxOpsPerRun: p.maxOpsPerRun, now: NOW });
  assert.equal(plan.ops.length, 2);
  for (const op of plan.ops) {
    assert.ok(AUTO_OP_KINDS.includes(op.operationKind));
    assert.equal(typeof op.reason, "string");
    assert.ok(op.reason.trim().length >= 10, "reason 必须可解释");
    assert.ok(isPlainBeforeAfter(op.before) && isPlainBeforeAfter(op.after));
  }
  const archiveOp = plan.ops.find((op) => op.operationKind === "archive-topic");
  assert.deepEqual(archiveOp.before, { archivedAt: null, archiveOrigin: null });
  assert.equal(archiveOp.after.archivedAt, NOW);
  assert.equal(archiveOp.after.archiveOrigin, AUTO_ARCHIVE_ORIGIN);
  const restoreOp = plan.ops.find((op) => op.operationKind === "unarchive-topic");
  assert.equal(restoreOp.before.archivedAt, iso(3));
  assert.equal(restoreOp.before.archiveOrigin, AUTO_ARCHIVE_ORIGIN);
  assert.deepEqual(restoreOp.after, { archivedAt: null, archiveOrigin: null });
});

function isPlainBeforeAfter(value) {
  return value !== null && typeof value === "object"
    && Object.hasOwn(value, "archivedAt") && Object.hasOwn(value, "archiveOrigin");
}

// ── 连组恢复（§4.4）：只恢复导航、不连坐成员 ─────────────────────────────

test("连组恢复：整组冷 + 恢复一名成员 → groupRestore 只说明导航，其余成员不出现在 ops 里", () => {
  const p = params();
  const rows = [
    // 组 g1 两名成员都归档（auto-inactive）：r1 热（29 天 updated → T≈50+）、r2 仍冷。
    row({ key: "r1", group: ["g1"], updated: iso(29), archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN }),
    row({ key: "r2", group: ["g1"], updated: iso(80), archivedAt: iso(40), archiveOrigin: AUTO_ARCHIVE_ORIGIN }),
  ];
  const { restore } = derive(rows, { p });
  assert.deepEqual(restore.map((c) => c.key), ["r1"], "只有热的成员进恢复清单");
  const plan = planAutoOps({ cool: [], restore, rows, maxOpsPerRun: p.maxOpsPerRun, now: NOW });
  // 不连坐：ops 里只有 r1，r2 的 archivedAt 原样保留（不在任何 op 里）。
  assert.deepEqual(plan.ops.map((op) => op.key), ["r1"]);
  // 导航恢复说明（navigationOnly）。
  assert.equal(plan.groupRestore.length, 1);
  assert.equal(plan.groupRestore[0].key, "g1");
  assert.equal(plan.groupRestore[0].navigationOnly, true);
  assert.deepEqual(plan.groupRestore[0].restoredMembers, ["r1"]);
  assert.equal(plan.groupRestore[0].otherMembersUntouched, true);
  assert.match(plan.groupRestore[0].reason, /不连坐/);
});

test("manual 归档组永不自动恢复：组内全员 manual → 无恢复候选、无 groupRestore", () => {
  const p = params();
  const rows = [
    row({ key: "m1", group: ["g2"], updated: iso(29), archivedAt: iso(3), archiveOrigin: "manual" }),
    row({ key: "m2", group: ["g2"], updated: iso(29), archivedAt: iso(3), archiveOrigin: "manual" }),
  ];
  const { restore } = derive(rows, { p });
  assert.deepEqual(restore, []);
  const plan = planAutoOps({ cool: [], restore, rows, maxOpsPerRun: p.maxOpsPerRun, now: NOW });
  assert.deepEqual(plan.groupRestore, []);
});

test("连组恢复：组本来就有活跃成员时导航从未离开，不产生 groupRestore 标注", () => {
  const p = params();
  const rows = [
    row({ key: "hot", group: ["g3"], updated: iso(1) }), // 活跃成员在组内
    row({ key: "warming", group: ["g3"], updated: iso(29), archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN }),
  ];
  const { restore } = derive(rows, { p });
  assert.deepEqual(restore.map((c) => c.key), ["warming"]);
  const plan = planAutoOps({ cool: [], restore, rows, maxOpsPerRun: p.maxOpsPerRun, now: NOW });
  assert.deepEqual(plan.groupRestore, [], "组导航未冷过，无需标注恢复");
});

// ── 撤销计划（一键撤销）────────────────────────────────────────────────────

test("buildUndoOps：applied 条目逐条取逆（before/after 互换），skipped/failed 不进撤销", () => {
  const run = {
    runId: "auto-1-abc",
    at: NOW,
    scopeId: "amber",
    trigger: "human-turn",
    mode: "auto",
    operationId: "op-1",
    undoneAt: null,
    ops: [
      { operationKind: "archive-topic", key: "a", scopeId: "amber", before: { archivedAt: null, archiveOrigin: null }, after: { archivedAt: NOW, archiveOrigin: AUTO_ARCHIVE_ORIGIN }, operationId: "autoar-x", status: "applied", reason: "r1" },
      { operationKind: "archive-topic", key: "b", scopeId: "amber", before: { archivedAt: null, archiveOrigin: null }, after: { archivedAt: NOW, archiveOrigin: AUTO_ARCHIVE_ORIGIN }, operationId: "autoar-y", status: "failed", reason: "r2", error: "X" },
      { operationKind: "unarchive-topic", key: "c", scopeId: "amber", before: { archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN }, after: { archivedAt: null, archiveOrigin: null }, operationId: "autoun-z", status: "applied", reason: "r3" },
    ],
  };
  const undoOps = buildUndoOps(run);
  assert.deepEqual(undoOps.map((op) => op.key), ["a", "c"], "failed 条目不进撤销");
  const undoA = undoOps[0];
  assert.equal(undoA.operationKind, "unarchive-topic");
  assert.deepEqual(undoA.before, { archivedAt: NOW, archiveOrigin: AUTO_ARCHIVE_ORIGIN });
  assert.deepEqual(undoA.after, { archivedAt: null, archiveOrigin: null });
  const undoC = undoOps[1];
  assert.equal(undoC.operationKind, "archive-topic");
  assert.equal(undoC.before.archivedAt, null);
  assert.equal(undoC.after.archivedAt, iso(3));
  assert.equal(undoC.after.archiveOrigin, AUTO_ARCHIVE_ORIGIN);
  assert.ok(undoA.reason.includes("auto-1-abc"), "撤销 reason 带 run 来源");
});

test("assertRunShape：缺字段/非法 kind/status 一律 INVALID_STATE", () => {
  const base = {
    runId: "r", at: NOW, scopeId: "amber", trigger: "manual", mode: "auto", operationId: "op",
    ops: [{ operationKind: "archive-topic", key: "k", scopeId: "amber", status: "applied", before: { archivedAt: null, archiveOrigin: null }, after: { archivedAt: NOW, archiveOrigin: "auto-inactive" } }],
  };
  assert.doesNotThrow(() => assertRunShape(base));
  assert.throws(() => assertRunShape({ ...base, runId: "" }), (e) => e.code === "INVALID_STATE");
  assert.throws(() => assertRunShape({ ...base, ops: [{ ...base.ops[0], operationKind: "rewrite" }] }), (e) => e.code === "INVALID_STATE");
  assert.throws(() => assertRunShape({ ...base, ops: [{ ...base.ops[0], status: "weird" }] }), (e) => e.code === "INVALID_STATE");
  assert.throws(() => assertRunShape({ ...base, ops: [{ ...base.ops[0], before: undefined }] }), (e) => e.code === "INVALID_STATE");
});

// ── 纯模块纪律 + 模式枚举 ────────────────────────────────────────────────

test("纯函数确定性：同一输入两次调用 JSON 逐字节相同（derive + plan）", () => {
  const p = params();
  const rows = [
    row({ key: "c", updated: iso(61) }),
    row({ key: "r", updated: iso(29), archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN }),
  ];
  const a = derive(rows, { p });
  const b = derive(rows, { p });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  const planA = planAutoOps({ cool: a.cool, restore: a.restore, rows, maxOpsPerRun: p.maxOpsPerRun, now: NOW });
  const planB = planAutoOps({ cool: a.cool, restore: a.restore, rows, maxOpsPerRun: p.maxOpsPerRun, now: NOW });
  assert.equal(JSON.stringify(planA), JSON.stringify(planB));
});

test("常量契约：三档模式 / 两类可逆操作 / 归档来源标记", () => {
  assert.deepEqual([...AUTO_MODES], ["off", "suggest", "auto"]);
  assert.deepEqual([...AUTO_OP_KINDS], ["archive-topic", "unarchive-topic"]);
  assert.equal(AUTO_ARCHIVE_ORIGIN, "auto-inactive");
});

// ── 批次 10-2：symlink/junction 构造 helper（收敛全文件 4 处 catch→t.skip）────
// 有符号链接权限的环境必须真跑（skip 就是换机盲区——链接构造不出来时越根/悬空
// 用例全空转，问题发现不了）；只有构造不了链接的环境（Windows 非管理员且未开
// 开发者模式等）才允许 skip，且打一行带原因与环境信息的日志，方便换机排查与
// 核对「0 skipped」。

function linkEnvInfo() {
  return `platform=${process.platform} node=${process.version}（Windows 构造符号链接需管理员或开发者模式）`;
}

/** 构造 symlink/junction；失败时打环境日志并 t.skip（返回 false，调用方据此 return）。 */
async function createLinkOrSkip(t, target, linkPath, type) {
  try {
    await fsSymlink(target, linkPath, type);
    return true;
  } catch (error) {
    console.warn(`[skip] ${type} 链接构造失败：${error?.code ?? "?"} ${error?.message ?? ""}；环境：${linkEnvInfo()}——相关越根/悬空用例跳过，本环境结论不代表有权限环境的结论`);
    t.skip(`当前环境不允许创建${type === "junction" ? "目录链接" : "文件符号链接"}（${error?.code ?? error?.message}）`);
    return false;
  }
}

// ── 装配源（只读；用临时目录验证坏文件降级与 global/active 覆盖）────────────

test("createAutoReplaySource：dataRoot null 全空装配；坏文件跳过计数；global 先、active 覆盖", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-src-"));
  try {
    const source = createAutoReplaySource({ dataRoot: null, stateRoot: null });
    assert.deepEqual((await source.readTopics("amber")).rows, []);
    assert.deepEqual(await source.readGroups("amber"), []);
    const emptyLedger = await source.readLedger();
    assert.deepEqual(emptyLedger.events, []);
    assert.equal(emptyLedger.error, null);

    await mkdir(path.join(base, "scopes", "global", "topics"), { recursive: true });
    await mkdir(path.join(base, "scopes", "amber", "topics"), { recursive: true });
    const body = (key, scope, updated) => `---\nkey: ${key}\nscopeId: ${scope}\ntitle: ${key}\nsummary: s\nupdated: ${updated}\n---\n\nbody\n`;
    await writeFile(path.join(base, "scopes", "global", "topics", "shared.md"), body("shared", "global", iso(90)));
    await writeFile(path.join(base, "scopes", "amber", "topics", "shared.md"), body("shared", "amber", iso(5)));
    await writeFile(path.join(base, "scopes", "amber", "topics", "broken.md"), "not-a-topic");
    await writeFile(path.join(base, "scopes", "amber", "topics", "not-md.txt"), "ignore");

    const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
    const { rows, skipped } = await live.readTopics("amber");
    assert.deepEqual(rows.map((r) => `${r.scopeId}:${r.key}`).sort(), ["amber:shared"], "active 覆盖 global（同 key）");
    assert.equal(skipped, 1, "坏 frontmatter 文件跳过计数");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 批次 8-4：readTopics 的越根链接口径与 store/listTopics 对齐 ────────────────

test("createAutoReplaySource：单文件越根 symlink 跳过并计数（与 listTopics 同集合）", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-escape-"));
  const outsideBase = await mkdtemp(path.join(tmpdir(), "shiori-auto-escape-out-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  t.after(() => rm(outsideBase, { recursive: true, force: true }));
  const topicsDir = path.join(base, "scopes", "amber", "topics");
  const outsideDir = outsideBase;
  await mkdir(topicsDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  const body = (key, scope, updated) => `---\nkey: ${key}\nscopeId: ${scope}\ntitle: ${key}\nsummary: s\nupdated: ${updated}\n---\n\nbody\n`;
  await writeFile(path.join(topicsDir, "good.md"), body("good", "amber", iso(1)));
  await writeFile(path.join(outsideDir, "evil.md"), body("evil", "amber", iso(1)));
  if (!(await createLinkOrSkip(t, path.join(outsideDir, "evil.md"), path.join(topicsDir, "evil.md"), "file"))) return;
  const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
  const { rows, skipped } = await live.readTopics("amber");
  assert.deepEqual(rows.map((r) => r.key), ["good"], "越根链接不得进入回放装配（预览少算的根因）");
  assert.equal(skipped, 1, "单文件越根按「跳过并计数」，与 store 快照进 shadow 同口径");
});

test("createAutoReplaySource：目录级越根 junction 直接拒绝（与 store 快照同口径 INVALID_INPUT）", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-escape-dir-"));
  const outsideBase = await mkdtemp(path.join(tmpdir(), "shiori-auto-escape-dir-out-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  t.after(() => rm(outsideBase, { recursive: true, force: true }));
  const scopeDir = path.join(base, "scopes", "amber");
  const outsideDir = outsideBase;
  await mkdir(scopeDir, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await writeFile(path.join(outsideDir, "evil.md"), `---\nkey: evil\nscopeId: amber\ntitle: evil\nsummary: s\nupdated: ${iso(1)}\n---\n\nbody\n`);
  if (!(await createLinkOrSkip(t, outsideDir, path.join(scopeDir, "topics"), process.platform === "win32" ? "junction" : "dir"))) return;
  const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
  await assert.rejects(
    () => live.readTopics("amber"),
    (error) => error.code === "INVALID_INPUT" && /越出管理根/.test(error.message),
    "topics 目录整体越根时，与 store 快照一样拒绝，不得静默读根外内容",
  );
});

test("createAutoReplaySource：悬空单文件 symlink 按坏文件降级（跳过计数，不抛）", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-dangling-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const topicsDir = path.join(base, "scopes", "amber", "topics");
  await mkdir(topicsDir, { recursive: true });
  await writeFile(path.join(topicsDir, "good.md"),
    `---\nkey: good\nscopeId: amber\ntitle: good\nsummary: s\nupdated: ${iso(1)}\n---\n\nbody\n`);
  // 目标不存在 = 悬空链接（lstat 成功、realpath ENOENT），不得把预览/评估拖垮。
  if (!(await createLinkOrSkip(t, path.join(base, "missing-target.md"), path.join(topicsDir, "dangling.md"), "file"))) return;
  const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
  const { rows, skipped } = await live.readTopics("amber");
  assert.deepEqual(rows.map((r) => r.key), ["good"], "悬空链接不进入装配");
  assert.equal(skipped, 1, "悬空链接计入 skipped（与坏 JSON 同口径）");
});

test("createAutoReplaySource：悬空 topics 目录 junction 视为空集合（不抛）", async (t) => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-dangling-dir-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const outside = await mkdtemp(path.join(tmpdir(), "shiori-auto-dangling-target-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(base, "scopes", "amber"), { recursive: true });
  if (!(await createLinkOrSkip(t, outside, path.join(base, "scopes", "amber", "topics"), process.platform === "win32" ? "junction" : "dir"))) return;
  // 删目标 = 悬空 junction（lstat 成功、realpath ENOENT）。
  await rm(outside, { recursive: true, force: true });
  const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
  const { rows, skipped } = await live.readTopics("amber");
  assert.deepEqual(rows, [], "悬空目录视为该 scope 无 topics");
  assert.equal(skipped, 0, "目录级悬空不计单文件跳过");
});

// ── 批次 10-2：readGroups 对齐 store 口径（根 realpath + 越根拒 + 悬空降级）────

/** 合法 groups.json 内容（core/groups.mjs validateGroupsData 口径：version 1 + 四字段条目）。 */
const validGroupsJson = (keys) => JSON.stringify({
  version: 1,
  groups: keys.map((key, index) => ({ key, title: `组-${key}`, summary: "s", order: index + 1 })),
});

test("createAutoReplaySource：readGroups 正常读取 groups.json（根 realpath + 越根检查不误伤正常文件）", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-groups-"));
  try {
    await mkdir(path.join(base, "scopes", "amber"), { recursive: true });
    await writeFile(path.join(base, "scopes", "amber", "groups.json"), validGroupsJson(["g1"]));
    const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
    const groups = await live.readGroups("amber");
    assert.deepEqual(groups.map((g) => g.key), ["g1"], "正常 groups.json 照常解析（10-2 改动不误伤）");
    // 无 groups.json 的 scope → 空清单降级（与改前 readFileOrNull 口径一致）。
    assert.deepEqual(await live.readGroups("global"), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("createAutoReplaySource：readGroups 越根（groups.json 指向根外）直接拒（对齐 store 口径 INVALID_INPUT）", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-groups-esc-"));
  const outsideBase = await mkdtemp(path.join(tmpdir(), "shiori-auto-groups-out-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  t.after(() => rm(outsideBase, { recursive: true, force: true }));
  await mkdir(path.join(base, "scopes", "amber"), { recursive: true });
  // 根外放一份内容完全合法的 groups.json：证明拒绝原因是越根链接而非坏内容。
  await writeFile(path.join(outsideBase, "groups.json"), validGroupsJson(["evil"]));
  if (!(await createLinkOrSkip(t, path.join(outsideBase, "groups.json"), path.join(base, "scopes", "amber", "groups.json"), "file"))) return;
  const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
  await assert.rejects(
    () => live.readGroups("amber"),
    (error) => error.code === "INVALID_INPUT" && /越出管理根/.test(error.message),
    "groups.json 指向根外时与 store readGroups（storage/groups.mjs）同判：拒绝，绝不静默读根外内容",
  );
});

test("createAutoReplaySource：readGroups 悬空 groups.json 按空清单降级（不抛）", async (t) => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-groups-dang-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "scopes", "amber"), { recursive: true });
  // 目标不存在 = 悬空链接（lstat 成功、realpath ENOENT）→ 坏文件降级。
  if (!(await createLinkOrSkip(t, path.join(base, "missing-groups-target.json"), path.join(base, "scopes", "amber", "groups.json"), "file"))) return;
  const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
  const groups = await live.readGroups("amber");
  assert.deepEqual(groups, [], "悬空 groups.json 按空清单降级，不拖垮评估");
});

test("createAutoReplaySource：readGroups 的 groups.json 自指循环链接（ELOOP）按空清单降级（不抛）", async (t) => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-groups-eloop-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "scopes", "amber"), { recursive: true });
  // groups.json → groups.json 自指循环（lstat 成功、realpath 报 ELOOP；Windows
  // 实测自指链接 realpath 报 ELOOP，互指循环报 ENOENT）——readGroups 的
  // ELOOP→[] 分支（degradableLinkError 命中）独立成用例，不靠 topics 用例顺带。
  if (!(await createLinkOrSkip(t, path.join(base, "scopes", "amber", "groups.json"), path.join(base, "scopes", "amber", "groups.json"), "file"))) return;
  const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
  const groups = await live.readGroups("amber");
  assert.deepEqual(groups, [], "ELOOP groups.json 按空清单降级：不抛、不拖垮评估");
});

test("createAutoReplaySource：ELOOP 循环链接按坏文件降级（skipped 计数，不抛）", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-eloop-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const topicsDir = path.join(base, "scopes", "amber", "topics");
  await mkdir(topicsDir, { recursive: true });
  await writeFile(path.join(topicsDir, "good.md"),
    `---\nkey: good\nscopeId: amber\ntitle: good\nsummary: s\nupdated: ${iso(1)}\n---\n\nbody\n`);
  // 自指循环链接：loop.md → loop.md（lstat 成功、realpath ELOOP；Windows 实测
  // 自指链接 realpath 报 ELOOP）。
  if (!(await createLinkOrSkip(t, path.join(topicsDir, "loop.md"), path.join(topicsDir, "loop.md"), "file"))) return;
  const live = createAutoReplaySource({ dataRoot: base, stateRoot: null });
  const { rows, skipped } = await live.readTopics("amber");
  assert.deepEqual(rows.map((r) => r.key), ["good"], "循环链接不进入装配，其余文件照常读出");
  assert.equal(skipped, 1, "ELOOP 命中 degradableLinkError → 计 skipped，不抛");
});

// ── 批次 10-2：deps.fs 注入面（realpath/lstat/readGroups 全走注入，删注入必须红）────

test("createAutoReplaySource：deps.fs 注入生效——假 realpath 报 ENOENT 按空装配降级（管理根 realpath 走注入面）", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  // 真盘存在且内容齐全：若实现写死 fsp.realpath（真根存在），本用例会拿到非空
  // rows 而 fail——红即证明管理根 realpath 走注入面。
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-inj-root-"));
  try {
    await mkdir(path.join(base, "scopes", "amber", "topics"), { recursive: true });
    await writeFile(path.join(base, "scopes", "amber", "topics", "good.md"),
      `---\nkey: good\nscopeId: amber\ntitle: good\nsummary: s\nupdated: ${iso(1)}\n---\n\nbody\n`);
    const real = await import("node:fs/promises");
    const realpathCalls = [];
    const fakeFs = {
      readdir: real.readdir,
      readFile: real.readFile,
      lstat: real.lstat,
      realpath: async (p) => {
        realpathCalls.push(p);
        const error = new Error("fake ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    };
    const live = createAutoReplaySource({ dataRoot: base, stateRoot: null, fs: fakeFs });
    const { rows, skipped } = await live.readTopics("amber");
    assert.deepEqual(rows, [], "注入的 realpath 报 ENOENT → 与真盘缺失同口径：空装配降级");
    assert.equal(skipped, 0);
    assert.deepEqual(realpathCalls, [base], "realpath 注入被调用且收到 dataRoot（管理根身份走注入面）");
    // readGroups 的管理根 realpath 同走注入面（同款降级）：清空采集后单独断言
    // readGroups 的调用确实经过注入 realpath——若实现把 readGroups 的根 realpath
    // 写死 fsp.realpath（真根存在、readGroups 照样返回 []），这段断言即红（评审 R1，
    // 交叉变异自证）。清空后断言精确 [base]，未来新增调用也会被立刻暴露。
    realpathCalls.length = 0;
    assert.deepEqual(await live.readGroups("amber"), []);
    assert.deepEqual(realpathCalls, [base], "readGroups 的管理根 realpath 走注入面且收到 dataRoot（写死 fsp.realpath 必红）");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("createAutoReplaySource：deps.fs 注入生效——假 lstat/realpath 报告越根链接时拒绝（逐级链接判定走注入面）", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  // 真盘无任何链接：若实现写死 fsp.lstat/fsp.realpath（真盘判定：无链接不越根），
  // 本用例会正常读出 rows 而 fail——红即证明越根检查走注入面。
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-inj-link-"));
  try {
    await mkdir(path.join(base, "scopes", "amber", "topics"), { recursive: true });
    await writeFile(path.join(base, "scopes", "amber", "topics", "good.md"),
      `---\nkey: good\nscopeId: amber\ntitle: good\nsummary: s\nupdated: ${iso(1)}\n---\n\nbody\n`);
    const topicsDir = path.join(base, "scopes", "amber", "topics");
    // 假实现：topics 目录是符号链接，解析到工作根之外（tmpdir 下与 base 平级的目录）。
    const escapeTarget = path.join(path.dirname(base), "outside-escape");
    const real = await import("node:fs/promises");
    const fakeFs = {
      readdir: real.readdir,
      readFile: real.readFile,
      lstat: async (p) => ({ isSymbolicLink: () => p === topicsDir }),
      realpath: async (p) => (p === topicsDir ? escapeTarget : p),
    };
    const live = createAutoReplaySource({ dataRoot: base, stateRoot: null, fs: fakeFs });
    await assert.rejects(
      () => live.readTopics("amber"),
      (error) => error.code === "INVALID_INPUT" && /越出管理根/.test(error.message),
      "注入假实现报告 topics 目录越根 → 与真链接同判拒绝（assertNoEscapeViaSymlink 吃注入 fs）",
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("createAutoReplaySource：readGroups 走注入 fs——真盘无文件、假 readFile 提供内容才能解析（写死 readFileOrNull 则红）", async () => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-inj-groups-"));
  try {
    await mkdir(path.join(base, "scopes", "amber"), { recursive: true });
    const groupsPath = path.join(base, "scopes", "amber", "groups.json");
    const real = await import("node:fs/promises");
    const fakeFs = {
      readdir: real.readdir,
      lstat: real.lstat,
      realpath: async (p) => p, // 恒等：规避 tmpdir 短名/大小写差异，保证路径比较一致
      readFile: async (p) => {
        if (p === groupsPath) {
          return Buffer.from(validGroupsJson(["g1"]), "utf8");
        }
        const error = new Error("fake ENOENT");
        error.code = "ENOENT";
        throw error;
      },
    };
    const live = createAutoReplaySource({ dataRoot: base, stateRoot: null, fs: fakeFs });
    const groups = await live.readGroups("amber");
    assert.deepEqual(groups.map((g) => g.key), ["g1"], "readGroups 的文件读取走注入面：真盘无此文件，只有注入 fs 能提供内容");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// ── 批次 10-2：operationId 重放口径（scopeId 过滤 + 滚动窗口）────────────────

/** 引擎/账本用例的最小 run 形状（apply 产物字段对齐）。 */
function dummyRun(overrides = {}) {
  return {
    runId: "r",
    at: NOW,
    scopeId: "amber",
    trigger: "human-turn",
    mode: "auto",
    operationId: "op",
    undoneAt: null,
    ops: [],
    ...overrides,
  };
}

/** 建临时 stateRoot + createStateStore（autoRunKeepLimit 可注入）。 */
async function withTempState(t, { autoRunKeepLimit } = {}) {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const base = await mkdtemp(path.join(tmpdir(), "shiori-auto-opid-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stateRoot = path.join(base, "state");
  await mkdir(stateRoot, { recursive: true });
  const options = autoRunKeepLimit === undefined ? {} : { autoRunKeepLimit };
  return createStateStore({ stateRoot, ...options });
}

test("autoStore.getRunByOperationId：scopeId 过滤——跨 scope 同 opId 不串；两参必填 fail-fast", async (t) => {
  const store = await withTempState(t);
  await store.autoStore.recordRun(dummyRun({ runId: "r-amber", operationId: "op-x", scopeId: "amber" }));
  const hit = await store.autoStore.getRunByOperationId("op-x", "amber");
  assert.equal(hit?.runId, "r-amber", "本 scope 同 opId 命中");
  assert.equal(await store.autoStore.getRunByOperationId("op-x", "delta"), null, "跨 scope 同 opId 不得命中别人的 run");
  assert.equal(await store.autoStore.getRunByOperationId("op-y", "amber"), null, "未知 opId 不命中");
  await assert.rejects(() => store.autoStore.getRunByOperationId("op-x"), (e) => e.code === "INVALID_INPUT", "缺 scopeId fail-fast");
  await assert.rejects(() => store.autoStore.getRunByOperationId("", "amber"), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => store.autoStore.getRunByOperationId("op-x", ""), (e) => e.code === "INVALID_INPUT");
});

test("autoStore.recordRun：缺省滚动窗口与 AUTO_RUN_KEEP 同源（第 51 条逐出最旧）", async (t) => {
  const store = await withTempState(t);
  for (let i = 0; i < AUTO_RUN_KEEP; i += 1) {
    await store.autoStore.recordRun(dummyRun({ runId: `r-${String(i).padStart(2, "0")}`, operationId: `op-${i}` }));
  }
  const full = await store.autoStore.read();
  assert.equal(full.state.runs.length, AUTO_RUN_KEEP, "窗口上限 = AUTO_RUN_KEEP");
  await store.autoStore.recordRun(dummyRun({ runId: "r-new", operationId: "op-new" }));
  const after = await store.autoStore.read();
  assert.equal(after.state.runs.length, AUTO_RUN_KEEP);
  assert.equal(after.state.runs[0].runId, "r-01", "最旧被裁");
  assert.equal(await store.autoStore.getRunByOperationId("op-0", "amber"), null, "被逐出的 opId 查不到（窗口外）");
  assert.equal((await store.autoStore.getRunByOperationId("op-49", "amber"))?.runId, "r-49", "窗口内 opId 照常命中");
});

test("createStateStore：autoRunKeepLimit 注入生效（整数 ≥1，非法拒绝）", async (t) => {
  const store = await withTempState(t, { autoRunKeepLimit: 2 });
  await store.autoStore.recordRun(dummyRun({ runId: "r-1", operationId: "op-1" }));
  await store.autoStore.recordRun(dummyRun({ runId: "r-2", operationId: "op-2" }));
  await store.autoStore.recordRun(dummyRun({ runId: "r-3", operationId: "op-3" }));
  const read = await store.autoStore.read();
  assert.deepEqual(read.state.runs.map((r) => r.runId), ["r-2", "r-3"], "注入窗口 2 → 只留最近两条");
  await assert.rejects(() => withTempState(t, { autoRunKeepLimit: 0 }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => withTempState(t, { autoRunKeepLimit: 1.5 }), (e) => e.code === "INVALID_INPUT");
});

// ── 批次 10-2：apply 重放口径（窗口内重放 / 逐出重跑 / 跨 scope 不串）────────────

/** 引擎用例的空装配回放源（无候选 → 不触执行路径）+ 一条远古种子事件（不熔断）。 */
function emptyReplaySource() {
  return {
    readTopics: async () => ({ rows: [], skipped: 0 }),
    readGroups: async () => [],
    readLedger: async () => ({
      events: [{ at: iso(90), scopeId: "amber", kind: "search_hit", topicKey: "__seed__" }],
      skipped: 0,
      error: null,
    }),
  };
}

function engineFor(store) {
  return createAutoEngine({
    nowIso: () => NOW,
    mode: () => "auto",
    params: () => params(),
    replaySource: emptyReplaySource(),
    serviceFor: async () => {
      throw new Error("本用例无候选，serviceFor 不应被调用");
    },
    store: store.autoStore,
  });
}

test("auto apply：窗口内同 operationId 重放首次结果；逐出窗口后重跑（autoRunKeepLimit=1）", async (t) => {
  const store = await withTempState(t, { autoRunKeepLimit: 1 });
  const engine = engineFor(store);
  const first = await engine.apply({ scopeId: "amber", trigger: "human-turn", operationId: "op-w" });
  assert.equal(first.replay, false);
  assert.equal(first.applied, 0);
  const second = await engine.apply({ scopeId: "amber", trigger: "human-turn", operationId: "op-w" });
  assert.equal(second.replay, true, "窗口内命中 → 重放首次结果");
  assert.equal(second.runId, first.runId, "重放返回同一 run");
  // keep=1：一条新 run 即把 op-w 的 run 逐出窗口 → 同 opId 按新执行重跑。
  await store.autoStore.recordRun(dummyRun({ runId: "r-other", operationId: "op-other", scopeId: "delta" }));
  const third = await engine.apply({ scopeId: "amber", trigger: "human-turn", operationId: "op-w" });
  assert.equal(third.replay, false, "run 被逐出滚动窗口后同 opId 重跑（注释口径：单操作幂等靠底层 journal）");
  assert.notEqual(third.runId, first.runId, "重跑产生新 run");
});

test("auto apply：跨 scope 同 operationId 不串（重放命中必须 scopeId 一致）", async (t) => {
  const store = await withTempState(t);
  const engine = engineFor(store);
  const amberRun = await engine.apply({ scopeId: "amber", trigger: "human-turn", operationId: "op-shared" });
  assert.equal(amberRun.replay, false);
  const deltaRun = await engine.apply({ scopeId: "delta", trigger: "human-turn", operationId: "op-shared" });
  assert.equal(deltaRun.replay, false, "delta 不得重放 amber 的 run（旧实现全量 scan 会串）");
  assert.notEqual(deltaRun.runId, amberRun.runId);
  const deltaAgain = await engine.apply({ scopeId: "delta", trigger: "human-turn", operationId: "op-shared" });
  assert.equal(deltaAgain.replay, true, "delta 自己的窗口内重放照常命中");
  assert.equal(deltaAgain.runId, deltaRun.runId);
});

// ── 0.5 第三波：selection 双通道（suggest 手动执行 / 逐条勾选 / candidate-missing）──
//
// 引擎级用例：回放源注入「三冷一热」候选（61/62/63 天冷档 + 29 天 auto-inactive
// 热档），service 为内存假实现（readTopic/mutate 记账），覆盖：
//   selection 子集执行（plan 原顺序）/ 未选中不执行不记录 / candidate-missing 记
//   skipped 不整单失败 / 重复与非法 selection INVALID_INPUT / off 拒绝 / suggest
//   手动执行成功（run.mode=suggest）/ suggest 自动调度仍不执行 / 旧 run 缺
//   selection 可回放。

/** 三冷一热候选的回放源（纯内存注入；行形状与 createAutoReplaySource.readTopics 产物一致）。 */
function candidateReplaySource() {
  const rows = [
    { key: "cool-1", scopeId: "amber", updated: iso(61), retention: "historical", pinned: false, group: [], title: "冷一" },
    { key: "cool-2", scopeId: "amber", updated: iso(62), retention: "historical", pinned: false, group: [], title: "冷二" },
    { key: "cool-3", scopeId: "amber", updated: iso(63), retention: "historical", pinned: false, group: [], title: "冷三" },
    { key: "rest-1", scopeId: "amber", updated: iso(29), retention: "historical", pinned: false, group: [], title: "热一", archivedAt: iso(3), archiveOrigin: AUTO_ARCHIVE_ORIGIN },
  ];
  return {
    rows,
    readTopics: async () => ({ rows: rows.map((r) => ({ ...r })), skipped: 0 }),
    readGroups: async () => [],
    readLedger: async () => ({
      // 远古种子事件（90 天前 ≥ minCooldownDays=30）：统计健康、不加热任何 topic。
      events: [{ at: iso(90), scopeId: "amber", kind: "search_hit", topicKey: "__seed__" }],
      skipped: 0,
      error: null,
    }),
  };
}

/** 假 service 状态（按回放源行初始化：archivedAt/archiveOrigin 与行一致）。 */
function fakeServiceState(rows) {
  const state = {};
  for (const row of rows) {
    state[row.key] = {
      scopeId: row.scopeId,
      revision: 1,
      body: "正文。",
      archivedAt: row.archivedAt ?? null,
      archiveOrigin: row.archiveOrigin ?? null,
    };
  }
  return state;
}

/** 假 serviceFor：readTopic 供 CAS 复核、mutate 记账（log 收集调用，磁盘效果反映在 state）。 */
function fakeServiceFor(state, log) {
  return async () => ({
    async readTopic(key) {
      const rec = state[key];
      if (!rec) {
        const error = new Error(`NOT_FOUND: topic "${key}"`);
        error.code = "NOT_FOUND";
        throw error;
      }
      return { key, scopeId: rec.scopeId, revision: rec.revision, body: rec.body, archivedAt: rec.archivedAt, archiveOrigin: rec.archiveOrigin };
    },
    async mutate(call) {
      log.push(call);
      for (const change of call.changes) {
        const rec = state[change.key];
        rec.revision += 1;
        rec.archivedAt = change.topic.archivedAt;
        rec.archiveOrigin = change.topic.archiveOrigin;
      }
      return { ok: true };
    },
  });
}

/** 带候选的引擎（mode 可注入；serviceFor 调用收集进 log）。 */
function candidateEngine(store, { mode = "suggest", log = [] } = {}) {
  const source = candidateReplaySource();
  return createAutoEngine({
    nowIso: () => NOW,
    mode: () => mode,
    params: () => params(),
    replaySource: source,
    serviceFor: fakeServiceFor(fakeServiceState(source.rows), log),
    store: store.autoStore,
  });
}

test("auto apply selection（0.5 第三波）：子集执行——只执行勾选项、按 plan 原顺序、未选中不执行不记录；run.selection 落账", async (t) => {
  const store = await withTempState(t);
  const log = [];
  const engine = candidateEngine(store, { mode: "suggest", log });
  const receipt = await engine.apply({
    scopeId: "amber",
    trigger: "manual",
    operationId: "op-sel-1",
    selection: [
      { key: "rest-1", operationKind: "unarchive-topic" },
      { key: "cool-1", operationKind: "archive-topic" },
    ],
  });
  assert.equal(receipt.replay, false);
  assert.equal(receipt.applied, 2);
  assert.equal(receipt.skipped, 0);
  assert.equal(receipt.failed, 0);
  // 顺序保持：执行顺序跟随 plan 原顺序（cool-1 在前、rest-1 在后），不是 selection 给的顺序。
  assert.deepEqual(receipt.ops.map((op) => op.key), ["cool-1", "rest-1"]);
  // 未选中的候选既不执行也不记 ops、不计 skipped。
  assert.equal(receipt.ops.some((op) => op.key === "cool-2"), false, "未选中的 cool-2 不记 ops");
  assert.equal(receipt.ops.some((op) => op.key === "cool-3"), false, "未选中的 cool-3 不记 ops");
  assert.equal(receipt.skipped, 0, "未选中的候选不计 skipped");
  // 服务端只写勾选项（mutate 恰两次，覆盖 cool-1 / rest-1）。
  assert.deepEqual(log.flatMap((call) => call.changes.map((change) => change.key)).sort(), ["cool-1", "rest-1"]);
  // run.selection 落账（归一为 key/operationKind，按调用侧顺序），run.mode 记当前模式。
  const run = await store.autoStore.getRun(receipt.runId);
  assertRunShape(run);
  assert.deepEqual(run.selection, [
    { key: "rest-1", operationKind: "unarchive-topic" },
    { key: "cool-1", operationKind: "archive-topic" },
  ]);
  assert.equal(run.mode, "suggest");
});

test("auto apply selection：candidate-missing——选中但复算后已消失的候选记 skipped，不整单失败", async (t) => {
  const store = await withTempState(t);
  const engine = candidateEngine(store, { mode: "suggest" });
  const receipt = await engine.apply({
    scopeId: "amber",
    trigger: "manual",
    operationId: "op-sel-2",
    selection: [
      { key: "gone", operationKind: "archive-topic" },
      { key: "cool-1", operationKind: "archive-topic" },
    ],
  });
  assert.equal(receipt.applied, 1, "cool-1 正常执行");
  assert.equal(receipt.skipped, 1, "gone 计入 skipped");
  assert.equal(receipt.failed, 0, "缺失候选不整单失败");
  const missing = receipt.ops.find((op) => op.key === "gone");
  assert.ok(missing, "消失候选有条目（不静默吞掉）");
  assert.equal(missing.status, "skipped");
  assert.equal(missing.reason, "candidate-missing");
  assert.equal(missing.operationKind, "archive-topic");
  // 执行条目按 plan 原顺序在前，缺失补记条目在后。
  assert.deepEqual(receipt.ops.map((op) => op.key), ["cool-1", "gone"]);
});

test("auto apply selection：校验——重复 (operationKind,key) INVALID_INPUT（不静默去重）；空数组/非法项/越界长度拒绝", async (t) => {
  const store = await withTempState(t);
  const engine = candidateEngine(store, { mode: "suggest" });
  const applyWith = (selection, operationId) =>
    engine.apply({ scopeId: "amber", trigger: "manual", operationId, selection });
  // 重复 (operationKind,key)：INVALID_INPUT，不静默去重。
  await assert.rejects(
    () => applyWith([
      { key: "cool-1", operationKind: "archive-topic" },
      { key: "cool-1", operationKind: "archive-topic" },
    ], "op-dup"),
    (e) => e.code === "INVALID_INPUT" && /重复/.test(e.message),
  );
  // 空数组 / 非数组 / 空 key / 非法 operationKind：一律 INVALID_INPUT。
  await assert.rejects(() => applyWith([], "op-empty"), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => applyWith("cool-1", "op-str"), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => applyWith([{ key: "", operationKind: "archive-topic" }], "op-empty-key"), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => applyWith([{ key: "cool-1", operationKind: "rewrite" }], "op-bad-kind"), (e) => e.code === "INVALID_INPUT");
  // 201 条越界 → INVALID_INPUT；200 条恰好合法（全为盘上没有的 key → 全部
  // candidate-missing，不失败——长度上限只约束入参形状，不约束命中与否）。
  const build = (count) => Array.from({ length: count }, (_, i) => ({ key: `k-${i}`, operationKind: "archive-topic" }));
  await assert.rejects(() => applyWith(build(201), "op-too-many"), (e) => e.code === "INVALID_INPUT");
  const boundary = await applyWith(build(200), "op-boundary-200");
  assert.equal(boundary.applied, 0);
  assert.equal(boundary.skipped, 200, "200 条为合法上界：全按 candidate-missing 计 skipped");
});

test("auto apply：mode 门槛（0.5 第三波）——off 拒绝（含 selection）；suggest 手动全量执行成功且 run.mode=suggest、run.selection=null", async (t) => {
  const offStore = await withTempState(t);
  const offEngine = candidateEngine(offStore, { mode: "off" });
  await assert.rejects(
    () => offEngine.apply({ scopeId: "amber", trigger: "manual", operationId: "op-off" }),
    (e) => e.code === "INVALID_STATE" && /off/.test(e.message),
  );
  await assert.rejects(
    () => offEngine.apply({
      scopeId: "amber", trigger: "manual", operationId: "op-off-sel",
      selection: [{ key: "cool-1", operationKind: "archive-topic" }],
    }),
    (e) => e.code === "INVALID_STATE",
    "off 对 selection 数组同样拒绝（mode 门槛先于一切执行路径）",
  );

  const store = await withTempState(t);
  const log = [];
  const engine = candidateEngine(store, { mode: "suggest", log });
  const receipt = await engine.apply({ scopeId: "amber", trigger: "manual", operationId: "op-sug-1" });
  assert.equal(receipt.replay, false);
  assert.equal(receipt.applied, 4, "全量执行：三冷一热全部应用");
  assert.deepEqual(receipt.ops.map((op) => op.key), ["cool-3", "cool-2", "cool-1", "rest-1"], "plan 原顺序：最冷优先、恢复在后");
  const run = await store.autoStore.getRun(receipt.runId);
  assert.equal(run.mode, "suggest", "run.mode 记当前模式");
  assert.equal(run.selection, null, "缺省 selection 落账为 null（旧调用语义不变）");
  assert.equal(log.length, 4, "每条候选一次 mutate");
});

test("auto apply：suggest 自动调度仍不执行（onHumanTurn 只评估，绝不触达执行层、不落 run）", async (t) => {
  const store = await withTempState(t);
  const log = [];
  const engine = candidateEngine(store, { mode: "suggest", log });
  await engine.onHumanTurn({ scopeId: "amber" });
  const read = await store.autoStore.read();
  assert.equal((read.state.runs ?? []).length, 0, "suggest 调度不落 run（绝不自动执行）");
  assert.equal(log.length, 0, "suggest 调度不触达 serviceFor（执行层零调用）");
  const anchor = read.state?.scopes?.amber ?? null;
  assert.ok(anchor !== null && typeof anchor.lastEvaluatedAt === "string" && anchor.lastEvaluatedAt.length > 0,
    "评估照常记账锚（suggest 只是不自动执行，不是不评估）");
});

test("auto apply：auto 模式人类轮调度仍自动执行（对照——门槛放开没有误伤调度路径）", async (t) => {
  const store = await withTempState(t);
  const log = [];
  const engine = candidateEngine(store, { mode: "auto", log });
  await engine.onHumanTurn({ scopeId: "amber" });
  const read = await store.autoStore.read();
  assert.equal((read.state.runs ?? []).length, 1, "auto 调度照常落 run");
  assert.ok(log.length >= 1, "auto 调度照常执行候选");
});

test("旧 run 缺 selection 字段可回放：assertRunShape 兼容（缺字段按 null 读），重放链路不报错", async (t) => {
  const store = await withTempState(t);
  // 0.5 第三波之前的 run 形状：没有 selection 字段。
  await store.autoStore.recordRun(dummyRun({ runId: "r-old", operationId: "op-old", trigger: "manual" }));
  const engine = candidateEngine(store, { mode: "suggest" });
  const replayed = await engine.apply({ scopeId: "amber", trigger: "manual", operationId: "op-old" });
  assert.equal(replayed.replay, true, "窗口内命中 → 重放首次结果，不因缺 selection 报错");
  assert.equal(replayed.runId, "r-old");
  const run = await store.autoStore.getRun("r-old");
  assert.doesNotThrow(() => assertRunShape(run), "旧 run（无 selection 字段）通过形状复核");
  // 新形状直测：selection=null / 合法数组放行；非法类型 / 空数组 / 坏条目拒。
  assert.doesNotThrow(() => assertRunShape(dummyRun({ selection: null })));
  assert.doesNotThrow(() => assertRunShape(dummyRun({ selection: [{ key: "k", operationKind: "archive-topic" }] })));
  assert.throws(() => assertRunShape(dummyRun({ selection: 42 })), (e) => e.code === "INVALID_STATE");
  assert.throws(() => assertRunShape(dummyRun({ selection: [] })), (e) => e.code === "INVALID_STATE");
  assert.throws(() => assertRunShape(dummyRun({ selection: [{ key: "k", operationKind: "bogus" }] })), (e) => e.code === "INVALID_STATE");
});
