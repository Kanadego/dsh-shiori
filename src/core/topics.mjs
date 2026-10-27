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
// Topic 形状：{key,title,summary,scopeId,revision,updated,body?}。
// body 之外的字段全部必填；summary ≤60 UTF-16 且不得含换行（会破坏索引行结构）；
// 允许未知字段以保持数据前向兼容（Topic 是数据记录，不是控制接口）。

import { fail, describe, requireObject, requireExactKeys } from "./errors.mjs";
import { validateKey } from "./keys.mjs";

// DESIGN §10 目录布局 scopes/global/ 即共享作用域，因此字面量 "global"
// 标记全局专题；B/C 必须使用同一字面量（见 REPORT.md 集成约定）。
export const GLOBAL_SCOPE_ID = "global";

export const SUMMARY_MAX_CHARS = 60;
const MAX_SCOPE_ID_CHARS = 128;

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
