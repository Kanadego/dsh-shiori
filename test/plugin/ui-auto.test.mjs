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
//      按钮转「重新评估」；候选行 checkbox 默认全选（0.5 第三波）
//   A3 自动模式：评估 → 一键全应用 → 就地二次确认 → 确认执行 → applyAutoChanges
//      （selection:null + operationId 幂等键）→ 回执（已执行/跳过/失败 + 逐条 ops +
//      runId）；replay 回执同口径
//   A3b 建议模式双通道（0.5 第三波）：suggest 可执行——勾选子集「应用选中」payload
//      只含选中项；「一键全应用」payload selection=null；N=0 禁用；新评估回包重置全选
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

// applyAutoChanges 幂等键形状：与服务端契约对齐（src/storage/paths.mjs
// validateOperationId，:111-131）——长度 1..128 且 ^[A-Za-z0-9][A-Za-z0-9._-]*$。
// 生产 newId()（client/index.js:561-566）的 UUID 与 op-<base36>-<8 位随机> 两种
// 产物都满足该契约；这里只锁服务端接受的形状，不锁客户端实现格式（客户端换
// id 方案不应被测试误杀）。
const OPERATION_ID_SERVER_CONTRACT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertOperationIdShape(value, label) {
  assert.equal(typeof value, "string", `${label} 为非空字符串（幂等键）`);
  assert.ok(value.length >= 1 && value.length <= 128, `${label} 长度在 1..128 约束内`);
  assert.ok(
    OPERATION_ID_SERVER_CONTRACT.test(value),
    `${label} 匹配服务端契约（字母/数字开头，仅字母/数字/点/下划线/连字符）：实际 ${JSON.stringify(value)}`,
  );
}

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
  const mounted = await harness.mount({ tab: "candidates", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    const card = mounted.find("[data-role=auto-card]");
    assert.ok(card, "auto 卡渲染在专题整理页");

    // 三档开关：当前档（suggest）高亮 primary，其余档可点。
    const offBtn = mounted.find("[data-role=auto-mode-off]");
    const suggestBtn = mounted.find("[data-role=auto-mode-suggest]");
    const autoBtn = mounted.find("[data-role=auto-mode-auto]");
    assert.ok(offBtn && suggestBtn && autoBtn, "三档按钮齐备");

    const cardText = mounted.textOfEl(card);
    assert.ok(cardText.includes("记忆整理（自动冷却 / 恢复）"), "卡片标题");
    // 模式行只回显服务端当前档的说明文案（autoModeText 当前档一个）；三档按钮各自带档名。
    // 0.5 第三波：suggest 文案改为「不自动执行，确认后执行」（双通道拍板）。
    assert.ok(cardText.includes("建议（不自动执行，确认后执行）"), "suggest 当前档说明文本");
    assert.ok(mounted.textOfEl(suggestBtn).includes("建议（当前）"), "当前档按钮带（当前）标记");
    assert.equal(mounted.textOfEl(offBtn), "关闭", "off 档按钮文案");
    assert.ok(cardText.includes("上次评估"), "上次评估行");
    assert.ok(cardText.includes("2026-11-21 10:00:00"), "lastEvaluatedAt 格式化为本地可读时间");
    assert.ok(cardText.includes("人类轮自动触发"), "lastEvaluatedBy 中文化");
    assert.ok(cardText.includes("下次评估窗口 2026-11-22 10:00:00（约 24 小时后）"), "nextTrigger 行（服务端权威）");
    assert.ok(cardText.includes("保护期状态"), "保护期状态行");
    assert.ok(cardText.includes("正常"), "保护期未触发时为正常");
    assert.ok(cardText.includes("每轮最多执行（条） 3") && cardText.includes("（maxOpsPerRun）"), "auto 参数快照行（中文主名 + 小字符号）");
    assert.ok(cardText.includes("评估周期（小时） 24") && cardText.includes("（evaluateEveryHours）"), "auto 参数快照行（第二项）");

    assert.ok(String(suggestBtn.className).includes("dshi_btnPrimary"), "当前档 suggest 高亮");
    assert.ok(!String(offBtn.className).includes("dshi_btnPrimary"), "off 档不高亮");
    assert.equal(suggestBtn.getAttribute("disabled"), "false", "按钮可点（configForms 缺席时才禁用）");

    // 动作按钮：立即评估 + 双执行入口（应用选中 / 一键全应用）+ 刷新。
    const evaluateBtn = mounted.find("[data-role=auto-evaluate]");
    const applySelectedBtn = mounted.find("[data-role=auto-apply-selected]");
    const applyAllBtn = mounted.find("[data-role=auto-apply-all]");
    assert.ok(evaluateBtn && applySelectedBtn && applyAllBtn, "动作按钮齐备（评估 + 双执行入口）");
    assert.equal(textOfElText(mounted, "[data-role=auto-evaluate]"), "立即评估", "首屏按钮文案");
    // 0.5 第三波：未评估时 N=0 / M=0 → 双执行入口禁用（对应数量为 0）；suggest 档
    // 本身不再禁用（禁用条件只剩 off / 熔断 / enabled=false / busy / 数量为 0）。
    assert.equal(applySelectedBtn.getAttribute("disabled"), "true", "未评估 N=0：应用选中禁用");
    assert.equal(textOfElText(mounted, "[data-role=auto-apply-selected]"), "应用选中（0 条）", "应用选中带 N 计数");
    assert.equal(applyAllBtn.getAttribute("disabled"), "true", "未评估 M=0：一键全应用禁用");
    assert.equal(textOfElText(mounted, "[data-role=auto-apply-all]"), "一键全应用", "一键全应用按钮文案");

    // 最近执行记录空态。
    assert.ok(mounted.find("[data-role=auto-runs-empty]"), "无 run 时空态文案");
    assert.equal(mounted.findAll("[data-role=auto-run-row]").length, 0, "无 run 行");

    // 建议模式提示语（0.5 第三波新语义：确认后执行）。
    assert.ok(cardText.includes("建议模式不会自动执行：勾选候选后点「应用选中」，或直接「一键全应用」。"), "suggest 模式提示语（新语义）");
    assert.equal(cardText.includes("建议模式只出清单"), false, "旧「只出清单」提示语已废弃");
  } finally {
    mounted.unmount();
  }
});

