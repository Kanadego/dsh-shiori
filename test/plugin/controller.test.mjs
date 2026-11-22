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
import { openSemanticVectorStore } from "../../src/semantic/store.mjs";
import { mergeSemanticRecall } from "../../src/sparks/semantic-recall.mjs";
import { openSparkStore } from "../../src/sparks/store.mjs";
import { pinScope } from "../../src/plugin/scope.mjs";

// 0.4-S1（reviewer P3）：测试入口统一注入 DSH_HOME=临时目录——0.4 起缺省根会真实
// mkdir（scope.mjs 直构缺根补默认同样落默认路径），不注入会写到真实 ~/.dsh。
const DSH_HOME_TMP = await mkdtemp(path.join(tmpdir(), "shiori-p5-ctrl-dsh-"));
process.env.DSH_HOME = DSH_HOME_TMP;
test.after(() => rm(DSH_HOME_TMP, { recursive: true, force: true }));

/** 可编程合成 bindings：记录注册并支持注入失败。 */
function fakeBindingsFactory({ failOn = null, disposeErrors = [], disposeThrows = null } = {}) {
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
      if (disposeThrows !== null) throw disposeThrows;
      return { disposed: true, errors: [...disposeErrors] };
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

// 规格连带：工具面 17→19（0.5-5C 新增 spark_link/spark_unlink；白名单批复
// wlreq-5b550817a9bf386d 边界 ②）——本用例的工具面计数断言与用例名同步 17→19，
// 其余断言原样不动。
test("active start 注册 19 工具 + 2 section + waterfall；工具输出 schema 覆盖真实成功分支（无空闭合 schema）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  const started = await controller.start();
  assert.deepEqual([...bindings.registered.sections].sort(), ["shiori:core", "shiori:persona"]);
  assert.equal(bindings.registered.waterfall !== null, true);
  assert.equal(bindings.registered.tools.length, 19); // 规格连带：工具面 17→19
  assert.deepEqual(started.tools.length, 19); // 规格连带：工具面 17→19
  // 19 工具名与契约清单逐一对齐；每个都有非空 output schema 且非空闭合对象。
  assert.deepEqual(TOOL_NAMES.length, 19); // 规格连带：工具面 17→19
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
  assert.equal(started.tools.length, 19); // 工具与 L2 不受影响（规格连带：工具面 17→19）
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
  assert.equal(started.tools.length, 19); // 规格连带：工具面 17→19
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

test("S3 active start：scope 的 groups.json 按默认模板初始化（单组 general）；group_manage 在工具面", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  const started = await controller.start();
  assert.ok(started.tools.includes("group_manage"), "group_manage 在 19 工具面"); // 规格连带：工具面 17→19
  const groupsFile = path.join(roots.dataRoot, "scopes", "amber", "groups.json");
  await access(groupsFile); // active 启动即初始化（缺文件才写）
  const data = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(groupsFile, "utf8")));
  assert.equal(data.version, 1);
  assert.deepEqual(data.groups.map((g) => g.key).sort(), ["general"]);
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
  // 历史窗口：本次改动前，stop() 的 sync prefix（banned=true）与 cleanupGeneration
  // 真正 +1 代次之间隔一个微任务——构造：downloader 在 gate 放行后返回 thenable，
  // then 里先 res(done)（排队 runSemanticDownload 的续体）再同步调 stop()，续体
  // 运行时 stale() 尚看不出代次已换。0.4 收尾把代次失效挪进 stop 同步段后窗口已
  // 关闭，本用例保留为回归钉：迟到 done 一律不拉起 rebuild。若把同步段的代次失效
  // 回退，这里仍由 trigger 的 banned 闸兜住（断言不变，行为事实不变）。
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

test("0.4 收尾：stop() 的同步段即完成代次失效（不 +2）并复位下载态", async (t) => {
  // 判别力（两道）：
  // ① 同步段——把 invalidateDownloadGeneration() 挪回 cleanupGenerationInner（回退
  //    本次改动）时，stop() 之后、await 之前读到的代次仍是旧值，第一条断言变红；
  // ② 不 +2——若 stop 同步段 +1 之后 cleanupGenerationInner 又补一次，最后那条
  //    「仍等于 genBefore+1」的断言变红。
  // 下载 snapshot 的形状被 deepEqual 钉死（不能加字段），故代次走 controller.diagnostics()。
  const roots = await tempRoots();
  t.after(roots.cleanup);
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const fakeDownloader = {
    download: async ({ onProgress }) => {
      onProgress({ percent: 40, loadedBytes: 40, totalBytes: 100, filesDone: 1, filesTotal: 2 });
      await gate;
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
  const before = await controller.management.getStatus(trustedContext, {});
  assert.equal(before.diagnostics.semantic.download.running, true, "下载中 running=true");
  const genBefore = controller.diagnostics().downloadGeneration;

  const stopping = controller.stop(); // 不 await：只跑同步段就检查
  assert.equal(controller.diagnostics().banned, true, "同步段已置 banned");
  assert.equal(controller.diagnostics().downloadGeneration, genBefore + 1,
    "stop() 首个 await 之前代次已 +1（banned/代次窗口关闭）");

  release(); // 旧代次任务此刻才收尾：stale() 立即可见，done 不许写回
  await stopping;
  await settle(); await settle();
  assert.equal(controller.diagnostics().downloadGeneration, genBefore + 1,
    "同一代清理不再 +2（每次清理恰 +1）");
  const after = await controller.management.getStatus(trustedContext, {});
  assert.equal(after.diagnostics.semantic.download.running, false, "stop 返回后不残留 running=true");
  assert.equal(after.diagnostics.semantic.download.phase, "idle", "迟到 done 不覆写复位后的状态");
  assert.equal(after.diagnostics.semantic.ready, false, "迟到 done 不冒充新代次就绪");
});

test("0.4 收尾：下载后自动 rebuild 走 force 全量路径——注入计数桩 provider，与可选依赖解耦", async (t) => {
  // 造一张 active 卡 + 预置一份 revision 与之匹配的旧向量（旧模型存量），然后
  // 触发下载完成。force/增量两条分支的可观测分叉用注入的计数桩 provider 度量
  // （reviewer attempt-1 必修 2：不再依赖「可选依赖未安装 → embed 快速失败」
  // 这一环境事实，标准 npm install 装上 @huggingface/transformers 也不受影响）：
  //   force（下载后自动重建）：先 store.clear() → revision 未变也必须重算 →
  //     embed 桩被调用 ≥1 次；
  //   增量（面板手动重建，对照组）：revision 未变 → 直接沿用现有向量 →
  //     embed 桩零调用。
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const settings = localSemanticSettings(roots);
  const dims = settings.semantic.local.dims;
  let embedCalls = 0;
  const stubProvider = {
    kind: "local",
    dims,
    embed: async () => {
      embedCalls += 1;
      return new Float32Array(dims); // 零向量即可（本用例不关心相似度）
    },
  };
  const fakeDownloader = {
    download: async ({ onProgress }) => {
      onProgress({ percent: 100, loadedBytes: 100, totalBytes: 100, filesDone: 3, filesTotal: 3 });
      await installFakeModelFiles(roots.dataRoot); // done = 文件齐全（真下载收尾契约）
      return { ok: "done", source: "x", attempts: [] };
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), settings, {
    bindings: fakeBindingsFactory(),
    createDownloader: () => fakeDownloader,
    createEmbeddingProvider: () => stubProvider, // 0.4 收尾新增 seam
  });
  await controller.start();
  const trustedContext = rpcContext();
  const saved = await controller.management.executeTool(trustedContext, {
    name: "spark_save", args: { title: "卡一", content: "正文内容", triggers: [], vitality: "evergreen" },
  });
  assert.equal(saved.ok, true, "卡片落库");
  assert.ok(typeof saved.id === "string" && saved.id.length > 0, "拿到卡片 id");
  assert.ok(Number.isInteger(saved.revision) && saved.revision >= 0, "拿到卡片 revision");
  // 预置旧向量：与卡片同 id 同 revision（增量分支会据此跳过 embed 的那份存量）。
  // 落点与控制器同契约：<stateRoot>/semantic/<scopeId>.json；scopeId 用与
  // scopeFromTrustedContext 同一入口 pinScope 按 (settings, sessionId) 推导。
  const scopeId = pinScope({
    settings: { ...settings, sessionPersonas: [], workspacePersonas: [] },
    sessionId: "s-panel", workspace: null, generation: 1, source: "panel-rpc",
  }).scopeId;
  const seed = await openSemanticVectorStore({
    stateRoot: roots.stateRoot, scopeId,
    model: settings.semantic.local.model, dims,
  });
  seed.upsert(saved.id, saved.revision, new Array(dims).fill(0));
  await seed.save();
  seed.close();
  assert.equal(embedCalls, 0, "预置阶段不动桩");
  // ── 主张：下载完成 → 自动 rebuild 走 force 全量 ──
  await controller.management.executeTool(trustedContext, { name: "semantic_download", args: {} });
  assert.ok(await waitFor(async () => {
    const st = await controller.management.getStatus(trustedContext, {});
    const r = st.diagnostics.semantic.rebuild;
    return r.running === false && r.phase === "done";
  }, 2000), "自动 rebuild 以 done 收尾（桩 embed 必成功，上限 2000ms）");
  assert.ok(embedCalls >= 1, `force 全量：revision 未变的卡也被清掉重算（embed 桩被调用，实际 ${embedCalls} 次）`);
  assert.equal(controller.diagnostics().counters.autoRebuildAttempts, 1, "恰好触发一次");
  // ── 对照组：面板手动重建走增量，revision 未变 → embed 零调用 ──
  const before = embedCalls;
  const manual = await controller.management.executeTool(trustedContext, { name: "semantic_rebuild", args: {} });
  assert.equal(manual.started, true, "手动重建能发起（单飞锁已释放）");
  assert.ok(await waitFor(async () => {
    const st = await controller.management.getStatus(trustedContext, {});
    const r = st.diagnostics.semantic.rebuild;
    return r.running === false && r.phase === "done";
  }, 2000), "手动 rebuild 以 done 收尾（上限 2000ms）");
  assert.equal(embedCalls, before, "手动重建走增量：revision 未变直接沿用现有向量，embed 桩零调用");
  await controller.stop();
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

// ─────────────────────────────────────────────────────────
// 0.5 · 写后增量向量 + 单飞并发防线 + 启动差集兜底（controller 级集成）
//
// 背景：0.4 及以前向量只在 runSemanticRebuild 里建——spark_save / spark_update /
// spark_forget 的写路径没有向量维护钩子，新卡与改过的卡永久落选。0.5 在
// controller 接线（src/semantic/incremental.mjs 是队列本体）：写工具成功 →
// markDirty（同步零 IO）→ 防抖批量 embed → upsert → 落盘；与重建共用单飞闸；
// scope 首次打开索引时启动差集兜底。provider 关闭时逐字节保持 0.4 行为。
// ─────────────────────────────────────────────────────────

/** 0.5 集成桩：确定性字符桶 embedding——同主题转述共享大量字符 → 高余弦；
 *  无关语句字符桶几乎不相交 → 低余弦。calls 记每次成功调用（顺序保留）。 */
function charBucketStubProvider(dims = 32) {
  const calls = [];
  return {
    kind: "local",
    dims,
    calls,
    async embed(text) {
      calls.push(text);
      const vec = new Float32Array(dims);
      for (const ch of text) vec[ch.codePointAt(0) % dims] += 1;
      return vec;
    },
  };
}

/** 0.5 集成设置：active + local 语义 + 阈值 0.3（字符桶桩的正/负样本间距按此校准：
 *  转述对 ≈0.68–0.71，无关对 ≈0–0.15）。 */
const incrementalSemanticSettings = (roots) => {
  const settings = localSemanticSettings(roots);
  settings.semantic = { ...settings.semantic, minSimilarity: 0.3 };
  return settings;
};

/** 与 controller 同口径推导面板会话的 scopeId（既有用例同款入口）。 */
const scopeIdForPanel = (settings) => pinScope({
  settings: { ...settings, sessionPersonas: [], workspacePersonas: [] },
  sessionId: "s-panel", workspace: null, generation: 1, source: "panel-rpc",
}).scopeId;

/** 只读快照：另开索引实例读单条（fresh open，读的永远是磁盘真值）。 */
async function readIndexEntry(roots, scopeId, settings, sparkId) {
  const store = await openSemanticVectorStore({
    stateRoot: roots.stateRoot, scopeId,
    model: settings.semantic.local.model, dims: settings.semantic.local.dims,
  });
  try {
    return store.get(sparkId);
  } finally {
    store.close();
  }
}

/** 只读快照：索引条目总数。 */
async function readIndexSize(roots, scopeId, settings) {
  const store = await openSemanticVectorStore({
    stateRoot: roots.stateRoot, scopeId,
    model: settings.semantic.local.model, dims: settings.semantic.local.dims,
  });
  try {
    return store.size();
  } finally {
    store.close();
  }
}

/** 真实召回合并层直调（spark 数据与索引文件都取磁盘真值）：证明「controller 维护
 *  的索引」在 mergeSemanticRecall 的新鲜度判据下可用，而非仅文件存在。 */
async function recallAgainst(roots, scopeId, settings, provider, query) {
  const sparkStore = await openSparkStore({ root: roots.dataRoot, scopeId });
  let sparks;
  try {
    sparks = await sparkStore.listActive();
  } finally {
    sparkStore.close();
  }
  const vectorStore = await openSemanticVectorStore({
    stateRoot: roots.stateRoot, scopeId,
    model: settings.semantic.local.model, dims: settings.semantic.local.dims,
  });
  try {
    return await mergeSemanticRecall({
      scopeId,
      userText: query,
      sparks,
      seenKeys: [],
      sessionId: "recall-probe",
      contextEpoch: 0,
      maxSeeds: 3,
      maxRelated: 2,
      provider,
      vectorsFor: (sparkId) => vectorStore.get(sparkId),
      threshold: settings.semantic.minSimilarity,
    });
  } finally {
    vectorStore.close();
  }
}

/** 事件门控等待：写后增量轮完全收场（running=false 且 pending=0 且指标到位）。 */
const waitForIncrementalSettled = async (controller, trustedContext, predicate, capMs = 4000) => {
  return waitFor(async () => {
    const s = (await controller.management.getStatus(trustedContext, {}))
      .diagnostics.semantic.incremental;
    return s.running === false && s.pending === 0 && s.lastFlushAt !== null && predicate(s);
  }, capMs);
};

test("0.5 写后增量：spark_save 成功即入队，防抖批处理后索引新鲜——转述 query 语义召回命中（全程不手动 rebuild）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  await installFakeModelFiles(roots.dataRoot); // canEmbed 门禁放行（桩 provider 不真加载模型）
  const settings = incrementalSemanticSettings(roots);
  const provider = charBucketStubProvider(settings.semantic.local.dims);
  const controller = await createShioriPluginController(fakeCtx(), settings, {
    bindings: fakeBindingsFactory(),
    createEmbeddingProvider: () => provider,
    semanticIncrementalDebounceMs: 20,
  });
  await controller.start();
  const trustedContext = rpcContext();
  // triggers=[]：字面召回恒空——seeds 只可能来自向量补位，证明力最纯。
  const saved = await controller.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "团建", content: "榴莲披萨好吃", triggers: [], vitality: "evergreen" },
  });
  assert.equal(saved.ok, true, "写路径零报错（工具回执原样）");
  assert.ok(await waitForIncrementalSettled(controller, trustedContext, (s) => s.embedded === 1 && s.flushes >= 1),
    "写后增量轮收尾落地（防抖后批量 embed → upsert → 落盘）");
  // 索引新鲜：不手动 rebuild，新卡已入索引且 revision 与卡对齐。
  const scopeId = scopeIdForPanel(settings);
  const entry = await readIndexEntry(roots, scopeId, settings, saved.id);
  assert.ok(entry !== null, "新卡不手动 rebuild 也能入索引");
  assert.equal(entry.revision, saved.revision);
  // 转述表述（只改说法，不命中任何 trigger）→ 语义召回命中。
  const recall = await recallAgainst(roots, scopeId, settings, provider, "想吃榴莲披萨");
  assert.equal(recall.semantic.enabled, true);
  assert.equal(recall.semantic.used, true, "向量补位真的被用上");
  assert.ok(recall.match.seeds.some((s) => s.id === saved.id), "含转述表述的对话靠语义召回命中新卡");
  // 无关 query：同桩低余弦，不误命中（正负样本分界有效）。
  const miss = await recallAgainst(roots, scopeId, settings, provider, "打印报销单");
  assert.equal(miss.semantic.used, false, "无关表述不误命中");
  await controller.stop();
});

test("0.5 spark_update 改 content：新 revision 覆盖旧向量——新表述可召回、旧表述不再命中", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  await installFakeModelFiles(roots.dataRoot);
  const settings = incrementalSemanticSettings(roots);
  const provider = charBucketStubProvider(settings.semantic.local.dims);
  const controller = await createShioriPluginController(fakeCtx(), settings, {
    bindings: fakeBindingsFactory(),
    createEmbeddingProvider: () => provider,
    semanticIncrementalDebounceMs: 20,
  });
  await controller.start();
  const trustedContext = rpcContext();
  const saved = await controller.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "团建", content: "榴莲披萨好吃", triggers: [], vitality: "evergreen" },
  });
  assert.ok(await waitForIncrementalSettled(controller, trustedContext, (s) => s.embedded === 1));
  const scopeId = scopeIdForPanel(settings);
  const before = await recallAgainst(roots, scopeId, settings, provider, "想吃榴莲披萨");
  assert.ok(before.match.seeds.some((s) => s.id === saved.id), "改前旧表述可召回（前置确认）");
  const updated = await controller.management.executeTool(trustedContext, {
    name: "spark_update",
    args: { id: saved.id, patch: { content: "珍珠奶茶" } },
  });
  assert.equal(updated.ok, true, "更新零报错");
  assert.ok(await waitForIncrementalSettled(controller, trustedContext, (s) => s.embedded === 2),
    "更新后增量轮收尾（重嵌新内容）");
  const entry = await readIndexEntry(roots, scopeId, settings, saved.id);
  assert.equal(entry.revision, updated.revision, "索引 revision 跟上更新");
  const oldHit = await recallAgainst(roots, scopeId, settings, provider, "想吃榴莲披萨");
  assert.equal(oldHit.match.seeds.length, 0, "旧表述向量已被覆盖：不再命中");
  assert.equal(oldHit.semantic.used, false);
  const newHit = await recallAgainst(roots, scopeId, settings, provider, "来杯珍珠奶茶");
  assert.ok(newHit.match.seeds.some((s) => s.id === saved.id), "新表述靠语义召回命中");
  await controller.stop();
});

