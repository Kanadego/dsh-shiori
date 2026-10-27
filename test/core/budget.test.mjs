import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateMutation } from "../../src/core/budget.mjs";
import { DEFAULT_CONFIG } from "../../src/core/config.mjs";

const config = DEFAULT_CONFIG;
// 默认配置推导：softAt=7500、hardAt=9000、hardCapChars=10000

function evaluate(currentChars, candidateChars, overrideConfig = config) {
  return evaluateMutation({
    currentText: "a".repeat(currentChars),
    candidateText: "a".repeat(candidateChars),
    config: overrideConfig,
  });
}

function assertResult(result, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(result[key], value, `${key}: expected ${value}, got ${result[key]} (reason=${result.reason})`);
  }
}

test("default config derives softAt=7500 and hardAt=9000", () => {
  const result = evaluate(0, 0);
  assert.equal(result.softAt, 7500);
  assert.equal(result.hardAt, 9000);
});

test("level boundaries: 7499/7500, 8999/9000, 10000/10001", () => {
  assertResult(evaluate(7499, 7499), { level: "normal" });
  assertResult(evaluate(7500, 7500), { level: "soft" });
  assertResult(evaluate(8999, 8999), { level: "soft" });
  assertResult(evaluate(9000, 9000), { level: "gate" });
  assertResult(evaluate(10000, 10000), { level: "gate" });
  assertResult(evaluate(10001, 10001), { level: "over-cap" });
});

test("below the gate a candidate may first cross into >=9000 up to 10000", () => {
  assertResult(evaluate(8999, 9500), { allowed: true, promotable: true, reason: "first-crossing", level: "soft" });
  assertResult(evaluate(8999, 9000), { allowed: true, promotable: true, reason: "first-crossing" });
  assertResult(evaluate(8999, 10000), { allowed: true, promotable: true, reason: "first-crossing" });
  assertResult(evaluate(0, 10000), { allowed: true, promotable: true, reason: "first-crossing" });
});

test("at or above the gate net growth is blocked", () => {
  assertResult(evaluate(9500, 9501), { allowed: false, promotable: false, reason: "net-growth-blocked", level: "gate" });
  assertResult(evaluate(9000, 9001), { allowed: false, promotable: false, reason: "net-growth-blocked" });
  assertResult(evaluate(9500, 9600), { allowed: false, promotable: false, reason: "net-growth-blocked" });
  assertResult(evaluate(10000, 10001), { allowed: false, promotable: false, reason: "over-hard-cap" });
});

test("at the gate equal-size rewrites and net reductions are allowed", () => {
  assertResult(evaluate(9500, 9500), { allowed: true, promotable: true, reason: "gate-hold" });
  assertResult(evaluate(9500, 9400), { allowed: true, promotable: true, reason: "net-reduction" });
  assertResult(evaluate(9500, 7000), { allowed: true, promotable: true, reason: "net-reduction" });
});

test("normal-state candidates above the hard cap are rejected outright", () => {
  assertResult(evaluate(8999, 10001), { allowed: false, promotable: false, reason: "over-hard-cap" });
  assertResult(evaluate(100, 10001), { allowed: false, promotable: false, reason: "over-hard-cap" });
  assertResult(evaluate(0, 10001), { allowed: false, promotable: false, reason: "over-hard-cap" });
});

test("over-cap current allows net-decrease repair down to <=10000 and is promotable", () => {
  assertResult(evaluate(10001, 10000), { allowed: true, promotable: true, reason: "repair", level: "over-cap" });
  assertResult(evaluate(10001, 9999), { allowed: true, promotable: true, reason: "repair" });
  assertResult(evaluate(11000, 7500), { allowed: true, promotable: true, reason: "repair" });
});

test("over-cap partial repair may be written but must not be promoted", () => {
  const result = evaluate(11000, 10500);
  assertResult(result, { allowed: true, promotable: false, reason: "repair-over-cap", level: "over-cap" });
  // allowed 与 promotable 不混用的直接证据
  assert.ok(result.allowed === true && result.promotable === false);
});

test("over-cap current rejects anything that is not a net decrease", () => {
  assertResult(evaluate(10001, 10001), { allowed: false, promotable: false, reason: "repair-only" });
  assertResult(evaluate(10001, 10002), { allowed: false, promotable: false, reason: "repair-only" });
  assertResult(evaluate(11000, 11000), { allowed: false, promotable: false, reason: "repair-only" });
});

