// P5 · 真实宿主契约测试（slot P）。
//
// 契约（CONTRACTS §8）：真实 DSH 0.2.1-rc.2 工具 runner 必须检查全部成功输出
// （特别 topic_append 写成功后返回成功）；禁止只 mock defineTool 成功就称输出
// 校验通过。本文件用本机已安装的真实 @deepseek-ai/dsh-tools：
// - 真实 defineTool 编译 16 工具的 output schema（assertSupportedJsonSchema 子集
//   检查在 defineTool 内部执行——schema 非法即抛错）；
// - 真实 validateJsonSchemaValue（与 runner createSuccessResult 同一校验函数，
//   dsh-tools lib/index.js:3640）逐工具校验成功输出；
// - topic_append 写成功后经真实 schema 校验返回成功（实机报告的原始缺陷路径）。
//
// 发现策略：DSH_TOOLS_PATH 环境变量 → bare import → 全局 npm root（只读）。
// 找不到真实包时 skip 并如实标注（RESULT.json 记 not-run，不冒称通过）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

import { createShioriService } from "../../src/service/index.mjs";
import { createPersonaAdapter } from "../../src/plugin/persona.mjs";
import { openSparkStore } from "../../src/sparks/store.mjs";
import { createCompatTools, createTopicCreateTool } from "../../src/host/tools.mjs";
import { createSparkTools } from "../../src/sparks/tools.mjs";
import { TOOL_NAMES, TOOL_OUTPUT_SCHEMAS, renderToolOutput } from "../../src/plugin/tool-schemas.mjs";
import { createDshBindings } from "../../src/plugin/bindings.mjs";
import { registerShioriTypert } from "../../src/plugin/typert-descriptors.mjs";
import { MANAGEMENT_METHODS } from "../../src/plugin/protocol.mjs";

const GLOBAL_DSH_TOOLS = process.env.APPDATA
  ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-tools", "lib", "index.js")
  : null;
const GLOBAL_DSH_TYPERT_REGISTRY = process.env.APPDATA
  ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "dsh-typert-registry", "lib", "types", "service.js")
  : null;

async function loadTypertRegistry() {
  try {
    return await import("@deepseek-ai/dsh-typert-registry/lib/types/service.js");
  } catch {
    if (GLOBAL_DSH_TYPERT_REGISTRY && existsSync(GLOBAL_DSH_TYPERT_REGISTRY)) {
      return import(pathToFileURL(GLOBAL_DSH_TYPERT_REGISTRY).href);
    }
    return null;
  }
}

let dshTools = null;
try {
  dshTools = process.env.DSH_TOOLS_PATH
    ? await import(pathToFileURL(process.env.DSH_TOOLS_PATH).href)
    : await import("@deepseek-ai/dsh-tools");
} catch {
  if (GLOBAL_DSH_TOOLS && existsSync(GLOBAL_DSH_TOOLS)) {
    dshTools = await import(pathToFileURL(GLOBAL_DSH_TOOLS).href);
  }
}

