// Shiori F1b · 语义向量索引（stateRoot 派生数据落盘）。
//
// 边界（F1b 任务书 c 条）：
// - 索引只落 <stateRoot>/semantic/<scopeId>.json，绝不写进 dataRoot——向量是
//   派生数据，可随时全量重建，不占业务数据根。
// - 文件结构：{ version, model, dims, entries: { sparkId: { revision, vec } } }。
//   vec 是定长 number[]（JSON 数组），加载时转 Float32Array。
// - 容错（不许把面板/召回打挂）：JSON 损坏、字段缺失、维度不符、model 换了
//   一律当「空索引」处理（下次重建全量补齐），不抛构造失败。损坏事实记在
//   lastLoadError 供诊断读取。
// - 写入用「同目录临时文件 + fsync + rename」原子替换（复用 storage/fsutil）。
// - 提供增量 upsert 与剔除（remove / retainOnly）：召回路径只读，重建路径写。

import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { atomicReplace, readFileOrNull, stableStringify } from "../storage/fsutil.mjs";

export const SEMANTIC_STORE_VERSION = 1;

function fail(code, message, details) {
  const error = new Error(message);
  error.name = "ShioriError";
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

/**
 * scopeId → 文件名安全校验：scopeId 会直接作为文件名段使用。出现路径分隔符
 * 或 ".." / "." 一律拒绝（persona 名由宿主配置提供，正常不含这些字符；
 * 拒绝比静默改写安全——改写会让两个 scope 的索引互相覆盖）。
 */
function requireSafeScopeId(scopeId) {
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    fail("INVALID_INPUT", `openSemanticVectorStore: scopeId must be a non-empty string, got ${String(scopeId)}`, {});
  }
  if (scopeId === "." || scopeId === ".." || /[/\\]/.test(scopeId)) {
    fail("INVALID_INPUT", `openSemanticVectorStore: scopeId must not contain path separators, got "${scopeId}"`, {});
  }
  return scopeId;
}

/** 单条向量条目校验：revision 非负整数、vec 是长度恰为 dims 的有限数值数组。 */
function validEntry(entry, dims) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  if (!Number.isInteger(entry.revision) || entry.revision < 0) return false;
  const vec = entry.vec;
  if (!Array.isArray(vec) || vec.length !== dims) return false;
  for (const n of vec) {
    if (typeof n !== "number" || !Number.isFinite(n)) return false;
  }
  return true;
}

/**
 * 打开（或创建）一个 scope 的向量索引。打开即从磁盘加载；损坏/不匹配的
 * 既有文件按空索引处理（不抛错），下次 save 时以当前 model/dims 全量重写。
 *
 * @param {object} args
 * @param {string} args.stateRoot 运行状态根目录（绝对路径；向量只允许落这里）。
 * @param {string} args.scopeId   scope 标识（persona 名或 "global"）。
 * @param {string} args.model     期望的 embedding 模型完整 id；磁盘文件 model
 *   与之不同 ⇒ 视为旧模型索引，全部条目作废（模型换了解释空间不同，旧向量不可信）。
 * @param {number} args.dims      期望的向量维度；不符的条目加载时逐条丢弃。
 * @returns {object} 见下方返回对象注释。
 * @throws {Error} code="INVALID_INPUT"：参数缺失/非法（含不安全的 scopeId）。
 */
