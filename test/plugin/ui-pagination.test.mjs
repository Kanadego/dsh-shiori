// S4 分页与脱敏测试（0.4）。证据级别与 ui-0.3.test.mjs 相同：真实执行
// client/index.js（fake window.__ModuleLoader__ + 有状态 react stub + 真实宿主
// zod 经绝对 file URL 导入），synthetic 渲染树，非浏览器实机。
// 覆盖：①最近变更（显示层每页 10 条、页码可点、跨批回退缓存命中不发请求、
// wire 仍 limit=20）②遗忘→专题索引导航 ③专题页 topic 列表 ④闪回「从未命中」
// ⑤候选列表 —— 每页 10 条、统一页码条、状态可回退；脱敏函数（机器串不进正文）。

import { test } from "node:test";
import assert from "node:assert/strict";
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
// harness（照 ui-0.3.test.mjs：有状态 react stub + 真实 slot 渲染定位 tab）
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
    useMemo: (factory) => factory(),
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

function findButton(tree, label) {
  return flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === label) || null;
}

function findButtons(tree, label) {
  return flattenVNode(tree).filter((n) => n.type === "button" && collectText(n) === label);
}

function pageNumButtons(tree) {
  return flattenVNode(tree).filter((n) => n.type === "button" && String(n.props.className || "").includes("dshi_pageNum"));
}

async function mountTabById(tabId, tabName) {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => async () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push(tabId, "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const tab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === tabName);
  assert.ok(tab, tabName + " reached through real slot render");
  const renderTab = (dsh, sessionId = "session-A", options = {}) => {
    host.cursor.v = 0;
    host.runEffects.v = Boolean(options.effects);
    return tab.type({ dsh, sessionId });
  };
  return { host, renderTab };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function timelineItem(index) {
  return {
    at: "2026-11-01T10:30:00.000Z",
    action: "spark.save",
    source: "spark",
    scope: "amber",
    target: { type: "spark", id: "card-" + String(index).padStart(2, "0"), title: "卡片" + index },
    detail: {},
  };
}

function topicRow(index, extra = {}) {
  return Object.assign({
    key: "topic-" + String(index).padStart(2, "0"),
    title: "主题" + index,
    summary: "摘要" + index,
    updated: "2026-11-01T10:00:00.000Z",
    revision: "shiori-r1.a.b",
    chars: 10,
    bytes: 20,
  }, extra);
}

// ---------------------------------------------------------------------------
// ① 最近变更：显示层每页 10 条（wire 仍整批 20），页码可点、状态可回退
// ---------------------------------------------------------------------------

test("最近变更：12 条一批显示两页——第 1 页 10 条、页码条统一、翻页不发请求、翻回不丢数据", async () => {
  const { host, renderTab } = await mountTabById("timeline", "TimelineTab");
  const calls = [];
  const batch0 = { scope: "amber", items: Array.from({ length: 12 }, (_, i) => timelineItem(i)), hasMore: false, skippedCorrupted: 0, scanLimited: false };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      return batch0;
    },
  };
  host.states.length = 0;
  let tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  const visibleTitles = (t) => flattenVNode(t).filter((n) => n.type === "div" && String(n.props.className || "") === "dshi_item").length;
  assert.equal(visibleTitles(tree), 10, "第 1 页只显示 10 条（每批取 20、显示切 10）");
  const pages = pageNumButtons(tree);
  assert.deepEqual(pages.map((p) => collectText(p)), ["1", "2"], "页码条渲染 1..2");
  assert.equal(pages[0].props.disabled, true, "当前页页码禁用（不重复触发）");
  assert.ok(collectText(tree).includes("第 1 / 2 页 · 界面每页显示 10 条"), "页脚给用户看的口径在前");
  assert.ok(collectText(tree).includes("（每页 20 条）"), "冻结文案字面保留（弱化在最后）");
  // 页码 2 可点：纯本地切片，不发请求。
  const callsBefore = calls.length;
  pages[1].props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.equal(visibleTitles(tree), 2, "第 2 页显示余下 2 条");
  assert.equal(calls.length, callsBefore, "批内翻页不发请求");
  assert.ok(collectText(tree).includes("第 2 / 2 页 · 界面每页显示 10 条"), "页码状态可回退（页号跟随）");
  // 上一页翻回第 1 页：同样本地、数据不丢。
  findButton(tree, "上一页").props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.equal(visibleTitles(tree), 10, "翻回第 1 页仍是 10 条（状态可回退）");
  assert.ok(collectText(tree).includes("卡片0") && collectText(tree).includes("卡片9"), "第 1 页条目正确");
});

