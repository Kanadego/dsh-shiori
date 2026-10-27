// Shiori P2-SPARKS · L2 Spark 卡片持久存储（G 槽位）
//
// 磁盘布局（root 为调用方显式提供的 sparks 根，全部由本模块创建）：
//   <root>/sparks/.shiori-lock[.guard]        跨进程写锁（复用 P1 lockfile 协议，
//                                              锁域仅限 sparks 子树，不触碰 P1 storage 根）
//   <root>/sparks/scopes/<scopeId>/sparks.json 单文件 scope 数据库
//
// 并发模型（重要边界，详见 docs/sparks/storage.md）：
//   - 写操作（save/update/forget/feedback）全程持跨进程锁后串行执行；
//   - 读操作（read/listActive/graph）无锁，依赖「临时文件 + fsync + rename」
//     的原子替换快照，只会看到旧库或新库二者之一，不存在撕裂读；
//   - 锁争用超时抛 LOCK_BUSY；本模块不自动抢夺疑似崩溃的锁（fail-closed，
//     由 P1 锁协议决定回收语义）。
//
// 恢复规则：
//   - 每次变更 = 单次原子替换（旧库或新库，无中间态），无需 journal；
//   - 打开与每次读写都会重新加载并严格校验数据库：损坏 / 空 / 非法 UTF-8 /
//     schema 不识别 / 字段形状不对 / 悬空引用一律 INVALID_STATE（或 UNSUPPORTED），
//     绝不静默归零、绝不吞错回成功。
//
// 幂等：
//   - 每个写操作可带 operationId：同 key 同语义请求重放返回首次结果快照；
//     同 key 不同语义请求拒绝（INVALID_INPUT）；
//   - feedback 另按 (cardId, sourceEventId) 事件去重，同一事件不重复计数。
//
// 本实现为零第三方依赖的纯文件方案；不探测 node:sqlite（未验证宿主能力前
// 不做任何 sqlite 假设），UNSUPPORTED 保留给「未来 schema 版本」场景。

import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  atomicReplace, assertEncodableUtf8, decodeUtf8Strict, stableStringify, sha256Buffer,
} from '../storage/fsutil.mjs';
import {
  validateScopeId, validateOperationId, assertNoCaseCollision,
  assertNoEscapeViaSymlink, assertRealInsideRoot,
} from '../storage/paths.mjs';
import { withLock } from '../storage/lockfile.mjs';
import {
  invalidInput, invalidState, revisionConflict, notFound, unsupported, wrapIoError,
} from './errors.mjs';

const DB_KIND = 'shiori-sparks-scope';
const SCHEMA_VERSION = 1;
const DB_FILE_NAME = 'sparks.json';
const AUTO_ID_PREFIX = 'spk-';

const VITALITIES = new Set(['evergreen', 'ephemeral']);
// merged 本批次没有写入路径，仅作为已知状态值放行（投影层统一只认 active）。
const CARD_STATES = new Set(['active', 'archived', 'superseded', 'merged']);

const LIMITS = Object.freeze({
  idChars: 64,
  titleChars: 80,
  summaryChars: 120,
  contentChars: 2000,
  wordChars: 64,   // triggers / entities 单词
  relChars: 64,    // link.rel
  triggersMax: 32,
  entitiesMax: 32,
  linksMax: 32,
});

// 与 P1 paths.mjs 的文件名规则同源：禁止 Windows 保留设备名做首段
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);
// 会成为 db 对象键的名字一律拒绝原型链保留名，防原型污染
const RESERVED_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// save 允许的输入键；patch 允许的可变字段
const SAVE_FIELDS = new Set(['id', 'title', 'summary', 'content', 'triggers', 'entities', 'links', 'vitality']);
const MUTABLE_FIELDS = new Set(['title', 'summary', 'content', 'triggers', 'entities', 'links', 'vitality']);
// payload 出现这些键 = 试图越权/改系统字段，一律拒绝并给出明确文案
const SENSITIVE_FIELDS = new Set(['scopeId', 'scope', 'root', 'dataRoot']);
const SYSTEM_FIELDS = new Set([
  'id', 'revision', 'state', 'createdAt', 'updatedAt', 'archivedAt',
  'supersedes', 'supersededBy', 'hitCount', 'lastHitAt', 'useCount', 'lastUsedAt',
  ...SENSITIVE_FIELDS,
]);

const nowIso = () => new Date().toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// 标识符与基础校验
// ---------------------------------------------------------------------------

