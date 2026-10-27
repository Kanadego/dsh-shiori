/**
 * P1-COMPLETION · openCompletionState 生命周期与持久化语义测试。
 * 全部使用 fs.mkdtemp 合成夹具并在 finally/after 清理；不读写真实记忆。
 */
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { LOCK_FILE_PREFIX, STATE_FILE_PREFIX, openCompletionState } from "../../src/completion/index.mjs";
import { createCompressProbe } from "../../src/host/compress-probe.mjs";

const snapshotA = { epoch: 1, compressSeenIds: ["e1"], watermarks: { s1: 5 }, expiredSessionIds: [], lastAdvance: null, updatedAt: "2026-10-24T00:00:00.000Z" };
const snapshotB = { epoch: 2, compressSeenIds: ["e1", "e2"], watermarks: { s1: 9 }, expiredSessionIds: [], lastAdvance: null, updatedAt: "2026-10-24T00:00:01.000Z" };

test("openCompletionState：入参校验（绝对 root、拒绝 home、scopeId 非空）", async () => {
  await assert.rejects(() => openCompletionState({ root: "relative/path", scopeId: "s" }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => openCompletionState({ root: "", scopeId: "s" }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => openCompletionState({ root: join(tmpdir(), "shiori-x") , scopeId: "" }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => openCompletionState({ scopeId: "s" }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => openCompletionState({ root: homedir(), scopeId: "s" }), (e) => e.code === "INVALID_INPUT");
});

test("openCompletionState：root/scope 互斥——同进程第二活 owner LOCK_BUSY；close 后可重开", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-lock-"));
  after(() => rm(dir, { recursive: true, force: true }));

  const first = await openCompletionState({ root: dir, scopeId: "amber" });
  await assert.rejects(
    () => openCompletionState({ root: dir, scopeId: "amber" }),
    (e) => e.code === "LOCK_BUSY",
  );
  // 不同 scope 互不影响
  const other = await openCompletionState({ root: dir, scopeId: "nova" });
  await other.close();
  // 优雅 close 释放锁 → 可重开
  await first.close();
  const reopened = await openCompletionState({ root: dir, scopeId: "amber" });
  await reopened.close();
});

test("openCompletionState：load/save 往返、快照兼容 probe 字段；close 语义", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-io-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });

  // 不存在 → null（唯一的新状态路径）
  assert.equal(await handle.sink.load(), null);

  await handle.sink.save(snapshotA);
  assert.deepEqual(await handle.sink.load(), snapshotA);

  // close：幂等；等待在途保存；之后 save/load 显式拒绝
  const inFlight = handle.sink.save(snapshotB);
  const closed = await handle.close();
  assert.equal(closed.closed, true);
  await inFlight; // close 排空了这次保存
  assert.deepEqual(await readFile(join(dir, `${STATE_FILE_PREFIX}amber.json`), "utf8").then(JSON.parse), snapshotB);
  const again = await handle.close();
  assert.equal(again.alreadyClosed, true);
  await assert.rejects(() => handle.sink.save(snapshotA), (e) => e.code === "INVALID_STATE");
  await assert.rejects(() => handle.sink.load(), (e) => e.code === "INVALID_STATE");
});

test("openCompletionState：scopeId 路径穿越不越根（编码文件名）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-trav-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "../../escape" });
  const diag = handle.diagnostics();
  assert.ok(resolve(diag.statePath).startsWith(resolve(dir)), diag.statePath);
  await handle.sink.save(snapshotA);
  assert.deepEqual(await handle.sink.load(), snapshotA);
  await handle.close();
  // 未在根外制造任何文件
  const outside = resolve(dir, "../../escape.json");
  await assert.rejects(() => readFile(outside), (e) => e.code === "ENOENT");
});

test("openCompletionState：load 空/目录/损坏 JSON/不存在 语义", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-bad-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, `${STATE_FILE_PREFIX}amber.json`);
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });

  // 不存在 → null
  assert.equal(await handle.sink.load(), null);
  // 空文件 → 抛错（不得归零）
  await writeFile(statePath, "  \n", "utf8");
  await assert.rejects(() => handle.sink.load(), (e) => e.code === "INVALID_INPUT");
  // 目录 → 抛错（不得归零）
  await rm(statePath);
  await mkdir(statePath);
  await assert.rejects(() => handle.sink.load(), (e) => e.code === "INVALID_STATE");
  await rm(statePath, { recursive: true });
  // 损坏 JSON → 抛错
  await writeFile(statePath, "{\"epoch\":1,\"comp", "utf8");
  await assert.rejects(() => handle.sink.load(), (e) => e.code === "INVALID_INPUT");
  await handle.close();

  // 损坏状态下重新 open：fail fast 抛错，且文件不被删除/重置
  await assert.rejects(() => openCompletionState({ root: dir, scopeId: "amber" }), (e) => e.code === "INVALID_INPUT");
  assert.equal((await readFile(statePath, "utf8")).startsWith("{\"epoch\":1,\"comp"), true, "损坏文件必须原样保留");
  // 锁没有泄漏：删除损坏文件后可重新打开
  await rm(statePath);
  const ok = await openCompletionState({ root: dir, scopeId: "amber" });
  await ok.close();
});

