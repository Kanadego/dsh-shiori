// P4-FORGETTING · M 槽位定向测试（P4-DECAY-ANALYSIS）
// 覆盖 CONTRACTS §1/§2/§3：
//   - policy 默认/部分覆盖/区间/显式 undefined/未知键/非普通对象/独立返回；
//   - 59/60/61 天阈值边界（60 天恰等于默认阈值不归档）、自定义阈值须满 60 天且严格低于；
//   - lastUsedAt 锚点优先、useCount 增半衰、大指数封顶（无 Infinity/NaN 污染）；
//   - evergreen / 退休状态 / 承接卡免疫；匹配/曝光（hitCount/lastHitAt）不续期；
//   - 时钟回拨 elapsed 夹 0 + 结构化 CLOCK_ROLLBACK 报警（非候选也报警）；
//   - reason 优先级链；返回恰好形状；
//   - analyzeForgetting：assessments/alarms 排序合并、候选排序与 limit（1..20）、
//     §3 Source/Plan 形状与独立 clone、plan=null、<=10000、跨 scope/重复 id/坏记录
//     整次报错、未知选项/缺必需参数拒绝；
//   - 不改输入（deep-freeze 夹具 + JSON 快照）；不泄漏原生 TypeError。
// 全部为合成内存夹具：不触磁盘、不触真实 DSH/profile/memory/persona。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FORGET_POLICY,
  normalizeForgetPolicy,
  evaluateSparkDecay,
  analyzeForgetting,
} from '../../src/forgetting/decay.mjs';

// —— 夹具 ——

const T0 = '2026-01-01T00:00:00.000Z';
const DAY = 86400000;
/** T0 之后 days 天的规范 UTC ISO（毫秒整精度）。 */
const at = (days) => new Date(Date.parse(T0) + days * DAY).toISOString();
const NOW = at(300);

let seq = 0;
/** 最小必需九字段卡（§2 下界形状）。 */
function spark(overrides = {}) {
  seq += 1;
  const id = overrides.id ?? `spk-${String(seq).padStart(3, '0')}`;
  return {
    id,
    scopeId: 'alpha',
    revision: 1,
    state: 'active',
    vitality: 'ephemeral',
    createdAt: T0,
    lastUsedAt: null,
    useCount: 0,
    supersedes: null,
    ...overrides,
  };
}

/** 冻结 store buildCard 的完整卡形状（20 字段）。 */
function fullCard(overrides = {}) {
  const base = spark(overrides);
  return {
    title: `t-${base.id}`,
    summary: '',
    content: `c-${base.id}`,
    triggers: [],
    entities: [],
    links: [],
    updatedAt: base.createdAt,
    archivedAt: null,
    supersededBy: null,
    hitCount: 0,
    lastHitAt: null,
    ...base,
  };
}

function deepFreeze(value) {
  Object.freeze(value);
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** 统一断言：SparkStoreError + 稳定 code，绝不泄漏原生 TypeError。 */
function assertInvalidInput(fn, part) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof Error, `应抛 Error，得到 ${err}`);
    assert.ok(!(err instanceof TypeError), `泄漏原生 TypeError：${err && err.stack}`);
    assert.equal(err.name, 'SparkStoreError');
    assert.equal(err.code, 'INVALID_INPUT');
    if (part !== undefined) assert.ok(err.message.includes(part), `文案应含 "${part}"，得到 "${err.message}"`);
    return true;
  });
}

const keysOf = (obj) => Object.keys(obj).sort();
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// —— DEFAULT_FORGET_POLICY / normalizeForgetPolicy ——