test("真实 defineTool：16 工具 output schema 编译（子集非法即抛）+ 真实 runner 校验函数验证成功输出", async (t) => {
  if (!dshTools) {
    t.skip("real @deepseek-ai/dsh-tools not resolvable on this machine (RESULT.json marks this check not-run)");
    return;
  }
  const { defineTool, validateJsonSchemaValue } = dshTools;
  assert.equal(typeof defineTool, "function");
  assert.equal(typeof validateJsonSchemaValue, "function");

  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-host-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dataRoot = path.join(base, "data");
  const personaAdapter = createPersonaAdapter({ dir: path.join(dataRoot, "persona"), scopeId: "amber", maxChars: 12000 });
  const service = await createShioriService({ root: dataRoot, activeScopeId: "amber", personaAdapter });
  const sparkStore = await openSparkStore({ root: dataRoot, scopeId: "amber" });
  const tools = [
    ...createCompatTools({ service, getSessionInfo: () => ({ sessionId: null, scopeId: "amber" }) }),
    createTopicCreateTool({ service, getSessionInfo: () => ({ sessionId: null, scopeId: "amber" }) }),
    ...createSparkTools({ scopeId: "amber", store: sparkStore }).tools,
  ];
  assert.equal(tools.length, 16);
  assert.deepEqual(tools.map((x) => x.name).sort(), [...TOOL_NAMES].sort());

  const compiled = new Map();
  for (const tool of tools) {
    // 真实 defineTool：output schema 子集检查（assertSupportedJsonSchema）在此发生。
    const defined = defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      isConcurrencySafe: () => false,
      async execute(args) { return tool.execute(args, { agent: { session: { id: "s-real" } } }); },
      output: {
        schema: TOOL_OUTPUT_SCHEMAS[tool.name],
        // 缺陷 A 修复点：render 返回 content block 数组（宿主把它直接当 result.content）。
        render: renderToolOutput,
      },
    });
    assert.equal(defined.name, tool.name);
    compiled.set(tool.name, defined);
  }
  assert.equal(compiled.size, 16);

  // 真实 defineTool 保留 output.render：对每个工具断言返回值形状（数组 / text block /
  // 可 JSON 还原原 value）——宿主 createSuccessResult 直接吃这个返回值。
  for (const [name, defined] of compiled) {
    const blocks = defined.output.render({}, { probe: name, items: [1, 2] });
    assert.ok(Array.isArray(blocks), `${name}: output.render must return a content block array`);
    assert.ok(blocks.length >= 1, `${name}: render must return at least one block`);
    for (const block of blocks) assert.equal(block.type, "text", `${name}: every block must be type "text"`);
    assert.deepEqual(JSON.parse(blocks[0].text), { probe: name, items: [1, 2] }, `${name}: render payload must round-trip`);
  }

  // ── 成功路径：真实执行 + 真实校验函数（runner createSuccessResult 同款）──
  // 1) topic_create 写成功 → 返回成功（不被 schema 拒收）。
  const created = await compiled.get("topic_create").execute(
    { topic: "host-contract", title: "Host Contract", summary: "created in real runner test" },
    { agent: { session: { id: "s-real" } } },
  );
  assert.equal(created.created, true);
  assert.deepEqual(validateJsonSchemaValue(compiled.get("topic_create").output.schema, created, "value"), []);

  // 2) topic_append 写成功 → 返回成功（实机报告原始缺陷：写生效但回执被
  //    additionalProperties:false 拒收为失败）。
  const appended = await compiled.get("topic_append").execute(
    { topic: "host-contract", section: "第一节", content: "真实 runner 校验的追加内容。" },
    { agent: { session: { id: "s-real" } } },
  );
  assert.equal(appended.projection, "written-pending-projection");
  assert.ok(Array.isArray(appended.changes) && appended.changes.length === 1);
  assert.deepEqual(validateJsonSchemaValue(compiled.get("topic_append").output.schema, appended, "value"), []);

  // 3) 4 个只读工具（实机报告全部被拒收的路径）。
  const readCases = [
    ["soul_read", {}],
    ["memory_read", { topic: "host-contract" }],
    ["memory_list_topics", {}],
    ["memory_search", { query: "runner" }],
  ];
  for (const [name, args] of readCases) {
    const value = await compiled.get(name).execute(args, { agent: { session: { id: "s-real" } } });
    const violations = validateJsonSchemaValue(compiled.get(name).output.schema, value, "value");
    assert.deepEqual(violations, [], `${name} output must pass the real runner schema: ${JSON.stringify(violations)}`);
  }

  // 4) 全部 16 工具成功输出逐一过真实校验（读分支走真实读；写分支走真实 CAS 写）。
  const sparkSaved = await compiled.get("spark_save").execute(
    { title: "真实卡", content: "内容。", triggers: ["真实词"], vitality: "evergreen" },
    { agent: { session: { id: "s-real" } } },
  );
  assert.deepEqual(validateJsonSchemaValue(compiled.get("spark_save").output.schema, sparkSaved, "value"), []);

  const successCases = [
    ["soul_update", { content: "# 新卡\n真实内容。" }],
    ["memory_read", {}],
    ["memory_append", { section: "段", content: "追加正文。" }],
    ["memory_rewrite", { content: "重写正文。" }],
    ["core_write", null], // revision 动态获取
    ["spark_read", null],
    ["spark_update", null],
    ["spark_graph", {}],
  ];
  for (const [name, args] of successCases) {
    let payload = args;
    if (name === "core_write") { const fresh = await compiled.get("memory_read").execute({}, { agent: { session: { id: "s-real" } } }); payload = { content: "core 真实写入。", expectedRevision: fresh.revision }; }
    if (name === "spark_read") payload = { id: sparkSaved.id };
    if (name === "spark_update") payload = { id: sparkSaved.id, patch: { summary: "补摘要" } };
    const value = await compiled.get(name).execute(payload, { agent: { session: { id: "s-real" } } });
    const violations = validateJsonSchemaValue(compiled.get(name).output.schema, value, "value");
    assert.deepEqual(violations, [], `${name} output must pass the real runner schema: ${JSON.stringify(violations)}`);
  }

  // spark_forget / spark_feedback / spark_forget(supersede) 需要两张卡。
  const second = await compiled.get("spark_save").execute(
    { title: "第二张", content: "替代内容。", triggers: ["第二词"], vitality: "ephemeral" },
    { agent: { session: { id: "s-real" } } },
  );
  const superseded = await compiled.get("spark_forget").execute(
    { id: second.id, mode: "supersede", replacementId: sparkSaved.id },
    { agent: { session: { id: "s-real" } } },
  );
  assert.deepEqual(validateJsonSchemaValue(compiled.get("spark_forget").output.schema, superseded, "value"), []);
  // feedback 必须在归档前（active-only）。
  const feedback = await compiled.get("spark_feedback").execute(
    { id: sparkSaved.id, used: true, sourceEventId: "evt-real-1" },
    { agent: { session: { id: "s-real" } } },
  );
  assert.deepEqual(validateJsonSchemaValue(compiled.get("spark_feedback").output.schema, feedback, "value"), []);
  // 承接替代关系的卡不能被归档（替代链不允许嵌套）；用第三张卡验证 archive。
  const third = await compiled.get("spark_save").execute(
    { title: "第三张", content: "要归档的内容。", triggers: ["第三词"], vitality: "ephemeral" },
    { agent: { session: { id: "s-real" } } },
  );
  const archived = await compiled.get("spark_forget").execute(
    { id: third.id, mode: "archive" },
    { agent: { session: { id: "s-real" } } },
  );
  assert.deepEqual(validateJsonSchemaValue(compiled.get("spark_forget").output.schema, archived, "value"), []);

  sparkStore.close();
});

