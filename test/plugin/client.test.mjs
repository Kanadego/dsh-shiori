// P5-Q client / RPC 测试。证据级别如实标注：
//   - client/index.js：真实执行（fake window.__ModuleLoader__ + stub react + 真实宿主 zod
//     经绝对 file URL 导入）——synthetic host ctx，非浏览器实机；
//   - src/plugin/client-rpc.mjs / index.mjs：真实模块逻辑 + temp 合成 stub（P 槽的
//     protocol.mjs / controller.mjs 在单槽副本中不存在，stub 放系统 temp 并清理，
//     明确标注 SYNTHETIC，不进白名单不发包）；
//   - 宿主 @deepseek-ai/dsh-typert-protocol / cordis 使用本机已安装 0.2.1-rc.2 真实包。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { register, createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiori-q-client-"));
const NPM_GLOBAL = process.env.DSH_NPM_GLOBAL
  ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
const HOST_MODULES = process.env.DSH_HOST_MODULES ?? join(NPM_GLOBAL, "@deepseek-ai", "dsh", "node_modules");

test.after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

// 宿主 zod（真实 0.2.1-rc.2 安装树内 zod@4.6.7）。
const zod = await import(`file:///${HOST_MODULES}/zod/index.js`);

// ---------------------------------------------------------------------------
// 通用：加载 bundle（真实执行 ModuleLoader 注册 + factory）
// ---------------------------------------------------------------------------

const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
await import(pathToFileURL(join(WORKQ, "client", "index.js")).href);

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
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

// ---------------------------------------------------------------------------
// bundle：形状、wire、CSS 一致性、安全约束
// ---------------------------------------------------------------------------

test("bundle：ModuleLoader 注册、导出 apply/inject、10 端点 wire 冻结", async () => {
  const mod = loadClientModule();
  assert.deepEqual(Object.keys(mod).sort(), ["TYPERT_REMOTE", "apply", "ensureLosslessJson", "inject"]);
  assert.deepEqual(mod.inject, ["remote", "slots", "configForms"]);
  assert.equal(mod.TYPERT_REMOTE.package, "dsh-shiori");

  const expected = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"];
  const endpoints = Object.keys(mod.TYPERT_REMOTE.methods).sort();
  assert.deepEqual(endpoints, [...expected].map((m) => `shiori/${m}`).sort());
  assert.equal(mod.TYPERT_REMOTE.descriptors.length, 10);

  for (const descriptor of mod.TYPERT_REMOTE.descriptors) {
    assert.equal(descriptor.invocation.kind, "direct");
    assert.deepEqual(
      descriptor.parameters.map((p) => `${p.name}:${p.wire}:${p.source}`),
      ["session:sessionId:lookup", "payload:payload:json"],
      descriptor.method,
    );
    assert.deepEqual(descriptor.cancellation, { parameter: "signal" });
  }
});

test("bundle：invoke 命名输入 → 位置参数映射与严格输入解析", async () => {
  const mod = loadClientModule();
  const calls = [];
  const fakeRemote = {
    shiori: {
      executeTool(session, payload, signal) {
        calls.push({ session, payload, signal: signal === "SIG" });
        return { ok: true };
      },
    },
  };
  const invoke = mod.TYPERT_REMOTE.methods["shiori/executeTool"].invoke;
  invoke(fakeRemote, { sessionId: "sess-9", payload: { name: "topic_append", args: {} } }, "SIG");
  assert.deepEqual(calls, [{ session: "sess-9", payload: { name: "topic_append", args: {} }, signal: true }]);

  const parser = mod.TYPERT_REMOTE.methods["shiori/getStatus"].input({ strict: true });
  const schema = parser.create();
  assert.deepEqual(schema.parse({ sessionId: "s1", payload: {} }), { sessionId: "s1", payload: {} });
  assert.throws(() => schema.parse({ sessionId: "s1" }), "payload required");
  assert.throws(() => schema.parse({ sessionId: "s1", payload: {}, extra: 1 }), "closed input");
  assert.equal(parser.jsonSchema.additionalProperties, false);
  assert.deepEqual(parser.jsonSchema.required, ["sessionId", "payload"]);
});

test("bundle：内嵌 CSS 与 client/shiori.css 规则一致（去注释/压缩比较）", async () => {
  const cssFile = readFileSync(join(WORKQ, "client", "shiori.css"), "utf8");
  const normalize = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, "")
    .trim();
  const rules = normalize(cssFile);
  // CSS 常量由多段字符串字面量拼接；逐段提取后连接再比较。
  const bundleSource = readFileSync(join(WORKQ, "client", "index.js"), "utf8");
  const start = bundleSource.indexOf("var CSS =");
  const end = bundleSource.indexOf("function ensureStyle");
  assert.ok(start >= 0 && end > start, "inline CSS string present");
  const segment = bundleSource.slice(start, end);
  const literals = [];
  const pattern = /"((?:[^"\\\r\n]|\\.)*)"/g;
  for (const match of segment.matchAll(pattern)) literals.push(match[1]);
  assert.ok(literals.length > 10, `CSS built from string literals (${literals.length})`);
  const inline = normalize(literals.join("").replace(/\\"/g, '"'));
  assert.equal(inline, rules, "inline CSS rules identical to client/shiori.css");
});

test("bundle：无 innerHTML / 无外部 CDN / 无 eval", async () => {
  const raw = readFileSync(join(WORKQ, "client", "index.js"), "utf8");
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // 剥注释后检查用法
  assert.ok(!source.includes("innerHTML"), "no innerHTML");
  assert.ok(!source.includes("dangerouslySetInnerHTML"), "no dangerouslySetInnerHTML");
  assert.ok(!/\binsertAdjacentHTML\b/.test(source), "no insertAdjacentHTML");
  assert.ok(!/https?:\/\//.test(source), "no remote resource URLs");
  assert.ok(!/\beval\s*\(/.test(source) && !/new Function\s*\(/.test(source), "no eval / Function constructor");
});

test("bundle apply：$mount → 槽位注册；失败逆序释放；$mount 失败不留槽位", async () => {
  const mod = loadClientModule();
  const events = [];

  const okCtx = {
    remote: { $mount: async (contribution) => { events.push("mount"); assert.equal(contribution, mod.TYPERT_REMOTE); return async () => events.push("unmount"); } },
    slots: {
      inject: (slot, factory) => { events.push("slot:" + slot); factory(); return async () => events.push("slot-dispose"); },
      register: (meta, renderFn) => ({ meta, renderFn }),
    },
  };
  const cleanup = await mod.apply(okCtx);
  assert.ok(events.includes("mount") && events.includes("slot:plugins.bundle.config"));
  await cleanup();
  assert.equal(events[events.length - 1], "unmount", "cleanup disposes reverse: slot first, mount last");
  assert.ok(events.indexOf("slot-dispose") < events.indexOf("unmount"));

  const failMount = {
    remote: { $mount: async () => { throw new Error("mount failed"); } },
    slots: { inject: () => { throw new Error("slot must not register when mount failed"); } },
  };
  await assert.rejects(() => mod.apply(failMount), /mount failed/);

  const failSlot = {
    remote: { $mount: async () => async () => events.push("unmount2") },
    slots: { inject: () => { throw new Error("slot failed"); } },
  };
  await assert.rejects(() => mod.apply(failSlot), /slot failed/);
  assert.equal(events[events.length - 1], "unmount2", "$mount disposer released when slot registration fails");
});

test("宿主 ctx 冻结（真机只读上下文）时 apply 仍能挂载，不因 shioriNotify 赋值失败", async () => {
  // 真机事故：桌面端 / web 宿主交给插件的 ctx 是冻结对象，apply 里给
  // ctx.shioriNotify 赋值会抛 TypeError，客户端入口永远停在 loading，
  // 桌面端直接报 "web boot: 1 entry did not activate / dsh-shiori: loading"。
  const mod = loadClientModule();
  let registered = null;
  const ctx = Object.freeze({
    remote: { $mount: async () => async () => {} },
    slots: {
      inject: (slot, factory) => factory(),
      register: (meta, renderFn) => { registered = { meta, render: renderFn }; return () => {}; },
    },
  });
  const cleanup = await mod.apply(ctx);
  assert.ok(registered, "slot registration executed on frozen ctx");
  assert.equal(ctx.shioriNotify, undefined, "frozen ctx 不接受额外字段");
  await cleanup();
});

test("bundle 面板：渲染根节点与会话缺省提示（stub react 真执行组件函数）", async () => {
  const mod = loadClientModule();
  let registered = null;
  const ctx = {
    remote: { $mount: async () => async () => {} },
    slots: {
      inject: (slot, factory) => factory(),
      register: (meta, renderFn) => { registered = { meta, render: renderFn }; return () => {}; },
    },
  };
  await mod.apply(ctx);
  assert.ok(registered, "slot registration executed");
  const vnode = registered.render({ entryKey: "dsh-shiori" });
  assert.equal(typeof vnode.type, "function", "slot renders the ShioriSection component");
  const root = vnode.type(vnode.props); // stub react：组件函数真执行（hooks 为 stub）
  assert.equal(root.type, "div");
  assert.equal(root.props.className, "dshi_root");
});

// ---------------------------------------------------------------------------
// 服务端：temp 合成 stub（SYNTHETIC——单槽验证用，随测试清理，绝不进入包/白名单）
// ---------------------------------------------------------------------------

const STUB_PROTOCOL = `// SYNTHETIC TEST STUB (slot Q single-slot verification only; NOT shipped).
// 镜像 CONTRACTS §6 冻结 wire：MANAGEMENT_METHODS 方法名 + validateManagementPayload 顶层闭键。
export const MANAGEMENT_METHODS = {
  getStatus: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  getMemoryView: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  getGraph: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  executeTool: { inputSchema: { type: "object", required: ["name", "args"] }, outputSchema: { type: "object" } },
  listCandidates: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  analyze: { inputSchema: { type: "object", required: ["kind"] }, outputSchema: { type: "object" } },
  reviewCandidate: { inputSchema: { type: "object", required: ["candidateId", "decision"] }, outputSchema: { type: "object" } },
  previewPlan: { inputSchema: { type: "object", required: ["kind"] }, outputSchema: { type: "object" } },
  executePlan: { inputSchema: { type: "object", required: ["planId", "planDigest", "operationId", "confirmed"] }, outputSchema: { type: "object" } },
  getTimeline: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
};
const ALLOWED = {
  getStatus: [], getMemoryView: [], getGraph: [], listCandidates: [],
  executeTool: ["name", "args"],
  analyze: ["kind", "operationId", "expectedQueueRevision"],
  reviewCandidate: ["candidateId", "decision", "expectedQueueRevision", "operationId"],
  previewPlan: ["kind", "candidateId", "proposal", "expectedQueueRevision", "operationId", "planId"],
  executePlan: ["planId", "planDigest", "operationId", "confirmed"],
  getTimeline: ["offset", "limit"],
};
export function validateManagementPayload(name, payload) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, name)) { const e = new Error("unknown method"); e.code = "INVALID_INPUT"; throw e; }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) { const e = new Error("payload must be an object"); e.code = "INVALID_INPUT"; throw e; }
  for (const key of Object.keys(payload)) if (!ALLOWED[name].includes(key)) { const e = new Error("unknown key " + key); e.code = "INVALID_INPUT"; throw e; }
  for (const key of (ALLOWED[name].length >= 0 ? Object.keys(MANAGEMENT_METHODS[name].inputSchema.required ?? {}) : [])) void key;
  const required = (MANAGEMENT_METHODS[name].inputSchema.required) ?? [];
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(payload, key)) { const e = new Error("missing " + key); e.code = "INVALID_INPUT"; throw e; }
}
`;

const STUB_CONTROLLER = `// SYNTHETIC TEST STUB (slot Q single-slot verification only; NOT shipped).
export async function createShioriPluginController(ctx, settings) {
  globalThis.__shioriQLastSettings = settings;
  const state = { created: true, started: 0, stopped: 0, settings };
  const management = {};
  for (const method of ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"]) {
    management[method] = async (trustedContext, payload) => ({ method, trusted: { source: trustedContext.source, principal: trustedContext.principal.kind, sessionId: trustedContext.session && trustedContext.session.id, hasAgent: Boolean(trustedContext.agent), signalLike: Boolean(trustedContext.signal) }, payload });
  }
  return {
    management,
    async start() { state.started += 1; },
    async stop() { state.stopped += 1; },
    diagnostics() { return state; },
  };
}
`;

const stubProtocolUrl = pathToFileURL(join(TMP_ROOT, "protocol.stub.mjs")).href;
const stubControllerUrl = pathToFileURL(join(TMP_ROOT, "controller.stub.mjs")).href;
writeFileSync(join(TMP_ROOT, "protocol.stub.mjs"), STUB_PROTOCOL);
writeFileSync(join(TMP_ROOT, "controller.stub.mjs"), STUB_CONTROLLER);

// data-URL 加载钩子：仅当导入方位于本槽 work/Q 树内时，把对 protocol.mjs /
// controller.mjs 的相对导入重定向到系统 temp 的合成 stub；其余解析原样放行。
const WORKQ_URL = pathToFileURL(WORKQ).href;
const loaderSource = `
export async function resolve(specifier, context, nextResolve) {
  const parent = String(context.parentURL || "");
  const inWorkQ = parent.startsWith(${JSON.stringify(WORKQ_URL)});
  if (inWorkQ && specifier.startsWith(".") && (specifier === "./protocol.mjs" || specifier.endsWith("plugin/protocol.mjs"))) return { url: ${JSON.stringify(stubProtocolUrl)}, shortCircuit: true };
  if (inWorkQ && specifier.startsWith(".") && (specifier === "./controller.mjs" || specifier.endsWith("plugin/controller.mjs"))) return { url: ${JSON.stringify(stubControllerUrl)}, shortCircuit: true };
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loaderSource)}`, pathToFileURL(HERE).href);

const { mountShioriRpc } = await import(pathToFileURL(join(WORKQ, "src", "plugin", "client-rpc.mjs")).href);
// 与被测代码同一解析路径取宿主协议包：src/plugin/*.mjs 以裸说明符导入
// @deepseek-ai/dsh-typert-protocol，Node 从 <工作树>/node_modules 解析。
// 之前的 HOST_MODULES 绝对 file URL 取到的是全局 DSH 安装树的另一份副本
// （工作树 rc.5 / 全局 rc.4，两个 realpath → 两个构造函数，instanceof 恒为 false）。
// createRequire().resolve 只取路径不执行，随后动态 import 拿到的就是被测代码
// 实际加载的那份模块图——本工作树 rc.5、主仓 junction 树 rc.4，各自自洽。
const requireFromSrc = createRequire(pathToFileURL(join(WORKQ, "src", "plugin", "client-rpc.mjs")));
const { remoteMethods, RemoteError, remoteErrorOf } = await import(
  pathToFileURL(requireFromSrc.resolve("@deepseek-ai/dsh-typert-protocol")).href
);

// 伪造 Cordis 上下文：reflect.provide 记录服务；get 提供可选服务；invocation 按调用方注入。
function fakeCtx({ typert = true, agents = true } = {}) {
  const services = new Map();
  if (typert) services.set("typert", {});
  if (agents) services.set("agents", { get: (id) => (id === "sess-live" ? { id } : undefined) });
  const ctx = {
    invocation: undefined,
    get: (name) => services.get(name),
    reflect: {
      provide: (name, value) => {
        services.set(name, value);
        return () => services.delete(name);
      },
      props: {},
    },
    fiber: { effect: (execute) => execute() },
  };
  return ctx;
}

function ownerInvocation() {
  return { peer: { principal: { kind: "owner" } } };
}

async function callAs(ctx, service, method, { principal = "owner", session = { id: "sess-live" }, payload = {} } = {}) {
  ctx.invocation = principal === null ? undefined : { peer: { principal: { kind: principal } } };
  return service[method](session, payload);
}

test("mountShioriRpc：真实 TypertRemoteService 挂载 + Remote 标记 + owner 授权 + trustedContext", async () => {
  const ctx = fakeCtx();
  const management = {};
  for (const m of ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"]) {
    management[m] = async (trusted, payload) => ({ ok: true, method: m, trusted, payload });
  }
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const service = ctx.get("shiori.panel");
  assert.ok(service, "service registered under shiori.panel");

  // 真实 Remote 标记（Gateway source-mode 发现路径）
  const markers = remoteMethods(service);
  assert.equal(markers.length, 10);
  assert.deepEqual(markers.map((m) => m.exportName ?? m.method).sort(),
    ["analyze", "executePlan", "executeTool", "getGraph", "getMemoryView", "getStatus", "getTimeline", "listCandidates", "previewPlan", "reviewCandidate"].sort());

  const out = await callAs(ctx, service, "getStatus");
  assert.equal(out.method, "getStatus");
  assert.equal(out.trusted.source, "panel-rpc");
  assert.equal(out.trusted.principal.kind, "owner");
  assert.equal(out.trusted.session.id, "sess-live");
  assert.ok(out.trusted.agent, "agent resolved from the host agents registry");
  assert.ok(out.trusted.signal, "cancellation signal present");

  await rpc.stop();
});

test("授权：非 owner / 无 invocation / 非宿主 session 一律拒绝", async () => {
  const ctx = fakeCtx();
  const noop = async () => ({});
  const management = Object.fromEntries(
    ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"].map((m) => [m, noop]),
  );
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const service = ctx.get("shiori.panel");

  await assert.rejects(() => callAs(ctx, service, "getStatus", { principal: "guest" }), (error) => error instanceof RemoteError && error.code === "shiori/unauthorized");
  await assert.rejects(() => callAs(ctx, service, "getStatus", { principal: null }), (error) => error.code === "shiori/unauthorized");
  await assert.rejects(() => callAs(ctx, service, "getStatus", { session: { noId: true } }), (error) => error.code === "shiori/invalid-session");
  await rpc.stop();
});

test("code 透传：management 抛 INVALID_INPUT/REVISION_CONFLICT 时 RemoteError 保留 code", async () => {
  const ctx = fakeCtx();
  const boom = (code) => async () => { const e = new Error("biz fail"); e.code = code; throw e; };
  const ok = async () => ({});
  const methods = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"];
  const management = Object.fromEntries(methods.map((m) => [m, m === "reviewCandidate" ? boom("REVISION_CONFLICT") : ok]));
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const service = ctx.get("shiori.panel");
  await assert.rejects(() => callAs(ctx, service, "reviewCandidate", { payload: { candidateId: "c1", decision: "reviewed" } }),
    (error) => error instanceof RemoteError && error.code === "REVISION_CONFLICT");
  await rpc.stop();

  // 无 code 的普通错误不伪装成功，按 INTERNAL 过线
  const ctx2 = fakeCtx();
  const management2 = Object.fromEntries(methods.map((m) => [m, m === "reviewCandidate" ? (async () => { throw new Error("bare"); }) : ok]));
  const rpc2 = await mountShioriRpc(ctx2, management2, { mode: "shadow", dataRoot: null, stateRoot: null });
  const service2 = ctx2.get("shiori.panel");
  await assert.rejects(() => callAs(ctx2, service2, "reviewCandidate", { payload: { candidateId: "c", decision: "reviewed" } }),
    (error) => error instanceof RemoteError && error.code === "INTERNAL");
  await rpc2.stop();
});

test("stop：禁新 → 排空在途；幂等；diagnostics 如实", async () => {
  const ctx = fakeCtx();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = async () => { await gate; return { slow: true }; };
  const ok = async () => ({});
  const management = Object.fromEntries(
    ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"].map((m) => [m, m === "getGraph" ? slow : ok]),
  );
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const service = ctx.get("shiori.panel");
  const inFlight = callAs(ctx, service, "getGraph");
  let stopped = false;
  const stopping = rpc.stop().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(stopped, false, "stop waits for in-flight call");
  await assert.rejects(() => callAs(ctx, service, "getStatus"), (error) => error.code === "shiori/rpc-stopped");
  release();
  const result = await inFlight;
  assert.deepEqual(result, { slow: true });
  await stopping;
  assert.equal(stopped, true);
  await rpc.stop(); // 幂等
  const diagnostics = rpc.diagnostics();
  assert.equal(diagnostics.closed, true);
  assert.equal(diagnostics.namespace, "shiori");
  assert.equal(diagnostics.transport, "typert-gateway");
  assert.equal(diagnostics.ownerOnly, true);
  assert.equal(diagnostics.methods.length, 10);
});

test("diagnostics：宿主 typert 缺席时声明 UI unsupported（仅工具模式）", async () => {
  const ctx = fakeCtx({ typert: false });
  const ok = async () => ({});
  const management = Object.fromEntries(
    ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"].map((m) => [m, ok]),
  );
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const diagnostics = rpc.diagnostics();
  assert.equal(diagnostics.transport, "unavailable");
  assert.equal(diagnostics.ui, "unsupported-no-transport");
  await rpc.stop();
});

test("wire 契约校验：P protocol 方法集不一致或 management 缺方法时拒绝挂载", async () => {
  const ok = async () => ({});
  const full = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"];
  await assert.rejects(
    () => mountShioriRpc(fakeCtx(), { getStatus: ok }, {}),
    /management is missing methods/,
  );
  await assert.rejects(
    () => mountShioriRpc(fakeCtx(), undefined, {}),
    /management/,
  );
  await assert.rejects(
    () => mountShioriRpc(null, Object.fromEntries(full.map((m) => [m, ok])), {}),
    /Cordis context/,
  );
});

// ---------------------------------------------------------------------------
// 入口 index.mjs：apply 顺序 / cleanup 顺序 / 部分失败逆序清理（controller 为 temp 合成 stub）
// ---------------------------------------------------------------------------

const entry = await import(pathToFileURL(join(WORKQ, "index.mjs")).href);

test("index：named exports（name/inject/Config/apply）且无 default 导出", () => {
  assert.equal(entry.name, "shiori");
  assert.deepEqual(entry.inject, ["tools", "systemPrompt"]);
  assert.equal(typeof entry.Config, "function");
  assert.equal(typeof entry.apply, "function");
  assert.equal(entry.default, undefined, "no default export shadowing named exports");
});

test("index apply：normalize → verify → controller.start → rpc mount；cleanup 先 RPC 后 controller", async () => {
  const order = [];
  const ctx = fakeCtx();
  // 捕获合成 controller 的生命周期：重写 stub 不可行（共享模块），改经 management 探测。
  const cleanup = await entry.apply(ctx, { dataRoot: join(TMP_ROOT, "idx-data"), stateRoot: join(TMP_ROOT, "idx-state") });
  assert.ok(ctx.get("shiori.panel"), "rpc service mounted");
  const service = ctx.get("shiori.panel");
  const out = await callAs(ctx, service, "getStatus");
  assert.equal(out.trusted.source, "panel-rpc");
  await cleanup();
  await assert.rejects(() => callAs(ctx, service, "getStatus"), (error) => error.code === "shiori/rpc-stopped", "cleanup stops RPC admission");
});

test("index apply：缺省配置为 inert shadow 挂载；非法配置整体失败", async () => {
  const ctx = fakeCtx();
  const cleanup = await entry.apply(ctx, {});
  assert.ok(ctx.get("shiori.panel"));
  await cleanup();
  await assert.rejects(() => entry.apply(fakeCtx(), { mode: "active" }), /allowActive/);
});

test("index apply：mountShioriRpc 失败（management 缺方法）→ 停 controller 后原样抛出", async () => {
  // 直接对 client-rpc 断言（entry 会因 P stub controller 始终提供全方法，
  // 用 management 缺方法场景由 mountShioriRpc 层覆盖，entry 的 catch 分支以此为准）
  const ok = async () => ({});
  await assert.rejects(
    () => mountShioriRpc(fakeCtx(), { getStatus: ok }, {}),
    /management is missing methods/,
  );
});

// ---------------------------------------------------------------------------
// R2 回归（owner review r-596f3955）：真实安装版 Cordis Context 的 traceable /
// shadow receiver 兼容。Gateway 以 receiverContext.get(key) 的 proxy 调方法，
// this 不是服务实例（shadow proxy）；此前 # 私有成员品牌检查九个方法全灭。
// ---------------------------------------------------------------------------

const cordisModule = await import(`file:///${HOST_MODULES}/@deepseek-ai/cordis/lib/index.js`);
const { Context: RealCordisContext } = cordisModule;

function realCordisFixture(managementOverrides = {}) {
  const recorded = { signals: [], payloads: [], sessions: [] };
  const management = {};
  for (const m of ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"]) {
    management[m] = async (trusted, payload) => {
      recorded.signals.push(trusted.signal);
      recorded.payloads.push(payload);
      recorded.sessions.push(trusted.session && trusted.session.id);
      if (managementOverrides[m]) return managementOverrides[m](trusted, payload);
      return { method: m, source: trusted.source, principal: trusted.principal.kind, sessionId: trusted.session?.id, hasSignal: Boolean(trusted.signal) };
    };
  }
  return { recorded, management };
}

async function callViaCordisReceiver(ctx, method, { session = { id: "sess-real" }, payload = {}, signal = null } = {}) {
  const service = ctx.get("shiori.panel");
  return Reflect.apply(Reflect.get(service, method), service, [session, payload, signal]);
}

test("R2 回归：真实 Cordis receiver 下九个方法全部可用，trustedContext 经 this.ctx 取得", async () => {
  const ctx = new RealCordisContext();
  const { management } = realCordisFixture();
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const callContext = ctx.extend({ invocation: { peer: { principal: { kind: "owner" } } } });
  const signal = new AbortController().signal;
  // 各方法按冻结 wire 的必填字段给最小合法 payload（stub 协议顶层闭键校验）
  const samplePayloads = {
    executeTool: { name: "soul_read", args: {} },
    analyze: { kind: "organize" },
    reviewCandidate: { candidateId: "c1", decision: "reviewed" },
    previewPlan: { kind: "organize" },
    executePlan: { planId: "p1", planDigest: "d1", operationId: "o1", confirmed: true },
  };
  for (const m of ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"]) {
    const out = await callViaCordisReceiver(callContext, m, { payload: samplePayloads[m] ?? {}, signal });
    assert.equal(out.method, m, `method ${m} must pass the real Cordis receiver`);
    assert.equal(out.source, "panel-rpc");
    assert.equal(out.principal, "owner");
    assert.equal(out.sessionId, "sess-real");
  }
  // 取消信号原样透传（同一对象身份，不是 dispatch 自有信号）
  const status = await callViaCordisReceiver(callContext, "getStatus", { signal });
  assert.ok(status, "call with signal ok");
  await rpc.stop();
});

test("R2 回归：真实 Cordis receiver 下 owner/无 invocation/错误 code/stop 与直调路径行为一致", async () => {
  const ctx = new RealCordisContext();
  const { management } = realCordisFixture();
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });

  // 非 owner：同一 receiver 路径拒绝
  const agentCtx = ctx.extend({ invocation: { peer: { principal: { kind: "agent" } } } });
  await assert.rejects(() => callViaCordisReceiver(agentCtx, "getStatus"),
    (error) => error.code === "shiori/unauthorized");
  // 无 invocation（裸 get，非 Gateway 调用）：拒绝
  const bare = ctx.get("shiori.panel");
  await assert.rejects(() => Reflect.apply(Reflect.get(bare, "getStatus"), bare, [{ id: "s" }, {}, null]),
    (error) => error.code === "shiori/unauthorized");

  // management 抛业务 code：经 receiver 路径原样透传
  management.getStatus = async () => { const e = new Error("stale"); e.code = "REVISION_CONFLICT"; throw e; };
  const ownerCtx = ctx.extend({ invocation: { peer: { principal: { kind: "owner" } } } });
  await assert.rejects(() => callViaCordisReceiver(ownerCtx, "getStatus"),
    (error) => error.code === "REVISION_CONFLICT");
  delete management.getStatus;

  // 无宿主 session（lookup 未解析出带 id 的对象）：拒绝
  await assert.rejects(() => callViaCordisReceiver(ownerCtx, "getStatus", { session: {} }),
    (error) => error.code === "shiori/invalid-session");

  // stop 后经 receiver 路径禁新；幂等
  await rpc.stop();
  await rpc.stop();
  await assert.rejects(() => callViaCordisReceiver(ownerCtx, "getStatus"),
    (error) => error.code === "shiori/rpc-stopped");
});

test("R2 回归：真实 Cordis receiver 下取消信号按 wire 末位参数透传（身份一致）", async () => {
  const ctx = new RealCordisContext();
  const { recorded, management } = realCordisFixture();
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const ownerCtx = ctx.extend({ invocation: { peer: { principal: { kind: "owner" } } } });
  const controller = new AbortController();
  await callViaCordisReceiver(ownerCtx, "getGraph", { signal: controller.signal });
  assert.equal(recorded.signals.at(-1), controller.signal, "exact signal object forwarded");
  // 缺省 signal：dispatch 自有控制器信号（可 AbortSignal），非 undefined
  await callViaCordisReceiver(ownerCtx, "getGraph");
  assert.ok(recorded.signals.at(-1) instanceof AbortSignal, "owned signal created when caller omits it");
  await rpc.stop();
});

