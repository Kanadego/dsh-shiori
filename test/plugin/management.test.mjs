// P5 · management + protocol 测试（slot P）：DTO 校验 / P3-P4 门面 / 授权执行 /
// 队列与 plan 持久恢复 / shadow 限制。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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

test("protocol：9 个方法全覆盖；闭包拒绝未知键；queueRevision/planDigest/operationId 规则", () => {
  assert.deepEqual([...MANAGEMENT_METHOD_NAMES].sort(), [
    "analyze", "executePlan", "executeTool", "getGraph", "getMemoryView",
    "getStatus", "listCandidates", "previewPlan", "reviewCandidate",
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
  // thin-core 明确 UNSUPPORTED（非 INVALID_INPUT 冒名）。
  assert.throws(
    () => validateManagementPayload("previewPlan", {
      kind: "organize", candidateId: "a".repeat(64), expectedQueueRevision: 0, operationId: "a1",
      proposal: { kind: "thin-core", before: "x", after: "y" },
    }),
    (e) => e.code === "UNSUPPORTED",
  );
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
  assert.equal(restored.queueRevision, reviewed.queueRevision);
  assert.equal(restored.items.find((it) => it.candidate.id === candidate.id).status, "reviewed");
  assert.ok(restored.plans.some((p) => p.planId === preview.planId && p.executed === true));
  await controller2.stop();
});

test("organize：merge-topic 计划仅更新已有 topic（目标缺失明确报错），thin-core 拒绝执行", async (t) => {
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
  const executed = await controller.management.executePlan(trusted, {
    planId: preview.planId, planDigest: preview.planDigest, operationId: "ex-m", confirmed: true,
  });
  assert.equal(executed.result.kind, "merge-topic");
  assert.equal(executed.result.status, "completed");
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

  // 1) 首轮 analyze（rev 0→1）+ review 首个候选。
  const first = await controller.management.analyze(trusted, { kind: "organize", operationId: "pa-an-1" });
  const reviewedId = first.items[0].candidate.id;
  const reviewedAfterReview = await controller.management.reviewCandidate(trusted, {
    candidateId: reviewedId, decision: "reviewed",
    expectedQueueRevision: first.queueRevision, operationId: "pa-rv-1",
  });
  assert.equal(reviewedAfterReview.queueRevision, first.queueRevision + 1);

  // 2) link 计划执行（源卡保持 active，队列候选不受影响）。
  const candidate = first.items[0].candidate;
  const proposal = {
    kind: "link",
    links: [{ id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id, rel: "相关" }] }],
  };
  const previewLink = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: candidate.id, proposal,
    expectedQueueRevision: reviewedAfterReview.queueRevision, operationId: "pa-pv-1",
  });
  const executedLink = await controller.management.executePlan(trusted, {
    planId: previewLink.planId, planDigest: previewLink.planDigest,
    operationId: "pa-ex-1", confirmed: true,
  });
  assert.equal(executedLink.result.status, "completed");

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
  //    - 仍存在的候选保留 reviewed status（不退回 pending）。
  const second = await controller.management.analyze(trusted, { kind: "organize", operationId: "pa-an-2" });
  assert.equal(second.items.length, second.analysis.candidates);
  for (const item of second.items) {
    const refsArchived = item.candidate.sources.some((s) => s.id === savedEphemeral.id);
    assert.equal(refsArchived, false, "no candidate may reference the archived card");
  }
  const keptReviewed = second.items.find((it) => it.candidate.id === reviewedId);
  if (keptReviewed !== undefined) {
    assert.equal(keptReviewed.status, "reviewed");
  }

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

  // 执行器成功 + markExecuted 落账后，收敛阶段 listActive 抛错 → 调用失败；
  // finally 必须 revoke grant（修复前 revokes === 0 = 泄漏）。
  await assert.rejects(
    () => management.executePlan(trusted, { planId, planDigest, operationId: "ex-leak-1", confirmed: true }),
    /injected listActive failure/,
  );
  assert.equal(revokes, 1, "grant must be revoked exactly once via finally");
  const entry = await state.planStore.get(scopeId, planId);
  assert.equal(entry.executed, true, "markExecuted happened before convergence (documented semantics)");
  await assert.rejects(
    () => management.executePlan(trusted, { planId, planDigest, operationId: "ex-leak-2", confirmed: true }),
    (e) => e.code === "REVISION_CONFLICT",
  );
});
