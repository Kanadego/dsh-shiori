// Shiori P5-Q · 原生插件配置（公共契约导出 Config / normalizePluginConfig / verifyPluginRoots）。
//
// 职责边界（CONTRACTS §2）：
//   - Config：原生 Schemastery schema，供宿主 settings UI / Cordis 装配解析静态结构；
//     它只证明「可序列化结构 + 默认值」，不证明路径安全，不替代 normalize；
//   - normalizePluginConfig：权威规范化。未知键拒绝；缺省 mode=shadow / allowActive=false /
//     defaultPersona=null / 两个 persona 映射=[] / l2、organize、forgetting.enabled=false /
//     ownerId='local' / dataRoot=stateRoot=null；预算经 core/validateConfig 全关系校验
//     （0.2 U2 起水位 softChars/hardChars 为权威：老配置只有 ratio 时按
//     hardCapChars × ratio 四舍五入换算，输出里 ratio 一律由水位回推保持同源），
//     semantic 段为 F1 方案 C 的接口预留（F1b 起 local 接真实本地 embedding：
//     provider=none 仍零依赖零网络；local 新增 dtype/cacheDir/mirror 三字段），
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

// semantic 段默认值（F1 方案 C 接口预留，字段名冻结；F1b 新增 local.dtype /
// cacheDir / mirror 三字段）：provider=none 时零依赖、零网络、行为与 0.1 一致。
// schema 默认与 normalize 权威默认共用这一份。
// model 默认必须是完整仓库 id（org/name）：transformers.js 按 id 从镜像下载，
// 短名 "bge-small-zh-v1.5" 不是合法仓库、会 404（spike 实测用的就是 Xenova/ 前缀）。
const DEFAULT_SEMANTIC = deepFreeze({
  provider: "none",
  // 语义召回置信度下限（余弦）。F1b 校准值 0.45 偏宽：24 条夹具实测 0.45 命中 21/24
  // 但额外捞进 17 张卡，0.55 是 17/24 命中 / 仅多 6 张卡的折中；0.70 起等价于纯字面。
  // 想更严或更松改这里即可（无需改代码），0.01–1 之间的小数。
  minSimilarity: 0.55,
  local: {
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "fp32",
    cacheDir: "",
    mirror: "https://hf-mirror.com/",
  },
  api: { endpoint: null, keyRef: null },
});

// 水位默认值：由默认占比 × 默认硬顶四舍五入派生，不写死常数（U2 产出 4）。
// DEFAULT_CONFIG.core 本身不含水位字段（属 core 契约，不在本批改动范围），
// 这里在其副本上补齐派生默认值。
function derivedWaterDefaults() {
  const core = clone(DEFAULT_CONFIG.core);
  core.softChars = Math.round(core.hardCapChars * core.softRatio);
  core.hardChars = Math.round(core.hardCapChars * core.hardRatio);
  return core;
}

function defaultBudgets() {
  const defaults = clone(DEFAULT_CONFIG);
  defaults.core = derivedWaterDefaults();
  return defaults;
}

function budgetObject() {
  return z.object({
    core: z.object({
      targetChars: z.natural().default(DEFAULT_CONFIG.core.targetChars),
      hardCapChars: z.natural().default(DEFAULT_CONFIG.core.hardCapChars),
      softRatio: z.number().default(DEFAULT_CONFIG.core.softRatio),
      hardRatio: z.number().default(DEFAULT_CONFIG.core.hardRatio),
      // 这两个字段不能给静态默认值：schema 默认一旦落进配置，就会在用户改了
      // hardCapChars 时顶替「按新硬顶派生」的水位（默认硬顶 10000 算出的
      // 7500/9000 会盖掉 20000 硬顶该有的 12000/18000），启动时报
      // core.targetChars must be < derived hardAt 直接起不来。
      // 缺省交给 normalizeBudgets 按真实 hardCapChars × ratio 派生。
      softChars: z.natural()
        .description("软水位（字符数）；缺省按 softRatio × hardCapChars 派生，显式给出则权威"),
      hardChars: z.natural()
        .description("硬水位（字符数）；缺省按 hardRatio × hardCapChars 派生，显式给出则权威"),
      cacheLockFallback: z.boolean().default(DEFAULT_CONFIG.core.cacheLockFallback),
    }).default(derivedWaterDefaults()),
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
  }).default(defaultBudgets());
}

