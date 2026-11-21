// Shiori 0.5 批次 3 · test/forgetting/topic-temperature.test.mjs
// A 线阶段 B 温度纯函数模块的黄金样例与边界测试（0.5-DEV-PLAN §4 / §5 / §6.3）。
// 自查口：node --test test/forgetting/topic-temperature.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  evaluateTopics,
  tierForTemperature,
  TEMPERATURE_DEFAULTS,
  S_MIN_DAYS,
  MIN_AGE_DAYS,
} from '../../src/forgetting/topic-temperature.mjs';

const DAY = 86400000;
const HOUR = 3600000;
const NOW_MS = Date.parse('2026-11-21T12:00:00.000Z');
const NOW_ISO = new Date(NOW_MS).toISOString();
const SCOPE = 'amber';

function iso(ms) {
  return new Date(ms).toISOString();
}

function close(actual, expected, label, epsilon) {
  const eps = epsilon === undefined ? 1e-9 : epsilon;
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= eps,
    label + ': 期望 ' + expected + ' ± ' + eps + '，实际 ' + actual,
  );
}

function topic(key, overrides) {
  return { key, scopeId: SCOPE, ...(overrides || {}) };
}

function event(atMs, kind, topicKey, extra) {
  return { at: iso(atMs), scopeId: SCOPE, kind, topicKey, ...(extra || {}) };
}

// 令 S0 = 60/log2(100/15) 时，updated 恰在 60 天前 → 基线 T 恰为 15，
// 冷读一次后 15 + 0.35*(100-15) = 44.75（黄金样例 ①）。
const S0_FIFTEEN = 60 / Math.log2(100 / 15);

function goldenReadInput() {
  return {
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [event(NOW_MS, 'read', 'a')],
    now: NOW_MS,
    params: { S0: S0_FIFTEEN },
  };
}

// ---------------------------------------------------------------------------
// 黄金样例
// ---------------------------------------------------------------------------

test('① 冷读加热：T=15 读一次 → 44.75，S 按间隔巩固', () => {
  const result = evaluateTopics(goldenReadInput());
  const entry = result.topics[0];
  close(entry.T, 44.75, 'T');
  close(entry.S, S0_FIFTEEN * (1 + 0.5 * (1 - 15 / 100)), 'S');
  assert.equal(entry.tier, 'cool');
  assert.equal(entry.lastHeatedAt, NOW_ISO);
  assert.equal(result.alarms.length, 0);
});

test('② 冷却窗口内（1h < 默认 24h）两次 read 只计一次加热', () => {
  const result = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [event(NOW_MS - HOUR, 'read', 'a'), event(NOW_MS, 'read', 'a')],
    now: NOW_MS,
    params: { S0: S0_FIFTEEN },
  });
  const entry = result.topics[0];
  assert.ok(entry.T > 44.6 && entry.T < 44.8, '窗口内重复读不应再次加热，实际 T=' + entry.T);
  assert.equal(entry.lastHeatedAt, iso(NOW_MS - HOUR));
  assert.ok(entry.reason.includes('窗口内跳过 1 次读取'), entry.reason);
});

test('③ 窗口外第二次 read → 跨过 restoreT（≈63.8，理想无衰减上限 64.09）', () => {
  // 本用例以 12h 窗口为前提，显式固化；默认值已迁至 src/forgetting/params.mjs（0.5 批次 4 · A 线：readDedupHours 默认 24，评审答复 q-3863f18493504ddc 拍板显式固化，三条断言零改动）。
  const params = { S0: S0_FIFTEEN, heatWindowHours: 12 };
  const result = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [event(NOW_MS - 12 * HOUR, 'read', 'a'), event(NOW_MS, 'read', 'a')],
    now: NOW_MS,
    params,
  });
  // 独立复算同一条闭式路径：基线 → 第一次读 → 0.5 天衰减 → 巩固 → 第二次读。
  const smax = params.Smax === undefined ? TEMPERATURE_DEFAULTS.Smax : params.Smax;
  let t = 100 * 2 ** (-(60 - 0.5) / S0_FIFTEEN);
  let s = Math.max(S0_FIFTEEN, Math.min(smax, S0_FIFTEEN * (1 + 0.5 * (1 - t / 100))));
  t = t + 0.35 * (100 - t);
  t = t * 2 ** (-0.5 / s);
  s = Math.max(S0_FIFTEEN, Math.min(smax, s * (1 + 0.5 * (1 - t / 100))));
  t = t + 0.35 * (100 - t);
  const entry = result.topics[0];
  close(entry.T, t, 'T');
  assert.ok(entry.T > 63.5 && entry.T < 64.1, '实际 T=' + entry.T);
  assert.ok(entry.T >= TEMPERATURE_DEFAULTS.restoreT, '应跨过 restoreT');
  assert.ok(!entry.reason.includes('跳过'), entry.reason);
});

