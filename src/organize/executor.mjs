// Shiori P3-ORGANIZE · L 槽受审执行器（P3-APPROVED-EXECUTOR）
//
// 职责（CONTRACTS §4）：只执行调用方每轮显式提交的单个已批准 plan
// （link / merge-topic），复用既有 createShioriService / createFileStore /
// openSparkStore 与它们的锁、CAS、journal、operation 幂等，不重写 topic
// 文件、不重写 sparks.json、不新增通用跨 DB 协调 journal。
//
// 授权模型：authorize 是宿主注入的判定函数；await authorize(...) 必须
// 严格 === true 才继续（客户端声明不是认证）。merge-topic 在「新退休源」
// 之前还会在锁外再判定一次（每次重试同样重新判定），随后锁内重读 topic
// 与源卡核验，再原子退休。用户内容永远不触发 authorize；本模块不从任何
// 未验证宿主声称已接线。
//
// 轮次身份（主审 L-3）：executeRound 在首个 await 前同步冻结全部输入
// （operationId / approval / plan 深拷贝），此后授权、派生子 id、bind、
// 落库与返回结果全部使用同一冻结身份，调用方跨 await 改写原 args 无效。
//
// merge 恢复语义（主审 L-2/L-6/L-7）：topic 提交永远凭稳定 mt 子
// operationId 走既有 service journal——storage.commit 的同 operationId 幂等
// 早退严格先于 generation/live CAS/policy，因此「本 round 是否提交过」由
// 持久 journal 判定，绝不以正文相等推断（无关操作可能写入逐字节相同的
// after，此时原 token 必然 CAS 失败，源全部保留）。退休阶段先锁内重读
// 全部源卡：全部 active 且 revision 与 plan 一致 → 新退休工作（锁内再核
// topic scope/正文/源块，外部覆盖即拒绝留源）；全部 merged 且 mergedInto
// 与 plan 派生期望一致 → 本 round 已完成的历史收据重放，不读 live topic、
// 不做 live 核验，用卡上指针重建首次退休指纹走 retireMerged 幂等重放，
// 零写、不重写外部已编辑的 topic；其余状态 fail-closed 拒绝。重放与首跑
// 每次同样重新 authorize、绑定相同 round 指纹。topic 先持久化，源退休用
// 提案 store.retireMerged 单 DB 原子整批；失败宁可保留重复也不丢源。派生
// 子 operationId 只从 scope + round operationId + 固定阶段标签派生（不含
// plan digest，不绕过碰撞校验）。
//
// 本模块不是公开 tool，也不注册任何宿主 tool；后台循环由调用方驱动，
// executeRound 不接受自动循环。

import path from 'node:path';

import { validateConfig, renderL1, evaluateMutation } from '../core/index.mjs';
import { createShioriService } from '../service/index.mjs';
import { createFileStore } from '../storage/index.mjs';
import { validateScopeId, validateOperationId } from '../storage/paths.mjs';
import { assertEncodableUtf8, sha256Buffer } from '../storage/fsutil.mjs';
import { openSparkStore } from '../sparks/store.mjs';

const APPROVAL_ACTORS = new Set(['main-session', 'authorized-idle-heartbeat']);
const SOURCES_BLOCK_OPEN = '\n<!-- shiori-p3-sources -->\n';
const SOURCES_BLOCK_CLOSE = '\n<!-- /shiori-p3-sources -->\n';

const PLAN_VERSION = 1;
const LINK_SOURCES_MAX = 64;      // 与提案 spark-store.mjs 保持一致
const MERGE_SOURCES_MIN = 8;
const MERGE_SOURCES_MAX = 19;
const LINKS_MAX = 20;

// plan 每 kind 允许的顶层键（禁止未知字段，digest/approval/operationId
// 由执行轮另行绑定，不允许出现在 plan 内）。
const PLAN_KEYS = {
  link: new Set(['version', 'scopeId', 'candidateId', 'kind', 'sources', 'links']),
  'merge-topic': new Set(['version', 'scopeId', 'candidateId', 'kind', 'sources', 'topic']),
  'thin-core': new Set(['version', 'scopeId', 'candidateId', 'kind', 'sources', 'core']),
};

function err(code, message, details) {
  const e = new Error(message);
  e.code = code;
  if (details !== undefined) e.details = details;
  return e;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 契约 §1 的 stable：递归排序普通对象键，数组保序（与 fsutil.stableStringify 同算法）。 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
}

