// Shiori 0.5-2B · topic-activity 事件账本（0.5 方案 §5 阶段 A.4，温度引擎统计底座）。
//
// 落盘 <stateRoot>/topic-activity.jsonl：append-only JSONL，每行一个事件。
// 事件形状（写入侧白名单五类 kind：四类加热事件 + settings_change 审计；
// 读取侧对未知 kind 结构兼容，供后续版本扩展）：
//   { at, scopeId, kind: "read"|"updated"|"search_hit"|"group_list", topicKey?, groupKey? }
//   { at, scopeId, kind: "settings_change", operationId, changes, next }
//
// 设计约束（任务书硬要求）：
// - 非阻塞：append() 同步返回、内部排队落盘，绝不抛、绝不 reject；写失败只记
//   诊断（stats().failed / lastError），调用方（host 工具）的返回不受任何影响。
// - scope 归属：scopeId 必须是 targetScopeId（被操作记忆所属 scope），由调用方
//   传入，本模块不猜、不改写——跨 scope 不许错记或漏记的责任边界在调用方。
// - 整行原子：单事件 = 单次 appendFile 写入一整行（行体为百字节级小 JSON，
//   单次 write 完成）；追加模式下并发写者（跨进程/跨协程）交错最坏只影响
//   行序，不会产生两行咬合的半行。
// - 崩溃半行：进程在写入中途被杀会在文件尾留下不带 \n 的残行。两个防线：
//   ① 读取侧按行独立解析，残行/坏行整行跳过，后续行照常解析（绝不把后续行带坏）；
//   ② 写入侧首次落盘前探测文件尾（一次性、记忆化），尾部缺 \n 时先补一个换行
//   再写事件行——避免崩溃残行与重启后第一行咬合成一行（那会多丢一个事件）。
//   探测失败的降级口径：按「无需补换行」继续 appendFile（append 失败本就只记诊断）。
// - 读取/统计入口：readTopicActivity / topicActivityStats 供测试与 0.5 阶段 B
//   温度引擎回放（read/updated 加热序列；search_hit/group_list 只入账不加热）。
//
// 错误口径：本模块是诊断数据路径，append 侧一切失败折叠为 { ok:false }（绝不抛）；
// 读取侧（测试/温度引擎显式调用）遵循 storage 层惯例——入参非法抛 INVALID_INPUT、
// 非 ENOENT 的 IO 失败包装 IO_ERROR，绝不静默吞错。

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { invalidInput, wrapIoError } from './errors.mjs';
import { isCanonicalIso } from './fsutil.mjs';

/** 账本事件 kind 全集（写入侧白名单；读取侧对未知 kind 结构兼容）。
 *  0.5 批次 4 · B 线追加 "settings_change"：热度参数变更审计事件（评审拍板：
 *  正式纳入合法 kind，复用本账本唯一 writer 追加；不参与加热——温度引擎只认
 *  read / updated 的加热语义，未知 kind 一律忽略）。 */
export const TOPIC_ACTIVITY_KINDS = Object.freeze(['read', 'updated', 'search_hit', 'group_list', 'settings_change']);

const ACTIVITY_FILE_NAME = 'topic-activity.jsonl';

/** 账本文件落点（<stateRoot>/topic-activity.jsonl）。 */
export function topicActivityFilePath(stateRoot) {
  return path.join(stateRoot, ACTIVITY_FILE_NAME);
}

function assertStateRoot(stateRoot) {
  if (typeof stateRoot !== 'string' || stateRoot.length === 0) {
    throw invalidInput('stateRoot 必须是非空字符串（绝对路径）');
  }
}

/**
 * 写入侧事件校验（append 用）：非法返回人类可读原因，合法返回 null。
 * - kind 必须在 TOPIC_ACTIVITY_KINDS 内（未知 kind 拒写——温度引擎的加热判据
 *   只认 read/updated，混入未知 kind 会污染统计；settings_change 是审计事件，
 *   引擎按未知 kind 忽略）；
 * - scopeId 必须是非空字符串（targetScopeId 归属边界）；
 * - at 缺省时由账本时钟补（规范 UTC ISO）；显式给出时必须是规范 UTC ISO；
 * - topicKey/groupKey 可选：给出时必须是非空字符串；
 * - settings_change（0.5 批次 4 B 线）：额外要求 operationId 非空字符串、
 *   changes 非空数组、next 完整 12 项参数对象（键级内容由 params.mjs 权威校验，
 *   账本层只挡结构，保持与 validateActivityEvent 其他分支同粒度的 fail-closed）。
 */
