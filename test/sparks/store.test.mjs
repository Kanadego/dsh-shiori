// P2-SPARK-STORE 定向测试：scope 隔离、schema 校验、revision CAS、
// operationId/sourceEventId 幂等、links/entities、archive/supersede、
// 持久重开、损坏 fail-closed 与跨进程锁（LOCK_BUSY）。
// 全部为合成测试：不接触真实 DSH、真实 profile 或用户记忆。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openSparkStore } from '../../src/sparks/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOCKFILE_URL = pathToFileURL(path.resolve(HERE, '../../src/storage/lockfile.mjs')).href;

// —— 本文件自带的极简夹具（不依赖 baseline test helpers，包可独立落位） ——

async function makeTmpRoot(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-sparks-' + randomBytes(4).toString('hex')));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });
  return dir;
}

async function waitForFile(file, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fsp.access(file);
      return true;
    } catch {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function dbFileOf(root, scopeId) {
  return path.join(root, 'sparks', 'scopes', scopeId, 'sparks.json');
}

const open = (root, scopeId, overrides = {}) => openSparkStore({ root, scopeId, ...overrides });

function cardInput(overrides = {}) {
  return {
    id: overrides.id ?? 'meme-onion',
    title: overrides.title ?? '洋葱梗',
    summary: overrides.summary ?? '问眼里常含泪水，原来刚切过洋葱。',
    content: overrides.content ?? '2026-10-16 木偶人问为什么眼里常含泪水，琥珀接了艾青的诗，结果他说刚切完洋葱。',
    triggers: overrides.triggers ?? ['洋葱', '切洋葱'],
    entities: overrides.entities ?? ['做饭'],
    links: overrides.links ?? [],
    vitality: overrides.vitality ?? 'evergreen',
    ...overrides,
  };
}

async function saveCard(store, overrides = {}, opts) {
  return store.save(cardInput(overrides), opts);
}

async function assertRejects(promise, code, messagePart) {
  const err = await promise.then(
    () => assert.fail(`期望抛 ${code}，但成功返回`),
    (e) => e,
  );
  assert.equal(err.code, code, `期望错误码 ${code}，得到 ${err.code}：${err.message}`);
  if (messagePart) assert.ok(err.message.includes(messagePart), `错误消息应含 "${messagePart}"，实际：${err.message}`);
  return err;
}

// ---------------------------------------------------------------------------
describe('输入校验与 payload 越权', () => {
  it('save 缺必填字段 / 非法 vitality / 非法 triggers → INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await assertRejects(store.save({ ...cardInput(), title: undefined }), 'INVALID_INPUT');
    await assertRejects(store.save({ ...cardInput(), content: undefined }), 'INVALID_INPUT');
    await assertRejects(store.save({ ...cardInput(), triggers: undefined }), 'INVALID_INPUT');
    await assertRejects(store.save({ ...cardInput(), vitality: 'daily' }), 'INVALID_INPUT');
    await assertRejects(store.save({ ...cardInput(), triggers: '洋葱' }), 'INVALID_INPUT');
    await assertRejects(store.save({ ...cardInput(), triggers: ['', 'x'] }), 'INVALID_INPUT');
    await assertRejects(store.save({ ...cardInput(), triggers: ['   '] }), 'INVALID_INPUT');
    await assertRejects(store.save(cardInput({ title: 'x'.repeat(81) })), 'INVALID_INPUT');
    await assertRejects(store.save(cardInput({ content: 'x'.repeat(2001) })), 'INVALID_INPUT');
    await assertRejects(store.save({ ...cardInput(), vitality: undefined }), 'INVALID_INPUT');
  });

  it('payload 携带 scopeId/root/scope → 拒绝（scope 由 openSparkStore 绑定）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await assertRejects(store.save({ ...cardInput(), scopeId: 'bob' }), 'INVALID_INPUT', 'openSparkStore');
    await assertRejects(store.save({ ...cardInput(), root: '/tmp/elsewhere' }), 'INVALID_INPUT');
    await assertRejects(store.save({ ...cardInput(), dataRoot: '/tmp/elsewhere' }), 'INVALID_INPUT');
    await assertRejects(store.update('meme-onion', { scopeId: 'bob' }), 'INVALID_INPUT');
    await assertRejects(store.save(cardInput(), { scopeId: 'bob' }), 'INVALID_INPUT');
  });

  it('孤立 UTF-16 代理码元 → INVALID_INPUT（拒绝静默替换）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await assertRejects(store.save(cardInput({ content: '坏\uDC00内容' })), 'INVALID_INPUT');
    await assertRejects(store.save(cardInput({ triggers: ['坏\uD800'] })), 'INVALID_INPUT');
  });

  it('非法 id / operationId / sourceEventId → INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    for (const bad of ['a/b', '../x', 'a\\b', 'a b', '.hidden', 'a.', '__proto__', 'constructor', 'x'.repeat(65), '']) {
      // 只断言错误码；具体值在 details / 消息中，逐值断言过于脆弱
      await assertRejects(store.save(cardInput({ id: bad })), 'INVALID_INPUT');
    }
    await assertRejects(saveCard(store, {}, { operationId: 'bad op id' }), 'INVALID_INPUT');
    await assertRejects(store.feedback('meme-onion', { used: true, sourceEventId: 'no/slash' }), 'INVALID_INPUT');
    await assertRejects(store.read('a/b'), 'INVALID_INPUT');
  });

  it('update patch 不能改系统字段；空 patch 拒绝', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    await assertRejects(store.update('meme-onion', { revision: 99 }), 'INVALID_INPUT', '系统字段');
    await assertRejects(store.update('meme-onion', { state: 'archived' }), 'INVALID_INPUT', '系统字段');
    await assertRejects(store.update('meme-onion', { hitCount: 5 }), 'INVALID_INPUT', '系统字段');
    await assertRejects(store.update('meme-onion', {}), 'INVALID_INPUT', '至少包含一个');
  });

  it('root 非法（相对路径 / 指向文件）→ INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    await assertRejects(open('relative/path', 'amber'), 'INVALID_INPUT');
    const filePath = path.join(root, 'plain-file');
    await fsp.writeFile(filePath, 'x');
    await assertRejects(open(filePath, 'amber'), 'INVALID_INPUT');
    await assertRejects(open(root, ''), 'INVALID_INPUT');
  });

  it('scopeId 与 scopes/ 下已有目录大小写碰撞 → INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    await fsp.mkdir(path.join(root, 'sparks', 'scopes', 'AMBER'), { recursive: true });
    await assertRejects(open(root, 'amber'), 'INVALID_INPUT', '大小写碰撞');
  });
});

