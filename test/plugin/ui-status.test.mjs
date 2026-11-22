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
  assert.ok(text.includes("闪回二级记忆：已开启"), "l2 徽章文案（0.5-13-4 按产品名改名）");
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

// ---------------------------------------------------------------------------
// S2 侧边栏独立入口：详情页 plugins.bundle.config 入口保留不回归，与 main /
// sidebar.panellist 两个新槽位并存（槽位写法对齐 dsh-email workbench 模板）。
// ---------------------------------------------------------------------------

test("S2 入口并存：详情页槽位仍走窄卡片根渲染 StatusTab，main 槽位根切全屏 scope class，侧边栏图标出「记忆」入口", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const calls = [];
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { calls.push({ meta, render }); return () => {}; },
    },
  });
  assert.deepEqual(
    calls.map((c) => c.meta.name),
    ["conversation.chat.assistant-actions", "main", "sidebar.panellist", "plugins.bundle.config"],
    "详情页槽位与三个增强槽位并存，bundle.config 仍是最后一次注册",
  );

  // 详情页入口不回归：bundle.config 渲染的根仍是窄卡片（860px 默认布局），
  // 且 StatusTab 经真实槽位渲染可达（沿用本文件 mountStatusPanel 的取法）。
  const detail = calls[calls.length - 1];
  const detailVNode = detail.render({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push("status", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const detailTree = detailVNode.type(detailVNode.props);
  assert.equal(detailTree.props.className, "dshi_root", "详情页根仍是窄卡片布局（无全屏 scope class）");
  assert.ok(
    flattenVNode(detailTree).some((n) => typeof n.type === "function" && n.type.name === "StatusTab"),
    "详情页 StatusTab 仍可达",
  );

  // main 槽位：inject 带 workbench:true，根容器切全屏 scope class（同一 PanelView 复用）。
  const main = calls.find((c) => c.meta.name === "main");
  assert.equal(main.meta.key, "shiori", "main 槽位 key=shiori");
  assert.deepEqual(main.meta.inject(), { workbench: true }, "main 槽位 inject 带 workbench:true");
  const mainVNode = main.render({ workbench: true });
  host.states.length = 0;
  host.states.push("status", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const mainTree = mainVNode.type(mainVNode.props);
  assert.equal(mainTree.props.className, "dshi_root dshi_rootMain", "main 槽位根挂全屏 scope class");
  assert.equal(mainTree.props["data-main"], "true", "main 槽位根标 data-main=true");
  assert.ok(
    flattenVNode(mainTree).some((n) => typeof n.type === "function" && n.type.name === "StatusTab"),
    "main 槽位复用同一 PanelView（StatusTab 经 main 槽位同样可达）",
  );

  // sidebar.panellist：出「记忆」图标入口。
  const sidebar = calls.find((c) => c.meta.name === "sidebar.panellist");
  assert.equal(sidebar.meta.id, "shiori", "sidebar.panellist id=shiori");
  assert.equal(sidebar.meta.order, 60, "sidebar.panellist order=60");
  assert.equal(sidebar.meta.label, "记忆", "sidebar.panellist label=记忆");
  const iconVNode = sidebar.render({ size: 18 });
  const icon = iconVNode.type(iconVNode.props);
  assert.equal(icon.type, "svg", "侧边栏图标为内联 svg（评审拍板：不引包内 icon.png，避免 404 破图）");
  assert.equal(icon.props.width, 18, "图标宽度随 size 下发");
  assert.equal(icon.props.height, 18, "图标高度随 size 下发");
  assert.equal(icon.props.stroke, "currentColor", "描边随宿主文字色");
});

// ---------------------------------------------------------------------------
// S1 启用入口（0.4）：configurationState needs-persona / needs-active / configured
// 三态初始化卡 + 「完成配置并启用」「启用记忆」的 settings 精确写入形状。
// needs-persona 一次写三键落 configured（点一次即启用）；needs-active 只写
// mode/allowActive 两键、卡名只读回显（不越态改默认卡）。
// dataRoot/stateRoot 只做回显确认，绝不写进配置（settings 未知键会被服务端拒绝）。
// ---------------------------------------------------------------------------

function findButton(tree, label) {
  return flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === label) || null;
}

function s1StatusDto(configurationState, extra = {}) {
  return {
    mode: configurationState === "configured" ? "active" : "shadow",
    configured: configurationState === "configured",
    scope: configurationState === "configured" ? "amber" : null,
    occupancy: null,
    capabilities: { l2: false, organize: false, forgetting: false, tools: false, sections: false },
    diagnostics: Object.assign({
      ownerId: "local",
      generation: 1,
      started: true,
      dataRoot: String.raw`C:\Users\tester\.dsh\shiori-data`,
      stateRoot: String.raw`C:\Users\tester\.dsh\shiori-state`,
      // rootsSource 是对象 {dataRoot, stateRoot}（服务端校验在 src/plugin/scope.mjs）。
      // 曾经用字符串冒充，恰好把 client 端 String(obj) → [object Object] 的
      // P0#1 回显 bug 掩住了——桩必须是真实对象形态。
      rootsSource: { dataRoot: "default", stateRoot: "default" },
      configurationState,
    }, extra),
  };
}

// 找 S1 初始化卡（data-role=enable-card）
function enableCardOf(tree) {
  return flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "enable-card") || null;
}

async function mountS1Status(dto, scope, calls, dtoFor) {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  host.states.length = 0;
  host.states.push(dto, null); // StatusTab: status / error
  const callDto = typeof dtoFor === "function" ? dtoFor : () => dto;
  const dsh = {
    call: async (method, sid, payload) => {
      calls.push({ method, sid, payload });
      return callDto(calls.length);
    },
    configScope: () => scope,
  };
  const render = () => {
    host.runEffects.v = false;
    host.cursor.v = 0;
    return renderStatus(dsh, "session-A");
  };
  return { host, render, dsh };
}

function fakeConfigScope(initial, mutations) {
  const state = { revision: 7, value: structuredClone(initial) };
  return {
    getSnapshot: () => ({ status: "ready", revision: state.revision, value: structuredClone(state.value) }),
    mutate: (ops, revision) => {
      mutations.push({ ops, revision });
      state.revision += 1;
      // 简化模拟：set op 直接落到 value（真实宿主由 configForms 提交）
      for (const op of ops) state.value[op.path[0]] = structuredClone(op.value);
      return Promise.resolve(true);
    },
  };
}

test("S1 needs-persona：「完成配置并启用」一次写 mode/allowActive/defaultPersona 三键、落 configured（点一次即启用）", async () => {
  const calls = [];
  const mutations = [];
  const scope = fakeConfigScope({ mode: "shadow", allowActive: false, defaultPersona: null, sessionPersonas: [] }, mutations);
  const configuredDto = s1StatusDto("configured");
  const { render } = await mountS1Status(s1StatusDto("needs-persona"), scope, calls, () => configuredDto);
  const tree = render();
  const card = enableCardOf(tree);
  assert.ok(card, "needs-persona 渲染初始化卡");
  const text = collectText(tree);
  assert.ok(text.includes(String.raw`C:\Users\tester\.dsh\shiori-data`), "dataRoot 回显确认");
  assert.ok(text.includes(String.raw`C:\Users\tester\.dsh\shiori-state`), "stateRoot 回显确认");
  // rootsSource 回显（0.4 审查 P0#1）：桩是对象形态，渲染必须按字段拼出两个值，
  // 不得出现 [object Object]（String(对象) 的退化产物）。
  assert.ok(!text.includes("[object Object]"), "rootsSource 回显不得出现 [object Object]");
  assert.ok(text.includes("dataRoot=default") && text.includes("stateRoot=default"),
    "rootsSource 两个字段都按 dataRoot=… / stateRoot=… 形态出现在回显里");
  assert.ok(findButton(tree, "完成配置并启用"), "needs-persona 出「完成配置并启用」（一次到位）");
  assert.equal(findButton(tree, "保存人设卡"), null, "旧「保存人设卡」两步走文案不再出现");
  assert.equal(findButton(tree, "启用记忆"), null, "needs-persona 不单出「启用记忆」");
  // 输入 + 点击：一次 mutate 恰写三键（键序 mode → allowActive → defaultPersona，
  // 值 trim），不写 dataRoot/stateRoot。
  const input = flattenVNode(card).find((n) => n.type === "input");
  assert.ok(input, "人设卡输入框存在");
  input.props.onChange({ target: { value: " amber " } });
  const tree2 = render();
  findButton(tree2, "完成配置并启用").props.onClick();
  await flush();
  assert.equal(mutations.length, 1, "点一次恰好一次 mutate");
  assert.deepEqual(mutations[0].ops, [
    { op: "set", path: ["mode"], value: "active" },
    { op: "set", path: ["allowActive"], value: true },
    { op: "set", path: ["defaultPersona"], value: "amber" },
  ], "一次写三键（不多不少），首装不再要点两下");
  assert.equal(mutations[0].revision, 7, "带快照 revision fence");
  assert.deepEqual(mutations[0].ops.filter((op) => op.path[0] === "dataRoot" || op.path[0] === "stateRoot"), [],
    "dataRoot/stateRoot 不出现在写入 ops");
  const getStatusCalls = calls.filter((c) => c.method === "getStatus").length;
  assert.ok(getStatusCalls >= 1, "保存成功后刷新状态卡（load 发出 getStatus）");
  // getStatus 返回 configured → 再渲染时初始化卡消失（走向 configured）。
  const tree3 = render();
  assert.equal(enableCardOf(tree3), null, "needs-persona 保存后 getStatus 已返回 configured，初始化卡不再渲染");
});

