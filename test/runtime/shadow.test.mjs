/**
 * P1-RUNTIME shadow 模式：零 dataRoot 写入、零注册、诚实 UNSUPPORTED 门面、
 * 完成事件观测经真实 dsh-adapter 映射并持久化到 stateRoot（synthetic E 工厂替身）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createShioriRuntime } from "../../src/runtime/index.mjs";
import {
  createFakePluginCtx, createSyntheticCompletionFactory, emitPtcCompress,
  isCode, makeTempDir, removeTempDir, waitFor,
} from "./_helpers.mjs";

async function assertAbsent(p) {
  await assert.rejects(stat(p), (error) => error.code === "ENOENT");
}

test("shadow 构造/start/stop 全程零 dataRoot 初始化；事件只落 stateRoot", async () => {
  const base = await makeTempDir("shiori-shadow-");
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx, dataRoot, stateRoot, activeScopeId: "scope-a", mode: "shadow",
    }, { openCompletionState: factory.openCompletionState });

    await runtime.start();
    await assertAbsent(dataRoot);
    assert.equal(pluginCtx.sections.size, 0, "shadow 不得注册 system section");
    assert.equal(pluginCtx.registeredTools.size, 0, "shadow 不得注册同名工具");
    assert.equal(pluginCtx.listenerCount(), 1, "shadow 只订阅完成事件（只读观测）");

    // 压缩事件经真实映射推进探针，状态写 stateRoot（允许），dataRoot 仍不存在。
    await emitPtcCompress(pluginCtx, "sess-1", 5, 2);
    const diag = runtime.diagnostics();
    assert.equal(diag.bridge.probe.epoch, 1, "真实映射的 compress 完成事件应推进 epoch");
    await assertAbsent(dataRoot);
    const stateFile = path.join(stateRoot, "completion-scope-a.json");
    await waitFor(() => factory.orderLog.includes("save:done:1"), { label: "state-file" });
    await assert.ok(await stat(stateFile), "探针快照必须持久化到 stateRoot");

    const report = await runtime.stop();
    assert.equal(report.stopped, true);
    assert.equal(report.handleClosed, true);
    assert.equal(pluginCtx.listenerCount(), 0, "stop 后撤销订阅");
    await assertAbsent(dataRoot, "stop 也不得初始化 dataRoot");
    assert.equal(runtime.service, null, "stop 后 service 句柄回收");
    assert.equal(runtime.bridge, null);
    assert.equal(runtime.host, null);
  } finally {
    await removeTempDir(base);
  }
});

test("shadow 未注入只读 service：UNSUPPORTED 门面，绝不用空文本冒充读取", async () => {
  const base = await makeTempDir("shiori-facade-");
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx, dataRoot, stateRoot, activeScopeId: "scope-a", mode: "shadow",
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();

    // 非压缩事件触发桥的快照刷新 -> 门面读取被拒（UNSUPPORTED），并被显式诊断。
    pluginCtx.emit({ id: "sess-1" }, {
      type: "tool/ptc-dispatch", seq: 1, data: { name: "other-tool", isError: false, content: "ok" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const diag = runtime.diagnostics();
    assert.equal(diag.service.kind, "shadow-unsupported-facade");
    assert.ok(diag.service.facade.readAttempts > 0, "读取尝试必须被记录，而不是静默返回空文本");
    assert.equal(diag.service.facade.lastError.code, "UNSUPPORTED");
    assert.ok(diag.service.facade.lastError.message.includes("no fabricated reads"));

    // 直接调 service 门面：读与写一律 UNSUPPORTED。
    await assert.rejects(runtime.service.readPersona(), isCode("UNSUPPORTED"));
    await assert.rejects(runtime.service.mutate({ changes: [] }), isCode("UNSUPPORTED"));
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("shadow 观测持久化跨重启去重：同一事件重放不重复推进", async () => {
  const base = await makeTempDir("shiori-dedup-");
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx, dataRoot, stateRoot, activeScopeId: "scope-a", mode: "shadow",
    }, { openCompletionState: factory.openCompletionState });

    await runtime.start();
    await emitPtcCompress(pluginCtx, "sess-1", 5, 2);
    assert.equal(runtime.diagnostics().bridge.probe.epoch, 1);
    await runtime.stop();

    await runtime.start(); // 重启：probe.restore 先于事件处理恢复状态
    assert.equal(runtime.diagnostics().bridge.restoredFromSink, true, "重启必须先恢复持久状态");
    await emitPtcCompress(pluginCtx, "sess-1", 5, 2); // 完全相同的事件（同 seq 水位）
    const diag = runtime.diagnostics();
    assert.equal(diag.bridge.probe.epoch, 1, "跨重启重放不得重复推进 epoch");
    assert.equal(diag.bridge.recentEvents.at(-1).reason, "duplicate");
    // 新事件仍正常推进
    await emitPtcCompress(pluginCtx, "sess-1", 6, 3);
    assert.equal(runtime.diagnostics().bridge.probe.epoch, 2);
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("shadow 允许显式注入合成只读 service（synthetic，仍零注册零 dataRoot 写）", async () => {
  const base = await makeTempDir("shiori-shadowsvc-");
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  const syntheticService = {
    readPersona: async () => ({ name: "synthetic", text: "SYNTHETIC PERSONA" }),
    readCoreView: async () => ({ text: "SYNTHETIC CORE VIEW", revision: "r1", scopeId: "scope-a" }),
    readTopic: async () => { throw Object.assign(new Error("synthetic: unsupported"), { code: "UNSUPPORTED" }); },
    listTopics: async () => [],
    search: async () => [],
    mutate: async () => { throw Object.assign(new Error("synthetic: shadow never mutates"), { code: "UNSUPPORTED" }); },
  };
  try {
    const runtime = await createShioriRuntime({
      pluginCtx, dataRoot, stateRoot, activeScopeId: "scope-a", mode: "shadow", service: syntheticService,
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();
    assert.equal(runtime.diagnostics().service.kind, "injected");
    assert.equal(pluginCtx.sections.size, 0);
    assert.equal(pluginCtx.registeredTools.size, 0);
    const view = await runtime.service.readCoreView();
    assert.equal(view.text, "SYNTHETIC CORE VIEW");
    await runtime.stop();
    await assertAbsent(dataRoot);
  } finally {
    await removeTempDir(base);
  }
});