export function validateActivityEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    return 'event 必须是对象';
  }
  if (!TOPIC_ACTIVITY_KINDS.includes(event.kind)) {
    return `kind 必须是 ${TOPIC_ACTIVITY_KINDS.join(' / ')} 之一`;
  }
  if (typeof event.scopeId !== 'string' || event.scopeId.length === 0) {
    return 'scopeId 必须是非空字符串（targetScopeId）';
  }
  if (event.at !== undefined && !isCanonicalIso(event.at)) {
    return 'at 必须是规范 UTC ISO 时间串（如 "2026-11-21T00:00:00.000Z"）';
  }
  for (const field of ['topicKey', 'groupKey']) {
    const value = event[field];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      return `${field} 必须是非空字符串或缺省`;
    }
  }
  if (event.kind === 'settings_change') {
    if (typeof event.operationId !== 'string' || event.operationId.length === 0) {
      return 'settings_change.operationId 必须是非空字符串';
    }
    if (!Array.isArray(event.changes) || event.changes.length === 0) {
      return 'settings_change.changes 必须是非空数组';
    }
    if (event.next === null || typeof event.next !== 'object' || Array.isArray(event.next)) {
      return 'settings_change.next 必须是完整 12 项参数对象';
    }
  }
  return null;
}

/**
 * 读取侧事件校验（结构口径，比写入侧宽）：JSON 行解析出的值必须是事件形状。
 * - at/scopeId 必填且 at 必须是规范 UTC ISO（账本写入侧保证；手改/损坏行在此拦截）；
 * - kind 只要求非空字符串——对未来版本新增 kind（如 0.5 阶段 C 的 manual_restored）
 *   结构兼容，旧读取器不丢新事件；
 * - topicKey/groupKey 可选，给出时必须是非空字符串。
 */
function isValidStoredEvent(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.at !== 'string' || !isCanonicalIso(value.at)) return false;
  if (typeof value.scopeId !== 'string' || value.scopeId.length === 0) return false;
  if (typeof value.kind !== 'string' || value.kind.length === 0) return false;
  for (const field of ['topicKey', 'groupKey']) {
    const v = value[field];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) return false;
  }
  return true;
}

/**
 * 创建事件账本（每插件实例一个，stateRoot 全实例共享；事件自带 scopeId 归属）。
 *
 * @param {object} deps
 * @param {string} deps.stateRoot 状态根（绝对路径；账本文件 <stateRoot>/topic-activity.jsonl）
 * @param {() => Date} [deps.now] 事件时间戳时钟（缺省系统时钟；测试注入固定时钟）
 * @param {object} [deps.fs] fs 注入（缺省 node:fs/promises；测试注入抛错桩验证非阻塞）。
 *   使用面：appendFile（事件落盘）、readFile（一次性尾部探测）。
 * @returns {{
 *   append: (event: object) => Promise<{ok: boolean, bytes?: number, code?: string, error?: string}>,
 *   flush: () => Promise<void>,
 *   stats: () => {file: string, appended: number, failed: number, lastError: string|null, pending: number},
 *   file: string,
 * }}
 */
