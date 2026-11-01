// F7 · 锁 owner 字段与只读探针测试。
//
// 覆盖（迭代清单 F7 / 子任务验收）：
// - withLock 写入方带 owner（opts.owner），不带时 payload 与 v0.1.0 完全一致；
// - 旧 payload（无 owner）可读：inspectExternalHolder 回退 PID 展示；
// - 带 owner 的 payload 可读：app/workspace/instance 鸭子类型透出；
// - inspectExternalHolder 只读一次、不阻塞、不获取锁、不抛 LOCK_BUSY；
// - 只读滞回状态机：<5 秒不算、≥5 秒算只读、释放 2 秒后恢复（假时钟驱动）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { withLock, inspectExternalHolder } from '../../src/storage/lockfile.mjs';
import {
  createReadonlyStateMachine,
  createReadonlyGuard,
  createWriteLockProbe,
  hostLockedError,
  validateReadonlyGuard,
  READONLY_HOLD_MS,
  WRITABLE_RELEASE_MS,
} from '../../src/host/readonly-guard.mjs';
import { createCompatTools, createTopicCreateTool } from '../../src/host/tools.mjs';
import { createSparkTools } from '../../src/sparks/tools.mjs';

const options = { timeoutMs: 1000, retryMs: 2 };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-lock-owner-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  return { root, lock: path.join(root, '.shiori-lock'), guard: path.join(root, '.shiori-lock.guard') };
}

// ── 写入方带 owner ───────────────────────────────────────────────────────────

test('withLock: opts.owner 写入 payload（app/workspace/instance）', async t => {
  const { root, lock } = await fixture(t);
  await withLock(root, { ...options, owner: { app: 'shiori-dsh', workspace: 'main', instance: 'host-1' } }, async () => {
    const payload = JSON.parse(await fs.readFile(lock, 'utf8'));
    assert.equal(payload.pid, process.pid);
    assert.equal(typeof payload.token, 'string');
    assert.equal(typeof payload.acquiredAt, 'string');
    assert.deepEqual(payload.owner, { app: 'shiori-dsh', workspace: 'main', instance: 'host-1' });
  });
  assert.equal(await fs.readdir(root).then(names => names.length), 0, '释放后无残留');
});

test('withLock: 不带 owner 时 payload 无 owner 字段（与 v0.1.0 一致）', async t => {
  const { root, lock } = await fixture(t);
  await withLock(root, options, async () => {
    const payload = JSON.parse(await fs.readFile(lock, 'utf8'));
    assert.equal('owner' in payload, false);
  });
});

test('withLock: 畸形 / 多余字段 owner 被清洗，不影响锁本身', async t => {
  const { root, lock } = await fixture(t);
  await withLock(root, { ...options, owner: { app: '', workspace: 42, token: ' smuggle', extra: 'x' } }, async () => {
    const payload = JSON.parse(await fs.readFile(lock, 'utf8'));
    assert.equal('owner' in payload, false, '全字段无效时不得写入空 owner');
  });
});

// ── inspectExternalHolder：旧 / 新 payload ──────────────────────────────────

test('inspectExternalHolder: 无锁文件 → held:false, owner:null', async t => {
  const { root } = await fixture(t);
  assert.deepEqual(await inspectExternalHolder(root), { held: false, owner: null });
});

test('inspectExternalHolder: 旧 payload（无 owner）可读，展示回退 PID', async t => {
  const { root, lock } = await fixture(t);
  // 必须用活着的 pid：死主残留一律 held:false（F7 自锁死防护）。
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: 'legacy', acquiredAt: '2020-01-01T00:00:00.000Z' }));
  const result = await inspectExternalHolder(root);
  assert.equal(result.held, true);
  assert.equal(result.owner.pid, process.pid);
  assert.equal(result.owner.acquiredAt, '2020-01-01T00:00:00.000Z');
  assert.equal('app' in result.owner, false, '旧 payload 不得伪造 owner 展示字段');
});

test('inspectExternalHolder: 带 owner 的 payload 鸭子类型透出', async t => {
  const { root, lock } = await fixture(t);
  await fs.writeFile(lock, JSON.stringify({
    pid: process.pid, token: 'x', acquiredAt: '2020-01-01T00:00:00.000Z',
    owner: { app: 'shiori-dsh', workspace: 'main' },
  }));
  const result = await inspectExternalHolder(root);
  assert.equal(result.held, true);
  assert.deepEqual(result.owner, { pid: process.pid, acquiredAt: '2020-01-01T00:00:00.000Z', app: 'shiori-dsh', workspace: 'main' });
});

