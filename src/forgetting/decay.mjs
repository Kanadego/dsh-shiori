// Shiori P4-FORGETTING · M 槽位：纯衰减分析与只读归档候选（P4-DECAY-ANALYSIS）
//
// 职责（CONTRACTS §1/§2/§3）：
//   - normalizeForgetPolicy：遗忘策略三字段（baseHalfLifeDays / maxHalfLifeDays /
//     archiveScore）「部分覆盖 + 默认补全」的严格规范化；
//   - evaluateSparkDecay：单卡衰减评估（同步纯函数）；
//   - analyzeForgetting：scope 内批量评估 + 只读归档候选 + archive-ephemeral Plan。
//
// 公式（§1，默认 policy 恰为 {baseHalfLifeDays:30, maxHalfLifeDays:240, archiveScore:0.25}）：
//   score        = 2 ** (-elapsedDays / halfLifeDays)
//   halfLifeDays = min(base * 2 ** useCount, max)（大指数封顶，见 computeHalfLifeDays）
//   elapsedDays  = max(0, (now - (lastUsedAt ?? createdAt)) / 86400000)（毫秒差除日，不取整）
//   归档资格      = active ∧ ephemeral ∧ supersedes===null ∧ elapsedDays>=60 ∧ score<archiveScore
//   默认阈值边界：59 天 too-recent；恰 60 天 score 恰为 0.25，不严格小于 → 不归档；
//   61 天可归档。自定义阈值下同样必须满 60 天冷却且分数严格低于阈值。
//   匹配/曝光（hitCount/lastHitAt）不续期——锚点只有 lastUsedAt ?? createdAt。
//
// 硬边界：
//   - 无磁盘、无定时器、无 provider、无时钟：now 一律显式注入；不 import 未发布的
//     N/O 实现；除错误类型外零依赖，可独立加载；
//   - 纯只读：不修改任何传入对象（card/opts/policy/params），返回一律新建对象；
//   - reason 优先级 inactive > evergreen > replacement-protected > clock-rollback >
//     too-recent > score-not-below-threshold > eligible，仅最后一种 eligible=true；
//   - 时钟回拨（now < 锚点）：elapsedDays 夹 0，并输出结构化 CLOCK_ROLLBACK 报警；
//     非候选（inactive / evergreen / 承接卡）遇回拨同样报警；
//   - evergreen 免时间衰减：halfLifeDays=null、score=1，但年龄仍按同一锚点计算；
//   - 时间一律规范 UTC ISO 字符串（有限且 new Date(v).toISOString()===v），
//     不猜 Date 对象 / 本地日期 / 数字时间戳；
//   - 公共选项必须是普通对象（Object.prototype 或 null 原型）+ 自有字段：继承字段
//     不作输入、未知键拒绝、policy 自有键显式 undefined 拒绝；查找一律
//     own-property 语义（Object.hasOwn / Set / Map），不存在 truthy/?? 碰撞面；
//   - 字符串必须可无损编码 UTF-8（拒绝孤立代理码元）；
//   - 不泄漏原生 TypeError：一切输入错误统一 SparkStoreError{code:'INVALID_INPUT'}。
//
// 标识符规则与冻结源逐条对齐（scopeId ↔ src/storage/paths.mjs validateScopeId，
// spark id ↔ src/sparks/store.mjs validateSparkId）。与 J 槽 analyze.mjs 同一先例：
// 本地实现以保持「除错误类型外零 import」的纯函数边界，规则以 P0/P2 冻结源为准；
// 复用 validateScopeId 语义前先检查类型（paths.mjs 的 toLowerCase 先于 typeof 检查，
// 非字符串会抛原生 TypeError，本模块必须自带类型前置防线）。

import { SparkStoreError } from '../sparks/errors.mjs';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/** 孤立 UTF-16 代理码元无法无损编码为 UTF-8，按契约拒绝（与 storage/fsutil 同规则）。
 *  高代理 0xD800..0xDBFF 未跟低代理、或低代理 0xDC00..0xDFFF 未跟高代理，均为孤立；
 *  低代理区间必须带上 0xDFFF 上界——U+E000..U+FFFF 等合法 BMP 文本不得误拒。 */
