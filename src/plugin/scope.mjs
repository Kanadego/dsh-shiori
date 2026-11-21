// Shiori P5-PLUGIN · 可信 scope 解析、settings 校验与身份固定（slot P）。
//
// 边界（CONTRACTS §2/§3）：
// - settings 由 Q 归一化后传入，P 在此完整再校验（未知键拒绝；路径/预算/映射复核）；
// - scope 只能从可信证据解析：工具 exec.agent.session.id、waterfall/pres-step 的
//   agent、RPC trustedContext 的宿主资源引用。payload 中的 ownerId/scopeId/persona/
//   authorize/root 一律拒绝；
// - 可信会话选卡：sessionPersonas 精确匹配 → workspacePersonas 规范路径最长匹配
//   （仅匹配路径边界）→ defaultPersona；persona null = global memory（scopeId 'global'）；
// - 每次 resolveScope 返回冻结的 {sessionId, scopeId, ownerId, generation}，
//   跨 await 不得改写请求目标；
// - 单用户本地 profile 是本批安全边界：多用户身份不可信时拒绝，不默认共享。

import path from "node:path";
import { realpathSync } from "node:fs";
import { DEFAULT_CONFIG, validateConfig } from "../core/index.mjs";
import { normalizeSemantic, defaultPluginRoots, comparableRoot } from "./config.mjs";
import { normalizeForgetPolicy } from "../forgetting/decay.mjs";
// 0.5 批次 4 · A 线：temperature 段的唯一源头（§11.2.6 12 项热度参数）。
// P 侧复核复用同一套 assertKnownTemperatureKeys（未知键 fail-closed）+
// normalizeTemperatureParams（逐项范围）+ validateTemperatureParams（交叉校验），
// 不复制任何数字与范围规则；缺省回落即 DEFAULT_TEMPERATURE_PARAMS
// （normalizeTemperatureParams(undefined) 的产物）。
import { assertKnownTemperatureKeys, normalizeTemperatureParams, validateTemperatureParams } from "../forgetting/params.mjs";
import { GLOBAL_SCOPE_ID } from "../core/topics.mjs";

/** persona 为 null（无卡）时的 scopeId：global memory。 */
export { GLOBAL_SCOPE_ID as NULL_PERSONA_SCOPE };

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

/**
 * 默认根比较口径（0.4 P4 返工，reviewer 打回项 1）：解析后等价，逐字节 === 会在
 * junction/symlink 环境打死插件——index.mjs apply 把 verifyPluginRoots 解析出的
 * 真实路径回填 settings 而 rootsSource 保持 default，词形与 realpath 不相等。
 * 存在则 realpath，解析失败或不存在退回字面；再按 config.mjs 的 comparableRoot
 * 同口径折叠（导出复用，两处不许各写一份）。
 */
function comparableResolvedRoot(value) {
  let resolved = value;
  try {
    resolved = realpathSync(value);
  } catch {
    // 不存在 / 不可解析：退回字面比较
  }
  return comparableRoot(resolved);
}

/**
 * 默认根（DSH_HOME / profileRoot 派生，非调用方显式提供）的绝对路径校验：
 * 复用 requireAbsoluteRoot 的文案会误说 "when provided"（reviewer nit 6），
 * 这里给准确文案。
 */
function requireDerivedAbsoluteRoot(value, field) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    fail("INVALID_INPUT", `settings.${field} default root derived from DSH_HOME must be an absolute path, got ${JSON.stringify(value)}`, {
      field, received: typeof value,
    });
  }
  return value;
}

const isPlainRecord = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** settings 顶层键（未知键拒绝）。基线 14 键与冻结契约 §2 一致；"temperature" 是
 *  0.5 批次 4 · A 线的扩展项（§11.2.6 热度参数 12 项，唯一源头
 *  ../forgetting/params.mjs）——经评审拍板（q-eb62768a0989320f）并入本契约，
 *  属 0.5 批次 4 扩展，非历史 §2 原生键。 */
const SETTINGS_KEYS = [
  "mode", "allowActive", "dataRoot", "stateRoot", "rootsSource", "ownerId",
  "defaultPersona", "sessionPersonas", "workspacePersonas",
  "budgets", "semantic", "l2", "organize", "forgetting",
  "temperature",
];