// ---------------------------------------------------------------------------
describe('基础读写、revision 与 record 形状', () => {
  it('save→read：public record 字段齐全，revision=1，state=active', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    const saved = await saveCard(store);
    assert.equal(saved.id, 'meme-onion');
    assert.equal(saved.scopeId, 'amber');
    assert.equal(saved.revision, 1);
    assert.equal(saved.state, 'active');
    assert.equal(saved.vitality, 'evergreen');
    assert.equal(saved.hitCount, 0);
    assert.equal(saved.useCount, 0);
    assert.equal(saved.lastHitAt, null);
    assert.equal(saved.lastUsedAt, null);
    assert.equal(saved.supersedes, null);
    assert.equal(saved.supersededBy, null);
    assert.deepEqual(saved.triggers, ['洋葱', '切洋葱']);
    assert.deepEqual(saved.entities, ['做饭']);
    assert.deepEqual(saved.links, []);
    const read = await store.read('meme-onion');
    assert.deepEqual(read, saved);
  });

  it('未显式 id 时自动生成 spk- 前缀 id；triggers 原样保留不去重改写', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    const saved = await saveCard(store, { id: undefined });
    assert.match(saved.id, /^spk-[0-9a-f]{16}$/);
    const dup = await saveCard(store, { id: undefined, title: '另一张' });
    assert.notEqual(dup.id, saved.id);
    const dedup = await store.save(cardInput({ id: 'dup-words', triggers: ['a', 'a', 'b'] }));
    assert.deepEqual(dedup.triggers, ['a', 'b']);
  });

  it('重复 id save → REVISION_CONFLICT；expectedRevision 只接受 0', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    const err = await assertRejects(saveCard(store), 'REVISION_CONFLICT');
    assert.equal(err.details.currentRevision, 1);
    await assertRejects(saveCard(store, {}, { expectedRevision: 0 }), 'REVISION_CONFLICT');
    await assertRejects(saveCard(store, { id: 'fresh-1' }, { expectedRevision: 1 }), 'INVALID_INPUT');
    // 期望 0 且目标确实不存在 → 成功
    const ok = await saveCard(store, { id: 'fresh-1' }, { expectedRevision: 0 });
    assert.equal(ok.revision, 1);
  });

  it('id 大小写碰撞拒绝（Windows 语义前瞻）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    await assertRejects(saveCard(store, { id: 'MEME-ONION' }), 'INVALID_INPUT', '大小写碰撞');
  });

  it('update 字段替换 + revision 递增；read 验证', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    const updated = await store.update('meme-onion', { vitality: 'ephemeral', triggers: ['洋葱头'] }, { expectedRevision: 1 });
    assert.equal(updated.revision, 2);
    assert.equal(updated.vitality, 'ephemeral');
    assert.deepEqual(updated.triggers, ['洋葱头']);
    assert.equal((await store.read('meme-onion')).revision, 2);
  });

  it('stale expectedRevision → REVISION_CONFLICT（details 带 currentRevision）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    await store.update('meme-onion', { title: 'v2' });
    const err = await assertRejects(
      store.update('meme-onion', { title: 'v3' }, { expectedRevision: 1 }),
      'REVISION_CONFLICT',
    );
    assert.equal(err.details.currentRevision, 2);
    assert.equal(err.details.expectedRevision, 1);
  });

  it('update / read 不存在的卡 → NOT_FOUND', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await assertRejects(store.read('ghost'), 'NOT_FOUND');
    await assertRejects(store.update('ghost', { title: 'x' }), 'NOT_FOUND');
    await assertRejects(store.forget('ghost', { mode: 'archive' }), 'NOT_FOUND');
    await assertRejects(store.feedback('ghost', { used: true }), 'NOT_FOUND');
  });

  it('返回值是副本：修改返回对象不影响库内状态', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    const saved = await saveCard(store);
    saved.title = '被篡改';
    saved.triggers.push('注入');
    assert.equal((await store.read('meme-onion')).title, '洋葱梗');
    assert.deepEqual((await store.read('meme-onion')).triggers, ['洋葱', '切洋葱']);
  });
});

