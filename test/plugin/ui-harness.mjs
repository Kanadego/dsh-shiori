// 共享 UI 测试 harness（0.5 批次 3 · B 线 P2#10 第一步）。
//
// 把 ui-readonly / ui-memory 里各自组装的 fake window.__ModuleLoader__ + 有状态
// react stub + vnode 遍历工具抽到一处，并补齐 fake document 与可控定时器，供后续
// 面板用例复用；同时提供 mount() 走「组件函数 → vnode → DOM」的真实重渲染循环。
//
// 证据级别与 ui-shell / ui-memory 一致：真实执行 client/index.js（组件函数真执行，
// SYNTHETIC，非浏览器实机）；字段逐项对齐现有 fake，不凭空添加。
//
// 两层用法：
//   1) vnode 层（ui-readonly / ui-memory 迁移用）：install() 后取 registrations /
//      makeStatefulReact / flattenVNode / collectText / findButtons / findTextarea /
//      applyPanel，断言与迁移前逐字一致；
//   2) DOM 层（ui-harness.test.mjs 用）：mount() 返回 render/rerender/unmount/text/
//      html/click/flush，flush 走真实重渲染路径（状态变更 → 重新执行组件函数 →
//      DOM 更新），不是每步重建。
//
// 模块级共享：client/index.js 是单例（window.__ModuleLoader__.load 只在模块首次
// 求值时执行一次），registrations 与 import 按进程共享，多个 harness 实例复用同一
// 份 bundle。install()/restore() 只管理全局键与定时器的挂/卸，不动 registrations。
//
// 定时器策略（0.5 批次 3 attempt 2）：mount() 默认安装可控定时器，restore/unmount
// 统一走一条清理路径卸载并逐字节还原全局 setTimeout/setInterval/clearTimeout/
// clearInterval 到安装前引用。可控定时器语义对齐真实 timer：advance 按到期时间
// 排序、回调内新排且落在本窗口的定时器要跑（重入）、interval 用 at += interval
// （不丢错过周期）、Date.now 随 advance 推进、句柄带 unref/no-op。

import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const NPM_GLOBAL = process.env.DSH_NPM_GLOBAL
  ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
const HOST_MODULES = process.env.DSH_HOST_MODULES ?? join(NPM_GLOBAL, "@deepseek-ai", "dsh", "node_modules");

// 真实定时器：异步 flush 必须走真实定时器（假定时器用例内 globalThis.setTimeout
// 已被替换，用它会永远挂起；与 ui-shell 同法在模块加载期捕获）。导出供迁移后的
// vnode 层用例（ui-readonly 轮询等）复用真引用，避免误捕 harness fake。
export const realSetTimeout = globalThis.setTimeout.bind(globalThis);
export const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
export const realSetInterval = globalThis.setInterval.bind(globalThis);
export const realClearInterval = globalThis.clearInterval.bind(globalThis);

// ── 模块级共享（client 单例）──────────────────────────────────────────────
const sharedRegistrations = [];
let sharedImportDone = false;
let sharedImportPromise = null;
let sharedClientHref = null;
let sharedZod = null;

async function importClientOnce(clientSource) {
  if (sharedImportDone) return;
  if (sharedImportPromise) return sharedImportPromise;
  sharedClientHref = typeof clientSource === "string" && clientSource.startsWith("file:")
    ? clientSource : pathToFileURL(clientSource).href;
  sharedImportPromise = (async () => {
    await import(sharedClientHref);
    sharedImportDone = true;
  })();
  return sharedImportPromise;
}

async function ensureZod() {
  if (sharedZod) return sharedZod;
  sharedZod = await import(`file:///${HOST_MODULES}/zod/index.js`);
  return sharedZod;
}

