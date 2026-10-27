// Shiori P3-QUEUE-DIFF · K 槽位测试（node:test，零新增依赖）
//
// 覆盖契约 §5 对 K 的全部反例要求：候选tamper、陈旧源、operation先于CAS、
// 恢复重放、同key异payload、returned alias污染、20/21、合并8..19、全文保全、thin仅草案。
//
// 注意：本文件用独立实现的 canonical/stable2/digest2 构造候选 id，
// 与模块内部实现交叉验证 digest 契约（不 import 模块内部函数）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createCandidateQueue, buildDraft, digestPlan } from '../../src/organize/queue.mjs';

const SCOPE = 'amber';

// --- 独立 canonical/digest 实现（与被测模块交叉验证） -----------------------

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[k] = canonical(value[k]);
    }
    return out;
  }
  return value;
}
const stable2 = (v) => JSON.stringify(canonical(v));
const digest2 = (v) => createHash('sha256').update(Buffer.from(stable2(v), 'utf8')).digest('hex');

// --- 夹具 -------------------------------------------------------------------

let cardSeq = 0;
function makeCard(id, over = {}) {
  cardSeq += 1;
  return {
    id,
    scopeId: SCOPE,
    revision: 1,
    title: `title-${id}`,
    summary: `summary-${id}`,
    triggers: [`tg-${id}`],
    entities: [`en-${id}`],
    links: [],
    content: `content-${id}`,
    vitality: 'evergreen',
    state: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    supersedes: null,
    supersededBy: null,
    hitCount: 0,
    lastHitAt: null,
    useCount: 0,
    lastUsedAt: null,
    ...over,
  };
}

function makeCandidate({ kind = 'link', sources, evidence = { sharedEntities: ['x'] }, scopeId = SCOPE }) {
  const base = { kind, scopeId, sources, evidence };
  return { ...base, id: digest2(base) };
}

const ref = (id, revision = 1) => ({ id, revision });
const sortedRefs = (...ids) => ids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((id) => ref(id));

const expectCode = (codes, fn) => {
  const list = codes.split('|').map((s) => s.trim());
  assert.throws(fn, (err) => err instanceof Error && list.includes(err.code),
    `期望错误码 ${codes} 之一`);
};

// ===========================================================================
// 队列基础与幂等 / CAS
// ===========================================================================

test('新队列为空快照：version/scopeId/revision=0/空 items/operations', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  assert.deepEqual(q.snapshot(), {
    version: 1, scopeId: SCOPE, revision: 0, items: [], operations: Object.create(null),
  });
  // operations 是 null 原型安全字典：继承属性名不得被误读为存在的账项
  const ops = q.snapshot().operations;
  assert.equal(Object.getPrototypeOf(ops), null);
  assert.equal('constructor' in ops, false);
  assert.equal('toString' in ops, false);
  assert.equal(ops.toString, undefined);
});

test('enqueue 入队成功：revision+1、pending 状态、operation 记录含指纹与请求', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  const snap = q.enqueue([a], { expectedRevision: 0, operationId: 'op-enq-1' });
  assert.equal(snap.revision, 1);
  assert.equal(snap.items.length, 1);
  assert.equal(snap.items[0].status, 'pending');
  assert.equal(snap.items[0].candidate.id, a.id);
  const op = snap.operations['op-enq-1'];
  assert.equal(op.kind, 'enqueue');
  assert.match(op.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(op.request, { kind: 'enqueue', candidates: [a] });
  assert.equal(op.result.revision, 1);
  assert.ok(!('operations' in op.result), '业务快照不含 operations，避免递归膨胀');
});

test('enqueue CAS：expectedRevision 不匹配抛 REVISION_CONFLICT 且队列原样', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  q.enqueue([a], { expectedRevision: 0, operationId: 'op-1' });
  const b = makeCandidate({ kind: 'isolated', sources: sortedRefs('c'), evidence: {} });
  expectCode('REVISION_CONFLICT', () => q.enqueue([b], { expectedRevision: 5, operationId: 'op-2' }));
  const snap = q.snapshot();
  assert.equal(snap.revision, 1);
  assert.equal(snap.items.length, 1);
  assert.equal(Object.keys(snap.operations).length, 1);
});

test('幂等按 operationId 先于 CAS：过期 expectedRevision 的同语义重放返回首次业务结果', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  const b = makeCandidate({ kind: 'isolated', sources: sortedRefs('c'), evidence: {} });
  q.enqueue([a], { expectedRevision: 0, operationId: 'op-1' });
  q.enqueue([b], { expectedRevision: 1, operationId: 'op-2' });
  // 当前 revision=2；用过期的 expectedRevision=0 重放 op-1 仍成功
  const replay = q.enqueue([a], { expectedRevision: 0, operationId: 'op-1' });
  assert.equal(replay.revision, 1, '重放返回首次业务结果的 revision');
  assert.equal(replay.items.length, 1);
  assert.ok(replay.operations['op-2'], '附带当前 operations 的克隆');
  assert.equal(q.snapshot().revision, 2, '队列 revision 不因重放变化');
});

test('同 key 异 payload：同 operationId 不同语义拒绝', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  const b = makeCandidate({ kind: 'isolated', sources: sortedRefs('c'), evidence: {} });
  q.enqueue([a], { expectedRevision: 0, operationId: 'op-1' });
  expectCode('INVALID_INPUT', () => q.enqueue([b], { expectedRevision: 1, operationId: 'op-1' }));
  // review 与 enqueue 冲突同样拒绝
  expectCode('INVALID_INPUT', () => q.review(a.id, {
    decision: 'reviewed', expectedRevision: 1, operationId: 'op-1',
  }));
});

test('相同 id 相同 payload 不重复入队，但去重 no-op 也是一次队列事务', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  q.enqueue([a], { expectedRevision: 0, operationId: 'op-1' });
  const snap = q.enqueue([deepCopy(a)], { expectedRevision: 1, operationId: 'op-2' });
  assert.equal(snap.revision, 2);
  assert.equal(snap.items.length, 1, '不重复入队');
  assert.equal(Object.keys(snap.operations).length, 2);
});

test('同批内重复候选 id 拒绝', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  expectCode('INVALID_INPUT', () => q.enqueue([a, deepCopy(a)], {
    expectedRevision: 0, operationId: 'op-1',
  }));
});

