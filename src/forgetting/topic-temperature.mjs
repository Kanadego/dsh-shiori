// Shiori 0.5 批次 3 · A 线：阶段 B 温度纯函数模块（0.5-DEV-PLAN §4 / §5 / §6.3）
//
// 职责：把「专题活动账本 + 专题/组元数据 + now + 参数」一次性回放成派生温度，
// 供批次 4 面板回放与批次 5 自动冷却消费。纯函数：零 I/O、零时钟读取、零环境变量、
// 不修改输入；同一输入两次调用深度相等。
//
// 公式（§4.1，全部四则运算 + 指数）：
//   Δt 天     = max(0, (t_now - t_last) / 86400000)（毫秒差除日，不取整）
//   T(t)      = T_last * 2 ** (-Δt / S)
//   S 巩固    = min(Smax, S * (1 + g * (1 - T/100)))，且不低于 S0（updated/read 共用）
//   读加热    = T + alpha * (100 - T)（alpha=0.35）
//   updated   = 先衰减，S 按上式巩固，再 T = max(T, 85)
//   created   = T=100，S=S0（账本尚未产出 created；读取侧兼容未来写入）
//
// canCool 的 archiveOrigin 口径：R7 写的「archiveOrigin !== "manual"」按语义实现为
// 「未人工归档」（!archivedAt）。存储层读取时活跃专题的 archiveOrigin 缺省就是
// "manual"（frontmatter 只对已归档专题写来源），字面比较会让所有活跃专题永远不可冷却。
//
// 分级（R7）：T>=50 active / >=25 cool / >=10 cold / 其余 frozen；阈值走 params
// （restoreT / cooldownT / coldT），默认值即 R7 的 50 / 25 / 10。
//
// 护栏建议字段（R7/R8，字段名本模块自定但有测试）：
//   canCool    = 未时钟回拨 ∧ 非归档 ∧ 非 pinned ∧ retention="historical"
//                ∧ T < cooldownT ∧ 年龄 >= MIN_AGE_DAYS(7 天)；
//   canRestore = 未时钟回拨 ∧ 已归档 ∧ archiveOrigin="auto-inactive" ∧ T >= restoreT。
//   「最小年龄保护期」由任务书 R8 钉死为 7 天常量（MIN_AGE_DAYS），不是 30 天；
//   §5.1 的 30 天观察期（params.minCooldownDays + statsStartedAt）属于批次 5，
//   本模块只把 minCooldownDays 原样保留在默认参数里、不参与 canCool 判定。
//
// 账本语义（与 src/storage/topic-activity.mjs 对齐）：
//   - 事件 at 为规范 UTC ISO 串（也接受有限毫秒数，便于测试）；
//   - 按 at 升序回放，at 相同按输入顺序稳定；at 非法 → 追加 BAD_EVENT 告警并跳过，
//     绝不抛出；任意事件 at > now → CLOCK_ROLLBACK 告警，整体照算但 canCool 全 false；
//   - 事件与专题严格按 (targetScopeId||scopeId, key) 配对：scope 不匹配、只有 key
//     撞上别的 scope、或事件无 scope 而专题有 scope，一律忽略该事件（不跨 scope 兜底）；
//     同一 (effectiveScopeId, key) 出现两条 topic 记录 → INVALID_INPUT（不允许后者
//     静默覆盖前者）；未知 topicKey / 未知 kind 同样忽略，不加热不报错（spark 命中
//     误塞进 topicKey 的脏数据在此自然滤掉）；
//   - read 全局时间窗口去重：同一专题距上次「计入加热的 read」不足 heatWindowHours
//     的重复读取不再加热（也不延长下次窗口，防止连续读把窗口无限续命）；
//   - updated 是最强使用证据：衰减后 T 顶到 85；search_hit / group_list 完全不加热。
//
// 存量种子（§6.3 / R6）：专题一条事件都没有时，按最后内容写入时间折算
//   T0 = 100 * 2 ** (-N / S0)（N = 距 updated 天数；缺 updated 回落 seedFallbackT），
//   reason 固定「存量种子：最后更新于 N 天前，种子 T=x」，面板可直接解释。
//   一旦该专题有事件，就按「updated 折算的基线 + 事件回放」计算，不再走种子口径；
//   有事件但缺 updated 时基线回落 seedFallbackT（默认 50，与 §6.3「缺 updated 回落
//   50」一致，不是 0），并在 reason 里注明基线来源。
//
//
// 组温度（§4.4 / R9）：非空组取活跃非归档成员 T 的最大值；空组或成员全归档时按
//   最近一次 group_list 事件锚点以 S0 衰减（无锚点则 T=null 并写明 reason）；
//   组内有 standing 或 pinned 活跃成员 → 组 canCool=false。