test("0.5 spark_forget：索引同步剔除，无残留条目", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  await installFakeModelFiles(roots.dataRoot);
  const settings = incrementalSemanticSettings(roots);
  const provider = charBucketStubProvider(settings.semantic.local.dims);
  const controller = await createShioriPluginController(fakeCtx(), settings, {
    bindings: fakeBindingsFactory(),
    createEmbeddingProvider: () => provider,
    semanticIncrementalDebounceMs: 20,
  });
  await controller.start();
  const trustedContext = rpcContext();
  const saved = await controller.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "团建", content: "榴莲披萨好吃", triggers: [], vitality: "evergreen" },
  });
  assert.ok(await waitForIncrementalSettled(controller, trustedContext, (s) => s.embedded === 1));
  const scopeId = scopeIdForPanel(settings);
  assert.ok(await readIndexEntry(roots, scopeId, settings, saved.id) !== null, "forget 前条目在索引");
  const forgotten = await controller.management.executeTool(trustedContext, {
    name: "spark_forget",
    args: { id: saved.id, mode: "archive" },
  });
  assert.equal(forgotten.ok, true, "forget 零报错");
  assert.ok(await waitForIncrementalSettled(controller, trustedContext, (s) => s.removed === 1),
    "forget 后增量轮收尾（剔除）");
  const entry = await readIndexEntry(roots, scopeId, settings, saved.id);
  assert.equal(entry, null, "索引无残留条目（内存与磁盘一致）");
  assert.equal(await readIndexSize(roots, scopeId, settings), 0);
  await controller.stop();
});

