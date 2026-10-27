// Shiori P4 · test/forgetting/executor.test.mjs
// O 槽单元测试：createForgetExecutor 门面（fake store，非真实组合）。
// 契约：phase5/collab/CONTRACTS.md §1/§3/§5/§7。
// 真实 M/N/O 组合见 test/forgetting/combination.test.mjs（SHIORI_P4_STAGE）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createForgetExecutor } from '../../src/forgetting/executor.mjs';

const SCOPE = 'amber';
const DEFAULT_POLICY = Object.freeze({ baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });

/** 基线合法 plan（每个用例克隆后改）；时间锚点固定。 */
function basePlan(overrides = {}) {
  return {
    version: 1,
    kind: 'archive-ephemeral',
    scopeId: SCOPE,
    now: '2026-10-25T00:00:00.000Z',
    policy: { ...DEFAULT_POLICY },
    sources: [{
      id: 'spk-a', revision: 1, createdAt: '2026-06-01T00:00:00.000Z', lastUsedAt: null, useCount: 0,
    }],
    ...overrides,
  };
}

/** fake store：记录调用，可控返回/抛错。 */
function fakeStore({ receipt } = {}) {
  const calls = [];
  return {
    calls,
    archiveEphemeral(plan, opts) {
      calls.push({ plan, opts });
      if (receipt instanceof Error) throw receipt;
      return receipt ?? {
        version: 1, kind: 'forget-archive-result', scopeId: plan.scopeId,
        operationId: opts.operationId, archivedAt: opts.executedAt, items: [],
      };
    },
  };
}

const allowAuth = () => true;
const fixedNow = () => '2026-10-25T12:00:00.000Z';

function makeExecutor(store, extra = {}) {
  return createForgetExecutor({
    store, scopeId: SCOPE, authorize: allowAuth, now: fixedNow, ...extra,
  });
}

async function assertRejects(promise, code, label) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `${label}：期望 code=${code}，得到 ${e.code}（${e.message}）`);
    assert.ok(e instanceof Error);
    return true;
  }, label);
}

// ---------------------------------------------------------------------------
// factory 严格校验
// ---------------------------------------------------------------------------

test('factory：参数形状与未知键', async () => {
  await assertRejects(Promise.resolve().then(() => createForgetExecutor(null)), 'INVALID_INPUT', 'null options');
  await assertRejects(Promise.resolve().then(() => createForgetExecutor(42)), 'INVALID_INPUT', '非对象');
  const store = fakeStore();
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, extra: 1 })),
    'INVALID_INPUT', '未知键',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE })),
    'INVALID_INPUT', '缺 authorize',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ scopeId: SCOPE, authorize: allowAuth })),
    'INVALID_INPUT', '缺 store',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store: {}, scopeId: SCOPE, authorize: allowAuth })),
    'INVALID_INPUT', 'store.archiveEphemeral 非函数',
  );
});

test('factory：scopeId 先查类型再复用 validateScopeId（不泄漏原生 TypeError）', async () => {
  const store = fakeStore();
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: 123, authorize: allowAuth })),
    'INVALID_INPUT', '数字 scopeId',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: null, authorize: allowAuth })),
    'INVALID_INPUT', 'null scopeId',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: 'GLOBAL', authorize: allowAuth })),
    'INVALID_INPUT', '与 global 大小写互斥的基线规则仍然生效',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: ' bad', authorize: allowAuth })),
    'INVALID_INPUT', '首空白被基线拒绝',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: 'a\u007fb', authorize: allowAuth })),
    'INVALID_INPUT', '控制字符被基线拒绝',
  );
});

