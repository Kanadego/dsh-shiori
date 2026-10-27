// Shiori P4-EXECUTOR-COLD-SEARCH · 可信遗忘执行门面
// 契约：phase5/collab/CONTRACTS.md §1/§3/§5/§7。
//
// 职责边界：本模块是宿主注入可信依赖（store / authorize / now / policy）后的
// 薄执行层，只做输入验证、首个 await 前的独立 clone、逐次可信授权与执行转发。
// 衰减计算属于 M（src/forgetting/decay.mjs），批量软归档与 operationId 重放
// 持久化属于 N 的 store 提案；本模块不实现二者，也不 import 未提交模块。
// 分析/检索不执行，执行不做分析；不新建 journal / coordinator。
//
// fail-closed 约定（契约 §7）：每次 execute（含底层可重放的尝试）都重新
// authorize 并采样可信 now；now < plan.now 时即使同 operationId 已有持久
// 收据也拒绝且不触碰 store。这是门面的明确限制，不声称所有重试恒重放。

import { validateScopeId, validateOperationId } from '../storage/paths.mjs';
import { SparkStoreError } from '../sparks/errors.mjs';

function err(code, message, details) {
  const e = new SparkStoreError(code, message, details);
  return e;
}

// §1 普通对象：Object.prototype 或 null 原型，非数组。
function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** 规范 UTC ISO：有限且 new Date(v).toISOString() === v。 */
function isCanonicalIso(v) {
  if (typeof v !== 'string') return false;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.toISOString() === v;
}

function checkCanonicalIso(v, field) {
  if (!isCanonicalIso(v)) {
    throw err('INVALID_INPUT', `${field} 必须是规范 UTC ISO 字符串（须满足 new Date(v).toISOString() === v）`, { value: v });
  }
}

// 与 src/sparks/store.mjs 的 validateSparkId 同规则副本（store 不导出该函数；
// 本层先行形状校验，store 侧仍会独立全量校验，双保险）。
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
const RESERVED_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isSparkIdShape(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return false;
  if (id.endsWith('.')) return false;
  if (RESERVED_JSON_KEYS.has(id)) return false;
  const stem = id.replace(/\.[A-Za-z0-9_-]+$/, '').toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// policy 归一化（§1 可信配置；与 M 的 normalizeForgetPolicy 同规则，
// 但独立实现——本模块不 import 未提交的 M）
// ---------------------------------------------------------------------------

const DEFAULT_FORGET_POLICY = Object.freeze({
  baseHalfLifeDays: 30,
  maxHalfLifeDays: 240,
  archiveScore: 0.25,
});

const POLICY_KEYS = new Set(['baseHalfLifeDays', 'maxHalfLifeDays', 'archiveScore']);

function checkPolicyField(v, field, where) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw err('INVALID_INPUT', `${where}.${field} 必须是有限数（拒绝 NaN/Infinity/非数值）`, { value: v });
  }
  if (field === 'baseHalfLifeDays' && (v < 1 || v > 365)) {
    throw err('INVALID_INPUT', `${where}.${field} 必须在 [1,365]`, { value: v });
  }
  if (field === 'maxHalfLifeDays' && (v < 1 || v > 3650)) {
    throw err('INVALID_INPUT', `${where}.${field} 必须在 [1,3650]（下界与 base 的关系另行校验）`, { value: v });
  }
  if (field === 'archiveScore' && (v <= 0 || v >= 1)) {
    throw err('INVALID_INPUT', `${where}.${field} 必须在开区间 (0,1)`, { value: v });
  }
}

/**
 * 归一化 policy：可部分覆盖再补默认；显式 undefined、未知键、NaN/Infinity、
 * 非普通对象一律 INVALID_INPUT。返回独立的冻结三字段对象。
 */
