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

function countTimelineItems(tree) {
  return flattenVNode(tree).filter((n) => n.props && n.props.className === "dshi_item").length;
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

test("F4 分页：界面每页 10 条（0.4）——首页整批请求 limit=20 只显示前 10 条；批内「下一页」纯本地不发请求；跨批才以 offset=20 请求下一批", async () => {
  const { host, renderTab, runTabEffects } = await mountTimelineTab();
  const calls = [];
  // 整批 20 条（一批 = 两个显示页）；第二批 hasMore=false 供末页禁用断言。
  const items = Array.from({ length: 20 }, (_, i) =>
    timelineItem({ target: { type: "spark", id: "abcd1234abcd1234abcd", title: "批内条目-" + String(i).padStart(2, "0") } }));
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      return pageDto({ items, hasMore: payload.offset === 0 });
    },
  };
  let tree = renderTab(dsh); // page=null → effect load(offset=0)
  await runTabEffects(); // effect 手动驱动 load(offset)
  await flush();
  assert.deepEqual(calls, [{ offset: 0, limit: 20 }], "首页仍整批请求 limit=20（wire 协议不变）");
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  assert.equal(countTimelineItems(tree), 10, "界面每页只显示 10 条（0.4 显示层分页）");
  let text = collectText(tree);
  assert.ok(text.includes("批内条目-00"), "首页显示第 1 条");
  assert.ok(!text.includes("批内条目-10"), "首页不显示第 11 条");
  assert.ok(text.includes("界面每页显示 10 条"), "页脚文案跟随界面每页 10 条");
  host.effects.length = 0; // 渲染收集到的 load effect 不重放；批内翻页不应发请求

  // 批内翻页：本地切片，不发请求
  const next = findButtons(tree, "下一页")[0];
  assert.ok(next && next.props.disabled !== true, "有本地下一页 → 下一页可用");
  next.props.onClick();
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  host.effects.length = 0;
  assert.deepEqual(calls, [{ offset: 0, limit: 20 }], "批内「下一页」纯本地切片，不发 RPC");
  assert.equal(countTimelineItems(tree), 10, "第二显示页仍每页 10 条");
  text = collectText(tree);
  assert.ok(text.includes("批内条目-10"), "第二显示页展示第 11 条");
  assert.ok(!text.includes("批内条目-00"), "第二显示页不再展示第 1 条");

  // 跨批：再点一次「下一页」才以 offset=20 请求下一批（第二批 hasMore=false）
  const next2 = findButtons(tree, "下一页")[0];
  assert.ok(next2 && next2.props.disabled !== true, "批内页耗尽 → 下一页仍可用");
  next2.props.onClick();
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  await runTabEffects(); // effect 手动驱动 load(offset)
  await flush();
  assert.deepEqual(calls, [{ offset: 0, limit: 20 }, { offset: 20, limit: 20 }], "跨批翻页以 offset=20（整批 20 条）请求");
  // 末页语义不回归：末批两条本地显示页耗尽且 hasMore=false → 下一页禁用
  host.effects.length = 0;
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  const nextLocal = findButtons(tree, "下一页")[0];
  assert.ok(nextLocal && nextLocal.props.disabled !== true, "末批仍有本地下一页");
  nextLocal.props.onClick();
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  host.effects.length = 0;
  const nextEnd = findButtons(tree, "下一页")[0];
  assert.ok(nextEnd && nextEnd.props.disabled === true, "末批末页（无本地下一页 + hasMore=false）→ 下一页禁用");
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

// ---------------------------------------------------------------------------
// f) 空批回退（0.4-REVIEW §2.4 问题 1 / P1#6；评审 attempt-2 阻塞 1/2、需给证 3）
//    编号 ①-⑤ 按本节用例在文件中的顺序：①=逐批回退、②=hasMore 空批不回退、
//    ③=offset=0 空态、④=回退在飞 busy、⑤=批缓存不写。退化实验留痕（改坏 → 变
//    红，均实测）：
//    A. 回退条件加 && false → ①④⑤ 三条红（④=在飞 busy、⑤=缓存给证）；
//    B. 回退改回递归 return load()（阻塞 1 原 bug）→ ①④⑤ 三条红（④=busy 在飞被提前复位）；
//    C. 去掉缓存守卫 !fellBack → ⑤ 红（batchCache 被写入 offset=40 的陈旧批）。
//    （②③ 在三种变异下都仍绿，作回归对照。）
// ---------------------------------------------------------------------------

test("F4 空批回退：offset>0 拉回空批 → 逐批回退（40→20→0），非空批即停", async () => {
  const { host, renderTab, runTabEffects } = await mountTimelineTab();
  const calls = [];
  const batches = {
    0: pageDto({ items: [timelineItem()], hasMore: false }),
    20: pageDto(),
    40: pageDto(),
  };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      return batches[payload.offset];
    },
  };
  host.states[PANEL_STATES + 1] = 40; // 预置 offset=40（用户已翻到第 5 显示页）
  let tree = renderTab(dsh);
  await runTabEffects();
  await flush();
  assert.deepEqual(calls, [
    { offset: 40, limit: 20 },
    { offset: 20, limit: 20 },
    { offset: 0, limit: 20 },
  ], "空批逐批回退：40→20→0，恰 3 次请求（空批不等于结束）");
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  assert.equal(countTimelineItems(tree), 1, "回退到非空批即停，渲染批0 内容");
  assert.equal(host.states[PANEL_STATES + 1], 0, "offset 状态同步为落地批");
});

