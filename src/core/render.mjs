// Shiori P0-CORE · L1 完整渲染（公共契约导出 renderL1）。
//
// 磁盘 core.md 只存人工正文；renderL1 在渲染时派生索引，禁止回写。
// 索引格式固定（CONTRACTS §A）：
//   标题行：## 主题记忆索引 / Topic memory index
//   条目行：- key [scopeId] — summary
//   归档钩子：另有 N 篇冷专题，memory_search 可查   ← N>0 才出现（DESIGN §2.1）
// core 非空且存在索引时以两个 LF 连接；无 topic 且无归档专题且无组行时不加索引标题。
// chars 按 UTF-16 码元计（text.length），bytes 为 UTF-8 字节数（仅诊断）。
// 标题、换行、来源 [scopeId] 全部计入 chars——预算以完整渲染为准。
//
// renderL1 是纯渲染：不做预算裁决（那是 evaluateMutation 的职责），
// 超限文本也必须能渲染出来，供修复候选比较使用。
// 输入 topics 必须是已去重的可见列表（同 key 重复即拒绝）；
// 带 archivedAt（非空字符串）的归档专题跳过条目渲染，只计入钩子行 N；
// 排序按 key 的 UTF-16 码元序，与系统 locale 无关，输入不变时逐字稳定。
//
// 0.5 批次 2 A 线（0.5-DEV-PLAN §5 阶段 A.2）新增可选输入 groups：组布局渲染——
//   独立活跃 topic 行（既有形态，不动）→
//   活跃组摘要行：- group:KEY — 组名（N 名成员）[ — 组摘要]   ← 组摘要非空才带
//   pinned 组内成员行：  - member-key — 成员摘要（两空格缩进，归档成员不列）
//   整组冷钩子行：- group:KEY — 组名（N 篇冷专题，memory_search 可查）
// 硬约束：
// - groups 缺省 / undefined / 空数组时输出与旧版逐字节一致（回归零变化）；
// - 组与成员一律按 key 字典序（UTF-16 码元序）渲染，禁止按温度/updated/插入
//   顺序排序——同一组数据打乱输入顺序，输出必须逐字节一致；组条目的 order
//   字段（groups.json 携带）不参与排序（数据记录字段容忍透传，不消费）；
// - 组条目 pinned 只校验形状不参与渲染（顺序硬约束之下 pinned 不改变行序，
//   语义留待后续阶段拍板）；成员 pinned 仅表示「该成员各占一行」；
// - 预算截断口径不变：本函数仍不截断（超 hardAt 走 evaluateMutation 既有逻辑），
//   且因输出先排序再拼接，截断结果不依赖输入顺序；
// - 整组冷/归档（成员非空且全部 archived）时组摘要行被冷钩子行取代——组内
//   topic 不能在 L1 彻底失明；部分归档的组仍走活跃组摘要行（归档成员不列行，
//   其可发现性由全局归档钩子与 memory_search 承担）。

import { fail, describe, requireObject } from "./errors.mjs";
import { validateTopic, compareKeys } from "./topics.mjs";
import { validateKey } from "./keys.mjs";

export const INDEX_HEADER = "## 主题记忆索引 / Topic memory index";

/** 索引末尾的归档钩子行（N>0 时出现，指向 memory_search 冷搜）。 */
export function archiveHookLine(archivedCount) {
  return `另有 ${archivedCount} 篇冷专题，memory_search 可查`;
}

const encoder = new TextEncoder();

/**
 * 组条目形状校验（0.5 A 线）：数据记录口径——未知字段容忍（前向兼容，
 * groups.json 条目可携带 order 等字段透传），已知字段强校验。
 * 必填：key（组 key 规范与 topic key 一致）、title；summary/members/pinned
 * 缺省补 '' / [] / false。
 */
