// 0.2 U2 产出 4 —— 预算水位契约与 semantic 接口预留的专项测试：
//   1) 默认 softChars/hardChars 由 DEFAULT_CONFIG 占比 × hardCapChars 四舍五入派生
//   2) 老配置只有 ratio 时按 hardCapChars × ratio 换算成水位，不报错
//   3) softChars > hardChars 被拒（中文错误）
//   4) targetChars 仍可读（保留 schema、老配置不报错，且只做区间校验）
//   5) semantic 段默认值正确（provider=none，字段名冻结）
// 纯配置层测试：不触文件系统、不依赖宿主。

import { test } from "node:test";
import assert from "node:assert/strict";
import { Config, normalizePluginConfig } from "../../src/plugin/config.mjs";
import { DEFAULT_CONFIG } from "../../src/core/config.mjs";

function rejects(fn, message) {
  let code = null;
  let text = null;
  try {
    fn();
  } catch (error) {
    code = error.code ?? null;
    text = String(error.message ?? "");
  }
  assert.ok(code === "INVALID_INPUT", `expected INVALID_INPUT failure${message ? ` (${message})` : ""}, got code=${code} message=${text}`);
  return text;
}

// ── 1) 默认水位派生 ─────────────────────────────────────────────────────────

test("缺省配置的水位默认值按 DEFAULT_CONFIG 占比 × hardCapChars 四舍五入派生", () => {
  const settings = normalizePluginConfig({});
  const core = settings.budgets.core;
  assert.equal(core.softChars, Math.round(DEFAULT_CONFIG.core.hardCapChars * DEFAULT_CONFIG.core.softRatio));
  assert.equal(core.hardChars, Math.round(DEFAULT_CONFIG.core.hardCapChars * DEFAULT_CONFIG.core.hardRatio));
  // 默认值具体形状：10000 × 0.75 / 0.90 → 7500 / 9000（不是写死的另一个数）。
  assert.equal(core.softChars, 7500);
  assert.equal(core.hardChars, 9000);
  // 输出里 ratio 与水位同源（由水位回推），运行时 softAt/hardAt 不得与水位分叉。
  assert.equal(core.softRatio, core.softChars / core.hardCapChars);
  assert.equal(core.hardRatio, core.hardChars / core.hardCapChars);
});

test("水位默认值随 hardCapChars 变化派生，而不是全局常数", () => {
  // 默认 targetChars=8000 与更大的硬顶组合会触发区间校验（softChars ≤ targetChars），
  // 因此同时抬 targetChars 到区间内：10500 ≤ 12000 < 12600。
  const settings = normalizePluginConfig({ budgets: { core: { hardCapChars: 14000, targetChars: 12000 } } });
  const core = settings.budgets.core;
  assert.equal(core.softChars, Math.round(14000 * DEFAULT_CONFIG.core.softRatio));
  assert.equal(core.hardChars, Math.round(14000 * DEFAULT_CONFIG.core.hardRatio));
  assert.equal(core.softChars, 10500);
  assert.equal(core.hardChars, 12600);
});

test("Schemastery schema 的缺省 budgets 同样携带派生水位", () => {
  const parsed = Config({});
  const core = parsed.budgets.get().core;
  assert.equal(core.softChars, Math.round(DEFAULT_CONFIG.core.hardCapChars * DEFAULT_CONFIG.core.softRatio));
  assert.equal(core.hardChars, Math.round(DEFAULT_CONFIG.core.hardCapChars * DEFAULT_CONFIG.core.hardRatio));
});

// ── 2) 老配置只有 ratio：换算成水位，不报错 ─────────────────────────────────

test("老配置只有 ratio 时按 hardCapChars × ratio 换算成水位且不报错", () => {
  const legacy = normalizePluginConfig({
    budgets: { core: { targetChars: 10000, hardCapChars: 14000, softRatio: 0.7, hardRatio: 0.9 } },
  });
  const core = legacy.budgets.core;
  assert.equal(core.softChars, Math.round(14000 * 0.7));
  assert.equal(core.hardChars, Math.round(14000 * 0.9));
  assert.equal(core.softChars, 9800);
  assert.equal(core.hardChars, 12600);
  // ratio 保留在输出里且与换算后的水位一致（同源回推）。
  assert.equal(core.softRatio, 0.7);
  assert.equal(core.hardRatio, 0.9);
  assert.equal(core.targetChars, 10000, "老配置的 targetChars 原样保留");
});

