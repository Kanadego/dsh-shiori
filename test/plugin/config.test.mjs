// P5-Q config 测试：原生 Schemastery Config 静态结构 / normalizePluginConfig 权威规范化 /
// verifyPluginRoots 真实路径校验（含 link 解析）。全部使用系统 temp 的合成目录，用后清理。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, sep } from "node:path";
import {
  Config,
  normalizePluginConfig,
  verifyPluginRoots,
  BUDGET_CEILINGS,
  SETTINGS_NAMESPACE,
} from "../../src/plugin/config.mjs";
import { DEFAULT_CONFIG } from "../../src/core/config.mjs";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiori-q-config-"));
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

test.after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

function rejects(fn, message) {
  let code = null;
  try {
    fn();
  } catch (error) {
    code = error.code ?? null;
  }
  assert.ok(code === "INVALID_INPUT", `expected INVALID_INPUT failure${message ? ` (${message})` : ""}`);
}

// ---------------------------------------------------------------------------
// 原生 Config schema dump（静态结构；缺省字段；非法值拒绝）
// ---------------------------------------------------------------------------

test("Config 是原生 Schemastery schema 且可解析缺省输入", () => {
  assert.equal(typeof Config, "function");
  const parsed = Config({});
  assert.equal(parsed.mode, "shadow");
  assert.equal(parsed.allowActive, false);
  assert.equal(parsed.ownerId, "local");
  assert.deepEqual(parsed.sessionPersonas, []);
  assert.deepEqual(parsed.workspacePersonas, []);
  // budgets 打了 .volatile()：宿主把值换成 cosmokit volatile 引用对象，不再直接可读
  // （见 src/plugin/config.mjs unwrapVolatile）。这里断言它是该形状且 get() 给出默认预算。
  assert.equal(typeof parsed.budgets.get, "function");
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.budgets, VOLATILE_WRITE));
  assert.deepEqual(parsed.budgets.get(), DEFAULT_CONFIG);
  assert.equal(parsed.l2.enabled, false);
  assert.equal(parsed.organize.enabled, false);
  assert.equal(parsed.forgetting.enabled, false);
  assert.deepEqual(parsed.forgetting.policy, { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });
  // null-able 字段缺省时被 schema 省略；normalize 权威补 null
  assert.ok(!("dataRoot" in parsed) || parsed.dataRoot === null);
  assert.ok(!("stateRoot" in parsed) || parsed.stateRoot === null);
  assert.ok(!("defaultPersona" in parsed) || parsed.defaultPersona === null);
  assert.equal(SETTINGS_NAMESPACE, "shiori");
});

test("Config schema 序列化为 JSON Schema 形状且接受显式 null 与完整样例", () => {
  const text = JSON.stringify(Config);
  const json = JSON.parse(text); // 序列化无损（refs 图形式）
  assert.ok(json && typeof json.refs === "object", "schema dump carries a refs graph");
  assert.ok(text.includes("\"default\":\"shadow\""), "mode default present in dump");
  assert.ok(text.includes("\"default\":false"), "boolean defaults present in dump");
  const sample = Config({
    mode: "shadow",
    allowActive: true,
    dataRoot: null,
    stateRoot: null,
    defaultPersona: null,
    sessionPersonas: [{ sessionId: "s1", persona: null }],
    workspacePersonas: [{ workspace: "D:/somewhere/ws", persona: "k1" }],
  });
  assert.equal(sample.mode, "shadow");
  assert.equal(sample.dataRoot, null);
  assert.deepEqual(sample.sessionPersonas, [{ sessionId: "s1", persona: null }]);
  assert.deepEqual(sample.workspacePersonas, [{ workspace: "D:/somewhere/ws", persona: "k1" }]);
});

test("Config schema 拒绝非法枚举值", () => {
  assert.throws(() => Config({ mode: "x" }));
  assert.throws(() => Config({ allowActive: "yes" }));
});

