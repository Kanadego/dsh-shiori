// Shiori P5-Q · 原生插件配置（公共契约导出 Config / normalizePluginConfig / verifyPluginRoots）。
//
// 职责边界（CONTRACTS §2）：
//   - Config：原生 Schemastery schema，供宿主 settings UI / Cordis 装配解析静态结构；
//     它只证明「可序列化结构 + 默认值」，不证明路径安全，不替代 normalize；
//   - normalizePluginConfig：权威规范化。未知键拒绝；缺省 mode=shadow / allowActive=false /
//     defaultPersona=null / 两个 persona 映射=[] / l2、organize、forgetting.enabled=false /
//     ownerId='local' / dataRoot=stateRoot=null；预算经 core/validateConfig 全关系校验，
//     忘却 policy 经 forgetting/normalizeForgetPolicy（默认 30/240/0.25）；
//   - verifyPluginRoots：apply 阶段的真实文件系统校验（真实 link 解析后仍绝对、
//     互不嵌套），静态 schema dump 不能替代本步。
//
// 安全规则：
//   - 仅 dataRoot 与 stateRoot 皆 null 且 mode=shadow 允许 inert 挂载（needs-configuration）；
//   - active 或配置了任一 root ⇒ 两个绝对 root 必须显式提供；
//   - active 必须 allowActive===true；
//   - profileRoot 只在宿主 bootstrap 能证明可信时由调用方显式传入（本批 DSH 0.2.1-rc.2
//     无已核实的 ctx.profileRoot，入口一律不传；ctx.baseUrl 不是 profileRoot，
//     禁止用 cwd/HOME/包目录猜测）。
//
// 本模块除 schemastery 与既有生产模块外零依赖；抛出的错误均带可序列化 .code（INVALID_INPUT）。

import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import z from "@deepseek-ai/schemastery";
import { DEFAULT_CONFIG, validateConfig } from "../core/config.mjs";
import { normalizeForgetPolicy } from "../forgetting/decay.mjs";

/** 本插件在宿主 settings 服务中的命名空间（与 Cordis 插件 id 一致）。 */
export const SETTINGS_NAMESPACE = "shiori";

// ---------------------------------------------------------------------------
// 错误辅助：统一带 .code 的普通 Error（可序列化，供宿主 / RPC 透传）
// ---------------------------------------------------------------------------

function fail(message) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  throw error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return Object.freeze(value);
}

function clone(value) {
  return value === null || typeof value !== "object" ? value : structuredClone(value);
}

// 宿主对打了 .volatile() 的字段不会把值直接交给插件：Cordis 装配时把它替换成
// cosmokit 的 volatile 引用对象
//   { get: () => frozenValue, [Symbol.for("cosmokit.volatile.write")]: fn }
// （宿主 dsh-settings describe()/volatileForm() 依赖该标记把字段列入 settings）。
// 这里只读配置，按鸭子类型解包：不用 instanceof、不 import cosmokit（跨 ESM 副本会
// 分裂），普通对象/数组/原始值原样返回。
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

function unwrapVolatile(value) {
  if (value !== null
    && typeof value === "object"
    && typeof value.get === "function"
    && VOLATILE_WRITE in value) {
    return value.get();
  }
  return value;
}

// ---------------------------------------------------------------------------
// 原生 Schemastery Config（静态结构 + 默认值；权威校验在 normalizePluginConfig）
// ---------------------------------------------------------------------------

const nullableString = () => z.union([z.string(), z.const(null)]);
const personaChoice = () => nullableString().default(null);