test("最近变更：跨批回退命中本地缓存不重复请求；未命中才发请求（limit 仍 20）", async () => {
  const { host, renderTab } = await mountTabById("timeline", "TimelineTab");
  const calls = [];
  const makeBatch = (offset, count, hasMore) => ({
    scope: "amber",
    items: Array.from({ length: count }, (_, i) => timelineItem(offset + i)),
    hasMore,
    skippedCorrupted: 0,
    scanLimited: false,
  });
  // 批 0 给满 20 条（hasMore 时服务端整批返回），批 1 给 5 条收尾。
  const batches = { 0: makeBatch(0, 20, true), 20: makeBatch(20, 5, false) };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      return batches[payload.offset];
    },
  };
  host.states.length = 0;
  let tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  const itemRows = (t) => flattenVNode(t).filter((n) => n.type === "div" && String(n.props.className || "") === "dshi_item");
  assert.deepEqual(calls, [{ offset: 0, limit: 20 }], "首页整批 20 条");
  // 第一次下一页：批 0 有 20 条 → 批内子页（第 2 页），本地切片不发请求。
  findButton(tree, "下一页").props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.equal(calls.length, 1, "批内子页不发请求");
  assert.equal(itemRows(tree).length, 10, "第 2 页 = 批 0 的后 10 条");
  // 第二次下一页：跨批发请求 offset=20/limit=20（wire 不改）。
  findButton(tree, "下一页").props.onClick();
  tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  assert.deepEqual(calls, [{ offset: 0, limit: 20 }, { offset: 20, limit: 20 }], "跨批下一页发 offset=20/limit=20（wire 不改）");
  assert.equal(pageNumButtons(tree).map((p) => collectText(p)).join(","), "1,2,3", "显示到第 3 页");
  assert.ok(collectText(tree).includes("第 3 / 3 页"), "绝对页号 = offset/10 + 子页 + 1");
  // 回退第 2 页：目标批（批 0）在缓存里 → 命中缓存不发请求。
  const callsBefore = calls.length;
  pageNumButtons(tree)[1].props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.equal(calls.length, callsBefore, "跨批回退命中缓存不重复请求");
  assert.equal(itemRows(tree).length, 10, "缓存批的第 2 页 10 条照常显示");
  assert.ok(collectText(tree).includes("卡片10") && collectText(tree).includes("卡片19"), "缓存批条目正确");
  // 再回第 1 页：同批子页 → 本地切子页。
  tree = renderTab(dsh, "session-A");
  pageNumButtons(tree)[0].props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.equal(calls.length, callsBefore, "同批回退不发请求");
  assert.equal(itemRows(tree).length, 10, "第 1 页 10 条");
  assert.ok(collectText(tree).includes("卡片0") && !collectText(tree).includes("卡片10"), "第 1 页条目正确");
});

