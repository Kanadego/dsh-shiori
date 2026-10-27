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
//
// ───────────────────────────────────────────────────────────────────────────
// P3-L 已选择性集成（2026-10-25）：受审执行器内部存储原语
//
// 来源为 L a3 不可变提案；主审验证纯插入增量并备份后合入本生产入口。
// 原提案保存在 phase4/collab/submissions；以下为新增能力：
//
//   1. 新增 store.bindOrganizeRound(plan, {operationId})：把规范 organize plan
//      指纹绑定到 scope DB 的 operations 账（runMutation，不改卡）。
//   2. 新增 store.applyOrganizeLinks(plan, {operationId})：单次 runMutation 内
//      原子校验全部 sources CAS/before 边/target 约束后整批织网，失败零卡变更。
//   3. 新增 store.retireMerged(sources, {topic, operationId})：单次 runMutation
//      内原子整批把 active 源卡置为 merged（严格 CAS + 拒绝 replacement 承接卡）。
//   4. validateCardShape 增加对 merged 卡 mergedInto/mergedAt 的严格加载校验
//      （非 merged 卡不得携带这两个字段）；SYSTEM_FIELDS 同步扩展，update patch
//      永远不能写 mergedInto/mergedAt。
//   5. 新增 organize plan 严格 schema 校验（link / merge-topic），规则与
//      src/organize/executor.mjs 中的副本一致（CONTRACTS §3/§4）。
//
// 三个新方法都是「受审执行器的内部存储原语」：不是公开 tool、不独立声称
// 已认证任何 topic/plan，调用方（executor）负责 authorize 与轮次绑定。
// ───────────────────────────────────────────────────────────────────────────
//
// ───────────────────────────────────────────────────────────────────────────
// [P4-N] 窄存储提案（2026-10-25）：批量软归档、冷库列表与明确有用反馈
//
// 本文件是当前生产 src/sparks/store.mjs 的完整提案副本 + 以下窄增量
// （相对冻结基线只插入、不改既有语义；测试在 temp stage 覆盖
// stage/src/sparks/store.mjs 后运行，保持相对 import）：
//
//   1. store.archiveEphemeral(plan, {operationId, executedAt})：单次
//      runMutation 内先整批核验（持久同 op 重放先于 live CAS；五字段 CAS
//      revision/createdAt/lastUsedAt/useCount；plan.now 与 executedAt 双重
//      资格复算）再一次性软归档 1..20 张 active ephemeral 卡；任一失败零卡
//      变化、不落新 op。归档只改 state/archivedAt/updatedAt/revision。
//   2. store.listArchived()：当前 scope 恰好 archived 的完整卡，按 id 排序
//      并 clone；只读，无 global fallback，不写库。
//   3. store.recordUsefulFeedback(id, {used, sourceEventId, operationId?})：
//      明确有用反馈，sourceEventId 必填，按 (scope,id,event) 去重；仅
//      used=true 时 useCount+1/lastUsedAt 更新（revision 不变）；与归档同锁。
//   4. 窄修复共享路径的 own-property 缺陷：runMutation 的 ops 查找与
//      feedback 的事件查找改用 Object.hasOwn（旧缺陷：sourceEventId/
//      operationId 为 "constructor" 时读到 Object.prototype 继承键，被误判
//      「已记录/已被不同语义使用」）；事件写入改用 defineProperty 保证
//      一定是自有可枚举属性。旧 feedback 的可选 sourceEventId 语义保留。
//
// 衰减复算为 N 私有实现，公式/参数与 M 槽契约同源（CONTRACTS §1）：
//   score = 2**(-elapsedDays/halfLifeDays)，
//   halfLifeDays = min(baseHalfLifeDays * 2**useCount, maxHalfLifeDays)，
//   elapsedDays = max(0, (now - (lastUsedAt ?? createdAt)) / 86400000)，
//   归档资格：active、ephemeral、supersedes===null、elapsedDays>=60 且
//   score < archiveScore。useCount 大指数封顶避免 2**useCount 溢出污染。
// 不 import 未提交的 M/O 模块，不新增依赖。
// ───────────────────────────────────────────────────────────────────────────

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
  // [P3-L] mergedInto/mergedAt 只能由 retireMerged 内部写入；
  // update patch / save input 携带即拒绝（不能当通用可写字段）。
  'mergedInto', 'mergedAt',
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
// [P3-L] organize plan 严格 schema 校验（与 src/organize/executor.mjs 的副本
// 规则一致；本层校验不信任调用方，executor 侧同规则双保险）
// ---------------------------------------------------------------------------

const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

const ORGANIZE_PLAN_VERSION = 1;
// bind/link 执行路径只接受这两种；thin-core 仅草案，executor 在更早处拒绝，
// 本层 schema 也按完整形状校验后由调用方决定。
const ORGANIZE_PLAN_KEYS = {
  link: new Set(['version', 'scopeId', 'candidateId', 'kind', 'sources', 'links']),
  'merge-topic': new Set(['version', 'scopeId', 'candidateId', 'kind', 'sources', 'topic']),
  'thin-core': new Set(['version', 'scopeId', 'candidateId', 'kind', 'sources', 'core']),
};
// link 的 sources 覆盖被改源 + 全部引用目标（+候选源），真实规模很小；
// 64 是防滥用的宽松硬上限，不是业务约束。
const LINK_SOURCES_MAX = 64;
const MERGE_SOURCES_MIN = 8;
const MERGE_SOURCES_MAX = 19;
const RETIRE_SOURCES_MAX = 19;
const LINKS_MAX = 20;
const SOURCES_BLOCK_OPEN = '\n<!-- shiori-p3-sources -->\n';
const SOURCES_BLOCK_CLOSE = '\n<!-- /shiori-p3-sources -->\n';

function checkPlanString(value, field, { min, max }) {
  if (typeof value !== 'string') {
    throw invalidInput(`plan.${field} 必须是字符串`);
  }
  if (value.length < min || (max !== undefined && value.length > max)) {
    throw invalidInput(`plan.${field} 长度必须在 ${min}..${max ?? '∞'} UTF-16（实际 ${value.length}）`);
  }
  assertEncodableUtf8(value, `plan.${field}`);
  return value;
}