// ---------------------------------------------------------------------------
describe('scope 隔离', () => {
  it('相同 id 跨 scope 不串读；listActive/graph 各自独立', async (t) => {
    const root = await makeTmpRoot(t);
    const amber = await open(root, 'amber');
    const bob = await open(root, 'bob');
    await saveCard(amber, { content: 'amber 的洋葱' });
    await saveCard(bob, { content: 'bob 的洋葱' });
    assert.equal((await amber.read('meme-onion')).content, 'amber 的洋葱');
    assert.equal((await bob.read('meme-onion')).content, 'bob 的洋葱');
    await assertRejects(amber.read('bob-only'), 'NOT_FOUND');
    await saveCard(bob, { id: 'bob-only', title: 'bob 专属' });
    await assertRejects(amber.read('bob-only'), 'NOT_FOUND');
    assert.equal((await amber.listActive()).length, 1);
    assert.equal((await bob.listActive()).length, 2);
    assert.equal((await amber.graph()).nodeCount, 1);
    assert.equal((await bob.graph()).nodeCount, 2);
    assert.equal((await amber.graph()).scopeId, 'amber');
  });

  it('link 目标仅存在于其他 scope → INVALID_INPUT（跨 scope 引用拒绝）', async (t) => {
    const root = await makeTmpRoot(t);
    const amber = await open(root, 'amber');
    const bob = await open(root, 'bob');
    await saveCard(bob, { id: 'bob-secret', title: 'bob 的卡' });
    await assertRejects(
      saveCard(amber, { id: 'a1', links: [{ target: 'bob-secret', rel: '关联' }] }),
      'INVALID_INPUT', '不存在于本 scope',
    );
    // amber 里补一张同 id 卡后 link 合法（各 scope 独立命名空间）
    await saveCard(amber, { id: 'bob-secret' });
    const ok = await saveCard(amber, { id: 'a1', links: [{ target: 'bob-secret', rel: '关联' }] });
    assert.equal(ok.links.length, 1);
  });

  it('supersede 的 replacementId 来自其他 scope → INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    const amber = await open(root, 'amber');
    const bob = await open(root, 'bob');
    await saveCard(amber);
    await saveCard(bob, { id: 'bob-new' });
    await assertRejects(
      amber.forget('meme-onion', { mode: 'supersede', replacementId: 'bob-new' }),
      'INVALID_INPUT', '不存在于本 scope',
    );
  });
});

// ---------------------------------------------------------------------------
describe('links 与图谱投影', () => {
  it('self-link / 不存在目标 → INVALID_INPUT；重复 link 对去重', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'a' });
    await assertRejects(saveCard(store, { id: 'b', links: [{ target: 'b', rel: '自指' }] }), 'INVALID_INPUT', 'self-link');
    await assertRejects(saveCard(store, { id: 'b', links: [{ target: 'ghost', rel: '断链' }] }), 'INVALID_INPUT');
    const saved = await saveCard(store, {
      id: 'b',
      links: [
        { target: 'a', rel: '同边' },
        { target: 'a', rel: '同边' },
        { target: 'a', rel: '另一关系' },
      ],
    });
    assert.equal(saved.links.length, 2);
    // update 时同样校验
    await assertRejects(store.update('b', { links: [{ target: 'b', rel: '自指' }] }), 'INVALID_INPUT', 'self-link');
    await assertRejects(store.update('b', { links: [{ target: 'ghost', rel: '断链' }] }), 'INVALID_INPUT');
  });

  it('graph：只含 active 节点与两端 active 的边；按 vitality 标注；稳定排序去重', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'n1', vitality: 'evergreen' });
    await saveCard(store, { id: 'n2', vitality: 'ephemeral', links: [{ target: 'n1', rel: '相关' }] });
    await saveCard(store, { id: 'n3', vitality: 'ephemeral', links: [{ target: 'n1', rel: '相关' }, { target: 'n2', rel: '相关' }] });
    await saveCard(store, { id: 'n4' });
    await store.forget('n4', { mode: 'archive' });
    const g = await store.graph();
    assert.deepEqual(g.nodes.map((n) => n.id), ['n1', 'n2', 'n3']);
    assert.deepEqual(g.nodes.map((n) => n.vitality), ['evergreen', 'ephemeral', 'ephemeral']);
    assert.deepEqual(g.edges, [
      { source: 'n2', target: 'n1', rel: '相关' },
      { source: 'n3', target: 'n1', rel: '相关' },
      { source: 'n3', target: 'n2', rel: '相关' },
    ]);
    assert.equal(g.nodeCount, 3);
    assert.equal(g.edgeCount, 3);
    // graph 不携带 content 正文
    assert.ok(!JSON.stringify(g).includes('2026-10-16'));
  });

  it('一端 archived 后对应边不可见，但显式列入 filteredEdges（不静默消失）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'x1' });
    await saveCard(store, { id: 'x2', links: [{ target: 'x1', rel: '相关' }] });
    assert.equal((await store.graph()).edgeCount, 1);
    await store.forget('x1', { mode: 'archive' });
    const g = await store.graph();
    assert.deepEqual(g.nodes.map((n) => n.id), ['x2']);
    assert.equal(g.edgeCount, 0);
    assert.deepEqual(g.filteredEdges, [{ source: 'x2', target: 'x1', rel: '相关', reason: 'target-retired' }]);
    assert.equal(g.filteredEdgeCount, 1);
    // 重开后仍一致
    store.close();
    const reopened = await open(root, 'amber');
    const g2 = await reopened.graph();
    assert.equal(g2.edgeCount, 0);
    assert.deepEqual(g2.filteredEdges, g.filteredEdges);
  });

  it('空库 graph/listActive 返回空集合而非报错', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    assert.deepEqual(await store.listActive(), []);
    const g = await store.graph();
    assert.deepEqual(g, {
      scopeId: 'amber', nodeCount: 0, edgeCount: 0, filteredEdgeCount: 0,
      nodes: [], edges: [], filteredEdges: [],
    });
  });
});

