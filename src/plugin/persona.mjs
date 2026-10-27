// Shiori P5-PLUGIN · L0 persona 独立持久 adapter（slot P）。
//
// 契约（CONTRACTS §3）：持久化到本插件 dataRoot/persona；read/commit 与 service
// 契约一致：文件锁、CAS、原子写、持久 operationId 同语义重放先于 liveCAS、冲突拒绝、
// 重启恢复。不可写旧 soul-md 路径。上限 12000 UTF16；外改坏格式/超限不覆盖原文件，
// 保留最近有效投影并诊断；无有效快照则阻止该 scope 启用。
//
// 磁盘布局（<dir> = dataRoot/persona，scopeId 均为文件名安全段）：
//   <dir>/<scopeId>.md                     人设卡正文（唯一真相）
//   <dir>/.ops/<scopeId>/<operationId>.json 持久操作账（payloadHash + result）
//   <dir>/.state/<scopeId>.lastvalid.json  最近有效投影 {text, hash, savedAt}
//
// 硬边界：
// - expectedRevision 为文件内容 SHA256（hex64）；null 仅当文件尚不存在；
// - 同 operationId 同 payload（payloadHash 含 scope + text + expectedRevision）
//   重放首次结果（先于 live CAS）；同 id 异 payload 拒绝；
// - 写入前校验：无损 UTF-8、非空、<= maxChars（UTF-16 计数）；失败不动原文件；
// - read() 遇坏外改：返回 lastvalid 投影（stale 标记）并计数诊断；无 lastvalid
//   → INVALID_STATE（调用方据此阻止该 scope 启用）；
// - commit 成功才更新 lastvalid；写原文件与写 lastvalid 两次原子替换。

import path from "node:path";
import { promises as fsp } from "node:fs";
import { withLock } from "../storage/lockfile.mjs";
import {
  atomicReplace, hashFileOrNull, readFileOrNull, sha256Buffer, stableStringify,
} from "../storage/fsutil.mjs";
import { validateScopeId } from "../core/topics.mjs";

const HEX64 = /^[0-9a-f]{64}$/;

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function computePayloadHash(entry) {
  // scope 参与 payload 身份：同 root 不同 scope 的相同请求互不命中。
  return sha256Buffer(Buffer.from(stableStringify({
    kind: "persona",
    scopeId: entry.scopeId,
    text: entry.text,
    expectedRevision: entry.expectedRevision,
  }), "utf8"));
}

/**
 * 创建 L0 persona adapter。
 *
 * @param {object} params
 * @param {string} params.dir      persona 数据目录（绝对路径；controller 保证与 stateRoot disjoint）
 * @param {string} params.scopeId  绑定 scope（可信 factory 来源）
 * @param {number} params.maxChars persona 上限（UTF-16 code units）
 * @param {object} [deps]
 * @param {() => string} [deps.nowIso] 时钟注入
 * @returns {{read(), commit(request), diagnostics()}}
 */