/** 绝对路径校验（不要求目录已存在；越界判定在 validateRoots）。 */
function requireAbsoluteRoot(value, field) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    fail("INVALID_INPUT", `settings.${field} must be an absolute path when provided`, {
      field, received: typeof value,
    });
  }
  return value;
}

function requirePersonaName(value, field) {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_INPUT", `settings.${field} must be a non-empty persona name or null`, { field });
  }
  // 卡名会直接拼成 <dataRoot>/persona/<name>.md（persona.mjs cardFile），所以必须挡住
  // 路径分隔符、上跳与 Windows ADS 冒号：否则 "../../x" 会读到 dataRoot 之外的文件。
  if (/[\\/:]/.test(value) || value.includes("..") || value.trim() !== value) {
    fail("INVALID_INPUT", `settings.${field} must not contain path separators, ".." or surrounding spaces`, { field });
  }
  return value;
}

function validateMappings(value, field, keyField) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("INVALID_INPUT", `settings.${field} must be an array`, { field });
  }
  return value.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      fail("INVALID_INPUT", `settings.${field}[${index}] must be an object`, { field, index });
    }
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes(keyField) || !keys.includes("persona")) {
      fail("INVALID_INPUT", `settings.${field}[${index}] must have exactly {${keyField}, persona}`, {
        field, index, keys,
      });
    }
    const key = entry[keyField];
    if (typeof key !== "string" || key.trim().length === 0) {
      fail("INVALID_INPUT", `settings.${field}[${index}].${keyField} must be a non-empty string`, { field, index });
    }
    return { [keyField]: key, persona: requirePersonaName(entry.persona, `${field}[${index}].persona`) };
  });
}

function validateModuleSwitch(value, field) {
  if (value === undefined) {
    // forgetting 缺省也带默认策略（30/240/.25）与 auto 三档模式缺省（suggest，
    // 0.5 批次 5 · A 线 §7）：供执行门面/引擎直接消费。
    return field === "forgetting"
      ? { enabled: false, autoMode: "suggest", policy: normalizeForgetPolicy({}) }
      : field === "l2"
        // 0.5-5C：l2 缺省也带分簇规则版本（与 config normalizePluginConfig 同默认）。
        ? { enabled: false, clustersVersion: 1 }
        : { enabled: false };
  }
  if (!isPlainRecord(value) || !Object.hasOwn(value, "enabled") || typeof value.enabled !== "boolean") {
    fail("INVALID_INPUT", `settings.${field}.enabled must be a boolean`, { field });
  }
  const keys = Object.keys(value);
  // 0.5-5C：l2 段放行 clustersVersion（闪回图谱分簇规则版本；仅这一个额外键，
  // organize 仍只认 enabled）。
  // 0.5 批次 5 · A 线：forgetting 段放行 autoMode（三档模式）。
  const allowed = field === "forgetting"
    ? ["enabled", "autoMode", "policy"]
    : field === "l2" ? ["enabled", "clustersVersion"] : ["enabled"];
  for (const key of keys) {
    if (!allowed.includes(key)) {
      fail("INVALID_INPUT", `settings.${field} has unknown property "${key}"`, { field, key });
    }
  }
  const result = { enabled: value.enabled };
  if (field === "forgetting") {
    // 0.5 批次 5 · A 线：auto 三档模式（off/suggest/auto），缺省 suggest（首版
    // 拍板口径）。显式给出但非法当场拒绝；取值域与 forgetting/auto.mjs 的
    // AUTO_MODES 同一（此处复制字面量 + 注释互指，避免反向 import 引擎模块）。
    if (value.autoMode === undefined) {
      result.autoMode = "suggest";
    } else if (value.autoMode !== "off" && value.autoMode !== "suggest" && value.autoMode !== "auto") {
      fail("INVALID_INPUT", `settings.forgetting.autoMode must be one of "off" / "suggest" / "auto", got ${JSON.stringify(value.autoMode)}`, { field });
    } else {
      result.autoMode = value.autoMode;
    }
    try {
      result.policy = normalizeForgetPolicy(value.policy ?? {});
    } catch (error) {
      fail("INVALID_INPUT", `settings.forgetting.policy invalid: ${error instanceof Error ? error.message : String(error)}`, {});
    }
  }
  if (field === "l2") {
    const version = value.clustersVersion;
    if (version === undefined) {
      result.clustersVersion = 1;
    } else if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
      fail("INVALID_INPUT", `settings.l2.clustersVersion must be a natural number >= 1, got ${JSON.stringify(version)}`, {});
    } else {
      result.clustersVersion = version;
    }
  }
  return result;
}