// ── A2 立即评估 ─────────────────────────────────────────────────────────────
test("A2 建议模式：立即评估 → runAutoEvaluation → 候选清单/回放规模/计划计数渲染，按钮转「重新评估」", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld();
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "candidates", dsh });
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

// ── A3 一键全应用（auto 模式）────────────────────────────────────────────────
test("A3 auto 模式：评估 → 一键全应用 → 就地二次确认 → applyAutoChanges（selection:null + operationId）→ 回执逐条 ops + runId；replay 回执同口径；两次执行 operationId 严格不等", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ mode: "auto" });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "candidates", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    // 0.5 第三波：未评估时 M=0 → 一键全应用禁用；先评估拿到候选（候选区与计数
    // 都来自评估回包）。
    assert.equal(mounted.find("[data-role=auto-apply-all]").getAttribute("disabled"), "true", "未评估 M=0：一键全应用禁用");
    assert.equal(mounted.click("[data-role=auto-evaluate]"), true, "先评估");
    await settle(mounted);
    assert.equal(mounted.find("[data-role=auto-apply-all]").getAttribute("disabled"), "false", "评估后 auto 模式一键全应用可点");
    assert.equal(mounted.click("[data-role=auto-apply-all]"), true, "点「一键全应用」命中");
    await settle(mounted);

    // 二次确认行就地展开（此时还没发 RPC——执行写真实数据，必须先确认）。
    const confirm = mounted.find("[data-role=auto-confirm]");
    assert.ok(confirm, "就地确认行出现");
    const confirmText = mounted.textOfEl(confirm);
    assert.ok(confirmText.includes("本轮全部 2 条"), "全应用通道确认文案带 M（本轮全部 2 条）");
    assert.ok(confirmText.includes("这不是预览"), "确认行明确告知会写数据");
    assert.ok(confirmText.includes("≤ 3"), "确认文案标明服务端复算后 ≤ maxOpsPerRun=3");
    assert.equal(dsh.calls.filter((c) => c.method === "applyAutoChanges").length, 0, "确认前零执行调用");

    assert.equal(mounted.click("[data-role=auto-apply-confirm]"), true, "点「确认执行」命中");
    await settle(mounted);

    const applyCalls = dsh.calls.filter((c) => c.method === "applyAutoChanges");
    assert.equal(applyCalls.length, 1, "恰发一次 applyAutoChanges");
    assert.equal(applyCalls[0].payload.selection, null, "一键全应用 payload selection=null（0.5 第三波契约）");
    const operationId = applyCalls[0].payload && applyCalls[0].payload.operationId;
    assertOperationIdShape(operationId, "首次执行 operationId");

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

    // replay 回执：客户端每次「一键全应用」都生成新 operationId（下方三次调用
    // 两两不同可证），replay 标记由 stub 伪造——模拟服务端按幂等键判定重复
    // 提交后「回放首次结果、不二次执行」的口径，验证的是 UI 渲染不是重放链路。
    world.applyResult = autoApplyDto({ replay: true });
    assert.equal(mounted.click("[data-role=auto-apply-all]"), true, "再次点「一键全应用」");
    await settle(mounted);
    assert.equal(mounted.click("[data-role=auto-apply-confirm]"), true, "再次确认");
    await settle(mounted);
    assert.ok(
      mounted.textOfEl(mounted.find("[data-role=auto-apply-result]")).includes("重复提交：回放首次执行结果"),
      "replay 回执口径",
    );

    // ── 两次独立执行：operationId 必须严格不等 ──────────────────────────────
    // 完整再走一遍「一键全应用」→「确认执行」，world 回正常回执（replay:false）。
    // 生产若把 newId() 写死成常量 / 复用同一 id，下面的 notEqual 即变红。
    world.applyResult = autoApplyDto();
    assert.equal(mounted.click("[data-role=auto-apply-all]"), true, "第二次干净执行：点「一键全应用」");
    await settle(mounted);
    assert.equal(
      dsh.calls.filter((c) => c.method === "applyAutoChanges").length,
      2,
      "第二轮确认前零新增执行调用（仍是首次 + replay 两次）",
    );
    assert.equal(mounted.click("[data-role=auto-apply-confirm]"), true, "第二次干净执行：确认执行");
    await settle(mounted);

    const allApplyCalls = dsh.calls.filter((c) => c.method === "applyAutoChanges");
    assert.equal(allApplyCalls.length, 3, "共三次 applyAutoChanges（首次 + replay 轮 + 干净第二轮）");
    // 每次调用各自独立 payload：逐个核 operationId 格式、长度与 selection=null。
    for (const [i, call] of allApplyCalls.entries()) {
      assertOperationIdShape(call.payload && call.payload.operationId, `第 ${i + 1} 次执行 operationId`);
      assert.equal(call.payload.selection, null, `第 ${i + 1} 次全应用 selection=null`);
    }
    const secondOperationId = allApplyCalls[2].payload.operationId;
    assert.notEqual(secondOperationId, operationId, "两次独立执行的 operationId 必须严格不等（不同提交不得复用同一 operationId）");
    const distinctIds = new Set(allApplyCalls.map((c) => c.payload.operationId));
    assert.equal(distinctIds.size, 3, "三次执行各自独立 payload：operationId 两两不同");

    const secondReceiptText = mounted.textOfEl(mounted.find("[data-role=auto-apply-result]"));
    assert.ok(secondReceiptText.includes("执行完成。"), "干净第二轮出正常执行回执");
    assert.ok(!secondReceiptText.includes("重复提交：回放首次执行结果"), "干净第二轮回执不是 replay 口径");
  } finally {
    mounted.unmount();
  }
});

