// Shiori 0.5 批次 4 · test/forgetting/params.test.mjs
// 温度参数唯一源头模块（0.5-DEV-PLAN §11.2.6）的测试：默认值/规格快照、逐项范围
// 校验（不夹取）、三条交叉校验、diff、审计事件纯构造、纯模块纪律、evaluateTopics
// 默认 vs 自定义参数对比。
// 自查口：node --test test/forgetting/params.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DEFAULT_TEMPERATURE_PARAMS,
  PARAM_SPECS,
  RESTORE_HYSTERESIS,
  normalizeTemperatureParams,
  validateTemperatureParams,
  diffParams,
  buildSettingsChangeEvent,
  toFormulaParams,
  assertKnownTemperatureKeys,
} from '../../src/forgetting/params.mjs';
import { evaluateTopics, TEMPERATURE_DEFAULTS } from '../../src/forgetting/topic-temperature.mjs';

const DAY = 86400000;
const HOUR = 3600000;
const NOW_MS = Date.parse('2026-11-21T12:00:00.000Z');
const SCOPE = 'amber';

function iso(ms) {
  return new Date(ms).toISOString();
}

function topic(key, overrides) {
  return { key, scopeId: SCOPE, ...(overrides || {}) };
}

function event(atMs, kind, topicKey, extra) {
  return { at: iso(atMs), scopeId: SCOPE, kind, topicKey, ...(extra || {}) };
}

function assertInvalid(error, messagePart) {
  assert.equal(error.code, 'INVALID_INPUT');
  if (messagePart !== undefined) {
    assert.ok(error.message.includes(messagePart), `报错应含 "${messagePart}"：${error.message}`);
  }
  return true; // assert.throws 的校验函数必须显式返回 true
}

// 与 topic-temperature.test.mjs 同款浮点容差断言（0.35/0.6 类系数经浮点乘法后
// 不保证逐位等于十进制期望，1e-9 容差与既有黄金样例口径一致）。
function close(actual, expected, label, epsilon) {
  const eps = epsilon === undefined ? 1e-9 : epsilon;
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= eps,
    (label || 'T') + ': 期望 ' + expected + ' ± ' + eps + '，实际 ' + actual,
  );
}

// ---------------------------------------------------------------------------
// 默认值与规格快照（唯一源头；§11.2.6 表逐项锁定）
// ---------------------------------------------------------------------------

test('默认值快照：12 项与 §11.2.6 表逐项一致，键序 = PARAM_SPECS 顺序，输出冻结', () => {
  assert.deepEqual({ ...DEFAULT_TEMPERATURE_PARAMS }, {
    s0Days: 30,
    sMaxDays: 180,
    consolidateGain: 0.5,
    readAlpha: 0.35,
    updatedFloor: 85,
    readDedupHours: 24,
    coolThreshold: 25,
    restoreThreshold: 50,
    minCooldownDays: 30,
    minRestoreGraceDays: 14,
    maxOpsPerRun: 20,
    evaluateEveryHours: 24,
  });
  assert.deepEqual(Object.keys(DEFAULT_TEMPERATURE_PARAMS), Object.keys(PARAM_SPECS));
  assert.ok(Object.isFrozen(DEFAULT_TEMPERATURE_PARAMS), '默认值对象必须冻结');
  assert.ok(Object.isFrozen(PARAM_SPECS), '规格对象必须冻结');
});

test('PARAM_SPECS 快照：范围/单位与 §11.2.6 表逐项一致；integer 标记仅在 maxOpsPerRun', () => {
  const expected = {
    s0Days: { min: 7, max: 90, unit: '天' },
    sMaxDays: { min: 60, max: 365, unit: '天' },
    consolidateGain: { min: 0, max: 1, unit: '无量纲' },
    readAlpha: { min: 0.1, max: 0.6, unit: '无量纲' },
    updatedFloor: { min: 50, max: 100, unit: '温度' },
    readDedupHours: { min: 6, max: 72, unit: '小时' },
    coolThreshold: { min: 10, max: 40, unit: '温度' },
    restoreThreshold: { min: 30, max: 80, unit: '温度' },
    minCooldownDays: { min: 7, max: 90, unit: '天' },
    minRestoreGraceDays: { min: 3, max: 30, unit: '天' },
    maxOpsPerRun: { min: 1, max: 50, unit: '条' },
    evaluateEveryHours: { min: 6, max: 168, unit: '小时' },
  };
  assert.deepEqual(Object.keys(PARAM_SPECS), Object.keys(expected));
  for (const [key, spec] of Object.entries(expected)) {
    assert.equal(PARAM_SPECS[key].min, spec.min, `${key}.min`);
    assert.equal(PARAM_SPECS[key].max, spec.max, `${key}.max`);
    assert.equal(PARAM_SPECS[key].unit, spec.unit, `${key}.unit`);
    assert.equal(typeof PARAM_SPECS[key].description, 'string', `${key}.description`);
    assert.ok(PARAM_SPECS[key].description.length > 0, `${key}.description 非空`);
  }
  const integerKeys = Object.keys(PARAM_SPECS).filter((key) => PARAM_SPECS[key].integer === true);
  assert.deepEqual(integerKeys, ['maxOpsPerRun'], 'integer 标记只允许 maxOpsPerRun（执行条数无小数语义）');
  assert.equal(RESTORE_HYSTERESIS, 10, '恢复/冷却回差常量');
});