describe('DEFAULT_FORGET_POLICY 与 normalizeForgetPolicy', () => {
  it('默认策略恰为冻结三字段 {30,240,0.25} 且对象已冻结', () => {
    assert.deepEqual(DEFAULT_FORGET_POLICY, { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });
    assert.equal(Object.isFrozen(DEFAULT_FORGET_POLICY), true);
    assert.throws(() => { DEFAULT_FORGET_POLICY.baseHalfLifeDays = 1; }, TypeError);
    assert.equal(DEFAULT_FORGET_POLICY.baseHalfLifeDays, 30);
  });

  it('无参/空对象返回补全默认的独立完整对象', () => {
    for (const policy of [undefined, {}]) {
      const out = normalizeForgetPolicy(policy);
      assert.deepEqual(out, { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });
      assert.notEqual(out, DEFAULT_FORGET_POLICY);
      assert.equal(Object.isFrozen(out), false);
    }
    const a = normalizeForgetPolicy();
    const b = normalizeForgetPolicy();
    assert.notEqual(a, b);
    a.baseHalfLifeDays = 7; // 返回值可变不影响默认与后续调用
    assert.equal(b.baseHalfLifeDays, 30);
    assert.equal(DEFAULT_FORGET_POLICY.baseHalfLifeDays, 30);
    assert.equal(normalizeForgetPolicy().baseHalfLifeDays, 30);
  });

  it('部分覆盖再补默认；全量覆盖生效', () => {
    assert.deepEqual(normalizeForgetPolicy({ baseHalfLifeDays: 10 }), { baseHalfLifeDays: 10, maxHalfLifeDays: 240, archiveScore: 0.25 });
    assert.deepEqual(normalizeForgetPolicy({ maxHalfLifeDays: 300 }), { baseHalfLifeDays: 30, maxHalfLifeDays: 300, archiveScore: 0.25 });
    assert.deepEqual(normalizeForgetPolicy({ archiveScore: 0.5 }), { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.5 });
    assert.deepEqual(
      normalizeForgetPolicy({ baseHalfLifeDays: 1, maxHalfLifeDays: 3650, archiveScore: 0.001 }),
      { baseHalfLifeDays: 1, maxHalfLifeDays: 3650, archiveScore: 0.001 },
    );
  });

  it('区间边界：base [1,365] 闭、max [base,3650] 闭、archiveScore (0,1) 开', () => {
    normalizeForgetPolicy({ baseHalfLifeDays: 1 });
    normalizeForgetPolicy({ baseHalfLifeDays: 365, maxHalfLifeDays: 365 }); // base 达上界须同步抬高 max
    normalizeForgetPolicy({ baseHalfLifeDays: 100, maxHalfLifeDays: 100 }); // max === base 合法
    normalizeForgetPolicy({ maxHalfLifeDays: 3650 });
    normalizeForgetPolicy({ archiveScore: 0.0000001 });
    normalizeForgetPolicy({ archiveScore: 0.9999999 });
    // 部分覆盖与默认的交互：单独抬 base=365 超过补默认的 max=240 → 违反 max>=base 拒绝
    assertInvalidInput(() => normalizeForgetPolicy({ baseHalfLifeDays: 365 }), '[base,3650]');
    assertInvalidInput(() => normalizeForgetPolicy({ baseHalfLifeDays: 0.999 }), '[1,365]');
    assertInvalidInput(() => normalizeForgetPolicy({ baseHalfLifeDays: 365.0001 }), '[1,365]');
    assertInvalidInput(() => normalizeForgetPolicy({ baseHalfLifeDays: 30, maxHalfLifeDays: 29.999 }), '[base,3650]');
    assertInvalidInput(() => normalizeForgetPolicy({ maxHalfLifeDays: 3650.1 }), '3650');
    assertInvalidInput(() => normalizeForgetPolicy({ archiveScore: 0 }), '(0,1)');
    assertInvalidInput(() => normalizeForgetPolicy({ archiveScore: 1 }), '(0,1)');
  });

  it('NaN/Infinity/-Infinity/非数值一律拒绝', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, '30', null, true]) {
      assertInvalidInput(() => normalizeForgetPolicy({ baseHalfLifeDays: bad }), 'baseHalfLifeDays');
      assertInvalidInput(() => normalizeForgetPolicy({ maxHalfLifeDays: bad }), 'maxHalfLifeDays');
      assertInvalidInput(() => normalizeForgetPolicy({ archiveScore: bad }), 'archiveScore');
    }
  });

  it('未知键拒绝；自有键显式 undefined 拒绝；null/数组/类实例等非普通对象拒绝', () => {
    assertInvalidInput(() => normalizeForgetPolicy({ baseHalfLifeDays: 30, extra: 1 }), '未知键');
    assertInvalidInput(() => normalizeForgetPolicy({ baseHalfLifeDays: undefined }), 'undefined');
    assertInvalidInput(() => normalizeForgetPolicy({ maxHalfLifeDays: undefined }), 'undefined');
    assertInvalidInput(() => normalizeForgetPolicy({ archiveScore: undefined }), 'undefined');
    assertInvalidInput(() => normalizeForgetPolicy(null), '普通对象');
    assertInvalidInput(() => normalizeForgetPolicy([]), '普通对象');
    assertInvalidInput(() => normalizeForgetPolicy('x'), '普通对象');
    assertInvalidInput(() => normalizeForgetPolicy(30), '普通对象');
    assertInvalidInput(() => normalizeForgetPolicy(new Date()), '普通对象');
    // null 原型普通对象放行（§1：Object.prototype 或 null 原型）
    const nullProto = Object.assign(Object.create(null), { baseHalfLifeDays: 12 });
    assert.deepEqual(
      normalizeForgetPolicy(nullProto),
      { baseHalfLifeDays: 12, maxHalfLifeDays: 240, archiveScore: 0.25 },
    );
  });

  it('继承字段不作输入：自定义原型对象拒绝；Object.prototype 成员不误当输入键', () => {
    // 自定义原型（非 Object.prototype/null）整体拒绝，不存在「继承键混入」通道
    const withProto = Object.create({ baseHalfLifeDays: 9, maxHalfLifeDays: 9, archiveScore: 0.9 });
    assertInvalidInput(() => normalizeForgetPolicy(withProto), '普通对象');
    // 空自有键对象：继承的 toString/constructor 等 Object.prototype 成员不是输入键，
    // 不触发未知键拒绝，按未提供处理补全默认
    assert.deepEqual(
      normalizeForgetPolicy({}),
      { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 },
    );
  });
});

// —— evaluateSparkDecay · 时间与阈值 ——

