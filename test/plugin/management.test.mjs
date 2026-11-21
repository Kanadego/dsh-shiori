// P5 · management + protocol 测试（slot P）：DTO 校验 / P3-P4 门面 / 授权执行 /
// 队列与 plan 持久恢复 / shadow 限制。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createShioriPluginController } from "../../src/plugin/controller.mjs";
import { openSparkStore } from "../../src/sparks/store.mjs";
import { createManagement } from "../../src/plugin/management.mjs";
import { createStateStore } from "../../src/plugin/state.mjs";
import { analyzeForgetting, normalizeForgetPolicy } from "../../src/forgetting/decay.mjs";
import { digestPlan as organizeDigestPlan } from "../../src/organize/executor.mjs";
import {
  MANAGEMENT_METHODS, MANAGEMENT_METHOD_NAMES, validateManagementPayload, MANAGEMENT_ERROR_CODES,
} from "../../src/plugin/protocol.mjs";
import { createGroupManageTool } from "../../src/host/tools.mjs";
import { ensureGroupsFile, readGroups, writeGroups } from "../../src/storage/groups.mjs";

// 默认组模板已收敛成一个「通用」组；组相关用例仍需要 dev/life 这套多组夹具，
// 显式写四组，避免用例被模板变更牵连。
const FOUR_GROUPS = [
  { key: "dev", title: "开发与配置", summary: "DSH / 插件 / 发版 / 沙箱", order: 10 },
  { key: "self", title: "自我与关系", summary: "身份 / 情绪 / 人际边界", order: 20 },
  { key: "project", title: "项目与工具", summary: "在跟的项目 / 常用工具与流程", order: 30 },
  { key: "life", title: "生活与偏好", summary: "作息 / 口味 / 日常安排", order: 40 },
];
const seedGroups = async (root) =>
  writeGroups({ dataRoot: root, scopeId: "amber", groups: FOUR_GROUPS, expectedRevision: null });

function fakeBindingsFactory() {
  const registered = { preStep: null, sessionEvents: null, waterfall: null, sections: [], tools: [] };
  const factory = () => ({
    registerSystemSection() { return true; },
    registerAssembleWaterfall(h) { registered.waterfall = h; return true; },
    registerPreStep(h) { registered.preStep = h; return true; },
    subscribeSessionEvents(l) { registered.sessionEvents = l; return true; },
    async registerTool() { return true; },
    async loadCreateUserMessage() { return (i) => ({ id: "m", role: "user", content: i.content, source: i.source }); },
    disposeAll() { return { disposed: true, errors: [] }; },
    get diagnostics() { return { registeredSections: [], registeredTools: [], waterfall: true, preStep: true, sessionEvents: true }; },
  });
  factory.registered = registered;
  return factory;
}

function fakeCtx() {
  return { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} };
}

async function setup(t) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-mgmt-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    organize: { enabled: true },
    forgetting: { enabled: true },
  }, { bindings });
  await controller.start();
  return { controller, base, trusted: { session: { id: "s-panel" }, source: "panel-rpc" } };
}

// ── protocol（纯 JSON 层）────────────────────────────────────

test("protocol：11 个方法全覆盖（10 + destroyData，0.4 S6）；闭包拒绝未知键；queueRevision/planDigest/operationId 规则", () => {
  assert.deepEqual([...MANAGEMENT_METHOD_NAMES].sort(), [
    "analyze", "destroyData", "executePlan", "executeTool", "getGraph", "getMemoryView",
    "getStatus", "getTimeline", "listCandidates", "previewPlan", "reviewCandidate",
  ].sort());
  for (const name of MANAGEMENT_METHOD_NAMES) {
    assert.ok(MANAGEMENT_METHODS[name].inputSchema);
    assert.ok(MANAGEMENT_METHODS[name].outputSchema);
  }
  assert.throws(() => validateManagementPayload("getStatus", { rogue: 1 }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("analyze", { kind: "organize" }), (e) => e.code === "INVALID_INPUT"); // 缺 operationId
  assert.throws(
    () => validateManagementPayload("analyze", { kind: "organize", operationId: "a1", expectedQueueRevision: -1 }),
    (e) => e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => validateManagementPayload("reviewCandidate", { candidateId: "xyz", decision: "reviewed", expectedQueueRevision: 0, operationId: "a1" }),
    (e) => e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => validateManagementPayload("executePlan", { planId: "p", planDigest: "ABC", operationId: "a1", confirmed: true }),
    (e) => e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => validateManagementPayload("executePlan", { planId: "p", planDigest: "a".repeat(64), operationId: "a1", confirmed: false }),
    (e) => e.code === "INVALID_INPUT",
  );
  // 0.2.3 守卫：协议层 previewPlan 收到 thin-core proposal → 拒收
  // （thin-core 已整块裁撤，oneOf 不再有该分支，任意形状都进不了协议面）。
  for (const proposal of [
    { kind: "thin-core", before: "x", after: "y" },
    { kind: "thin-core" },
    { kind: "thin-core", before: 1, after: "y", extra: 1 },
  ]) {
    assert.throws(
      () => validateManagementPayload("previewPlan", {
        kind: "organize", candidateId: "a".repeat(64), expectedQueueRevision: 0, operationId: "a1",
        proposal,
      }),
      (e) => e.code === "INVALID_INPUT",
      `thin-core proposal 应被 wire 层拒绝：${JSON.stringify(proposal)}`,
    );
  }
  // Error code 词表冻结。
  assert.deepEqual([...MANAGEMENT_ERROR_CODES].sort(), [
    "BUDGET_EXCEEDED", "INVALID_INPUT", "NOT_CONFIGURED", "NOT_FOUND",
    "REVISION_CONFLICT", "UNAUTHORIZED", "UNSUPPORTED",
  ]);
});

// ── P3 organize 门面 ─────────────────────────────────────────

test("organize 全链：analyze 入队（持久）→ review → previewPlan（buildDraft digest）→ executePlan（授权执行）", async (t) => {
  const { controller, trusted, base } = await setup(t);
  // 铺 9 张同实体卡，触发 cluster 候选（>=8 源）。
  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: {
        title: `卡${i}`, content: `共同实体内容 ${i}。`, triggers: [`词${i}`],
        entities: ["共现实体"], vitality: "evergreen",
      },
    });
  }
  const listed = await controller.management.listCandidates(trusted, {});
  assert.equal(listed.queueRevision, 0);
  assert.deepEqual(listed.items, []);

  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "an-1" });
  assert.equal(analyzed.analysis.kind, "organize");
  assert.equal(analyzed.analysis.candidates > 0, true);
  assert.equal(analyzed.items.length, analyzed.analysis.candidates);
  const queueRevision = analyzed.queueRevision;
  assert.ok(Number.isInteger(queueRevision) && queueRevision > 0);

  // analyze 幂等：同 operationId 重放不重复入队。
  const analyzed2 = await controller.management.analyze(trusted, { kind: "organize", operationId: "an-1" });
  assert.equal(analyzed2.items.length, analyzed.items.length);

  const candidate = analyzed.items[0].candidate;
  const reviewed = await controller.management.reviewCandidate(trusted, {
    candidateId: candidate.id, decision: "reviewed", expectedQueueRevision: queueRevision, operationId: "rv-1",
  });
  assert.equal(reviewed.queueRevision, queueRevision + 1);

  // previewPlan：organize proposal 严格 buildDraft（link 形状）。
  const proposal = {
    kind: "link",
    links: [{ id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id, rel: "相关" }] }],
  };
  const preview = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: candidate.id, proposal, expectedQueueRevision: reviewed.queueRevision, operationId: "pv-1",
  });
  assert.equal(preview.kind, "organize");
  assert.equal(preview.proposalKind, "link");
  assert.match(preview.planDigest, /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(preview.diff) && preview.diff.length > 0);

  // executePlan：confirmed + digest 绑定 + 授权执行。
  const executed = await controller.management.executePlan(trusted, {
    planId: preview.planId, planDigest: preview.planDigest, operationId: "ex-1", confirmed: true,
  });
  assert.equal(executed.planId, preview.planId);
  assert.equal(executed.result.status, "completed");
  assert.equal(executed.result.kind, "link");

  // digest 不符 → REVISION_CONFLICT（批准必须绑定内容）。
  await assert.rejects(
    () => controller.management.executePlan(trusted, {
      planId: preview.planId, planDigest: "f".repeat(64), operationId: "ex-2", confirmed: true,
    }),
    (e) => e.code === "REVISION_CONFLICT",
  );

  // 持久恢复：先停第一代（释放完成状态独占锁），新 controller 同 roots → 队列与 plan 账还在。
  await controller.stop();
  const bindings2 = fakeBindingsFactory();
  const controller2 = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    organize: { enabled: true }, forgetting: { enabled: true },
  }, { bindings: bindings2 });
  await controller2.start();
  const restored = await controller2.management.listCandidates(trusted, {});
  // P-A 收敛新语义：executePlan 成功后把本次执行的候选从队列移除（queueRevision
  // 前进 1），已执行候选不再画成可审阅条目；plan 账保留 executed 审计。
  assert.equal(restored.queueRevision, reviewed.queueRevision + 1);
  assert.ok(
    !restored.items.some((it) => it.candidate.id === candidate.id),
    "executed candidate must be removed from the queue",
  );
  assert.ok(restored.plans.some((p) => p.planId === preview.planId && p.executed === true));
  await controller2.stop();
});

test("organize：merge-topic 计划仅更新已有 topic（目标缺失明确报错）", async (t) => {
  const { controller, trusted } = await setup(t);
  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: { title: `M${i}`, content: `实体聚合 ${i}。`, triggers: [`m${i}`], entities: ["聚合实体"], vitality: "ephemeral" },
    });
  }
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "an-m" });
  const cluster = analyzed.items.find((it) => it.candidate.kind === "cluster");
  assert.ok(cluster, "expected a cluster candidate from 9 same-entity cards");
  // 先创建目标 topic（P3 merge 仅更新已有 topic），并取真实 revision token。
  await controller.management.executeTool(trusted, {
    name: "topic_create", args: { topic: "merge-target", title: "Merge Target", summary: "target" },
  });
  const topicView = await controller.management.executeTool(trusted, {
    name: "memory_read", args: { topic: "merge-target" },
  });
  const preview = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: cluster.candidate.id,
    proposal: {
      kind: "merge-topic",
      topic: {
        key: "merge-target", expectedRevision: topicView.revision,
        before: topicView.content, after: "## merged\n\ncontent", title: "Merge Target", summary: "target",
        updated: "2026-10-25T00:00:00.000Z",
      },
    },
    expectedQueueRevision: analyzed.queueRevision, operationId: "pv-m",
  });
  assert.equal(preview.kind, "organize");
  assert.equal(preview.proposalKind, "merge-topic");
  const executed = await controller.management.executePlan(trusted, {
    planId: preview.planId, planDigest: preview.planDigest, operationId: "ex-m", confirmed: true,
  });
  assert.equal(executed.result.kind, "merge-topic");
  assert.equal(executed.result.status, "completed");
  await controller.stop();
});

// ── 0.2.3：thin-core 全链用例已随整块裁撤删除（协议层拒收守卫见文件头部
// validateManagementPayload 测试；执行器侧拒收见 test/organize/executor.test.mjs）──

test("listCandidates：候选过期时透传条目 stale 与全量 staleCount（分页不受影响）", async (t) => {
  const { controller, trusted } = await setup(t);
  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: {
        title: `S卡${i}`, content: `共同实体内容 ${i}。`, triggers: [`s词${i}`],
        entities: ["stale实体"], vitality: "evergreen",
      },
    });
  }
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "st-an" });
  assert.ok(analyzed.items.length > 0, "organize analyze must yield candidates");

  // 全新队列：全部新鲜
  const fresh = await controller.management.listCandidates(trusted, {});
  assert.equal(fresh.staleCount, 0);
  for (const item of fresh.items) assert.equal(item.stale, false);

  // 推进其中一张源卡的 revision（spark_update）→ 引用它的候选全部过期
  const bumped = analyzed.items[0].candidate.sources[0].id;
  await controller.management.executeTool(trusted, {
    name: "spark_update",
    args: { id: bumped, patch: { content: "被更新过的内容，revision 已前进。" } },
  });

  const listed = await controller.management.listCandidates(trusted, {});
  assert.equal(listed.total, analyzed.items.length, "列表未分页时条目数应等于全量");
  for (const item of listed.items) {
    const refsBumped = item.candidate.sources.some((s) => s.id === bumped);
    assert.equal(item.stale, refsBumped, "item.stale 应精确等于『引用了被推进的卡』");
  }
  assert.equal(listed.staleCount, listed.items.filter((it) => it.stale).length);

  // 分页：staleCount 仍是分页前全量口径，不随 limit/offset 缩水
  const paged = await controller.management.listCandidates(trusted, { limit: 1, offset: 0 });
  assert.equal(paged.items.length, 1);
  assert.equal(paged.total, listed.total);
  assert.equal(paged.staleCount, listed.staleCount);
  await controller.stop();
});

// ── P4 forgetting 门面 ───────────────────────────────────────

/** 注入未来时钟的 setup：新卡在 controller 时间观里已 90 天。 */
async function setupWithFutureClock(t) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-fg-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const future = new Date(Date.now() + 90 * 24 * 3600 * 1000);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    organize: { enabled: true },
    forgetting: { enabled: true },
  }, { bindings, now: () => future });
  await controller.start();
  return { controller, base, trusted: { session: { id: "s-panel" }, source: "panel-rpc" } };
}

test("forgetting 全链：90 天 ephemeral 入选（默认 30/240/.25、>=60 天）→ previewPlan → executePlan 归档；常青免疫", async (t) => {
  const { controller, trusted } = await setupWithFutureClock(t);
  const savedEphemeral = await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "旧临时", content: "临时 workaround。", triggers: ["旧临时词"], vitality: "ephemeral" },
  });
  const savedEvergreen = await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "常青梗", content: "永远有效。", triggers: ["常青词"], vitality: "evergreen" },
  });

  const analyzed = await controller.management.analyze(trusted, { kind: "forgetting", operationId: "fg-1" });
  assert.equal(analyzed.analysis.kind, "forgetting");
  assert.equal(analyzed.analysis.candidates, 1); // 仅 ephemeral 旧卡
  assert.deepEqual(analyzed.analysis.policy, { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });
  assert.equal(analyzed.plans.length, 1);
  const planSummary = analyzed.plans[0];
  assert.equal(planSummary.kind, "forgetting");

  const preview = await controller.management.previewPlan(trusted, { kind: "forgetting", planId: planSummary.planId });
  assert.equal(preview.planDigest, planSummary.planDigest);
  assert.equal(preview.changedItems, 1);
  // forgetting 预览不带 proposalKind（可选字段，缺省即 undefined）。
  assert.equal(preview.proposalKind, undefined);

  const executed = await controller.management.executePlan(trusted, {
    planId: preview.planId, planDigest: preview.planDigest, operationId: "fg-ex-1", confirmed: true,
  });
  assert.ok(executed.result);

  // 归档生效：ephemeral 已 archived；常青仍 active（免疫）。冷搜显式可见。
  const cold = await controller.management.executeTool(trusted, {
    name: "memory_search", args: { query: "临时", includeArchived: true },
  });
  assert.ok(cold.matches.some((m) => m.key === savedEphemeral.id && m.state === "archived"));
  const readEvergreen = await controller.management.executeTool(trusted, {
    name: "spark_read", args: { id: savedEvergreen.id },
  });
  assert.equal(readEvergreen.state, "active");
  const readArchived = await controller.management.executeTool(trusted, {
    name: "spark_read", args: { id: savedEphemeral.id },
  });
  assert.equal(readArchived.state, "archived");

  // 同 planId 重复执行：M1 plan 一次性——已执行计划拒绝重跑（含同 operationId）。
  await assert.rejects(
    () => controller.management.executePlan(trusted, {
      planId: preview.planId, planDigest: preview.planDigest, operationId: "fg-ex-1", confirmed: true,
    }),
    (e) => e.code === "REVISION_CONFLICT" && /already executed/.test(e.message),
  );
  await controller.stop();
});

