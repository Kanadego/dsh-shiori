import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostBridge, SECTION_CORE } from "../../src/host/index.mjs";
import { ACTIVE_CONFIG, createFakeService } from "./helpers.mjs";

const tick = () => new Promise((r) => setImmediate(r));
const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** 可重复武装的快照门控 service：armed 时下一次 readCoreView 挂起，其后返回正常值。 */
function createGateableSnapshotService() {
  const base = createFakeService();
  const gate = createDeferred();
  let armed = false;
  return {
    base,
    gate,
    arm() { armed = true; },
    service: {
      ...base,
      async readCoreView() {
        if (armed) {
          armed = false;
          return gate.promise;
        }
        return base.readCoreView();
      },
    },
  };
}

/** 同步 section 的最小宿主（记录注册内容，供 renderSection 断言）。 */
function createSyncHost() {
  const sections = new Map();
  const tools = new Map();
  return {
    capabilities: { asyncSectionText: false },
    registerSystemSection({ name, order, text }) {
      sections.set(name, { order, text });
      return () => sections.delete(name);
    },
    registerTool: (tool) => {
      tools.set(tool.name, tool);
      return Promise.resolve(() => tools.delete(tool.name));
    },
    subscribeCompletedTools: () => () => {},
    getSessionInfo: () => ({ sessionId: "s", scopeId: "amber", capabilities: {} }),
    sections,
    tools,
    async renderSection(name) {
      const section = sections.get(name);
      return section ? await section.text({ agent: { session: { id: "s" } } }) : undefined;
    },
  };
}

test("S1：被取消的旧快照读取不得覆盖已启动新代的 L1 快照", async () => {
  const host = createSyncHost();
  const { service, gate, arm } = createGateableSnapshotService();
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });

  arm(); // 旧代的初始 readCoreView 挂起在门控上
  const oldStart = bridge.start();
  await tick();
  await tick();
  bridge.stop();

  // 新代启动：readCoreView 正常返回当前真实值 → section = NEW CURRENT CORE
  const newStart = await bridge.start();
  assert.equal(newStart.cancelled, undefined);
  const newCore = await host.renderSection(SECTION_CORE);
  assert.ok(newCore.includes("铁律"), "新代 section = NEW CURRENT CORE");

  // 放行旧代迟到读取（旧值）
  gate.resolve({ text: "OLD CANCELLED CORE", revision: "old", scopeId: "amber" });
  const oldResult = await oldStart;
  assert.equal(oldResult.cancelled, true);

  // 提交前核对代际：旧值不得覆盖新代快照
  const core = await host.renderSection(SECTION_CORE);
  assert.ok(!core.includes("OLD CANCELLED CORE"), "旧代迟到读取不得写新代 snapshot");
  assert.ok(core.includes("铁律"), "section 保持 NEW CURRENT CORE");
  await bridge.stop();
});

test("S1b：同代并发刷新，较早读取迟到不得覆盖较新快照", async () => {
  const host = createSyncHost();
  const { service, gate, arm } = createGateableSnapshotService();
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();

  // 并发刷新：A 走门控（会迟到），B 立即完成
  arm();
  const olderRefresh = bridge.refresh(); // A：readCoreView 挂起
  await tick();
  await bridge.refresh(); // B：立即读取并提交（refresh() 不返回值，快照效果用 section 断言）

  // A 迟到返回一个“更旧”的读取
  gate.resolve({ text: "STALE EARLIER READ", revision: "rOld", scopeId: "amber" });
  await olderRefresh;

  const core = await host.renderSection(SECTION_CORE);
  assert.ok(!core.includes("STALE EARLIER READ"), "较早读取迟到不得覆盖较新快照");
  assert.ok(core.includes("铁律"));
  await bridge.stop();
});

test("S1c：旧工具调用的延迟刷新跨 stop/start 不得写新代快照", async () => {
  const host = createSyncHost();
  const { service, gate, arm } = createGateableSnapshotService();
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();

  // 旧代工具写入：mutate 立即成功，随后的快照刷新被门控挂起
  arm();
  const pendingReceipt = host.tools.get("soul_update").execute({ content: "# 工具写入的人设" });
  await tick();
  await tick();

  bridge.stop(); // mutate 已落库，但其迟到刷新属于旧代
  const newStart = await bridge.start(); // 新代快照 = 当前服务状态
  assert.equal(newStart.tools.length, 9);
  const newCore = await host.renderSection(SECTION_CORE);
  assert.ok(newCore.includes("铁律"), "新代快照来自当前服务");

  // 放行旧代迟到的刷新（伪造旧值）
  gate.resolve({ text: "STALE FROM OLD GEN", revision: "stale", scopeId: "amber" });
  await pendingReceipt;
  await tick();

  const core = await host.renderSection(SECTION_CORE);
  assert.ok(!core.includes("STALE FROM OLD GEN"), "旧代工具的迟到刷新不得写新代快照");
  assert.ok(core.includes("铁律"));
  await bridge.stop();
});

