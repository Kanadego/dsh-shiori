// 路径与命名防线：key/scopeId/operationId 校验、大小写碰撞、junction 越界。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  validateKey, validateScopeId, validateOperationId, assertNoCaseCollision,
} from '../../src/storage/paths.mjs';
import { createFileStore } from '../../src/storage/index.mjs';
import {
  stubRenderL1, stubEvaluateMutation, TEST_CONFIG, makeTmpRoot, topicObject,
} from './helpers.mjs';

describe('validateKey / validateScopeId / validateOperationId', () => {
  // 与 A.keys.mjs 对齐：Unicode 合法、内部空格合法、128 UTF16 上限（R9）
  const okKeys = ['abc', 'a1', 'a-b_c', 'topic-2026', '0abc', 'Abc', '-abc', '_abc',
    'a b', '中文专题', 'a'.repeat(128), 'v1.2', 'x.con'];
  for (const k of okKeys) {
    it(`接受 ${JSON.stringify(k.length > 20 ? `(len ${k.length})` : k)}`, () => {
      assert.equal(validateKey(k), k);
    });
  }

  const badKeys = [
    '', ' a', 'a ', 'a'.repeat(129),
    'a/b', 'a\\b', '..', '.', '...', 'C:foo', 'C:\\x', 'foo:bar',
    'abc.', 'con', 'CON', 'nul', 'com1', 'lpt9', 'con.md', 'aux.md.x',
    'core', 'CORE.md', 'tab\tx', 'a<b>', 'a|b', 'a?b', 'a*b',
    'a\uD800b', '\uDC00', '\u007f', 'a\u0080b',
  ];
  for (const k of badKeys) {
    it(`拒绝 ${JSON.stringify(k)}`, () => {
      assert.throws(() => validateKey(k), (e) => e.code === 'INVALID_INPUT');
    });
  }

  it('scopeId 允许 global 与合法名；大小写别名/路径注入/保留名拒绝', () => {
    assert.equal(validateScopeId('global'), 'global');
    assert.equal(validateScopeId('amber'), 'amber');
    assert.equal(validateScopeId('中文卡'), '中文卡');
    assert.throws(() => validateScopeId('Global'), (e) => e.code === 'INVALID_INPUT'); // 与 global 大小写互斥
    assert.throws(() => validateScopeId('GLOBAL'), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => validateScopeId('../x'), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => validateScopeId('a/b'), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => validateScopeId('com1'), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => validateScopeId('a.'), (e) => e.code === 'INVALID_INPUT');
  });

  it('operationId 允许字母数字点下划线连字符，拒绝分隔符与保留名', () => {
    assert.equal(validateOperationId('op-1.2_x'), 'op-1.2_x');
    assert.throws(() => validateOperationId('a/b'), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => validateOperationId('com1'), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => validateOperationId(''), (e) => e.code === 'INVALID_INPUT');
  });
});

describe('大小写碰撞（Windows 文件系统语义）', () => {
  it('目录内已存在 abc.md 时拒绝创建 ABC.md', async (t) => {
    const root = await makeTmpRoot(t);
    const dir = path.join(root, 'scopes', 'amber', 'topics');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'abc.md'), 'x');
    await assert.rejects(() => assertNoCaseCollision(dir, 'ABC.md'), (e) => e.code === 'INVALID_INPUT');
    // 精确同名不报
    await assert.doesNotReject(() => assertNoCaseCollision(dir, 'abc.md'));
  });

  it('store 提交 ABC 时因已有 abc.md 拒绝，原文件不被覆盖', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore({
      root, activeScopeId: 'amber', policy: stubEvaluateMutation,
      renderL1: stubRenderL1, config: TEST_CONFIG,
    });
    await store.commit({
      operationId: 'lower', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'abc', expectedRevision: null, topic: topicObject({ title: '小写', body: 'v1' }) }],
    });
    await assert.rejects(() => store.commit({
      operationId: 'upper', expectedGeneration: 1,
      changes: [{ kind: 'topic', key: 'ABC', expectedRevision: null, topic: topicObject({ title: '大写', body: 'v2' }) }],
    }), (e) => e.code === 'INVALID_INPUT');
    const onDisk = await fsp.readFile(path.join(root, 'scopes', 'amber', 'topics', 'abc.md'), 'utf8');
    assert.ok(onDisk.includes('小写'));
  });
});

describe('symlink / junction 越界拒绝', () => {
  it('topics 目录被替换为指向 root 外的 junction → 读写显式拒绝，不越根写盘', async (t) => {
    const root = await makeTmpRoot(t);
    const outside = await fsp.mkdtemp(path.join(path.dirname(root), 'shiori-outside-'));
    t.after(() => fsp.rm(outside, { recursive: true, force: true }).catch(() => {}));

    const store = await createFileStore({
      root, activeScopeId: 'amber', policy: stubEvaluateMutation,
      renderL1: stubRenderL1, config: TEST_CONFIG,
    });
    const topicsDir = path.join(root, 'scopes', 'amber', 'topics');
    await fsp.rm(topicsDir, { recursive: true, force: true });
    await fsp.symlink(outside, topicsDir, 'junction');

    await assert.rejects(() => store.listTopics(), (e) => e.code === 'INVALID_INPUT');
    await assert.rejects(() => store.commit({
      operationId: 'escape', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'evil', expectedRevision: null, topic: topicObject() }],
    }), (e) => e.code === 'INVALID_INPUT');

    // 越界目录没有被写入
    const outsideEntries = await fsp.readdir(outside);
    assert.deepEqual(outsideEntries, []);
  });

  it('根内 junction（解析后仍在 root 内）可用', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore({
      root, activeScopeId: 'amber', policy: stubEvaluateMutation,
      renderL1: stubRenderL1, config: TEST_CONFIG,
    });
    // amber/topics 链接到 root 内的 shared-topics 目录（解析后仍在授权根内）
    const sharedDir = path.join(root, 'shared-topics');
    const amberTopics = path.join(root, 'scopes', 'amber', 'topics');
    await fsp.mkdir(sharedDir, { recursive: true });
    const raw = [
      '---',
      'key: "in-root"',
      'title: "根内"',
      'summary: "经junction可见"',
      'updated: "2026-10-24T00:00:00.000Z"',
      'scopeId: "amber"',
      '---',
      '',
      'body',
    ].join('\n');
    await fsp.writeFile(path.join(sharedDir, 'in-root.md'), raw, 'utf8');
    await fsp.rm(amberTopics, { recursive: true, force: true });
    await fsp.symlink(sharedDir, amberTopics, 'junction');

    const topics = await store.listTopics();
    assert.deepEqual(topics.map((x) => x.key), ['in-root']);
    assert.equal(topics[0].summary, '经junction可见');
  });
});