// ── A4 一键撤销 ─────────────────────────────────────────────────────────────
test("A4 一键撤销：最近执行记录出撤销按钮 → undoAutoRun({runId}) → 回执计数；服务端 undoneAt 回读后按钮变「已撤销」文本", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ mode: "auto" });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "candidates", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    // 执行一轮（拿 runId）→ 服务端记账 → 面板回读出现 run 行。
    assert.equal(mounted.click("[data-role=auto-evaluate]"), true, "先评估（0.5 第三波：M 计数来自评估回包）");
    await settle(mounted);
    assert.equal(mounted.click("[data-role=auto-apply-all]"), true, "一键全应用");
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
    assert.equal(mounted.click("[data-role=status-refresh]"), true, "点「刷新」回读最近执行记录");
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
    assert.equal(mounted.click("[data-role=status-refresh]"), true, "刷新回读 undoneAt");
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
  const mounted = await harness.mount({ tab: "candidates", dsh });
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
    assert.equal(mounted.click("[data-role=status-refresh]"), true, "点「刷新」");
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
test("A6 保护期：fuse.fused=true → 保护期徽章 + 双执行入口禁用并带 title 说明", async () => {
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
  const mounted = await harness.mount({ tab: "candidates", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    const card = mounted.find("[data-role=auto-card]");
    const cardText = mounted.textOfEl(card);
    assert.ok(cardText.includes("已进入保护期（本轮不出任何可执行候选）"), "保护期状态行");
    const badge = mounted.find("[data-role=auto-fuse-badge]");
    assert.equal(mounted.textOfEl(badge), "保护期", "徽章文案");
    assert.ok(String(badge.className).includes("dshi_badgeWarn"), "徽章警示样式");

    // 0.5.0 转正：判定明细（原始 reasons）随技术细节一起裁撤，只留徽章与状态行。
    assert.equal(mounted.find("[data-role=auto-fuse-reasons]"), null, "判定明细行已裁撤");

    // 0.5 第三波：双执行入口在熔断时都禁用（禁用条件含熔断），title 说明熔断口径。
    const applySelectedBtn = mounted.find("[data-role=auto-apply-selected]");
    const applyAllBtn = mounted.find("[data-role=auto-apply-all]");
    assert.equal(applySelectedBtn.getAttribute("disabled"), "true", "熔断时应用选中禁用");
    assert.equal(applyAllBtn.getAttribute("disabled"), "true", "熔断时一键全应用禁用");
    assert.equal(applySelectedBtn.getAttribute("title"), "已进入保护期：本轮不出任何可执行候选", "应用选中 title 说明");
    assert.equal(applyAllBtn.getAttribute("title"), "已进入保护期：本轮不出任何可执行候选", "一键全应用 title 说明");
  } finally {
    mounted.unmount();
  }
});

// ── A7 off 模式 ─────────────────────────────────────────────────────────────
test("A7 off：立即评估禁用并说明（off 只记账不评估），双执行入口禁用并说明，模式行显示关闭档", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ mode: "off" });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "candidates", dsh });
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

    // 0.5 第三波：off 仍拒绝执行——双执行入口禁用，title 说明 off 口径（文案换成
    // off 专属：suggest 已放开，不再拖 suggest 一起提）。
    const applySelectedBtn = mounted.find("[data-role=auto-apply-selected]");
    const applyAllBtn = mounted.find("[data-role=auto-apply-all]");
    assert.equal(applySelectedBtn.getAttribute("disabled"), "true", "off 模式应用选中禁用");
    assert.equal(applyAllBtn.getAttribute("disabled"), "true", "off 模式一键全应用禁用");
    assert.equal(applySelectedBtn.getAttribute("title"), "mode=off 只记账不执行：先切到「建议」或「自动」", "应用选中 title 说明（off）");
    assert.equal(applyAllBtn.getAttribute("title"), "mode=off 只记账不执行：先切到「建议」或「自动」", "一键全应用 title 说明（off）");
  } finally {
    mounted.unmount();
  }
});

