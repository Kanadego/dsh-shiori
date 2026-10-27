import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  COMPRESS_TOOL,
  blocksFromReceiptText,
  createCompressProbe,
  createJsonFileSink,
  normalizeCompletionEvent,
  receiptToSuccessAndBlocks,
} from "../../src/host/compress-probe.mjs";

const compressEvent = (over = {}) => ({
  eventId: "evt-1",
  sessionId: "sess-1",
  name: "compress",
  success: true,
  blocksCreated: 2,
  ...over,
});

/** dsh-native.js:128 partialOutcomeNote 固定全文（attempt 3 行尾锚定所依据的真实格式）。 */
const partialLine = (n) =>
  `[acp-result: PARTIAL — ${n} block(s) created; some requested range(s) were NOT folded. Retry ONLY the failed range(s) listed above; do not re-fold the ranges that were applied.]`;

test("normalizeCompletionEvent：形状校验（seq 为可选适配层扩展）", () => {
  const ok = normalizeCompletionEvent(compressEvent());
  assert.deepEqual(ok, { eventId: "evt-1", sessionId: "sess-1", name: "compress", success: true, blocksCreated: 2, seq: undefined });
  const withSeq = normalizeCompletionEvent(compressEvent({ seq: 139 }));
  assert.equal(withSeq.seq, 139);
  for (const bad of [
    null,
    {},
    compressEvent({ eventId: "" }),
    compressEvent({ sessionId: "" }),
    compressEvent({ name: "" }),
    compressEvent({ success: "yes" }),
    compressEvent({ blocksCreated: -1 }),
    compressEvent({ blocksCreated: 1.5 }),
    compressEvent({ seq: -3 }),
    compressEvent({ seq: 1.5 }),
  ]) {
    assert.throws(() => normalizeCompletionEvent(bad), (e) => e.code === "INVALID_INPUT", JSON.stringify(bad));
  }
  // blocksCreated 缺省合法（直接模式无块证据）
  const noBlocks = normalizeCompletionEvent(compressEvent({ blocksCreated: undefined }));
  assert.equal(noBlocks.blocksCreated, undefined);
});

test("receiptToSuccessAndBlocks：billion-context 真实回执形状 {text, failed, outcome?, blocksCreated?}", () => {
  assert.deepEqual(
    receiptToSuccessAndBlocks({ text: "compressed 2 ranges into b1", failed: false, blocksCreated: 2 }),
    { success: true, blocksCreated: 2 },
  );
  assert.deepEqual(
    receiptToSuccessAndBlocks({ text: partialLine(1), outcome: "partial", failed: false, blocksCreated: 1 }),
    { success: true, blocksCreated: 1 },
  );
  assert.deepEqual(receiptToSuccessAndBlocks({ text: "no model request has arrived", outcome: "refused", failed: true }), { success: false, blocksCreated: undefined });
  assert.deepEqual(receiptToSuccessAndBlocks({ text: "boom", failed: true }), { success: false, blocksCreated: undefined });
  assert.deepEqual(receiptToSuccessAndBlocks({ text: "ok", failed: false }), { success: true, blocksCreated: undefined });
});

test("blocksFromReceiptText：本机实测成功格式与 PARTIAL 格式，之外不猜", () => {
  // 本机 session.v4.jsonl.zstd 实际样本（脱敏：仅消息区间与块计数）
  assert.equal(
    blocksFromReceiptText("[Compressed m00004–m00010, m00011–m00018 → 2 block(s), ~41854 tokens saved.]"),
    2,
  );
  assert.equal(
    blocksFromReceiptText("[Compressed m00001–m00038, m00041–m00065, m00067–m00073 → 3 block(s), ~73362 tokens saved.]"),
    3,
  );
  assert.equal(
    blocksFromReceiptText(partialLine(1)),
    1,
  );
  // 非 receipts / 无计数：不猜
  assert.equal(blocksFromReceiptText("compressed successfully"), undefined);
  assert.equal(blocksFromReceiptText("[Compressed nothing]"), undefined);
  assert.equal(blocksFromReceiptText(undefined), undefined);
});

