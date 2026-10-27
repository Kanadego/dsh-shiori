// Shiori P4 · test/forgetting/cold-search.test.mjs
// O 槽单元测试：createColdSearch 显式冷库检索门面（fake store，非真实组合）。
// 契约：phase5/collab/CONTRACTS.md §1/§5/§7。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createColdSearch } from '../../src/forgetting/cold-search.mjs';

const SCOPE = 'amber';

/** 合法 archived 完整卡（合成；字段与基线 buildCard 形状一致）。 */
function archivedCard(overrides = {}) {
  return {
    id: 'spk-a',
    scopeId: SCOPE,
    revision: 2,
    title: 'Coffee Brewing Notes',
    summary: 'basic v60 recipe',
    triggers: ['v60', 'pour-over'],
    entities: ['coffee'],
    links: [],
    content: 'Use 15g coffee to 250ml water.',
    vitality: 'ephemeral',
    state: 'archived',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    archivedAt: '2026-10-25T00:00:00.000Z',
    supersedes: null,
    supersededBy: null,
    hitCount: 0,
    lastHitAt: null,
    useCount: 0,
    lastUsedAt: null,
    ...overrides,
  };
}

/** fake store：固定返回 + 调用计数 + 只读不变性断言材料。 */
function fakeStore(records) {
  const calls = [];
  return {
    calls,
    listArchived: async () => {
      calls.push(1);
      return records;
    },
  };
}

async function assertRejects(promise, code, label) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code, `${label}：期望 code=${code}，得到 ${e.code}（${e.message}）`);
    return true;
  }, label);
}

// ---------------------------------------------------------------------------
// factory 严格校验
// ---------------------------------------------------------------------------

test('factory：参数/store/scopeId 严格校验', async () => {
  await assertRejects(Promise.resolve().then(() => createColdSearch(null)), 'INVALID_INPUT', 'null options');
  await assertRejects(Promise.resolve().then(() => createColdSearch({})), 'INVALID_INPUT', '缺 store/scopeId');
  await assertRejects(
    Promise.resolve().then(() => createColdSearch({ store: fakeStore([]), scopeId: SCOPE, extra: 1 })),
    'INVALID_INPUT', '未知键',
  );
  await assertRejects(
    Promise.resolve().then(() => createColdSearch({ store: {}, scopeId: SCOPE })),
    'INVALID_INPUT', 'store.listArchived 非函数',
  );
  // scopeId 先查类型再复用 validateScopeId，不泄漏原生 TypeError
  await assertRejects(
    Promise.resolve().then(() => createColdSearch({ store: fakeStore([]), scopeId: 42 })),
    'INVALID_INPUT', '数字 scopeId',
  );
  await assertRejects(
    Promise.resolve().then(() => createColdSearch({ store: fakeStore([]), scopeId: 'GLOBAL' })),
    'INVALID_INPUT', 'global 大小写互斥基线仍然生效',
  );
  const facade = createColdSearch({ store: fakeStore([]), scopeId: SCOPE });
  assert.deepEqual(Object.keys(facade).sort(), ['search'], '返回对象只含 search');
});

// ---------------------------------------------------------------------------
// 请求严格选项
// ---------------------------------------------------------------------------

