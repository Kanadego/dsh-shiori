/**
 * Shiori P1-COMPLETION · 完成事件持久状态（openCompletionState）。
 *
 * 接口约定（完成事件与持久接口）：
 *
 *     export async function openCompletionState({ root, scopeId });
 *     -> { sink: { load(), save(snapshot) }, flush(), close(), diagnostics() }
 *
 * 语义要点（全部有对应测试，见 test/completion/）：
 *
 * - root 必须是显式、绝对、独立的 stateRoot（不存在则创建）；不默认 home，
 *   且显式拒绝 root === os.homedir()。scopeId 来自可信 factory（绝不来自工具 payload）。
 * - 状态文件与锁文件都放在 root 内，文件名由 scopeId 编码（encodeURIComponent，
 *   超长时退化为 SHA256 十六进制），因此 scopeId 含路径分隔符也无法越根。
 * - sink.load()/save(snapshot) 与 createCompressProbe 快照兼容
 *   （epoch / compressSeenIds / watermarks / expiredSessionIds / lastAdvance / updatedAt）。
 * - load：文件不存在 → null（唯一的新状态路径）；空文件 / 目录 / symlink /
 *   权限异常 / 损坏 JSON 一律抛错，绝不重置为 epoch 0。
 * - save：临时文件 O_EXCL 创建 → 写入 → fsync → rename 原子替换；
 *   失败时清理临时文件并抛错，上一次已提交快照保持不动。
 *   Windows/NTFS 没有目录 fsync：rename 之后目录项落盘依赖文件系统日志，
 *   崩溃窗口内的最后一次保存可能回退到上一个快照 —— diagnostics.windowsLimitation
 *   明示该限制，不宣称完整 directory-sync 语义。
 * - root/scope 互斥：整个 load→observe→save 生命周期持锁。锁文件 O_EXCL 创建，
 *   含 {pid, scopeId, ownerToken, acquiredAt}：
 *   · 已有锁且 owner 进程活着（或活性未知，EPERM 等）→ LOCK_BUSY，绝不触碰他人锁；
 *   · 仅当 kill(pid,0) 返回 ESRCH（唯一可证死亡信号，与根 guard-lock 协议同款判定）
 *     才允许保守接管：残留锁被重命名为 *.residue-* 保留证据（不删除），并在
 *     diagnostics.residueRecovered 如实记录；
 *   · 原子 rename 不是多写者保证 —— 本模块只支持单写者，没有多写者模式。
 * - close：幂等；先 flush（等待进行中的保存排队完成）再释放锁。
 *   释放前核对锁内 ownerToken 与 pid，只释放自己的锁；不匹配则保留并记录。
 *   close 之后的 load/save 显式拒绝（INVALID_STATE）。
 * - 诊断诚实性：save 失败后 diagnostics.durable = "degraded"，
 *   此时不得声称跨重启 exactly-once；同进程去重（eventId/水位，内存）与
 *   持久保证（上次成功 save 的快照）分开陈述。
 */
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { INVALID_INPUT, INVALID_STATE, LOCK_BUSY } from "./errors.mjs";

/** 状态/锁文件名前缀（后接编码后的 scopeId）。 */
export const STATE_FILE_PREFIX = "completion-state-";
export const LOCK_FILE_PREFIX = "completion-lock-";
/** 编码 scopeId 超过该长度时改用 SHA256 十六进制，避免超过文件名长度限制。 */
const MAX_ENCODED_SCOPE = 160;

function samePath(a, b) {
  if (path.resolve(a) !== path.resolve(b)) return false;
  return process.platform === "win32"
    ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
    : true;
}

function encodeScopeId(scopeId) {
  const encoded = encodeURIComponent(scopeId);
  if (encoded.length <= MAX_ENCODED_SCOPE) return encoded;
  return createHash("sha256").update(scopeId, "utf8").digest("hex");
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    throw INVALID_INPUT(`${name} must be a non-empty string`, { received: typeof value });
  }
  return value;
}