test("探针：成功且有块证据推进一次；重复 eventId 不推进", async () => {
  const probe = createCompressProbe();
  const first = await probe.observe(compressEvent({ blocksCreated: 2 }));
  assert.equal(first.advanced, true);
  assert.equal(first.epoch, 1);
  assert.equal(probe.epoch(), 1);

  const dup = await probe.observe(compressEvent({ blocksCreated: 2 }));
  assert.equal(dup.advanced, false);
  assert.equal(dup.reason, "duplicate");
  assert.equal(probe.epoch(), 1);

  const second = await probe.observe(compressEvent({ eventId: "evt-2", blocksCreated: 3 }));
  assert.equal(second.advanced, true);
  assert.equal(probe.epoch(), 2);
});

test("探针：失败 / 零块 / 无块证据 / 非 compress 不推进", async () => {
  const probe = createCompressProbe();
  const cases = [
    { event: compressEvent({ eventId: "e-fail", success: false, blocksCreated: 3 }), reason: "failed" },
    { event: compressEvent({ eventId: "e-zero", blocksCreated: 0 }), reason: "zero-blocks" },
    { event: compressEvent({ eventId: "e-noblocks", blocksCreated: undefined }), reason: "no-block-evidence" },
    { event: compressEvent({ name: "memory_read", eventId: "e-read", blocksCreated: 5 }), reason: "not-compress" },
  ];
  for (const { event, reason } of cases) {
    const obs = await probe.observe(event);
    assert.equal(obs.advanced, false, event.eventId);
    assert.equal(obs.reason, reason);
  }
  assert.equal(probe.epoch(), 0);
  const obs = await probe.observe(compressEvent({ eventId: "evt-ok" }));
  assert.equal(obs.advanced, true);
});

test("探针：一次 batch/partial 只推进一次（每个 dispatch 一条归一化事件）", async () => {
  const probe = createCompressProbe();
  const one = await probe.observe(compressEvent({ eventId: "batch-1", blocksCreated: 4 }));
  assert.equal(one.advanced, true);
  await probe.observe(compressEvent({ eventId: "batch-1", blocksCreated: 4 }));
  assert.equal(probe.epoch(), 1);
});

test("R4：普通事件洪泛不破坏压缩去重（近期环淘汰后仍靠持久水位）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-probe-r4-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "epoch.json");
  const sink = createJsonFileSink(statePath);

  const probe1 = createCompressProbe({ sink });
  await probe1.restore();
  // 压缩事件带 seq（适配层形状：<sessionId>:<type>:<seq>）
  await probe1.observe(compressEvent({ eventId: "s1:tool/ptc-dispatch:10", sessionId: "s1", seq: 10, blocksCreated: 2 }));
  assert.equal(probe1.epoch(), 1);
  // 6000 条非压缩事件（远超近期环 1024 与压缩集合上限）：不进持久层
  for (let i = 0; i < 6000; i += 1) {
    await probe1.observe(compressEvent({ eventId: `s1:tool/result:${100 + i}`, sessionId: "s1", seq: 100 + i, name: "memory_read", success: true }));
  }
  assert.equal(probe1.epoch(), 1);

  // 重启：恢复后重放最初压缩事件（低于水位）→ 不推进
  const probe2 = createCompressProbe({ sink });
  await probe2.restore();
  assert.equal(probe2.epoch(), 1);
  const replay = await probe2.observe(compressEvent({ eventId: "s1:tool/ptc-dispatch:10", sessionId: "s1", seq: 10, blocksCreated: 2 }));
  assert.equal(replay.advanced, false);
  assert.equal(replay.reason, "duplicate");
  assert.equal(probe2.epoch(), 1);

  // 新压缩事件（seq 高于水位）正常推进
  const next = await probe2.observe(compressEvent({ eventId: "s1:tool/ptc-dispatch:9000", sessionId: "s1", seq: 9000, blocksCreated: 1 }));
  assert.equal(next.advanced, true);
  assert.equal(probe2.epoch(), 2);
});