export function createTopicActivityLedger({ stateRoot, now = () => new Date(), fs = fsp } = {}) {
  assertStateRoot(stateRoot);
  if (typeof fs?.appendFile !== 'function' || typeof fs?.readFile !== 'function') {
    throw invalidInput('fs 注入必须提供 appendFile 与 readFile');
  }
  const file = topicActivityFilePath(stateRoot);

  let appended = 0;
  let failed = 0;
  let lastError = null;
  // 单写队列：append 只入队即返回（非阻塞），落盘按入队序串行执行——行序稳定、
  // 尾部探测结论只被消费一次（并发首写不会都去补换行）。
  let chain = Promise.resolve();
  const inflight = new Set();
  // 尾部探测（一次性、记忆化）：null=未探测；boolean=「文件尾缺 \n，需先补一个换行」。
  // 探测失败（非 ENOENT）按「无需补」处理并固化结论，不重试——append 失败本就只记
  // 诊断；该降级的最坏代价是崩溃残行与重启后第一行咬合（丢一个事件），可接受。
  let tailNeedsNewline = null;

  async function writeOne(record) {
    try {
      if (tailNeedsNewline === null) {
        try {
          const raw = await fs.readFile(file, 'utf8');
          tailNeedsNewline = raw.length > 0 && !raw.endsWith('\n');
        } catch (err) {
          // ENOENT = 账本尚不存在（首次写）；其余探测失败同样按「无需补」降级。
          tailNeedsNewline = false;
          if (err?.code !== 'ENOENT') {
            lastError = `tail probe failed: ${err?.code ?? err?.message ?? 'unknown'}`;
          }
        }
      }
      const prefix = tailNeedsNewline === true ? '\n' : '';
      tailNeedsNewline = false; // 结论只消费一次：写入成功（或失败降级）后不再补
      const line = prefix + JSON.stringify(record) + '\n';
      await fs.appendFile(file, line, 'utf8');
      appended += 1;
      return { ok: true, bytes: Buffer.byteLength(line, 'utf8') };
    } catch (err) {
      failed += 1;
      lastError = `${err?.code ?? err?.message ?? 'unknown'}`;
      return { ok: false, code: 'IO_ERROR', error: lastError };
    }
  }

  /**
   * 入账一个事件（非阻塞 fire-and-forget）：同步校验 + 入队即返回；返回的 promise
   * 已内部兜底，永不 reject、resolve 值即写盘结论（测试可 await 断言；生产调用方
   * 不 await）。校验失败同样不抛：记诊断、返回 { ok:false, code:"INVALID_INPUT" }，
   * 不产生任何磁盘写入。
   */
  function append(event) {
    const invalidReason = validateActivityEvent(event);
    if (invalidReason !== null) {
      failed += 1;
      lastError = invalidReason;
      return Promise.resolve({ ok: false, code: 'INVALID_INPUT', error: invalidReason });
    }
    // 事件行键序固定为形状约定顺序（at → scopeId → kind → topicKey → groupKey；
    // settings_change 追加 operationId → changes → next）。
    const record = { at: event.at ?? now().toISOString(), scopeId: event.scopeId, kind: event.kind };
    if (event.topicKey !== undefined) record.topicKey = event.topicKey;
    if (event.groupKey !== undefined) record.groupKey = event.groupKey;
    if (event.kind === 'settings_change') {
      record.operationId = event.operationId;
      record.changes = event.changes;
      record.next = event.next;
    }
    const pending = chain.then(() => writeOne(record));
    chain = pending.then(() => {}, () => {}); // 链体永不 reject（writeOne 已兜底，双保险）
    inflight.add(pending);
    const settle = () => inflight.delete(pending);
    pending.then(settle, settle);
    return pending;
  }

  /** 等待全部在途入账落盘（测试确定性断言用；生产路径不调用）。 */
  async function flush() {
    await chain;
  }

  function stats() {
    return { file, appended, failed, lastError, pending: inflight.size };
  }

  return { append, flush, stats, file };
}

/**
 * 读取账本事件（坏行容忍）：按行独立 JSON 解析 + 结构校验，非法行整行跳过
 * （计入 skipped），后续行照常解析。账本不存在（ENOENT）视为空账本。
 *
 * @param {object} args
 * @param {string} args.stateRoot 状态根
 * @param {string} [args.scopeId] 可选过滤：只返回该 scope 的事件（targetScopeId 口径）
 * @param {object} [args.fs] fs 注入（缺省 node:fs/promises；使用面 readFile）
 * @returns {Promise<{events: Array<object>, skipped: number}>}
 */
export async function readTopicActivity({ stateRoot, scopeId, fs = fsp } = {}) {
  assertStateRoot(stateRoot);
  if (typeof fs?.readFile !== 'function') {
    throw invalidInput('fs 注入必须提供 readFile');
  }
  const file = topicActivityFilePath(stateRoot);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { events: [], skipped: 0 };
    throw wrapIoError(`read ${file}`, err);
  }
  const events = [];
  let skipped = 0;
  // 尾部 \n 让 split 产生末尾空元素——那是文件结尾不是坏行，先剥掉；
  // 其余空行/纯空白行视为损坏内容（计入 skipped），一律跳过不中断。
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      skipped += 1;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    if (!isValidStoredEvent(parsed)) {
      skipped += 1;
      continue;
    }
    if (scopeId !== undefined && parsed.scopeId !== scopeId) continue;
    events.push(parsed);
  }
  return { events, skipped };
}

/**
 * 账本统计（温度引擎/测试用）：按 kind 计数。四类加热键恒齐（缺省 0）；
 * settings_change 审计事件计入 total/skipped，但不进入 byKind（不参与加热统计）。
 * scopeId 过滤口径与 readTopicActivity 一致；skipped 透传（账本健康度观测）。
 *
 * @returns {Promise<{total: number, skipped: number, byKind: {read: number, updated: number, search_hit: number, group_list: number}}>}
 */
export async function topicActivityStats({ stateRoot, scopeId, fs = fsp } = {}) {
  const { events, skipped } = await readTopicActivity({ stateRoot, scopeId, fs });
  const byKind = { read: 0, updated: 0, search_hit: 0, group_list: 0 };
  for (const event of events) {
    if (event.kind in byKind) byKind[event.kind] += 1;
  }
  return { total: events.length, skipped, byKind };
}
