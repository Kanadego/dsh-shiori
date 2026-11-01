// U3 状态页彩色水位 + 信息分层 测试。证据级别与 test/plugin/client.test.mjs 相同：
// 真实执行 client/index.js（fake window.__ModuleLoader__ + 有状态 react stub + 真实宿主
// zod 经绝对 file URL 导入），synthetic 渲染树，非浏览器实机。
// harness（makeStatefulReact / flattenVNode / collectText / mountStatusPanel /
// mountBudgetsTab 装配方式）照搬 client.test.mjs 现有写法，未改动该文件。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const NPM_GLOBAL = process.env.DSH_NPM_GLOBAL
  ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
const HOST_MODULES = process.env.DSH_HOST_MODULES ?? join(NPM_GLOBAL, "@deepseek-ai", "dsh", "node_modules");

const zod = await import(`file:///${HOST_MODULES}/zod/index.js`);

// ---------------------------------------------------------------------------
// 通用：装载 bundle（真实执行 ModuleLoader 注册 + factory）
// ---------------------------------------------------------------------------

const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
await import(pathToFileURL(join(WORKQ, "client", "index.js")).href);

function makeStatefulReact() {
  const states = [];
  const effects = [];
  const cursor = { v: 0 };
  const runEffects = { v: false };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: "fragment",
    useState: (initial) => {
      const i = cursor.v++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; }];
    },
    useEffect: (fn) => { if (runEffects.v) effects.push(fn); },
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  };
  return { react, states, effects, cursor, runEffects };
}

function flattenVNode(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) flattenVNode(child, out); return out; }
  if (!node || typeof node !== "object") return out;
  out.push(node);
  if (node.children) flattenVNode(node.children, out);
  return out;
}

function collectText(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out.join(""); }
  if (node === null || node === undefined || typeof node === "boolean") return out.join("");
  if (typeof node !== "object") { out.push(String(node)); return out.join(""); }
  if (node.children) collectText(node.children, out);
  return out.join("");
}

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// 与 client.test.mjs mountStatusPanel 同法：真实 ShioriSection → StatusTab。
async function mountStatusPanel(mod, host) {
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  // ShioriSection useState 顺序：tab / sessionId / manual / sessions / modeStatus。
  host.states.length = 0;
  host.states.push("status", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const statusTab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "StatusTab");
  assert.ok(statusTab, "StatusTab reached through real slot render");
  return (dsh, sessionId = "session-A") => {
    host.cursor.v = 0;
    return statusTab.type({ dsh, sessionId });
  };
}

// 真实 P 槽 DTO 形状（同 client.test.mjs realPStatusDto）
function realPStatusDto(occupancy) {
  return {
    mode: "active",
    configured: true,
    scope: "amber",
    occupancy: occupancy ?? { l0Chars: 12, l1Chars: 34, l0Budget: 12000, l1HardCap: 48000 },
    capabilities: { l2: true, organize: true, forgetting: true, tools: true, sections: true },
    diagnostics: { ownerId: "local", generation: 1, started: true },
  };
}

function renderStatusWithDto(host, renderStatus, dto) {
  host.states.length = 0;
  host.states.push(dto, null); // StatusTab: status / error
  host.runEffects.v = false;
  return renderStatus({ call: async () => ({}) });
}

// 状态页里 L0/L1 两条水位条（渲染顺序 L0 在前）
function statusBars(tree) {
  const bars = flattenVNode(tree).filter((n) => n.props && Object.prototype.hasOwnProperty.call(n.props, "data-dshi-bar"));
  assert.equal(bars.length, 2, "状态页渲染 L0/L1 两条水位条");
  return { l0: bars[0], l1: bars[1] };
}

// ---------------------------------------------------------------------------
// a) 三档阈值边界（具名常量 WATER_WARN_RATIO=0.7 / WATER_DANGER_RATIO=0.9）
// ---------------------------------------------------------------------------