test("模块开关：organize/forgetting disabled → analyze UNSUPPORTED；冷搜不受开关影响", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-mgmt2-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    organize: { enabled: false }, forgetting: { enabled: false },
  }, { bindings });
  await controller.start();
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };
  await assert.rejects(
    () => controller.management.analyze(trusted, { kind: "organize", operationId: "x" }),
    (e) => e.code === "UNSUPPORTED",
  );
  await assert.rejects(
    () => controller.management.analyze(trusted, { kind: "forgetting", operationId: "x" }),
    (e) => e.code === "UNSUPPORTED",
  );
  // 冷搜（includeArchived）始终只读可用。
  const cold = await controller.management.executeTool(trusted, {
    name: "memory_search", args: { query: "anything", includeArchived: true },
  });
  assert.deepEqual(cold.matches, []);
  await controller.stop();
});

// ─────────────────────────────────────────────────────────────
// a3 返工回归（B-abort / M4-drain）
// ─────────────────────────────────────────────────────────────

/** 组织 link 计划全链：9 张同实体卡 → analyze → review → previewPlan。 */
async function buildLinkPlan(controller, trusted, opPrefix) {
  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: {
        title: `卡${i}`, content: `共同实体内容 ${i}。`, triggers: [`词${i}`],
        entities: ["共现实体"], vitality: "evergreen",
      },
    });
  }
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: `${opPrefix}-an` });
  assert.ok(analyzed.items.length > 0, "organize analyze must yield candidates");
  const candidate = analyzed.items[0].candidate;
  const reviewed = await controller.management.reviewCandidate(trusted, {
    candidateId: candidate.id, decision: "reviewed",
    expectedQueueRevision: analyzed.queueRevision, operationId: `${opPrefix}-rv`,
  });
  const proposal = {
    kind: "link",
    links: [{ id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id, rel: "相关" }] }],
  };
  const preview = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: candidate.id, proposal,
    expectedQueueRevision: reviewed.queueRevision, operationId: `${opPrefix}-pv`,
  });
  return { preview };
}

test("B-abort 调用前已 abort 的 signal：executePlan 拒绝 AUTHORIZATION_REQUIRED，plan 未落账且仍可正常执行", async (t) => {
  const { controller, trusted } = await setup(t);
  const { preview } = await buildLinkPlan(controller, trusted, "ab");

  // signal 在调用发起前已 abort——a2 的取消空洞：注册监听永不触发 → 完整执行。
  // 修复后：registerGrant 入口发现已 abort 即撤销 → 注册后核验当场拒绝。
  const ac = new AbortController();
  ac.abort();
  const abortedContext = { ...trusted, signal: ac.signal };
  await assert.rejects(
    () => controller.management.executePlan(abortedContext, {
      planId: preview.planId, planDigest: preview.planDigest, operationId: "ab-ex", confirmed: true,
    }),
    (e) => e.code === "AUTHORIZATION_REQUIRED" && /cancelled before execution/.test(e.message),
  );

  // plan 未被标记执行：同 aborted signal 重试仍是授权拒绝（非 REVISION_CONFLICT「已执行」）。
  await assert.rejects(
    () => controller.management.executePlan(abortedContext, {
      planId: preview.planId, planDigest: preview.planDigest, operationId: "ab-ex", confirmed: true,
    }),
    (e) => e.code === "AUTHORIZATION_REQUIRED",
  );

  // 换有效 signal 重试同 plan 同 operationId：正常执行完成（plan 未被烧掉）。
  const executed = await controller.management.executePlan(
    { ...trusted, signal: new AbortController().signal },
    { planId: preview.planId, planDigest: preview.planDigest, operationId: "ab-ex", confirmed: true },
  );
  assert.equal(executed.result.status, "completed");
  await controller.stop();
});

test("B-abort 执行中途 abort：调用被拒且 plan 未落账（账本 executed=false），同 operationId 重放可收尾", async (t) => {
  const { controller, trusted } = await setup(t);
  const { preview } = await buildLinkPlan(controller, trusted, "mid");

  const ac = new AbortController();
  const pending = controller.management.executePlan(
    { ...trusted, signal: ac.signal },
    { planId: preview.planId, planDigest: preview.planDigest, operationId: "mid-ex", confirmed: true },
  ).then(
    () => ({ outcome: "resolved" }),
    (e) => ({ outcome: "rejected", code: e?.code }),
  );
  setTimeout(() => ac.abort(), 0); // 授权注册后、执行收尾前的中途窗口
  const outcome = await pending;
  // 取消必须导致拒绝：executor 授权检查 APPROVAL_REQUIRED（organize），
  // 或取消落在 markExecuted 前核验窗口 AUTHORIZATION_REQUIRED——两者都不落账。
  assert.equal(outcome.outcome, "rejected");
  assert.ok(
    outcome.code === "APPROVAL_REQUIRED" || outcome.code === "AUTHORIZATION_REQUIRED",
    `unexpected outcome code ${outcome.code}`,
  );

  // 账本：plan 未被标记执行。
  const listed = await controller.management.listCandidates(trusted, {});
  const planEntry = listed.plans.find((p) => p.planId === preview.planId);
  assert.ok(planEntry, "plan must exist in ledger");
  assert.notEqual(planEntry.executed, true);

  // 同 operationId 重试（底层阶段幂等重放）可正常收尾。
  const executed = await controller.management.executePlan(
    { ...trusted, signal: new AbortController().signal },
    { planId: preview.planId, planDigest: preview.planDigest, operationId: "mid-ex", confirmed: true },
  );
  assert.equal(executed.result.status, "completed");
  await controller.stop();
});

test("M4-drain 在途 analyze + stop：stop 排空等它收场（带上限），RPC 正常完成不撞已关闭 store", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-mgmt3-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };
  let slowListActive = false;
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    organize: { enabled: true }, forgetting: { enabled: true },
  }, {
    bindings,
    // 注入 listActive 延迟（审查 M4 repro 同款）：在途 RPC 可观测拉长。
    createSparkStore: async (args) => {
      const store = await openSparkStore(args);
      return new Proxy(store, {
        get(target, prop) {
          if (prop === "listActive" && slowListActive) {
            return async (...callArgs) => {
              await new Promise((r) => setTimeout(r, 300));
              return target.listActive(...callArgs);
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  await controller.start();
  for (let i = 0; i < 2; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: { title: `M4卡${i}`, content: `内容 ${i}。`, triggers: [`m4${i}`], vitality: "evergreen" },
    });
  }

  slowListActive = true;
  const t0 = Date.now();
  const pending = controller.management.analyze(trusted, { kind: "organize", operationId: "an-m4" }).then(
    (value) => ({ outcome: "resolved", candidates: value.analysis.candidates }),
    (e) => ({ outcome: "rejected", code: e?.code, message: e?.message }),
  );
  await new Promise((r) => setTimeout(r, 80)); // RPC 在途
  const stopResult = await controller.stop();
  const drainedMs = Date.now() - t0 - 80;

  // stop 等到在途 analyze 收场（>200ms 的注入延迟被吸收），且无未收场上报。
  assert.equal(stopResult.stopped, true);
  assert.deepEqual(stopResult.errors, []);
  assert.ok(drainedMs >= 150, `stop must drain in-flight RPC, only waited ${drainedMs}ms`);
  // RPC 正常完成（a2 事实：store 先关、RPC 后到 → INVALID_STATE）。
  const rpc = await pending;
  assert.equal(rpc.outcome, "resolved");
  await controller.stop(); // 幂等
});

// ─────────────────────────────────────────────────────────────
// a4 回归（P-A 队列收敛 / P-B forgetting diff）
// ─────────────────────────────────────────────────────────────

test("P-B forgetting 预览 diff 非空：包含全部待归档卡（spark:<id>），state active→archived、revision +1", async (t) => {
  const { controller, trusted } = await setupWithFutureClock(t);
  const savedA = await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "旧临A", content: "临时 A。", triggers: ["a词"], vitality: "ephemeral" },
  });
  const savedB = await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "旧临B", content: "临时 B。", triggers: ["b词"], vitality: "ephemeral" },
  });
  const analyzed = await controller.management.analyze(trusted, { kind: "forgetting", operationId: "pbdiff-1" });
  assert.equal(analyzed.analysis.candidates, 2);
  const planSummary = analyzed.plans.find((p) => p.kind === "forgetting" && p.executed === false);
  assert.ok(planSummary, "forgetting plan must be saved");
  assert.equal(planSummary.changedItems, 2);

  const preview = await controller.management.previewPlan(trusted, {
    kind: "forgetting", planId: planSummary.planId,
  });
  // diff 覆盖全部待归档卡，形状与 organize 同类。
  assert.equal(preview.diff.length, 2);
  const paths = preview.diff.map((d) => d.path).sort();
  assert.deepEqual(paths, [`spark:${savedA.id}`, `spark:${savedB.id}`].sort());
  for (const entry of preview.diff) {
    assert.match(entry.path, /^spark:spk-[0-9a-f]+$/);
    const before = JSON.parse(entry.oldText);
    const after = JSON.parse(entry.newText);
    assert.equal(before.state, "active");
    assert.equal(after.state, "archived");
    assert.equal(after.revision, before.revision + 1);
    assert.equal(before.id, entry.path.slice("spark:".length));
  }
  await controller.stop();
});

test("P-A 队列收敛：执行（link+forgetting）后 re-analyze 清失效候选、reviewed 保留、plan 收敛、同 operationId 重放不二次收敛", async (t) => {
  // 专用夹具：时钟随每次调用推进 1 小时（forgetting plan.now 漂移 → 不同
  // digest → 不同 planId，模拟真机重复 analyze 产生多条 open 计划的场景）。
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-paconv-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const futureMs = Date.now() + 90 * 24 * 3600 * 1000;
  let tick = 0;
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    organize: { enabled: true },
    forgetting: { enabled: true },
  }, { bindings, now: () => new Date(futureMs + (tick++) * 3600 * 1000) });
  await controller.start();
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };

  // 9 张同实体卡（cluster/link 候选）+ 1 张旧 ephemeral 卡（forgetting 归档）。
  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: {
        title: `卡${i}`, content: `共同实体内容 ${i}。`, triggers: [`词${i}`],
        entities: ["共现实体"], vitality: "evergreen",
      },
    });
  }
  const savedEphemeral = await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "旧临时", content: "临时。", triggers: ["旧词"], vitality: "ephemeral" },
  });

  // 1) 首轮 analyze（rev 0→1）+ review 首个候选；另选一条「源卡不会被本次
  //    link 执行波及」的 link 候选一并 review，供第 4 步验证 reviewed 保留
  //    （被执行的那个候选已不在队列，不能再拿它验）。
  const first = await controller.management.analyze(trusted, { kind: "organize", operationId: "pa-an-1" });
  const reviewedId = first.items[0].candidate.id;
  const reviewedAfterReview = await controller.management.reviewCandidate(trusted, {
    candidateId: reviewedId, decision: "reviewed",
    expectedQueueRevision: first.queueRevision, operationId: "pa-rv-1",
  });
  assert.equal(reviewedAfterReview.queueRevision, first.queueRevision + 1);
  const candidate = first.items[0].candidate;
  const touchedIds = new Set([candidate.sources[0].id, candidate.sources[1].id]);
  const retained = first.items.find((it) =>
    it.candidate.id !== reviewedId
    && it.candidate.kind === "link"
    && it.candidate.sources.every((s) => !touchedIds.has(s.id)));
  assert.ok(retained, "fixture must contain a link candidate untouched by the link plan");
  const retainedReviewedId = retained.candidate.id;
  const retainedAfterReview = await controller.management.reviewCandidate(trusted, {
    candidateId: retainedReviewedId, decision: "reviewed",
    expectedQueueRevision: reviewedAfterReview.queueRevision, operationId: "pa-rv-1b",
  });
  assert.equal(retainedAfterReview.queueRevision, reviewedAfterReview.queueRevision + 1);

  // 2) link 计划执行：源卡保持 active，但本次执行的候选（plan.candidateId 指向
  //    的那条）被从队列收敛移除、queueRevision 前进 1——面板 load() 一刷新就
  //    拿不到旧候选，用户不会再点到一个注定 REVISION_CONFLICT 的按钮。
  const proposal = {
    kind: "link",
    links: [{ id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id, rel: "相关" }] }],
  };
  const previewLink = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: candidate.id, proposal,
    expectedQueueRevision: retainedAfterReview.queueRevision, operationId: "pa-pv-1",
  });
  const executedLink = await controller.management.executePlan(trusted, {
    planId: previewLink.planId, planDigest: previewLink.planDigest,
    operationId: "pa-ex-1", confirmed: true,
  });
  assert.equal(executedLink.result.status, "completed");
  const afterExec = await controller.management.listCandidates(trusted, {});
  assert.equal(afterExec.queueRevision, retainedAfterReview.queueRevision + 1);
  assert.ok(
    !afterExec.items.some((it) => it.candidate.id === candidate.id),
    "executed candidate must be removed from the queue right after executePlan",
  );

  // 3) forgetting analyze 两次：第二次应作废第一次的 open 计划（收敛到 1 open），
  //    然后执行归档（1 张卡 archived → 队列中引用它的候选失效）。
  await controller.management.analyze(trusted, { kind: "forgetting", operationId: "pa-fg-1" });
  const fg2 = await controller.management.analyze(trusted, { kind: "forgetting", operationId: "pa-fg-2" });
  const openFg = fg2.plans.filter((p) => p.kind === "forgetting" && p.executed === false && p.superseded !== true);
  assert.equal(openFg.length, 1, "repeated forgetting analyze must converge to a single open plan");
  const supersededFg = fg2.plans.find((p) => p.superseded === true);
  assert.ok(supersededFg, "superseded plan must be marked superseded:true");
  const fgExec = await controller.management.executePlan(trusted, {
    planId: openFg[0].planId, planDigest: openFg[0].planDigest,
    operationId: "pa-ex-2", confirmed: true,
  });
  assert.ok(fgExec.result);

  // 4) re-analyze organize：以本次分析为准收敛——
  //    - items 恰等于新分析结果（无失效候选：无任何 item 引用已归档卡）；
  //    - 仍存在的候选保留 reviewed status（不退回 pending）。被执行的候选
  //      （reviewedId）已由 executePlan 收敛移除，reviewed 保留改用源卡未被
  //      执行波及的另一条候选（retainedReviewedId）验证。
  const second = await controller.management.analyze(trusted, { kind: "organize", operationId: "pa-an-2" });
  assert.equal(second.items.length, second.analysis.candidates);
  for (const item of second.items) {
    const refsArchived = item.candidate.sources.some((s) => s.id === savedEphemeral.id);
    assert.equal(refsArchived, false, "no candidate may reference the archived card");
  }
  assert.ok(
    !second.items.some((it) => it.candidate.id === reviewedId),
    "executed candidate must not reappear after re-analyze",
  );
  const keptReviewed = second.items.find((it) => it.candidate.id === retainedReviewedId);
  assert.ok(keptReviewed !== undefined, "reviewed candidate with untouched sources must survive re-analyze");
  assert.equal(keptReviewed.status, "reviewed");

  // 5) 计划收敛：无仍 open 的计划；已执行计划保留审计。
  const listed = await controller.management.listCandidates(trusted, {});
  assert.equal(listed.plans.filter((p) => p.executed === false && p.superseded !== true).length, 0);
  assert.ok(listed.plans.some((p) => p.planId === previewLink.planId && p.executed === true),
    "executed plans must be kept for audit");

  // 6) 同 operationId 重放：analyze 返回首次结果，队列与 plans 不再变化。
  const beforeReplay = await controller.management.listCandidates(trusted, {});
  const replay = await controller.management.analyze(trusted, { kind: "organize", operationId: "pa-an-2" });
  assert.deepEqual(replay.analysis, second.analysis);
  assert.equal(replay.queueRevision, beforeReplay.queueRevision);
  assert.deepEqual(replay.items, beforeReplay.items);
  assert.deepEqual(replay.plans, beforeReplay.plans);
  const fgReplay = await controller.management.analyze(trusted, { kind: "forgetting", operationId: "pa-fg-2" });
  assert.deepEqual(fgReplay.analysis, fg2.analysis);
  assert.equal(fgReplay.plans.filter((p) => p.executed === false && p.superseded !== true).length, 0);

  await controller.stop();
});

