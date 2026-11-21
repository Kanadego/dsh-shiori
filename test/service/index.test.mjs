// 0.5 批次 2 A 线 · service 层保留策略（retention/archiveOrigin）：
// 字段透出（listTopics/readTopic）、token meta 继承（append/rewrite 不丢字段）、
// 显式清除、非法值拒绝、陈旧 token 冲突。真实 FileStore + 真实磁盘临时 root。

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShioriService, stateWeightOf } from '../../src/service/index.mjs';
import { validateConfig } from '../../src/core/index.mjs';

const config = validateConfig({});
const now = () => new Date('2026-11-21T12:00:00.000Z');

async function fixture(t, scope = 'amber') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-svc-a05-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = await createShioriService({ root, activeScopeId: scope, now, config });
  return { root, service };
}

/** 与 host 工具同形状的写请求：topic 元数据可带任意 S3/A 线字段。 */
const topicWrite = (operationId, item, body, meta = {}) => ({ operationId, changes: [{ kind: 'topic', key: item.key,
  text: body, expectedRevision: item.revision, topic: { title: item.title, summary: item.summary, ...meta } }] });

async function seedWarm(service, key = 'plans', meta = {}) {
  return service.mutate({ operationId: `seed-${key}`, changes: [{ kind: 'topic', key, expectedRevision: null,
    text: 'original body\n', topic: { title: 'Plans', summary: 'test summary', updated: '2026-11-01T00:00:00.000Z', ...meta } }] });
}

test('listTopics/readTopic 透出 retention/archiveOrigin：缺省 standing/manual', async t => {
  const { root, service } = await fixture(t);
  await seedWarm(service);
  const listed = await service.listTopics();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].retention, 'standing');
  assert.equal(listed[0].archiveOrigin, 'manual');
  const item = await service.readTopic('plans');
  assert.equal(item.retention, 'standing');
  assert.equal(item.archiveOrigin, 'manual');
  // 磁盘 front-matter 无这两个键（缺省不落盘，老工具读取形状不变）
  const disk = await fs.readFile(path.join(root, 'scopes/amber/topics/plans.md'), 'utf8');
  assert.doesNotMatch(disk, /^retention:/m);
  assert.doesNotMatch(disk, /^archiveOrigin:/m);
});

test('创建时显式 retention: historical 落盘并在列表/读取透出', async t => {
  const { root, service } = await fixture(t);
  await seedWarm(service, 'archive-me', { retention: 'historical' });
  const disk = await fs.readFile(path.join(root, 'scopes/amber/topics/archive-me.md'), 'utf8');
  assert.match(disk, /^retention: "historical"$/m);
  const listed = await service.listTopics();
  assert.equal(listed[0].retention, 'historical');
  assert.equal(listed[0].archiveOrigin, 'manual');
  const item = await service.readTopic('archive-me');
  assert.equal(item.retention, 'historical');
});

test('append/rewrite 继承 retention/archiveOrigin（token meta），不丢手改字段', async t => {
  const { service } = await fixture(t);
  await seedWarm(service, 'plans', { retention: 'historical', archiveOrigin: 'auto-inactive' });
  const item = await service.readTopic('plans');
  // append 语义：payload 只带 title/summary + 全文 body，不带保留策略字段
  await service.mutate(topicWrite('append-after', item, item.body + '\n新增段落\n'));
  const after = await service.readTopic('plans');
  assert.equal(after.retention, 'historical', 'append 后 retention 必须继承');
  assert.equal(after.archiveOrigin, 'auto-inactive', 'append 后 archiveOrigin 必须继承');
  // rewrite 语义：全新正文同样继承
  const current = await service.readTopic('plans');
  await service.mutate(topicWrite('rewrite-after', current, '全新重写的正文\n'));
  const rewritten = await service.readTopic('plans');
  assert.equal(rewritten.retention, 'historical');
  assert.equal(rewritten.archiveOrigin, 'auto-inactive');
});

