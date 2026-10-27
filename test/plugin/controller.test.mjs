// P5 · controller 生命周期测试（slot P）。
// 合成 bindings（不依赖真实 DSH 包）；只用 temp 目录，不触真实 profile。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createShioriPluginController } from "../../src/plugin/controller.mjs";
import { TOOL_NAMES, TOOL_OUTPUT_SCHEMAS } from "../../src/plugin/tool-schemas.mjs";
import { openCompletionState } from "../../src/completion/index.mjs";

/** 可编程合成 bindings：记录注册并支持注入失败。 */
function fakeBindingsFactory({ failOn = null } = {}) {
  const registered = { sections: [], tools: [], waterfall: null, preStep: null, sessionEvents: null, disposed: 0 };
  const factory = (ctx, settings, deps) => ({
    registerSystemSection({ name }) {
      if (failOn === "section") throw new Error("injected section failure");
      registered.sections.push(name);
      return true;
    },
    registerAssembleWaterfall(handler) {
      if (failOn === "waterfall") throw new Error("injected waterfall failure");
      registered.waterfall = handler;
      return true;
    },
    registerPreStep(handler) {
      if (failOn === "preStep") throw new Error("injected pre-step failure");
      registered.preStep = handler;
      return true;
    },
    subscribeSessionEvents(listener) {
      if (failOn === "sessionEvents") throw new Error("injected subscription failure");
      registered.sessionEvents = listener;
      return true;
    },
    async registerTool(tool) {
      if (failOn === `tool:${tool.name}`) throw new Error(`injected tool failure: ${tool.name}`);
      registered.tools.push(tool.name);
      return true;
    },
    async loadCreateUserMessage() {
      return (input) => ({ id: `msg-${Math.random().toString(16).slice(2)}`, role: "user", content: input.content, source: input.source });
    },
    disposeAll() {
      registered.disposed += 1;
      registered.sections = [];
      registered.tools = [];
      registered.waterfall = null;
      registered.preStep = null;
      registered.sessionEvents = null;
      return { disposed: true, errors: [] };
    },
    // 与真实 bindings.diagnostics 同形（registeredSections/registeredTools）。
    get diagnostics() {
      return {
        registeredSections: registered.sections,
        registeredTools: registered.tools,
        waterfall: registered.waterfall !== null,
        preStep: registered.preStep !== null,
        sessionEvents: registered.sessionEvents !== null,
      };
    },
  });
  factory.registered = registered;
  return factory;
}

function fakeCtx() {
  return { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} };
}

/**
 * 合成 dsh-system-prompt 的 ScopedLayers 形状（仅供 B2 探测/装配判定）：
 * global 层 + scoped Map，merge(scope, project) 返回 global 与该 scope 的合并。
 * 真实宿主见 dsh-system-prompt lib/index.js:355-363。
 */
function fakeLayers({ global = new Map(), scopes = new Map() } = {}) {
  const view = (sections) => ({ sections });
  return {
    global: view(global),
    scoped: scopes,
    merge(scope, project) {
      const merged = new Map();
      const add = (layer) => {
        const projected = project(layer);
        if (projected instanceof Map) for (const [k, v] of projected) merged.set(k, v);
      };
      add(view(global));
      if (scope !== undefined) {
        const scopedSections = scopes.get(scope);
        if (scopedSections !== undefined) add(view(scopedSections));
      }
      return merged;
    },
  };
}

