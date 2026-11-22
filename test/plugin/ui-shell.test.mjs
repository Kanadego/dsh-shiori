// U8 全局壳层测试：sticky 壳条 / toast 三态 / 需重启提示 / tab 图标。
// 证据级别与 test/plugin/client.test.mjs 一致：真实执行 client/index.js
//（fake window.__ModuleLoader__ + stub react + 真实宿主 zod 经绝对 file URL 导入），
// toast/横幅为纯 DOM 组件，用最小 fake document + 可控假定时器驱动（SYNTHETIC，
// 非浏览器实机）。不触真实宿主 RPC，不修改任何既有测试文件。

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const NPM_GLOBAL = process.env.DSH_NPM_GLOBAL
  ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
const HOST_MODULES = process.env.DSH_HOST_MODULES ?? join(NPM_GLOBAL, "@deepseek-ai", "dsh", "node_modules");

// 宿主 zod（与 client.test.mjs 同源：真实安装树内 zod）。
const zod = await import(`file:///${HOST_MODULES}/zod/index.js`);

// ---------------------------------------------------------------------------
// 装载 bundle（照 client.test.mjs 的 harness）
// ---------------------------------------------------------------------------

const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
await import(pathToFileURL(join(WORKQ, "client", "index.js")).href);

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: "Fragment",
  useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: () => ({ current: null }),
};

function loadClientModule() {
  assert.equal(registrations.length, 1, "bundle registers exactly once");
  const registration = registrations[0];
  assert.equal(registration.id, "dsh-shiori");
  return registration.factory((name) => {
    if (name === "zod") return zod;
    if (name === "react") return reactStub;
    throw new Error(`unexpected require: ${name}`);
  });
}

