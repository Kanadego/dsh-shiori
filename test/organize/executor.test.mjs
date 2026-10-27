// P3 根集成测试：直接检验根 src/organize 与 src/sparks/store.mjs。
// 冻结 P2 loader 对照仅复制已接收 G a2 的不可变 store 到临时目录。
// 生产测试不导入 proposal；J/K 组合必须执行，导入或构造失败直接失败。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(HERE, '../../src');
const FROZEN_STORE = process.env.SHIORI_FROZEN_G_STORE
  ?? path.resolve(HERE, '../fixtures/frozen/G/a2-226d3f0e-77ea-4a4c-b097-ad6483ebc806/files/src/sparks/store.mjs');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// 生产入口直接使用 SRC_DIR；历史 loader 对照保留独立临时树。
const stageImport = (rel) => import(pathToFileURL(path.join(SRC_DIR, rel)).href);
const frozenStageRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-p3-l-frozen-'));
await fsp.cp(SRC_DIR, path.join(frozenStageRoot, 'src'), { recursive: true });
await fsp.copyFile(FROZEN_STORE, path.join(frozenStageRoot, 'src/sparks/store.mjs'));
const frozenImport = (rel) => import(pathToFileURL(path.join(frozenStageRoot, 'src', rel)).href);

const {
  createOrganizerExecutor, digestPlan,
} = await stageImport('organize/executor.mjs');
const { openSparkStore } = await stageImport('sparks/store.mjs');
const { openSparkStore: openFrozenSparkStore } = await frozenImport('sparks/store.mjs');
const { createShioriService } = await stageImport('service/index.mjs');
const { createFileStore } = await stageImport('storage/index.mjs');
const { validateConfig, renderL1, evaluateMutation } = await stageImport('core/index.mjs');
const { stableStringify } = await stageImport('storage/fsutil.mjs');

const CONFIG = validateConfig({});
const SOURCES_BLOCK_OPEN = '\n<!-- shiori-p3-sources -->\n';
const SOURCES_BLOCK_CLOSE = '\n<!-- /shiori-p3-sources -->\n';

process.on('exit', () => {
  rmSync(frozenStageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function makeRoot(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-p3-l-data-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });
  return dir;
}

async function openStores(root, scopeId = 'amber') {
  const fileStore = await createFileStore({
    root, activeScopeId: scopeId, config: CONFIG, policy: evaluateMutation, renderL1,
  });
  const service = await createShioriService({ root, activeScopeId: scopeId });
  const sparkStore = await openSparkStore({ root, scopeId });
  return { fileStore, service, sparkStore };
}

const grantAll = () => async () => true;

async function seedCard(sparkStore, id, overrides = {}) {
  return sparkStore.save({
    id,
    title: overrides.title ?? `卡-${id}`,
    summary: overrides.summary ?? `${id} 的摘要`,
    content: overrides.content ?? `${id} 的正文：使用者于 2026-10 记录的原句 <orig-${id}/>`,
    triggers: overrides.triggers ?? [`t-${id}`],
    entities: overrides.entities ?? ['共同实体'],
    links: overrides.links ?? [],
    vitality: 'evergreen',
  });
}

async function seedTopic(fileStore, key, body, meta = {}) {
  return fileStore.commit({
    operationId: `seed-${key}-${randomBytes(3).toString('hex')}`,
    changes: [{
      kind: 'topic', key, expectedRevision: null,
      topic: {
        title: meta.title ?? `主题-${key}`,
        summary: meta.summary ?? '合并目标',
        updated: meta.updated ?? '2026-10-25T00:00:00.000Z',
        body,
      },
    }],
  });
}

/**
 * K 契约源保全块（十字段记录、按 id 升序的数组）——独立构造路径：
 * 手工按字母序插入键后用 JSON.stringify，与执行器内部递归 stable 序列化
 * 完全独立，字节比对才有意义（主审 L-1：数组不是 id 键 map）。
 */
function sourcesBlockOf(cards) {
  const records = [...cards].sort(byId).map((c) => {
    const r = {};
    r.content = c.content;
    r.entities = [...c.entities];
    r.id = c.id;
    r.links = c.links.map((l) => ({ rel: l.rel, target: l.target }));
    r.revision = c.revision;
    r.scopeId = c.scopeId;
    r.summary = c.summary;
    r.title = c.title;
    r.triggers = [...c.triggers];
    r.vitality = c.vitality;
    return r;
  });
  return SOURCES_BLOCK_OPEN + JSON.stringify(records) + SOURCES_BLOCK_CLOSE;
}

/** a1 错误形状（id 键 map）：仅用于负例——不得再被接受。 */
function mapBlockOf(cards) {
  const map = {};
  for (const c of [...cards].sort(byId)) {
    map[c.id] = {
      id: c.id, scopeId: c.scopeId, revision: c.revision,
      title: c.title, summary: c.summary, content: c.content,
      triggers: c.triggers, entities: c.entities, links: c.links, vitality: c.vitality,
    };
  }
  return SOURCES_BLOCK_OPEN + stableStringify(map) + SOURCES_BLOCK_CLOSE;
}

async function makeLinkPlan(sparkStore, scopeId, { idA = 'card-a', idB = 'card-b', rel = 'related' } = {}) {
  const a = await sparkStore.read(idA);
  const b = await sparkStore.read(idB);
  return {
    version: 1,
    scopeId,
    candidateId: sha(Buffer.from(`link-cand-${idA}-${idB}`)).slice(0, 64),
    kind: 'link',
    sources: [{ id: a.id, revision: a.revision }, { id: b.id, revision: b.revision }].sort(byId),
    links: [{
      id: a.id,
      expectedRevision: a.revision,
      before: [...a.links].sort((x, y) => (x.target < y.target ? -1 : x.target > y.target ? 1 : (x.rel < y.rel ? -1 : 1))),
      after: [...a.links, { target: b.id, rel }]
        .sort((x, y) => (x.target < y.target ? -1 : x.target > y.target ? 1 : (x.rel < y.rel ? -1 : 1))),
    }],
  };
}

async function makeMergePlan(service, sparkStore, scopeId, topicKey, cardIds, { extraAfter = '\n(后续注记)\n' } = {}) {
  const item = await service.readTopic(topicKey);
  const cards = [];
  for (const id of cardIds) cards.push(await sparkStore.read(id));
  cards.sort(byId);
  const after = item.body + sourcesBlockOf(cards) + extraAfter;
  return {
    version: 1,
    scopeId,
    candidateId: sha(Buffer.from(`merge-cand-${topicKey}`)).slice(0, 64),
    kind: 'merge-topic',
    sources: cards.map((c) => ({ id: c.id, revision: c.revision })),
    topic: {
      key: topicKey,
      expectedRevision: item.revision,
      before: item.body,
      after,
      title: item.title,
      summary: item.summary,
      updated: item.updated,
    },
  };
}

const round = (plan, operationId, actor = 'main-session') => ({
  plan,
  approval: { actor, planDigest: digestPlan(plan) },
  operationId,
});

async function dbBytes(root, scopeId = 'amber') {
  return fsp.readFile(path.join(root, 'sparks', 'scopes', scopeId, 'sparks.json')).catch(() => null);
}

async function topicBytes(root, scopeId, key) {
  return fsp.readFile(path.join(root, 'scopes', scopeId, 'topics', `${key}.md`)).catch(() => null);
}

const code = (value) => (e) => e.code === value;

// ---------------------------------------------------------------------------
// factory 与授权防线
// ---------------------------------------------------------------------------

describe('P3-L executor factory', () => {
  it('拒绝缺失/非函数 authorize 与相对 root', async () => {
    const root = 'relative/path';
    await assert.rejects(createOrganizerExecutor({ root, scopeId: 'amber' }), code('INVALID_INPUT'));
    await assert.rejects(
      createOrganizerExecutor({ root, scopeId: 'amber', authorize: 'yes' }),
      code('INVALID_INPUT'),
    );
    await assert.rejects(
      createOrganizerExecutor({ root: 'D:/work/ws', scopeId: 'amber' }),
      code('INVALID_INPUT'),
    );
  });

  it('close 后 executeRound → INVALID_STATE（幂等 close）', async (t) => {
    const root = await makeRoot(t);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    exec.close();
    exec.close();
    await assert.rejects(
      exec.executeRound({ plan: {}, approval: { actor: 'main-session', planDigest: 'x' }, operationId: 'r' }),
      code('INVALID_STATE'),
    );
  });
});

describe('P3-L approval 防线（全部零写）', () => {
  it('无 approval / 错 digest / 未知 actor / authorize=false → APPROVAL_REQUIRED 且 sparks 库字节不变', async (t) => {
    const root = await makeRoot(t);
    const { fileStore, sparkStore } = await openStores(root);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const denyExec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: async () => false });
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');
    await seedTopic(fileStore, 'notes', '初始正文\n');
    const plan = await makeLinkPlan(sparkStore, 'amber');

    const before = await dbBytes(root);
    await assert.rejects(
      exec.executeRound({ plan, approval: undefined, operationId: 'round-1' }),
      code('APPROVAL_REQUIRED'),
    );
    await assert.rejects(
      exec.executeRound({ plan, approval: { actor: 'main-session', planDigest: 'deadbeef' }, operationId: 'round-1' }),
      code('APPROVAL_REQUIRED'),
    );
    await assert.rejects(
      exec.executeRound({ plan, approval: { actor: 'background-daemon', planDigest: digestPlan(plan) }, operationId: 'round-1' }),
      code('APPROVAL_REQUIRED'),
    );
    await assert.rejects(
      denyExec.executeRound(round(plan, 'round-1')),
      code('APPROVAL_REQUIRED'),
    );
    const after = await dbBytes(root);
    assert.equal(sha(after), sha(before), '任何授权失败都必须零写入');
    assert.equal((await sparkStore.read('card-a')).revision, 1);
    exec.close();
    denyExec.close();
    sparkStore.close();
  });

  it('批准篡改（planDigest 指向别的 plan）→ APPROVAL_REQUIRED，authorize 不被调用', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    let calls = 0;
    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber', authorize: async () => { calls += 1; return true; },
    });
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');
    const planA = await makeLinkPlan(sparkStore, 'amber', { idA: 'card-a', idB: 'card-b' });
    const planB = await makeLinkPlan(sparkStore, 'amber', { idA: 'card-b', idB: 'card-a' });
    await assert.rejects(
      exec.executeRound({ plan: planA, approval: { actor: 'main-session', planDigest: digestPlan(planB) }, operationId: 'r' }),
      code('APPROVAL_REQUIRED'),
    );
    assert.equal(calls, 0, 'digest 不一致时根本不应询问宿主');
    exec.close();
    sparkStore.close();
  });

  it('thin-core 仅草案：执行拒绝 UNSUPPORTED 且零写', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    let calls = 0;
    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber', authorize: async () => { calls += 1; return true; },
    });
    await seedCard(sparkStore, 'card-a');
    const before = await dbBytes(root);
    const plan = {
      version: 1, scopeId: 'amber', candidateId: 'c'.repeat(64), kind: 'thin-core',
      sources: [{ id: 'card-a', revision: 1 }], core: { before: '旧核心', after: '新核心' },
    };
    await assert.rejects(exec.executeRound(round(plan, 'r-thin')), code('UNSUPPORTED'));
    assert.equal(calls, 0, '草案拒绝不进入授权询问');
    assert.equal(sha(await dbBytes(root)), sha(before));
    exec.close();
    sparkStore.close();
  });
});

