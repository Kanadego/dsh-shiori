// Shiori P0-CORE · L1 完整渲染（公共契约导出 renderL1）。
//
// 磁盘 core.md 只存人工正文；renderL1 在渲染时派生索引，禁止回写。
// 索引格式固定（CONTRACTS §A）：
//   标题行：## 主题记忆索引 / Topic memory index
//   条目行：- key [scopeId] — summary
//   归档钩子：另有 N 篇冷专题，memory_search 可查   ← N>0 才出现（DESIGN §2.1）
// core 非空且存在索引时以两个 LF 连接；无 topic 且无归档专题不加索引标题。
// chars 按 UTF-16 码元计（text.length），bytes 为 UTF-8 字节数（仅诊断）。
// 标题、换行、来源 [scopeId] 全部计入 chars——预算以完整渲染为准。
//
// renderL1 是纯渲染：不做预算裁决（那是 evaluateMutation 的职责），
// 超限文本也必须能渲染出来，供修复候选比较使用。
// 输入 topics 必须是已去重的可见列表（同 key 重复即拒绝）；
// 带 archivedAt（非空字符串）的归档专题跳过条目渲染，只计入钩子行 N；
// 排序按 key 的 UTF-16 码元序，与系统 locale 无关，输入不变时逐字稳定。

import { fail, describe, requireObject, requireExactKeys } from "./errors.mjs";
import { validateTopic, compareKeys } from "./topics.mjs";

export const INDEX_HEADER = "## 主题记忆索引 / Topic memory index";

/** 索引末尾的归档钩子行（N>0 时出现，指向 memory_search 冷搜）。 */
export function archiveHookLine(archivedCount) {
  return `另有 ${archivedCount} 篇冷专题，memory_search 可查`;
}

const encoder = new TextEncoder();

export function renderL1(input) {
  requireObject(input, "renderL1 input");
  requireExactKeys(input, "renderL1 input", ["coreText", "topics"]);
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

  const indexText =
    validated.length === 0 && archivedCount === 0
      ? ""
      : [
          INDEX_HEADER,
          ...validated.map((topic) => `- ${topic.key} [${topic.scopeId}] — ${topic.summary}`),
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