test("R4：无 seq 事件的压缩去重走持久集合（近期环淘汰后仍有效）", async () => {
  const probe = createCompressProbe(); // 内存探针，模拟无 seq 注入
  await probe.observe(compressEvent({ eventId: "evt-A", blocksCreated: 1 }));
  // 洪泛大量无 seq 压缩事件，把近期环（1024）挤爆
  for (let i = 0; i < 2000; i += 1) {
    await probe.observe(compressEvent({ eventId: `bulk-${i}`, blocksCreated: 1 }));
  }
  assert.equal(probe.epoch(), 2001);
  // 持久集合上限 4096 未触发：evt-A 仍在集合内 → 重复
  const dup = await probe.observe(compressEvent({ eventId: "evt-A", blocksCreated: 1 }));
  assert.equal(dup.reason, "duplicate");
  assert.equal(probe.epoch(), 2001);
});

test("R4：无 seq 事件超过持久集合上限属已知局限（文档声明，不用调大上限掩盖）", async () => {
  const probe = createCompressProbe();
  await probe.observe(compressEvent({ eventId: "old-1", blocksCreated: 1 }));
  for (let i = 0; i < 4100; i += 1) {
    await probe.observe(compressEvent({ eventId: `old-bulk-${i}`, blocksCreated: 1 }));
  }
  // old-1 已被 FIFO 淘汰且无水位兜底：真实宿主事件恒带 seq（适配层保证），
  // 此路径只存在于无 seq 的注入事件 —— 作为已声明局限记录在 docs。
  const replay = await probe.observe(compressEvent({ eventId: "old-1", blocksCreated: 1 }));
  assert.equal(replay.advanced, true);
  assert.equal(probe.epoch(), 4102);
});

test("R4：带 seq 的压缩事件超过持久集合上限仍不重复推进（水位兜底）", async () => {
  const probe = createCompressProbe();
  // 5000 个带 seq 的压缩事件 > COMPRESS_SEEN_LIMIT(4096)：第一个事件被 FIFO 淘汰
  for (let i = 0; i < 5000; i += 1) {
    await probe.observe(compressEvent({ eventId: `s1:tool/ptc-dispatch:${i}`, sessionId: "s1", seq: i, blocksCreated: 1 }));
  }
  assert.equal(probe.epoch(), 5000);
  // 重放最早的（已被集合淘汰）→ 仍因水位判重，不推进
  const replay = await probe.observe(compressEvent({ eventId: "s1:tool/ptc-dispatch:0", sessionId: "s1", seq: 0, blocksCreated: 1 }));
  assert.equal(replay.reason, "duplicate");
  assert.equal(replay.advanced, false);
  assert.equal(probe.epoch(), 5000);
});

test("R4：跨会话隔离——不同 session 的相同 seq / eventId 互不干扰", async () => {
  const probe = createCompressProbe();
  const a = await probe.observe(compressEvent({ eventId: "sa:tool/ptc-dispatch:5", sessionId: "sa", seq: 5, blocksCreated: 1 }));
  assert.equal(a.advanced, true);
  const b = await probe.observe(compressEvent({ eventId: "sb:tool/ptc-dispatch:5", sessionId: "sb", seq: 5, blocksCreated: 1 }));
  assert.equal(b.advanced, true, "另一会话的同 seq 事件不是重复");
  // 会话内重放才是重复
  const dup = await probe.observe(compressEvent({ eventId: "sa:tool/ptc-dispatch:5", sessionId: "sa", seq: 5, blocksCreated: 1 }));
  assert.equal(dup.reason, "duplicate");
  assert.equal(probe.epoch(), 2);
});

test("持久化 + 恢复重放：重启后 epoch 保留，同一 eventId 不再推进", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-probe-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "epoch.json");
  const sink = createJsonFileSink(statePath);

  const probe1 = createCompressProbe({ sink });
  await probe1.restore();
  await probe1.observe(compressEvent({ eventId: "evt-1", blocksCreated: 2 }));
  await probe1.observe(compressEvent({ eventId: "evt-2", blocksCreated: 1 }));
  assert.equal(probe1.epoch(), 2);

  const persisted = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(persisted.epoch, 2);
  assert.ok(persisted.compressSeenIds.includes("evt-1"));
  assert.ok(typeof persisted.watermarks === "object");

  const probe2 = createCompressProbe({ sink });
  const restored = await probe2.restore();
  assert.equal(restored.restored, true);
  assert.equal(probe2.epoch(), 2);

  const replay = await probe2.observe(compressEvent({ eventId: "evt-1", blocksCreated: 2 }));
  assert.equal(replay.advanced, false);
  assert.equal(replay.reason, "duplicate");
  assert.equal(probe2.epoch(), 2);

  await probe2.observe(compressEvent({ eventId: "evt-3", blocksCreated: 5 }));
  assert.equal(probe2.epoch(), 3);
});

