// Shiori 0.4-S3 / 0.5-1A · topic 分组元数据契约与组清单（groups.json）纯逻辑层。
// 依据 docs/0.4-DEV-PLAN.md §S3.1 / §S3.2 / §S3.5，字段命名与文档一致。
//
// 0.5 批次 1-A（P1#7 解环）：本模块自此只保留纯逻辑——结构版本与默认模板、
// 组 key / 组条目 / 清单校验、组存在性断言、序列化与解析、迁移计划。
// 文件 I/O（读写 groups.json、锁、原子替换）已下沉到 src/storage/groups.mjs；
// 依赖方向收敛为 storage → core（纯逻辑单向），本模块不再 import ../storage/*、
// 不触文件系统、不取锁，core 侧单测不触盘。
//
// 组清单文件：<dataRoot>/scopes/<scopeId>/groups.json（scope 内私有，不跨人设共享）：
//   { "version": 1, "groups": [{ "key", "title", "summary", "order" }] }
//
// 设计要点：
// - 读写入口见 src/storage/groups.mjs（readGroups / ensureGroupsFile / writeGroups /
//   deleteGroup），与 topic 写入同一把跨进程锁；root 一律先 realpath——与 store 的
//   rootReal 同一身份，否则会绕开存储层的跨进程文件锁。
// - 读取路径绝不写盘：readGroups 遇到文件缺失抛 NOT_FOUND，不静默初始化；
//   首次初始化显式走 ensureGroupsFile（幂等，缺文件才写默认模板）。
// - 默认模板以常量导出（DEFAULT_GROUPS_TEMPLATE），后续 UI 与工具引同一份，
//   不允许各自再造一份组名。
// - topic 侧 group 校验（形状/key 规范）在 topics.mjs；本模块负责
//   「组 key 必须存在于 groups.json」与「删组须迁移」的清单层校验。
// - topic 文件本身的迁移改写走 store 提交协议（journal/CAS），本模块不代写——
//   删组只做校验并产出迁移计划（planGroupMigration），由工具层执行。
//
// 错误口径：带稳定 code 的错误（INVALID_INPUT / INVALID_STATE / NOT_FOUND /
// REVISION_CONFLICT），错误形状与 src/storage/errors.mjs 的 StorageError 完全一致
// （name/code/message/details）。P1#7 之后 core 不再 import storage，因此错误工厂
// 在此本地定义；storage 侧 I/O 抛错仍走 src/storage/errors.mjs 的原厂实现，
// 两侧实例形状一致，调用方按 code 判定的行为不变。

import { validateKey } from './keys.mjs';
import { RETENTION_VALUES } from './topics.mjs';
import { describe, isPlainRecord } from './errors.mjs';

/** groups.json 结构版本（0.4 S3 只认 1）。 */
export const GROUPS_VERSION = 1;

/** 组清单文件名（相对 scopes/<scopeId>/）。 */
export const GROUPS_FILE_NAME = 'groups.json';

// 默认组模板：只预置一个「通用」组（0.4 调整）。
// 早前预置 dev / self / project / life 四组，问题有两个：组清单会跟着 topic 索引
// 一起进 L1，四个空组等于白占四行预算；而且绝大多数人实际只用一两个组，剩下
// 的是噪音。现在按需建组（组工具 create），空库只留一个能落东西的地方。
// 深冻结常量：UI 与工具引同一份，杜绝副本漂移；需要可变副本时用
// defaultGroupsTemplate() 取深拷贝。
export const DEFAULT_GROUPS_TEMPLATE = Object.freeze([
  Object.freeze({ key: 'general', title: '通用', summary: '没有特别归类的内容', order: 10 }),
]);

/** 默认模板的可变深拷贝（写入 groups.json 用）。 */
export function defaultGroupsTemplate() {
  return DEFAULT_GROUPS_TEMPLATE.map((entry) => ({ ...entry }));
}

// ---------- 本地错误工厂（形状与 storage/errors.mjs 的 StorageError 一致） ----------

/**
 * 纯逻辑层抛错的最小构造：与 StorageError 同形（name/code/message/details），
 * 使调用方按 code 与 message 判定的行为与重构前完全一致。
 * storage 侧 I/O 错误仍由 src/storage/errors.mjs 原厂构造（真 StorageError 实例）。
 */