test("最近变更：缓存命中回退后点「刷新」，再翻第 3 页不得把批0 串页成批1（评审 rework 阻塞 3 回归）", async () => {
  const { host, renderTab } = await mountTabById("timeline", "TimelineTab");
  const calls = [];
  const makeBatch = (offset, count, hasMore) => ({
    scope: "amber",
    items: Array.from({ length: count }, (_, i) => timelineItem(offset + i)),
    hasMore,
    skippedCorrupted: 0,
    scanLimited: false,
  });
  const batches = { 0: makeBatch(0, 20, true), 20: makeBatch(20, 5, false) };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      return batches[payload.offset];
    },
  };
  // 复现路径：批0 → 下一页×2 到第 3 页（跨批发请求）→ 回退第 2 页（命中缓存，
  // 页面显示批0、offset 同步为 0）→ 点「刷新」→ 点第 3 页。
  host.states.length = 0;
  let tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  findButton(tree, "下一页").props.onClick();
  tree = renderTab(dsh, "session-A");
  findButton(tree, "下一页").props.onClick();
  tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  assert.deepEqual(calls, [{ offset: 0, limit: 20 }, { offset: 20, limit: 20 }], "前置：批0 → 批1");
  pageNumButtons(tree)[1].props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.ok(collectText(tree).includes("卡片10") && collectText(tree).includes("卡片19"), "回退第 2 页命中缓存显示批0");
  // 点「刷新」：重拉当前批0。缓存键 = 当前 offset 状态（0），与页面内容一致，
  // 不会把批0 错标成批20 再被当成另一批命中。
  findButton(tree, "刷新").props.onClick();
  await flush();
  tree = renderTab(dsh, "session-A");
  assert.deepEqual(calls[2], { offset: 0, limit: 20 }, "刷新重拉当前批0");
  // 再点第 3 页：目标批（批20）不在缓存 → 必须走真实请求并显示批1 内容；
  // 若缓存被污染（批0 冒充批20），这里会不发包且显示卡片0..——两种都断言拦下。
  pageNumButtons(tree)[2].props.onClick();
  tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  const itemRows = () => flattenVNode(tree).filter((n) => n.type === "div" && String(n.props.className || "") === "dshi_item");
  assert.deepEqual(calls[3], { offset: 20, limit: 20 }, "第 3 页走真实请求取批1（缓存未串页才会未命中）");
  assert.equal(itemRows().length, 5, "第 3 页显示批1 的 5 条");
  assert.ok(collectText(tree).includes("卡片20") && collectText(tree).includes("卡片24"), "第 3 页内容来自批1");
  assert.equal(collectText(tree).includes("卡片0"), false, "批0 内容不得冒充第 3 页（串页回归）");
});

test("最近变更：切会话后回退一页不得回放前一会话的缓存条目（评审 attempt-3 阻塞 A）", async () => {
  const { host, renderTab } = await mountTabById("timeline", "TimelineTab");
  const calls = [];
  const makeItem = (session, index) => ({
    at: "2026-11-01T10:30:00.000Z",
    action: "spark.save",
    source: "spark",
    scope: "amber",
    target: { type: "spark", id: "card-" + String(index).padStart(2, "0"), title: (session === "session-A" ? "A卡" : "B卡") + index },
    detail: {},
  });
  const makeBatch = (session, offset, count, hasMore) => ({
    scope: "amber",
    items: Array.from({ length: count }, (_, i) => makeItem(session, offset + i)),
    hasMore,
    skippedCorrupted: 0,
    scanLimited: false,
  });
  // 两个会话各自有批0（20 条）与批20（5 条）：数据按 (session, offset) 取。
  const data = {
    "session-A": { 0: makeBatch("session-A", 0, 20, true), 20: makeBatch("session-A", 20, 5, false) },
    "session-B": { 0: makeBatch("session-B", 0, 20, true), 20: makeBatch("session-B", 20, 5, false) },
  };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ session, offset: payload.offset, limit: payload.limit });
      return data[session][payload.offset];
    },
  };
  // 会话A：批0 → 下一页×2 到批20（批0 进缓存）。
  host.states.length = 0;
  let tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  findButton(tree, "下一页").props.onClick();
  tree = renderTab(dsh, "session-A");
  findButton(tree, "下一页").props.onClick();
  tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  assert.deepEqual(calls, [
    { session: "session-A", offset: 0, limit: 20 },
    { session: "session-A", offset: 20, limit: 20 },
  ], "前置：会话A 批0 → 批20，批0 进缓存");
  // 切会话B：effect 按保留的 offset 重拉 B 的批20。
  tree = renderTab(dsh, "session-B", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-B");
  assert.deepEqual(calls[2], { session: "session-B", offset: 20, limit: 20 }, "切会话重拉 B 的当前批");
  // 点第 1 页：目标批0 的缓存条目属于会话A → 不得命中。先 render 一次、不跑
  // effect，断言「点击那一瞬」的树：若缓存被错误命中（变异：去掉 sessionId
  // 字段/校验），命中分支会 setPage(A批0)，树里立刻出现 A 条目、本断言当场变红；
  // effect 稍后重拉的真实请求会把树覆盖回 B 数据，只看最终树抓不到那一瞬。
  pageNumButtons(tree)[0].props.onClick();
  tree = renderTab(dsh, "session-B");
  assert.equal(collectText(tree).includes("A卡"), false, "点击回退那一瞬不得回放会话A 条目（变异自证：去掉 sessionId 校验此断言变红）");
  // 随后 effect 发真实请求取 B 批0 并覆盖显示。
  tree = renderTab(dsh, "session-B", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-B");
  assert.deepEqual(calls[3], { session: "session-B", offset: 0, limit: 20 }, "前会话的缓存条目不命中：走真实请求取 B 批0");
  assert.ok(collectText(tree).includes("B卡0") && collectText(tree).includes("B卡9"), "第 1 页显示会话B 自己的条目");
  assert.equal(collectText(tree).includes("A卡"), false, "不得回放会话A 的条目（跨会话串页回归）");
});