test('review：pending→reviewed/dismissed；非 pending 拒绝；未知 id NOT_FOUND', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  const b = makeCandidate({ kind: 'isolated', sources: sortedRefs('c'), evidence: {} });
  q.enqueue([a, b], { expectedRevision: 0, operationId: 'op-1' });

  let snap = q.review(a.id, { decision: 'reviewed', expectedRevision: 1, operationId: 'op-r1' });
  assert.equal(snap.revision, 2);
  assert.equal(snap.items.find((i) => i.candidate.id === a.id).status, 'reviewed');

  expectCode('INVALID_STATE', () => q.review(a.id, {
    decision: 'dismissed', expectedRevision: 2, operationId: 'op-r2',
  }));
  expectCode('NOT_FOUND', () => q.review('0'.repeat(64), {
    decision: 'reviewed', expectedRevision: 2, operationId: 'op-r3',
  }));
  expectCode('INVALID_INPUT', () => q.review(b.id, {
    decision: 'approved', expectedRevision: 2, operationId: 'op-r4',
  }));
  // 失败后队列原样
  assert.equal(q.snapshot().revision, 2);
  assert.equal(q.snapshot().items.find((i) => i.candidate.id === b.id).status, 'pending');
});

test('review 幂等重放：同 operationId 在状态已变后仍返回首次结果', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  q.enqueue([a], { expectedRevision: 0, operationId: 'op-1' });
  q.review(a.id, { decision: 'reviewed', expectedRevision: 1, operationId: 'op-r1' });
  const replay = q.review(a.id, { decision: 'reviewed', expectedRevision: 1, operationId: 'op-r1' });
  assert.equal(replay.revision, 2);
  assert.equal(replay.items[0].status, 'reviewed');
  assert.equal(q.snapshot().revision, 2);
});

test('reviewed 不是批准：状态机只有 pending/reviewed/dismissed，队列无任何执行语义', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  const snap = q.enqueue([a], { expectedRevision: 0, operationId: 'op-1' });
  q.review(a.id, { decision: 'reviewed', expectedRevision: 1, operationId: 'op-r1' });
  const s = q.snapshot();
  assert.ok(s.items.every((i) => ['pending', 'reviewed', 'dismissed'].includes(i.status)));
  // Plan 契约层面禁止 approval/operationId 字段（后续 buildDraft 测试覆盖）
  assert.ok(!('approval' in snap));
});

function deepCopy(v) { return JSON.parse(JSON.stringify(v)); }

// ===========================================================================
// 输入校验 / 候选篡改
// ===========================================================================

test('候选篡改：id 与 digest({kind,scopeId,sources,evidence}) 不一致拒绝', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  const tampered = { ...a, evidence: { sharedEntities: ['x'], extra: 'tampered' } };
  assert.notEqual(tampered.id, digest2({
    kind: tampered.kind, scopeId: tampered.scopeId, sources: tampered.sources, evidence: tampered.evidence,
  }));
  expectCode('INVALID_INPUT', () => q.enqueue([tampered], { expectedRevision: 0, operationId: 'op-1' }));
  // 改 id 本身同样拒绝
  const flipped = { ...a, id: (a.id.startsWith('0') ? '1' : '0') + a.id.slice(1) };
  expectCode('INVALID_INPUT', () => q.enqueue([flipped], { expectedRevision: 0, operationId: 'op-2' }));
});

test('跨 scope 候选拒绝；scope 缺失/未知键/非法 kind 拒绝', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const foreign = makeCandidate({ sources: sortedRefs('a', 'b'), scopeId: 'other-scope' });
  expectCode('INVALID_INPUT', () => q.enqueue([foreign], { expectedRevision: 0, operationId: 'op-1' }));

  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  expectCode('INVALID_INPUT', () => q.enqueue([{ ...a, kind: 'weird' }], {
    expectedRevision: 0, operationId: 'op-2',
  }));
  expectCode('INVALID_INPUT', () => q.enqueue([{ ...a, extra: 1 }], {
    expectedRevision: 0, operationId: 'op-3',
  }));
  const { id, ...noScope } = a;
  expectCode('INVALID_INPUT', () => q.enqueue([{ ...a, scopeId: undefined }], {
    expectedRevision: 0, operationId: 'op-4',
  }));
  void id; void noScope;
});
test('sources 规范化：未排序/重复/revision<1/未知键一律拒绝', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const mk = (sources) => makeCandidate({ sources });
  expectCode('INVALID_INPUT', () => q.enqueue([mk([ref('b'), ref('a')])], {
    expectedRevision: 0, operationId: 'op-1',
  }));
  expectCode('INVALID_INPUT', () => q.enqueue([mk([ref('a'), ref('a')])], {
    expectedRevision: 0, operationId: 'op-2',
  }));
  expectCode('INVALID_INPUT', () => q.enqueue([mk([{ id: 'a', revision: 0 }])], {
    expectedRevision: 0, operationId: 'op-3',
  }));
  expectCode('INVALID_INPUT', () => q.enqueue([mk([{ id: 'a', revision: 1, extra: 1 }])], {
    expectedRevision: 0, operationId: 'op-4',
  }));
  expectCode('INVALID_INPUT', () => q.enqueue([mk([])], {
    expectedRevision: 0, operationId: 'op-5',
  }));
});

test('证据含非协议 JSON 值（函数/undefined/NaN/稀疏数组/循环）拒绝', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const base = makeCandidate({ sources: sortedRefs('a', 'b') });
  const bad = (evidence) => {
    const c = { kind: 'link', scopeId: SCOPE, sources: sortedRefs('a', 'b'), evidence };
    return { ...c, id: '0'.repeat(64) }; // id 无法通过校验前先被协议 JSON 校验拦截
  };
  expectCode('INVALID_INPUT', () => q.enqueue([bad({ f: () => 1 })], {
    expectedRevision: 0, operationId: 'op-1',
  }));
  expectCode('INVALID_INPUT', () => q.enqueue([bad({ u: undefined })], {
    expectedRevision: 0, operationId: 'op-2',
  }));
  expectCode('INVALID_INPUT', () => q.enqueue([bad({ n: NaN })], {
    expectedRevision: 0, operationId: 'op-3',
  }));
  const sparse = ['a']; delete sparse[0];
  expectCode('INVALID_INPUT', () => q.enqueue([bad({ s: sparse })], {
    expectedRevision: 0, operationId: 'op-4',
  }));
  const cyc = {}; cyc.self = cyc;
  expectCode('INVALID_INPUT', () => q.enqueue([bad({ c: cyc })], {
    expectedRevision: 0, operationId: 'op-5',
  }));
  void base;
});

test('孤立代理码元字符串拒绝（非无损 UTF-8）', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const evil = { kind: 'link', scopeId: SCOPE, sources: sortedRefs('a', 'b'), evidence: { s: '\ud800' } };
  expectCode('INVALID_INPUT', () => q.enqueue([{ ...evil, id: '0'.repeat(64) }], {
    expectedRevision: 0, operationId: 'op-1',
  }));
});