function codedError(code, message, details) {
  const error = new Error(message);
  error.name = 'StorageError';
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function invalidInput(message, details) {
  return codedError('INVALID_INPUT', message, details);
}

function invalidState(message, details) {
  return codedError('INVALID_STATE', message, details);
}

// ---------- 纯工具（与 storage/fsutil.mjs 同实现，复制以断开对 storage 的导入） ----------

/**
 * 严格 UTF-8 解码（纯函数，无 fs）：字节损坏时抛 INVALID_STATE，
 * 绝不静默生成 U+FFFD 替换字符（R6）。与 fsutil.decodeUtf8Strict 逐字一致。
 */
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function decodeUtf8Strict(buf, where) {
  try {
    return strictDecoder.decode(buf);
  } catch (err) {
    throw invalidState(`${where}: 文件字节不是合法 UTF-8，拒绝静默替换`, {
      where,
      error: err.message,
    });
  }
}

/** 是否含孤立 UTF-16 代理码元（无法无损编码为 UTF-8，会静默变 U+FFFD）。 */
export function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i += 1; // 合法代理对，跳过低代理
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** 64 位小写 hex 判定（revision CAS 入参校验用）。 */
export function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * 组 key 校验：与 topic key 同一文件名级安全规则（keys.mjs）。
 * 组 key 只落在 groups.json 与 front-matter，不直接成为文件名，
 * 但复用同一规则保证清单、front-matter 与后续 UI 的字符口径一致。
 */
export function validateGroupKey(key, where = 'group key') {
  if (typeof key !== 'string' || key.length === 0) {
    throw invalidInput(`${where} 必须是非空字符串，得到 ${typeof key}`);
  }
  try {
    validateKey(key);
  } catch (error) {
    throw invalidInput(`${where} 不符合 key 规范: ${error.message}`);
  }
  return key;
}

/**
 * 组条目共享契约（0.5 债收口 R2，唯一实现）：core/groups.mjs 与 core/render.mjs
 * 的 validateGroupEntry 曾是同名不同契约的两份实现——共享字段规则各自漂移，
 * 写入侧放行的数据（如含换行的 summary）会被渲染侧拒绝。本函数收口共享字段：
 * plain record 判定（与 errors.mjs requireObject 同语义同措辞）、key/title
 * 必须是自有属性且非空、key 规范（keys.mjs）、summary 出现时必须是字符串且
 * 不得含换行（索引行结构不变量，与 validateTopic 同族同措辞）。
 * 两个入口在此之上叠加各自的层内字段：
 * - core/groups.mjs validateGroupEntry（groups.json 记录）：summary/order 记录层
 *   必填、孤立代理码元（INVALID_STATE）、retention 枚举。
 * - core/render.mjs validateGroupEntry（renderL1 groups 输入）：summary 缺省补
 *   ''，pinned/members 形状。
 * members/pinned 在记录层是未知字段（容忍丢弃，前向兼容），在渲染层是一等
 * 输入（强校验）——层内分歧在 test/core/groups.test.mjs 的契约对照用例钉死。
 * 返回归一化共享字段 {key, title, summary}（summary 缺省补 ''）。
 * 错误经本地 codedError 抛出（INVALID_INPUT，StorageError 形状）。
 */
export function validateGroupEntryShared(entry, where) {
  if (!isPlainRecord(entry)) {
    throw invalidInput(`${where} must be a plain object, got ${describe(entry)}`);
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'key')) {
    throw invalidInput(`${where} is missing required property "key"`);
  }
  if (typeof entry.key !== 'string' || entry.key.length === 0) {
    throw invalidInput(`${where}: key must be a non-empty string`);
  }
  try {
    validateKey(entry.key);
  } catch (error) {
    throw invalidInput(`${where}: ${error.message}`);
  }
  if (!Object.prototype.hasOwnProperty.call(entry, 'title')) {
    throw invalidInput(`${where} is missing required property "title"`);
  }
  if (typeof entry.title !== 'string' || entry.title.length === 0) {
    throw invalidInput(`${where}: title must be a non-empty string`);
  }
  if (entry.summary !== undefined && typeof entry.summary !== 'string') {
    throw invalidInput(`${where}: summary must be a string when present`);
  }
  const summary = entry.summary ?? '';
  // 索引行结构不变量：组摘要进单行索引，换行会破坏行结构（与 topic summary 同规）
  if (summary.includes('\n') || summary.includes('\r')) {
    throw invalidInput(`${where}: summary must not contain line breaks`);
  }
  return { key: entry.key, title: entry.title, summary };
}

