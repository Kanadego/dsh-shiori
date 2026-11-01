// Shiori F4 · 最近变更时间线数据层（双源合并，纯只读）。
//
// 双源（F4 现状核对：spark 写完全不经过 journal）：
//   ① <dataRoot>/journal/<operationId>.json 里 phase=committed 的事务记录
//      —— 覆盖 core / topic 写入；提交成功后条目不删、长期堆积、无轮转
//      （src/storage/store.mjs 只清 staging）；
//   ② <dataRoot>/sparks/scopes/<scopeId>/sparks.json 的 operations 账
//      （db.ops[operationId] = { kind, fingerprint, at, result }，单文件
//      原子替换；覆盖存卡 / 改卡 / 归档 / 替代 / 反馈 / 织网 / merge 退休）。
//
// 合并：两源按时间倒序归并、标注来源；同一 operationId 两边都有视为同一
// 操作，去重保留 journal 版本并在 detail.dedupedWith 标注。
//
// 资源约束（journal 会长期堆积，绝不一次读全量进内存排序）：
//   - 先 readdir 拿文件名（零内容读取），分批 stat 取 mtime，只保留最新的
//     SCAN_LIMIT 个文件再分批读内容；
//   - 合并结果按 offset+limit+1 有界截断（+1 供 hasMore 判定）。
//
// 只读保证：本模块只 stat / readFile，绝不写 dataRoot；journal 与 spark 库
// 里任何损坏记录都被跳过并计入 skippedCorrupted，不炸整个时间线视图。

import { promises as fsp } from "node:fs";
import path from "node:path";

export const TIMELINE_DEFAULT_LIMIT = 100;
export const TIMELINE_MAX_LIMIT = 500;
/** 单次调用最多读取内容的 journal 文件数（按 mtime 取最新；防长期堆积拖垮面板）。 */
export const TIMELINE_JOURNAL_SCAN_LIMIT = 4000;

const IO_BATCH = 64;

/** 与 storage/journal.mjs 一致的四态：phase 缺失/非法的记录按损坏计。 */
const JOURNAL_PHASES = new Set(["prepared", "committing", "committed", "aborted"]);

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

/**
 * spark 写操作账 → 时间线条目的映射。
 * delivery-hit（投递统计）与 organize-bind（绑定标记）非内容写，不上时间线。
 */
const SPARK_OP_ACTION_BY_KIND = {
  "save": "spark.save",
  "update": "spark.update",
  "forget": null, // 由 result.state 细分 archive / supersede
  "feedback": "spark.feedback",
  "useful-feedback": "spark.feedback",
  "organize-links": "spark.links",
  "retire-merged": "spark.retire",
  "forget-archive": "spark.archive",
};
const SPARK_OP_KINDS_EXCLUDED = new Set(["delivery-hit", "organize-bind"]);

/** 时间线归并排序：atMs 倒序；相等时保持原始插入顺序（与旧的二分插入语义一致）。 */
function byAtDesc(a, b) {
  return b.atMs - a.atMs;
}

/** 两路已按 atMs 倒序的列表归并（稳定：左边相等时优先，即 journal 优先）。 */
function mergeByAtDesc(left, right) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i].atMs >= right[j].atMs) out.push(left[i++]);
    else out.push(right[j++]);
  }
  while (i < left.length) out.push(left[i++]);
  while (j < right.length) out.push(right[j++]);
  return out;
}

/** 有界倒序插入：保持 desc，长度超 keep 截尾。 */
function insertSortedDesc(list, entry, keep) {
  const at = entry.atMs;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].atMs >= at) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, entry);
  if (list.length > keep) list.length = keep;
}

/** journal committed 记录 → 0..n 条时间线条目（每条 change 一条，主 change 在首）。 */
function journalEntries(journal) {
  if (journal === null || typeof journal !== "object" || Array.isArray(journal)) return [];
  if (journal.phase !== "committed") return [];
  if (typeof journal.operationId !== "string" || journal.operationId.length === 0) return [];
  if (typeof journal.scopeId !== "string" || journal.scopeId.length === 0) return [];
  const at = typeof journal.updatedAt === "string" && Number.isFinite(Date.parse(journal.updatedAt))
    ? journal.updatedAt
    : (typeof journal.createdAt === "string" && Number.isFinite(Date.parse(journal.createdAt))
      ? journal.createdAt
      : null);
  if (at === null) return [];
  const changes = Array.isArray(journal.changes) ? journal.changes : [];
  const entries = [];
  for (const change of changes) {
    if (change === null || typeof change !== "object" || Array.isArray(change)) continue;
    if (change.kind !== "core" && change.kind !== "topic") continue;
    if (typeof change.key !== "string" || change.key.length === 0) continue;
    entries.push({
      atMs: Date.parse(at),
      item: {
        at: new Date(Date.parse(at)).toISOString(),
        action: `${change.kind}.write`,
        source: "journal",
        scope: journal.scopeId,
        target: { type: change.kind, id: change.key, title: null },
        detail: { operationId: journal.operationId },
      },
    });
  }
  return entries;
}