test("P-A 用户路径：执行后旧候选 previewPlan 报 NOT_FOUND（非 REVISION_CONFLICT），重新 analyze 后新候选 revision 最新、preview 成功", async (t) => {
  const { controller, trusted } = await setup(t);
  // 3 张同实体卡 → analyze 产出 link pair 候选（两卡间无既有边）。
  for (let i = 0; i < 3; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: {
        title: `卡${i}`, content: `同实体内容 ${i}。`, triggers: [`词${i}`],
        entities: ["同实体"], vitality: "evergreen",
      },
    });
  }
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "up-an-1" });
  const linkItem = analyzed.items.find((it) => it.candidate.kind === "link");
  assert.ok(linkItem, "expected a link pair candidate");
  const oldCandidate = linkItem.candidate;
  // 全部候选的源卡 revision 基线（isolated 候选覆盖每张卡）。
  const oldRevisions = new Map();
  for (const it of analyzed.items) {
    for (const s of it.candidate.sources) {
      if (!oldRevisions.has(s.id)) oldRevisions.set(s.id, s.revision);
    }
  }

  const proposal = {
    kind: "link",
    links: [{ id: oldCandidate.sources[0].id, after: [{ target: oldCandidate.sources[1].id, rel: "相关" }] }],
  };
  const preview = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: oldCandidate.id, proposal,
    expectedQueueRevision: analyzed.queueRevision, operationId: "up-pv-1",
  });
  const executed = await controller.management.executePlan(trusted, {
    planId: preview.planId, planDigest: preview.planDigest, operationId: "up-ex-1", confirmed: true,
  });
  assert.equal(executed.result.status, "completed");

  // 执行后：该候选已不在队列、queueRevision 前进 1。
  const afterExec = await controller.management.listCandidates(trusted, {});
  assert.equal(afterExec.queueRevision, analyzed.queueRevision + 1);
  assert.ok(
    !afterExec.items.some((it) => it.candidate.id === oldCandidate.id),
    "executed candidate must be gone from the queue",
  );

  // 用户拿旧候选再点预览：NOT_FOUND（不是 REVISION_CONFLICT）——候选已被
  // 收敛移除，客户端按「刷新队列」处理，而不是误判为并发冲突。
  await assert.rejects(
    () => controller.management.previewPlan(trusted, {
      kind: "organize", candidateId: oldCandidate.id, proposal,
      expectedQueueRevision: afterExec.queueRevision, operationId: "up-pv-2",
    }),
    (e) => e.code === "NOT_FOUND",
  );

  // 重新 analyze：新候选的 sources[].revision 绑定卡片最新 revision
  // （被执行 link 的源卡 revision +1，其余不变），previewPlan 成功。
  const reanalyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "up-an-2" });
  const modifiedId = oldCandidate.sources[0].id; // 被 link 执行写入的源卡
  const newItem = reanalyzed.items.find((it) =>
    it.candidate.kind === "link"
    && it.candidate.sources.some((s) => s.id === modifiedId));
  assert.ok(newItem, "expected a fresh link candidate bound to latest revisions");
  for (const ref of newItem.candidate.sources) {
    const expected = ref.id === modifiedId
      ? oldRevisions.get(ref.id) + 1
      : oldRevisions.get(ref.id);
    assert.equal(ref.revision, expected, `candidate source "${ref.id}" must bind the latest card revision`);
  }
  const newPreview = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: newItem.candidate.id,
    proposal: {
      kind: "link",
      links: [{
        id: newItem.candidate.sources[0].id,
        after: [{ target: newItem.candidate.sources[1].id, rel: "相关" }],
      }],
    },
    expectedQueueRevision: reanalyzed.queueRevision, operationId: "up-pv-3",
  });
  assert.match(newPreview.planDigest, /^[a-f0-9]{64}$/);
  assert.ok(newPreview.diff.length > 0);
  await controller.stop();
});

test("P-A previewPlan 收敛：新预览作废旧 open organize 计划；被作废计划执行被服务端硬闸拒绝", async (t) => {
  const { controller, trusted } = await setup(t);
  const { preview } = await buildLinkPlan(controller, trusted, "pv");
  // 第二次预览（不同 proposal → 不同 digest → 新计划；旧 open 计划应被作废）。
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "pv-an" });
  const candidate = analyzed.items[0].candidate;
  const proposal2 = {
    kind: "link",
    links: [
      { id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id, rel: "相关" }] },
      { id: candidate.sources[1].id, after: [{ target: candidate.sources[2].id, rel: "相关" }] },
    ],
  };
  const preview2 = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: candidate.id, proposal: proposal2,
    expectedQueueRevision: analyzed.queueRevision, operationId: "pv-pv-2",
  });
  const listed = await controller.management.listCandidates(trusted, {});
  const openPlans = listed.plans.filter((p) => p.kind === "organize" && p.executed === false && p.superseded !== true);
  assert.equal(openPlans.length, 1);
  assert.equal(openPlans[0].planId, preview2.planId);
  assert.ok(listed.plans.some((p) => p.planId === preview.planId && p.superseded === true),
    "earlier open plan must be superseded");

  // 被作废计划执行 → 服务端 REVISION_CONFLICT（不依赖客户端禁用按钮）。
  await assert.rejects(
    () => controller.management.executePlan(trusted, {
      planId: preview.planId, planDigest: preview.planDigest, operationId: "pv-ex-old", confirmed: true,
    }),
    (e) => e.code === "REVISION_CONFLICT" && /superseded/.test(e.message),
  );
  await controller.stop();
});

// ─────────────────────────────────────────────────────────────
// a5 回归（P-A 残留收紧）
// ─────────────────────────────────────────────────────────────

test("P-A 残留：陈旧 expectedQueueRevision 的 REVISION_CONFLICT 不毒化 operationId——同 operationId 修正后重试成功收敛", async (t) => {
  const { controller, trusted } = await setup(t);
  for (let i = 0; i < 3; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: { title: `卡${i}`, content: `内容 ${i}。`, triggers: [`词${i}`], vitality: "evergreen" },
    });
  }
  const first = await controller.management.analyze(trusted, { kind: "organize", operationId: "cas-an-1" });
  assert.equal(first.queueRevision, 1);

  // 陈旧 revision（期望 0，当前 1）→ REVISION_CONFLICT。journal 未写（CAS 先于
  // journal）：同 operationId 不被毒化。
  await assert.rejects(
    () => controller.management.analyze(trusted, { kind: "organize", operationId: "cas-an-2", expectedQueueRevision: 0 }),
    (e) => e.code === "REVISION_CONFLICT",
  );
  // 同 operationId 修正 revision 后重试 → 真正收敛（不是"返回成功但队列没变"）。
  const retry = await controller.management.analyze(trusted, { kind: "organize", operationId: "cas-an-2" });
  assert.equal(retry.queueRevision, 2);
  assert.equal(retry.items.length, retry.analysis.candidates);
  const listed = await controller.management.listCandidates(trusted, {});
  assert.equal(listed.queueRevision, 2);
  // 同 operationId 重放 → journal 命中，返回首次结果，revision 不再前进。
  const replay = await controller.management.analyze(trusted, { kind: "organize", operationId: "cas-an-2" });
  assert.deepEqual(replay.analysis, retry.analysis);
  assert.equal(replay.queueRevision, 2);
  await controller.stop();
});

test("P-A 残留：organize analyze 也收敛计划账——此前 open 的 organize 计划被作废、执行被硬闸拒绝，重放不二次作废", async (t) => {
  const { controller, trusted } = await setup(t);
  const { preview } = await buildLinkPlan(controller, trusted, "ag");
  // analyze（新 operationId）→ 队列按本次分析重建，旧 open organize 计划作废。
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "ag-an-1" });
  assert.equal(analyzed.items.length, analyzed.analysis.candidates);
  const listed = await controller.management.listCandidates(trusted, {});
  assert.equal(listed.plans.filter((p) => p.kind === "organize" && p.executed === false && p.superseded !== true).length, 0,
    "organize analyze must supersede stale open organize plans");
  assert.ok(listed.plans.some((p) => p.planId === preview.planId && p.superseded === true));
  // 被作废计划执行被服务端硬闸拒绝。
  await assert.rejects(
    () => controller.management.executePlan(trusted, {
      planId: preview.planId, planDigest: preview.planDigest, operationId: "ag-ex-old", confirmed: true,
    }),
    (e) => e.code === "REVISION_CONFLICT" && /superseded/.test(e.message),
  );
  // 同 operationId 重放：journal 命中，plans 逐字一致（不用旧 operationId
  // 二次作废、也不误杀潜在新计划）。
  const replay = await controller.management.analyze(trusted, { kind: "organize", operationId: "ag-an-1" });
  assert.deepEqual(replay.plans, listed.plans);
  await controller.stop();
});

test("P-A 残留：executePlan 收敛阶段抛错时 grant 随 finally 撤销（不泄漏授权）", async (t) => {
  // createManagement 级单元夹具：forgetting 执行用假 store（archiveEphemeral
  // 成功、listActive 注入抛错），plan 账用真实 state store（temp 目录）。
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-grantleak-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "state"), { recursive: true });
  const state = createStateStore({ stateRoot: path.join(base, "state") });
  const scopeId = "amber";
  const futureMs = Date.now() + 90 * 24 * 3600 * 1000;
  const nowIso = () => new Date(futureMs).toISOString();
  const oldIso = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();

  const policy = normalizeForgetPolicy({});
  const settings = {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    sessionPersonas: [], workspacePersonas: [],
    budgets: { persona: { maxChars: 12000 }, core: { targetChars: 2000, hardCapChars: 4000 } },
    l2: { enabled: false }, organize: { enabled: true },
    forgetting: { enabled: true, policy },
  };

  // 一张过期 ephemeral 卡（完整九必需字段）→ 真实 analyzeForgetting 产出合法 plan。
  const card = {
    id: "spk-grantleak0001", scopeId, revision: 1, state: "active", vitality: "ephemeral",
    createdAt: oldIso, lastUsedAt: oldIso, useCount: 0, supersedes: null,
    title: "旧临时", content: "临时内容。",
  };
  const analysis = analyzeForgetting({ scopeId, sparks: [card], now: nowIso(), policy });
  assert.ok(analysis.plan, "fixture must yield a forgetting plan");
  const plan = structuredClone(analysis.plan);
  const planDigest = organizeDigestPlan(plan);
  const planId = `fp-${planDigest}`;
  await state.planStore.save(scopeId, planId, {
    kind: "forgetting", planDigest, queueRevision: null, plan,
    diff: [], changedItems: plan.sources.length, summary: "fixture",
  });

  // 假 spark store：归档成功；收敛阶段的 listActive 注入抛错。
  const fakeSparkStore = {
    async archiveEphemeral(planClone, opts) {
      return { operationId: opts.operationId, archivedAt: nowIso(), cards: planClone.sources.map((s) => ({ id: s.id, revision: s.revision + 1, state: "archived" })) };
    },
    listActive() {
      throw new Error("injected listActive failure");
    },
  };
  let revokes = 0;
  const { management } = createManagement({
    settings,
    dataRoot: settings.dataRoot,
    state,
    resourcesFor: async () => ({ sparkStore: fakeSparkStore }),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: (spec) => {
      const grant = { ...spec, revoked: false };
      grant.revoke = () => { revokes += 1; grant.revoked = true; };
      return grant;
    },
    executeToolForScope: async () => { throw new Error("not used"); },
    nowIso,
  });
  const trusted = { session: { id: "s-grantleak" }, source: "panel-rpc" };

  // B1（audit B P2-1）行为变更：执行器成功 + markExecuted 落账后，收敛阶段
  // listActive 抛错不再翻转回执——调用按 executed 成功返回，收敛失败以
  // queueConvergence.applied=false + 可读 warning 上报；finally 仍必须 revoke
  // grant（revokes === 1）。
  const executed = await management.executePlan(trusted, { planId, planDigest, operationId: "ex-leak-1", confirmed: true });
  assert.ok(
    executed.result.archivedAt && executed.result.operationId === "ex-leak-1",
    "executor receipt must survive convergence failure",
  );
  assert.equal(executed.queueConvergence.applied, false);
  assert.match(executed.queueConvergence.warning, /injected listActive failure/);
  assert.equal(revokes, 1, "grant must be revoked exactly once via finally");
  const entry = await state.planStore.get(scopeId, planId);
  assert.equal(entry.executed, true, "markExecuted happened before convergence (documented semantics)");
  await assert.rejects(
    () => management.executePlan(trusted, { planId, planDigest, operationId: "ex-leak-2", confirmed: true }),
    (e) => e.code === "REVISION_CONFLICT",
  );
});

// ── F7：只读宿主的面板写路径（0.2 复审 F-6 收口）────────────────────────

/** 与真实座位守卫同形状的只读桩：locked 时 assertWritable 抛 HOST_LOCKED。 */
function reviewSeatGuardStub() {
  const stub = {
    locked: true,
    assertWritable() {
      if (stub.locked !== true) return;
      const error = new Error("HOST_LOCKED: another Shiori instance holds the write lock");
      error.code = "HOST_LOCKED";
      throw error;
    },
  };
  return stub;
}

async function readonlyHostFixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-readonly-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "state"), { recursive: true });
  await mkdir(path.join(base, "data"), { recursive: true });
  const state = createStateStore({ stateRoot: path.join(base, "state") });
  const settings = {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    sessionPersonas: [], workspacePersonas: [],
    budgets: { persona: { maxChars: 12000 }, core: { targetChars: 2000, hardCapChars: 4000 } },
    l2: { enabled: false }, organize: { enabled: true },
    forgetting: { enabled: true, policy: normalizeForgetPolicy({}) },
  };
  const guard = reviewSeatGuardStub();
  const { management } = createManagement({
    settings,
    dataRoot: settings.dataRoot,
    state,
    resourcesFor: async () => ({ sparkStore: { async listActive() { return []; } } }),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: (spec) => {
      const grant = { ...spec, revoked: false };
      grant.revoke = () => { grant.revoked = true; };
      return grant;
    },
    executeToolForScope: async () => { throw new Error("not used"); },
    nowIso: () => new Date().toISOString(),
    // 取值函数形态：controller 的门面构造早于 start() 里的座位守卫。
    readonlyGuard: () => guard,
  });
  const trusted = { session: { id: "s-readonly" }, source: "panel-rpc" };
  return { management, guard, trusted };
}

