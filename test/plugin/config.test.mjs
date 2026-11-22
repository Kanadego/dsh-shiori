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
  comparableRoot,
  BUDGET_CEILINGS,
  SETTINGS_NAMESPACE,
} from "../../src/plugin/config.mjs";
import { comparableRoot as comparableRootFromCanon } from "../../src/storage/path-canon.mjs";
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

// Config() 输出的 volatile 字段是 cosmokit 引用对象（宿主写入通道的要求），
// 断言默认值时按 ref.get() 取值；普通值原样返回。
function configValue(value) {
  return value !== null && typeof value === "object"
    && typeof value.get === "function"
    && VOLATILE_WRITE in value
    ? value.get()
    : value;
}

// ---------------------------------------------------------------------------
// 原生 Config schema dump（静态结构；缺省字段；非法值拒绝）
// ---------------------------------------------------------------------------

test("Config 是原生 Schemastery schema 且可解析缺省输入", () => {
  assert.equal(typeof Config, "function");
  const parsed = Config({});
  // 0.4-S1 起 mode / allowActive / defaultPersona 同 budgets 打 volatile：
  // 宿主把它们替换成 cosmokit 引用对象（见 configValue），缺省值经 get() 读出。
  assert.equal(configValue(parsed.mode), "shadow");
  assert.equal(configValue(parsed.allowActive), false);
  assert.equal(parsed.ownerId, "local");
  // 0.4 面板热写起 sessionPersonas / workspacePersonas 同 budgets 打 volatile，
  // 缺省值同样经引用对象读出（见 configValue）。
  assert.deepEqual(configValue(parsed.sessionPersonas), []);
  assert.deepEqual(configValue(parsed.workspacePersonas), []);
  // budgets 打了 .volatile()：宿主把值换成 cosmokit volatile 引用对象，不再直接可读
  // （见 src/plugin/config.mjs unwrapVolatile）。这里断言它是该形状且 get() 给出默认预算。
  assert.equal(typeof parsed.budgets.get, "function");
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.budgets, VOLATILE_WRITE));
  assert.deepEqual(parsed.budgets.get(), PLUGIN_DEFAULT_BUDGETS);
  assert.equal(parsed.l2.enabled, false);
  assert.equal(parsed.organize.enabled, false);
  // 0.5 批次 13 起 forgetting 整块打了 .volatile()：宿主把值换成 cosmokit 引用对象
  // （同 budgets，经 configValue 解包），判据不变。
  const forgettingDefault = configValue(parsed.forgetting);
  assert.equal(forgettingDefault.enabled, false);
  assert.deepEqual(forgettingDefault.policy, { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });
  // null-able 字段缺省时被 schema 省略；normalize 权威补 null。
  // defaultPersona 打了 volatile 后，schemastery 的可空缺省路径会把它包成
  // get()===undefined 的引用（显式 null 才得到 null），normalize 两种都归一成 null。
  assert.ok(!("dataRoot" in parsed) || parsed.dataRoot === null);
  assert.ok(!("stateRoot" in parsed) || parsed.stateRoot === null);
  assert.ok(!("defaultPersona" in parsed)
    || configValue(parsed.defaultPersona) === null
    || configValue(parsed.defaultPersona) === undefined);
  assert.equal(normalizePluginConfig({ defaultPersona: parsed.defaultPersona }).defaultPersona, null);
  assert.equal(SETTINGS_NAMESPACE, "shiori");
});

test("Config schema：mode / allowActive / defaultPersona 标记为 volatile（宿主 settings 允许写入）", () => {
  // 真机缺陷：settings 写入通道只放行 volatile 字段，未标记的三个字段被拒
  // （dsh-settings write(): Config field "mode" is not volatile）。
  for (const field of ["mode", "allowActive", "defaultPersona"]) {
    assert.equal(Config.dict[field].meta.volatile, true, `${field} 的 schema meta 必须带 volatile`);
  }
  // schema 解析后同样给出带写标记的引用对象（宿主依据它收集可写字段）。
  const parsed = Config({ mode: "active", allowActive: true, defaultPersona: "amber" });
  for (const field of ["mode", "allowActive", "defaultPersona"]) {
    const value = parsed[field];
    assert.equal(typeof value.get, "function", `${field} 应被替换成 cosmokit 引用对象`);
    assert.ok(VOLATILE_WRITE in value, `${field} 引用对象应带 cosmokit.volatile.write 标记`);
  }
  assert.equal(parsed.mode.get(), "active");
  assert.equal(parsed.allowActive.get(), true);
  assert.equal(parsed.defaultPersona.get(), "amber");
});

