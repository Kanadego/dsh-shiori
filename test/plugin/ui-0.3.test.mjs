// 0.3 UI 四点改动的定向回归（各改动 ≥1 条断言，独立成文件，不动既有测试）：
//   1. 图谱四角标签：画布边界纳入锚点判定 + 钳回画布渲染（不再被 viewBox 裁掉），
//      「可见标签两两不相交、不压节点圆」承诺保持；
//   2. 最近变更分页：TIMELINE_PAGE_SIZE 100 → 20；
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

test("0.3-1 图谱：任何渲染出的标签矩形都完整落在 800×380 viewBox 内（四角/贴边标签不再被裁掉），且两两不相交、不压节点圆", async () => {
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
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= 800 && r.y + r.h <= 380,
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
// 改动 2：最近变更分页 100 → 20
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

test("0.3-2 最近变更：每页 20 条——请求 limit=20、翻页 offset 步进 20、页脚文案跟随常量", async () => {
  const { host, renderTab } = await mountTabById("timeline", "TimelineTab");
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push(payload);
      return pageDto({ items: [timelineItem()], hasMore: true });
    },
  };
  // 首页：states 从空初始化（page=null → effect load(offset=0)），再重渲染读最新 state
  host.states.length = 0;
  let tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  assert.deepEqual(calls[0], { offset: 0, limit: 20 }, "首页以 limit=20 请求");
  tree = renderTab(dsh, "session-A");
  assert.ok(collectText(tree).includes("（每页 20 条）"), "页脚文案跟随 TIMELINE_PAGE_SIZE");

  // 翻页：下一页以 offset=20 请求
  calls.length = 0;
  const next = findButton(tree, "下一页");
  assert.ok(next && next.props.disabled !== true, "hasMore=true → 下一页可用");
  next.props.onClick();
  tree = renderTab(dsh, "session-A", { effects: true });
  for (const fn of host.effects.splice(0)) fn();
  await flush();
  assert.deepEqual(calls, [{ offset: 20, limit: 20 }], "下一页以 offset=20（每页 20 条）请求");
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

async function mountMemoryTab() {
  const { host, tab } = await mountTabById("memory", "MemoryTab");
  // 与 ui-memory.test.mjs 同款：view 预置进 states[0]（直接调组件，不走 load effect）
  return (dsh, view) => {
    host.states.length = 0;
    host.states[0] = view === undefined ? null : view;
    host.cursor.v = 0;
    host.runEffects.v = false;
    return tab.type({ dsh, sessionId: "session-A" });
  };
}

test("0.3-3 记忆上限：L1 按硬顶显示（l1.hardCap 优先于 l1.budget），L0 用 l0.budget（不走 budgets.persona 兜底）", async () => {
  const render = await mountMemoryTab();
  const dsh = { call: async () => ({}) };
  // 真实 DTO（getMemoryView）：l1.hardCap=14000 与 l1.budget=8000 同时在——必须取 14000
  const view = memoryViewDto(
    { chars: 12, budget: 9000 },
    { chars: 60, hardCap: 14000, budget: 8000 },
    { persona: { maxChars: 7777 }, core: { targetChars: 8000 } },
  );
  const text = collectText(render(dsh, view));
  assert.ok(text.includes("60 / 14000 UTF-16"), "L1 上限取 l1.hardCap（硬顶口径，与状态页 l1HardCap 同源）");
  assert.ok(text.includes("12 / 9000 UTF-16"), "L0 上限取 l0.budget（不再读 budgets.persona）");
  assert.ok(!text.includes("7777 UTF-16"), "budgets.persona 不再参与 Bar 上限兜底（DTO 明细区原样透出不算）");
});

test("0.3-3 记忆上限：老宿主 DTO 无 l1.hardCap/budget 时按 budgets.core.hardCapChars → 常量 14000 兜底，口径仍与状态页一致", async () => {
  const render = await mountMemoryTab();
  const dsh = { call: async () => ({}) };
  // 老宿主：DTO 无 budgets、l1 只有 chars——落常量 14000（硬顶口径，不再是 targetChars 8000）
  const bare = collectText(render(dsh, memoryViewDto({}, { chars: 60 })));
  assert.ok(bare.includes("60 / 14000 UTF-16"), "全缺兜底常量为 14000（硬顶口径）");
  assert.ok(!bare.includes("8000 UTF-16"), "不再按 targetChars=8000 显示");
  // 中间层：view.budgets.core.hardCapChars 存在时优先于常量
  const withBudgets = collectText(render(dsh, memoryViewDto({}, { chars: 60 },
    { core: { hardCapChars: 12345 } })));
  assert.ok(withBudgets.includes("60 / 12345 UTF-16"), "budgets.core.hardCapChars 参与兜底链");
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

test("0.3-4 遗忘页：tab 名「遗忘」；整理入口（分析整理候选 / 预览整理计划 / 合并进主题）与整理计划卡全部消失，分析遗忘候选保留", async () => {
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
  assert.ok(tabLabels.includes("遗忘"), "tab 改名只讲遗忘");
  assert.ok(!tabLabels.includes("整理与遗忘"), "旧 tab 名消失");

  const data = {
    queueRevision: 5,
    items: [{ candidate: { id: "cluster-A", kind: "cluster", scopeId: "default", sources: [{ id: "s1" }, { id: "s2" }], evidence: { field: "entities", sharedTerm: "项目X" } }, status: "pending" }],
    plans: [organizePlan, forgettingPlan],
  };
  const { render } = await mountCandidatesWithStates(data);
  const tree = render({ call: async () => data });
  const text = collectText(tree);
  assert.ok(findButton(tree, "分析遗忘候选"), "分析遗忘候选保留");
  assert.equal(findButton(tree, "分析整理候选"), undefined, "分析整理候选移除");
  assert.equal(findButton(tree, "预览整理计划"), undefined, "预览整理计划移除");
  assert.equal(findButton(tree, "合并进主题"), undefined, "合并进主题移除");
  assert.equal(findButton(tree, "高级：手动编辑 proposal"), undefined, "整理 proposal 高级调试区移除");
  assert.ok(!text.includes("集群（"), "整理候选三组（集群）组头移除");
  assert.ok(!text.includes("可建链接（"), "整理候选三组（可链接）组头移除");
  assert.ok(!text.includes("孤立卡（"), "整理候选三组（孤立）组头移除");
  assert.ok(!text.includes("op-1"), "整理类计划卡不再展示（kind=organize 被过滤）");
  assert.ok(text.includes("fp-1"), "遗忘计划照常展示");
  assert.ok(findButton(tree, "稍后再说") && findButton(tree, "忽略"), "候选审阅动作保留");
  assert.ok(findButton(tree, "预览遗忘计划"), "遗忘计划预览入口保留");
  assert.ok(findButton(tree, "载入 / 刷新专题"), "手动归档入口保留");
});

test("0.3-4 遗忘页：候选审阅「稍后再说」仍发 decision=reviewed（协议不变）", async () => {
  const data = {
    queueRevision: 5,
    items: [{ candidate: { id: "cluster-A", kind: "cluster", scopeId: "default", sources: [{ id: "s1" }, { id: "s2" }], evidence: {} }, status: "pending" }],
    plans: [],
  };
  const calls = [];
  const { render } = await mountCandidatesWithStates(data);
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, payload });
      if (method === "listCandidates") return data;
      return {};
    },
  };
  let tree = render(dsh);
  findButton(tree, "稍后再说").props.onClick();
  await flush();
  const reviewed = calls.find((c) => c.method === "reviewCandidate");
  assert.ok(reviewed, "reviewCandidate issued");
  assert.equal(reviewed.payload.decision, "reviewed", "协议 decision 不变");
  assert.equal(reviewed.payload.candidateId, "cluster-A", "candidate.id 仍取业务 id");
});

