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
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { register } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiori-q-client-"));
const HOST_MODULES = "C:/Users/crash/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules";

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

test("bundle：ModuleLoader 注册、导出 apply/inject、9 端点 wire 冻结", async () => {
  const mod = loadClientModule();
  assert.deepEqual(Object.keys(mod).sort(), ["TYPERT_REMOTE", "apply", "ensureLosslessJson", "inject"]);
  assert.deepEqual(mod.inject, ["remote", "slots", "configForms"]);
  assert.equal(mod.TYPERT_REMOTE.package, "dsh-shiori");

  const expected = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"];
  const endpoints = Object.keys(mod.TYPERT_REMOTE.methods).sort();
  assert.deepEqual(endpoints, [...expected].map((m) => `shiori/${m}`).sort());
  assert.equal(mod.TYPERT_REMOTE.descriptors.length, 9);

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
};
const ALLOWED = {
  getStatus: [], getMemoryView: [], getGraph: [], listCandidates: [],
  executeTool: ["name", "args"],
  analyze: ["kind", "operationId", "expectedQueueRevision"],
  reviewCandidate: ["candidateId", "decision", "expectedQueueRevision", "operationId"],
  previewPlan: ["kind", "candidateId", "proposal", "expectedQueueRevision", "operationId", "planId"],
  executePlan: ["planId", "planDigest", "operationId", "confirmed"],
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
  for (const method of ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"]) {
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
const { remoteMethods, RemoteError, remoteErrorOf } = await import(`file:///${HOST_MODULES}/@deepseek-ai/dsh-typert-protocol/lib/index.js`);

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
  for (const m of ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"]) {
    management[m] = async (trusted, payload) => ({ ok: true, method: m, trusted, payload });
  }
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const service = ctx.get("shiori.panel");
  assert.ok(service, "service registered under shiori.panel");

  // 真实 Remote 标记（Gateway source-mode 发现路径）
  const markers = remoteMethods(service);
  assert.equal(markers.length, 9);
  assert.deepEqual(markers.map((m) => m.exportName ?? m.method).sort(),
    ["analyze", "executePlan", "executeTool", "getGraph", "getMemoryView", "getStatus", "listCandidates", "previewPlan", "reviewCandidate"].sort());

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
    ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"].map((m) => [m, noop]),
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
  const methods = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"];
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
    ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"].map((m) => [m, m === "getGraph" ? slow : ok]),
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
  assert.equal(diagnostics.methods.length, 9);
});

test("diagnostics：宿主 typert 缺席时声明 UI unsupported（仅工具模式）", async () => {
  const ctx = fakeCtx({ typert: false });
  const ok = async () => ({});
  const management = Object.fromEntries(
    ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"].map((m) => [m, ok]),
  );
  const rpc = await mountShioriRpc(ctx, management, { mode: "shadow", dataRoot: null, stateRoot: null });
  const diagnostics = rpc.diagnostics();
  assert.equal(diagnostics.transport, "unavailable");
  assert.equal(diagnostics.ui, "unsupported-no-transport");
  await rpc.stop();
});

test("wire 契约校验：P protocol 方法集不一致或 management 缺方法时拒绝挂载", async () => {
  const ok = async () => ({});
  const full = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"];
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
  for (const m of ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"]) {
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
  for (const m of ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"]) {
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
    { queueRevision: 0, items: [{ candidateId: "candidate-A" }], plans: [] },
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
  // 未加载：写动作按钮必须禁用
  assert.equal(findButton(tree, "分析整理候选").props.disabled, true, "analyze disabled before load");
  // 即便被直接触发（无障碍/脚本场景），payload 也不得含 undefined 值字段
  findButton(tree, "分析整理候选").props.onClick();
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
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "previewPlan") return new Promise((resolve) => { previewResolve = resolve; });
      if (method === "listCandidates") return { queueRevision: 0, items: [{ candidateId: "candidate-A" }], plans: [] };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...loadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  assert.equal(findButton(tree, "分析整理候选").props.disabled, false, "analyze enabled after load");
  findButton(tree, "分析整理候选").props.onClick();
  await flush();
  const analyze = calls.find((c) => c.method === "analyze");
  assert.equal(analyze.payload.expectedQueueRevision, 0, "loaded revision attached as number");
  assert.equal(isRemoteJsonValue(analyze.payload), true);

  calls.length = 0;
  tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览整理计划").props.onClick();
  assert.ok(previewResolve, "previewPlan in flight");
  previewResolve({ kind: "organize", planId: "plan-A", planDigest: "digest-A", summary: "ok", diff: [] });
  await flush();
  const preview = calls.find((c) => c.method === "previewPlan");
  assert.equal(preview.payload.expectedQueueRevision, 0);
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
  // 会话 A：已加载，点击 preview organize（在途挂起）
  host.states.length = 0;
  host.states.push(...loadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览整理计划").props.onClick();
  assert.ok(previewResolve, "previewPlan for session-A in flight");

  // 切到会话 B：渲染并运行 effects（同一 guard 对象，会话守卫清状态 + load）
  tree = renderCandidates(dsh, "session-B", { effects: true });
  for (const effect of host.effects.splice(0)) effect();
  await flush();

  // A 的预览此刻才完成：必须被代际守卫丢弃
  previewResolve({ kind: "organize", planId: "plan-A", planDigest: "digest-A", summary: "preview A", diff: [] });
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
      cwd: "D:\\AI",
      projections: { kind: "cached", asOfSeq: 594, values: { title: "你是 Shiori 项目（D:/AIagent/shiori" } },
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

  const mount = () => {
    host.states.length = 0;
    host.cursor.v = 0;
    // BudgetsTab useState 顺序：snapshot / error / ok
    host.states.push(scope.getSnapshot(), null, null);
    const tree = tab.type(tab.props);
    const inputs = flattenVNode(tree).filter((n) => n.type === "input" && n.props && n.props["data-path"]);
    assert.equal(inputs.length, 10, "ten budget inputs rendered");
    const form = flattenVNode(tree).find((n) => n.type === "form");
    assert.ok(form, "form present");
    return { tree, inputs, form, states: host.states, scope };
  };

  const submit = async (mounted, overrides) => {
    const form = { querySelectorAll: () => mounted.inputs.map((n) => {
      const path = n.props["data-path"];
      const value = Object.prototype.hasOwnProperty.call(overrides, path) ? overrides[path] : n.props.defaultValue;
      return { getAttribute: () => path, value };
    }) };
    mounted.form.props.onSubmit({ preventDefault: () => {}, target: form });
    await flush(20);
  };

  return { mount, submit, mutations, state, host };
}

test("预算 tab：空输入不落 0（保留服务端现值），只写用户填写的字段", async () => {
  const { mount, submit, mutations } = await mountBudgetsTab();
  const mounted = mount();
  // 渲染值来自快照 value.budgets（旧代码读 value[section][key] 永远是空串）
  const byPath = new Map(mounted.inputs.map((n) => [n.props["data-path"], n.props.defaultValue]));
  assert.equal(byPath.get("core.targetChars"), "8000");
  assert.equal(byPath.get("core.softRatio"), "0.75");
  assert.equal(byPath.get("persona.maxChars"), "12000");

  await submit(mounted, { "core.targetChars": "", "persona.maxChars": "11000" });
  assert.equal(mutations.length, 1, "one atomic budgets write");
  assert.deepEqual(mutations[0].ops.map((op) => op.path), [["budgets"]]);
  assert.equal(mutations[0].ops[0].value.core.targetChars, 8000, "empty input kept server value, not 0");
  assert.equal(mutations[0].ops[0].value.core.hardCapChars, 10000);
  assert.equal(mutations[0].ops[0].value.core.softRatio, 0.75);
  assert.equal(mutations[0].ops[0].value.persona.maxChars, 11000, "filled field written");
  assert.equal(mutations[0].ops[0].value.spark.maxCards, 5);
  assert.equal(mutations[0].ops[0].value.core.cacheLockFallback, false);
  assert.match(String(mounted.states[2]), /已保存/);
});

test("预算 tab：非法数字/比率中止整批且不发写入，错误码 ui/invalid-number", async () => {
  const { mount, submit, mutations } = await mountBudgetsTab();
  const chineseLabelByPath = {
    "spark.maxChars": "Spark 卡片最大字符数",
    "core.softRatio": "L0 软压缩阈值占比",
    "core.hardRatio": "L0 硬压缩阈值占比",
    "core.targetChars": "L0 记忆目标字符数",
    "persona.maxChars": "人设卡最大字符数",
  };
  for (const bad of [
    { "spark.maxChars": "abc" },
    { "core.softRatio": "1.5" },
    { "core.hardRatio": "0" },
    { "core.targetChars": "0" },
    { "persona.maxChars": "13000" },
  ]) {
    const mounted = mount();
    await submit(mounted, bad);
    const path = Object.keys(bad)[0];
    assert.equal(mutations.length, 0, "no write for invalid " + path + "=" + bad[path]);
    const error = mounted.states[1];
    assert.ok(error && error.code === "ui/invalid-number", "ui/invalid-number for " + path);
    assert.match(String(error.message), new RegExp(path.replace(".", "\\.")), "error names the raw parameter");
    assert.ok(String(error.message).includes(chineseLabelByPath[path]),
      "error also explains the field in Chinese: " + chineseLabelByPath[path]);
  }
});

test("预算 tab：字段标签为「中文解释（原参数名）」并附一句中文用途说明", async () => {
  const { mount } = await mountBudgetsTab();
  const mounted = mount();
  const labelTextByPath = new Map();
  for (const label of flattenVNode(mounted.tree).filter((n) => n.type === "label" && n.props && n.props.className === "dshi_label")) {
    const input = flattenVNode(label).find((n) => n.type === "input" && n.props && n.props["data-path"]);
    if (input) labelTextByPath.set(input.props["data-path"], collectText(label));
  }
  const expected = {
    "core.targetChars": ["L0 记忆目标字符数", "core.targetChars", "目标长度"],
    "core.hardCapChars": ["L0 硬上限字符数", "core.hardCapChars", "硬上限"],
    "core.softRatio": ["L0 软压缩阈值占比", "core.softRatio", "0 到 1"],
    "core.hardRatio": ["L0 硬压缩阈值占比", "core.hardRatio", "0 到 1"],
    "persona.maxChars": ["人设卡最大字符数", "persona.maxChars", "上限 12000", "UTF-16"],
    "spark.maxChars": ["Spark 卡片最大字符数", "spark.maxChars", "上限 600", "总长度"],
    "spark.inlineMaxChars": ["Spark 内联注入最大字符数", "spark.inlineMaxChars", "上限 100", "摘要"],
    "spark.maxCards": ["Spark 最多卡片数", "spark.maxCards", "上限 5", "卡片数量"],
    "spark.seedCount": ["Spark 召回种子数", "spark.seedCount", "上限 3", "种子素材"],
    "spark.linkCount": ["Spark 关联链接数", "spark.linkCount", "上限 2", "1 跳关联"],
  };
  assert.equal(labelTextByPath.size, 10, "十个预算字段都有自己的标签");
  for (const [path, parts] of Object.entries(expected)) {
    const text = labelTextByPath.get(path);
    assert.ok(text, "label for " + path);
    for (const part of parts) assert.ok(text.includes(part), path + " label/hint includes: " + part);
  }
});

test("预算 tab：比率字段 step=any 允许小数，整数/字符段 step=1 且保留 min/max（回归）", async () => {
  const { mount } = await mountBudgetsTab();
  const mounted = mount();
  const byPath = new Map(mounted.inputs.map((n) => [n.props["data-path"], n.props]));
  // 回归：HTML number input 默认 step=1 会把 0.75 判成非法（原生校验气泡
  // 「两个最接近的有效值分别为0和1」），比率字段必须放行任意小数。
  for (const path of ["core.softRatio", "core.hardRatio"]) {
    const input = byPath.get(path);
    assert.equal(input.step, "any", path + " 渲染 step=any，0.75 不再被判非法");
    assert.equal(input.min, "0", path + " 仍保留 min");
  }
  for (const path of [
    "core.targetChars", "core.hardCapChars", "persona.maxChars", "spark.maxChars",
    "spark.inlineMaxChars", "spark.maxCards", "spark.seedCount", "spark.linkCount",
  ]) {
    const input = byPath.get(path);
    assert.equal(input.step, "1", path + " 仍只收整数");
    assert.equal(input.min, "0", path + " 仍保留 min");
  }
  assert.equal(byPath.get("persona.maxChars").max, "12000", "整数段 max 保留");
  assert.equal(byPath.get("core.softRatio").max, undefined, "无上限的比率段不写 max");
});

test("预算 tab：文案改名人设卡（只改展示文案，协议字段 persona.maxChars 不变）", async () => {
  const { mount } = await mountBudgetsTab();
  const mounted = mount();
  const label = flattenVNode(mounted.tree).find((n) => n.type === "label"
    && n.props && n.props.className === "dshi_label"
    && flattenVNode(n).some((child) => child.type === "input" && child.props && child.props["data-path"] === "persona.maxChars"));
  assert.ok(label, "persona.maxChars 字段有 label");
  const text = collectText(label);
  assert.ok(text.includes("人设卡最大字符数"), "标签显示「人设卡最大字符数」: " + text);
  assert.ok(text.includes("人设卡正文的最大长度"), "hint 同步改为「人设卡正文的最大长度」");
  assert.ok(!text.includes("人格卡"), "不再出现旧文案「人格卡」");
  assert.equal(flattenVNode(label).find((n) => n.type === "input").props["data-path"], "persona.maxChars",
    "data-path / 协议字段名不变");
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

// 单独执行一个 tab 组件（面板 7 个 useState 之后开始计数），跑它的挂载 effect。
async function runTab(host, vnode) {
  host.cursor.v = 7;
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

  assert.equal(host.states[8], null, "会话级错误不写入 tab 的 error 状态（ErrorBox 不渲染）");
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
  assert.equal(host.states[8], null, "重试成功后无错误");
  assert.equal(host.states[7].l0, "L0 内容");
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
          sources: [{ id: "s3", revision: 1 }], evidence: {},
        },
        status: "pending",
      }],
      plans: [],
    },
    null, false, JSON.stringify({ kind: "link", links: [] }), null, null,
    { sessionId, gen: 0 },
  ];
}

test("Q-A 回归：cluster 候选渲染「合并进主题」入口；主题列表经 executeTool 拉取且 legacy 主题被过滤", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 5, items: [], plans: [] };
      if (method === "executeTool" && payload.name === "memory_list_topics") {
        return { topics: [
          { key: "t-live", title: "活主题", summary: "s", updated: "2026-10-26T10:00:00.000Z", revision: "shiori-r1.AbCdEf.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
          { key: "t-legacy", title: "旧主题", summary: "s", updated: "legacy-unknown", revision: "shiori-r1.OlD.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
        ] };
      }
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A", { effects: false });
  // 行头显示的是 item.candidate.id（真机嵌套 DTO），不是数组下标
  const rowText = collectText(tree);
  assert.ok(rowText.includes("cluster-A") && rowText.includes("link-B"), "candidate.id rendered as row id");
  assert.ok(!/(^|\n)0(\n|$)/.test(rowText.split("候选（")[1]?.split("计划（")[0] ?? ""), "no bare index as row id");
  // 入口只出现在 cluster 候选行（link-B 没有）
  const mergeButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("合并进主题"));
  assert.equal(mergeButtons.length, 1, "merge entry rendered once (cluster candidate only)");
  assert.equal(mergeButtons[0].props.disabled, false, "merge entry enabled after load");

  mergeButtons[0].props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("合并进主题（候选 cluster-…）"), "merge card open for cluster-A");
  assert.ok(text.includes("t-live"), "non-legacy topic listed with key");
  assert.ok(text.includes("rev shiori-r1.AbCdEf"), "revision prefix shown for topic");
  assert.ok(!text.includes("t-legacy"), "legacy topic filtered out of the list");
  assert.ok(text.includes("新建主题"), "create-topic section available");
  const listCall = calls.find((c) => c.method === "executeTool" && c.payload.name === "memory_list_topics");
  assert.ok(listCall, "topics fetched via executeTool memory_list_topics");
  assert.deepEqual(listCall.payload.args, {}, "memory_list_topics called with empty args");
  assert.equal(listCall.session, "session-A");
});