test("S1 needs-active：「启用记忆」只写 mode/allowActive 两键（不越态改默认卡），卡名只读回显；configured 不出卡", async () => {
  const calls = [];
  const mutations = [];
  const scope = fakeConfigScope({ mode: "shadow", allowActive: false, defaultPersona: "amber", sessionPersonas: [] }, mutations);
  const { render } = await mountS1Status(s1StatusDto("needs-active"), scope, calls);
  const tree = render();
  const card = enableCardOf(tree);
  assert.ok(card, "needs-active 渲染初始化卡");
  assert.ok(findButton(tree, "启用记忆"), "「启用记忆」按钮存在");
  const input = flattenVNode(card).find((n) => n.type === "input");
  assert.equal(input.props.value, "amber", "当前配置卡名回显（草稿为空时输入框显示配置值）");
  assert.equal(input.props.readOnly, true, "needs-active 态卡名只读（该态不改默认卡）");
  // 点「启用记忆」：恰好一次 mutate、只写 mode/allowActive 两键，
  // 不带 defaultPersona（用户即便改过输入框也不能借启用顺手改卡）。
  findButton(tree, "启用记忆").props.onClick();
  await flush();
  assert.equal(mutations.length, 1, "启用恰好一次 mutate");
  assert.deepEqual(mutations[0].ops, [
    { op: "set", path: ["mode"], value: "active" },
    { op: "set", path: ["allowActive"], value: true },
  ], "needs-active 恰写两键，不含 defaultPersona");
  // 全部写入都不含 dataRoot / stateRoot（服务端只读派生，面板绝不写）。
  for (const m of mutations) {
    assert.deepEqual(m.ops.filter((op) => op.path[0] === "dataRoot" || op.path[0] === "stateRoot"), [],
      "dataRoot/stateRoot 不出现在写入 ops");
  }
  // configured：初始化卡不渲染。
  const calls2 = [];
  const mutations2 = [];
  const scope2 = fakeConfigScope({ mode: "active", allowActive: true, defaultPersona: "amber" }, mutations2);
  const { render: renderConfigured } = await mountS1Status(s1StatusDto("configured"), scope2, calls2);
  assert.equal(enableCardOf(renderConfigured()), null, "configured 状态不出初始化卡");
});

// rootsSource 边界（0.4 P0 交叉审查补钉）：服务端 diagnostics 里 rootsSource 畸形
// 时——非对象（字符串/null/缺失）或对象缺 dataRoot/stateRoot 字段——面板必须
// 回退不崩、不出现 [object Object]。期望值独立于实现可推：非对象 → 整体回退「—」；
// 对象缺字段 → 该字段位显示「—」，但 "dataRoot=… / stateRoot=…" 的形态保留。
test("S1 rootsSource 畸形回退：非对象 / 缺字段时面板不崩、按「—」回退、不出现 [object Object]", async () => {
  // [说明, rootsSource 桩值, 期望的根来源回显行内容]
  const cases = [
    ["rootsSource 是字符串", "default", "根来源 rootsSource: —"],
    ["rootsSource 是 null", null, "根来源 rootsSource: —"],
    ["rootsSource 缺失（undefined）", undefined, "根来源 rootsSource: —"],
    ["rootsSource 是空对象（两字段都缺）", {}, "根来源 rootsSource: dataRoot=— / stateRoot=—"],
    ["rootsSource 缺 dataRoot", { stateRoot: "default" }, "根来源 rootsSource: dataRoot=— / stateRoot=default"],
    ["rootsSource 缺 stateRoot", { dataRoot: "default" }, "根来源 rootsSource: dataRoot=default / stateRoot=—"],
    ["rootsSource 的 dataRoot 是空串", { dataRoot: "", stateRoot: "default" }, "根来源 rootsSource: dataRoot=— / stateRoot=default"],
    ["rootsSource 是数组形态", ["dev"], "根来源 rootsSource: dataRoot=— / stateRoot=—"],
  ];
  for (const [label, rootsSource, expectedEcho] of cases) {
    const calls = [];
    const mutations = [];
    const scope = fakeConfigScope({ mode: "shadow", allowActive: false, defaultPersona: null, sessionPersonas: [] }, mutations);
    const { render } = await mountS1Status(s1StatusDto("needs-persona", { rootsSource }), scope, calls);
    const tree = render();
    // 钉的行为：畸形 rootsSource 只影响回显回退，初始化卡照常渲染（面板不崩）。
    assert.ok(enableCardOf(tree), `${label}：初始化卡照常渲染（回退不崩）`);
    const text = collectText(tree);
    assert.ok(!text.includes("[object Object]"), `${label}：不得出现 [object Object]（对象被 String 化的退化产物）`);
    assert.ok(text.includes(expectedEcho), `${label}：回显按规格回退（期望「${expectedEcho}」）`);
  }
});

test("S1 needs-active 窄窗口：快照未就绪（configPersona 空）时启用按钮仍可点、输入不死锁", async () => {
  const calls = [];
  const mutations = [];
  const scope = fakeConfigScope({ mode: "shadow", allowActive: false, defaultPersona: null, sessionPersonas: [] }, mutations);
  const { render } = await mountS1Status(s1StatusDto("needs-active"), scope, calls);
  const tree = render();
  const card = enableCardOf(tree);
  assert.ok(card, "needs-active 渲染初始化卡");
  const enable = findButton(tree, "启用记忆");
  assert.ok(enable, "「启用记忆」按钮存在");
  assert.equal(enable.props.disabled, false, "卡名缺失不禁用启用（只读+禁用不死锁）");
  const input = flattenVNode(card).find((n) => n.type === "input");
  assert.equal(input.props.readOnly, false, "configPersona 为空时不锁输入");
});