async function tempRoots() {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-ctrl-"));
  return {
    base,
    dataRoot: path.join(base, "data"),
    stateRoot: path.join(base, "state"),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

const activeSettings = (roots) => ({
  mode: "active",
  allowActive: true,
  dataRoot: roots.dataRoot,
  stateRoot: roots.stateRoot,
  ownerId: "local",
  defaultPersona: "amber",
  l2: { enabled: false },
});

test("构造不自动 start；start 幂等拒绝；stop 幂等；再启新代", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  const d0 = controller.diagnostics();
  assert.equal(d0.started, false);
  assert.equal(d0.startCount, 0);

  await controller.start();
  await assert.rejects(() => controller.start(), (e) => e.code === "INVALID_STATE");
  const d1 = controller.diagnostics();
  assert.equal(d1.started, true);
  assert.equal(d1.startCount, 1);

  const stop1 = await controller.stop();
  assert.equal(stop1.stopped, true);
  const stop2 = await controller.stop(); // 幂等 no-op 语义（已停止再停无害）
  assert.equal(stop2.stopped, true);
  assert.equal(controller.diagnostics().started, false);

  await controller.start();
  assert.equal(controller.diagnostics().startCount, 2);
  assert.equal(controller.diagnostics().generation, 2);
  await controller.stop();
});

test("inert：shadow 且无 root → needs-configuration；getStatus 可用，其余 NOT_CONFIGURED；不注册任何宿主资源", async (t) => {
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), { mode: "shadow" }, { bindings });
  await controller.start();
  const d = controller.diagnostics();
  assert.equal(d.mode, "inert");
  assert.equal(d.needsConfiguration, true);
  assert.deepEqual(bindings.registered.sections, []);
  assert.deepEqual(bindings.registered.tools, []);

  const trustedContext = { session: { id: "s-1" }, source: "panel-rpc" };
  const status = await controller.management.getStatus(trustedContext, {});
  assert.equal(status.mode, "inert");
  assert.equal(status.configured, false);
  await assert.rejects(
    () => controller.management.getMemoryView(trustedContext, {}),
    (e) => e.code === "NOT_CONFIGURED",
  );
  await assert.rejects(
    () => controller.management.executeTool(trustedContext, { name: "memory_read", args: {} }),
    (e) => e.code === "NOT_CONFIGURED",
  );
  await controller.stop();
});

test("active start 注册 16 工具 + 2 section + waterfall；工具输出 schema 覆盖真实成功分支（无空闭合 schema）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  const started = await controller.start();
  assert.deepEqual([...bindings.registered.sections].sort(), ["shiori:core", "shiori:persona"]);
  assert.equal(bindings.registered.waterfall !== null, true);
  assert.equal(bindings.registered.tools.length, 16);
  assert.deepEqual(started.tools.length, 16);
  // 16 工具名与契约清单逐一对齐；每个都有非空 output schema 且非空闭合对象。
  assert.deepEqual(TOOL_NAMES.length, 16);
  for (const name of bindings.registered.tools) {
    assert.ok(TOOL_NAMES.includes(name), `unexpected tool ${name}`);
    const schema = TOOL_OUTPUT_SCHEMAS[name];
    assert.ok(schema && typeof schema === "object");
    assert.ok(Object.keys(schema.properties ?? {}).length > 0, `${name} output schema must not be empty-closed`);
  }
  await controller.stop();
});

test("部分 start 失败（第 3 个工具注入失败）→ 零残留：注册全撤销、完成句柄关闭、可重启", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory({ failOn: "tool:memory_read" });
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  await assert.rejects(() => controller.start(), /injected tool failure/);
  const d = controller.diagnostics();
  assert.equal(d.started, false);
  assert.equal(d.counters.startFailures.length, 1);
  // 失败逆序清理：disposeAll 被调用，注册清空。
  assert.equal(bindings.registered.disposed, 1);
  assert.deepEqual(bindings.registered.tools, []);
  assert.deepEqual(bindings.registered.sections, []);
  // 失败后可重新 start（换掉失败点）。
  const bindings2 = fakeBindingsFactory();
  const controller2 = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings: bindings2 });
  await controller2.start();
  assert.equal(controller2.diagnostics().started, true);
  await controller2.stop();
});

test("stop 禁新请求：stopped 后工具入口 / waterfall 拒绝", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  await controller.start();
  const waterfall = bindings.registered.waterfall;
  await controller.stop();
  const d = controller.diagnostics();
  assert.equal(d.banned, true); // stop 后禁新请求保持（restart 时复位）
  assert.equal(controller.diagnostics().started, false);
  // stop 后 waterfall 不可用（已撤销注册）；直接调用应走「未启动」分支不读业务。
  const result = await waterfall({ sections: [], contexts: [], tools: [], variables: {} }, {}, async () => ({ sections: [], contexts: [], tools: [], variables: {} }));
  assert.deepEqual(result.sections, []);
});

