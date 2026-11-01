// U4 记忆 L0/L1 页：预览（markdown 安全子集）/ 编辑 / 保存冲突 / 空状态。
// 证据级别如实标注：client/index.js 的 MemoryTab 真实执行（fake window.__ModuleLoader__
// + 有状态 react stub + 真实宿主 zod），synthetic host ctx，非浏览器实机。
// harness 与 test/plugin/client.test.mjs 同法：经真实 slot 渲染函数定位 MemoryTab
// 组件 vnode，再以显式 dsh 独立调用组件函数（stub hooks 有状态，可交互后重渲染）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiori-u4-memory-"));
const NPM_GLOBAL = process.env.DSH_NPM_GLOBAL
  ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
const HOST_MODULES = process.env.DSH_HOST_MODULES ?? join(NPM_GLOBAL, "@deepseek-ai", "dsh", "node_modules");

test.after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

const zod = await import(`file:///${HOST_MODULES}/zod/index.js`);

const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
await import(pathToFileURL(join(WORKQ, "client", "index.js")).href);

// ---------------------------------------------------------------------------
// harness（与 client.test.mjs 的 makeStatefulReact / flattenVNode / collectText 同构）
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
// probeTick/workspaces/workspaceId），MemoryTab 的 state 从该下标起。
const PANEL_STATES = 9;

