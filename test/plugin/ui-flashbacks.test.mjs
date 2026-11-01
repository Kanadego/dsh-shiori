// F2 闪回命中可见性测试。证据级别如实标注：
//   - client/index.js：真实执行（fake window.__ModuleLoader__ + 有状态 stub react +
//     真实宿主 zod 经绝对 file URL 导入）——synthetic host ctx，非浏览器实机；
//   - src/plugin/management.mjs：真实模块逻辑 + 合成 deps（sparkStore / l2 账本
//     为内存 fixture，不触盘）；
//   - 控制器 preStepHandler → finalizeDelivery 的 hitMeta 富化路径需要完整宿主
//     bindings 装配，本文件未覆盖（见交付 note「哪里没把握」）。

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

// 宿主 zod（真实 0.2.1-rc.2 安装树内 zod）。
const zod = await import(`file:///${HOST_MODULES}/zod/index.js`);

// ---------------------------------------------------------------------------
// 通用：加载 bundle + 有状态 react stub（与 test/plugin/client.test.mjs 同款）
// ---------------------------------------------------------------------------

const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
await import(pathToFileURL(join(WORKQ, "client", "index.js")).href);

function makeStatefulReact() {
  const states = [];
  const cursor = { v: 0 };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: "fragment",
    useState: (initial) => {
      const i = cursor.v++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; }];
    },
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  };
  return { react, states, cursor };
}

function loadModule(host) {
  assert.equal(registrations.length, 1, "bundle registers exactly once");
  return registrations[0].factory((name) => (name === "zod" ? zod : host.react));
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

function findComponent(tree, name) {
  return flattenVNode(tree).find((n) => typeof n.type === "function" && n.type.name === name);
}

function findButton(tree, label) {
  return flattenVNode(tree).find((n) => n.type === "button" && [].concat(n.children ?? []).join("").includes(label));
}

// 挂载面板并返回 section 树（presets 覆盖 ShioriSection 前若干个 useState）。
async function mountSection(host, presets) {
  const mod = loadModule(host);
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => async () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => {
        if (meta.name === "plugins.bundle.config") renderSlot = render;
        return () => {};
      },
    },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push(...presets);
  host.cursor.v = 0;
  return sectionVNode.type(sectionVNode.props);
}

// ---------------------------------------------------------------------------
// a) tab：TABS 末尾追加「闪回命中」，图标走 CSS mask、不塞 emoji
// ---------------------------------------------------------------------------

const FROZEN_TAB_LABELS = ["状态", "记忆 L0/L1", "图谱", "候选 / 计划", "L3/topic 记忆管理", "预算配置"];

test("F2 tab：闪回命中追加在 TABS 末尾，前六项 label 逐字不变，图标 mask 类齐备且不塞 emoji", async () => {
  const host = makeStatefulReact();
  const tree = await mountSection(host, ["status", "session-A", "", null, { mode: "active" }]);
  const tabs = flattenVNode(tree).filter((n) => n.type === "button" && String(n.props.className).includes("dshi_tab"));
  assert.equal(tabs.length, FROZEN_TAB_LABELS.length + 1);
  assert.deepEqual(tabs.slice(0, 6).map((n) => [].concat(n.children).join("")), FROZEN_TAB_LABELS,
    "既有六项 label 逐字不变（冻结清单测试的改法见交付 note）");
  const last = tabs[tabs.length - 1];
  assert.equal([].concat(last.children).join(""), "闪回命中", "末尾 tab label");
  assert.equal(last.props.className.includes("dshi_tabIco-flashbacks"), true, "专属图标类");
  assert.equal(last.props.className.includes("dshi_tabIco "), true, "图标标记类");
  // 图标是 CSS mask 伪元素，label 是按钮唯一 children：不许 emoji、不许塞图形文本。
  assert.equal(/\p{Extended_Pictographic}/u.test([].concat(last.children).join("")), false, "label 无 emoji");

  const cssFile = readFileSync(join(WORKQ, "client", "shiori.css"), "utf8");
  const bundleSource = readFileSync(join(WORKQ, "client", "index.js"), "utf8");
  for (const [label, text] of [["client/shiori.css", cssFile], ["内嵌 CSS", bundleSource]]) {
    assert.ok(text.includes(".dshi_tabIco-flashbacks{--dshi-tab-ico:url('data:image/svg+xml,"), `${label}：闪回 tab 专属 mask SVG`);
  }
  assert.ok(cssFile.includes(".dshi_fbPop{position:absolute"), "client/shiori.css：按钮弹出层样式");
});

