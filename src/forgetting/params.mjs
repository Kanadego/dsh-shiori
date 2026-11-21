// Shiori 0.5 批次 4 · A 线：热度参数唯一源头模块（0.5-DEV-PLAN §11.2.6）。
//
// 职责：把温度公式里 12 个用户可调数字收成本文件唯一一份（默认值 + 规格 + 校验 +
// diff + 审计事件纯构造），供三处同源消费：
//   - topic-temperature.mjs：TEMPERATURE_DEFAULTS 与公式参数全部由本模块派生
//     （固定映射 s0Days→S0 / sMaxDays→Smax / consolidateGain→g / readAlpha→alpha /
//     readDedupHours→heatWindowHours / updatedFloor→updated 保底 /
//     coolThreshold→cooldownT / restoreThreshold→restoreT /
//     minCooldownDays→minCooldownDays），不许再写字面量（同源断言有用例锁死）；
//   - plugin/config.mjs：temperature 设置段的 schema 默认值与权威校验复用本模块；
//   - 批次 4 B 线面板：唯一可读源头（范围/单位/描述都在 PARAM_SPECS）。
//
// 纯模块纪律（与 topic-temperature.mjs 同款）：零 I/O、零时钟读取、零环境变量、
// 不修改输入；同一输入两次调用深度相等。错误统一抛 SparkStoreError（code=INVALID_INPUT），
// 与公式模块同一错误族。
//
// 两层校验口径（有意不同，别「统一」掉）：
//   - 本模块 normalizeTemperatureParams：范围按 §11.2.6 表（用户可调区间），
//     未知键忽略（前向兼容：B/C 线可能在同一对象里塞自己的字段）；
//   - plugin/config.mjs normalizeTemperature：段内未知键拒绝（持久化设置逐键把关，
//     与 budgets/semantic 同款），再委托本模块做范围 + 交叉校验。
//
// 审计（§11.2.6 UI 纪律 4）：每次参数变更记一条 kind='settings_change' 事件
// （时间、目标 scope、键级旧值/新值，不含正文）；本模块只提供纯构造器
// buildSettingsChangeEvent，不落盘——落盘归执行层（批次 5）。

import { SparkStoreError } from '../sparks/errors.mjs';