// 定位 MemoryTab 并返回 render(dsh)：每次调用独立渲染一次 MemoryTab
// （cursor 归位到面板 state 之后，states[9] 承载 view）。
async function mountMemoryTab() {
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
  // ShioriSection useState 顺序：tab / sessionId / manual / sessions / modeStatus。
  // runEffects 保持 false：不发任何 RPC，view 由测试直接预置。
  host.states.length = 0;
  host.states.push("memory", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const memoryTab = flattenVNode(sectionTree)
    .find((n) => typeof n.type === "function" && n.type.name === "MemoryTab");
  assert.ok(memoryTab, "MemoryTab reached through real slot render");
  return (dsh, view) => {
    host.states.length = Math.max(host.states.length, PANEL_STATES);
    host.states[PANEL_STATES] = view === undefined ? null : view;
    host.cursor.v = PANEL_STATES;
    return memoryTab.type({ dsh, sessionId: "session-A" });
  };
}

function findButtons(tree, label) {
  return flattenVNode(tree)
    .filter((n) => n.type === "button" && flattenVNode(n).some((c) => typeof c !== "object" || c === null ? String(c) === label : collectText(c) === label));
}

function findTextarea(tree) {
  return flattenVNode(tree).find((n) => n.type === "textarea");
}

function memoryViewDto(l0Text, l1Fields) {
  return {
    scope: "amber",
    l0: l0Text === undefined
      ? { text: "# 人设卡标题\n常驻身份说明", revision: "r0", chars: 12, stale: false }
      : (typeof l0Text === "string"
        ? { text: l0Text, revision: "r0", chars: l0Text.length, stale: false }
        : l0Text),
    l1: l1TextOf(l1Fields),
    budgets: { persona: { maxChars: 12000 }, core: { targetChars: 8000, hardCap: 14000 } },
  };
}

function l1TextOf(fields) {
  const l1 = Object.assign({
    text: "CORE BODY\n\n## 主题记忆索引 / Topic memory index\n- a [amber] — A",
    body: "CORE BODY",
    revision: "r1",
    chars: 60,
  }, fields ?? {});
  return l1;
}

// ---------------------------------------------------------------------------
// a) 预览态：markdown 安全子集 + XSS 字面量
// ---------------------------------------------------------------------------

test("U4 预览态：含 <script>/<img onerror> 的记忆文本按字面显示且不产生对应元素节点", async () => {
  const render = await mountMemoryTab();
  const l0Text = [
    "# 人设标题",
    "",
    "<script>alert(1)</script>",
    "",
    "<img onerror=\"alert(2)\" src=\"x\">",
    "",
    "- 列表一",
    "- 列表二",
    "",
    "> 引用一句话",
    "",
    "1. 第一",
    "2. 第二",
    "",
    "普通段落 **加粗片段** 与 `行内代码片段`",
    "",
    "```js",
    "const a = 1;",
    "```",
    "",
    "#### 四级标题不在安全子集内",
  ].join("\n");
  const dsh = { call: async () => ({}) };
  const tree = render(dsh, memoryViewDto(l0Text));
  const flat = flattenVNode(tree);
  const types = new Set(flat.map((n) => n.type));

  // 危险内容不得成为元素节点：按字面文本显示
  for (const dangerous of ["script", "img", "iframe", "svg", "h1", "h2", "h3"]) {
    assert.equal(types.has(dangerous), false, `no <${dangerous}> element node`);
  }
  const text = collectText(tree);
  assert.ok(text.includes("<script>alert(1)</script>"), "script tag shown literally");
  assert.ok(text.includes("<img onerror=\"alert(2)\" src=\"x\">"), "img onerror shown literally");
  assert.ok(text.includes("#### 四级标题不在安全子集内"), "unsupported heading shown verbatim (不吞内容)");

  // 安全子集照常渲染为对应元素
  assert.ok(flat.some((n) => n.type === "ul"), "unordered list rendered");
  assert.ok(flat.some((n) => n.type === "ol"), "ordered list rendered");
  assert.ok(flat.some((n) => n.type === "blockquote"), "blockquote rendered");
  assert.ok(flat.some((n) => n.type === "pre"), "fenced code block rendered");
  assert.ok(flat.some((n) => n.type === "strong"), "bold rendered");
  assert.ok(flat.some((n) => n.type === "code"), "inline code rendered");
  assert.ok(flat.some((n) => n.type === "div" && n.props.className === "dshi_mdH1"), "h1 rendered as styled div");
  assert.ok(collectText(tree).includes("const a = 1;"), "code block content present");
  // 渲染树的全部字符串子节点里，script 内容依然存在（文本节点，不是元素）
  assert.ok(collectText(tree).includes("alert(1)"), "script body survives as plain text");
});

test("U4 预览态：L1 展示完整渲染视图（含派生索引），未闭合标记按字面输出", async () => {
  const render = await mountMemoryTab();
  const dsh = { call: async () => ({}) };
  const view = memoryViewDto(undefined, {
    text: "CORE BODY\n\n## 主题记忆索引\n- a [amber] — A",
    body: "CORE BODY",
  });
  const tree = render(dsh, view);
  const text = collectText(tree);
  assert.ok(text.includes("主题记忆索引"), "L1 preview shows full rendered view incl. derived index");
  // 未闭合的 ** 与 ` 都按字面显示
  const view2 = memoryViewDto("未闭合 **加粗 与 `行内 按字面");
  const tree2 = render(dsh, view2);
  assert.ok(collectText(tree2).includes("未闭合 **加粗 与 `行内 按字面"), "unclosed markers shown verbatim");
});

// ---------------------------------------------------------------------------
// b) 编辑 / 取消 / 保存 三条路径
// ---------------------------------------------------------------------------

test("U4 编辑：L0 进编辑可改草稿，取消不落盘且草稿保留（重进编辑不清空）", async () => {
  const render = await mountMemoryTab();
  const calls = [];
  const view = memoryViewDto();
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, payload });
      if (method === "getMemoryView") return view;
      return {};
    },
  };

  // 进入编辑：初值为服务端文本
  let tree = render(dsh, view);
  const editButtons = findButtons(tree, "编辑");
  assert.ok(editButtons.length >= 1, "edit buttons present");
  editButtons[0].props.onClick();   // L0
  tree = render(dsh, view);
  let textarea = findTextarea(tree);
  assert.ok(textarea, "L0 editor opened");
  assert.equal(textarea.props.value, "# 人设卡标题\n常驻身份说明", "editor seeded from layer text");

  // 输入草稿
  textarea.props.onChange({ target: { value: "我的新草稿" } });
  tree = render(dsh, view);
  textarea = findTextarea(tree);
  assert.equal(textarea.props.value, "我的新草稿", "draft updated through onChange");

  // 取消：退出编辑、不发任何写请求
  const writeCallsBefore = calls.filter((c) => c.method === "executeTool").length;
  const cancel = findButtons(tree, "取消")[0];
  assert.ok(cancel, "cancel button present while editing");
  cancel.props.onClick();
  tree = render(dsh, view);
  assert.equal(findTextarea(tree), undefined, "editing closed after cancel");
  assert.equal(calls.filter((c) => c.method === "executeTool").length, writeCallsBefore, "cancel never writes to disk");

  // 重进编辑：草稿仍在，不被服务端版本覆盖
  findButtons(tree, "编辑")[0].props.onClick();
  tree = render(dsh, view);
  textarea = findTextarea(tree);
  assert.ok(textarea, "re-entered edit");
  assert.equal(textarea.props.value, "我的新草稿", "draft preserved across cancel/re-enter (不清空用户已输入的内容)");
});