// ── 有状态 react stub（与两份既有测试的 makeStatefulReact 逐字段一致）────────
//
// 下标约定（对齐 client/index.js 的合成测试约定）：
//   * useState 下标 = useState 调用顺序号（cursor.v 只被 useState 推进）。
//     这让 vnode 层测试能以 host.states[N] / PANEL_STATES=9 精确定位面板与
//     tab 的 state 槽位，与迁移前逐字一致。
//   * useRef 使用独立的 refs 数组（refCursor），不占 useState 下标。client 的
//     注释（index.js:6106/6109）明确「useRef 不占 useState 下标」。
//   * useEffect 使用独立的 effects 数组（effectCursor），不占 useState 下标。
//
// attempt 2（R4）补齐真实 React 语义：
//   * useEffect 比较 deps（Object.is 浅比较）：deps 相同则跳过（不重跑），不同则
//     先执行上一次的 cleanup 再跑新 effect；无 deps 则每次重渲染都跑。
//   * useRef 跨渲染持久：refs[refCursor] 只初始化一次，重渲染返回同一 {current}。
//   * useState 同组件内多次 set 合并：setter 只改 states[i]；render 循环由 mount 的
//     cursor 归位 + 重新执行组件函数完成，最后一次 set 生效（同真实 React 批处理）。
function makeStatefulReact() {
  const states = [];
  const refs = [];
  // effects 数组仍存「函数」（兼容 ui-readonly 的 for (const fn of effects) fn()），
  // deps / cleanup 存到并行数组 effectDeps / effectCleanups（R4 需要比较 deps + 跑清理）。
  const effects = [];
  const effectDeps = [];
  const effectCleanups = [];
  const cursor = { v: 0 };       // useState 下标
  const refCursor = { v: 0 };    // useRef 下标（独立）
  const effectCursor = { v: 0 }; // useEffect 下标（独立）
  const runEffects = { v: false };

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: "fragment",
    useState: (initial) => {
      const i = cursor.v++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      const setter = (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; };
      return [states[i], setter];
    },
    useEffect: (fn, deps) => {
      const i = effectCursor.v++;
      const prevCleanup = effectCleanups[i];
      const prevDeps = effectDeps[i];
      if (prevDeps !== undefined || prevCleanup !== undefined || effects[i] !== undefined) {
        if (deps === undefined) {
          // 无 deps：每次重渲染都跑，先清理上一次
          if (typeof prevCleanup === "function") prevCleanup();
        } else if (Array.isArray(prevDeps) && Array.isArray(deps)
          && prevDeps.length === deps.length
          && prevDeps.every((d, k) => Object.is(d, deps[k]))) {
          return; // deps 未变，跳过（保留既有 effects[i] 不重复 push）
        } else if (typeof prevCleanup === "function") {
          prevCleanup();
        }
      }
      effectDeps[i] = deps;
      if (!runEffects.v) { effectCleanups[i] = null; return; }
      // 只收集不执行：真实 effect 由 flush 统一跑（或 vnode 层用例手动 fn()）。
      // cleanup 由 flush 执行 fn 后捕获返回值，记录到 effectCleanups[i]。
      effects[i] = fn;
    },
    useMemo: (fn) => fn(),
    useRef: (initial) => {
      const i = refCursor.v++;
      if (!(i in refs)) refs[i] = { current: initial };
      return refs[i];
    },
  };
  return { react, states, refs, effects, effectDeps, effectCleanups, cursor, refCursor, effectCursor, runEffects };
}

// ── vnode 遍历工具（两份既有测试同构，此处为唯一实现）───────────────────────
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

// findButtons：按钮内任一子节点文本与 label 精确相等即命中（较 ui-readonly 的
// collectText 全等更通用，能处理按钮内多层嵌套；对「编辑/取消/保存」这类纯文本
// 按钮两者结果一致，不弱化既有断言）。
function findButtons(tree, label) {
  return flattenVNode(tree)
    .filter((n) => n.type === "button" && flattenVNode(n).some((c) => {
      if (typeof c !== "object" || c === null) return String(c) === label;
      return collectText(c) === label;
    }));
}

function findTextarea(tree) {
  return flattenVNode(tree).find((n) => n.type === "textarea");
}

