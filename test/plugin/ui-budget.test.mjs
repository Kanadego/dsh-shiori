// 0.5 批次 13 · s2：设置页四子页（预算 / 温度 / 闪回卡片 / 向量召回）测试。
//
// 证据级别与 ui-temperature / ui-shell 一致：真实执行 client/index.js（harness 的
// fake window.__ModuleLoader__ + 有状态 react stub + 真实宿主 zod），mount() 走真实
// 重渲染循环（state 变更 → 重新执行组件函数 → DOM 更新）。SYNTHETIC，非浏览器实机。
//
// 覆盖任务书验收：
// - 四子页都能点开并渲染至少一个可见 data-role；默认预算页；未知 id 回落预算页
//   （上一版预览在这里出过「点某页空白」白屏 bug）；
// - 预算子页：L0「不计入水位」说明、四色占用条（绿=已用 / 橙=软水位 / 红=硬阀 /
//   灰=硬顶）与派生值断言；
// - 滑条夹紧 / 联动用派生值断言（期望值由夹具 + 规则算出，不抄字面量）；
// - 闪回卡片子页：5 个 budgets.spark 字段 + persona.maxChars 全部接线，与预算
//   子页共用同一份草稿；后端没有的字段只留「待后端提供」灰字；
// - 温度子页：12 项中文主名 + 符号名小字；
// - ErrorBox 两行口径不变：已知码人话在前 + 原文次要行；未知码只出原文。

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const FULL_BUDGETS = {
  core: { targetChars: 8000, hardCapChars: 10000, softChars: 7500, hardChars: 9000 },
  persona: { maxChars: 12000 },
  spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 },
};

const SPARK_FIELDS = ["maxChars", "inlineMaxChars", "maxCards", "seedCount", "linkCount"];
const SETTINGS_PAGES = ["budget", "temp", "spark", "recall"];

// 温度 12 项的中文主名（任务书对照表；测试内独立一份，面板改名必须同步这里）。
const TEMPERATURE_LABELS = {
  s0Days: "新主题半衰期（天）",
  sMaxDays: "半衰期上限（天）",
  consolidateGain: "巩固增益",
  readAlpha: "读取加热系数",
  updatedFloor: "改动后保底温度",
  readDedupHours: "去重窗口（小时）",
  coolThreshold: "冷却线",
  restoreThreshold: "恢复线",
  minCooldownDays: "最短冷却天数",
  minRestoreGraceDays: "恢复后保护期（天）",
  maxOpsPerRun: "每轮最多执行（条）",
  evaluateEveryHours: "评估周期（小时）",
};

// 真实占用（字符数）；占用条宽度 / 标记位置一律由它和草稿值派生。
const OCCUPANCY_CHARS = 2000;

const SEMANTIC_DTO = {
  enabled: true,
  provider: "local",
  model: "Xenova/bge-small-zh-v1.5",
  ready: false,
  modelInstalled: false,
  modelDir: "/data/models",
  vectors: 0,
  rebuild: { running: false, phase: "idle", done: 0, total: 0, error: null },
  download: { running: false, phase: "idle" },
};

function makeScope({ mutateReject } = {}) {
  const state = {
    revision: 1,
    value: {
      budgets: clone(FULL_BUDGETS),
      temperature: clone(DEFAULT_TEMPERATURE_PARAMS),
    },
    mutateCalls: [],
  };
  const scope = {
    getSnapshot: () => ({ status: "ready", revision: state.revision, value: clone(state.value) }),
    mutate: async (ops, revision) => {
      state.mutateCalls.push({ ops: clone(ops), revision });
      if (mutateReject) throw mutateReject;
      for (const op of ops) {
        if (op.op === "set" && op.path[0] === "budgets") state.value.budgets = clone(op.value);
      }
      state.revision += 1;
      return true;
    },
  };
  return { state, scope };
}