function validateSparkId(id, field = 'id') {
  if (typeof id !== 'string' || id.length === 0) {
    throw invalidInput(`${field} 必须是非空字符串`);
  }
  if (id.length > LIMITS.idChars) {
    throw invalidInput(`${field} 超 ${LIMITS.idChars} UTF-16（实际 ${id.length}）`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw invalidInput(`${field} 只允许字母/数字/点/下划线/连字符且以字母数字开头`, { value: id });
  }
  if (id.endsWith('.')) {
    throw invalidInput(`${field} 不得以点结尾（Windows 语义）`, { value: id });
  }
  if (RESERVED_JSON_KEYS.has(id)) {
    throw invalidInput(`${field} 与对象键保留名冲突`, { value: id });
  }
  const stem = id.replace(/\.[A-Za-z0-9_-]+$/, '').toUpperCase();
  if (WINDOWS_RESERVED.has(stem)) {
    throw invalidInput(`${field} 与 Windows 保留设备名冲突`, { value: id });
  }
  return id;
}

function validateEventId(sourceEventId) {
  // 与 operationId 同规则；独立函数以便错误文案准确
  try {
    return validateOperationId(sourceEventId);
  } catch (err) {
    const e = invalidInput(`sourceEventId 非法：${err.message}`, { sourceEventId });
    e.cause = err;
    throw e;
  }
}

function checkString(value, field, { min, max, where }) {
  if (typeof value !== 'string') {
    throw invalidInput(`${where}.${field} 必须是字符串，得到 ${value === null ? 'null' : typeof value}`);
  }
  if (value.length < min || value.length > max) {
    throw invalidInput(`${where}.${field} 长度必须在 ${min}..${max} UTF-16（实际 ${value.length}）`);
  }
  assertEncodableUtf8(value, `${where}.${field}`);
  return value;
}

function checkWordArray(value, field, { where, maxCount }) {
  if (!Array.isArray(value)) {
    throw invalidInput(`${where}.${field} 必须是字符串数组`);
  }
  if (value.length > maxCount) {
    throw invalidInput(`${where}.${field} 最多 ${maxCount} 项（实际 ${value.length}）`);
  }
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      throw invalidInput(`${where}.${field} 的每一项必须是字符串`);
    }
    if (raw.length === 0 || raw.length > LIMITS.wordChars) {
      throw invalidInput(`${where}.${field} 的每一项长度必须在 1..${LIMITS.wordChars} UTF-16`);
    }
    if (raw.trim() === '') {
      throw invalidInput(`${where}.${field} 的每一项不得为纯空白`);
    }
    assertEncodableUtf8(raw, `${where}.${field} 项`);
    if (!seen.has(raw)) { seen.add(raw); out.push(raw); } // 原样保留，仅去重
  }
  return out;
}

function checkLinks(value, field, { where }) {
  if (!Array.isArray(value)) {
    throw invalidInput(`${where}.${field} 必须是 {target, rel} 数组`);
  }
  if (value.length > LIMITS.linksMax) {
    throw invalidInput(`${where}.${field} 最多 ${LIMITS.linksMax} 项（实际 ${value.length}）`);
  }
  const seen = new Set();
  const out = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      throw invalidInput(`${where}.${field} 的每一项必须是对象`);
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'target' && key !== 'rel') {
        throw invalidInput(`${where}.${field} 项只允许 target/rel 字段，未知键 "${key}"`);
      }
    }
    const target = validateSparkId(entry.target, `${field}.target`);
    const rel = checkString(entry.rel, 'rel', { min: 1, max: LIMITS.relChars, where: `${where}.${field}` });
    if (rel.trim() === '') {
      throw invalidInput(`${where}.${field}.rel 不得为纯空白`);
    }
    const key = `${target}\u0000${rel}`;
    if (!seen.has(key)) { seen.add(key); out.push({ target, rel }); }
  }
  return out;
}

function checkVitality(value, where) {
  if (!VITALITIES.has(value)) {
    throw invalidInput(`${where}.vitality 必须是 evergreen 或 ephemeral`, { value });
  }
  return value;
}

/**
 * 拒绝未知键；对越权键（scopeId/root 等）与系统字段给出明确文案。
 * allowed 为该上下文合法的键集合。
 */
function assertOnlyKeys(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (allowed.has(key)) continue;
    if (SENSITIVE_FIELDS.has(key)) {
      throw invalidInput(`${where} 不能携带 "${key}"：scope 由 openSparkStore 绑定，payload 无权决定`, { key });
    }
    if (SYSTEM_FIELDS.has(key)) {
      throw invalidInput(`${where} 不能修改系统字段 "${key}"`, { key });
    }
    throw invalidInput(`${where} 含未知字段 "${key}"`, { key });
  }
}

/**
 * 字段在场判定：显式 undefined 视为未提供（展开默认值对象的常见形态），
 * 其余值（含 null）按提供处理并交给各字段校验器报错。
 */
const hasField = (obj, key) => Object.hasOwn(obj, key) && obj[key] !== undefined;