test("F7：只读宿主上面板写方法一律 HOST_LOCKED（含 executePlan），放行可写后才执行", async (t) => {
  const { management, guard, trusted } = await readonlyHostFixture(t);
  const calls = [
    ["analyze", { kind: "organize", operationId: "op-ro-analyze" }],
    ["reviewCandidate", {
      candidateId: "a".repeat(64), decision: "reviewed", expectedQueueRevision: 0, operationId: "op-ro-review",
    }],
    ["previewPlan", { kind: "forgetting", planId: "fp-missing" }],
    ["executePlan", { planId: "fp-missing", planDigest: "d".repeat(64), operationId: "op-ro-exec", confirmed: true }],
  ];
  for (const [name, payload] of calls) {
    await assert.rejects(
      () => management[name](trusted, payload),
      (error) => error.code === "HOST_LOCKED" && /another Shiori instance/.test(error.message),
      `${name} must be rejected on a read-only host`,
    );
  }

  // 只读桩的拒绝发生在任何账本写入之前：解锁后同一调用才真正执行。
  guard.locked = false;
  const analysis = await management.analyze(trusted, { kind: "organize", operationId: "op-ro-analyze" });
  assert.equal(analysis.items.length, 0);
  assert.equal(analysis.analysis.kind, "organize");
});

test("F7：deps.readonlyGuard 形状非法在第一次写调用时拒绝（不静默放行）", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-readonly-bad-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "state"), { recursive: true });
  const state = createStateStore({ stateRoot: path.join(base, "state") });
  const settings = {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    sessionPersonas: [], workspacePersonas: [],
    budgets: { persona: { maxChars: 12000 }, core: { targetChars: 2000, hardCapChars: 4000 } },
    l2: { enabled: false }, organize: { enabled: true },
    forgetting: { enabled: true, policy: normalizeForgetPolicy({}) },
  };
  const { management } = createManagement({
    settings, dataRoot: settings.dataRoot, state,
    resourcesFor: async () => ({ sparkStore: { async listActive() { return []; } } }),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: (spec) => ({ ...spec, revoke() {} }),
    executeToolForScope: async () => { throw new Error("not used"); },
    nowIso: () => new Date().toISOString(),
    readonlyGuard: { nope: 1 },
  });
  const trusted = { session: { id: "s-readonly-bad" }, source: "panel-rpc" };
  await assert.rejects(
    () => management.analyze(trusted, { kind: "organize", operationId: "op-bad-guard" }),
    (error) => error.code === "INVALID_INPUT" && /assertWritable/.test(error.message),
  );
});

test("getTimeline：payload 缺省时按空对象处理（不抛裸 TypeError）", async (t) => {
  const { management, trusted } = await readonlyHostFixture(t);
  const page = await management.getTimeline(trusted);
  assert.equal(page.scope, "amber");
  assert.deepEqual(page.items, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.scanLimited, false);
});

// ── archive-topic 预览（0.2.2 专题归档/恢复）────────────────────────────────

test("protocol：previewPlan 第三变体 archive-topic（required 三键；operationId 可选；未知字段拒绝）", () => {
  const base = { kind: "archive-topic", topicKey: "arch-target", archive: true };
  // required 三键：kind/topicKey/archive；operationId 可选（P-A 作废标记用，缺省落 null）
  assert.deepEqual(validateManagementPayload("previewPlan", base), base);
  assert.deepEqual(
    validateManagementPayload("previewPlan", { ...base, operationId: "pv-ar-0" }),
    { ...base, operationId: "pv-ar-0" },
  );
  // 缺任一必填键 / archive 非布尔 / topicKey 空串 / 未知字段
  assert.throws(() => validateManagementPayload("previewPlan", { kind: "archive-topic", topicKey: "x" }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("previewPlan", { kind: "archive-topic", archive: true }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("previewPlan", { topicKey: "x", archive: true }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("previewPlan", { kind: "archive-topic", topicKey: "x", archive: "yes" }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("previewPlan", { kind: "archive-topic", topicKey: "", archive: true }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("previewPlan", { kind: "archive-topic", topicKey: "x", archive: true, rogue: 1 }), (e) => e.code === "INVALID_INPUT");
});

test("archive-topic 全链：previewPlan → executePlan 落盘归档；恢复后字段消失；同状态 INVALID_INPUT；topic 不存在 NOT_FOUND", async (t) => {
  const { controller, trusted, base } = await setup(t);
  await controller.management.executeTool(trusted, {
    name: "topic_create", args: { topic: "arch-target", title: "Arch Target", summary: "target" },
  });

  // topic 不存在 → NOT_FOUND
  await assert.rejects(
    () => controller.management.previewPlan(trusted, { kind: "archive-topic", topicKey: "nope", archive: true }),
    (e) => e.code === "NOT_FOUND",
  );
  // 未归档时要求恢复 → INVALID_INPUT（已在目标状态）
  await assert.rejects(
    () => controller.management.previewPlan(trusted, { kind: "archive-topic", topicKey: "arch-target", archive: false }),
    (e) => e.code === "INVALID_INPUT",
  );

  // 预览归档：queueRevision 恒 null（无队列事务）、changedItems 1、summary 固定
  const preview = await controller.management.previewPlan(trusted, {
    kind: "archive-topic", topicKey: "arch-target", archive: true, operationId: "pv-ar-1",
  });
  assert.equal(preview.kind, "organize");
  assert.equal(preview.proposalKind, "archive-topic");
  assert.match(preview.planDigest, /^[a-f0-9]{64}$/);
  assert.equal(preview.queueRevision, null);
  assert.equal(preview.changedItems, 1);
  assert.equal(preview.summary, "archive-topic plan over 1 topic");
  assert.equal(preview.diff.length, 1);
  assert.equal(preview.diff[0].path, "topic:arch-target");
  assert.equal(preview.diff[0].oldText, "archivedAt: (未归档)");
  assert.match(preview.diff[0].newText, /^archivedAt: \d{4}-/);

  // 执行：走 organizer executor（entry.kind "organize"）
  const executed = await controller.management.executePlan(trusted, {
    planId: preview.planId, planDigest: preview.planDigest, operationId: "ex-ar-1", confirmed: true,
  });
  assert.equal(executed.result.status, "completed");
  assert.equal(executed.result.kind, "archive-topic");
  assert.equal(executed.result.changedItems, 1);

  // 真实落盘：front-matter 出现 archivedAt
  const topicFile = path.join(base, "data", "scopes", "amber", "topics", "arch-target.md");
  const rawArchived = await readFile(topicFile, "utf8");
  assert.match(rawArchived, /archivedAt: "/);

  // 已归档再要求归档 → INVALID_INPUT
  await assert.rejects(
    () => controller.management.previewPlan(trusted, { kind: "archive-topic", topicKey: "arch-target", archive: true }),
    (e) => e.code === "INVALID_INPUT",
  );

  // 预览恢复 → 执行 → front-matter 字段消失
  const preview2 = await controller.management.previewPlan(trusted, {
    kind: "archive-topic", topicKey: "arch-target", archive: false, operationId: "pv-ar-2",
  });
  assert.equal(preview2.diff[0].oldText.startsWith("archivedAt: 2"), true);
  assert.equal(preview2.diff[0].newText, "archivedAt: (未归档)");
  await controller.management.executePlan(trusted, {
    planId: preview2.planId, planDigest: preview2.planDigest, operationId: "ex-ar-2", confirmed: true,
  });
  const rawRestored = await readFile(topicFile, "utf8");
  assert.ok(!rawRestored.includes("archivedAt"), "恢复后 front-matter 不再有 archivedAt 字段");
});

test("archive-topic：跨 scope 拒绝 INVALID_STATE；P2-B3 独立计划族——归档预览不再作废 organize 计划，两计划都可执行", async (t) => {
  const { controller, trusted, base } = await setup(t);
  await controller.management.executeTool(trusted, {
    name: "topic_create", args: { topic: "local-topic", title: "Local", summary: "s" },
  });

  // 跨 scope：global scope 预置一个 topic 文件（readTopic 回退链可达，scopeId 为 global）
  const globalDir = path.join(base, "data", "scopes", "global", "topics");
  await mkdir(globalDir, { recursive: true });
  await writeFile(path.join(globalDir, "shared.md"),
    '---\nkey: "shared"\ntitle: "Shared"\nsummary: "s"\nupdated: "2026-11-01T00:00:00.000Z"\nscopeId: "global"\n---\n全局正文\n');
  await assert.rejects(
    () => controller.management.previewPlan(trusted, { kind: "archive-topic", topicKey: "shared", archive: true }),
    (e) => e.code === "INVALID_STATE",
  );

  // P-A 收敛：open 的 organize 计划被 archive-topic 预览作废，执行被硬闸拒绝
  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: { title: `A${i}`, content: `共同实体内容 ${i}。`, triggers: [`a${i}`], entities: ["归档实体"], vitality: "evergreen" },
    });
  }
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "an-ar" });
  const candidate = analyzed.items[0].candidate;
  const reviewed = await controller.management.reviewCandidate(trusted, {
    candidateId: candidate.id, decision: "reviewed",
    expectedQueueRevision: analyzed.queueRevision, operationId: "rv-ar",
  });
  const organizePreview = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: candidate.id, expectedQueueRevision: reviewed.queueRevision, operationId: "pv-organize-ar",
    proposal: { kind: "link", links: [{ id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id, rel: "相关" }] }] },
  });
  assert.ok(organizePreview.planId);

  // P2-B3 后 archive-topic 是独立计划族：归档预览只收敛其它归档计划，
  // 不再作废 organize 计划（修复前这里会误伤，确认执行报 REVISION_CONFLICT）。
  await controller.management.executeTool(trusted, {
    name: "topic_create", args: { topic: "arch-other", title: "Other", summary: "s" },
  });
  const arPreview = await controller.management.previewPlan(trusted, {
    kind: "archive-topic", topicKey: "arch-other", archive: true, operationId: "pv-ar-sup",
  });
  const listedAfterAr = await controller.management.listCandidates(trusted, {});
  const organizeRow = listedAfterAr.plans.find((p) => p.planId === organizePreview.planId);
  assert.ok(organizeRow, "organize plan must be listed");
  assert.equal(organizeRow.superseded, false, "archive preview must NOT supersede organize plan");
  assert.equal(organizeRow.kind, "organize");

  // organize 计划仍可执行（P2-B3 修复的核心回归点）
  const executedOrganize = await controller.management.executePlan(trusted, {
    planId: organizePreview.planId, planDigest: organizePreview.planDigest, operationId: "ex-organize-after-ar", confirmed: true,
  });
  assert.equal(executedOrganize.result.status, "completed");

  // archive 计划也可执行（未被作废）
  const executed = await controller.management.executePlan(trusted, {
    planId: arPreview.planId, planDigest: arPreview.planDigest, operationId: "ex-ar-sup", confirmed: true,
  });
  assert.equal(executed.result.status, "completed");
});

// ── P2-B3：archive-topic 独立计划族 ──────────────────────────────────────────

test("P2-B3：归档预览 → organize analyze 不作废归档计划（仍 open 且可执行）；队列 DTO wire 不漏新 store kind", async (t) => {
  const { controller, trusted } = await setup(t);
  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: { title: `P2B3-${i}`, content: `共同实体内容 ${i}。`, triggers: [`p2b3-${i}`], entities: ["P2B3实体"], vitality: "evergreen" },
    });
  }
  await controller.management.executeTool(trusted, {
    name: "topic_create", args: { topic: "p2b3-target", title: "P2B3", summary: "s" },
  });
  // 1) 归档预览：store 落新 kind "archive-topic"
  const arPreview = await controller.management.previewPlan(trusted, {
    kind: "archive-topic", topicKey: "p2b3-target", archive: true, operationId: "pv-p2b3-1",
  });
  // 2) 跑一次 organize analyze（修复前会把归档计划顺手作废 → executePlan 报 REVISION_CONFLICT）
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "an-p2b3-1" });
  // 队列 DTO（analyze 返回走 queueDto）：wire 不漏新 store kind——映射回 organize 家族
  const analyzeRow = analyzed.plans.find((p) => p.planId === arPreview.planId);
  assert.ok(analyzeRow, "archive plan must appear in analyze plans DTO");
  assert.equal(analyzeRow.kind, "organize", "wire kind 恒为家族名 organize");
  assert.equal(analyzeRow.superseded, false, "organize analyze must NOT supersede archive plan");
  assert.ok(!analyzed.plans.some((p) => p.kind === "archive-topic"), "wire must not leak store kind archive-topic");
  // listCandidates（另一条 plans wire 路径）同样不漏、同样如实标注
  const listed = await controller.management.listCandidates(trusted, {});
  const listedRow = listed.plans.find((p) => p.planId === arPreview.planId);
  assert.ok(listedRow);
  assert.equal(listedRow.kind, "organize");
  assert.equal(listedRow.superseded, false);
  // 3) 归档计划仍可执行
  const executed = await controller.management.executePlan(trusted, {
    planId: arPreview.planId, planDigest: arPreview.planDigest, operationId: "ex-p2b3-1", confirmed: true,
  });
  assert.equal(executed.result.status, "completed");
  assert.equal(executed.result.kind, "archive-topic");
});

test("P2-B3：归档预览收敛同族——后一个归档预览作废前一个 open 归档计划（executePlan 硬闸生效）", async (t) => {
  const { controller, trusted } = await setup(t);
  await controller.management.executeTool(trusted, { name: "topic_create", args: { topic: "p2b3-a", title: "A", summary: "s" } });
  await controller.management.executeTool(trusted, { name: "topic_create", args: { topic: "p2b3-b", title: "B", summary: "s" } });
  const previewA = await controller.management.previewPlan(trusted, {
    kind: "archive-topic", topicKey: "p2b3-a", archive: true, operationId: "pv-p2b3-a",
  });
  const previewB = await controller.management.previewPlan(trusted, {
    kind: "archive-topic", topicKey: "p2b3-b", archive: true, operationId: "pv-p2b3-b",
  });
  assert.notEqual(previewA.planId, previewB.planId);
  const listed = await controller.management.listCandidates(trusted, {});
  const rowA = listed.plans.find((p) => p.planId === previewA.planId);
  assert.ok(rowA);
  assert.equal(rowA.superseded, true, "archive preview B must supersede open archive plan A");
  assert.equal(rowA.kind, "organize");
  await assert.rejects(
    () => controller.management.executePlan(trusted, {
      planId: previewA.planId, planDigest: previewA.planDigest, operationId: "ex-p2b3-a-sup", confirmed: true,
    }),
    (e) => e.code === "REVISION_CONFLICT" && /superseded/.test(e.message),
    "被作废的归档计划不可执行（硬闸不放宽）",
  );
  const executedB = await controller.management.executePlan(trusted, {
    planId: previewB.planId, planDigest: previewB.planDigest, operationId: "ex-p2b3-b", confirmed: true,
  });
  assert.equal(executedB.result.status, "completed");
});

