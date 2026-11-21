// 0.5 批次 5 · B 线：状态页「记忆整理（auto）」卡的真实渲染测试。
//
// 证据级别与 ui-harness.test.mjs 相同：真实执行 client/index.js，harness.mount()
// 走「组件函数 → vnode → fake document element 树」的真实重渲染循环（effect 驱动
// 数据加载 → RPC 假桩 → 状态变更 → 组件函数重执行 → DOM 更新），click/change 触发
// 真实 onClick/onchange。synthetic 渲染树，非浏览器实机。
//
// 覆盖面（对应 StatusTab auto 卡，服务端权威在 forgetting/auto.mjs，面板只透传）：
//   A1 首屏渲染：三档模式开关 + 上次评估 / 下次触发 / 熔断 / auto 参数行 + 动作按钮
//   A2 建议模式：立即评估 → 候选清单（逐条候选行 / 回放规模 / 计划计数）→
//      按钮转「重新评估」；suggest 下「执行本轮」禁用（只出清单）
//   A3 自动模式：执行本轮 → 就地二次确认 → 确认执行 → applyAutoChanges（operationId
//      幂等键）→ 回执（已执行/跳过/失败 + 逐条 ops + runId）；replay 回执同口径
//   A4 一键撤销：最近执行记录出现撤销按钮 → 点撤销 → undoAutoRun({runId}) →
//      回执（回滚 / 已是撤销态 / 跳过 / 失败）→ 服务端 undoneAt 回读后按钮变文本
//   A5 三档模式开关（configForms CAS 通道）：写入 forgetting.autoMode → 服务端
//      未热提交时出 pending 提示（如实说明、不谎报生效）→ 服务端回读后提示收口
//      + 当前档高亮；立即生效路径走 toast
//   A6 熔断：fuse.fused=true → 熔断徽章 + 判定明细行 + 「执行本轮」禁用并说明
//   A7 off：立即评估禁用并说明（off 只记账不评估）
//   A8 getAutoStatus 失败（shadow / 未启动 / 模块关）：整卡静默隐藏，不出错框不崩
//   A9 configForms 缺席（旧宿主）：三档按钮禁用 + 指路文案，状态行照常回显

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createUiHarness } from "./ui-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const CLIENT_SRC = join(WORKQ, "client", "index.js");

// ---------------------------------------------------------------------------
// 服务端 DTO 假桩（字段口径对齐 src/plugin/protocol.mjs auto 四方法的 outputSchema
// 与 forgetting/auto.mjs 的 status/evaluationView/applyView 实际产物）
// ---------------------------------------------------------------------------

function autoStatusDto(overrides = {}) {
  return {
    scope: "amber",
    enabled: true,
    mode: "suggest",
    lastEvaluatedAt: "2026-11-21T10:00:00.000Z",
    lastEvaluatedBy: "human-turn",
    nextTrigger: {
      dueAt: "2026-11-22T10:00:00.000Z",
      hoursRemaining: 24,
      requiresHumanTurn: true,
      softWatermarkArmed: false,
    },
    fuse: {
      fused: false,
      reasons: [],
      statsValid: true,
      statsStartedAt: "2026-11-01T00:00:00.000Z",
      maxEventAt: "2026-11-21T09:00:00.000Z",
      eventCount: 42,
    },
    stats: { eventCount: 42, ledgerSkipped: 0, ledgerError: null },
    params: {
      maxOpsPerRun: 3,
      evaluateEveryHours: 24,
      coolThreshold: 0.25,
      restoreThreshold: 0.5,
      minCooldownDays: 7,
      minRestoreGraceDays: 1,
    },
    lastRuns: [],
    ...overrides,
  };
}