test("0.3-4 遗忘页：遗忘计划「预览遗忘计划」→ 确认卡 →「确认执行」发出 executePlan（confirmed:true）", async () => {
  const data = { queueRevision: 5, items: [], plans: [forgettingPlan] };
  const calls = [];
  const { render } = await mountCandidatesWithStates(data);
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, payload });
      if (method === "listCandidates") return data;
      if (method === "previewPlan") {
        return { kind: "forgetting", planId: "fp-1", planDigest: "digest-1", summary: "archive 2 ephemeral card(s)", diff: [] };
      }
      if (method === "executePlan") return { executed: true };
      return {};
    },
  };
  let tree = render(dsh);
  findButton(tree, "预览遗忘计划").props.onClick();
  await flush();
  const previewCall = calls.find((c) => c.method === "previewPlan");
  assert.ok(previewCall, "previewPlan issued");
  assert.equal(previewCall.payload.kind, "forgetting", "预览走 forgetting 计划");
  assert.equal(previewCall.payload.planId, "fp-1");

  tree = render(dsh);
  assert.ok(collectText(tree).includes("按衰减分数把旧卡归档"), "遗忘预览卡有人话正文");
  const confirm = findButton(tree, "确认执行");
  assert.ok(confirm, "确认卡出现");
  confirm.props.onClick();
  await flush();
  const exec = calls.find((c) => c.method === "executePlan");
  assert.ok(exec, "executePlan issued");
  assert.equal(exec.payload.planId, "fp-1");
  assert.equal(exec.payload.planDigest, "digest-1");
  assert.equal(exec.payload.confirmed, true);
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