/**
 * 校验单个组条目（groups.json 元素 / create 参数）。
 * 必填：key/title/summary/order（与文档 §S3.2 结构一致）；未知字段读取时容忍
 * （前向兼容），归一化时丢弃——清单重写后文件里保留契约四字段 + 可选 retention。
 * 0.5 债收口 R2：key/title/summary 共享规则走 validateGroupEntryShared 单一
 * 实现（换行禁令由此对写入侧生效——此前写入侧放行含换行摘要、渲染侧拒绝，
 * 是两份同名契约漂移的实证）；本函数只叠加记录层字段：summary/order 必填、
 * order 有限数字、孤立代理码元（INVALID_STATE）、retention 枚举。
 * 0.5 批次 2 A 线（阶段 A.1）：可选组级 retention 策略（组默认值，topic 显式值
 * 覆盖组，解析在 core/topics.mjs 的 resolveRetention）——出现时必须是合法枚举
 * 成员，非法值 INVALID_INPUT（不许静默纠正）；缺省时归一化结果不带该键
 * （老清单文件字节形状不变）。
 */
export function validateGroupEntry(entry, where) {
  const shared = validateGroupEntryShared(entry, where);
  for (const field of ['summary', 'order']) {
    if (!Object.prototype.hasOwnProperty.call(entry, field)) {
      throw invalidInput(`${where} is missing required property "${field}"`);
    }
  }
  if (typeof entry.order !== 'number' || !Number.isFinite(entry.order)) {
    throw invalidInput(`${where}: order must be a finite number`);
  }
  if (hasLoneSurrogate(shared.title) || hasLoneSurrogate(shared.summary)) {
    throw invalidState(`${where} 含孤立代理码元，无法无损写入`);
  }
  const normalized = { key: shared.key, title: shared.title, summary: shared.summary, order: entry.order };
  if (entry.retention !== undefined) {
    if (!RETENTION_VALUES.includes(entry.retention)) {
      throw invalidInput(`${where}.retention 必须是 ${RETENTION_VALUES.map((v) => `"${v}"`).join(' | ')} 之一，得到 ${typeof entry.retention === 'string' ? `"${entry.retention.slice(0, 60)}"` : String(entry.retention)}`);
    }
    normalized.retention = entry.retention;
  }
  return normalized;
}

/**
 * 校验并归一化整个组清单数据：{version, groups}。
 * version 只认 GROUPS_VERSION；组 key 不得重复；返回全新归一化对象。
 */
export function validateGroupsData(data, where = 'groups.json') {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw invalidState(`${where} 顶层必须是对象`);
  }
  if (data.version !== GROUPS_VERSION) {
    throw invalidState(`${where} 的 version 必须是 ${GROUPS_VERSION}，得到 `
      + `${typeof data.version === 'string' ? `"${data.version}"` : String(data.version)}；`
      + '文件可能由更高版本工具写出，请勿手工改写 version');
  }
  if (!Array.isArray(data.groups)) {
    throw invalidState(`${where} 的 groups 必须是数组`);
  }
  const seen = new Set();
  const groups = [];
  for (let i = 0; i < data.groups.length; i += 1) {
    const entry = validateGroupEntry(data.groups[i], `${where}.groups[${i}]`);
    if (seen.has(entry.key)) {
      throw invalidState(`${where} 组 key 重复: "${entry.key}"`);
    }
    seen.add(entry.key);
    groups.push(entry);
  }
  return { version: GROUPS_VERSION, groups };
}

/**
 * 校验 topic 挂载的组 key 全部存在于清单（§S3.1：不存在则报错并提示先建组）。
 * 报错可读：逐个列出缺失 key 与现有组。
 */
