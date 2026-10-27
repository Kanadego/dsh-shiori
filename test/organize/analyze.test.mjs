// P3-ORGANIZE · J 槽位定向测试（P3-CANDIDATES）
// 覆盖 CONTRACTS §5-J：排列稳定、跨 scope/重复/非法输入、入边孤立、
// 已有边/互逆不再建议、cluster 7/8 阈值、零写（原数组不变/无 fs import）、
// digest 稳定、limit 截断、返回引用不泄露、协议 JSON 反例。
// 全部为合成内存夹具：不触磁盘、不触真实 DSH/profile/memory/persona。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { analyzeCandidates } from '../../src/organize/analyze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// —— 夹具 ——

let seq = 0;
function card(overrides = {}) {
  seq += 1;
  const id = overrides.id ?? `card-${String(seq).padStart(3, '0')}`;
  return {
    id,
    scopeId: 'alpha',
    revision: overrides.revision ?? 1,
    state: 'active',
    title: `t-${id}`,
    summary: '',
    content: `c-${id}`,
    triggers: [],
    entities: [],
    links: [],
    vitality: 'evergreen',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** 与契约 §1 字面公式一致的 digest（测试侧自行实现，不 import 被测模块内部函数）。 */
function canon(value) {
  if (Array.isArray(value)) return value.map(canon);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canon(value[k])]));
  }
  return value;
}
const stable = (v) => JSON.stringify(canon(v));
const digestOf = (v) => createHash('sha256').update(Buffer.from(stable(v), 'utf8')).digest('hex');

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// —— 基础行为 ——

describe('analyzeCandidates · link 候选', () => {
  it('共享实体产生未连接 pair 的 link 候选，sources 按 id 排序、revision 绑定', () => {
    const a = card({ id: 'a', entities: ['Java', ' JVM '], revision: 3 });
    const b = card({ id: 'b', entities: ['jvm'], revision: 2 });
    const c = card({ id: 'c', entities: ['rust'] });
    const out = analyzeCandidates({ scopeId: 'alpha', records: [a, b, c] });
    const links = out.filter((x) => x.kind === 'link');
    assert.equal(links.length, 1);
    const l = links[0];
    assert.deepEqual(l.sources, [{ id: 'a', revision: 3 }, { id: 'b', revision: 2 }]);
    assert.deepEqual(l.evidence, { sharedEntities: ['jvm'], sharedTriggers: [] });
    assert.equal(l.scopeId, 'alpha');
  });

  it('共享 trigger 同样产生 link 候选，evidence 分字段记录', () => {
    const a = card({ id: 'a', triggers: ['deploy'] });
    const b = card({ id: 'b', triggers: ['Deploy'] }); // 大小写按 trim+toLowerCase 归一
    const out = analyzeCandidates({ scopeId: 'alpha', records: [a, b] });
    const links = out.filter((x) => x.kind === 'link');
    assert.equal(links.length, 1);
    assert.deepEqual(links[0].evidence, { sharedEntities: [], sharedTriggers: ['deploy'] });
  });

  it('任一方向已有链接（含互逆）不再建议', () => {
    const mk = (linksA, linksB) => [
      card({ id: 'a', entities: ['x'], links: linksA }),
      card({ id: 'b', entities: ['x'], links: linksB }),
    ];
    assert.equal(analyzeCandidates({ scopeId: 'alpha', records: mk([{ target: 'b', rel: 'related' }], []) }).filter((c) => c.kind === 'link').length, 0);
    assert.equal(analyzeCandidates({ scopeId: 'alpha', records: mk([], [{ target: 'a', rel: 'related' }]) }).filter((c) => c.kind === 'link').length, 0);
    assert.equal(analyzeCandidates({ scopeId: 'alpha', records: mk([{ target: 'b', rel: 'r1' }], [{ target: 'a', rel: 'r2' }]) }).filter((c) => c.kind === 'link').length, 0);
  });

  it('出边指向非 active 目标不阻断 pair 建议（该目标根本不在 records 中）', () => {
    const a = card({ id: 'a', entities: ['x'], links: [{ target: 'retired', rel: 'r' }] });
    const b = card({ id: 'b', entities: ['x'] });
    const out = analyzeCandidates({ scopeId: 'alpha', records: [a, b] });
    assert.equal(out.filter((c) => c.kind === 'link').length, 1);
  });
});