/**
 * 把插件层 budgets（含 U2 权威水位 softChars/hardChars）裁剪成 core validateConfig
 * 认识的形状。水位不是 core 契约字段（core/config.mjs 的 section() 拒绝未知键），
 * 任何把 budgets 喂给 core（createShioriService / organize executor / compat tools）
 * 的地方都必须先过这里。
 */
export function coreBudgetsOf(budgets) {
  const core = { ...(budgets?.core ?? {}) };
  delete core.softChars;
  delete core.hardChars;
  return { ...budgets, core };
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
  // F1 方案 C 接口预留（字段名冻结，玄砚按此对接）：本期只定契约，不实现召回。
  semantic: z.object({
    provider: z.union([z.const("none"), z.const("local"), z.const("api")]).default("none")
      .description("语义召回提供方：none=关闭（默认，零依赖零网络）；local=本地 embedding；api=外部接口（本期仅预留）"),
    local: z.object({
      model: z.string().default("Xenova/bge-small-zh-v1.5").description("本地 embedding 模型的完整仓库 id（org/name，默认 Xenova/bge-small-zh-v1.5；开启 local 后才会触发一次性模型下载）"),
      dims: z.natural().default(512).description("向量维度"),
      dtype: z.union([z.const("fp32"), z.const("fp16"), z.const("q8")]).default("fp32")
        .description("ONNX 推理精度：fp32=精度基线（91MB）；fp16=折中；q8=最小最快（23MB，短文本 p95 约 4ms）"),
      cacheDir: z.string().default("").description("模型缓存目录；空字符串表示用 <stateRoot>/semantic/models"),
      mirror: z.string().default("https://hf-mirror.com/").description("HuggingFace 镜像地址（国内直连 huggingface.co 一般不可达）"),
    }).default({ model: "Xenova/bge-small-zh-v1.5", dims: 512, dtype: "fp32", cacheDir: "", mirror: "https://hf-mirror.com/" }),
    minSimilarity: z.number().default(0.55)
      .description("语义召回置信度下限（余弦相似度，0.01–1）：越大越严。实测 0.45 命中多但噪声大、0.70 起等价纯字面"),
    api: z.object({
      endpoint: nullableString().default(null).description("外部 embedding 接口地址；null=未配置"),
      keyRef: nullableString().default(null).description("密钥引用名（不存明文密钥）；null=未配置"),
    }).default({ endpoint: null, keyRef: null }),
  }).default(clone(DEFAULT_SEMANTIC)).description("语义召回接口预留（F1 方案 C）：本期只定契约，不实现召回"),
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
  "semantic",
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

// 自然数（0 或正整数）校验，中文报错（U2 产出 4：水位字段越界一律中文提示）。
function requireNaturalChars(value, name) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${name} 必须是自然数（0 或正整数），当前为 ${String(value)}`);
  }
  return value;
}

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

  // ── U2 水位契约：softChars / hardChars（字符数）为权威，ratio 为派生值 ──────
  // 老配置兼容读：只有 softRatio / hardRatio 时按 hardCapChars × ratio 四舍五入
  // 换算成水位，不报错；两者都提供时水位优先（面板保存时会清掉 ratio，避免双源真相）。
  const coreIn = source.core === undefined ? {} : source.core;
  if (!isPlainRecord(coreIn)) fail(`budgets.core must be a plain object`);
  const hardCapChars = coreIn.hardCapChars === undefined
    ? DEFAULT_CONFIG.core.hardCapChars
    : coreIn.hardCapChars;
  // 派生依赖硬顶做乘法，先确认它是正整数（类型错误仍按既有英文口径报，与
  // validateConfig 一致），避免 NaN 混进水位。
  if (typeof hardCapChars !== "number" || !Number.isInteger(hardCapChars) || hardCapChars <= 0) {
    fail(`budgets.core.hardCapChars must be a positive integer, got ${String(hardCapChars)}`);
  }
  const deriveWater = (charsKey, ratioKey, defaultRatio) => {
    if (coreIn[charsKey] !== undefined) {
      return requireNaturalChars(coreIn[charsKey], `budgets.core.${charsKey}（${charsKey === "softChars" ? "软" : "硬"}水位字符数）`);
    }
    const ratio = coreIn[ratioKey] === undefined ? defaultRatio : coreIn[ratioKey];
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) {
      fail(`budgets.core.${ratioKey} must be a finite number, got ${String(ratio)}`);
    }
    return Math.round(hardCapChars * ratio);
  };
  const softChars = deriveWater("softChars", "softRatio", DEFAULT_CONFIG.core.softRatio);
  const hardChars = deriveWater("hardChars", "hardRatio", DEFAULT_CONFIG.core.hardRatio);
  // 0 与等值都必须在这里挡住：面板侧 schema 是 z.natural（允许 0），真正拒绝
  // 发生在 core/validateConfig，那时抛的是英文、且配置已经落盘——重启即告警。
  if (softChars < 1) {
    fail(`软水位（${softChars} 字符）至少为 1 字符：0 会被换算成 0 比例，core 直接拒绝加载。`);
  }
  if (hardChars < 2) {
    fail(`硬水位（${hardChars} 字符）至少为 2 字符：它必须严格大于软水位。`);
  }
  if (softChars >= hardChars) {
    fail(`软水位（${softChars} 字符）必须小于硬水位（${hardChars} 字符）：相等会让 core 的 softRatio < hardRatio 校验失败。`);
  }
  if (hardChars > hardCapChars) {
    fail(`硬水位（${hardChars} 字符）不能超过硬顶 hardCapChars（${hardCapChars} 字符）。`);
  }
  if (hardChars === hardCapChars) {
    // 需求写作 hardChars ≤ hardCapChars，但 core/validateConfig 的既有硬约束是
    // hardAt < hardCapChars（硬闸之上要保留「超限」判定空间，DESIGN §5.1.1），
    // 该约束不在本批白名单内、无法放开——等于硬顶按越界处理，中文说明原因。
    fail(`硬水位（${hardChars} 字符）必须小于硬顶 hardCapChars（${hardCapChars} 字符）：硬闸之上需要保留超限判定的空间。`);
  }

  // validateConfig（core 契约，本批不可改）仍按 ratio 推水位做整体关系校验：
  // 用水位回推 ratio 喂给它，保证输出里 ratio 与水位同源（运行时 budget.mjs 的
  // softAt/hardAt 由 ratio 推出，必须与面板水位一致，不得分叉）。
  // targetChars 区间校验随之变为 softChars ≤ targetChars < hardChars（D3：仅区间校验）。
  const coreForValidation = { ...clone(DEFAULT_CONFIG.core), ...coreIn };
  delete coreForValidation.softChars;
  delete coreForValidation.hardChars;
  coreForValidation.softRatio = softChars / hardCapChars;
  coreForValidation.hardRatio = hardChars / hardCapChars;
  const budgets = validateConfig({ ...source, core: coreForValidation });
  // 把权威水位并回输出（validateConfig 返回形状不含新字段）。
  return deepFreeze({
    core: { ...budgets.core, softChars, hardChars },
    persona: budgets.persona,
    spark: budgets.spark,
  });
}

// ── semantic 段（F1 方案 C 接口预留 + F1b local 三字段）：provider=none 时不生效 ──
export function normalizeSemantic(value) {
  if (value === undefined) return clone(DEFAULT_SEMANTIC);
  if (!isPlainRecord(value)) fail(`semantic must be a plain object`);
  for (const key of Object.keys(value)) {
    if (key !== "provider" && key !== "local" && key !== "minSimilarity" && key !== "api") {
      fail(`semantic has unknown property "${key}"`);
    }
  }
  const provider = value.provider === undefined ? DEFAULT_SEMANTIC.provider : value.provider;
  if (provider !== "none" && provider !== "local" && provider !== "api") {
    fail(`semantic.provider must be "none", "local" or "api", got ${String(provider)}`);
  }
  let local = clone(DEFAULT_SEMANTIC.local);
  if (value.local !== undefined) {
    if (!isPlainRecord(value.local)) fail(`semantic.local must be a plain object`);
    // F1b 白名单：model / dims 之外新增 dtype / cacheDir / mirror 三字段。
    for (const key of Object.keys(value.local)) {
      if (key !== "model" && key !== "dims" && key !== "dtype" && key !== "cacheDir" && key !== "mirror") {
        fail(`semantic.local has unknown property "${key}"`);
      }
    }
    const dtype = value.local.dtype === undefined
      ? DEFAULT_SEMANTIC.local.dtype
      : value.local.dtype;
    if (dtype !== "fp32" && dtype !== "fp16" && dtype !== "q8") {
      fail(`semantic.local.dtype must be "fp32", "fp16" or "q8", got ${String(dtype)}`);
    }
    const cacheDir = value.local.cacheDir === undefined
      ? DEFAULT_SEMANTIC.local.cacheDir
      : value.local.cacheDir;
    if (typeof cacheDir !== "string") {
      fail(`semantic.local.cacheDir must be a string (empty string = use <stateRoot>/semantic/models), got ${String(cacheDir)}`);
    }
    const mirror = value.local.mirror === undefined
      ? DEFAULT_SEMANTIC.local.mirror
      : value.local.mirror;
    if (typeof mirror !== "string" || mirror.length === 0) {
      fail(`semantic.local.mirror must be a non-empty string, got ${String(mirror)}`);
    }
    local = {
      model: value.local.model === undefined
        ? DEFAULT_SEMANTIC.local.model
        : requireNonEmptyString(value.local.model, "semantic.local.model"),
      dims: value.local.dims === undefined
        ? DEFAULT_SEMANTIC.local.dims
        : requireNaturalChars(value.local.dims, "semantic.local.dims"),
      dtype,
      cacheDir,
      mirror,
    };
  }
  const minSimilarity = value.minSimilarity === undefined
    ? DEFAULT_SEMANTIC.minSimilarity
    : value.minSimilarity;
  if (typeof minSimilarity !== "number" || !Number.isFinite(minSimilarity)
    || minSimilarity <= 0 || minSimilarity > 1) {
    fail(`semantic.minSimilarity must be a number in (0, 1], got ${String(minSimilarity)}`);
  }
  let api = clone(DEFAULT_SEMANTIC.api);
  if (value.api !== undefined) {
    if (!isPlainRecord(value.api)) fail(`semantic.api must be a plain object`);
    for (const key of Object.keys(value.api)) {
      if (key !== "endpoint" && key !== "keyRef") fail(`semantic.api has unknown property "${key}"`);
    }
    const nullableRef = (raw, name) => raw === undefined || raw === null ? null : requireNonEmptyString(raw, name);
    api = {
      endpoint: nullableRef(value.api.endpoint, "semantic.api.endpoint"),
      keyRef: nullableRef(value.api.keyRef, "semantic.api.keyRef"),
    };
  }
  return { provider, minSimilarity, local, api };
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
  const semantic = normalizeSemantic(raw.semantic);

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
    semantic: Object.freeze(semantic),
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