test('④ updated 从 T=20 顶到 85，S 按间隔巩固且不低于 S0', () => {
  const s0 = 60 / Math.log2(100 / 20);
  const result = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [event(NOW_MS, 'updated', 'a')],
    now: NOW_MS,
    params: { S0: s0 },
  });
  const entry = result.topics[0];
  close(entry.T, 85, 'T');
  close(entry.S, s0 * (1 + 0.5 * (1 - 20 / 100)), 'S');
  assert.equal(entry.tier, 'active');
});

test('⑤ 存量种子：60 天 → 25，90 天 → 12.5，缺 updated 回落 50', () => {
  const result = evaluateTopics({
    topics: [
      topic('a', { updated: iso(NOW_MS - 60 * DAY) }),
      topic('b', { updated: iso(NOW_MS - 90 * DAY) }),
      topic('c'),
    ],
    now: NOW_MS,
  });
  const [a, b, c] = result.topics;
  assert.equal(a.T, 25);
  assert.equal(b.T, 12.5);
  assert.equal(c.T, 50);
  assert.equal(a.reason, '存量种子：最后更新于 60 天前，种子 T=25');
  assert.ok(b.reason.includes('存量种子'));
  assert.ok(c.reason.includes('存量种子'));
  assert.ok(c.reason.includes('seedFallbackT=50'));
  assert.equal(a.tier, 'cool');
  assert.equal(b.tier, 'cold');
  assert.equal(a.lastHeatedAt, null);
});

test('⑥ 时钟回拨：CLOCK_ROLLBACK 告警且 canCool 全 false', () => {
  const result = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 90 * DAY), retention: 'historical' })],
    events: [event(NOW_MS + HOUR, 'read', 'a')],
    now: NOW_MS,
  });
  assert.deepEqual(result.alarms, [{ code: 'CLOCK_ROLLBACK' }]);
  assert.equal(result.topics[0].canCool, false);
  assert.deepEqual(result.topics[0].alarms, [{ code: 'CLOCK_ROLLBACK' }]);
  assert.ok(Number.isFinite(result.topics[0].T), '整体温度仍计算');
});

test('⑦ 坏事件行只记 BAD_EVENT，不抛出也不带坏后续行', () => {
  const result = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [
      { at: 'not-a-date', scopeId: SCOPE, kind: 'read', topicKey: 'a' },
      event(NOW_MS, 'read', 'a'),
    ],
    now: NOW_MS,
  });
  assert.deepEqual(result.alarms, [{ code: 'BAD_EVENT', at: 'not-a-date' }]);
  close(result.topics[0].T, 51.25, 'T');
});

// ---------------------------------------------------------------------------
// 组温度
// ---------------------------------------------------------------------------