describe('evaluateSparkDecay · 阈值边界与衰减公式', () => {
  it('默认策略：59 天 too-recent；恰 60 天 score 恰为 0.25 不严格低于阈值 → 不归档；61 天 eligible', () => {
    const r59 = evaluateSparkDecay(spark(), { now: at(59) });
    assert.equal(r59.reason, 'too-recent');
    assert.equal(r59.eligible, false);

    const r60 = evaluateSparkDecay(spark(), { now: at(60) });
    assert.equal(r60.elapsedDays, 60);
    assert.equal(r60.halfLifeDays, 30);
    assert.equal(r60.score, 0.25); // 2**(-60/30) = 2**-2，浮点精确
    assert.equal(r60.reason, 'score-not-below-threshold');
    assert.equal(r60.eligible, false);

    const r61 = evaluateSparkDecay(spark(), { now: at(61) });
    assert.equal(r61.reason, 'eligible');
    assert.equal(r61.eligible, true);
    assert.ok(r61.score < 0.25);
  });

  it('返回恰好 {id,revision,elapsedDays,halfLifeDays,score,eligible,reason,alarms} 八键', () => {
    const r = evaluateSparkDecay(spark({ id: 'x-1', revision: 4 }), { now: NOW });
    assert.deepEqual(keysOf(r), [
      'alarms', 'elapsedDays', 'eligible', 'halfLifeDays', 'id', 'reason', 'revision', 'score',
    ]);
    assert.equal(r.id, 'x-1');
    assert.equal(r.revision, 4);
    assert.deepEqual(r.alarms, []);
  });

  it('lastUsedAt 锚点优先：近期使用续命，忽略更早的 createdAt', () => {
    const card = spark({ createdAt: T0, lastUsedAt: at(270) });
    const r = evaluateSparkDecay(card, { now: at(300) });
    assert.equal(r.elapsedDays, 30);
    assert.equal(r.reason, 'too-recent');
    // 反例：去掉 lastUsedAt，同卡 300 天可归档
    const r2 = evaluateSparkDecay(spark({ createdAt: T0, lastUsedAt: null }), { now: at(300) });
    assert.equal(r2.reason, 'eligible');
  });

  it('useCount 指数延长半衰期：halfLifeDays=min(base*2**useCount,max)', () => {
    assert.equal(evaluateSparkDecay(spark({ useCount: 1 }), { now: NOW }).halfLifeDays, 60);
    assert.equal(evaluateSparkDecay(spark({ useCount: 2 }), { now: NOW }).halfLifeDays, 120);
    assert.equal(evaluateSparkDecay(spark({ useCount: 3 }), { now: NOW }).halfLifeDays, 240); // 30*8=240 恰等于 max
    assert.equal(evaluateSparkDecay(spark({ useCount: 4 }), { now: NOW }).halfLifeDays, 240); // 封顶
  });

  it('大指数封顶：useCount 达 1024/安全整数上限时 halfLifeDays=max，无 Infinity/NaN 污染', () => {
    for (const useCount of [1023, 1024, 5000, Number.MAX_SAFE_INTEGER]) {
      const r = evaluateSparkDecay(spark({ useCount }), { now: at(2400) });
      assert.equal(r.halfLifeDays, 240, `useCount=${useCount}`);
      assert.equal(Number.isFinite(r.score), true, `useCount=${useCount}`);
      assert.equal(Number.isNaN(r.score), false, `useCount=${useCount}`);
      // 2400 天 / 240 半衰 = 10 个半衰 → score=2**-10
      assert.ok(Math.abs(r.score - 2 ** -10) < 1e-12, `useCount=${useCount}`);
      assert.equal(r.reason, 'eligible'); // 2**-10 < 0.25 且 2400>=60
    }
  });

  it('自定义阈值：必须满 60 天冷却且分数严格低于阈值', () => {
    const policy = { baseHalfLifeDays: 100, archiveScore: 0.9 };
    // 55 天：score≈0.68 < 0.9 但未满冷却 → too-recent
    assert.equal(evaluateSparkDecay(spark(), { now: at(55), policy }).reason, 'too-recent');
    // 80 天：score=2**-0.8≈0.574 < 0.9 且 >=60 → eligible
    const r = evaluateSparkDecay(spark(), { now: at(80), policy });
    assert.equal(r.reason, 'eligible');
    assert.ok(r.score < 0.9);
    // 恰好压线：base=30 时选阈值 2**-(80/30) 的分数 → 相等不归档（严格低于）
    const edge = 2 ** (-80 / 30);
    assert.equal(
      evaluateSparkDecay(spark(), { now: at(80), policy: { archiveScore: edge } }).reason,
      'score-not-below-threshold',
    );
    assert.equal(
      evaluateSparkDecay(spark(), { now: at(80), policy: { archiveScore: edge * 1.0000001 } }).reason,
      'eligible',
    );
  });

  it('匹配/曝光不续期：hitCount/lastHitAt 再新也不影响锚点', () => {
    const card = fullCard({ createdAt: T0, lastUsedAt: null, hitCount: 999, lastHitAt: at(299) });
    const r = evaluateSparkDecay(card, { now: NOW });
    assert.equal(r.elapsedDays, 300);
    assert.equal(r.reason, 'eligible');
  });

  it('接受完整卡形状（20 字段）与 merged 卡 mergedInto/mergedAt，未知字段拒绝', () => {
    const r = evaluateSparkDecay(fullCard({ id: 'full-1' }), { now: at(70) });
    assert.equal(r.reason, 'eligible');
    const merged = fullCard({ id: 'm-1', state: 'merged', mergedInto: 'topic-key', mergedAt: NOW });
    assert.equal(evaluateSparkDecay(merged, { now: NOW }).reason, 'inactive');
    assertInvalidInput(() => evaluateSparkDecay(fullCard({ nope: 1 }), { now: NOW }), 'schema 之外');
  });
});

