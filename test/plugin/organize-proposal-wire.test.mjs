// P5 · B2（audit 2026-11-07 B P2-2）回归测试：previewPlan 的 wire inputSchema
// 与 buildDraft 同口径。
//
// 契约：link 的 rel 必须是非空字符串（1..64，与 buildDraft 的 checkText
// 1..CARD_LIMITS.relChars 一致）且与 target 同为必需；merge-topic 的
// expectedRevision 必须是非空字符串（1..16384，与 validatePlanTopic 一致）。
// 以上非法形状在 wire 层即拒（INVALID_INPUT，与 buildDraft 错误码一致），
// 每条用例「wire 拒 / buildDraft 拒」成对出现。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateManagementPayload } from "../../src/plugin/protocol.mjs";
import { buildDraft } from "../../src/organize/queue.mjs";
import { createShioriPluginController } from "../../src/plugin/controller.mjs";
import { createHash } from "node:crypto";

// --- wire 层夹具 -------------------------------------------------------------
// candidateId / operationId 只需满足 wire 形状（64hex / 可见 ASCII）；
// proposal 的形状本身才是被测对象。

const CANDIDATE_ID = "a".repeat(64);
const preview = (proposal) => validateManagementPayload("previewPlan", {
  kind: "organize", candidateId: CANDIDATE_ID, proposal, expectedQueueRevision: 1, operationId: "op-wire",
});
const expectInvalid = (fn) => {
  assert.throws(fn, (err) => err instanceof Error && err.code === "INVALID_INPUT");
};

// --- buildDraft 层夹具（与 test/organize/queue.test.mjs 同款最小场景）--------

const SCOPE = "amber";
function makeCard(id, over = {}) {
  return {
    id, scopeId: SCOPE, revision: 1,
    title: `title-${id}`, summary: `summary-${id}`,
    triggers: [`tg-${id}`], entities: [`en-${id}`],
    links: [], content: `content-${id}`,
    vitality: "evergreen", state: "active",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null, supersedes: null, supersededBy: null,
    hitCount: 0, lastHitAt: null, useCount: 0, lastUsedAt: null,
    ...over,
  };
}
const ref = (id, revision = 1) => ({ id, revision });

function linkScene() {
  const base = {
    kind: "link", scopeId: SCOPE,
    sources: [ref("a"), ref("b")],
    evidence: { sharedEntities: ["cat"] },
  };
  // candidate.id = digest({kind,scopeId,sources,evidence})（独立实现，与
  // test/organize/queue.test.mjs 同款交叉验证思路）。
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === "object") {
      return Object.keys(v).sort().reduce((out, k) => { out[k] = canonical(v[k]); return out; }, {});
    }
    return v;
  };
  const id = createHash("sha256")
    .update(Buffer.from(JSON.stringify(canonical(base)), "utf8"))
    .digest("hex");
  const candidate = { ...base, id };
  const records = [makeCard("a"), makeCard("b"), makeCard("c")];
  return { candidate, records };
}
const draft = (proposal) => buildDraft({ ...linkScene(), proposal });

// ===========================================================================
// link · rel（wire 拒 / buildDraft 拒 成对）
// ===========================================================================

test("B2 wire：link 的 rel 缺省 → INVALID_INPUT；buildDraft 同 proposal 同样 INVALID_INPUT", () => {
  expectInvalid(() => preview({ kind: "link", links: [{ id: "a", after: [{ target: "c" }] }] }));
  expectInvalid(() => draft({ kind: "link", links: [{ id: "a", after: [{ target: "c" }] }] }));
});

test("B2 wire：link 的 rel 为 null → INVALID_INPUT；buildDraft 同 proposal 同样 INVALID_INPUT", () => {
  expectInvalid(() => preview({ kind: "link", links: [{ id: "a", after: [{ target: "c", rel: null }] }] }));
  expectInvalid(() => draft({ kind: "link", links: [{ id: "a", after: [{ target: "c", rel: null }] }] }));
});

test("B2 wire：link 的 rel 为空串 / 65 字符（超限）→ INVALID_INPUT；buildDraft 同 proposal 同样 INVALID_INPUT", () => {
  for (const rel of ["", "r".repeat(65)]) {
    expectInvalid(() => preview({ kind: "link", links: [{ id: "a", after: [{ target: "c", rel }] }] }));
    expectInvalid(() => draft({ kind: "link", links: [{ id: "a", after: [{ target: "c", rel }] }] }));
  }
});