test('⑧ 组温度取活跃成员最大值；standing/pinned 保护；空组按 group_list 锚点衰减', () => {
  const result = evaluateTopics({
    topics: [
      topic('cold1', { updated: iso(NOW_MS - 100 * DAY), retention: 'historical', group: ['g-cold'] }),
      topic('cold2', { updated: iso(NOW_MS - 100 * DAY), retention: 'historical', group: ['g-cold'] }),
      topic('warm', { updated: iso(NOW_MS - 60 * DAY), retention: 'historical', group: ['g-max'] }),
      topic('stand', { updated: iso(NOW_MS - 10 * DAY), retention: 'standing', group: ['g-stand'] }),
      topic('pin', { updated: iso(NOW_MS - 90 * DAY), retention: 'historical', pinned: true, group: ['g-pin'] }),
      topic('inherit', { updated: iso(NOW_MS - 100 * DAY), group: ['g-cold'] }),
    ],
    groups: [
      { key: 'g-cold', retention: 'historical' },
      { key: 'g-max', retention: 'historical' },
      { key: 'g-stand', retention: 'historical' },
      { key: 'g-pin', retention: 'historical' },
      { key: 'g-empty', retention: 'historical' },
    ],
    events: [
      { at: iso(NOW_MS - 90 * DAY), scopeId: SCOPE, kind: 'group_list', groupKey: 'g-empty' },
    ],
    now: NOW_MS,
  });
  const byKey = new Map(result.groups.map((g) => [g.key, g]));
  close(byKey.get('g-cold').T, 100 * 2 ** (-100 / 30), 'g-cold T');
  assert.equal(byKey.get('g-cold').tier, 'frozen');
  assert.equal(byKey.get('g-cold').canCool, true);
  assert.equal(byKey.get('g-max').T, 25);
  assert.equal(byKey.get('g-max').canCool, false, 'T 未低于 cooldownT');
  close(byKey.get('g-stand').T, 100 * 2 ** (-10 / 30), 'g-stand T');
  assert.equal(byKey.get('g-stand').canCool, false, 'standing 活跃成员保护');
  assert.equal(byKey.get('g-pin').canCool, false, 'pinned 活跃成员保护');
  close(byKey.get('g-empty').T, 12.5, 'g-empty T');
  assert.equal(byKey.get('g-empty').canCool, true);
  assert.ok(byKey.get('g-empty').reason.includes('空组'), byKey.get('g-empty').reason);
  // 组策略被成员继承（产出 effective retention）
  const inherit = result.topics.find((t) => t.key === 'inherit');
  assert.equal(inherit.retention, 'historical');
});

test('空组无 group_list 锚点：T=null 且标 reason，canCool=false', () => {
  const result = evaluateTopics({
    topics: [],
    groups: [{ key: 'g-empty', retention: 'historical' }],
    now: NOW_MS,
  });
  const group = result.groups[0];
  assert.equal(group.T, null);
  assert.equal(group.tier, null);
  assert.equal(group.canCool, false);
  assert.ok(group.reason.includes('无目录访问记录'), group.reason);
});

// ---------------------------------------------------------------------------
// 回放顺序与纯函数
// ---------------------------------------------------------------------------

test('⑨ 乱序事件按 at 排序后结果一致（at 相同按输入稳定）', () => {
  const base = {
    topics: [topic('a', { updated: iso(NOW_MS - 120 * DAY) })],
    now: NOW_MS,
    params: { S0: S0_FIFTEEN },
  };
  const events = [
    event(NOW_MS - 60 * DAY, 'updated', 'a'),
    event(NOW_MS - 30 * DAY, 'read', 'a'),
    event(NOW_MS, 'read', 'a'),
  ];
  const forward = evaluateTopics({ ...base, events });
  const backward = evaluateTopics({ ...base, events: [...events].reverse() });
  assert.deepEqual(forward.topics[0].T, backward.topics[0].T);
  assert.deepEqual(forward.topics[0].S, backward.topics[0].S);
  assert.deepEqual(forward, backward);
});

test('同一输入两次调用深度相等，且不修改输入（深冻结通过）', () => {
  const deepFreeze = (value) => {
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) deepFreeze(value[key]);
      Object.freeze(value);
    }
    return value;
  };
  const frozen = deepFreeze({
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY), group: ['g1'] })],
    groups: [{ key: 'g1', retention: 'historical' }],
    events: [event(NOW_MS - DAY, 'read', 'a')],
    now: NOW_MS,
    params: { heatWindowHours: 6 },
  });
  const before = JSON.stringify(frozen);
  const first = evaluateTopics(frozen);
  const second = evaluateTopics(frozen);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(frozen), before);
});