function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i += 1; // 合法代理对，跳过低代理
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // 孤立低代理
    }
  }
  return false;
}

/** 协议 JSON 校验：undefined/NaN/Infinity/循环/函数/symbol/bigint/稀疏数组不属于
 *  协议 JSON，一律拒绝；字符串（含对象键）拒绝孤立代理码元（非 lossless UTF-8）。 */
function assertProtocolJson(value, where, seen = new Set()) {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string') {
    if (hasLoneSurrogate(value)) {
      throw invalidInput(`${where} 含孤立 UTF-16 代理码元，无法无损编码为 UTF-8`, { where });
    }
    return;
  }
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw invalidInput(`${where} 含非有限数值（NaN/Infinity 不属于协议 JSON）`, { where });
    }
    return;
  }
  if (t === 'boolean') return;
  if (t !== 'object') {
    throw invalidInput(`${where} 含协议 JSON 之外的类型 "${t}"`, { where, type: t });
  }
  if (seen.has(value)) {
    throw invalidInput(`${where} 含循环引用`, { where });
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) {
          throw invalidInput(`${where} 是稀疏数组（索引 ${i} 缺失）`, { where, index: i });
        }
        assertProtocolJson(value[i], `${where}[${i}]`, seen);
      }
    } else {
      if (!isPlainObject(value)) {
        throw invalidInput(`${where} 不是普通对象（类实例/数组以外的宿主对象拒绝）`, { where });
      }
      for (const key of Object.keys(value)) {
        if (hasLoneSurrogate(key)) {
          throw invalidInput(`${where} 的对象键含孤立代理码元，无法无损编码为 UTF-8`, { where });
        }
        assertProtocolJson(value[key], `${where}.${key}`, seen);
      }
    }
  } finally {
    seen.delete(value);
  }
}

// ---------------------------------------------------------------------------
// 错误工厂（与 src/sparks/errors.mjs 的 SparkStoreError 对齐：判定只看 code 字段）
// ---------------------------------------------------------------------------

function invalidInput(message, details) {
  return new SparkStoreError('INVALID_INPUT', message, details);
}

/**
 * 不可信值的安全描述：只输出类型名，数值单独用 String 格式化（String(number)
 * 永不调用输入的 toString/valueOf）。用于错误文案与 details，杜绝
 * `${不可信值}` 插值在构造业务错误前触发原生 TypeError
 * （如 toString 非函数的对象 / null 原型对象 / Symbol）。
 */
function describeValue(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return String(v);
  return typeof v;
}

// ---------------------------------------------------------------------------
// 标识符校验（与冻结源逐条对齐；类型先行，杜绝原生 TypeError）
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
const FORBIDDEN_CHARS = new Set([...`<>:"/\\|?*`]);

function rejectPerChar(kind, value) {
  // for...of 按码点迭代：合法代理对（非 BMP 字符）不会落入孤立代理区间
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw invalidInput(`${kind} 含孤立代理码元（U+${cp.toString(16).toUpperCase()}）`, { kind });
    }
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      throw invalidInput(`${kind} 含控制字符（U+${cp.toString(16).toUpperCase().padStart(4, '0')}）`, { kind });
    }
    if (FORBIDDEN_CHARS.has(ch)) {
      throw invalidInput(`${kind} 含 Windows 禁用文件名字符 "${ch}"`, { kind });
    }
  }
}

