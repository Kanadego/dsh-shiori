// Shiori P0-CORE · 作用域可见性与 Topic 元数据校验。
// 公共契约导出 selectVisibleTopics；validateTopic/validateScopeId/compareKeys
// 为 render 与本模块共用的内部助手（不进公共入口）。
//
// 可见性规则（CONTRACTS §A / DESIGN §4.4、§10）：
// - scopeId === activeScopeId 或 scopeId === "global" 的专题可见；
// - 同 key 时 active 覆盖 global；
// - 其他 scope 一律不可见；
// - 相同 key 可在不同 scope 并存，但同一 scope 内重复 key 是数据错误，拒绝；
// - 输出按 key 的 UTF-16 码元序稳定排序，绝不依赖系统 locale。
//
// Topic 形状：{key,title,summary,scopeId,revision,updated,body?,archivedAt?,
//              group?,pinned?,retention?,archiveOrigin?}。
// body 之外的字段全部必填；summary ≤60 UTF-16 且不得含换行（会破坏索引行结构）；
// group/pinned 为 0.4 S3 新增可选分组元数据（缺省读取补 [] / false，不回写磁盘，
// 老文件行为不变）；retention/archiveOrigin 为 0.5 批次 2 A 线新增可选保留策略
// 元数据（缺省读取补 standing / manual，不回写磁盘）；允许未知字段以保持数据
// 前向兼容（Topic 是数据记录，不是控制接口）。

import { fail, describe, show, requireObject, requireExactKeys } from "./errors.mjs";
import { validateKey } from "./keys.mjs";

// DESIGN §10 目录布局 scopes/global/ 即共享作用域，因此字面量 "global"
// 标记全局专题；B/C 必须使用同一字面量（见 REPORT.md 集成约定）。
export const GLOBAL_SCOPE_ID = "global";

export const SUMMARY_MAX_CHARS = 60;

// 0.4 S3（DESIGN §S3.1）：group 软上限——首个是主组（计数/摘要），其余为兼属。
// 超出不拒绝（软约束，只提示），调用方用 groupSoftLimitWarning 取提示文案。
export const GROUP_SOFT_LIMIT = 3;

// 0.5 批次 2 A 线（0.5-DEV-PLAN §5 阶段 A.1）：保留策略字段。
// retention：数据保留档位——standing = 常驻（进 L1 索引的正常活跃专题），
// historical = 历史档（温度引擎后续自动冷却的候选人群，本模块只管形状）。
// archiveOrigin：归档来源——manual = 人工归档，auto-inactive = 自动冷却归档
// （阶段 C 落地）；已有 archivedAt 但没有来源的旧文件按 manual 读（缺省即人工）。
// 两个枚举深度冻结：调用方引同一份常量，杜绝副本漂移。
export const RETENTION_VALUES = Object.freeze(["standing", "historical"]);
export const ARCHIVE_ORIGIN_VALUES = Object.freeze(["manual", "auto-inactive"]);
export const DEFAULT_RETENTION = "standing";
export const DEFAULT_ARCHIVE_ORIGIN = "manual";

const MAX_SCOPE_ID_CHARS = 128;

/** retention 枚举校验：合法返回原值，非法 fail("INVALID_INPUT")，不静默纠正。 */
export function validateRetention(value, where = "retention") {
  if (!RETENTION_VALUES.includes(value)) {
    fail(
      "INVALID_INPUT",
      `${where} must be one of ${RETENTION_VALUES.map((v) => JSON.stringify(v)).join(" | ")}, got ${show(value)}`,
    );
  }
  return value;
}

/** archiveOrigin 枚举校验：合法返回原值，非法 fail("INVALID_INPUT")，不静默纠正。 */
export function validateArchiveOrigin(value, where = "archiveOrigin") {
  if (!ARCHIVE_ORIGIN_VALUES.includes(value)) {
    fail(
      "INVALID_INPUT",
      `${where} must be one of ${ARCHIVE_ORIGIN_VALUES.map((v) => JSON.stringify(v)).join(" | ")}, got ${show(value)}`,
    );
  }
  return value;
}

