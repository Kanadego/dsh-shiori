// Shiori P0-STORAGE · 文件仓库核心实现
//
// 磁盘布局（root 内，全部由本模块创建）：
//   scopes/global/core.md | topics/<key>.md     共享 scope（只被 active=global 时写入）
//   scopes/<scopeId>/core.md | topics/<key>.md  私有 scope（写只落这里）
//   journal/<operationId>.json                  持久 prepare/commit/recovery 日志
//   state/current.json                          {generation} 提交代指针（可由 journal 推导重建）
//   staging/<operationId>/                      提交暂存（after/backup 字节）
//   .shiori-lock                                跨进程文件锁
//
// 提交协议（全程持锁）：
//   CAS 校验 → 注入 policy 预算评估（完整可见快照渲染）→ staging 写入+fsync
//   → journal(prepared) → 目标备份 → journal(committing) → 逐文件 rename（rename 前
//   复核哈希，发现手改冲突立即中止回滚）→ journal(committed) → generation 指针 → 清理
//
// 恢复（recover 或任意操作前的自动补账，均持锁）：
//   - prepared 且无应用痕迹 → 干净中止，目标保持 before 态；
//   - committing/部分应用 → 从 staging 补完 rename，补完成功才推进 generation；
//   - 目标出现第三方新内容（哈希既非 before 也非 after）→ 冲突：绝不覆盖新内容，
//     已应用的条目从备份回滚，operation 记为 aborted-with-conflicts；
//   - journal(committed) 但指针落后 → 推进指针。
//   原则：宁可暂留重复内容，绝不丢失已存在的更新内容。

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import {
  invalidInput, revisionConflict, budgetRejected, invalidState, notFound,
} from './errors.mjs';
import {
  sha256Buffer, readFileOrNull, hashFileOrNull, writeFileSynced,
  atomicReplace, fsyncDirBestEffort, sleep,
} from './fsutil.mjs';
import {
  validateKey, validateScopeId, validateOperationId,
  assertNoCaseCollision, assertNoEscapeViaSymlink, assertRealInsideRoot, joinUnder,
} from './paths.mjs';
import { withLock } from './lockfile.mjs';
import { serializeTopicFile, parseTopicFile, parseLegacyMarkdown } from './frontmatter.mjs';
import {
  computePayloadHash, readJournal, saveJournal, listJournals, newJournal,
} from './journal.mjs';
import { assertEncodableUtf8, decodeUtf8Strict } from './fsutil.mjs';

const FAULT_POINTS = new Set(['prepare', 'backup', 'first-rename', 'renames', 'marker']);

function crashNow() {
  // 故障注入：模拟进程在持久阶段被强杀（仅当 factory 显式传入 faultAfter 时可达）
  process.kill(process.pid, 'SIGKILL');
}