// ---------------------------------------------------------------------------
// normalizeTemperatureParams
// ---------------------------------------------------------------------------

test('normalize：缺省回落默认；部分覆盖逐项补齐；未知键忽略（前向兼容）；不改输入', () => {
  assert.deepEqual({ ...normalizeTemperatureParams(undefined) }, { ...DEFAULT_TEMPERATURE_PARAMS });
  const partial = normalizeTemperatureParams({ s0Days: 45, futureKey: 'ignored' });
  assert.equal(partial.s0Days, 45);
  assert.equal(partial.sMaxDays, DEFAULT_TEMPERATURE_PARAMS.sMaxDays, '未给键回落默认');
  assert.ok(!('futureKey' in partial), '未知键不进输出');
  const input = Object.freeze({ s0Days: 45 });
  const out = normalizeTemperatureParams(input);
  assert.deepEqual(input, { s0Days: 45 }, '不得修改输入');
  assert.ok(Object.isFrozen(out), '输出冻结');
  // 显式 undefined 的键同样回落默认
  const withUndefined = normalizeTemperatureParams({ s0Days: undefined, coolThreshold: 30 });
  assert.equal(withUndefined.s0Days, DEFAULT_TEMPERATURE_PARAMS.s0Days);
  assert.equal(withUndefined.coolThreshold, 30);
});

test('normalize：非普通对象一律 INVALID_INPUT（null / 数值 / 数组）', () => {
  for (const bad of [null, 42, 'params', [], true]) {
    assert.throws(() => normalizeTemperatureParams(bad), (error) => assertInvalid(error), String(bad));
  }
});

test('12 项范围校验：越界即 INVALID_INPUT（details 带键名/实际值/允许区间），绝不静默夹取', () => {
  for (const [key, spec] of Object.entries(PARAM_SPECS)) {
    const delta = spec.integer === true ? 1 : 0.01;
    for (const bad of [spec.min - delta, spec.max + delta]) {
      assert.throws(
        () => normalizeTemperatureParams({ [key]: bad }),
        (error) => {
          assertInvalid(error, key);
          assert.equal(error.details.key, key);
          assert.equal(error.details.value, bad);
          assert.equal(error.details.min, spec.min);
          assert.equal(error.details.max, spec.max);
          return true;
        },
        `${key}=${bad} 应被拒绝（允许区间 [${spec.min}, ${spec.max}]）`,
      );
    }
  }
});

test('非有限数 / 非数值类型：12 项逐键拒绝（NaN / ±Infinity / 字符串 / null / 布尔），message 带允许区间', () => {
  for (const [key, spec] of Object.entries(PARAM_SPECS)) {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '30', null, true]) {
      assert.throws(
        () => normalizeTemperatureParams({ [key]: bad }),
        (error) => {
          assertInvalid(error, key);
          assert.equal(error.details.key, key);
          // 评审 R5：message 必须带允许区间文本（不只藏在 details）
          assert.ok(
            error.message.includes(`[${spec.min}, ${spec.max}]`),
            `message 应含允许区间 [${spec.min}, ${spec.max}]：${error.message}`,
          );
          return true;
        },
        `${key}=${String(bad)} 应被拒绝`,
      );
    }
  }
});

