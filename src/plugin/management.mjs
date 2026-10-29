// Shiori P5-PLUGIN · 管理 API 生产实现（slot P；CONTRACTS §6）。
//
// createManagement(deps) → {management}：每次调用第一参 trustedContext（服务端
// 绑定；不可模型传），第二参 payload（业务字段）；只返回 plain DTO，Error.code
// 可序列化。wire 字段与 validateManagementPayload 以 protocol.mjs 为唯一权威。
//
// 门面边界：
// - shadow（含 inert）：仅 getStatus 纯内存可用（不触盘、不建锁、不开任何
//   scope 资源——shadow 实例抢独占锁会把真的 active 实例挤成 LOCK_BUSY）；
//   其余方法一律 UNSUPPORTED；inert（无 root）→ getStatus 之外 NOT_CONFIGURED；
// - organize.enabled 控制 organize 候选/计划/执行；forgetting.enabled 控制
//   遗忘分析/计划/执行；显式 includeArchived 冷搜不受开关影响（在工具层）；
// - executePlan 授权：仅认证 owner 面板 RPC（trustedContext 已由 Q resolver
//   校验 principal）；P 从 trustedContext 授予仅本次调用的授权
//   {scopeId, sessionId, generation, planDigest, operationId}，不从 payload.actor
//   /authorize 取值；每次底层 authorize 回调核验存 plan、调用未撤销、session
//   映射/generation 仍相同；stop/断连撤销，重试与 merge 退休前重验；
// - 候选队列持久快照跨重启恢复（queueStore）；plan 账不可变（planStore）。

import { analyzeCandidates } from "../organize/analyze.mjs";
import { createCandidateQueue, buildDraft as buildOrganizeDraft, buildForgetArchiveDiff } from "../organize/queue.mjs";
import { digestPlan as organizeDigestPlan, createOrganizerExecutor } from "../organize/executor.mjs";
import { analyzeForgetting } from "../forgetting/decay.mjs";
import { createForgetExecutor } from "../forgetting/executor.mjs";
import { validateManagementPayload } from "./protocol.mjs";
import { pinScope, sessionEvidenceFromRpc, rejectIdentityFields } from "./scope.mjs";

const MAIN_SESSION_ACTOR = "main-session";
// analyzeCandidates 的候选上限（analyze.mjs 校验 1..1000）：organize 分析内部
// 以此派生收敛集；命中上限视为"可能截断"，启用 keepAbsentIds 保护。
const ANALYZE_CANDIDATE_LIMIT = 1000;

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

/**
 * @param {object} deps
 * @param {object} deps.settings 已校验 settings（validateControllerSettings）
 * @param {string} deps.dataRoot 业务数据根（organize executor 与 sparks/topic 共用）
 * @param {object} deps.state   createStateStore 实例
 * @param {(scopeId: string, agent?: object|null) => Promise<object>} deps.resourcesFor  返回 {service, sparkStore, personaAdapter}
 * @param {() => boolean} deps.isStarted
 * @param {() => number} deps.generation
 * @param {(grant: object) => object} deps.registerGrant   注册仅本次调用授权；返回带 revoke() 的句柄
 * @param {(scope: object) => Promise<object>} deps.executeToolForScope  工具执行（与真实工具路径同校验/CAS）
 * @param {(agent: object|null) => string|null} [deps.workspaceForAgent] 从宿主 agent 解析可信 workspace（只读）
 * @param {() => string} [deps.nowIso]
 */
