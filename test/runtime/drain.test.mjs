/**
 * P1-RUNTIME stop 排空：在途完成事件必须落盘后才 flush/close；
 * 只调同步 bridge.stop 不等于排空；宿主侧 flushCompletedTools 亦被等待。
 * 全部 synthetic（门闸控制的假 E 工厂与假宿主）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { createShioriRuntime } from "../../src/runtime/index.mjs";
import { createFakeHost } from "../host/helpers.mjs";
import {
  createFakePluginCtx, createSyntheticCompletionFactory, delay, emitPtcCompress,
  makeTempDir, removeTempDir,
} from "./_helpers.mjs";

async function gatedRuntimeContext(prefix) {
  const base = await makeTempDir(prefix);
  let releaseSave;
  const saveGate = new Promise((resolve) => { releaseSave = resolve; });
  const factory = createSyntheticCompletionFactory({ saveGate: () => saveGate });
  return { base, factory, pluginCtx: createFakePluginCtx(), releaseSave };
}

test("stop 等待在途事件落盘：save 完成 → flush → close 的确定顺序", async () => {
  const ctx = await gatedRuntimeContext("shiori-drain1-");
  try {
    const runtime = await createShioriRuntime({
      pluginCtx: ctx.pluginCtx,
      dataRoot: path.join(ctx.base, "data"),
      stateRoot: path.join(ctx.base, "state"),
      activeScopeId: "scope-a",
      mode: "shadow",
    }, { openCompletionState: ctx.factory.openCompletionState });
    await runtime.start();
    await emitPtcCompress(ctx.pluginCtx, "sess-1", 5, 2); // save 挂在门闸上

    const stopPromise = runtime.stop();
    await delay(60);
    assert.ok(ctx.factory.orderLog.includes("save:start:1"), "事件处理已进入保存阶段");
    assert.ok(!ctx.factory.orderLog.includes("close"), "未排空前不得 close（stop 仍在等待）");
    let settled = false;
    stopPromise.then(() => { settled = true; }, () => { settled = true; });
    await delay(40);
    assert.equal(settled, false, "stop() 不得在门闸释放前返回（排空语义）");

    ctx.releaseSave();
    const report = await stopPromise;
    assert.equal(report.stopped, true);
    assert.ok(report.drained >= 1, "至少排空 1 个在途事件处理");
    assert.equal(report.handleClosed, true);
    const order = ctx.factory.orderLog;
    assert.ok(order.indexOf("save:done:1") >= 0);
    assert.ok(order.indexOf("flush") > order.indexOf("save:done:1"), "flush 在保存完成之后");
    assert.ok(order.indexOf("close") > order.indexOf("flush"), "close 在 flush 之后");
  } finally {
    await removeTempDir(ctx.base);
  }
});

test("只调用同步 bridge.stop 不等于排空：保存仍挂起，由 runtime.stop 补齐排空与关闭", async () => {
  const ctx = await gatedRuntimeContext("shiori-drain2-");
  try {
    const runtime = await createShioriRuntime({
      pluginCtx: ctx.pluginCtx,
      dataRoot: path.join(ctx.base, "data"),
      stateRoot: path.join(ctx.base, "state"),
      activeScopeId: "scope-a",
      mode: "shadow",
    }, { openCompletionState: ctx.factory.openCompletionState });
    await runtime.start();
    await emitPtcCompress(ctx.pluginCtx, "sess-1", 5, 2);

    // 直接调桥的同步 stop：撤销订阅，但在途保存不会被等待。
    const bridgeResult = runtime.bridge.stop();
    assert.ok(bridgeResult && typeof bridgeResult.disposed === "number", "bridge.stop 是同步回执");
    await delay(40);
    assert.ok(!ctx.factory.orderLog.includes("save:done:1"), "同步 bridge.stop 不排空保存（预期）");
    assert.ok(!ctx.factory.orderLog.includes("close"));

    ctx.releaseSave();
    const report = await runtime.stop();
    assert.equal(report.stopped, true);
    assert.ok(ctx.factory.orderLog.indexOf("save:done:1") >= 0, "runtime.stop 排空了在途保存");
    assert.ok(ctx.factory.orderLog.includes("close"), "句柄最终被关闭");
  } finally {
    await removeTempDir(ctx.base);
  }
});

test("宿主提供 flushCompletedTools 时，stop 在关闭句柄前等待它", async () => {
  const base = await makeTempDir("shiori-drain3-");
  const factory = createSyntheticCompletionFactory();
  try {
    const hostLog = [];
    const fakeHost = createFakeHost(); // 归一化事件直发（synthetic 宿主）
    fakeHost.flushCompletedTools = async () => {
      await delay(30); // 宿主侧尚有在途监听器
      hostLog.push("host-flush");
      factory.orderLog.push("host-flush");
    };
    const runtime = await createShioriRuntime({
      pluginCtx: {},
      dataRoot: path.join(base, "data"),
      stateRoot: path.join(base, "state"),
      activeScopeId: "scope-a",
      mode: "shadow",
    }, {
      openCompletionState: factory.openCompletionState,
      createHost: () => fakeHost,
    });
    await runtime.start();
    await fakeHost.emit({ eventId: "e1", sessionId: "s1", name: "compress", success: true, blocksCreated: 3, seq: 1 });
    const report = await runtime.stop();
    assert.equal(report.stopped, true);
    const order = factory.orderLog;
    assert.ok(order.includes("host-flush"), "宿主侧 flush 被调用");
    assert.ok(order.indexOf("host-flush") < order.indexOf("close"), "host flush 先于句柄 close");
  } finally {
    await removeTempDir(base);
  }
});
