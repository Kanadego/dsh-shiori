// 0.3 UI 四点改动的定向回归（各改动 ≥1 条断言，独立成文件，不动既有测试）：
//   1. 图谱四角标签：画布边界纳入锚点判定 + 钳回画布渲染（不再被 viewBox 裁掉），
//      「可见标签两两不相交、不压节点圆」承诺保持；
//   2. 最近变更分页：wire 批量 TIMELINE_PAGE_SIZE=20、界面每页 LIST_PAGE_SIZE=10
//      （0.4 显示层分页：批内翻页纯本地、跨批才发请求）；
//   3. 记忆上限两页同源同口径：MemoryTab 按 l1.hardCap（硬顶）显示，与状态页
//      occupancy.l1HardCap 同一真值；L0 取 l0.budget，不再走 budgets.persona 兜底；
//   4. 整理与遗忘页收敛为只做遗忘：整理入口 / 整理候选组 / 整理计划卡移除，
//      遗忘分析与计划预览执行、手动归档入口保留。
// 证据级别与 ui-memory / ui-timeline 一致：真实执行 client/index.js（fake
// window.__ModuleLoader__ + 有状态 react stub + 真实宿主 zod），组件函数真执行
//（SYNTHETIC，非浏览器实机）。不触真实宿主 RPC。

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
// harness（与 ui-memory / client.test.mjs 同构：有状态 react stub）
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

async function settle() {
  for (let i = 0; i < 5; i++) {
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function findButton(tree, label) {
  return flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === label);
}

function findButtons(tree, label) {
  return flattenVNode(tree).filter((n) => n.type === "button" && collectText(n) === label);
}

// 通过真实 slot 渲染定位指定 tab 组件（与 client.test.mjs mountTabById 同构）。
async function mountTabById(tabId, tabName) {
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
  return { host, renderTab, tab };
}

// ---------------------------------------------------------------------------
// 改动 1：图谱四角标签（画布边界纳入锚点判定 + 钳回画布）
// ---------------------------------------------------------------------------

// 与 client.test.mjs crowdedGraphPayload 同款：40 节点长标题 + 链状边，
// 力布局归一化后挤在画布内，分离收尾可能把节点推到 [30,770]×[30,350] 边缘。
function crowdedGraphPayload(count) {
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push({
      id: "spk-" + i,
      title: "记忆卡片标题" + i + "号是一句比较长的卡片名字",
      vitality: "ephemeral", state: "active", revision: 1,
      degree: i % 5,
    });
  }
  const edges = [];
  for (let i = 0; i < count - 1; i++) edges.push({ from: "spk-" + i, to: "spk-" + (i + 1) });
  return { nodes, edges };
}

const LBL = { wide: 10, narrow: 6, margin: 4, height: 12, gap: 2, nodePad: 2 };
function labelWidthOf(text) {
  let w = LBL.margin;
  for (let i = 0; i < text.length; i++) w += text.charCodeAt(i) < 0x80 ? LBL.narrow : LBL.wide;
  return w;
}
function rectsCollide(a, b, gap) {
  return !(a.x >= b.x + b.w + gap || b.x >= a.x + a.w + gap
    || a.y >= b.y + b.h + gap || b.y >= a.y + a.h + gap);
}
function graphLabels(tree) {
  return flattenVNode(tree).filter((n) => n.type === "text" && String(n.props.className) === "dshi_nodeLabel");
}
function graphCircles(tree) {
  return flattenVNode(tree).filter((n) => n.type === "circle");
}
function labelRectOfEl(textEl) {
  const kids = [].concat(textEl.children);
  const visible = kids.filter((c) => typeof c === "string").join("");
  const w = labelWidthOf(visible);
  const anchor = textEl.props.textAnchor || "start";
  const x = anchor === "end" ? textEl.props.x - w
    : anchor === "middle" ? textEl.props.x - w / 2 : textEl.props.x;
  return { visible, rect: { x, y: textEl.props.y - LBL.height / 2, w, h: LBL.height } };
}