export function createPersonaAdapter({ dir, scopeId, maxChars, lockTimeoutMs = 10_000, retryMs = 50 } = {}, deps = {}) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    fail("INVALID_INPUT", "persona adapter requires an absolute data dir", {});
  }
  validateScopeId(scopeId);
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    fail("INVALID_INPUT", "persona adapter requires a positive integer maxChars", {});
  }
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  const cardFile = path.join(dir, `${scopeId}.md`);
  const opsDir = path.join(dir, ".ops", scopeId);
  const opFileFor = (operationId) => path.join(opsDir, `${operationId}.json`);
  const lastvalidFile = path.join(dir, ".state", `${scopeId}.lastvalid.json`);

  const stats = {
    reads: 0,
    commits: 0,
    replays: 0,
    conflicts: 0,
    externalInvalid: 0,
    lastvalidFallbacks: 0,
    lastError: null,
  };

  async function ensureDirs() {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.mkdir(opsDir, { recursive: true });
    await fsp.mkdir(path.dirname(lastvalidFile), { recursive: true });
  }

  /** 锁前确保目录存在（首次 probe/commit 时 persona 目录可能尚未创建）。 */
  async function withDirLock(fn) {
    await fsp.mkdir(dir, { recursive: true });
    return withLock(dir, { timeoutMs: lockTimeoutMs, retryMs }, fn);
  }

  /** 读取当前磁盘正文与内容哈希。 */
  async function readCurrent() {
    const bytes = await readFileOrNull(cardFile);
    if (bytes === null) return { present: false, text: null, hash: null };
    const text = bytes.toString("utf8");
    return { present: true, text, hash: sha256Buffer(Buffer.from(text, "utf8")) };
  }

  /** 校验正文：无损 UTF-8、非空、<= maxChars。返回错误消息或 null。 */
  function validateText(text) {
    if (typeof text !== "string") return "persona text must be a string";
    if (!text.isWellFormed()) return "persona text contains unpaired surrogates";
    if (text.length === 0) return "persona text must not be empty";
    if (text.length > maxChars) {
      return `persona text exceeds persona.maxChars (${text.length} > ${maxChars} UTF-16 chars)`;
    }
    return null;
  }

  /** 读 lastvalid 快照；无 → null。 */
  async function readLastValid() {
    const bytes = await readFileOrNull(lastvalidFile);
    if (bytes === null) return null;
    try {
      const snap = JSON.parse(bytes.toString("utf8"));
      if (typeof snap?.text !== "string" || typeof snap?.hash !== "string" || !HEX64.test(snap.hash)) return null;
      if (sha256Buffer(Buffer.from(snap.text, "utf8")) !== snap.hash) return null; // 快照自校验
      return snap;
    } catch {
      return null;
    }
  }

  async function read() {
    stats.reads += 1;
    return withDirLock(async () => {
      const current = await readCurrent();
      if (!current.present) {
        const lastvalid = await readLastValid();
        if (lastvalid !== null) {
          stats.lastvalidFallbacks += 1;
          return { name: scopeId, text: lastvalid.text, revision: lastvalid.hash, stale: true };
        }
        // 从未有过卡：诚实返回不存在（首次启用由 controller 探测决定是否放行）。
        return { name: scopeId, text: null, revision: null };
      }
      const invalid = validateText(current.text);
      if (invalid !== null) {
        // 坏外改：不覆盖原文件，保留最近有效投影并诊断。
        stats.externalInvalid += 1;
        stats.lastError = { at: nowIso(), reason: invalid };
        const lastvalid = await readLastValid();
        if (lastvalid !== null) {
          stats.lastvalidFallbacks += 1;
          return { name: scopeId, text: lastvalid.text, revision: lastvalid.hash, stale: true, externalInvalid: invalid };
        }
        fail("INVALID_STATE", `persona file for scope "${scopeId}" is externally invalid and no last-valid snapshot exists: ${invalid}`, {
          scopeId, reason: invalid,
        });
      }
      return { name: scopeId, text: current.text, revision: current.hash };
    });
  }

  /** revision（sha256 hex）派生的稳定 generation（重放恒定；不硬编码 0）。 */
  function generationFromRevision(hash) {
    return Number.parseInt(hash.slice(0, 13), 16);
  }

  /**
   * prepared 账目的幂等恢复（崩溃窗口）：
   * - 磁盘卡 hash === prior.newHash → 卡已写入（写卡后、收尾前崩溃）：补写
   *   lastvalid 与 committed 终态，返回首次结果 —— 同 operationId 幂等完成；
   * - 磁盘卡 hash === prior.expectedRevision → 卡尚未写入（写卡前崩溃）：
   *   返回 null，调用方按原计划安全重做（CAS 前提未破坏）；
   * - 其他 → 外部改写，返回 null 并由调用方报冲突。
   */
  async function recoverPrepared(prior, { text }) {
    const newHash = typeof prior.newHash === "string" && HEX64.test(prior.newHash) ? prior.newHash : null;
    if (newHash === null) return null;
    const current = await readCurrent();
    if (current.hash !== newHash) return null;
    // 卡已在盘且内容与本次请求一致：补收尾（lastvalid + committed），不重写卡。
    await ensureDirs();
    const lastvalid = { text, hash: newHash, savedAt: nowIso(), operationId: prior.operationId };
    await fsp.mkdir(path.dirname(lastvalidFile), { recursive: true });
    await atomicReplace(lastvalidFile, Buffer.from(JSON.stringify(lastvalid, null, 2), "utf8"));
    const journal = {
      operationId: prior.operationId,
      payloadHash: prior.payloadHash,
      phase: "committed",
      scopeId,
      expectedRevision: prior.expectedRevision,
      newHash,
      startedAt: prior.startedAt ?? nowIso(),
      result: {
        operationId: prior.operationId,
        generation: generationFromRevision(newHash),
        changes: [{
          kind: "persona",
          scope: scopeId,
          beforeRevision: prior.expectedRevision,
          afterRevision: newHash,
        }],
      },
      committedAt: nowIso(),
      recoveredFromPrepared: true,
    };
    await atomicReplace(opFileFor(prior.operationId), Buffer.from(JSON.stringify(journal, null, 2), "utf8"));
    return structuredClone(journal.result);
  }

  async function commit(request) {
    stats.commits += 1;
    // service 契约：{operationId, changes:[{kind:'persona', text, expectedRevision}]}
    if (request === null || typeof request !== "object" || Array.isArray(request)) {
      fail("INVALID_INPUT", "persona commit requires a request object", {});
    }
    const operationId = request.operationId;
    if (typeof operationId !== "string" || !/^[\x21-\x7e]{1,128}$/.test(operationId)) {
      fail("INVALID_INPUT", "persona commit requires a printable non-empty operationId", {});
    }
    if (!Array.isArray(request.changes) || request.changes.length !== 1) {
      fail("UNSUPPORTED", "persona commit accepts exactly one persona change (no cross-adapter batches)", {});
    }
    const change = request.changes[0];
    if (change?.kind !== "persona") {
      fail("INVALID_INPUT", "persona commit change.kind must be 'persona'", {});
    }
    if (!("expectedRevision" in change)) {
      fail("INVALID_INPUT", "persona commit requires explicit expectedRevision", {});
    }
    const expectedRevision = change.expectedRevision;
    if (expectedRevision !== null && (typeof expectedRevision !== "string" || !HEX64.test(expectedRevision))) {
      fail("INVALID_INPUT", "persona expectedRevision must be null or a sha256 hex string", {});
    }
    const text = change.text;
    const invalid = validateText(text);
    if (invalid !== null) {
      fail("INVALID_INPUT", invalid, { chars: typeof text === "string" ? text.length : undefined, limit: maxChars });
    }

    return withDirLock(async () => {
      await ensureDirs();
      const fingerprint = computePayloadHash({ scopeId, text, expectedRevision });
      const opFile = path.join(opsDir, `${operationId}.json`);

      // —— 持久重放先于 live CAS ——
      const priorBytes = await readFileOrNull(opFile);
      if (priorBytes !== null) {
        let prior = null;
        try { prior = JSON.parse(priorBytes.toString("utf8")); } catch { /* 损坏账目按冲突处理 */ }
        if (prior !== null) {
          if (prior.payloadHash !== fingerprint) {
            fail("INVALID_INPUT", `operationId "${operationId}" was already used with a different persona payload`, {
              operationId,
            });
          }
          if (prior.phase === "committed" && prior.result) {
            stats.replays += 1;
            return structuredClone(prior.result);
          }
          // prepared（写卡前后崩溃）：按磁盘实况幂等恢复，不盲目重写也不误报冲突。
          const recovered = await recoverPrepared(prior, { text });
          if (recovered !== null) {
            stats.replays += 1;
            return structuredClone(recovered);
          }
          // 磁盘 === expectedRevision：写卡前崩溃，CAS 前提未破坏 → 走下方正常提交流程。
          // 其他磁盘状态：外部改写，按冲突拒绝。
          const diskNow = (await readCurrent()).hash;
          if (diskNow !== expectedRevision) {
            stats.conflicts += 1;
            fail("REVISION_CONFLICT", "persona CAS failed: disk revision differs from expectedRevision", {
              expectedRevision, actualRevision: diskNow,
            });
          }
        }
      }

      const current = await readCurrent();
      if (current.hash !== expectedRevision) {
        stats.conflicts += 1;
        fail("REVISION_CONFLICT", "persona CAS failed: disk revision differs from expectedRevision", {
          expectedRevision, actualRevision: current.hash,
        });
      }

      await fsp.mkdir(path.dirname(opFile), { recursive: true });
      const newHash = sha256Buffer(Buffer.from(text, "utf8"));
      const journal = {
        operationId,
        payloadHash: fingerprint,
        phase: "prepared",
        scopeId,
        expectedRevision,
        // 崩溃恢复依据：目标内容哈希与 CAS 前提。写卡后崩溃时，重放按
        // 磁盘 hash === newHash 识别「卡已写、收尾未做」并幂等补齐（B5）。
        newHash,
        startedAt: nowIso(),
      };
      await atomicReplace(opFile, Buffer.from(JSON.stringify(journal, null, 2), "utf8"));

      // —— 原子写原文件 ——
      const buffer = Buffer.from(text, "utf8");
      await atomicReplace(cardFile, buffer);

      // —— 更新 lastvalid（写成功才更新） ——
      const lastvalid = { text, hash: newHash, savedAt: nowIso(), operationId };
      await fsp.mkdir(path.dirname(lastvalidFile), { recursive: true });
      await atomicReplace(lastvalidFile, Buffer.from(JSON.stringify(lastvalid, null, 2), "utf8"));

      journal.phase = "committed";
      journal.result = {
        operationId,
        generation: generationFromRevision(newHash),
        changes: [{
          kind: "persona",
          scope: scopeId,
          beforeRevision: current.hash,
          afterRevision: newHash,
        }],
      };
      journal.committedAt = nowIso();
      await atomicReplace(opFile, Buffer.from(JSON.stringify(journal, null, 2), "utf8"));

      return structuredClone(journal.result);
    });
  }

  /**
   * 启用探测：scope 是否可启用。当前文件有效，或存在 lastvalid 快照，或
   * 从未有过卡（视为待初始化，允许启用——首次 soul_update 建卡）。
   */
  async function probe() {
    return withDirLock(async () => {
      const current = await readCurrent();
      if (!current.present) return { ok: true, state: "absent" };
      const invalid = validateText(current.text);
      if (invalid === null) return { ok: true, state: "valid", revision: current.hash };
      const lastvalid = await readLastValid();
      if (lastvalid !== null) return { ok: true, state: "stale-with-lastvalid", reason: invalid };
      return { ok: false, state: "invalid-no-snapshot", reason: invalid };
    });
  }

  function diagnostics() {
    return { kind: "persona-adapter", scopeId, maxChars, ...structuredClone(stats) };
  }

  return { read, commit, probe, diagnostics };
}