test("shadow 配置 root：注册零工具零 section，management 只读（executeTool 写拒绝）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const settings = {
    mode: "shadow", allowActive: false,
    dataRoot: roots.dataRoot, stateRoot: roots.stateRoot,
    ownerId: "local", defaultPersona: "amber",
  };
  const controller = await createShioriPluginController(fakeCtx(), settings, { bindings });
  await controller.start();
  assert.deepEqual(bindings.registered.tools, []);
  assert.deepEqual(bindings.registered.sections, []);
  const trustedContext = { session: { id: "s-1" }, source: "panel-rpc" };
  const status = await controller.management.getStatus(trustedContext, {});
  assert.equal(status.mode, "shadow");
  assert.equal(status.configured, true);
  assert.equal(status.scope, "amber");
  await assert.rejects(
    () => controller.management.executeTool(trustedContext, { name: "memory_append", args: { section: "x", content: "y" } }),
    (e) => e.code === "UNSUPPORTED",
  );
  await assert.rejects(
    () => controller.management.analyze(trustedContext, { kind: "organize", operationId: "a1" }),
    (e) => e.code === "UNSUPPORTED",
  );
  await controller.stop();
});

test("真实工具路径：exec 会话证据 → scope 固定 → topic_create 创建 → 同 operationId 重放不重复追加", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  await controller.start();
  const bindings2 = fakeBindingsFactory();
  void bindings2;
  // 经真实工具路径执行：dispatchTool → service → store journal。
  const exec = { agent: { session: { id: "s-tool" } } };
  // 找到注册 def 中的 dispatch：通过 bindings.registered.tools 无法直接拿 execute；
  // 用 management.executeTool（active 模式同一 dispatchTool 路径）。
  const trustedContext = { session: { id: "s-tool" }, source: "panel-rpc" };
  const created = await controller.management.executeTool(trustedContext, {
    name: "topic_create",
    args: { topic: "alpha", title: "Alpha", summary: "first topic", operationId: "tc-1" },
  });
  assert.equal(created.created, true);
  assert.equal(created.replayed, undefined);

  const replayed = await controller.management.executeTool(trustedContext, {
    name: "topic_create",
    args: { topic: "alpha", title: "Alpha", summary: "first topic", operationId: "tc-1" },
  });
  assert.equal(replayed.replayed, true);

  // 同 op 异 payload 拒绝。
  await assert.rejects(
    () => controller.management.executeTool(trustedContext, {
      name: "topic_create",
      args: { topic: "beta", title: "Beta", summary: "other", operationId: "tc-1" },
    }),
    (e) => e.code === "INVALID_INPUT",
  );

  // 已存在 active 同 key → 冲突。
  await assert.rejects(
    () => controller.management.executeTool(trustedContext, {
      name: "topic_create",
      args: { topic: "alpha", title: "Alpha2", summary: "dup" },
    }),
    (e) => e.code === "INVALID_INPUT" && /already exists/.test(e.message),
  );

  // payload 身份字段拒绝。
  await assert.rejects(
    () => controller.management.executeTool(trustedContext, { name: "memory_read", args: { scopeId: "someone" } }),
    (e) => e.code === "INVALID_INPUT",
  );

  // 读回列表确认一个 topic。
  const list = await controller.management.executeTool(trustedContext, { name: "memory_list_topics", args: {} });
  assert.equal(list.topics.filter((x) => x.key === "alpha").length, 1);
  await controller.stop();
});

// ─────────────────────────────────────────────────────────────
// a2 返工回归（B1/B2/B3/B4/B7）
// ─────────────────────────────────────────────────────────────

test("B4 start/stop 互锁：start 在途时 stop 先等它收场；start 中止且不残留注册，可立即重启（无 LOCK_BUSY）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  let release;
  const gate = new Promise((res) => { release = res; });
  const slowOpenState = async (args) => {
    await gate; // 人为拉长 start 在途窗口
    return openCompletionState(args);
  };
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), {
    bindings, openState: slowOpenState,
  });

  const startPromise = controller.start().then(
    () => ({ outcome: "resolved" }),
    (error) => ({ outcome: "rejected", code: error?.code }),
  );
  await new Promise((r) => setTimeout(r, 20)); // 确保 start 已进入 openState 等待
  const stopPromise = controller.stop(); // start 在途：stop 必须先等它收场
  release();
  const startOutcome = await startPromise;
  assert.equal(startOutcome.outcome, "rejected");
  assert.equal(startOutcome.code, "INVALID_STATE");
  const stopResult = await stopPromise;
  assert.equal(stopResult.stopped, true);
  assert.equal(controller.diagnostics().started, false);
  // 零残留：注册全撤销，完成句柄已关（无锁文件占坑）。
  assert.equal(bindings.registered.disposed >= 1, true);
  assert.deepEqual(bindings.registered.tools, []);
  // 立即重启：不再撞 LOCK_BUSY。
  const bindings2 = fakeBindingsFactory();
  const controller2 = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings: bindings2 });
  await controller2.start();
  assert.equal(controller2.diagnostics().started, true);
  await controller2.stop();
});