test("0.5 降级 provider=none：写路径零报错、不产生向量文件、incremental 诊断恒空转", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), {
    bindings: fakeBindingsFactory(),
  });
  await controller.start();
  const trustedContext = rpcContext();
  const saved = await controller.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "普通卡", content: "与语义无关的写路径", triggers: [], vitality: "evergreen" },
  });
  assert.equal(saved.ok, true, "provider 关闭：写路径零报错（0.4 行为逐字节不变）");
  const semantic = (await controller.management.getStatus(trustedContext, {})).diagnostics.semantic;
  assert.deepEqual(semantic.incremental, {
    enabled: false, pending: null, running: false, flushes: 0, embedded: 0, removed: 0,
    startupSyncs: 0, lastFlushAt: null, lastSyncAt: null, lastError: null, lastSkipReason: null,
  }, "provider 关闭：增量诊断恒空转快照");
  assert.equal(await fileExists(path.join(roots.stateRoot, "semantic")), false,
    "provider 关闭绝不产生向量文件");
  await controller.stop();
});

test("0.5 降级 模型未装：写路径零报错、增量挂起可诊断、不写索引文件", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  // 真实 provider（不注入桩），模型未安装：embed 不可用但写路径必须零报错。
  const controller = await createShioriPluginController(fakeCtx(), localSemanticSettings(roots), {
    bindings: fakeBindingsFactory(),
    semanticIncrementalDebounceMs: 20,
  });
  await controller.start();
  const trustedContext = rpcContext();
  const saved = await controller.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "模型未装", content: "写路径照常成功", triggers: [], vitality: "evergreen" },
  });
  assert.equal(saved.ok, true, "写路径零报错");
  assert.ok(await waitFor(async () => {
    const s = (await controller.management.getStatus(trustedContext, {})).diagnostics.semantic.incremental;
    return s.lastSkipReason === "model-not-installed" && s.pending === 1 && s.flushes >= 1;
  }, 4000), "降级原因可见（model-not-installed）、pending 保留待模型就绪");
  const s = (await controller.management.getStatus(trustedContext, {})).diagnostics.semantic.incremental;
  assert.equal(s.lastError, null, "降级不是失败：lastError 不留痕");
  assert.equal(await fileExists(path.join(roots.stateRoot, "semantic")), false,
    "模型未装：不打开索引不落盘（skip 发生在 openVectorStore 之前）");
  await controller.stop();
});