import { SparkStoreError } from '../sparks/errors.mjs';

const DAY_MS = 86400000;

/** 稳定性 S 的下限（天）。方案 §4.1：S ∈ [Smin, Smax]。 */
export const S_MIN_DAYS = 1;

/** 自动冷却最小年龄保护期（天）：created/updated 距今不足 7 天一律 canCool=false。
 *  任务书 R8 明确「别猜成 30」——30 天是 §5.1 的观察期口径（minCooldownDays），
 *  由批次 5 结合 statsStartedAt 判断；本模块只负责这道 7 天最小保护期。 */
export const MIN_AGE_DAYS = 7;

/** 温度分级（由高到低），供批次 4/5 与面板共用同一份常量。 */
export const TIER_VALUES = Object.freeze(['active', 'cool', 'cold', 'frozen']);

/** 默认参数（冻结；调用方只读）。expectedStatsStartedAt 不在本模块消费。 */
export const TEMPERATURE_DEFAULTS = Object.freeze({
  S0: 30,
  Smax: 180,
  alpha: 0.35,
  g: 0.5,
  heatWindowHours: 12,
  minCooldownDays: 30,
  seedFallbackT: 50,
  cooldownT: 25,
  restoreT: 50,
  coldT: 10,
});

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function invalidInput(message, details) {
  return new SparkStoreError('INVALID_INPUT', message, details);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 规范 UTC ISO（与 storage/fsutil.mjs 的 isCanonicalIso 同口径）→ 毫秒；非法返回 null。 */
function isoToMs(value) {
  if (typeof value !== 'string' || !CANONICAL_ISO_RE.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString() === value ? ms : null;
}

function requireIsoMs(value, where) {
  const ms = isoToMs(value);
  if (ms === null) {
    throw invalidInput(`${where} 必须是规范 UTC ISO 时间串（如 "2026-11-21T00:00:00.000Z"）`, { where });
  }
  return ms;
}

/** now：规范 UTC ISO 串或有限毫秒数；其余一律 INVALID_INPUT。 */
function normalizeNow(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidInput('now 必须是有限毫秒数或规范 UTC ISO 串', { now: String(value) });
    return value;
  }
  const ms = isoToMs(value);
  if (ms === null) throw invalidInput('now 必须是有限毫秒数或规范 UTC ISO 串', { nowType: typeof value });
  return ms;
}

/** 事件 at：规范 UTC ISO 串或有限毫秒数 → 毫秒；非法返回 null（由调用方记 BAD_EVENT）。 */
function eventAtToMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return isoToMs(value);
}

function daysBetween(fromMs, toMs) {
  return Math.max(0, (toMs - fromMs) / DAY_MS);
}