test("R1 回归（entry 集成）：尾随分隔符 roots 经 verify 后以 canonical 形式传入 controller", async () => {
  const { mkdirSync, realpathSync } = await import("node:fs");
  const { sep } = await import("node:path");
  const dataDir = join(TMP_ROOT, "idx-can-data");
  const stateDir = join(TMP_ROOT, "idx-can-state");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const ctx = fakeCtx();
  const cleanup = await entry.apply(ctx, { dataRoot: dataDir + sep, stateRoot: stateDir + sep });
  const captured = globalThis.__shioriQLastSettings;
  assert.ok(captured, "synthetic controller captured settings");
  assert.equal(captured.dataRoot, realpathSync(dataDir), "dataRoot canonical (no trailing separator)");
  assert.equal(captured.stateRoot, realpathSync(stateDir), "stateRoot canonical (no trailing separator)");
  await cleanup();
});

// ---------------------------------------------------------------------------
// R3/R4 回归（owner review r-596f3955）：无损 JSON payload 与会话/代际守卫。
// 复用 owner repro 的两阶段机制：先以预置 section 状态渲染根组件拿 CandidatesTab
// 引用，再独立调用组件函数（有状态 react stub + effects 收集），并用真实宿主
// isRemoteJsonValue 验证 payload 无损性。纯合成 UI 数据，无宿主 RPC。
// ---------------------------------------------------------------------------

const { isRemoteJsonValue } = await import(`file:///${HOST_MODULES}/@deepseek-ai/dsh-typert-protocol/lib/index.js`);

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

// ref 感知版 harness：useRef 按（owner, hook 序号）持久化，跨渲染返回同一对象——
// 真实 React 语义。专供 P1-1 / P1-3 的跨渲染 ref 守卫用例；owner 由测试在调用
// 组件前设置（host.owner），区分 section 渲染与 tab 渲染的 ref 槽位，避免串槽。
// states / effects / cursor 语义与 makeStatefulReact 完全一致。
function makeRefAwareReact() {
  const states = [];
  const effects = [];
  const cursor = { v: 0 };
  const runEffects = { v: false };
  const refsByOwner = new Map(); // owner -> refs[]
  const host = {
    owner: null,
    react: {
      createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      Fragment: "fragment",
      useState: (initial) => {
        const i = cursor.v++;
        if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
        return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; }];
      },
      useEffect: (fn) => { if (runEffects.v) effects.push(fn); },
      useMemo: (fn) => fn(),
      useRef: (initial) => {
        const i = cursor.v++;
        if (!refsByOwner.has(host.owner)) refsByOwner.set(host.owner, []);
        const refs = refsByOwner.get(host.owner);
        if (!(i in refs)) refs[i] = { current: initial };
        return refs[i];
      },
    },
    states, effects, cursor, runEffects,
  };
  return host;
}

function flattenVNode(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) flattenVNode(child, out); return out; }
  if (!node || typeof node !== "object") return out;
  out.push(node);
  if (node.children) flattenVNode(node.children, out);
  return out;
}

// 递归收集渲染树里的全部可见文本（stub h 的 children 是数组，字符串散在各层）
function collectText(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out.join(""); }
  if (node === null || node === undefined || typeof node === "boolean") return out.join("");
  if (typeof node !== "object") { out.push(String(node)); return out.join(""); }
  if (node.children) collectText(node.children, out);
  return out.join("");
}

// 挂载面板并返回 renderCandidates(dsh, sessionId, { effects })：
// 每次调用独立渲染 CandidatesTab（cursor 归零，states 承载其 7 个 useState）。
async function mountCandidates(mod, host) {
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  // ShioriSection useState 顺序：tab / sessionId / manual / sessions / modeStatus（R6 追加）；
  // 预置 tab="candidates"、sessionId 非空且 modeStatus={mode:"active"}，
  // 渲染一次拿到 CandidatesTab 引用。
  host.states.length = 0;
  host.states.push("candidates", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const candidates = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "CandidatesTab");
  assert.ok(candidates, "CandidatesTab reached through real slot render");
  return (dsh, sessionId, options = {}) => {
    host.cursor.v = 0;
    host.runEffects.v = Boolean(options.effects);
    return candidates.type({ dsh, sessionId });
  };
}

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function findButton(tree, label) {
  const button = flattenVNode(tree).find((n) => n.type === "button" && n.children.includes(label));
  assert.ok(button, `button "${label}" present`);
  return button;
}

// CandidatesTab useState 顺序：data / error / busy / proposal / preview / previewError / guard
// （第 5 轮起 proposal 预填合法 link 形状——默认死值空 links 会被客户端本地校验拦截，
//   而 R3/R4 测的是 revision 附带与会话守卫语义，需要 previewPlan 真正发出）
function loadedStates(sessionId) {
  return [
    // 真实形状补正（review a1 打回项 1）：link 候选必是两卡配对，扁平 candidateId 形状保留，
    // 但 sources 必须给足 2 张——单源候选会被 proposalSkeleton 本地拦截，previewPlan 发不出。
    // 0.3：organize 预览入口裁撤后，previewPlan 无损 / R4 在途预览改走遗忘计划行内预览，
    // 故 fixture 带一条 open 的 forgetting 计划。
    { queueRevision: 0, items: [{ candidateId: "candidate-A", kind: "link", sources: [{ id: "s-a" }, { id: "s-b" }] }],
      plans: [{ planId: "fp-A", kind: "forgetting", planDigest: "digest-fp", queueRevision: null, changedItems: 1, summary: "archive 1 ephemeral card(s)", createdAt: "2026-11-01T00:00:00.000Z", executed: false, superseded: false }] },
    null, false, JSON.stringify({ kind: "link", links: [{ id: "s1", after: [{ target: "t-a", rel: null }] }] }), null, null,
    { sessionId, gen: 0 },
  ];
}

test("R3 回归：数据未加载时不发送 expectedQueueRevision，payload 经宿主 isRemoteJsonValue 判无损；写动作禁用", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: [], plans: [] };
      return {};
    },
  };
  host.states.length = 0; // 未加载：data=null
  let tree = renderCandidates(dsh, "session-A");
  // 未加载：写动作按钮必须禁用（0.3 整理流程裁撤后唯一的 analyze 入口是「分析遗忘候选」）
  assert.equal(findButton(tree, "分析遗忘候选").props.disabled, true, "analyze disabled before load");
  // 即便被直接触发（无障碍/脚本场景），payload 也不得含 undefined 值字段
  findButton(tree, "分析遗忘候选").props.onClick();
  await flush();
  const analyze = calls.find((c) => c.method === "analyze");
  assert.ok(analyze, "analyze call issued");
  assert.equal(Object.prototype.hasOwnProperty.call(analyze.payload, "expectedQueueRevision"), false,
    "no expectedQueueRevision own property before queueRevision is known");
  assert.equal(isRemoteJsonValue(analyze.payload), true, "analyze payload lossless per host validator");
});

test("R3 回归：数据已加载时 expectedQueueRevision 以数值附带，previewPlan payload 无损", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  let previewResolve;
  // 真实形状补正（review a1 打回项 1 延伸）：analyze 的真实响应是 queueDto（setData 整包
  // 替换），stub 返回 {} 会把队列冲空、候选消失；listCandidates 同步给两卡配对的 link 候选
  // 与 forgetting 计划（0.3：previewPlan 无损改走遗忘计划行内预览，analyze 整包替换后仍要在场）。
  const analyzeQueueDto = { queueRevision: 0, items: [{ candidateId: "candidate-A", kind: "link", sources: [{ id: "s-a" }, { id: "s-b" }] }], plans: loadedStates("x")[0].plans };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "previewPlan") return new Promise((resolve) => { previewResolve = resolve; });
      if (method === "listCandidates") return analyzeQueueDto;
      if (method === "analyze") return analyzeQueueDto;
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...loadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  assert.equal(findButton(tree, "分析遗忘候选").props.disabled, false, "analyze enabled after load");
  findButton(tree, "分析遗忘候选").props.onClick();
  await flush();
  const analyze = calls.find((c) => c.method === "analyze");
  assert.equal(analyze.payload.expectedQueueRevision, 0, "loaded revision attached as number");
  assert.equal(isRemoteJsonValue(analyze.payload), true);

  // 0.3：organize 预览（预览整理计划）已裁撤；previewPlan 无损改走遗忘计划行内预览
  //（doPreviewForgetting 不带 expectedQueueRevision——它不改队列，凭 planDigest 校验）。
  calls.length = 0;
  tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览遗忘计划").props.onClick();
  assert.ok(previewResolve, "previewPlan in flight");
  previewResolve({ kind: "forgetting", planId: "fp-A", planDigest: "digest-fp", summary: "ok", diff: [] });
  await flush();
  const preview = calls.find((c) => c.method === "previewPlan");
  assert.equal(preview.payload.kind, "forgetting");
  assert.equal(isRemoteJsonValue(preview.payload), true, "previewPlan payload lossless");
});

test("R4 回归：A 会话在途预览在切到 B 会话后完成——不得渲染确认框，更不得发出 executePlan", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  let previewResolve;
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "previewPlan") return new Promise((resolve) => { previewResolve = resolve; });
      if (method === "listCandidates") return { queueRevision: 0, items: [{ candidateId: "candidate-A" }], plans: [] };
      return {};
    },
  };
  // 会话 A：已加载，点击「预览遗忘计划」（在途挂起；0.3 organize 预览入口裁撤后
  // previewPlan 的会话守卫语义改由遗忘计划行内预览承载）
  host.states.length = 0;
  host.states.push(...loadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览遗忘计划").props.onClick();
  assert.ok(previewResolve, "previewPlan for session-A in flight");

  // 切到会话 B：渲染并运行 effects（同一 guard 对象，会话守卫清状态 + load）
  tree = renderCandidates(dsh, "session-B", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await flush();

  // A 的预览此刻才完成：必须被代际守卫丢弃
  previewResolve({ kind: "forgetting", planId: "fp-A", planDigest: "digest-fp", summary: "preview A", diff: [] });
  await flush();

  tree = renderCandidates(dsh, "session-B");
  const confirm = flattenVNode(tree).find((n) => n.type === "button" && n.children.includes("确认执行（不可撤销）"));
  assert.equal(confirm, undefined, "stale session-A preview must not render under session-B");
  const exec = calls.find((c) => c.method === "executePlan");
  assert.equal(exec, undefined, "stale preview must never trigger executePlan");
});

test("R4 回归：会话切换清空会话绑定状态（data/preview），守卫跟踪新会话并重新加载", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: [], plans: [] };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...loadedStates("session-A"));
  renderCandidates(dsh, "session-A");
  assert.equal(host.states[6].sessionId, "session-A");
  // 切到 B：渲染 + effects（同一 guard 对象，会话守卫清空会话绑定状态 + load）
  renderCandidates(dsh, "session-B", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await flush();
  assert.equal(host.states[6].sessionId, "session-B", "guard holder tracks current session");
  assert.equal(host.states[6].gen, 1, "generation bumped on session change");
  const listCalls = calls.filter((c) => c.method === "listCandidates");
  assert.equal(listCalls.at(-1).session, "session-B", "fresh load for the new session");
  // 守卫清空后 load 又回填：数据归属新会话（queueRevision 来自 B 的响应）
  assert.equal(host.states[0] && host.states[0].queueRevision, 0, "data reloaded for session-B");
});

test("R3 回归：ensureLosslessJson 导出并对 undefined / 非 JSON 值抛 shiori/ui-invalid-payload", async () => {
  const mod = registrations[0].factory((n) => (n === "react" ? reactStub : zod));
  const guard = mod.ensureLosslessJson;
  assert.equal(typeof guard, "function");
  guard({ a: 1, b: null, c: ["x", { d: true }] });
  assert.throws(() => guard({ expectedQueueRevision: undefined }), (e) => e.code === "shiori/ui-invalid-payload");
  assert.throws(() => guard({ nested: { deep: [undefined] } }), (e) => e.code === "shiori/ui-invalid-payload");
  assert.throws(() => guard({ f: () => {} }), (e) => e.code === "shiori/ui-invalid-payload");
  assert.throws(() => guard({ n: Number.NaN }), (e) => e.code === "shiori/ui-invalid-payload");
  assert.throws(() => guard({ when: new Date() }), (e) => e.code === "shiori/ui-invalid-payload");
});

// R6 追加回归：inert / shadow 时数据 tab 渲染「未配置」占位，CandidatesTab 等数据组件
// 不再挂载（用户点不进数据界面，不会吃到 UNSUPPORTED/NOT_CONFIGURED）；getStatus 可用，
// 「状态」「预算配置」tab 不受影响；getStatus 失败时回退旧行为（逐 tab 报错）。
test("R6 追加回归：shadow / inert 模式下数据 tab 呈现未配置占位而非可点数据界面", async () => {
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

  const renderSection = (states) => {
    host.states.length = 0;
    host.states.push(...states);
    host.cursor.v = 0;
    return sectionVNode.type(sectionVNode.props);
  };

  for (const mode of ["shadow", "inert"]) {
    // ShioriSection useState 顺序：tab / sessionId / manual / sessions / modeStatus
    const tree = renderSection(["candidates", "session-A", "", null, { mode, configured: mode === "shadow" }]);
    const flat = flattenVNode(tree);
    assert.ok(!flat.some((n) => typeof n.type === "function" && n.type.name === "CandidatesTab"),
      `${mode}: CandidatesTab must not mount`);
    assert.ok(!flat.some((n) => typeof n.type === "function" && n.type.name === "MemoryTab"),
      `${mode}: MemoryTab must not mount`);
    assert.ok(!flat.some((n) => typeof n.type === "function" && n.type.name === "GraphTab"),
      `${mode}: GraphTab must not mount`);
    const text = collectText(tree);
    assert.ok(text.includes(mode === "inert" ? "未配置（inert）" : "shadow 模式"), `${mode}: placeholder title present`);
    assert.ok(text.includes("装配期探活"), `${mode}: placeholder explains probing-only semantics`);
  }

  // getStatus 失败（modeStatus=null）：回退旧行为，数据 tab 照常挂载，由各 tab 自行报错
  const fallback = flattenVNode(renderSection(["candidates", "session-A", "", null, null]));
  assert.ok(fallback.some((n) => typeof n.type === "function" && n.type.name === "CandidatesTab"),
    "getStatus failure falls back to previous behavior (per-tab errors)");
});

// ---------------------------------------------------------------------------
// Q 返工回归（owner 真机 repro：cannot get property "remote.shiori" without inject）
// 宿主把 remote 命名空间注册为 Cordis 服务键 "remote.<ns>"，消费方必须走
// ctx.get("remote.<ns>") 取；直读 ctx.remote.<ns> 在未注入时会被 Cordis 属性拦截抛错。
// 本插件自己通过 ctx.remote.$mount 提供 "remote.shiori"，故 inject 保持
// ["remote", "slots", "configForms"]，绝不把 remote.shiori 写进 inject（会自锁）。
// 用两种宿主形状验证：
//   A 真实宿主：ctx.get 提供命名空间，remote 上直读 shiori/session 会抛 inject 错误；
//   B 旧宿主：无 ctx.get，仅 ctx.remote.<ns> 属性（回退路径）；
//   C 两者都缺：call 抛 shiori/ui-unavailable、listSessions 返回 null（降级不静默）。
// ---------------------------------------------------------------------------

// 真实宿主形状：ctx.remote 存在（inject 含 "remote"，$mount 可用），但其上没有
// shiori/session 命名空间属性；任何直读都会命中 Cordis 的未注入属性拦截。
function makeHostCtx(host, options) {
  const traps = [];
  const target = { $mount: async () => async () => {} };
  const remote = options.realHost
    ? new Proxy(target, {
        get(obj, key) {
          if (typeof key !== "string" || Reflect.has(obj, key)) return Reflect.get(obj, key);
          traps.push(key);
          throw new Error(`cannot get property "remote.${key}" without inject`);
        },
      })
    : Object.assign({ $mount: target.$mount }, options.legacy);
  const ctx = {
    remote,
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { host.renderSlot = render; return () => {}; },
    },
  };
  if (options.realHost) ctx.get = (key) => options.services[key];
  return { ctx, traps };
}

test("Q 返工回归：真实宿主经 ctx.get 取 remote 命名空间（不再抛 without inject）；ctx.remote 回退仍可用", async () => {
  // ── A 真实宿主形状：命名空间只经 ctx.get 可达 ────────────────────────────
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const calls = [];
  const shioriRpc = {
    getStatus: async (sessionId, payload) => {
      calls.push({ ns: "shiori", method: "getStatus", sessionId, payload });
      return { ok: true, value: { mode: "active", configured: true } };
    },
  };
  const sessionRpc = {
    list: async (payload) => {
      calls.push({ ns: "session", method: "list", payload });
      return { ok: true, value: { items: [{ sessionId: "sess-host-1", title: "宿主会话" }] } };
    },
  };
  const { ctx, traps } = makeHostCtx(host, {
    realHost: true,
    services: { "remote.shiori": shioriRpc, "remote.session": sessionRpc },
  });
  assert.equal("shiori" in ctx.remote, false, "真实宿主：remote 上没有 shiori 属性（命名空间走服务键）");
  assert.equal("session" in ctx.remote, false, "真实宿主：remote 上没有 session 属性");

  const cleanup = await mod.apply(ctx);
  const sectionVNode = host.renderSlot({ entryKey: "dsh-shiori" });
  const api = sectionVNode.props.dsh;
  assert.equal(typeof api.call, "function");

  assert.deepEqual(await api.listSessions(),
    [{ sessionId: "sess-host-1", title: "宿主会话", updatedAt: undefined }],
    "session.list 经 ctx.get 走通（规范化后带 title/updatedAt 字段）");
  assert.deepEqual(await api.call("getStatus", "sess-host-1", {}), { mode: "active", configured: true },
    "shiori 命名空间经 ctx.get 走通");
  assert.deepEqual(calls.map((c) => c.ns), ["session", "shiori"], "两个命名空间都取自 ctx.get");
  assert.deepEqual(traps, [], "全程未直读 ctx.remote.<ns>（否则会命中 without inject 拦截）");

  // 面板首屏：会话下拉用宿主列表填充并自动选中第一项（owner repro：下拉为空）
  host.states.length = 0;
  host.cursor.v = 0;
  host.effects.length = 0;
  host.runEffects.v = true;
  const mounted = host.renderSlot({ entryKey: "dsh-shiori" });
  assert.equal(mounted.type.name, "ShioriSection");
  mounted.type(mounted.props);
  for (const effect of host.effects.splice(0)) effect();
  await flush();
  assert.deepEqual(host.states[3], [{ sessionId: "sess-host-1", title: "宿主会话", updatedAt: undefined }],
    "sessions 状态由宿主列表填充（非 null）");
  assert.equal(host.states[1], "sess-host-1", "自动选中首个会话");
  host.runEffects.v = false;
  host.cursor.v = 0;
  const tree = mounted.type(mounted.props);
  const text = collectText(tree);
  assert.ok(text.includes("宿主会话"), "会话下拉渲染宿主返回的会话");
  assert.ok(!text.includes("宿主 session 列表不可用"), "不再显示「session 列表不可用」降级提示");
  await cleanup();

  // ── B 旧宿主回退：没有 ctx.get，只有 ctx.remote.<ns> 属性直读 ────────────
  const legacyHost = makeStatefulReact();
  const legacyMod = registrations[0].factory((n) => (n === "react" ? legacyHost.react : zod));
  const legacyCalls = [];
  const legacyShiori = {
    getMemoryView: async (sessionId, payload) => {
      legacyCalls.push({ ns: "shiori", sessionId, payload });
      return { ok: true, value: { levels: [] } };
    },
  };
  const legacySession = {
    list: async () => {
      legacyCalls.push({ ns: "session" });
      return { ok: true, value: { items: [{ id: "legacy-1" }] } };
    },
  };
  const { ctx: legacyCtx } = makeHostCtx(legacyHost, {
    realHost: false,
    legacy: { shiori: legacyShiori, session: legacySession },
  });
  assert.equal(typeof legacyCtx.get, "undefined", "旧宿主无 ctx.get");
  const legacyCleanup = await legacyMod.apply(legacyCtx);
  const legacyVNode = legacyHost.renderSlot({ entryKey: "dsh-shiori" });
  const legacyApi = legacyVNode.props.dsh;
  assert.deepEqual(await legacyApi.listSessions(),
    [{ sessionId: "legacy-1", title: "", updatedAt: undefined }],
    "回退路径：session.list 仍可用（只有 id 的旧 DTO 归一为 sessionId）");
  assert.deepEqual(await legacyApi.call("getMemoryView", "sess-legacy", {}), { levels: [] },
    "回退路径：shiori 命名空间仍可用");
  assert.deepEqual(legacyCalls.map((c) => c.ns), ["session", "shiori"]);
  await legacyCleanup();

  // ── C 两者都缺：降级不静默（call 抛 ui-unavailable，列表返回 null） ─────
  const emptyHost = makeStatefulReact();
  const emptyMod = registrations[0].factory((n) => (n === "react" ? emptyHost.react : zod));
  const { ctx: emptyCtx, traps: emptyTraps } = makeHostCtx(emptyHost, { realHost: true, services: {} });
  const emptyCleanup = await emptyMod.apply(emptyCtx);
  const emptyApi = emptyHost.renderSlot({ entryKey: "dsh-shiori" }).props.dsh;
  assert.equal(await emptyApi.listSessions(), null, "缺 remote.session 时返回 null（面板显示降级提示）");
  await assert.rejects(() => emptyApi.call("getStatus", "s", {}), (error) => {
    assert.equal(error.code, "shiori/ui-unavailable");
    assert.ok(!/without inject/.test(String(error.message)), "不得把 Cordis 未注入错误漏给用户");
    return true;
  }, "缺 remote.shiori 时抛 shiori/ui-unavailable");
  // 服务键取不到时才回退旧属性直读；直读被 Cordis 拦截，错误必须被吞掉而不是外泄
  assert.deepEqual([...emptyTraps].sort(), ["session", "shiori"],
    "缺失场景走 ctx.remote 回退，但拦截错误被 try/catch 吞掉（外泄则上面的断言已失败）");
  await emptyCleanup();
});

// ---------------------------------------------------------------------------
// 会话列表 / 下拉（owner 实机 /api/session/list 抓到的真实 DTO）：
// 标题在 item.projections.values.title；子代理会话带 parentSessionId 或
// origin === "subagent"；归档集合在宿主 Cordis 服务 "workspaces" 快照的
// archivedSessionIds 里。以下用真实 client/index.js 执行 + fake host ctx。
// ---------------------------------------------------------------------------

async function mountSessionListPanel(services, sectionProps) {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const { ctx } = makeHostCtx(host, { realHost: true, services });
  const cleanup = await mod.apply(ctx);
  // sectionProps 模拟宿主 slot 传入的 props（如当前会话 sessionId）。
  const sectionVNode = host.renderSlot(Object.assign({ entryKey: "dsh-shiori" }, sectionProps || {}));
  return { host, cleanup, sectionVNode, api: sectionVNode.props.dsh };
}

async function renderFreshPanel(host, sectionVNode) {
  host.states.length = 0;
  host.cursor.v = 0;
  host.effects.length = 0;
  host.runEffects.v = true;
  sectionVNode.type(sectionVNode.props); // 首帧：收集 effects（此时 sessions 尚未加载）
  for (const effect of host.effects.splice(0)) effect();
  await flush();
  host.runEffects.v = false;
  host.cursor.v = 0;
  return sectionVNode;
}

test("会话列表：过滤子代理/归档会话，标题取 projections.values.title，无标题回退 sessionId", async () => {
  const items = [
    // 真机样例：子代理会话（parentSessionId + origin:"subagent"），标题在 projections
    {
      sessionId: "c84f983a-0d7e-43ba-8a37-0aceadd3cef7",
      updatedAt: 1793001853174,
      agentAvailable: false,
      running: false,
      blank: false,
      parentSessionId: "session-6abb73e6-32f9-480b-b2af-06620775843d",
      origin: "subagent",
      cwd: "D:\\work",
      projections: { kind: "cached", asOfSeq: 594, values: { title: "示例子代理会话标题" } },
    },
    // 只有 origin 的子代理会话也必须过滤
    { sessionId: "session-origin-only", origin: "subagent" },
    // 归档会话：不在 session.list 的过滤语义里，靠 workspaces 快照剔除
    { sessionId: "session-archived", updatedAt: 2, projections: { values: { title: "归档会话" } } },
    // 普通会话：标题只在 projections.values.title
    {
      sessionId: "session-467a56b4-fcf0-41f1-8305-f6a8ece86329",
      updatedAt: 1,
      projections: { kind: "cached", asOfSeq: 7, values: { title: "只回答一个字：好" } },
    },
    // item.title 直接可用时也认
    { sessionId: "session-direct-title", title: "直接标题" },
    // projections 里 title 非字符串 → 视为无标题
    { sessionId: "session-no-title", projections: { values: { title: 42 } } },
    // 旧 DTO 只有 id
    { id: "legacy-id-only" },
    // sessionId 为空串 → 丢弃
    { sessionId: "" },
  ];
  const { api, cleanup } = await mountSessionListPanel({
    "remote.session": { list: async () => ({ ok: true, value: { items } }) },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: ["session-archived"] }) } },
  });
  assert.deepEqual(await api.listSessions(), [
    { sessionId: "session-467a56b4-fcf0-41f1-8305-f6a8ece86329", title: "只回答一个字：好", updatedAt: 1 },
    { sessionId: "session-direct-title", title: "直接标题", updatedAt: undefined },
    { sessionId: "session-no-title", title: "", updatedAt: undefined },
    { sessionId: "legacy-id-only", title: "", updatedAt: undefined },
  ], "只保留普通、未归档会话，并归一化 title/sessionId");
  await cleanup();
});

test("会话列表：丢弃非当前空壳会话（blank:true），当前 blank/缺失 blank/有标题的保留；空列表不报错", async () => {
  const items = [
    // 宿主建过但没说过话的裸 session：blank:true、title:null（此条稍后用作「当前会话」）
    { sessionId: "session-blank", blank: true, title: null, updatedAt: 9 },
    // 非当前的 blank 会话：始终丢弃
    { sessionId: "session-other-blank", blank: true, title: null, updatedAt: 6 },
    // blank 字段缺失 → 按 false 处理，不能误杀正常会话
    { sessionId: "session-no-blank-field", updatedAt: 8 },
    // 显式 blank:false + 标题：保留
    { sessionId: "session-titled", blank: false, updatedAt: 7, projections: { values: { title: "有标题的会话" } } },
  ];
  const listed = await mountSessionListPanel({
    "remote.session": { list: async () => ({ ok: true, value: { items } }) },
  });
  assert.deepEqual(await listed.api.listSessions(), [
    { sessionId: "session-no-blank-field", title: "", updatedAt: 8 },
    { sessionId: "session-titled", title: "有标题的会话", updatedAt: 7 },
  ], "blank:true 丢弃；blank 缺失按 false 处理，正常会话不误杀");
  await listed.cleanup();

  // 当前会话（宿主 slot props.sessionId）即使还是 blank，也必须留在列表里；
  // 其它 blank 会话照旧丢弃。
  const current = await mountSessionListPanel({
    "remote.session": { list: async () => ({ ok: true, value: { items } }) },
  }, { sessionId: "session-blank" });
  assert.deepEqual(await current.api.listSessions("session-blank"), [
    { sessionId: "session-blank", title: "", updatedAt: 9 },
    { sessionId: "session-no-blank-field", title: "", updatedAt: 8 },
    { sessionId: "session-titled", title: "有标题的会话", updatedAt: 7 },
  ], "当前 blank 会话保留，其它 blank 仍丢弃");
  // 真实面板路径：loadSessions 把 props.sessionId 透传给 normalize，下拉里能看到自己。
  const currentMounted = await renderFreshPanel(current.host, current.sectionVNode);
  assert.deepEqual(current.host.states[3], [
    { sessionId: "session-blank", title: "", updatedAt: 9 },
    { sessionId: "session-no-blank-field", title: "", updatedAt: 8 },
    { sessionId: "session-titled", title: "有标题的会话", updatedAt: 7 },
  ], "面板列表包含当前 blank 会话");
  const currentOptions = flattenVNode(currentMounted.type(currentMounted.props)).filter((n) => n.type === "option");
  assert.ok(currentOptions.some((option) => option.props.value === "session-blank"), "下拉选项含当前 blank 会话");
  assert.ok(!currentOptions.some((option) => option.props.value === "session-other-blank"), "非当前 blank 会话不出现");
  await current.cleanup();

  // 手动选择列表为空：只渲染占位项，首帧/渲染都不抛错
  const empty = await mountSessionListPanel({
    "remote.session": { list: async () => ({ ok: true, value: { items: [] } }) },
  });
  assert.deepEqual(await empty.api.listSessions(), [], "空 items 返回空数组而不是 null");
  let threw = null;
  let mounted = null;
  try { mounted = await renderFreshPanel(empty.host, empty.sectionVNode); } catch (error) { threw = error; }
  assert.equal(threw, null, "手动选择列表为空时渲染不报错");
  assert.deepEqual(empty.host.states[3], [], "sessions 状态为空数组");
  const options = flattenVNode(mounted.type(mounted.props)).filter((n) => n.type === "option");
  assert.equal(options.length, 1, "手动选择列表为空时只剩「— 选择会话 —」占位");
  await empty.cleanup();
});