async function mountSection(mod, ctxExtra = {}) {
  let renderSlot = null;
  const ctx = {
    remote: { $mount: async () => async () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
    ...ctxExtra,
  };
  const cleanup = await mod.apply(ctx);
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  const tree = sectionVNode.type(sectionVNode.props); // stub react：组件函数真执行
  return { ctx, cleanup, sectionVNode, tree };
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

// ---------------------------------------------------------------------------
// 最小 fake document（toast/横幅为纯 DOM 组件；只覆盖 client/index.js 实际用到
// 的 createElement / getElementById / head / body / appendChild / removeChild）。
// ---------------------------------------------------------------------------

function makeFakeElement(tagName) {
  const el = {
    tagName,
    id: "",
    className: "",
    textContent: "",
    type: undefined,
    attrs: {},
    children: [],
    parentNode: null,
    onclick: null,
    setAttribute(key, value) { el.attrs[String(key)] = String(value); },
    appendChild(child) { child.parentNode = el; el.children.push(child); return child; },
    removeChild(child) {
      const index = el.children.indexOf(child);
      if (index >= 0) el.children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
  };
  return el;
}

function makeFakeDocument() {
  const created = [];
  const head = makeFakeElement("head");
  const body = makeFakeElement("body");
  const doc = {
    head,
    body,
    createElement(tagName) {
      const el = makeFakeElement(tagName);
      created.push(el);
      return el;
    },
    getElementById(id) {
      return created.find((el) => el.id === id) || null;
    },
  };
  return { doc, created };
}

// 可控假定时器：替换 globalThis.setTimeout/clearTimeout，advance(ms) 推进时间。
// 只在 toast 自动消失用例内短暂安装，finally 还原（node:test 自身不受影响）。
function installFakeTimers() {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const state = { now: 0, timers: [], clearedLive: 0 };
  globalThis.setTimeout = (fn, ms) => {
    const timer = { fn, at: state.now + (ms || 0) };
    state.timers.push(timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => {
    const index = state.timers.indexOf(timer);
    if (index >= 0) {
      state.timers.splice(index, 1);
      state.clearedLive += 1;
    }
  };
  return {
    advance(ms) {
      state.now += ms;
      const due = state.timers.filter((timer) => timer.at <= state.now);
      for (const timer of due) {
        const index = state.timers.indexOf(timer);
        if (index >= 0) {
          state.timers.splice(index, 1);
          timer.fn();
        }
      }
    },
    pendingCount: () => state.timers.length,
    clearedCount: () => state.clearedLive,
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    },
  };
}

async function withFakeDomAndTimers(run) {
  const fake = makeFakeDocument();
  const previousDocument = globalThis.document;
  globalThis.document = fake.doc;
  const timers = installFakeTimers();
  try {
    await run({ fake, timers });
  } finally {
    timers.restore();
    globalThis.document = previousDocument;
  }
}

function toastHostOf(fake) {
  return fake.doc.body.children.find((el) => el.className === "dshi_toasts") || null;
}

function toastsOf(fake, kind = null) {
  const host = toastHostOf(fake);
  const all = host ? host.children : [];
  return kind ? all.filter((el) => el.attrs["data-kind"] === kind) : all;
}

function bannerOf(fake) {
  return fake.doc.body.children.find((el) => el.attrs["data-role"] === "restart-banner") || null;
}

// 从 fake document 里取 ensureStyle 注入的 CSS 文本。
function styleTextOf(fake) {
  const tag = fake.created.find((el) => el.id === "dsh-shiori-style");
  return tag ? tag.textContent : "";
}

// ---------------------------------------------------------------------------
// a) sticky 壳条
// ---------------------------------------------------------------------------

test("U8 壳层：选择器行与 tab 栏包进壳条、壳条不吸顶（S2-4 取消遮挡）；工作区默认卡进选择器行（S2-3）", async () => {
  const fake = makeFakeDocument();
  const previousDocument = globalThis.document;
  globalThis.document = fake.doc;
  try {
    const mod = loadClientModule();
    const { cleanup, tree } = await mountSection(mod);
    const sticky = flattenVNode(tree).find((n) => n.type === "div" && n.props.className === "dshi_sticky");
    assert.ok(sticky, "渲染出 .dshi_sticky 容器");
    const inside = flattenVNode(sticky);
    // 会话选择器（首帧 sessions 未出 → input 分支）在壳条内。
    assert.ok(inside.some((n) => n.type === "input" && n.props.placeholder === "session id"), "会话选择器在壳条内");
    // 0.5-13-4：八页签（概览 / 专题记忆 / 专题整理 / 闪回 / 人设与核心 /
    // 投递体检 / 最近变更 / 设置）都在壳条内。
    const tabs = inside.filter((n) => n.type === "button" && String(n.props.className).includes("dshi_tab"));
    assert.equal(tabs.length, 8, "tab 栏在壳条内（八页签）");
    // 提示行不粘：壳条外仍有 hint 容器位（壳条本身不包含 dshi_hint 提示行）。
    assert.equal(flattenVNode(sticky).filter((n) => n.type === "div" && n.props.className === "dshi_hint").length, 0, "提示行不进壳条");
    // S2-3：选择器统一进一条水平行（选工作区 / 选会话 / 记忆卡 / 工作区默认卡 同容器）。
    const selectorRow = inside.find((n) => n.type === "div" && n.props["data-role"] === "selector-row");
    assert.ok(selectorRow, "壳条内有 .dshi_selectorRow 选择器行");
    const rowInside = flattenVNode(selectorRow);
    assert.ok(rowInside.some((n) => n.type === "input" && n.props.placeholder === "session id"), "会话选择器在选择器行内");
    assert.ok(rowInside.some((n) => n.type === "button" && n.props["data-role"] === "persona-card-btn"), "记忆卡按钮在选择器行内");
    assert.ok(rowInside.some((n) => n.props && n.props["data-role"] === "default-persona"), "工作区默认卡控件在选择器行内");
    const css = styleTextOf(fake);
    // S2-4：壳条整体不吸顶——不再有 position:sticky/top/z-index 遮挡组合。
    assert.ok(css.includes(".dshi_sticky{display:flex;flex-direction:column;"),
      "壳条保留布局块样式（不吸顶）");
    assert.equal(css.includes(".dshi_sticky{position:sticky"), false,
      "壳条不再 position:sticky（取消吸顶遮挡）");
    assert.equal(css.includes("z-index:30"), false, "壳条不再占用层叠顺序");
    // S2-3：水平行 + 窄屏换行 + 控件等高（修「记忆卡：amber」与下拉错位）。
    assert.ok(css.includes(".dshi_selectorRow{display:flex;align-items:flex-end;"), "选择器行 flex 水平排列");
    assert.ok(css.includes(".dshi_selectorRow{display:flex;align-items:flex-end;gap:var(--dshi-space-sm);flex-wrap:wrap}"),
      "窄屏换行（flex-wrap:wrap）");
    assert.ok(css.includes(".dshi_selectorRow .dshi_btn,.dshi_selectorRow .dshi_input,.dshi_selectorRow .dshi_select{height:28px;"),
      "选择器行控件统一 28px 高度（基线对齐）");
    await cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

// ---------------------------------------------------------------------------
// d) tab 图标 + label 冻结
// ---------------------------------------------------------------------------

// 0.5-13-4：用户拍板的八页签信息架构（唯一被授权重写的 tab 冻结清单）。
const TAB_LABELS = ["概览", "专题记忆", "专题整理", "闪回", "人设与核心", "投递体检", "最近变更", "设置"];
const TAB_IDS = ["overview", "topics", "candidates", "flashbacks", "soul", "delivery", "timeline", "budgets"];

test("U8 tab：八项 label 逐字一致、顺序固定，每项带图标（伪元素图形 + 每 tab 专属 mask）", async () => {
  const fake = makeFakeDocument();
  const previousDocument = globalThis.document;
  globalThis.document = fake.doc;
  try {
    const mod = loadClientModule();
    const { cleanup, tree } = await mountSection(mod);
    const tabs = flattenVNode(tree).filter((n) => n.type === "button" && String(n.props.className).includes("dshi_tab"));
    assert.equal(tabs.length, 8);
    // label 一个字都不许改（与 R8 断言同口径：children join 后逐项比较）。
    assert.deepEqual(tabs.map((n) => [].concat(n.children).join("")), TAB_LABELS);
    // 图标节点存在：按钮带 dshi_tabIco + 每 tab 专属类；图标本体是 CSS mask
    // 伪元素（不改按钮 DOM 形状，label 仍是唯一 children）。
    for (let i = 0; i < TAB_IDS.length; i++) {
      const className = String(tabs[i].props.className);
      assert.ok(className.includes("dshi_tabIco"), "图标标记类：" + TAB_IDS[i]);
      assert.ok(className.includes("dshi_tabIco-" + TAB_IDS[i]), "专属图标类：" + TAB_IDS[i]);
      assert.equal([].concat(tabs[i].children).join(""), TAB_LABELS[i], "children 仍是纯 label：" + TAB_IDS[i]);
    }
    const css = styleTextOf(fake);
    assert.ok(css.includes(".dshi_tabIco::before{content:\"\""), "图标伪元素声明存在");
    assert.ok(css.includes("mask:var(--dshi-tab-ico)"), "图标走 CSS mask 渲染");
    for (const id of TAB_IDS) {
      assert.ok(css.includes(`.dshi_tabIco-${id}{--dshi-tab-ico:url('data:image/svg+xml,`), "每 tab 专属内联 SVG：" + id);
    }
    // 不许用 emoji：label 全部来自冻结清单，且图标不进入 children。
    await cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

// 0.5-13-4：旧 id 别名（status / memory / graph）必须仍可挂载并渲染对应合并页，
// 高亮落在新 id 的 tab 上——不许死路由、不许灰 tab。
test("U8 tab 别名：status/memory/graph 旧 id 仍挂载对应页（概览 / 专题记忆 / 闪回），高亮落在新 id", async () => {
  const cases = [
    { tab: "status", components: ["StatusTab"], label: "概览" },
    // 13-5：专题记忆页只剩专题索引（记忆内容编辑段已并入人设与核心页）。
    { tab: "memory", components: ["TopicsTab"], label: "专题记忆" },
    { tab: "graph", components: ["GraphTab", "FlashbacksTab"], label: "闪回" },
  ];
  for (const entry of cases) {
    const { host, render, cleanup } = await mountSectionStateful(s4PanelPreset({ tab: entry.tab }));
    try {
      host.cursor.v = 0;
      const tree = render();
      const flat = flattenVNode(tree);
      for (const name of entry.components) {
        assert.ok(flat.some((n) => typeof n.type === "function" && n.type.name === name),
          entry.tab + " 别名渲染 " + name);
      }
      assert.equal(flat.some((n) => n.props && n.props["data-role"] === "topic-view-memory"), false,
        entry.tab + "：不再挂载 topic-view-memory（13-5 去重）");
      assert.equal(flat.some((n) => typeof n.type === "function" && n.type.name === "MemoryTab"), false,
        entry.tab + "：MemoryTab 已删除，不再渲染");
      const onTab = flat.find((n) => n.type === "button" && String(n.props.className).includes("dshi_tabOn"));
      assert.ok(onTab, entry.tab + "：有且仅有一个高亮 tab");
      assert.equal(collectText(onTab), entry.label, entry.tab + " 高亮落在 " + entry.label);
      // 别名不额外长 tab：仍恰好 8 个 tab 按钮。
      assert.equal(flat.filter((n) => n.type === "button" && String(n.props.className).includes("dshi_tab")).length, 8,
        entry.tab + "：别名不增加 tab 数量");
    } finally {
      await cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// b) toast 三态 + 自动消失（假定时器）+ 手动关闭 + 卸载清理
// ---------------------------------------------------------------------------

test("U8 toast：三态渲染（成功/失败/需重启）、可叠多条、定时器推进后自动消失", async () => {
  await withFakeDomAndTimers(async ({ fake, timers }) => {
    const mod = loadClientModule();
    const { ctx, cleanup } = await mountSection(mod);
    assert.ok(ctx.shioriNotify && typeof ctx.shioriNotify.toast === "function", "可复用入口经 ctx 下发");
    ctx.shioriNotify.toast("success", "已保存");
    ctx.shioriNotify.toast("error", "保存失败：boom");
    ctx.shioriNotify.toast("restart", "需要重启");
    assert.equal(toastsOf(fake).length, 3, "右下角浮层可叠多条");
    assert.deepEqual(toastsOf(fake).map((el) => el.attrs["data-kind"]), ["success", "error", "restart"]);
    // 每条都有文本与手动关闭按钮。
    for (const el of toastsOf(fake)) {
      assert.equal(el.children[0].className, "dshi_toastText");
      assert.ok(String(el.children[0].textContent).length > 0, "toast 文本非空");
      assert.equal(el.children[1].className, "dshi_toastClose");
    }
    // 成功约 3 秒自动消失；失败/需重启约 6 秒（假定时器推进）。
    timers.advance(3000);
    assert.deepEqual(toastsOf(fake).map((el) => el.attrs["data-kind"]), ["error", "restart"], "成功 3s 自动消失");
    timers.advance(3000);
    assert.equal(toastsOf(fake).length, 0, "失败/需重启 6s 自动消失");
    assert.equal(toastHostOf(fake).children.length, 0);
    assert.ok(timers.pendingCount() === 0, "无残留定时器");
    await cleanup();
  });
});

test("U8 toast：手动关闭立即移除并清理定时器（不泄漏）", async () => {
  await withFakeDomAndTimers(async ({ fake, timers }) => {
    const mod = loadClientModule();
    const { ctx } = await mountSection(mod);
    const el = ctx.shioriNotify.toast("error", "失败");
    assert.equal(toastsOf(fake).length, 1);
    assert.equal(timers.pendingCount(), 1, "挂着一个自动消失定时器");
    const close = el.children[1];
    close.onclick();
    assert.equal(toastsOf(fake).length, 0, "手动关闭后立即移除");
    assert.equal(timers.pendingCount(), 0, "定时器被清理");
    assert.ok(timers.clearedCount() >= 1, "clearTimeout 被调用");
    ctx.shioriNotify.dispose();
  });
});

test("U8 toast：未知 kind 回退为失败样式，卸载（cleanup）清理全部定时器与节点", async () => {
  await withFakeDomAndTimers(async ({ fake, timers }) => {
    const mod = loadClientModule();
    const { ctx, cleanup } = await mountSection(mod);
    ctx.shioriNotify.toast("nonsense", "未知类型");
    ctx.shioriNotify.toast("success", "待清理");
    assert.deepEqual(toastsOf(fake).map((el) => el.attrs["data-kind"]), ["error", "success"], "未知 kind 回退 error");
    assert.equal(timers.pendingCount(), 2);
    await cleanup();
    assert.equal(timers.pendingCount(), 0, "卸载清理全部定时器");
    assert.equal(toastHostOf(fake), null, "toast 宿主节点已从 body 摘除");
    assert.equal(bannerOf(fake), null, "横幅一并摘除");
  });
});

// ---------------------------------------------------------------------------
// c) 需重启强提示：toast + 页内横幅
// ---------------------------------------------------------------------------

test("U8 需重启：组合入口同时出 toast 与页内横幅；横幅只留一条、可关闭、再次触发刷新文案", async () => {
  await withFakeDomAndTimers(async ({ fake, timers }) => {
    const mod = loadClientModule();
    const { ctx } = await mountSection(mod);
    ctx.shioriNotify.restart("第一批配置需重启生效");
    assert.equal(toastsOf(fake, "restart").length, 1, "「需重启」toast 出现");
    const banner = bannerOf(fake);
    assert.ok(banner, "页内可见横幅出现");
    assert.ok(collectFakeText(banner).includes("第一批配置需重启生效"), "横幅文案透传");
    // 再次触发：横幅只保留一条，文案刷新。
    ctx.shioriNotify.restart("第二批配置需重启生效");
    assert.equal(toastsOf(fake, "restart").length, 2, "toast 可叠加");
    assert.equal(bannerOf(fake), banner, "横幅复用同一节点");
    assert.ok(collectFakeText(banner).includes("第二批配置需重启生效"), "横幅文案刷新");
    // 手动关闭横幅。
    banner.children[1].onclick();
    assert.equal(bannerOf(fake), null, "横幅手动关闭");
    // toast 仍走 6s 自动消失。
    timers.advance(6000);
    assert.equal(toastsOf(fake).length, 0, "需重启 toast 自动消失");
    ctx.shioriNotify.dispose();
  });
});

function collectFakeText(node, out = []) {
  if (node.textContent) out.push(node.textContent);
  for (const child of node.children) collectFakeText(child, out);
  return out.join("");
}

// ---------------------------------------------------------------------------
// c) BudgetsTab 保存成功 → 需重启提示；保存失败 → 只失败 toast
// （照 client.test.mjs mountBudgetsTab 的 fake configForms scope 口径）
// ---------------------------------------------------------------------------

const FULL_BUDGETS = {
  core: { targetChars: 8000, hardCapChars: 10000, softRatio: 0.75, hardRatio: 0.9, cacheLockFallback: false },
  persona: { maxChars: 12000 },
  spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 },
};

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

// 保存流程的异步 flush 必须走真实定时器：假定时器用例里 globalThis.setTimeout
// 已被替换，用它会永远挂起（这里在模块加载期捕获真实引用）。
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const flush = (ms = 20) => new Promise((resolve) => realSetTimeout(resolve, ms));

async function mountBudgetsViaSection(scope) {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((name) => (name === "react" ? host.react : zod));
  let renderSlot = null;
  const ctx = {
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
    configForms: { get: (ns) => (ns === "shiori" ? scope : undefined) },
  };
  const cleanup = await mod.apply(ctx);
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push("budgets", "session-A", "", null, undefined);
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const tab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "BudgetsTab");
  assert.ok(tab, "BudgetsTab reached through real slot render");
  return { host, tab, cleanup, ctx };
}

async function budgetsSaveScenario(scope) {
  const { host, tab, cleanup, ctx } = await mountBudgetsViaSection(scope);
  const restartCalls = [];
  const render = () => {
    host.cursor.v = 0;
    return tab.type({
      dsh: { call: async () => ({}), configScope: () => scope },
      sessionId: "session-A",
      // 记录调用后转发到壳层 ctx 入口：既验证接线（props.notifyRestart 被调），
      // 又让真实 toast/横幅出现在 fake document 上。
      notifyRestart: (text) => { restartCalls.push(text); ctx.shioriNotify.restart(text); },
    });
  };
  host.states.length = 0;
  host.cursor.v = 0;
  host.states.push(scope.getSnapshot(), null, null);
  const form = flattenVNode(render()).find((n) => n.type === "form");
  assert.ok(form, "form present");
  form.props.onSubmit({ preventDefault: () => {} });
  await flush(20);
  const tree = render();
  return { tree, restartCalls, cleanup };
}

test("U8 BudgetsTab：保存成功出现「需重启」toast 与页内横幅（通知回调恰好一次）", async () => {
  const fake = makeFakeDocument();
  const previousDocument = globalThis.document;
  globalThis.document = fake.doc;
  let disposer = async () => {};
  try {
    const state = { revision: 3, written: structuredClone(FULL_BUDGETS) };
    const scope = {
      getSnapshot: () => ({ status: "ready", revision: state.revision, value: { budgets: structuredClone(state.written) } }),
      mutate: (ops, revision) => {
        state.written = structuredClone(ops[0].value);
        state.revision += 1;
        return Promise.resolve(true);
      },
    };
    const { tree, restartCalls, cleanup } = await budgetsSaveScenario(scope);
    disposer = cleanup;
    assert.match(collectText(tree), /已保存/, "okText 仍说清已保存与生效时机");
    assert.match(collectText(tree), /宿主重启后生效/, "okText 仍说明重启生效");
    assert.equal(restartCalls.length, 1, "需重启通知恰好一次");
    assert.equal(toastsOf(fake, "restart").length, 1, "「需重启」toast 出现");
    assert.ok(bannerOf(fake), "页内横幅出现");
    assert.ok(collectFakeText(bannerOf(fake)).includes("宿主重启后生效"), "横幅说明生效时机");
    assert.equal(toastsOf(fake, "error").length, 0, "成功路径无失败 toast");
  } finally {
    await disposer(); // 清掉 toast 定时器与节点，不把真实 6s 定时器留给事件循环
    globalThis.document = previousDocument;
  }
});

test("U8 BudgetsTab：保存失败只出失败 toast，绝不出现需重启提示", async () => {
  await withFakeDomAndTimers(async ({ fake }) => {
    const scope = {
      getSnapshot: () => ({ status: "ready", revision: 3, value: { budgets: structuredClone(FULL_BUDGETS) } }),
      mutate: () => Promise.reject(Object.assign(new Error("boom"), { code: "shiori/denied" })),
    };
    const { tree, restartCalls, cleanup } = await budgetsSaveScenario(scope);
    try {
      assert.doesNotMatch(collectText(tree), /已保存/, "失败路径无已保存文案");
      assert.equal(restartCalls.length, 0, "需重启通知回调未触发");
      assert.equal(toastsOf(fake, "restart").length, 0, "无需重启 toast");
      assert.equal(bannerOf(fake), null, "无页内横幅");
      const errors = toastsOf(fake, "error");
      assert.equal(errors.length, 1, "只出失败 toast");
      assert.ok(collectFakeText(errors[0]).includes("预算保存失败"), "失败 toast 点明保存失败");
      assert.ok(collectFakeText(errors[0]).includes("shiori/denied"), "失败 toast 带错误码");
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// S2 侧边栏独立入口：main 全屏槽位 + sidebar.panellist 图标，与详情页入口并存。
// 槽位写法对齐 dsh-email 的 workbench register 模板（lib/client.js:136-141）。
// ---------------------------------------------------------------------------

// 捕获 apply 里全部 register 调用（含顺序与 meta/render），供 S2 断言用；
// register 返回的 disposer 会记录被释放的槽位名，供 cleanup 断言用。
async function mountCapturingSlots(ctxExtra = {}) {
  const calls = [];
  const disposed = [];
  const mod = loadClientModule();
  const ctx = {
    remote: { $mount: async () => async () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { calls.push({ meta, render }); return () => { disposed.push(meta.name); }; },
    },
    ...ctxExtra,
  };
  const cleanup = await mod.apply(ctx);
  return { calls, cleanup, disposed };
}

// 执行一次组件函数（stub react：hooks 走 reactStub，样式注入走 fake document）。
function renderComponent(vnode, fake) {
  const previousDocument = globalThis.document;
  globalThis.document = fake;
  try {
    return vnode.type(vnode.props);
  } finally {
    globalThis.document = previousDocument;
  }
}

test("S2 槽位：apply 依次注册 assistant-actions / main / sidebar.panellist / plugins.bundle.config，main 带 workbench:true，bundle.config 仍是最后一次注册", async () => {
  const fake = makeFakeDocument();
  const { calls, cleanup, disposed } = await mountCapturingSlots();
  try {
    assert.deepEqual(
      calls.map((c) => c.meta.name),
      ["conversation.chat.assistant-actions", "main", "sidebar.panellist", "plugins.bundle.config"],
      "四个槽位按序注册，bundle.config 收尾（最后一次 register 获胜语义不变）",
    );
    // main 槽位：key=shiori，inject 下发 workbench:true（dsh-email 模板口径）。
    const main = calls.find((c) => c.meta.name === "main");
    assert.equal(main.meta.key, "shiori", "main 槽位 key=shiori");
    assert.deepEqual(main.meta.inject(), { workbench: true }, "main 槽位 inject 带 workbench:true");
    // 渲染进 main 槽位（宿主把 inject 结果并入 props）：复用 ShioriSection，
    // 根容器切换为全屏 scope class 并标 data-main=true。
    const mainVNode = main.render({ workbench: true });
    assert.equal(typeof mainVNode.type, "function", "main 槽位渲染面板组件（复用 PanelView）");
    const mainRoot = renderComponent(mainVNode, fake.doc);
    assert.equal(mainRoot.type, "div", "main 根为 div 容器");
    assert.equal(mainRoot.props.className, "dshi_root dshi_rootMain", "main 槽位根挂全屏 scope class");
    assert.equal(mainRoot.props["data-main"], "true", "main 槽位根标 data-main=true");
    // sidebar.panellist：id=shiori、order=60、label=记忆。
    const sidebar = calls.find((c) => c.meta.name === "sidebar.panellist");
    assert.equal(sidebar.meta.id, "shiori", "sidebar.panellist id=shiori");
    assert.equal(sidebar.meta.order, 60, "sidebar.panellist order=60");
    assert.equal(sidebar.meta.label, "记忆", "sidebar.panellist label=记忆");
    // 图标渲染：内联 SVG（评审 q-315cc6110122fd8d 拍板 B 方案——client bundle 拿不到
    // 自身资源 URL，img 引包内 icon.png 实机大概率 404；png 留给市场与配置页）。
    const iconVNode = sidebar.render({ size: 18 });
    const icon = iconVNode.type(iconVNode.props);
    assert.equal(icon.type, "svg", "侧边栏图标为内联 svg 元素");
    assert.equal(icon.props.className, "dshi_sideIcon", "图标带 scope class");
    assert.equal(icon.props.width, 18, "图标宽度随 size 下发");
    assert.equal(icon.props.height, 18, "图标高度随 size 下发");
    assert.equal(icon.props.viewBox, "0 0 24 24", "viewBox 与宿主图标同一套");
    assert.equal(icon.props.stroke, "currentColor", "描边随宿主文字色");
    assert.equal(icon.props.strokeWidth, 1.75, "描边宽度 1.75（宿主图标口径）");
    assert.equal(icon.props["aria-hidden"], true, "装饰性图标 aria-hidden（可访问名来自宿主 label=记忆）");
    assert.ok(Array.isArray(icon.children) && icon.children.length >= 1, "书页线稿 path 存在");
    // 宿主不传 size 时回退默认 20（评审：别写死 16，收窄时会传更小值）。
    const iconDefault = sidebar.render({}).type(sidebar.render({}).props).props;
    assert.equal(iconDefault.width, 20, "size 缺省回退 20");
    // 侧边栏收窄时宿主传更小值（评审 attempt-1：补 size=16 缩放断言）。
    const iconSmallVNode = sidebar.render({ size: 16 });
    const iconSmall = iconSmallVNode.type(iconSmallVNode.props).props;
    assert.equal(iconSmall.width, 16, "size=16 时图标宽度随宿主收窄");
    assert.equal(iconSmall.height, 16, "size=16 时图标高度随宿主收窄");
    // 详情页入口并存：bundle.config 仍渲染窄卡片根（无全屏 scope class）。
    const detail = calls[calls.length - 1];
    assert.equal(detail.meta.name, "plugins.bundle.config", "详情页槽位仍在");
    assert.equal(detail.meta.key, "dsh-shiori", "详情页 key=dsh-shiori 不回归");
    const detailVNode = detail.render({ entryKey: "dsh-shiori" });
    const detailRoot = renderComponent(detailVNode, fake.doc);
    assert.equal(detailRoot.props.className, "dshi_root", "详情页根仍是 860px 窄卡片布局");
    assert.ok(!("data-main" in detailRoot.props), "详情页根不输出 data-main 属性");
    // 卸载真的释放两个新槽位的 disposer（评审 attempt-1 顺带项）。
    await cleanup();
    assert.ok(disposed.includes("main"), "cleanup 释放 main 槽位 disposer");
    assert.ok(disposed.includes("sidebar.panellist"), "cleanup 释放 sidebar.panellist 槽位 disposer");
    assert.ok(disposed.includes("plugins.bundle.config"), "cleanup 释放详情页槽位 disposer");
  } finally {
    // fake document 无 removeChild 之外的清理需求。
  }
});

test("S2 门控：main 槽位抛错或缺失时不得注册 sidebar.panellist（不留点了没落点的死按钮），详情页入口不受影响", async () => {
  // 与 mountCapturingSlots 同款记录桩，但 slots.inject 可按槽位名注入故障
  //（抛错 / 返回非函数），register 仍记录全部注册调用。
  async function mountWithSlotInject(injectImpl) {
    const calls = [];
    const mod = loadClientModule();
    const ctx = {
      remote: { $mount: async () => async () => {} },
      slots: {
        inject: injectImpl,
        register: (meta, render) => { calls.push({ meta, render }); return () => {}; },
      },
    };
    const cleanup = await mod.apply(ctx);
    return { calls, cleanup };
  }
  // ① main 槽位注册抛错：静默跳过 main 与 sidebar.panellist，bundle.config 照常收尾。
  {
    const { calls } = await mountWithSlotInject((name, fn) => {
      if (name === "main") throw new Error("main slot unavailable");
      return fn();
    });
    assert.deepEqual(
      calls.map((c) => c.meta.name),
      ["conversation.chat.assistant-actions", "plugins.bundle.config"],
      "main 抛错 → main 与 sidebar.panellist 都不注册，bundle.config 仍收尾",
    );
    assert.equal(calls.find((c) => c.meta.name === "sidebar.panellist"), undefined,
      "main 不可用时绝不注册侧边栏入口");
  }
  // ② main 槽位缺失（inject 返回非函数）：同样不挂 sidebar.panellist。
  {
    const { calls } = await mountWithSlotInject((name, fn) => (name === "main" ? undefined : fn()));
    assert.deepEqual(
      calls.map((c) => c.meta.name),
      ["conversation.chat.assistant-actions", "plugins.bundle.config"],
      "main 缺失 → sidebar.panellist 不注册，详情页入口照常",
    );
    assert.equal(calls.find((c) => c.meta.name === "sidebar.panellist"), undefined,
      "main 缺失时绝不注册侧边栏入口");
  }
});

test("S2 样式：全屏容器 scope class 与侧边栏图标 CSS 声明存在（max-width/padding 覆盖窄卡片默认值；S2-4 上下留白）", async () => {
  const fake = makeFakeDocument();
  const previousDocument = globalThis.document;
  globalThis.document = fake.doc;
  try {
    const mod = loadClientModule();
    const { cleanup, tree } = await mountSection(mod);
    const css = styleTextOf(fake);
    // 全屏容器：放开 860px 限宽、吃满宿主高度、顶部/左侧让出宿主框架留白（照
    // dsh-email workbench 模板 w-page[data-main=true] 的口径），内容随宿主宽度
    // 收缩（1440 与 900 宽都不横向溢出的样式保证）。
    assert.ok(css.includes(".dshi_rootMain{box-sizing:border-box;max-width:none;width:100%;height:100%;"), "全屏容器显式 border-box（根元素不吃 .dshi_root * 重置，100% 宽高叠 padding 不再溢出）");
    // S2-4：底部补 max(28px, bottom-clearance)（侧边栏入口打开时首尾不再被裁）。
    assert.ok(
      css.includes("padding:calc(24px + var(--dsh-frame-top-clearance,0px)) 28px max(28px,var(--dsh-frame-bottom-clearance,0px)) max(28px,var(--dsh-frame-leading-clearance,0px))"),
      "全屏容器上下左右留白（frame clearance 口径 + 底部留白）",
    );
    assert.ok(css.includes("overflow:auto}"), "全屏容器自滚动");
    // S2-4：壳条整体不吸顶后，让出框架顶部的 sticky 覆盖规则不再存在。
    assert.equal(css.includes(".dshi_rootMain .dshi_sticky"), false,
      "不再有 workbench sticky top 覆盖规则（壳条已不吸顶）");
    // 侧边栏图标样式。
    assert.ok(css.includes(".dshi_sideIcon{display:block}"), "侧边栏图标 scope class 声明存在");
    // 详情页窄卡片默认值未被改动。
    assert.ok(css.includes(".dshi_root{max-width:860px;"), "详情页 860px 窄卡片默认值保留");
    await cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

// ---------------------------------------------------------------------------
// S4 选卡按钮（0.4，评审 q-b8f480de923fa65d 拍板）：sticky 壳条里的「会话顶部」
// 按钮，显示当前卡名（getStatus.scope，global 原样显示）；切换走 sessionPersonas
// 单键 read-modify-write（条目只 {sessionId, persona} 两键、清卡=persona 置 null
// 不删条目）；「记忆已随人设卡切换」提示只出现一次（组件内状态）。
// ---------------------------------------------------------------------------

// 有状态渲染整个 ShioriSection（面板 9 个 useState 预置，挂选卡交互断言）。
// wiring：{ calls, scope, status }——经真实 ctx 注入 remote.shiori 与 configForms
// （api 走 ctx.get("remote.shiori") / ctx.configForms.get("shiori")，测试 stub 不直接传 dsh）。
async function mountSectionStateful(panelPreset, wiring = {}) {
  const calls = wiring.calls || [];
  const host = makeStatefulReact();
  const mod = registrations[0].factory((name) => (name === "react" ? host.react : zod));
  let renderSlot = null;
  const shioriNamespace = {
    getStatus: async (sid, payload) => {
      calls.push({ method: "getStatus", payload });
      return { ok: true, value: wiring.status || { mode: "active", scope: "amber" } };
    },
    getMemoryView: async (sid, payload) => {
      calls.push({ method: "getMemoryView", payload });
      return { l0: { content: "", budget: 12000 }, l1: { content: "", hardCap: 14000 } };
    },
    executeTool: async () => ({ ok: true, value: {} }),
  };
  const ctx = {
    remote: { $mount: async () => async () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
  };
  // workspaces：面板「选工作区」下拉与按工作区设默认卡都读宿主快照（ctx.get("workspaces")）。
  ctx.get = (key) => (key === "remote.shiori" ? shioriNamespace : (key === "workspaces" ? wiring.workspaces : undefined));
  ctx.configForms = { get: (ns) => (ns === "shiori" ? (wiring.scope !== undefined ? wiring.scope : null) : undefined) };
  const cleanup = await mod.apply(ctx);
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push(...panelPreset);
  const render = () => {
    host.cursor.v = 0;
    host.runEffects.v = false;
    return sectionVNode.type(sectionVNode.props);
  };
  return { host, render, cleanup, calls };
}

function s4PanelPreset(overrides = {}) {
  const availability = Object.assign({
    sessionId: "session-A", blocked: false, error: null, probeError: null,
    skipped: 0, probing: false, done: true,
  }, overrides.availability || {});
  return [
    overrides.tab || "status",
    overrides.sessionId !== undefined ? overrides.sessionId : "session-A",
    "",
    overrides.sessions !== undefined ? overrides.sessions : [],
    overrides.modeStatus !== undefined ? overrides.modeStatus : { mode: "active", scope: "amber" },
    availability,
    0,
    overrides.workspaces !== undefined ? overrides.workspaces : null,
    overrides.workspaceId !== undefined ? overrides.workspaceId : "",
  ];
}

function findButton(tree, label) {
  return flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === label) || null;
}

function personaButton(tree) {
  return flattenVNode(tree).find((n) => n.type === "button" && n.props && n.props["data-role"] === "persona-card-btn") || null;
}

function personaRow(tree) {
  return flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "persona-card-row") || null;
}

function switchedHints(tree) {
  return flattenVNode(tree).filter((n) => n.props && n.props["data-role"] === "persona-switched");
}

function makeScopeForPersona(initialValue, mutations) {
  const state = { revision: 11, value: structuredClone(initialValue) };
  return {
    getSnapshot: () => ({ status: "ready", revision: state.revision, value: structuredClone(state.value) }),
    mutate: (ops, revision) => {
      mutations.push({ ops, revision });
      for (const op of ops) state.value[op.path[0]] = structuredClone(op.value);
      state.revision += 1;
      return Promise.resolve(true);
    },
  };
}

// CAS 冲突桩：第一次 mutate 带 fence 不匹配 → 返回 false 且未应用（并发写入者
// 已把 revision 顶到 12）；之后恢复正常。覆盖「mutate 返回 applied=false → 重读
// 快照重试一次成功」路径（评审 rework 非阻塞 3：此前该路径零覆盖）。
function makeCasConflictScope(initialValue, mutations) {
  const state = { revision: 11, value: structuredClone(initialValue) };
  let failFirst = true;
  return {
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
}

test("S4 选卡按钮：壳条内显示当前卡名（global 原样显示）、未选会话禁用、点击展开选卡行", async () => {
  // global：scope 为 null → 显示「记忆卡：global」；未选会话（sessionId=""）禁用。
  const { render, cleanup } = await mountSectionStateful(
    s4PanelPreset({ sessionId: "", modeStatus: { mode: "active", scope: null } }));
  try {
    let tree = render();
    let btn = personaButton(tree);
    assert.ok(btn, "壳条内渲染选卡按钮");
    assert.equal(collectText(btn), "记忆卡：global", "无卡时原样显示 global");
    assert.equal(btn.props.disabled, true, "未选会话时禁用");
    assert.equal(personaRow(tree), null, "未展开时无选卡行");
    // amber：显示当前卡名；点击展开选卡行（输入框回显当前卡名）。
    const { render: render2, cleanup: cleanup2 } = await mountSectionStateful(s4PanelPreset());
    tree = render2();
    btn = personaButton(tree);
    assert.equal(collectText(btn), "记忆卡：amber", "显示当前卡名");
    assert.equal(btn.props.disabled, false, "已选会话可点");
    assert.equal(btn.props.title.includes("记忆卡：amber"), true, "title 带全名（窄屏截断兜底）");
    btn.props.onClick();
    tree = render2();
    const row = personaRow(tree);
    assert.ok(row, "点击展开选卡行");
    const input = flattenVNode(row).find((n) => n.type === "input");
    assert.equal(input.props.value, "amber", "输入框回显当前卡名");
    assert.ok(findButton(row, "切换") && findButton(row, "清除专属卡") && findButton(row, "取消"), "切换 / 清除专属卡 / 取消三键齐备");
    await cleanup2();
  } finally {
    await cleanup();
  }
});

test("S4 切卡：sessionPersonas 单键 read-modify-write（条目 {sessionId, persona} 两键、其余条目原样保留、单键 set）", async () => {
  const calls = [];
  const mutations = [];
  const scope = makeScopeForPersona({
    mode: "active", allowActive: true, defaultPersona: "amber",
    sessionPersonas: [{ sessionId: "s-other", persona: "kappa" }, { sessionId: "session-A", persona: "amber" }],
  }, mutations);
  const { render, cleanup } = await mountSectionStateful(s4PanelPreset(), { calls, scope });
  try {
    let tree = render();
    personaButton(tree).props.onClick();
    tree = render();
    let row = personaRow(tree);
    flattenVNode(row).find((n) => n.type === "input").props.onChange({ target: { value: "  beta " } });
    tree = render();
    row = personaRow(tree);
    findButton(row, "切换").props.onClick();
    await flush(20);
    assert.equal(mutations.length, 1, "切换恰好一次 mutate");
    const sent = mutations[0];
    assert.deepEqual(sent.ops, [{
      op: "set",
      path: ["sessionPersonas"],
      value: [{ sessionId: "s-other", persona: "kappa" }, { sessionId: "session-A", persona: "beta" }],
    }], "只 set sessionPersonas 单键；条目只 {sessionId, persona} 两键；其他条目原样保留");
    assert.equal(sent.revision, 11, "带快照 revision fence");
    const getStatusAfter = calls.filter((c) => c.method === "getStatus").length;
    assert.ok(getStatusAfter >= 1, "成功后再刷一次 getStatus 让回显跟上（评审 C）");
    // 提示只出现一次：切完后连续重渲染，data-role=persona-switched 恰好 1 个。
    tree = render();
    assert.equal(switchedHints(tree).length, 1, "「记忆已随人设卡切换」恰好一条");
    tree = render();
    assert.equal(switchedHints(tree).length, 1, "再渲染仍只有一条（组件内状态，不是每渲染重复）");
    assert.equal(collectText(switchedHints(tree)[0]), "记忆已随人设卡切换", "提示文案逐字一致");
    // 选卡行已收起、草稿仍在（下次展开继续用）。
    assert.equal(personaRow(tree), null, "切换成功后选卡行收起");
    // 再展开选卡行：上一轮「已切换」提示复位（评审 attempt-3 非阻塞）。
    personaButton(tree).props.onClick();
    tree = render();
    assert.ok(personaRow(tree), "重新展开选卡行");
    assert.equal(switchedHints(tree).length, 0, "重新展开后上一轮提示已复位");
  } finally {
    await cleanup();
  }
});

test("S4 切卡 CAS 冲突：mutate 返回 false → 重读快照换新 revision 重试一次成功", async () => {
  const calls = [];
  const mutations = [];
  const scope = makeCasConflictScope({
    mode: "active", allowActive: true, defaultPersona: "amber",
    sessionPersonas: [{ sessionId: "s-other", persona: "kappa" }, { sessionId: "session-A", persona: "amber" }],
  }, mutations);
  const { render, cleanup } = await mountSectionStateful(s4PanelPreset(), { calls, scope });
  try {
    let tree = render();
    personaButton(tree).props.onClick();
    tree = render();
    const row = personaRow(tree);
    flattenVNode(row).find((n) => n.type === "input").props.onChange({ target: { value: "beta" } });
    tree = render();
    findButton(personaRow(tree), "切换").props.onClick();
    await flush(20);
    tree = render();
    // 恰好两次 mutate：第一次 fence=11 被 CAS 拒（applied=false，未应用），
    // 重读快照后第二次 fence=12 成功——不是报错收场，也不是无限重试。
    assert.equal(mutations.length, 2, "CAS false 恰好重试一次");
    assert.equal(mutations[0].revision, 11, "第一次带旧 fence");
    assert.equal(mutations[1].revision, 12, "重试前重读快照、换新 fence");
    const expectedValue = [{ sessionId: "s-other", persona: "kappa" }, { sessionId: "session-A", persona: "beta" }];
    assert.deepEqual(mutations[0].ops, [{ op: "set", path: ["sessionPersonas"], value: expectedValue }]);
    assert.deepEqual(mutations[1].ops, mutations[0].ops, "重试的 ops 与第一次一致");
    assert.equal(collectText(tree).includes("切换失败"), false, "重试成功不走失败文案");
    assert.equal(switchedHints(tree).length, 1, "成功后提示恰好一条");
  } finally {
    await cleanup();
  }
});

test("S4 切卡兜底：空卡名拒绝（不发 mutate）；清除专属卡=persona 置 null 且条目保留；失败亮错误原文", async () => {
  const calls = [];
  const mutations = [];
  const scope = makeScopeForPersona({
    mode: "active", allowActive: true, defaultPersona: "amber",
    sessionPersonas: [{ sessionId: "session-A", persona: "amber" }],
  }, mutations);
  const { render, cleanup } = await mountSectionStateful(s4PanelPreset(), { calls, scope });
  try {
    let tree = render();
    personaButton(tree).props.onClick();
    tree = render();
    let row = personaRow(tree);
    // 空卡名：清空输入 → 切换 → 本地拒绝（「卡名不能为空」），不发 mutate。
    flattenVNode(row).find((n) => n.type === "input").props.onChange({ target: { value: "   " } });
    tree = render();
    row = personaRow(tree);
    findButton(row, "切换").props.onClick();
    await flush(10);
    tree = render();
    row = personaRow(tree);
    assert.ok(collectText(row).includes("卡名不能为空"), "空串拒绝提示");
    assert.equal(mutations.length, 0, "空卡名不发 mutate");
    // 失败路径：mutate 抛错 → 错误原文可见（不静默吞）。
    const failingScope = {
      getSnapshot: scope.getSnapshot,
      mutate: () => Promise.reject(Object.assign(new Error("host refused"), { code: "shiori/denied" })),
    };
    const failing = await mountSectionStateful(s4PanelPreset(), { scope: failingScope });
    let tree2 = failing.render();
    personaButton(tree2).props.onClick();
    tree2 = failing.render();
    flattenVNode(personaRow(tree2)).find((n) => n.type === "input").props.onChange({ target: { value: "beta" } });
    tree2 = failing.render();
    findButton(personaRow(tree2), "切换").props.onClick();
    await flush(20);
    tree2 = failing.render();
    const errRow = personaRow(tree2);
    assert.ok(errRow, "失败后选卡行保持展开");
    assert.ok(collectText(errRow).includes("切换失败"), "失败文案出现");
    assert.ok(collectText(errRow).includes("host refused"), "错误原文可见（不静默吞）");
    await failing.cleanup();
    // 清除专属卡：persona 置 null，条目保留（评审 B 硬约束②）。
    // （选卡行此前是展开态：先点一下收起、再点开，回到展开态再清卡。）
    tree = render();
    personaButton(tree).props.onClick();
    tree = render();
    personaButton(tree).props.onClick();
    tree = render();
    findButton(personaRow(tree), "清除专属卡").props.onClick();
    await flush(20);
    assert.equal(mutations.length, 1, "清除恰好一次 mutate");
    assert.deepEqual(mutations[0].ops, [{
      op: "set",
      path: ["sessionPersonas"],
      value: [{ sessionId: "session-A", persona: null }],
    }], "清卡=该条目 persona 写成 null，条目不从数组删除");
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// S2-2/S2-3：工作区默认卡（壳条选择器区）。getStatus.personas 非空 → 下拉；
// 空/缺失 → 手填输入框回退。保存仍是 defaultPersona 单键 read-modify-write。
// ---------------------------------------------------------------------------

const defaultPersonaControl = (tree) =>
  flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "default-persona") || null;

test("S2-3 工作区默认卡：personas 非空 → 下拉列出卡名，回显当前值，保存只 set defaultPersona 单键", async () => {
  const calls = [];
  const mutations = [];
  const scope = makeScopeForPersona({
    mode: "active", allowActive: true, defaultPersona: "amber",
    sessionPersonas: [{ sessionId: "session-A", persona: "amber" }],
  }, mutations);
  const { render, cleanup } = await mountSectionStateful(
    s4PanelPreset({ modeStatus: { mode: "active", scope: "amber", personas: ["amber", "beta", "gamma"] } }),
    { calls, scope },
  );
  try {
    let tree = render();
    const control = defaultPersonaControl(tree);
    assert.ok(control, "选择器行渲染工作区默认卡控件");
    // 实机反馈：下拉只有一张卡时手输被回弹，datalist 又看不出能点选。
    // 最终形态：有候选 → select 直接点选，末尾留「自定义」出口（选中切手输框）；
    // 没候选 → 直接手输。
    const select = flattenVNode(control).find((n) => n.type === "select" && n.props["data-role"] === "default-persona-select");
    assert.ok(select, "有卡列表时渲染下拉可直接选");
    assert.equal(select.props.value, "amber", "回显当前 defaultPersona");
    const options = flattenVNode(select).filter((n) => n.type === "option").map((n) => n.props.value);
    assert.deepEqual(options, ["amber", "beta", "gamma", "__custom__"],
      "候选项来自 getStatus.personas，末尾是自定义出口");
    // 保存默认卡：单键 set，其余配置键不动。
    select.props.onChange({ target: { value: "beta" } });
    tree = render();
    findButton(tree, "保存默认卡").props.onClick();
    await flush(20);
    tree = render();
    assert.equal(mutations.length, 1, "保存默认卡恰好一次 mutate");
    assert.deepEqual(mutations[0].ops, [{ op: "set", path: ["defaultPersona"], value: "beta" }],
      "只 set defaultPersona 单键");
    assert.ok(collectText(tree).includes("工作区默认人设卡已保存为「beta」"), "成功提示可见");
  } finally {
    await cleanup();
  }
});

test("S2-3 工作区默认卡：personas 为空 → 手填输入框回退（不锁死），保存仍走单键写入", async () => {
  const calls = [];
  const mutations = [];
  const scope = makeScopeForPersona({
    mode: "active", allowActive: true, defaultPersona: "amber",
    sessionPersonas: [],
  }, mutations);
  const { render, cleanup } = await mountSectionStateful(
    s4PanelPreset({ modeStatus: { mode: "active", scope: "amber", personas: [] } }),
    { calls, scope },
  );
  try {
    let tree = render();
    const control = defaultPersonaControl(tree);
    assert.ok(control, "工作区默认卡控件照常渲染");
    const cardSelects = flattenVNode(control).filter((n) => n.type === "select" && n.props["data-role"] !== "default-persona-scope");
    assert.equal(cardSelects.length, 0, "空列表不渲染卡名下拉（范围选择器是另一个控件）");
    const input = flattenVNode(control).find((n) => n.type === "input");
    assert.ok(input, "回退到手填输入框");
    assert.equal(input.props.value, "amber", "回显当前 defaultPersona");
    input.props.onChange({ target: { value: "delta" } });
    tree = render();
    findButton(tree, "保存默认卡").props.onClick();
    await flush(20);
    assert.equal(mutations.length, 1, "回退路径保存一次 mutate");
    assert.deepEqual(mutations[0].ops, [{ op: "set", path: ["defaultPersona"], value: "delta" }],
      "回退路径同样只 set defaultPersona");
  } finally {
    await cleanup();
  }
});

// 2026-11-15 实机反馈：切卡只刷 getStatus 会出现「壳条显示新卡、人设卡（L0）还是旧卡」，
// 所以切卡成功后必须重取一次 getMemoryView（L0/L1 是按当前选卡解析的）。
// 13-5：展示 L0 的页面从 MemoryTab 收敛到人设与核心页（SoulTab），刷新令牌照旧透传。
test("S4 切卡：成功后 refreshToken 自增，人设与核心页重取 getMemoryView（编辑器换新卡）", async () => {
  const calls = [];
  const mutations = [];
  const scope = makeScopeForPersona({ mode: "active", allowActive: true, defaultPersona: "amber", sessionPersonas: [] }, mutations);
  const { render, cleanup } = await mountSectionStateful(s4PanelPreset({ tab: "soul" }), { calls, scope });
  const soulTab = (tree) => flattenVNode(tree).find((n) => typeof n.type === "function" && n.type.name === "SoulTab") || null;
  try {
    let tree = render();
    const before = soulTab(tree);
    assert.ok(before, "人设与核心页已挂载");
    const tokenBefore = before.props.refreshToken;
    personaButton(tree).props.onClick();
    tree = render();
    flattenVNode(personaRow(tree)).find((n) => n.type === "input").props.onChange({ target: { value: "engine" } });
    tree = render();
    findButton(personaRow(tree), "切换").props.onClick();
    await flush(20);
    const after = soulTab(render());
    assert.equal(after.props.refreshToken, tokenBefore + 1, "切卡成功后 refreshToken 自增一次");
    assert.equal(after.props.sessionId, "session-A", "会话没变（只是选卡变了）");
    // 13-5：页内「正在编辑」换卡与壳条共用同一条 personaWrite 链路（函数透传）。
    assert.equal(typeof after.props.onSwitchPersona, "function", "SoulTab 拿到壳层 onSwitchPersona");
  } finally {
    await cleanup();
  }
});

// 2026-11-15 实机反馈：面板只能设「所有工作区」的默认卡，而配置本来就有
// workspacePersonas（服务端按路径最长前缀解析）。范围=仅当前工作区时写
// workspacePersonas 单键，条目严格 {workspace, persona} 两键。
test("S2-3b 工作区默认卡：范围=仅当前工作区 → 写 workspacePersonas 单键", async () => {
  const calls = [];
  const mutations = [];
  const scope = makeScopeForPersona({
    mode: "active", allowActive: true, defaultPersona: "amber",
    sessionPersonas: [], workspacePersonas: [{ workspace: "D:/proj/other", persona: "kappa" }],
  }, mutations);
  const workspaces = [{ workspaceId: "ws-1", title: "项目A", path: "D:/proj/a", sessionIds: [] }];
  const { render, cleanup } = await mountSectionStateful(
    s4PanelPreset({ workspaceId: "ws-1", workspaces, modeStatus: { mode: "active", scope: "amber", personas: [] } }),
    { calls, scope },
  );
  try {
    let tree = render();
    const control = defaultPersonaControl(tree);
    const rangeSelect = flattenVNode(control).find((n) => n.type === "select" && n.props["data-role"] === "default-persona-scope");
    assert.ok(rangeSelect, "范围选择器存在");
    assert.equal(rangeSelect.props.disabled, false, "选定工作区后可选「仅当前工作区」");
    rangeSelect.props.onChange({ target: { value: "workspace" } });
    tree = render();
    const input = flattenVNode(defaultPersonaControl(tree)).find((n) => n.type === "input");
    input.props.onChange({ target: { value: "  beta " } });
    tree = render();
    findButton(tree, "保存默认卡").props.onClick();
    await flush(20);
    assert.equal(mutations.length, 1, "按工作区保存一次 mutate");
    assert.deepEqual(mutations[0].ops, [{
      op: "set",
      path: ["workspacePersonas"],
      value: [{ workspace: "D:/proj/other", persona: "kappa" }, { workspace: "D:/proj/a", persona: "beta" }],
    }], "只 set workspacePersonas；其它工作区条目原样保留；条目只 {workspace, persona}");
  } finally {
    await cleanup();
  }
});