test("P2-B3：organize 预览与归档预览互不作废（正向/反向两个顺序都验）", async (t) => {
  // 正向：organize 预览 → 归档预览 → organize 计划不被作废，两计划都可执行
  {
    const { controller, trusted } = await setup(t);
    for (let i = 0; i < 9; i++) {
      await controller.management.executeTool(trusted, {
        name: "spark_save",
        args: { title: `F${i}`, content: `共同实体内容 ${i}。`, triggers: [`fwd-${i}`], entities: ["互不实体"], vitality: "evergreen" },
      });
    }
    await controller.management.executeTool(trusted, { name: "topic_create", args: { topic: "p2b3-fwd", title: "F", summary: "s" } });
    const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "an-p2b3-fwd" });
    const candidate = analyzed.items[0].candidate;
    const reviewed = await controller.management.reviewCandidate(trusted, {
      candidateId: candidate.id, decision: "reviewed", expectedQueueRevision: analyzed.queueRevision, operationId: "rv-p2b3-fwd",
    });
    const orgPreview = await controller.management.previewPlan(trusted, {
      kind: "organize", candidateId: candidate.id, expectedQueueRevision: reviewed.queueRevision, operationId: "pv-p2b3-fwd",
      proposal: { kind: "link", links: [{ id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id, rel: "相关" }] }] },
    });
    const arPreview = await controller.management.previewPlan(trusted, {
      kind: "archive-topic", topicKey: "p2b3-fwd", archive: true, operationId: "pv-p2b3-fwd-ar",
    });
    const listed = await controller.management.listCandidates(trusted, {});
    assert.equal(listed.plans.find((p) => p.planId === orgPreview.planId)?.superseded, false,
      "archive preview must not supersede organize plan");
    assert.equal(listed.plans.find((p) => p.planId === arPreview.planId)?.superseded, false,
      "organize-family previews must not supersede archive plan");
    const ex1 = await controller.management.executePlan(trusted, {
      planId: orgPreview.planId, planDigest: orgPreview.planDigest, operationId: "ex-p2b3-fwd", confirmed: true,
    });
    assert.equal(ex1.result.status, "completed");
    const ex2 = await controller.management.executePlan(trusted, {
      planId: arPreview.planId, planDigest: arPreview.planDigest, operationId: "ex-p2b3-fwd-ar", confirmed: true,
    });
    assert.equal(ex2.result.status, "completed");
    await controller.stop();
  }
  // 反向：归档预览 → organize analyze + organize 预览 → 归档计划不被作废
  {
    const { controller, trusted } = await setup(t);
    for (let i = 0; i < 9; i++) {
      await controller.management.executeTool(trusted, {
        name: "spark_save",
        args: { title: `R${i}`, content: `共同实体内容 ${i}。`, triggers: [`rev-${i}`], entities: ["互不实体"], vitality: "evergreen" },
      });
    }
    await controller.management.executeTool(trusted, { name: "topic_create", args: { topic: "p2b3-rev", title: "R", summary: "s" } });
    const arPreview = await controller.management.previewPlan(trusted, {
      kind: "archive-topic", topicKey: "p2b3-rev", archive: true, operationId: "pv-p2b3-rev-ar",
    });
    const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "an-p2b3-rev" });
    const candidate = analyzed.items[0].candidate;
    const reviewed = await controller.management.reviewCandidate(trusted, {
      candidateId: candidate.id, decision: "reviewed", expectedQueueRevision: analyzed.queueRevision, operationId: "rv-p2b3-rev",
    });
    await controller.management.previewPlan(trusted, {
      kind: "organize", candidateId: candidate.id, expectedQueueRevision: reviewed.queueRevision, operationId: "pv-p2b3-rev",
      proposal: { kind: "link", links: [{ id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id, rel: "相关" }] }] },
    });
    const listed = await controller.management.listCandidates(trusted, {});
    assert.equal(listed.plans.find((p) => p.planId === arPreview.planId)?.superseded, false,
      "organize analyze/preview must not supersede archive plan");
    const ex = await controller.management.executePlan(trusted, {
      planId: arPreview.planId, planDigest: arPreview.planDigest, operationId: "ex-p2b3-rev-ar", confirmed: true,
    });
    assert.equal(ex.result.status, "completed");
    await controller.stop();
  }
});

test("P2-B3：旧形状兼容（store kind organize + plan.kind archive-topic）——organize analyze 不作废、仍可执行", async (t) => {
  const { controller, trusted, base } = await setup(t);
  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: { title: `LG${i}`, content: `共同实体内容 ${i}。`, triggers: [`lg-${i}`], entities: ["旧形状实体"], vitality: "evergreen" },
    });
  }
  await controller.management.executeTool(trusted, {
    name: "topic_create", args: { topic: "p2b3-legacy", title: "Legacy", summary: "s" },
  });
  // 用真实归档预览构建合法 plan 内容（expectedRevision 由 service 保证新鲜），
  // 再以升级前的旧形状（store kind "organize" + plan.kind "archive-topic"）落一份。
  const realPreview = await controller.management.previewPlan(trusted, {
    kind: "archive-topic", topicKey: "p2b3-legacy", archive: true, operationId: "pv-p2b3-legacy-real",
  });
  const stateStore = createStateStore({ stateRoot: path.join(base, "state") });
  const entry = await stateStore.planStore.get("amber", realPreview.planId);
  assert.ok(entry, "real preview plan must be persisted under scope amber");
  assert.equal(entry.kind, "archive-topic");
  assert.equal(entry.plan.kind, "archive-topic");
  const legacyPlanId = `op-${entry.planDigest}-legacy`;
  await stateStore.planStore.save("amber", legacyPlanId, {
    kind: "organize",
    planDigest: entry.planDigest,
    queueRevision: null,
    plan: entry.plan,
    diff: entry.diff,
    changedItems: entry.changedItems,
    summary: entry.summary,
  });
  // organize analyze（修复前：旧条目被当 organize 计划作废 → executePlan 报 superseded）
  await controller.management.analyze(trusted, { kind: "organize", operationId: "an-p2b3-legacy" });
  const listed = await controller.management.listCandidates(trusted, {});
  const legacyRow = listed.plans.find((p) => p.planId === legacyPlanId);
  assert.ok(legacyRow, "legacy plan must be listed");
  assert.equal(legacyRow.superseded, false, "organize analyze must NOT supersede legacy archive entry");
  // wire 形状：旧条目 store kind 本就是 "organize"，映射后不变（plansToWire
  // 只做 kind 家族名映射，不补 schema 外字段）
  assert.equal(legacyRow.kind, "organize");
  // 仍可执行（执行侧按 plan.kind 分派 organizer executor）
  const executed = await controller.management.executePlan(trusted, {
    planId: legacyPlanId, planDigest: entry.planDigest, operationId: "ex-p2b3-legacy", confirmed: true,
  });
  assert.equal(executed.result.status, "completed");
  assert.equal(executed.result.kind, "archive-topic");
  // 落盘验证：归档真发生了
  const topicFile = path.join(base, "data", "scopes", "amber", "topics", "p2b3-legacy.md");
  const raw = await readFile(topicFile, "utf8");
  assert.match(raw, /archivedAt: "/);
});


// ── group_manage list 主组口径（0.4 审查 P0#2，用户 2026-11-14 拍板）──────────
// 一个 topic 可挂多组，但组行计数只认主组 t.group[0]——退化成遍历整个 group
// 数组时，多组 topic 会在每个挂载组重复 +1，组计数总和虚高。

test("group_manage list 主组口径：多组 topic 只计入主组 t.group[0]，非主组不重复计数", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-groupcount-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const service = {
    async listTopics() {
      return [
        { key: "t-a", group: ["dev"] },                    // 主组 dev
        { key: "t-b", group: ["life", "dev"] },            // 主组 life
        { key: "t-c", group: ["dev", "life", "self"] },    // 主组 dev
      ];
    },
    async mutate() { throw new Error("list 计数用例不触写路径"); },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const out = await tool.execute({ action: "list" });
  const dev = out.groups.find((g) => g.key === "dev");
  const life = out.groups.find((g) => g.key === "life");
  assert.equal(dev.topics, 2, "dev 主组计 t-a + t-c（t-b 主组是 life，不重复计入 dev）");
  assert.equal(life.topics, 1, "life 主组只计 t-b（t-c 挂了 life 但主组是 dev，不重复计）");
});

// group 字段畸形（0.4 P0 交叉审查补钉）：实现只认 t.group[0]（数组首元素），
// 空数组 / 缺失 / 非数组都没有合法主组——一律不计入任何组，组计数总和必须
// 等于「有主组的 topic 数」，退化实现会把畸形挂载错算进某些组或整体虚增。
test("group_manage list 边界口径：group 空数组 / 缺失 / 非数组一律不计入任何组", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-groupedge-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const service = {
    async listTopics() {
      return [
        { key: "t-ok", group: ["dev"] },              // 正常主组（对照组：证明计数仍在工作）
        { key: "t-multi", group: ["dev", "life"] },   // 双挂：主组 dev、副组 life——副组不计数
        { key: "t-empty", group: [] },                // 空数组：无主组
        { key: "t-missing" },                         // 字段缺失：无主组
        { key: "t-str", group: "dev" },               // 非数组字符串：不是合法挂载
        { key: "t-null", group: null },               // null：不是合法挂载
      ];
    },
    async mutate() { throw new Error("list 计数用例不触写路径"); },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const out = await tool.execute({ action: "list" });
  const dev = out.groups.find((g) => g.key === "dev");
  const life = out.groups.find((g) => g.key === "life");
  // 钉的行为：只有主组 t.group[0] 进计数——t-multi 双挂只给 dev +1，副组 life 为 0
  //（计数退化为遍历整个 group 数组的旧实现会得出 life=1、total=3，本用例必红）；
  // 畸形 group（空数组/缺失/非数组）没有合法主组，同样不把任何组计数撑起来。
  assert.equal(dev.topics, 2, "dev 计 t-ok + t-multi（t-multi 副组挂 life，不重复计入 life）");
  assert.equal(life.topics, 0, "life 只被 t-multi 副组挂着，计数为 0");
  const total = out.groups.reduce((sum, g) => sum + g.topics, 0);
  assert.equal(total, 2, "组计数总和 = 有主组的 topic 数（t-ok + t-multi；守恒：副组与畸形挂载不虚增）");
});

// ── 0.4 收尾：主组判据收紧 + CAS 自愈重试 + dangling 检测与 repair ────────────
// ① 稀疏数组的空洞让 group[0] 取出 undefined，旧判据 primary !== null 放行
//   undefined，计数表混进 undefined 键；② 删除组「迁移成员 + CAS 删组」两步
//   之间 groups.json 被并发改动时，旧实现只改错误文案让人手动重试，没有自愈；
//   ③ 悬空引用（卡片指向已不存在的组）旧实现既不暴露也不修复。

// 需求 1（主组判据 typeof primary === "string"）属内部卫生：旧判据放行的
// undefined 只落在内部 counts 表，而输出只按 groups 行取值——undefined 键不
// 会出现在任何观测面上。因此本用例无法判别旧实现（旧实现下三条断言同样全绿），
// 这里诚实降级为计数契约：空洞主组不把任何组行计数撑起来、尾部空洞不影响合法
// 主组、组行计数总和 = 有合法字符串主组的 topic 数。
test("group_manage list 稀疏数组：空洞主组不污染任何组行计数（契约断言，不能判别旧实现）", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-groupsparse-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const holed = new Array(2);       // [ <1 empty>, "dev" ]：group[0] 是空洞
  holed[1] = "dev";
  const tailSparse = ["life"];      // ["life", <1 empty>]：主组合法、尾部空洞
  tailSparse.length = 2;
  const service = {
    async listTopics() {
      return [
        { key: "t-ok", group: ["dev"] },      // 对照组：证明计数仍在工作
        { key: "t-holed", group: holed },     // 稀疏：group[0] 空洞 → 无合法主组
        { key: "t-tail", group: tailSparse }, // 稀疏：主组 life 合法，尾部空洞不参与
      ];
    },
    async mutate() { throw new Error("list 计数用例不触写路径"); },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const out = await tool.execute({ action: "list" });
  const dev = out.groups.find((g) => g.key === "dev");
  const life = out.groups.find((g) => g.key === "life");
  // 契约：空洞主组没有合法字符串主组，不得把任何组行计数撑起来；旧实现把
  // undefined 计数放进内部表但不进输出，所以以下断言对旧实现同样成立（见上方注释）。
  assert.equal(dev.topics, 1, "dev 只计 t-ok（t-holed 的 group[0] 是空洞，不得计入任何键）");
  assert.equal(life.topics, 1, "life 计 t-tail（主组合法；尾部空洞不影响）");
  const total = out.groups.reduce((sum, g) => sum + g.topics, 0);
  assert.equal(total, 2, "计数守恒：组行总和 = 有合法字符串主组的 topic 数（空洞主组不虚增）");
});

test("group_manage delete：CAS 冲突自动重读 revision 补删组条目，迁移绝不二次执行", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-groupcas-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  // 铺两行组：gone（待删）与 dest（迁移目标）。并发写者在迁移提交期间往清单追加
  // intruder 组，让 deleteGroup 的 CAS（expectedRevision=action 开头的快照）必失败。
  const empty = await readGroups({ dataRoot: base, scopeId: "amber" });
  await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: empty.revision, groups: [
    { key: "gone", title: "待删组", summary: "", order: 1 },
    { key: "dest", title: "目标组", summary: "", order: 2 },
  ] });
  const topics = new Map([
    ["t-1", { key: "t-1", title: "卡1", summary: "s", body: "正文1", revision: 1, group: ["gone"] }],
    ["t-2", { key: "t-2", title: "卡2", summary: "s", body: "正文2", revision: 5, group: ["dest"] }],
  ]);
  let mutateCalls = 0;
  const service = {
    async listTopics() {
      return [...topics.values()].map((t) => ({ key: t.key, group: [...t.group] }));
    },
    async readTopic(key) {
      const t = topics.get(key);
      if (!t) {
        const e = new Error(`topic 不存在: ${key}`); e.code = "NOT_FOUND"; throw e;
      }
      return { ...t, group: [...t.group] };
    },
    async mutate({ changes }) {
      mutateCalls += 1;
      for (const c of changes) {
        const t = topics.get(c.key);
        t.revision += 1;
        t.group = [...c.topic.group];
        t.body = c.text;
      }
      // 模拟并发窗口：迁移提交生效的同时，别处改了 groups.json（CAS 基线失效）。
      const cur = await readGroups({ dataRoot: base, scopeId: "amber" });
      await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: cur.revision, groups: [
        ...cur.data.groups, { key: "intruder", title: "并发新组", summary: "", order: 99 },
      ] });
      return { revision: "after-mutate" };
    },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const out = await tool.execute({
    action: "delete", key: "gone", migrateTo: "dest", operationId: "cas-retry-1",
  });
  assert.equal(out.deleted, true, "第一次 CAS 失败必须由实现自愈（重读 revision 补删），不得上抛");
  assert.equal(mutateCalls, 1, "重试只补删组条目，绝不二次迁移（service.mutate 只调一次）");
  const after = await readGroups({ dataRoot: base, scopeId: "amber" });
  assert.deepEqual(after.data.groups.map((g) => g.key), ["dest", "intruder"],
    "gone 已删；并发写入的 intruder 必须保留（重试用的是重读后的清单，不是覆盖）");
  assert.deepEqual(topics.get("t-1").group, ["dest"], "成员迁移生效且只执行一次");
});

test("group_manage list：dangling 字段列出 topic.group 指向不存在组的条目（去重），既有键不丢", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-groupdangling-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const empty = await readGroups({ dataRoot: base, scopeId: "amber" });
  await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: empty.revision, groups: [
    { key: "dev", title: "开发", summary: "", order: 1 },
    { key: "life", title: "生活", summary: "", order: 2 },
  ] });
  const service = {
    async listTopics() {
      return [
        { key: "t-a", group: ["dev", "ghost"] },      // 副组悬空
        { key: "t-b", group: ["missing"] },           // 主组悬空
        { key: "t-c", group: ["dev"] },               // 全部有效（对照组）
        { key: "t-d", group: ["life", "ghost"] },     // 与 t-a 悬到同一个 ghost，仍是独立条目
        { key: "t-e", group: ["ghost", "ghost"] },    // 同一悬空组重复挂载 → 去重为一条
      ];
    },
    async mutate() { throw new Error("dangling 检测用例不触写路径"); },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const out = await tool.execute({ action: "list" });
  assert.deepEqual(out.dangling, [
    { topicKey: "t-a", group: "ghost" },
    { topicKey: "t-b", group: "missing" },
    { topicKey: "t-d", group: "ghost" },
    { topicKey: "t-e", group: "ghost" },
  ], "悬空条目形如 {topicKey, group}，按 (topicKey, group) 去重，顺序随 topic 遍历序");
  // 既有返回结构只加字段、不改原有键：scope/action/revision/groups 全部仍在。
  for (const k of ["scope", "action", "revision", "groups"]) {
    assert.ok(Object.hasOwn(out, k), `既有键 ${k} 必须保留`);
  }
  assert.equal(out.groups.find((g) => g.key === "dev").topics, 2, "有效组计数不受悬空检测影响（dev 主组计 t-a + t-c）");
});

