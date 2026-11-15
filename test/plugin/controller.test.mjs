// P5 · controller 生命周期测试（slot P）。
// 合成 bindings（不依赖真实 DSH 包）；只用 temp 目录，不触真实 profile。

import { test } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createShioriPluginController } from "../../src/plugin/controller.mjs";
import { TOOL_NAMES, TOOL_OUTPUT_SCHEMAS } from "../../src/plugin/tool-schemas.mjs";
import { openCompletionState } from "../../src/completion/index.mjs";
import { defaultPluginRoots } from "../../src/plugin/config.mjs";

// 0.4-S1（reviewer P3）：测试入口统一注入 DSH_HOME=临时目录——0.4 起缺省根会真实
// mkdir（scope.mjs 直构缺根补默认同样落默认路径），不注入会写到真实 ~/.dsh。
const DSH_HOME_TMP = await mkdtemp(path.join(tmpdir(), "shiori-p5-ctrl-dsh-"));
process.env.DSH_HOME = DSH_HOME_TMP;
test.after(() => rm(DSH_HOME_TMP, { recursive: true, force: true }));

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

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
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

test("active start 注册 17 工具 + 2 section + waterfall；工具输出 schema 覆盖真实成功分支（无空闭合 schema）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  const started = await controller.start();
  assert.deepEqual([...bindings.registered.sections].sort(), ["shiori:core", "shiori:persona"]);
  assert.equal(bindings.registered.waterfall !== null, true);
  assert.equal(bindings.registered.tools.length, 17);
  assert.deepEqual(started.tools.length, 17);
  // 17 工具名与契约清单逐一对齐；每个都有非空 output schema 且非空闭合对象。
  assert.deepEqual(TOOL_NAMES.length, 17);
  for (const name of bindings.registered.tools) {
    assert.ok(TOOL_NAMES.includes(name), `unexpected tool ${name}`);
    const schema = TOOL_OUTPUT_SCHEMAS[name];
    assert.ok(schema && typeof schema === "object");
    assert.ok(Object.keys(schema.properties ?? {}).length > 0, `${name} output schema must not be empty-closed`);
  }
  await controller.stop();
});

test("F7 座位：active start 占座并上报诊断，stop 后让座", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  await controller.start();

  const readonly = controller.diagnostics().readonly;
  assert.ok(readonly !== null, "active start should report the seat in diagnostics");
  assert.equal(readonly.writable, true);
  assert.equal(readonly.readonly, false);
  assert.equal(readonly.seat.announced, true);
  assert.equal(readonly.seat.degraded, false);
  const seatFile = readonly.seat.file;
  assert.equal(path.dirname(seatFile), path.join(roots.dataRoot, ".shiori-seats"));
  assert.equal(await fileExists(seatFile), true);

  await controller.stop();
  assert.equal(controller.diagnostics().readonly, null);
  assert.equal(await fileExists(seatFile), false);
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
  assert.equal(started.tools.length, 17); // 工具与 L2 不受影响
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
  assert.equal(started.tools.length, 17);
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

// ─────────────────────────────────────────────────────────────
// 0.4-S1 · status/diagnostics 完成度信号（dataRoot / stateRoot / configurationState，
// 纯增量：既有字段语义不变，前端初始化卡片据此渲染，不再自行推断）
// ─────────────────────────────────────────────────────────────

test("0.4-S1 增量信号：diagnostics/getStatus 返回解析后两根、rootsSource 与 configurationState", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  // activeSettings 带默认卡 amber 且双根显式 → configured / explicit
  const d = controller.diagnostics();
  assert.equal(d.dataRoot, roots.dataRoot);
  assert.equal(d.stateRoot, roots.stateRoot);
  assert.equal(d.rootsSource.dataRoot, "explicit");
  assert.equal(d.rootsSource.stateRoot, "explicit");
  assert.equal(d.configurationState, "configured");
  await controller.start();
  const trustedContext = { session: { id: "s-1" }, source: "panel-rpc" };
  const status = await controller.management.getStatus(trustedContext, {});
  assert.equal(status.diagnostics.dataRoot, roots.dataRoot);
  assert.equal(status.diagnostics.stateRoot, roots.stateRoot);
  assert.equal(status.diagnostics.rootsSource.dataRoot, "explicit");
  assert.equal(status.diagnostics.configurationState, "configured");
  await controller.stop();

  // 人设卡未指定 → needs-persona（初始化卡片的人设行信号，最优先）
  const bindings2 = fakeBindingsFactory();
  const controller2 = await createShioriPluginController(fakeCtx(), {
    ...activeSettings(roots), defaultPersona: null,
  }, { bindings: bindings2 });
  const d2 = controller2.diagnostics();
  assert.equal(d2.configurationState, "needs-persona");
  await controller2.stop();

  // reviewer P3：shadow + 已设人设卡 → needs-active（不再误报 configured；
  // 面板据此显示「启用记忆」入口）
  const bindings3 = fakeBindingsFactory();
  const controller3 = await createShioriPluginController(fakeCtx(), {
    mode: "shadow", allowActive: false,
    dataRoot: roots.dataRoot, stateRoot: roots.stateRoot,
    ownerId: "local", defaultPersona: "amber",
  }, { bindings: bindings3 });
  const d3 = controller3.diagnostics();
  assert.equal(d3.mode, "shadow");
  assert.equal(d3.configurationState, "needs-active");
  await controller3.stop();
});