/**
 * P 侧 settings 完整校验（Q 归一化后再核验；防御直接构造的 settings）。
 * 通过返回冻结的规范化 settings；不修改输入。
 */
export function validateControllerSettings(raw) {
  if (!isPlainRecord(raw)) {
    fail("INVALID_INPUT", "settings must be a plain object", { received: typeof raw });
  }
  for (const key of Object.keys(raw)) {
    if (!SETTINGS_KEYS.includes(key)) {
      fail("INVALID_INPUT", `settings has unknown property "${key}"`, { key });
    }
  }

  const mode = raw.mode ?? "shadow";
  if (mode !== "shadow" && mode !== "active") {
    fail("INVALID_INPUT", `settings.mode must be "shadow" or "active", got ${JSON.stringify(mode)}`, {});
  }
  const allowActive = raw.allowActive ?? false;
  if (typeof allowActive !== "boolean") {
    fail("INVALID_INPUT", "settings.allowActive must be a boolean", {});
  }
  if (mode === "active" && allowActive !== true) {
    fail("INVALID_INPUT", 'active mode requires settings.allowActive === true', {});
  }

  // 0.4-S1（reviewer P2②）：各根独立解析——只显式给一个根时，另一个补 DSH_HOME
  // 默认（与 normalizePluginConfig 同语义），不再要求「必须齐给或全缺」。rootsSource
  // 由 normalize 传入；直构缺省时按「显式给值=explicit、缺省/补默认=default」现推。
  // 显式传入 rootsSource 时做自洽校验（0.4 P4）：explicit 必须对应已给值；default
  // 必须对应未给值或「解析后等价于 DSH_HOME 默认根」的值——normalize/verify 注入
  // 产物就是「真实路径（junction/symlink 已解析）+ default 标记」，controller.mjs
  // 会对此再校验，不能拒。「source=explicit 但值是 null」「default 配自定路径」
  // 这类自相矛盾的配置直接拒绝，不给排障留坑。
  // 边界（nit 7）：default 值校验只认 DSH_HOME 默认根；profileRoot 入口当前不可达
  // （config.mjs 顶部边界注释、index.mjs apply 均不传 options），若未来接入
  // profileRoot，这里必须同步放宽或给 rootsSource 引入第三来源。
  let rootsSource = raw.rootsSource;
  if (rootsSource !== undefined) {
    if (!isPlainRecord(rootsSource)
      || (rootsSource.dataRoot !== "explicit" && rootsSource.dataRoot !== "default")
      || (rootsSource.stateRoot !== "explicit" && rootsSource.stateRoot !== "default")) {
      fail("INVALID_INPUT", 'settings.rootsSource must be { dataRoot: "explicit" | "default", stateRoot: "explicit" | "default" }', {});
    }
    let defaults = null; // 惰性（nit 5）：双 explicit 不触碰 defaultPluginRoots
    for (const field of ["dataRoot", "stateRoot"]) {
      const given = raw[field] ?? null;
      // 类型先行（attempt 4 返工）：comparables 会走 realpathSync/normalize，
      // 非字符串（如 raw.dataRoot = 5）在那里抛 TypeError，绕过统一 fail。
      // 与 explicit 分支同口径：非法类型一律 INVALID_INPUT。
      if (given !== null && typeof given !== "string") {
        fail("INVALID_INPUT", `settings.${field} must be a string when provided, got ${typeof given}`, {
          field, received: typeof given,
        });
      }
      if (rootsSource[field] === "explicit") {
        if (given === null) {
          fail("INVALID_INPUT", `settings.rootsSource.${field} is "explicit" but settings.${field} is not given`, { field });
        }
      } else if (given !== null) {
        defaults ??= defaultPluginRoots();
        // 接受条件（attempt 5 收口，单条判据）：解析后等价。comparableResolvedRoot
        // 先 realpath、解析失败时退回 comparableRoot 字面折叠（实现见下方 comparableResolvedRoot），
        // 「两侧 realpath 都失败」的场景已由该兜底覆盖，不需要第二个字面判据。
        // 边界：DSH_HOME 指向坏链接时词形与目标不一致，解析侧与词形侧都不相等，
        // 照旧拒绝——本卡不覆盖该场景（生产不可达）。
        const sameResolved = comparableResolvedRoot(given) === comparableResolvedRoot(defaults[field]);
        if (!sameResolved) {
          fail("INVALID_INPUT", `settings.rootsSource.${field} is "default" but settings.${field} is not the DSH_HOME default root after path resolution`, { field });
        }
      }
    }
  }
  let dataRoot = raw.dataRoot ?? null;
  let stateRoot = raw.stateRoot ?? null;
  if (rootsSource === undefined) {
    rootsSource = {
      dataRoot: dataRoot !== null ? "explicit" : "default",
      stateRoot: stateRoot !== null ? "explicit" : "default",
    };
  }
  if (dataRoot !== null) requireAbsoluteRoot(dataRoot, "dataRoot");
  if (stateRoot !== null) requireAbsoluteRoot(stateRoot, "stateRoot");
  if (dataRoot === null && stateRoot !== null) {
    dataRoot = requireDerivedAbsoluteRoot(defaultPluginRoots().dataRoot, "dataRoot");
    rootsSource = { ...rootsSource, dataRoot: "default" };
  }
  if (stateRoot === null && dataRoot !== null) {
    stateRoot = requireDerivedAbsoluteRoot(defaultPluginRoots().stateRoot, "stateRoot");
    rootsSource = { ...rootsSource, stateRoot: "default" };
  }
  // active 直构双空兜底（0.4 P4）：与 apply 路径（normalizePluginConfig）同语义——
  // active 不允许带着一对 null 根去 openState，双根皆缺省时补 DSH_HOME 默认并标记
  // default；shadow 保持 null（影子挂载 inert，不能给它补根）。
  if (mode === "active" && dataRoot === null && stateRoot === null) {
    const defaults = defaultPluginRoots();
    dataRoot = requireDerivedAbsoluteRoot(defaults.dataRoot, "dataRoot");
    stateRoot = requireDerivedAbsoluteRoot(defaults.stateRoot, "stateRoot");
    rootsSource = { ...rootsSource, dataRoot: "default", stateRoot: "default" };
  }
  if (dataRoot !== null && mode !== "active") {
    // shadow 配置了 root：允许只读预览挂载（诊断可见），但必须显式知道这是 shadow。
    if (allowActive !== false) fail("INVALID_INPUT", "shadow mode must have allowActive === false", {});
  }

  const ownerId = raw.ownerId ?? "local";
  if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
    fail("INVALID_INPUT", "settings.ownerId must be a non-empty string", {});
  }

  const defaultPersona = requirePersonaName(raw.defaultPersona ?? null, "defaultPersona");
  const sessionPersonas = validateMappings(raw.sessionPersonas, "sessionPersonas", "sessionId");
  const workspacePersonas = validateMappings(raw.workspacePersonas, "workspacePersonas", "workspace");
  for (const entry of workspacePersonas) {
    requireAbsoluteRoot(entry.workspace, "workspacePersonas[].workspace");
  }

  // 预算：完整由 validateConfig 验证；并强制 Q 生产安全上限（可向下调）。
  const budgetsRaw = raw.budgets ?? {};
  if (!isPlainRecord(budgetsRaw)) {
    fail("INVALID_INPUT", "settings.budgets must be a plain object", {});
  }
  // U2 水位（softChars/hardChars）是插件层契约字段，core validateConfig 不认识：
  // 先取出、按「水位 / 硬顶」回推 ratio 喂 core（与 src/plugin/config.mjs 同源推导，
  // 避免双源真相），校验通过后再把权威水位并回 settings.budgets。
  const budgetsCoreIn = isPlainRecord(budgetsRaw.core) ? budgetsRaw.core : {};
  const waterSoft = budgetsCoreIn.softChars;
  const waterHard = budgetsCoreIn.hardChars;
  const budgetsForCore = { ...budgetsRaw, core: { ...budgetsCoreIn } };
  delete budgetsForCore.core.softChars;
  delete budgetsForCore.core.hardChars;
  const waterCap = Number.isInteger(budgetsForCore.core.hardCapChars) && budgetsForCore.core.hardCapChars > 0
    ? budgetsForCore.core.hardCapChars
    : DEFAULT_CONFIG.core.hardCapChars;
  if (waterSoft !== undefined && waterHard !== undefined && waterSoft > waterHard) {
    fail("INVALID_INPUT", `软水位（${waterSoft} 字符）不能大于硬水位（${waterHard} 字符）`, {});
  }
  if (waterSoft !== undefined) budgetsForCore.core.softRatio = waterSoft / waterCap;
  if (waterHard !== undefined) budgetsForCore.core.hardRatio = waterHard / waterCap;
  let budgets;
  try {
    budgets = validateConfig(budgetsForCore);
  } catch (error) {
    fail("INVALID_INPUT", `settings.budgets invalid: ${error instanceof Error ? error.message : String(error)}`, {});
  }
  const softChars = waterSoft ?? Math.round(budgets.core.hardCapChars * budgets.core.softRatio);
  const hardChars = waterHard ?? Math.round(budgets.core.hardCapChars * budgets.core.hardRatio);
  budgets = Object.freeze({
    core: Object.freeze({ ...budgets.core, softChars, hardChars }),
    persona: budgets.persona,
    spark: budgets.spark,
  });
  const caps = [
    // 与 src/plugin/config.mjs BUDGET_CEILINGS.persona.maxChars 保持一致（公开插件，
    // 长人设卡用户需要更高的上限；默认值仍由 DEFAULT_CONFIG 给 12000）。
    ["persona", "maxChars", 60000],
    ["spark", "maxChars", 600],
    ["spark", "inlineMaxChars", 100],
    ["spark", "maxCards", 5],
    ["spark", "seedCount", 3],
    ["spark", "linkCount", 2],
  ];
  for (const [section, field, cap] of caps) {
    if (budgets[section][field] > cap) {
      fail("INVALID_INPUT", `settings.budgets.${section}.${field} (${budgets[section][field]}) exceeds the production safety cap ${cap}`, {
        section, field, cap,
      });
    }
  }

  // semantic 段（F1 方案 C 接口预留）：形状与默认值由 Q 侧 normalizeSemantic 单一来源，
  // P 侧复核后原样透传（本期不消费）。
  let semantic;
  try {
    semantic = normalizeSemantic(raw.semantic);
  } catch (error) {
    fail("INVALID_INPUT", `settings.semantic invalid: ${error instanceof Error ? error.message : String(error)}`, {});
  }

  const l2 = validateModuleSwitch(raw.l2, "l2");
  const organize = validateModuleSwitch(raw.organize, "organize");
  const forgetting = validateModuleSwitch(raw.forgetting, "forgetting");

  // temperature 段（0.5 批次 4 · A 线，§11.2.6 12 项热度参数）：与 semantic 同款
  // 「Q 侧单一来源、P 侧复核」——先经 assertKnownTemperatureKeys 对段内未知键
  // fail-closed（评审 R4：P 侧挂载复核与 config/semantic 同款口径，typo 必须拒绝
  // 而不是被 normalizeTemperatureParams 的前向兼容「未知键忽略」静默落默认值；
  // 两层差异见 params.mjs assertKnownTemperatureKeys 注释），再走
  // normalizeTemperatureParams（逐项范围，绝不夹取）+ validateTemperatureParams
  // （sMaxDays>s0Days / restoreThreshold≥coolThreshold+10 /
  // minRestoreGraceDays≤minCooldownDays 三条交叉校验），非法值 fail-closed 且
  // message 带键名——直构 settings 也挡得住，不只靠 config 层。
  let temperature;
  try {
    assertKnownTemperatureKeys(raw.temperature);
    temperature = normalizeTemperatureParams(raw.temperature);
    validateTemperatureParams(temperature);
  } catch (error) {
    fail("INVALID_INPUT", `settings.temperature invalid: ${error instanceof Error ? error.message : String(error)}`, {});
  }

  return Object.freeze({
    mode,
    allowActive,
    dataRoot,
    stateRoot,
    rootsSource: Object.freeze(rootsSource),
    ownerId,
    defaultPersona,
    sessionPersonas: Object.freeze(sessionPersonas.map((e) => Object.freeze(e))),
    workspacePersonas: Object.freeze(workspacePersonas.map((e) => Object.freeze(e))),
    budgets,
    semantic: Object.freeze(semantic),
    l2: Object.freeze(l2),
    organize: Object.freeze(organize),
    forgetting: Object.freeze(forgetting),
    temperature,
  });
}