test("S1 启用 CAS：mutate 返回 false → 重读快照换 revision 重试一次；仍 false 按证据区分宿主拒绝 / revision 冲突（S2-1，评审 attempt-3 阻塞 B）", async () => {
  // false 一次后成功：恰好两次 mutate，第二次 revision 换新，无错误、状态卡刷新。
  const calls = [];
  const mutations = [];
  const state = { revision: 7, value: { mode: "shadow", allowActive: false, defaultPersona: null, sessionPersonas: [] } };
  let failFirst = true;
  const casScope = {
    getSnapshot: () => ({ status: "ready", revision: state.revision, value: structuredClone(state.value) }),
    mutate: (ops, revision) => {
      mutations.push({ ops, revision });
      if (failFirst) {
        failFirst = false;
        state.revision += 1; // 并发写入者先动了一步，旧 fence 失效
        return Promise.resolve(false);
      }
      for (const op of ops) state.value[op.path[0]] = structuredClone(op.value);
      state.revision += 1;
      return Promise.resolve(true);
    },
  };
  const configuredDto = s1StatusDto("configured");
  const { render } = await mountS1Status(s1StatusDto("needs-persona"), casScope, calls, () => configuredDto);
  let tree = render();
  const input = flattenVNode(enableCardOf(tree)).find((n) => n.type === "input");
  input.props.onChange({ target: { value: "amber" } });
  tree = render();
  findButton(tree, "完成配置并启用").props.onClick();
  await flush();
  assert.equal(mutations.length, 2, "CAS false 恰好重试一次（不是点了没变化）");
  assert.equal(mutations[0].revision, 7, "第一次带旧 fence");
  assert.equal(mutations[1].revision, 8, "重试前重读快照、换新 fence");
  assert.deepEqual(mutations[1].ops, mutations[0].ops, "重试的 ops 与第一次一致（三键）");
  tree = render();
  assert.equal(collectText(tree).includes("启用失败"), false, "重试成功不走失败文案");
  assert.equal(enableCardOf(tree), null, "成功后 getStatus 回 configured、初始化卡消失");
  // 一直 false：只重试一次就报冲突，亮原文（不无限重试、不静默）。
  const mutations2 = [];
  const alwaysFalse = {
    getSnapshot: () => ({ status: "ready", revision: 7, value: { mode: "shadow", allowActive: false, defaultPersona: null, sessionPersonas: [] } }),
    mutate: (ops, revision) => { mutations2.push({ ops, revision }); return Promise.resolve(false); },
  };
  const { render: renderFail } = await mountS1Status(s1StatusDto("needs-persona"), alwaysFalse, []);
  let tree2 = renderFail();
  flattenVNode(enableCardOf(tree2)).find((n) => n.type === "input").props.onChange({ target: { value: "amber" } });
  tree2 = renderFail();
  findButton(tree2, "完成配置并启用").props.onClick();
  await flush();
  tree2 = renderFail();
  assert.equal(mutations2.length, 2, "仍 false 也只重试一次（不无限重试）");
  const text = collectText(tree2);
  assert.ok(text.includes("启用失败"), "失败文案出现");
  // S2-1：mutate 恒 false 且 revision 没动 = 宿主拒绝写入，不再误报「revision 冲突」。
  assert.ok(text.includes("宿主拒绝写入"), "无冲突证据时如实说「宿主拒绝写入」");
  assert.equal(text.includes("设置刚被其他窗口修改"), false, "不得把宿主拒绝拼成 revision 冲突");
  // 首次抛错、第二次返回 false：两条路径不得叠加，总共仍是两次 attempt
  //（评审 attempt-4 阻塞 1：此场景此前会调用 3 次）。
  const mutations3 = [];
  let throwFirst = true;
  const throwThenFalse = {
    getSnapshot: () => ({ status: "ready", revision: 7, value: { mode: "shadow", allowActive: false, defaultPersona: null, sessionPersonas: [] } }),
    mutate: (ops, revision) => {
      mutations3.push({ ops, revision });
      if (throwFirst) { throwFirst = false; return Promise.reject(new Error("host hiccup")); }
      return Promise.resolve(false);
    },
  };
  const { render: renderStack } = await mountS1Status(s1StatusDto("needs-persona"), throwThenFalse, []);
  let tree3 = renderStack();
  flattenVNode(enableCardOf(tree3)).find((n) => n.type === "input").props.onChange({ target: { value: "amber" } });
  tree3 = renderStack();
  findButton(tree3, "完成配置并启用").props.onClick();
  await flush();
  tree3 = renderStack();
  assert.equal(mutations3.length, 2, "首次抛错 + 二次 false 也只有两次 attempt（重试不叠加）");
  const text3 = collectText(tree3);
  assert.ok(text3.includes("启用失败"), "失败文案出现");
  // S2-1：最后一次是普通错误、revision 未变 → 宿主拒绝写入（不误报 revision 冲突）。
  assert.ok(text3.includes("宿主拒绝写入"), "无冲突证据仍走「宿主拒绝写入」");
  assert.ok(text3.includes("host hiccup"), "错误原文保留可见（不静默吞）");
  // S2-1 对照：revision 在两次尝试之间确实变了（并发写入者动了），才允许说 revision 冲突。
  const mutations4 = [];
  const movedRevision = { v: 7 };
  const movedScope = {
    getSnapshot: () => ({ status: "ready", revision: movedRevision.v, value: { mode: "shadow", allowActive: false, defaultPersona: null, sessionPersonas: [] } }),
    mutate: (ops, revision) => {
      mutations4.push({ ops, revision });
      movedRevision.v += 1; // 每次都有人抢先写，旧 fence 必失效
      return Promise.resolve(false);
    },
  };
  const { render: renderMoved } = await mountS1Status(s1StatusDto("needs-persona"), movedScope, []);
  let tree4 = renderMoved();
  flattenVNode(enableCardOf(tree4)).find((n) => n.type === "input").props.onChange({ target: { value: "amber" } });
  tree4 = renderMoved();
  findButton(tree4, "完成配置并启用").props.onClick();
  await flush();
  tree4 = renderMoved();
  assert.equal(mutations4.length, 2, "revision 变化场景同样只重试一次");
  const text4 = collectText(tree4);
  assert.ok(text4.includes("revision 冲突"), "revision 确有变化时仍报 revision 冲突");
  assert.equal(text4.includes("宿主拒绝写入"), false, "真冲突不落到宿主拒绝分支");
});

test("S1 启用：快照非 ready / 无 revision 时不发 mutate、亮原文（attempt 校验快照，评审 attempt-4 非阻塞）", async () => {
  const mutations = [];
  const notReady = {
    getSnapshot: () => ({ status: "loading", revision: null, value: null }),
    mutate: (ops, revision) => { mutations.push({ ops, revision }); return Promise.resolve(true); },
  };
  const { render } = await mountS1Status(s1StatusDto("needs-persona"), notReady, []);
  let tree = render();
  flattenVNode(enableCardOf(tree)).find((n) => n.type === "input").props.onChange({ target: { value: "amber" } });
  tree = render();
  findButton(tree, "完成配置并启用").props.onClick();
  await flush();
  tree = render();
  assert.equal(mutations.length, 0, "快照不可用绝不发 mutate（两次尝试都在快照校验处拦下）");
  const text = collectText(tree);
  assert.ok(text.includes("启用失败"), "失败文案出现");
  assert.ok(text.includes("设置快照不可用"), "快照校验原文可见（不静默吞）");
});

test("S1 兜底：configForms 缺席时按钮禁用并给说明；mutation 失败亮错误原文", async () => {
  const calls = [];
  const { render } = await mountS1Status(s1StatusDto("needs-active"), undefined, calls);
  const tree = render();
  const enable = findButton(tree, "启用记忆");
  assert.ok(enable, "按钮仍渲染");
  assert.equal(enable.props.disabled, true, "configForms 缺席 → 启用按钮禁用");
  assert.ok(collectText(tree).includes("设置命名空间不可用"), "缺席说明可见");
  // mutation 拒绝 → 错误原文进 ErrorBox（不静默吞）。
  const mutations = [];
  const scope = {
    getSnapshot: () => ({ status: "ready", revision: 1, value: { mode: "shadow", allowActive: false, defaultPersona: "amber" } }),
    mutate: () => Promise.reject(Object.assign(new Error("denied by host"), { code: "shiori/denied" })),
  };
  const { render: renderFail } = await mountS1Status(s1StatusDto("needs-active"), scope, []);
  let tree2 = renderFail();
  flattenVNode(enableCardOf(tree2)).find((n) => n.type === "input").props.onChange({ target: { value: "amber" } });
  tree2 = renderFail();
  findButton(tree2, "启用记忆").props.onClick();
  await flush();
  tree2 = renderFail(); // 错误写入 state 后重渲染才可见
  const text = collectText(tree2);
  assert.ok(text.includes("启用失败"), "失败文案出现");
  assert.ok(text.includes("denied by host"), "错误原文可见（不静默吞）");
});

// ---------------------------------------------------------------------------
// S2-2：启用卡的人设卡下拉（getStatus.personas）。列表非空 → select，
// 空/缺失/非数组 → 手填输入框回退（绝不锁死）。
// ---------------------------------------------------------------------------

function dropdownScope(defaultPersona) {
  return {
    getSnapshot: () => ({ status: "ready", revision: 1, value: { mode: "shadow", allowActive: false, defaultPersona, sessionPersonas: [] } }),
    mutate: () => Promise.resolve(true),
  };
}