// ── A8 取数失败整卡静默 ─────────────────────────────────────────────────────
test("A8 getAutoStatus 失败（shadow / 未启动 / 模块关）：整卡静默隐藏，不出错框不崩", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ autoStatusError: Object.assign(new Error("UNSUPPORTED: forgetting module is disabled"), { code: "UNSUPPORTED" }) });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "candidates", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    assert.equal(mounted.find("[data-role=auto-card]"), null, "auto 卡不渲染");
    assert.ok(!mounted.text().includes("记忆整理（自动冷却 / 恢复）"), "标题不出现在任何位置");
    // 专题整理页其余部分不受牵连：索引与分组窗格与整理说明照常渲染。
    assert.ok(mounted.find("[data-role=organize-pane-candidates]"), "专题整理页本体不受牵连");
    assert.ok(mounted.text().includes("整理功能才启用不到 30 天"), "整理说明句照常回显");
  } finally {
    mounted.unmount();
  }
});

// ── A9 configForms 缺席 ─────────────────────────────────────────────────────
test("A9 configForms 缺席（旧宿主）：三档按钮禁用 + 指路文案，状态行照常回显", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld();
  const dsh = makeDsh(world); // 不挂 configScope
  const mounted = await harness.mount({ tab: "candidates", dsh });
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
    assert.ok(mounted.textOfEl(card).includes("建议（不自动执行"), "模式行照常回显服务端现值（0.5 第三波新文案）");
  } finally {
    mounted.unmount();
  }
});