test("会话列表：workspaces 服务缺失或快照抛错时不崩溃且不过滤归档", async () => {
  const items = [
    { sessionId: "session-a", updatedAt: 5, projections: { values: { title: "会话 A" } } },
    { sessionId: "session-b", projections: { values: {} } },
  ];
  const expected = [
    { sessionId: "session-a", title: "会话 A", updatedAt: 5 },
    { sessionId: "session-b", title: "", updatedAt: undefined },
  ];
  const missing = await mountSessionListPanel({
    "remote.session": { list: async () => ({ ok: true, value: { items } }) },
  });
  assert.deepEqual(await missing.api.listSessions(), expected, "workspaces 服务缺失 → 不过滤归档、不崩溃");
  await missing.cleanup();

  const broken = await mountSessionListPanel({
    "remote.session": { list: async () => ({ ok: true, value: { items } }) },
    workspaces: { list: { getSnapshot: () => { throw new Error("snapshot boom"); } } },
  });
  assert.deepEqual(await broken.api.listSessions(), expected, "getSnapshot 抛错被吞掉，按无归档处理");
  await broken.cleanup();
});

test("面板会话下拉：标题优先、超 60 字截断、无标题回退 id、option.title 悬停完整 id、自动选中过滤后首条", async () => {
  const longTitle = "记".repeat(65);
  const items = [
    { sessionId: "session-sub", parentSessionId: "p-1", projections: { values: { title: "子代理会话" } } },
    { sessionId: "session-1", projections: { values: { title: longTitle } } },
    { sessionId: "session-2" },
  ];
  const { host, sectionVNode, cleanup } = await mountSessionListPanel({
    "remote.session": { list: async () => ({ ok: true, value: { items } }) },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
  });
  const mounted = await renderFreshPanel(host, sectionVNode);

  assert.equal(host.states[1], "session-1", "自动选中过滤后的第一条（不再是子代理会话）");
  const tree = mounted.type(mounted.props);
  const options = flattenVNode(tree).filter((n) => n.type === "option");
  assert.equal(options.length, 3, "placeholder + 两条普通会话（子代理被过滤）");
  assert.equal(options[0].props.value, "", "空列表占位选项保留");
  assert.equal(options[1].props.value, "session-1");
  assert.equal(options[1].children[0], "记".repeat(60) + "…", "中文标题按字符截断到 60 + 省略号");
  assert.equal(options[1].props.title, "session-1", "option.title 为完整 sessionId");
  assert.equal(options[2].children[0], "session-2", "无标题回退 sessionId");
  assert.equal(options[2].props.title, "session-2");
  assert.ok(!collectText(tree).includes("id · "), "不再使用「id · 标题」形式");
  await cleanup();
});

test("面板会话下拉：过滤后为空时仍渲染「选择会话」占位，sessionId 保持空串", async () => {
  const items = [
    { sessionId: "session-sub", origin: "subagent" },
    { sessionId: "session-archived", projections: { values: { title: "归档" } } },
  ];
  const { host, sectionVNode, cleanup } = await mountSessionListPanel({
    "remote.session": { list: async () => ({ ok: true, value: { items } }) },
    workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: ["session-archived"] }) } },
  });
  const mounted = await renderFreshPanel(host, sectionVNode);
  assert.deepEqual(host.states[3], [], "sessions 状态为空数组（不是 null）");
  assert.equal(host.states[1], "", "不自动选中任何会话");
  const tree = mounted.type(mounted.props);
  const options = flattenVNode(tree).filter((n) => n.type === "option");
  assert.equal(options.length, 1, "只剩「— 选择会话 —」占位");
  assert.equal(options[0].props.value, "");
  assert.ok(collectText(tree).includes("选择或输入会话后展示"), "空列表显示手选提示，不崩溃");
  await cleanup();
});

// ---------------------------------------------------------------------------
// Q 返工回归（owner 真实浏览器 repro）：getStatus 成功返回后面板整块被 React
// 错误边界抹掉，控制台栈：
//   TypeError: status.diagnostics.some is not a function
//     at StatusTab (client.js:420)
// 根因：宿主真实 DTO 的 diagnostics 是对象 —— src/plugin/management.mjs:167-171
// getStatus 返回 { ownerId, generation, started }，而 client 旧代码直接对非数组
// 调用 .some。以下用例全部经真实 slot 渲染函数（ShioriSection → StatusTab），
// 不是单测辅助函数；react stub 有状态，能走通 load() → setStatus → 重渲染。
// ---------------------------------------------------------------------------

async function mountStatusPanel(mod, host) {
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
  host.states.length = 0;
  host.states.push("status", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const statusTab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "StatusTab");
  assert.ok(statusTab, "StatusTab reached through real slot render");
  // 与 mountCandidates 同法：显式传入测试 dsh（slot 上的 props.dsh 是真实 RPC api）。
  return (dsh, sessionId = "session-A") => {
    host.cursor.v = 0;
    return statusTab.type({ dsh, sessionId });
  };
}

// 真实 P 槽 DTO 形状（src/plugin/management.mjs:153-197 getStatus）
function realPStatusDto() {
  return {
    mode: "active",
    configured: true,
    scope: "amber",
    occupancy: { l0Chars: 12, l1Chars: 34, l0Budget: 12000, l1HardCap: 48000 },
    capabilities: { l2: true, organize: true, forgetting: true, tools: true, sections: true },
    diagnostics: { ownerId: "local", generation: 1, started: true },
  };
}

test("Q 返工回归：真实 P 槽 getStatus DTO（diagnostics 为对象）渲染不崩溃，mode 与 diagnostics 键值可见", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);

  const dto = realPStatusDto();
  const calls = [];
  const dsh = {
    call: async (method, sessionId, payload) => {
      calls.push({ method, sessionId, payload });
      assert.equal(method, "getStatus");
      return dto;
    },
  };

  // 首帧 status=null（加载中）；effects 里的 load() 走真实 RPC 成功路径。
  host.states.length = 0;
  host.effects.length = 0;
  host.runEffects.v = true;
  let tree = renderStatus(dsh);
  assert.ok(collectText(tree).includes("加载中"), "first paint is loading state");
  for (const effect of host.effects.splice(0)) effect();
  await flush();
  host.runEffects.v = false;

  assert.equal(host.states[0], dto, "status state filled from successful getStatus");
  assert.deepEqual(calls.map((c) => c.method), ["getStatus"], "exactly one getStatus RPC");

  let threw = null;
  try { tree = renderStatus(); } catch (error) { threw = error; }
  assert.equal(threw, null, "React render path must not throw on real DTO (error boundary would blank the panel)");

  const text = collectText(tree);
  assert.ok(text.includes("mode: active"), "status card shows mode: active");
  assert.ok(text.includes('ownerId: "local"'), "diagnostics.ownerId rendered as key: value");
  assert.ok(text.includes("generation: 1"), "diagnostics.generation rendered as key: value");
  assert.ok(text.includes("started: true"), "diagnostics.started rendered as key: value");

  // 健康 DTO 不带 needs-configuration → 不得误报徽标
  const warnBadge = flattenVNode(tree).find((n) => n.type === "span" && n.className === "dshi_badge dshi_badgeWarn");
  assert.equal(warnBadge, undefined, "no needs-configuration warning on healthy DTO");
});

test("Q 回归对照：diagnostics 为数组 [{code:\"needs-configuration\"}] 时徽标仍显示（旧行为不回归）", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);

  const dto = { mode: "inert", configured: false, diagnostics: [{ code: "needs-configuration" }] };
  host.states.length = 0;
  host.states.push(dto, null); // StatusTab: status / error
  host.runEffects.v = false;
  const tree = renderStatus({ call: async () => ({}) });
  const badge = flattenVNode(tree).find((n) =>
    n.type === "span"
    && n.children.includes("needs-configuration")
    && String(n.props.className).includes("dshi_badgeWarn"));
  assert.ok(badge, "needs-configuration badge rendered for array diagnostics");
});

test("Q 回归对照：diagnostics 对象携带 code = needs-configuration 时同样显示徽标", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);

  const dto = { mode: "inert", configured: false, diagnostics: { ownerId: "local", code: "needs-configuration" } };
  host.states.length = 0;
  host.states.push(dto, null);
  host.runEffects.v = false;
  const tree = renderStatus({ call: async () => ({}) });
  const badge = flattenVNode(tree).find((n) =>
    n.type === "span"
    && n.children.includes("needs-configuration")
    && String(n.props.className).includes("dshi_badgeWarn"));
  assert.ok(badge, "needs-configuration badge rendered for object diagnostics.code");
});
// ---------------------------------------------------------------------------
// R7 回归（owner 实机）：预算 tab 空输入不得写 0，非法值中止整批。
// 证据级别：真实 client/index.js 执行 + 有状态 react stub（非浏览器实机）；
// 提交目标是 fake configForms scope（记录 mutate 的 ops），不触真实宿主。
// ---------------------------------------------------------------------------

const FULL_BUDGETS = {
  core: { targetChars: 8000, hardCapChars: 10000, softRatio: 0.75, hardRatio: 0.9, cacheLockFallback: false },
  persona: { maxChars: 12000 },
  spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 },
};

// U2 标杆页测试装配：真实 client/index.js + 有状态 react stub（setter 写回
// host.states，重渲染即可读到新草稿）。BudgetsTab useState 顺序：
// snapshot / error / ok / draftEdits / occupancy。
async function mountBudgetsTab() {
  const host = makeStatefulReact();
  const mutations = [];
  const state = { revision: 3, written: structuredClone(FULL_BUDGETS) };
  const scope = {
    getSnapshot: () => ({ status: "ready", revision: state.revision, value: { budgets: structuredClone(state.written) } }),
    mutate: (ops, revision) => {
      mutations.push({ ops: structuredClone(ops), revision });
      state.written = structuredClone(ops[0].value);
      state.revision += 1;
      return Promise.resolve(true);
    },
  };
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
    configForms: { get: (ns) => (ns === "shiori" ? scope : undefined) },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  // ShioriSection useState 顺序：tab / sessionId / manual / sessions / modeStatus
  host.states.length = 0;
  host.states.push("budgets", "session-A", "", null, undefined);
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const tab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "BudgetsTab");
  assert.ok(tab, "BudgetsTab reached through real slot render");

  const render = () => {
    host.cursor.v = 0;
    return tab.type(tab.props);
  };
  const mount = () => {
    host.states.length = 0;
    host.cursor.v = 0;
    host.states.push(scope.getSnapshot(), null, null);
    const tree = render();
    const inputs = flattenVNode(tree).filter((n) => n.type === "input" && n.props && n.props["data-path"]);
    const form = flattenVNode(tree).find((n) => n.type === "form");
    assert.ok(form, "form present");
    return { tree, inputs, form };
  };
  const inputFor = (tree, path) => flattenVNode(tree).find((n) => n.type === "input" && n.props && n.props["data-path"] === path);
  const setField = (path, value) => {
    const input = inputFor(render(), path);
    assert.ok(input, "input rendered for " + path);
    input.props.onChange({ target: { value } });
    return render();
  };
  const submitNow = async () => {
    const form = flattenVNode(render()).find((n) => n.type === "form");
    form.props.onSubmit({ preventDefault: () => {} });
    await flush(20);
    return render();
  };
  const submitButton = (tree) => flattenVNode(tree).find((n) => n.type === "button" && n.props && n.props.type === "submit");
  return { mount, render, setField, submitNow, submitButton, mutations, scope, state, host };
}

test("预算 tab（U2 标杆页）：三层九字段、界面名主位、技术名进 tooltip、后果描述 + 实时水位条", async () => {
  const { mount } = await mountBudgetsTab();
  const mounted = mount();
  // 九个可编辑字段；水位字段各渲染「滑杆 + 数字框」两个 input，故 input 共 11 个。
  assert.equal(mounted.inputs.length, 11, "11 inputs (9 fields, water fields have slider + number)");
  assert.equal(mounted.inputs.filter((n) => String(n.props.className) === "dshi_slider").length, 2, "两条水位滑杆");

  const expected = {
    "persona.maxChars": ["人设卡最大字符数", "persona.maxChars", "写入会被拒绝"],
    "core.hardCapChars": ["硬顶", "core.hardCapChars", "不能越过的总长度上限"],
    "core.softChars": ["软水位", "core.softChars", "开始压缩着写"],
    "core.hardChars": ["硬水位（硬闸）", "core.hardChars", "只能删减"],
    "spark.maxChars": ["单次投递长度上限", "spark.maxChars", "发不出去"],
    "spark.inlineMaxChars": ["直接带全文的门槛", "spark.inlineMaxChars", "只发摘要"],
    "spark.maxCards": ["单次最多卡片数", "spark.maxCards", "防止刷屏"],
    "spark.seedCount": ["召回种子数", "spark.seedCount", "种子素材条数"],
    "spark.linkCount": ["关联链接数", "spark.linkCount", "1 跳关联"],
  };
  const labelsByPath = new Map();
  for (const label of flattenVNode(mounted.tree).filter((n) => n.type === "label" && n.props && n.props.className === "dshi_label")) {
    const input = flattenVNode(label).find((n) => n.type === "input" && n.props && n.props["data-path"]);
    if (input) labelsByPath.set(input.props["data-path"], label);
  }
  assert.equal(labelsByPath.size, 9, "九个字段各有 label");
  const wholeText = collectText(mounted.tree);
  for (const [path, parts] of Object.entries(expected)) {
    const label = labelsByPath.get(path);
    assert.ok(label, "label for " + path);
    const text = collectText(label);
    assert.ok(text.includes(parts[0]), path + " 界面名主位: " + parts[0] + " — got: " + text);
    assert.ok(String(label.props.title || "").includes(parts[1]), path + " 技术名进 title tooltip，不在正文里");
    assert.ok(wholeText.includes(parts[2]), path + " 后果描述出现: " + parts[2]);
  }
  // D3：targetChars 留在配置里但面板不展示；旧 ratio 字段也不出现。
  const renderedPaths = new Set(mounted.inputs.map((n) => n.props["data-path"]));
  assert.ok(!renderedPaths.has("core.targetChars"), "targetChars 不渲染（D3）");
  assert.ok(!renderedPaths.has("core.softRatio"), "旧 softRatio 不在面板");
  // 三组分卡（L0 人设卡 / L1 记忆核心 / L2 闪回卡片）
  const text = collectText(mounted.tree);
  for (const part of ["人设卡", "记忆核心", "闪回卡片"]) assert.ok(text.includes(part), "group card: " + part);
  // 实时预览条（本页灵魂）：有占用刻度文案即为渲染成功
  const preview = flattenVNode(mounted.tree).find((n) => n.props && String(n.props.className).includes("dshi_preview"));
  assert.ok(preview, "水位预览条渲染");
  assert.ok(text.includes("软水位") && text.includes("硬闸") && text.includes("硬顶"), "预览条图例");
});

test("预算 tab：草稿取 value.budgets；旧 softRatio/hardRatio 按硬顶换算成水位显示", async () => {
  const { mount } = await mountBudgetsTab();
  const mounted = mount();
  const values = new Map(mounted.inputs.map((n) => [n.props["data-path"], n.props.value]));
  assert.equal(values.get("core.hardCapChars"), "10000");
  assert.equal(values.get("core.softChars"), "7500", "0.75 × 10000 换算");
  assert.equal(values.get("core.softChars.num"), "7500");
  assert.equal(values.get("core.hardChars"), "9000", "0.9 × 10000 换算");
  assert.equal(values.get("core.hardChars.num"), "9000");
  assert.equal(values.get("persona.maxChars"), "12000");
  assert.equal(values.get("spark.maxCards"), "5");
});

test("预算 tab：空输入就地中文报错并禁用保存，绝不写 0（HEAD 老回归）", async () => {
  const { mount, setField, submitButton, mutations } = await mountBudgetsTab();
  mount();
  const tree = setField("persona.maxChars", "");
  // 报错文案必须点名界面上看得见的中文字段名（用户不可能去猜技术名）。
  assert.ok(collectText(tree).includes("人设卡最大字符数必须是正整数"), "空输入按越界处理且点名可见字段名");
  assert.ok(!collectText(tree).includes("persona.maxChars"), "错误文案不点名技术名");
  assert.equal(submitButton(tree).props.disabled, true, "越界时保存按钮禁用");
  assert.equal(mutations.length, 0, "越界不发写入（绝不会把空输入写成 0）");

  // 水位字段的空输入同理：不落 0、不落 null，只报错并禁用保存。
  mount();
  const softTree = setField("core.softChars.num", "");
  assert.ok(collectText(softTree).includes("软水位至少为 1 字符"), "空水位报错");
  assert.equal(submitButton(softTree).props.disabled, true);
  assert.equal(mutations.length, 0, "空水位同样不发写入");
});

test("预算 tab：非法数字就地中文报错并中止整批写入（HEAD 老回归）", async () => {
  const { mount, setField, submitButton, submitNow, mutations } = await mountBudgetsTab();
  mount();
  // 非数字：草稿里保留原文（不是 NaN、不是 0），校验判非法。
  const tree = setField("spark.maxCards", "五");
  const text = collectText(tree);
  assert.ok(text.includes("单次最多卡片数必须是正整数"), "非数字报错点名可见字段名");
  assert.equal(submitButton(tree).props.disabled, true, "非法数字禁用保存");
  // 就算绕过 disabled 直接提交，save() 里的 errorCount 双保险也要拦住整批写入。
  await submitNow();
  assert.equal(mutations.length, 0, "非法数字不得发出任何 budgets 写入");

  mount();
  const floatTree = setField("core.hardCapChars", "10000.5");
  assert.ok(collectText(floatTree).includes("硬顶必须是正整数"), "非整数硬顶报错");
  assert.equal(submitButton(floatTree).props.disabled, true, "非整数硬顶禁用保存");
  await submitNow();
  assert.equal(mutations.length, 0, "整批中止，不写半截");
});

test("预算 tab：上限与联动校验——中文就地提示，越界即禁用保存", async () => {
  const { mount, setField, submitButton } = await mountBudgetsTab();
  mount();
  let tree = setField("persona.maxChars", "60001");
  assert.ok(collectText(tree).includes("超过上限 60000"), "persona 上限");
  assert.equal(submitButton(tree).props.disabled, true);

  mount();
  tree = setField("spark.maxChars", "700");
  assert.ok(collectText(tree).includes("超过上限 600"), "spark 上限");
  assert.equal(submitButton(tree).props.disabled, true);

  mount();
  tree = setField("core.hardCapChars", "abc");
  assert.ok(collectText(tree).includes("硬顶必须是正整数"), "非数字硬顶");
  assert.equal(submitButton(tree).props.disabled, true);

  // 软/硬水位联动钳制：硬顶下调后硬水位 ≤ 硬顶-1、软水位 ≤ 硬水位-1，不留越界态
  mount();
  tree = setField("core.hardCapChars", "5000");
  const values = new Map(flattenVNode(tree).filter((n) => n.type === "input" && n.props && n.props["data-path"]).map((n) => [n.props["data-path"], n.props.value]));
  assert.equal(values.get("core.hardChars"), "4999", "硬水位钳到硬顶-1");
  assert.equal(values.get("core.softChars"), "4998", "软水位跟在硬水位下一格（必须严格小于）");
  assert.equal(submitButton(tree).props.disabled, false, "三个可见字段都合法 → 保存可用（隐藏的 targetChars 不再当硬约束）");
});

test("预算 tab：把硬顶调到原 targetChars 以下仍可保存，落盘后 targetChars 收敛进合法区间（P1）", async () => {
  const { mount, setField, submitNow, submitButton, mutations } = await mountBudgetsTab();
  mount();
  // 出厂 targetChars=8000；把硬顶压到 5000 → 旧实现让 targetChars 越界并禁用保存，
  // 而 targetChars 在面板上根本没有对应输入框，用户无从修。
  let tree = setField("core.hardCapChars", "5000");
  assert.equal(submitButton(tree).props.disabled, false, "保存必须可用");
  assert.equal(flattenVNode(tree).find((n) => n.props && String(n.props.className).includes("dshi_blockError")), undefined, "不渲染任何越界横幅");
  const errorNodes = flattenVNode(tree).filter((n) => n.props && /dshi_fieldError|dshi_blockError/.test(String(n.props.className)));
  assert.deepEqual(errorNodes.map((n) => collectText(n)), [], "没有任何就地错误/越界横幅");
  assert.ok(!flattenVNode(tree).some((n) => n.props && String(n.props.className).includes("dshi_preview") && collectText(n).includes("targetChars")), "预览条也不提隐藏字段");

  tree = await submitNow();
  assert.equal(mutations.length, 1, "一次原子写入");
  const core = mutations[0].ops[0].value.core;
  assert.equal(core.hardCapChars, 5000);
  assert.equal(core.hardChars, 4999);
  assert.equal(core.softChars, 4998);
  assert.equal(core.targetChars, 4998, "targetChars 被收敛进 [软水位, 硬水位-1] 并写回");
  // 落盘值与服务端 validateConfig 的约束对齐：softAt ≤ targetChars < hardAt < cap。
  assert.ok(core.softChars <= core.targetChars, "软水位 ≤ 目标长度");
  assert.ok(core.targetChars < core.hardChars, "目标长度 < 硬水位");
  assert.ok(core.hardChars < core.hardCapChars, "硬水位 < 硬顶");
  assert.match(collectText(tree), /已保存/);
});

test("预算 tab：抬高软水位时 targetChars 跟着上移，不会卡住滑杆", async () => {
  const { mount, setField, submitNow, mutations } = await mountBudgetsTab();
  mount();
  // 出厂 soft=7500 / target=8000：把软水位拉到 8500（> target），target 必须跟着走到 8500。
  setField("core.softChars.num", "8500");
  await submitNow();
  assert.equal(mutations.length, 1);
  const core = mutations[0].ops[0].value.core;
  assert.equal(core.softChars, 8500);
  assert.equal(core.targetChars, 8500, "目标长度跟随软水位，不留在下面形成矛盾");
  assert.ok(core.targetChars < core.hardChars, "仍严格小于硬水位");
});

test("预算 tab：单批原子写 budgets，水位落盘并清除旧 ratio，targetChars 原样保留", async () => {
  const { mount, setField, submitNow, mutations } = await mountBudgetsTab();
  mount();
  setField("persona.maxChars", "11000");
  setField("core.hardChars.num", "9500");
  const tree = await submitNow();
  assert.equal(mutations.length, 1, "一次原子 budgets 写入");
  assert.deepEqual(mutations[0].ops.map((op) => op.path), [["budgets"]]);
  const value = mutations[0].ops[0].value;
  assert.equal(value.core.hardChars, 9500, "水位字段按用户输入落盘");
  assert.equal(value.core.softChars, 7500);
  // 硬水位 9500 后 targetChars 仍在 [7500, 9499] 内 → 保持原值，不被无谓改写。
  assert.equal(value.core.targetChars, 8000, "未触及区间时 targetChars 保持原值");
  assert.equal(value.core.softRatio, undefined, "旧 softRatio 保存时清除");
  assert.equal(value.core.hardRatio, undefined, "旧 hardRatio 保存时清除");
  assert.equal(value.persona.maxChars, 11000, "改动字段写入");
  assert.equal(value.spark.maxCards, 5, "未改字段原样");
  assert.match(collectText(tree), /已保存/);
});

// ---------------------------------------------------------------------------
// Q 槽健壮性（owner 实机：12 个会话里 11 个 getStatus 返回 session/writer-held，
// 五个 tab 各刷一行红字）。覆盖四条验收：
//   A 探测式自动选中（最多 5 个候选，逐次 getStatus）
//   B 会话级不可用不进 tab ErrorBox，面板提示中文文案 + code + 跳过数量
//   C 同一 sessionId 的会话级失败缓存，切 tab 不重复 RPC；「刷新」清缓存强制重试
//   D 非会话级错误照旧进对应 tab ErrorBox（不吞、不伪装成功）
// 全部经真实 client/index.js 与 fake 宿主 ctx（makeHostCtx realHost），无真实网络/宿主调用。
// ShioriSection useState 顺序：tab / sessionId / manual / sessions / modeStatus /
// availability / probeTick（共 7 个），tab 组件从索引 7 开始。
// ---------------------------------------------------------------------------

function probeError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function mountPanel(services) {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const { ctx } = makeHostCtx(host, { realHost: true, services });
  const cleanup = await mod.apply(ctx);
  const sectionVNode = host.renderSlot({ entryKey: "dsh-shiori" });
  return { host, mod, sectionVNode, cleanup };
}

// 首帧执行列表加载 effect，之后只重跑「选中会话后的探测 effect」——
// stub 的 useEffect 不比较依赖，若不跳过首个 effect 会重复 listSessions 并重复探测。
async function bootPanel(host, sectionVNode) {
  host.states.length = 0;
  host.effects.length = 0;
  host.cursor.v = 0;
  host.runEffects.v = true;
  sectionVNode.type(sectionVNode.props);
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  for (let round = 0; round < 4; round++) {
    host.cursor.v = 0;
    host.runEffects.v = true;
    sectionVNode.type(sectionVNode.props);
    const pending = host.effects.splice(0).slice(1);
    if (pending.length === 0) break;
    for (const effect of pending) effect();
    await settle();
  }
  host.runEffects.v = false;
  host.cursor.v = 0;
  return sectionVNode.type(sectionVNode.props);
}

function findComponent(tree, name) {
  return flattenVNode(tree).find((n) => typeof n.type === "function" && n.type.name === name);
}

function findErrorBoxes(tree) {
  return flattenVNode(tree).filter((n) => n.props && n.props.className === "dshi_error");
}

// 面板自身占用的 useState 个数（tab / sessionId / manual / sessions / modeStatus /
// availability / probeTick / workspaces / workspaceId）。面板加 state 时这里要同步 +
// 下面的用例如有下标断言也要跟着挪。
const PANEL_STATES = 9;

// 单独执行一个 tab 组件（面板 useState 之后开始计数），跑它的挂载 effect。
async function runTab(host, vnode) {
  host.cursor.v = PANEL_STATES;
  host.runEffects.v = true;
  vnode.type(vnode.props);
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;
}