// ---------------------------------------------------------------------------
// b) 面板三组内容：从未命中 / top 榜 / 投递吞吐（口径文案）
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

function graphFixture() {
  const now = Date.now();
  return {
    scope: "amber",
    nodes: [
      { id: "s-never", title: "从未命中的卡", summary: null, vitality: "evergreen", revision: 1, hitCount: 0, lastHitAt: null, createdAt: new Date(now - 3 * DAY_MS).toISOString() },
      { id: "s-top", title: "高频卡", summary: null, vitality: "evergreen", revision: 2, hitCount: 5, lastHitAt: new Date(now - 3600_000).toISOString(), createdAt: new Date(now - 40 * DAY_MS).toISOString() },
      { id: "s-mid", title: "中频卡", summary: null, vitality: "ephemeral", revision: 1, hitCount: 3, lastHitAt: new Date(now - 7200_000).toISOString(), createdAt: new Date(now - 10 * DAY_MS).toISOString() },
      { id: "s-legacy", title: "老投递卡", summary: null, vitality: "ephemeral", revision: 1, hitCount: 1, lastHitAt: null, createdAt: null },
    ],
    edges: [],
    deliveries: [{
      deliveryId: "d1", at: new Date(now - 60_000).toISOString(), sessionId: "session-A",
      cards: [{ sparkId: "s-top", trigger: "高频", source: "seed" }],
    }],
    deliveryStats: { rounds: 4, totalDelivered: 10, uniqueCards: 6 },
  };
}

test("F2 面板：三组数据齐备——从未命中标题+存续天数、top 榜降序+命中次数+最近时间、吞吐统计与口径标注", async () => {
  const host = makeStatefulReact();
  const sectionTree = await mountSection(host, ["flashbacks", "session-A", "", null, { mode: "active" }]);
  const tab = findComponent(sectionTree, "FlashbacksTab");
  assert.ok(tab, "FlashbacksTab reached through real slot render");

  host.states.length = 0;
  host.states.push(graphFixture(), { l2: true, organize: true, forgetting: true, tools: true, sections: true }, null);
  host.cursor.v = 0;
  const tree = tab.type({ dsh: { call: async () => ({}) }, sessionId: "session-A" });
  const text = collectText(tree);

  // ① 从未命中：标题 + 存续天数。
  assert.ok(text.includes("从未命中（1 张）"), "从未命中分组与计数");
  assert.ok(text.includes("从未命中的卡"), "未命中卡标题");
  assert.ok(text.includes("存续 3 天"), "存续天数来自 createdAt");
  assert.ok(text.includes("命中 top 榜"), "top 榜分组");

  // ② top 榜：命中次数 + 最近命中时间；口径是「进入投递包」，不是「使用」。
  assert.ok(text.includes("进入投递包 5 次"), "命中次数文案");
  assert.ok(text.includes("进入投递包 3 次"), "第二名的命中次数");
  assert.ok(text.indexOf("高频卡") < text.indexOf("中频卡"), "top 榜按 hitCount 降序");
  assert.ok(text.includes("最近进入投递包："), "最近命中时间行");

  // ③ 投递吞吐：总投递张数 / 轮次 / 重复投递率（1 - 6/10 = 40%）。
  assert.ok(text.includes("总投递张数10"), "总投递张数");
  assert.ok(text.includes("投递轮次4"), "轮次");
  assert.ok(text.includes("重复投递率40%"), "重复投递率按 1 − unique/total 计算");
  // 口径（用户硬性要求）：如实标注覆盖区间为 L2 开启期间，严禁「使用了 N 次」措辞。
  assert.ok(text.includes("只覆盖 L2 开启期间的记录"), "吞吐统计标注 L2 开启期覆盖口径");
  assert.ok(text.includes("不是全生命周期口径"), "明确否认全生命周期口径");
  assert.equal(text.includes("使用了"), false, "严禁把 hitCount 说成「使用了 N 次」");
});

