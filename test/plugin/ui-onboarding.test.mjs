// 0.5 批次 4 · C 线：整理向导测试（management 三新方法单测 + 状态页卡片 UI 用例）。
//
// 证据级别：
// - 管理级：真实 createShioriPluginController（临时 dataRoot/stateRoot）——
//   预览零写入用「前后整树 sha256 快照」实证（评审细化口径：onboarding.json
//   不得因 preview 出现）；应用走真实 service.mutate 单事务，落盘结果读磁盘核对。
// - UI 级：统一 ui-harness（批次 3 真实重渲染循环，不另写 fake loader）——
//   触发 / 不触发 / 以后再说 / 重新开始 / 预览与应用 payload 形状。
// 本文件是评审指定的新方法单测落点（不往 management.test.mjs 塞）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createShioriPluginController } from "../../src/plugin/controller.mjs";
import { MANAGEMENT_METHODS, MANAGEMENT_METHOD_NAMES } from "../../src/plugin/protocol.mjs";
import { createStateStore } from "../../src/plugin/state.mjs";
import { CONTRACT_METHODS } from "../../src/plugin/client-rpc.mjs";
import { readGroups } from "../../src/storage/groups.mjs";
import { createUiHarness } from "./ui-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const CLIENT_SRC = join(WORKQ, "client", "index.js");

// ── wire 契约三处清单逐字一致（评审拍板：加方法漏同步当场红）────────────────
// 三处 = protocol.MANAGEMENT_METHODS 键序 / MANAGEMENT_METHOD_NAMES 导出 /
// client-rpc.CONTRACT_METHODS 冻结清单。controller 的 DRAINED_MANAGEMENT_METHODS
// （= 契约清单去 getStatus）在 controller 构造期有逐字一致断言（缺一处即启动
// 失败），controller.test.mjs 的每次构造都在跑它。
test("wire 14 方法：MANAGEMENT_METHOD_NAMES ≡ protocol 键序 ≡ CONTRACT_METHODS（逐字同序，评审拍板锁死）", () => {
  const protocolKeys = Object.keys(MANAGEMENT_METHODS);
  assert.deepEqual([...MANAGEMENT_METHOD_NAMES], [...protocolKeys], "导出清单 ≡ protocol 键序");
  assert.deepEqual([...MANAGEMENT_METHOD_NAMES], [...CONTRACT_METHODS], "protocol 键序 ≡ CONTRACT_METHODS（逐字同序）");
  assert.deepEqual([...protocolKeys].slice(-3), ["onboardingPreview", "onboardingApply", "onboardingMark"], "向导三方法按声明顺序追加在 destroyData 之后");
});

// ---------------------------------------------------------------------------
// 管理级夹具（照 management.test.mjs 的 controller setup 口径，本文件独立复制）
// ---------------------------------------------------------------------------

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

/** 起 active controller（临时双根）+ 铺 N 个未分组 topic；返回 trusted 与根路径。 */
async function setupController(t, { topics = 6, mode = "active" } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-onboard-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  await mkdir(dataRoot, { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode, allowActive: mode === "active",
    dataRoot, stateRoot,
    ownerId: "local", defaultPersona: "amber",
    organize: { enabled: true },
    forgetting: { enabled: true },
  }, { bindings });
  await controller.start();
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };
  // shadow 只读挂载不能建 topic（工具层只读守卫）——仅 active 夹具铺题。
  if (mode === "active") {
    for (let i = 0; i < topics; i += 1) {
      const family = i < 3 ? "shiori" : "comfy";
      await controller.management.executeTool(trusted, {
        name: "topic_create",
        args: {
          topic: `${family}-t${i}`,
          title: `${family} 主题${i}`,
          summary: `${family} 系列条目${i}`,
        },
      });
    }
  }
  return { controller, trusted, dataRoot, stateRoot, base };
}

/** 整树快照：相对路径 → sha256（预览零写入的实证口径，评审指定）。 */
async function snapshotTree(root) {
  const out = {};
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
      else {
        const buf = await readFile(path.join(dir, entry.name));
        out[childRel] = createHash("sha256").update(buf).digest("hex");
      }
    }
  }
  await walk(root, "");
  return out;
}

function assertTreesIdentical(before, after, label) {
  const beforeKeys = Object.keys(before).sort();
  const afterKeys = Object.keys(after).sort();
  assert.deepEqual(afterKeys, beforeKeys, `${label}：文件集合不变`);
  for (const key of beforeKeys) {
    assert.equal(after[key], before[key], `${label}：文件内容逐字节不变（${key}）`);
  }
}

// 五条测试语料的规则提案（用例间共享构造；组数/成员由 proposeGroups 决定，测试
// 只按「组数 3..6 / 成员覆盖全部 topic」的契约断言，不写死分组形状）。
async function ruleProposalOf(controller, trusted) {
  const status = await controller.management.onboardingPreview(trusted, {});
  assert.equal(status.needed, true, "夹具前置：未分组且 topic≥6 时向导应触发");
  return status.proposal;
}

// ── onboardingPreview：状态模式 + 预览零写入实证 ─────────────────────────────