function makeDsh({ scope } = {}) {
  const calls = [];
  const dsh = {
    call: async (method, sessionId, payload) => {
      calls.push({ method, sessionId, payload });
      if (method === "getStatus") {
        return {
          occupancy: { l1Chars: OCCUPANCY_CHARS, l1HardCap: FULL_BUDGETS.core.hardCapChars },
          diagnostics: { semantic: clone(SEMANTIC_DTO) },
        };
      }
      if (method === "getTemperatureSettings") {
        return {
          current: clone(DEFAULT_TEMPERATURE_PARAMS),
          defaults: clone(DEFAULT_TEMPERATURE_PARAMS),
          specs: clone(PARAM_SPECS),
          crossChecks: [],
          hysteresis: 10,
          audit: [],
        };
      }
      if (method === "executeTool") return {};
      return {};
    },
    configScope: () => scope,
    listSessions: async () => [{ sessionId: "session-A" }],
  };
  return { dsh, calls };
}

async function settle(panel, { rounds = 8 } = {}) {
  for (let i = 0; i < rounds; i += 1) {
    panel.rerender();
    await panel.flush();
  }
}

async function mountSettings(dsh) {
  const panel = await harness.mount({ tab: "budgets", dsh });
  await settle(panel);
  return panel;
}

async function openPage(panel, id) {
  assert.ok(panel.click(`[data-role="settings-tab-${id}"]`), "点击子页按钮：" + id);
  await settle(panel);
}

// data-path 里带点（core.softChars），harness 的简化选择器会把点误当 class——
// 统一按属性精确扫描，不拼选择器字符串。
function findInput(panel, path) {
  return panel.findAll("input").find((el) => el.getAttribute("data-path") === path) || null;
}

function inputValue(panel, path) {
  const input = findInput(panel, path);
  return input ? input.getAttribute("value") : null;
}

function changeInput(panel, path, value) {
  const input = findInput(panel, path);
  assert.ok(input, "input rendered for " + path);
  assert.equal(typeof input.onchange, "function", "input has onChange: " + path);
  input.onchange({ target: { value } });
}

// ---------------------------------------------------------------------------
// 子页骨架
// ---------------------------------------------------------------------------

test("子页切换：四按钮 + 默认预算页；每页至少一个可见 data-role；未知 id 回落预算页", async () => {
  const { scope } = makeScope();
  const { dsh } = makeDsh({ scope });
  const panel = await mountSettings(dsh);
  try {
    assert.ok(panel.find('[data-role="settings-seg"]'), "子页切换容器 settings-seg 渲染");
    for (const id of SETTINGS_PAGES) {
      assert.ok(panel.find(`[data-role="settings-tab-${id}"]`), "子页按钮存在：" + id);
    }
    // 默认预算页：只有预算页容器可见。
    const budgetTab = panel.find('[data-role="settings-tab-budget"]');
    assert.equal(budgetTab.getAttribute("aria-pressed"), "true", "默认高亮预算子页");
    assert.ok(panel.find('[data-role="settings-page-budget"]'), "默认渲染预算页");
    for (const id of SETTINGS_PAGES.filter((page) => page !== "budget")) {
      assert.equal(panel.find(`[data-role="settings-page-${id}"]`), null, "非当前页不渲染：" + id);
    }
    // 每页一个可见 data-role（预算页：占用条）。
    assert.ok(panel.find('[data-role="budget-occupancy"]'), "预算页可见 data-role=budget-occupancy");

    // 温度子页：温度卡片。
    await openPage(panel, "temp");
    assert.ok(panel.find('[data-role="settings-page-temp"]'), "温度页容器");
    assert.ok(panel.find('[data-role="temperature-settings"]'), "温度页可见 data-role=temperature-settings");

    // 闪回卡片子页：说明卡。
    await openPage(panel, "spark");
    assert.ok(panel.find('[data-role="settings-page-spark"]'), "闪回卡片页容器");
    assert.ok(panel.find('[data-role="settings-spark"]'), "闪回卡片页可见 data-role=settings-spark");

    // 向量召回子页：语义召回卡 + 两个按钮。
    await openPage(panel, "recall");
    assert.ok(panel.find('[data-role="settings-page-recall"]'), "向量召回页容器");
    assert.ok(panel.find('[data-role="semantic-recall"]'), "向量召回页可见 data-role=semantic-recall");
    assert.ok(panel.findAll("button").some((el) => panel.textOfEl(el) === "重建向量"), "重建向量按钮在场");
    assert.ok(panel.find('[data-role="settings-page-budget"]') === null, "切走后预算页不再渲染");

    // 回预算页。
    await openPage(panel, "budget");
    assert.ok(panel.find('[data-role="settings-page-budget"]'), "可切回预算页");

    // 未知 id 回落预算页：直接篡改组件本地 state（不靠 UI 能点到不存在的页）。
    await openPage(panel, "temp");
    const stateIndex = panel.host.states.indexOf("temp");
    assert.ok(stateIndex >= 0, "子页状态存组件本地 state");
    panel.host.states[stateIndex] = "no-such-subpage";
    panel.rerender();
    await panel.flush();
    assert.ok(panel.find('[data-role="settings-page-budget"]'), "未知 id → 回落预算页（不白屏）");
    assert.equal(panel.find('[data-role="settings-page-temp"]'), null, "未知 id 不残留其它页");
    assert.ok(panel.find('[data-role="settings-seg"]'), "回落时切换控件仍在");
  } finally {
    panel.unmount();
  }
});