/** scopeId 规则与冻结 storage/paths.mjs validateScopeId 对齐；typeof 先行。 */
function validateScopeId(scopeId) {
  if (scopeId === 'global') return scopeId;
  if (typeof scopeId !== 'string' || scopeId.length === 0) {
    throw invalidInput(`scopeId 必须是非空字符串，得到 ${scopeId === null ? 'null' : typeof scopeId}`);
  }
  if (scopeId.toLowerCase() === 'global') {
    throw invalidInput(`scopeId "${scopeId}" 与共享作用域 global 大小写互斥（Windows 目录不区分大小写）`);
  }
  if (scopeId.length > 128) {
    throw invalidInput(`scopeId 超 128 UTF16（实际 ${scopeId.length}）`);
  }
  if (scopeId !== scopeId.trim()) {
    throw invalidInput('scopeId 不得以空白开头或结尾');
  }
  rejectPerChar('scopeId', scopeId);
  if (scopeId.endsWith(' ') || scopeId.endsWith('.')) {
    throw invalidInput('scopeId 不得以空格或点结尾（Windows 语义）');
  }
  const firstSegment = scopeId.split('.')[0].replace(/[. ]+$/, '').toUpperCase();
  if (WINDOWS_RESERVED.has(firstSegment)) {
    throw invalidInput(`scopeId "${scopeId}" 与 Windows 保留设备名冲突`);
  }
  return scopeId;
}

/** 卡 id 规则与冻结 src/sparks/store.mjs validateSparkId 对齐。 */
function validateCardId(id, field) {
  if (typeof id !== 'string' || id.length === 0) {
    throw invalidInput(`${field} 必须是非空字符串`);
  }
  if (id.length > 64) {
    throw invalidInput(`${field} 超 64 UTF-16（实际 ${id.length}）`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw invalidInput(`${field} 只允许字母/数字/点/下划线/连字符且以字母数字开头`, { value: id });
  }
  if (id.endsWith('.')) {
    throw invalidInput(`${field} 不得以点结尾（Windows 语义）`, { value: id });
  }
  if (id === '__proto__' || id === 'prototype' || id === 'constructor') {
    throw invalidInput(`${field} 与对象键保留名冲突`, { value: id });
  }
  const stem = id.replace(/\.[A-Za-z0-9_-]+$/, '').toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) {
    throw invalidInput(`${field} 与 Windows 保留设备名冲突`, { value: id });
  }
  return id;
}

// ---------------------------------------------------------------------------
// 规范时间校验（§1：有限且 new Date(v).toISOString() === v）
// ---------------------------------------------------------------------------

function validateCanonicalIso(value, field) {
  if (typeof value !== 'string') {
    throw invalidInput(`${field} 必须是字符串，得到 ${value === null ? 'null' : typeof value}`);
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw invalidInput(`${field} 不是可解析的有限时间（须规范 UTC ISO，如 2026-10-25T00:00:00.000Z）`, { field });
  }
  if (new Date(ms).toISOString() !== value) {
    throw invalidInput(`${field} 必须是规范 UTC ISO 字符串（要求 new Date(v).toISOString()===v，如 2026-10-25T00:00:00.000Z）`, { field, value });
  }
  return value;
}

// ---------------------------------------------------------------------------
// 遗忘策略（§1：默认恰好三字段；部分覆盖补默认；严格区间）
// ---------------------------------------------------------------------------

export const DEFAULT_FORGET_POLICY = Object.freeze({
  baseHalfLifeDays: 30,
  maxHalfLifeDays: 240,
  archiveScore: 0.25,
});

const POLICY_FIELDS = Object.freeze(['baseHalfLifeDays', 'maxHalfLifeDays', 'archiveScore']);

function requireFiniteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    const shown = typeof value === 'number' ? String(value) : (value === null ? 'null' : typeof value);
    throw invalidInput(`policy.${field} 必须是有限数值（拒绝 NaN/Infinity/非数值），得到 ${shown}`, { field });
  }
  return value;
}

/**
 * 规范化遗忘策略：部分覆盖 + 默认补全，返回**独立**的完整三字段普通对象。
 * 规则（§1）：policy 必须是普通对象；未知键拒绝；自有键显式 undefined 拒绝；
 * base 为有限数 [1,365]；max 为有限数 [base,3650]；archiveScore 为有限数 (0,1) 开区间。
 * 返回值是全新对象（与 DEFAULT_FORGET_POLICY 及历次返回互不共享）。
 */