test("Q 槽健壮性 A：探测式自动选中——跳过 session/writer-held 选中下一个可用会话", async () => {
  const probed = [];
  const services = {
    "remote.session": {
      list: async () => ({ ok: true, value: { items: [{ sessionId: "s1" }, { sessionId: "s2" }, { sessionId: "s3" }] } }),
    },
    "remote.shiori": {
      getStatus: async (sessionId) => {
        probed.push(sessionId);
        if (sessionId === "s1") return { ok: false, error: { code: "session/writer-held", message: 'session "s1" is already owned by an active write handle' } };
        return { ok: true, value: { mode: "active", configured: true } };
      },
    },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  const tree = await bootPanel(host, sectionVNode);

  assert.equal(host.states[1], "s2", "跳过被写句柄占用的 s1，自动选中 s2");
  assert.deepEqual(probed, ["s1", "s2"], "命中可用会话即停止探测");
  assert.equal(host.states[5].skipped, 1, "记录了 1 个被跳过的会话");
  assert.equal(host.states[5].blocked, false, "可用会话不被标记为 blocked");
  assert.equal(host.states[5].done, true);

  const text = collectText(tree);
  assert.ok(text.includes("宿主无法打开该会话：它正被另一个写句柄占用"), "writer-held 中文文案");
  assert.ok(text.includes("（session/writer-held）"), "提示里展示错误码");
  assert.ok(text.includes("已跳过 1 个宿主不可用的会话"), "提示里带跳过数量");
  assert.ok(findComponent(tree, "StatusTab"), "选中可用会话后正常挂载状态 tab");
  assert.equal(findErrorBoxes(tree).length, 0, "面板本身不出现红色 ErrorBox");
  await cleanup();
});

test("Q 槽健壮性 A：5 个候选全部不可用 → 保持占位项、sessionId 为空、不渲染任何 tab", async () => {
  const probed = [];
  const items = [];
  for (let i = 1; i <= 6; i++) items.push({ sessionId: "sess-" + i });
  const services = {
    "remote.session": { list: async () => ({ ok: true, value: { items } }) },
    "remote.shiori": {
      getStatus: async (sessionId) => {
        probed.push(sessionId);
        return { ok: false, error: { code: "session/writer-held", message: "held " + sessionId } };
      },
    },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  const tree = await bootPanel(host, sectionVNode);

  assert.deepEqual(probed, ["sess-1", "sess-2", "sess-3", "sess-4", "sess-5"], "最多探测 5 个候选");
  assert.equal(host.states[1], "", "全部不可用时 sessionId 置空");
  const select = flattenVNode(tree).find((n) => n.type === "select");
  assert.equal(select.props.value, "", "下拉保持在占位项");
  const options = flattenVNode(tree).filter((n) => n.type === "option");
  assert.equal(options[0].props.value, "", "占位项仍是第一项（selectedIndex 0）");
  const text = collectText(tree);
  assert.ok(text.includes("未选择会话"), "面板显示「未选择会话」占位");
  assert.ok(text.includes("已跳过 5 个宿主不可用的会话"));
  for (const name of ["StatusTab", "MemoryTab", "GraphTab", "CandidatesTab", "BudgetsTab"]) {
    assert.equal(findComponent(tree, name), undefined, name + " 不渲染（避免继续刷错误）");
  }
  await cleanup();
});

test("Q 槽健壮性 A/D：探测遇到非会话级错误也继续，但错误原样暴露（不吞掉）", async () => {
  const services = {
    "remote.session": {
      list: async () => ({ ok: true, value: { items: [{ sessionId: "s1" }, { sessionId: "s2" }] } }),
    },
    "remote.shiori": {
      getStatus: async (sessionId) => {
        if (sessionId === "s1") return { ok: false, error: { code: "INVALID_INPUT", message: "bad session id" } };
        return { ok: true, value: { mode: "active", configured: true } };
      },
    },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  const tree = await bootPanel(host, sectionVNode);

  assert.equal(host.states[1], "s2", "非会话级错误也继续探测下一个候选");
  assert.equal(host.states[5].probeError.code, "INVALID_INPUT", "普通错误缓存在 probeError");
  assert.equal(host.states[5].blocked, false, "普通错误不阻断会话");
  const text = collectText(tree);
  assert.ok(text.includes("[INVALID_INPUT] bad session id"), "普通错误原样显示 [code] message");
  assert.ok(text.includes("已跳过 1 个宿主不可用的会话"));
  await cleanup();
});

test("Q 槽健壮性 B：tab 内的 session/writer-held 不进 ErrorBox，改为面板提示", async () => {
  const services = {
    "remote.session": { list: async () => ({ ok: true, value: { items: [{ sessionId: "session-A", title: "A" }] } }) },
    "remote.shiori": {
      getStatus: async () => ({ ok: true, value: { mode: "active", configured: true } }),
      getMemoryView: async () => ({
        ok: false,
        error: { code: "session/writer-held", message: 'session "session-A" is already owned by an active write handle' },
      }),
    },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  await bootPanel(host, sectionVNode);
  assert.equal(host.states[1], "session-A");

  host.states[0] = "memory";
  host.runEffects.v = false;
  host.cursor.v = 0;
  const firstPaint = sectionVNode.type(sectionVNode.props);
  const memoryTab = findComponent(firstPaint, "MemoryTab");
  assert.ok(memoryTab, "未 blocked 时记忆 tab 正常挂载");
  await runTab(host, memoryTab);

  // MemoryTab 的 state 从 PANEL_STATES 起：view / error。
  assert.equal(host.states[PANEL_STATES + 1], null, "会话级错误不写入 tab 的 error 状态（ErrorBox 不渲染）");
  assert.equal(host.states[5].blocked, true, "面板层缓存会话级失败");
  assert.equal(host.states[5].error.code, "session/writer-held");
  assert.equal(host.states[5].sessionId, "session-A");

  host.cursor.v = 0;
  const after = sectionVNode.type(sectionVNode.props);
  const text = collectText(after);
  assert.ok(text.includes("宿主无法打开该会话：它正被另一个写句柄占用"), "面板提示 writer-held 中文文案");
  assert.ok(text.includes("（session/writer-held）"), "提示展示错误码");
  assert.ok(text.includes("已跳过 1 个宿主不可用的会话"));
  assert.equal(findErrorBoxes(after).length, 0, "不再出现红色 ErrorBox");
  assert.equal(findComponent(after, "MemoryTab"), undefined, "blocked 后暂停该会话的数据请求");
  await cleanup();
});

test("R7：记忆核心编辑初值取磁盘正文 body，而不是含派生索引的渲染视图", async () => {
  // 服务端 getMemoryView 的 l1.text 是「core 正文 + 派生主题索引」的渲染结果，
  // core_write 不剥离索引 —— 草稿若取 text，保存后索引会被固化进 core。这里钉住
  // 客户端必须用 l1.body 作为编辑初值。
  const services = {
    "remote.session": { list: async () => ({ ok: true, value: { items: [{ sessionId: "session-A" }] } }) },
    "remote.shiori": {
      getStatus: async () => ({ ok: true, value: { mode: "active", configured: true } }),
      getMemoryView: async () => ({
        ok: true,
        value: {
          scope: "amber",
          l0: { text: "PERSONA", revision: "r0", chars: 7, budget: 12000, stale: false },
          l1: {
            text: "CORE BODY\n\n## 主题记忆索引 / Topic memory index\n- a [amber] — A",
            body: "CORE BODY",
            revision: "r1",
            chars: 60,
            budget: 10000,
            hardCap: 14000,
          },
        },
      }),
    },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  await bootPanel(host, sectionVNode);
  assert.equal(host.states[1], "session-A");

  host.states[0] = "memory";
  host.cursor.v = 0;
  host.runEffects.v = false;
  const tree = sectionVNode.type(sectionVNode.props);
  const memoryTab = findComponent(tree, "MemoryTab");
  assert.ok(memoryTab, "MemoryTab mounted");
  await runTab(host, memoryTab);

  host.cursor.v = PANEL_STATES;
  let painted = memoryTab.type(memoryTab.props);
  const editButtons = flattenVNode(painted).filter((n) => n.type === "button" && n.children.includes("编辑"));
  assert.equal(editButtons.length, 2, "L0 and L1 both expose an edit button");
  assert.ok(collectText(painted).includes("主题记忆索引"), "预览仍展示完整渲染视图（含派生索引）");

  editButtons[1].props.onClick();   // L1
  host.cursor.v = PANEL_STATES;
  painted = memoryTab.type(memoryTab.props);
  const textarea = flattenVNode(painted).find((n) => n.type === "textarea");
  assert.ok(textarea, "L1 editor opened");
  assert.equal(textarea.props.value, "CORE BODY", "编辑初值取 body，不含派生索引");
  await cleanup();
});

test("Q 槽健壮性 C：同一会话缓存失败——切 tab 不重复 RPC，刷新清缓存强制重试", async () => {
  const calls = [];
  let memoryAttempts = 0;
  const services = {
    "remote.session": { list: async () => ({ ok: true, value: { items: [{ sessionId: "session-A" }] } }) },
    "remote.shiori": {
      getStatus: async (sessionId) => {
        calls.push({ method: "getStatus", sessionId });
        return { ok: true, value: { mode: "active", configured: true } };
      },
      getMemoryView: async () => {
        calls.push({ method: "getMemoryView" });
        memoryAttempts += 1;
        if (memoryAttempts === 1) return { ok: false, error: { code: "session/writer-held", message: "held" } };
        return { ok: true, value: { l0: "L0 内容", l1: "L1 内容" } };
      },
      getGraph: async () => {
        calls.push({ method: "getGraph" });
        return { ok: true, value: { nodes: [] } };
      },
    },
  };
  const countOf = (method) => calls.filter((c) => c.method === method).length;
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  await bootPanel(host, sectionVNode);

  // 1) 记忆 tab 首次数据 RPC 命中 session/writer-held
  host.states[0] = "memory";
  host.runEffects.v = false;
  host.cursor.v = 0;
  let tree = sectionVNode.type(sectionVNode.props);
  const memoryTab = findComponent(tree, "MemoryTab");
  assert.ok(memoryTab);
  await runTab(host, memoryTab);
  assert.equal(memoryAttempts, 1);
  assert.equal(host.states[5].blocked, true);
  assert.equal(countOf("getStatus"), 1, "自动选中只探测一次");

  // 2) 切图谱：blocked 会话不再发任何数据 RPC
  host.states[0] = "graph";
  host.cursor.v = 0;
  tree = sectionVNode.type(sectionVNode.props);
  assert.equal(findComponent(tree, "GraphTab"), undefined, "blocked 时不挂载 GraphTab");
  assert.equal(countOf("getGraph"), 0, "切 tab 不发已判失败的会话数据 RPC");

  // 3) 切回记忆：同一 sessionId 不重发同一 RPC
  host.states[0] = "memory";
  host.cursor.v = 0;
  tree = sectionVNode.type(sectionVNode.props);
  assert.equal(findComponent(tree, "MemoryTab"), undefined);
  assert.equal(memoryAttempts, 1, "同一 sessionId 的会话级失败被缓存，不再发 RPC");

  // 4) 点「刷新」→ 清缓存、强制重新探测 → 成功后 tab 重新挂载并重试
  findButton(tree, "刷新").props.onClick();
  host.cursor.v = 0;
  host.runEffects.v = true;
  sectionVNode.type(sectionVNode.props);
  for (const effect of host.effects.splice(0).slice(1)) effect();
  await settle();
  host.runEffects.v = false;
  assert.equal(countOf("getStatus"), 2, "刷新强制重新探测会话");
  assert.equal(host.states[5].blocked, false, "探测成功后清除 blocked 缓存");

  host.cursor.v = 0;
  tree = sectionVNode.type(sectionVNode.props);
  const retryTab = findComponent(tree, "MemoryTab");
  assert.ok(retryTab, "缓存清除后 tab 重新挂载");
  await runTab(host, retryTab);
  assert.equal(memoryAttempts, 2, "刷新后可重试同一会话的 RPC");
  assert.equal(host.states[PANEL_STATES + 1], null, "重试成功后无错误");
  assert.equal(host.states[PANEL_STATES].l0, "L0 内容");
  await cleanup();
});

test("Q 槽健壮性 D：非会话级错误照旧进对应 tab 的 ErrorBox（不吞、不伪装成功）", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);

  for (const pair of [["INVALID_INPUT", "bad input"], ["gateway/timeout", "upstream timeout"], ["shiori/FAILED", "business failure"]]) {
    const code = pair[0];
    const message = pair[1];
    const dsh = {
      call: async () => { throw probeError(code, message); },
    };
    host.states.length = 0;
    host.effects.length = 0;
    host.runEffects.v = true;
    renderStatus(dsh);
    for (const effect of host.effects.splice(0)) effect();
    await settle();
    host.runEffects.v = false;

    const error = host.states[1];
    assert.ok(error, code + ": error state must be set");
    assert.equal(error.code, code, code + ": code preserved in tab state");

    host.cursor.v = 0;
    const tree = renderStatus(dsh);
    const boxes = findErrorBoxes(tree);
    assert.equal(boxes.length, 1, code + ": exactly one ErrorBox rendered");
    assert.ok(collectText(boxes[0]).includes("[" + code + "] " + message), code + ": ErrorBox shows [code] message");
  }
});

// ---------------------------------------------------------------------------
// R7 回归（owner 实机 3082，DSH 0.2.1-rc.2）：ShioriSection 首帧拉 session 列表
// 瞬时失败（远端 session 命名空间未就绪 / session.list 一次抖动）曾永久退化成手填
// 输入框，「刷新」也救不回来。现在：最多 3 次尝试（300ms / 900ms 递进），成功（数组，
// 含空数组）立刻 setSessions + probeCandidates；「刷新」在列表为 null/空时重新拉列表。
// 全部经真实 client/index.js + mountPanel/bootPanel helpers，无假实现。
// ---------------------------------------------------------------------------

async function waitMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2500) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await waitMs(25);
  }
  return false;
}

// 用当前 states 重画面板（不重跑 effect，避免误触发挂载期 effect）。
function repaint(host, sectionVNode) {
  host.cursor.v = 0;
  host.runEffects.v = false;
  return sectionVNode.type(sectionVNode.props);
}

test("R7 回归 a：列表第一次返回 null、第二次返回数组 → 自动重试后出现下拉并选中可用会话", async () => {
  let listCalls = 0;
  const probed = [];
  const services = {
    "remote.session": {
      list: async () => {
        listCalls += 1;
        return listCalls === 1
          ? null
          : { ok: true, value: { items: [{ sessionId: "s1", title: "会话一" }] } };
      },
    },
    "remote.shiori": {
      getStatus: async (sessionId) => {
        probed.push(sessionId);
        return { ok: true, value: { mode: "active", configured: true } };
      },
    },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  let tree = await bootPanel(host, sectionVNode);
  assert.equal(listCalls, 1, "首帧只拉一次，失败后进入 300ms 重试等待");
  assert.equal(host.states[3], undefined, "重试期间 sessions 保持 undefined（首帧未出结果）");
  assert.ok(!collectText(tree).includes("宿主 session 列表不可用"), "首帧未出结果不显示不可用提示");

  assert.equal(await waitFor(() => listCalls >= 2), true, "自动重试第二次尝试");
  await settle();
  tree = repaint(host, sectionVNode);

  assert.equal(listCalls, 2, "第二次成功即停止重试");
  assert.equal(host.states[1], "s1", "成功后立刻 probeCandidates 选中可用会话");
  assert.deepEqual(probed, ["s1"], "只探测一次");
  const select = flattenVNode(tree).find((n) => n.type === "select");
  assert.ok(select, "列表成功后渲染 <select>（不再是手填 input）");
  assert.equal(select.props.value, "s1", "下拉选中探测成功的会话");
  const optionValues = flattenVNode(tree).filter((n) => n.type === "option").map((n) => n.props.value);
  assert.deepEqual(optionValues, ["", "s1"]);
  assert.ok(collectText(tree).includes("会话一"), "标题作为选项文案");
  assert.equal(flattenVNode(tree).find((n) => n.type === "input"), undefined, "手填输入框消失");
  await cleanup();
});

test("R7 回归 b：连续 3 次返回 null → 手填输入框 + 提示；点「刷新」第 4 次成功变下拉", async () => {
  let listCalls = 0;
  const probed = [];
  const services = {
    "remote.session": {
      list: async () => {
        listCalls += 1;
        if (listCalls <= 3) return null;
        return { ok: true, value: { items: [{ sessionId: "s1", title: "会话一" }] } };
      },
    },
    "remote.shiori": {
      getStatus: async (sessionId) => {
        probed.push(sessionId);
        return { ok: true, value: { mode: "active", configured: true } };
      },
    },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  await bootPanel(host, sectionVNode);

  assert.equal(await waitFor(() => listCalls >= 3), true, "3 次尝试（300ms + 900ms 间隔）全部执行");
  await settle();
  let tree = repaint(host, sectionVNode);

  assert.equal(listCalls, 3, "最多 3 次尝试，不无限重试");
  assert.equal(host.states[3], null, "3 次都失败 → sessions=null（旧兜底）");
  assert.ok(flattenVNode(tree).find((n) => n.type === "input"), "出现手填 session id 输入框");
  let text = collectText(tree);
  assert.ok(text.includes("宿主 session 列表不可用"), "确定失败时才显示不可用提示");
  assert.ok(text.includes("请手动输入 session id"));

  const refresh = findButton(tree, "刷新");
  refresh.props.onClick();
  // 刷新后重画并跑非挂载期 effect（跳过首个 list 加载 effect，点击已触发拉取）。
  host.cursor.v = 0;
  host.runEffects.v = true;
  sectionVNode.type(sectionVNode.props);
  for (const effect of host.effects.splice(0).slice(1)) effect();
  await settle();
  host.runEffects.v = false;
  tree = repaint(host, sectionVNode);

  assert.equal(listCalls, 4, "「刷新」重新拉列表（第 4 次）");
  assert.equal(host.states[3].length, 1, "刷新成功后 sessions 恢复为数组");
  assert.equal(host.states[1], "s1", "刷新成功后 probeCandidates 选中可用会话");
  assert.deepEqual(probed, ["s1"]);
  const select = flattenVNode(tree).find((n) => n.type === "select");
  assert.ok(select, "刷新成功后从手填输入框变回 <select>");
  assert.equal(select.props.value, "s1");
  assert.ok(!collectText(tree).includes("宿主 session 列表不可用"), "恢复后不再显示不可用提示");
  await cleanup();
});

test("R7 回归 c：已有列表时点「刷新」不重新 listSessions（只重探候选）", async () => {
  let listCalls = 0;
  let probes = 0;
  const services = {
    "remote.session": {
      list: async () => {
        listCalls += 1;
        return { ok: true, value: { items: [{ sessionId: "s1" }] } };
      },
    },
    "remote.shiori": {
      getStatus: async () => {
        probes += 1;
        return { ok: false, error: { code: "session/writer-held", message: "held" } };
      },
    },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  let tree = await bootPanel(host, sectionVNode);

  assert.equal(listCalls, 1);
  assert.equal(probes, 1, "首帧自动探测一次");
  assert.ok(collectText(tree).includes("已跳过 1 个宿主不可用的会话"), "候选不可用时出现刷新入口");

  findButton(tree, "刷新").props.onClick();
  await settle();
  tree = repaint(host, sectionVNode);

  assert.equal(listCalls, 1, "已有列表时「刷新」不重新拉列表");
  assert.equal(probes, 2, "「刷新」只重新探测候选");
  assert.equal(Array.isArray(host.states[3]) && host.states[3].length, 1, "列表保持不变");
  await cleanup();
});

// ---------------------------------------------------------------------------
// 第 4 轮回归（owner work order Q-A / Q-B / Q-C）。
// 证据级别：真实 client/index.js 执行 + 有状态 react stub（非浏览器实机）；
// executeTool / previewPlan / executePlan 均打桩，纯合成数据，不触真实宿主。
// 第 5 轮返工（owner a4 复核 r-3b6a5071）：夹具改为宿主真实 queueDto 形状
// items[i] = { candidate: {id, kind, scopeId, sources, evidence}, status }
// （src/organize/queue.mjs item 结构 / src/plugin/management.mjs queueDto:136-144），
// 不再用扁平对象掩盖真机 DTO。
// ---------------------------------------------------------------------------

function clusterLoadedStates(sessionId) {
  return [
    {
      queueRevision: 5,
      items: [{
        candidate: {
          id: "cluster-A", kind: "cluster", scopeId: "default",
          sources: [{ id: "s1", revision: 1 }, { id: "s2", revision: 1 }],
          evidence: { field: "entities", sharedTerm: "项目X" },
        },
        status: "pending",
      }, {
        candidate: {
          id: "link-B", kind: "link", scopeId: "default",
          // 真实形状补正（review a1 打回项 2）：link 候选两卡配对，补第二张源卡。
          sources: [{ id: "s3", revision: 1 }, { id: "s4", revision: 1 }], evidence: {},
        },
        status: "pending",
      }],
      plans: [],
    },
    null, false, JSON.stringify({ kind: "link", links: [] }), null, null,
    { sessionId, gen: 0 },
  ];
}



test("Q-B 回归：遗忘计划预览与执行的错误路径给出可读中文提示（UNSUPPORTED / REVISION_CONFLICT / NOT_FOUND），原 code 保留", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") {
        return { queueRevision: 0, items: [], plans: [{ planId: "fp-1", kind: "forgetting", planDigest: "d", executed: false, superseded: false }] };
      }
      if (method === "previewPlan") {
        throw Object.assign(new Error("legacy topics remain read-only"), { code: "UNSUPPORTED" });
      }
      if (method === "executePlan") {
        throw Object.assign(new Error("plan already executed"), { code: "REVISION_CONFLICT" });
      }
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(
    { queueRevision: 0, items: [], plans: [{ planId: "fp-1", kind: "forgetting", planDigest: "d", executed: false, superseded: false }] },
    null, false, "", null, null,
    { sessionId: "session-A", gen: 0 });

  // UNSUPPORTED：遗忘计划行内「预览遗忘计划」触达服务端错误映射
  let tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览遗忘计划").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  let text = collectText(tree);
  assert.ok(text.includes("[UNSUPPORTED]"), "original code preserved");
  assert.ok(text.includes("不支持该操作"), "UNSUPPORTED explained in Chinese");
  assert.ok(text.includes("legacy topics remain read-only"), "original message retained");

  // REVISION_CONFLICT：预置一条已成功预览（模拟用户此前已预览过），走确认执行错误路径
  host.states[4] = { sessionId: "session-A", plan: { kind: "forgetting", planId: "fp-1", planDigest: "digest-F", summary: "", diff: [] } };
  tree = renderCandidates(dsh, "session-A");
  findButton(tree, "确认执行").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  text = collectText(tree);
  assert.ok(text.includes("revision 冲突"), "REVISION_CONFLICT explained in Chinese");
  assert.ok(text.includes("plan already executed"), "original message retained");
  assert.equal(calls.filter((c) => c.method === "executePlan").length, 1, "executePlan attempted once");

  // NOT_FOUND：过期的遗忘计划预览（guard 已把 data 刷成空列表，补一条计划）
  calls.length = 0;
  host.states[0] = { queueRevision: 0, items: [], plans: [{ planId: "fp-gone", kind: "forgetting", planDigest: "d2", executed: false, superseded: false }] };
  const boomDsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: [], plans: [] };
      if (method === "previewPlan") throw Object.assign(new Error("plan no longer open"), { code: "NOT_FOUND" });
      return {};
    },
  };
  tree = renderCandidates(boomDsh, "session-A");
  findButton(tree, "预览遗忘计划").props.onClick();
  await flush();
  tree = renderCandidates(boomDsh, "session-A");
  text = collectText(tree);
  assert.ok(text.includes("[NOT_FOUND]"), "NOT_FOUND code preserved");
  assert.ok(text.includes("该候选或计划已过期") && text.includes("点「刷新」重新读取"), "stale guidance points to 刷新 (0.3 无再分析入口)");
});

test("Q-B 回归：队列 revision 前进后旧 preview 拒绝执行（executePlan 零调用）；revision 一致时正常执行", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 7, items: [], plans: [] };
      if (method === "executePlan") return { executed: true };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(
    { queueRevision: 7, items: [], plans: [] },
    null, false, JSON.stringify({ kind: "link", links: [] }),
    { sessionId: "session-A", plan: { kind: "organize", planId: "plan-A", planDigest: "digest-A", summary: "", diff: [] }, queueRevision: 3 },
    null,
    { sessionId: "session-A", gen: 0 });
  let tree = renderCandidates(dsh, "session-A");
  // U5b rework：plan.kind="organize" 属未知 kind，按钮为「确认执行」（审查授权改）
  findButton(tree, "确认执行").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  assert.ok(collectText(tree).includes("队列已变化（预览基于 revision 3，当前 7）"), "stale queue revision explained");
  assert.ok(collectText(tree).includes("shiori/ui-stale-preview"), "stale preview code visible");
  assert.equal(calls.filter((c) => c.method === "executePlan").length, 0, "executePlan never sent on stale preview");

  // revision 对齐后可执行
  host.states[4] = { sessionId: "session-A", plan: { kind: "organize", planId: "plan-A", planDigest: "digest-A", summary: "", diff: [] }, queueRevision: 7 };
  tree = renderCandidates(dsh, "session-A");
  // U5b rework：同上，未知 kind → 「确认执行」（审查授权改）
  findButton(tree, "确认执行").props.onClick();
  await flush();
  const exec = calls.find((c) => c.method === "executePlan");
  assert.ok(exec, "executePlan sent when revisions match");
  assert.equal(exec.payload.planDigest, "digest-A");
  assert.equal(exec.payload.confirmed, true);
});

test("Q-B 回归：plans 列表区分 open/executed/superseded——executed 与 superseded 行禁用 preview、对应 preview 的执行按钮禁用（真实 DTO 无 operationId，不再断言）", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  // planStore.list 真实投影（src/plugin/state.mjs）：planId/kind/planDigest/queueRevision/
  // changedItems/summary/createdAt/executed + P a4 起的 superseded 布尔——无 executedWith/operationId。
  const planRows = [
    { planId: "plan-open", kind: "forgetting", planDigest: "d1", queueRevision: 0, changedItems: 1, summary: "s", createdAt: "2026-10-27T00:00:00.000Z", executed: false, superseded: false },
    { planId: "plan-done", kind: "forgetting", planDigest: "d2", queueRevision: 0, changedItems: 1, summary: "s", createdAt: "2026-10-27T00:01:00.000Z", executed: true, superseded: false },
    { planId: "plan-sup", kind: "forgetting", planDigest: "d4", queueRevision: 0, changedItems: 1, summary: "s", createdAt: "2026-10-27T00:02:00.000Z", executed: false, superseded: true },
  ];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: [], plans: planRows };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(
    { queueRevision: 0, items: [], plans: planRows },
    null, false, "",
    { sessionId: "session-A", plan: { kind: "forgetting", planId: "plan-done", planDigest: "d2", summary: "", diff: [] }, queueRevision: 0 },
    null,
    { sessionId: "session-A", gen: 0 });
  const tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  // 徽章中文化：按 badge 节点的文本断言，避免命中 hint 里的同名词
  const badgeText = flattenVNode(tree)
    .filter((n) => n.type === "span" && String(n.props.className || "").includes("dshi_badge"))
    .map((n) => collectText(n))
    .join("|");
  assert.ok(badgeText.includes("已执行"), "executed badge rendered (已执行)");
  assert.ok(badgeText.includes("已作废"), "superseded badge rendered (已作废)");
  assert.ok(badgeText.includes("待执行"), "open badge rendered (待执行)");
  assert.ok(!text.includes("op op-9"), "no fake operationId: real DTO has no executedWith");
  assert.ok(text.includes("该计划已执行：不可再次预览 / 执行"), "executed row hint");
  assert.ok(text.includes("该计划已被新预览作废（superseded）"), "superseded row hint");
  // 0.3：整理类计划卡裁撤——kind=organize/merge-topic 的计划不再渲染（上面夹具已只含 forgetting）
  // preview forgetting：open 行可用；superseded 行渲染但禁用（点了也不发）；executed 行不渲染
  const previewButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("预览遗忘计划"));
  assert.equal(previewButtons.length, 2, "open + superseded forgetting rows render the button");
  const enabledButton = previewButtons.find((n) => n.props.disabled === false);
  const disabledButton = previewButtons.find((n) => n.props.disabled === true);
  assert.ok(enabledButton && disabledButton, "superseded row's button disabled, open row's enabled");
  // 预览 plan-done 的确认按钮被禁用（plans 行 executed 标记）
  // U5b rework：plan.kind="forgetting" 属未知 kind，按钮为「确认执行」（审查授权改）
  const confirm = flattenVNode(tree).find((n) => n.type === "button" && n.children.includes("确认执行"));
  assert.ok(confirm, "confirm button rendered");
  assert.equal(confirm.props.disabled, true, "execute disabled for executed plan");
  assert.ok(text.includes("该计划已执行或已被新预览作废"), "disabled reason rendered");
  // 作废计划不发 RPC：preview 挂 plan-sup 时确认禁用
  host.states[4] = { sessionId: "session-A", plan: { kind: "forgetting", planId: "plan-sup", planDigest: "d4", summary: "", diff: [] }, queueRevision: 0 };
  const tree2 = renderCandidates(dsh, "session-A");
  // U5b rework：同上，未知 kind → 「确认执行」（审查授权改）
  const confirm2 = flattenVNode(tree2).find((n) => n.type === "button" && n.children.includes("确认执行"));
  assert.equal(confirm2.props.disabled, true, "execute disabled for superseded plan");
  assert.equal(calls.filter((c) => c.method === "previewPlan" || c.method === "executePlan").length, 0, "zero RPC for superseded plan");
});

test("Q-C 回归：diagnostics 新字段容错——codec/transport 等未知字段照常渲染，undefined 值忽略，不崩、不显示 undefined", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountStatusPanel(mod, host);
  const dto = {
    mode: "active", configured: true,
    diagnostics: {
      ownerId: "local", generation: 3, started: true,
      codec: "src", transport: "gateway",
      futureField: { nested: [1, 2, { deep: true }] },
      absentLater: undefined,
    },
  };
  host.states.length = 0;
  host.states.push(dto, null); // StatusTab: status / error
  const tree = renderStatus({ call: async () => ({}) });
  const text = collectText(tree);
  assert.ok(text.includes("codec") && text.includes('"src"'), "new codec field rendered as key: value");
  assert.ok(text.includes("transport") && text.includes('"gateway"'), "new transport field rendered");
  assert.ok(text.includes("futureField"), "unknown future field rendered (tolerated)");
  assert.ok(!text.includes("undefined"), "undefined never displayed");
  assert.ok(text.includes("ownerId") && text.includes("generation: 3"), "known fields unchanged");
});

// ---------------------------------------------------------------------------
// 第 5 轮返工回归（owner a4 复核 r-3b6a5071：候选 id/kind 取错层级 + 死 proposal）。
// 夹具一律用宿主真实 queueDto 形状 { candidate: {id,kind,scopeId,sources,evidence}, status }。
// ---------------------------------------------------------------------------

test("Q-A 回归（真实 queueDto）：reviewed / dismissed 两按钮发出的 candidateId 均为 item.candidate.id，不退化为数组下标", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 5, items: clusterLoadedStates("x")[0].items, plans: [] };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  const buttonsOf = (label) => flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes(label));

  // 第一行 cluster-A：审阅按钮发 candidate.id（0.3：preview organize 按钮随整理流程裁撤）
  buttonsOf("稍后再说")[0].props.onClick();
  buttonsOf("忽略")[0].props.onClick();
  await flush();
  const reviewed = calls.find((c) => c.method === "reviewCandidate" && c.payload.decision === "reviewed");
  const dismissed = calls.find((c) => c.method === "reviewCandidate" && c.payload.decision === "dismissed");
  assert.ok(reviewed && dismissed, "review actions issued");
  assert.equal(reviewed.payload.candidateId, "cluster-A", "reviewed sends candidate.id");
  assert.equal(dismissed.payload.candidateId, "cluster-A", "dismissed sends candidate.id");

  // 第二行 link-B：同样发 candidate.id
  calls.length = 0;
  tree = renderCandidates(dsh, "session-A");
  buttonsOf("稍后再说")[1].props.onClick();
  await flush();
  const linkReview = calls.find((c) => c.method === "reviewCandidate");
  assert.ok(linkReview, "link row review issued");
  assert.equal(linkReview.payload.candidateId, "link-B", "link row sends candidate.id (not index 1)");

  // 兜底断言：任何发出去的 candidateId 都不是纯下标
  const sentIds = calls.filter((c) => c.payload && c.payload.candidateId !== undefined).map((c) => c.payload.candidateId);
  for (const id of sentIds) assert.ok(id === "cluster-A" || id === "link-B", `no index sent as business id (got ${id})`);
});