// ---------------------------------------------------------------------------
describe('软归档与替代（archive / supersede）', () => {
  it('archive：软归档，read 仍可见，listActive/graph 排除，重复 forget → INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    const archived = await store.forget('meme-onion', { mode: 'archive', expectedRevision: 1 });
    assert.equal(archived.state, 'archived');
    assert.equal(archived.revision, 2);
    assert.ok(archived.archivedAt);
    assert.equal((await store.read('meme-onion')).state, 'archived');
    assert.deepEqual((await store.listActive()).map((c) => c.id), []);
    assert.equal((await store.graph()).nodeCount, 0);
    await assertRejects(store.forget('meme-onion', { mode: 'archive' }), 'INVALID_STATE');
    await assertRejects(store.update('meme-onion', { title: 'x' }), 'INVALID_STATE');
  });

  it('archive 不接受 replacementId；mode 非法 → INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    await assertRejects(store.forget('meme-onion', { mode: 'archive', replacementId: 'meme-onion' }), 'INVALID_INPUT');
    await assertRejects(store.forget('meme-onion', { mode: 'delete' }), 'INVALID_INPUT');
    await assertRejects(store.forget('meme-onion', {}), 'INVALID_INPUT');
  });

  it('supersede：原卡保留并 supersededBy 指向新卡；新卡 supersedes 回指且 revision 递增', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'old' });
    await saveCard(store, { id: 'new', title: '新版洋葱梗' });
    const superseded = await store.forget('old', { mode: 'supersede', replacementId: 'new', expectedRevision: 1 });
    assert.equal(superseded.state, 'superseded');
    assert.equal(superseded.supersededBy, 'new');
    assert.equal(superseded.revision, 2);
    const replacement = await store.read('new');
    assert.equal(replacement.supersedes, 'old');
    assert.equal(replacement.revision, 2);
    assert.equal(replacement.state, 'active');
    // 有向关系可从两侧 read 验证；投影只留 replacement
    assert.deepEqual((await store.listActive()).map((c) => c.id), ['new']);
    assert.equal((await store.graph()).nodeCount, 1);
  });

  it('supersede 反例：无 replacementId / 不存在 / 自身 / 非 active / 已承接 / 双重 forget', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'a' });
    await saveCard(store, { id: 'b' });
    await saveCard(store, { id: 'c' });
    await assertRejects(store.forget('a', { mode: 'supersede' }), 'INVALID_INPUT');
    await assertRejects(store.forget('a', { mode: 'supersede', replacementId: 'ghost' }), 'INVALID_INPUT');
    await assertRejects(store.forget('a', { mode: 'supersede', replacementId: 'a' }), 'INVALID_INPUT');
    await store.forget('b', { mode: 'archive' });
    await assertRejects(store.forget('a', { mode: 'supersede', replacementId: 'b' }), 'INVALID_STATE', 'active');
    await store.forget('a', { mode: 'supersede', replacementId: 'c' });
    // c 已承接 a，不能再承接别人
    await saveCard(store, { id: 'd' });
    await assertRejects(store.forget('d', { mode: 'supersede', replacementId: 'c' }), 'INVALID_STATE', '已替代');
    // 已 superseded 的 a 不能再次 forget，也不能 update
    await assertRejects(store.forget('a', { mode: 'archive' }), 'INVALID_STATE');
    await assertRejects(store.update('a', { title: 'x' }), 'INVALID_STATE');
  });

  it('stale expectedRevision 的 forget → REVISION_CONFLICT', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    await store.update('meme-onion', { title: 'v2' });
    await assertRejects(store.forget('meme-onion', { mode: 'archive', expectedRevision: 1 }), 'REVISION_CONFLICT');
  });
});