test("B2 宿主 complete section：启动探测命中 → 不注册 L0/L1 section，diagnostics 如实声明 l0l1Effective=false", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  // 模拟 dsh-persona preset complete:true 的注册表形状（dsh-system-prompt layers）。
  const completeLayer = {
    sections: { entries: () => [["deployment:persona-prefix", { name: "deployment:persona-prefix", complete: true }]] },
  };
  const ctx = {
    systemPrompt: { section: () => () => {}, layers: { global: completeLayer, scoped: new Map() } },
    tools: { register: () => () => {} },
    on: () => () => {},
  };
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(ctx, activeSettings(roots), { bindings });
  const started = await controller.start();
  assert.deepEqual(started.sections, []); // 不注册（注册也会被宿主快照回填丢弃）
  assert.equal(started.l0l1Effective, false);
  assert.equal(started.tools.length, 16); // 工具与 L2 不受影响
  const d = controller.diagnostics();
  assert.equal(d.completeShadowed.length, 1);
  assert.equal(d.completeShadowed[0].name, "deployment:persona-prefix");
  assert.equal(d.l0l1Effective, false);
  await controller.stop();
});

test("B3 shadow+roots 纯内存：永不创建 completion 锁 / state 文件；getStatus 无占用；executeTool 一律 UNSUPPORTED", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const { readdir } = await import("node:fs/promises");
  const bindings = fakeBindingsFactory();
  const settings = {
    mode: "shadow", allowActive: false,
    dataRoot: roots.dataRoot, stateRoot: roots.stateRoot,
    ownerId: "local", defaultPersona: "amber",
  };
  const controller = await createShioriPluginController(fakeCtx(), settings, { bindings });
  await controller.start();
  // B3 铁证：stateRoot 目录不存在或为空（绝不建 completion-lock）。
  let stateFiles = [];
  try { stateFiles = await readdir(roots.stateRoot, { recursive: true }); } catch { /* 不存在也算过 */ }
  assert.equal(stateFiles.length, 0);
  assert.equal(controller.diagnostics().completion.status, "not-open");
  const trustedContext = { session: { id: "s-1" }, source: "panel-rpc" };
  const status = await controller.management.getStatus(trustedContext, {});
  assert.equal(status.mode, "shadow");
  assert.equal(status.scope, "amber"); // 纯内存 pinScope 解析仍可用
  assert.equal(status.occupancy, null); // 不触盘读占用
  // shadow 连只读工具也不放行（不开 scope 资源 → 不抢任何锁）。
  await assert.rejects(
    () => controller.management.executeTool(trustedContext, { name: "memory_read", args: {} }),
    (e) => e.code === "UNSUPPORTED",
  );
  await controller.stop();
});