function clampTemperature(value) {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** 时间自然冷却：T * 2^(-Δt/S)。S 非法（<=0）时返回 0，避免 NaN 扩散。 */
function decayTemperature(temperature, stabilityDays, elapsedDays) {
  if (!Number.isFinite(temperature) || !Number.isFinite(stabilityDays) || stabilityDays <= 0) return 0;
  if (elapsedDays <= 0) return clampTemperature(temperature);
  return clampTemperature(temperature * 2 ** (-elapsedDays / stabilityDays));
}

/** 间隔巩固：S * (1 + g * (1 - T/100))，封顶 Smax。 */
function consolidateStability(stabilityDays, temperature, g, smax) {
  const next = stabilityDays * (1 + g * (1 - temperature / 100));
  return Math.min(smax, next);
}

/** 窗口 12h 等参数转毫秒。 */
function hoursToMs(hours) {
  return hours * 3600000;
}

/** 稳定性下限：S0 与 S_MIN_DAYS 取大（方案 §4.1 要求 S ∈ [Smin, Smax]）。 */
function stabilityFloor(params) {
  return Math.max(params.S0, S_MIN_DAYS);
}

/** 稳定性上限：不得低于下限（防止 S0 < Smin 的怪参数把区间倒挂）。 */
function stabilityCap(params) {
  return Math.max(params.Smax, stabilityFloor(params));
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return 'NaN';
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

// ---------------------------------------------------------------------------
// 参数规范化
// ---------------------------------------------------------------------------

function normalizeParams(rawParams) {
  if (rawParams === undefined) return { ...TEMPERATURE_DEFAULTS };
  if (!isPlainObject(rawParams)) {
    throw invalidInput('params 必须是普通对象或缺省', { paramsType: typeof rawParams });
  }
  const params = { ...TEMPERATURE_DEFAULTS };
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(rawParams, key) || rawParams[key] === undefined) continue;
    const value = rawParams[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidInput(`params.${key} 必须是有限数值`, { key, valueType: typeof value });
    }
    params[key] = value;
  }
  // 未知键忽略（前向兼容：批次 4/5 可能在同一 params 对象里塞自己的字段）。
  if (!(params.S0 > 0)) throw invalidInput('params.S0 必须大于 0', { S0: params.S0 });
  if (!(params.Smax >= params.S0)) {
    throw invalidInput('params.Smax 必须不小于 params.S0', { Smax: params.Smax, S0: params.S0 });
  }
  if (!(params.alpha >= 0 && params.alpha <= 1)) {
    throw invalidInput('params.alpha 必须落在 [0, 1]', { alpha: params.alpha });
  }
  if (!(params.g >= 0)) throw invalidInput('params.g 必须不小于 0', { g: params.g });
  if (!(params.heatWindowHours >= 0)) {
    throw invalidInput('params.heatWindowHours 必须不小于 0', { heatWindowHours: params.heatWindowHours });
  }
  if (!(params.minCooldownDays >= 0)) {
    throw invalidInput('params.minCooldownDays 必须不小于 0', { minCooldownDays: params.minCooldownDays });
  }
  if (!(params.seedFallbackT >= 0 && params.seedFallbackT <= 100)) {
    throw invalidInput('params.seedFallbackT 必须落在 [0, 100]', { seedFallbackT: params.seedFallbackT });
  }
  if (!(params.coldT >= 0 && params.coldT <= params.cooldownT
    && params.cooldownT <= params.restoreT && params.restoreT <= 100)) {
    throw invalidInput('params 的温度阈值必须满足 0 <= coldT <= cooldownT <= restoreT <= 100', {
      coldT: params.coldT, cooldownT: params.cooldownT, restoreT: params.restoreT,
    });
  }
  return params;
}

/** 温度分级（R7 默认 50 / 25 / 10，可由 params 覆盖阈值）。T 必须有限。 */
export function tierForTemperature(temperature, params) {
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
    throw invalidInput('temperature 必须是有限数值', { temperatureType: typeof temperature });
  }
  const resolved = params === undefined ? TEMPERATURE_DEFAULTS : { ...TEMPERATURE_DEFAULTS, ...params };
  if (temperature >= resolved.restoreT) return 'active';
  if (temperature >= resolved.cooldownT) return 'cool';
  if (temperature >= resolved.coldT) return 'cold';
  return 'frozen';
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