// ---------------------------------------------------------------------------
describe('feedback 与 sourceEventId 去重', () => {
  it('used=true 更新 useCount/lastUsedAt，revision 不变', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    const saved = await saveCard(store);
    const fb = await store.feedback('meme-onion', { used: true, sourceEventId: 'evt-1' });
    assert.equal(fb.useCount, 1);
    assert.ok(fb.lastUsedAt);
    assert.equal(fb.revision, saved.revision); // 统计写不动 revision
  });

  it('同一 sourceEventId 重复反馈不重复计数；不同 used 语义 → INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    await store.feedback('meme-onion', { used: true, sourceEventId: 'evt-1' });
    const again = await store.feedback('meme-onion', { used: true, sourceEventId: 'evt-1' });
    assert.equal(again.useCount, 1);
    await assertRejects(
      store.feedback('meme-onion', { used: false, sourceEventId: 'evt-1' }),
      'INVALID_INPUT', '不同语义',
    );
    // 不同事件正常计数
    await store.feedback('meme-onion', { used: true, sourceEventId: 'evt-2' });
    assert.equal((await store.read('meme-onion')).useCount, 2);
  });

  it('used=false 不计数但记录事件；缺 used → INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    const fb = await store.feedback('meme-onion', { used: false, sourceEventId: 'evt-f' });
    assert.equal(fb.useCount, 0);
    assert.equal(fb.lastUsedAt, null);
    await assertRejects(store.feedback('meme-onion', { sourceEventId: 'evt-x' }), 'INVALID_INPUT');
    await assertRejects(store.feedback('meme-onion', { used: 'yes' }), 'INVALID_INPUT');
  });

  it('feedback 可带 operationId：重放返回首次快照且不重复计数', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    const first = await store.feedback('meme-onion', { used: true, sourceEventId: 'evt-1', operationId: 'fb-op-1' });
    assert.equal(first.useCount, 1);
    await store.feedback('meme-onion', { used: true, sourceEventId: 'evt-2' }); // useCount → 2
    const replay = await store.feedback('meme-onion', { used: true, sourceEventId: 'evt-1', operationId: 'fb-op-1' });
    assert.equal(replay.useCount, 1); // 首次快照，不反映后续变更
    assert.equal((await store.read('meme-onion')).useCount, 2); // 事件 evt-1 未重复计数
  });
});

// ---------------------------------------------------------------------------
describe('operationId 幂等', () => {
  it('save 同 opId 重放返回同一条记录；库中只有一张卡', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    const first = await saveCard(store, { id: 'op-card' }, { operationId: 'save-1' });
    const replay = await saveCard(store, { id: 'op-card' }, { operationId: 'save-1' });
    assert.deepEqual(replay, first);
    assert.equal((await store.listActive()).length, 1);
  });

  it('自动 id 的 save 重放返回同一个自动 id', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    const first = await saveCard(store, { id: undefined }, { operationId: 'auto-1' });
    const replay = await saveCard(store, { id: undefined }, { operationId: 'auto-1' });
    assert.equal(replay.id, first.id);
    assert.equal((await store.listActive()).length, 1);
  });

  it('同 opId 不同语义请求（改内容/换方法）→ INVALID_INPUT', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'c1' }, { operationId: 'op-x' });
    await assertRejects(saveCard(store, { id: 'c1', title: '另一个语义' }, { operationId: 'op-x' }), 'INVALID_INPUT', '不同语义');
    await assertRejects(store.update('c1', { title: '又一个' }, { operationId: 'op-x' }), 'INVALID_INPUT', '不同语义');
    // expectedRevision 属于请求语义的一部分
    await saveCard(store, { id: 'c2' }, { operationId: 'op-y', expectedRevision: 0 });
    await assertRejects(
      store.update('c2', { title: 't' }, { operationId: 'op-y' }),
      'INVALID_INPUT', '不同语义',
    );
  });

  it('update opId 重放：revision 不再递增，返回首次结果快照', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'u1' });
    const first = await store.update('u1', { title: '第一次' }, { expectedRevision: 1, operationId: 'upd-1' });
    assert.equal(first.revision, 2);
    await store.update('u1', { title: '第二次' }); // revision → 3
    const replay = await store.update('u1', { title: '第一次' }, { expectedRevision: 1, operationId: 'upd-1' });
    assert.equal(replay.revision, 2);
    assert.equal(replay.title, '第一次');
    assert.equal((await store.read('u1')).revision, 3); // 重放没有真实写入
    assert.equal((await store.read('u1')).title, '第二次');
  });

  it('forget opId 重放返回首次结果，不报 INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'f1' });
    const first = await store.forget('f1', { mode: 'archive', operationId: 'fg-1' });
    const replay = await store.forget('f1', { mode: 'archive', operationId: 'fg-1' });
    assert.deepEqual(replay, first);
  });

  it('失败的操作不占用 opId：可修正后用同 opId 重试', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'r1' });
    await store.update('r1', { title: 'v2' });
    await assertRejects(
      store.update('r1', { title: 'stale' }, { expectedRevision: 1, operationId: 'retry-1' }),
      'REVISION_CONFLICT',
    );
    const ok = await store.update('r1', { title: 'fresh' }, { expectedRevision: 2, operationId: 'retry-1' });
    assert.equal(ok.revision, 3);
  });
});

