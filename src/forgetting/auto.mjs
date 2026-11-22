// Shiori 0.5 批次 5 · A 线：auto 冷却/恢复（评估、执行、一键撤销；0.5-DEV-PLAN
// §5 护栏 / §11.2.1 触发 / §11.2.2 评估 / §11.2.3 执行 / §4.4 连组恢复 / §6.2 失败语义）。
//
// 三层结构（与 topic-temperature.mjs 的纯模块纪律对齐）：
//   1) 纯函数层（本文件上半部）：触发判定 / 熔断与统计健康 / 候选派生 / 执行计划 /
//      撤销计划——零 I/O、零时钟读取、不修改输入；同一输入两次调用深度相等。
//      温度一律委托 evaluateTopics（topic-temperature.mjs 是唯一公式源头），
//      本模块绝不复制衰减/加热/巩固公式。
//   2) 回放数据源（createAutoReplaySource）：只读装配评估输入（topics frontmatter /
//      groups.json / topic-activity 账本），坏文件按「跳过并计数」降级。与
//      management.simulateTemperature 的只读装配同一套逻辑（本模块是唯一实现，
//      management 复用，杜绝两份装配悄悄分叉）。
//   3) 引擎（createAutoEngine）：评估 / 执行 / 撤销 / 状态的权威入口。management
//      的四个 auto RPC 与 controller pre-step 调度共用同一实例；全部持久状态落
//      state.mjs 的 autoStore（<stateRoot>/auto-organize.json），内存只留单飞闸。
//
// 语义钉死（§11.2.3 / §5；0.5 第三波 suggest 双通道拍板 2026-11-22）：
//   - 三档模式：off 只记账不计算；suggest 只评估出清单（候选/原因），绝不自动
//     执行，但允许手动 apply——逐条勾选（selection 数组）或一键全应用
//     （selection=null 全量）；auto 在人类轮调度里评估后自动执行。两类可逆操作
//     不变——archive-topic（archivedAt + archiveOrigin="auto-inactive"）与
//     unarchive-topic（清 archivedAt + 清 archiveOrigin）。
//   - 每轮 ≤ params.maxOpsPerRun（默认 20）；单条 CAS（fresh read + revision
//     token）+ operationId（service journal 幂等）。
//   - run 记录（runId / 时间 / 每条变更前后值）供 undoAutoRun 一键撤销；
//     撤销只回滚该 run 的变更，重复撤销幂等。
//   - 护栏（全部为真才执行，§5.1）：retention === "historical"（Topic 显式值 ??
//     主组默认 ?? standing）、!pinned、!archivedAt、age >= minCooldownDays、
//     距上次恢复 >= minRestoreGraceDays、T < coolThreshold、statsValid、无时钟回拨；
//     恢复侧（§5.2）：archiveOrigin === "auto-inactive" && T >= restoreThreshold
//     && 无时钟回拨。手动归档（archiveOrigin="manual"）永不自动恢复。
//   - 连组恢复（§4.4）：组不单独存温度（有效温度 = 组内活跃成员 T 最大值，由
//     evaluateTopics 派生）；恢复只恢复导航、不连坐成员——auto 只出 topic 级
//     unarchive，其余成员 archivedAt 一律不动；组导航是派生态（成员恢复即回来），
//     groupRestore 只作说明性输出（navigationOnly: true），绝不生成组级写操作。
//   - 失败语义（§6.2 / §11.2.4）：账本损坏（坏行/不可读）、缺 statsStartedAt
//     （账本零事件，无统计起点）、时钟回拨（now < maxEventAt）→ 熔断：本轮不出
//     任何可执行候选、正常读写零影响、诊断如实上报；观察期未满（statsStartedAt
//     距今 < minCooldownDays 天）只挡冷却、不挡恢复、不算熔断。只读宿主
//     （HOST_LOCKED）不执行 auto（只读评估仍可用）。

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import path from "node:path";

import { SparkStoreError } from "../sparks/errors.mjs";
import { evaluateTopics } from "./topic-temperature.mjs";
import {
  normalizeTemperatureParams,
  toFormulaParams,
  validateTemperatureParams,
} from "./params.mjs";
import { parseTopicFile } from "../storage/frontmatter.mjs";
import { parseGroupsFile } from "../core/groups.mjs";
import { readTopicActivity } from "../storage/topic-activity.mjs";
import { isCanonicalIso, sha256Buffer } from "../storage/fsutil.mjs";
// 0.5 批次 8-4：readTopics 的越根链接检查与 store 快照共用同一实现（同一个
// 管理根身份 realpath 后逐级 lstat），不再各写一份符号链接判定。
// 0.5 批次 10-2：越根检查的 lstat/realpath 与管理根 realpath、groups.json 读
// 一并收进 deps.fs 注入面（assertNoEscapeViaSymlink 第三参透传，可选注入、
// 缺省 node:fs/promises），假 fs 用例可驱动链接判定。
import { assertNoEscapeViaSymlink } from "../storage/paths.mjs";

/**
 * 子操作身份（与 organize/executor.mjs 的 deriveStageOperationId 同一模式）：
 * operationId 兼作 journal 文件名，字符集受限（storage/paths.mjs
 * validateOperationId：字母/数字/点/下划线/连字符且字母数字开头），因此子操作
 * 不拼「:序号」，改用「前缀-sh256(父 operationId + 序号).slice(40)」——确定性
 * （同 run 重试得到同一批子操作身份，journal 幂等重放照常生效）且字符集合法。
 */
function deriveSubOperationId(prefix, ...parts) {
  const derived = `${prefix}-${sha256Buffer(Buffer.from(parts.join("\u0000"), "utf8")).toString("hex").slice(0, 40)}`;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(derived) === false) {
    throw invalidInput(`派生的子 operationId 非法：${derived}`, { prefix });
  }
  return derived;
}

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/** auto 三档模式（§7 / §11.2.3）。 */
export const AUTO_MODES = Object.freeze(["off", "suggest", "auto"]);

/** auto 归档来源标记（§11.2.3）：auto 冷却写入的 archiveOrigin，恢复侧唯一认这个值。 */
export const AUTO_ARCHIVE_ORIGIN = "auto-inactive";

/** auto 执行的两类可逆操作（§11.2.3）：拆篇/合并/改写/retention/pinned/删组永不进 auto。 */
export const AUTO_OP_KINDS = Object.freeze(["archive-topic", "unarchive-topic"]);

/** 触发/评估来源（autoStore.lastEvaluatedBy 与 run.trigger 的取值域）。 */
export const AUTO_TRIGGERS = Object.freeze(["manual", "human-turn", "soft-watermark"]);

/** run 记录保留上限（滚动裁旧；撤销窗口内足够，超出按最旧丢弃）。
 * state.mjs createStateStore({ autoRunKeepLimit }) 可注入缩小窗口（测试用，
 * 验「逐出后同 operationId 重跑」）；缺省与本常量同源（50）。 */
export const AUTO_RUN_KEEP = 50;

/** 熔断/观察期原因码（诊断与 wire 输出的稳定取值）。 */
export const AUTO_FUSE_CODES = Object.freeze({
  LEDGER_UNREADABLE: "LEDGER_UNREADABLE",
  LEDGER_DAMAGED: "LEDGER_DAMAGED",
  STATS_MISSING: "STATS_MISSING",
  CLOCK_ROLLBACK: "CLOCK_ROLLBACK",
  OBSERVATION_PERIOD: "OBSERVATION_PERIOD",
});

function invalidInput(message, details) {
  return new SparkStoreError("INVALID_INPUT", message, details);
}

function invalidState(message, details) {
  return new SparkStoreError("INVALID_STATE", message, details);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

const CANONICAL_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function requireCanonicalIso(value, where) {
  if (typeof value !== "string" || !CANONICAL_ISO_RE.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw invalidInput(`${where} 必须是规范 UTC ISO 时间串（如 "2026-11-21T00:00:00.000Z"）或 null`, {
      where,
      valueType: typeof value,
    });
  }
  return value;
}

/** now：规范 UTC ISO 串或有限毫秒数 → 毫秒；其余一律 INVALID_INPUT。 */
function normalizeNowMs(value, where = "now") {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidInput(`${where} 必须是有限毫秒数或规范 UTC ISO 串`, { where });
    return value;
  }
  if (typeof value === "string" && CANONICAL_ISO_RE.test(value) && Number.isFinite(Date.parse(value))) {
    return Date.parse(value);
  }
  throw invalidInput(`${where} 必须是规范 UTC ISO 串或有限毫秒数`, { where, valueType: typeof value });
}

/** 专题身份键（与 topic-temperature/replay 同口径：effectiveScopeId + key）。 */
export function autoIdentityKey(scopeId, key) {
  return `${scopeId === null || scopeId === undefined ? "" : scopeId}\u0000${key}`;
}