// ---------------------------------------------------------------------------
// normalizePluginConfig：缺省 inert shadow
// ---------------------------------------------------------------------------

test("缺省配置规范化为 inert shadow 且不修改输入", () => {
  const raw = {};
  const settings = normalizePluginConfig(raw);
  assert.equal(settings.mode, "shadow");
  assert.equal(settings.allowActive, false);
  assert.equal(settings.dataRoot, null);
  assert.equal(settings.stateRoot, null);
  assert.equal(settings.ownerId, "local");
  assert.equal(settings.defaultPersona, null);
  assert.deepEqual(settings.sessionPersonas, []);
  assert.deepEqual(settings.workspacePersonas, []);
  assert.deepEqual(settings.budgets, DEFAULT_CONFIG);
  assert.equal(settings.l2.enabled, false);
  assert.equal(settings.organize.enabled, false);
  assert.equal(settings.forgetting.enabled, false);
  assert.deepEqual(settings.forgetting.policy, { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });
  assert.deepEqual(raw, {});
  // 冻结：规范化结果不可被调用方篡改
  assert.ok(Object.isFrozen(settings) && Object.isFrozen(settings.budgets));
});

test("undefined / null 输入按缺省处理", () => {
  assert.equal(normalizePluginConfig(undefined).mode, "shadow");
  assert.equal(normalizePluginConfig(null).mode, "shadow");
});

// ---------------------------------------------------------------------------
// 未知键拒绝（顶层 / 段 / 映射条目 / policy）
// ---------------------------------------------------------------------------

test("未知顶层与段内键一律拒绝", () => {
  rejects(() => normalizePluginConfig({ surprise: 1 }), "top-level");
  rejects(() => normalizePluginConfig({ l2: { enabled: false, extra: 1 } }), "l2 extra");
  rejects(() => normalizePluginConfig({ organize: { on: true } }), "organize unknown");
  rejects(() => normalizePluginConfig({ forgetting: { enabled: false, policy: { baseHalfLifeDays: 30, other: 1 } } }), "policy unknown");
  rejects(() => normalizePluginConfig({ sessionPersonas: [{ sessionId: "s", persona: null, x: 1 }] }), "session mapping unknown");
  rejects(() => normalizePluginConfig({ workspacePersonas: [{ workspace: "D:/w", persona: null, x: 1 }] }), "workspace mapping unknown");
});

// ---------------------------------------------------------------------------
// 根目录规则
// ---------------------------------------------------------------------------

test("仅一root配置时必须两者显式提供", () => {
  rejects(() => normalizePluginConfig({ dataRoot: join(TMP_ROOT, "d") }), "data only");
  rejects(() => normalizePluginConfig({ stateRoot: join(TMP_ROOT, "s") }), "state only");
});

test("roots 必须绝对路径且互不嵌套", () => {
  const data = join(TMP_ROOT, "alpha", "data");
  const state = join(TMP_ROOT, "beta", "state");
  const ok = normalizePluginConfig({ dataRoot: data, stateRoot: state });
  assert.equal(ok.dataRoot, data);
  assert.equal(ok.stateRoot, state);

  rejects(() => normalizePluginConfig({ dataRoot: data, stateRoot: join(data, "inner") }), "nested");
  rejects(() => normalizePluginConfig({ dataRoot: data, stateRoot: data }), "equal");
  rejects(() => normalizePluginConfig({ dataRoot: "relative/x", stateRoot: state }), "relative data");
  rejects(() => normalizePluginConfig({ dataRoot: data, stateRoot: "relative/y" }), "relative state");
});