test("0.3-1 图谱：任何渲染出的标签矩形都完整落在 800×460 viewBox 内（四角/贴边标签不再被裁掉），且两两不相交、不压节点圆", async () => {
  const payload = crowdedGraphPayload(40);
  // 挂载并跑完 load effect（getGraph → states[0]）
  const mounted = await mountTabById("graph", "GraphTab");
  const dsh2 = { call: async (method) => (method === "getGraph" ? payload : {}) };
  mounted.host.states.length = 0;
  mounted.renderTab(dsh2, "session-A", { effects: true });
  for (const fn of mounted.host.effects.splice(0)) fn();
  await settle();
  const tree = mounted.renderTab(dsh2, "session-A");
  const labels = graphLabels(tree).map(labelRectOfEl);
  const circles = graphCircles(tree);
  assert.equal(circles.length, 40, "40 个节点全部渲染");
  assert.ok(labels.length > 0, "至少渲染了一个标签");
  // ① 新口径：标签矩形一律完整在画布内（0.3 前允许排到画布外被 viewBox 裁掉）
  for (const label of labels) {
    const r = label.rect;
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 800 && r.y + r.h <= 460,
      `标签完整落在 viewBox 内（got x=${r.x}, y=${r.y}, w=${r.w}, h=${r.h}）`);
  }
  // ② 既有承诺不回退：可见标签两两不相交（留 2px 间距）
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      assert.ok(!rectsCollide(labels[i].rect, labels[j].rect, LBL.gap),
        `可见标签 ${i} 与 ${j} 不相交`);
    }
  }
  // ③ 既有承诺不回退：标签不压任何节点圆（方框近似）
  const nodeBoxes = circles.map((c) => {
    const pad = c.props.r + LBL.nodePad;
    return { x: c.props.cx - pad, y: c.props.cy - pad, w: pad * 2, h: pad * 2 };
  });
  for (const label of labels) {
    for (const box of nodeBoxes) {
      assert.ok(!rectsCollide(label.rect, box, 0), "标签矩形不与节点圆相交");
    }
  }
  // ④ 钳回是确定性的：同一份数据再渲染一次，标签排布完全一致
  const again = graphLabels(mounted.renderTab(dsh2, "session-A")).map(labelRectOfEl)
    .map((l) => ({ x: l.rect.x, y: l.rect.y, w: l.rect.w, visible: l.visible }));
  const first = labels.map((l) => ({ x: l.rect.x, y: l.rect.y, w: l.rect.w, visible: l.visible }));
  assert.deepEqual(again, first, "同一份数据两次渲染标签排布完全一致（钳回无随机）");
});

// ---------------------------------------------------------------------------
// 改动 2：最近变更分页（0.4：wire 批量 TIMELINE_PAGE_SIZE=20、界面每页 LIST_PAGE_SIZE=10）
// ---------------------------------------------------------------------------

function timelineItem() {
  return {
    at: "2026-11-01T10:30:00.000Z", action: "spark.save", source: "spark",
    scope: "amber", target: { type: "spark", id: "abcd1234abcd1234abcd", title: "会议纪要" }, detail: {},
  };
}
function pageDto(fields) {
  return Object.assign({ scope: "amber", items: [], hasMore: false, skippedCorrupted: 0, scanLimited: false }, fields);
}

function countTimelineItems(tree) {
  return flattenVNode(tree).filter((n) => n.props && n.props.className === "dshi_item").length;
}