test("0.5 交错防线：force 重建持闸期间增量只标 dirty（索引零写），收尾后差集补齐无覆盖/误删", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  await installFakeModelFiles(roots.dataRoot);
  const settings = incrementalSemanticSettings(roots);
  const dims = settings.semantic.local.dims;
  // 闸控桩：holdSlowEmbeds 置真后，含「慢卡」的嵌入挂起直到放行——模拟重建慢卡。
  let holdSlowEmbeds = false;
  let releaseRebuild = null;
  const rebuildGate = new Promise((resolve) => { releaseRebuild = resolve; });
  let slowEmbedCalls = 0;
  const provider = {
    kind: "local",
    dims,
    async embed(text) {
      if (holdSlowEmbeds && text.includes("慢卡")) {
        slowEmbedCalls += 1;
        await rebuildGate;
      }
      const vec = new Float32Array(dims);
      for (const ch of text) vec[ch.codePointAt(0) % dims] += 1;
      return vec;
    },
  };
  const controller = await createShioriPluginController(fakeCtx(), settings, {
    bindings: fakeBindingsFactory(),
    createEmbeddingProvider: () => provider,
    semanticIncrementalDebounceMs: 20,
  });
  await controller.start();
  const trustedContext = rpcContext();
  const savedFast = await controller.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "快卡", content: "榴莲披萨好吃", triggers: [], vitality: "evergreen" },
  });
  assert.ok(await waitForIncrementalSettled(controller, trustedContext, (s) => s.embedded === 1));
  const savedSlow = await controller.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "慢卡", content: "珍珠奶茶", triggers: [], vitality: "evergreen" },
  });
  assert.ok(await waitForIncrementalSettled(controller, trustedContext, (s) => s.embedded === 2 && s.startupSyncs >= 1),
    "两张卡都已增量入索引（首次开索引的启动差集也已收场）");
  // 发起 force 全量重建（detached），并让重建对「慢卡」的嵌入挂起持闸。
  holdSlowEmbeds = true;
  const rebuild = await controller.management.executeTool(trustedContext, {
    name: "semantic_rebuild", args: { force: true },
  });
  assert.equal(rebuild.started, true);
  assert.ok(await waitFor(async () => {
    const r = (await controller.management.getStatus(trustedContext, {})).diagnostics.semantic.rebuild;
    return r.running === true && slowEmbedCalls >= 1;
  }, 4000), "重建已持闸并卡在慢卡嵌入");
  // 重建持闸期间写新卡：只标 dirty，flush 轮启动后被闸拦下，索引零写。
  const savedNew = await controller.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "新卡", content: "打印报销单", triggers: [], vitality: "evergreen" },
  });
  assert.ok(await waitFor(async () => {
    const s = (await controller.management.getStatus(trustedContext, {})).diagnostics.semantic.incremental;
    return s.running === true && s.pending === 1;
  }, 4000), "增量轮已启动并被闸拦下（重建中只标 dirty）");
  assert.equal(await readIndexEntry(roots, scopeIdForPanel(settings), settings, savedNew.id), null,
    "持闸期间索引零写（严禁与 clear/retainOnly 交错）");
  releaseRebuild();
  assert.ok(await waitFor(async () => {
    const r = (await controller.management.getStatus(trustedContext, {})).diagnostics.semantic.rebuild;
    return r.running === false && r.phase === "done";
  }, 4000), "force 重建以 done 收尾");
  assert.ok(await waitForIncrementalSettled(controller, trustedContext, (s) => s.embedded === 3),
    "锁释放后按差集补齐新卡");
  const scopeId = scopeIdForPanel(settings);
  assert.equal(await readIndexSize(roots, scopeId, settings), 3, "三张卡俱全（无误删）");
  assert.equal((await readIndexEntry(roots, scopeId, settings, savedFast.id)).revision, savedFast.revision,
    "重建重嵌不覆盖 revision（无覆盖）");
  assert.equal((await readIndexEntry(roots, scopeId, settings, savedSlow.id)).revision, savedSlow.revision);
  assert.equal((await readIndexEntry(roots, scopeId, settings, savedNew.id)).revision, savedNew.revision,
    "重建快照外的新卡由增量差集补齐");
  await controller.stop();
});