function autoEvalDto(overrides = {}) {
  return {
    scope: "amber",
    evaluatedAt: "2026-11-21T11:00:00.000Z",
    trigger: "manual",
    fused: false,
    fuse: autoStatusDto().fuse,
    stats: { eventCount: 42, ledgerSkipped: 0, ledgerError: null, topicRows: 5, rowsSkipped: 0 },
    replay: { topics: 5, groups: 2, alarms: [] },
    candidates: [
      {
        operationKind: "archive-topic",
        key: "project-alpha",
        scopeId: "amber",
        title: "项目 α",
        T: 0.12,
        tier: "cold",
        ageDays: 40,
        reason: "自动冷却候选：T=0.12 < coolThreshold=0.25",
      },
      {
        operationKind: "unarchive-topic",
        key: "topic-beta",
        scopeId: "amber",
        title: "β 专题",
        T: 0.61,
        tier: "cool",
        ageDays: 2,
        reason: "自动恢复候选：archiveOrigin=auto、T=0.61 ≥ restoreThreshold=0.5",
      },
    ],
    plan: { ops: [], truncated: false, groupRestore: [], counts: { cool: 1, restore: 1, total: 2 } },
    ...overrides,
  };
}

function autoApplyDto(overrides = {}) {
  return {
    runId: "auto-1763712000000-ab12cd34",
    replay: false,
    evaluatedAt: "2026-11-21T11:05:00.000Z",
    trigger: "manual",
    applied: 2,
    skipped: 1,
    failed: 0,
    truncated: false,
    ops: [
      {
        operationKind: "archive-topic",
        key: "project-alpha",
        scopeId: "amber",
        title: "项目 α",
        before: { archivedAt: null, archiveOrigin: null },
        after: { archivedAt: "2026-11-21T11:05:00.000Z", archiveOrigin: "auto" },
        operationId: "autoar-1",
        status: "applied",
        reason: "自动冷却候选：T=0.12 < coolThreshold=0.25",
      },
      {
        operationKind: "archive-topic",
        key: "topic-old",
        scopeId: "amber",
        title: null,
        before: { archivedAt: null, archiveOrigin: null },
        after: { archivedAt: "2026-11-21T11:05:00.000Z", archiveOrigin: "auto" },
        operationId: "autoar-2",
        status: "skipped",
        reason: "评估与执行之间被第三方改过：宁可少执行",
        detail: "state-changed-since-eval",
      },
      {
        operationKind: "unarchive-topic",
        key: "topic-beta",
        scopeId: "amber",
        title: "β 专题",
        before: { archivedAt: "2026-11-10T00:00:00.000Z", archiveOrigin: "auto" },
        after: { archivedAt: null, archiveOrigin: null },
        operationId: "autoun-1",
        status: "applied",
        reason: "自动恢复候选：archiveOrigin=auto、T=0.61 ≥ restoreThreshold=0.5",
      },
    ],
    groupRestore: [{ group: "g-alpha", restoredMembers: ["topic-x"] }],
    counts: { cool: 1, restore: 1, total: 2 },
    ...overrides,
  };
}

function autoUndoDto(overrides = {}) {
  return {
    runId: "auto-1763712000000-ab12cd34",
    replay: false,
    undoneAt: "2026-11-21T11:10:00.000Z",
    reverted: 2,
    alreadyUndone: 0,
    skipped: 0,
    failed: 0,
    ops: [
      { operationKind: "unarchive-topic", key: "project-alpha", scopeId: "amber", before: {}, after: {}, status: "applied" },
      { operationKind: "archive-topic", key: "topic-beta", scopeId: "amber", before: {}, after: {}, status: "applied" },
    ],
    ...overrides,
  };
}

const STATUS_DTO = {
  mode: "active",
  configured: true,
  scope: "amber",
  occupancy: { l0Chars: 12, l1Chars: 34, l0Budget: 12000, l1HardCap: 48000 },
  capabilities: { l2: true, organize: true, forgetting: true, tools: true, sections: true },
  diagnostics: { ownerId: "local", generation: 1, started: true, configurationState: "configured" },
};

// ---------------------------------------------------------------------------
// 假 dsh / 假 configForms scope
// ---------------------------------------------------------------------------