test("F2 面板：top 榜严格降序并截断到 10 条，平局按最近命中时间降序", async () => {
  const host = makeStatefulReact();
  const sectionTree = await mountSection(host, ["flashbacks", "session-A", "", null, { mode: "active" }]);
  const tab = findComponent(sectionTree, "FlashbacksTab");
  const now = Date.now();
  const nodes = [];
  for (let i = 0; i < 12; i++) {
    nodes.push({
      id: "s-" + String(i).padStart(2, "0"), title: "卡" + i, summary: null, vitality: "evergreen",
      revision: 1, hitCount: i + 1, lastHitAt: new Date(now - i * 1000).toISOString(), createdAt: new Date(now - DAY_MS).toISOString(),
    });
  }
  // 平局样本：hitCount 相同 → lastHitAt 新的在前。
  nodes.push({ id: "s-tie-old", title: "平局旧", summary: null, vitality: "ephemeral", revision: 1, hitCount: 6, lastHitAt: new Date(now - 9000_000).toISOString(), createdAt: null });
  nodes.push({ id: "s-tie-new", title: "平局新", summary: null, vitality: "ephemeral", revision: 1, hitCount: 6, lastHitAt: new Date(now - 1000).toISOString(), createdAt: null });
  host.states.length = 0;
  host.states.push({ scope: "amber", nodes, edges: [], deliveries: [], deliveryStats: { rounds: 1, totalDelivered: 20, uniqueCards: 14 } }, { l2: true }, null);
  host.cursor.v = 0;
  const tree = tab.type({ dsh: { call: async () => ({}) }, sessionId: "session-A" });
  const text = collectText(tree);
  assert.ok(text.includes("前 10 / 共 14 张"), "截断提示（12 + 2 平局 = 14 张命中卡）");
  // hitCount 6 的三张按 lastHitAt 降序：平局新（now-1s）→ 卡5（now-5s）→ 平局旧（now-150s）。
  const order = ["卡11", "卡10", "卡9", "卡8", "卡7", "卡6", "平局新", "卡5", "平局旧", "卡4"];
  let cursor = -1;
  for (const label of order) {
    const at = text.indexOf(label);
    assert.ok(at > cursor, `排序位置：${label}`);
    cursor = at;
  }
  assert.equal(text.includes("卡3"), false, "第 11 名以后不渲染");
});

test("F2 面板：L2 关闭显示引导（不渲染吞吐组）；空卡片显示引导；零投递不给 0% 去重率", async () => {
  const host = makeStatefulReact();
  const sectionTree = await mountSection(host, ["flashbacks", "session-A", "", null, { mode: "active" }]);
  const tab = findComponent(sectionTree, "FlashbacksTab");

  // L2 关闭：整页引导，不报错、不空白、无吞吐组。
  host.states.length = 0;
  host.states.push({ scope: "amber", nodes: [], edges: [], deliveries: [], deliveryStats: { rounds: 0, totalDelivered: 0, uniqueCards: 0 } }, { l2: false, organize: true, forgetting: true, tools: true, sections: true }, null);
  host.cursor.v = 0;
  const offTree = tab.type({ dsh: { call: async () => ({}) }, sessionId: "session-A" });
  const offText = collectText(offTree);
  assert.ok(offText.includes("L2 闪回投递未开启"), "L2 关闭引导文案");
  assert.ok(offText.includes("开启 L2"), "引导去开 L2");
  assert.equal(offText.includes("总投递张数"), false, "L2 关闭不渲染吞吐组");

  // L2 开、无卡片：两组引导 + 暂无投递（不给 0%）。
  host.states.length = 0;
  host.states.push({ scope: "amber", nodes: [], edges: [], deliveries: [], deliveryStats: { rounds: 0, totalDelivered: 0, uniqueCards: 0 } }, { l2: true }, null);
  host.cursor.v = 0;
  const emptyTree = tab.type({ dsh: { call: async () => ({}) }, sessionId: "session-A" });
  const emptyText = collectText(emptyTree);
  assert.ok(emptyText.includes("当前 scope 还没有 active 卡片"), "无卡片引导");
  assert.ok(emptyText.includes("还没有任何卡片进入过投递包"), "空 top 榜引导");
  assert.ok(emptyText.includes("暂无投递"), "零投递显示「暂无投递」");
  assert.equal(emptyText.includes("重复投递率0%"), false, "零投递不显示 0%");
});