// 宿主 dsh-settings write() 的放行判据（lib/index.js isVolatilePath）：schema.meta.volatile
// 命中即放行，否则沿 dict 下钻剩余路径——最近的 volatile 祖先覆盖整棵子树。这里照抄判据，
// 直接断言面板三处写入路径都能通过宿主校验。
function isVolatilePath(schema, path) {
  if (schema.meta.volatile) return true;
  const [key, ...rest] = path;
  const child = key === undefined ? undefined : schema.dict?.[key];
  return child !== undefined && isVolatilePath(child, rest);
}

test("Config schema：sessionPersonas / workspacePersonas / semantic 标记为 volatile（面板热写路径放行）", () => {
  // 真机缺陷：面板三处写入被宿主拒绝——dsh-settings write():
  // Config field "sessionPersonas" is not volatile（workspacePersonas 同款）。
  // 「保存模型目录」写 semantic.local.cacheDir 时，宿主 validatePaths 遍历的是合并后
  // 的整个 semantic 对象（provider/model/dims 都在里面），叶子单独标 volatile 仍会被
  // "Config field semantic.provider is not volatile" 挡下，所以 semantic 整块标记。
  for (const path of [["sessionPersonas"], ["workspacePersonas"], ["semantic", "local", "cacheDir"]]) {
    assert.equal(isVolatilePath(Config, path), true, `写入路径 ${path.join(".")} 必须命中 volatile`);
  }
  assert.equal(Config.dict.sessionPersonas.meta.volatile, true);
  assert.equal(Config.dict.workspacePersonas.meta.volatile, true);
  assert.equal(Config.dict.semantic.meta.volatile, true);
  // 落盘根仍不可热写：这两个字段改了要重新装配才有意义。
  assert.equal(isVolatilePath(Config, ["dataRoot"]), false);
  assert.equal(isVolatilePath(Config, ["stateRoot"]), false);
});

// 宿主 dsh-settings write() 的拒绝文案原型：非 volatile 路径直接报
// `Config field "<path>" is not volatile`（code=settings/rejected）。复刻拒绝行为，
// 断言面板三档切换写 forgetting 时不会被它挡下——去掉 .volatile() 即变红（回归钉）。
function hostRejectIfNotVolatile(schema, path) {
  if (isVolatilePath(schema, path)) return;
  const error = new Error(`Config field "${path.join(".")}" is not volatile`);
  error.code = "settings/rejected";
  throw error;
}