test("U4 保存：L0 走 soul_update，成功后退出编辑并展示确认文案、重新拉取视图", async () => {
  const render = await mountMemoryTab();
  const calls = [];
  const view = memoryViewDto();
  let viewLoads = 0;
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, payload });
      if (method === "getMemoryView") { viewLoads += 1; return view; }
      return {};
    },
  };

  let tree = render(dsh, view);
  findButtons(tree, "编辑")[0].props.onClick();   // L0
  tree = render(dsh, view);
  findTextarea(tree).props.onChange({ target: { value: "保存后的 L0" } });
  tree = render(dsh, view);
  findButtons(tree, "保存")[0].props.onClick();
  await flush();

  const saveCall = calls.find((c) => c.method === "executeTool");
  assert.ok(saveCall, "save issues executeTool");
  assert.equal(saveCall.payload.name, "soul_update");
  assert.deepEqual(saveCall.payload.args, { content: "保存后的 L0" });
  tree = render(dsh, view);
  assert.equal(findTextarea(tree), undefined, "editing closed after successful save");
  assert.ok(collectText(tree).includes("人设卡已保存"), "success message shown");
  // 挂载路径的 effect 未运行（stub），这里的重新拉取来自保存成功后的 load()
  assert.ok(viewLoads >= 1, "view reloaded after save");
});

test("U4 保存：L1 编辑初值取磁盘正文 body，保存走 core_write 且带 expectedRevision", async () => {
  const render = await mountMemoryTab();
  const calls = [];
  const view = memoryViewDto(undefined, { text: "CORE BODY\n\n## 索引", body: "CORE BODY", revision: "r1" });
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, payload });
      if (method === "getMemoryView") return view;
      return {};
    },
  };

  let tree = render(dsh, view);
  const editButtons = findButtons(tree, "编辑");
  assert.ok(editButtons.length >= 2, "L0 and L1 both expose edit");
  editButtons[1].props.onClick();   // L1
  tree = render(dsh, view);
  const textarea = findTextarea(tree);
  assert.ok(textarea, "L1 editor opened");
  assert.equal(textarea.props.value, "CORE BODY", "L1 editor seeded from disk body (not rendered view)");

  findTextarea(tree).props.onChange({ target: { value: "CORE BODY v2" } });
  tree = render(dsh, view);
  findButtons(tree, "保存")[0].props.onClick();
  await flush();

  const saveCall = calls.find((c) => c.method === "executeTool" && c.payload.name === "core_write");
  assert.ok(saveCall, "core_write issued");
  assert.deepEqual(saveCall.payload.args, { content: "CORE BODY v2", expectedRevision: "r1" },
    "save carries expectedRevision for CAS");
  tree = render(dsh, view);
  assert.ok(collectText(tree).includes("记忆核心已保存"), "success message shown for L1");
});

// ---------------------------------------------------------------------------
// c) 保存冲突：明确指引 + 草稿保留
// ---------------------------------------------------------------------------