test("0.5 启动差集兜底：重启后索引与卡片漂移（过期 revision + 幽灵残留）在 scope 首开索引时后台修复", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  await installFakeModelFiles(roots.dataRoot);
  const settings = incrementalSemanticSettings(roots);
  const dims = settings.semantic.local.dims;
  // 第一段：正常写入一张卡并等增量收尾，然后停机。
  const controller1 = await createShioriPluginController(fakeCtx(), settings, {
    bindings: fakeBindingsFactory(),
    createEmbeddingProvider: () => charBucketStubProvider(dims),
    semanticIncrementalDebounceMs: 20,
  });
  await controller1.start();
  const trustedContext = rpcContext();
  const saved = await controller1.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "团建", content: "榴莲披萨好吃", triggers: [], vitality: "evergreen" },
  });
  assert.ok(await waitForIncrementalSettled(controller1, trustedContext, (s) => s.embedded === 1));
  await controller1.stop();
  // 制造漂移（绕过钩子，模拟外部写者）：裸 store 改一版（revision +1，索引没跟上），
  // 再往索引塞一个幽灵残留条目。
  const scopeId = scopeIdForPanel(settings);
  const bare = await openSparkStore({ root: roots.dataRoot, scopeId });
  let updated;
  try {
    updated = await bare.update(saved.id, { content: "榴莲披萨加菠萝" }, {});
  } finally {
    bare.close();
  }
  const drift = await openSemanticVectorStore({
    stateRoot: roots.stateRoot, scopeId,
    model: settings.semantic.local.model, dims,
  });
  try {
    drift.upsert("sp-ghost", 1, new Float32Array(dims).fill(0.5));
    await drift.save();
  } finally {
    drift.close();
  }
  // 第二段：新控制器（同 roots）。首次打开索引由下一张卡的写后增量 flush 触发，
  // 打开即 kick 启动差集兜底：过期 revision 后台补嵌、幽灵 retainOnly 剔除。
  const controller2 = await createShioriPluginController(fakeCtx(), settings, {
    bindings: fakeBindingsFactory(),
    createEmbeddingProvider: () => charBucketStubProvider(dims),
    semanticIncrementalDebounceMs: 20,
  });
  await controller2.start();
  const saved2 = await controller2.management.executeTool(trustedContext, {
    name: "spark_save",
    args: { title: "会议室", content: "打印报销单", triggers: [], vitality: "evergreen" },
  });
  assert.equal(saved2.ok, true);
  assert.ok(await waitFor(async () => {
    const store = await openSemanticVectorStore({
      stateRoot: roots.stateRoot, scopeId,
      model: settings.semantic.local.model, dims,
    });
    try {
      const drifted = store.get(saved.id);
      const ghost = store.get("sp-ghost");
      const fresh = store.get(saved2.id);
      return drifted !== null && drifted.revision === updated.revision
        && ghost === null
        && fresh !== null && fresh.revision === saved2.revision;
    } finally {
      store.close();
    }
  }, 6000), "启动差集兜底在后台修复漂移：过期卡补嵌、幽灵剔除、新卡入索引");
  const inc = (await controller2.management.getStatus(trustedContext, {})).diagnostics.semantic.incremental;
  assert.ok(inc.startupSyncs >= 1, "启动差集轮可观测（诊断可见）");
  await controller2.stop();
});

// ---------------------------------------------------------------------------
// 0.5-2B：topic-activity 事件账本接线（R3）——controller 是生产接线点。
// 用真实 createTopicActivityLedger（真实 stateRoot 落盘）验证：两个 scope 交叉
// 操作的事件按 targetScopeId 归属；写失败（账本路径被目录占位）只进诊断、工具
// 照常返回。真实账本的行级语义由 test/storage/topic-activity.test.mjs 覆盖。
// ---------------------------------------------------------------------------

import { mkdir as actMkdir, stat as actStat } from "node:fs/promises";
import { readTopicActivity, topicActivityFilePath } from "../../src/storage/topic-activity.mjs";

test("0.5-2B 接线：两个 scope 交叉操作 → 四类事件按 targetScopeId 归属（组目录端到端）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const workspaceDir = path.join(roots.base, "project-bravo");
  const ctx = {
    systemPrompt: { section: () => () => {} },
    tools: { register: () => () => {} },
    on: () => () => {},
    // 宿主 workingDirectory 服务（只读 get；s-ws 会话路由到 bravo 卡 scope）。
    workingDirectory: { get: (session) => (session?.id === "s-ws" ? workspaceDir : path.join(roots.base, "other")) },
  };
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(ctx, {
    ...activeSettings(roots),
    defaultPersona: "amber",
    workspacePersonas: [{ workspace: workspaceDir, persona: "bravo" }],
  }, { bindings });
  await controller.start();

  // 账本诊断可见（stateRoot 已配置 → 账本存在，落点即 <stateRoot>/topic-activity.jsonl）。
  const d0 = controller.diagnostics();
  assert.ok(d0.topicActivity !== null && typeof d0.topicActivity.appended === "number");
  assert.equal(d0.topicActivity.file, topicActivityFilePath(roots.stateRoot));

  const wsContext = { session: { id: "s-ws" }, agent: { session: { id: "s-ws" } }, source: "panel-rpc" };
  const amberContext = { session: { id: "s-other" }, agent: { session: { id: "s-other" } }, source: "panel-rpc" };

  // 交叉序列（bravo 与 amber 交替操作，事件必须各归各的 targetScopeId）：
  //  1 bravo topic_create        → updated@bravo
  //  2 amber memory_read{}       → read@amber（core 无 topicKey）
  //  3 amber topic_create        → updated@amber
  //  4 amber memory_search       → search_hit@amber
  //  5 bravo memory_read         → read@bravo
  //  6 amber group_manage create → 不在接线清单：零事件
  //  7 amber topic_create(group) → updated@amber
  //  8 amber memory_read 组目录  → group_list@amber
  const createdBravo = await controller.management.executeTool(wsContext, {
    name: "topic_create", args: { topic: "ws-note", title: "WS", summary: "in bravo scope" },
  });
  assert.equal(createdBravo.created, true);
  await controller.management.executeTool(amberContext, { name: "memory_read", args: {} });
  await controller.management.executeTool(amberContext, {
    name: "topic_create", args: { topic: "alpha", title: "Alpha", summary: "searchable alpha topic" },
  });
  const found = await controller.management.executeTool(amberContext, {
    name: "memory_search", args: { query: "alpha" },
  });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].key, "alpha");
  await controller.management.executeTool(wsContext, { name: "memory_read", args: { topic: "ws-note" } });
  await controller.management.executeTool(amberContext, {
    name: "group_manage", args: { action: "create", key: "dev", title: "Dev", summary: "dev stuff", order: 10 },
  });
  await controller.management.executeTool(amberContext, {
    name: "topic_create", args: { topic: "alpha2", title: "Alpha2", summary: "grouped member", group: ["dev"] },
  });
  const directory = await controller.management.executeTool(amberContext, {
    name: "memory_read", args: { topic: "dev" },
  });
  assert.equal(directory.kind, "group", "controller 接线后组目录读法端到端可用");
  assert.deepEqual(directory.members.map((m) => m.key), ["alpha2"]);
  assert.equal(directory.members[0].chars, 0, "成员目录只给体积计数，绝不含正文");

  // fire-and-forget 入账：轮询 diagnostics 的 appended 计数（等待全部落盘）。
  assert.ok(
    await waitFor(async () => controller.diagnostics().topicActivity.appended >= 7, 5000),
    "7 条事件全部入账（group_manage 不接线不计）",
  );
  const { events, skipped } = await readTopicActivity({ stateRoot: roots.stateRoot });
  assert.equal(skipped, 0);
  assert.deepEqual(events.map((e) => [e.scopeId, e.kind, e.topicKey ?? e.groupKey ?? null]), [
    ["bravo", "updated", "ws-note"],
    ["amber", "read", null],
    ["amber", "updated", "alpha"],
    ["amber", "search_hit", "alpha"],
    ["bravo", "read", "ws-note"],
    ["amber", "updated", "alpha2"],
    ["amber", "group_list", "dev"],
  ], "四类事件按执行序落盘，scopeId 与 targetScopeId 逐一对应（两个 scope 交叉操作不错记不漏记）");
  await controller.stop();
});

