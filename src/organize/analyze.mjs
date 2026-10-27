// Shiori P3-ORGANIZE · J 槽位：只读机械候选分析（P3-CANDIDATES）
//
// 职责（CONTRACTS §2）：从调用方传入的完整 active 卡记录（store.listActive 快照）
// 同步生成三类整理候选，全程零写入、零副作用：
//   - isolated：active 图（入边+出边均按 active 语义计）中零度的孤立卡；
//   - link：共享规范化实体/触发词、且两卡之间尚无任一方向既有链接的未连接 pair；
//   - cluster：同一 scope 内共享单个实体/触发词、成员 >= 8 张唯一卡的候选组。
//
// 硬边界：
//   - 本模块不 import node:fs / node:path，不打开 store，不写任何数据；
//   - 不修改传入 records（测试以 deep-freeze 夹具证明）；
//   - 不导入宿主/队列/执行器；候选只是建议，不含任何批准或执行语义；
//   - evidence 为确定性协议 JSON：无时间戳、无随机值、无 LLM 建议、无执行请求。
//
// 记录校验（J-2 主审裁定）：records 项必须是冻结 src/sparks/store.mjs 能产生并加载的
// 完整 active 卡——业务字段（id/scopeId/revision/state/title/summary/content/triggers/
// entities/links/vitality）逐一验证类型、枚举与长度边界（LIMITS 与 store 同值）；
// 审计时间字段（createdAt 等）不要求在场（J-2 裁定不扩大契约），在场时只做轻量类型
// 校验；schema 之外的未知字段拒绝。
//
// 确定性（CONTRACTS §1）：所有匹配按 trim+toLowerCase 归一化，去重并按 UTF16 码点
// 二进制序排序；排序先 kind 再 id；digest = SHA256(UTF8 stable({kind, scopeId,
// sources, evidence}))。stable 按 §1 字面公式实现：递归
// JSON.stringify(Object.fromEntries(Object.keys(v).sort().map(...)))，数组顺序保持。
// 相同输入（含 records 任意排列、对象键序差异）必须产出完全相同的候选集。
//
// 协议 JSON 之外（undefined/NaN/Infinity/循环/函数/symbol/bigint/稀疏数组/孤立代理
// 码元）一律 INVALID_INPUT 拒绝，绝不静默替换；对象键同样要求可无损编码 UTF-8。

import { createHash } from 'node:crypto';

import { SparkStoreError } from '../sparks/errors.mjs';

// ---------------------------------------------------------------------------
// 错误工厂（错误形状与 src/sparks/errors.mjs 的 SparkStoreError 对齐）
// ---------------------------------------------------------------------------

function invalidInput(message, details) {
  return new SparkStoreError('INVALID_INPUT', message, details);
}

// ---------------------------------------------------------------------------
// 基础校验规则
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

/**
 * 协议 JSON 校验：undefined/NaN/Infinity/循环/函数/symbol/bigint/稀疏数组
 * 不属于协议 JSON，一律拒绝；字符串（含对象键）另拒绝孤立代理码元（非 lossless UTF-8）。
 */
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

// scopeId 规则与冻结的 storage/paths.mjs validateScopeId（P0 A 语义 ∩ B 物理强化）
// 逐条对齐；本模块刻意本地实现以保持「零 fs import」边界，规则以 P0 冻结源为准。
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
const FORBIDDEN_CHARS = new Set([...`<>:"/\\|?*`]);

