import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, validateConfig } from "../../src/core/config.mjs";

function assertRejected(config, pattern) {
  assert.throws(
    () => validateConfig(config),
    (error) => {
      assert.equal(error.code, "INVALID_INPUT", `code for ${JSON.stringify(config)}`);
      if (pattern) assert.match(error.message, pattern, `message for ${JSON.stringify(config)}`);
      return true;
    },
    `expected ${JSON.stringify(config)} to be rejected`,
  );
}

test("DEFAULT_CONFIG matches the contract values exactly", () => {
  assert.deepEqual(DEFAULT_CONFIG, {
    core: { targetChars: 8000, hardCapChars: 10000, softRatio: 0.75, hardRatio: 0.90, cacheLockFallback: false },
    persona: { maxChars: 12000 },
    spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 },
  });
});

test("DEFAULT_CONFIG is deeply frozen and validates as-is", () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.core));
  assert.ok(Object.isFrozen(DEFAULT_CONFIG.spark));
  const validated = validateConfig(DEFAULT_CONFIG);
  assert.deepEqual(validated, DEFAULT_CONFIG);
  assert.notEqual(validated, DEFAULT_CONFIG);
});

test("validateConfig fills missing sections and keys from defaults", () => {
  assert.deepEqual(validateConfig({}), DEFAULT_CONFIG);
  const partial = validateConfig({ core: { targetChars: 8500 } });
  assert.equal(partial.core.targetChars, 8500);
  assert.equal(partial.core.hardCapChars, 10000);
  assert.equal(partial.persona.maxChars, 12000);
  assert.equal(partial.spark.linkCount, 2);
  // 输入不被修改，返回值是全新对象
  const input = { core: { targetChars: 8500 } };
  validateConfig(input);
  assert.deepEqual(input, { core: { targetChars: 8500 } });
  assert.notEqual(partial, DEFAULT_CONFIG);
  assert.ok(Object.isFrozen(partial));
  assert.ok(Object.isFrozen(partial.core));
});

test("validateConfig accepts a fully custom valid config", () => {
  const config = {
    core: { targetChars: 500, hardCapChars: 1000, softRatio: 0.5, hardRatio: 0.8, cacheLockFallback: true },
    persona: { maxChars: 2000 },
    spark: { maxChars: 300, inlineMaxChars: 50, maxCards: 4, seedCount: 2, linkCount: 2 },
  };
  const validated = validateConfig(config);
  assert.deepEqual(validated, config);
  // softAt=500 ≤ 500 < hardAt=800 < 1000
  assert.equal(Math.floor(1000 * 0.5), 500);
  assert.equal(Math.floor(1000 * 0.8), 800);
});

test("validateConfig accepts linkCount 0", () => {
  const validated = validateConfig({ spark: { linkCount: 0 } });
  assert.equal(validated.spark.linkCount, 0);
});

test("validateConfig rejects non-object input", () => {
  assertRejected(undefined, /must be a plain object/);
  assertRejected(null, /must be a plain object/);
  assertRejected(42, /must be a plain object/);
  assertRejected("config", /must be a plain object/);
  assertRejected([], /must be a plain object/);
});

test("validateConfig rejects unknown properties at both levels", () => {
  assertRejected({ extra: 1 }, /unknown top-level property "extra"/);
  assertRejected({ core: { targetChar: 8000 } }, /unknown property "targetChar"/);
  assertRejected({ spark: { maxCard: 5 } }, /unknown property "maxCard"/);
});

test("validateConfig rejects non-object sections", () => {
  assertRejected({ core: null }, /config\.core must be a plain object/);
  assertRejected({ core: [] }, /config\.core must be a plain object/);
  assertRejected({ persona: 12 }, /config\.persona must be a plain object/);
});

test("validateConfig rejects invalid numeric fields", () => {
  for (const bad of [0, -1, 1.5, "8000", NaN, Infinity, null]) {
    assertRejected({ core: { targetChars: bad } }, /core\.targetChars must be a positive integer/);
    assertRejected({ persona: { maxChars: bad } }, /persona\.maxChars must be a positive integer/);
    assertRejected({ spark: { maxChars: bad } }, /spark\.maxChars must be a positive integer/);
  }
  assertRejected({ spark: { linkCount: -1 } }, /linkCount must be a non-negative integer/);
  assertRejected({ spark: { linkCount: 1.5 } }, /linkCount must be a non-negative integer/);
  assertRejected({ spark: { seedCount: 0 } }, /seedCount must be a positive integer/);
});

