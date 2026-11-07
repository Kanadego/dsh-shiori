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
import {
  createCandidateQueue, buildDraft as buildOrganizeDraft, buildArchiveTopicPlan,
  buildForgetArchiveDiff, listQueue,
} from "../organize/queue.mjs";
import { digestPlan as organizeDigestPlan, createOrganizerExecutor } from "../organize/executor.mjs";
import { analyzeForgetting } from "../forgetting/decay.mjs";
import { createForgetExecutor } from "../forgetting/executor.mjs";
import { validateManagementPayload } from "./protocol.mjs";
import { coreBudgetsOf } from "./config.mjs";
import { createTimelineReader } from "../timeline/index.mjs";
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
 * @param {object} [deps.timelineReader] 已构造的时间线读取器（测试注入；省略则按 dataRoot 惰性创建）
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

  /**
   * F7 只读宿主守门：后启动的宿主只有读权，面板的写方法（analyze /
   * reviewCandidate / previewPlan / executePlan）必须与工具层同口径抛
   * HOST_LOCKED——面板置灰挡不住直连 RPC，剧情外最强的写路径（执行计划）
   * 全在这里，漏一处「只读」就是空话。
   *
   * deps.readonlyGuard 允许传取值函数：门面在 controller 构造期创建，而座位
   * 守卫要等 start() 里才建（先占座、后建工具），构造期读不到实例。
   * 缺省（未提供 / 尚为 null）放行——与工具层「无 guard → 行为不变」一致，
   * 让注入式装配（测试、桌面宿主内嵌 service）不受影响。
   */
  function assertHostWritable(where) {
    const guard = typeof deps.readonlyGuard === "function" ? deps.readonlyGuard() : deps.readonlyGuard;
    if (guard === undefined || guard === null) return;
    if (typeof guard.assertWritable !== "function") {
      fail("INVALID_INPUT", `readonlyGuard dependency must expose assertWritable() (hooked from ${where})`, {});
    }
    guard.assertWritable();
  }

  /**
   * F7 面板黄条数据源：getStatus.diagnostics.readonly 透出只读状态
   * （writable/readonly/holder/座位心跳细节）。与 assertHostWritable 同一取值
   * 函数口径；guard 未挂（inert/shadow/未 start）时为 null，面板无黄条。
   * diagnostics 块在 wire 上是 additionalProperties:true，纯增量（typertRpc 同例），
   * 不改描述符。
   */
  function readonlyGuardStatus() {
    const guard = typeof deps.readonlyGuard === "function" ? deps.readonlyGuard() : deps.readonlyGuard;
    return guard !== undefined && guard !== null && typeof guard.status === "function" ? guard.status() : null;
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

  // ── F4 时间线（数据层在 src/timeline；本门面只固定可信 root 与 scope）──────
  // 惰性创建：inert 挂载 dataRoot 为 null，工厂期创建会炸；getTimeline 走
  // requireActiveDataAccess，到达时 dataRoot 必为绝对路径。

  let timelineReader = deps.timelineReader ?? null;
  function timelineReaderFor() {
    if (timelineReader === null) {
      timelineReader = createTimelineReader({ dataRoot });
    }
    return timelineReader;
  }

  /**
   * planStore.list 投影 → wire 形状（P2-B3）：store kind "archive-topic" 是
   * 归档计划的独立落库 kind，wire（protocol.mjs planSummary，additionalProperties
   * :false 的闭形状，kind enum 只有 organize/forgetting）不认识新 store kind——
   * 仅映射家族名 kind:"organize"，不补任何 schema 外字段（proposalKind 只存在于
   * previewPlan 的 planView 形状，plans 列表客户端只读 planId/executed/superseded
   * /summary，加了也不读，反而造成协议面与实现不一致）。
   *
   * 旧条目识别：升级前归档计划以 kind:"organize" + plan.kind:"archive-topic"
   * 落库，但 planStore.list 投影不含 plan.kind（且 list 有 listCandidates /
   * forgetting analyze / queueDto 三条 wire 路径，不宜为它扩投影）——按 store
   * kind 判定：旧条目 store kind 本就是 "organize"，映射后形状不变，与本次
   * 新落库计划在 wire 上同为 organize 家族行。
   */
  function plansToWire(plans) {
    return plans.map((p) => p.kind === "archive-topic"
      ? { ...p, kind: "organize" }
      : p);
  }

  /**
   * 队列 DTO：items 经 organize/queue.mjs 的 listQueue 投影——候选 sources 补
   * 卡片 title（取不到给 null），其余字段原样（只增不改）。records 缺省时
   * 不投影（保持旧形状，供无需标题的内部路径复用）。
   */
  async function queueDto(scopeId, queue, records) {
    const snapshot = queue.snapshot();
    const plans = await state.planStore.list(scopeId);
    const items = records === undefined
      ? snapshot.items
      : listQueue({ items: snapshot.items, records }).items;
    return {
      queueRevision: snapshot.revision,
      items,
      plans: plansToWire(plans),
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
          // F7：只读状态（writable=false 时面板显示黄条并置灰写按钮）。
          // holder 为外部持有者（座位心跳的 pid/startedAt 等）；缺字段时面板回退 PID。
          readonly: readonlyGuardStatus(),
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
      // F2 闪回命中可见性：投影节点只带 id/title/summary/vitality/revision，
      // 投递统计（hitCount/lastHitAt）与存续起点（createdAt）按 id 从卡片记录补回。
      const hitMeta = new Map();
      for (const record of records) {
        if (record === null || typeof record !== "object" || typeof record.id !== "string") continue;
        hitMeta.set(record.id, {
          hitCount: Number.isInteger(record.hitCount) && record.hitCount >= 0 ? record.hitCount : 0,
          lastHitAt: typeof record.lastHitAt === "string" ? record.lastHitAt : null,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
        });
      }
      // F2：L2 投递账 → 最近投递明细（上限 20 条，只含元数据）+ 全量吞吐统计。
      // 账本只覆盖 L2 开启期间的记录（L2 关闭期无账可查），该口径由面板如实标注。
      const deliveries = [];
      const deliveryStats = { rounds: 0, totalDelivered: 0, uniqueCards: 0 };
      if (settings.l2.enabled) {
        const ledger = await state.l2Store.diagnostics(scope.scopeId);
        const pendings = ledger?.pending ?? {};
        const acceptedMap = ledger?.accepted ?? {};
        const committedMap = ledger?.committed ?? {};
        for (const entry of Object.values(pendings)) {
          if (entry === null || typeof entry !== "object") continue;
          // 只列已进入会话的投递（有 accepted receipt 或 committed 终态）；
          // 崩溃悬挂的 pending 不算投递。
          const accepted = acceptedMap[entry.deliveryId];
          if (accepted === undefined && committedMap[entry.deliveryId] === undefined) continue;
          const snapshot = entry.delivery ?? {};
          const meta = typeof snapshot.hitMeta === "object" && snapshot.hitMeta !== null ? snapshot.hitMeta : {};
          const delivered = Array.isArray(snapshot.delivered) ? snapshot.delivered : [];
          deliveries.push({
            deliveryId: entry.deliveryId,
            at: typeof accepted?.acceptedAt === "string"
              ? accepted.acceptedAt
              : (typeof committedMap[entry.deliveryId]?.committedAt === "string"
                ? committedMap[entry.deliveryId].committedAt
                : (typeof entry.createdAt === "string" ? entry.createdAt : "")),
            sessionId: typeof entry.session === "string" ? entry.session : "",
            cards: delivered.map((d) => {
              const m = typeof d?.id === "string" && meta[d.id] !== null && typeof meta[d.id] === "object" ? meta[d.id] : {};
              return {
                sparkId: typeof d?.id === "string" ? d.id : "",
                trigger: typeof m.trigger === "string" ? m.trigger : null,
                source: m.source === "seed" || m.source === "related" ? m.source : null,
              };
            }).filter((c) => c.sparkId !== ""),
          });
        }
        deliveries.sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : (a.deliveryId < b.deliveryId ? -1 : 1)));
        deliveries.splice(20);
        // 吞吐统计（全账本口径，不受上面 20 条截断影响）：轮次 = committed 包数；
        // 总投递张数 = 各包 hitUpdates 长度之和（同卡重复进包重复计）；
        // 去重后卡片数 = 出现过的不同 sparkId 数。重复投递率由客户端按
        // 1 - uniqueCards/totalDelivered 计算。
        const hitsMap = ledger?.hits ?? {};
        const unique = new Set();
        for (const updates of Object.values(hitsMap)) {
          if (!Array.isArray(updates)) continue;
          deliveryStats.totalDelivered += updates.length;
          for (const u of updates) {
            if (u !== null && typeof u === "object" && typeof u.sparkId === "string") unique.add(u.sparkId);
          }
        }
        deliveryStats.uniqueCards = unique.size;
        deliveryStats.rounds = Object.keys(committedMap).length;
      }
      return {
        scope: scope.scopeId,
        nodes: projection.nodes.map((n) => {
          const meta = hitMeta.get(n.id) ?? { hitCount: 0, lastHitAt: null, createdAt: null };
          return {
            id: n.id,
            title: n.title ?? null,
            summary: n.summary ?? null,
            vitality: n.vitality ?? null,
            revision: n.revision ?? null,
            hitCount: meta.hitCount,
            lastHitAt: meta.lastHitAt,
            createdAt: meta.createdAt,
          };
        }),
        edges: projection.edges.map((e) => ({
          source: e.source,
          target: e.target,
          rel: e.rel ?? null,
        })),
        deliveries,
        deliveryStats,
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

    /**
     * 候选队列与计划摘要（同 scope；不泄露别卡）。可选 limit / offset 分页
     * （缺省不分页，行为与旧版完全一致）；候选项 sources 补卡片 title、
     * 条目补 stale（源 revision 与 records 不一致 / 源卡不在 records 即过期）、
     * 顶层补 total / groups / statusCounts / staleCount（计数不受分页影响，
     * staleCount 为分页前全量口径），客户端一次请求即可渲染分组与标题，
     * 无需二次取卡比对。投影走 organize/queue.mjs 的 listQueue（纯只读），
     * 不改变队列状态。
     */
    async listCandidates(trustedContext, payload) {
      const p = payload ?? {};
      validateManagementPayload("listCandidates", p);
      requireActiveDataAccess("listCandidates");
      const scope = await scopeFromTrustedContext(trustedContext);
      const resources = await resourcesFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
      const records = await resources.sparkStore.listActive();
      const queue = await loadQueue(scope.scopeId);
      const snapshot = queue.snapshot();
      const page = listQueue({ items: snapshot.items, records, limit: p.limit, offset: p.offset });
      return {
        queueRevision: snapshot.revision,
        items: page.items,
        plans: plansToWire(await state.planStore.list(scope.scopeId)),
        total: page.total,
        groups: page.groups,
        statusCounts: page.statusCounts,
        staleCount: page.staleCount,
      };
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
      assertHostWritable("analyze");
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
        const replayRecords = await resources.sparkStore.listActive();
        const dto = await queueDto(scope.scopeId, queue, replayRecords);
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
        const dto = await queueDto(scope.scopeId, queue, records);
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
      const queue = await loadQueue(scope.scopeId);
      const dto = await queueDto(scope.scopeId, queue, records);
      return {
        queueRevision: dto.queueRevision,
        items: dto.items,
        plans: plansToWire(await state.planStore.list(scope.scopeId)),
        analysis: analysisView,
      };
    },

    /** 候选审阅（与现 queue.review 完全映射；reviewed 不是执行授权）。 */
    async reviewCandidate(trustedContext, payload) {
      validateManagementPayload("reviewCandidate", payload);
      requireActiveDataAccess("reviewCandidate");
      requireActive("reviewCandidate");
      assertHostWritable("reviewCandidate");
      requireModule("organize");
      const scope = await scopeFromTrustedContext(trustedContext);
      const resources = await resourcesFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
      const records = await resources.sparkStore.listActive();
      const queue = await loadQueue(scope.scopeId);
      queue.review(payload.candidateId, {
        decision: payload.decision,
        expectedRevision: payload.expectedQueueRevision,
        operationId: payload.operationId,
      });
      await state.queueStore.save(scope.scopeId, queue.snapshot());
      return queueDto(scope.scopeId, queue, records);
    },

    /** 计划预览：organize proposal 走 buildDraft；forgetting 用 planId 取回 analyze 保存的计划；archive-topic 由 service fresh topic 现建归档/恢复计划。 */
    async previewPlan(trustedContext, payload) {
      validateManagementPayload("previewPlan", payload);
      requireActiveDataAccess("previewPlan");
      requireActive("previewPlan");
      assertHostWritable("previewPlan");
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

      if (payload.kind === "archive-topic") {
        // 0.2.2 专题归档/恢复：不依赖候选队列（candidateId 是确定性别名，
        // 不在队列里），直接从 service 读 fresh topic 构建计划，走既有
        // previewPlan → executePlan 通道（P2-B3 起独立落库 kind:"archive-topic"，
        // executePlan 与 organize 一样走 organizer executor，由其按 plan.kind
        // 分派），不另开写接口。
        requireModule("organize");
        const resources = await resourcesFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
        const fresh = await resources.service.readTopic(payload.topicKey);
        if (fresh.scopeId !== scope.scopeId) {
          fail("INVALID_STATE", `topic "${payload.topicKey}" belongs to scope "${fresh.scopeId}", not "${scope.scopeId}"`, {
            topicKey: payload.topicKey,
            topicScopeId: fresh.scopeId,
            scopeId: scope.scopeId,
          });
        }
        const currentArchivedAt = fresh.archivedAt ?? null;
        if ((payload.archive && currentArchivedAt !== null) || (!payload.archive && currentArchivedAt === null)) {
          fail("INVALID_INPUT", `topic "${payload.topicKey}" is already in the target archive state`, {
            topicKey: payload.topicKey,
            archive: payload.archive,
            currentArchivedAt,
          });
        }
        const target = payload.archive ? nowIso() : null;
        const built = buildArchiveTopicPlan({
          scopeId: scope.scopeId,
          key: payload.topicKey,
          expectedRevision: fresh.revision,
          archivedAt: target,
          currentArchivedAt,
        });
        const planId = `op-${built.digest}`;
        await state.planStore.save(scope.scopeId, planId, {
          kind: "archive-topic",
          planDigest: built.digest,
          queueRevision: null,
          plan: built.plan,
          diff: built.diff,
          changedItems: built.changedItems,
          summary: "archive-topic plan over 1 topic",
        });
        // P-A：计划收敛——独立计划族（P2-B3）：只作废其它仍 open 的归档计划
        // （含升级前以 kind:"organize" 落库的旧归档条目），不动整理预览。
        // payload.operationId 可选（schema required 三键），缺省落
        // null：supersededWith !== undefined 的 executePlan 硬闸仍生效。
        await state.planStore.supersedeOpen(scope.scopeId, {
          kind: "archive-topic",
          keepPlanId: planId,
          operationId: payload.operationId ?? null,
        });
        return {
          planId,
          kind: "organize",
          proposalKind: "archive-topic",
          planDigest: built.digest,
          queueRevision: null,
          diff: built.diff,
          changedItems: built.changedItems,
          summary: "archive-topic plan over 1 topic",
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
        proposalKind: built.plan.kind,
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
      assertHostWritable("executePlan");
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
        // P2-B3：archive-topic 独立计划族后，organize 与 archive-topic 两种
        // store kind 都走 organizer executor（执行器按 plan.kind 分派具体动作）。
        if (entry.kind === "organize" || entry.kind === "archive-topic") {
          requireModule("organize");
          const executor = await createOrganizerExecutor({
            root: dataRoot,
            scopeId: scope.scopeId,
            authorize,
            budgets: coreBudgetsOf(settings.budgets),
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
      // P-A：执行后立即收敛队列——移除两类候选：
      //   1) 引用「已不再是 active」源卡的候选（merge 退休 / forgetting 归档后，
      //      面板不再把失效条目画成可审阅）；
      //   2) 本次执行的候选本身（organize plan.candidateId 指向的那条）：它已
      //      被执行完毕，留在队列里只会让用户再点一个注定 REVISION_CONFLICT
      //      的按钮（link 计划源卡仍 active，旧逻辑因此漏掉它）。收敛/保存后
      //      queueRevision 前进，客户端 load() 刷新即拿不到旧候选。
      // forgetting 计划（archive-ephemeral）没有 candidateId → executedCandidateId
      // 为 null，此时行为与只按 active 过滤完全一致。
      // 确定性/重放安全：移除集合由「队列项 ∩ (非 active 源卡 ∪ 已执行候选)」
      // 决定；重放同 operationId 时首轮已移除、幸存集合不变 → 不动队列、不记
      // 队列事务。队列 operationId 复用本次执行 operationId（面板各操作生成
      // 唯一 operationId）。
      // P-A 残留收紧：收敛/保存抛错时 grant 也必须撤销（merge 已落盘但
      // 调用报错——grant 泄漏会放大授权窗口），finally 保证两条路径都撤销。
      const executedCandidateId = typeof entry.plan?.candidateId === "string" ? entry.plan.candidateId : null;
      try {
        const queue = await loadQueue(scope.scopeId);
        const snapshot = queue.snapshot();
        const activeIds = new Set((await resources.sparkStore.listActive()).map((r) => r.id));
        const survivors = snapshot.items
          .filter((it) => executedCandidateId === null || it.candidate.id !== executedCandidateId)
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

    /**
     * F4 最近变更时间线：journal committed + spark 写操作账双源合并，倒序
     * 分页。数据层（src/timeline/index.mjs）负责分批扫与有界合并；本门面
     * 只经 controller 固定 root 与可信 scope，不直接读文件、不收 payload
     * 的 scope 字段（时间线恒出本 scope，不泄露别 scope）。
     */
    async getTimeline(trustedContext, payload) {
      // payload 缺省时用空对象：校验放行 undefined，后面却直接解引用会抛裸
      // TypeError（直调/嵌入方看到的是崩溃而不是 INVALID_INPUT）。
      const p = payload ?? {};
      validateManagementPayload("getTimeline", p);
      requireActiveDataAccess("getTimeline");
      const scope = await scopeFromTrustedContext(trustedContext);
      const page = await timelineReaderFor().read({
        scope: scope.scopeId,
        offset: p.offset ?? 0,
        limit: p.limit ?? 100,
      });
      // scanLimited 是数据层的诚实度标注（扫描窗口被截断 → 更早的历史根本不
      // 在 items 里，深历史 ≠ 到底了）。它必须到达 wire，否则面板会把「窗口
      // 截断」当成「没有更多」，用户看到的时间线静默缺一段。
      return page;
    },
  };

  return { management, isInert };
}
