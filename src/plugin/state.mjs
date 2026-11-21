// Shiori P5-PLUGIN · stateRoot 持久账本（slot P）。
//
// 职责（CONTRACTS §4/§5/§6）：
// - 工具 operationId 重放账：同 scope + 原始业务 payload 绑定 operationId，
//   首次规范化结果（含 CAS/时间/回执）持久化供重放；重放先于新 liveCAS；
//   遗漏的 autoCAS/时间不加入重试输入指纹；
// - L2 投递账：scanned（稳定原始 eventId 去重）、pending（投递先落账）、
//   accepted receipt（surface append 证据）、committed 终态（hit+seen 落地后）；
//   跨 dataRoot/stateRoot 用 journal + 稳定 deliveryId 实现可恢复逻辑提交；
//   任一点崩溃恢复补齐，不因 stats 失败重新追加附件；
// - seen 键库（scope+session+epoch 维度）；
// - 整理/遗忘 plan 账（不可变 planId → plan/digest/diff/summary）与候选队列快照。
//
// 持久原语：单文件 JSON + 原子替换 + fsync（复用 storage/fsutil）；目录级
// withLock 串行化读写。不宣称单 rename 原子跨多账——恢复依赖账本之间的
// 显式状态机（pending → accepted → committed），而不是依赖跨文件原子性。

import path from "node:path";
import { promises as fsp } from "node:fs";
import { withLock } from "../storage/lockfile.mjs";
import { atomicReplace, readFileOrNull, sha256Buffer, stableStringify } from "../storage/fsutil.mjs";
// 0.5 批次 4 D 线：投递诊断记录的形状白名单与滚动裁旧唯一权威在
// sparks/diagnostics.mjs（纯函数，零 IO）；账本层只负责落盘与计数。
import { assertRecordShape, trimRecords } from "../sparks/diagnostics.mjs";

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * 读取 F5 水位采样历史（模块级独立导出：供后续预算建议计算，不必打开整个
 * state store）。旧 scope 没有文件时返回空数组，不报错；sinceDays 给定时
 * 只返回最近 N 天内的条目。水位数据只落 stateRoot，dataRoot 里不存在。
 */