test("B2 wire：link 的 rel 为 64 字符（上限内）→ wire 放行（合法性由草案/执行链路判定）", () => {
  const rel = "r".repeat(64);
  assert.doesNotThrow(() => preview({ kind: "link", links: [{ id: "a", after: [{ target: "c", rel }] }] }));
});

// ===========================================================================
// merge-topic · expectedRevision（wire 拒 / buildDraft 拒 成对）
// ===========================================================================

const mergeProposal = (expectedRevision) => ({
  kind: "merge-topic",
  topic: {
    key: "merge-target",
    expectedRevision,
    before: "old", after: "new", title: "Merge Target", summary: "s", updated: "2026-11-08T00:00:00.000Z",
  },
});

test("B2 wire：merge-topic 的 expectedRevision 为 null → INVALID_INPUT；buildDraft 同 proposal 同样 INVALID_INPUT", () => {
  expectInvalid(() => preview(mergeProposal(null)));
  expectInvalid(() => draft(mergeProposal(null)));
});

test("B2 wire：merge-topic 的 expectedRevision 缺省 → INVALID_INPUT；buildDraft 同 proposal 同样 INVALID_INPUT", () => {
  const { topic, ...rest } = mergeProposal("rev");
  delete topic.expectedRevision;
  expectInvalid(() => preview({ kind: "merge-topic", topic }));
  expectInvalid(() => draft({ kind: "merge-topic", topic }));
});

test("B2 wire：merge-topic 的 expectedRevision 为 16385 字符（超限）→ INVALID_INPUT；buildDraft 同 proposal 同样 INVALID_INPUT", () => {
  const rev = "r".repeat(16385);
  expectInvalid(() => preview(mergeProposal(rev)));
  expectInvalid(() => draft(mergeProposal(rev)));
});

test("B2 wire：merge-topic 的 expectedRevision 合法（1..16384）→ wire 放行", () => {
  assert.doesNotThrow(() => preview(mergeProposal("rev-1")));
});

// ===========================================================================
// preview 阶段端到端：rel 缺省的 proposal 在 previewPlan RPC 即拒（INVALID_INPUT）
// ===========================================================================

test("B2 端到端：previewPlan 收到 rel 缺省的 link proposal → INVALID_INPUT（不再漏到草案层才拒）", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-wire-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bindings = () => ({
    registerSystemSection() { return true; },
    registerAssembleWaterfall() { return true; },
    registerPreStep() { return true; },
    subscribeSessionEvents() { return true; },
    async registerTool() { return true; },
    async loadCreateUserMessage() { return (i) => ({ id: "m", role: "user", content: i.content, source: i.source }); },
    disposeAll() { return { disposed: true, errors: [] }; },
    get diagnostics() { return { registeredSections: [], registeredTools: [], waterfall: true, preStep: true, sessionEvents: true }; },
  });
  const controller = await createShioriPluginController(
    { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} },
    {
      mode: "active", allowActive: true,
      dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
      ownerId: "local", defaultPersona: "amber",
      organize: { enabled: true },
      forgetting: { enabled: true },
    },
    { bindings },
  );
  await controller.start();
  const trusted = { session: { id: "s-wire" }, source: "panel-rpc" };

  for (let i = 0; i < 9; i++) {
    await controller.management.executeTool(trusted, {
      name: "spark_save",
      args: { title: `W${i}`, content: `wire 口径 ${i}。`, triggers: [`w${i}`], entities: ["wire实体"], vitality: "evergreen" },
    });
  }
  const analyzed = await controller.management.analyze(trusted, { kind: "organize", operationId: "an-wire" });
  const candidate = analyzed.items[0].candidate;
  await assert.rejects(
    () => controller.management.previewPlan(trusted, {
      kind: "organize", candidateId: candidate.id,
      proposal: { kind: "link", links: [{ id: candidate.sources[0].id, after: [{ target: candidate.sources[1].id }] }] },
      expectedQueueRevision: analyzed.queueRevision, operationId: "pv-wire",
    }),
    (err) => err instanceof Error && err.code === "INVALID_INPUT",
  );
  await controller.stop();
});
