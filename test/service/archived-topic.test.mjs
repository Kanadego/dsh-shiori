import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShioriService } from '../../src/service/index.mjs';
import { validateConfig, renderL1, evaluateMutation } from '../../src/core/index.mjs';

const config = validateConfig({});
const now = () => new Date('2026-10-24T12:00:00.000Z');
const code = value => e => e.code === value;

async function fixture(t, scope = 'amber') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-archived-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = await createShioriService({ root, activeScopeId: scope, now, config, renderL1, policy: evaluateMutation });
  return { root, service };
}

/** 与 host 工具同形状的写请求：topic 元数据只带 title/summary（append/rewrite 路径）。 */
const topicWrite = (operationId, item, body, meta = {}) => ({ operationId, changes: [{ kind: 'topic', key: item.key,
  text: body, expectedRevision: item.revision, topic: { title: item.title, summary: item.summary, ...meta } }] });

async function seedWarm(service, key = 'plans') {
  return service.mutate({ operationId: `seed-${key}`, changes: [{ kind: 'topic', key, expectedRevision: null,
    text: 'original body\n', topic: { title: 'Plans', summary: 'test summary', updated: '2026-01-01T00:00:00.000Z' } }] });
}

test('topic 写入 archivedAt 字符串：listTopics 标记归档，front-matter 落盘', async t => {
  const { root, service } = await fixture(t);
  await seedWarm(service);
  const item = await service.readTopic('plans');
  await service.mutate(topicWrite('archive-it', item, item.body, { archivedAt: '2026-11-07T00:00:00.000Z' }));

  const listed = await service.listTopics();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].archived, true);
  assert.equal(listed[0].archivedAt, '2026-11-07T00:00:00.000Z');

  const reread = await service.readTopic('plans');
  assert.equal(reread.archivedAt, '2026-11-07T00:00:00.000Z');
  const disk = await fs.readFile(path.join(root, 'scopes/amber/topics/plans.md'), 'utf8');
  assert.match(disk, /archivedAt: "2026-11-07T00:00:00\.000Z"/);
});

test('append 语义（不带 archivedAt 的元数据）保留原归档标记，不静默取消', async t => {
  const { service } = await fixture(t);
  await seedWarm(service);
  const item = await service.readTopic('plans');
  await service.mutate(topicWrite('archive-it', item, item.body, { archivedAt: '2026-11-07T00:00:00.000Z' }));

  // 模拟 topic_append：payload 只有 title/summary + 全文 body，不含 archivedAt
  const current = await service.readTopic('plans');
  const appended = current.body + '\n## 2026-11-07 新增段落\n\nappend content\n';
  await service.mutate(topicWrite('append-after-archive', current, appended));

  const after = await service.readTopic('plans');
  assert.equal(after.archivedAt, '2026-11-07T00:00:00.000Z', 'append 后归档标记必须保留');
  assert.equal(after.body, appended);
  const listed = await service.listTopics();
  assert.equal(listed[0].archived, true);
});

test('rewrite 语义（全量替换正文，元数据不带 archivedAt）仍保留归档', async t => {
  const { service } = await fixture(t);
  await seedWarm(service);
  const item = await service.readTopic('plans');
  await service.mutate(topicWrite('archive-it', item, item.body, { archivedAt: '2026-11-07T00:00:00.000Z' }));

  // 模拟 memory_rewrite 的 topic 分支：全新正文 + 既有 title/summary
  const current = await service.readTopic('plans');
  await service.mutate(topicWrite('rewrite-after-archive', current, '全新重写的正文\n'));

  const after = await service.readTopic('plans');
  assert.equal(after.archivedAt, '2026-11-07T00:00:00.000Z', 'rewrite 后归档标记必须保留');
  assert.equal(after.body, '全新重写的正文\n');
});

test('显式 archivedAt: null 清除归档（恢复）：标记消失，L1 索引复原', async t => {
  const { service } = await fixture(t);
  await seedWarm(service);
  const item = await service.readTopic('plans');
  await service.mutate(topicWrite('archive-it', item, item.body, { archivedAt: '2026-11-07T00:00:00.000Z' }));

  // 归档后 L1 索引无该条目、有钩子行
  const archivedView = await service.readCoreView();
  assert.ok(!archivedView.text.includes('- plans [amber]'));
  assert.ok(archivedView.text.includes('另有 1 篇冷专题'));

  const archived = await service.readTopic('plans');
  await service.mutate(topicWrite('unarchive-it', archived, archived.body, { archivedAt: null }));

  const after = await service.readTopic('plans');
  assert.equal(after.archivedAt, undefined, 'null 清除后 readTopic 不再带 archivedAt');
  const listed = await service.listTopics();
  assert.equal(listed[0].archived, false);
  assert.equal(listed[0].archivedAt ?? null, null);
  // 恢复后钩子行消失、条目回到索引
  const view = await service.readCoreView();
  assert.ok(!view.text.includes('另有'), 'N=0 时钩子行整行不出现');
  assert.ok(view.text.includes('- plans [amber] — test summary'));
});

test('未归档 topic 的 append/rewrite 不引入 archivedAt', async t => {
  const { service } = await fixture(t);
  await seedWarm(service);
  const item = await service.readTopic('plans');
  await service.mutate(topicWrite('plain-append', item, item.body + 'more\n'));
  const after = await service.readTopic('plans');
  assert.equal(after.archivedAt, undefined);
  assert.equal((await service.listTopics())[0].archived, false);
});

test('非法 archivedAt 报 INVALID_INPUT 且不落盘：非日期串 / 空串 / 非字符串', async t => {
  const { service } = await fixture(t);
  await seedWarm(service);
  const item = await service.readTopic('plans');
  for (const [opId, bad] of [['bad-date', 'not-a-date'], ['bad-empty', ''], ['bad-type', 123]]) {
    await assert.rejects(
      service.mutate(topicWrite(opId, item, item.body, { archivedAt: bad })),
      e => e.code === 'INVALID_INPUT' && e.message.includes('archivedAt'),
      `archivedAt=${JSON.stringify(bad)} 应报含字段名的 INVALID_INPUT`,
    );
  }
  // 报错后 topic 保持原样
  const unchanged = await service.readTopic('plans');
  assert.equal(unchanged.archivedAt, undefined);
  assert.equal(unchanged.body, 'original body\n');
});