// —— evaluateSparkDecay · 资格与免疫 ——

describe('evaluateSparkDecay · 免疫与 reason 优先级', () => {
  it('evergreen 免疫：halfLifeDays=null、score=1，年龄仍同锚点计算', () => {
    const r = evaluateSparkDecay(spark({ vitality: 'evergreen', createdAt: T0 }), { now: at(5000) });
    assert.equal(r.halfLifeDays, null);
    assert.equal(r.score, 1);
    assert.equal(r.elapsedDays, 5000);
    assert.equal(r.reason, 'evergreen');
    assert.equal(r.eligible, false);
  });

  it('退休状态不候选：archived/superseded/merged → inactive', () => {
    for (const state of ['archived', 'superseded', 'merged']) {
      const r = evaluateSparkDecay(spark({ state }), { now: at(500) });
      assert.equal(r.reason, 'inactive', state);
      assert.equal(r.eligible, false, state);
      // 分数仍按公式计算（非候选也有真实评估）
      assert.ok(r.score < 0.25, state);
    }
  });

  it('承接替代卡保护：supersedes 非空 → replacement-protected', () => {
    const r = evaluateSparkDecay(spark({ supersedes: 'old-1' }), { now: at(500) });
    assert.equal(r.reason, 'replacement-protected');
    assert.equal(r.eligible, false);
  });

  it('reason 优先级：inactive > evergreen > replacement-protected', () => {
    assert.equal(
      evaluateSparkDecay(spark({ state: 'archived', vitality: 'evergreen' }), { now: NOW }).reason,
      'inactive',
    );
    assert.equal(
      evaluateSparkDecay(spark({ state: 'superseded', vitality: 'evergreen' }), { now: NOW }).reason,
      'inactive',
    );
    assert.equal(
      evaluateSparkDecay(spark({ vitality: 'evergreen', supersedes: 'old-1' }), { now: NOW }).reason,
      'evergreen',
    );
  });
});

// —— evaluateSparkDecay · 时钟回拨 ——

describe('evaluateSparkDecay · 时钟回拨报警', () => {
  it('now < lastUsedAt：elapsedDays 夹 0、reason=clock-rollback、结构化报警', () => {
    const card = spark({ createdAt: T0, lastUsedAt: at(100) });
    const r = evaluateSparkDecay(card, { now: at(40) });
    assert.equal(r.elapsedDays, 0);
    assert.equal(r.reason, 'clock-rollback');
    assert.equal(r.eligible, false);
    assert.equal(r.score, 1); // elapsed=0 → 2**0
    assert.deepEqual(r.alarms, [{ code: 'CLOCK_ROLLBACK', id: card.id, anchorAt: at(100), now: at(40) }]);
  });

  it('now < createdAt（lastUsedAt=null）同样报警，anchorAt=createdAt', () => {
    const r = evaluateSparkDecay(spark({ createdAt: T0 }), { now: '2025-12-01T00:00:00.000Z' });
    assert.equal(r.elapsedDays, 0);
    assert.equal(r.reason, 'clock-rollback');
    assert.deepEqual(r.alarms, [{ code: 'CLOCK_ROLLBACK', id: r.id, anchorAt: T0, now: '2025-12-01T00:00:00.000Z' }]);
  });

  it('now === 锚点不算回拨：elapsed=0、无报警、too-recent', () => {
    const r = evaluateSparkDecay(spark({ lastUsedAt: at(100) }), { now: at(100) });
    assert.equal(r.elapsedDays, 0);
    assert.deepEqual(r.alarms, []);
    assert.equal(r.reason, 'too-recent');
  });

  it('非候选遇回拨也报警：archived/evergreen/承接卡报警但 reason 保持更高优先级', () => {
    const rollbackNow = '2025-06-01T00:00:00.000Z';
    const archived = evaluateSparkDecay(spark({ state: 'archived', createdAt: T0 }), { now: rollbackNow });
    assert.equal(archived.reason, 'inactive');
    assert.equal(archived.alarms.length, 1);
    assert.equal(archived.alarms[0].code, 'CLOCK_ROLLBACK');

    const ever = evaluateSparkDecay(spark({ vitality: 'evergreen', createdAt: T0 }), { now: rollbackNow });
    assert.equal(ever.reason, 'evergreen');
    assert.equal(ever.alarms.length, 1);

    const prot = evaluateSparkDecay(spark({ supersedes: 'old-1', createdAt: T0 }), { now: rollbackNow });
    assert.equal(prot.reason, 'replacement-protected');
    assert.equal(prot.alarms.length, 1);
  });
});

// —— evaluateSparkDecay · 输入校验与纯度 ——