function parseTopicEntry(raw, index) {
  if (!isPlainObject(raw)) throw invalidInput(`topics[${index}] 必须是普通对象`, { index });
  const key = raw.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw invalidInput(`topics[${index}].key 必须是非空字符串`, { index });
  }
  const scopeId = raw.scopeId;
  if (scopeId !== undefined && (typeof scopeId !== 'string' || scopeId.length === 0)) {
    throw invalidInput(`topics[${index}].scopeId 必须是非空字符串或缺省`, { index });
  }
  const targetScopeId = raw.targetScopeId;
  if (targetScopeId !== undefined && (typeof targetScopeId !== 'string' || targetScopeId.length === 0)) {
    throw invalidInput(`topics[${index}].targetScopeId 必须是非空字符串或缺省`, { index });
  }
  const updatedMs = raw.updated === undefined ? null : requireIsoMs(raw.updated, `topics[${index}].updated`);
  const createdAtMs = raw.createdAt === undefined ? null : requireIsoMs(raw.createdAt, `topics[${index}].createdAt`);
  const archivedAtMs = raw.archivedAt === undefined ? null : requireIsoMs(raw.archivedAt, `topics[${index}].archivedAt`);
  if (raw.pinned !== undefined && typeof raw.pinned !== 'boolean') {
    throw invalidInput(`topics[${index}].pinned 必须是布尔值或缺省`, { index });
  }
  if (raw.retention !== undefined && raw.retention !== 'standing' && raw.retention !== 'historical') {
    throw invalidInput(`topics[${index}].retention 必须是 "standing" | "historical" 或缺省`, { index });
  }
  if (raw.archiveOrigin !== undefined && raw.archiveOrigin !== 'manual' && raw.archiveOrigin !== 'auto-inactive') {
    throw invalidInput(`topics[${index}].archiveOrigin 必须是 "manual" | "auto-inactive" 或缺省`, { index });
  }
  let groupKeys = [];
  if (raw.group !== undefined) {
    if (typeof raw.group === 'string') {
      if (raw.group.length === 0) throw invalidInput(`topics[${index}].group 不能是空字符串`, { index });
      groupKeys = [raw.group];
    } else if (Array.isArray(raw.group)) {
      groupKeys = raw.group.map((item, position) => {
        if (typeof item !== 'string' || item.length === 0) {
          throw invalidInput(`topics[${index}].group[${position}] 必须是非空字符串`, { index, position });
        }
        return item;
      });
    } else {
      throw invalidInput(`topics[${index}].group 必须是字符串、字符串数组或缺省`, { index });
    }
  }
  const effectiveScopeId = targetScopeId ?? scopeId ?? null;
  return {
    index,
    key,
    scopeId: scopeId ?? null,
    targetScopeId: targetScopeId ?? null,
    effectiveScopeId,
    updatedMs,
    createdAtMs,
    archivedAtMs,
    pinned: raw.pinned === true,
    retention: raw.retention,
    archiveOrigin: raw.archiveOrigin,
    groupKeys,
    // 派生状态
    temperature: null,
    stability: null,
    lastStateMs: null,
    lastHeatedAt: null,
    lastCountedReadMs: null,
    lastUpdatedEventMs: null,
    lastCreatedEventMs: null,
    hasEvent: false,
    baselineFromUpdated: false,
    baselineFromFallback: false,
    counts: { created: 0, updated: 0, read: 0, skippedReads: 0 },
    searchHits: 0,
    reason: '',
    effectiveRetention: 'standing',
  };
}

function parseGroupEntry(raw, index) {
  if (!isPlainObject(raw)) throw invalidInput(`groups[${index}] 必须是普通对象`, { index });
  const key = raw.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw invalidInput(`groups[${index}].key 必须是非空字符串`, { index });
  }
  if (raw.scopeId !== undefined && (typeof raw.scopeId !== 'string' || raw.scopeId.length === 0)) {
    throw invalidInput(`groups[${index}].scopeId 必须是非空字符串或缺省`, { index });
  }
  if (raw.retention !== undefined && raw.retention !== 'standing' && raw.retention !== 'historical') {
    throw invalidInput(`groups[${index}].retention 必须是 "standing" | "historical" 或缺省`, { index });
  }
  const archivedAtMs = raw.archivedAt === undefined ? null : requireIsoMs(raw.archivedAt, `groups[${index}].archivedAt`);
  let members = null;
  if (raw.members !== undefined) {
    if (!Array.isArray(raw.members)) throw invalidInput(`groups[${index}].members 必须是数组或缺省`, { index });
    members = raw.members.map((member, position) => {
      if (!isPlainObject(member)) {
        throw invalidInput(`groups[${index}].members[${position}] 必须是普通对象`, { index, position });
      }
      if (typeof member.key !== 'string' || member.key.length === 0) {
        throw invalidInput(`groups[${index}].members[${position}].key 必须是非空字符串`, { index, position });
      }
      if (member.archived !== undefined && typeof member.archived !== 'boolean') {
        throw invalidInput(`groups[${index}].members[${position}].archived 必须是布尔值或缺省`, { index, position });
      }
      if (member.pinned !== undefined && typeof member.pinned !== 'boolean') {
        throw invalidInput(`groups[${index}].members[${position}].pinned 必须是布尔值或缺省`, { index, position });
      }
      if (member.retention !== undefined && member.retention !== 'standing' && member.retention !== 'historical') {
        throw invalidInput(`groups[${index}].members[${position}].retention 必须是枚举或缺省`, { index, position });
      }
      return {
        key: member.key,
        scopeId: typeof member.scopeId === 'string' && member.scopeId.length > 0 ? member.scopeId : null,
        archived: member.archived,
        pinned: member.pinned,
        retention: member.retention,
      };
    });
  }
  return {
    index,
    key,
    scopeId: raw.scopeId ?? null,
    retention: raw.retention,
    archivedAtMs,
    members,
  };
}

