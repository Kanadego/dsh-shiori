// Shiori 0.4-S3 · topic 分组元数据契约与组清单（groups.json）数据层。
// 依据 docs/0.4-DEV-PLAN.md §S3.1 / §S3.2 / §S3.5，字段命名与文档一致。
//
// 组清单文件：<dataRoot>/scopes/<scopeId>/groups.json（scope 内私有，不跨人设共享）：
//   { "version": 1, "groups": [{ "key", "title", "summary", "order" }] }
//
// 设计要点：
// - 锁与原子写复用 src/storage 现成实现（lockfile.withLock + fsutil.atomicReplace），
//   与 topic 写入同一把锁；root 一律先 realpath——与 store 的 rootReal 同一身份，
//   否则会绕开存储层的跨进程文件锁。
// - 读取路径绝不写盘：readGroups 遇到文件缺失抛 NOT_FOUND，不静默初始化；
//   首次初始化显式走 ensureGroupsFile（幂等，缺文件才写默认模板）。
// - 默认模板以常量导出（DEFAULT_GROUPS_TEMPLATE），后续 UI 与工具引同一份，
//   不允许各自再造一份组名。
// - topic 侧 group 校验（形状/key 规范）在 topics.mjs；本模块负责
//   「组 key 必须存在于 groups.json」与「删组须迁移」的清单层校验。
// - topic 文件本身的迁移改写走 store 提交协议（journal/CAS），本模块不代写——
//   deleteGroup 只做校验并产出迁移计划（planGroupMigration），由工具层执行。
//
// 错误口径：复用 storage 错误（带稳定 code 的 StorageError）——
//   INVALID_INPUT（入参/清单形状）、INVALID_STATE（磁盘数据损坏/不支持版本）、
//   NOT_FOUND（清单或组不存在）、REVISION_CONFLICT（CAS 失败）。

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { validateKey } from './keys.mjs';
import {
  invalidInput, invalidState, notFound, revisionConflict,
} from '../storage/errors.mjs';
import {
  groupsFilePath, assertNoEscapeViaSymlink,
} from '../storage/paths.mjs';
import { withLock } from '../storage/lockfile.mjs';
import {
  atomicReplace, readFileOrNull, decodeUtf8Strict, sha256Buffer, hasLoneSurrogate,
} from '../storage/fsutil.mjs';

export { groupsFilePath };

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
 * 校验单个组条目（groups.json 元素 / create 参数）。
 * 必填：key/title/summary/order（与文档 §S3.2 结构一致）；未知字段读取时容忍
 * （前向兼容），归一化时丢弃——清单重写后文件里只保留契约四字段。
 */
export function validateGroupEntry(entry, where) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw invalidInput(`${where} 必须是对象`);
  }
  for (const field of ['key', 'title', 'summary', 'order']) {
    if (!Object.prototype.hasOwnProperty.call(entry, field)) {
      throw invalidInput(`${where} 缺少必填字段 "${field}"`);
    }
  }
  validateGroupKey(entry.key, `${where}.key`);
  if (typeof entry.title !== 'string' || entry.title.length === 0) {
    throw invalidInput(`${where}.title 必须是非空字符串`);
  }
  if (typeof entry.summary !== 'string') {
    throw invalidInput(`${where}.summary 必须是字符串`);
  }
  if (typeof entry.order !== 'number' || !Number.isFinite(entry.order)) {
    throw invalidInput(`${where}.order 必须是有限数字`);
  }
  if (hasLoneSurrogate(entry.title) || hasLoneSurrogate(entry.summary)) {
    throw invalidState(`${where} 含孤立代理码元，无法无损写入`);
  }
  return { key: entry.key, title: entry.title, summary: entry.summary, order: entry.order };
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
  for (let i = 0; i < data.groups.length; i++) {
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

// ---------- 磁盘 I/O（锁 + 原子写，与 store 同一把锁） ----------

function assertAbsolutePath(dataRoot) {
  if (typeof dataRoot !== 'string' || dataRoot.length === 0) {
    throw invalidInput('dataRoot 必须是非空字符串（绝对路径）');
  }
  if (!path.isAbsolute(dataRoot)) {
    throw invalidInput('dataRoot 必须是绝对路径', { dataRoot });
  }
}

/** realpath 归一：与 store 的 rootReal 同一身份，锁才真正互斥。 */
async function toRootReal(dataRoot) {
  assertAbsolutePath(dataRoot);
  try {
    return await fsp.realpath(dataRoot);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw notFound(`dataRoot 不存在: ${dataRoot}`, { dataRoot, ioCode: err.code });
    }
    throw err;
  }
}