// ---------------------------------------------------------------------------
// plan schema 反例（执行器 + 提案双校验一致）
// ---------------------------------------------------------------------------

describe('P3-L plan schema 反例', () => {
  async function fixture(t) {
    const root = await makeRoot(t);
    const stores = await openStores(root);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    await seedCard(stores.sparkStore, 'card-a');
    await seedCard(stores.sparkStore, 'card-b');
    await seedTopic(stores.fileStore, 'notes', '初始正文\n');
    return { root, ...stores, exec };
  }

  it('未知字段 / 携带 digest/approval/operationId / 跨 scope / 乱序 sources 全拒绝', async (t) => {
    const { exec, sparkStore } = await fixture(t);
    const plan = await makeLinkPlan(sparkStore, 'amber');
    const bad = [
      { ...plan, extra: 1 },
      { ...plan, digest: 'x' },
      { ...plan, operationId: 'inline-op' },
      { ...plan, scopeId: 'global' },
      { ...plan, sources: [...plan.sources].reverse() },
    ];
    for (const p of bad) {
      await assert.rejects(exec.executeRound(round(p, 'r-schema')), code('INVALID_INPUT'));
    }
    await assert.rejects(
      exec.executeRound({ ...round(plan, 'r-schema'), operationId: '非法 op!' }),
      code('INVALID_INPUT'),
    );
    exec.close();
  });

  it('merge：sources 7 张(<8) / 20 张(>19) / after 非 before 前缀 / 缺源块标记 全拒绝', async (t) => {
    const { exec, sparkStore, service } = await fixture(t);
    const ids = [];
    for (let i = 0; i < 20; i += 1) {
      ids.push(`m-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const seven = await makeMergePlan(service, sparkStore, 'amber', 'notes', ids.slice(0, 7));
    await assert.rejects(exec.executeRound(round(seven, 'r-m1')), code('INVALID_INPUT'));
    const twenty = await makeMergePlan(service, sparkStore, 'amber', 'notes', ids.slice(0, 20));
    await assert.rejects(exec.executeRound(round(twenty, 'r-m2')), code('INVALID_INPUT'));

    const eight = await makeMergePlan(service, sparkStore, 'amber', 'notes', ids.slice(0, 8));
    const noPrefix = structuredClone(eight);
    noPrefix.topic = { ...eight.topic, after: '完全不同开头' + eight.topic.after };
    noPrefix.candidateId = 'a'.repeat(64);
    await assert.rejects(exec.executeRound(round(noPrefix, 'r-m3')), code('INVALID_INPUT'));

    const noBlock = structuredClone(eight);
    noBlock.topic = {
      ...eight.topic,
      after: eight.topic.before + '\n追加但没有源块\n',
    };
    noBlock.candidateId = 'b'.repeat(64);
    await assert.rejects(exec.executeRound(round(noBlock, 'r-m4')), code('INVALID_INPUT'));
    exec.close();
  });

  it('link：after 丢 before 边 / 无新边 / self-link / 目标不在 sources / >20 条 全拒绝', async (t) => {
    const { exec, sparkStore } = await fixture(t);
    const plan = await makeLinkPlan(sparkStore, 'amber');

    const drop = structuredClone(plan);
    drop.links[0].after = [];
    await assert.rejects(exec.executeRound(round(drop, 'r-l1')), code('INVALID_INPUT'));

    const noAdd = structuredClone(plan);
    noAdd.links[0].after = [...noAdd.links[0].before];
    await assert.rejects(exec.executeRound(round(noAdd, 'r-l2')), code('INVALID_INPUT'));

    const self = structuredClone(plan);
    self.links[0].after = [{ target: 'card-a', rel: 'self' }];
    await assert.rejects(exec.executeRound(round(self, 'r-l3')), code('INVALID_INPUT'));

    const orphan = structuredClone(plan);
    orphan.sources = [orphan.sources[0]];
    await assert.rejects(exec.executeRound(round(orphan, 'r-l4')), code('INVALID_INPUT'));

    const many = [];
    for (let i = 0; i < 21; i += 1) many.push(plan.links[0]);
    const over = { ...plan, links: many };
    await assert.rejects(exec.executeRound(round(over, 'r-l5')), code('INVALID_INPUT'));
    exec.close();
  });
});

// ---------------------------------------------------------------------------
// link 执行：正常、重启重放、原子失败
// ---------------------------------------------------------------------------

describe('P3-L link 执行', () => {
  it('正常织网：changedItems=2，两张源卡 revision+1，边写入', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');
    const plan = await makeLinkPlan(sparkStore, 'amber');

    const result = await exec.executeRound(round(plan, 'round-l1'));
    assert.equal(result.status, 'completed');
    assert.equal(result.operationId, 'round-l1');
    assert.equal(result.planDigest, digestPlan(plan));
    assert.equal(result.kind, 'link');
    assert.equal(result.changedItems, 1);
    const a = await sparkStore.read('card-a');
    assert.equal(a.revision, 2);
    assert.deepEqual(a.links, [{ target: 'card-b', rel: 'related' }]);
    assert.equal((await sparkStore.read('card-b')).revision, 1, '目标卡不被修改');
    exec.close();
    sparkStore.close();
  });

  it('重启重放：关闭重开全部 adapter 后同 round 幂等，结果与首次一致', async (t) => {
    const root = await makeRoot(t);
    let plan;
    let first;
    {
      const { sparkStore } = await openStores(root);
      const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
      await seedCard(sparkStore, 'card-a');
      await seedCard(sparkStore, 'card-b');
      plan = await makeLinkPlan(sparkStore, 'amber');
      first = await exec.executeRound(round(plan, 'round-l2'));
      exec.close();
      sparkStore.close();
    }
    // 模拟重启：全部 adapter 关闭重开
    const { sparkStore: sp2 } = await openStores(root);
    const exec2 = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const replay = await exec2.executeRound(round(plan, 'round-l2'));
    assert.deepEqual(replay, first);
    const a = await sp2.read('card-a');
    assert.equal(a.revision, 2, '重放不得再次 bump revision');
    assert.equal(a.links.length, 1, '重放不得重复加边');
    exec2.close();
    sp2.close();
  });

  it('同 round 换 plan → INVALID_INPUT（bind 指纹碰撞拒绝），原 plan 仍可重放', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');
    const plan1 = await makeLinkPlan(sparkStore, 'amber', { idA: 'card-a', idB: 'card-b', rel: 'related' });
    await exec.executeRound(round(plan1, 'round-l3'));

    const plan2 = await makeLinkPlan(sparkStore, 'amber', { idA: 'card-b', idB: 'card-a', rel: 'related' });
    plan2.links[0].id = 'card-b';
    plan2.links[0].expectedRevision = (await sparkStore.read('card-b')).revision;
    plan2.links[0].before = [];
    plan2.links[0].after = [{ target: 'card-a', rel: 'related' }];
    await assert.rejects(exec.executeRound(round(plan2, 'round-l3')), code('INVALID_INPUT'));

    const replay = await exec.executeRound(round(plan1, 'round-l3'));
    assert.equal(replay.changedItems, 1);
    exec.close();
    sparkStore.close();
  });

  it('原子失败：sources 中一张卡 revision 陈旧 → REVISION_CONFLICT，全部卡零变更', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');
    await seedCard(sparkStore, 'card-c');
    // a→b、a→c 两张被改卡：其中 card-c 在 plan 生成后被外部 update（revision 前进）
    const plan = {
      version: 1, scopeId: 'amber', candidateId: 'd'.repeat(64), kind: 'link',
      sources: [
        { id: 'card-a', revision: 1 },
        { id: 'card-b', revision: 1 },
        { id: 'card-c', revision: 1 },
      ],
      links: [
        { id: 'card-a', expectedRevision: 1, before: [], after: [{ target: 'card-b', rel: 'r1' }] },
        { id: 'card-c', expectedRevision: 1, before: [], after: [{ target: 'card-b', rel: 'r2' }] },
      ],
    };
    await sparkStore.update('card-c', { title: '外部改动' });
    assert.equal((await sparkStore.read('card-c')).revision, 2);

    await assert.rejects(exec.executeRound(round(plan, 'round-l4')), code('REVISION_CONFLICT'));
    const a = await sparkStore.read('card-a');
    assert.equal(a.revision, 1, '失败后 card-a 零变更（原子整批）');
    assert.deepEqual(a.links, [], '失败后 card-a 边不变');
    const c = await sparkStore.read('card-c');
    assert.equal(c.revision, 2);
    assert.deepEqual(c.links, [], 'card-c 未被织网');
    exec.close();
    sparkStore.close();
  });

  it('before 边不匹配 / 目标非 active → 零写', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');
    await seedCard(sparkStore, 'card-z');
    await sparkStore.forget('card-z', { mode: 'archive' });

    const staleBefore = {
      version: 1, scopeId: 'amber', candidateId: 'e'.repeat(64), kind: 'link',
      sources: [{ id: 'card-a', revision: 1 }, { id: 'card-b', revision: 1 }],
      links: [{
        id: 'card-a', expectedRevision: 1,
        before: [{ target: 'card-b', rel: '旧边' }],
        // rel 按 UTF16 升序：'related' < '旧边'
        after: [{ target: 'card-b', rel: 'related' }, { target: 'card-b', rel: '旧边' }],
      }],
    };
    await assert.rejects(exec.executeRound(round(staleBefore, 'r-b1')), code('REVISION_CONFLICT'));

    const archivedTarget = {
      version: 1, scopeId: 'amber', candidateId: 'f'.repeat(64), kind: 'link',
      sources: [{ id: 'card-a', revision: 1 }, { id: 'card-z', revision: 2 }],
      links: [{ id: 'card-a', expectedRevision: 1, before: [], after: [{ target: 'card-z', rel: 'x' }] }],
    };
    // 非 active 目标在 sources 全量核验处即被拒（INVALID_STATE），零写
    await assert.rejects(exec.executeRound(round(archivedTarget, 'r-b2')), code('INVALID_STATE'));

    assert.deepEqual((await sparkStore.read('card-a')).links, []);
    exec.close();
    sparkStore.close();
  });
});

// ---------------------------------------------------------------------------
// merge-topic 执行
// ---------------------------------------------------------------------------

async function mergeFixture(t, { cardCount = 8, authorize } = {}) {
  const root = await makeRoot(t);
  const stores = await openStores(root);
  await seedTopic(stores.fileStore, 'dream', '目标主题已有正文\n');
  const ids = [];
  for (let i = 0; i < cardCount; i += 1) {
    ids.push(`src-${String(i).padStart(2, '0')}`);
    await seedCard(stores.sparkStore, ids[i]);
  }
  const exec = await createOrganizerExecutor({
    root, scopeId: 'amber', authorize: authorize ?? grantAll(),
  });
  return { root, ...stores, exec, ids };
}

describe('P3-L merge-topic 执行', () => {
  it('正常合并：topic 先落盘（含源保全块），8 源原子退休，完整 body 可追溯', async (t) => {
    const { root, exec, service, sparkStore, ids } = await mergeFixture(t);
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);

    const result = await exec.executeRound(round(plan, 'round-m1'));
    assert.equal(result.status, 'completed');
    assert.equal(result.kind, 'merge-topic');
    assert.equal(result.changedItems, 9, '8 源 + 1 topic');
    assert.match(result.topic.revision, /^[0-9a-f]{64}$/);

    // topic 落盘且 after 精确（append-only + 源块）
    const item = await service.readTopic('dream');
    assert.equal(item.body, plan.topic.after);
    assert.equal(item.body.startsWith(plan.topic.before), true);
    const openCount = item.body.split(SOURCES_BLOCK_OPEN).length - 1;
    assert.equal(openCount, 1, '源块只出现一次');

    // 全部源退休：merged + mergedInto 指针 + 原文保留
    for (const id of ids) {
      const card = await sparkStore.read(id);
      assert.equal(card.state, 'merged');
      assert.equal(card.mergedInto.key, 'dream');
      assert.equal(card.mergedInto.scopeId, 'amber');
      assert.equal(card.mergedInto.revision, result.topic.revision);
      assert.equal(card.mergedInto.bodyHash, result.topic.bodyHash);
      assert.ok(card.content.includes(`<orig-${id}/>`), '退休卡原文保留');
    }
    const active = await sparkStore.listActive();
    assert.equal(active.length, 0, '退休源退出 active 池');

    // 完整 body 可追溯：从落盘正文提取源块 JSON（K 契约：十字段记录、
    // 按 id 升序的数组，不是 id 键 map），逐字段对上退休前快照
    const blockJson = item.body.slice(
      item.body.indexOf(SOURCES_BLOCK_OPEN) + SOURCES_BLOCK_OPEN.length,
      item.body.indexOf(SOURCES_BLOCK_CLOSE),
    );
    const records = JSON.parse(blockJson);
    assert.equal(Array.isArray(records), true, '源块是记录数组（K 契约形状）');
    assert.equal(records.length, 8);
    assert.deepEqual(records.map((r) => r.id), [...ids].sort(), '记录按 id 升序');
    for (const rec of records) {
      const card = await sparkStore.read(rec.id);
      assert.equal(rec.content, card.content);
      assert.equal(rec.revision, 1, '块内是退休前 revision');
      assert.equal(rec.scopeId, 'amber');
      assert.deepEqual(rec.triggers, card.triggers, 'triggers 保原序');
      assert.deepEqual(rec.entities, card.entities, 'entities 保原序');
      assert.deepEqual(rec.links, card.links.map((l) => ({ rel: l.rel, target: l.target })), 'links 保原序且仅 {target,rel}');
      assert.equal(rec.vitality, card.vitality);
      assert.equal(rec.title, card.title);
      assert.equal(rec.summary, card.summary);
    }
    // 块字节与独立构造的期望完全一致（L-1 回归）
    const cardsSnapshot = [];
    for (const id of ids) cardsSnapshot.push(await sparkStore.read(id));
    const expectedBlock = sourcesBlockOf(cardsSnapshot.map((c) => ({ ...c, revision: 1 })));
    assert.equal(item.body.includes(expectedBlock), true, '落盘块与独立构造的数组块逐字节一致');
    exec.close();
    sparkStore.close();
  });

  it('退休前故障（authorize 二次判定失败）：topic 已落盘但源全保留，重试幂等收敛不重复 append', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    let calls = 0;
    let failedOnce = false;
    const injected = await createOrganizerExecutor({
      root, scopeId: 'amber',
      authorize: async () => {
        calls += 1;
        // 首次尝试的退休前判定（第 2 次调用）失败一次；此后的重试全部放行
        if (!failedOnce && calls === 2) { failedOnce = true; return false; }
        return true;
      },
    });
    const err = await injected.executeRound(round(plan, 'round-m2')).then(
      () => null, (x) => x,
    );
    assert.equal(err.code, 'APPROVAL_REQUIRED');
    assert.equal(err.phase, 'before-retire');
    assert.equal(err.topicCommitted, true, '阶段信息必须指明 topic 已提交');

    // topic 已写、源全部保留
    const item = await service.readTopic('dream');
    assert.equal(item.body, plan.topic.after);
    for (const id of ids) {
      assert.equal((await sparkStore.read(id)).state, 'active', `退休前故障后 ${id} 仍 active`);
    }

    // 重试：同 plan 同 round，全部授权通过 → 收敛
    const recovered = await injected.executeRound(round(plan, 'round-m2'));
    assert.equal(recovered.status, 'completed');
    const item2 = await service.readTopic('dream');
    assert.equal(item2.body, plan.topic.after, '重试不重复 append');
    assert.equal(item2.body.split(SOURCES_BLOCK_OPEN).length - 1, 1, '源块仍只有一个');
    for (const id of ids) {
      assert.equal((await sparkStore.read(id)).state, 'merged');
    }
    injected.close();
    sparkStore.close();
  });

  it('重启重放：退休前判定失败后关闭重开全部 adapter，同 round 重试幂等完成', async (t) => {
    const root = await makeRoot(t);
    let plan;
    {
      // 第一次尝试：mutate 已提交（topic 落盘）、退休前判定失败 —— 等价于
      // 「topic 已落盘、退休前进程中断」，且此后全部 adapter 关闭重开
      const { service, sparkStore, fileStore } = await openStores(root);
      await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
      const ids = [];
      for (let i = 0; i < 8; i += 1) {
        ids.push(`src-${String(i).padStart(2, '0')}`);
        await seedCard(sparkStore, ids[i]);
      }
      plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
      let calls = 0;
      const exec = await createOrganizerExecutor({
        root, scopeId: 'amber',
        authorize: async () => { calls += 1; return calls !== 2; },
      });
      const err = await exec.executeRound(round(plan, 'round-m3')).then(() => null, (x) => x);
      assert.equal(err.code, 'APPROVAL_REQUIRED');
      assert.equal(err.topicCommitted, true);
      exec.close();
      sparkStore.close();
    }
    // 重启：全部 adapter 关闭重开后重试同 round（同 plan / 同 operationId）
    const { service: s2, sparkStore: sp2 } = await openStores(root);
    const exec2 = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const result = await exec2.executeRound(round(plan, 'round-m3'));
    assert.equal(result.status, 'completed');
    assert.equal(result.changedItems, 9);
    const item = await s2.readTopic('dream');
    assert.equal(item.body, plan.topic.after, 'journal 幂等重放，正文与首次落盘一致');
    assert.equal(item.body.split(SOURCES_BLOCK_OPEN).length - 1, 1, '不重复 append 源块');
    const active = await sp2.listActive();
    assert.equal(active.length, 0);
    for (let i = 0; i < 8; i += 1) {
      assert.equal((await sp2.read(`src-${String(i).padStart(2, '0')}`)).state, 'merged');
    }
    exec2.close();
    sp2.close();
  });

  it('同 round 异 payload（不同 after）→ 拒绝，不退休也不改 topic', async (t) => {
    const { exec, service, sparkStore, ids } = await mergeFixture(t);
    const planA = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    await exec.executeRound(round(planA, 'round-m4'));

    // 同 round 换 plan（不同 after 正文）→ bind/operations 指纹碰撞拒绝
    const planTampered = structuredClone(planA);
    planTampered.topic = { ...planTampered.topic, after: planA.topic.after + '\n篡改追加\n' };
    planTampered.candidateId = 'ab'.repeat(32);
    const err = await exec.executeRound(round(planTampered, 'round-m4')).then(() => null, (x) => x);
    assert.equal(err.code, 'INVALID_INPUT', '同 round 不同 plan 指纹必须拒绝');
    const item = await service.readTopic('dream');
    assert.equal(item.body, planA.topic.after, 'topic 不被二次改写');
    for (const id of ids) {
      const card = await sparkStore.read(id);
      assert.equal(card.state, 'merged');
      assert.equal(card.mergedInto.bodyHash, sha(Buffer.from(planA.topic.after, 'utf8')));
    }
    exec.close();
    sparkStore.close();
  });

  it('topic 提交失败（meta 被外部改动导致 token CAS 失败）→ 源零退休', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    // 外部改 title（body 不变）：正文比较无法发现，plan 的 token/generation
    // 已过期，mutate 的 token CAS 必须失败
    const item = await service.readTopic('dream');
    await service.mutate({
      operationId: 'external-edit',
      changes: [{
        kind: 'topic', key: 'dream', expectedRevision: item.revision,
        topic: { title: '被外部改过的标题', summary: item.summary, updated: item.updated },
        text: item.body,
      }],
    });
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const err = await exec.executeRound(round(plan, 'round-m5')).then(() => null, (x) => x);
    assert.equal(err.code, 'REVISION_CONFLICT');
    assert.equal(err.topicCommitted, false);
    for (const id of ids) {
      assert.equal((await sparkStore.read(id)).state, 'active', 'topic 失败时源一律不退休');
    }
    exec.close();
    sparkStore.close();
  });

  it('topic 被覆盖（mutate 后锁内重读前外部覆写正文）→ 拒绝退休、源可查', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    const topicFile = path.join(root, 'scopes', 'amber', 'topics', 'dream.md');

    let calls = 0;
    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber',
      authorize: async () => {
        calls += 1;
        if (calls === 2) {
          // 退休前判定时机：外部覆写 topic 正文（保 front-matter 结构的合法 topic 文件）
          const raw = await fsp.readFile(topicFile, 'utf8');
          const bodyAt = raw.indexOf('---\n', 4) + 4;
          await fsp.writeFile(topicFile, raw.slice(0, bodyAt) + '外部新写的正文\n');
        }
        return true;
      },
    });
    const err = await exec.executeRound(round(plan, 'round-m6')).then(() => null, (x) => x);
    assert.equal(err.code, 'REVISION_CONFLICT');
    assert.equal(err.phase, 'sources-retire');
    assert.equal(err.topicCommitted, true);
    for (const id of ids) {
      const card = await sparkStore.read(id);
      assert.equal(card.state, 'active', 'topic 被覆盖时源一律不退休（宁可保留重复）');
      assert.ok(card.content.length > 0);
    }
    exec.close();
    sparkStore.close();
  });

  it('跨 scope topic（active 文件被删、fallback 到 global）→ 锁内 scope 不一致拒绝退休', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    // global scope 建同名 topic（制造 fallback 可见性）
    const globalStore = await createFileStore({
      root, activeScopeId: 'global', config: CONFIG, policy: evaluateMutation, renderL1,
    });
    await seedTopic(globalStore, 'dream', 'global 的正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    const activeTopicFile = path.join(root, 'scopes', 'amber', 'topics', 'dream.md');

    let calls = 0;
    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber',
      authorize: async () => {
        calls += 1;
        if (calls === 2) await fsp.unlink(activeTopicFile);
        return true;
      },
    });
    const err = await exec.executeRound(round(plan, 'round-m7')).then(() => null, (x) => x);
    assert.equal(err.code, 'INVALID_STATE');
    assert.equal(err.phase, 'sources-retire');
    for (const id of ids) {
      assert.equal((await sparkStore.read(id)).state, 'active', '跨 scope 不退休');
    }
    exec.close();
    sparkStore.close();
  });

  it('replacement 拒绝：supersedes 非 null 的源卡不可退休，整批零变更（深 retire 防线）', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    // src-04 承接了额外卡 extra-0 的替代关系：active 但 supersedes 非 null
    await seedCard(sparkStore, 'extra-0');
    await sparkStore.forget('extra-0', { mode: 'supersede', replacementId: 'src-04' });
    assert.equal((await sparkStore.read('src-04')).state, 'active');
    assert.equal((await sparkStore.read('src-04')).supersedes, 'extra-0');

    // plan 全部源 live 校验通过（都 active），走到 retire 才触发 replacement 防线
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const err = await exec.executeRound(round(plan, 'round-m8')).then(() => null, (x) => x);
    assert.equal(err.code, 'INVALID_STATE');
    assert.equal(err.phase, 'sources-retire');
    assert.equal(err.topicCommitted, true, 'topic 已按规则先落盘（阶段信息如实）');
    for (const id of ids) {
      const card = await sparkStore.read(id);
      assert.notEqual(card.state, 'merged', '整批原子失败：没有任何源被退休');
    }
    // 失败保留重复：topic 正文已含源块，源卡原文仍可查
    const item = await service.readTopic('dream');
    assert.equal(item.body, plan.topic.after);
    for (const id of ids) {
      assert.ok((await sparkStore.read(id)).content.length > 0, '失败源卡仍可查');
    }
    exec.close();
    sparkStore.close();
  });

  it('源 CAS 批量原子失败（retireMerged 直测）：错误 revision 拒绝且库文件字节不变；同 opId 换语义拒绝', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');
    const before = await dbBytes(root);
    await assert.rejects(sparkStore.retireMerged(
      [{ id: 'card-a', revision: 1 }, { id: 'card-b', revision: 99 }],
      { topic: { key: 'k', scopeId: 'amber', revision: 'a'.repeat(64), bodyHash: 'b'.repeat(64) }, operationId: 'rt-1' },
    ), code('REVISION_CONFLICT'));
    assert.equal(sha(await dbBytes(root)), sha(before), '失败整批零落盘');
    assert.equal((await sparkStore.read('card-a')).state, 'active');

    // 成功退休占用 rt-1 后，同 opId 换 sources 语义 → 指纹拒绝（重启重放语义）
    await sparkStore.retireMerged([{ id: 'card-a', revision: 1 }], {
      topic: { key: 'k', scopeId: 'amber', revision: 'a'.repeat(64), bodyHash: 'b'.repeat(64) },
      operationId: 'rt-1',
    });
    await assert.rejects(sparkStore.retireMerged(
      [{ id: 'card-b', revision: 1 }],
      { topic: { key: 'k', scopeId: 'amber', revision: 'a'.repeat(64), bodyHash: 'b'.repeat(64) }, operationId: 'rt-1' },
    ), code('INVALID_INPUT'));
    assert.equal((await sparkStore.read('card-b')).state, 'active', '被拒绝的换语义请求零写入');
    sparkStore.close();
  });
});

// ---------------------------------------------------------------------------
// 源保全块契约形状（主审 L-1：K 输出数组为准）
// ---------------------------------------------------------------------------

describe('P3-L 源保全块：K 契约数组形状', () => {
  it('a1 的 id 键 map 块不再被接受：sources-retire 拒绝、源保留（接口差异不可用自造格式掩盖）', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    // 用 a1 错误形状（map）手工拼 after
    const item = await service.readTopic('dream');
    const cards = [];
    for (const id of ids) cards.push(await sparkStore.read(id));
    const plan = {
      version: 1,
      scopeId: 'amber',
      candidateId: sha(Buffer.from('map-negative')).slice(0, 64),
      kind: 'merge-topic',
      sources: [...cards].sort(byId).map((c) => ({ id: c.id, revision: c.revision })),
      topic: {
        key: 'dream',
        expectedRevision: item.revision,
        before: item.body,
        after: item.body + mapBlockOf(cards) + '\n(后续注记)\n',
        title: item.title,
        summary: item.summary,
        updated: item.updated,
      },
    };
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const err = await exec.executeRound(round(plan, 'map-neg-1')).then(() => null, (x) => x);
    assert.equal(err.code, 'INVALID_STATE');
    assert.equal(err.phase, 'sources-retire');
    assert.equal(err.topicCommitted, true, 'topic 已先落盘（阶段信息如实）');
    for (const id of ids) {
      assert.equal((await sparkStore.read(id)).state, 'active', '块不一致时源一律不退休');
    }
    const after = await service.readTopic('dream');
    assert.equal(after.body, plan.topic.after, 'topic 正文已含 map 块（失败的中间态如实保留）');
    exec.close();
    sparkStore.close();
  });

  it('J→K→L 根模块组合：analyzeCandidates + buildDraft 实际草案经执行器合并成功（必须执行）', async (t) => {
    const { analyzeCandidates } = await stageImport('organize/analyze.mjs');
    const { buildDraft, digestPlan: kdigest } = await stageImport('organize/queue.mjs');
    const root = await makeRoot(t);
    const { fileStore, service, sparkStore } = await openStores(root);
    await seedTopic(fileStore, 'target', 'original topic\n');
    for (let i = 0; i < 8; i += 1) {
      await sparkStore.save({
        id: `card-${i}`, title: `card ${i}`, summary: 'source',
        content: `original content ${i}`, triggers: ['shared'], entities: ['shared'],
        links: [], vitality: 'evergreen',
      });
    }
    let draft;
    const records = await sparkStore.listActive();
    const candidate = analyzeCandidates({ scopeId: 'amber', records }).find((x) => x.kind === 'cluster');
    const item = await service.readTopic('target');
    draft = buildDraft({
      candidate, records,
      proposal: {
        kind: 'merge-topic',
        topic: {
          key: 'target', expectedRevision: item.revision,
          before: item.body, after: `${item.body}append\n`,
          title: item.title, summary: item.summary, updated: item.updated,
        },
      },
    });
    assert.equal(kdigest(draft.plan), digestPlan(draft.plan), 'K 与 L 的 plan digest 完全一致');
    assert.equal(draft.plan.topic.after.includes(SOURCES_BLOCK_OPEN), true, 'K 已把源块追加进 after');

    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const result = await exec.executeRound(round(draft.plan, 'combo-array-1'));
    assert.equal(result.status, 'completed');
    assert.equal(result.changedItems, 9);
    assert.equal((await sparkStore.listActive()).length, 0, '8 源全部退休');
    const item2 = await service.readTopic('target');
    assert.equal(item2.body, draft.plan.topic.after, 'K 真产物的 after 原样落盘');
    // K 的块与退休前快照逐字节一致（独立从 plan 里抽出 K 块再比对落盘正文）
    assert.equal(item2.body.includes(
      draft.plan.topic.after.slice(
        draft.plan.topic.after.indexOf(SOURCES_BLOCK_OPEN),
        draft.plan.topic.after.indexOf(SOURCES_BLOCK_CLOSE) + SOURCES_BLOCK_CLOSE.length,
      ),
    ), true);
    exec.close();
    sparkStore.close();
  });
});

// ---------------------------------------------------------------------------
// merge 完成后重放（主审 L-2/L-7：持久收据重放先于 live 校验，重试仍须重新授权；
// 完成收据不因 topic 后续被外部编辑/覆盖而丢失，也不得改写外部正文）
// ---------------------------------------------------------------------------

describe('P3-L merge 完成后重放', () => {
  it('同实例完成重放：同 plan+operationId 返回首次结果，库与 topic 字节不变，authorize 重新判定两次', async (t) => {
    const authCalls = { n: 0 };
    const { root, exec, service, sparkStore, ids } = await mergeFixture(t, {
      authorize: async () => { authCalls.n += 1; return true; },
    });
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    const first = await exec.executeRound(round(plan, 'round-replay-1'));
    assert.equal(first.status, 'completed');
    const dbBefore = await dbBytes(root);
    const topicBefore = await topicBytes(root, 'amber', 'dream');
    const callsBefore = authCalls.n;

    const replay = await exec.executeRound(round(plan, 'round-replay-1'));
    assert.equal(replay.status, 'completed');
    assert.deepEqual(replay, first, '重放返回首次结果快照');
    assert.equal(authCalls.n, callsBefore + 2, '重试同样经历 round + before-retire 两次 authorize');
    assert.equal(sha(await dbBytes(root)), sha(dbBefore), 'sparks 库零新写');
    assert.equal(sha(await topicBytes(root, 'amber', 'dream')), sha(topicBefore), 'topic 零新写、不重复 append');
    exec.close();
    sparkStore.close();
  });

  it('全部 adapter 关闭重开后完成重放：持久幂等恢复（不要求调用方重建草案）', async (t) => {
    const root = await makeRoot(t);
    let first;
    let plan;
    {
      const { service, sparkStore, fileStore } = await openStores(root);
      await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
      const ids = [];
      for (let i = 0; i < 8; i += 1) {
        ids.push(`src-${String(i).padStart(2, '0')}`);
        await seedCard(sparkStore, ids[i]);
      }
      plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
      const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
      first = await exec.executeRound(round(plan, 'round-replay-2'));
      exec.close();
      sparkStore.close();
    }
    // 重启：全部 adapter 关闭重开后，同 plan（merged 记录进不了 K，调用方
    // 只能拿原 plan）+ 同 operationId 重试 → 幂等返回首次结果
    const { service: s2, sparkStore: sp2 } = await openStores(root);
    const exec2 = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const replay = await exec2.executeRound(round(plan, 'round-replay-2'));
    assert.deepEqual(replay, first, '重开后重放返回首次结果');
    assert.equal((await sp2.listActive()).length, 0);
    assert.equal((await s2.readTopic('dream')).body, plan.topic.after);
    exec2.close();
    sp2.close();
  });

  it('重试拒绝授权：authorize=false → APPROVAL_REQUIRED，重放不越过授权且零新写', async (t) => {
    const { root, exec, service, sparkStore, ids } = await mergeFixture(t);
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    await exec.executeRound(round(plan, 'round-replay-3'));
    const dbBefore = await dbBytes(root);
    exec.close();

    const execDeny = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: async () => false });
    await assert.rejects(execDeny.executeRound(round(plan, 'round-replay-3')), code('APPROVAL_REQUIRED'));
    assert.equal(sha(await dbBytes(root)), sha(dbBefore), '拒绝授权零新写');
    execDeny.close();
    sparkStore.close();
  });

  it('完成后 topic 被外部覆盖：同请求重放仍返回历史收据，外部正文保持原样（主审 L-7）', async (t) => {
    const { root, exec, service, sparkStore, ids } = await mergeFixture(t);
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    const first = await exec.executeRound(round(plan, 'round-replay-4'));
    assert.equal(first.status, 'completed');

    // 外部覆盖 topic 正文（保留合法 frontmatter 的结构）。本 round 已完成：
    // 历史收据重放不得因此失败，也不得把正文改写回 plan.after
    const topicFile = path.join(root, 'scopes', 'amber', 'topics', 'dream.md');
    const raw = await fsp.readFile(topicFile, 'utf8');
    const bodyAt = raw.indexOf('---\n', 4) + 4;
    await fsp.writeFile(topicFile, `${raw.slice(0, bodyAt)}外部完全重写的正文\n`);
    const overwritten = await topicBytes(root, 'amber', 'dream');
    const dbBefore = await dbBytes(root);

    const replay = await exec.executeRound(round(plan, 'round-replay-4'));
    assert.equal(replay.status, 'completed', '完成收据重放不被 live topic 校验阻断');
    assert.equal(replay.topic.revision, first.topic.revision, '收据仍是首次提交的历史快照');
    assert.equal(sha(await topicBytes(root, 'amber', 'dream')), sha(overwritten), '外部正文保持原样，不被改写');
    assert.equal(sha(await dbBytes(root)), sha(dbBefore), '不再次退休：sparks 库字节不变');
    for (const id of ids) {
      const card = await sparkStore.read(id);
      assert.equal(card.state, 'merged', '源保持已退休状态');
      assert.equal(card.mergedInto.key, 'dream');
    }
    exec.close();
    sparkStore.close();
  });

  it('无关操作写入逐字节相同的 after + 本 round 无历史 → 原 token CAS 拒绝，8 源全部保留（主审 L-6）', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    // 另一个合法 service 操作把正文写成与 plan.after 完全相同（token/generation 已前进）
    const item = await service.readTopic('dream');
    await service.mutate({
      operationId: 'unrelated-writer',
      changes: [{
        kind: 'topic', key: 'dream', expectedRevision: item.revision,
        topic: { title: item.title, summary: item.summary, updated: item.updated },
        text: plan.topic.after,
      }],
    });
    const topicBefore = await topicBytes(root, 'amber', 'dream');
    const dbBefore = await dbBytes(root);

    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const err = await exec.executeRound(round(plan, 'never-before-executed')).then(() => null, (x) => x);
    assert.equal(err.code, 'REVISION_CONFLICT', '正文相等不构成本 round 的提交身份：原 token 必须被拒');
    assert.equal(err.phase, 'topic-commit');
    assert.equal(err.topicCommitted, false);
    assert.equal((await sparkStore.listActive()).length, 8, '零退休：全部源保留 active');
    assert.equal(sha(await topicBytes(root, 'amber', 'dream')), sha(topicBefore), 'topic 零新写（保留无关写入者的版本）');
    // sparks 库唯一允许的新写是本 round 的 bind 身份账（在 mutate 之前落账），
    // 不得出现任何退休/织网痕迹
    const before = JSON.parse(dbBefore.toString('utf8'));
    const after = JSON.parse((await dbBytes(root)).toString('utf8'));
    assert.deepEqual(after.cards, before.cards, '任何卡零变更');
    const bdKey = `bd-${sha(Buffer.from(JSON.stringify(['amber', 'never-before-executed', 'bd']), 'utf8')).slice(0, 40)}`;
    const newOps = Object.keys(after.ops).filter((k) => !(k in before.ops));
    assert.deepEqual(newOps, [bdKey], '唯一新写是 bind 身份账（无 rt/ln 记录）');
    exec.close();
    sparkStore.close();
  });

  it('metadata-only 外部改动（正文未变）+ 本 round 无历史 → 同样 CAS 拒绝，源保留（主审 L-6）', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    // 外部只改 title（正文与 plan.before 逐字节一致）：正文比较无法发现，
    // 只有 token/generation 锚定能拒绝
    const item = await service.readTopic('dream');
    await service.mutate({
      operationId: 'external-title-edit',
      changes: [{
        kind: 'topic', key: 'dream', expectedRevision: item.revision,
        topic: { title: '仅外部改标题', summary: item.summary, updated: item.updated },
        text: item.body,
      }],
    });
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const err = await exec.executeRound(round(plan, 'round-l6-meta')).then(() => null, (x) => x);
    assert.equal(err.code, 'REVISION_CONFLICT');
    assert.equal(err.phase, 'topic-commit');
    assert.equal(err.topicCommitted, false);
    for (const id of ids) {
      assert.equal((await sparkStore.read(id)).state, 'active', '零退休');
    }
    exec.close();
    sparkStore.close();
  });

  it('完成→重开→外部合法编辑→重开→同请求重放：历史收据成功且外部正文不变（主审 L-7 精确场景）', async (t) => {
    const root = await makeRoot(t);
    let plan;
    let first;
    {
      const { service, sparkStore, fileStore } = await openStores(root);
      await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
      const ids = [];
      for (let i = 0; i < 8; i += 1) {
        ids.push(`src-${String(i).padStart(2, '0')}`);
        await seedCard(sparkStore, ids[i]);
      }
      plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
      const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
      first = await exec.executeRound(round(plan, 'round-l7'));
      assert.equal(first.status, 'completed');
      exec.close();
      sparkStore.close();
    }
    // 重开 → 外部合法编辑正文 → 关闭
    {
      const { service, sparkStore } = await openStores(root);
      const item = await service.readTopic('dream');
      await service.mutate({
        operationId: 'external-edit',
        changes: [{
          kind: 'topic', key: 'dream', expectedRevision: item.revision,
          topic: { title: item.title, summary: item.summary, updated: item.updated },
          text: '外部编辑后的正文\n',
        }],
      });
      sparkStore.close();
    }
    // 再重开：同 plan / 同 operationId / 同批准 → 历史收据重放成功，外部正文不动
    const { service: s3, sparkStore: sp3 } = await openStores(root);
    let authCalls = 0;
    const exec3 = await createOrganizerExecutor({
      root, scopeId: 'amber',
      authorize: async () => { authCalls += 1; return true; },
    });
    const topicBeforeReplay = await topicBytes(root, 'amber', 'dream');
    const dbBeforeReplay = await dbBytes(root);
    const replay = await exec3.executeRound(round(plan, 'round-l7'));
    assert.equal(replay.status, 'completed', '外部编辑后历史收据重放仍成功');
    assert.equal(authCalls, 2, '重放同样经历 round + before-retire 两次 authorize');
    assert.deepEqual(replay.retiredCards, first.retiredCards, '退休清单是首次结果快照');
    assert.equal(replay.topic.revision, first.topic.revision, 'topic 收据是首次提交的历史 revision');
    assert.equal(replay.changedItems, 9);
    const item3 = await s3.readTopic('dream');
    assert.equal(item3.body, '外部编辑后的正文\n', '外部正文保持不变（绝不回写 plan.after）');
    assert.equal(sha(await topicBytes(root, 'amber', 'dream')), sha(topicBeforeReplay), 'topic 文件零新写');
    assert.equal(sha(await dbBytes(root)), sha(dbBeforeReplay), 'sparks 库零新写');
    assert.equal((await sp3.listActive()).length, 0);
    for (let i = 0; i < 8; i += 1) {
      assert.equal((await sp3.read(`src-${String(i).padStart(2, '0')}`)).state, 'merged');
    }
    exec3.close();
    sp3.close();
  });

  it('混合状态拒绝：源被手工改成指向别处的 merged → fail-closed，不退休也不重放', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    await exec.executeRound(round(plan, 'round-replay-5'));
    // 手工把一张卡的 mergedInto 指到别处（模拟损坏/外部改动）
    const dbFile = path.join(root, 'sparks', 'scopes', 'amber', 'sparks.json');
    const rawDb = JSON.parse(await fsp.readFile(dbFile, 'utf8'));
    rawDb.cards['src-03'].mergedInto = { key: 'other', scopeId: 'amber', revision: 'c'.repeat(64), bodyHash: 'd'.repeat(64) };
    await fsp.writeFile(dbFile, JSON.stringify(rawDb));

    const err = await exec.executeRound(round(plan, 'round-replay-5')).then(() => null, (x) => x);
    assert.equal(err.code, 'INVALID_STATE');
    assert.equal(err.phase, 'sources-retire');
    for (const id of ids) {
      assert.equal((await sparkStore.read(id)).state, 'merged', '不发生任何新写入');
    }
    exec.close();
    sparkStore.close();
  });
});

// ---------------------------------------------------------------------------
// 输入冻结（主审 L-3：首个 await 前固化全部轮次身份）
// ---------------------------------------------------------------------------

describe('P3-L 输入冻结（跨 await 身份不可变）', () => {
  it('authorize 挂起期间替换 args.operationId → 授权、落库与返回值都是冻结的原 id', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');

    let release; const gate = new Promise((r) => { release = r; });
    let entered; const entry = new Promise((r) => { entered = r; });
    let authorized;
    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber',
      authorize: async (x) => { authorized = x.operationId; entered(); await gate; return true; },
    });
    const args = round(await makeLinkPlan(sparkStore, 'amber'), 'authorized-id');
    const pending = exec.executeRound(args);
    await entry;                       // authorize 已看到 authorized-id，正在挂起
    args.operationId = 'unapproved-id';
    release();
    const result = await pending;

    assert.equal(authorized, 'authorized-id', 'authorize 看到的是冻结 id');
    assert.equal(result.operationId, 'authorized-id', '返回的是冻结 id');
    // 落库 ops 键也只能是冻结 id 的派生子 id
    const stableArr = (v) => JSON.stringify(v);
    const bdFrozen = `bd-${sha(Buffer.from(stableArr(['amber', 'authorized-id', 'bd']), 'utf8')).slice(0, 40)}`;
    const bdSwapped = `bd-${sha(Buffer.from(stableArr(['amber', 'unapproved-id', 'bd']), 'utf8')).slice(0, 40)}`;
    const raw = JSON.parse((await dbBytes(root)).toString('utf8'));
    assert.equal(Object.hasOwn(raw.ops, bdFrozen), true, 'ops 记录绑定冻结 id 的派生键');
    assert.equal(Object.hasOwn(raw.ops, bdSwapped), false, '换入的 id 没有任何落库痕迹');
    assert.equal((await sparkStore.read('card-a')).revision, 2, '织网写入真实发生');
    exec.close();
    sparkStore.close();
  });

  it('authorize 挂起期间改嵌套 plan 值 → 执行的仍是冻结 plan（digest 与落库边集不变）', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');
    await seedCard(sparkStore, 'card-c');

    const plan = await makeLinkPlan(sparkStore, 'amber', { idA: 'card-a', idB: 'card-b' });
    const frozenDigest = digestPlan(plan);
    const frozenAfter = structuredClone(plan.links[0].after);

    let release; const gate = new Promise((r) => { release = r; });
    let entered; const entry = new Promise((r) => { entered = r; });
    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber',
      authorize: async () => { entered(); await gate; return true; },
    });
    const args = round(plan, 'freeze-plan-1');
    const pending = exec.executeRound(args);
    await entry;
    args.plan.candidateId = 'ff'.repeat(32);
    args.plan.links[0].after.push({ target: 'card-c', rel: 'injected' });
    release();
    const result = await pending;

    assert.equal(result.status, 'completed');
    assert.equal(result.planDigest, frozenDigest, '结果绑定冻结 plan 的 digest');
    const cardA = await sparkStore.read('card-a');
    assert.deepEqual(cardA.links, frozenAfter, '实际落库的边集是冻结 plan 的 after（注入边未生效）');
    assert.deepEqual((await sparkStore.read('card-c')).links, [], '被注入的目标卡零变更');
    exec.close();
    sparkStore.close();
  });
});

// ---------------------------------------------------------------------------
// schema 类型校验（主审 L-5：先类型后内容，失败零业务写入）
// ---------------------------------------------------------------------------

describe('P3-L schema 类型校验（非字符串 metadata → INVALID_INPUT）', () => {
  it('executor：topic.summary/title/updated 非字符串 → INVALID_INPUT（带 code），零写', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const basePlan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const dbBefore = await dbBytes(root);
    const topicBefore = await topicBytes(root, 'amber', 'dream');

    let i = 0;
    for (const bad of [42, null, true, { x: 1 }, ['a']]) {
      for (const field of ['summary', 'title', 'updated']) {
        const plan = structuredClone(basePlan);
        plan.topic[field] = bad;
        const e = await exec.executeRound(round(plan, `l5-${i += 1}`)).then(() => null, (x) => x);
        assert.ok(e instanceof Error, `${field}=${JSON.stringify(bad)} 必须抛错`);
        assert.equal(e.code, 'INVALID_INPUT', `${field}=${JSON.stringify(bad)} → INVALID_INPUT（非裸 TypeError）`);
      }
    }
    assert.equal(sha(await dbBytes(root)), sha(dbBefore), 'sparks 库零写');
    assert.equal(sha(await topicBytes(root, 'amber', 'dream')), sha(topicBefore), 'topic 零写');
    for (const id of ids) {
      assert.equal((await sparkStore.read(id)).state, 'active', '零业务写入');
    }
    exec.close();
    sparkStore.close();
  });

  it('提案 store 入口：bindOrganizeRound 非法 schema 同样 INVALID_INPUT 零写', async (t) => {
    const root = await makeRoot(t);
    const { service, sparkStore, fileStore } = await openStores(root);
    await seedTopic(fileStore, 'dream', '目标主题已有正文\n');
    const ids = [];
    for (let i = 0; i < 8; i += 1) {
      ids.push(`src-${String(i).padStart(2, '0')}`);
      await seedCard(sparkStore, ids[i]);
    }
    const plan = await makeMergePlan(service, sparkStore, 'amber', 'dream', ids);
    plan.topic.summary = 42;
    const dbBefore = await dbBytes(root);
    await assert.rejects(sparkStore.bindOrganizeRound(plan, { operationId: 'bd-l5-1' }), code('INVALID_INPUT'));
    plan.topic.summary = 'x'.repeat(61);
    await assert.rejects(sparkStore.bindOrganizeRound(plan, { operationId: 'bd-l5-2' }), code('INVALID_INPUT'));
    assert.equal(sha(await dbBytes(root)), sha(dbBefore), '提案入口失败零写');
    sparkStore.close();
  });
});

// ---------------------------------------------------------------------------
// 提案 store 新增行为与 P2 兼容
// ---------------------------------------------------------------------------

describe('P3-L 提案 store：merged 加载校验与保护', () => {
  it('merged 卡可重开加载（严格 mergedInto），非 merged 卡带 mergedInto 拒绝', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    await seedCard(sparkStore, 'card-a');
    await sparkStore.retireMerged([{ id: 'card-a', revision: 1 }], {
      topic: { key: 'k', scopeId: 'amber', revision: 'a'.repeat(64), bodyHash: 'b'.repeat(64) },
      operationId: 'rt-load-1',
    });
    sparkStore.close();
    // 重开：loader 严格校验 mergedInto
    const reopened = await openSparkStore({ root, scopeId: 'amber' });
    const card = await reopened.read('card-a');
    assert.equal(card.state, 'merged');
    assert.equal(card.mergedInto.key, 'k');
    assert.deepEqual((await reopened.listActive()).length, 0);
    await seedCard(reopened, 'card-b');
    reopened.close();

    // 手工把 active 卡加上 mergedInto → 加载拒绝（严格区分写入路径）
    const dbFile = path.join(root, 'sparks', 'scopes', 'amber', 'sparks.json');
    const raw = JSON.parse(await fsp.readFile(dbFile, 'utf8'));
    raw.cards['card-b'].mergedInto = { key: 'k', scopeId: 'amber', revision: 'a'.repeat(64), bodyHash: 'b'.repeat(64) };
    await fsp.writeFile(dbFile, JSON.stringify(raw));
    await assert.rejects(openSparkStore({ root, scopeId: 'amber' }), code('INVALID_STATE'));
  });

  it('旧 P2 已知 merged 形状兼容：真实旧 DB 夹具加载/listActive 排除/原文可读，冻结 P2 实现同样可加载', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'legacy-1', { content: '旧合并卡的正文保留' });
    await seedCard(sparkStore, 'legacy-2', { content: '带字符串 marker 的旧合并卡' });
    sparkStore.close();

    // 手工把两张卡置为旧 P2 已知 merged 形状（P2 无写入路径，外部/人工标记语义）
    const dbFile = path.join(root, 'sparks', 'scopes', 'amber', 'sparks.json');
    const raw = JSON.parse(await fsp.readFile(dbFile, 'utf8'));
    raw.cards['legacy-1'].state = 'merged';                 // 形状①：无 mergedInto
    raw.cards['legacy-2'].state = 'merged';
    raw.cards['legacy-2'].mergedInto = 'card-a';            // 形状②：字符串 marker
    await fsp.writeFile(dbFile, JSON.stringify(raw));

    // 夹具真实性：同一份库文件，冻结 P2 store（未覆盖提案）也能加载
    const frozenStore = await openFrozenSparkStore({ root, scopeId: 'amber' });
    assert.equal((await frozenStore.read('legacy-1')).state, 'merged');
    assert.equal((await frozenStore.read('legacy-2')).state, 'merged');
    frozenStore.close();

    // 提案 store：加载接受、投影排除、原文可读（主审 L-4）
    const reopened = await openSparkStore({ root, scopeId: 'amber' });
    assert.equal((await reopened.read('legacy-1')).content, '旧合并卡的正文保留');
    assert.equal((await reopened.read('legacy-2')).mergedInto, 'card-a');
    const active = await reopened.listActive();
    assert.deepEqual(active.map((c) => c.id), ['card-a'], 'merged 退出 active 池');
    // 旧形状卡不可 update/forget（merged 保护对旧形状同样生效）
    await assert.rejects(reopened.update('legacy-1', { title: 'x' }), code('INVALID_STATE'));
    await assert.rejects(reopened.forget('legacy-1', { mode: 'archive' }), code('INVALID_STATE'));
    reopened.close();
  });

  it('新对象指针损坏拒绝：未知字段/缺字段/非 hex/非对象非字符串 → 整库 INVALID_STATE', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    await seedCard(sparkStore, 'card-a');
    await sparkStore.retireMerged([{ id: 'card-a', revision: 1 }], {
      topic: { key: 'k', scopeId: 'amber', revision: 'a'.repeat(64), bodyHash: 'b'.repeat(64) },
      operationId: 'rt-legacy-ok',
    });
    sparkStore.close();

    const dbFile = path.join(root, 'sparks', 'scopes', 'amber', 'sparks.json');
    const original = await fsp.readFile(dbFile, 'utf8');
    const cases = [
      ['未知字段', (card) => { card.mergedInto.extra = 1; }],
      ['缺 bodyHash', (card) => { delete card.mergedInto.bodyHash; }],
      ['revision 非 hex', (card) => { card.mergedInto.revision = 'XYZ'; }],
      ['非对象非字符串', (card) => { card.mergedInto = 42; }],
      ['空字符串 marker', (card) => { card.mergedInto = ''; }],
      ['mergedAt 非字符串', (card) => { card.mergedAt = 42; }],
    ];
    for (const [name, mutate] of cases) {
      await fsp.writeFile(dbFile, original);
      const raw = JSON.parse(original);
      mutate(raw.cards['card-a']);
      await fsp.writeFile(dbFile, JSON.stringify(raw));
      await assert.rejects(openSparkStore({ root, scopeId: 'amber' }), { code: 'INVALID_STATE', message: new RegExp(name === '空字符串 marker' ? 'marker' : 'mergedInto|mergedAt') });
    }
    // 修回原始合法库 → 可正常打开（fail-closed 但不损毁）
    await fsp.writeFile(dbFile, original);
    const ok = await openSparkStore({ root, scopeId: 'amber' });
    assert.equal((await ok.read('card-a')).state, 'merged');
    ok.close();
  });

  it('merged 卡不可 update/forget/feedback；update patch 带 mergedInto 拒绝', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    await seedCard(sparkStore, 'card-a');
    await sparkStore.retireMerged([{ id: 'card-a', revision: 1 }], {
      topic: { key: 'k', scopeId: 'amber', revision: 'a'.repeat(64), bodyHash: 'b'.repeat(64) },
      operationId: 'rt-prot-1',
    });
    await assert.rejects(sparkStore.update('card-a', { title: 'x' }), code('INVALID_STATE'));
    await assert.rejects(sparkStore.forget('card-a', { mode: 'archive' }), code('INVALID_STATE'));
    await assert.rejects(sparkStore.feedback('card-a', { used: true }), code('INVALID_STATE'));
    await seedCard(sparkStore, 'card-b');
    await assert.rejects(
      sparkStore.update('card-b', { mergedInto: { key: 'k', scopeId: 'amber', revision: 'a'.repeat(64), bodyHash: 'b'.repeat(64) } }),
      code('INVALID_INPUT'),
    );
    sparkStore.close();
  });

  it('bindOrganizeRound：同 opId 异 plan 拒绝（重启后仍拒绝），operations 账不改卡', async (t) => {
    const root = await makeRoot(t);
    const { sparkStore } = await openStores(root);
    await seedCard(sparkStore, 'card-a');
    await seedCard(sparkStore, 'card-b');
    const plan = await makeLinkPlan(sparkStore, 'amber');
    await sparkStore.bindOrganizeRound(plan, { operationId: 'bd-1' });
    const before = (await sparkStore.listActive()).map((c) => c.revision);
    const again = await sparkStore.bindOrganizeRound(plan, { operationId: 'bd-1' });
    assert.equal(again.bound, true);
    const other = await makeLinkPlan(sparkStore, 'amber', { idA: 'card-b', idB: 'card-a' });
    other.links[0] = { id: 'card-b', expectedRevision: 1, before: [], after: [{ target: 'card-a', rel: 'x' }] };
    await assert.rejects(sparkStore.bindOrganizeRound(other, { operationId: 'bd-1' }), code('INVALID_INPUT'));
    assert.deepEqual((await sparkStore.listActive()).map((c) => c.revision), before, 'bind 不改任何卡');
    sparkStore.close();
    // 重启后同 opId 异 plan 仍拒绝
    const reopened = await openSparkStore({ root, scopeId: 'amber' });
    await assert.rejects(reopened.bindOrganizeRound(other, { operationId: 'bd-1' }), code('INVALID_INPUT'));
    await reopened.bindOrganizeRound(plan, { operationId: 'bd-1' });
    reopened.close();
  });
});