test("S3：已失效代的迟到刷新不得抢占刷新序号、破坏新代初始快照", async () => {
  const host = createSyncHost();
  const base = createFakeService();
  const mutateGate = createDeferred();
  const viewGate = createDeferred();
  let gateMutateReceipt = false;
  let gateView = false;
  const service = {
    ...base,
    async mutate(request) {
      const result = await base.mutate(request); // 写入已生效，回执挂起
      if (gateMutateReceipt) {
        gateMutateReceipt = false;
        await mutateGate.promise;
      }
      return result;
    },
    async readCoreView() {
      if (gateView) {
        gateView = false;
        return viewGate.promise;
      }
      return base.readCoreView();
    },
  };
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start(); // 旧代启动成功

  // 1. 旧代 soul_update：mutate 已写入，回执挂起
  gateMutateReceipt = true;
  const pendingTool = host.tools.get("soul_update").execute({ content: "# 旧代写入" });
  await tick();
  await tick();

  // 2. stop；新代 start 进入初始 readCoreView 并挂起
  bridge.stop();
  gateView = true;
  const newStart = bridge.start();
  await tick();
  await tick();

  // 3. 放行旧代 mutate 回执 → 旧代刷新（不得推进共享序号、不得发起无效读取竞争）
  mutateGate.resolve();
  await pendingTool;
  await tick();

  // 4. 放行新代初始读取 → start 必须成功且快照真实可用
  viewGate.resolve({ text: "## 铁律\n新代核心。", revision: "r3", scopeId: "amber" });
  const result = await newStart;
  assert.equal(result.cancelled, undefined, "新代 start 不受旧代迟到刷新干扰");
  assert.equal(bridge.diagnostics().started, true);

  // 5. 渲染必须可用（反例中抛 INVALID_STATE: snapshot not ready）
  const core = await host.renderSection(SECTION_CORE);
  assert.ok(core.includes("铁律"), "新代快照真实可用，可渲染");
  await bridge.stop();
});

test("S2：被取消的旧 restore 不得回滚新代的 epoch 与去重状态", async () => {
  const loadGate = createDeferred();
  let loadCalls = 0;
  const validSnapshot = {
    epoch: 0,
    compressSeenIds: [],
    watermarks: {},
    expiredSessionIds: [],
    updatedAt: "2026-10-24T00:00:00.000Z",
  };
  const sink = {
    load: async () => {
      loadCalls += 1;
      if (loadCalls === 1) return loadGate.promise; // 旧代挂起
      return validSnapshot; // 新代立即得到合法快照
    },
    save: async () => {},
  };
  const host = createSyncHost();
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "shadow", probeSink: sink });

  const oldStart = bridge.start(); // 旧代：停在 sink.load
  await tick();
  bridge.stop();

  const newStart = await bridge.start(); // 新代：restore 完成（epoch 0），桥启动
  assert.equal(newStart.cancelled, undefined);

  // 新代处理真实归一化 compress 完成事件 → epoch = 1
  const advanced = await bridge.onCompletedTool({
    eventId: "s1:tool/ptc-dispatch:10", sessionId: "s1", name: "compress", success: true, blocksCreated: 2, seq: 10,
  });
  assert.equal(advanced.advanced, true);
  assert.equal(bridge.diagnostics().probe.epoch, 1);

  // 放行旧代合法快照（epoch 0）：isCurrent 把守 → 丢弃候选，不回滚
  loadGate.resolve(validSnapshot);
  const oldResult = await oldStart;
  assert.equal(oldResult.cancelled, true);
  assert.equal(bridge.diagnostics().probe.epoch, 1, "旧代 restore 不得把 epoch 回滚到 0");

  // 去重依据也必须保留：重放同一事件 → duplicate，不重复推进
  const replay = await bridge.onCompletedTool({
    eventId: "s1:tool/ptc-dispatch:10", sessionId: "s1", name: "compress", success: true, blocksCreated: 2, seq: 10,
  });
  assert.equal(replay.reason, "duplicate");
  assert.equal(bridge.diagnostics().probe.epoch, 1);
});