test("0.4-S1 rootsSource：shadow 直构缺一根时补 DSH_HOME 默认并如实标记（reviewer P1/P2②）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  // 直构：显式双根
  const explicit = await createShioriPluginController(fakeCtx(), {
    mode: "shadow", allowActive: false,
    dataRoot: roots.dataRoot, stateRoot: roots.stateRoot,
    ownerId: "local", defaultPersona: "amber",
  }, { bindings });
  const dExplicit = explicit.diagnostics();
  assert.equal(dExplicit.rootsSource.dataRoot, "explicit");
  assert.equal(dExplicit.rootsSource.stateRoot, "explicit");
  await explicit.stop();

  // 直构：只给 dataRoot、stateRoot 缺省 → scope 校验独立补 DSH_HOME 默认根
  // （不再误拒「显式 dataRoot + null stateRoot」），rootsSource 如实区分来源
  const partial = await createShioriPluginController(fakeCtx(), {
    mode: "shadow", allowActive: false,
    dataRoot: roots.dataRoot,
    ownerId: "local", defaultPersona: "amber",
  }, { bindings });
  const dPartial = partial.diagnostics();
  assert.equal(dPartial.dataRoot, roots.dataRoot);
  assert.equal(dPartial.stateRoot, path.join(DSH_HOME_TMP, "shiori-state"));
  assert.equal(dPartial.rootsSource.dataRoot, "explicit");
  assert.equal(dPartial.rootsSource.stateRoot, "default");
  await partial.stop();

  // normalize 产物路径：settings 自带 rootsSource，scope 原样透传（不重推）
  const defaulted = await createShioriPluginController(fakeCtx(), {
    mode: "shadow", allowActive: false,
    dataRoot: defaultPluginRoots().dataRoot, stateRoot: defaultPluginRoots().stateRoot,
    rootsSource: { dataRoot: "default", stateRoot: "default" },
    ownerId: "local", defaultPersona: null,
  }, { bindings });
  const dDefaulted = defaulted.diagnostics();
  assert.equal(dDefaulted.rootsSource.dataRoot, "default");
  assert.equal(dDefaulted.rootsSource.stateRoot, "default");
  assert.equal(dDefaulted.configurationState, "needs-persona");
  await defaulted.stop();
});

// ---------------------------------------------------------------------------
// S3（0.4）：scope 首次进 active → ensureGroupsFile 写默认组清单；
// shadow（配置了 root）不建 scope 资源，不写盘；group_manage 进工具面。
// ---------------------------------------------------------------------------

test("S3 active start：scope 的 groups.json 按默认模板初始化；group_manage 在工具面", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  const started = await controller.start();
  assert.ok(started.tools.includes("group_manage"), "group_manage 在第 17 工具面");
  const groupsFile = path.join(roots.dataRoot, "scopes", "amber", "groups.json");
  await access(groupsFile); // active 启动即初始化（缺文件才写）
  const data = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(groupsFile, "utf8")));
  assert.equal(data.version, 1);
  assert.deepEqual(data.groups.map((g) => g.key).sort(), ["dev", "life", "project", "self"]);
  await controller.stop();
});

test("S3 shadow：不初始化 groups.json（shadow 不写盘）", async (t) => {
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
  await assert.rejects(() => access(path.join(roots.dataRoot, "scopes", "amber", "groups.json")));
  await controller.stop();
});

// ─────────────────────────────────────────────────────────
// S5 · 模型下载与目录（<dataRoot>/models 口径 + semantic_download 保留名）
// ─────────────────────────────────────────────────────────

/** active + provider=local（cacheDir 空串走 controller 派生契约）的设置。 */
const localSemanticSettings = (roots) => ({
  ...activeSettings(roots),
  semantic: {
    provider: "local",
    local: {
      model: "Xenova/bge-small-zh-v1.5",
      dims: 512,
      dtype: "q8",
      cacheDir: "",
      mirror: "https://hf-mirror.com/",
    },
    minSimilarity: 0.55,
    api: { endpoint: null, keyRef: null },
  },
});

const rpcContext = () => ({ session: { id: "s-panel" }, source: "panel-rpc" });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 有界轮询等待（S5 复审 P2）：条件为真即返回；超时前最后再查一次（最后一次也
 *  假 → 调用方断言失败，如实暴露而不是糊过去）。不许用 rm 重试糊 teardown 竞态。 */
