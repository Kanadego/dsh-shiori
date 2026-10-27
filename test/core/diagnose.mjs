// Shiori P0-CORE · 诊断自检脚本（非 node:test 用例，独立运行）。
// 用法：node test/core/diagnose.mjs
// 逐项快速核对六个公共导出的关键行为并打印结果；
// 全部通过时进程退出码为 0，否则为 1。
// 详细报错含义见 docs/core/TROUBLESHOOTING.md。

import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  validateConfig,
  renderL1,
  evaluateMutation,
  selectVisibleTopics,
  validateKey,
} from "../../src/core/index.mjs";

const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
}

check("exports: DEFAULT_CONFIG matches contract", () => {
  assert.equal(DEFAULT_CONFIG.core.hardCapChars, 10000);
  assert.equal(DEFAULT_CONFIG.core.targetChars, 8000);
  assert.equal(DEFAULT_CONFIG.spark.seedCount + DEFAULT_CONFIG.spark.linkCount <= DEFAULT_CONFIG.spark.maxCards, true);
});

check("validateConfig: defaults validate; bad chain rejected", () => {
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
  assert.throws(() => validateConfig({ core: { targetChars: 9500 } }), (e) => e.code === "INVALID_INPUT");
});

check("validateKey: Windows reserved names rejected", () => {
  for (const key of ["CON", "con.md", "COM1", "aux", "a/b", "..", "x ", "x.", "core", "core.md"]) {
    assert.throws(() => validateKey(key), (e) => e.code === "INVALID_INPUT", `expected reject: ${key}`);
  }
  assert.equal(validateKey("洋葱梗"), "洋葱梗");
});

check("renderL1: fixed index format, two-LF join, UTF-16 chars", () => {
  const result = renderL1({
    coreText: "core",
    topics: [{ key: "k", title: "T", summary: "S", scopeId: "amber", revision: "r", updated: "2026-01-01T00:00:00Z" }],
  });
  assert.equal(result.text, "core\n\n## 主题记忆索引 / Topic memory index\n- k [amber] — S");
  assert.equal(result.chars, result.text.length);
  assert.equal(renderL1({ coreText: "😀", topics: [] }).chars, 2);
});

check("renderL1: summary 61 and duplicate key rejected", () => {
  const topic = { key: "k", title: "T", summary: "a".repeat(60), scopeId: "g", revision: "r", updated: "2026-01-01" };
  renderL1({ coreText: "c", topics: [topic] });
  assert.throws(
    () => renderL1({ coreText: "c", topics: [{ ...topic, summary: "a".repeat(61) }] }),
    (e) => e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => renderL1({ coreText: "c", topics: [topic, { ...topic }] }),
    (e) => e.code === "INVALID_INPUT",
  );
});

check("selectVisibleTopics: active overrides global; third scope hidden", () => {
  const t = (key, scopeId) => ({ key, title: "T", summary: "S", scopeId, revision: "r", updated: "2026-01-01" });
  const visible = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [t("k", "global"), t("k", "amber"), t("k", "other"), t("z", "other")],
  });
  assert.deepEqual(visible.map((x) => [x.key, x.scopeId]), [["k", "amber"]]);
});

check("evaluateMutation: 7499/7500, 8999/9000, 10000/10001 levels", () => {
  const ev = (a, b) => evaluateMutation({ currentText: "a".repeat(a), candidateText: "a".repeat(b), config: DEFAULT_CONFIG });
  assert.equal(ev(7499, 7499).level, "normal");
  assert.equal(ev(7500, 7500).level, "soft");
  assert.equal(ev(8999, 8999).level, "soft");
  assert.equal(ev(9000, 9000).level, "gate");
  assert.equal(ev(10000, 10000).level, "gate");
  assert.equal(ev(10001, 10001).level, "over-cap");
});