// ---------------------------------------------------------------------------
// c) 服务端 getGraph：nodes 扩展字段 + deliveries（hitMeta 富化）+ deliveryStats
// ---------------------------------------------------------------------------

test("F2 服务端：getGraph 返回 nodes 命中字段、deliveries（含 trigger/source，崩溃悬挂包不算投递）、deliveryStats", async () => {
  const { createManagement } = await import(pathToFileURL(join(WORKQ, "src", "plugin", "management.mjs")).href);
  const now = Date.now();
  const cards = [
    { id: "s1", scopeId: "global", state: "active", title: "卡一", summary: "s", vitality: "evergreen", revision: 1, triggers: [], entities: [], links: [], content: "c", hitCount: 2, lastHitAt: new Date(now - 60_000).toISOString(), createdAt: new Date(now - 5 * DAY_MS).toISOString() },
    { id: "s2", scopeId: "global", state: "active", title: "卡二", summary: null, vitality: "ephemeral", revision: 1, triggers: [], entities: [], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: new Date(now - DAY_MS).toISOString() },
  ];
  const ledger = {
    scanned: {}, seen: {}, sessionEpochs: {},
    pending: {
      d1: {
        deliveryId: "d1", session: "session-A", createdAt: new Date(now - 120_000).toISOString(),
        delivery: {
          delivered: [{ id: "s1", revision: 1 }, { id: "s2", revision: 1 }],
          hitMeta: { s1: { trigger: "触发词A", source: "seed" }, s2: { trigger: null, source: "related" } },
        },
      },
      // 崩溃悬挂包（无 accepted / committed）：不算投递。
      dHang: { deliveryId: "dHang", session: "session-A", createdAt: new Date(now - 300_000).toISOString(), delivery: { delivered: [{ id: "s1", revision: 1 }], hitMeta: {} } },
    },
    accepted: { d1: { deliveryId: "d1", acceptedAt: new Date(now - 60_000).toISOString() } },
    committed: { d1: { committedAt: new Date(now - 30_000).toISOString() } },
    hits: { d1: [{ sparkId: "s1", revision: 1 }, { sparkId: "s2", revision: 1 }, { sparkId: "s1", revision: 1 }] },
  };
  const baseSettings = (l2Enabled) => ({
    mode: "active", ownerId: "local", defaultPersona: null, sessionPersonas: [], workspacePersonas: [],
    organize: { enabled: true }, forgetting: { enabled: true }, l2: { enabled: l2Enabled },
    dataRoot: join(WORKQ, "tmp-nonexistent-data"), stateRoot: join(WORKQ, "tmp-nonexistent-state"),
    budgets: {},
  });
  const build = (l2Enabled) => createManagement({
    settings: baseSettings(l2Enabled),
    dataRoot: join(WORKQ, "tmp-nonexistent-data"),
    state: { l2Store: { diagnostics: async () => ledger } },
    resourcesFor: async () => ({ sparkStore: { listActive: async () => cards } }),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: () => ({}),
    executeToolForScope: async () => ({}),
  }).management;
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };

  const out = await build(true).getGraph(trusted, {});
  const s1 = out.nodes.find((n) => n.id === "s1");
  const s2 = out.nodes.find((n) => n.id === "s2");
  assert.equal(s1.hitCount, 2);
  assert.ok(typeof s1.lastHitAt === "string" && typeof s1.createdAt === "string");
  assert.equal(s2.hitCount, 0);
  assert.equal(s2.lastHitAt, null);
  assert.equal(out.deliveries.length, 1, "崩溃悬挂的 pending 不进投递列表");
  assert.equal(out.deliveries[0].deliveryId, "d1");
  assert.equal(out.deliveries[0].sessionId, "session-A");
  assert.deepEqual(out.deliveries[0].cards, [
    { sparkId: "s1", trigger: "触发词A", source: "seed" },
    { sparkId: "s2", trigger: null, source: "related" },
  ], "hitMeta 富化随投递明细带出");
  assert.deepEqual(out.deliveryStats, { rounds: 1, totalDelivered: 3, uniqueCards: 2 },
    "吞吐统计按全账本口径（同卡重复进包重复计）");

  const off = await build(false).getGraph(trusted, {});
  assert.deepEqual(off.deliveries, []);
  assert.deepEqual(off.deliveryStats, { rounds: 0, totalDelivered: 0, uniqueCards: 0 }, "L2 关闭：无账可查，统计为零");
  assert.equal(off.nodes.find((n) => n.id === "s1").hitCount, 2, "卡片统计不受 L2 开关影响");
});