// ---------------------------------------------------------------------------
// 预算子页
// ---------------------------------------------------------------------------

test("预算子页：四色占用条（绿已用/橙软/红硬/灰硬顶）+ L0「不计入水位」；位置由占用与草稿派生", async () => {
  const { scope } = makeScope();
  const { dsh } = makeDsh({ scope });
  const panel = await mountSettings(dsh);
  try {
    const page = panel.find('[data-role="settings-page-budget"]');
    assert.ok(page, "预算页渲染");
    const text = panel.textOf('[data-role="settings-page-budget"]');
    assert.ok(text.includes("不计入水位"), "L0 人设卡注明不计入水位");
    assert.ok(panel.find('[data-role="persona-max-note"]'), "L0 说明有 data-role");

    const cap = FULL_BUDGETS.core.hardCapChars;
    const soft = FULL_BUDGETS.core.softChars;
    const hard = FULL_BUDGETS.core.hardChars;
    const pct = (value) => (value / cap) * 100 + "%";

    const fill = panel.find('[data-role="budget-occupancy-fill"]');
    assert.ok(fill, "已用填充段渲染");
    assert.equal(fill.style.width, pct(OCCUPANCY_CHARS), "已用宽度 = 占用/硬顶（派生）");
    assert.equal(fill.style.background, "var(--dshi-safe)", "未过软水位 → 绿色 token");

    const softMark = panel.find('[data-role="budget-occupancy-soft"]');
    assert.equal(softMark.style.left, pct(soft), "软水位刻度位置派生自 softChars");
    assert.ok(softMark.style.background.includes("--dshi-warn"), "软水位 = 橙色 token");
    assert.equal(softMark.getAttribute("title"), "软水位 " + soft + " 字符");

    const hardMark = panel.find('[data-role="budget-occupancy-hard"]');
    assert.equal(hardMark.style.left, pct(hard), "硬阀刻度位置派生自 hardChars");
    assert.ok(hardMark.style.background.includes("--dshi-danger"), "硬阀 = 红色 token");

    const capMark = panel.find('[data-role="budget-occupancy-cap"]');
    assert.ok(capMark, "硬顶刻度渲染");
    assert.equal(Number(capMark.style.right), 0, "硬顶刻度贴右端（100%）");
    assert.ok(capMark.style.background.includes("--dshi-text-dim"), "硬顶 = 灰色 token");
  } finally {
    panel.unmount();
  }
});