test("active 必须 allowActive 且两根齐全；缺一拒绝", () => {
  rejects(() => normalizePluginConfig({ mode: "active" }), "active without roots");
  rejects(() => normalizePluginConfig({ mode: "active", allowActive: true }), "active allowActive without roots");
  rejects(() => normalizePluginConfig({
    mode: "active",
    dataRoot: join(TMP_ROOT, "a"),
    stateRoot: join(TMP_ROOT, "b"),
  }), "active without allowActive");
  const ok = normalizePluginConfig({
    mode: "active",
    allowActive: true,
    dataRoot: join(TMP_ROOT, "a"),
    stateRoot: join(TMP_ROOT, "b"),
  });
  assert.equal(ok.mode, "active");
  // shadow + 双根允许（已配置即非 inert）
  const shadowRooted = normalizePluginConfig({
    dataRoot: join(TMP_ROOT, "a"),
    stateRoot: join(TMP_ROOT, "b"),
  });
  assert.equal(shadowRooted.mode, "shadow");
});

test("profileRoot 仅在显式传入时计算并列默认根；非法值拒绝", () => {
  const computed = normalizePluginConfig({}, { profileRoot: join(TMP_ROOT, "profile") });
  assert.equal(computed.dataRoot, join(TMP_ROOT, "profile", "shiori-data"));
  assert.equal(computed.stateRoot, join(TMP_ROOT, "profile", "shiori-state"));
  assert.equal(computed.mode, "shadow");
  // 显式 roots 优先于 profileRoot 默认
  const explicit = normalizePluginConfig(
    { dataRoot: join(TMP_ROOT, "a"), stateRoot: join(TMP_ROOT, "b") },
    { profileRoot: join(TMP_ROOT, "profile") },
  );
  assert.equal(explicit.dataRoot, join(TMP_ROOT, "a"));
  rejects(() => normalizePluginConfig({}, { profileRoot: "relative" }), "relative profileRoot");
  // 未传 profileRoot 时不猜测任何根
  assert.equal(normalizePluginConfig({}).dataRoot, null);
});

// ---------------------------------------------------------------------------
// persona 映射
// ---------------------------------------------------------------------------

test("persona 映射校验：sessionId/_workspace 非空、workspace 绝对、persona null 或非空串", () => {
  const ok = normalizePluginConfig({
    sessionPersonas: [
      { sessionId: "s1", persona: "k1" },
      { sessionId: "s2", persona: null },
    ],
    workspacePersonas: [
      { workspace: join(TMP_ROOT, "ws1"), persona: null },
      { workspace: join(TMP_ROOT, "ws2"), persona: "k2" },
    ],
    defaultPersona: "k1",
  });
  assert.equal(ok.sessionPersonas.length, 2);
  assert.equal(ok.workspacePersonas.length, 2);
  assert.equal(ok.defaultPersona, "k1");

  rejects(() => normalizePluginConfig({ sessionPersonas: [{ sessionId: "", persona: null }] }), "empty sessionId");
  rejects(() => normalizePluginConfig({ sessionPersonas: [{ sessionId: "s", persona: 3 }] }), "numeric persona");
  rejects(() => normalizePluginConfig({ workspacePersonas: [{ workspace: "rel", persona: null }] }), "relative workspace");
  rejects(() => normalizePluginConfig({ defaultPersona: "" }), "empty defaultPersona");
  rejects(() => normalizePluginConfig({ ownerId: "" }), "empty ownerId");
});

// ---------------------------------------------------------------------------
// 预算：基线全关系 + Q 安全上限
// ---------------------------------------------------------------------------

test("预算经 validateConfig 全关系校验", () => {
  rejects(() => normalizePluginConfig({ budgets: { core: { targetChars: 0 } } }), "zero target");
  rejects(() => normalizePluginConfig({ budgets: { spark: { inlineMaxChars: 700 } } }), "inline > max");
  rejects(() => normalizePluginConfig({ budgets: { spark: { seedCount: 4, linkCount: 2, maxCards: 5 } } }), "seed+link > maxCards");
  rejects(() => normalizePluginConfig({ budgets: { core: { softRatio: 0.95, hardRatio: 0.9 } } }), "soft >= hard");
  rejects(() => normalizePluginConfig({ budgets: { unknownSection: {} } }), "unknown budget section");

  const lower = normalizePluginConfig({
    budgets: { persona: { maxChars: 4000 }, spark: { maxChars: 300, inlineMaxChars: 60, maxCards: 3, seedCount: 2, linkCount: 1 } },
  });
  assert.equal(lower.budgets.persona.maxChars, 4000);
  assert.equal(lower.budgets.spark.maxCards, 3);
});

