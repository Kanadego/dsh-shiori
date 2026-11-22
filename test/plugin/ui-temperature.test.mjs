// 0.5 批次 4 · B 线：设置页「记忆整理」热度参数面板测试（批次 3 ui-harness）。
//
// 证据级别：真实执行 client/index.js（harness 的 fake window.__ModuleLoader__ +
// 有状态 react stub + 真实宿主 zod），mount() 走真实重渲染循环（state 变更 →
// 重新执行组件函数 → DOM 更新）。SYNTHETIC，非浏览器实机。
//
// 覆盖任务书面板验收：
// - 12 项表单（当前值 / 默认值 / 范围 / 单位 / 说明）——默认值与规格一律取自
//   服务端 DTO（TEMPERATURE_DTO），测试内不再抄第二份；
// - 改值 → 预览出现「会冷却 / 会恢复」两张清单与 L1 字符净变化；
// - 保存顺序：scope.mutate → 快照确认 → recordTemperatureChange → 审计多一条；
//   保存当刻 executePlan / listCandidates 零调用；
// - recorded:false（无新增审计）与 recorded:true（N 项变更）提示分开；
// - 仅「尚未生效」INVALID_STATE 重试 ≤3 次；审计 I/O 等其他 INVALID_STATE
//   不重试且原样展示服务端 message；
// - 逐项 / 全部恢复默认；非法值当场红字（服务端 INVALID_INPUT 原文），保存禁用。

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createUiHarness } from "./ui-harness.mjs";
import { DEFAULT_TEMPERATURE_PARAMS, PARAM_SPECS } from "../../src/forgetting/params.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const CLIENT_SRC = join(WORKQ, "client", "index.js");

const harness = createUiHarness({ clientSource: CLIENT_SRC });
await harness.install();

test.after(() => {
  harness.restore();
});

// 服务端 DTO 夹具（唯一一份；断言里的默认值/范围/说明全部从这里取）。
const TEMPERATURE_DTO = Object.freeze({
  defaults: Object.freeze({
    s0Days: 30, sMaxDays: 180, consolidateGain: 0.5, readAlpha: 0.35,
    updatedFloor: 85, readDedupHours: 24, coolThreshold: 25, restoreThreshold: 50,
    minCooldownDays: 30, minRestoreGraceDays: 14, maxOpsPerRun: 20, evaluateEveryHours: 24,
  }),
  specs: Object.freeze({
    s0Days: Object.freeze({ min: 7, max: 90, unit: "天", description: "新生 Topic 的初始有效半衰期 S0" }),
    sMaxDays: Object.freeze({ min: 60, max: 365, unit: "天", description: "间隔巩固上限 Smax" }),
    consolidateGain: Object.freeze({ min: 0, max: 1, unit: "无量纲", description: "间隔巩固增益 g" }),
    readAlpha: Object.freeze({ min: 0.1, max: 0.6, unit: "无量纲", description: "read 加热系数 alpha" }),
    updatedFloor: Object.freeze({ min: 50, max: 100, unit: "温度", description: "内容修改后的温度保底" }),
    readDedupHours: Object.freeze({ min: 6, max: 72, unit: "小时", description: "read 全局冷却窗口（去重）" }),
    coolThreshold: Object.freeze({ min: 10, max: 40, unit: "温度", description: "冷却线，低于即 cold" }),
    restoreThreshold: Object.freeze({ min: 30, max: 80, unit: "温度", description: "恢复线，回升到即恢复" }),
    minCooldownDays: Object.freeze({ min: 7, max: 90, unit: "天", description: "最小冷却年龄（观察期）" }),
    minRestoreGraceDays: Object.freeze({ min: 3, max: 30, unit: "天", description: "手动恢复后的保护期" }),
    maxOpsPerRun: Object.freeze({ min: 1, max: 50, unit: "条", integer: true, description: "auto 单轮最多执行条数" }),
    evaluateEveryHours: Object.freeze({ min: 6, max: 168, unit: "小时", description: "评估周期" }),
  }),
  crossChecks: Object.freeze([
    Object.freeze({ code: "RESTORE_HYSTERESIS", left: "restoreThreshold", right: "coolThreshold", rule: "restoreThreshold >= coolThreshold + 10" }),
  ]),
  hysteresis: 10,
});

const TEMP_KEYS = Object.keys(TEMPERATURE_DTO.specs);