test("0.5-2B 写失败降级：账本路径被目录占位 → 工具照常返回、失败只进诊断（绝不阻塞工具）", async (t) => {
  const roots = await tempRoots();
  t.after(roots.cleanup);
  // 破坏手法：把 <stateRoot>/topic-activity.jsonl 预先建成目录——appendFile 必失败
  // （EISDIR/EPERM 视平台而定），且不影响 store/persona/组清单等其他落盘路径。
  await actMkdir(path.join(roots.stateRoot, "topic-activity.jsonl"), { recursive: true });
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), activeSettings(roots), { bindings });
  await controller.start();
  const trustedContext = { session: { id: "s-blocked" }, source: "panel-rpc" };

  // 读工具照常返回（账本入账失败不影响语义）。
  const view = await controller.management.executeTool(trustedContext, { name: "memory_read", args: {} });
  assert.equal(view.exists, false);
  assert.equal(view.truncated, false);

  // 写工具照常返回（updated 入账同样 fire-and-forget 失败降级）。
  const created = await controller.management.executeTool(trustedContext, {
    name: "topic_create", args: { topic: "blocked", title: "B", summary: "write path intact" },
  });
  assert.equal(created.created, true, "写工具不受账本写失败影响");

  // 失败只进诊断：failed 增长、appended 恒 0、lastError 记录（错误码平台相关，不钉死）。
  assert.ok(
    await waitFor(async () => controller.diagnostics().topicActivity.failed >= 2, 5000),
    "两次入账（read + updated）都失败并计数",
  );
  const stats = controller.diagnostics().topicActivity;
  assert.equal(stats.appended, 0);
  assert.ok(typeof stats.lastError === "string" && stats.lastError.length > 0);
  const stat = await actStat(topicActivityFilePath(roots.stateRoot));
  assert.ok(stat.isDirectory(), "占位目录原样保留（没有任何文件被写出）");
  await controller.stop();
});

// ── 0.5 批次 3 · R1/R3/R4②：降级挂载的面板口径与重启语义 ──────────────────────
// 夹具沿用本文件既有 tempRoots / fakeBindingsFactory / activeSettings；不可写根
// 用「父级是普通文件」造确定性 mkdir ENOTDIR（跨平台一致，不依赖 ACL/管理员）。

test("R1/R3（0.5 批次 3）：降级态面板 executeTool 先报 UNSUPPORTED + details.roots；不 stop 再 start 明确拒绝；stop→start 恢复", async (t) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const blocker = path.join(roots.base, "data-blocker");
  await writeFile(blocker, "not a directory", "utf8");
  const dataRoot = path.join(blocker, "shiori-root");
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(
    fakeCtx(),
    activeSettings({ ...roots, dataRoot }),
    { bindings },
  );

  const started = await controller.start();
  assert.equal(started.degraded, true, "不可写根 → 降级挂载");
  assert.equal(started.roots.length, 1);
  assert.equal(started.roots[0].root, "dataRoot");
  assert.equal(started.roots[0].code, "ENOTDIR");
  assert.equal(controller.diagnostics().started, false, "降级不宣称 started");

  // R1：面板路径先拿降级诊断，而不是 INVALID_STATE「尚未启动」。
  const trustedContext = { session: { id: "s-degraded" }, source: "panel-rpc" };
  await assert.rejects(
    () => controller.management.executeTool(trustedContext, { name: "memory_append", args: { section: "x", content: "y" } }),
    (e) => {
      assert.equal(e.code, "UNSUPPORTED", "降级态面板必须拿 UNSUPPORTED，不是 INVALID_STATE");
      assert.equal(e.details.roots.length, 1);
      assert.equal(e.details.roots[0].root, "dataRoot");
      assert.equal(e.details.roots[0].path, dataRoot);
      assert.equal(e.details.roots[0].code, "ENOTDIR");
      return true;
    },
  );
  // getStatus 纯内存投影：diagnostics.roots 面板可见（不触 scope 资源）。
  const status = await controller.management.getStatus(trustedContext, {});
  assert.equal(status.diagnostics.roots.length, 1);
  assert.equal(status.diagnostics.roots[0].root, "dataRoot");

  // R3：降级后不 stop 再 start 会撞名——给出明确错误，要求先 stop()。
  await assert.rejects(
    () => controller.start(),
    (e) => {
      assert.equal(e.code, "INVALID_STATE");
      assert.match(String(e.message), /stop\(\)/);
      return true;
    },
  );

  // 修复目录后，重启的唯一合法路径是 stop()→start()；恢复后工具正常工作。
  await controller.stop();
  await rm(blocker, { force: true });
  await mkdir(dataRoot, { recursive: true });
  const recovered = await controller.start();
  assert.equal(recovered.degraded, undefined, "根就绪后不得再降级");
  assert.equal(controller.diagnostics().started, true);
  const created = await controller.management.executeTool(trustedContext, {
    name: "topic_create",
    args: { topic: "r1-recovered", title: "R1 恢复", summary: "recovered after stop->start" },
  });
  assert.equal(created.created, true, "stop→start 恢复后工具应正常落盘");
  await controller.stop();
});

test("R4②（0.5 批次 3）：diagnostics.roots 与 personasError 在面板 getStatus 上并存（不整抛）", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const blocker = path.join(roots.base, "persona-blocker");
  await writeFile(blocker, "not a directory", "utf8");
  const dataRoot = path.join(blocker, "shiori-root");
  const eacces = new Error("EACCES: permission denied, scandir '" + dataRoot + "/persona'");
  eacces.code = "EACCES";
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(
    fakeCtx(),
    activeSettings({ ...roots, dataRoot }),
    { bindings, personasReaddir: async () => { throw eacces; } },
  );
  // 故障并存：根不可写（降级） + 人设卡目录读不了（EACCES）。getStatus 不得
  // 因后者整抛，否则 controller 注入的 diagnostics.roots 到不了面板。
  const started = await controller.start();
  assert.equal(started.degraded, true);
  const trustedContext = { session: { id: "s-degraded-persona" }, source: "panel-rpc" };
  const status = await controller.management.getStatus(trustedContext, {});
  assert.deepEqual(status.personas, [], "读不了目录 → 空清单，不整抛");
  assert.equal(status.diagnostics.roots.length, 1);
  assert.equal(status.diagnostics.roots[0].root, "dataRoot");
  assert.equal(status.diagnostics.roots[0].code, "ENOTDIR");
  assert.equal(typeof status.diagnostics.personasError, "string");
  assert.match(status.diagnostics.personasError, /EACCES/);
  await controller.stop();
});