function rejectPerChar(kind, value) {
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

function validateScopeId(scopeId) {
  if (scopeId === 'global') return scopeId;
  if (typeof scopeId !== 'string' || scopeId.length === 0) {
    throw invalidInput(`scopeId 必须是非空字符串，得到 ${scopeId === null ? 'null' : typeof scopeId}`);
  }
  if (scopeId.toLowerCase() === 'global') {
    throw invalidInput(`scopeId "${scopeId}" 与共享作用域 global 大小写互斥`);
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

/** 卡 id 规则与冻结 src/sparks/store.mjs validateSparkId 的字符集/保留名约束对齐。 */
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
// 完整 active 卡校验：LIMITS 与冻结 store 同值（J-2 裁定）
// ---------------------------------------------------------------------------

const LIMITS = Object.freeze({
  idChars: 64,
  titleChars: 80,
  summaryChars: 120,
  contentChars: 2000,
  wordChars: 64,
  relChars: 64,
  triggersMax: 32,
  entitiesMax: 32,
  linksMax: 32,
});
const VITALITIES = new Set(['evergreen', 'ephemeral']);

// J 必查的业务字段（J-2 裁定：完整 active card 不是允许缺字段的投影）
const BUSINESS_FIELDS = new Set([
  'id', 'scopeId', 'revision', 'state', 'title', 'summary', 'content',
  'triggers', 'entities', 'links', 'vitality',
]);
// store 卡的系统/审计字段：不要求在场（不扩大契约），在场时只做轻量类型校验
const OPTIONAL_STRING_FIELDS = new Set(['createdAt', 'updatedAt', 'archivedAt', 'lastHitAt', 'lastUsedAt', 'supersedes', 'supersededBy']);
const OPTIONAL_COUNT_FIELDS = new Set(['hitCount', 'useCount']);

function validateStringField(value, field, at, min, max) {
  if (typeof value !== 'string') {
    throw invalidInput(`${at}.${field} 必须是字符串，得到 ${value === null ? 'null' : typeof value}`);
  }
  if (value.length < min || value.length > max) {
    throw invalidInput(`${at}.${field} 长度必须在 ${min}..${max} UTF-16（实际 ${value.length}，与冻结 store 上限一致）`);
  }
  return value;
}

function validateTermArray(value, field, at, maxCount) {
  if (!Array.isArray(value)) {
    throw invalidInput(`${at}.${field} 必须是字符串数组`);
  }
  if (value.length > maxCount) {
    throw invalidInput(`${at}.${field} 最多 ${maxCount} 项（实际 ${value.length}，与冻结 store 一致）`);
  }
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'string') {
      throw invalidInput(`${at}.${field}[${i}] 必须是字符串，得到 ${typeof item}`);
    }
    if (item.length === 0 || item.length > LIMITS.wordChars) {
      throw invalidInput(`${at}.${field}[${i}] 长度必须在 1..${LIMITS.wordChars} UTF-16`);
    }
    if (item.trim() === '') {
      throw invalidInput(`${at}.${field}[${i}] 不得为纯空白（冻结 store 不产生此类词）`);
    }
  }
  return value;
}

function validateLinkArray(value, field, at, selfId, maxCount) {
  if (!Array.isArray(value)) {
    throw invalidInput(`${at}.${field} 必须是 {target, rel} 数组`);
  }
  if (value.length > maxCount) {
    throw invalidInput(`${at}.${field} 最多 ${maxCount} 项（实际 ${value.length}，与冻结 store 一致）`);
  }
  const out = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (!isPlainObject(entry)) {
      throw invalidInput(`${at}.${field}[${i}] 必须是对象`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'target' && key !== 'rel') {
        throw invalidInput(`${at}.${field}[${i}] 只允许 target/rel 字段，未知键 "${key}"`);
      }
    }
    const target = validateCardId(entry.target, `${at}.${field}[${i}].target`);
    if (typeof entry.rel !== 'string' || entry.rel.length === 0 || entry.rel.length > LIMITS.relChars) {
      throw invalidInput(`${at}.${field}[${i}].rel 长度必须在 1..${LIMITS.relChars} UTF-16`);
    }
    if (entry.rel.trim() === '') {
      throw invalidInput(`${at}.${field}[${i}].rel 不得为纯空白`);
    }
    if (target === selfId) {
      throw invalidInput(`${at}.${field}[${i}] 不允许 self-link（冻结 store 拒绝）`, { target });
    }
    out.push({ target, rel: entry.rel });
  }
  return out;
}

