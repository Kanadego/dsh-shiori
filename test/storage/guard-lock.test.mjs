import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { withLock, holdsLock } from '../../src/storage/lockfile.mjs';

// timeoutMs 是本文件里各「预期成功」acquire 的调度预算，不是被测性质：8 路并发
// 负载下（其他 node 进程同时跑同样的测试），单个 fs 调用可能被拉长到数百 ms，
// 胜者的 guard 占用链（mkdir→readdir→lstat→readFile→rmdir，含 release 阶段再次
// 取 guard）会远超 1s，败者按 1s deadline 轮询会误报「Guard occupied」。抬到 10s
// 只放大预算。所有预期 LOCK_BUSY 的路径都不受影响：它们要么显式传 timeoutMs:0
//（deadline 立即到期），要么是 fail-fast 错误（EACCES 读失败、legacy 残留物、
// owner 已变），在第一次尝试内即抛出，从不依赖 deadline 耗尽。断言一字未动。
const options = { timeoutMs: 10_000, retryMs: 2 };
const deadPid = 2147483647;
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
// C-fix C1：gate 是编排机制不是断言——8 路并发负载下子进程拉起 + 事件派发可能
// 远超 5s，gate 误超时会制造假失败。预算抬到 30s，断言一字未动。
async function bounded(p, ms = 30_000) {
  let timer;
  try { return await Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('gate timed out')), ms); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-guard-candidate-'));
  const actual = await fs.realpath(root);
  t.after(async () => {
    // Verify the exact owned absolute root and inspect its entries before deletion.
    assert.equal(await fs.realpath(root), actual);
    assert.ok(path.isAbsolute(root));
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('shiori-guard-candidate-'));
    await fs.readdir(root);
    await fs.rm(root, { recursive: true, force: false, maxRetries: 5 });
  });
  return { root, lock: path.join(root, '.shiori-lock'), guard: path.join(root, '.shiori-lock.guard') };
}
function patch(t, name, replace) { const old = fs[name]; fs[name] = replace(old); t.after(() => { fs[name] = old; }); }
function ioError(code) { return Object.assign(new Error('synthetic ' + code), { code }); }
function isBusy(err) { return err.code === 'LOCK_BUSY'; }
async function absent(p) { await assert.rejects(fs.lstat(p), { code: 'ENOENT' }); }
async function seedDead(lock) { assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' }); await fs.writeFile(lock, JSON.stringify({ pid: deadPid, token: 'dead' })); }
const fresh = name => import('../../src/storage/lockfile.mjs?' + name);

test('stale read stays under guard: competing reclaimers cannot move or replace it', async t => {
  const { root, lock, guard } = await fixture(t);
  await seedDead(lock);
  const who = new AsyncLocalStorage(), observed = gate(), resume = gate(), inside = gate(), finish = gate();
  const A = await fresh('stale-A'), B = await fresh('stale-B'), C = await fresh('stale-C');
  let held = false, entries = 0, active = 0, max = 0, reads = 0, pending;
  patch(t, 'readFile', old => async function(p, ...args) {
    const raw = await old.call(this, p, ...args);
    if (p === lock) { reads++; if (who.getStore() === 'B' && !held) { held = true; observed.resolve(); await resume.promise; } }
    return raw;
  });
  const critical = async () => {
    entries++; active++; max = Math.max(max, active);
    try {
      // Another contender may briefly hold the metadata guard while it observes our live owner.
      // Safety is exclusive critical-section ownership, not permanent guard absence.
      const owner = JSON.parse(await fs.readFile(lock, 'utf8'));
      assert.equal(owner.pid, process.pid);
      assert.notEqual(owner.token, 'dead');
    } finally { active--; }
  };
  try {
    pending = who.run('B', () => B.withLock(root, options, async () => { entries++; active++; max = Math.max(max, active); inside.resolve(); await finish.promise; active--; }));
    await bounded(observed.promise);
    const rawBefore = await fs.lstat(lock);
    await assert.rejects(who.run('A', () => A.withLock(root, { timeoutMs: 0, retryMs: 1 }, critical)), isBusy);
    await assert.rejects(who.run('C', () => C.withLock(root, { timeoutMs: 0, retryMs: 1 }, critical)), isBusy);
    assert.equal(reads, 1, 'no competing stale snapshot can be obtained');
    assert.equal(entries, 0);
    assert.equal((await fs.lstat(lock)).ino, rawBefore.ino);
    resume.resolve(); await bounded(inside.promise); await absent(guard);
    const own = JSON.parse(await fs.readFile(lock, 'utf8')); assert.equal(own.pid, process.pid); assert.notEqual(own.token, 'dead');
    await assert.rejects(A.withLock(root, { timeoutMs: 0, retryMs: 1 }, critical), isBusy);
    finish.resolve(); await bounded(pending);
    await Promise.all([A.withLock(root, options, critical), C.withLock(root, options, critical)]);
    assert.equal(entries, 3); assert.equal(max, 1);
    await absent(lock); await absent(guard);
  } finally { resume.resolve(); finish.resolve(); await Promise.allSettled([pending]); }
});

for (const window of ['owner-read-before-unlink', 'after-unlink-before-guard-release']) {
  test('release/acquire race is serialized: ' + window, async t => {
    const { root, lock, guard } = await fixture(t);
    const who = new AsyncLocalStorage(), paused = gate(), resume = gate();
    const A = await fresh('release-A-' + window), B = await fresh('release-B-' + window);
    let inRelease = false, onceOnly = false, pending, enteredB = false;
    const method = window === 'owner-read-before-unlink' ? 'readFile' : 'unlink';
    patch(t, method, old => async function(p, ...args) {
      const result = await old.call(this, p, ...args);
      if (p === lock && who.getStore() === 'A' && inRelease && !onceOnly) { onceOnly = true; paused.resolve(); await resume.promise; }
      return result;
    });
    try {
      pending = who.run('A', () => A.withLock(root, options, async () => { await absent(guard); inRelease = true; }));
      await bounded(paused.promise);
      await assert.rejects(B.withLock(root, { timeoutMs: 0, retryMs: 1 }, async () => { enteredB = true; }), isBusy);
      assert.equal(enteredB, false);
      assert.ok((await fs.lstat(guard)).isDirectory());
      resume.resolve(); await bounded(pending);
      await B.withLock(root, options, async () => { enteredB = true; assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, process.pid); await absent(guard); });
      assert.equal(enteredB, true); await absent(lock); await absent(guard);
    } finally { resume.resolve(); await Promise.allSettled([pending]); }
  });
}