test("Q 生产安全上限：超上限拒绝，恰在上限允许", () => {
  assert.equal(BUDGET_CEILINGS.persona.maxChars, 12000);
  assert.deepEqual(BUDGET_CEILINGS.spark, { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 });

  const atCeiling = normalizePluginConfig({
    budgets: { persona: { maxChars: 12000 }, spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 } },
  });
  assert.equal(atCeiling.budgets.persona.maxChars, 12000);

  rejects(() => normalizePluginConfig({ budgets: { persona: { maxChars: 12001 } } }), "persona over ceiling");
  rejects(() => normalizePluginConfig({ budgets: { spark: { maxChars: 601 } } }), "spark maxChars over");
  rejects(() => normalizePluginConfig({ budgets: { spark: { inlineMaxChars: 101 } } }), "spark inline over");
  rejects(() => normalizePluginConfig({ budgets: { spark: { maxCards: 6 } } }), "spark maxCards over");
  rejects(() => normalizePluginConfig({ budgets: { spark: { seedCount: 4 } } }), "spark seedCount over");
  rejects(() => normalizePluginConfig({ budgets: { spark: { linkCount: 3 } } }), "spark linkCount over");
});

// ---------------------------------------------------------------------------
// 忘却 policy
// ---------------------------------------------------------------------------

test("forgetting policy 部分覆盖 + 默认补全；非法值拒绝", () => {
  const partial = normalizePluginConfig({ forgetting: { enabled: true, policy: { baseHalfLifeDays: 45 } } });
  assert.equal(partial.forgetting.enabled, true);
  assert.deepEqual(partial.forgetting.policy, { baseHalfLifeDays: 45, maxHalfLifeDays: 240, archiveScore: 0.25 });

  rejects(() => normalizePluginConfig({ forgetting: { enabled: true, policy: { baseHalfLifeDays: 0 } } }), "base < 1");
  rejects(() => normalizePluginConfig({ forgetting: { enabled: true, policy: { maxHalfLifeDays: 10 } } }), "max < base");
  rejects(() => normalizePluginConfig({ forgetting: { enabled: true, policy: { archiveScore: 1 } } }), "archiveScore >= 1");
  rejects(() => normalizePluginConfig({ forgetting: { enabled: "yes" } }), "enabled not boolean");
});

// ---------------------------------------------------------------------------
// verifyPluginRoots：真实路径（含 link 解析）
// ---------------------------------------------------------------------------

test("verifyPluginRoots：inert 通过；真实目录解析后不嵌套", () => {
  const inert = verifyPluginRoots(normalizePluginConfig({}));
  assert.equal(inert.inert, true);

  const dataDir = join(TMP_ROOT, "vr", "data");
  const stateDir = join(TMP_ROOT, "vr", "state");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const verified = verifyPluginRoots(normalizePluginConfig({ dataRoot: dataDir, stateRoot: stateDir }));
  assert.equal(verified.inert, false);
  assert.ok(verified.dataRoot.endsWith("data"));
  assert.ok(verified.stateRoot.endsWith("state"));
});

test("verifyPluginRoots：不存在的深层路径仍拒绝嵌套", () => {
  const base = join(TMP_ROOT, "deep");
  rejects(() => verifyPluginRoots(normalizePluginConfig({
    dataRoot: join(base, "x", "data"),
    stateRoot: join(base, "x", "data", "state"),
  })), "nested deep non-existent");
});