/** 读取并解析状态文件；不存在 → null，任何内容/形状异常 → 抛错（绝不归零）。 */
async function loadStateFile(statePath) {
  let info;
  try {
    info = await lstat(statePath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    // 权限异常等：不得当成"新状态"
    throw INVALID_INPUT(`completion state file is not readable (${error.code ?? error.message}); refusing to treat as new state`, {
      statePath,
      fsCode: error?.code,
    });
  }
  if (info.isSymbolicLink()) {
    throw INVALID_STATE("completion state file is a symlink; refusing to follow", { statePath });
  }
  if (info.isDirectory()) {
    throw INVALID_STATE("completion state path is a directory; refusing to treat as new state", { statePath });
  }
  let raw;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    throw INVALID_INPUT(`completion state file read failed (${error.code ?? error.message}); refusing to treat as new state`, {
      statePath,
      fsCode: error?.code,
    });
  }
  if (raw.trim().length === 0) {
    throw INVALID_INPUT("completion state file is empty; refusing to treat as new state (delete it only after human review)", { statePath });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw INVALID_INPUT(`completion state file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { statePath });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw INVALID_INPUT("completion state snapshot must be a JSON object", { statePath, received: Array.isArray(parsed) ? "array" : typeof parsed });
  }
  return parsed;
}

/**
 * 原子保存：O_EXCL 临时文件 → 写入 → fsync → rename。
 * 失败时清理临时文件；目标文件要么是旧快照、要么是新快照，不会半写。
 */
async function saveStateFile(statePath, snapshot) {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw INVALID_INPUT("completion state snapshot must be an object", { received: typeof snapshot });
  }
  let serialized;
  try {
    serialized = JSON.stringify(snapshot, null, 2);
  } catch (error) {
    throw INVALID_INPUT(`completion state snapshot is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`, {});
  }
  const tmp = `${statePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(serialized, "utf8");
      await fh.sync();
    } finally {
      await fh.close().catch(() => {});
    }
  } catch (error) {
    await unlink(tmp).catch(() => {});
    error.details = { ...(error.details ?? {}), phase: "tmp-write", tmp, statePath };
    throw error;
  }
  try {
    await rename(tmp, statePath);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    error.details = { ...(error.details ?? {}), phase: "rename", tmp, statePath };
    throw error;
  }
}

/**
 * 活性判定：只有 ESRCH 才证明 owner 进程死亡；EPERM/其他异常视为"未知"，
 * 一律 LOCK_BUSY（不抢锁）。与根 guard-lock 协议（HANDOFF.md §5）同款保守语义。
 */
function ownerLiveness(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error && error.code === "ESRCH") return "dead";
    return "unknown";
  }
}

/**
 * 打开 (root, scopeId) 的完成事件持久状态。
 * @param {object} options
 * @param {string} options.root 显式绝对 stateRoot（不存在则创建；拒绝 home 与 symlink）
 * @param {string} options.scopeId 可信 factory 提供的 scope 标识
 */