test('显式 retention: null 清除（磁盘省略整行，读取回 standing）', async t => {
  const { root, service } = await fixture(t);
  await seedWarm(service, 'plans', { retention: 'historical' });
  const item = await service.readTopic('plans');
  await service.mutate(topicWrite('clear-it', item, item.body, { retention: null }));
  const after = await service.readTopic('plans');
  assert.equal(after.retention, 'standing');
  const disk = await fs.readFile(path.join(root, 'scopes/amber/topics/plans.md'), 'utf8');
  assert.doesNotMatch(disk, /^retention:/m);
  const listed = await service.listTopics();
  assert.equal(listed[0].retention, 'standing');
});

test('非法枚举 mutate 拒绝（INVALID_INPUT），不许静默纠正', async t => {
  const { service } = await fixture(t);
  await seedWarm(service);
  const item = await service.readTopic('plans');
  for (const [field, bad] of [
    ['retention', 'bogus'], ['retention', 42], ['retention', true],
    ['archiveOrigin', 'auto'], ['archiveOrigin', 7], ['archiveOrigin', false],
  ]) {
    await assert.rejects(
      () => service.mutate(topicWrite(`bad-${field}-${String(bad)}`, item, item.body, { [field]: bad })),
      (error) => error.code === 'INVALID_INPUT' && new RegExp(`topic.${field}`).test(error.message),
      `${field}=${String(bad)}`,
    );
  }
  // 变更被拒后磁盘与读取保持原值
  const after = await service.readTopic('plans');
  assert.equal(after.retention, 'standing');
});

test('手改磁盘：archivedAt 有值但无 archiveOrigin → 读取按 manual（人工归档缺省）', async t => {
  const { root, service } = await fixture(t);
  await seedWarm(service, 'hand');
  const file = path.join(root, 'scopes/amber/topics/hand.md');
  const raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, raw.replace('---\n', '---\narchivedAt: "2026-11-20T00:00:00.000Z"\n'), 'utf8');
  const item = await service.readTopic('hand');
  assert.equal(item.archivedAt, '2026-11-20T00:00:00.000Z');
  assert.equal(item.archiveOrigin, 'manual', '已有 archivedAt 但无来源 → 人工归档');
  assert.equal(item.retention, 'standing');
  const listed = await service.listTopics();
  assert.equal(listed[0].archiveOrigin, 'manual');
  assert.equal(listed[0].archived, true);
});

test('读后被第三方改 retention：陈旧 token append → REVISION_CONFLICT（防旧值回写）', async t => {
  const { service } = await fixture(t);
  await seedWarm(service, 'plans');
  const stale = await service.readTopic('plans');
  // 第三方（模拟另一会话/面板）把 retention 改成 historical
  const fresh = await service.readTopic('plans');
  await service.mutate(topicWrite('third-party', fresh, fresh.body, { retention: 'historical' }));
  // 陈旧 token 的 append 必须冲突（正常流程 generation/revision CAS 先拦，
  // metadata 比对是防伪 token 的纵深防线），而不是把 standing 继承回去
  await assert.rejects(
    () => service.mutate(topicWrite('stale-append', stale, stale.body + '\nmore\n')),
    (error) => error.code === 'REVISION_CONFLICT',
  );
  const after = await service.readTopic('plans');
  assert.equal(after.retention, 'historical', '冲突拒写后磁盘值不被陈旧 token 覆盖');
  assert.equal(after.body, fresh.body, '正文未被陈旧 append 污染');
});

test('archiveOrigin 显式写入 auto-inactive + archivedAt 组合，全程透出', async t => {
  const { root, service } = await fixture(t);
  await seedWarm(service, 'plans');
  const item = await service.readTopic('plans');
  await service.mutate(topicWrite('auto-archive', item, item.body, {
    archivedAt: '2026-11-21T00:00:00.000Z', archiveOrigin: 'auto-inactive',
  }));
  const after = await service.readTopic('plans');
  assert.equal(after.archivedAt, '2026-11-21T00:00:00.000Z');
  assert.equal(after.archiveOrigin, 'auto-inactive');
  const disk = await fs.readFile(path.join(root, 'scopes/amber/topics/plans.md'), 'utf8');
  assert.match(disk, /^archiveOrigin: "auto-inactive"$/m);
  const listed = await service.listTopics();
  assert.equal(listed[0].archived, true);
  assert.equal(listed[0].archiveOrigin, 'auto-inactive');
});