test('factory：authorize/now/policy 严格校验', async () => {
  const store = fakeStore();
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: 'yes' })),
    'INVALID_INPUT', 'authorize 非函数',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, now: undefined })),
    'INVALID_INPUT', 'now 显式 undefined',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, now: 'x' })),
    'INVALID_INPUT', 'now 非函数',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, policy: { unknown: 1 } })),
    'INVALID_INPUT', 'policy 未知键',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, policy: { archiveScore: undefined } })),
    'INVALID_INPUT', 'policy 显式 undefined',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, policy: { archiveScore: Number.NaN } })),
    'INVALID_INPUT', 'policy NaN',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, policy: { baseHalfLifeDays: 366 } })),
    'INVALID_INPUT', 'base 超上界',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, policy: { baseHalfLifeDays: 60, maxHalfLifeDays: 30 } })),
    'INVALID_INPUT', 'max < base',
  );
  await assertRejects(
    Promise.resolve().then(() => createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, policy: { archiveScore: 0 } })),
    'INVALID_INPUT', 'archiveScore 闭界 0',
  );
  // 部分覆盖 + 补默认：合法
  const ex = createForgetExecutor({
    store, scopeId: SCOPE, authorize: allowAuth, now: fixedNow, policy: { archiveScore: 0.2 },
  });
  assert.equal(typeof ex.execute, 'function');
  await ex.execute(basePlan({
    policy: { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.2 },
  }), { operationId: 'op-partial-policy' });
});

test('factory：null 原型 policy 是合法普通对象；返回对象只含 execute', async () => {
  const store = fakeStore();
  const ex = createForgetExecutor({
    store, scopeId: SCOPE, authorize: allowAuth, now: fixedNow,
    policy: Object.assign(Object.create(null), { archiveScore: 0.3 }),
  });
  assert.deepEqual(Object.keys(ex).sort(), ['execute']);
  await ex.execute(basePlan({
    policy: { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.3 },
  }), { operationId: 'op-nullproto' });
});

// ---------------------------------------------------------------------------
// plan / opts 完整校验（全部位于首次 await 前：authorize 与 store 均不得被触碰）
// ---------------------------------------------------------------------------

test('plan：非法形状全部 INVALID_INPUT 且不触发 authorize/store', async () => {
  const store = fakeStore();
  let authCalls = 0;
  const ex = createForgetExecutor({
    store, scopeId: SCOPE, now: fixedNow,
    authorize: () => { authCalls += 1; return true; },
  });
  const badPlans = [
    ['非对象', null],
    ['数组', []],
    ['字符串', 'plan'],
    ['未知键', { ...basePlan(), extra: true }],
    ['缺 sources', (() => { const p = basePlan(); delete p.sources; return p; })()],
    ['version', basePlan({ version: 2 })],
    ['kind', basePlan({ kind: 'archive' })],
    ['scope 不一致', basePlan({ scopeId: 'other' })],
    ['now 非规范（缺毫秒）', basePlan({ now: '2026-10-25T00:00:00Z' })],
    ['now 非规范（本地偏移）', basePlan({ now: '2026-10-25T08:00:00.000+08:00' })],
    ['now Date 对象', basePlan({ now: new Date(0) })],
    ['now 数字', basePlan({ now: 0 })],
    ['policy 未知键', basePlan({ policy: { ...DEFAULT_POLICY, x: 1 } })],
    ['policy 缺字段', basePlan({ policy: { baseHalfLifeDays: 30 } })],
    ['policy 与 factory 不一致', basePlan({ policy: { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.5 } })],
    ['sources 非数组', basePlan({ sources: {} })],
    ['sources 空', basePlan({ sources: [] })],
    ['sources 21 项', basePlan({ sources: Array.from({ length: 21 }, (_, i) => ({ id: `spk-${i}`, revision: 1, createdAt: '2026-06-01T00:00:00.000Z', lastUsedAt: null, useCount: 0 })) })],
  ];
  for (const [label, plan] of badPlans) {
    await assertRejects(ex.execute(plan, { operationId: 'op-x' }), 'INVALID_INPUT', label);
  }
  assert.equal(authCalls, 0, '非法 plan 不得触发 authorize');
  assert.equal(store.calls.length, 0, '非法 plan 不得触碰 store');
});