function budgetObject() {
  return z.object({
    core: z.object({
      targetChars: z.natural().default(DEFAULT_CONFIG.core.targetChars),
      hardCapChars: z.natural().default(DEFAULT_CONFIG.core.hardCapChars),
      softRatio: z.number().default(DEFAULT_CONFIG.core.softRatio),
      hardRatio: z.number().default(DEFAULT_CONFIG.core.hardRatio),
      cacheLockFallback: z.boolean().default(DEFAULT_CONFIG.core.cacheLockFallback),
    }).default(clone(DEFAULT_CONFIG.core)),
    persona: z.object({
      maxChars: z.natural().default(DEFAULT_CONFIG.persona.maxChars),
    }).default(clone(DEFAULT_CONFIG.persona)),
    spark: z.object({
      maxChars: z.natural().default(DEFAULT_CONFIG.spark.maxChars),
      inlineMaxChars: z.natural().default(DEFAULT_CONFIG.spark.inlineMaxChars),
      maxCards: z.natural().default(DEFAULT_CONFIG.spark.maxCards),
      seedCount: z.natural().default(DEFAULT_CONFIG.spark.seedCount),
      linkCount: z.natural().default(DEFAULT_CONFIG.spark.linkCount),
    }).default(clone(DEFAULT_CONFIG.spark)),
  }).default(clone(DEFAULT_CONFIG));
}

/** 原生 Schemastery Config：宿主 settings UI 与 Cordis 装配使用的静态 schema。 */
export const Config = z.object({
  mode: z.union([z.const("shadow"), z.const("active")]).default("shadow").description("shadow 只读影子（默认，不写业务数据）；active 显式启用完整工具与写入"),
  allowActive: z.boolean().default(false).description("显式允许 active；mode=active 时必须为 true"),
  dataRoot: nullableString().default(null).description("业务数据根目录（绝对路径）；默认 null（inert 挂载，需配置诊断）"),
  stateRoot: nullableString().default(null).description("运行状态根目录（绝对路径），与 dataRoot 互不嵌套；默认 null"),
  ownerId: z.string().default("local").description("可信部署配置的单用户 owner 标识；模型不可传"),
  defaultPersona: personaChoice().description("默认人设卡名；null=global memory / 无默认卡"),
  sessionPersonas: z.array(z.object({
    sessionId: z.string().description("宿主会话 id"),
    persona: personaChoice().description("该会话的人设卡；null=global"),
  })).default([]).description("会话级选卡映射（下一次调用生效）"),
  workspacePersonas: z.array(z.object({
    workspace: z.string().description("工作区绝对路径"),
    persona: personaChoice().description("该工作区的人设卡；null=global"),
  })).default([]).description("工作区级选卡映射（最长路径边界匹配）"),
  // volatile：宿主 settings 服务只收纳「schema 里至少一个 meta.volatile 字段」的
  // 命名空间（dsh-settings describe()）；标记后值以 cosmokit volatile 引用交给插件，
  // 读取处经 unwrapVolatile 解包。语义＝宿主热提交该字段、不重载插件。
  budgets: budgetObject().volatile().description("L0/L1/L2 预算（宿主热提交，不重载插件；下次插件重载/宿主重启后生效）"),
  l2: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }).description("L2 闪回自动投递开关"),
  organize: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }).description("整理（候选/计划/执行）开关"),
  forgetting: z.object({
    enabled: z.boolean().default(false).description("遗忘（分析/计划/执行）开关；显式 includeArchived 冷搜不受此开关限制"),
    policy: z.object({
      baseHalfLifeDays: z.number().default(30),
      maxHalfLifeDays: z.number().default(240),
      archiveScore: z.number().default(0.25),
    }).default({ baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 }),
  }).default({ enabled: false, policy: { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 } }).description("双轨遗忘"),
});

// ---------------------------------------------------------------------------
// 字段级校验（own-property 语义；未知键一律拒绝）
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set([
  "mode", "allowActive", "dataRoot", "stateRoot", "ownerId", "defaultPersona",
  "sessionPersonas", "workspacePersonas", "budgets", "l2", "organize", "forgetting",
]);

function requireBoolean(value, name) {
  if (typeof value !== "boolean") fail(`${name} must be a boolean, got ${String(value)}`);
  return value;
}

function requireNonEmptyString(value, name) {
  if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

function requirePersona(value, name) {
  if (value === null) return null;
  return requireNonEmptyString(value, name);
}

function requireMappingList(value, name, checkEntry) {
  if (!Array.isArray(value)) fail(`${name} must be an array`);
  const out = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) fail(`${name} entries must be plain objects`);
    out.push(checkEntry(entry));
  }
  return out;
}