test("0.5 批次 13：forgetting 整块 volatile（schema meta + 引用对象 + 宿主放行判据三层）", () => {
  // 真机缺陷：面板顶部「建议 / 自动 / 关闭」三档切换写 forgetting.autoMode 被宿主拒
  // —— settings/rejected  Config field "forgetting.autoMode" is not volatile。
  // 与 semantic / temperature 同款：叶子单独标只覆盖该叶子；写 enabled / policy
  // 或用宿主插件配置页整块编辑时会被挡，故整块标记。
  const writePaths = [
    ["forgetting"],
    ["forgetting", "autoMode"],
    ["forgetting", "policy", "baseHalfLifeDays"],
  ];
  // 第一层：schema meta 整块标记为 volatile。
  assert.equal(Config.dict.forgetting.meta.volatile, true, "forgetting 的 schema meta 必须带 volatile");
  // 第二层：解析后给出带 cosmokit.volatile.write 标记的引用对象。
  const parsed = Config({});
  const ref = parsed.forgetting;
  assert.equal(typeof ref.get, "function", "forgetting 应被替换成 cosmokit 引用对象");
  assert.ok(VOLATILE_WRITE in ref, "forgetting 引用对象应带 cosmokit.volatile.write 标记");
  assert.deepEqual(configValue(ref), { enabled: false, autoMode: "suggest", policy: { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 } });
  // 第三层：宿主放行判据命中 + 复刻 write() 三路径都不抛「is not volatile」。
  for (const path of writePaths) {
    assert.equal(isVolatilePath(Config, path), true, `写入路径 ${path.join(".")} 必须命中 volatile`);
    assert.doesNotThrow(() => hostRejectIfNotVolatile(Config, path), `宿主不应拒绝 ${path.join(".")}`);
  }
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
  assert.equal(configValue(sample.mode), "shadow");
  assert.equal(sample.dataRoot, null);
  assert.deepEqual(configValue(sample.sessionPersonas), [{ sessionId: "s1", persona: null }]);
  assert.deepEqual(configValue(sample.workspacePersonas), [{ workspace: "D:/somewhere/ws", persona: "k1" }]);
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

test("volatile：mode / allowActive / defaultPersona 引用对象被解包成普通值", () => {
  // 宿主把三个 volatile 字段换成 cosmokit 引用对象交给插件（与 budgets 同款）。
  const settings = normalizePluginConfig({
    mode: volatileRef("active"),
    allowActive: volatileRef(true),
    defaultPersona: volatileRef("amber"),
  });
  // 解包结果是普通 string / boolean，不是引用对象——下游 scope.mjs / controller.mjs
  // / management.mjs 直接做 === 比较，拿到引用对象会全部误判。
  assert.equal(settings.mode, "active");
  assert.equal(typeof settings.mode, "string");
  assert.equal(settings.allowActive, true);
  assert.equal(typeof settings.allowActive, "boolean");
  assert.equal(settings.defaultPersona, "amber");
  assert.equal(typeof settings.defaultPersona, "string");
  assert.ok(Object.isFrozen(settings));

  // 缺省路径同样解包：defaultPersona 的引用对象包着 null 时输出 null。
  const defaults = normalizePluginConfig({
    mode: volatileRef("shadow"),
    allowActive: volatileRef(false),
    defaultPersona: volatileRef(null),
  });
  assert.equal(defaults.mode, "shadow");
  assert.equal(defaults.allowActive, false);
  assert.equal(defaults.defaultPersona, null);
});

test("volatile：宿主形态（Config 解析产物整包喂给 normalize）解包后不漏引用对象", () => {
  // 真机装配路径：宿主用 Config 解析后把带 cosmokit 引用的配置直接交给 apply，
  // apply 第一步 normalize 必须把三个字段与 budgets 全部解包成普通值，下游
  // scope.mjs / controller.mjs / management.mjs 的 === 比较才不会误判。
  const fromHost = Config({
    mode: "active",
    allowActive: true,
    defaultPersona: "amber",
    sessionPersonas: [{ sessionId: "s1", persona: "amber" }],
    workspacePersonas: [{ workspace: join(TMP_ROOT, "ws-host"), persona: null }],
  });
  const settings = normalizePluginConfig(fromHost);
  assert.equal(settings.mode, "active");
  assert.equal(settings.allowActive, true);
  assert.equal(settings.defaultPersona, "amber");
  assert.equal(typeof settings.mode, "string");
  assert.equal(typeof settings.allowActive, "boolean");
  assert.equal(typeof settings.defaultPersona, "string");
  // budgets 在宿主侧同样是引用对象，解包后是普通冻结对象。
  assert.equal(typeof settings.budgets.get, "undefined");
  assert.ok(Object.isFrozen(settings.budgets));
  // 面板热写三路同理：映射是普通数组、cacheDir 是普通字符串（缺省值也解包）。
  assert.ok(Array.isArray(settings.sessionPersonas));
  assert.deepEqual(settings.sessionPersonas, [{ sessionId: "s1", persona: "amber" }]);
  assert.ok(Array.isArray(settings.workspacePersonas));
  assert.deepEqual(settings.workspacePersonas, [{ workspace: join(TMP_ROOT, "ws-host"), persona: null }]);
  assert.equal(typeof settings.semantic.local.cacheDir, "string");
  assert.equal(settings.semantic.local.cacheDir, "");
});

test("volatile：sessionPersonas / workspacePersonas 引用对象被解包成普通数组", () => {
  const ws = join(TMP_ROOT, "ws-hot");
  const settings = normalizePluginConfig({
    sessionPersonas: volatileRef([{ sessionId: "s-hot", persona: "amber" }]),
    workspacePersonas: volatileRef([{ workspace: ws, persona: "amber" }]),
  });
  // 下游 scope.mjs validateControllerSettings 与 controller.mjs 直接遍历数组、
  // 读元素属性；拿到引用对象会 TypeError，所以这里断言普通数组与元素形状。
  assert.ok(Array.isArray(settings.sessionPersonas));
  assert.deepEqual(settings.sessionPersonas, [{ sessionId: "s-hot", persona: "amber" }]);
  assert.ok(Array.isArray(settings.workspacePersonas));
  assert.deepEqual(settings.workspacePersonas, [{ workspace: ws, persona: "amber" }]);
  assert.equal(typeof settings.sessionPersonas.get, "undefined");
  // 空数组与普通数组输入照旧（解包分支不改变既有语义）。
  const empty = normalizePluginConfig({ sessionPersonas: volatileRef([]), workspacePersonas: volatileRef([]) });
  assert.deepEqual(empty.sessionPersonas, []);
  assert.deepEqual(empty.workspacePersonas, []);
  const plain = normalizePluginConfig({
    sessionPersonas: [{ sessionId: "s-plain", persona: null }],
    workspacePersonas: [{ workspace: ws, persona: null }],
  });
  assert.deepEqual(plain.sessionPersonas, [{ sessionId: "s-plain", persona: null }]);
  assert.deepEqual(plain.workspacePersonas, [{ workspace: ws, persona: null }]);
});

test("volatile：semantic.local.cacheDir 引用对象被解包成普通字符串", () => {
  const dir = join(TMP_ROOT, "models-hot");
  const settings = normalizePluginConfig({
    semantic: { provider: "local", local: { cacheDir: volatileRef(dir) } },
  });
  // controller.semanticProviderConfig() 对 cacheDir 做字符串判断/拼接，引用对象会炸。
  assert.equal(settings.semantic.local.cacheDir, dir);
  assert.equal(typeof settings.semantic.local.cacheDir, "string");
  assert.equal(typeof settings.semantic.local.cacheDir.get, "undefined");
  // 空串契约同样解包（Config 缺省值在宿主侧也是引用对象）。
  const empty = normalizePluginConfig({
    semantic: { provider: "local", local: { cacheDir: volatileRef("") } },
  });
  assert.equal(empty.semantic.local.cacheDir, "");
});

test("volatile：mode / allowActive 解包不绕过校验", () => {
  rejects(() => normalizePluginConfig({ mode: volatileRef("turbo") }), "volatile bad mode");
  rejects(() => normalizePluginConfig({ allowActive: volatileRef("yes") }), "volatile non-boolean allowActive");
  rejects(() => normalizePluginConfig({ mode: volatileRef("active"), allowActive: volatileRef(false) }), "volatile active without allowActive");
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

// 0.4-S2（#e8a569）：路径规范化收口到 src/storage/path-canon.mjs 单一来源。
// config.mjs 只 re-export（同一函数对象），scope.mjs 的 import 路径不变。
test("0.4-S2：config.mjs 的 comparableRoot 直接 re-export 自 path-canon（单一来源）", () => {
  assert.equal(comparableRoot, comparableRootFromCanon, "必须是同一个函数对象，而非各自实现");
  for (const value of ["/", join(tmpdir(), "shiori-canon-root")]) {
    assert.equal(comparableRoot(value), comparableRootFromCanon(value), `折叠结果必须同源：${value}`);
  }
});

// ---------------------------------------------------------------------------
// P1#8 · 根目录 mkdir 失败降级（reviewer 答复 q-2dac64b1f233f6c1 拍板 B 方案）：
// verifyPluginRoots(settings, { degradeOnMkdirFailure: true })——apply 专用降级
// 开关；缺省（不传）行为逐字节不变（mkdir 失败照旧整体 throw，见上方既有用例
// 「目录创建失败给出可读诊断」，零改动）。降级模式逐根记结构化诊断（{root, path,
// reason, code}）随返回值透出（rootDiagnostics），不再 throw。
// 夹具：用「路径穿过一个已存在的普通文件」制造确定性的 mkdir 失败（Windows /
// POSIX 都给 ENOTDIR），不依赖平台 ACL；「根本身是文件」给 EEXIST 作补充形态。
// ---------------------------------------------------------------------------

/** 与 index.mjs apply 同款调用形态（降级开关常量，避免散落字面量）。 */
const DEGRADE = { degradeOnMkdirFailure: true };

test("P1#8：降级模式下单根 mkdir 失败不抛——记一条结构化诊断，另一根照常创建", () => {
  const base = join(TMP_ROOT, "p1-degrade");
  mkdirSync(base, { recursive: true });
  // dataRoot 的父级是一个普通文件：mkdirSync 递归创建必然失败（ENOTDIR，跨平台确定）。
  const blocker = join(base, "blocked.txt");
  writeFileSync(blocker, "not a directory", "utf8");
  const dataRoot = join(blocker, "shiori-data");
  const stateRoot = join(base, "shiori-state");
  let verified = null;
  try {
    verified = verifyPluginRoots(normalizePluginConfig({ dataRoot, stateRoot }), DEGRADE);
  } catch (error) {
    assert.fail(`mkdir failure must degrade instead of throwing (got ${error.code}: ${error.message})`);
  }
  assert.equal(verified.inert, false);
  // 正常字段照常回填（解析后的词法路径；ENOTDIR 不影响解析结果）。
  assert.equal(verified.dataRoot, dataRoot);
  assert.equal(verified.stateRoot, stateRoot);
  // 恰好一条诊断，字段齐全：root 归属、路径、原因、code。
  assert.equal(verified.rootDiagnostics.length, 1, "exactly one diagnostic for the failing root");
  const diag = verified.rootDiagnostics[0];
  assert.equal(diag.root, "dataRoot");
  assert.equal(diag.path, dataRoot);
  assert.equal(typeof diag.reason, "string");
  assert.ok(diag.reason.length > 0, "reason must carry the underlying error message");
  assert.equal(diag.code, "ENOTDIR");
  // 逐根独立：失败不牵连另一根，stateRoot 照常创建（mkdir -p 既有语义保留）；
  // 失败根零落盘（不创建任何东西，业务文件由降级挂载态的 controller 负责不建）。
  assert.equal(existsSync(stateRoot), true, "the healthy root must still be created");
  assert.equal(existsSync(dataRoot), false, "the failing root must not be created");
});

test("P1#8：降级模式下双根各自失败 → 两条诊断（各自带路径与 code）", () => {
  const base = join(TMP_ROOT, "p1-degrade-both");
  mkdirSync(base, { recursive: true });
  const dataBlocker = join(base, "data.txt");
  const stateBlocker = join(base, "state.txt");
  writeFileSync(dataBlocker, "x", "utf8");
  writeFileSync(stateBlocker, "x", "utf8");
  const verified = verifyPluginRoots(normalizePluginConfig({
    dataRoot: join(dataBlocker, "shiori-data"),
    stateRoot: join(stateBlocker, "shiori-state"),
  }), DEGRADE);
  assert.equal(verified.rootDiagnostics.length, 2, "one diagnostic per failing root");
  assert.deepEqual(verified.rootDiagnostics.map((d) => d.root), ["dataRoot", "stateRoot"]);
  for (const diag of verified.rootDiagnostics) {
    assert.equal(diag.code, "ENOTDIR");
    assert.ok(diag.reason.length > 0);
    assert.ok(diag.path.startsWith(base), "diagnostic path must point at the declared root");
  }
});

test("P1#8：降级模式下根本身是文件 → EEXIST 诊断；缺省模式仍抛（两向覆盖）", () => {
  const base = join(TMP_ROOT, "p1-degrade-eexist");
  mkdirSync(base, { recursive: true });
  const fileRoot = join(base, "shiori-data");
  writeFileSync(fileRoot, "occupied by a regular file", "utf8");
  const stateRoot = join(base, "shiori-state");
  // 降级模式：EEXIST 记诊断、不抛。
  const verified = verifyPluginRoots(normalizePluginConfig({ dataRoot: fileRoot, stateRoot }), DEGRADE);
  const diag = verified.rootDiagnostics.find((d) => d.root === "dataRoot");
  assert.ok(diag, "dataRoot (a regular file) must be diagnosed");
  assert.equal(diag.code, "EEXIST");
  assert.equal(diag.path, fileRoot);
  // 缺省模式（不传开关）：同一夹具（dataRoot 是普通文件）照旧整体 throw——既有
  // 公共契约语义逐字节保留（上方既有用例「目录创建失败给出可读诊断」锁的就是
  // 这条路，零改动）。
  assert.throws(
    () => verifyPluginRoots(normalizePluginConfig({ dataRoot: fileRoot, stateRoot: join(base, "s2-default") })),
    (error) => error.code === "INVALID_INPUT" && /cannot create shiori root directories/.test(error.message),
    "default mode must keep throwing on mkdir failure (unchanged public contract)",
  );
  // 对照组：降级模式两根就绪 → rootDiagnostics 为空数组（纯增量字段）。
  const healthy = verifyPluginRoots(normalizePluginConfig({
    dataRoot: join(base, "ok-data"),
    stateRoot: join(base, "ok-state"),
  }), DEGRADE);
  assert.deepEqual(healthy.rootDiagnostics, [], "healthy roots must produce an empty diagnostics array");
  assert.equal(healthy.inert, false);
  assert.equal(existsSync(join(base, "ok-data")), true);
  assert.equal(existsSync(join(base, "ok-state")), true);
});

// ---------------------------------------------------------------------------
// 0.5 批次 4 · A 线 · temperature 段（§11.2.6 12 项热度参数）。
// 评审答复 q-eb62768a0989320f 拍板走 C——这一处契约一次改完整：config 收纳 +
// normalizePluginConfig 返回值包含 temperature + scope.mjs SETTINGS_KEYS 放行
// （白名单经评审追加 src/plugin/scope.mjs）。以下全部为新增用例，既有断言零改动；
// 「真实入口 boot」覆盖复用现有 host-contract.test.mjs 的 B-P2 路径（不在白名单，
// 本文件不改它），本文件以 validateControllerSettings 直证 controller 挂载入口接受。
// ---------------------------------------------------------------------------

const { DEFAULT_TEMPERATURE_PARAMS } = await import("../../src/forgetting/params.mjs");
const { validateControllerSettings } = await import("../../src/plugin/scope.mjs");

test("0.5 批次 4：Config schema 带 temperature 段——默认值从 params.mjs 派生、整块 volatile", () => {
  const parsed = Config({});
  assert.equal(typeof parsed.temperature.get, "function", "volatile 字段在宿主侧是引用对象");
  assert.ok(Object.prototype.hasOwnProperty.call(parsed.temperature, VOLATILE_WRITE));
  assert.deepEqual(parsed.temperature.get(), { ...DEFAULT_TEMPERATURE_PARAMS }, "schema 默认值与唯一源头逐键一致（不复制数字）");
  assert.equal(Config.dict.temperature.meta.volatile, true, "整块 volatile：宿主只收纳带 volatile 字段的命名空间（dsh-settings describe）");
  assert.equal(isVolatilePath(Config, ["temperature", "s0Days"]), true, "面板写入路径（叶子）放行");
});

test("0.5 批次 4：normalizePluginConfig 收纳并返回 temperature——controller 挂载入口校验可接受", () => {
  // 显式配置：逐键校验后进返回值（拍板 C：返回值包含 temperature）。
  const settings = normalizePluginConfig({ temperature: { s0Days: 45, maxOpsPerRun: 10 } });
  assert.equal(settings.temperature.s0Days, 45);
  assert.equal(settings.temperature.maxOpsPerRun, 10);
  assert.equal(settings.temperature.sMaxDays, DEFAULT_TEMPERATURE_PARAMS.sMaxDays, "未给键回落唯一源头默认");
  assert.ok(Object.isFrozen(settings.temperature));
  // controller 构造时对 settings 调用的正是这个函数（scope.mjs
  // validateControllerSettings）：SETTINGS_KEYS 已放行 temperature，真实入口
  // boot（host-contract B-P2，本文件不改）因此保持绿。
  const controllerView = validateControllerSettings(settings);
  assert.equal(controllerView.temperature.s0Days, 45);
  assert.ok(Object.isFrozen(controllerView.temperature));
  // 缺省：返回值即唯一源头默认（config 层默认 = scope 层默认 = params.mjs 默认）。
  const defaults = normalizePluginConfig({});
  assert.deepEqual({ ...defaults.temperature }, { ...DEFAULT_TEMPERATURE_PARAMS });
});

test("0.5 批次 4：temperature 非法值在 config 层与 scope 层都被拒，message 带键名与原因", () => {
  // config 层：范围越界 / 段内未知键 / 交叉校验（回差不足）。评审 R6：rejects 的
  // 第二参只是失败提示文案、不构成断言——改为对 message 做真实匹配。
  assert.throws(
    () => normalizePluginConfig({ temperature: { s0Days: 0 } }),
    (error) => error.code === "INVALID_INPUT" && /s0Days/.test(error.message) && /超出允许区间/.test(error.message),
    "config 层拒绝范围越界（下界），message 带键名与区间",
  );
  assert.throws(
    () => normalizePluginConfig({ temperature: { s0Days: 5000 } }),
    (error) => error.code === "INVALID_INPUT" && /s0Days/.test(error.message) && /超出允许区间/.test(error.message),
    "config 层拒绝范围越界（上界）",
  );
  assert.throws(
    () => normalizePluginConfig({ temperature: { notAParam: 1 } }),
    (error) => error.code === "INVALID_INPUT" && /notAParam/.test(error.message) && /unknown property/.test(error.message),
    "config 层拒绝段内未知键（fail-closed，经 params.mjs assertKnownTemperatureKeys）",
  );
  assert.throws(
    () => normalizePluginConfig({ temperature: { coolThreshold: 40, restoreThreshold: 49 } }),
    (error) => error.code === "INVALID_INPUT" && /restoreThreshold/.test(error.message),
    "config 层拒绝交叉校验违规（回差不足）",
  );
  // scope 层（直构 settings 也挡得住，不只靠 config 层）：范围越界 / 交叉校验 /
  // 段内未知键（评审 R4：P 侧同样 fail-closed，typo 不静默落默认值）。
  assert.throws(
    () => validateControllerSettings({ temperature: { s0Days: 0 } }),
    (error) => error.code === "INVALID_INPUT" && /s0Days/.test(error.message),
    "scope 层拒绝范围越界且 message 带键名",
  );
  assert.throws(
    () => validateControllerSettings({ temperature: { s0Days: 90, sMaxDays: 90 } }),
    (error) => error.code === "INVALID_INPUT" && /sMaxDays/.test(error.message),
    "交叉校验（sMaxDays 须大于 s0Days）在 scope 层同样生效",
  );
  assert.throws(
    () => validateControllerSettings({ temperature: { notAParam: 1 } }),
    (error) => error.code === "INVALID_INPUT" && /notAParam/.test(error.message) && /unknown property/.test(error.message),
    "scope 层拒绝段内未知键（不静默忽略）",
  );
});

test("0.5 批次 4：不写 temperature 时运行期值等于 DEFAULT_TEMPERATURE_PARAMS（scope 缺省回落）", () => {
  const view = validateControllerSettings({});
  assert.deepEqual({ ...view.temperature }, { ...DEFAULT_TEMPERATURE_PARAMS });
  assert.ok(Object.isFrozen(view.temperature), "缺省回落值同样冻结");
  // normalize 侧缺省一致（config 层默认 = scope 层默认 = 唯一源头默认）。
  assert.deepEqual({ ...normalizePluginConfig({}).temperature }, { ...DEFAULT_TEMPERATURE_PARAMS });
});

test("0.5 批次 4：temperature 的 volatile 引用对象被解包后照常校验", () => {
  const settings = normalizePluginConfig({ temperature: volatileRef({ s0Days: 45 }) });
  assert.equal(settings.temperature.s0Days, 45);
  assert.equal(typeof settings.temperature.get, "undefined", "解包后是普通冻结对象");
  // 评审 R12：对 message 做真实匹配（rejects 的第二参只是失败提示文案）。
  assert.throws(
    () => normalizePluginConfig({ temperature: volatileRef({ s0Days: 0 }) }),
    (error) => error.code === "INVALID_INPUT" && /s0Days/.test(error.message) && /超出允许区间/.test(error.message),
    "volatile 引用解包后照常校验（范围越界仍拒绝）",
  );
});