// ---------------------------------------------------------------------------
// ③ 专题页 topic 列表：每页 10 条；筛选后页码钳回、不渲染空页
// ---------------------------------------------------------------------------

test("专题页：12 个主题分两页（每页 10 条）；第 2 页翻回第 1 页数据不丢；搜索后页码钳回不空白", async () => {
  const { host, renderTab } = await mountTabById("topics", "TopicsTab");
  const topics = Array.from({ length: 12 }, (_, i) => topicRow(i, { updated: "2026-11-" + String(12 - i).padStart(2, "0") + "T10:00:00.000Z" }));
  const dsh = {
    call: async (method, session, payload) => {
      if (payload && payload.name === "memory_list_topics") return { topics };
      return {};
    },
  };
  host.states.length = 0;
  let tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  const itemRows = () => flattenVNode(tree).filter((n) => n.type === "div" && String(n.props.className || "") === "dshi_item");
  assert.equal(itemRows().length, 10, "第 1 页 10 条");
  assert.deepEqual(pageNumButtons(tree).map((p) => collectText(p)), ["1", "2"], "页码 1..2");
  assert.ok(collectText(tree).includes("共 12 个主题"), "原有计数提示不动");
  pageNumButtons(tree)[1].props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.equal(itemRows().length, 2, "第 2 页 2 条");
  // 搜索把可见列表压到 3 条：页码钳回第 1 页，绝不渲染空页。
  const search = flattenVNode(tree).find((n) => n.type === "input" && String(n.props.placeholder || "").includes("搜索"));
  search.props.onChange({ target: { value: "主题1" } });
  tree = renderTab(dsh, "session-A");
  assert.equal(itemRows().length, 3, "筛选后 3 条全部可见（页码钳回）");
  assert.ok(collectText(tree).includes("显示 3/12 个主题"), "筛选计数提示保留");
  // 清空搜索 → 回到全量列表；页码记忆保留（第 2 页 2 条，状态可回退、不空白）。
  search.props.onChange({ target: { value: "" } });
  tree = renderTab(dsh, "session-A");
  assert.equal(itemRows().length, 2, "清空搜索回到记忆中的第 2 页（2 条，不空白）");
  assert.deepEqual(pageNumButtons(tree).map((p) => collectText(p)), ["1", "2"], "页码条恢复 1..2");
});

// ---------------------------------------------------------------------------
// ④ 闪回「从未命中」：每页 5 条（13-5 起与最近命中同口径）
// ---------------------------------------------------------------------------