// 批次 8-3 漂移守卫 + 0.5-10（债 13）：TEMPERATURE_DTO 夹具此前与 src/forgetting/params.mjs
// 无同源校验——params.mjs 加参数/改默认值忘了同步夹具不会红。这里锁「键集合（数量+逐 key）」
// 与「默认值逐键一致」，并（债 13：旧守卫只锁键集合+defaults，改 min/unit/integer 不红）
// 逐 key deepEqual {min,max,unit,integer}——范围/单位/整数约束任一位漂移必红。
// 说明文案（description）两侧允许措辞差异，不逐字比对（面板展示以 DTO 为准）。
test("夹具同源守卫：TEMPERATURE_DTO 的参数键集合 ≡ PARAM_SPECS（数量+逐 key），defaults ≡ DEFAULT_TEMPERATURE_PARAMS，specs 逐 key {min,max,unit,integer} ≡ PARAM_SPECS", () => {
  const srcKeys = Object.keys(PARAM_SPECS);
  assert.equal(TEMP_KEYS.length, srcKeys.length,
    `参数数量一致（DTO ${TEMP_KEYS.length} / PARAM_SPECS ${srcKeys.length}）——params.mjs 加了参数必须同步夹具`);
  assert.deepEqual([...TEMP_KEYS].sort(), [...srcKeys].sort(),
    "DTO specs 键集合与 PARAM_SPECS 逐 key 一致（双向无缺无多）");
  for (const key of TEMP_KEYS) {
    assert.ok(Object.hasOwn(PARAM_SPECS, key), `DTO 键 ${key} 在 PARAM_SPECS 中存在`);
    assert.ok(Object.hasOwn(DEFAULT_TEMPERATURE_PARAMS, key), `DTO 键 ${key} 在 DEFAULT_TEMPERATURE_PARAMS 中存在`);
    const dto = TEMPERATURE_DTO.specs[key];
    const src = PARAM_SPECS[key];
    assert.deepEqual(
      { min: dto.min, max: dto.max, unit: dto.unit, integer: dto.integer },
      { min: src.min, max: src.max, unit: src.unit, integer: src.integer },
      `DTO specs.${key} 与 PARAM_SPECS.${key} 的 {min,max,unit,integer} 逐值一致——改范围/单位/整数约束必须同步夹具（债 13 变异面）`);
  }
  assert.deepEqual({ ...TEMPERATURE_DTO.defaults }, { ...DEFAULT_TEMPERATURE_PARAMS },
    "DTO defaults 与 DEFAULT_TEMPERATURE_PARAMS 逐键逐值一致——改默认值必须同步夹具");
});

// 自洽夹具：base/candidate 的分级计数与 transitions 逐条对应（5 个专题），
// L1 净变化 = 迁入 cold/frozen 的 chars 之和 − 迁出 cold/frozen 的 chars 之和。
const PREVIEW_DTO = {
  base: { tiers: { active: 2, cool: 2, cold: 1, frozen: 0 } },
  candidate: { tiers: { active: 1, cool: 2, cold: 2, frozen: 0 } },
  transitions: [
    { key: "alpha", scopeId: "amber", from: "active", to: "cold", T_from: 60, T_to: 20, reason: "账本回放：read 0 / updated 1", chars: 20 },
    { key: "beta", scopeId: "amber", from: "active", to: "cool", T_from: 55, T_to: 24, reason: "账本回放：read 1 / updated 0", chars: 10 },
    { key: "gamma", scopeId: "amber", from: "cool", to: "cold", T_from: 24, T_to: 18, reason: "账本回放：read 2 / updated 0", chars: 15 },
    { key: "delta", scopeId: "amber", from: "cool", to: "active", T_from: 24, T_to: 70, reason: "账本回放：read 5 / updated 0", chars: 5 },
    { key: "epsilon", scopeId: "amber", from: "cold", to: "cool", T_from: 22, T_to: 30, reason: "账本回放：read 4 / updated 0", chars: 7 },
  ],
  l1DeltaChars: 28,
  alarms: [],
};