test("Q-A 回归：旧扁平形状兼容——candidateId 仍被读取；缺业务 id 的行按钮禁用，绝不把下标当 id 发出", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return {
        queueRevision: 0,
        items: [
          { candidateId: "flat-1", kind: "link", sources: [{ id: "s1", revision: 1 }], evidence: {} },
          { status: "pending" },
        ],
        plans: [],
      };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(
    { queueRevision: 0, items: [
      { candidateId: "flat-1", kind: "link", sources: [{ id: "s1", revision: 1 }], evidence: {} },
      { status: "pending" },
    ], plans: [] },
    null, false, JSON.stringify({ kind: "link", links: [{ id: "s1", after: [{ target: "t-a", rel: null }] }] }), null, null,
    { sessionId: "session-A", gen: 0 });
  const tree = renderCandidates(dsh, "session-A");
  // U5 改口径：按钮改名「稍后再说」（契约不变：仍发 decision=reviewed、用业务 id）。
  const reviewedButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("稍后再说"));
  assert.equal(reviewedButtons.length, 2, "both rows rendered");
  assert.equal(reviewedButtons[0].props.disabled, false, "flat candidateId row enabled (compat)");
  assert.equal(reviewedButtons[1].props.disabled, true, "id-less row disabled: index must never be sent as id");

  reviewedButtons[0].props.onClick();
  await flush();
  const call = calls.find((c) => c.method === "reviewCandidate");
  assert.ok(call, "flat row action issued");
  assert.equal(call.payload.candidateId, "flat-1", "flat candidateId used as business id");
  assert.equal(calls.filter((c) => c.payload && (c.payload.candidateId === "0" || c.payload.candidateId === "1")).length, 0,
    "no index ever sent as candidateId");
});


// ---------------------------------------------------------------------------
// 第 6 轮返工回归（owner a5 复核 r-5f0dd70f：B-Q3 details 遮断 / B-Q2 死默认值 /
// superseded / operationId 虚假断言）。
// ---------------------------------------------------------------------------

// 宿主判据逐字复刻：dsh-api-gateway/lib/index.js rpcFailure 与
// dsh-client-connection/lib/client.browser.js parseConnectionResponse 失败分支。
// 断言用宿主真实 isRecord 语义，不自造宽松判据。
function gatewayIsRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function gatewayRpcFailure(error) {
  const remote = remoteErrorOf(error);
  if (remote !== void 0) return { ok: false, error: { code: remote.code, message: remote.message, details: remote.details } };
  return { ok: false, error: { code: "gateway/internal", message: error instanceof Error ? error.message : String(error), details: {} } };
}
function clientParseFailure(result) {
  if (!gatewayIsRecord(result)) throw new TypeError("connection: invalid server-response result");
  if (result.ok === true) return result;
  if (result.ok !== false || !gatewayIsRecord(result.error)) throw new TypeError("connection: invalid server-response result");
  const error = result.error;
  if (typeof error.code !== "string" || typeof error.message !== "string" || !gatewayIsRecord(error.details)) {
    throw new TypeError("connection: invalid server-response failure");
  }
  return result;
}

function wireRoundTrip(error) {
  const envelope = gatewayRpcFailure(error);
  return JSON.parse(JSON.stringify(envelope)); // gateway → JSON over the wire
}

const RPC_METHODS = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline"];
const NOOP_MANAGEMENT = () => Object.fromEntries(RPC_METHODS.map((m) => [m, async () => ({})]));
const REVIEW_PAYLOAD = { candidateId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", decision: "reviewed", expectedQueueRevision: 5, operationId: "op-1" };

async function catchRpcError(management, method, opts) {
  const ctx = fakeCtx();
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const service = ctx.get("shiori.panel");
  let caught;
  try { await callAs(ctx, service, method, opts); } catch (e) { caught = e; }
  await rpc.stop();
  return caught;
}

test("B-Q3 回归：全部 RemoteError 出口的 details 恒为对象——经 gateway 搬运 + JSON 往返后宿主客户端判据不再抛 invalid server-response failure", async () => {
  const exits = {};
  // 出口 1：业务错误带 details（P protocol failInvalid 形状）→ 透传
  exits["business + details"] = await catchRpcError(Object.fromEntries(RPC_METHODS.map((m) => [m, m === "reviewCandidate"
    ? async () => { const e = new Error("biz fail"); e.code = "INVALID_INPUT"; e.details = { violations: [{ path: "proposal.links", message: "minItems" }] }; throw e; }
    : async () => ({})])), "reviewCandidate", { payload: REVIEW_PAYLOAD });
  // 出口 2：业务错误无 details → { code } 兜底
  exits["business bare"] = await catchRpcError(Object.fromEntries(RPC_METHODS.map((m) => [m, m === "reviewCandidate"
    ? async () => { const e = new Error("biz bare"); e.code = "REVISION_CONFLICT"; throw e; }
    : async () => ({})])), "reviewCandidate", { payload: REVIEW_PAYLOAD });
  // 出口 3：无 code 普通 Error → INTERNAL + { code }
  exits["INTERNAL"] = await catchRpcError(Object.fromEntries(RPC_METHODS.map((m) => [m, m === "reviewCandidate"
    ? async () => { throw new Error("bare"); }
    : async () => ({})])), "reviewCandidate", { payload: REVIEW_PAYLOAD });
  // 出口 4/5：guest / 无 invocation → shiori/unauthorized
  exits["unauthorized guest"] = await catchRpcError(NOOP_MANAGEMENT(), "getStatus", { principal: "guest" });
  exits["unauthorized no-invocation"] = await catchRpcError(NOOP_MANAGEMENT(), "getStatus", { principal: null });
  // 出口 6：非宿主 session → shiori/invalid-session
  exits["invalid-session"] = await catchRpcError(NOOP_MANAGEMENT(), "getStatus", { session: { noId: true } });

  for (const [label, error] of Object.entries(exits)) {
    assert.ok(error, `${label}: error thrown`);
    const wire = wireRoundTrip(error);
    // 宿主客户端真实判据：此前这里抛 "connection: invalid server-response failure"
    const parsed = clientParseFailure(wire);
    assert.equal(gatewayIsRecord(parsed.error.details), true, `${label}: details is record after JSON round-trip (got ${JSON.stringify(parsed.error.details)})`);
  }
  // 各出口 details 内容如实
  assert.deepEqual(exits["business + details"].details, { violations: [{ path: "proposal.links", message: "minItems" }] },
    "P failInvalid details passed through verbatim");
  assert.deepEqual(exits["business bare"].details, { code: "REVISION_CONFLICT" }, "no details → { code }");
  assert.deepEqual(exits["INTERNAL"].details, { code: "INTERNAL" });
  assert.equal(exits["unauthorized guest"].details.code, "shiori/unauthorized");
  assert.equal(exits["invalid-session"].details.code, "shiori/invalid-session");
});

test("B-Q3 回归：rpc-stopped 出口 details 为对象且携带 method；INVALID_INPUT violations 经 JSON 往返后客户端仍可达", async () => {
  const ctx = fakeCtx();
  const rpc = await mountShioriRpc(ctx, NOOP_MANAGEMENT(), { mode: "shadow", dataRoot: null, stateRoot: null });
  const service = ctx.get("shiori.panel");
  await rpc.stop(); // 完成 stop → state.closed
  let caught;
  try { await callAs(ctx, service, "getStatus"); } catch (e) { caught = e; }
  assert.ok(caught, "rpc-stopped thrown after stop");
  assert.equal(caught.code, "shiori/rpc-stopped");
  assert.equal(gatewayIsRecord(caught.details), true, "rpc-stopped details is record");
  assert.equal(caught.details.method, "getStatus", "rpc-stopped details carries method");
  const wire = wireRoundTrip(caught);
  assert.doesNotThrow(() => clientParseFailure(wire), "client parses the failure envelope");
  await rpc.stop(); // 幂等

  // violations 端到端：details.violations 在 JSON 往返后仍能被客户端读到
  const violationError = await catchRpcError(Object.fromEntries(RPC_METHODS.map((m) => [m, m === "previewPlan"
    ? async () => { const e = new Error("payload does not match any allowed shape"); e.code = "INVALID_INPUT"; e.details = { violations: [{ path: "proposal", message: "must match link or merge-topic" }] }; throw e; }
    : async () => ({})])), "previewPlan", { payload: { kind: "organize" } });
  const violationWire = wireRoundTrip(violationError);
  const parsedEnvelope = clientParseFailure(violationWire);
  assert.deepEqual(parsedEnvelope.error.details.violations,
    [{ path: "proposal", message: "must match link or merge-topic" }],
    "INVALID_INPUT violations reachable on the client after JSON round-trip");
});



// ---------------------------------------------------------------------------
// 展示层步骤引导（merge 卡片）：未选目标主题 → ① 进行中 + 中性提示；选定 → 合并表单/预览按钮
// ---------------------------------------------------------------------------

function mergeTopicsDsh(calls) {
  return {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 5, items: [], plans: [] };
      if (method === "executeTool" && payload.name === "memory_list_topics") {
        return { topics: [
          { key: "t-live", title: "活主题", summary: "s", updated: "2026-10-26T10:00:00.000Z", revision: "shiori-r1.AbCdEf.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
        ] };
      }
      if (method === "executeTool" && payload.name === "memory_read") {
        return { exists: true, content: "# 已有正文\n", revision: "shiori-r1.R34D.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" };
      }
      return {};
    },
  };
}




// ---------------------------------------------------------------------------
// 第 7 轮：候选面板布局与中文文案（就地展开合并卡 / 按钮徽章中文化 / 原始 JSON 折叠）
// ---------------------------------------------------------------------------


test("第 7 轮：按钮与徽章中文化——页面不再出现英文旧文案，点「稍后再说」仍发 status=reviewed", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 5, items: clusterLoadedStates("x")[0].items, plans: [] };
      return {};
    },
  };
  // 计划行：organize / forgetting 两种 kind 的徽章都要中文化
  const planRows = [
    { planId: "plan-o", kind: "organize", planDigest: "do", queueRevision: 0, changedItems: 1, summary: "s", createdAt: "2026-10-27T00:00:00.000Z", executed: false, superseded: false },
    { planId: "plan-f", kind: "forgetting", planDigest: "df", queueRevision: 0, changedItems: 1, summary: "s", createdAt: "2026-10-27T00:01:00.000Z", executed: false, superseded: false },
  ];
  const seeded = clusterLoadedStates("session-A");
  seeded[0] = { queueRevision: 5, items: seeded[0].items, plans: planRows };
  host.states.length = 0;
  host.states.push(...seeded);
  host.states[7] = null;
  const tree = renderCandidates(dsh, "session-A");
  const nodes = flattenVNode(tree);
  const buttonLabels = nodes
    .filter((n) => n.type === "button")
    .map((n) => n.children.find((c) => typeof c === "string"))
    .filter((c) => typeof c === "string");
  for (const stale of ["analyze organize", "analyze forgetting", "reviewed", "dismissed", "preview organize", "preview forgetting"]) {
    assert.ok(!buttonLabels.includes(stale), `no English button label "${stale}"`);
  }
  // U5 改口径：「标记已阅」改名「稍后再说」（协议仍发 decision=reviewed，见下方断言）。
  // 0.3 收敛：整理入口按钮（分析整理候选 / 预览整理计划 / 合并进主题）随整理流程裁撤。
  for (const label of ["分析遗忘候选", "稍后再说", "忽略"]) {
    assert.ok(buttonLabels.includes(label), `Chinese button "${label}" present`);
  }
  for (const removed of ["分析整理候选", "预览整理计划", "合并进主题"]) {
    assert.ok(!buttonLabels.includes(removed), `removed organize button "${removed}" absent`);
  }
  const text = collectText(tree);
  assert.ok(text.includes("候选（2）"), "candidate card title localized");
  assert.ok(text.includes("待处理"), "status badges localized");
  const staleBadges = nodes.filter((n) => n.type === "span" && ["open", "executed", "superseded"].includes(String(collectText(n))));
  assert.equal(staleBadges.length, 0, "no English plan badges rendered");
  // 计划行 kind 徽章：forgetting → 遗忘（plan.kind 协议值本身不变；0.3 起 organize
  // 计划卡被过滤，夹具里的 plan-o 不再渲染，页面不出「整理」徽章）
  const planKindBadges = nodes
    .filter((n) => n.type === "span" && String(n.props.className || "").includes("dshi_badge"))
    .map((n) => collectText(n));
  assert.ok(planKindBadges.includes("遗忘"), "forgetting plan badge localized (遗忘)");
  assert.ok(!planKindBadges.includes("整理"), "organize plan card filtered out (整理 badge absent)");
  assert.ok(!planKindBadges.includes("organize") && !planKindBadges.includes("forgetting"), "no English plan kind badges");

  // 协议值不变：按钮中文、payload 仍发 reviewed / dismissed（U5 起按钮文案为「稍后再说」）
  findButton(tree, "稍后再说").props.onClick();
  await flush();
  const reviewed = calls.find((c) => c.method === "reviewCandidate");
  assert.ok(reviewed, "reviewCandidate issued");
  assert.equal(reviewed.payload.decision, "reviewed", "protocol decision stays reviewed");
  assert.equal(reviewed.payload.candidateId, "cluster-A", "candidate.id still sent");
  calls.length = 0;
  findButton(renderCandidates(dsh, "session-A"), "忽略").props.onClick();
  await flush();
  const dismissed = calls.find((c) => c.method === "reviewCandidate");
  assert.ok(dismissed, "dismiss issued");
  assert.equal(dismissed.payload.decision, "dismissed", "protocol decision stays dismissed");
});

test("第 7 轮：原始 JSON 默认折叠——候选行与计划行都用 details 且不带 open", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const planRows = [
    { planId: "plan-open", kind: "forgetting", planDigest: "d1", queueRevision: 0, changedItems: 1, summary: "s", createdAt: "2026-10-27T00:00:00.000Z", executed: false, superseded: false },
  ];
  const dsh = {
    call: async (method, session, payload) => {
      if (method === "listCandidates") return { queueRevision: 5, items: clusterLoadedStates("x")[0].items, plans: planRows };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(
    { queueRevision: 5, items: clusterLoadedStates("x")[0].items, plans: planRows },
    null, false, JSON.stringify({ kind: "link", links: [] }), null, null,
    { sessionId: "session-A", gen: 0 }, null);
  const tree = renderCandidates(dsh, "session-A");
  const details = flattenVNode(tree).filter((n) => n.type === "details");
  assert.equal(details.length, 3, "2 candidate rows + 1 plan row each wrap raw JSON in details");
  for (const node of details) {
    assert.equal(Object.prototype.hasOwnProperty.call(node.props, "open"), false, "details closed by default (no open attribute)");
    assert.equal(node.props.className, "dshi_details");
    const summary = node.children.find((c) => c && c.type === "summary");
    assert.ok(summary, "details has a summary");
    assert.equal(summary.children.join(""), "原始数据（JSON）");
    const pre = node.children.find((c) => c && c.type === "pre");
    assert.ok(pre, "raw JSON still available inside details");
    assert.equal(pre.props.className, "dshi_pre");
  }
  const text = collectText(tree);
  assert.ok(text.includes("计划（1）"), "plans title localized");
  assert.ok(text.includes("计划＝预览（previewPlan）"), "plans hint rendered");
  assert.ok(text.includes("候选是之前「整理分析」留下的待审条目"), "candidates hint rendered (0.3 只做遗忘口径)");
});

// ── 第 8 轮：面板第二轮反馈 ────────────────────────────────────────────────
// ① 图谱之后新增 L3 主题页；② revision token 截断；③ 卡片详情只改 spark 卡片、
// 连线可撤销；④ 主题列表默认只显示名字，展开才读正文。

// 与 mountCandidates 同一套路，但按 tab id 找组件：预置 ShioriSection 的
// tab / sessionId / modeStatus，渲染一次拿到目标 tab 的组件引用。
async function mountTabById(mod, host, tabId, tabName) {
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
  return (dsh, sessionId, options = {}) => {
    host.cursor.v = 0;
    host.runEffects.v = Boolean(options.effects);
    return tab.type({ dsh, sessionId });
  };
}

// ref 感知版挂载：与 mountTabById 同一路径，但组件调用前后设置 host.owner，
// 让 tab 的持久 ref 槽位（makeRefAwareReact）与 section 渲染的 ref 槽位分开。
async function mountTabByIdRefAware(mod, host, tabId, tabName) {
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
  host.owner = "section";
  let sectionTree;
  try { sectionTree = sectionVNode.type(sectionVNode.props); } finally { host.owner = null; }
  const tab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === tabName);
  assert.ok(tab, tabName + " reached through real slot render");
  return (dsh, sessionId, options = {}) => {
    host.cursor.v = 0;
    host.runEffects.v = Boolean(options.effects);
    host.owner = tabName;
    try { return tab.type({ dsh, sessionId }); } finally { host.owner = null; }
  };
}

// P1-1（重建轮询串会话）：轮询每轮比对渲染体同步的 sessionId 镜像 ref，卸载
// cleanup 置停——旧实现比对创建闭包里的 props，切换会话后恒等、永不停止。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("P1-1：重建轮询——发起后切换会话，旧会话的轮询停止（getStatus 不再增长）", async () => {
  const host = makeRefAwareReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderStatus = await mountTabByIdRefAware(mod, host, "status", "StatusTab");
  const statusCalls = [];
  const pendingStatus = []; // getStatus 挂起队列（手工控制响应时序）
  const semanticDto = (running) => ({
    mode: "active", configured: true,
    occupancy: { l0Chars: 1, l0Budget: 10, l1Chars: 1, l1HardCap: 10 },
    diagnostics: { semantic: { enabled: true, provider: "local", model: "m", ready: true, rebuild: { running, phase: running ? "running" : "idle" } } },
  });
  const dsh = {
    call: async (method, session, payload) => {
      if (method === "getStatus") {
        statusCalls.push(session);
        return new Promise((resolve) => pendingStatus.push(resolve));
      }
      // executeTool（semantic_rebuild）：立即成功
      return { ok: true };
    },
  };

  // 挂载：初始 getStatus 挂起 → 放行（idle），「重建向量」按钮可点
  host.states.length = 0;
  host.states.push(null, null, null);
  let tree = renderStatus(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;
  pendingStatus.shift()(semanticDto(false));
  await settle();
  tree = renderStatus(dsh, "session-A");
  assert.equal(statusCalls.length, 1, "one getStatus from mount load");
  findButton(tree, "重建向量").props.onClick();
  await settle();

  // 轮询第 1 轮的 getStatus 挂起中：此刻切换会话（重渲染即更新镜像 ref）
  assert.equal(statusCalls.length, 2, "poll round 1 issued");
  tree = renderStatus(dsh, "session-B");

  // 放行第 1 轮（仍 running → 循环继续），等待 1.5s 轮询间隔过后：
  // 旧闭包比对 ref 发现已切到 session-B → 直接退出，不再发第 2 轮
  pendingStatus.shift()(semanticDto(true));
  await sleep(1700);
  await settle();
  assert.equal(statusCalls.length, 2, "no further getStatus after session switch");
  assert.deepEqual(statusCalls, ["session-A", "session-A"], "both calls were for the original session");
});

test("R8：tab 栏八项冻结顺序（含 F2 闪回命中 / F4 最近变更）", async () => {
  const services = {
    "remote.session": { list: async () => ({ ok: true, value: { items: [{ sessionId: "session-A" }] } }) },
    "remote.shiori": { getStatus: async () => ({ ok: true, value: { mode: "active", configured: true } }) },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  const tree = await bootPanel(host, sectionVNode);
  const labels = flattenVNode(tree)
    .filter((n) => n.type === "button" && String((n.props && n.props.className) || "").includes("dshi_tab"))
    .map((n) => [].concat(n.children).join(""));
  // U6 改口径：tab 名按 GLOSSARY 第三章目标名落地（记忆内容 / 闪回图谱 / 专题 / 记忆预算），
  // tab id 与顺序不变。
  assert.deepEqual(labels, ["状态", "最近变更", "记忆内容", "闪回图谱", "遗忘", "专题", "闪回命中", "记忆预算"]);
  await cleanup();
});

test("R8：L0/L1 标题行的 revision 只显示前缀，完整 token 收进 title 属性", async () => {
  const longRev = "shiori-r1.eyJhbWJlciI6InBlcnNvbmEifQ.0123456789abcdef0123456789abcdef0123456789abcdef";
  const services = {
    "remote.session": { list: async () => ({ ok: true, value: { items: [{ sessionId: "session-A" }] } }) },
    "remote.shiori": {
      getStatus: async () => ({ ok: true, value: { mode: "active", configured: true } }),
      getMemoryView: async () => ({
        ok: true,
        value: {
          scope: "amber",
          l0: { text: "PERSONA", revision: longRev, chars: 7, budget: 12000, stale: false },
          l1: { text: "CORE BODY", body: "CORE BODY", revision: longRev, chars: 9, budget: 10000, hardCap: 14000 },
        },
      }),
    },
  };
  const { host, sectionVNode, cleanup } = await mountPanel(services);
  await bootPanel(host, sectionVNode);
  host.states[0] = "memory";
  host.cursor.v = 0;
  host.runEffects.v = false;
  const tree = sectionVNode.type(sectionVNode.props);
  const memoryTab = findComponent(tree, "MemoryTab");
  assert.ok(memoryTab);
  await runTab(host, memoryTab);

  host.cursor.v = PANEL_STATES;
  const painted = memoryTab.type(memoryTab.props);
  const text = collectText(painted);
  const badges = flattenVNode(painted).filter((n) => String((n.props && n.props.className) || "").includes("dshi_badge") && String(n.props.title || "").startsWith("完整版本号："));
  assert.equal(badges.length, 2, "两个 badge 都带完整版本号");
  for (const badge of badges) {
    assert.equal(badge.props.title, "完整版本号：" + longRev);
    const shown = collectText(badge);
    assert.equal(shown, "rev shiori-r1.ey…", "标题行只显示 12 字符前缀 + 省略号");
    assert.equal(shown.includes(longRev), false, "标题行不再铺完整 token");
  }
  // 完整值仍可从「完整 DTO」折叠区查到（排查用），所以这里只钉标题行本身。
  assert.ok(text.includes("完整 DTO"), "原始 DTO 仍可展开查看");
  await cleanup();
});

test("R8：L3 主题页默认不读正文，展开才 memory_read；保存带 expectedRevision（U6：legacy 概念已删除，按普通主题渲染）", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderTopics = await mountTabById(mod, host, "topics", "TopicsTab");
  const calls = [];
  const topicRevision = "shiori-r1.c3RkLWJ5LXRvcGlj.abcdef0123456789abcdef0123456789abcdef0123456789";
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (payload && payload.name === "memory_list_topics") {
        return {
          topics: [
            { key: "t-live", title: "活主题", summary: "一行摘要", updated: "2026-10-26T10:00:00.000Z", revision: topicRevision, chars: 12, bytes: 20 },
            { key: "t-legacy", title: "旧主题", summary: "", updated: "legacy-unknown", revision: topicRevision, chars: 5, bytes: 9 },
          ],
        };
      }
      if (payload && payload.name === "memory_read") {
        return { topic: payload.args.topic, exists: true, content: "# " + payload.args.topic + " 正文\n", revision: topicRevision, bytes: 18 };
      }
      if (payload && payload.name === "memory_rewrite") return { ok: true };
      return {};
    },
  };
  const countTool = (name) => calls.filter((c) => c.payload && c.payload.name === name).length;

  host.states.length = 0;
  let tree = renderTopics(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;
  tree = renderTopics(dsh, "session-A");

  const text = collectText(tree);
  assert.ok(text.includes("L3 主题记忆（topic）"), "page title");
  assert.ok(text.includes("t-live") && text.includes("t-legacy"), "两个主题都在列表里");
  // U6：legacy 概念删除——updated === "legacy-unknown" 的行也按普通主题渲染，无只读徽章。
  assert.ok(!text.includes("legacy 只读"), "no legacy read-only badge (legacy removed)");
  assert.equal(countTool("memory_read"), 0, "列表默认不读正文");
  assert.equal(countTool("memory_list_topics"), 1, "进页只拉一次列表");

  // 展开 t-live：这时才读正文
  findButton(tree, "展开").props.onClick();
  await settle();
  tree = renderTopics(dsh, "session-A");
  assert.ok(collectText(tree).includes("# t-live 正文"), "展开后读到正文");
  assert.equal(countTool("memory_read"), 1, "只有展开的那一个主题发 memory_read");
  assert.equal(calls.filter((c) => c.payload && c.payload.name === "memory_read")[0].payload.args.topic, "t-live");

  // 另一个主题展开：与普通主题完全一致（读正文、给编辑按钮）
  findButton(tree, "展开").props.onClick();
  await settle();
  tree = renderTopics(dsh, "session-A");
  assert.ok(collectText(tree).includes("# t-legacy 正文"), "t-legacy 展开读到正文");
  assert.ok(flattenVNode(tree).filter((n) => n.type === "button" && collectText(n) === "编辑").length === 1, "t-legacy 展开后有编辑按钮");

  // 回到活跃主题编辑保存：memory_rewrite 带 expectedRevision
  findButton(tree, "展开").props.onClick();
  await settle();
  tree = renderTopics(dsh, "session-A");
  findButton(tree, "编辑").props.onClick();
  await settle();
  tree = renderTopics(dsh, "session-A");
  const textarea = flattenVNode(tree).find((n) => n.type === "textarea");
  assert.ok(textarea, "编辑框打开");
  assert.ok(String(textarea.props.value).includes("# t-live 正文"), "编辑初值是当前正文");
  textarea.props.onChange({ target: { value: "# t-live 新正文\n" } });
  tree = renderTopics(dsh, "session-A");
  findButton(tree, "保存").props.onClick();
  await settle();
  const rewrite = calls.find((c) => c.payload && c.payload.name === "memory_rewrite");
  assert.ok(rewrite, "memory_rewrite issued");
  assert.deepEqual(rewrite.payload.args, { topic: "t-live", content: "# t-live 新正文\n", expectedRevision: topicRevision });
});