function makeConfigScope(initialValue) {
  const snapshot = { status: "ready", revision: 7, value: JSON.parse(JSON.stringify(initialValue)) };
  const mutations = [];
  function applyOps(value, ops) {
    for (const op of ops) {
      assert.equal(op.op, "set", "本测试只支持 set 操作");
      let node = value;
      for (let i = 0; i < op.path.length - 1; i += 1) {
        if (node[op.path[i]] === undefined || node[op.path[i]] === null) node[op.path[i]] = {};
        node = node[op.path[i]];
      }
      node[op.path[op.path.length - 1]] = op.value;
    }
  }
  return {
    mutations,
    getSnapshot() {
      return { status: snapshot.status, revision: snapshot.revision, value: snapshot.value };
    },
    async mutate(ops, revision) {
      mutations.push({ ops: JSON.parse(JSON.stringify(ops)), revision });
      if (revision !== snapshot.revision) return false;
      applyOps(snapshot.value, ops);
      snapshot.revision += 1;
      return true;
    },
  };
}

function makeDsh(world, configScope) {
  const calls = [];
  const dsh = {
    call: async (method, sessionId, payload) => {
      calls.push({ method, sessionId, payload });
      if (method === "getStatus") return STATUS_DTO;
      if (method === "onboardingPreview") return {};
      // 温度卡不参与本套用例：回 current=null → 卡片静默隐藏，互不干扰。
      if (method === "getTemperatureSettings") return { current: null };
      if (method === "getAutoStatus") return world.autoStatus();
      if (method === "runAutoEvaluation") return world.autoEval();
      if (method === "applyAutoChanges") {
        world.applyCalls = (world.applyCalls || 0) + 1;
        return world.applyResult;
      }
      if (method === "undoAutoRun") {
        world.undoCalls = (world.undoCalls || 0) + 1;
        return world.undoResult;
      }
      return {};
    },
  };
  if (configScope) dsh.configScope = () => configScope;
  dsh.calls = calls;
  return dsh;
}

function makeWorld(overrides = {}) {
  const world = {
    mode: "suggest",
    lastRuns: [],
    evalResult: autoEvalDto(),
    applyResult: autoApplyDto(),
    undoResult: autoUndoDto(),
    autoStatusError: null,
    statusOverrides: {},
    ...overrides,
  };
  world.autoStatus = () => {
    if (world.autoStatusError !== null) throw world.autoStatusError;
    return autoStatusDto({
      mode: world.mode,
      lastRuns: world.lastRuns.map((r) => ({ ...r })),
      ...world.statusOverrides,
    });
  };
  world.autoEval = () => world.evalResult;
  return world;
}

async function settle(mounted) {
  await mounted.flush();
  await mounted.flush();
  mounted.rerender();
}

function textOfElText(mounted, selector) {
  const el = mounted.find(selector);
  return el === null ? null : mounted.textOfEl(el);
}

// toast 挂在 fake document.body 下（不在面板 vnode 树里）：手动遍历 body 子树收集
// 文本（doc 对象没有 children 链，document.querySelectorAll 够不到 body 挂载点）。
function toastTextsOf(doc) {
  const out = [];
  const visit = (el) => {
    if (!el || typeof el !== "object" || el.nodeType !== 1) return;
    if (String(el.className || "").split(/\s+/).includes("dshi_toastText")) {
      out.push(String(el.textContent || ""));
    }
    if (el.children) for (const child of el.children) visit(child);
  };
  visit(doc.head);
  visit(doc.body);
  return out;
}

