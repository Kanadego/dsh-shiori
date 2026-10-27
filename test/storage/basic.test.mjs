// 基础读取语义：fallback、去重、两卡同 key 不串、revision 哈希、legacy 兼容。

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

describe('legacy 旧 Markdown 只读兼容', () => {
  it('无 front-matter 文件可读（title/summary 推导），进影子报告，提交不改原文件', async (t) => {
    const root = await makeTmpRoot(t);
    const dirG = path.join(root, 'scopes', 'global', 'topics');
    await fsp.mkdir(dirG, { recursive: true });
    const legacyBody = '# 旧专题\n\n第一段摘要行\n\n正文内容';
    await fsp.writeFile(path.join(dirG, 'legacy-topic.md'), Buffer.from(legacyBody, 'utf8'));

    const store = await createFileStore(opts({ root }));
    const topic = await store.readTopic('legacy-topic');
    assert.equal(topic.title, '旧专题');
    assert.equal(topic.summary, '第一段摘要行');
    // R8：updated 用非空哨兵串，DTO 可直接通过真实 A 的 validateTopic
    assert.equal(topic.updated, 'legacy-unknown');
    assert.equal(topic.revision, sha256(Buffer.from(legacyBody, 'utf8')));

    const report = await store.legacyReport();
    assert.ok(report.legacy.some((l) => l.key === 'legacy-topic'));

    // 只读兼容：原文件逐字未动
    const after = await fsp.readFile(path.join(dirG, 'legacy-topic.md'), 'utf8');
    assert.equal(after, legacyBody);
  });

  it('旧文件推导摘要超 60：影子索引按规则截断，全文留在 body/legacySummaryFull，原文件不动', async (t) => {
    const root = await makeTmpRoot(t);
    const dirG = path.join(root, 'scopes', 'global', 'topics');
    await fsp.mkdir(dirG, { recursive: true });
    const longLine = '长'.repeat(80);
    const body = `# 长摘要旧专题\n\n${longLine}\n\n正文`;
    await fsp.writeFile(path.join(dirG, 'long-legacy.md'), Buffer.from(body, 'utf8'));

    const store = await createFileStore(opts({ root }));
    const topic = await store.readTopic('long-legacy');
    assert.equal(topic.summary.length, 60); // 影子索引按规则截断
    assert.equal(topic.legacySummaryFull, longLine); // 全文可追溯
    assert.equal(topic.body, body); // 正文未截断
    const report = await store.legacyReport();
    const entry = report.legacy.find((l) => l.key === 'long-legacy');
    assert.ok(entry.reason.includes('非无损迁移'));

    // 原文件逐字未动
    assert.equal(await fsp.readFile(path.join(dirG, 'long-legacy.md'), 'utf8'), body);
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