export async function readWaterline(stateRoot, scopeId, { sinceDays } = {}) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) {
    fail("INVALID_INPUT", "readWaterline requires an absolute stateRoot", {});
  }
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    fail("INVALID_INPUT", "readWaterline requires a non-empty scopeId", {});
  }
  if (sinceDays !== undefined && sinceDays !== null
    && (typeof sinceDays !== "number" || !Number.isFinite(sinceDays) || sinceDays <= 0)) {
    fail("INVALID_INPUT", `readWaterline sinceDays must be a positive finite number, got ${JSON.stringify(sinceDays)}`, { sinceDays });
  }
  const file = path.join(stateRoot, "waterline", `${Buffer.from(scopeId, "utf8").toString("hex")}.json`);
  const bytes = await readFileOrNull(file);
  if (bytes === null) return [];
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail("INVALID_STATE", `waterline ledger is unreadable: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  if (sinceDays === undefined || sinceDays === null) return entries;
  const cutoff = Date.now() - sinceDays * 86_400_000;
  return entries.filter((entry) => {
    const at = Date.parse(entry?.at);
    return Number.isFinite(at) && at >= cutoff;
  });
}

/**
 * 单文件 JSON 账本：load() 读盘（缺失→empty），mutate(fn) 在锁内读-改-原子写。
 * mutate 的 fn 收到当前数据，返回新数据；写失败抛错不改内存态。
 */
function createLedger({ file, empty, lockRoot }) {
  let cache = null; // 已加载的最新内存态；写入成功才更新
  async function load() {
    if (cache !== null) return cache;
    const bytes = await readFileOrNull(file);
    if (bytes === null) {
      cache = structuredClone(empty());
      return cache;
    }
    try {
      cache = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      fail("INVALID_STATE", `state ledger ${path.basename(file)} is unreadable: ${error instanceof Error ? error.message : String(error)}`, { file });
    }
    return cache;
  }
  async function mutate(fn) {
    return withLock(lockRoot, { timeoutMs: 10_000, retryMs: 50 }, async () => {
      const current = await load();
      const next = fn(structuredClone(current));
      if (next === undefined || next === null) {
        fail("INVALID_STATE", "state ledger mutate must return the next state", { file });
      }
      // 无变更不落盘：L1 装配是每轮热路径，账本「读-判-写」若每次都原子写，
      // 会把「绝不每轮写盘」的承诺变成每轮一次加锁 + 序列化 + rename。
      // 序列化后按字节比较即可（同一份数据 → 同一份文本）。
      const before = JSON.stringify(current);
      const after = JSON.stringify(next);
      if (before === after) {
        cache = current;
        return structuredClone(next);
      }
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await atomicReplace(file, Buffer.from(JSON.stringify(next, null, 2), "utf8"));
      cache = next;
      return structuredClone(next);
    });
  }
  async function read() {
    return structuredClone(await load());
  }
  function resetMemoryCache() {
    cache = null;
  }
  return { load, mutate, read, resetMemoryCache };
}

/**
 * 打开 stateRoot 下的全部账本。
 * 布局：
 *   <stateRoot>/tool-ops/<scopeId>.json            工具 operationId 重放账
 *   <stateRoot>/l2/<scopeId>.json                  L2 投递账（scanned/pending/accepted/committed/hit/seen）
 *   <stateRoot>/plans/<scopeId>.json               plan 账（organize/forgetting，不可变）
 *   <stateRoot>/queues/<scopeId>.json              候选队列快照
 *   <stateRoot>/waterline/<scopeId hex>.json       F5 前置 · L1 水位采样侧表（低频）
 *   <stateRoot>/diagnostics/<scopeId hex>.json     0.5-4D · L2 投递诊断账本（每轮一条，7 天滚动）
 *   <stateRoot>/auto-organize.json                 0.5-5A · auto 冷却/恢复记账（评估锚 + run 审计）
 */
export function createStateStore({ stateRoot, now = () => new Date() } = {}) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) {
    fail("INVALID_INPUT", "state store requires an absolute stateRoot", {});
  }
  // 可注入时钟（waterline 采样节流测试用）；生产缺省取真实时间。
  const nowDate = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };

  const safeSegment = (id) => {
    if (typeof id !== "string" || id.length === 0 || /[<>:"/\\|?*\u0000-\u001f]/.test(id)) {
      fail("INVALID_INPUT", `scopeId "${id}" is not usable as a state file segment`, {});
    }
    return Buffer.from(id, "utf8").toString("hex"); // 文件名安全：scopeId hex 编码
  };

  const toolOps = (scopeId) => createLedger({
    file: path.join(stateRoot, "tool-ops", `${safeSegment(scopeId)}.json`),
    empty: () => ({ operations: {} }),
    lockRoot: stateRoot,
  });

  const l2Ledger = (scopeId) => createLedger({
    file: path.join(stateRoot, "l2", `${safeSegment(scopeId)}.json`),
    empty: () => ({ scanned: {}, pending: {}, accepted: {}, committed: {}, seen: {}, hits: {}, sessionEpochs: {} }),
    lockRoot: stateRoot,
  });

  const plansLedger = (scopeId) => createLedger({
    file: path.join(stateRoot, "plans", `${safeSegment(scopeId)}.json`),
    empty: () => ({ plans: {} }),
    lockRoot: stateRoot,
  });

  const analyzeOpsLedger = (scopeId) => createLedger({
    file: path.join(stateRoot, "analyze-ops", `${safeSegment(scopeId)}.json`),
    empty: () => ({ operations: {} }),
    lockRoot: stateRoot,
  });

  const queueLedger = (scopeId) => createLedger({
    file: path.join(stateRoot, "queues", `${safeSegment(scopeId)}.json`),
    empty: () => ({ snapshot: null }),
    lockRoot: stateRoot,
  });

  const projectionLedger = (scopeId) => createLedger({
    file: path.join(stateRoot, "projections", `${safeSegment(scopeId)}.json`),
    empty: () => ({ l1: null }),
    lockRoot: stateRoot,
  });

  const diagnosticsLedger = (scopeId) => createLedger({
    file: path.join(stateRoot, "diagnostics", `${safeSegment(scopeId)}.json`),
    empty: () => ({ records: [] }),
    lockRoot: stateRoot,
  });

  /**
   * 每个 scope 上次真正落盘的投影签名（revision\0hash）。
   * L1 装配是每轮热路径：投影没变时就别进账本（withLock 要开/删锁文件、
   * 再序列化对比、必要时 rename），否则「每轮一次磁盘写 + 一次加锁」。
   * 进程内单写者（F7 座位保证），所以这份记忆是权威的。
   */
  const lastSavedL1 = new Map();

  /** L1 最近有效投影（超限外改时保留并告警；不截断铁律）。 */
  const projectionStore = {
    /**
     * 保存 L1 投影。waterline 可选（F5 前置）：active 装配路径传入当前预算
     * 水位线时，顺路做低频水位采样（state.mjs 内部节流，绝不每轮写盘）；
     * 不传则行为与 0.1 完全一致。只读宿主（shadow / F7 只读降级）不经过
     * 本路径（waterfall 仅 active 注册），天然不写。
     */
    async saveL1(scopeId, { text, revision, waterline }) {
      const hash = sha256Buffer(Buffer.from(text, "utf8"));
      const signature = `${revision ?? ""}\u0000${hash}`;
      if (lastSavedL1.get(scopeId) !== signature) {
        await projectionLedger(scopeId).mutate((state) => {
          // savedAt 只记「投影真的变了」的时刻：同样的内容重复装配不刷新它。
          state.l1 = {
            text: structuredClone(text),
            revision: revision ?? null,
            hash,
            savedAt: new Date().toISOString(),
          };
          return state;
        });
        lastSavedL1.set(scopeId, signature);
      }
      if (waterline !== undefined && waterline !== null) {
        // 水位采样自带节流，且无变更不落盘（见 createLedger.mutate）。
        await waterlineStore.maybeSample(scopeId, {
          l1Chars: text.length,
          softChars: waterline.softChars,
          hardChars: waterline.hardChars,
          hardCapChars: waterline.hardCapChars,
        });
      }
    },
    async loadL1(scopeId) {
      const state = await projectionLedger(scopeId).read();
      return state.l1 === null ? null : structuredClone(state.l1);
    },
  };

  // ------------------------------------------------------------------
  // F5 前置 · L1 水位采样侧表（<stateRoot>/waterline/<scopeId hex>.json）
  // ------------------------------------------------------------------

  /** 环形上限：超出丢最旧（F5 只算「过去 N 天 N 次触闸」，2000 条远超所需）。 */
  const WATERLINE_MAX_ENTRIES = 2000;
  /** 采样最小间隔：距上一条采样不足 1 小时且未跨阈值时不记（绝不每轮写盘）。 */
  const WATERLINE_MIN_INTERVAL_MS = 60 * 60 * 1000;

  const waterlineLedger = (scopeId) => createLedger({
    file: path.join(stateRoot, "waterline", `${safeSegment(scopeId)}.json`),
    empty: () => ({ entries: [] }),
    lockRoot: stateRoot,
  });

  /** 水位三区：safe < softChars ≤ warning < hardChars ≤ danger。 */
  function waterlineZone(l1Chars, softChars, hardChars) {
    if (l1Chars >= hardChars) return "danger";
    if (l1Chars >= softChars) return "warning";
    return "safe";
  }

  const waterlineStore = {
    /**
     * 低频采样：满足其一才记一条 —— 距上一条采样 ≥ 1 小时；或由安全区
     * 进入警告区 / 进入危险区（zone 相对「上一条自己记录的水位线」判定，
     * 预算变更不产生假跨越；降回低区不记，等下一个间隔采样兜底）。
     * 返回是否实际记录了一条。
     */
    async maybeSample(scopeId, { l1Chars, softChars, hardChars, hardCapChars }) {
      for (const [field, value] of Object.entries({ l1Chars, softChars, hardChars, hardCapChars })) {
        if (!Number.isInteger(value) || value < 0) {
          fail("INVALID_INPUT", `waterline sample ${field} must be a non-negative integer, got ${JSON.stringify(value)}`, { field });
        }
      }
      const zone = waterlineZone(l1Chars, softChars, hardChars);
      let recorded = false;
      await waterlineLedger(scopeId).mutate((state) => {
        const entries = Array.isArray(state.entries) ? state.entries : [];
        const last = entries.length > 0 ? entries[entries.length - 1] : null;
        let trigger = null;
        if (last === null) {
          trigger = "interval"; // 首条：无历史可比，按间隔到期记
        } else {
          const elapsed = nowDate().getTime() - Date.parse(last.at);
          if (!Number.isFinite(elapsed) || elapsed >= WATERLINE_MIN_INTERVAL_MS) {
            trigger = "interval";
          } else {
            const lastZone = waterlineZone(last.l1Chars, last.softChars, last.hardChars);
            if (zone !== lastZone) {
              if (zone === "warning" && lastZone === "safe") trigger = "soft-cross";
              else if (zone === "danger") trigger = "hard-cross";
            }
          }
        }
        if (trigger === null) return state;
        entries.push({
          at: nowDate().toISOString(),
          l1Chars,
          softChars,
          hardChars,
          hardCapChars,
          trigger,
        });
        while (entries.length > WATERLINE_MAX_ENTRIES) entries.shift();
        state.entries = entries;
        recorded = true;
        return state;
      });
      return recorded;
    },
  };

  /**
   * 水位采样历史读取（store 实例入口；实现见模块级 readWaterline 导出）。
   */
  function readWaterlineFor(scopeId, opts) {
    return readWaterline(stateRoot, scopeId, opts);
  }

  // ------------------------------------------------------------------
  // 0.5 批次 4 D 线 · L2 投递诊断账本（<stateRoot>/diagnostics/<scopeId hex>.json）
  // ------------------------------------------------------------------

  /**
   * 写侧诊断计数（topic-activity 同款口径：append 绝不抛、失败只计数留痕，
   * 调用方（controller pre-step）fire-and-forget，写失败只告警不阻塞投递）。
   * 评审 R17：按 scope 记数——writerStats(scopeId) 返回该 scope 的计数，
   * 多 scope 面板各自读各自的账，不再串号。
   */
  const diagnosticsWriteStatsByScope = new Map(); // scopeId → { appended, failed, lastError, lastSuccessAt }
  function writeStatsFor(scopeId) {
    if (typeof scopeId !== "string" || scopeId.length === 0) {
      fail("INVALID_INPUT", "writerStats requires a non-empty scopeId");
    }
    let entry = diagnosticsWriteStatsByScope.get(scopeId);
    if (entry === undefined) {
      entry = { appended: 0, failed: 0, lastError: null, lastSuccessAt: null };
      diagnosticsWriteStatsByScope.set(scopeId, entry);
    }
    return entry;
  }

  const diagnosticsStore = {
    /**
     * 追加一条投递诊断记录（每轮 pre-step 一条，不含卡片正文）。形状白名单
     * 违规直接抛（编程错误走严格口径）；IO 失败折叠为 { ok:false }（诊断数据
     * 路径绝不打断召回/投递主链路），失败计数进 writerStats(scopeId) 面板可见（按 scope 记数）。
     * 落盘前按 7 天滚动裁旧 + 硬上限（裁旧用 store 注入时钟，测试可推时间）。
     */
    async appendRecord(scopeId, record) {
      assertRecordShape(record);
      try {
        await diagnosticsLedger(scopeId).mutate((state) => {
          const records = Array.isArray(state.records) ? state.records : [];
          records.push(structuredClone(record));
          state.records = trimRecords(records, { now: nowDate().getTime() });
          return state;
        });
        const stats = writeStatsFor(scopeId);
        stats.appended += 1;
        stats.lastSuccessAt = new Date().toISOString();
        return { ok: true };
      } catch (error) {
        const stats = writeStatsFor(scopeId);
        stats.failed += 1;
        stats.lastError = error instanceof Error ? error.message : String(error);
        return { ok: false, error: stats.lastError };
      }
    },
    /** 全量记录读取（裁旧在 readDiagnostics 侧做；账本读侧不重复裁）。 */
    async readRecords(scopeId) {
      const state = await diagnosticsLedger(scopeId).read();
      return Array.isArray(state.records) ? structuredClone(state.records) : [];
    },
    /** 写侧计数快照（getStatus.diagnostics.delivery.writer 数据源；按 scope
     * 记数——评审 R17，多 scope 不串号）。 */
    writerStats(scopeId) {
      return { ...writeStatsFor(scopeId) };
    },
  };

  // ------------------------------------------------------------------
  // 工具 operationId 重放账
  // ------------------------------------------------------------------

  /** 指纹 = scope + 原始业务 payload（不含 operationId / 时间 / autoCAS）。 */
  function toolFingerprint(scopeId, toolName, payload) {
    return sha256Buffer(Buffer.from(stableStringify({ scopeId, toolName, payload }), "utf8"));
  }

  const toolOpStore = {
    /**
     * 重放检查：存在同 id 账目时，同指纹返回首次回执（replayed=true），
     * 异指纹拒绝。无账目返回 null（调用方继续执行）。
     */
    async lookup(scopeId, toolName, operationId, payload) {
      const ledger = await toolOps(scopeId).read();
      const entry = Object.hasOwn(ledger.operations, operationId) ? ledger.operations[operationId] : undefined;
      if (entry === undefined) return null;
      const fingerprint = toolFingerprint(scopeId, toolName, payload);
      if (entry.fingerprint !== fingerprint) {
        fail("INVALID_INPUT", `operationId "${operationId}" was already used with a different payload for ${toolName}`, {
          operationId, toolName,
        });
      }
      return { ...structuredClone(entry.result), replayed: true };
    },
    /** 首次成功执行后持久化回执（同 id 异 payload 由 lookup 拒绝）。 */
    async record(scopeId, toolName, operationId, payload, result) {
      const fingerprint = toolFingerprint(scopeId, toolName, payload);
      await toolOps(scopeId).mutate((state) => {
        const entry = Object.hasOwn(state.operations, operationId) ? state.operations[operationId] : undefined;
        if (entry !== undefined) {
          if (entry.fingerprint !== fingerprint) {
            fail("INVALID_INPUT", `operationId "${operationId}" was already used with a different payload for ${toolName}`, {
              operationId, toolName,
            });
          }
          return state; // 已记录（并发同 id）：保留首次
        }
        state.operations[operationId] = {
          fingerprint,
          toolName,
          recordedAt: new Date().toISOString(),
          result: structuredClone(result),
        };
        return state;
      });
      return structuredClone(result);
    },
  };

  // ------------------------------------------------------------------
  // L2 投递账
  // ------------------------------------------------------------------

  const l2Store = {
    /** 是否已扫描过稳定原始 eventId（Message.id）。 */
    async isScanned(scopeId, sourceMessageId) {
      const state = await l2Ledger(scopeId).read();
      return Object.hasOwn(state.scanned, sourceMessageId);
    },
    /** 标记已扫描（先于投递；重复标记幂等）。 */
    async markScanned(scopeId, sourceMessageId) {
      await l2Ledger(scopeId).mutate((state) => {
        if (!Object.hasOwn(state.scanned, sourceMessageId)) {
          state.scanned[sourceMessageId] = { at: new Date().toISOString() };
        }
        return state;
      });
    },
    /** 记 pending（投递先落账：崩溃恢复依据；含完整 delivery 快照）。 */
    async recordPending(scopeId, delivery) {
      await l2Ledger(scopeId).mutate((state) => {
        if (!Object.hasOwn(state.pending, delivery.deliveryId)) {
          state.pending[delivery.deliveryId] = {
            deliveryId: delivery.deliveryId,
            messageId: delivery.messageId,
            sourceMessageId: delivery.sourceMessageId,
            session: delivery.sessionId,
            epoch: delivery.contextEpoch,
            createdAt: new Date().toISOString(),
            delivery: structuredClone(delivery.delivery),
          };
        }
        return state;
      });
    },
    /** 查单个 pending（按稳定 deliveryId；存在返回 {accepted,...}，否则 null）。 */
    async pendingById(scopeId, deliveryId) {
      const state = await l2Ledger(scopeId).read();
      const p = state.pending[deliveryId];
      if (p === undefined) return null;
      return {
        deliveryId: p.deliveryId,
        messageId: p.messageId,
        sourceMessageId: p.sourceMessageId,
        epoch: p.epoch,
        session: p.session,
        accepted: Object.hasOwn(state.accepted, p.deliveryId),
        committed: Object.hasOwn(state.committed, p.deliveryId),
      };
    },
    /**
     * 未终态（未 committed）的 pending：accepted 未 committed 的由恢复补齐收尾；
     * 无 accepted receipt 的只能保持 pending 且禁重发（宿主缺幂等 receipt 时不
     * 盲目重发原 event）。
     */
    async pendingUnfinalized(scopeId) {
      const state = await l2Ledger(scopeId).read();
      return Object.values(state.pending)
        .filter((p) => !Object.hasOwn(state.committed, p.deliveryId))
        .map((p) => ({
          deliveryId: p.deliveryId,
          messageId: p.messageId,
          sourceMessageId: p.sourceMessageId,
          epoch: p.epoch,
          session: p.session,
          accepted: Object.hasOwn(state.accepted, p.deliveryId),
        }));
    },
    /**
     * 持久 accepted receipt（surface append 证据；崩溃点 1）。
     * 仅当 pending 存在同 messageId 时接受（真实 session/event 证据链）。
     * 返回命中的投递；未知 messageId（非本插件消息）返回 null。
     */
    async recordAccepted(scopeId, { messageId }) {
      const state = await l2Ledger(scopeId).read();
      const pending = Object.values(state.pending).find((p) => p.messageId === messageId);
      if (pending === undefined) return null;
      await l2Ledger(scopeId).mutate((current) => {
        if (!Object.hasOwn(current.accepted, pending.deliveryId)) {
          current.accepted[pending.deliveryId] = {
            deliveryId: pending.deliveryId,
            messageId,
            acceptedAt: new Date().toISOString(),
          };
        }
        return current;
      });
      return {
        deliveryId: pending.deliveryId,
        sourceMessageId: pending.sourceMessageId,
        epoch: pending.epoch,
        session: pending.session,
      };
    },
    /** 持久 hit 账（commitDelivery 的 hitUpdates；崩溃点 2 之后由调用方写 store）。 */
    async recordHits(scopeId, deliveryId, hitUpdates) {
      await l2Ledger(scopeId).mutate((state) => {
        if (!Object.hasOwn(state.hits, deliveryId)) {
          state.hits[deliveryId] = structuredClone(hitUpdates);
        }
        return state;
      });
    },
    /** 已 seen 键集合（scope+session+epoch → 键数组）。 */
    async seenKeys(scopeId, sessionId, contextEpoch) {
      const state = await l2Ledger(scopeId).read();
      const key = `${sessionId}\u0000${contextEpoch}`;
      return Object.hasOwn(state.seen, key) ? state.seen[key] : [];
    },
    /** 追加 seen 键（幂等）。 */
    async addSeenKeys(scopeId, sessionId, contextEpoch, keys) {
      await l2Ledger(scopeId).mutate((state) => {
        const key = `${sessionId}\u0000${contextEpoch}`;
        const current = Object.hasOwn(state.seen, key) ? state.seen[key] : [];
        const set = new Set(current);
        for (const k of keys) set.add(k);
        state.seen[key] = [...set];
        return state;
      });
    },
    /** committed 终态 marker（崩溃恢复补齐后的收尾；崩溃点 3）。 */
    async recordCommitted(scopeId, deliveryId) {
      await l2Ledger(scopeId).mutate((state) => {
        if (!Object.hasOwn(state.committed, deliveryId)) {
          state.committed[deliveryId] = { committedAt: new Date().toISOString() };
        }
        return state;
      });
    },
    async isCommitted(scopeId, deliveryId) {
      const state = await l2Ledger(scopeId).read();
      return Object.hasOwn(state.committed, deliveryId);
    },
    /** 压缩 epoch 按 session 隔离（A 成功压缩不清 B 冷却）。 */
    async sessionEpoch(scopeId, sessionId) {
      const state = await l2Ledger(scopeId).read();
      return Object.hasOwn(state.sessionEpochs, sessionId) ? state.sessionEpochs[sessionId] : 0;
    },
    /** 仅推进该 session 的 epoch（其他会话不动）。 */
    async bumpSessionEpoch(scopeId, sessionId) {
      await l2Ledger(scopeId).mutate((state) => {
        const current = Object.hasOwn(state.sessionEpochs, sessionId) ? state.sessionEpochs[sessionId] : 0;
        state.sessionEpochs[sessionId] = current + 1;
        return state;
      });
    },
    /** deliveryId：scope+session+sourceMessage+epoch 的稳定哈希（重试不变）。 */
    deliveryIdFor({ scopeId, sessionId, sourceMessageId, contextEpoch }) {
      return sha256Buffer(Buffer.from(stableStringify({
        v: 1, scopeId, sessionId, sourceMessageId, contextEpoch,
      }), "utf8"));
    },
    diagnostics(scopeId) {
      return l2Ledger(scopeId).read();
    },
  };

  // ------------------------------------------------------------------
  // plan 账（不可变）
  // ------------------------------------------------------------------

  const planStore = {
    /** 保存 plan（不可变：同 planId 二次保存仅当内容一致才幂等，否则拒绝）。 */
    async save(scopeId, planId, entry) {
      await plansLedger(scopeId).mutate((state) => {
        const existing = Object.hasOwn(state.plans, planId) ? state.plans[planId] : undefined;
        if (existing !== undefined) {
          if (existing.planDigest !== entry.planDigest) {
            fail("INVALID_STATE", `planId "${planId}" already exists with a different digest`, { planId });
          }
          return state;
        }
        state.plans[planId] = {
          planId,
          kind: entry.kind,
          planDigest: entry.planDigest,
          queueRevision: entry.queueRevision ?? null,
          plan: structuredClone(entry.plan),
          diff: structuredClone(entry.diff ?? []),
          changedItems: entry.changedItems ?? 0,
          summary: entry.summary ?? "",
          createdAt: new Date().toISOString(),
          executed: false,
        };
        return state;
      });
    },
    async get(scopeId, planId) {
      const state = await plansLedger(scopeId).read();
      const entry = Object.hasOwn(state.plans, planId) ? state.plans[planId] : undefined;
      return entry === undefined ? null : structuredClone(entry);
    },
    async list(scopeId) {
      const state = await plansLedger(scopeId).read();
      return Object.values(state.plans)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : (a.planId < b.planId ? -1 : 1)))
        .map((p) => ({
          planId: p.planId,
          kind: p.kind,
          planDigest: p.planDigest,
          queueRevision: p.queueRevision,
          changedItems: p.changedItems,
          summary: p.summary,
          createdAt: p.createdAt,
          executed: p.executed,
          // P-A：计划收敛——仍 open 且被更新计划取代的条目如实标注（客户端据此禁用执行）。
          superseded: p.supersededWith !== undefined,
        }));
    },
    async markExecuted(scopeId, planId, operationId) {
      await plansLedger(scopeId).mutate((state) => {
        const entry = Object.hasOwn(state.plans, planId) ? state.plans[planId] : undefined;
        if (entry === undefined) {
          fail("NOT_FOUND", `plan "${planId}" not found`, { planId });
        }
        entry.executed = true;
        entry.executedWith = operationId;
        entry.executedAt = new Date().toISOString();
        return state;
      });
    },
    /**
     * P-A 计划收敛：把同 scope 同 kind 且仍 open（未执行、未作废）的计划标记
     * 为已作废（keepPlanId 除外）。已 executed 的保留审计；已被其他 operationId
     * 作过废的不改写——同 operationId 重放不改任何状态（幂等）。
     * 返回本次实际作废的 planId 列表。
     */
    async supersedeOpen(scopeId, { kind, keepPlanId, operationId }) {
      if (kind !== "organize" && kind !== "forgetting" && kind !== "archive-topic") {
        fail("INVALID_INPUT", `supersedeOpen kind must be organize/forgetting/archive-topic, got ${JSON.stringify(kind)}`, {});
      }
      const superseded = [];
      await plansLedger(scopeId).mutate((state) => {
        for (const [planId, entry] of Object.entries(state.plans)) {
          if (planId === keepPlanId) continue;
          if (entry.executed === true) continue;
          if (entry.supersededWith !== undefined) continue;
          // 旧形状兼容：升级前归档计划以 kind:"organize" + plan.kind
          // "archive-topic" 落库（新落库的归档计划不再走 kind:"organize"，
          // 这条规则只为升级前已落库的旧计划）。非 archive-topic 收敛时跳过
          // 这类旧条目（不作废）——整理分析/整理预览不再顺手作废归档计划；
          // archive-topic 收敛时除新 kind 外还把它们一并作废。
          const legacyArchive = entry.kind === "organize" && entry.plan?.kind === "archive-topic";
          if (kind === "archive-topic") {
            if (entry.kind !== "archive-topic" && !legacyArchive) continue;
          } else {
            if (entry.kind !== kind) continue;
            if (legacyArchive) continue;
          }
          entry.supersededWith = operationId;
          entry.supersededAt = new Date().toISOString();
          superseded.push(planId);
        }
        return state;
      });
      return superseded;
    },
  };

  // ------------------------------------------------------------------
  // analyze operationId 重放账（P-A：analyze 幂等——重放返回首次派生结果，
  // 不二次收敛队列、不因 now 漂移二次落 plan）
  // ------------------------------------------------------------------

  const analyzeOpStore = {
    /** 命中返回 {kind, operationId, planId, plan, analysis}；未命中 null。 */
    async get(scopeId, kind, operationId) {
      const state = await analyzeOpsLedger(scopeId).read();
      const key = `${kind}\u0000${operationId}`;
      const entry = Object.hasOwn(state.operations, key) ? state.operations[key] : undefined;
      return entry === undefined ? null : structuredClone(entry);
    },
    /** 首写为准：已存在时不覆盖；返回既有记录或本次新写记录（均含完整字段）。 */
    async put(scopeId, kind, operationId, value) {
      const key = `${kind}\u0000${operationId}`;
      await analyzeOpsLedger(scopeId).mutate((state) => {
        if (Object.hasOwn(state.operations, key)) return state;
        state.operations[key] = {
          kind,
          operationId,
          planId: value.planId ?? null,
          plan: value.plan === undefined || value.plan === null ? null : structuredClone(value.plan),
          diff: value.diff === undefined ? [] : structuredClone(value.diff),
          analysis: structuredClone(value.analysis),
          // P-A：organize 操作记录收敛后的队列快照——journal 落盘与队列保存
          // 之间崩溃时，重放可据此幂等修复（仅当磁盘 revision 落后才补写）。
          queueSnapshot: value.queueSnapshot === undefined ? null : structuredClone(value.queueSnapshot),
          createdAt: new Date().toISOString(),
        };
        return state;
      });
      return this.get(scopeId, kind, operationId);
    },
  };

  // ------------------------------------------------------------------
  // 候选队列快照
  // ------------------------------------------------------------------

  const queueStore = {
    async save(scopeId, snapshot) {
      await queueLedger(scopeId).mutate((state) => {
        state.snapshot = structuredClone(snapshot);
        state.savedAt = new Date().toISOString();
        return state;
      });
    },
    async load(scopeId) {
      const state = await queueLedger(scopeId).read();
      return state.snapshot === null ? null : structuredClone(state.snapshot);
    },
  };

  // ------------------------------------------------------------------
  // 0.5 批次 4 · C 线：整理向导标记位（<stateRoot>/onboarding.json，scope 无关）
  //
  // 形状：{ version, dismissedAt?, completedAt?, proposalHash? }。「以后再说」
  // 写 dismissedAt 后不再触发；面板「重新开始」清 dismissedAt；向导应用成功
  // 写 completedAt + proposalHash。与 queueStore 同款 createLedger 地基：
  // 无变更不落盘（读-判-写 + 字节比较，节流/幂等），原子替换 + fsync。
  //
  // 诊断不阻塞（§11.2.7：写盘失败只诊断不阻塞）：本 store 的方法绝不抛——
  // 读失败（缺失/损坏/版本不识别）返回 {flag: null, error: 摘要}，向导按
  // 「无标记位」降级（最坏结果是卡片重新出现一次）；写失败返回
  // {ok: false, error: 摘要}，调用方把摘要透传进 diagnostics，不陪葬主流程。
  // ------------------------------------------------------------------

  const ONBOARDING_FLAG_VERSION = 1;

  const onboardingLedger = createLedger({
    file: path.join(stateRoot, "onboarding.json"),
    empty: () => ({ version: ONBOARDING_FLAG_VERSION }),
    lockRoot: stateRoot,
  });

  /** 有界错误摘要（只供诊断展示，不要求还原完整错误）。 */
  function onboardingErrorSummary(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 200 ? `${message.slice(0, 199)}…` : message;
  }

  /** 形状校验：version 只认 1；时间戳/摘要字段必须是非空字符串或缺省。 */
  function validateOnboardingFlag(flag) {
    if (flag === null || typeof flag !== "object" || Array.isArray(flag)) return null;
    if (flag.version !== ONBOARDING_FLAG_VERSION) return null;
    for (const field of ["dismissedAt", "completedAt", "proposalHash"]) {
      const value = flag[field];
      if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0)) {
        return null;
      }
    }
    return {
      version: ONBOARDING_FLAG_VERSION,
      dismissedAt: typeof flag.dismissedAt === "string" ? flag.dismissedAt : null,
      completedAt: typeof flag.completedAt === "string" ? flag.completedAt : null,
      proposalHash: typeof flag.proposalHash === "string" ? flag.proposalHash : null,
    };
  }

  const onboardingStore = {
    /**
     * 读标记位。缺失/损坏/版本不识别一律 {flag: null, error?}——error 为有界
     * 摘要（损坏与版本不识别时）。缺失文件返回归一化空标记
     * {version, dismissedAt:null, completedAt:null, proposalHash:null}（createLedger
     * 空模板，行为即「无标记位」）；损坏/版本不识别时 flag 才为 null。绝不抛、绝不写盘。
     */
    async read() {
      try {
        const state = await onboardingLedger.read();
        const flag = validateOnboardingFlag(state);
        if (flag !== null) return { flag, error: null };
        return {
          flag: null,
          error: `onboarding.json 形状或版本不识别（期望 version=${ONBOARDING_FLAG_VERSION}），按无标记位降级`,
        };
      } catch (error) {
        // createLedger.read 只在 JSON 损坏时抛（缺失返回空模板）；按无标记降级。
        return { flag: null, error: onboardingErrorSummary(error) };
      }
    },

    /**
     * 坏 JSON 自愈（R6②/P2-5）：损坏的 onboarding.json 会让读路径降级（向导
     * 反复出现）而写路径永久失败、UI 又可能丢 warning——写动作遇 INVALID_STATE
     * （JSON 损坏）时把坏文件改名 .corrupt-<ts> 备份后按空账本重试一次。
     * 备份时间戳用注入时钟 nowDate()（测试可固定，使命中 rename 失败分支可
     * 确定性构造）。仅自愈「账本损坏」；IO 故障（权限/磁盘）与「备份 rename
     * 失败」（评审二轮 R1，P1）都原样抛出——调用方必须产出 {ok:false, error}
     * 让 UI 看见「没写成」，绝不吞成成功。
     */
    async mutateWithHeal(mutateFn) {
      try {
        await onboardingLedger.mutate(mutateFn);
        return { healed: false };
      } catch (error) {
        if (error?.code !== "INVALID_STATE") throw error;
        const corruptFile = `${path.join(stateRoot, "onboarding.json")}.corrupt-${nowDate().getTime()}`;
        try {
          await fsp.rename(path.join(stateRoot, "onboarding.json"), corruptFile);
        } catch (renameError) {
          const annotated = new Error(
            `onboarding.json 损坏自愈失败（备份 rename 失败：${onboardingErrorSummary(renameError)}）；原错误：${onboardingErrorSummary(error)}`,
          );
          annotated.code = error.code;
          throw annotated;
        }
        await onboardingLedger.mutate(mutateFn);
        return { healed: true, corruptFile: path.basename(corruptFile) };
      }
    },

    /**
     * 「以后再说」：写 dismissedAt。保留 completedAt 审计；proposalHash 仅在
     * 未完成时写入（R9③/P2-8：完成后 dismiss 不得覆盖完成时的提案 hash 审计）。
     * 幂等：重复 dismiss 刷新 dismissedAt（最后搁置时刻为准）；无变更不落盘。
     */
    async dismiss(nowIso, proposalHash = null) {
      try {
        const heal = await this.mutateWithHeal((state) => {
          state.version = ONBOARDING_FLAG_VERSION;
          state.dismissedAt = nowIso;
          if (proposalHash !== null && proposalHash !== undefined
            && (state.completedAt === undefined || state.completedAt === null)) {
            state.proposalHash = proposalHash;
          }
          return state;
        });
        return { ok: true, error: null, ...(heal.healed ? { healed: true, healedDetail: heal.corruptFile } : {}) };
      } catch (error) {
        return { ok: false, error: onboardingErrorSummary(error) };
      }
    },

    /**
     * 「重新开始」：清 dismissedAt（completedAt/proposalHash 不动——已完成
     * 的审计痕迹不被重开抹掉）。幂等：本就无 dismissedAt 时无变更不落盘。
     * 坏 JSON 自愈同 dismiss（mutateWithHeal）。
     */
    async restart() {
      try {
        const heal = await this.mutateWithHeal((state) => {
          delete state.dismissedAt;
          return state;
        });
        return { ok: true, error: null, ...(heal.healed ? { healed: true, healedDetail: heal.corruptFile } : {}) };
      } catch (error) {
        return { ok: false, error: onboardingErrorSummary(error) };
      }
    },

    /**
     * 向导应用成功：写 completedAt + proposalHash 并清 dismissedAt（完成态
     * 覆盖搁置态）。幂等：重复应用刷新 completedAt（最后应用时刻为准）。
     * 坏 JSON 自愈同 dismiss（mutateWithHeal）。
     */
    async complete(nowIso, proposalHash) {
      try {
        const heal = await this.mutateWithHeal((state) => {
          state.version = ONBOARDING_FLAG_VERSION;
          state.completedAt = nowIso;
          state.proposalHash = typeof proposalHash === "string" ? proposalHash : null;
          delete state.dismissedAt;
          return state;
        });
        return { ok: true, error: null, ...(heal.healed ? { healed: true, healedDetail: heal.corruptFile } : {}) };
      } catch (error) {
        return { ok: false, error: onboardingErrorSummary(error) };
      }
    },

    /** 诊断视图（原始账本内容；只读）。 */
    async diagnostics() {
      return onboardingLedger.read();
    },
  };

  // ------------------------------------------------------------------
  // 0.5 批次 5 · A 线：auto 冷却/恢复记账（<stateRoot>/auto-organize.json）。
  //
  // 与温度统计账本（topic-activity.jsonl）严格分开：这里只存调度记账与 run
  // 审计（上次成功评估锚 + 每 run 的逐条变更前后值），是「评估/执行/撤销」的
  // 事实来源；损坏时评估降级（锚视为空、run 不可查），绝不牵连温度统计与
  // 正常读写。run 记录滚动保留（上限 forgetting/auto.mjs 的 AUTO_RUN_KEEP）。
  // ------------------------------------------------------------------

  const AUTO_STATE_VERSION = 1;
  // 滚动上限与 forgetting/auto.mjs 的 AUTO_RUN_KEEP 同源常量（复制数值 + 注释
  // 互指，避免 storage 层反向 import plugin 层）。
  const AUTO_RUN_KEEP_LIMIT = 50;

  const autoLedger = createLedger({
    file: path.join(stateRoot, "auto-organize.json"),
    empty: () => ({ version: AUTO_STATE_VERSION, scopes: {}, runs: [] }),
    lockRoot: stateRoot,
  });

  /** 有界错误摘要（只供诊断展示）。 */
  function autoErrorSummary(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 200 ? `${message.slice(0, 199)}…` : message;
  }

  /** 读侧归一：版本不识别 / 形状漂移一律按「无记账」降级（state: null + error 摘要）。 */
  function normalizeAutoState(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { state: null, error: "auto-organize.json 形状不识别，按无记账降级" };
    }
    if (raw.version !== AUTO_STATE_VERSION) {
      return { state: null, error: `auto-organize.json version 不识别（期望 ${AUTO_STATE_VERSION}），按无记账降级` };
    }
    return {
      state: {
        version: AUTO_STATE_VERSION,
        scopes: raw.scopes !== null && typeof raw.scopes === "object" && !Array.isArray(raw.scopes) ? raw.scopes : {},
        runs: Array.isArray(raw.runs) ? raw.runs : [],
      },
      error: null,
    };
  }

  const autoStore = {
    /** 读全量记账状态；损坏/版本不识别 → { state: null, error: 摘要 }（绝不抛）。 */
    async read() {
      try {
        return normalizeAutoState(await autoLedger.read());
      } catch (error) {
        return { state: null, error: autoErrorSummary(error) };
      }
    },

    /** 记账评估锚（该 scope 上次成功评估时间与来源）。锚写入失败如实上抛
     *  （调用方决定是否降级）；无变更（同值重写）由 createLedger 幂等跳过落盘。 */
    async markEvaluated(scopeId, atIso, by) {
      if (typeof scopeId !== "string" || scopeId.length === 0) {
        fail("INVALID_INPUT", "autoStore.markEvaluated requires a non-empty scopeId", {});
      }
      if (typeof atIso !== "string" || atIso.length === 0) {
        fail("INVALID_INPUT", "autoStore.markEvaluated requires an ISO at", {});
      }
      return autoLedger.mutate((state) => {
        state.version = AUTO_STATE_VERSION;
        if (state.scopes === null || typeof state.scopes !== "object" || Array.isArray(state.scopes)) {
          state.scopes = {};
        }
        state.scopes[scopeId] = { lastEvaluatedAt: atIso, lastEvaluatedBy: typeof by === "string" ? by : null };
        return state;
      });
    },

    /** 追加 run 审计记录（滚动保留最近 AUTO_RUN_KEEP_LIMIT 条）。 */
    async recordRun(run) {
      if (run === null || typeof run !== "object" || Array.isArray(run)) {
        fail("INVALID_INPUT", "autoStore.recordRun requires a run object", {});
      }
      if (typeof run.runId !== "string" || run.runId.length === 0) {
        fail("INVALID_INPUT", "autoStore.recordRun requires run.runId", {});
      }
      return autoLedger.mutate((state) => {
        state.version = AUTO_STATE_VERSION;
        if (!Array.isArray(state.runs)) state.runs = [];
        state.runs.push(run);
        if (state.runs.length > AUTO_RUN_KEEP_LIMIT) {
          state.runs = state.runs.slice(state.runs.length - AUTO_RUN_KEEP_LIMIT);
        }
        return state;
      });
    },

    /** 按 runId 查 run；不存在返回 null；账本损坏上抛（撤销路径需要硬失败）。 */
    async getRun(runId) {
      const { state, error } = await this.read();
      if (state === null) fail("INVALID_STATE", `auto-organize.json 不可读，run 查询失败：${error}`, {});
      return state.runs.find((run) => run?.runId === runId) ?? null;
    },

    /** 按 operationId 查 run（apply 幂等重放判据）。 */
    async getRunByOperationId(operationId) {
      const { state, error } = await this.read();
      if (state === null) fail("INVALID_STATE", `auto-organize.json 不可读，run 查询失败：${error}`, {});
      return state.runs.find((run) => run?.operationId === operationId) ?? null;
    },

    /** 置 undoneAt（一键撤销完成标记）。run 不存在 → NOT_FOUND（幂等闸由引擎侧把守）。 */
    async markRunUndone(runId, atIso) {
      if (typeof atIso !== "string" || atIso.length === 0) {
        fail("INVALID_INPUT", "autoStore.markRunUndone requires an ISO at", {});
      }
      return autoLedger.mutate((state) => {
        state.version = AUTO_STATE_VERSION;
        if (!Array.isArray(state.runs)) state.runs = [];
        const run = state.runs.find((entry) => entry?.runId === runId);
        if (run === undefined) {
          fail("NOT_FOUND", `run "${runId}" 不存在，无法标记撤销完成`, {});
        }
        run.undoneAt = atIso;
        return state;
      });
    },
  };

  function diagnostics() {
    return { kind: "state-store", stateRoot };
  }

  return { toolOpStore, l2Store, planStore, queueStore, onboardingStore, projectionStore, analyzeOpStore, waterlineStore, diagnosticsStore, autoStore, readWaterline: readWaterlineFor, diagnostics };
}