test("F4 空批回退：hasMore===true 的空批不回退（不与服务端「还有更多」打架）", async () => {
  const { host, renderTab, runTabEffects } = await mountTimelineTab();
  const calls = [];
  const batches = {
    0: pageDto({ items: [timelineItem()], hasMore: false }),
    20: pageDto({ hasMore: true }), // 空批但服务端声明还有更多：防御异常 DTO，不回退
  };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      return batches[payload.offset];
    },
  };
  host.states[PANEL_STATES + 1] = 20;
  let tree = renderTab(dsh);
  await runTabEffects();
  await flush();
  assert.deepEqual(calls, [{ offset: 20, limit: 20 }], "hasMore===true 空批恰 1 次请求，不回退");
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  assert.equal(countTimelineItems(tree), 0, "hasMore 空批照旧落地渲染（0 条）");
});

test("F4 空批回退：offset=0 空批照旧渲染空态引导文案（不回退、不发多余请求）", async () => {
  const { host, renderTab, runTabEffects } = await mountTimelineTab();
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      return pageDto();
    },
  };
  let tree = renderTab(dsh);
  await runTabEffects();
  await flush();
  assert.deepEqual(calls, [{ offset: 0, limit: 20 }], "首页空批恰 1 次请求（不回退到负 offset）");
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  assert.ok(collectText(tree).includes("还没有任何变更记录"), "空态引导文案照旧");
  assert.equal(findButtons(tree, "下一页").length, 0, "空态不渲染分页条");
});

test("F4 空批回退：回退在飞期间 busy 仍为 true、「刷新」仍禁点（评审 attempt-2 阻塞 1 能红证据）", async () => {
  const { host, renderTab } = await mountTimelineTab();
  const calls = [];
  let resolveFallback;
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      if (payload.offset === 40) return pageDto(); // 空批 → 立即触发回退
      if (payload.offset === 20) {
        return new Promise((resolve) => { resolveFallback = resolve; }); // 回退批挂起（在飞）
      }
      return pageDto({ items: [timelineItem()], hasMore: false });
    },
  };
  host.states[PANEL_STATES + 1] = 40;
  renderTab(dsh);
  const effectPromise = (async () => { for (const fn of host.effects.splice(0)) await fn(); })();
  await flush(); // 第一轮（空批）落地，第二轮（offset=20）在飞
  assert.deepEqual(calls, [{ offset: 40, limit: 20 }, { offset: 20, limit: 20 }], "前置：空批已触发回退且回退请求在飞");
  let tree = renderTab(dsh, host.states[PANEL_STATES]);
  const refreshing = findButtons(tree, "刷新中…")[0];
  assert.ok(refreshing, "回退在飞：按钮处于「刷新中…」（busy 仍为 true，未被提前复位）");
  assert.equal(refreshing.props.disabled, true, "回退在飞：刷新禁点（不能并发第二次 load）");
  resolveFallback(pageDto({ items: [timelineItem()], hasMore: false })); // 落地：busy 才复位
  await effectPromise;
  await flush();
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  assert.equal(countTimelineItems(tree), 1, "回退落地显示非空批");
  const refresh = findButtons(tree, "刷新")[0];
  assert.ok(refresh && refresh.props.disabled !== true, "落地后刷新恢复可点");
});

test("F4 空批回退：回退链不把空批/已判空批次写入批缓存（评审 attempt-2 需给证 3）", async () => {
  const { host, renderTab, runTabEffects } = await mountTimelineTab();
  const calls = [];
  const stage = { phase: "initial" };
  const batch40Full = pageDto({ items: [timelineItem(), timelineItem()], hasMore: false });
  const batch40Empty = pageDto(); // 数据收缩后批40 已空
  const batch20 = pageDto({ items: [timelineItem()], hasMore: false });
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      if (stage.phase === "refresh") return payload.offset === 40 ? batch40Empty : batch20;
      return batch40Full;
    },
  };
  host.states[PANEL_STATES + 1] = 40;
  let tree = renderTab(dsh);
  await runTabEffects();
  await flush();
  assert.deepEqual(calls, [{ offset: 40, limit: 20 }], "前置：批40 非空落地，lastLoadedOffset=40");
  assert.equal(host.states[PANEL_STATES + 6], null, "前置：无换批 → 批缓存仍为 null");
  // 评审给证链：在 offset=40 点「刷新」→ 拉回空批 → 回退 20
  stage.phase = "refresh";
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  findButtons(tree, "刷新")[0].props.onClick();
  await flush();
  assert.deepEqual(calls, [
    { offset: 40, limit: 20 },
    { offset: 40, limit: 20 },
    { offset: 20, limit: 20 },
  ], "刷新拉批40（空批）→ 回退拉批20");
  // 关键断言：回退链上批缓存必须仍是 null（空批与已判空批次的陈旧内容都不得入缓存）
  assert.equal(host.states[PANEL_STATES + 6], null, "回退链不写批缓存（cache 仍为 null）");
  tree = renderTab(dsh, host.states[PANEL_STATES]);
  assert.equal(countTimelineItems(tree), 1, "回退落地批20 非空");
  assert.equal(host.states[PANEL_STATES + 1], 20, "offset 同步为落地批 20");
});