export function createManagement(deps) {
  const {
    settings,
    dataRoot,
    state,
    resourcesFor,
    isStarted,
    generation,
    registerGrant,
    executeToolForScope,
    nowIso = () => new Date().toISOString(),
  } = deps;

  for (const [name, value] of Object.entries({ settings, state, resourcesFor, isStarted, generation, registerGrant, executeToolForScope })) {
    if (value === undefined) fail("INVALID_INPUT", `createManagement requires deps.${name}`, {});
  }

  const isInert = settings.mode === "shadow" && settings.dataRoot === null && settings.stateRoot === null;
  const configured = !isInert;

  function requireConfigured() {
    if (isInert) {
      fail("NOT_CONFIGURED", "controller is mounted inert (shadow without dataRoot/stateRoot); only getStatus is available", {});
    }
  }

  function requireActive(where) {
    if (settings.mode !== "active") {
      fail("UNSUPPORTED", `${where} is a mutation and unsupported in shadow mode`, { mode: settings.mode });
    }
  }

  function requireStarted() {
    if (!isStarted()) {
      fail("INVALID_STATE", "controller is not started", {});
    }
  }

  /**
   * B3：触数据根的门面仅 active 可用。shadow（含 inert）永不打开 scope 资源
   * / completion 锁 / receipt —— 只读预览若开独占锁，会把真的 active 实例
   * 挤成 LOCK_BUSY。shadow 只保留纯内存 getStatus。
   */
  function requireActiveDataAccess(where) {
    requireConfigured(); // inert → NOT_CONFIGURED
    if (settings.mode !== "active") {
      fail("UNSUPPORTED", `${where} requires active mode; shadow mounts expose in-memory getStatus only`, {
        mode: settings.mode,
      });
    }
    requireStarted();
  }

  /** 可信 scope 解析（P 自己重新固定；不信任何预计算 scopeId）。
   *  workspace 来自宿主 workingDirectory 服务（只读 get），供 workspacePersonas 选卡。 */
  async function scopeFromTrustedContext(trustedContext) {
    requireStarted();
    const evidence = sessionEvidenceFromRpc(trustedContext);
    return pinScope({
      settings,
      sessionId: evidence.sessionId,
      workspace: deps.workspaceForAgent?.(evidence.agent) ?? null,
      generation: generation(),
      source: "panel-rpc",
    });
  }

  function requireModule(kind) {
    if (kind === "organize" && settings.organize.enabled !== true) {
      fail("UNSUPPORTED", "organize module is disabled by settings.organize.enabled=false", {});
    }
    if (kind === "forgetting" && settings.forgetting.enabled !== true) {
      fail("UNSUPPORTED", "forgetting module is disabled by settings.forgetting.enabled=false", {});
    }
  }

  // ── 队列 ─────────────────────────────────────────────────────

  async function loadQueue(scopeId) {
    const snapshot = await state.queueStore.load(scopeId);
    if (snapshot === null) {
      return createCandidateQueue({ scopeId });
    }
    return createCandidateQueue({ scopeId, snapshot });
  }

  async function queueDto(scopeId, queue) {
    const snapshot = queue.snapshot();
    const plans = await state.planStore.list(scopeId);
    return {
      queueRevision: snapshot.revision,
      items: snapshot.items,
      plans,
    };
  }

  // ── 管理 API ─────────────────────────────────────────────────

  const management = {
    /**
     * 状态：mode、当前可信 scope、占用 / 能力 / 诊断。
     * 不返回完整数据根或其他卡正文。
     */
    async getStatus(trustedContext, payload) {
      validateManagementPayload("getStatus", payload ?? {});
      const status = {
        mode: isInert ? "inert" : settings.mode,
        configured,
        scope: null,
        occupancy: null,
        capabilities: {
          l2: settings.l2.enabled,
          organize: settings.organize.enabled,
          forgetting: settings.forgetting.enabled,
          tools: !isInert && settings.mode === "active",
          sections: !isInert && settings.mode === "active",
        },
        diagnostics: {
          ownerId: settings.ownerId,
          generation: generation(),
          started: isStarted(),
          // P-C 诚实度（wire 的 diagnostics 块 additionalProperties:true，纯增量）：
          // 严格 codec 的实际状态——"strict" = 描述符已注册进宿主 typert registry；
          // "src" = 回退（reason 给出缺席/失败原因）。
          typertRpc: deps.typertRpcInfo?.() ?? { codec: "src", reason: "unknown" },
        },
      };
      if (isInert || !isStarted()) return status;
      const evidence = sessionEvidenceFromRpc(trustedContext);
      // shadow 下仅纯内存解析（pinScope 不触盘）；occupancy 只在 active 读数据。
      const scope = pinScope({
        settings,
        sessionId: evidence.sessionId,
        workspace: deps.workspaceForAgent?.(evidence.agent) ?? null,
        generation: generation(),
        source: "panel-rpc",
      });
      status.scope = scope.scopeId;
      if (settings.mode !== "active") return status;
      const resources = await resourcesFor(scope.scopeId, evidence.agent);
      const [persona, view] = await Promise.all([
        resources.service.readPersona(),
        resources.service.readCoreView(),
      ]);
      status.occupancy = {
        l0Chars: persona?.text?.length ?? 0,
        l1Chars: (view?.text ?? "").length,
        l0Budget: settings.budgets.persona.maxChars,
        l1HardCap: settings.budgets.core.hardCapChars,
      };
      return status;
    },

    /** 当前 scope L0/L1 预览与预算、revision（面板用）。 */
    async getMemoryView(trustedContext, payload) {
      validateManagementPayload("getMemoryView", payload ?? {});
      requireActiveDataAccess("getMemoryView");
      const scope = await scopeFromTrustedContext(trustedContext);
      const resources = await resourcesFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
      const persona = await resources.service.readPersona();
      const view = await resources.service.readCoreView();
      return {
        scope: scope.scopeId,
        l0: {
          text: persona?.text ?? null,
          revision: persona?.revision ?? null,
          chars: persona?.text?.length ?? 0,
          budget: settings.budgets.persona.maxChars,
          stale: persona?.stale === true,
        },
        l1: {
          text: view?.text ?? "",
          // 磁盘正文（不含派生索引）；面板编辑用这一份，回退到 text 会污染 core。
          // 若宿主注入的 service 没实现 body（旧契约），退回 text 而不是空串——
          // 空串会让面板的编辑框一片空白、保存即清空 core，比带上索引危险得多。
          body: typeof view?.body === "string" ? view.body : (view?.text ?? ""),
          revision: view?.revision ?? null,
          chars: (view?.text ?? "").length,
          budget: settings.budgets.core.targetChars,
          hardCap: settings.budgets.core.hardCapChars,
        },
      };
    },

    /** 当前授权 scope 的 active 全图（真实 client 取数；不经模型工具返回整图）。 */
    async getGraph(trustedContext, payload) {
      validateManagementPayload("getGraph", payload ?? {});
      requireActiveDataAccess("getGraph");
      const scope = await scopeFromTrustedContext(trustedContext);
      const resources = await resourcesFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
      const records = await resources.sparkStore.listActive();
      const { projectGraph, normalizeGraphRecords } = await import("../sparks/graph.mjs");
      const projection = projectGraph({ scopeId: scope.scopeId, records: normalizeGraphRecords(records) });
      return {
        scope: scope.scopeId,
        nodes: projection.nodes.map((n) => ({
          id: n.id,
          title: n.title ?? null,
          summary: n.summary ?? null,
          vitality: n.vitality ?? null,
          revision: n.revision ?? null,
        })),
        edges: projection.edges.map((e) => ({
          source: e.source,
          target: e.target,
          rel: e.rel ?? null,
        })),
      };
    },

    /**
     * 走同工具校验 / coordinator / CAS 的工具执行（节点详情 / 编辑）。
     * 仅 active（shadow 不开任何 scope 资源，见 requireActiveDataAccess）。
     */
    async executeTool(trustedContext, payload) {
      validateManagementPayload("executeTool", payload);
      rejectIdentityFields(payload.args ?? {}, "management.executeTool.args");
      requireActiveDataAccess("executeTool");
      const scope = await scopeFromTrustedContext(trustedContext);
      return executeToolForScope(scope, payload.name, payload.args ?? {});
    },

    /** 候选队列与计划摘要（同 scope；不泄露别卡）。 */
    async listCandidates(trustedContext, payload) {
      validateManagementPayload("listCandidates", payload ?? {});
      requireActiveDataAccess("listCandidates");
      const scope = await scopeFromTrustedContext(trustedContext);
      const queue = await loadQueue(scope.scopeId);
      return queueDto(scope.scopeId, queue);
    },

    /**
     * 派生候选 / 遗忘分析。纯业务数据只读；此门面显式持久写派生候选/plan 账。
     * P-A：operationId 幂等——同 operationId 重放返回首次派生结果（analyzeOps
     * 账），不二次收敛队列、不因 now 漂移二次落 plan；organize 分析以本次
     * 结果收敛队列（保留在场候选 status、移除失效候选）。
     */
    async analyze(trustedContext, payload) {
      validateManagementPayload("analyze", payload);
      requireActiveDataAccess("analyze");
      requireActive("analyze");
      requireModule(payload.kind);
      const evidence = sessionEvidenceFromRpc(trustedContext);
      const scope = await scopeFromTrustedContext(trustedContext);
      const resources = await resourcesFor(scope.scopeId, evidence.agent);

      // P-A：重放短路（先于任何派生/收敛；与 enqueue 的「幂等先于 CAS」同序）。
      const prior = await state.analyzeOpStore.get(scope.scopeId, payload.kind, payload.operationId);
      if (prior !== null) {
        // 崩溃窗口补齐：journal 已记、plan 尚未落盘 → 幂等补保存（同内容 save 为 no-op）。
        if (prior.kind === "forgetting" && prior.planId !== null && prior.plan !== null) {
          await state.planStore.save(scope.scopeId, prior.planId, {
            kind: "forgetting",
            planDigest: organizeDigestPlan(prior.plan),
            queueRevision: null,
            plan: prior.plan,
            diff: prior.diff ?? [],
            changedItems: prior.plan.sources.length,
            summary: `archive ${prior.plan.sources.length} ephemeral card(s) (elapsed>=60d, score<${prior.plan.policy.archiveScore})`,
          });
        }
        // P-A 收紧：journal 已记但队列保存未完成（journal 落盘与 queueStore.save
        // 之间崩溃）→ 磁盘 revision 落后于收敛后快照时幂等补写；磁盘已前进
        // （后续操作）则不动。
        if (prior.kind === "organize" && prior.queueSnapshot !== null && prior.queueSnapshot !== undefined) {
          const diskQueue = await loadQueue(scope.scopeId);
          if (diskQueue.snapshot().revision < prior.queueSnapshot.revision) {
            await state.queueStore.save(scope.scopeId, prior.queueSnapshot);
          }
        }
        const queue = await loadQueue(scope.scopeId);
        const dto = await queueDto(scope.scopeId, queue);
        return { ...dto, analysis: prior.analysis };
      }

      if (payload.kind === "organize") {
        const records = await resources.sparkStore.listActive();
        // P-A 残留：取 analyzeCandidates 的上限（1000）做内部收敛派生——wire
        // 只报候选计数，不因此扩面；仅当派生命中上限（可能截断）时启用
        // keepAbsentIds 保护。
        const candidates = analyzeCandidates({ scopeId: scope.scopeId, records, limit: ANALYZE_CANDIDATE_LIMIT });
        const analysis = { kind: "organize", candidates: candidates.length, now: nowIso() };
        const queue = await loadQueue(scope.scopeId);
        const expectedRevision = payload.expectedQueueRevision ?? queue.snapshot().revision;
        // P-A 残留（截断保护）：候选 ≥ 上限时"不在本次候选集"不再等价于"失效"
        // ——超出 limit 的既有队列项若源卡仍全部 active 则保留原 status
        // （reviewed 不丢），源卡已 retired 的照常移除；未截断时 null，
        // "不在场 = 移除"语义不变。
        let keepAbsentIds = null;
        if (candidates.length >= ANALYZE_CANDIDATE_LIMIT) {
          const activeIds = new Set(records.map((r) => r.id));
          const candidateIds = new Set(candidates.map((c) => c.id));
          const keep = queue.snapshot().items
            .filter((it) => !candidateIds.has(it.candidate.id))
            .filter((it) => it.candidate.sources.every((s) => activeIds.has(s.id)))
            .map((it) => it.candidate.id);
          if (keep.length > 0) keepAbsentIds = keep;
        }
        // P-A 收紧：CAS 先于 journal——陈旧 expectedQueueRevision 的
        // REVISION_CONFLICT 发生在 journal 之前，operationId 不被毒化
        // （重放可用修正后的 revision 重试，收敛语义以本次分析为准）。
        // 以本次分析为准收敛队列：保留在场候选的 status（reviewed 不退回）、
        // 新候选 pending 追加、失效候选（源卡已 merged/archived 等）移除；
        // 空集合允许（清空队列）。
        queue.converge(candidates, { operationId: payload.operationId, expectedRevision, keepAbsentIds });
        const convergedSnapshot = queue.snapshot();
        // journal 落收敛后快照：journal 与队列保存之间崩溃 → 重放短路时按
        // 快照幂等修复（见 prior 分支）。
        await state.analyzeOpStore.put(scope.scopeId, "organize", payload.operationId, {
          planId: null,
          analysis,
          queueSnapshot: convergedSnapshot,
        });
        await state.queueStore.save(scope.scopeId, convergedSnapshot);
        // P-A 残留：organize 分析也收敛计划账——队列已按本次分析重建，此前
        // open 的 organize 计划引用旧候选集（不执行就滞留面板），一律作废
        // （本次分析不生成新 plan，keepPlanId=null）；executed 计划保留审计。
        // 幂等：已被作废的不改写。重放短路分支不补跑（避免用旧 operationId
        // 误杀此后 previewPlan 生成的新计划）。
        await state.planStore.supersedeOpen(scope.scopeId, {
          kind: "organize",
          keepPlanId: null,
          operationId: payload.operationId,
        });
        const dto = await queueDto(scope.scopeId, queue);
        return { ...dto, analysis };
      }

      // forgetting：analyzeForgetting 纯只读；plan 非空才存 plan 账（操作幂等按 operationId）。
      const records = await resources.sparkStore.listActive();
      const analysis = analyzeForgetting({
        scopeId: scope.scopeId,
        sparks: records,
        now: nowIso(),
        policy: settings.forgetting.policy,
      });
      let planId = null;
      let planDiff = [];
      if (analysis.plan !== null) {
        const plan = structuredClone(analysis.plan);
        const planDigest = organizeDigestPlan(plan);
        planId = `fp-${planDigest}`;
        // P-B：展示 diff——与 organize 同形状（spark:<id>，before/after 投影 +
        // state/revision），确认前即可见「将要归档哪些卡」。
        const recordsById = new Map(records.map((r) => [r.id, r]));
        planDiff = buildForgetArchiveDiff(plan, recordsById);
        await state.planStore.save(scope.scopeId, planId, {
          kind: "forgetting",
          planDigest,
          queueRevision: null,
          plan,
          diff: planDiff,
          changedItems: plan.sources.length,
          summary: `archive ${plan.sources.length} ephemeral card(s) (elapsed>=60d, score<${plan.policy.archiveScore})`,
        });
      }
      const analysisView = {
        kind: "forgetting",
        assessments: analysis.assessments.length,
        candidates: analysis.candidates.length,
        alarms: analysis.alarms,
        now: analysis.now,
        policy: analysis.policy,
      };
      // P-A：journal 先写（含 plan 原文与 diff，重放可幂等补保存）。
      await state.analyzeOpStore.put(scope.scopeId, "forgetting", payload.operationId, {
        planId,
        plan: analysis.plan,
        diff: planDiff,
        analysis: analysisView,
      });
      // P-A：计划收敛——以本次分析的 plan（或空）为准，作废同 kind 其他仍
      // open 的计划（幂等：已 executed 保留审计、已被作废的不改写）。
      await state.planStore.supersedeOpen(scope.scopeId, {
        kind: "forgetting",
        keepPlanId: planId,
        operationId: payload.operationId,
      });
      const plans = await state.planStore.list(scope.scopeId);
      const queue = await loadQueue(scope.scopeId);
      const dto = await queueDto(scope.scopeId, queue);
      return {
        queueRevision: dto.queueRevision,
        items: dto.items,
        plans,
        analysis: analysisView,
      };
    },

    /** 候选审阅（与现 queue.review 完全映射；reviewed 不是执行授权）。 */
    async reviewCandidate(trustedContext, payload) {
      validateManagementPayload("reviewCandidate", payload);
      requireActiveDataAccess("reviewCandidate");
      requireActive("reviewCandidate");
      requireModule("organize");
      const scope = await scopeFromTrustedContext(trustedContext);
      const queue = await loadQueue(scope.scopeId);
      queue.review(payload.candidateId, {
        decision: payload.decision,
        expectedRevision: payload.expectedQueueRevision,
        operationId: payload.operationId,
      });
      await state.queueStore.save(scope.scopeId, queue.snapshot());
      return queueDto(scope.scopeId, queue);
    },

    /** 计划预览：organize proposal 走 buildDraft；forgetting 用 planId 取回 analyze 保存的计划。 */
    async previewPlan(trustedContext, payload) {
      validateManagementPayload("previewPlan", payload);
      requireActiveDataAccess("previewPlan");
      requireActive("previewPlan");
      const scope = await scopeFromTrustedContext(trustedContext);

      if (payload.kind === "forgetting") {
        requireModule("forgetting");
        const entry = await state.planStore.get(scope.scopeId, payload.planId);
        if (entry === null || entry.kind !== "forgetting") {
          fail("NOT_FOUND", `forgetting plan "${payload.planId}" not found in scope "${scope.scopeId}"`, {
            planId: payload.planId,
          });
        }
        if (entry.executed === true) {
          fail("REVISION_CONFLICT", `plan "${payload.planId}" was already executed (operationId ${entry.executedWith ?? "unknown"})`, {
            planId: payload.planId,
          });
        }
        return {
          planId: entry.planId,
          kind: entry.kind,
          planDigest: entry.planDigest,
          queueRevision: null,
          diff: entry.diff,
          changedItems: entry.changedItems,
          summary: entry.summary,
        };
      }

      requireModule("organize");
      const resources = await resourcesFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
      const queue = await loadQueue(scope.scopeId);
      const snapshot = queue.snapshot();
      const item = snapshot.items.find((it) => it?.candidate?.id === payload.candidateId);
      if (item === undefined) {
        fail("NOT_FOUND", `candidate "${payload.candidateId}" not found in scope "${scope.scopeId}"`, {
          candidateId: payload.candidateId,
        });
      }
      const records = await resources.sparkStore.listActive();
      const built = buildOrganizeDraft({
        candidate: item.candidate,
        records,
        proposal: payload.proposal,
      });
      const planId = `op-${built.digest}`;
      await state.planStore.save(scope.scopeId, planId, {
        kind: "organize",
        planDigest: built.digest,
        queueRevision: snapshot.revision,
        plan: built.plan,
        diff: built.diff,
        changedItems: built.changedItems,
        summary: `${built.plan.kind} plan over ${built.plan.sources.length} source(s)`,
      });
      // P-A：计划收敛——新预览表达当前意图，作废同 scope 其他仍 open 的
      // organize 计划（幂等：已 executed 保留审计、已被作废的不改写；被作废
      // 计划不可再执行）。 abandoned preview 不再无限累积。
      await state.planStore.supersedeOpen(scope.scopeId, {
        kind: "organize",
        keepPlanId: planId,
        operationId: payload.operationId,
      });
      return {
        planId,
        kind: "organize",
        planDigest: built.digest,
        queueRevision: snapshot.revision,
        diff: built.diff,
        changedItems: built.changedItems,
        summary: `${built.plan.kind} plan over ${built.plan.sources.length} source(s)`,
      };
    },

    /**
     * 执行已预览且明确确认的计划。仅认证 owner 面板 RPC；授权仅本次调用，
     * 每次底层 authorize（含重试、merge 退休前）核验；stop/断连撤销。
     */
    async executePlan(trustedContext, payload) {
      validateManagementPayload("executePlan", payload);
      requireConfigured();
      requireStarted();
      requireActive("executePlan");
      const scope = await scopeFromTrustedContext(trustedContext);
      const entry = await state.planStore.get(scope.scopeId, payload.planId);
      if (entry === null) {
        fail("NOT_FOUND", `plan "${payload.planId}" not found in scope "${scope.scopeId}"`, {
          planId: payload.planId,
        });
      }
      if (entry.planDigest !== payload.planDigest) {
        fail("REVISION_CONFLICT", "planDigest does not match the stored plan (approval must bind content)", {
          planId: payload.planId,
        });
      }
      // M1：plan 一次性。已执行的 plan 拒绝重跑（同 plan 重跑会二次 merge/
      // archive）；执行器层的 operationId 幂等仅覆盖同一 operationId 的底层重放，
      // 不能替代管理层的「已执行」状态检查。
      if (entry.executed === true) {
        fail("REVISION_CONFLICT", `plan "${payload.planId}" was already executed (operationId ${entry.executedWith ?? "unknown"}); approve and preview a new plan instead`, {
          planId: payload.planId,
          executedWith: entry.executedWith ?? null,
        });
      }
      // P-A：已被更新计划作废的 open 计划不可执行（面板据 superseded 禁用执行；
      // 此处为服务端硬闸，不依赖客户端行为）。
      if (entry.supersededWith !== undefined) {
        fail("REVISION_CONFLICT", `plan "${payload.planId}" was superseded (operationId ${entry.supersededWith}); approve and preview a new plan instead`, {
          planId: payload.planId,
          supersededWith: entry.supersededWith,
        });
      }

      // 仅本次调用的授权（scope/session/generation/digest/opId）；signal 断开即撤销。
      const grant = registerGrant({
        scopeId: scope.scopeId,
        sessionId: scope.sessionId,
        generation: scope.generation,
        planDigest: payload.planDigest,
        operationId: payload.operationId,
        signal: trustedContext.signal ?? null,
      });
      const authorize = async (authParams) => {
        // B-abort：撤销与「已 abort 的 signal」都判失败——取消在任何 await
        // 窗口到达都不能再通过授权。
        if (grant.revoked || grant.signal?.aborted === true) return false;
        if (grant.generation !== generation() || !isStarted()) return false;
        if (authParams?.planDigest !== undefined && authParams.planDigest !== grant.planDigest) return false;
        if (authParams?.operationId !== undefined && authParams.operationId !== grant.operationId) return false;
        return true;
      };

      // B-abort：注册后立即核验——signal 在 scope/plan 查询的两次 await 期间
      // （或注册前）已取消时，不进入 resourcesFor / executor，不 merge/归档。
      if (grant.revoked || trustedContext.signal?.aborted === true) {
        fail("AUTHORIZATION_REQUIRED", "executePlan cancelled before execution", { planId: payload.planId });
      }

      const resources = await resourcesFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
      let result;
      try {
        if (entry.kind === "organize") {
          requireModule("organize");
          const executor = await createOrganizerExecutor({
            root: dataRoot,
            scopeId: scope.scopeId,
            authorize,
            budgets: settings.budgets,
          });
          try {
            result = await executor.executeRound({
              plan: entry.plan,
              approval: { actor: MAIN_SESSION_ACTOR, planDigest: payload.planDigest },
              operationId: payload.operationId,
            });
          } finally {
            executor.close();
          }
        } else {
          requireModule("forgetting");
          const executor = createForgetExecutor({
            store: resources.sparkStore,
            scopeId: scope.scopeId,
            authorize,
            now: nowIso,
            policy: settings.forgetting.policy,
          });
          result = await executor.execute(entry.plan, { operationId: payload.operationId });
        }
      } catch (error) {
        // B-abort：执行器抛错（含 mid-executor abort 的 APPROVAL_REQUIRED）时
        // 授权随调用收场撤销，不等 cleanup/stop。
        grant.revoke();
        throw error;
      }

      // B-abort：markExecuted 前二次核验——取消落在「执行完成、落账之前」的
      // 窗口也不落账（plan 保持未执行，可重新批准执行）。
      if (grant.revoked || trustedContext.signal?.aborted === true) {
        fail("AUTHORIZATION_REQUIRED", "executePlan cancelled before execution was recorded", { planId: payload.planId });
      }
      await state.planStore.markExecuted(scope.scopeId, payload.planId, payload.operationId);
      // P-A：执行后立即收敛队列——移除引用「已不再是 active」源卡的候选
      // （merge 退休 / forgetting 归档后，面板不再把失效条目画成可审阅；
      // link 计划源卡仍 active，不动队列）。确定性/重放安全：移除集合由
      // 「队列项 ∩ 非 active 源卡」决定；重放同 operationId 时首轮已移除、
      // 幸存集合不变 → 不动队列、不记队列事务。队列 operationId 复用本次
      // 执行 operationId（面板各操作生成唯一 operationId）。
      // P-A 残留收紧：收敛/保存抛错时 grant 也必须撤销（merge 已落盘但
      // 调用报错——grant 泄漏会放大授权窗口），finally 保证两条路径都撤销。
      try {
        const queue = await loadQueue(scope.scopeId);
        const snapshot = queue.snapshot();
        const activeIds = new Set((await resources.sparkStore.listActive()).map((r) => r.id));
        const survivors = snapshot.items
          .filter((it) => it.candidate.sources.every((s) => activeIds.has(s.id)))
          .map((it) => it.candidate);
        if (survivors.length !== snapshot.items.length) {
          queue.converge(survivors, { operationId: payload.operationId, expectedRevision: snapshot.revision });
          await state.queueStore.save(scope.scopeId, queue.snapshot());
        }
      } finally {
        grant.revoke();
      }
      return {
        planId: payload.planId,
        planDigest: payload.planDigest,
        operationId: payload.operationId,
        result,
      };
    },
  };

  return { management, isInert };
}