function validateGroupEntry(entry, where) {
  requireObject(entry, where);
  if (!Object.prototype.hasOwnProperty.call(entry, "key")) {
    fail("INVALID_INPUT", `${where} is missing required property "key"`);
  }
  if (typeof entry.key !== "string" || entry.key.length === 0) {
    fail("INVALID_INPUT", `${where}: key must be a non-empty string`);
  }
  try {
    validateKey(entry.key);
  } catch (error) {
    fail("INVALID_INPUT", `${where}: ${error.message}`);
  }
  if (!Object.prototype.hasOwnProperty.call(entry, "title")) {
    fail("INVALID_INPUT", `${where} is missing required property "title"`);
  }
  if (typeof entry.title !== "string" || entry.title.length === 0) {
    fail("INVALID_INPUT", `${where}: title must be a non-empty string`);
  }
  if (entry.summary !== undefined && typeof entry.summary !== "string") {
    fail("INVALID_INPUT", `${where}: summary must be a string when present`);
  }
  const summary = entry.summary ?? "";
  // 索引行结构不变量：组摘要进单行索引，换行会破坏行结构（与 topic summary 同规）
  if (summary.includes("\n") || summary.includes("\r")) {
    fail("INVALID_INPUT", `${where}: summary must not contain line breaks`);
  }
  if (entry.pinned !== undefined && typeof entry.pinned !== "boolean") {
    fail("INVALID_INPUT", `${where}: pinned must be a boolean when present`);
  }
  if (entry.members !== undefined && !Array.isArray(entry.members)) {
    fail("INVALID_INPUT", `${where}: members must be an array when present`);
  }
  return {
    key: entry.key,
    title: entry.title,
    summary,
    pinned: entry.pinned ?? false,
    members: entry.members ?? [],
  };
}

/**
 * 组内成员形状校验（0.5 A 线）：数据记录口径。必填 key（与 topic key 同规范）；
 * title/summary/pinned/archived 缺省补默认（'' / '' / false / false），
 * 出现时强校验类型；summary 不得含换行（索引行结构不变量）。
 */
function validateGroupMember(member, where) {
  requireObject(member, where);
  if (!Object.prototype.hasOwnProperty.call(member, "key")) {
    fail("INVALID_INPUT", `${where} is missing required property "key"`);
  }
  if (typeof member.key !== "string" || member.key.length === 0) {
    fail("INVALID_INPUT", `${where}: key must be a non-empty string`);
  }
  try {
    validateKey(member.key);
  } catch (error) {
    fail("INVALID_INPUT", `${where}: ${error.message}`);
  }
  if (member.title !== undefined
    && (typeof member.title !== "string" || member.title.length === 0)) {
    fail("INVALID_INPUT", `${where}: title must be a non-empty string when present`);
  }
  if (member.summary !== undefined && typeof member.summary !== "string") {
    fail("INVALID_INPUT", `${where}: summary must be a string when present`);
  }
  const summary = member.summary ?? "";
  if (summary.includes("\n") || summary.includes("\r")) {
    fail("INVALID_INPUT", `${where}: summary must not contain line breaks`);
  }
  if (member.pinned !== undefined && typeof member.pinned !== "boolean") {
    fail("INVALID_INPUT", `${where}: pinned must be a boolean when present`);
  }
  if (member.archived !== undefined && typeof member.archived !== "boolean") {
    fail("INVALID_INPUT", `${where}: archived must be a boolean when present`);
  }
  return {
    key: member.key,
    summary,
    pinned: member.pinned ?? false,
    archived: member.archived ?? false,
  };
}

/**
 * 组布局行渲染（0.5 A 线）：组按 key 字典序；每组先组行、后 pinned 成员行。
 * 整组冷/归档（成员非空且全部 archived）→ 一行冷钩子取代组摘要行。
 * 返回行数组（无组内容时为空数组，调用方拼接结果与旧版逐字节一致）。
 */