test("group_manage repair：清掉悬空引用（CAS+operationId 单提交），有效组与卡片正文不动，repair 后 list 干净", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-grouprepair-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const empty = await readGroups({ dataRoot: base, scopeId: "amber" });
  await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: empty.revision, groups: [
    { key: "dev", title: "开发", summary: "", order: 1 },
  ] });
  const topics = new Map([
    ["t-a", { key: "t-a", title: "卡A", summary: "sa", body: "正文A", revision: 11, group: ["dev", "ghost"] }],
    ["t-b", { key: "t-b", title: "卡B", summary: "sb", body: "正文B", revision: 22, group: ["ghost"] }],
    ["t-c", { key: "t-c", title: "卡C", summary: "sc", body: "正文C", revision: 33, group: ["dev"] }],
  ]);
  const mutateCalls = [];
  const service = {
    async listTopics() {
      return [...topics.values()].map((t) => ({ key: t.key, group: [...t.group] }));
    },
    async readTopic(key) {
      const t = topics.get(key);
      if (!t) {
        const e = new Error(`topic 不存在: ${key}`); e.code = "NOT_FOUND"; throw e;
      }
      return { ...t, group: [...t.group] };
    },
    async mutate(args) {
      mutateCalls.push(args);
      for (const c of args.changes) {
        const t = topics.get(c.key);
        assert.equal(c.expectedRevision, t.revision, "repair 变更必须带 CAS（expectedRevision=读时 revision）");
        t.revision += 1;
        t.group = [...c.topic.group];
        t.body = c.text;
      }
      // review a3 项 1（remaining 判别力）：提交期间不改 groups.json。本次变更已把
      // ghost 挂载摘掉，提交后重读 topics 时真实剩余悬空为 0；若 remaining 退回
      // 「提交前快照」口径，会数到 2（t-a/ghost + t-b/ghost），下面 remaining === 0
      // 断言必变红。
      return { revision: "after-repair" };
    },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const out = await tool.execute({ action: "repair", operationId: "repair-1" });
  assert.equal(out.cleaned, 2, "清理条数 = 实际摘除的 (topicKey, group) 对数（t-a 的 ghost + t-b 的 ghost）");
  assert.equal(
    out.remaining, 0,
    "remaining 用提交后重读的 topics：ghost 挂载已摘掉、known 仍是 {dev} → 0；"
    + "退回提交前快照口径会数到 2（t-a/ghost + t-b/ghost），本条必变红",
  );
  assert.equal(mutateCalls.length, 1, "全部清理收进单次 service.mutate 提交");
  assert.equal(mutateCalls[0].operationId, "repair-1", "operationId 必须透传（幂等键）");
  assert.deepEqual(topics.get("t-a").group, ["dev"], "t-a 只摘 ghost，有效主组 dev 保留");
  assert.deepEqual(topics.get("t-b").group, [], "t-b 只剩悬空挂载 → 清成空数组");
  assert.equal(topics.get("t-b").body, "正文B", "卡片正文原样保留");
  assert.deepEqual(topics.get("t-c").group, ["dev"], "全有效卡片 t-c 不进变更（不碰有效组和卡片正文）");
  // repair 之后 list 必须干净
  const listed = await tool.execute({ action: "list" });
  assert.deepEqual(listed.dangling, [], "repair 后 list.dangling 为空");
  // 重放幂等：无悬空时不再触写路径
  const again = await tool.execute({ action: "repair", operationId: "repair-2" });
  assert.equal(again.cleaned, 0, "重复 repair 空清理");
  assert.equal(again.remaining, 0, "重复 repair 剩余悬空条数同样为 0");
  assert.equal(mutateCalls.length, 1, "无悬空引用时 repair 不触写路径（幂等）");
});

// review a3 项 2：提交前复核用的是较早的 snapshot，快照里判成悬空的挂载可能已被
// 别处摘掉——buildChanges 重读后实际摘除 0 条时，repair 必须跳过 mutate（否则白涨
// groups.json revision），返回 cleaned 0 与当前 revision。
test("group_manage repair：重读 topics 时悬空挂载已被别处摘掉 → 跳过 mutate，cleaned 0", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-grouprepairnoop-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const empty = await readGroups({ dataRoot: base, scopeId: "amber" });
  await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: empty.revision, groups: [
    { key: "dev", title: "开发", summary: "", order: 1 },
  ] });
  const before = await readGroups({ dataRoot: base, scopeId: "amber" });
  let mutateCalls = 0;
  const service = {
    // 快照里 t-a 仍挂 ghost（悬空）。
    async listTopics() { return [{ key: "t-a", group: ["dev", "ghost"] }]; },
    // 但读改写时 ghost 已被别处摘掉：实际无可摘条目。
    async readTopic(key) {
      return { key, title: "卡A", summary: "sa", body: "正文A", revision: 5, group: ["dev"] };
    },
    async mutate() { mutateCalls += 1; return { revision: "should-not-happen" }; },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const out = await tool.execute({ action: "repair", operationId: "repair-noop" });
  assert.equal(out.cleaned, 0, "实际摘除 0 条：如实返回 0，不谎报快照里的悬空数");
  assert.equal(out.remaining, 0, "既然没有实际变更，剩余悬空按空修复返回 0");
  assert.equal(out.revision, before.revision, "不触写：返回的仍是当前清单 revision");
  assert.equal(mutateCalls, 0, "removed 为 0 时绝不调用 service.mutate（避免空提交涨 revision）");
});

// review a3 项 1 另一方向：提交窗口内别处删掉 dev 组 → remaining 用提交后重读的
// known 精确为 2（t-a/dev + t-c/dev）。退回「提交前 known」口径会算成 0，本条必红。
test("group_manage repair：提交窗口内 dev 组被删 → remaining 精确为 2（提交后 known）", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-grouprepairknown-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const empty = await readGroups({ dataRoot: base, scopeId: "amber" });
  await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: empty.revision, groups: [
    { key: "dev", title: "开发", summary: "", order: 1 },
  ] });
  const topics = new Map([
    ["t-a", { key: "t-a", title: "卡A", summary: "sa", body: "正文A", revision: 1, group: ["dev", "ghost"] }],
    ["t-c", { key: "t-c", title: "卡C", summary: "sc", body: "正文C", revision: 2, group: ["dev"] }],
  ]);
  let mutateCalls = 0;
  const service = {
    async listTopics() { return [...topics.values()].map((x) => ({ key: x.key, group: [...x.group] })); },
    async readTopic(key) { const x = topics.get(key); return { ...x, group: [...x.group] }; },
    async mutate({ changes }) {
      mutateCalls += 1;
      for (const c of changes) {
        const x = topics.get(c.key);
        x.revision += 1;
        x.group = [...c.topic.group];
        x.body = c.text;
      }
      // 提交期间别处删掉 dev：提交后 t-a/t-c 的 dev 挂载都成残余悬空。
      const cur = await readGroups({ dataRoot: base, scopeId: "amber" });
      await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: cur.revision, groups: [] });
      return { revision: "after-repair" };
    },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const out = await tool.execute({ action: "repair", operationId: "repair-known-fresh" });
  assert.equal(out.cleaned, 1, "只摘 t-a/ghost");
  assert.equal(out.remaining, 2,
    "提交后 known 为空：t-a/t-c 的 dev 挂载都成残余悬空（2）；"
    + "退回提交前 known 口径会算成 0，本条必变红");
  assert.equal(mutateCalls, 1);
});

// 必修 1 回归：list/repair 的先 topics 后 groups 读序。组可见性保证挂载发生在
// 建组之后——若组在这两次读之间被建出，后读的 groups 必须看得到它。这里让
// listTopics 在返回前顺手把新组写进 groups.json（模拟并发建组）：旧读序
//（先 groups 定格 known、后读 topics）会把这条件挂载误判成悬空并静默摘掉。
test("group_manage list/repair 读序：读 topics 期间建出的组不被误判为悬空（必修 1 回归）", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-grouporder-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const empty = await readGroups({ dataRoot: base, scopeId: "amber" });
  await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: empty.revision, groups: [
    { key: "dev", title: "开发", summary: "", order: 1 },
  ] });
  let groupCreated = false;
  const service = {
    async listTopics() {
      if (!groupCreated) {
        groupCreated = true;
        // 并发建组：本快照之后、工具读 groups 之前，新组 hot 落盘。
        const cur = await readGroups({ dataRoot: base, scopeId: "amber" });
        await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: cur.revision, groups: [
          ...cur.data.groups, { key: "hot", title: "热组", summary: "", order: 2 },
        ] });
      }
      return [{ key: "t-hot", group: ["hot"] }];
    },
    async readTopic() { throw new Error("有效挂载不得被 repair 读改写"); },
    async mutate() { throw new Error("有效挂载不得被 repair 写入"); },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const listed = await tool.execute({ action: "list" });
  assert.deepEqual(listed.dangling, [], "组先于挂载可见，后读 groups 必看到 hot，不得判悬空");
  assert.equal(listed.groups.find((g) => g.key === "hot").topics, 1, "hot 组正常计数");
  const repaired = await tool.execute({ action: "repair" });
  assert.equal(repaired.cleaned, 0, "repair 用同一读序，读到最新清单后不清理任何有效挂载");
  assert.equal(repaired.remaining, 0, "剩余悬空为 0");
});

// 必修 2 回归：groups.json 缺失/为空时 known 是空集——若不拒绝，repair 会把
// 每条挂载都当悬空、一次 mutate 全摘（清空用户数据，不是修复）。
test("group_manage repair：groups.json 缺失且有挂载 → INVALID_STATE 拒绝，不摘任何挂载", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-grouprepairnogroups-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // 刻意不调 ensureGroupsFile：groups.json 缺失，readGroupsOrEmpty 兜底为空清单。
  let mutateCalls = 0;
  const service = {
    async listTopics() {
      return [{ key: "t-a", group: ["dev"] }, { key: "t-b", group: ["ghost"] }];
    },
    async readTopic(key) { return { key, title: "卡", summary: "", body: "正文", revision: 1, group: [] }; },
    async mutate() { mutateCalls += 1; return { revision: "should-not-happen" }; },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  await assert.rejects(
    () => tool.execute({ action: "repair", operationId: "repair-no-groups" }),
    (e) => {
      assert.equal(e.code, "INVALID_STATE");
      assert.match(e.message, /group_manage action=create/, "文案要指到 agent 真能调到的 group_manage create");
      assert.match(e.message, /初始化/);
      assert.deepEqual(e.details.mountedTopics, ["t-a", "t-b"]);
      return true;
    },
  );
  assert.equal(mutateCalls, 0, "拒绝发生在构造变更之前，绝不写盘");
  // list 只读，仍如实暴露悬空（暴露 ≠ 清空）。
  const listed = await tool.execute({ action: "list" });
  assert.equal(listed.revision, null, "清单缺失时 revision 为 null");
  assert.deepEqual(listed.dangling.map((d) => d.topicKey), ["t-a", "t-b"]);
  // 空清单 + 无挂载：repair 正常空修复，不误拒。
  service.listTopics = async () => [];
  const emptyRepair = await tool.execute({ action: "repair" });
  assert.equal(emptyRepair.cleaned, 0);
  assert.equal(emptyRepair.remaining, 0);
  assert.equal(mutateCalls, 0);
});

// 必修 4b：repair 的写失败必须透出——mutate 的 CAS 冲突不能被吞成「已修复」。
test("group_manage repair：service.mutate 抛 CAS 冲突如实透出，不吞不重试", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-grouprepairfail-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const empty = await readGroups({ dataRoot: base, scopeId: "amber" });
  await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: empty.revision, groups: [
    { key: "dev", title: "开发", summary: "", order: 1 },
  ] });
  let mutateCalls = 0;
  const service = {
    async listTopics() { return [{ key: "t-a", group: ["dev", "ghost"] }]; },
    async readTopic(key) {
      return { key, title: "卡A", summary: "sa", body: "正文A", revision: 7, group: ["dev", "ghost"] };
    },
    async mutate() {
      mutateCalls += 1;
      const error = new Error("simulated repair CAS conflict");
      error.code = "REVISION_CONFLICT";
      throw error;
    },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  await assert.rejects(
    () => tool.execute({ action: "repair", operationId: "repair-cas-fail" }),
    (e) => e.code === "REVISION_CONFLICT" && /simulated repair CAS conflict/.test(e.message),
  );
  assert.equal(mutateCalls, 1, "只提交一次，失败不重试、不谎报 cleaned");
});

// 必修 2：读清单到 mutate 之间若有人建组修好了悬空，repair 必须复核 revision——
// 否则本次 mutate 会把刚修好的挂载再摘一次（数据丢失风险）。
test("group_manage repair：readTopic 与 mutate 之间组被建出（悬空已自愈）→ 提交前复核，不触写", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p4-grouprecheck-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await seedGroups(base);
  const empty = await readGroups({ dataRoot: base, scopeId: "amber" });
  await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: empty.revision, groups: [
    { key: "dev", title: "开发", summary: "", order: 1 },
  ] });
  let groupCreated = false;
  let mutateCalls = 0;
  const service = {
    async listTopics() { return [{ key: "t-a", group: ["dev", "hot"] }]; },
    async readTopic(key) {
      if (!groupCreated) {
        groupCreated = true;
        // 并发建组：本次 readTopic 之后、mutate 之前，hot 落盘——t-a 的挂载不再悬空。
        const cur = await readGroups({ dataRoot: base, scopeId: "amber" });
        await writeGroups({ dataRoot: base, scopeId: "amber", expectedRevision: cur.revision, groups: [
          ...cur.data.groups, { key: "hot", title: "热组", summary: "", order: 2 },
        ] });
      }
      return { key, title: "卡A", summary: "sa", body: "正文A", revision: 3, group: ["dev", "hot"] };
    },
    async mutate() { mutateCalls += 1; return { revision: "should-not-happen" }; },
  };
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  const out = await tool.execute({ action: "repair", operationId: "repair-recheck" });
  assert.equal(out.cleaned, 0, "复核发现挂载已不再悬空：清理 0 条");
  assert.equal(out.remaining, 0, "剩余悬空 0 条");
  assert.equal(mutateCalls, 0, "提交前复核拦下 mutate，不得把刚修好的挂载再摘一次");
  assert.ok(typeof out.revision === "string", "返回复核后的清单 revision");
  const after = await readGroups({ dataRoot: base, scopeId: "amber" });
  assert.ok(after.data.groups.some((g) => g.key === "hot"), "并发建出的 hot 组保留");
});

// ── 0.4 S6 卸载与焚毁（destroyData，第 11 个管理方法）────────────────────────
// 只删 dataRoot：stateRoot 与 DSH 配置不动；confirm 必须等于当前 dataRoot 原文；
// 目录不存在返回 deleted:false 而不是抛错；安全校验与删除走 src/storage/purge.mjs
// 共享模块（与命令行 bin/admin.mjs 同一份实现）。

test("destroyData：confirm 正确删净 dataRoot（目录消失、stateRoot 完好）", async (t) => {
  const { controller, base, trusted } = await setup(t);
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  // 铺数据：dataRoot 下写文件（含 topic 布局），stateRoot 写一个哨兵文件。
  await mkdir(path.join(dataRoot, "scopes", "amber", "topics"), { recursive: true });
  await writeFile(path.join(dataRoot, "scopes", "amber", "topics", "t1.md"), "topic one", "utf8");
  await writeFile(path.join(dataRoot, "persona", "amber.md"), "L0", "utf8");
  await mkdir(path.join(stateRoot, "tool-ops"), { recursive: true });
  await writeFile(path.join(stateRoot, "tool-ops", "a.json"), "{}", "utf8");

  const ownerTrusted = { ...trusted, principal: { kind: "owner" } };
  const result = await controller.management.destroyData(ownerTrusted, { confirm: dataRoot });
  assert.equal(result.deleted, true);
  // start 阶段可能已写入插件自身的初始化文件（scope 目录等），至少包含我们铺的 2 个
  assert.ok(result.files >= 2, `删除计数应覆盖铺入的文件（实际 ${result.files}）`);
  assert.ok(result.bytes >= "topic one".length + "L0".length, "字节计数覆盖铺入内容");
  assert.equal(typeof result.dataRoot, "string");
  assert.ok(result.dataRoot.length > 0);
  await assert.rejects(() => stat(dataRoot), { code: "ENOENT" }, "dataRoot 目录本身一并移除");
  // stateRoot 完好：哨兵文件原样
  assert.equal(await readFile(path.join(stateRoot, "tool-ops", "a.json"), "utf8"), "{}");
});

