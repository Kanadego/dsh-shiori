/**
 * P1-COMPLETION · 与 D 宿主桥（createHostBridge）的组合集成测试。
 * 使用真实 dsh-adapter + 真实桥 + openCompletionState；全合成数据、临时 root。
 * D 的 src/runtime 未交付不阻塞：桥接口（probeSink）为冻结契约。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { openCompletionState } from "../../src/completion/index.mjs";
import { assembleDshShioriHost } from "../../src/host/dsh-adapter.mjs";
import { createHostBridge } from "../../src/host/index.mjs";
import { createFakeService } from "../host/helpers.mjs";

function fakePluginCtx() {
  const handlers = new Map();
  return {
    systemPrompt: { section: () => () => {} },
    tools: { register: () => () => {} },
    on(type, handler) {
      handlers.set(type, (handlers.get(type) ?? new Set()).add(handler));
      return () => handlers.get(type)?.delete(handler);
    },
    dispatch(session, event) {
      for (const handler of handlers.get("session/event") ?? []) handler(session, event);
    },
  };
}


/** 等待谓词成立（桥监听器 fire-and-forget 时 flush 不等待 observe，需轮询）。 */
async function waitFor(predicate, label, timeoutMs = 5000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const ptcCompress = (seq, over = {}) => ({
  type: "tool/ptc-dispatch",
  seq,
  data: {
    rootCallId: `c${seq}`, parentCallId: `c${seq}`, subCallId: `c${seq}:ptc:1`,
    name: "compress", isError: false,
    content: [{ type: "text", text: "[Compressed m00001–m00002 → 2 block(s), ~1234 tokens saved.]" }],
    ...over,
  },
});

test("桥 + openCompletionState：完成事件持久化、重启恢复与重放去重（同进程两代桥）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-bridge-"));
  after(() => rm(dir, { recursive: true, force: true }));

  // 第一代桥：probeSink 接 openCompletionState
  const handle1 = await openCompletionState({ root: dir, scopeId: "amber" });
  const ctx1 = fakePluginCtx();
  const assembled1 = await assembleDshShioriHost(ctx1, {
    service: createFakeService(),
    mode: "shadow",
    probeSink: handle1.sink,
  });
  const started1 = await assembled1.start();
  assert.equal(started1.cancelled, undefined);
  assert.equal(assembled1.bridge.diagnostics().restoredFromSink, false, "首次启动无历史状态");

  ctx1.dispatch({ id: "s1" }, ptcCompress(10));
  await assembled1.host.flushCompletedTools();
  await waitFor(() => assembled1.bridge.diagnostics().probe.epoch === 1, "epoch 1");
  assert.equal(assembled1.bridge.diagnostics().probe.epoch, 1);
  assembled1.stop();
  await handle1.close();

  // 第二代桥（模拟宿主重启后的新一代桥）：恢复后重放同事件不推进
  const handle2 = await openCompletionState({ root: dir, scopeId: "amber" });
  const ctx2 = fakePluginCtx();
  const assembled2 = await assembleDshShioriHost(ctx2, {
    service: createFakeService(),
    mode: "shadow",
    probeSink: handle2.sink,
  });
  await assembled2.start();
  const diag2 = assembled2.bridge.diagnostics();
  assert.equal(diag2.restoredFromSink, true, "恢复自持久状态");
  assert.equal(diag2.probe.epoch, 1);

  ctx2.dispatch({ id: "s1" }, ptcCompress(10));
  await assembled2.host.flushCompletedTools();
  await waitFor(() => assembled2.bridge.diagnostics().recentEvents.length > 0, "replay observed");
  assert.equal(assembled2.bridge.diagnostics().probe.epoch, 1, "重放同 seq 事件不得重复推进");
  // 新事件正常推进
  ctx2.dispatch({ id: "s1" }, ptcCompress(11));
  await waitFor(() => assembled2.bridge.diagnostics().probe.epoch === 2, "epoch 2");
  assert.equal(assembled2.bridge.diagnostics().probe.epoch, 2);
  assembled2.stop();
  await handle2.close();
});