describe('analyzeCandidates · isolated 候选', () => {
  it('无任何 active 入边+出边的卡被标记 isolated', () => {
    const iso = card({ id: 'iso' });
    const hub = card({ id: 'hub', links: [{ target: 'leaf', rel: 'r' }] });
    const leaf = card({ id: 'leaf' });
    const out = analyzeCandidates({ scopeId: 'alpha', records: [iso, hub, leaf] });
    const isos = out.filter((c) => c.kind === 'isolated').map((c) => c.sources[0].id);
    // hub 有 active 出边；leaf 有 active 入边；iso 两者皆无
    assert.deepEqual(isos, ['iso']);
    const ev = out.find((c) => c.kind === 'isolated').evidence;
    assert.deepEqual(ev, { inDegree: 0, outDegree: 0, ignoredRetiredTargets: [] });
  });

  it('出边只指向非 active 目标仍算孤立，忽略目标列入证据', () => {
    const a = card({ id: 'a', links: [{ target: 'gone', rel: 'r' }, { target: 'gone', rel: 'r' }] });
    const out = analyzeCandidates({ scopeId: 'alpha', records: [a] });
    const isos = out.filter((c) => c.kind === 'isolated');
    assert.equal(isos.length, 1);
    assert.deepEqual(isos[0].evidence.ignoredRetiredTargets, ['gone']);
  });
});

describe('analyzeCandidates · cluster 候选', () => {
  it('7 张卡共享同一实体不产生 cluster，8 张产生', () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => card({ id: `c${i}`, entities: [' shared '] }));
    assert.equal(analyzeCandidates({ scopeId: 'alpha', records: mk(7) }).filter((c) => c.kind === 'cluster').length, 0);
    const out8 = analyzeCandidates({ scopeId: 'alpha', records: mk(8) });
    const clusters = out8.filter((c) => c.kind === 'cluster');
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].sources.length, 8);
    assert.deepEqual(clusters[0].evidence, { field: 'entities', sharedTerm: 'shared' });
    // sources 严格按 id 排序
    const ids = clusters[0].sources.map((s) => s.id);
    assert.deepEqual(ids, [...ids].sort());
  });

  it('trigger 共享同样可构成 cluster；相同成员集合确定性去重', () => {
    // entities:X 与 triggers:same 产生完全相同的成员集合 → 只保留 1 个候选
    const cards = Array.from({ length: 8 }, (_, i) => card({ id: `d${i}`, entities: ['X'], triggers: ['same'] }));
    const out = analyzeCandidates({ scopeId: 'alpha', records: cards });
    const clusters = out.filter((c) => c.kind === 'cluster');
    assert.equal(clusters.length, 1);
    // 确定性：entities 字段序在 triggers 之前
    assert.equal(clusters[0].evidence.field, 'entities');
  });

  it('不同成员集合各自成候选；成员不足 8 的第二个词不凑数', () => {
    const cards = [
      ...Array.from({ length: 8 }, (_, i) => card({ id: `big${i}`, entities: ['big'] })),
      ...Array.from({ length: 7 }, (_, i) => card({ id: `small${i}`, entities: ['big', 'small'] })),
    ];
    const out = analyzeCandidates({ scopeId: 'alpha', records: cards });
    const clusters = out.filter((c) => c.kind === 'cluster');
    assert.equal(clusters.length, 1); // 'small' 只有 7 张 → 不得凑数
    assert.equal(clusters[0].evidence.sharedTerm, 'big');
  });
});

// —— 确定性 ——