test("R3/rework：disposeAll 报错或抛错 → degradedRegistered 保留，后续 start 仍被 INVALID_STATE 拦下", async (t) => {
  const { writeFile } = await import("node:fs/promises");
  const roots = await tempRoots();
  t.after(roots.cleanup);
  const blocker = path.join(roots.base, "dispose-blocker");
  await writeFile(blocker, "not a directory", "utf8");
  const dataRoot = path.join(blocker, "shiori-root");

  // 生产 bindings 的 disposeAll 不抛、失败走 errors 数组——两种失败形态都必须
  // 保留二次注册闸（注册表可能残留，直接 start 会撞名）。
  for (const failure of [
    { label: "errors 数组", options: { disposeErrors: ["injected disposer failure"] } },
    { label: "抛出异常", options: { disposeThrows: new Error("injected disposeAll throw") } },
  ]) {
    const bindings = fakeBindingsFactory(failure.options);
    const controller = await createShioriPluginController(
      fakeCtx(),
      activeSettings({ ...roots, dataRoot }),
      { bindings },
    );
    const started = await controller.start();
    assert.equal(started.degraded, true, `${failure.label}：先造降级挂载`);
    const stopped = await controller.stop();
    assert.ok(stopped.errors.length > 0, `${failure.label}：stop 如实上报撤销失败`);
    await assert.rejects(
      () => controller.start(),
      (e) => {
        assert.equal(e.code, "INVALID_STATE", `${failure.label}：撤销不干净时 start 必须仍被拦`);
        assert.match(String(e.message), /stop\(\)/);
        return true;
      },
    );
  }
});

// ── 0.5 批次 5 · A 线：pre-step auto 调度接线（§11.2.1 触发）─────────────────
//
// 人类轮判据：本轮上下文存在 source.kind === "user" 的消息（心跳投递/引擎室轮的
// source 不是 user → 天然跳过）。调度 fire-and-forget：绝不阻塞主回答、失败静默
// 进诊断（diagnostics().counters.autoEvaluationFailures 与 getStatus.diagnostics.auto）。
// 同步手段（0.5 批次 7-1 去墙钟）：事件门控——等 getStatus().diagnostics.auto 的
// evaluations/runs 计数到位（auto-eval/auto-run 记账在落盘之后发出），再读
// <stateRoot>/auto-organize.json 做最终断言（waitForAutoState / awaitAutoDiag）。

import { writeFile as autoWriteFile, readFile as autoReadFile, mkdir as autoMkdir } from "node:fs/promises";

const AUTO_PRESTEP_TEMPERATURE = {
  s0Days: 30, sMaxDays: 180, consolidateGain: 0.5, readAlpha: 0.35,
  updatedFloor: 85, readDedupHours: 24, coolThreshold: 25, restoreThreshold: 50,
  minCooldownDays: 7, minRestoreGraceDays: 3, maxOpsPerRun: 20, evaluateEveryHours: 6,
};

async function autoPreStepFixture(t, { autoMode = "suggest", l2 = false } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-autopre-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    l2: { enabled: l2 },
    forgetting: { enabled: true, autoMode },
    temperature: AUTO_PRESTEP_TEMPERATURE,
  }, { bindings });
  await controller.start();
  // 预置一个冷态 historical topic + search_hit 统计起点（与 management 夹具同款）。
  const topicsDir = path.join(base, "data", "scopes", "amber", "topics");
  await autoMkdir(topicsDir, { recursive: true });
  const updated = new Date(Date.now() - 61 * 86400000).toISOString();
  await autoWriteFile(path.join(topicsDir, "pre-cold.md"), [
    "---",
    "key: pre-cold",
    "scopeId: amber",
    "title: 调度夹具",
    "summary: s",
    `updated: ${updated}`,
    "retention: historical",
    "---",
    "",
    "正文。",
    "",
  ].join("\n"));
  await autoMkdir(path.join(base, "state"), { recursive: true });
  const hitAt = new Date(Date.now() - 8 * 86400000).toISOString();
  await autoWriteFile(path.join(base, "state", "topic-activity.jsonl"),
    JSON.stringify({ at: hitAt, scopeId: "amber", kind: "search_hit", topicKey: "pre-cold" }) + "\n");
  return { controller, bindings, base, stateRoot: path.join(base, "state"), topicsDir };
}

function autoHumanMessage(id) {
  return { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text: "人类输入" }] };
}

function autoHeartbeatMessage(id) {
  // 心跳投递形状：role=user 但 source.kind ≠ user（引擎室轮）——不构成人类轮。
  return { id, role: "user", source: { kind: "heartbeat-inject" }, content: [{ type: "text", text: "心跳注入" }] };
}

/** 0.5 批次 7-1：auto 记账等待改事件门控（去墙钟 flake，照 6B-2 awaitCounter 先例）。
 * 完成信号：auto-eval（suggest）/ auto-run（auto 模式）诊断都在 markEvaluated
 * （auto-organize.json 落盘）之后发出（src/forgetting/auto.mjs：先 await 落盘再
 * diag），controller 侧 onDiagnostics 同步自增 ctrl.auto，getStatus().diagnostics.auto
 * 是其纯内存快照——「计数 ≥1」即「本轮评估已记账、文件必已落盘」，此后读文件做
 * 最终断言（正常路径首读即中）。轮询超时只作失败兜底，错误信息区分
 * 「调度未触发评估」（计数全 0，附 notDue/busy/failures/fused 细节）、
 * 「评估已触发但熔断」（fused > 0：auto-eval-fused 后不记账不发 run）与
 * 「已评估但记账未落盘」（计数到位、文件读取仍失败）。 */
