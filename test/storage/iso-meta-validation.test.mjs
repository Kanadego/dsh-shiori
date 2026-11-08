// A1/A2/A6（P2-1/P2-2/P2-6）storage 层：
// - A1：store 写入侧拒绝非规范 ISO 的 archivedAt / updated；
// - A2：读路径对手改的 archivedAt 垃圾串按「未归档」降级，不照收成 archived；
// - A6：readJournal 损坏包装为 StorageError（INVALID_STATE），不再是裸 Error。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { createFileStore, StorageError } from '../../src/storage/index.mjs';
import { readJournal } from '../../src/storage/journal.mjs';
import { sha256, makeTmpRoot, makeStoreOptions, topicObject, topicRawText } from './helpers.mjs';

function putTopic(root, scopeId, key, text) {
  return fsp.writeFile(path.join(root, 'scopes', scopeId, 'topics', `${key}.md`), Buffer.from(text, 'utf8'));
}

describe('A1 storage 写入侧规范 ISO 校验', () => {
  it('store.commit 拒绝宽松日期串的 archivedAt（P2-1 盲区值）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(makeStoreOptions({ root }));
    for (const bad of ['March 5, 2026', '2026', 'Feb 30, 2026']) {
      await assert.rejects(
        store.commit({
          operationId: `bad-arch-${bad}`,
          changes: [{ kind: 'topic', key: 'plan-a', expectedRevision: null,
            topic: { ...topicObject(), key: 'plan-a', archivedAt: bad } }],
        }),
        (err) => err.code === 'INVALID_INPUT',
        `archivedAt="${bad}" 不应被 Date.parse 宽松口径放行`,
      );
    }
    // 磁盘零残留：拒绝路径不得落盘任何 topic
    const listed = await store.listTopics();
    assert.equal(listed.length, 0);
  });

  it('store.commit 拒绝非 ISO 的 updated（P2-3：与 archivedAt 同强度）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(makeStoreOptions({ root }));
    for (const bad of ['garbage-not-a-date', 'March 5, 2026']) {
      await assert.rejects(
        store.commit({
          operationId: `bad-upd-${bad}`,
          changes: [{ kind: 'topic', key: 'plan-a', expectedRevision: null,
            topic: { ...topicObject(), key: 'plan-a', updated: bad } }],
        }),
        (err) => err.code === 'INVALID_INPUT',
        `updated="${bad}" 不应落盘`,
      );
    }
  });

  it('store.commit updated date-only 日历回环：2026-02-30 / 2026-04-31 拒绝，2026-11-07 仍放行', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(makeStoreOptions({ root }));
    for (const bad of ['2026-02-30', '2026-04-31']) {
      await assert.rejects(
        store.commit({
          operationId: `bad-cal-${bad}`,
          changes: [{ kind: 'topic', key: 'plan-a', expectedRevision: null,
            topic: { ...topicObject(), key: 'plan-a', updated: bad } }],
        }),
        (err) => err.code === 'INVALID_INPUT',
        `updated="${bad}" 是不存在的日历日期，不应落盘`,
      );
    }
    await store.commit({
      operationId: 'ok-cal',
      changes: [{ kind: 'topic', key: 'plan-a', expectedRevision: null,
        topic: { ...topicObject(), key: 'plan-a', updated: '2026-11-07' } }],
    });
    const listed = await store.listTopics();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].updated, '2026-11-07');
  });

  it('裸 text 写入路径同样拒绝非规范 ISO 的 archivedAt / updated', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(makeStoreOptions({ root }));
    const withArch = topicRawText({ key: 'plan-a', scopeId: 'amber', updated: '2026-10-24T00:00:00.000Z' })
      .replace('\n---\n', '\narchivedAt: "March 5, 2026"\n---\n');
    await assert.rejects(
      store.commit({ operationId: 'raw-bad-arch', changes: [{ kind: 'topic', key: 'plan-a', expectedRevision: null, text: withArch }] }),
      (err) => err.code === 'INVALID_INPUT',
    );
    const badUpd = topicRawText({ key: 'plan-b', scopeId: 'amber', updated: 'March 5, 2026' });
    await assert.rejects(
      store.commit({ operationId: 'raw-bad-upd', changes: [{ kind: 'topic', key: 'plan-b', expectedRevision: null, text: badUpd }] }),
      (err) => err.code === 'INVALID_INPUT',
    );
  });
});