test("水位与 ratio 同时提供时水位优先（ratio 由水位回推，不信任旧 ratio）", () => {
  const both = normalizePluginConfig({
    budgets: { core: { hardCapChars: 10000, softRatio: 0.5, hardRatio: 0.6, softChars: 7500, hardChars: 9000 } },
  });
  const core = both.budgets.core;
  assert.equal(core.softChars, 7500);
  assert.equal(core.hardChars, 9000);
  assert.equal(core.softRatio, 0.75, "输出 ratio 由权威水位回推，旧 ratio 不再有效");
  assert.equal(core.hardRatio, 0.9);
});

// ── 3) 越界拒绝（中文错误） ─────────────────────────────────────────────────

test("softChars > hardChars 被拒且报中文错误", () => {
  const text = rejects(
    () => normalizePluginConfig({ budgets: { core: { softChars: 9000, hardChars: 8000 } } }),
    "soft > hard",
  );
  assert.ok(text.includes("软水位") && text.includes("硬水位"), `中文提示应点名软/硬水位: ${text}`);
  assert.match(text, /9000/);
  assert.match(text, /8000/);
});

test("hardChars ≥ hardCapChars 被拒且报中文错误", () => {
  const over = rejects(
    () => normalizePluginConfig({ budgets: { core: { hardCapChars: 10000, hardChars: 11000, softChars: 5000 } } }),
    "hard > cap",
  );
  assert.ok(over.includes("硬顶"), `中文提示应点名硬顶: ${over}`);
  // 硬闸之上要保留超限判定空间：等于硬顶同样不可表达（core 校验要求 hardAt < hardCapChars）。
  const equal = rejects(
    () => normalizePluginConfig({ budgets: { core: { hardCapChars: 10000, hardChars: 10000, softChars: 5000 } } }),
    "hard == cap",
  );
  assert.ok(equal.includes("必须小于硬顶"), `等于硬顶也按越界处理并中文说明: ${equal}`);
});

test("软水位 0 / 硬水位 1 被拒（面板 schema 允许，但 core 换算后必然加载失败）", () => {
  const zero = rejects(
    () => normalizePluginConfig({ budgets: { core: { softChars: 0 } } }),
    "softChars = 0",
  );
  assert.ok(zero.includes("至少为 1"), `0 必须在归一化拦截并中文说明: ${zero}`);
  const tiny = rejects(
    () => normalizePluginConfig({ budgets: { core: { hardCapChars: 3, hardChars: 1, softChars: 1 } } }),
    "hardChars = 1",
  );
  assert.ok(tiny.includes("硬水位"), `硬水位过小必须中文拒绝: ${tiny}`);
});

test("softChars == hardChars 被拒（core 要求严格小于，等值回推成同比例必失败）", () => {
  const text = rejects(
    () => normalizePluginConfig({ budgets: { core: { hardCapChars: 10000, softChars: 8000, hardChars: 8000 } } }),
    "soft == hard",
  );
  assert.ok(text.includes("必须小于"), `等值也要拒并中文说明严格小于: ${text}`);
  // targetChars 缺省时必须仍能被这条规则拦下（不被「软 > 目标」抢先）。
  const noTarget = rejects(
    () => normalizePluginConfig({ budgets: { core: { hardCapChars: 10000, softChars: 6000, hardChars: 6000, targetChars: undefined } } }),
    "soft == hard, no target",
  );
  assert.ok(noTarget.includes("必须小于"), `无目标长度时同样拦截: ${noTarget}`);
});

test("水位字段必须是非负整数（自然数），负数与小数被中文拒绝", () => {
  rejects(() => normalizePluginConfig({ budgets: { core: { softChars: -1 } } }), "negative softChars");
  rejects(() => normalizePluginConfig({ budgets: { core: { softChars: 7500.5 } } }), "fractional softChars");
  rejects(() => normalizePluginConfig({ budgets: { core: { hardChars: -3 } } }), "negative hardChars");
  rejects(() => normalizePluginConfig({ budgets: { core: { hardChars: 9000.25 } } }), "fractional hardChars");
});