test('enqueue 参数形状：非数组/空数组/opts 缺字段/非法 operationId 拒绝', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  expectCode('INVALID_INPUT', () => q.enqueue('nope', { expectedRevision: 0, operationId: 'op-1' }));
  expectCode('INVALID_INPUT', () => q.enqueue([], { expectedRevision: 0, operationId: 'op-2' }));
  expectCode('INVALID_INPUT', () => q.enqueue([a], { operationId: 'op-3' }));
  expectCode('INVALID_INPUT', () => q.enqueue([a], { expectedRevision: 0 }));
  expectCode('INVALID_INPUT', () => q.enqueue([a], { expectedRevision: 0, operationId: 'bad id!' }));
  expectCode('INVALID_INPUT', () => q.enqueue([a], { expectedRevision: -1, operationId: 'op-4' }));
  expectCode('INVALID_INPUT', () => q.enqueue([a], { expectedRevision: 0, operationId: 'op-5', extra: 1 }));
});

test('工厂参数校验：scopeId 必填、快照 scope 必须一致', () => {
  expectCode('INVALID_INPUT', () => createCandidateQueue({}));
  expectCode('INVALID_INPUT', () => createCandidateQueue({ scopeId: '' }));
  expectCode('INVALID_INPUT', () => createCandidateQueue({ scopeId: SCOPE, snapshot: { version: 1 } }));
  expectCode('INVALID_INPUT', () => createCandidateQueue({ scopeId: SCOPE, extra: 1 }));
});

// ===========================================================================
// 返回值 alias 污染
// ===========================================================================

test('returned alias 污染：改返回快照不影响队列；改入参数组不影响已存候选', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b'), evidence: { sharedEntities: ['x'] } });
  const input = [a];
  const snap1 = q.enqueue(input, { expectedRevision: 0, operationId: 'op-1' });

  // 污染返回值
  snap1.items[0].status = 'dismissed';
  snap1.items[0].candidate.evidence.sharedEntities[0] = 'polluted';
  snap1.revision = 999;
  delete snap1.operations['op-1'];

  const clean = q.snapshot();
  assert.equal(clean.revision, 1);
  assert.equal(clean.items[0].status, 'pending');
  assert.deepEqual(clean.items[0].candidate.evidence, { sharedEntities: ['x'] });
  assert.ok(clean.operations['op-1']);

  // 污染调用方持有的输入对象
  input[0].evidence.sharedEntities[0] = 'polluted-2';
  input.push(makeCandidate({ kind: 'isolated', sources: sortedRefs('z'), evidence: {} }));
  assert.deepEqual(q.snapshot().items[0].candidate.evidence, { sharedEntities: ['x'] });
  assert.equal(q.snapshot().items.length, 1);

  // 两次 snapshot 互不共享
  const s1 = q.snapshot();
  const s2 = q.snapshot();
  assert.notEqual(s1, s2);
  s1.items.length = 0;
  assert.equal(s2.items.length, 1);
});

// ===========================================================================
// 快照恢复：严格校验 + 确定性重放
// ===========================================================================

function buildHistoryQueue() {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b'), evidence: { sharedEntities: ['x'] } });
  const b = makeCandidate({ kind: 'cluster', sources: sortedRefs('c01', 'c02', 'c03', 'c04', 'c05', 'c06', 'c07', 'c08'), evidence: {} });
  q.enqueue([a, b], { expectedRevision: 0, operationId: 'op-1' });
  q.enqueue([deepCopy(a)], { expectedRevision: 1, operationId: 'op-2' }); // 去重 no-op 事务
  q.review(a.id, { decision: 'reviewed', expectedRevision: 2, operationId: 'op-3' });
  q.review(b.id, { decision: 'dismissed', expectedRevision: 3, operationId: 'op-4' });
  return { q, a, b };
}

test('快照往返：恢复后的快照与原快照 deep equal', () => {
  const { q } = buildHistoryQueue();
  const snap = q.snapshot();
  const q2 = createCandidateQueue({ scopeId: SCOPE, snapshot: deepCopy(snap) });
  assert.deepEqual(q2.snapshot(), snap);
});

test('恢复重放：恢复后旧 operationId 幂等仍生效（带过期 expectedRevision）', () => {
  const { q, a, b } = buildHistoryQueue();
  const snap = q.snapshot();
  const q2 = createCandidateQueue({ scopeId: SCOPE, snapshot: snap });
  // 必须重放与首次完全相同的语义请求（同 operationId 同 payload）
  const replay = q2.enqueue([deepCopy(a), deepCopy(b)], { expectedRevision: 0, operationId: 'op-1' });
  assert.equal(replay.revision, 1, '返回 op-1 首次业务结果');
  assert.equal(replay.items.length, 2);
  assert.equal(q2.snapshot().revision, 4, '当前队列 revision 不变');
  // 恢复后还能继续新事务
  const c = makeCandidate({ kind: 'isolated', sources: sortedRefs('c'), evidence: {} });
  const next = q2.enqueue([c], { expectedRevision: 4, operationId: 'op-5' });
  assert.equal(next.revision, 5);
});

test('恢复严格校验：篡改 items/revision/operations/版本/scope 均拒绝', () => {
  const { q } = buildHistoryQueue();
  const base = q.snapshot();

  const tamper = (mutate) => {
    const copy = deepCopy(base);
    mutate(copy);
    expectCode('INVALID_INPUT | INVALID_STATE', () => createCandidateQueue({ scopeId: SCOPE, snapshot: copy }));
  };

  // status 被手工翻转（无对应 operation 历史）
  tamper((s) => { s.items[1].status = 'pending'; });
  // 候选证据被篡改（digest 不匹配）
  tamper((s) => { s.items[0].candidate.evidence.sharedEntities[0] = 'hack'; });
  // 顶层 revision 与 operations 条数不一致
  tamper((s) => { s.revision = 10; });
  // 删除一条 operation（历史缺失）
  tamper((s) => { delete s.operations['op-3']; });
  // 重复 result.revision
  tamper((s) => { s.operations['op-4'].result.revision = 3; });
  // 指纹被篡改
  tamper((s) => { s.operations['op-1'].fingerprint = 'f'.repeat(64); });
  // operation 记录缺 result
  tamper((s) => { delete s.operations['op-1'].result; });
  // result 缺 items
  tamper((s) => { delete s.operations['op-1'].result.items; });
  // 多出的 item 没有入队历史
  tamper((s) => {
    s.items.push({ candidate: makeCandidate({ kind: 'isolated', sources: sortedRefs('q9'), evidence: {} }), status: 'pending' });
  });
  // 版本号与 scope
  tamper((s) => { s.version = 2; });
  expectCode('INVALID_INPUT', () => createCandidateQueue({ scopeId: 'other', snapshot: deepCopy(base) }));
  expectCode('INVALID_INPUT', () => createCandidateQueue({ scopeId: SCOPE, snapshot: { ...deepCopy(base), scopeId: 'other' } }));
});