test('search 请求：形状/query/limit 严格校验', async () => {
  const search = createColdSearch({ store: fakeStore([]), scopeId: SCOPE }).search;
  await assertRejects(search(), 'INVALID_INPUT', '缺 request');
  await assertRejects(search(null), 'INVALID_INPUT', 'null request');
  await assertRejects(search({ query: 'x', limit: 20, extra: 1 }), 'INVALID_INPUT', '未知键');
  await assertRejects(search({}), 'INVALID_INPUT', '缺 query');
  await assertRejects(search({ limit: 20 }), 'INVALID_INPUT', '只有 limit');
  await assertRejects(search({ query: 'x', limit: undefined }), 'INVALID_INPUT', 'limit 显式 undefined');
  await assertRejects(search({ query: 'x', limit: 0 }), 'INVALID_INPUT', 'limit 0');
  await assertRejects(search({ query: 'x', limit: 101 }), 'INVALID_INPUT', 'limit 101');
  await assertRejects(search({ query: 'x', limit: 1.5 }), 'INVALID_INPUT', 'limit 非整数');
  await assertRejects(search({ query: 'x', limit: '20' }), 'INVALID_INPUT', 'limit 字符串');
  await assertRejects(search({ query: 'x', limit: 2 ** 53 }), 'INVALID_INPUT', 'limit 超 safe integer');
  await assertRejects(search({ query: 42 }), 'INVALID_INPUT', 'query 非字符串');
  await assertRejects(search({ query: '   ' }), 'INVALID_INPUT', 'query 纯空白 trim 后为空');
  await assertRejects(search({ query: '  \t\n ' }), 'INVALID_INPUT', 'query 混合空白 trim 后为空');
  await assertRejects(search({ query: 'x'.repeat(201) }), 'INVALID_INPUT', 'query 超 200');
  await assertRejects(search({ query: 'a\ud800b' }), 'INVALID_INPUT', '孤立代理不可 UTF-8');
  // trim 后恰好 200 合法（trim 前可更长）
  const r = await search({ query: `  ${'x'.repeat(200)}  ` });
  assert.equal(r.query.length, 200);
});

// ---------------------------------------------------------------------------
// 匹配语义
// ---------------------------------------------------------------------------

test('逐字段字面包含：title/summary/content/triggers/entities 任一命中', async () => {
  const cases = [
    ['title 命中', 'coffee brewing', true],
    ['summary 命中', 'v60 recipe', true],
    ['content 命中', '15g', true],
    ['triggers 元素命中', 'pour-over', true],
    ['entities 元素命中', 'coffee', true],
    ['大小写不敏感', 'USE 15G', true],
    ['trim 输入', '  coffee  ', true],
    ['未命中', 'espresso', false],
  ];
  const search = createColdSearch({ store: fakeStore([archivedCard()]), scopeId: SCOPE }).search;
  for (const [label, q, expectHit] of cases) {
    const r = await search({ query: q });
    assert.equal(r.items.length, expectHit ? 1 : 0, label);
  }
});

test('不跨字段/元素拼接：跨 title+summary、跨 trigger 相邻元素均不命中', async () => {
  const card = archivedCard({ title: 'Alpha', summary: 'Beta', triggers: ['gamma', 'delta'] });
  const search = createColdSearch({ store: fakeStore([card]), scopeId: SCOPE }).search;
  assert.equal((await search({ query: 'alphabeta' })).items.length, 0, 'title+summary 不拼接');
  assert.equal((await search({ query: 'gammadelta' })).items.length, 0, '数组逐元素、不 join');
  assert.equal((await search({ query: 'gamma delta' })).items.length, 0, '跨元素含空格不拼接');
});

test('字面匹配：正则元字符不当正则解释', async () => {
  const card = archivedCard({ title: 'a.c', summary: '', content: '', triggers: [], entities: [] });
  const search = createColdSearch({ store: fakeStore([card]), scopeId: SCOPE }).search;
  assert.equal((await search({ query: '.' })).items.length, 1, '字面点号命中 a.c');
  const card2 = archivedCard({ id: 'spk-b', title: 'xyz', summary: '', content: '', triggers: [], entities: [] });
  const search2 = createColdSearch({ store: fakeStore([card, card2]), scopeId: SCOPE }).search;
  assert.equal((await search2({ query: '.*' })).items.length, 0, '.* 不作为通配');
  assert.equal((await search2({ query: 'x.z' })).items.length, 0, '. 不通配任意字符');
});