test('plan.sources 项字段校验', async () => {
  const store = fakeStore();
  const ex = makeExecutor(store);
  const good = { id: 'spk-a', revision: 1, createdAt: '2026-06-01T00:00:00.000Z', lastUsedAt: null, useCount: 0 };
  const bad = [
    ['source 非对象', 42],
    ['source 未知键', { ...good, extra: 1 }],
    ['source 缺 useCount', (() => { const s = { ...good }; delete s.useCount; return s; })()],
    ['id 非法字符', { ...good, id: 'bad id' }],
    ['id 点结尾', { ...good, id: 'spk-a.' }],
    ['id 保留名', { ...good, id: '__proto__' }],
    ['id 超长', { ...good, id: `a${'x'.repeat(64)}` }],
    ['revision 0', { ...good, revision: 0 }],
    ['revision 非整数', { ...good, revision: 1.5 }],
    ['revision 非 safe integer', { ...good, revision: 2 ** 53 }],
    ['createdAt 非规范', { ...good, createdAt: '2026-06-01' }],
    ['lastUsedAt 非法（数字）', { ...good, lastUsedAt: 5 }],
    ['lastUsedAt 非规范 ISO', { ...good, lastUsedAt: '2026-07-01T00:00:00Z' }],
    ['useCount 负数', { ...good, useCount: -1 }],
    ['useCount 非整数', { ...good, useCount: 0.5 }],
  ];
  for (const [label, source] of bad) {
    await assertRejects(ex.execute(basePlan({ sources: [source] }), { operationId: 'op-s' }), 'INVALID_INPUT', label);
  }
  assert.equal(store.calls.length, 0);
  // lastUsedAt 合法 ISO 值通过
  await ex.execute(basePlan({ sources: [{ ...good, lastUsedAt: '2026-08-01T00:00:00.000Z', useCount: 3 }] }), { operationId: 'op-s-ok' });
  assert.equal(store.calls.length, 1);
});

test('plan.sources 重复 id 拒绝；恰好 20 项通过', async () => {
  const store = fakeStore();
  const ex = makeExecutor(store);
  const mk = (id) => ({ id, revision: 1, createdAt: '2026-06-01T00:00:00.000Z', lastUsedAt: null, useCount: 0 });
  await assertRejects(
    ex.execute(basePlan({ sources: [mk('spk-a'), mk('spk-a')] }), { operationId: 'op-dup' }),
    'INVALID_INPUT', '重复 id',
  );
  const twenty = Array.from({ length: 20 }, (_, i) => mk(`spk-${String(i).padStart(2, '0')}`));
  await ex.execute(basePlan({ sources: twenty }), { operationId: 'op-20' });
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].plan.sources.length, 20);
});

test('opts：形状/未知键/operationId 严格校验', async () => {
  const store = fakeStore();
  const ex = makeExecutor(store);
  const plan = basePlan();
  await assertRejects(ex.execute(plan), 'INVALID_INPUT', '缺 opts');
  await assertRejects(ex.execute(plan, null), 'INVALID_INPUT', 'opts null');
  await assertRejects(ex.execute(plan, { operationId: 'op-1', extra: 1 }), 'INVALID_INPUT', 'opts 未知键');
  await assertRejects(ex.execute(plan, { operationId: undefined }), 'INVALID_INPUT', 'operationId 显式 undefined');
  await assertRejects(ex.execute(plan, { operationId: '' }), 'INVALID_INPUT', '空 operationId');
  await assertRejects(ex.execute(plan, { operationId: 'a/b' }), 'INVALID_INPUT', '含斜杠');
  await assertRejects(ex.execute(plan, { operationId: 'a:b' }), 'INVALID_INPUT', '含冒号');
  await assertRejects(ex.execute(plan, { operationId: '-x' }), 'INVALID_INPUT', '非字母数字开头');
  await assertRejects(ex.execute(plan, { operationId: 'x'.repeat(129) }), 'INVALID_INPUT', '超长');
  assert.equal(store.calls.length, 0, 'opts 非法不得触碰 store');
});

// ---------------------------------------------------------------------------
// 授权语义
// ---------------------------------------------------------------------------