function normalizeTrustedPolicy(policy, where) {
  if (!isPlainObject(policy)) {
    throw err('INVALID_INPUT', `${where} 必须是普通对象（Object.prototype 或 null 原型）`);
  }
  for (const k of Object.keys(policy)) {
    if (!POLICY_KEYS.has(k)) {
      throw err('INVALID_INPUT', `${where} 含未知键 "${k}"（只允许 baseHalfLifeDays/maxHalfLifeDays/archiveScore）`, { key: k });
    }
  }
  for (const k of Object.keys(policy)) {
    if (policy[k] === undefined) {
      throw err('INVALID_INPUT', `${where}.${k} 显式 undefined（省略该键即用默认值）`, { key: k });
    }
  }
  const baseHalfLifeDays = Object.hasOwn(policy, 'baseHalfLifeDays')
    ? policy.baseHalfLifeDays
    : DEFAULT_FORGET_POLICY.baseHalfLifeDays;
  const maxHalfLifeDays = Object.hasOwn(policy, 'maxHalfLifeDays')
    ? policy.maxHalfLifeDays
    : DEFAULT_FORGET_POLICY.maxHalfLifeDays;
  const archiveScore = Object.hasOwn(policy, 'archiveScore')
    ? policy.archiveScore
    : DEFAULT_FORGET_POLICY.archiveScore;
  checkPolicyField(baseHalfLifeDays, 'baseHalfLifeDays', where);
  checkPolicyField(archiveScore, 'archiveScore', where);
  checkPolicyField(maxHalfLifeDays, 'maxHalfLifeDays', where);
  if (maxHalfLifeDays < baseHalfLifeDays) {
    throw err('INVALID_INPUT', `${where}.maxHalfLifeDays 不得小于 baseHalfLifeDays`, {
      baseHalfLifeDays, maxHalfLifeDays,
    });
  }
  return Object.freeze({ baseHalfLifeDays, maxHalfLifeDays, archiveScore });
}

// ---------------------------------------------------------------------------
// archive-ephemeral Plan 完整 schema 校验（§3；N 的 store 侧同规则独立复验）
// ---------------------------------------------------------------------------

const PLAN_KEYS = new Set(['version', 'kind', 'scopeId', 'now', 'policy', 'sources']);
const SOURCE_KEYS = new Set(['id', 'revision', 'createdAt', 'lastUsedAt', 'useCount']);
const SOURCES_MIN = 1;
const SOURCES_MAX = 20;

function assertExactKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw err('INVALID_INPUT', `${where} 含未知键 "${k}"`, { key: k });
    }
  }
  for (const k of allowed) {
    if (!Object.hasOwn(obj, k)) {
      throw err('INVALID_INPUT', `${where} 缺少必需键 "${k}"`, { key: k });
    }
  }
}

/**
 * 键集合校验：只允许 allowed 内的键、required 内的键必须提供；
 * allowed 中其余键（如 now/policy）可选。显式 undefined 交给后续
 * 各字段校验器按"提供了但值非法"处理。
 */
function assertKeySet(obj, allowed, required, where) {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      throw err('INVALID_INPUT', `${where} 含未知键 "${k}"`, { key: k });
    }
  }
  for (const k of required) {
    if (!Object.hasOwn(obj, k)) {
      throw err('INVALID_INPUT', `${where} 缺少必需键 "${k}"`, { key: k });
    }
  }
}

/**
 * 校验 archive-ephemeral Plan 形状与类型（§1/§3），并绑定 scope、
 * 要求 plan.policy 与 factory 规范 policy 精确一致。
 */