test("预算子页滑条：改硬顶后两滑条按夹紧规则联动（派生值断言，不写字面量）", async () => {
  const { scope } = makeScope();
  const { dsh } = makeDsh({ scope });
  const panel = await mountSettings(dsh);
  try {
    const sliders = panel.findAll('input[type="range"]');
    assert.equal(sliders.length, 2, "两条真滑条（软水位 / 硬阀）");
    assert.equal(findInput(panel, "core.softChars").getAttribute("min"), "1",
      "软水位滑条下限固定为 1（服务端要求 ≥1 字符）");

    // 改硬顶：硬阀被夹到「硬顶 - 1」，软水位被夹到「硬阀 - 1」。
    const newCap = Math.floor(FULL_BUDGETS.core.hardCapChars / 2);
    changeInput(panel, "core.hardCapChars", String(newCap));
    await settle(panel);
    const expectedHard = Math.min(FULL_BUDGETS.core.hardChars, newCap - 1);
    const expectedSoft = Math.min(FULL_BUDGETS.core.softChars, expectedHard - 1);

    assert.equal(inputValue(panel, "core.hardChars"), String(expectedHard), "硬阀滑条值 = min(原值, 硬顶-1)");
    assert.equal(inputValue(panel, "core.hardChars.num"), String(expectedHard), "硬阀数字框与滑条同源");
    assert.equal(findInput(panel, "core.hardChars").getAttribute("max"), String(newCap - 1),
      "硬阀滑条上限 = 硬顶 - 1");
    assert.equal(inputValue(panel, "core.softChars"), String(expectedSoft), "软水位 = min(原值, 硬阀-1)");
    assert.equal(inputValue(panel, "core.softChars.num"), String(expectedSoft), "软水位数字框与滑条同源");
    assert.equal(findInput(panel, "core.softChars").getAttribute("max"), String(expectedHard - 1),
      "软水位滑条上限 = 硬阀 - 1");

    // 百分比只显示、不落盘、不参与校验：由当前字符数 ÷ 硬顶现算（派生断言）。
    const pctOf = (chars, capValue) => (Math.round((chars / capValue) * 1000) / 10) + "%";
    assert.ok(panel.textOf('[data-role="water-percent-softChars"]').includes(pctOf(expectedSoft, newCap)),
      "软水位旁显示「字符数 + 占硬顶百分比」（派生自 softChars/hardCapChars）");
    assert.ok(panel.textOf('[data-role="water-percent-hardChars"]').includes(pctOf(expectedHard, newCap)),
      "硬阀旁显示「字符数 + 占硬顶百分比」（派生自 hardChars/hardCapChars）");

    // 反向联动：把硬阀再压低 → 软水位跟着压到「硬阀 - 1」。
    const lowerHard = Math.max(2, Math.floor(expectedHard / 2));
    changeInput(panel, "core.hardChars.num", String(lowerHard));
    await settle(panel);
    const expectedSoft2 = Math.min(expectedSoft, lowerHard - 1);
    assert.equal(inputValue(panel, "core.softChars"), String(expectedSoft2), "硬阀下调后软水位被夹到硬阀-1（派生）");
    assert.equal(findInput(panel, "core.softChars").getAttribute("max"), String(lowerHard - 1),
      "软水位滑条上限随硬阀同步");
  } finally {
    panel.unmount();
  }
});

