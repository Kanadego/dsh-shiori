// Shiori 0.5 批次 4 · B 线：温度回放模拟（纯模块，0.5-DEV-PLAN §11.2.6 预览）。
//
// 职责：给定同一份（topics / groups / events / now），分别以 baseParams（当前生效
// 参数）与 params（候选参数）各回放一遍，输出分级分布与两者之间的迁级清单，
// 供面板「先预览后保存」展示，不写任何盘、不读时钟（now 显式注入）。
//
// 硬约束（任务书）：
// - T 的计算必须**委托** evaluateTopics（topic-temperature.mjs 是唯一公式源头）；
//   本模块不许复制衰减/加热/巩固公式，否则预览与实际评估会悄悄分叉。
//   同事件序列 + 同参数下，每个 topic 的 T 与直接调用 evaluateTopics 逐条相等
//   （确定性用例锁死）。
// - 纯模块纪律同 topic-temperature.mjs：零 I/O、零 Date.now、零环境变量、
//   不修改输入；同一输入两次调用深度相等（JSON.stringify 逐字节相同）。
//
// 参数口径：baseParams / params 都是**用户层 12 项参数**（params.mjs 的
// normalizeTemperatureParams 产物，允许部分缺省），内部经 toFormulaParams 转成
// 公式键再交给 evaluateTopics。绝不接受公式键直传——那会被 normalizeParams
// 当作未知键静默忽略（回落默认），预览与实际评估就会静默分叉。
//
// l1DeltaChars 是**预估**（不是事实）：只按「迁入 cold/frozen 的 topic 字符数 −
// 迁出 cold/frozen 的 topic 字符数」做净变化估算，不含归档落地、L1 渲染重排等
// 尚未发生的实际影响。字符数取 topic 元数据的 chars 字段（调用方注入；缺失按 0）。

import { SparkStoreError } from "../sparks/errors.mjs";
import { evaluateTopics } from "./topic-temperature.mjs";
import {
  DEFAULT_TEMPERATURE_PARAMS,
  normalizeTemperatureParams,
  toFormulaParams,
  validateTemperatureParams,
} from "./params.mjs";

const TIERS = Object.freeze(["active", "cool", "cold", "frozen"]);
const COLD_TIERS = new Set(["cold", "frozen"]);

function invalidInput(message, details) {
  return new SparkStoreError("INVALID_INPUT", message, details);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === Object.getPrototypeOf({}));
}

/** 用户层 12 项参数：normalize（补默认/逐项范围）+ 三条交叉校验，返回冻结对象。 */
function normalizeUserParams(input, where) {
  if (input === undefined) return normalizeTemperatureParams(DEFAULT_TEMPERATURE_PARAMS);
  let normalized;
  try {
    normalized = normalizeTemperatureParams(input);
    validateTemperatureParams(normalized);
  } catch (error) {
    throw invalidInput(`${where} 参数非法：${error instanceof Error ? error.message : String(error)}`, {
      where,
      cause: error?.details ?? null,
    });
  }
  return normalized;
}

/** topic 的稳定身份键：effectiveScopeId（targetScopeId ?? scopeId）+ key。 */
function topicIdentity(scopeId, key) {
  return `${scopeId === null || scopeId === undefined ? "" : scopeId}\u0000${key}`;
}

/** 输入 topic 元数据索引（只为取 chars；evaluateTopics 自己负责严格校验）。 */
function charsIndex(topics, where) {
  if (!Array.isArray(topics)) throw invalidInput(`${where} 必须是数组`, { where });
  const index = new Map();
  for (let i = 0; i < topics.length; i += 1) {
    const raw = topics[i];
    if (!isPlainObject(raw)) throw invalidInput(`${where}[${i}] 必须是普通对象`, { where, index: i });
    if (typeof raw.key !== "string" || raw.key.length === 0) {
      throw invalidInput(`${where}[${i}].key 必须是非空字符串`, { where, index: i });
    }
    const effectiveScopeId = raw.targetScopeId ?? raw.scopeId ?? null;
    const identity = topicIdentity(effectiveScopeId, raw.key);
    let chars = 0;
    if (raw.chars !== undefined) {
      if (typeof raw.chars !== "number" || !Number.isFinite(raw.chars) || raw.chars < 0) {
        throw invalidInput(`${where}[${i}].chars 必须是非负有限数值或缺省`, { where, index: i });
      }
      chars = raw.chars;
    }
    index.set(identity, chars);
  }
  return index;
}

function tierCounts(topicOutputs) {
  const tiers = { active: 0, cool: 0, cold: 0, frozen: 0 };
  for (const topic of topicOutputs) {
    if (Object.hasOwn(tiers, topic.tier)) tiers[topic.tier] += 1;
  }
  return tiers;
}