/** 折叠路径用于比较（Windows 大小写不敏感）。 */
const foldPath = process.platform === "win32"
  ? (p) => path.resolve(p).toLowerCase()
  : (p) => path.resolve(p);

/**
 * 可信会话选卡：sessionPersonas 精确 → workspace 最长前缀（仅路径边界）→ defaultPersona。
 * persona null = global memory。无任何匹配且 defaultPersona 为 null → scopeId 'global'。
 */
export function personaForSession(settings, { sessionId, workspace } = {}) {
  if (sessionId !== undefined && sessionId !== null) {
    const hit = settings.sessionPersonas.find((e) => e.sessionId === sessionId);
    if (hit !== undefined) return hit.persona;
  }
  if (workspace !== undefined && workspace !== null) {
    const ws = foldPath(workspace);
    let best = null;
    let bestLen = -1;
    for (const entry of settings.workspacePersonas) {
      const base = foldPath(entry.workspace);
      const boundary = ws === base || ws.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
      if (boundary && base.length > bestLen) {
        best = entry;
        bestLen = base.length;
      }
    }
    if (best !== null) return best.persona;
  }
  return settings.defaultPersona;
}

/**
 * 从装配期 raw settings 里挑出三个选卡字段的 volatile 引用（宿主热提交时不重载插件，
 * 引用值就地更新；非引用形态一律记为 null，回落快照）。
 */