test('模块源码不含 I/O / 时钟 / 环境变量依赖（R12）', () => {
  const source = readFileSync(new URL('../../src/forgetting/topic-temperature.mjs', import.meta.url), 'utf8');
  assert.ok(!/Date\.now\s*\(/.test(source), '不得调用 Date.now');
  assert.ok(!/process\.env/.test(source), '不得读 process.env');
  assert.ok(!/from\s+['"]node:(fs|path)['"]/.test(source), '不得 import node:fs / node:path');
  assert.ok(!/from\s+['"]node:/.test(source), '不得 import 任何 node: 内建');
});

// ---------------------------------------------------------------------------
// 其余规则
// ---------------------------------------------------------------------------

test('search_hit / group_list / 未知 kind 不加热；未知 topicKey 忽略', () => {
  const result = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 90 * DAY) })],
    events: [
      event(NOW_MS - HOUR, 'search_hit', 'a'),
      event(NOW_MS - 2 * HOUR, 'search_hit', 'a'),
      { at: iso(NOW_MS - HOUR), scopeId: SCOPE, kind: 'group_list', groupKey: 'g1' },
      event(NOW_MS - HOUR, 'manual_restored', 'a'),
      event(NOW_MS - HOUR, 'read', 'zzz-not-a-topic'),
    ],
    now: NOW_MS,
  });
  const entry = result.topics[0];
  assert.equal(entry.T, 12.5);
  assert.equal(entry.S, 30);
  assert.equal(entry.searchHits, 2);
  assert.equal(result.alarms.length, 0);
});

test('scope 隔离：同一 key 的阅读只加热同 scope 那一份', () => {
  const result = evaluateTopics({
    topics: [
      { key: 'a', scopeId: 'amber', updated: iso(NOW_MS - 90 * DAY) },
      { key: 'a', scopeId: 'global', updated: iso(NOW_MS - 60 * DAY) },
    ],
    events: [{ at: iso(NOW_MS), scopeId: 'amber', kind: 'read', topicKey: 'a' }],
    now: NOW_MS,
  });
  const amber = result.topics.find((t) => t.scopeId === 'amber');
  const global = result.topics.find((t) => t.scopeId === 'global');
  close(amber.T, 12.5 + 0.35 * (100 - 12.5), 'amber T');
  assert.equal(global.T, 25);
});

test('canCool：historical + 冷 + 年龄达标才为真；7 天最小保护期生效', () => {
  const params = { S0: 30 };
  const createdAt = NOW_MS - 100 * DAY;
  const result = evaluateTopics({
    topics: [
      // 年龄 5 天（updated 新）但 T 已被 created 事件自然冷却到 9.92 → 保护期拦截
      topic('young', { updated: iso(NOW_MS - 5 * DAY), retention: 'historical' }),
      // 同温度但年龄 20 天 → 可冷却
      topic('aged', { updated: iso(NOW_MS - 20 * DAY), retention: 'historical' }),
      // 常驻档 → 不可冷却
      topic('standing', { updated: iso(NOW_MS - 20 * DAY), retention: 'standing' }),
    ],
    events: ['young', 'aged', 'standing'].map((key) => ({
      at: iso(createdAt),
      scopeId: SCOPE,
      kind: 'created',
      topicKey: key,
    })),
    now: NOW_MS,
    params,
  });
  const byKey = new Map(result.topics.map((t) => [t.key, t]));
  close(byKey.get('young').T, 100 * 2 ** (-100 / 30), 'young T');
  assert.equal(byKey.get('young').canCool, false, '年龄不足 ' + MIN_AGE_DAYS + ' 天');
  assert.equal(byKey.get('aged').canCool, true);
  assert.equal(byKey.get('standing').canCool, false);
});