// ── A1 首屏渲染 ─────────────────────────────────────────────────────────────
test("A1 状态页挂载：auto 卡渲染三档开关 + 上次评估/下次触发/熔断/auto 参数行 + 动作按钮（suggest 当前档高亮）", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld();
  // 常规路径：宿主 configForms 可用（缺席场景归 A9）。
  const configScope = makeConfigScope({ mode: "active", forgetting: { enabled: true, autoMode: "suggest" } });
  const dsh = makeDsh(world, configScope);
  const mounted = await harness.mount({ tab: "status", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    const card = mounted.find("[data-role=auto-card]");
    assert.ok(card, "auto 卡渲染在状态页");

    // 三档开关：当前档（suggest）高亮 primary，其余档可点。
    const offBtn = mounted.find("[data-role=auto-mode-off]");
    const suggestBtn = mounted.find("[data-role=auto-mode-suggest]");
    const autoBtn = mounted.find("[data-role=auto-mode-auto]");
    assert.ok(offBtn && suggestBtn && autoBtn, "三档按钮齐备");

    const cardText = mounted.textOfEl(card);
    assert.ok(cardText.includes("记忆整理（自动冷却 / 恢复）"), "卡片标题");
    // 模式行只回显服务端当前档的说明文案（autoModeText 当前档一个）；三档按钮各自带档名。
    assert.ok(cardText.includes("建议（评估出清单，不自动执行）"), "suggest 当前档说明文本");
    assert.ok(mounted.textOfEl(suggestBtn).includes("建议（当前）"), "当前档按钮带（当前）标记");
    assert.equal(mounted.textOfEl(offBtn), "关闭", "off 档按钮文案");
    assert.ok(cardText.includes("上次评估"), "上次评估行");
    assert.ok(cardText.includes("2026-11-21 10:00:00"), "lastEvaluatedAt 格式化为本地可读时间");
    assert.ok(cardText.includes("人类轮自动触发"), "lastEvaluatedBy 中文化");
    assert.ok(cardText.includes("下次评估窗口 2026-11-22 10:00:00（约 24 小时后）"), "nextTrigger 行（服务端权威）");
    assert.ok(cardText.includes("熔断状态"), "熔断行");
    assert.ok(cardText.includes("正常"), "熔断未触发时为正常");
    assert.ok(cardText.includes("maxOpsPerRun=3"), "auto 参数快照行");
    assert.ok(cardText.includes("evaluateEveryHours=24"), "auto 参数快照行（第二项）");

    assert.ok(String(suggestBtn.className).includes("dshi_btnPrimary"), "当前档 suggest 高亮");
    assert.ok(!String(offBtn.className).includes("dshi_btnPrimary"), "off 档不高亮");
    assert.equal(suggestBtn.getAttribute("disabled"), "false", "按钮可点（configForms 缺席时才禁用）");

    // 动作按钮：立即评估 + 执行本轮 + 刷新。
    const evaluateBtn = mounted.find("[data-role=auto-evaluate]");
    const applyBtn = mounted.find("[data-role=auto-apply]");
    assert.ok(evaluateBtn && applyBtn, "动作按钮齐备");
    assert.equal(textOfElText(mounted, "[data-role=auto-evaluate]"), "立即评估", "首屏按钮文案");
    assert.equal(applyBtn.getAttribute("disabled"), "true", "suggest 模式下执行本轮禁用（只出清单）");

    // 最近执行记录空态。
    assert.ok(mounted.find("[data-role=auto-runs-empty]"), "无 run 时空态文案");
    assert.equal(mounted.findAll("[data-role=auto-run-row]").length, 0, "无 run 行");

    // 建议模式提示语。
    assert.ok(cardText.includes("建议模式只出清单"), "suggest 模式提示语");
  } finally {
    mounted.unmount();
  }
});