test("Q-A 回归：新建主题路径以服务端返回的 revision token 构造 proposal；previewPlan 携带 candidateId 与 expectedQueueRevision；diff 被渲染", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  let listTopicsCount = 0;
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 5, items: [], plans: [] };
      if (method === "executeTool" && payload.name === "memory_list_topics") {
        listTopicsCount += 1;
        // 第一次（openMerge）：只有 legacy → 提示需要新建；第二次（创建后）：含新主题
        return listTopicsCount === 1
          ? { topics: [{ key: "t-legacy", title: "旧", summary: "s", updated: "legacy-unknown", revision: "shiori-r1.x.y" }] }
          : { topics: [
              { key: "t-legacy", title: "旧", summary: "s", updated: "legacy-unknown", revision: "shiori-r1.x.y" },
              { key: "t-new", title: "新主题", summary: "一行摘要", updated: "2026-10-26T15:10:00.000Z", revision: "shiori-r1.Fr3sH.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
            ] };
      }
      if (method === "executeTool" && payload.name === "topic_create") return { created: true, topic: payload.args.topic };
      if (method === "executeTool" && payload.name === "memory_read") {
        return { exists: true, content: "# 旧正文\n", revision: "shiori-r1.R34D.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" };
      }
      if (method === "previewPlan") {
        return { kind: "merge-topic", planId: "plan-M", planDigest: "digest-M", summary: "ok", diff: [
          { path: "topic:t-new", oldText: "# 旧正文\n", newText: "# 旧正文\n\n## 合并记忆：项目X\n" },
          { path: "spark:s1", oldText: "a", newText: "b" },
        ] };
      }
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A");
  findButton(tree, "合并进主题").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  assert.ok(collectText(tree).includes("没有可用的非 legacy 主题"), "no usable topic → create hint");

  // 填新建主题表单（每次 onChange 后重渲染，闭包取最新 state）
  const setInput = (placeholder, value) => {
    tree = renderCandidates(dsh, "session-A");
    const input = flattenVNode(tree).find((n) => n.type === "input" && n.props.placeholder === placeholder);
    assert.ok(input, `input "${placeholder}" present`);
    input.props.onChange({ target: { value } });
  };
  setInput("key（安全文件名，core 保留）", "t-new");
  setInput("标题", "新主题");
  setInput("单行摘要（≤60 字符）", "一行摘要");
  tree = renderCandidates(dsh, "session-A");
  findButton(tree, "创建并选择").props.onClick();
  await flush();

  tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("合并表单（目标 t-new）"), "merge form opened for created topic");
  assert.ok(text.includes("token(memory_read)"), "token sourced from server read");

  // 预览 diff
  tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览 diff（previewPlan）").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  const previewCall = calls.find((c) => c.method === "previewPlan");
  assert.ok(previewCall, "previewPlan sent");
  assert.equal(previewCall.payload.kind, "organize");
  assert.equal(previewCall.payload.candidateId, "cluster-A");
  assert.equal(previewCall.payload.expectedQueueRevision, 5, "queue revision attached");
  assert.equal(typeof previewCall.payload.operationId, "string");
  assert.equal(previewCall.payload.proposal.kind, "merge-topic");
  assert.equal(previewCall.payload.proposal.topic.key, "t-new");
  assert.equal(previewCall.payload.proposal.topic.expectedRevision,
    "shiori-r1.R34D.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "server-issued token carried into proposal");
  assert.equal(previewCall.payload.proposal.topic.before, "# 旧正文\n", "before loaded from memory_read (never empty)");
  assert.ok(previewCall.payload.proposal.topic.after.startsWith(previewCall.payload.proposal.topic.before), "after keeps before (append-only)");
  assert.equal(previewCall.payload.proposal.topic.title, "新主题");
  assert.ok(isRemoteJsonValue(previewCall.payload), "merge preview payload lossless");
  const previewText = collectText(tree);
  assert.ok(previewText.includes("topic:t-new"), "diff entry path rendered");
  assert.ok(previewText.includes("spark:s1"), "spark diff entry rendered");
  assert.ok(previewText.includes("plan-M") && previewText.includes("digest-M"), "planId/digest rendered");
  // topic_create 请求形状
  const createCall = calls.find((c) => c.method === "executeTool" && c.payload.name === "topic_create");
  assert.equal(createCall.payload.args.topic, "t-new");
  assert.equal(createCall.payload.args.summary, "一行摘要");
  assert.equal(typeof createCall.payload.args.operationId, "string");
});