test('canRestore：仅 auto-inactive 且 T>=restoreT；manual 归档永不自动恢复', () => {
  const result = evaluateTopics({
    topics: [
      topic('auto-hot', {
        updated: iso(NOW_MS - 10 * DAY),
        archivedAt: iso(NOW_MS - 5 * DAY),
        archiveOrigin: 'auto-inactive',
      }),
      topic('auto-cold', {
        updated: iso(NOW_MS - 90 * DAY),
        archivedAt: iso(NOW_MS - 5 * DAY),
        archiveOrigin: 'auto-inactive',
      }),
      topic('manual-hot', {
        updated: iso(NOW_MS - 10 * DAY),
        archivedAt: iso(NOW_MS - 5 * DAY),
        archiveOrigin: 'manual',
      }),
    ],
    now: NOW_MS,
  });
  const byKey = new Map(result.topics.map((t) => [t.key, t]));
  assert.ok(byKey.get('auto-hot').T >= TEMPERATURE_DEFAULTS.restoreT);
  assert.equal(byKey.get('auto-hot').canRestore, true);
  assert.equal(byKey.get('auto-cold').canRestore, false);
  assert.equal(byKey.get('manual-hot').canRestore, false);
  assert.equal(byKey.get('auto-hot').canCool, false, '已归档不再冷却');
});

test('tier 边界：50/25/10 与冻结常量', () => {
  assert.equal(S_MIN_DAYS, 1);
  assert.equal(MIN_AGE_DAYS, 7);
  assert.equal(tierForTemperature(50), 'active');
  assert.equal(tierForTemperature(49.999), 'cool');
  assert.equal(tierForTemperature(25), 'cool');
  assert.equal(tierForTemperature(24.999), 'cold');
  assert.equal(tierForTemperature(10), 'cold');
  assert.equal(tierForTemperature(9.999), 'frozen');
  assert.throws(() => tierForTemperature(Number.NaN), (error) => error.code === 'INVALID_INPUT');
});

test('事件 at 也接受毫秒数，与 ISO 结果一致', () => {
  const isoResult = evaluateTopics(goldenReadInput());
  const msResult = evaluateTopics({
    ...goldenReadInput(),
    events: [{ at: NOW_MS, scopeId: SCOPE, kind: 'read', topicKey: 'a' }],
  });
  assert.deepEqual(isoResult, msResult);
});

// ---------------------------------------------------------------------------
// 打回项 R1 / R2 / R3
// ---------------------------------------------------------------------------

test('R1 事件严格按 (scope,key) 配对：跨 scope / 仅 key 撞名一律不加热', () => {
  // 两个 scope 同 key，事件 scope 不匹配任何一份 → 两份都保持种子温度
  const mismatch = evaluateTopics({
    topics: [
      topic('a', { scopeId: 'amber', updated: iso(NOW_MS - 90 * DAY) }),
      topic('a', { scopeId: 'global', updated: iso(NOW_MS - 60 * DAY) }),
    ],
    events: [event(NOW_MS, 'read', 'a', { scopeId: 'other' })],
    now: NOW_MS,
  });
  assert.equal(mismatch.topics[0].T, 12.5);
  assert.equal(mismatch.topics[1].T, 25);
  // 事件 scope 只命中其中一份 → 另一份不变（严格命中，不做 byKey[0] 兜底）
  const partial = evaluateTopics({
    topics: [
      topic('a', { scopeId: 'amber', updated: iso(NOW_MS - 90 * DAY) }),
      topic('a', { scopeId: 'global', updated: iso(NOW_MS - 60 * DAY) }),
    ],
    events: [event(NOW_MS, 'read', 'a', { scopeId: 'amber' })],
    now: NOW_MS,
  });
  close(partial.topics[0].T, 12.5 + 0.35 * (100 - 12.5), 'amber T');
  assert.equal(partial.topics[1].T, 25);
  // 无 scope 的专题不被带 scope 的事件按 key 兜底加热
  const unscoped = evaluateTopics({
    topics: [{ key: 'a', updated: iso(NOW_MS - 90 * DAY) }],
    events: [event(NOW_MS, 'read', 'a')],
    now: NOW_MS,
  });
  assert.equal(unscoped.topics[0].T, 12.5);
});