test("render 形状契约：renderToolOutput 与 bindings 注册给宿主的 output.render 都必须返回 content block 数组（缺陷 A）", async () => {
  // 1) 纯函数契约：数组 → 每项 type:"text" → 首项 text JSON 可还原原 value。
  const value = { ok: true, items: [1, 2], note: "中文" };
  const blocks = renderToolOutput({}, value);
  assert.ok(Array.isArray(blocks), "renderToolOutput must return an array");
  assert.ok(blocks.length >= 1, "renderToolOutput must return at least one block");
  for (const block of blocks) {
    assert.equal(typeof block, "object");
    assert.equal(block.type, "text");
    assert.equal(typeof block.text, "string");
  }
  assert.deepEqual(JSON.parse(blocks[0].text), value);

  // 2) bindings 注册：宿主 defineTool 收到的 output.render 同样返回数组（含兜底分支）。
  const captured = [];
  const fakeCtx = {
    systemPrompt: { section: () => () => {} },
    tools: {
      register: (def) => {
        captured.push(def);
        return () => {};
      },
    },
    on: () => () => {},
  };
  const bindings = createDshBindings(fakeCtx, {}, {
    // 注入 stub loader：只捕获 defineTool 的入参，不需要真实 dsh-tools 包。
    loadDshTools: async () => ({
      defineTool: (options) => ({
        name: options.name,
        output: { schema: options.output.schema, render: options.output.render },
      }),
    }),
  });
  const baseTool = {
    name: "shape_probe",
    description: "render 形状探测",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
    async execute() { return { ok: true }; },
  };
  await bindings.registerTool(baseTool); // 无 outputRender → 走 bindings 兜底
  await bindings.registerTool({
    ...baseTool,
    name: "shape_probe_explicit",
    outputRender: (_args, out) => [{ type: "text", text: JSON.stringify(out) }, { type: "text", text: "trailer" }],
  });
  assert.equal(captured.length, 2);

  const fallback = captured[0].output.render({}, { ok: true });
  assert.ok(Array.isArray(fallback), "bindings fallback render must return an array");
  assert.equal(fallback[0].type, "text");
  assert.deepEqual(JSON.parse(fallback[0].text), { ok: true });

  const explicit = captured[1].output.render({}, { ok: false });
  assert.ok(Array.isArray(explicit));
  assert.deepEqual(explicit, [{ type: "text", text: JSON.stringify({ ok: false }) }, { type: "text", text: "trailer" }]);

  bindings.disposeAll();
});