test("U6：L3 主题页搜索过滤（key/title/summary，忽略大小写）+ 排序（更新时间倒序默认 / 字数 / 标题）+ updated 日期 + 已归档徽章置灰", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderTopics = await mountTabById(mod, host, "topics", "TopicsTab");
  const rows = [
    { key: "alpha", title: "世界观设定", summary: "大陆与王国", updated: "2026-10-01T08:00:00.000Z", revision: "shiori-r1.a.b", chars: 30 },
    { key: "beta", title: "人物关系", summary: "ALICE 与 BOB 的约定", updated: "2026-11-05T12:00:00.000Z", revision: "shiori-r1.b.b", chars: 120 },
    { key: "gamma", title: "旧事", summary: "", updated: "", revision: "shiori-r1.c.b", chars: 200, archived: true },
    { key: "delta", title: "B计划", summary: "备用线", updated: "2026-09-09T00:00:00.000Z", revision: "shiori-r1.d.b", chars: 80 },
  ];
  const dsh = {
    call: async (method, session, payload) => {
      if (payload && payload.name === "memory_list_topics") return { topics: rows };
      if (payload && payload.name === "memory_read") {
        return { topic: payload.args.topic, exists: true, content: "正文", revision: "shiori-r1.x.y", bytes: 6 };
      }
      return {};
    },
  };
  const renderRow = (tree) => flattenVNode(tree)
    .filter((n) => String((n.props && n.props.className) || "") === "dshi_item");
  const rowKeys = (tree) => renderRow(tree).map((row) => {
    const title = flattenVNode(row).find((n) => String((n.props && n.props.className) || "").includes("dshi_cardTitle"));
    return collectText(title);
  });

  // 首次渲染跑 effects 让 load() 拉到列表（与 R8 用例同一路径），之后复用状态渲染。
  host.states.length = 0;
  let tree = renderTopics(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;
  tree = renderTopics(dsh, "session-A");

  // 列表默认排序：更新时间倒序（beta 11-05 → alpha 10-01 → delta 09-09 → gamma 缺失排最后）
  let text = collectText(tree);
  assert.deepEqual(rowKeys(tree), ["beta", "alpha", "delta", "gamma"], "default sort: updated desc, missing date last (缺失日期无论升降序都排最后)");
  assert.ok(text.includes("2026-11-05") && text.includes("2026-10-01") && text.includes("2026-09-09"), "updated shown as YYYY-MM-DD");
  assert.ok(!text.includes("2026-11-05T"), "no time-of-day leaked into updated column");

  // 缺失 updated 显示 —
  const dayCells = flattenVNode(tree).filter((n) => (n.props && n.props.title) === "更新时间");
  assert.ok(dayCells.some((n) => collectText(n) === "—"), "missing updated renders —");

  // 已归档行：徽章 + 名称/摘要调灰
  const archivedRows = renderRow(tree).filter((row) => collectText(row).includes("已归档"));
  assert.equal(archivedRows.length, 1, "archived row carries badge");
  const archivedTitle = flattenVNode(archivedRows[0]).find((n) => String((n.props && n.props.className) || "").includes("dshi_cardTitle"));
  assert.ok(archivedTitle.props.style && String(archivedTitle.props.style.color).includes("label-tertiary"), "archived name dimmed");

  // 搜索：key / title / summary 子串，忽略大小写；空串显示全部
  const searchInput = flattenVNode(tree).find((n) => n.type === "input" && String(n.props.placeholder || "").includes("搜索"));
  assert.ok(searchInput, "search input rendered");
  searchInput.props.onChange({ target: { value: "ALICE" } });
  tree = renderTopics(dsh, "session-A");
  assert.deepEqual(rowKeys(tree), ["beta"], "search matches summary case-insensitively");
  assert.ok(collectText(tree).includes("显示 1/4 个主题"), "count reflects filtering");
  searchInput.props.onChange({ target: { value: "世界" } });
  tree = renderTopics(dsh, "session-A");
  assert.deepEqual(rowKeys(tree), ["alpha"], "search matches title");
  searchInput.props.onChange({ target: { value: "gam" } });
  tree = renderTopics(dsh, "session-A");
  assert.deepEqual(rowKeys(tree), ["gamma"], "search matches key");
  searchInput.props.onChange({ target: { value: "" } });
  tree = renderTopics(dsh, "session-A");
  assert.ok(collectText(tree).includes("共 4 个主题"), "empty search shows all");

  // 排序下拉：字数倒序 / 标题序
  const sortSelect = flattenVNode(tree).find((n) => n.type === "select" && n.props.title === "排序方式");
  assert.ok(sortSelect, "sort select rendered");
  const setSort = (value) => {
    sortSelect.props.onChange({ target: { value } });
    return rowKeys(renderTopics(dsh, "session-A"));
  };
  assert.deepEqual(setSort("chars-desc"), ["gamma", "beta", "delta", "alpha"], "sort by chars desc");
  // 标题序走 localeCompare("zh-Hans-CN")：Node ≥13 全 ICU 下为稳定拼音序，拉丁字母排 CJK 之后。
  assert.deepEqual(setSort("title-asc"), ["gamma", "beta", "alpha", "delta"], "sort by title (pinyin collation)");
  assert.deepEqual(setSort("updated-asc"), ["delta", "alpha", "beta", "gamma"], "sort by updated asc, missing date last");
  assert.deepEqual(setSort("updated-desc"), ["beta", "alpha", "delta", "gamma"], "back to default sort");

  // 搜索无结果：提示但不把「空作用域」文案混进来
  const searchInput2 = flattenVNode(renderTopics(dsh, "session-A")).find((n) => n.type === "input" && String(n.props.placeholder || "").includes("搜索"));
  searchInput2.props.onChange({ target: { value: "不存在的词" } });
  tree = renderTopics(dsh, "session-A");
  text = collectText(tree);
  assert.ok(text.includes("没有匹配的主题"), "no-match hint shown");
  assert.ok(!text.includes("这个作用域下还没有主题"), "empty-scope hint not confused with no-match");
});

// P1-3（详情串卡）：readTopic 的响应晚到时按「发起时的专题是否还是当前专题」丢弃。

test("P1-3：点 A 立刻点 B，A 的详情响应晚到 → 不覆盖 B（串卡守卫）", async () => {
  const host = makeRefAwareReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderTopics = await mountTabByIdRefAware(mod, host, "topics", "TopicsTab");
  const calls = [];
  const pendingReads = new Map(); // topic -> resolve（手工控制响应时序）
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (payload && payload.name === "memory_list_topics") {
        return { topics: [
          { key: "t-a", title: "A", summary: "", updated: "2026-11-02T00:00:00.000Z", chars: 3 },
          { key: "t-b", title: "B", summary: "", updated: "2026-11-01T00:00:00.000Z", chars: 3 },
        ] };
      }
      if (payload && payload.name === "memory_read") {
        return new Promise((resolve) => { pendingReads.set(payload.args.topic, resolve); });
      }
      return {};
    },
  };
  const readCount = (topic) => calls.filter((c) => c.payload && c.payload.name === "memory_read" && c.payload.args.topic === topic).length;

  host.states.length = 0;
  let tree = renderTopics(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;
  tree = renderTopics(dsh, "session-A");
  assert.equal(readCount("t-a") + readCount("t-b"), 0, "list only, no reads yet");

  // 点 A（排序 updated-desc：t-a 11-02 在前，第一个「展开」即 t-a）→ 读请求挂起
  findButton(tree, "展开").props.onClick();
  assert.equal(readCount("t-a"), 1, "A read issued");
  tree = renderTopics(dsh, "session-A"); // 重渲染：opened = t-a

  // 立刻点 B（此时只剩 t-b 的「展开」）→ B 的读请求也挂起
  const expandB = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("展开"));
  assert.equal(expandB.length, 1, "only t-b still shows 展开");
  expandB[0].props.onClick();
  assert.equal(readCount("t-b"), 1, "B read issued");
  tree = renderTopics(dsh, "session-A"); // 重渲染：opened = t-b

  // A 的响应晚到：opened 已是 t-b → 整包丢弃，detail 不得被 A 覆盖
  pendingReads.get("t-a")({ topic: "t-a", exists: true, content: "# A 正文", revision: "r-a" });
  await settle();
  assert.equal(host.states[3], "t-b", "opened stays B");
  assert.equal(host.states[4], null, "stale A response discarded, detail not overwritten");

  // B 的响应正常落地
  pendingReads.get("t-b")({ topic: "t-b", exists: true, content: "# B 正文", revision: "r-b" });
  await settle();
  assert.equal(host.states[4] && host.states[4].content, "# B 正文", "B detail lands");
  assert.equal(readCount("t-a") + readCount("t-b"), 2, "exactly one read per topic");
});

test("P1-3：detail.topic 与 opened 不一致时点保存 → 不发 memory_rewrite，给中文提示", async () => {
  const host = makeRefAwareReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderTopics = await mountTabByIdRefAware(mod, host, "topics", "TopicsTab");
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (payload && payload.name === "memory_list_topics") {
        return { topics: [
          { key: "t-a", title: "A", summary: "", updated: "2026-11-02T00:00:00.000Z", chars: 3 },
          { key: "t-b", title: "B", summary: "", updated: "2026-11-01T00:00:00.000Z", chars: 3 },
        ] };
      }
      if (payload && payload.name === "memory_read") {
        return { topic: payload.args.topic, exists: true, content: "# A 正文", revision: "r-a" };
      }
      return {};
    },
  };

  // 挂载并展开 t-a，让 detail / 草稿进入「已打开可保存」状态
  host.states.length = 0;
  let tree = renderTopics(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;
  tree = renderTopics(dsh, "session-A");
  findButton(tree, "展开").props.onClick();
  await settle();
  tree = renderTopics(dsh, "session-A");
  findButton(tree, "编辑").props.onClick();
  tree = renderTopics(dsh, "session-A");
  const textarea = flattenVNode(tree).find((n) => n.type === "textarea");
  assert.ok(textarea, "edit box open");
  textarea.props.onChange({ target: { value: "# A 被改过的草稿" } });

  // 模拟响应期间用户切换了专题：opened 变为 t-b，但 detail 仍是 t-a 的快照
  host.states[3] = "t-b";
  tree = renderTopics(dsh, "session-A");
  findButton(tree, "保存").props.onClick();
  await settle();
  assert.equal(calls.filter((c) => c.payload && c.payload.name === "memory_rewrite").length, 0,
    "no memory_rewrite when detail.topic != opened");
  assert.equal(calls.filter((c) => c.payload && c.payload.name === "memory_read").length, 1,
    "no reload triggered by the refused save");
  tree = renderTopics(dsh, "session-A"); // 重渲染后提示可见
  assert.ok(String(collectText(tree)).includes("详情已切换，请重新打开该专题再保存"),
    "Chinese refusal message shown");
});

// P1-2（六 tab 过期守卫）：load 的响应回来时若会话已切换，整包丢弃。

test("P1-2：TopicsTab 旧会话响应晚到 → 不覆盖新会话数据（会话守卫）", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderTopics = await mountTabById(mod, host, "topics", "TopicsTab");
  const calls = [];
  const pendingLists = []; // memory_list_topics 挂起队列（手工控制响应时序）
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (payload && payload.name === "memory_list_topics") {
        return new Promise((resolve) => pendingLists.push(resolve));
      }
      return {};
    },
  };
  const listA = { topics: [{ key: "a-1", title: "A", summary: "", updated: "2026-11-02T00:00:00.000Z", chars: 1 }] };
  const listB = { topics: [{ key: "b-1", title: "B", summary: "", updated: "2026-11-03T00:00:00.000Z", chars: 2 }] };

  // 会话 A 发起 load（挂起），随即切到会话 B：渲染体同步换绑守卫并发起新 load
  host.states.length = 0;
  let tree = renderTopics(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  assert.equal(calls.length, 1, "session-A load issued");
  tree = renderTopics(dsh, "session-B", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  assert.equal(calls.length, 2, "session-B load issued");

  // A 的响应晚到 → 丢弃；B 的响应正常落地
  pendingLists[0](listA);
  await settle();
  assert.equal(host.states[0], null, "stale session-A response discarded");
  pendingLists[1](listB);
  await settle();
  assert.deepEqual(host.states[0], listB.topics, "session-B data lands");
  assert.equal(host.states[1], false, "busy closed by the fresh load");
});

test("P1-2：FlashbacksTab 旧会话响应晚到 → 不覆盖新会话数据（会话守卫）", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderFlashbacks = await mountTabById(mod, host, "flashbacks", "FlashbacksTab");
  const pendingStatus = []; // getStatus 挂起队列
  const pendingGraph = [];  // getGraph 挂起队列
  const dsh = {
    call: async (method, session, payload) => {
      if (method === "getStatus") return new Promise((resolve) => pendingStatus.push(resolve));
      if (method === "getGraph") return new Promise((resolve) => pendingGraph.push(resolve));
      return {};
    },
  };
  const capsB = { l2: true };
  const graphB = { nodes: [{ id: "b-1", hitCount: 3, lastHitAt: "2026-11-03T00:00:00.000Z" }], edges: [], deliveryStats: { totalDelivered: 3, uniqueCards: 2, rounds: 2 } };

  // 会话 A 发起 load（getStatus 挂起），随即切到会话 B 并发起新 load
  host.states.length = 0;
  let tree = renderFlashbacks(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  tree = renderFlashbacks(dsh, "session-B", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  assert.equal(pendingStatus.length, 2, "two getStatus in flight (A then B)");

  // A 的 getStatus 晚到 → 丢弃（A 的 load 就地返回，A 的 getGraph 永不发出）
  pendingStatus[0]({ capabilities: { l2: false } });
  await settle();
  assert.equal(pendingGraph.length, 0, "stale session-A load never reaches getGraph");
  assert.equal(host.states[1], null, "stale caps discarded");

  // B 的响应正常落地
  pendingStatus[1]({ capabilities: capsB });
  await settle();
  assert.equal(pendingGraph.length, 1, "only session-B's getGraph issued");
  assert.deepEqual(host.states[1], capsB, "session-B caps land");
  pendingGraph[0](graphB);
  await settle();
  assert.deepEqual(host.states[0], graphB, "session-B graph lands");
});

test("R8：卡片详情只编辑 spark 卡片本身——保存只提交改动字段，连线可撤销", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderGraph = await mountTabById(mod, host, "graph", "GraphTab");
  const calls = [];
  const card = {
    id: "spk-1", revision: 3, title: "旧标题", summary: "", content: "旧正文",
    triggers: ["甲"], entities: [], links: [{ target: "spk-2", rel: "related" }],
    vitality: "ephemeral", state: "active",
  };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "getGraph") {
        return {
          nodes: [
            { id: "spk-1", title: "旧标题", vitality: "ephemeral", state: "active", revision: 3 },
            { id: "spk-2", title: "另一张卡", vitality: "evergreen", state: "active", revision: 1 },
          ],
          edges: [],
        };
      }
      if (payload && payload.name === "spark_read") return Object.assign({}, card);
      if (payload && payload.name === "spark_update") return { ok: true };
      return {};
    },
  };

  host.states.length = 0;
  let tree = renderGraph(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;

  host.states[2] = { id: "spk-1", title: "旧标题", vitality: "ephemeral", state: "active", revision: 3, raw: { id: "spk-1" } };
  tree = renderGraph(dsh, "session-A");
  const detail = findComponent(tree, "NodeDetail");
  assert.ok(detail, "NodeDetail mounted for the selected node");

  // NodeDetail 的 useState 紧接 GraphTab 的 7 个之后
  // （graph / error / selected / view / hoverId / search / searchMiss——图谱页改版追加后 3 个）
  host.cursor.v = 7;
  host.runEffects.v = true;
  detail.type(detail.props);
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;
  const renderDetail = () => { host.cursor.v = 7; return detail.type(detail.props); };

  let painted = renderDetail();
  let text = collectText(painted);
  assert.ok(text.includes("卡片内容"), "卡片内容表单渲染出来");
  assert.ok(!text.includes("重写人设卡"), "卡片详情里不再有人设卡改写入口");
  assert.ok(!text.includes("重写记忆核心"), "卡片详情里不再有记忆核心改写入口");
  assert.ok(!text.includes("往某个主题里追加内容"), "topic_append 已挪到独立页");
  assert.ok(text.includes("另一张卡"), "已有连线显示目标卡标题");

  // 只改标题：patch 里只有 title，不夹带其它字段
  const titleInput = flattenVNode(painted).find((n) => n.type === "input" && n.props.value === "旧标题");
  assert.ok(titleInput, "标题输入框带当前值");
  titleInput.props.onChange({ target: { value: "新标题" } });
  painted = renderDetail();
  findButton(painted, "保存卡片").props.onClick();
  await settle();
  const update = calls.find((c) => c.payload && c.payload.name === "spark_update");
  assert.ok(update, "spark_update issued");
  assert.deepEqual(update.payload.args, { id: "spk-1", patch: { title: "新标题" }, expectedRevision: 3 });

  // 移除连线 → 标记未保存 → 「撤销修改」还原且不写服务端
  calls.length = 0;
  painted = renderDetail();
  assert.ok(collectText(painted).includes("与服务端一致"), "刚读完时连线与服务端一致");
  findButton(painted, "移除").props.onClick();
  painted = renderDetail();
  assert.ok(collectText(painted).includes("有未保存的改动"), "删掉连线后标记未保存");
  assert.ok(collectText(painted).includes("这张卡还没有连线。"), "连线行在本地消失");
  findButton(painted, "撤销修改").props.onClick();
  painted = renderDetail();
  assert.ok(collectText(painted).includes("与服务端一致"), "撤销后回到一致状态");
  assert.equal(collectText(painted).includes("这张卡还没有连线。"), false, "连线恢复");
  assert.equal(flattenVNode(painted).filter((n) => n.type === "button" && collectText(n) === "移除").length, 1, "连线行回到列表里");
  assert.equal(calls.length, 0, "撤销只在本地还原，不发请求");
});


// ---------------------------------------------------------------------------
// R8 续（图谱页改版）：手写 FR 力导向布局稳定且坐标有限 / 半径按 degree /
// hover 邻居高亮 / 搜索定位居中 / 实体聚类着色稳定 / 图例文案更新。
// GraphTab useState 顺序：graph / error / selected / view / hoverId / search /
// searchMiss（共 7 个）。
// ---------------------------------------------------------------------------

const GRAPH_TAB_NODES = [
  { id: "spk-1", title: "苹果卡", vitality: "evergreen", state: "active", revision: 1, degree: 3, entities: ["项目甲"] },
  { id: "spk-2", title: "香蕉卡", vitality: "ephemeral", state: "active", revision: 1, degree: 0, entities: ["项目甲"] },
  { id: "spk-3", title: "樱桃卡", vitality: "ephemeral", state: "active", revision: 1, degree: 1, entities: ["项目乙"] },
  { id: "spk-4", title: "无实体卡", vitality: "ephemeral", state: "active", revision: 1 },
];
const GRAPH_TAB_PAYLOAD = { nodes: GRAPH_TAB_NODES, edges: [{ from: "spk-1", to: "spk-2" }] };

// 挂 GraphTab 并跑完 load() effect，返回 rerender（重渲染读最新 state）。
async function mountGraphTab(payload = GRAPH_TAB_PAYLOAD) {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderGraph = await mountTabById(mod, host, "graph", "GraphTab");
  const dsh = {
    call: async (method) => (method === "getGraph" ? payload : {}),
  };
  host.states.length = 0;
  renderGraph(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;
  return {
    host,
    rerender: () => renderGraph(dsh, "session-A"),
  };
}

function graphNodeGs(tree) {
  return flattenVNode(tree).filter((n) => n.type === "g" && String(n.props.key || "").startsWith("spk-"));
}

function graphCircles(tree) {
  return flattenVNode(tree).filter((n) => n.type === "circle");
}

test("R8：图谱力导向布局——同一数据两次渲染一致、坐标有限且夹在画布内、孤立节点互不重叠", async () => {
  const { rerender } = await mountGraphTab();
  const first = graphCircles(rerender()).map((c) => [c.props.cx, c.props.cy]);
  assert.equal(first.length, 4, "4 个节点都有位置");
  for (const [x, y] of first) {
    assert.ok(Number.isFinite(x) && Number.isFinite(y), "坐标不含 NaN/Infinity");
    assert.ok(x >= 30 && x <= 770 && y >= 30 && y <= 350, `坐标夹在 [30,770]×[30,350] 内（got ${x},${y}）`);
  }
  // 同一份数据再开一个独立实例渲染，布局逐点一致（无 Math.random、顺序稳定）
  const { rerender: rerender2 } = await mountGraphTab();
  const second = graphCircles(rerender2()).map((c) => [c.props.cx, c.props.cy]);
  assert.deepEqual(second, first, "同一份数据两次渲染布局完全一致");
  // 孤立节点（spk-3 / spk-4 无边）互不重叠、也不与其它点重合
  for (let i = 0; i < first.length; i++) {
    for (let j = i + 1; j < first.length; j++) {
      const dist = Math.hypot(first[i][0] - first[j][0], first[i][1] - first[j][1]);
      assert.ok(dist > 1, `节点 ${i} 与 ${j} 位置不重合（dist=${dist}）`);
    }
  }
});

test("R8：图谱节点半径按 degree 变化——r = 10 + min(8, 2*degree)，缺失/非数字按 0", async () => {
  const { rerender } = await mountGraphTab();
  let tree = rerender();
  const radii = graphCircles(tree).map((c) => c.props.r).sort((a, b) => a - b);
  // spk-1 degree 3 → 16；spk-3 degree 1 → 12；spk-2 degree 0 → 10；spk-4 缺失 → 10
  assert.deepEqual(radii, [10, 10, 12, 16], "半径映射 r = 10 + min(8, 2*degree)");
  // 标签 x 偏移 = cx + r + 4（不再写死 +18——最大半径 18 时标签会压在圆边上）
  for (const g of graphNodeGs(tree)) {
    const circle = flattenVNode(g).find((n) => n.type === "circle");
    const label = flattenVNode(g).find((n) => n.type === "text");
    assert.equal(label.props.x, circle.props.cx + circle.props.r + 4, `标签偏移随半径（${g.props.key}）`);
  }
  // degree 非数字按 0
  const { rerender: rerender2 } = await mountGraphTab({
    nodes: [{ id: "spk-9", title: "坏 degree 卡", vitality: "ephemeral", state: "active", revision: 1, degree: "很多" }],
    edges: [],
  });
  const badRadii = graphCircles(rerender2()).map((c) => c.props.r);
  assert.deepEqual(badRadii, [10], "degree 非数字按 0 处理");
});

// 密集图（review-rework a1）：链状图节点多、成分长，最容易出现全贴边 + 完全重合。
function chainGraphPayload(count) {
  const nodes = [];
  for (let i = 0; i < count; i++) {
    nodes.push({ id: "spk-" + i, title: "链卡" + i, vitality: "ephemeral", state: "active", revision: 1, degree: i === 0 || i === count - 1 ? 1 : 2 });
  }
  const edges = [];
  for (let i = 0; i < count - 1; i++) edges.push({ from: "spk-" + i, to: "spk-" + (i + 1) });
  return { nodes, edges };
}

// 密集图通用断言：坐标有限、夹在 [30,770]×[30,350]、两两距离 > 6、
// 角落边界（x 与 y 同时贴边）的节点不许超过一半。
function assertDenseLayoutHealthy(tree, count) {
  const circles = graphCircles(tree);
  assert.equal(circles.length, count, `${count} 个节点全部渲染`);
  const pts = circles.map((c) => ({ x: c.props.cx, y: c.props.cy }));
  let cornerBoundary = 0;
  for (const p of pts) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y), "坐标不含 NaN/Infinity");
    assert.ok(p.x >= 30 && p.x <= 770 && p.y >= 30 && p.y <= 350, `坐标夹在 [30,770]×[30,350] 内（got ${p.x},${p.y}）`);
    if ((p.x === 30 || p.x === 770) && (p.y === 30 || p.y === 350)) cornerBoundary++;
  }
  assert.ok(cornerBoundary <= Math.floor(count / 2), `不许全贴边（角落边界 ${cornerBoundary}/${count}）`);
  let minDist = Infinity;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (d < minDist) minDist = d;
      assert.ok(d > 6, `节点 ${i}/${j} 距离 ${d.toFixed(2)} 必须大于 6（不许重合/叠标签）`);
    }
  }
  return minDist;
}

test("R8：密集图布局——60 节点链不贴边、不重合、两两距离 > 6", async () => {
  const { rerender } = await mountGraphTab(chainGraphPayload(60));
  const minDist = assertDenseLayoutHealthy(rerender(), 60);
  assert.ok(minDist > 6, `最小两两距离 ${minDist.toFixed(2)} > 6`);
});

test("R8：密集图布局——200 节点链同款断言（中心回归 + 归一化 + 分离收尾三层都到位）", async () => {
  const { rerender } = await mountGraphTab(chainGraphPayload(200));
  const minDist = assertDenseLayoutHealthy(rerender(), 200);
  assert.ok(minDist > 6, `最小两两距离 ${minDist.toFixed(2)} > 6`);
});

test("R8：图谱 hover 邻居高亮——非邻居节点与无关边淡出（内联 opacity 0.25），离开复原，不影响选中", async () => {
  const { rerender } = await mountGraphTab();
  let tree = rerender();
  // hover spk-1：直接邻居 spk-2；spk-3 / spk-4 淡出；spk1–spk2 的边保持原样
  graphNodeGs(tree).find((n) => n.props.key === "spk-1").props.onPointerEnter();
  tree = rerender();
  const dimmedKeys = graphNodeGs(tree).filter((n) => n.props.style && n.props.style.opacity === 0.25).map((n) => n.props.key);
  assert.deepEqual(dimmedKeys.sort(), ["spk-3", "spk-4"], "非邻居节点淡出（opacity 0.25）");
  const keepKeys = graphNodeGs(tree).filter((n) => n.props.style && n.props.style.opacity === 1).map((n) => n.props.key);
  assert.deepEqual(keepKeys.sort(), ["spk-1", "spk-2"], "悬停节点与直接邻居保持原样");
  const lines = flattenVNode(tree).filter((n) => n.type === "line");
  assert.equal(lines.length, 1, "一条边渲染");
  assert.equal(lines[0].props.style.opacity, 1, "悬停节点与邻居之间的边保持原样");
  assert.equal(lines[0].props.style.transition, "opacity .15s", "淡出走 opacity 过渡");
  // 离开复原
  graphNodeGs(tree).find((n) => n.props.key === "spk-1").props.onPointerLeave();
  tree = rerender();
  const allGs = graphNodeGs(tree);
  assert.ok(allGs.every((n) => n.props.style && n.props.style.opacity === 1), "离开后节点全部复原");
  assert.ok(flattenVNode(tree).filter((n) => n.type === "line").every((n) => n.props.style.opacity === 1), "离开后边全部复原");
  // hover 不影响点击选中：onPointerUp 仍走 setSelected
  graphNodeGs(tree).find((n) => n.props.key === "spk-2").props.onPointerUp();
  tree = rerender();
  assert.ok(findComponent(tree, "NodeDetail"), "hover 后点击仍能选中节点开详情");
});

test("R8：图谱搜索定位——回车选中第一个匹配并居中（缩放保持），无匹配只提示不清图", async () => {
  const { host, rerender } = await mountGraphTab();
  let tree = rerender();
  const searchInput = () => flattenVNode(tree).find((n) => n.type === "input"
    && String(n.props.placeholder || "") === "搜索：按标题或 id 定位");
  assert.ok(searchInput(), "搜索输入框渲染，placeholder 按需求文案");

  // 无匹配：提示一句，图不清空、不选中
  searchInput().props.onChange({ target: { value: "不存在的词" } });
  tree = rerender();
  searchInput().props.onKeyDown({ key: "Enter" });
  tree = rerender();
  assert.ok(collectText(tree).includes("没有匹配的卡片"), "无匹配给提示");
  assert.equal(findComponent(tree, "NodeDetail"), undefined, "无匹配不选中");
  assert.equal(graphCircles(tree).length, 4, "无匹配不清空图");

  // 匹配标题：回车选中第一个匹配，view 让节点落在 800×380 中心，缩放保持
  searchInput().props.onChange({ target: { value: "樱桃" } });
  tree = rerender();
  searchInput().props.onKeyDown({ key: "Enter" });
  tree = rerender();
  assert.ok(findComponent(tree, "NodeDetail"), "回车选中第一个匹配并开详情");
  const view = host.states[3];
  const target = graphNodeGs(tree).find((n) => n.props.key === "spk-3");
  const circle = flattenVNode(target).find((n) => n.type === "circle");
  assert.equal(view.k, 1, "缩放保持");
  assert.ok(Math.abs(view.x - (400 - circle.props.cx * view.k)) < 1e-9
    && Math.abs(view.y - (190 - circle.props.cy * view.k)) < 1e-9, "目标节点换算到 800×380 中心");

  // id 匹配忽略大小写
  searchInput().props.onChange({ target: { value: "SPK-4" } });
  tree = rerender();
  searchInput().props.onKeyDown({ key: "Enter" });
  tree = rerender();
  assert.ok(findComponent(tree, "NodeDetail"), "id 大小写不敏感匹配");

  // 「清除」清空输入与提示
  findButton(tree, "清除").props.onClick();
  tree = rerender();
  assert.equal(host.states[5], "", "清除清空输入框");
  assert.ok(!collectText(tree).includes("没有匹配的卡片"), "清除后提示消失");
});

test("R8：图谱实体聚类着色——同实体同色、不同实体不同色、无实体中性色；图例讲清填充/描边语义", async () => {
  const { rerender } = await mountGraphTab();
  const tree = rerender();
  const circleByKey = {};
  for (const g of graphNodeGs(tree)) {
    circleByKey[g.props.key] = flattenVNode(g).find((n) => n.type === "circle");
  }
  // 聚类填充走 circle 内联 style.fill：同实体同色、不同实体不同色、无实体中性色
  const fillOf = (id) => circleByKey[id].props.style.fill;
  assert.equal(fillOf("spk-1"), fillOf("spk-2"), "同一实体（项目甲）永远同色");
  assert.notEqual(fillOf("spk-1"), fillOf("spk-3"), "不同实体不同色（项目甲 vs 项目乙）");
  assert.ok(fillOf("spk-4").includes("--dsw-alias-label-secondary"), "没有 entities 的节点用中性色");
  // 存续类型改用描边：evergreen 绿描边、ephemeral 蓝描边；既有三态类名继续挂在节点上
  assert.equal(circleByKey["spk-1"].props.style.stroke, "var(--dsw-alias-state-success-primary,#1a7f37)", "evergreen 绿描边");
  assert.equal(circleByKey["spk-2"].props.style.stroke, "var(--dsw-alias-state-business-primary,#3964fe)", "ephemeral 蓝描边");
  assert.ok(String(circleByKey["spk-1"].props.className).includes("dshi_nodeEvergreen"), "dshi_nodeEvergreen 类保持挂载");
  assert.ok(String(circleByKey["spk-2"].props.className).includes("dshi_nodeEphemeral"), "dshi_nodeEphemeral 类保持挂载");
  // 图例：三个既有条目保持 + 新语义文案
  const text = collectText(tree);
  assert.ok(text.includes("填充=实体聚类，描边=存续类型"), "图例讲清填充=实体聚类、描边=存续类型");
  assert.ok(text.includes("evergreen") && text.includes("ephemeral") && text.includes("非 active"), "三个既有图例条目保持不变");
});


// ---------------------------------------------------------------------------
// 0.2.3 实测反馈：图谱标签去重叠 + 手动连线空关系名按 related 落库。
// ---------------------------------------------------------------------------