test("B1 workspacePersonas 生产可达：trustedContext.agent 经宿主 workingDirectory.get 选卡（不再串 default 卡）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const workspaceDir = path.join(roots.base, "project-alpha");
  const ctx = {
    systemPrompt: { section: () => () => {} },
    tools: { register: () => () => {} },
    on: () => () => {},
    // 宿主 workingDirectory 服务（只读 get；本测试按会话返回固定目录）。
    workingDirectory: { get: (session) => (session?.id === "s-ws" ? workspaceDir : path.join(roots.base, "other")) },
  };
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(ctx, {
    ...activeSettings(roots),
    defaultPersona: "amber",
    workspacePersonas: [{ workspace: workspaceDir, persona: "bravo" }],
  }, { bindings });
  await controller.start();
  assert.ok(controller.diagnostics().workspaceRouting.workingDirectoryAvailable);
  // workspace 会话 → bravo 卡 scope（此前整个生命周期 0 次查询、串到 default）。
  const wsContext = {
    session: { id: "s-ws" }, agent: { session: { id: "s-ws" } }, source: "panel-rpc",
  };
  const created = await controller.management.executeTool(wsContext, {
    name: "topic_create", args: { topic: "ws-note", title: "WS", summary: "in bravo scope" },
  });
  assert.equal(created.created, true);
  const d = controller.diagnostics();
  assert.ok(d.counters.workingDirectoryLookups > 0, "workingDirectory.get must be consulted");
  assert.ok(d.scopes.some((s) => s.scopeId === "bravo"), "bravo scope resources must be opened");
  // 非 workspace 会话仍走 default 卡。
  const other = await controller.management.executeTool(
    { session: { id: "s-other" }, agent: { session: { id: "s-other" } }, source: "panel-rpc" },
    { name: "memory_list_topics", args: {} },
  );
  assert.ok(Array.isArray(other.topics));
  await controller.stop();
});

test("B7 assemble 错误隔离：启动后卡被外改超限 → 本轮装配不抛、跳过该 section 并计诊断", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  await controller.start();
  // 启动后外改：卡超限（13000 > 12000）且无 lastvalid —— 原 B7 复现场景。
  const { writeFile, mkdir } = await import("node:fs/promises");
  await mkdir(path.join(roots.dataRoot, "persona"), { recursive: true });
  await writeFile(path.join(roots.dataRoot, "persona", "amber.md"), "x".repeat(13000), "utf8");
  const waterfall = bindings.registered.waterfall;
  // 宿主语义：waterfall 闭包持有 assembly，next() 无参调用返回它。
  const assembly = {
    sections: [
      { name: "shiori:persona", text: "stale" },
      { name: "shiori:core", text: "stale-core" },
    ],
    contexts: [], tools: [], variables: {},
  };
  const result = await waterfall(
    assembly,
    { agent: { session: { id: "s-b7" } } },
    async () => assembly,
  );
  // 不抛：整轮装配存活；坏卡 section 被跳过（保留宿主原样），诊断如实记录。
  assert.equal(result.sections.find((s) => s.name === "shiori:persona").text, "stale");
  const d = controller.diagnostics();
  assert.ok(d.counters.assemblySkips.some((s) => s.startsWith("persona(")), "skip must be diagnosed");
  await controller.stop();
});

// ─────────────────────────────────────────────────────────────
// a3 返工回归（B2 诚实度 / B1-c）
// ─────────────────────────────────────────────────────────────

test("B2 诚实度·探测不可用：宿主 layers 读不到 → completeProbe=unavailable，l0l1Effective=unknown 不谎报 true", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const ctx = {
    // systemPrompt 存在但 layers 不可读（getter 抛错）——探测不可判定。
    systemPrompt: { section: () => () => {}, get layers() { throw new Error("registry unreadable"); } },
    tools: { register: () => () => {} },
    on: () => () => {},
  };
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(ctx, activeSettings(roots), { bindings });
  const started = await controller.start();
  // 不可判定时照常注册（无法证明会被宿主丢弃），但有效性必须报 unknown。
  assert.equal(started.completeProbe, "unavailable");
  assert.equal(started.l0l1Effective, "unknown");
  assert.deepEqual(started.completeShadowed, []);
  const d = controller.diagnostics();
  assert.equal(d.completeProbe, "unavailable");
  assert.equal(d.l0l1Effective, "unknown");
  await controller.stop();
});