// ---------------------------------------------------------------------------
// 主题回放
// ---------------------------------------------------------------------------

/** 事件 → 专题：只认严格 (effectiveScopeId, key)，不做跨 scope / 仅 key 兜底。 */
function findTopicRecord(context, scopeId, key) {
  const scope = scopeId === null || scopeId === undefined ? '' : scopeId;
  const found = context.byScopeAndKey.get(scope + '\u0000' + key);
  return found === undefined ? null : found;
}

/** 组成员 → 专题：成员清单没有 scope 字段（契约 members:[{key,...}]），因此先用
 *  组/成员的 scope 精确匹配，再回落到无 scope 记录，最后按 key 取第一条——组温度
 *  是「这个组里的成员」的聚合，允许在组所属 scope 上下文中宽松解析。 */
function findGroupMemberRecord(context, group, member) {
  const scopeId = member.scopeId ?? group.scopeId ?? null;
  if (scopeId !== null) {
    const scoped = context.byScopeAndKey.get(scopeId + '\u0000' + member.key);
    if (scoped !== undefined) return scoped;
  }
  const unscoped = context.byScopeAndKey.get('\u0000' + member.key);
  if (unscoped !== undefined) return unscoped;
  const bucket = context.byKey.get(member.key);
  return bucket && bucket.length > 0 ? bucket[0] : null;
}

function initBaseline(record, atMs, params) {
  if (record.temperature !== null) return;
  record.stability = stabilityFloor(params);
  if (record.updatedMs !== null) {
    record.temperature = decayTemperature(100, stabilityFloor(params), daysBetween(record.updatedMs, atMs));
    record.baselineFromUpdated = true;
  } else {
    // R3 / §6.3：有事件但缺 updated —— 基线回落 seedFallbackT（默认 50），不是 0。
    record.temperature = clampTemperature(params.seedFallbackT);
    record.baselineFromFallback = true;
  }
  record.lastStateMs = atMs;
}

function applyEvent(record, event, params) {
  const atMs = event.atMs;
  if (event.kind === 'created') {
    record.temperature = 100;
    record.stability = stabilityFloor(params);
    record.lastStateMs = atMs;
    record.lastCreatedEventMs = atMs;
    record.lastHeatedAt = event.atIso;
    record.hasEvent = true;
    record.counts.created += 1;
    return;
  }
  if (event.kind === 'updated' || event.kind === 'read') {
    initBaseline(record, atMs, params);
    const elapsed = daysBetween(record.lastStateMs, atMs);
    record.temperature = decayTemperature(record.temperature, record.stability, elapsed);
    record.lastStateMs = atMs;
    if (event.kind === 'updated') {
      record.stability = Math.max(
        stabilityFloor(params),
        Math.min(stabilityCap(params), consolidateStability(record.stability, record.temperature, params.g, stabilityCap(params))),
      );
      record.temperature = Math.max(record.temperature, 85);
      record.lastUpdatedEventMs = atMs;
      record.lastHeatedAt = event.atIso;
      record.hasEvent = true;
      record.counts.updated += 1;
      return;
    }
    // read：全局时间窗口去重——距上次计入加热的读取不足 heatWindowHours 只算一次。
    const windowMs = hoursToMs(params.heatWindowHours);
    if (record.lastCountedReadMs !== null && atMs - record.lastCountedReadMs < windowMs) {
      record.hasEvent = true;
      record.counts.skippedReads += 1;
      return;
    }
    record.stability = Math.max(
      stabilityFloor(params),
      Math.min(stabilityCap(params), consolidateStability(record.stability, record.temperature, params.g, stabilityCap(params))),
    );
    record.temperature = record.temperature + params.alpha * (100 - record.temperature);
    record.lastCountedReadMs = atMs;
    record.lastHeatedAt = event.atIso;
    record.hasEvent = true;
    record.counts.read += 1;
    return;
  }
  if (event.kind === 'search_hit') {
    record.searchHits += 1;
    return;
  }
  // group_list / 未知 kind：不加热（R5 / R11）。
}