/** spark operations 账条目 → 时间线条目（非内容写 kind 返回 null）。 */
function sparkEntry(operationId, op, scopeId) {
  if (op === null || typeof op !== "object" || Array.isArray(op)) return null;
  if (SPARK_OP_KINDS_EXCLUDED.has(op.kind)) return null;
  const actionBase = Object.hasOwn(SPARK_OP_ACTION_BY_KIND, op.kind) ? SPARK_OP_ACTION_BY_KIND[op.kind] : undefined;
  if (actionBase === undefined) return null;
  const at = typeof op.at === "string" && Number.isFinite(Date.parse(op.at)) ? op.at : null;
  if (at === null) return null;
  const result = op.result !== undefined && op.result !== null && typeof op.result === "object" && !Array.isArray(op.result)
    ? op.result
    : {};
  let action = actionBase;
  let targetId = typeof result.id === "string" ? result.id : null;
  let targetTitle = typeof result.title === "string" ? result.title : null;
  let targetType = "spark";
  const detail = { operationId };
  if (op.kind === "forget") {
    action = result.state === "superseded" ? "spark.supersede" : "spark.archive";
    if (result.state === "superseded" && typeof result.supersededBy === "string") {
      detail.replacementId = result.supersededBy;
    }
  }
  if (op.kind === "organize-links") {
    const updated = Array.isArray(result.updated) ? result.updated.filter((u) => u && typeof u.id === "string") : [];
    if (updated.length === 0) return null;
    targetId = updated[0].id;
    detail.changedIds = updated.map((u) => u.id);
    detail.changedItems = typeof result.changedItems === "number" ? result.changedItems : updated.length;
  }
  if (op.kind === "retire-merged") {
    const topic = result.topic !== null && typeof result.topic === "object" && typeof result.topic.key === "string"
      ? result.topic
      : null;
    const retired = Array.isArray(result.retired) ? result.retired.filter((u) => u && typeof u.id === "string") : [];
    if (topic === null || retired.length === 0) return null;
    targetType = "topic"; // 回跳对象是升华后的专题
    targetId = topic.key;
    targetTitle = null;
    detail.changedIds = retired.map((u) => u.id);
    detail.changedItems = typeof result.changedItems === "number" ? result.changedItems : retired.length;
  }
  if (op.kind === "forget-archive") {
    const items = Array.isArray(result.items) ? result.items.filter((c) => c && typeof c.id === "string") : [];
    if (items.length === 0) return null;
    targetId = items[0].id;
    targetTitle = typeof items[0].title === "string" ? items[0].title : null;
    detail.changedIds = items.map((c) => c.id);
    detail.changedItems = items.length;
  }
  if (targetId === null) return null;
  return {
    atMs: Date.parse(at),
    item: {
      at: new Date(Date.parse(at)).toISOString(),
      action,
      source: "spark",
      scope: scopeId,
      target: { type: targetType, id: targetId, title: targetTitle },
      detail,
    },
  };
}

/**
 * 打开时间线读取器。
 *
 * @param {object} params
 * @param {string} params.dataRoot 业务数据根（绝对路径；journal 与 sparks 都在其下）
 */