export function normalizeForgetPolicy(policy = {}) {
  if (!isPlainObject(policy)) {
    throw invalidInput(`policy 必须是普通对象（Object.prototype 或 null 原型），得到 ${policy === null ? 'null' : typeof policy}`);
  }
  for (const key of Object.keys(policy)) {
    if (!POLICY_FIELDS.includes(key)) {
      throw invalidInput(`policy 含未知键 "${key}"（只允许 ${POLICY_FIELDS.join('/')}）`, { key });
    }
    if (policy[key] === undefined) {
      throw invalidInput(`policy.${key} 自有键显式 undefined 必须拒绝（不提供请省略该键）`, { key });
    }
  }
  const base = Object.hasOwn(policy, 'baseHalfLifeDays')
    ? policy.baseHalfLifeDays
    : DEFAULT_FORGET_POLICY.baseHalfLifeDays;
  const max = Object.hasOwn(policy, 'maxHalfLifeDays')
    ? policy.maxHalfLifeDays
    : DEFAULT_FORGET_POLICY.maxHalfLifeDays;
  const archiveScore = Object.hasOwn(policy, 'archiveScore')
    ? policy.archiveScore
    : DEFAULT_FORGET_POLICY.archiveScore;

  requireFiniteNumber(base, 'baseHalfLifeDays');
  if (base < 1 || base > 365) {
    throw invalidInput(`policy.baseHalfLifeDays 必须在 [1,365]（实际 ${base}）`, { baseHalfLifeDays: base });
  }
  requireFiniteNumber(max, 'maxHalfLifeDays');
  if (max < base || max > 3650) {
    throw invalidInput(`policy.maxHalfLifeDays 必须在 [base,3650]（base=${base}，实际 ${max}）`, { maxHalfLifeDays: max, baseHalfLifeDays: base });
  }
  requireFiniteNumber(archiveScore, 'archiveScore');
  if (archiveScore <= 0 || archiveScore >= 1) {
    throw invalidInput(`policy.archiveScore 必须在开区间 (0,1)（实际 ${archiveScore}）`, { archiveScore });
  }
  return {
    baseHalfLifeDays: base,
    maxHalfLifeDays: max,
    archiveScore,
  };
}

// ---------------------------------------------------------------------------
// 卡记录校验（§2：至少九个必需自有字段；可含完整卡其他字段）
// ---------------------------------------------------------------------------

const VITALITIES = new Set(['evergreen', 'ephemeral']);
const CARD_STATES = new Set(['active', 'archived', 'superseded', 'merged']);

// §2 必需自有字段（继承字段不作输入）
const REQUIRED_CARD_FIELDS = Object.freeze([
  'id', 'scopeId', 'revision', 'state', 'vitality',
  'createdAt', 'lastUsedAt', 'useCount', 'supersedes',
]);
// 冻结 store 能产生的完整卡其余字段（buildCard 全集 + merged 卡 mergedInto/mergedAt）
const OPTIONAL_CARD_FIELDS = new Set([
  'title', 'summary', 'content', 'triggers', 'entities', 'links',
  'updatedAt', 'archivedAt', 'supersededBy', 'hitCount', 'lastHitAt',
  'mergedInto', 'mergedAt',
]);

/**
 * 校验单卡并返回只读评估视图（只提取九个参与计算的字段，绝不写回输入）。
 * 可选字段在场时做轻量类型校验（完整业务长度校验属冻结 store 的职责，
 * 本模块只消费它能产生的形状）。
 */