/** 归档态归一（与 frontmatter/service 读路径的缺省注入一致）：未归档 archivedAt
 *  归一为 null；archiveOrigin 缺省归一为 "manual"（磁盘省略整行 = 人工口径）。 */
function archiveStateOf(value) {
  return {
    archivedAt: value?.archivedAt == null || value.archivedAt === "" ? null : String(value.archivedAt),
    archiveOrigin: value?.archiveOrigin == null || value.archiveOrigin === "" ? "manual" : String(value.archiveOrigin),
  };
}

function archiveStateEquals(a, b) {
  const left = archiveStateOf(a);
  const right = archiveStateOf(b);
  return left.archivedAt === right.archivedAt && left.archiveOrigin === right.archiveOrigin;
}

function compareTopicRows(a, b, direction) {
  const tDelta = direction === "asc" ? a.T - b.T : b.T - a.T;
  if (tDelta !== 0) return tDelta;
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.scopeId === b.scopeId) return 0;
  return a.scopeId < b.scopeId ? -1 : 1;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function formatDays(value) {
  return String(round2(value));
}

// ---------------------------------------------------------------------------
// 纯函数 1：触发判定（§11.2.1）
// ---------------------------------------------------------------------------

/**
 * 触发判定（纯函数）：三个入口按 §11.2.1 的优先级折叠成一个布尔。
 *
 * - mode === "off"：只记账不计算，永不触发（连同水位）；
 * - 非人类轮（isHumanTurn=false）：心跳投递 / 引擎室轮的 source.kind 不是 "user"，
 *   天然跳过——满 24h 没人类会话就一直等，不按时钟硬跑；
 * - lastEvaluatedAt === null：从未成功评估过 → 第一次人类轮即评估（基线）；
 * - 距上次成功评估满 evaluateEveryHours 小时 → 触发（主入口）；
 * - softWatermark=true：L1 软水位（渲染层发现 L1 逼近 softChars 后武装）顺带触发
 *   一次分析——只触发评估，绝不缩短 S、绝不降低冷却阈值（§7 禁止恐慌性遗忘）。
 *
 * @param {object} input
 * @param {string} input.mode AUTO_MODES 之一。
 * @param {boolean} input.isHumanTurn 本轮上下文是否存在 source.kind === "user" 的消息。
 * @param {string|null} input.lastEvaluatedAt 该 scope 上次成功评估时间（规范 ISO 或 null）。
 * @param {string|number} input.now 规范 UTC ISO 串或毫秒数。
 * @param {number} input.evaluateEveryHours 评估周期（小时，> 0）。
 * @param {boolean} [input.softWatermark=false] L1 软水位是否已武装。
 * @returns {{triggered: boolean, reason: string, nextDueAt: string|null}}
 *   reason ∈ mode-off / not-human-turn / first-run / elapsed / soft-watermark / not-due。
 */
export function shouldTriggerAutoEvaluation(input = {}) {
  if (!isPlainObject(input)) throw invalidInput("shouldTriggerAutoEvaluation 的入参必须是普通对象");
  const { mode, isHumanTurn, lastEvaluatedAt, now, evaluateEveryHours, softWatermark = false } = input;
  if (!AUTO_MODES.includes(mode)) {
    throw invalidInput(`mode 必须是 ${AUTO_MODES.join(" / ")} 之一`, { mode: String(mode) });
  }
  if (typeof isHumanTurn !== "boolean") {
    throw invalidInput("isHumanTurn 必须是布尔值", { valueType: typeof isHumanTurn });
  }
  if (typeof softWatermark !== "boolean") {
    throw invalidInput("softWatermark 必须是布尔值", { valueType: typeof softWatermark });
  }
  if (typeof evaluateEveryHours !== "number" || !Number.isFinite(evaluateEveryHours) || evaluateEveryHours <= 0) {
    throw invalidInput("evaluateEveryHours 必须是正数（小时）", { evaluateEveryHours: String(evaluateEveryHours) });
  }
  const lastMs = lastEvaluatedAt === null || lastEvaluatedAt === undefined
    ? null
    : Date.parse(requireCanonicalIso(lastEvaluatedAt, "lastEvaluatedAt"));
  if (mode === "off") return { triggered: false, reason: "mode-off", nextDueAt: null };
  if (!isHumanTurn) return { triggered: false, reason: "not-human-turn", nextDueAt: null };
  const nowMs = normalizeNowMs(now, "now");
  if (lastMs === null) return { triggered: true, reason: "first-run", nextDueAt: null };
  const periodMs = evaluateEveryHours * HOUR_MS;
  const nextDueAt = new Date(lastMs + periodMs).toISOString();
  if (nowMs - lastMs >= periodMs) return { triggered: true, reason: "elapsed", nextDueAt };
  if (softWatermark) return { triggered: true, reason: "soft-watermark", nextDueAt };
  return { triggered: false, reason: "not-due", nextDueAt };
}

// ---------------------------------------------------------------------------
// 纯函数 2：熔断与统计健康（§5.1 statsValid / §6.2 / §11.2.4）
// ---------------------------------------------------------------------------

/**
 * 统计健康与熔断判定（纯函数）。statsStartedAt 的落地口径：topic-activity 账本
 * 首条事件的 at（账本 append-only，首事件即「首次启用统计」的时刻）；账本零事件
 * = 无统计起点 = 缺 statsStartedAt → 熔断（fail-closed：没有任何统计就自动冷却
 * 等于盲冷）。损坏口径：账本不可读（IO 错误）或存在坏行/坏事件（skipped > 0）→
 * 熔断；时钟回拨：任一事件 at > now → 熔断。观察期：now - statsStartedAt <
 * minCooldownDays 天 → statsValid=false（只挡冷却、不挡恢复、不算熔断）。
 *
 * 熔断是「本轮不产出可执行候选 + 诊断如实上报」，不持久化粘滞位——账本修复后
 * 下一轮自动恢复，正常记忆读写永远零影响。
 *
 * @param {object} input
 * @param {Array<object>} input.events 账本事件（readTopicActivity 产物）。
 * @param {string|number} input.now 规范 UTC ISO 串或毫秒数。
 * @param {number} input.minCooldownDays 观察期天数（params 12 项之一）。
 * @param {number} [input.ledgerSkipped=0] 账本坏行计数（readTopicActivity.skipped）。
 * @param {string|null} [input.ledgerError=null] 账本读取失败的有界摘要（null=正常）。
 * @returns {{fused: boolean, reasons: Array<{code: string, detail: string}>,
 *   statsValid: boolean, statsStartedAt: string|null, maxEventAt: string|null,
 *   eventCount: number}}
 */
export function computeAutoFuse(input = {}) {
  if (!isPlainObject(input)) throw invalidInput("computeAutoFuse 的入参必须是普通对象");
  const { events, now, minCooldownDays, ledgerSkipped = 0, ledgerError = null } = input;
  if (!Array.isArray(events)) throw invalidInput("events 必须是数组");
  if (typeof minCooldownDays !== "number" || !Number.isFinite(minCooldownDays) || minCooldownDays < 0) {
    throw invalidInput("minCooldownDays 必须是非负有限数值", { minCooldownDays: String(minCooldownDays) });
  }
  if (!Number.isInteger(ledgerSkipped) || ledgerSkipped < 0) {
    throw invalidInput("ledgerSkipped 必须是非负整数", { ledgerSkipped: String(ledgerSkipped) });
  }
  const nowMs = normalizeNowMs(now, "now");
  const reasons = [];
  let damaged = false;
  if (ledgerError !== null && ledgerError !== undefined) {
    damaged = true;
    reasons.push({ code: AUTO_FUSE_CODES.LEDGER_UNREADABLE, detail: String(ledgerError) });
  }
  if (ledgerSkipped > 0) {
    damaged = true;
    reasons.push({ code: AUTO_FUSE_CODES.LEDGER_DAMAGED, detail: `账本存在 ${ledgerSkipped} 条坏行（损坏内容已跳过）` });
  }
  const times = [];
  for (const event of events) {
    const atMs = Date.parse(event?.at);
    if (!Number.isFinite(atMs)) {
      damaged = true;
      reasons.push({ code: AUTO_FUSE_CODES.LEDGER_DAMAGED, detail: `账本事件 at 非法：${String(event?.at)}` });
      continue;
    }
    times.push(atMs);
  }
  const eventCount = events.length;
  let statsStartedAt = null;
  let maxEventAt = null;
  if (times.length > 0) {
    statsStartedAt = new Date(Math.min(...times)).toISOString();
    maxEventAt = new Date(Math.max(...times)).toISOString();
  } else if (!damaged) {
    reasons.push({ code: AUTO_FUSE_CODES.STATS_MISSING, detail: "账本零事件：缺 statsStartedAt（无统计起点），auto 熔断" });
  }
  if (maxEventAt !== null && Date.parse(maxEventAt) > nowMs) {
    reasons.push({
      code: AUTO_FUSE_CODES.CLOCK_ROLLBACK,
      detail: `时钟回拨：now=${new Date(nowMs).toISOString()} 早于账本最大事件时间 ${maxEventAt}`,
    });
  }
  // 熔断 = 存在阻断性原因（账本损坏/缺统计起点/时钟回拨）；观察期只是 statsValid
  // 信号（只挡冷却），不算熔断。
  const fused = reasons.some((reason) => reason.code !== AUTO_FUSE_CODES.OBSERVATION_PERIOD);
  let statsValid = false;
  if (!fused && times.length > 0) {
    statsValid = nowMs - Date.parse(statsStartedAt) >= minCooldownDays * DAY_MS;
    if (!statsValid) {
      reasons.push({
        code: AUTO_FUSE_CODES.OBSERVATION_PERIOD,
        detail: `观察期未满：statsStartedAt=${statsStartedAt} 距今不足 minCooldownDays=${minCooldownDays} 天（只挡冷却，不挡恢复）`,
      });
    }
  }
  return {
    fused,
    reasons,
    statsValid,
    statsStartedAt,
    maxEventAt,
    eventCount,
  };
}