test('K2: independent module instance cannot enter in published-before-guard-release window', async t => {
  const { root, lock, guard } = await fixture(t);
  const published = gate(), resume = gate(), inside = gate(), finish = gate();
  const A = await fresh('K2-A'), B = await fresh('K2-B');
  let onceOnly = false, pending, entered = false;
  patch(t, 'link', old => async function(from, to, ...args) { const out = await old.call(this, from, to, ...args); if (to === lock && !onceOnly) { onceOnly = true; published.resolve(); await resume.promise; } return out; });
  try {
    pending = A.withLock(root, options, async () => { inside.resolve(); await finish.promise; });
    await bounded(published.promise);
    await assert.rejects(B.withLock(root, { timeoutMs: 0, retryMs: 1 }, async () => { entered = true; }), isBusy);
    resume.resolve(); await bounded(inside.promise); await absent(guard);
    await assert.rejects(B.withLock(root, { timeoutMs: 0, retryMs: 1 }, async () => { entered = true; }), isBusy);
    assert.equal(entered, false); finish.resolve(); await bounded(pending);
    await B.withLock(root, options, async () => { entered = true; }); assert.equal(entered, true);
  } finally { resume.resolve(); finish.resolve(); await Promise.allSettled([pending]); }
});

test('ALS reentry, queue, thrown callback cleanup and detached context expiry', async t => {
  const { root, lock, guard } = await fixture(t);
  assert.equal(holdsLock(root), false);
  const delayed = gate(), done = gate(); let late, active = 0, max = 0;
  await withLock(root, options, async () => {
    assert.equal(holdsLock(root), true); await absent(guard);
    assert.equal(await withLock(root, options, async () => 42), 42);
    late = (async () => { await delayed.promise; assert.equal(holdsLock(root), false); await withLock(root, options, async () => { done.resolve(); }); })();
  });
  assert.equal(holdsLock(root), false); delayed.resolve(); await bounded(done.promise); await late;
  await Promise.all(Array.from({ length: 12 }, () => withLock(root, options, async () => { active++; max = Math.max(max, active); await new Promise(r => setImmediate(r)); active--; })));
  assert.equal(max, 1);
  const original = new Error('callback failed');
  await assert.rejects(withLock(root, options, async () => { throw original; }), e => e === original);
  await withLock(root, options, async () => {}); await absent(lock); await absent(guard);
});