test('inspectExternalHolder: 畸形 / 缺字段 payload → held:false（unknown 状态）', async t => {
  const { root, lock } = await fixture(t);
  await fs.writeFile(lock, 'not json at all');
  let result = await inspectExternalHolder(root);
  assert.equal(result.held, false);
  assert.equal(result.owner, null);
  assert.equal(result.state, 'unknown');

  await fs.writeFile(lock, JSON.stringify({ pid: 1234 })); // 缺 token
  result = await inspectExternalHolder(root);
  assert.equal(result.held, false);
  assert.equal(result.state, 'unknown');
});

test('inspectExternalHolder: 持锁中调用 → held:true 且不阻塞、不抛 LOCK_BUSY', async t => {
  const { root } = await fixture(t);
  await withLock(root, { ...options, owner: { app: 'self-test' } }, async () => {
    const result = await inspectExternalHolder(root);
    assert.equal(result.held, true);
    assert.equal(result.owner.pid, process.pid);
    assert.equal(result.owner.app, 'self-test');
  });
});

test('inspectExternalHolder: guard 目录存在时仍正常返回（不参与 guard 竞争）', async t => {
  const { root, guard, lock } = await fixture(t);
  await fs.mkdir(guard);
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: 'x', acquiredAt: 't' }));
  const result = await inspectExternalHolder(root);
  assert.equal(result.held, true);
  assert.equal(result.owner.pid, process.pid);
  await fs.rmdir(guard);
});

test('inspectExternalHolder: 死主残留锁 → held:false + state:stale（不把只读挡在写路径前）', async t => {
  const { root, lock } = await fixture(t);
  // 2147483646 不会是真进程：找不到即判死主（ESRCH）。
  await fs.writeFile(lock, JSON.stringify({ pid: 2147483646, token: 'x', acquiredAt: 't' }));
  const result = await inspectExternalHolder(root);
  assert.equal(result.held, false, '死主不得报 held:true，否则本 host 永久只读、acquire 期回收永不执行');
  assert.equal(result.owner, null);
  assert.equal(result.state, 'stale');
  assert.equal(result.stale, true);
  await fs.stat(lock); // 探针只读，不删文件（回收归 acquire）
});

// ── 只读滞回状态机（假时钟）─────────────────────────────────────────────────

function machineWithFakeClock() {
  let t = 0;
  const machine = createReadonlyStateMachine({ now: () => t });
  return { machine, advance: (ms) => { t += ms; }, now: () => t };
}
const HOLD = { held: true, owner: { pid: 999, app: 'other-host' } };
const FREE = { held: false, owner: null };

test('滞回：外部持有 <5 秒不算只读', t => {
  const { machine, advance } = machineWithFakeClock();
  machine.observe(HOLD);
  advance(READONLY_HOLD_MS - 1);
  const status = machine.observe(HOLD);
  assert.equal(status.writable, true);
  assert.equal(status.readonly, false);
});

test('滞回：外部持有 ≥5 秒判为只读，holder 透出', t => {
  const { machine, advance } = machineWithFakeClock();
  machine.observe(HOLD);
  advance(READONLY_HOLD_MS);
  const status = machine.observe(HOLD);
  assert.equal(status.readonly, true);
  assert.equal(status.holder.pid, 999);
  assert.equal(status.holder.app, 'other-host');
});

test('滞回：只读后释放 <2 秒不恢复；释放期间再次持有则释放计时清零', t => {
  const { machine, advance } = machineWithFakeClock();
  machine.observe(HOLD);
  advance(READONLY_HOLD_MS);
  assert.equal(machine.observe(HOLD).readonly, true);

  advance(1);
  assert.equal(machine.observe(FREE).readonly, true, '释放第 1ms：仍只读');
  advance(WRITABLE_RELEASE_MS - 1);
  assert.equal(machine.observe(FREE).writable, false, '释放不足 2 秒：仍只读');

  advance(1);
  assert.equal(machine.observe(HOLD).readonly, true, '释放将满时又持有：继续只读');
  advance(WRITABLE_RELEASE_MS);
  assert.equal(machine.observe(HOLD).readonly, true, '释放计时已被再次持有清零：不得恢复');
});

test('滞回：锁释放持续 2 秒后恢复可写并清空持有状态', t => {
  const { machine, advance } = machineWithFakeClock();
  machine.observe(HOLD);
  advance(READONLY_HOLD_MS);
  assert.equal(machine.observe(HOLD).readonly, true);

  advance(1);
  assert.equal(machine.observe(FREE).readonly, true);
  advance(WRITABLE_RELEASE_MS);
  const status = machine.observe(FREE);
  assert.equal(status.writable, true);
  assert.equal(status.holder, null);
  assert.equal(status.heldSince, null);
});