export function createTimelineReader({ dataRoot, scanLimit = TIMELINE_JOURNAL_SCAN_LIMIT } = {}) {
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot)) {
    fail("INVALID_INPUT", "timeline reader requires an absolute dataRoot", {});
  }
  if (!Number.isInteger(scanLimit) || scanLimit < 1) {
    fail("INVALID_INPUT", "timeline reader scanLimit must be a positive integer", { scanLimit });
  }

  const journalDir = path.join(dataRoot, "journal");

  /** 分批 stat 取 mtime，返回按 mtime 倒序截断到 scanLimit 的文件名列表。 */
  async function newestJournalFiles(scanLimit) {
    let names;
    try {
      names = await fsp.readdir(journalDir);
    } catch (err) {
      if (err.code === "ENOENT") return { selected: [], total: 0 };
      throw err;
    }
    const jsonNames = names.filter((name) => name.endsWith(".json"));
    let top = []; // { name, mtimeMs } 按 mtimeMs 降序，长度 ≤ scanLimit
    for (let i = 0; i < jsonNames.length; i += IO_BATCH) {
      const batch = jsonNames.slice(i, i + IO_BATCH);
      const stats = await Promise.all(batch.map(async (name) => {
        try {
          const st = await fsp.stat(path.join(journalDir, name));
          return { name, mtimeMs: st.mtimeMs };
        } catch {
          return null; // stat 瞬时失败（被并发清理等）：跳过该文件
        }
      }));
      for (const s of stats) {
        if (s === null) continue;
        insertSortedDesc(top, s, scanLimit);
      }
    }
    top = top.slice(0, scanLimit);
    return { selected: top, total: jsonNames.length };
  }

  /**
   * 读取时间线（倒序分页）。
   *
   * @param {object} params
   * @param {string} params.scope   scope 过滤（必填：时间线只出本 scope）
   * @param {number} [params.offset] 跳过条数（默认 0）
   * @param {number} [params.limit]  单页条数（默认 100，上限 500）
   * @returns {{scope, items, hasMore, skippedCorrupted}}
   */
  async function read({ scope, offset = 0, limit = TIMELINE_DEFAULT_LIMIT }) {
    if (typeof scope !== "string" || scope.length === 0) {
      fail("INVALID_INPUT", "timeline read requires a non-empty scope", { scope });
    }
    if (!Number.isInteger(offset) || offset < 0) {
      fail("INVALID_INPUT", `timeline offset must be a non-negative integer, got ${JSON.stringify(offset)}`, { offset });
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > TIMELINE_MAX_LIMIT) {
      fail("INVALID_INPUT", `timeline limit must be an integer in 1..${TIMELINE_MAX_LIMIT}, got ${JSON.stringify(limit)}`, { limit });
    }
    let skippedCorrupted = 0;
    const journalList = [];
    const sparkList = [];

    // ① journal（分批：readdir → stat 取最新 scanLimit → 分批读内容）
    const { selected, total: journalFileCount } = await newestJournalFiles(scanLimit);
    for (let i = 0; i < selected.length; i += IO_BATCH) {
      const batch = selected.slice(i, i + IO_BATCH);
      const parsed = await Promise.all(batch.map(async ({ name }) => {
        try {
          const raw = await fsp.readFile(path.join(journalDir, name), "utf8");
          const journal = JSON.parse(raw);
          // 合法 JSON 但协议形状损坏（非对象 / phase 非法）→ 按损坏计，
          // 与 journal.mjs「损坏记录不得被静默遗漏」同口径；prepared/
          // committing/aborted 等合法非终态记录只是不上时间线，不算损坏。
          if (journal === null || typeof journal !== "object" || Array.isArray(journal)
            || typeof journal.phase !== "string" || !JOURNAL_PHASES.has(journal.phase)) {
            skippedCorrupted += 1;
            return [];
          }
          return journalEntries(journal);
        } catch {
          skippedCorrupted += 1;
          return [];
        }
      }));
      for (const entries of parsed) {
        for (const entry of entries) {
          if (entry.item.scope !== scope) continue; // scope 过滤
          journalList.push(entry);
        }
      }
    }
    journalList.sort(byAtDesc);

    // ② spark 写操作账（单文件 scope 库；库缺失/损坏跳过 spark 源，不炸视图）
    const sparkDbFile = path.join(dataRoot, "sparks", "scopes", scope, "sparks.json");
    try {
      const raw = await fsp.readFile(sparkDbFile, "utf8");
      const db = JSON.parse(raw);
      const dbScope = db !== null && typeof db === "object" && typeof db.scopeId === "string" ? db.scopeId : scope;
      const ops = db !== null && typeof db === "object" && db.ops !== null && typeof db.ops === "object" ? db.ops : {};
      for (const [operationId, op] of Object.entries(ops)) {
        const entry = sparkEntry(operationId, op, dbScope);
        if (entry === null) continue;
        if (entry.item.scope !== scope) continue;
        sparkList.push(entry);
      }
      sparkList.sort(byAtDesc);
    } catch (err) {
      if (err.code !== "ENOENT") skippedCorrupted += 1;
    }

    // 去重与截断的次序：先去重、后截断。旧实现把两源并入后立刻按
    // offset+limit+1 截断再去重，重复项占掉窗口名额 → 整页缩水、hasMore
    // 提前变 false（面板「加载更多」静默少数据）。现在按源分别排序，
    // 用「journal 的 operationId 全集」过滤 spark（跨整窗口，不只看当前页），
    // 再两路归并、最后才按 offset/limit 切片。
    const journalOps = new Set();
    for (const entry of journalList) {
      const operationId = entry.item.detail.operationId;
      if (typeof operationId === "string" && operationId.length > 0) journalOps.add(operationId);
    }
    const sparkOps = new Set();
    for (const entry of sparkList) {
      const operationId = entry.item.detail.operationId;
      if (typeof operationId === "string" && operationId.length > 0) sparkOps.add(operationId);
    }
    // journal 侧保留全部条目（一个 operationId 的多条 change 都要上时间线），
    // 只标注「同操作在 spark 账里也有一份」。
    for (const entry of journalList) {
      const operationId = entry.item.detail.operationId;
      if (typeof operationId !== "string" || operationId.length === 0) continue;
      if (sparkOps.has(operationId) && !Array.isArray(entry.item.detail.dedupedWith)) {
        entry.item.detail.dedupedWith = ["spark"];
      }
    }
    const sparkKept = [];
    for (const entry of sparkList) {
      const operationId = entry.item.detail.operationId;
      if (typeof operationId === "string" && operationId.length > 0 && journalOps.has(operationId)) continue;
      sparkKept.push(entry);
    }
    const merged = mergeByAtDesc(journalList, sparkKept);
    const hasMore = merged.length > offset + limit;
    const items = merged.slice(offset, offset + limit).map((entry) => entry.item);
    // 扫描窗口被截断（journal 文件多于 scanLimit）：更早的历史本次不可见，
    // 需要让调用方能区分「真的到底了」与「只是没扫到」。
    const scanLimited = journalFileCount > scanLimit;
    return { scope, items, hasMore, skippedCorrupted, scanLimited };
  }

  return { read };
}