test("桥 + 完成状态：持久化失败保持内存推进但 diagnostics 如实暴露（桥可观察）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-bridge2-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  const ctx = fakePluginCtx();
  const assembled = await assembleDshShioriHost(ctx, {
    service: createFakeService(),
    mode: "shadow",
    probeSink: handle.sink,
  });
  await assembled.start();

  // 先正常推进一次，随后关闭状态句柄制造持久化失败
  ctx.dispatch({ id: "s1" }, ptcCompress(1));
  await assembled.host.flushCompletedTools();
  assert.equal(assembled.bridge.diagnostics().probe.epoch, 1);
  await handle.close();

  // 新事件：内存 epoch 继续推进，但 sink.save 拒绝 → probe.sinkError 必须如实暴露
  ctx.dispatch({ id: "s1" }, ptcCompress(2));
  await assembled.host.flushCompletedTools();
  await waitFor(() => assembled.bridge.diagnostics().probe.sinkError !== null, "sinkError observed");
  const diag = assembled.bridge.diagnostics();
  assert.equal(diag.probe.epoch, 2, "内存推进与持久化失败分离");
  assert.match(diag.probe.sinkError ?? "", /closed/i, "持久化失败必须在桥诊断可观察");
  assert.equal(handle.diagnostics().durable, "degraded", "句柄诊断不得宣称 durable");
  assembled.stop();
});

test("桥 + createJsonFileSink：损坏状态文件使 start 显式失败，不重置 epoch 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-bridge3-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "epoch.json");
  await writeFile(statePath, "{not-json", "utf8");

  const ctx = fakePluginCtx();
  const { createJsonFileSink } = await import("../../src/host/compress-probe.mjs");
  const bridge = createHostBridge({
    host: {
      capabilities: { asyncSectionText: true },
      registerSystemSection: () => () => {},
      registerTool: async () => () => {},
      subscribeCompletedTools: () => () => {},
      getSessionInfo: () => ({ sessionId: null, scopeId: "amber" }),
    },
    service: createFakeService(),
    mode: "shadow",
    probeSink: createJsonFileSink(statePath),
  });
  await assert.rejects(() => bridge.start(), (e) => e.code === "INVALID_INPUT");
  // 损坏文件未被 start 清掉
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(statePath, "utf8"), "{not-json");
});

// ── C2（r-24f616d0）：真实桥组合下的监听器排空 ───────────────────────────────

test("C2 真实桥组合：契约形状监听器（返回 Promise）→ flush waited>0 且状态落盘", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-c2-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  const ctx = fakePluginCtx();
  const host = (await import("../../src/host/dsh-adapter.mjs")).createDshHostAbstraction(ctx, { trustedScopeId: "amber" });
  const bridge = createHostBridge({
    host, service: createFakeService(), mode: "shadow", probeSink: handle.sink,
  });
  // 不调用 bridge.start()：基线内部订阅为 fire-and-forget 形状，避免同事件双重派发。
  // 契约/D-a1 形状：监听器返回 onCompletedTool 的 Promise（永不 reject，错误转回执）。
  // 这是 D 归属 src/host/index.mjs:336 已实现的形状；E 不改非归属文件，
  // 此处以完全相同的接线证明组合语义（真实 createHostBridge 处理路径：onCompletedTool → probe → probeSink）。
  const dispose = host.subscribeCompletedTools((event) =>
    bridge.onCompletedTool(event).catch(() => ({ advanced: false, reason: "handler-error" })));

  ctx.dispatch({ id: "s1" }, ptcCompress(20));
  const report = await host.flushCompletedTools();
  assert.ok(report.waited >= 1, `契约形状下 flush 必须等待在途回调：${JSON.stringify(report)}`);
  assert.equal(report.untrackedDispatches, 0);
  assert.equal(report.failures.length, 0);
  assert.equal(bridge.diagnostics().probe.epoch, 1, "flush 后处理已完成");

  // 排空后 close：状态已落盘（close 排空窗口 + 协议顺序 dispose→flush→close）
  dispose();
  bridge.stop();
  const closed = await handle.close();
  assert.ok(closed.drainedSaves >= 1);
  assert.equal(closed.lostSaves, 0);

  const handle2 = await openCompletionState({ root: dir, scopeId: "amber" });
  assert.equal((await handle2.sink.load()).epoch, 1, "真实组合下推进必须持久化");
  await handle2.close();
});