const FULL_BUDGETS = {
  core: { targetChars: 8000, hardCapChars: 10000, softChars: 7500, hardChars: 9000 },
  persona: { maxChars: 12000 },
  spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeScope(initialTemperature, order) {
  const state = {
    revision: 1,
    value: { budgets: clone(FULL_BUDGETS), temperature: clone(initialTemperature) },
    baseline: clone(initialTemperature),
    mutateCalls: [],
  };
  state.scope = {
    getSnapshot: () => ({ status: "ready", revision: state.revision, value: clone(state.value) }),
    mutate: async (ops) => {
      state.mutateCalls.push(clone(ops));
      order.push("mutate");
      for (const op of ops) {
        if (op.op === "set" && op.path[0] === "temperature") state.value.temperature = clone(op.value);
      }
      state.revision += 1;
      return true;
    },
  };
  return state;
}

function makeDsh({ scopeState, audit, order, recordBehavior, recordReceipt, refreshFailsAfterRecord, previewWarning } = {}) {
  const calls = [];
  const auditRef = audit ?? [];
  let recordAttempts = 0;
  let recordSucceeded = false;
  const dsh = {
    call: async (method, sessionId, payload) => {
      calls.push({ method, sessionId, payload });
      if (method === "getStatus") return { occupancy: { l1Chars: 32 } };
      if (method === "getTemperatureSettings") {
        if (refreshFailsAfterRecord === true && recordSucceeded) {
          throw new Error("读取最新状态失败：simulated");
        }
        return {
          current: clone(scopeState.value.temperature),
          defaults: clone(TEMPERATURE_DTO.defaults),
          specs: clone(TEMPERATURE_DTO.specs),
          crossChecks: clone(TEMPERATURE_DTO.crossChecks),
          hysteresis: TEMPERATURE_DTO.hysteresis,
          audit: clone(auditRef),
        };
      }
      if (method === "simulateTemperature") {
        const params = payload.params;
        if (typeof params.restoreThreshold !== "number" || typeof params.coolThreshold !== "number"
          || params.restoreThreshold < params.coolThreshold + TEMPERATURE_DTO.hysteresis) {
          const error = new Error("temperature 校验失败：restoreThreshold（" + String(params.restoreThreshold) + "）必须不小于 coolThreshold + " + String(TEMPERATURE_DTO.hysteresis) + "（" + String(Number(params.coolThreshold) + TEMPERATURE_DTO.hysteresis) + "），恢复/冷却两线须留回差");
          error.code = "INVALID_INPUT";
          throw error;
        }
        const preview = clone(PREVIEW_DTO);
        if (previewWarning !== undefined) preview.warning = previewWarning;
        return preview;
      }
      if (method === "recordTemperatureChange") {
        recordAttempts += 1;
        if (typeof recordReceipt === "function") {
          order.push("record");
          const receipt = recordReceipt(recordAttempts, payload);
          recordSucceeded = true;
          return receipt;
        }
        if (typeof recordBehavior === "function") {
          const outcome = recordBehavior(recordAttempts, payload);
          if (outcome instanceof Error) throw outcome;
          if (outcome && typeof outcome === "object") {
            order.push("record");
            recordSucceeded = true;
            return clone(outcome);
          }
        }
        const before = scopeState.baseline;
        const changes = [];
        for (const [key, to] of Object.entries(payload.params)) {
          if (Object.is(before[key], to) === false) changes.push({ key, from: before[key], to });
        }
        if (changes.length > 0) {
          auditRef.unshift({ at: "2026-11-22T00:00:00.000Z", scopeId: "amber", operationId: payload.operationId, changes: clone(changes) });
          scopeState.baseline = clone(payload.params);
        }
        order.push("record");
        recordSucceeded = true;
        return { recorded: changes.length > 0, replay: false, changes };
      }
      if (method === "executePlan" || method === "listCandidates") {
        order.push(method);
        return {};
      }
      return {};
    },
    configScope: () => scopeState.scope,
    listSessions: async () => [{ sessionId: "session-A" }],
  };
  return { dsh, calls, attempts: () => recordAttempts };
}

async function settle(panel, { rounds = 8, advanceMs = 0 } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    panel.rerender();
    await panel.flush();
    if (advanceMs > 0) await harness.timers.advance(advanceMs);
  }
}

async function mountBudgets(dsh) {
  const panel = await harness.mount({ tab: "budgets", dsh });
  await settle(panel);
  // 0.5 批次 13 · s2：温度参数移到「设置 → 温度」子页；挂载后先切子页。
  // 断言只增不减：原有用例的判据（表单/预览/审计…）逐条保留在下方。
  assert.ok(panel.find('[data-role="settings-seg"]'), "预算 tab 内渲染子页切换控件");
  assert.ok(panel.click('[data-role="settings-tab-temp"]'), "切换到「温度」子页");
  await settle(panel);
  assert.ok(panel.find('[data-role="settings-page-temp"]'), "温度子页容器出现");
  return panel;
}