test('authorize 必须严格 === true；否则 AUTHORIZATION_REQUIRED 且不触碰 store', async () => {
  for (const granted of ['true', 1, {}, undefined, null, Promise.resolve(true).valueOf() === true ? 'skip' : 0]) {
    if (granted === 'skip') continue;
    const store = fakeStore();
    const ex = createForgetExecutor({
      store, scopeId: SCOPE, now: fixedNow, authorize: () => granted,
    });
    await assertRejects(
      ex.execute(basePlan(), { operationId: 'op-auth' }),
      'AUTHORIZATION_REQUIRED', `granted=${JSON.stringify(granted) ?? String(granted)}`,
    );
    assert.equal(store.calls.length, 0);
  }
});

test('authorize 抛错原样传播（不包装）', async () => {
  const boom = new Error('宿主拒绝：用户未确认');
  boom.code = 'HOST_DENIED';
  const store = fakeStore();
  const ex = createForgetExecutor({
    store, scopeId: SCOPE, now: fixedNow, authorize: () => { throw boom; },
  });
  await assert.rejects(
    ex.execute(basePlan(), { operationId: 'op-throw' }),
    (e) => e === boom,
    '同一致错误对象冒泡',
  );
  assert.equal(store.calls.length, 0);
});

test('authorize 收到 {kind,scopeId,plan,operationId}，plan 为独立 clone（篡改不影响执行）', async () => {
  const store = fakeStore();
  const ex = createForgetExecutor({
    store, scopeId: SCOPE, now: fixedNow,
    authorize: async (req) => {
      assert.equal(req.kind, 'forget-archive');
      assert.equal(req.scopeId, SCOPE);
      assert.equal(req.operationId, 'op-clone');
      assert.deepEqual(req.plan, basePlan());
      // 回调篡改收到的 plan / 试图越权
      req.plan.sources = [];
      req.plan.scopeId = 'hijack';
      req.operationId = 'hijack';
      req.kind = 'evil';
      return true;
    },
  });
  const plan = basePlan();
  await ex.execute(plan, { operationId: 'op-clone' });
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].plan.sources.length, 1, '篡改 authorize 收到的 plan 不影响执行');
  assert.equal(store.calls[0].plan.scopeId, SCOPE);
  assert.equal(store.calls[0].opts.operationId, 'op-clone');
  assert.deepEqual(plan, basePlan(), '调用方原 plan 不被改动');
});

test('每次尝试（含同 operationId 重试）都重新 authorize', async () => {
  const store = fakeStore();
  let authCalls = 0;
  const ex = createForgetExecutor({
    store, scopeId: SCOPE, now: fixedNow,
    authorize: () => { authCalls += 1; return authCalls >= 3; },
  });
  await assertRejects(ex.execute(basePlan(), { operationId: 'op-reauth' }), 'AUTHORIZATION_REQUIRED', '第 1 次');
  await assertRejects(ex.execute(basePlan(), { operationId: 'op-reauth' }), 'AUTHORIZATION_REQUIRED', '第 2 次');
  const r = await ex.execute(basePlan(), { operationId: 'op-reauth' });
  assert.equal(r.operationId, 'op-reauth');
  assert.equal(authCalls, 3, '三次尝试三次授权');
  assert.equal(store.calls.length, 1, '仅授权通过的那次触达 store');
});

test('首次 await 前 clone：authorize 挂起期间调用方改写 plan 不影响执行', async () => {
  const store = fakeStore();
  const ex = createForgetExecutor({
    store, scopeId: SCOPE, now: fixedNow,
    authorize: () => new Promise((resolve) => setTimeout(() => resolve(true), 10)),
  });
  const plan = basePlan();
  const p = ex.execute(plan, { operationId: 'op-mutate' });
  plan.sources = [];
  plan.now = '2030-01-01T00:00:00.000Z';
  await p;
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].plan.sources.length, 1, 'store 收到的是首 await 前快照');
  assert.equal(store.calls[0].plan.now, '2026-10-25T00:00:00.000Z');
});

// ---------------------------------------------------------------------------
// 可信时钟
// ---------------------------------------------------------------------------