describe('evaluateSparkDecay · 输入校验、不改输入、不泄漏 TypeError', () => {
  it('opts：非普通对象/未知键/缺 now/显式 undefined policy 全部拒绝', () => {
    const card = spark();
    assertInvalidInput(() => evaluateSparkDecay(card, null), '普通对象');
    assertInvalidInput(() => evaluateSparkDecay(card, undefined), '普通对象');
    assertInvalidInput(() => evaluateSparkDecay(card, 42), '普通对象');
    assertInvalidInput(() => evaluateSparkDecay(card, { now: NOW, extra: 1 }), '未知键');
    assertInvalidInput(() => evaluateSparkDecay(card, { policy: {} }), 'now 必须显式注入');
    assertInvalidInput(() => evaluateSparkDecay(card, { now: NOW, policy: undefined }), 'undefined');
  });

  it('now 必须是规范 UTC ISO：本地偏移/缺毫秒/日期串/非法串全拒', () => {
    const card = spark();
    for (const bad of [
      '2026-01-01T08:00:00.000+08:00', // 本地偏移
      '2026-01-01T00:00:00Z',          // 缺毫秒
      '2026-01-01',                    // 纯日期
      '2026-13-01T00:00:00.000Z',      // 非法月份
      'not-a-date',
      1767225600000,                   // 数字时间戳
      new Date().toISOString() === '' ? null : null,
    ]) {
      if (bad === null) continue;
      assertInvalidInput(() => evaluateSparkDecay(card, { now: bad }), 'now');
    }
    // Date 对象也不猜
    assertInvalidInput(() => evaluateSparkDecay(card, { now: new Date() }), 'now');
  });

  it('卡：九个必需自有字段逐一缺失拒绝；继承字段不作输入', () => {
    for (const field of ['id', 'scopeId', 'revision', 'state', 'vitality', 'createdAt', 'lastUsedAt', 'useCount', 'supersedes']) {
      const card = spark();
      delete card[field];
      assertInvalidInput(() => evaluateSparkDecay(card, { now: NOW }), field);
    }
    // 原型链上带全部必需字段的对象：无自有键 → 缺必需字段
    const inherited = Object.create(spark());
    assertInvalidInput(() => evaluateSparkDecay(inherited, { now: NOW }), '必需自有字段');
  });

  it('卡字段类型/枚举/格式：非法值全拒（稳定 INVALID_INPUT，非 TypeError）', () => {
    const bad = (overrides) => () => evaluateSparkDecay(spark(overrides), { now: NOW });
    assertInvalidInput(bad({ id: '' }), 'id');
    assertInvalidInput(bad({ id: 'a b' }), 'id');
    assertInvalidInput(bad({ id: '.abc' }), 'id');
    assertInvalidInput(bad({ id: '__proto__' }), 'id'); // 保留名/字符集任一先命中，稳定 INVALID_INPUT
    assertInvalidInput(bad({ id: 'CON' }), '保留设备名');
    assertInvalidInput(bad({ scopeId: 5 }), 'scopeId');
    assertInvalidInput(bad({ scopeId: 'Global' }), 'global');
    assertInvalidInput(bad({ scopeId: 'a/b' }), '禁用文件名字符');
    assertInvalidInput(bad({ revision: 0 }), 'revision');
    assertInvalidInput(bad({ revision: -1 }), 'revision');
    assertInvalidInput(bad({ revision: 1.5 }), 'revision');
    assertInvalidInput(bad({ revision: 2 ** 53 }), 'revision'); // 超安全整数
    assertInvalidInput(bad({ revision: '1' }), 'revision');
    assertInvalidInput(bad({ state: 'Active' }), 'state');
    assertInvalidInput(bad({ state: 'deleted' }), 'state');
    assertInvalidInput(bad({ vitality: 'Ephemeral' }), 'vitality');
    assertInvalidInput(bad({ createdAt: '2026-01-01T00:00:00Z' }), 'createdAt');
    assertInvalidInput(bad({ createdAt: 1767225600000 }), 'createdAt');
    assertInvalidInput(bad({ lastUsedAt: 'yesterday' }), 'lastUsedAt');
    assertInvalidInput(bad({ lastUsedAt: 5 }), 'lastUsedAt');
    assertInvalidInput(bad({ useCount: -1 }), 'useCount');
    assertInvalidInput(bad({ useCount: 1.5 }), 'useCount');
    assertInvalidInput(bad({ useCount: '0' }), 'useCount');
    assertInvalidInput(bad({ useCount: 2 ** 53 }), 'useCount'); // 超安全整数
    assertInvalidInput(bad({ supersedes: 'bad id!' }), 'supersedes');
    // 合法上限：安全整数 useCount / 64 长 id 通过
    assert.equal(
      evaluateSparkDecay(spark({ useCount: Number.MAX_SAFE_INTEGER, id: 'a'.repeat(64) }), { now: NOW }).id,
      'a'.repeat(64),
    );
  });

  it('卡含非协议 JSON（孤立代理码元/NaN/循环引用）拒绝', () => {
    const lone = spark();
    lone.title = 'bad \uD800 surrogate';
    assertInvalidInput(() => evaluateSparkDecay(lone, { now: NOW }), '代理码元');
    const nan = spark();
    nan.hitCount = Number.NaN;
    assertInvalidInput(() => evaluateSparkDecay(nan, { now: NOW }), '有限数值');
    const cyclic = spark();
    cyclic.links = [{ target: 'x', rel: 'r', self: cyclic }];
    assertInvalidInput(() => evaluateSparkDecay(cyclic, { now: NOW }), '循环引用'); // 协议检查先于字段白名单
  });

  it('null/undefined/数字当卡：稳定 INVALID_INPUT，绝不泄漏原生 TypeError', () => {
    for (const bad of [null, undefined, 42, 'card', [], () => {}]) {
      assertInvalidInput(() => evaluateSparkDecay(bad, { now: NOW }), '普通对象');
    }
  });

  it('不修改输入：deep-freeze 卡与 opts 下计算成功，且 JSON 快照前后一致', () => {
    const card = deepFreeze(fullCard({ id: 'frozen-1', createdAt: T0, lastUsedAt: at(10), useCount: 2 }));
    const opts = deepFreeze({ now: at(300), policy: { archiveScore: 0.4 } });
    const before = JSON.stringify({ card, opts });
    const r = evaluateSparkDecay(card, opts);
    assert.equal(r.reason, 'eligible'); // elapsed=290、halfLife=120 → 2**(-290/120)≈0.188 < 0.4
    assert.equal(JSON.stringify({ card, opts }), before);
  });

  it('确定性：同输入两次评估结果 deepEqual', () => {
    const card = spark({ createdAt: T0, useCount: 1 });
    assert.deepEqual(
      evaluateSparkDecay(card, { now: at(120) }),
      evaluateSparkDecay(card, { now: at(120) }),
    );
  });
});