export function readLiveRefs(raw) {
  const pick = (value) => (value !== null && typeof value === "object" && typeof value.get === "function" ? value : null);
  if (raw === null || typeof raw !== "object") {
    return Object.freeze({ defaultPersona: null, sessionPersonas: null, workspacePersonas: null, temperature: null });
  }
  return Object.freeze({
    defaultPersona: pick(raw.defaultPersona),
    sessionPersonas: pick(raw.sessionPersonas),
    workspacePersonas: pick(raw.workspacePersonas),
    // 0.5 批次 4 · B 线：12 项热度参数的 volatile 引用（面板保存后服务端热读；
    // 消费方是 controller.liveTemperature，不参与选卡）。
    temperature: pick(raw.temperature),
  });
}

/**
 * 用 volatile 引用里的最新值覆盖装配期快照的选卡字段——面板「切换人设卡」写入
 * sessionPersonas / workspacePersonas / defaultPersona 后，宿主不重载插件，只有
 * 实时解包才能让当前会话的下一次调用用上新卡。引用缺失、抛错或热值非法时回落
 * 快照，绝不因热更新失败而拒绝请求。
 */
export function liveSettingsForScope(settings) {
  const refs = settings?.liveRefs;
  if (refs === null || typeof refs !== "object") return settings;
  const read = (ref, fallback) => {
    if (ref === null || typeof ref !== "object" || typeof ref.get !== "function") return fallback;
    try { return ref.get(); } catch { return fallback; }
  };
  try {
    return Object.freeze({
      ...settings,
      defaultPersona: requirePersonaName(read(refs.defaultPersona, settings.defaultPersona), "defaultPersona"),
      sessionPersonas: Object.freeze(validateMappings(read(refs.sessionPersonas, settings.sessionPersonas), "sessionPersonas", "sessionId").map((e) => Object.freeze(e))),
      workspacePersonas: Object.freeze(validateMappings(read(refs.workspacePersonas, settings.workspacePersonas), "workspacePersonas", "workspace").map((e) => Object.freeze(e))),
    });
  } catch {
    return settings;
  }
}

