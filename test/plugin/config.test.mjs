// P5-Q config 测试：原生 Schemastery Config 静态结构 / normalizePluginConfig 权威规范化 /
// verifyPluginRoots 真实路径校验（含 link 解析）。全部使用系统 temp 的合成目录，用后清理。

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, sep } from "node:path";
import {
  Config,
  normalizePluginConfig,
  normalizeSemantic,
  verifyPluginRoots,
  defaultDshHome,
  defaultPluginRoots,
  BUDGET_CEILINGS,
  SETTINGS_NAMESPACE,
} from "../../src/plugin/config.mjs";
import { DEFAULT_CONFIG } from "../../src/core/config.mjs";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiori-q-config-"));
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

// 0.4-S1（reviewer P3）：测试入口统一注入 DSH_HOME=临时目录——0.4 起缺省根在
// normalize/verify 里真实解析并 mkdir，不注入的话任何缺省根用例都会在真实
// ~/.dsh 下创建目录。各用例内可用 withDshHome 临时改写并用后恢复。
process.env.DSH_HOME = join(TMP_ROOT, "dsh-home");

// U2 起插件层预算在 core 契约之上多两个权威水位字段（由默认占比 × 默认硬顶派生，
// 见 src/plugin/config.mjs derivedWaterDefaults）。core 的 DEFAULT_CONFIG 本身不含
// 它们——期望值按同一公式推出，不写死常数。
const PLUGIN_DEFAULT_BUDGETS = {
  core: {
    ...DEFAULT_CONFIG.core,
    softChars: Math.round(DEFAULT_CONFIG.core.hardCapChars * DEFAULT_CONFIG.core.softRatio),
    hardChars: Math.round(DEFAULT_CONFIG.core.hardCapChars * DEFAULT_CONFIG.core.hardRatio),
  },
  persona: DEFAULT_CONFIG.persona,
  spark: DEFAULT_CONFIG.spark,
};

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
  assert.deepEqual(parsed.budgets.get(), PLUGIN_DEFAULT_BUDGETS);
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
// normalizePluginConfig：缺省 shadow + 双根落 DSH_HOME 默认（0.4-S1）
// ---------------------------------------------------------------------------