function validateRecords(records, scopeId) {
  if (!Array.isArray(records)) {
    throw invalidInput(`records 必须是数组，得到 ${records === null ? 'null' : typeof records}`);
  }
  const seenIds = new Set();
  const out = [];
  for (let i = 0; i < records.length; i += 1) {
    const raw = records[i];
    const at = `records[${i}]`;
    if (!isPlainObject(raw)) {
      throw invalidInput(`${at} 必须是普通对象（完整 active 卡）`);
    }
    assertProtocolJson(raw, at);
    for (const key of Object.keys(raw)) {
      if (!BUSINESS_FIELDS.has(key) && !OPTIONAL_STRING_FIELDS.has(key) && !OPTIONAL_COUNT_FIELDS.has(key)) {
        throw invalidInput(`${at} 含完整 active 卡 schema 之外的字段 "${key}"（冻结 store 无法产生）`, { key });
      }
      if (OPTIONAL_STRING_FIELDS.has(key)) {
        const v = raw[key];
        if (v !== null && typeof v !== 'string') {
          throw invalidInput(`${at}.${key} 必须是字符串或 null，得到 ${typeof v}`);
        }
      }
      if (OPTIONAL_COUNT_FIELDS.has(key)) {
        const v = raw[key];
        if (!Number.isInteger(v) || v < 0) {
          throw invalidInput(`${at}.${key} 必须是 >= 0 的整数`);
        }
      }
    }
    const id = validateCardId(raw.id, `${at}.id`);
    if (seenIds.has(id)) {
      throw invalidInput(`records 存在重复 id "${id}"（同 scope id 唯一）`, { id });
    }
    seenIds.add(id);
    if (raw.scopeId !== scopeId) {
      throw invalidInput(`${at}.scopeId (${JSON.stringify(raw.scopeId)}) 与入口 scopeId (${JSON.stringify(scopeId)}) 不一致，跨 scope 记录拒绝`, { id });
    }
    if (!Number.isInteger(raw.revision) || raw.revision < 1) {
      throw invalidInput(`${at}.revision 必须是 >= 1 的整数`, { id, revision: raw.revision });
    }
    if (raw.state !== 'active') {
      throw invalidInput(`${at}.state 必须是 "active"（候选只来自 active 卡，陈旧/非 active 记录拒绝）`, { id, state: raw.state ?? null });
    }
    validateStringField(raw.title, 'title', at, 1, LIMITS.titleChars);
    validateStringField(raw.summary, 'summary', at, 0, LIMITS.summaryChars);
    validateStringField(raw.content, 'content', at, 1, LIMITS.contentChars);
    if (!VITALITIES.has(raw.vitality)) {
      throw invalidInput(`${at}.vitality 必须是 evergreen 或 ephemeral`, { id, vitality: raw.vitality ?? null });
    }
    out.push({
      id,
      revision: raw.revision,
      entities: validateTermArray(raw.entities, 'entities', at, LIMITS.entitiesMax),
      triggers: validateTermArray(raw.triggers, 'triggers', at, LIMITS.triggersMax),
      links: validateLinkArray(raw.links, 'links', at, id, LIMITS.linksMax),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 归一化与 digest
// ---------------------------------------------------------------------------

/** trim + toLowerCase，去重并按 UTF16 码点二进制序排序。
 *  （完整卡校验已拒绝空/纯空白词；此处忽略空项是归一化层面的防线。） */
function normalizeTerms(terms) {
  const seen = new Set();
  for (const raw of terms) {
    const norm = raw.trim().toLowerCase();
    if (norm.length > 0) seen.add(norm);
  }
  return [...seen].sort(byCodepoint);
}

/** stable(value)，CONTRACTS §1 字面公式：递归对普通对象键
 *  Object.keys(v).sort() 后 Object.fromEntries 重建，再 JSON.stringify；数组顺序保持。
 *  输入已通过 assertProtocolJson，序列化不存在静默替换路径。 */
function toSorted(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toSorted);
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, toSorted(value[k])]));
}
const stable = (value) => JSON.stringify(toSorted(value));