// —— analyzeForgetting ——

describe('analyzeForgetting · 形状、排序与合并', () => {
  function analysisCards() {
    return [
      spark({ id: 'c-young', createdAt: at(250), lastUsedAt: at(280) }),   // elapsed 20 → too-recent
      spark({ id: 'a-old', createdAt: T0 }),                               // elapsed 300 → eligible
      spark({ id: 'b-mid', createdAt: at(100), useCount: 1 }),             // elapsed 200, halfLife 60 → 2**(-10/3)≈0.099 → eligible
      spark({ id: 'd-ever', createdAt: T0, vitality: 'evergreen' }),       // evergreen
      spark({ id: 'e-dead', createdAt: T0, state: 'archived' }),           // inactive
      spark({ id: 'f-prot', createdAt: T0, supersedes: 'z-1' }),           // replacement-protected
    ];
  }

  it('返回恰好九键，version/kind/policy/now 回显正确', () => {
    const r = analyzeForgetting({ scopeId: 'alpha', sparks: analysisCards(), now: NOW });
    assert.deepEqual(keysOf(r), [
      'alarms', 'assessments', 'candidates', 'kind', 'now', 'plan', 'policy', 'scopeId', 'version',
    ]);
    assert.equal(r.version, 1);
    assert.equal(r.kind, 'forget-analysis');
    assert.equal(r.scopeId, 'alpha');
    assert.equal(r.now, NOW);
    assert.deepEqual(r.policy, { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });
  });

  it('assessments 覆盖全体卡并按 id 升序；candidates 按 elapsedDays 降序再 id 升序', () => {
    const r = analyzeForgetting({ scopeId: 'alpha', sparks: analysisCards(), now: NOW });
    assert.equal(r.assessments.length, 6);
    assert.deepEqual(r.assessments.map((a) => a.id), [...r.assessments].sort(byId).map((a) => a.id));
    assert.deepEqual(r.candidates.map((c) => c.id), ['a-old', 'b-mid']); // 300 > 200
  });

  it('elapsedDays 并列时按 id 升序破平', () => {
    const sparks = [
      spark({ id: 'zz', createdAt: T0 }),
      spark({ id: 'aa', createdAt: T0 }),
      spark({ id: 'mm', createdAt: T0 }),
    ];
    const r = analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW, limit: 2 });
    assert.deepEqual(r.candidates.map((c) => c.id), ['aa', 'mm']); // 同 300 天，id 升序取前 2
  });

  it('alarms 按卡 id 合并升序', () => {
    const rollbackNow = '2025-06-01T00:00:00.000Z';
    const sparks = [
      spark({ id: 'b-rollback', createdAt: T0 }),
      spark({ id: 'a-rollback', createdAt: T0 }),
      spark({ id: 'c-fine', createdAt: '2025-01-01T00:00:00.000Z' }),
    ];
    const r = analyzeForgetting({ scopeId: 'alpha', sparks, now: rollbackNow });
    assert.deepEqual(r.alarms.map((x) => x.id), ['a-rollback', 'b-rollback']);
    assert.equal(r.alarms[0].code, 'CLOCK_ROLLBACK');
    assert.equal(r.alarms[0].anchorAt, T0);
    assert.equal(r.alarms[0].now, rollbackNow);
  });

  it('policy 部分覆盖被补全回显（完整三字段）', () => {
    const r = analyzeForgetting({ scopeId: 'alpha', sparks: [], now: NOW, policy: { archiveScore: 0.5 } });
    assert.deepEqual(r.policy, { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.5 });
    assert.equal(r.plan, null);
  });

  it('空 sparks：assessments/candidates/alarms 全空、plan=null', () => {
    const r = analyzeForgetting({ scopeId: 'global', sparks: [], now: NOW });
    assert.deepEqual(r.assessments, []);
    assert.deepEqual(r.candidates, []);
    assert.deepEqual(r.alarms, []);
    assert.equal(r.plan, null);
  });
});