// ── A2 立即评估 ─────────────────────────────────────────────────────────────
test("A2 建议模式：立即评估 → runAutoEvaluation → 候选清单/回放规模/计划计数渲染，按钮转「重新评估」", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld();
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "status", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    assert.equal(mounted.click("[data-role=auto-evaluate]"), true, "点「立即评估」命中");
    await settle(mounted);

    const evalCalls = dsh.calls.filter((c) => c.method === "runAutoEvaluation");
    assert.equal(evalCalls.length, 1, "恰发一次 runAutoEvaluation");
    assert.deepEqual(evalCalls[0].payload, {}, "评估入参为空对象");

    const result = mounted.find("[data-role=auto-eval-result]");
    assert.ok(result, "评估结果区渲染");
    const resultText = mounted.textOfEl(result);
    assert.ok(resultText.includes("评估时间 2026-11-21 11:00:00"), "评估时间行");
    assert.ok(resultText.includes("触发 手动"), "trigger 中文化");
    assert.ok(resultText.includes("回放规模：topics 5 · groups 2 · alarms "), "回放规模行");
    assert.ok(resultText.includes("本轮计划：冷却 1 + 恢复 1 = 共 2 条（每轮上限 3）"), "计划计数行");

    const candidates = mounted.findAll("[data-role=auto-candidate]");
    assert.equal(candidates.length, 2, "两条候选行");
    const candText = mounted.textOfEl(candidates[0]);
    assert.ok(candText.includes("归档候选"), "operationKind 中文化（archive-topic）");
    assert.ok(candText.includes("project-alpha（项目 α）"), "候选 key + title");
    assert.ok(candText.includes("T=0.12"), "温度 T");
    assert.ok(candText.includes("ageDays=40"), "账龄");
    assert.ok(candText.includes("理由："), "候选理由（§11.2.2：自动决策必带理由）");
    assert.ok(mounted.textOfEl(candidates[1]).includes("恢复候选"), "unarchive-topic 中文化");

    assert.equal(textOfElText(mounted, "[data-role=auto-evaluate]"), "重新评估", "评估后按钮转「重新评估」");

    // 评估成功已记账锚 → 状态卡同步刷新（getAutoStatus 第二次拉取）。
    const statusCalls = dsh.calls.filter((c) => c.method === "getAutoStatus");
    assert.ok(statusCalls.length >= 2, "评估成功后刷新 getAutoStatus（上次评估/下次触发权威在服务端）");
  } finally {
    mounted.unmount();
  }
});

// ── A3 执行本轮（auto 模式）─────────────────────────────────────────────────
test("A3 auto 模式：执行本轮 → 就地二次确认 → applyAutoChanges（operationId）→ 回执逐条 ops + runId；replay 回执同口径", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ mode: "auto" });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "status", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    assert.equal(mounted.find("[data-role=auto-apply]").getAttribute("disabled"), "false", "auto 模式下执行本轮可点");
    assert.equal(mounted.click("[data-role=auto-apply]"), true, "点「执行本轮」命中");
    await settle(mounted);

    // 二次确认行就地展开（此时还没发 RPC——执行写真实数据，必须先确认）。
    const confirm = mounted.find("[data-role=auto-confirm]");
    assert.ok(confirm, "就地确认行出现");
    assert.ok(mounted.textOfEl(confirm).includes("这不是预览"), "确认行明确告知会写数据");
    assert.equal(dsh.calls.filter((c) => c.method === "applyAutoChanges").length, 0, "确认前零执行调用");

    assert.equal(mounted.click("[data-role=auto-apply-confirm]"), true, "点「确认执行」命中");
    await settle(mounted);

    const applyCalls = dsh.calls.filter((c) => c.method === "applyAutoChanges");
    assert.equal(applyCalls.length, 1, "恰发一次 applyAutoChanges");
    const operationId = applyCalls[0].payload && applyCalls[0].payload.operationId;
    assert.equal(typeof operationId, "string", "operationId 为非空字符串（幂等键）");
    assert.ok(operationId.length >= 8 && operationId.length <= 128, "operationId 长度在 1..128 约束内");

    const receipt = mounted.find("[data-role=auto-apply-result]");
    assert.ok(receipt, "执行回执渲染");
    const receiptText = mounted.textOfEl(receipt);
    assert.ok(receiptText.includes("执行完成。 已执行 2 · 跳过 1 · 失败 0"), "计数行");
    assert.ok(receiptText.includes("runId auto-1763712000000-ab12cd34"), "runId 回显（供撤销关联）");
    assert.ok(receiptText.includes("连组恢复 1 条"), "groupRestore 提示");
    assert.ok(receiptText.includes("可在下方「最近执行记录」"), "撤销入口提示");

    const opRows = mounted.findAll("[data-role=auto-apply-op]");
    assert.equal(opRows.length, 3, "逐条 ops 行（2 applied + 1 skipped）");
    assert.ok(mounted.textOfEl(opRows[0]).includes("已执行"), "status 中文化：applied");
    assert.ok(mounted.textOfEl(opRows[1]).includes("已跳过"), "status 中文化：skipped");
    assert.ok(mounted.textOfEl(opRows[2]).includes("恢复"), "operationKind 中文化：unarchive-topic");

    // replay 回执（同 operationId 重放）：口径改为「回放首次结果」。
    world.applyResult = autoApplyDto({ replay: true });
    assert.equal(mounted.click("[data-role=auto-apply]"), true, "再次点「执行本轮」");
    await settle(mounted);
    assert.equal(mounted.click("[data-role=auto-apply-confirm]"), true, "再次确认");
    await settle(mounted);
    assert.ok(
      mounted.textOfEl(mounted.find("[data-role=auto-apply-result]")).includes("重复提交：回放首次执行结果"),
      "replay 回执口径",
    );
  } finally {
    mounted.unmount();
  }
});