test("持久化槽失败如实进诊断，不丢内存 epoch", async () => {
  const sink = {
    async load() { return null; },
    async save() { throw new Error("disk full"); },
  };
  const probe = createCompressProbe({ sink });
  const obs = await probe.observe(compressEvent());
  assert.equal(obs.advanced, true);
  assert.equal(probe.epoch(), 1);
  assert.match(probe.diagnostics().sinkError ?? "", /disk full/);
});

test("R7：恢复是原子的——损坏快照在替换前抛错，旧状态原样保留且可继续重放", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-probe-r7-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "epoch.json");
  const sink = createJsonFileSink(statePath);

  // 先建立有效状态：epoch=1
  const probe = createCompressProbe({ sink });
  await probe.restore();
  await probe.observe(compressEvent({ eventId: "good-1", blocksCreated: 2 }));
  assert.equal(probe.epoch(), 1);

  const corrupted = [
    { epoch: 99, compressSeenIds: ["ok", null] },
    { epoch: 99, compressSeenIds: "not-array" },
    { epoch: "not-a-number", compressSeenIds: [] },
    { epoch: -5, compressSeenIds: [] },
    { epoch: 99, compressSeenIds: [], watermarks: { s1: "bad" } },
    { epoch: 99, compressSeenIds: [], watermarks: { "": 1 } },
    { epoch: 99, compressSeenIds: [], lastAdvance: 5 },
    { epoch: 99, compressSeenIds: [], updatedAt: 42 },
    "totally-wrong",
  ];
  for (const snapshot of corrupted) {
    await writeFile(statePath, JSON.stringify(snapshot), "utf8");
    await assert.rejects(() => probe.restore(), (e) => e.code === "INVALID_INPUT", JSON.stringify(snapshot));
    // 原子性：旧状态必须原样保留
    assert.equal(probe.epoch(), 1, `state clobbered by ${JSON.stringify(snapshot)}`);
  }

  // 旧状态仍可继续工作：重放 good-1 仍是 duplicate
  const dup = await probe.observe(compressEvent({ eventId: "good-1", blocksCreated: 2 }));
  assert.equal(dup.reason, "duplicate");
  assert.equal(probe.epoch(), 1);
});

test("R7：合法快照恢复后重放行为正确", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-probe-r7b-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "epoch.json");
  await writeFile(statePath, JSON.stringify({
    epoch: 7,
    compressSeenIds: ["c1", "c2"],
    watermarks: { sessA: 100, sessB: 42 },
    lastAdvance: { eventId: "c2", sessionId: "sessB", blocksCreated: 2, at: "2026-10-24T00:00:00.000Z" },
    updatedAt: "2026-10-24T00:00:00.000Z",
  }), "utf8");
  const probe = createCompressProbe({ sink: createJsonFileSink(statePath) });
  const restored = await probe.restore();
  assert.equal(restored.restored, true);
  assert.equal(probe.epoch(), 7);
  assert.equal((await probe.observe(compressEvent({ eventId: "c1", blocksCreated: 1 }))).reason, "duplicate");
  assert.equal((await probe.observe(compressEvent({ eventId: "sa:tool/ptc-dispatch:100", sessionId: "sessA", seq: 100, blocksCreated: 1 }))).reason, "duplicate");
  assert.equal((await probe.observe(compressEvent({ eventId: "sa:tool/ptc-dispatch:101", sessionId: "sessA", seq: 101, blocksCreated: 1 }))).advanced, true);
  assert.equal(probe.epoch(), 8);
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