test('R1 同一 (scope,key) 重复 topic → INVALID_INPUT，不静默覆盖', () => {
  const cases = [
    [{ key: 'a', scopeId: SCOPE, updated: iso(NOW_MS - DAY) }, { key: 'a', scopeId: SCOPE, updated: iso(NOW_MS - 2 * DAY) }],
    [{ key: 'a' }, { key: 'a' }],
    [{ key: 'a', scopeId: SCOPE }, { key: 'a', targetScopeId: SCOPE }],
  ];
  for (const topics of cases) {
    assert.throws(
      () => evaluateTopics({ topics, now: NOW_MS }),
      (error) => error.code === 'INVALID_INPUT',
      '重复 (scope,key) 应抛 INVALID_INPUT',
    );
  }
});

test('R2 回拨守卫判别性：T<25 且年龄达标时，多一条未来事件即 canCool=false', () => {
  const base = {
    topics: [topic('cold', { updated: iso(NOW_MS - 90 * DAY), retention: 'historical' })],
    now: NOW_MS,
  };
  const clean = evaluateTopics(base);
  assert.equal(clean.topics[0].T, 12.5);
  assert.equal(clean.topics[0].canCool, true, '无未来事件时应可冷却');

  const rollback = evaluateTopics({
    ...base,
    // 未来事件打在未知 topic 上：不改变 cold 的温度，只用来触发回拨守卫
    events: [event(NOW_MS + HOUR, 'read', 'ghost')],
  });
  assert.deepEqual(rollback.alarms, [{ code: 'CLOCK_ROLLBACK' }]);
  assert.equal(rollback.topics[0].T, 12.5);
  assert.equal(rollback.topics[0].canCool, false, '回拨守卫必须把 canCool 压成 false');

  // 组级回拨守卫同样要有判别性：空组锚点 90 天 → 12.5 可冷却；加未来事件后必须转 false
  const groups = [{ key: 'g', retention: 'historical' }];
  const anchor = { at: iso(NOW_MS - 90 * DAY), scopeId: SCOPE, kind: 'group_list', groupKey: 'g' };
  const cleanGroup = evaluateTopics({ topics: [], groups, events: [anchor], now: NOW_MS });
  assert.equal(cleanGroup.groups[0].T, 12.5);
  assert.equal(cleanGroup.groups[0].canCool, true);
  const rollbackGroup = evaluateTopics({
    topics: [],
    groups,
    events: [anchor, event(NOW_MS + HOUR, 'read', 'ghost')],
    now: NOW_MS,
  });
  assert.equal(rollbackGroup.groups[0].T, 12.5);
  assert.equal(rollbackGroup.groups[0].canCool, false);
  assert.deepEqual(rollbackGroup.groups[0].alarms, [{ code: 'CLOCK_ROLLBACK' }]);
});

test('R3 有事件但缺 updated：基线回落 seedFallbackT=50（非 0）', () => {
  const result = evaluateTopics({
    topics: [topic('noup')],
    events: [event(NOW_MS, 'read', 'noup')],
    now: NOW_MS,
  });
  const entry = result.topics[0];
  close(entry.T, 67.5, 'T'); // 50 + 0.35 * (100 - 50)
  close(entry.S, 30 * 1.25, 'S');
  assert.equal(entry.lastHeatedAt, NOW_ISO);
  assert.ok(entry.reason.includes('seedFallbackT=50'), entry.reason);
});

// ---------------------------------------------------------------------------
// 入参校验
// ---------------------------------------------------------------------------

test('入参校验：缺 topics / 坏 now / 坏 updated / 坏 params / 重复组键', () => {
  const assertInvalid = (input) => assert.throws(
    () => evaluateTopics(input),
    (error) => error.code === 'INVALID_INPUT',
    '应抛 INVALID_INPUT',
  );
  assertInvalid(undefined);
  assertInvalid({ now: NOW_MS });
  assertInvalid({ topics: [], now: '2026-11-21 12:00:00' });
  assertInvalid({ topics: [{ key: 'a', updated: 'yesterday' }], now: NOW_MS });
  assertInvalid({ topics: [{ key: '' }], now: NOW_MS });
  assertInvalid({ topics: [], now: NOW_MS, params: { alpha: 2 } });
  assertInvalid({ topics: [], now: NOW_MS, params: { S0: 0 } });
  assertInvalid({
    topics: [],
    groups: [{ key: 'g1' }, { key: 'g1' }],
    now: NOW_MS,
  });
});