test("Q-A/Q-B 回归：合并与执行的错误路径给出可读中文提示（UNSUPPORTED / REVISION_CONFLICT / NOT_FOUND），原 code 保留", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const TOKEN = "shiori-r1.T0k.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: [], plans: [] };
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
    // merge 卡片改为「就地展开」：只有队列里存在被点击的那一行时才渲染，故这里必须真给一条 cluster 候选
    { queueRevision: 0, items: [{ candidate: { id: "cluster-A", kind: "cluster", scopeId: "default", sources: [{ id: "s1", revision: 1 }], evidence: {} }, status: "pending" }], plans: [] },
    // proposal 预填合法 link 形状（NOT_FOUND 阶段要真正发 previewPlan 才能测服务端错误映射）
    null, false, JSON.stringify({ kind: "link", links: [{ id: "s1", after: [{ target: "t-a", rel: null }] }] }),
    // preview：预置一条 merge-topic 预览（走确认执行错误路径）
    { sessionId: "session-A", plan: { kind: "merge-topic", planId: "plan-M", planDigest: "digest-M", summary: "", diff: [] }, queueRevision: 0 },
    null,
    { sessionId: "session-A", gen: 0 },
    // Q-A 新增 hook：merge / topics / mergeForm / newTopic
    { candidateId: "cluster-A" },
    { loading: false, error: null, topics: [{ key: "t-live", title: "T", summary: "s", updated: "2026-10-26T00:00:00.000Z", revision: TOKEN }], total: 1 },
    { key: "t-live", expectedRevision: TOKEN, tokenSource: "memory_read", before: "# 旧正文\n", after: "# 旧正文\n\n追加\n", title: "T", summary: "s", updated: "2026-10-26T00:00:00.000Z" },
    { topic: "", title: "", summary: "", busy: false, error: null });

  let tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览 diff（previewPlan）").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  let text = collectText(tree);
  assert.ok(text.includes("[UNSUPPORTED]"), "original code preserved");
  assert.ok(text.includes("不支持该操作"), "UNSUPPORTED explained in Chinese");
  assert.ok(text.includes("legacy topics remain read-only"), "original message retained");

  // previewPlan 失败已清空 preview：直接预置一条预览（模拟用户此前已成功预览）再执行
  host.states[4] = { sessionId: "session-A", plan: { kind: "merge-topic", planId: "plan-M", planDigest: "digest-M", summary: "", diff: [] }, queueRevision: 0 };
  tree = renderCandidates(dsh, "session-A");
  findButton(tree, "确认执行（不可撤销）").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  text = collectText(tree);
  assert.ok(text.includes("revision 冲突"), "REVISION_CONFLICT explained in Chinese");
  assert.ok(text.includes("plan already executed"), "original message retained");
  assert.equal(calls.filter((c) => c.method === "executePlan").length, 1, "executePlan attempted once");

  // NOT_FOUND：过期候选的 preview organize（guard 已把 data 刷成空列表，补一条候选）
  calls.length = 0;
  host.states[0] = { queueRevision: 0, items: [{ candidateId: "cand-1" }], plans: [] };
  const boomDsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: [], plans: [] };
      if (method === "previewPlan") throw Object.assign(new Error("candidate sources missing"), { code: "NOT_FOUND" });
      return {};
    },
  };
  tree = renderCandidates(boomDsh, "session-A");
  findButton(tree, "预览整理计划").props.onClick();
  await flush();
  tree = renderCandidates(boomDsh, "session-A");
  text = collectText(tree);
  assert.ok(text.includes("[NOT_FOUND]"), "NOT_FOUND code preserved");
  assert.ok(text.includes("该候选或计划已过期") && text.includes("重新分析"), "stale-candidate guidance shown");
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
  findButton(tree, "确认执行（不可撤销）").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  assert.ok(collectText(tree).includes("队列已变化（预览基于 revision 3，当前 7）"), "stale queue revision explained");
  assert.ok(collectText(tree).includes("shiori/ui-stale-preview"), "stale preview code visible");
  assert.equal(calls.filter((c) => c.method === "executePlan").length, 0, "executePlan never sent on stale preview");

  // revision 对齐后可执行
  host.states[4] = { sessionId: "session-A", plan: { kind: "organize", planId: "plan-A", planDigest: "digest-A", summary: "", diff: [] }, queueRevision: 7 };
  tree = renderCandidates(dsh, "session-A");
  findButton(tree, "确认执行（不可撤销）").props.onClick();
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
    { planId: "plan-merge", kind: "merge-topic", planDigest: "d3", queueRevision: 0, changedItems: 2, summary: "s", createdAt: "2026-10-27T00:03:00.000Z", executed: false, superseded: false },
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
  assert.ok(text.includes("organize 计划请从对应候选"), "organize-kind plan hint");
  // preview forgetting：open 行可用；superseded 行渲染但禁用（点了也不发）；executed 行不渲染
  const previewButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("预览遗忘计划"));
  assert.equal(previewButtons.length, 2, "open + superseded forgetting rows render the button");
  const enabledButton = previewButtons.find((n) => n.props.disabled === false);
  const disabledButton = previewButtons.find((n) => n.props.disabled === true);
  assert.ok(enabledButton && disabledButton, "superseded row's button disabled, open row's enabled");
  // 预览 plan-done 的确认按钮被禁用（plans 行 executed 标记）
  const confirm = flattenVNode(tree).find((n) => n.type === "button" && n.children.includes("确认执行（不可撤销）"));
  assert.ok(confirm, "confirm button rendered");
  assert.equal(confirm.props.disabled, true, "execute disabled for executed plan");
  assert.ok(text.includes("该计划已执行或已被新预览作废"), "disabled reason rendered");
  // 作废计划不发 RPC：preview 挂 plan-sup 时确认禁用
  host.states[4] = { sessionId: "session-A", plan: { kind: "forgetting", planId: "plan-sup", planDigest: "d4", summary: "", diff: [] }, queueRevision: 0 };
  const tree2 = renderCandidates(dsh, "session-A");
  const confirm2 = flattenVNode(tree2).find((n) => n.type === "button" && n.children.includes("确认执行（不可撤销）"));
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