test("L4：forgetSession 显式归档会话——此后该会话压缩事件一律拒绝（fail-safe）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-probe-exp-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "epoch.json");
  const sink = createJsonFileSink(statePath);

  const probe1 = createCompressProbe({ sink });
  await probe1.restore();
  await probe1.observe(compressEvent({ eventId: "s1:tool/ptc-dispatch:10", sessionId: "s1", seq: 10, blocksCreated: 2 }));
  assert.equal(probe1.epoch(), 1);

  await probe1.forgetSession("s1");
  // 归档后：同一事件（低于水位）与更高 seq 的新事件都拒绝——不重新当成新压缩。
  // 旧 id 可能先命中运行期重复/持久集合（reason duplicate），语义同样是拒绝推进。
  const replayOld = await probe1.observe(compressEvent({ eventId: "s1:tool/ptc-dispatch:10", sessionId: "s1", seq: 10, blocksCreated: 2 }));
  assert.equal(replayOld.advanced, false);
  assert.ok(["duplicate", "expired-session"].includes(replayOld.reason), replayOld.reason);
  const replayNew = await probe1.observe(compressEvent({ eventId: "s1:tool/ptc-dispatch:99", sessionId: "s1", seq: 99, blocksCreated: 2 }));
  assert.equal(replayNew.reason, "expired-session");
  assert.equal(replayNew.advanced, false);
  assert.equal(probe1.epoch(), 1);
  // 归档会话的普通事件照旧观测（本来就不推进）
  const ordinary = await probe1.observe(compressEvent({ eventId: "s1:tool/result:100", sessionId: "s1", seq: 100, name: "memory_read", success: true }));
  assert.equal(ordinary.reason, "not-compress");

  // 归档持久化：重启后依旧拒绝
  const probe2 = createCompressProbe({ sink });
  await probe2.restore();
  const afterRestart = await probe2.observe(compressEvent({ eventId: "s1:tool/ptc-dispatch:200", sessionId: "s1", seq: 200, blocksCreated: 2 }));
  assert.equal(afterRestart.reason, "expired-session");

  // 其他会话不受影响
  const other = await probe2.observe(compressEvent({ eventId: "s2:tool/ptc-dispatch:1", sessionId: "s2", seq: 1, blocksCreated: 1 }));
  assert.equal(other.advanced, true);
  assert.equal(probe2.epoch(), 2);

  // forgetSession 参数校验
  await assert.rejects(() => probe2.forgetSession(""), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => probe2.forgetSession(42), (e) => e.code === "INVALID_INPUT");
});

test("探针不接受 token 骤降类信号：观察面只有归一化完成事件", () => {
  const probe = createCompressProbe();
  assert.equal(typeof probe.observe, "function");
  assert.equal(probe.observe.length, 1);
  assert.equal(COMPRESS_TOOL, "compress");
});

// ── P1-COMPLETION：整行锚定的块证据识别 ──────────────────────────────────────

test("P1 锚定：无关文本夹带箭头/片段不得解析为块证据", () => {
  // 任意位置的箭头计数不是回执
  assert.equal(blocksFromReceiptText("→ 3 block(s)"), undefined);
  assert.equal(blocksFromReceiptText("progress: 5 block(s) created today"), undefined);
  assert.equal(blocksFromReceiptText("step 1 → 2 block(s), ~30 tokens saved. done"), undefined);
  // 回执片段（前后带其他文字）不是完整回执
  assert.equal(blocksFromReceiptText("log: [Compressed m1–m2 → 2 block(s), ~10 tokens saved.] trailing"), undefined);
  assert.equal(blocksFromReceiptText("prefix [acp-result: PARTIAL — 2 block(s) created; rest"), undefined);
  // 大小写陷阱：PARTIAL 必须 [acp-result: 开头整行
  assert.equal(blocksFromReceiptText("x [acp-result: partial — 1 block(s) created;"), undefined);
});

test("P1 锚定：完整回执行（含多行文本首行）仍然解析", () => {
  assert.equal(
    blocksFromReceiptText("[Compressed m00004–m00010, m00011–m00018 → 2 block(s), ~41854 tokens saved.]"),
    2,
  );
  // 真实 PTC content：回执在首行，后跟块摘要行
  assert.equal(
    blocksFromReceiptText("[Compressed m00004–m00010, m00011–m00018 → 2 block(s), ~41854 tokens saved.]\n · b1 full summary\n · b2 full summary"),
    2,
  );
  assert.equal(
    blocksFromReceiptText(partialLine(1)),
    1,
  );
  // 回执行允许出现在多行文本的任意一整行（保守：仍须整行匹配）
  assert.equal(
    blocksFromReceiptText("header\n[Compressed m00001–m00005 → 3 block(s), ~100 tokens saved.]\nfooter"),
    3,
  );
});