test("validateConfig rejects invalid ratios", () => {
  for (const bad of [0, -0.1, 1, 1.5, NaN, "0.75"]) {
    assertRejected({ core: { softRatio: bad } }, /core\.softRatio/);
  }
  for (const bad of [1, 1.2, 0, NaN]) {
    assertRejected({ core: { hardRatio: bad } }, /core\.hardRatio/);
  }
  assertRejected({ core: { softRatio: 0.8, hardRatio: 0.8 } }, /softRatio \(0\.8\) must be < core\.hardRatio/);
  assertRejected({ core: { softRatio: 0.85, hardRatio: 0.8 } }, /must be < core\.hardRatio/);
});

test("validateConfig rejects non-boolean cacheLockFallback", () => {
  assertRejected({ core: { cacheLockFallback: "false" } }, /cacheLockFallback must be a boolean/);
  assertRejected({ core: { cacheLockFallback: 0 } }, /cacheLockFallback must be a boolean/);
  assertRejected({ core: { cacheLockFallback: null } }, /cacheLockFallback must be a boolean/);
});

test("validateConfig rejects spark constraint violations", () => {
  assertRejected({ spark: { maxChars: 100, inlineMaxChars: 101 } }, /inlineMaxChars \(101\) must be <= spark\.maxChars \(100\)/);
  assertRejected({ spark: { inlineMaxChars: 601 } }, /inlineMaxChars \(601\) must be <= spark\.maxChars \(600\)/);
  assertRejected({ spark: { seedCount: 4, linkCount: 2 } }, /seedCount \+ spark\.linkCount \(6\) must be <= spark\.maxCards/);
  assertRejected({ spark: { maxCards: 2, seedCount: 3 } }, /must be <= spark\.maxCards/);
});

test("validateConfig rejects watermark chain violations with default caps", () => {
  // 默认 softAt=7500、hardAt=9000
  assertRejected({ core: { targetChars: 7499 } }, /softAt \(7500\) must be <= core\.targetChars/);
  assertRejected({ core: { targetChars: 9000 } }, /core\.targetChars \(9000\) must be < derived hardAt/);
  assertRejected({ core: { targetChars: 9500 } }, /core\.targetChars \(9500\) must be < derived hardAt/);
});

test("validateConfig rejects configs where derived softAt equals hardAt", () => {
  // hardCap=10, softRatio=0.80 → softAt=8；hardRatio=0.84 → hardAt=8
  // targetChars 需要同时 ≥8 且 <8，任何值都非法
  assertRejected(
    { core: { targetChars: 7, hardCapChars: 10, softRatio: 0.8, hardRatio: 0.84 } },
    /softAt \(8\) must be <= core\.targetChars/,
  );
  assertRejected(
    { core: { targetChars: 8, hardCapChars: 10, softRatio: 0.8, hardRatio: 0.84 } },
    /must be < derived hardAt/,
  );
});

test("validateConfig rejects degenerate hardCapChars that cannot satisfy the chain", () => {
  // hardCap=1 时 hardAt=floor(1×hardRatio)=0，targetChars<0 不可能
  assertRejected(
    { core: { targetChars: 1, hardCapChars: 1, softRatio: 0.5, hardRatio: 0.9 } },
    /must be < derived hardAt/,
  );
});

test("validateConfig error shape", () => {
  try {
    validateConfig({ core: { targetChars: -1 } });
    assert.fail("expected throw");
  } catch (error) {
    assert.equal(error.name, "ShioriError");
    assert.equal(error.code, "INVALID_INPUT");
  }
});

test("R3 regression: exotic objects are not accepted as config or sections", () => {
  // Date/Map/Set/类实例都不是普通记录对象，不能充当配置
  assertRejected(new Date(0), /config must be a plain object, got Date/);
  assertRejected(new Map(), /config must be a plain object, got Map/);
  assertRejected(new Set(), /config must be a plain object, got Set/);
  assertRejected(/regex/, /config must be a plain object, got RegExp/);
  class Foo {}
  assertRejected(new Foo(), /config must be a plain object, got Foo/);
  // 段级同样拒绝：不能被当成缺省静默通过
  assertRejected({ core: new Date(0) }, /config\.core must be a plain object, got Date/);
  assertRejected({ core: new Map() }, /config\.core must be a plain object, got Map/);
  assertRejected({ persona: new Set([1]) }, /config\.persona must be a plain object, got Set/);
  assertRejected({ spark: "600" }, /config\.spark must be a plain object, got string/);
});

test("R3 regression: Object.create(null) records are accepted, inherited configs are not", () => {
  // null 原型的普通记录对象 + 自有字段：合法
  const config = Object.create(null);
  config.core = { targetChars: 8500 };
  const validated = validateConfig(config);
  assert.equal(validated.core.targetChars, 8500);
  assert.deepEqual(validateConfig(Object.create(null)), DEFAULT_CONFIG);
  // 字段只在原型链上的对象：不是普通记录对象
  const proto = { core: { targetChars: 8500 } };
  assertRejected(Object.create(proto), /config must be a plain object/);
});
