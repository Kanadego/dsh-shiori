// Shiori P3-QUEUE-DIFF · K 槽位：可恢复候选队列与审阅 diff 草案
//
// 职责边界：
// - createCandidateQueue：内存中的候选队列，可 JSON 快照恢复；本模块不持久化任何用户文件。
//   入队 / 审核只改变队列自身状态；reviewed 是「已审阅」不是「已批准 / 已执行」，
//   队列不产生任何业务写入，也不携带 approval / operationId 语义到 Plan。
// - buildDraft：把 (candidate, records, proposal) 变成确定性的 Plan + digest + 展示用 diff。
//   Plan 是 L 执行器的输入草案，本身不含 digest/approval/operationId，禁止未知字段。
//
// 实现独立性：本文件按契约独立实现 stable/digest/schema 校验，只 import node:crypto，
// 不 import 任何冻结 src 文件、也不 import 其他槽位（J/L）尚未合入的模块。
// 少数标识符规则（scopeId / spark id / topic key / operationId）按既有冻结实现的
// 同一规则在本文件内镜像实现，仅作输入校验，不改变其语义。
//
// 错误码统一为 Error.code：INVALID_INPUT / REVISION_CONFLICT / NOT_FOUND /
// INVALID_STATE / UNSUPPORTED（本模块不产生 APPROVAL_REQUIRED；执行授权属于 L）。

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// 基础工具：错误 / 比较 / 协议 JSON / stable / digest / 克隆
// ---------------------------------------------------------------------------

function fail(code, message, details) {
  const err = new Error(message);
  err.code = code;
  if (details !== undefined) err.details = details;
  throw err;
}

// UTF-16 二进制比较：与平台 locale 无关（契约 §1）
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const OBJECT_PROTO = Object.prototype;
const RESERVED_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === OBJECT_PROTO || proto === null;
}

/**
 * 协议 JSON 校验：undefined / function / symbol / bigint / NaN / Infinity /
 * 循环引用 / 稀疏数组孔洞 / 类实例 / 孤立代理码元字符串一律拒绝（契约 §1）。
 * 通过后才允许进入 stable()/digest()/deepClone()。
 */