/** SourceRef 列表：{id,revision} 精确形状、id 唯一、按 id UTF16 升序。 */
function checkPlanSources(value, { min, max }) {
  if (!Array.isArray(value)) {
    throw invalidInput('plan.sources 必须是数组');
  }
  if (value.length < min || value.length > max) {
    throw invalidInput(`plan.sources 数量必须在 ${min}..${max}（实际 ${value.length}）`);
  }
  let prev = null;
  for (const s of value) {
    if (!isPlainObject(s)) throw invalidInput('plan.sources 项必须是 {id,revision} 对象');
    const keys = Object.keys(s);
    if (keys.length !== 2 || !Object.hasOwn(s, 'id') || !Object.hasOwn(s, 'revision')) {
      throw invalidInput('plan.sources 项只允许恰好 id/revision 两个键');
    }
    validateSparkId(s.id, 'plan.sources.id');
    if (!Number.isInteger(s.revision) || s.revision < 1) {
      throw invalidInput(`plan.sources.revision 必须是 >=1 整数（id=${s.id}）`);
    }
    if (prev !== null && !(prev < s.id)) {
      throw invalidInput(`plan.sources 必须按 id UTF16 升序且无重复（"${s.id}" 处乱序/重复）`);
    }
    prev = s.id;
  }
  return value;
}

/** {target,rel} 数组：精确形状、无重复、按 target 再 rel 升序。 */
function checkPlanLinkPairs(value, field) {
  if (!Array.isArray(value)) {
    throw invalidInput(`plan.${field} 必须是 {target,rel} 数组`);
  }
  if (value.length > LIMITS.linksMax) {
    throw invalidInput(`plan.${field} 最多 ${LIMITS.linksMax} 项（实际 ${value.length}）`);
  }
  let prevKey = null;
  for (const p of value) {
    if (!isPlainObject(p)) throw invalidInput(`plan.${field} 项必须是对象`);
    const keys = Object.keys(p);
    if (keys.length !== 2 || !Object.hasOwn(p, 'target') || !Object.hasOwn(p, 'rel')) {
      throw invalidInput(`plan.${field} 项只允许恰好 target/rel 两个键`);
    }
    validateSparkId(p.target, `${field}.target`);
    const rel = checkString(p.rel, 'rel', { min: 1, max: LIMITS.relChars, where: `plan.${field}` });
    if (rel.trim() === '') throw invalidInput(`plan.${field}.rel 不得为纯空白`);
    const key = `${p.target}\u0000${p.rel}`;
    if (prevKey !== null && !(prevKey < key)) {
      throw invalidInput(`plan.${field} 必须按 target 再 rel 升序且无 (target,rel) 重复`);
    }
    prevKey = key;
  }
  return value;
}

/**
 * organize plan 完整 schema 校验（link / merge-topic / thin-core 三种形状）。
 * 返回原 plan 引用（调用方自行克隆隔离）；任何未知字段/越界/乱序一律 INVALID_INPUT。
 */
function validateOrganizePlan(plan, boundScopeId) {
  if (!isPlainObject(plan)) {
    throw invalidInput('plan 必须是对象');
  }
  const kind = plan.kind;
  if (!(kind === 'link' || kind === 'merge-topic' || kind === 'thin-core')) {
    throw invalidInput('plan.kind 只支持 link / merge-topic / thin-core', { kind });
  }
  const allowed = ORGANIZE_PLAN_KEYS[kind];
  const present = new Set(Object.keys(plan));
  for (const key of present) {
    if (!allowed.has(key)) {
      if (key === 'digest' || key === 'approval' || key === 'operationId') {
        throw invalidInput(`plan 不能携带 "${key}"（digest/approval/operationId 由执行轮另行绑定）`);
      }
      throw invalidInput(`plan 含未知字段 "${key}"（kind=${kind}）`);
    }
  }
  for (const key of allowed) {
    if (!present.has(key)) {
      throw invalidInput(`plan 缺少必填字段 "${key}"（kind=${kind}）`);
    }
  }
  if (plan.version !== ORGANIZE_PLAN_VERSION) {
    throw invalidInput(`plan.version 必须是 ${ORGANIZE_PLAN_VERSION}`, { version: plan.version });
  }
  if (plan.scopeId !== boundScopeId) {
    throw invalidInput('plan.scopeId 与 store 绑定 scope 不一致（跨 scope 一律拒绝）', {
      planScopeId: plan.scopeId, boundScopeId,
    });
  }
  checkPlanString(plan.candidateId, 'candidateId', { min: 1, max: 128 });

  if (kind === 'link') {
    checkPlanSources(plan.sources, { min: 1, max: LINK_SOURCES_MAX });
    if (!Array.isArray(plan.links) || plan.links.length < 1 || plan.links.length > LINKS_MAX) {
      throw invalidInput(`plan.links 数量必须在 1..${LINKS_MAX}`);
    }
    const sourceIds = new Set(plan.sources.map((s) => s.id));
    const revisionOf = new Map(plan.sources.map((s) => [s.id, s.revision]));
    let prevId = null;
    for (const l of plan.links) {
      if (!isPlainObject(l)) throw invalidInput('plan.links 项必须是对象');
      const keys = Object.keys(l);
      if (keys.length !== 4 || !keys.every((k) => ['id', 'expectedRevision', 'before', 'after'].includes(k))) {
        throw invalidInput('plan.links 项只允许恰好 id/expectedRevision/before/after 四个键');
      }
      validateSparkId(l.id, 'plan.links.id');
      if (prevId !== null && !(prevId < l.id)) {
        throw invalidInput('plan.links 必须按 id UTF16 升序且无重复');
      }
      prevId = l.id;
      if (!sourceIds.has(l.id)) {
        throw invalidInput(`plan.links.id "${l.id}" 不在 plan.sources 中`);
      }
      if (l.expectedRevision !== revisionOf.get(l.id)) {
        throw invalidInput(`plan.links.expectedRevision 与 plan.sources 中 "${l.id}" 的 revision 不一致`);
      }
      checkPlanLinkPairs(l.before, 'links.before');
      checkPlanLinkPairs(l.after, 'links.after');
      const beforeSet = new Set(l.before.map((p) => `${p.target}\u0000${p.rel}`));
      const afterSet = new Set(l.after.map((p) => `${p.target}\u0000${p.rel}`));
      if (afterSet.size !== l.after.length || beforeSet.size !== l.before.length) {
        throw invalidInput('plan.links before/after 含重复 (target,rel)');
      }
      for (const p of l.after) {
        if (p.target === l.id) throw invalidInput(`plan.links.after 不允许 self-link（"${l.id}"）`);
      }
      let added = 0;
      for (const key of afterSet) {
        if (!beforeSet.has(key)) added += 1;
      }
      if (added === 0) throw invalidInput(`plan.links "${l.id}" 的 after 相对 before 无新增边（拒绝无变化）`);
      for (const key of beforeSet) {
        if (!afterSet.has(key)) throw invalidInput(`plan.links "${l.id}" 的 after 丢失了 before 边（append-only）`);
      }
    }
    // 被改源与全部引用目标都必须绑定 revision（⊆ sources）
    for (const l of plan.links) {
      for (const p of l.after) {
        if (!sourceIds.has(p.target)) {
          throw invalidInput(`plan.links.after 引用目标 "${p.target}" 不在 plan.sources 中（未绑定 revision）`);
        }
      }
    }
    return plan;
  }

  if (kind === 'merge-topic') {
    checkPlanSources(plan.sources, { min: MERGE_SOURCES_MIN, max: MERGE_SOURCES_MAX });
    const t = plan.topic;
    if (!isPlainObject(t)) throw invalidInput('plan.topic 必须是对象');
    const tKeys = Object.keys(t);
    if (tKeys.length !== 7 || !tKeys.every((k) => ['key', 'expectedRevision', 'before', 'after', 'title', 'summary', 'updated'].includes(k))) {
      throw invalidInput('plan.topic 只允许恰好 key/expectedRevision/before/after/title/summary/updated 七个键');
    }
    if (typeof t.key !== 'string' || t.key.length === 0) {
      throw invalidInput('plan.topic.key 必须是非空字符串（topic key 规则由 service 层校验）');
    }
    assertEncodableUtf8(t.key, 'plan.topic.key');
    checkPlanString(t.expectedRevision, 'topic.expectedRevision', { min: 1, max: 16384 });
    if (typeof t.before !== 'string' || typeof t.after !== 'string') {
      throw invalidInput('plan.topic.before/after 必须是字符串');
    }
    assertEncodableUtf8(t.before, 'plan.topic.before');
    assertEncodableUtf8(t.after, 'plan.topic.after');
    if (!t.after.startsWith(t.before)) {
      throw invalidInput('plan.topic.after 必须以 before 为前缀（append-only，保留原正文）');
    }
    if (t.after.length === t.before.length) {
      throw invalidInput('plan.topic.after 与 before 完全相同（拒绝无变化）');
    }
    if (!t.after.includes(SOURCES_BLOCK_OPEN) || !t.after.includes(SOURCES_BLOCK_CLOSE)) {
      throw invalidInput('plan.topic.after 缺少 shiori-p3-sources 源保全块起止标记');
    }
    // 类型先行（主审 L-5）：非字符串 metadata 必须得到 INVALID_INPUT，
    // 不允许 .length/.includes 触发裸 TypeError；边界与 K validatePlanTopic 对齐
    checkPlanString(t.title, 'topic.title', { min: 1 });
    checkPlanString(t.summary, 'topic.summary', { min: 0, max: 60 });
    if (t.summary.includes('\n') || t.summary.includes('\r')) throw invalidInput('plan.topic.summary 不得含换行');
    checkPlanString(t.updated, 'topic.updated', { min: 1 });
    return plan;
  }

  // thin-core：形状校验（仅草案；执行一律拒绝，不进入本 store 的任何写路径）
  const c = plan.core;
  if (!isPlainObject(c)) throw invalidInput('plan.core 必须是对象');
  const cKeys = Object.keys(c);
  if (cKeys.length !== 2 || !cKeys.every((k) => k === 'before' || k === 'after')) {
    throw invalidInput('plan.core 只允许恰好 before/after 两个键');
  }
  if (typeof c.before !== 'string' || typeof c.after !== 'string') {
    throw invalidInput('plan.core.before/after 必须是字符串');
  }
  assertEncodableUtf8(c.before, 'plan.core.before');
  assertEncodableUtf8(c.after, 'plan.core.after');
  checkPlanSources(plan.sources, { min: 1, max: LINK_SOURCES_MAX });
  return plan;
}