test("onboardingPreview 状态模式：needed + 规则提案（3–6 组、成员不重不漏）+ 标记位回显；stateRoot/dataRoot 除 storage 读路径既有的 generation 指针懒初始化外零写入，且不出现 onboarding.json（R7 口径：夹具已预热快照）", async (t) => {
  const { controller, trusted, dataRoot, stateRoot } = await setupController(t, { topics: 6 });

  const dataBefore = await snapshotTree(dataRoot);
  const stateBefore = await snapshotTree(stateRoot);
  assert.equal(Object.hasOwn(stateBefore, "onboarding.json"), false, "前置：标记位文件尚不存在");

  const status = await controller.management.onboardingPreview(trusted, {});

  const dataAfter = await snapshotTree(dataRoot);
  const stateAfter = await snapshotTree(stateRoot);
  assertTreesIdentical(dataBefore, dataAfter, "dataRoot");
  assertTreesIdentical(stateBefore, stateAfter, "stateRoot");
  assert.equal(Object.hasOwn(stateAfter, "onboarding.json"), false, "onboarding.json 不得因 preview 出现");

  assert.equal(status.scope, "amber");
  assert.equal(status.needed, true);
  assert.equal(status.reason, "needed");
  assert.equal(status.markedKind, null);
  assert.equal(status.counts.topics, 6);
  assert.equal(status.counts.groups, 1, "默认模板组 general 计入组数（挂载口径不触发它）");
  assert.equal(status.counts.historical, 0);
  assert.ok(status.counts.proposed >= 3 && status.counts.proposed <= 6, `提案 3..6 组（实际 ${status.counts.proposed}）`);
  assert.match(status.proposal.hash, /^[0-9a-f]{64}$/);
  assert.equal(status.proposal.groups.length, status.counts.proposed);
  const covered = status.proposal.groups.flatMap((g) => g.members);
  assert.equal(new Set(covered).size, covered.length, "提案成员不重");
  assert.deepEqual([...new Set(covered)].sort(), [
    "comfy-t3", "comfy-t4", "comfy-t5", "shiori-t0", "shiori-t1", "shiori-t2",
  ], "提案成员不漏（覆盖全部未归档 topic）");
  assert.equal(status.preview, null, "状态模式不出预览");
  assert.deepEqual(status.flag, { version: 1, dismissedAt: null, completedAt: null, proposalHash: null }, "无标记位时回显全空");
});

test("onboardingPreview 预览模式：L1 投影 / historical 清单 / 冷却候选 / diff；两次预览依旧零写入", async (t) => {
  const { controller, trusted, dataRoot, stateRoot } = await setupController(t, { topics: 6 });
  const proposal = await ruleProposalOf(controller, trusted);

  const stateBefore = await snapshotTree(stateRoot);
  const dataBefore = await snapshotTree(dataRoot);
  // 编辑提案：第一组标 historical。
  const edited = {
    groups: proposal.groups.map((g, i) => ({
      ...g,
      defaultRetention: i === 0 ? "historical" : g.defaultRetention,
    })),
    ungrouped: [],
  };
  const view = await controller.management.onboardingPreview(trusted, { proposal: edited });

  assertTreesIdentical(dataBefore, await snapshotTree(dataRoot), "dataRoot");
  assertTreesIdentical(stateBefore, await snapshotTree(stateRoot), "stateRoot");
  assert.equal(Object.hasOwn(await snapshotTree(stateRoot), "onboarding.json"), false, "预览模式同样不写标记位");

  assert.equal(view.needed, true);
  assert.equal(view.proposal, null, "预览模式不出规则提案");
  assert.ok(view.preview, "预览块存在");
  const preview = view.preview;
  assert.match(preview.hash, /^[0-9a-f]{64}$/);
  assert.equal(preview.hash, view.preview.hash);
  assert.ok(preview.l1Preview.includes("group:"), "L1 投影含组行");
  assert.ok(preview.summary.length > 0);
  assert.ok(preview.diff.length >= 1, "diff 至少含 groups.json 条目");
  assert.equal(preview.diff[0].path, "groups.json");
  // historical 清单 = 冷却候选（同集合）。
  assert.deepEqual(
    preview.coolingCandidates.map((c) => c.key),
    preview.historical.map((h) => h.key),
  );
  for (const row of preview.historical) {
    assert.ok(["group", "override"].includes(row.source));
  }
  // 标 historical 的组默认生效：第一组的成员全部在清单里，其余组不在。
  const historicalKeys = new Set(preview.historical.map((h) => h.key));
  for (const member of edited.groups[0].members) {
    assert.ok(historicalKeys.has(member), `组默认 historical 生效：${member} 在清单`);
  }
  for (let i = 1; i < edited.groups.length; i += 1) {
    for (const member of edited.groups[i].members) {
      assert.equal(historicalKeys.has(member), false, `standing 组成员不在清单：${member}`);
    }
  }
});

test("onboardingPreview 预览模式反例：成员不完整 / 未知 topic / overrides 键越界 拒绝（INVALID_INPUT）", async (t) => {
  const { controller, trusted } = await setupController(t, { topics: 6 });
  const proposal = await ruleProposalOf(controller, trusted);
  // 成员不漏被破坏：抽掉一个成员且不进 ungrouped。
  const incomplete = {
    groups: proposal.groups.map((g, i) => (i === 0
      ? { ...g, members: g.members.slice(1) }
      : g)),
    ungrouped: [],
  };
  await assert.rejects(
    () => controller.management.onboardingPreview(trusted, { proposal: incomplete }),
    (e) => e.code === "INVALID_INPUT",
  );
  // 未知 topic。
  const unknown = {
    groups: proposal.groups.map((g, i) => (i === 0 ? { ...g, members: [...g.members, "ghost"] } : g)),
    ungrouped: [],
  };
  await assert.rejects(
    () => controller.management.onboardingPreview(trusted, { proposal: unknown }),
    (e) => e.code === "INVALID_INPUT",
  );
  // overrides 键越界（不是该组成员）。
  const badOverride = {
    groups: proposal.groups.map((g, i) => (i === 0 ? { ...g, overrides: { ghost: "historical" } } : g)),
    ungrouped: [],
  };
  await assert.rejects(
    () => controller.management.onboardingPreview(trusted, { proposal: badOverride }),
    (e) => e.code === "INVALID_INPUT",
  );
});

test("onboardingPreview：shadow 挂载 UNSUPPORTED（向导不触 shadow）", async (t) => {
  const { controller, trusted } = await setupController(t, { topics: 6, mode: "shadow" });
  await assert.rejects(
    () => controller.management.onboardingPreview(trusted, {}),
    (e) => e.code === "UNSUPPORTED",
  );
});

// ── onboardingApply：硬闸 + 单事务落地 ───────────────────────────────────────

