// Shiori 0.5-1A · 组清单（groups.json）文件 I/O 层。
//
// P1#7 解环：此前组清单的读写实现住在 src/core/groups.mjs，导致
// core → storage（锁/fsutil/路径）与 storage/store.mjs → core（readGroups）
// 双向依赖。本模块把文件 I/O（realpath 归一、锁、原子替换、CAS）下沉到
// storage 层；core/groups.mjs 只留纯逻辑（校验/序列化/迁移计划），
// 依赖方向收敛为 storage → core 单向，依赖图无环。
//
// 与 store 同一套地基：
// - 锁：lockfile.withLock 对同 root 可重入（AsyncLocalStorage 识别嵌套），
//   commit 持锁期间调用 readGroups 不会死锁——与 store 共用同一把跨进程锁；
// - root 一律先 realpath，与 store 的 rootReal 同一身份，否则锁互斥失效；
// - 原子写复用 fsutil.atomicReplace；读路径绝不写盘。
//
// 错误口径：复用 src/storage/errors.mjs 的 StorageError 原厂构造——
//   INVALID_INPUT（入参）、INVALID_STATE（磁盘数据损坏/不支持版本）、
//   NOT_FOUND（清单或组不存在）、REVISION_CONFLICT（CAS 失败）。
// 纯逻辑校验（清单形状/key 规范）由 core/groups.mjs 抛出（同形状同 code）。

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { invalidInput, invalidState, notFound, revisionConflict } from './errors.mjs';
import { groupsFilePath, assertNoEscapeViaSymlink } from './paths.mjs';
import { withLock } from './lockfile.mjs';
import { atomicReplace, readFileOrNull, sha256Buffer } from './fsutil.mjs';
import {
  GROUPS_VERSION, defaultGroupsTemplate, validateGroupKey, validateGroupsData,
  serializeGroupsFile, parseGroupsFile, normalizeTopicsInput, planGroupMigration, isHex64,
} from '../core/groups.mjs';

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
