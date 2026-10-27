import { test } from "node:test";
import assert from "node:assert/strict";
import { validateKey } from "../../src/core/keys.mjs";

function assertRejected(key, pattern) {
  assert.throws(
    () => validateKey(key),
    (error) => {
      assert.equal(error.code, "INVALID_INPUT", `code for ${JSON.stringify(key)}`);
      if (pattern) assert.match(error.message, pattern, `message for ${JSON.stringify(key)}`);
      return true;
    },
    `expected ${JSON.stringify(key)} to be rejected`,
  );
}

test("validateKey accepts normal keys and returns the key itself", () => {
  for (const key of ["onion", "meme-onion", "onion_meme", "洋葱梗", "a.b", "A1", "sub.topic", "t100", "console", "core-notes", "x".repeat(128)]) {
    assert.equal(validateKey(key), key);
  }
});

test("validateKey rejects non-string and empty input", () => {
  assertRejected(undefined, /must be a string/);
  assertRejected(null, /must be a string/);
  assertRejected(123, /must be a string/);
  assertRejected(["x"], /must be a string/);
  assertRejected("", /must not be empty/);
});

test("validateKey rejects keys that are too long", () => {
  assertRejected("x".repeat(129), /at most 128/);
});

test("validateKey rejects path separators, traversal and drive-letter characters", () => {
  assertRejected("a/b", /forbidden filename character/);
  assertRejected("a\\b", /forbidden filename character/);
  assertRejected("a:b", /forbidden filename character/);
  assertRejected("c:\\x", /forbidden filename character/);
  assertRejected("..", /only of dots/);
  assertRejected(".", /only of dots/);
  assertRejected("...", /only of dots/);
  for (const ch of `<>*?"|><`) {
    assertRejected(`a${ch}b`, /forbidden filename character/);
  }
});

test("validateKey rejects control characters including newlines and tabs", () => {
  assertRejected("a\nb", /control characters/);
  assertRejected("a\rb", /control characters/);
  assertRejected("a\tb", /control characters/);
  assertRejected("a\u0000b", /control characters/);
  assertRejected("a\u007fb", /control characters/);
  assertRejected("a\u0085b", /control characters/);
});

test("validateKey rejects leading/trailing spaces and trailing dots", () => {
  assertRejected(" foo", /must not start with a space/);
  assertRejected("foo ", /must not end with a space/);
  assertRejected("foo.", /must not end with a space or dot/);
  assertRejected("   ", /must not start with a space/);
});

test("validateKey rejects Windows reserved device names in any case and with extensions", () => {
  for (const key of ["CON", "con", "Con", "PRN", "prn", "AUX", "NUL", "nul", "COM1", "com9", "LPT1", "lpt9"]) {
    assertRejected(key, /Windows reserved device name/);
  }
  assertRejected("CON.md", /Windows reserved device name/);
  assertRejected("con.x", /Windows reserved device name/);
  assertRejected("CON .x", /Windows reserved device name/);
  assertRejected("CON..x", /Windows reserved device name/);
});

test("validateKey keeps non-reserved names that merely contain reserved prefixes", () => {
  // "console"/"contact" 不是保留名；只有完整的设备名（可带扩展名）才非法。
  assert.equal(validateKey("console"), "console");
  assert.equal(validateKey("contact"), "contact");
  assert.equal(validateKey("comedy"), "comedy");
  assert.equal(validateKey("nuclear"), "nuclear");
});

test("validateKey rejects the reserved Shiori alias core / core.md (case-insensitive)", () => {
  assertRejected("core", /reserved Shiori alias/);
  assertRejected("core.md", /reserved Shiori alias/);
  assertRejected("CORE", /reserved Shiori alias/);
  assertRejected("Core.MD", /reserved Shiori alias/);
});

test("every rejection carries a ShioriError shape", () => {
  try {
    validateKey("CON");
    assert.fail("expected throw");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "ShioriError");
    assert.equal(error.code, "INVALID_INPUT");
    assert.ok(typeof error.message === "string" && error.message.length > 0);
  }
});

test("R1 regression: lone surrogate code units are rejected at any position", () => {
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  // 首/中/尾孤立高/低代理，以及反序配对（两者都是孤立代理）
  assertRejected(high, /lone surrogate/);
  assertRejected(low, /lone surrogate/);
  assertRejected(`${high}a`, /lone surrogate/);
  assertRejected(`a${high}`, /lone surrogate/);
  assertRejected(`a${high}b`, /lone surrogate/);
  assertRejected(`a${low}b`, /lone surrogate/);
  assertRejected(low + high, /lone surrogate/);
  assertRejected(`${high}${high}`, /lone surrogate/);
});

test("R1 regression: distinct lone-surrogate keys would silently merge in UTF-8", () => {
  // 演示碰撞根源：两个不同的非法 key 经 UTF-8 编码都变成 U+FFFD（efbfbd）。
  // 因此必须在 key 校验层显式拒绝，而不是允许编码损失归并。
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  assert.notEqual(high, low);
  assert.equal(Buffer.from(high).toString("hex"), "efbfbd");
  assert.equal(Buffer.from(low).toString("hex"), "efbfbd");
  for (const key of [high, low]) {
    assertRejected(key, /lone surrogate/);
  }
});

test("R1 regression: valid surrogate pairs (non-BMP characters) stay legal", () => {
  assert.equal(validateKey("😀"), "😀");
  assert.equal(validateKey("𠮷"), "𠮷");
  assert.equal(validateKey("a😀b"), "a😀b");
  assert.equal(validateKey(`梗😀🀄`), `梗😀🀄`);
  // 成对代理的 UTF-8 编码不发生替换
  assert.equal(Buffer.from("😀").toString("hex"), "f09f9880");
});