test("0.3-2 最近变更：界面每页 10 条——整批请求 limit=20 只显示前 10 条、批内翻页纯本地不发请求、跨批才步进 offset=20、页脚文案跟随界面分页", async () => {
  const { host, renderTab } = await mountTabById("timeline", "TimelineTab");
  const calls = [];
  // 整批 20 条（一批 = 两个显示页）：只有批内条目数 ≥ 11 才能真正鉴别
  // 「界面每页 10 条」——批不满一页时旧冻结用例的批外请求路径也会被走到。
  const items = Array.from({ length: 20 }, (_, i) => Object.assign(timelineItem(), {
    target: { type: "spark", id: "abcd1234abcd1234abcd", title: "批内条目-" + String(i).padStart(2, "0") },
  }));
  const dsh = {
    call: async (method, session, payload) => {
      // 0.5-13-4：TimelineTab 还会探测温度审计 / auto run（合并流），只记录
      // getTimeline 的 wire 调用，避免首屏探测混进分页断言。
      if (method === "getTimeline") calls.push(payload);
      return pageDto({ items, hasMore: true });
    },
  };
  // 首页：states 从空初始化（page=null → effect load(offset=0)），再重渲染读最新 state
  host.states.length = 0;
  let tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  assert.deepEqual(calls[0], { offset: 0, limit: 20 }, "首页仍整批请求 limit=20（wire 协议不变）");
  tree = renderTab(dsh, "session-A");
  assert.equal(countTimelineItems(tree), 10, "界面每页只显示 10 条（0.4 显示层分页）");
  let text = collectText(tree);
  assert.ok(text.includes("批内条目-00"), "首页显示第 1 条");
  assert.ok(!text.includes("批内条目-10"), "首页不显示第 11 条");
  assert.ok(text.includes("界面每页显示 10 条"), "页脚文案跟随界面每页 10 条");

  // 批内翻页：下一页纯本地切片，不发请求
  calls.length = 0;
  const next = findButton(tree, "下一页");
  assert.ok(next && next.props.disabled !== true, "有本地下一页 → 下一页可用");
  next.props.onClick();
  tree = renderTab(dsh, "session-A");
  assert.deepEqual(calls, [], "批内「下一页」纯本地切片，不发 RPC");
  assert.equal(countTimelineItems(tree), 10, "第二显示页仍每页 10 条");
  text = collectText(tree);
  assert.ok(text.includes("批内条目-10"), "第二显示页展示第 11 条");
  assert.ok(!text.includes("批内条目-00"), "第二显示页不再展示第 1 条");

  // 跨批：再点一次「下一页」才以 offset=20 请求下一批
  const next2 = findButton(tree, "下一页");
  assert.ok(next2 && next2.props.disabled !== true, "批内页耗尽 → 下一页仍可用");
  next2.props.onClick();
  tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  assert.deepEqual(calls, [{ offset: 20, limit: 20 }], "跨批翻页以 offset=20（整批 20 条）请求");
});

// ---------------------------------------------------------------------------
// 改动 3：记忆上限两页同源同口径（L1 硬顶 / L0 l0.budget）
// ---------------------------------------------------------------------------

function memoryViewDto(l0Fields, l1Fields, budgets) {
  return Object.assign({
    scope: "amber",
    l0: Object.assign({ text: "# 人设卡标题\n常驻身份说明", revision: "r0", chars: 12, stale: false }, l0Fields),
    l1: Object.assign({
      text: "CORE BODY\n\n## 主题记忆索引\n- a [amber] — A",
      body: "CORE BODY", revision: "r1", chars: 60,
    }, l1Fields),
  }, budgets === undefined ? {} : { budgets });
}

async function mountSoulTab() {
  // 13-5：记忆编辑从专题记忆页（MemoryTab）并入「人设与核心」页（SoulTab）。
  // SoulTab 的 state 顺序：status / view / loadError / editKind。
  const { host, tab } = await mountTabById("soul", "SoulTab");
  return (dsh, view, editKind) => {
    host.states.length = 0;
    host.states[0] = null;
    host.states[1] = view === undefined ? null : view;
    host.states[2] = null;
    host.states[3] = editKind || "l0";
    host.cursor.v = 0;
    host.runEffects.v = false;
    return tab.type({ dsh, sessionId: "session-A" });
  };
}