const waitFor = async (condition, capMs = 2000, stepMs = 20) => {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return await condition();
};

test("S5 目录口径：cacheDir 空串兑现为 <dataRoot>/models（诊断 modelDir），modelInstalled 起步 false", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), { bindings });
  await controller.start();
  const status = await controller.management.getStatus(rpcContext(), {});
  const semantic = status.diagnostics.semantic;
  assert.equal(semantic.modelDir, path.join(roots.dataRoot, "models"),
    "模型缓存目录兑现为 <dataRoot>/models（不再落 stateRoot/semantic/models）");
  assert.equal(semantic.modelInstalled, false, "干净机器上模型未安装");
  assert.deepEqual(semantic.download, {
    running: false, phase: "idle", percent: null, loadedBytes: 0, totalBytes: 0,
    filesDone: 0, filesTotal: 0, source: null, error: null, code: null, installHint: null,
  }, "下载任务态初始 idle");
  // 显式 cacheDir 优先于派生（契约不变）。
  const roots2 = await tempRoots();
  t.after(roots2.cleanup);
  const settings2 = localSemanticSettings(roots2);
  settings2.semantic = { ...settings2.semantic, local: { ...settings2.semantic.local, cacheDir: roots2.dataRoot } };
  const controller2 = await createShioriPluginController(fakeCtx(), settings2, { bindings: fakeBindingsFactory() });
  await controller2.start();
  const status2 = await controller2.management.getStatus(rpcContext(), {});
  assert.equal(status2.diagnostics.semantic.modelDir, roots2.dataRoot, "显式 cacheDir 优先");
  await controller.stop();
  await controller2.stop();
});

test("S5 semantic_download：假下载器全流程——单飞、进度落诊断、done 置 ready、源顺序镜像先官方后", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const downloaderOpts = [];
  // P0#3：done = 文件齐全 + 维度校验通过（真下载收尾的契约）。桩照此把期望文件
  // 落盘——done 后自动 rebuild 的文件门禁才会放行（否则触发期同步抛错落
  // lastError，与本用例的 lastError===null 断言冲突）。
  const fakeDownloader = {
    download: async ({ onProgress, onSource, onPhase }) => {
      onSource("https://hf-mirror.com/");
      onPhase("downloading");
      onProgress({ percent: 40, loadedBytes: 400, totalBytes: 1000, filesDone: 1, filesTotal: 3 });
      await settle();
      await installFakeModelFiles(roots.dataRoot); // 文件齐全契约：与 :1353 同一桩（声明提升，前置用例可直接调）
      return { ok: "done", source: "https://hf-mirror.com/", attempts: [] };
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings,
    createDownloader: (opts) => {
      downloaderOpts.push(opts);
      return fakeDownloader;
    },
  });
  await controller.start();
  const trustedContext = rpcContext();
  const started = await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  assert.equal(started.started, true);
  // 下载器首个 await 前同步跑 onSource/onPhase，快照可能已推进到 downloading；
  // 两种都算「启动快照」（绝不可能是 done/error 终态）。
  assert.ok(started.phase === "starting" || started.phase === "downloading",
    `返回的是启动快照（实际 ${started.phase}）`);
  // 在跑期间重复触发：单飞返回快照不重跑。
  const again = await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  assert.equal(again.started, false, "单飞：进行中重复点击只返回快照");
  await settle();
  await settle();
  const status = await controller.management.getStatus(trustedContext, {});
  const dl = status.diagnostics.semantic.download;
  assert.equal(dl.running, false);
  assert.equal(dl.phase, "done");
  assert.equal(dl.percent, 40, "最后一次进度快照留在诊断里");
  assert.equal(dl.loadedBytes, 400);
  assert.equal(status.diagnostics.semantic.ready, true, "done（含真实推理校验）→ provider 就绪");
  assert.equal(status.diagnostics.semantic.lastError, null);
  // 下载器入参：目录口径 + 源顺序（镜像先、官方源兜底）+ model/dims/dtype 透传。
  assert.equal(downloaderOpts.length, 1, "单飞只创建一个下载器");
  assert.equal(downloaderOpts[0].cacheDir, path.join(roots.dataRoot, "models"));
  assert.deepEqual(downloaderOpts[0].mirrors, ["https://hf-mirror.com/", "https://huggingface.co/"]);
  assert.equal(downloaderOpts[0].model, "Xenova/bge-small-zh-v1.5");
  assert.equal(downloaderOpts[0].dims, 512);
  assert.equal(downloaderOpts[0].dtype, "q8");
  // P0#3：done 后自动 rebuild 是 detached——stop 前等它收尾落地（含最终
  // store.save），避免 teardown 的 rm 撞上未完成的 save（Windows EBUSY）。
  // 谓词与 1369 口径一致：running === false 且 phase === "done"——只查 running
  // 挡不住「rebuild 被拉起后中途变 error/aborted」的退化（phase 红得出来）。
  assert.ok(await waitFor(async () => {
    const s = await controller.management.getStatus(trustedContext, {});
    const r = s.diagnostics.semantic.rebuild;
    return r.running === false && r.phase === "done";
  }, 2000), "自动 rebuild 收尾为 done（上限 2000ms）");
  assert.equal((await controller.management.getStatus(trustedContext, {}))
    .diagnostics.semantic.lastError, null, "自动 rebuild 空列表成功：不落错误");
  await controller.stop();
});