/** retireMerged 的 topic 指针参数严格校验。 */
function validateRetireTopicPointer(topic, boundScopeId) {
  if (!isPlainObject(topic)) {
    throw invalidInput('retireMerged opts.topic 必须是 {key,scopeId,revision,bodyHash} 对象');
  }
  const keys = Object.keys(topic);
  if (keys.length !== 4 || !keys.every((k) => ['key', 'scopeId', 'revision', 'bodyHash'].includes(k))) {
    throw invalidInput('retireMerged opts.topic 只允许恰好 key/scopeId/revision/bodyHash 四个键');
  }
  if (typeof topic.key !== 'string' || topic.key.length === 0) {
    throw invalidInput('retireMerged opts.topic.key 必须是非空字符串');
  }
  assertEncodableUtf8(topic.key, 'retireMerged topic.key');
  if (topic.scopeId !== boundScopeId) {
    throw invalidInput('retireMerged opts.topic.scopeId 与 store 绑定 scope 不一致（跨 scope 拒绝）', {
      topicScopeId: topic.scopeId, boundScopeId,
    });
  }
  if (!isHex64(topic.revision)) throw invalidInput('retireMerged opts.topic.revision 必须是 64 位小写 hex');
  if (!isHex64(topic.bodyHash)) throw invalidInput('retireMerged opts.topic.bodyHash 必须是 64 位小写 hex');
  return topic;
}