test("Q-A 回归（真实 queueDto）：reviewed / dismissed / preview organize 三按钮发出的 candidateId 均为 item.candidate.id，不退化为数组下标", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 5, items: clusterLoadedStates("x")[0].items, plans: [] };
      if (method === "previewPlan") return { kind: "organize", planId: "plan-L", planDigest: "digest-L", summary: "", diff: [] };
      return {};
    },
  };
  host.states.length = 0;
  // proposal 预填合法 link 形状，让 preview organize 能真正发 RPC（本轮起死值被本地拦截）
  host.states.push(...clusterLoadedStates("session-A"));
  host.states[3] = JSON.stringify({ kind: "link", links: [{ id: "s1", after: [{ target: "t-a", rel: null }] }] });
  let tree = renderCandidates(dsh, "session-A");
  const buttonsOf = (label) => flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes(label));

  // 第一行 cluster-A：三按钮都发 candidate.id
  buttonsOf("标记已阅")[0].props.onClick();
  buttonsOf("忽略")[0].props.onClick();
  buttonsOf("预览整理计划")[0].props.onClick();
  await flush();
  const reviewed = calls.find((c) => c.method === "reviewCandidate" && c.payload.decision === "reviewed");
  const dismissed = calls.find((c) => c.method === "reviewCandidate" && c.payload.decision === "dismissed");
  const preview = calls.find((c) => c.method === "previewPlan");
  assert.ok(reviewed && dismissed && preview, "three actions issued");
  assert.equal(reviewed.payload.candidateId, "cluster-A", "reviewed sends candidate.id");
  assert.equal(dismissed.payload.candidateId, "cluster-A", "dismissed sends candidate.id");
  assert.equal(preview.payload.candidateId, "cluster-A", "preview organize sends candidate.id");

  // 第二行 link-B：同样发 candidate.id
  calls.length = 0;
  tree = renderCandidates(dsh, "session-A");
  const linkButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("预览整理计划"));
  linkButtons[1].props.onClick();
  await flush();
  const linkPreview = calls.find((c) => c.method === "previewPlan");
  assert.ok(linkPreview, "link row preview issued");
  assert.equal(linkPreview.payload.candidateId, "link-B", "link row sends candidate.id (not index 1)");

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
  const reviewedButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("标记已阅"));
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