function validateDecayCard(card, at) {
  if (!isPlainObject(card)) {
    throw invalidInput(`${at} 必须是普通对象（完整卡或至少含九个必需自有字段），得到 ${card === null ? 'null' : typeof card}`);
  }
  assertProtocolJson(card, at);
  for (const key of Object.keys(card)) {
    if (!OPTIONAL_CARD_FIELDS.has(key) && !REQUIRED_CARD_FIELDS.includes(key)) {
      throw invalidInput(`${at} 含完整卡 schema 之外的字段 "${key}"（冻结 store 无法产生）`, { key });
    }
  }
  for (const field of REQUIRED_CARD_FIELDS) {
    if (!Object.hasOwn(card, field)) {
      throw invalidInput(`${at} 缺少必需自有字段 "${field}"（继承字段不作输入）`, { field });
    }
  }

  const id = validateCardId(card.id, `${at}.id`);
  if (typeof card.scopeId !== 'string') {
    throw invalidInput(`${at}.scopeId 必须是字符串，得到 ${card.scopeId === null ? 'null' : typeof card.scopeId}`, { id });
  }
  validateScopeId(card.scopeId);
  if (!Number.isSafeInteger(card.revision) || card.revision < 1) {
    throw invalidInput(`${at}.revision 必须是 >= 1 的安全整数`, { id, revision: card.revision ?? null });
  }
  if (!CARD_STATES.has(card.state)) {
    throw invalidInput(`${at}.state 必须是 active/archived/superseded/merged 之一`, { id, state: card.state ?? null });
  }
  if (!VITALITIES.has(card.vitality)) {
    throw invalidInput(`${at}.vitality 必须是 evergreen 或 ephemeral`, { id, vitality: card.vitality ?? null });
  }
  validateCanonicalIso(card.createdAt, `${at}.createdAt`);
  if (card.lastUsedAt !== null) {
    validateCanonicalIso(card.lastUsedAt, `${at}.lastUsedAt`);
  }
  if (!Number.isSafeInteger(card.useCount) || card.useCount < 0) {
    throw invalidInput(`${at}.useCount 必须是 >= 0 的安全整数`, { id, useCount: card.useCount ?? null });
  }
  if (card.supersedes !== null) {
    validateCardId(card.supersedes, `${at}.supersedes`);
  }

  // 可选字段轻量校验（在场才查；不扩大契约）
  const optStr = (field) => {
    if (!Object.hasOwn(card, field)) return;
    if (typeof card[field] !== 'string') {
      throw invalidInput(`${at}.${field} 在场时必须是字符串，得到 ${typeof card[field]}`, { id, field });
    }
  };
  const optStrOrNull = (field) => {
    if (!Object.hasOwn(card, field)) return;
    if (card[field] !== null && typeof card[field] !== 'string') {
      throw invalidInput(`${at}.${field} 在场时必须是字符串或 null`, { id, field });
    }
  };
  optStr('title'); optStr('summary'); optStr('content'); optStr('updatedAt');
  optStrOrNull('archivedAt'); optStrOrNull('lastHitAt'); optStrOrNull('supersededBy');
  if (Object.hasOwn(card, 'supersededBy') && card.supersededBy !== null) {
    validateCardId(card.supersededBy, `${at}.supersededBy`);
  }
  if (Object.hasOwn(card, 'hitCount')) {
    if (!Number.isInteger(card.hitCount) || card.hitCount < 0) {
      throw invalidInput(`${at}.hitCount 在场时必须是 >= 0 的整数`, { id, hitCount: card.hitCount ?? null });
    }
  }
  if (Object.hasOwn(card, 'triggers')) {
    const v = card.triggers;
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || t.length === 0)) {
      throw invalidInput(`${at}.triggers 在场时必须是非空字符串数组`, { id });
    }
  }
  if (Object.hasOwn(card, 'entities')) {
    const v = card.entities;
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || t.length === 0)) {
      throw invalidInput(`${at}.entities 在场时必须是非空字符串数组`, { id });
    }
  }
  if (Object.hasOwn(card, 'links')) {
    const v = card.links;
    if (!Array.isArray(v)) {
      throw invalidInput(`${at}.links 在场时必须是 {target, rel} 数组`, { id });
    }
    for (let i = 0; i < v.length; i += 1) {
      const l = v[i];
      if (!isPlainObject(l) || typeof l.target !== 'string' || typeof l.rel !== 'string' || l.rel.length === 0) {
        throw invalidInput(`${at}.links[${i}] 形状损坏（须 {target, rel}）`, { id, index: i });
      }
    }
  }
  if (Object.hasOwn(card, 'mergedInto')) {
    const v = card.mergedInto;
    if (typeof v !== 'string' && !isPlainObject(v)) {
      throw invalidInput(`${at}.mergedInto 在场时必须是字符串 marker 或对象指针`, { id });
    }
  }
  if (Object.hasOwn(card, 'mergedAt')) {
    const v = card.mergedAt;
    if (v !== null && v !== undefined && typeof v !== 'string') {
      throw invalidInput(`${at}.mergedAt 在场时必须是字符串或 null`, { id });
    }
  }

  return {
    id,
    scopeId: card.scopeId,
    revision: card.revision,
    state: card.state,
    vitality: card.vitality,
    createdAt: card.createdAt,
    lastUsedAt: card.lastUsedAt,
    useCount: card.useCount,
    supersedes: card.supersedes,
  };
}