/** plan 摘要：SHA256 UTF8 stable(plan)。plan 已通过完整 schema + 排序校验。 */
export function digestPlan(plan) {
  return sha256Buffer(Buffer.from(stable(plan), 'utf8'));
}

/**
 * 派生阶段子 operationId：只由 scope + round operationId + 固定阶段标签
 * 决定（确定性、无 plan digest），保证同 round 重试得到同一批子操作身份，
 * 同 round 换 plan 时被各阶段 ops 的指纹碰撞校验拒绝。
 */
function deriveStageOperationId(scopeId, operationId, stage) {
  const h = sha256Buffer(Buffer.from(stable([scopeId, operationId, stage]), 'utf8')).slice(0, 40);
  const derived = `${stage}-${h}`;
  validateOperationId(derived);
  return derived;
}

// ---------------------------------------------------------------------------
// plan 完整 schema 校验（与提案 proposals/spark-store.mjs 同规则副本；
// 提案方法内部还会再独立校验一次，双保险）
// ---------------------------------------------------------------------------

function checkPlanString(value, field, { min, max }) {
  if (typeof value !== 'string') {
    throw err('INVALID_INPUT', `plan.${field} 必须是字符串`);
  }
  if (value.length < min || (max !== undefined && value.length > max)) {
    throw err('INVALID_INPUT', `plan.${field} 长度必须在 ${min}..${max ?? '∞'} UTF-16（实际 ${value.length}）`);
  }
  assertEncodableUtf8(value, `plan.${field}`);
  return value;
}

function checkSparkIdShape(id, field) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) {
    throw err('INVALID_INPUT', `plan ${field} 必须是 1..64 字符的字符串`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || id.endsWith('.') || id === '__proto__') {
    throw err('INVALID_INPUT', `plan ${field} 含非法字符/形状`, { value: id });
  }
  return id;
}

function checkPlanSources(value, { min, max }) {
  if (!Array.isArray(value)) throw err('INVALID_INPUT', 'plan.sources 必须是数组');
  if (value.length < min || value.length > max) {
    throw err('INVALID_INPUT', `plan.sources 数量必须在 ${min}..${max}（实际 ${value.length}）`);
  }
  let prev = null;
  for (const s of value) {
    if (!isPlainObject(s)) throw err('INVALID_INPUT', 'plan.sources 项必须是 {id,revision} 对象');
    const keys = Object.keys(s);
    if (keys.length !== 2 || !Object.hasOwn(s, 'id') || !Object.hasOwn(s, 'revision')) {
      throw err('INVALID_INPUT', 'plan.sources 项只允许恰好 id/revision 两个键');
    }
    checkSparkIdShape(s.id, 'sources.id');
    if (!Number.isInteger(s.revision) || s.revision < 1) {
      throw err('INVALID_INPUT', `plan.sources.revision 必须是 >=1 整数（id=${s.id}）`);
    }
    if (prev !== null && !(prev < s.id)) {
      throw err('INVALID_INPUT', `plan.sources 必须按 id UTF16 升序且无重复（"${s.id}" 处乱序/重复）`);
    }
    prev = s.id;
  }
  return value;
}

function checkPlanLinkPairs(value, field) {
  if (!Array.isArray(value)) throw err('INVALID_INPUT', `plan.${field} 必须是 {target,rel} 数组`);
  if (value.length > 32) {
    throw err('INVALID_INPUT', `plan.${field} 最多 32 项（实际 ${value.length}）`);
  }
  let prevKey = null;
  for (const p of value) {
    if (!isPlainObject(p)) throw err('INVALID_INPUT', `plan.${field} 项必须是对象`);
    const keys = Object.keys(p);
    if (keys.length !== 2 || !Object.hasOwn(p, 'target') || !Object.hasOwn(p, 'rel')) {
      throw err('INVALID_INPUT', `plan.${field} 项只允许恰好 target/rel 两个键`);
    }
    checkSparkIdShape(p.target, `${field}.target`);
    if (typeof p.rel !== 'string' || p.rel.length < 1 || p.rel.length > 64 || p.rel.trim() === '') {
      throw err('INVALID_INPUT', `plan.${field}.rel 必须是 1..64 非空白字符串`);
    }
    const key = `${p.target}\u0000${p.rel}`;
    if (prevKey !== null && !(prevKey < key)) {
      throw err('INVALID_INPUT', `plan.${field} 必须按 target 再 rel 升序且无 (target,rel) 重复`);
    }
    prevKey = key;
  }
  return value;
}