test("S2-2 启用卡：personas 非空 → 下拉列出全部卡名，选中后草稿生效、启用按钮解禁", async () => {
  const dto = s1StatusDto("needs-persona");
  dto.personas = ["amber", "beta", "  amber  ", ""]; // 重复/空白项应被清洗
  const { render } = await mountS1Status(dto, dropdownScope(""), []);
  let tree = render();
  const card = enableCardOf(tree);
  assert.ok(card, "needs-persona 渲染初始化卡");
  const select = flattenVNode(card).find((n) => n.type === "select" && n.props["data-role"] === "persona-select");
  assert.ok(select, "有卡列表时渲染下拉（data-role=persona-select）");
  assert.equal(flattenVNode(card).some((n) => n.type === "input"), false, "有列表时不再渲染手填输入框");
  const options = flattenVNode(select).filter((n) => n.type === "option").map((n) => collectText(n));
  assert.deepEqual(options, ["请选择人设卡", "amber", "beta"], "选项来自 personas（去重、去空白）");
  assert.equal(findButton(tree, "完成配置并启用").props.disabled, true, "未选卡时启用按钮禁用");
  select.props.onChange({ target: { value: "beta" } });
  tree = render();
  const select2 = flattenVNode(enableCardOf(tree)).find((n) => n.type === "select" && n.props["data-role"] === "persona-select");
  assert.equal(select2.props.value, "beta", "选中值进入草稿");
  assert.equal(findButton(tree, "完成配置并启用").props.disabled, false, "选了非空卡名后启用按钮解禁");
});

test("S2-2 启用卡：personas 缺失 / 非数组 → 手填输入框回退（契约容忍，不崩不锁死）", async () => {
  for (const personas of [undefined, null, "amber", 42, {}]) {
    const dto = s1StatusDto("needs-persona");
    if (personas !== undefined) dto.personas = personas;
    const { render } = await mountS1Status(dto, dropdownScope(""), []);
    const tree = render();
    const card = enableCardOf(tree);
    assert.ok(card, "初始化卡照常渲染（personas=" + JSON.stringify(personas) + "）");
    const select = flattenVNode(card).find((n) => n.type === "select" && n.props["data-role"] === "persona-select");
    assert.equal(select, undefined, "非数组不渲染下拉");
    const input = flattenVNode(card).find((n) => n.type === "input");
    assert.ok(input, "回退到手填输入框");
    assert.equal(input.props.readOnly, false, "回退时输入框可编辑（不锁死）");
  }
});

test("S2-2 启用卡：needs-active + 已有卡名 → 下拉只读回显（与输入框 readOnly 口径一致）", async () => {
  const dto = s1StatusDto("needs-active");
  dto.personas = ["amber", "beta"];
  const { render } = await mountS1Status(dto, dropdownScope("amber"), []);
  const tree = render();
  const select = flattenVNode(enableCardOf(tree)).find((n) => n.type === "select" && n.props["data-role"] === "persona-select");
  assert.ok(select, "needs-active 有列表 → 下拉");
  assert.equal(select.props.value, "amber", "回显当前配置卡名");
  assert.equal(select.props.disabled, true, "needs-active 已有卡名时只读");
});

// ---------------------------------------------------------------------------
// S4「工作区默认卡」（0.4，S2-3 已搬到壳条选择器区）：「工作区默认卡」控件
// defaultPersona 编辑，单键 read-modify-write：只 set defaultPersona，其余配置
// 键原样保留。挂载 ShioriSection（面板 9 个 useState 预置），控件经
// data-role="default-persona" 定位；personas 列表为空 → 手填输入框回退。
// ---------------------------------------------------------------------------

async function mountBudgetsForPersona(initialValue, mutations, mutateImpl, modeStatusExtra) {
  const host = makeStatefulReact();
  const state = { revision: 3, value: structuredClone(initialValue) };
  const scope = {
    getSnapshot: () => ({ status: "ready", revision: state.revision, value: structuredClone(state.value) }),
    mutate: (ops, revision) => {
      mutations.push({ ops, revision });
      if (mutateImpl) return mutateImpl(ops, revision, state);
      for (const op of ops) state.value[op.path[0]] = structuredClone(op.value);
      state.revision += 1;
      return Promise.resolve(true);
    },
  };
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: { inject: (n, fn) => fn(), register: (meta, render) => { renderSlot = render; return () => {}; } },
    configForms: { get: (ns) => (ns === "shiori" ? scope : undefined) },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push(
    "budgets", "session-A", "", [],
    Object.assign({ mode: "active", scope: "amber" }, modeStatusExtra),
    { sessionId: "session-A", blocked: false, error: null, probeError: null, skipped: 0, probing: false, done: true },
    0, null, "",
  );
  const render = () => {
    host.cursor.v = 0;
    host.runEffects.v = false;
    return sectionVNode.type(sectionVNode.props);
  };
  return { host, render, scope };
}

const defaultPersonaControlOf = (tree) => flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "default-persona") || null;

test("S4 工作区默认卡：输入回显当前配置值；保存只 set defaultPersona 一个键（mode/budgets 等原样保留）", async () => {
  const mutations = [];
  const initialValue = {
    mode: "active", allowActive: true, defaultPersona: "amber-old",
    sessionPersonas: [{ sessionId: "s1", persona: null }],
    budgets: structuredClone(FULL_BUDGETS),
  };
  const { render } = await mountBudgetsForPersona(initialValue, mutations);
  let tree = render();
  const cardOf = defaultPersonaControlOf;
  assert.ok(cardOf(tree), "壳条选择器区渲染「工作区默认卡」控件");
  const inputOf = (t) => flattenVNode(cardOf(t)).find((n) => n.type === "input");
  assert.equal(inputOf(tree).props.value, "amber-old", "输入框回显当前 defaultPersona");
  inputOf(tree).props.onChange({ target: { value: "amber-new" } });
  tree = render();
  flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === "保存默认卡").props.onClick();
  await flush();
  assert.equal(mutations.length, 1, "保存恰好一次 mutate");
  assert.deepEqual(mutations[0].ops, [{ op: "set", path: ["defaultPersona"], value: "amber-new" }],
    "只 set defaultPersona 单键");
  assert.ok(collectText(render()).includes("工作区默认人设卡已保存"), "成功提示可见");
});

test("S4 工作区默认卡：trim 后空串拒绝（「卡名不能为空」且不发 mutate）；失败亮错误原文", async () => {
  const mutations = [];
  const initialValue = { mode: "shadow", allowActive: false, defaultPersona: null, budgets: structuredClone(FULL_BUDGETS) };
  const { render } = await mountBudgetsForPersona(initialValue, mutations);
  let tree = render();
  const inputOf = (t) => flattenVNode(defaultPersonaControlOf(t)).find((n) => n.type === "input");
  inputOf(tree).props.onChange({ target: { value: "   " } });
  tree = render();
  flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === "保存默认卡").props.onClick();
  await flush();
  tree = render(); // 错误写入 state 后重渲染才可见
  assert.equal(mutations.length, 0, "空卡名不发 mutate");
  assert.ok(collectText(tree).includes("卡名不能为空"), "空串拒绝提示");
  // 失败路径：错误原文可见（不静默吞）。
  const mutations2 = [];
  const failing = await mountBudgetsForPersona(
    { mode: "shadow", allowActive: false, defaultPersona: "amber", budgets: structuredClone(FULL_BUDGETS) },
    mutations2,
    () => Promise.reject(Object.assign(new Error("CAS conflict"), { code: "REVISION_CONFLICT" })),
  );
  let tree2 = failing.render();
  inputOf(tree2).props.onChange({ target: { value: "beta" } });
  tree2 = failing.render();
  flattenVNode(tree2).find((n) => n.type === "button" && collectText(n) === "保存默认卡").props.onClick();
  await flush();
  tree2 = failing.render(); // 错误写入 state 后重渲染才可见
  const text2 = collectText(tree2);
  assert.ok(text2.includes("保存失败"), "失败文案出现");
  assert.ok(text2.includes("CAS conflict"), "错误原文可见");
});

// ---------------------------------------------------------------------------
// 0.4 B 批（B1/B2）：重试口径统一 ≤2 次 + conflict 挂 cause。
// ---------------------------------------------------------------------------