// ShioriSection 自身 useState 个数（tab/sessionId/manual/sessions/modeStatus/
// availability/probeTick/workspaces/workspaceId）。
const PANEL_STATES = 9;

// ── 可控假定时器（语义对齐真实 timer，attempt 2）──────────────────────────
//
// 语义保证（R2）：
//   * advance(ms) 把 now 推进 ms，按到期时间升序依次执行到期回调；
//   * 回调内新排的定时器，若其到期时间落在本次 advance 窗口内（<= 新 now），
//     同一轮也要跑（重入）；
//   * interval 回调执行后 at += interval（不是 at = now + interval），不丢错过周期；
//   * Date.now 随 advance 推进（返回 now）；
//   * 句柄是普通对象，带 unref/no-op 与 hasRef 方法（对齐 Node Timeout 外壳）。
function makeFakeTimers() {
  const realNow = Date.now.bind(Date);
  const saved = { setTimeout: null, clearTimeout: null, setInterval: null, clearInterval: null };
  let now = 0;
  let seq = 0;
  let timers = [];

  function timerOf(fn, ms, interval) {
    const t = { id: ++seq, fn, at: now + (ms || 0), interval: interval === undefined ? null : interval };
    t.unref = () => t;
    t.ref = () => t;
    t.hasRef = () => true;
    return t;
  }

  function install() {
    saved.setTimeout = globalThis.setTimeout;
    saved.clearTimeout = globalThis.clearTimeout;
    saved.setInterval = globalThis.setInterval;
    saved.clearInterval = globalThis.clearInterval;
    globalThis.setTimeout = (fn, ms) => { const t = timerOf(fn, ms, null); timers.push(t); return t; };
    globalThis.clearTimeout = (t) => { timers = timers.filter((x) => x !== t); };
    globalThis.setInterval = (fn, ms) => { const t = timerOf(fn, ms, ms || 0); timers.push(t); return t; };
    globalThis.clearInterval = (t) => { timers = timers.filter((x) => x !== t); };
    Date.now = () => now;
  }

  function restore() {
    if (saved.setTimeout !== null) globalThis.setTimeout = saved.setTimeout;
    if (saved.clearTimeout !== null) globalThis.clearTimeout = saved.clearTimeout;
    if (saved.setInterval !== null) globalThis.setInterval = saved.setInterval;
    if (saved.clearInterval !== null) globalThis.clearInterval = saved.clearInterval;
    Date.now = realNow;
    saved.setTimeout = saved.clearTimeout = saved.setInterval = saved.clearInterval = null;
    timers.length = 0; // 清空残留（R1：restore 后 pendingCount 必须 0）
  }

  async function advance(ms) {
    const target = now + ms;
    // 按到期时间排序 + 重入：逐个 timer 把 now 推进到该 timer 的到期时刻，
    // 回调内新排的定时器基于「当前到期时间」计算 at，落在窗口内则同轮执行。
    while (true) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const idx = timers.findIndex((t) => t.at <= target);
      if (idx < 0) break;
      const t = timers.splice(idx, 1)[0];
      now = t.at; // 推进到该 timer 的到期时间（重入 timer 以此为基准）
      t.fn();
      if (t.interval !== null) {
        t.at += t.interval; // 不丢错过周期
        timers.push(t);
      }
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    }
    now = target; // 最终推进到目标时刻
  }

  return {
    install, restore, advance,
    pendingCount: () => timers.length,
    pending: () => timers,
    now: () => now,
  };
}