test("S5 semantic_download：args.cancel=true 协作取消 → phase=cancelled、running=false（不留半截锁）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  let sawCancel = false;
  const fakeDownloader = {
    download: async ({ onProgress, isCancelled }) => {
      onProgress({ percent: 10, loadedBytes: 10, totalBytes: 100, filesDone: 0, filesTotal: 2 });
      // 模拟 progress_callback 检查点：取消翻真后立刻收场。
      await gate;
      sawCancel = isCancelled();
      if (sawCancel) return { ok: "cancelled", attempts: [] };
      return { ok: "done", source: "x", attempts: [] };
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings,
    createDownloader: () => fakeDownloader,
  });
  await controller.start();
  const trustedContext = rpcContext();
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  const cancelRes = await controller.management.executeTool(trustedContext, { name: "semantic_download", args: { cancel: true } });
  assert.equal(cancelRes.cancelled, true, "取消请求被受理");
  release();
  await settle(); await settle();
  const status = await controller.management.getStatus(trustedContext, {});
  const dl = status.diagnostics.semantic.download;
  assert.equal(sawCancel, true, "isCancelled 透传到下载器");
  assert.equal(dl.running, false, "取消后锁释放（不留半截锁）");
  assert.equal(dl.phase, "cancelled");
  assert.equal(dl.error, null, "取消不是错误");
  assert.equal(status.diagnostics.semantic.ready, false, "取消不置就绪");
  // 幂等取消：没有在跑的任务时原样返回，不报错。
  const idle = await controller.management.executeTool(trustedContext, { name: "semantic_download", args: { cancel: true } });
  assert.equal(idle.cancelled, false);
  await controller.stop();
});

test("S5 semantic_download：全源失败 → phase=error + 中文报错 + installHint（含规范目录与双源）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const fakeDownloader = {
    download: async () => ({
      ok: "error",
      attempts: [
        { source: "https://hf-mirror.com/", error: "ENOTFOUND mirror" },
        { source: "https://huggingface.co/", error: "ETIMEDOUT official" },
      ],
      error: "全部下载源均失败（共 2 个）。源 https://hf-mirror.com/：ENOTFOUND mirror；源 https://huggingface.co/：ETIMEDOUT official",
    }),
  };
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings,
    createDownloader: () => fakeDownloader,
  });
  await controller.start();
  const trustedContext = rpcContext();
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  await settle(); await settle();
  const status = await controller.management.getStatus(trustedContext, {});
  const dl = status.diagnostics.semantic.download;
  assert.equal(dl.running, false);
  assert.equal(dl.phase, "error");
  assert.match(dl.error, /全部下载源均失败/);
  assert.match(dl.error, /hf-mirror\.com/);
  assert.ok(dl.installHint, "报错卡片带安装提示词");
  assert.match(dl.installHint, /<缓存根>\/<org>\/<model>\//, "提示词写明规范目录写法");
  assert.match(dl.installHint, /models/, "提示词含本机目录");
  assert.match(dl.installHint, /Xenova\/bge-small-zh-v1\.5/);
  assert.match(dl.installHint, /huggingface\.co/, "提示词含双源地址");
  assert.match(status.diagnostics.semantic.lastError, /模型下载失败/);
  await controller.stop();
});

// 0.4 收账·复审 P2-2：installHint 依赖说明分流（controller.mjs dependencyNote）
// 与 lastError 前缀豁免两个新分支的鉴别力——把任一处判断条件改坏必须变红。
// P3-5（B 批收账）：拆成两条独立用例（各自独立 tempRoots 与 controller），
// 退化时能看到具体是哪条支路坏掉；断言内容与合体版一致、未放宽。