function validateSaveInput(input) {
  if (!isPlainObject(input)) {
    throw invalidInput(`save input 必须是对象，得到 ${input === null ? 'null' : typeof input}`);
  }
  assertOnlyKeys(input, SAVE_FIELDS, 'save input');
  const out = {};
  if (hasField(input, 'id')) out.id = validateSparkId(input.id);
  out.title = checkString(input.title, 'title', { min: 1, max: LIMITS.titleChars, where: 'save input' });
  out.summary = hasField(input, 'summary')
    ? checkString(input.summary, 'summary', { min: 0, max: LIMITS.summaryChars, where: 'save input' })
    : '';
  out.content = checkString(input.content, 'content', { min: 1, max: LIMITS.contentChars, where: 'save input' });
  if (!Array.isArray(input.triggers)) {
    throw invalidInput('save input.triggers 必须提供（可为空数组，空触发词的卡不会成为匹配种子）');
  }
  out.triggers = checkWordArray(input.triggers, 'triggers', { where: 'save input', maxCount: LIMITS.triggersMax });
  out.entities = hasField(input, 'entities')
    ? checkWordArray(input.entities, 'entities', { where: 'save input', maxCount: LIMITS.entitiesMax })
    : [];
  out.links = hasField(input, 'links')
    ? checkLinks(input.links, 'links', { where: 'save input' })
    : [];
  out.vitality = checkVitality(input.vitality, 'save input');
  return out;
}

function validatePatch(patch) {
  if (!isPlainObject(patch)) {
    throw invalidInput(`update patch 必须是对象，得到 ${patch === null ? 'null' : typeof patch}`);
  }
  assertOnlyKeys(patch, MUTABLE_FIELDS, 'update patch');
  const keys = Object.keys(patch).filter((k) => MUTABLE_FIELDS.has(k) && patch[k] !== undefined);
  if (keys.length === 0) {
    throw invalidInput('update patch 至少包含一个可修改字段（title/summary/content/triggers/entities/links/vitality）');
  }
  const out = {};
  if (hasField(patch, 'title')) out.title = checkString(patch.title, 'title', { min: 1, max: LIMITS.titleChars, where: 'update patch' });
  if (hasField(patch, 'summary')) out.summary = checkString(patch.summary, 'summary', { min: 0, max: LIMITS.summaryChars, where: 'update patch' });
  if (hasField(patch, 'content')) out.content = checkString(patch.content, 'content', { min: 1, max: LIMITS.contentChars, where: 'update patch' });
  if (hasField(patch, 'triggers')) out.triggers = checkWordArray(patch.triggers, 'triggers', { where: 'update patch', maxCount: LIMITS.triggersMax });
  if (hasField(patch, 'entities')) out.entities = checkWordArray(patch.entities, 'entities', { where: 'update patch', maxCount: LIMITS.entitiesMax });
  if (hasField(patch, 'links')) out.links = checkLinks(patch.links, 'links', { where: 'update patch' });
  if (hasField(patch, 'vitality')) out.vitality = checkVitality(patch.vitality, 'update patch');
  return out;
}

// ---------------------------------------------------------------------------
// 数据库加载 / 校验 / 持久化
// ---------------------------------------------------------------------------

function emptyDb(scopeId) {
  return {
    kind: DB_KIND,
    schemaVersion: SCHEMA_VERSION,
    scopeId,
    generation: 0,
    cards: {},
    ops: {},
    feedback: {},
  };
}

function invalidDb(problem, file, extra = {}) {
  return invalidState(`sparks 数据库校验失败：${problem}（拒绝静默归零/静默重建，需人工检查）`, { file, ...extra });
}

function validateCardShape(card, key, scopeId, cards, file) {
  const at = (v) => typeof v === 'string' || v === null;
  const fail = (problem) => { throw invalidDb(`卡片 "${key}" 记录损坏：${problem}`, file, { card: key }); };
  if (!isPlainObject(card)) fail('不是对象');
  if (card.id !== key) fail(`id 字段 (${JSON.stringify(card.id)}) 与键不一致`);
  if (card.scopeId !== scopeId) fail(`scopeId 不属于本 scope (${JSON.stringify(card.scopeId)})`);
  if (typeof card.title !== 'string' || card.title.length === 0) fail('title 缺失或为空');
  if (typeof card.summary !== 'string') fail('summary 缺失');
  if (typeof card.content !== 'string' || card.content.length === 0) fail('content 缺失或为空');
  if (!Number.isInteger(card.revision) || card.revision < 1) fail(`revision 非正整数 (${JSON.stringify(card.revision)})`);
  if (!VITALITIES.has(card.vitality)) fail(`vitality 非法 (${JSON.stringify(card.vitality)})`);
  if (!CARD_STATES.has(card.state)) fail(`state 非法 (${JSON.stringify(card.state)})`);
  if (!Array.isArray(card.triggers) || card.triggers.some((t) => typeof t !== 'string' || t.length === 0)) fail('triggers 损坏');
  if (!Array.isArray(card.entities) || card.entities.some((t) => typeof t !== 'string' || t.length === 0)) fail('entities 损坏');
  if (!Array.isArray(card.links)) fail('links 损坏');
  for (const l of card.links) {
    if (!isPlainObject(l) || typeof l.target !== 'string' || typeof l.rel !== 'string' || l.rel.length === 0) {
      fail('links 项形状损坏');
    }
    if (!Object.hasOwn(cards, l.target)) fail(`悬空 link 目标 "${l.target}"（本存储从不物理删除卡片，悬空即损坏）`);
  }
  // G1 防线（加载时）：supersedes/supersededBy 必须双向一致且指向正确的状态，
  // replacement 必须仍是 active——断裂链条 fail-closed，绝不当作健康库加载。
  if (card.supersedes !== null) {
    const original = cards[card.supersedes];
    if (original === undefined || original.state !== 'superseded' || original.supersededBy !== key) {
      fail(`supersedes 指向 "${card.supersedes}" 但对侧替代关系不一致或缺失`);
    }
  }
  if (card.supersededBy !== null) {
    const replacement = cards[card.supersededBy];
    if (replacement === undefined || replacement.state !== 'active' || replacement.supersedes !== key) {
      fail(`supersededBy 指向 "${card.supersededBy}" 但对侧不是 active 的承接卡`);
    }
  }
  if (!Number.isInteger(card.hitCount) || card.hitCount < 0) fail('hitCount 损坏');
  if (!Number.isInteger(card.useCount) || card.useCount < 0) fail('useCount 损坏');
  if (typeof card.createdAt !== 'string') fail('createdAt 损坏');
  if (typeof card.updatedAt !== 'string') fail('updatedAt 损坏');
  if (!at(card.archivedAt) || !at(card.lastHitAt) || !at(card.lastUsedAt)) fail('时间戳字段损坏');
  return card;
}