function inputValue(panel, key) {
  const input = panel.find(`input[data-temp-input="${key}"]`);
  return input ? input.getAttribute("value") : null;
}

function auditEntries(panel) {
  return panel.findAll('[data-role="temperature-audit-entry"]');
}

test("热度参数面板：12 项表单（当前/默认/范围/单位/说明），审计初始为空", async () => {
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, []);
  const { dsh } = makeDsh({ scopeState });
  const panel = await mountBudgets(dsh);
  try {
    assert.ok(panel.find('[data-role="temperature-settings"]'), "出现「记忆整理」卡片");
    for (const key of TEMP_KEYS) {
      const value = inputValue(panel, key);
      assert.equal(value, String(TEMPERATURE_DTO.defaults[key]), key + " 当前值取宿主快照");
      const spec = TEMPERATURE_DTO.specs[key];
      const row = panel.textOf(`[data-temp-key="${key}"]`);
      assert.ok(row.includes("范围 " + spec.min + " ~ " + spec.max), key + " 范围来自 DTO specs");
      assert.ok(row.includes("（" + spec.unit + "）"), key + " 单位来自 DTO specs");
      assert.ok(row.includes(spec.description), key + " 说明来自 DTO specs");
      assert.ok(row.includes("默认 " + TEMPERATURE_DTO.defaults[key]), key + " 默认值来自 DTO defaults");
    }
    const text = panel.textOf('[data-role="temperature-settings"]');
    assert.ok(text.includes("记忆整理"), "分组标题");
    // 0.5-13-4：温度审计分组已迁到「最近变更」，设置页不再渲染。
    assert.equal(panel.find('[data-role="temperature-audit"]'), null, "设置页不再出现温度审计分组");
    assert.equal(panel.findAll('[data-role="temperature-audit-entry"]').length, 0, "设置页无审计条目");
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：改值 → 预览两张清单 + L1 净变化；保存顺序 mutate→record 且审计多一条", async () => {
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const audit = [{ at: "2026-11-01T00:00:00.000Z", scopeId: "amber", operationId: "old", changes: [{ key: "s0Days", from: 20, to: 30 }] }];
  const { dsh, calls } = makeDsh({ scopeState, audit, order });
  const panel = await mountBudgets(dsh);
  try {
    assert.equal(panel.find('[data-role="temperature-audit"]'), null, "设置页无审计分组（已迁最近变更）");
    assert.ok(panel.change('input[data-temp-input="coolThreshold"]', "30"), "改 coolThreshold=30");
    await settle(panel);

    assert.ok(panel.find('[data-role="temperature-preview"]'), "改动后出现预览区");
    // 夹具自洽性：每个 transition 的 from/to 计数必须与 base/candidate tiers 完全一致，
    // L1 净变化必须等于迁入 cold/frozen 的 chars 减迁出 cold/frozen 的 chars。
    const baseCounts = { active: 0, cool: 0, cold: 0, frozen: 0 };
    const candidateCounts = { active: 0, cool: 0, cold: 0, frozen: 0 };
    for (const transition of PREVIEW_DTO.transitions) {
      baseCounts[transition.from] += 1;
      candidateCounts[transition.to] += 1;
    }
    assert.deepEqual(baseCounts, PREVIEW_DTO.base.tiers, "transitions from 与 base tiers 逐级一致");
    assert.deepEqual(candidateCounts, PREVIEW_DTO.candidate.tiers, "transitions to 与 candidate tiers 逐级一致");
    const entering = PREVIEW_DTO.transitions.filter((t) => t.to === "cold" || t.to === "frozen").reduce((sum, t) => sum + t.chars, 0);
    const leaving = PREVIEW_DTO.transitions.filter((t) => t.from === "cold" || t.from === "frozen").reduce((sum, t) => sum + t.chars, 0);
    assert.equal(PREVIEW_DTO.l1DeltaChars, entering - leaving, "l1DeltaChars = 迁入 − 迁出");

    const previewText = panel.textOf('[data-role="temperature-preview"]');
    assert.ok(previewText.includes("active " + PREVIEW_DTO.candidate.tiers.active
      + " · cool " + PREVIEW_DTO.candidate.tiers.cool
      + " · cold " + PREVIEW_DTO.candidate.tiers.cold
      + " · frozen " + PREVIEW_DTO.candidate.tiers.frozen), "候选分级分布三项计数正确");
    const cooling = panel.textOf('[data-role="temperature-cooling"]');
    const restoring = panel.textOf('[data-role="temperature-restoring"]');
    assert.ok(cooling.includes("会冷却（3）") && cooling.includes("alpha") && cooling.includes("beta") && cooling.includes("gamma"), "会冷却清单含 alpha/beta/gamma");
    assert.ok(restoring.includes("会恢复（2）") && restoring.includes("delta") && restoring.includes("epsilon"), "会恢复清单含 delta/epsilon");
    assert.ok(cooling.includes("active → cold") && cooling.includes("字符 20") && cooling.includes("理由："), "每条含 from→to、字符影响与理由");
    assert.ok(panel.textOf('[data-role="temperature-l1-delta"]').includes("+" + PREVIEW_DTO.l1DeltaChars), "L1 字符净变化与夹具一致");

    assert.ok(panel.click('[data-role="temperature-save"]'), "保存按钮可点");
    await settle(panel, { advanceMs: 350 });

    assert.equal(scopeState.mutateCalls.length, 1, "先走 scope.mutate 且只一次");
    assert.deepEqual(order, ["mutate", "record"], "顺序：写入设置 → 记录审计");
    const recordCall = calls.find((call) => call.method === "recordTemperatureChange");
    assert.ok(recordCall, "后调 recordTemperatureChange");
    assert.equal(recordCall.payload.params.coolThreshold, 30, "审计参数=已写入的目标值");
    assert.equal(calls.filter((call) => call.method === "executePlan" || call.method === "listCandidates").length, 0,
      "保存当刻 executePlan/listCandidates 零调用");

    const saved = panel.textOf('[data-role="temperature-saved"]');
    assert.ok(saved.includes("已保存并记录审计（1 项变更）"), "recorded:true 提示条数取 changes.length");
    assert.equal(panel.findAll('[data-role="temperature-audit-entry"]').length, 0, "保存后设置页仍不渲染审计（条目在最近变更页）");
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：recorded:false（无变更、未新增审计）与 recorded:true 的提示分开", async () => {
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const audit = [];
  const { dsh } = makeDsh({
    scopeState,
    audit,
    order,
    recordBehavior: () => ({ recorded: false, replay: false, changes: [] }),
  });
  const panel = await mountBudgets(dsh);
  try {
    panel.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel);
    panel.click('[data-role="temperature-save"]');
    await settle(panel, { advanceMs: 350 });

    const saved = panel.textOf('[data-role="temperature-saved"]');
    assert.ok(saved.includes("未新增审计记录"), "recorded:false 明确说明未新增审计");
    assert.ok(saved.includes("参数已保存"), "仍如实提示参数已保存");
    assert.equal(saved.includes("已记录审计"), false, "recorded:false 不得出现「已记录审计」");
    assert.equal(saved.includes("项变更"), false, "recorded:false 不得套用变更条数文案");
    assert.equal(panel.find('[data-role="temperature-audit"]'), null, "设置页不渲染审计分组");
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：逐项恢复默认 + 恢复全部默认把 12 项复位", async () => {
  const order = [];
  const scopeState = makeScope({ ...TEMPERATURE_DTO.defaults, coolThreshold: 33, s0Days: 45 }, order);
  const { dsh } = makeDsh({ scopeState, order });
  const panel = await mountBudgets(dsh);
  try {
    assert.equal(inputValue(panel, "coolThreshold"), "33");
    assert.ok(panel.click('button[data-key="coolThreshold"]'), "逐项「默认」按钮存在");
    await settle(panel);
    assert.equal(inputValue(panel, "coolThreshold"), String(TEMPERATURE_DTO.defaults.coolThreshold), "逐项恢复为 DTO 默认值");

    panel.change('input[data-temp-input="s0Days"]', "60");
    await settle(panel);
    assert.equal(inputValue(panel, "s0Days"), "60");
    assert.ok(panel.click('[data-role="temperature-reset-all"]'), "存在「恢复全部默认」");
    await settle(panel);
    for (const key of TEMP_KEYS) {
      assert.equal(inputValue(panel, key), String(TEMPERATURE_DTO.defaults[key]), key + " 复位为 DTO 默认值");
    }
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：非法值当场红字（服务端 INVALID_INPUT 原文），保存禁用", async () => {
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const { dsh } = makeDsh({ scopeState, order });
  const panel = await mountBudgets(dsh);
  try {
    panel.change('input[data-temp-input="restoreThreshold"]', "30");
    await settle(panel);
    const invalid = panel.find('[data-role="temperature-invalid"]');
    assert.ok(invalid, "非法值出现红字");
    const invalidText = panel.textOf('[data-role="temperature-invalid"]');
    assert.ok(invalidText.includes("restoreThreshold"), "红字使用服务端 message（含键名）");
    assert.ok(invalidText.includes("coolThreshold + " + TEMPERATURE_DTO.hysteresis), "红字带交叉校验规则");
    const saveButton = panel.find('[data-role="temperature-save"]');
    assert.ok(saveButton && saveButton.getAttribute("disabled") === "true", "预览非法时保存按钮禁用");
    assert.equal(scopeState.mutateCalls.length, 0, "非法值不会写设置");
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：「尚未生效」INVALID_STATE 重试（≤3 次），最终成功只报一次成功", async () => {
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const audit = [];
  const { dsh, attempts } = makeDsh({
    scopeState,
    audit,
    order,
    recordBehavior: (attempt) => {
      if (attempt <= 2) {
        const error = new Error("设置尚未生效：服务端当前参数与提交值不一致");
        error.code = "INVALID_STATE";
        return error;
      }
      return null;
    },
  });
  const panel = await mountBudgets(dsh);
  try {
    panel.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel);
    panel.click('[data-role="temperature-save"]');
    await settle(panel, { advanceMs: 350 });
    assert.ok(panel.find('[data-role="temperature-saved"]'), "重试后成功并提示");
    assert.equal(attempts(), 3, "共尝试 3 次（2 次失败 + 1 次成功）");
    assert.equal(scopeState.mutateCalls.length, 1, "设置只写一次（重试只重发审计）");
    assert.equal(panel.find('[data-role="temperature-audit"]'), null, "设置页不渲染审计分组（入库由 RPC 断言）");
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：非「尚未生效」的 INVALID_STATE 不重试，原样展示服务端 message", async () => {
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const { dsh, attempts } = makeDsh({
    scopeState,
    order,
    recordBehavior: () => {
      const error = new Error("审计账本不可写：EACCES");
      error.code = "INVALID_STATE";
      return error;
    },
  });
  const panel = await mountBudgets(dsh);
  try {
    panel.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel);
    panel.click('[data-role="temperature-save"]');
    await settle(panel, { advanceMs: 350 });
    assert.equal(attempts(), 1, "审计 I/O 失败不重试");
    const errorText = panel.textOf('[data-role="temperature-save-error"]');
    assert.ok(errorText.includes("保存已写入，但审计失败：审计账本不可写：EACCES"), "原样展示服务端 message");
    assert.equal(errorText.includes("尚未把新参数交给插件"), false, "不得误归因宿主热提交");
    assert.equal(panel.find('[data-role="temperature-saved"]'), null, "失败不出现成功提示");
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：record 成功后刷新失败 → 如实提示「参数与审计已保存」，不反报审计失败", async () => {
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const audit = [];
  const { dsh } = makeDsh({ scopeState, audit, order, refreshFailsAfterRecord: true });
  const panel = await mountBudgets(dsh);
  try {
    panel.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel);
    panel.click('[data-role="temperature-save"]');
    await settle(panel, { advanceMs: 350 });

    assert.equal(audit.length, 1, "审计已在服务端落账（+1）");
    const errorText = panel.textOf('[data-role="temperature-save-error"]');
    assert.ok(errorText.includes("参数与审计已保存；读取最新状态失败，请重新打开本页"), "刷新失败文案如实区分");
    assert.equal(errorText.includes("审计失败"), false, "不得反报审计失败");
    assert.equal(errorText.includes("审计未落账"), false, "不得提示审计未落账");
    assert.equal(panel.find('[data-role="temperature-saved"]'), null, "刷新失败不显示旧的成功文案");
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：recorded:false 且刷新失败 → 文案按回执只说「参数已保存」，不出现「审计」字样", async () => {
  // 0.5-10（债 1④）：回执 recorded:false（未落审计）+ 刷新失败——旧行为无条件
  // 写「参数与审计已保存」，夸大事实；改后按 receipt.recorded 拼文案。
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const { dsh } = makeDsh({
    scopeState,
    order,
    recordBehavior: () => ({ recorded: false, replay: false, changes: [] }),
    refreshFailsAfterRecord: true,
  });
  const panel = await mountBudgets(dsh);
  try {
    panel.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel);
    panel.click('[data-role="temperature-save"]');
    await settle(panel, { advanceMs: 350 });

    const errorText = panel.textOf('[data-role="temperature-save-error"]');
    assert.ok(errorText.includes("参数已保存；读取最新状态失败，请重新打开本页"), "未落审计时只说「参数已保存」");
    assert.equal(errorText.includes("审计"), false, "不再出现「审计」字样（改坏实现必红：无条件旧文案含「审计」）");
    assert.equal(panel.find('[data-role="temperature-saved"]'), null, "刷新失败不显示成功文案");
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：机器可读 details.reason=parameters-not-effective 时即使文案不同也重试", async () => {
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const audit = [];
  const { dsh, attempts } = makeDsh({
    scopeState,
    audit,
    order,
    recordBehavior: (attempt) => {
      if (attempt <= 2) {
        const error = new Error("宿主参数尚未同步（自定义措辞，不含旧版关键字）");
        error.code = "INVALID_STATE";
        error.details = { reason: "parameters-not-effective" };
        return error;
      }
      return null;
    },
  });
  const panel = await mountBudgets(dsh);
  try {
    panel.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel);
    panel.click('[data-role="temperature-save"]');
    await settle(panel, { advanceMs: 350 });
    assert.equal(attempts(), 3, "按 details.reason 识别并重试到成功");
    assert.ok(panel.find('[data-role="temperature-saved"]'), "最终成功提示");
    assert.equal(panel.find('[data-role="temperature-audit"]'), null, "设置页不渲染审计分组（入库由 RPC 断言）");
  } finally {
    panel.unmount();
  }
});

test("热度参数面板：预览渲染服务端 warning（有 warning 可见，无 warning 不出空节点）", async () => {
  // 0.5-10（债 14e）：simulateTemperature 跳过坏 topic 文件时回执带 warning
  //（「已跳过 N 个无法读取的 topic 文件…」），预览块此前只渲染
  // tiers/cooling/restoring/l1DeltaChars，告警被吞——预览少算用户无从知晓。
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const { dsh } = makeDsh({
    scopeState,
    order,
    previewWarning: "已跳过 2 个无法读取的 topic 文件（损坏或越根链接），预览结果未计入它们",
  });
  const panel = await mountBudgets(dsh);
  try {
    panel.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel);
    assert.ok(panel.find('[data-role="temperature-preview-warning"]'), "有 warning 时预览块出现告警行");
    const warningText = panel.textOf('[data-role="temperature-preview-warning"]');
    assert.ok(warningText.includes("⚠"), "告警行带 ⚠ 前缀（与其余降级告警同款样式）");
    assert.ok(warningText.includes("已跳过 2 个无法读取的 topic 文件"), "告警行逐字渲染服务端 warning");
    assert.ok(panel.find('[data-role="temperature-preview"]'), "预览块照常在");
  } finally {
    panel.unmount();
  }

  // 无 warning：不渲染告警节点（不出空行）。
  const scopeState2 = makeScope(TEMPERATURE_DTO.defaults, []);
  const { dsh: dsh2 } = makeDsh({ scopeState: scopeState2, order: [] });
  const panel2 = await mountBudgets(dsh2);
  try {
    panel2.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel2);
    assert.equal(panel2.find('[data-role="temperature-preview-warning"]'), null, "无 warning 时不出告警节点");
    assert.ok(panel2.find('[data-role="temperature-preview"]'), "预览块照常在");
  } finally {
    panel2.unmount();
  }
});

