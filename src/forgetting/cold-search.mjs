// Shiori P4-EXECUTOR-COLD-SEARCH · 显式只读冷库检索门面
// 只读边界：不自动调用、不写库、不复活卡片、不产附件。
//
// 职责边界：用户显式发起冷库查询的窄门面，只读绑定 scope 的 archived 记录；
// 不自动调用、不写库、不复活/续期、不写统计/反馈，不产生新卡或附件。
// 冷库列表来自 N 提案的 store.listArchived()（仅当前 scope 恰好 archived，
// 不含 active/superseded/merged，无 global fallback）；本模块只做严格选项
// 校验、记录完整性与 scope/状态核验、逐字段字面包含匹配。
//
// 匹配语义：query.trim().toLowerCase() 对 title/summary/content 逐字段、
// triggers/entities 逐元素做字面包含（String.includes），任一命中即匹配；
// 不跨字段/元素拼接，不用正则/代码/路径。truncated 严格为过滤后命中总数
// 超过 limit。不输出正文（content/triggers/entities/links 不出现在结果中）。
//
// 主审 D-1（a1 返工）修复：store 返回的记录是不可信输入——所有读取字符
// 串须可无损 UTF-8 编码（拒绝孤立代理）、数组按索引逐位校验（稀疏洞拒绝）、
// 错误文案只描述类型不序列化值（BigInt 等不得触发原生 TypeError）。

import { validateScopeId } from '../storage/paths.mjs';
import { assertEncodableUtf8 } from '../storage/fsutil.mjs';
import { SparkStoreError } from '../sparks/errors.mjs';

function err(code, message, details) {
  return new SparkStoreError(code, message, details);
}

// §1 普通对象：Object.prototype 或 null 原型，非数组。
function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 规范 UTC ISO：有限且 new Date(v).toISOString() === v。 */
function isCanonicalIso(v) {
  if (typeof v !== 'string') return false;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) && d.toISOString() === v;
}

/**
 * 不可信值的安全描述：只报告类型/长度，绝不把值本身放进错误文案
 * （主审 D-1：JSON.stringify(BigInt) 会抛原生 TypeError、孤立代理会
 * 产出不可编码文案；typeof/length 永不抛错）。
 */
function safeDescribe(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string': return `string(len ${v.length})`;
    case 'number': return Number.isFinite(v) ? `number(${v})` : 'number(非有限)';
    case 'bigint': return 'bigint';
    case 'boolean': return `boolean(${v})`;
    case 'undefined': return 'undefined';
    default: return Array.isArray(v) ? `array(len ${v.length})` : 'object';
  }
}

/**
 * 字符串可无损 UTF-8 编码：不含孤立代理码元（D-1）。
 * store 记录属不可信输入，坏值按 INVALID_STATE 拒绝；这里本地实现而不
 * 复用 fsutil 工具，避免把 store 状态损坏误报成调用方 INVALID_INPUT。
 */