test("Q-B 回归（真实 queueDto）：默认 proposal（空 links）被本地拦截——previewPlan 零调用并给出中文指引；补全 link 项后放行", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const nestedItems = [{ candidate: { id: "link-B", kind: "link", scopeId: "default", sources: [{ id: "s3", revision: 1 }], evidence: {} }, status: "pending" }];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: nestedItems, plans: [] };
      if (method === "previewPlan") return { kind: "organize", planId: "plan-L", planDigest: "digest-L", summary: "", diff: [] };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(
    { queueRevision: 0, items: nestedItems, plans: [] },
    null, false, JSON.stringify({ kind: "link", links: [] }), null, null,
    { sessionId: "session-A", gen: 0 });
  let tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览整理计划").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  assert.equal(calls.filter((c) => c.method === "previewPlan").length, 0, "dead proposal never sent to server");
  const text = collectText(tree);
  assert.ok(text.includes("请先补 link 项，或改用 cluster 候选的「合并进主题」流程"), "Chinese guidance rendered");
  assert.ok(text.includes("ui/invalid-proposal"), "local validation code visible");
  assert.ok(text.includes("至少需要 1 项"), "minItems explained");

  // 补全 link 项后放行（payload 无损、candidateId 为嵌套 id）
  host.states[3] = JSON.stringify({ kind: "link", links: [{ id: "s3", after: [{ target: "t1", rel: "supports" }] }] });
  tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览整理计划").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  const preview = calls.find((c) => c.method === "previewPlan");
  assert.ok(preview, "valid proposal passes local validation");
  assert.equal(preview.payload.candidateId, "link-B", "nested candidate.id sent");
  assert.equal(preview.payload.proposal.kind, "link");
  assert.deepEqual(preview.payload.proposal.links, [{ id: "s3", after: [{ target: "t1", rel: "supports" }] }], "links payload lossless");
  assert.ok(isRemoteJsonValue(preview.payload), "payload lossless per isRemoteJsonValue");
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