/**
 * 生效 retention 解析（0.5 批次 2 A 线）：topic 显式值覆盖组级默认值，
 * 两者都缺省 = standing。
 * - groupEntry 是 groups.json 的组条目（归一化或原始形状均可，未知字段不在此
 *   消费——保持组清单的未知键容错口径）；带 retention 策略时按枚举校验，
 *   非法策略值 fail("INVALID_INPUT")，绝不静默回退默认。
 * - topic 显式值缺省/无 topic 时返回组策略（无则 standing）；
 *   topic 显式值非法同样拒绝（数据错误不该被组策略掩盖）。
 */
export function resolveRetention(topic, groupEntry) {
  const policy =
    groupEntry === undefined || groupEntry === null ? undefined : groupEntry.retention;
  if (policy !== undefined) validateRetention(policy, "group retention policy");
  if (topic?.retention !== undefined) return validateRetention(topic.retention, "topic retention");
  return policy ?? DEFAULT_RETENTION;
}

/** group 超软上限时的提示文案；未超上限或无 group 字段返回 null。 */
export function groupSoftLimitWarning(topic) {
  if (Array.isArray(topic?.group) && topic.group.length > GROUP_SOFT_LIMIT) {
    return `topic "${topic.key}" 挂载 ${topic.group.length} 个组，超过软上限 ${GROUP_SOFT_LIMIT}（主组为 "${topic.group[0]}"）`;
  }
  return null;
}

export function validateScopeId(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_INPUT", `${name} must be a non-empty string, got ${describe(value)}`);
  }
  if (value.length > MAX_SCOPE_ID_CHARS) {
    fail("INVALID_INPUT", `${name} must be at most ${MAX_SCOPE_ID_CHARS} UTF-16 chars, got ${value.length}`);
  }
  if (value !== value.trim()) {
    fail("INVALID_INPUT", `${name} must not start or end with whitespace`);
  }
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      fail("INVALID_INPUT", `${name} must not contain lone surrogate code units`);
    }
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      fail("INVALID_INPUT", `${name} must not contain control characters`);
    }
  }
  return value;
}