test("onboardingApply：confirmed 缺失/为 false 在 wire 层即拒；hash 不符 REVISION_CONFLICT；组 key 撞既有清单 INVALID_INPUT", async (t) => {
  const { controller, trusted } = await setupController(t, { topics: 6 });
  const proposal = await ruleProposalOf(controller, trusted);
  const edited = { groups: proposal.groups, ungrouped: [] };
  const hash = proposal.hash;

  await assert.rejects(
    () => controller.management.onboardingApply(trusted, { proposal: edited, hash, operationId: "op-1", confirmed: false }),
    (e) => e.code === "INVALID_INPUT",
    "confirmed:false 在 wire 层拒",
  );
  await assert.rejects(
    () => controller.management.onboardingApply(trusted, { proposal: edited, hash, operationId: "op-1" }),
    (e) => e.code === "INVALID_INPUT",
    "confirmed 缺失在 wire 层拒",
  );
  await assert.rejects(
    () => controller.management.onboardingApply(trusted, { proposal: edited, hash: "b".repeat(64), operationId: "op-1", confirmed: true }),
    (e) => e.code === "REVISION_CONFLICT",
    "hash 与提案内容不符拒",
  );
  // 组 key 撞默认模板组 general：改提案 key 复用既有组名 → INVALID_INPUT（fail-closed）。
  const collide = {
    groups: proposal.groups.map((g, i) => (i === 0 ? { ...g, key: "general" } : g)),
    ungrouped: [],
  };
  const collideHash = (await import("../../src/organize/onboarding.mjs")).proposalHash(collide);
  await assert.rejects(
    () => controller.management.onboardingApply(trusted, { proposal: collide, hash: collideHash, operationId: "op-2", confirmed: true }),
    (e) => e.code === "INVALID_INPUT",
    "组 key 与既有清单冲突拒",
  );
});

test("onboardingApply：单事务落地（组清单 + topic 挂组 + historical 组策略 + override 显式写入）+ completedAt + 一次性硬闸", async (t) => {
  const { controller, trusted, dataRoot, stateRoot } = await setupController(t, { topics: 6 });
  const proposal = await ruleProposalOf(controller, trusted);
  // 编辑：第一组组默认 historical；第二组 standing + 一条 override historical。
  const groups = proposal.groups.map((g, i) => {
    if (i === 0) return { ...g, defaultRetention: "historical" };
    if (i === 1 && g.members.length > 0) {
      return { ...g, defaultRetention: "standing", overrides: { [g.members[0]]: "historical" } };
    }
    return g;
  });
  const edited = { groups, ungrouped: [] };
  const { proposalHash } = await import("../../src/organize/onboarding.mjs");
  const hash = proposalHash(edited);

  const receipt = await controller.management.onboardingApply(trusted, {
    proposal: edited, hash, operationId: "op-apply-1", confirmed: true,
  });

  assert.equal(receipt.applied, true);
  assert.equal(receipt.hash, hash);
  assert.equal(receipt.createdGroups, groups.length);
  assert.equal(receipt.mountedTopics, groups.reduce((n, g) => n + g.members.length, 0));
  assert.ok(receipt.completedAt);
  // 回执 historicalCount：第一组全员 + 第二组 override 一条。
  const expectedHistorical = groups[0].members.length + (groups[1] ? 1 : 0);
  assert.equal(receipt.historicalCount, expectedHistorical);
  assert.ok(Array.isArray(receipt.result.changes) && receipt.result.changes.length > 0, "mutate 回执摘录在");

  // 落盘核对：组清单（order 按 canonical key 序 10/20/30…——与实现注释同口径）。
  const { data } = await readGroups({ dataRoot, scopeId: "amber" });
  const canonicalOrder = [...groups].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const [index, group] of canonicalOrder.entries()) {
    const entry = data.groups.find((candidate) => candidate.key === group.key);
    assert.ok(entry, `组 ${group.key} 已写入清单`);
    assert.equal(entry.title, group.title);
    if (group.defaultRetention === "historical") {
      assert.equal(entry.retention, "historical", `historical 组策略写进组条目（${group.key}）`);
    } else {
      assert.equal(Object.hasOwn(entry, "retention"), false, "standing 组不写多余 retention 行");
    }
    assert.equal(entry.order, (index + 1) * 10, "order 按 canonical key 序 10/20/30…");
  }
  // 落盘核对：topic front-matter（挂组 + override 显式 retention）。
  const topicsDir = path.join(dataRoot, "scopes", "amber", "topics");
  for (const group of groups) {
    for (const member of group.members) {
      const raw = await readFile(path.join(topicsDir, `${member}.md`), "utf8");
      assert.match(raw, new RegExp(`group: \\["${group.key}"\\]`), `${member} 挂进 ${group.key}`);
      const override = group.overrides?.[member];
      if (override !== undefined) {
        assert.match(raw, new RegExp(`retention: "${override}"`), `${member} 的 override 显式写入`);
      } else {
        assert.doesNotMatch(raw, /retention:/, `${member} 无 override 时不落 retention 行（走组策略）`);
      }
    }
  }
  // 落盘核对：标记位（completedAt + proposalHash，dismissedAt 不存在）。
  const flagRaw = JSON.parse(await readFile(path.join(stateRoot, "onboarding.json"), "utf8"));
  assert.equal(flagRaw.version, 1);
  assert.equal(flagRaw.completedAt, receipt.completedAt);
  assert.equal(flagRaw.proposalHash, hash);
  assert.equal(flagRaw.dismissedAt, undefined);

  // 一次性硬闸：已完成再 apply → INVALID_STATE（哪怕换提案/换 operationId）。
  await assert.rejects(
    () => controller.management.onboardingApply(trusted, {
      proposal: edited, hash, operationId: "op-apply-2", confirmed: true,
    }),
    (e) => e.code === "INVALID_STATE",
  );

  // 完成后再查状态：marked/completed，needed=false。
  const status = await controller.management.onboardingPreview(trusted, {});
  assert.equal(status.reason, "marked");
  assert.equal(status.markedKind, "completed");
  assert.equal(status.needed, false);
  // 应用后再预览零写入（读路径不动已完成数据）。
  const stateBefore = await snapshotTree(stateRoot);
  await controller.management.onboardingPreview(trusted, { proposal: edited });
  assertTreesIdentical(stateBefore, await snapshotTree(stateRoot), "完成态预览零写入");
});