test("verifyPluginRoots：symlink 解析后嵌套被拒绝（Windows junction 场景之外的目录 symlink 链）", () => {
  const dataReal = join(TMP_ROOT, "linkcase", "real-data");
  const stateDir = join(TMP_ROOT, "linkcase", "outer", "real-data", "state");
  const linkParent = join(TMP_ROOT, "linkcase", "outer-link");
  const linkTarget = join(TMP_ROOT, "linkcase", "outer");
  mkdirSync(dataReal, { recursive: true });
  mkdirSync(join(linkTarget, "real-data"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  let linkType = "junction";
  try {
    symlinkSync(linkTarget, linkParent, "dir");
    linkType = "dir";
  } catch {
    symlinkSync(linkTarget, linkParent, "junction");
  }
  // dataRoot 经由 link 指向 outer/real-data；stateRoot 实际位于其内部 → 解析后嵌套必须拒绝
  const dataViaLink = join(linkParent, "real-data");
  let threw = null;
  try {
    verifyPluginRoots(normalizePluginConfig({ dataRoot: dataViaLink, stateRoot: stateDir }));
  } catch (error) {
    threw = error.code ?? null;
  }
  assert.equal(threw, "INVALID_INPUT", "nested-after-link roots must be rejected");
});

test("verifyPluginRoots：解析后仍不相交的 link 组合通过", () => {
  const a = join(TMP_ROOT, "links-ok", "a-real");
  const b = join(TMP_ROOT, "links-ok", "b-real");
  const la = join(TMP_ROOT, "links-ok", "a-link");
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  try {
    symlinkSync(a, la, "dir");
  } catch {
    symlinkSync(a, la, "junction");
  }
  const verified = verifyPluginRoots(normalizePluginConfig({ dataRoot: la, stateRoot: b }));
  assert.equal(verified.dataRoot, a);
  assert.equal(verified.stateRoot, b);
});

// ---------------------------------------------------------------------------
// R1 回归（owner review r-596f3955）：盘符根 / 混排分隔符 / 尾随分隔符的
// 不相交判定。全部为只读配置校验，不对盘根做任何写入。
// ---------------------------------------------------------------------------

const DRIVE_ROOT = process.platform === "win32" ? parse(TMP_ROOT).root : null;

test("R1 回归：盘符根包含其下目录必须双向拒绝（normalize 阶段）", () => {
  if (!DRIVE_ROOT) return; // 非 Windows 平台无盘符根，用例不适用
  // owner repro 方向 1：dataRoot=盘根，stateRoot 在盘内
  rejects(() => normalizePluginConfig({
    mode: "active", allowActive: true,
    dataRoot: DRIVE_ROOT, stateRoot: TMP_ROOT,
  }), "drive root contains stateRoot");
  // owner repro 方向 2：stateRoot=盘根，dataRoot 在盘内
  rejects(() => normalizePluginConfig({
    mode: "active", allowActive: true,
    dataRoot: TMP_ROOT, stateRoot: DRIVE_ROOT,
  }), "state root contains dataRoot");
  // verifyPluginRoots（apply 阶段）同样必须拒绝
  rejects(() => verifyPluginRoots(normalizePluginConfig({
    dataRoot: DRIVE_ROOT, stateRoot: TMP_ROOT,
  })), "verify drive root contains stateRoot");
});

test("R1 回归：尾随分隔符 / 混排分隔符 / 大小写在比较前统一 canonical 化", () => {
  if (!DRIVE_ROOT) return;
  const plainData = join(TMP_ROOT, "r1sep", "data");
  const plainState = join(TMP_ROOT, "r1sep", "state");
  mkdirSync(plainData, { recursive: true });
  mkdirSync(plainState, { recursive: true });
  try {
    // 尾随分隔符的盘根：D:\（等价 D:/）包含 TMP_ROOT → 拒绝
    rejects(() => normalizePluginConfig({
      dataRoot: DRIVE_ROOT, stateRoot: TMP_ROOT + sep,
    }), "trailing-sep drive root contains tmp");
    // 尾随分隔符的普通目录嵌套 → 拒绝
    rejects(() => normalizePluginConfig({
      dataRoot: plainData + sep, stateRoot: join(plainData, "inner"),
    }), "trailing-sep data contains inner");
    // 混排分隔符：正斜杠形式写法仍识别为嵌套
    rejects(() => normalizePluginConfig({
      dataRoot: plainData.split(sep).join("/"),
      stateRoot: join(plainData, "inner").split(sep).join("/"),
    }), "mixed-separator nested");
    // 不相交 + 尾随分隔符：接受且 settings 中为 canonical 形式（无尾随分隔符）
    const ok = normalizePluginConfig({ dataRoot: plainData + sep, stateRoot: plainState + sep });
    assert.equal(ok.dataRoot, plainData);
    assert.equal(ok.stateRoot, plainState);
  } finally {
    rmSync(join(TMP_ROOT, "r1sep"), { recursive: true, force: true });
  }
});

test("R1 回归：同名前缀目录不相交；verifyPluginRoots 返回解析后的 canonical 根", () => {
  if (!DRIVE_ROOT) return;
  const prefixLike = join(TMP_ROOT, "r1sib", "ai");
  const longer = join(TMP_ROOT, "r1sib", "aiagent");
  mkdirSync(prefixLike, { recursive: true });
  mkdirSync(longer, { recursive: true });
  try {
    // "…\ai" 与 "…\aiagent" 是同前缀字符串但互不嵌套
    const ok = normalizePluginConfig({ dataRoot: prefixLike, stateRoot: longer });
    assert.equal(ok.dataRoot, prefixLike);
    // verify：输入带尾随/混排分隔符，返回解析后的 canonical 绝对路径
    const verified = verifyPluginRoots(normalizePluginConfig({
      dataRoot: prefixLike + sep,
      stateRoot: longer.split(sep).join("/"),
    }));
    assert.equal(verified.dataRoot, prefixLike);
    assert.equal(verified.stateRoot, longer);
  } finally {
    rmSync(join(TMP_ROOT, "r1sib"), { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// volatile 解包：宿主把 budgets 值换成 cosmokit 引用对象（见 unwrapVolatile）
// ---------------------------------------------------------------------------

function volatileRef(value) {
  return { get: () => value, [VOLATILE_WRITE]: () => {} };
}

test("volatile：budgets 引用对象被解包后照常通过权威校验", () => {
  const value = { persona: { maxChars: 4000 }, spark: { maxChars: 300, inlineMaxChars: 60, maxCards: 3, seedCount: 2, linkCount: 1 } };
  const settings = normalizePluginConfig({ budgets: volatileRef(value) });
  assert.equal(settings.budgets.persona.maxChars, 4000);
  assert.equal(settings.budgets.spark.maxCards, 3);
  // core 段未提供的部分仍按默认补齐
  assert.equal(settings.budgets.core.targetChars, DEFAULT_CONFIG.core.targetChars);
  assert.ok(Object.isFrozen(settings.budgets));
});

test("volatile：解包不绕过校验（非法预算仍然拒绝）", () => {
  rejects(() => normalizePluginConfig({ budgets: volatileRef({ persona: { maxChars: 12001 } }) }), "volatile over ceiling");
  rejects(() => normalizePluginConfig({ budgets: volatileRef({ core: { softRatio: 0.95, hardRatio: 0.9 } }) }), "volatile soft >= hard");
});

test("volatile 回归：普通对象没有 cosmokit 写标记时不按 volatile 解包", () => {
  // 有 get 但缺 Symbol.for("cosmokit.volatile.write") ⇒ 不解包，仍按普通 budgets 校验
  rejects(() => normalizePluginConfig({ budgets: { get: () => DEFAULT_CONFIG } }), "plain object with get");
  // 真正的普通预算对象照旧走原路径
  const plain = normalizePluginConfig({ budgets: { persona: { maxChars: 5000 } } });
  assert.equal(plain.budgets.persona.maxChars, 5000);
});