/** persona 名 → scopeId（null persona → global）。 */
export function scopeIdForPersona(persona) {
  return persona === null ? GLOBAL_SCOPE_ID : persona;
}

/**
 * 拒绝 payload 中的危险身份字段：模型/客户端永远不能传 ownerId/scopeId/
 * persona/authorize/root 定位 scope（出现即拒绝，即便值恰好等于可信值）。
 */
export function rejectIdentityFields(payload, where) {
  if (!isPlainRecord(payload)) {
    fail("INVALID_INPUT", `${where}: payload must be a plain object`, { where });
  }
  const dangerous = ["ownerId", "scopeId", "scope", "persona", "authorize", "root", "trustedContext"];
  for (const key of dangerous) {
    if (Object.hasOwn(payload, key)) {
      fail("INVALID_INPUT", `${where}: dangerous identity field "${key}" cannot be passed in payloads; `
        + "identity is resolved from trusted host evidence only", { where, key });
    }
  }
  return payload;
}

/**
 * 从可信证据固定一次请求的 scope 身份。返回冻结对象；跨 await 使用同一对象，
 * 不得重新解析或改写。
 *
 * @param {object} args
 * @param {object} args.settings 已校验 settings
 * @param {string} args.sessionId 可信会话 id（宿主资源；非 wire 参数）
 * @param {string} [args.workspace] 可信工作区（宿主证据）
 * @param {number} args.generation controller 启动代际
 * @param {string} args.source 'tool-exec' | 'assemble' | 'pre-step' | 'panel-rpc'
 */
