// 提交语义：CAS、幂等重放、payload 冲突、policy 预算闸门、结果与校验。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { createFileStore } from '../../src/storage/index.mjs';
import {
  sha256, stubRenderL1, stubEvaluateMutation, TEST_CONFIG, topicRawText,
  makeTmpRoot, putCore, topicObject,
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

describe('commit 基本流程与幂等', () => {
  it('提交返回结果形状，文件落盘，generation 前进', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const result = await store.commit({
      operationId: 'op-1', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: '铁律 v1\n' }],
    });
    assert.equal(result.operationId, 'op-1');
    assert.equal(result.generation, 1);
    assert.equal(result.changes[0].kind, 'core');
    assert.equal(result.changes[0].beforeRevision, null);
    assert.equal(result.changes[0].afterRevision, sha256(Buffer.from('铁律 v1\n', 'utf8')));
    assert.ok(result.budget && typeof result.budget.allowed === 'boolean');
    assert.equal((await store.readCore()).text, '铁律 v1\n');
    assert.equal((await store.snapshot()).generation, 1);

    const raw = await fsp.readFile(path.join(root, 'scopes', 'amber', 'core.md'), 'utf8');
    assert.equal(raw, '铁律 v1\n');
  });

  it('同 operationId + 同 payload 重放幂等（返回同一结果，不再递增 generation）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const call = () => ({
      operationId: 'op-x', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: '只有一次\n' }],
    });
    const first = await store.commit(call());
    const replay = await store.commit(call());
    assert.equal(replay.generation, first.generation);
    assert.equal(replay.operationId, first.operationId);
    assert.equal((await store.snapshot()).generation, 1);
    assert.equal((await store.readCore()).text, '只有一次\n');
  });

  it('同 operationId + 不同 payload → REVISION_CONFLICT', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await store.commit({
      operationId: 'op-y', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'A\n' }],
    });
    await assert.rejects(() => store.commit({
      operationId: 'op-y', expectedGeneration: 1,
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('A\n')), text: 'B\n' }],
    }), (err) => err.code === 'REVISION_CONFLICT');
    assert.equal((await store.readCore()).text, 'A\n');
  });
});

describe('CAS（expectedRevision / expectedGeneration）', () => {
  async function seeded(t) {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const r = await store.commit({
      operationId: 'seed', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'seed\n' }],
    });
    return { root, store, rev: r.changes[0].afterRevision };
  }

  it('哈希不匹配 → REVISION_CONFLICT，文件不变', async (t) => {
    const { store, rev } = await seeded(t);
    await assert.rejects(() => store.commit({
      operationId: 'bad-cas', expectedGeneration: 1,
      changes: [{ kind: 'core', expectedRevision: '0'.repeat(64), text: '篡改\n' }],
    }), (err) => err.code === 'REVISION_CONFLICT');
    assert.equal((await store.readCore()).text, 'seed\n');
    assert.notEqual(rev, '0'.repeat(64));
  });

  it('已有文件必须提供哈希（null 拒绝）；缺失文件必须 null（非 null 拒绝）', async (t) => {
    const { store } = await seeded(t);
    await assert.rejects(() => store.commit({
      operationId: 'null-on-existing',
      changes: [{ kind: 'core', expectedRevision: null, text: 'x\n' }],
    }), (err) => err.code === 'REVISION_CONFLICT');

    await assert.rejects(() => store.commit({
      operationId: 'hash-on-missing',
      changes: [{ kind: 'topic', key: 'new-one', expectedRevision: '0'.repeat(64), topic: topicObject() }],
    }), (err) => err.code === 'REVISION_CONFLICT');
    await assert.rejects(() => store.readTopic('new-one'), (err) => err.code === 'NOT_FOUND');
  });

  it('expectedRevision 未显式提供 → INVALID_INPUT（不静默放行）', async (t) => {
    const { store } = await seeded(t);
    await assert.rejects(() => store.commit({
      operationId: 'no-exp',
      changes: [{ kind: 'core', text: 'x\n' }],
    }), (err) => err.code === 'INVALID_INPUT');
  });

  it('expectedGeneration 不一致 → REVISION_CONFLICT', async (t) => {
    const { store } = await seeded(t); // 当前 generation=1
    await assert.rejects(() => store.commit({
      operationId: 'bad-gen', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('seed\n')), text: 'y\n' }],
    }), (err) => err.code === 'REVISION_CONFLICT');
    assert.equal((await store.readCore()).text, 'seed\n');
  });

  it('正确 CAS 提交成功', async (t) => {
    const { store, rev } = await seeded(t);
    const r = await store.commit({
      operationId: 'good-cas', expectedGeneration: 1,
      changes: [{ kind: 'core', expectedRevision: rev, text: '更新\n' }],
    });
    assert.equal(r.generation, 2);
    assert.equal(r.changes[0].beforeRevision, rev);
  });
});

