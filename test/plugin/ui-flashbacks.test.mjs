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
  // S7-rework P2：记录 useEffect 回调（不自动执行）——切会话复位逻辑要手动跑。
  // 既有用例不读 effects，行为与原 `useEffect: () => {}` 完全一致。
  const effects = [];
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: "fragment",
    useState: (initial) => {
      const i = cursor.v++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; }];
    },
    useEffect: (fn) => { effects.push(fn); },
    useMemo: (fn) => fn(),
    useRef: () => ({ current: null }),
  };
  return { react, states, cursor, effects };
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
// a) tab：0.5-13-4 八页签（闪回 = 图谱 + 命中合并页），图标走 CSS mask、不塞 emoji
// ---------------------------------------------------------------------------

// 0.5-13-4 八页签（唯一被授权重写的 tab 冻结清单）。
const MERGED_TAB_LABELS = ["概览", "专题记忆", "专题整理", "闪回", "人设与核心", "投递体检", "最近变更", "设置"];

test("F2 tab：八项顺序固定，闪回 tab 图标 mask 类齐备且不塞 emoji", async () => {
  const host = makeStatefulReact();
  const tree = await mountSection(host, ["status", "session-A", "", null, { mode: "active" }]);
  const tabs = flattenVNode(tree).filter((n) => n.type === "button" && String(n.props.className).includes("dshi_tab"));
  const labels = tabs.map((n) => [].concat(n.children).join(""));
  assert.deepEqual(labels, MERGED_TAB_LABELS, "最终 tab 顺序");
  const flash = tabs.find((n) => [].concat(n.children).join("") === "闪回");
  assert.ok(flash, "闪回 tab 存在");
  assert.equal(flash.props.className.includes("dshi_tabIco-flashbacks"), true, "专属图标类");
  assert.equal(flash.props.className.includes("dshi_tabIco "), true, "图标标记类");
  // 图标是 CSS mask 伪元素，label 是按钮唯一 children：不许 emoji、不许塞图形文本。
  assert.equal(/\p{Extended_Pictographic}/u.test([].concat(flash.children).join("")), false, "label 无 emoji");

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

test("F2 面板：三组数据齐备——从未命中标题+存续天数、最近命中按时间倒序、吞吐统计与口径标注", async () => {
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
  // ② 最近命中（0.5-13-4：原 top 榜改为按 lastHitAt 倒序的最近命中）。
  assert.ok(text.includes("最近命中（3 张）"), "最近命中分组与计数");
  assert.ok(text.includes("进入投递包 5 次"), "命中次数文案");
  assert.ok(text.includes("进入投递包 3 次"), "第二名的命中次数");
  assert.ok(text.indexOf("高频卡") < text.indexOf("中频卡"), "最近命中按 lastHitAt 倒序");
  assert.ok(text.indexOf("中频卡") < text.indexOf("老投递卡"), "无 lastHitAt 的卡片排最后");
  assert.ok(text.includes("最近进入投递包："), "最近命中时间行");
  // 不足一页（3 < 8）不显示页码条。
  assert.equal(flattenVNode(tree).some((n) => n.props && n.props["data-role"] === "flashback-hits-page"), false, "不足一页不显示页码");
  // ③ 投递吞吐：总投递张数 / 轮次 / 重复投递率（1 - 6/10 = 40%）。
  assert.ok(text.includes("总投递张数10"), "总投递张数");
  assert.ok(text.includes("投递轮次4"), "轮次");
  assert.ok(text.includes("重复投递率40%"), "重复投递率按 1 − unique/total 计算");
  assert.ok(text.includes("只覆盖 L2 开启期间的记录"), "吞吐统计标注 L2 开启期覆盖口径");
  assert.ok(text.includes("不是全生命周期口径"), "明确否认全生命周期口径");
  assert.equal(text.includes("使用了"), false, "严禁把 hitCount 说成「使用了 N 次」");
});

test("F2 面板：最近命中每页 8 条，页码边界（上一页/下一页/第 N/M 页）与平局排序", async () => {
  const host = makeStatefulReact();
  const sectionTree = await mountSection(host, ["flashbacks", "session-A", "", null, { mode: "active" }]);
  const tab = findComponent(sectionTree, "FlashbacksTab");
  const now = Date.now();
  const nodes = [];
  for (let i = 0; i < 14; i++) {
    nodes.push({
      id: "s-" + String(i).padStart(2, "0"), title: "卡" + i, summary: null, vitality: "evergreen",
      revision: 1, hitCount: 20 - i, lastHitAt: new Date(now - i * 1000).toISOString(), createdAt: new Date(now - DAY_MS).toISOString(),
    });
  }
  // 平局：lastHitAt 相同 → hitCount 高的在前。
  nodes.push({ id: "s-tie-low", title: "平局低", summary: null, vitality: "ephemeral", revision: 1, hitCount: 16, lastHitAt: new Date(now - 3000).toISOString(), createdAt: null });
  nodes.push({ id: "s-tie-high", title: "平局高", summary: null, vitality: "ephemeral", revision: 1, hitCount: 19, lastHitAt: new Date(now - 3000).toISOString(), createdAt: null });
  host.states.length = 0;
  host.states.push({ scope: "amber", nodes, edges: [], deliveries: [], deliveryStats: { rounds: 1, totalDelivered: 20, uniqueCards: 14 } }, { l2: true }, null);
  host.cursor.v = 0;
  const render = () => { host.cursor.v = 0; return tab.type({ dsh: { call: async () => ({}) }, sessionId: "session-A" }); };
  let tree = render();
  const rows = (t) => flattenVNode(t).filter((n) => n.props && n.props["data-role"] === "flashback-hit-row");
  assert.equal(rows(tree).length, 8, "第 1 页 8 条");
  let text = collectText(tree);
  assert.ok(text.includes("最近命中（16 张）"), "总计数 14 + 2 平局");
  assert.ok(text.includes("第 1 / 2 页（每页 8 条）"), "页码信息");
  assert.ok(text.indexOf("平局高") < text.indexOf("卡3"), "同 lastHitAt 按 hitCount 降序（平局高 19 > 卡3 17）");
  assert.ok(text.indexOf("卡3") < text.indexOf("平局低"), "同 lastHitAt 低 hitCount 排后（卡3 17 > 平局低 16）");
  const prev = flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "flashback-hits-prev");
  const next = flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "flashback-hits-next");
  assert.equal(prev.props.disabled, true, "第 1 页「上一页」禁用");
  assert.equal(next.props.disabled, false, "第 1 页「下一页」可点");
  next.props.onClick();
  tree = render();
  text = collectText(tree);
  assert.equal(rows(tree).length, 8, "第 2 页 8 条（共 16 条）");
  assert.ok(text.includes("第 2 / 2 页（每页 8 条）"), "翻页后页码信息");
  assert.equal(flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "flashback-hits-prev").props.disabled, false, "第 2 页「上一页」可点");
  assert.equal(flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "flashback-hits-next").props.disabled, true, "末页「下一页」禁用");
  assert.equal(text.includes("卡0"), false, "第 2 页不渲染第 1 页的卡片");
});