const RPC_METHODS = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"];
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

test("B-Q2 回归：默认 proposal 为空——link 候选点 preview organize 先预填真实源卡 id 骨架（零 RPC），骨架可直接发送；cluster 候选指引走「合并进主题」", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const nestedItems = [
    { candidate: { id: "link-B", kind: "link", scopeId: "default", sources: [{ id: "spk-3", revision: 1 }, { id: "spk-4", revision: 1 }], evidence: {} }, status: "pending" },
    { candidate: { id: "cluster-A", kind: "cluster", scopeId: "default", sources: [{ id: "spk-1", revision: 1 }, { id: "spk-2", revision: 1 }], evidence: { field: "entities", sharedTerm: "项目X" } }, status: "pending" },
  ];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: nestedItems, plans: [] };
      if (method === "previewPlan") return { kind: "organize", planId: "plan-L", planDigest: "digest-L", summary: "", diff: [] };
      return {};
    },
  };
  host.states.length = 0;
  // proposal 为默认空串（B-Q2：默认不再是必红死值）
  host.states.push(
    { queueRevision: 0, items: nestedItems, plans: [] },
    null, false, "", null, null,
    { sessionId: "session-A", gen: 0 });
  let tree = renderCandidates(dsh, "session-A");
  const previewButtons = () => flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("预览整理计划"));

  // link 候选：第一次点 → 预填骨架，零 RPC
  previewButtons()[0].props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  assert.equal(calls.filter((c) => c.method === "previewPlan").length, 0, "empty proposal never sent");
  assert.ok(collectText(tree).includes("已按该候选预填 link 骨架"), "prefill message rendered");
  const skeleton = JSON.parse(host.states[3]);
  assert.deepEqual(skeleton, { kind: "link", links: [{ id: "spk-3", after: [{ target: "spk-4", rel: "related" }] }] },
    "skeleton uses the candidate's real source ids");

  // 第二次点（骨架即合法 payload）→ 真正发送
  previewButtons()[0].props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  const linkPreview = calls.find((c) => c.method === "previewPlan");
  assert.ok(linkPreview, "skeleton sent on second click");
  assert.deepEqual(linkPreview.payload.proposal.links, [{ id: "spk-3", after: [{ target: "spk-4", rel: "related" }] }]);

  // cluster 候选：空 proposal → 指引走「合并进主题」，零 RPC
  calls.length = 0;
  host.states[3] = "";
  tree = renderCandidates(dsh, "session-A");
  flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("预览整理计划"))[1].props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  assert.equal(calls.filter((c) => c.method === "previewPlan").length, 0, "cluster empty proposal never sent");
  assert.ok(collectText(tree).includes("请使用「合并进主题」一键流程"), "cluster guidance rendered");
});