// ── A4 一键撤销 ─────────────────────────────────────────────────────────────
test("A4 一键撤销：最近执行记录出撤销按钮 → undoAutoRun({runId}) → 回执计数；服务端 undoneAt 回读后按钮变「已撤销」文本", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ mode: "auto" });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "status", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    // 执行一轮（拿 runId）→ 服务端记账 → 面板回读出现 run 行。
    assert.equal(mounted.click("[data-role=auto-apply]"), true, "执行本轮");
    await settle(mounted);
    assert.equal(mounted.click("[data-role=auto-apply-confirm]"), true, "确认执行");
    await settle(mounted);

    world.lastRuns = [{
      runId: world.applyResult.runId,
      at: "2026-11-21T11:05:00.000Z",
      trigger: "manual",
      applied: 2,
      undoneAt: null,
    }];
    assert.equal(mounted.click("[data-role=auto-refresh]"), true, "点「刷新」回读最近执行记录");
    await settle(mounted);

    const runRows = mounted.findAll("[data-role=auto-run-row]");
    assert.equal(runRows.length, 1, "一条 run 行");
    const runText = mounted.textOfEl(runRows[0]);
    assert.ok(runText.includes("auto-1763712000000-ab12cd34"), "runId 展示");
    assert.ok(runText.includes("2026-11-21 11:05:00"), "run 时间");
    assert.ok(runText.includes("已执行 2 条"), "applied 计数");
    assert.ok(mounted.find("[data-role=auto-undo]"), "未撤销的 run 有撤销按钮");

    // 一键撤销。
    assert.equal(mounted.click("[data-role=auto-undo]"), true, "点「一键撤销」命中");
    await settle(mounted);

    const undoCalls = dsh.calls.filter((c) => c.method === "undoAutoRun");
    assert.equal(undoCalls.length, 1, "恰发一次 undoAutoRun");
    assert.deepEqual(undoCalls[0].payload, { runId: "auto-1763712000000-ab12cd34" }, "按 runId 撤销");

    const undoResult = mounted.find("[data-role=auto-undo-result]");
    assert.ok(undoResult, "撤销回执渲染");
    const undoText = mounted.textOfEl(undoResult);
    assert.ok(undoText.includes("撤销完成。 回滚 2 · 已是撤销态 0 · 跳过 0 · 失败 0"), "撤销计数行");

    // 服务端 undoneAt 回读后：按钮消失，变「已撤销」文本。
    world.lastRuns[0].undoneAt = "2026-11-21T11:10:00.000Z";
    assert.equal(mounted.click("[data-role=auto-refresh]"), true, "刷新回读 undoneAt");
    await settle(mounted);
    assert.equal(mounted.find("[data-role=auto-undo]"), null, "已撤销 run 不再有撤销按钮");
    assert.ok(mounted.textOfEl(mounted.findAll("[data-role=auto-run-row]")[0]).includes("已撤销"), "行内显示已撤销时间");
  } finally {
    mounted.unmount();
  }
});

