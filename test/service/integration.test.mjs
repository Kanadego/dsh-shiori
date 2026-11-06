import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShioriService } from '../../src/service/index.mjs';
import { createFileStore } from '../../src/storage/index.mjs';
import { validateConfig, renderL1, evaluateMutation } from '../../src/core/index.mjs';

const config = validateConfig({});
const now = () => new Date('2026-10-24T12:00:00.000Z');
async function fixture(t, scope = 'amber') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const opts = { root, activeScopeId: scope, config, renderL1, policy: evaluateMutation };
  return { root, service: await createShioriService({ root, activeScopeId: scope, now }),
    store: await createFileStore(opts), global: await createFileStore({ ...opts, activeScopeId: 'global' }) };
}
const core = (operationId, text, expectedRevision) => ({ operationId, changes: [{ kind: 'core', text, expectedRevision }] });
const topicReq = (operationId, item, body, meta = {}) => ({ operationId, changes: [{ kind: 'topic', key: item.key,
  text: body, expectedRevision: item.revision, topic: { title: item.title, summary: item.summary, ...meta } }] });
async function seedTopic(store, operationId = 'seed-topic') {
  return store.commit({ operationId, changes: [{ kind: 'topic', key: 'plans', expectedRevision: null,
    topic: { title: 'Plans', summary: 'test summary', updated: '2026-01-01T00:00:00.000Z', body: 'original body\n' } }] });
}
const code = value => e => e.code === value;

test('requires explicit absolute root and trusted scope', async () => {
  await assert.rejects(createShioriService(), code('INVALID_INPUT'));
  await assert.rejects(createShioriService({ root: 'relative', activeScopeId: 'amber' }), code('INVALID_INPUT'));
});

test('core fallback token validates source and first write shadows only active scope', async t => {
  const { service, store, global } = await fixture(t);
  await global.commit(core('seed-core', 'global body', null));
  const r = await service.readCore();
  const result = await service.mutate(core('shadow-core', r.text + '\nprivate', r.revision));
  assert.equal(r.scopeId, 'global'); assert.equal(result.changes[0].scope, 'amber');
  assert.equal(result.changes[0].beforeRevision, null);
  assert.equal((await global.readCore()).text, 'global body');
  assert.equal((await store.readCore()).text, 'global body\nprivate');
});

test('rejects stale global fallback after manual edit and rejects raw null/hash bypass', async t => {
  const { root, service, global, store } = await fixture(t);
  await global.commit(core('seed-core', 'global body', null));
  const r = await service.readCore();
  await fs.writeFile(path.join(root, 'scopes/global/core.md'), 'manual newer');
  await assert.rejects(service.mutate(core('stale', 'old', r.revision)), code('REVISION_CONFLICT'));
  await assert.rejects(service.mutate(core('raw-null', 'bad', null)), code('REVISION_CONFLICT'));
  await assert.rejects(fs.stat(path.join(root, 'scopes/amber/core.md')), code('ENOENT'));
  assert.equal((await store.readCore()).text, 'manual newer');
});

test('empty active file is not fallback', async t => {
  const { service, global } = await fixture(t);
  await service.mutate(core('empty-active', '', null));
  await global.commit(core('global-later', 'shared', null));
  assert.equal((await service.readCore()).scopeId, 'amber');
  assert.equal((await service.readCore()).text, '');
});

test('topic fallback maps C body plus metadata to B structured topic and updates updated', async t => {
  const { service, store, global } = await fixture(t);
  await seedTopic(global);
  const item = await service.readTopic('plans');
  const result = await service.mutate(topicReq('shadow-topic', item, 'new exact body\n\n', { summary: 'changed' }));
  const saved = await store.readTopic('plans');
  assert.equal(result.changes[0].beforeRevision, null); assert.equal(result.changes[0].scope, 'amber');
  assert.equal(saved.scopeId, 'amber'); assert.equal(saved.body, 'new exact body\n\n');
  assert.equal(saved.updated, '2026-10-24T12:00:00.000Z');
  assert.equal(saved.title, 'Plans'); assert.equal(saved.summary, 'changed');
  assert.equal((await global.readTopic('plans')).body, 'original body\n');
});

test('stale fallback topic and metadata rejected; missing topic is not created', async t => {
  const { root, service, global } = await fixture(t);
  await seedTopic(global); const item = await service.readTopic('plans');
  const file = path.join(root, 'scopes/global/topics/plans.md');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('original body', 'manual edit'));
  await assert.rejects(service.mutate(topicReq('stale-topic', item, 'old')), code('REVISION_CONFLICT'));
  await assert.rejects(service.readTopic('missing'), code('NOT_FOUND'));
});