test('confirmed dead PID is reclaimed; same PID/unknown PID errors are never reclaim authority', async t => {
  const { root, lock } = await fixture(t); await seedDead(lock);
  await withLock(root, options, async () => {}); await absent(lock);
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: 'independent-instance' }));
  await assert.rejects(withLock(root, { timeoutMs: 0, retryMs: 1 }, async () => assert.fail('same PID')), isBusy);
  const old = process.kill; t.after(() => { process.kill = old; });
  process.kill = () => { throw ioError('EIO'); };
  await fs.writeFile(lock, JSON.stringify({ pid: deadPid, token: 'unproven-dead' }));
  await assert.rejects(withLock(root, { timeoutMs: 0, retryMs: 1 }, async () => assert.fail('unknown PID')), isBusy);
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).token, 'unproven-dead');
});

for (const raw of ['', '{broken', '{}', '{"pid":0,"token":"x"}', '{"pid":-1,"token":"x"}', '{"pid":2147483647,"token":""}']) {
  test('unknown lock is not stolen: ' + JSON.stringify(raw), async t => {
    const { root, lock, guard } = await fixture(t); await fs.writeFile(lock, raw);
    await assert.rejects(withLock(root, { timeoutMs: 0, retryMs: 1 }, async () => assert.fail('unknown entered')), isBusy);
    assert.equal(await fs.readFile(lock, 'utf8'), raw); await absent(guard);
  });
}

for (const method of ['readdir', 'lstat', 'readFile']) {
  test('fail closed on ' + method + ' permission/read error and still release guard', async t => {
    const { root, lock, guard } = await fixture(t); await seedDead(lock);
    const original = fs[method];
    patch(t, method, old => async function(p, ...args) { if (p === (method === 'readdir' ? root : lock)) throw ioError('EACCES'); return old.call(this, p, ...args); });
    await assert.rejects(withLock(root, options, async () => assert.fail('read error entered')), e => e.code === 'LOCK_BUSY' && e.details.ioCode === 'EACCES');
    fs[method] = original;
    assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).token, 'dead'); await absent(guard);
  });
}

test('legacy moving/takenover artifacts block entry, even without a lock', async t => {
  const { root, lock, guard } = await fixture(t);
  for (const name of ['.shiori-lock.moving-old', '.shiori-lock.takenover-old']) {
    const file = path.join(root, name); await fs.writeFile(file, 'evidence');
    await assert.rejects(withLock(root, options, async () => assert.fail('legacy artifact entered')), isBusy);
    assert.equal(await fs.readFile(file, 'utf8'), 'evidence'); await absent(lock); await absent(guard); await fs.unlink(file);
  }
});

test('guard release retries transient errors and does not leave a mutex behind', async t => {
  const { root, guard } = await fixture(t); let attempts = 0;
  patch(t, 'rmdir', old => async function(p, ...args) { if (p === guard && attempts++ < 3) throw ioError('EPERM'); return old.call(this, p, ...args); });
  await withLock(root, options, async () => {});
  assert.ok(attempts >= 5); await absent(guard);
});

// C-fix C1（评审授权后必补）：guard-acquire 的 mkdir 对瞬时 OS 错误（Windows
// delete-pending 竞争窗口）有界重试。三条边界：瞬时错误重试后成功、持续性错误
// 到界 fail-closed 且 ioCode 保留、EEXIST 语义原样（绝不自动接管）。
test('transient guard mkdir EPERM is retried within deadline and withLock completes', async t => {
  const { root, lock, guard } = await fixture(t);
  let mkdirCalls = 0;
  patch(t, 'mkdir', old => async function(p, ...args) {
    if (p === guard) { mkdirCalls += 1; if (mkdirCalls === 1) throw ioError('EPERM'); }
    return old.call(this, p, ...args);
  });
  await withLock(root, options, async () => {
    assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).pid, process.pid);
  });
  // acquire 第一次 mkdir 撞 EPERM 后重试成功（第 2 次），release 再取一次 guard
  //（第 3 次）——重试确实发生过，且整条 withLock 正常完成。
  assert.ok(mkdirCalls >= 3, `transient EPERM 后重试发生，mkdir 调用数=${mkdirCalls}`);
  await absent(lock); await absent(guard);
});