function finalizeTopic(record, nowMs, params) {
  if (!record.hasEvent) {
    if (record.updatedMs !== null) {
      const elapsedDays = daysBetween(record.updatedMs, nowMs);
      record.temperature = decayTemperature(100, stabilityFloor(params), elapsedDays);
      record.stability = stabilityFloor(params);
      record.lastHeatedAt = null;
      record.reason = `存量种子：最后更新于 ${formatNumber(Math.round(elapsedDays))} 天前，种子 T=${formatNumber(record.temperature)}`;
    } else {
      record.temperature = clampTemperature(params.seedFallbackT);
      record.stability = stabilityFloor(params);
      record.lastHeatedAt = null;
      record.reason = `存量种子：缺少最后更新时间，回落 seedFallbackT=${formatNumber(params.seedFallbackT)}（种子 T=${formatNumber(record.temperature)}）`;
    }
    return;
  }
  const elapsedDays = daysBetween(record.lastStateMs, nowMs);
  record.temperature = decayTemperature(record.temperature, record.stability, elapsedDays);
  const parts = [];
  if (record.baselineFromUpdated) parts.push('基线按最后更新折算');
  if (record.baselineFromFallback) parts.push('基线按 seedFallbackT=' + formatNumber(params.seedFallbackT) + ' 折算');
  parts.push(`账本回放：created ${record.counts.created} / updated ${record.counts.updated} / read ${record.counts.read}`);
  if (record.counts.skippedReads > 0) parts.push(`窗口内跳过 ${record.counts.skippedReads} 次读取`);
  if (record.searchHits > 0) parts.push(`搜索曝光 ${record.searchHits} 次（不加热）`);
  record.reason = parts.join('；');
}

function effectiveRetentionFor(record, context) {
  if (record.retention !== undefined) return record.retention;
  for (const groupKey of record.groupKeys) {
    const group = context.groupByKey.get(groupKey);
    if (group && group.retention !== undefined) return group.retention;
  }
  return 'standing';
}

function ageDaysFor(record, nowMs) {
  const anchors = [];
  if (record.updatedMs !== null) anchors.push(record.updatedMs);
  if (record.createdAtMs !== null) anchors.push(record.createdAtMs);
  if (record.lastUpdatedEventMs !== null) anchors.push(record.lastUpdatedEventMs);
  if (record.lastCreatedEventMs !== null) anchors.push(record.lastCreatedEventMs);
  if (anchors.length === 0) return null;
  const anchor = Math.max(...anchors);
  return daysBetween(anchor, nowMs);
}

function buildTopicOutput(record, nowMs, params, clockRollback) {
  const archived = record.archivedAtMs !== null;
  const ageDays = ageDaysFor(record, nowMs);
  const canCool = !clockRollback
    && !archived
    && !record.pinned
    && record.effectiveRetention === 'historical'
    && record.temperature < params.cooldownT
    && ageDays !== null
    && ageDays >= MIN_AGE_DAYS;
  const canRestore = !clockRollback
    && archived
    && record.archiveOrigin === 'auto-inactive'
    && record.temperature >= params.restoreT;
  return {
    key: record.key,
    scopeId: record.scopeId,
    targetScopeId: record.targetScopeId,
    effectiveScopeId: record.effectiveScopeId,
    T: record.temperature,
    S: record.stability,
    tier: tierForTemperature(record.temperature, params),
    lastHeatedAt: record.lastHeatedAt,
    retention: record.effectiveRetention,
    archived,
    pinned: record.pinned,
    ageDays,
    canCool,
    canRestore,
    searchHits: record.searchHits,
    reason: record.reason,
    alarms: clockRollback ? [{ code: 'CLOCK_ROLLBACK' }] : [],
  };
}

// ---------------------------------------------------------------------------
// 组温度
// ---------------------------------------------------------------------------

function groupMembers(group, context) {
  if (group.members !== null) return group.members;
  const members = [];
  for (const record of context.records) {
    if (!record.groupKeys.includes(group.key)) continue;
    if (group.scopeId !== null && record.effectiveScopeId !== group.scopeId) continue;
    members.push({ key: record.key, scopeId: record.effectiveScopeId, archived: undefined, pinned: undefined, retention: undefined });
  }
  return members;
}

