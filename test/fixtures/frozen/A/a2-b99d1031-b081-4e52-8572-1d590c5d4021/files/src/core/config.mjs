// Shiori P0-CORE · 配置默认值与整体校验（公共契约导出 DEFAULT_CONFIG / validateConfig）。
// 依据 DESIGN §5.1.1：softAt=floor(hardCapChars×softRatio)、hardAt=floor(hardCapChars×hardRatio)，
// 配置整体必须满足 0<softRatio<hardRatio<1、softAt≤targetChars<hardAt<hardCapChars；
// 字符与卡片数量为正整数（linkCount 可为 0）；inlineMaxChars≤maxChars；seedCount+linkCount≤maxCards。
// 校验通过返回全新冻结的完整配置，不修改输入；非法组合整体抛 INVALID_INPUT，不部分提交。

import { fail, describe, isPlainRecord } from "./errors.mjs";

export const DEFAULT_CONFIG = deepFreeze({
  core: {
    targetChars: 8000,
    hardCapChars: 10000,
    softRatio: 0.75,
    hardRatio: 0.90,
    cacheLockFallback: false,
  },
  persona: {
    maxChars: 12000,
  },
  spark: {
    maxChars: 600,
    inlineMaxChars: 100,
    maxCards: 5,
    seedCount: 3,
    linkCount: 2,
  },
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return Object.freeze(value);
}

// 读取一个配置段：缺省时返回默认段副本；存在时必须为普通对象且无未知属性
//（防拼写错误，未知属性一律拒绝而不是静默忽略）。
function section(config, name, defaults) {
  const value = config[name];
  if (value === undefined) return { ...defaults };
  if (!isPlainRecord(value)) {
    fail("INVALID_INPUT", `config.${name} must be a plain object, got ${describe(value)}`);
  }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(defaults, key)) {
      fail("INVALID_INPUT", `config.${name} has unknown property "${key}"`);
    }
  }
  return { ...defaults, ...value };
}

function positiveInteger(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail("INVALID_INPUT", `${name} must be a positive integer, got ${String(value)}`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail("INVALID_INPUT", `${name} must be a non-negative integer, got ${String(value)}`);
  }
  return value;
}

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_INPUT", `${name} must be a finite number, got ${String(value)}`);
  }
  return value;
}

export function validateConfig(config) {
  if (!isPlainRecord(config)) {
    fail("INVALID_INPUT", `config must be a plain object, got ${describe(config)}`);
  }
  for (const key of Object.keys(config)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) {
      fail("INVALID_INPUT", `config has unknown top-level property "${key}"`);
    }
  }
  const core = section(config, "core", DEFAULT_CONFIG.core);
  const persona = section(config, "persona", DEFAULT_CONFIG.persona);
  const spark = section(config, "spark", DEFAULT_CONFIG.spark);

  const targetChars = positiveInteger(core.targetChars, "core.targetChars");
  const hardCapChars = positiveInteger(core.hardCapChars, "core.hardCapChars");
  const softRatio = finiteNumber(core.softRatio, "core.softRatio");
  const hardRatio = finiteNumber(core.hardRatio, "core.hardRatio");
  if (softRatio <= 0) fail("INVALID_INPUT", `core.softRatio must be > 0, got ${softRatio}`);
  if (hardRatio >= 1) fail("INVALID_INPUT", `core.hardRatio must be < 1, got ${hardRatio}`);
  if (softRatio >= hardRatio) {
    fail("INVALID_INPUT", `core.softRatio (${softRatio}) must be < core.hardRatio (${hardRatio})`);
  }
  if (typeof core.cacheLockFallback !== "boolean") {
    fail("INVALID_INPUT", `core.cacheLockFallback must be a boolean, got ${describe(core.cacheLockFallback)}`);
  }

  const personaMaxChars = positiveInteger(persona.maxChars, "persona.maxChars");

  const sparkMaxChars = positiveInteger(spark.maxChars, "spark.maxChars");
  const inlineMaxChars = positiveInteger(spark.inlineMaxChars, "spark.inlineMaxChars");
  const maxCards = positiveInteger(spark.maxCards, "spark.maxCards");
  const seedCount = positiveInteger(spark.seedCount, "spark.seedCount");
  const linkCount = nonNegativeInteger(spark.linkCount, "spark.linkCount");
  if (inlineMaxChars > sparkMaxChars) {
    fail("INVALID_INPUT", `spark.inlineMaxChars (${inlineMaxChars}) must be <= spark.maxChars (${sparkMaxChars})`);
  }
  if (seedCount + linkCount > maxCards) {
    fail("INVALID_INPUT", `spark.seedCount + spark.linkCount (${seedCount + linkCount}) must be <= spark.maxCards (${maxCards})`);
  }

  const softAt = Math.floor(hardCapChars * softRatio);
  const hardAt = Math.floor(hardCapChars * hardRatio);
  if (softAt > targetChars) {
    fail("INVALID_INPUT", `derived softAt (${softAt}) must be <= core.targetChars (${targetChars})`);
  }
  if (targetChars >= hardAt) {
    fail("INVALID_INPUT", `core.targetChars (${targetChars}) must be < derived hardAt (${hardAt})`);
  }
  if (hardAt >= hardCapChars) {
    fail("INVALID_INPUT", `derived hardAt (${hardAt}) must be < core.hardCapChars (${hardCapChars})`);
  }

  return deepFreeze({
    core: { targetChars, hardCapChars, softRatio, hardRatio, cacheLockFallback: core.cacheLockFallback },
    persona: { maxChars: personaMaxChars },
    spark: { maxChars: sparkMaxChars, inlineMaxChars, maxCards, seedCount, linkCount },
  });
}
