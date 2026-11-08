/** Minimal A/B/C service. No home/profile defaults; no host activation. */
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { validateConfig, validateKey, renderL1, evaluateMutation } from '../core/index.mjs';
import { createFileStore } from '../storage/index.mjs';
import { isCanonicalIso, isIsoDateOrTimestamp } from '../storage/fsutil.mjs';

const PREFIX = 'shiori-r1.';
const guards = new AsyncLocalStorage();
const hash = text => createHash('sha256').update(text).digest('hex');
// A5/P2-5 威胁模型核实结论（2026-11-08）：token 确实会到达不可信面（memory_read
// 把含 projectionHash 的 readCoreView token 交给模型；剥掉该字段 + 无密钥 SHA-256
// 重签可绕过「渲染视图未变」乐观锁），绕过路径真实可达。
// 本次判定不动摘要算法，理由：requirement 建议的「进程级随机 HMAC 密钥」与既有
// 跨进程 durable replay 契约直接冲突——acceptance 矩阵 global-fallback case 要求
// 同 operationId + 原 token 跨真实重启重放回执一致（src/acceptance/
// global-fallback-child.mjs），进程密钥会使重放必败（已实测）。换 per-root 持久化
// 密钥属新设计（数据根新增密钥文件），超出本单「最小改动」授权，留待专项决策。
// 保留的兜底：摘要解析做严格形状校验 + timingSafeEqual，剥字段重签依然只能伪造
// 出「与 readCore token 等价」的合法形态——该形态本就是 checkSources 认可的输入，
// 剥离攻击的实际增益收敛为「跳过渲染视图新鲜度检查」，被 sourceRevision 磁盘
// 真值 CAS 与预算策略二次兜底。
const stable = value => JSON.stringify(value, function (_key, v) {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v;
});
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function record(v, name) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('INVALID_INPUT', name + ' must be an object');
}
function text(v, name) {
  if (typeof v !== 'string' || !v.isWellFormed()) fail('INVALID_INPUT', name + ' must be lossless UTF-8 text');
  return v;
}
function noScope(v) {
  if ('scope' in v || 'scopeId' in v || 'activeScopeId' in v) fail('INVALID_INPUT', 'scope is factory-only');
}
function encode(data) {
  const body = Buffer.from(stable(data)).toString('base64url');
  return PREFIX + body + '.' + hash(body);
}
function decode(token) {
  if (typeof token !== 'string' || token.length > 16384 || !token.startsWith(PREFIX)) fail('INVALID_INPUT', 'expected service revision token');
  const [body, digest, excess] = token.slice(PREFIX.length).split('.');
  // 摘要必须是精确 64 位小写 hex（A5 兜底硬化）：Buffer.from 的 hex 解码会静默
  // 截断非法尾字符，不先做形状校验的话尾巴会被当成原摘要放行。
  if (excess !== undefined || !isHash(digest)) fail('INVALID_INPUT', 'damaged revision token');
  const expected = Buffer.from(hash(body), 'hex');
  const got = Buffer.from(digest, 'hex');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    fail('INVALID_INPUT', 'damaged revision token');
  }
  try { return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { fail('INVALID_INPUT', 'invalid revision token'); }
}
const isHash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);