test("openCompletionState：save 失败保持上次已提交快照；diagnostics 不得宣称 durable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-fail-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, `${STATE_FILE_PREFIX}amber.json`);
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  await handle.sink.save(snapshotA);
  const committed = await readFile(statePath, "utf8");

  // 故障注入：目标文件只读 → rename 替换失败（Windows FILE_ATTRIBUTE_READONLY）
  await chmod(statePath, 0o444);
  await assert.rejects(() => handle.sink.save(snapshotB));
  await chmod(statePath, 0o644);
  // 上次已提交快照原样保留
  assert.equal(await readFile(statePath, "utf8"), committed);
  // 诊断诚实性：durable 降级，不得声称跨重启 exactly-once
  const diag = handle.diagnostics();
  assert.equal(diag.durable, "degraded");
  assert.equal(diag.durableExactlyOnceAcrossRestart, false);
  assert.match(diag.lastSaveError, /EPERM|EACCES|EBUSY|EPERM|permission/i);
  // 恢复后可再次保存（重试机制不吞故障：失败期间诊断已如实暴露）
  await handle.sink.save(snapshotB);
  assert.deepEqual(await handle.sink.load(), snapshotB);
  assert.equal(handle.diagnostics().durable, "file-atomic-rename (last save committed)");
  await handle.close();
  // 失败的临时文件已清理
  const leftovers = (await readdir(dir)).filter((n) => n.includes(".tmp-"));
  assert.equal(leftovers.length, 0, leftovers.join(","));
});

test("openCompletionState：symlink 防护（root symlink / 状态文件 symlink）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-link-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const realDir = join(dir, "real");
  await mkdir(realDir);

  // root 是 symlink → 拒绝。Windows 无特权/开发者模式时 symlink 创建失败 → skip 该断言。
  const linkPath = join(dir, "link");
  try {
    await symlink(realDir, linkPath, "dir");
  } catch {
    t.skip("symlink creation not permitted on this environment");
    return;
  }
  await assert.rejects(() => openCompletionState({ root: linkPath, scopeId: "amber" }), (e) => e.code === "INVALID_INPUT");

  // 状态文件是 symlink → load 拒绝跟随（不读取链接目标内容）
  const target = join(dir, "elsewhere.json");
  await writeFile(target, JSON.stringify(snapshotA), "utf8");
  const handle = await openCompletionState({ root: realDir, scopeId: "amber" });
  await symlink(target, join(realDir, `${STATE_FILE_PREFIX}amber.json`), "file");
  await assert.rejects(() => handle.sink.load(), (e) => e.code === "INVALID_STATE");
  await handle.close();
});

test("openCompletionState：diagnostics 暴露 root/scope/持久化边界与 Windows 限制", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-diag-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  const diag = handle.diagnostics();
  assert.equal(diag.scopeId, "amber");
  assert.equal(diag.root, resolve(dir));
  assert.equal(diag.initialLoad.present, false);
  assert.equal(diag.persistence.fileSync, true);
  assert.equal(diag.persistence.directorySync, false);
  assert.match(diag.persistence.windowsLimitation, /no directory fsync/i);
  assert.equal(diag.lock.held, true);
  assert.match(diag.inProcessDedup, /memory/);
  await handle.sink.save(snapshotA);
  const diag2 = handle.diagnostics();
  assert.equal(diag2.initialLoad.present, false, "initialLoad 只反映打开时刻");
  assert.equal(diag2.saves, 1);
  await handle.close();
});

test("openCompletionState：锁文件内容含 owner 身份；close 只释放自己的锁", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-owner-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const lockPath = join(dir, `${LOCK_FILE_PREFIX}amber.json`);
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.scopeId, "amber");
  assert.equal(typeof lock.ownerToken, "string");
  await handle.close();
  await assert.rejects(() => readFile(lockPath), (e) => e.code === "ENOENT", "自己的锁必须被释放");
});

// ── C1（r-24f616d0 / review-E-a2）：close 不得丢失已报告的推进 ─────────────────
// 门控 sink：arm() 之后的首个 save 挂起在 gate 上（确定性在途保存，不用轮询/定时器），
// entered 在 save 真正进入（挂起）时解析。底层仍是 handle 的真实文件 sink。
function createGatedSink(underlying) {
  let armed = false;
  let released = false;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  return {
    sink: {
      load: () => underlying.load(),
      async save(snapshot) {
        if (armed && !released) {
          // 先进入底层队列（enqueued），再挂起 —— 保证 close 看到的是真正的在途保存
          const pending = underlying.save(snapshot);
          markEntered();
          await gate;
          return pending;
        }
        return underlying.save(snapshot);
      },
    },
    entered,
    arm() { armed = true; },
    release() {
      if (!released) {
        released = true;
        releaseGate();
      }
    },
  };
}

