/** Minimal A/B/C service. No home/profile defaults; no host activation. */
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { validateConfig, validateKey, renderL1, evaluateMutation } from '../core/index.mjs';
import { createFileStore } from '../storage/index.mjs';

const PREFIX = 'shiori-r1.';
const guards = new AsyncLocalStorage();
const hash = text => createHash('sha256').update(text).digest('hex');
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
  if (excess !== undefined || hash(body) !== digest) fail('INVALID_INPUT', 'damaged revision token');
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
      meta: kind === 'topic' ? { title: item.title, summary: item.summary, updated: item.updated } : null });
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
      if (t.kind === 'topic' && item && (item.title !== t.meta.title || item.summary !== t.meta.summary || item.updated !== t.meta.updated)) {
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
      return s.topics.map(item => ({ ...item, revision: tokenFor('topic', item, s.generation, at) }));
    });
  }
  async function search(query) {
    text(query, 'query');
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) fail('INVALID_INPUT', 'query must not be empty');
    return (await listTopics()).map(t => ({ key: t.key, title: t.title, summary: t.summary, scopeId: t.scopeId,
      score: words.filter(w => (t.key + ' ' + t.title + ' ' + t.summary + ' ' + t.body).toLowerCase().includes(w)).length }))
      .filter(t => t.score > 0).sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
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
      if (Object.keys(c.topic).some(k => !['title', 'summary', 'updated'].includes(k))) fail('INVALID_INPUT', 'topic metadata accepts title/summary/updated only');
      if (token?.meta.updated === 'legacy-unknown') fail('UNSUPPORTED', 'legacy topics remain read-only');
      if (isTopicCreate && !c.topic.title) fail('INVALID_INPUT', 'topic creation requires explicit topic.title');
      if (isTopicCreate && !c.topic.summary) fail('INVALID_INPUT', 'topic creation requires explicit topic.summary');
      return { ...base, key: c.key, topic: {
        title: text(c.topic.title ?? token?.meta.title, 'title'),
        summary: text(c.topic.summary ?? token?.meta.summary, 'summary'),
        updated: text(c.topic.updated ?? token?.issuedAt, 'updated'), body: text(c.text, 'topic body'),
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