/** personaAdapter: independent read()/commit(request) with its own durable CAS/idempotency. */
export async function createShioriService({ root, activeScopeId, config = {}, personaAdapter, now = () => new Date() } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('INVALID_INPUT', 'explicit absolute root is required');
  if (typeof activeScopeId !== 'string' || !activeScopeId) fail('INVALID_INPUT', 'trusted activeScopeId is required');
  if (personaAdapter !== undefined && (typeof personaAdapter?.read !== 'function' || typeof personaAdapter?.commit !== 'function')) {
    fail('INVALID_INPUT', 'personaAdapter requires read and commit');
  }
  const validated = validateConfig(config);
  const store = await createFileStore({ root, activeScopeId, config: validated, renderL1,
    policy: async args => {
      // B checks its durable operationId replay BEFORE policy. Thus a committed replay
      // still works with the old token, without a second service journal/cache.
      await guards.getStore()?.();
      return evaluateMutation(args);
    },
  });
  if (typeof store.withLock !== 'function') fail('UNSUPPORTED', 'storage coordinator withLock is required');
  const rootId = hash(store.rootReal);
  function timestamp() {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('INVALID_STATE', 'clock must return a valid Date');
    return value.toISOString();
  }
  function tokenFor(kind, item, generation, issuedAt, projectionHash = null) {
    const sourceRevision = item?.revision ?? null;
    const sourceScope = item?.scopeId ?? activeScopeId;
    return encode({ v: 1, rootId, activeScopeId, kind, key: kind === 'topic' ? item.key : null,
      sourceScope, sourceRevision, targetRevision: sourceScope === activeScopeId ? sourceRevision : null,
      generation, issuedAt, projectionHash,
      // archivedAt 进入 token meta：append/rewrite 等 payload 不带归档字段的写路径
      // 靠它继承现有归档标记（undefined 在 JSON 编码时省略 = 未归档）。
      meta: kind === 'topic' ? { title: item.title, summary: item.summary, updated: item.updated, archivedAt: item.archivedAt } : null });
  }
  function parseToken(value, kind, key) {
    const t = decode(value);
    record(t, 'revision token');
    if (t.v !== 1 || t.rootId !== rootId || t.activeScopeId !== activeScopeId || t.kind !== kind || t.key !== (key ?? null)) {
      fail('REVISION_CONFLICT', 'revision token belongs to another root/scope/target');
    }
    if (![activeScopeId, 'global'].includes(t.sourceScope)
      || !(t.sourceRevision === null || isHash(t.sourceRevision))
      || t.targetRevision !== (t.sourceScope === activeScopeId ? t.sourceRevision : null)
      || !Number.isInteger(t.generation) || t.generation < 0
      || typeof t.issuedAt !== 'string' || !Number.isFinite(Date.parse(t.issuedAt))
      || !(t.projectionHash === null || isHash(t.projectionHash))) {
      fail('INVALID_INPUT', 'invalid revision token fields');
    }
    if (kind === 'topic') {
      record(t.meta, 'token metadata');
      text(t.meta.title, 'title'); text(t.meta.summary, 'summary'); text(t.meta.updated, 'updated');
      // 归档标记可选（旧版 token 无此字段）；有值时必须是规范 UTC ISO 串（A1/P2-1）。
      if (t.meta.archivedAt !== undefined && !isCanonicalIso(t.meta.archivedAt)) {
        fail('INVALID_INPUT', 'archivedAt must be a canonical UTC ISO 8601 string '
          + '(e.g. "2026-11-07T00:00:00.000Z")');
      }
    }
    return t;
  }
  async function current(kind, key) {
    if (kind === 'core') return store.readCore();
    try { return await store.readTopic(key); }
    catch (e) { if (e.code === 'NOT_FOUND') return null; throw e; }
  }
  async function checkSources(tokens) {
    for (const t of tokens) {
      const item = await current(t.kind, t.key);
      const revision = item?.revision ?? null;
      const scope = item?.scopeId ?? activeScopeId;
      if (revision !== t.sourceRevision || scope !== t.sourceScope) fail('REVISION_CONFLICT', 'visible source changed since read');
      if (t.projectionHash !== null) {
        const s = await store.snapshot();
        if (hash(renderL1({ coreText: s.core.text, topics: s.topics }).text) !== t.projectionHash) {
          fail('REVISION_CONFLICT', 'rendered core view changed since read');
        }
      }
      if (t.kind === 'topic' && item && (item.title !== t.meta.title || item.summary !== t.meta.summary || item.updated !== t.meta.updated
        || (item.archivedAt ?? null) !== (t.meta.archivedAt ?? null))) {
        fail('REVISION_CONFLICT', 'topic metadata does not match revision token');
      }
      const target = scope === activeScopeId ? revision : null;
      if (target !== t.targetRevision) fail('REVISION_CONFLICT', 'active target changed since read');
    }
  }
  async function readCore() {
    return store.withLock(async () => {
      const s = await store.snapshot();
      return { ...s.core, revision: tokenFor('core', s.core, s.generation, timestamp()) };
    });
  }
  async function readCoreView() {
    return store.withLock(async () => {
      const s = await store.snapshot();
      // Index is only derived here and in B's full candidate budget; never persisted.
      const rendered = renderL1({ coreText: s.core.text, topics: s.topics }).text;
      // body = 磁盘上的 core 正文（不含派生索引）。面板编辑必须写回 body，
      // 否则会把渲染出来的索引一起固化进 core（core_write 不剥离索引）。
      return { text: rendered,
        body: s.core.text,
        revision: tokenFor('core', s.core, s.generation, timestamp(), hash(rendered)), scopeId: s.core.scopeId };
    });
  }
  async function readTopic(key) {
    validateKey(key);
    return store.withLock(async () => {
      const s = await store.snapshot();
      const item = await store.readTopic(key);
      return { ...item, revision: tokenFor('topic', item, s.generation, timestamp()) };
    });
  }
  async function listTopics() {
    return store.withLock(async () => {
      const s = await store.snapshot(); const at = timestamp();
      // 归档标记供面板第二批接线（L3 页归档徽章/排序）使用：
      // archived 布尔 + 原始 archivedAt（缺省 = 未归档，字段省略）。
      return s.topics.map(item => ({ ...item,
        archived: typeof item.archivedAt === 'string' && item.archivedAt.length > 0,
        revision: tokenFor('topic', item, s.generation, at) }));
    });
  }
  async function search(query) {
    text(query, 'query');
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) fail('INVALID_INPUT', 'query must not be empty');
    // 搜索范围默认包含已归档 topic（冷搜），但归档结果只回 key/title/summary
    // 摘要级信息：state 标 'archived'、score 置 0、排在未归档结果之后，绝不返回正文；
    // 要看全文用 memory_read(key)。与 spark 冷卡 searchArchived 的 includeArchived
    // 语义无关，spark 行为不受影响。
    const active = [];
    const archived = [];
    for (const t of await listTopics()) {
      const score = words.filter(w => (t.key + ' ' + t.title + ' ' + t.summary + ' ' + t.body).toLowerCase().includes(w)).length;
      if (!score) continue;
      if (t.archived) {
        archived.push({ key: t.key, title: t.title, summary: t.summary, scopeId: t.scopeId, score: 0, state: 'archived' });
      } else {
        active.push({ key: t.key, title: t.title, summary: t.summary, scopeId: t.scopeId, score });
      }
    }
    active.sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    archived.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return [...active, ...archived];
  }
  async function readPersona() {
    return personaAdapter ? personaAdapter.read() : { name: null, text: null };
  }
  async function mutate(request) {
    record(request, 'request'); noScope(request);
    if (!Array.isArray(request.changes) || !request.changes.length) fail('INVALID_INPUT', 'changes must be nonempty');
    const input = structuredClone(request); // freeze identity across awaits/caller mutation
    for (const c of input.changes) { record(c, 'change'); noScope(c); }
    const personas = input.changes.filter(c => c.kind === 'persona');
    if (personas.length) {
      if (!personaAdapter) fail('UNSUPPORTED', 'soul_update requires an explicit independent personaAdapter');
      if (input.changes.length !== 1) fail('UNSUPPORTED', 'persona and memory cannot form a cross-adapter atomic batch');
      const c = personas[0]; text(c.text, 'persona text');
      if (!('expectedRevision' in c)) fail('INVALID_INPUT', 'expectedRevision is required');
      if (!c.text.length || c.text.length > validated.persona.maxChars) fail('INVALID_INPUT', 'persona length outside configured limit');
      return personaAdapter.commit(input);
    }
    // All normalization is deterministic from the caller request/token. In particular,
    // no fresh now()/generation is introduced on a retry of the same operationId.

    const tokens = [];
    const changes = input.changes.map(c => {
      if (!['core', 'topic'].includes(c.kind)) fail('INVALID_INPUT', 'unsupported change kind');
      if (!('expectedRevision' in c)) fail('INVALID_INPUT', 'expectedRevision is required');
      if (c.kind === 'topic') validateKey(c.key);
      const token = typeof c.expectedRevision === 'string' && c.expectedRevision.startsWith(PREFIX)
        ? parseToken(c.expectedRevision, c.kind, c.kind === 'topic' ? c.key : null) : null;
      if (token) tokens.push(token);
      // P0 edits existing topics only (service revision token required); P5 adds
      // topic creation: kind 'topic' with expectedRevision null (store enforces the
      // new-file CAS) and explicit topic metadata. The full candidate budget
      // (derived index growth) is still evaluated by the store policy.
      const isTopicCreate = c.kind === 'topic' && c.expectedRevision === null;
      if (!token && !isTopicCreate
        && (c.kind !== 'core' || !(c.expectedRevision === null || isHash(c.expectedRevision)))) {
        fail('INVALID_INPUT', 'topic writes require a service revision token (or null for creation)');
      }
      const base = { kind: c.kind, expectedRevision: token ? token.targetRevision : c.expectedRevision };
      if (c.kind === 'core') return { ...base, text: text(c.text, 'core text') };
      record(c.topic, 'topic metadata'); noScope(c.topic);
      if (Object.keys(c.topic).some(k => !['title', 'summary', 'updated', 'archivedAt'].includes(k))) {
        fail('INVALID_INPUT', 'topic metadata accepts title/summary/updated/archivedAt only');
      }
      // archivedAt：undefined/null 合法；字符串必须是规范 UTC ISO 串（A1/P2-1）。
      if (c.topic.archivedAt !== undefined && c.topic.archivedAt !== null) {
        const value = text(c.topic.archivedAt, 'archivedAt');
        if (!isCanonicalIso(value)) {
          fail('INVALID_INPUT', 'archivedAt must be a canonical UTC ISO 8601 string '
            + '(e.g. "2026-11-07T00:00:00.000Z"), or null to clear the archive mark');
        }
      }
      // updated 写入校验（A3/P2-3）：调用方显式提供的 updated 必须是 ISO 8601
      // 形态（完整规范 UTC 时间戳或 date-only），与 storage 层同口径；
      // token 继承路径（issuedAt 由 timestamp() 生成）不受影响。
      if (c.topic.updated !== undefined && !isIsoDateOrTimestamp(text(c.topic.updated, 'updated'))) {
        fail('INVALID_INPUT', 'updated must be an ISO 8601 timestamp '
          + '(e.g. "2026-11-07T00:00:00.000Z" or "2026-11-07")');
      }
      if (token?.meta.updated === 'legacy-unknown') {
        // 防御分支：legacy 裸 md（缺 front-matter）在 storage 加载时已直接抛错，
        // 正常流程造不出这种 token；保留显式拒绝以防伪造 revision token。
        fail('UNSUPPORTED', 'legacy topic 拒写：缺少 front-matter，属非法数据（请补全 front-matter 或重建专题）');
      }
      if (isTopicCreate && !c.topic.title) fail('INVALID_INPUT', 'topic creation requires explicit topic.title');
      if (isTopicCreate && !c.topic.summary) fail('INVALID_INPUT', 'topic creation requires explicit topic.summary');
      return { ...base, key: c.key, topic: {
        title: text(c.topic.title ?? token?.meta.title, 'title'),
        summary: text(c.topic.summary ?? token?.meta.summary, 'summary'),
        updated: text(c.topic.updated ?? token?.issuedAt, 'updated'), body: text(c.text, 'topic body'),
        // 归档语义：payload 未带（undefined）→ 继承 token 里的现有标记（append/rewrite
        // 不许静默取消归档；创建时无 token → 未归档）；显式 null → 清除（存储层空串 =
        // 省略该字段）；字符串 → 原样写入归档时间（已在上方校验）。
        archivedAt: c.topic.archivedAt === undefined ? token?.meta.archivedAt
          : c.topic.archivedAt === null ? '' : c.topic.archivedAt,
      } };
    });
    const generations = new Set(tokens.map(t => t.generation));
    if (generations.size > 1) fail('REVISION_CONFLICT', 'batch tokens must come from one generation');
    return store.withLock(async () => {
      // Keep the operation identity stable for raw null/SHA retries. Resource CAS
      // still runs under this lock; only caller/token generations join the request.
      const expectedGeneration = input.expectedGeneration ?? tokens[0]?.generation;
      // Coordinator read and source-CAS occur under the SAME B per-root lock.
      // B itself owns active-file CAS, durable idempotency, journal and full budget.
      const guard = async () => {
        await checkSources(tokens);
        for (const c of input.changes) {
          if (c.kind === 'core' && !(typeof c.expectedRevision === 'string' && c.expectedRevision.startsWith(PREFIX))) {
            const item = await store.readCore();
            if (item.revision !== c.expectedRevision || (item.revision !== null && item.scopeId !== activeScopeId)) {
              fail('REVISION_CONFLICT', 'raw revision is not the active core; read a service revision token');
            }
          }
        }
      };
      const result = await guards.run(guard, () => store.commit({ operationId: input.operationId, expectedGeneration, changes }));
      // C writeReceipt reads changes[0].scope, not B's source fallback scope.
      return { ...result, changes: result.changes.map(c => Object.fromEntries(
        Object.entries({ ...c, scope: activeScopeId }).filter(([, value]) => value !== undefined),
      )) };
    });
  }
  return Object.freeze({ readPersona, readCore, readCoreView, readTopic, listTopics, search, mutate });
}
