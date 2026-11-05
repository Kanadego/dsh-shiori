// Shiori · K 槽位补充测试（node:test，零新增依赖）
//
// 覆盖子任务新增能力（只新增用例，不改既有断言）：
// - listQueue 展示投影：candidate.sources 补 title（取不到给 null、不删原字段）、
//   顶层 groups / statusCounts / total；
// - listQueue 可选分页 limit / offset：缺省行为与不分页完全一致、total 不受分页影响；
// - buildLinkDraft 的 INVALID_INPUT（被改源不在 candidate.sources）补
//   details: { field, reason, hint }，错误码与 message 前缀不变。
//
// 本文件与 queue.test.mjs 同一套独立 canonical/digest 实现（交叉验证 digest 契约）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createCandidateQueue, buildDraft, listQueue } from '../../src/organize/queue.mjs';

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

function makeCard(id, over = {}) {
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

/** 构造一组混合 kind/status 的队列 items（不依赖队列事务，直接手搭形状）。 */
function makeItems() {
  return [
    { candidate: makeCandidate({ kind: 'link', sources: sortedRefs('a', 'b') }), status: 'pending' },
    { candidate: makeCandidate({ kind: 'isolated', sources: sortedRefs('c'), evidence: {} }), status: 'reviewed' },
    { candidate: makeCandidate({ kind: 'cluster', sources: sortedRefs('d', 'e', 'f'), evidence: { topic: 't' } }), status: 'dismissed' },
    { candidate: makeCandidate({ kind: 'link', sources: sortedRefs('g', 'h') }), status: 'pending' },
  ];
}

const RECORDS = [
  makeCard('a'), makeCard('b'), makeCard('c'),
  // d/e/f 故意不给记录（源卡已退休等场景）：title 应为 null 而不是报错
  makeCard('g'), makeCard('h'),
];

// ===========================================================================
// listQueue：投影 / title / groups / statusCounts / total
// ===========================================================================

test('listQueue：sources 补 title（既有字段保留）、顶层 groups/statusCounts/total', () => {
  const items = makeItems();
  const view = listQueue({ items, records: RECORDS });

  assert.equal(view.total, 4);
  assert.deepEqual(view.groups, { cluster: 1, link: 2, isolated: 1 });
  assert.deepEqual(view.statusCounts, { pending: 2, reviewed: 1, dismissed: 1 });

  assert.equal(view.items.length, 4);
  const first = view.items[0];
  assert.equal(first.status, 'pending');
  // sources 只增 title：id/revision 原样保留
  assert.deepEqual(first.candidate.sources, [
    { id: 'a', revision: 1, title: 'title-a' },
    { id: 'b', revision: 1, title: 'title-b' },
  ]);
  // 候选既有字段（含 evidence）原样保留
  assert.deepEqual(first.candidate.evidence, { sharedEntities: ['x'] });
  assert.equal(first.candidate.kind, 'link');
  // 取不到记录的源卡 title 为 null，不删 id/revision
  const cluster = view.items[2];
  assert.deepEqual(cluster.candidate.sources, [
    { id: 'd', revision: 1, title: null },
    { id: 'e', revision: 1, title: null },
    { id: 'f', revision: 1, title: null },
  ]);
  assert.deepEqual(cluster.candidate.evidence, { topic: 't' });
});

test('listQueue：缺 records 时 title 一律 null；不修改输入 items（纯只读投影）', () => {
  const items = makeItems();
  const before = JSON.stringify(items);
  const view = listQueue({ items });
  assert.equal(view.total, 4);
  for (const item of view.items) {
    for (const s of item.candidate.sources) {
      assert.equal(s.title, null);
      assert.ok(typeof s.id === 'string' && Object.hasOwn(s, 'revision'));
    }
  }
  assert.equal(JSON.stringify(items), before, 'listQueue 不得改动输入 items');

  // records: null 与缺省同语义
  const view2 = listQueue({ items, records: null });
  assert.deepEqual(view2, view);
});

test('listQueue：空队列 → 空投影，计数全 0、total 0', () => {
  const view = listQueue({ items: [], records: RECORDS });
  assert.deepEqual(view, {
    items: [],
    total: 0,
    groups: { cluster: 0, link: 0, isolated: 0 },
    statusCounts: { pending: 0, reviewed: 0, dismissed: 0 },
  });
});

test('listQueue：真实队列事务产生的 items 同样可投影（与 createCandidateQueue 组合）', () => {
  const q = createCandidateQueue({ scopeId: SCOPE });
  const a = makeCandidate({ kind: 'link', sources: sortedRefs('a', 'b') });
  const b = makeCandidate({ kind: 'isolated', sources: sortedRefs('c'), evidence: {} });
  q.enqueue([a, b], { expectedRevision: 0, operationId: 'op-list-1' });
  q.review(b.id, { decision: 'dismissed', expectedRevision: 1, operationId: 'op-list-2' });
  const view = listQueue({ items: q.snapshot().items, records: RECORDS });
  assert.equal(view.total, 2);
  assert.deepEqual(view.groups, { cluster: 0, link: 1, isolated: 1 });
  assert.deepEqual(view.statusCounts, { pending: 1, reviewed: 0, dismissed: 1 });
  const aItem = view.items.find((it) => it.candidate.id === a.id);
  assert.deepEqual(aItem.candidate.sources, [
    { id: 'a', revision: 1, title: 'title-a' },
    { id: 'b', revision: 1, title: 'title-b' },
  ]);
});

// ===========================================================================
// listQueue：可选分页
// ===========================================================================

test('listQueue 分页：不传 limit/offset 与传 {limit: total, offset: 0} 完全一致', () => {
  const items = makeItems();
  const plain = listQueue({ items, records: RECORDS });
  const paged = listQueue({ items, records: RECORDS, limit: plain.total, offset: 0 });
  assert.deepEqual(paged, plain);
});

test('listQueue 分页：limit/offset 正确切页，total/groups/statusCounts 不受分页影响', () => {
  const items = makeItems();
  const view = listQueue({ items, records: RECORDS, limit: 2, offset: 1 });
  assert.equal(view.total, 4);
  assert.deepEqual(view.groups, { cluster: 1, link: 2, isolated: 1 });
  assert.deepEqual(view.statusCounts, { pending: 2, reviewed: 1, dismissed: 1 });
  // 第二页：isolated(c) 与 cluster(d/e/f)（按入队顺序切片）
  assert.deepEqual(view.items.map((it) => it.candidate.kind), ['isolated', 'cluster']);
  assert.equal(view.items[0].status, 'reviewed');
  assert.equal(view.items[1].status, 'dismissed');

  // offset 超出总数 → 空页但 total 仍是 4
  const tail = listQueue({ items, records: RECORDS, offset: 99 });
  assert.deepEqual(tail.items, []);
  assert.equal(tail.total, 4);

  // limit=0 → 空页但 total 仍是 4
  const zero = listQueue({ items, records: RECORDS, limit: 0 });
  assert.deepEqual(zero.items, []);
  assert.equal(zero.total, 4);

  // 只传 offset = 从 offset 取到末尾
  const fromOffset = listQueue({ items, records: RECORDS, offset: 3 });
  assert.equal(fromOffset.items.length, 1);
  assert.equal(fromOffset.items[0].candidate.kind, 'link');
});

test('listQueue：非法参数 fail-closed（形状 / 未知字段 / 非法分页值）', () => {
  const items = makeItems();
  expectCode('INVALID_INPUT', () => listQueue(null));
  expectCode('INVALID_INPUT', () => listQueue({ items: 'nope' }));
  expectCode('INVALID_INPUT', () => listQueue({ items, extra: 1 }));
  expectCode('INVALID_INPUT', () => listQueue({ items, records: 'nope' }));
  expectCode('INVALID_INPUT', () => listQueue({ items: [{ candidate: {}, status: 'pending' }] }));
  expectCode('INVALID_INPUT', () => listQueue({
    items: [{ candidate: makeCandidate({ sources: sortedRefs('a') }), status: 'done' }],
  }));
  expectCode('INVALID_INPUT', () => listQueue({ items, limit: -1 }));
  expectCode('INVALID_INPUT', () => listQueue({ items, limit: 1.5 }));
  expectCode('INVALID_INPUT', () => listQueue({ items, offset: -1 }));
  expectCode('INVALID_INPUT', () => listQueue({ items, offset: '0' }));
});

// ===========================================================================
// buildDraft：被改源不在 candidate.sources 的结构化错误 details
// ===========================================================================

test('buildDraft link：proposal.links[i].id 不在 candidate.sources → INVALID_INPUT + details{field,reason,hint}', () => {
  const candidate = makeCandidate({ kind: 'link', sources: sortedRefs('a', 'b') });
  const records = [makeCard('a'), makeCard('b')];
  // 错误码与 message 前缀不变（前端仍按 message 兜底）
  assert.throws(
    () => buildDraft({
      candidate,
      records,
      proposal: { kind: 'link', links: [{ id: 'zzz', after: [{ target: 'a', rel: '相关' }] }] },
    }),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.equal(err.message, 'proposal.links[0].id "zzz" 必须是 candidate.sources 中的卡');
      // 结构化 details：field 精确到下标，hint 为中文人话
      assert.equal(err.details.field, 'proposal.links[0].id');
      assert.equal(typeof err.details.reason, 'string');
      assert.ok(err.details.reason.includes('zzz'));
      assert.ok(err.details.hint.includes('刷新') && err.details.hint.includes('重新分析'));
      return true;
    },
  );
});

test('buildDraft link：合法草案不受 details 改动影响（plan/digest 行为不变）', () => {
  const candidate = makeCandidate({ kind: 'link', sources: sortedRefs('a', 'b') });
  const records = [makeCard('a'), makeCard('b')];
  const built = buildDraft({
    candidate,
    records,
    proposal: { kind: 'link', links: [{ id: 'a', after: [{ target: 'b', rel: '相关' }] }] },
  });
  assert.equal(built.plan.kind, 'link');
  assert.match(built.digest, /^[0-9a-f]{64}$/);
  assert.equal(built.changedItems, 1);
});