test("闪回命中：13 张从未命中卡分三页（每页 5 条），页码可点、翻回不丢", async () => {
  const { host, renderTab } = await mountTabById("flashbacks", "FlashbacksTab");
  const nodes = Array.from({ length: 13 }, (_, i) => ({
    id: "s-" + String(i).padStart(2, "0"),
    title: "未命中卡" + i,
    summary: null, vitality: "evergreen", revision: 1,
    hitCount: 0, lastHitAt: null,
    createdAt: new Date(Date.parse("2026-11-01T00:00:00.000Z") - i * 86400000).toISOString(),
  }));
  const graph = { nodes, edges: [], deliveries: [], deliveryStats: { totalDelivered: 0, uniqueCards: 0, rounds: 0 } };
  const dsh = {
    call: async (method, session, payload) => {
      if (method === "getStatus") return { mode: "active", configured: true, capabilities: { l2: true, organize: true, forgetting: true, tools: true, sections: true }, diagnostics: {} };
      if (method === "getGraph") return graph;
      return {};
    },
  };
  host.states.length = 0;
  let tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  tree = renderTab(dsh, "session-A");
  const neverHitRows = () => flattenVNode(tree).filter((n) => n.type === "div" && String(n.props.className || "") === "dshi_item"
    && collectText(n).includes("存续"));
  assert.equal(neverHitRows().length, 5, "从未命中第 1 页 5 张");
  assert.deepEqual(pageNumButtons(tree).map((p) => collectText(p)), ["1", "2", "3"], "页码 1..3（13 ÷ 5）");
  assert.ok(collectText(tree).includes("从未命中（13 张）"), "总数照常显示");
  assert.ok(collectText(tree).includes("第 1 / 3 页（每页 5 条）"), "页码口径改为每页 5 条（全局 LIST_PAGE_SIZE 不动）");
  pageNumButtons(tree)[1].props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.equal(neverHitRows().length, 5, "第 2 页 5 张");
  pageNumButtons(tree)[2].props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.equal(neverHitRows().length, 3, "第 3 页 3 张（13 = 5+5+3）");
  findButton(tree, "上一页").props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.equal(neverHitRows().length, 5, "翻回第 2 页（状态可回退）");
});

// ---------------------------------------------------------------------------
// ② 遗忘→专题索引导航：每页 10 条 + 机器串脱敏
// ---------------------------------------------------------------------------

const MACHINE_UPDATED = "2026-11-05T09:56:36.451Z";
const MACHINE_REVISION = "shiori-r1.eyJhbWJlciI6InBlcnNvbmEifQ.0123456789abcdef0123456789abcdef0123456789";

async function mountCandidatesWithTopics(topics) {
  const { host, renderTab } = await mountTabById("candidates", "CandidatesTab");
  const data = { queueRevision: 5, items: [], plans: [] };
  host.states.length = 0;
  host.states.push(data, null, false, "", null, null, { sessionId: "session-A", gen: 0 });
  const dsh = {
    call: async (method, session, payload) => {
      if (method === "listCandidates") return data;
      if (method === "executeTool" && payload.name === "memory_list_topics") return { topics };
      return {};
    },
  };
  const render = () => {
    host.cursor.v = 0;
    host.runEffects.v = false;
    return renderTab(dsh, "session-A");
  };
  return { host, render };
}

test("专题索引导航：12 篇分两页（每页 10 条）；页码可点、翻回不丢", async () => {
  const topics = Array.from({ length: 12 }, (_, i) => topicRow(i, {
    updated: "2026-11-" + String(20 - i).padStart(2, "0") + "T10:00:00.000Z",
  }));
  const { render } = await mountCandidatesWithTopics(topics);
  let tree = render();
  findButton(tree, "载入 / 刷新专题").props.onClick();
  await flush();
  tree = render();
  const archiveRows = () => flattenVNode(flattenVNode(tree).find((n) => n.type === "div" && collectText(n).includes("专题索引归档")))
    .filter((n) => n.type === "div" && String(n.props.className || "") === "dshi_item");
  assert.equal(archiveRows().length, 10, "第 1 页 10 篇");
  assert.deepEqual(pageNumButtons(tree).map((p) => collectText(p)), ["1", "2"], "页码 1..2");
  assert.ok(collectText(tree).includes("未归档 12 篇，共 12 篇"), "计数提示保留");
  pageNumButtons(tree)[1].props.onClick();
  tree = render();
  assert.equal(archiveRows().length, 2, "第 2 页 2 篇");
  findButton(tree, "上一页").props.onClick();
  tree = render();
  assert.equal(archiveRows().length, 10, "翻回第 1 页（状态可回退）");
});

