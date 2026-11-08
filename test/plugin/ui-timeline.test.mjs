// F4「最近变更」面板页测试：渲染 / 分页 / hasMore / scanLimited 提示 / 空状态 /
// 跳转（专题 → 专题 tab、卡片 → 图谱 tab；core 不跳）。证据级别与 ui-memory /
// ui-shell 一致：真实执行 client/index.js（fake window.__ModuleLoader__ + 有状态
// react stub + 真实宿主 zod），TimelineTab 组件函数真执行（SYNTHETIC，非浏览器
// 实机）。不触真实宿主 RPC，不修改任何既有测试文件。

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

// ---------------------------------------------------------------------------
// harness（与 ui-memory 同构：有状态 react stub；effect 可手动运行以驱动 load）
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

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// 面板自身 useState 个数（tab/sessionId/manual/sessions/modeStatus/availability/
// probeTick/workspaces/workspaceId）＝ 9；TimelineTab 的 page/offset/error/busy
// 四个 state 从下标 9 起（本文件不往面板加 useState，老测试的 PANEL_STATES 不变）。
const PANEL_STATES = 9;

async function mountTimelineTab() {
  const host = makeStatefulReact();
  host.runEffects.v = true; // 收集 effect 但由测试手动运行（不发面板级 RPC）
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
  host.states.length = 0;
  host.states.push("timeline", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  host.effects.length = 0; // 面板级 effect 不跑（stub 不自动执行）
  const timelineTab = flattenVNode(sectionTree)
    .find((n) => typeof n.type === "function" && n.type.name === "TimelineTab");
  assert.ok(timelineTab, "TimelineTab reached through real slot render");
  host.runEffects.v = false;
  const renderTab = (dsh, page, extra = {}) => {
    host.states.length = Math.max(host.states.length, PANEL_STATES + 4);
    host.states[PANEL_STATES] = page === undefined ? null : page;          // pageState
    // offset / error / busy 用初始值（stub useState 首读时落 states[10..12]）
    host.cursor.v = PANEL_STATES;
    host.runEffects.v = true; // 只收集 TimelineTab 自己的 effect，由测试手动运行
    const tree = timelineTab.type({ dsh, sessionId: "session-A", onJump: extra.onJump });
    host.runEffects.v = false;
    return tree;
  };
  const runTabEffects = async () => {
    for (const fn of host.effects.splice(0)) await fn();
  };
  return { host, renderTab, runTabEffects };
}

function findButtons(tree, label) {
  return flattenVNode(tree)
    .filter((n) => n.type === "button" && collectText(n) === label);
}

// ---------------------------------------------------------------------------
// fixtures（wire 形状见 src/plugin/protocol.mjs timelineItem）
// ---------------------------------------------------------------------------

function timelineItem(fields) {
  return Object.assign({
    at: "2026-11-01T10:30:00.000Z",
    action: "spark.save",
    source: "spark",
    scope: "amber",
    target: { type: "spark", id: "abcd1234abcd1234abcd", title: "会议纪要" },
    detail: {},
  }, fields);
}

function pageDto(fields) {
  return Object.assign({
    scope: "amber",
    items: [],
    hasMore: false,
    skippedCorrupted: 0,
    scanLimited: false,
  }, fields);
}

// ---------------------------------------------------------------------------
// a) 渲染：时间 / 动作 / 来源 / 对象 / 去重标注
// ---------------------------------------------------------------------------

test("F4 渲染：每条显示时间、动作（中文）、来源徽章、涉及对象；dedupe 条目有可见标注", async () => {
  const { renderTab } = await mountTimelineTab();
  const page = pageDto({
    items: [
      timelineItem(),
      timelineItem({
        action: "core.write", source: "journal",
        target: { type: "core", id: "CORE", title: null },
        detail: { operationId: "op-1", dedupedWith: ["spark"] },
      }),
    ],
  });
  const tree = renderTab({ call: async () => page }, page);
  const text = collectText(tree);
  assert.match(text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, "时间已格式化显示");
  assert.ok(text.includes("存卡"), "动作中文化（spark.save → 存卡）");
  assert.ok(text.includes("核心写入"), "动作中文化（core.write → 核心写入）");
  assert.ok(text.includes("卡片"), "来源徽章（spark → 卡片）");
  assert.ok(text.includes("核心"), "来源徽章（core → 核心）");
  assert.ok(text.includes("会议纪要"), "涉及对象显示标题");
  assert.ok(text.includes("scope amber"), "scope 标签透传（不自行过滤）");
  assert.ok(text.includes("已去重"), "dedupe 条目有可见标注");
  // 去重徽章是带 dshi_tlDedupe 类的专属徽章（title 说明合并语义，不进文本树）。
  const dedupeBadges = flattenVNode(tree).filter((n) => n.type === "span"
    && String(n.props.className || "").includes("dshi_tlDedupe"));
  assert.equal(dedupeBadges.length, 1, "去重徽章只标注带 dedupedWith 的那一条");
});

test("F4 渲染：动作词表外的未知 action 按原样显示（不吞不炸）", async () => {
  const { renderTab } = await mountTimelineTab();
  const page = pageDto({ items: [timelineItem({ action: "spark.something-new" })] });
  const tree = renderTab({ call: async () => page }, page);
  assert.ok(collectText(tree).includes("spark.something-new"), "未知 action 原样透出");
});

// ---------------------------------------------------------------------------
// b) 分页与 hasMore
// ---------------------------------------------------------------------------

test("F4 分页：hasMore=false 时「下一页」禁用；首页「上一页」禁用", async () => {
  const { renderTab } = await mountTimelineTab();
  const page = pageDto({ items: [timelineItem()], hasMore: false });
  const tree = renderTab({ call: async () => page }, page);
  const next = findButtons(tree, "下一页")[0];
  const prev = findButtons(tree, "上一页")[0];
  assert.ok(next && next.props.disabled === true, "末页 hasMore=false → 下一页禁用");
  assert.ok(prev && prev.props.disabled === true, "首页 → 上一页禁用");
});

test("F4 分页：hasMore=true 时「下一页」可点，点击后以 offset=20 请求下一页（0.3 每页 100 → 20）", async () => {
  const { host, renderTab, runTabEffects } = await mountTimelineTab();
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      return pageDto({ items: [timelineItem()], hasMore: false });
    },
  };
  const firstPage = pageDto({ items: [timelineItem()], hasMore: true });
  let tree = renderTab(dsh, firstPage);
  const next = findButtons(tree, "下一页")[0];
  assert.ok(next && next.props.disabled !== true, "hasMore=true → 下一页可用");
  host.effects.length = 0; // 首轮渲染的 load(offset=0) 不重放，只看翻页那一次请求
  next.props.onClick();
  tree = renderTab(dsh, pageDto({ items: [timelineItem()], hasMore: false }));
  await runTabEffects(); // effect 手动驱动 load(offset)
  await flush();
  assert.deepEqual(calls, [{ offset: 20, limit: 20 }], "下一页以 offset=20（每页 20 条）请求");
  const next2 = findButtons(tree, "下一页")[0];
  assert.ok(next2 && next2.props.disabled === true, "末页禁用下一页");
});