function validateArchivePlan(plan, boundScopeId, factoryPolicy) {
  if (!isPlainObject(plan)) {
    throw err('INVALID_INPUT', 'plan 必须是普通对象（Object.prototype 或 null 原型，非数组）');
  }
  assertExactKeys(plan, PLAN_KEYS, 'plan');
  if (plan.version !== 1) {
    throw err('INVALID_INPUT', 'plan.version 必须是 1', { version: plan.version });
  }
  if (plan.kind !== 'archive-ephemeral') {
    throw err('INVALID_INPUT', 'plan.kind 必须是 "archive-ephemeral"', { kind: plan.kind });
  }
  if (typeof plan.scopeId !== 'string') {
    throw err('INVALID_INPUT', 'plan.scopeId 必须是非空字符串', { value: typeof plan.scopeId });
  }
  if (plan.scopeId !== boundScopeId) {
    throw err('INVALID_INPUT', 'plan.scopeId 与执行器绑定的 scope 不一致（scope 由 factory 绑定，不从请求覆盖）', {
      boundScopeId, planScopeId: plan.scopeId,
    });
  }
  checkCanonicalIso(plan.now, 'plan.now');

  // policy：Plan 不接受部分覆盖，必须完整三字段且与 factory 规范值精确一致
  if (!isPlainObject(plan.policy)) {
    throw err('INVALID_INPUT', 'plan.policy 必须是普通对象');
  }
  assertExactKeys(plan.policy, POLICY_KEYS, 'plan.policy');
  for (const k of POLICY_KEYS) checkPolicyField(plan.policy[k], k, 'plan.policy');
  if (plan.policy.maxHalfLifeDays < plan.policy.baseHalfLifeDays) {
    throw err('INVALID_INPUT', 'plan.policy.maxHalfLifeDays 不得小于 baseHalfLifeDays');
  }
  if (
    plan.policy.baseHalfLifeDays !== factoryPolicy.baseHalfLifeDays
    || plan.policy.maxHalfLifeDays !== factoryPolicy.maxHalfLifeDays
    || plan.policy.archiveScore !== factoryPolicy.archiveScore
  ) {
    throw err('INVALID_INPUT', 'plan.policy 与执行器 factory 的规范 policy 不一致（精确相等才可执行；文案不构成授权）', {
      factoryPolicy, planPolicy: plan.policy,
    });
  }

  if (!Array.isArray(plan.sources)) {
    throw err('INVALID_INPUT', 'plan.sources 必须是数组');
  }
  if (plan.sources.length < SOURCES_MIN || plan.sources.length > SOURCES_MAX) {
    throw err('INVALID_INPUT', `plan.sources 数量必须在 ${SOURCES_MIN}..${SOURCES_MAX}（实际 ${plan.sources.length}）`, {
      count: plan.sources.length,
    });
  }
  const seen = new Set();
  for (let i = 0; i < plan.sources.length; i++) {
    const s = plan.sources[i];
    const where = `plan.sources[${i}]`;
    if (!isPlainObject(s)) {
      throw err('INVALID_INPUT', `${where} 必须是普通对象`);
    }
    assertExactKeys(s, SOURCE_KEYS, where);
    if (!isSparkIdShape(s.id)) {
      throw err('INVALID_INPUT', `${where}.id 不是合法 spark id（1..64，字母/数字开头，只允许字母/数字/点/下划线/连字符，不以点结尾，非保留名）`, { value: s.id });
    }
    if (!Number.isSafeInteger(s.revision) || s.revision < 1) {
      throw err('INVALID_INPUT', `${where}.revision 必须是正 safe integer`, { value: s.revision });
    }
    checkCanonicalIso(s.createdAt, `${where}.createdAt`);
    if (s.lastUsedAt !== null) {
      checkCanonicalIso(s.lastUsedAt, `${where}.lastUsedAt（null 或规范 UTC ISO）`);
    }
    if (!Number.isSafeInteger(s.useCount) || s.useCount < 0) {
      throw err('INVALID_INPUT', `${where}.useCount 必须是非负 safe integer`, { value: s.useCount });
    }
    if (seen.has(s.id)) {
      throw err('INVALID_INPUT', `${where} id "${s.id}" 重复（Source 列表 id 唯一）`, { id: s.id });
    }
    seen.add(s.id);
  }
}

// ---------------------------------------------------------------------------
// createForgetExecutor
// ---------------------------------------------------------------------------

/**
 * 创建可信遗忘执行门面。
 *
 * @param {object} options
 * @param {object} options.store     可信 spark store，必须提供 archiveEphemeral 函数
 * @param {string} options.scopeId   绑定 scope；plan.scopeId 必须与其一致，
 *                                   请求无法覆盖（复用 validateScopeId 前先检查类型）
 * @param {function} options.authorize 可信授权判定函数；每次 execute（含重放尝试）
 *                                   都被调用，收到 {kind:'forget-archive',scopeId,
 *                                   plan:独立clone,operationId}，必须严格 === true
 * @param {function} [options.now]   可信时钟，同步函数返回规范 UTC ISO；
 *                                   缺省用 new Date().toISOString()
 * @param {object} [options.policy]  §1 可信 policy 配置，可部分覆盖；缺省用默认三参数
 * @returns {{execute: function}}    execute(plan, {operationId})
 */