describe('预算策略（policy 注入）', () => {
  it('policy 拒绝 → BUDGET_REJECTED，磁盘不变、generation 不变、无残留 journal', async (t) => {
    const root = await makeTmpRoot(t);
    // 用 custom policy：一律拒绝
    const store = await createFileStore(opts({
      root,
      policy: () => ({ allowed: false, reason: '测试拒绝', currentChars: 1, candidateChars: 2 }),
    }));
    await putCore(root, 'amber', '原铁律\n');
    await assert.rejects(() => store.commit({
      operationId: 'rejected',
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('原铁律\n')), text: '新铁律\n' }],
    }), (err) => {
      assert.equal(err.code, 'BUDGET_REJECTED');
      assert.equal(err.details.budget.reason, '测试拒绝');
      return true;
    });
    assert.equal((await store.readCore()).text, '原铁律\n');
    assert.equal((await store.snapshot()).generation, 0);
    const journals = await fsp.readdir(path.join(root, 'journal'));
    assert.deepEqual(journals, []); // 拒绝发生在持久化之前
  });

  it('policy 收到完整可见快照渲染文本（含索引，不只 core 正文）', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'amber', 'a'.repeat(8990));
    const dirA = path.join(root, 'scopes', 'amber', 'topics');
    await fsp.mkdir(dirA, { recursive: true });
    await fsp.writeFile(path.join(dirA, 'old-topic.md'), Buffer.from(
      topicRawText({ key: 'old-topic', scopeId: 'amber', summary: '已'.repeat(40), body: 'x' }), 'utf8',
    ));

    const calls = [];
    const recordingPolicy = (input) => {
      calls.push(input);
      return stubEvaluateMutation(input);
    };
    const store = await createFileStore(opts({ root, policy: recordingPolicy }));
    await assert.rejects(() => store.commit({
      operationId: 'grow-index',
      changes: [{ kind: 'topic', key: 'new-topic', expectedRevision: null, topic: topicObject({ summary: '新'.repeat(40) }) }],
    }), (err) => err.code === 'BUDGET_REJECTED');

    // currentText 必须包含索引头与旧行：8990(core) + 2(LF LF) + 索引整体
    assert.equal(calls.length, 1);
    const current = calls[0].currentText;
    assert.ok(current.startsWith('a'.repeat(100)));
    assert.ok(current.includes('## 主题记忆索引 / Topic memory index'));
    assert.ok(current.includes('- old-topic [amber] —'));
    // 若只量 core 正文（8990 < 9000）就不会走拒绝分支——这里被拒说明索引计入水位
    assert.ok(calls[0].currentText.length >= 9000);
    assert.ok(calls[0].candidateText.length > calls[0].currentText.length);
  });

  it('首次跨入增长闸门（候选 ≤ 硬顶）允许提交', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'amber', 'a'.repeat(8800));
    const store = await createFileStore(opts({ root }));
    const r = await store.commit({
      operationId: 'crossing',
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('a'.repeat(8800), 'utf8')), text: 'a'.repeat(9050) }],
    });
    assert.equal(r.generation, 1);
    assert.equal(r.budget.level, 'crossing');
  });

  it('候选超过绝对硬顶 → 拒绝', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.commit({
      operationId: 'over-cap',
      changes: [{ kind: 'core', expectedRevision: null, text: 'a'.repeat(10001) }],
    }), (err) => err.code === 'BUDGET_REJECTED');
  });

  it('超限后净减少允许修复（repair 放行）', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'amber', 'a'.repeat(10500));
    const store = await createFileStore(opts({ root }));
    const r = await store.commit({
      operationId: 'repair',
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('a'.repeat(10500), 'utf8')), text: 'a'.repeat(10300) }],
    });
    assert.equal(r.budget.allowed, true);
    assert.equal(r.budget.level, 'repair');
  });

  it('renderL1/policy 注入异常向上传播，磁盘不变', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({
      root,
      policy: () => { throw new Error('policy boom'); },
    }));
    await assert.rejects(() => store.commit({
      operationId: 'boom',
      changes: [{ kind: 'core', expectedRevision: null, text: 'x\n' }],
    }), /policy boom/);
    assert.equal((await store.snapshot()).generation, 0);
  });
});

