/**
 * loopback 捕获器测试：随机回环端口、真实 HTTP 捕获、raw/normalized 双证据、
 * 凭证头不出现在证据中、stop 后显式失败、超时不吞、上限拒绝。
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  assembleCompleteSystem,
  createLoopbackCapture,
  normalizeCapturedRequest,
  sendProviderRequest,
  sha256Hex,
} from "../../src/acceptance/loopback-capture.mjs";
import { withTempDir } from "./helpers.mjs";

// ─── 回环车道锁（0.5 批次 8-1，审阅者拍板方案 A，与 matrix.test.mjs 内联同款）───
// 目的：node --test 的并行单位是文件（scripts/run-tests.mjs 一条 node --test 统一
// 调度，不在本单白名单），文件内顶层用例实测严格串行——单文件无法向运行器声明
// 「把重网络用例摘出并行池」。这里用跨进程互斥锁把本文件与 matrix.test.mjs 错开，
// 降低回环连接在并行负载下被挤掉的概率（批次 8 抓到的连接层失败同族）。
// 审阅者四条硬约束：① best-effort——抢锁异常或等待超 30s 一律放行照跑并打一行
// 说明，绝不 skip/fail/少跑用例；② 防盗死锁——锁内写持有者 PID，持锁进程死亡
// （process.kill(pid,0) 探测）或锁超龄 120s 即接管清理；③ 判据零改动——锁只在
// 文件加载时抢，不介入用例内部；④ 生效证明见提交 note（两文件并行起止时间戳 +
// npm test 连跑 5 次）。锁只用来「尽量错开」，不是正确性门禁。
const LANE_DIR = path.join(tmpdir(), "shiori-acceptance-loopback-lane");
const LANE_WAIT_MS = 30_000;
const LANE_STALE_MS = 120_000;
let laneOwned = false;
process.on("exit", () => {
  if (laneOwned) { try { rmSync(LANE_DIR, { recursive: true, force: true }); } catch { /* 退出清理失败无碍 */ } }
});
try {
  const laneDeadline = Date.now() + LANE_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LANE_DIR); // 原子抢占；EEXIST = 已有人持锁
      writeFileSync(path.join(LANE_DIR, "pid"), String(process.pid));
      laneOwned = true;
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error; // 非「已存在」异常 → 外层放行照跑
      let steal = true;
      try {
        const holder = Number(readFileSync(path.join(LANE_DIR, "pid"), "utf8").trim());
        const age = Date.now() - statSync(LANE_DIR).mtimeMs;
        let holderAlive = false;
        try { process.kill(holder, 0); holderAlive = true; } catch (e) { holderAlive = e?.code === "EPERM"; }
        if (Number.isInteger(holder) && holder > 0 && holderAlive && age < LANE_STALE_MS) steal = false;
      } catch { /* pid 文件缺失/读失败 → 视为可接管 */ }
      if (steal) {
        try { rmSync(LANE_DIR, { recursive: true, force: true }); } catch { /* 接管失败下轮重试 */ }
        continue;
      }
      if (Date.now() >= laneDeadline) {
        console.error(`[loopback-lane] 等待回环车道锁超 ${LANE_WAIT_MS}ms，放行照跑（best-effort，不改变判据）`);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
} catch (error) {
  console.error(`[loopback-lane] 锁机制异常（${error?.message ?? error}），放行照跑（best-effort，不改变判据）`);
}

const HOST_OWN = "Host-owned synthetic system text for capture tests.";

function fakeHost(sections = []) {
  return {
    listSections: () => sections,
  };
}

test("capture starts on a random 127.0.0.1 port and stops cleanly", async () => {
  const capture = createLoopbackCapture();
  const started = await capture.start();
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  const second = createLoopbackCapture();
  const started2 = await second.start();
  assert.notEqual(started.port, started2.port, "two captures must get distinct random ports");
  // 生命周期诊断（反馈 F3）：运行中 started=true；stop 后必须归位为 false。
  assert.equal(capture.diagnostics().started, true, "diagnostics must report started=true while running");
  await capture.stop();
  await second.stop();
  const diag = capture.diagnostics();
  assert.equal(diag.started, false, "diagnostics must NOT report started=true after stop()");
  assert.equal(diag.stopped, true);
  assert.equal((await capture.stop()).alreadyStopped, true, "stop is idempotent");
  assert.equal(capture.diagnostics().started, false, "idempotent second stop must not flip started back on");
});