test('结果恰好形状：id 排序、limit 截断、truncated 严格为命中数>limit', async () => {
  const mk = (id, title) => archivedCard({ id, title, summary: 'needle', content: '', triggers: [], entities: [] });
  const records = [mk('spk-c', 'c'), mk('spk-a', 'a'), mk('spk-b', 'b'), mk('spk-d', 'd')];
  const search = createColdSearch({ store: fakeStore(records), scopeId: SCOPE }).search;

  const all = await search({ query: 'needle' });
  assert.equal(all.truncated, false, '4 命中 > limit=20？否 → 不截断');
  assert.deepEqual(all.items.map((i) => i.id), ['spk-a', 'spk-b', 'spk-c', 'spk-d'], '按 id 升序');

  const two = await search({ query: 'needle', limit: 2 });
  assert.equal(two.truncated, true, '4 > 2 → 截断');
  assert.deepEqual(two.items.map((i) => i.id), ['spk-a', 'spk-b']);

  const exact = await search({ query: 'needle', limit: 4 });
  assert.equal(exact.truncated, false, '4 == 4 → 不截断（严格 >）');
  assert.equal(exact.items.length, 4);

  const one = await search({ query: 'needle', limit: 1 });
  assert.equal(one.truncated, true);
  assert.deepEqual(one.items.map((i) => i.id), ['spk-a']);

  assert.deepEqual(Object.keys(two).sort(), ['items', 'kind', 'query', 'scopeId', 'truncated']);
  assert.deepEqual(Object.keys(two.items[0]).sort(), ['archivedAt', 'id', 'revision', 'state', 'summary', 'title']);
  assert.equal(two.items[0].state, 'archived');
  assert.equal(two.kind, 'cold-search');
  assert.equal(two.scopeId, SCOPE);
  assert.equal(two.query, 'needle');
});

test('非 BMP/Unicode 大小写折叠：É 匹配 é（toLowerCase 语义）', async () => {
  const card = archivedCard({ id: 'spk-u', title: 'Café 黃昏メモ', summary: '', content: '', triggers: [], entities: [] });
  const search = createColdSearch({ store: fakeStore([card]), scopeId: SCOPE }).search;
  assert.equal((await search({ query: 'café' })).items.length, 1, '小写精确');
  assert.equal((await search({ query: 'CAFÉ' })).items.length, 1, 'É 折叠为 é');
  assert.equal((await search({ query: '黃昏' })).items.length, 1, 'CJK 子串');
});

test('只读：每次 search 恰好调用一次 store，记录对象不被改动，无任何写入通道', async () => {
  const records = [archivedCard(), archivedCard({ id: 'spk-b' })];
  const snapshot = structuredClone(records);
  const store = fakeStore(records);
  const search = createColdSearch({ store, scopeId: SCOPE }).search;
  await search({ query: 'coffee' });
  await search({ query: 'nothing' });
  await search({ query: 'coffee', limit: 1 });
  assert.equal(store.calls.length, 3, '显式调用 3 次，无自动调用');
  assert.deepEqual(records, snapshot, '冷库记录不被修改/续期/写统计');
});

// ---------------------------------------------------------------------------
// 记录核验（store 违反契约 → INVALID_STATE fail-closed）
// ---------------------------------------------------------------------------

test('跨 scope / 非 archived / 损坏记录一律 INVALID_STATE', async () => {
  const bad = [
    ['跨 scope', [archivedCard({ scopeId: 'other' })]],
    ['active 卡', [archivedCard({ state: 'active' })]],
    ['superseded 卡', [archivedCard({ state: 'superseded' })]],
    ['merged 卡', [archivedCard({ state: 'merged' })]],
    ['title 缺失', [archivedCard({ title: undefined })]],
    ['summary 非字符串', [archivedCard({ summary: 5 })]],
    ['revision 非正', [archivedCard({ revision: 0 })]],
    ['archivedAt 非规范', [archivedCard({ archivedAt: '2026-10-25T00:00:00Z' })]],
    ['id 非法形状', [archivedCard({ id: 'bad id' })]],
    ['content 类型损坏', [archivedCard({ content: 7 })]],
    ['triggers 混入非字符串', [archivedCard({ triggers: ['ok', 3] })]],
  ];
  for (const [label, records] of bad) {
    const search = createColdSearch({ store: fakeStore(records), scopeId: SCOPE }).search;
    await assertRejects(search({ query: 'coffee' }), 'INVALID_STATE', label);
  }
  // 非数组返回同样拒绝
  const searchArr = createColdSearch({ store: { listArchived: async () => ({}) }, scopeId: SCOPE }).search;
  await assertRejects(searchArr({ query: 'x' }), 'INVALID_STATE', 'listArchived 返回非数组');
});

