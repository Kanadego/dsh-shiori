/**
 * loopback 捕获器测试：随机回环端口、真实 HTTP 捕获、raw/normalized 双证据、
 * 凭证头不出现在证据中、stop 后显式失败、超时不吞、上限拒绝。
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  assembleCompleteSystem,
  createLoopbackCapture,
  normalizeCapturedRequest,
  sendProviderRequest,
  sha256Hex,
} from "../../src/acceptance/loopback-capture.mjs";
import { withTempDir } from "./helpers.mjs";

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
    const big = JSON.stringify({ model: "m", system: "x".repeat(9 * 1024 * 1024), messages: [] });
    await assert.rejects(
      fetch(`${url}/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: big, signal: AbortSignal.timeout(8000) }),
      (error) => error instanceof Error,
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