test("0.4 收账·RUNTIME 支：installHint 切「已装但加载失败」说明，lastError 无前缀豁免", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const trustedContext = rpcContext();
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings,
    createDownloader: () => ({
      download: async () => ({
        ok: "error",
        code: "DOWNLOAD_RUNTIME_LOAD_FAILED",
        attempts: [],
        error: "可选依赖 @huggingface/transformers 已安装，但运行时加载失败。（原始错误：EACCES: permission denied）",
      }),
    }),
  });
  await controller.start();
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  await settle(); await settle();
  const st = await controller.management.getStatus(trustedContext, {});
  const dl = st.diagnostics.semantic.download;
  assert.equal(dl.code, "DOWNLOAD_RUNTIME_LOAD_FAILED");
  assert.match(dl.installHint, /已安装，但本次运行时加载失败/, "installHint 依赖说明切到 RUNTIME 支");
  assert.match(dl.installHint, /修复依赖环境/, "RUNTIME 支给修复方向而不是 npm i");
  assert.equal(/先在插件目录执行 npm i @huggingface\/transformers 再重试/.test(dl.installHint), false,
    "RUNTIME 支不给装依赖提示（npm i 修不好加载失败）");
  assert.match(st.diagnostics.semantic.lastError, /^模型下载失败：/, "RUNTIME 码无前缀豁免");
  await controller.stop();
});

test("0.4 收账·DEPENDENCY 支：installHint 挂 npm i 装依赖提示，lastError 原样透传（前缀豁免）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const trustedContext = rpcContext();
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings,
    createDownloader: () => ({
      download: async () => ({
        ok: "error",
        code: "DOWNLOAD_DEPENDENCY_MISSING",
        attempts: [],
        error: "缺少可选依赖 @huggingface/transformers（未随插件包安装）。这不是网络问题。",
      }),
    }),
  });
  await controller.start();
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  await settle(); await settle();
  const st = await controller.management.getStatus(trustedContext, {});
  const dl = st.diagnostics.semantic.download;
  assert.equal(dl.code, "DOWNLOAD_DEPENDENCY_MISSING");
  assert.match(dl.installHint, /先在插件目录执行 npm i @huggingface\/transformers 再重试/, "DEPENDENCY 支挂装依赖提示");
  assert.equal(/已安装，但本次运行时加载失败/.test(dl.installHint), false, "DEPENDENCY 支不冒充 RUNTIME 文案");
  assert.equal(st.diagnostics.semantic.lastError,
    "缺少可选依赖 @huggingface/transformers（未随插件包安装）。这不是网络问题。",
    "lastError 前缀豁免：DEPENDENCY 码原样透传（不加「模型下载失败：」前缀）");
  await controller.stop();
});

test("S5 建索引门禁：模型未安装时 semantic_rebuild 拒绝（INVALID_STATE，文案指向下载按钮）；下载完成后放行", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  // 假下载器：落盘齐备的模型文件（真下载替身），让文件门禁放行。
  const fakeDownloader = {
    download: async ({ onProgress }) => {
      onProgress({ percent: 100, loadedBytes: 100, totalBytes: 100, filesDone: 3, filesTotal: 3 });
      await installFakeModelFiles(roots.dataRoot); // 文件齐全契约：与 :1353 同一桩（声明提升，前置用例可直接调）
      return { ok: "done", source: "https://hf-mirror.com/", attempts: [] };
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings,
    createDownloader: () => fakeDownloader,
  });
  await controller.start();
  const trustedContext = rpcContext();
  await assert.rejects(
    () => controller.management.executeTool(trustedContext, { name: "semantic_rebuild", args: {} }),
    (e) => {
      assert.equal(e.code, "INVALID_STATE");
      assert.match(e.message, /尚未安装/);
      assert.match(e.message, /下载模型/);
      return true;
    },
    "模型未安装：建索引被拦下");
  // 下载完成后（文件齐备）→ 建索引门禁放行（走到 sparkStore 列卡：空列表即成功）。
  // P0#3：done 还会自动串一次 rebuild——先等它收尾（单飞让路），再手动发起。
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  await settle(); await settle();
  assert.ok(await waitFor(async () => {
    const s = await controller.management.getStatus(trustedContext, {});
    return s.diagnostics.semantic.rebuild.running === false;
  }, 2000), "下载后自动 rebuild 收尾落地（上限 2000ms）");
  const rebuild = await controller.management.executeTool(trustedContext, { name: "semantic_rebuild", args: {} });
  assert.equal(rebuild.started, true, "模型已安装：建索引可发起");
  // S5 复审 P2 + 0.4 收账遗留 3：重建是 detached，这个 waitFor 是在等 rebuild
  // 收尾完全落地（含收尾写 retainOnly → store.save 的残余窗口，见
  // controller.mjs runSemanticRebuild 收尾注释），running 在
  // runSemanticRebuild 完全收场后才置 false，之后再 stop——避免 teardown 的
  // rm 撞上未完成的 save（Windows 上表现为 EBUSY），不是在「规避脏数据」。
  // 不许用 rm 重试糊过去。
  assert.ok(await waitFor(async () => {
    const s = await controller.management.getStatus(trustedContext, {});
    return s.diagnostics.semantic.rebuild.running === false;
  }, 2000), "重建收尾（含最终 store.save）落地（上限 2000ms）");
  await controller.stop();
});