test('滞回：可写态下瞬时争用消失立即清零，重新持有重新计时', t => {
  const { machine, advance } = machineWithFakeClock();
  machine.observe(HOLD);
  advance(READONLY_HOLD_MS - 1);
  assert.equal(machine.observe(HOLD).writable, true);
  advance(1);
  assert.equal(machine.observe(FREE).writable, true, '争用消失：非只读态不翻转');
  advance(1);
  machine.observe(HOLD);
  advance(READONLY_HOLD_MS - 1);
  assert.equal(machine.observe(HOLD).writable, true, '重新持有从零计时，差 1ms 不得翻转');
  advance(1);
  assert.equal(machine.observe(HOLD).readonly, true);
});

test('createReadonlyGuard: poll 推进状态机；assertWritable 只读态抛 HOST_LOCKED（带 holder）', async t => {
  let t0 = 0;
  const guard = createReadonlyGuard({
    probe: async () => HOLD,
    now: () => t0,
    intervalMs: 50,
  });
  guard.assertWritable(); // 初始可写：放行
  await guard.poll();
  t0 += READONLY_HOLD_MS;
  await guard.poll();
  guard.stop();
  assert.throws(() => guard.assertWritable(), (error) => {
    assert.equal(error.code, 'HOST_LOCKED');
    assert.equal(error.details.holder.pid, 999);
    return true;
  });
  // 结构化错误工厂本身也可直接断言
  const err = hostLockedError({ pid: 7, app: 'x' });
  assert.equal(err.code, 'HOST_LOCKED');
  assert.deepEqual(err.details.holder, { pid: 7, app: 'x' });
});

test('createReadonlyGuard: probe 抛错不推进状态机，保持当前可写性', async t => {
  let failing = false;
  let t0 = 0;
  const guard = createReadonlyGuard({
    probe: async () => {
      if (failing) throw Object.assign(new Error('io'), { code: 'EACCES' });
      return HOLD;
    },
    now: () => t0,
  });
  await guard.poll();
  t0 += READONLY_HOLD_MS;
  await guard.poll();
  assert.equal(guard.status().readonly, true);
  failing = true;
  t0 += WRITABLE_RELEASE_MS + 1;
  await guard.poll(); // 探针失败：状态保持只读（不得凭失败翻转）
  assert.equal(guard.status().readonly, true);
  guard.stop();
});

test('createWriteLockProbe: 逐个 root 探测，第一个持有者胜出；全空 → held:false', async t => {
  const emptyA = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-lock-owner-empty-'));
  const emptyB = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-lock-owner-empty-'));
  const { root, lock } = await fixture(t);
  try {
    const probeEmpty = createWriteLockProbe({ roots: [emptyA, emptyB] });
    assert.deepEqual(await probeEmpty(), { held: false, owner: null });

    // 外部持有者必须是活进程，否则探针按死主跳过（F7 自锁死防护）。
    const { spawn } = await import('node:child_process');
    const foreign = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'ignore' });
    try {
      await fs.writeFile(lock, JSON.stringify({ pid: foreign.pid, token: 'x', acquiredAt: 't', owner: { app: 'a' } }));
      const probe = createWriteLockProbe({ roots: [emptyA, root] });
      const result = await probe();
      assert.equal(result.held, true);
      assert.equal(result.owner.pid, foreign.pid);
    } finally { foreign.kill(); }

    // 自家 pid 持有不算外部持有（否则本进程的长写会把自己翻成只读）。
    await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: 'y', acquiredAt: 't' }));
    assert.equal((await createWriteLockProbe({ roots: [root] })()).held, false);
  } finally {
    await fs.rm(emptyA, { recursive: true, force: true });
    await fs.rm(emptyB, { recursive: true, force: true });
  }
  assert.throws(() => createWriteLockProbe({ roots: [] }), TypeError);
});

test('createWriteLockProbe: 畸形锁 → 抛错（不可判定），不伪装成 held:false', async t => {
  const { root, lock } = await fixture(t);
  await fs.writeFile(lock, 'not json');
  const probe = createWriteLockProbe({ roots: [root] });
  await assert.rejects(() => probe(), /probe failed/);
  // guard 端把抛错解释为「本轮不推进」：可写态保持可写，绝不因不可判定翻只读。
  const guard = createReadonlyGuard({ probe, holdMs: 0, now: () => 0 });
  const status = await guard.poll();
  assert.equal(status.writable, true);
});

test('validateReadonlyGuard: 可选依赖鸭子类型校验——缺省放行、形状错拒绝', () => {
  assert.equal(validateReadonlyGuard(undefined), undefined);
  const good = { assertWritable() {} };
  assert.equal(validateReadonlyGuard(good), good);
  for (const bad of [null, 42, {}, { assertWritable: 'nope' }]) {
    assert.throws(() => validateReadonlyGuard(bad), (error) => error.code === 'INVALID_INPUT');
  }
});

// ── 工具层接线：只读态写工具拒写（F7 / D2）──────────────────────────────────

function readonlyGuardStub(locked) {
  return {
    assertWritable() {
      if (locked) throw hostLockedError({ pid: 777, app: 'other-host' });
    },
  };
}

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