test("0.4 B1：saveDefaultPersona 两次 mutate 都抛错 → 恰好 ≤2 次 mutate，message 含第二次原始错误文本", async () => {
  const mutations = [];
  const errs = [
    Object.assign(new Error("第一次失败：host hiccup A"), { code: "shiori/denied" }),
    Object.assign(new Error("第二次失败：host hiccup B"), { code: "shiori/denied" }),
  ];
  let calls = 0;
  const page = await mountBudgetsForPersona(
    { mode: "shadow", allowActive: false, defaultPersona: "amber", budgets: structuredClone(FULL_BUDGETS) },
    mutations,
    () => { const e = errs[Math.min(calls, errs.length - 1)]; calls += 1; return Promise.reject(e); },
  );
  let tree = page.render();
  const inputOf = (t) => flattenVNode(flattenVNode(t).find((n) => n.props && n.props["data-role"] === "default-persona"))
    .find((n) => n.type === "input");
  inputOf(tree).props.onChange({ target: { value: "beta" } });
  tree = page.render();
  flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === "保存默认卡").props.onClick();
  await flush();
  tree = page.render();
  assert.equal(mutations.length, 2, `恰好两次 mutate（原最坏口径 3 次），实际 ${mutations.length}`);
  const text = collectText(tree);
  assert.ok(text.includes("保存失败"), "失败文案出现");
  assert.ok(text.includes("第二次失败：host hiccup B"), "message 含第二次的原始错误文本（不吞成一句话）");
  assert.ok(text.includes("shiori/ui-persona-conflict"), "code 仍是 ui-persona-conflict");
});

test("0.4 B1：saveDefaultPersona 首次抛错、二次返回 false → 总共两次 mutate（路径不叠加）", async () => {
  const mutations = [];
  let threw = false;
  const page = await mountBudgetsForPersona(
    { mode: "shadow", allowActive: false, defaultPersona: "amber", budgets: structuredClone(FULL_BUDGETS) },
    mutations,
    () => {
      if (!threw) { threw = true; return Promise.reject(new Error("host hiccup")); }
      return Promise.resolve(false);
    },
  );
  let tree = page.render();
  const inputOf = (t) => flattenVNode(flattenVNode(t).find((n) => n.props && n.props["data-role"] === "default-persona"))
    .find((n) => n.type === "input");
  inputOf(tree).props.onChange({ target: { value: "beta" } });
  tree = page.render();
  flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === "保存默认卡").props.onClick();
  await flush();
  tree = page.render();
  assert.equal(mutations.length, 2, "首次抛错 + 二次 false 也是两次（重试不叠加）");
  const text = collectText(tree);
  assert.ok(text.includes("host hiccup"), "最后一次的原始错误文本可见");
  // S2-1：最后一次是普通错误、revision 未变 → 宿主拒绝写入（不再误报 revision 冲突）。
  assert.ok(text.includes("宿主拒绝写入"), "无冲突证据 → 宿主拒绝写入");
  assert.equal(text.includes("设置刚被其他窗口修改"), false, "不把宿主拒绝拼成 revision 冲突");
});

test("0.4 B2：conflict 挂 cause——第二次抛 shiori/ui-scope → 最终 code 仍是 ui-persona-conflict，cause 归因亮「原因：」", async () => {
  const mutations = [];
  const scopeError = Object.assign(new Error("设置快照不可用（status=ready）。"), { code: "shiori/ui-scope" });
  const page = await mountBudgetsForPersona(
    { mode: "shadow", allowActive: false, defaultPersona: "amber", budgets: structuredClone(FULL_BUDGETS) },
    mutations,
    () => Promise.reject(scopeError), // 两次都抛快照错误：它就是最后一次的原始错误
  );
  let tree = page.render();
  const inputOf = (t) => flattenVNode(flattenVNode(t).find((n) => n.props && n.props["data-role"] === "default-persona"))
    .find((n) => n.type === "input");
  inputOf(tree).props.onChange({ target: { value: "beta" } });
  tree = page.render();
  flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === "保存默认卡").props.onClick();
  await flush();
  tree = page.render();
  const text = collectText(tree);
  assert.ok(text.includes("[shiori/ui-persona-conflict]"), "最终 code 保持 ui-persona-conflict");
  assert.ok(text.includes("原因："), "message 追加「（原因：…）」");
  assert.ok(text.includes("shiori/ui-scope"), "cause.code（被吞前的原始归因）经（原因：…）可见");
  assert.ok(text.includes("设置快照不可用"), "cause.message 原文可见");
});

// 0.4 B 批（B1/B2）会话专属卡 personaWrite 的最小壳层 harness：直接渲染
// ShioriSection（面板 9 个 useState 预置，与 ui-shell.test.mjs mountSectionStateful
// 同口径；该文件不在本单白名单，故在此复刻最小接线，persona 按钮经 data-role 定位）。
async function mountSectionForSessionPersona(initialValue, mutateImpl) {
  const host = makeStatefulReact();
  const mutations = [];
  const state = { revision: 11, value: structuredClone(initialValue) };
  const scope = {
    getSnapshot: () => ({ status: "ready", revision: state.revision, value: structuredClone(state.value) }),
    mutate: (ops, revision) => {
      mutations.push({ ops, revision });
      if (mutateImpl) return mutateImpl(ops, revision, state);
      for (const op of ops) state.value[op.path[0]] = structuredClone(op.value);
      state.revision += 1;
      return Promise.resolve(true);
    },
  };
  const mod = registrations[0].factory((name) => (name === "react" ? host.react : zod));
  let renderSlot = null;
  const shioriNamespace = {
    getStatus: async () => ({ ok: true, value: { mode: "active", scope: "amber" } }),
    executeTool: async () => ({ ok: true, value: {} }),
  };
  const ctx = {
    remote: { $mount: async () => async () => {} },
    slots: { inject: (name, fn) => fn(), register: (meta, render) => { renderSlot = render; return () => {}; } },
  };
  ctx.get = (key) => (key === "remote.shiori" ? shioriNamespace : undefined);
  ctx.configForms = { get: (ns) => (ns === "shiori" ? scope : undefined) };
  await mod.apply(ctx);
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push(
    "status", "session-A", "", [],
    { mode: "active", scope: "amber" },
    { sessionId: "session-A", blocked: false, error: null, probeError: null, skipped: 0, probing: false, done: true },
    0, null, "",
  );
  const render = () => {
    host.cursor.v = 0;
    host.runEffects.v = false;
    return sectionVNode.type(sectionVNode.props);
  };
  return { render, mutations };
}

const personaButtonOf = (tree) => flattenVNode(tree).find((n) => n.type === "button" && n.props && n.props["data-role"] === "persona-card-btn") || null;
const personaRowOf = (tree) => flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "persona-card-row") || null;

const SESSION_PERSONA_INIT = {
  mode: "active", allowActive: true, defaultPersona: "amber",
  sessionPersonas: [{ sessionId: "session-A", persona: "amber" }],
};

test("0.4 B1：personaWrite（切换）两次 mutate 都抛错 → 恰好 ≤2 次 mutate，message 含第二次原始错误文本", async () => {
  const errs = [
    new Error("第一次失败：writer A"),
    new Error("第二次失败：writer B"),
  ];
  let calls = 0;
  const { render, mutations } = await mountSectionForSessionPersona(SESSION_PERSONA_INIT, () => {
    const e = errs[Math.min(calls, errs.length - 1)];
    calls += 1;
    return Promise.reject(e);
  });
  let tree = render();
  personaButtonOf(tree).props.onClick();
  tree = render();
  flattenVNode(personaRowOf(tree)).find((n) => n.type === "input").props.onChange({ target: { value: "beta" } });
  tree = render();
  flattenVNode(personaRowOf(tree)).find((n) => n.type === "button" && collectText(n) === "切换").props.onClick();
  await flush(20);
  tree = render();
  assert.equal(mutations.length, 2, `切换路径恰好两次 mutate（原最坏口径 3 次），实际 ${mutations.length}`);
  const text = collectText(tree);
  assert.ok(text.includes("切换失败"), "切换路径的失败文案（与清除路径分别鉴别）");
  assert.ok(text.includes("第二次失败：writer B"), "message 含第二次的原始错误文本");
  assert.ok(text.includes("shiori/ui-persona-conflict"), "conflict 终态");
});

test("0.4 B1/B2：personaWrite（清除专属卡）两次 mutate 都抛 shiori/ui-scope → ≤2 次 mutate + cause 归因亮「原因：」", async () => {
  const scopeError = Object.assign(new Error("设置快照不可用（status=ready）。"), { code: "shiori/ui-scope" });
  const { render, mutations } = await mountSectionForSessionPersona(SESSION_PERSONA_INIT, () => Promise.reject(scopeError));
  let tree = render();
  personaButtonOf(tree).props.onClick();
  tree = render();
  flattenVNode(personaRowOf(tree)).find((n) => n.type === "button" && collectText(n) === "清除专属卡").props.onClick();
  await flush(20);
  tree = render();
  assert.equal(mutations.length, 2, `清除路径恰好两次 mutate，实际 ${mutations.length}`);
  const text = collectText(tree);
  assert.ok(text.includes("清除专属卡失败"), "清除路径的失败文案（与切换路径分别鉴别）");
  assert.ok(text.includes("shiori/ui-persona-conflict"), "最终 code 是 ui-persona-conflict");
  assert.ok(text.includes("原因："), "message 追加「（原因：…）」");
  assert.ok(text.includes("shiori/ui-scope"), "cause.code（原始归因）经（原因：…）可见");
});