// locale 无关的 key 比较：直接按 UTF-16 码元比较，结果跨平台逐字一致。
export function compareKeys(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function validateTopic(topic, where) {
  requireObject(topic, where);
  const required = ["key", "title", "summary", "scopeId", "revision", "updated"];
  // 必填字段必须是自有属性：仅存在于原型链上的字段不算数
  for (const field of required) {
    if (!Object.prototype.hasOwnProperty.call(topic, field)) {
      fail("INVALID_INPUT", `${where} is missing required property "${field}"`);
    }
  }
  try {
    validateKey(topic.key);
  } catch (error) {
    fail("INVALID_INPUT", `${where}: ${error.message}`);
  }
  if (typeof topic.title !== "string" || topic.title.length === 0) {
    fail("INVALID_INPUT", `${where}: title must be a non-empty string`);
  }
  if (typeof topic.summary !== "string") {
    fail("INVALID_INPUT", `${where}: summary must be a string`);
  }
  if (topic.summary.length > SUMMARY_MAX_CHARS) {
    fail(
      "INVALID_INPUT",
      `${where}: summary is ${topic.summary.length} UTF-16 chars, max is ${SUMMARY_MAX_CHARS}`,
    );
  }
  if (topic.summary.includes("\n") || topic.summary.includes("\r")) {
    fail("INVALID_INPUT", `${where}: summary must not contain line breaks`);
  }
  validateScopeId(topic.scopeId, `${where}: scopeId`);
  if (typeof topic.revision !== "string" || topic.revision.length === 0) {
    fail("INVALID_INPUT", `${where}: revision must be a non-empty string`);
  }
  const updated = topic.updated;
  const updatedOk =
    (typeof updated === "string" && updated.length > 0) ||
    (typeof updated === "number" && Number.isFinite(updated)) ||
    (updated instanceof Date && Number.isFinite(updated.getTime()));
  if (!updatedOk) {
    fail("INVALID_INPUT", `${where}: updated must be a non-empty string, a finite number, or a valid Date`);
  }
  if (topic.body !== undefined && typeof topic.body !== "string") {
    fail("INVALID_INPUT", `${where}: body must be a string when present`);
  }
  // 归档标记（可选）：有值即归档（ISO 时间串），缺省/空 = 未归档；
  // 老文件没有该字段，行为不变（DESIGN §2.1 已定方案）。
  if (topic.archivedAt !== undefined) {
    if (typeof topic.archivedAt !== "string" || topic.archivedAt.length === 0) {
      fail("INVALID_INPUT", `${where}: archivedAt must be a non-empty string when present`);
    }
    if (topic.archivedAt.includes("\n") || topic.archivedAt.includes("\r")) {
      fail("INVALID_INPUT", `${where}: archivedAt must not contain line breaks`);
    }
  }
  // 分组元数据（0.4 S3，可选）：group 是组 key 数组（首个是主组，软上限
  // GROUP_SOFT_LIMIT，超出不在此拒绝）；pinned 是布尔钉住标记。老文件没有
  // 这两个字段 = 未分组、不钉住，行为不变；读取侧补默认值（[] / false），
  // 不回写磁盘。组 key 是否存在于 groups.json 由组清单层（groups.mjs）
  // 校验——本模块只做形状与 key 字符规范校验（与 topic key 同一规则）。
  if (topic.group !== undefined) {
    if (!Array.isArray(topic.group)) {
      fail("INVALID_INPUT", `${where}: group must be an array of group keys when present`);
    }
    const seenGroups = new Set();
    for (let i = 0; i < topic.group.length; i++) {
      const groupKey = topic.group[i];
      if (typeof groupKey !== "string" || groupKey.length === 0) {
        fail("INVALID_INPUT", `${where}: group[${i}] must be a non-empty string`);
      }
      try {
        validateKey(groupKey);
      } catch (error) {
        fail("INVALID_INPUT", `${where}: group[${i}]: ${error.message}`);
      }
      if (seenGroups.has(groupKey)) {
        fail("INVALID_INPUT", `${where}: group contains duplicate key "${groupKey}"`);
      }
      seenGroups.add(groupKey);
    }
  }
  if (topic.pinned !== undefined && typeof topic.pinned !== "boolean") {
    fail("INVALID_INPUT", `${where}: pinned must be a boolean when present`);
  }
  // 保留策略字段（0.5 批次 2 A 线，可选）：缺省 = standing / manual（读取侧由
  // frontmatter 补默认值，本模块只校验形状，不注入、不回写磁盘）；非法枚举值
  // 一律 INVALID_INPUT（不许静默纠正）。老数据没有这两个字段，行为不变。
  if (topic.retention !== undefined) {
    validateRetention(topic.retention, `${where}: retention`);
  }
  if (topic.archiveOrigin !== undefined) {
    validateArchiveOrigin(topic.archiveOrigin, `${where}: archiveOrigin`);
  }
  return topic;
}

export function selectVisibleTopics(input) {
  requireObject(input, "selectVisibleTopics input");
  requireExactKeys(input, "selectVisibleTopics input", ["activeScopeId", "topics"]);
  validateScopeId(input.activeScopeId, "activeScopeId");
  if (!Array.isArray(input.topics)) {
    fail("INVALID_INPUT", `topics must be an array, got ${describe(input.topics)}`);
  }

  // 全部输入（含不可见 scope）都做完整校验：坏数据即刻显式失败，
  // 不静默跳过。同一 scope 内重复 key 是存储层错误。
  // 用索引循环而非 forEach：稀疏数组的孔（undefined）必须进入校验，
  // 不允许被跳孔逻辑静默当成无 topic。
  const seenScopeKeys = new Set();
  const activeByKey = new Map();
  const globalByKey = new Map();
  for (let index = 0; index < input.topics.length; index++) {
    const topic = validateTopic(input.topics[index], `topics[${index}]`);
    const scopeKey = `${topic.scopeId}\u0000${topic.key}`;
    if (seenScopeKeys.has(scopeKey)) {
      fail(
        "INVALID_INPUT",
        `duplicate topic key "${topic.key}" within scope "${topic.scopeId}" (topics[${index}])`,
      );
    }
    seenScopeKeys.add(scopeKey);
    if (topic.scopeId === input.activeScopeId) {
      activeByKey.set(topic.key, topic);
    } else if (topic.scopeId === GLOBAL_SCOPE_ID) {
      globalByKey.set(topic.key, topic);
    }
  }

  // 同 key：active 覆盖 global（activeScopeId 为 "global" 时自然退化为仅全局）。
  const visibleByKey = new Map(globalByKey);
  for (const [key, topic] of activeByKey) visibleByKey.set(key, topic);
  return [...visibleByKey.values()].sort((a, b) => compareKeys(a.key, b.key));
}
