// Shiori P0-CORE · 双水位 + 绝对硬顶闸门（公共契约导出 evaluateMutation）。
//
// 唯一水位基数：config.core.hardCapChars（默认 10000）。
// softAt=floor(hardCapChars×softRatio)（默认 7500）、
// hardAt=floor(hardCapChars×hardRatio)（默认 9000）。
// 占用一律按完整渲染文本的 UTF-16 码元数计（text.length）。
//
// 规则（CONTRACTS §A / DESIGN §7.1）：
//   当前 < hardAt        ：候选可首次跨入 ≥hardAt，但候选 ≤ hardCapChars；
//   hardAt ≤ 当前 ≤ cap  ：禁止净增长（候选 ≤ 当前才允许，等长改写可以）；
//   当前 > hardCapChars  ：只允许净减少修复；修复后仍超限时 promotable=false
//                          （可写盘但不得提升为有效 system），直到 ≤ cap；
//   当前正常时候选 > cap ：写盘前拒绝。
//
// allowed（是否允许写盘）与 promotable（是否可提升为有效 L1 投影）是
// 两个独立判定，不混用：部分修复时 allowed=true 且 promotable=false。
//
// 返回的 level 描述“当前”所处的水位区间（决策适用哪个档位）：
//   "normal"（<softAt）| "soft"（≥softAt）| "gate"（≥hardAt）| "over-cap"（>cap）。
// reason 是稳定标识符，取值见 docs/core/INTERFACE.md 的词表；
// 提交后新的水位可由调用方用 currentText=候选再次求值得到。

import { fail, describe, requireObject, requireExactKeys } from "./errors.mjs";
import { validateConfig } from "./config.mjs";

export function evaluateMutation(input) {
  requireObject(input, "evaluateMutation input");
  requireExactKeys(input, "evaluateMutation input", ["currentText", "candidateText", "config"]);
  const { currentText, candidateText } = input;
  if (typeof currentText !== "string") {
    fail("INVALID_INPUT", `currentText must be a string, got ${describe(currentText)}`);
  }
  if (typeof candidateText !== "string") {
    fail("INVALID_INPUT", `candidateText must be a string, got ${describe(candidateText)}`);
  }
  const config = validateConfig(input.config);
  const { hardCapChars, softRatio, hardRatio } = config.core;
  const softAt = Math.floor(hardCapChars * softRatio);
  const hardAt = Math.floor(hardCapChars * hardRatio);
  const currentChars = currentText.length;
  const candidateChars = candidateText.length;

  const level =
    currentChars > hardCapChars ? "over-cap"
    : currentChars >= hardAt ? "gate"
    : currentChars >= softAt ? "soft"
    : "normal";

  let allowed;
  let promotable;
  let reason;
  if (currentChars > hardCapChars) {
    if (candidateChars >= currentChars) {
      allowed = false;
      promotable = false;
      reason = "repair-only";
    } else if (candidateChars > hardCapChars) {
      allowed = true;
      promotable = false;
      reason = "repair-over-cap";
    } else {
      allowed = true;
      promotable = true;
      reason = "repair";
    }
  } else if (candidateChars > hardCapChars) {
    allowed = false;
    promotable = false;
    reason = "over-hard-cap";
  } else if (currentChars >= hardAt) {
    if (candidateChars > currentChars) {
      allowed = false;
      promotable = false;
      reason = "net-growth-blocked";
    } else if (candidateChars < currentChars) {
      allowed = true;
      promotable = true;
      reason = "net-reduction";
    } else {
      allowed = true;
      promotable = true;
      reason = "gate-hold";
    }
  } else if (candidateChars >= hardAt) {
    allowed = true;
    promotable = true;
    reason = "first-crossing";
  } else if (candidateChars >= softAt) {
    allowed = true;
    promotable = true;
    reason = "soft-reminder";
  } else {
    allowed = true;
    promotable = true;
    reason = "ok";
  }

  return { allowed, promotable, reason, level, currentChars, candidateChars, softAt, hardAt };
}