// ── A5 三档模式开关 ─────────────────────────────────────────────────────────
test("A5 模式开关：写 forgetting.autoMode（configForms CAS）→ 服务端未热提交时 pending 提示 → 回读后收口 + 高亮；立即生效路径走 toast", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const configScope = makeConfigScope({ mode: "active", forgetting: { enabled: true, autoMode: "suggest" } });
  const world = makeWorld();
  const dsh = makeDsh(world, configScope);
  const mounted = await harness.mount({ tab: "status", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    // 立即生效路径：点当前档（suggest → suggest）→ 服务端现读一致 → toast，无 pending。
    assert.equal(mounted.click("[data-role=auto-mode-suggest]"), true, "点当前档（幂等写）");
    await settle(mounted);
    assert.equal(configScope.mutations.length, 1, "configForms 恰被 mutate 一次");
    assert.deepEqual(configScope.mutations[0].ops, [{ op: "set", path: ["forgetting", "autoMode"], value: "suggest" }], "只写 forgetting.autoMode 单键");
    assert.equal(configScope.mutations[0].revision, 7, "按当前 revision 提交");
    assert.equal(configScope.getSnapshot().revision, 8, "快照 revision 已推进（写入确认）");
    assert.equal(mounted.find("[data-role=auto-mode-pending]"), null, "服务端立即回读 → 无 pending 提示");
    const toastTexts = toastTextsOf(harness.document);
    assert.ok(toastTexts.some((t) => t.includes("记忆整理模式已保存")), "toast 收口提示");

    // 滞后路径：切到 auto，服务端仍回 suggest（宿主尚未热提交）→ pending 提示。
    assert.equal(mounted.click("[data-role=auto-mode-auto]"), true, "点「自动」档");
    await settle(mounted);
    assert.deepEqual(configScope.mutations[1].ops, [{ op: "set", path: ["forgetting", "autoMode"], value: "auto" }], "第二次写 autoMode=auto");
    assert.equal(configScope.getSnapshot().value.forgetting.autoMode, "auto", "配置确已生效");
    const pending = mounted.find("[data-role=auto-mode-pending]");
    assert.ok(pending, "服务端未热提交 → pending 提示出现");
    const pendingText = mounted.textOfEl(pending);
    assert.ok(pendingText.includes("forgetting.autoMode=auto"), "写入了什么");
    assert.ok(pendingText.includes("服务端当前仍是 suggest"), "服务端现状如实回显（不谎报生效）");

    // 服务端热提交后：手动「刷新」也能收口 pending + 当前档高亮。
    world.mode = "auto";
    assert.equal(mounted.click("[data-role=auto-refresh]"), true, "点「刷新」");
    await settle(mounted);
    assert.equal(mounted.find("[data-role=auto-mode-pending]"), null, "pending 提示收口");
    const autoBtn = mounted.find("[data-role=auto-mode-auto]");
    assert.ok(String(autoBtn.className).includes("dshi_btnPrimary"), "auto 档高亮");
    assert.ok(mounted.textOfEl(mounted.find("[data-role=auto-card]")).includes("自动（评估后自动执行"), "模式行文本更新");
  } finally {
    mounted.unmount();
  }
});

// ── A6 熔断 ─────────────────────────────────────────────────────────────────
test("A6 熔断：fuse.fused=true → 熔断徽章 + 判定明细行 + 「执行本轮」禁用并带 title 说明", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({
    mode: "auto",
    statusOverrides: {
      fuse: {
        fused: true,
        reasons: [{ code: "LEDGER_DAMAGED", detail: "账本存在 3 条坏行（损坏内容已跳过）" }],
        statsValid: false,
        statsStartedAt: null,
        maxEventAt: "2026-11-21T09:00:00.000Z",
        eventCount: 10,
      },
    },
    evalResult: autoEvalDto({ fused: true, candidates: [], plan: { ops: [], truncated: false, groupRestore: [], counts: { cool: 0, restore: 0, total: 0 } } }),
  });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "status", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    const card = mounted.find("[data-role=auto-card]");
    const cardText = mounted.textOfEl(card);
    assert.ok(cardText.includes("已熔断（本轮不出任何可执行候选）"), "熔断状态行");
    const badge = mounted.find("[data-role=auto-fuse-badge]");
    assert.equal(mounted.textOfEl(badge), "熔断", "徽章文案");
    assert.ok(String(badge.className).includes("dshi_badgeWarn"), "徽章警示样式");

    const reasons = mounted.find("[data-role=auto-fuse-reasons]");
    assert.ok(reasons, "判定明细行渲染");
    assert.ok(mounted.textOfEl(reasons).includes("[LEDGER_DAMAGED]"), "明细带 code");
    assert.ok(mounted.textOfEl(reasons).includes("坏行"), "明细带 detail");

    const applyBtn = mounted.find("[data-role=auto-apply]");
    assert.equal(applyBtn.getAttribute("disabled"), "true", "熔断时执行本轮禁用");
    assert.equal(applyBtn.getAttribute("title"), "已熔断：本轮不出任何可执行候选", "title 说明");
  } finally {
    mounted.unmount();
  }
});

