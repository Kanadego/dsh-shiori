// F7 · bridge（非 RPC）通路只读降级测试（任务书 e 项 + f 项 host 侧拒写用例）。
//
// 基线核对结论（写进交付 note）：src/host/index.mjs 的 start() 在 active 模式
// 已先占座位、把 readonlyGuard 传给 createCompatTools（tools.mjs 写工具逐个
// assertNotHostLocked），diagnostics().readonly 也已透出——(e) 的接线在基线
// e5a9e5d 已完成，本文件用真实座位心跳（真实文件系统 + 真实 pid）证明行为：
//   - 更早的活座位存在时，桥的写工具返回结构化 HOST_LOCKED（code + details.holder），
//     且绝不触达 service.mutate；
//   - 读工具照常；L0/L1 section 照常注册（注入不受影响）；
//   - diagnostics().readonly.writable 如实为 false；
//   - 没有更早座位时行为与 0.1 一致（可写）。
// 两个座位同进程不同 instanceId：座位判据按 pid+instanceId 区分，
// startedAt 注入造成「先来/后来」——不需要真的两个进程。

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHostBridge, SECTION_PERSONA, SECTION_CORE } from '../../src/host/index.mjs';
import { createSeatGuard } from '../../src/host/seat.mjs';

function fakeService() {
  const calls = [];
  return {
    calls,
    async readPersona() { return { name: 'p', text: 'persona', revision: 'r0' }; },
    async readCoreView() { return { text: 'core', scopeId: 's', revision: 'r1' }; },
    async readTopic(key) { return { key, title: 't', summary: 's', body: 'b', scopeId: 's', revision: 'r2' }; },
    async listTopics() { return []; },
    async search() { return []; },
    async mutate(request) { calls.push(request); return { operationId: 'op', generation: 1, changes: [] }; },
  };
}

function fakeHost() {
  const sections = [];
  const tools = [];
  return {
    sections,
    tools,
    registerSystemSection(def) { sections.push(def); return () => {}; },
    registerTool(tool) { tools.push(tool); return () => {}; },
    subscribeCompletedTools() { return () => {}; },
    getSessionInfo() { return { sessionId: null }; },
  };
}

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-readonly-bridge-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return root;
}

test('bridge 拒写：更早活座位存在时，active 桥写工具抛 HOST_LOCKED（结构化）且不触达 service.mutate', async (t) => {
  const root = await tempRoot(t);
  // 「先启动」的宿主：更早的 startedAt，占住写权。
  const holder = await createSeatGuard({ dataRoot: root, instanceId: 'holder-earlier', startedAt: 1000 });

  const service = fakeService();
  const host = fakeHost();
  const bridge = createHostBridge({
    host,
    service,
    mode: 'active',
    config: { hostBridge: { allowActive: true } },
    dataRoot: root,
  });
  t.after(async () => { await bridge.stop(); await holder.stop(); });
  const startResult = await bridge.start();
  assert.equal(startResult.cancelled, undefined, '启动不被取消');

  // diagnostics 如实报只读（与 controller RPC 路径同口径）。
  const readonly = bridge.diagnostics().readonly;
  assert.ok(readonly && readonly.writable === false, 'diagnostics.readonly.writable === false');
  assert.ok(readonly.holder && readonly.holder.pid === process.pid, 'holder 透出占座者 pid');

  // 写工具：结构化 HOST_LOCKED（code + details.holder），绝不触达 service.mutate。
  const byName = new Map(host.tools.map((tool) => [tool.name, tool]));
  await assert.rejects(byName.get('soul_update').execute({ content: 'new persona' }), (error) => {
    assert.equal(error.code, 'HOST_LOCKED');
    assert.ok(error.details && error.details.holder && error.details.holder.pid === process.pid, 'details.holder 结构化');
    return true;
  });
  await assert.rejects(byName.get('core_write').execute({ content: 'c', expectedRevision: 'r1' }), (error) => {
    assert.equal(error.code, 'HOST_LOCKED');
    return true;
  });
  assert.equal(service.calls.length, 0, '只读态写请求不得触达 service.mutate');

  // 读工具照常。
  const soulRead = await byName.get('soul_read').execute({});
  assert.equal(soulRead.exists, true);
  const memoryRead = await byName.get('memory_read').execute({});
  assert.equal(memoryRead.content, 'core');

  // L0/L1 注入不受影响：两个 section 照常注册。
  assert.ok(host.sections.some((s) => s.name === SECTION_PERSONA), 'persona section 已注册');
  assert.ok(host.sections.some((s) => s.name === SECTION_CORE), 'core section 已注册');

  await bridge.stop();
  await holder.stop();
});

test('bridge 可写：无更早座位时 active 桥行为与 0.1 一致', async (t) => {
  const root = await tempRoot(t);
  const service = fakeService();
  const host = fakeHost();
  const bridge = createHostBridge({
    host,
    service,
    mode: 'active',
    config: { hostBridge: { allowActive: true } },
    dataRoot: root,
  });
  t.after(async () => { await bridge.stop(); });
  await bridge.start();
  assert.equal(bridge.diagnostics().readonly.writable, true, '无更早座位 → 可写');
  const byName = new Map(host.tools.map((tool) => [tool.name, tool]));
  await byName.get('soul_update').execute({ content: 'new persona' });
  assert.equal(service.calls.length, 1, '可写态写请求触达 service.mutate');
  await bridge.stop();
});

test('bridge shadow / 无 dataRoot：不占座、无只读判定（diagnostics.readonly 为 null）', async (t) => {
  const root = await tempRoot(t);
  const host = fakeHost();
  const bridge = createHostBridge({ host, service: fakeService(), mode: 'shadow' });
  t.after(async () => { bridge.stop(); });
  await bridge.start();
  assert.equal(bridge.diagnostics().readonly, null, 'shadow 不占座 → readonly 为 null');
  await bridge.stop();
  void root;
});