/** digest = SHA256(UTF8 stable(value))，小写 64 hex。 */
function digest(value) {
  return createHash('sha256').update(Buffer.from(stable(value), 'utf8')).digest('hex');
}

// ---------------------------------------------------------------------------
// 候选构建
// ---------------------------------------------------------------------------

const KIND_ORDER = Object.freeze(['cluster', 'isolated', 'link']);

function buildCandidate(kind, scopeId, cards, evidence) {
  assertProtocolJson(evidence, `candidates[${kind}].evidence`);
  const sources = cards
    .map((c) => ({ id: c.id, revision: c.revision }))
    .sort((a, b) => byCodepoint(a.id, b.id));
  const id = digest({ kind, scopeId, sources, evidence });
  return { id, kind, scopeId, sources, evidence };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 只读机械候选分析（同步纯函数）。
 *
 * @param {object} params
 * @param {string} params.scopeId 显式 scope（factory-only，不从环境猜测）
 * @param {readonly object[]} params.records 完整 active 卡记录（store.listActive 快照）；
 *   分析快照不受每轮 <=20 写入配额约束（那是执行侧业务写入配额），规模由调用方决定
 * @param {number} [params.limit=100] 返回候选上限，正整数且 <= 1000
 * @returns {Array<{id:string, kind:'cluster'|'isolated'|'link', scopeId:string,
 *   sources:Array<{id:string, revision:number}>, evidence:object}>}
 *   排序先 kind（cluster < isolated < link）再 id，均为 UTF16 码点二进制序。
 */
export function analyzeCandidates(params = {}) {
  if (!isPlainObject(params)) {
    throw invalidInput(`analyzeCandidates 参数必须是普通对象，得到 ${params === null ? 'null' : typeof params}`);
  }
  for (const key of Object.keys(params)) {
    if (key !== 'scopeId' && key !== 'records' && key !== 'limit') {
      throw invalidInput(`analyzeCandidates 含未知选项 "${key}"（允许：scopeId/records/limit）`, { key });
    }
  }
  const { scopeId, records, limit = 100 } = params;
  if (scopeId === undefined) {
    throw invalidInput('scopeId 必须显式提供（不从 cwd/HOME/global 猜测）');
  }
  validateScopeId(scopeId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw invalidInput('limit 必须是 1..1000 的整数', { limit });
  }
  const cards = validateRecords(records, scopeId);
  const ids = new Set(cards.map((c) => c.id));

  // —— 归一化词表与 active 邻接（入边 + 出边，均只在 active 记录之间计） ——
  for (const card of cards) {
    card.normEntities = normalizeTerms(card.entities);
    card.normTriggers = normalizeTerms(card.triggers);
  }
  const outEdges = new Map(); // id -> Set(targetId)（仅 target 也在快照内才算 active 边）
  const inEdges = new Map();  // id -> Set(sourceId)
  for (const card of cards) {
    const outs = new Set();
    for (const l of card.links) {
      if (l.target !== card.id && ids.has(l.target)) {
        outs.add(l.target);
        if (!inEdges.has(l.target)) inEdges.set(l.target, new Set());
        inEdges.get(l.target).add(card.id);
      }
    }
    outEdges.set(card.id, outs);
  }

  // —— 倒排索引：field -> Map(term -> 含该词的卡列表)。
  //  必须用无歧义的嵌套结构：词条本身允许含 U+0000（冻结 store 合法输入），
  //  任何 field+NUL+term 的字符串复合键都会在 term 首个 NUL 处截断，
  //  导致机械证据失真且不同输入的候选 ID 碰撞（J-3 阻断项）。 ——
  const inverted = new Map([['entities', new Map()], ['triggers', new Map()]]);
  for (const card of cards) {
    for (const term of card.normEntities) {
      const byTerm = inverted.get('entities');
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term).push(card);
    }
    for (const term of card.normTriggers) {
      const byTerm = inverted.get('triggers');
      if (!byTerm.has(term)) byTerm.set(term, []);
      byTerm.get(term).push(card);
    }
  }

  const candidates = [];

  // —— isolated：active 图零度（无 active 出边且无 active 入边） ——
  for (const card of cards) {
    if (outEdges.get(card.id).size > 0) continue;
    const ins = inEdges.get(card.id);
    if (ins !== undefined && ins.size > 0) continue;
    // 出边里指向非 active 目标的边不计入 active 度，但作为机械证据列出
    const ignored = [...new Set(card.links.map((l) => l.target).filter((t) => !ids.has(t)))].sort(byCodepoint);
    candidates.push(buildCandidate('isolated', scopeId, [card], {
      inDegree: 0,
      outDegree: 0,
      ignoredRetiredTargets: ignored,
    }));
  }

  // —— link：共享实体/触发词的未连接 pair（任一方向已有链接即不再建议）。
  //  成本显式声明：对每个词的成员列表物化全部 pair，时间/内存 O(Σ_t C(m_t,2))，
  //  高共现词的大输入按成员数平方增长——这是「机械共现」语义的固有代价。 ——
  const pairShared = new Map(); // "a\0b" -> {a,b,entities:Set,triggers:Set}（卡 id 不允许 NUL，pair 键无歧义）
  for (const field of ['entities', 'triggers']) {
    const byTerm = inverted.get(field);
    for (const term of [...byTerm.keys()].sort(byCodepoint)) {
      const members = byTerm.get(term);
      if (members.length < 2) continue;
      const sorted = [...members].sort((a, b) => byCodepoint(a.id, b.id));
      for (let i = 0; i < sorted.length; i += 1) {
        for (let j = i + 1; j < sorted.length; j += 1) {
          const a = sorted[i];
          const b = sorted[j];
          if (outEdges.get(a.id).has(b.id) || outEdges.get(b.id).has(a.id)) continue;
          const pk = `${a.id}\u0000${b.id}`;
          let entry = pairShared.get(pk);
          if (!entry) {
            entry = { a, b, entities: new Set(), triggers: new Set() };
            pairShared.set(pk, entry);
          }
          entry[field].add(term);
        }
      }
    }
  }
  for (const pk of [...pairShared.keys()].sort(byCodepoint)) {
    const { a, b, entities, triggers } = pairShared.get(pk);
    candidates.push(buildCandidate('link', scopeId, [a, b], {
      sharedEntities: [...entities].sort(byCodepoint),
      sharedTriggers: [...triggers].sort(byCodepoint),
    }));
  }

  // —— cluster：共享单个实体/触发词、成员 >= 8 张唯一卡的确定性候选组。
  //  遍历序（entities 先于 triggers、词按码点序）+ 成员集合去重保证确定性；
  //  成员 >= 20 的 cluster 按本槽契约照常产出，源数 8..19 的业务约束由 K 的 merge-topic 把守。 ——
  const CLUSTER_MIN = 8;
  const seenCluster = new Set();
  for (const field of ['entities', 'triggers']) {
    const byTerm = inverted.get(field);
    for (const term of [...byTerm.keys()].sort(byCodepoint)) {
      const members = byTerm.get(term);
      if (members.length < CLUSTER_MIN) continue;
      const memberKey = members.map((c) => c.id).sort(byCodepoint).join('\u0000');
      if (seenCluster.has(memberKey)) continue;
      seenCluster.add(memberKey);
      candidates.push(buildCandidate('cluster', scopeId, members, { field, sharedTerm: term }));
    }
  }

  // —— 排序：先 kind 再 id（UTF16 码点二进制序），再按 limit 截断 ——
  candidates.sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    return byCodepoint(a.id, b.id);
  });
  return candidates.slice(0, limit);
}

export default analyzeCandidates;
