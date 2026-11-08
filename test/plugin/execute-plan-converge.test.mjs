// P5 · B1（audit 2026-11-07 B P2-1）回归测试：executePlan 收敛失败不翻转回执。
//
// 契约：markExecuted 落账后计划必然已执行；执行后的队列收敛若抛错，调用
// 必须按 executed 成功返回（result 完整），收敛失败降级为回执内
// queueConvergence.applied=false + 可读 warning。幂等判据：planStore.executed
// 标志先于收敛落账，重试同 planId 恒撞「already executed」REVISION_CONFLICT
// 硬闸，不会二次执行（用执行器调用计数证明）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createShioriPluginController } from "../../src/plugin/controller.mjs";
import { createManagement } from "../../src/plugin/management.mjs";
import { createStateStore } from "../../src/plugin/state.mjs";
import { analyzeForgetting, normalizeForgetPolicy } from "../../src/forgetting/decay.mjs";
import { digestPlan as organizeDigestPlan } from "../../src/organize/executor.mjs";

function fakeBindingsFactory() {
  return () => ({
    registerSystemSection() { return true; },
    registerAssembleWaterfall() { return true; },
    registerPreStep() { return true; },
    subscribeSessionEvents() { return true; },
    async registerTool() { return true; },
    async loadCreateUserMessage() { return (i) => ({ id: "m", role: "user", content: i.content, source: i.source }); },
    disposeAll() { return { disposed: true, errors: [] }; },
    get diagnostics() { return { registeredSections: [], registeredTools: [], waterfall: true, preStep: true, sessionEvents: true }; },
  });
}

function fakeCtx() {
  return { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} };
}

test("B1 全链：executePlan 成功路径回执带 queueConvergence.applied=true（无告警）；重试撞 already-executed 硬闸", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-conv-ok-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    organize: { enabled: true },
    forgetting: { enabled: true },
  }, { bindings: fakeBindingsFactory() });
  await controller.start();
  const trusted = { session: { id: "s-conv-ok" }, source: "panel-rpc" };

  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: { title: `C${i}`, content: `收敛正常 ${i}。`, triggers: [`c${i}`], entities: ["收敛实体"], vitality: "evergreen" },
    });
  }
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "an-conv-ok" });
  const candidate = analyzed.items[0].candidate;
  const preview = await controller.management.previewPlan(trusted, {
    kind: "organize", candidateId: candidate.id,
    proposal: { kind: "link", links: [{ id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id, rel: "相关" }] }] },
    expectedQueueRevision: analyzed.queueRevision, operationId: "pv-conv-ok",
  });
  const executed = await controller.management.executePlan(trusted, {
    planId: preview.planId, planDigest: preview.planDigest, operationId: "ex-conv-ok", confirmed: true,
  });
  assert.equal(executed.result.status, "completed");
  assert.equal(executed.queueConvergence.applied, true, "normal path must report applied=true");
  assert.equal(executed.queueConvergence.warning, undefined, "no warning on the normal path");

  // 幂等：重试同 planId 拒绝，不二次执行。
  await assert.rejects(
    () => controller.management.executePlan(trusted, {
      planId: preview.planId, planDigest: preview.planDigest, operationId: "ex-conv-ok", confirmed: true,
    }),
    (e) => e.code === "REVISION_CONFLICT" && /already executed/.test(e.message),
  );
  await controller.stop();
});

test("B1 注入：收敛抛错时回执仍按 executed 成功返回（applied=false + 可读 warning），执行器只跑一次，重试被硬闸拒绝", async (t) => {
  // createManagement 级单元夹具：forgetting 执行用假 store（archiveEphemeral
  // 成功并计数；收敛阶段的 listActive 注入抛错），plan 账用真实 state store。
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-conv-fail-"));
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

  const card = {
    id: "spk-convfail00001", scopeId, revision: 1, state: "active", vitality: "ephemeral",
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

  let executions = 0;
  const fakeSparkStore = {
    async archiveEphemeral(planClone, opts) {
      executions += 1;
      return { operationId: opts.operationId, archivedAt: nowIso(), cards: planClone.sources.map((s) => ({ id: s.id, revision: s.revision + 1, state: "archived" })) };
    },
    listActive() {
      throw new Error("injected listActive failure");
    },
  };
  const { management } = createManagement({
    settings,
    dataRoot: settings.dataRoot,
    state,
    resourcesFor: async () => ({ sparkStore: fakeSparkStore }),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: (spec) => {
      const grant = { ...spec, revoked: false };
      grant.revoke = () => { grant.revoked = true; };
      return grant;
    },
    executeToolForScope: async () => { throw new Error("not used"); },
    nowIso,
  });
  const trusted = { session: { id: "s-convfail" }, source: "panel-rpc" };

  // 收敛阶段抛错 → 调用成功返回（不翻转回执），告警可读。
  const executed = await management.executePlan(trusted, { planId, planDigest, operationId: "ex-conv-fail-1", confirmed: true });
  assert.equal(executed.planId, planId);
  assert.equal(
    executed.result.operationId, "ex-conv-fail-1",
    "executor receipt must survive convergence failure (forgetting receipt carries operationId)",
  );
  assert.ok(executed.result.archivedAt, "executor receipt must survive convergence failure");
  assert.equal(executed.queueConvergence.applied, false);
  assert.match(
    executed.queueConvergence.warning,
    /injected listActive failure/,
    "warning must carry the underlying reason verbatim",
  );
  assert.match(
    executed.queueConvergence.warning,
    /下次 analyze/,
    "warning must tell the user what happens next (readable, actionable)",
  );

  // 幂等判据：executed 标志已落账 → 重试撞 already-executed 硬闸；执行器
  // 恰被调用一次（收敛失败的重试不会二次执行计划）。
  assert.equal(executions, 1, "executor must run exactly once");
  const entry = await state.planStore.get(scopeId, planId);
  assert.equal(entry.executed, true);
  assert.equal(entry.executedWith, "ex-conv-fail-1");
  await assert.rejects(
    () => management.executePlan(trusted, { planId, planDigest, operationId: "ex-conv-fail-2", confirmed: true }),
    (e) => e.code === "REVISION_CONFLICT" && /already executed/.test(e.message),
  );
  assert.equal(executions, 1, "retry must not execute the plan a second time");
});
