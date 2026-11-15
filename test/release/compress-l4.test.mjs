// L4 压力测试（发版门禁层）：4097 会话洪泛——自 test/host/compress-probe.test.mjs
// 原样搬移（用例与断言逐字未改），默认 `npm test` 不跑本文件
// （scripts/run-tests.mjs dev 层只收集 test/host 等开发目录，test/release/ 整目录
// 只在 `npm run test:release` 收集）。4097 的洪泛规模完整保留，未降级。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createCompressProbe, createJsonFileSink } from "../../src/host/compress-probe.mjs";

const compressEvent = (over = {}) => ({
  eventId: "evt-1",
  sessionId: "sess-1",
  name: "compress",
  success: true,
  blocksCreated: 2,
  ...over,
});

test("L4：跨 session 洪泛（4097 个会话）后，最早会话的水位仍保留——恢复重放不重复推进", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-probe-l4-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "epoch.json");
  const sink = createJsonFileSink(statePath);

  const probe1 = createCompressProbe({ sink });
  await probe1.restore();
  await probe1.observe(compressEvent({ eventId: "s0:tool/ptc-dispatch:1", sessionId: "s0", seq: 1, blocksCreated: 2 }));
  assert.equal(probe1.epoch(), 1);
  // 4097 个不同 session 的 compress（都带 seq），超过旧版水位/集合全部上限
  for (let i = 0; i < 4097; i += 1) {
    await probe1.observe(compressEvent({
      eventId: `sflood-${i}:tool/ptc-dispatch:5`,
      sessionId: `sflood-${i}`,
      seq: 5,
      blocksCreated: 1,
    }));
  }
  assert.equal(probe1.epoch(), 4098);

  // 持久保存并恢复；重放最早会话的事件 → 水位仍在 → duplicate
  const probe2 = createCompressProbe({ sink });
  await probe2.restore();
  assert.equal(probe2.epoch(), 4098);
  const replay = await probe2.observe(compressEvent({ eventId: "s0:tool/ptc-dispatch:1", sessionId: "s0", seq: 1, blocksCreated: 2 }));
  assert.equal(replay.advanced, false, "带真实 seq 的路径也不得因淘汰重新推进");
  assert.equal(replay.reason, "duplicate");
  assert.equal(probe2.epoch(), 4098);
});