test("destroyData：confirm 错误被拒（INVALID_INPUT）且目录完好", async (t) => {
  const { controller, base, trusted } = await setup(t);
  const dataRoot = path.join(base, "data");
  await writeFile(path.join(dataRoot, "keep.txt"), "keep", "utf8");
  const ownerTrusted = { ...trusted, principal: { kind: "owner" } };
  for (const bad of [`${dataRoot}/`, dataRoot.toUpperCase(), " ", ""]) {
    await assert.rejects(
      () => controller.management.destroyData(ownerTrusted, { confirm: bad }),
      (e) => e.code === "INVALID_INPUT",
      `confirm="${bad}" 必须被拒（原文逐字符比对，不 trim、不忽略大小写）`,
    );
  }
  assert.equal(await readFile(path.join(dataRoot, "keep.txt"), "utf8"), "keep", "目录完好未删");
  // 非 owner principal → UNAUTHORIZED（权限错误码）
  await assert.rejects(
    () => controller.management.destroyData({ ...trusted, principal: { kind: "guest" } }, { confirm: dataRoot }),
    (e) => e.code === "UNAUTHORIZED",
  );
  await assert.rejects(
    () => controller.management.destroyData({ ...trusted }, { confirm: dataRoot }),
    (e) => e.code === "UNAUTHORIZED",
  );
  assert.equal(await readFile(path.join(dataRoot, "keep.txt"), "utf8"), "keep");
});

test("destroyData：目录不存在返回 deleted:false（不抛错）；幂等重删同根", async (t) => {
  const { controller, base, trusted } = await setup(t);
  const dataRoot = path.join(base, "data");
  const ownerTrusted = { ...trusted, principal: { kind: "owner" } };
  await writeFile(path.join(dataRoot, "gone.txt"), "x", "utf8");
  const first = await controller.management.destroyData(ownerTrusted, { confirm: dataRoot });
  assert.equal(first.deleted, true);
  // 目录已不存在：deleted:false，不抛错
  const second = await controller.management.destroyData(ownerTrusted, { confirm: dataRoot });
  assert.equal(second.deleted, false);
  assert.equal(second.files, 0);
  assert.equal(second.bytes, 0);
});

// 中-2（review-rework a1）：焚毁后 scope 资源缓存必须失效——controller 的
// ctrl.scopes 缓存里 sparkStore 指向已删目录；不清掉，后续访问会从内存旧缓存
// 拿到已焚毁卡片的记录。destroyData 成功后调 controller 的 closeAllScopes
// 清理入口，下一次访问按需重建空资源。
test("destroyData：焚毁后 scope 资源缓存失效——立刻再走资源路径不得拿到旧缓存", async (t) => {
  const { controller, base, trusted } = await setup(t);
  const dataRoot = path.join(base, "data");
  // 铺两张 spark 卡（落盘 + 进 scope 资源缓存）
  await controller.management.executeTool(trusted, {
    name: "spark_save", args: { title: "卡A", content: "内容A", triggers: ["词A"], vitality: "evergreen" },
  });
  await controller.management.executeTool(trusted, {
    name: "spark_save", args: { title: "卡B", content: "内容B", triggers: ["词B"], vitality: "evergreen" },
  });
  const graphBefore = await controller.management.getGraph(trusted, {});
  assert.ok(graphBefore.nodes.length >= 2, "焚毁前卡片在图上（对照组：缓存路径在工作）");

  const ownerTrusted = { ...trusted, principal: { kind: "owner" } };
  const result = await controller.management.destroyData(ownerTrusted, { confirm: dataRoot });
  assert.equal(result.deleted, true);

  // 立刻再走需要资源的路径：必须重建空资源，不得复用指向已删目录的旧缓存
  //（退化实验：去掉 controller 的 invalidateScopeResources 注入，这里会拿到
  // 旧缓存里的 2 张卡 → 本用例变红）。
  const graphAfter = await controller.management.getGraph(trusted, {});
  assert.equal(graphAfter.nodes.length, 0, "旧缓存若未失效，这里会拿到已焚毁卡片的旧记录");
  const listed = await controller.management.listCandidates(trusted, {});
  assert.equal(listed.items.length, 0, "候选队列同样按重建后的空资源给出");
});

// 必修 1/2（review-rework a2）：invalidateScopeResources 的存在性校验必须在
// purgeDataRoot 之前——校验后置会造成「数据已删净、然后才抛 INVALID_STATE」
// 的顺序错误（破坏性动作先做、校验后做）。本用例锁住顺序：dep 缺失时
// destroyData 必须被拒，且 dataRoot 与两个哨兵文件逐字节完好（删除根本没发生）。
// 退化实验：把校验挪回 purge 之后，哨兵会被删、本用例红。
test("destroyData：invalidateScopeResources 缺失时在删除之前拒绝——dataRoot 与哨兵原样保留", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-destroydep-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "state"), { recursive: true });
  await mkdir(path.join(base, "data"), { recursive: true });
  await writeFile(path.join(base, "data", "sentinel-a.txt"), "A-bytes", "utf8");
  await writeFile(path.join(base, "data", "sentinel-b.txt"), "B-bytes", "utf8");
  const state = createStateStore({ stateRoot: path.join(base, "state") });
  const settings = {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    sessionPersonas: [], workspacePersonas: [],
    budgets: { persona: { maxChars: 12000 }, core: { targetChars: 2000, hardCapChars: 4000 } },
    l2: { enabled: false }, organize: { enabled: true },
    forgetting: { enabled: true, policy: normalizeForgetPolicy({}) },
  };
  const { management } = createManagement({
    settings,
    dataRoot: settings.dataRoot,
    state,
    resourcesFor: async () => { throw new Error("not used"); },
    isStarted: () => true,
    generation: () => 1,
    registerGrant: () => { throw new Error("not used"); },
    executeToolForScope: async () => { throw new Error("not used"); },
    nowIso: () => new Date().toISOString(),
    // 故意不注入 invalidateScopeResources（必修 2 的被测前提）
  });
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc", principal: { kind: "owner" } };
  await assert.rejects(
    () => management.destroyData(trusted, { confirm: settings.dataRoot }),
    (e) => e.code === "INVALID_STATE",
    "dep 缺失必须在删除之前拒绝",
  );
  // 数据原样：dataRoot 在、两个哨兵逐字节完好（校验后置的退化实现会先删净再抛错）
  assert.equal(await readFile(path.join(base, "data", "sentinel-a.txt"), "utf8"), "A-bytes");
  assert.equal(await readFile(path.join(base, "data", "sentinel-b.txt"), "utf8"), "B-bytes");
});

// 必修（review-rework a3）：invalidateScopeResources 是 async（复用的
// closeAllScopes 返回 Promise<string[]>）——destroyData 必须 await 错误数组再
// 判定；不 await 拿到的是 Promise，Array.isArray 恒 false，清缓存失败被静默
// 吞掉（检测成死代码）。注入 async 失败源，锁住「失败必须如实上抛」。
test("destroyData：invalidateScopeResources async 失败（[boom]）必须 INVALID_STATE 且错误信息带 boom", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-destroyclose-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "state"), { recursive: true });
  await mkdir(path.join(base, "data"), { recursive: true });
  await writeFile(path.join(base, "data", "gone.txt"), "x", "utf8");
  const state = createStateStore({ stateRoot: path.join(base, "state") });
  const settings = {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    sessionPersonas: [], workspacePersonas: [],
    budgets: { persona: { maxChars: 12000 }, core: { targetChars: 2000, hardCapChars: 4000 } },
    l2: { enabled: false }, organize: { enabled: true },
    forgetting: { enabled: true, policy: normalizeForgetPolicy({}) },
  };
  const { management } = createManagement({
    settings,
    dataRoot: settings.dataRoot,
    state,
    resourcesFor: async () => { throw new Error("not used"); },
    isStarted: () => true,
    generation: () => 1,
    registerGrant: () => { throw new Error("not used"); },
    executeToolForScope: async () => { throw new Error("not used"); },
    nowIso: () => new Date().toISOString(),
    // async 失败源：close 错误数组非空
    invalidateScopeResources: async () => ["boom"],
  });
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc", principal: { kind: "owner" } };
  await assert.rejects(
    () => management.destroyData(trusted, { confirm: settings.dataRoot }),
    (e) => e.code === "INVALID_STATE" && String(e.message).includes("boom"),
    "async 清缓存失败必须 await 后如实上抛（不 await 会拿到 Promise、错误被吞）",
  );
});

// ── 0.4-S7 getGraph 两级视图：缺省全量兼容路径 / level=1 分簇 / level=2 簇内 ──
// 夹具沿用内存 fixture（不触盘）；scope 解析与 ui-flashbacks 同口径（trusted session）。

