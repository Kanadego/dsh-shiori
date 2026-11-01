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

test("U8 壳层：工作区/会话选择器与 tab 栏包进 sticky 壳条，CSS 声明存在", async () => {
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
    // 八个 tab 按钮都在壳条内（F2 闪回命中 + F4 最近变更各加一项）。
    const tabs = inside.filter((n) => n.type === "button" && String(n.props.className).includes("dshi_tab"));
    assert.equal(tabs.length, 8, "tab 栏在壳条内");
    // 提示行不粘：壳条外仍有 hint 容器位（壳条本身不包含 dshi_hint 提示行）。
    assert.equal(flattenVNode(sticky).filter((n) => n.type === "div" && n.props.className === "dshi_hint").length, 0, "提示行不进壳条");
    const css = styleTextOf(fake);
    assert.ok(css.includes(".dshi_sticky{position:sticky;top:0;"), "sticky CSS 声明存在（position:sticky + top）");
    assert.ok(css.includes("z-index:30"), "壳条带层叠顺序");
    await cleanup();
  } finally {
    globalThis.document = previousDocument;
  }
});

// ---------------------------------------------------------------------------
// d) tab 图标 + label 冻结
// ---------------------------------------------------------------------------

const TAB_LABELS = ["状态", "最近变更", "记忆 L0/L1", "图谱", "候选 / 计划", "L3/topic 记忆管理", "闪回命中", "预算配置"];
const TAB_IDS = ["status", "timeline", "memory", "graph", "candidates", "topics", "flashbacks", "budgets"];

test("U8 tab：八项 label 逐字一致（含 F2/F4 两项新增），每项带图标（伪元素图形 + 每 tab 专属 mask）", async () => {
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