/** retireMerged 的 sources 严格校验（1..19 SourceRef，按 id 升序）。 */
function validateRetireSources(sources) {
  checkPlanSources(sources, { min: 1, max: RETIRE_SOURCES_MAX });
  return sources;
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
  // [P3-L] merged 卡加载校验（主审 L-4）：兼容旧 P2 已知形状——
  //   ① state='merged' 且无 mergedInto（P2 无写入路径，加载校验接受，
  //      投影排除，docs/sparks/storage.md「merged 状态无写入路径」）；
  //   ② mergedInto 为字符串 marker（docs/sparks/delivery.md 资格筛选语义：
  //      已设置即排除，不解释指向）。
  // 新形状（retireMerged 产物）仍是严格对象指针：恰好 key/scopeId/revision/
  // bodyHash 四键、64 位小写 hex revision/bodyHash；mergedAt 可选但必须是
  // 字符串。非 merged 卡不得携带 mergedInto/mergedAt（严格区分写入路径）。
  // 新写入不降格：retireMerged 只写新对象指针。
  if (card.state === 'merged') {
    if (card.mergedInto === undefined) {
      // 旧 P2 已知形状①：无 mergedInto 的 merged 卡，加载接受
    } else if (typeof card.mergedInto === 'string') {
      // 旧 P2 已知形状②：字符串 marker
      if (card.mergedInto.length === 0) fail('mergedInto 字符串 marker 不得为空');
    } else if (isPlainObject(card.mergedInto)) {
      const mi = card.mergedInto;
      for (const mk of Object.keys(mi)) {
        if (mk !== 'key' && mk !== 'scopeId' && mk !== 'revision' && mk !== 'bodyHash') {
          fail(`mergedInto 含未知字段 "${mk}"`);
        }
      }
      if (typeof mi.key !== 'string' || mi.key.length === 0) fail('mergedInto.key 缺失或为空');
      if (typeof mi.scopeId !== 'string' || mi.scopeId.length === 0) fail('mergedInto.scopeId 缺失或为空');
      if (!isHex64(mi.revision)) fail('mergedInto.revision 不是 64 位小写 hex');
      if (!isHex64(mi.bodyHash)) fail('mergedInto.bodyHash 不是 64 位小写 hex');
    } else {
      fail('mergedInto 损坏（须为旧字符串 marker 或新 {key,scopeId,revision,bodyHash} 对象）');
    }
    if (card.mergedAt !== undefined && card.mergedAt !== null && typeof card.mergedAt !== 'string') {
      fail('mergedAt 损坏（须为字符串或缺失）');
    }
  } else if (card.mergedInto !== undefined || card.mergedAt !== undefined) {
    fail(`非 merged 卡不得携带 mergedInto/mergedAt 字段（state=${card.state}）`);
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
// [P4-N] 遗忘归档：forget plan 严格校验与 N 私有衰减复算
// ---------------------------------------------------------------------------

const FORGET_PLAN_VERSION = 1;
const FORGET_PLAN_KIND = 'archive-ephemeral';
const FORGET_PLAN_KEYS = new Set(['version', 'kind', 'scopeId', 'now', 'policy', 'sources']);
const FORGET_POLICY_KEYS = new Set(['baseHalfLifeDays', 'maxHalfLifeDays', 'archiveScore']);
const FORGET_SOURCE_KEYS = new Set(['id', 'revision', 'createdAt', 'lastUsedAt', 'useCount']);
const ARCHIVE_SOURCES_MAX = 20;
const ARCHIVE_COOLDOWN_DAYS = 60;
const MS_PER_DAY = 86_400_000;
const FORGET_ARCHIVE_OP_KIND = 'forget-archive';
const FORGET_ARCHIVE_RESULT_KIND = 'forget-archive-result';

/** 普通对象：Object.prototype 或 null 原型（非数组）。 */
function isNormalObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * 规范 UTC ISO 字符串：时间戳有限且 new Date(v).toISOString() === v。
 * 先判有限再 roundtrip：对非法输入 new Date(v).toISOString() 会抛 RangeError。
 */
function validateCanonicalIso(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    throw invalidInput(`${field} 必须是规范 UTC ISO 字符串（如 2026-10-25T00:00:00.000Z）`);
  }
  return value;
}

/**
 * [P4-N] forget policy 严格校验（CONTRACTS §1）：完整三字段、拒绝未知键；
 * base 有限数 [1,365]；max 有限数 [base,3650]；archiveScore 有限数 (0,1)。
 * 返回独立三字段快照。
 */
function validateForgetPolicy(policy, where = 'plan.policy') {
  if (!isNormalObject(policy)) {
    throw invalidInput(`${where} 必须是普通对象`);
  }
  const keys = Object.keys(policy);
  if (keys.length !== FORGET_POLICY_KEYS.size || !keys.every((k) => FORGET_POLICY_KEYS.has(k))) {
    throw invalidInput(`${where} 必须恰好包含 baseHalfLifeDays/maxHalfLifeDays/archiveScore 三个字段（不接受部分覆盖）`);
  }
  const { baseHalfLifeDays, maxHalfLifeDays, archiveScore } = policy;
  for (const [name, value] of [
    ['baseHalfLifeDays', baseHalfLifeDays],
    ['maxHalfLifeDays', maxHalfLifeDays],
    ['archiveScore', archiveScore],
  ]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidInput(`${where}.${name} 必须是有限数值（拒绝 NaN/Infinity/非数值）`);
    }
  }
  if (baseHalfLifeDays < 1 || baseHalfLifeDays > 365) {
    throw invalidInput(`${where}.baseHalfLifeDays 必须在 [1,365] 内`, { value: baseHalfLifeDays });
  }
  if (maxHalfLifeDays < baseHalfLifeDays || maxHalfLifeDays > 3650) {
    throw invalidInput(`${where}.maxHalfLifeDays 必须在 [baseHalfLifeDays,3650] 内`, { value: maxHalfLifeDays });
  }
  if (archiveScore <= 0 || archiveScore >= 1) {
    throw invalidInput(`${where}.archiveScore 必须在 (0,1) 内`, { value: archiveScore });
  }
  return { baseHalfLifeDays, maxHalfLifeDays, archiveScore };
}

/** [P4-N] Source 精确五自有键校验（CONTRACTS §3）。 */
function validateForgetSource(source, where = 'plan.sources 项') {
  if (!isNormalObject(source)) {
    throw invalidInput(`${where} 必须是普通对象`);
  }
  const keys = Object.keys(source);
  if (keys.length !== FORGET_SOURCE_KEYS.size || !keys.every((k) => FORGET_SOURCE_KEYS.has(k))) {
    throw invalidInput(`${where} 只允许恰好 id/revision/createdAt/lastUsedAt/useCount 五个自有键`);
  }
  validateSparkId(source.id, `${where}.id`);
  if (!Number.isSafeInteger(source.revision) || source.revision < 1) {
    throw invalidInput(`${where}.revision 必须是 >=1 的 safe 整数（id=${source.id}）`);
  }
  validateCanonicalIso(source.createdAt, `${where}.createdAt`);
  if (source.lastUsedAt !== null) {
    validateCanonicalIso(source.lastUsedAt, `${where}.lastUsedAt`);
  }
  if (!Number.isSafeInteger(source.useCount) || source.useCount < 0) {
    throw invalidInput(`${where}.useCount 必须是 >=0 的 safe 整数（id=${source.id}）`);
  }
}

/**
 * [P4-N] forget plan 严格校验（CONTRACTS §3/§4）：普通对象、恰好六键、
 * kind/version/scopeId 精确、now 规范 ISO、policy 完整三字段、sources
 * 1..20 且五字段精确形状、id 唯一。返回 sources 按 id 升序规范化的独立
 * 快照（语义指纹与锁内核验都用该快照；调用方后续改动不影响）。
 */
function validateForgetPlan(plan, boundScopeId) {
  if (!isNormalObject(plan)) {
    throw invalidInput('plan 必须是普通对象');
  }
  const keys = Object.keys(plan);
  if (keys.length !== FORGET_PLAN_KEYS.size || !keys.every((k) => FORGET_PLAN_KEYS.has(k))) {
    throw invalidInput('plan 必须恰好包含 version/kind/scopeId/now/policy/sources 六个字段');
  }
  if (plan.version !== FORGET_PLAN_VERSION) {
    throw invalidInput(`plan.version 必须是 ${FORGET_PLAN_VERSION}`, { version: plan.version });
  }
  if (plan.kind !== FORGET_PLAN_KIND) {
    throw invalidInput(`plan.kind 必须是 "${FORGET_PLAN_KIND}"`, { kind: plan.kind });
  }
  if (plan.scopeId !== boundScopeId) {
    throw invalidInput('plan.scopeId 与 store 绑定 scope 不一致（跨 scope 一律拒绝）', {
      planScopeId: plan.scopeId, boundScopeId,
    });
  }
  validateCanonicalIso(plan.now, 'plan.now');
  const policy = validateForgetPolicy(plan.policy);
  if (!Array.isArray(plan.sources)) {
    throw invalidInput('plan.sources 必须是数组');
  }
  if (plan.sources.length < 1 || plan.sources.length > ARCHIVE_SOURCES_MAX) {
    throw invalidInput(`plan.sources 数量必须在 1..${ARCHIVE_SOURCES_MAX}（实际 ${plan.sources.length}）`);
  }
  const seen = new Set();
  const sources = [];
  for (const s of plan.sources) {
    validateForgetSource(s);
    if (seen.has(s.id)) {
      throw invalidInput(`plan.sources 存在重复 id "${s.id}"（id 必须唯一）`);
    }
    seen.add(s.id);
    sources.push({
      id: s.id,
      revision: s.revision,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
      useCount: s.useCount,
    });
  }
  sources.sort((a, b) => byCodepoint(a.id, b.id));
  return { version: FORGET_PLAN_VERSION, kind: FORGET_PLAN_KIND, scopeId: plan.scopeId, now: plan.now, policy, sources };
}