describe('analyzeCandidates · 确定性与排序', () => {
  const fixture = () => [
    card({ id: 'a', entities: ['x'], triggers: ['t'] }),
    card({ id: 'b', entities: ['x'], triggers: ['t'] }),
    card({ id: 'lonely' }),
    ...Array.from({ length: 8 }, (_, i) => card({ id: `g${i}`, entities: ['grp'] })),
  ];

  it('records 任意排列产出完全相同的候选集（含 id 与 sources）', () => {
    const base = analyzeCandidates({ scopeId: 'alpha', records: fixture() });
    for (let round = 0; round < 5; round += 1) {
      const shuffled = fixture().sort(() => ((seq = seq + 1), (seq % 3) - 1));
      const other = analyzeCandidates({ scopeId: 'alpha', records: shuffled });
      assert.deepEqual(other, base);
    }
  });

  it('候选排序先 kind（cluster<isolated<link）再 id', () => {
    const out = analyzeCandidates({ scopeId: 'alpha', records: fixture() });
    const kinds = out.map((c) => c.kind);
    const rank = { cluster: 0, isolated: 1, link: 2 };
    for (let i = 1; i < kinds.length; i += 1) {
      assert.ok(rank[kinds[i - 1]] <= rank[kinds[i]], `kind 顺序被破坏于 ${i}`);
      if (kinds[i - 1] === kinds[i]) assert.ok(out[i - 1].id < out[i].id, '同 kind 内 id 未升序');
    }
  });

  it('id 等于 SHA256(stable({kind,scopeId,sources,evidence}))，小写 64 hex', () => {
    const out = analyzeCandidates({ scopeId: 'alpha', records: fixture() });
    for (const cand of out) {
      assert.match(cand.id, /^[0-9a-f]{64}$/);
      assert.equal(
        cand.id,
        digestOf({ kind: cand.kind, scopeId: cand.scopeId, sources: cand.sources, evidence: cand.evidence }),
      );
    }
  });

  it('对象键序不同的等价记录产出相同候选（stable 序列化）', () => {
    const a = { ...card({ id: 'a', entities: ['x'] }) };
    const b = { ...card({ id: 'b', entities: ['x'] }) };
    // 倒置键序构造等价对象
    const flip = (o) => Object.fromEntries(Object.entries(o).reverse());
    const r1 = analyzeCandidates({ scopeId: 'alpha', records: [a, b] });
    const r2 = analyzeCandidates({ scopeId: 'alpha', records: [flip(a), flip(b)] });
    assert.deepEqual(r2, r1);
  });
});

// —— limit ——

describe('analyzeCandidates · limit', () => {
  const fixture = () => [
    card({ id: 'a', entities: ['x'] }),
    card({ id: 'b', entities: ['x'] }),
    card({ id: 'lonely' }),
  ];

  it('默认 100；超出的候选被确定性截断（排序后取前 N）', () => {
    const full = analyzeCandidates({ scopeId: 'alpha', records: fixture() });
    assert.ok(full.length >= 3);
    const two = analyzeCandidates({ scopeId: 'alpha', records: fixture(), limit: 2 });
    assert.deepEqual(two, full.slice(0, 2));
  });

  it('非法 limit 拒绝：0、-1、1001、1.5、"50"', () => {
    const records = fixture();
    for (const bad of [0, -1, 1001, 1.5, '50', Number.NaN]) {
      assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records, limit: bad }), (e) => e.code === 'INVALID_INPUT', `limit=${String(bad)} 应拒绝`);
    }
    assert.equal(analyzeCandidates({ scopeId: 'alpha', records, limit: 1000 }).length, analyzeCandidates({ scopeId: 'alpha', records }).length);
  });
});

// —— 输入校验反例 ——