// ---------------------------------------------------------------------------
// 0.5 批次 4 D 线：memory_search 归档排序 finalScore = 词法分 × stateWeightOf。
// 用例设计带变异自证：把 stateWeight 全设 1.0（或退化按 key 排序）会让
// 「b-cold 排在 a-frozen 之前」这条断言变红（见任务书「变红自证」要求）。
// ---------------------------------------------------------------------------

/** 建一张已归档 topic（archiveOrigin 显式指定；title/summary 含查询词）。 */
async function seedArchived(service, key, { origin, title = '归档', summary = '排障' } = {}) {
  await service.mutate({ operationId: `seed-${key}`, changes: [{ kind: 'topic', key, expectedRevision: null,
    text: '归档正文\n', topic: { title, summary, updated: '2026-11-01T00:00:00.000Z' } }] });
  const item = await service.readTopic(key);
  await service.mutate(topicWrite(`archive-${key}`, item, item.body,
    { archivedAt: '2026-11-10T00:00:00.000Z', archiveOrigin: origin }));
}

test('D 线：stateWeightOf 四分支 + 缺失/未知值回落（评审 q-50d63bd04a86684e 拍板口径）', () => {
  assert.equal(stateWeightOf({ archived: false }), 1.0, '未归档 → active');
  assert.equal(stateWeightOf({}), 1.0, 'archived 缺失 → 未归档（storage 缺省即未归档）');
  assert.equal(stateWeightOf({ archived: true, archiveOrigin: 'auto-inactive' }), 0.5, '系统自动冷却 → frozen');
  assert.equal(stateWeightOf({ archived: true, archiveOrigin: 'manual' }), 0.75, '人工归档 → cold');
  assert.equal(stateWeightOf({ archived: true }), 0.75, 'origin 缺失 → 人工归档缺省口径（storage 补 manual）');
  assert.equal(stateWeightOf({ archived: true, archiveOrigin: 'bogus' }), 0.75, '未知 origin 保守回落 cold，不静默变 active');
  assert.equal(stateWeightOf({ archived: 1, archiveOrigin: undefined }), 0.75, '垃圾真值按归档保守处理');
});

test('D 线：search 归档排序 finalScore = 词法分 × stateWeightOf；活跃恒在前；score 字段保留词法分', async t => {
  const { service } = await fixture(t);
  // 关键区分度：a-frozen 与 b-cold 同词法分（1），键序 a-frozen < b-cold。
  // 权重生效时 b-cold（0.75）排在 a-frozen（0.5）前；权重全 1.0 或退化按 key
  // 排序时 a-frozen 会反超 → 断言红（变异自证）。
  await seedArchived(service, 'a-frozen', { origin: 'auto-inactive', summary: '排障' });
  await seedArchived(service, 'b-cold', { origin: 'manual', summary: '排障' });
  await seedArchived(service, 'c-strong', { origin: 'auto-inactive', summary: '排障 深冷' });
  await service.mutate({ operationId: 'seed-warm-z', changes: [{ kind: 'topic', key: 'warm-z', expectedRevision: null,
    text: '热正文\n', topic: { title: 'Warm', summary: '排障', updated: '2026-11-01T00:00:00.000Z' } }] });

  const hits = await service.search('排障 深冷');
  assert.deepEqual(hits.map(h => [h.key, h.state ?? null]), [
    ['warm-z', null],          // 活跃恒在前（权重只在归档条目之间比大小）
    ['c-strong', 'archived'],  // 2 词 × frozen 0.5 = 1.0
    ['b-cold', 'archived'],    // 1 词 × cold 0.75 = 0.75
    ['a-frozen', 'archived'],  // 1 词 × frozen 0.5 = 0.5
  ]);
  assert.deepEqual(hits.map(h => h.score), [1, 2, 1, 1], 'score 字段 = 保留的词法命中分（不再恒 0）');
});

test('D 线：同分（finalScore 相等）按 key 码点序稳定排序', async t => {
  const { service } = await fixture(t);
  await seedArchived(service, 't2-auto', { origin: 'auto-inactive', summary: '排障' });
  await seedArchived(service, 't1-auto', { origin: 'auto-inactive', summary: '排障' });
  const hits = await service.search('排障');
  assert.deepEqual(hits.map(h => h.key), ['t1-auto', 't2-auto'], '同为 frozen 0.5 → key 序稳定');
});
