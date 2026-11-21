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

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { analyzeCandidates } from "../organize/analyze.mjs";
import {
  createCandidateQueue, buildDraft as buildOrganizeDraft, buildArchiveTopicPlan,
  buildForgetArchiveDiff, listQueue,
} from "../organize/queue.mjs";
import {
  needsOnboarding as needsOnboardingPure,
  proposeGroups as proposeGroupsPure,
  proposalHash as computeProposalHash,
  validateProposal as validateOnboardingProposal,
  assertProposalCoversTopics,
} from "../organize/onboarding.mjs";
import { digestPlan as organizeDigestPlan, createOrganizerExecutor } from "../organize/executor.mjs";
import { analyzeForgetting } from "../forgetting/decay.mjs";
import { createForgetExecutor } from "../forgetting/executor.mjs";
import { renderL1 } from "../core/render.mjs";
import { validateManagementPayload } from "./protocol.mjs";
import { coreBudgetsOf } from "./config.mjs";
import { createTimelineReader } from "../timeline/index.mjs";
import { purgeDataRoot, PurgeSafetyError } from "../storage/purge.mjs";
import { readGroups } from "../storage/groups.mjs";
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

// 人设卡文件名：persona adapter 的落盘布局是 <dataRoot>/persona/<name>.md
// （persona.mjs 顶部磁盘布局），name 即配置里的 persona 名/scopeId。
const PERSONA_CARD_SUFFIX = ".md";

// R1（交叉审查补漏）：diagnostics.personasError 的有界错误摘要上限。摘要只
// 供面板诊断区定位故障类别（code + message），不要求还原完整错误，超长截断。
const PERSONAS_ERROR_SUMMARY_MAX = 200;

/** 读目录失败的有界单行摘要：「CODE: message」，超 PERSONAS_ERROR_SUMMARY_MAX 截断。 */
function personaErrorSummary(error) {
  const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : "UNKNOWN";
  const message = error instanceof Error && typeof error.message === "string" && error.message.length > 0
    ? error.message
    : String(error);
  const raw = `${code}: ${message}`;
  return raw.length <= PERSONAS_ERROR_SUMMARY_MAX ? raw : `${raw.slice(0, PERSONAS_ERROR_SUMMARY_MAX - 1)}…`;
}

/**
 * 人设卡清单（getStatus 的 personas 字段）：<dataRoot>/persona/*.md 的 basename
 * 去掉 .md，名字升序。纯只读——绝不创建目录、不写盘；dataRoot 未初始化（inert）
 * 或 persona 目录不存在时返回 []。
 *
 * R1（交叉审查补漏）：其它读目录失败（EACCES 等）不再整体上抛——旧实现会让
 * getStatus 一起失败，controller 注入的 diagnostics.roots 根本到不了面板，
 * P1#8 的「面板可见」落空。改为返回 { names: [], error: 摘要 }，getStatus 把
 * 有界摘要写进 diagnostics.personasError 后照常返回——故障以诊断字段如实
 * 出线，不静默吞掉、也不把整个状态请求陪葬。ENOENT/ENOTDIR（目录不存在 /
 * 不是目录）仍按「没有卡」处理且不写 personasError（现状口径不变）。
 *
 * @param {string} dataRoot 业务数据根
 * @param {typeof import("node:fs/promises").readdir} readdirImpl 读目录实现
 *   （生产 = node:fs/promises readdir；测试注入 EACCES 桩用）
 * @returns {Promise<{names: string[], error: ?string}>} error null = 目录正常或不存在
 */