// ---------------------------------------------------------------------------
// e/f) 消息底部按钮：插槽注册、降级关联、冻结 ctx、插槽缺席静默跳过
// ---------------------------------------------------------------------------

async function applyWithSlots(host, options = {}) {
  const mod = loadModule(host);
  const registered = {};
  const inject = options.throwOnActions
    ? (name, fn) => {
        if (name !== "plugins.bundle.config") throw new Error("no such slot: " + name);
        return fn();
      }
    : (name, fn) => fn();
  const slots = {
    inject,
    register: (meta, render) => { registered[meta.name] = { meta, render }; return () => {}; },
  };
  let ctx = { remote: { $mount: async () => async () => {} }, slots };
  if (options.freeze) ctx = Object.freeze(ctx);
  const cleanup = await mod.apply(ctx);
  return { registered, cleanup };
}

test("F2 按钮：assistant-actions 插槽注册成功，降级关联如实标注「最近一次投递」，来源与触发词带出", async () => {
  const host = makeStatefulReact();
  const { registered, cleanup } = await applyWithSlots(host);
  const action = registered["conversation.chat.assistant-actions"];
  assert.ok(action, "assistant-actions 插槽已注册");
  assert.equal(action.meta.id, "shiori-flashbacks");
  assert.equal(typeof action.meta.inject, "function");
  assert.deepEqual(Object.keys(action.meta.inject("session-9")), ["shioriSessionId"], "meta.inject 提供会话 id");

  const now = Date.now();
  const vnode = action.render({ messageId: "m-1", shioriSessionId: "session-A" });
  assert.equal(vnode.type.name, "FlashbackActions", "render 包一层注入 dsh 后落到按钮组件");

  const graph = {
    nodes: [{ id: "s1", title: "卡片甲", summary: null, vitality: "evergreen", revision: 1, hitCount: 1, lastHitAt: new Date(now - 60_000).toISOString(), createdAt: null }],
    deliveries: [
      { deliveryId: "d-old", at: new Date(now - 11 * 60_000).toISOString(), sessionId: "session-A", cards: [{ sparkId: "s-x", trigger: "过期词", source: "seed" }] },
      { deliveryId: "d-other", at: new Date(now - 30_000).toISOString(), sessionId: "session-B", cards: [{ sparkId: "s-y", trigger: "别会话", source: "seed" }] },
      { deliveryId: "d-new", at: new Date(now - 60_000).toISOString(), sessionId: "session-A", cards: [{ sparkId: "s1", trigger: "触发词A", source: "seed" }, { sparkId: "s2", trigger: null, source: "related" }] },
    ],
  };
  host.states.length = 0;
  host.states.push(true, { delivery: graph.deliveries[2], nodes: graph.nodes, error: null }, false);
  host.cursor.v = 0;
  const tree = vnode.type(vnode.props);
  const text = collectText(tree);
  assert.ok(text.includes("最近一次投递（10 分钟内）"), "降级口径如实标注");
  assert.ok(text.includes("无法精确到单条消息"), "不许假装精确到具体消息");
  assert.ok(text.includes("卡片甲"), "标题来自 getGraph nodes");
  assert.ok(text.includes("命中触发词：触发词A · 来源：种子"), "种子来源 + 命中触发词");
  assert.ok(text.includes("命中触发词：未记录 · 来源：一跳关联"), "一跳关联来源 + 老数据未记录触发词");
  assert.equal(text.includes("过期词"), false, "窗口外的旧投递不显示");
  assert.equal(text.includes("别会话"), false, "其他会话的投递不显示");
  await cleanup();
});