test('integer 约束：maxOpsPerRun 拒绝小数（message 带区间）；未标 integer 的天数允许小数', () => {
  assert.throws(
    () => normalizeTemperatureParams({ maxOpsPerRun: 20.5 }),
    (error) => {
      assertInvalid(error, 'maxOpsPerRun');
      assert.equal(error.details.key, 'maxOpsPerRun');
      assert.ok(error.message.includes('[1, 50]'), `message 应含允许区间 [1, 50]：${error.message}`);
      return true;
    },
    'maxOpsPerRun=20.5 应被拒绝（integer）',
  );
  const fractional = normalizeTemperatureParams({ s0Days: 30.5 });
  assert.equal(fractional.s0Days, 30.5, '未标 integer 的参数允许小数（公式按连续天数计算）');
});

// ---------------------------------------------------------------------------
// validateTemperatureParams：三条交叉校验
// ---------------------------------------------------------------------------

test('交叉校验：默认参数与贴边界合法组合放行', () => {
  validateTemperatureParams(normalizeTemperatureParams(undefined));
  // 恰好贴边界：restore = cool + 10；grace == cooldown；smax 刚好大于 s0
  validateTemperatureParams({
    ...DEFAULT_TEMPERATURE_PARAMS,
    coolThreshold: 40,
    restoreThreshold: 40 + RESTORE_HYSTERESIS,
    minCooldownDays: 14,
    minRestoreGraceDays: 14,
    s0Days: 89,
    sMaxDays: 90,
  });
});

test('交叉校验①：sMaxDays > s0Days，相等即拒', () => {
  assert.throws(
    () => validateTemperatureParams({ ...DEFAULT_TEMPERATURE_PARAMS, s0Days: 90, sMaxDays: 90 }),
    (error) => {
      assertInvalid(error, 'sMaxDays');
      assert.ok(error.message.includes('s0Days'), error.message);
      return true;
    },
  );
});

test('交叉校验②：restoreThreshold >= coolThreshold + 10（回差不足即拒）', () => {
  assert.throws(
    () => validateTemperatureParams({ ...DEFAULT_TEMPERATURE_PARAMS, coolThreshold: 40, restoreThreshold: 49 }),
    (error) => {
      assertInvalid(error, 'restoreThreshold');
      assert.ok(error.message.includes('coolThreshold'), error.message);
      assert.equal(error.details.hysteresis, RESTORE_HYSTERESIS);
      return true;
    },
  );
});

test('交叉校验③：minRestoreGraceDays <= minCooldownDays（保护期长于观察期即拒）', () => {
  assert.throws(
    () => validateTemperatureParams({ ...DEFAULT_TEMPERATURE_PARAMS, minCooldownDays: 7, minRestoreGraceDays: 14 }),
    (error) => {
      assertInvalid(error, 'minRestoreGraceDays');
      assert.ok(error.message.includes('minCooldownDays'), error.message);
      return true;
    },
  );
});

test('交叉校验：缺键 / 非有限数 / 非普通对象拒绝', () => {
  assert.throws(() => validateTemperatureParams({ s0Days: 30 }), (error) => assertInvalid(error, 'sMaxDays'));
  assert.throws(() => validateTemperatureParams({ ...DEFAULT_TEMPERATURE_PARAMS, sMaxDays: Number.NaN }), (error) => assertInvalid(error, 'sMaxDays'));
  assert.throws(() => validateTemperatureParams(null), (error) => assertInvalid(error));
  assert.throws(() => validateTemperatureParams('params'), (error) => assertInvalid(error));
});

// ---------------------------------------------------------------------------
// diffParams
// ---------------------------------------------------------------------------

test('diffParams：只列变化项，按 PARAM_SPECS 顺序（散布三键验证顺序）；无变化返回空数组', () => {
  const oldP = normalizeTemperatureParams(undefined);
  const nextP = normalizeTemperatureParams({
    s0Days: 45,
    updatedFloor: 90,
    evaluateEveryHours: 12,
  });
  const diff = diffParams(oldP, nextP);
  assert.deepEqual(diff, [
    { key: 's0Days', from: 30, to: 45 },
    { key: 'updatedFloor', from: 85, to: 90 },
    { key: 'evaluateEveryHours', from: 24, to: 12 },
  ]);
  assert.deepEqual(diffParams(oldP, normalizeTemperatureParams(undefined)), []);
  assert.ok(Object.isFrozen(diff) && diff.every((entry) => Object.isFrozen(entry)), 'diff 及条目冻结');
});

