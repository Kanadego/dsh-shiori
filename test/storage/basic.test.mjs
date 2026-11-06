// 基础读取语义：fallback、去重、两卡同 key 不串、revision 哈希、legacy 报错、archivedAt。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { createFileStore } from '../../src/storage/index.mjs';
import {
  sha256, stubRenderL1, stubEvaluateMutation, TEST_CONFIG,
  makeTmpRoot, putCore, topicObject, topicRawText,
} from './helpers.mjs';

function opts(overrides = {}) {
  return {
    root: overrides.root,
    activeScopeId: overrides.activeScopeId ?? 'amber',
    policy: stubEvaluateMutation,
    renderL1: stubRenderL1,
    config: TEST_CONFIG,
    ...overrides,
  };
}

describe('readCore fallback 语义', () => {
  it('active 缺失才 fallback global，scopeId 标明来源', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'global', 'global-铁律\n');
    const store = await createFileStore(opts({ root }));
    const core = await store.readCore();
    assert.equal(core.text, 'global-铁律\n');
    assert.equal(core.scopeId, 'global');
    assert.equal(core.revision, sha256(Buffer.from('global-铁律\n', 'utf8')));
  });

  it('active core 存在但为空文件：不触发 fallback', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'global', 'global-铁律\n');
    await putCore(root, 'amber', '');
    const store = await createFileStore(opts({ root }));
    const core = await store.readCore();
    assert.equal(core.text, '');
    assert.equal(core.scopeId, 'amber');
    assert.equal(core.revision, sha256(Buffer.from('', 'utf8')));
  });

  it('active core 有内容：优先于 global', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'global', 'global\n');
    await putCore(root, 'amber', 'amber\n');
    const store = await createFileStore(opts({ root }));
    const core = await store.readCore();
    assert.equal(core.text, 'amber\n');
    assert.equal(core.scopeId, 'amber');
  });

  it('两侧都不存在：空文本 + null revision', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const core = await store.readCore();
    assert.deepEqual({ text: core.text, revision: core.revision }, { text: '', revision: null });
  });
});

describe('listTopics 可见性与去重', () => {
  it('同 key active 覆盖 global，按 key 稳定排序，带 body 与文件哈希 revision', async (t) => {
    const root = await makeTmpRoot(t);
    const dirG = path.join(root, 'scopes', 'global', 'topics');
    const dirA = path.join(root, 'scopes', 'amber', 'topics');
    await fsp.mkdir(dirG, { recursive: true });
    await fsp.mkdir(dirA, { recursive: true });

    const rawZ = topicRawText({ key: 'zzz', scopeId: 'global', title: 'G版', summary: '全局版', body: 'G-body' });
    const rawM = topicRawText({ key: 'mid', scopeId: 'global', title: 'M', summary: '仅全局', body: 'M-body' });
    const rawZActive = topicRawText({ key: 'zzz', scopeId: 'amber', title: 'A版', summary: '私有版', body: 'A-body' });
    await fsp.writeFile(path.join(dirG, 'zzz.md'), Buffer.from(rawZ, 'utf8'));
    await fsp.writeFile(path.join(dirG, 'mid.md'), Buffer.from(rawM, 'utf8'));
    await fsp.writeFile(path.join(dirA, 'zzz.md'), Buffer.from(rawZActive, 'utf8'));

    const store = await createFileStore(opts({ root }));
    const topics = await store.listTopics();
    assert.deepEqual(topics.map((x) => x.key), ['mid', 'zzz']); // 稳定 key 排序
    const zzz = topics.find((x) => x.key === 'zzz');
    assert.equal(zzz.scopeId, 'amber'); // active 优先
    assert.equal(zzz.title, 'A版');
    assert.equal(zzz.body, 'A-body');
    assert.equal(zzz.revision, sha256(Buffer.from(rawZActive, 'utf8')));
    const mid = topics.find((x) => x.key === 'mid');
    assert.equal(mid.scopeId, 'global');
  });

  it('两卡同 key 不串：两个不同 active scope 的 store 互不可见对方私有 topic', async (t) => {
    const root = await makeTmpRoot(t);
    const storeA = await createFileStore(opts({ root, activeScopeId: 'amber' }));
    const storeS = await createFileStore(opts({ root, activeScopeId: 'sage' }));

    await storeA.commit({
      operationId: 'op-a-1', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'shared-key', expectedRevision: null, topic: topicObject({ title: '示例版', summary: '示例私有', body: 'amber-secret' }) }],
    });
    // generation 是 per-root 的提交代号：storeS 需按当前代做 CAS
    const gen = (await storeS.snapshot()).generation;
    await storeS.commit({
      operationId: 'op-s-1', expectedGeneration: gen,
      changes: [{ kind: 'topic', key: 'shared-key', expectedRevision: null, topic: topicObject({ title: '鼠尾草版', summary: '另一卡', body: 'sage-secret' }) }],
    });

    const a = await storeA.readTopic('shared-key');
    const s = await storeS.readTopic('shared-key');
    assert.equal(a.body, 'amber-secret');
    assert.equal(a.scopeId, 'amber');
    assert.equal(s.body, 'sage-secret');
    assert.equal(s.scopeId, 'sage');
    assert.notEqual(a.revision, s.revision);
    // 各自列表只有自己那份
    assert.deepEqual((await storeA.listTopics()).map((x) => x.key), ['shared-key']);
    assert.equal((await storeS.listTopics())[0].title, '鼠尾草版');
  });

  it('core 提交只写 active scope，不覆盖 global', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'global', 'global-不动\n');
    const store = await createFileStore(opts({ root, activeScopeId: 'amber' }));
    await store.commit({
      operationId: 'op-c1', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'amber 新铁律\n' }],
    });
    const globalRaw = await fsp.readFile(path.join(root, 'scopes', 'global', 'core.md'), 'utf8');
    assert.equal(globalRaw, 'global-不动\n');
    assert.equal((await store.readCore()).text, 'amber 新铁律\n');
    assert.equal((await store.readCore()).scopeId, 'amber');
  });
});