function invalidInput(message, details) {
  return new SparkStoreError('INVALID_INPUT', message, details);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** 恢复线回差：restoreThreshold 必须不小于 coolThreshold + 10（§11.2.6 校验前置）。
 *  单独导出给面板展示校验规则，避免「+10」散落成魔数。 */
export const RESTORE_HYSTERESIS = 10;

/** 12 项热度参数默认值（§11.2.6 表，冻结；唯一源头，别处一律 import 不许复制数字）。
 *  键序即 PARAM_SPECS 顺序（= 方案表格顺序），diffParams 按此序输出。 */
export const DEFAULT_TEMPERATURE_PARAMS = Object.freeze({
  s0Days: 30,
  sMaxDays: 180,
  consolidateGain: 0.5,
  readAlpha: 0.35,
  updatedFloor: 85,
  readDedupHours: 24, // 方案 §11.2.6 拍板 24h；topic-temperature 旧默认 12 以方案为准改 24
  coolThreshold: 25,
  restoreThreshold: 50,
  minCooldownDays: 30,
  minRestoreGraceDays: 14,
  maxOpsPerRun: 20,
  evaluateEveryHours: 24,
});

/** 12 项参数规格（§11.2.6 表：范围 / 单位 / 描述；integer 标记必须为整数的项）。
 *  冻结对象，键序即 diffParams 输出顺序；B 线面板表单据此渲染。 */
export const PARAM_SPECS = Object.freeze({
  s0Days: Object.freeze({ min: 7, max: 90, unit: '天', description: '新生 Topic 的初始有效半衰期 S0' }),
  sMaxDays: Object.freeze({ min: 60, max: 365, unit: '天', description: '间隔巩固上限 Smax' }),
  consolidateGain: Object.freeze({ min: 0, max: 1, unit: '无量纲', description: '间隔巩固增益 g' }),
  readAlpha: Object.freeze({ min: 0.1, max: 0.6, unit: '无量纲', description: 'read 加热系数 alpha' }),
  updatedFloor: Object.freeze({ min: 50, max: 100, unit: '温度', description: '内容修改后的温度保底' }),
  readDedupHours: Object.freeze({ min: 6, max: 72, unit: '小时', description: 'read 全局冷却窗口（去重）' }),
  coolThreshold: Object.freeze({ min: 10, max: 40, unit: '温度', description: '冷却线，低于即 cold' }),
  restoreThreshold: Object.freeze({ min: 30, max: 80, unit: '温度', description: '恢复线，回升到即恢复' }),
  minCooldownDays: Object.freeze({ min: 7, max: 90, unit: '天', description: '最小冷却年龄（观察期）' }),
  minRestoreGraceDays: Object.freeze({ min: 3, max: 30, unit: '天', description: '手动恢复后的保护期' }),
  maxOpsPerRun: Object.freeze({ min: 1, max: 50, unit: '条', integer: true, description: 'auto 单轮最多执行条数' }),
  evaluateEveryHours: Object.freeze({ min: 6, max: 168, unit: '小时', description: '评估周期（距上次成功评估）' }),
});

/**
 * 规范化 12 项热度参数（纯函数，不修改输入）。
 *
 * - 缺省（undefined）回落 DEFAULT_TEMPERATURE_PARAMS；
 * - 已知键缺省 / undefined 逐项回落默认；
 * - 未知键忽略（前向兼容，不进输出）；
 * - 非有限数（NaN / Infinity / 非数值类型）或超范围 → INVALID_INPUT，
 *   message 与 details 带键名、实际值、允许区间，绝不静默夹取；
 * - maxOpsPerRun 有 integer 约束（执行条数无小数语义）。
 *
 * 注意：本函数只做逐项范围校验；三条交叉校验（sMaxDays > s0Days /
 * restoreThreshold >= coolThreshold + RESTORE_HYSTERESIS /
 * minRestoreGraceDays <= minCooldownDays）在 validateTemperatureParams，
 * 调用方（面板保存 / config normalize）两步连用。
 *
 * @param {object|undefined} input 部分或完整参数对象。
 * @returns {Readonly<object>} 冻结的 12 项完整参数。
 */
export function normalizeTemperatureParams(input) {
  if (input === undefined) return Object.freeze({ ...DEFAULT_TEMPERATURE_PARAMS });
  if (!isPlainObject(input)) {
    throw invalidInput('temperature 参数必须是普通对象或缺省', { valueType: typeof input });
  }
  const out = {};
  for (const [key, spec] of Object.entries(PARAM_SPECS)) {
    const raw = input[key];
    if (raw === undefined) {
      out[key] = DEFAULT_TEMPERATURE_PARAMS[key];
      continue;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw invalidInput(
        `temperature.${key} 必须是有限数值（${spec.description}），允许区间 [${spec.min}, ${spec.max}]，当前为 ${String(raw)}`,
        { key, value: String(raw), valueType: typeof raw, min: spec.min, max: spec.max },
      );
    }
    if (raw < spec.min || raw > spec.max) {
      throw invalidInput(
        `temperature.${key}=${String(raw)} 超出允许区间 [${spec.min}, ${spec.max}]（${spec.description}），不静默夹取`,
        { key, value: raw, min: spec.min, max: spec.max },
      );
    }
    if (spec.integer === true && !Number.isInteger(raw)) {
      throw invalidInput(
        `temperature.${key} 必须是整数（${spec.description}），允许区间 [${spec.min}, ${spec.max}]，当前为 ${String(raw)}`,
        { key, value: raw, min: spec.min, max: spec.max, integer: true },
      );
    }
    out[key] = raw;
  }
  return Object.freeze(out);
}

/**
 * 三条交叉校验（§11.2.6 UI 纪律 2「校验前置」，违反即 INVALID_INPUT，不静默修正）：
 *   1. sMaxDays > s0Days（巩固上限必须高于初始半衰期）；
 *   2. restoreThreshold >= coolThreshold + RESTORE_HYSTERESIS（恢复/冷却两线留回差，
 *      防止在同一段温度上抖动）；
 *   3. minRestoreGraceDays <= minCooldownDays（保护期不得长于观察期）。
 *
 * 入参应为 normalizeTemperatureParams 的产物（12 键齐全；涉及键缺省或非有限数
 * 一律 INVALID_INPUT）。逐项范围校验不在本函数——那是 normalizeTemperatureParams
 * 的职责，两层各司其职。
 *
 * @param {object} p 完整 12 项参数对象。
 * @returns {void} 通过即静默返回；违反抛 SparkStoreError(INVALID_INPUT)。
 */
export function validateTemperatureParams(p) {
  if (!isPlainObject(p)) {
    throw invalidInput('validateTemperatureParams 的入参必须是普通对象', { valueType: typeof p });
  }
  const requireKey = (key) => {
    const value = p[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidInput(
        `temperature.${key} 缺失或不是有限数值，无法做交叉校验`,
        { key, valueType: typeof value },
      );
    }
    return value;
  };
  const s0 = requireKey('s0Days');
  const smax = requireKey('sMaxDays');
  if (!(smax > s0)) {
    throw invalidInput(
      `temperature 校验失败：sMaxDays（${String(smax)}）必须大于 s0Days（${String(s0)}）`,
      { rule: 'sMaxDays > s0Days', sMaxDays: smax, s0Days: s0 },
    );
  }
  const cool = requireKey('coolThreshold');
  const restore = requireKey('restoreThreshold');
  if (!(restore >= cool + RESTORE_HYSTERESIS)) {
    throw invalidInput(
      `temperature 校验失败：restoreThreshold（${String(restore)}）必须不小于 coolThreshold + ${RESTORE_HYSTERESIS}（${String(cool + RESTORE_HYSTERESIS)}），恢复/冷却两线须留回差`,
      { rule: 'restoreThreshold >= coolThreshold + RESTORE_HYSTERESIS', restoreThreshold: restore, coolThreshold: cool, hysteresis: RESTORE_HYSTERESIS },
    );
  }
  const grace = requireKey('minRestoreGraceDays');
  const cooldown = requireKey('minCooldownDays');
  if (!(grace <= cooldown)) {
    throw invalidInput(
      `temperature 校验失败：minRestoreGraceDays（${String(grace)}）必须不大于 minCooldownDays（${String(cooldown)}），恢复保护期不得长于冷却观察期`,
      { rule: 'minRestoreGraceDays <= minCooldownDays', minRestoreGraceDays: grace, minCooldownDays: cooldown },
    );
  }
}

/**
 * 参数 diff：只列变化项，按 PARAM_SPECS（= 方案表）顺序输出 { key, from, to }。
 * 两个入参都必须是 12 键齐全的完整参数对象（normalizeTemperatureParams 的产物），
 * 缺键/非普通对象拒绝，避免「静默把缺键当成变化」的歧义；值比较用 Object.is
 * （NaN 不会自己跟自己产生假 diff）。
 *
 * @param {object} oldP 旧参数。
 * @param {object} nextP 新参数。
 * @returns {Readonly<Array<{key, from, to}>>} 冻结的变化数组（无变化为空数组）。
 */
export function diffParams(oldP, nextP) {
  for (const [label, obj] of [['oldP', oldP], ['nextP', nextP]]) {
    if (!isPlainObject(obj)) {
      throw invalidInput(`diffParams 的 ${label} 必须是普通对象`, { arg: label, valueType: typeof obj });
    }
    for (const key of Object.keys(PARAM_SPECS)) {
      if (!Object.hasOwn(obj, key)) {
        throw invalidInput(
          `diffParams 的 ${label} 缺少键 "${key}"：diff 只接受完整 12 项参数对象（先过 normalizeTemperatureParams）`,
          { arg: label, key },
        );
      }
    }
  }
  const changes = [];
  for (const key of Object.keys(PARAM_SPECS)) {
    const from = oldP[key];
    const to = nextP[key];
    if (!Object.is(from, to)) changes.push(Object.freeze({ key, from, to }));
  }
  return Object.freeze(changes);
}

// 规范 UTC ISO（与 topic-temperature.mjs / storage/fsutil.mjs 同口径）。
// 审计事件的 at 必须规范落盘，别让面板塞本地时间串进来。
const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function requireCanonicalIso(value, where) {
  if (typeof value !== 'string' || !CANONICAL_ISO_RE.test(value)) {
    throw invalidInput(`${where} 必须是规范 UTC ISO 时间串（如 "2026-11-21T00:00:00.000Z"）`, {
      where,
      valueType: typeof value,
    });
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw invalidInput(`${where} 必须是真实存在的规范 UTC ISO 时间串`, { where, at: value });
  }
  return value;
}

/**
 * 参数变更审计事件纯构造器（§11.2.6 UI 纪律 4）。不落盘、不读时钟——at 由调用方
 * 显式给出；输出形状冻结且恰为 { kind, at, targetScopeId, changes } 四键，不含正文，
 * 供执行层（批次 5）原样写入事件账本。
 *
 * - changes：diffParams 的产物（[{ key, from, to }]），本构造器逐条复核
 *   （key 必须是 12 项之一、from/to 有限数值、from !== to、键不重复），并按
 *   PARAM_SPECS 顺序重排为规范审计序；
 * - changes 为空数组 → INVALID_INPUT（没有变化就不该构造审计事件）。
 *
 * @param {object} input
 * @param {string} input.at 规范 UTC ISO 时间串（调用方给，本模块不读时钟）。
 * @param {string} input.targetScopeId 变更归属的 scope id（非空字符串）。
 * @param {Array<{key, from, to}>} input.changes 键级旧值/新值。
 * @returns {Readonly<object>} { kind: 'settings_change', at, targetScopeId, changes }
 */
export function buildSettingsChangeEvent({ at, targetScopeId, changes } = {}) {
  const atIso = requireCanonicalIso(at, 'settings_change.at');
  if (typeof targetScopeId !== 'string' || targetScopeId.length === 0) {
    throw invalidInput('settings_change.targetScopeId 必须是非空字符串', {
      valueType: typeof targetScopeId,
    });
  }
  if (!Array.isArray(changes) || changes.length === 0) {
    throw invalidInput(
      'settings_change.changes 必须是非空数组：没有参数变化就不应构造审计事件',
      { changesType: Array.isArray(changes) ? 'array(empty)' : typeof changes },
    );
  }
  const seen = new Set();
  const normalized = changes.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw invalidInput(`changes[${index}] 必须是普通对象`, { index });
    }
    const keys = Object.keys(entry);
    if (keys.length !== 3 || !keys.includes('key') || !keys.includes('from') || !keys.includes('to')) {
      throw invalidInput(`changes[${index}] 必须恰为 { key, from, to }`, { index, keys });
    }
    const { key, from, to } = entry;
    if (typeof key !== 'string' || !Object.hasOwn(PARAM_SPECS, key)) {
      throw invalidInput(`changes[${index}].key 必须是 12 项参数之一，当前为 ${String(key)}`, { index, key });
    }
    for (const [label, value] of [['from', from], ['to', to]]) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw invalidInput(`changes[${index}].${label} 必须是有限数值，当前为 ${String(value)}`, {
          index, key, label, valueType: typeof value,
        });
      }
    }
    if (Object.is(from, to)) {
      throw invalidInput(`changes[${index}]（${key}）的 from 与 to 相同（${String(from)}），不是一次变更`, { index, key });
    }
    if (seen.has(key)) {
      throw invalidInput(`changes 里键 "${key}" 重复出现`, { key });
    }
    seen.add(key);
    return Object.freeze({ key, from, to });
  });
  // 按 PARAM_SPECS（= 方案表）顺序输出规范审计序；diffParams 本就按此序产出，
  // 手工构造的乱序 changes 在这里归一。
  normalized.sort((a, b) => Object.keys(PARAM_SPECS).indexOf(a.key) - Object.keys(PARAM_SPECS).indexOf(b.key));
  return Object.freeze({
    kind: 'settings_change',
    at: atIso,
    targetScopeId,
    changes: Object.freeze(normalized),
  });
}