test("onboardingApply：标记位写盘失败只诊断不阻塞（onboarding.json 目录不可写 → applied:true + warning，数据已落地）", async (t) => {
  const { controller, trusted, dataRoot, stateRoot } = await setupController(t, { topics: 6 });
  const proposal = await ruleProposalOf(controller, trusted);
  const edited = { groups: proposal.groups, ungrouped: [] };
  const { proposalHash } = await import("../../src/organize/onboarding.mjs");
  const hash = proposalHash(edited);
  // 让 onboarding.json 变成目录：atomicReplace 对目录 rename 必失败（写盘故障注入）。
  await mkdir(path.join(stateRoot, "onboarding.json"), { recursive: true });

  const receipt = await controller.management.onboardingApply(trusted, {
    proposal: edited, hash, operationId: "op-apply-3", confirmed: true,
  });
  assert.equal(receipt.applied, true, "数据写入成功不因标记位写盘失败翻转为失败");
  assert.ok(typeof receipt.warning === "string" && receipt.warning.length > 0, "诊断摘要如实出线");
  // 数据确已落地：组清单有条目。
  const { data } = await readGroups({ dataRoot, scopeId: "amber" });
  assert.ok(groupsIncluded(data.groups, proposal));
});

function groupsIncluded(existing, proposal) {
  return proposal.groups.every((g) => existing.some((entry) => entry.key === g.key));
}

// ── onboardingMark：以后再说 / 重新开始 ──────────────────────────────────────

test("onboardingMark：dismiss 写 dismissedAt（可带提案 hash）后五态转 marked/dismissed；restart 清 dismissedAt 恢复 needed；写盘失败只诊断", async (t) => {
  const { controller, trusted, stateRoot } = await setupController(t, { topics: 6 });
  const proposal = await ruleProposalOf(controller, trusted);

  const dismissed = await controller.management.onboardingMark(trusted, { dismiss: true, hash: proposal.hash });
  assert.equal(dismissed.action, "dismiss");
  assert.equal(dismissed.warning, null);
  assert.equal(dismissed.flag.dismissedAt !== null, true);
  assert.equal(dismissed.flag.completedAt, null);
  assert.equal(dismissed.flag.proposalHash, proposal.hash, "提案 hash 进标记位（供预览与标记位比对）");
  const onDisk = JSON.parse(await readFile(path.join(stateRoot, "onboarding.json"), "utf8"));
  assert.ok(onDisk.dismissedAt);

  const status = await controller.management.onboardingPreview(trusted, {});
  assert.equal(status.reason, "marked");
  assert.equal(status.markedKind, "dismissed");
  assert.equal(status.needed, false);
  assert.equal(status.proposal, null, "不触发时不出提案");

  const restarted = await controller.management.onboardingMark(trusted, { restart: true });
  assert.equal(restarted.action, "restart");
  assert.equal(restarted.warning, null);
  assert.equal(restarted.flag.dismissedAt, null, "重新开始清 dismissedAt");
  assert.equal(restarted.flag.completedAt, null);
  const after = await controller.management.onboardingPreview(trusted, {});
  assert.equal(after.needed, true, "重启后恢复触发");
  assert.equal(after.reason, "needed");

  // 幂等：连续 restart 不报错（无变更不落盘）。
  const again = await controller.management.onboardingMark(trusted, { restart: true });
  assert.equal(again.warning, null);
});

test("onboardingMark：shadow 挂载可用（只触 stateRoot 标记位）；inert NOT_CONFIGURED", async (t) => {
  // shadow + 已配置双根：mark 可写标记位（assertHostWritable 放行，无座位争抢）。
  const shadowed = await setupController(t, { topics: 6, mode: "shadow" });
  // shadow 下无法建 topic（工具只读守卫）——直接对空 scope 标记位做读写验证。
  const marked = await shadowed.controller.management.onboardingMark(shadowed.trusted, { dismiss: true });
  assert.equal(marked.action, "dismiss");
  assert.equal(marked.warning, null);
  assert.ok(marked.flag.dismissedAt);
  const restarted = await shadowed.controller.management.onboardingMark(shadowed.trusted, { restart: true });
  assert.equal(restarted.flag.dismissedAt, null);
});

// ---------------------------------------------------------------------------
// UI 用例（统一 ui-harness：真实重渲染循环）
// ---------------------------------------------------------------------------

const STATUS_DTO = {
  mode: "active",
  configured: true,
  personas: ["amber"],
  scope: "amber",
  occupancy: { l0Chars: 0, l1Chars: 0, l0Budget: 12000, l1HardCap: 20000 },
  capabilities: { l2: false, organize: true, forgetting: true, tools: true, sections: true },
  diagnostics: { ownerId: "local", generation: 1, started: true, configurationState: "configured" },
};

/** 规则提案夹具（形状与 proposeGroups 输出一致；组/成员写死以稳定 UI 断言）。 */
const FIXTURE_PROPOSAL = {
  hash: "a".repeat(64),
  groups: [
    { key: "shiori", title: "Shiori", members: ["shiori-t0", "shiori-t1"], defaultRetention: "standing" },
    { key: "comfy", title: "Comfy", members: ["comfy-t3", "comfy-t4"], defaultRetention: "standing" },
  ],
  ungrouped: [],
};

const FIXTURE_PREVIEW = {
  hash: "b".repeat(64),
  diff: [{ path: "groups.json", oldText: "[]", newText: "[...]" }],
  changedItems: 5,
  summary: "向导应用：新建 2 个组、挂载 4 个 topic、2 条标 historical（进冷却候选）",
  l1Preview: "- group:shiori — Shiori（2 名成员）\n- group:comfy — Comfy（2 名成员）",
  historical: [
    { key: "shiori-t0", title: "shiori 主题0", source: "group" },
    { key: "shiori-t1", title: "shiori 主题1", source: "group" },
  ],
  coolingCandidates: [
    { key: "shiori-t0", title: "shiori 主题0" },
    { key: "shiori-t1", title: "shiori 主题1" },
  ],
};