test("0.3-3 记忆上限：L1 按硬顶显示（l1.hardCap 优先于 l1.budget），L0 用 l0.budget（不走 budgets.persona 兜底）", async () => {
  const render = await mountSoulTab();
  const dsh = { call: async () => ({}) };
  // 真实 DTO（getMemoryView）：l1.hardCap=14000 与 l1.budget=8000 同时在——必须取 14000
  const view = memoryViewDto(
    { chars: 12, budget: 9000 },
    { chars: 60, hardCap: 14000, budget: 8000 },
    { persona: { maxChars: 7777 }, core: { targetChars: 8000 } },
  );
  const l0Text = collectText(render(dsh, view, "l0"));
  assert.ok(l0Text.includes("上限 9000 字（不计入水位）"), "L0 上限取 l0.budget（不再读 budgets.persona）");
  assert.ok(!l0Text.includes("7777 字"), "budgets.persona 不再参与上限兜底");
  const l1Text = collectText(render(dsh, view, "l1"));
  assert.ok(l1Text.includes("上限 14000 字（计水位）"), "L1 上限取 l1.hardCap（硬顶口径，与状态页 l1HardCap 同源）");
  assert.ok(!l1Text.includes("上限 8000 字"), "l1.budget 在硬顶存在时不作为上限");
});

test("0.3-3 记忆上限：DTO 缺 hardCap/budget 时如实显示「—」，不再按 budgets.core.hardCapChars 或常量 14000 本地推算", async () => {
  const render = await mountSoulTab();
  const dsh = { call: async () => ({}) };
  // 老宿主：DTO 无 budgets、l1 只有 chars——SoulTab 只认 DTO，取不到就显示「—」。
  const bare = collectText(render(dsh, memoryViewDto({}, { chars: 60 }), "l1"));
  assert.ok(bare.includes("上限 — 字（计水位）"), "缺字段如实显示「—」");
  assert.ok(!bare.includes("14000"), "不再回落常量 14000");
  // 中间层 view.budgets.core.hardCapChars 存在也不参与：本页不做本地推算。
  const withBudgets = collectText(render(dsh, memoryViewDto({}, { chars: 60 },
    { core: { hardCapChars: 12345 } }), "l1"));
  assert.ok(withBudgets.includes("上限 — 字（计水位）"), "budgets.core.hardCapChars 不参与本页上限");
  assert.ok(!withBudgets.includes("12345 字"), "不显示推算值");
});

// ---------------------------------------------------------------------------
// 改动 4：整理与遗忘页收敛为只做遗忘
// ---------------------------------------------------------------------------

// CandidatesTab useState 顺序（0.3）：data / error / busy / proposal(槽位保留) /
// preview / previewError / guard / titles / filter / search / topics。
function candidateLoadedStates(data) {
  return [data, null, false, "", null, null, { sessionId: "session-A", gen: 0 }];
}

async function mountCandidatesWithStates(data) {
  const { host, renderTab } = await mountTabById("candidates", "CandidatesTab");
  // states 预置一次后跨渲染保留（异步 setPreview / setTopics 在重渲染时可见）
  host.states.length = 0;
  host.states.push(...candidateLoadedStates(data));
  const render = (dsh) => {
    host.cursor.v = 0;
    host.runEffects.v = false;
    return renderTab(dsh, "session-A");
  };
  return { host, render };
}

const forgettingPlan = { planId: "fp-1", kind: "forgetting", executed: false, superseded: false };
const organizePlan = { planId: "op-1", kind: "organize", executed: false, superseded: false };