// ---------------------------------------------------------------------------
describe('持久化与重开', () => {
  it('保存全部状态后 close 重开：revision/state/supersededBy/useCount 全保留', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'old' });
    await saveCard(store, { id: 'new' });
    await store.update('old', { title: '改过' });
    await store.forget('old', { mode: 'supersede', replacementId: 'new' });
    await store.feedback('new', { used: true, sourceEventId: 'evt-9' });
    store.close();

    const reopened = await open(root, 'amber');
    const old = await reopened.read('old');
    assert.equal(old.state, 'superseded');
    assert.equal(old.supersededBy, 'new');
    assert.equal(old.revision, 3);
    assert.equal(old.title, '改过');
    const fresh = await reopened.read('new');
    assert.equal(fresh.supersedes, 'old');
    assert.equal(fresh.revision, 2);
    assert.equal(fresh.useCount, 1);
    assert.deepEqual((await reopened.listActive()).map((c) => c.id), ['new']);
  });

  it('重开后 operationId 幂等记录仍然生效', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'p1' }, { operationId: 'persist-op' });
    store.close();
    const reopened = await open(root, 'amber');
    const replayOk = await reopened.save(cardInput({ id: 'p1' }), { operationId: 'persist-op' });
    assert.equal(replayOk.id, 'p1');
    assert.equal((await reopened.listActive()).length, 1);
    await assertRejects(
      reopened.save(cardInput({ id: 'p1', title: '不同语义' }), { operationId: 'persist-op' }),
      'INVALID_INPUT', '不同语义',
    );
  });

  it('close 后所有方法 → INVALID_STATE；close 幂等', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    store.close();
    store.close();
    await assertRejects(store.read('meme-onion'), 'INVALID_STATE');
    await assertRejects(store.listActive(), 'INVALID_STATE');
    await assertRejects(store.graph(), 'INVALID_STATE');
    await assertRejects(saveCard(store, { id: 'x2' }), 'INVALID_STATE');
  });

  it('同进程两个 store 实例交替写：revision 连续递增不丢失', async (t) => {
    const root = await makeTmpRoot(t);
    const s1 = await open(root, 'amber');
    const s2 = await open(root, 'amber');
    await saveCard(s1, { id: 'shared' });
    for (let i = 0; i < 4; i += 1) {
      const current = await s1.read('shared');
      await (i % 2 === 0 ? s2 : s1).update('shared', { title: `v${i + 2}` }, { expectedRevision: current.revision });
    }
    assert.equal((await s1.read('shared')).revision, 5);
  });
});

// ---------------------------------------------------------------------------
describe('损坏与故障（fail-closed，绝不静默归零）', () => {
  async function reopenExpect(root, scopeId, code, part) {
    const err = await open(root, scopeId).then(
      () => assert.fail('期望 open 失败'),
      (e) => e,
    );
    assert.equal(err.code, code, `期望 ${code}，得到 ${err.code}：${err.message}`);
    if (part) assert.ok(err.message.includes(part), `消息应含 "${part}"：${err.message}`);
  }

  it('垃圾字节 / 非法 UTF-8 → open 即 INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    store.close();
    await fsp.writeFile(dbFileOf(root, 'amber'), Buffer.from([0xff, 0xfe, 0x00, 0x81]), null);
    await reopenExpect(root, 'amber', 'INVALID_STATE');
  });

  it('空文件 / 截断 JSON / 错误 kind / 错 scopeId → INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    store.close();
    const file = dbFileOf(root, 'amber');
    const backup = await fsp.readFile(file, 'utf8');

    await fsp.writeFile(file, '');
    await reopenExpect(root, 'amber', 'INVALID_STATE', '空');

    await fsp.writeFile(file, backup.slice(0, backup.length - 10));
    await reopenExpect(root, 'amber', 'INVALID_STATE', 'JSON');

    const wrongKind = JSON.parse(backup);
    wrongKind.kind = 'someone-else';
    await fsp.writeFile(file, JSON.stringify(wrongKind));
    await reopenExpect(root, 'amber', 'INVALID_STATE', 'kind');

    const wrongScope = JSON.parse(backup);
    wrongScope.scopeId = 'bob';
    await fsp.writeFile(file, JSON.stringify(wrongScope));
    await reopenExpect(root, 'amber', 'INVALID_STATE', 'scopeId');
  });

  it('未来 schema 版本 → UNSUPPORTED', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    store.close();
    const file = dbFileOf(root, 'amber');
    const future = JSON.parse(await fsp.readFile(file, 'utf8'));
    future.schemaVersion = 99;
    await fsp.writeFile(file, JSON.stringify(future));
    await reopenExpect(root, 'amber', 'UNSUPPORTED');
  });

  it('手改卡片字段（revision 变字符串）→ INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store);
    store.close();
    const file = dbFileOf(root, 'amber');
    const db = JSON.parse(await fsp.readFile(file, 'utf8'));
    db.cards['meme-onion'].revision = 'one';
    await fsp.writeFile(file, JSON.stringify(db));
    await reopenExpect(root, 'amber', 'INVALID_STATE', 'revision');
  });

  it('悬空 link（手改加不存在的 target）→ INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'a' });
    await saveCard(store, { id: 'b', links: [{ target: 'a', rel: 'r' }] });
    store.close();
    const file = dbFileOf(root, 'amber');
    const db = JSON.parse(await fsp.readFile(file, 'utf8'));
    delete db.cards.a;
    await fsp.writeFile(file, JSON.stringify(db));
    await reopenExpect(root, 'amber', 'INVALID_STATE', '悬空');
  });

  it('数据库路径被目录占用 → INVALID_STATE（不静默重建）', async (t) => {
    const root = await makeTmpRoot(t);
    await fsp.mkdir(dbFileOf(root, 'amber'), { recursive: true });
    await reopenExpect(root, 'amber', 'INVALID_STATE', '符号链接或目录');
    // 读路径同样 fail-closed：先正常建库再把文件换成目录
    const store = await open(root, 'bob');
    await saveCard(store, { id: 'z' });
    store.close();
    await fsp.rm(dbFileOf(root, 'bob'));
    await fsp.mkdir(dbFileOf(root, 'bob'));
    await assertRejects(open(root, 'bob'), 'INVALID_STATE', '符号链接或目录');
  });

  it('scopes 管理路径被普通文件占用 → INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    await fsp.mkdir(path.join(root, 'sparks'), { recursive: true });
    await fsp.writeFile(path.join(root, 'sparks', 'scopes'), 'not a dir');
    const err = await open(root, 'amber').then(() => assert.fail('期望失败'), (e) => e);
    assert.equal(err.code, 'INVALID_STATE', `得到 ${err.code}：${err.message}`);
  });
});