export async function openSemanticVectorStore({ stateRoot, scopeId, model, dims }) {
  requireSafeScopeId(scopeId);
  if (typeof stateRoot !== "string" || stateRoot.length === 0) {
    fail("INVALID_INPUT", "openSemanticVectorStore: stateRoot must be a non-empty absolute path (vectors live under stateRoot only)", {});
  }
  if (typeof model !== "string" || model.length === 0) {
    fail("INVALID_INPUT", "openSemanticVectorStore: model must be a non-empty string", {});
  }
  if (!Number.isInteger(dims) || dims <= 0) {
    fail("INVALID_INPUT", `openSemanticVectorStore: dims must be a positive integer, got ${String(dims)}`, {});
  }

  const file = join(stateRoot, "semantic", `${scopeId}.json`);

  // 内存态：entries 的 vec 一律 Float32Array；磁盘往返才是 number[]。
  let entries = new Map(); // sparkId -> { revision, vec: Float32Array }
  let dirty = false;
  /** 打开时发现的磁盘问题（损坏/版本不符/model 变更）；空字符串 = 正常。 */
  let lastLoadError = "";
  let closed = false;

  function ensureOpen() {
    if (closed) fail("INVALID_STATE", `semantic vector store (${scopeId}) is closed`, {});
  }

  async function loadFromDisk() {
    const raw = await readFileOrNull(file);
    if (raw === null) return; // 首次使用：空索引，不算错误

    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("root is not an object");
      }
      if (parsed.version !== SEMANTIC_STORE_VERSION) {
        lastLoadError = `未知索引版本 ${String(parsed.version)}，按空索引重建`;
        return;
      }
      if (parsed.model !== model || parsed.dims !== dims) {
        // 模型或维度换了：旧向量与新模型不在同一空间，全部作废（全量重建）。
        lastLoadError = `索引属于模型 ${String(parsed.model)}/${String(parsed.dims)}维，`
          + `当前为 ${model}/${dims}维，旧条目已作废`;
        return;
      }
      if (parsed.entries === null || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
        lastLoadError = "entries 字段缺失或不是对象，按空索引重建";
        return;
      }
      const loaded = new Map();
      for (const [sparkId, entry] of Object.entries(parsed.entries)) {
        if (typeof sparkId !== "string" || sparkId.length === 0) continue;
        if (!validEntry(entry, dims)) continue; // 单条损坏只丢该条
        loaded.set(sparkId, { revision: entry.revision, vec: Float32Array.from(entry.vec) });
      }
      entries = loaded;
    } catch (error) {
      // JSON 损坏 / 结构异常：当空索引，绝不把调用方打挂。
      entries = new Map();
      lastLoadError = `索引文件损坏（${error instanceof Error ? error.message : String(error)}），按空索引重建`;
    }
  }

  async function persist() {
    ensureOpen();
    // 首次落盘前确保 <stateRoot>/semantic/ 存在（atomicReplace 不建目录）。
    await mkdir(dirname(file), { recursive: true });
    const payload = {
      version: SEMANTIC_STORE_VERSION,
      model,
      dims,
      entries: Object.fromEntries(
        [...entries.entries()].map(([sparkId, e]) => [sparkId, { revision: e.revision, vec: [...e.vec] }]),
      ),
    };
    // stableStringify 键排序：同逻辑索引产出同字节（与 sparks store 同约定）。
    await atomicReplace(file, Buffer.from(`${stableStringify(payload)}\n`, "utf8"));
    dirty = false;
  }

  // 打开即加载：磁盘损坏 / model 变更都收敛为空索引（容错契约），此后读到的
  // 就是确定状态；调用方无需再做二次初始化。
  await loadFromDisk();

  return {
    /** 诊断：落盘路径（<stateRoot>/semantic/<scopeId>.json）。 */
    get file() { return file; },
    get model() { return model; },
    get dims() { return dims; },
    /** 打开时发现的磁盘问题（"" = 正常）；诊断用，不影响可用性。 */
    get lastLoadError() { return lastLoadError; },
    /** 有效向量条数。 */
    size() {
      ensureOpen();
      return entries.size;
    },
    /** 读单条：{ revision, vec } 或 null。调用方自行比对 revision 是否新鲜。 */
    get(sparkId) {
      ensureOpen();
      const entry = entries.get(sparkId);
      if (entry === undefined) return null;
      return { revision: entry.revision, vec: entry.vec };
    },
    /** 增量 upsert（只改内存；落盘由 save() 显式控制，批量写一次）。 */
    upsert(sparkId, revision, vec) {
      ensureOpen();
      if (typeof sparkId !== "string" || sparkId.length === 0) {
        fail("INVALID_INPUT", `upsert: sparkId must be a non-empty string, got ${String(sparkId)}`, {});
      }
      if (!Number.isInteger(revision) || revision < 0) {
        fail("INVALID_INPUT", `upsert(${sparkId}): revision must be a non-negative integer, got ${String(revision)}`, {});
      }
      const isVector = vec instanceof Float32Array || vec instanceof Float64Array
        || (Array.isArray(vec) && vec.every((n) => typeof n === "number"));
      if (!isVector || vec.length !== dims) {
        fail("INVALID_INPUT", `upsert(${sparkId}): vec must be a numeric vector of length ${dims}, got length ${isVector ? vec.length : typeof vec}`, {});
      }
      entries.set(sparkId, { revision, vec: Float32Array.from(vec) });
      dirty = true;
    },
    /** 剔除单条（卡片归档/删除后索引同步）。返回是否确实删了。 */
    remove(sparkId) {
      ensureOpen();
      const removed = entries.delete(sparkId);
      if (removed) dirty = true;
      return removed;
    },
    /** 剔除不在 keepIds 里的全部条目（重建收尾：索引与 active 卡对齐）。 */
    retainOnly(keepIds) {
      ensureOpen();
      const keep = keepIds instanceof Set ? keepIds : new Set(keepIds);
      for (const sparkId of [...entries.keys()]) {
        if (!keep.has(sparkId)) entries.delete(sparkId);
      }
      dirty = true;
    },
    /** 清空（force 全量重建用）；save 后磁盘也是空的。 */
    clear() {
      ensureOpen();
      entries = new Map();
      dirty = true;
    },
    /** 原子替换落盘（幂等：无变更时 no-op，不产生 IO）。 */
    async saveIfDirty() {
      if (!dirty) return false;
      await persist();
      return true;
    },
    /** 无条件落盘（重建每批收尾用，保证进度可恢复）。
     *  命名说明：闭包内的实现函数叫 persist()，与本方法同名不同物——
     *  方法经对象属性调用 persist，避免「方法与外层函数同名」的递归误读。 */
    async save() {
      await persist();
    },
    /** 只读快照（诊断/评测用）：不暴露内部 Map。 */
    snapshot() {
      ensureOpen();
      return {
        model,
        dims,
        entries: Object.fromEntries(
          [...entries.entries()].map(([sparkId, e]) => [sparkId, { revision: e.revision, vec: [...e.vec] }]),
        ),
      };
    },
    /** 关闭：内存态丢弃；未落盘的变更丢失（调用方负责先 save）。幂等。 */
    close() {
      closed = true;
      entries = new Map();
      dirty = false;
    },
  };
}