// ---------------------------------------------------------------------------
// 衰减计算（§1 公式 + §2 reason 优先级）
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86400000;
// §1 固定冷却 60 天（毫秒/86400000，不取整）
const MIN_COOLDOWN_DAYS = 60;
// 2**1024 起为 Infinity：大指数先封顶，避免溢出污染中间值
const MAX_SAFE_EXPONENT = 1024;

/** halfLifeDays = min(base * 2**useCount, max)；大指数封顶防溢出（§1）。 */
function computeHalfLifeDays(base, useCount, max) {
  const growth = useCount >= MAX_SAFE_EXPONENT ? Infinity : 2 ** useCount;
  const grown = base * growth; // base 为有限正数、growth 有限或 Infinity：无 NaN 路径
  return grown >= max ? max : grown;
}

/**
 * 单卡评估（输入为已校验视图 + 已规范 policy + 已校验 now）。
 * 返回恰好 {id, revision, elapsedDays, halfLifeDays, score, eligible, reason, alarms}。
 */
function assessCard(view, nowIso, nowMs, policy) {
  const anchorAt = view.lastUsedAt ?? view.createdAt; // lastUsedAt 优先；null 时回落 createdAt
  const rawElapsedMs = nowMs - Date.parse(anchorAt);
  const rollback = rawElapsedMs < 0;
  const elapsedDays = rollback ? 0 : rawElapsedMs / MS_PER_DAY;

  let halfLifeDays = null;
  let score = 1;
  if (view.vitality === 'ephemeral') {
    halfLifeDays = computeHalfLifeDays(policy.baseHalfLifeDays, view.useCount, policy.maxHalfLifeDays);
    score = 2 ** (-elapsedDays / halfLifeDays);
  }

  const alarms = rollback
    ? [{ code: 'CLOCK_ROLLBACK', id: view.id, anchorAt, now: nowIso }]
    : [];

  // reason 优先级（§2）：inactive > evergreen > replacement-protected > clock-rollback
  //   > too-recent > score-not-below-threshold > eligible；仅最后一种 eligible=true。
  let reason;
  if (view.state !== 'active') {
    reason = 'inactive';
  } else if (view.vitality === 'evergreen') {
    reason = 'evergreen';
  } else if (view.supersedes !== null) {
    reason = 'replacement-protected';
  } else if (rollback) {
    reason = 'clock-rollback';
  } else if (elapsedDays < MIN_COOLDOWN_DAYS) {
    reason = 'too-recent';
  } else if (!(score < policy.archiveScore)) {
    reason = 'score-not-below-threshold';
  } else {
    reason = 'eligible';
  }

  return {
    id: view.id,
    revision: view.revision,
    elapsedDays,
    halfLifeDays,
    score,
    eligible: reason === 'eligible',
    reason,
    alarms,
  };
}

// ---------------------------------------------------------------------------
// 公共入口 1：evaluateSparkDecay
// ---------------------------------------------------------------------------