test('persistent guard mkdir EPERM fails closed at the bound with real ioCode', async t => {
  const { root, lock, guard } = await fixture(t);
  let mkdirCalls = 0;
  patch(t, 'mkdir', old => async function(p, ...args) {
    if (p === guard) { mkdirCalls += 1; throw ioError('EPERM'); }
    return old.call(this, p, ...args);
  });
  // 持续性权限故障不许被吞成「等一等就好」：有界重试耗尽后抛 LOCK_BUSY，
  // details.ioCode 保留真实 code（EPERM），phase 仍是 guard-acquire。
  // C-fix P0#4：重试预算必须「恰好有界」——首次 mkdir + 4 次重试 = 5 次。
  // 少于 5 说明重试被砍（瞬时抖动会变成误报占用），多于 5 说明上限被放宽
  //（持续性故障会被拖长等待），两者都是回归。timeoutMs=1000 / retryMs=2 下
  // 四次重试退避合计 4+6+8+10=28ms，距 deadline 余量充足，计数不受负载抖动影响。
  await assert.rejects(
    withLock(root, { timeoutMs: 1000, retryMs: 2 }, async () => assert.fail('entered')),
    e => e.code === 'LOCK_BUSY' && e.details.phase === 'guard-acquire' && e.details.ioCode === 'EPERM',
  );
  assert.equal(mkdirCalls, 5, `持续 EPERM 下 mkdir 应恰好调用 5 次（首次+4 次重试），实际=${mkdirCalls}`);
  await absent(lock);
});

test('regression: EEXIST guard to deadline still reports Guard occupied, never takeover', async t => {
  const { root, lock, guard } = await fixture(t);
  await fs.mkdir(guard); // 外部持有者占住 guard：EEXIST 语义必须原样（fail-closed）
  await assert.rejects(
    withLock(root, { timeoutMs: 30, retryMs: 2 }, async () => assert.fail('entered')),
    e => e.code === 'LOCK_BUSY' && e.details.phase === 'guard-acquire'
      && e.message.includes('Guard occupied; no automatic guard takeover'),
  );
  await absent(lock);
  assert.ok((await fs.lstat(guard)).isDirectory(), '被占的 guard 不许被自动接管或清除');
});

test('permanent guard release failure is explicit and prevents fn, never auto-clears guard', async t => {
  const { root, lock, guard } = await fixture(t); const original = fs.rmdir;
  patch(t, 'rmdir', old => async function(p, ...args) { if (p === guard) throw ioError('EPERM'); return old.call(this, p, ...args); });
  await assert.rejects(withLock(root, options, async () => assert.fail('guard cleanup failed before fn')), e => e.code === 'LOCK_BUSY' && e.details.phase === 'guard-release');
  fs.rmdir = original;
  assert.ok((await fs.lstat(guard)).isDirectory()); assert.ok((await fs.lstat(lock)).isFile());
  await assert.rejects(withLock(root, { timeoutMs: 0, retryMs: 1 }, async () => assert.fail('stale guard entered')), isBusy);
});

test('cleanup failure preserves callback error and releases process queue', async t => {
  const { root, guard } = await fixture(t); const original = fs.rmdir; const callbackError = new Error('important original');
  let failRelease = false;
  patch(t, 'rmdir', old => async function(p, ...args) { if (p === guard && failRelease) throw ioError('EIO'); return old.call(this, p, ...args); });
  await assert.rejects(withLock(root, options, async () => { failRelease = true; throw callbackError; }), e => e instanceof AggregateError && e.cause === callbackError && e.errors[0] === callbackError && e.errors[1].code === 'LOCK_BUSY');
  fs.rmdir = original;
  await assert.rejects(bounded(withLock(root, { timeoutMs: 0, retryMs: 1 }, async () => {})), isBusy);
});

test('changed owner is never unlinked during release', async t => {
  const { root, lock, guard } = await fixture(t);
  await assert.rejects(withLock(root, options, async () => { await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: 'foreign' })); }), isBusy);
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).token, 'foreign'); await absent(guard);
});

async function childAt(root, mode) {
  const script = fileURLToPath(new URL('./bin/guard-kill.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, root, mode], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; });
  const exit = once(child, 'exit');
  try { const [message] = await bounded(once(child, 'message')); assert.equal(message.mode, mode); return { child, exit, stderr }; }
  catch (err) { child.kill('SIGKILL'); await exit; throw err; }
}

for (const mode of ['fn', 'guard-before-publish', 'guard-after-publish', 'guard-release']) {
  test('child kill at deterministic boundary: ' + mode, async t => {
    const { root, lock, guard } = await fixture(t);
    const { child, exit } = await childAt(root, mode);
    try {
      if (mode === 'fn') await absent(guard); else assert.ok((await fs.lstat(guard)).isDirectory());
      child.kill('SIGKILL'); await bounded(exit);
      if (mode === 'fn') { await withLock(root, options, async () => {}); await absent(lock); await absent(guard); }
      else { await assert.rejects(withLock(root, { timeoutMs: 0, retryMs: 1 }, async () => assert.fail('orphan guard entered')), isBusy); assert.ok((await fs.lstat(guard)).isDirectory()); }
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; } }
  });
}