const HOST_WRITE_TOOLS = ['soul_update', 'memory_append', 'memory_rewrite', 'core_write', 'topic_append'];
const HOST_WRITE_PAYLOADS = {
  soul_update: { content: 'new persona' },
  memory_append: { section: 's', content: 'c' },
  memory_rewrite: { content: 'c' },
  core_write: { content: 'c', expectedRevision: 'r1' },
  topic_append: { topic: 'daily', section: 's', content: 'c' },
};

test('接线：只读态下兼容写工具抛 HOST_LOCKED 且绝不触达 service.mutate；读工具照常', async () => {
  const service = fakeService();
  const tools = createCompatTools({
    service,
    getSessionInfo: () => ({ sessionId: null, scopeId: 's' }),
    readonlyGuard: readonlyGuardStub(true),
  });
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  for (const name of HOST_WRITE_TOOLS) {
    await assert.rejects(byName.get(name).execute(HOST_WRITE_PAYLOADS[name]), (error) => {
      assert.equal(error.code, 'HOST_LOCKED');
      assert.equal(error.details.holder.pid, 777);
      return true;
    });
  }
  assert.equal(service.calls.length, 0, '只读态写请求不得触达 service.mutate');
  // 读工具与只读态无关
  const soulRead = await byName.get('soul_read').execute({});
  assert.equal(soulRead.exists, true);
  const memoryRead = await byName.get('memory_read').execute({});
  assert.equal(memoryRead.content, 'core');
});

test('接线：可写态（或无 readonlyGuard）写工具行为与 0.1 一致', async () => {
  for (const guard of [undefined, readonlyGuardStub(false)]) {
    const service = fakeService();
    const tools = createCompatTools({ service, readonlyGuard: guard });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    await byName.get('soul_update').execute({ content: 'new persona' });
    await byName.get('core_write').execute({ content: 'c', expectedRevision: 'r1' });
    assert.equal(service.calls.length, 2);
  }
});

test('接线：topic_create 只读态抛 HOST_LOCKED', async () => {
  const service = fakeService();
  const tool = createTopicCreateTool({ service, readonlyGuard: readonlyGuardStub(true) });
  await assert.rejects(
    tool.execute({ topic: 'daily', title: 'T', summary: 'S' }),
    (error) => error.code === 'HOST_LOCKED',
  );
  assert.equal(service.calls.length, 0);
});

test('接线：只读态下 spark 写工具抛 HOST_LOCKED；spark_read / spark_graph 照常', async () => {
  const storeCalls = [];
  const store = {
    async save(input, options) { storeCalls.push(['save', input]); return { id: 'i1', revision: 1, state: 'active', vitality: 'evergreen' }; },
    async read(id) { return { id, scopeId: 's', revision: 1, title: 't', summary: 's', triggers: [], entities: [], links: [], content: 'c', vitality: 'evergreen', state: 'active' }; },
    async update(id, patch, options) { storeCalls.push(['update', id]); return { id, revision: 2, state: 'active', vitality: 'evergreen' }; },
    async forget(id, options) { storeCalls.push(['forget', id]); return { id, revision: 3, state: 'archived', vitality: 'evergreen' }; },
    async feedback(id, options) { storeCalls.push(['feedback', id]); return { id, revision: 4, state: 'active', vitality: 'evergreen' }; },
    async listActive() { return []; },
  };
  const facade = createSparkTools({ scopeId: 's', store, readonlyGuard: readonlyGuardStub(true) });
  for (const [name, payload] of [
    ['spark_save', { content: 'c', title: 't', triggers: ['a'], vitality: 'evergreen' }],
    ['spark_update', { id: 'i1', patch: { title: 'x' } }],
    ['spark_forget', { id: 'i1', mode: 'archive' }],
    ['spark_feedback', { id: 'i1', used: true }],
  ]) {
    await assert.rejects(facade.execute(name, payload), (error) => {
      assert.equal(error.code, 'HOST_LOCKED');
      return true;
    });
  }
  assert.equal(storeCalls.length, 0, '只读态 spark 写请求不得触达 store');
  const read = await facade.execute('spark_read', { id: 'i1' });
  assert.equal(read.ok, true);
  const graph = await facade.execute('spark_graph', {});
  assert.equal(graph.ok, true);
});

test('接线：readonlyGuard 形状错在工厂创建期拒绝', () => {
  assert.throws(
    () => createCompatTools({ service: fakeService(), readonlyGuard: { nope: 1 } }),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => createTopicCreateTool({ service: fakeService(), readonlyGuard: 42 }),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => createSparkTools({ scopeId: 's', store: { save() {}, read() {}, update() {}, forget() {}, feedback() {}, listActive() {} }, readonlyGuard: 'x' }),
    (error) => error.code === 'INVALID_INPUT',
  );
});