describe('analyzeCandidates · 输入校验', () => {
  it('scopeId 缺失/非法拒绝', () => {
    const records = [card()];
    for (const bad of [undefined, null, '', '  x  ', 'a/b', 'GLOBAL', 's.', 'x\n']) {
      assert.throws(() => analyzeCandidates({ scopeId: bad, records }), (e) => e.code === 'INVALID_INPUT', `scopeId=${String(bad)} 应拒绝`);
    }
  });

  it('records 非数组 / 项非对象拒绝', () => {
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: 'no' }), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [null] }), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [[]] }), (e) => e.code === 'INVALID_INPUT');
  });

  it('跨 scope 记录拒绝', () => {
    assert.throws(
      () => analyzeCandidates({ scopeId: 'alpha', records: [card({ scopeId: 'beta' })] }),
      (e) => e.code === 'INVALID_INPUT',
    );
  });

  it('重复 id 拒绝', () => {
    assert.throws(
      () => analyzeCandidates({ scopeId: 'alpha', records: [card({ id: 'dup' }), card({ id: 'dup', revision: 2 })] }),
      (e) => e.code === 'INVALID_INPUT',
    );
  });

  it('非法 revision（0 / 1.5 / "1"）拒绝', () => {
    for (const bad of [0, -1, 1.5, '1']) {
      assert.throws(
        () => analyzeCandidates({ scopeId: 'alpha', records: [card({ revision: bad })] }),
        (e) => e.code === 'INVALID_INPUT',
        `revision=${String(bad)} 应拒绝`,
      );
    }
  });

  it('非 active 状态拒绝（陈旧/归档卡不得混入）', () => {
    for (const state of ['archived', 'superseded', 'merged', undefined]) {
      assert.throws(
        () => analyzeCandidates({ scopeId: 'alpha', records: [card({ state })] }),
        (e) => e.code === 'INVALID_INPUT',
        `state=${String(state)} 应拒绝`,
      );
    }
  });

  it('不完整卡拒绝（业务字段逐项：缺 id/scope/revision/state/title/summary/content/triggers/entities/links/vitality）', () => {
    const base = card();
    for (const key of ['id', 'scopeId', 'revision', 'state', 'title', 'summary', 'content', 'triggers', 'entities', 'links', 'vitality']) {
      const broken = { ...base };
      delete broken[key];
      assert.throws(
        () => analyzeCandidates({ scopeId: 'alpha', records: [broken] }),
        (e) => e.code === 'INVALID_INPUT',
        `缺 ${key} 应拒绝`,
      );
    }
  });

  it('完整卡 schema 之外的字段拒绝；审计字段不要求在场但在场必须形状正确', () => {
    assert.throws(
      () => analyzeCandidates({ scopeId: 'alpha', records: [card({ extra: { a: 1 } })] }),
      (e) => e.code === 'INVALID_INPUT',
      '未知字段 extra 应拒绝',
    );
    // 审计字段可省略
    const bare = card();
    delete bare.createdAt; delete bare.updatedAt;
    assert.ok(analyzeCandidates({ scopeId: 'alpha', records: [bare] }).length >= 0);
    // 在场但形状错误 → 拒绝
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [card({ createdAt: 123 })] }), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [card({ hitCount: -1 })] }), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [card({ supersedes: 5 })] }), (e) => e.code === 'INVALID_INPUT');
  });

  it('J-2 字段边界与冻结 store 一致：长度/数量/枚举越界一律拒绝', () => {
    const cases = [
      ['content 2001', card({ content: 'x'.repeat(2001) })],
      ['title 81', card({ title: 'x'.repeat(81) })],
      ['summary 121', card({ summary: 'x'.repeat(121) })],
      ['id 65', card({ id: 'a'.repeat(65) })],
      ['triggers 33 项', card({ triggers: Array.from({ length: 33 }, (_, i) => `t${i}`) })],
      ['entities 33 项', card({ entities: Array.from({ length: 33 }, (_, i) => `e${i}`) })],
      ['links 33 项', card({ links: Array.from({ length: 33 }, (_, i) => ({ target: `x${i}`, rel: 'r' })) })],
      ['term 65 字符', card({ triggers: ['t'.repeat(65)] })],
      ['rel 65 字符', card({ links: [{ target: 'b', rel: 'r'.repeat(65) }] })],
      ['空 trigger', card({ triggers: [''] })],
      ['纯空白 trigger', card({ triggers: ['   '] })],
      ['纯空白 rel', card({ links: [{ target: 'b', rel: '  ' }] })],
      ['空 rel', card({ links: [{ target: 'b', rel: '' }] })],
      ['self-link', card({ id: 'self', links: [{ target: 'self', rel: 'r' }] })],
      ['vitality 非法枚举', card({ vitality: 'green' })],
      ['vitality 缺失', card({ vitality: undefined })],
      ['summary 非字符串', card({ summary: 42 })],
      ['revision 0', card({ revision: 0 })],
      ['revision 1.5', card({ revision: 1.5 })],
      ['revision "1"', card({ revision: '1' })],
    ];
    for (const [label, bad] of cases) {
      assert.throws(
        () => analyzeCandidates({ scopeId: 'alpha', records: [bad] }),
        (e) => e.code === 'INVALID_INPUT',
        `${label} 应拒绝`,
      );
    }
  });

  it('合法文本（含边界码点）必须通过：U+D7FF / 全角Ａ / U+FF0C / U+E000 / U+FFFF / emoji 代理对', () => {
    const accepted = ['\ud7ff', 'Ａ', '，', '计划，下一步', '\ue000', '\uf900', '\uffff', '\u{1F600}', 'ＡＢＣ'];
    for (const text of accepted) {
      const out = analyzeCandidates({
        scopeId: 'alpha',
        records: [card({ id: 'a', title: `标题${text}`, content: `内容${text}` }), card({ id: 'b', title: 'x', content: 'y', entities: [`词${text}`] })],
      });
      assert.ok(Array.isArray(out), `text=${JSON.stringify(text)} 应接受`);
    }
  });

  it('J-3：含 U+0000 的完整词条保留在 evidence 中，不同词条候选 ID 不同', () => {
    // link：trigger 与 entity 各自验证；同前缀不同后缀的 NUL 词必须产出不同候选
    for (const field of ['triggers', 'entities']) {
      const mk = (term) => [
        card({ id: 'a', [field]: [term] }),
        card({ id: 'b', [field]: [term] }),
      ];
      const runs = ['x', 'x\u0000a', 'x\u0000b', 'x\u0000a\u0000b', '\u0000x'].map((term) => {
        const out = analyzeCandidates({ scopeId: 'alpha', records: mk(term) });
        const link = out.find((c) => c.kind === 'link');
        assert.ok(link, `term=${JSON.stringify(term)} 应产出 link 候选`);
        const ev = field === 'entities'
          ? { sharedEntities: [term], sharedTriggers: [] }
          : { sharedEntities: [], sharedTriggers: [term] };
        assert.deepEqual(link.evidence, ev, `term=${JSON.stringify(term)} 的 evidence 必须精确保留完整词条`);
        return { term, id: link.id, out };
      });
      const ids = new Set(runs.map((r) => r.id));
      assert.equal(ids.size, runs.length, '不同标准化词条的 link 候选 ID 不得碰撞');
      // 排列稳定：含 NUL 词的乱序输入产出相同候选集
      const base = analyzeCandidates({ scopeId: 'alpha', records: mk('x\u0000a') });
      assert.deepEqual(analyzeCandidates({ scopeId: 'alpha', records: [...mk('x\u0000a')].reverse() }), base);
    }
    // cluster >= 8：NUL 词照常成立，sharedTerm 精确保留
    const mkCluster = (term) => Array.from({ length: 8 }, (_, i) => card({ id: `n${i}`, entities: [term], triggers: [term] }));
    const outA = analyzeCandidates({ scopeId: 'alpha', records: mkCluster('x\u0000a') });
    const outB = analyzeCandidates({ scopeId: 'alpha', records: mkCluster('x\u0000b') });
    const clA = outA.filter((c) => c.kind === 'cluster');
    const clB = outB.filter((c) => c.kind === 'cluster');
    assert.equal(clA.length, 1);
    assert.equal(clB.length, 1);
    assert.deepEqual(clA[0].evidence, { field: 'entities', sharedTerm: 'x\u0000a' });
    assert.deepEqual(clB[0].evidence, { field: 'entities', sharedTerm: 'x\u0000b' });
    assert.notEqual(clA[0].id, clB[0].id, '不同 NUL 词条的 cluster 候选 ID 不得碰撞');
    // 同一输入的 entities 与 triggers 产生相同成员集合 → 确定性去重仍只保留 1 个
    assert.equal(clA.length, 1);
  });

  it('孤立代理码元拒绝（高/低代理、含对象键），合法代理对通过', () => {
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [card({ content: 'bad\ud800' })] }), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [card({ content: 'bad\udc00' })] }), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [card({ title: 'tail\udfff' })] }), (e) => e.code === 'INVALID_INPUT');
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [card({ triggers: ['w\ud800d'] })] }), (e) => e.code === 'INVALID_INPUT');
    const withBadKey = {
      ...card(),
      '\ud800k': 1, // 孤立代理对象键：无法无损 UTF-8，须拒绝
    };
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [withBadKey] }), (e) => e.code === 'INVALID_INPUT');
  });

  it('links 项形状非法拒绝（非对象/未知键/坏 target/空 rel）', () => {
    const cases = [
      ['x'],
      [{ target: 'b', rel: 'r', extra: 1 }],
      [{ target: 'bad id!', rel: 'r' }],
      [{ target: 'b', rel: '' }],
    ];
    for (const links of cases) {
      assert.throws(
        () => analyzeCandidates({ scopeId: 'alpha', records: [card({ links })] }),
        (e) => e.code === 'INVALID_INPUT',
        `links=${JSON.stringify(links)} 应拒绝`,
      );
    }
  });

  it('协议 JSON 之外拒绝：NaN revision / 函数字段 / 稀疏 triggers / 循环引用 / 孤立代理码元', () => {
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [card({ revision: Number.NaN })] }), (e) => e.code === 'INVALID_INPUT');
    const fn = card();
    fn.extra = () => {};
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [fn] }), (e) => e.code === 'INVALID_INPUT');
    const sparse = card();
    sparse.triggers = ['a'];
    sparse.triggers.length = 3; // 稀疏化
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [sparse] }), (e) => e.code === 'INVALID_INPUT');
    const cyc = card();
    cyc.self = cyc;
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [cyc] }), (e) => e.code === 'INVALID_INPUT');
    const lone = card({ title: 'ok' });
    lone.content = '\ud800'; // 孤立高代理：非 lossless UTF-8
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [lone] }), (e) => e.code === 'INVALID_INPUT');
  });

  it('空 records 与未知选项键', () => {
    assert.deepEqual(analyzeCandidates({ scopeId: 'alpha', records: [] }), []);
    assert.throws(() => analyzeCandidates({ scopeId: 'alpha', records: [], bogus: 1 }), (e) => e.code === 'INVALID_INPUT');
  });
});

