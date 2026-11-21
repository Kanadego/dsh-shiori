// Shiori 0.5-5C · 实体归一（resolveAlias）与图谱 sidecar 配置加载。
//
// 职责（0.5-5C 任务书模块 1；方案依据 0.5-DEV-PLAN §11.3）：
// - resolveAlias(entity, table) → canonical：大小写折叠、全半角折叠（NFKC）、
//   空白折叠，再查手写别名表（dataRoot/aliases.json），未命中回落内置小表，
//   再未命中返回归一化后的原词。只做「规范化 + 手写表」，不做自动学习
//   （表条目带 source: "manual" | "learned"，0.5 两者都读，但没有任何写入学习路径）。
// - loadAliasTable(dataRoot)：读 <dataRoot>/aliases.json（可缺失）。sidecar 语义：
//   损坏/形状不对/超限一律降级为空表 + error 留痕，绝不把图谱投影/面板打挂
//   ——别名表是人工维护的辅助配置，不是业务事实。
// - loadClusterOverrides(dataRoot, scopeId)：读 <dataRoot>/spark-clusters.json
//   人工覆盖 sidecar（只存被改过的 cardId → 簇名，按 scopeId 分桶避免跨 scope
//   误伤）。读取时覆盖派生分簇结果；卡片本体不动、不迁移。容错口径与别名表一致。
//
// 纯函数边界：resolveAlias / normalizeEntityText 零 IO；两个 loader 只读盘、
// 绝不写盘、绝不建目录（sidecar 文件由用户/后续批次的手动流程创建）。
//
// 归一化的单一事实来源：图谱投影（graph.mjs normalizeEntities）经本模块出
// canonical 实体，节点 entities / 分簇 key / 客户端着色三处同源。卡片存储
// 本体不归一（spark_save 写什么存什么）——归一只发生在投影层。

import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** sidecar 版本（结构变更时递增；不识别的版本按空表降级，不抛错）。 */
const SIDECAR_VERSION = 1;

/** 实体/别名/簇名的单段长度上限（与 store LIMITS.wordChars 同量级）。 */
const WORD_MAX_CHARS = 64;

/** 单个 sidecar 表的条目上限（手写文件防滥用；超出部分丢弃并记 error）。 */
const SIDECAR_MAX_ENTRIES = 512;

/** 别名条目允许的 source 枚举（0.5 无学习路径，learned 仅前向兼容手写）。 */
const ALIAS_SOURCES = new Set(["manual", "learned"]);

// 内置兜底别名表（常见同义写法；canonical 一律小写归一形）。
// 只收录纯拼写变体，不做语义映射（"gpt"→"openai" 这类归属判断不该由代码拍板）。
export const BUILTIN_ENTITY_ALIASES = Object.freeze({
  "js": "javascript",
  "nodejs": "node",
  "ts": "typescript",
  "py": "python",
  "py3": "python",
  "k8s": "kubernetes",
  "reactjs": "react",
  "vuejs": "vue",
});

/**
 * 实体文本归一：NFKC（全角字母/数字/符号折叠为半角，蕴含 NFC）→ trim →
 * 内部空白折叠为单空格 → 小写。非字符串输入返回 ""（调用方按脏值丢弃）。
 */
