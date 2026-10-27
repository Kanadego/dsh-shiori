import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostBridge } from "../../src/host/index.mjs";
import { isCodedError } from "../../src/host/errors.mjs";
import { ACTIVE_CONFIG, createFakeService } from "./helpers.mjs";

const tick = () => new Promise((r) => setImmediate(r));
const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/**
 * 门控宿主：section 立即注册；工具注册可被 gate 推迟（模拟真实适配层 async 注册），
 * gate resolve 时才真正登记并返回 disposer；reject 则注册失败。
 * 同名重复注册抛错（对齐 cordis 真实语义，dsh-native.js:131 "already registered"），
 * 因此旧代迟到注册实际走失败路径，不会覆盖新代同名工具。
 */
function createGatedHost() {
  const sections = new Map();
  const tools = new Map();
  const listeners = new Set();
  let pendingGate = null;
  return {
    capabilities: { asyncSectionText: false },
    registerSystemSection({ name, order, text }) {
      if (sections.has(name)) throw new Error(`${name} already registered`);
      sections.set(name, { order, text });
      return () => sections.delete(name);
    },
    registerTool(tool) {
      const register = () => {
        if (tools.has(tool.name)) {
          throw new Error(`${tool.name} already registered by another provider`);
        }
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      };
      if (pendingGate) {
        const gate = pendingGate;
        pendingGate = null;
        return gate.promise.then(register);
      }
      return Promise.resolve(register());
    },
    armToolGate() {
      const gate = createDeferred();
      pendingGate = gate;
      return gate;
    },
    subscribeCompletedTools(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSessionInfo: () => ({ sessionId: "sess-gated", scopeId: "amber", capabilities: {} }),
    listRegisteredTools: () => [...tools.keys()],
    listRegisteredSections: () => [...sections.keys()],
    sections,
    tools,
    listeners,
    listenerCount: () => listeners.size,
  };
}

test("L1：stop 能取消等待 restore 的启动（取消后不订阅、不置 started）", async () => {
  const host = createGatedHost();
  const loadGate = createDeferred();
  const sink = { load: () => loadGate.promise, save: async () => {} };
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "shadow", probeSink: sink });

  const pendingStart = bridge.start();
  await tick();
  const stopped = bridge.stop(); // 在 restore 等待期间取消
  assert.ok(stopped.disposed >= 0);

  loadGate.resolve(null); // 让 restore 完成
  const result = await pendingStart;
  assert.equal(result.cancelled, true, "取消的 start 必须返回取消回执");
  assert.equal(result.sections.length, 0);
  assert.equal(result.tools.length, 0);
  assert.equal(host.listenerCount(), 0, "已取消的 start 不得保留订阅");
  assert.equal(host.sections.size, 0);
  assert.equal(host.tools.size, 0);
  assert.equal(bridge.diagnostics().started, false, "stop 已返回，桥不得重新存活");

  // 取消后可以正常启动
  const started = await bridge.start();
  assert.equal(started.cancelled, undefined);
  assert.equal(host.listenerCount(), 1);
  await bridge.stop();
});

test("L2：旧代迟到的注册只撤销自身，不混入新代（18 !== 9 反例）", async () => {
  const host = createGatedHost();
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "active", config: ACTIVE_CONFIG });

  const gate = host.armToolGate();
  const oldStart = bridge.start(); // 旧代：注册 2 个 section 后停在第一个工具的 gate 上
  await tick();
  await tick();
  assert.equal(host.sections.size, 2, "旧代 section 已注册");
  assert.equal(host.tools.size, 0);

  bridge.stop();
  assert.equal(host.sections.size, 0, "stop 回收旧代已注册内容");

  const newStart = await bridge.start(); // 新代：gate 已消费，立即完整注册
  assert.equal(newStart.tools.length, 9);
  assert.equal(newStart.cancelled, undefined);
  assert.equal(host.tools.size, 9);
  assert.equal(host.sections.size, 2);

  gate.resolve(() => {}); // 旧代迟到的工具注册此刻才完成：同名已被新代占用 → 宿主抛错（cordis 语义）
  await assert.rejects(
    () => oldStart,
    (e) => /already registered/.test(e.message),
    "旧代迟到注册走失败路径，旧调用方收到冲突错误",
  );
  await tick();
  assert.equal(host.tools.size, 9, "既不是 18（混入）也不是 8（误删新代）：恰好新代的 9");
  assert.equal(host.sections.size, 2);
  assert.equal(bridge.diagnostics().started, true, "新代不受旧代迟到注册影响");
  await bridge.stop();
});