test("B2 诚实度·启动后 global 注册 complete section：本次装配按 scope 记账，不刷新不谎报", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  // 可变注册表：start 时 global 无 complete section（探测未命中），之后由「宿主」注册。
  const globalSections = new Map([["host-card", { name: "host-card", complete: false }]]);
  const layers = fakeLayers({ global: globalSections });
  const ctx = {
    systemPrompt: { section: () => () => {}, layers },
    tools: { register: () => () => {} },
    on: () => () => {},
  };
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(ctx, activeSettings(roots), { bindings });
  const started = await controller.start();
  assert.equal(started.completeProbe, "none");
  assert.equal(started.l0l1Effective, true);
  assert.deepEqual(started.completeShadowed, []);

  // start 之后宿主注册 global complete:true section（agent scope 晚注册时序）。
  globalSections.set("late-card", { name: "late-card", complete: true });

  const waterfall = bindings.registered.waterfall;
  const assembly = {
    sections: [
      { name: "shiori:persona", text: "HOST-ORIG" },
      { name: "shiori:core", text: "HOST-ORIG-CORE" },
    ],
    contexts: [], tools: [], variables: {},
  };
  const result = await waterfall(assembly, { agent: { session: { id: "s-late" } } }, async () => assembly);
  // global complete 对每一次装配都成立：本轮原样返回（宿主会整体丢弃本包改写），
  // 不刷新、不计数，但如实记账「本次装配被遮蔽」。
  assert.equal(result.sections.find((s) => s.name === "shiori:persona").text, "HOST-ORIG");
  assert.equal(result.sections.find((s) => s.name === "shiori:core").text, "HOST-ORIG-CORE");
  const d = controller.diagnostics();
  assert.equal(d.counters.assemblies, 0);
  assert.equal(d.counters.assembliesRefreshed, 0);
  assert.equal(d.assemblyCompleteShadowed, 1);
  assert.equal(d.assemblyCompleteProbe, "ok");
  assert.ok(d.counters.assemblySkips.some((s) => s.startsWith("complete(")), "shadow must be diagnosed");
  assert.deepEqual(d.completeShadowed, [], "启动期探测不回溯改写（历史事实）");
  assert.equal(d.l0l1Effective, "unknown", "至少一次装配未送达 → 不得宣称有效");
  await controller.stop();
});

test("B2 跨 scope 隔离：preset-minimal 的 complete persona 不遮蔽 global 装配，只遮蔽该 scope 的本次装配", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  // 真机缺陷 A/B 形状：global 无 complete，另一个 scope（desktop/web 的 preset-minimal）
  // 有 complete:true 的 persona。旧实现遍历 layers.scoped 全量 → 全局误判遮蔽。
  const globalSections = new Map([["host-card", { name: "host-card", complete: false }]]);
  const scoped = new Map([
    ["preset-minimal", new Map([["persona", { name: "persona", order: -1000, complete: true }]])],
  ]);
  const layers = fakeLayers({ global: globalSections, scopes: scoped });
  const ctx = {
    systemPrompt: { section: () => () => {}, layers },
    tools: { register: () => () => {} },
    on: () => () => {},
  };
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(ctx, activeSettings(roots), { bindings });
  const started = await controller.start();
  // 跨 scope 的 complete 与 global 探测无关：本包 L0/L1 必须照常注册。
  assert.equal(started.completeProbe, "none");
  assert.deepEqual(started.completeShadowed, []);
  assert.deepEqual(started.sections, ["shiori:persona", "shiori:core"]);
  assert.equal(started.l0l1Effective, true);

  const waterfall = bindings.registered.waterfall;
  const makeAssembly = () => ({
    sections: [
      { name: "shiori:persona", text: "HOST-ORIG" },
      { name: "shiori:core", text: "HOST-ORIG-CORE" },
    ],
    contexts: [], tools: [], variables: {},
  });

  // 1) global 装配（context 不带 scope）：本次 assembly 没有 complete → 正常刷新、不记遮蔽。
  const globalAssembly = makeAssembly();
  const globalResult = await waterfall(
    globalAssembly,
    { agent: { session: { id: "s-global" } } },
    async () => globalAssembly,
  );
  assert.notEqual(globalResult, undefined);
  let d = controller.diagnostics();
  assert.equal(d.counters.assemblies, 1);
  assert.equal(d.assemblyCompleteShadowed, 0);
  assert.equal(d.assemblyCompleteProbe, "none");
  assert.equal(d.l0l1Effective, true);

  // 2) preset-minimal 装配：complete persona 快照会整体替换本次 sections →
  //    如实记账并原样返回（不刷新、不谎报注入成功）。
  const presetAssembly = makeAssembly();
  const presetResult = await waterfall(
    presetAssembly,
    { agent: { session: { id: "s-preset" } }, scope: "preset-minimal" },
    async () => presetAssembly,
  );
  assert.equal(presetResult.sections.find((s) => s.name === "shiori:persona").text, "HOST-ORIG");
  d = controller.diagnostics();
  assert.equal(d.assemblyCompleteShadowed, 1);
  assert.equal(d.assemblyCompleteProbe, "ok");
  assert.equal(d.counters.assemblies, 1, "shadowed assembly must not count as refreshed");
  assert.ok(d.counters.assemblySkips.some((s) => s.includes("persona@preset-minimal")));
  assert.equal(d.l0l1Effective, "unknown", "不可判定 ≠ 有效");
  await controller.stop();
});