test("S5 inert 直构：dataRoot null → modelDir null、semantic_download 拒绝（目录无法解析）", async (t) => {
  const bindings = fakeBindingsFactory();
  const settings = {
    mode: "shadow",
    semantic: {
      provider: "local",
      local: { model: "Xenova/bge-small-zh-v1.5", dims: 512, dtype: "q8", cacheDir: "", mirror: "https://hf-mirror.com/" },
      minSimilarity: 0.55,
      api: { endpoint: null, keyRef: null },
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), settings, { bindings });
  await controller.start();
  const status = await controller.management.getStatus({ session: { id: "s-1" }, source: "panel-rpc" }, {});
  assert.equal(status.diagnostics.semantic.modelDir, null, "inert 下目录不解析");
  assert.equal(status.diagnostics.semantic.modelInstalled, false);
  // inert 挂载下 management 只暴露 getStatus：executeTool 先被 NOT_CONFIGURED 拦下
  //（比 controller 内部的「目录无法解析」更早，两道门都拒绝）。
  await assert.rejects(
    () => controller.management.executeTool({ session: { id: "s-1" }, source: "panel-rpc" }, { name: "semantic_download", args: {} }),
    (e) => {
      assert.equal(e.code, "NOT_CONFIGURED");
      assert.match(e.message, /inert/);
      return true;
    },
  );
  await controller.stop();
});

// ─────────────────────────────────────────────────────────
// S5 复审（amber-review-04 attempt-1）补测：只读拒绝 / 跨 stop-restart 复位 / 取消后再下载
// ─────────────────────────────────────────────────────────

/** 与真实座位守卫同形状的只读桩：assertWritable 抛 HOST_LOCKED（diagnostics 有 status、清理有 stop）。 */
function readonlySeatGuardStub() {
  return {
    guard: {
      assertWritable() {
        const error = new Error("HOST_LOCKED: another Shiori instance holds the write lock");
        error.code = "HOST_LOCKED";
        throw error;
      },
    },
    status: () => ({ mode: "readonly", holder: "test-stub" }),
    stop: async () => {},
  };
}

test("S5 复审：只读宿主上 semantic_download / semantic_rebuild 一律 HOST_LOCKED（保留名通道与写工具同口径）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings: fakeBindingsFactory(),
    createSeatGuardFactory: () => readonlySeatGuardStub(),
  });
  await controller.start();
  const trustedContext = rpcContext();
  for (const name of ["semantic_download", "semantic_rebuild"]) {
    await assert.rejects(
      () => controller.management.executeTool(trustedContext, { name, args: {} }),
      (e) => {
        assert.equal(e.code, "HOST_LOCKED");
        assert.match(e.message, /写权/);
        return true;
      },
      `${name} 在只读宿主上必须被拒`,
    );
  }
  await controller.stop();
});

test("S5 复审：下载中 stop → 下载态复位（running=false、phase=idle）；restart 后可重新发起，旧任务收尾不覆写", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const fakeDownloader = {
    download: async ({ onProgress }) => {
      onProgress({ percent: 55, loadedBytes: 55, totalBytes: 100, filesDone: 1, filesTotal: 2 });
      await gate; // 旧任务卡在下载中，直到重启后放行
      return { ok: "done", source: "x", attempts: [] };
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings: fakeBindingsFactory(),
    createDownloader: () => fakeDownloader,
  });
  await controller.start();
  const trustedContext = rpcContext();
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  const dlOf = async () => (await controller.management.getStatus(trustedContext, {})).diagnostics.semantic.download;
  assert.equal((await dlOf()).running, true, "下载中 running=true");
  await controller.stop();
  const stoppedDl = await dlOf();
  assert.equal(stoppedDl.running, false, "stop 后不残留「下载中」");
  assert.equal(stoppedDl.phase, "idle", "stop 后回到 idle（不卡 started:false 死锁）");
  // 重启：状态仍是空闲；旧任务收尾（放行 gate）不覆写新代次状态。
  await controller.start();
  assert.equal((await dlOf()).phase, "idle", "restart 后保持 idle");
  release();
  await settle(); await settle();
  const afterOld = await dlOf();
  assert.equal(afterOld.running, false, "旧任务收尾代次不匹配：不覆写复位后的状态");
  assert.equal(afterOld.phase, "idle", "旧任务 done 结果被代次防护丢弃");
  assert.equal(
    (await controller.management.getStatus(trustedContext, {})).diagnostics.semantic.ready,
    false, "旧任务的 done 不冒充新代次就绪",
  );
  // 重启后点下载能重新发起（不再永远 started:false）。
  const restarted = await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  assert.equal(restarted.started, true, "restart 后可重新发起下载");
  assert.ok(await waitFor(async () => (await dlOf()).running === false, 2000), "新任务收尾落地");
  await controller.stop();
});