test('diffParams：缺键 / 非普通对象拒绝（只接受完整 12 项参数对象）', () => {
  const full = normalizeTemperatureParams(undefined);
  const missing = { ...full };
  delete missing.s0Days;
  assert.throws(() => diffParams(missing, full), (error) => assertInvalid(error, 'oldP'));
  assert.throws(() => diffParams(full, missing), (error) => assertInvalid(error, 'nextP'));
  assert.throws(() => diffParams(null, full), (error) => assertInvalid(error));
  assert.throws(() => diffParams(full, 42), (error) => assertInvalid(error));
});

// ---------------------------------------------------------------------------
// buildSettingsChangeEvent：审计事件纯构造
// ---------------------------------------------------------------------------

test('buildSettingsChangeEvent：恰为 { kind, at, targetScopeId, changes } 四键（不含正文），changes 按 PARAM_SPECS 顺序归一', () => {
  const at = '2026-11-21T12:00:00.000Z';
  const event = buildSettingsChangeEvent({
    at,
    targetScopeId: SCOPE,
    // 手工乱序构造：应被归一为 PARAM_SPECS 顺序（s0Days 在 evaluateEveryHours 前）
    changes: [
      { key: 'evaluateEveryHours', from: 24, to: 12 },
      { key: 's0Days', from: 30, to: 45 },
    ],
  });
  assert.deepEqual(Object.keys(event), ['kind', 'at', 'targetScopeId', 'changes'], '事件恰四键，不含正文');
  assert.equal(event.kind, 'settings_change');
  assert.equal(event.at, at);
  assert.equal(event.targetScopeId, SCOPE);
  assert.deepEqual(event.changes, [
    { key: 's0Days', from: 30, to: 45 },
    { key: 'evaluateEveryHours', from: 24, to: 12 },
  ]);
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.changes), '事件与 changes 冻结');
  // 与 diffParams 的产物无缝衔接
  const fromDiff = buildSettingsChangeEvent({
    at,
    targetScopeId: SCOPE,
    changes: diffParams(normalizeTemperatureParams(undefined), normalizeTemperatureParams({ s0Days: 45 })),
  });
  assert.deepEqual(fromDiff.changes, [{ key: 's0Days', from: 30, to: 45 }]);
});

test('buildSettingsChangeEvent：非法输入逐项拒绝（at / scope / changes 形状 / 未知键 / from==to / 重复键 / 空 changes）', () => {
  const at = '2026-11-21T12:00:00.000Z';
  const change = { key: 's0Days', from: 30, to: 45 };
  const assertThrows = (input, part) => assert.throws(
    () => buildSettingsChangeEvent(input),
    (error) => assertInvalid(error, part),
    JSON.stringify(input)?.slice(0, 80),
  );
  // at：缺省 / 非规范串 / 带时区偏移 / 不存在的日期
  assertThrows({ targetScopeId: SCOPE, changes: [change] }, 'at');
  assertThrows({ at: '2026-11-21 12:00:00', targetScopeId: SCOPE, changes: [change] }, 'at');
  assertThrows({ at: '2026-11-21T20:00:00.000+08:00', targetScopeId: SCOPE, changes: [change] }, 'at');
  assertThrows({ at: '2026-02-30T00:00:00.000Z', targetScopeId: SCOPE, changes: [change] }, 'at');
  // targetScopeId：缺省 / 空串 / 非字符串
  assertThrows({ at, changes: [change] }, 'targetScopeId');
  assertThrows({ at, targetScopeId: '', changes: [change] }, 'targetScopeId');
  assertThrows({ at, targetScopeId: 42, changes: [change] }, 'targetScopeId');
  // changes：缺省 / 空数组 / 非数组
  assertThrows({ at, targetScopeId: SCOPE }, 'changes');
  assertThrows({ at, targetScopeId: SCOPE, changes: [] }, 'changes');
  assertThrows({ at, targetScopeId: SCOPE, changes: 's0Days' }, 'changes');
  // 条目：非普通对象 / 键形状错 / 未知键 / from 或 to 非有限数 / from==to / 重复键
  assertThrows({ at, targetScopeId: SCOPE, changes: [null] }, 'changes[0]');
  assertThrows({ at, targetScopeId: SCOPE, changes: [{ key: 's0Days', from: 30 }] }, 'changes[0]');
  assertThrows({ at, targetScopeId: SCOPE, changes: [{ key: 'notAParam', from: 1, to: 2 }] }, 'notAParam');
  assertThrows({ at, targetScopeId: SCOPE, changes: [{ key: 's0Days', from: Number.NaN, to: 45 }] }, 'from');
  assertThrows({ at, targetScopeId: SCOPE, changes: [{ key: 's0Days', from: 30, to: '45' }] }, 'to');
  assertThrows({ at, targetScopeId: SCOPE, changes: [{ key: 's0Days', from: 45, to: 45 }] }, 'from 与 to 相同');
  assertThrows({ at, targetScopeId: SCOPE, changes: [change, { ...change }] }, '重复');
});

