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

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

const HEX64 = /^[0-9a-f]{64}$/;

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
 */
export function createStateStore({ stateRoot } = {}) {
  if (typeof stateRoot !== "string" || !path.isAbsolute(stateRoot)) {
    fail("INVALID_INPUT", "state store requires an absolute stateRoot", {});
  }

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

  /** L1 最近有效投影（超限外改时保留并告警；不截断铁律）。 */
  const projectionStore = {
    async saveL1(scopeId, { text, revision }) {
      await projectionLedger(scopeId).mutate((state) => {
        state.l1 = {
          text: structuredClone(text),
          revision: revision ?? null,
          hash: sha256Buffer(Buffer.from(text, "utf8")),
          savedAt: new Date().toISOString(),
        };
        return state;
      });
    },
    async loadL1(scopeId) {
      const state = await projectionLedger(scopeId).read();
      return state.l1 === null ? null : structuredClone(state.l1);
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
      if (kind !== "organize" && kind !== "forgetting") {
        fail("INVALID_INPUT", `supersedeOpen kind must be organize/forgetting, got ${JSON.stringify(kind)}`, {});
      }
      const superseded = [];
      await plansLedger(scopeId).mutate((state) => {
        for (const [planId, entry] of Object.entries(state.plans)) {
          if (planId === keepPlanId) continue;
          if (entry.kind !== kind) continue;
          if (entry.executed === true) continue;
          if (entry.supersededWith !== undefined) continue;
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

  function diagnostics() {
    return { kind: "state-store", stateRoot };
  }

  return { toolOpStore, l2Store, planStore, queueStore, projectionStore, analyzeOpStore, diagnostics };
}