describe('analyzeForgetting · Source 与 Plan（§3）', () => {
  it('candidates 为 §3 Source：恰好五键，绑定 live 同名字段', () => {
    const sparks = [
      spark({ id: 's-2', createdAt: T0, lastUsedAt: at(5), useCount: 1, revision: 7 }), // halfLife=60 → 2**(-295/60)≈0.033
      spark({ id: 's-1', createdAt: at(10), lastUsedAt: null, useCount: 0, revision: 2 }),
    ];
    const r = analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW });
    assert.equal(r.candidates.length, 2);
    for (const c of r.candidates) {
      assert.deepEqual(keysOf(c), ['createdAt', 'id', 'lastUsedAt', 'revision', 'useCount']);
    }
    const byIdMap = new Map(r.candidates.map((c) => [c.id, c]));
    assert.deepEqual(byIdMap.get('s-2'), { id: 's-2', revision: 7, createdAt: T0, lastUsedAt: at(5), useCount: 1 });
    assert.deepEqual(byIdMap.get('s-1'), { id: 's-1', revision: 2, createdAt: at(10), lastUsedAt: null, useCount: 0 });
  });

  it('plan：恰好 {version,kind,scopeId,now,policy,sources}，sources 与 candidates 独立 clone 且改按 id 排序', () => {
    const sparks = [
      spark({ id: 'younger', createdAt: at(50) }),  // elapsed 250
      spark({ id: 'aaa', createdAt: T0 }),          // elapsed 300 → 年龄第一
    ];
    const r = analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW });
    assert.equal(r.candidates.map((c) => c.id).join(','), 'aaa,younger'); // 年龄优先
    assert.deepEqual(keysOf(r.plan), ['kind', 'now', 'policy', 'scopeId', 'sources', 'version']);
    assert.equal(r.plan.version, 1);
    assert.equal(r.plan.kind, 'archive-ephemeral');
    assert.equal(r.plan.scopeId, 'alpha');
    assert.equal(r.plan.now, NOW);
    assert.deepEqual(r.plan.policy, r.policy);
    assert.notEqual(r.plan.policy, r.policy); // 独立对象
    assert.equal(r.plan.sources.map((s) => s.id).join(','), 'aaa,younger'); // id 排序
    // 独立 clone：修改 plan.sources 不影响 candidates，且对象互不共享
    for (const s of r.plan.sources) {
      assert.equal(r.candidates.includes(s), false);
    }
    r.plan.sources[0].revision = 999;
    assert.equal(r.candidates.find((c) => c.id === 'aaa').revision, 1);
  });

  it('plan 在无候选时为 null', () => {
    const r = analyzeForgetting({ scopeId: 'alpha', sparks: [spark({ vitality: 'evergreen' })], now: NOW });
    assert.equal(r.plan, null);
  });
});

describe('analyzeForgetting · limit 与候选上限', () => {
  /** n 张 eligible 卡：id 内嵌 elapsed（e-061..e-<60+n>），createdAt = now - elapsed。 */
  function eligibleDeck(n) {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      const elapsed = 61 + i;
      out.push(spark({ id: `e-${String(elapsed).padStart(3, '0')}`, createdAt: at(300 - elapsed) }));
    }
    return out;
  }

  it('默认 limit=20：21 张 eligible 只取 elapsedDays 最大的 20 张（丢弃最年轻）', () => {
    const r = analyzeForgetting({ scopeId: 'alpha', sparks: eligibleDeck(21), now: NOW });
    assert.equal(r.candidates.length, 20);
    // e-061..e-081：最年轻 e-061（elapsed=61）被截掉
    assert.ok(r.candidates.every((c) => c.id !== 'e-061'));
    let prev = Infinity;
    for (const c of r.candidates) {
      const elapsed = Number(c.id.slice(2));
      assert.ok(elapsed <= prev, '候选应按 elapsedDays 降序');
      prev = elapsed;
    }
    assert.equal(r.plan.sources.length, 20);
  });

  it('limit=1 取最老；limit=20 合法；plan.sources 与 candidates 同集', () => {
    const sparks = eligibleDeck(25);
    const r1 = analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW, limit: 1 });
    assert.deepEqual(r1.candidates.map((c) => c.id), ['e-085']); // e-061..e-085 中最老
    const r20 = analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW, limit: 20 });
    assert.equal(r20.candidates.length, 20);
    assert.deepEqual(
      r20.plan.sources.map((s) => s.id),
      [...r20.candidates].sort(byId).map((c) => c.id),
    );
  });

  it('limit 0/21/1.5/"20"/NaN 全拒；显式 undefined limit 视为未提供（默认 20）', () => {
    const sparks = eligibleDeck(5);
    const base = { scopeId: 'alpha', sparks, now: NOW };
    assertInvalidInput(() => analyzeForgetting({ ...base, limit: 0 }), 'limit');
    assertInvalidInput(() => analyzeForgetting({ ...base, limit: 21 }), 'limit');
    assertInvalidInput(() => analyzeForgetting({ ...base, limit: 2.5 }), 'limit');
    assertInvalidInput(() => analyzeForgetting({ ...base, limit: '20' }), 'limit');
    assertInvalidInput(() => analyzeForgetting({ ...base, limit: Number.NaN }), 'limit');
    const r = analyzeForgetting({ ...base, limit: undefined });
    assert.equal(r.candidates.length, 5);
  });

  it('非法 limit 的错误构造不泄漏原生 TypeError（M-a1 返工项）：坏 toString 对象/null 原型/Symbol 稳定 INVALID_INPUT', () => {
    const base = { scopeId: 'alpha', sparks: [], now: NOW };
    // 普通 JSON 对象、toString 非函数：${limit} 插值曾触发原生 TypeError
    const badToString = { toString: 'not-callable' };
    assertInvalidInput(() => analyzeForgetting({ ...base, limit: badToString }), 'limit');
    // null 原型对象：同样曾触发 Cannot convert object to primitive value
    const nullProto = Object.create(null);
    nullProto.toString = 'not-callable';
    assertInvalidInput(() => analyzeForgetting({ ...base, limit: nullProto }), 'limit');
    // Symbol：曾触发 Cannot convert a Symbol value to a string
    assertInvalidInput(() => analyzeForgetting({ ...base, limit: Symbol('bad-limit') }), 'limit');
    // 正常非法数字保持既有文案与行为
    assertInvalidInput(() => analyzeForgetting({ ...base, limit: 21 }), '1..20');
    // 错误 details 也只含安全描述（字符串），可整体 JSON 序列化
    try {
      analyzeForgetting({ ...base, limit: badToString });
      assert.fail('应当抛出');
    } catch (err) {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.equal(err.details.limit, 'object');
      JSON.stringify(err); // 不得因 details 残留不可信原始值而抛错
    }
  });

  it('policy 字段遇 Symbol 同样稳定 INVALID_INPUT（String(number) 路径不受影响）', () => {
    for (const field of ['baseHalfLifeDays', 'maxHalfLifeDays', 'archiveScore']) {
      assertInvalidInput(() => normalizeForgetPolicy({ [field]: Symbol('bad') }), field);
    }
    // 数值路径不受描述格式化影响：String(NaN)='NaN' 文案安全
    assertInvalidInput(() => normalizeForgetPolicy({ baseHalfLifeDays: Number.NaN }), 'baseHalfLifeDays');
  });
});