function validateRoundPlan(plan, boundScopeId) {
  if (!isPlainObject(plan)) throw err('INVALID_INPUT', 'plan 必须是对象');
  const kind = plan.kind;
  if (!(kind === 'link' || kind === 'merge-topic' || kind === 'thin-core')) {
    throw err('INVALID_INPUT', 'plan.kind 只支持 link / merge-topic / thin-core', { kind });
  }
  const allowed = PLAN_KEYS[kind];
  const present = new Set(Object.keys(plan));
  for (const key of present) {
    if (!allowed.has(key)) {
      if (key === 'digest' || key === 'approval' || key === 'operationId') {
        throw err('INVALID_INPUT', `plan 不能携带 "${key}"（digest/approval/operationId 由执行轮另行绑定）`);
      }
      throw err('INVALID_INPUT', `plan 含未知字段 "${key}"（kind=${kind}）`, { key });
    }
  }
  for (const key of allowed) {
    if (!present.has(key)) {
      throw err('INVALID_INPUT', `plan 缺少必填字段 "${key}"（kind=${kind}）`, { key });
    }
  }
  if (plan.version !== PLAN_VERSION) {
    throw err('INVALID_INPUT', `plan.version 必须是 ${PLAN_VERSION}`, { version: plan.version });
  }
  if (plan.scopeId !== boundScopeId) {
    throw err('INVALID_INPUT', 'plan.scopeId 与执行器绑定 scope 不一致（跨 scope 一律拒绝）', {
      planScopeId: plan.scopeId, boundScopeId,
    });
  }
  checkPlanString(plan.candidateId, 'candidateId', { min: 1, max: 128 });

  if (kind === 'link') {
    checkPlanSources(plan.sources, { min: 1, max: LINK_SOURCES_MAX });
    if (!Array.isArray(plan.links) || plan.links.length < 1 || plan.links.length > LINKS_MAX) {
      throw err('INVALID_INPUT', `plan.links 数量必须在 1..${LINKS_MAX}（一次 round 最多 20 条写入，不得拆轮绕过）`);
    }
    const sourceIds = new Set(plan.sources.map((s) => s.id));
    const revisionOf = new Map(plan.sources.map((s) => [s.id, s.revision]));
    let prevId = null;
    for (const l of plan.links) {
      if (!isPlainObject(l)) throw err('INVALID_INPUT', 'plan.links 项必须是对象');
      const keys = Object.keys(l);
      if (keys.length !== 4 || !keys.every((k) => ['id', 'expectedRevision', 'before', 'after'].includes(k))) {
        throw err('INVALID_INPUT', 'plan.links 项只允许恰好 id/expectedRevision/before/after 四个键');
      }
      checkSparkIdShape(l.id, 'links.id');
      if (prevId !== null && !(prevId < l.id)) {
        throw err('INVALID_INPUT', 'plan.links 必须按 id UTF16 升序且无重复');
      }
      prevId = l.id;
      if (!sourceIds.has(l.id)) {
        throw err('INVALID_INPUT', `plan.links.id "${l.id}" 不在 plan.sources 中`);
      }
      if (l.expectedRevision !== revisionOf.get(l.id)) {
        throw err('INVALID_INPUT', `plan.links.expectedRevision 与 plan.sources 中 "${l.id}" 的 revision 不一致`);
      }
      if (!Number.isInteger(l.expectedRevision) || l.expectedRevision < 1) {
        throw err('INVALID_INPUT', `plan.links.expectedRevision 必须是 >=1 整数`);
      }
      checkPlanLinkPairs(l.before, 'links.before');
      checkPlanLinkPairs(l.after, 'links.after');
      const beforeSet = new Set(l.before.map((p) => `${p.target}\u0000${p.rel}`));
      const afterSet = new Set(l.after.map((p) => `${p.target}\u0000${p.rel}`));
      if (afterSet.size !== l.after.length || beforeSet.size !== l.before.length) {
        throw err('INVALID_INPUT', 'plan.links before/after 含重复 (target,rel)');
      }
      let added = 0;
      for (const key of afterSet) {
        if (!beforeSet.has(key)) added += 1;
      }
      if (added === 0) throw err('INVALID_INPUT', `plan.links "${l.id}" 的 after 相对 before 无新增边（拒绝无变化）`);
      for (const key of beforeSet) {
        if (!afterSet.has(key)) throw err('INVALID_INPUT', `plan.links "${l.id}" 的 after 丢失了 before 边（append-only）`);
      }
      for (const p of l.after) {
        if (p.target === l.id) throw err('INVALID_INPUT', `plan.links.after 不允许 self-link（"${l.id}"）`);
        if (!sourceIds.has(p.target)) {
          throw err('INVALID_INPUT', `plan.links.after 引用目标 "${p.target}" 不在 plan.sources 中（未绑定 revision）`);
        }
      }
    }
    return plan;
  }

  if (kind === 'merge-topic') {
    checkPlanSources(plan.sources, { min: MERGE_SOURCES_MIN, max: MERGE_SOURCES_MAX });
    const t = plan.topic;
    if (!isPlainObject(t)) throw err('INVALID_INPUT', 'plan.topic 必须是对象');
    const tKeys = Object.keys(t);
    if (tKeys.length !== 7
        || !tKeys.every((k) => ['key', 'expectedRevision', 'before', 'after', 'title', 'summary', 'updated'].includes(k))) {
      throw err('INVALID_INPUT', 'plan.topic 只允许恰好 key/expectedRevision/before/after/title/summary/updated 七个键');
    }
    if (typeof t.key !== 'string' || t.key.length === 0) {
      throw err('INVALID_INPUT', 'plan.topic.key 必须是非空字符串（topic key 规则由 service 层校验）');
    }
    assertEncodableUtf8(t.key, 'plan.topic.key');
    checkPlanString(t.expectedRevision, 'topic.expectedRevision', { min: 1, max: 16384 });
    if (typeof t.before !== 'string' || typeof t.after !== 'string') {
      throw err('INVALID_INPUT', 'plan.topic.before/after 必须是字符串');
    }
    assertEncodableUtf8(t.before, 'plan.topic.before');
    assertEncodableUtf8(t.after, 'plan.topic.after');
    if (!t.after.startsWith(t.before)) {
      throw err('INVALID_INPUT', 'plan.topic.after 必须以 before 为前缀（append-only，保留原正文）');
    }
    if (t.after.length === t.before.length) {
      throw err('INVALID_INPUT', 'plan.topic.after 与 before 完全相同（拒绝无变化）');
    }
    if (!t.after.includes(SOURCES_BLOCK_OPEN) || !t.after.includes(SOURCES_BLOCK_CLOSE)) {
      throw err('INVALID_INPUT', 'plan.topic.after 缺少 shiori-p3-sources 源保全块起止标记');
    }
    // 类型先行（主审 L-5）：非字符串 metadata 必须得到 INVALID_INPUT，
    // 不允许 .length/.includes 触发裸 TypeError；边界与 K validatePlanTopic 对齐
    checkPlanString(t.title, 'topic.title', { min: 1 });
    checkPlanString(t.summary, 'topic.summary', { min: 0, max: 60 });
    if (t.summary.includes('\n') || t.summary.includes('\r')) {
      throw err('INVALID_INPUT', 'plan.topic.summary 不得含换行');
    }
    checkPlanString(t.updated, 'topic.updated', { min: 1 });
    return plan;
  }

  // thin-core：完整形状校验（仅草案；executeRound 一律拒绝执行）
  const c = plan.core;
  if (!isPlainObject(c)) throw err('INVALID_INPUT', 'plan.core 必须是对象');
  const cKeys = Object.keys(c);
  if (cKeys.length !== 2 || !cKeys.every((k) => k === 'before' || k === 'after')) {
    throw err('INVALID_INPUT', 'plan.core 只允许恰好 before/after 两个键');
  }
  if (typeof c.before !== 'string' || typeof c.after !== 'string') {
    throw err('INVALID_INPUT', 'plan.core.before/after 必须是字符串');
  }
  checkPlanSources(plan.sources, { min: 1, max: LINK_SOURCES_MAX });
  return plan;
}

