import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSeatGuard, createSeatRegistry, SEAT_DIR_NAME } from "../../src/host/seat.mjs";
import { createCompatTools } from "../../src/host/tools.mjs";
import { createFakeService } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, "seat-holder.mjs");

async function tempDataRoot(t, name) {
  const base = await fsp.mkdtemp(path.join(tmpdir(), `shiori-${name}-`));
  t.after(() => fsp.rm(base, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}));
  return base;
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

/** 拉一个真实宿主子进程（真进程 / 真定时器 / 真文件系统）。 */
function startChild(t, dataRoot) {
  const child = spawn(process.execPath, [CHILD, dataRoot], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const replies = [];
  const waiters = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter.resolve(message);
    else replies.push(message);
  });
  const exited = once(child, "exit").then(([code, signal]) => ({ code, signal }));

  function next(timeoutMs = 5000) {
    if (replies.length > 0) return Promise.resolve(replies.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`seat child did not reply within ${timeoutMs}ms (stderr: ${stderr})`));
      }, timeoutMs);
      const waiter = {
        resolve: (message) => { clearTimeout(timer); resolve(message); },
      };
      waiters.push(waiter);
    });
  }

  async function send(command) {
    child.stdin.write(`${command}\n`);
    return next();
  }

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.catch(() => {});
    lines.close();
  });

  return { child, next, send, exited, stderr: () => stderr };
}

/** 父进程内的座位宿主（与被测 registry 同进程，方便断言状态）。 */
async function localSeat(dataRoot, options = {}) {
  const seat = await createSeatGuard({ dataRoot, ...options });
  const service = createFakeService();
  const toolByName = new Map(
    createCompatTools({
      service,
      getSessionInfo: () => ({ sessionId: "seat-local", scopeId: "amber" }),
      readonlyGuard: seat.guard,
    }).map((tool) => [tool.name, tool]),
  );
  return { seat, service, toolByName };
}

