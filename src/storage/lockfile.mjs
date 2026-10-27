// Independent B lock repair candidate: every public lock mutation holds one guard.
// Protocol participants MUST all use this version; upgrade only after quiescing old writers.
// mkdir(guard) is atomic, never reclaimed automatically, and covers short I/O only.
// A crash while guard exists is deliberately fail-closed; see REPORT.md.
import { randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lockBusy } from './errors.mjs';
import { sleep, writeFileSynced } from './fsutil.mjs';

const als = new AsyncLocalStorage();
const procState = new Map();
const LOCK_NAME = '.shiori-lock';
const GUARD_NAME = '.shiori-lock.guard';
const transientRemoval = new Set(['EPERM', 'EACCES', 'EBUSY']);

function busy(root, phase, reason, cause) {
  const err = lockBusy(reason, {
    lockPath: path.join(root, LOCK_NAME), guardPath: path.join(root, GUARD_NAME), phase,
    hint: 'Stop all storage users before manual recovery. Never remove a possibly live guard.',
    ...(cause ? { ioCode: cause.code ?? null } : {}),
  });
  if (cause) err.cause = cause;
  return err;
}

// Preserve the original failure and expose cleanup failures instead of silently losing either.
function withCleanupError(primary, cleanup) {
  const err = new AggregateError([primary, cleanup], 'Storage operation and lock cleanup both failed', { cause: primary });
  err.code = primary?.code ?? cleanup?.code ?? 'LOCK_BUSY';
  err.details = { operationError: primary, cleanupError: cleanup };
  return err;
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) {
    // Only ESRCH proves absence. Unknown/permission failures are never reclaim authority.
    if (err.code === 'ESRCH') return false;
    return true;
  }
}