test('恢复校验不能只信任 revision：revision 正确但 items 与历史不符仍拒绝', () => {
  const { q } = buildHistoryQueue();
  const copy = deepCopy(q.snapshot());
  // revision 与条数不变，但把 items[0] 换成另一条合法候选（无入队历史）
  copy.items[0] = {
    candidate: makeCandidate({ kind: 'isolated', sources: sortedRefs('c'), evidence: {} }),
    status: 'reviewed',
  };
  expectCode('INVALID_STATE', () => createCandidateQueue({ scopeId: SCOPE, snapshot: copy }));
});

test('恢复校验 request 载荷：review 的非法 decision 在恢复时也会被拒', () => {
  const { q } = buildHistoryQueue();
  const copy = deepCopy(q.snapshot());
  copy.operations['op-3'].request.decision = 'approved';
  copy.operations['op-3'].fingerprint = digest2(copy.operations['op-3'].request);
  copy.operations['op-3'].result = deepCopy(copy.operations['op-3'].result);
  expectCode('INVALID_INPUT', () => createCandidateQueue({ scopeId: SCOPE, snapshot: copy }));
});

// ===========================================================================
// buildDraft · link
// ===========================================================================

function linkDraftScene() {
  const candidate = makeCandidate({
    kind: 'link',
    sources: sortedRefs('a', 'b'),
    evidence: { sharedEntities: ['cat'] },
  });
  const records = [
    makeCard('a', { links: [{ target: 'b', rel: 'related' }] }),
    makeCard('b'),
    makeCard('c'),
  ];
  return { candidate, records };
}

test('link 草案：plan 形状精确、sources 绑定全部相关卡 revision、before 保留、after 并集排序', () => {
  const { candidate, records } = linkDraftScene();
  const draft = buildDraft({
    candidate,
    records,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'c', rel: 'related' }] }] },
  });
  const { plan, digest, diff, changedItems } = draft;

  assert.deepEqual(Object.keys(plan).sort(), ['candidateId', 'kind', 'links', 'scopeId', 'sources', 'version']);
  assert.equal(plan.version, 1);
  assert.equal(plan.scopeId, SCOPE);
  assert.equal(plan.candidateId, candidate.id);
  assert.equal(plan.kind, 'link');
  // sources = 候选源 ∪ 被改源 ∪ 目标，按 id 排序
  assert.deepEqual(plan.sources, [ref('a'), ref('b'), ref('c')]);
  const entry = plan.links[0];
  assert.equal(entry.id, 'a');
  assert.equal(entry.expectedRevision, 1);
  assert.deepEqual(entry.before, [{ target: 'b', rel: 'related' }]);
  assert.deepEqual(entry.after, [
    { target: 'b', rel: 'related' },
    { target: 'c', rel: 'related' },
  ], '保留 before 边并按 target 再 rel 排序');
  assert.equal(changedItems, 1);
  assert.deepEqual(diff, [{
    path: 'spark:a',
    oldText: stable2([{ target: 'b', rel: 'related' }]),
    newText: stable2([{ target: 'b', rel: 'related' }, { target: 'c', rel: 'related' }]),
  }]);
  assert.equal(digest, digestPlan(plan));
  assert.match(digest, /^[0-9a-f]{64}$/);
  // plan 不含 digest/approval/operationId
  const forbidden = ['digest', 'approval', 'operationId', 'approved', 'executed'];
  assert.ok(!Object.keys(plan).some((k) => forbidden.includes(k)));
});

test('link 草案：多被改源、changedItems=条数、links 按 id 排序', () => {
  const { candidate, records } = linkDraftScene();
  const draft = buildDraft({
    candidate,
    records,
    proposal: {
      kind: 'link',
      links: [
        { id: 'b', after: [{ target: 'a', rel: 'mirrors' }] },
        { id: 'a', after: [{ target: 'b', rel: 'extra' }] },
      ],
    },
  });
  assert.equal(draft.changedItems, 2);
  assert.deepEqual(draft.plan.links.map((l) => l.id), ['a', 'b'], 'Plan.links 按 id 升序');
  const bEntry = draft.plan.links[1];
  assert.deepEqual(bEntry.after, [
    { target: 'a', rel: 'mirrors' },
  ]);
});

test('link 20/21 上限：20 条被改源 ok，21 条拒绝', () => {
  const ids = Array.from({ length: 22 }, (_, i) => `s${String(i + 1).padStart(2, '0')}`); // s01..s22
  const candidate = makeCandidate({ kind: 'link', sources: sortedRefs(...ids), evidence: {} });
  const records = ids.map((id) => makeCard(id));
  const last = ids[21]; // 所有新边指向 s22，避免自环
  const mk = (n) => ({
    kind: 'link',
    links: Array.from({ length: n }, (_, i) => ({
      id: ids[i], after: [{ target: last, rel: 'related' }],
    })),
  });
  const ok = buildDraft({ candidate, records, proposal: mk(20) });
  assert.equal(ok.changedItems, 20);
  expectCode('INVALID_INPUT', () => buildDraft({ candidate, records, proposal: mk(21) }));
});

test('link 反例：自环/重复(target,rel)/重复被改源/非候选源/未知目标/无变化', () => {
  const { candidate, records } = linkDraftScene();
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'a', rel: 'self' }] }] },
  }));
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'c', rel: 'r' }, { target: 'c', rel: 'r' }] }] },
  }));
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records,
    proposal: {
      kind: 'link',
      links: [
        { id: 'a', after: [{ target: 'c', rel: 'r1' }] },
        { id: 'a', after: [{ target: 'c', rel: 'r2' }] },
      ],
    },
  }));
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records,
    proposal: { kind: 'link', links: [{ id: 'c', after: [{ target: 'a', rel: 'r' }] }] },
  }));
  expectCode('NOT_FOUND', () => buildDraft({
    candidate, records,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'zzz', rel: 'r' }] }] },
  }));
  // 无变化：建议的边已存在
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'b', rel: 'related' }] }] },
  }));
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records,
    proposal: { kind: 'link', links: [] },
  }));
});

test('link 陈旧源与缺失源：REVISION_CONFLICT / NOT_FOUND', () => {
  const candidate = makeCandidate({ kind: 'link', sources: [ref('a', 1), ref('b', 2)], evidence: {} });
  const records = [makeCard('a', { revision: 2 }), makeCard('b', { revision: 2 })];
  expectCode('REVISION_CONFLICT', () => buildDraft({
    candidate, records,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'b', rel: 'r' }] }] },
  }));
  const candidate2 = makeCandidate({ kind: 'link', sources: [ref('a'), ref('ghost')], evidence: {} });
  expectCode('NOT_FOUND', () => buildDraft({
    candidate: candidate2, records: [makeCard('a')],
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'ghost', rel: 'r' }] }] },
  }));
});