function assertProtocolJson(value, where, ancestors = new Set()) {
  if (value === null) return;
  const type = typeof value;
  if (type === 'string') {
    if (!value.isWellFormed()) {
      fail('INVALID_INPUT', `${where} 含孤立代理码元，不是无损 UTF-8 文本`);
    }
    return;
  }
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      fail('INVALID_INPUT', `${where} 含 NaN/Infinity，不属于协议 JSON`);
    }
    return;
  }
  if (type === 'boolean') return;
  if (type === 'undefined' || type === 'function' || type === 'symbol' || type === 'bigint') {
    fail('INVALID_INPUT', `${where} 含 ${type} 值，不属于协议 JSON`);
  }
  // typeof === 'object'
  if (ancestors.has(value)) fail('INVALID_INPUT', `${where} 含循环引用`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) {
          fail('INVALID_INPUT', `${where}[${i}] 是稀疏数组孔洞，不属于协议 JSON`);
        }
        assertProtocolJson(value[i], `${where}[${i}]`, ancestors);
      }
      return;
    }
    if (!isPlainObject(value)) {
      fail('INVALID_INPUT', `${where} 必须是普通对象或数组（拒绝类实例等非 JSON 值）`);
    }
    for (const key of Object.keys(value)) {
      // 键与值同属协议文本（§9/§11）：对象键同样必须是无损 UTF-8。
      // JSON.stringify 会把孤立代理码元转义成 "\ud800" 文本，掩盖有损事实，
      // 故对键显式校验（a1 反例 K-2）；合法非 ASCII 键与配对代理键照常接受。
      if (!key.isWellFormed()) {
        fail('INVALID_INPUT', `${where} 的对象键 ${JSON.stringify(key)} 含孤立代理码元，不是无损 UTF-8 文本`);
      }
      assertProtocolJson(value[key], `${where}.${key === '' ? '""' : key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

/** stable(value)：递归按 UTF-16 序排序普通对象键后的 JSON 文本；数组顺序保持（契约 §1）。 */
function stable(value) {
  return JSON.stringify(value, function canonical(_key, v) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort(byCodepoint).map((k) => [k, v[k]]));
    }
    return v;
  });
}

/** digest = SHA256(UTF8(stable(value)))，小写 64 hex。 */
function digest(value) {
  return createHash('sha256').update(Buffer.from(stable(value), 'utf8')).digest('hex');
}

/** 深克隆：仅对已通过协议 JSON 校验的值调用（JSON 序列化无损失，且不泄露内部引用）。 */
const deepClone = (value) => JSON.parse(JSON.stringify(value));

// operationId -> operation 记录的安全字典（a1 反例 K-1）：
// `constructor`/`toString`/`hasOwnProperty` 等继承属性名是合法 operationId，
// 普通对象上直接索引会把它们误读为历史账项；null 原型字典 + own-property
// 查找让任何键都只是普通数据键（`__proto__` 形态也不触发原型 setter，
// 防止原型污染/账项丢失）。写入、克隆、快照与恢复全程保持该语义。
function newOperationRegistry() {
  return Object.create(null);
}
function lookupOperation(operations, operationId) {
  return Object.hasOwn(operations, operationId) ? operations[operationId] : undefined;
}
/** operations 克隆：逐条深克隆并保持安全字典（null 原型），不泄露内部引用。 */
function cloneOperations(operations) {
  const out = newOperationRegistry();
  for (const [operationId, entry] of Object.entries(operations)) {
    out[operationId] = deepClone(entry);
  }
  return out;
}

/** 断言 plain object 且键集合恰好为 expected（缺失/未知均拒绝）。 */
function assertExactKeys(obj, expected, where) {
  if (!isPlainObject(obj)) {
    fail('INVALID_INPUT', `${where} 必须是普通对象`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(obj, key)) {
      fail('INVALID_INPUT', `${where} 缺少必填字段 "${key}"`);
    }
  }
  for (const key of Object.keys(obj)) {
    if (!expected.includes(key)) {
      fail('INVALID_INPUT', `${where} 含未知字段 "${key}"（允许：${expected.join('/')}）`, { key });
    }
  }
}

// ---------------------------------------------------------------------------
// 标识符规则（镜像既有冻结实现的同一规则，仅用于输入校验）
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** scopeId：非空、≤128 UTF-16、无首尾空白、无控制字符、无孤立代理码元（镜像 core/topics.mjs）。 */
function validateScopeIdLocal(value, name = 'scopeId') {
  if (typeof value !== 'string' || value.length === 0) {
    fail('INVALID_INPUT', `${name} 必须是非空字符串`);
  }
  if (value.length > 128) {
    fail('INVALID_INPUT', `${name} 不得超过 128 UTF-16（实际 ${value.length}）`);
  }
  if (value !== value.trim()) {
    fail('INVALID_INPUT', `${name} 不得含首尾空白`);
  }
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      fail('INVALID_INPUT', `${name} 不得含孤立代理码元`);
    }
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      fail('INVALID_INPUT', `${name} 不得含控制字符`);
    }
  }
  return value;
}

/** spark 卡 id：≤64 UTF-16、字母数字开头、仅 [A-Za-z0-9._-]、非保留名（镜像 sparks/store.mjs）。 */
function validateSparkIdLocal(id, field = 'id') {
  if (typeof id !== 'string' || id.length === 0) {
    fail('INVALID_INPUT', `${field} 必须是非空字符串`);
  }
  if (id.length > 64) {
    fail('INVALID_INPUT', `${field} 超过 64 UTF-16（实际 ${id.length}）`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    fail('INVALID_INPUT', `${field} 只允许字母/数字/点/下划线/连字符且以字母数字开头`);
  }
  if (id.endsWith('.')) {
    fail('INVALID_INPUT', `${field} 不得以点结尾`);
  }
  if (RESERVED_JSON_KEYS.has(id)) {
    fail('INVALID_INPUT', `${field} 与对象键保留名冲突`);
  }
  const stem = id.replace(/\.[A-Za-z0-9_-]+$/, '').toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) {
    fail('INVALID_INPUT', `${field} 与 Windows 保留设备名冲突`);
  }
  return id;
}

/** topic key：跨平台文件名安全规则（镜像 core/keys.mjs）。 */
function validateTopicKeyLocal(key, field = 'topic.key') {
  if (typeof key !== 'string' || key.length === 0) {
    fail('INVALID_INPUT', `${field} 必须是非空字符串`);
  }
  if (key.length > 128) {
    fail('INVALID_INPUT', `${field} 不得超过 128 UTF-16（实际 ${key.length}）`);
  }
  const forbidden = new Set([...'<>:"/\\|?*']);
  for (const ch of key) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      fail('INVALID_INPUT', `${field} 不得含孤立代理码元`);
    }
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      fail('INVALID_INPUT', `${field} 不得含控制字符`);
    }
    if (forbidden.has(ch)) {
      fail('INVALID_INPUT', `${field} 含非法文件名字符 "${ch}"`);
    }
  }
  if (/^\.+$/.test(key)) fail('INVALID_INPUT', `${field} 不得只由点组成`);
  if (key.startsWith(' ')) fail('INVALID_INPUT', `${field} 不得以空格开头`);
  if (key.endsWith(' ') || key.endsWith('.')) {
    fail('INVALID_INPUT', `${field} 不得以空格或点结尾`);
  }
  const firstSegment = key.split('.')[0].replace(/[. ]+$/, '').toUpperCase();
  if (WINDOWS_RESERVED.has(firstSegment)) {
    fail('INVALID_INPUT', `${field} 与 Windows 保留设备名冲突`);
  }
  if (key.toLowerCase() === 'core' || key.toLowerCase() === 'core.md') {
    fail('INVALID_INPUT', `${field} 与 Shiori 保留别名 "core" 冲突`);
  }
  return key;
}

/** operationId：≤128 UTF-16、字母数字开头、仅 [A-Za-z0-9._-]（镜像 storage/paths.mjs）。 */
function validateOperationIdLocal(operationId) {
  if (typeof operationId !== 'string' || operationId.length === 0) {
    fail('INVALID_INPUT', 'operationId 必须是非空字符串');
  }
  if (operationId.length > 128) {
    fail('INVALID_INPUT', `operationId 超过 128 UTF-16（实际 ${operationId.length}）`);
  }
  if (operationId !== operationId.trim()) {
    fail('INVALID_INPUT', 'operationId 不得含首尾空白');
  }
  if (/[/\\:]/.test(operationId) || operationId === '.' || operationId === '..') {
    fail('INVALID_INPUT', 'operationId 含非法字符');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operationId)) {
    fail('INVALID_INPUT', 'operationId 只允许字母/数字/点/下划线/连字符且以字母数字开头');
  }
  const stem = operationId.replace(/\.[A-Za-z0-9_-]+$/, '').toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) {
    fail('INVALID_INPUT', 'operationId 与 Windows 保留设备名冲突');
  }
  return operationId;
}

// ---------------------------------------------------------------------------
// 候选（Candidate）校验 —— 与 J 槽契约同形，K 侧重验防篡改
// ---------------------------------------------------------------------------

const CANDIDATE_KINDS = new Set(['isolated', 'link', 'cluster']);

/** SourceRef 列表：{id,revision} 精确形状、revision>=1、id 唯一且按 UTF-16 升序（契约 §1）。 */
function validateSourceRefs(sources, where) {
  if (!Array.isArray(sources) || sources.length === 0) {
    fail('INVALID_INPUT', `${where} 必须是非空 SourceRef 数组`);
  }
  const seen = new Set();
  let prev = null;
  for (let i = 0; i < sources.length; i += 1) {
    const ref = sources[i];
    assertExactKeys(ref, ['id', 'revision'], `${where}[${i}]`);
    validateSparkIdLocal(ref.id, `${where}[${i}].id`);
    if (!Number.isInteger(ref.revision) || ref.revision < 1) {
      fail('INVALID_INPUT', `${where}[${i}].revision 必须是 >=1 的整数`);
    }
    if (seen.has(ref.id)) {
      fail('INVALID_INPUT', `${where} 存在重复 id "${ref.id}"`);
    }
    seen.add(ref.id);
    if (prev !== null && byCodepoint(prev, ref.id) >= 0) {
      fail('INVALID_INPUT', `${where} 必须按 id 的 UTF-16 序升序排列（"${ref.id}" 之前应为更大 id）`);
    }
    prev = ref.id;
  }
  return sources;
}

/**
 * 完整候选校验：形状 / kind / scope 一致 / sources 规范化 / 证据协议 JSON，
 * 并重算 id=digest({kind,scopeId,sources,evidence}) 防候选篡改（契约 §3「所有candidate重新核验id与scope」）。
 */
function validateCandidate(candidate, expectedScopeId, where) {
  assertProtocolJson(candidate, where);
  assertExactKeys(candidate, ['id', 'kind', 'scopeId', 'sources', 'evidence'], where);
  if (!CANDIDATE_KINDS.has(candidate.kind)) {
    fail('INVALID_INPUT', `${where}.kind 必须是 isolated/link/cluster（得到 ${JSON.stringify(candidate.kind)}）`);
  }
  if (candidate.scopeId !== expectedScopeId) {
    fail('INVALID_INPUT', `${where}.scopeId 与队列 scope 不一致，跨 scope 候选拒绝`, {
      candidateScopeId: candidate.scopeId, queueScopeId: expectedScopeId,
    });
  }
  validateSourceRefs(candidate.sources, `${where}.sources`);
  if (!isPlainObject(candidate.evidence)) {
    fail('INVALID_INPUT', `${where}.evidence 必须是对象`);
  }
  if (typeof candidate.id !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.id)) {
    fail('INVALID_INPUT', `${where}.id 必须是小写 64 位 hex`);
  }
  const recomputed = digest({
    kind: candidate.kind, scopeId: candidate.scopeId,
    sources: candidate.sources, evidence: candidate.evidence,
  });
  if (recomputed !== candidate.id) {
    fail('INVALID_INPUT', `${where}.id 与 digest({kind,scopeId,sources,evidence}) 不一致，候选疑似被篡改`, {
      declaredId: candidate.id, recomputedId: recomputed,
    });
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// createCandidateQueue
// ---------------------------------------------------------------------------
//
// 快照编码（K 文档声明，恢复时严格校验）：
//   snapshot = { version:1, scopeId, revision, items, operations }
//   items[i] = { candidate, status: 'pending'|'reviewed'|'dismissed' }（按入队顺序）
//   operations[operationId] = { kind:'enqueue'|'review', fingerprint:64hex,
//                               request:{...原请求载荷}, result:{version:1,scopeId,revision,items} }
// result 是不含 operations 的业务快照（避免递归指数膨胀，契约 §5）；request 被保留
// 供恢复时从空队列做确定性全量重放：重放结果必须与 items/revision 完全一致，
// 因此顶层 revision 不可被单独信任。重放命中幂等时返回「首次业务结果 + 当前 operations 克隆」。
// operations 字典在内存与快照输出中均为 null 原型安全字典：键读取一律按
// own-property 语义（`constructor`/`toString` 等继承名是合法 operationId，
// 不与 Object.prototype 属性混淆；`__proto__` 形态不触发原型 setter）。

const ITEM_STATUSES = new Set(['pending', 'reviewed', 'dismissed']);
const OP_KINDS = new Set(['enqueue', 'review', 'converge']);

function businessSnapshotOf(state) {
  return {
    version: 1,
    scopeId: state.scopeId,
    revision: state.revision,
    items: deepClone(state.items),
  };
}

function fullSnapshotOf(state) {
  return { ...businessSnapshotOf(state), operations: cloneOperations(state.operations) };
}

/** enqueue 业务逻辑（输入已校验、已克隆）：相同 id 相同 payload 去重不重复入队。 */
function applyEnqueue(state, candidates) {
  for (const candidate of candidates) {
    const existing = state.items.find((item) => item.candidate.id === candidate.id);
    if (existing === undefined) {
      state.items.push({ candidate, status: 'pending' });
    } else if (stable(existing.candidate) !== stable(candidate)) {
      // id 经 digest 核验后理论上不可达；保留为对损坏状态的防御。
      fail('INVALID_STATE', `队列内已存在同 id 不同内容的候选 "${candidate.id}"，疑似状态损坏`, {
        candidateId: candidate.id,
      });
    }
  }
}

/** review 业务逻辑（输入已校验）：只有 pending 可 review。 */
function applyReview(state, candidateId, decision) {
  const item = state.items.find((entry) => entry.candidate.id === candidateId);
  if (item === undefined) {
    fail('NOT_FOUND', `候选 "${candidateId}" 不在队列中`, { candidateId });
  }
  if (item.status !== 'pending') {
    fail('INVALID_STATE', `候选 "${candidateId}" 状态为 ${item.status}，只有 pending 可以 review`, {
      candidateId, status: item.status,
    });
  }
  item.status = decision;
}

/**
 * converge 业务逻辑（输入已校验、已克隆；P-A 队列收敛）：
 * 以本次分析派生的候选集为准——仍在场的候选保留既有 status（reviewed 不因
 * 重新分析退回 pending），新出现的候选以 pending 追加，本次不再出现的候选
 * （源卡已 merged/archived 或派生条件消失）从队列移除。确定性：给定重放到的
 * 中间状态与同一候选集，产出唯一终态。
 */
function applyConverge(state, candidates, keepAbsentIds = null) {
  const currentIds = new Set(candidates.map((candidate) => candidate.id));
  // 截断保护（P-A 残留）：分析候选达到 limit 上限时，"不在本次候选集"不再
  // 等价于"失效"——keepAbsentIds 列出的既有队列项按原 status 保留。
  const keepIds = keepAbsentIds === null ? null : new Set(keepAbsentIds);
  const kept = [];
  const keptIds = new Set();
  for (const item of state.items) {
    if (currentIds.has(item.candidate.id) || (keepIds !== null && keepIds.has(item.candidate.id))) {
      kept.push(item);
      keptIds.add(item.candidate.id);
    }
  }
  for (const candidate of candidates) {
    if (!keptIds.has(candidate.id)) {
      kept.push({ candidate, status: 'pending' });
    }
  }
  state.items = kept;
}

/** 校验 opts 形状并返回规范化值；optionalKeys 中的键可缺席，其余未知键拒绝。 */
function readQueueOpts(opts, expectedKeys, method, optionalKeys = []) {
  if (!isPlainObject(opts)) fail('INVALID_INPUT', `${method} opts 必须是普通对象`);
  const allowed = [...expectedKeys, ...optionalKeys];
  for (const key of expectedKeys) {
    if (!Object.hasOwn(opts, key)) fail('INVALID_INPUT', `${method} opts 缺少必填字段 "${key}"`);
  }
  for (const key of Object.keys(opts)) {
    if (!allowed.includes(key)) {
      fail('INVALID_INPUT', `${method} opts 含未知字段 "${key}"（允许：${allowed.join('/')}）`, { key });
    }
  }
  if (!Number.isInteger(opts.expectedRevision) || opts.expectedRevision < 0) {
    fail('INVALID_INPUT', `${method} opts.expectedRevision 必须是 >=0 的整数`);
  }
  validateOperationIdLocal(opts.operationId);
  return opts;
}

/** 校验一份业务快照（items/revision），用于 operations[].result 与恢复路径。 */
function validateBusinessSnapshot(value, scopeId, where) {
  assertExactKeys(value, ['version', 'scopeId', 'revision', 'items'], where);
  if (value.version !== 1) fail('INVALID_INPUT', `${where}.version 必须是 1`);
  if (value.scopeId !== scopeId) {
    fail('INVALID_INPUT', `${where}.scopeId 与队列 scope 不一致`);
  }
  if (!Number.isInteger(value.revision) || value.revision < 0) {
    fail('INVALID_INPUT', `${where}.revision 必须是 >=0 的整数`);
  }
  validateItems(value.items, scopeId, `${where}.items`);
  return value;
}

function validateItems(items, scopeId, where) {
  if (!Array.isArray(items)) fail('INVALID_INPUT', `${where} 必须是数组`);
  const seen = new Set();
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    assertExactKeys(item, ['candidate', 'status'], `${where}[${i}]`);
    if (!ITEM_STATUSES.has(item.status)) {
      fail('INVALID_INPUT', `${where}[${i}].status 必须是 pending/reviewed/dismissed`);
    }
    validateCandidate(item.candidate, scopeId, `${where}[${i}].candidate`);
    if (seen.has(item.candidate.id)) {
      fail('INVALID_INPUT', `${where} 存在重复候选 id "${item.candidate.id}"`);
    }
    seen.add(item.candidate.id);
  }
  return items;
}

/** 校验单条 operation 记录（含 fingerprint 与 request 的一致性）。 */
function validateOperationEntry(entry, operationId, scopeId, where) {
  assertExactKeys(entry, ['kind', 'fingerprint', 'request', 'result'], where);
  if (!OP_KINDS.has(entry.kind)) {
    fail('INVALID_INPUT', `${where}.kind 必须是 enqueue/review/converge`);
  }
  if (typeof entry.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(entry.fingerprint)) {
    fail('INVALID_INPUT', `${where}.fingerprint 必须是小写 64 位 hex`);
  }
  const request = entry.request;
  if (entry.kind === 'enqueue') {
    assertExactKeys(request, ['kind', 'candidates'], `${where}.request`);
    if (request.kind !== 'enqueue') fail('INVALID_INPUT', `${where}.request.kind 与 entry.kind 不一致`);
    if (!Array.isArray(request.candidates) || request.candidates.length === 0) {
      fail('INVALID_INPUT', `${where}.request.candidates 必须是非空数组`);
    }
    const seen = new Set();
    for (let i = 0; i < request.candidates.length; i += 1) {
      validateCandidate(request.candidates[i], scopeId, `${where}.request.candidates[${i}]`);
      const cid = request.candidates[i].id;
      if (seen.has(cid)) fail('INVALID_INPUT', `${where}.request.candidates 存在重复 id "${cid}"`);
      seen.add(cid);
    }
  } else if (entry.kind === 'converge') {
    // keepAbsentIds 可选（旧快照无此键；截断保护引入）。未知键仍拒绝。
    const requestKeys = Object.keys(request);
    for (const key of requestKeys) {
      if (key !== 'kind' && key !== 'candidates' && key !== 'keepAbsentIds') {
        fail('INVALID_INPUT', `${where}.request 含未知字段 "${key}"（允许：kind/candidates/keepAbsentIds）`);
      }
    }
    if (!requestKeys.includes('kind')) fail('INVALID_INPUT', `${where}.request 缺少必填字段 "kind"`);
    if (!requestKeys.includes('candidates')) fail('INVALID_INPUT', `${where}.request 缺少必填字段 "candidates"`);
    if (request.kind !== 'converge') fail('INVALID_INPUT', `${where}.request.kind 与 entry.kind 不一致`);
    // 收敛允许空数组（本次分析无候选 = 清空失效候选）。
    if (!Array.isArray(request.candidates)) {
      fail('INVALID_INPUT', `${where}.request.candidates 必须是数组（可为空）`);
    }
    const seen = new Set();
    for (let i = 0; i < request.candidates.length; i += 1) {
      validateCandidate(request.candidates[i], scopeId, `${where}.request.candidates[${i}]`);
      const cid = request.candidates[i].id;
      if (seen.has(cid)) fail('INVALID_INPUT', `${where}.request.candidates 存在重复 id "${cid}"`);
      seen.add(cid);
    }
    if (requestKeys.includes('keepAbsentIds')) {
      if (!Array.isArray(request.keepAbsentIds)) {
        fail('INVALID_INPUT', `${where}.request.keepAbsentIds 必须是数组`);
      }
      const seenKeep = new Set();
      for (const id of request.keepAbsentIds) {
        if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
          fail('INVALID_INPUT', `${where}.request.keepAbsentIds 必须全是小写 64 位 hex 候选 id`);
        }
        if (seenKeep.has(id)) fail('INVALID_INPUT', `${where}.request.keepAbsentIds 存在重复 id "${id}"`);
        seenKeep.add(id);
      }
      if (JSON.stringify([...seenKeep].sort(byCodepoint)) !== JSON.stringify(request.keepAbsentIds)) {
        fail('INVALID_INPUT', `${where}.request.keepAbsentIds 必须按码点升序去重存放`);
      }
    }
  } else {
    assertExactKeys(request, ['kind', 'candidateId', 'decision'], `${where}.request`);
    if (request.kind !== 'review') fail('INVALID_INPUT', `${where}.request.kind 与 entry.kind 不一致`);
    if (typeof request.candidateId !== 'string' || !/^[0-9a-f]{64}$/.test(request.candidateId)) {
      fail('INVALID_INPUT', `${where}.request.candidateId 必须是小写 64 位 hex`);
    }
    if (request.decision !== 'reviewed' && request.decision !== 'dismissed') {
      fail('INVALID_INPUT', `${where}.request.decision 必须是 reviewed/dismissed`);
    }
  }
  if (digest(request) !== entry.fingerprint) {
    fail('INVALID_INPUT', `${where}.fingerprint 与 request 内容不匹配，操作记录疑似被篡改`);
  }
  validateBusinessSnapshot(entry.result, scopeId, `${where}.result`);
  return entry;
}

/**
 * 从快照恢复：结构校验 + 从空队列按 result.revision 升序确定性重放全部 operations，
 * 每一步的中间业务快照必须与记录的 result 完全一致，最终状态必须与顶层
 * items/revision 完全一致 —— 顶层 revision 不被单独信任。
 */
function restoreState(snapshot, scopeId) {
  assertProtocolJson(snapshot, 'snapshot');
  assertExactKeys(snapshot, ['version', 'scopeId', 'revision', 'items', 'operations'], 'snapshot');
  if (snapshot.version !== 1) fail('INVALID_INPUT', 'snapshot.version 必须是 1');
  if (snapshot.scopeId !== scopeId) {
    fail('INVALID_INPUT', 'snapshot.scopeId 与工厂 scopeId 不一致，拒绝恢复');
  }
  if (!Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
    fail('INVALID_INPUT', 'snapshot.revision 必须是 >=0 的整数');
  }
  validateItems(snapshot.items, scopeId, 'snapshot.items');
  if (!isPlainObject(snapshot.operations)) {
    fail('INVALID_INPUT', 'snapshot.operations 必须是对象');
  }

  const entries = [];
  for (const [operationId, entry] of Object.entries(snapshot.operations)) {
    validateOperationIdLocal(operationId);
    validateOperationEntry(entry, operationId, scopeId, `snapshot.operations.${operationId}`);
    entries.push({ operationId, entry });
  }

  // 不变量：每个成功队列事务 revision+1 并恰好记录一条 operation，
  // 因此 operations 数必须等于顶层 revision，且各 result.revision 恰为 1..N。
  if (entries.length !== snapshot.revision) {
    fail('INVALID_STATE', `snapshot.revision (${snapshot.revision}) 与 operations 条数 (${entries.length}) 不一致，拒绝恢复`);
  }
  const revisions = entries.map(({ entry }) => entry.result.revision).sort((a, b) => a - b);
  for (let i = 0; i < revisions.length; i += 1) {
    if (revisions[i] !== i + 1) {
      fail('INVALID_STATE', `operations 的 result.revision 必须恰好覆盖 1..${entries.length}（发现 ${revisions[i]}）`);
    }
  }

  const state = { scopeId, revision: 0, items: [], operations: newOperationRegistry() };
  entries.sort((a, b) => a.entry.result.revision - b.entry.result.revision);
  for (const { operationId, entry } of entries) {
    if (entry.kind === 'enqueue') {
      applyEnqueue(state, deepClone(entry.request.candidates));
    } else if (entry.kind === 'converge') {
      applyConverge(state, deepClone(entry.request.candidates), entry.request.keepAbsentIds ?? null);
    } else {
      applyReview(state, entry.request.candidateId, entry.request.decision);
    }
    state.revision += 1;
    const produced = businessSnapshotOf(state);
    if (stable(produced) !== stable(entry.result)) {
      fail('INVALID_STATE', `operation "${operationId}" 的重放结果与记录的 result 不一致，快照历史被篡改`, {
        operationId,
      });
    }
    state.operations[operationId] = {
      kind: entry.kind,
      fingerprint: entry.fingerprint,
      request: deepClone(entry.request),
      result: deepClone(entry.result),
    };
  }
  if (state.revision !== snapshot.revision
    || stable(businessSnapshotOf(state)) !== stable({
      version: 1, scopeId, revision: snapshot.revision, items: snapshot.items,
    })) {
    fail('INVALID_STATE', '重放终态与快照顶层 items/revision 不一致，拒绝恢复');
  }
  return state;
}

/** 断言 plain object：required 必须在场，optional 可选，其余未知键拒绝。 */
function assertAllowedKeys(obj, required, optional, where) {
  if (!isPlainObject(obj)) {
    fail('INVALID_INPUT', `${where} 必须是普通对象`);
  }
  for (const key of required) {
    if (!Object.hasOwn(obj, key)) {
      fail('INVALID_INPUT', `${where} 缺少必填字段 "${key}"`);
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      fail('INVALID_INPUT', `${where} 含未知字段 "${key}"（允许：${[...allowed].join('/')}）`, { key });
    }
  }
}

/**
 * 建立候选队列。
 *
 * @param {object} params
 * @param {string} params.scopeId  显式 scope（factory-only；不从 cwd/HOME/global 猜测）
 * @param {object} [params.snapshot] 可选快照；提供时执行严格恢复校验
 * @returns {object} queue = { snapshot(), enqueue(), review() }
 */
export function createCandidateQueue(params) {
  if (!isPlainObject(params)) {
    fail('INVALID_INPUT', 'createCandidateQueue 参数必须是对象');
  }
  assertAllowedKeys(params, ['scopeId'], ['snapshot'], 'createCandidateQueue 参数');
  const { scopeId, snapshot } = params;
  validateScopeIdLocal(scopeId);
  const state = snapshot === undefined
    ? { scopeId, revision: 0, items: [], operations: newOperationRegistry() }
    : restoreState(snapshot, scopeId);

  const queue = {
    /** 当前完整快照的深克隆（修改返回值不影响队列内部状态）。 */
    snapshot() {
      return fullSnapshotOf(state);
    },

    /**
     * 入队：幂等按 operationId 先于 CAS（重放不受 expectedRevision 约束）；
     * 同 operationId 异 payload 拒绝；相同 id 相同 payload 不重复入队，
     * 即便去重 no-op 也算一次队列事务（revision+1）。
     */
    enqueue(candidates, opts) {
      if (!Array.isArray(candidates) || candidates.length === 0) {
        fail('INVALID_INPUT', 'enqueue 的 candidates 必须是非空数组');
      }
      for (let i = 0; i < candidates.length; i += 1) {
        validateCandidate(candidates[i], scopeId, `candidates[${i}]`);
      }
      const batchIds = new Set();
      for (const candidate of candidates) {
        if (batchIds.has(candidate.id)) {
          fail('INVALID_INPUT', `同一批 enqueue 内存在重复候选 id "${candidate.id}"`);
        }
        batchIds.add(candidate.id);
      }
      readQueueOpts(opts, ['expectedRevision', 'operationId'], 'enqueue');

      const request = { kind: 'enqueue', candidates: deepClone(candidates) };
      const fingerprint = digest(request);

      // 幂等先于 CAS：同 operationId 同 payload 直接重放首次业务结果 + 当前 operations 克隆。
      // 查找必须走 own-property（安全字典），继承属性名不得被误读为历史账项（K-1）。
      const prior = lookupOperation(state.operations, opts.operationId);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          fail('INVALID_INPUT', `operationId "${opts.operationId}" 已被不同语义的请求使用，拒绝执行`, {
            operationId: opts.operationId, previousKind: prior.kind, attemptedKind: 'enqueue',
          });
        }
        return { ...deepClone(prior.result), operations: cloneOperations(state.operations) };
      }

      if (opts.expectedRevision !== state.revision) {
        fail('REVISION_CONFLICT', `队列 revision CAS 失败（期望 ${opts.expectedRevision}，当前 ${state.revision}）`, {
          expectedRevision: opts.expectedRevision, currentRevision: state.revision,
        });
      }

      applyEnqueue(state, request.candidates);
      state.revision += 1;
      state.operations[opts.operationId] = {
        kind: 'enqueue', fingerprint, request, result: businessSnapshotOf(state),
      };
      return fullSnapshotOf(state);
    },

    /**
     * 审核：只有 pending 可以 review；reviewed 是「已审阅」而非「已批准/已执行」，
     * 不产生任何业务写入。失败（NOT_FOUND/INVALID_STATE/CAS 冲突）时队列原样。
     */
    review(candidateId, opts) {
      if (typeof candidateId !== 'string' || !/^[0-9a-f]{64}$/.test(candidateId)) {
        fail('INVALID_INPUT', 'candidateId 必须是小写 64 位 hex（候选 id 即 digest）');
      }
      readQueueOpts(opts, ['decision', 'expectedRevision', 'operationId'], 'review');
      if (opts.decision !== 'reviewed' && opts.decision !== 'dismissed') {
        fail('INVALID_INPUT', 'review opts.decision 必须是 reviewed 或 dismissed');
      }

      const request = { kind: 'review', candidateId, decision: opts.decision };
      const fingerprint = digest(request);

      const prior = lookupOperation(state.operations, opts.operationId);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          fail('INVALID_INPUT', `operationId "${opts.operationId}" 已被不同语义的请求使用，拒绝执行`, {
            operationId: opts.operationId, previousKind: prior.kind, attemptedKind: 'review',
          });
        }
        return { ...deepClone(prior.result), operations: cloneOperations(state.operations) };
      }

      if (opts.expectedRevision !== state.revision) {
        fail('REVISION_CONFLICT', `队列 revision CAS 失败（期望 ${opts.expectedRevision}，当前 ${state.revision}）`, {
          expectedRevision: opts.expectedRevision, currentRevision: state.revision,
        });
      }

      applyReview(state, candidateId, opts.decision);
      state.revision += 1;
      state.operations[opts.operationId] = {
        kind: 'review', fingerprint, request, result: businessSnapshotOf(state),
      };
      return fullSnapshotOf(state);
    },

    /**
     * 收敛（P-A）：以本次分析派生的候选集为准对齐队列——保留在场候选的既有
     * status（reviewed 不退回）、新候选以 pending 追加、不在场的候选移除
     * （其源卡已 merged/archived 或派生条件消失）。candidates 允许空数组。
     * opts.keepAbsentIds（可选，null 或 64-hex id 数组）：截断保护——调用方
     * 在候选集被 limit 截断时，把"不在候选集但源卡仍全部 active"的既有队列项
     * 列在这里，它们按原 status 保留而非移除；未截断时传 null（缺省），
     * "不在场 = 移除"语义不变。与 enqueue 同幂等语义：同 operationId 同
     * payload 重放首次业务结果；即便集合无变化也记一次队列事务
     * （revision+1），保持「operations 数 === revision」的恢复不变量与严格
     * 幂等。keepAbsentIds 入 journal request（排序规范化），重放逐字一致。
     */
    converge(candidates, opts) {
      if (!Array.isArray(candidates)) {
        fail('INVALID_INPUT', 'converge 的 candidates 必须是数组（可为空）');
      }
      for (let i = 0; i < candidates.length; i += 1) {
        validateCandidate(candidates[i], scopeId, `candidates[${i}]`);
      }
      const batchIds = new Set();
      for (const candidate of candidates) {
        if (batchIds.has(candidate.id)) {
          fail('INVALID_INPUT', `同一批 converge 内存在重复候选 id "${candidate.id}"`);
        }
        batchIds.add(candidate.id);
      }
      readQueueOpts(opts, ['expectedRevision', 'operationId'], 'converge', ['keepAbsentIds']);
      let keepAbsentIds = null;
      if (opts.keepAbsentIds !== undefined && opts.keepAbsentIds !== null) {
        if (!Array.isArray(opts.keepAbsentIds)) {
          fail('INVALID_INPUT', 'converge opts.keepAbsentIds 必须是数组或 null');
        }
        const seenKeep = new Set();
        for (const id of opts.keepAbsentIds) {
          if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) {
            fail('INVALID_INPUT', 'converge opts.keepAbsentIds 必须全是小写 64 位 hex 候选 id');
          }
          if (seenKeep.has(id)) {
            fail('INVALID_INPUT', `converge opts.keepAbsentIds 存在重复 id "${id}"`);
          }
          seenKeep.add(id);
        }
        keepAbsentIds = [...seenKeep].sort(byCodepoint);
      }

      const request = { kind: 'converge', candidates: deepClone(candidates) };
      if (keepAbsentIds !== null) request.keepAbsentIds = keepAbsentIds;
      const fingerprint = digest(request);

      const prior = lookupOperation(state.operations, opts.operationId);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint) {
          fail('INVALID_INPUT', `operationId "${opts.operationId}" 已被不同语义的请求使用，拒绝执行`, {
            operationId: opts.operationId, previousKind: prior.kind, attemptedKind: 'converge',
          });
        }
        return { ...deepClone(prior.result), operations: cloneOperations(state.operations) };
      }

      if (opts.expectedRevision !== state.revision) {
        fail('REVISION_CONFLICT', `队列 revision CAS 失败（期望 ${opts.expectedRevision}，当前 ${state.revision}）`, {
          expectedRevision: opts.expectedRevision, currentRevision: state.revision,
        });
      }

      applyConverge(state, request.candidates, keepAbsentIds);
      state.revision += 1;
      state.operations[opts.operationId] = {
        kind: 'converge', fingerprint, request, result: businessSnapshotOf(state),
      };
      return fullSnapshotOf(state);
    },
  };
  return queue;
}

// ---------------------------------------------------------------------------
// buildDraft：候选 + 完整 active records + proposal -> { plan, digest, diff, changedItems }
// ---------------------------------------------------------------------------

const PLAN_KINDS = new Set(['link', 'merge-topic', 'thin-core']);
// 镜像冻结 sparks/store.mjs 的 LIMITS（仅用于输入校验，保证草案可被执行器接受）
const CARD_LIMITS = Object.freeze({
  titleChars: 80, summaryChars: 120, contentChars: 2000,
  wordChars: 64, relChars: 64, triggersMax: 32, entitiesMax: 32, linksMax: 32,
});
const VITALITIES = new Set(['evergreen', 'ephemeral']);
const MAX_CHANGED_ITEMS = 20;

const SOURCES_MARKER = '<!-- shiori-p3-sources -->';
const SOURCES_CLOSE_MARKER = '<!-- /shiori-p3-sources -->';
const SOURCES_BLOCK_OPEN = '\n<!-- shiori-p3-sources -->\n';
const SOURCES_BLOCK_CLOSE = '\n<!-- /shiori-p3-sources -->\n';

function checkText(value, where, { min = 0, max = null }) {
  if (typeof value !== 'string') {
    fail('INVALID_INPUT', `${where} 必须是字符串`);
  }
  if (!value.isWellFormed()) {
    fail('INVALID_INPUT', `${where} 含孤立代理码元，不是无损 UTF-8 文本`);
  }
  if (value.length < min) {
    fail('INVALID_INPUT', `${where} 长度必须 >= ${min} UTF-16（实际 ${value.length}）`);
  }
  if (max !== null && value.length > max) {
    fail('INVALID_INPUT', `${where} 长度必须 <= ${max} UTF-16（实际 ${value.length}）`);
  }
  return value;
}

/** 完整 active 卡记录校验（store.listActive 形状；记录只认 active，契约 §1）。 */
function validateRecord(record, expectedScopeId, where) {
  assertProtocolJson(record, where);
  if (!isPlainObject(record)) fail('INVALID_INPUT', `${where} 必须是普通对象`);
  for (const field of ['id', 'scopeId', 'revision', 'state', 'title', 'summary', 'content',
    'triggers', 'entities', 'links', 'vitality']) {
    if (!Object.hasOwn(record, field)) {
      fail('INVALID_INPUT', `${where} 缺少必填字段 "${field}"（须为完整 active card 记录）`);
    }
  }
  validateSparkIdLocal(record.id, `${where}.id`);
  if (record.scopeId !== expectedScopeId) {
    fail('INVALID_INPUT', `${where}.scopeId (${JSON.stringify(record.scopeId)}) 与候选 scope 不一致，跨 scope 记录拒绝`);
  }
  if (!Number.isInteger(record.revision) || record.revision < 1) {
    fail('INVALID_INPUT', `${where}.revision 必须是 >=1 的整数`);
  }
  if (record.state !== 'active') {
    fail('INVALID_INPUT', `${where}.state 必须是 active（只认完整 active card 记录），得到 ${JSON.stringify(record.state)}`);
  }
  checkText(record.title, `${where}.title`, { min: 1, max: CARD_LIMITS.titleChars });
  checkText(record.summary, `${where}.summary`, { min: 0, max: CARD_LIMITS.summaryChars });
  checkText(record.content, `${where}.content`, { min: 1, max: CARD_LIMITS.contentChars });
  for (const [field, maxCount] of [['triggers', CARD_LIMITS.triggersMax], ['entities', CARD_LIMITS.entitiesMax]]) {
    if (!Array.isArray(record[field])) fail('INVALID_INPUT', `${where}.${field} 必须是字符串数组`);
    if (record[field].length > maxCount) {
      fail('INVALID_INPUT', `${where}.${field} 最多 ${maxCount} 项（实际 ${record[field].length}）`);
    }
    for (let i = 0; i < record[field].length; i += 1) {
      checkText(record[field][i], `${where}.${field}[${i}]`, { min: 1, max: CARD_LIMITS.wordChars });
      if (record[field][i].trim() === '') {
        fail('INVALID_INPUT', `${where}.${field}[${i}] 不得为纯空白`);
      }
    }
  }
  validateCardLinks(record.links, `${where}.links`);
  if (!VITALITIES.has(record.vitality)) {
    fail('INVALID_INPUT', `${where}.vitality 必须是 evergreen/ephemeral`);
  }
  return record;
}

/** 卡上 links（P2 实际形状 {target,rel}）：形状、去重、上限校验。 */
function validateCardLinks(links, where) {
  if (!Array.isArray(links)) fail('INVALID_INPUT', `${where} 必须是 {target,rel} 数组`);
  if (links.length > CARD_LIMITS.linksMax) {
    fail('INVALID_INPUT', `${where} 最多 ${CARD_LIMITS.linksMax} 项（实际 ${links.length}）`);
  }
  const seen = new Set();
  for (let i = 0; i < links.length; i += 1) {
    const entry = links[i];
    assertExactKeys(entry, ['target', 'rel'], `${where}[${i}]`);
    validateSparkIdLocal(entry.target, `${where}[${i}].target`);
    checkText(entry.rel, `${where}[${i}].rel`, { min: 1, max: CARD_LIMITS.relChars });
    if (entry.rel.trim() === '') {
      fail('INVALID_INPUT', `${where}[${i}].rel 不得为纯空白`);
    }
    const key = `${entry.target}\u0000${entry.rel}`;
    if (seen.has(key)) {
      fail('INVALID_INPUT', `${where}[${i}] 与既有 (target,rel) 重复：(${entry.target},${entry.rel})`);
    }
    seen.add(key);
  }
  return links;
}

const linkKey = (l) => `${l.target}\u0000${l.rel}`;
const compareLinks = (a, b) => byCodepoint(a.target, b.target) || byCodepoint(a.rel, b.rel);

/** 源保全块用的记录投影：仅这十个字段，triggers/entities/links 保持原数组顺序（契约 §5）。 */
function projectRecordForBlock(record) {
  return {
    id: record.id,
    scopeId: record.scopeId,
    revision: record.revision,
    title: record.title,
    summary: record.summary,
    content: record.content,
    triggers: [...record.triggers],
    entities: [...record.entities],
    links: record.links.map((l) => ({ target: l.target, rel: l.rel })),
    vitality: record.vitality,
  };
}

/** Plan 结构校验（供 buildDraft 自检与 digestPlan 外部校验共用；纯结构，不查 records）。 */
function validatePlanShape(plan, where = 'plan') {
  assertProtocolJson(plan, where);
  if (!isPlainObject(plan)) fail('INVALID_INPUT', `${where} 必须是普通对象`);
  if (plan.version !== 1) fail('INVALID_INPUT', `${where}.version 必须是 1`);
  if (!PLAN_KINDS.has(plan.kind)) {
    fail('INVALID_INPUT', `${where}.kind 必须是 link/merge-topic/thin-core`);
  }
  validateScopeIdLocal(plan.scopeId, `${where}.scopeId`);
  if (typeof plan.candidateId !== 'string' || !/^[0-9a-f]{64}$/.test(plan.candidateId)) {
    fail('INVALID_INPUT', `${where}.candidateId 必须是小写 64 位 hex`);
  }
  validateSourceRefs(plan.sources, `${where}.sources`);
  const base = ['version', 'scopeId', 'candidateId', 'kind', 'sources'];
  if (plan.kind === 'link') {
    assertExactKeys(plan, [...base, 'links'], where);
    if (!Array.isArray(plan.links) || plan.links.length === 0) {
      fail('INVALID_INPUT', `${where}.links 必须是非空数组`);
    }
    if (plan.links.length > MAX_CHANGED_ITEMS) {
      fail('INVALID_INPUT', `${where}.links 超过单轮 ${MAX_CHANGED_ITEMS} 上限（实际 ${plan.links.length}）`);
    }
    const seen = new Set();
    let prevId = null;
    for (let i = 0; i < plan.links.length; i += 1) {
      const entry = plan.links[i];
      assertExactKeys(entry, ['id', 'expectedRevision', 'before', 'after'], `${where}.links[${i}]`);
      validateSparkIdLocal(entry.id, `${where}.links[${i}].id`);
      if (!Number.isInteger(entry.expectedRevision) || entry.expectedRevision < 1) {
        fail('INVALID_INPUT', `${where}.links[${i}].expectedRevision 必须是 >=1 的整数`);
      }
      validateCardLinks(entry.before, `${where}.links[${i}].before`);
      validateCardLinks(entry.after, `${where}.links[${i}].after`);
      if (seen.has(entry.id)) fail('INVALID_INPUT', `${where}.links 存在重复被改源 "${entry.id}"`);
      seen.add(entry.id);
      if (prevId !== null && byCodepoint(prevId, entry.id) >= 0) {
        fail('INVALID_INPUT', `${where}.links 必须按 id 的 UTF-16 序升序排列`);
      }
      prevId = entry.id;
      for (const l of entry.after) {
        if (l.target === entry.id) fail('INVALID_INPUT', `${where}.links[${i}].after 不允许自环`);
      }
    }
  } else if (plan.kind === 'merge-topic') {
    assertExactKeys(plan, [...base, 'topic'], where);
    validatePlanTopic(plan.topic, `${where}.topic`);
  } else {
    assertExactKeys(plan, [...base, 'core'], where);
    assertExactKeys(plan.core, ['before', 'after'], `${where}.core`);
    checkText(plan.core.before, `${where}.core.before`, { min: 0 });
    checkText(plan.core.after, `${where}.core.after`, { min: 0 });
  }
  return plan;
}

/** merge-topic 的 topic 元数据校验（before/after 为正文文本，expectedRevision 为 service 不透明 token）。 */
function validatePlanTopic(topic, where) {
  assertExactKeys(topic, ['key', 'expectedRevision', 'before', 'after', 'title', 'summary', 'updated'], where);
  validateTopicKeyLocal(topic.key, `${where}.key`);
  checkText(topic.expectedRevision, `${where}.expectedRevision`, { min: 1, max: 16384 });
  checkText(topic.before, `${where}.before`, { min: 0 });
  checkText(topic.after, `${where}.after`, { min: 0 });
  checkText(topic.title, `${where}.title`, { min: 1 });
  checkText(topic.summary, `${where}.summary`, { min: 0, max: 60 });
  if (topic.summary.includes('\n') || topic.summary.includes('\r')) {
    fail('INVALID_INPUT', `${where}.summary 不得含换行`);
  }
  checkText(topic.updated, `${where}.updated`, { min: 1 });
  return topic;
}

/** 对外部传入 plan 计算 digest（先做完整结构校验，防止对非协议值求指纹）。 */
export function digestPlan(plan) {
  validatePlanShape(plan);
  return digest(plan);
}

// --- link 草案 -------------------------------------------------------------

function buildLinkDraft(candidate, recordsById, proposal) {
  assertExactKeys(proposal, ['kind', 'links'], 'proposal');
  if (!Array.isArray(proposal.links) || proposal.links.length === 0) {
    fail('INVALID_INPUT', 'proposal.links 必须是非空数组');
  }
  if (proposal.links.length > MAX_CHANGED_ITEMS) {
    fail('INVALID_INPUT', `proposal.links 超过单轮 ${MAX_CHANGED_ITEMS} 上限（实际 ${proposal.links.length}）`);
  }

  const sourceIds = new Set(candidate.sources.map((ref) => ref.id));
  const seenEntryIds = new Set();
  const entries = [];
  for (let i = 0; i < proposal.links.length; i += 1) {
    const entry = proposal.links[i];
    assertExactKeys(entry, ['id', 'after'], `proposal.links[${i}]`);
    // 被改源必须是候选源中的卡
    if (!sourceIds.has(entry.id)) {
      fail('INVALID_INPUT', `proposal.links[${i}].id "${entry.id}" 必须是 candidate.sources 中的卡`);
    }
    if (seenEntryIds.has(entry.id)) {
      fail('INVALID_INPUT', `proposal.links 存在重复被改源 "${entry.id}"`);
    }
    seenEntryIds.add(entry.id);
    if (!Array.isArray(entry.after) || entry.after.length === 0) {
      fail('INVALID_INPUT', `proposal.links[${i}].after 必须是非空数组`);
    }
    // 规范化之前先拒绝重复 (target,rel) 输入；同时禁止自环与未知目标
    const seenPairs = new Set();
    for (let j = 0; j < entry.after.length; j += 1) {
      const pair = entry.after[j];
      assertExactKeys(pair, ['target', 'rel'], `proposal.links[${i}].after[${j}]`);
      validateSparkIdLocal(pair.target, `proposal.links[${i}].after[${j}].target`);
      checkText(pair.rel, `proposal.links[${i}].after[${j}].rel`, { min: 1, max: CARD_LIMITS.relChars });
      if (pair.rel.trim() === '') {
        fail('INVALID_INPUT', `proposal.links[${i}].after[${j}].rel 不得为纯空白`);
      }
      if (pair.target === entry.id) {
        fail('INVALID_INPUT', `proposal.links[${i}].after[${j}] 不允许自环（target === 被改源 "${entry.id}"）`);
      }
      const key = linkKey(pair);
      if (seenPairs.has(key)) {
        fail('INVALID_INPUT', `proposal.links[${i}].after 重复 (target,rel)：(${pair.target},${pair.rel})，规范化前拒绝`);
      }
      seenPairs.add(key);
      if (!recordsById.has(pair.target)) {
        fail('NOT_FOUND', `link 目标 "${pair.target}" 不在传入的完整 active records 中（须同 scope、active）`, {
          target: pair.target,
        });
      }
    }

    const record = recordsById.get(entry.id);
    // 保留全部 before 边：after = before ∪ 新增，按 target 再 rel 排序。
    // active 卡的既有边指向已退休/未随行传入的卡是合法数据形态（store 的
    // archive 只改目标状态、不改入边）。隐式保留的 before 边目标同样必须
    // 在 records 中：缺失时按契约返回 NOT_FOUND —— 不静默丢边、不抛原生
    // TypeError（a1 反例 K-3）。
    const before = record.links.map((l) => ({ target: l.target, rel: l.rel }));
    for (const l of before) {
      if (!recordsById.has(l.target)) {
        fail('NOT_FOUND', `被改源 "${entry.id}" 的既有边目标 "${l.target}" 不在传入的完整 active records 中，无法绑定 revision（请将全部被引用卡纳入 records，或先清理该边）`, {
          target: l.target, sourceId: entry.id,
        });
      }
    }
    const beforeKeys = new Set(before.map(linkKey));
    const afterMap = new Map(before.map((l) => [linkKey(l), { target: l.target, rel: l.rel }]));
    let added = 0;
    for (const key of seenPairs) {
      if (!beforeKeys.has(key)) added += 1;
    }
    if (added === 0) {
      fail('INVALID_INPUT', `proposal.links[${i}] 对 "${entry.id}" 没有新增边（拒绝无变化草案）`);
    }
    for (const pair of entry.after) afterMap.set(linkKey(pair), { target: pair.target, rel: pair.rel });
    const after = [...afterMap.values()].sort(compareLinks);
    if (after.length > CARD_LIMITS.linksMax) {
      fail('INVALID_INPUT', `"${entry.id}" 合并后 links 将达 ${after.length} 项，超过存储上限 ${CARD_LIMITS.linksMax}`);
    }
    entries.push({
      id: entry.id,
      expectedRevision: record.revision,
      before,
      after,
    });
  }

  entries.sort((a, b) => byCodepoint(a.id, b.id));

  // sources = 候选全部源 ∪ 被改源 ∪ 全部引用目标；候选源、after 新增目标与
  // 隐式保留的 before 目标均已逐一校验存在于 records，此处再留一道组装防御。
  const sourceIdSet = new Set(candidate.sources.map((ref) => ref.id));
  for (const entry of entries) {
    sourceIdSet.add(entry.id);
    for (const l of entry.after) sourceIdSet.add(l.target);
  }
  const sources = [...sourceIdSet].sort(byCodepoint).map((id) => {
    const record = recordsById.get(id);
    if (record === undefined) {
      fail('NOT_FOUND', `引用目标 "${id}" 不在传入的完整 active records 中，无法绑定 revision`, {
        target: id,
      });
    }
    return { id, revision: record.revision };
  });

  const plan = {
    version: 1,
    scopeId: candidate.scopeId,
    candidateId: candidate.id,
    kind: 'link',
    sources,
    links: entries,
  };
  const diff = entries.map((entry) => ({
    path: `spark:${entry.id}`,
    oldText: stable(entry.before),
    newText: stable(entry.after),
  }));
  return { plan, diff, changedItems: entries.length };
}

// --- merge-topic 草案 ------------------------------------------------------

function buildMergeTopicDraft(candidate, recordsById, proposal) {
  assertExactKeys(proposal, ['kind', 'topic'], 'proposal');
  const topic = proposal.topic;
  assertExactKeys(topic, ['key', 'expectedRevision', 'before', 'after', 'title', 'summary', 'updated'], 'proposal.topic');
  validatePlanTopic(topic, 'proposal.topic');

  if (candidate.kind !== 'cluster') {
    fail('INVALID_INPUT', `merge-topic 草案要求 cluster 候选（得到 kind=${JSON.stringify(candidate.kind)}）`);
  }
  if (candidate.sources.length < 8 || candidate.sources.length > 19) {
    fail('INVALID_INPUT', `merge-topic 草案要求 cluster 候选源数量在 8..19（实际 ${candidate.sources.length}）`);
  }

  // append-only：after 必须以 before 为前缀
  if (!topic.after.startsWith(topic.before)) {
    fail('INVALID_INPUT', 'proposal.topic.after 必须保留 before 全文（append only）');
  }

  // 源保全块：只包含本次 sources，按 id 排序，完整十个字段，数组保持原顺序
  const projected = candidate.sources.map((ref) => projectRecordForBlock(recordsById.get(ref.id)));
  const block = SOURCES_BLOCK_OPEN + stable(projected) + SOURCES_BLOCK_CLOSE;

  let finalAfter;
  if (topic.after.includes(block)) {
    finalAfter = topic.after; // 已存在完全相同块，不重复追加
  } else if (topic.after.includes(SOURCES_MARKER) || topic.after.includes(SOURCES_CLOSE_MARKER)) {
    fail('INVALID_INPUT', 'proposal.topic.after 已含不同内容的源保全块标记，拒绝叠加第二个块（正文以既有块为准需人工处理）');
  } else {
    finalAfter = topic.after + block;
  }

  const plan = {
    version: 1,
    scopeId: candidate.scopeId,
    candidateId: candidate.id,
    kind: 'merge-topic',
    sources: deepClone(candidate.sources),
    topic: {
      key: topic.key,
      expectedRevision: topic.expectedRevision,
      before: topic.before,
      after: finalAfter,
      title: topic.title,
      summary: topic.summary,
      updated: topic.updated,
    },
  };
  const diff = [
    { path: `topic:${topic.key}`, oldText: topic.before, newText: finalAfter },
    ...candidate.sources.map((ref) => {
      const record = recordsById.get(ref.id);
      const before = stable({ ...projectRecordForBlock(record), state: record.state });
      const after = stable({
        ...projectRecordForBlock(record),
        state: 'merged',
        revision: record.revision + 1,
      });
      return { path: `spark:${ref.id}`, oldText: before, newText: after };
    }),
  ];
  return { plan, diff, changedItems: candidate.sources.length + 1 };
}

// --- thin-core 草案 --------------------------------------------------------

function buildThinCoreDraft(candidate, proposal) {
  assertExactKeys(proposal, ['kind', 'before', 'after'], 'proposal');
  checkText(proposal.before, 'proposal.before', { min: 0 });
  checkText(proposal.after, 'proposal.after', { min: 0 });
  const plan = {
    version: 1,
    scopeId: candidate.scopeId,
    candidateId: candidate.id,
    kind: 'thin-core',
    sources: deepClone(candidate.sources),
    core: { before: proposal.before, after: proposal.after },
  };
  // 仅展示草案：changedItems 恒为 0；K 不读写真实 L1，不做自动删减，执行器必须拒绝执行。
  const diff = [{ path: 'core', oldText: proposal.before, newText: proposal.after }];
  return { plan, diff, changedItems: 0 };
}

// ---------------------------------------------------------------------------

/**
 * 构建审阅草案。所有 candidate 重新核验 id 与 scope；records 必须含全部被引用卡
 * （候选源、被改源、link 的全部边目标——含隐式保留的既有边目标），且 revision
 * 全部吻合（陈旧源 / 缺失源拒绝）；返回的 diff 仅是展示内容，
 * 不注入批准 / 执行状态。
 *
 * @param {object} input
 * @param {object} input.candidate  J 槽形状的候选（id 重算核验）
 * @param {Array}  input.records    完整 active 卡记录（store.listActive 形状）
 * @param {object} input.proposal   {kind:'link'|'merge-topic'|'thin-core', ...}
 * @returns {{plan, digest, diff, changedItems}}
 */
export function buildDraft(input) {
  if (!isPlainObject(input)) {
    fail('INVALID_INPUT', 'buildDraft 参数必须是对象');
  }
  assertExactKeys(input, ['candidate', 'records', 'proposal'], 'buildDraft 参数');
  const { candidate, records, proposal } = input;

  validateCandidate(candidate, candidate?.scopeId, 'candidate');
  assertProtocolJson(records, 'records');
  if (!Array.isArray(records)) {
    fail('INVALID_INPUT', 'records 必须是数组（完整 active card 记录列表）');
  }
  const recordsById = new Map();
  for (let i = 0; i < records.length; i += 1) {
    validateRecord(records[i], candidate.scopeId, `records[${i}]`);
    if (recordsById.has(records[i].id)) {
      fail('INVALID_INPUT', `records 存在重复 id "${records[i].id}"`);
    }
    recordsById.set(records[i].id, records[i]);
  }

  // 候选源覆盖：缺失 -> NOT_FOUND；revision 不吻合 -> REVISION_CONFLICT（陈旧源）
  for (const ref of candidate.sources) {
    const record = recordsById.get(ref.id);
    if (record === undefined) {
      fail('NOT_FOUND', `候选源 "${ref.id}" 不在传入 records 中，无法绑定 revision`, { id: ref.id });
    }
    if (record.revision !== ref.revision) {
      fail('REVISION_CONFLICT', `候选源 "${ref.id}" revision 陈旧（候选绑定 ${ref.revision}，records 当前 ${record.revision}）`, {
        id: ref.id, candidateRevision: ref.revision, recordRevision: record.revision,
      });
    }
  }

  assertProtocolJson(proposal, 'proposal');
  if (!isPlainObject(proposal)) fail('INVALID_INPUT', 'proposal 必须是普通对象');
  if (typeof proposal.kind !== 'string' || !PLAN_KINDS.has(proposal.kind)) {
    fail('INVALID_INPUT', 'proposal.kind 必须是 link/merge-topic/thin-core');
  }

  let built;
  if (proposal.kind === 'link') {
    built = buildLinkDraft(candidate, recordsById, proposal);
  } else if (proposal.kind === 'merge-topic') {
    built = buildMergeTopicDraft(candidate, recordsById, proposal);
  } else {
    built = buildThinCoreDraft(candidate, proposal);
  }

  validatePlanShape(built.plan); // 自检：Plan 无未知字段、无 digest/approval/operationId
  return {
    plan: built.plan,
    digest: digest(built.plan),
    diff: built.diff,
    changedItems: built.changedItems,
  };
}

/**
 * P-B：forgetting 归档计划的展示 diff——与 merge-topic 的源卡条目同形状
 * （path `spark:<id>`；oldText/newText 为投影卡记录 + state/revision 的
 * stable JSON）。执行时 createForgetExecutor 负责 CAS 与 archivedAt/rev+1
 * 的真实落盘；本 diff 仅是确认前的展示内容。recordsById 必须来自与 plan
 * 同一次分析的 listActive 快照（卡缺失/revision 漂移都 fail-closed，不猜测）。
 *
 * @param {object} plan analyzeForgetting 产出的 archive-ephemeral plan
 * @param {Map<string, object>} recordsById 卡 id -> 完整 active 记录
 * @returns {Array<{path: string, oldText: string, newText: string}>}
 */
export function buildForgetArchiveDiff(plan, recordsById) {
  if (!isPlainObject(plan) || plan.kind !== 'archive-ephemeral') {
    fail('INVALID_INPUT', 'buildForgetArchiveDiff 需要 archive-ephemeral plan');
  }
  if (!isPlainObject(recordsById) && !(recordsById instanceof Map)) {
    fail('INVALID_INPUT', 'recordsById 必须是普通对象或 Map');
  }
  const get = typeof recordsById.get === 'function'
    ? (id) => recordsById.get(id)
    : (id) => recordsById[id];
  return plan.sources.map((ref) => {
    const record = get(ref.id);
    if (record === undefined) {
      fail('INVALID_STATE', `归档计划源卡 "${ref.id}" 不在分析快照中，拒绝生成展示 diff`, { id: ref.id });
    }
    if (record.revision !== ref.revision) {
      fail('REVISION_CONFLICT', `归档计划源卡 "${ref.id}" revision 漂移（plan 绑定 ${ref.revision}，快照 ${record.revision}）`, {
        id: ref.id, planRevision: ref.revision, recordRevision: record.revision,
      });
    }
    const projected = projectRecordForBlock(record);
    const before = stable({ ...projected, state: record.state });
    const after = stable({
      ...projected,
      state: 'archived',
      revision: record.revision + 1,
    });
    return { path: `spark:${ref.id}`, oldText: before, newText: after };
  });
}