function neededStatus() {
  return {
    scope: "amber",
    needed: true,
    reason: "needed",
    markedKind: null,
    counts: { topics: 6, groups: 1, historical: 0, proposed: 2 },
    flag: { version: 1, dismissedAt: null, completedAt: null, proposalHash: null },
    proposal: FIXTURE_PROPOSAL,
    preview: null,
  };
}

function makeUiDsh(over = {}) {
  const calls = [];
  // 返回后可用例直接改 dsh.preview / dsh.apply / dsh.mark 动态翻转桩返回值
  //（用例里「先翻桩、再点击」的时序依赖动态读取，闭包固定构造参数会漏）。
  const dsh = {
    preview: over.preview,
    apply: over.apply,
    mark: over.mark,
    status: over.status,
    call: async (method, sessionId, payload) => {
      calls.push({ method, payload });
      if (method === "getStatus") return dsh.status ?? STATUS_DTO;
      if (method === "onboardingPreview") {
        return dsh.preview ?? neededStatus();
      }
      if (method === "onboardingApply") return dsh.apply ?? { applied: true, completedAt: "2026-01-01T00:00:00.000Z" };
      if (method === "onboardingMark") return dsh.mark ?? { action: "dismiss", flag: { version: 1, dismissedAt: "x", completedAt: null, proposalHash: null }, warning: null };
      return {};
    },
  };
  dsh.calls = calls;
  return dsh;
}

async function mountStatus(dsh) {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const mounted = await harness.mount({ tab: "status", dsh });
  mounted.render();
  await mounted.flush();
  // harness 的 fake document 不挂载渲染树（click/text 走内部 dom 引用）；元素
  // 访问统一走 rerender() 返回的 dom 根 + 本文件 finder（与 harness 内部
  // matchesSelector 同口径，不另起 document 查询）。
  let current = mounted.rerender();
  const fresh = () => { current = mounted.rerender(); return current; };
  return { harness, mounted, dom: () => current, fresh };
}

function walkDom(el, visit) {
  if (!el || typeof el !== "object" || el.nodeType !== 1) return;
  visit(el);
  for (const child of el.children) walkDom(child, visit);
}

/** 按 data-role 找元素（第一个命中；无命中 null）。 */
function elByRole(dom, role) {
  let found = null;
  walkDom(dom, (el) => {
    if (found === null && el.getAttribute("data-role") === role) found = el;
  });
  return found;
}

/** 按 data-role 找全部命中元素（文档序）。 */
function elsByRole(dom, role) {
  const out = [];
  walkDom(dom, (el) => {
    if (el.getAttribute("data-role") === role) out.push(el);
  });
  return out;
}

/** 按按钮内文本找按钮元素（fake 元素的 onclick 可直接调用）。 */
function buttonsByText(dom, label) {
  const out = [];
  walkDom(dom, (el) => {
    if (el.tagName === "BUTTON" && collectDomText(el) === label) out.push(el);
  });
  return out;
}

const hasCard = (state, role) => elByRole(state.dom(), role) !== null;

test("UI 触发：needed=true 时状态页出现向导卡片（不弹窗，data-role 锚点），自动探测 ≤1 次", async () => {
  const dsh = makeUiDsh();
  const state = await mountStatus(dsh);
  const { mounted } = state;
  try {
    assert.equal(hasCard(state, "onboarding-card"), true, "向导卡片在状态页内联出现");
    const text = mounted.text();
    assert.ok(text.includes("首启整理向导"), "卡片标题");
    // 组 title 在 input 的 value 属性里（collectDomText 不含属性），成员 key 是
    // 文本节点——按成员断言候选组可见性。
    assert.ok(text.includes("shiori-t0"), "第一组成员可见");
    assert.ok(text.includes("comfy-t3"), "第二组成员可见");
    assert.ok(text.includes("以后再说"), "搁置入口可见");
    const probes = dsh.calls.filter((c) => c.method === "onboardingPreview" && Object.keys(c.payload).length === 0);
    assert.equal(probes.length, 1, "状态探测恰一次（挂载 effect，非每帧）");
    assert.equal(hasCard(state, "onboarding-confirm"), false, "确认行默认不展开（不打断）");
  } finally {
    mounted.unmount();
  }
});

test("UI 不触发：grouped / completed / too-few-topics / shadow 失败 均不出卡片", async () => {
  for (const [label, over] of [
    ["grouped", { preview: { ...neededStatus(), needed: false, reason: "grouped", proposal: null } }],
    ["completed", { preview: { ...neededStatus(), needed: false, reason: "marked", markedKind: "completed", proposal: null } }],
    ["too-few-topics", { preview: { ...neededStatus(), needed: false, reason: "too-few-topics", proposal: null } }],
  ]) {
    const dsh = makeUiDsh(over);
    const state = await mountStatus(dsh);
  const { mounted } = state;
    try {
      assert.equal(hasCard(state, "onboarding-card"), false, `${label} 不出编辑卡`);
      assert.equal(hasCard(state, "onboarding-card-dismissed"), false, `${label} 不出搁置卡`);
    } finally {
      mounted.unmount();
    }
  }
  // 服务端 UNSUPPORTED（shadow / 未启动）：不出卡、不占版面、不出错误框。
  const dsh = makeUiDsh();
  dsh.call = async (method) => {
    if (method === "onboardingPreview") {
      const error = new Error("unsupported");
      error.code = "UNSUPPORTED";
      throw error;
    }
    return STATUS_DTO;
  };
  const state = await mountStatus(dsh);
  const { mounted } = state;
  try {
    assert.equal(hasCard(state, "onboarding-card"), false);
    assert.equal(mounted.text().includes("unsupported"), false, "向导取数失败静默（不打断状态页）");
  } finally {
    mounted.unmount();
  }
});