export function normalizeEntityText(entity) {
  if (typeof entity !== "string") return "";
  return entity.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * 实体归一 → canonical。
 *
 * @param {unknown} entity 原始实体词。
 * @param {Map<string, string>|null} [table] 手写别名表（normalizeEntityText 键 →
 *   canonical；loadAliasTable 产物）。null/空 Map = 只走内置表。
 * @returns {string} canonical；输入非字符串或归一后为空 → ""。
 *   单跳映射：canonical 不再过表（避免手写表成环）；手写表优先于内置表。
 */
export function resolveAlias(entity, table = null) {
  const key = normalizeEntityText(entity);
  if (key.length === 0) return "";
  if (table instanceof Map && table.size > 0) {
    const mapped = table.get(key);
    if (typeof mapped === "string" && mapped.length > 0) return mapped;
  }
  const builtin = BUILTIN_ENTITY_ALIASES[key];
  if (typeof builtin === "string" && builtin.length > 0) return builtin;
  return key;
}

/** sidecar 单文件读取的统一容错：ENOENT = 首次使用（正常），其余按降级处理。 */
async function readSidecarOrNull(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error !== null && typeof error === "object" && error.code === "ENOENT") {
      return { raw: null, error: null };
    }
    return { raw: null, error: `读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
  return { raw, error: null };
}

/** 通用解析骨架：JSON 损坏 / 非对象 / 版本不识别 → null（调用方降级为空表）。 */
function parseSidecarJson(raw, file, label) {
  if (raw === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label}不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label}顶层必须是对象`);
  }
  if (parsed.version !== SIDECAR_VERSION) {
    throw new Error(`${label}版本不识别（期望 ${SIDECAR_VERSION}，得到 ${String(parsed.version)}）`);
  }
  return parsed;
}

/**
 * 读 <dataRoot>/aliases.json 手写别名表。
 *
 * 文件形状（手写；可缺失 = 空表）：
 *   { "version": 1, "aliases": [ { "alias": "js", "canonical": "javascript", "source": "manual" } ] }
 *
 * 校验规则：alias/canonical 为非空字符串（各 ≤64 字，归一后 alias 非空）、
 * source ∈ manual|learned；归一化后 alias 重复时首条胜出（后续忽略）；单跳映射，
 * canonical 不再过表；条目上限 512（超出丢弃并记 error）。
 *
 * @param {string} dataRoot 业务数据根（绝对路径；只读）。
 * @returns {Promise<{table: Map<string, string>, error: string|null, file: string}>}
 *   table 恒非 null（损坏降级为空表）；error 非空时 table 为「已成功解析的前缀或空表」。
 */
export async function loadAliasTable(dataRoot) {
  const table = new Map();
  // 直构（测试/嵌入方）可能没有 dataRoot：sidecar 是可选辅助配置，缺根按
  // 「无表」处理，不当作故障。
  if (typeof dataRoot !== "string" || dataRoot.length === 0) {
    return { table, error: null, file: null };
  }
  const file = join(dataRoot, "aliases.json");
  const { raw, error: readError } = await readSidecarOrNull(file);
  if (raw === null) {
    return { table, error: readError, file };
  }
  let parsed;
  try {
    parsed = parseSidecarJson(raw, file, "aliases.json");
  } catch (error) {
    return { table, error: error instanceof Error ? error.message : String(error), file };
  }
  const list = parsed.aliases;
  if (!Array.isArray(list)) {
    return { table, error: "aliases.json 的 aliases 字段缺失或不是数组", file };
  }
  let error = null;
  let dropped = 0;
  for (const entry of list) {
    if (table.size >= SIDECAR_MAX_ENTRIES) {
      dropped += 1;
      continue;
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      error = error ?? "aliases 条目必须是对象";
      continue;
    }
    const keys = Object.keys(entry);
    if (keys.length !== 3 || !keys.every((k) => k === "alias" || k === "canonical" || k === "source")) {
      error = error ?? 'aliases 条目只允许恰好 alias/canonical/source 三个字段';
      continue;
    }
    const { alias, canonical, source } = entry;
    if (typeof alias !== "string" || alias.trim().length === 0 || alias.length > WORD_MAX_CHARS
      || typeof canonical !== "string" || canonical.trim().length === 0 || canonical.length > WORD_MAX_CHARS) {
      error = error ?? `alias/canonical 必须是 1..${WORD_MAX_CHARS} 字的非空字符串`;
      continue;
    }
    if (!ALIAS_SOURCES.has(source)) {
      error = error ?? `aliases 条目 source 必须是 manual 或 learned（得到 ${String(source)}）`;
      continue;
    }
    const key = normalizeEntityText(alias);
    const target = normalizeEntityText(canonical);
    if (key.length === 0 || target.length === 0) {
      error = error ?? "alias/canonical 归一化后不得为空";
      continue;
    }
    if (!table.has(key)) table.set(key, target); // 首条胜出，结果与条目顺序无关的确定性
  }
  if (dropped > 0) {
    error = error ?? `aliases 条目超过上限 ${SIDECAR_MAX_ENTRIES}，超出部分丢弃 ${dropped} 条`;
  }
  return { table, error, file };
}