// ---------------------------------------------------------------------------
// 纯模块纪律（与 topic-temperature 同款 R12 口径）
// ---------------------------------------------------------------------------

test('params.mjs 源码零 I/O / 零时钟读取 / 零环境变量 / 零 node: 内建', () => {
  const source = readFileSync(new URL('../../src/forgetting/params.mjs', import.meta.url), 'utf8');
  assert.ok(!/Date\.now\s*\(/.test(source), '不得调用时钟');
  assert.ok(!/process\.env/.test(source), '不得读环境变量');
  assert.ok(!/from\s+['"]node:/.test(source), '不得 import 任何 node: 内建');
  assert.ok(!/require\s*\(/.test(source), '不得使用 require');
  assert.ok(!/readFileSync|writeFileSync|mkdirSync/.test(source.replace(/\/\/.*$/gm, '')), '不得出现文件系统调用');
});

// ---------------------------------------------------------------------------
// evaluateTopics：同一事件序列，默认参数 vs 自定义参数（§11.2.6 参数可配置的语义闭环）
// ---------------------------------------------------------------------------

// 基线：updated 在 60 天前（S0=30 → 种子 T=100*2^(-2)=25），同一事件序列两种参数各跑一遍。
const CONTRAST_BASE = {
  topics: [topic('a', { updated: iso(NOW_MS - 60 * DAY) })],
  now: NOW_MS,
};

test('对比组①：readAlpha 0.35 → 0.6，同一 read 事件加热幅度按参数变化（51.25 → 70）', () => {
  const base = { ...CONTRAST_BASE, events: [event(NOW_MS, 'read', 'a')] };
  const withDefault = evaluateTopics(base);
  const customParams = normalizeTemperatureParams({ readAlpha: 0.6 }); // 用户层参数 → 映射键
  const withCustom = evaluateTopics({ ...base, params: { alpha: customParams.readAlpha } });
  close(withDefault.topics[0].T, 51.25, '默认 readAlpha=0.35'); // 25 + 0.35 * 75
  close(withCustom.topics[0].T, 70, '自定义 readAlpha=0.6'); // 25 + 0.6 * 75
  assert.ok(withCustom.topics[0].T > withDefault.topics[0].T);
});

test('对比组②：updatedFloor 85 → 60，updated 保底按参数变化（85 → 60）', () => {
  const base = { ...CONTRAST_BASE, events: [event(NOW_MS, 'updated', 'a')] };
  const withDefault = evaluateTopics(base);
  const customParams = normalizeTemperatureParams({ updatedFloor: 60 });
  const withCustom = evaluateTopics({ ...base, params: { updatedFloor: customParams.updatedFloor } });
  assert.equal(withDefault.topics[0].T, 85, '默认保底 85');
  assert.equal(withCustom.topics[0].T, 60, '自定义保底 60');
});

test('对比组③（真穿映射）：非默认 readDedupHours=12 经 toFormulaParams 喂 evaluateTopics 必须真实生效', () => {
  // 评审 R3：旧版把「等于默认值的参数」喂回去做 deepEqual，是恒真用例——映射写错
  // /漏传会被公式模块「未知键忽略→回落默认」掩盖。改为非默认值真穿映射：
  // readDedupHours=12（窗口 12h）时，间隔恰好 12h 的第二次 read 不被去重（窗口判定
  // 是严格小于），T 必须高于只读一次——映射错/漏传则窗口回落默认 24h，用例必红。
  const mapped = toFormulaParams(normalizeTemperatureParams({ readDedupHours: 12 }));
  const input = {
    ...CONTRAST_BASE,
    events: [event(NOW_MS - 12 * HOUR, 'read', 'a'), event(NOW_MS, 'read', 'a')],
    params: mapped,
  };
  const twice = evaluateTopics(input);
  const once = evaluateTopics({ ...input, events: [event(NOW_MS - 12 * HOUR, 'read', 'a')] });
  assert.ok(twice.topics[0].T > once.topics[0].T, `12h 窗口下第二次 read 应正常加热：两次=${twice.topics[0].T} 单次=${once.topics[0].T}`);
  assert.equal(twice.topics[0].lastHeatedAt, iso(NOW_MS), '第二次 read 计入加热');
  assert.ok(!twice.topics[0].reason.includes('跳过'), twice.topics[0].reason);

  // toFormulaParams 对默认值的输出与 TEMPERATURE_DEFAULTS 逐键相等
  //（批次 4 起 TEMPERATURE_DEFAULTS 为 11 键、含 updatedFloor——经
  // FORMULA_DEFAULTS 展开的事实形状，评审 R8 拍板按事实对齐）。
  const fromDefaults = toFormulaParams(DEFAULT_TEMPERATURE_PARAMS);
  for (const [key, value] of Object.entries(fromDefaults)) {
    assert.equal(TEMPERATURE_DEFAULTS[key], value, `TEMPERATURE_DEFAULTS.${key} 必须等于 toFormulaParams 默认输出`);
  }
});

test('toFormulaParams：映射固定（9 键）、输出冻结；缺键 / 非普通对象拒绝', () => {
  const defaults = toFormulaParams(DEFAULT_TEMPERATURE_PARAMS);
  assert.deepEqual({ ...defaults }, {
    S0: 30,
    Smax: 180,
    g: 0.5,
    alpha: 0.35,
    updatedFloor: 85,
    heatWindowHours: 24,
    cooldownT: 25,
    restoreT: 50,
    minCooldownDays: 30,
  });
  assert.ok(Object.isFrozen(defaults));
  // 值与 12 项源头逐项相等（映射只换键名不改值）
  for (const [userKey, formulaKey] of Object.entries({ s0Days: 'S0', sMaxDays: 'Smax', consolidateGain: 'g', readAlpha: 'alpha', updatedFloor: 'updatedFloor', readDedupHours: 'heatWindowHours', coolThreshold: 'cooldownT', restoreThreshold: 'restoreT', minCooldownDays: 'minCooldownDays' })) {
    assert.equal(defaults[formulaKey], DEFAULT_TEMPERATURE_PARAMS[userKey], `${formulaKey} ← ${userKey}`);
  }
  // 缺键 / 非普通对象拒绝（绝不静默用默认值顶替缺键）
  const missing = { ...DEFAULT_TEMPERATURE_PARAMS };
  delete missing.s0Days;
  assert.throws(() => toFormulaParams(missing), (error) => assertInvalid(error, 's0Days'));
  assert.throws(() => toFormulaParams(null), (error) => assertInvalid(error));
  assert.throws(() => toFormulaParams({}), (error) => assertInvalid(error, 's0Days'));
});

test('toFormulaParams：值类型 fail-closed（评审 R9：NaN / 字符串 / 整数键传小数均拒绝）', () => {
  const base = normalizeTemperatureParams(undefined);
  assert.throws(
    () => toFormulaParams({ ...base, s0Days: Number.NaN }),
    (error) => assertInvalid(error, 's0Days'),
    '映射键传 NaN 必须拒绝（否则透传给公式层静默回落/算出 NaN）',
  );
  assert.throws(
    () => toFormulaParams({ ...base, readDedupHours: 'abc' }),
    (error) => assertInvalid(error, 'readDedupHours'),
    '映射键传字符串必须拒绝',
  );
  assert.throws(
    () => toFormulaParams({ ...base, maxOpsPerRun: 20.5 }),
    (error) => assertInvalid(error, 'maxOpsPerRun'),
    'integer 标记键传小数必须拒绝（按 PARAM_SPECS 标记驱动）',
  );
});

test('assertKnownTemperatureKeys：未知键 / 非普通对象拒绝（message 带键名）；缺省放行', () => {
  assertKnownTemperatureKeys(undefined); // 缺省放行
  assertKnownTemperatureKeys(normalizeTemperatureParams(undefined)); // 完整 12 项放行
  assert.throws(
    () => assertKnownTemperatureKeys({ notAParam: 1 }),
    (error) => assertInvalid(error, 'notAParam') && /unknown property/.test(error.message),
  );
  assert.throws(() => assertKnownTemperatureKeys(null), (error) => assertInvalid(error));
  assert.throws(() => assertKnownTemperatureKeys(42), (error) => assertInvalid(error));
});