test('two readers racing fallback core writes get one winner', async t => {
  const { service, root, global } = await fixture(t);
  await global.commit(core('seed-core', 'shared', null));
  const other = await createShioriService({ root, activeScopeId: 'amber', now });
  const a = await service.readCore(); const b = await other.readCore();
  const rs = await Promise.allSettled([service.mutate(core('race-a', 'A', a.revision)), other.mutate(core('race-b', 'B', b.revision))]);
  assert.equal(rs.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(rs.filter(r => r.status === 'rejected' && r.reason.code === 'REVISION_CONFLICT').length, 1);
});

test('two readers racing fallback topic writes get one winner', async t => {
  const { service, root, global } = await fixture(t); await seedTopic(global);
  const other = await createShioriService({ root, activeScopeId: 'amber', now });
  const a = await service.readTopic('plans'); const b = await other.readTopic('plans');
  const rs = await Promise.allSettled([service.mutate(topicReq('topic-a', a, 'A')), other.mutate(topicReq('topic-b', b, 'B'))]);
  assert.equal(rs.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(rs.filter(r => r.status === 'rejected' && r.reason.code === 'REVISION_CONFLICT').length, 1);
});

test('core view renders index but core mutations persist body only', async t => {
  const { root, service, store } = await fixture(t); await seedTopic(store);
  await service.mutate(core('new-core', 'body', null));
  const rendered = await service.readCoreView();
  assert.match(rendered.text, /Topic memory index/);
  // body 是磁盘正文（面板编辑与回写只能用它）；text 才是带派生索引的渲染视图。
  assert.equal(rendered.body, 'body');
  const disk = await service.readCore(); assert.equal(disk.text, 'body');
  await service.mutate(core('append-core', disk.text + '\nappend', disk.revision));
  assert.equal(await fs.readFile(path.join(root, 'scopes/amber/core.md'), 'utf8'), 'body\nappend');
});

test('rendered core token catches topic/index edit without generation advance', async t => {
  const { root, service, store } = await fixture(t); await seedTopic(store);
  const view = await service.readCoreView();
  const file = path.join(root, 'scopes/amber/topics/plans.md');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('test summary', 'manual summary'));
  await assert.rejects(service.mutate(core('stale-view', 'replacement', view.revision)), code('REVISION_CONFLICT'));
});

test('A budget measures complete rendered view including topic index', async t => {
  const { service, store } = await fixture(t); await seedTopic(store);
  await assert.rejects(service.mutate(core('over-cap', 'x'.repeat(9999), null)), code('BUDGET_REJECTED'));
});

test('revision tokens bind root, scope and target; scope fields are forbidden', async t => {
  const { root, service, store } = await fixture(t);
  const other = await createShioriService({ root, activeScopeId: 'violet', now });
  const r = await service.readCore();
  await assert.rejects(other.mutate(core('cross-scope', 'bad', r.revision)), code('REVISION_CONFLICT'));
  await assert.rejects(service.mutate({ ...core('inject-scope', '', null), scopeId: 'global' }), code('INVALID_INPUT'));
  await seedTopic(store); const topic = await service.readTopic('plans');
  await assert.rejects(service.mutate(core('wrong-kind', 'bad', topic.revision)), code('REVISION_CONFLICT'));
  await assert.rejects(service.mutate(core('damaged', 'bad', r.revision + 'x')), code('INVALID_INPUT'));
});

test('same operationId replay survives service instance and time; changed payload conflicts', async t => {
  const { root, service, global } = await fixture(t);
  await global.commit(core('seed-core', 'shared', null)); await seedTopic(global);
  const req = core('idempotent-core', 'private', (await service.readCore()).revision);
  const first = await service.mutate(req);
  const other = await createShioriService({ root, activeScopeId: 'amber', now: () => new Date('2030-01-01') });
  assert.deepEqual(await other.mutate(req), first);
  await assert.rejects(other.mutate({ ...req, changes: [{ ...req.changes[0], text: 'different' }] }), code('REVISION_CONFLICT'));
  const tr = topicReq('idempotent-topic', await service.readTopic('plans'), 'body');
  const tf = await service.mutate(tr); assert.deepEqual(await other.mutate(tr), tf);
});

test('existing topic metadata updates preserve caller updated; no invented topic', async t => {
  const { service, store } = await fixture(t); await seedTopic(store);
  const item = await service.readTopic('plans'); const updated = '2026-10-25T00:00:00.000Z';
  await service.mutate(topicReq('metadata', item, 'body', { title: 'New title', summary: '', updated }));
  const saved = await service.readTopic('plans');
  assert.equal(saved.updated, updated); assert.equal(saved.summary, ''); assert.equal(saved.title, 'New title');
  await assert.rejects(service.readTopic('missing'), code('NOT_FOUND'));
});

test('search is lexical; absent persona is readable but writes require adapter', async t => {
  const { service, store } = await fixture(t); await seedTopic(store);
  assert.equal((await service.search('original summary')).length, 1);
  assert.deepEqual(await service.readPersona(), { name: null, text: null });
  await assert.rejects(service.mutate({ operationId: 'no-persona', changes: [{ kind: 'persona', text: 'card', expectedRevision: null }] }), code('UNSUPPORTED'));
});

test('persona adapter receives isolated CAS request; mixed writes are unsupported', async t => {
  const { root } = await fixture(t); let received;
  const adapter = { read: async () => ({ name: 'fixture', text: 'card', revision: 'v1' }),
    commit: async request => { received = request; return { operationId: request.operationId }; } };
  const service = await createShioriService({ root, activeScopeId: 'amber', personaAdapter: adapter });
  assert.equal((await service.readPersona()).revision, 'v1');
  const req = { operationId: 'persona-cas', changes: [{ kind: 'persona', text: 'new', expectedRevision: 'v1' }] };
  await service.mutate(req); assert.deepEqual(received, req);
  await assert.rejects(service.mutate({ operationId: 'mixed', changes: [...req.changes, core('unused', 'body', null).changes[0]] }), code('UNSUPPORTED'));
});

test('L3 归档：listTopics 带归档标记，L1 索引跳过归档项并出现钩子行（N=0 消失）', async t => {
  const { service, store } = await fixture(t);
  await store.commit({ operationId: 'seed-warm', changes: [{ kind: 'topic', key: 'warm', expectedRevision: null,
    topic: { title: 'Warm', summary: '热专题摘要', updated: '2026-01-01T00:00:00.000Z', body: 'warm body\n' } }] });
  await store.commit({ operationId: 'seed-cold', changes: [{ kind: 'topic', key: 'cold', expectedRevision: null,
    topic: { title: 'Cold', summary: '冷专题摘要', updated: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-11-07T00:00:00.000Z', body: 'cold body\n' } }] });

  const listed = await service.listTopics();
  assert.deepEqual(
    listed.map(x => [x.key, x.archived, x.archivedAt ?? null]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [['cold', true, '2026-11-07T00:00:00.000Z'], ['warm', false, null]],
  );

  // L1 渲染：归档项不进索引条目，末尾出现 N=1 钩子行
  const view = await service.readCoreView();
  assert.ok(!view.text.includes('- cold [amber]'), '归档专题不进 L1 索引');
  assert.ok(view.text.includes('- warm [amber] — 热专题摘要'));
  assert.ok(view.text.includes('另有 1 篇冷专题，memory_search 可查'));

  // 删掉 archivedAt（空串 = 取消归档）即恢复：钩子行消失，索引复原
  const cold = await store.readTopic('cold');
  await store.commit({ operationId: 'unarchive-cold', changes: [{ kind: 'topic', key: 'cold',
    expectedRevision: cold.revision,
    topic: { title: 'Cold', summary: '冷专题摘要', updated: cold.updated, archivedAt: '', body: cold.body } }] });
  const view2 = await service.readCoreView();
  assert.ok(!view2.text.includes('另有'), 'N=0 时钩子行整行不出现');
  assert.ok(view2.text.includes('- cold [amber] — 冷专题摘要'));
});

test('memory_read 不受归档影响：归档专题照常返回全文', async t => {
  const { service, store } = await fixture(t);
  await store.commit({ operationId: 'seed-cold', changes: [{ kind: 'topic', key: 'cold', expectedRevision: null,
    topic: { title: 'Cold', summary: '冷专题摘要', updated: '2026-01-01T00:00:00.000Z',
      archivedAt: '2026-11-07T00:00:00.000Z', body: '全文正文不能丢\n' } }] });
  const topic = await service.readTopic('cold');
  assert.equal(topic.body, '全文正文不能丢\n');
  assert.equal(topic.archivedAt, '2026-11-07T00:00:00.000Z');
  assert.equal(topic.title, 'Cold');
});

test('memory_search 冷搜：默认包含归档 topic，但只回摘要级（state=archived、score=0、排后、无正文）', async t => {
  const { service, store } = await fixture(t);
  await store.commit({ operationId: 'seed-2', changes: [
    { kind: 'topic', key: 'warm', expectedRevision: null,
      topic: { title: 'Warm', summary: '排障手册热版', updated: '2026-01-01T00:00:00.000Z', body: 'warm 正文\n' } },
    { kind: 'topic', key: 'cold', expectedRevision: null,
      topic: { title: 'Cold', summary: '排障手册冷版', updated: '2026-01-01T00:00:00.000Z',
        archivedAt: '2026-11-07T00:00:00.000Z', body: 'cold 正文\n' } },
  ] });

  const hits = await service.search('排障手册');
  assert.deepEqual(hits.map(h => [h.key, h.score, h.state ?? null]), [
    ['warm', 1, null],   // 未归档在前，正常计分
    ['cold', 0, 'archived'], // 归档在后，score 恒 0，state 标 archived
  ]);
  for (const hit of hits) {
    const expectedKeys = hit.state === 'archived'
      ? ['key', 'title', 'summary', 'scopeId', 'score', 'state']
      : ['key', 'title', 'summary', 'scopeId', 'score'];
    assert.deepEqual(Object.keys(hit).sort(), expectedKeys.sort());
    assert.ok(!('body' in hit), '搜索结果绝不返回正文');
    assert.ok(!JSON.stringify(hit).includes('正文'), '摘要级信息不含正文片段');
  }

  // 只命中归档专题正文、不命中 key/title/summary 时也能被搜到（冷搜可考古）
  const coldOnly = await service.search('cold 正文专属词');
  assert.deepEqual(coldOnly.map(h => [h.key, h.state]), [['cold', 'archived']]);
});