// 拥挤夹具：N 个节点链成一串，标题统一较长（估宽 > 120px，必触发截断），
// forceLayout 归一化后整体挤在 800×380 中央；度数 0..4 交错（半径 10~18）。
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

// 与 client/index.js 的估算口径一致：ASCII 6px、非 ASCII 10px、余量 4px、高 12px、
// 上限 120px、标签间距 2px、节点圆方框外扩 2px。
const LBL = { wide: 10, narrow: 6, margin: 4, height: 12, maxWidth: 120, gap: 2, nodePad: 2 };
function labelWidthOf(text) {
  let w = LBL.margin;
  for (let i = 0; i < text.length; i++) w += text.charCodeAt(i) < 0x80 ? LBL.narrow : LBL.wide;
  return w;
}
function truncateLabelTextOf(title) {
  if (labelWidthOf(title) <= LBL.maxWidth) return title;
  let kept = "";
  for (let i = 0; i < title.length; i++) {
    if (labelWidthOf(title.slice(0, i + 1) + "…") > LBL.maxWidth) break;
    kept = title.slice(0, i + 1);
  }
  return kept + "…";
}
function rectsCollide(a, b, gap) {
  return !(a.x >= b.x + b.w + gap || b.x >= a.x + a.w + gap
    || a.y >= b.y + b.h + gap || b.y >= a.y + a.h + gap);
}
function graphLabels(tree) {
  return flattenVNode(tree).filter((n) => n.type === "text" && String(n.props.className) === "dshi_nodeLabel");
}
// 从渲染树读 text 坐标 / text-anchor / 可见文本 / <title>，复算标签矩形。
function labelRectOfEl(textEl) {
  const kids = [].concat(textEl.children);
  const titleChild = kids.find((c) => c && c.type === "title");
  const visible = kids.filter((c) => typeof c === "string").join("");
  const w = labelWidthOf(visible);
  const anchor = textEl.props.textAnchor || "start";
  const x = anchor === "end" ? textEl.props.x - w
    : anchor === "middle" ? textEl.props.x - w / 2 : textEl.props.x;
  return { titleChild, visible, anchor, rect: { x, y: textEl.props.y - LBL.height / 2, w, h: LBL.height } };
}

test("025a：图谱标签去重叠——40 节点挤中央：可见标签两两不相交、不压节点圆、超宽截断补省略号、完整标题进 <title>", async () => {
  const payload = crowdedGraphPayload(40);
  const titleSet = new Set(payload.nodes.map((n) => n.title));
  const { rerender } = await mountGraphTab(payload);
  const tree = rerender();
  const labels = graphLabels(tree).map(labelRectOfEl);
  assert.ok(labels.length > 0, "至少渲染了一个标签");
  const circles = graphCircles(tree);
  assert.equal(circles.length, 40, "40 个节点全部渲染");
  const nodeBoxes = circles.map((c) => {
    const pad = c.props.r + LBL.nodePad;
    return { x: c.props.cx - pad, y: c.props.cy - pad, w: pad * 2, h: pad * 2 };
  });
  // ① 任意两个可见标签矩形不相交（标签之间留 2px 间距）
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      assert.ok(!rectsCollide(labels[i].rect, labels[j].rect, LBL.gap),
        `可见标签 ${i} 与 ${j} 不相交`);
    }
  }
  // ② 标签矩形不与任何节点圆（方框近似）相交
  for (const label of labels) {
    for (const box of nodeBoxes) {
      assert.ok(!rectsCollide(label.rect, box, 0), "标签矩形不与节点圆相交");
    }
  }
  // ③ 完整标题进 <title>；可见文本估宽 ≤ 120px；超宽标题截断补「…」
  for (const label of labels) {
    assert.ok(label.titleChild, "标签带 <title> 子元素");
    const fullTitle = [].concat(label.titleChild.children).join("");
    assert.ok(titleSet.has(fullTitle), "<title> 里是完整标题");
    assert.ok(labelWidthOf(label.visible) <= LBL.maxWidth, "可见文本估宽 ≤ 120px");
    if (labelWidthOf(fullTitle) > LBL.maxWidth) {
      assert.ok(label.visible.endsWith("…"), "超宽标题补省略号");
      assert.notEqual(label.visible, fullTitle, "确实发生了截断");
    }
  }
});

test("025a：图谱标签去重叠——被隐藏的节点四锚皆撞（逐锚复算碰撞），且排布确定性可复现", async () => {
  const payload = crowdedGraphPayload(40);
  const idToTitle = {};
  for (const node of payload.nodes) idToTitle[node.id] = node.title;
  const { rerender } = await mountGraphTab(payload);
  const tree = rerender();
  const labels = graphLabels(tree).map(labelRectOfEl);
  const placedRects = labels.map((l) => l.rect);
  const circles = graphCircles(tree);
  const nodeBoxes = circles.map((c) => {
    const pad = c.props.r + LBL.nodePad;
    return { x: c.props.cx - pad, y: c.props.cy - pad, w: pad * 2, h: pad * 2 };
  });
  // 隐藏节点 = 渲染树里找不到对应 <title> 的节点
  const visibleTitles = new Set(labels.map((l) => [].concat(l.titleChild.children).join("")));
  const hiddenIds = Object.keys(idToTitle).filter((id) => !visibleTitles.has(idToTitle[id]));
  assert.ok(hiddenIds.length > 0, `拥挤夹具下有标签被隐藏（实际隐藏 ${hiddenIds.length} 个）`);
  // 每个隐藏节点：四个锚点逐一复算，都必须撞上某个已放置标签矩形或节点圆方框
  for (const id of hiddenIds) {
    const g = graphNodeGs(tree).find((n) => n.props.key === id);
    const circle = flattenVNode(g).find((n) => n.type === "circle");
    const cx = circle.props.cx;
    const cy = circle.props.cy;
    const r = circle.props.r;
    const width = labelWidthOf(truncateLabelTextOf(idToTitle[id]));
    const anchors = [
      { x: cx + r + 4, y: cy + 4, anchor: "start" },
      { x: cx - r - 4, y: cy + 4, anchor: "end" },
      { x: cx, y: cy + r + 14, anchor: "middle" },
      { x: cx, y: cy - r - 8, anchor: "middle" },
    ];
    // 0.3 起画布边界纳入锚点判定（与 client/index.js labelLayoutOf 同口径复算）：
    // 每个锚点先试原位（矩形须完整落在 800×380 viewBox 内且不撞），再试平移钳回
    // 画布后的位置（不撞即用）；两条路都失败才隐藏。被隐藏的节点因此逐锚复算
    // 「原位不可用（出画布或被撞）且钳回后仍被撞」。
    const inCanvas = (rc) => rc.x >= 0 && rc.y >= 0 && rc.x + rc.w <= 800 && rc.y + rc.h <= 380;
    const clampToCanvas = (rc) => ({
      x: Math.min(Math.max(rc.x, 0), 800 - rc.w),
      y: Math.min(Math.max(rc.y, 0), 380 - rc.h),
      w: rc.w, h: rc.h,
    });
    const collides = (rc) => placedRects.some((other) => rectsCollide(rc, other, LBL.gap))
      || nodeBoxes.some((box) => rectsCollide(rc, box, 0));
    for (const anchor of anchors) {
      const x = anchor.anchor === "end" ? anchor.x - width
        : anchor.anchor === "middle" ? anchor.x - width / 2 : anchor.x;
      const rect = { x, y: anchor.y - LBL.height / 2, w: width, h: LBL.height };
      const rawBlocked = !inCanvas(rect) || collides(rect);
      const clamped = clampToCanvas(rect);
      const clampedBlocked = collides(clamped);
      assert.ok(rawBlocked && clampedBlocked,
        `隐藏节点 ${id} 的锚点 ${anchor.anchor}@(${anchor.x},${anchor.y}) 原位（含出画布判定）与钳回画布后确实都被撞`);
    }
  }
  // 确定性：同一份数据再开一个独立实例，可见标签（坐标/锚点/文本）完全一致
  const { rerender: rerender2 } = await mountGraphTab(payload);
  const again = graphLabels(rerender2()).map(labelRectOfEl)
    .map((l) => ({ x: l.rect.x, y: l.rect.y, w: l.rect.w, anchor: l.anchor, visible: l.visible }));
  const first = labels.map((l) => ({ x: l.rect.x, y: l.rect.y, w: l.rect.w, anchor: l.anchor, visible: l.visible }));
  assert.deepEqual(again, first, "同一份数据两次渲染标签排布完全一致（无随机）");
});

test("025a：图谱标签去重叠——hover / 选中节点的标签强制存在、固定右侧锚点、画在所有标签之后", async () => {
  const payload = crowdedGraphPayload(40);
  const idToTitle = {};
  for (const node of payload.nodes) idToTitle[node.id] = node.title;
  const { host, rerender } = await mountGraphTab(payload);
  // hover spk-0 + 选中 spk-1：两个标签都必须渲染（GraphTab state 下标：graph/error/selected/view/hoverId/search/searchMiss）
  host.states[4] = "spk-0";
  host.states[2] = { id: "spk-1", title: idToTitle["spk-1"], vitality: "ephemeral", state: "active", revision: 1 };
  const tree = rerender();
  const allLabels = graphLabels(tree);
  const forcedTitles = new Set([idToTitle["spk-0"], idToTitle["spk-1"]]);
  const forcedIndexes = [];
  for (const id of ["spk-0", "spk-1"]) {
    const forced = allLabels.find((el) => {
      const parsed = labelRectOfEl(el);
      return [].concat(parsed.titleChild.children).join("") === idToTitle[id];
    });
    assert.ok(forced, `强制标签（${id}）一定存在`);
    const circle = flattenVNode(graphNodeGs(tree).find((n) => n.props.key === id)).find((n) => n.type === "circle");
    assert.equal(forced.props.textAnchor, "start", "强制标签固定右侧（start 对齐）");
    assert.equal(forced.props.x, circle.props.cx + circle.props.r + 4, "强制标签锚点 = x+r+4");
    assert.equal(forced.props.y, circle.props.cy + 4, "强制标签锚点 y = y+4");
    forcedIndexes.push(allLabels.indexOf(forced));
  }
  // 画在所有标签之后：所有普通（非 hover/选中）标签在扁平渲染树里都排在强制标签之前
  for (let i = 0; i < allLabels.length; i++) {
    const parsed = labelRectOfEl(allLabels[i]);
    const title = [].concat(parsed.titleChild.children).join("");
    if (forcedTitles.has(title)) continue;
    for (const fi of forcedIndexes) {
      assert.ok(i < fi, "普通标签都排在强制标签之前（强制标签画在最上层）");
    }
  }
  // pointer-events:none 由 .dshi_nodeLabel 类保持（内嵌 CSS 未动，类名未换）
  assert.ok(allLabels.every((el) => String(el.props.className) === "dshi_nodeLabel"), "标签类名保持 dshi_nodeLabel");
});

test("025a：手动连线空关系名——留空按 related 落库、历史 null/空串读取即归一、超 64 字不发请求", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderGraph = await mountTabById(mod, host, "graph", "GraphTab");
  const calls = [];
  const card = {
    id: "spk-1", revision: 7, title: "主卡", summary: "", content: "正文",
    triggers: [], entities: [],
    // 历史脏数据：rel null 与空串各一条
    links: [{ target: "spk-2", rel: null }, { target: "spk-3", rel: "" }],
    vitality: "ephemeral", state: "active",
  };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "getGraph") {
        return {
          nodes: [
            { id: "spk-1", title: "主卡", vitality: "ephemeral", state: "active", revision: 7 },
            { id: "spk-2", title: "邻居甲", vitality: "evergreen", state: "active", revision: 1 },
            { id: "spk-3", title: "邻居乙", vitality: "ephemeral", state: "active", revision: 1 },
            { id: "spk-4", title: "邻居丙", vitality: "ephemeral", state: "active", revision: 1 },
          ],
          edges: [],
        };
      }
      if (payload && payload.name === "spark_read") return Object.assign({}, card);
      if (payload && payload.name === "spark_update") return { ok: true };
      return {};
    },
  };

  host.states.length = 0;
  let tree = renderGraph(dsh, "session-A", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;

  host.states[2] = { id: "spk-1", title: "主卡", vitality: "ephemeral", state: "active", revision: 7, raw: { id: "spk-1" } };
  tree = renderGraph(dsh, "session-A");
  const detail = findComponent(tree, "NodeDetail");
  assert.ok(detail, "NodeDetail mounted for the selected node");

  // NodeDetail 的 useState 紧接 GraphTab 的 7 个之后（与 R8 用例同一下标口径）
  host.cursor.v = 7;
  host.runEffects.v = true;
  detail.type(detail.props);
  for (const effect of host.effects.splice(0)) effect();
  await settle();
  host.runEffects.v = false;
  const renderDetail = () => { host.cursor.v = 7; return detail.type(detail.props); };

  // ① 历史 null / 空串连线读取后归一显示 related，两条一条不丢
  let painted = renderDetail();
  const relBadges = flattenVNode(painted).filter((n) => n.type === "span"
    && n.props.className === "dshi_badgeDim dshi_badge" && collectText(n) === "related");
  assert.equal(relBadges.length, 2, "两条历史脏连线都归一显示 related");
  assert.equal(flattenVNode(painted).filter((n) => n.type === "button" && collectText(n) === "移除").length, 2,
    "两条连线一条不丢");
  const relInput = () => flattenVNode(painted).find((n) => n.type === "input"
    && String(n.props.placeholder || "") === "关系名（留空自动记为 related）");
  assert.ok(relInput(), "提示文案改为「关系名（留空自动记为 related）」");

  // ② 留空点「添加连线」→ 本地该条 rel 为 related；保存 → patch.links 无 null/空串
  // （NodeDetail 的 useState 下标：form/busy/formError/formOk/card/linkTarget/linkRel/…，cursor 7 起 → linkTarget=12、linkRel=13）
  host.states[12] = "spk-4";
  host.states[13] = "";
  painted = renderDetail();
  findButton(painted, "添加连线").props.onClick();
  painted = renderDetail();
  calls.length = 0;
  findButton(painted, "保存连线").props.onClick();
  await settle();
  const update = calls.find((c) => c.payload && c.payload.name === "spark_update");
  assert.ok(update, "spark_update issued");
  const sentLinks = update.payload.args.patch.links;
  assert.equal(sentLinks.length, 3, "三条连线全部提交");
  assert.deepEqual(sentLinks.map((l) => l.target).sort(), ["spk-2", "spk-3", "spk-4"], "历史两条 + 新增一条都在");
  for (const link of sentLinks) {
    assert.equal(link.rel, "related", "每条 rel 都是 related（无 null、无空串）");
  }

  // ③ 关系名超 64 个 UTF-16 字：不发请求，直接显示人话错误
  painted = renderDetail();
  host.states[12] = "spk-4";
  host.states[13] = "字".repeat(65);
  painted = renderDetail();
  findButton(painted, "添加连线").props.onClick();
  painted = renderDetail();
  calls.length = 0;
  findButton(painted, "保存连线").props.onClick();
  await settle();
  painted = renderDetail();
  assert.equal(calls.find((c) => c.payload && c.payload.name === "spark_update"), undefined,
    "超 64 字不发 spark_update");
  assert.ok(collectText(painted).includes("关系名最多 64 个字"), "显示人话错误「关系名最多 64 个字」");
  // 错误只拦这一次提交，不误伤：撤销超长草稿、改成合法关系名后能正常发出
  findButton(painted, "撤销修改").props.onClick();
  painted = renderDetail();
  host.states[12] = "spk-4";
  host.states[13] = "依赖";
  painted = renderDetail();
  findButton(painted, "添加连线").props.onClick();
  painted = renderDetail();
  calls.length = 0;
  findButton(painted, "保存连线").props.onClick();
  await settle();
  const retry = calls.find((c) => c.payload && c.payload.name === "spark_update");
  assert.ok(retry, "改成合法关系名后 spark_update 正常发出");
  assert.ok(retry.payload.args.patch.links.every((l) => l.rel.length <= 64 && l.rel.length >= 1),
    "提交的每条 rel 都在 1..64 字内");
});


// ---------------------------------------------------------------------------
// U5：整理与遗忘页重做——tab 改名 / 稍后再说 / kind 分组折叠 / 筛选搜索 /
// 删共享 proposal 框（预览直接按候选发骨架）+ 就地预览 / 计划独立成卡。
// 协议与守卫不变：doReview 仍发 reviewed / dismissed；previewPlan 仍发
// kind + candidateId + proposal + operationId + expectedQueueRevision。
// ---------------------------------------------------------------------------

test("U5/0.3：tab 名只讲遗忘，行按钮「稍后再说」带不删除 tooltip，协议仍发 decision=reviewed", async () => {
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
  host.states.push("candidates", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const tabLabels = flattenVNode(sectionTree)
    .filter((n) => n.type === "button" && String((n.props && n.props.className) || "").includes("dshi_tab"))
    .map((n) => [].concat(n.children).join(""));
  assert.ok(tabLabels.includes("遗忘"), "tab label is 遗忘 (0.3 只做遗忘)");
  assert.ok(!tabLabels.includes("整理与遗忘"), "old tab label 整理与遗忘 gone");
  assert.ok(!tabLabels.includes("候选 / 计划"), "old tab label 候选 / 计划 gone");

  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 5, items: clusterLoadedStates("x")[0].items, plans: [] };
      return {};
    },
  };
  const tab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "CandidatesTab");
  assert.ok(tab, "CandidatesTab reached");
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  host.cursor.v = 0;
  const tree = tab.type({ dsh, sessionId: "session-A" });
  const laterButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("稍后再说"));
  assert.equal(laterButtons.length, 2, "both candidate rows have 稍后再说 button");
  assert.equal(String(laterButtons[0].props.title), "只是收起来，不会删除任何记忆", "tooltip promises nothing gets deleted");
  assert.equal(flattenVNode(tree).some((n) => n.type === "button" && n.children.includes("标记已阅")), false,
    "old label 标记已阅 gone");
  laterButtons[0].props.onClick();
  await flush();
  const reviewed = calls.find((c) => c.method === "reviewCandidate");
  assert.ok(reviewed, "reviewCandidate issued");
  assert.equal(reviewed.payload.decision, "reviewed", "protocol decision stays reviewed");
  assert.equal(reviewed.payload.candidateId, "cluster-A", "candidate.id still sent");
});


test("U5/0.3：未知 kind 与缺 kind 的候选兜底渲染（kind 分组已裁撤，行在平铺列表中绝不静默消失）", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const items = [
    { candidate: { id: "fut-1", kind: "future-kind", scopeId: "default", sources: [{ id: "s9" }], evidence: {} }, status: "pending" },
    { candidate: { id: "no-kind", scopeId: "default", sources: [{ id: "s8" }], evidence: {} }, status: "pending" },
  ];
  const dsh = {
    call: async (method) => (method === "listCandidates" ? { queueRevision: 5, items, plans: [] } : {}),
  };
  host.states.length = 0;
  host.states.push({ queueRevision: 5, items, plans: [] }, null, false, "", null, null, { sessionId: "session-A", gen: 0 });
  const tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(!text.includes("其他（"), "no kind group headers anymore (0.3 flat list)");
  assert.ok(text.includes("fut-1") && text.includes("no-kind"), "unknown-kind and kind-less rows are both rendered");
  assert.ok(text.includes("future-kind"), "unknown kind badge keeps the raw value (never swallowed)");
});


test("U5：筛选（全部/待处理/已阅/已忽略，chip 带计数）与搜索框按短 id 过滤，均为纯前端", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const items = [
    { candidate: { id: "cand-pending", kind: "link", scopeId: "default", sources: [{ id: "s-1" }], evidence: {} }, status: "pending" },
    { candidate: { id: "cand-reviewed", kind: "link", scopeId: "default", sources: [{ id: "s-2" }], evidence: {} }, status: "reviewed" },
    { candidate: { id: "cand-dismissed", kind: "link", scopeId: "default", sources: [{ id: "s-3" }], evidence: {} }, status: "dismissed" },
  ];
  const dsh = {
    call: async (method) => (method === "listCandidates" ? { queueRevision: 5, items, plans: [] } : {}),
  };
  host.states.length = 0;
  host.states.push({ queueRevision: 5, items, plans: [] }, null, false, "", null, null, { sessionId: "session-A", gen: 0 });
  let tree = renderCandidates(dsh, "session-A");
  let text = collectText(tree);
  const chips = (t) => flattenVNode(t).filter((n) => n.type === "button" && String(n.props.className || "").includes("dshi_filterChip"));
  assert.ok(text.includes("已阅（1）"), "已阅 chip shows its count");
  assert.ok(text.includes("待处理（1）") && text.includes("已忽略（1）") && text.includes("全部（3）"), "all chips show counts");
  assert.ok(text.includes("cand-pending"), "default filter 待处理 shows the pending row");
  assert.equal(text.includes("cand-reviewed"), false, "reviewed row hidden under default filter");

  const reviewedChip = chips(tree).find((n) => collectText(n).includes("已阅"));
  reviewedChip.props.onClick();
  tree = renderCandidates(dsh, "session-A");
  text = collectText(tree);
  assert.ok(text.includes("cand-reviewed"), "已阅 filter shows the reviewed row");
  assert.equal(text.includes("cand-pending"), false, "pending row hidden under 已阅 filter");

  const allChip = chips(tree).find((n) => collectText(n).includes("全部"));
  allChip.props.onClick();
  tree = renderCandidates(dsh, "session-A");
  text = collectText(tree);
  assert.ok(text.includes("cand-pending") && text.includes("cand-reviewed") && text.includes("cand-dismissed"),
    "全部 filter shows every row");

  const searchInput = flattenVNode(tree).find((n) => n.type === "input" && String(n.props.className || "").includes("dshi_searchInput"));
  assert.ok(searchInput, "search input present");
  searchInput.props.onChange({ target: { value: "cand-re" } });
  tree = renderCandidates(dsh, "session-A");
  text = collectText(tree);
  assert.ok(text.includes("cand-reviewed"), "search by short id keeps the matching row");
  assert.equal(text.includes("cand-pending") && text.includes("cand-dismissed"), false,
    "search filters out non-matching rows (no RPC issued)");
});

test("U5：计划列表独立成卡；已执行 / 已作废默认折叠（details 无 open），折叠内容仍在 DOM 可切回", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const planRows = [
    { planId: "plan-open", kind: "forgetting", planDigest: "d1", queueRevision: 0, changedItems: 1, summary: "s", createdAt: "2026-11-01T00:00:00.000Z", executed: false, superseded: false },
    { planId: "plan-done", kind: "forgetting", planDigest: "d2", queueRevision: 0, changedItems: 1, summary: "s", createdAt: "2026-11-01T00:01:00.000Z", executed: true, superseded: false },
  ];
  const dsh = {
    call: async (method) => (method === "listCandidates" ? { queueRevision: 5, items: [], plans: planRows } : {}),
  };
  host.states.length = 0;
  host.states.push({ queueRevision: 5, items: [], plans: planRows }, null, false, "", null, null, { sessionId: "session-A", gen: 0 });
  const tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("计划（2）"), "plans card title rendered");
  const cards = flattenVNode(tree).filter((n) => n.type === "div" && n.props && n.props.className === "dshi_card");
  const plansCard = cards.find((n) => collectText(n).includes("计划（2）"));
  assert.ok(plansCard, "plans live in their own card");
  assert.equal(collectText(plansCard).includes("候选（"), false, "plans no longer share the candidates card");
  const archive = flattenVNode(tree)
    .filter((n) => n.type === "details")
    .find((n) => collectText(n).includes("已执行 / 已作废"));
  assert.ok(archive, "archive group present");
  assert.equal(Object.prototype.hasOwnProperty.call(archive.props, "open"), false, "archive collapsed by default (no open attribute)");
  assert.ok(collectText(archive).includes("（1）"), "archive group shows its count");
  assert.ok(collectText(archive).includes("该计划已执行：不可再次预览 / 执行"), "executed row content stays in the DOM while collapsed");
});

// ── U5b：候选理由行 + 预览卡人话 + 按 kind 的按钮文案（只改显示层，协议与守卫不动）──

function mountCandidatesWithItems(items) {
  return async () => {
    const host = makeStatefulReact();
    const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
    const renderCandidates = await mountCandidates(mod, host);
    const dsh = { call: async (method) => (method === "listCandidates" ? { queueRevision: 5, items, plans: [] } : {}) };
    host.states.length = 0;
    host.states.push({ queueRevision: 5, items, plans: [] }, null, false, "", null, null, { sessionId: "session-A", gen: 0 });
    return { host, renderCandidates, dsh };
  };
}

// （0.3：expandIsolatedGroup 辅助已随 kind 分组裁撤删除，孤立卡行平铺渲染、直接断言。）

test("U5b：候选行理由小字——link 并列实体/触发词、cluster 报数点名、isolated 补退休连线数", async () => {
  const items = [
    { candidate: { id: "link-1", kind: "link", scopeId: "default", sources: [{ id: "a-1" }, { id: "b-2" }], evidence: { sharedEntities: ["小樱"], sharedTriggers: ["早上去学校"] } }, status: "pending" },
    { candidate: { id: "cluster-1", kind: "cluster", scopeId: "default", sources: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], evidence: { field: "triggers", sharedTerm: "海贼王" } }, status: "pending" },
    { candidate: { id: "iso-1", kind: "isolated", scopeId: "default", sources: [{ id: "s9" }], evidence: { inDegree: 0, outDegree: 0, ignoredRetiredTargets: ["t-1", "t-2"] } }, status: "pending" },
  ];
  const make = await mountCandidatesWithItems(items)();
  // 0.3：无分组折叠，行直接平铺可见
  let tree = make.renderCandidates(make.dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("理由：两张卡都提到实体「小樱」；都带触发词「早上去学校」"),
    "link reason joins entities and triggers");
  assert.ok(text.includes("理由：3 张卡都共享触发词「海贼王」，可以合并成一个主题"),
    "cluster reason counts sources and names the shared term (field=triggers → 触发词)");
  assert.ok(text.includes("理由：这张卡没有和任何卡相连（另有 2 条指向已退休卡的旧连线）"),
    "isolated reason appends retired-link count");
});

test("U5b：cluster field=entities 用「实体」；link 两字段都空退化为「两张卡有共同关键词」", async () => {
  const items = [
    { candidate: { id: "cluster-e", kind: "cluster", scopeId: "default", sources: [{ id: "s1" }, { id: "s2" }], evidence: { field: "entities", sharedTerm: "海贼王" } }, status: "pending" },
    { candidate: { id: "link-e", kind: "link", scopeId: "default", sources: [{ id: "a-1" }, { id: "b-2" }], evidence: {} }, status: "pending" },
  ];
  const make = await mountCandidatesWithItems(items)();
  const tree = make.renderCandidates(make.dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("理由：2 张卡都共享实体「海贼王」，可以合并成一个主题"),
    "cluster reason uses 实体 for field=entities");
  assert.ok(text.includes("理由：两张卡有共同关键词"), "link with empty evidence degrades to generic keyword reason");
});

test("U5b：evidence 缺失 / 形状不对 / 未知 kind → 不出理由行，行本身一个不少", async () => {
  const items = [
    { candidate: { id: "cluster-plain", kind: "cluster", scopeId: "default", sources: [{ id: "s1" }, { id: "s2" }], evidence: {} }, status: "pending" },
    { candidate: { id: "link-bad", kind: "link", scopeId: "default", sources: [{ id: "a-1" }, { id: "b-2" }], evidence: { sharedEntities: "小樱" } }, status: "pending" },
    { candidate: { id: "no-evidence", kind: "isolated", scopeId: "default", sources: [{ id: "s9" }] }, status: "pending" },
    { candidate: { id: "fut-1", kind: "future-kind", scopeId: "default", sources: [{ id: "s8" }], evidence: { sharedEntities: ["x"] } }, status: "pending" },
  ];
  const make = await mountCandidatesWithItems(items)();
  // 0.3：无分组折叠，行直接平铺可见
  let tree = make.renderCandidates(make.dsh, "session-A");
  const text = collectText(tree);
  assert.equal(text.includes("理由："), false, "no reason line rendered for missing/malformed/unknown evidence");
  assert.ok(text.includes("cluster-plain") && text.includes("link-bad") && text.includes("no-evidence") && text.includes("fut-1"),
    "all rows still rendered — reason must not swallow the row");
});



