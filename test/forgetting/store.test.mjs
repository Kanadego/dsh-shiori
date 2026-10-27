// P4-N 定向测试：批量软归档 / 冷库列表 / 明确有用反馈（CONTRACTS §1/§3/§4）。
//
// 集成测试：复制当前项目生产 src/test/package 到临时 stage，不覆盖 store。
// 只复制历史 G a2 loader 对照夹具，保留全部定向断言与内嵌 P0-P3 回归。

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(HERE, '../..'); // 当前项目根（test/forgetting → 上两级）

const DAY = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00.000Z（合成时钟）
const T = (ms) => new Date(ms).toISOString();
const DEFAULT_POLICY = Object.freeze({ baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });

let stage = null;
let openSparkStore = null;

// ---------------------------------------------------------------------------
// 夹具（内联，不依赖基线 test helpers）
// ---------------------------------------------------------------------------

async function makeTmpRoot(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-p4n-' + randomBytes(4).toString('hex')));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });
  return dir;
}

const dbFileOf = (root, scopeId) => path.join(root, 'sparks', 'scopes', scopeId, 'sparks.json');
const dbBytes = async (root, scopeId) => fsp.readFile(dbFileOf(root, scopeId));
const dbJson = async (root, scopeId) => JSON.parse((await dbBytes(root, scopeId)).toString('utf8'));

const open = (root, scopeId, overrides = {}) => openSparkStore({ root, scopeId, ...overrides });

function cardInput(o = {}) {
  return {
    id: o.id ?? 'c-1',
    title: o.title ?? '合成测试卡',
    summary: o.summary ?? '合成摘要',
    content: o.content ?? '合成正文：仅用于遗忘测试，不含任何真实记忆。',
    triggers: o.triggers ?? ['合成'],
    entities: o.entities ?? ['测试'],
    links: o.links ?? [],
    vitality: o.vitality ?? 'ephemeral',
    ...o,
  };
}

const saveCard = (store, o = {}, opts) => store.save(cardInput(o), opts);

/** 由真实卡构造五字段 Source 快照。 */
const sourceOf = (card) => ({
  id: card.id,
  revision: card.revision,
  createdAt: card.createdAt,
  lastUsedAt: card.lastUsedAt ?? null,
  useCount: card.useCount,
});

function planOf(scopeId, cards, nowIso, policy, overrides = {}) {
  const plan = {
    version: 1,
    kind: 'archive-ephemeral',
    scopeId,
    now: nowIso,
    policy: policy ?? DEFAULT_POLICY,
    sources: cards.map(sourceOf),
  };
  return { ...plan, ...overrides };
}

/** 手写合法库种子：可精确控制 createdAt/lastUsedAt/useCount/state 等系统字段。 */
function handCard(o = {}) {
  return {
    id: o.id ?? 'h-1',
    revision: 1,
    title: o.title ?? '手写卡',
    summary: '',
    content: o.content ?? '手写合成正文',
    triggers: [],
    entities: [],
    links: [],
    vitality: 'ephemeral',
    state: 'active',
    createdAt: o.createdAt ?? T(EPOCH),
    updatedAt: o.updatedAt ?? T(EPOCH),
    archivedAt: null,
    supersedes: null,
    supersededBy: null,
    hitCount: 0,
    lastHitAt: null,
    useCount: 0,
    lastUsedAt: null,
    ...o,
  };
}