function buildGroupOutput(group, context, nowMs, params, clockRollback) {
  const effectiveRetention = group.retention ?? 'standing';
  const memberEntries = groupMembers(group, context);
  let activeMembers = 0;
  let unknownActiveMembers = 0;
  let maxTemperature = null;
  let hasStandingActive = false;
  let hasPinnedActive = false;
  for (const member of memberEntries) {
    const record = findGroupMemberRecord(context, group, member);
    const archived = member.archived !== undefined
      ? member.archived === true
      : (record !== null && record.archivedAtMs !== null);
    const pinned = member.pinned !== undefined
      ? member.pinned === true
      : (record !== null && record.pinned);
    if (archived) continue;
    activeMembers += 1;
    const retention = member.retention !== undefined
      ? member.retention
      : (record !== null ? record.effectiveRetention : (group.retention ?? 'standing'));
    if (retention === 'standing') hasStandingActive = true;
    if (pinned) hasPinnedActive = true;
    if (record !== null) {
      if (maxTemperature === null || record.temperature > maxTemperature) maxTemperature = record.temperature;
    } else {
      unknownActiveMembers += 1;
    }
  }
  let temperature = maxTemperature;
  let reason;
  if (maxTemperature !== null) {
    reason = `组温取 ${activeMembers} 个活跃成员的最大值（T=${formatNumber(maxTemperature)}）`;
  } else {
    const anyScopeAnchor = context.groupAnchors.get(`\u0000${group.key}`);
    const scopedAnchor = group.scopeId === null
      ? null
      : context.groupAnchors.get(`${group.scopeId}\u0000${group.key}`);
    const effectiveAnchor = scopedAnchor ?? anyScopeAnchor;
    if (effectiveAnchor) {
      const elapsedDays = daysBetween(effectiveAnchor.ms, nowMs);
      temperature = decayTemperature(100, stabilityFloor(params), elapsedDays);
      reason = `${activeMembers > 0 ? '成员温度未知' : '空组'}：按最近目录访问（${formatNumber(Math.round(elapsedDays))} 天前）以 S0 衰减`;
    } else {
      temperature = null;
      reason = activeMembers > 0
        ? `${activeMembers} 个活跃成员温度未知且无目录访问记录，无法折算组温`
        : '空组且无目录访问记录，无法折算组温';
    }
  }
  const canCool = !clockRollback
    && group.archivedAtMs === null
    && effectiveRetention === 'historical'
    && !hasStandingActive
    && !hasPinnedActive
    && temperature !== null
    && temperature < params.cooldownT;
  return {
    key: group.key,
    T: temperature,
    tier: temperature === null ? null : tierForTemperature(temperature, params),
    retention: effectiveRetention,
    activeMembers,
    unknownActiveMembers,
    canCool,
    reason,
    alarms: clockRollback ? [{ code: 'CLOCK_ROLLBACK' }] : [],
  };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 回放专题活动账本，输出派生温度（同步纯函数）。
 *
 * @param {object} input
 * @param {Array<object>} input.topics 专题元数据（至少 { key, scopeId?, targetScopeId?, updated?,
 *   retention?, archiveOrigin?, archivedAt?, pinned?, group? }）
 * @param {Array<object>} [input.groups] 组元数据（{ key, retention?, archivedAt?, members? }）
 * @param {Array<object>} [input.events] topic-activity 账本事件（{ at, scopeId, kind, topicKey?, groupKey? }）
 * @param {string|number} input.now 规范 UTC ISO 串或毫秒数
 * @param {object} [input.params] 公式参数覆盖（默认 TEMPERATURE_DEFAULTS）
 * @returns {{topics: Array<object>, groups: Array<object>, alarms: Array<object>}}
 */
export function evaluateTopics(input) {
  if (!isPlainObject(input)) {
    throw invalidInput('evaluateTopics 的入参必须是普通对象');
  }
  if (!Array.isArray(input.topics)) {
    throw invalidInput('topics 必须是数组');
  }
  if (input.events !== undefined && !Array.isArray(input.events)) {
    throw invalidInput('events 必须是数组或缺省');
  }
  if (input.groups !== undefined && !Array.isArray(input.groups)) {
    throw invalidInput('groups 必须是数组或缺省');
  }
  const params = normalizeParams(input.params);
  const nowMs = normalizeNow(input.now);

  const records = input.topics.map((raw, index) => parseTopicEntry(raw, index));
  const groups = (input.groups ?? []).map((raw, index) => parseGroupEntry(raw, index));

  const context = {
    records,
    byScopeAndKey: new Map(),
    byKey: new Map(),
    groupByKey: new Map(),
    groupAnchors: new Map(),
  };
  for (const record of records) {
    const scope = record.effectiveScopeId === null ? '' : record.effectiveScopeId;
    const identity = scope + '\u0000' + record.key;
    if (context.byScopeAndKey.has(identity)) {
      throw invalidInput('topics 中 (effectiveScopeId, key) 重复："' + (scope === '' ? '(无 scope)' : scope) + '/' + record.key + '"', { scopeId: record.effectiveScopeId, key: record.key });
    }
    context.byScopeAndKey.set(identity, record);
    const bucket = context.byKey.get(record.key);
    if (bucket) bucket.push(record);
    else context.byKey.set(record.key, [record]);
  }
  for (const group of groups) {
    if (context.groupByKey.has(group.key)) {
      throw invalidInput(`groups 中组键重复："${group.key}"`, { key: group.key });
    }
    context.groupByKey.set(group.key, group);
  }

  const alarms = [];
  const parsedEvents = [];
  const rawEvents = input.events ?? [];
  for (let index = 0; index < rawEvents.length; index += 1) {
    const raw = rawEvents[index];
    if (!isPlainObject(raw)) {
      alarms.push({ code: 'BAD_EVENT', at: null });
      continue;
    }
    const atMs = eventAtToMs(raw.at);
    if (atMs === null) {
      alarms.push({ code: 'BAD_EVENT', at: raw.at === undefined ? null : raw.at });
      continue;
    }
    if (typeof raw.kind !== 'string' || raw.kind.length === 0) continue; // 未知结构：忽略
    const scopeId = typeof raw.scopeId === 'string' && raw.scopeId.length > 0 ? raw.scopeId : null;
    const topicKey = typeof raw.topicKey === 'string' && raw.topicKey.length > 0 ? raw.topicKey : null;
    const groupKey = typeof raw.groupKey === 'string' && raw.groupKey.length > 0 ? raw.groupKey : null;
    parsedEvents.push({
      index,
      atMs,
      atIso: new Date(atMs).toISOString(),
      kind: raw.kind,
      scopeId,
      topicKey,
      groupKey,
    });
  }
  // 按 at 升序稳定排序（at 相同保留输入顺序）。
  parsedEvents.sort((a, b) => (a.atMs === b.atMs ? a.index - b.index : a.atMs - b.atMs));

  let clockRollback = false;
  for (const event of parsedEvents) {
    if (event.atMs > nowMs) {
      clockRollback = true;
      break;
    }
  }
  if (clockRollback) alarms.push({ code: 'CLOCK_ROLLBACK' });

  for (const event of parsedEvents) {
    if (event.kind === 'group_list') {
      if (event.groupKey === null) continue;
      const anyKey = `\u0000${event.groupKey}`;
      const scopedKey = event.scopeId === null ? null : `${event.scopeId}\u0000${event.groupKey}`;
      const previous = context.groupAnchors.get(anyKey);
      if (!previous || event.atMs >= previous.ms) {
        context.groupAnchors.set(anyKey, { ms: event.atMs, scopeId: event.scopeId });
      }
      if (scopedKey !== null) {
        const previousScoped = context.groupAnchors.get(scopedKey);
        if (!previousScoped || event.atMs >= previousScoped.ms) {
          context.groupAnchors.set(scopedKey, { ms: event.atMs, scopeId: event.scopeId });
        }
      }
      continue;
    }
    if (event.topicKey === null) continue;
    const record = findTopicRecord(context, event.scopeId, event.topicKey);
    if (record === null) continue; // 未知 topicKey：忽略（R11）
    applyEvent(record, event, params);
  }

  for (const record of records) {
    record.effectiveRetention = effectiveRetentionFor(record, context);
    finalizeTopic(record, nowMs, params);
  }

  const topicOutputs = records.map((record) => buildTopicOutput(record, nowMs, params, clockRollback));
  const groupOutputs = groups.map((group) => buildGroupOutput(group, context, nowMs, params, clockRollback));

  return { topics: topicOutputs, groups: groupOutputs, alarms };
}