/**
 * 源保全块记录投影（与 K buildDraft/projectRecordForBlock 逐字节一致）：
 * 仅这十个字段；triggers/entities/links 保持卡上原数组顺序，
 * 规范排序只作用于源记录的 id（契约 §3/§5）。
 */
function projectCardForSourcesBlock(card) {
  return {
    id: card.id,
    scopeId: card.scopeId,
    revision: card.revision,
    title: card.title,
    summary: card.summary,
    content: card.content,
    triggers: [...card.triggers],
    entities: [...card.entities],
    links: card.links.map((l) => ({ target: l.target, rel: l.rel })),
    vitality: card.vitality,
  };
}

/**
 * 源保全块：K 契约输出形状 = 按源 id 升序的十字段记录数组（不是 id 键 map；
 * 主审 L-1 裁定数组为准，K 不改数组）。块内是精确真实卡快照，是数据不是指令。
 */
function buildSourcesBlock(cards) {
  const records = [...cards]
    .sort((a, b) => byCodepoint(a.id, b.id))
    .map(projectCardForSourcesBlock);
  return SOURCES_BLOCK_OPEN + stable(records) + SOURCES_BLOCK_CLOSE;
}

// ---------------------------------------------------------------------------
// createOrganizerExecutor
// ---------------------------------------------------------------------------