test('now() 返回非规范 ISO 拒绝；now < plan.now INVALID_STATE 且不触碰 store', async () => {
  const store = fakeStore();
  const bad = createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, now: () => '2026-10-25 12:00:00' });
  await assertRejects(bad.execute(basePlan(), { operationId: 'op-now' }), 'INVALID_INPUT', '非规范时钟');
  const rollback = createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, now: () => '2026-10-24T23:59:59.999Z' });
  await assertRejects(rollback.execute(basePlan(), { operationId: 'op-rb' }), 'INVALID_STATE', '时钟早于 plan.now');
  assert.equal(store.calls.length, 0, 'fail-closed：即使底层同 op 可重放也不调用 store');
});

test('now() === plan.now 恰好放行；缺省 now 用真实系统时钟', async () => {
  const store = fakeStore();
  const eq = createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth, now: () => '2026-10-25T00:00:00.000Z' });
  const r = await eq.execute(basePlan(), { operationId: 'op-eq' });
  assert.equal(r.archivedAt, '2026-10-25T00:00:00.000Z');
  assert.equal(store.calls[0].opts.executedAt, '2026-10-25T00:00:00.000Z');

  const sys = createForgetExecutor({ store, scopeId: SCOPE, authorize: allowAuth });
  const futurePlan = basePlan({ now: '2000-01-01T00:00:00.000Z' });
  await sys.execute(futurePlan, { operationId: 'op-sys' });
  assert.ok(store.calls[1].opts.executedAt >= '2026-01-01T00:00:00.000Z', '缺省时钟取当前系统时间');
});

// ---------------------------------------------------------------------------
// store 转发与结果
// ---------------------------------------------------------------------------

test('只调用一次 store.archiveEphemeral(clone, {operationId,executedAt})，结果独立 clone，store 抛错原样传播', async () => {
  const receipt = {
    version: 1, kind: 'forget-archive-result', scopeId: SCOPE, operationId: 'op-r',
    archivedAt: '2026-10-25T12:00:00.000Z',
    items: [{ id: 'spk-a', title: 't', summary: '', revision: 2, state: 'archived', archivedAt: '2026-10-25T12:00:00.000Z', extra: { nested: [1] } }],
  };
  const store = fakeStore({ receipt });
  const ex = makeExecutor(store);
  const plan = basePlan();
  const out = await ex.execute(plan, { operationId: 'op-r' });
  assert.equal(store.calls.length, 1);
  assert.notEqual(store.calls[0].plan, plan, 'store 收到独立 clone');
  assert.deepEqual(store.calls[0].plan, plan);
  assert.deepEqual(store.calls[0].opts, { operationId: 'op-r', executedAt: '2026-10-25T12:00:00.000Z' });
  assert.deepEqual(out, receipt);
  assert.notEqual(out, receipt, '返回结果为独立 clone');
  out.items.length = 0;
  assert.equal(receipt.items.length, 1, '改动返回值不影响 store 原件');

  const boom = new Error('REVISION_CONFLICT from store');
  const store2 = fakeStore({ receipt: boom });
  const ex2 = makeExecutor(store2);
  await assert.rejects(
    ex2.execute(basePlan(), { operationId: 'op-boom' }),
    (e) => e === boom,
    'store 错误原样传播',
  );
});

test('execute 不接受 authorize/now/scope/root 覆盖：请求里没有这些通道', async () => {
  const store = fakeStore();
  const ex = makeExecutor(store);
  // plan/opts 的严格键集合本身封死了越权键；这里验证带越权键的请求被拒
  await assertRejects(
    ex.execute(basePlan({ authorize: allowAuth }), { operationId: 'op-hijack' }),
    'INVALID_INPUT', 'plan 携带 authorize',
  );
  await assertRejects(
    ex.execute(basePlan({ scope: 'x' }), { operationId: 'op-hijack2' }),
    'INVALID_INPUT', 'plan 携带 scope',
  );
  await assertRejects(
    ex.execute(basePlan(), { operationId: 'op-hijack3', now: fixedNow }),
    'INVALID_INPUT', 'opts 携带 now',
  );
  assert.equal(store.calls.length, 0);
});