async function listPersonaNames(dataRoot, readdirImpl) {
  if (typeof dataRoot !== "string" || dataRoot.length === 0) return { names: [], error: null };
  let entries;
  try {
    entries = await readdirImpl(join(dataRoot, "persona"), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { names: [], error: null };
    return { names: [], error: personaErrorSummary(error) };
  }
  return {
    names: entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PERSONA_CARD_SUFFIX))
      .map((entry) => entry.name.slice(0, -PERSONA_CARD_SUFFIX.length))
      .sort(),
    error: null,
  };
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
 * @param {() => Array<{root: string, path: string, reason: string, code: string}>} [deps.getRootDegradation]
 *   降级挂载（任一根 mkdir 失败）的逐根诊断取值函数（controller 注入；缺省视为
 *   无降级）。executeTool 在 requireStarted 之前据此返回 UNSUPPORTED +
 *   details.roots——降级态不宣称 started，否则面板只会拿到 INVALID_STATE。
 * @param {typeof import("node:fs/promises").readdir} [deps.readdir] 人设卡目录读取注入点
 *   （缺省 node:fs/promises readdir；仅测试注入 EACCES 桩验证 R1 降级路径用，
 *   默认行为逐字不变。controller 经 dependencies.personasReaddir 可选透传，
 *   生产不传。）
 * @param {() => Promise<string[]>} [deps.invalidateScopeResources] scope 资源缓存失效入口
 *   （0.4 S6 中-2：仅 destroyData 使用；async——复用 controller 的 closeAllScopes，
 *   返回 Promise<string[]> 的 close 错误数组，调用方必须 await。存在性在删除之前
 *   校验（review-rework a2 必修 1：校验后置会让「数据先删净、再抛错」），缺失时
 *   destroyData fail-closed 拒绝且不删任何文件；await 后错误数组非空同样
 *   INVALID_STATE 上报（review-rework a3 必修：不 await 会把失败静默吞掉））
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
    getRootDegradation,
    nowIso = () => new Date().toISOString(),
  } = deps;

  for (const [name, value] of Object.entries({ settings, state, resourcesFor, isStarted, generation, registerGrant, executeToolForScope })) {
    if (value === undefined) fail("INVALID_INPUT", `createManagement requires deps.${name}`, {});
  }

  // R1：人设卡目录读取实现（缺省 = 生产 readdir；测试注入桩，controller 不传）。
  const readdirForPersonas = typeof deps.readdir === "function" ? deps.readdir : readdir;

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
   * R1（0.5 批次 3）：降级挂载的逐根诊断（controller 以 getRootDegradation
   * 注入取值函数；缺省/返回非数组一律当作「无降级」，非降级路径行为逐字不变）。
   */
  function rootDegradation() {
    if (typeof getRootDegradation !== "function") return [];
    const roots = getRootDegradation();
    return Array.isArray(roots) ? roots : [];
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

  // ── 0.5 批次 4 · C 线：整理向导（onboardingPreview/Apply/Mark 共用）────────
  //
  // 评审拍板（问答 q-1d92bbf96c2eb618）：独立三方法，previewPlan/executePlan
  // 不动；写通道唯一 = service.mutate 单事务（组清单 + topic 元数据），不碰
  // executor / 不新建旁路存储。预览恒零写入（只读 listTopics/groups/core 视图
  // + renderL1 纯函数现算），应用前绝不自动执行。
  //
  // 授权语义（照 executePlan 评估，评审要求显式交代不做静默省略）：executePlan
  // 的 registerGrant 存在是因为执行器是多步异步过程（多次 authorize 回调、
  // 重试与 merge 退休窗口、signal 断连撤销）。onboardingApply 的唯一写是
  // service.mutate 的一次原子 store 事务（journal + staging + 原子替换，失败
  // 整体回滚）——不存在「授权已给、执行跨多个可撤销窗口」的形态，grant 注册
  // 无可守护的中间态；等价保障 = 调用前 signal.aborted 前置核验（B-abort 同款）
  // + mutate 自身事务性 + hash 内容绑定。trustedContext 仍由 Q 层 owner 校验。

  /** 组清单读取（读路径绝不写盘；缺失=未初始化 → 空清单 + revision null）。 */
  async function readGroupsOrEmpty(scopeId) {
    try {
      const { revision, data } = await readGroups({ dataRoot: settings.dataRoot, scopeId });
      return { revision, groups: data.groups };
    } catch (error) {
      if (error?.code === "NOT_FOUND") return { revision: null, groups: [] };
      throw error;
    }
  }

  /** 向导作用人群：当前 scope 可见 topic 的未归档行（归档=冷内容，不进向导）。 */
  async function onboardingTopicsFor(scopeId, agent) {
    const resources = await resourcesFor(scopeId, agent);
    const rows = await resources.service.listTopics();
    const unarchived = (Array.isArray(rows) ? rows : []).filter((row) => row?.archived !== true);
    return { resources, unarchived };
  }

  /** 提案生效后的每 topic 有效 retention：override > 组默认；未归组 topic 不在表内。 */
  function effectiveRetentionMap(canonical) {
    const byTopic = new Map();
    for (const group of canonical.groups) {
      for (const member of group.members) {
        const override = group.overrides !== undefined ? group.overrides[member] : undefined;
        byTopic.set(member, {
          retention: override ?? group.defaultRetention,
          source: override !== undefined ? "override" : "group",
        });
      }
    }
    return byTopic;
  }

  /** 稳定序列化（diff 展示用；与 organize 槽位 stable 同公式：键排序、数组保序）。 */
  function stableForDiff(value) {
    return JSON.stringify(value, (key, v) => {
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
      }
      return v;
    });
  }

  /**
   * 预览装配（纯只读，零写入）：组目录投影（renderL1 现算「目标组布局」）、
   * historical 清单（组默认或 override 生效者）、冷却候选（同集合平铺）、
   * 展示 diff（groups.json 整表：当前清单 → 现有清单 + 新组；逐 topic 元数据）。
   *
   * R4（评审 P2-2）：生产 L1 渲染（service readCoreView）不传 groups——组行
   * 尚未接入生产 L1。投影改为「既有组（含 0 成员、带原 summary）+ 提案组」的
   * 组目录视图，客户端文案如实标注「目标组布局（0.5 B 线组目录，尚未接入 L1）」，
   * 不再冒称「应用后 L1」；成员口径与 group_manage list 的组行计数一致
   * （主组、未归档；memory_read 组目录含任意挂载与 archived，是另一口径）。
   */
  function buildOnboardingPreview(canonical, unarchived, currentGroups, coreText) {
    const effective = effectiveRetentionMap(canonical);
    const groupByMember = new Map();
    for (const group of canonical.groups) {
      for (const member of group.members) groupByMember.set(member, group.key);
    }
    const rowByKey = new Map(unarchived.map((row) => [row.key, row]));
    // 假想 topic 行：挂组 + 生效 retention（renderL1 校验完整 topic 形状，
    // 逐字沿用 listTopics 行的 key/title/summary/scopeId/revision/updated）。
    const hypothetical = unarchived.map((row) => {
      const groupKey = groupByMember.get(row.key);
      const nextGroup = groupKey !== undefined ? [groupKey] : (Array.isArray(row.group) ? row.group : []);
      return {
        ...row,
        group: nextGroup,
        retention: effective.get(row.key)?.retention ?? row.retention,
      };
    });
    // 假想组投影（renderL1 groups 形状）：members 只带 key/summary/pinned/archived。
    // 既有组先入投影（R4：0 成员也要保留行，summary 用原值；成员按主组挂载
    // row.group[0] === key 解析——与面板「组行计数只认主组」同口径），提案组
    // 追加其后；按 key 去重（既有组优先）——完成态对旧提案重复预览时提案组
    // 已在清单里，重复行会让 renderGroupLines 拒绝整个渲染。
    const groupsProjection = [];
    const seenProjectionKeys = new Set();
    for (const entry of currentGroups) {
      if (seenProjectionKeys.has(entry.key)) continue;
      seenProjectionKeys.add(entry.key);
      groupsProjection.push({
        key: entry.key,
        title: entry.title,
        summary: entry.summary ?? "",
        members: unarchived
          .filter((row) => Array.isArray(row.group) && row.group[0] === entry.key)
          .map((row) => ({
            key: row.key,
            summary: row.summary ?? "",
            pinned: row.pinned === true,
            archived: false,
          })),
      });
    }
    for (const group of canonical.groups) {
      if (seenProjectionKeys.has(group.key)) continue;
      seenProjectionKeys.add(group.key);
      groupsProjection.push({
        key: group.key,
        title: group.title,
        summary: "",
        members: group.members.map((member) => {
          const row = rowByKey.get(member);
          return {
            key: member,
            summary: row?.summary ?? "",
            pinned: row?.pinned === true,
            archived: false,
          };
        }),
      });
    }
    const l1Preview = renderL1({ coreText, topics: hypothetical, groups: groupsProjection }).text;

    // historical / 冷却候选：生效 retention = historical 的 topic（key 码点序）。
    const historical = unarchived
      .filter((row) => effective.get(row.key)?.retention === "historical")
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((row) => ({ key: row.key, title: row.title, source: effective.get(row.key).source }));
    const coolingCandidates = historical.map((row) => ({ key: row.key, title: row.title }));

    // 展示 diff：groups.json 整表（现有条目 → 现有条目 + 新组）+ 逐 topic 元数据。
    // 新组条目与 apply 同形状（order 按 canonical 序 10/20/30；summary 空）。
    const diff = [];
    const topicChanges = [];
    for (const group of canonical.groups) {
      for (const member of group.members) {
        const row = rowByKey.get(member);
        const override = group.overrides !== undefined ? group.overrides[member] : undefined;
        const before = { group: Array.isArray(row?.group) ? row.group : [], retention: row?.retention ?? "standing" };
        const after = {
          group: [group.key],
          retention: override !== undefined ? override : (row?.retention ?? "standing"),
        };
        if (override === undefined && group.defaultRetention === "historical") {
          // 组默认 historical 走组条目策略（resolveRetention），topic 文件不重复落；
          // diff 如实标注生效值来自组策略。
          after.retentionVia = `group:${group.key}`;
        }
        topicChanges.push({ path: `topic:${member}`, oldText: stableForDiff(before), newText: stableForDiff(after) });
      }
    }
    diff.push({
      path: "groups.json",
      oldText: stableForDiff(currentGroups),
      newText: stableForDiff([...currentGroups, ...canonical.groups.map((group, index) => ({
        key: group.key,
        title: group.title,
        summary: "",
        order: (index + 1) * 10,
        ...(group.defaultRetention === "historical" ? { retention: "historical" } : {}),
      }))]),
    });
    for (const entry of topicChanges) diff.push(entry);

    const mountedTopics = topicChanges.length;
    const historicalCount = historical.length;
    return {
      hash: computeProposalHash(canonical),
      diff,
      changedItems: canonical.groups.length + mountedTopics,
      summary: `向导应用：新建 ${canonical.groups.length} 个组、挂载 ${mountedTopics} 个 topic、${historicalCount} 条标 historical（进冷却候选）`,
      l1Preview,
      historical,
      coolingCandidates,
    };
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
     * 状态：mode、当前可信 scope、占用 / 能力 / 诊断。0.4-S1 起 diagnostics 返回
     * 解析后的两个根路径、根来源（rootsSource）与配置完成度信号
     * （configurationState：needs-persona / needs-active / configured）；
     * 仍不返回任何卡正文。
     */
    async getStatus(trustedContext, payload) {
      validateManagementPayload("getStatus", payload ?? {});
      // R1（交叉审查补漏）：personas 清单与状态解耦——persona 目录读不了
      // （EACCES 等权限故障）不再让整个 getStatus 抛错，否则 controller 注入
      // 的 diagnostics.roots 等诊断字段全部到不了面板。错误以有界摘要写入
      // diagnostics.personasError（无错不出键，正常路径 wire 形状逐字不变），
      // 状态照常返回。
      const personaList = await listPersonaNames(settings.dataRoot, readdirForPersonas);
      const status = {
        mode: isInert ? "inert" : settings.mode,
        configured,
        // 人设卡清单（0.4 面板选卡用）：dataRoot/persona/*.md 的名字，升序；
        // inert（dataRoot 未初始化）、目录不存在或目录不可读 → []。只读目录，不建目录。
        personas: personaList.names,
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
          // 0.4-S1（wire 的 diagnostics 块 additionalProperties:true，纯增量）：
          // apply 阶段解析后的两个根（默认落点或显式配置，一律已 mkdir -p）、
          // 根来源（rootsSource：explicit=用户显式配置 / default=缺省解析）与
          // 配置完成度信号。configurationState 与前端初始化卡片三行对齐：
          // needs-persona = 人设卡未指定（defaultPersona null，最优先）；
          // needs-active = 人设卡已配置但 mode 非 active（shadow 只读，待启用）；
          // configured = active 且人设卡已配置。前端不再自行推断。
          dataRoot: settings.dataRoot,
          stateRoot: settings.stateRoot,
          rootsSource: settings.rootsSource,
          configurationState: settings.defaultPersona === null
            ? "needs-persona"
            : (settings.mode === "active" ? "configured" : "needs-active"),
          // P-C 诚实度（wire 的 diagnostics 块 additionalProperties:true，纯增量）：
          // 严格 codec 的实际状态——"strict" = 描述符已注册进宿主 typert registry；
          // "src" = 回退（reason 给出缺席/失败原因）。
          typertRpc: deps.typertRpcInfo?.() ?? { codec: "src", reason: "unknown" },
          // F7：只读状态（writable=false 时面板显示黄条并置灰写按钮）。
          // holder 为外部持有者（座位心跳的 pid/startedAt 等）；缺字段时面板回退 PID。
          readonly: readonlyGuardStatus(),
        },
      };
      // R1：目录读取故障在这里如实出线（有界摘要）；无错不出键——正常路径与
      // ENOENT（目录不存在=没有卡）的返回形状逐字不变。放在 inert/shadow 提前
      // 返回之前：shadow 挂载正是「面板只剩 getStatus 可用」的场景，降级信息
      // 必须同样可达。
      if (personaList.error !== null) {
        status.diagnostics.personasError = personaList.error;
      }
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

    /** 当前授权 scope 的图谱视图（缺省全量；0.4-S7 起支持 level=1 分簇 / level=2 簇内）。 */
    async getGraph(trustedContext, payload) {
      validateManagementPayload("getGraph", payload ?? {});
      requireActiveDataAccess("getGraph");
      const scope = await scopeFromTrustedContext(trustedContext);
      const resources = await resourcesFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
      const records = await resources.sparkStore.listActive();
      const { projectGraph, clusterProjection, normalizeGraphRecords } = await import("../sparks/graph.mjs");
      const normalized = normalizeGraphRecords(records);
      // F2 闪回命中可见性：投影节点只带 id/title/summary/vitality/revision，
      // 投递统计（hitCount/lastHitAt）与存续起点（createdAt）按 id 从卡片记录补回。
      // 三条路径（缺省全量 / level=1 / level=2）共用：两级视图不丢命中统计。
      const hitMeta = new Map();
      for (const record of records) {
        if (record === null || typeof record !== "object" || typeof record.id !== "string") continue;
        hitMeta.set(record.id, {
          hitCount: Number.isInteger(record.hitCount) && record.hitCount >= 0 ? record.hitCount : 0,
          lastHitAt: typeof record.lastHitAt === "string" ? record.lastHitAt : null,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
        });
      }
      // 节点出线口径：全量与 level=2 共用（level=1 无节点；簇内节点必须仍带命中字段）。
      // 0.4 收尾补 entities：projectGraph 的节点已按 normalizeEntities 规范化
      // （trim 非空、去重保序、上限 4 条，脏数据退化为 []）；客户端 entityKeyOf
      // 按 raw.entities 取首实体做聚类着色（图例「填充=实体聚类」），此前 nodeOut
      // 丢字段导致所有节点落中性色。缺省 []，调用方（客户端）按空数组走中性色。
      // 前提（0.4 收尾 reviewer 记录项）：这里只做 Array.isArray 兜底、不重复
      // 规范化，规范化单一来源在 graph.mjs 的 normalizeEntities——若投影路径
      // 变更（换掉 projectGraph / 改节点产出），规范化必须跟着走，否则脏数据
      // 会从这里漏到 wire（契约 maxItems 4 / items 非空字符串会被打破）。
      // 0.4 收尾补 degree：projectGraph（graph.mjs:190/260-261）与 clusterProjection
      // （graph.mjs:383-390）都算好了节点度，此前 nodeOut 白名单未放行，字段在这一
      // 步被静默丢掉。客户端 nodeRadiusOf 依赖该字段（读 node.raw.degree）据此放大
      // 节点半径，缺失即退化为 0 → 半径恒为基准值、重要度看不出来。脏数据兜底 0
      // 与 hitCount 同口径（非负整数才放行）。
      const nodeOut = (n) => {
        const meta = hitMeta.get(n.id) ?? { hitCount: 0, lastHitAt: null, createdAt: null };
        return {
          id: n.id,
          title: n.title ?? null,
          summary: n.summary ?? null,
          vitality: n.vitality ?? null,
          revision: n.revision ?? null,
          degree: Number.isInteger(n.degree) && n.degree >= 0 ? n.degree : 0,
          entities: Array.isArray(n.entities) ? n.entities : [],
          hitCount: meta.hitCount,
          lastHitAt: meta.lastHitAt,
          createdAt: meta.createdAt,
        };
      };
      const edgeOut = (e) => ({ source: e.source, target: e.target, rel: e.rel ?? null });
      // F2：L2 投递账 → 最近投递明细（上限 20 条，只含元数据）+ 全量吞吐统计。
      // 账本只覆盖 L2 开启期间的记录（L2 关闭期无账可查），该口径由面板如实标注。
      // 三条路径（缺省全量 / level=1 / level=2）共用：两级视图不丢投递账。
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
      // 0.4-S7 两级视图：level 缺省走全量兼容路径（candidates 页与既有用例依赖），
      // level=1/2 走 clusterProjection。deliveries/deliveryStats 三条路径口径一致。
      if (payload?.level !== undefined) {
        // clusterProjection 的返回体自带 schemaVersion/level/scopeId（纯函数独立成契约），
        // 这里只取 clusters/total（level=1）与 cluster/nodes/edges（level=2）三项出线，
        // wire 形状仍以本文件声明的 outputSchema 为准。
        // cluster 只在 level=2 时生效（level=1 是簇概览，cluster 无意义——哪怕带了也忽略，
        // 保证 {level:1, cluster:"任意"} 一定返回 clusters/total 齐全的 level=1 形状）。
        // level=2 没带 cluster：不崩，按未知簇退化为空视图（key 为空串必不命中）。
        const cluster = payload.level === 2 ? (payload.cluster ?? "") : undefined;
        const projection = clusterProjection({ scopeId: scope.scopeId, records: normalized, cluster });
        if (payload.level === 1) {
          return {
            scope: scope.scopeId,
            level: 1,
            clusters: projection.clusters,
            total: projection.total,
            deliveries,
            deliveryStats,
          };
        }
        return {
          scope: scope.scopeId,
          level: 2,
          cluster: { key: projection.cluster.key, label: projection.cluster.label, count: projection.cluster.count },
          nodes: projection.nodes.map(nodeOut),
          edges: projection.edges.map(edgeOut),
          deliveries,
          deliveryStats,
        };
      }
      const projection = projectGraph({ scopeId: scope.scopeId, records: normalized });
      return {
        scope: scope.scopeId,
        nodes: projection.nodes.map(nodeOut),
        edges: projection.edges.map(edgeOut),
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
      // R1：降级挂载（roots 不可写）先于 requireActiveDataAccess/requireStarted
      // 判定——降级态不宣称 started，旧顺序只会把可用性故障错报成 INVALID_STATE
      // 「尚未启动」。与宿主工具入口同一口径：明确 UNSUPPORTED + details.roots
      // 说明哪个根不可用、为什么；非降级路径（诊断为空数组）行为逐字不变。
      const degradation = rootDegradation();
      if (degradation.length > 0) {
        fail("UNSUPPORTED", `shiori root directories are not writable; tool "${String(payload.name)}" is unavailable (degraded read-only mount). 修复目录权限或显式改配 dataRoot/stateRoot 后重启插件即可恢复`, {
          roots: [...degradation],
        });
      }
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
      // B1（audit B P2-1）：markExecuted 已落账、执行结果已定，收敛阶段再抛
      // 错不得翻转回执——把成功伪装成失败会让客户端拿不到执行回执，且重试
      // 恒撞「already executed」硬闸（幂等判据：planStore.executed 标志先于
      // 收敛落账，同 planId 重试必被上方 executed 硬闸拒绝，不会二次执行）。
      // 收敛失败降级为回执内 queueConvergence.applied=false + 可读告警；残留
      // 失效候选由下一次 organize analyze 的收敛清理，队列正确性不受损
      // （失效候选只会导致一次注定 REVISION_CONFLICT 的执行，无数据风险）。
      const executedCandidateId = typeof entry.plan?.candidateId === "string" ? entry.plan.candidateId : null;
      let queueConvergence = { applied: true };
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
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        queueConvergence = {
          applied: false,
          warning: `计划已执行，但执行后的队列收敛失败（失效候选留待下次 analyze 清理）：${reason}`,
        };
      } finally {
        grant.revoke();
      }
      return {
        planId: payload.planId,
        planDigest: payload.planDigest,
        operationId: payload.operationId,
        result,
        queueConvergence,
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

    /**
     * 0.4 S6 卸载与焚毁（第 11 个管理方法，wire 唯一一次增项）：焚毁整个
     * dataRoot（目录本身一并移除）。stateRoot 与 DSH 配置不动；不自动做
     * plugin remove、失败不忽略错误继续。
     *
     * 门面顺序（fail-closed）：schema 校验 → 配置/数据访问守门 → 权限二次
     * 核验（UNAUTHORIZED）→ confirm 必须等于当前 dataRoot 原文（INVALID_INPUT）
     * → purge 模块安全校验（与命令行同一份实现；违反按 INVALID_INPUT 拒绝，
     * details.rule 记具体规则）→ 删除 → scope 资源缓存失效（中-2）。
     * 目录不存在返回 deleted:false（不抛错）。
     *
     * 期望根双重锁定：confirm 与 expectedRoot 都钉死在 settings.dataRoot
     * （服务端解析的当前根，payload 里不带任何根字段），purge 模块再校验
     * 「确认的根 = 删除的根」。
     */
    async destroyData(trustedContext, payload) {
      validateManagementPayload("destroyData", payload);
      requireConfigured();                    // inert → NOT_CONFIGURED
      requireActiveDataAccess("destroyData"); // shadow → UNSUPPORTED；未 start → INVALID_STATE
      assertHostWritable("destroyData");      // F7 只读宿主 → HOST_LOCKED（与写工具同口径）
      // 权限：面板 RPC 授权只认 owner（与 Q 层同口径的二次核验，fail-closed；
      // 直调/嵌入方绕过 Q 时在这里拦下）。
      const principal = trustedContext?.principal;
      if (!principal || principal.kind !== "owner") {
        fail("UNAUTHORIZED", "destroyData requires an owner principal", {
          principalKind: principal ? String(principal.kind) : null,
        });
      }
      const expectedRoot = settings.dataRoot;
      if (typeof payload.confirm !== "string" || payload.confirm !== expectedRoot) {
        fail("INVALID_INPUT", "confirm 必须等于当前 dataRoot 原文（逐字符相等）", {
          confirm: "must equal the current dataRoot exactly",
        });
      }
      // 中-2（review-rework a1）+ 必修 1（review-rework a2）：依赖校验必须在
      // purgeDataRoot 之前——校验后置会造成「数据已删净、然后才抛 INVALID_STATE」
      // 的顺序错误（破坏性动作先做、校验后做）。fail-closed：生产 controller 必
      // 注入 invalidateScopeResources；缺失时拒绝且删除根本不发生。
      if (typeof deps.invalidateScopeResources !== "function") {
        fail("INVALID_STATE", "destroyData requires deps.invalidateScopeResources (scope resource cache must be droppable after purge)", {});
      }
      // purge 共享模块（命令行与面板同一份实现）：安全校验 + 删除。
      // PurgeSafetyError（fail-closed 拒绝，code=INVALID_INPUT，details.rule
      // 记命中的具体规则）与 IO 失败都原样上抛——绝不忽略错误后假装成功。
      const result = await purgeDataRoot(expectedRoot, {
        expectedRoot,
        stateRoot: settings.stateRoot,
      });
      // 焚毁成功后使 scope 资源缓存失效——缓存里的 sparkStore/service 全部指向
      // 已删目录，不清掉的话后续访问会拿到旧缓存（内存中仍有已焚毁卡片的记录）。
      // closeAllScopes 只关内存态并清缓存，下一次访问按需重建空资源。仅
      // deleted:true 时需要；deleted:false（目录本就不存在）不动缓存。close
      // 全程内存操作、不可能触盘失败；万一报错仍如实上抛（不静默吞掉让旧缓存
      // 悄悄残留）。
      if (result.deleted === true) {
        // 必修（review-rework a3）：invalidateScopeResources 是 async（复用的
        // closeAllScopes 返回 Promise<string[]>）——必须 await 拿到错误数组再
        // 判定；不 await 的话拿到的是 Promise，Array.isArray 恒 false，清缓存
        // 失败会被静默吞掉（检测成死代码）。万一报错仍如实上抛（不静默吞掉
        // 让旧缓存悄悄残留）。
        const closeErrors = await deps.invalidateScopeResources();
        if (Array.isArray(closeErrors) && closeErrors.length > 0) {
          fail("INVALID_STATE", `destroyData succeeded but scope resource invalidation failed: ${closeErrors.join("; ")}`, {});
        }
      }
      return result;
    },

    /**
     * 0.5 批次 4 · C 线（wire 12）：整理向导状态 + 提案预览。两种模式零写入：
     * - 无参（状态模式）：needsOnboarding 五态判定 + 纯规则提案（proposeGroups）
     *   + 标记位回显；未触发时 proposal 为 null。
     * - {proposal}（预览模式）：按用户编辑后的提案出「目标组布局投影 /
     *   historical 清单 / 冷却候选 / 展示 diff」——只读 listTopics/groups/
     *   core 视图 + renderL1 纯函数，不落 planStore、不碰标记位、不写盘。
     * 向导人群恒为未归档 topic（归档=冷内容，不参与聚类与挂载）。
     */
    async onboardingPreview(trustedContext, payload) {
      const p = payload ?? {};
      validateManagementPayload("onboardingPreview", p);
      requireActiveDataAccess("onboardingPreview");
      const scope = await scopeFromTrustedContext(trustedContext);
      const { resources, unarchived } = await onboardingTopicsFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
      const groupsRead = await readGroupsOrEmpty(scope.scopeId);
      const flagRead = await state.onboardingStore.read();
      const diagnosticsOut = { groupsRevision: groupsRead.revision };
      if (flagRead.error !== null) diagnosticsOut.flagError = flagRead.error;

      const verdict = needsOnboardingPure({
        topics: unarchived,
        groups: groupsRead.groups,
        onboarding: flagRead.flag,
      });

      if (p.proposal !== undefined) {
        // 预览模式：成员完整性与 overrides 深层校验 fail-closed（对照组 snapshot
        // 是本次现读的未归档行——topic 集合与提案不符即 INVALID_INPUT，面板刷新重提）。
        const canonical = validateOnboardingProposal(p.proposal);
        assertProposalCoversTopics(canonical, unarchived);
        const coreView = await resources.service.readCoreView();
        return {
          scope: scope.scopeId,
          needed: verdict.needed,
          reason: verdict.reason,
          markedKind: verdict.markedKind,
          counts: {
            topics: unarchived.length,
            groups: groupsRead.groups.length,
            historical: unarchived.filter((row) => row.retention === "historical").length,
            proposed: 0,
          },
          flag: flagRead.flag,
          proposal: null,
          preview: buildOnboardingPreview(canonical, unarchived, groupsRead.groups, coreView.body),
          diagnostics: diagnosticsOut,
        };
      }

      // 状态模式：纯规则提案（仅 needed 时）；takenKeys 预置既有组 key——提案
      // key 恒不与既有组撞名（R5①：面板改不了 key，撞名即死路，提议源头规避）；
      // 哈希供面板在「以后再说」时随 onboardingMark 回传，与标记位比对。
      const proposed = verdict.needed ? proposeGroupsPure(unarchived, { takenKeys: groupsRead.groups.map((g) => g.key) }) : [];
      return {
        scope: scope.scopeId,
        needed: verdict.needed,
        reason: verdict.reason,
        markedKind: verdict.markedKind,
        counts: {
          topics: unarchived.length,
          groups: groupsRead.groups.length,
          historical: unarchived.filter((row) => row.retention === "historical").length,
          proposed: proposed.length,
        },
        flag: flagRead.flag,
        proposal: proposed.length > 0
          ? { hash: computeProposalHash({ groups: proposed, ungrouped: [] }), groups: proposed, ungrouped: [] }
          : null,
        preview: null,
        diagnostics: diagnosticsOut,
      };
    },

    /**
     * 0.5 批次 4 · C 线（wire 13）：确认应用。硬闸（评审细化口径）：
     * confirmed 显式 true（schema）→ 服务端重算 proposalHash 与 payload.hash
     * 绑定（不符 REVISION_CONFLICT）→ 已 completed 拒（INVALID_STATE，一次性）
     * → signal.aborted 前置核验 → service.mutate 单事务（组清单 CAS + topic
     * 元数据；operationId 幂等由 store journal 层承担）→ completedAt 写盘
     * （失败只诊断不阻塞，重试同 operationId 由 mutate 幂等收尾）。
     */
    async onboardingApply(trustedContext, payload) {
      validateManagementPayload("onboardingApply", payload);
      requireConfigured();
      requireStarted();
      requireActive("onboardingApply");
      assertHostWritable("onboardingApply");
      const scope = await scopeFromTrustedContext(trustedContext);
      if (trustedContext.signal?.aborted === true) {
        fail("AUTHORIZATION_REQUIRED", "onboardingApply cancelled before execution", { scopeId: scope.scopeId });
      }
      const { resources, unarchived } = await onboardingTopicsFor(scope.scopeId, sessionEvidenceFromRpc(trustedContext).agent);
      const canonical = validateOnboardingProposal(payload.proposal);
      assertProposalCoversTopics(canonical, unarchived);
      const recomputedHash = computeProposalHash(canonical);
      if (recomputedHash !== payload.hash) {
        fail("REVISION_CONFLICT", "hash does not match the proposal content (approval must bind content)", {
          expectedHash: recomputedHash,
        });
      }
      const flagRead = await state.onboardingStore.read();
      if (flagRead.flag?.completedAt) {
        fail("INVALID_STATE", `onboarding wizard already completed at ${flagRead.flag.completedAt}（一次性；如需重整请用面板分组管理或重新初始化 stateRoot）`, {
          completedAt: flagRead.flag.completedAt,
        });
      }

      const groupsRead = await readGroupsOrEmpty(scope.scopeId);
      // R9②/P2-8②：应用前复核 needsOnboarding 门槛，守住「≥5 且首启」语义——
      // 手造 proposal 经 RPC 对 3 个 topic 的 scope 建组在这里被拒（面板卡片本
      // 就只在 needed 时出现，这是服务端硬闸）。完成态已在上方一次性硬闸拦下，
      // dismissed 需先「重新开始」，grouped/has-historical 说明用户已自己动手。
      const verdict = needsOnboardingPure({
        topics: unarchived,
        groups: groupsRead.groups,
        onboarding: flagRead.flag,
      });
      if (verdict.needed !== true) {
        fail("INVALID_STATE", `onboarding wizard is not applicable now (reason=${verdict.reason}${verdict.markedKind ? `/${verdict.markedKind}` : ""})；应用只对「未归组、无 historical、topic≥5 且未标记」的 scope 开放`, {
          reason: verdict.reason,
          markedKind: verdict.markedKind,
        });
      }
      // 新组条目：key 碰撞 fail-closed（R5①：提案侧已用 takenKeys 规避既有
      // 组 key，此处是并发/手造提案的兜底硬闸——文案给用户可执行出路）；order
      // 按规范化 key 序 10/20/30…（确定性）；summary 空串（面板可后改）；组默认
      // historical 写进组条目 retention（resolveRetention：topic 显式值覆盖组默认）。
      const existingKeys = new Set(groupsRead.groups.map((g) => g.key));
      const newEntries = canonical.groups.map((group, index) => {
        if (existingKeys.has(group.key)) {
          fail("INVALID_INPUT", `组 key "${group.key}" 已存在于组清单（请在向导里跳过该组，或到分组管理里处理同名组后重试）`, {
            key: group.key,
            known: [...existingKeys].sort(),
          });
        }
        const entry = { key: group.key, title: group.title, summary: "", order: (index + 1) * 10 };
        if (group.defaultRetention === "historical") entry.retention = "historical";
        return entry;
      });
      const nextGroups = [...groupsRead.groups, ...newEntries];

      // topic changes：仅组成员（ungrouped 保持现状不动）；group 挂载必写；
      // retention 仅 override 显式写（组默认走组条目策略，topic 文件不重复落
      // standing——避免组策略后续调整时 topic 显式值反而盖不住的矛盾）。
      const rowByKey = new Map(unarchived.map((row) => [row.key, row]));
      const changes = [];
      for (const group of canonical.groups) {
        for (const member of group.members) {
          const row = rowByKey.get(member);
          const topicMeta = { group: [group.key] };
          const override = group.overrides !== undefined ? group.overrides[member] : undefined;
          if (override !== undefined) topicMeta.retention = override;
          changes.push({
            kind: "topic",
            key: member,
            expectedRevision: row.revision,
            text: row.body ?? "",
            topic: topicMeta,
          });
        }
      }
      const mutateResult = await resources.service.mutate({
        operationId: payload.operationId,
        changes,
        groups: { expectedRevision: groupsRead.revision, groups: nextGroups },
      });

      // 应用成功 → completedAt + proposalHash。写盘失败只诊断不阻塞（§11.2.7）：
      // 数据已落地；重试同 operationId 时 mutate journal 幂等返回原回执，completedAt
      // 由该次重试补写——warning 如实说明，不把成功伪装成失败。
      const completedAt = nowIso();
      const flagResult = await state.onboardingStore.complete(completedAt, recomputedHash);
      const historicalCount = canonical.groups.reduce((n, group) => {
        for (const member of group.members) {
          const override = group.overrides !== undefined ? group.overrides[member] : undefined;
          if ((override ?? group.defaultRetention) === "historical") n += 1;
        }
        return n;
      }, 0);
      const out = {
        applied: true,
        operationId: payload.operationId,
        hash: recomputedHash,
        createdGroups: newEntries.length,
        mountedTopics: changes.length,
        historicalCount,
        result: { changes: mutateResult?.changes ?? [] },
        completedAt,
      };
      if (flagResult.ok !== true) {
        // R4（评审二轮）：文案只陈述事实，不承诺 UI 做不到的事——应用后卡片
        // 收起（grouped），面板没有「重试同一请求」的入口；completedAt 缺失的
        // 后果（一次性闸门以此为准）如实说明即可。
        out.warning = `组与 retention 已写入；onboarding.json 写盘失败（${flagResult.error}）——completedAt 未记录，向导完成标记缺失（不影响已写入的数据）`;
      } else if (flagResult.healed === true) {
        out.warning = `检测到 onboarding.json 损坏，已备份为 ${flagResult.healedDetail} 并重建标记位（completedAt 已写入）`;
      }
      return out;
    },

    /**
     * 0.5 批次 4 · C 线（wire 14）：向导标记位维护。「以后再说」写 dismissedAt
     * （可选携带当前提案 hash 供预览与标记位比对）；「重新开始」清 dismissedAt。
     * 只触 stateRoot/onboarding.json（scope 无关），不要求 started；写盘失败
     * 只诊断不阻塞（warning 出有界摘要）。
     */
    async onboardingMark(trustedContext, payload) {
      validateManagementPayload("onboardingMark", payload);
      requireConfigured();
      assertHostWritable("onboardingMark");
      // healed（R6②/P2-5）：坏 JSON 自愈成功也如实出 warning（备份文件名），
      // 不把「悄悄重建」伪装成无事发生。
      if (payload.dismiss === true) {
        const markResult = await state.onboardingStore.dismiss(nowIso(), payload.hash ?? null);
        const flagRead = await state.onboardingStore.read();
        return {
          action: "dismiss",
          flag: flagRead.flag,
          warning: markResult.ok !== true
            ? `dismissedAt 写盘失败（下次仍会提示）：${markResult.error}`
            : (markResult.healed === true ? `检测到 onboarding.json 损坏，已备份为 ${markResult.healedDetail} 并重建标记位` : null),
        };
      }
      const restartResult = await state.onboardingStore.restart();
      const flagRead = await state.onboardingStore.read();
      return {
        action: "restart",
        flag: flagRead.flag,
        warning: restartResult.ok !== true
          ? `dismissedAt 清除失败（向导保持隐藏态，可重试）：${restartResult.error}`
          : (restartResult.healed === true ? `检测到 onboarding.json 损坏，已备份为 ${restartResult.healedDetail} 并重建标记位` : null),
      };
    },
  };

  return { management, isInert };
}