// ─────────────────────────────────────────────────────────────
// a4 回归（P-C Gateway 严格 codec 描述符；真实 dsh-typert-registry）
// ─────────────────────────────────────────────────────────────

/** 最小 cordis ctx（generator effect 语义；足够 TypertRegistry/lookups.register 运行）。 */
function fakeTypertCtx() {
  const services = new Map();
  const ctx = {
    reflect: { props: {}, provide(name, value) { services.set(name, value); } },
    effect(genFn) {
      const it = genFn.call({});
      const first = it.next();
      return () => {
        if (!first.done && first.value) {
          try { first.value(); } catch { /* 清理失败不传播 */ }
        }
      };
    },
    on() { return () => {}; },
    inject() {},
    get(key) { return services.get(key); },
    logger: { warn() {} },
  };
  return { ctx, services };
}

test("P-C 严格描述符：真实 TypertRegistry 接受 9 端点注册 → local.get 全 strict；dispose→hasSeen→重注册；重复注册 adopt；无 typert 回退 SRC", async (t) => {
  const registryMod = await loadTypertRegistry();
  if (!registryMod) {
    t.skip("real @deepseek-ai/dsh-typert-registry not resolvable on this machine (RESULT.json marks this check not-run)");
    return;
  }
  const TypertRegistry = registryMod.default;
  const { ctx } = fakeTypertCtx();
  const typert = new TypertRegistry(ctx);
  ctx.typert = typert;
  // 宿主 dsh-session lib/index.js:1741 同形状的 session lookup provider。
  typert.lookups.register("session", {
    parameter: "session",
    wire: "sessionId",
    resource: "session",
    hostTypeSymbol: "@deepseek-ai/dsh-session#Session",
    wireTypeSymbol: "@deepseek-ai/dsh-session/types#SessionId",
    resolve: async (sessionId) => ({ id: sessionId }),
  });

  const reg = registerShioriTypert(ctx);
  assert.equal(reg.codec, "strict");
  assert.equal(reg.reason, null);
  assert.equal(typeof reg.disposer, "function");

  const methods = Object.keys(MANAGEMENT_METHODS);
  assert.equal(methods.length, 9);
  for (const method of methods) {
    const descriptor = typert.local.get(`shiori/${method}`);
    assert.ok(descriptor, `endpoint shiori/${method} must be registered`);
    assert.equal(descriptor.service, "shiori.panel");
    assert.equal(descriptor.namespace, "shiori");
    assert.equal(descriptor.method, method);
    assert.equal(descriptor.invocation.kind, "direct");
    assert.equal(descriptor.result.mode, "strict");
    assert.equal(descriptor.parameters.length, 2);
    const [session, payload] = descriptor.parameters;
    assert.equal(session.source, "lookup");
    assert.equal(session.lookup, "session");
    assert.equal(session.wire, "sessionId");
    assert.equal(session.codec.mode, "strict");
    assert.equal(session.codec.typeSymbol, "@deepseek-ai/dsh-session/types#SessionId");
    assert.equal(payload.source, "json");
    assert.equal(payload.wire, "payload");
    assert.equal(payload.codec.mode, "strict");
    assert.equal(typeof payload.codec.create, "function");
    assert.equal(payload.codec.create().parse("passthrough"), "passthrough");
    assert.equal(descriptor.cancellation.parameter, "signal");
  }

  // dispose → hasSeen（gateway 对该窗口报 definition-unavailable）→ 重注册恢复。
  reg.disposer();
  assert.equal(typert.local.get("shiori/getStatus"), undefined);
  assert.equal(typert.local.hasSeen("shiori/getStatus"), true);
  const reg2 = registerShioriTypert(ctx);
  assert.equal(reg2.codec, "strict");
  assert.ok(typert.local.get("shiori/getStatus"));

  // 未 dispose 的重复注册（上一代残留）→ 逐字一致 → adopt（strict 沿用，无 disposer）。
  const reg3 = registerShioriTypert(ctx);
  assert.equal(reg3.codec, "strict");
  assert.match(reg3.reason, /adopted-from-previous-registration/);
  assert.equal(reg3.disposer, null);

  // 无 typert 注册面的 ctx → 回退 SRC（现状行为），不抛出。
  const bare = registerShioriTypert({});
  assert.equal(bare.codec, "src");
  assert.ok(bare.reason);
});