test("ErrorBox 两行口径不变：已知码人话在前 + 原文次要行；未知码只出原文", async () => {
  // 已知码：INVALID_INPUT → 人话主行 + 原文弱化行。
  const known = makeScope({
    mutateReject: Object.assign(new Error("core.hardCapChars must be positive"), { code: "INVALID_INPUT" }),
  });
  const knownDsh = makeDsh({ scope: known.scope });
  const panel = await mountSettings(knownDsh.dsh);
  try {
    const form = panel.find("form");
    assert.ok(form && typeof form.onsubmit === "function", "预算保存表单可提交");
    form.onsubmit({ preventDefault() {} });
    await settle(panel);
    const boxes = panel.findAll(".dshi_error").filter((el) => panel.textOfEl(el).includes("输入参数被拒绝"));
    assert.equal(boxes.length, 1, "已知码出现人话主行");
    const boxText = panel.textOfEl(boxes[0]);
    assert.ok(boxText.startsWith("输入参数被拒绝"), "人话在前");
    assert.ok(boxText.includes("[INVALID_INPUT] core.hardCapChars must be positive"), "原文行保留 code + message");
    // 原文行是字号 11px 的次要行：在盒子子树里找带 [code] 的小字节点。
    const rawNode = (function findRaw(node) {
      if (!node || node.nodeType !== 1) return null;
      if (node.style && node.style.fontSize === "11px"
        && panel.textOfEl(node).includes("[INVALID_INPUT]")) return node;
      for (const kid of node.children) {
        const hit = findRaw(kid);
        if (hit) return hit;
      }
      return null;
    })(boxes[0]);
    assert.ok(rawNode, "原文以次要样式（11px）单独成行");
  } finally {
    panel.unmount();
  }

  // 未知码：只出原文，不加人话前缀。
  const unknown = makeScope({
    mutateReject: Object.assign(new Error("boom"), { code: "shiori/denied" }),
  });
  const unknownDsh = makeDsh({ scope: unknown.scope });
  const panel2 = await mountSettings(unknownDsh.dsh);
  try {
    const form2 = panel2.find("form");
    form2.onsubmit({ preventDefault() {} });
    await settle(panel2);
    const boxes = panel2.findAll(".dshi_error").filter((el) => panel2.textOfEl(el).includes("[shiori/denied]"));
    assert.equal(boxes.length, 1, "未知码原文照出");
    const boxText = panel2.textOfEl(boxes[0]);
    assert.equal(boxText, "[shiori/denied] boom", "未知码只出原文（不加前缀、不加人话）");
  } finally {
    panel2.unmount();
  }
});

// ---------------------------------------------------------------------------
// 闪回卡片子页
// ---------------------------------------------------------------------------

test("闪回卡片子页：5 个 budgets.spark 字段 + persona.maxChars 全接线（共用草稿），后端没有的只写「待后端提供」", async () => {
  const { scope } = makeScope();
  const { dsh } = makeDsh({ scope });
  const panel = await mountSettings(dsh);
  try {
    await openPage(panel, "spark");
    assert.ok(panel.find('[data-role="settings-page-spark"]'), "闪回卡片页渲染");
    for (const key of SPARK_FIELDS) {
      assert.equal(inputValue(panel, "spark." + key), String(FULL_BUDGETS.spark[key]),
        "接线 budgets.spark." + key);
    }
    assert.equal(inputValue(panel, "persona.maxChars"), String(FULL_BUDGETS.persona.maxChars),
      "接线 budgets.persona.maxChars");
    assert.ok(panel.find('[data-role="spark-persona-note"]'), "人设卡注明属 L0 / 不计入水位");
    const text = panel.textOf('[data-role="settings-page-spark"]');
    assert.ok(text.includes("种子数 + 关联数不得超过单次最多卡片数"), "seedCount/linkCount 与 maxCards 的关系有说明");
    const pending = panel.textOf('[data-role="spark-pending-backend"]');
    assert.ok(pending.includes("待后端提供"), "后端没有的字段（回看天数）只写待后端提供");

    // 同一份草稿（评审补例）：闪回页改 maxCards → 切回预算子页同字段数值一致。
    const nextMaxCards = FULL_BUDGETS.spark.maxCards - 1;
    changeInput(panel, "spark.maxCards", String(nextMaxCards));
    await settle(panel);
    await openPage(panel, "budget");
    assert.equal(inputValue(panel, "spark.maxCards"), String(nextMaxCards), "跨子页共用同一份草稿");
  } finally {
    panel.unmount();
  }
});