test("C2 P1 集成：D 桥内部监听器返回 Promise 且可被排空", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-c2b-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  const ctx = fakePluginCtx();
  const assembled = await assembleDshShioriHost(ctx, {
    service: createFakeService(),
    mode: "shadow",
    probeSink: handle.sink,
  });
  await assembled.start(); // D 集成接线返回 onCompletedTool 的 Promise

  ctx.dispatch({ id: "s1" }, ptcCompress(30));
  await waitFor(() => assembled.bridge.diagnostics().probe.epoch === 1, "epoch 1");
  const report = await assembled.host.flushCompletedTools();
  assert.ok(report.waited >= 1, "D 集成监听器必须被 flush 排空：" + JSON.stringify(report));
  assert.equal(report.untrackedDispatches, 0, "D 集成监听器返回 Promise，不应留下未跟踪派发");
  assembled.stop();
  await handle.close();
});

test("C2 失败可观察：真实接线中监听器 Promise 拒绝 → flush failures 报告", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-c2c-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  const ctx = fakePluginCtx();
  const host = (await import("../../src/host/dsh-adapter.mjs")).createDshHostAbstraction(ctx, { trustedScopeId: "amber" });
  createHostBridge({ host, service: createFakeService(), mode: "shadow", probeSink: handle.sink });

  host.subscribeCompletedTools((event) => {
    if (event.seq === 40) return Promise.reject(new Error("processing failed"));
    return Promise.resolve({ advanced: false, reason: "ok" });
  });
  ctx.dispatch({ id: "s1" }, ptcCompress(40));
  const report = await host.flushCompletedTools();
  assert.equal(report.waited, 1);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0], /processing failed/);
  await handle.close();
});

// ── C1 真实桥 close 竞态（review-E-a2 非阻塞建议）────────────────────────────

test("C1 真实桥 close 竞态：派发不 flush 即 close（门控在途保存），推进持久化且重放不二次推进", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-c1bridge-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });

  // 门控真实 sink：save 先进入 handle 队列再挂起，制造确定性在途保存（不轮询）
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const gatedSink = {
    load: () => handle.sink.load(),
    async save(snapshot) {
      const pending = handle.sink.save(snapshot);
      markEntered();
      await gate;
      return pending;
    },
  };

  const ctx = fakePluginCtx();
  const host = (await import("../../src/host/dsh-adapter.mjs")).createDshHostAbstraction(ctx, { trustedScopeId: "amber" });
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "shadow", probeSink: gatedSink });
  const dispose = host.subscribeCompletedTools((event) =>
    bridge.onCompletedTool(event).catch(() => ({ advanced: false, reason: "handler-error" })));

  // 最恶劣时序：派发后不排空即 close（在途保存挂起期间 close）。
  // flushCompletedTools 在回调仍在途时启动：waited>=1 证明契约形状派发可排空。
  ctx.dispatch({ id: "s1" }, ptcCompress(50));
  await entered;
  const flushPromise = host.flushCompletedTools();
  releaseGate();
  const closed = await handle.close();
  const report = await flushPromise;
  assert.ok(report.waited >= 1, `派发回调必须可排空：${JSON.stringify(report)}`);
  assert.equal(report.untrackedDispatches, 0);
  assert.equal(bridge.diagnostics().probe.epoch, 1, "内存推进照常");
  assert.ok(closed.drainedSaves >= 1, `close 必须排空在途保存：${JSON.stringify(closed)}`);
  assert.equal(closed.lostSaves, 0);

  // 重开：推进已持久化；同事件重放（新桥同 sink 语义）不得二次推进
  const handle2 = await openCompletionState({ root: dir, scopeId: "amber" });
  const persisted = await handle2.sink.load();
  assert.equal(persisted.epoch, 1);
  const ctx2 = fakePluginCtx();
  const bridge2 = createHostBridge({
    host: (await import("../../src/host/dsh-adapter.mjs")).createDshHostAbstraction(ctx2, { trustedScopeId: "amber" }),
    service: createFakeService(), mode: "shadow", probeSink: handle2.sink,
  });
  await bridge2.start(); // restore 自持久状态
  assert.equal(bridge2.diagnostics().probe.epoch, 1);
  ctx2.dispatch({ id: "s1" }, ptcCompress(50));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(bridge2.diagnostics().probe.epoch, 1, "重放同 seq 事件不得二次推进");
  bridge2.stop();
  await handle2.close();
});