// ─────────────────────────────────────────────────────────────
// a5 回归（B-P2：真实 index.mjs 入口 + 真实 Cordis fiber boot）
//
// a4 翻车根因：registerShioriTypert 用 `ctx?.typert` 属性取服务——真实宿主
// Cordis 里插件 fiber 对未 inject 的服务属性访问会直接抛
// `cannot get property "typert" without inject`，进程级 apply 整体失败、
// 九个管理方法全 404。原有 real-host 用例把 registry 直接递给函数，绕过了
// Cordis 的 inject 门控，全绿也没挡住。本节用真实 cordis Context 装载
// index.mjs（Q 槽入口，inject 只有 tools/systemPrompt，不 stub typert），
// 复现同一装配层级。index.mjs 属 Q 槽、不在本槽 work 树里：组合树 / owner
// 树 / 真机存在，缺席时 skip 并如实标注（同上 Discovery 约定）。
// ─────────────────────────────────────────────────────────────

const SESSION_WIRE_SYMBOL = "@deepseek-ai/dsh-session/types#SessionId";
const ENTRY_PATH = fileURLToPath(new URL("../../index.mjs", import.meta.url));

async function loadCordis() {
  try {
    return await import("@deepseek-ai/cordis");
  } catch {
    const globalCordis = process.env.APPDATA
      ? path.join(process.env.APPDATA, "npm", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai", "cordis", "lib", "index.js")
      : null;
    if (globalCordis && existsSync(globalCordis)) {
      return import(pathToFileURL(globalCordis).href);
    }
    return null;
  }
}

/**
 * 用真实 cordis Context 装载 index.mjs 并等到 apply 完成（shiori.panel 服务
 * 在场）。宿主基础服务（tools/systemPrompt + extra）由 provides 声明的 fake
 * host 插件提供——这正是 B-P2 的装配层级：入口 inject 只有 tools/systemPrompt。
 */
async function bootRealEntry({ extraServices = null, timeoutMs = 10000 } = {}) {
  const cordis = await loadCordis();
  if (!cordis) throw new Error("SKIP: cordis not resolvable");
  if (!existsSync(ENTRY_PATH)) throw new Error("SKIP: index.mjs entry not present in this tree");
  const entry = await import(pathToFileURL(ENTRY_PATH).href);

  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-boot-"));
  const tools = { registered: [] };
  const root = new cordis.Context();
  root.plugin({
    name: "shiori-boot-test-host",
    provides: ["tools", "systemPrompt", ...(extraServices ? Object.keys(extraServices) : [])],
    apply(ctx) {
      ctx.provide("tools", { register(def) { tools.registered.push(def.name); return () => {}; } });
      ctx.provide("systemPrompt", {
        section: () => () => {},
        layers: { global: { sections: { entries: () => [].entries() } } },
      });
      for (const [name, service] of Object.entries(extraServices ?? {})) ctx.provide(name, service);
      return () => {};
    },
  });
  root.plugin(entry, {
    mode: "active",
    allowActive: true,
    dataRoot: path.join(base, "data"),
    stateRoot: path.join(base, "state"),
    defaultPersona: "amber",
    l2: { enabled: false },
  });

  // 轮询等 apply 完成（cordis 插件应用是异步的；shiori.panel 由 mountShioriRpc
  // 在 start 成功后注册——服务在场即"插件激活"）。
  const deadline = Date.now() + timeoutMs;
  let panel = null;
  for (;;) {
    panel = root.get("shiori.panel");
    if (panel !== undefined && panel !== null) break;
    if (Date.now() > deadline) {
      await rm(base, { recursive: true, force: true });
      throw new Error("shiori.panel service did not appear: entry apply did not complete (boot failed)");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const cleanup = async () => {
    try { await panel.stop(); } catch { /* 尽力清理 */ }
    try { await root.fiber._unload(); } catch { /* 尽力清理 */ }
    await rm(base, { recursive: true, force: true });
  };
  return { panel, tools, cleanup };
}

test("B-P2 真实入口 boot：index.mjs apply + 真实 Cordis fiber（不注入 typert）→ 插件激活、16 工具注册、typertRpc 如实回退 src", async (t) => {
  const cordis = await loadCordis();
  if (!cordis) { t.skip("real cordis not resolvable on this machine (RESULT.json marks this check not-run)"); return; }
  if (!existsSync(ENTRY_PATH)) {
    t.skip("index.mjs (Q slot) absent from this partial work tree; runs green in combined/owner tree — RESULT.json marks this check not-run here");
    return;
  }

  const { panel, tools, cleanup } = await bootRealEntry({});
  try {
    // 插件激活：服务在场、面板 RPC 诊断 open。
    const diag = panel.diagnostics();
    assert.equal(diag.service, "shiori.panel");
    assert.equal(diag.closed, false);
    // 16 工具经真实 bindings + 真实 defineTool 注册进宿主 tools 服务。
    assert.equal(tools.registered.length, 16);
    // typertRpc 走"registry 缺席"分支（ctx.get 可选读取返回 undefined），
    // 而不是被调用点 try/catch 接住的异常——reason 必须逐字是缺席语义。
    const status = await panel.management.getStatus(
      { session: { id: "boot-probe-s1" }, source: "panel-rpc" }, {},
    );
    assert.equal(status.diagnostics.typertRpc.codec, "src");
    assert.equal(status.diagnostics.typertRpc.reason, "host typert registry unavailable on this context");
  } finally {
    await cleanup();
  }
});

test("B-P2 真实入口 boot：注入 typert 但 register 抛错 → start 仍成功、reason 如实携带异常消息", async (t) => {
  const cordis = await loadCordis();
  if (!cordis) { t.skip("real cordis not resolvable on this machine (RESULT.json marks this check not-run)"); return; }
  if (!existsSync(ENTRY_PATH)) {
    t.skip("index.mjs (Q slot) absent from this partial work tree; runs green in combined/owner tree — RESULT.json marks this check not-run here");
    return;
  }

  const { panel, tools, cleanup } = await bootRealEntry({
    extraServices: {
      typert: {
        // provider 形状与宿主 dsh-session lib/index.js:1741-1748 一致，
        // 通过注册前核验后让 register 真抛。
        lookups: {
          get: (key) => key === "session"
            ? { wire: "sessionId", wireTypeSymbol: SESSION_WIRE_SYMBOL }
            : undefined,
        },
        register: () => { throw new Error("injected typert failure"); },
      },
    },
  });
  try {
    assert.equal(tools.registered.length, 16, "register 抛错不得阻断 16 工具注册");
    const status = await panel.management.getStatus(
      { session: { id: "boot-probe-s2" }, source: "panel-rpc" }, {},
    );
    assert.equal(status.diagnostics.typertRpc.codec, "src");
    assert.match(status.diagnostics.typertRpc.reason, /typert\.register failed: injected typert failure/);
  } finally {
    await cleanup();
  }
});