function lockOpts(options = {}) {
  return {
    timeoutMs: options.lockTimeoutMs ?? 10_000,
    retryMs: options.retryMs ?? 50,
  };
}

function serializeGroupsFile(data) {
  const normalized = validateGroupsData(data);
  // 2 空格缩进 + 尾换行：与 state/current.json 等既有 JSON 落盘风格一致
  return Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
}

function parseGroupsFile(raw, fileLabel) {
  const text = decodeUtf8Strict(raw, fileLabel);
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw invalidState(`${fileLabel} 不是合法 JSON: ${error.message}`);
  }
  return validateGroupsData(data, fileLabel);
}

function normalizeTopicsInput(topics) {
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

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/**
 * 读取组清单（锁内；缺失抛 NOT_FOUND，读路径绝不写盘）。
 * @returns {Promise<{revision: string, data: {version: number, groups: Array}}>}
 */
export async function readGroups({ dataRoot, scopeId, lockTimeoutMs, retryMs } = {}) {
  const rootReal = await toRootReal(dataRoot);
  const file = groupsFilePath(rootReal, scopeId);
  return withLock(rootReal, lockOpts({ lockTimeoutMs, retryMs }), async () => {
    await assertNoEscapeViaSymlink(rootReal, file);
    const raw = await readFileOrNull(file);
    if (raw === null) {
      throw notFound(
        `组清单不存在: ${file}（首次使用请先调用 ensureGroupsFile 初始化默认模板）`,
        { file, scopeId },
      );
    }
    return { revision: sha256Buffer(raw), data: parseGroupsFile(raw, `groups.json(${scopeId})`) };
  });
}

/**
 * 首次初始化（幂等，§S3.2）：groups.json 缺失时写入默认模板；
 * 已存在时只校验不改动。初始化也是写操作，必须在锁内、原子写。
 * @returns {Promise<{created: boolean, revision: string, data: object}>}
 */
export async function ensureGroupsFile({ dataRoot, scopeId, lockTimeoutMs, retryMs } = {}) {
  const rootReal = await toRootReal(dataRoot);
  const file = groupsFilePath(rootReal, scopeId);
  return withLock(rootReal, lockOpts({ lockTimeoutMs, retryMs }), async () => {
    await assertNoEscapeViaSymlink(rootReal, file);
    // scopes/<scopeId>/ 可能尚不存在（如 global scope 初始化）
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const raw = await readFileOrNull(file);
    if (raw !== null) {
      return {
        created: false,
        revision: sha256Buffer(raw),
        data: parseGroupsFile(raw, `groups.json(${scopeId})`),
      };
    }
    const data = { version: GROUPS_VERSION, groups: defaultGroupsTemplate() };
    const buffer = serializeGroupsFile(data);
    await atomicReplace(file, buffer);
    return { created: true, revision: sha256Buffer(buffer), data };
  });
}

/**
 * 整表写入组清单（锁内 + 原子写 + CAS）。
 * @param {Array} groups 组条目数组（{key,title,summary,order}），写入前全量校验
 * @param {string|null} expectedRevision 当前文件 sha256；null = 新建（文件必须不存在）；
 *   与 store 的 revision CAS 同口径，防覆盖并发修改
 * @returns {Promise<{revision: string, data: object}>}
 */
export async function writeGroups({
  dataRoot, scopeId, groups, expectedRevision, lockTimeoutMs, retryMs,
} = {}) {
  if (expectedRevision === undefined) {
    throw invalidInput('expectedRevision 必须显式提供（新建为 null，更新为当前文件 sha256）');
  }
  if (expectedRevision !== null && !isHex64(expectedRevision)) {
    throw invalidInput('expectedRevision 必须是 null 或 64 位 hex sha256', { expectedRevision });
  }
  // 锁外先校验形状（快速失败）；锁内序列化时再验一次，两处同一实现
  const data = validateGroupsData({ version: GROUPS_VERSION, groups }, 'groups.json(待写入)');
  const rootReal = await toRootReal(dataRoot);
  const file = groupsFilePath(rootReal, scopeId);
  return withLock(rootReal, lockOpts({ lockTimeoutMs, retryMs }), async () => {
    await assertNoEscapeViaSymlink(rootReal, file);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const raw = await readFileOrNull(file);
    const current = raw === null ? null : sha256Buffer(raw);
    if (current !== expectedRevision) {
      throw revisionConflict('groups.json revision CAS 失败：磁盘内容与期望哈希不一致（含手改检测）', {
        file, expectedRevision, actualRevision: current,
      });
    }
    const buffer = serializeGroupsFile(data);
    await atomicReplace(file, buffer);
    return { revision: sha256Buffer(buffer), data };
  });
}

/**
 * 删除组（§S3.3 delete，§S3.5：组内仍有 topic 且未给 migrateTo 一律拒绝）。
 * 组内成员由调用方传入（topics: [{key, group}]，即该 scope 的可见 topic 快照，
 * group 已按读取口径补默认 []）——本模块不扫 topics 目录，避免绕开 store 的
 * 影子报告与去重逻辑。
 *
 * 给了 migrateTo 时：目标组必须已存在；返回迁移计划（不写 topic 文件，
 * 迁移改写由工具层走 store 提交协议执行）。
 *
 * @param {Array} topics 组内成员判定用的 topic 快照
 * @param {string|undefined} [expectedRevision] 可选 CAS（undefined = 不校验）
 * @returns {Promise<{revision, data, members: string[], migration: Array}>}
 */
export async function deleteGroup({
  dataRoot, scopeId, key, migrateTo, topics, expectedRevision, lockTimeoutMs, retryMs,
} = {}) {
  validateGroupKey(key, 'key');
  if (migrateTo !== undefined) {
    validateGroupKey(migrateTo, 'migrateTo');
    if (migrateTo === key) {
      throw invalidInput('migrateTo 不能等于被删除的组 key');
    }
  }
  const normalizedTopics = normalizeTopicsInput(topics ?? []);
  if (expectedRevision !== undefined && expectedRevision !== null && !isHex64(expectedRevision)) {
    throw invalidInput('expectedRevision 必须是 null/undefined 或 64 位 hex sha256', { expectedRevision });
  }
  const rootReal = await toRootReal(dataRoot);
  const file = groupsFilePath(rootReal, scopeId);
  return withLock(rootReal, lockOpts({ lockTimeoutMs, retryMs }), async () => {
    await assertNoEscapeViaSymlink(rootReal, file);
    const raw = await readFileOrNull(file);
    if (raw === null) {
      throw notFound(
        `组清单不存在: ${file}（首次使用请先调用 ensureGroupsFile 初始化默认模板）`,
        { file, scopeId },
      );
    }
    const data = parseGroupsFile(raw, `groups.json(${scopeId})`);
    const revision = sha256Buffer(raw);
    if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== revision) {
      throw revisionConflict('groups.json revision CAS 失败：磁盘内容与期望哈希不一致（含手改检测）', {
        file, expectedRevision, actualRevision: revision,
      });
    }
    if (!data.groups.some((g) => g.key === key)) {
      throw notFound(
        `组 "${key}" 不存在于 scope "${scopeId}" 的组清单`
        + `（现有组: ${data.groups.map((g) => g.key).join(', ') || '无'}）`,
        { key, scopeId, known: data.groups.map((g) => g.key) },
      );
    }
    if (migrateTo !== undefined && !data.groups.some((g) => g.key === migrateTo)) {
      throw invalidInput(
        `migrateTo 指向的组 "${migrateTo}" 不存在，请先建组`
        + `（现有组: ${data.groups.map((g) => g.key).join(', ') || '无'}）`,
        { migrateTo, known: data.groups.map((g) => g.key) },
      );
    }
    const members = normalizedTopics
      .filter((t) => t.group.includes(key))
      .map((t) => t.key);
    if (members.length > 0 && migrateTo === undefined) {
      throw invalidState(
        `组 "${key}" 内仍有 ${members.length} 个 topic（${members.join(', ')}），拒绝删除；`
        + '请先把组内 topic 迁出，或提供 migrateTo 指定迁移目标组',
        { key, members },
      );
    }
    const migration = migrateTo !== undefined ? planGroupMigration(normalizedTopics, key, migrateTo) : [];
    const nextData = {
      version: GROUPS_VERSION,
      groups: data.groups.filter((g) => g.key !== key),
    };
    const buffer = serializeGroupsFile(nextData);
    await atomicReplace(file, buffer);
    return { revision: sha256Buffer(buffer), data: nextData, members, migration };
  });
}
