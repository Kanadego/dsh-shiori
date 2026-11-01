// F5 前置 · L1 水位采样侧表测试：采样节流（同小时内不重复记）、跨阈值必记、
// 环形上限 2000 裁剪、无文件返回空；另覆盖 sinceDays 过滤与预算变更不产生假跨越。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createStateStore, readWaterline } from "../../src/plugin/state.mjs";

const HOUR = 60 * 60 * 1000;

function hexFileName(scopeId) {
  return `${Buffer.from(scopeId, "utf8").toString("hex")}.json`;
}

async function setup(t) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-waterline-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

/** 预置水位文件（环形上限/过滤用例直接写盘，绕过采样器）。 */
async function seedWaterline(base, scopeId, entries) {
  const dir = path.join(base, "waterline");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, hexFileName(scopeId)), JSON.stringify({ entries }, null, 2), "utf8");
}

function makeStore(base, nowMs) {
  return createStateStore({ stateRoot: base, now: () => new Date(nowMs) });
}

const BUDGET = { softChars: 700, hardChars: 900, hardCapChars: 1000 };

async function saveWithChars(store, scopeId, l1Chars, waterline = BUDGET) {
  return store.projectionStore.saveL1(scopeId, {
    text: "x".repeat(l1Chars),
    revision: null,
    waterline,
  });
}

// ── 采样节流：同小时内、同水位区不重复记 ────────────────────────

test("waterline：同小时内同区不重复记；间隔满 1 小时才记下一条（interval）", async (t) => {
  const base = await setup(t);
  const scope = "scope-throttle";
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const store = makeStore(base, nowMs);

  await saveWithChars(store, scope, 100); // 首条（无历史可比，按 interval 记）
  let entries = await readWaterline(base, scope);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].trigger, "interval");
  assert.deepEqual(
    { l1Chars: entries[0].l1Chars, softChars: entries[0].softChars, hardChars: entries[0].hardChars, hardCapChars: entries[0].hardCapChars },
    { l1Chars: 100, softChars: 700, hardChars: 900, hardCapChars: 1000 },
  );

  // 同小时内、同区：多次落盘都不记（绝不每轮写盘；判定只依赖文件历史，
  // 重建 store 实例不影响）
  nowMs += 10 * 60 * 1000;
  const store2 = makeStore(base, nowMs);
  await saveWithChars(store2, scope, 200);
  await saveWithChars(store2, scope, 300);
  nowMs += 49 * 60 * 1000; // 距首条 59 分钟：仍不满 1 小时
  const store3 = makeStore(base, nowMs);
  await saveWithChars(store3, scope, 400);
  entries = await readWaterline(base, scope);
  assert.equal(entries.length, 1);

  // 距上一条 ≥ 1 小时：记 interval
  nowMs += 2 * 60 * 1000; // 61 分钟
  const store4 = makeStore(base, nowMs);
  await store4.projectionStore.saveL1(scope, {
    text: "x".repeat(500),
    revision: null,
    waterline: BUDGET,
  });
  entries = await readWaterline(base, scope);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].trigger, "interval");
  assert.equal(entries[1].l1Chars, 500);
});