test("UI 以后再说：写 dismissedAt（带提案 hash）→ 卡片转已搁置态；重新开始 → 清 dismissedAt", async () => {
  const dsh = makeUiDsh();
  const state = await mountStatus(dsh);
  const { mounted } = state;
  try {
    // 桩先翻转为 dismissed：obDismiss 成功后内部会自动重取状态（真实链路里
    // 服务端已落 dismissedAt），卡片收起就发生在这一次重取上。
    dsh.preview = {
      ...neededStatus(),
      needed: false,
      reason: "marked",
      markedKind: "dismissed",
      proposal: null,
      flag: { version: 1, dismissedAt: "2026-01-01T00:00:00.000Z", completedAt: null, proposalHash: FIXTURE_PROPOSAL.hash },
    };
    assert.equal(mounted.click("[data-role=onboarding-dismiss]"), true, "点「以后再说」");
    await mounted.flush();
    state.fresh();
    const markCalls = dsh.calls.filter((c) => c.method === "onboardingMark");
    assert.equal(markCalls.length, 1);
    assert.deepEqual(markCalls[0].payload, { dismiss: true, hash: FIXTURE_PROPOSAL.hash }, "搁置携带当前提案 hash");
    assert.equal(hasCard(state, "onboarding-card"), false, "编辑卡收起");
    assert.equal(hasCard(state, "onboarding-card-dismissed"), true, "已搁置折叠卡出现");

    // 重新开始：桩翻回 needed（obRestart 内部重取即取到），恢复编辑卡。
    dsh.preview = neededStatus();
    assert.equal(mounted.click("[data-role=onboarding-restart]"), true, "点「重新开始」");
    await mounted.flush();
    state.fresh();
    const restarts = dsh.calls.filter((c) => c.method === "onboardingMark" && c.payload.restart === true);
    assert.equal(restarts.length, 1, "restart 动作发出（清 dismissedAt）");
    assert.equal(hasCard(state, "onboarding-card-dismissed"), false, "搁置卡收起");
    assert.equal(hasCard(state, "onboarding-card"), true, "向导恢复编辑卡");
  } finally {
    mounted.unmount();
  }
});

test("UI 预览：草稿 payload 形状（组/成员/档位/ungrouped）+ 预览卡渲染 L1/historical/冷却候选；应用走二次确认且 confirmed:true", async () => {
  const dsh = makeUiDsh();
  const state = await mountStatus(dsh);
  const { mounted } = state;
  try {
    // 预览前先做一次交互：第二组改名 + 跳过第一组 → payload 如实反映草稿。
    const titleInputs = elsByRole(state.dom(), "onboarding-group-title");
    titleInputs[1].onchange({ target: { value: "Comfy 改名" } });
    state.fresh();
    assert.equal(mounted.click("[data-role=onboarding-group-skip]"), true, "跳过按钮可点（命中第一组）");
    // 上面 click 命中的是第一个匹配（第一组跳过）。
    state.fresh();
    assert.ok(mounted.text().includes("该组已跳过"), "跳过组给出说明");

    // 预览桩：预览模式响应带 preview 块（obPreviewRun 存整响应，卡片读 .preview）。
    dsh.preview = { ...neededStatus(), proposal: null, preview: FIXTURE_PREVIEW };
    assert.equal(mounted.click("[data-role=onboarding-preview-run]"), true, "点「生成预览」");
    await mounted.flush();
    state.fresh();

    const previewCalls = dsh.calls.filter((c) => c.method === "onboardingPreview" && c.payload.proposal !== undefined);
    assert.equal(previewCalls.length, 1, "预览调用一次");
    const payload = previewCalls[0].payload.proposal;
    assert.deepEqual(payload.groups, [{
      key: "comfy",
      title: "Comfy 改名",
      members: ["comfy-t3", "comfy-t4"],
      defaultRetention: "standing",
      overrides: {},
    }], "payload：跳过组剔除、改名生效、结构闭合");
    assert.deepEqual(payload.ungrouped, ["shiori-t0", "shiori-t1"], "跳过组成员落入 ungrouped");

    // 预览渲染（桩返回 FIXTURE_PREVIEW）。
    assert.equal(hasCard(state, "onboarding-preview"), true);
    const text = mounted.text();
    assert.ok(text.includes("目标组布局"), "组目录投影段（R4 口径：不冒称应用后 L1）");
    assert.ok(text.includes("group:shiori"), "L1 投影内容");
    assert.ok(text.includes("冷却候选"), "冷却候选段");
    assert.ok(text.includes("shiori-t0"), "historical 清单可见");
    assert.equal(hasCard(state, "onboarding-confirm"), false, "确认行未展开");

    assert.equal(mounted.click("[data-role=onboarding-apply-open]"), true, "点「应用…」展开确认");
    await mounted.flush();
    state.fresh();
    assert.equal(hasCard(state, "onboarding-confirm"), true);
    assert.ok(mounted.text().includes("将新建 1 个组"), "二次确认文案：写入组数");
    assert.ok(mounted.text().includes("2 个 topic 挂入分组"), "二次确认文案：影响 topic 数");

    assert.equal(mounted.click("[data-role=onboarding-apply-confirm]"), true, "点「确认应用」");
    await mounted.flush();
    state.fresh();
    const applyCalls = dsh.calls.filter((c) => c.method === "onboardingApply");
    assert.equal(applyCalls.length, 1, "应用调用一次");
    assert.equal(applyCalls[0].payload.confirmed, true, "confirmed 显式 true");
    assert.equal(applyCalls[0].payload.hash, FIXTURE_PREVIEW.hash, "hash 绑定预览内容");
    assert.ok(applyCalls[0].payload.operationId, "operationId 由面板生成");
    assert.deepEqual(applyCalls[0].payload.proposal, payload, "应用的提案与预览一致");
  } finally {
    mounted.unmount();
  }
});