/**
 * [P4-N] useCount 大指数封顶：2**useCount 超过 max/base 后对 halfLife 无影响
 *（min 封顶），再往上乘只会得到 Infinity 污染 score；指数封顶在
 * ceil(log2(max/base)) 处即已达到 max，结果与无溢出的精确值一致。
 */
function halfLifeDaysFor(useCount, policy) {
  const cap = Math.max(0, Math.ceil(Math.log2(policy.maxHalfLifeDays / policy.baseHalfLifeDays)));
  const cappedUse = Math.min(useCount, cap);
  return Math.min(policy.baseHalfLifeDays * 2 ** cappedUse, policy.maxHalfLifeDays);
}

/** [P4-N] N 私有衰减复算：与 M 槽同公式/参数，不依赖未提交的 M 模块。 */
function recomputeDecay(sourceLike, nowMs, policy) {
  const anchorMs = Date.parse(sourceLike.lastUsedAt ?? sourceLike.createdAt);
  const elapsedDays = Math.max(0, (nowMs - anchorMs) / MS_PER_DAY);
  const halfLifeDays = halfLifeDaysFor(sourceLike.useCount, policy);
  const score = 2 ** (-elapsedDays / halfLifeDays);
  return { elapsedDays, halfLifeDays, score };
}

/** [P4-N] 归档资格：冷却满 60 天且 score 严格低于阈值（等于不算）。 */
function isArchiveEligible(decay, policy) {
  return decay.elapsedDays >= ARCHIVE_COOLDOWN_DAYS && decay.score < policy.archiveScore;
}

// ---------------------------------------------------------------------------
// [P4-N / D-3 窄修复] feedback bucket 与事件写入的 own-property 语义
// ---------------------------------------------------------------------------

/**
 * [D-3] bucket 只认自有普通对象。合法卡 id（如 "toString"，不在
 * RESERVED_JSON_KEYS 名单内）会命中 db.feedback 的继承键：直接
 * db.feedback[id] 读取会拿到 Object.prototype 的内置函数当作 bucket，
 * 事件被写到函数对象上——不持久化、跨进程丢失事件去重。
 */
function ownFeedbackBucket(db, cardId) {
  const bucket = Object.hasOwn(db.feedback, cardId) ? db.feedback[cardId] : undefined;
  return bucket !== undefined && isPlainObject(bucket) ? bucket : undefined;
}

/**
 * [D-3] bucket 初始化用 defineProperty：`??=` / 普通赋值在已有继承键
 * （函数恒为 truthy）时不会创建自有 bucket；defineProperty 恒为自有键。
 */
function ensureFeedbackBucket(db, cardId) {
  let bucket = ownFeedbackBucket(db, cardId);
  if (bucket === undefined) {
    bucket = {};
    Object.defineProperty(db.feedback, cardId, {
      value: bucket, enumerable: true, writable: true, configurable: true,
    });
  }
  return bucket;
}

/**
 * [D-3] 事件写入用 defineProperty：与 bucket 初始化同一 own-property 语义。
 * （"__proto__" 类键本就被事件 id 校验以「首字符必须字母数字」拒绝，此处
 * defineProperty 是纵深防御：即使键名与继承键重合也恒为自有可枚举键。）
 */