// 会话映射：{sessionId: nonemptyString, persona: string|null}，未知键拒绝
function sessionMapping(entry) {
  const keys = Object.keys(entry);
  if (!keys.includes("sessionId")) fail(`sessionPersonas entry is missing "sessionId"`);
  if (!keys.includes("persona")) fail(`sessionPersonas entry is missing "persona"`);
  for (const key of keys) {
    if (key !== "sessionId" && key !== "persona") fail(`sessionPersonas entry has unknown property "${key}"`);
  }
  return { sessionId: requireNonEmptyString(entry.sessionId, "sessionPersonas.sessionId"), persona: requirePersona(entry.persona, "sessionPersonas.persona") };
}

// 工作区映射：{workspace: absolutePath, persona: string|null}，未知键拒绝
function workspaceMapping(entry) {
  const keys = Object.keys(entry);
  if (!keys.includes("workspace")) fail(`workspacePersonas entry is missing "workspace"`);
  if (!keys.includes("persona")) fail(`workspacePersonas entry is missing "persona"`);
  for (const key of keys) {
    if (key !== "workspace" && key !== "persona") fail(`workspacePersonas entry has unknown property "${key}"`);
  }
  const workspace = requireNonEmptyString(entry.workspace, "workspacePersonas.workspace");
  if (!isAbsolute(workspace)) fail(`workspacePersonas.workspace must be an absolute path, got "${workspace}"`);
  return { workspace, persona: requirePersona(entry.persona, "workspacePersonas.persona") };
}

/** Q 生产配置额外强制安全上限（CONTRACTS §2：可向下调，仍须满足 validateConfig 关系）。 */
export const BUDGET_CEILINGS = Object.freeze({
  // 人设卡上限：插件是公开分发的，别人的人设卡可能远长于本机（12000 曾把
  // 长卡用户挡在门外）。上限抬到 60000，默认值仍是 DEFAULT_CONFIG 的 12000。
  persona: Object.freeze({ maxChars: 60000 }),
  spark: Object.freeze({ maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 }),
});

function normalizeBudgets(value) {
  const source = value === undefined ? clone(DEFAULT_CONFIG) : value;
  if (!isPlainRecord(source)) fail(`budgets must be a plain object`);
  // 未知顶层段拒绝（core/persona/spark 之外的段不接受）
  for (const key of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) fail(`budgets has unknown section "${key}"`);
  }
  const ceilings = [];
  if (source.persona !== undefined && source.persona.maxChars > BUDGET_CEILINGS.persona.maxChars) {
    ceilings.push(`budgets.persona.maxChars (${source.persona.maxChars}) exceeds ceiling ${BUDGET_CEILINGS.persona.maxChars}`);
  }
  if (source.spark !== undefined && isPlainRecord(source.spark)) {
    for (const [key, ceiling] of Object.entries(BUDGET_CEILINGS.spark)) {
      const v = source.spark[key];
      if (typeof v === "number" && v > ceiling) ceilings.push(`budgets.spark.${key} (${v}) exceeds ceiling ${ceiling}`);
    }
  }
  if (ceilings.length > 0) fail(ceilings.join("; "));
  // 交由既有基线校验：段内未知键、类型、正整数、softRatio<hardRatio、inline<=max、seed+link<=maxCards、水位关系
  return validateConfig(source);
}

function normalizeSwitch(value, name) {
  if (value === undefined) return { enabled: false };
  if (!isPlainRecord(value)) fail(`${name} must be a plain object`);
  for (const key of Object.keys(value)) {
    if (key !== "enabled") fail(`${name} has unknown property "${key}"`);
  }
  if (!Object.hasOwn(value, "enabled")) fail(`${name} is missing "enabled"`);
  return { enabled: requireBoolean(value.enabled, `${name}.enabled`) };
}

function normalizeForgetting(value) {
  if (value === undefined) {
    return { enabled: false, policy: normalizeForgetPolicy({}) };
  }
  if (!isPlainRecord(value)) fail(`forgetting must be a plain object`);
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "policy") fail(`forgetting has unknown property "${key}"`);
  }
  if (!Object.hasOwn(value, "enabled")) fail(`forgetting is missing "enabled"`);
  const enabled = requireBoolean(value.enabled, "forgetting.enabled");
  const policy = value.policy === undefined ? normalizeForgetPolicy({}) : normalizeForgetPolicy(value.policy);
  return { enabled, policy };
}