// ---------------------------------------------------------------------------
// 用户键 → 公式键的固定映射（§11.2.6 ↔ §4.1）
// ---------------------------------------------------------------------------

/** 9 个参与公式的用户键到公式键的映射（updatedFloor 键名两侧一致）。
 *  唯一映射表：TEMPERATURE_DEFAULTS / INTERNAL_PARAM_DEFAULTS（topic-temperature.mjs）、
 *  B 线面板预览与批次 5 的「settings 直接喂 evaluateTopics」都经 toFormulaParams
 *  转换——否则 settings 键名会被公式模块当作未知键静默忽略（静默回落默认）。 */
const FORMULA_KEY_MAP = Object.freeze({
  s0Days: 'S0',
  sMaxDays: 'Smax',
  consolidateGain: 'g',
  readAlpha: 'alpha',
  updatedFloor: 'updatedFloor',
  readDedupHours: 'heatWindowHours',
  coolThreshold: 'cooldownT',
  restoreThreshold: 'restoreT',
  minCooldownDays: 'minCooldownDays',
});

/**
 * 把完整 12 项用户参数按固定映射转成公式键参数（evaluateTopics 的 params 形状）。
 *
 * 入参纪律与 diffParams 同款：只接受完整 12 项参数对象（normalizeTemperatureParams
 * 的产物）——缺键绝不静默用默认值顶替，否则映射写错/漏传会被「回落默认」掩盖
 * （评审 R3 指出的恒真用例教训）。输出冻结，键序即 FORMULA_KEY_MAP 顺序。
 *
 * 值类型 fail-closed（评审 R9）：这里是 B 线面板与批次 5 的直接入口，NaN / 字符串
 * 等非法值原样透传会被公式模块当未知键忽略（静默回落默认）或算出 NaN。类型校验
 * 覆盖全部 12 项（较打回条目点名的 9 个映射键更严：非映射键同样在下游消费，
 * 边界统一拦）；integer 约束按 PARAM_SPECS 标记驱动，当前命中 maxOpsPerRun。
 *
 * @param {object} p 完整 12 项用户参数。
 * @returns {Readonly<object>} { S0, Smax, g, alpha, updatedFloor, heatWindowHours,
 *   cooldownT, restoreT, minCooldownDays }
 */