test("U3 水位三档：阈值边界 0.699/0.7/0.899/0.9/1.0/溢出 → safe/warn/warn/danger/danger/danger", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);

  const cases = [
    { used: 6990, expected: "safe", fill: "dshi_barFillSafe" },
    { used: 7000, expected: "warn", fill: "dshi_barFillWarn" },
    { used: 8990, expected: "warn", fill: "dshi_barFillWarn" },
    { used: 9000, expected: "danger", fill: "dshi_barFillDanger" },
    { used: 10000, expected: "danger", fill: "dshi_barFillDanger" },
    { used: 12000, expected: "danger", fill: "dshi_barFillDanger" }, // 溢出截断到 100%
  ];
  for (const { used, expected, fill } of cases) {
    const dto = realPStatusDto({ l0Chars: used, l0Budget: 10000, l1Chars: 0, l1HardCap: 48000 });
    const tree = renderStatusWithDto(host, renderStatus, dto);
    const { l0 } = statusBars(tree);
    assert.equal(l0.props["data-dshi-bar"], expected,
      `ratio ${used}/10000 锚点应为 ${expected}`);
    const fillNode = flattenVNode(l0).find((n) => String(n.props.className).startsWith("dshi_barFill"));
    assert.ok(fillNode, "fill 节点存在");
    assert.equal(fillNode.props.className, "dshi_barFill " + fill, `ratio ${used}/10000 fill 类名`);
    assert.ok(String(fillNode.props.style.width).endsWith("%"), "宽度按百分比");
  }
});

test("U3 无障碍与可测锚点：role=progressbar + aria-valuenow/min/max + data-dshi-bar 在轨道上", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const dto = realPStatusDto({ l0Chars: 6000, l0Budget: 10000, l1Chars: 24000, l1HardCap: 48000 });
  const tree = renderStatusWithDto(host, renderStatus, dto);
  const { l0, l1 } = statusBars(tree);
  for (const [bar, used, limit] of [[l0, 6000, 10000], [l1, 24000, 48000]]) {
    assert.equal(bar.props.role, "progressbar", "role=progressbar");
    assert.equal(bar.props["aria-valuemin"], 0, "aria-valuemin=0");
    assert.equal(bar.props["aria-valuemax"], limit, "aria-valuemax=上限");
    assert.equal(bar.props["aria-valuenow"], used, "aria-valuenow=已用");
    assert.equal(typeof bar.props["aria-label"], "string", "aria-label 为条目名");
    assert.ok(["safe", "warn", "danger"].includes(bar.props["data-dshi-bar"]), "锚点值域");
  }
});

test("U3 旧可读文本保留：occupancyText 的 used / limit（百分比）与原 hint 不丢失", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const dto = realPStatusDto({ l0Chars: 6990, l0Budget: 10000, l1Chars: 24000, l1HardCap: 48000 });
  const tree = renderStatusWithDto(host, renderStatus, dto);
  const text = collectText(tree);
  assert.ok(text.includes("6990 / 10000 字符（69.9%）"), "occupancyText 百分比格式保留");
  assert.ok(text.includes("24000 / 48000 字符（50%）"), "L1 occupancyText 保留");
  assert.ok(text.includes("人设卡正文已用 / 上限"), "L0 原 hint 保留");
  assert.ok(text.includes("记忆核心正文已用 / 硬上限"), "L1 原 hint 保留");
  assert.ok(text.includes("6990 / 10000 UTF-16"), "Bar 自带的 UTF-16 刻度文本保留");
});

// ---------------------------------------------------------------------------
// d) 「技术细节」折叠区：默认收起；展开内容字段齐全；能力徽章保持现状
// ---------------------------------------------------------------------------

test("U3 折叠区默认收起，summary 与原始字段齐全；能力徽章不动", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const tree = renderStatusWithDto(host, renderStatus, realPStatusDto());

  const details = flattenVNode(tree).filter((n) => n.type === "details");
  assert.ok(details.length >= 2, "技术细节 + 完整 DTO 两个折叠区都在");
  for (const d of details) {
    assert.notEqual(d.props.open, true, "details 默认收起（无 open 属性）");
  }
  const summaries = flattenVNode(tree).filter((n) => n.type === "summary").map((n) => collectText(n));
  assert.ok(summaries.some((s) => s.includes("技术细节")), "技术细节 summary 在");
  assert.ok(summaries.some((s) => s.includes("完整 DTO")), "完整 DTO summary 在");

  // 展开后字段与值一个不少（mode / scope / diagnostics 三类原始字段）
  const text = collectText(tree);
  assert.ok(text.includes("mode: active"), "mode 字段");
  assert.ok(text.includes("scope: amber"), "scope 字段");
  assert.ok(text.includes('ownerId: "local"'), "diagnostics.ownerId");
  assert.ok(text.includes("generation: 1"), "diagnostics.generation");
  assert.ok(text.includes("started: true"), "diagnostics.started");

  // 能力徽章保持现状（渲染与文案不动）
  assert.ok(text.includes("已启用的能力"), "能力卡标题在");
  assert.ok(text.includes("Spark 二级记忆：已开启"), "l2 徽章文案不变");
  assert.ok(text.includes("遗忘归档：已开启"), "forgetting 徽章文案不变");
});