test("waterline：节流命中时账本文件不被重写（无变更不落盘，mtime 不变）", async (t) => {
  const base = await setup(t);
  const scope = "scope-nowrite";
  let nowMs = Date.UTC(2026, 0, 2, 0, 0, 0);
  await saveWithChars(makeStore(base, nowMs), scope, 100); // 首条落盘
  const file = path.join(base, "waterline", hexFileName(scope));
  const before = (await stat(file)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  nowMs += 5 * 60 * 1000;
  // 同小时内同区：判定为「不记」，账本必须完全不落盘——每轮 L1 装配都原子写
  // 会让 mtime 每轮都变，与 state.mjs 的「绝不每轮写盘」承诺相反。
  await saveWithChars(makeStore(base, nowMs), scope, 120);
  await saveWithChars(makeStore(base, nowMs), scope, 130);
  assert.equal((await stat(file)).mtimeMs, before, "节流命中时不得重写水位账本");
  assert.equal((await readWaterline(base, scope)).length, 1);
});

// ── 跨阈值必记：由安全区进入警告区 / 由警告区进入危险区 ──────────

test("waterline：跨软水位/硬闸必记（soft-cross/hard-cross）；降回低区不记；换预算不产生假跨越", async (t) => {
  const base = await setup(t);
  const scope = "scope-cross";
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  let store = makeStore(base, nowMs);

  await saveWithChars(store, scope, 100); // interval（safe）
  nowMs += 5 * 60 * 1000;
  store = makeStore(base, nowMs);
  await saveWithChars(store, scope, 750); // safe → warning：soft-cross
  nowMs += 5 * 60 * 1000;
  store = makeStore(base, nowMs);
  await saveWithChars(store, scope, 950); // warning → danger：hard-cross
  nowMs += 5 * 60 * 1000;
  store = makeStore(base, nowMs);
  await saveWithChars(store, scope, 980); // danger 内徘徊：不记
  nowMs += 5 * 60 * 1000;
  store = makeStore(base, nowMs);
  // 预算收紧（soft 970 / hard 990）：同 61 分钟内 zone 用「各条目自带水位线」
  // 判定——960 相对新预算为 safe，属降区，不记；也不因阈值变化记假跨越。
  await saveWithChars(store, scope, 960, { softChars: 970, hardChars: 990, hardCapChars: 1000 });
  nowMs += 5 * 60 * 1000;
  store = makeStore(base, nowMs);
  // 新预算下 985 ≥ 970（warning，相对上一条 960@970 也是 warning）：不记
  await saveWithChars(store, scope, 985, { softChars: 970, hardChars: 990, hardCapChars: 1000 });

  const entries = await readWaterline(base, scope);
  assert.deepEqual(entries.map((e) => e.trigger), ["interval", "soft-cross", "hard-cross"]);
  assert.deepEqual(entries.map((e) => e.l1Chars), [100, 750, 950]);
});

// ── 环形上限 2000：超出丢最旧 ────────────────────────────────

test("waterline：环形上限 2000 条，超出丢最旧", async (t) => {
  const base = await setup(t);
  const scope = "scope-ring";
  const start = Date.UTC(2025, 0, 1, 0, 0, 0);
  const seeded = [];
  for (let i = 0; i < 2050; i += 1) {
    seeded.push({
      at: new Date(start + i * HOUR).toISOString(),
      l1Chars: i,
      softChars: 700,
      hardChars: 900,
      hardCapChars: 1000,
      trigger: "interval",
    });
  }
  await seedWaterline(base, scope, seeded);

  // 末条之后 2 小时再采一条 → 记录后裁到 2000，最旧的被丢
  const store = makeStore(base, start + 2050 * HOUR);
  await saveWithChars(store, scope, 1234);

  const entries = await readWaterline(base, scope);
  assert.equal(entries.length, 2000);
  assert.equal(entries[0].l1Chars, 51); // 2051 条裁到 2000：最旧的 51 条（含原 0..50）被丢
  assert.equal(entries[entries.length - 1].l1Chars, 1234);
  assert.equal(entries[entries.length - 1].trigger, "interval");
});

// ── 无文件返回空；sinceDays 过滤 ─────────────────────────────

test("waterline：旧 scope 无文件返回空数组不报错；sinceDays 只返回最近 N 天", async (t) => {
  const base = await setup(t);
  assert.deepEqual(await readWaterline(base, "scope-never-sampled"), []);

  // sinceDays 过滤按真实时钟取截止线：夹具时间用真实 now 回推
  const nowMs = Date.now();
  await seedWaterline(base, "scope-window", [
    { at: new Date(nowMs - 10 * 24 * HOUR).toISOString(), l1Chars: 1, softChars: 700, hardChars: 900, hardCapChars: 1000, trigger: "interval" },
    { at: new Date(nowMs - 1 * 24 * HOUR).toISOString(), l1Chars: 2, softChars: 700, hardChars: 900, hardCapChars: 1000, trigger: "hard-cross" },
  ]);
  const all = await readWaterline(base, "scope-window");
  assert.equal(all.length, 2);
  const recent = await readWaterline(base, "scope-window", { sinceDays: 7 });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].l1Chars, 2);

  // 非法 sinceDays / scopeId / root 拒绝
  await assert.rejects(() => readWaterline(base, "scope-window", { sinceDays: 0 }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => readWaterline(base, ""), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => readWaterline("relative/root", "scope-window"), (e) => e.code === "INVALID_INPUT");
});

// ── dataRoot 隔离：水位数据只落 stateRoot ────────────────────

test("waterline：采样只写 stateRoot/waterline/，不入其他账本目录", async (t) => {
  const base = await setup(t);
  const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const store = makeStore(base, nowMs);
  await saveWithChars(store, "scope-place", 100);
  const { readdir } = await import("node:fs/promises");
  const dirs = await readdir(base);
  assert.deepEqual(dirs.sort(), ["projections", "waterline"]);
});