/** 每侧回放结果的 topic 投影（key/scopeId/T/tier）：供「与 evaluateTopics 逐条
 *  相等」的确定性对照，面板只消费 tiers。 */
function topicProjection(topicOutputs) {
  return topicOutputs.map((topic) => ({
    key: topic.key,
    scopeId: topic.effectiveScopeId ?? null,
    T: topic.T,
    tier: topic.tier,
  }));
}

/**
 * 温度回放模拟（纯函数）。
 *
 * @param {object} input
 * @param {Array<object>} input.topics evaluateTopics 的 topics 元数据；可带 chars
 *   （非负有限数值；面板/服务端从 topic 正文长度换算注入，缺失按 0）。
 * @param {Array<object>} [input.groups]
 * @param {Array<object>} [input.events] topic-activity 账本事件（全量，从头回放）。
 * @param {string|number} input.now 规范 UTC ISO 串或有限毫秒数。
 * @param {object} [input.params] 候选参数（用户层 12 项；缺省 = 默认参数）。
 * @param {object} [input.baseParams] 基准参数（用户层 12 项；缺省 = 默认参数）。
 * @returns {{
 *   base: { tiers: {active: number, cool: number, cold: number, frozen: number} },
 *   candidate: { tiers: {active: number, cool: number, cold: number, frozen: number} },
 *   transitions: Array<{key: string, scopeId: string|null, from: string, to: string,
 *     T_from: number, T_to: number, reason: string, chars: number}>,
 *   l1DeltaChars: number,
 *   alarms: Array<object>,
 * }}
 *   transitions 只列 from !== to 的 topic（按输入 topics 顺序）；reason 取候选侧
 *   回放理由；chars 是该 topic 注入的字符数。l1DeltaChars 为预估净变化（见文件头）。
 */
export function simulateTemperature(input) {
  if (!isPlainObject(input)) {
    throw invalidInput("simulateTemperature 的入参必须是普通对象");
  }
  const { topics, groups, events, now, params, baseParams } = input;
  if (!Array.isArray(topics)) throw invalidInput("topics 必须是数组");
  if (groups !== undefined && !Array.isArray(groups)) throw invalidInput("groups 必须是数组或缺省");
  if (events !== undefined && !Array.isArray(events)) throw invalidInput("events 必须是数组或缺省");
  if (now === undefined) throw invalidInput("now 必须显式注入（规范 UTC ISO 串或有限毫秒数）");

  const baseUser = normalizeUserParams(baseParams, "baseParams");
  const candidateUser = normalizeUserParams(params, "params");
  const charsByTopic = charsIndex(topics, "topics");

  // 唯一公式源头：两遍都委托 evaluateTopics（禁止在本模块复制公式）。
  const baseResult = evaluateTopics({
    topics, groups, events, now, params: toFormulaParams(baseUser),
  });
  const candidateResult = evaluateTopics({
    topics, groups, events, now, params: toFormulaParams(candidateUser),
  });

  const candidateByTopic = new Map();
  for (const topic of candidateResult.topics) {
    candidateByTopic.set(topicIdentity(topic.effectiveScopeId, topic.key), topic);
  }

  const transitions = [];
  let l1DeltaChars = 0;
  for (const before of baseResult.topics) {
    const identity = topicIdentity(before.effectiveScopeId, before.key);
    const after = candidateByTopic.get(identity);
    if (after === undefined) continue; // 同一输入两遍回放，必然存在；防御未来演化
    if (before.tier === after.tier) continue;
    const chars = charsByTopic.get(identity) ?? 0;
    const becameCold = COLD_TIERS.has(after.tier) && !COLD_TIERS.has(before.tier);
    const leftCold = COLD_TIERS.has(before.tier) && !COLD_TIERS.has(after.tier);
    if (becameCold) l1DeltaChars += chars;
    if (leftCold) l1DeltaChars -= chars;
    transitions.push({
      key: before.key,
      scopeId: before.effectiveScopeId ?? null,
      from: before.tier,
      to: after.tier,
      T_from: before.T,
      T_to: after.T,
      reason: after.reason,
      chars,
    });
  }

  return {
    base: { tiers: tierCounts(baseResult.topics), topics: topicProjection(baseResult.topics) },
    candidate: { tiers: tierCounts(candidateResult.topics), topics: topicProjection(candidateResult.topics) },
    transitions,
    l1DeltaChars,
    alarms: candidateResult.alarms.map((alarm) => ({ ...alarm })),
  };
}

export { TIERS as REPLAY_TIERS };