/**
 * 单卡衰减评估（同步纯函数，不修改输入）。
 *
 * @param {object} card 至少含九个必需自有字段的卡记录（可含冻结 store 完整卡的
 *   其余字段；未知字段拒绝）
 * @param {object} opts 恰好 {now, policy}：now 必须显式注入（规范 UTC ISO）；
 *   policy 可选（§1 规则；自有键显式 undefined 拒绝）
 * @returns {{id:string, revision:number, elapsedDays:number, halfLifeDays:number|null,
 *   score:number, eligible:boolean, reason:string, alarms:Array<object>}}
 */
export function evaluateSparkDecay(card, opts) {
  if (!isPlainObject(opts)) {
    throw invalidInput(`evaluateSparkDecay 的第二参数（opts）必须是普通对象 {now, policy}，得到 ${opts === null ? 'null' : typeof opts}`);
  }
  for (const key of Object.keys(opts)) {
    if (key !== 'now' && key !== 'policy') {
      throw invalidInput(`evaluateSparkDecay opts 含未知键 "${key}"（允许：now/policy）`, { key });
    }
  }
  if (!Object.hasOwn(opts, 'now')) {
    throw invalidInput('now 必须显式注入（纯分析不读系统时钟）');
  }
  const now = validateCanonicalIso(opts.now, 'opts.now');
  if (Object.hasOwn(opts, 'policy') && opts.policy === undefined) {
    throw invalidInput('opts.policy 自有键显式 undefined 必须拒绝（不提供请省略该键）');
  }
  const policy = normalizeForgetPolicy(opts.policy);
  const view = validateDecayCard(card, 'card');
  return assessCard(view, now, Date.parse(now), policy);
}

// ---------------------------------------------------------------------------
// 公共入口 2：analyzeForgetting
// ---------------------------------------------------------------------------

const MAX_SPARKS = 10000;
const DEFAULT_LIMIT = 20;

/** §3 Source：恰好 {id, revision, createdAt, lastUsedAt, useCount}，绑定 live 同名字段。 */
function toSource(view) {
  return {
    id: view.id,
    revision: view.revision,
    createdAt: view.createdAt,
    lastUsedAt: view.lastUsedAt,
    useCount: view.useCount,
  };
}

/**
 * scope 批量衰减分析（同步纯函数，只读，不修改输入）。
 *
 * @param {object} params 恰好 {scopeId, sparks, now, policy, limit}
 * @param {string} params.scopeId 显式 scope（不从环境猜测）
 * @param {readonly object[]} params.sparks <= 10000 张卡；id 无重复；全体 scopeId
 *   与入口严格一致（跨 scope 报错）；坏记录整次报错、不静默跳过
 * @param {string} params.now 显式注入的规范 UTC ISO
 * @param {object} [params.policy] §1 规则（可选，默认补全）
 * @param {number} [params.limit=20] 候选上限，整数 1..20
 * @returns {{version:1, kind:'forget-analysis', scopeId, now, policy,
 *   assessments:Array, candidates:Array, alarms:Array, plan:object|null}}
 */