function renderGroupLines(groups) {
  if (!Array.isArray(groups)) {
    fail("INVALID_INPUT", `groups must be an array, got ${describe(groups)}`);
  }
  // 索引循环而非 map：稀疏数组的孔（undefined）必须进入校验被显式拒绝。
  const seenGroupKeys = new Set();
  const sections = [];
  for (let index = 0; index < groups.length; index++) {
    const group = validateGroupEntry(groups[index], `groups[${index}]`);
    if (seenGroupKeys.has(group.key)) {
      fail(
        "INVALID_INPUT",
        `duplicate group key "${group.key}" (groups[${index}])`,
      );
    }
    seenGroupKeys.add(group.key);
    const members = [];
    const seenMemberKeys = new Set();
    for (let memberIndex = 0; memberIndex < group.members.length; memberIndex++) {
      const member = validateGroupMember(
        group.members[memberIndex],
        `groups[${index}].members[${memberIndex}]`,
      );
      // 成员 key 只在组内去重：同一 topic 兼属多组（0.4 S3 软上限语义）时
      // 允许跨组重复出现。
      if (seenMemberKeys.has(member.key)) {
        fail(
          "INVALID_INPUT",
          `duplicate member key "${member.key}" in group "${group.key}" (groups[${index}].members[${memberIndex}])`,
        );
      }
      seenMemberKeys.add(member.key);
      members.push(member);
    }
    sections.push({ group, members });
  }
  // 顺序硬约束：一律 key 字典序，输入顺序不影响输出（打乱输入逐字节一致）。
  sections.sort((a, b) => compareKeys(a.group.key, b.group.key));

  const lines = [];
  for (const { group, members } of sections) {
    if (members.length > 0 && members.every((member) => member.archived)) {
      // 整组冷/归档：冷内容不上面索引（与专题条目同规），但组必须保留一行
      // 可发现入口，指向 memory_search 冷搜。
      lines.push(`- group:${group.key} — ${group.title}（${members.length} 篇冷专题，memory_search 可查）`);
      continue;
    }
    const summaryPart = group.summary.length > 0 ? ` — ${group.summary}` : "";
    lines.push(`- group:${group.key} — ${group.title}（${members.length} 名成员）${summaryPart}`);
    // pinned 组内成员各占一行（key 字典序）；归档成员不列行——冷内容不上索引。
    const pinnedMembers = members
      .filter((member) => member.pinned && !member.archived)
      .sort((a, b) => compareKeys(a.key, b.key));
    for (const member of pinnedMembers) {
      lines.push(`  - ${member.key} — ${member.summary}`);
    }
  }
  return lines;
}

export function renderL1(input) {
  requireObject(input, "renderL1 input");
  // 0.5 A 线：groups 是新增可选键（缺省 = 旧签名完全兼容）；未知键仍拒绝
  // （防拼写错误），coreText/topics 仍为必填自有属性。
  const allowedKeys = ["coreText", "topics", "groups"];
  for (const key of Object.keys(input)) {
    if (!allowedKeys.includes(key)) {
      fail(
        "INVALID_INPUT",
        `renderL1 input has unknown property "${key}" (allowed: ${allowedKeys.join(", ")})`,
      );
    }
  }
  for (const key of ["coreText", "topics"]) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      fail("INVALID_INPUT", `renderL1 input is missing required property "${key}"`);
    }
  }
  const { coreText, topics } = input;
  if (typeof coreText !== "string") {
    fail("INVALID_INPUT", `coreText must be a string, got ${describe(coreText)}`);
  }
  if (!Array.isArray(topics)) {
    fail("INVALID_INPUT", `topics must be an array, got ${describe(topics)}`);
  }

  // 索引循环而非 map：稀疏数组的孔（undefined）必须进入校验被显式拒绝，
  // 不允许被跳孔逻辑静默当成无 topic。
  const seenKeys = new Set();
  const validated = [];
  let archivedCount = 0;
  for (let index = 0; index < topics.length; index++) {
    const topic = validateTopic(topics[index], `topics[${index}]`);
    if (seenKeys.has(topic.key)) {
      fail(
        "INVALID_INPUT",
        `duplicate topic key "${topic.key}" (topics[${index}]); renderL1 expects a deduplicated visible topic list`,
      );
    }
    seenKeys.add(topic.key);
    // 归档专题不进 L1 索引条目（L1 预算的核心目的）；只计入钩子行 N。
    // 归档真相只在专题文件本身：有 archivedAt 即归档（topics.mjs 校验非空串）。
    if (topic.archivedAt !== undefined) {
      archivedCount++;
      continue;
    }
    validated.push(topic);
  }
  validated.sort((a, b) => compareKeys(a.key, b.key));

  // 0.5 A 线：组布局行。groups 缺省（键不存在或 undefined）时走空数组，
  // 拼接结果与旧版逐字节一致。
  const groupLines = input.groups === undefined ? [] : renderGroupLines(input.groups);

  const indexText =
    validated.length === 0 && archivedCount === 0 && groupLines.length === 0
      ? ""
      : [
          INDEX_HEADER,
          ...validated.map((topic) => `- ${topic.key} [${topic.scopeId}] — ${topic.summary}`),
          ...groupLines,
          ...(archivedCount > 0 ? [archiveHookLine(archivedCount)] : []),
        ].join("\n");

  let text;
  if (coreText.length > 0 && indexText.length > 0) {
    text = `${coreText}\n\n${indexText}`;
  } else if (indexText.length > 0) {
    text = indexText;
  } else {
    text = coreText;
  }

  return { text, chars: text.length, bytes: encoder.encode(text).length, indexText };
}