/**
 * 读 <dataRoot>/spark-clusters.json 人工分簇覆盖 sidecar（0.5-5C 模块 1）。
 *
 * 文件形状（手写；可缺失 = 无覆盖；卡片本体不动、不迁移，只存被改过的卡）：
 *   { "version": 1, "scopes": { "<scopeId>": { "<cardId>": "<簇名>" } } }
 *
 * 按 scopeId 分桶：cardId 由 store 随机生成，跨 scope 撞名概率可忽略，但 sidecar
 * 是共享 dataRoot 的全局文件，分桶让语义明确（本覆盖只作用于本 scope）。
 * 值为 1..64 字的簇名（trim 后非空）；条目上限 512/scope。
 *
 * @param {string} dataRoot 业务数据根（绝对路径；只读）。
 * @param {string} scopeId 当前 scope。
 * @returns {Promise<{overrides: Map<string, string>, error: string|null, file: string}>}
 */
export async function loadClusterOverrides(dataRoot, scopeId) {
  const overrides = new Map();
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    return { overrides, error: "scopeId 必须是非空字符串", file: null };
  }
  if (typeof dataRoot !== "string" || dataRoot.length === 0) {
    return { overrides, error: null, file: null };
  }
  const file = join(dataRoot, "spark-clusters.json");
  const { raw, error: readError } = await readSidecarOrNull(file);
  if (raw === null) {
    return { overrides, error: readError, file };
  }
  let parsed;
  try {
    parsed = parseSidecarJson(raw, file, "spark-clusters.json");
  } catch (error) {
    return { overrides, error: error instanceof Error ? error.message : String(error), file };
  }
  const scopes = parsed.scopes;
  if (scopes === null || typeof scopes !== "object" || Array.isArray(scopes)) {
    return { overrides, error: "spark-clusters.json 的 scopes 字段缺失或不是对象", file };
  }
  const bucket = Object.hasOwn(scopes, scopeId) ? scopes[scopeId] : undefined;
  if (bucket === undefined) {
    return { overrides, error: null, file }; // 本 scope 无覆盖：正常
  }
  if (bucket === null || typeof bucket !== "object" || Array.isArray(bucket)) {
    return { overrides, error: `scopes["${scopeId}"] 必须是对象（cardId → 簇名）`, file };
  }
  let error = null;
  let dropped = 0;
  for (const [cardId, cluster] of Object.entries(bucket)) {
    if (overrides.size >= SIDECAR_MAX_ENTRIES) {
      dropped += 1;
      continue;
    }
    if (typeof cardId !== "string" || cardId.length === 0 || cardId.length > WORD_MAX_CHARS) {
      error = error ?? `cardId 必须是 1..${WORD_MAX_CHARS} 字的字符串`;
      continue;
    }
    if (typeof cluster !== "string" || cluster.trim().length === 0 || cluster.length > WORD_MAX_CHARS) {
      error = error ?? `卡片 "${cardId}" 的覆盖簇名必须是 1..${WORD_MAX_CHARS} 字的非空字符串`;
      continue;
    }
    overrides.set(cardId, cluster.trim());
  }
  if (dropped > 0) {
    error = error ?? `覆盖条目超过上限 ${SIDECAR_MAX_ENTRIES}，超出部分丢弃 ${dropped} 条`;
  }
  return { overrides, error, file };
}