test("S5 复审：取消收场后立刻再次下载能发起（单飞锁已释放），新任务正常收尾", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  let runs = 0;
  const fakeDownloader = {
    download: async ({ onProgress }) => {
      runs += 1;
      if (runs === 1) {
        onProgress({ percent: 30, loadedBytes: 30, totalBytes: 100, filesDone: 1, filesTotal: 2 });
        await gate;
        return { ok: "cancelled", attempts: [] };
      }
      onProgress({ percent: 80, loadedBytes: 80, totalBytes: 100, filesDone: 2, filesTotal: 2 });
      return { ok: "done", source: "x", attempts: [] };
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings: fakeBindingsFactory(),
    createDownloader: () => fakeDownloader,
  });
  await controller.start();
  const trustedContext = rpcContext();
  const dlOf = async () => (await controller.management.getStatus(trustedContext, {})).diagnostics.semantic.download;
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: { cancel: true } });
  release();
  assert.ok(
    await waitFor(async () => {
      const s = await dlOf();
      return s.running === false && s.phase === "cancelled";
    }, 2000), "第一次任务以 cancelled 收场（上限 2000ms）",
  );
  // 取消收场后立刻再次下载：单飞锁已释放，能重新发起并正常收尾。
  const again = await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  assert.equal(again.started, true, "取消后可再次发起下载");
  assert.equal(runs, 2, "第二次真的创建了新下载任务");
  assert.ok(
    await waitFor(async () => {
      const s = await dlOf();
      return s.running === false && s.phase === "done";
    }, 2000), "第二次任务正常收尾 done",
  );
  assert.equal((await dlOf()).error, null);
  await controller.stop();
});

// ─────────────────────────────────────────────────────────
// P0#3（0.4 审查报告）：下载完成后自动 rebuild + 触发幂等 + 失败可见
// ─────────────────────────────────────────────────────────

/** 写齐期望模型文件（真下载收尾「文件齐全」契约的桩替身）。 */
async function installFakeModelFiles(dataRoot) {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const modelDir = path.join(dataRoot, "models", "Xenova", "bge-small-zh-v1.5");
  mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
  for (const rel of ["config.json", "tokenizer.json", "onnx/model_quantized.onnx"]) {
    writeFileSync(path.join(modelDir, ...rel.split("/")), "x");
  }
}

test("S5 P0#3：下载完成后自动 rebuild 恰好一次（计数器可观测）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const fakeDownloader = {
    download: async ({ onProgress }) => {
      onProgress({ percent: 100, loadedBytes: 100, totalBytes: 100, filesDone: 3, filesTotal: 3 });
      await installFakeModelFiles(roots.dataRoot); // done = 文件齐全（真下载收尾契约）
      return { ok: "done", source: "x", attempts: [] };
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings: fakeBindingsFactory(),
    createDownloader: () => fakeDownloader,
  });
  await controller.start();
  const trustedContext = rpcContext();
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  assert.ok(await waitFor(async () => {
    const s = await controller.management.getStatus(trustedContext, {});
    const r = s.diagnostics.semantic.rebuild;
    return r.running === false && r.phase === "done";
  }, 2000), "自动 rebuild 收尾为 done（上限 2000ms）");
  assert.equal(controller.diagnostics().counters.autoRebuildAttempts, 1, "恰好触发一次");
  const s = await controller.management.getStatus(trustedContext, {});
  assert.equal(s.diagnostics.semantic.ready, true, "done → provider 就绪");
  assert.equal(s.diagnostics.semantic.lastError, null, "空列表 rebuild 成功：不落错误");
  await controller.stop();
});

test("S5 P0#3：迟到 done（stop/restart 后任务态已复位）不触发自动 rebuild、不计数", async (t) => {
  // 旧代次任务在 stop/restart 后才收尾：cleanupGenerationInner 同步做 gen+1 与
  // resetDownloadIdle，所以完成事件到达时 stale 与 running 任一条检查都能兜住——
  // 当前结构下代次检查单独不可达。退化语义：只删 stale 或只删 running，本用例
  // 仍然绿；两者全删才会红。它钉的是「迟到 done 不拉起 rebuild」这个行为事实，
  // 不是代次闸本身（trigger 里保留的代次闸是纵深防御，结构上不可达，见
  // controller.mjs triggerAutoRebuildAfterDownload 注释）。
  const roots2 = await tempRoots();
  t.after(roots2.cleanup);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const gatedDownloader = {
    download: async ({ onProgress }) => {
      onProgress({ percent: 55, loadedBytes: 55, totalBytes: 100, filesDone: 1, filesTotal: 2 });
      await gate;
      return { ok: "done", source: "x", attempts: [] };
    },
  };
  const controller2 = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots2), {
    bindings: fakeBindingsFactory(),
    createDownloader: () => gatedDownloader,
  });
  await controller2.start();
  const trusted2 = rpcContext();
  await controller2.management.executeTool(trusted2, { name: "semantic_download", args: {} });
  await controller2.stop();
  await controller2.start();
  release(); // 旧代次任务的 done 此刻才到达（迟到完成事件）
  await settle(); await settle();
  assert.equal(controller2.diagnostics().counters.autoRebuildAttempts, 0, "迟到 done 不触发");
  const s2 = await controller2.management.getStatus(trusted2, {});
  assert.equal(s2.diagnostics.semantic.rebuild.phase, "idle", "rebuild 保持 idle（未被迟到的完成事件拉起）");
  await controller2.stop();
});