// ---------------------------------------------------------------------------
// c) scanLimited / skippedCorrupted 提示
// ---------------------------------------------------------------------------

test("F4 scanLimited=true：列表顶部提示「只扫描了最近 N 个文件，更早的变更不可见」", async () => {
  const { renderTab } = await mountTimelineTab();
  const page = pageDto({ items: [timelineItem()], scanLimited: true });
  const tree = renderTab({ call: async () => page }, page);
  const text = collectText(tree);
  assert.match(text, /只扫描了最近 4000 个文件，更早的变更不可见/, "扫描截断提示出现（N 与 TIMELINE_JOURNAL_SCAN_LIMIT 同步）");
});

test("F4 scanLimited=false：不出现扫描截断提示；skippedCorrupted 如实显示", async () => {
  const { renderTab } = await mountTimelineTab();
  let tree = renderTab({ call: async () => pageDto({ items: [timelineItem()] }) }, pageDto({ items: [timelineItem()] }));
  assert.ok(!collectText(tree).includes("只扫描了最近"), "无截断提示");
  tree = renderTab(
    { call: async () => pageDto({ items: [timelineItem()], skippedCorrupted: 3 }) },
    pageDto({ items: [timelineItem()], skippedCorrupted: 3 }),
  );
  assert.ok(collectText(tree).includes("3 条损坏记录已跳过"), "损坏记录数如实显示");
});

// ---------------------------------------------------------------------------
// d) 空状态
// ---------------------------------------------------------------------------

test("F4 空状态：给引导文案（怎么产生第一条变更），不留白也不报错", async () => {
  const { renderTab } = await mountTimelineTab();
  const tree = renderTab({ call: async () => pageDto() }, pageDto());
  const text = collectText(tree);
  assert.ok(text.includes("还没有任何变更记录"), "空状态文案出现");
  assert.ok(text.includes("刷新"), "引导里有刷新入口");
  assert.equal(findButtons(tree, "下一页").length, 0, "空列表不渲染分页按钮");
});

// ---------------------------------------------------------------------------
// e) 跳转：专题 → 专题 tab、卡片 → 图谱 tab、core 不跳
// ---------------------------------------------------------------------------

test("F4 跳转：专题条目「定位」回调 onJump(topic,id)，卡片回调 onJump(spark,id)", async () => {
  const { renderTab } = await mountTimelineTab();
  const jumps = [];
  const page = pageDto({
    items: [
      timelineItem({ action: "topic.write", target: { type: "topic", id: "daily", title: null } }),
      timelineItem({ action: "spark.save", target: { type: "spark", id: "abcd1234abcd1234abcd", title: "会议纪要" } }),
    ],
  });
  const tree = renderTab({ call: async () => page }, page, { onJump: (type, id) => jumps.push([type, id]) });
  const jumps2 = flattenVNode(tree).filter((n) => n.type === "button" && collectText(n) === "定位");
  assert.equal(jumps2.length, 2, "topic / spark 两条都可定位");
  jumps2[0].props.onClick();
  jumps2[1].props.onClick();
  assert.deepEqual(jumps, [["topic", "daily"], ["spark", "abcd1234abcd1234abcd"]], "onJump 收到 (type,id)");
});

test("F4 跳转：core 条目不提供「定位」（核心记忆无对应 tab，提示去记忆页查看）", async () => {
  const { renderTab } = await mountTimelineTab();
  const jumps = [];
  const page = pageDto({
    items: [timelineItem({ action: "core.write", target: { type: "core", id: "CORE", title: null } })],
  });
  const tree = renderTab({ call: async () => page }, page, { onJump: (type, id) => jumps.push([type, id]) });
  assert.equal(findButtons(tree, "定位").length, 0, "core 条目无定位按钮");
  assert.ok(collectText(tree).includes("记忆内容"), "提示核心记忆去「记忆内容」页查看");
  assert.equal(jumps.length, 0);
});