describe('readTopic', () => {
  it('active 优先，global 兜底，不存在抛 NOT_FOUND，非法 key 抛 INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    const dirG = path.join(root, 'scopes', 'global', 'topics');
    await fsp.mkdir(dirG, { recursive: true });
    const raw = topicRawText({ key: 'only-global', scopeId: 'global', body: 'CRLF\r\n正文' });
    await fsp.writeFile(path.join(dirG, 'only-global.md'), Buffer.from(raw, 'utf8'));

    const store = await createFileStore(opts({ root }));
    const topic = await store.readTopic('only-global');
    assert.equal(topic.scopeId, 'global');
    assert.equal(topic.body, 'CRLF\r\n正文'); // body 逐字保留

    await assert.rejects(() => store.readTopic('nope'), (err) => err.code === 'NOT_FOUND');
    await assert.rejects(() => store.readTopic('../escape'), (err) => err.code === 'INVALID_INPUT');
  });

  it('非法 front-matter 的文件显式报 INVALID_STATE，不静默', async (t) => {
    const root = await makeTmpRoot(t);
    const dirA = path.join(root, 'scopes', 'amber', 'topics');
    await fsp.mkdir(dirA, { recursive: true });
    await fsp.writeFile(path.join(dirA, 'broken.md'), Buffer.from('---\nkey: "broken"\ntitle: [block\n---\n正文', 'utf8'));
    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.readTopic('broken'), (err) => err.code === 'INVALID_STATE');
    // 列表不中断，但记录影子问题
    assert.deepEqual(await store.listTopics(), []);
    const report = await store.legacyReport();
    assert.ok(report.shadow.some((s) => s.file.endsWith('broken.md')));
  });
});

describe('legacy 裸 md 直接报错（不再只读兼容）', () => {
  it('readTopic 遇无 front-matter 文件抛 INVALID_STATE，错误带文件名与路径', async (t) => {
    const root = await makeTmpRoot(t);
    const dirG = path.join(root, 'scopes', 'global', 'topics');
    await fsp.mkdir(dirG, { recursive: true });
    const legacyBody = '# 旧专题\n\n第一段摘要行\n\n正文内容';
    const file = path.join(dirG, 'legacy-topic.md');
    await fsp.writeFile(file, Buffer.from(legacyBody, 'utf8'));

    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.readTopic('legacy-topic'), (err) => {
      assert.equal(err.code, 'INVALID_STATE');
      assert.ok(err.message.includes('legacy-topic.md'), '错误信息含文件名');
      assert.ok(err.message.includes(file.replace(/\\/g, '/')) || err.message.includes(file), '错误信息含路径');
      assert.ok(err.message.includes('缺少 front-matter'), '错误信息说明缺 front-matter');
      assert.ok(err.message.includes('非法数据'), '错误信息说明属非法数据');
      return true;
    });
    // 原文件不动
    assert.equal(await fsp.readFile(file, 'utf8'), legacyBody);
  });

  it('列举路径（listTopics/snapshot/legacyReport）同样直接抛错，不静默跳过、不降级', async (t) => {
    const root = await makeTmpRoot(t);
    const dirG = path.join(root, 'scopes', 'global', 'topics');
    await fsp.mkdir(dirG, { recursive: true });
    await fsp.writeFile(path.join(dirG, 'long-legacy.md'), Buffer.from('# 长摘要旧专题\n\n正文', 'utf8'));

    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.listTopics(), (err) => err.code === 'INVALID_STATE' && err.message.includes('long-legacy.md'));
    await assert.rejects(() => store.snapshot(), (err) => err.code === 'INVALID_STATE');
    await assert.rejects(() => store.legacyReport(), (err) => err.code === 'INVALID_STATE');
    // 提交也被阻止（加载非法数据不能绕过）
    await assert.rejects(() => store.commit({
      operationId: 'blocked-by-legacy', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: '新铁律\n' }],
    }), (err) => err.code === 'INVALID_STATE');
  });
});