test('link 记录校验：跨 scope / 非 active / 重复 id / links 超存储上限', () => {
  const { candidate } = linkDraftScene();
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records: [makeCard('a'), makeCard('b', { scopeId: 'other' })],
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'b', rel: 'r' }] }] },
  }));
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records: [makeCard('a'), makeCard('b', { state: 'archived' }), makeCard('c')],
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'b', rel: 'r' }] }] },
  }));
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records: [makeCard('a'), makeCard('a')],
    proposal: { kind: 'link', links: [] },
  }));
  // a 已有 32 条边，再加 1 条将超过存储 linksMax=32
  const many = Array.from({ length: 32 }, (_, i) => ({ target: `m${String(i).padStart(2, '0')}`, rel: 'r' }));
  const manyIds = many.map((l) => l.target);
  const candidate3 = makeCandidate({ kind: 'link', sources: sortedRefs('a', 'b'), evidence: {} });
  const records3 = [makeCard('a', { links: many }), makeCard('b'), ...manyIds.map((id) => makeCard(id))];
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate: candidate3, records: records3,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'b', rel: 'new' }] }] },
  }));
});

test('link 用 targetId 字符串数组的旧形状不是合法输入（沿用 P2 {target,rel} 形状）', () => {
  const { candidate, records } = linkDraftScene();
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records,
    proposal: { kind: 'link', links: [{ id: 'a', after: ['c'] }] },
  }));
});

// ===========================================================================
// buildDraft · merge-topic
// ===========================================================================

function clusterScene(count = 8) {
  const ids = Array.from({ length: count }, (_, i) => `c${String(i + 1).padStart(2, '0')}`);
  const candidate = makeCandidate({
    kind: 'cluster',
    sources: sortedRefs(...ids),
    evidence: { sharedTriggers: ['dream'] },
  });
  const records = ids.map((id, i) => makeCard(id, {
    triggers: [`t${i}-z`, `t${i}-a`], // 故意非排序，验证保全块保留原顺序
    links: i === 0 ? [{ target: ids[1], rel: 'peer' }] : [],
  }));
  records.push(makeCard('outsider')); // records 全集中存在但不在候选源内
  return { ids, candidate, records };
}

const topicProposal = (before, after) => ({
  kind: 'merge-topic',
  topic: {
    key: 'dream-journal',
    expectedRevision: 'shiori-r1.dGVzdA.deadbeef',
    before,
    after,
    title: '梦境日志',
    summary: '合并梦境碎片',
    updated: '2026-10-25T00:00:00.000Z',
  },
});

function expectedBlock(candidate, recordsById) {
  const projected = candidate.sources.map((r) => {
    const rec = recordsById.get(r.id);
    return {
      id: rec.id, scopeId: rec.scopeId, revision: rec.revision,
      title: rec.title, summary: rec.summary, content: rec.content,
      triggers: [...rec.triggers], entities: [...rec.entities],
      links: rec.links.map((l) => ({ target: l.target, rel: l.rel })),
      vitality: rec.vitality,
    };
  });
  return '\n<!-- shiori-p3-sources -->\n' + stable2(projected) + '\n<!-- /shiori-p3-sources -->\n';
}

test('merge-topic 全文保全：自动追加源块、含全部源完整字段、原数组顺序保留', () => {
  const { candidate, records } = clusterScene(8);
  const recordsById = new Map(records.map((r) => [r.id, r]));
  const before = 'DREAM TOPIC BODY\n';
  const after = 'DREAM TOPIC BODY\nsecond paragraph\n';
  const draft = buildDraft({ candidate, records, proposal: topicProposal(before, after) });

  const block = expectedBlock(candidate, recordsById);
  const finalAfter = after + block;
  assert.equal(draft.plan.topic.after, finalAfter);
  assert.ok(finalAfter.startsWith(before), 'append only');
  assert.ok(finalAfter.includes('<!-- shiori-p3-sources -->'));
  // 保全块包含每个源的完整十字段投影（spot check）
  const c01 = recordsById.get('c01');
  assert.ok(finalAfter.includes(stable2([{
    id: 'c01', scopeId: SCOPE, revision: 1, title: c01.title, summary: c01.summary,
    content: c01.content, triggers: c01.triggers, entities: c01.entities,
    links: [{ target: 'c02', rel: 'peer' }], vitality: 'evergreen',
  }]).slice(1, -1)));
  // 只含本次 sources，不含 records 全集里的 outsider
  assert.ok(!finalAfter.includes('outsider'));
  assert.equal(draft.plan.topic.before, before);
  assert.equal(draft.plan.topic.key, 'dream-journal');
  assert.equal(draft.plan.topic.expectedRevision, 'shiori-r1.dGVzdA.deadbeef');
  assert.deepEqual(draft.plan.sources, candidate.sources, 'sources 精确等于候选源');
  assert.equal(draft.changedItems, 9);
  assert.deepEqual(Object.keys(draft.plan).sort(), ['candidateId', 'kind', 'scopeId', 'sources', 'topic', 'version']);
  // diff：topic 正文对比 + 每张源 active→merged 草案
  assert.equal(draft.diff.length, 9);
  assert.equal(draft.diff[0].path, 'topic:dream-journal');
  assert.equal(draft.diff[0].oldText, before);
  assert.equal(draft.diff[0].newText, finalAfter);
  const spark = draft.diff[1];
  assert.equal(spark.path, 'spark:c01');
  assert.ok(spark.oldText.includes('"state":"active"'));
  assert.ok(spark.newText.includes('"state":"merged"'));
  assert.ok(spark.newText.includes('"revision":2'), 'merged 草案 revision+1');
  assert.equal(draft.digest, digestPlan(draft.plan));
});

test('merge-topic 幂等源块：after 已含完全相同块时不重复追加', () => {
  const { candidate, records } = clusterScene(8);
  const recordsById = new Map(records.map((r) => [r.id, r]));
  const before = 'B\n';
  const first = buildDraft({ candidate, records, proposal: topicProposal(before, before + 'x\n') });
  const afterWithBlock = first.plan.topic.after;
  const second = buildDraft({ candidate, records, proposal: topicProposal(before, afterWithBlock) });
  assert.equal(second.plan.topic.after, afterWithBlock, '不重复追加');
  assert.equal(second.plan.topic.after.match(/<!-- shiori-p3-sources -->/g).length, 1);
  assert.equal(second.digest, first.digest, '相同最终正文绑定相同 digest');
});

test('merge-topic 冲突源块：已存在不同内容的源块标记时拒绝', () => {
  const { candidate, records } = clusterScene(8);
  const conflicting = 'PRE\n\n<!-- shiori-p3-sources -->\n[{"id":"other"}]\n<!-- /shiori-p3-sources -->\n';
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records, proposal: topicProposal('PRE\n', conflicting),
  }));
});