test("S7 getGraph：level=1 分簇概览（clusters/total 出线、无 nodes/edges）、level=2 簇内节点仍带 hitCount/lastHitAt/createdAt", async () => {
  const { createManagement } = await import("../../src/plugin/management.mjs");
  const NOW = Date.now();
  const DAY = 86400000;
  const cards = [
    { id: "g1", scopeId: "global", state: "active", title: "甲一", summary: null, vitality: "evergreen", revision: 1, triggers: [], entities: ["项目甲"], links: [{ target: "g2" }], content: "c", hitCount: 3, lastHitAt: new Date(NOW - 60_000).toISOString(), createdAt: new Date(NOW - 5 * DAY).toISOString() },
    { id: "g2", scopeId: "global", state: "active", title: "甲二", summary: null, vitality: "ephemeral", revision: 1, triggers: [], entities: ["项目甲"], links: [{ target: "g1", rel: "related" }], content: "c", hitCount: 0, lastHitAt: null, createdAt: new Date(NOW - DAY).toISOString() },
    { id: "g3", scopeId: "global", state: "active", title: "乙卡", summary: null, vitality: "evergreen", revision: 1, triggers: [], entities: ["项目乙"], links: [], content: "c", hitCount: 1, lastHitAt: new Date(NOW - 90_000).toISOString(), createdAt: null },
    { id: "g4", scopeId: "global", state: "active", title: "散卡", summary: null, vitality: "ephemeral", revision: 1, triggers: [], entities: [], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
  ];
  const ledger = { pending: {}, accepted: {}, committed: {}, hits: {} };
  const build = () => createManagement({
    settings: {
      mode: "active", ownerId: "local", defaultPersona: null, sessionPersonas: [], workspacePersonas: [],
      organize: { enabled: true }, forgetting: { enabled: true }, l2: { enabled: true },
      dataRoot: path.join(tmpdir(), "shiori-s7-nonexistent-data"),
      stateRoot: path.join(tmpdir(), "shiori-s7-nonexistent-state"),
      budgets: {},
    },
    dataRoot: path.join(tmpdir(), "shiori-s7-nonexistent-data"),
    state: { l2Store: { diagnostics: async () => ledger } },
    resourcesFor: async () => ({ sparkStore: { listActive: async () => cards } }),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: () => ({}),
    executeToolForScope: async () => ({}),
  }).management;
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };

  // ① 缺省：全量兼容路径（candidates 页 id→title 映射与既有用例依赖），不带 level 字段。
  const full = await build().getGraph(trusted, {});
  assert.deepEqual(Object.keys(full).sort(),
    ["deliveries", "deliveryStats", "edges", "nodes", "scope"], "缺省响应不含 level/clusters/cluster 键");
  assert.equal(full.nodes.find((n) => n.id === "g1").hitCount, 3, "全量路径命中统计照常");
  // degree 出线（#224c65）：全量路径每个节点 degree 必须是非负整数——
  // projectGraph 已按边累加（graph.mjs:260-261），nodeOut 此前丢字段导致全为 undefined。
  for (const node of full.nodes) {
    assert.ok(Number.isInteger(node.degree) && node.degree >= 0,
      `全量路径节点 ${node.id} 的 degree 必须是非负整数（实得 ${JSON.stringify(node.degree)}）`);
  }
  // g1↔g2 互逆两条有向边折叠为一条无向边：两端各计 1；g3/g4 无边计 0。
  assert.equal(full.nodes.find((n) => n.id === "g1").degree, 1, "g1 度=1（g1↔g2 折叠边）");
  assert.equal(full.nodes.find((n) => n.id === "g2").degree, 1, "g2 度=1（g1↔g2 折叠边）");
  assert.equal(full.nodes.find((n) => n.id === "g3").degree, 0, "g3 孤立节点度=0");
  assert.equal(full.nodes.find((n) => n.id === "g4").degree, 0, "g4 孤立节点度=0");

  // ② level=1：clusters/total 出线，nodes/edges 不出线；投递账与吞吐统计不丢。
  const l1 = await build().getGraph(trusted, { level: 1 });
  assert.deepEqual(Object.keys(l1).sort(),
    ["clusters", "deliveries", "deliveryStats", "level", "scope", "total"], "level=1 响应形状");
  assert.equal(l1.level, 1);
  assert.equal(l1.total, 4);
  assert.deepEqual(l1.clusters.map((c) => [c.key, c.count]), [
    ["项目甲", 2], ["__unclustered__", 1], ["项目乙", 1],
  ], "count 降序、同数按 key 字典序（UTF-16 码元：下划线在汉字之前）");
  assert.deepEqual(l1.clusters[0].samples, ["甲一", "甲二"], "samples 最多 3 个标题");
  assert.equal(l1.clusters[1].label, "未分类", "无实体簇 label 固定「未分类」");
  assert.deepEqual(l1.deliveryStats, { rounds: 0, totalDelivered: 0, uniqueCards: 0 });

  // ③ level=2：簇内节点与边；节点仍带 hitCount/lastHitAt/createdAt（命中统计不丢）。
  const l2 = await build().getGraph(trusted, { level: 2, cluster: "项目甲" });
  assert.deepEqual(Object.keys(l2).sort(),
    ["cluster", "deliveries", "deliveryStats", "edges", "level", "nodes", "scope"], "level=2 响应形状");
  assert.equal(l2.level, 2);
  assert.deepEqual(l2.cluster, { key: "项目甲", label: "项目甲", count: 2 });
  assert.deepEqual(l2.nodes.map((n) => n.id), ["g1", "g2"]);
  for (const node of l2.nodes) {
    assert.ok(Object.hasOwn(node, "hitCount"), "hitCount 必须在");
    assert.ok(Object.hasOwn(node, "lastHitAt"), "lastHitAt 必须在");
    assert.ok(Object.hasOwn(node, "createdAt"), "createdAt 必须在");
  }
  const g1 = l2.nodes.find((n) => n.id === "g1");
  assert.equal(g1.hitCount, 3);
  assert.equal(typeof g1.lastHitAt, "string");
  assert.equal(typeof g1.createdAt, "string");
  assert.deepEqual(l2.edges, [{ source: "g1", target: "g2", rel: "related" }], "跨簇边不进 level=2（互逆折叠 rel 取字典序较小者）");
  // degree 出线（#224c65）：level=2 簇内节点同样带整数 degree——
  // clusterProjection 只按簇内边重算（graph.mjs:383-390），g1/g2 各 1。
  for (const node of l2.nodes) {
    assert.ok(Number.isInteger(node.degree) && node.degree >= 0,
      `level=2 节点 ${node.id} 的 degree 必须是非负整数（实得 ${JSON.stringify(node.degree)}）`);
  }
  assert.equal(g1.degree, 1, "level=2 簇内 g1 度=1（簇内折叠边 g1-g2）");
  assert.equal(l2.nodes.find((n) => n.id === "g2").degree, 1, "level=2 簇内 g2 度=1");

  // ④ level=2 未知簇：不抛错，空 nodes/edges + count 0。
  const miss = await build().getGraph(trusted, { level: 2, cluster: "不存在" });
  assert.deepEqual(miss.cluster, { key: "不存在", label: "不存在", count: 0 });
  assert.deepEqual(miss.nodes, []);
  assert.deepEqual(miss.edges, []);

  // ⑤ level=2 没带 cluster：退化为未知簇空视图（不崩）。
  const noCluster = await build().getGraph(trusted, { level: 2 });
  assert.equal(noCluster.cluster.count, 0);
  assert.deepEqual(noCluster.nodes, []);

  // ⑥ P1（rework）：level=1 带了 cluster 也必须忽略——返回 level=1 完整形状
  // （clusters/total 齐全），不许退化成只剩 deliveries/deliveryStats 的残缺响应。
  const l1WithCluster = await build().getGraph(trusted, { level: 1, cluster: "项目甲" });
  assert.equal(l1WithCluster.level, 1, "level 仍是 1（cluster 被忽略，不串到 level=2 分支）");
  assert.ok(Array.isArray(l1WithCluster.clusters) && l1WithCluster.clusters.length > 0,
    "clusters 必须齐全（旧实现读 projection.clusters 得 undefined，本断言必红）");
  assert.equal(l1WithCluster.total, 4, "total 必须齐全");
  assert.equal(Object.hasOwn(l1WithCluster, "nodes"), false, "level=1 不出 nodes");

  // ⑦ degree 出线（#224c65）：同一节点连两条边 → degree===2；孤立节点 → 0。
  // 独立夹具（不改上面 ①②③ 的既有断言口径）：h1 同时连 h2/h3，h4 无边。
  const degreeCards = [
    { id: "h1", scopeId: "global", state: "active", title: "枢纽", summary: null, vitality: "evergreen", revision: 1, triggers: [], entities: [], links: [{ target: "h2" }, { target: "h3" }], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
    { id: "h2", scopeId: "global", state: "active", title: "叶二", summary: null, vitality: "ephemeral", revision: 1, triggers: [], entities: [], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
    { id: "h3", scopeId: "global", state: "active", title: "叶三", summary: null, vitality: "ephemeral", revision: 1, triggers: [], entities: [], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
    { id: "h4", scopeId: "global", state: "active", title: "孤立", summary: null, vitality: "ephemeral", revision: 1, triggers: [], entities: [], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
  ];
  const buildDegree = () => createManagement({
    settings: {
      mode: "active", ownerId: "local", defaultPersona: null, sessionPersonas: [], workspacePersonas: [],
      organize: { enabled: true }, forgetting: { enabled: true }, l2: { enabled: false },
      dataRoot: path.join(tmpdir(), "shiori-s7-nonexistent-data"),
      stateRoot: path.join(tmpdir(), "shiori-s7-nonexistent-state"),
      budgets: {},
    },
    dataRoot: path.join(tmpdir(), "shiori-s7-nonexistent-data"),
    state: { l2Store: { diagnostics: async () => ledger } },
    resourcesFor: async () => ({ sparkStore: { listActive: async () => degreeCards } }),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: () => ({}),
    executeToolForScope: async () => ({}),
  }).management;
  const deg = await buildDegree().getGraph(trusted, {});
  assert.equal(deg.nodes.find((n) => n.id === "h1").degree, 2, "连两条边的节点 degree 必须为 2（出线丢字段时必红）");
  assert.equal(deg.nodes.find((n) => n.id === "h4").degree, 0, "孤立节点 degree 必须为 0");
  assert.equal(deg.edges.length, 2, "h1 的两条边都要出线");
});

test("S7 protocol：getGraph 输入新增可选 level/cluster；非法 level 被拒（wire 11 方法：S6 的 destroyData 已并入）", () => {
  // 合法形状
  for (const ok of [{}, { level: 1 }, { level: 2, cluster: "x" }, { cluster: "x" }]) {
    validateManagementPayload("getGraph", ok);
  }
  // 非法形状一律 INVALID_INPUT
  for (const bad of [
    { level: 3 }, { level: 0 }, { level: "1" }, { level: null },
    { cluster: 42 }, { cluster: null }, { level: 1, rogue: true },
  ]) {
    assert.throws(
      () => validateManagementPayload("getGraph", bad),
      (e) => e.code === "INVALID_INPUT",
      `应拒绝：${JSON.stringify(bad)}`,
    );
  }
  // wire 方法清单：S6 并入后为 11（destroyData 第 11 位）；S7 只给 getGraph 加可选字段。
  assert.deepEqual([...MANAGEMENT_METHOD_NAMES].sort(), [
    "analyze", "destroyData", "executePlan", "executeTool", "getGraph", "getMemoryView",
    "getStatus", "getTimeline", "listCandidates", "previewPlan", "reviewCandidate",
  ].sort());

  // degree 出线（#224c65）：输出契约必须先声明——getGraphNodeItem 是
  // additionalProperties:false，未声明的字段一上线就是「契约外字段」。
  // 注：validateManagementPayload 校验的是 inputSchema，仓库无 outputSchema
  // 运行时校验器；此处按 timeline.test.mjs:287-292 的既有口径断言声明本身，
  // 值域由 minimum:0 表达（-1 不在合法值域），运行时「输出的 degree 全是
  // 非负整数」由 S7 getGraph 用例的真实输出断言覆盖。
  const graphOut = MANAGEMENT_METHODS.getGraph.outputSchema;
  const nodeBranches = graphOut.oneOf.filter((branch) => Object.hasOwn(branch.properties ?? {}, "nodes"));
  assert.equal(nodeBranches.length, 2, "带节点的一支是全量、一支是 level=2");
  for (const branch of nodeBranches) {
    const nodeItem = branch.properties.nodes.items;
    assert.deepEqual(nodeItem.properties.degree, { type: "integer", minimum: 0 },
      "degree 必须声明为 integer 且 minimum 0（degree:-1 不在合法值域）");
    assert.equal(nodeItem.additionalProperties, false);
    assert.ok(nodeItem.required.includes("degree"), "nodeOut 两条路径恒输出 degree，故进 required");
  }
});

// ── 0.4-S1：getStatus.personas（人设卡清单）──────────────────────────────────
// 来源 <dataRoot>/persona/*.md 的 basename 去 .md，名字升序；dataRoot 未初始化
// （inert）或目录不存在 → []；只读目录，绝不建目录/写盘。

function shadowSettings({ dataRoot, stateRoot, rootsSource }) {
  return {
    mode: "shadow", allowActive: false,
    dataRoot, stateRoot,
    rootsSource: rootsSource ?? { dataRoot: "explicit", stateRoot: "explicit" },
    ownerId: "local", defaultPersona: null,
    sessionPersonas: [], workspacePersonas: [],
    budgets: { persona: { maxChars: 12000 }, core: { targetChars: 2000, hardCapChars: 4000 } },
    l2: { enabled: false }, organize: { enabled: false },
    forgetting: { enabled: false, policy: normalizeForgetPolicy({}) },
  };
}

/** 直构 shadow 门面（不启动 controller，getStatus 走纯内存 + 只读目录列举）。 */
function createShadowManagement({ dataRoot, stateRoot, stateDir }) {
  const { management } = createManagement({
    settings: shadowSettings({ dataRoot, stateRoot }),
    dataRoot,
    state: createStateStore({ stateRoot: stateDir }),
    resourcesFor: async () => { throw new Error("not used"); },
    isStarted: () => false,
    generation: () => 0,
    registerGrant: () => { throw new Error("not used"); },
    executeToolForScope: async () => { throw new Error("not used"); },
  });
  return management;
}

test("getStatus.personas：列出 dataRoot/persona/*.md 的名字（升序，忽略非 md）", async (t) => {
  const { controller, base, trusted } = await setup(t);
  const personaDir = path.join(base, "data", "persona");
  await mkdir(personaDir, { recursive: true });
  await writeFile(path.join(personaDir, "zeta.md"), "Z", "utf8");
  await writeFile(path.join(personaDir, "a-card.md"), "A", "utf8");
  await writeFile(path.join(personaDir, "notes.txt"), "n", "utf8");
  const status = await controller.management.getStatus(trusted, {});
  assert.deepEqual(status.personas, ["a-card", "zeta"]);
  // wire 契约：outputSchema 显式声明 personas 并进 required（闭形状，不许漏字段）。
  const statusOut = MANAGEMENT_METHODS.getStatus.outputSchema;
  assert.deepEqual(statusOut.properties.personas, { type: "array", items: { type: "string" } });
  assert.ok(statusOut.required.includes("personas"), "getStatus 恒输出 personas，进 required");
});

test("getStatus.personas：目录不存在返回 []，且绝不创建目录", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-personas-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const management = createShadowManagement({ dataRoot, stateRoot: stateDir, stateDir });
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };
  const status = await management.getStatus(trusted, {});
  assert.equal(status.mode, "shadow");
  assert.deepEqual(status.personas, []);
  // 只读：persona/ 目录不会被顺手建出来
  await assert.rejects(() => stat(path.join(dataRoot, "persona")), { code: "ENOENT" }, "getStatus 不得创建 persona 目录");
});

test("getStatus.personas：空 persona 目录返回 []", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-personas-empty-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await mkdir(path.join(dataRoot, "persona"), { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const management = createShadowManagement({ dataRoot, stateRoot: stateDir, stateDir });
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };
  const status = await management.getStatus(trusted, {});
  assert.deepEqual(status.personas, []);
});

test("getStatus.personas：inert（dataRoot 未初始化）返回 []", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-personas-inert-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stateDir = path.join(base, "state");
  await mkdir(stateDir, { recursive: true });
  const { management } = createManagement({
    settings: shadowSettings({ dataRoot: null, stateRoot: null, rootsSource: { dataRoot: "default", stateRoot: "default" } }),
    dataRoot: null,
    state: createStateStore({ stateRoot: stateDir }),
    resourcesFor: async () => { throw new Error("not used"); },
    isStarted: () => false,
    generation: () => 0,
    registerGrant: () => { throw new Error("not used"); },
    executeToolForScope: async () => { throw new Error("not used"); },
  });
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };
  const status = await management.getStatus(trusted, {});
  assert.equal(status.mode, "inert");
  assert.deepEqual(status.personas, []);
});

// ── R1（交叉审查补漏）：目录读取故障降级——getStatus 不陪葬，故障进诊断 ──────

test("getStatus.personas：readdir 抛 EACCES → getStatus 照常返回、personas 空、diagnostics.personasError 非空且有界", async (t) => {
  // 用注入桩让 readdir 真抛 EACCES（不是构造不存在的目录——那是 ENOENT，
  // 行为不同）：旧实现 listPersonaNames 对非 ENOENT/ENOTDIR 错误原样上抛，
  // 会把整个 getStatus 炸掉，controller 注入的 diagnostics.roots 等字段根本
  // 到不了面板。修复口径：personas 降级为 [] + diagnostics.personasError
  // 写有界错误摘要，状态照常返回。
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-personas-eacces-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const eacces = new Error(`EACCES: permission denied, scandir '${path.join(dataRoot, "persona")}'`);
  eacces.code = "EACCES";
  const { management } = createManagement({
    settings: shadowSettings({ dataRoot, stateRoot: stateDir }),
    dataRoot,
    state: createStateStore({ stateRoot: stateDir }),
    resourcesFor: async () => { throw new Error("not used"); },
    isStarted: () => false,
    generation: () => 0,
    registerGrant: () => { throw new Error("not used"); },
    executeToolForScope: async () => { throw new Error("not used"); },
    readdir: async () => { throw eacces; },
  });
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };
  const status = await management.getStatus(trusted, {});
  assert.equal(status.mode, "shadow");
  assert.deepEqual(status.personas, [], "读不了目录既不冒充有卡，也不让整个状态请求陪葬");
  const digest = status.diagnostics.personasError;
  assert.ok(typeof digest === "string" && digest.length > 0, "personasError 必须非空（故障不许静默吞掉）");
  assert.ok(digest.includes("EACCES"), `摘要须带错误类别码，实际：${digest}`);
  assert.ok(digest.length <= 200, `错误摘要必须有界，实际 ${digest.length} 字符`);
  // 降级不影响其余诊断字段出线——面板可见性正是本单主题（diagnostics.roots 必须可达）。
  assert.equal(status.diagnostics.dataRoot, dataRoot);
  assert.equal(status.diagnostics.stateRoot, stateDir);
  assert.equal(status.diagnostics.rootsSource.dataRoot, "explicit");
});

test("getStatus.personas：ENOENT（目录不存在）不写 personasError——正常路径 wire 形状逐字不变", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-personas-enoent-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateDir = path.join(base, "state");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const management = createShadowManagement({ dataRoot, stateRoot: stateDir, stateDir });
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };
  const status = await management.getStatus(trusted, {});
  assert.deepEqual(status.personas, []);
  assert.equal(status.diagnostics.personasError, undefined, "ENOENT 是「没有卡」，不是故障，不出 personasError 键");
  await assert.rejects(() => stat(path.join(dataRoot, "persona")), { code: "ENOENT" }, "R1 不得顺手创建 persona 目录");
});

// ── 0.5 批次 3 · R1：降级挂载下面板 executeTool 的判定顺序 ─────────────────────
// 降级挂载不宣称 started：旧顺序先 requireStarted，面板只会拿到 INVALID_STATE
// 「尚未启动」——把可用性故障错报成状态故障。controller 注入 getRootDegradation
// 后，executeTool 必须先判降级、返回带 details.roots 的 UNSUPPORTED；非降级
// （缺省注入或空数组）行为与错误码逐字不变。

test("R1：getRootDegradation 非空 → executeTool 先报 UNSUPPORTED + details.roots；为空/缺省仍 INVALID_STATE", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-r1-mgmt-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const settings = { ...shadowSettings({ dataRoot, stateRoot }), mode: "active", allowActive: true };
  const build = (extra) => createManagement({
    settings,
    dataRoot,
    state: createStateStore({ stateRoot }),
    resourcesFor: async () => { throw new Error("not used"); },
    isStarted: () => false,
    generation: () => 1,
    registerGrant: () => { throw new Error("not used"); },
    executeToolForScope: async () => { throw new Error("must not reach executeToolForScope in degraded mode"); },
    ...extra,
  }).management;
  const trusted = { session: { id: "s-degraded" }, source: "panel-rpc" };
  const roots = [{ root: "dataRoot", path: dataRoot, reason: `ENOTDIR: not a directory, mkdir '${dataRoot}'`, code: "ENOTDIR" }];

  const degraded = build({ getRootDegradation: () => roots });
  await assert.rejects(
    () => degraded.executeTool(trusted, { name: "memory_read", args: {} }),
    (e) => {
      assert.equal(e.code, "UNSUPPORTED", "降级态必须是 UNSUPPORTED，不是 INVALID_STATE");
      assert.ok(String(e.message).includes("not writable"), "文案须点出根不可写");
      assert.deepEqual(e.details.roots, roots, "details.roots 带逐根诊断（哪个根、为什么）");
      return true;
    },
  );
  // 非降级路径：未启动仍是 INVALID_STATE——缺省注入与返回空数组同口径。
  for (const extra of [{}, { getRootDegradation: () => [] }]) {
    const normal = build(extra);
    await assert.rejects(
      () => normal.executeTool(trusted, { name: "memory_read", args: {} }),
      (e) => e.code === "INVALID_STATE",
    );
  }
});