describe('analyzeForgetting · 规模、scope 与坏记录', () => {
  it('10000 张卡合法；10001 张拒绝', () => {
    const deck = (n) => Array.from({ length: n }, (_, i) =>
      spark({ id: `bulk-${String(i).padStart(5, '0')}`, createdAt: at(299) }));
    const r = analyzeForgetting({ scopeId: 'alpha', sparks: deck(10000), now: NOW });
    assert.equal(r.assessments.length, 10000);
    assert.deepEqual(r.candidates, []); // 全部 1 天 → too-recent，plan=null
    assert.equal(r.plan, null);
    assertInvalidInput(() => analyzeForgetting({ scopeId: 'alpha', sparks: deck(10001), now: NOW }), '10000');
  });

  it('跨 scope 记录整次拒绝', () => {
    const sparks = [spark({ id: 'ok-1' }), spark({ id: 'bad-1', scopeId: 'beta' })];
    assertInvalidInput(
      () => analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW }),
      '跨 scope',
    );
  });

  it('重复 id 拒绝', () => {
    const sparks = [spark({ id: 'dup' }), spark({ id: 'dup', createdAt: at(10) })];
    assertInvalidInput(() => analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW }), '重复 id');
  });

  it('坏记录整次报错（不静默跳过）：第二张缺 useCount 即全量失败', () => {
    const bad = spark({ id: 'bad-2' });
    delete bad.useCount;
    const sparks = [spark({ id: 'good-1' }), bad];
    assertInvalidInput(() => analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW }), 'useCount');
  });

  it('未知选项/缺必需参数/类型不符全拒', () => {
    const sparks = [spark()];
    assertInvalidInput(() => analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW, foo: 1 }), '未知选项');
    assertInvalidInput(() => analyzeForgetting({ sparks, now: NOW }), 'scopeId 必须显式提供');
    assertInvalidInput(() => analyzeForgetting({ scopeId: 7, sparks, now: NOW }), 'scopeId');
    assertInvalidInput(() => analyzeForgetting({ scopeId: 'alpha', now: NOW }), 'sparks 必须显式提供');
    assertInvalidInput(() => analyzeForgetting({ scopeId: 'alpha', sparks: {}, now: NOW }), 'sparks');
    assertInvalidInput(() => analyzeForgetting({ scopeId: 'alpha', sparks }), 'now 必须显式注入');
    assertInvalidInput(() => analyzeForgetting({ scopeId: 'alpha', sparks, now: NOW, policy: undefined }), 'undefined');
    assertInvalidInput(() => analyzeForgetting(), 'scopeId 必须显式提供');
    assertInvalidInput(() => analyzeForgetting(null), '普通对象');
  });

  it('不修改输入：deep-freeze params 全程只读，JSON 快照前后一致', () => {
    const params = deepFreeze({
      scopeId: 'alpha',
      sparks: [
        deepFreeze(fullCard({ id: 'fr-1', createdAt: T0, lastUsedAt: at(20), useCount: 1 })),
        deepFreeze(fullCard({ id: 'fr-2', createdAt: T0, vitality: 'evergreen', hitCount: 3, lastHitAt: at(299) })),
      ],
      now: NOW,
      policy: deepFreeze({ archiveScore: 0.3 }),
      limit: 5,
    });
    const before = JSON.stringify(params);
    const r = analyzeForgetting(params);
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].id, 'fr-1');
    assert.equal(JSON.stringify(params), before);
  });

  it('确定性：同输入两次分析 deepEqual（含 plan）', () => {
    const params = { scopeId: 'alpha', sparks: analysisDeterministic(), now: NOW, limit: 3 };
    function analysisDeterministic() {
      return [
        spark({ id: 'd-1', createdAt: T0 }),
        spark({ id: 'd-2', createdAt: at(80), useCount: 2 }),
        spark({ id: 'd-3', createdAt: at(10), state: 'archived' }),
      ];
    }
    assert.deepEqual(analyzeForgetting(params), analyzeForgetting(params));
  });
});