test('merge-topic 8..19 边界：7 拒绝、8 ok、19 ok（changedItems=20）、20 拒绝', () => {
  const mk = (n) => {
    const { candidate, records } = clusterScene(n);
    return () => buildDraft({
      candidate, records, proposal: topicProposal('B\n', 'B\nmore\n'),
    });
  };
  expectCode('INVALID_INPUT', mk(7));
  assert.equal(mk(8)().changedItems, 9);
  assert.equal(mk(19)().changedItems, 20);
  expectCode('INVALID_INPUT', mk(20));
});

test('merge-topic 只接受 cluster 候选', () => {
  const { records } = clusterScene(8);
  const linkCandidate = makeCandidate({
    kind: 'link',
    sources: sortedRefs('c01', 'c02'),
    evidence: { sharedEntities: ['x'] },
  });
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate: linkCandidate, records, proposal: topicProposal('B\n', 'B\nx\n'),
  }));
});

test('merge-topic append-only：after 必须保留 before 全文', () => {
  const { candidate, records } = clusterScene(8);
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records, proposal: topicProposal('KEEP THIS\n', 'REPLACED\n'),
  }));
});

test('merge-topic 元数据冻结校验：key/summary/expectedRevision/title/updated', () => {
  const { candidate, records } = clusterScene(8);
  const base = topicProposal('B\n', 'B\nx\n');
  const bad = (mutate) => {
    const p = deepCopy(base);
    mutate(p.topic);
    return buildDraft({ candidate, records, proposal: p });
  };
  expectCode('INVALID_INPUT', () => bad((t) => { t.key = 'a/b'; }));
  expectCode('INVALID_INPUT', () => bad((t) => { t.key = 'core'; }));
  expectCode('INVALID_INPUT', () => bad((t) => { t.summary = 'x'.repeat(61); }));
  expectCode('INVALID_INPUT', () => bad((t) => { t.summary = 'a\nb'; }));
  expectCode('INVALID_INPUT', () => bad((t) => { t.expectedRevision = 123; }));
  expectCode('INVALID_INPUT', () => bad((t) => { t.title = ''; }));
  expectCode('INVALID_INPUT', () => bad((t) => { t.updated = ''; }));
  expectCode('INVALID_INPUT', () => bad((t) => { t.extra = 1; }));
});

test('merge-topic 陈旧源与缺失源：REVISION_CONFLICT / NOT_FOUND', () => {
  const { candidate, records } = clusterScene(8);
  const staleRecords = records.map((r) => (r.id === 'c03' ? { ...r, revision: 2 } : r));
  expectCode('REVISION_CONFLICT', () => buildDraft({
    candidate, records: staleRecords, proposal: topicProposal('B\n', 'B\nx\n'),
  }));
  const missing = records.filter((r) => r.id !== 'c04');
  expectCode('NOT_FOUND', () => buildDraft({
    candidate, records: missing, proposal: topicProposal('B\n', 'B\nx\n'),
  }));
});

// ===========================================================================
// buildDraft · thin-core（仅草案）
// ===========================================================================

test('thin-core 仅草案：plan.core、changedItems=0、diff 展示、无执行字段', () => {
  const candidate = makeCandidate({ kind: 'isolated', sources: sortedRefs('a'), evidence: {} });
  const records = [makeCard('a')];
  const draft = buildDraft({
    candidate, records,
    proposal: { kind: 'thin-core', before: 'L1 原文', after: 'L1 精简后' },
  });
  assert.deepEqual(Object.keys(draft.plan).sort(), ['candidateId', 'core', 'kind', 'scopeId', 'sources', 'version']);
  assert.deepEqual(draft.plan.core, { before: 'L1 原文', after: 'L1 精简后' });
  assert.equal(draft.changedItems, 0);
  assert.deepEqual(draft.diff, [{ path: 'core', oldText: 'L1 原文', newText: 'L1 精简后' }]);
  assert.equal(draft.digest, digestPlan(draft.plan));
  assert.ok(!Object.keys(draft.plan).includes('approval'));
  // K 不读写真实 L1：不触发任何文件/执行动作由源码静态保证（模块零 fs import）
});

test('thin-core 输入校验：非字符串正文拒绝；候选源仍需 records 覆盖', () => {
  const candidate = makeCandidate({ kind: 'isolated', sources: sortedRefs('a'), evidence: {} });
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records: [makeCard('a')],
    proposal: { kind: 'thin-core', before: 1, after: 'x' },
  }));
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records: [makeCard('a')],
    proposal: { kind: 'thin-core', before: 'a', after: 'b', extra: 1 },
  }));
  expectCode('NOT_FOUND', () => buildDraft({
    candidate, records: [],
    proposal: { kind: 'thin-core', before: 'a', after: 'b' },
  }));
});

// ===========================================================================
// buildDraft 通用校验 / digestPlan / 确定性
// ===========================================================================

test('buildDraft 参数校验：未知键/缺键/非对象/proposal 非法 kind 拒绝', () => {
  const { candidate, records } = linkDraftScene();
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records, proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'c', rel: 'r' }] }] }, extra: 1,
  }));
  expectCode('INVALID_INPUT', () => buildDraft({ candidate, proposal: { kind: 'link', links: [] } }));
  expectCode('INVALID_INPUT', () => buildDraft('nope'));
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate, records, proposal: { kind: 'explode', links: [] },
  }));
  // 候选被篡改
  const tampered = { ...candidate, evidence: { sharedEntities: ['cat', 'INJECTED'] } };
  expectCode('INVALID_INPUT', () => buildDraft({
    candidate: tampered, records,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'c', rel: 'r' }] }] },
  }));
});

test('digestPlan：与 buildDraft 结果一致；拒绝非协议/未知字段/坏版本', () => {
  const { candidate, records } = linkDraftScene();
  const draft = buildDraft({
    candidate, records,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'c', rel: 'related' }] }] },
  });
  assert.equal(digestPlan(deepCopy(draft.plan)), draft.digest);
  expectCode('INVALID_INPUT', () => digestPlan({ ...draft.plan, version: 2 }));
  expectCode('INVALID_INPUT', () => digestPlan({ ...draft.plan, extra: 1 }));
  expectCode('INVALID_INPUT', () => digestPlan({ ...draft.plan, links: undefined }));
  expectCode('INVALID_INPUT', () => digestPlan(null));
  // 键序无关：属性插入顺序不同 digest 相同
  const reordered = {};
  for (const k of ['links', 'sources', 'kind', 'candidateId', 'scopeId', 'version']) {
    reordered[k] = deepCopy(draft.plan[k]);
  }
  assert.equal(digestPlan(reordered), draft.digest);
});