export function analyzeForgetting(params = {}) {
  if (!isPlainObject(params)) {
    throw invalidInput(`analyzeForgetting 参数必须是普通对象，得到 ${params === null ? 'null' : typeof params}`);
  }
  for (const key of Object.keys(params)) {
    if (key !== 'scopeId' && key !== 'sparks' && key !== 'now' && key !== 'policy' && key !== 'limit') {
      throw invalidInput(`analyzeForgetting 含未知选项 "${key}"（允许：scopeId/sparks/now/policy/limit）`, { key });
    }
  }
  if (!Object.hasOwn(params, 'scopeId')) {
    throw invalidInput('scopeId 必须显式提供（不从 cwd/HOME/global 猜测）');
  }
  if (typeof params.scopeId !== 'string') {
    throw invalidInput(`scopeId 必须是字符串，得到 ${params.scopeId === null ? 'null' : typeof params.scopeId}`);
  }
  const scopeId = validateScopeId(params.scopeId);
  if (!Object.hasOwn(params, 'now')) {
    throw invalidInput('now 必须显式注入（纯分析不读系统时钟）');
  }
  const now = validateCanonicalIso(params.now, 'now');
  if (Object.hasOwn(params, 'policy') && params.policy === undefined) {
    throw invalidInput('policy 自有键显式 undefined 必须拒绝（不提供请省略该键）');
  }
  const policy = normalizeForgetPolicy(params.policy);
  if (!Object.hasOwn(params, 'sparks')) {
    throw invalidInput('sparks 必须显式提供（数组，可为空）');
  }
  if (!Array.isArray(params.sparks)) {
    throw invalidInput(`sparks 必须是数组，得到 ${params.sparks === null ? 'null' : typeof params.sparks}`);
  }
  if (params.sparks.length > MAX_SPARKS) {
    throw invalidInput(`sparks 最多 ${MAX_SPARKS} 张卡（实际 ${params.sparks.length}）`, { count: params.sparks.length });
  }
  // limit：显式 undefined 视为未提供（沿用 store hasField 惯例）；policy 除外（§1 特指）
  const limit = (Object.hasOwn(params, 'limit') && params.limit !== undefined)
    ? params.limit
    : DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    // describeValue：对不可信值禁止 ${limit} 直接插值（会调用 toString/valueOf，
    // Symbol/坏 toString 对象在业务错误前触发原生 TypeError），details 同样只留安全描述
    throw invalidInput(`limit 必须是 1..20 的整数（得到 ${describeValue(limit)}）`, { limit: describeValue(limit) });
  }

  // —— 全体先校验（坏记录整次报错，不静默跳过） ——
  const views = [];
  const seenIds = new Set();
  for (let i = 0; i < params.sparks.length; i += 1) {
    const view = validateDecayCard(params.sparks[i], `sparks[${i}]`);
    if (view.scopeId !== scopeId) {
      throw invalidInput(`sparks[${i}].scopeId (${JSON.stringify(view.scopeId)}) 与入口 scopeId (${JSON.stringify(scopeId)}) 不一致，跨 scope 记录拒绝`, { id: view.id });
    }
    if (seenIds.has(view.id)) {
      throw invalidInput(`sparks 存在重复 id "${view.id}"（同 scope id 唯一）`, { id: view.id });
    }
    seenIds.add(view.id);
    views.push(view);
  }

  // —— 逐卡评估 ——
  const nowMs = Date.parse(now);
  const assessments = views
    .map((view) => assessCard(view, now, nowMs, policy))
    .sort((a, b) => byCodepoint(a.id, b.id));

  // alarms 按卡 id 合并（每卡至多一条 CLOCK_ROLLBACK）
  const alarms = assessments
    .flatMap((a) => a.alarms)
    .sort((x, y) => byCodepoint(x.id, y.id));

  // 候选：eligible 卡按 elapsedDays 降序、再 id 升序，取 limit
  const viewById = new Map(views.map((v) => [v.id, v]));
  const eligible = assessments
    .filter((a) => a.eligible)
    .sort((a, b) => (b.elapsedDays - a.elapsedDays) || byCodepoint(a.id, b.id))
    .slice(0, limit);
  const candidates = eligible.map((a) => toSource(viewById.get(a.id)));

  // plan：无候选为 null；否则 §3 完整 Plan，sources 与 candidates 独立 clone、改按 id 排序
  const plan = candidates.length === 0
    ? null
    : {
        version: 1,
        kind: 'archive-ephemeral',
        scopeId,
        now,
        policy: { ...policy },
        sources: candidates
          .map((c) => ({ ...c }))
          .sort((a, b) => byCodepoint(a.id, b.id)),
      };

  return {
    version: 1,
    kind: 'forget-analysis',
    scopeId,
    now,
    policy,
    assessments,
    candidates,
    alarms,
    plan,
  };
}
