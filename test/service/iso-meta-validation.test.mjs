// A1/A3（P2-1/P2-3）写入侧校验收紧：archivedAt 与 updated 必须是规范 UTC ISO 串。
// 覆盖「写入拒绝」路径：宽松可解析值（英文日期/裸年份/滚动假日期/date-only 以外的
// 非 ISO 串）在 service 层被拒，不再被 V8 宽松解析放行落盘。
// 读路径降级用例见 test/storage/iso-meta-validation.test.mjs。

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

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-isometa-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = await createShioriService({ root, activeScopeId: 'amber', now, config, renderL1, policy: evaluateMutation });
  return { root, service };
}

async function seedTopic(service) {
  await service.mutate({ operationId: 'seed', changes: [{ kind: 'topic', key: 'plans', expectedRevision: null,
    text: 'original body\n', topic: { title: 'Plans', summary: 'test summary', updated: '2026-01-01T00:00:00.000Z' } }] });
  return service.readTopic('plans');
}

const metaWrite = (operationId, item, meta) => ({ operationId, changes: [{ kind: 'topic', key: item.key,
  text: item.body, expectedRevision: item.revision, topic: { title: item.title, summary: item.summary, ...meta } }] });

// 审计 P2-1 的宽松解析盲区：全部能被 new Date()/Date.parse 接受，但不是规范 ISO。
const LOOSE_ARCHIVED_AT = ['March 5, 2026', '2026', 'Feb 30, 2026', '2026/11/07', '11/07/2026'];

test('A1 service 写入侧拒绝宽松日期串的 archivedAt（P2-1 盲区值逐个拒绝）', async t => {
  const { service } = await fixture(t);
  const item = await seedTopic(service);
  for (const bad of LOOSE_ARCHIVED_AT) {
    await assert.rejects(
      service.mutate(metaWrite(`bad-arch-${bad}`, item, { archivedAt: bad })),
      code('INVALID_INPUT'),
      `archivedAt="${bad}" 不应被宽松解析放行`,
    );
  }
  // 磁盘零残留：拒绝路径不得落盘任何垃圾值
  const reread = await service.readTopic('plans');
  assert.equal(reread.archivedAt, undefined);
});

test('A1 service 写入侧接受规范 UTC ISO 的 archivedAt，拒绝带偏移的非规范形态', async t => {
  const { service } = await fixture(t);
  const item = await seedTopic(service);
  await service.mutate(metaWrite('arch-canonical', item, { archivedAt: '2026-11-07T00:00:00.000Z' }));
  assert.equal((await service.readTopic('plans')).archivedAt, '2026-11-07T00:00:00.000Z');

  // 合法 ISO 8601 但非规范 UTC 形态（new Date(v).toISOString() !== v）同样拒绝
  const item2 = await service.readTopic('plans');
  await assert.rejects(
    service.mutate(metaWrite('arch-offset', item2, { archivedAt: '2026-11-07T08:00:00+08:00' })),
    code('INVALID_INPUT'),
  );
});

test('A3 service 写入侧拒绝调用方提供的非 ISO updated', async t => {
  const { service } = await fixture(t);
  const item = await seedTopic(service);
  for (const bad of ['garbage-not-a-date', 'March 5, 2026', '2026']) {
    await assert.rejects(
      service.mutate(metaWrite(`bad-upd-${bad}`, item, { updated: bad })),
      code('INVALID_INPUT'),
      `updated="${bad}" 不应落盘`,
    );
  }
  // token 继承路径（不带 updated）不受影响，updated 继续继承 token.issuedAt
  await service.mutate(metaWrite('inherit-upd', item, {}));
  const after = await service.readTopic('plans');
  assert.equal(after.updated, '2026-10-24T12:00:00.000Z');
});

test('A3 updated 口径：date-only ISO（YYYY-MM-DD）是既有合法形态，继续接受', async t => {
  // 与 archivedAt 的 canonical 口径存在强弱差的点：仓库既有数据/夹具
  // （test/integration、src/acceptance）在用 date-only，属合法 ISO 8601 日期形态
  const { service } = await fixture(t);
  await service.mutate({ operationId: 'seed-date-only', changes: [{ kind: 'topic', key: 'plans', expectedRevision: null,
    text: 'body\n', topic: { title: 'Plans', summary: 'test summary', updated: '2026-10-24' } }] });
  assert.equal((await service.readTopic('plans')).updated, '2026-10-24');
});

test('A3 updated date-only 日历回环：不存在的日期（2026-02-30 / 2026-04-31）必须拒绝，2026-11-07 仍放行', async t => {
  const { service } = await fixture(t);
  const item = await seedTopic(service);
  for (const bad of ['2026-02-30', '2026-04-31']) {
    await assert.rejects(
      service.mutate(metaWrite(`bad-cal-${bad}`, item, { updated: bad })),
      code('INVALID_INPUT'),
      `updated="${bad}" 是不存在的日历日期，不应落盘`,
    );
  }
  await service.mutate(metaWrite('ok-cal', item, { updated: '2026-11-07' }));
  assert.equal((await service.readTopic('plans')).updated, '2026-11-07');
});