test("0.3-4 专题整理页：tab 名「专题整理」；旧整理入口与候选/计划卡全部消失，只留索引归档与分组管理", async () => {
  // tab 名经真实 section 渲染读取
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
  const tabLabels = flattenVNode(sectionVNode.type(sectionVNode.props))
    .filter((n) => n.type === "button" && String((n.props && n.props.className) || "").includes("dshi_tab"))
    .map((n) => [].concat(n.children).join(""));
  assert.ok(tabLabels.includes("专题整理"), "tab 改名（0.5-13-4：遗忘 → 专题整理）");
  assert.ok(!tabLabels.includes("整理与遗忘"), "旧 tab 名消失");

  const data = {
    queueRevision: 5,
    items: [{ candidate: { id: "cluster-A", kind: "cluster", scopeId: "default", sources: [{ id: "s1" }, { id: "s2" }], evidence: { field: "entities", sharedTerm: "项目X" } }, status: "pending" }],
    plans: [organizePlan, forgettingPlan],
  };
  const { render } = await mountCandidatesWithStates(data);
  const tree = render({ call: async () => data });
  const text = collectText(tree);
  // 0.5.0 转正：候选审阅与计划整块下线（含分析遗忘候选），只留两块互斥手风琴。
  for (const label of ["分析整理候选", "预览整理计划", "合并进主题", "高级：手动编辑 proposal", "分析遗忘候选"]) {
    assert.equal(findButton(tree, label), undefined, label + " 已下线");
  }
  assert.ok(!text.includes("集群（"), "整理候选三组（集群）组头移除");
  assert.ok(!text.includes("孤立卡（"), "整理候选三组（孤立）组头移除");
  assert.ok(!text.includes("op-1") && !text.includes("fp-1"), "计划卡不再展示");
  // 索引归档默认展开；分组管理在收起的另一块里。
  assert.ok(flattenVNode(tree).some((n) => n.props && n.props["data-role"] === "organize-acc-head-archive"), "索引归档手风琴头在");
  assert.ok(flattenVNode(tree).some((n) => n.props && n.props["data-role"] === "organize-acc-head-groups"), "分组管理手风琴头在");
  assert.ok(findButton(tree, "载入 / 刷新专题"), "手动归档入口保留");
});

test("0.3-4 遗忘页：手动归档入口——「载入 / 刷新专题」后「移出索引」发 previewPlan {kind:'archive-topic',topicKey,archive:true} 恰三键", async () => {
  const data = { queueRevision: 5, items: [], plans: [] };
  const calls = [];
  const { render } = await mountCandidatesWithStates(data);
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, payload });
      if (method === "listCandidates") return data;
      if (method === "executeTool" && payload.name === "memory_list_topics") {
        return { topics: [{ key: "t-live", title: "活", summary: "s", updated: "2026-10-26T10:00:00.000Z", revision: "shiori-r1.Liv.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }] };
      }
      if (method === "previewPlan") {
        return { kind: "organize", planId: "plan-AT", planDigest: "digest-AT", summary: "archive-topic plan", diff: [] };
      }
      return {};
    },
  };
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新专题").props.onClick();
  await flush();
  tree = render(dsh);
  const row = flattenVNode(tree).find((n) => n.type === "div" && n.props.key === "t-live");
  assert.ok(row, "专题行渲染");
  const removeBtn = flattenVNode(row).find((n) => n.type === "button" && collectText(n) === "移出索引");
  assert.ok(removeBtn, "未归档行有「移出索引」");
  removeBtn.props.onClick();
  await flush();
  const previewCall = calls.find((c) => c.method === "previewPlan");
  assert.ok(previewCall, "previewPlan sent on 移出索引 click");
  assert.deepEqual(previewCall.payload, { kind: "archive-topic", topicKey: "t-live", archive: true },
    "archive-topic preview payload 恰三键（协议不变）");
  tree = render(dsh);
  assert.ok(collectText(tree).includes("专题归档"), "归档确认卡标题渲染");
  assert.ok(collectText(tree).includes("把专题『t-live』移出 L1 索引"), "方向与专题名可见");
});