test("S5 P0#3：banned 窗口内迟到 done 不触发自动 rebuild（autoRebuildAttempts 保持 0）", async (t) => {
  // 真实可达窗口：stop() 的 sync prefix（banned=true）与 cleanupGeneration 真正
  // +1 代次之间隔一个微任务。构造：downloader 在 gate 放行后返回 thenable，
  // then 里先 res(done)（排队 runSemanticDownload 的续体）再同步调 stop()——
  // stop 的 gen+1 微任务排在续体之后，续体运行时 stale() 尚看不出代次已换。
  // 没有 trigger 开头的 banned/started 闸，此用例变红：attempts=1 且 rebuild
  // 真的被拉起（夹具已落盘模型文件，文件门禁放行 → phase 不再是 idle）。
  const roots = await tempRoots();
  t.after(roots.cleanup);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  let controller = null;
  const fakeDownloader = {
    download: async ({ onProgress }) => {
      onProgress({ percent: 100, loadedBytes: 100, totalBytes: 100, filesDone: 3, filesTotal: 3 });
      await installFakeModelFiles(roots.dataRoot); // 文件门禁放行：删守卫时 rebuild 真会跑
      await gate;
      return {
        then: (res) => {
          res({ ok: "done", source: "x", attempts: [] }); // 先排队 done 续体
          void controller.stop().catch(() => {}); // 再同步置 banned=true（gen+1 微任务排在续体之后）
        },
      };
    },
  };
  controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings: fakeBindingsFactory(),
    createDownloader: () => fakeDownloader,
  });
  await controller.start();
  const trustedContext = rpcContext();
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  release(); // 放行 gate → thenable 路径开始
  await settle(); await settle();
  assert.ok(controller.diagnostics().banned, "窗口路径已把控制器置为 banned（stop 已发起）");
  await controller.stop(); // 幂等收尾（窗口内已调过一次 stop）
  assert.equal(controller.diagnostics().counters.autoRebuildAttempts, 0,
    "banned 窗口内的迟到 done 不触发自动 rebuild");
  // 等（若守卫被删而被拉起的）rebuild 收尾落地，避免 teardown rm 撞 store.save；
  // 守卫在位时 rebuild 从未运行，此等待即刻通过。
  assert.ok(await waitFor(async () => {
    const s = await controller.management.getStatus(trustedContext, {});
    return s.diagnostics.semantic.rebuild.running === false;
  }, 2000), "rebuild 若被拉起须先收尾（上限 2000ms）");
  const s = await controller.management.getStatus(trustedContext, {});
  assert.equal(s.diagnostics.semantic.rebuild.phase, "idle", "rebuild 保持 idle（未被拉起）");
});

test("S5 P0#3：自动 rebuild 失败落面板可见错误（不静默）——门禁拒绝时 lastError 带触发前缀", async (t) => {
  // 桩 done 但不落盘模型文件（模拟「收尾校验被绕过」的异常路径）：自动触发的
  // rebuild 被文件门禁同步拒绝 → catch 落 lastError，面板可见，绝不静默。
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const fakeDownloader = {
    download: async ({ onProgress }) => {
      onProgress({ percent: 100, loadedBytes: 100, totalBytes: 100, filesDone: 3, filesTotal: 3 });
      return { ok: "done", source: "x", attempts: [] }; // 不写文件（异常路径）
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings: fakeBindingsFactory(),
    createDownloader: () => fakeDownloader,
  });
  await controller.start();
  const trustedContext = rpcContext();
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  assert.ok(await waitFor(async () => {
    const s = await controller.management.getStatus(trustedContext, {});
    return s.diagnostics.semantic.lastError !== null;
  }, 2000), "触发期失败落到 lastError（上限 2000ms）");
  const s = await controller.management.getStatus(trustedContext, {});
  assert.equal(s.diagnostics.semantic.download.phase, "done", "下载本体仍按 done 收尾");
  assert.match(s.diagnostics.semantic.lastError, /下载后自动重建向量失败/, "触发前缀可诊断");
  assert.match(s.diagnostics.semantic.lastError, /尚未安装/, "门禁拒绝文案透传");
  assert.equal(controller.diagnostics().counters.autoRebuildAttempts, 1, "失败也如实计数（触发发生过）");
  await controller.stop();
});