function validateLoadedDb(db, expectedScopeId, file) {
  if (!isPlainObject(db)) throw invalidDb('顶层不是对象', file);
  if (db.kind !== DB_KIND) throw invalidDb(`kind 不匹配（期望 ${DB_KIND}，得到 ${JSON.stringify(db.kind)}）`, file);
  if (!Number.isInteger(db.schemaVersion)) throw invalidDb('schemaVersion 非整数', file);
  if (db.schemaVersion > SCHEMA_VERSION) {
    throw unsupported(`sparks 数据库 schema 版本 ${db.schemaVersion} 来自更新版本，当前实现只支持 <= ${SCHEMA_VERSION}`, { file, schemaVersion: db.schemaVersion });
  }
  if (db.schemaVersion !== SCHEMA_VERSION) throw invalidDb(`schemaVersion 非法 (${db.schemaVersion})`, file);
  if (db.scopeId !== expectedScopeId) {
    throw invalidDb(`scopeId 不匹配（文件属于 "${db.scopeId}"，本 store 绑定 "${expectedScopeId}"）`, file);
  }
  if (!Number.isInteger(db.generation) || db.generation < 0) throw invalidDb('generation 损坏', file);
  if (!isPlainObject(db.cards)) throw invalidDb('cards 缺失或不是对象', file);
  if (!isPlainObject(db.ops)) throw invalidDb('ops 缺失或不是对象', file);
  if (!isPlainObject(db.feedback)) throw invalidDb('feedback 缺失或不是对象', file);

  for (const key of Object.keys(db.cards)) {
    validateSparkId(key, 'cards 键');
    validateCardShape(db.cards[key], key, expectedScopeId, db.cards, file);
  }
  for (const [opId, op] of Object.entries(db.ops)) {
    if (!isPlainObject(op) || typeof op.kind !== 'string' || op.kind.length === 0
      || typeof op.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(op.fingerprint)
      || typeof op.at !== 'string' || !isPlainObject(op.result)) {
      throw invalidDb(`操作记录 "${opId}" 损坏`, file);
    }
  }
  for (const [cardId, events] of Object.entries(db.feedback)) {
    if (!Object.hasOwn(db.cards, cardId)) throw invalidDb(`feedback 记录指向不存在的卡 "${cardId}"`, file);
    if (!isPlainObject(events)) throw invalidDb(`feedback["${cardId}"] 不是对象`, file);
    for (const [eventId, ev] of Object.entries(events)) {
      if (!isPlainObject(ev) || typeof ev.used !== 'boolean' || typeof ev.at !== 'string') {
        throw invalidDb(`feedback 事件 "${cardId}/${eventId}" 损坏`, file);
      }
    }
  }
  return db;
}

/** 加载 scope 数据库；文件不存在返回 null；损坏/占用/IO 异常一律抛错。 */
async function loadDb(dbFile, expectedScopeId) {
  let stat;
  try {
    stat = await fsp.lstat(dbFile);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw wrapIoError('sparks 数据库 lstat', err);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw invalidState('数据库路径被符号链接或目录占用，拒绝读取/静默重建', { file: dbFile });
  }
  let buf;
  try {
    buf = await fsp.readFile(dbFile);
  } catch (err) {
    throw wrapIoError('sparks 数据库读取', err);
  }
  if (buf.length === 0) {
    throw invalidState('数据库文件为空（0 字节），疑似损坏：拒绝静默归零', { file: dbFile });
  }
  const text = decodeUtf8Strict(buf, dbFile); // 非法 UTF-8 → INVALID_STATE
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const e = invalidState('数据库文件不是合法 JSON，疑似损坏：拒绝静默归零', { file: dbFile });
    e.cause = err;
    throw e;
  }
  return validateLoadedDb(parsed, expectedScopeId, dbFile);
}