// ---------------------------------------------------------------------------
// S5 模型下载（0.4）：状态页「下载模型」按钮（未安装高亮）+ 进度条 + 取消 +
// 双源失败报错卡片（手动目录输入框 + 可复制安装提示词）。数据全部来自
// diagnostics.semantic.download（前端轮询既有 getStatus 读，不新增 RPC）。
// ---------------------------------------------------------------------------

function s5SemanticDto(download, semanticExtra = {}) {
  const dto = realPStatusDto();
  dto.diagnostics.semantic = Object.assign({
    provider: "local",
    enabled: true,
    ready: false,
    model: "Xenova/bge-small-zh-v1.5",
    modelDir: "C:\\Users\\tester\\.dsh\\shiori-data\\models",
    modelInstalled: false,
    rebuild: { running: false, phase: "idle", total: 0, done: 0, error: null },
    download,
  }, semanticExtra);
  return dto;
}

const s5IdleDownload = {
  running: false, phase: "idle", percent: null, loadedBytes: 0, totalBytes: 0,
  filesDone: 0, filesTotal: 0, source: null, error: null, installHint: null,
};

test("S5 下载按钮：未安装时高亮（主按钮）、「重建向量」并存；旧 DTO（无 download/modelDir）不炸", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const tree = renderStatusWithDto(host, renderStatus, s5SemanticDto(s5IdleDownload));
  const download = findButton(tree, "下载模型");
  assert.ok(download, "「下载模型」按钮存在");
  assert.ok(String(download.props.className).includes("dshi_btnPrimary"), "未安装 → 高亮主按钮");
  assert.equal(download.props.disabled, false);
  assert.ok(findButton(tree, "重建向量"), "「重建向量」按钮并存（S4 前端入口不回归）");
  assert.ok(collectText(tree).includes("未安装"), "模型文件未安装文案");
  assert.ok(collectText(tree).includes("models"), "模型目录（dataRoot 派生）可见");
  // 旧服务端 DTO：diagnostics.semantic 只有老字段（无 download/modelDir/modelInstalled）
  const oldDto = realPStatusDto();
  oldDto.diagnostics.semantic = { provider: "local", enabled: true, ready: true, model: "m", rebuild: { running: false, phase: "idle" } };
  const oldTree = renderStatusWithDto(host, renderStatus, oldDto);
  const oldDownload = findButton(oldTree, "下载模型");
  assert.ok(oldDownload, "旧 DTO 也渲染下载按钮（不炸）");
  assert.equal(String(oldDownload.props.className).includes("dshi_btnPrimary"), false,
    "modelInstalled 未知时不高亮（只有确认未安装才高亮）");
  assert.ok(collectText(oldTree).includes("已就绪"), "旧 DTO ready 文本不回归");
});

test("S5 下载中：进度文本（百分比 + MB + 文件数 + 源）、进度条 aria、取消按钮出现且下载禁点", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const tree = renderStatusWithDto(host, renderStatus, s5SemanticDto({
    ...s5IdleDownload,
    running: true, phase: "downloading", percent: 42,
    loadedBytes: 44_040_192, totalBytes: 104_857_600,
    filesDone: 1, filesTotal: 3, source: "https://hf-mirror.com/",
  }));
  const text = collectText(tree);
  assert.ok(text.includes("42%"), "百分比显示");
  assert.ok(text.includes("42.0MB / 100.0MB"), "已下载字节 / 总字节（MB）");
  assert.ok(text.includes("1/3 个文件"), "文件计数");
  assert.ok(text.includes("源 https://hf-mirror.com/"), "当前源");
  // 进度条节点（无 data-dshi-bar，不与 L0/L1 水位条的三档锚点混用）。
  const bars = flattenVNode(tree).filter((n) => n.props && n.props["aria-label"] === "模型下载进度");
  assert.equal(bars.length, 1, "下载进度条恰好一条");
  assert.equal(bars[0].props["aria-valuenow"], 42);
  assert.equal(bars[0].props["aria-valuemax"], 100);
  assert.ok(statusBars(tree), "L0/L1 水位条不回归");
  const download = findButton(tree, "下载中…");
  assert.equal(download.props.disabled, true, "下载中按钮禁点");
  assert.ok(findButton(tree, "取消"), "取消按钮出现");
  assert.equal(findButton(tree, "重建向量").props.disabled, false, "重建不受下载影响");
});

test("S5 双源失败报错卡片：错误原因、手动目录输入框、安装提示词与一键复制；保存目录只 set cacheDir 单键", async () => {
  const calls = [];
  const mutations = [];
  const scope = fakeConfigScope({
    mode: "active", allowActive: true, defaultPersona: "amber",
    semantic: { provider: "local", local: { model: "Xenova/bge-small-zh-v1.5", dims: 512, dtype: "q8", cacheDir: "", mirror: "https://hf-mirror.com/" } },
  }, mutations);
  const errDownload = {
    ...s5IdleDownload,
    running: false, phase: "error",
    error: "全部下载源均失败（共 2 个）。源 https://hf-mirror.com/：ENOTFOUND；源 https://huggingface.co/：ETIMEDOUT",
    installHint: "请把 HuggingFace 模型 Xenova/bge-small-zh-v1.5 安装到本机以下目录（目录结构必须保持「<缓存根>/<org>/<model>/」）：\nC:\\Users\\tester\\.dsh\\shiori-data\\models\\Xenova\\bge-small-zh-v1.5\n可用任一下载源：\nhttps://hf-mirror.com/\nhttps://huggingface.co/\n",
  };
  const { render } = await mountS1Status(s5SemanticDto(errDownload), scope, calls);
  let tree = render();
  const card = flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "download-error");
  assert.ok(card, "报错卡片渲染");
  const text = collectText(tree);
  assert.ok(text.includes("全部下载源均失败"), "服务端错误原文可见（不静默吞）");
  assert.ok(text.includes("网络原因"), "可读原因说明");
  assert.ok(text.includes("<缓存根>/<org>/<model>/"), "规范目录写法说明");
  assert.ok(text.includes("https://huggingface.co/"), "安装提示词（含双源）可见");
  assert.ok(findButton(tree, "复制安装提示词"), "一键复制按钮");
  assert.ok(findButton(tree, "保存目录"), "手动目录保存按钮");
  // 复制按钮在无剪贴板环境点击也不炸（catch 后给可读反馈）。
  findButton(tree, "复制安装提示词").props.onClick();
  await flush();
  const textAfterCopy = collectText(render());
  assert.ok(textAfterCopy.includes("复制失败"), "无剪贴板环境的失败反馈可见（不崩）");
  // 手动目录：输入 + 保存 → 恰一次 mutate，只 set semantic.local.cacheDir 单键。
  const input = flattenVNode(card).find((n) => n.type === "input");
  assert.ok(input, "手动目录输入框存在");
  input.props.onChange({ target: { value: " D:\\hf-cache " } });
  tree = render();
  findButton(tree, "保存目录").props.onClick();
  await flush();
  assert.equal(mutations.length, 1, "保存目录恰好一次 mutate");
  assert.deepEqual(mutations[0].ops, [
    { op: "set", path: ["semantic", "local", "cacheDir"], value: "D:\\hf-cache" },
  ], "只 set cacheDir 单键（值 trim，路径不写死）");
});

test("S5 复审 P1：依赖缺失归因（code=DOWNLOAD_DEPENDENCY_MISSING）→ 报错卡片不再说「网络原因」", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const tree = renderStatusWithDto(host, renderStatus, s5SemanticDto({
    ...s5IdleDownload,
    running: false, phase: "error",
    code: "DOWNLOAD_DEPENDENCY_MISSING",
    error: "缺少可选依赖 @huggingface/transformers（未随插件包安装）。这不是网络问题，"
      + "无需检查下载源——请在插件目录执行 npm i @huggingface/transformers 后重试。",
    installHint: null,
  }));
  const text = collectText(tree);
  assert.ok(text.includes("缺少可选依赖"), "服务端依赖缺失原文可见");
  assert.ok(text.includes("不是网络问题"), "归因文案按 code 切换为依赖缺失说明");
  assert.equal(text.includes("网络原因"), false, "不再把依赖缺失误归因为网络故障");
  // 网络 case 的归因文案不回归（默认分支仍讲网络原因）。
  const netTree = renderStatusWithDto(host, renderStatus, s5SemanticDto({
    ...s5IdleDownload,
    running: false, phase: "error",
    code: null,
    error: "全部下载源均失败（共 2 个）。",
  }));
  assert.ok(collectText(netTree).includes("网络原因"), "网络 case 归因不回归");
});