test("0.2.3：预览卡 thin-core 已裁撤——不再渲染瘦身标题 / 长度正文 /「确认瘦身」按钮，回落通用确认卡", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const longBefore = "旧".repeat(12345);
  const longAfter = "新".repeat(8900);
  const plan = {
    kind: "organize", proposalKind: "thin-core", planId: "plan-T", planDigest: "digest-T", queueRevision: 0,
    summary: "thin-core plan over 1 source(s)",
    diff: [{ path: "core", oldText: longBefore, newText: longAfter }],
  };
  const dsh = { call: async (method) => (method === "listCandidates" ? { queueRevision: 0, items: [], plans: [] } : {}) };
  host.states.length = 0;
  host.states.push({ queueRevision: 0, items: [], plans: [] }, null, false, "", { sessionId: "session-A", plan, queueRevision: 0 }, null, { sessionId: "session-A", gen: 0 });
  const tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  // 0.2.3 裁撤：thin-core 专用文案（标题「core 瘦身」/ 长度正文 / 专用按钮）一律不再出现。
  assert.ok(!text.includes("core 瘦身"), "no thin-core title");
  assert.ok(!text.includes("core 正文 12345 → 8900 字"), "no thin-core length body line");
  assert.ok(!flattenVNode(tree).some((n) => n.type === "button" && n.children.includes("确认瘦身")), "no 确认瘦身 button");
  // 回落通用确认卡：标题原样透出 kind，正文走 summary 兜底，按钮「确认执行」danger。
  const confirm = flattenVNode(tree).find((n) => n.type === "button" && n.children.includes("确认执行"));
  assert.ok(confirm, "generic 确认执行 button");
  assert.ok(String(confirm.props.className || "").includes("dshi_btnDanger"), "fallback confirm stays danger");
  assert.ok(text.includes("thin-core plan over 1 source(s)"), "summary fallback keeps some info");
  const rawInfo = flattenVNode(tree).find((n) => n.type === "details" && collectText(n).includes("原始信息"));
  assert.ok(rawInfo && collectText(rawInfo).includes("旧".repeat(50)), "full before text only inside collapsed 原始信息 details");
});

test("U5b：预览卡未知 kind——标题原样显示 kind、正文走 summary 兜底、按钮「确认执行」danger，不崩", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const plan = {
    kind: "organize", planId: "plan-A", planDigest: "digest-A", queueRevision: 0,
    summary: "organize plan over 3 source(s)",
    diff: [{ path: "spark:s-1", oldText: "旧", newText: "新" }],
  };
  const dsh = {
    call: async (method, session, payload) => {
      if (method === "listCandidates") return { queueRevision: 0, items: [], plans: [] };
      if (method === "executePlan") return { executed: true };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push({ queueRevision: 0, items: [], plans: [] }, null, false, "", { sessionId: "session-A", plan, queueRevision: 0 }, null, { sessionId: "session-A", gen: 0 });
  const tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("organize"), "unknown kind shown as-is");
  assert.ok(text.includes("organize plan over 3 source(s)"), "summary fallback keeps some info for unknown kinds");
  const confirm = flattenVNode(tree).find((n) => n.type === "button" && n.children.includes("确认执行"));
  assert.ok(confirm, "unknown kind keeps generic 确认执行 button");
  assert.ok(String(confirm.props.className || "").includes("dshi_btnDanger"), "unknown kind confirm stays danger");
  assert.ok(text.includes("旧") && text.includes("新"), "raw diff still reachable inside 原始信息");
});

// ── 0.2.3：planView.proposalKind 决定预览卡文案（planKindOf：proposalKind 优先，
// 回退 plan.kind；旧服务端不带该字段时回到现状）──────────────────────────────

function mountPreviewPlan(plan) {
  return async () => {
    const host = makeStatefulReact();
    const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
    const renderCandidates = await mountCandidates(mod, host);
    const dsh = { call: async (method) => (method === "listCandidates" ? { queueRevision: 0, items: [], plans: [] } : {}) };
    host.states.length = 0;
    host.states.push({ queueRevision: 0, items: [], plans: [] }, null, false, "", { sessionId: "session-A", plan, queueRevision: 0 }, null, { sessionId: "session-A", gen: 0 });
    const tree = renderCandidates(dsh, "session-A");
    return { host, tree, text: collectText(tree) };
  };
}

test("0.2.3/0.3：planKindOf——proposalKind 仍决定取值；thin-core 已裁撤不出专用文案；缺失时 kind:organize 不出任何专用文案且不抛错（merge-topic 文案随整理流程删除）", async () => {
  // 断言 1：kind:"organize"+proposalKind:"merge-topic"（整理流程 0.3 裁撤）→
  // 不再出「合并进主题」专用标题 / 正文 / 确认按钮，回落通用确认卡。
  const merge = await (await mountPreviewPlan({
    kind: "organize", proposalKind: "merge-topic", planId: "plan-M2", planDigest: "digest-M2", queueRevision: 0,
    summary: "merge-topic plan over 2 source(s)",
    diff: [
      { path: "topic:topic-y", oldText: "# 主题", newText: "# 主题\n追加" },
      { path: "spark:s-1", oldText: "{}", newText: '{"state":"merged"}' },
      { path: "spark:s-2", oldText: "{}", newText: '{"state":"merged"}' },
    ],
  }))();
  const mergeCard = flattenVNode(merge.tree).find((n) => n.type === "div" && n.props && n.props.className === "dshi_confirm");
  assert.ok(mergeCard, "preview confirm card rendered without throw");
  const mergeCardText = collectText(mergeCard);
  assert.ok(!mergeCardText.includes("把 2 张卡合并进主题"), "merge-topic body line removed with the organize flow");
  assert.ok(!mergeCardText.includes("合并后源卡会退休，这一步不可撤销"), "merge-topic retirement warning removed");
  assert.ok(!flattenVNode(mergeCard).some((n) => n.type === "button" && n.children.includes("确认合并（不可撤销）")),
    "merge-topic confirm button removed; falls back to generic");

  // 断言 2：kind:"organize"+proposalKind:"thin-core"（0.2.3 已裁撤）→ 不出瘦身标题 /
  // 长度正文 /「确认瘦身」按钮，回落通用确认卡（summary 兜底、确认执行）。
  const thin = await (await mountPreviewPlan({
    kind: "organize", proposalKind: "thin-core", planId: "plan-T2", planDigest: "digest-T2", queueRevision: 0,
    summary: "thin-core plan over 1 source(s)",
    diff: [{ path: "core", oldText: "旧".repeat(500), newText: "新".repeat(300) }],
  }))();
  assert.ok(!thin.text.includes("core 瘦身"), "no thin-core title (kind removed in 0.2.3)");
  assert.ok(!thin.text.includes("core 正文 500 → 300 字"), "no thin-core length body line");
  assert.ok(!flattenVNode(thin.tree).some((n) => n.type === "button" && n.children.includes("确认瘦身")), "no 确认瘦身 button");
  const thinConfirm = flattenVNode(thin.tree).find((n) => n.type === "button" && n.children.includes("确认执行"));
  assert.ok(thinConfirm, "thin-core falls back to generic 确认执行");

  // 断言 3：proposalKind 缺失且 kind:"organize"（旧服务端 / 无 proposal 形状）→
  // 不出任何专用标题 / 正文（回到现状），也不许抛错。只看预览确认卡（dshi_confirm）
  // 区域——页面固定说明文案里本就含「合并进主题」等词，不能按全文匹配。
  const legacy = await (await mountPreviewPlan({
    kind: "organize", planId: "plan-O2", planDigest: "digest-O2", queueRevision: 0,
    summary: "organize plan over 1 source(s)",
    diff: [{ path: "spark:s-1", oldText: "旧", newText: "新" }],
  }))();
  const legacyCard = flattenVNode(legacy.tree).find((n) => n.type === "div" && n.props && n.props.className === "dshi_confirm");
  assert.ok(legacyCard, "preview confirm card rendered without throw");
  const legacyCardText = collectText(legacyCard);
  assert.ok(!legacyCardText.includes("连起来") && !legacyCardText.includes("合并进主题") && !legacyCardText.includes("core 瘦身") && !legacyCardText.includes("专题归档"),
    "no specialized title when proposalKind is missing on kind:organize");
  assert.ok(!legacyCardText.includes("把 2 张卡合并进主题") && !legacyCardText.includes("core 正文") && !legacyCardText.includes("移出 L1 索引") && !legacyCardText.includes("合并后源卡会退休"),
    "no specialized body lines either");
  const legacyConfirm = flattenVNode(legacyCard).find((n) => n.type === "button" && n.children.includes("确认执行"));
  assert.ok(legacyConfirm, "fallback keeps generic 确认执行 button (no throw, old behavior)");
});

// ── U5-c：孤立卡不提供「预览整理计划」──────────────────────────────────────
// 背景：孤立卡（kind=isolated）只有 1 张源卡，proposalSkeleton 退化为占位符
// "<另一张卡 id>"，服务端 validateSparkIdLocal 必拒（INVALID_INPUT）。
// 修复：孤立卡行不渲染该入口；proposalSkeleton 对 sources<2 返回 null；
// doPreviewOrganize 本地报人话错误，不发任何 RPC。

function candidateRowsOf(tree) {
  return flattenVNode(tree).filter((n) => n.type === "div" && n.props && n.props.className === "dshi_item");
}
function previewButtonsIn(node) {
  return flattenVNode(node).filter((n) => n.type === "button" && n.children.includes("预览整理计划"));
}

test("U5-c/0.3：候选行（含孤立卡）一律没有「预览整理计划」入口，行动作只剩 稍后再说 + 忽略", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const items = [
    { candidate: { id: "cluster-A", kind: "cluster", scopeId: "default", sources: [{ id: "s1" }, { id: "s2" }], evidence: {} }, status: "pending" },
    { candidate: { id: "link-B", kind: "link", scopeId: "default", sources: [{ id: "s3" }, { id: "s4" }], evidence: {} }, status: "pending" },
    { candidate: { id: "iso-C", kind: "isolated", scopeId: "default", sources: [{ id: "s5" }], evidence: {} }, status: "pending" },
  ];
  const dsh = {
    call: async (method) => (method === "listCandidates" ? { queueRevision: 5, items, plans: [] } : {}),
  };
  host.states.length = 0;
  host.states.push({ queueRevision: 5, items, plans: [] }, null, false, "", null, null, { sessionId: "session-A", gen: 0 });
  const tree = renderCandidates(dsh, "session-A");

  const rows = candidateRowsOf(tree);
  const clusterRow = rows.find((row) => collectText(row).includes("cluster-A"));
  const linkRow = rows.find((row) => collectText(row).includes("link-B"));
  const isoRow = rows.find((row) => collectText(row).includes("iso-C"));
  assert.ok(clusterRow && linkRow && isoRow, "all three kind rows rendered");
  assert.equal(previewButtonsIn(clusterRow).length, 0, "cluster row has no 预览整理计划 (removed in 0.3)");
  assert.equal(previewButtonsIn(linkRow).length, 0, "link row has no 预览整理计划 (removed in 0.3)");
  assert.equal(previewButtonsIn(isoRow).length, 0, "isolated row has no 预览整理计划 entry");
  // 每行只保留审阅动作，行本身一个不少
  for (const row of [clusterRow, linkRow, isoRow]) {
    const labels = flattenVNode(row).filter((n) => n.type === "button").map((n) => n.children.join(""));
    assert.deepEqual(labels, ["稍后再说", "忽略"], "row keeps exactly 稍后再说 + 忽略");
  }
});

test("U5-c/0.3：候选区提示语只讲遗忘口径（遗留整理候选可审阅，不再提预览/合并入口）", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const items = [
    { candidate: { id: "cluster-A", kind: "cluster", scopeId: "default", sources: [{ id: "s1" }, { id: "s2" }], evidence: {} }, status: "pending" },
    { candidate: { id: "link-B", kind: "link", scopeId: "default", sources: [{ id: "s3" }, { id: "s4" }], evidence: {} }, status: "pending" },
    { candidate: { id: "iso-C", kind: "isolated", scopeId: "default", sources: [{ id: "s5" }], evidence: {} }, status: "pending" },
  ];
  const dsh = {
    call: async (method) => (method === "listCandidates" ? { queueRevision: 5, items, plans: [] } : {}),
  };
  host.states.length = 0;
  host.states.push({ queueRevision: 5, items, plans: [] }, null, false, "", null, null, { sessionId: "session-A", gen: 0 });
  const tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("候选是之前「整理分析」留下的待审条目"), "hint states legacy organize candidates stay reviewable");
  assert.ok(text.includes("稍后再说"), "review actions still explained");
  assert.equal(text.includes("可「合并进主题」"), false, "old merge entry hint gone");
  assert.equal(text.includes("可「预览整理计划」"), false, "old organize preview hint gone");
});



// U5-d（0.3 更新）：错误文案不再指向已删除的「分析整理候选」——候选操作指向「刷新」，
// 计划执行冲突指向计划行的「预览遗忘计划」；「刷新」按钮 title 说明只重读快照。
test("U5-d/0.3：REVISION_CONFLICT 提示指向行内「预览遗忘计划」；「刷新」按钮 title 说明只重读快照", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: [], plans: [] };
      if (method === "executePlan") throw Object.assign(new Error("plan already executed"), { code: "REVISION_CONFLICT" });
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(
    { queueRevision: 0, items: [], plans: [] }, null, false, "", null, null, { sessionId: "session-A", gen: 0 });
  // 预置一条已成功预览（模拟用户此前已预览过遗忘计划），走确认执行错误路径
  host.states[4] = { sessionId: "session-A", plan: { kind: "forgetting", planId: "plan-F", planDigest: "digest-F", summary: "", diff: [] }, queueRevision: 0 };
  let tree = renderCandidates(dsh, "session-A");
  findButton(tree, "确认执行").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("revision 冲突"), "REVISION_CONFLICT explained in Chinese");
  assert.ok(text.includes("预览遗忘计划"), "guidance points to the working entry (重新生成预览)");
  assert.ok(text.includes("不要重试旧预览"), "do-not-retry-stale-preview warning retained");
  assert.ok(!text.includes("分析整理候选"), "removed organize button never referenced");
  assert.ok(text.includes("plan already executed"), "original message retained");

  // 「刷新」按钮：title 必须说明它只重读队列快照、不会重新分析
  tree = renderCandidates(dsh, "session-A");
  const refreshButton = findButton(tree, "刷新");
  const refreshTitle = String(refreshButton.props.title || "");
  assert.ok(refreshTitle.includes("只重新读取队列快照") && refreshTitle.includes("不会重新分析"),
    "refresh button title clarifies it does not re-analyze");
});

// ---------------------------------------------------------------------------
// U5-e：过期候选就地标注（行内「卡片已改」徽章 + 预览按钮置灰）与顶部重新分析入口。
// ---------------------------------------------------------------------------

test("U5-e/0.3：stale 候选渲染「卡片已改」徽章 + 理由小字，「稍后再说」「忽略」仍可用（整理预览/合并入口已裁撤）", async () => {
  const items = [
    { candidate: { id: "link-stale", kind: "link", scopeId: "default", sources: [{ id: "a-1" }, { id: "b-2" }], evidence: { sharedEntities: ["小樱"] } }, status: "pending", stale: true },
    { candidate: { id: "link-fresh", kind: "link", scopeId: "default", sources: [{ id: "c-1" }, { id: "d-2" }], evidence: { sharedEntities: ["小兰"] } }, status: "pending" },
    { candidate: { id: "cluster-stale", kind: "cluster", scopeId: "default", sources: [{ id: "s1" }, { id: "s2" }, { id: "s3" }], evidence: { field: "triggers", sharedTerm: "海贼王" } }, status: "pending", stale: true },
    { candidate: { id: "cluster-fresh", kind: "cluster", scopeId: "default", sources: [{ id: "s4" }, { id: "s5" }, { id: "s6" }], evidence: { field: "triggers", sharedTerm: "火影" } }, status: "pending" },
  ];
  const make = await mountCandidatesWithItems(items)();
  const tree = make.renderCandidates(make.dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("卡片已改"), "stale badge text rendered");
  assert.ok(text.includes("这条候选绑定的卡片在你上次分析之后被改过"),
    "stale reason line rendered");
  // 过期行徽章类名存在；未过期行不出现
  const badges = flattenVNode(tree).filter((n) => String(n.props.className || "").includes("dshi_badgeStale"));
  assert.equal(badges.length, 2, "one stale badge per stale row");
  // 0.3：「预览整理计划」「合并进主题」已随整理流程裁撤，页面不再出现
  assert.equal(flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("预览整理计划")).length, 0,
    "organize preview entry removed");
  assert.equal(flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("合并进主题")).length, 0,
    "merge entry removed");
  // 「稍后再说」「忽略」不受 stale 影响（只改 status，不校验 revision），每行各一对
  const reviewButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("稍后再说"));
  const dismissButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("忽略"));
  assert.equal(reviewButtons.length, 4, "every row keeps a review action");
  assert.equal(dismissButtons.length, 4, "every row keeps a dismiss action");
  assert.ok(reviewButtons.every((b) => b.props.disabled === false), "review buttons stay enabled on stale rows");
  assert.ok(dismissButtons.every((b) => b.props.disabled === false), "dismiss buttons stay enabled on stale rows");
});



// ---------------------------------------------------------------------------
// 0.2.2 归档入口（task-ed991a8fb6f08bfc-s2）：整理页专题行「移出索引 / 恢复到索引」。
// 证据级别：真实 client/index.js 执行 + 有状态 react stub（非浏览器实机）；
// executeTool / previewPlan / executePlan 均打桩，纯合成数据，不触真实宿主。
// 契约：previewPlan 入参 { kind:'archive-topic', topicKey, archive }，返回与 organize
// 相同的 plan 视图；客户端不发明新 RPC。
// ---------------------------------------------------------------------------

// 专题行查找：专题行是 dshi_item，行头有 dshi_mono span 文本恰为 topic key
// （候选行的 dshi_mono 是短 id、计划行是 planId，均不会与 key 全等）。
function topicRowByKey(tree, key) {
  return flattenVNode(tree).find((n) => {
    if (n.type !== "div" || String(n.props.className || "") !== "dshi_item") return false;
    return flattenVNode(n).some((m) => m.type === "span"
      && String(m.props.className || "").includes("dshi_mono")
      && collectText(m) === key);
  });
}

function rowButtonLabels(row) {
  return flattenVNode(row)
    .filter((n) => n.type === "button")
    .map((n) => collectText(n));
}

const archiveTopicsFixture = () => [
  { key: "t-old", title: "旧", summary: "abcdef", updated: "2026-01-01T00:00:00.000Z", revision: "shiori-r1.Old.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  { key: "t-new", title: "新", summary: "abcd", updated: "2026-05-01T00:00:00.000Z", revision: "shiori-r1.New.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  { key: "t-same-a", title: "A", summary: "longer-summary", updated: "2026-05-01T00:00:00.000Z", revision: "shiori-r1.Sam.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  { key: "t-noupd", title: "无时间", summary: "ab", updated: "", revision: "shiori-r1.Nou.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  { key: "t-arch", title: "归档", summary: "xyz", updated: "2026-03-01T00:00:00.000Z", revision: "shiori-r1.Arc.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", archived: true },
];

test("0.2.2 归档入口：专题列表排序（未归档在前按 updated 升序、空 updated 最后、已归档整段靠后）+ 已归档徽章与行按钮布局", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return clusterLoadedStates("x")[0];
      if (method === "executeTool" && payload.name === "memory_list_topics") return { topics: archiveTopicsFixture() };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  // 0.3：归档入口从合并卡迁到独立「专题索引归档（手动）」卡——点「载入 / 刷新专题」拉列表
  findButton(tree, "载入 / 刷新专题").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");

  // 顶部说明：未归档计数 + 语义边界（不写死字符数预算）
  const text = collectText(tree);
  assert.ok(text.includes("未归档 4 篇"), "top hint counts unarchived topics");
  assert.ok(text.includes("移出索引只影响每轮注入的 L1 索引条目，正文保留，memory_read(key) 随时可读，memory_search 仍能搜到"),
    "top hint explains L1-index-only semantics");

  // 排序：t-old(2026-01-01) → 同 updated 的 t-same-a/t-new（summary 长度降序）→
  // t-noupd（空 updated 组内垫底）→ 已归档 t-arch 整段最后
  const order = ["t-old", "t-same-a", "t-new", "t-noupd", "t-arch"].map((k) => text.indexOf(k));
  assert.ok(order.every((i) => i >= 0), "all topic keys rendered");
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "topic rows rendered in required order");

  // 已归档徽章：dshi_badgeDim dshi_badge，恰好 1 个
  const badges = flattenVNode(tree).filter((n) => n.type === "span"
    && String(n.props.className || "").includes("dshi_badge")
    && collectText(n) === "已归档");
  assert.equal(badges.length, 1, "exactly one 已归档 badge");
  assert.ok(topicRowByKey(tree, "t-arch"), "archived row rendered");

  // 行按钮布局（0.3）：未归档行 = 移出索引（合并入口已随整理流程裁撤）；已归档行 = 恢复到索引
  assert.deepEqual(rowButtonLabels(topicRowByKey(tree, "t-arch")), ["恢复到索引"],
    "archived row: only 恢复到索引");
  assert.deepEqual(rowButtonLabels(topicRowByKey(tree, "t-old")), ["移出索引"],
    "unarchived row: only 移出索引");
  assert.equal(flattenVNode(tree).filter((n) => n.type === "button" && collectText(n) === "移出索引").length, 4,
    "移出索引 on every unarchived row");
});

test("0.2.2 归档入口：未归档行「移出索引」发 previewPlan {kind:'archive-topic',topicKey,archive:true}（payload 恰三键、无损），确认卡文案与 executePlan、成功后刷新列表", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return clusterLoadedStates("x")[0];
      if (method === "executeTool" && payload.name === "memory_list_topics") {
        return { topics: [{ key: "t-live", title: "活", summary: "s", updated: "2026-10-26T10:00:00.000Z", revision: "shiori-r1.Liv.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }] };
      }
      if (method === "previewPlan") {
        // 服务端真实 planView 形状（reviewer 打回项 3，src/plugin/management.mjs
        // archive-topic 分支）：kind 恒为家族名 "organize"，client 靠 preview.archiveTopic
        // 钉定判定归档卡，不得依赖 plan.kind === "archive-topic"（生产恒为假）。
        return { kind: "organize", planId: "plan-AT", planDigest: "digest-AT", queueRevision: null, changedItems: 1, summary: "archive-topic plan over 1 topic", diff: [
          { path: "topic:t-live", oldText: "archivedAt: (未归档)", newText: "archivedAt: 2026-11-07T10:00:00.000Z" },
        ] };
      }
      if (method === "executePlan") return { executed: true };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  // 0.3：入口改走「专题索引归档（手动）」卡
  findButton(tree, "载入 / 刷新专题").props.onClick();
  await flush();

  tree = renderCandidates(dsh, "session-A");
  const row = topicRowByKey(tree, "t-live");
  assert.ok(row, "topic row rendered");
  const removeBtn = flattenVNode(row).find((n) => n.type === "button" && collectText(n) === "移出索引");
  removeBtn.props.onClick();
  await flush();

  const previewCall = calls.find((c) => c.method === "previewPlan");
  assert.ok(previewCall, "previewPlan sent on 移出索引 click");
  assert.deepEqual(Object.keys(previewCall.payload).sort(), ["archive", "kind", "topicKey"],
    "archive-topic preview payload has exactly the contract keys");
  assert.deepEqual(previewCall.payload, { kind: "archive-topic", topicKey: "t-live", archive: true });
  assert.equal(previewCall.session, "session-A");
  assert.equal(isRemoteJsonValue(previewCall.payload), true, "archive-topic preview payload lossless");

  // 确认卡（targetId=topicKey 不在候选/计划行中 → 回落底部确认卡）
  tree = renderCandidates(dsh, "session-A");
  const cardText = collectText(tree);
  assert.ok(cardText.includes("专题归档"), "archive-topic card title rendered");
  assert.ok(cardText.includes("把专题『t-live』移出 L1 索引"), "card body names topic and direction");
  assert.ok(cardText.includes("正文长度不变，随时可读"), "card body states content untouched");
  const confirmBtn = findButton(tree, "确认移出索引（可随时恢复）");
  assert.equal(confirmBtn.props.disabled, false, "confirm enabled for open plan");

  confirmBtn.props.onClick();
  await flush();
  const exec = calls.find((c) => c.method === "executePlan");
  assert.ok(exec, "executePlan sent on confirm");
  assert.equal(exec.payload.planId, "plan-AT");
  assert.equal(exec.payload.planDigest, "digest-AT");
  assert.equal(exec.payload.confirmed, true);
  // 执行成功：刷新专题列表（memory_list_topics 共两次：openMerge 一次 + 执行后一次）
  const listCalls = calls.filter((c) => c.method === "executeTool" && c.payload.name === "memory_list_topics");
  assert.equal(listCalls.length, 2, "topics list refreshed after archive-topic execution");
});

test("0.2.2 归档入口：已归档行「恢复到索引」发 archive:false，确认卡为「确认恢复」方向", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return clusterLoadedStates("x")[0];
      if (method === "executeTool" && payload.name === "memory_list_topics") return { topics: [archiveTopicsFixture()[4]] };
      if (method === "previewPlan") {
        // 同上：服务端真实 planView 形状，kind 恒为 "organize"。
        return { kind: "organize", planId: "plan-AR", planDigest: "digest-AR", queueRevision: null, changedItems: 1, summary: "archive-topic plan over 1 topic", diff: [
          { path: "topic:t-arch", oldText: "archivedAt: 2026-03-01T00:00:00.000Z", newText: "archivedAt: (未归档)" },
        ] };
      }
      if (method === "executePlan") return { executed: true };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  // 0.3：入口改走「专题索引归档（手动）」卡
  findButton(tree, "载入 / 刷新专题").props.onClick();
  await flush();

  tree = renderCandidates(dsh, "session-A");
  const row = topicRowByKey(tree, "t-arch");
  const restoreBtn = flattenVNode(row).find((n) => n.type === "button" && collectText(n) === "恢复到索引");
  restoreBtn.props.onClick();
  await flush();

  const previewCall = calls.find((c) => c.method === "previewPlan");
  assert.ok(previewCall, "previewPlan sent on 恢复到索引 click");
  assert.deepEqual(previewCall.payload, { kind: "archive-topic", topicKey: "t-arch", archive: false },
    "restore direction sends archive:false");

  tree = renderCandidates(dsh, "session-A");
  const cardText = collectText(tree);
  assert.ok(cardText.includes("把专题『t-arch』恢复到 L1 索引"), "restore direction named in card body");
  findButton(tree, "确认恢复").props.onClick();
  await flush();
  const exec = calls.find((c) => c.method === "executePlan");
  assert.ok(exec, "executePlan sent on restore confirm");
  assert.equal(exec.payload.planId, "plan-AR");
});

test("0.2.2 归档入口：previewPlan 失败走既有 ErrorBox 展示（code 保留 + 中文说明），不渲染确认卡", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return clusterLoadedStates("x")[0];
      if (method === "executeTool" && payload.name === "memory_list_topics") {
        return { topics: [{ key: "t-live", title: "活", summary: "s", updated: "2026-10-26T10:00:00.000Z", revision: "shiori-r1.Liv.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }] };
      }
      if (method === "previewPlan") {
        throw Object.assign(new Error("archive-topic plan refused by server"), { code: "UNSUPPORTED" });
      }
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  // 0.3：入口改走「专题索引归档（手动）」卡
  findButton(tree, "载入 / 刷新专题").props.onClick();
  await flush();

  tree = renderCandidates(dsh, "session-A");
  const row = topicRowByKey(tree, "t-live");
  flattenVNode(row).find((n) => n.type === "button" && collectText(n) === "移出索引").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");

  const text = collectText(tree);
  assert.ok(text.includes("[UNSUPPORTED]"), "original code preserved in ErrorBox");
  assert.ok(text.includes("服务端不支持该操作"), "UNSUPPORTED explained in Chinese");
  assert.ok(text.includes("archive-topic plan refused by server"), "original message retained");
  assert.equal(flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === "确认移出索引（可随时恢复）"), undefined,
    "no confirm card after failed preview");
  assert.equal(calls.filter((c) => c.method === "executePlan").length, 0, "executePlan never sent after failed preview");
});

test("0.2.2 归档入口（rework a2）：普通 organize 预览（preview 未钉 archiveTopic）不出现「专题归档」、确认按钮为「确认执行」、执行后不刷新专题列表", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  // 普通 organize 预览的 planView：与服务端归档预览同 kind（恒 "organize"），
  // 但 preview 状态里没有 archiveTopic 钉定——client 不得据此显示归档文案。
  const ordinaryPlanView = { kind: "organize", planId: "plan-ORG", planDigest: "digest-ORG", queueRevision: 7, changedItems: 1, summary: "organize plan", diff: [] };
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 7, items: [], plans: [] };
      if (method === "previewPlan") return ordinaryPlanView;
      if (method === "executePlan") return { executed: true };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(
    { queueRevision: 7, items: [], plans: [] },
    null, false, "",
    // preview 状态：无 archiveTopic 钉定（普通 organize 预览，如候选行「预览整理计划」产物）
    { sessionId: "session-A", plan: ordinaryPlanView, queueRevision: 7 },
    null,
    { sessionId: "session-A", gen: 0 });
  let tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(!text.includes("专题归档"), "no archive title on ordinary organize preview");
  assert.ok(!text.includes("移出 L1 索引"), "no archive body line on ordinary organize preview");
  const confirmBtn = findButton(tree, "确认执行");
  assert.equal(confirmBtn.props.disabled, false, "ordinary preview confirm enabled with default label");

  confirmBtn.props.onClick();
  await flush();
  const exec = calls.find((c) => c.method === "executePlan");
  assert.ok(exec, "executePlan sent for ordinary organize preview");
  assert.equal(calls.filter((c) => c.method === "executeTool" && c.payload.name === "memory_list_topics").length, 0,
    "topics list NOT refreshed after ordinary organize execution");
});