function isLosslessUtf8(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// 与 src/sparks/store.mjs 的 validateSparkId 同规则副本（本层仅形状核验，
// 用于拒绝损坏记录；不是身份分配）。
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

const QUERY_MIN = 1;
const QUERY_MAX = 200;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const DEFAULT_LIMIT = 20;

function assertAllowedKeys(obj, allowedSet, requiredSet, where) {
  for (const k of Object.keys(obj)) {
    if (!allowedSet.has(k)) {
      throw err('INVALID_INPUT', `${where} 含未知键 "${k}"`, { key: k });
    }
  }
  for (const k of requiredSet) {
    if (!Object.hasOwn(obj, k)) {
      throw err('INVALID_INPUT', `${where} 缺少必需键 "${k}"`, { key: k });
    }
  }
}

/**
 * 核验 store.listArchived() 返回的单条记录：必须是本 scope 恰好 archived
 * 的完整卡且具备检索/回显所需的摘要字段；跨 scope、非 archived、摘要字段
 * 损坏一律 INVALID_STATE（store 违反其契约，fail-closed，不静默跳过）。
 *
 * D-1 修复：所有被读取的字符串（输出字段与检索材料）都必须可无损 UTF-8
 * 编码；数组按索引逐位校验（稀疏数组的洞读出 undefined，一并拒绝）；
 * 错误文案只用 safeDescribe 描述不可信值，绝不序列化值本身。
 */
function validateArchivedRecord(record, boundScopeId) {
  if (!isPlainObject(record)) {
    throw err('INVALID_STATE', `冷库记录必须是普通对象（得到 ${safeDescribe(record)}）`);
  }
  if (!isSparkIdShape(record.id)) {
    throw err('INVALID_STATE', `冷库记录 id 不是合法 spark id（${safeDescribe(record.id)}）`);
  }
  const where = `冷库记录 "${record.id}"`; // id 已过形状校验（ASCII 安全）
  if (record.scopeId !== boundScopeId) {
    throw err('INVALID_STATE', `${where} 的 scopeId 不属于本 scope（无 global fallback，跨 scope 记录拒绝）`, {
      boundScopeId, recordScopeId: record.scopeId,
    });
  }
  if (record.state !== 'archived') {
    throw err('INVALID_STATE', `${where} 状态为 ${safeDescribe(record.state)}，只允许恰好 archived（不查 superseded/merged/active）`);
  }
  if (typeof record.title !== 'string') {
    throw err('INVALID_STATE', `${where} title 缺失或非字符串（${safeDescribe(record.title)}）`);
  }
  if (!isLosslessUtf8(record.title)) {
    throw err('INVALID_STATE', `${where} title 含孤立代理码元，不可无损 UTF-8 编码`);
  }
  if (typeof record.summary !== 'string') {
    throw err('INVALID_STATE', `${where} summary 缺失或非字符串（${safeDescribe(record.summary)}）`);
  }
  if (!isLosslessUtf8(record.summary)) {
    throw err('INVALID_STATE', `${where} summary 含孤立代理码元，不可无损 UTF-8 编码`);
  }
  if (!Number.isSafeInteger(record.revision) || record.revision < 1) {
    throw err('INVALID_STATE', `${where} revision 必须是正 safe integer（${safeDescribe(record.revision)}）`);
  }
  if (!isCanonicalIso(record.archivedAt)) {
    throw err('INVALID_STATE', `${where} archivedAt 必须是规范 UTC ISO 字符串（${safeDescribe(record.archivedAt)}）`);
  }
  if (record.content !== undefined) {
    if (typeof record.content !== 'string') {
      throw err('INVALID_STATE', `${where} content 类型损坏（${safeDescribe(record.content)}）`);
    }
    if (!isLosslessUtf8(record.content)) {
      throw err('INVALID_STATE', `${where} content 含孤立代理码元，不可无损 UTF-8 编码`);
    }
  }
  for (const field of ['triggers', 'entities']) {
    const v = record[field];
    if (v !== undefined) {
      if (!Array.isArray(v)) {
        throw err('INVALID_STATE', `${where} ${field} 必须是字符串数组（${safeDescribe(v)}）`);
      }
      // 索引逐位读取：稀疏数组的洞读出 undefined，与非法元素一并拒绝
      for (let i = 0; i < v.length; i++) {
        const w = v[i];
        if (typeof w !== 'string') {
          throw err('INVALID_STATE', `${where} ${field}[${i}] 必须是字符串（${safeDescribe(w)}）`);
        }
        if (!isLosslessUtf8(w)) {
          throw err('INVALID_STATE', `${where} ${field}[${i}] 含孤立代理码元，不可无损 UTF-8 编码`);
        }
      }
    }
  }
}

/** 逐字段/逐元素字面包含；不跨字段拼接。 */
function recordMatches(record, needle) {
  for (const field of ['title', 'summary', 'content']) {
    const v = record[field];
    if (typeof v === 'string' && v.toLowerCase().includes(needle)) return true;
  }
  for (const field of ['triggers', 'entities']) {
    const arr = record[field];
    if (Array.isArray(arr)) {
      for (const w of arr) {
        if (w.toLowerCase().includes(needle)) return true;
      }
    }
  }
  return false;
}

/**
 * 创建显式冷库检索门面。
 *
 * @param {object} options
 * @param {object} options.store   可信 spark store，必须提供 listArchived 函数
 * @param {string} options.scopeId 绑定 scope（复用 validateScopeId 前先检查类型）
 * @returns {{search: function}}   search({query, limit?})，显式调用，不自动触发
 */
export function createColdSearch(options) {
  if (!isPlainObject(options)) {
    throw err('INVALID_INPUT', 'createColdSearch options 必须是普通对象');
  }
  assertAllowedKeys(options, new Set(['store', 'scopeId']), new Set(['store', 'scopeId']), 'createColdSearch options');
  const { store, scopeId } = options;
  if (store === null || typeof store !== 'object' || typeof store.listArchived !== 'function') {
    throw err('INVALID_INPUT', 'createColdSearch 需要可信 store，且 store.listArchived 必须是函数');
  }
  // validateScopeId 内部在类型检查前就读 scopeId.toLowerCase()，必须先查类型防原生 TypeError
  if (typeof scopeId !== 'string') {
    throw err('INVALID_INPUT', 'scopeId 必须是非空字符串');
  }
  validateScopeId(scopeId);

  /**
   * 显式检索冷库：只读，不写库、不复活/续期、不记统计。
   * 返回恰好 {kind:'cold-search', scopeId, query(trim后), items, truncated}；
   * items 恰好 {id,title,summary,revision,state:'archived',archivedAt}，
   * 按 id 排序取 limit；store 抛错原样传播。
   */
  async function search(request) {
    if (!isPlainObject(request)) {
      throw err('INVALID_INPUT', 'search request 必须是普通对象');
    }
    assertAllowedKeys(request, new Set(['query', 'limit']), new Set(['query']), 'search request');
    if (Object.hasOwn(request, 'limit')) {
      if (request.limit === undefined) {
        throw err('INVALID_INPUT', 'search request.limit 显式 undefined（省略该键即用默认值）');
      }
    }
    const limit = Object.hasOwn(request, 'limit') ? request.limit : DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < LIMIT_MIN || limit > LIMIT_MAX) {
      throw err('INVALID_INPUT', `search request.limit 必须是 ${LIMIT_MIN}..${LIMIT_MAX} 整数`, { value: limit });
    }
    if (typeof request.query !== 'string') {
      throw err('INVALID_INPUT', 'search request.query 必须是字符串');
    }
    const query = request.query.trim();
    if (query.length < QUERY_MIN || query.length > QUERY_MAX) {
      throw err('INVALID_INPUT', `search request.query trim 后必须为 ${QUERY_MIN}..${QUERY_MAX} UTF-16（实际 ${query.length}）`, {
        length: query.length,
      });
    }
    assertEncodableUtf8(query, 'search request.query');
    const needle = query.toLowerCase();

    const records = await store.listArchived();
    if (!Array.isArray(records)) {
      throw err('INVALID_STATE', 'store.listArchived() 必须返回数组');
    }
    const hits = [];
    for (const record of records) {
      validateArchivedRecord(record, scopeId);
      if (recordMatches(record, needle)) hits.push(record);
    }
    hits.sort((a, b) => byCodepoint(a.id, b.id));
    // truncated 严格为过滤后命中总数 > limit（截断事实，不是"可能有更多"）
    const truncated = hits.length > limit;
    const items = hits.slice(0, limit).map((r) => ({
      id: r.id,
      title: r.title,
      summary: r.summary,
      revision: r.revision,
      state: 'archived',
      archivedAt: r.archivedAt,
    }));
    return { kind: 'cold-search', scopeId, query, items, truncated };
  }

  return { search };
}
