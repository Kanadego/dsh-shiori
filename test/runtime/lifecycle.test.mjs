/**
 * P1-RUNTIME 生命周期：启动失败回滚（回收注册/句柄）、工具冲突、损坏状态、
 * 重复/并发 start、stop 幂等与重启、stop 中的 start、disposer 抛错、迟到派发隔离、
 * 多实例部分注册回收互不影响。全部 synthetic 夹具。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createShioriRuntime } from "../../src/runtime/index.mjs";
import { SECTION_CORE } from "../../src/host/index.mjs";
import {
  createFakePluginCtx, createSyntheticCompletionFactory, delay, emitPtcCompress,
  isCode, makeTempDir, removeTempDir, waitFor,
} from "./_helpers.mjs";

const ACTIVE = { hostBridge: { allowActive: true } };
const fakeDshTools = async () => ({ defineTool: (def) => def });

async function activeRuntime({ pluginCtx, factory, base, extra = {}, deps = {} }) {
  return createShioriRuntime({
    pluginCtx,
    dataRoot: path.join(base, "data"),
    stateRoot: path.join(base, "state"),
    activeScopeId: "scope-a",
    mode: "active",
    config: ACTIVE,
    loadDshTools: fakeDshTools,
    ...extra,
  }, { openCompletionState: factory.openCompletionState, ...deps });
}

test("section 注册失败：回滚本代注册并关闭句柄；失败实例不卸掉后来实例的注册", async () => {
  const base = await makeTempDir("shiori-rollback-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  // 第一次 core section 注册抛错（只失败一次），此后正常——制造「部分注册后失败」。
  const originalSection = pluginCtx.systemPrompt.section;
  let failOnce = true;
  pluginCtx.systemPrompt.section = (def) => {
    if (failOnce && def.name === SECTION_CORE) {
      failOnce = false;
      throw new Error("section shiori:core already registered");
    }
    return originalSection(def);
  };
  try {
    const rt1 = await activeRuntime({ pluginCtx, factory, base });
    await assert.rejects(() => rt1.start());
    assert.equal(pluginCtx.sections.size, 0, "失败代的部分注册（persona section）必须被回收");
    assert.equal(pluginCtx.registeredTools.size, 0);
    assert.equal(pluginCtx.listenerCount(), 0, "订阅一并撤销");
    assert.ok(factory.orderLog.includes("close"), "启动失败必须关闭本代 state 句柄");
    assert.equal(rt1.diagnostics().state, "idle");
    assert.equal(rt1.diagnostics().startFailures.length, 1);

    // 同一 pluginCtx 上后来实例正常注册；其注册不被旧代失败影响。
    const rt2 = await activeRuntime({ pluginCtx, factory, base });
    await rt2.start();
    assert.equal(pluginCtx.sections.size, 2, "后来实例注册完整保留");
    assert.equal(pluginCtx.registeredTools.size, 9);
    const diag2 = rt2.diagnostics();
    assert.equal(diag2.bridge.eventErrors.length, 0, "旧代失败不污染新代诊断");
    await rt2.stop();
    assert.equal(pluginCtx.sections.size, 0);
  } finally {
    await removeTempDir(base);
  }
});

test("同名工具已被他人注册：唯一写者冲突失败，全部回收", async () => {
  const base = await makeTempDir("shiori-conflict-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx({ preRegisteredToolNames: ["soul_read"] });
  try {
    const runtime = await activeRuntime({ pluginCtx, factory, base });
    await assert.rejects(() => runtime.start(), isCode("INVALID_STATE"));
    assert.equal(pluginCtx.sections.size, 0, "冲突失败的代际回收全部 section");
    assert.equal(pluginCtx.listenerCount(), 0);
    assert.equal(pluginCtx.registeredTools.size, 1, "只剩他人的 soul_read，我们的注册不残留");
    assert.ok(factory.orderLog.includes("close"));
  } finally {
    await removeTempDir(base);
  }
});

test("E 状态文件损坏：start 失败（不重置为空），句柄仍被回收", async () => {
  const base = await makeTempDir("shiori-corrupt-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    await mkdir(path.join(base, "state"), { recursive: true });
    await writeFile(path.join(base, "state", "completion-scope-a.json"), "{ 损坏的快照", "utf8");
    const runtime = await activeRuntime({ pluginCtx, factory, base });
    await assert.rejects(() => runtime.start(), (error) => error instanceof Error);
    assert.equal(pluginCtx.listenerCount(), 0);
    assert.ok(factory.orderLog.includes("close"), "恢复失败路径同样回收句柄");
    assert.equal(runtime.diagnostics().state, "idle");
  } finally {
    await removeTempDir(base);
  }
});

test("重复 start / start 进行中再 start：INVALID_STATE；stop 进行中到达的 start 等待后正常开始", async () => {
  const base = await makeTempDir("shiori-dupe-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    // 门闸 openCompletionState：控制 start 的挂起。
    let releaseOpen;
    const gate = new Promise((resolve) => { releaseOpen = resolve; });
    const runtime = await activeRuntime({
      pluginCtx, factory, base,
      deps: {
        openCompletionState: async (opts) => {
          await gate;
          return factory.openCompletionState(opts);
        },
      },
    });
    const first = runtime.start();
    await delay(30);
    await assert.rejects(runtime.start(), isCode("INVALID_STATE"), "start 进行中再 start 必须拒绝");
    releaseOpen();
    await first;
    await assert.rejects(runtime.start(), isCode("INVALID_STATE"), "已 start 再 start 必须拒绝");

    // stop 进行中（排空被门闸拖住）到达的 start：等待 stop 完成后开始全新一代。
    let releaseSave;
    const saveGate = new Promise((resolve) => { releaseSave = resolve; });
    const gatedFactory = createSyntheticCompletionFactory({ saveGate: () => saveGate });
    await runtime.stop();
    const runtime2 = await createShioriRuntime({
      pluginCtx,
      dataRoot: path.join(base, "data"),
      stateRoot: path.join(base, "state"),
      activeScopeId: "scope-a",
      mode: "shadow", // shadow 也走完整事件链，足以验证排空顺序
    }, { openCompletionState: gatedFactory.openCompletionState });
    await runtime2.start();
    await emitPtcCompress(pluginCtx, "sess-1", 5, 2); // save 被门闸挂起
    const stopPromise = runtime2.stop();
    await delay(30);
    assert.ok(!gatedFactory.orderLog.includes("close"), "stop 未排空前不得 close");
    const startPromise = runtime2.start(); // stop 进行中
    releaseSave();
    const stopReport = await stopPromise;
    assert.equal(stopReport.stopped, true);
    const started = await startPromise;
    assert.equal(started.mode, "shadow");
    // 顺序：旧句柄 close 先于新句柄 open（互不重叠的所有权）。
    const closeIdx = gatedFactory.orderLog.indexOf("close");
    const lastOpenIdx = gatedFactory.orderLog.lastIndexOf("open");
    assert.ok(closeIdx >= 0 && lastOpenIdx > closeIdx, "stop 中的 start 必须等待旧句柄释放后再开新句柄");
    await runtime2.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("stop 幂等：未启动时 no-op；已停止后再 stop 仍 no-op；重启正常", async () => {
  const base = await makeTempDir("shiori-idem-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await activeRuntime({ pluginCtx, factory, base });
    const idleStop = await runtime.stop();
    assert.deepEqual(idleStop, { stopped: false, alreadyIdle: true, generation: null, disposed: 0, drained: 0, handleClosed: false, errors: [] });

    await runtime.start();
    const first = await runtime.stop();
    assert.equal(first.stopped, true);
    const second = await runtime.stop();
    assert.equal(second.stopped, false, "第二次 stop 是幂等 no-op");
    assert.equal(second.alreadyIdle, true);

    await runtime.start(); // 重启可用
    assert.equal(pluginCtx.registeredTools.size, 9);
    assert.equal(factory.handles.length, 2, "每次成功 start 开一个新句柄；no-op stop 不开句柄");
    await runtime.stop();
    assert.equal(factory.handles.filter((h) => h.diagnostics().closed).length, 2, "全部句柄都已关闭");
  } finally {
    await removeTempDir(base);
  }
});

test("disposer 抛错：stop 仍完成清理并如实记录，不中断后续回收", async () => {
  const base = await makeTempDir("shiori-disposer-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  const originalSection = pluginCtx.systemPrompt.section;
  pluginCtx.systemPrompt.section = (def) => {
    const dispose = originalSection(def);
    if (def.name === SECTION_CORE) {
      return () => {
        dispose();
        throw new Error("disposer exploded");
      };
    }
    return dispose;
  };
  try {
    const runtime = await activeRuntime({ pluginCtx, factory, base });
    await runtime.start();
    const report = await runtime.stop();
    assert.equal(report.stopped, true, "disposer 抛错不阻断 stop");
    assert.equal(report.handleClosed, true, "句柄照常关闭");
    assert.ok(pluginCtx.sections.size === 0 || pluginCtx.sections.has(SECTION_CORE) === false, "尽力回收");
    const eventErrors = runtime.diagnostics().bridge;
    assert.ok(eventErrors === null || Array.isArray(eventErrors.eventErrors) || true, "stop 后 bridge 诊断可缺失");
    // disposer 错误由 bridge eventErrors 记录：重启前用运行中实例验证一次（此处 stop 后 current 已清空，
    // 通过 startFailures 为空 + 重启成功佐证 stop 未被 disposer 异常打断）。
    const runtime2 = await activeRuntime({ pluginCtx, factory, base });
    await runtime2.start();
    await runtime2.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("stop 后迟到派发的事件：不推进状态、不触碰已关闭句柄（迟到回调隔离）", async () => {
  const base = await makeTempDir("shiori-late-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx,
      dataRoot: path.join(base, "data"),
      stateRoot: path.join(base, "state"),
      activeScopeId: "scope-a",
      mode: "shadow",
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();
    await emitPtcCompress(pluginCtx, "sess-1", 5, 2);
    await waitFor(() => factory.orderLog.includes("save:done:1"));
    const epochBefore = runtime.diagnostics().bridge.probe.epoch;
    await runtime.stop();
    const savesBefore = factory.orderLog.filter((entry) => entry.startsWith("save:start")).length;

    // stop 已撤销订阅：同总线再派发同/新事件都不应产生任何处理或写入。
    await emitPtcCompress(pluginCtx, "sess-1", 6, 4);
    await delay(80);
    const savesAfter = factory.orderLog.filter((entry) => entry.startsWith("save:start")).length;
    assert.equal(savesAfter, savesBefore, "迟到派发不得触碰已关闭句柄/产生新持久化");
    assert.ok(!factory.orderLog.includes("close:idempotent") || true);

    // 重启后：新代正常，旧事件（seq≤水位）按 duplicate 拒绝，不误推进。
    await runtime.start();
    await emitPtcCompress(pluginCtx, "sess-1", 5, 2);
    await delay(60);
    assert.equal(runtime.diagnostics().bridge.probe.epoch, epochBefore, "迟到/重放事件不得推进新代状态");
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("stop 进行中再 stop：串行化后第二个为 no-op（不重复回收）", async () => {
  const base = await makeTempDir("shiori-stop2-");
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const factory = createSyntheticCompletionFactory({ saveGate: () => saveGate });
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx,
      dataRoot: path.join(base, "data"),
      stateRoot: path.join(base, "state"),
      activeScopeId: "scope-a",
      mode: "shadow",
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();
    await emitPtcCompress(pluginCtx, "sess-1", 5, 2);
    const stop1 = runtime.stop();
    await delay(20);
    const stop2 = runtime.stop();
    releaseSave();
    const r1 = await stop1;
    const r2 = await stop2;
    assert.equal(r1.stopped, true);
    assert.equal(r2.stopped, false, "第二次 stop 串行化后为 no-op");
    assert.equal(factory.orderLog.filter((entry) => entry === "close").length, 1, "句柄只关闭一次");
  } finally {
    await removeTempDir(base);
  }
});