// ---------------------------------------------------------------------------
// 温度子页
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 评审补例：语义召回块同一时刻只在 DOM 一处（防两份同时轮询 / 两个重建按钮）
// ---------------------------------------------------------------------------

function countRole(panel, role) {
  return panel.findAll(`[data-role="${role}"]`).length;
}

function descendantsOf(el, predicate) {
  const out = [];
  (function walk(node) {
    for (const child of node.children || []) {
      if (predicate(child)) out.push(child);
      walk(child);
    }
  })(el);
  return out;
}

function clickSectionTab(panel, label) {
  const tab = panel.findAll("button").find((el) => panel.textOfEl(el) === label);
  assert.ok(tab, "页签按钮存在：" + label);
  tab.onclick();
}

test("语义召回块：状态页与设置页向量召回子页同一时刻只有一份在 DOM；渲染走同一受控实现", async () => {
  const { scope } = makeScope();
  const { dsh } = makeDsh({ scope });
  // 直接挂在状态页（默认 tab=status）。
  const panel = await harness.mount({ tab: "status", dsh });
  await settle(panel);
  try {
    assert.equal(countRole(panel, "semantic-recall"), 1, "状态页有一份语义召回卡");
    assert.equal(panel.find('[data-role="settings-page-recall"]'), null, "状态页没有设置页容器");

    clickSectionTab(panel, "记忆预算");
    await settle(panel);
    assert.equal(panel.find('[data-role="settings-page-recall"]'), null, "预算 tab 默认子页不是向量召回");
    assert.equal(countRole(panel, "semantic-recall"), 0, "切到设置页后状态页那份语义块不在 DOM");

    await openPage(panel, "recall");
    assert.equal(countRole(panel, "semantic-recall"), 1, "向量召回子页有且只有一份");
    const page = panel.find('[data-role="settings-page-recall"]');
    const inside = descendantsOf(page, (el) => el.nodeType === 1 && el.getAttribute("data-role") === "semantic-recall");
    assert.equal(inside.length, 1, "设置页那份在 settings-page-recall 容器内");
    const rebuildButtons = panel.findAll("button").filter((el) => panel.textOfEl(el) === "重建向量");
    assert.equal(rebuildButtons.length, 1, "同一时刻只有一个「重建向量」可点");

    clickSectionTab(panel, "状态");
    await settle(panel);
    assert.equal(panel.find('[data-role="settings-page-recall"]'), null, "切回状态页后设置页容器不在 DOM");
    assert.equal(countRole(panel, "semantic-recall"), 1, "状态页那份回来，且仍只有一份");
  } finally {
    panel.unmount();
  }
});

test("温度子页：12 项中文主名 + 符号名小字（symbol 仍可见，单位取服务端 DTO）", async () => {
  const { scope } = makeScope();
  const { dsh } = makeDsh({ scope });
  const panel = await mountSettings(dsh);
  try {
    await openPage(panel, "temp");
    const keys = Object.keys(PARAM_SPECS);
    assert.equal(keys.length, Object.keys(TEMPERATURE_LABELS).length, "中文名表覆盖 12 项");
    for (const key of keys) {
      const row = panel.find(`[data-temp-key="${key}"]`);
      assert.ok(row, "温度参数行：" + key);
      const rowText = panel.textOfEl(row);
      assert.ok(rowText.includes(TEMPERATURE_LABELS[key]), key + " 中文主名：" + TEMPERATURE_LABELS[key]);
      assert.ok(rowText.includes(key), key + " 符号名仍可见（缩成小字）");
      const unit = PARAM_SPECS[key].unit;
      if (unit) assert.ok(rowText.includes("（" + unit + "）"), key + " 单位来自 DTO");
      const sym = panel.findAll("span").find((el) => panel.textOfEl(el).includes(key) && el.style && el.style.fontSize === "11px");
      assert.ok(sym, key + " 符号名以小字（11px）展示");
    }
  } finally {
    panel.unmount();
  }
});