test("F2 按钮：窗口内无本会话投递 → 明确提示；点按钮发起 getGraph 并按 shioriSessionId 过滤", async () => {
  const host = makeStatefulReact();
  const { registered, cleanup } = await applyWithSlots(host);
  const action = registered["conversation.chat.assistant-actions"];
  const vnode = action.render({ messageId: "m-1", shioriSessionId: "session-A" });

  const calls = [];
  const dsh = {
    call: async (method, session) => {
      calls.push({ method, session });
      return { nodes: [], deliveries: [{ deliveryId: "d-old", at: new Date(Date.now() - 11 * 60_000).toISOString(), sessionId: "session-A", cards: [] }] };
    },
  };
  // 关闭态：点击 → 展开 + 首次拉取。
  host.states.length = 0;
  host.states.push(false, undefined, false);
  host.cursor.v = 0;
  const props = { dsh, shioriSessionId: "session-A", messageId: "m-1" };
  const tree = vnode.type(props);
  const button = findButton(tree, "闪回命中");
  assert.ok(button, "按钮存在");
  button.props.onClick();
  assert.equal(host.states[0], true, "点击展开");
  assert.equal(calls.length, 1, "点击后立即发起 getGraph（async 函数首个 await 前同步执行）");
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{ method: "getGraph", session: "session-A" }], "按注入的会话 id 拉取 getGraph");
  assert.equal(host.states[2], false, "拉取完成后 busy 复位");
  assert.equal(host.states[1].delivery, null, "11 分钟前的投递超出窗口 → 无最近投递");
  host.states[0] = true;
  host.cursor.v = 0;
  const openTree = vnode.type(props);
  assert.ok(collectText(openTree).includes("最近 10 分钟内本会话没有投递记录。"), "窗口外如实提示");
  await cleanup();
});

test("F2 按钮：宿主 ctx 冻结时 apply 不抛（插槽照常注册）；插槽缺席时静默跳过，apply 不失败", async () => {
  // 冻结 ctx（真机只读上下文）。
  const host = makeStatefulReact();
  const { registered, cleanup } = await applyWithSlots(host, { freeze: true });
  assert.ok(registered["conversation.chat.assistant-actions"], "冻结 ctx 下插槽注册成功");
  assert.ok(registered["plugins.bundle.config"], "面板插槽不受影响");
  await cleanup();

  // 旧宿主没有 assistant-actions 插槽：静默跳过，面板照常挂载。
  const host2 = makeStatefulReact();
  const { registered: registered2, cleanup: cleanup2 } = await applyWithSlots(host2, { throwOnActions: true });
  assert.ok(registered2["plugins.bundle.config"], "插槽缺席时面板插槽仍注册");
  assert.equal(registered2["conversation.chat.assistant-actions"], undefined, "消息按钮插槽未注册");
  await cleanup2();
});