test("capture url/port throw before start", () => {
  const capture = createLoopbackCapture();
  assert.throws(() => capture.url, (e) => e.code === "INVALID_STATE");
  assert.throws(() => capture.port, (e) => e.code === "INVALID_STATE");
});

test("a stopped capture cannot be restarted", async () => {
  const capture = createLoopbackCapture();
  await capture.start();
  await capture.stop();
  await assert.rejects(capture.start(), (e) => e.code === "INVALID_STATE");
});

test("sendProviderRequest does a real loopback POST and records raw + normalized evidence", async () => {
  const capture = createLoopbackCapture();
  await capture.start();
  try {
    const host = fakeHost([
      { name: "shiori:persona", order: 0, text: () => "P0-TEXT" },
      { name: "shiori:core", order: 0.5, text: async () => "L1-TEXT" },
    ]);
    const sent = await sendProviderRequest({
      capture,
      host,
      hostOwnSystem: HOST_OWN,
      model: "synthetic-test",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(sent.status, 200);
    const captured = capture.requests[sent.captureIndex];
    assert.ok(captured);
    // raw 证据：确定性序列化的字节与 hash 可复算。
    const expectedBody = JSON.stringify({ model: "synthetic-test", system: `${HOST_OWN}\n\nP0-TEXT\n\nL1-TEXT`, messages: [{ role: "user", content: "hi" }] });
    assert.equal(captured.bytes, Buffer.byteLength(expectedBody, "utf8"));
    assert.equal(captured.sha256, sha256Hex(Buffer.from(expectedBody, "utf8")));
    // normalized 证据：完整 system 按序拼接。
    assert.equal(captured.normalized.system, `${HOST_OWN}\n\nP0-TEXT\n\nL1-TEXT`);
    assert.equal(captured.normalized.model, "synthetic-test");
  } finally {
    await capture.stop();
  }
});

test("sensitive headers never reach the evidence; only names are recorded", async () => {
  const capture = createLoopbackCapture();
  const { url } = await capture.start();
  try {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer SUPER-SECRET-TOKEN",
        "x-api-key": "SUPER-SECRET-KEY",
      },
      body: JSON.stringify({ model: "m", system: HOST_OWN, messages: [] }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(capture.requests.length, 1);
    const recorded = JSON.stringify(capture.requests[0]);
    assert.ok(!recorded.includes("SUPER-SECRET"), "secret values must not appear in captured evidence");
    assert.equal(capture.requests[0].headers.authorization, undefined);
    const recordedNames = capture.requests[0].otherHeadersPresent.map((h) => h.name);
    for (const required of ["authorization", "x-api-key"]) {
      assert.ok(recordedNames.includes(required), `header name ${required} must be recorded`);
    }
    assert.ok(!recordedNames.some((name) => !name), "only header NAMES are recorded");
    assert.deepEqual(capture.diagnostics().errors, []);
  } finally {
    await capture.stop();
  }
});

test("requests after stop fail explicitly (no silent swallow)", async () => {
  const capture = createLoopbackCapture();
  const { url } = await capture.start();
  await capture.stop();
  await assert.rejects(
    fetch(`${url}/v1/chat`, { method: "POST", body: "{}", signal: AbortSignal.timeout(3000) }),
    (error) => error instanceof Error,
  );
  assert.equal(capture.requests.length, 0);
});

test("unparseable request bodies are recorded as normalize errors, not evidence", async () => {
  const capture = createLoopbackCapture();
  const { url } = await capture.start();
  try {
    const response = await fetch(`${url}/v1/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.match(capture.requests[0].normalizeError, /not valid UTF-8 JSON/);
    assert.equal(capture.requests[0].normalized, null);
    await assert.throws(() => normalizeCapturedRequest(Buffer.from('{"nosystem":1}')), (e) => e.code === "INVALID_INPUT");
  } finally {
    await capture.stop();
  }
});

test("a stalled request times out explicitly and destroys the connection", async () => {
  const capture = createLoopbackCapture({ requestTimeoutMs: 150 });
  const { port } = await capture.start();
  try {
    // 发送头但悬着不发 body：捕获端必须在 150ms 超时并显式记录。
    await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1");
      const payload = "POST /v1/chat HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 64\r\n\r\n";
      socket.on("connect", () => socket.write(payload));
      socket.on("error", () => resolve()); // 服务端超时销毁连接 -> 客户端 ECONNRESET
      socket.on("close", () => resolve());
      setTimeout(() => { socket.destroy(); reject(new Error("timeout test did not settle in 5s")); }, 5000).unref();
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(capture.requests.length, 0);
    assert.equal(capture.diagnostics().errorCount, 1);
    assert.match(capture.diagnostics().errors[0], /timed out after 150ms/);
  } finally {
    await capture.stop();
  }
});

test("capture limit rejects extra requests with 503 and an explicit error", async () => {
  const capture = createLoopbackCapture({ maxRequests: 1 });
  const { url } = await capture.start();
  try {
    const body = JSON.stringify({ model: "m", system: HOST_OWN, messages: [] });
    for (const expected of [200, 503]) {
      const response = await fetch(`${url}/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, expected);
      await response.arrayBuffer();
    }
    assert.equal(capture.requests.length, 1);
    assert.match(capture.diagnostics().errors.join("\n"), /capture limit 1 reached/);
  } finally {
    await capture.stop();
  }
});

test("assembleCompleteSystem requires listSections and rejects non-string renders", async () => {
  await assert.rejects(assembleCompleteSystem({}, HOST_OWN), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(
    assembleCompleteSystem(fakeHost([{ name: "bad", order: 0, text: () => 42 }]), HOST_OWN),
    (e) => e.code === "INVALID_STATE",
  );
});

test("huge request bodies are rejected before capture", async () => {
  const capture = createLoopbackCapture();
  const { url } = await capture.start();
  try {
    // 减负载（0.5 批次 8-1）：8MiB 限制按整份请求体计（src/acceptance/loopback-capture.mjs
    // data 处理器累计 byteLength > 8*1024*1024 即销毁连接）。原 system 9MiB 比触发点
    // 多 ~12% 无谓流量，并行负载下回环传输拖长窗口、偶发踩线 8s AbortSignal（批次 8
    // 抓到的 flake）。这里收窄到刚好越过限制的最小值：JSON 外壳 {"model":"m",
    // "system":"","messages":[]} 恰 39 字节 + system 8MiB = 总量 8MiB + 39 > 8MiB，
    // 仍走同一拒绝分支；判据与断言零改动。
    const big = JSON.stringify({ model: "m", system: "x".repeat(8 * 1024 * 1024), messages: [] });
    await assert.rejects(
      fetch(`${url}/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: big, signal: AbortSignal.timeout(8000) }),
      (error) => error instanceof Error,
    );
    // 诊断可见性门控（0.5 批次 8-1，照 controller.test.mjs awaitAutoDiag 先例）：
    // fetch 拒绝后立刻读诊断存在时序假设。源码序上 recordError 同步先于 req.destroy()
    // （src/acceptance/loopback-capture.mjs data 处理器），fetch 拒绝又发生在 destroy
    // 之后（RST 收尾），实测探针（空载 60 次 + 双线全量对冲负载 120 次）拒绝瞬间
    // errors 恒已含 limit 条目——不变量成立。此处门控仍保留：等诊断出现在内存
    // errors 后再断言，消除「拒绝时刻 vs 诊断落账」的一切调度抖动；超时即红且
    // 把实际 errors 打进断言消息（区分三类形态：连接失败=errors 为空 / 中途断流=
    // request stream error / 限制未触发=无 limit 条目）。判据不放宽：诊断必须出现。
    const diagDeadline = Date.now() + 2000;
    let errorsSeen = "";
    while (Date.now() < diagDeadline) {
      errorsSeen = capture.diagnostics().errors.join("\n");
      if (errorsSeen.includes("8MiB capture limit")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      errorsSeen.includes("8MiB capture limit"),
      `8MiB capture limit 诊断应在连接被毁后可见（轮询超时，实际 errors=${JSON.stringify(errorsSeen)}）`,
    );
    assert.equal(capture.requests.length, 0);
    assert.match(capture.diagnostics().errors.join("\n"), /8MiB capture limit/);
  } finally {
    await capture.stop();
  }
});

test("temp evidence root helper cleans up after itself", async () => {
  await withTempDir("shiori-accept-helpers-", async (dir) => {
    assert.match(dir, /shiori-accept-helpers-/);
  });
});