// ---------------------------------------------------------------------------
// 0.5 批次 4 · A 线追加用例（参数唯一源头同源；评审答复 q-3863f18493504ddc 拍板）
// 以下全部为新增，既有断言零改动（用例③仅按拍板在调用处显式固化 heatWindowHours: 12）。
// ---------------------------------------------------------------------------

const { DEFAULT_TEMPERATURE_PARAMS } = await import('../../src/forgetting/params.mjs');

test('批次 4：默认参数下 12h 间隔的第二次 read 在 24h 窗口内被去重（readDedupHours 默认 24）', () => {
  const twice = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [event(NOW_MS - 12 * HOUR, 'read', 'a'), event(NOW_MS, 'read', 'a')],
    now: NOW_MS,
  });
  const once = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [event(NOW_MS - 12 * HOUR, 'read', 'a')],
    now: NOW_MS,
  });
  const entry = twice.topics[0];
  // 第二次 read 被窗口去重：温度与只读一次完全相同（不加热、不延长窗口）
  close(entry.T, once.topics[0].T, '两次 read 与一次 read 等温');
  assert.equal(entry.lastHeatedAt, once.topics[0].lastHeatedAt);
  assert.equal(entry.lastHeatedAt, iso(NOW_MS - 12 * HOUR));
  assert.ok(entry.reason.includes('窗口内跳过 1 次读取'), entry.reason);
});

test('批次 4：间隔 >24h 的第二次 read 正常加热（窗口外，不受新默认影响）', () => {
  const twice = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [event(NOW_MS - 25 * HOUR, 'read', 'a'), event(NOW_MS, 'read', 'a')],
    now: NOW_MS,
  });
  const once = evaluateTopics({
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [event(NOW_MS - 25 * HOUR, 'read', 'a')],
    now: NOW_MS,
  });
  const entry = twice.topics[0];
  assert.ok(entry.T > once.topics[0].T, '第二次 read 应正常加热：T=' + entry.T + ' 单次=' + once.topics[0].T);
  assert.equal(entry.lastHeatedAt, NOW_ISO);
  assert.ok(!entry.reason.includes('跳过'), entry.reason);
});

test('批次 4 同源断言：TEMPERATURE_DEFAULTS 数值全部派生自 DEFAULT_TEMPERATURE_PARAMS（映射固定）', () => {
  assert.equal(TEMPERATURE_DEFAULTS.S0, DEFAULT_TEMPERATURE_PARAMS.s0Days, 'S0 ← s0Days');
  assert.equal(TEMPERATURE_DEFAULTS.Smax, DEFAULT_TEMPERATURE_PARAMS.sMaxDays, 'Smax ← sMaxDays');
  assert.equal(TEMPERATURE_DEFAULTS.alpha, DEFAULT_TEMPERATURE_PARAMS.readAlpha, 'alpha ← readAlpha');
  assert.equal(TEMPERATURE_DEFAULTS.g, DEFAULT_TEMPERATURE_PARAMS.consolidateGain, 'g ← consolidateGain');
  assert.equal(TEMPERATURE_DEFAULTS.heatWindowHours, DEFAULT_TEMPERATURE_PARAMS.readDedupHours, 'heatWindowHours ← readDedupHours');
  assert.equal(TEMPERATURE_DEFAULTS.minCooldownDays, DEFAULT_TEMPERATURE_PARAMS.minCooldownDays, 'minCooldownDays ← minCooldownDays');
  assert.equal(TEMPERATURE_DEFAULTS.cooldownT, DEFAULT_TEMPERATURE_PARAMS.coolThreshold, 'cooldownT ← coolThreshold');
  assert.equal(TEMPERATURE_DEFAULTS.restoreT, DEFAULT_TEMPERATURE_PARAMS.restoreThreshold, 'restoreT ← restoreThreshold');
  // 不在 12 项里的公式内在常量保持原值（非用户可调）
  assert.equal(TEMPERATURE_DEFAULTS.seedFallbackT, 50);
  assert.equal(TEMPERATURE_DEFAULTS.coldT, 10);
});