describe('A2 读路径 archivedAt 垃圾串降级', () => {
  it('手改 archivedAt 垃圾串：readTopic 按未归档处理，listTopics 不标记 archived', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(makeStoreOptions({ root }));
    await putTopic(root, 'amber', 'plan-a', topicRawText({
      key: 'plan-a', scopeId: 'amber',
      updated: '2026-10-24T00:00:00.000Z',
      body: '正文',
    }).replace('\n---\n正文', '\narchivedAt: "totally-garbage"\n---\n正文'));

    const item = await store.readTopic('plan-a');
    assert.equal(item.archivedAt, undefined, '垃圾 archivedAt 必须降级为未归档（字段省略）');

    const listed = await store.listTopics();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].archivedAt, undefined);
  });

  it('手改宽松可解析串（如 "2026"）同样降级，不只拒绝全不可解析值', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(makeStoreOptions({ root }));
    await putTopic(root, 'amber', 'plan-a', topicRawText({
      key: 'plan-a', scopeId: 'amber',
      updated: '2026-10-24T00:00:00.000Z',
      body: '正文',
    }).replace('\n---\n正文', '\narchivedAt: "2026"\n---\n正文'));
    const item = await store.readTopic('plan-a');
    assert.equal(item.archivedAt, undefined);
  });

  it('规范 ISO 的 archivedAt 读路径不受影响，仍标记归档', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(makeStoreOptions({ root }));
    await putTopic(root, 'amber', 'plan-a', topicRawText({
      key: 'plan-a', scopeId: 'amber',
      updated: '2026-10-24T00:00:00.000Z',
      body: '正文',
    }).replace('\n---\n正文', '\narchivedAt: "2026-11-07T00:00:00.000Z"\n---\n正文'));
    const item = await store.readTopic('plan-a');
    assert.equal(item.archivedAt, '2026-11-07T00:00:00.000Z');
    const listed = await store.listTopics();
    assert.equal(listed[0].archivedAt, '2026-11-07T00:00:00.000Z');
  });
});

describe('A6 readJournal 损坏包装错误形状', () => {
  it('损坏 journal 抛 StorageError（INVALID_STATE）且保留 cause，不再是裸 Error', async (t) => {
    const root = await makeTmpRoot(t);
    const journalDir = path.join(root, 'journal');
    await fsp.mkdir(journalDir, { recursive: true });
    await fsp.writeFile(path.join(journalDir, 'broken-op.json'), Buffer.from('{broken json', 'utf8'));
    await assert.rejects(
      readJournal(root, 'broken-op'),
      (err) => {
        assert.ok(err instanceof StorageError, '必须是 StorageError 实例');
        assert.equal(err.name, 'StorageError');
        assert.equal(err.code, 'INVALID_STATE');
        assert.ok(err.cause instanceof SyntaxError, '原始 JSON 解析错误必须保留在 cause');
        return true;
      },
    );
  });

  it('缺失 journal 仍返回 null，非解析类读取失败按 IO_ERROR 归口', async (t) => {
    const root = await makeTmpRoot(t);
    await fsp.mkdir(path.join(root, 'journal'), { recursive: true });
    assert.equal(await readJournal(root, 'absent-op'), null);

    // 用一个「journal 路径上是目录」的夹具制造非 ENOENT 读取失败（EISDIR）
    await fsp.mkdir(path.join(root, 'journal', 'dir-op.json'), { recursive: true });
    await assert.rejects(
      readJournal(root, 'dir-op'),
      (err) => {
        assert.equal(err.code, 'IO_ERROR');
        assert.ok(err instanceof StorageError);
        return true;
      },
    );
  });
});