async function waitForAutoState(controller, stateRoot, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let auto = null;
  while (Date.now() < deadline) {
    auto = (await controller.management.getStatus(
      { session: { id: "s-1" }, source: "panel-rpc" }, {},
    )).diagnostics.auto ?? null;
    if ((auto?.evaluations ?? 0) > 0 || (auto?.runs ?? 0) > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if ((auto?.evaluations ?? 0) === 0 && (auto?.runs ?? 0) === 0) {
    // 0.5 批次 7-1 R2：熔断（auto-eval-fused）时评估已触发但不记账、不发
    // auto-eval/auto-run——计数全 0 但 fused > 0，不能误报「调度未触发评估」。
    const fused = auto?.fused ?? 0;
    throw new Error(
      fused > 0
        ? `auto-organize.json 等待超时（${timeoutMs}ms）：评估已触发但熔断`
          + `（auto-eval-fused，fused=${fused}，evaluations=0 runs=0`
          + ` failures=${auto?.failures ?? 0} lastError=${auto?.lastError ?? "null"}）`
        : `auto-organize.json 等待超时（${timeoutMs}ms）：调度未触发评估`
          + `（evaluations=0 runs=0 notDue=${auto?.notDue ?? 0} busy=${auto?.busy ?? 0}`
          + ` failures=${auto?.failures ?? 0} fused=${fused} lastError=${auto?.lastError ?? "null"}）`,
    );
  }
  const file = path.join(stateRoot, "auto-organize.json");
  const readDeadline = Date.now() + 2000;
  for (;;) {
    try {
      const raw = await autoReadFile(file, "utf8");
      if (raw.includes("lastEvaluatedAt")) return JSON.parse(raw);
    } catch { /* 已记账但文件尚不可读：短暂重试 */ }
    if (Date.now() > readDeadline) {
      throw new Error(
        `auto-organize.json 已评估但记账未落盘/未含 lastEvaluatedAt`
        + `（evaluations=${auto?.evaluations ?? 0} runs=${auto?.runs ?? 0}）`
        + `——记账信号已到、文件读取仍失败`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 0.5 批次 7-1：等 auto 诊断计数到位（事件门控）。照 6B-2 awaitCounter 先例
 * （test/sparks/diagnostics.test.mjs:700）：25ms 一步轮询 getStatus.diagnostics.auto
 * （纯内存计数快照），超时把当前实际值打印进断言消息。 */
async function awaitAutoDiag(controller, key, expected, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let current = 0;
  while (Date.now() < deadline) {
    const auto = (await controller.management.getStatus(
      { session: { id: "s-1" }, source: "panel-rpc" }, {},
    )).diagnostics.auto ?? {};
    current = auto[key] ?? 0;
    if (current >= expected) return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(
    current >= expected,
    `auto 诊断 ${key} 应 ≥ ${expected}（轮询超时，实际 ${current}）`
    + `——auto 记账在落盘后发出（fire-and-forget），需等待决议`,
  );
  return current;
}

test("pre-step auto 调度：心跳轮不触发（source.kind ≠ user）；人类轮首评触发且绝不阻塞主回答", async (t) => {
  const { controller, bindings, stateRoot } = await autoPreStepFixture(t, { autoMode: "suggest", l2: false });
  const preStep = bindings.registered.preStep;
  const agent = { session: { id: "s-1" } };
  const nextDecision = { kind: "enter", messages: [] };

  // 心跳轮：不触发调度（auto 记账永不落盘）。
  const decisionHb = await preStep({ agent, messages: [autoHeartbeatMessage("hb-1")] }, async () => nextDecision);
  assert.equal(decisionHb.kind, "enter", "心跳轮 preStep 照常放行");
  await new Promise((resolve) => setTimeout(resolve, 400));
  await assert.rejects(
    () => autoReadFile(path.join(stateRoot, "auto-organize.json"), "utf8"),
    (error) => error.code === "ENOENT",
    "心跳轮不写 auto-organize.json（未评估）",
  );

  // 人类轮：first-run 基线评估触发（fire-and-forget，preStep 立即返回）。
  const startedAt = Date.now();
  const decision = await preStep({ agent, messages: [autoHumanMessage("m-1")] }, async () => nextDecision);
  assert.equal(decision.kind, "enter", "人类轮 preStep 照常放行（不被 auto 阻塞）");
  assert.ok(Date.now() - startedAt < 300, "调度构造同步返回（评估在后台跑）");
  const storeState = await waitForAutoState(controller, stateRoot);
  assert.equal(storeState.scopes.amber.lastEvaluatedBy, "human-turn", "人类轮评估已记账");

  // 诊断可见：计数为 0 次失败；面板 status 记账同步。
  assert.equal(controller.diagnostics().counters.autoEvaluationFailures, 0);
  const status = await controller.management.getAutoStatus({ session: { id: "s-1" }, source: "panel-rpc" }, {});
  assert.equal(status.lastEvaluatedBy, "human-turn");
});

test("pre-step auto 调度：L2 关闭时照常调度；auto 模式人类轮直接执行（topic 落 archivedAt）", async (t) => {
  const { controller, bindings, stateRoot, topicsDir } = await autoPreStepFixture(t, { autoMode: "auto", l2: false });
  const preStep = bindings.registered.preStep;
  const agent = { session: { id: "s-1" } };
  const decision = await preStep({ agent, messages: [autoHumanMessage("m-auto")] }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(decision.kind, "enter");
  await waitForAutoState(controller, stateRoot);
  // auto 模式：调度接执行——冷态 topic 已被归档。auto-run 记账（runs 计数）在
  // executeOp 全部完成（archivedAt 已写盘）与 recordRun/markEvaluated 落盘之后
  // 发出（src/forgetting/auto.mjs apply），计数到位后读文件做最终断言（0.5 批次
  // 7-1：原 3s 墙钟轮询在并行负载下不稳，改事件门控）。
  await awaitAutoDiag(controller, "runs", 1);
  const raw = await autoReadFile(path.join(topicsDir, "pre-cold.md"), "utf8");
  assert.ok(raw.includes("archivedAt"), "auto 模式人类轮执行了冷却（archivedAt 落盘）");
  const autoDiag = (await controller.management.getStatus({ session: { id: "s-1" }, source: "panel-rpc" }, {})).diagnostics.auto;
  assert.ok(autoDiag.runs >= 1, "执行轮数进诊断");
});

test("pre-step auto 调度：评估失败静默计数（autoStore 损坏 → 记账失败），主回答零影响", async (t) => {
  const { controller, bindings, stateRoot } = await autoPreStepFixture(t, { autoMode: "suggest", l2: false });
  // 预写一份损坏的 auto-organize.json（坏 JSON）——markEvaluated 将失败。
  await autoWriteFile(path.join(stateRoot, "auto-organize.json"), "{ broken json !!!");
  const preStep = bindings.registered.preStep;
  const agent = { session: { id: "s-1" } };
  const decision = await preStep({ agent, messages: [autoHumanMessage("m-fail")] }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(decision.kind, "enter", "评估失败不打断 pre-step");
  // 失败计数进诊断（0.5 批次 7-1 R1：原 3s 墙钟轮询在并行负载/记账延迟下不稳，
  // 改事件门控——auto-schedule-failed 在同一 onDiagnostics 回调里同步自增
  // ctrl.auto.failures 与 counters.autoEvaluationFailures，两处同源，等前者到位）。
  await awaitAutoDiag(controller, "failures", 1);
  const failures = controller.diagnostics().counters.autoEvaluationFailures;
  assert.ok(failures >= 1, `autoEvaluationFailures ≥ 1（实际 ${failures}）`);
  const autoDiag = (await controller.management.getStatus({ session: { id: "s-1" }, source: "panel-rpc" }, {})).diagnostics.auto;
  assert.ok(autoDiag.failures >= 1);
  assert.ok(autoDiag.lastError !== null, "最近错误如实留痕");
});