async function persistDb(dbFile, db) {
  // stableStringify 键排序 → 相同逻辑库得到相同字节，便于 diff 与哈希校验
  const text = `${stableStringify(db)}\n`;
  await atomicReplace(dbFile, Buffer.from(text, 'utf8'));
}

const fingerprintOf = (payload) => sha256Buffer(Buffer.from(stableStringify(payload), 'utf8'));

// ---------------------------------------------------------------------------
// 管理目录准备
// ---------------------------------------------------------------------------

async function realpathChecked(p, where) {
  try {
    return await fsp.realpath(p);
  } catch (err) {
    throw wrapIoError(`${where} realpath`, err);
  }
}

async function ensureManagedDir(domainReal, segments) {
  const target = path.join(domainReal, ...segments);
  await assertNoEscapeViaSymlink(domainReal, target);
  let st = null;
  try {
    st = await fsp.lstat(target);
  } catch (err) {
    if (err.code !== 'ENOENT') throw wrapIoError('sparks 目录检查', err);
  }
  if (st && (st.isSymbolicLink() || !st.isDirectory())) {
    throw invalidState(`管理路径被符号链接/非目录占用：${segments.join(path.sep)}`, { path: target });
  }
  try {
    await fsp.mkdir(target, { recursive: true });
  } catch (err) {
    throw wrapIoError('sparks 目录创建', err);
  }
  return target;
}

// ---------------------------------------------------------------------------
// 卡片构建与语义检查（在持锁加载的 db 上执行）
// ---------------------------------------------------------------------------

function buildCard(id, scopeId, norm, at) {
  return {
    id,
    scopeId,
    revision: 1,
    title: norm.title,
    summary: norm.summary,
    triggers: [...norm.triggers],
    entities: [...norm.entities],
    links: norm.links.map((l) => ({ target: l.target, rel: l.rel })),
    content: norm.content,
    vitality: norm.vitality,
    state: 'active',
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    supersedes: null,
    supersededBy: null,
    hitCount: 0,
    lastHitAt: null,
    useCount: 0,
    lastUsedAt: null,
  };
}

function assertCardActive(card, id, action) {
  if (card.state !== 'active') {
    throw invalidState(`卡片 "${id}" 状态为 ${card.state}，不能 ${action}（仅 active 卡可变更）`, { id, state: card.state });
  }
}

function assertExpectedRevision(card, expectedRevision, id) {
  if (expectedRevision !== undefined && expectedRevision !== card.revision) {
    throw revisionConflict(`卡片 "${id}" revision CAS 失败`, {
      id, expectedRevision, currentRevision: card.revision,
    });
  }
}

function assertLinksValid(links, db, selfId) {
  for (const l of links) {
    if (l.target === selfId) {
      throw invalidInput(`links 不允许 self-link（target === "${selfId}"）`, { target: l.target });
    }
    const target = db.cards[l.target];
    if (target === undefined) {
      throw invalidInput(`link 目标 "${l.target}" 不存在于本 scope（跨 scope 或未知 id 一律拒绝）`, { target: l.target });
    }
    if (target.state !== 'active') {
      throw invalidInput(`link 目标 "${l.target}" 状态为 ${target.state}，仅 active 卡可被链接`, {
        target: l.target, targetState: target.state,
      });
    }
  }
}

function assertNoCaseTwin(db, id) {
  const lower = id.toLowerCase();
  for (const existing of Object.keys(db.cards)) {
    if (existing.toLowerCase() === lower && existing !== id) {
      throw invalidInput(`id 大小写碰撞：本 scope 已存在 "${existing}"，与 "${id}" 在 Windows 语义下互斥`, { existing, attempted: id });
    }
  }
}

function generateCardId(db) {
  for (;;) {
    const id = AUTO_ID_PREFIX + randomBytes(8).toString('hex');
    if (!Object.hasOwn(db.cards, id)) return id;
  }
}

function readOpts(opts, allowedKeys, method) {
  if (opts === undefined) return {};
  if (!isPlainObject(opts)) {
    throw invalidInput(`${method} 的第二参数（opts）必须是对象`);
  }
  for (const key of Object.keys(opts)) {
    if (!allowedKeys.includes(key)) {
      if (SENSITIVE_FIELDS.has(key)) {
        throw invalidInput(`${method} opts 不能携带 "${key}"：scope/root 由 openSparkStore 绑定`, { key });
      }
      throw invalidInput(`${method} opts 含未知键 "${key}"（允许：${allowedKeys.join('/')}）`, { key });
    }
  }
  return opts;
}

function readExpectedRevision(opts, { min }) {
  if (!Object.hasOwn(opts, 'expectedRevision')) return undefined;
  const v = opts.expectedRevision;
  if (!Number.isInteger(v) || v < min) {
    throw invalidInput(`expectedRevision 必须是 >= ${min} 的整数`, { expectedRevision: v });
  }
  return v;
}

// ---------------------------------------------------------------------------
// openSparkStore
// ---------------------------------------------------------------------------