// ---------------------------------------------------------------------------
// c) 同一档颜色按 token 判：状态页三档类名 ↔ 预算页预览条内联 token 一一对应
// ---------------------------------------------------------------------------

const FULL_BUDGETS = {
  core: { targetChars: 8000, hardCapChars: 10000, softRatio: 0.75, hardRatio: 0.9, cacheLockFallback: false },
  persona: { maxChars: 12000 },
  spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 },
};

// 与 client.test.mjs mountBudgetsTab 同法（裁剪到本测试需要的部分）。
async function mountBudgetsTabForPreview(host) {
  const state = { revision: 3, written: structuredClone(FULL_BUDGETS) };
  const scope = {
    getSnapshot: () => ({ status: "ready", revision: state.revision, value: { budgets: structuredClone(state.written) } }),
    mutate: () => Promise.resolve(true),
  };
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
    configForms: { get: (ns) => (ns === "shiori" ? scope : undefined) },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push("budgets", "session-A", "", null, undefined);
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const tab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "BudgetsTab");
  assert.ok(tab, "BudgetsTab reached through real slot render");
  return (occupancy) => {
    // BudgetsTab useState 顺序：snapshot / error / ok / draftEdits / occupancy。
    host.states.length = 0;
    host.cursor.v = 0;
    host.states.push(scope.getSnapshot(), null, null, undefined, occupancy);
    host.cursor.v = 0;
    return tab.type(tab.props);
  };
}

function budgetPreviewFill(tree) {
  const fill = flattenVNode(tree).find((n) => n.props && String(n.props.className).includes("dshi_trackFill"));
  assert.ok(fill, "预算页预览条 fill 渲染（occupancy.chars 可用时）");
  return fill;
}

test("U3 同一档颜色（token 判）：CSS 三档类名 ↔ 预算页预览条内联 token 一一对应，状态页运行时档位一致", async () => {
  // 1) shiori.css：三档类名只引用 --dshi-safe/warn/danger token，不写裸 hex。
  const css = readFileSync(join(WORKQ, "client", "shiori.css"), "utf8").replace(/\s+/g, "");
  const tierTokens = { safe: "var(--dshi-safe)", warn: "var(--dshi-warn)", danger: "var(--dshi-danger)" };
  for (const [tier, token] of Object.entries(tierTokens)) {
    assert.ok(css.includes(`.dshi_barFill${tier[0].toUpperCase()}${tier.slice(1)}{background:${token}}`),
      `.dshi_barFill${tier} → ${token}`);
  }

  // 2) 状态页：同档位运行时锚点/类名（Bar 三档）。
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const statusTierByRatio = [
    { used: 5000, tier: "safe" },
    { used: 7500, tier: "warn" },
    { used: 9500, tier: "danger" },
  ];
  for (const { used, tier } of statusTierByRatio) {
    const tree = renderStatusWithDto(host, renderStatus,
      realPStatusDto({ l0Chars: used, l0Budget: 10000, l1Chars: 0, l1HardCap: 48000 }));
    const { l0 } = statusBars(tree);
    assert.equal(l0.props["data-dshi-bar"], tier, `状态页 ratio ${used / 10000} → ${tier}`);
  }

  // 3) 预算页预览条（budgetPreviewBar，软水位/硬闸分档，未被重构）：
  //    同档位内联颜色 token 与状态页类名映射的 token 相同。
  const renderBudgets = await mountBudgetsTabForPreview(host);
  const budgetCases = [
    { chars: 3000, tier: "safe" },   // < 软水位 7500
    { chars: 8000, tier: "warn" },   // ≥ 软水位 7500，< 硬闸 9000
    { chars: 9500, tier: "danger" }, // ≥ 硬闸 9000
  ];
  for (const { chars, tier } of budgetCases) {
    const tree = renderBudgets({ chars });
    const fill = budgetPreviewFill(tree);
    assert.equal(fill.props.style.background, tierTokens[tier],
      `预算页预览条 ${tier} 档内联 token 与状态页 .dshi_barFill${tier} 相同`);
  }
});