// ── fake document（被 client 的 ensureStyle / toast / visibilitychange 用到的子集）─
//
// 5D 合成布局模型（SYNTHETIC，非真实排版引擎）：只为「开合前后按钮 offsetTop
// 不变」这条回归断言提供最小可判别口径，规则两条——
//   * offsetHeight：自身计 1，文本子节点各计 1，in-flow 元素子节点递归求和；
//   * offsetTop：同一父容器内、排在本元素之前的 in-flow 兄弟高度之和；
//   * 子元素 style.position === "fixed" 按「脱离布局」计 0 贡献——这正是 5D
//     修复的核心。注意：absolute/缺失样式在本模型里按「参与布局」计，与 CSS
//     规范不同——理由是真机实测缺陷正是「absolute 版本浮层在该插槽里参与了
//     布局（className 样式没作用到插槽 DOM），把按钮顶到上一行」，模型按实测
//     缺陷建模，使「改回 absolute / 改用 className」的变异自测必然变红。
function flowChildHeight(child) {
  if (child.nodeType === 3) return 1;
  if (child.nodeType !== 1) return 0;
  if (child.style && child.style.position === "fixed") return 0; // 脱离布局
  return flowHeightOf(child);
}
function flowHeightOf(el) {
  // fragment 占位（renderVNodeToDom 对 null/boolean/数组的降级产物）按透明容器计：
  // 高度 = 子项之和，不按自身计 1——「open ? 弹层 : null」的 null 分支不该占布局。
  if (String(el.tagName || "").toUpperCase() === "FRAGMENT") {
    let height = 0;
    for (const child of el.children) height += flowChildHeight(child);
    return height;
  }
  let height = 1;
  for (const child of el.children) height += flowChildHeight(child);
  return height;
}
function flowTopOf(el) {
  const parent = el.parentNode;
  if (!parent) return 0;
  let top = 0;
  for (const child of parent.children) {
    if (child === el) break;
    top += flowChildHeight(child);
  }
  return top;
}
function makeElement(tagName) {
  return {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    children: [],
    attributes: {},
    className: "",
    id: "",
    style: {},
    _text: "",
    parentNode: null,
    // 可控锚点矩形（getBoundingClientRect 桩）：默认视口原点零矩形，用例可写
    // el._rect 覆盖（真实浏览器由布局引擎决定；沙箱由用例钉值）。
    _rect: null,
    getBoundingClientRect() {
      return Object.assign({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, this._rect || {});
    },
    // 5D 合成布局模型：offsetTop / offsetHeight 按 flowHeightOf / flowTopOf 现算。
    get offsetHeight() { return flowHeightOf(this); },
    get offsetTop() { return flowTopOf(this); },
    appendChild(child) { if (child == null) return child; child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) { this.children.splice(i, 1); child.parentNode = null; } return child; },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "id") this.id = String(value);
      else if (name === "class" || name === "className") this.className = String(value);
    },
    getAttribute(name) {
      if (name === "id") return this.id || null;
      else if (name === "class" || name === "className") return this.className || null;
      return this.attributes[name] ?? null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

function makeFakeDocument() {
  const head = makeElement("head");
  const body = makeElement("body");
  const doc = {
    nodeType: 9,
    head,
    body,
    hidden: false,
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById(id) { return findFirst(doc, (el) => el.id === String(id)); },
    querySelector(sel) { return findFirst(doc, (el) => matchesSelector(el, sel)); },
    querySelectorAll(sel) {
      const out = [];
      walk(doc, (el) => { if (matchesSelector(el, sel)) out.push(el); });
      return out;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  if (node.nodeType === 1) visit(node);
  if (node.children) for (const child of node.children) walk(child, visit);
}

function findFirst(doc, predicate) {
  let found = null;
  walk(doc, (el) => { if (found === null && predicate(el)) found = el; });
  return found;
}

function matchesSelector(el, sel) {
  const s = String(sel).trim();
  if (!s) return false;
  let tag = null;
  const tagM = s.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
  if (tagM) tag = tagM[1].toLowerCase();
  let attrName = null, attrValue = null, text = null;
  const attrRe = /\[([a-zA-Z-]+)(?:=([^\]]*))?\]/g;
  let am;
  while ((am = attrRe.exec(s)) !== null) {
    const name = am[1];
    const value = am[2] === undefined ? null : am[2].replace(/^["']|["']$/g, "");
    if (name === "text") text = value;
    else { attrName = name; attrValue = value; }
  }
  const cls = (s.match(/\.([a-zA-Z0-9_-]+)/g) || []).map((c) => c.slice(1));
  const idM = s.match(/#([a-zA-Z0-9_-]+)/);
  if (tag && el.tagName.toLowerCase() !== tag) return false;
  if (idM && el.id !== idM[1]) return false;
  for (const c of cls) if (!String(el.className || "").split(/\s+/).includes(c)) return false;
  if (attrName !== null) {
    if (attrValue === null) { if (el.getAttribute(attrName) == null) return false; }
    else if (el.getAttribute(attrName) !== attrValue) return false;
  }
  if (text !== null && collectDomText(el).indexOf(text) === -1) return false;
  return true;
}

function collectDomText(el) {
  if (!el) return "";
  if (el.nodeType === 3) return el.textContent || "";
  if (el.nodeType !== 1) return "";
  let out = "";
  for (const child of el.children) out += collectDomText(child);
  return out + (el._text || "");
}

// ── vnode → element 渲染器 ──────────────────────────────────────────────
function renderVNodeToDom(vnode, doc) {
  if (Array.isArray(vnode)) {
    const frag = makeElement("fragment");
    for (const child of vnode) frag.appendChild(renderVNodeToDom(child, doc));
    return frag;
  }
  if (vnode === null || vnode === undefined || typeof vnode === "boolean") return makeElement("fragment");
  if (typeof vnode !== "object") return doc.createTextNode(vnode);
  const { type, props, children } = vnode;
  if (type === "fragment") {
    const frag = makeElement("fragment");
    if (children) for (const child of children) frag.appendChild(renderVNodeToDom(child, doc));
    return frag;
  }
  if (typeof type === "function") return renderVNodeToDom(type(props || {}), doc);
  const el = doc.createElement(type);
  const p = props || {};
  for (const key of Object.keys(p)) {
    const value = p[key];
    if (key === "className") el.className = String(value);
    else if (key === "children") { /* children 走 children 参数 */ }
    else if (key === "style" && value && typeof value === "object") {
      // 5D：style 对象落到 el.style（此前进 attributes 变 "[object Object]"）。
      // 合成布局模型（flowHeightOf/flowTopOf）按 el.style.position 判「脱离布局」，
      // 不落 style 对象模型就失效；同时更贴近真实 DOM 语义。
      Object.assign(el.style, value);
    }
    else if (key === "ref" && value && typeof value === "object") {
      // 5D：ref 接线（真实 React 语义）。此前 ref 被当 attribute 序列化丢弃，
      // 组件里 ref.current 永远 null；接线后 FlashbackActions 才能拿到按钮元素
      // 调 getBoundingClientRect 做浮层 fixed 定位。
      value.current = el;
    }
    else if (/^on[A-Z]/.test(key) && typeof value === "function") el[key.toLowerCase()] = value;
    else el.setAttribute(key, value);
  }
  if (children) for (const child of children) el.appendChild(renderVNodeToDom(child, doc));
  return el;
}

function serializeDom(el) {
  if (!el) return "";
  if (el.nodeType === 3) return String(el.textContent || "");
  if (el.nodeType !== 1) return "";
  let out = "";
  for (const child of el.children) out += serializeDom(child);
  if (el._text) out += el._text;
  return out;
}

// ── harness 主入口 ──────────────────────────────────────────────────────
export function createUiHarness(options = {}) {
  const { clientSource } = options;

  const saved = { hadWindow: false, hadDocument: false, window: undefined, document: undefined };
  let installed = false;
  const fakeTimers = makeFakeTimers();

  async function install() {
    if (installed) return;
    // 先置 installed=true 再 import：import 抛错时 restore 也能正确回滚（R3）。
    installed = true;
    saved.hadWindow = "window" in globalThis;
    saved.hadDocument = "document" in globalThis;
    saved.window = globalThis.window;
    saved.document = globalThis.document;
    globalThis.window = { __ModuleLoader__: { load: (registration) => sharedRegistrations.push(registration) } };
    globalThis.document = makeFakeDocument();
    try {
      if (clientSource) await importClientOnce(clientSource);
    } catch (err) {
      restore();
      throw err;
    }
  }

  function restore() {
    if (!installed) return;
    if (saved.hadWindow) globalThis.window = saved.window; else delete globalThis.window;
    if (saved.hadDocument) globalThis.document = saved.document; else delete globalThis.document;
    fakeTimers.restore();
    installed = false;
  }

  async function applyPanel(host) {
    const zod = await ensureZod();
    const mod = sharedRegistrations[0].factory((n) => (n === "react" ? host.react : zod));
    let renderSlot = null;
    // 5D：捕获全部插槽注册（name → {meta, render}），供 mountSlot 挂非面板插槽
    //（如 conversation.chat.assistant-actions 的消息按钮）；renderSlot 语义不变
    //（同一插槽上下文里最后一次 register 获胜 = 面板插槽收尾）。
    const registered = {};
    await mod.apply({
      remote: { $mount: async () => () => {} },
      slots: {
        inject: (name, fn) => fn(),
        register: (meta, render) => {
          registered[meta.name] = { meta, render };
          renderSlot = render;
          return () => {};
        },
      },
    });
    const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
    return { mod, renderSlot, sectionVNode, registered };
  }

  // 共享渲染循环（mount / mountSlot 复用）：renderOnce() 由调用方执行组件函数并
  // 返回落 DOM 的 vnode，循环负责光标复位（必须在组件函数执行前）、click/find/
  // change 交互、flush（effect → 微任务排空 → 真实重渲染路径）与 unmount 清理。
  function makeRenderLoop(host, renderOnce) {
    let dom = null;

    function resetCursors() {
      host.cursor.v = 0;
      host.refCursor.v = 0;
      host.effectCursor.v = 0;
    }

    function render() {
      resetCursors();
      dom = renderOnce();
      return dom;
    }
    function rerender() {
      resetCursors();
      dom = renderOnce();
      return dom;
    }
    function text() { return collectDomText(dom); }
    function html() { return serializeDom(dom); }

    function click(selector) {
      if (!dom) return false;
      const el = findFirst(dom, (e) => matchesSelector(e, selector));
      if (!el) return false;
      const handler = el.onclick;
      if (typeof handler !== "function") return false;
      handler();
      return true;
    }

    // 0.5 批次 4 B 线：表单交互钩子（不改渲染链，只在已渲染树上定位/拨动元素）。
    // 只处理单属性选择器（与 matchesSelector 能力一致），多属性请分步 find。
    function find(selector) {
      return dom ? findFirst(dom, (e) => matchesSelector(e, selector)) : null;
    }

    function findAll(selector) {
      const out = [];
      if (dom) walk(dom, (el) => { if (matchesSelector(el, selector)) out.push(el); });
      return out;
    }

    function change(selector, value) {
      const el = find(selector);
      if (!el || typeof el.onchange !== "function") return false;
      el.onchange({ target: { value } });
      return true;
    }

    function textOf(selector) {
      const el = find(selector);
      return el ? collectDomText(el) : "";
    }

    // 5D：取单个已定位元素的文本（按文本挑按钮时配 findAll 用）。
    function textOfEl(el) {
      return collectDomText(el);
    }

    async function flush(rounds = 20) {
      // 跑收集到的 effect 函数并捕获 cleanup（供下次 deps 变化时清理）。
      // 注意：effects 下标与 effectCleanups 下标一致（effectCursor 顺序），
      // 但 splice 会打乱下标——这里按 effectCursor 顺序跑，先拷贝再清空。
      const batch = host.effects.slice();
      host.effects.length = 0;
      for (let i = 0; i < batch.length; i++) {
        const fn = batch[i];
        if (typeof fn !== "function") continue;
        const cleanup = fn();
        // cleanup 按 effect 槽位记录：重新遍历 effectCursor 对齐。
        // 简化：effects 数组下标 i 即 effectCursor 顺序（因为 useEffect 顺序追加）。
        if (typeof cleanup === "function") host.effectCleanups[i] = cleanup;
      }
      for (let i = 0; i < rounds; i++) await Promise.resolve();
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      for (let i = 0; i < rounds; i++) await Promise.resolve();
    }

    function unmount() {
      // 单一清理路径：unmount 直接复用 restore（R3）。
      restore();
      dom = null;
    }

    return { render, rerender, unmount, text, html, click, flush, host, find, findAll, change, textOf, textOfEl };
  }

  async function mount(mountProps = {}) {
    await install();
    // mount 默认安装可控定时器（R1）：restore/unmount 会统一卸载并还原。
    fakeTimers.install();
    const host = makeStatefulReact();
    host.runEffects.v = true; // 真实渲染循环：effect 驱动数据加载（getMemoryView 等）
    const { sectionVNode } = await applyPanel(host);

    const dsh = mountProps.dsh ?? { call: async () => ({}) };
    const sectionProps = { dsh, ...(mountProps.slotProps || {}) };
    const prefill = mountProps.prefillStates;

    function renderOnce() {
      if (prefill) {
        host.states.length = 0;
        for (const v of prefill) host.states.push(v);
      } else {
        host.states.length = Math.max(host.states.length, PANEL_STATES);
        if (!(0 in host.states) || host.states[0] === undefined) host.states[0] = mountProps.tab ?? "status";
        if (!(1 in host.states) || host.states[1] === undefined) host.states[1] = "session-A";
        if (!(2 in host.states) || host.states[2] === undefined) host.states[2] = "";
        if (!(3 in host.states) || host.states[3] === undefined) host.states[3] = null;
        if (!(4 in host.states) || host.states[4] === undefined) host.states[4] = mountProps.modeStatus ?? { mode: "active" };
      }
      return renderVNodeToDom(sectionVNode.type(sectionProps), globalThis.document);
    }
    return makeRenderLoop(host, renderOnce);
  }

  // 5D：按插槽名挂载非面板组件（如 conversation.chat.assistant-actions 的
  // FlashbackActions），复用 mount 的真实重渲染循环（effect → flush → 状态变更 →
  // 组件函数重执行 → DOM 更新）。props 优先级：显式 slotProps > meta.inject 注入
  //（injectArg 触发）> dsh；prefillStates 与 mount 同款（每次渲染重置 states）。
  async function mountSlot(slotName, mountProps = {}) {
    await install();
    fakeTimers.install();
    const host = makeStatefulReact();
    host.runEffects.v = true;
    const { registered } = await applyPanel(host);
    const comp = registered[slotName];
    if (!comp) throw new Error("mountSlot: slot not registered: " + slotName);
    const dsh = mountProps.dsh ?? { call: async () => ({}) };
    const injected = typeof comp.meta.inject === "function" && mountProps.injectArg !== undefined
      ? (comp.meta.inject(mountProps.injectArg) || {})
      : {};
    const slotProps = { dsh, ...injected, ...(mountProps.slotProps || {}) };
    const prefill = mountProps.prefillStates;
    function renderOnce() {
      if (Array.isArray(prefill)) {
        host.states.length = 0;
        for (const v of prefill) host.states.push(v);
      }
      // comp.render(slotProps) 返回组件 vnode；renderVNodeToDom 遇 function 类型
      // 会执行组件函数本体（光标已在 makeRenderLoop.render 里复位）。
      return renderVNodeToDom(comp.render(slotProps), globalThis.document);
    }
    const loop = makeRenderLoop(host, renderOnce);
    return { ...loop, comp, slotProps };
  }

  return {
    install, restore,
    makeStatefulReact,
    flattenVNode, collectText, findButtons, findTextarea,
    applyPanel,
    mount,
    mountSlot,
    get registrations() { return sharedRegistrations; },
    get document() { return globalThis.document; },
    timers: fakeTimers,
    PANEL_STATES,
    WORKQ,
    HOST_MODULES,
    NPM_GLOBAL,
    ensureZod,
  };
}

export { makeStatefulReact, flattenVNode, collectText, findButtons, findTextarea, PANEL_STATES };