export function assertGroupsExist(data, keys, where = 'group') {
  const known = new Set(data.groups.map((g) => g.key));
  const missing = [];
  for (const key of keys) {
    if (!known.has(key)) missing.push(key);
  }
  if (missing.length > 0) {
    throw invalidInput(
      `${where} ${missing.map((k) => `"${k}"`).join('、')} 不存在，请先建组`
      + `（现有组: ${[...known].join(', ') || '无'}）`,
      { missing, known: [...known] },
    );
  }
}

// ---------- 纯函数：序列化 / 解析（字节级契约，storage 层读写时调用） ----------

/**
 * 组清单数据 → 落盘字节（2 空格缩进 + 尾换行，与 state/current.json 等
 * 既有 JSON 落盘风格一致）。写入前全量校验。
 * @returns {Buffer}
 */
export function serializeGroupsFile(data) {
  const normalized = validateGroupsData(data);
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

/**
 * 磁盘字节 → 组清单数据：严格解码 + JSON 解析 + 全量校验。
 * 纯函数：只消费 Buffer，不触文件系统。
 *
 * 错误族（0.5 批次 8-4 统一）：磁盘字节入口一律 INVALID_STATE——与 topic 解析
 * （parseTopicFile 全部 invalidState）同族。validateGroupsData 的字段级校验
 * 会抛 INVALID_INPUT（那是「写入口的用户 payload」族），本函数在此裹成
 * INVALID_STATE（message/details 原样保留）；写入口（serializeGroupsFile /
 * writeGroups / store.commit 的 payload 校验）仍直接调 validateGroupsData，
 * 保持 INVALID_INPUT 不变。
 */
export function parseGroupsFile(raw, fileLabel) {
  const text = decodeUtf8Strict(raw, fileLabel);
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw invalidState(`${fileLabel} 不是合法 JSON: ${error.message}`);
  }
  try {
    return validateGroupsData(data, fileLabel);
  } catch (error) {
    if (error?.code === 'INVALID_INPUT') {
      throw invalidState(error.message, error.details);
    }
    throw error;
  }
}

/**
 * topic 挂载快照归一化（删组/迁移的成员判定输入）：
 * 元素形如 {key, group: string[]}，group 缺省补 []（读取口径）。
 */
export function normalizeTopicsInput(topics) {
  if (!Array.isArray(topics)) {
    throw invalidInput('topics 必须是数组（元素形如 {key, group: string[]}）');
  }
  return topics.map((t, i) => {
    if (t === null || typeof t !== 'object' || Array.isArray(t)) {
      throw invalidInput(`topics[${i}] 必须是对象`);
    }
    if (typeof t.key !== 'string' || t.key.length === 0) {
      throw invalidInput(`topics[${i}].key 必须是非空字符串`);
    }
    const group = t.group === undefined ? [] : t.group;
    if (!Array.isArray(group) || group.some((g) => typeof g !== 'string')) {
      throw invalidInput(`topics[${i}].group 必须是字符串数组`);
    }
    return { key: t.key, group };
  });
}

// ---------- 纯函数：迁移计划（§S3.5 删组迁移） ----------

/**
 * 单个 topic 的 group 数组迁移：把 fromKey 摘出、toKey 顶替其原位置
 * （保主组语义）；toKey 已在剩余组里则不重复添加。
 * @returns {string[]|null} 非成员返回 null（调用方跳过），成员返回新数组
 */
export function migrateGroupArray(group, fromKey, toKey) {
  const index = group.indexOf(fromKey);
  if (index === -1) return null;
  const next = group.filter((k) => k !== fromKey);
  if (toKey !== undefined && !next.includes(toKey)) {
    next.splice(Math.min(index, next.length), 0, toKey);
  }
  return next;
}

/**
 * 迁移计划：topics（形如 {key, group: string[]}）中挂了 fromKey 的条目，
 * 逐个给出迁移后的 group 数组。只产计划不写盘——topic 文件改写必须走
 * store 提交协议，由上层工具执行。
 * @returns {{topicKey: string, group: string[]}[]}
 */
export function planGroupMigration(topics, fromKey, toKey) {
  if (toKey !== undefined && toKey === fromKey) {
    throw invalidInput('migrateTo 不能等于被删除的组 key');
  }
  const plan = [];
  for (const { key, group } of normalizeTopicsInput(topics)) {
    const next = migrateGroupArray(group, fromKey, toKey);
    if (next !== null) plan.push({ topicKey: key, group: next });
  }
  return plan;
}