test("脱敏：updated 时间戳 + rev token 不进正文——只显示友好日期，原始串整体在 title 属性", async () => {
  const topics = [
    { key: "t-machine", title: "带机器串", summary: "s", updated: MACHINE_UPDATED, revision: MACHINE_REVISION },
    { key: "t-nodate", title: "无日期", summary: "s", updated: "not-a-date", revision: MACHINE_REVISION },
    { key: "t-missing", title: "缺字段", summary: "s", updated: "", revision: "" },
  ];
  const { render } = await mountCandidatesWithTopics(topics);
  let tree = render();
  findButton(tree, "载入 / 刷新专题").props.onClick();
  await flush();
  tree = render();
  const rowOf = (key) => flattenVNode(tree).find((n) => n.type === "div" && n.props.key === key);
  const machineRow = rowOf("t-machine");
  assert.ok(machineRow, "机器串行渲染");
  const rowText = collectText(machineRow);
  assert.ok(rowText.includes("2026-11-05"), "友好日期可见");
  assert.ok(!rowText.includes("T09:56"), "时间部分不进正文");
  assert.ok(!rowText.includes("shiori-r1"), "revision token 不进正文");
  assert.ok(!rowText.includes("rev "), "rev 前缀不进正文");
  const dateSpan = flattenVNode(machineRow).find((n) => n.props && n.props.title && String(n.props.title).includes("shiori-r1"));
  assert.ok(dateSpan, "原始串所在节点存在");
  assert.equal(dateSpan.props.title, MACHINE_UPDATED + " rev " + MACHINE_REVISION, "原始机器串完整进 title（updated + rev + token）");
  assert.equal(collectText(dateSpan), "2026-11-05", "该节点正文只有友好日期");
  // 非日期前缀 / 缺字段：不炸、显示占位。
  assert.equal(collectText(rowOf("t-nodate")).includes("—"), true, "非日期 updated 显示 —（原始串在 title）");
  assert.ok(rowOf("t-missing"), "缺字段行照常渲染");
});

// ---------------------------------------------------------------------------
// ⑤ 候选列表：每页 10 条（统一口径）
// ---------------------------------------------------------------------------

test("候选列表：12 条待审分两页（每页 10 条）；页码可点、翻回不丢", async () => {
  const { host, renderTab } = await mountTabById("candidates", "CandidatesTab");
  const data = {
    queueRevision: 5,
    items: Array.from({ length: 12 }, (_, i) => ({
      candidate: {
        id: "card-" + String(i).padStart(2, "0"),
        kind: "isolated",
        scopeId: "default",
        sources: [{ id: "card-" + String(i).padStart(2, "0") }],
        evidence: { ignoredRetiredTargets: [] },
      },
      status: "pending",
    })),
    plans: [],
  };
  host.states.length = 0;
  host.states.push(data, null, false, "", null, null, { sessionId: "session-A", gen: 0 });
  const graph = { nodes: data.items.map((it, i) => ({ id: it.candidate.id, title: "孤卡" + i })), edges: [] };
  const dsh = {
    call: async (method, session, payload) => {
      if (method === "listCandidates") return data;
      if (method === "getGraph") return graph;
      return {};
    },
  };
  const render = () => {
    host.cursor.v = 0;
    host.runEffects.v = false;
    return renderTab(dsh, "session-A");
  };
  let tree = render();
  // 候选行不依赖额外拉取（标题映射拉不到就退化短 id），列表立即可见。
  const candidateRows = () => flattenVNode(flattenVNode(tree).find((n) => n.type === "div" && collectText(n).includes("候选（")))
    .filter((n) => n.type === "div" && String(n.props.className || "") === "dshi_item");
  assert.equal(candidateRows().length, 10, "候选第 1 页 10 条");
  assert.deepEqual(pageNumButtons(tree).map((p) => collectText(p)), ["1", "2"], "页码 1..2");
  pageNumButtons(tree)[1].props.onClick();
  tree = render();
  assert.equal(candidateRows().length, 2, "候选第 2 页 2 条");
  findButton(tree, "上一页").props.onClick();
  tree = render();
  assert.equal(candidateRows().length, 10, "翻回第 1 页（状态可回退）");
});