// ---------------------------------------------------------------------------
describe('跨进程锁（LOCK_BUSY）', () => {
  it('子进程持锁期间写入 → LOCK_BUSY；释放后写入成功', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber', { lockTimeoutMs: 300, retryMs: 25 });
    const lockRoot = path.join(root, 'sparks');
    const marker = path.join(root, 'holder-ready.marker');

    const code = [
      `import { withLock } from ${JSON.stringify(LOCKFILE_URL)};`,
      `import { writeFileSync } from 'node:fs';`,
      `await withLock(${JSON.stringify(lockRoot)}, { timeoutMs: 8000 }, async () => {`,
      `  writeFileSync(${JSON.stringify(marker)}, 'held');`,
      `  await new Promise((r) => setTimeout(r, 1500));`,
      `});`,
    ].join('\n');
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: os.tmpdir(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });

    assert.ok(await waitForFile(marker), '子进程未能取得锁（marker 未出现）');
    const err = await store.save(cardInput()).then(
      () => assert.fail('期望 LOCK_BUSY'),
      (e) => e,
    );
    assert.equal(err.code, 'LOCK_BUSY', `得到 ${err.code}：${err.message}`);

    await new Promise((resolve) => child.on('close', resolve));
    assert.equal(child.exitCode, 0, `锁持有子进程异常退出：${stderr}`);
    // 锁释放后同一 store 可正常写入
    const saved = await store.save(cardInput());
    assert.equal(saved.revision, 1);
    store.close();
  });
});

// ---------------------------------------------------------------------------
// 审核反例回归（rework attempt 2 · 反馈 G1/G2/G3）
// ---------------------------------------------------------------------------
describe('替代链完整性（G1）', () => {
  it('承接了替代关系的 replacement 不能被 archive 也不能被再替代', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'old' });
    await saveCard(store, { id: 'mid' });
    await saveCard(store, { id: 'newest' });
    await store.forget('old', { mode: 'supersede', replacementId: 'mid' });
    await assertRejects(store.forget('mid', { mode: 'archive' }), 'INVALID_STATE', '承接');
    await assertRejects(store.forget('mid', { mode: 'supersede', replacementId: 'newest' }), 'INVALID_STATE', '承接');
    // replacement 仍可正常 update（内容维护不动链条）
    const updated = await store.update('mid', { title: '维护' });
    assert.equal(updated.state, 'active');
    assert.equal(updated.supersedes, 'old');
    // 链条保持健康
    assert.equal((await store.read('old')).supersededBy, 'mid');
    assert.deepEqual((await store.listActive()).map((c) => c.id), ['mid', 'newest']);
  });

  it('create → 尝试退休 replacement → reopen：链条完好且加载校验把断裂判为损坏', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'a1' });
    await saveCard(store, { id: 'a2' });
    await store.forget('a1', { mode: 'supersede', replacementId: 'a2' });
    store.close();
    const reopened = await open(root, 'amber');
    const a1 = await reopened.read('a1');
    const a2 = await reopened.read('a2');
    assert.equal(a1.state, 'superseded');
    assert.equal(a1.supersededBy, 'a2');
    assert.equal(a2.state, 'active');
    assert.equal(a2.supersedes, 'a1');
    reopened.close();
    // 手改磁盘伪造断裂链（replacement 被外部置为 archived）→ 重开 fail-closed
    const file = dbFileOf(root, 'amber');
    const db = JSON.parse(await fsp.readFile(file, 'utf8'));
    db.cards.a2.state = 'archived';
    await fsp.writeFile(file, JSON.stringify(db));
    const err = await open(root, 'amber').then(() => assert.fail('期望失败'), (e) => e);
    assert.equal(err.code, 'INVALID_STATE', `得到 ${err.code}：${err.message}`);
    assert.match(err.message, /supersededBy|替代关系/);
  });

  it('手改造成单侧缺失的替代关系 → 重开 INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'a1' });
    await saveCard(store, { id: 'a2' });
    await store.forget('a1', { mode: 'supersede', replacementId: 'a2' });
    store.close();
    const file = dbFileOf(root, 'amber');
    const db = JSON.parse(await fsp.readFile(file, 'utf8'));
    delete db.cards.a2.supersedes; // a1.supersededBy 仍指向 a2，但对侧消失
    await fsp.writeFile(file, JSON.stringify(db));
    const err = await open(root, 'amber').then(() => assert.fail('期望失败'), (e) => e);
    assert.equal(err.code, 'INVALID_STATE');
  });
});