// ---------------------------------------------------------------------------
// 纯函数 3：候选派生（§5.1 / §5.2 护栏逐条）
// ---------------------------------------------------------------------------

/**
 * 从回放结果派生 auto 候选（纯函数）。每个候选必带非空 reason（§11.2.2：没有
 * reason 的自动决策一律不许执行）。
 *
 * @param {object} input
 * @param {string|number} input.now
 * @param {object} input.params 完整 12 项用户参数（normalizeTemperatureParams 产物）。
 * @param {Array<object>} input.replayTopics evaluateTopics 的 topics 输出。
 * @param {Array<object>} input.rows 源元数据行（createAutoReplaySource.readTopics
 *   产物，含 archivedAt / archiveOrigin / group）。
 * @param {object} input.fuse computeAutoFuse 产物（fused=true 时两清单恒空）。
 * @param {Map<string, string>} [input.restoreAnchors] 专题身份键 → 上次恢复时间
 *   （来自 run 记录的 auto 恢复史；§5.1 的 minRestoreGraceDays 护栏输入）。
 * @returns {{cool: Array<object>, restore: Array<object>}}
 */
export function deriveAutoCandidates(input = {}) {
  if (!isPlainObject(input)) throw invalidInput("deriveAutoCandidates 的入参必须是普通对象");
  const { now, params, replayTopics, rows, fuse, restoreAnchors } = input;
  if (!Array.isArray(replayTopics)) throw invalidInput("replayTopics 必须是数组");
  if (!Array.isArray(rows)) throw invalidInput("rows 必须是数组");
  if (!isPlainObject(fuse)) throw invalidInput("fuse 必须是 computeAutoFuse 的产物");
  if (!(restoreAnchors === undefined || restoreAnchors instanceof Map)) {
    throw invalidInput("restoreAnchors 必须是 Map 或缺省", { valueType: typeof restoreAnchors });
  }
  validateTemperatureParams(params);
  const nowMs = normalizeNowMs(now, "now");
  const replayByKey = new Map();
  for (const topic of replayTopics) {
    replayByKey.set(autoIdentityKey(topic.effectiveScopeId, topic.key), topic);
  }
  const anchors = restoreAnchors ?? new Map();
  const cool = [];
  const restore = [];
  for (const row of rows) {
    const replay = replayByKey.get(autoIdentityKey(row.scopeId, row.key));
    if (replay === undefined) continue; // 坏文件行已被装配层跳过，回放里没有对应记录
    const identity = autoIdentityKey(row.scopeId, row.key);
    const archive = archiveStateOf(row);
    const base = {
      operationKind: null,
      key: row.key,
      scopeId: row.scopeId,
      title: typeof row.title === "string" ? row.title : null,
      T: replay.T,
      tier: replay.tier,
      ageDays: replay.ageDays,
      stability: replay.S,
      reason: "",
      replayReason: replay.reason,
    };
    if (fuse.fused !== true) {
      // ── 冷却候选（§5.1 护栏，全部为真才执行）──
      if (replay.archived === false && archive.archivedAt === null) {
        const guardParts = [];
        let ok = true;
        if (replay.retention === "historical") guardParts.push("retention=historical"); else ok = false;
        if (replay.pinned === false) guardParts.push("非 pinned"); else ok = false;
        if (replay.ageDays !== null && replay.ageDays >= params.minCooldownDays) {
          guardParts.push(`age=${formatDays(replay.ageDays)}天 ≥ minCooldownDays=${params.minCooldownDays}天`);
        } else ok = false;
        const anchor = anchors.get(identity) ?? null;
        if (anchor === null || (nowMs - Date.parse(anchor)) >= params.minRestoreGraceDays * DAY_MS) {
          if (anchor !== null) {
            guardParts.push(`距上次恢复 ${formatDays((nowMs - Date.parse(anchor)) / DAY_MS)}天 ≥ minRestoreGraceDays=${params.minRestoreGraceDays}天`);
          }
        } else ok = false;
        if (replay.T < params.coolThreshold) guardParts.push(`T=${round2(replay.T)} < coolThreshold=${params.coolThreshold}`); else ok = false;
        if (fuse.statsValid !== true) ok = false;
        if (ok) {
          cool.push({
            ...base,
            operationKind: "archive-topic",
            // 未归档专题磁盘上没有 archiveOrigin 行（缺省 manual 口径）；撤销时
            // 用 null 清行（存储层 '' 哨兵 = 省略整行），不回写显式 manual。
            before: { archivedAt: null, archiveOrigin: null },
            after: { archivedAt: null, archiveOrigin: null }, // apply 层以 run 时刻落 archivedAt
            reason: `自动冷却候选：${guardParts.join("、")}｜${replay.reason}`,
          });
        }
      }
      // ── 恢复候选（§5.2 护栏）：手动归档（manual）永不自动恢复 ──
      if (archive.archivedAt !== null) {
        const originOk = archive.archiveOrigin === AUTO_ARCHIVE_ORIGIN;
        const tempOk = replay.T >= params.restoreThreshold;
        if (originOk && tempOk) {
          restore.push({
            ...base,
            operationKind: "unarchive-topic",
            before: { archivedAt: archive.archivedAt, archiveOrigin: archive.archiveOrigin },
            after: { archivedAt: null, archiveOrigin: null },
            reason: `自动恢复候选：archiveOrigin=${AUTO_ARCHIVE_ORIGIN}、T=${round2(replay.T)} ≥ restoreThreshold=${params.restoreThreshold}｜${replay.reason}`,
          });
        }
      }
    }
  }
  cool.sort((a, b) => compareTopicRows(a, b, "asc")); // 最冷的先执行
  restore.sort((a, b) => compareTopicRows(a, b, "desc")); // 最热的先执行
  return { cool, restore };
}

// ---------------------------------------------------------------------------
// 纯函数 4：执行计划（每轮 ≤ maxOpsPerRun + 连组恢复说明）
// ---------------------------------------------------------------------------

/**
 * 把候选折叠成一轮执行计划（纯函数）：冷却优先、恢复其次（§11.2.3 清单顺序），
 * 截断到 maxOpsPerRun；恢复落在 plan 里的组给出说明性 groupRestore（§4.4 连组
 * 恢复：只恢复导航、不连坐成员——navigationOnly 恒 true，绝不生成组级写操作）。
 *
 * @param {object} input
 * @param {Array<object>} input.cool deriveAutoCandidates.cool
 * @param {Array<object>} input.restore deriveAutoCandidates.restore
 * @param {Array<object>} input.rows 源元数据行（解析组成员归属用）。
 * @param {number} input.maxOpsPerRun 单轮上限（params 12 项之一，正整数）。
 * @param {string|number} [input.now] 归档动作的 archivedAt 时间戳（缺省不落，
 *   apply 层注入 run 时刻；纯函数不读时钟）。
 * @returns {{ops: Array<object>, truncated: boolean, groupRestore: Array<object>,
 *   counts: {cool: number, restore: number, total: number}}}
 */