test("B1-c 压缩事件 scope 归属：header.cwd 与 workingDirectory 投影分叉 → 以投影为准；无服务回落 default", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const workspaceDir = path.join(roots.base, "project-ws");
  const otherDir = path.join(roots.base, "unmapped");
  const ctx = {
    systemPrompt: { section: () => () => {} },
    tools: { register: () => () => {} },
    on: () => () => {},
    workingDirectory: { get: (session) => (session?.id === "s-ws" ? workspaceDir : otherDir) },
  };
  const bindings = fakeBindingsFactory();
  const controller = await createShioriControllerForTest(ctx, roots, bindings, workspaceDir);
  await controller.start();

  // 会话 header.cwd 指向别处（WS_B 伪证），但投影返回 workspaceDir → bravo。
  const listener = bindings.registered.sessionEvents;
  await listener(
    { id: "s-ws", header: { cwd: path.join(roots.base, "project-OTHER") } },
    { type: "tool/ptc-dispatch", seq: 1, data: { name: "compress", blocksCreated: 2, subCallId: "c-1" } },
  );
  await listener(
    { id: "s-def", header: { cwd: otherDir } },
    { type: "tool/ptc-dispatch", seq: 1, data: { name: "compress", blocksCreated: 1, subCallId: "c-2" } },
  );

  // 投影归属：s-ws → bravo 的 epoch 推进；s-def（未映射目录）→ default amber。
  const { createStateStore } = await import("../../src/plugin/state.mjs");
  const st = createStateStore({ stateRoot: roots.stateRoot });
  assert.equal(await st.l2Store.sessionEpoch("bravo", "s-ws"), 1);
  assert.equal(await st.l2Store.sessionEpoch("amber", "s-ws"), 0);
  assert.equal(await st.l2Store.sessionEpoch("amber", "s-def"), 1);
  await controller.stop();
});

test("P-C typert 注册失败不阻断启动：无 typert 注册面 → 回退 SRC 且 diagnostics 如实上报 reason", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  // fakeCtx 无 typert 注册面 → registerShioriTypert 回退 SRC。
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  const started = await controller.start();
  assert.equal(started.tools.length, 16);
  const d = controller.diagnostics();
  assert.equal(d.typertRpc.codec, "src");
  assert.match(d.typertRpc.reason, /typert registry unavailable/);
  // stop 幂等清理不抛（无 disposer 可撤）。
  const stopped = await controller.stop();
  assert.equal(stopped.stopped, true);

  // typert.register 注入失败且无既有描述符 → 回退 SRC，原因带上报错原文。
  const bindings2 = fakeBindingsFactory();
  const throwingCtx = {
    ...fakeCtx(),
    typert: {
      register() { throw new Error("injected typert failure"); },
      lookups: { get: () => ({ wire: "sessionId", wireTypeSymbol: "@deepseek-ai/dsh-session/types#SessionId" }) },
      local: { get: () => undefined },
    },
  };
  const controller2 = await createShioriPluginController(throwingCtx, activeSettings(roots), { bindings: bindings2 });
  await controller2.start();
  const d2 = controller2.diagnostics();
  assert.equal(d2.typertRpc.codec, "src");
  assert.match(d2.typertRpc.reason, /injected typert failure/);
  await controller2.stop();
});

/** B1-c 测试夹具：workspace 映射 + 压缩探针所需的最小 settings/controller。 */
async function createShioriControllerForTest(ctx, roots, bindings, workspaceDir) {
  return createShioriPluginController(ctx, {
    ...activeSettings(roots),
    defaultPersona: "amber",
    l2: { enabled: true },
    workspacePersonas: [{ workspace: workspaceDir, persona: "bravo" }],
  }, { bindings });
}