describe('topic 提交细节', () => {
  it('结构化 topic：写入严格 front-matter，body 逐字保留（含 CRLF 与 unicode）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const body = '第一行\r\n第二行 emoji 🔥 tail\n';
    await store.commit({
      operationId: 't1', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'alpha', expectedRevision: null, topic: topicObject({ body }) }],
    });
    const topic = await store.readTopic('alpha');
    assert.equal(topic.body, body);
    assert.equal(topic.scopeId, 'amber');
    assert.equal(topic.title, '示例专题');
    const fileOnDisk = await fsp.readFile(path.join(root, 'scopes', 'amber', 'topics', 'alpha.md'), 'utf8');
    assert.ok(fileOnDisk.startsWith('---\nkey: "alpha"\n'));
    assert.ok(fileOnDisk.endsWith(body));
  });

  it('裸 text topic：校验严格格式后原样落盘', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const raw = [
      '---',
      'key: "beta"',
      'title: "裸文本"',
      'summary: "ok"',
      'updated: "2026-10-24T00:00:00.000Z"',
      'scopeId: "amber"',
      '---',
      '',
      'raw 正文',
    ].join('\n');
    await store.commit({
      operationId: 't2', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'beta', expectedRevision: null, text: raw }],
    });
    const topic = await store.readTopic('beta');
    assert.equal(topic.title, '裸文本');
    const onDisk = await fsp.readFile(path.join(root, 'scopes', 'amber', 'topics', 'beta.md'), 'utf8');
    assert.equal(onDisk, raw);
  });

  it('裸 text topic 的 scopeId 指向其他 scope：拒绝且磁盘与 generation 不变', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root, activeScopeId: 'amber' }));
    const raw = [
      '---',
      'key: "mis-scoped"',
      'title: "错 scope"',
      'summary: "ok"',
      'updated: "2026-10-24T00:00:00.000Z"',
      'scopeId: "global"',
      '---',
      '',
      'raw 正文',
    ].join('\n');
    await assert.rejects(() => store.commit({
      operationId: 'mis-scoped', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'mis-scoped', expectedRevision: null, text: raw }],
    }), (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.equal(err.details.metaScopeId, 'global');
      return true;
    });
    // 磁盘无文件、generation 不变
    assert.equal(await fsp.access(path.join(root, 'scopes', 'amber', 'topics', 'mis-scoped.md'))
      .then(() => true, () => false), false);
    assert.equal((await store.snapshot()).generation, 0);
    // 修正 scopeId 后同一内容可提交
    const fixed = raw.replace('scopeId: "global"', 'scopeId: "amber"');
    await store.commit({
      operationId: 'mis-scoped-fixed', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'mis-scoped', expectedRevision: null, text: fixed }],
    });
    assert.equal((await store.readTopic('mis-scoped')).scopeId, 'amber');
  });

  it('summary 超 60 UTF16 拒绝；scopeId 指向其他 scope 拒绝；key 不一致拒绝', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.commit({
      operationId: 'long-summary', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'gamma', expectedRevision: null, topic: topicObject({ summary: '长'.repeat(61) }) }],
    }), (err) => err.code === 'INVALID_INPUT');
    await assert.rejects(() => store.commit({
      operationId: 'wrong-scope', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'gamma', expectedRevision: null, topic: topicObject({ scopeId: 'sage' }) }],
    }), (err) => err.code === 'INVALID_INPUT');
    await assert.rejects(() => store.commit({
      operationId: 'wrong-key', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'gamma', expectedRevision: null, topic: { ...topicObject(), key: 'delta' } }],
    }), (err) => err.code === 'INVALID_INPUT');
  });

  it('同批重复目标、多 core、空 changes、非法 kind、payload scopeId 全部 INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const topicChange = { kind: 'topic', key: 'dup', expectedRevision: null, topic: topicObject() };
    await assert.rejects(() => store.commit({
      operationId: 'dup-targets', expectedGeneration: 0,
      changes: [topicChange, { ...topicChange }],
    }), (err) => err.code === 'INVALID_INPUT');
    await assert.rejects(() => store.commit({
      operationId: 'two-cores', expectedGeneration: 0,
      changes: [
        { kind: 'core', expectedRevision: null, text: 'a' },
        { kind: 'core', expectedRevision: null, text: 'b' },
      ],
    }), (err) => err.code === 'INVALID_INPUT');
    await assert.rejects(() => store.commit({ operationId: 'empty', expectedGeneration: 0, changes: [] }),
      (err) => err.code === 'INVALID_INPUT');
    await assert.rejects(() => store.commit({
      operationId: 'bad-kind', expectedGeneration: 0,
      changes: [{ kind: 'spark', expectedRevision: null }],
    }), (err) => err.code === 'INVALID_INPUT');
    await assert.rejects(() => store.commit({
      operationId: 'scope-in-payload', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'a', scopeId: 'sage' }],
    }), (err) => err.code === 'INVALID_INPUT');
  });

  it('active core 缺失但 global 存在：写 active 需 expectedRevision=null，policy 按可见快照评估', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'global', 'global 视角\n');
    const store = await createFileStore(opts({ root, activeScopeId: 'amber' }));
    const r = await store.commit({
      operationId: 'first-active-write', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'active 落盘\n' }],
    });
    assert.equal(r.generation, 1);
    assert.equal((await store.readCore()).text, 'active 落盘\n');
    // global 原文件不动
    assert.equal(await fsp.readFile(path.join(root, 'scopes', 'global', 'core.md'), 'utf8'), 'global 视角\n');
  });
});