export function planAutoOps(input = {}) {
  if (!isPlainObject(input)) throw invalidInput("planAutoOps 的入参必须是普通对象");
  const { cool, restore, rows, maxOpsPerRun, now } = input;
  if (!Array.isArray(cool) || !Array.isArray(restore)) {
    throw invalidInput("cool/restore 必须是数组");
  }
  if (!Array.isArray(rows)) throw invalidInput("rows 必须是数组");
  if (!Number.isInteger(maxOpsPerRun) || maxOpsPerRun < 1) {
    throw invalidInput("maxOpsPerRun 必须是正整数", { maxOpsPerRun: String(maxOpsPerRun) });
  }
  const runAtMs = now === undefined ? null : normalizeNowMs(now, "now");
  const runAtIso = runAtMs === null ? null : new Date(runAtMs).toISOString();
  const candidates = [...cool, ...restore];
  const ops = [];
  for (const candidate of candidates.slice(0, maxOpsPerRun)) {
    const op = {
      operationKind: candidate.operationKind,
      key: candidate.key,
      scopeId: candidate.scopeId,
      title: candidate.title,
      before: { ...candidate.before },
      after: { ...candidate.after },
      reason: candidate.reason,
      T: candidate.T,
    };
    if (op.operationKind === "archive-topic" && runAtIso !== null) {
      op.after = { archivedAt: runAtIso, archiveOrigin: AUTO_ARCHIVE_ORIGIN };
    }
    ops.push(op);
  }
  const truncated = candidates.length > maxOpsPerRun;

  // 连组恢复说明（§4.4）：组导航是派生态——组内出现活跃成员，组行/组目录即回到
  // L1。这里只按「主组挂载（row.group[0]）」口径标注哪些组因本轮恢复而导航恢复；
  // 其余成员的 archivedAt 一律不出现在 ops 里（不连坐）。组内全员 manual 归档时
  // 永远没有 restore 候选（§5.2 挡在 topic 级），组导航不自动恢复——即「manual
  // 归档组永不自动恢复」。
  const rowById = new Map(rows.map((row) => [autoIdentityKey(row.scopeId, row.key), row]));
  const groupRestore = [];
  if (restore.length > 0) {
    const touchedGroups = new Map(); // 组 key → 恢复成员清单
    for (const op of ops) {
      if (op.operationKind !== "unarchive-topic") continue;
      const row = rowById.get(autoIdentityKey(op.scopeId, op.key));
      const groupKey = Array.isArray(row?.group) && row.group.length > 0 ? row.group[0] : null;
      if (groupKey === null) continue;
      if (!touchedGroups.has(groupKey)) touchedGroups.set(groupKey, []);
      touchedGroups.get(groupKey).push(op.key);
    }
    for (const [groupKey, restoredMembers] of touchedGroups) {
      // 组在改动前是否整体冷（组内所有主组成员都归档）——只有「整组冷 → 本轮
      // 恢复 ≥1 成员」才是导航恢复；组本来就有活跃成员时导航从未离开，不标注。
      const memberRows = rows.filter((row) => Array.isArray(row.group) && row.group[0] === groupKey);
      const allArchivedBefore = memberRows.length > 0
        && memberRows.every((row) => archiveStateOf(row).archivedAt !== null);
      if (!allArchivedBefore) continue;
      groupRestore.push({
        key: groupKey,
        navigationOnly: true,
        restoredMembers,
        otherMembersUntouched: true,
        reason: `连组恢复（§4.4）：组 "${groupKey}" 原先无活跃成员，本轮恢复 ${restoredMembers.join("、")} 后组导航（组行 + 组目录）随之回到 L1；其余成员 archivedAt 不动（不连坐）`,
      });
    }
  }

  return {
    ops,
    truncated,
    groupRestore,
    counts: { cool: cool.length, restore: restore.length, total: candidates.length },
  };
}

// ---------------------------------------------------------------------------
// 纯函数 5：撤销计划（run 记录 → 逆操作）
// ---------------------------------------------------------------------------

/**
 * 从 run 记录构建撤销操作清单（纯函数）：applied 的条目逐条取逆（archive ↔
 * unarchive），before/after 互换。skipped/failed 条目没有落盘变更，不进撤销。
 *
 * @param {object} run autoStore 里的 run 记录（recordRun 落盘形状）。
 * @returns {Array<object>} 逆操作清单（形状与 planAutoOps.ops 一致，reason 带来源）。
 */
export function buildUndoOps(run) {
  assertRunShape(run);
  const undoOps = [];
  for (const op of run.ops) {
    if (op.status !== "applied") continue;
    undoOps.push({
      operationKind: op.operationKind === "archive-topic" ? "unarchive-topic" : "archive-topic",
      key: op.key,
      scopeId: op.scopeId,
      title: op.title ?? null,
      before: { ...op.after },
      after: { ...op.before },
      reason: `撤销 ${run.runId} 的 ${op.operationKind}（${op.key}）：恢复到 run 前状态`,
      sourceRunId: run.runId,
    });
  }
  return undoOps;
}

/** run 记录形状复核（store 读出后 / 纯函数消费前的最后防线）。非法抛 INVALID_STATE。
 * 0.5 第三波起 run.selection 可选：旧 run（第三波前落盘）缺该字段按 null 读，
 * 不报错（回放 / 撤销链路必须兼容旧账）；字段存在时必须为 null 或合法 selection
 * 数组（形状与 apply 入参一致）。 */
export function assertRunShape(run) {
  if (!isPlainObject(run)) throw invalidState("run 记录必须是普通对象", {});
  for (const field of ["runId", "at", "scopeId", "trigger", "mode", "operationId"]) {
    if (typeof run[field] !== "string" || run[field].length === 0) {
      throw invalidState(`run 记录缺少合法的 ${field}`, { field: String(run[field]) });
    }
  }
  if (run.selection !== undefined && run.selection !== null) {
    if (!Array.isArray(run.selection) || run.selection.length === 0) {
      throw invalidState("run 记录的 selection 必须是 null 或非空数组", {});
    }
    for (const item of run.selection) {
      if (!isPlainObject(item)
        || typeof item.key !== "string" || item.key.length === 0
        || !AUTO_OP_KINDS.includes(item.operationKind)) {
        throw invalidState("run.selection 条目缺少合法的 key/operationKind", {});
      }
    }
  }
  if (!Array.isArray(run.ops)) throw invalidState("run 记录的 ops 必须是数组", {});
  for (const op of run.ops) {
    if (!isPlainObject(op)) throw invalidState("run.ops 条目必须是普通对象", {});
    if (!AUTO_OP_KINDS.includes(op.operationKind)) {
      throw invalidState(`run.ops 条目的 operationKind 非法：${String(op.operationKind)}`, {});
    }
    if (typeof op.key !== "string" || op.key.length === 0 || typeof op.scopeId !== "string" || op.scopeId.length === 0) {
      throw invalidState("run.ops 条目缺少合法的 key/scopeId", {});
    }
    if (!["applied", "skipped", "failed"].includes(op.status)) {
      throw invalidState(`run.ops 条目的 status 非法：${String(op.status)}`, {});
    }
    if (!isPlainObject(op.before) || !isPlainObject(op.after)) {
      throw invalidState("run.ops 条目缺少 before/after", {});
    }
  }
}

/** selection 复合身份键（0.5 第三波）：operationKind + key 唯一确定一条候选。 */
function selectionItemKey(item) {
  return `${item.operationKind}\u0000${item.key}`;
}

/**
 * apply 的 selection 归一与校验（0.5 第三波 suggest 双通道）：
 *   - 缺省 / null → null（全量执行，旧调用兼容）；
 *   - 数组 → 每项 { key: 非空字符串, operationKind: AUTO_OP_KINDS 之一 }，
 *     长度 1..200；重复 (operationKind,key) → INVALID_INPUT（不静默去重）。
 * 返回归一后的数组（只保留 key/operationKind 两字段，多余键不入 run 记录）。
 */