check("evaluateMutation: gate + cap verdicts", () => {
  const ev = (a, b) => evaluateMutation({ currentText: "a".repeat(a), candidateText: "a".repeat(b), config: DEFAULT_CONFIG });
  assert.deepEqual(
    { a: ev(8999, 9500).allowed, r: ev(8999, 9500).reason },
    { a: true, r: "first-crossing" },
  );
  assert.equal(ev(9500, 9501).allowed, false);
  assert.equal(ev(8999, 10001).allowed, false);
  assert.deepEqual({ a: ev(10001, 10000).allowed, p: ev(10001, 10000).promotable }, { a: true, p: true });
  assert.deepEqual({ a: ev(11000, 10500).allowed, p: ev(11000, 10500).promotable }, { a: true, p: false });
});

check("determinism: repeated renders are byte-identical", () => {
  const topics = [1, 2, 3].map((i) => ({
    key: `k${i}`, title: "T", summary: `S${i}`, scopeId: "global", revision: "r", updated: "2026-01-01",
  }));
  const a = renderL1({ coreText: "c", topics });
  const b = renderL1({ coreText: "c", topics: [...topics].reverse() });
  assert.equal(a.text, b.text);
  assert.equal(a.bytes, b.bytes);
});

check("R1: lone surrogate keys rejected, valid pairs kept", () => {
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  for (const key of [high, low, `a${high}b`, low + high]) {
    assert.throws(() => validateKey(key), (e) => e.code === "INVALID_INPUT", `expected reject: ${JSON.stringify(key)}`);
  }
  assert.equal(validateKey("😀"), "😀");
  assert.equal(Buffer.from(high).toString("hex"), Buffer.from(low).toString("hex"));
});

check("R2: sparse topic arrays rejected, not skipped", () => {
  assert.throws(() => renderL1({ coreText: "x", topics: new Array(1) }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => selectVisibleTopics({ activeScopeId: "global", topics: new Array(1) }), (e) => e.code === "INVALID_INPUT");
  const sparse = [{ key: "a", title: "T", summary: "S", scopeId: "amber", revision: "r", updated: "2026-01-01" }];
  sparse[2] = sparse[0];
  assert.throws(() => renderL1({ coreText: "x", topics: sparse }), (e) => e.code === "INVALID_INPUT");
});

check("R3: exotic control objects rejected; own-property required", () => {
  assert.throws(() => validateConfig(new Date(0)), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateConfig({ core: new Map() }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => renderL1(Object.create({ coreText: "x", topics: [] })), (e) => e.code === "INVALID_INPUT");
  assert.deepEqual(validateConfig(Object.create(null)), DEFAULT_CONFIG);
  const topic = Object.create({ key: "k", title: "T", summary: "S", scopeId: "amber", revision: "r", updated: "2026-01-01" });
  assert.throws(() => selectVisibleTopics({ activeScopeId: "amber", topics: [topic] }), (e) => e.code === "INVALID_INPUT");
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`[FAIL] ${name}`);
    console.log(`       ${error.code ?? ""} ${error.message.split("\n")[0]}`);
  }
}

// 规模感参考（非断言）：200 专题渲染耗时
{
  const topics = Array.from({ length: 200 }, (_, i) => ({
    key: `topic-${String(i).padStart(4, "0")}`,
    title: `标题${i}`,
    summary: `摘要${i}`,
    scopeId: "amber",
    revision: `rev-${i}`,
    updated: "2026-10-24T00:00:00Z",
  }));
  const started = process.hrtime.bigint();
  for (let i = 0; i < 100; i++) renderL1({ coreText: "a".repeat(8000), topics });
  const ms = Number(process.hrtime.bigint() - started) / 1e6 / 100;
  console.log(`[INFO] renderL1 x100 on 200 topics: ${ms.toFixed(3)} ms/render, ${(8000 + 200 * 20).toLocaleString()}+ chars`);
}

console.log(failed === 0 ? "\ndiagnose: ALL OK" : `\ndiagnose: ${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