// —— 纯度 / 零写 ——

describe('analyzeCandidates · 纯度', () => {
  it('不修改传入 records（deep-freeze 夹具 + 前后深比较）', () => {
    const records = [
      card({ id: 'a', entities: ['x'], triggers: [' T '], links: [{ target: 'b', rel: 'r' }] }),
      card({ id: 'b', entities: ['X'] }),
      ...Array.from({ length: 8 }, (_, i) => card({ id: `f${i}`, entities: ['grp'] })),
    ];
    const snapshot = JSON.parse(JSON.stringify(records));
    for (const r of records) Object.freeze(r);
    for (const r of records) {
      Object.freeze(r.entities);
      Object.freeze(r.triggers);
      Object.freeze(r.links);
    }
    Object.freeze(records);
    const out = analyzeCandidates({ scopeId: 'alpha', records });
    assert.ok(out.length > 0);
    assert.deepEqual(JSON.parse(JSON.stringify(records)), snapshot);
  });

  it('返回对象为全新引用，篡改返回值不污染后续结果', () => {
    const records = () => [card({ id: 'a', entities: ['x'] }), card({ id: 'b', entities: ['x'] })];
    const first = analyzeCandidates({ scopeId: 'alpha', records: records() });
    const linkOf = (list) => list.find((c) => c.kind === 'link');
    assert.ok(linkOf(first), '夹具应产出 link 候选');
    linkOf(first).sources.push({ id: 'hacked', revision: 1 });
    linkOf(first).evidence.sharedEntities.push('hacked');
    const second = analyzeCandidates({ scopeId: 'alpha', records: records() });
    assert.deepEqual(second, analyzeCandidates({ scopeId: 'alpha', records: records() }));
    assert.ok(!JSON.stringify(second).includes('hacked'));
  });

  it('候选 evidence 不含时间戳/随机/批准或执行语义', () => {
    const out = analyzeCandidates({ scopeId: 'alpha', records: fixtureLike() });
    const json = JSON.stringify(out);
    assert.ok(!/approval|approve|executed?|authorize|timestamp|Date\.now|random/i.test(json), `evidence 混入越界语义: ${json}`);
    for (const cand of out) {
      assert.deepEqual(Object.keys(cand).sort(), ['evidence', 'id', 'kind', 'scopeId', 'sources']);
    }
    function fixtureLike() {
      return [
        card({ id: 'a', entities: ['x'] }),
        card({ id: 'b', entities: ['x'] }),
        card({ id: 'lonely' }),
        ...Array.from({ length: 8 }, (_, i) => card({ id: `k${i}`, entities: ['grp'] })),
      ];
    }
  });

  it('模块零 I/O：analyze.mjs 的 import 语句不含 fs/path/宿主/队列/执行器/store', () => {
    const src = readFileSync(path.resolve(HERE, '../../src/organize/analyze.mjs'), 'utf8');
    const specifiers = [...src.matchAll(/^import\s[\s\S]*?from\s+['"]([^'"]+)['"];?$/gm)].map((m) => m[1]);
    assert.ok(specifiers.length > 0, '应解析到 import 语句');
    assert.deepEqual(specifiers, ['node:crypto', '../sparks/errors.mjs']);
  });
});