test("P1 锚定（attempt 3）：PARTIAL 行尾锚定到 dsh-native 真实固定尾缀，截断/矛盾尾缀不解析", () => {
  // 真实全文（dsh-native.js:128 partialOutcomeNote，2026-10-25 复核）逐字解析
  assert.equal(blocksFromReceiptText(partialLine(2)), 2);
  assert.equal(blocksFromReceiptText(`header\n${partialLine(3)}\nfooter`), 3, "整行出现在多行文本中仍解析");
  // 前缀匹配漏洞（attempt 2 的缺陷）：真实开头 + 矛盾/伪造尾缀 → 一律不解析
  assert.equal(
    blocksFromReceiptText("[acp-result: PARTIAL — 1 block(s) created; some requested range(s) were NOT folded.]"),
    undefined,
    "截断尾缀（旧测试用的短变体）不是真实格式",
  );
  assert.equal(
    blocksFromReceiptText(`${partialLine(1)} extra text`),
    undefined,
    "真实全文后带尾随矛盾文本不得解析",
  );
  assert.equal(
    blocksFromReceiptText(partialLine(1).replace("do not re-fold the ranges that were applied.]", "please fold everything.]")),
    undefined,
    "改写尾缀不得解析",
  );
  // 无块数变体（created 为空串）：真实宿主行为，但不携带块证据 → 不解析出数字
  assert.equal(
    blocksFromReceiptText("[acp-result: PARTIAL — some requested range(s) were NOT folded. Retry ONLY the failed range(s) listed above; do not re-fold the ranges that were applied.]"),
    undefined,
  );
});

test("P1 metaConflict：元数据与文本矛盾保守不推进，仍记为已处理", async () => {
  const probe = createCompressProbe();
  const obs = await probe.observe(compressEvent({ eventId: "mc-1", seq: 5, blocksCreated: 3, metaConflict: true }));
  assert.equal(obs.advanced, false);
  assert.equal(obs.reason, "meta-conflict");
  assert.equal(probe.epoch(), 0);
  assert.equal(probe.diagnostics().metaConflictEvents, 1);
  // 已处理：同 seq 重放按 duplicate 拒绝（不得改判推进）
  const replay = await probe.observe(compressEvent({ eventId: "mc-1", seq: 5, blocksCreated: 3, metaConflict: true }));
  assert.equal(replay.reason, "duplicate");
  // normalize 校验：metaConflict 必须是 boolean
  assert.throws(() => normalizeCompletionEvent(compressEvent({ metaConflict: "yes" })), (e) => e.code === "INVALID_INPUT");
});

test("P1 call identity：同一底层调用双报告只推进一次；无 callId 推进如实计数", async () => {
  const probe = createCompressProbe();
  // direct 报告（callId c9，meta 块证据）先推进
  const direct = await probe.observe(compressEvent({
    eventId: "s1:tool/result:5", sessionId: "s1", seq: 5, callId: "c9", blocksCreated: 2,
  }));
  assert.equal(direct.advanced, true);
  // 同一调用的 PTC 报告（不同 eventId/seq，相同 callId）→ duplicate-call，不推进
  const ptc = await probe.observe(compressEvent({
    eventId: "s1:tool/ptc-dispatch:6", sessionId: "s1", seq: 6, callId: "c9", blocksCreated: 2,
  }));
  assert.equal(ptc.advanced, false);
  assert.equal(ptc.reason, "duplicate-call");
  assert.equal(probe.epoch(), 1);
  assert.equal(probe.diagnostics().duplicateCallEvents, 1);

  // 不同 callId = 不同调用，正常推进
  const other = await probe.observe(compressEvent({
    eventId: "s1:tool/ptc-dispatch:7", sessionId: "s1", seq: 7, callId: "c10", blocksCreated: 1,
  }));
  assert.equal(other.advanced, true);
  assert.equal(probe.epoch(), 2);

  // 无 callId 的推进：允许但 diagnostics 如实计数（不谎称跨路径 exactly-once）
  const anonymous = await probe.observe(compressEvent({ eventId: "evt-no-id", blocksCreated: 1 }));
  assert.equal(anonymous.advanced, true);
  assert.equal(probe.diagnostics().advancesWithoutCallIdentity, 1);
  // 同一调用先失败后成功的矛盾报告：同样按 duplicate-call 拒绝
  const failFirst = await probe.observe(compressEvent({
    eventId: "s2:tool/result:1", sessionId: "s2", seq: 1, callId: "cx", success: false, blocksCreated: 1,
  }));
  assert.equal(failFirst.reason, "failed");
  const thenSuccess = await probe.observe(compressEvent({
    eventId: "s2:tool/ptc-dispatch:2", sessionId: "s2", seq: 2, callId: "cx", success: true, blocksCreated: 1,
  }));
  assert.equal(thenSuccess.reason, "duplicate-call");
  // normalize 校验：callId 必须是非空字符串
  assert.throws(() => normalizeCompletionEvent(compressEvent({ callId: "" })), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => normalizeCompletionEvent(compressEvent({ callId: 42 })), (e) => e.code === "INVALID_INPUT");
});