async function waitFor(check, { timeoutMs = 8000, intervalMs = 200, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

test("单实例：可写、写工具生效、停止后座位文件消失", async (t) => {
  const root = await tempDataRoot(t, "seat-single");
  const { seat, toolByName } = await localSeat(root);
  t.after(() => seat.stop());

  const status = seat.status();
  assert.equal(status.writable, true);
  assert.equal(status.readonly, false);
  assert.equal(status.seat.announced, true);
  assert.equal(status.seat.degraded, false);
  assert.equal(await pathExists(seat.registry.file), true);

  await toolByName.get("soul_update").execute({ content: "# 座位写入\n" });
  const read = await toolByName.get("soul_read").execute({});
  assert.equal(read.exists, true);

  await seat.stop();
  assert.equal(await pathExists(seat.registry.file), false);
});

test("真子进程：后启动的宿主立刻只读，先启动的仍可写", async (t) => {
  const root = await tempDataRoot(t, "seat-e2e");
  const a = startChild(t, root);
  const readyA = await a.next();
  assert.equal(readyA.tag, "ready");
  assert.equal(readyA.writable, true);
  assert.equal((await a.send("status")).writable, true);

  const b = startChild(t, root);
  const readyB = await b.next();
  assert.equal(readyB.tag, "ready");
  assert.equal(readyB.writable, false);
  assert.equal(readyB.readonly, true);
  assert.equal(readyB.holder.pid, a.child.pid);

  const writeB = await b.send("write");
  assert.equal(writeB.ok, false);
  assert.equal(writeB.code, "HOST_LOCKED");
  const readB = await b.send("read");
  assert.equal(readB.ok, true);
  assert.equal(readB.writable, false);

  const writeA = await a.send("write");
  assert.equal(writeA.ok, true);
  assert.equal(writeA.writable, true);
  assert.equal((await a.send("status")).writable, true);

  assert.equal((await b.send("exit")).tag, "bye");
  assert.equal((await a.send("exit")).tag, "bye");
});

test("先启动的宿主正常退出后，后启动的宿主在 6s 级窗口内恢复可写", async (t) => {
  const root = await tempDataRoot(t, "seat-graceful");
  const a = startChild(t, root);
  assert.equal((await a.next()).tag, "ready");

  const local = await localSeat(root);
  t.after(() => local.seat.stop());
  assert.equal(local.seat.status().writable, false);

  assert.equal((await a.send("exit")).tag, "bye");
  await a.exited;

  const started = Date.now();
  await waitFor(() => local.seat.status().writable === true, {
    label: "local seat writable after holder exited",
    timeoutMs: 15000,
  });
  const elapsed = Date.now() - started;
  // 设计窗口约 6s（心跳 2s / 判死 6s / 滞回 4s）；并行跑满测试时事件循环抖动会拖长，
  // 这里只保证「确实会自愈且窗口有界」，不放宽实现参数。
  assert.ok(elapsed <= 12000, `expected the seat to free in ≤12s (design ~6s), took ${elapsed}ms`);
  await local.toolByName.get("soul_update").execute({ content: "# 接替写入\n" });
});

test("先启动的宿主被 kill -9：靠心跳老化在 6s 级窗口内恢复可写", async (t) => {
  const root = await tempDataRoot(t, "seat-kill");
  const a = startChild(t, root);
  assert.equal((await a.next()).tag, "ready");

  const local = await localSeat(root);
  t.after(() => local.seat.stop());
  assert.equal(local.seat.status().writable, false);

  a.child.kill("SIGKILL");
  await a.exited;

  const started = Date.now();
  await waitFor(() => local.seat.status().writable === true, {
    label: "local seat writable after holder was killed",
    timeoutMs: 15000,
  });
  const elapsed = Date.now() - started;
  // 同上一例：窗口有界、参数不变，只给 CI 抖动留余量。
  assert.ok(elapsed <= 12000, `expected the seat to free in ≤12s (design ~6s), took ${elapsed}ms`);
});

test("畸形座位文件被忽略并清理，不阻断启动", async (t) => {
  const root = await tempDataRoot(t, "seat-garbage");
  const dir = path.join(root, SEAT_DIR_NAME);
  await fsp.mkdir(dir, { recursive: true });
  const garbage = {
    "half.json": '{"pid": 1234, "instanceId": "x"',
    "nopid.json": JSON.stringify({ instanceId: "y", startedAt: 1 }),
    "textpid.json": JSON.stringify({ pid: "123", instanceId: "z", startedAt: 1 }),
    "negpid.json": JSON.stringify({ pid: -5, instanceId: "w", startedAt: 1 }),
  };
  for (const [name, body] of Object.entries(garbage)) {
    await fsp.writeFile(path.join(dir, name), body, "utf8");
  }

  const { seat, toolByName } = await localSeat(root);
  t.after(() => seat.stop());
  assert.equal(seat.status().writable, true);
  for (const name of Object.keys(garbage)) {
    assert.equal(await pathExists(path.join(dir, name)), false, `${name} should be pruned`);
  }
  await toolByName.get("soul_update").execute({ content: "# 畸形座位旁写入\n" });
});

test("自身座位不参与持有判定", async (t) => {
  const root = await tempDataRoot(t, "seat-self");
  const { seat } = await localSeat(root);
  t.after(() => seat.stop());

  await seat.guard.poll();
  const evaluation = await seat.registry.evaluate();
  assert.equal(evaluation.held, false);
  assert.equal(evaluation.owner, null);
  assert.equal(await pathExists(seat.registry.file), true);
});

test("同 startedAt 的两个宿主按 instanceId 决定唯一写者", async (t) => {
  const root = await tempDataRoot(t, "seat-tie");
  const startedAt = Date.now() - 1000;
  const later = await localSeat(root, { instanceId: "zzzz", startedAt });
  t.after(() => later.seat.stop());
  const earlier = await localSeat(root, { instanceId: "aaaa", startedAt });
  t.after(() => earlier.seat.stop());

  await later.seat.guard.poll();
  await earlier.seat.guard.poll();

  const writable = [earlier.seat.status().writable, later.seat.status().writable];
  assert.equal(writable.filter(Boolean).length, 1, `exactly one writer expected, got ${JSON.stringify(writable)}`);
  assert.equal(earlier.seat.status().writable, true);
  assert.equal(later.seat.status().writable, false);
});

test("未 announce 的纯读 registry 不占座、不影响他人", async (t) => {
  const root = await tempDataRoot(t, "seat-quiet");
  const registry = createSeatRegistry({ dataRoot: root });
  const evaluation = await registry.evaluate();
  assert.equal(evaluation.unannounced, true);
  assert.equal(evaluation.held, false);
  assert.equal(await pathExists(registry.dir), false);

  const { seat } = await localSeat(root);
  t.after(() => seat.stop());
  assert.equal(seat.status().writable, true);
});

test("座位目录被文件占用：降级但不崩，fail-open 保持可写", async (t) => {
  const root = await tempDataRoot(t, "seat-degraded");
  await fsp.writeFile(path.join(root, SEAT_DIR_NAME), "not a directory", "utf8");

  const { seat, toolByName } = await localSeat(root);
  t.after(() => seat.stop());
  const status = seat.status();
  assert.equal(status.writable, true);
  assert.equal(status.readonly, false);

  const registryStatus = seat.registry.status();
  assert.equal(registryStatus.degraded, true);
  assert.equal(registryStatus.announced, false);
  assert.equal(registryStatus.lastError?.code, "EEXIST");
  await toolByName.get("soul_update").execute({ content: "# 降级下仍可写\n" });
});

test("pid 存活但心跳老化的座位不回收，只标 stale：卡住的先来者仍是写者", async (t) => {
  const root = await tempDataRoot(t, "seat-stale");
  const { seat } = await localSeat(root);
  t.after(() => seat.stop());

  const foreign = path.join(seat.registry.dir, `${process.pid}-stale-foreign.json`);
  await fsp.writeFile(foreign, JSON.stringify({
    pid: process.pid,
    instanceId: "stale-foreign",
    startedAt: seat.registry.startedAt - 5000,
    heartbeatAt: Date.now() - 7000,
  }), "utf8");
  const old = new Date(Date.now() - 7000);
  await fsp.utimes(foreign, old, old);

  const evaluation = await seat.registry.evaluate();
  // 活 pid 只是卡住：它还是先来的那个。删了它，它下一拍就会重新占座 → 双写。
  assert.equal(evaluation.held, true);
  assert.equal(evaluation.owner.instanceId, "stale-foreign");
  assert.equal(evaluation.owner.stale, true);
  assert.equal(await pathExists(foreign), true, "活 pid 的老化座位不得被删");

  await seat.guard.poll();
  assert.equal(seat.status().writable, false);
});

test("pid 已退出的座位立刻回收，不占写权", async (t) => {
  const root = await tempDataRoot(t, "seat-dead");
  const { seat } = await localSeat(root);
  t.after(() => seat.stop());

  // 拿一个真死掉的 pid（刚退出的子进程），比猜一个不存在的号码可靠。
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const deadPid = child.pid;
  await once(child, "exit");

  const dead = path.join(seat.registry.dir, `${deadPid}-dead-foreign.json`);
  await fsp.writeFile(dead, JSON.stringify({
    pid: deadPid,
    instanceId: "dead-foreign",
    startedAt: seat.registry.startedAt - 5000,
    heartbeatAt: Date.now(),
  }), "utf8");

  const evaluation = await seat.registry.evaluate();
  assert.equal(evaluation.held, false);
  assert.equal(await pathExists(dead), false, "死 pid 的座位应当被回收");
  assert.equal(seat.status().writable, true);
});

test("座位文件被删：心跳不续用原座次，按新占座处理并让出写权", async (t) => {
  const root = await tempDataRoot(t, "seat-lost");
  const first = await localSeat(root, { instanceId: "lost-first", startedAt: Date.now() - 10000 });
  t.after(() => first.seat.stop());
  const second = await localSeat(root, { instanceId: "lost-second" });
  t.after(() => second.seat.stop());
  assert.equal(first.seat.status().writable, true);
  assert.equal(second.seat.status().writable, false);

  const before = second.seat.registry.startedAt;
  await fsp.unlink(second.seat.registry.file);
  await second.seat.registry.heartbeat();

  assert.ok(second.seat.registry.startedAt > before, "座位丢了必须按当前时刻重排 startedAt");
  assert.equal(await pathExists(second.seat.registry.file), true);
  const payload = JSON.parse(await fsp.readFile(second.seat.registry.file, "utf8"));
  assert.equal(payload.instanceId, "lost-second");
  assert.equal(payload.pid, process.pid);
  assert.equal(payload.startedAt, second.seat.registry.startedAt);

  await second.seat.guard.poll();
  assert.equal(second.seat.status().writable, false);
  assert.equal(first.seat.status().writable, true);
});

test("座位文件被别人顶掉：心跳识破替换，重写回自己的身份与新座次", async (t) => {
  const root = await tempDataRoot(t, "seat-swapped");
  const first = await localSeat(root, { instanceId: "swap-first", startedAt: Date.now() - 10000 });
  t.after(() => first.seat.stop());
  const second = await localSeat(root, { instanceId: "swap-second" });
  t.after(() => second.seat.stop());
  assert.equal(second.seat.status().writable, false);

  const before = second.seat.registry.startedAt;
  // 外人把 B 的座位文件改写成「很早就启动」的假座次。
  await fsp.writeFile(second.seat.registry.file, JSON.stringify({
    pid: process.pid,
    instanceId: "swap-intruder",
    startedAt: before - 60000,
    heartbeatAt: Date.now(),
  }), "utf8");
  await second.seat.registry.heartbeat();

  const payload = JSON.parse(await fsp.readFile(second.seat.registry.file, "utf8"));
  assert.equal(payload.instanceId, "swap-second", "必须重写回自己的身份");
  assert.ok(payload.startedAt > before, "不许悄悄续用被改写的旧座次");
  assert.equal(payload.startedAt, second.seat.registry.startedAt);
  await second.seat.guard.poll();
  assert.equal(second.seat.status().writable, false);
});

test("启动竞态：先启动者 announce 晚于后启动者，下一拍就收敛、不留长期双写", async (t) => {
  const root = await tempDataRoot(t, "seat-race");
  const earlierStartedAt = Date.now() - 5000;
  const a = createSeatRegistry({ dataRoot: root, instanceId: "race-a", startedAt: earlierStartedAt });
  const b = await localSeat(root, { instanceId: "race-b", startedAt: Date.now() });
  t.after(() => b.seat.stop());
  t.after(() => a.withdraw());

  // B 先占座：此刻目录里还没有 A，B 认为自己可写。
  assert.equal(b.seat.status().writable, true);
  // A 晚 announce，但 startedAt 更早 → A 认为自己是写者。
  await a.announce();
  assert.equal((await a.evaluate()).held, false);

  // 两人短暂都以为自己能写（B 的心跳/判定窗口内），但一拍内必须收敛：
  await b.seat.guard.poll();
  assert.equal(b.seat.status().writable, false);
  assert.equal(b.seat.status().holder?.instanceId, "race-a");
  assert.equal((await a.evaluate()).held, false, "收敛后 A 独占写权");
  // 收敛后不再翻转
  await b.seat.guard.poll();
  assert.equal(b.seat.status().writable, false);
});