test("L2b：start 进行中拒绝并发 start", async () => {
  const host = createGatedHost();
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "active", config: ACTIVE_CONFIG });
  const gate = host.armToolGate();
  const first = bridge.start();
  await tick();
  await assert.rejects(
    () => bridge.start(),
    (e) => isCodedError(e) && e.code === "INVALID_STATE" && /in progress/.test(e.message),
  );
  gate.resolve(() => {});
  await first;
  await bridge.stop();
});

test("L3：旧代迟到失败只回收旧代，已成功的新代原样保留", async () => {
  const host = createGatedHost();
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "active", config: ACTIVE_CONFIG });

  const gate = host.armToolGate();
  const oldStart = bridge.start();
  await tick();
  await tick();

  bridge.stop();
  const newStart = await bridge.start(); // 新代成功启动
  assert.equal(newStart.tools.length, 9);
  assert.equal(bridge.diagnostics().started, true);

  gate.reject(new Error("tool loader died")); // 旧代此刻才失败
  await assert.rejects(() => oldStart, /tool loader died/);
  await tick();

  assert.equal(host.tools.size, 9, "新代 9 个工具不被旧代失败清空");
  assert.equal(host.sections.size, 2, "新代 section 不被旧代失败回收");
  assert.equal(host.listenerCount(), 1, "新代订阅不被旧代失败回收");
  assert.equal(bridge.diagnostics().started, true, "started 不被旧代 catch 改写");
  await bridge.stop();
  assert.equal(host.tools.size, 0);
  assert.equal(host.listenerCount(), 0);
});

test("L3b：active 初始 snapshot 延迟期间 stop → 新代成功，旧代取消", async () => {
  const host = createGatedHost();
  const snapshotGate = createDeferred();
  let gatedCall = true;
  const service = {
    ...createFakeService(),
    async readCoreView() {
      if (gatedCall) {
        gatedCall = false;
        return snapshotGate.promise;
      }
      return { text: "核心正文。", revision: "r", scopeId: "amber" };
    },
  };
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });

  const oldStart = bridge.start(); // 停在初始快照读取
  await tick();
  bridge.stop();

  snapshotGate.resolve({ text: "旧代迟到的快照", revision: "r0", scopeId: "amber" });
  const oldResult = await oldStart;
  assert.equal(oldResult.cancelled, true, "快照延迟取消返回取消回执");
  assert.equal(host.listenerCount(), 0, "取消的 start 不得订阅");
  assert.equal(host.sections.size, 0);

  // 新代正常启动
  const newStart = await bridge.start();
  assert.equal(newStart.tools.length, 9);
  assert.equal(host.listenerCount(), 1);
  await bridge.stop();
});

test("L1b：shadow restore 延迟期间重复失败启动不累积；stop→start 正常", async () => {
  const host = createGatedHost();
  let failLoads = 2;
  const sink = {
    load: async () => {
      if (failLoads > 0) {
        failLoads -= 1;
        throw new Error("state file corrupted");
      }
      return null;
    },
    save: async () => {},
  };
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "shadow", probeSink: sink });
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(() => bridge.start(), /state file corrupted/);
    assert.equal(host.listenerCount(), 0, "失败启动不得泄漏订阅");
  }
  const started = await bridge.start();
  assert.equal(host.listenerCount(), 1, "成功重启后恰好一次订阅");
  const stopped = bridge.stop();
  assert.ok(stopped.disposed >= 1);
  assert.equal(host.listenerCount(), 0);
});