test("U4 保存冲突：REVISION_CONFLICT 时给出重新加载指引，草稿保留在编辑框不清空", async () => {
  const render = await mountMemoryTab();
  const calls = [];
  const view = memoryViewDto(undefined, { text: "CORE BODY\n\n## 索引", body: "CORE BODY", revision: "r1" });
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, payload });
      if (method === "getMemoryView") return view;
      if (method === "executeTool" && payload.name === "core_write") {
        const error = new Error("core CAS failed: disk revision differs from expectedRevision");
        error.code = "REVISION_CONFLICT";
        throw error;
      }
      return {};
    },
  };

  let tree = render(dsh, view);
  findButtons(tree, "编辑")[1].props.onClick();   // L1
  tree = render(dsh, view);
  findTextarea(tree).props.onChange({ target: { value: "冲突场景下的本地草稿" } });
  tree = render(dsh, view);
  findButtons(tree, "保存")[0].props.onClick();
  await flush();
  tree = render(dsh, view);   // stub react 不自动重渲染，交互后必须重画

  const text = collectText(tree);
  assert.ok(text.includes("记忆已在别处更新，请重新加载后再改"), "conflict guidance shown");
  assert.ok(text.includes("[REVISION_CONFLICT]"), "error code still surfaced via ErrorBox");
  // 停在编辑态，草稿原样保留
  const textarea = findTextarea(tree);
  assert.ok(textarea, "still editing after conflict (not silently dropped)");
  assert.equal(textarea.props.value, "冲突场景下的本地草稿", "local draft kept intact (不丢用户输入)");
});

// ---------------------------------------------------------------------------
// d) 空状态：引导文案 + 仍可写第一条 + 进度条照常
// ---------------------------------------------------------------------------

test("U4 空状态：L0/L1 缺数据或正文为空时展示引导文案（怎么组织/从哪写/先配什么）", async () => {
  const render = await mountMemoryTab();
  const dsh = { call: async () => ({}) };

  // 两层都缺数据
  let tree = render(dsh, memoryViewDto(null, { text: "", body: "", revision: "r1" }));
  let text = collectText(tree);
  assert.ok(text.includes("还是空的"), "empty-state guide shown for both layers");
  assert.ok(text.includes("记忆按层组织"), "guide explains how memory is organized");
  assert.ok(text.includes("写第一条"), "guide explains where to write the first entry");
  assert.ok(text.includes("预算配置"), "guide explains what to configure first");
  // 空状态仍提供编辑入口
  assert.ok(findButtons(tree, "编辑").length >= 2, "edit entry available in empty state");
  // 顶部两条占用进度条照常渲染（Bar 未被替换/移除）
  assert.ok(flattenVNode(tree).some((n) => n.props && n.props.className === "dshi_bar"), "occupancy bars still rendered");

  // 空状态点编辑 → 进入文本框；取消 → 回到引导文案
  findButtons(tree, "编辑")[0].props.onClick();
  tree = render(dsh, memoryViewDto(null, { text: "", body: "", revision: "r1" }));
  assert.ok(findTextarea(tree), "empty layer can enter edit");
  findTextarea(tree).props.onChange({ target: { value: "第一条记忆" } });
  tree = render(dsh, memoryViewDto(null, { text: "", body: "", revision: "r1" }));
  findButtons(tree, "取消")[0].props.onClick();
  tree = render(dsh, memoryViewDto(null, { text: "", body: "", revision: "r1" }));
  assert.ok(collectText(tree).includes("还是空的"), "cancel returns to empty-state guide");
  assert.ok(findTextarea(tree) === undefined, "no textarea after cancel");
});

// ---------------------------------------------------------------------------
// e) 进度条只调既有 Bar：占用数值照旧透传（Bar 本体由另一条线负责）
// ---------------------------------------------------------------------------

test("U4 进度条：占用数值照旧传入 Bar（label/used/limit 形状不变）", async () => {
  const render = await mountMemoryTab();
  const view = memoryViewDto("# 人设卡标题\n常驻身份说明", { text: "CORE BODY", body: "CORE BODY", revision: "r1" });
  const dsh = { call: async () => ({}) };
  const tree = render(dsh, view);
  const bars = flattenVNode(tree).filter((n) => n.type === "div" && n.props && n.props.className === "dshi_card"
    && flattenVNode(n).some((c) => c.type === "div" && c.props && c.props.className === "dshi_bar"));
  assert.ok(bars.length >= 2, "two occupancy bars rendered through Bar");
  const text = collectText(tree);
  assert.ok(text.includes("14 / 12000 UTF-16"), "L0 usage passed to Bar");
  assert.ok(text.includes("60 / 8000 UTF-16"), "L1 usage passed to Bar");
});