// ---------------------------------------------------------------------------
// 根目录：字符串级校验 + profileRoot 可信默认
// ---------------------------------------------------------------------------

function normalizeRoot(value, name) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) fail(`${name} must be an absolute path string or null`);
  if (!isAbsolute(value)) fail(`${name} must be an absolute path, got "${value}"`);
  // 规范化为平台统一分隔符形式（折叠重复分隔符 / 收缩 ..），并去掉尾随分隔符；
  // 盘根保留自身分隔符（"C:\" 是合法绝对根，剥掉会退化成 drive-relative 的 "C:"）。
  let canonical = normalize(value);
  while (canonical.endsWith(sep) && isAbsolute(canonical.slice(0, -1))) {
    canonical = canonical.slice(0, -1);
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// normalizePluginConfig
// ---------------------------------------------------------------------------

/**
 * 规范化插件设置（权威入口）。不修改输入；非法整体抛带 .code 的 Error，不部分提交。
 *
 * @param {object} raw 宿主传入的原始配置（允许部分缺省）。
 * @param {{profileRoot?: string}} [options] 仅当宿主 bootstrap 证明可信时传入的
 *   profile 根；两者皆 null 时允许计算并列 shiori-data / shiori-state。默认不传。
 * @returns {Readonly<object>} 冻结的完整设置对象（CONTRACTS §2 settings 形状）。
 */
export function normalizePluginConfig(raw, { profileRoot } = {}) {
  if (raw === undefined || raw === null) raw = {};
  if (!isPlainRecord(raw)) fail(`config must be a plain object`);
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`config has unknown top-level property "${key}"`);
  }

  const mode = raw.mode === undefined ? "shadow" : raw.mode;
  if (mode !== "shadow" && mode !== "active") fail(`mode must be "shadow" or "active", got ${String(mode)}`);
  const allowActive = raw.allowActive === undefined ? false : requireBoolean(raw.allowActive, "allowActive");

  let dataRoot = normalizeRoot(raw.dataRoot, "dataRoot");
  let stateRoot = normalizeRoot(raw.stateRoot, "stateRoot");
  const rootsProvided = dataRoot !== null || stateRoot !== null;

  if (profileRoot !== undefined) {
    if (typeof profileRoot !== "string" || !isAbsolute(profileRoot)) {
      fail(`options.profileRoot, when provided, must be an absolute path`);
    }
    if (!rootsProvided) {
      // 仅可信 profile bootstrap 才允许并列默认根；一旦计算即不再是 inert。
      dataRoot = join(profileRoot, "shiori-data");
      stateRoot = join(profileRoot, "shiori-state");
    }
  }

  if (rootsProvided || profileRoot !== undefined) {
    if (dataRoot === null || stateRoot === null) {
      fail(`dataRoot and stateRoot must both be provided explicitly once either is configured`);
    }
    const relation = textualRootRelation(dataRoot, stateRoot);
    if (relation !== "disjoint") {
      fail(`dataRoot and stateRoot must be absolute, disjoint and non-nested (${relation}: "${dataRoot}" / "${stateRoot}")`);
    }
  }
  if (mode === "active") {
    if (!allowActive) fail(`mode "active" requires allowActive === true`);
    if (dataRoot === null || stateRoot === null) {
      fail(`mode "active" requires both dataRoot and stateRoot to be configured`);
    }
  }

  const ownerId = raw.ownerId === undefined ? "local" : requireNonEmptyString(raw.ownerId, "ownerId");
  const defaultPersona = raw.defaultPersona === undefined ? null : requirePersona(raw.defaultPersona, "defaultPersona");
  const sessionPersonas = raw.sessionPersonas === undefined
    ? []
    : requireMappingList(raw.sessionPersonas, "sessionPersonas", sessionMapping);
  const workspacePersonas = raw.workspacePersonas === undefined
    ? []
    : requireMappingList(raw.workspacePersonas, "workspacePersonas", workspaceMapping);
  // budgets 在宿主侧是 volatile 引用对象（见 unwrapVolatile）；解包后再做权威校验。
  const budgets = normalizeBudgets(unwrapVolatile(raw.budgets));
  const l2 = normalizeSwitch(raw.l2, "l2");
  const organize = normalizeSwitch(raw.organize, "organize");
  const forgetting = normalizeForgetting(raw.forgetting);

  return deepFreeze({
    mode,
    allowActive,
    dataRoot,
    stateRoot,
    ownerId,
    defaultPersona,
    sessionPersonas: Object.freeze(sessionPersonas.map(Object.freeze)),
    workspacePersonas: Object.freeze(workspacePersonas.map(Object.freeze)),
    budgets,
    l2: Object.freeze(l2),
    organize: Object.freeze(organize),
    forgetting: Object.freeze(forgetting),
  });
}