// Must run under guard. Only ENOENT means absent; malformed/empty/non-file stays occupied.
async function readHeld(root) {
  const lockPath = path.join(root, LOCK_NAME);
  let stat;
  try { stat = await fsp.lstat(lockPath); }
  catch (err) {
    if (err.code === 'ENOENT') return { state: 'absent' };
    throw busy(root, 'read', 'Cannot inspect lock; refusing acquisition', err);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return { state: 'unknown' };
  let raw;
  try { raw = await fsp.readFile(lockPath, 'utf8'); }
  catch (err) { throw busy(root, 'read', 'Cannot read lock; refusing acquisition', err); }
  let payload;
  try { payload = JSON.parse(raw); } catch { return { state: 'unknown' }; }
  if (!payload || !Number.isInteger(payload.pid) || payload.pid <= 0 || payload.pid > 2147483647
      || typeof payload.token !== 'string' || payload.token.length === 0) return { state: 'unknown' };
  return { state: 'ok', payload };
}

async function ensureNoLegacyMove(root) {
  let names;
  try { names = await fsp.readdir(root); }
  catch (err) { throw busy(root, 'inspect', 'Cannot inspect legacy takeover artifacts', err); }
  if (names.some(n => n.startsWith('.shiori-lock.moving-') || n.startsWith('.shiori-lock.takenover-'))) {
    throw busy(root, 'inspect', 'Legacy takeover artifacts require offline manual recovery');
  }
}

// A guard has no internal file: rmdir cannot accidentally recursively delete unknown content.
// Retry only transient failures, with a bounded independent cleanup budget.
async function removeGuard(root) {
  const guardPath = path.join(root, GUARD_NAME);
  for (let attempt = 0; ; attempt++) {
    try { await fsp.rmdir(guardPath); return; }
    catch (err) {
      if (attempt < 4 && transientRemoval.has(err.code)) { await sleep(5 * (attempt + 1)); continue; }
      throw busy(root, 'guard-release', 'Guard release failed; manual recovery may be required', err);
    }
  }
}

async function underGuard(root, deadline, retryMs, action) {
  const guardPath = path.join(root, GUARD_NAME);
  for (;;) {
    try { await fsp.mkdir(guardPath); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw busy(root, 'guard-acquire', 'Cannot acquire guard', err);
      if (Date.now() >= deadline) throw busy(root, 'guard-acquire', 'Guard occupied; no automatic guard takeover');
      await sleep(retryMs);
    }
  }
  let result, primary, failed = false;
  try { result = await action(); } catch (err) { failed = true; primary = err; }
  try { await removeGuard(root); }
  catch (cleanup) { throw failed ? withCleanupError(primary, cleanup) : cleanup; }
  if (failed) throw primary;
  return result;
}

async function publish(root, payload) {
  const lockPath = path.join(root, LOCK_NAME);
  const tmp = `${lockPath}.new-${payload.token}`;
  let primary, failed = false;
  try {
    await writeFileSynced(tmp, Buffer.from(JSON.stringify(payload), 'utf8'));
    // No overwrite, including if a non-protocol actor unexpectedly created a new file.
    await fsp.link(tmp, lockPath);
  } catch (err) { failed = true; primary = busy(root, 'publish', 'Cannot publish lock', err); }
  try { await fsp.unlink(tmp); }
  catch (err) {
    if (err.code !== 'ENOENT') {
      const cleanup = busy(root, 'publish-cleanup', 'Cannot remove lock publication temporary file', err);
      throw failed ? withCleanupError(primary, cleanup) : cleanup;
    }
  }
  if (failed) throw primary;
}

async function acquire(root, payload, deadline, retryMs) {
  for (;;) {
    const acquired = await underGuard(root, deadline, retryMs, async () => {
      await ensureNoLegacyMove(root);
      const held = await readHeld(root);
      if (held.state === 'unknown' || (held.state === 'ok' && isPidAlive(held.payload.pid))) return false;
      if (held.state === 'ok') {
        // No snapshot can escape this guard. A cooperating new owner cannot appear here.
        try { await fsp.unlink(path.join(root, LOCK_NAME)); }
        catch (err) { throw busy(root, 'reclaim', 'Cannot remove confirmed dead owner lock', err); }
      }
      await publish(root, payload);
      return true;
    });
    // underGuard already removed the guard before authorizing execution of fn.
    if (acquired) return;
    if (Date.now() >= deadline) throw busy(root, 'acquire', 'Lock busy: live owner or unknown lock content');
    await sleep(retryMs);
  }
}

async function release(root, token, timeoutMs, retryMs) {
  await underGuard(root, Date.now() + timeoutMs, retryMs, async () => {
    await ensureNoLegacyMove(root);
    const held = await readHeld(root);
    if (held.state !== 'ok' || held.payload.pid !== process.pid || held.payload.token !== token) {
      throw busy(root, 'release', 'Owner lock missing or changed; refusing to remove unknown lock');
    }
    try { await fsp.unlink(path.join(root, LOCK_NAME)); }
    catch (err) { throw busy(root, 'release', 'Cannot release owner lock', err); }
  });
}

export async function withLock(rootReal, opts, fn) {
  const ctx = als.getStore();
  if (ctx?.active && ctx.root === rootReal) return fn();
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const retryMs = opts?.retryMs ?? 50;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(retryMs) || retryMs <= 0) {
    throw new TypeError('Invalid lock timeout/retry options');
  }
  let st = procState.get(rootReal);
  if (!st) { st = { queueTail: Promise.resolve() }; procState.set(rootReal, st); }
  const turn = st.queueTail;
  let releaseQueue;
  st.queueTail = new Promise(resolve => { releaseQueue = resolve; });
  await turn;
  const token = randomBytes(16).toString('hex');
  let acquired = false, failed = false, primary, result;
  const owner = { root: rootReal, token, active: true };
  try {
    await acquire(rootReal, { pid: process.pid, token, acquiredAt: new Date().toISOString() }, Date.now() + timeoutMs, retryMs);
    acquired = true;
    try { result = await als.run(owner, fn); } catch (err) { failed = true; primary = err; }
  } catch (err) { failed = true; primary = err; }
  finally {
    // Async descendants from a completed fn must not inherit stale reentrancy authority.
    owner.active = false;
    try {
      if (acquired) await release(rootReal, token, timeoutMs, retryMs);
    } catch (cleanup) { primary = failed ? withCleanupError(primary, cleanup) : cleanup; failed = true; }
    finally { releaseQueue(); }
  }
  if (failed) throw primary;
  return result;
}

export function holdsLock(rootReal) {
  const ctx = als.getStore();
  return !!(ctx?.active && ctx.root === rootReal);
}