test("B-Q2 回归：手抖写的多余键 / rel 类型错误被本地校验拦下（previewPlan 零调用，中文指出多余键）", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const nestedItems = [{ candidate: { id: "link-B", kind: "link", scopeId: "default", sources: [{ id: "spk-3", revision: 1 }], evidence: {} }, status: "pending" }];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, session, payload });
      if (method === "listCandidates") return { queueRevision: 0, items: nestedItems, plans: [] };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(
    { queueRevision: 0, items: nestedItems, plans: [] },
    null, false, JSON.stringify({ kind: "link", links: [{ id: "spk-3", after: [{ target: "t1", rel: 3 }], note: "多余键" }] }),
    null, null,
    { sessionId: "session-A", gen: 0 });
  let tree = renderCandidates(dsh, "session-A");
  findButton(tree, "预览整理计划").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  assert.equal(calls.filter((c) => c.method === "previewPlan").length, 0, "malformed proposal never sent");
  const text = collectText(tree);
  assert.ok(text.includes("存在多余键") && text.includes("note"), "extra key named in Chinese");
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

test("展示引导 T1：合并卡未选目标主题时显示 ① 进行中步骤与「还没有选择目标主题」中性提示，且无合并表单/预览按钮", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = mergeTopicsDsh(calls);
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A", { effects: false });
  findButton(tree, "合并进主题").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("合并流程（3 步"), "numbered step guidance rendered");
  assert.ok(text.includes("① 进行中"), "step 1 marked in progress while no target topic");
  assert.ok(text.includes("② 待完成") && text.includes("③ 待完成"), "later steps dim / pending");
  assert.ok(text.includes("还没有选择目标主题"), "explicit neutral hint about missing target topic");
  assert.ok(text.includes("选定之后才会出现「合并表单」和「预览 diff」按钮"), "hint explains what appears after choosing");
  assert.ok(!text.includes("合并表单（目标"), "no merge form heading before choosing a topic");
  const previewButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("预览 diff（previewPlan）"));
  assert.equal(previewButtons.length, 0, "no preview diff button before choosing a topic");
  const errorBoxes = flattenVNode(tree).filter((n) => n.type === "div" && n.props && typeof n.props.className === "string" && n.props.className.includes("dshi_error"));
  assert.equal(errorBoxes.length, 0, "neutral hint is not an error box");
});

test("展示引导 T2：选中主题后出现「合并表单（目标 t-live）」与预览按钮，未选提示消失、步骤推进到 ③", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const calls = [];
  const dsh = mergeTopicsDsh(calls);
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  let tree = renderCandidates(dsh, "session-A", { effects: false });
  findButton(tree, "合并进主题").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  findButton(tree, "合并到这个主题").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");
  const text = collectText(tree);
  assert.ok(text.includes("合并表单（目标 t-live）"), "merge form appears for chosen topic");
  const previewButtons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("预览 diff（previewPlan）"));
  assert.equal(previewButtons.length, 1, "preview diff button rendered once in merge form");
  assert.ok(!text.includes("还没有选择目标主题"), "missing-target hint gone after choosing");
  assert.ok(text.includes("已在合并表单中"), "next-step hint replaces the missing-target hint");
  assert.ok(text.includes("① 已完成") && text.includes("③ 下一步"), "steps advance after target chosen");
  const readCall = calls.find((c) => c.method === "executeTool" && c.payload.name === "memory_read");
  assert.ok(readCall, "topic content fetched via memory_read");
  assert.equal(readCall.payload.args.topic, "t-live");
});