async function seedDb(t, root, scopeId, cards, extra = {}) {
  const db = {
    kind: 'shiori-sparks-scope',
    schemaVersion: 1,
    scopeId,
    generation: 0,
    cards: {},
    ops: {},
    feedback: {},
    ...extra,
  };
  for (const c of cards) db.cards[c.id] = { ...c, scopeId };
  const file = dbFileOf(root, scopeId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(db, null, 2)}\n`);
  return open(root, scopeId);
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

/** 归档后逐字段核对：除四处系统字段外全部原样。 */
function assertArchivedSnapshot(before, after, executedAt) {
  assert.equal(after.state, 'archived');
  assert.equal(after.archivedAt, executedAt);
  assert.equal(after.updatedAt, executedAt);
  assert.equal(after.revision, before.revision + 1);
  for (const key of [
    'id', 'scopeId', 'title', 'summary', 'content', 'triggers', 'entities', 'links',
    'vitality', 'createdAt', 'supersedes', 'supersededBy', 'hitCount', 'lastHitAt',
    'useCount', 'lastUsedAt', 'mergedInto', 'mergedAt',
  ]) {
    assert.deepEqual(after[key], before[key], `归档不得改动字段 "${key}"`);
  }
}

/** 运行 stage 内旧测试（真实子进程 node --test）。 */
/** 运行 stage 内旧测试（真实子进程 node --test）。
 * 须剥离子进程的 NODE_TEST_CONTEXT/NODE_TEST_TMP_DIR：否则父测试运行器
 * 会在子进程里留下「递归测试」标记，node --test 会跳过执行并只告警。 */
function runNodeTest(files, timeoutMs = 300_000) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_TMP_DIR;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: stage, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function stageTestFiles(dirs) {
  const files = [];
  for (const d of dirs) {
    const abs = path.join(stage, 'test', d);
    for (const e of (await fsp.readdir(abs)).sort()) {
      if (e.endsWith('.test.mjs')) files.push(path.join(abs, e));
    }
  }
  return files;
}

function tapCounts(out) {
  const grab = (re) => Number((out.match(re) || [])[1] ?? -1);
  return { tests: grab(/^# tests (\d+)$/m), pass: grab(/^# pass (\d+)$/m), fail: grab(/^# fail (\d+)$/m) };
}

// ---------------------------------------------------------------------------

describe('P4-N 已集成窄存储（temp stage 生产位置）', () => {
  before(async () => {
    stage = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-p4n-stage-'));
    for (const name of ['src', 'test']) {
      await fsp.cp(path.join(WORK, name), path.join(stage, name), { recursive: true });
    }
    await fsp.copyFile(path.join(WORK, 'package.json'), path.join(stage, 'package.json'));
    const fixture = 'phase3/collab/submissions/G/a2-226d3f0e-77ea-4a4c-b097-ad6483ebc806/files/src/sparks/store.mjs';
    await fsp.mkdir(path.dirname(path.join(stage, fixture)), { recursive: true });
    await fsp.copyFile(path.join(WORK, fixture), path.join(stage, fixture));
    ({ openSparkStore } = await import(pathToFileURL(path.join(stage, 'src', 'sparks', 'store.mjs')).href));
  });

  after(async () => {
    if (stage) {
      await fsp.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      stage = null;
    }
  });

  // ------------------------------------------------------------------
  describe('plan/opts 形状与类型校验（INVALID_INPUT）', () => {
    it('plan 非普通对象 / 六键不完整 / 未知键 / 越权键', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-a');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const good = planOf('sc-a', [card], nowIso);
      await assertRejects(store.archiveEphemeral(null, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral('plan', { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral([good], { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
      for (const key of ['version', 'kind', 'scopeId', 'now', 'policy', 'sources']) {
        const broken = { ...good };
        delete broken[key];
        await assertRejects(store.archiveEphemeral(broken, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
      }
      for (const badKey of ['digest', 'approval', 'operationId', 'extra']) {
        await assertRejects(store.archiveEphemeral({ ...good, [badKey]: 'x' }, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
      }
    });

    it('plan 必须普通对象（Object.prototype/null 原型）；继承字段不作输入', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-a');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const own = planOf('sc-a', [card], nowIso);
      // 非普通原型（自定义原型对象，即使内容无害）→ INVALID_INPUT
      const customProto = Object.assign(Object.create({ digest: 'x' }), own);
      await assertRejects(store.archiveEphemeral(customProto, { operationId: 'op-cp', executedAt: nowIso }), 'INVALID_INPUT', '普通对象');
      // null 原型普通对象 → 接受
      const nullProto = Object.assign(Object.create(null), JSON.parse(JSON.stringify(own)));
      const r = await store.archiveEphemeral(nullProto, { operationId: 'op-np', executedAt: nowIso });
      assert.equal(r.kind, 'forget-archive-result');
      // 继承字段不作输入：Object.prototype 被污染多余键不影响合法 plan；
      // 必需字段必须自有（继承 version 不算）
      const card2 = await saveCard(store, { id: 'c2' });
      const own2 = planOf('sc-a', [card2], T(Date.parse(card2.createdAt) + 100 * DAY));
      const nowIso2 = T(Date.parse(card2.createdAt) + 100 * DAY);
      const key = 'p4nPollutionProbe';
      const savedDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, key);
      Object.prototype[key] = 'polluted';
      try {
        await store.archiveEphemeral(own2, { operationId: 'op-polluted', executedAt: nowIso2 });
        const missing = { ...own2 };
        delete missing.version;
        Object.prototype.version = 99;
        try {
          await assertRejects(store.archiveEphemeral(missing, { operationId: 'op-mv', executedAt: nowIso2 }), 'INVALID_INPUT');
        } finally {
          delete Object.prototype.version;
        }
      } finally {
        if (savedDescriptor === undefined) delete Object.prototype[key];
        else Object.defineProperty(Object.prototype, key, savedDescriptor);
      }
    });

    it('version/kind/scopeId 精确匹配；跨 scope 拒绝', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-a');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const good = planOf('sc-a', [card], nowIso);
      await assertRejects(store.archiveEphemeral({ ...good, version: 2 }, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral({ ...good, kind: 'link' }, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral({ ...good, scopeId: 'sc-b' }, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
    });

    it('now/executedAt 必须规范 UTC ISO（毫秒 + Z，roundtrip 一致）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-a');
      const card = await saveCard(store, {});
      const good = planOf('sc-a', [card], T(EPOCH + 100 * DAY));
      for (const bad of [
        '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00', '2026-01-01T00:00:00.000z',
        'not-a-date', '', 1750000000000, null, undefined, NaN, Infinity,
      ]) {
        await assertRejects(store.archiveEphemeral({ ...good, now: bad }, { operationId: 'op1', executedAt: T(EPOCH + 100 * DAY) }), 'INVALID_INPUT', 'plan.now');
        await assertRejects(store.archiveEphemeral({ ...good, now: T(EPOCH + 100 * DAY) }, { operationId: 'op1', executedAt: bad }), 'INVALID_INPUT');
      }
    });

    it('policy 完整三字段 / 范围 / 有限数（不接受部分覆盖）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-a');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const good = planOf('sc-a', [card], nowIso);
      const cases = [
        { baseHalfLifeDays: 30, maxHalfLifeDays: 240 },                       // 缺 archiveScore
        { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25, x: 1 }, // 未知键
        { baseHalfLifeDays: 0.5, maxHalfLifeDays: 240, archiveScore: 0.25 },  // base < 1
        { baseHalfLifeDays: 366, maxHalfLifeDays: 240, archiveScore: 0.25 },  // base > 365
        { baseHalfLifeDays: 30, maxHalfLifeDays: 29, archiveScore: 0.25 },    // max < base
        { baseHalfLifeDays: 30, maxHalfLifeDays: 3651, archiveScore: 0.25 },  // max > 3650
        { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0 },      // score = 0
        { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 1 },      // score = 1
        { baseHalfLifeDays: NaN, maxHalfLifeDays: 240, archiveScore: 0.25 },
        { baseHalfLifeDays: 30, maxHalfLifeDays: Infinity, archiveScore: 0.25 },
        { baseHalfLifeDays: '30', maxHalfLifeDays: 240, archiveScore: 0.25 },
        [30, 240, 0.25], null, 'x',
      ];
      for (const p of cases) {
        await assertRejects(store.archiveEphemeral({ ...good, policy: p }, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
      }
      // 合法边界值：base=1 / max=3650 / score 靠近 1 → 资格通过，真正归档；
      // base=max=365 / score 极小 → 入口合法但资格不足（INVALID_STATE，非 INVALID_INPUT）
      const p1 = { baseHalfLifeDays: 1, maxHalfLifeDays: 3650, archiveScore: 0.999 };
      const r = await store.archiveEphemeral(planOf('sc-a', [card], nowIso, p1), { operationId: 'op-p-1', executedAt: nowIso });
      assert.equal(r.kind, 'forget-archive-result');
      const card2 = await saveCard(store, { id: 'c2' });
      const p2 = { baseHalfLifeDays: 365, maxHalfLifeDays: 365, archiveScore: 0.001 };
      await assertRejects(
        store.archiveEphemeral(planOf('sc-a', [card2], nowIso, p2), { operationId: 'op-p-365', executedAt: nowIso }),
        'INVALID_STATE', '资格',
      );
    });

    it('sources 1..20 / 五自有键 / 类型边界 / 去重 / id 规则', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-a');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const good = planOf('sc-a', [card], nowIso);
      await assertRejects(store.archiveEphemeral({ ...good, sources: [] }, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT', '1..20');
      const dup = { ...good, sources: [{ ...good.sources[0] }, { ...good.sources[0] }] };
      await assertRejects(store.archiveEphemeral(dup, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT', '重复');
      const badSources = [
        null, 'x', 5,
        { id: card.id }, // 缺四个键
        { id: card.id, revision: 1, createdAt: card.createdAt, lastUsedAt: null, useCount: 0, extra: 1 },
        { ...good.sources[0], revision: 0 },
        { ...good.sources[0], revision: 1.5 },
        { ...good.sources[0], revision: 2 ** 53 },
        { ...good.sources[0], createdAt: '2026-01-01T00:00:00Z' },
        { ...good.sources[0], lastUsedAt: 123 },
        { ...good.sources[0], useCount: -1 },
        { ...good.sources[0], useCount: 1.5 },
        { ...good.sources[0], useCount: 2 ** 53 },
        { ...good.sources[0], id: 'a/b' },
        { ...good.sources[0], id: 'constructor' },
      ];
      for (const s of badSources) {
        await assertRejects(store.archiveEphemeral({ ...good, sources: [s] }, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
      }
      // 必需字段继承不算自有：revision 从原型继承 → 拒绝
      const inherited = Object.create({ revision: 1 });
      Object.assign(inherited, { id: card.id, createdAt: card.createdAt, lastUsedAt: null, useCount: 0 });
      await assertRejects(store.archiveEphemeral({ ...good, sources: [inherited] }, { operationId: 'op1', executedAt: nowIso }), 'INVALID_INPUT');
    });

    it('opts 两字段必需 / 恰两键 / operationId 规则', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-a');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const plan = planOf('sc-a', [card], nowIso);
      await assertRejects(store.archiveEphemeral(plan, { operationId: 'op1' }), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral(plan, { executedAt: nowIso }), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral(plan, { operationId: 'op1', executedAt: nowIso, authorize: true }), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral(plan, { operationId: 'op1', executedAt: nowIso, root: '/x' }), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral(plan, null), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral(plan, 'x'), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral(plan, { operationId: 'a/b', executedAt: nowIso }), 'INVALID_INPUT');
      await assertRejects(store.archiveEphemeral(plan, { operationId: '', executedAt: nowIso }), 'INVALID_INPUT');
    });
  });

  // ------------------------------------------------------------------
  describe('归档执行：形状、字段保持与冷库列表', () => {
    it('三张卡批量归档：返回恰好六键、items 按 id 排序、正文原样', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-a');
      const ids = ['z-card', 'a-card', 'm-card'];
      const saved = {};
      for (const id of ids) saved[id] = await saveCard(store, { id, title: `标题-${id}`, content: `正文-${id}`, triggers: ['词A', '词B'] });
      const nowIso = T(Date.parse(saved['a-card'].createdAt) + 100 * DAY);
      const plan = planOf('sc-a', ids.map((id) => saved[id]), nowIso);
      const executedAt = T(Date.parse(nowIso) + 5 * DAY);
      const before = await Promise.all(ids.map((id) => store.read(id)));
      const r = await store.archiveEphemeral(plan, { operationId: 'op-arch-1', executedAt });
      assert.deepEqual(Object.keys(r).sort(), ['archivedAt', 'items', 'kind', 'operationId', 'scopeId', 'version']);
      assert.equal(r.version, 1);
      assert.equal(r.kind, 'forget-archive-result');
      assert.equal(r.scopeId, 'sc-a');
      assert.equal(r.operationId, 'op-arch-1');
      assert.equal(r.archivedAt, executedAt);
      assert.equal(r.items.length, 3);
      assert.deepEqual(r.items.map((c) => c.id), ['a-card', 'm-card', 'z-card']);
      const beforeById = new Map(before.map((c) => [c.id, c]));
      for (const item of r.items) assertArchivedSnapshot(beforeById.get(item.id), item, executedAt);
      // live 状态：listActive 清空；read 仍可见；listArchived 一致
      assert.deepEqual((await store.listActive()).map((c) => c.id), []);
      const archived = await store.listArchived();
      assert.deepEqual(archived.map((c) => c.id), ['a-card', 'm-card', 'z-card']);
      for (const item of archived) assertArchivedSnapshot(beforeById.get(item.id), item, executedAt);
    });

    it('归档不改输入：plan 与 source 深比较不变', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-a');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const plan = planOf('sc-a', [card], nowIso);
      const frozen = JSON.parse(JSON.stringify(plan));
      await store.archiveEphemeral(plan, { operationId: 'op-no-mut', executedAt: nowIso });
      assert.deepEqual(plan, frozen);
    });

    it('listArchived：clone 独立、不写库、无 global fallback、排除 superseded/merged', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await seedDb(t, root, 'sc-a', [
        handCard({ id: 'arc-1', state: 'archived', archivedAt: T(EPOCH + DAY), updatedAt: T(EPOCH + DAY), revision: 2 }),
        handCard({ id: 'sup-1', state: 'superseded', supersededBy: 'rep-1', updatedAt: T(EPOCH) }),
        handCard({ id: 'rep-1', supersedes: 'sup-1' }),
        handCard({ id: 'mrg-1', state: 'merged', mergedInto: 'topic-x' }),
        handCard({ id: 'act-1' }),
      ]);
      const bytes0 = await dbBytes(root, 'sc-a');
      const list = await store.listArchived();
      assert.deepEqual(list.map((c) => c.id), ['arc-1']);
      list[0].title = '被篡改';
      list[0].links = [{ target: 'act-1', rel: 'x' }];
      const again = await store.listArchived();
      assert.equal(again[0].title, '手写卡');
      assert.deepEqual(again[0].links, []);
      assert.deepEqual(await dbBytes(root, 'sc-a'), bytes0); // 只读：字节不变
      // global fallback 不存在：另一个 scope 打开同 root 返回空
      const other = await open(root, 'sc-b');
      assert.deepEqual(await other.listArchived(), []);
      // 绑定 global 时返回 global 自己的（无 fallback 混入）
      const g = await seedDb(t, root, 'global', [
        handCard({ id: 'g-arc', state: 'archived', archivedAt: T(EPOCH), updatedAt: T(EPOCH) }),
      ]);
      assert.deepEqual((await g.listArchived()).map((c) => c.id), ['g-arc']);
      // 空库
      const empty = await open(root, 'sc-c');
      assert.deepEqual(await empty.listArchived(), []);
    });
  });

  // ------------------------------------------------------------------
  describe('资格边界（§1 验收：59/60/61、严格阈值、useCount、lastUsedAt、回拨）', () => {
    it('默认策略：59 天与整 60 天（score==0.25）不归档，61 天可归档', async (t) => {
      const root = await makeTmpRoot(t);
      for (const [days, ok] of [[59, false], [60, false], [61, true]]) {
        const store = await open(root, `sc-d${days}`);
        const card = await saveCard(store, {});
        const nowIso = T(Date.parse(card.createdAt) + days * DAY);
        const plan = planOf(`sc-d${days}`, [card], nowIso);
        const p = store.archiveEphemeral(plan, { operationId: `op-${days}`, executedAt: nowIso });
        if (ok) {
          const r = await p;
          assert.equal(r.items.length, 1);
        } else {
          await assertRejects(p, 'INVALID_STATE', '资格');
        }
      }
    });

    it('自定义阈值：满 60 天且严格低于才可归档', async (t) => {
      const root = await makeTmpRoot(t);
      const policy = { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.2 };
      // 60 天：score=0.25 不低于 0.2 → 拒绝；69 天：≈0.2036 仍不低于 → 拒绝；
      // 70 天：≈0.1985 < 0.2 且满 60 天 → 允许
      for (const [days, ok] of [[60, false], [69, false], [70, true]]) {
        const store = await open(root, `sc-c${days}`);
        const card = await saveCard(store, {});
        const nowIso = T(Date.parse(card.createdAt) + days * DAY);
        const plan = planOf(`sc-c${days}`, [card], nowIso, policy);
        if (ok) {
          const r = await store.archiveEphemeral(plan, { operationId: `op-${days}`, executedAt: nowIso });
          assert.equal(r.items.length, 1);
        } else {
          await assertRejects(store.archiveEphemeral(plan, { operationId: `op-${days}`, executedAt: nowIso }), 'INVALID_STATE');
        }
      }
    });

    it('useCount 延长半衰期：useCount=1 时 70 天不到阈值，useCount=0 时可归档', async (t) => {
      const root = await makeTmpRoot(t);
      const s0 = await open(root, 'sc-u0');
      const c0 = await saveCard(s0, { id: 'u0' });
      await s0.feedback('u0', { used: true }); // useCount=1, lastUsedAt=now
      const fresh0 = await s0.read('u0');
      const now0 = T(Date.parse(fresh0.lastUsedAt) + 70 * DAY);
      await assertRejects(
        s0.archiveEphemeral(planOf('sc-u0', [fresh0], now0), { operationId: 'op-u0', executedAt: now0 }),
        'INVALID_STATE', '资格',
      );
      const s1 = await open(root, 'sc-u1');
      const c1 = await saveCard(s1, { id: 'u1' });
      const now1 = T(Date.parse(c1.createdAt) + 70 * DAY);
      const r = await s1.archiveEphemeral(planOf('sc-u1', [c1], now1), { operationId: 'op-u1', executedAt: now1 });
      assert.equal(r.items.length, 1);
    });

    it('useCount 大指数封顶：useCount=2000 不产生 Infinity，仍可按 max 半衰期归档', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await seedDb(t, root, 'sc-big', [
        handCard({ id: 'big', useCount: 2000, createdAt: T(EPOCH), updatedAt: T(EPOCH) }),
      ]);
      // 1000 天：halfLife=min(30*2^useCount 封顶后, 240)=240 → score≈0.057<0.25 → 可归档
      // 若未封顶：30*2^2000=Infinity → score=2^0=1 → 永远拒绝
      const nowIso = T(EPOCH + 1000 * DAY);
      const card = await store.read('big');
      const r = await store.archiveEphemeral(planOf('sc-big', [card], nowIso), { operationId: 'op-big', executedAt: nowIso });
      assert.equal(r.items.length, 1);
    });

    it('lastUsedAt 优先于 createdAt：锚点最近使用而非创建', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await seedDb(t, root, 'sc-anchor', [
        handCard({
          id: 'anch',
          createdAt: T(EPOCH),                    // 创建于 1000 天前
          lastUsedAt: T(EPOCH + 941 * DAY),       // 最近使用于 59 天前（相对 plan.now）
          updatedAt: T(EPOCH),
        }),
      ]);
      const card = await store.read('anch');
      const now59 = T(EPOCH + 1000 * DAY);
      await assertRejects(
        store.archiveEphemeral(planOf('sc-anchor', [card], now59), { operationId: 'op-a59', executedAt: now59 }),
        'INVALID_STATE', '资格',
      );
      // 换一张 61 天未用的：允许（同一库第二张卡）
      const store2 = await seedDb(t, root, 'sc-anchor2', [
        handCard({ id: 'anch2', createdAt: T(EPOCH), lastUsedAt: T(EPOCH + 939 * DAY), updatedAt: T(EPOCH) }),
      ]);
      const card2 = await store2.read('anch2');
      const now61 = T(EPOCH + 1000 * DAY);
      const r = await store2.archiveEphemeral(planOf('sc-anchor2', [card2], now61), { operationId: 'op-a61', executedAt: now61 });
      assert.equal(r.items.length, 1);
    });

    it('时钟回拨：plan.now 早于锚点 → elapsed 夹 0 → 未达资格（INVALID_STATE）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await seedDb(t, root, 'sc-rb', [
        handCard({ id: 'rb', createdAt: T(EPOCH + 50 * DAY), updatedAt: T(EPOCH + 50 * DAY) }),
      ]);
      const card = await store.read('rb');
      const nowIso = T(EPOCH); // plan.now 早于 createdAt
      await assertRejects(
        store.archiveEphemeral(planOf('sc-rb', [card], nowIso), { operationId: 'op-rb', executedAt: nowIso }),
        'INVALID_STATE', '资格',
      );
    });

    it('executedAt < plan.now → INVALID_STATE（执行回拨，先于逐卡检查）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-exerb');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      await assertRejects(
        store.archiveEphemeral(planOf('sc-exerb', [card], nowIso), { operationId: 'op-x1', executedAt: T(Date.parse(nowIso) - 1) }),
        'INVALID_STATE', 'executedAt',
      );
      // 即使同时有卡不存在，回拨检查仍在逐卡存在性之前
      const plan = planOf('sc-exerb', [card], nowIso);
      plan.sources.push({ id: 'missing', revision: 1, createdAt: nowIso, lastUsedAt: null, useCount: 0 });
      await assertRejects(
        store.archiveEphemeral(plan, { operationId: 'op-x2', executedAt: T(Date.parse(nowIso) - DAY) }),
        'INVALID_STATE', 'executedAt',
      );
    });

    it('曝光/统计不续期：hitCount/lastHitAt 不影响锚点', async (t) => {
      const root = await makeTmpRoot(t);
      // 手写库：lastHitAt 很新但 lastUsedAt/createdAt 很老 → 仍可归档
      const store = await seedDb(t, root, 'sc-hits', [
        handCard({ id: 'hit', createdAt: T(EPOCH), lastHitAt: T(EPOCH + 999 * DAY), updatedAt: T(EPOCH) }),
      ]);
      const card = await store.read('hit');
      const nowIso = T(EPOCH + 1000 * DAY);
      const r = await store.archiveEphemeral(planOf('sc-hits', [card], nowIso), { operationId: 'op-hit', executedAt: nowIso });
      assert.equal(r.items.length, 1);
    });
  });

  // ------------------------------------------------------------------
  describe('免疫与状态（evergreen、承接、退休、不存在）', () => {
    it('evergreen 免疫：再老也不可归档（INVALID_STATE）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-ev');
      const card = await saveCard(store, { id: 'ev-1', vitality: 'evergreen' });
      const nowIso = T(Date.parse(card.createdAt) + 3650 * DAY);
      await assertRejects(
        store.archiveEphemeral(planOf('sc-ev', [card], nowIso), { operationId: 'op-ev', executedAt: nowIso }),
        'INVALID_STATE', 'evergreen',
      );
      assert.equal((await store.listActive()).length, 1);
    });

    it('承接替代关系的 replacement 不得归档（INVALID_STATE）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-rep');
      await saveCard(store, { id: 'old-1' });
      await saveCard(store, { id: 'rep-1' });
      await store.forget('old-1', { mode: 'supersede', replacementId: 'rep-1' });
      const rep = await store.read('rep-1');
      assert.equal(rep.supersedes, 'old-1');
      const nowIso = T(Date.parse(rep.createdAt) + 100 * DAY);
      await assertRejects(
        store.archiveEphemeral(planOf('sc-rep', [rep], nowIso), { operationId: 'op-rep', executedAt: nowIso }),
        'INVALID_STATE', '承接',
      );
      // 原卡保持 superseded、replacement 保持 active：链路不被破坏
      assert.equal((await store.read('old-1')).state, 'superseded');
      assert.equal((await store.read('rep-1')).state, 'active');
    });

    it('退休状态不候选：archived/superseded/merged 再归档 → INVALID_STATE；不存在 → NOT_FOUND', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await seedDb(t, root, 'sc-st', [
        handCard({ id: 'st-arc', state: 'archived', archivedAt: T(EPOCH), updatedAt: T(EPOCH), revision: 2 }),
        handCard({ id: 'st-sup', state: 'superseded', supersededBy: 'st-rep', updatedAt: T(EPOCH) }),
        handCard({ id: 'st-rep', supersedes: 'st-sup' }),
        handCard({ id: 'st-mrg', state: 'merged', mergedInto: 'topic-y' }),
      ]);
      const nowIso = T(EPOCH + 1000 * DAY);
      for (const id of ['st-arc', 'st-sup', 'st-mrg']) {
        const card = await store.read(id);
        await assertRejects(
          store.archiveEphemeral(planOf('sc-st', [card], nowIso), { operationId: `op-${id}`, executedAt: nowIso }),
          'INVALID_STATE',
        );
      }
      const missing = { id: 'no-such', revision: 1, createdAt: nowIso, lastUsedAt: null, useCount: 0 };
      await assertRejects(
        store.archiveEphemeral(planOf('sc-st', [missing], nowIso), { operationId: 'op-miss', executedAt: nowIso }),
        'NOT_FOUND',
      );
      // 全部失败后：库文件字节不变（零卡变化、无新 op）
      const list = await store.listActive();
      assert.deepEqual(list.map((c) => c.id), ['st-rep']);
    });
  });

  // ------------------------------------------------------------------
  describe('全量 CAS 与整批原子性', () => {
    it('revision 不符 → REVISION_CONFLICT，整批零卡变化、文件不变', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-cas');
      const a = await saveCard(store, { id: 'cas-a' });
      const b = await saveCard(store, { id: 'cas-b' });
      await store.update('cas-b', { title: '改过标题' }); // revision +1
      const freshB = await store.read('cas-b');
      const nowIso = T(Date.parse(a.createdAt) + 100 * DAY);
      const stalePlan = planOf('sc-cas', [a, { ...sourceOf(freshB), revision: freshB.revision - 1 }], nowIso);
      const bytes0 = await dbBytes(root, 'sc-cas');
      await assertRejects(store.archiveEphemeral(stalePlan, { operationId: 'op-cas', executedAt: nowIso }), 'REVISION_CONFLICT', 'cas-b');
      assert.deepEqual(await dbBytes(root, 'sc-cas'), bytes0);
      assert.equal((await store.listActive()).length, 2);
    });

    it('反馈后陈旧计划：lastUsedAt/useCount 变化（revision 未变）仍被 CAS 捕获', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-fb-cas');
      const card = await saveCard(store, { id: 'fb-cas' });
      // useCount=1 → halfLife=60 → 200 天后 score≈0.099<0.25 达资格
      const nowIso = T(Date.parse(card.createdAt) + 200 * DAY);
      const stalePlan = planOf('sc-fb-cas', [card], nowIso); // 反馈前快照
      await store.recordUsefulFeedback('fb-cas', { used: true, sourceEventId: 'evt-1' });
      const fresh = await store.read('fb-cas');
      assert.equal(fresh.revision, card.revision); // 反馈不动 revision
      assert.equal(fresh.useCount, 1);
      const bytes0 = await dbBytes(root, 'sc-fb-cas');
      await assertRejects(store.archiveEphemeral(stalePlan, { operationId: 'op-fbcas', executedAt: nowIso }), 'REVISION_CONFLICT');
      assert.deepEqual(await dbBytes(root, 'sc-fb-cas'), bytes0);
      // 用反馈后的新快照可正常归档（反馈变化被 CAS 之后的计划接受）
      const r = await store.archiveEphemeral(planOf('sc-fb-cas', [fresh], nowIso), { operationId: 'op-fbcas2', executedAt: nowIso });
      assert.equal(r.items.length, 1);
    });

    it('createdAt 任意差异 → REVISION_CONFLICT', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-ct');
      const card = await saveCard(store, { id: 'ct-1' });
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const bad = { ...sourceOf(card), createdAt: T(Date.parse(card.createdAt) - DAY) };
      await assertRejects(
        store.archiveEphemeral(planOf('sc-ct', [bad], nowIso), { operationId: 'op-ct', executedAt: nowIso }),
        'REVISION_CONFLICT',
      );
    });

    it('单卡错误优先级：状态错优先于 CAS；CAS 优先于资格', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await seedDb(t, root, 'sc-pri', [
        handCard({ id: 'pri-1', state: 'archived', archivedAt: T(EPOCH), updatedAt: T(EPOCH), revision: 2 }),
        handCard({ id: 'pri-2', vitality: 'evergreen', revision: 9 }),       // evergreen + 将注入错 revision
        handCard({ id: 'pri-3', createdAt: T(EPOCH + 1000 * DAY) }),
      ]);
      const nowIso = T(EPOCH + 2000 * DAY);
      const s1 = await store.read('pri-1');
      await assertRejects(
        store.archiveEphemeral(planOf('sc-pri', [{ ...sourceOf(s1), revision: 1 }], nowIso), { operationId: 'op-p1', executedAt: nowIso }),
        'INVALID_STATE', // 状态错误优先于 CAS
      );
      const s2 = await store.read('pri-2');
      await assertRejects(
        store.archiveEphemeral(planOf('sc-pri', [{ ...sourceOf(s2), revision: 1 }], nowIso), { operationId: 'op-p2', executedAt: nowIso }),
        'INVALID_STATE', 'evergreen', // 免疫优先于 CAS（revision 同时不符）
      );
      const s3 = await store.read('pri-3'); // createdAt=now-1000d，快照其余一致
      const stale3 = { ...sourceOf(s3), revision: 77 };
      await assertRejects(
        store.archiveEphemeral(planOf('sc-pri', [stale3], nowIso), { operationId: 'op-p3', executedAt: nowIso }),
        'REVISION_CONFLICT', // CAS 优先于资格复算
      );
    });

    it('20 张同锁原子归档成功；21 张入口拒绝', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-20');
      const cards = [];
      for (let i = 0; i < 20; i += 1) {
        cards.push(await saveCard(store, { id: `card-${String(i).padStart(2, '0')}` }));
      }
      const nowIso = T(Date.parse(cards[0].createdAt) + 100 * DAY);
      const plan = planOf('sc-20', cards.reverse(), nowIso); // 乱序传入，内部规范化
      const r = await store.archiveEphemeral(plan, { operationId: 'op-20', executedAt: nowIso });
      assert.equal(r.items.length, 20);
      assert.deepEqual(r.items.map((c) => c.id), cards.map((c) => c.id).sort());
      assert.equal((await store.listActive()).length, 0);
      assert.equal((await store.listArchived()).length, 20);
      // 21 张
      const store2 = await open(root, 'sc-21');
      const cards2 = [];
      for (let i = 0; i < 21; i += 1) {
        cards2.push(await saveCard(store2, { id: `c-${i}` }));
      }
      const nowIso2 = T(Date.parse(cards2[0].createdAt) + 100 * DAY);
      await assertRejects(
        store2.archiveEphemeral(planOf('sc-21', cards2, nowIso2), { operationId: 'op-21', executedAt: nowIso2 }),
        'INVALID_INPUT', '1..20',
      );
      assert.equal((await store2.listActive()).length, 21);
    });

    it('失败无新 op、无部分归档：失败后同 op 修正重试可真正执行', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-fail');
      const a = await saveCard(store, { id: 'f-a' });
      const b = await saveCard(store, { id: 'f-b' });
      await store.update('f-b', { title: '新标题' });
      const freshB = await store.read('f-b');
      const nowIso = T(Date.parse(a.createdAt) + 100 * DAY);
      const stale = planOf('sc-fail', [a, { ...sourceOf(freshB), revision: freshB.revision - 1 }], nowIso);
      const bytes0 = await dbBytes(root, 'sc-fail');
      await assertRejects(store.archiveEphemeral(stale, { operationId: 'op-retry', executedAt: nowIso }), 'REVISION_CONFLICT');
      assert.deepEqual(await dbBytes(root, 'sc-fail'), bytes0); // 失败不落盘
      // 同 operationId 换正确快照 → 应真正执行（若失败写了 op 会错误重放/拒绝）
      const fixed = planOf('sc-fail', [a, freshB], nowIso);
      const r = await store.archiveEphemeral(fixed, { operationId: 'op-retry', executedAt: nowIso });
      assert.equal(r.items.length, 2);
      assert.deepEqual((await store.listActive()).map((c) => c.id), []);
    });
  });

  // ------------------------------------------------------------------
  describe('持久重放先于 live CAS（同 op 幂等）', () => {
    it('同 op 同 plan：重放返回首次结果（含首次 archivedAt），不采用新 executedAt', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-rp');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const executed1 = T(Date.parse(nowIso) + DAY);
      const executed2 = T(Date.parse(nowIso) + 30 * DAY);
      const plan = planOf('sc-rp', [card], nowIso);
      const first = await store.archiveEphemeral(plan, { operationId: 'op-rp', executedAt: executed1 });
      const bytes1 = await dbBytes(root, 'sc-rp');
      const gen1 = (await dbJson(root, 'sc-rp')).generation;
      const again = await store.archiveEphemeral(plan, { operationId: 'op-rp', executedAt: executed2 });
      assert.deepEqual(again, first);
      assert.equal(again.archivedAt, executed1); // 首次 archivedAt
      assert.deepEqual(await dbBytes(root, 'sc-rp'), bytes1); // 重放零写
      assert.equal((await dbJson(root, 'sc-rp')).generation, gen1);
    });

    it('已完成同 op 在 executedAt 回拨时仍重放（回拨检查在重放之后）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-rp2');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const first = await store.archiveEphemeral(planOf('sc-rp2', [card], nowIso), { operationId: 'op-rp2', executedAt: nowIso });
      const rollback = await store.archiveEphemeral(
        planOf('sc-rp2', [card], nowIso),
        { operationId: 'op-rp2', executedAt: T(Date.parse(nowIso) - 10 * DAY) },
      );
      assert.deepEqual(rollback, first);
    });

    it('executedAt 格式非法仍在入口 INVALID_INPUT（即使 op 已存在）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-rp3');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      await store.archiveEphemeral(planOf('sc-rp3', [card], nowIso), { operationId: 'op-rp3', executedAt: nowIso });
      await assertRejects(
        store.archiveEphemeral(planOf('sc-rp3', [card], nowIso), { operationId: 'op-rp3', executedAt: 'bad' }),
        'INVALID_INPUT',
      );
    });

    it('同 op 异 plan（policy/now/sources 任一差异）→ INVALID_INPUT；sources 顺序规范化后同 plan 可重放', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-rp4');
      const a = await saveCard(store, { id: 'r-a' });
      const b = await saveCard(store, { id: 'r-b' });
      const nowIso = T(Date.parse(a.createdAt) + 100 * DAY);
      const first = await store.archiveEphemeral(planOf('sc-rp4', [a, b], nowIso), { operationId: 'op-rp4', executedAt: nowIso });
      assert.deepEqual(first.items.map((c) => c.id), ['r-a', 'r-b']);
      // now 不同
      await assertRejects(
        store.archiveEphemeral(planOf('sc-rp4', [a, b], T(Date.parse(nowIso) + 1)), { operationId: 'op-rp4', executedAt: nowIso }),
        'INVALID_INPUT', '不同语义',
      );
      // policy 不同
      await assertRejects(
        store.archiveEphemeral(planOf('sc-rp4', [a, b], nowIso, { baseHalfLifeDays: 40, maxHalfLifeDays: 240, archiveScore: 0.25 }), { operationId: 'op-rp4', executedAt: nowIso }),
        'INVALID_INPUT',
      );
      // sources 子集不同
      await assertRejects(
        store.archiveEphemeral(planOf('sc-rp4', [a], nowIso), { operationId: 'op-rp4', executedAt: nowIso }),
        'INVALID_INPUT',
      );
      // 顺序不同但集合相同 → 规范化后同指纹 → 重放
      const reversed = await store.archiveEphemeral(planOf('sc-rp4', [b, a], nowIso), { operationId: 'op-rp4', executedAt: nowIso });
      assert.deepEqual(reversed, first);
    });

    it('close 后重开：持久 op 重放仍幂等（close/reopen 可重放）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-rp5');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const first = await store.archiveEphemeral(planOf('sc-rp5', [card], nowIso), { operationId: 'op-rp5', executedAt: nowIso });
      store.close();
      await assertRejects(store.listArchived(), 'INVALID_STATE', 'close');
      const reopened = await open(root, 'sc-rp5');
      const replay = await reopened.archiveEphemeral(planOf('sc-rp5', [card], nowIso), { operationId: 'op-rp5', executedAt: nowIso });
      assert.deepEqual(replay, first);
      assert.equal((await reopened.listArchived()).length, 1);
    });

    it('同 plan 不同 op 重试：卡已 archived → INVALID_STATE（不复活、不重放他人 op）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-rp6');
      const card = await saveCard(store, {});
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      await store.archiveEphemeral(planOf('sc-rp6', [card], nowIso), { operationId: 'op-first', executedAt: nowIso });
      await assertRejects(
        store.archiveEphemeral(planOf('sc-rp6', [card], nowIso), { operationId: 'op-second', executedAt: nowIso }),
        'INVALID_STATE',
      );
    });
  });

  // ------------------------------------------------------------------
  describe('明确有用反馈 recordUsefulFeedback', () => {
    it('used=true：useCount+1、lastUsedAt 更新、revision 不变、返回完整卡 clone', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-fb');
      const card = await saveCard(store, { id: 'fb-1' });
      const r = await store.recordUsefulFeedback('fb-1', { used: true, sourceEventId: 'evt-a' });
      assert.equal(r.id, 'fb-1');
      assert.equal(r.useCount, 1);
      assert.ok(r.lastUsedAt > card.createdAt);
      assert.equal(r.revision, card.revision);
      r.title = '被篡改'; // clone 独立
      const again = await store.read('fb-1');
      assert.equal(again.title, card.title);
      assert.equal(again.useCount, 1);
    });

    it('used=false：不改 useCount/lastUsedAt，但事件仍记录', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-fb2');
      const card = await saveCard(store, { id: 'fb-2' });
      const r = await store.recordUsefulFeedback('fb-2', { used: false, sourceEventId: 'evt-n' });
      assert.equal(r.useCount, 0);
      assert.equal(r.lastUsedAt, null);
      // 同事件改 true → 不同语义拒绝（事件已记录 used=false）
      await assertRejects(
        store.recordUsefulFeedback('fb-2', { used: true, sourceEventId: 'evt-n' }),
        'INVALID_INPUT', '不能改为',
      );
      assert.equal((await store.read('fb-2')).useCount, 0);
    });

    it('同事件同 used 不双计数；跨 API（旧 feedback）共享事件去重', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-fb3');
      const card = await saveCard(store, { id: 'fb-3' });
      await store.recordUsefulFeedback('fb-3', { used: true, sourceEventId: 'evt-x' });
      await store.recordUsefulFeedback('fb-3', { used: true, sourceEventId: 'evt-x' }); // 重放不双计
      assert.equal((await store.read('fb-3')).useCount, 1);
      // 旧 API 反向：先旧 feedback 再 recordUsefulFeedback
      await store.feedback('fb-3', { used: true, sourceEventId: 'evt-y' });
      await store.recordUsefulFeedback('fb-3', { used: true, sourceEventId: 'evt-y' });
      assert.equal((await store.read('fb-3')).useCount, 2);
      // 旧 API 对 recordUsefulFeedback 已记录事件的反向幂等
      await store.feedback('fb-3', { used: true, sourceEventId: 'evt-x' });
      assert.equal((await store.read('fb-3')).useCount, 2);
      // 同事件不同语义（旧 API 视角）
      await assertRejects(store.feedback('fb-3', { used: false, sourceEventId: 'evt-x' }), 'INVALID_INPUT');
    });

    it('形状校验：used/sourceEventId 必需、未知键拒绝、id/事件 id 规则', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-fb4');
      await saveCard(store, { id: 'fb-4' });
      await assertRejects(store.recordUsefulFeedback('fb-4', { used: true }), 'INVALID_INPUT');
      await assertRejects(store.recordUsefulFeedback('fb-4', { sourceEventId: 'e' }), 'INVALID_INPUT');
      await assertRejects(store.recordUsefulFeedback('fb-4', { used: 1, sourceEventId: 'e' }), 'INVALID_INPUT');
      await assertRejects(store.recordUsefulFeedback('fb-4', { used: true, sourceEventId: 'e', extra: 1 }), 'INVALID_INPUT');
      await assertRejects(store.recordUsefulFeedback('fb-4', { used: true, sourceEventId: 'a/b' }), 'INVALID_INPUT');
      await assertRejects(store.recordUsefulFeedback('bad/id', { used: true, sourceEventId: 'e' }), 'INVALID_INPUT');
      await assertRejects(store.recordUsefulFeedback('no-such', { used: true, sourceEventId: 'e' }), 'NOT_FOUND');
      // 继承 used 不算自有
      const inherited = Object.create({ used: true });
      Object.assign(inherited, { sourceEventId: 'e' });
      await assertRejects(store.recordUsefulFeedback('fb-4', inherited), 'INVALID_INPUT');
    });

    it('operationId 重放：首次结果快照；同 op 异语义拒绝', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-fb5');
      await saveCard(store, { id: 'fb-5' });
      const first = await store.recordUsefulFeedback('fb-5', { used: true, sourceEventId: 'evt-1', operationId: 'fb-op' });
      assert.equal(first.useCount, 1);
      const replay = await store.recordUsefulFeedback('fb-5', { used: true, sourceEventId: 'evt-1', operationId: 'fb-op' });
      assert.deepEqual(replay, first);
      assert.equal((await store.read('fb-5')).useCount, 1);
      await assertRejects(
        store.recordUsefulFeedback('fb-5', { used: true, sourceEventId: 'evt-2', operationId: 'fb-op' }),
        'INVALID_INPUT', '不同语义',
      );
      await assertRejects(
        store.recordUsefulFeedback('fb-5', { used: false, sourceEventId: 'evt-1', operationId: 'fb-op' }),
        'INVALID_INPUT',
      );
    });

    it('退休卡拒绝（active-only，不复活）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-fb6');
      const card = await saveCard(store, { id: 'fb-6' });
      await store.forget('fb-6', { mode: 'archive' });
      await assertRejects(
        store.recordUsefulFeedback('fb-6', { used: true, sourceEventId: 'evt-z' }),
        'INVALID_STATE',
      );
      // 无 op 的事件重放沿用 active-only
      await assertRejects(
        store.recordUsefulFeedback('fb-6', { used: true, sourceEventId: 'evt-z' }),
        'INVALID_STATE',
      );
      assert.equal((await store.read('fb-6')).useCount, 0);
    });

    it('sourceEventId/operationId 为 "constructor"：own-property 修复后正常记录与重放', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-proto');
      await saveCard(store, { id: 'pc-1' });
      // 旧缺陷：事件查找读到 Object.prototype.constructor → 误报已记录/语义冲突
      const r = await store.recordUsefulFeedback('pc-1', { used: true, sourceEventId: 'constructor' });
      assert.equal(r.useCount, 1);
      const r2 = await store.recordUsefulFeedback('pc-1', { used: true, sourceEventId: 'constructor' });
      assert.equal(r2.useCount, 1); // 事件级幂等
      await assertRejects(
        store.recordUsefulFeedback('pc-1', { used: false, sourceEventId: 'constructor' }),
        'INVALID_INPUT', '不能改为',
      );
      // runMutation ops 账同样修复：operationId="constructor" 可保存并重放
      const s1 = await store.save(cardInput({ id: 'pc-2' }), { operationId: 'constructor' });
      assert.equal(s1.id, 'pc-2');
      const s2 = await store.save(cardInput({ id: 'pc-2' }), { operationId: 'constructor' });
      assert.deepEqual(s2, s1);
      // 事件真实落库（defineProperty 自有属性）：重开库后仍幂等
      store.close();
      const reopened = await open(root, 'sc-proto');
      const r3 = await reopened.recordUsefulFeedback('pc-1', { used: true, sourceEventId: 'constructor' });
      assert.equal(r3.useCount, 1);
      assert.ok(Object.hasOwn((await dbJson(root, 'sc-proto')).feedback['pc-1'], 'constructor'));
    });

    it('useCount 溢出：safe integer 上限时 used=true 原子失败，used=false 仍可记录', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await seedDb(t, root, 'sc-ovf', [
        handCard({ id: 'ovf', useCount: Number.MAX_SAFE_INTEGER, lastUsedAt: T(EPOCH), updatedAt: T(EPOCH) }),
      ]);
      const bytes0 = await dbBytes(root, 'sc-ovf');
      await assertRejects(
        store.recordUsefulFeedback('ovf', { used: true, sourceEventId: 'evt-ovf' }),
        'INVALID_STATE', '上限',
      );
      assert.deepEqual(await dbBytes(root, 'sc-ovf'), bytes0); // 原子失败：事件也未写
      const r = await store.recordUsefulFeedback('ovf', { used: false, sourceEventId: 'evt-ovf-f' });
      assert.equal(r.useCount, Number.MAX_SAFE_INTEGER);
      assert.equal(r.lastUsedAt, T(EPOCH)); // false 不改 lastUsedAt
    });
  });

  // ------------------------------------------------------------------
  describe('旧 feedback 兼容（可选 sourceEventId 语义保留）', () => {
    it('旧 feedback：无 sourceEventId 每次计数；带 operationId 幂等', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-old');
      await saveCard(store, { id: 'old-1' });
      await store.feedback('old-1', { used: true });
      await store.feedback('old-1', { used: true });
      assert.equal((await store.read('old-1')).useCount, 2);
      const f1 = await store.feedback('old-1', { used: false });
      assert.equal((await store.read('old-1')).useCount, 2); // false 不计数
      const r1 = await store.feedback('old-1', { used: true, operationId: 'fb-old-op' });
      const r2 = await store.feedback('old-1', { used: true, operationId: 'fb-old-op' });
      assert.deepEqual(r2, r1);
      assert.equal((await store.read('old-1')).useCount, 3);
    });

    it('归档与反馈同锁域：归档成功后反馈被拒（active-only）；反馈与归档串行交错不产生撕裂', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-lock');
      const card = await saveCard(store, { id: 'lk-1' });
      // 反馈后 useCount=1 → halfLife=60 → 200 天达资格
      const nowIso = T(Date.parse(card.createdAt) + 200 * DAY);
      await store.recordUsefulFeedback('lk-1', { used: true, sourceEventId: 'evt-lk' });
      const fresh = await store.read('lk-1');
      const r = await store.archiveEphemeral(planOf('sc-lock', [fresh], nowIso), { operationId: 'op-lk', executedAt: nowIso });
      assert.equal(r.items[0].useCount, 1); // 统计原样带进冷库
      await assertRejects(
        store.recordUsefulFeedback('lk-1', { used: true, sourceEventId: 'evt-lk2' }),
        'INVALID_STATE',
      );
    });
  });

  // ------------------------------------------------------------------
  describe('attempt2 返工回归（主审 D-1/D-2）：首次 await 前独立输入快照', () => {
    it('D-1 archiveEphemeral：调用后篡改 opts/plan 不影响首次回执、日志键与重放', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-d1');
      const card = await saveCard(store, { id: 'd1' });
      const nowIso = T(Date.parse(card.createdAt) + 100 * DAY);
      const executedAt = T(Date.parse(nowIso) + 5000);
      const plan = planOf('sc-d1', [card], nowIso);
      const opts = { operationId: 'original-op', executedAt };
      const pending = store.archiveEphemeral(plan, opts);
      // 调用返回 pending 后立即（首个 await 前）同步篡改调用方对象
      opts.operationId = 'mutated-after-call';
      opts.executedAt = T(EPOCH + 3 * DAY);
      plan.now = T(EPOCH + 999 * DAY);
      plan.policy = { baseHalfLifeDays: 100, maxHalfLifeDays: 200, archiveScore: 0.5 };
      plan.sources[0].revision = 999;
      plan.sources.push({ id: 'ghost', revision: 1, createdAt: nowIso, lastUsedAt: null, useCount: 0 });
      const r = await pending;
      assert.equal(r.operationId, 'original-op');
      assert.equal(r.archivedAt, executedAt);
      assert.equal(r.items.length, 1);
      assert.equal(r.items[0].id, 'd1');
      assert.equal(r.items[0].revision, card.revision + 1);
      // 持久日志键为原 key；篡改 key 不存在
      assert.deepEqual(Object.keys((await dbJson(root, 'sc-d1')).ops), ['original-op']);
      // close/reopen 后以原 key + 原语义 plan 重放：返回原回执、数据库字节不变
      store.close();
      const reopened = await open(root, 'sc-d1');
      const bytes1 = await dbBytes(root, 'sc-d1');
      const replay = await reopened.archiveEphemeral(
        planOf('sc-d1', [card], nowIso), // 与首次相同语义（值相等的新对象）
        { operationId: 'original-op', executedAt: T(Date.parse(nowIso) + 9000 * DAY) },
      );
      assert.equal(replay.operationId, 'original-op');
      assert.equal(replay.archivedAt, executedAt);
      assert.deepEqual(replay, r);
      assert.deepEqual(await dbBytes(root, 'sc-d1'), bytes1);
    });

    it('D-2 recordUsefulFeedback：继承 operationId 不作输入；独立计数且零 op 日志', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-d2');
      const card = await saveCard(store, { id: 'c-old' });
      const desc = Object.getOwnPropertyDescriptor(Object.prototype, 'operationId');
      Object.defineProperty(Object.prototype, 'operationId', {
        value: 'inherited-not-input', writable: true, configurable: true, // 非枚举
      });
      try {
        // 两个不同事件独立计数（旧缺陷：第二个会被继承 op key 误判同语义而拒绝）
        const r1 = await store.recordUsefulFeedback('c-old', { used: true, sourceEventId: 'evt-d2-a' });
        assert.equal(r1.useCount, 1);
        const r2 = await store.recordUsefulFeedback('c-old', { used: true, sourceEventId: 'evt-d2-b' });
        assert.equal(r2.useCount, 2);
        assert.deepEqual(Object.keys((await dbJson(root, 'sc-d2')).ops), []); // 无继承 op 日志
        // 同事件不双计数
        const r3 = await store.recordUsefulFeedback('c-old', { used: true, sourceEventId: 'evt-d2-a' });
        assert.equal(r3.useCount, 2);
        // 自有合法 operationId 仍是输入；调用后篡改 opts 不影响首次结果
        const opts = { used: true, sourceEventId: 'evt-d2-c', operationId: 'own-op-d2' };
        const pending = store.recordUsefulFeedback('c-old', opts);
        opts.used = false;
        opts.sourceEventId = 'evt-d2-zzz';
        opts.operationId = 'mutated-op';
        const r4 = await pending;
        assert.equal(r4.useCount, 3);
        assert.deepEqual(Object.keys((await dbJson(root, 'sc-d2')).ops), ['own-op-d2']);
        // 原 key 原语义重放返回首次结果，不再计数
        const r5 = await store.recordUsefulFeedback('c-old', { used: true, sourceEventId: 'evt-d2-c', operationId: 'own-op-d2' });
        assert.equal(r5.useCount, 3);
        // 显式自有 undefined → 拒绝
        await assertRejects(
          store.recordUsefulFeedback('c-old', { used: true, sourceEventId: 'evt-d2-d', operationId: undefined }),
          'INVALID_INPUT',
        );
        // null 原型 opts 正常（普通对象含 null 原型）
        const nullOpts = Object.assign(Object.create(null), { used: true, sourceEventId: 'evt-d2-np' });
        const r6 = await store.recordUsefulFeedback('c-old', nullOpts);
        assert.equal(r6.useCount, 4);
      } finally {
        if (desc === undefined) delete Object.prototype.operationId;
        else Object.defineProperty(Object.prototype, 'operationId', desc);
      }
      assert.equal(Object.getOwnPropertyDescriptor(Object.prototype, 'operationId'), desc);
    });
  });

  // ------------------------------------------------------------------
  describe('attempt3 返工回归（主审 D-3）：feedback bucket own-property', () => {
    it('D-3 卡 id=toString：bucket 自有创建、事件持久、跨 API 去重、重开幂等、无内置对象污染', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-d3');
      // "toString" 是合法 spark id（不在保留键名单），会命中 db.feedback 继承键
      const card = await saveCard(store, { id: 'toString' });
      const r1 = await store.recordUsefulFeedback('toString', { used: true, sourceEventId: 'e1' });
      assert.equal(r1.useCount, 1);
      const db1 = await dbJson(root, 'sc-d3');
      assert.ok(Object.hasOwn(db1.feedback, 'toString'), 'bucket 必须是 db.feedback 自有键');
      assert.equal(typeof db1.feedback.toString, 'object');
      assert.ok(Object.hasOwn(db1.feedback.toString, 'e1'), '事件必须是 bucket 自有键');
      // 旧 API 同事件 → 跨 API 去重；旧 API 新事件 → 计数
      assert.equal((await store.feedback('toString', { used: true, sourceEventId: 'e1' })).useCount, 1);
      assert.equal((await store.feedback('toString', { used: true, sourceEventId: 'e2' })).useCount, 2);
      assert.equal((await store.recordUsefulFeedback('toString', { used: true, sourceEventId: 'e2' })).useCount, 2);
      await assertRejects(store.recordUsefulFeedback('toString', { used: false, sourceEventId: 'e1' }), 'INVALID_INPUT', '不能改为');
      // 未污染内置函数对象：Object.prototype.toString 上不得出现事件键
      const fnProps = Object.getOwnPropertyNames(Object.prototype.toString);
      assert.ok(!fnProps.includes('e1') && !fnProps.includes('e2'));
      // close/reopen（跨进程持久）：同事件仍不双计数
      store.close();
      const reopened = await open(root, 'sc-d3');
      assert.equal((await reopened.feedback('toString', { used: true, sourceEventId: 'e1' })).useCount, 2);
      assert.equal((await reopened.recordUsefulFeedback('toString', { used: true, sourceEventId: 'e2' })).useCount, 2);
      const db2 = await dbJson(root, 'sc-d3');
      assert.ok(Object.hasOwn(db2.feedback.toString, 'e1') && Object.hasOwn(db2.feedback.toString, 'e2'));
      assert.equal((await reopened.read('toString')).revision, card.revision);
    });

    it('D-3 真实跨进程：全新 Node 子进程同事件反馈不双计数（新/旧/混合）', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-d3x');
      await saveCard(store, { id: 'toString' });
      await saveCard(store, { id: 'nm-1' });
      // 子进程脚本写在 tmp root 内（随 t.after 清理，不进封包）
      const childScript = path.join(root, '_d3-child.cjs');
      await fsp.writeFile(childScript, [
        "const { pathToFileURL } = require('node:url');",
        '(async () => {',
        "  const { openSparkStore } = await import(pathToFileURL(process.argv[2]).href);",
        '  const store = await openSparkStore({ root: process.argv[3], scopeId: process.argv[4] });',
        "  const api = process.argv[5] === 'old' ? 'feedback' : 'recordUsefulFeedback';",
        '  const card = await store[api](process.argv[6], { used: true, sourceEventId: process.argv[7] });',
        '  console.log(JSON.stringify({ useCount: card.useCount }));',
        "})().catch((e) => { console.error((e && e.code ? e.code + ': ' : '') + (e && e.message)); process.exit(1); });",
      ].join('\n'));
      const storePath = path.join(stage, 'src', 'sparks', 'store.mjs');
      const runChild = (api, cardId, evt) => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [childScript, storePath, root, 'sc-d3x', api, cardId, evt]);
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('close', (code) => {
          if (code !== 0) reject(new Error(`${api}:${cardId}:${evt} exit ${code}: ${err}`));
          else resolve(JSON.parse(out));
        });
      });
      // 两个全新子进程对同一事件：第二条必须重放去重（useCount 与首次相同）。
      // 注意 toString 卡跨事件对累加：三对事件各计一次，终值 3。
      let prev = 0;
      let pairIdx = 0;
      for (const [api1, api2] of [['useful', 'useful'], ['old', 'old'], ['old', 'useful']]) {
        const evt = `evt-x-${pairIdx}-${api1}`;
        pairIdx += 1;
        const c1 = await runChild(api1, 'toString', evt);
        assert.equal(c1.useCount, prev + 1, `${api1} 首次（新事件应计数）`);
        const c2 = await runChild(api2, 'toString', evt);
        assert.equal(c2.useCount, c1.useCount, `${api2} 跨进程去重（同事件不双计）`);
        prev = c1.useCount;
      }
      // 普通卡 + 原型事件名（toString/valueOf/hasOwnProperty 均为合法事件 id）自有持久
      // （"__proto__" 以非字母数字开头，本就不是合法事件 id，入口即拒）
      let nmCount = 0;
      for (const evt of ['toString', 'valueOf', 'hasOwnProperty']) {
        nmCount += 1;
        assert.equal((await runChild('useful', 'nm-1', evt)).useCount, nmCount, `evt=${evt} 首次`);
        assert.equal((await runChild('old', 'nm-1', evt)).useCount, nmCount, `evt=${evt} 跨进程去重`);
      }
      const db = await dbJson(root, 'sc-d3x');
      assert.equal(db.cards.toString.useCount, 3, 'toString 卡三对事件各计一次');
      assert.equal(db.cards['nm-1'].useCount, 3, 'nm-1 卡三个事件各计一次');
      assert.ok(Object.hasOwn(db.feedback['nm-1'], 'toString'));
      assert.ok(Object.hasOwn(db.feedback['nm-1'], 'valueOf'));
      assert.ok(Object.hasOwn(db.feedback['nm-1'], 'hasOwnProperty'));
      assert.ok(Object.hasOwn(db.feedback, 'toString'));
      // 无内置对象污染：Object.prototype.toString / Object.prototype 上无事件键
      assert.equal(Object.getOwnPropertyNames(Object.prototype.toString).filter((n) => n.startsWith('evt-')).length, 0);
      assert.ok(!Object.getOwnPropertyNames(Object.prototype).some((n) => n.startsWith('evt-')));
    });

    it('D-3 同事件不同 used 跨 API 拒绝；普通 id 行为不变', async (t) => {
      const root = await makeTmpRoot(t);
      const store = await open(root, 'sc-d3n');
      await saveCard(store, { id: 'normal-1' });
      await store.feedback('normal-1', { used: true, sourceEventId: 'ev-1' });
      await assertRejects(store.recordUsefulFeedback('normal-1', { used: false, sourceEventId: 'ev-1' }), 'INVALID_INPUT', '不能改为');
      await store.recordUsefulFeedback('normal-1', { used: true, sourceEventId: 'ev-2' });
      await assertRejects(store.feedback('normal-1', { used: false, sourceEventId: 'ev-2' }), 'INVALID_INPUT');
      assert.equal((await store.read('normal-1')).useCount, 2);
      const db = await dbJson(root, 'sc-d3n');
      assert.ok(Object.hasOwn(db.feedback['normal-1'], 'ev-1') && Object.hasOwn(db.feedback['normal-1'], 'ev-2'));
    });
  });

  // ------------------------------------------------------------------
  describe('真实旧回归（stage 生产位置运行 P0-P3 测试）', () => {
    it('定向：stage test/sparks 全套通过（旧 API、LOCK_BUSY 跨进程锁、损坏 fail-closed）', async () => {
      const files = await stageTestFiles(['sparks']);
      const { code, out, err } = await runNodeTest(files, 240_000);
      const counts = tapCounts(out);
      assert.equal(code, 0, `旧 sparks 回归失败：\n${out.slice(-4000)}\n${err.slice(-2000)}`);
      assert.ok(counts.tests > 0 && counts.fail === 0, `TAP 计数异常：${JSON.stringify(counts)}`);
    });

    it('定向：stage test/organize 全套通过（P3 方法保留 + G a2 冻结 loader 对照）', async () => {
      const files = await stageTestFiles(['organize']);
      const { code, out, err } = await runNodeTest(files, 240_000);
      const counts = tapCounts(out);
      assert.equal(code, 0, `旧 organize 回归失败：\n${out.slice(-4000)}\n${err.slice(-2000)}`);
      assert.ok(counts.tests > 0 && counts.fail === 0, `TAP 计数异常：${JSON.stringify(counts)}`);
    });

    it('全量：stage npm test 等价（P0-P3 全部套件真实运行）', async () => {
      const dirs = ['core', 'host', 'storage', 'service', 'integration', 'runtime', 'completion', 'acceptance', 'sparks', 'organize'];
      const files = await stageTestFiles(dirs);
      assert.ok(files.length >= 40, `stage 测试文件数量异常：${files.length}`);
      const { code, out, err } = await runNodeTest(files, 420_000);
      const counts = tapCounts(out);
      assert.equal(code, 0, `全量旧回归失败：\n${out.slice(-6000)}\n${err.slice(-2000)}`);
      assert.ok(counts.tests > 700 && counts.fail === 0, `TAP 计数异常：${JSON.stringify(counts)}`);
    });
  });
});
