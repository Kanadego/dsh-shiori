// 真实 A 模块集成回归（R8/R9 要求：不能仅用宽松 stub 声称接口等价）。
// 只读引用琥珀认可的 A 提交包 a2-b99d1031（渲染器/预算/配置/key 校验），
// 不修改旧封包；若该路径不存在，本文件会显式失败以暴露集成链断裂。
//
// 夹具全部为自建临时目录合成内容；不读写真实记忆，不联网。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const A_ENTRY = 'D:/AIagent/shiori/collab/submissions/A/a2-b99d1031-b081-4e52-8572-1d590c5d4021/files/src/core/index.mjs';
const A = await import(pathToFileURL(A_ENTRY).href);

import { createFileStore } from '../../src/storage/index.mjs';
import { makeTmpRoot, putCore } from './helpers.mjs';

function sha(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function opts(overrides = {}) {
  return {
    root: overrides.root,
    activeScopeId: overrides.activeScopeId ?? 'amber',
    policy: A.evaluateMutation,
    renderL1: A.renderL1,
    config: A.DEFAULT_CONFIG,
    ...overrides,
  };
}

describe('真实 A.renderL1 / A.evaluateMutation / A.DEFAULT_CONFIG 注入', () => {
  it('legacy topic 在场时 snapshot 与无关 core 提交可运行；旧文件字节不变（R8）', async (t) => {
    const root = await makeTmpRoot(t);
    const dirG = path.join(root, 'scopes', 'global', 'topics');
    await fsp.mkdir(dirG, { recursive: true });
    // 含超长摘要行的旧 Markdown（曾因 updated:null / summary>60 卡死真实 A）
    const longLine = '长'.repeat(90);
    const legacyBytes = Buffer.from(`# 旧专题\n\n${longLine}\n\n正文内容`, 'utf8');
    await fsp.writeFile(path.join(dirG, 'legacy-old.md'), legacyBytes);

    const store = await createFileStore(opts({ root }));
    const snap = await store.snapshot(); // 返回原始 core（渲染属调用方）
    assert.ok(snap.topics.some((x) => x.key === 'legacy-old'));
    // legacy DTO 直接通过真实 A 的 validateTopic 并完成渲染（R8 的关键判据）
    const rendered = A.renderL1({ coreText: snap.core.text, topics: snap.topics });
    assert.ok(rendered.text.includes('## 主题记忆索引 / Topic memory index'));
    assert.ok(rendered.text.includes('- legacy-old [global] — '));
    assert.equal(rendered.chars, rendered.text.length); // A 的 UTF16 口径

    const r = await store.commit({
      operationId: 'unrelated-core', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: '新铁律\n' }],
    });
    assert.equal(r.generation, 1);
    assert.equal(r.budget.reason, 'ok'); // 真实 evaluateMutation 的稳定 reason
    assert.deepEqual(await fsp.readFile(path.join(dirG, 'legacy-old.md')), legacyBytes); // 旧文件字节不变
  });

  it('空 core + 空 summary topic + 中文 key：完整渲染只剩索引（R7/R9）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await store.commit({
      operationId: 'topics-1', expectedGeneration: 0,
      changes: [
        { kind: 'topic', key: '中文专题', expectedRevision: null, topic: { title: '中文', summary: '', updated: '2026-10-24T00:00:00.000Z', body: '内容' } },
        { kind: 'topic', key: 'empty-summary', expectedRevision: null, topic: { title: 'ES', summary: '', updated: '2026-10-24T00:00:00.000Z', body: 'b' } },
      ],
    });
    const snap = await store.snapshot();
    // 渲染由调用方用真实 A 完成：core 为空时完整文本只剩索引（R7）
    const rendered = A.renderL1({ coreText: snap.core.text, topics: snap.topics });
    assert.equal(rendered.text,
      '## 主题记忆索引 / Topic memory index\n- empty-summary [amber] — \n- 中文专题 [amber] — ');
    // 两侧 validateKey 对同一批 key 的接受度一致（R9：不独自收窄公共接口）
    for (const key of ['中文专题', 'empty-summary']) {
      assert.doesNotThrow(() => A.validateKey(key), `A 应接受 "${key}"`);
      await store.readTopic(key); // B 同样接受且可读
    }
    // A 合法但本 store 未创建的 key：B 不得在 key 校验层拒绝（应报 NOT_FOUND）
    for (const key of ['a b', 'Abc']) {
      assert.doesNotThrow(() => A.validateKey(key), `A 应接受 "${key}"`);
      await assert.rejects(() => store.readTopic(key), (e) => e.code === 'NOT_FOUND');
    }
  });

  it('真实预算闸门：候选超硬顶拒绝；超限净减少修复放行；闸门内净增长拒绝', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.commit({
      operationId: 'over', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'a'.repeat(10_001) }],
    }), (err) => {
      assert.equal(err.code, 'BUDGET_REJECTED');
      assert.equal(err.details.budget.reason, 'over-hard-cap');
      return true;
    });

    await putCore(root, 'amber', 'a'.repeat(10_500));
    const repaired = await store.commit({
      operationId: 'repair', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: sha('a'.repeat(10_500)), text: 'a'.repeat(9_500) }],
    });
    assert.equal(repaired.budget.reason, 'repair'); // 修复后 9500 已回到硬顶内
    assert.equal(repaired.budget.allowed, true);
    assert.equal(repaired.budget.promotable, true);

    await assert.rejects(() => store.commit({
      operationId: 'grow', expectedGeneration: 1,
      changes: [{ kind: 'core', expectedRevision: sha('a'.repeat(9_500)), text: 'a'.repeat(9_600) }],
    }), (err) => err.details.budget.reason === 'net-growth-blocked');
  });

  it('listTopics 输出可直接通过 A.selectVisibleTopics（DTO 契合）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await store.commit({
      operationId: 'seed', expectedGeneration: 0,
      changes: [
        { kind: 'topic', key: 'b-topic', expectedRevision: null, topic: { title: 'B', summary: 'sb', updated: '2026-10-24T00:00:00.000Z', body: '' } },
        { kind: 'topic', key: 'a-topic', expectedRevision: null, topic: { title: 'A', summary: 'sa', updated: '2026-10-24T00:00:00.000Z', body: '' } },
      ],
    });
    const topics = await store.listTopics();
    const visible = A.selectVisibleTopics({ activeScopeId: 'amber', topics });
    assert.deepEqual(visible.map((x) => x.key), ['a-topic', 'b-topic']); // A 的稳定排序
  });
});