// 0.5-13-4：合并页（闪回 = 图谱 + 命中）与图谱 460 画布 / 适应画布按钮。
test("F2 合并页：图谱 460 画布 + 适应画布按钮；同页同时渲染图谱与最近命中", async () => {
  const host = makeStatefulReact();
  const sectionTree = await mountSection(host, ["graph", "session-A", "", null, { mode: "active" }]);
  const flat = flattenVNode(sectionTree);
  assert.ok(flat.some((n) => n.props && n.props["data-role"] === "flashback-view-graph"), "图谱段");
  assert.ok(flat.some((n) => n.props && n.props["data-role"] === "flashback-view-hits"), "命中段");
  const graphTab = findComponent(sectionTree, "GraphTab");
  assert.ok(graphTab, "GraphTab reached through alias graph");
  // GraphTab 的 view 状态在 states[3]（graph/error/selected/view...）。
  host.states.length = 0;
  host.states.push({ scope: "amber", nodes: [{ id: "s-1", title: "卡", vitality: "evergreen", state: "active" }], edges: [] }, null, null, { x: 40, y: 60, k: 2 });
  host.cursor.v = 0;
  const tree = graphTab.type({ dsh: { call: async () => ({}) }, sessionId: "session-A" });
  const svg = flattenVNode(tree).find((n) => n.type === "svg");
  assert.equal(svg.props.viewBox, "0 0 800 460", "viewBox 高 460");
  const fit = flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "graph-fit");
  assert.ok(fit, "适应画布按钮存在");
  fit.props.onClick();
  assert.deepEqual(host.states[3], { x: 0, y: 0, k: 1 }, "适应画布重置缩放并居中");
  const cssFile = readFileSync(join(WORKQ, "client", "shiori.css"), "utf8");
  assert.ok(cssFile.includes(".dshi_graphSvg{display:block;width:100%;height:460px;touch-action:none}"), "CSS 画布高 460");
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
// c2) 0.4 收尾：nodeOut 补 entities——服务端节点带出规范化实体，客户端着色接上
// ---------------------------------------------------------------------------

/** getGraph 单测的极简 management 装配（L2 关闭：不查账本；卡片来自内存 fixture）。 */
async function buildGraphManagement(cards) {
  const { createManagement } = await import(pathToFileURL(join(WORKQ, "src", "plugin", "management.mjs")).href);
  return createManagement({
    settings: {
      mode: "active", ownerId: "local", defaultPersona: null, sessionPersonas: [], workspacePersonas: [],
      organize: { enabled: true }, forgetting: { enabled: true }, l2: { enabled: false },
      dataRoot: join(WORKQ, "tmp-nonexistent-data"), stateRoot: join(WORKQ, "tmp-nonexistent-state"),
      budgets: {},
    },
    dataRoot: join(WORKQ, "tmp-nonexistent-data"),
    state: { l2Store: { diagnostics: async () => ({}) } },
    resourcesFor: async () => ({ sparkStore: { listActive: async () => cards } }),
    isStarted: () => true,
    generation: () => 1,
    registerGrant: () => ({}),
    executeToolForScope: async () => ({}),
  }).management;
}

test("0.4 收尾：getGraph nodeOut 输出 entities（trim/去重/上限 4，缺失退化为 []）", async () => {
  const cards = [
    // 脏数据齐活：带空格重复、非字符串、空串、超出上限的尾随实体——
    // 期望按 normalizeEntities 口径规范化（trim 后去重保序、上限 4 截断）。
    { id: "s1", scopeId: "global", state: "active", title: "卡一", summary: "s", vitality: "evergreen", revision: 1, triggers: [], entities: ["项目甲", " 项目甲 ", 42, "", "项目乙", "项目丙", "项目丁", "项目戊"], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
    { id: "s2", scopeId: "global", state: "active", title: "卡二", summary: null, vitality: "ephemeral", revision: 1, triggers: [], entities: ["项目甲"], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
    { id: "s3", scopeId: "global", state: "active", title: "卡三", summary: null, vitality: "ephemeral", revision: 1, triggers: [], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
  ];
  const mgmt = await buildGraphManagement(cards);
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };

  const out = await mgmt.getGraph(trusted, {});
  const nodeById = Object.fromEntries(out.nodes.map((n) => [n.id, n]));
  assert.deepEqual(nodeById.s1.entities, ["项目甲", "项目乙", "项目丙", "项目丁"],
    "脏 entities 规范化：trim 后去重保序、非字符串/空串丢弃、上限 4 截断");
  assert.deepEqual(nodeById.s2.entities, ["项目甲"], "干净 entities 原样带出");
  assert.deepEqual(nodeById.s3.entities, [], "无 entities 的卡缺省 []（不再丢字段，客户端据此走中性色）");
  // 契约断言（reviewer attempt-1 必修 1）：wire 的每个节点键都必须在
  // getGraphNodeItem 的 outputSchema 声明（写法照 test/plugin/timeline.test.mjs
  // 的 getTimeline 同款断言）——additionalProperties:false 下新增字段漏声明
  // 即属契约矛盾，这里钉死防止再犯。
  const { MANAGEMENT_METHODS } = await import(pathToFileURL(join(WORKQ, "src", "plugin", "protocol.mjs")).href);
  const nodeItems = MANAGEMENT_METHODS.getGraph.outputSchema.oneOf[0].properties.nodes.items;
  assert.equal(nodeItems.additionalProperties, false, "节点 schema 保持 additionalProperties:false（契约口径不变）");
  assert.equal(nodeItems.properties.entities.type, "array");
  assert.equal(nodeItems.properties.entities.maxItems, 4, "entities 上限与 graph.mjs MAX_NODE_ENTITIES 一致");
  assert.deepEqual(nodeItems.properties.entities.items, { type: "string", minLength: 1 }, "entities 元素为非空字符串");
  assert.ok(nodeItems.required.includes("entities"), "entities 进 required（nodeOut 三条路径恒输出该字段）");
  for (const node of out.nodes) {
    for (const key of Object.keys(node)) {
      assert.ok(Object.hasOwn(nodeItems.properties, key), `wire key "${key}" 未在 getGraphNodeItem 声明`);
    }
  }
  // level=2 分支的节点 schema 与全量分支是同一对象（形状一致的契约由引用相等钉住）。
  assert.equal(MANAGEMENT_METHODS.getGraph.outputSchema.oneOf[2].properties.nodes.items, nodeItems,
    "level=2 与全量共用同一 getGraphNodeItem");
  // 其余既有字段不受影响（nodeOut 扩展不挤掉旧字段）。
  assert.equal(nodeById.s1.title, "卡一");
  assert.equal(nodeById.s1.hitCount, 0);
  assert.equal(nodeById.s1.createdAt, null);
});

test("0.4 收尾：getGraph entities 经 nodeOut 出线后客户端接上着色（有实体聚类色 / 无实体中性色）", async () => {
  // 端到端接线：management.getGraph（真实 projectGraph + 补字段后的 nodeOut）
  // 的返回原样喂给客户端 GraphTab，验证图例「填充=实体聚类」从此是真的——
  // 此前 nodeOut 丢 entities，所有节点永远落中性色。
  const cards = [
    { id: "s1", scopeId: "global", state: "active", title: "卡一", summary: "s", vitality: "evergreen", revision: 1, triggers: [], entities: ["项目甲"], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
    { id: "s2", scopeId: "global", state: "active", title: "卡二", summary: null, vitality: "ephemeral", revision: 1, triggers: [], entities: ["项目甲"], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
    { id: "s3", scopeId: "global", state: "active", title: "卡三", summary: null, vitality: "ephemeral", revision: 1, triggers: [], links: [], content: "c", hitCount: 0, lastHitAt: null, createdAt: null },
  ];
  const mgmt = await buildGraphManagement(cards);
  const trusted = { session: { id: "s-panel" }, source: "panel-rpc" };
  const graph = await mgmt.getGraph(trusted, {});

  // 客户端 GraphTab：经真实插槽挂到 graph tab 找到组件本体，再直接渲染
  // （react stub 不自动调用嵌套组件；与 ui-flashbacks 既有 FlashbacksTab 用例同款）。
  // 首渲染 state 全走初值 → 手动跑 load effect（拉 getGraph）→ 二次渲染读最新 state。
  const host = makeStatefulReact();
  const mod = loadModule(host);
  const dsh = { call: async (method) => (method === "getGraph" ? graph : {}) };
  const firstTree = await mountSection(host, ["graph", "session-A", "", null, { mode: "active" }]);
  const tab = findComponent(firstTree, "GraphTab");
  assert.ok(tab, "graph tab 挂载 GraphTab");
  host.states.length = 0;
  host.cursor.v = 0;
  host.effects.length = 0;
  tab.type({ dsh, sessionId: "session-A" }); // 首渲染：state 全初值，load effect 入列
  for (const effect of host.effects.splice(0)) effect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  host.cursor.v = 0;
  const tree = tab.type({ dsh, sessionId: "session-A" }); // 二次渲染：graph state 已填充

  const circleByKey = {};
  for (const g of flattenVNode(tree).filter((n) => n.type === "g" && ["s1", "s2", "s3"].includes(String(n.props.key)))) {
    circleByKey[g.props.key] = flattenVNode(g).find((n) => n.type === "circle");
  }
  assert.ok(circleByKey["s1"] && circleByKey["s2"] && circleByKey["s3"], "三个节点都渲染出 circle");
  const NEUTRAL = "var(--dsw-alias-label-secondary";
  assert.ok(!String(circleByKey["s1"].props.style.fill).includes(NEUTRAL), "有实体的节点着聚类色（不再是中性色）");
  assert.equal(circleByKey["s1"].props.style.fill, circleByKey["s2"].props.style.fill, "同一实体（项目甲）同色");
  assert.ok(String(circleByKey["s3"].props.style.fill).includes(NEUTRAL), "无实体的节点落中性色");
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

test("F2 按钮（R3 收口）：未拉取整位不渲染；挂载 effect 按注入会话 id 拉取；无投递浮层兜底文案保留；有卡按钮照常且点击不重复拉取", async () => {
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
  const props = { dsh, shioriSessionId: "session-A", messageId: "m-1" };
  // ① 未拉取（result=undefined）：整位不渲染（§11.5 R3 收口——加载中不留灰度入口）。
  // 原「按钮以『闪回』占位」断言按新契约改写。
  host.states.length = 0;
  host.states.push(false, undefined, false);
  host.cursor.v = 0;
  let tree = vnode.type(props);
  assert.equal(findButton(tree, "闪回"), undefined, "未拉取：整位不渲染");

  // ③ 挂载 effect 手动跑（本文件 react stub 不自动执行 effect）：getGraph 按注入的
  // shioriSessionId 发出——验证目标在本用例内自证，不引用别的文件的断言。
  host.effects.length = 0;
  host.cursor.v = 0;
  vnode.type(props);
  const mountEffects = host.effects.splice(0);
  assert.ok(mountEffects.length >= 1, "挂载 effect 已入列");
  for (const effect of mountEffects) effect();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{ method: "getGraph", session: "session-A" }], "挂载即按注入的会话 id 拉取 getGraph（原验证目标：按 shioriSessionId 过滤拉取）");
  assert.equal(host.states[1].delivery, null, "11 分钟前的投递超出窗口 → 无最近投递");

  // ② 已拉取、窗口外无投递（delivery=null、error=null）：按钮仍不占位（新契约）；
  // open=true（竞态窗口：浮层开着时数据被重新拉取）时浮层兜底文案照常渲染——
  // 防竞态分支保留，不因按钮不显示而删除。
  host.states.length = 0;
  host.states.push(false, { delivery: null, matchedPrecise: false, nodes: [], error: null }, false);
  host.cursor.v = 0;
  tree = vnode.type(props);
  assert.equal(findButton(tree, "闪回"), undefined, "已拉取确认无投递：按钮不占位");
  host.states[0] = true;
  host.cursor.v = 0;
  const fallbackTree = vnode.type(props);
  assert.ok(collectText(fallbackTree).includes("最近 10 分钟内本会话没有投递记录。"), "无投递浮层兜底文案保留（原验证目标：窗口外如实提示）");

  // 有卡已拉取：按钮照常出现；点击开浮层不再重复发 getGraph（拉取已由挂载
  // effect 完成，R3 收口后 toggle 不再兜底首次拉取）。
  host.states.length = 0;
  host.states.push(false, {
    delivery: { deliveryId: "d-new", sourceMessageId: "m-1", at: new Date(Date.now() - 60_000).toISOString(), sessionId: "session-A",
      cards: [{ sparkId: "s1", trigger: "触发词A", source: "seed" }] },
    matchedPrecise: false,
    nodes: [{ id: "s1", title: "卡片甲", summary: null }],
    error: null,
  }, false);
  host.cursor.v = 0;
  tree = vnode.type(props);
  const button = findButton(tree, "闪回");
  assert.ok(button, "有卡已拉取：按钮占位");
  const callsBeforeClick = calls.length;
  button.props.onClick();
  assert.equal(host.states[0], true, "点击展开浮层");
  assert.equal(calls.length, callsBeforeClick, "已拉取状态下点击不再重复发 getGraph（拉取由挂载 effect 承担）");
  host.cursor.v = 0;
  const openTree = vnode.type(props);
  assert.ok(collectText(openTree).includes("卡片甲"), "浮层卡片在列");
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

// ---------------------------------------------------------------------------
// g) 0.4-S7 闪回图谱两级视图：首屏只渲染簇圆、点簇进二级、返回复位、
//    空簇不渲染、单卡簇降级为点。GraphTab useState 顺序：
//    graph / error / selected / view / hoverId / search / searchMiss /
//    tabGuard / activeCluster（S7 新增，追加在既有 8 个之后）。
// ---------------------------------------------------------------------------

const GRAPH_TAB_PRESET_STATES = (graph) =>
  [graph, null, null, { x: 0, y: 0, k: 1 }, null, "", false, { sessionId: "session-A", gen: 0 }, null];

function graphLevel1Fixture() {
  return {
    scope: "amber",
    level: 1,
    clusters: [
      { key: "项目甲", label: "项目甲", count: 3, samples: ["卡一", "卡二", "卡三"] },
      { key: "项目乙", label: "项目乙", count: 2, samples: ["卡四", "卡五"] },
      { key: "__unclustered__", label: "未分类", count: 1, samples: ["散卡"] },
      { key: "ghost", label: "幽灵簇", count: 0, samples: [] }, // 空簇：客户端必须不渲染
    ],
    total: 6,
  };
}

function graphLevel2Fixture() {
  return {
    scope: "amber",
    level: 2,
    cluster: { key: "项目甲", label: "项目甲", count: 2 },
    nodes: [
      { id: "spk-1", title: "卡一", summary: null, vitality: "evergreen", revision: 1, hitCount: 2, lastHitAt: new Date(Date.now() - 60_000).toISOString(), createdAt: null },
      { id: "spk-2", title: "卡二", summary: null, vitality: "ephemeral", revision: 1, hitCount: 0, lastHitAt: null, createdAt: null },
    ],
    edges: [{ source: "spk-1", target: "spk-2", rel: null }],
    deliveries: [],
    deliveryStats: { rounds: 0, totalDelivered: 0, uniqueCards: 0 },
  };
}

async function flushAsync() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountGraphTabForS7(host) {
  const sectionTree = await mountSection(host, ["graph", "session-A", "", null, { mode: "active" }]);
  const tab = findComponent(sectionTree, "GraphTab");
  assert.ok(tab, "GraphTab reached through real slot render");
  return tab;
}

test("S7 图谱首屏：只渲染簇圆（无卡节点）、簇旁标 label 与 count、空簇不渲染、单卡簇降级为点", async () => {
  const host = makeStatefulReact();
  const tab = await mountGraphTabForS7(host);
  const calls = [];
  const dsh = { call: async (method, session, payload) => { calls.push({ method, session, payload }); return {}; } };

  host.states.length = 0;
  host.states.push(...GRAPH_TAB_PRESET_STATES(graphLevel1Fixture()));
  host.cursor.v = 0;
  const tree = tab.type({ dsh, sessionId: "session-A" });
  const text = collectText(tree);

  assert.ok(text.includes("项目甲"), "簇 label 渲染");
  assert.ok(text.includes("3 张"), "count 与卡数文案渲染");
  assert.ok(text.includes("未分类"), "未分类簇 label");
  assert.equal(text.includes("幽灵簇"), false, "空簇不渲染");

  const nodeGs = flattenVNode(tree).filter((n) => n.type === "g" && String(n.props.key || "").startsWith("spk-"));
  assert.equal(nodeGs.length, 0, "首屏不渲染任何卡节点（只有簇圆）");

  const circles = flattenVNode(tree).filter((n) => n.type === "circle");
  assert.equal(circles.length, 3, "只渲染三个簇圆（count=0 的空簇被过滤）");
  const dots = circles.filter((c) => c.props.style && c.props.style.stroke === "none");
  assert.equal(dots.length, 1, "单卡簇（未分类 count=1）降级为一个点：不画簇圆边框");
  assert.equal(dots[0].props.r, 5, "单卡簇点的半径是小点");
  for (const c of circles) {
    if (c.props.style && c.props.style.stroke === "none") continue;
    assert.ok(Number(c.props.r) > 10, "普通簇圆大小按 count（半径大于点的半径）");
  }
  // 首屏「刷新」走 level=1：payload 只带 level，不带 cluster。
  findButton(tree, "刷新").props.onClick();
  await flushAsync();
  assert.deepEqual(calls[0], { method: "getGraph", session: "session-A", payload: { level: 1 } },
    "首屏/刷新只拉 level=1");
});

test("S7 图谱点簇进二级：getGraph level=2 带簇名、面包屑「全部 › 簇名」、返回复位回首屏", async () => {
  const host = makeStatefulReact();
  const tab = await mountGraphTabForS7(host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      return payload && payload.level === 2 ? graphLevel2Fixture() : graphLevel1Fixture();
    },
  };

  host.states.length = 0;
  host.states.push(...GRAPH_TAB_PRESET_STATES(graphLevel1Fixture()));
  host.cursor.v = 0;
  let tree = tab.type({ dsh, sessionId: "session-A" });

  // 点簇「项目甲」→ 拉 level=2。
  const clusterG = flattenVNode(tree).find(
    (n) => n.type === "g" && n.props && String(n.props["aria-label"] || "").indexOf("项目甲") >= 0);
  assert.ok(clusterG, "簇圆可点（aria-label 可定位）");
  clusterG.props.onPointerUp();
  await flushAsync();

  assert.deepEqual(calls[calls.length - 1].payload, { level: 2, cluster: "项目甲" }, "点簇拉 level=2 并带簇 key");
  assert.equal(host.states[8], "项目甲", "activeCluster state 记下簇 key");
  assert.deepEqual(host.states[3], { x: 0, y: 0, k: 1 }, "进簇复位视口");
  assert.equal(host.states[2], null, "进簇清空选中");

  host.cursor.v = 0;
  tree = tab.type({ dsh, sessionId: "session-A" });
  const text = collectText(tree);
  assert.ok(text.includes("全部 › 项目甲"), "面包屑「全部 › 簇名」");
  const nodeGs = flattenVNode(tree).filter((n) => n.type === "g" && String(n.props.key || "").startsWith("spk-"));
  assert.equal(nodeGs.length, 2, "二级渲染簇内卡节点");
  assert.equal(flattenVNode(tree).some((n) => n.type === "line"), true, "二级渲染簇内连线");
  assert.equal(text.includes("3 张"), false, "二级不再渲染簇圆计数");

  // 返回：复位回首屏簇圆（selected / 视口 / activeCluster 全部复位）。
  findButton(tree, "返回").props.onClick();
  await flushAsync();
  assert.deepEqual(calls[calls.length - 1].payload, { level: 1 }, "返回重拉 level=1");
  assert.equal(host.states[8], null, "activeCluster 复位");
  assert.equal(host.states[2], null, "选中复位");
  assert.deepEqual(host.states[3], { x: 0, y: 0, k: 1 }, "视口复位");

  host.cursor.v = 0;
  tree = tab.type({ dsh, sessionId: "session-A" });
  assert.ok(collectText(tree).includes("3 张"), "回首屏重新渲染簇圆");
  assert.equal(flattenVNode(tree).filter((n) => n.type === "g" && String(n.props.key || "").startsWith("spk-")).length, 0,
    "首屏不再有卡节点");
});

// 回归守卫（#3e8717）：返回首屏只复位选中/视口/簇状态并重拉 level=1，
// 不得先把图谱 state 清空（setGraph(null)）——清了会出现一帧空图谱。
// 断言按 fixture 对象身份查 states 全槽，不锁 useState 下标，也不锁渲染分支。
test("S7 回归守卫：返回首屏后图谱不被清空（backToAll 不得 setGraph(null)）", async () => {
  const host = makeStatefulReact();
  const tab = await mountGraphTabForS7(host);
  const level1 = graphLevel1Fixture();
  const level2 = graphLevel2Fixture();
  const dsh = {
    call: async (method, session, payload) => (payload && payload.level === 2 ? level2 : level1),
  };

  host.states.length = 0;
  host.states.push(...GRAPH_TAB_PRESET_STATES(level1));
  host.cursor.v = 0;
  let tree = tab.type({ dsh, sessionId: "session-A" });

  // 进簇拿到 level=2 帧。
  const clusterG = flattenVNode(tree).find(
    (n) => n.type === "g" && n.props && String(n.props["aria-label"] || "").indexOf("项目甲") >= 0);
  assert.ok(clusterG, "簇圆可点（aria-label 可定位）");
  clusterG.props.onPointerUp();
  await flushAsync();
  assert.ok(host.states.includes(level2), "进簇后持有 level=2 图谱帧");

  host.cursor.v = 0;
  tree = tab.type({ dsh, sessionId: "session-A" });
  const backBtn = findButton(tree, "返回");
  assert.ok(backBtn, "二级视图有「返回」按钮");
  backBtn.props.onClick();
  // 点击后、flush 前断言：同步阶段图谱 state 仍持有上一帧数据，不出现被清空的 null。
  assert.ok(host.states.includes(level2), "返回后仍持有上一帧图谱数据，不被清空");
  await flushAsync();
  assert.ok(host.states.includes(level1), "返回重拉后持有 level=1 帧（首屏数据在位）");
});

test("S7 图谱时间线跳转 focusTarget：走不带 level 的全量兼容路径，节点视图照常", async () => {
  const host = makeStatefulReact();
  const tab = await mountGraphTabForS7(host);
  const calls = [];
  const fullGraph = {
    scope: "amber",
    nodes: [
      { id: "spk-1", title: "跳转目标卡", summary: null, vitality: "evergreen", revision: 1, hitCount: 1, lastHitAt: null, createdAt: null },
      { id: "spk-2", title: "邻卡", summary: null, vitality: "ephemeral", revision: 1, hitCount: 0, lastHitAt: null, createdAt: null },
    ],
    edges: [{ source: "spk-1", target: "spk-2", rel: null }],
    deliveries: [],
    deliveryStats: { rounds: 0, totalDelivered: 0, uniqueCards: 0 },
  };
  const dsh = { call: async (method, session, payload) => { calls.push({ method, session, payload }); return fullGraph; } };

  host.states.length = 0;
  host.states.push(...GRAPH_TAB_PRESET_STATES(fullGraph));
  host.cursor.v = 0;
  // focusTarget 在途（时间线跳转）：即使预置的是带 clusters 的数据也不渲染簇。
  host.states[0] = { ...graphLevel1Fixture(), nodes: fullGraph.nodes, edges: fullGraph.edges };
  const tree = tab.type({
    dsh, sessionId: "session-A",
    focusTarget: { type: "spark", id: "spk-1", seq: 1 },
  });
  const text = collectText(tree);
  assert.ok(text.includes("跳转目标卡"), "节点视图渲染（跳转路径不破）");
  assert.equal(flattenVNode(tree).filter((n) => n.type === "circle").length, 2,
    "focusTarget 在途不渲染簇圆（走全量节点视图）");
  // 刷新走兼容路径：payload 不带 level（与 candidates 页全量调用同一形状）。
  findButton(tree, "刷新").props.onClick();
  await flushAsync();
  assert.deepEqual(calls[0], { method: "getGraph", session: "session-A", payload: {} },
    "focusTarget 在途的刷新走全量兼容路径");
});

test("S7-rework P4：level=2 簇为空 → 空态文案是「该簇暂无卡片」，不冒充「scope 无 active 卡」", async () => {
  const host = makeStatefulReact();
  const tab = await mountGraphTabForS7(host);
  const emptyLevel2 = {
    scope: "amber",
    level: 2,
    cluster: { key: "幽灵簇", label: "幽灵簇", count: 0 },
    nodes: [],
    edges: [],
    deliveries: [],
    deliveryStats: { rounds: 0, totalDelivered: 0, uniqueCards: 0 },
  };
  host.states.length = 0;
  host.states.push(...GRAPH_TAB_PRESET_STATES(emptyLevel2));
  // GraphTab useState 第 9 个是 activeCluster（S7 新增）：预置为已进簇状态。
  host.states[8] = "幽灵簇";
  host.cursor.v = 0;
  const tree = tab.type({ dsh: { call: async () => emptyLevel2 }, sessionId: "session-A" });
  const text = collectText(tree);
  assert.ok(text.includes("该簇（幽灵簇）暂无卡片"), "空簇按 clusterLabel 给专属空态");
  assert.equal(text.includes("当前 scope 无 active 卡"), false, "不冒充 scope 级空态");
});

test("S7-rework P2：A 会话进簇 → 切到 B —— 首个请求必须是 level=1 且不带 cluster，面包屑回「全部」", async () => {
  const host = makeStatefulReact();
  const tab = await mountGraphTabForS7(host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      return payload && payload.level === 2 ? graphLevel2Fixture() : graphLevel1Fixture();
    },
  };

  host.states.length = 0;
  host.states.push(...GRAPH_TAB_PRESET_STATES(graphLevel1Fixture()));
  host.cursor.v = 0;
  let tree = tab.type({ dsh, sessionId: "session-A" });
  host.effects.length = 0; // 挂载期的 effect 由预置 state 覆盖，不跑

  // A 会话进簇「项目甲」→ level=2。
  const clusterG = flattenVNode(tree).find(
    (n) => n.type === "g" && n.props && String(n.props["aria-label"] || "").indexOf("项目甲") >= 0);
  assert.ok(clusterG, "A 会话簇圆可点");
  clusterG.props.onPointerUp();
  await flushAsync();
  assert.deepEqual(calls.at(-1).payload, { level: 2, cluster: "项目甲" }, "A 进簇发的是 level=2");
  assert.equal(host.states[8], "项目甲", "A 会话 activeCluster 记下簇 key");

  // 切到 B：重渲染（props.sessionId 变化），手动跑本轮注册的 effects（模拟 React 重跑）。
  host.cursor.v = 0;
  tree = tab.type({ dsh, sessionId: "session-B" });
  for (const effect of host.effects.splice(0)) effect();
  await flushAsync();

  assert.deepEqual(calls.at(-1), { method: "getGraph", session: "session-B", payload: { level: 1 } },
    "切会话后的首个请求是 level=1 且不带 cluster（P2 修复点；旧实现会带 {level:2,cluster:旧簇名}，必红）");
  assert.equal(host.states[8], null, "activeCluster 已随切会话复位");
  host.cursor.v = 0;
  tree = tab.type({ dsh, sessionId: "session-B" });
  const text = collectText(tree);
  assert.equal(text.includes("全部 › 项目甲"), false, "面包屑不再挂旧簇名");
  assert.ok(text.includes("3 张"), "B 会话首屏重新渲染簇圆（level=1 到货）");
});