function isHex64(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

export async function createFileStore({
  root, activeScopeId, policy, renderL1, config,
  lockTimeoutMs = 10_000, retryMs = 50, faultAfter = null,
}) {
  if (typeof root !== 'string' || root.trim() === '') {
    throw invalidInput('root 必须显式提供（无隐式 home 默认值）');
  }
  if (!path.isAbsolute(root)) {
    throw invalidInput('root 必须是绝对路径', { root });
  }
  validateScopeId(activeScopeId ?? '');
  if (typeof policy !== 'function') {
    throw invalidInput('policy（A.evaluateMutation 或等价 stub）必须显式注入');
  }
  if (typeof renderL1 !== 'function') {
    throw invalidInput('renderL1（A.renderL1 或等价 stub）必须显式注入');
  }
  validateConfigShape(config);
  if (faultAfter !== null && !FAULT_POINTS.has(faultAfter)) {
    throw invalidInput(`faultAfter 只支持 ${[...FAULT_POINTS].join('/')}`, { faultAfter });
  }

  await fsp.mkdir(root, { recursive: true });
  const rootReal = await fsp.realpath(path.resolve(root));

  // R4：任何创建/读写之前，先验证已存在的管理路径没有越根 symlink/junction。
  // scopes/<active>、topics、journal、state、staging 都可能被预先植入链接。
  const managedRels = [
    ['scopes'],
    ['scopes', 'global'],
    ['scopes', 'global', 'topics'],
    ['scopes', activeScopeId],
    ['scopes', activeScopeId, 'topics'],
    ['journal'],
    ['state'],
    ['staging'],
  ];
  for (const rel of managedRels) {
    const p = joinUnder(rootReal, ...rel);
    try {
      await fsp.access(p);
    } catch {
      continue; // 不存在：将由下方 mkdir 以普通目录创建
    }
    await assertNoEscapeViaSymlink(rootReal, p);
  }
  // scopes/ 目录大小写互斥：Windows 下 scopes/Amber 会与既有 scopes/amber 合并
  const scopesDir = joinUnder(rootReal, 'scopes');
  try {
    await fsp.access(scopesDir);
    await assertNoCaseCollision(scopesDir, activeScopeId);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const dirs = {
    globalScope: joinUnder(rootReal, 'scopes', 'global'),
    activeScope: joinUnder(rootReal, 'scopes', activeScopeId),
    journal: joinUnder(rootReal, 'journal'),
    state: joinUnder(rootReal, 'state'),
    staging: joinUnder(rootReal, 'staging'),
  };
  for (const dir of [dirs.globalScope, dirs.activeScope, dirs.journal, dirs.state, dirs.staging]) {
    await fsp.mkdir(dir, { recursive: true });
  }
  await fsp.mkdir(path.join(dirs.globalScope, 'topics'), { recursive: true });
  await fsp.mkdir(path.join(dirs.activeScope, 'topics'), { recursive: true });

  // 创建后 realpath 复核（防 TOCTOU / mkdir 跟随竞态链接）
  for (const rel of managedRels) {
    const p = joinUnder(rootReal, ...rel);
    // eslint-disable-next-line no-await-in-loop
    const real = await fsp.realpath(p);
    assertRealInsideRoot(rootReal, real);
  }

  return new FileStore({
    rootReal, activeScopeId, policy, renderL1, config,
    lockTimeoutMs, retryMs, faultAfter, dirs,
  });
}

function validateConfigShape(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw invalidInput('config 必须是已校验的完整配置对象');
  }
  const core = config.core;
  if (!core || typeof core !== 'object') {
    throw invalidInput('config.core 缺失（B 只做结构健全性检查，业务校验属 A）');
  }
  for (const field of ['targetChars', 'hardCapChars', 'softRatio', 'hardRatio']) {
    const v = core[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw invalidInput(`config.core.${field} 必须为正数`, { got: v });
    }
  }
}

class FileStore {
  constructor({ rootReal, activeScopeId, policy, renderL1, config, lockTimeoutMs, retryMs, faultAfter, dirs }) {
    this.rootReal = rootReal;
    this.activeScopeId = activeScopeId;
    this.policy = policy;
    this.renderL1 = renderL1;
    this.config = config;
    this.lockTimeoutMs = lockTimeoutMs;
    this.retryMs = retryMs;
    this.faultAfter = faultAfter;
    this.dirs = dirs;
    /** @type {{shadow: Array, legacy: Array}} 最近一次扫描的兼容/异常清单 */
    this.lastScan = { shadow: [], legacy: [] };
  }

  // ---------- 路径 ----------

  coreFile(scopeId) {
    return joinUnder(this.rootReal, 'scopes', scopeId, 'core.md');
  }

  topicsDir(scopeId) {
    return joinUnder(this.rootReal, 'scopes', scopeId, 'topics');
  }

  topicFile(scopeId, key) {
    return joinUnder(this.rootReal, 'scopes', scopeId, 'topics', `${key}.md`);
  }

  pointerFile() {
    return joinUnder(this.rootReal, 'state', 'current.json');
  }

  // ---------- 锁 ----------

  withLock(fn) {
    return withLock(this.rootReal, { timeoutMs: this.lockTimeoutMs, retryMs: this.retryMs }, fn);
  }

  // ---------- 读取 ----------

  /**
   * 当前可见快照：core（含 active→global fallback）+ 可见 topics（active 优先去重、
   * 稳定 key 排序）。必须在锁内调用。旧格式/不可解析文件记入 lastScan，不中断列举。
   */
  async #effectiveView() {
    const shadow = [];
    const legacy = [];

    // core：active 不存在才 fallback global；空文件不触发 fallback。
    // 磁盘字节严格 UTF-8 解码：损坏文件显式 INVALID_STATE，不静默替换（R6）。
    const activeCoreFile = this.coreFile(this.activeScopeId);
    await assertNoEscapeViaSymlink(this.rootReal, activeCoreFile);
    const activeBytes = await readFileOrNull(activeCoreFile);
    let core;
    if (activeBytes !== null) {
      core = {
        text: decodeUtf8Strict(activeBytes, `core.md(${this.activeScopeId})`),
        revision: sha256Buffer(activeBytes),
        scopeId: this.activeScopeId,
      };
    } else if (this.activeScopeId !== 'global') {
      const globalCoreFile = this.coreFile('global');
      await assertNoEscapeViaSymlink(this.rootReal, globalCoreFile);
      const globalBytes = await readFileOrNull(globalCoreFile);
      if (globalBytes !== null) {
        core = {
          text: decodeUtf8Strict(globalBytes, 'core.md(global)'),
          revision: sha256Buffer(globalBytes),
          scopeId: 'global',
        };
      } else {
        core = { text: '', revision: null, scopeId: this.activeScopeId };
      }
    } else {
      core = { text: '', revision: null, scopeId: 'global' };
    }

    // topics：global 先扫、active 后扫（同 key 由 active 覆盖 global）
    const scopesToList = this.activeScopeId === 'global'
      ? ['global'] : ['global', this.activeScopeId];
    const byKey = new Map();
    for (const scopeId of scopesToList) {
      const dir = this.topicsDir(scopeId);
      await assertNoEscapeViaSymlink(this.rootReal, dir);
      let names;
      try {
        names = await fsp.readdir(dir);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw err;
      }
      for (const name of names) {
        if (!name.endsWith('.md')) {
          shadow.push({ file: path.join(dir, name), reason: '非 .md 文件，已跳过' });
          continue;
        }
        const stem = name.slice(0, -3);
        const file = path.join(dir, name);
        let key;
        try {
          key = validateKey(stem);
        } catch (err) {
          shadow.push({ file, reason: `文件名不符合 key 规范: ${err.message}` });
          continue;
        }
        // 单个 topic 文件也可能是越根链接：越界的进影子报告并跳过（R4）
        try {
          await assertNoEscapeViaSymlink(this.rootReal, file);
        } catch (err) {
          shadow.push({ file, reason: `越根 symlink/junction: ${err.message}` });
          continue;
        }
        const raw = await readFileOrNull(file);
        if (raw === null) continue;
        const revision = sha256Buffer(raw);
        let parsed;
        try {
          parsed = parseTopicFile(raw); // 内部严格解码（R6）
        } catch (err) {
          shadow.push({ file, reason: `front-matter 无法解析: ${err.message}` });
          continue;
        }
        if (!parsed.hasFrontMatter) {
          // 旧 Markdown 兼容只读（R8）：DTO 必须能通过真实 A 的 validateTopic——
          // updated 用稳定哨兵串；推导摘要 >60 时影子索引按 60 截断显示，
          // 全文保留在 body 与 legacySummaryFull，正文与原文件不动，报告中声明非无损。
          const lp = parseLegacyMarkdown(raw);
          const fullSummary = lp.summary;
          const summaryOver = fullSummary.length > 60;
          const topic = {
            key,
            title: lp.title || key,
            summary: summaryOver ? fullSummary.slice(0, 60) : fullSummary,
            scopeId,
            revision,
            updated: 'legacy-unknown',
            body: lp.body,
          };
          if (summaryOver) topic.legacySummaryFull = fullSummary;
          byKey.set(key, topic);
          legacy.push({
            file, key, scopeId,
            reason: summaryOver
              ? '旧格式：推导摘要超 60 UTF16，影子索引按规则截断显示（正文未动，非无损迁移）'
              : '无 front-matter 的旧 Markdown，只读兼容',
          });
          continue;
        }
        const { meta, body } = parsed;
        if (meta.key !== key) {
          shadow.push({ file, reason: `front-matter key "${meta.key}" 与文件名 "${key}" 不一致，已跳过` });
          continue;
        }
        if (meta.scopeId !== scopeId) {
          shadow.push({ file, reason: `front-matter scopeId "${meta.scopeId}" 与所在 scope "${scopeId}" 不一致，已跳过` });
          continue;
        }
        if (meta.summary.length > 60) {
          shadow.push({ file, reason: `summary 超 60 UTF16（${meta.summary.length}），手改无效，已跳过` });
          continue;
        }
        if (meta.summary.includes('\n') || meta.summary.includes('\r')) {
          shadow.push({ file, reason: 'summary 含换行（会破坏索引行结构），已跳过' });
          continue;
        }
        byKey.set(key, {
          key, title: meta.title, summary: meta.summary, scopeId,
          revision, updated: meta.updated, body,
        });
      }
    }
    const topics = [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    this.lastScan = { shadow, legacy };
    return { core, topics };
  }

  async readCore() {
    return this.withLock(async () => {
      await this.#reconcileLocked();
      const { core } = await this.#effectiveView();
      return { text: core.text, revision: core.revision, scopeId: core.scopeId };
    });
  }

  async listTopics() {
    return this.withLock(async () => {
      await this.#reconcileLocked();
      const { topics } = await this.#effectiveView();
      return topics;
    });
  }

  async readTopic(key) {
    validateKey(key);
    return this.withLock(async () => {
      await this.#reconcileLocked();
      for (const scopeId of this.activeScopeId === 'global' ? ['global'] : [this.activeScopeId, 'global']) {
        const file = this.topicFile(scopeId, key);
        await assertNoEscapeViaSymlink(this.rootReal, file);
        const raw = await readFileOrNull(file);
        if (raw === null) continue;
        const parsed = parseTopicFile(raw); // 内部严格解码（R6）
        if (!parsed.hasFrontMatter) {
          const lp = parseLegacyMarkdown(raw);
          const fullSummary = lp.summary;
          const summaryOver = fullSummary.length > 60;
          const topic = {
            key, title: lp.title || key,
            summary: summaryOver ? fullSummary.slice(0, 60) : fullSummary,
            scopeId,
            revision: sha256Buffer(raw),
            updated: 'legacy-unknown',
            body: lp.body,
          };
          if (summaryOver) topic.legacySummaryFull = fullSummary;
          return topic;
        }
        const { meta, body } = parsed;
        if (meta.key !== key) {
          throw invalidState(`topic "${key}" 的 front-matter key "${meta.key}" 与文件名不一致`, { file });
        }
        if (meta.scopeId !== scopeId) {
          throw invalidState(`topic "${key}" 的 front-matter scopeId "${meta.scopeId}" 与所在 scope 不一致`, { file });
        }
        if (meta.summary.length > 60) {
          throw invalidState(`topic "${key}" 的 summary 超 60 UTF16（手改无效）`, { file });
        }
        if (meta.summary.includes('\n') || meta.summary.includes('\r')) {
          throw invalidState(`topic "${key}" 的 summary 含换行（破坏索引行结构）`, { file });
        }
        return {
          key, title: meta.title, summary: meta.summary, scopeId,
          revision: sha256Buffer(raw), updated: meta.updated, body,
        };
      }
      throw notFound(`topic "${key}" 在可见 scope 中不存在`, { key, activeScopeId: this.activeScopeId });
    });
  }

  async snapshot() {
    return this.withLock(async () => {
      await this.#reconcileLocked();
      const generation = await this.#readGenerationLocked();
      const { core, topics } = await this.#effectiveView();
      return {
        generation,
        core: { text: core.text, revision: core.revision, scopeId: core.scopeId },
        topics,
      };
    });
  }

  async legacyReport() {
    return this.withLock(async () => {
      await this.#reconcileLocked();
      await this.#effectiveView();
      return { shadow: this.lastScan.shadow, legacy: this.lastScan.legacy };
    });
  }

  async diagnostics() {
    const generation = await this.withLock(async () => {
      await this.#reconcileLocked();
      return this.#readGenerationLocked();
    });
    const journals = await listJournals(this.rootReal);
    return {
      root: this.rootReal,
      activeScopeId: this.activeScopeId,
      generation,
      journalCount: journals.length,
      lastScan: this.lastScan,
      faultAfter: this.faultAfter,
    };
  }

  // ---------- generation 指针 ----------

  async #readGenerationLocked() {
    const raw = await readFileOrNull(this.pointerFile());
    if (raw !== null) {
      try {
        const p = JSON.parse(raw.toString('utf8'));
        if (Number.isInteger(p.generation) && p.generation >= 0) return p.generation;
      } catch { /* 损坏 → 推导 */ }
    }
    // 指针缺失/损坏：从 committed journal 推导并修复
    const journals = await listJournals(this.rootReal);
    let max = 0;
    for (const j of journals) {
      if (!j.corrupted && j.phase === 'committed' && Number.isInteger(j.generationAfter)) {
        max = Math.max(max, j.generationAfter);
      }
    }
    await this.#writeGenerationLocked(max, 'derived');
    return max;
  }

  async #writeGenerationLocked(generation, lastOperationId) {
    await atomicReplace(this.pointerFile(), Buffer.from(JSON.stringify({
      generation, lastOperationId, updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8'));
  }

  // ---------- 提交 ----------

  async commit({ operationId, expectedGeneration, changes }) {
    validateOperationId(operationId);
    if (expectedGeneration !== undefined && expectedGeneration !== null
        && (!Number.isInteger(expectedGeneration) || expectedGeneration < 0)) {
      throw invalidInput('expectedGeneration 必须是非负整数、null 或 undefined', { expectedGeneration });
    }
    if (!Array.isArray(changes) || changes.length === 0) {
      throw invalidInput('changes 必须是非空数组');
    }
    // R1：payload 身份包含可信 activeScopeId——同 root 不同 scope 的相同请求
    // 是不同操作，不得命中彼此的幂等结果
    const payloadHash = computePayloadHash({
      scopeId: this.activeScopeId, expectedGeneration, changes,
    });

    return this.withLock(async () => {
      const recoverReport = await this.#reconcileLocked();

      // R3：损坏/无法校验的 journal = 状态不明确，开放写入前显式阻塞
      const blocked = recoverReport.operations.filter((op) => String(op.action).startsWith('blocked-'));
      if (blocked.length > 0) {
        throw invalidState('存在损坏或无法校验的 journal，提交被阻止（状态不明确时不得无提示开放写入）', {
          blocked,
          hint: '人工核验磁盘状态后修复或移除对应 journal 文件，再重试',
        });
      }

      // 幂等：同 operationId 已有 journal
      const existing = await readJournal(this.rootReal, operationId);
      if (existing && !existing.corrupted) {
        if (existing.payloadHash !== payloadHash) {
          throw revisionConflict(
            `operationId "${operationId}" 已被不同 payload 使用（重放必须逐字段重复原调用；作用域也参与操作身份）`,
            { operationId, recordedPhase: existing.phase, recordedScopeId: existing.scopeId ?? null },
          );
        }
        if (existing.phase === 'committed') {
          return existing.result;
        }
        // aborted：允许同 payload 全新尝试（journal 将被覆盖重写）
      }

      const generation = await this.#readGenerationLocked();
      if (expectedGeneration !== undefined && expectedGeneration !== null
          && expectedGeneration !== generation) {
        throw revisionConflict('generation 已前进（expectedGeneration 与当前不一致）', {
          expectedGeneration, currentGeneration: generation,
        });
      }

      // ---- 解析每个 change 为计划条目（CAS 校验）----
      const seenTargets = new Set();
      /** @type {{change,index,kind,key?,file,buffer,beforeRevision,afterRevision,stagingFile,backupFile}[]} */
      const entries = [];
      let coreChangeCount = 0;
      for (let i = 0; i < changes.length; i += 1) {
        const change = changes[i];
        if (!change || typeof change !== 'object' || Array.isArray(change)) {
          throw invalidInput(`changes[${i}] 必须是对象`);
        }
        if (change.scopeId !== undefined) {
          throw invalidInput(`changes[${i}].scopeId 不允许出现在工具 payload（写只到 active scope）`);
        }
        if (change.kind !== 'core' && change.kind !== 'topic') {
          throw invalidInput(`changes[${i}].kind 只支持 "core" | "topic"`, { kind: change.kind });
        }
        if (change.kind === 'core') coreChangeCount += 1;
        if (coreChangeCount > 1) {
          throw invalidInput('一次提交最多一个 core 变更');
        }
        if (!('expectedRevision' in change)) {
          throw invalidInput(`changes[${i}].expectedRevision 必须显式提供（新文件为 null）`);
        }
        const exp = change.expectedRevision;
        if (exp !== null && !isHex64(exp)) {
          throw invalidInput(`changes[${i}].expectedRevision 必须是 null 或 64 位 hex`, { got: exp });
        }

        let file; let buffer; let key = undefined;
        if (change.kind === 'core') {
          if (typeof change.text !== 'string') {
            throw invalidInput(`changes[${i}].text（core 正文）必须是字符串`);
          }
          assertEncodableUtf8(change.text, `changes[${i}].text`);
          file = this.coreFile(this.activeScopeId);
          buffer = Buffer.from(change.text, 'utf8');
        } else {
          if (typeof change.key !== 'string') {
            throw invalidInput(`changes[${i}].key（topic）必须是字符串`);
          }
          key = validateKey(change.key);
          file = this.topicFile(this.activeScopeId, key);
          buffer = this.#buildTopicBuffer(i, key, change);
        }
        const targetId = `${change.kind}:${key ?? ''}`;
        if (seenTargets.has(targetId)) {
          throw invalidInput(`changes[${i}] 与同批其他变更重复（${targetId}）`);
        }
        seenTargets.add(targetId);
        await assertNoEscapeViaSymlink(this.rootReal, file);
        // 大小写别名碰撞先于 CAS 判定：Windows stat 会把 'ABC.md' 解析到已有
        // 'abc.md'，若先做 CAS 会误报 REVISION_CONFLICT 而非明确的碰撞（R9）
        if (change.kind === 'topic') {
          await assertNoCaseCollision(path.dirname(file), path.basename(file));
        }
        const current = await hashFileOrNull(file);
        if (current === null && exp !== null) {
          throw revisionConflict(`目标文件不存在但 expectedRevision 非 null`, {
            file, expectedRevision: exp, actualRevision: null,
          });
        }
        if (current !== null && exp === null) {
          throw revisionConflict('目标文件已存在但 expectedRevision 为 null（已有文件必须提供哈希）', {
            file, actualRevision: current,
          });
        }
        if (current !== null && exp !== null && current !== exp) {
          throw revisionConflict('revision CAS 失败：磁盘内容与期望哈希不一致（含手改检测）', {
            file, expectedRevision: exp, actualRevision: current,
          });
        }
        entries.push({
          change, index: i, kind: change.kind, key, file, buffer,
          beforeRevision: current, afterRevision: sha256Buffer(buffer),
          stagingFile: joinUnder(this.rootReal, 'staging', operationId, `after-${i}.bin`),
          backupFile: joinUnder(this.rootReal, 'staging', operationId, `backup-${i}.bin`),
        });
      }

      // ---- 预算：完整可见快照经注入渲染器生成 current/candidate 文本 ----
      const view = await this.#effectiveView();
      const currentRendered = this.renderL1({ coreText: view.core.text, topics: view.topics });
      if (!currentRendered || typeof currentRendered.text !== 'string') {
        throw invalidInput('renderL1 必须返回 {text,chars,bytes,indexText}');
      }
      const candidateCoreText = entries.some((e) => e.kind === 'core')
        ? entries.find((e) => e.kind === 'core').change.text
        : view.core.text;
      const topicMap = new Map(view.topics.map((t) => [t.key, t]));
      for (const e of entries) {
        if (e.kind !== 'topic') continue;
        const parsed = parseTopicFile(e.buffer);
        const meta = parsed.hasFrontMatter ? parsed.meta : null;
        topicMap.set(e.key, {
          key: e.key,
          title: meta ? meta.title : e.key,
          summary: meta ? meta.summary : '',
          scopeId: this.activeScopeId,
          revision: e.afterRevision,
          updated: meta ? meta.updated : null,
          body: parsed.hasFrontMatter ? parsed.body : e.buffer.toString('utf8'),
        });
      }
      const candidateTopics = [...topicMap.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const candidateRendered = this.renderL1({ coreText: candidateCoreText, topics: candidateTopics });
      if (!candidateRendered || typeof candidateRendered.text !== 'string') {
        throw invalidInput('renderL1 必须返回 {text,chars,bytes,indexText}');
      }

      const policyResult = await this.policy({
        currentText: currentRendered.text,
        candidateText: candidateRendered.text,
        config: this.config,
      });
      if (!policyResult || typeof policyResult.allowed !== 'boolean') {
        throw invalidInput('policy 必须返回含布尔 allowed 的结果');
      }
      const budget = {
        ...policyResult,
        currentChars: policyResult.currentChars ?? currentRendered.text.length,
        candidateChars: policyResult.candidateChars ?? candidateRendered.text.length,
      };
      if (policyResult.allowed !== true) {
        throw budgetRejected(`预算策略拒绝本次提交: ${policyResult.reason ?? '未提供原因'}`, {
          budget, recoverReport,
        });
      }

      // ---- staging + journal(prepared) ----
      const stagingDir = joinUnder(this.rootReal, 'staging', operationId);
      await fsp.mkdir(stagingDir, { recursive: true });
      for (const e of entries) {
        await writeFileSynced(e.stagingFile, e.buffer);
      }
      const journal = newJournal({
        operationId,
        scopeId: this.activeScopeId,
        payloadHash,
        generationBefore: generation,
        generationAfter: generation + 1,
        changes: entries.map((e) => ({
          index: e.index, kind: e.kind, key: e.key, file: e.file,
          stagingFile: e.stagingFile, backupFile: e.backupFile,
          beforeRevision: e.beforeRevision, afterRevision: e.afterRevision,
        })),
      });
      journal.budget = budget;
      await saveJournal(this.rootReal, journal);
      if (this.faultAfter === 'prepare') crashNow();

      // ---- 备份目标当前内容（回滚依据）----
      for (const e of entries) {
        if (e.beforeRevision === null) continue; // 新文件无备份
        const bytes = await readFileOrNull(e.file);
        if (bytes !== null) await writeFileSynced(e.backupFile, bytes);
      }
      if (this.faultAfter === 'backup') crashNow();

      journal.phase = 'committing';
      await saveJournal(this.rootReal, journal);

      // ---- 逐文件应用（rename 前复核，发现手改立即中止回滚）----
      const applied = [];
      for (const [n, e] of entries.entries()) {
        const cur = await hashFileOrNull(e.file);
        if (cur === e.afterRevision) { applied.push(e); continue; }
        if (cur !== e.beforeRevision) {
          await this.#abortMidCommit(journal, entries, applied, stagingDir, {
            index: e.index, file: e.file, expected: e.beforeRevision, observed: cur,
          });
        }
        await atomicReplace(e.file, e.buffer);
        await fsyncDirBestEffort(path.dirname(e.file));
        applied.push(e);
        if (n === 0 && this.faultAfter === 'first-rename') crashNow();
      }
      if (this.faultAfter === 'renames') crashNow();

      // ---- 提交标记 + 指针 + 清理 ----
      journal.phase = 'committed';
      journal.result = {
        operationId,
        generation: journal.generationAfter,
        changes: entries.map((e) => ({
          kind: e.kind, key: e.key,
          beforeRevision: e.beforeRevision, afterRevision: e.afterRevision,
        })),
        budget,
      };
      await saveJournal(this.rootReal, journal);
      if (this.faultAfter === 'marker') crashNow();

      await this.#writeGenerationLocked(journal.generationAfter, operationId);
      await fsp.rm(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return journal.result;
    });
  }

  /** 结构化 topic / 裸文本 topic → 目标文件字节（写入前完成全部格式校验）。 */
  #buildTopicBuffer(index, key, change) {
    const hasText = 'text' in change && change.text !== undefined;
    const hasTopic = 'topic' in change && change.topic !== undefined;
    if (hasText && hasTopic) {
      throw invalidInput(`changes[${index}] 的 text 与 topic 只能二选一`);
    }
    if (hasText) {
      if (typeof change.text !== 'string') {
        throw invalidInput(`changes[${index}].text 必须是字符串`);
      }
      assertEncodableUtf8(change.text, `changes[${index}].text`);
      const parsed = parseTopicFile(Buffer.from(change.text, 'utf8'));
      if (!parsed.hasFrontMatter) {
        throw invalidInput(`changes[${index}].text 必须带严格 front-matter（旧 Markdown 不能作为写入格式）`);
      }
      this.#validateTopicMeta(index, key, parsed.meta, change.text);
      return Buffer.from(change.text, 'utf8');
    }
    if (!hasTopic || !change.topic || typeof change.topic !== 'object' || Array.isArray(change.topic)) {
      throw invalidInput(`changes[${index}] 的 topic 变更需要提供 topic 对象或 text`);
    }
    const t = change.topic;
    if (t.key !== undefined && t.key !== key) {
      throw invalidInput(`changes[${index}].topic.key 与 change.key 不一致`, { topicKey: t.key, key });
    }
    if (t.scopeId !== undefined && t.scopeId !== this.activeScopeId) {
      throw invalidInput(`changes[${index}].topic.scopeId 不得指定其他 scope（写只到 active scope）`, {
        got: t.scopeId, activeScopeId: this.activeScopeId,
      });
    }
    const meta = {
      key,
      title: t.title,
      summary: t.summary,
      updated: t.updated,
      scopeId: this.activeScopeId,
    };
    this.#validateTopicMeta(index, key, meta, t);
    let extra;
    if (t.extra !== undefined) {
      if (!t.extra || typeof t.extra !== 'object' || Array.isArray(t.extra)) {
        throw invalidInput(`changes[${index}].topic.extra 必须是字符串映射对象`);
      }
      extra = {};
      for (const [k, v] of Object.entries(t.extra)) {
        if (typeof v !== 'string') throw invalidInput(`changes[${index}].topic.extra.${k} 必须是字符串`);
        extra[k] = v;
      }
    }
    const body = t.body === undefined ? '' : t.body;
    if (typeof body !== 'string') {
      throw invalidInput(`changes[${index}].topic.body 必须是字符串`);
    }
    return serializeTopicFile({ ...meta, extra }, body);
  }

  #validateTopicMeta(index, key, meta, source) {
    const where = `changes[${index}]`;
    for (const field of ['title', 'summary', 'updated']) {
      if (typeof meta[field] !== 'string') {
        throw invalidInput(`${where} 的 ${field} 必须是字符串`);
      }
      assertEncodableUtf8(meta[field], `${where}.${field}`);
    }
    if (meta.title.length === 0 || meta.title.length > 1000) {
      throw invalidInput(`${where} 的 title 必须为 1-1000 字符`);
    }
    // 与 A.validateTopic 一致：summary 允许空串，但 ≤60 且不得含换行（R7/R8）
    if (meta.summary.length > 60) {
      throw invalidInput(`${where} 的 summary 超 60 UTF16（${meta.summary.length}）`);
    }
    if (meta.summary.includes('\n') || meta.summary.includes('\r')) {
      throw invalidInput(`${where} 的 summary 不得含换行（会破坏索引行结构）`);
    }
    if (meta.updated.length === 0) {
      throw invalidInput(`${where} 的 updated 必须为非空字符串`);
    }
    if (meta.key !== key) {
      throw invalidInput(`${where} front-matter key 与 change.key 不一致`, { metaKey: meta.key, key });
    }
    // scopeId 以落盘 front-matter 为准直接校验（裸 text 的 meta 同样覆盖）：
    // 拒绝任何指向其他 scope 的写入（K/缺陷 7——此前仅校验 source 对象字段，
    // 裸 text 路径绕过了该检查）
    if (meta.scopeId !== this.activeScopeId) {
      throw invalidInput(`${where} front-matter scopeId "${meta.scopeId}" 不得指向其他 scope（写只到 ${this.activeScopeId}）`, {
        metaScopeId: meta.scopeId, activeScopeId: this.activeScopeId,
      });
    }
    if (source && typeof source === 'object' && source.scopeId !== undefined
        && source.scopeId !== this.activeScopeId) {
      throw invalidInput(`${where} scopeId 不得指定其他 scope`);
    }
  }

  /** 提交中途发现目标被第三方修改：回滚已应用条目，中止，不覆盖新内容。 */
  async #abortMidCommit(journal, entries, applied, stagingDir, conflict) {
    const rolledBack = [];
    for (const e of applied) {
      const cur = await hashFileOrNull(e.file);
      if (cur !== e.afterRevision) continue; // 已被第三方再改：不碰
      if (e.beforeRevision === null) {
        await fsp.unlink(e.file).catch(() => {});
        rolledBack.push({ index: e.index, action: 'removed-created' });
      } else {
        const backup = await readFileOrNull(e.backupFile);
        if (backup !== null && sha256Buffer(backup) === e.beforeRevision) {
          await atomicReplace(e.file, backup);
          rolledBack.push({ index: e.index, action: 'restored-backup' });
        } else {
          rolledBack.push({ index: e.index, action: 'kept-no-backup' });
        }
      }
    }
    journal.phase = 'aborted';
    journal.abortedReason = 'target-changed-during-commit';
    journal.conflicts = [conflict];
    journal.rolledBack = rolledBack;
    await saveJournal(this.rootReal, journal);
    // staging 保留（含 after 字节），供人工挽回；由 recover 报告指出
    throw revisionConflict('提交期间目标文件被外部修改，已回滚本次变更且不覆盖新内容', {
      operationId: journal.operationId,
      conflict,
      rolledBack,
      stagingKept: stagingDir,
    });
  }

  // ---------- 恢复 ----------

  /**
   * 补账（必须在锁内调用）：处理全部未完成 journal、清理孤儿 staging、推进指针。
   * 损坏/无法校验的 journal 记为 blocked：保留其 staging 证据，不当作无主垃圾。
   */
  async #reconcileLocked() {
    const report = { operations: [], orphansRemoved: [], pointerAdvanced: false };
    const journals = await listJournals(this.rootReal);
    const blockedStems = new Set();

    for (const j of journals) {
      if (j.corrupted) {
        // R3/J1：损坏（JSON 或协议形状）journal 的状态不明确，
        // staging（含备份证据）按可信文件 stem 保留，绝不当作无主垃圾清除
        const stem = j.stem ?? j.file.replace(/\.json$/, '');
        blockedStems.add(stem);
        let stagingKept = false;
        try {
          await fsp.access(path.join(this.dirs.staging, stem));
          stagingKept = true;
        } catch { /* 无 staging */ }
        report.operations.push({
          operationId: null, file: j.file, reason: j.reason,
          action: 'blocked-corrupted-journal', stagingKept,
        });
        continue;
      }
      if (j.phase !== 'prepared' && j.phase !== 'committing') continue;

      // R4：journal 内引用的路径必须与本模块从 (scopeId, kind, key, index)
      // 推导的权威路径一致，且不得越根；不一致视为不可校验事务并阻塞。
      const pathIssues = [];
      if (typeof j.scopeId !== 'string' || j.scopeId.length === 0) {
        pathIssues.push('journal 缺少可信 scopeId（旧版本日志，无法校验操作身份）');
      }
      const checked = [];
      if (pathIssues.length === 0) {
        for (let i = 0; i < j.changes.length; i += 1) {
          const entry = j.changes[i];
          try {
            const expectedFile = entry.kind === 'core'
              ? this.coreFile(j.scopeId)
              : this.topicFile(j.scopeId, validateKey(entry.key));
            const expectedStaging = joinUnder(this.rootReal, 'staging', j.operationId, `after-${i}.bin`);
            const expectedBackup = joinUnder(this.rootReal, 'staging', j.operationId, `backup-${i}.bin`);
            if (entry.file !== expectedFile || entry.stagingFile !== expectedStaging
                || entry.backupFile !== expectedBackup) {
              pathIssues.push(`changes[${i}] 路径与权威推导不一致`);
              continue;
            }
            await assertNoEscapeViaSymlink(this.rootReal, entry.file);
            checked.push(entry);
          } catch (err) {
            pathIssues.push(`changes[${i}]: ${err.message}`);
          }
        }
      }
      if (pathIssues.length > 0) {
        blockedStems.add(j.operationId);
        report.operations.push({
          operationId: j.operationId, phase: j.phase,
          action: 'blocked-invalid-journal', issues: pathIssues,
        });
        continue;
      }

      /** @type {{entry, state: 'applied'|'at-before'|'conflict', observed?}[]} */
      const decisions = [];
      for (const entry of checked) {
        // eslint-disable-next-line no-await-in-loop
        const cur = await hashFileOrNull(entry.file);
        if (cur === entry.afterRevision) {
          decisions.push({ entry, state: 'applied' });
        } else if ((entry.beforeRevision === null && cur === null) || cur === entry.beforeRevision) {
          decisions.push({ entry, state: 'at-before' });
        } else {
          decisions.push({ entry, state: 'conflict', observed: cur });
        }
      }
      const conflicts = decisions.filter((d) => d.state === 'conflict');
      const applied = decisions.filter((d) => d.state === 'applied');
      const atBefore = decisions.filter((d) => d.state === 'at-before');

      if (conflicts.length > 0) {
        // 第三方新内容在场：绝不覆盖；回滚我们已应用的条目
        const rolledBack = [];
        for (const d of applied) {
          rolledBack.push(await this.#rollbackEntry(d.entry));
        }
        j.phase = 'aborted';
        j.abortedReason = 'recovered-with-conflicts';
        j.conflicts = conflicts.map((c) => ({
          index: c.entry.index, file: c.entry.file, expected: c.entry.beforeRevision, observed: c.observed,
        }));
        j.rolledBack = rolledBack;
        await saveJournal(this.rootReal, j);
        report.operations.push({
          operationId: j.operationId, phase: j.phase, action: 'aborted-with-conflicts',
          conflicts: j.conflicts, rolledBack,
        });
        continue;
      }

      if (j.phase === 'prepared' && applied.length === 0) {
        j.phase = 'aborted';
        j.abortedReason = 'recovered-before-apply';
        await saveJournal(this.rootReal, j);
        await fsp.rm(path.join(this.rootReal, 'staging', j.operationId),
          { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
        report.operations.push({ operationId: j.operationId, phase: 'prepared', action: 'aborted-clean' });
        continue;
      }

      // 补完：at-before 且 staging 字节可用 → rename；之后全部 applied 才提交
      let completionFailed = false;
      for (const d of atBefore) {
        const staged = await readFileOrNull(d.entry.stagingFile);
        if (staged !== null && sha256Buffer(staged) === d.entry.afterRevision) {
          await atomicReplace(d.entry.file, staged);
          await fsyncDirBestEffort(path.dirname(d.entry.file));
          d.state = 'applied';
        } else {
          completionFailed = true;
          d.state = 'unrecoverable';
        }
      }

      const finalApplied = decisions.filter((d) => d.state === 'applied');
      if (!completionFailed && finalApplied.length === checked.length) {
        j.phase = 'committed';
        j.result = {
          operationId: j.operationId,
          generation: j.generationAfter,
          changes: j.changes.map((e) => ({
            kind: e.kind, key: e.key, beforeRevision: e.beforeRevision, afterRevision: e.afterRevision,
          })),
          budget: j.budget ?? null,
        };
        await saveJournal(this.rootReal, j);
        if ((await this.#readGenerationLocked()) < j.generationAfter) {
          await this.#writeGenerationLocked(j.generationAfter, j.operationId);
          report.pointerAdvanced = true;
        }
        await fsp.rm(path.join(this.rootReal, 'staging', j.operationId),
          { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
        report.operations.push({ operationId: j.operationId, phase: 'committing', action: 'completed' });
        continue;
      }

      // 无法补完：回滚已应用条目并中止
      const rolledBack = [];
      for (const d of finalApplied) {
        rolledBack.push(await this.#rollbackEntry(d.entry));
      }
      j.phase = 'aborted';
      j.abortedReason = completionFailed ? 'recovered-incomplete-staging' : 'recovered-mixed';
      j.rolledBack = rolledBack;
      await saveJournal(this.rootReal, j);
      report.operations.push({
        operationId: j.operationId, phase: j.phase, action: 'aborted-incomplete',
        rolledBack,
      });
    }

    // 指针与已提交 journal 对齐（崩溃落在 committed 标记之后、指针写入之前的情形）
    let maxCommitted = 0; let maxCommittedOp = null;
    for (const j of journals) {
      if (!j.corrupted && j.phase === 'committed' && Number.isInteger(j.generationAfter)
          && j.generationAfter > maxCommitted) {
        maxCommitted = j.generationAfter;
        maxCommittedOp = j.operationId;
      }
    }
    if (maxCommitted > 0 && (await this.#readGenerationLocked()) < maxCommitted) {
      await this.#writeGenerationLocked(maxCommitted, maxCommittedOp);
      report.pointerAdvanced = true;
    }

    // 孤儿 staging：没有对应未完成 journal 的暂存目录。
    // 例外（R3）：blocked（损坏/不可校验）与 aborted-with-conflicts / kept-no-backup
    // 的操作，staging 保留证据供人工挽回，不当作无主垃圾清除。
    const preserveStaging = new Set(blockedStems);
    for (const j of journals) {
      if (!j.corrupted && j.phase === 'aborted'
        && ((Array.isArray(j.conflicts) && j.conflicts.length > 0)
          || (Array.isArray(j.rolledBack) && j.rolledBack.some((r) => r.action === 'kept-no-backup')))) {
        preserveStaging.add(j.operationId);
      }
    }
    let stagingNames = [];
    try {
      stagingNames = await fsp.readdir(this.dirs.staging);
    } catch { /* 不存在 */ }
    const openOps = new Set(
      journals.filter((j) => !j.corrupted && (j.phase === 'prepared' || j.phase === 'committing'))
        .map((j) => j.operationId),
    );
    for (const name of stagingNames) {
      if (!openOps.has(name) && !preserveStaging.has(name)) {
        await fsp.rm(path.join(this.dirs.staging, name),
          { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
        report.orphansRemoved.push(name);
      }
    }
    return report;
  }

  /** 回滚单个已应用条目：优先备份恢复；新文件删除；无备份保留并报告。 */
  async #rollbackEntry(entry) {
    const cur = await hashFileOrNull(entry.file);
    if (cur !== entry.afterRevision) {
      return { index: entry.index, action: 'kept-externally-modified' };
    }
    if (entry.beforeRevision === null) {
      await fsp.unlink(entry.file).catch(() => {});
      return { index: entry.index, action: 'removed-created' };
    }
    const backup = await readFileOrNull(entry.backupFile);
    if (backup !== null && sha256Buffer(backup) === entry.beforeRevision) {
      await atomicReplace(entry.file, backup);
      return { index: entry.index, action: 'restored-backup' };
    }
    return { index: entry.index, action: 'kept-no-backup' };
  }

  async recover() {
    return this.withLock(async () => {
      const report = await this.#reconcileLocked();
      await this.#effectiveView();
      report.shadow = this.lastScan.shadow;
      report.legacy = this.lastScan.legacy;
      report.generation = await this.#readGenerationLocked();
      report.healthy = report.operations.every((op) => !String(op.action).includes('conflict')
        && !String(op.action).startsWith('blocked-'));
      return report;
    });
  }
}

// 便于外部按需小睡（测试辅助不经过此模块，避免污染公共面）
export { sleep };