/**
 * 打开受审整理执行器。
 *
 * @param {object} params
 * @param {string} params.root      显式绝对数据根（topics 与 sparks 共用同一根：
 *                                  <root>/scopes/... 与 <root>/sparks/...）
 * @param {string} params.scopeId   绑定 scope；所有读写只发生在此 scope
 * @param {function} params.authorize 宿主授权判定函数，缺失拒绝；
 *                                    每次 executeRound（含重试）与 merge 退休前
 *                                    都会被调用，必须严格返回 === true
 * @param {object} [params.budgets] P5：可信自定义预算（validateConfig 形状）；
 *                                  缺省沿用默认配置。禁止调用方借预算绕闸——
 *                                  预算仍经 validateConfig 整体校验后才进入执行。
 */
export async function createOrganizerExecutor(params) {
  if (!isPlainObject(params)) {
    throw err('INVALID_INPUT', 'createOrganizerExecutor 参数必须是 {root,scopeId,authorize[,budgets]} 对象');
  }
  const keys = Object.keys(params);
  const baseKeys = ['root', 'scopeId', 'authorize'];
  const hasBudgets = keys.includes('budgets');
  if (keys.length !== (hasBudgets ? 4 : 3)
    || !baseKeys.every((k) => keys.includes(k))
    || (hasBudgets && params.budgets !== undefined && !isPlainObject(params.budgets))) {
    throw err('INVALID_INPUT', 'createOrganizerExecutor 只接受恰好 root/scopeId/authorize（可选 budgets）参数');
  }
  const { root, scopeId, authorize } = params;
  if (typeof root !== 'string' || root.trim() === '' || !path.isAbsolute(root)) {
    throw err('INVALID_INPUT', 'root 必须显式提供且是绝对路径', { root });
  }
  validateScopeId(scopeId);
  if (typeof authorize !== 'function') {
    throw err('INVALID_INPUT', 'authorize 必须是函数（宿主授权判定；缺失即拒绝创建）');
  }

  let config;
  try {
    config = hasBudgets && params.budgets !== undefined ? validateConfig(params.budgets) : validateConfig({});
  } catch (e) {
    throw err('INVALID_INPUT', `budgets 校验失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const fileStore = await createFileStore({
    root, activeScopeId: scopeId, config, policy: evaluateMutation, renderL1,
  });
  const service = await createShioriService({ root, activeScopeId: scopeId, config });
  const sparkStore = await openSparkStore({ root, scopeId });

  let closed = false;
  const ensureOpen = () => {
    if (closed) throw err('INVALID_STATE', 'organizer executor 已 close，不能继续使用');
  };

  /** 每 executeRound 开头的统一授权判定。 */
  const demandApproval = async ({ approval, planDigest, plan, operationId, stage }) => {
    if (!isPlainObject(approval)) {
      throw err('APPROVAL_REQUIRED', 'approval 必须显式提供 {actor,planDigest}', { stage, operationId });
    }
    const aKeys = Object.keys(approval);
    if (aKeys.length !== 2 || !Object.hasOwn(approval, 'actor') || !Object.hasOwn(approval, 'planDigest')) {
      throw err('APPROVAL_REQUIRED', 'approval 只允许恰好 actor/planDigest 两个键', { stage, operationId });
    }
    if (!APPROVAL_ACTORS.has(approval.actor)) {
      throw err('APPROVAL_REQUIRED', `approval.actor 未知（只允许 ${[...APPROVAL_ACTORS].join(' / ')}）`, {
        stage, operationId, actor: approval.actor,
      });
    }
    if (approval.planDigest !== planDigest) {
      throw err('APPROVAL_REQUIRED', 'approval.planDigest 与 plan 实际摘要不一致（批准必须绑定内容）', {
        stage, operationId, expected: planDigest,
      });
    }
    const granted = await authorize({
      approval: structuredClone(approval),
      planDigest,
      plan: structuredClone(plan),
      operationId,
    });
    if (granted !== true) {
      throw err('APPROVAL_REQUIRED', 'authorize 判定未通过（必须严格返回 === true）', {
        stage, operationId, actor: approval.actor,
      });
    }
  };

  async function executeLinkRound({ plan, planDigest, operationId }) {
    // bind 已在 executeRound 主流程完成（同 round 身份账）；
    // applyOrganizeLinks 内部原子校验全部 sources/before 边/target 约束。
    const receipt = await sparkStore.applyOrganizeLinks(plan, {
      operationId: deriveStageOperationId(scopeId, operationId, 'ln'),
    });
    return {
      status: 'completed',
      operationId,
      planDigest,
      kind: 'link',
      changedItems: receipt.changedItems,
      updatedCards: structuredClone(receipt.updated),
    };
  }

  async function executeMergeRound({ plan, planDigest, operationId, approval }) {
    const topicSubOperationId = deriveStageOperationId(scopeId, operationId, 'mt');
    const retireSubOperationId = deriveStageOperationId(scopeId, operationId, 'rt');

    // 1) topic 提交永远凭稳定 mt 子 operationId 走既有 service journal
    //    （主审 L-6/L-7）：storage.commit 的同 operationId 幂等早退严格先于
    //    generation/live CAS/policy——
    //    - 本 round 已提交过（含重启后、topic 其后被外部编辑/覆盖）：直接
    //      返回首次提交回执，零写、不重复 append、不受 live 状态影响；
    //    - 本 round 从未提交：走 live token CAS。正文即使被无关操作写成与
    //      plan.after 逐字节相同，generation/revision token 也已前进 →
    //      REVISION_CONFLICT，绝不把别人的写入冒领成本 round 的提交；
    //      metadata-only 外部改动同样在 token CAS 处失败。
    //    mutate 抛错 ⟹ 本 round 的 mt 从未持久提交（提交过的同 payload 只会
    //    幂等早退成功，不可能再抛 CAS 错），topicCommitted 如实记 false。
    try {
      await service.mutate({
        operationId: topicSubOperationId,
        changes: [{
          kind: 'topic',
          key: plan.topic.key,
          expectedRevision: plan.topic.expectedRevision,
          topic: {
            title: plan.topic.title,
            summary: plan.topic.summary,
            updated: plan.topic.updated,
          },
          text: plan.topic.after,
        }],
      });
    } catch (e) {
      e.phase = 'topic-commit';
      e.topicCommitted = false;
      e.topicKey = plan.topic.key;
      e.topicSubOperationId = topicSubOperationId;
      // 首跑目标缺失时给出明确归因（此时本 round 必未提交，探测无歧义）
      if (e.code === 'REVISION_CONFLICT') {
        try {
          await service.readTopic(plan.topic.key);
        } catch (probe) {
          if (probe.code === 'NOT_FOUND') {
            throw err('INVALID_INPUT', `merge 目标 topic "${plan.topic.key}" 不存在（当前只更新已存在 topic，不创建）`, {
              phase: 'topic-precheck', topicCommitted: false,
              key: plan.topic.key, reason: e.message,
            });
          }
        }
      }
      throw e;
    }

    // 2) 退休前二次授权（锁外判定；每次重试——含完成收据重放——仍重新
    //    authorize，随后锁内核验）
    try {
      await demandApproval({ approval, planDigest, plan, operationId, stage: 'before-retire' });
    } catch (e) {
      e.phase = e.phase ?? 'before-retire';
      e.topicCommitted = true;
      e.topicKey = plan.topic.key;
      e.topicSubOperationId = topicSubOperationId;
      throw e;
    }

    // 3) 锁序统一 topic root → sparks：锁内重读全部源卡（不沿用锁外快照），
    //    按源卡持久状态分两路，再 retireMerged（内部再取 sparks 子树锁 +
    //    幂等重放先于源 CAS）。
    let retireReceipt;
    try {
      retireReceipt = await fileStore.withLock(async () => {
        const expectedRevisionOf = new Map(plan.sources.map((s) => [s.id, s.revision]));
        const cards = [];
        for (const s of plan.sources) {
          cards.push(await sparkStore.read(s.id));
        }
        const allActive = cards.every((c) => c.state === 'active' && c.revision === expectedRevisionOf.get(c.id));

        if (allActive) {
          // 新退休工作（首跑，或「topic 已提交、退休未做」的半完成恢复）：
          // 锁内重读 topic，scope 与正文必须仍与 plan.after 一致——外部
          // 覆盖 → REVISION_CONFLICT，宁可保留重复也不丢源。
          const fresh = await fileStore.readTopic(plan.topic.key); // 同 root 锁内重入
          if (fresh.scopeId !== scopeId) {
            throw err('INVALID_STATE', `锁内重读 topic "${plan.topic.key}" 的 scope "${fresh.scopeId}" 与执行器 scope 不一致，拒绝退休`, {
              phase: 'sources-retire', topicCommitted: true, key: plan.topic.key, topicScopeId: fresh.scopeId,
            });
          }
          if (fresh.body !== plan.topic.after) {
            throw err('REVISION_CONFLICT', `锁内重读 topic "${plan.topic.key}" 正文与 plan.after 不一致（已被外部覆盖），拒绝退休`, {
              phase: 'sources-retire', topicCommitted: true, key: plan.topic.key,
            });
          }
          const block = buildSourcesBlock(cards);
          if (!plan.topic.after.includes(block)) {
            throw err('INVALID_STATE', `topic "${plan.topic.key}" 的源保全块与当前源卡快照不一致，拒绝退休`, {
              phase: 'sources-retire', topicCommitted: true, key: plan.topic.key,
            });
          }
          return sparkStore.retireMerged(plan.sources, {
            topic: {
              key: plan.topic.key,
              scopeId: fresh.scopeId,
              revision: fresh.revision,
              bodyHash: sha256Buffer(Buffer.from(fresh.body, 'utf8')),
            },
            operationId: retireSubOperationId,
          });
        }

        // 历史收据重放（本 round 已完成）：全部 merged 且 mergedInto 四键
        // 指针与 plan 派生期望一致（key/scope 匹配、bodyHash=sha256(plan.
        // after)、revision 为 64hex 且全卡一致）。不读 live topic、不做
        // body/scope 的 live 核验——完成收据不因 topic 后续被外部编辑而
        // 丢失（主审 L-7）。用卡上指针重建首次退休指纹：retireMerged 内部
        // 同 operationId 幂等重放先于源 CAS，指纹命中 → 返回首次结果、
        // 零写、不重写外部 topic、不再次退休；若 rt 账实亡（ops 无记录），
        // live 校验在「仅 active 可退休」处 fail-closed。
        const planBodyHash = sha256Buffer(Buffer.from(plan.topic.after, 'utf8'));
        const reference = cards[0].mergedInto;
        const referenceOk = isPlainObject(reference)
          && Object.keys(reference).length === 4
          && reference.key === plan.topic.key
          && reference.scopeId === scopeId
          && /^[0-9a-f]{64}$/.test(reference.revision)
          && reference.bodyHash === planBodyHash;
        const allMergedHere = referenceOk && cards.every((c) => c.state === 'merged'
          && isPlainObject(c.mergedInto)
          && Object.keys(c.mergedInto).length === 4
          && c.mergedInto.key === reference.key
          && c.mergedInto.scopeId === reference.scopeId
          && c.mergedInto.revision === reference.revision
          && c.mergedInto.bodyHash === reference.bodyHash);
        if (!allMergedHere) {
          throw err('INVALID_STATE', 'merge 源卡状态与 plan 不一致（部分退休/被外部改动/指针不匹配），拒绝退休', {
            phase: 'sources-retire', topicCommitted: true, key: plan.topic.key,
            states: cards.map((c) => ({ id: c.id, state: c.state, revision: c.revision })),
          });
        }
        return sparkStore.retireMerged(plan.sources, {
          topic: {
            key: reference.key,
            scopeId: reference.scopeId,
            revision: reference.revision,
            bodyHash: reference.bodyHash,
          },
          operationId: retireSubOperationId,
        });
      });
    } catch (e) {
      if (e.phase === undefined) {
        e.phase = 'sources-retire';
        e.topicCommitted = true;
        e.topicKey = plan.topic.key;
        e.topicSubOperationId = topicSubOperationId;
      }
      throw e;
    }
    return {
      status: 'completed',
      operationId,
      planDigest,
      kind: 'merge-topic',
      changedItems: plan.sources.length + 1,
      topic: {
        key: retireReceipt.topic.key,
        scopeId: retireReceipt.topic.scopeId,
        revision: retireReceipt.topic.revision,
        bodyHash: retireReceipt.topic.bodyHash,
        operationId: topicSubOperationId,
      },
      retiredCards: structuredClone(retireReceipt.retired),
    };
  }

  return Object.freeze({
    /**
     * 执行一轮：一次只接受一个 plan，写入量 <=20（link 每被改源计 1；
     * merge-topic 每退休源 + topic 计 1），不得拆子轮绕过。
     * 失败抛带 code 异常；merge 若 topic 已提交会附 phase/topicCommitted 阶段信息。
     */
    async executeRound(args) {
      ensureOpen();
      if (!isPlainObject(args)) throw err('INVALID_INPUT', 'executeRound 参数必须是 {plan,approval,operationId} 对象');
      const keys = Object.keys(args);
      if (keys.length !== 3 || !keys.every((k) => k === 'plan' || k === 'approval' || k === 'operationId')) {
        throw err('INVALID_INPUT', 'executeRound 只接受恰好 plan/approval/operationId 三个键');
      }
      // 首个 await 前完整冻结轮次身份（主审 L-3）：operationId / approval /
      // plan 全部同步固化，之后所有授权阶段、派生子 id、bind 与结果都只用
      // 冻结值。调用方在 authorize 挂起期间改写原 args（含嵌套值）无法
      // 改变本轮绑定的内容与身份；单个 Object.freeze 不足以隔离可变引用。
      const operationId = args.operationId;
      validateOperationId(operationId);
      const approvalArg = args.approval;
      if (!isPlainObject(approvalArg)) {
        throw err('APPROVAL_REQUIRED', 'approval 必须显式提供 {actor,planDigest}', { stage: 'prepare', operationId });
      }
      const aKeys = Object.keys(approvalArg);
      if (aKeys.length !== 2 || !Object.hasOwn(approvalArg, 'actor') || !Object.hasOwn(approvalArg, 'planDigest')) {
        throw err('APPROVAL_REQUIRED', 'approval 只允许恰好 actor/planDigest 两个键', { stage: 'prepare', operationId });
      }
      const approval = { actor: approvalArg.actor, planDigest: approvalArg.planDigest };
      let plan;
      try {
        plan = structuredClone(args.plan); // 跨 await 隔离调用方可变引用（含嵌套值）
      } catch {
        throw err('INVALID_INPUT', 'plan 含不可结构克隆的值（拒绝执行）', { operationId });
      }
      validateRoundPlan(plan, scopeId);
      const planDigest = digestPlan(plan);

      if (plan.kind === 'thin-core') {
        throw err('UNSUPPORTED', 'thin-core 仅草案（changedItems=0），受审执行器一律拒绝执行', {
          phase: 'rejected', topicCommitted: false, candidateId: plan.candidateId,
        });
      }

      await demandApproval({ approval, planDigest, plan, operationId, stage: 'round' });

      await sparkStore.bindOrganizeRound(plan, {
        operationId: deriveStageOperationId(scopeId, operationId, 'bd'),
      });

      if (plan.kind === 'link') {
        return executeLinkRound({ plan, planDigest, operationId });
      }
      return executeMergeRound({ plan, planDigest, operationId, approval });
    },

    /** 关闭执行器（幂等）；关闭 sparkStore，此后 executeRound → INVALID_STATE。 */
    close() {
      if (closed) return;
      closed = true;
      sparkStore.close();
    },
  });
}