test("热度参数面板：replay 回执提示重放且审计条数不变；receipt 缺失走无变更分支不抛错", async () => {
  const order = [];
  const scopeState = makeScope(TEMPERATURE_DTO.defaults, order);
  const audit = [];
  const { dsh } = makeDsh({
    scopeState,
    audit,
    order,
    recordReceipt: () => ({ recorded: false, replay: true, changes: [{ key: "coolThreshold", from: 25, to: 30 }] }),
  });
  const panel = await mountBudgets(dsh);
  try {
    panel.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel);
    panel.click('[data-role="temperature-save"]');
    await settle(panel, { advanceMs: 350 });
    const saved = panel.textOf('[data-role="temperature-saved"]');
    assert.ok(saved.includes("重放既有审计，未新增审计记录"), "replay 分支提示重放");
    assert.equal(saved.includes("已记录审计"), false, "replay 分支不得出现「已记录审计」");
    assert.equal(panel.find('[data-role="temperature-audit"]'), null, "设置页不渲染审计分组");
  } finally {
    panel.unmount();
  }

  const order2 = [];
  const scopeState2 = makeScope(TEMPERATURE_DTO.defaults, order2);
  const { dsh: dsh2 } = makeDsh({ scopeState: scopeState2, order: order2, recordReceipt: () => undefined });
  const panel2 = await mountBudgets(dsh2);
  try {
    panel2.change('input[data-temp-input="coolThreshold"]', "30");
    await settle(panel2);
    panel2.click('[data-role="temperature-save"]');
    await settle(panel2, { advanceMs: 350 });
    assert.ok(panel2.find('[data-role="temperature-saved"]'), "receipt 缺失仍有回执提示（不抛错）");
    assert.ok(panel2.textOf('[data-role="temperature-saved"]').includes("未新增审计记录"), "缺失回执走无变更分支");
  } finally {
    panel2.unmount();
  }
});