test('确定性：相同输入两次构建 digest/plan 完全一致；evidence 键序不影响候选 id', () => {
  const { candidate, records } = linkDraftScene();
  const proposal = { kind: 'link', links: [{ id: 'a', after: [{ target: 'c', rel: 'related' }] }] };
  const d1 = buildDraft({ candidate, records, proposal: deepCopy(proposal) });
  const d2 = buildDraft({ candidate, records, proposal: deepCopy(proposal) });
  assert.equal(d1.digest, d2.digest);
  assert.deepEqual(d1.plan, d2.plan);
  assert.deepEqual(d1.diff, d2.diff);

  const c1 = makeCandidate({ sources: sortedRefs('a', 'b'), evidence: { a: 1, b: 2 } });
  const c2 = makeCandidate({ sources: sortedRefs('a', 'b'), evidence: { b: 2, a: 1 } });
  assert.equal(c1.id, c2.id, 'stable 对普通对象键排序，键序无关');
  const q = createCandidateQueue({ scopeId: SCOPE });
  q.enqueue([c1], { expectedRevision: 0, operationId: 'op-1' });
  const snap = q.enqueue([c2], { expectedRevision: 1, operationId: 'op-2' });
  assert.equal(snap.items.length, 1, '同 id 同 payload 去重');
});

test('UTF-16 稳定排序：ids 按码元序而非 locale 序', () => {
  // 'Z' (0x5A) < 'a' (0x61)：二进制序中大写在前
  const q = createCandidateQueue({ scopeId: SCOPE });
  const cZ = makeCandidate({ kind: 'isolated', sources: [ref('Z')], evidence: {} });
  const ca = makeCandidate({ kind: 'isolated', sources: [ref('a')], evidence: {} });
  q.enqueue([ca, cZ], { expectedRevision: 0, operationId: 'op-1' });
  // 候选源要求升序；Z < a 的组合必须按 Z 在前
  const cBoth = makeCandidate({ kind: 'link', sources: [ref('Z'), ref('a')], evidence: {} });
  const snap = q.enqueue([cBoth], { expectedRevision: 1, operationId: 'op-2' });
  assert.deepEqual(snap.items[2].candidate.sources.map((s) => s.id), ['Z', 'a']);
});

// ===========================================================================
// a2 返工修复回归（主审 a1 反馈 K-1/K-2/K-3）
// ===========================================================================

// --- K-1：operationId 安全字典 ------------------------------------------------

test('K-1 继承属性名是合法 operationId：constructor/toString 等首次使用正常成功', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const names = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'toLocaleString'];
  let revision = 0;
  for (const name of names) {
    const c = makeCandidate({ kind: 'isolated', sources: [ref(`s-${name.length}`)], evidence: {} });
    const snap = q.enqueue([c], { expectedRevision: revision, operationId: name });
    revision += 1;
    assert.equal(snap.revision, revision, `${name} 应作为全新 operationId 正常执行`);
    assert.ok(Object.hasOwn(snap.operations, name));
  }
  // review 路径同样不受继承名影响
  const first = makeCandidate({ kind: 'isolated', sources: [ref('s-11')], evidence: {} });
  q.enqueue([first], { expectedRevision: revision, operationId: 'op-extra' });
  const snap = q.review(first.id, {
    decision: 'reviewed', expectedRevision: revision + 1, operationId: 'propertyIsEnumerable',
  });
  assert.equal(snap.revision, revision + 2);
  assert.equal(Object.keys(snap.operations).length, names.length + 2);
});

test('K-1 继承名 operationId 幂等：同请求重放先于 CAS 返回首次业务结果', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  q.enqueue([a], { expectedRevision: 0, operationId: 'constructor' });
  const b = makeCandidate({ kind: 'isolated', sources: [ref('c')], evidence: {} });
  q.enqueue([b], { expectedRevision: 1, operationId: 'op-2' });
  // 当前 revision=2；用过期的 expectedRevision=0 重放 constructor 仍返回首次结果
  const replay = q.enqueue([deepCopy(a)], { expectedRevision: 0, operationId: 'constructor' });
  assert.equal(replay.revision, 1);
  assert.equal(replay.items.length, 1);
  assert.ok(Object.hasOwn(replay.operations, 'op-2'), '附带当前 operations 克隆');
  assert.equal(q.snapshot().revision, 2, '重放不改变队列 revision');
});

test('K-1 继承名 operationId 同 id 异 payload 拒绝', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  const b = makeCandidate({ kind: 'isolated', sources: [ref('c')], evidence: {} });
  q.enqueue([a], { expectedRevision: 0, operationId: 'toString' });
  expectCode('INVALID_INPUT', () => q.enqueue([b], { expectedRevision: 1, operationId: 'toString' }));
  expectCode('INVALID_INPUT', () => q.review(a.id, {
    decision: 'reviewed', expectedRevision: 1, operationId: 'toString',
  }));
  assert.equal(q.snapshot().revision, 1);
});

test('K-1 __proto__ 不是合法 operationId：拒绝且队列不受污染', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  expectCode('INVALID_INPUT', () => q.enqueue([a], { expectedRevision: 0, operationId: '__proto__' }));
  expectCode('INVALID_INPUT', () => q.review(a.id, {
    decision: 'reviewed', expectedRevision: 0, operationId: '__proto__.x',
  }));
  // 拒绝后队列照常工作，operations 无多余键
  const snap = q.enqueue([deepCopy(a)], { expectedRevision: 0, operationId: 'op-1' });
  assert.equal(snap.revision, 1);
  assert.deepEqual(Object.keys(snap.operations), ['op-1']);
  assert.equal(Object.getPrototypeOf(snap.operations), null, '对外快照 operations 也是安全字典');
});

test('K-1 JSON 快照往返恢复后安全字典语义一致：继承名可继续用作 operationId', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  q.enqueue([a], { expectedRevision: 0, operationId: 'op-enq-1' });
  const wire = JSON.parse(JSON.stringify(q.snapshot()));
  const q2 = createCandidateQueue({ scopeId: SCOPE, snapshot: wire });
  assert.equal(Object.getPrototypeOf(q2.snapshot().operations), null);
  // 恢复后继承名作为全新 operationId 正常执行；旧 id 幂等与异 payload 拒绝均保持
  const b = makeCandidate({ kind: 'isolated', sources: [ref('c')], evidence: {} });
  const snap = q2.enqueue([b], { expectedRevision: 1, operationId: 'constructor' });
  assert.equal(snap.revision, 2);
  assert.ok(Object.hasOwn(snap.operations, 'constructor'));
  const replay = q2.enqueue([deepCopy(a)], { expectedRevision: 0, operationId: 'op-enq-1' });
  assert.equal(replay.revision, 1, '恢复后旧 operationId 幂等仍先于 CAS');
  expectCode('INVALID_INPUT', () => q2.enqueue([makeCandidate({ kind: 'isolated', sources: [ref('z')], evidence: {} })], {
    expectedRevision: 2, operationId: 'constructor',
  }));
});