function writeFeedbackEvent(bucket, sourceEventId, used, at) {
  Object.defineProperty(bucket, sourceEventId, {
    value: { used, at }, enumerable: true, writable: true, configurable: true,
  });
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
        // [P4-N 窄修复] own-property 查找：validateOperationId 允许
        // "constructor" 这类键，旧写法 db.ops[operationId] 会读到
        // Object.prototype 继承键，把全新请求误判为「已被不同语义使用」。
        const prior = Object.hasOwn(db.ops, operationId) ? db.ops[operationId] : undefined;
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
            // [P4-N 窄修复] bucket 与事件都只认自有字段：sourceEventId 为
            // "constructor" 等键时旧写法会读到 Object.prototype 继承值
            // （prior.used 为 undefined），把全新事件误报为「已记录」；
            // 卡 id 为 "toString" 等继承键名时 bucket 查找/初始化见 D-3
            // 辅助函数——不得把事件写到继承的内置函数对象上。
            const events = ownFeedbackBucket(db, id);
            const prior = events !== undefined && Object.hasOwn(events, sourceEventId)
              ? events[sourceEventId]
              : undefined;
            if (prior !== undefined) {
              if (prior.used !== o.used) {
                throw invalidInput(`sourceEventId "${sourceEventId}" 已记录 used=${prior.used}，不能改为 ${o.used}（同 key 不同语义）`, {
                  id, sourceEventId, previousUsed: prior.used,
                });
              }
              return clone(card); // 事件级幂等：不重复计数
            }
            writeFeedbackEvent(ensureFeedbackBucket(db, id), sourceEventId, o.used, nowIso());
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
     * [P5] L2 投递 hit 记账：对已成功 surface append 的投递逐卡
     * hitCount+1 / lastHitAt=now。幂等按 operationId（同 deliveryId 重放
     * 零写、不重复计数）；只改投递统计，不改 revision（非内容写）。
     * 卡缺失（异常场景）逐条跳过并计入 skipped，不让 stats 失败炸整批。
     *
     * @param {Array<{sparkId:string, revision?:number}>} entries
     * @param {object} [opts] {operationId}
     */
    async recordDeliveryHits(entries, opts = {}) {
      ensureOpen();
      if (!Array.isArray(entries)) {
        throw invalidInput('recordDeliveryHits 的 entries 必须是数组');
      }
      const operationId = Object.hasOwn(opts, 'operationId')
        ? validateOperationId(opts.operationId)
        : undefined;
      const normalized = entries.map((e, i) => {
        if (!e || typeof e !== 'object' || typeof e.sparkId !== 'string' || e.sparkId.length === 0) {
          throw invalidInput(`entries[${i}] 需要 {sparkId}`);
        }
        return { sparkId: e.sparkId, revision: Number.isInteger(e.revision) ? e.revision : null };
      });
      return runMutation(
        'delivery-hit',
        operationId,
        { kind: 'delivery-hit', entries: normalized },
        (db) => {
          const applied = [];
          const skipped = [];
          for (const entry of normalized) {
            const card = Object.hasOwn(db.cards, entry.sparkId) ? db.cards[entry.sparkId] : undefined;
            if (card === undefined) {
              skipped.push({ sparkId: entry.sparkId, reason: 'missing' });
              continue;
            }
            card.hitCount += 1;
            card.lastHitAt = nowIso();
            applied.push({ sparkId: card.id, revision: card.revision });
          }
          return { applied, skipped };
        },
      );
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

    // ------------------------------------------------------------------
    // [P3-L] organize 窄接口（受审执行器内部原语，非公开 tool）
    // ------------------------------------------------------------------

    /**
     * [P3-L] 把规范 organize plan 指纹绑定到本 round 的 operationId：
     * 只记稳定请求身份账（ops 表 + generation），不改任何卡。
     * 同 operationId 不同 plan 指纹（含 kind/candidateId 变化）重启后也拒绝；
     * 相同指纹重放返回首次结果快照。
     */
    async bindOrganizeRound(plan, opts) {
      ensureOpen();
      if (!isPlainObject(opts)) {
        throw invalidInput('bindOrganizeRound 的第二参数（opts）必须是 {operationId} 对象');
      }
      const keys = Object.keys(opts);
      if (keys.length !== 1 || keys[0] !== 'operationId') {
        throw invalidInput('bindOrganizeRound opts 只允许恰好 operationId 一个键');
      }
      validateOperationId(opts.operationId);
      const checked = validateOrganizePlan(plan, scopeId);
      if (checked.kind === 'thin-core') {
        throw unsupported('thin-core 仅草案，bindOrganizeRound 不接受（执行一律拒绝）');
      }
      const planDigest = sha256Buffer(Buffer.from(stableStringify(checked), 'utf8'));
      const at = nowIso();
      return runMutation(
        'organize-bind',
        opts.operationId,
        { kind: 'organize-bind', scopeId, planDigest },
        () => ({
          bound: true,
          kind: checked.kind,
          candidateId: checked.candidateId,
          planDigest,
          changedCards: 0,
          boundAt: at,
        }),
      );
    },

    /**
     * [P3-L] 织网整批执行：单次 runMutation 内原子校验全部 sources（存在、
     * active、revision CAS）、每张被改卡的 before 边精确匹配、after ⊇ before、
     * target 存在且 active，然后一次性修改 <=20 张源卡；任何失败零卡变更。
     * 同 operationId 幂等重放先于 live CAS（runMutation 语义）。
     */
    async applyOrganizeLinks(plan, opts) {
      ensureOpen();
      if (!isPlainObject(opts)) {
        throw invalidInput('applyOrganizeLinks 的第二参数（opts）必须是 {operationId} 对象');
      }
      const keys = Object.keys(opts);
      if (keys.length !== 1 || keys[0] !== 'operationId') {
        throw invalidInput('applyOrganizeLinks opts 只允许恰好 operationId 一个键');
      }
      validateOperationId(opts.operationId);
      const checked = validateOrganizePlan(plan, scopeId);
      if (checked.kind !== 'link') {
        throw invalidInput(`applyOrganizeLinks 只接受 kind="link" 的 plan（得到 "${checked.kind}"）`);
      }
      const planDigest = sha256Buffer(Buffer.from(stableStringify(checked), 'utf8'));
      return runMutation(
        'organize-links',
        opts.operationId,
        { kind: 'organize-links', scopeId, planDigest },
        (db) => {
          // 1) 全部 sources 原子核验（含只被引用、不被修改的目标卡）
          for (const s of checked.sources) {
            const card = db.cards[s.id];
            if (card === undefined) {
              throw notFound(`plan.sources 卡片 "${s.id}" 不存在于 scope "${scopeId}"`, { id: s.id, scopeId });
            }
            if (card.state !== 'active') {
              throw invalidState(`plan.sources 卡片 "${s.id}" 状态为 ${card.state}，仅 active 可参与织网`, { id: s.id, state: card.state });
            }
            if (card.revision !== s.revision) {
              throw revisionConflict(`plan.sources 卡片 "${s.id}" revision CAS 失败`, {
                id: s.id, expectedRevision: s.revision, currentRevision: card.revision,
              });
            }
          }
          // 2) 逐张被改卡：before 边精确 CAS → 校验 after → 写入
          const updated = [];
          for (const l of checked.links) {
            const card = db.cards[l.id];
            const currentPairs = new Set(card.links.map((x) => `${x.target}\u0000${x.rel}`));
            const planBefore = new Set(l.before.map((x) => `${x.target}\u0000${x.rel}`));
            if (currentPairs.size !== planBefore.size || ![...planBefore].every((k) => currentPairs.has(k))) {
              throw revisionConflict(`卡片 "${l.id}" 当前边集合与 plan.links.before 不一致（before CAS 失败）`, {
                id: l.id, expectedPairs: [...planBefore].sort(), currentPairs: [...currentPairs].sort(),
              });
            }
            // target 约束（存在 / active / 非自环）复用既有校验
            assertLinksValid(l.after, db, l.id);
            if (l.after.length > LIMITS.linksMax) {
              throw invalidInput(`卡片 "${l.id}" after 边数超上限 ${LIMITS.linksMax}`);
            }
            card.links = l.after.map((x) => ({ target: x.target, rel: x.rel }));
            card.revision += 1;
            card.updatedAt = nowIso();
            updated.push({ id: l.id, beforeRevision: l.expectedRevision, afterRevision: card.revision });
          }
          return {
            kind: 'link',
            changedItems: updated.length,
            updated,
            planDigest,
          };
        },
      );
    },

    /**
     * [P3-L] merge 退休：单次 runMutation 内原子整批把全部 sources（1..19
     * SourceRef，严格 CAS，全部须 active）置为 state='merged'，写入
     * mergedInto={key,scopeId,revision,bodyHash}；保留全部原文与原关系。
     * 任何失败（不存在/非 active/revision 不符/承接了 supersedes 的 replacement）
     * 都不写任何源卡。方法本身不验证 topic 内容——那是受审执行器锁内核验的职责。
     */
    async retireMerged(sources, opts) {
      ensureOpen();
      if (!Array.isArray(sources)) {
        throw invalidInput('retireMerged 的第一参数（sources）必须是 SourceRef 数组');
      }
      if (!isPlainObject(opts)) {
        throw invalidInput('retireMerged 的第二参数（opts）必须是 {topic,operationId} 对象');
      }
      const keys = Object.keys(opts);
      if (keys.length !== 2 || !keys.every((k) => k === 'topic' || k === 'operationId')) {
        throw invalidInput('retireMerged opts 只允许恰好 topic/operationId 两个键');
      }
      validateOperationId(opts.operationId);
      const checkedSources = validateRetireSources(sources);
      const topic = validateRetireTopicPointer(opts.topic, scopeId);
      return runMutation(
        'retire-merged',
        opts.operationId,
        {
          kind: 'retire-merged', scopeId,
          sources: checkedSources.map((s) => ({ id: s.id, revision: s.revision })),
          topic: {
            key: topic.key, scopeId: topic.scopeId,
            revision: topic.revision, bodyHash: topic.bodyHash,
          },
        },
        (db) => {
          // 先整批核验，后整批写入：任何一项失败都不落盘
          for (const s of checkedSources) {
            const card = db.cards[s.id];
            if (card === undefined) {
              throw notFound(`retireMerged 源卡 "${s.id}" 不存在于 scope "${scopeId}"`, { id: s.id, scopeId });
            }
            if (card.state !== 'active') {
              throw invalidState(`retireMerged 源卡 "${s.id}" 状态为 ${card.state}，仅 active 可退休`, { id: s.id, state: card.state });
            }
            if (card.revision !== s.revision) {
              throw revisionConflict(`retireMerged 源卡 "${s.id}" revision CAS 失败`, {
                id: s.id, expectedRevision: s.revision, currentRevision: card.revision,
              });
            }
            if (card.supersedes !== null) {
              throw invalidState(`retireMerged 源卡 "${s.id}" 已承接 "${card.supersedes}" 的替代关系，replacement 不得退休`, {
                id: s.id, supersedes: card.supersedes,
              });
            }
          }
          const at = nowIso();
          const retired = [];
          for (const s of checkedSources) {
            const card = db.cards[s.id];
            card.state = 'merged';
            card.revision += 1;
            card.updatedAt = at;
            card.mergedInto = {
              key: topic.key, scopeId: topic.scopeId,
              revision: topic.revision, bodyHash: topic.bodyHash,
            };
            card.mergedAt = at;
            retired.push({ id: s.id, beforeRevision: s.revision, afterRevision: card.revision });
          }
          return {
            kind: 'retire-merged',
            changedItems: retired.length,
            topic: {
              key: topic.key, scopeId: topic.scopeId,
              revision: topic.revision, bodyHash: topic.bodyHash,
            },
            retired,
          };
        },
      );
    },

    // ------------------------------------------------------------------
    // [P4-N] 遗忘窄存储：批量软归档 / 冷库列表 / 明确有用反馈
    // ------------------------------------------------------------------

    /**
     * [P4-N] 批量软归档（CONTRACTS §3/§4）。plan 为 forget-archive plan
     * （恰好 version/kind/scopeId/now/policy/sources 六键，policy 完整三
     * 字段，sources 1..20 五字段精确形状）；opts 两字段必需。
     *
     * §7 固定顺序：入口同步形状/类型校验与独立快照 → 锁内 load → 持久同 op
     * 重放先于 live CAS → executedAt<plan.now 拒绝 → 逐卡按 id 顺序做存在性
     * （NOT_FOUND）→ active/ephemeral/承接检查（INVALID_STATE）→ 五字段 CAS
     * （REVISION_CONFLICT）→ plan.now 与 executedAt 双重资格复算
     * （INVALID_STATE）→ 全批验证成功后统一修改。任一卡冲突整批零卡变化、
     * 不落新 op。executedAt 不属语义指纹：已完成同 op 在 executedAt 回拨时
     * 仍重放首次持久结果；但格式非法的 executedAt 在入口即 INVALID_INPUT。
     */
    async archiveEphemeral(plan, opts) {
      ensureOpen();
      if (!isNormalObject(opts)) {
        throw invalidInput('archiveEphemeral 的第二参数（opts）必须是普通对象');
      }
      const optKeys = Object.keys(opts);
      if (optKeys.length !== 2 || !optKeys.every((k) => k === 'operationId' || k === 'executedAt')) {
        throw invalidInput('archiveEphemeral opts 必须恰好提供 operationId/executedAt 两个键');
      }
      // [D-1 修复] 首次 await 前同步捕获独立 opts 标量快照：日志键、回执与
      // 全部锁内代码只用该快照，不再闭包读取外部 opts（调用后篡改不影响
      // 首次结果、持久日志键与重放回执）。
      const operationId = validateOperationId(opts.operationId);
      const executedAt = validateCanonicalIso(opts.executedAt, 'archiveEphemeral opts.executedAt');
      const checked = validateForgetPlan(plan, scopeId);
      // 首次 await 前独立输入快照：语义指纹 = 规范化 plan（sources 按 id
      // 排序、键递归排序由 stableStringify 保证；executedAt 不入指纹）。
      const fingerprintPayload = { kind: FORGET_ARCHIVE_OP_KIND, scopeId, plan: checked };
      return runMutation(
        FORGET_ARCHIVE_OP_KIND,
        operationId,
        fingerprintPayload,
        (db) => {
          // §7 顺序④：executedAt 回拨比较只能放在持久重放之后
          if (Date.parse(executedAt) < Date.parse(checked.now)) {
            throw invalidState(`executedAt (${executedAt}) 早于 plan.now (${checked.now})，拒绝执行（时钟回拨）`, {
              executedAt, planNow: checked.now,
            });
          }
          const planNowMs = Date.parse(checked.now);
          const executedAtMs = Date.parse(executedAt);
          // §7 顺序⑤..⑧：逐卡按 id 顺序核验；scope 由加载校验结构性保证，
          // 此处仍显式核对（fail-closed）
          for (const s of checked.sources) {
            const card = Object.hasOwn(db.cards, s.id) ? db.cards[s.id] : undefined;
            if (card === undefined) {
              throw notFound(`plan.sources 卡片 "${s.id}" 不存在于 scope "${scopeId}"`, { id: s.id, scopeId });
            }
            if (card.scopeId !== scopeId) {
              throw invalidState(`plan.sources 卡片 "${s.id}" scopeId 不属于本 scope`, { id: s.id });
            }
            if (card.state !== 'active') {
              throw invalidState(`plan.sources 卡片 "${s.id}" 状态为 ${card.state}，仅 active 卡可归档（退休状态不候选）`, {
                id: s.id, state: card.state,
              });
            }
            if (card.vitality !== 'ephemeral') {
              throw invalidState(`plan.sources 卡片 "${s.id}" vitality 为 ${card.vitality}，evergreen 免疫归档`, {
                id: s.id, vitality: card.vitality,
              });
            }
            if (card.supersedes !== null) {
              throw invalidState(`plan.sources 卡片 "${s.id}" 已承接 "${card.supersedes}" 的替代关系，replacement 不得归档`, {
                id: s.id, supersedes: card.supersedes,
              });
            }
            // 全量五字段 CAS：feedback 不增 revision，故不能只核 revision
            if (card.revision !== s.revision
              || card.createdAt !== s.createdAt
              || (card.lastUsedAt ?? null) !== (s.lastUsedAt ?? null)
              || card.useCount !== s.useCount) {
              throw revisionConflict(`plan.sources 卡片 "${s.id}" 快照 CAS 失败（revision/createdAt/lastUsedAt/useCount 任一不符）`, {
                id: s.id,
                expected: { revision: s.revision, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt ?? null, useCount: s.useCount },
                current: { revision: card.revision, createdAt: card.createdAt, lastUsedAt: card.lastUsedAt ?? null, useCount: card.useCount },
              });
            }
            const decayAtPlanNow = recomputeDecay(card, planNowMs, checked.policy);
            const decayAtExecutedAt = recomputeDecay(card, executedAtMs, checked.policy);
            if (!isArchiveEligible(decayAtPlanNow, checked.policy) || !isArchiveEligible(decayAtExecutedAt, checked.policy)) {
              throw invalidState(`plan.sources 卡片 "${s.id}" 未达归档资格（须 elapsedDays>=${ARCHIVE_COOLDOWN_DAYS} 且 score 严格低于 archiveScore）`, {
                id: s.id,
                atPlanNow: decayAtPlanNow,
                atExecutedAt: decayAtExecutedAt,
                archiveScore: checked.policy.archiveScore,
              });
            }
          }
          // §7 顺序⑨：全批验证成功后统一修改；仅四处字段，其余正文/链接/统计原样
          const items = [];
          for (const s of checked.sources) {
            const card = db.cards[s.id];
            card.state = 'archived';
            card.archivedAt = executedAt;
            card.updatedAt = executedAt;
            card.revision += 1;
            items.push(clone(card));
          }
          return {
            version: FORGET_PLAN_VERSION,
            kind: FORGET_ARCHIVE_RESULT_KIND,
            scopeId,
            operationId,
            archivedAt: executedAt,
            items,
          };
        },
      );
    },

    /**
     * [P4-N] 冷库列表：当前 scope 恰好 archived 的完整卡，按 id 排序并
     * clone；不含 active/superseded/merged，无 global fallback；只读不写库。
     */
    async listArchived() {
      const db = await loadForRead();
      if (db === null) return [];
      const ids = Object.keys(db.cards)
        .filter((id) => db.cards[id].state === 'archived')
        .sort(byCodepoint);
      return ids.map((id) => clone(db.cards[id]));
    },

    /**
     * [P4-N] 明确有用反馈（CONTRACTS §4）：used 必须自有 boolean，
     * sourceEventId 必填且为合法事件 id，按 (scope,id,event) 去重——同事件
     * 同 used 不双计数，不同 used 拒绝（INVALID_INPUT）。仅 used===true 时
     * useCount+1 且 lastUsedAt 更新；返回完整卡，revision 不变。可复用旧
     * feedback 表（同事件跨 API 去重），safe integer 溢出在写入前原子失败。
     * 带 operationId 保留首次结果重放；无 op 的事件重放沿用 active-only，
     * 不复活退休卡。反馈与归档共用同一锁域，归档全量 CAS 含有用反馈变化。
     */
    async recordUsefulFeedback(id, opts) {
      ensureOpen();
      validateSparkId(id, 'id');
      if (!isNormalObject(opts)) {
        throw invalidInput('recordUsefulFeedback 的第二参数（opts）必须是普通对象');
      }
      const optKeys = Object.keys(opts);
      if (!Object.hasOwn(opts, 'used') || !Object.hasOwn(opts, 'sourceEventId')
        || optKeys.some((k) => k !== 'used' && k !== 'sourceEventId' && k !== 'operationId')) {
        throw invalidInput('recordUsefulFeedback opts 必须提供 used/sourceEventId，且只允许 used/sourceEventId/operationId 三个键');
      }
      if (typeof opts.used !== 'boolean') {
        throw invalidInput('recordUsefulFeedback 的 used 必须是布尔值');
      }
      if (typeof opts.sourceEventId !== 'string') {
        throw invalidInput('recordUsefulFeedback 的 sourceEventId 必须是字符串');
      }
      const sourceEventId = validateEventId(opts.sourceEventId);
      // [D-2 修复] operationId 只取自有字段（继承字段不作输入，契约 §1）：
      // 入口同步捕获独立值，显式自有 undefined 走 validate 拒绝，
      // 未提供（或仅继承）时为 undefined —— 不产生任何 operationId 日志。
      const operationId = Object.hasOwn(opts, 'operationId')
        ? validateOperationId(opts.operationId)
        : undefined;
      const used = opts.used;
      return runMutation(
        'useful-feedback',
        operationId,
        { kind: 'useful-feedback', id, used, sourceEventId },
        (db) => {
          const card = Object.hasOwn(db.cards, id) ? db.cards[id] : undefined;
          if (card === undefined) {
            throw notFound(`卡片 "${id}" 不存在于 scope "${scopeId}"`, { id, scopeId });
          }
          // active-only：无 op 的事件重放也不复活退休卡
          assertCardActive(card, id, '记录有用反馈');
          // [D-3] bucket 与事件都只认自有字段（与旧 feedback 共享辅助函数）
          const events = ownFeedbackBucket(db, id);
          const prior = events !== undefined && Object.hasOwn(events, sourceEventId)
            ? events[sourceEventId]
            : undefined;
          if (prior !== undefined) {
            if (prior.used !== used) {
              throw invalidInput(`sourceEventId "${sourceEventId}" 已记录 used=${prior.used}，不能改为 ${used}（同 key 不同语义）`, {
                id, sourceEventId, previousUsed: prior.used,
              });
            }
            return clone(card); // 事件级幂等：不重复计数
          }
          // safe integer 溢出在任何写入前原子拒绝（apply 抛错 → 整次零变化）
          if (used && (!Number.isSafeInteger(card.useCount) || card.useCount + 1 > Number.MAX_SAFE_INTEGER)) {
            throw invalidState(`卡片 "${id}" useCount 已达 safe integer 上限，拒绝继续计数`, { id, useCount: card.useCount });
          }
          const at = nowIso();
          writeFeedbackEvent(ensureFeedbackBucket(db, id), sourceEventId, used, at);
          if (used) {
            card.useCount += 1;
            card.lastUsedAt = at;
          }
          return clone(card);
        },
      );
    },

    /** 关闭 store（幂等）；此后任何方法调用 → INVALID_STATE。 */
    close() {
      closed = true;
    },
  };

  return store;
}