// ── 4) targetChars 仍可读：保留 schema、老配置不报错、只做区间校验 ──────────

test("targetChars 仍可读：老配置原样保留，区间校验继续生效", () => {
  const kept = normalizePluginConfig({
    budgets: { core: { targetChars: 8000, hardCapChars: 10000, softChars: 7500, hardChars: 9000 } },
  });
  assert.equal(kept.budgets.core.targetChars, 8000);
  // 区间校验（D3：softChars ≤ targetChars < hardChars）：硬水位压到目标长度之下被拒。
  rejects(
    () => normalizePluginConfig({ budgets: { core: { targetChars: 8000, hardCapChars: 10000, softChars: 7000, hardChars: 7800 } } }),
    "targetChars >= hardChars",
  );
});

test("面板把硬顶压到原 targetChars 以下：收敛后的三元组能过归一化（P1 联动）", () => {
  // 面板侧 clampCoreWater 的产物：cap 5000 → 硬 4999 → 软 4998 → target 4998。
  const ok = normalizePluginConfig({
    budgets: { core: { targetChars: 4998, hardCapChars: 5000, softChars: 4998, hardChars: 4999 } },
  });
  const core = ok.budgets.core;
  assert.equal(core.hardCapChars, 5000);
  assert.equal(core.softChars, 4998);
  assert.equal(core.hardChars, 4999);
  assert.equal(core.targetChars, 4998);
  // 反过来：如果面板不收敛（targetChars 仍是出厂 8000），同样的硬顶下调会被拒——
  // 这正是「隐藏字段当硬约束」的现场，收敛必须发生在前端草稿里，而不是靠用户手改。
  rejects(
    () => normalizePluginConfig({ budgets: { core: { targetChars: 8000, hardCapChars: 5000, softChars: 4998, hardChars: 4999 } } }),
    "unclamped targetChars",
  );
});

// ── 5) semantic 段：默认值正确，字段名冻结 ──────────────────────────────────

test("semantic 段默认值正确（provider=none，零依赖零网络）", () => {
  const settings = normalizePluginConfig({});
  assert.deepEqual(settings.semantic, {
    provider: "none",
    local: { model: "bge-small-zh-v1.5", dims: 512 },
    api: { endpoint: null, keyRef: null },
  });
  assert.ok(Object.isFrozen(settings.semantic));
  // Schemastery schema 缺省同样给出该形状（宿主 settings UI 依赖它）。
  const parsed = Config({});
  assert.equal(parsed.semantic.provider, "none");
  assert.equal(parsed.semantic.local.model, "bge-small-zh-v1.5");
  assert.equal(parsed.semantic.local.dims, 512);
  assert.equal(parsed.semantic.api.endpoint, null);
  assert.equal(parsed.semantic.api.keyRef, null);
});

test("semantic 段：合法值通过、未知键与非法 provider 拒绝", () => {
  const local = normalizePluginConfig({ semantic: { provider: "local", local: { dims: 768 } } });
  assert.deepEqual(local.semantic, {
    provider: "local",
    local: { model: "bge-small-zh-v1.5", dims: 768 },
    api: { endpoint: null, keyRef: null },
  });
  const api = normalizePluginConfig({ semantic: { provider: "api", api: { endpoint: "https://example.invalid/embed", keyRef: "env:EMBED_KEY" } } });
  assert.deepEqual(api.semantic.api, { endpoint: "https://example.invalid/embed", keyRef: "env:EMBED_KEY" });
  rejects(() => normalizePluginConfig({ semantic: { provider: "bogus" } }), "bad provider");
  rejects(() => normalizePluginConfig({ semantic: { unknownKey: 1 } }), "unknown top key");
  rejects(() => normalizePluginConfig({ semantic: { local: { unknownKey: 1 } } }), "unknown local key");
  rejects(() => normalizePluginConfig({ semantic: { api: { unknownKey: 1 } } }), "unknown api key");
  rejects(() => normalizePluginConfig({ semantic: { local: { dims: 0.5 } } }), "dims must be natural");
  rejects(() => normalizePluginConfig({ semantic: { local: { model: "" } } }), "model must be non-empty");
  rejects(() => normalizePluginConfig({ semantic: { api: { endpoint: "" } } }), "endpoint must be string or null");
});