// ── A10 suggest 双通道：默认全选 / 全不选 / N=0 禁用 / 新评估回包重置全选 ───────
test("A10 suggest 双通道（0.5 第三波）：评估后默认全选；全不选 → 应用选中（0 条）禁用、一键全应用保持可点；重新评估回包把勾选重置为全选", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ mode: "suggest" });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "candidates", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    assert.equal(mounted.click("[data-role=auto-evaluate]"), true, "点「立即评估」命中");
    await settle(mounted);

    // 默认全选：两条候选行的 checkbox 都是 checked，计数「已勾选 2 条」，应用选中（2 条）可点。
    const checkboxes = () => mounted.findAll("[data-role=auto-candidate-pick]");
    assert.equal(checkboxes().length, 2, "每条候选行一个 checkbox");
    for (const box of checkboxes()) {
      assert.equal(box.getAttribute("checked"), "true", "默认全选：checkbox checked");
      assert.equal(String(box.getAttribute("value")).includes("|"), true, "勾选值为 operationKind|key 复合 id");
    }
    const pickToolsText = mounted.textOfEl(mounted.find("[data-role=auto-pick-tools]"));
    assert.ok(pickToolsText.includes("本轮共 2 条候选 · 已勾选 2 条"), "勾选计数行");
    assert.equal(mounted.find("[data-role=auto-select-all]") !== null, true, "全选按钮存在");
    assert.equal(mounted.find("[data-role=auto-select-none]") !== null, true, "全不选按钮存在");
    assert.equal(mounted.find("[data-role=auto-apply-selected]").getAttribute("disabled"), "false", "suggest 下应用选中可点（不再禁用）");
    assert.equal(mounted.textOfEl(mounted.find("[data-role=auto-apply-selected]")), "应用选中（2 条）", "N=2 计数");

    // 全不选 → N=0：应用选中禁用；M=2>0 → 一键全应用保持可点。
    assert.equal(mounted.click("[data-role=auto-select-none]"), true, "点「全不选」命中");
    await settle(mounted);
    assert.equal(mounted.textOfEl(mounted.find("[data-role=auto-apply-selected]")), "应用选中（0 条）", "N=0 计数");
    assert.equal(mounted.find("[data-role=auto-apply-selected]").getAttribute("disabled"), "true", "N=0 时应用选中禁用");
    assert.equal(mounted.find("[data-role=auto-apply-all]").getAttribute("disabled"), "false", "M=2>0：一键全应用保持可点");

    // 全选恢复。
    assert.equal(mounted.click("[data-role=auto-select-all]"), true, "点「全选」命中");
    await settle(mounted);
    assert.equal(mounted.find("[data-role=auto-apply-selected]").getAttribute("disabled"), "false", "全选后应用选中恢复可点");

    // 取消一条 → 重新评估：新评估回包把勾选重置为全选（不复用上一轮勾选残留）。
    checkboxes()[0].onchange();
    await settle(mounted);
    assert.equal(checkboxes()[0].getAttribute("checked"), "false", "取消勾选第一条生效");
    assert.equal(mounted.textOfEl(mounted.find("[data-role=auto-apply-selected]")), "应用选中（1 条）", "N=1 计数");
    assert.equal(mounted.click("[data-role=auto-evaluate]"), true, "重新评估");
    await settle(mounted);
    for (const box of mounted.findAll("[data-role=auto-candidate-pick]")) {
      assert.equal(box.getAttribute("checked"), "true", "新评估回包重置为全选");
    }
    assert.equal(mounted.textOfEl(mounted.find("[data-role=auto-apply-selected]")), "应用选中（2 条）", "重置后 N=2");
  } finally {
    mounted.unmount();
  }
});