/**
 * 打开绑定到 (root, scopeId) 的 spark 存储。
 *
 * @param {object} params
 * @param {string} params.root    sparks 数据根（绝对路径，显式提供，无隐式默认）
 * @param {string} params.scopeId 绑定的 scope；此后所有读写只发生在此 scope，
 *                                payload 永远无权改变
 * @param {number} [params.lockTimeoutMs] 写锁等待上限，默认 10000
 * @param {number} [params.retryMs]       写锁重试间隔，默认 50
 */
export async function openSparkStore({ root, scopeId, lockTimeoutMs = 10_000, retryMs = 50 }) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw invalidInput('root 必须显式提供（无隐式 home 默认值）');
  }
  if (!path.isAbsolute(root)) {
    throw invalidInput('root 必须是绝对路径', { root });
  }
  validateScopeId(scopeId);
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw invalidInput('lockTimeoutMs 必须是 >= 0 的整数', { lockTimeoutMs });
  }
  if (!Number.isInteger(retryMs) || retryMs <= 0) {
    throw invalidInput('retryMs 必须是正整数', { retryMs });
  }

  try {
    await fsp.mkdir(root, { recursive: true });
  } catch (err) {
    // recursive 只对已存在目录抑制 EEXIST；指向文件/设备时是调用方错误
    if (err.code === 'EEXIST' || err.code === 'ENOTDIR') {
      throw invalidInput('root 已存在但不是可用目录', { root, ioCode: err.code });
    }
    throw wrapIoError('创建 sparks root', err);
  }
  let st;
  try {
    st = await fsp.stat(root);
  } catch (err) {
    throw wrapIoError('检查 sparks root', err);
  }
  if (!st.isDirectory()) {
    throw invalidInput('root 已存在但不是目录', { root });
  }
  const rootReal = await realpathChecked(root, 'sparks root');

  const sparksDir = await ensureManagedDir(rootReal, ['sparks']);
  const sparksReal = await realpathChecked(sparksDir, 'sparks 子树');
  assertRealInsideRoot(rootReal, sparksReal);

  const scopesDir = await ensureManagedDir(sparksReal, ['scopes']);
  const scopesReal = await realpathChecked(scopesDir, 'sparks scopes');
  assertRealInsideRoot(sparksReal, scopesReal);

  // scopes/ 目录大小写互斥（Windows 下 scopes/Amber 会与 scopes/amber 合并）
  await assertNoCaseCollision(scopesReal, scopeId);
  const scopeDir = await ensureManagedDir(sparksReal, ['scopes', scopeId]);

  const dbFile = path.join(scopeDir, DB_FILE_NAME);
  const lockRoot = sparksReal;

  // 打开即严格校验一次：损坏的库在 open 阶段 fail-fast
  await loadDb(dbFile, scopeId);

  let closed = false;
  const ensureOpen = () => {
    if (closed) throw invalidState('spark store 已 close，不能继续使用');
  };
  const lockOpts = { timeoutMs: lockTimeoutMs, retryMs };

  /**
   * 持锁变更：加载（或初始化）→ 幂等检查 → apply → 记录 op → 单次原子落盘。
   * apply 与 op 记录写入同一次原子替换，崩溃后二者要么都在、要么都不在。
   */
  async function runMutation(kind, operationId, fingerprintPayload, apply) {
    ensureOpen();
    return withLock(lockRoot, lockOpts, async () => {
      const db = (await loadDb(dbFile, scopeId)) ?? emptyDb(scopeId);
      if (operationId !== undefined) {
        const prior = db.ops[operationId];
        if (prior !== undefined) {
          if (prior.fingerprint !== fingerprintOf(fingerprintPayload)) {
            throw invalidInput('operationId 已被不同语义的请求使用，拒绝执行', {
              operationId, previousKind: prior.kind, attemptedKind: kind,
            });
          }
          return clone(prior.result); // 重放返回首次结果快照，不反映后续变更
        }
      }
      const result = apply(db);
      db.generation += 1;
      if (operationId !== undefined) {
        db.ops[operationId] = {
          kind,
          fingerprint: fingerprintOf(fingerprintPayload),
          at: nowIso(),
          result: clone(result),
        };
      }
      try {
        await persistDb(dbFile, db);
      } catch (err) {
        throw wrapIoError('sparks 数据库写入', err);
      }
      return clone(result);
    });
  }

  async function loadForRead() {
    ensureOpen();
    return loadDb(dbFile, scopeId);
  }

  const store = {
    /** 新建卡片；期望目标不存在（revision 0）。返回创建的完整记录。 */
    async save(input, opts) {
      ensureOpen();
      const o = readOpts(opts, ['expectedRevision', 'operationId'], 'save');
      if (Object.hasOwn(o, 'operationId')) validateOperationId(o.operationId);
      const expected = readExpectedRevision(o, { min: 0 });
      if (expected !== undefined && expected !== 0) {
        throw invalidInput('save 的 expectedRevision 只能为 0（断言目标不存在）', { expectedRevision: expected });
      }
      const norm = validateSaveInput(input);
      return runMutation('save', o.operationId, { kind: 'save', input: norm, expectedRevision: expected ?? null }, (db) => {
        if (norm.id !== undefined && Object.hasOwn(db.cards, norm.id)) {
          throw revisionConflict(`id "${norm.id}" 已存在于本 scope（save 期望目标不存在）`, {
            id: norm.id, currentRevision: db.cards[norm.id].revision, expectedRevision: 0,
          });
        }
        const id = norm.id !== undefined ? norm.id : generateCardId(db);
        if (norm.id !== undefined) assertNoCaseTwin(db, id);
        assertLinksValid(norm.links, db, id);
        const card = buildCard(id, scopeId, norm, nowIso());
        db.cards[id] = card;
        return card;
      });
    },

    /** 读取单卡（含 archived/superseded，软归档不隐藏）；不存在 → NOT_FOUND。 */
    async read(id) {
      validateSparkId(id, 'id');
      const db = await loadForRead();
      if (db === null || !Object.hasOwn(db.cards, id)) {
        throw notFound(`卡片 "${id}" 不存在于 scope "${scopeId}"`, { id, scopeId });
      }
      return clone(db.cards[id]);
    },

    /** 更新 active 卡的可变字段；revision +1。 */
    async update(id, patch, opts) {
      ensureOpen();
      validateSparkId(id, 'id');
      const o = readOpts(opts, ['expectedRevision', 'operationId'], 'update');
      if (Object.hasOwn(o, 'operationId')) validateOperationId(o.operationId);
      const expected = readExpectedRevision(o, { min: 1 });
      const norm = validatePatch(patch);
      return runMutation('update', o.operationId, { kind: 'update', id, patch: norm, expectedRevision: expected ?? null }, (db) => {
        const card = db.cards[id];
        if (card === undefined) {
          throw notFound(`卡片 "${id}" 不存在于 scope "${scopeId}"`, { id, scopeId });
        }
        assertCardActive(card, id, 'update');
        assertExpectedRevision(card, expected, id);
        if (norm.links !== undefined) assertLinksValid(norm.links, db, id);
        for (const [key, value] of Object.entries(norm)) card[key] = value;
        card.revision += 1;
        card.updatedAt = nowIso();
        return card;
      });
    },

    /**
     * 软遗忘：archive 仅置 archived；supersede 要求 replacementId，
     * 原卡保留并建立有向替代关系（原卡.supersededBy / 新卡.supersedes）。
     * 返回变更后的原卡记录。
     */
    async forget(id, opts) {
      ensureOpen();
      validateSparkId(id, 'id');
      const o = readOpts(opts, ['mode', 'replacementId', 'expectedRevision', 'operationId'], 'forget');
      if (Object.hasOwn(o, 'operationId')) validateOperationId(o.operationId);
      const mode = o.mode;
      if (mode !== 'archive' && mode !== 'supersede') {
        throw invalidInput('forget mode 必须是 "archive" 或 "supersede"', { mode });
      }
      let replacementId;
      if (mode === 'supersede') {
        if (typeof o.replacementId !== 'string') {
          throw invalidInput('supersede 必须提供 replacementId');
        }
        replacementId = validateSparkId(o.replacementId, 'replacementId');
      } else if (Object.hasOwn(o, 'replacementId')) {
        throw invalidInput('archive 模式不接受 replacementId');
      }
      const expected = readExpectedRevision(o, { min: 1 });
      return runMutation(
        'forget',
        o.operationId,
        { kind: 'forget', id, mode, replacementId: replacementId ?? null, expectedRevision: expected ?? null },
        (db) => {
          const card = db.cards[id];
          if (card === undefined) {
            throw notFound(`卡片 "${id}" 不存在于 scope "${scopeId}"`, { id, scopeId });
          }
          assertCardActive(card, id, 'forget');
          // G1 防线：承接了替代关系的 replacement 不能被归档/再替代，
          // 否则原卡的 supersededBy 会指向一张已退休的卡，链条断裂。
          if (card.supersedes !== null) {
            throw invalidState(`卡片 "${id}" 已承接 "${card.supersedes}" 的替代关系，不能被归档或再替代（替代链不允许嵌套）`, {
              id, supersedes: card.supersedes,
            });
          }
          assertExpectedRevision(card, expected, id);
          const at = nowIso();
          if (mode === 'archive') {
            card.state = 'archived';
            card.archivedAt = at;
            card.updatedAt = at;
            card.revision += 1;
          } else {
            if (replacementId === id) {
              throw invalidInput('supersede 的 replacementId 不能指向自身', { replacementId });
            }
            const replacement = db.cards[replacementId];
            if (replacement === undefined) {
              throw invalidInput(`replacementId "${replacementId}" 不存在于本 scope（跨 scope 或未知 id 一律拒绝）`, { replacementId });
            }
            assertCardActive(replacement, replacementId, '作为 replacement');
            if (replacement.supersedes !== null) {
              throw invalidState(`replacement "${replacementId}" 已替代另一张卡，不能再次承接`, { replacementId });
            }
            card.state = 'superseded';
            card.supersededBy = replacementId;
            card.updatedAt = at;
            card.revision += 1;
            replacement.supersedes = id;
            replacement.revision += 1;
            replacement.updatedAt = at;
          }
          return card;
        },
      );
    },

    /**
     * 显式反馈。used=true 时 useCount/lastUsedAt 更新（不动 revision）。
     * 带 sourceEventId 时按 (id, sourceEventId) 事件去重：同一事件重复调用
     * 不重复计数；同一事件携带不同 used 语义 → INVALID_INPUT。
     */
    async feedback(id, opts) {
      ensureOpen();
      validateSparkId(id, 'id');
      const o = readOpts(opts, ['used', 'sourceEventId', 'operationId'], 'feedback');
      if (Object.hasOwn(o, 'operationId')) validateOperationId(o.operationId);
      if (typeof o.used !== 'boolean') {
        throw invalidInput('feedback 必须显式提供布尔 used');
      }
      let sourceEventId;
      if (Object.hasOwn(o, 'sourceEventId')) {
        if (typeof o.sourceEventId !== 'string') {
          throw invalidInput('sourceEventId 必须是字符串');
        }
        sourceEventId = validateEventId(o.sourceEventId);
      }
      return runMutation(
        'feedback',
        o.operationId,
        { kind: 'feedback', id, used: o.used, sourceEventId: sourceEventId ?? null },
        (db) => {
          const card = db.cards[id];
          if (card === undefined) {
            throw notFound(`卡片 "${id}" 不存在于 scope "${scopeId}"`, { id, scopeId });
          }
          // G2 防线：已退休的卡不再参与匹配/投递，反馈统计（无论正负）一律拒绝
          assertCardActive(card, id, 'feedback');
          if (sourceEventId !== undefined) {
            const prior = db.feedback[id]?.[sourceEventId];
            if (prior !== undefined) {
              if (prior.used !== o.used) {
                throw invalidInput(`sourceEventId "${sourceEventId}" 已记录 used=${prior.used}，不能改为 ${o.used}（同 key 不同语义）`, {
                  id, sourceEventId, previousUsed: prior.used,
                });
              }
              return clone(card); // 事件级幂等：不重复计数
            }
            (db.feedback[id] ??= {})[sourceEventId] = { used: o.used, at: nowIso() };
          }
          if (o.used) {
            card.useCount += 1;
            card.lastUsedAt = nowIso();
          }
          return card;
        },
      );
    },

    /** 当前 scope 的 active 卡完整记录，按 id 稳定排序。 */
    async listActive() {
      const db = await loadForRead();
      if (db === null) return [];
      const ids = Object.keys(db.cards).filter((id) => db.cards[id].state === 'active').sort(byCodepoint);
      return ids.map((id) => clone(db.cards[id]));
    },

    /**
     * 当前 scope 的 active 图谱投影：节点带 vitality 标注，
     * 边仅在两端都 active 时可见，去重并稳定排序。不含 content 正文。
     * G3 契约：已接受但因一端退休而不可见的边**不静默消失**——
     * 逐条列入 filteredEdges（reason: source-retired / target-retired）。
     */
    async graph() {
      const db = await loadForRead();
      const cards = db?.cards ?? {};
      const nodes = [];
      const edgeMap = new Map();
      const filteredMap = new Map();
      const pushFiltered = (source, l, reason) => {
        const key = `${source}\u0000${l.target}\u0000${l.rel}`;
        if (!filteredMap.has(key)) filteredMap.set(key, { source, target: l.target, rel: l.rel, reason });
      };
      for (const id of Object.keys(cards).sort(byCodepoint)) {
        const card = cards[id];
        if (card.state !== 'active') {
          for (const l of card.links) pushFiltered(id, l, 'source-retired');
          continue;
        }
        nodes.push({ id: card.id, title: card.title, vitality: card.vitality, revision: card.revision });
        for (const l of card.links) {
          const target = cards[l.target];
          if (target === undefined || target.state !== 'active') {
            // target 缺失在加载校验下不可达；防御性归入 target-retired
            pushFiltered(id, l, 'target-retired');
            continue;
          }
          const key = `${card.id}\u0000${l.target}\u0000${l.rel}`;
          if (!edgeMap.has(key)) edgeMap.set(key, { source: card.id, target: l.target, rel: l.rel });
        }
      }
      const cmpEdge = (a, b) => byCodepoint(a.source, b.source) || byCodepoint(a.target, b.target) || byCodepoint(a.rel, b.rel);
      const edges = [...edgeMap.values()].sort(cmpEdge);
      const filteredEdges = [...filteredMap.values()].sort(cmpEdge);
      return {
        scopeId,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        filteredEdgeCount: filteredEdges.length,
        nodes,
        edges,
        filteredEdges,
      };
    },

    /** 关闭 store（幂等）；此后任何方法调用 → INVALID_STATE。 */
    close() {
      closed = true;
    },
  };

  return store;
}