test('store 抛错原样传播；检索材料字段缺失时仅跳过该字段匹配', async () => {
  const boom = new Error('LOCK_BUSY from store');
  const search = createColdSearch({
    store: { listArchived: async () => { throw boom; } },
    scopeId: SCOPE,
  }).search;
  await assert.rejects(search({ query: 'x' }), (e) => e === boom, '同一错误对象冒泡');

  // 摘要字段完整、检索材料（content/triggers/entities）缺失的记录仍可按 title 检索
  const slim = { ...archivedCard() };
  delete slim.content;
  delete slim.triggers;
  delete slim.entities;
  const ok = createColdSearch({ store: fakeStore([slim]), scopeId: SCOPE }).search;
  const r = await ok({ query: 'coffee brewing' });
  assert.equal(r.items.length, 1);
  assert.equal((await ok({ query: '15g' })).items.length, 0, '缺 content 时正文不参与匹配');
});

// ---------------------------------------------------------------------------
// 主审 a1 返工 D-1 回归：损坏冷库记录一律 INVALID_STATE，不泄漏原生错误
// ---------------------------------------------------------------------------

test('D-1 回归：稀疏数组洞 / BigInt state 不触发原生 TypeError，均 INVALID_STATE', async () => {
  const bad = [
    ['triggers 稀疏数组（单洞）', { ...archivedCard(), triggers: new Array(1) }],
    ['triggers 稀疏数组（中间洞）', { ...archivedCard(), triggers: ['ok', , 'also'] }],
    ['entities 稀疏数组', { ...archivedCard(), entities: ['ok', ,] }],
    ['state 为 BigInt', { ...archivedCard(), state: 1n }],
    ['state 为数字', { ...archivedCard(), state: 1 }],
    ['revision 为 BigInt', { ...archivedCard(), revision: 2n }],
    ['title 为 BigInt', { ...archivedCard(), title: 1n }],
    ['summary 为对象', { ...archivedCard(), summary: { x: 1 } }],
    ['triggers 元素为 BigInt', { ...archivedCard(), triggers: ['ok', 1n] }],
  ];
  for (const [label, record] of bad) {
    const search = createColdSearch({ store: fakeStore([record]), scopeId: SCOPE }).search;
    // 匹配与否都必须在校验层 fail-closed：用命中与不命中两种 query 都试一次
    await assertRejects(search({ query: 'coffee' }), 'INVALID_STATE', `${label}（命中路径）`);
    await assertRejects(search({ query: 'zzz-no-hit' }), 'INVALID_STATE', `${label}（未命中路径）`);
  }
});

test('D-1 回归：孤立代理码元的任何读取字符串一律 INVALID_STATE，不得进入输出', async () => {
  const lone = 'a\ud800b';
  const bad = [
    ['title 孤立代理', { ...archivedCard(), title: lone }],
    ['summary 孤立代理', { ...archivedCard(), summary: lone }],
    ['content 孤立代理', { ...archivedCard(), content: lone }],
    ['triggers 元素孤立代理', { ...archivedCard(), triggers: ['ok', lone] }],
    ['entities 元素孤立代理', { ...archivedCard(), entities: [lone] }],
    ['summary 尾部孤立高代理', { ...archivedCard(), summary: 'ok\ud800' }],
  ];
  for (const [label, record] of bad) {
    const search = createColdSearch({ store: fakeStore([record]), scopeId: SCOPE }).search;
    await assertRejects(search({ query: 'coffee' }), 'INVALID_STATE', label);
    const r2 = await (async () => {
      try { await search({ query: 'zzz' }); return 'leaked'; } catch (e) { return e.code; }
    })();
    assert.equal(r2, 'INVALID_STATE', `${label}：未命中路径同样拒绝`);
  }
  // 合法代理对（非 BMP 字符）不受影响：可读、可命中、可输出
  const good = archivedCard({ id: 'spk-ok', title: 'Café 黃昏メモ \u{1F9E1}', summary: '\u{1D306} summary' });
  const search = createColdSearch({ store: fakeStore([good]), scopeId: SCOPE }).search;
  const r = await search({ query: 'café' });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].summary, '\u{1D306} summary');
});