// ── A11 suggest 双通道：应用选中 payload 只含勾选项；一键全应用 payload selection=null ──
test("A11 suggest 双通道（0.5 第三波）：只勾一条时「应用选中」payload 只含选中项（含 operationKind）；「一键全应用」payload selection=null；确认文案分清两条通道", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const world = makeWorld({ mode: "suggest" });
  const dsh = makeDsh(world);
  const mounted = await harness.mount({ tab: "candidates", dsh });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();

    assert.equal(mounted.click("[data-role=auto-evaluate]"), true, "先评估");
    await settle(mounted);

    // 取消勾选第一条（project-alpha，archive-topic）→ 只勾 topic-beta（unarchive-topic）。
    const boxes = mounted.findAll("[data-role=auto-candidate-pick]");
    assert.equal(String(boxes[0].getAttribute("value")), "archive-topic|project-alpha", "复合 id：kind|key（第一条）");
    assert.equal(String(boxes[1].getAttribute("value")), "unarchive-topic|topic-beta", "复合 id：kind|key（第二条）");
    boxes[0].onchange();
    await settle(mounted);
    assert.equal(mounted.textOfEl(mounted.find("[data-role=auto-apply-selected]")), "应用选中（1 条）", "N=1");

    // 应用选中通道：确认文案是「选中的 N 条」，payload.selection 只含勾选项。
    assert.equal(mounted.click("[data-role=auto-apply-selected]"), true, "点「应用选中」命中");
    await settle(mounted);
    const confirmSelected = mounted.textOfEl(mounted.find("[data-role=auto-confirm]"));
    assert.ok(confirmSelected.includes("选中的 1 条"), "选中通道确认文案（选中的 1 条）");
    assert.equal(confirmSelected.includes("本轮全部 2 条"), false, "选中通道不出全量文案");
    assert.equal(mounted.click("[data-role=auto-apply-confirm]"), true, "确认执行（选中通道）");
    await settle(mounted);

    const selectedCalls = dsh.calls.filter((c) => c.method === "applyAutoChanges");
    assert.equal(selectedCalls.length, 1);
    assert.deepEqual(selectedCalls[0].payload.selection, [
      { key: "topic-beta", operationKind: "unarchive-topic" },
    ], "payload.selection 只含勾选项（project-alpha 已取消，不出现在 payload）");
    assertOperationIdShape(selectedCalls[0].payload.operationId, "应用选中 operationId");

    // 一键全应用通道：确认文案是「本轮全部 M 条」，payload.selection=null。
    assert.equal(mounted.click("[data-role=auto-apply-all]"), true, "点「一键全应用」命中");
    await settle(mounted);
    const confirmAll = mounted.textOfEl(mounted.find("[data-role=auto-confirm]"));
    assert.ok(confirmAll.includes("本轮全部 2 条"), "全应用通道确认文案（本轮全部 2 条）");
    assert.equal(confirmAll.includes("选中的 1 条"), false, "全应用通道不出选中文案");
    assert.equal(mounted.click("[data-role=auto-apply-confirm]"), true, "确认执行（全应用通道）");
    await settle(mounted);

    const allCalls = dsh.calls.filter((c) => c.method === "applyAutoChanges");
    assert.equal(allCalls.length, 2);
    assert.equal(allCalls[1].payload.selection, null, "一键全应用 payload selection=null");
    assert.notEqual(allCalls[1].payload.operationId, allCalls[0].payload.operationId, "两通道各自独立 operationId");
  } finally {
    mounted.unmount();
  }
});