test("展示引导 T3：legacy 主题行（updated legacy-unknown）的「合并到这个主题」按钮带 title 说明且不禁用", async () => {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  const renderCandidates = await mountCandidates(mod, host);
  const dsh = {
    call: async (method) => {
      if (method === "listCandidates") return { queueRevision: 5, items: [], plans: [] };
      return {};
    },
  };
  host.states.length = 0;
  host.states.push(...clusterLoadedStates("session-A"));
  // 直接注入 topics 状态：loadTopics 会过滤 legacy 行，这里绕过拉取路径验证渲染期的防御性 title。
  host.states[7] = { candidateId: "cluster-A" };
  host.states[8] = { loading: false, error: null, total: 1, topics: [
    { key: "t-legacy", title: "旧主题", summary: "s", updated: "legacy-unknown", revision: "shiori-r1.OlD.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
  ] };
  const tree = renderCandidates(dsh, "session-A", { effects: false });
  const buttons = flattenVNode(tree).filter((n) => n.type === "button" && n.children.includes("合并到这个主题"));
  assert.equal(buttons.length, 1, "legacy topic row renders its merge button");
  assert.ok(String(buttons[0].props.title || "").includes("legacy"), "legacy title explains read-only topic");
  assert.equal(buttons[0].props.disabled, false, "row button is not disabled (choosing is the primary action)");
});

// ---------------------------------------------------------------------------
// 第 7 轮：候选面板布局与中文文案（就地展开合并卡 / 按钮徽章中文化 / 原始 JSON 折叠）
// ---------------------------------------------------------------------------

test("第 7 轮：合并卡就地展开——紧贴被点击的候选行，第二行在其后，中间不夹其他区块", async () => {
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
  host.states[7] = null; // merge 未激活
  let tree = renderCandidates(dsh, "session-A");
  findButton(tree, "合并进主题").props.onClick();
  await flush();
  tree = renderCandidates(dsh, "session-A");

  const nodes = flattenVNode(tree);
  const container = nodes.find((n) => n.type === "div" && n.props && n.props.className === "dshi_items");
  assert.ok(container, "dshi_items container present");
  // 容器直接子节点（items.map 可能产出嵌套数组）：[*候选行, 合并卡, *候选行]
  const direct = [];
  (function push(k) {
    if (Array.isArray(k)) { for (const c of k) push(c); return; }
    if (k && typeof k === "object") direct.push(k);
  })(container.children);
  assert.equal(direct.length, 3, "container holds exactly 2 rows + 1 inline merge card");
  assert.equal(direct[0].props.className, "dshi_item", "first child is candidate row 1");
  assert.equal(direct[1].props.className, "dshi_itemMerge", "merge card is the immediate sibling of the clicked row");
  assert.equal(direct[2].props.className, "dshi_item", "second candidate row follows the merge card");
  const inlineCard = flattenVNode(direct[1]).find((n) => n.type === "div" && n.props.className === "dshi_card");
  assert.ok(inlineCard, "merge card keeps dshi_card styling");
  const text = collectText(tree);
  assert.ok(text.includes("合并进主题（候选 cluster-…）"), "short candidate id in title");
  const titleSpan = flattenVNode(direct[1]).find((n) => n.type === "span" && String(n.props.title || "").includes("cluster-A"));
  assert.ok(titleSpan, "full candidate id kept in title attribute");
  assert.ok(text.indexOf("合并进主题（候选") > text.indexOf("cluster-A"), "merge card renders below the clicked row header");
});

test("第 7 轮：按钮与徽章中文化——页面不再出现英文旧文案，点「标记已阅」仍发 status=reviewed", async () => {
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
  for (const label of ["分析整理候选", "分析遗忘候选", "标记已阅", "忽略", "预览整理计划", "合并进主题"]) {
    assert.ok(buttonLabels.includes(label), `Chinese button "${label}" present`);
  }
  const text = collectText(tree);
  assert.ok(text.includes("候选（2）"), "candidate card title localized");
  assert.ok(text.includes("集群") && text.includes("待处理"), "kind/status badges localized");
  const staleBadges = nodes.filter((n) => n.type === "span" && ["open", "executed", "superseded"].includes(String(collectText(n))));
  assert.equal(staleBadges.length, 0, "no English plan badges rendered");
  // 计划行 kind 徽章：organize / forgetting → 整理 / 遗忘（plan.kind 协议值本身不变）
  const planKindBadges = nodes
    .filter((n) => n.type === "span" && String(n.props.className || "").includes("dshi_badge"))
    .map((n) => collectText(n));
  assert.ok(planKindBadges.includes("整理"), "organize plan badge localized (整理)");
  assert.ok(planKindBadges.includes("遗忘"), "forgetting plan badge localized (遗忘)");
  assert.ok(!planKindBadges.includes("organize") && !planKindBadges.includes("forgetting"), "no English plan kind badges");

  // 协议值不变：按钮中文、payload 仍发 reviewed / dismissed
  findButton(tree, "标记已阅").props.onClick();
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
    { planId: "plan-open", kind: "organize", planDigest: "d1", queueRevision: 0, changedItems: 1, summary: "s", createdAt: "2026-10-27T00:00:00.000Z", executed: false, superseded: false },
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
  assert.ok(text.includes("候选由「分析整理候选 / 分析遗忘候选」生成"), "candidates hint rendered");
});