// ── A7 off 模式 ─────────────────────────────────────────────────────────────
test("A7 off：立即评估禁用并说明（off 只记账不评估），模式行显示关闭档", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ mode: "off" });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "status", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    const card = mounted.find("[data-role=auto-card]");
    assert.ok(card, "off 模式卡片仍渲染（模块开着、autoMode=off）");
    assert.ok(mounted.textOfEl(card).includes("关闭（只记账，不评估）"), "模式行文本");
    assert.ok(String(mounted.find("[data-role=auto-mode-off]").className).includes("dshi_btnPrimary"), "off 档高亮");

    const evaluateBtn = mounted.find("[data-role=auto-evaluate]");
    assert.equal(evaluateBtn.getAttribute("disabled"), "true", "立即评估禁用");
    assert.equal(evaluateBtn.getAttribute("title"), "mode=off 只记账不评估：先切到「建议」或「自动」", "title 说明");

    const applyBtn = mounted.find("[data-role=auto-apply]");
    assert.equal(applyBtn.getAttribute("disabled"), "true", "执行本轮禁用");
    assert.equal(applyBtn.getAttribute("title"), "仅 mode=auto 可执行：先切到「自动」（suggest 只出清单，off 只记账）", "title 说明");
  } finally {
    mounted.unmount();
  }
});

// ── A8 取数失败整卡静默 ─────────────────────────────────────────────────────
test("A8 getAutoStatus 失败（shadow / 未启动 / 模块关）：整卡静默隐藏，不出错框不崩", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ autoStatusError: Object.assign(new Error("UNSUPPORTED: forgetting module is disabled"), { code: "UNSUPPORTED" }) });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "status", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    assert.equal(mounted.find("[data-role=auto-card]"), null, "auto 卡不渲染");
    assert.ok(!mounted.text().includes("记忆整理（自动冷却 / 恢复）"), "标题不出现在任何位置");
    // 状态页其余部分不受牵连：运行状态卡照常渲染。
    assert.ok(mounted.text().includes("运行状态"), "状态页本体不受牵连");
    assert.ok(mounted.text().includes("运行中"), "getStatus 正常回显");
  } finally {
    mounted.unmount();
  }
});

// ── A9 configForms 缺席 ─────────────────────────────────────────────────────
test("A9 configForms 缺席（旧宿主）：三档按钮禁用 + 指路文案，状态行照常回显", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld();
  const dsh = makeDsh(world); // 不挂 configScope
  const mounted = await harness.mount({ tab: "status", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    const card = mounted.find("[data-role=auto-card]");
    assert.ok(card, "卡片照常渲染（只读回显不受 configForms 影响）");
    for (const mode of ["off", "suggest", "auto"]) {
      assert.equal(mounted.find(`[data-role=auto-mode-${mode}]`).getAttribute("disabled"), "true", `${mode} 档按钮禁用`);
    }
    assert.ok(mounted.textOfEl(card).includes("设置命名空间不可用（configForms 缺席）"), "指路文案");
    assert.ok(mounted.textOfEl(card).includes("forgetting.autoMode"), "指到具体配置键");
    assert.ok(mounted.textOfEl(card).includes("建议（评估出清单"), "模式行照常回显服务端现值");
  } finally {
    mounted.unmount();
  }
});