test("缺省配置规范化为 shadow 且双根落 DSH_HOME 默认路径；不修改输入（0.4-S1）", () => {
  const raw = {};
  const settings = normalizePluginConfig(raw);
  assert.equal(settings.mode, "shadow");
  assert.equal(settings.allowActive, false);
  assert.equal(settings.dataRoot, defaultPluginRoots().dataRoot);
  assert.equal(settings.stateRoot, defaultPluginRoots().stateRoot);
  assert.equal(settings.rootsSource.dataRoot, "default");
  assert.equal(settings.rootsSource.stateRoot, "default");
  assert.equal(settings.ownerId, "local");
  assert.equal(settings.defaultPersona, null);
  assert.deepEqual(settings.sessionPersonas, []);
  assert.deepEqual(settings.workspacePersonas, []);
  assert.deepEqual(settings.budgets, PLUGIN_DEFAULT_BUDGETS);
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

test("单根配置合法：缺省根独立落 DSH_HOME 默认（各根互不牵连，0.4-S1）", () => {
  const onlyData = normalizePluginConfig({ dataRoot: join(TMP_ROOT, "d") });
  assert.equal(onlyData.dataRoot, join(TMP_ROOT, "d"));
  assert.equal(onlyData.stateRoot, defaultPluginRoots().stateRoot);
  assert.equal(onlyData.rootsSource.dataRoot, "explicit");
  assert.equal(onlyData.rootsSource.stateRoot, "default");

  const onlyState = normalizePluginConfig({ stateRoot: join(TMP_ROOT, "s") });
  assert.equal(onlyState.dataRoot, defaultPluginRoots().dataRoot);
  assert.equal(onlyState.stateRoot, join(TMP_ROOT, "s"));
  assert.equal(onlyState.rootsSource.dataRoot, "default");
  assert.equal(onlyState.rootsSource.stateRoot, "explicit");
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

test("active 必须 allowActive；双根可缺省走 DSH_HOME 默认（0.4-S1）", () => {
  // allowActive 缺省/false 仍是硬闸（安全取向不变）
  rejects(() => normalizePluginConfig({ mode: "active" }), "active without allowActive");
  rejects(() => normalizePluginConfig({
    mode: "active",
    dataRoot: join(TMP_ROOT, "a"),
    stateRoot: join(TMP_ROOT, "b"),
  }), "active with roots without allowActive");
  // 0.4-S1：active 不再要求显式双根——根缺失走默认（启用按钮只写 mode+allowActive 即可）
  const okDefaulted = normalizePluginConfig({ mode: "active", allowActive: true });
  assert.equal(okDefaulted.mode, "active");
  assert.equal(okDefaulted.dataRoot, defaultPluginRoots().dataRoot);
  assert.equal(okDefaulted.stateRoot, defaultPluginRoots().stateRoot);
  assert.equal(okDefaulted.rootsSource.dataRoot, "default");
  assert.equal(okDefaulted.rootsSource.stateRoot, "default");
  const ok = normalizePluginConfig({
    mode: "active",
    allowActive: true,
    dataRoot: join(TMP_ROOT, "a"),
    stateRoot: join(TMP_ROOT, "b"),
  });
  assert.equal(ok.mode, "active");
  assert.equal(ok.rootsSource.dataRoot, "explicit");
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
  // 0.4-S1：未传 profileRoot 时缺省根落 DSH_HOME 默认路径（不再是 null）
  const noProfile = normalizePluginConfig({});
  assert.equal(noProfile.dataRoot, defaultPluginRoots().dataRoot);
  assert.equal(noProfile.stateRoot, defaultPluginRoots().stateRoot);
  assert.equal(noProfile.rootsSource.dataRoot, "default");
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
  assert.equal(BUDGET_CEILINGS.persona.maxChars, 60000);
  assert.deepEqual(BUDGET_CEILINGS.spark, { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 });

  const atCeiling = normalizePluginConfig({
    budgets: { persona: { maxChars: 60000 }, spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 } },
  });
  assert.equal(atCeiling.budgets.persona.maxChars, 60000);

  // 回归：旧上限 12000 曾把长人设卡用户挡在门外，抬到 60000 后 12000 必须照常通过。
  const legacy = normalizePluginConfig({ budgets: { persona: { maxChars: 12000 } } });
  assert.equal(legacy.budgets.persona.maxChars, 12000, "旧上限值仍被接受");

  rejects(() => normalizePluginConfig({ budgets: { persona: { maxChars: 60001 } } }), "persona over ceiling");
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

test("profileRoot 缺省优先于 DSH_HOME：每个缺省的根单独派生，显式根不受影响（0.4 P4）", () => {
  // 只显式给 dataRoot：stateRoot 用 profileRoot 派生（不再牵连去 DSH_HOME）
  const onlyData = normalizePluginConfig(
    { dataRoot: join(TMP_ROOT, "d") },
    { profileRoot: join(TMP_ROOT, "profile") },
  );
  assert.equal(onlyData.dataRoot, join(TMP_ROOT, "d"));
  assert.equal(onlyData.stateRoot, join(TMP_ROOT, "profile", "shiori-state"));
  assert.equal(onlyData.rootsSource.dataRoot, "explicit");
  assert.equal(onlyData.rootsSource.stateRoot, "default");

  // 对称方向：只显式给 stateRoot，dataRoot 用 profileRoot 派生
  const onlyState = normalizePluginConfig(
    { stateRoot: join(TMP_ROOT, "s") },
    { profileRoot: join(TMP_ROOT, "profile") },
  );
  assert.equal(onlyState.dataRoot, join(TMP_ROOT, "profile", "shiori-data"));
  assert.equal(onlyState.stateRoot, join(TMP_ROOT, "s"));
  assert.equal(onlyState.rootsSource.dataRoot, "default");
  assert.equal(onlyState.rootsSource.stateRoot, "explicit");
});

test("verifyPluginRoots：双根 null 解析默认根并 mkdir（inert 退役）；真实目录解析后不嵌套", () => {
  // 0.4-S1：双根 null 不再 inert——解析默认根（本文件顶部已把 DSH_HOME 指到临时目录）
  // 并真实创建目录
  const defaulted = verifyPluginRoots(normalizePluginConfig({}));
  assert.equal(defaulted.inert, false);
  assert.equal(defaulted.dataRoot, defaultPluginRoots().dataRoot);
  assert.equal(defaulted.stateRoot, defaultPluginRoots().stateRoot);
  assert.equal(existsSync(defaulted.dataRoot), true);
  assert.equal(existsSync(defaulted.stateRoot), true);

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
  rejects(() => normalizePluginConfig({ budgets: volatileRef({ persona: { maxChars: 60001 } }) }), "volatile over ceiling");
  rejects(() => normalizePluginConfig({ budgets: volatileRef({ core: { softRatio: 0.95, hardRatio: 0.9 } }) }), "volatile soft >= hard");
});

test("volatile 回归：普通对象没有 cosmokit 写标记时不按 volatile 解包", () => {
  // 有 get 但缺 Symbol.for("cosmokit.volatile.write") ⇒ 不解包，仍按普通 budgets 校验
  rejects(() => normalizePluginConfig({ budgets: { get: () => DEFAULT_CONFIG } }), "plain object with get");
  // 真正的普通预算对象照旧走原路径
  const plain = normalizePluginConfig({ budgets: { persona: { maxChars: 5000 } } });
  assert.equal(plain.budgets.persona.maxChars, 5000);
});

// ---------------------------------------------------------------------------
// 0.4-S1 · 根路径默认化（装完即用）：defaultDshHome / defaultPluginRoots /
// verifyPluginRoots 的 null → 默认根解析与 apply 阶段 mkdir -p
// ---------------------------------------------------------------------------

/** 在单个用例内临时设置 DSH_HOME，用后恢复（normalize/verify 都在调用期读 env）。 */
function withDshHome(value, fn) {
  const previous = process.env.DSH_HOME;
  try {
    if (value === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = value;
    fn();
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
}

test("defaultDshHome / defaultPluginRoots：DSH_HOME 优先，缺省 ~/.dsh；根并列在主目录下", () => {
  const envHome = join(TMP_ROOT, "dsh-home");
  withDshHome(envHome, () => {
    assert.equal(defaultDshHome(), envHome);
    const roots = defaultPluginRoots();
    assert.equal(roots.dataRoot, join(envHome, "shiori-data"));
    assert.equal(roots.stateRoot, join(envHome, "shiori-state"));
  });
  withDshHome(undefined, () => {
    // 环境变量未设置 → ~/.dsh（纯推导断言，不触发 mkdir，不污染真实主目录）
    assert.equal(defaultDshHome(), join(homedir(), ".dsh"));
    const roots = defaultPluginRoots();
    assert.equal(roots.dataRoot, join(homedir(), ".dsh", "shiori-data"));
    assert.equal(roots.stateRoot, join(homedir(), ".dsh", "shiori-state"));
  });
  // 空字符串环境变量按未设置处理
  withDshHome("", () => {
    assert.equal(defaultDshHome(), join(homedir(), ".dsh"));
  });
});

test("Config schema 文案写明默认落点（DSH_HOME）", () => {
  const text = JSON.stringify(Config);
  assert.ok(text.includes("DSH_HOME"), "dataRoot/stateRoot description must name DSH_HOME");
  assert.ok(text.includes("shiori-data"), "dataRoot description must name the default folder");
  assert.ok(text.includes("shiori-state"), "stateRoot description must name the default folder");
});

test("0.4-S1：显式 dataRoot + stateRoot 缺省 → 只补 stateRoot（各根独立解析互不牵连）", () => {
  withDshHome(join(TMP_ROOT, "dsh-partial"), () => {
    // 正向：只给 dataRoot，stateRoot 落 DSH_HOME 默认
    const dataDir = join(TMP_ROOT, "partial", "data");
    const settings = normalizePluginConfig({ dataRoot: dataDir });
    assert.equal(settings.dataRoot, dataDir, "explicit dataRoot wins");
    assert.equal(settings.stateRoot, join(TMP_ROOT, "dsh-partial", "shiori-state"), "missing stateRoot is defaulted independently");
    // 反向：只给 stateRoot，dataRoot 落 DSH_HOME 默认
    const stateDir = join(TMP_ROOT, "partial", "state");
    const reversed = normalizePluginConfig({ stateRoot: stateDir });
    assert.equal(reversed.stateRoot, stateDir, "explicit stateRoot wins");
    assert.equal(reversed.dataRoot, join(TMP_ROOT, "dsh-partial", "shiori-data"), "missing dataRoot is defaulted independently");
  });
});

test("verifyPluginRoots：双根皆 null → 解析默认根（DSH_HOME 下）并 mkdir -p，不再 inert", () => {
  const envHome = join(TMP_ROOT, "dsh-verify");
  withDshHome(envHome, () => {
    const verified = verifyPluginRoots(normalizePluginConfig({}));
    assert.equal(verified.inert, false, "missing roots must no longer mount inert (0.4-S1)");
    assert.equal(verified.dataRoot, join(envHome, "shiori-data"));
    assert.equal(verified.stateRoot, join(envHome, "shiori-state"));
    // apply 阶段 mkdir -p：目录真实创建
    assert.equal(existsSync(verified.dataRoot), true, "default dataRoot must be created at apply");
    assert.equal(existsSync(verified.stateRoot), true, "default stateRoot must be created at apply");
  });
});

test("verifyPluginRoots：显式配置尚未存在的根目录时 mkdir -p 就绪", () => {
  const dataDir = join(TMP_ROOT, "mkdir-explicit", "data");
  const stateDir = join(TMP_ROOT, "mkdir-explicit", "state");
  assert.equal(existsSync(dataDir), false);
  const verified = verifyPluginRoots(normalizePluginConfig({ dataRoot: dataDir, stateRoot: stateDir }));
  assert.equal(verified.inert, false);
  assert.equal(existsSync(dataDir), true);
  assert.equal(existsSync(stateDir), true);
});

test("verifyPluginRoots：DSH_HOME 为相对路径 → 可读拒绝（不静默落 cwd）", () => {
  withDshHome("relative-dsh-home", () => {
    let threw = null;
    try {
      verifyPluginRoots(normalizePluginConfig({}));
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, "relative DSH_HOME must be rejected");
    assert.equal(threw.code, "INVALID_INPUT");
    assert.match(threw.message, /absolute path/);
  });
});

test("verifyPluginRoots：目录创建失败给出可读诊断（父路径是文件）", () => {
  // 用一个已存在的「文件」当 dataRoot 的父级：mkdir 在其下创建目录必然失败，
  // 且失败发生在嵌套校验之后（不会对合法配置产生误伤）。
  const blocker = join(TMP_ROOT, "mkdir-fail", "blocker");
  mkdirSync(dirname(blocker), { recursive: true });
  writeFileSync(blocker, "not a directory", "utf8");
  const dataRoot = join(blocker, "shiori-data");
  const stateRoot = join(TMP_ROOT, "mkdir-fail", "state");
  let threw = null;
  try {
    verifyPluginRoots(normalizePluginConfig({ dataRoot, stateRoot }));
  } catch (error) {
    threw = error;
  }
  assert.ok(threw, "mkdir under a file path must fail");
  assert.equal(threw.code, "INVALID_INPUT");
  assert.match(threw.message, /cannot create shiori root directories/);
  assert.match(threw.message, /dataRoot=/, "diagnostic names both roots");
});

// 0.4 补丁（账本 #a423c4）：上面部分用例名义上调 verify，实际经 normalize 时
// 就抛了（normalize 恒把 null 根补成默认路径）。verify 本体的两个分支——
// 「双 null 兜底解析默认根」与「兜底里对相对 DSH_HOME 的可读拒绝」——只对
// 直构 / 嵌入方的 settings（未经 normalize）可达，必须直调 verify 才算真单测。

test("verifyPluginRoots 本体：直构 settings 双根 null（未经 normalize）→ 兜底解析默认根并 mkdir", () => {
  // review a1（打回项 4）：verify 返回的 inert 是无条件字面量 false，断言它恒真
  // 无鉴别力——换成「兜底给出的默认根必须是解析真实 link 后的 canonical 绝对
  // 路径」：DSH_HOME 用 junction，若 verify 回填了词法混排形式这条就红。
  const base = join(TMP_ROOT, "verify-direct-defaults");
  const home = join(base, "real-home");
  mkdirSync(home, { recursive: true });
  const link = join(base, "link-home");
  try {
    symlinkSync(home, link, "dir");
  } catch {
    symlinkSync(home, link, "junction");
  }
  withDshHome(link, () => {
    const verified = verifyPluginRoots({ dataRoot: null, stateRoot: null });
    assert.equal(verified.dataRoot, join(home, "shiori-data"), "默认 dataRoot 须解析到真实路径而非 junction 词形");
    assert.equal(verified.stateRoot, join(home, "shiori-state"), "默认 stateRoot 须解析到真实路径而非 junction 词形");
    assert.equal(existsSync(verified.dataRoot), true, "兜底分支同样要 mkdir -p");
    assert.equal(existsSync(verified.stateRoot), true, "兜底分支同样要 mkdir -p");
  });
});

test("verifyPluginRoots 本体：DSH_HOME 为相对路径 → verify 自己的可读拒绝（不经 normalize 直构双 null）", () => {
  // 「verifyPluginRoots：DSH_HOME 为相对路径」一条走 normalize（normalize 的
  // normalizeRoot 先抛）；这里直调 verify，证明 verify 兜底分支里的 normalizeRoot
  // 也拦得住相对默认根，不静默落 cwd。
  withDshHome("relative-dsh-home", () => {
    let threw = null;
    try {
      verifyPluginRoots({ dataRoot: null, stateRoot: null });
    } catch (error) {
      threw = error;
    }
    assert.ok(threw, "verify 本体必须拒绝相对默认根");
    assert.equal(threw.code, "INVALID_INPUT");
    assert.match(threw.message, /absolute path/);
  });
});

// ---------------------------------------------------------------------------
// P0#3（0.4 审查报告）：手动模型目录 semantic.local.cacheDir 的路径校验
// （非空必须绝对路径 + 含 .. 片段一律拒绝；空串保持 <dataRoot>/models 契约）
// ---------------------------------------------------------------------------

test("P0#3 semantic.local.cacheDir：相对路径拒绝、含 .. 片段拒绝；空串与规范绝对路径放行", () => {
  const localWith = (cacheDir) => ({ provider: "local", local: { cacheDir } });
  // 相对路径拒绝（错误口径沿用本模块 fail 的 INVALID_INPUT）。
  assert.throws(() => normalizeSemantic(localWith("hf-cache")), (e) => {
    assert.equal(e.code, "INVALID_INPUT");
    assert.match(e.message, /semantic\.local\.cacheDir/);
    assert.match(e.message, /absolute path/);
    return true;
  }, "相对路径被拒（P0#3）");
  assert.throws(() => normalizeSemantic(localWith(join("models", "cache"))), (e) => {
    assert.equal(e.code, "INVALID_INPUT");
    return true;
  }, "多段相对路径同样被拒");
  // 绝对路径含 .. 片段：命中的是「.. 段」规则本身（fail 消息 must not contain）。
  // 夹具用字符串拼接而非 path.join——join 会把 ".." 折叠掉，构造不出含 .. 的
  // 绝对路径字面。
  for (const bad of [
    join(tmpdir(), "cache") + "/../root",
    join(tmpdir(), "cache") + "\\..\\root",
    join(tmpdir(), "a") + "/../b",
  ]) {
    assert.throws(() => normalizeSemantic(localWith(bad)), (e) => {
      assert.equal(e.code, "INVALID_INPUT");
      assert.match(e.message, /must not contain/);
      return true;
    }, `绝对路径含 .. 片段被拒（P0#3）：${bad}`);
  }
  // 相对路径（即便字符串里含 ..）：先命中的是「绝对路径」规则（fail 消息
  // absolute path）——.. 段规则只对已过绝对路径关的输入生效。
  assert.throws(() => normalizeSemantic(localWith(".." + join("escape", "dir"))), (e) => {
    assert.equal(e.code, "INVALID_INPUT");
    assert.match(e.message, /absolute path/);
    return true;
  }, "相对路径（含 ..）被拒的是绝对路径规则（P0#3）");
  // 空串契约不回归：仍代表「用 <dataRoot>/models」。
  const empty = normalizeSemantic(localWith(""));
  assert.equal(empty.local.cacheDir, "");
  // 规范绝对路径放行，值原样透传（不再做折叠/改写）。
  const abs = join(tmpdir(), "hf-cache");
  const ok = normalizeSemantic(localWith(abs));
  assert.equal(ok.local.cacheDir, abs);
});