test("P1 createJsonFileSink：空文件/目录/损坏 JSON 不得当新状态；save 原子含 fsync", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shiori-sink-p1-"));
  after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "epoch.json");
  const sink = createJsonFileSink(statePath);

  // 不存在 → null（唯一的新状态路径）
  assert.equal(await sink.load(), null);

  // 空文件 → 抛错，不是 null
  await writeFile(statePath, "", "utf8");
  await assert.rejects(() => sink.load(), (e) => e.code === "INVALID_INPUT");

  // 目录 → 抛错（旧行为 EISDIR 返回 null 已移除）
  await rm(statePath);
  await mkdir(statePath);
  await assert.rejects(() => sink.load(), (e) => e.code === "INVALID_INPUT");
  await rmdir(statePath);

  // 损坏 JSON → INVALID_INPUT（不是裸 SyntaxError）
  await writeFile(statePath, "{oops", "utf8");
  await assert.rejects(() => sink.load(), (e) => e.code === "INVALID_INPUT");

  // 正常 roundtrip（O_EXCL 临时文件 + fsync + rename）
  await sink.save({ epoch: 3, compressSeenIds: ["a"] });
  assert.deepEqual(await sink.load(), { epoch: 3, compressSeenIds: ["a"] });
  // 目录里没有残留 .tmp 文件
  const leftovers = (await readdir(dir)).filter((n) => n.includes(".tmp-"));
  assert.equal(leftovers.length, 0, leftovers.join(","));
});

test("P2（真实宿主 2026-10-26）：成功回执在闭合 ] 之前内嵌 Excluded 警告仍解析出块数", () => {
  // 逐字节选：session-a6026977-5… seq=124 前两条警告原文（其余三段同模板）。
  const realWarned = "[Compressed m00020–m00021, m00023–m00024, m00026–m00027, m00029–m00030, m00041–m00042 → 5 block(s), ~57512 tokens saved. Excluded 1 protected message(s) m00019 from compression range (recent/last-user zone) — they stay visible outside the new block; do not target them in another compress call.; Excluded 1 protected message(s) m00022 from compression range (recent/last-user zone) — they stay visible outside the new block; do not target them in another compress call.]";
  assert.equal(blocksFromReceiptText(realWarned), 5);
  assert.equal(blocksFromReceiptText(realWarned + "\n · b1 full summary\n · b2 full summary"), 5);
  // 硬锚点仍在：缺闭合 ] / 括号外尾随文本 / 行首混入其他文字 → 不解析
  assert.equal(blocksFromReceiptText(realWarned.slice(0, -1)), undefined);
  assert.equal(blocksFromReceiptText("log: " + realWarned), undefined);
  assert.equal(blocksFromReceiptText(realWarned + " trailing"), undefined);
  // Errors 注记（applyErrorNote）同样位于闭合 ] 内 → 解析
  assert.equal(blocksFromReceiptText("[Compressed m1–m2 → 3 block(s), ~10 tokens saved. Errors: fold failed]"), 3);
  // 警告尾串不得跨越内嵌 ]（否则任意后缀都能伪造回执）
  assert.equal(blocksFromReceiptText("[Compressed m1–m2 → 3 block(s), ~10 tokens saved. warn] junk]"), undefined);
});