export function toFormulaParams(p) {
  if (!isPlainObject(p)) {
    throw invalidInput('toFormulaParams 的入参必须是普通对象', { valueType: typeof p });
  }
  for (const key of Object.keys(PARAM_SPECS)) {
    if (!Object.hasOwn(p, key)) {
      throw invalidInput(
        `toFormulaParams 的入参缺少键 "${key}"：只接受完整 12 项参数对象（先过 normalizeTemperatureParams）`,
        { key },
      );
    }
    const value = p[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidInput(
        `toFormulaParams 的入参 ${key} 必须是有限数值，当前为 ${String(value)}`,
        { key, value: String(value), valueType: typeof value },
      );
    }
    if (PARAM_SPECS[key].integer === true && !Number.isInteger(value)) {
      throw invalidInput(
        `toFormulaParams 的入参 ${key} 必须是整数，当前为 ${String(value)}`,
        { key, value: String(value), integer: true },
      );
    }
  }
  const out = {};
  for (const [userKey, formulaKey] of Object.entries(FORMULA_KEY_MAP)) {
    out[formulaKey] = p[userKey];
  }
  return Object.freeze(out);
}

/**
 * 段内未知键 fail-closed 校验（config 持久化设置与 scope 挂载复核共用，评审 R4：
 * 两处同口径、不复制逻辑）。normalizeTemperatureParams 的「未知键忽略」是公式/
 * 面板运行时对象的前向兼容口径；持久化与挂载入口必须逐键把关——typo 直接拒绝，
 * 不静默落默认值。两层口径差异是有意设计（见本文件头注释），别「统一」掉。
 *
 * @param {object|undefined} value 待检的 temperature 段。
 * @returns {void} 缺省（undefined）静默放行；非普通对象 / 含未知键抛
 *   SparkStoreError(INVALID_INPUT)，message 带键名。
 */
export function assertKnownTemperatureKeys(value) {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    throw invalidInput('temperature 必须是普通对象或缺省', { valueType: typeof value });
  }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(DEFAULT_TEMPERATURE_PARAMS, key)) {
      throw invalidInput(`temperature has unknown property "${key}"`, { key });
    }
  }
}