test("soft watermark: reminders but no blocking", () => {
  assertResult(evaluate(7000, 7499), { allowed: true, promotable: true, reason: "ok" });
  assertResult(evaluate(7000, 7500), { allowed: true, promotable: true, reason: "soft-reminder" });
  assertResult(evaluate(7600, 7400), { allowed: true, promotable: true, reason: "ok" });
  assertResult(evaluate(7600, 7700), { allowed: true, promotable: true, reason: "soft-reminder" });
});

test("emoji counts as 2 UTF-16 chars toward every watermark", () => {
  // currentText = "a"×8998 + "😀" → 9000 码元（若按 1 计则是 8999）
  const currentText = "a".repeat(8998) + "😀";
  assert.equal(currentText.length, 9000);
  const candidateText = "a".repeat(8998) + "😀😀";
  assert.equal(candidateText.length, 9002);
  const result = evaluateMutation({ currentText, candidateText, config });
  // 若 emoji 误按 1 计：current=8999、candidate=9000 → 将被误判为 first-crossing 放行
  assertResult(result, { allowed: false, promotable: false, reason: "net-growth-blocked", level: "gate", currentChars: 9000, candidateChars: 9002 });

  // 反向：8998 码元（a×8997+😀）→ 9000 码元仍可首次跨入
  const ok = evaluateMutation({
    currentText: "a".repeat(8997) + "😀",
    candidateText: "a".repeat(8998) + "😀",
    config,
  });
  assertResult(ok, { allowed: true, promotable: true, reason: "first-crossing", currentChars: 8999, candidateChars: 9000 });
});

test("custom config recalculates watermarks from its own caps", () => {
  const custom = {
    core: { targetChars: 500, hardCapChars: 1000, softRatio: 0.5, hardRatio: 0.8, cacheLockFallback: false },
    persona: { maxChars: 2000 },
    spark: { maxChars: 300, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 },
  };
  assertResult(evaluate(0, 0, custom), { softAt: 500, hardAt: 800 });
  assertResult(evaluate(499, 499, custom), { level: "normal" });
  assertResult(evaluate(500, 500, custom), { level: "soft" });
  assertResult(evaluate(799, 900, custom), { allowed: true, reason: "first-crossing" });
  assertResult(evaluate(800, 801, custom), { allowed: false, reason: "net-growth-blocked" });
  assertResult(evaluate(900, 1001, custom), { allowed: false, reason: "over-hard-cap" });
  assertResult(evaluate(1001, 1000, custom), { allowed: true, promotable: true, reason: "repair" });
  assertResult(evaluate(1200, 1100, custom), { allowed: true, promotable: false, reason: "repair-over-cap" });
});

test("result exposes exact chars of both sides", () => {
  const result = evaluate(1234, 5678);
  assertResult(result, { currentChars: 1234, candidateChars: 5678 });
});

test("invalid inputs are rejected with INVALID_INPUT", () => {
  assert.throws(() => evaluateMutation(), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => evaluateMutation(null), (e) => e.code === "INVALID_INPUT");
  assert.throws(
    () => evaluateMutation({ currentText: "a", candidateText: "b" }),
    (e) => e.code === "INVALID_INPUT" && /missing required property "config"/.test(e.message),
  );
  assert.throws(
    () => evaluateMutation({ currentText: "a", candidateText: "b", config: { core: { targetChars: -1 } } }),
    (e) => e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => evaluateMutation({ currentText: 5, candidateText: "b", config }),
    (e) => e.code === "INVALID_INPUT" && /currentText must be a string/.test(e.message),
  );
  assert.throws(
    () => evaluateMutation({ currentText: "a", candidateText: null, config }),
    (e) => e.code === "INVALID_INPUT" && /candidateText must be a string/.test(e.message),
  );
  assert.throws(
    () => evaluateMutation({ currentText: "a", candidateText: "b", config, extra: 1 }),
    (e) => e.code === "INVALID_INPUT" && /unknown property/.test(e.message),
  );
});

test("empty-string states are valid inputs", () => {
  assertResult(evaluate(0, 0), { allowed: true, promotable: true, reason: "ok", level: "normal", currentChars: 0, candidateChars: 0 });
  assertResult(evaluate(0, 7500), { allowed: true, reason: "soft-reminder" });
});