function normalizeApplySelection(selection) {
  if (selection === undefined || selection === null) return null;
  if (!Array.isArray(selection)) {
    throw invalidInput("selection 必须是 null 或数组（null=全量执行，数组=只执行选中项）", {
      valueType: typeof selection,
    });
  }
  if (selection.length < 1 || selection.length > 200) {
    throw invalidInput("selection 数组长度必须为 1..200", { length: selection.length });
  }
  const seen = new Set();
  const normalized = [];
  for (const item of selection) {
    if (!isPlainObject(item)) {
      throw invalidInput("selection 每项必须是普通对象 { key, operationKind }", { valueType: typeof item });
    }
    if (typeof item.key !== "string" || item.key.length === 0) {
      throw invalidInput("selection 每项的 key 必须是非空字符串", { key: String(item?.key) });
    }
    if (!AUTO_OP_KINDS.includes(item.operationKind)) {
      throw invalidInput(`selection 每项的 operationKind 必须是 ${AUTO_OP_KINDS.join(" / ")} 之一`, {
        operationKind: String(item?.operationKind),
      });
    }
    const identity = selectionItemKey(item);
    if (seen.has(identity)) {
      throw invalidInput(`selection 存在重复条目（${item.operationKind} ${item.key}）：不静默去重，请去掉重复项后重试`, {
        operationKind: item.operationKind,
        key: item.key,
      });
    }
    seen.add(identity);
    normalized.push({ key: item.key, operationKind: item.operationKind });
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// 回放数据源（只读装配；management.simulateTemperature 与 auto 引擎共用）
// ---------------------------------------------------------------------------

/**
 * 只读评估装配源。硬约束：全部裸 readFile / readdir，不开存储锁、不建目录、
 * 不写盘（预览与评估零写入；锁内读会 mkdir 数据根并写 .shiori-lock，把只读
 * 预览变成写操作——见 management.mjs 0.5 批次 4 B 线注释）。坏文件按「跳过
 * 并计数」降级，不让一个手改坏文件拖垮整次评估；单文件越根 symlink/junction
 * 同口径计入 skipped（与 store 快照进 shadow 跳过一致），目录级越根与 store
 * 一样直接拒绝（INVALID_INPUT）；悬空链接（realpath 失败 ENOENT/ELOOP）
 * 按坏文件降级——单文件计入 skipped、目录级视为无 topics。
 *
 * @param {object} deps
 * @param {string|null} deps.dataRoot 业务数据根（null → 全空装配）。
 * @param {string|null} deps.stateRoot 状态根（null → 账本空读）。
 * @param {object} [deps.fs] fs 注入（缺省 node:fs/promises）。readdir/readFile
 *   必须提供；realpath/lstat（0.5 批次 10-2）可选、缺省 node:fs/promises——
 *   管理根 realpath、越根链接检查（assertNoEscapeViaSymlink）与 groups.json
 *   读取都走注入面，测试可用假实现驱动链接判定。
 * @returns {{readTopics: (scopeId: string) => Promise<{rows: Array, skipped: number}>,
 *   readGroups: (scopeId: string) => Promise<Array>,
 *   readLedger: () => Promise<{events: Array, skipped: number, error: string|null}>}}
 */
export function createAutoReplaySource({ dataRoot, stateRoot, fs = fsp } = {}) {
  if (typeof fs?.readdir !== "function" || typeof fs?.readFile !== "function") {
    throw invalidInput("fs 注入必须提供 readdir 与 readFile");
  }
  // 0.5 批次 10-2：realpath/lstat 收进注入面（可选，缺省 fsp）——管理根身份、
  // 越根链接检查与 readGroups 的文件读取全部经 ioFs；删注入（写死 fsp）时
  // 新增的注入用例必须红。
  const ioFs = {
    readdir: fs.readdir,
    readFile: fs.readFile,
    realpath: typeof fs?.realpath === "function" ? fs.realpath : fsp.realpath,
    lstat: typeof fs?.lstat === "function" ? fs.lstat : fsp.lstat,
  };
  const root = typeof dataRoot === "string" && dataRoot.length > 0 ? dataRoot : null;

  // 悬空/循环链接（realpath 失败 ENOENT/ELOOP）不是越界：按坏文件降级——
  // 单文件级计 skipped / 返回空清单，目录级视为空集合（readTopics/readGroups
  // 各调用点同判）。
  const degradableLinkError = (error) => error?.code === "ENOENT" || error?.code === "ELOOP";

  /** topics 只读装配（global 先、active 覆盖，与本仓 FileStore.effectiveView 同口径）。 */
  async function readTopics(scopeId) {
    if (root === null) return { rows: [], skipped: 0 };
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      throw invalidInput("readTopics 的 scopeId 必须是非空字符串");
    }
    // 批次 8-4：realpath 口径与 store/listTopics 对齐——快照读路径先 realpath
    // 管理根（store.mjs rootReal 同一身份），再对目录与单文件做越根
    // symlink/junction 检查。目录级越根与 store 一样直接拒绝（快照同样会抛
    // INVALID_INPUT）；单文件越根按「跳过并计数」降级（store 进 shadow 跳过），
    // 保证预览/评估看到的 topic 集合与 listTopics 一致，不再多吃根外链接。
    // 悬空链接（lstat 成功但 realpath 失败）不是越界：ENOENT/ELOOP 按坏文件
    // 降级——单文件计入 skipped，目录级视为该 scope 无 topics（continue），
    // 兑现本函数「坏文件跳过不拖垮评估」的承诺；其余错误照旧上抛。
    // 批次 10-2：realpath/lstat 与 readdir/readFile 同走注入面（ioFs）。
    let rootReal;
    try {
      rootReal = await ioFs.realpath(root);
    } catch (error) {
      if (error?.code === "ENOENT") return { rows: [], skipped: 0 };
      throw error;
    }
    const scopes = scopeId === "global" ? ["global"] : ["global", scopeId];
    const byKey = new Map();
    let skipped = 0;
    for (const sid of scopes) {
      const dir = path.join(rootReal, "scopes", sid, "topics");
      try {
        await assertNoEscapeViaSymlink(rootReal, dir, ioFs);
      } catch (error) {
        if (degradableLinkError(error)) continue;
        throw error;
      }
      let names;
      try {
        names = await ioFs.readdir(dir);
      } catch (error) {
        if (error?.code === "ENOENT" || error?.code === "ENOTDIR") continue;
        throw error;
      }
      const rows = [];
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        const key = name.slice(0, -3);
        const file = path.join(dir, name);
        try {
          await assertNoEscapeViaSymlink(rootReal, file, ioFs);
        } catch (error) {
          if (error?.code === "INVALID_INPUT" || degradableLinkError(error)) { skipped += 1; continue; }
          throw error;
        }
        let raw;
        try {
          raw = await ioFs.readFile(file);
        } catch (error) {
          if (error?.code === "ENOENT") { skipped += 1; continue; }
          throw error;
        }
        let parsed;
        try {
          parsed = parseTopicFile(raw);
        } catch {
          skipped += 1;
          continue;
        }
        if (!parsed.hasFrontMatter) { skipped += 1; continue; }
        const { meta, body, group, pinned, retention, archiveOrigin } = parsed;
        if (meta.key !== key || meta.scopeId !== sid) { skipped += 1; continue; }
        rows.push({
          key,
          title: meta.title,
          summary: meta.summary,
          body,
          scopeId: sid,
          updated: meta.updated,
          group,
          pinned,
          retention,
          archiveOrigin,
          ...(isCanonicalIso(meta.archivedAt) ? { archivedAt: meta.archivedAt } : {}),
        });
      }
      for (const row of rows) byKey.set(row.key, row); // active 覆盖 global（同 key）
    }
    return { rows: [...byKey.values()], skipped };
  }

  /**
   * 组清单只读解析（0.5 批次 10-2 对齐 store 口径，与 storage/groups.mjs
   * readGroups 同族错误码）：管理根先 realpath（缺失 ENOENT → 空清单降级，
   * 与 readTopics 同判），再对 groups.json 全链做越根 symlink/junction 检查
   * （assertNoEscapeViaSymlink，注入 fs）——groups.json 或其任一祖先目录指向
   * 根外 → INVALID_INPUT 直接拒（与 store 同判，绝不静默读根外内容）；
   * 悬空/ELOOP 链接按坏文件降级返回 []（不拖垮评估）；文件缺失（ENOENT）或
   * 坏 JSON → 空清单降级。全部 I/O（realpath/lstat/readFile）走注入面。
   */
  async function readGroups(scopeId) {
    if (root === null) return [];
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      throw invalidInput("readGroups 的 scopeId 必须是非空字符串");
    }
    let rootReal;
    try {
      rootReal = await ioFs.realpath(root);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const file = path.join(rootReal, "scopes", scopeId, "groups.json");
    try {
      await assertNoEscapeViaSymlink(rootReal, file, ioFs);
    } catch (error) {
      if (degradableLinkError(error)) return [];
      throw error;
    }
    let raw;
    try {
      raw = await ioFs.readFile(file);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    try {
      return parseGroupsFile(raw, `groups.json(${scopeId})`).groups;
    } catch {
      return [];
    }
  }

  /** 全量账本事件（裸 readFile；坏行计数透传给熔断判定；IO 失败折叠为 error 摘要）。 */
  async function readLedger() {
    if (typeof stateRoot !== "string" || stateRoot.length === 0) {
      return { events: [], skipped: 0, error: null };
    }
    try {
      const { events, skipped } = await readTopicActivity({ stateRoot });
      return { events, skipped, error: null };
    } catch (error) {
      return { events: [], skipped: 0, error: `${error?.code ?? "IO_ERROR"}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  return { readTopics, readGroups, readLedger };
}

// ---------------------------------------------------------------------------
// 引擎（评估 / 执行 / 撤销 / 状态的权威入口）
// ---------------------------------------------------------------------------

/**
 * 构造 auto 引擎。management 四个 auto RPC 与 controller pre-step 调度共用同一
 * 实例；全部持久状态落 deps.store（state.mjs autoStore），内存只留单飞闸。
 *
 * @param {object} deps
 * @param {() => string} deps.nowIso 时钟（规范 UTC ISO）。
 * @param {() => string} deps.mode 三档模式取值函数（调用时现读，支持热切换）。
 * @param {() => object} deps.params 12 项参数取值函数（缺省补齐由本引擎复核）。
 * @param {object} deps.replaySource createAutoReplaySource 产物。
 * @param {(scopeId: string) => Promise<object>} deps.serviceFor 按 scopeId 取
 *   service（readTopic / mutate；执行路径的 CAS + journal 幂等都在 service 层）。
 * @param {object|null} deps.store autoStore（null 允许——状态视图降级，写路径
 *   INVALID_STATE；undefined 不允许）。
 * @param {() => boolean} [deps.isStarted] controller 是否 started（pre-step 路径守门）。
 * @param {() => object|null} [deps.readonlyGuard] F7 座位守卫取值函数
 *   （status().writable === false → 不执行 auto，只读评估仍可用）。
 * @param {(scopeId: string) => Promise<boolean>} [deps.watermark] L1 软水位探测
 *   （true = 已逼近 softChars；探测失败按 false 降级）。
 * @param {(entry: object) => void} [deps.onDiagnostics] 诊断汇（静默失败留痕）。
 * @returns {{evaluate, apply, undo, status, onHumanTurn}}
 */
export function createAutoEngine(deps = {}) {
  const {
    nowIso = () => new Date().toISOString(),
    mode,
    params,
    replaySource,
    serviceFor,
    store,
    isStarted = null,
    readonlyGuard = null,
    watermark = null,
    onDiagnostics = null,
  } = deps;
  for (const [name, value] of Object.entries({ mode, params, replaySource, serviceFor })) {
    if (value === undefined || value === null) {
      throw invalidInput(`createAutoEngine requires deps.${name}`, {});
    }
  }
  if (store === undefined) throw invalidInput("createAutoEngine requires deps.store（null 允许，undefined 不允许）", {});

  // 单飞闸：同一 scope 同时只跑一次调度链（评估/执行期间再来人类轮直接跳过，
  // 计入诊断 skippedBusy——CAS 与 autoStore 锁保证了并发安全，这里只为省重复计算）。
  const inFlight = new Set();

  function diag(entry) {
    if (typeof onDiagnostics === "function") {
      try {
        onDiagnostics(entry);
      } catch { /* 诊断汇失败不影响主流程 */ }
    }
  }

  function currentMode() {
    const value = mode();
    if (!AUTO_MODES.includes(value)) {
      throw invalidState(`auto mode 取值非法：${String(value)}`, { mode: String(value) });
    }
    return value;
  }

  function currentParams() {
    const normalized = normalizeTemperatureParams(params());
    validateTemperatureParams(normalized);
    return normalized;
  }

  /** 执行宿主可写守卫：HOST_LOCKED / shadow 不执行 auto（§6.2）。 */
  function assertWritableForAuto(where) {
    const guard = typeof readonlyGuard === "function" ? readonlyGuard() : readonlyGuard;
    if (guard === undefined || guard === null) return;
    const status = typeof guard.status === "function" ? guard.status() : null;
    if (status !== null && status.writable === false) {
      throw invalidState(`${where}: 只读宿主（HOST_LOCKED）不执行 auto`, { holder: status?.holder ?? null });
    }
  }

  function requireStore(where) {
    if (store === null) {
      throw invalidState(`${where}: stateRoot 未配置，auto 记账不可用`, {});
    }
    return store;
  }

  async function storeRead() {
    if (store === null) return { state: null, error: "stateRoot 未配置" };
    return store.read();
  }

  /** 恢复锚（§5.1 minRestoreGraceDays）：来自未撤销 run 的 applied unarchive 条目。 */
  async function restoreAnchorsFromRuns() {
    const read = await storeRead();
    const anchors = new Map();
    if (read.state === null) return anchors;
    for (const run of read.state.runs ?? []) {
      if (run?.undoneAt !== null && run?.undoneAt !== undefined) continue; // 已撤销 = 状态已还原，不再保护
      for (const op of Array.isArray(run?.ops) ? run.ops : []) {
        if (op?.status !== "applied" || op?.operationKind !== "unarchive-topic") continue;
        const identity = autoIdentityKey(op.scopeId, op.key);
        const existing = anchors.get(identity);
        if (existing === undefined || run.at > existing) anchors.set(identity, run.at);
      }
    }
    return anchors;
  }

  /** 纯评估（零写盘）：装配 → 回放 → 熔断 → 候选 → 计划。 */
  async function evaluatePure({ scopeId }) {
    const engineParams = currentParams();
    const [{ rows, skipped: rowsSkipped }, groups, ledger] = await Promise.all([
      replaySource.readTopics(scopeId),
      replaySource.readGroups(scopeId),
      replaySource.readLedger(),
    ]);
    const now = nowIso();
    const replay = evaluateTopics({
      topics: rows.map((row) => ({
        key: row.key,
        scopeId: row.scopeId,
        updated: row.updated,
        archivedAt: row.archivedAt,
        pinned: row.pinned,
        retention: row.retention,
        archiveOrigin: row.archiveOrigin,
        group: row.group,
      })),
      groups,
      events: ledger.events,
      now,
      params: toFormulaParams(engineParams),
    });
    const fuse = computeAutoFuse({
      events: ledger.events,
      now,
      minCooldownDays: engineParams.minCooldownDays,
      ledgerSkipped: ledger.skipped,
      ledgerError: ledger.error,
    });
    const anchors = await restoreAnchorsFromRuns();
    const candidates = deriveAutoCandidates({
      now,
      params: engineParams,
      replayTopics: replay.topics,
      rows,
      fuse,
      restoreAnchors: anchors,
    });
    const plan = fuse.fused
      ? { ops: [], truncated: false, groupRestore: [], counts: { cool: 0, restore: 0, total: 0 } }
      : planAutoOps({ cool: candidates.cool, restore: candidates.restore, rows, maxOpsPerRun: engineParams.maxOpsPerRun, now });
    return { engineParams, now, rows, rowsSkipped, ledger, replay, fuse, candidates, plan };
  }

  /** 评估视图（evaluate / runAutoEvaluation 的返回形状；全部可 JSON 序列化）。 */
  function evaluationView(scopeId, trigger, pure) {
    return {
      scope: scopeId,
      evaluatedAt: pure.now,
      trigger,
      fused: pure.fuse.fused,
      fuse: pure.fuse,
      stats: {
        eventCount: pure.fuse.eventCount,
        ledgerSkipped: pure.ledger.skipped,
        ledgerError: pure.ledger.error,
        topicRows: pure.rows.length,
        rowsSkipped: pure.rowsSkipped,
      },
      replay: {
        topics: pure.replay.topics.length,
        groups: pure.replay.groups.length,
        alarms: pure.replay.alarms,
      },
      candidates: [...pure.candidates.cool, ...pure.candidates.restore].map((candidate) => ({
        operationKind: candidate.operationKind,
        key: candidate.key,
        scopeId: candidate.scopeId,
        title: candidate.title,
        T: candidate.T,
        tier: candidate.tier,
        ageDays: candidate.ageDays,
        reason: candidate.reason,
      })),
      plan: {
        ops: pure.plan.ops,
        truncated: pure.plan.truncated,
        groupRestore: pure.plan.groupRestore,
        counts: pure.plan.counts,
      },
    };
  }

  /** apply 视图（执行回执）。 */
  function applyView(run, replayed, extra = {}) {
    return {
      runId: run.runId,
      replay: replayed === true,
      evaluatedAt: run.at,
      trigger: run.trigger,
      applied: run.ops.filter((op) => op.status === "applied").length,
      skipped: run.ops.filter((op) => op.status === "skipped").length,
      failed: run.ops.filter((op) => op.status === "failed").length,
      truncated: extra.truncated ?? false,
      ops: run.ops.map((op) => ({
        operationKind: op.operationKind,
        key: op.key,
        scopeId: op.scopeId,
        title: op.title ?? null,
        before: { ...op.before },
        after: { ...op.after },
        operationId: op.operationId ?? null,
        status: op.status,
        reason: op.reason,
        ...(op.detail !== undefined ? { detail: op.detail } : {}),
        ...(op.error !== undefined ? { error: op.error } : {}),
      })),
      groupRestore: extra.groupRestore ?? [],
      ...(extra.counts !== undefined ? { counts: extra.counts } : {}),
    };
  }

  /** 单条执行：fresh 重读 → 前置复核 → mutate（CAS + journal operationId）。 */
  async function executeOp(op, { operationIdBase, index }) {
    const entry = {
      operationKind: op.operationKind,
      key: op.key,
      scopeId: op.scopeId,
      title: op.title ?? null,
      before: { ...op.before },
      after: { ...op.after },
      operationId: deriveSubOperationId(op.operationKind === "archive-topic" ? "autoar" : "autoun", operationIdBase, index),
      status: "skipped",
      reason: op.reason,
    };
    try {
      const service = await serviceFor(op.scopeId);
      const fresh = await service.readTopic(op.key);
      if (fresh.scopeId !== op.scopeId) {
        entry.detail = `scope-drift: topic "${op.key}" 属于 scope "${fresh.scopeId}"，与本轮评估口径 "${op.scopeId}" 不符`;
        return entry;
      }
      if (!archiveStateEquals(archiveStateOf(fresh), op.before)) {
        // 评估与执行之间被第三方改过：宁可少执行，绝不覆盖（fail-closed）。
        entry.detail = "state-changed-since-eval";
        return entry;
      }
      await service.mutate({
        operationId: entry.operationId,
        changes: [{
          kind: "topic",
          key: op.key,
          expectedRevision: fresh.revision,
          topic: {
            archivedAt: op.after.archivedAt,
            archiveOrigin: op.after.archiveOrigin,
          },
          text: fresh.body,
        }],
      });
      entry.status = "applied";
      return entry;
    } catch (error) {
      entry.status = "failed";
      entry.error = `${error?.code ?? "INTERNAL"}: ${error instanceof Error ? error.message : String(error)}`;
      return entry;
    }
  }

  const engine = {
    /**
     * 评估（只读回放 + 成功后记账锚）。mode=off 拒绝（off 只记账不计算）；
     * 熔断时不记账锚（失败的评估不算「上次成功评估」）。
     */
    async evaluate({ scopeId, trigger }) {
      if (typeof scopeId !== "string" || scopeId.length === 0) {
        throw invalidInput("evaluate 的 scopeId 必须是非空字符串");
      }
      if (!AUTO_TRIGGERS.includes(trigger)) {
        throw invalidInput(`trigger 必须是 ${AUTO_TRIGGERS.join(" / ")} 之一`, { trigger: String(trigger) });
      }
      const activeMode = currentMode();
      if (activeMode === "off") {
        throw invalidState("auto mode=off：只记账不计算，评估被拒绝（面板切到 suggest/auto 后再试）", { mode: activeMode });
      }
      const ledgerStore = requireStore("evaluate");
      const pure = await evaluatePure({ scopeId });
      const view = evaluationView(scopeId, trigger, pure);
      if (pure.fuse.fused) {
        diag({
          kind: "auto-eval-fused",
          scopeId,
          reasons: pure.fuse.reasons.map((reason) => reason.code),
          at: pure.now,
        });
        return { ...view, fused: true };
      }
      await ledgerStore.markEvaluated(scopeId, pure.now, trigger);
      diag({
        kind: "auto-eval",
        scopeId,
        trigger,
        at: pure.now,
        candidates: { cool: pure.candidates.cool.length, restore: pure.candidates.restore.length },
      });
      return { ...view, fused: false };
    },

    /**
     * 执行一轮（0.5 第三波：mode=suggest / auto 的手动执行入口；off 拒绝——off
     * 只记账不计算。自动调度路径 onHumanTurn 仍只在 mode=auto 调本方法，suggest
     * 绝不自跑）。selection（0.5 第三波 suggest 双通道）：
     *   - 缺省 / null = 全量执行（旧调用语义不变）；
     *   - 数组 = 只执行选中项（≤200 条；过滤发生在 evaluatePure 之后、逐条
     *     executeOp 之前，按 plan 原顺序过滤）。
     * 选中但复算后已不存在的 key（候选已随温度变化消失）→ 记一条
     * { key, operationKind, status: "skipped", reason: "candidate-missing" } 进
     * run.ops（计入 skipped），不整单失败；未选中的候选既不执行也不记 ops、
     * 不计 skipped。run.selection 落账（null 或数组）供审计与回放。
     * operationId 重放口径（0.5 批次 10-2 注释纠正，与实现一致）：run 账本只
     * 保留最近 AUTO_RUN_KEEP 轮（state.mjs recordRun 滚动裁旧），同 operationId
     * 仅在窗口内重放首次结果；被逐出窗口后会重跑——单操作自身的幂等不靠 run
     * 查重，靠底层 journal 的 operationId（service.mutate 幂等重放）。重放命中
     * 还必须 scopeId 一致（getRunByOperationId 过滤），跨 scope 同 opId 不串。
     */
    async apply({ scopeId, trigger, operationId, selection: rawSelection }) {
      if (typeof scopeId !== "string" || scopeId.length === 0) {
        throw invalidInput("apply 的 scopeId 必须是非空字符串");
      }
      if (!AUTO_TRIGGERS.includes(trigger)) {
        throw invalidInput(`trigger 必须是 ${AUTO_TRIGGERS.join(" / ")} 之一`, { trigger: String(trigger) });
      }
      if (typeof operationId !== "string" || operationId.length === 0 || operationId.length > 128) {
        throw invalidInput("apply 的 operationId 必须是 1..128 字符的非空字符串", {});
      }
      const selection = normalizeApplySelection(rawSelection);
      const activeMode = currentMode();
      if (activeMode === "off") {
        throw invalidState("auto mode=off：只记账不计算，执行被拒绝（面板切到 suggest/auto 后再试）", { mode: activeMode });
      }
      assertWritableForAuto("apply");
      const ledgerStore = requireStore("apply");
      // operationId 重放判据先于一切派生（与 analyze 的重放短路同序）；scopeId
      // 过滤防跨 scope 同 opId 串号——窗口内命中才重放，逐出后按新执行处理。
      const prior = await ledgerStore.getRunByOperationId(operationId, scopeId);
      if (prior !== null) {
        assertRunShape(prior);
        return applyView(prior, true);
      }
      const pure = await evaluatePure({ scopeId });
      if (pure.fuse.fused) {
        diag({ kind: "auto-apply-fused", scopeId, reasons: pure.fuse.reasons.map((reason) => reason.code), at: pure.now });
        throw invalidState("auto 熔断：本轮不出任何可执行候选（详见 fuse.reasons）", { fuse: pure.fuse });
      }
      // selection 过滤（null = 全量）：在 evaluatePure 之后、逐条 executeOp 之前，
      // 按 plan 原顺序过滤；选中但复算后已消失的候选按 selection 原顺序补记
      // candidate-missing（skipped），不进执行、不整单失败。
      const opsToExecute = [];
      const missingEntries = [];
      if (selection === null) {
        for (const op of pure.plan.ops) opsToExecute.push(op);
      } else {
        const remaining = new Set(selection.map(selectionItemKey));
        for (const op of pure.plan.ops) {
          const identity = selectionItemKey(op);
          if (!remaining.has(identity)) continue; // 未选中：不执行、不记 ops、不计 skipped
          remaining.delete(identity);
          opsToExecute.push(op);
        }
        for (const item of selection) {
          if (!remaining.has(selectionItemKey(item))) continue;
          // 选中但复算后已不存在（候选随温度变化消失）：记 skipped，不失败。
          // before/after 无真实前后值（候选已不在盘上），占位 null 值——本条
          // status=skipped 不落盘变更，buildUndoOps 只取 applied，占位值不进撤销。
          missingEntries.push({
            operationKind: item.operationKind,
            key: item.key,
            scopeId,
            title: null,
            before: { archivedAt: null, archiveOrigin: null },
            after: { archivedAt: null, archiveOrigin: null },
            status: "skipped",
            reason: "candidate-missing",
          });
        }
      }
      const run = {
        runId: `auto-${Date.parse(pure.now)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        at: pure.now,
        scopeId,
        trigger,
        mode: activeMode,
        operationId,
        selection,
        undoneAt: null,
        ops: [],
      };
      for (let index = 0; index < opsToExecute.length; index += 1) {
        run.ops.push(await executeOp(opsToExecute[index], { operationIdBase: operationId, index }));
      }
      for (const entry of missingEntries) run.ops.push(entry);
      await ledgerStore.recordRun(run);
      await ledgerStore.markEvaluated(scopeId, pure.now, trigger);
      diag({
        kind: "auto-run",
        scopeId,
        runId: run.runId,
        at: pure.now,
        trigger,
        applied: run.ops.filter((op) => op.status === "applied").length,
        selected: selection === null ? null : selection.length,
        truncated: pure.plan.truncated,
      });
      return applyView(run, false, {
        truncated: pure.plan.truncated,
        groupRestore: pure.plan.groupRestore,
        counts: pure.plan.counts,
      });
    },

    /**
     * 一键撤销：只回滚该 run 的 applied 变更（对账现状：现状 = after → 回到
     * before；现状已是 before → 幂等跳过；现状漂移 → 跳过并如实报告）。全部
     * 条目处理完才置 undoneAt（中途失败可重试，已撤销条目按幂等跳过）。
     */
    async undo({ scopeId, runId }) {
      if (typeof scopeId !== "string" || scopeId.length === 0) {
        throw invalidInput("undo 的 scopeId 必须是非空字符串");
      }
      if (typeof runId !== "string" || runId.length === 0) {
        throw invalidInput("undo 的 runId 必须是非空字符串", {});
      }
      assertWritableForAuto("undo");
      const ledgerStore = requireStore("undo");
      const run = await ledgerStore.getRun(runId);
      if (run === null) {
        throw invalidState(`run "${runId}" 不存在（可能已超出 ${AUTO_RUN_KEEP} 条滚动窗口）`, { runId });
      }
      assertRunShape(run);
      if (run.scopeId !== scopeId) {
        throw invalidState(`run "${runId}" 属于 scope "${run.scopeId}"，不能从 scope "${scopeId}" 撤销`, {
          runId,
          runScopeId: run.scopeId,
          scopeId,
        });
      }
      if (run.undoneAt !== null && run.undoneAt !== undefined) {
        // 重复撤销幂等：不碰任何盘，回放首次结论。
        return {
          runId,
          replay: true,
          undoneAt: run.undoneAt,
          reverted: 0,
          alreadyUndone: 0,
          skipped: 0,
          failed: 0,
          ops: run.ops.map((op) => ({ key: op.key, scopeId: op.scopeId, operationKind: op.operationKind, status: op.status })),
        };
      }
      const undoOps = buildUndoOps(run);
      const result = { reverted: 0, alreadyUndone: 0, skipped: 0, failed: 0, ops: [] };
      let hardFailure = false;
      for (let index = 0; index < undoOps.length; index += 1) {
        const op = undoOps[index];
        // 撤销操作的 before/after 语义与 buildUndoOps 对齐：before = run 后状态
        // （撤销执行前的现状），after = run 前状态（撤销执行后的目标）。
        const entry = {
          operationKind: op.operationKind,
          key: op.key,
          scopeId: op.scopeId,
          before: { ...op.before },
          after: { ...op.after },
          reason: op.reason,
          status: "skipped",
        };
        try {
          const service = await serviceFor(op.scopeId);
          const fresh = await service.readTopic(op.key);
          const current = archiveStateOf(fresh);
          if (archiveStateEquals(current, op.before)) {
            // 现状仍是 run 后状态（撤销尚未执行）→ 执行逆操作（写回 run 前状态；
            // CAS）。子操作身份由 runId + 序号确定性派生（重试同一撤销得到同一
            // 身份，journal 幂等）。
            await service.mutate({
              operationId: deriveSubOperationId("autounundo", runId, index),
              changes: [{
                kind: "topic",
                key: op.key,
                expectedRevision: fresh.revision,
                topic: {
                  archivedAt: op.after.archivedAt,
                  archiveOrigin: op.after.archiveOrigin,
                },
                text: fresh.body,
              }],
            });
            entry.status = "applied";
            result.reverted += 1;
          } else if (archiveStateEquals(current, op.after)) {
            // 现状已是 run 前状态（此前撤销已生效/用户手动还原）→ 幂等跳过。
            entry.status = "already-undone";
            result.alreadyUndone += 1;
          } else {
            // 现状漂移（run 之后被第三方改过）→ 撤销只回滚本 run 的变更，不覆盖。
            entry.status = "skipped";
            entry.detail = "state-changed-since-run";
            result.skipped += 1;
          }
        } catch (error) {
          entry.status = "failed";
          entry.error = `${error?.code ?? "INTERNAL"}: ${error instanceof Error ? error.message : String(error)}`;
          result.failed += 1;
          hardFailure = true;
        }
        result.ops.push(entry);
      }
      const undoneAt = hardFailure ? null : nowIso();
      if (!hardFailure) {
        await ledgerStore.markRunUndone(runId, undoneAt);
      }
      diag({ kind: "auto-undo", scopeId, runId, reverted: result.reverted, skipped: result.skipped, failed: result.failed });
      return {
        runId,
        replay: false,
        undoneAt,
        reverted: result.reverted,
        alreadyUndone: result.alreadyUndone,
        skipped: result.skipped,
        failed: result.failed,
        ops: result.ops,
      };
    },

    /**
     * 状态视图（getAutoStatus 数据源）：模式、上次评估、下次触发条件、熔断、
     * 参数与最近 run 摘要。轻量：账本直读 + 熔断判定，不做全量回放。
     */
    async status({ scopeId }) {
      if (typeof scopeId !== "string" || scopeId.length === 0) {
        throw invalidInput("status 的 scopeId 必须是非空字符串");
      }
      const activeMode = currentMode();
      const engineParams = currentParams();
      const ledger = await replaySource.readLedger();
      const now = nowIso();
      const fuse = computeAutoFuse({
        events: ledger.events,
        now,
        minCooldownDays: engineParams.minCooldownDays,
        ledgerSkipped: ledger.skipped,
        ledgerError: ledger.error,
      });
      const read = await storeRead();
      const anchor = read.state?.scopes?.[scopeId] ?? null;
      const lastEvaluatedAt = anchor?.lastEvaluatedAt ?? null;
      const lastEvaluatedBy = anchor?.lastEvaluatedBy ?? null;
      const due = lastEvaluatedAt === null
        ? { triggered: true, reason: "first-run", nextDueAt: null }
        : shouldTriggerAutoEvaluation({
          mode: activeMode,
          isHumanTurn: true,
          lastEvaluatedAt,
          now,
          evaluateEveryHours: engineParams.evaluateEveryHours,
          softWatermark: false,
        });
      const runs = (read.state?.runs ?? [])
        .filter((run) => run?.scopeId === scopeId)
        .slice(-5)
        .reverse()
        .map((run) => ({
          runId: run.runId,
          at: run.at,
          trigger: run.trigger,
          applied: (run.ops ?? []).filter((op) => op.status === "applied").length,
          undoneAt: run.undoneAt ?? null,
        }));
      const watermarkArmed = typeof watermark === "function"
        ? await Promise.resolve(watermark(scopeId)).catch(() => false)
        : false;
      return {
        scope: scopeId,
        mode: activeMode,
        lastEvaluatedAt,
        lastEvaluatedBy,
        nextTrigger: {
          dueAt: due.nextDueAt,
          hoursRemaining: due.nextDueAt === null
            ? null
            : Math.max(0, Math.round(((Date.parse(due.nextDueAt) - Date.parse(now)) / HOUR_MS) * 100) / 100),
          requiresHumanTurn: true,
          softWatermarkArmed: watermarkArmed === true,
        },
        fuse,
        stats: {
          eventCount: fuse.eventCount,
          ledgerSkipped: ledger.skipped,
          ledgerError: ledger.error,
        },
        params: {
          maxOpsPerRun: engineParams.maxOpsPerRun,
          evaluateEveryHours: engineParams.evaluateEveryHours,
          coolThreshold: engineParams.coolThreshold,
          restoreThreshold: engineParams.restoreThreshold,
          minCooldownDays: engineParams.minCooldownDays,
          minRestoreGraceDays: engineParams.minRestoreGraceDays,
        },
        lastRuns: runs,
        ...(read.error !== null ? { storeError: read.error } : {}),
      };
    },

    /**
     * pre-step 调度入口（人类轮 + 周期/水位 → 评估；auto 模式接执行）。fire-and-
     * forget 语义：内部吞掉一切失败（转诊断），绝不向调用方抛错、绝不阻塞主回答。
     * 同 scope 单飞：上一轮还没跑完时本轮直接跳过（计数进诊断）。
     */
    onHumanTurn({ scopeId }) {
      return (async () => {
        try {
          if (typeof isStarted === "function" && isStarted() !== true) return;
          const activeMode = currentMode();
          if (activeMode === "off") return; // off 只记账：调度不评估
          if (inFlight.has(scopeId)) {
            diag({ kind: "auto-schedule-skipped-busy", scopeId, at: nowIso() });
            return;
          }
          inFlight.add(scopeId);
          try {
            const read = await storeRead();
            const anchor = read.state?.scopes?.[scopeId]?.lastEvaluatedAt ?? null;
            const engineParams = currentParams();
            const armed = typeof watermark === "function"
              ? await Promise.resolve(watermark(scopeId)).catch(() => false)
              : false;
            const decision = shouldTriggerAutoEvaluation({
              mode: activeMode,
              // onHumanTurn 只被人类轮调用（controller 侧已判 source.kind === "user"）。
              isHumanTurn: true,
              lastEvaluatedAt: anchor,
              now: nowIso(),
              evaluateEveryHours: engineParams.evaluateEveryHours,
              softWatermark: armed === true,
            });
            if (decision.triggered !== true) {
              diag({ kind: "auto-schedule-not-due", scopeId, reason: decision.reason, at: nowIso() });
              return;
            }
            const trigger = decision.reason === "soft-watermark" ? "soft-watermark" : "human-turn";
            if (activeMode === "auto") {
              await engine.apply({
                scopeId,
                trigger,
                operationId: `auto-sched-${Date.parse(nowIso())}-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
              });
            } else {
              await engine.evaluate({ scopeId, trigger });
            }
          } finally {
            inFlight.delete(scopeId);
          }
        } catch (error) {
          diag({
            kind: "auto-schedule-failed",
            scopeId,
            at: nowIso(),
            error: `${error?.code ?? "INTERNAL"}: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      })();
    },
  };

  return engine;
}