// 0.4 收账遗留 1：报错卡片按 dl.code 分三支（缺依赖 / 加载失败 / 其余网络）。
// 加载失败支的文案必须明确「不是网络问题」，且不复用缺依赖那句。
test("0.4 收账：code=DOWNLOAD_RUNTIME_LOAD_FAILED → 报错卡片明确「不是网络问题」，不复用缺依赖文案", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const tree = renderStatusWithDto(host, renderStatus, s5SemanticDto({
    ...s5IdleDownload,
    running: false, phase: "error",
    code: "DOWNLOAD_RUNTIME_LOAD_FAILED",
    error: "可选依赖 @huggingface/transformers 已安装，但运行时加载失败（不是网络问题，也不是缺依赖）。"
      + "请先查看错误信息，修复依赖环境（文件权限、版本兼容等）后重试。"
      + "（原始错误：EACCES: permission denied, open '<插件目录>/node_modules/@huggingface/transformers/dist/transformers.mjs'）",
    installHint: null,
  }));
  const card = flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "download-error");
  assert.ok(card, "报错卡片渲染");
  const text = collectText(tree);
  // 原始错误摘要透传（服务端 error 原文可见，不静默吞）。
  assert.ok(text.includes("EACCES: permission denied"), "原始错误摘要可见");
  assert.ok(text.includes("可选依赖已安装但加载失败"), "加载失败支的归因文案出现");
  // P2-1（B 批）：与服务端「包已装但内部缺模块」口径对齐——npm i 不一定解决，
  // 不再写死「npm i 不会解决问题」。
  assert.ok(text.includes("单纯 npm i @huggingface/transformers 不一定解决问题"),
    "RUNTIME 支文案与服务端口径对齐");
  assert.ok(text.includes("不是网络问题"), "明确这不是网络问题");
  assert.equal(text.includes("网络原因"), false, "不许走网络支文案");
  assert.equal(text.includes("这是插件缺可选依赖"), false, "不许复用缺依赖那句（npm i 修不好加载失败）");
  // 服务端原文里也带「不是网络问题」，但归因文案必须是卡片自己的加载失败支。
  // 老行为不回归：缺依赖支与网络支文案各自保持原样（见上一用例）。
});

// S2-5：缺可选依赖不是故障——卡片走中性 warn 样式，文案说明「可选能力、
// 只影响语义召回、其余功能不受影响」；其余失败仍用红色报错样式。
test("S2-5 缺依赖提示：卡片用中性 warn 样式（不再是红色 ErrorBox），文案点明可选能力/只影响语义召回", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const tree = renderStatusWithDto(host, renderStatus, s5SemanticDto({
    ...s5IdleDownload,
    running: false, phase: "error",
    code: "DOWNLOAD_DEPENDENCY_MISSING",
    error: "缺少可选依赖 @huggingface/transformers（未随插件包安装）。这不是网络问题，"
      + "无需检查下载源——请在插件目录执行 npm i @huggingface/transformers 后重试。",
    installHint: null,
  }));
  const card = flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "download-error");
  assert.ok(card, "提示卡片渲染");
  assert.ok(String(card.props.className).includes("dshi_warn"), "缺依赖卡片用 dshi_warn 中性样式");
  assert.equal(String(card.props.className).includes("dshi_error"), false, "不再用红色 dshi_error");
  assert.equal(card.props["data-tone"], "warn", "data-tone=warn 供样式/测试定位");
  const text = collectText(tree);
  assert.ok(text.includes("可选依赖"), "说明这是可选依赖");
  assert.ok(text.includes("只影响语义召回"), "说明缺失只影响语义召回");
  assert.ok(text.includes("其他记忆功能都不受影响") || text.includes("关键词召回与其他记忆功能都不受影响"),
    "说明其余功能不受影响");
  assert.equal(text.includes("网络原因"), false, "不说成网络原因");
  // 对照：运行时加载失败仍走红色报错卡片（不是可选能力缺失）。
  const runtimeTree = renderStatusWithDto(host, renderStatus, s5SemanticDto({
    ...s5IdleDownload,
    running: false, phase: "error",
    code: "DOWNLOAD_RUNTIME_LOAD_FAILED",
    error: "可选依赖已安装但运行时加载失败。",
    installHint: null,
  }));
  const runtimeCard = flattenVNode(runtimeTree).find((n) => n.props && n.props["data-role"] === "download-error");
  assert.ok(String(runtimeCard.props.className).includes("dshi_error"), "加载失败仍用红色报错样式");
  assert.notEqual(runtimeCard.props["data-tone"], "warn", "加载失败不标 warn");
});

test("S5 done/cancelled 相：完成提示指向「重建向量」；取消提示状态回到未就绪", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const doneTree = renderStatusWithDto(host, renderStatus, s5SemanticDto({
    ...s5IdleDownload, running: false, phase: "done", percent: 100,
    loadedBytes: 104_857_600, totalBytes: 104_857_600, filesDone: 3, filesTotal: 3,
  }));
  const doneText = collectText(doneTree);
  assert.ok(doneText.includes("已通过维度与文件校验"), "完成提示含校验语义");
  assert.ok(doneText.includes("重建向量"), "完成提示指向建索引");
  const cancelTree = renderStatusWithDto(host, renderStatus, s5SemanticDto({
    ...s5IdleDownload, running: false, phase: "cancelled",
  }));
  const cancelText = collectText(cancelTree);
  assert.ok(cancelText.includes("已取消"), "取消相提示");
  assert.ok(cancelText.includes("未就绪"), "取消后状态回到未就绪的说明");
  // cancelled 不是 error：报错卡片不渲染。
  assert.equal(flattenVNode(cancelTree).find((n) => n.props && n.props["data-role"] === "download-error") || null, null);
});

test("S5 面板重开接续：本地无快照（dlProgress null）时直接显示服务端在跑的任务 + 点取消发 cancel", async () => {
  const calls = [];
  const mutations = [];
  const scope = fakeConfigScope({
    mode: "active", allowActive: true, defaultPersona: "amber",
    semantic: { provider: "local", local: { model: "Xenova/bge-small-zh-v1.5", dims: 512, dtype: "q8", cacheDir: "", mirror: "https://hf-mirror.com/" } },
  }, mutations);
  const { render, dsh } = await mountS1Status(s5SemanticDto({
    ...s5IdleDownload,
    running: true, phase: "downloading", percent: 7, loadedBytes: 7_340_032,
    totalBytes: 104_857_600, filesDone: 0, filesTotal: 3, source: "https://huggingface.co/",
  }), scope, calls);
  const tree = render();
  // 没有本地轮询快照：进度直接来自服务端诊断（关面板不中断任务的可见性）。
  assert.ok(collectText(tree).includes("7%"), "服务端快照的百分比");
  assert.ok(collectText(tree).includes("源 https://huggingface.co/"), "回落中的官方源可见");
  findButton(tree, "取消").props.onClick();
  await flush();
  const cancelCall = calls.find((c) => c.method === "executeTool");
  assert.ok(cancelCall, "取消经 executeTool 发出");
  assert.deepEqual(cancelCall.payload, { name: "semantic_download", args: { cancel: true } },
    "取消 = 保留名 semantic_download + args.cancel（不新增 RPC）");
});


// ---------------------------------------------------------------------------
// 0.4 S6「卸载并清除数据」危险按钮：二次确认必须输入 dataRoot 原文
//（输入不对时不发 RPC），文案写清「只删 dataRoot，stateRoot 与 DSH 配置
// 不受影响」，失败如实显示错误码。
// ---------------------------------------------------------------------------

function findInputIn(node, out = []) {
  const all = flattenVNode(node);
  return all.filter((n) => n.type === "input");
}

function destroyCardOf(tree) {
  return flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "destroy-data-card") || null;
}

