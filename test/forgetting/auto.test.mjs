// 0.5 批次 5 · A 线：auto 冷却/恢复纯函数层测试（0.5-DEV-PLAN §5 / §11.2 / §4.4）。
//
// 覆盖面（任务书完成判据 ①）：25/50 回差、minCooldownDays / minRestoreGraceDays、
// historical / pinned / manual 护栏、每轮 ≤ maxOpsPerRun、时钟回拨熔断、心跳轮
// 不触发、连组恢复不连坐。纯模块纪律：同一输入两次调用深度相等（JSON 逐字节
// 相同）；本文件不触碰磁盘、不读时钟——全部显式注入。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_ARCHIVE_ORIGIN,
  AUTO_FUSE_CODES,
  AUTO_MODES,
  AUTO_OP_KINDS,
  assertRunShape,
  autoIdentityKey,
  buildUndoOps,
  computeAutoFuse,
  createAutoReplaySource,
  deriveAutoCandidates,
  planAutoOps,
  shouldTriggerAutoEvaluation,
} from "../../src/forgetting/auto.mjs";
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