export function pinScope({ settings, sessionId, workspace, generation, source }) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("INVALID_INPUT", "pinScope requires a trusted non-empty sessionId (host resource)", { source });
  }
  if (!Number.isInteger(generation) || generation < 0) {
    fail("INVALID_INPUT", "pinScope requires a non-negative integer generation", { source });
  }
  const persona = personaForSession(liveSettingsForScope(settings), { sessionId, workspace });
  return Object.freeze({
    sessionId,
    workspace: workspace ?? null,
    persona,
    scopeId: scopeIdForPersona(persona),
    ownerId: settings.ownerId,
    generation,
    source,
    fixedAt: Object.freeze(new Date()),
  });
}

/**
 * 从工具 exec 提取可信会话证据（dsh-native.js:131 同款：exec.agent.session.id）。
 * exec 无 agent/session → INVALID_INPUT（不猜、不回落上一个会话）。
 */
export function sessionEvidenceFromExec(exec) {
  const sessionId = exec?.agent?.session?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("INVALID_INPUT", "tool execution lacks trusted session evidence (exec.agent.session.id)", {});
  }
  return { sessionId, agent: exec.agent };
}

/**
 * 从 assemble/pre-step 的 agent 提取可信会话证据。
 */
export function sessionEvidenceFromAgent(agent) {
  const sessionId = agent?.session?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null; // 诊断装配等无 agent 场景：调用方不读业务
  }
  return { sessionId, agent };
}

/**
 * 从 RPC trustedContext 提取可信会话证据。
 * trustedContext 必须是服务端绑定的宿主资源 {agent, session, principal, source, signal}；
 * payload 永不携带 trustedContext（rejectIdentityFields 已在 wire 层拒绝）。
 * principal 校验由 Q 的 resolver 完成；P 只再核验会话证据存在。
 */
export function sessionEvidenceFromRpc(trustedContext) {
  if (!isPlainRecord(trustedContext)) {
    fail("INVALID_INPUT", "trustedContext must be a server-bound resource object", {});
  }
  const sessionId = trustedContext.session?.id ?? trustedContext.agent?.session?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("INVALID_INPUT", "trustedContext lacks trusted session identity (session.id / agent.session.id)", {});
  }
  if (trustedContext.source !== "panel-rpc") {
    fail("INVALID_INPUT", `trustedContext.source must be "panel-rpc", got ${JSON.stringify(trustedContext.source)}`, {});
  }
  return { sessionId, agent: trustedContext.agent ?? null, principal: trustedContext.principal ?? null };
}