describe('links / feedback 仅限 active 卡（G2）', () => {
  it('link 目标为 archived 或 superseded → INVALID_INPUT（save 与 update 双路径）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'arch' });
    await saveCard(store, { id: 'sup', title: '将被打断' });
    await saveCard(store, { id: 'sup2' });
    await store.forget('arch', { mode: 'archive' });
    await store.forget('sup', { mode: 'supersede', replacementId: 'sup2' });
    await assertRejects(
      saveCard(store, { id: 'n1', links: [{ target: 'arch', rel: 'r' }] }),
      'INVALID_INPUT', '仅 active 卡可被链接',
    );
    await assertRejects(
      saveCard(store, { id: 'n1', links: [{ target: 'sup', rel: 'r' }] }),
      'INVALID_INPUT', '仅 active 卡可被链接',
    );
    await saveCard(store, { id: 'n1', links: [{ target: 'sup2', rel: 'r' }] });
    await assertRejects(
      store.update('n1', { links: [{ target: 'arch', rel: 'r' }] }),
      'INVALID_INPUT', '仅 active 卡可被链接',
    );
  });

  it('对 archived / superseded 卡 feedback（used=true 与 used=false）→ INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'arch' });
    await saveCard(store, { id: 'sup' });
    await saveCard(store, { id: 'sup2' });
    await store.forget('arch', { mode: 'archive' });
    await store.forget('sup', { mode: 'supersede', replacementId: 'sup2' });
    await assertRejects(store.feedback('arch', { used: true, sourceEventId: 'e1' }), 'INVALID_STATE');
    await assertRejects(store.feedback('arch', { used: false, sourceEventId: 'e2' }), 'INVALID_STATE');
    await assertRejects(store.feedback('sup', { used: true, sourceEventId: 'e3' }), 'INVALID_STATE');
    // active 卡不受影响
    const ok = await store.feedback('sup2', { used: true, sourceEventId: 'e4' });
    assert.equal(ok.useCount, 1);
  });
});

describe('graph 失效边显式上报（G3）', () => {
  it('active→retired 与 retired→active 两类失效边都出现在 filteredEdges 且不进 edges', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'k1' });
    await saveCard(store, { id: 'k2', links: [{ target: 'k1', rel: '相关' }] });
    await saveCard(store, { id: 'k3', links: [{ target: 'k2', rel: '相关' }] });
    // 建链时全部 active，合法；随后归档制造两端失效场景
    await store.forget('k2', { mode: 'archive' });
    const g = await store.graph();
    assert.deepEqual(g.nodes.map((n) => n.id), ['k1', 'k3']);
    assert.equal(g.edgeCount, 0);
    assert.equal(g.filteredEdgeCount, 2);
    assert.deepEqual(g.filteredEdges, [
      { source: 'k2', target: 'k1', rel: '相关', reason: 'source-retired' },
      { source: 'k3', target: 'k2', rel: '相关', reason: 'target-retired' },
    ]);
    // read 侧的 links 与 graph 报告一致，不出现静默吞并
    const k3 = await store.read('k3');
    assert.deepEqual(k3.links, [{ target: 'k2', rel: '相关' }]);
  });

  it('写路径拒绝非 active 目标后，graph 不会产生新的失效边来源', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await open(root, 'amber');
    await saveCard(store, { id: 'm1' });
    await saveCard(store, { id: 'm2' });
    await store.forget('m2', { mode: 'archive' });
    await assertRejects(
      saveCard(store, { id: 'm3', links: [{ target: 'm2', rel: 'r' }] }),
      'INVALID_INPUT', '仅 active 卡可被链接',
    );
    const g = await store.graph();
    assert.equal(g.edgeCount, 0);
    assert.equal(g.filteredEdgeCount, 0);
  });
});