export async function openCompletionState({ root, scopeId } = {}) {
  requireNonEmptyString(root, "root");
  requireNonEmptyString(scopeId, "scopeId");
  if (!path.isAbsolute(root)) {
    throw INVALID_INPUT("root must be an absolute stateRoot path (openCompletionState never defaults to home or cwd)", { root });
  }
  const resolvedRoot = path.resolve(root);
  if (samePath(resolvedRoot, os.homedir())) {
    throw INVALID_INPUT("root must be a dedicated stateRoot, not the user home directory", { root });
  }
  await mkdir(resolvedRoot, { recursive: true });
  const rootInfo = await lstat(resolvedRoot);
  if (rootInfo.isSymbolicLink()) {
    throw INVALID_INPUT("root must not be a symlink (link protection)", { root: resolvedRoot });
  }
  if (!rootInfo.isDirectory()) {
    throw INVALID_INPUT("root must be a directory", { root: resolvedRoot });
  }

  const encoded = encodeScopeId(scopeId);
  const statePath = path.join(resolvedRoot, `${STATE_FILE_PREFIX}${encoded}.json`);
  const lockPath = path.join(resolvedRoot, `${LOCK_FILE_PREFIX}${encoded}.json`);

  // —— 互斥：O_EXCL 抢锁；已有锁按活性判定 LOCK_BUSY / 保守接管（ESRCH 才接管） ——
  const ownerToken = randomUUID();
  let residueRecovered = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fh = await open(lockPath, "wx");
      try {
        await fh.writeFile(JSON.stringify({
          pid: process.pid,
          scopeId,
          ownerToken,
          acquiredAt: new Date().toISOString(),
        }, null, 2), "utf8");
        await fh.sync();
      } finally {
        await fh.close().catch(() => {});
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        error.details = { ...(error.details ?? {}), phase: "lock-create", lockPath };
        throw error;
      }
      if (attempt === 2) {
        throw LOCK_BUSY("completion state lock could not be acquired after retries", { lockPath });
      }
      // 已有锁：读取并判定。
      let existing;
      try {
        existing = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        // 形状未知/不可读的锁一律保守拒绝（可能是他人锁或半写残留，不由本进程删除）。
        throw LOCK_BUSY("completion state lock exists but is unreadable; refusing to touch it (manual recovery required, see docs/completion/TROUBLESHOOTING.md)", { lockPath });
      }
      const pid = existing?.pid;
      if (!Number.isInteger(pid)) {
        throw LOCK_BUSY("completion state lock has no usable owner pid; refusing to touch it (manual recovery required)", { lockPath, scopeId: existing?.scopeId ?? null });
      }
      const liveness = ownerLiveness(pid);
      if (liveness !== "dead") {
        throw LOCK_BUSY(
          liveness === "alive"
            ? "another live owner holds this completion state (root/scope exclusive load→observe→save lifecycle)"
            : "owner liveness of the existing completion state lock could not be proven dead; refusing takeover",
          { lockPath, ownerPid: pid, ownerAcquiredAt: existing?.acquiredAt ?? null },
        );
      }
      // ESRCH：owner 已死 → 保守接管。残留锁重命名保留证据（不删除他人锁文件内容）。
      const residuePath = `${lockPath}.residue-${Date.now()}-${randomUUID().slice(0, 8)}`;
      try {
        await rename(lockPath, residuePath);
      } catch (renameError) {
        if (renameError?.code === "ENOENT") continue; // 残留刚好被清理，重试抢锁
        throw LOCK_BUSY(`residue lock rename failed (${renameError.code ?? renameError.message}); refusing takeover`, { lockPath });
      }
      residueRecovered = { ownerPid: pid, ownerAcquiredAt: existing?.acquiredAt ?? null, residuePath };
    }
  }

  const state = {
    closing: false,
    closed: false,
    saves: 0,
    savesFailed: 0,
    /** close 完成后到达的 save 次数（已报告的推进未能持久化的审计计数）。 */
    lostSaves: 0,
    lastSaveError: null,
    lockReleaseError: null,
  };
  /**
   * 保存串行队列。queueTail 永不 reject（失败已记录）；flush 用计数循环等待，
   * 因此 flush 排空期间新入队的保存也会被等待（C1 修复：固定引用的 await queue
   * 会漏掉排空期间到达的保存）。
   */
  let queueTail = Promise.resolve();
  let enqueued = 0;
  let settled = 0;

  function save(snapshot) {
    if (state.closed) {
      // close 完成后的 save：显式拒绝并计入审计 —— 这代表一次已报告但未持久化的推进。
      state.lostSaves += 1;
      state.lastSaveError = "save rejected: completion state is closed";
      const error = INVALID_STATE("completion state is closed; save is rejected", { statePath });
      return Promise.reject(error);
    }
    // closing（排空窗口）期间仍接受保存：close 等待全部已接受保存落定后才释放锁。
    enqueued += 1;
    state.saves += 1;
    const run = queueTail.then(async () => {
      try {
        await saveStateFile(statePath, snapshot);
        state.lastSaveError = null;
      } catch (error) {
        state.savesFailed += 1;
        state.lastSaveError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        settled += 1;
      }
    });
    queueTail = run.then(() => {}, () => {});
    return run;
  }

  function load() {
    if (state.closed) {
      return Promise.reject(INVALID_STATE("completion state is closed; load is rejected", { statePath }));
    }
    return loadStateFile(statePath);
  }

  /** 等待全部已接受（含等待期间新入队）的保存落定；queueTail 永不 reject。 */
  async function flush() {
    let guard = 0;
    while (settled !== enqueued) {
      if (++guard > 1_000_000) {
        throw INVALID_STATE("completion state flush did not settle (producer still enqueueing during close?)", { enqueued, settled });
      }
      await queueTail;
    }
    return { pending: enqueued - settled };
  }

  async function releaseLock() {
    let content;
    try {
      content = JSON.parse(await readFile(lockPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return; // 锁已不在：无事可释放
      state.lockReleaseError = `lock unreadable at close (${error.code ?? error.message}); left in place`;
      return;
    }
    if (content?.ownerToken !== ownerToken || content?.pid !== process.pid) {
      // 只释放自己的锁：内容不匹配（被接管/重建）时保留并如实记录。
      state.lockReleaseError = "lock content does not match this owner; left in place";
      return;
    }
    try {
      await unlink(lockPath);
    } catch (error) {
      state.lockReleaseError = `lock unlink failed (${error.code ?? error.message})`;
    }
  }

  let closePromise = null;
  function close() {
    if (state.closed) return Promise.resolve({ closed: true, alreadyClosed: true });
    if (closePromise) return closePromise;
    closePromise = (async () => {
      // 排空窗口：closing 期间到达的保存仍被接受并等待落定（C1 修复）。
      // 生产方按 D 协议先撤销订阅再 close，因此窗口有界；异常持续生产由 flush 守护计数兜底。
      state.closing = true;
      await flush();
      state.closed = true;
      // 「flush 返回 → closed 置位」之间存在微任务间隙（例如桥 fire-and-forget 派发的
      // persist 回调恰在此刻运行并入队保存）：closed 置位后不可能再有新入队，
      // 再排空一次，确保全部已接受的保存落定后才释放锁（attempt 3 修复）。
      await flush();
      await releaseLock();
      return {
        closed: true,
        alreadyClosed: false,
        drainedSaves: enqueued,
        lostSaves: state.lostSaves,
      };
    })();
    return closePromise;
  }

  // —— 打开即做一次初始读取（fail fast）：损坏/空/目录在 open 时就暴露，
  //    而不是等到第一次 restore；失败时释放锁再抛。 ——
  let initialSnapshot = null;
  try {
    initialSnapshot = await loadStateFile(statePath);
  } catch (error) {
    state.closed = true;
    await flush();
    await releaseLock();
    throw error;
  }

  function diagnostics() {
    return {
      root: resolvedRoot,
      scopeId,
      statePath,
      lockPath,
      closed: state.closed,
      initialLoad: initialSnapshot === null
        ? { present: false, note: "no state file yet; first save will create it" }
        : { present: true, epoch: initialSnapshot.epoch },
      lock: {
        held: !state.closed,
        closing: state.closing,
        pid: process.pid,
        residueRecovered,
        releaseError: state.lockReleaseError,
      },
      persistence: {
        kind: "file-atomic-rename",
        fileSync: true,
        directorySync: false,
        windowsLimitation:
          "Windows/NTFS has no directory fsync: after fsync of the state file, the rename's directory entry "
          + "is not separately synced. A crash inside that window can roll the state back to the previous "
          + "snapshot; replayed events are then re-processed by design (see durable note).",
      },
      saves: state.saves,
      savesFailed: state.savesFailed,
      /** close 完成后才到达的 save 次数：已报告但未持久化的推进（审计计数，C1）。 */
      lostSaves: state.lostSaves,
      advancedButNotDurable: state.lostSaves,
      lastSaveError: state.lastSaveError,
      durable: (state.lastSaveError === null && state.lostSaves === 0)
        ? "file-atomic-rename (last save committed)"
        : "degraded",
      durableExactlyOnceAcrossRestart:
        (state.lastSaveError === null && state.lostSaves === 0)
          ? "conditional: guaranteed only up to the last successful save; a crash between fsync and rename visibility may roll back one save (windowsLimitation)"
          : false,
      inProcessDedup: "probe-level (eventId ring + session watermarks, memory); independent of this sink's durability",
    };
  }

  return {
    sink: { load, save },
    flush,
    close,
    diagnostics,
  };
}