export function createForgetExecutor(options) {
  if (!isPlainObject(options)) {
    throw err('INVALID_INPUT', 'createForgetExecutor options 必须是普通对象');
  }
  assertKeySet(options, new Set(['store', 'scopeId', 'authorize', 'now', 'policy']), new Set(['store', 'scopeId', 'authorize']), 'createForgetExecutor options');
  const { store, scopeId, authorize } = options;
  if (store === null || typeof store !== 'object' || typeof store.archiveEphemeral !== 'function') {
    throw err('INVALID_INPUT', 'createForgetExecutor 需要可信 store，且 store.archiveEphemeral 必须是函数');
  }
  // validateScopeId 内部在类型检查前就读 scopeId.toLowerCase()，必须先查类型防原生 TypeError
  if (typeof scopeId !== 'string') {
    throw err('INVALID_INPUT', 'scopeId 必须是非空字符串');
  }
  validateScopeId(scopeId);
  if (typeof authorize !== 'function') {
    throw err('INVALID_INPUT', 'authorize 必须是函数（宿主可信授权判定；缺失即拒绝创建）');
  }
  if (Object.hasOwn(options, 'now')) {
    if (options.now === undefined) {
      throw err('INVALID_INPUT', 'options.now 显式 undefined（省略该键即用默认时钟）');
    }
    if (typeof options.now !== 'function') {
      throw err('INVALID_INPUT', 'options.now 必须是同步函数（返回规范 UTC ISO 字符串）');
    }
  }
  const factoryPolicy = Object.hasOwn(options, 'policy')
    ? normalizeTrustedPolicy(options.policy, 'options.policy')
    : normalizeTrustedPolicy(DEFAULT_FORGET_POLICY, 'DEFAULT_FORGET_POLICY');
  const sampleNow = Object.hasOwn(options, 'now') ? options.now : () => new Date().toISOString();

  /**
   * 执行一次遗忘归档：完整验证 → 首个 await 前独立 clone → 每次尝试
   * （含重放）重新 authorize → 采样可信 now（回拨 fail-closed）→ 只调用
   * 一次 store.archiveEphemeral(独立clone, {operationId, executedAt})，
   * 返回其结果快照的独立 clone；store 抛错原样传播。
   */
  async function execute(plan, opts) {
    // ---- 以下全部同步执行，位于首次 await 之前 ----
    validateArchivePlan(plan, scopeId, factoryPolicy);
    if (!isPlainObject(opts)) {
      throw err('INVALID_INPUT', 'execute opts 必须是普通对象');
    }
    assertExactKeys(opts, new Set(['operationId']), 'execute opts');
    if (opts.operationId === undefined) {
      throw err('INVALID_INPUT', 'execute opts.operationId 显式 undefined');
    }
    validateOperationId(opts.operationId);
    const operationId = opts.operationId;
    const planClone = structuredClone(plan);
    // 授权参数独立 clone：authorize 回调内的任何篡改都到不了执行路径
    const authParams = {
      kind: 'forget-archive',
      scopeId,
      plan: structuredClone(planClone),
      operationId,
    };
    // ---- 每次尝试（含重放）均重新可信授权 ----
    const granted = await authorize(authParams);
    if (granted !== true) {
      throw err('AUTHORIZATION_REQUIRED', 'authorize 未严格返回 === true，拒绝执行遗忘归档', {
        scopeId, operationId,
      });
    }
    // ---- 授权后采样可信时钟；回拨 fail-closed（重放亦不豁免，§7）----
    const executedAt = sampleNow();
    if (!isCanonicalIso(executedAt)) {
      throw err('INVALID_INPUT', '可信 now() 必须返回规范 UTC ISO 字符串（new Date(v).toISOString()===v）', {
        value: executedAt,
      });
    }
    if (new Date(executedAt).getTime() < new Date(planClone.now).getTime()) {
      throw err('INVALID_STATE', '采样时钟早于 plan.now，拒绝执行（门面 fail-closed，底层可重放也不豁免）', {
        operationId, planNow: planClone.now, executedAt,
      });
    }
    // ---- 只调用一次 store；传独立 clone，回调/调用方篡改不影响执行内容 ----
    const receipt = await store.archiveEphemeral(structuredClone(planClone), { operationId, executedAt });
    return structuredClone(receipt);
  }

  return { execute };
}
