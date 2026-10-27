/**
 * P1-COMPLETION · 真实子进程重启 / 崩溃残留测试。
 * 不用同进程重新 new 冒充进程重启：每轮由父测试 spawn 独立 node 子进程。
 * 全部合成数据，夹具用 mkdtemp 并清理。
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openCompletionState } from "../../src/completion/index.mjs";
import { createCompressProbe } from "../../src/host/compress-probe.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const childScript = join(here, "bin", "restart-child.mjs");
const holdScript = join(here, "bin", "hold-child.mjs");

function spawnNode(script, args) {
  return spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
}

function readLine(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx >= 0) resolvePromise(buffer.slice(0, idx));
    });
    child.stderr.on("data", (chunk) => { buffer = `STDERR: ${chunk}`; });
    child.on("error", rejectPromise);
  });
}

function waitForExit(child) {
  return new Promise((resolvePromise) => {
    child.on("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

const compressEvent = (over = {}) => ({
  eventId: "s1:tool/ptc-dispatch:10",
  sessionId: "s1",
  name: "compress",
  success: true,
  blocksCreated: 2,
  seq: 10,
  ...over,
});

async function runChild({ root, scope, events, crash = false }) {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-ev-"));
  const eventsFile = join(dir, "events.json");
  await writeFile(eventsFile, JSON.stringify(events), "utf8");
  const args = ["--root", root, "--scope", scope, "--events", eventsFile];
  if (crash) args.push("--crash");
  const child = spawnNode(childScript, args);
  const line = await readLine(child);
  const exit = await waitForExit(child);
  await rm(dir, { recursive: true, force: true });
  return { line, exit };
}

test("真实子进程重启：优雅退出后重放同事件不重复推进（持久去重跨进程）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-restart-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const events = [compressEvent()];

  // 第 1 个进程：观察并推进
  const run1 = await runChild({ root: dir, scope: "amber", events });
  assert.equal(run1.exit.code, 0, run1.line);
  const result1 = JSON.parse(run1.line);
  assert.equal(result1.epoch, 1);
  assert.equal(result1.results[0].advanced, true);

  // 第 2 个进程（真实重启）：恢复后重放同事件 → duplicate
  const run2 = await runChild({ root: dir, scope: "amber", events });
  assert.equal(run2.exit.code, 0, run2.line);
  const result2 = JSON.parse(run2.line);
  assert.equal(result2.epoch, 1, "重启后 epoch 保留");
  assert.equal(result2.results[0].advanced, false);
  assert.equal(result2.results[0].reason, "duplicate");
});

test("真实子进程崩溃（SIGKILL 后无 close）：锁残留保守接管 + 崩溃前状态可用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-kill-"));
  after(() => rm(dir, { recursive: true, force: true }));

  // 子进程打开并持锁 → SIGKILL → 锁残留
  const child = spawnNode(holdScript, ["--root", dir, "--scope", "amber"]);
  const ready = await readLine(child);
  assert.match(ready, /^ready \d+$/);
  child.kill("SIGKILL");
  const exit = await waitForExit(child);
  assert.equal(exit.signal, "SIGKILL");

  // 崩溃期间：锁残留必须拒绝新 owner（在接管判定前不该有第二个 owner 静默进入）。
  // 接管路径：ESRCH 证明 owner 死亡 → 保守接管，残留文件保留为证据。
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  const diag = handle.diagnostics();
  assert.ok(diag.lock.residueRecovered, "接管必须如实记录 residueRecovered");
  assert.equal(diag.lock.residueRecovered.ownerPid, Number(ready.split(" ")[1]));
  const files = await readdir(dir);
  assert.ok(files.some((n) => n.includes(".residue-")), "残留锁文件必须保留为证据");
  await handle.close();

  // SIGKILL 前 hold-child 没写过状态：状态文件不存在 → 新状态
  const handle2 = await openCompletionState({ root: dir, scopeId: "amber" });
  assert.equal(await handle2.sink.load(), null);
  await handle2.close();
});

test("真实子进程崩溃注入：崩溃前已 save 的状态在接管后仍然可恢复去重", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-crash-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const events = [compressEvent()];

  // 子进程观察并推进后不 close 直接 exit(7)（observe 内已 await fsync+rename）
  const run1 = await runChild({ root: dir, scope: "amber", events, crash: true });
  assert.equal(run1.exit.code, 7, run1.line);
  const result1 = JSON.parse(run1.line);
  assert.equal(result1.epoch, 1);

  // 父进程接管残留锁并验证状态
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  assert.ok(handle.diagnostics().lock.residueRecovered, "崩溃残留应被接管");
  const persisted = JSON.parse(await readFile(join(dir, "completion-state-amber.json"), "utf8"));
  assert.equal(persisted.epoch, 1);

  // 用持久 sink 建 probe 验证重放去重
  const probe = createCompressProbe({ sink: handle.sink });
  await probe.restore();
  assert.equal(probe.epoch(), 1);
  const replay = await probe.observe(compressEvent());
  assert.equal(replay.advanced, false);
  assert.equal(replay.reason, "duplicate");
  await handle.close();
});

test("真实子进程持锁存活期间：第二活 owner（父进程）LOCK_BUSY，优雅退出后可进入", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-cs-live-"));
  after(() => rm(dir, { recursive: true, force: true }));

  const child = spawnNode(holdScript, ["--root", dir, "--scope", "amber"]);
  const ready = await readLine(child);
  assert.match(ready, /^ready \d+$/);
  // 子进程活着：父进程打开 → LOCK_BUSY（不触碰他人锁）
  await assert.rejects(
    () => openCompletionState({ root: dir, scopeId: "amber" }),
    (e) => e.code === "LOCK_BUSY",
  );
  // 优雅关闭子进程 → 锁释放 → 父进程可进入
  child.stdin.end();
  const exit = await waitForExit(child);
  assert.equal(exit.code, 0);
  const handle = await openCompletionState({ root: dir, scopeId: "amber" });
  assert.equal(handle.diagnostics().lock.residueRecovered, null, "优雅退出不产生残留");
  await handle.close();
});
