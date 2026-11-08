// F7 只读降级面板测试：黄条出现 / 消失 / owner 缺字段回退 PID、写按钮置灰 +
// 页内原因说明、只读轮询启停。证据级别与 ui-shell / ui-memory 一致：真实执行
// client/index.js（fake window.__ModuleLoader__ + 有状态 react stub + 真实宿主
// zod），组件函数真执行（SYNTHETIC，非浏览器实机）。黄条数据源为
// getStatus.diagnostics.readonly（guard.status()，src/plugin/management.mjs 注入）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const NPM_GLOBAL = process.env.DSH_NPM_GLOBAL
  ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
const HOST_MODULES = process.env.DSH_HOST_MODULES ?? join(NPM_GLOBAL, "@deepseek-ai", "dsh", "node_modules");

const zod = await import(`file:///${HOST_MODULES}/zod/index.js`);

const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
await import(pathToFileURL(join(WORKQ, "client", "index.js")).href);

// 真实 setTimeout：异步 flush 必须走真实定时器（假定时器用例内 globalThis.setTimeout
// 已被替换，用它会永远挂起；与 ui-shell 同法在模块加载期捕获）。
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const flush = (ms = 20) => new Promise((resolve) => realSetTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

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

// 面板自身 useState 个数（tab/sessionId/manual/sessions/modeStatus/availability/
// probeTick/workspaces/workspaceId）；本文件不往面板加 useState，老测试的
// PANEL_STATES=9 布局不变。
const PANEL_STATES = 9;

// 面板级渲染（黄条在 sticky 壳条内）：states[0..8] 预置，modeStatus 由参数给定。
async function mountSection(modeStatus) {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  const render = (nextModeStatus, dsh) => {
    host.states.length = Math.max(host.states.length, PANEL_STATES);
    host.states[0] = "status";
    host.states[1] = "session-A";
    host.states[2] = "";
    host.states[3] = null;
    host.states[4] = nextModeStatus === undefined ? modeStatus : nextModeStatus;
    host.cursor.v = 0;
    return sectionVNode.type({ dsh: dsh || { call: async () => ({}), listSessions: async () => [] } });
  };
  return { host, render };
}

function readonlyStatus(holder, writable = false) {
  return { writable, readonly: !writable, holder: holder ?? null, heldSince: null, readonlySince: null, releasedAt: null, lastProbeAt: null };
}

function modeStatusDto(readonly) {
  return { mode: "active", diagnostics: { ownerId: "local", generation: 1, started: true, readonly } };
}

// 与 client/index.js readonlySinceText 同口径的本地 HH:MM（避免测试里硬编码时区）。
function hhmmOf(ms) {
  const d = new Date(ms);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function bannerOf(tree) {
  return flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "readonly-banner") || null;
}

function findButtons(tree, label) {
  return flattenVNode(tree)
    .filter((n) => n.type === "button" && collectText(n) === label);
}

// ---------------------------------------------------------------------------
// a) 黄条：出现 / 文案 / owner 缺字段回退 / 消失
// ---------------------------------------------------------------------------

test("F7 黄条：diagnostics.readonly 非 null 且 writable=false 时出现，文案含 PID 与起始时刻", async () => {
  const startedAt = Date.UTC(2026, 10, 1, 2, 5, 0);
  const { render } = await mountSection(modeStatusDto(readonlyStatus({ pid: 4321, instanceId: "i-1", startedAt })));
  const tree = render();
  const banner = bannerOf(tree);
  assert.ok(banner, "黄条出现在壳层");
  const text = collectText(banner);
  assert.ok(text.includes("另一实例正在写入，当前只读"), "主文案");
  assert.ok(text.includes("PID 4321"), "PID 透出");
  assert.ok(text.includes("自 " + hhmmOf(startedAt) + " 起"), "起始时刻（本地 HH:MM）");
  assert.ok(text.includes("profile 配置修改由宿主管理"), "边界说明：宿主配置不受限");
  // 黄色系：roBanner 类（不用 error 红色、不是报错样式）。
  assert.ok(String(banner.props.className).includes("dshi_roBanner"));
});

test("F7 黄条：holder 缺 startedAt 回退只显示 PID；缺 pid 再退一级不炸", async () => {
  const { render } = await mountSection(modeStatusDto(readonlyStatus({ pid: 4321, instanceId: "i-1" })));
  let text = collectText(bannerOf(render()));
  assert.ok(text.includes("（PID 4321）"), "缺 startedAt → 回退 PID");
  assert.ok(!text.includes("自 "), "无起始时刻文案");

  const { render: render2 } = await mountSection(modeStatusDto(readonlyStatus(null)));
  text = collectText(bannerOf(render2()));
  assert.ok(text.includes("另一实例正在写入，当前只读。"), "holder 全缺 → 通用文案，不炸");
});

test("F7 黄条：writable=true 或 readonly=null 时不出现；恢复写后重渲染即消失", async () => {
  const { render } = await mountSection(modeStatusDto(readonlyStatus({ pid: 4321, startedAt: 0 }, true)));
  assert.equal(bannerOf(render()), null, "writable=true 无黄条");

  const { render: render3 } = await mountSection(modeStatusDto(null));
  assert.equal(bannerOf(render3()), null, "readonly=null（inert/shadow/未 start）无黄条");

  // 只读 → 恢复写：同一次挂载内刷新 modeStatus，黄条自动消失。
  const { render: render2 } = await mountSection(modeStatusDto(readonlyStatus({ pid: 4321, startedAt: 0 })));
  assert.ok(bannerOf(render2()), "只读时出现");
  assert.equal(bannerOf(render2(modeStatusDto(readonlyStatus(null, true)))), null, "恢复写后消失");
});

// ---------------------------------------------------------------------------
// b) 写按钮置灰 + 页内原因说明
// ---------------------------------------------------------------------------

const MEMORY_VIEW = {
  scope: "amber",
  l0: { text: "# 人设卡标题\n常驻身份说明", revision: "r0", chars: 12, stale: false },
  l1: { text: "CORE BODY", body: "CORE BODY", revision: "r1", chars: 9 },
  budgets: { persona: { maxChars: 12000 }, core: { targetChars: 8000 } },
};

async function mountMemoryTab() {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: { inject: (name, fn) => fn(), register: (meta, render) => { renderSlot = render; return () => {}; } },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push("memory", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const memoryTab = flattenVNode(sectionTree)
    .find((n) => typeof n.type === "function" && n.type.name === "MemoryTab");
  assert.ok(memoryTab, "MemoryTab reached");
  const render = (readOnly) => {
    host.states.length = Math.max(host.states.length, PANEL_STATES + 7);
    host.states[PANEL_STATES] = MEMORY_VIEW;
    host.cursor.v = PANEL_STATES;
    return memoryTab.type({ dsh: { call: async () => ({}) }, sessionId: "session-A", readOnly });
  };
  return { render };
}

test("F7 置灰：只读态记忆页「编辑 / 保存」禁用并给一行原因说明；恢复后可用", async () => {
  const { render } = await mountMemoryTab();
  const roTree = render(true);
  const edits = findButtons(roTree, "编辑");
  assert.ok(edits.length >= 2, "L0/L1 编辑入口都在");
  for (const button of edits) assert.equal(button.props.disabled, true, "只读态编辑禁用");
  assert.ok(collectText(roTree).includes("写操作已停用"), "页内说明置灰原因");
  const normalTree = render(undefined);
  for (const button of findButtons(normalTree, "编辑")) {
    assert.notEqual(button.props.disabled, true, "可写态编辑可用");
  }
  assert.ok(!collectText(normalTree).includes("写操作已停用"), "可写态无置灰说明");
});

const QUEUE_DTO = { queueRevision: 3, items: [], plans: [] };

async function mountCandidatesTab() {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: { inject: (name, fn) => fn(), register: (meta, render) => { renderSlot = render; return () => {}; } },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push("candidates", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const tab = flattenVNode(sectionTree)
    .find((n) => typeof n.type === "function" && n.type.name === "CandidatesTab");
  assert.ok(tab, "CandidatesTab reached");
  const render = (readOnly) => {
    host.states.length = Math.max(host.states.length, PANEL_STATES + 12);
    host.states[PANEL_STATES] = QUEUE_DTO; // data：queueRevision 已加载
    host.cursor.v = PANEL_STATES;
    return tab.type({ dsh: { call: async () => QUEUE_DTO }, sessionId: "session-A", readOnly });
  };
  return { render };
}

test("F7 置灰：只读态候选页「分析遗忘候选」按钮禁用（与服务端 assertHostWritable 同口径）", async () => {
  const { render } = await mountCandidatesTab();
  const roTree = render(true);
  // 0.3：整理入口（分析整理候选）裁撤，唯一 analyze 入口是「分析遗忘候选」
  for (const label of ["分析遗忘候选"]) {
    const button = findButtons(roTree, label)[0];
    assert.ok(button, label + " 按钮在");
    assert.equal(button.props.disabled, true, label + " 只读态禁用");
  }
  assert.ok(collectText(roTree).includes("写操作已停用"), "页内说明置灰原因");
  const normalTree = render(undefined);
  for (const label of ["分析遗忘候选"]) {
    assert.notEqual(findButtons(normalTree, label)[0].props.disabled, true, label + " 可写态可用");
  }
  assert.equal(findButtons(roTree, "分析整理候选").length, 0, "removed organize analyze button absent");
});

// ---------------------------------------------------------------------------
// c) 只读轮询：黄条期间每 8s 刷新 getStatus；恢复 writable 停止
// ---------------------------------------------------------------------------

// 可控假定时器（照 ui-shell 同法；只在轮询用例内安装，finally 还原）。
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
function installFakeTimers() {
  const state = { now: 0, timers: [] };
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, at: state.now + (ms || 0) };
    state.timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    const index = state.timers.indexOf(timer);
    if (index >= 0) state.timers.splice(index, 1);
  };
  return {
    async advance(ms) {
      state.now += ms;
      const due = state.timers.filter((timer) => timer.at <= state.now);
      for (const timer of due) {
        const index = state.timers.indexOf(timer);
        if (index >= 0) {
          state.timers.splice(index, 1);
          timer.fn();
        }
        await new Promise((resolve) => realSetTimeout(resolve, 0));
      }
    },
    pendingCount: () => state.timers.length,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

test("F7 轮询：只读态期间周期刷新 getStatus；getStatus 回 writable 后不再排下一轮", async () => {
  const timers = installFakeTimers();
  try {
    const startedAt = Date.UTC(2026, 10, 1, 2, 5, 0);
    const statusQueue = [
      modeStatusDto(readonlyStatus({ pid: 4321, startedAt })),
      modeStatusDto(readonlyStatus({ pid: 4321, startedAt })),
      modeStatusDto(readonlyStatus(null, true)), // 恢复可写
    ];
    const calls = [];
    const dsh = {
      call: async (method) => {
        calls.push(method);
        return statusQueue[Math.min(calls.filter((m) => m === "getStatus").length - 1, statusQueue.length - 1)];
      },
      listSessions: async () => [],
    };
    const host = makeStatefulReact();
    host.runEffects.v = true; // 面板级 effect 全部收集并手动运行
    const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
    let renderSlot = null;
    await mod.apply({
      remote: { $mount: async () => () => {} },
      slots: { inject: (name, fn) => fn(), register: (meta, render) => { renderSlot = render; return () => {}; } },
    });
    const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
    host.states.length = 0;
    host.states.push("status", "session-A", "", null, modeStatusDto(readonlyStatus({ pid: 4321, startedAt })));
    host.cursor.v = 0;
    const tree = sectionVNode.type({ dsh });
    assert.ok(bannerOf(tree), "只读黄条在");
    // 首帧 effect（loadSessions/probe）先跑掉，轮询 effect 最后注册。
    for (const fn of host.effects.splice(0)) fn();
    await flush();
    assert.equal(timers.pendingCount(), 1, "只读态排入 8s 轮询定时器");
    await timers.advance(8000);
    await flush();
    const getStatusCount = calls.filter((m) => m === "getStatus").length;
    assert.ok(getStatusCount >= 2, "轮询触发了一次 getStatus 刷新");
    // 第二次轮询仍只读 → 再排一轮；第三次返回 writable → 停。
    assert.equal(timers.pendingCount(), 1, "仍只读 → 下一轮已排");
    await timers.advance(8000);
    await flush();
    assert.equal(timers.pendingCount(), 0, "恢复 writable → 不再排下一轮（黄条随之消失）");
  } finally {
    timers.restore();
  }
});