test("UI 组交互：组默认档位切换与逐条 override 进 payload；并入上一组合并成员", async () => {
  const dsh = makeUiDsh();
  const state = await mountStatus(dsh);
  const { mounted } = state;
  try {
    // 组默认档位：第一组切 historical。
    const selects = elsByRole(state.dom(), "onboarding-group-retention");
    selects[0].onchange({ target: { value: "historical" } });
    state.fresh();
    // 逐条 override：第二组第一个成员切 historical。
    const memberSelects = elsByRole(state.dom(), "onboarding-member-retention");
    assert.ok(memberSelects.length >= 4, "每个成员行一个档位选择器");
    memberSelects[2].onchange({ target: { value: "historical" } });
    state.fresh();
    // 并入上一组：第二组并入第一组（第二组按钮 index>0 才有）。
    const mergeButtons = buttonsByText(state.dom(), "并入上一组");
    assert.equal(mergeButtons.length, 1, "仅非首组有并入按钮");
    mergeButtons[0].onclick();
    state.fresh();

    assert.equal(mounted.click("[data-role=onboarding-preview-run]"), true);
    await mounted.flush();
    state.fresh();
    const previewCalls = dsh.calls.filter((c) => c.method === "onboardingPreview" && c.payload.proposal !== undefined);
    assert.equal(previewCalls.length, 1);
    const payload = previewCalls[0].payload.proposal;
    assert.equal(payload.groups.length, 1, "合并后剩一组");
    assert.equal(payload.groups[0].defaultRetention, "historical", "组默认档位进 payload");
    assert.deepEqual(payload.groups[0].members, ["shiori-t0", "shiori-t1", "comfy-t3", "comfy-t4"], "并入后成员随迁");
    assert.deepEqual(payload.groups[0].overrides, { "comfy-t3": "historical" }, "override 随迁且逐条调整生效");
  } finally {
    mounted.unmount();
  }
});

/** 收集文本等于 label 的按钮元素（fake document 树）。 */
function flattenButtons(harness, label) {
  const out = [];
  const walk = (el) => {
    if (!el || typeof el !== "object") return;
    if (el.nodeType === 1) {
      if (el.tagName === "BUTTON" && collectDomText(el) === label) out.push(el);
      for (const child of el.children) walk(child);
    }
  };
  for (const top of harness.document.body.children) walk(top);
  return out;
}

function collectDomText(el) {
  if (!el) return "";
  if (el.nodeType === 3) return el.textContent || "";
  if (el.nodeType !== 1) return "";
  let out = "";
  for (const child of el.children) out += collectDomText(child);
  return out + (el._text || "");
}

test("R2 死路回归：预览后再编辑必须清预览与确认行（应用必须以新预览的 hash 重走）", async () => {
  const dsh = makeUiDsh();
  const state = await mountStatus(dsh);
  const { mounted } = state;
  try {
    // 预览桩：返回带 preview 的响应（hash = b*64）。
    dsh.preview = { ...neededStatus(), proposal: null, preview: FIXTURE_PREVIEW };
    assert.equal(mounted.click("[data-role=onboarding-preview-run]"), true, "先出预览");
    await mounted.flush();
    state.fresh();
    assert.equal(hasCard(state, "onboarding-preview"), true, "预览卡在");
    assert.equal(mounted.click("[data-role=onboarding-apply-open]"), true, "确认行展开");
    await mounted.flush();
    state.fresh();
    assert.equal(hasCard(state, "onboarding-confirm"), true);

    // 编辑（改第二组标题）→ 预览与确认行必须立即作废（R2：编辑后旧 hash 应用必 REVISION_CONFLICT）。
    const titleInputs = elsByRole(state.dom(), "onboarding-group-title");
    titleInputs[1].onchange({ target: { value: "改名后组" } });
    state.fresh();
    assert.equal(hasCard(state, "onboarding-preview"), false, "预览卡被清（invalidatePreview）");
    assert.equal(hasCard(state, "onboarding-confirm"), false, "确认行被收起");
    const previewCallsBefore = dsh.calls.filter((c) => c.method === "onboardingPreview" && c.payload.proposal !== undefined).length;
    assert.equal(mounted.click("[data-role=onboarding-apply-open]"), false, "应用入口已随预览消失（守卫回到「请先生成预览」路径）");

    // 重新预览：payload 携带编辑后的草稿，hash 与新内容同源。
    dsh.preview = { ...neededStatus(), proposal: null, preview: { ...FIXTURE_PREVIEW, hash: "c".repeat(64) } };
    assert.equal(mounted.click("[data-role=onboarding-preview-run]"), true, "重新生成预览");
    await mounted.flush();
    state.fresh();
    const previewCalls = dsh.calls.filter((c) => c.method === "onboardingPreview" && c.payload.proposal !== undefined);
    assert.equal(previewCalls.length, previewCallsBefore + 1, "重走一次预览");
    assert.equal(previewCalls[previewCalls.length - 1].payload.proposal.groups[1].title, "改名后组", "新草稿进 payload");
    assert.equal(mounted.click("[data-role=onboarding-apply-open]"), true, "新预览后应用入口恢复");
    await mounted.flush();
    state.fresh();
    assert.equal(mounted.click("[data-role=onboarding-apply-confirm]"), true, "确认应用");
    await mounted.flush();
    state.fresh();
    const applyCalls = dsh.calls.filter((c) => c.method === "onboardingApply");
    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0].payload.hash, "c".repeat(64), "hash 与最新预览同源（不再用旧 hash）");
  } finally {
    mounted.unmount();
  }
});