test("S6 危险按钮：dataRoot 已知时渲染「卸载并清除数据」卡，文案写清只删 dataRoot", async () => {
  const calls = [];
  const dto = s1StatusDto("configured", { dataRoot: String.raw`C:\Users\tester\.dsh\shiori-data`, stateRoot: String.raw`C:\Users\tester\.dsh\shiori-state` });
  const { render } = await mountS1Status(dto, null, calls);
  const tree = render();
  const card = destroyCardOf(tree);
  assert.ok(card, "状态页渲染危险按钮卡");
  const text = collectText(tree);
  assert.ok(text.includes("卸载并清除数据"), "按钮文案");
  assert.ok(text.includes("只删 dataRoot"), "写清「只删 dataRoot」");
  assert.ok(text.includes("stateRoot 与 DSH 配置不受影响"), "写清 stateRoot 与 DSH 配置不受影响");
  assert.equal(findButton(tree, "确认清除"), null, "确认框默认收起，只有点击后才展开");
});

test("S6 二次确认：输入与 dataRoot 原文不一致 → 不发 RPC（按钮禁用 + 处理函数硬闸）", async () => {
  const calls = [];
  const dataRoot = String.raw`C:\Users\tester\.dsh\shiori-data`;
  const dto = s1StatusDto("configured", { dataRoot, stateRoot: String.raw`C:\Users\tester\.dsh\shiori-state` });
  const { render } = await mountS1Status(dto, null, calls);
  let tree = render();
  findButton(tree, "卸载并清除数据").props.onClick();
  tree = render(); // setDestroyStage 落 state 后重渲染
  assert.ok(flattenVNode(tree).some((n) => n.props && n.props["data-role"] === "destroy-confirm"), "确认框展开");
  const confirmButton = findButton(tree, "确认清除");
  assert.equal(confirmButton.props.disabled, true, "输入为空时确认按钮禁用");
  // 输入错误的原文
  const input = flattenVNode(tree).find((n) => n.type === "input");
  input.props.onChange({ target: { value: dataRoot.slice(0, -1) } }); // 少最后一个字符
  tree = render();
  const confirmButton2 = findButton(tree, "确认清除");
  assert.equal(confirmButton2.props.disabled, true, "输入与原文不一致时确认按钮仍禁用");
  // 处理函数硬闸：绕过 disabled 直接 onClick 也不发 RPC
  confirmButton2.props.onClick();
  await flush();
  assert.equal(calls.filter((c) => c.method === "destroyData").length, 0, "输入不对时绝不发 destroyData RPC");
  // 大小写不同同样不发（逐字符相等，不忽略大小写）
  const input2 = flattenVNode(tree).find((n) => n.type === "input");
  input2.props.onChange({ target: { value: dataRoot.toLowerCase() } });
  tree = render();
  findButton(tree, "确认清除").props.onClick();
  await flush();
  assert.equal(calls.filter((c) => c.method === "destroyData").length, 0, "大小写不一致也不发 RPC");
});

// S2-6：确认框根因修复——placeholder 与比较同源（都取 trim 后的 dataRoot），
// 草稿比较前 trim：照抄可见字符（含从页面上带出的首尾空白）也能启用按钮；
// 中间字符不同仍禁用；确认 RPC 仍回传服务端原文。
test("S2-6 二次确认：输入完整 dataRoot（前后带空白）→ 按钮启用并发 destroyData；错误输入仍禁用", async () => {
  const calls = [];
  const dataRoot = String.raw`C:\Users\tester\.dsh\shiori-data`;
  const dto = s1StatusDto("configured", { dataRoot, stateRoot: String.raw`C:\Users\tester\.dsh\shiori-state` });
  const { render } = await mountS1Status(dto, null, calls);
  let tree = render();
  findButton(tree, "卸载并清除数据").props.onClick();
  tree = render();
  const input = flattenVNode(tree).find((n) => n.type === "input" && n.props["data-role"] === "destroy-confirm-input");
  assert.ok(input, "确认输入框带 data-role=destroy-confirm-input（可定位）");
  assert.equal(input.props.placeholder, dataRoot, "placeholder 与 dataRoot 同源（trim 后）");
  assert.equal(input.props.autoComplete, "off", "关闭自动补全，避免浏览器插入隐藏字符");
  // 逐字符输入完整路径（这里模拟从页面复制带出的首尾空白）→ 按钮启用
  input.props.onChange({ target: { value: "  " + dataRoot + "  " } });
  tree = render();
  const confirm = findButton(tree, "确认清除");
  assert.equal(confirm.props.disabled, false, "输入完整 dataRoot（首尾空白忽略）后确认按钮启用");
  assert.equal(flattenVNode(tree).some((n) => n.props && n.props["data-role"] === "destroy-mismatch"), false,
    "匹配时不出不一致提示");
  confirm.props.onClick();
  await flush();
  const destroyCall = calls.find((c) => c.method === "destroyData");
  assert.ok(destroyCall, "匹配后发出 destroyData");
  assert.deepEqual(destroyCall.payload, { confirm: dataRoot }, "confirm 回传服务端原文（不受首尾空白影响）");
  // 错误输入：中间字符不同 → 仍禁用 + 不一致提示
  const second = await mountS1Status(dto, null, []);
  let tree2 = second.render();
  findButton(tree2, "卸载并清除数据").props.onClick();
  tree2 = second.render();
  flattenVNode(tree2).find((n) => n.type === "input" && n.props["data-role"] === "destroy-confirm-input")
    .props.onChange({ target: { value: dataRoot.replace("shiori-data", "shiori-dat") } });
  tree2 = second.render();
  assert.equal(findButton(tree2, "确认清除").props.disabled, true, "错误输入仍禁用");
  assert.ok(flattenVNode(tree2).some((n) => n.props && n.props["data-role"] === "destroy-mismatch"),
    "错误输入给出「不一致」提示（不再让用户干瞪灰按钮）");
});

test("S6 二次确认：输入 dataRoot 原文 → 发 destroyData（confirm=原文）、成功后刷新状态并提示", async () => {
  const calls = [];
  const dataRoot = String.raw`C:\Users\tester\.dsh\shiori-data`;
  const dto = s1StatusDto("configured", { dataRoot, stateRoot: String.raw`C:\Users\tester\.dsh\shiori-state` });
  const { render, dsh } = await mountS1Status(dto, null, calls);
  let tree = render();
  findButton(tree, "卸载并清除数据").props.onClick();
  tree = render();
  const input = flattenVNode(tree).find((n) => n.type === "input");
  input.props.onChange({ target: { value: dataRoot } }); // 原文逐字符一致
  tree = render();
  const confirmButton = findButton(tree, "确认清除");
  assert.equal(confirmButton.props.disabled, false, "输入原文一致后确认按钮可用");
  confirmButton.props.onClick();
  await flush();
  const destroyCalls = calls.filter((c) => c.method === "destroyData");
  assert.equal(destroyCalls.length, 1, "恰发一次 destroyData RPC");
  assert.deepEqual(destroyCalls[0].payload, { confirm: dataRoot }, "confirm 必须等于 dataRoot 原文");
  assert.ok(calls.some((c) => c.method === "getStatus"), "成功后刷新状态页");
  tree = render();
  assert.ok(collectText(tree).includes("已焚毁 dataRoot"), "成功提示可见");
});

test("S6 失败显示错误码：destroyData 被拒时错误码如实可见", async () => {
  const calls = [];
  const dataRoot = String.raw`C:\Users\tester\.dsh\shiori-data`;
  const dto = s1StatusDto("configured", { dataRoot, stateRoot: String.raw`C:\Users\tester\.dsh\shiori-state` });
  const failingDto = { ...dto };
  const { render } = await mountS1Status(dto, null, calls, (n) => {
    if (n === 1) throw Object.assign(new Error("destroyData requires active mode"), { code: "UNSUPPORTED" });
    return failingDto;
  });
  let tree = render();
  findButton(tree, "卸载并清除数据").props.onClick();
  tree = render();
  const input = flattenVNode(tree).find((n) => n.type === "input");
  input.props.onChange({ target: { value: dataRoot } });
  tree = render();
  findButton(tree, "确认清除").props.onClick();
  await flush();
  tree = render();
  const text = collectText(tree);
  assert.ok(text.includes("清除失败"), "失败文案可见");
  assert.ok(text.includes("UNSUPPORTED"), "错误码如实显示");
  const errBox = flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "destroy-error");
  assert.ok(errBox, "错误块带 data-role=destroy-error");
});