// ── 0.5-13-4：温度审计迁入「最近变更」，与整理执行记录合成一条按时间倒序的流 ──
test("最近变更：温度审计与整理执行记录合并成时间流（倒序）；只有 auto run 有「撤销这次」", async () => {
  const undoCalls = [];
  const audit = [{ at: "2026-11-20T08:00:00.000Z", operationId: "audit-1", changes: [{ key: "coolThreshold", from: 25, to: 30 }, { key: "s0Days", from: 30, to: 40 }] }];
  const runs = [{ runId: "auto-run-1", at: "2026-11-21T08:00:00.000Z", trigger: "manual", applied: 2, undoneAt: null }];
  const dsh = {
    call: async (method, sessionId, payload) => {
      if (method === "getStatus") return { mode: "active", configured: true, scope: "amber", personas: [], capabilities: { l2: true, organize: true, forgetting: true, tools: true, sections: true }, occupancy: { l0Chars: 0, l1Chars: 0, l0Budget: 12000, l1HardCap: 14000 }, diagnostics: {} };
      if (method === "getTimeline") return { scope: "amber", items: [], hasMore: false, skippedCorrupted: 0, scanLimited: false };
      if (method === "getTemperatureSettings") return { current: clone(TEMPERATURE_DTO.defaults), defaults: clone(TEMPERATURE_DTO.defaults), specs: clone(TEMPERATURE_DTO.specs), crossChecks: [], hysteresis: TEMPERATURE_DTO.hysteresis, audit: clone(audit) };
      if (method === "getAutoStatus") return { scope: "amber", enabled: true, mode: "suggest", lastRuns: clone(runs), fuse: { fused: false, reasons: [], statsValid: true }, params: {} };
      if (method === "undoAutoRun") { undoCalls.push(payload); return { ok: true }; }
      return {};
    },
  };
  const panel = await harness.mount({ tab: "timeline", dsh });
  await settle(panel);
  try {
    const stream = panel.find('[data-role="timeline-org-stream"]');
    assert.ok(stream, "合并流渲染在最近变更页");
    const rows = panel.findAll('[data-role="timeline-org-row"]');
    assert.equal(rows.length, 2, "审计 1 条 + 整理执行 1 条");
    const text = panel.textOfEl(stream);
    assert.ok(text.indexOf("整理执行") < text.indexOf("设置审计"), "按时间倒序：较新的整理执行在前");
    assert.ok(text.includes("冷却线：25 → 30（coolThreshold）") && text.includes("新主题半衰期（天）：30 → 40（s0Days）"),
      "审计用中文主名 + 符号名小字展示键级变更");
    assert.equal(rows.filter((el) => panel.textOfEl(el).includes("撤销这次")).length, 1, "只有 auto run 行有「撤销这次」");
    const undoBtn = panel.find('[data-role="timeline-org-undo"]');
    assert.ok(undoBtn, "撤销按钮存在");
    panel.click('[data-role="timeline-org-undo"]');
    await settle(panel);
    assert.deepEqual(undoCalls, [{ runId: "auto-run-1" }], "按既有 undoAutoRun 能力撤销该次");
    // 审计行没有撤销入口：它不在任何按钮行里。
    const auditRow = rows.find((el) => el.getAttribute("data-kind") === "audit");
    assert.ok(auditRow, "审计行存在");
    assert.equal(panel.findAll('[data-role="timeline-org-undo"]').length, 1, "审计行不带撤销按钮");
  } finally {
    panel.unmount();
  }
});