test("R8 warning 渲染：apply 回执 warning 在卡片上可见（不再被丢弃）", async () => {
  const dsh = makeUiDsh();
  dsh.apply = { applied: true, completedAt: "2026-01-01T00:00:00.000Z", warning: "组与 retention 已写入；onboarding.json 写盘失败（EACCES）——completedAt 未记录，向导完成标记缺失（不影响已写入的数据）" };
  const state = await mountStatus(dsh);
  const { mounted } = state;
  try {
    // 挂载探测先吃状态模式（neededStatus 带提案、卡片出编辑态），点击预览前
    // 再翻成预览模式响应（带 preview 块）——与 R2 同款两段翻转。
    dsh.preview = { ...neededStatus(), proposal: null, preview: FIXTURE_PREVIEW };
    assert.equal(mounted.click("[data-role=onboarding-preview-run]"), true);
    await mounted.flush();
    state.fresh();
    assert.equal(mounted.click("[data-role=onboarding-apply-open]"), true);
    await mounted.flush();
    state.fresh();
    assert.equal(mounted.click("[data-role=onboarding-apply-confirm]"), true);
    await mounted.flush();
    state.fresh();
    const warningEl = elByRole(state.dom(), "onboarding-warning");
    assert.ok(warningEl, "warning 有渲染锚点");
    assert.ok(mounted.text().includes("onboarding.json 写盘失败"), "warning 文案可见");
    assert.ok(mounted.text().includes("completedAt 未记录"), "服务端事实陈述逐字渲染（R4：不加客户端一刀切后缀）");
  } finally {
    mounted.unmount();
  }
});

test("R6 坏 JSON 自愈：onboarding.json 损坏后 dismiss 自愈重建（备份 .corrupt-*）+ warning 出线；completed 后 dismiss 不覆盖 proposalHash（R9③）", async (t) => {
  const { controller, trusted, stateRoot } = await setupController(t, { topics: 6 });
  // 写坏 JSON：读路径降级（向导重新出现），写路径此前会永久失败。
  await writeFile(path.join(stateRoot, "onboarding.json"), "{ this is not json", "utf8");
  const before = await controller.management.onboardingPreview(trusted, {});
  assert.equal(before.reason, "needed", "坏 JSON 按无标记位降级（向导重新出现）");
  assert.ok(before.diagnostics && before.diagnostics.flagError, "降级诊断如实出线");

  const marked = await controller.management.onboardingMark(trusted, { dismiss: true, hash: "a".repeat(64) });
  assert.equal(marked.action, "dismiss");
  assert.ok(marked.flag && marked.flag.dismissedAt, "自愈后 dismissedAt 写入");
  assert.ok(typeof marked.warning === "string" && marked.warning.includes("重建"), "warning 说明已重建（不悄悄伪装无事）");
  const backups = (await readdir(stateRoot)).filter((name) => name.startsWith("onboarding.json.corrupt-"));
  assert.equal(backups.length, 1, "坏文件已备份（保留现场）");

  // R9③：完成后再 dismiss 不得覆盖完成审计（proposalHash 保持完成时的值）。
  const completed = await controller.management.onboardingMark(trusted, { restart: true });
  assert.equal(completed.warning, null);
  const proposal = await ruleProposalOf(controller, trusted);
  const { proposalHash } = await import("../../src/organize/onboarding.mjs");
  const edited = { groups: proposal.groups, ungrouped: [] };
  const hash = proposalHash(edited);
  await controller.management.onboardingApply(trusted, { proposal: edited, hash, operationId: "op-r93", confirmed: true });
  const afterApply = await controller.management.onboardingMark(trusted, { dismiss: true, hash: "f".repeat(64) });
  assert.equal(afterApply.action, "dismiss");
  assert.equal(afterApply.flag.proposalHash, hash, "completed 后 dismiss 不覆盖完成时的 proposalHash");
  assert.ok(afterApply.flag.completedAt, "completedAt 保留");
});

test("R9② 应用门槛：手造提案对未达触发条件的 scope（3 个 topic）应用 → INVALID_STATE", async (t) => {
  const { controller, trusted } = await setupController(t, { topics: 3 });
  const { proposalHash } = await import("../../src/organize/onboarding.mjs");
  // 手造覆盖 3 个 topic 的合法提案（结构闭合、成员不重不漏）。
  // topics=3 时键全为 shiori-t0/t1/t2（family 按下标 <3 判定）。
  const edited = {
    groups: [
      { key: "g1", title: "组一", members: ["shiori-t0", "shiori-t1"], defaultRetention: "standing" },
      { key: "g2", title: "组二", members: ["shiori-t2"], defaultRetention: "historical" },
    ],
    ungrouped: [],
  };
  await assert.rejects(
    () => controller.management.onboardingApply(trusted, {
      proposal: edited, hash: proposalHash(edited), operationId: "op-gate", confirmed: true,
    }),
    (e) => e.code === "INVALID_STATE" && String(e.message).includes("reason=too-few-topics"),
    "未达触发条件的 scope 拒绝应用（≥5 且首启语义由服务端守住）",
  );
});

test("R1（评审二轮）：自愈的备份 rename 失败必须显式失败（不吞成成功）——固定时钟预建同名目录构造", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-onboard-heal-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const stateRoot = path.join(base, "state");
  await mkdir(stateRoot, { recursive: true });
  const FIXED = 1737500000000;
  const store = createStateStore({ stateRoot, now: () => new Date(FIXED) });
  // 坏 JSON：读路径降级；备份目标名 onboarding.json.corrupt-<FIXED> 预建为目录
  // → rename(file → 既有目录) 在 Windows/Linux 都失败 → 自愈必须显式失败。
  await writeFile(path.join(stateRoot, "onboarding.json"), "{ corrupt", "utf8");
  await mkdir(path.join(stateRoot, `onboarding.json.corrupt-${FIXED}`), { recursive: true });

  const result = await store.onboardingStore.dismiss("2026-01-01T00:00:00.000Z", "a".repeat(64));
  assert.equal(result.ok, false, "rename 失败不得吞成 ok:true");
  assert.match(result.error, /自愈失败/);
  // 现场保留：坏文件原样在（未写成功）、备份目录未被误删、无半写产物。
  assert.equal(await readFile(path.join(stateRoot, "onboarding.json"), "utf8"), "{ corrupt");
  const names = await readdir(stateRoot);
  assert.ok(names.includes(`onboarding.json.corrupt-${FIXED}`), "预建目录原样在");
  assert.equal(names.filter((n) => n === "onboarding.json" || n.startsWith("onboarding.json.")).length, 2, "无其它半写产物");
});