// ---------------------------------------------------------------------------
// verifyPluginRoots：apply 阶段真实文件系统校验（真实 link 解析后仍不嵌套）
// ---------------------------------------------------------------------------

// 沿已存在的最近祖先做 realpath，再拼回不存在尾部：得到「按当前文件系统解析」的绝对路径。
function resolveWithLinks(target) {
  let current = target;
  const tail = [];
  for (;;) {
    try {
      const resolved = realpathSync(current);
      return tail.length === 0 ? resolved : join(resolved, ...tail);
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        const wrapped = new Error(`cannot resolve "${target}": ${String(error.message || error)}`);
        wrapped.code = "INVALID_INPUT";
        throw wrapped;
      }
      const parent = dirname(current);
      if (parent === current) return target; // 到盘根仍不存在：按字面路径返回
      tail.unshift(basename(current));
      current = parent;
    }
  }
}

const CASE_INSENSITIVE_FS = process.platform === "win32";

// 把路径折算成可比较形式：normalize（统一分隔符、折叠重复、收缩 ..）后去掉全部
// 尾部分隔符（盘根折叠为裸盘符，POSIX 根 "/" 折叠为 ""），win32 再统一小写。
// 此后「相等 / 嵌套 / 不相交」的判定只在这一种 canonical 形状上进行，盘根、
// 混排分隔符、尾随分隔符不再有特例。
function comparableRoot(value) {
  let normalized = normalize(value);
  if (CASE_INSENSITIVE_FS) normalized = normalized.toLowerCase();
  while (normalized.endsWith(sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// 比较两个路径（词法或已解析均可，本函数不触碰文件系统）：
// equal / nested（任一包含另一）/ disjoint。
// 嵌套判定要求被包含方的 canonical 形状再加一个分隔符是包含方的前缀：
// "d:" + sep = "d:\" 是 "d:\ai" 的前缀 ⇒ 盘根包含其下任意目录；
// "d:\work" + sep = "d:\work\" 不是 "d:\workshop" 的前缀 ⇒ 同名前缀目录不相交。
function textualRootRelation(a, b) {
  const left = comparableRoot(a);
  const right = comparableRoot(b);
  if (left === right) return "equal";
  if (left.startsWith(right + sep) || right.startsWith(left + sep)) return "nested";
  return "disjoint";
}

/**
 * apply 阶段统一真实路径校验：真实 link（junction/symlink）解析后仍要求绝对、
 * 互不嵌套。inert（两根皆 null）直接通过并标记。失败抛带 .code 的 Error。
 *
 * @param {object} settings normalizePluginConfig 的返回值。
 * @returns {{inert: boolean, dataRoot: string|null, stateRoot: string|null}}
 */
export function verifyPluginRoots(settings) {
  const { dataRoot, stateRoot } = settings;
  if (dataRoot === null && stateRoot === null) {
    return { inert: true, dataRoot: null, stateRoot: null };
  }
  if (dataRoot === null || stateRoot === null) {
    fail(`verifyPluginRoots requires both roots to be configured`);
  }
  const resolvedData = resolveWithLinks(dataRoot);
  const resolvedState = resolveWithLinks(stateRoot);
  const relation = textualRootRelation(resolvedData, resolvedState);
  if (relation !== "disjoint") {
    fail(`dataRoot and stateRoot overlap after resolving real links (${relation}: "${resolvedData}" / "${resolvedState}")`);
  }
  return { inert: false, dataRoot: resolvedData, stateRoot: resolvedState };
}
