// L1 投影账本测试：saveL1 是每轮装配热路径，同样的投影重复保存不得重写账本
// （每轮一次加锁 + 序列化 + rename 会把「低频落盘」变成「每轮写盘」）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createStateStore } from "../../src/plugin/state.mjs";

async function setup(t) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-projection-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

const SCOPE = "amber";

function projectionFile(base) {
  const hex = Buffer.from(SCOPE, "utf8").toString("hex");
  return path.join(base, "projections", `${hex}.json`);
}

test("projection：同一份 L1 重复保存不重写账本（mtime 与 savedAt 都不动）", async (t) => {
  const base = await setup(t);
  const store = createStateStore({ stateRoot: base });

  const first = await store.projectionStore.saveL1(SCOPE, { text: "# 核心\n内容", revision: "rev-1" });
  assert.equal(first, undefined);
  const file = projectionFile(base);
  const before = await stat(file);
  const savedL1 = await store.projectionStore.loadL1(SCOPE);
  assert.equal(savedL1.revision, "rev-1");
  assert.equal(savedL1.text, "# 核心\n内容");

  await new Promise((resolve) => setTimeout(resolve, 25));
  // 每轮装配都会再走一次：同样的 text + revision 不许落盘。
  await store.projectionStore.saveL1(SCOPE, { text: "# 核心\n内容", revision: "rev-1" });
  await store.projectionStore.saveL1(SCOPE, { text: "# 核心\n内容", revision: "rev-1" });

  const after = await stat(file);
  assert.equal(after.mtimeMs, before.mtimeMs, "未变化的投影不得重写账本");
  assert.equal(after.size, before.size);
  const again = await store.projectionStore.loadL1(SCOPE);
  assert.equal(again.savedAt, savedL1.savedAt, "savedAt 只记投影真正变化的时刻");
});

test("projection：投影变化（正文或 revision）时落盘，loadL1 拿到最新", async (t) => {
  const base = await setup(t);
  const store = createStateStore({ stateRoot: base });
  await store.projectionStore.saveL1(SCOPE, { text: "一", revision: "rev-1" });
  const file = projectionFile(base);
  const before = await stat(file);

  await new Promise((resolve) => setTimeout(resolve, 25));
  await store.projectionStore.saveL1(SCOPE, { text: "二", revision: "rev-1" });
  assert.notEqual((await stat(file)).mtimeMs, before.mtimeMs, "正文变了必须落盘");
  assert.equal((await store.projectionStore.loadL1(SCOPE)).text, "二");

  const changed = await stat(file);
  await new Promise((resolve) => setTimeout(resolve, 25));
  // 正文相同、revision 变了（外部改写人设/核心后的重新渲染）同样要落盘。
  await store.projectionStore.saveL1(SCOPE, { text: "二", revision: "rev-2" });
  assert.notEqual((await stat(file)).mtimeMs, changed.mtimeMs);
  const latest = await store.projectionStore.loadL1(SCOPE);
  assert.equal(latest.revision, "rev-2");
  assert.equal(latest.text, "二");
});

test("projection：未保存过时 loadL1 返回 null；waterline 与投影互不影响", async (t) => {
  const base = await setup(t);
  const store = createStateStore({ stateRoot: base });
  assert.equal(await store.projectionStore.loadL1(SCOPE), null);

  const waterline = { softChars: 700, hardChars: 900, hardCapChars: 1000 };
  await store.projectionStore.saveL1(SCOPE, { text: "x".repeat(120), waterline });
  assert.equal((await store.projectionStore.loadL1(SCOPE)).text.length, 120);

  // 第二轮没变：账本不重写，但水位采样仍按自己的节流判定（这里同小时同区 → 不记）。
  const { readWaterline } = await import("../../src/plugin/state.mjs");
  const entriesBefore = await readWaterline(base, SCOPE);
  await store.projectionStore.saveL1(SCOPE, { text: "x".repeat(120), waterline });
  assert.deepEqual(await readWaterline(base, SCOPE), entriesBefore);
});