describe('archivedAt 归档标记（store 层）', () => {
  it('带 archivedAt 的 topic：readTopic/listTopics/snapshot 带出标记', async (t) => {
    const root = await makeTmpRoot(t);
    const dirA = path.join(root, 'scopes', 'amber', 'topics');
    await fsp.mkdir(dirA, { recursive: true });
    await fsp.writeFile(path.join(dirA, 'cold.md'), Buffer.from(topicRawText({
      key: 'cold', scopeId: 'amber', body: '冷专题正文',
    }).replace('---\n', '---\narchivedAt: "2026-11-07T00:00:00.000Z"\n'), 'utf8'));

    const store = await createFileStore(opts({ root }));
    const topic = await store.readTopic('cold');
    assert.equal(topic.archivedAt, '2026-11-07T00:00:00.000Z');
    assert.equal(topic.body, '冷专题正文');
    const topics = await store.listTopics();
    assert.equal(topics.length, 1);
    assert.equal(topics[0].archivedAt, '2026-11-07T00:00:00.000Z');
    const snap = await store.snapshot();
    assert.equal(snap.topics[0].archivedAt, '2026-11-07T00:00:00.000Z');
  });

  it('老文件没有 archivedAt 字段 = 未归档，行为不变', async (t) => {
    const root = await makeTmpRoot(t);
    const dirA = path.join(root, 'scopes', 'amber', 'topics');
    await fsp.mkdir(dirA, { recursive: true });
    await fsp.writeFile(path.join(dirA, 'warm.md'), Buffer.from(topicRawText({ key: 'warm', scopeId: 'amber' }), 'utf8'));

    const store = await createFileStore(opts({ root }));
    const topic = await store.readTopic('warm');
    assert.equal(topic.archivedAt, undefined);
    assert.ok(!('archivedAt' in topic), 'DTO 不携带 archivedAt 字段');
  });

  it('结构化写入：archivedAt 有值落盘、空串省略、非 ISO 拒绝', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await store.commit({
      operationId: 'archive-create', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'cold', expectedRevision: null,
        topic: { title: '冷', summary: '摘要', updated: '2026-11-07T00:00:00.000Z',
          archivedAt: '2026-11-07T12:00:00.000Z', body: '正文' } }],
    });
    const raw = await fsp.readFile(path.join(root, 'scopes', 'amber', 'topics', 'cold.md'), 'utf8');
    assert.match(raw, /^archivedAt: "2026-11-07T12:00:00\.000Z"$/m);
    assert.equal((await store.readTopic('cold')).archivedAt, '2026-11-07T12:00:00.000Z');

    // 空串 = 取消归档：序列化省略该行
    const snap = await store.snapshot();
    const rev = snap.topics[0].revision;
    await store.commit({
      operationId: 'unarchive', expectedGeneration: 1,
      changes: [{ kind: 'topic', key: 'cold', expectedRevision: rev,
        topic: { title: '冷', summary: '摘要', updated: '2026-11-07T01:00:00.000Z',
          archivedAt: '', body: '正文' } }],
    });
    const raw2 = await fsp.readFile(path.join(root, 'scopes', 'amber', 'topics', 'cold.md'), 'utf8');
    assert.doesNotMatch(raw2, /^archivedAt:/m);
    assert.equal((await store.readTopic('cold')).archivedAt, undefined);

    // 非 ISO 拒绝
    const currentRev = (await store.snapshot()).topics[0].revision;
    await assert.rejects(() => store.commit({
      operationId: 'bad-archive', expectedGeneration: 2,
      changes: [{ kind: 'topic', key: 'cold', expectedRevision: currentRev,
        topic: { title: '冷', summary: '摘要', updated: '2026-11-07T02:00:00.000Z',
          archivedAt: 'not-a-date', body: '正文' } }],
    }), (err) => err.code === 'INVALID_INPUT');
  });
});

describe('snapshot 与 diagnostics', () => {
  it('新 root generation=0；提交后 snapshot 反映完整已提交代', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const snap0 = await store.snapshot();
    assert.equal(snap0.generation, 0);
    assert.deepEqual(snap0.topics, []);

    await store.commit({
      operationId: 'op-1', expectedGeneration: 0,
      changes: [
        { kind: 'core', expectedRevision: null, text: 'core v1\n' },
        { kind: 'topic', key: 'alpha', expectedRevision: null, topic: topicObject({ body: 'A' }) },
      ],
    });
    const snap1 = await store.snapshot();
    assert.equal(snap1.generation, 1);
    assert.equal(snap1.core.text, 'core v1\n');
    assert.deepEqual(snap1.topics.map((x) => x.key), ['alpha']);
  });

  it('diagnostics 暴露 root/scope/generation', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const d = await store.diagnostics();
    assert.equal(path.normalize(d.root), path.normalize(root));
    assert.equal(d.activeScopeId, 'amber');
    assert.equal(d.generation, 0);
  });
});