const replayEvent = {
  eventId: "s1:tool/ptc-dispatch:10", sessionId: "s1", name: "compress",
  success: true, blocksCreated: 2, seq: 10,
};

test("C1 证据（attempt 3）：真实初始状态 + 确定性在途保存，close 排空后重放不二次推进", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-c1-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  const gate = createGatedSink(handle.sink);
  const probe = createCompressProbe({ sink: gate.sink });

  // 评审要求的前提：先有一次真实已落盘的初始状态（awaited first save），restore 有据可依
  await handle.sink.save({ epoch: 0, compressSeenIds: [], watermarks: {}, expiredSessionIds: [], lastAdvance: null, updatedAt: "2026-10-25T00:00:00.000Z" });
  await probe.restore();

  // 制造真实在途保存：observe 在后台推进 → save 进入门控并挂起（entered 解析即在途）
  gate.arm();
  const observation = probe.observe(replayEvent);
  await gate.entered;
  let settledEarly = false;
  const closePromise = handle.close(); // 在途保存挂起期间 close，必须等它落定
  closePromise.then(() => { settledEarly = true; });
  await Promise.resolve();
  assert.equal(settledEarly, false, "close 必须等待在途保存，不得先于排空返回");
  gate.release();
  const closed = await closePromise;
  const obs = await observation;
  assert.equal(obs.advanced, true, "内存推进照常报告");
  assert.ok(closed.drainedSaves >= 1, `close 必须排空在途保存：${JSON.stringify(closed)}`);
  assert.equal(closed.lostSaves, 0);

  // 重新打开：推进必须已持久化（旧实现此处 epoch 丢失 → 重放二次推进）
  const handle2 = await openCompletionState({ root: dir, scopeId: "amber" });
  const persisted = await handle2.sink.load();
  assert.ok(persisted, "状态文件必须存在");
  assert.equal(persisted.epoch, 1, "已报告的推进不得丢失");
  const probe2 = createCompressProbe({ sink: handle2.sink });
  await probe2.restore();
  const replay = await probe2.observe(replayEvent);
  assert.equal(replay.advanced, false, "重放同事件不得二次推进");
  assert.equal(replay.reason, "duplicate");
  await handle2.close();
});

test("C1 回归守卫：fire-and-forget 派发后立即 close（真实桥形状）——保存不丢失、重放不二次推进", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-c1b-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  const gate = createGatedSink(handle.sink);
  const probe = createCompressProbe({ sink: gate.sink });
  await probe.restore();

  // 真实桥形状：fire-and-forget 派发后立即 close（保存入队发生在 close 的
  // 「首次 flush 返回 → closed 置位」微任务间隙里，且 close 启动时仍挂起在门上）。
  // 确定性判别点：close 返回时不得有任何已接受保存被拒（lostSaves=0）或丢失
  // （epoch 持久化）——a1 式实现（先置 closed 再排空）在此处 lostSaves=1 直接失败。
  gate.arm();
  const observation = probe.observe(replayEvent);
  const closePromise = handle.close(); // 未 await：保存将在间隙入队并挂起
  await gate.entered;
  gate.release();
  const closed = await closePromise;
  const obs = await observation;
  assert.equal(obs.advanced, true);
  assert.ok(closed.drainedSaves >= 1, `close 必须排空全部已接受保存：${JSON.stringify(closed)}`);
  assert.equal(closed.lostSaves, 0);

  const handle2 = await openCompletionState({ root: dir, scopeId: "amber" });
  const persisted = await handle2.sink.load();
  assert.equal(persisted?.epoch, 1, "间隙里入队的保存也必须持久化");
  await handle2.close();
});

test("C1 审计：close 完成后到达的 save 显式拒绝并计入 lostSaves/advancedButNotDurable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-c1b-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  await handle.close(); // 完全关闭（无在途保存）
  assert.ok(handle.diagnostics().lock.held === false);
  await assert.rejects(() => handle.sink.save({ epoch: 1, compressSeenIds: [] }), (e) => e.code === "INVALID_STATE");
  const diag = handle.diagnostics();
  assert.equal(diag.lostSaves, 1, "close 后被拒的 save 必须进 lostSaves 审计");
  assert.equal(diag.advancedButNotDurable, 1);
  assert.equal(diag.durable, "degraded");
  assert.equal(diag.durableExactlyOnceAcrossRestart, false);
});