test('批次 4 源码断言：映射键一律经 toFormulaParams 派生，禁数字字面量（12/24/85/30/180/0.35/25/50 全拦）', () => {
  const source = readFileSync(new URL('../../src/forgetting/topic-temperature.mjs', import.meta.url), 'utf8');
  // 去注释后断言（注释里的数字属说明性内容，不算「定义」）
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  // 正向（评审 R1）：默认值必须经唯一映射函数构造（评审 R2 落地后逐键手写映射
  // 已删除，正向断言随之收敛为「构造必须出现」；回退字面量的拦截由下方反向
  // 断言承担——旧值 12 与新值 24 都拦，任一回退必红）。
  assert.ok(
    /toFormulaParams\s*\(\s*DEFAULT_TEMPERATURE_PARAMS\s*\)/.test(code),
    'TEMPERATURE_DEFAULTS / INTERNAL_PARAM_DEFAULTS 必须经 toFormulaParams(DEFAULT_TEMPERATURE_PARAMS) 构造',
  );
  // 钉死 updated 保底的消费表达式（评审 R11：宽松的 /params\.updatedFloor/ 会被
  // normalizeParams 的区间守卫满足，改成局部常量 Math.max(T, FLOOR) 也拦不住）。
  assert.ok(
    /record\.temperature\s*=\s*Math\.max\(record\.temperature,\s*params\.updatedFloor\)/.test(code),
    'updated 保底必须以 record.temperature = Math.max(record.temperature, params.updatedFloor) 形式消费',
  );
  // 反向：9 个映射键在去注释源码里一律不得以「键: 数字字面量」形式出现
  //（值只能来自 toFormulaParams 的输出）。评审 R10：正则加前缀负向断言（防单字
  // 母键 g 误伤 tag: 1 这类以 g 结尾的属性）+ 可选引号（'heatWindowHours': 24
  // 这类带引号键写法也要拦）。
  for (const mappedKey of ['S0', 'Smax', 'alpha', 'g', 'heatWindowHours', 'minCooldownDays', 'cooldownT', 'restoreT', 'updatedFloor']) {
    assert.ok(
      !new RegExp(`(?<![A-Za-z0-9_$])(?:'|")?${mappedKey}(?:'|")?\\s*:\\s*-?\\d`).test(code),
      `映射键 ${mappedKey} 不得回写数字字面量（含带引号键写法；须由 toFormulaParams 派生）`,
    );
  }
  // 公式内在常量（非 12 项映射键）保留字面量，白名单在此锁定：
  assert.ok(/seedFallbackT:\s*50\b/.test(code), 'seedFallbackT=50 为公式内在常量（§6.3 缺 updated 回落），保留');
  assert.ok(/coldT:\s*10\b/.test(code), 'coldT=10 为公式内在常量（R7 分级），保留');
});

test('批次 4：updated 保底读 params.updatedFloor（默认 85，可覆盖；公式层守卫 [0,100]）', () => {
  const base = {
    topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
    events: [event(NOW_MS, 'updated', 'a')],
    now: NOW_MS,
  };
  // 基线 T=100*2^(-60/30)=25：updated 后顶到保底
  close(evaluateTopics(base).topics[0].T, 85, '默认 updatedFloor=85');
  close(evaluateTopics({ ...base, params: { updatedFloor: 60 } }).topics[0].T, 60, '覆盖 updatedFloor=60');
  // 公式层守卫 [0,100]（用户层 50–100 由 params.mjs PARAM_SPECS 把关，两层口径与 S0 同款）
  assert.throws(
    () => evaluateTopics({ ...base, params: { updatedFloor: 101 } }),
    (error) => error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => evaluateTopics({ ...base, params: { updatedFloor: -1 } }),
    (error) => error.code === 'INVALID_INPUT',
  );
});