test('K-1 手工快照 operations 携带 __proto__ 键：恢复拒绝且不污染', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  q.enqueue([a], { expectedRevision: 0, operationId: 'op-enq-1' });
  // 通过 JSON 文本替换制造 own-property 形态的 __proto__ 键（JSON.parse 用
  // DefineOwnProperty 语义，不触发 setter，等价于恶意/损坏快照的真实形态）
  const hostile = JSON.parse(JSON.stringify(q.snapshot()).replace('"op-enq-1":', '"__proto__":'));
  assert.ok(Object.hasOwn(hostile.operations, '__proto__'), '前置：替换确实造出 own __proto__ 键');
  expectCode('INVALID_INPUT', () => createCandidateQueue({ scopeId: SCOPE, snapshot: hostile }));
  // 恢复被拒后新建队列不受影响（无原型污染残留）
  const fresh = createCandidateQueue({ scopeId: SCOPE });
  const snap = fresh.enqueue([deepCopy(a)], { expectedRevision: 0, operationId: 'op-1' });
  assert.equal(snap.revision, 1);
});

// --- K-2：协议 JSON 对象键无损 UTF-8 ------------------------------------------

test('K-2 对象键孤立代理码元拒绝：evidence 键 \\ud800 即使候选 id 自洽也拒绝', () => {
  const evidence = { '\ud800': 1 };
  const candidate = makeCandidate({ kind: 'isolated', sources: [ref('a')], evidence });
  assert.match(candidate.id, /^[0-9a-f]{64}$/, '前置：id 按同键内容计算且自洽');
  let caught;
  try { createCandidateQueue({ scopeId: SCOPE }).enqueue([candidate], { expectedRevision: 0, operationId: 'op-1' }); }
  catch (e) { caught = e; }
  assert.ok(caught instanceof Error, 'enqueue 必须拒绝');
  assert.equal(caught.code, 'INVALID_INPUT');
  assert.ok(caught.message.includes('对象键'), `消息应指出是键的问题：${caught.message}`);
  // buildDraft 入口同样拒绝
  assert.throws(() => buildDraft({
    candidate, records: [makeCard('a')], proposal: { kind: 'thin-core', before: 'x', after: 'xy' },
  }), (err) => err.code === 'INVALID_INPUT' && err.message.includes('对象键'));
});

test('K-2 records 额外键孤立代理码元拒绝', () => {
  const candidate = makeCandidate({ sources: sortedRefs('a', 'b') });
  const bad = makeCard('a');
  bad['\ud800'] = 'x';
  assert.throws(() => buildDraft({
    candidate, records: [bad, makeCard('b')],
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'b', rel: 'relates' }] }] },
  }), (err) => err.code === 'INVALID_INPUT' && err.message.includes('对象键'));
});

test('K-2 快照含孤立代理键：恢复在结构校验阶段拒绝', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ sources: sortedRefs('a', 'b') });
  q.enqueue([a], { expectedRevision: 0, operationId: 'op-enq-1' });
  const hostile = deepCopy(q.snapshot());
  hostile.operations['op-enq-1'].request.candidates[0].evidence['\ud800'] = 1;
  assert.throws(() => createCandidateQueue({ scopeId: SCOPE, snapshot: hostile }),
    (err) => err.code === 'INVALID_INPUT' && err.message.includes('对象键'));
});

test('K-2 合法非 ASCII 键与配对代理键照常接受并可通过快照恢复', () => {
  const evidence = { '标题': 1, 'café': 2, '𝒜': 3, '😀': 4 };
  assert.ok('😀'.isWellFormed(), '前置：配对代理键是良构文本');
  const candidate = makeCandidate({ kind: 'isolated', sources: [ref('a')], evidence });
  const q = createCandidateQueue({ scopeId: SCOPE });
  q.enqueue([candidate], { expectedRevision: 0, operationId: 'op-1' });
  const restored = createCandidateQueue({ scopeId: SCOPE, snapshot: JSON.parse(JSON.stringify(q.snapshot())) });
  const snap = restored.snapshot();
  assert.equal(snap.revision, 1);
  assert.deepEqual(snap.items[0].candidate.evidence, evidence);
});

test('K-2 digestPlan 入口：plan 含孤立代理键拒绝', () => {
  const candidate = makeCandidate({ sources: sortedRefs('a', 'b') });
  const draft = buildDraft({
    candidate, records: [makeCard('a'), makeCard('b')],
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'b', rel: 'relates' }] }] },
  });
  const bad = deepCopy(draft.plan);
  bad['\ud800'] = 1;
  assert.throws(() => digestPlan(bad),
    (err) => err.code === 'INVALID_INPUT' && err.message.includes('对象键'));
});

// --- K-3：link 既有边目标必须存在于 records -----------------------------------

function danglingScene(recordsExtra) {
  const candidate = makeCandidate({ sources: [ref('a')] });
  const a = makeCard('a', { links: [{ target: 'retired-x', rel: 'mentions' }] });
  const b = makeCard('b');
  return {
    candidate,
    records: [a, b, ...recordsExtra],
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'b', rel: 'relates' }] }] },
  };
}

test('K-3 仅新增 after（旧边隐式保留）时既有边目标缺失：NOT_FOUND 而非原生 TypeError', () => {
  const input = danglingScene([]);
  const inputBefore = deepCopy(input);
  let caught;
  try { buildDraft(input); } catch (e) { caught = e; }
  assert.ok(caught instanceof Error, '必须抛契约错误而非成功');
  assert.equal(caught.code, 'NOT_FOUND', `应有错误码，得到 ${caught.code}`);
  assert.equal(caught.details.target, 'retired-x');
  assert.equal(caught.details.sourceId, 'a');
  assert.ok(caught.message.includes('retired-x'), '消息应指明缺失目标');
  assert.deepEqual(input, inputBefore, '失败后输入保持不变');
});

test('K-3 显式携带旧边进 after：目标缺失同样 NOT_FOUND（两路径行为一致）', () => {
  const input = danglingScene([]);
  input.proposal.links[0].after = [
    { target: 'retired-x', rel: 'mentions' },
    { target: 'b', rel: 'relates' },
  ];
  assert.throws(() => buildDraft(input), (err) => err.code === 'NOT_FOUND'
    && err.details.target === 'retired-x');
});

test('K-3 对照：既有边目标在 records 中则成功，旧边保留并进入 sources 绑定 revision', () => {
  const input = danglingScene([makeCard('retired-x', { revision: 3 })]);
  const draft = buildDraft(input);
  assert.deepEqual(draft.plan.sources, [
    { id: 'a', revision: 1 }, { id: 'b', revision: 1 }, { id: 'retired-x', revision: 3 },
  ]);
  const entry = draft.plan.links[0];
  assert.deepEqual(entry.before, [{ target: 'retired-x', rel: 'mentions' }], '不丢弃旧边');
  const afterSorted = [
    { target: 'b', rel: 'relates' }, { target: 'retired-x', rel: 'mentions' },
  ];
  assert.deepEqual(entry.after, afterSorted, 'after 为并集按 target 排序');
  assert.equal(draft.changedItems, 1);
});
