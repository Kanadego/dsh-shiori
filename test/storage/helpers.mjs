// 测试辅助：契约等价 stub、夹具构造、子进程工具。
// stub 语义严格按 CONTRACTS.md §A/§B 文字实现；合并后由真实 A 模块替换。

import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const INDEX_HEADER = '## 主题记忆索引 / Topic memory index';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 等价 A.renderL1 的 stub（UTF16 = text.length）。 */
export function stubRenderL1({ coreText, topics }) {
  const list = [...topics].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let indexText = '';
  if (list.length > 0) {
    const lines = list.map((t) => `- ${t.key} [${t.scopeId}] — ${t.summary}`);
    indexText = `${INDEX_HEADER}\n${lines.join('\n')}`;
  }
  const text = [coreText, indexText].filter((s) => s !== '').join('\n\n');
  return { text, chars: text.length, bytes: Buffer.byteLength(text, 'utf8'), indexText };
}

/** 等价 A.evaluateMutation 的 stub（预算规则见 CONTRACTS.md §A）。 */
export function stubEvaluateMutation({ currentText, candidateText, config }) {
  const { hardCapChars, softRatio, hardRatio } = config.core;
  const softAt = Math.floor(hardCapChars * softRatio);
  const hardAt = Math.floor(hardCapChars * hardRatio);
  const current = currentText.length;
  const candidate = candidateText.length;

  let allowed; let level; let reason;
  if (current > hardCapChars) {
    allowed = candidate < current;
    level = 'repair';
    reason = allowed ? '超限修复：净减少放行' : '超限状态下仅允许净减少';
  } else if (current >= hardAt) {
    allowed = candidate <= current;
    level = 'hard-gate';
    reason = allowed ? '增长闸门内：禁止净增长' : '增长闸门：禁止净增长，请先下沉';
  } else {
    allowed = candidate <= hardCapChars;
    level = candidate >= hardAt ? 'crossing' : 'ok';
    reason = allowed
      ? (level === 'crossing' ? '首次跨入增长闸门，允许且提醒' : '预算内')
      : '候选完整渲染超过绝对硬顶';
  }
  return {
    allowed,
    promotable: allowed && candidate <= hardCapChars,
    reason,
    level,
    currentChars: current,
    candidateChars: candidate,
    softAt,
    hardAt,
  };
}

export const TEST_CONFIG = Object.freeze({
  core: { targetChars: 8000, hardCapChars: 10000, softRatio: 0.75, hardRatio: 0.9, cacheLockFallback: false },
  persona: { maxChars: 12000 },
  spark: { maxChars: 600, inlineMaxChars: 100, maxCards: 5, seedCount: 3, linkCount: 2 },
});

/** 每个测试独立的临时 root（node:test 结束时自动清理）。 */
export async function makeTmpRoot(t, prefix = 'shiori-b-') {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix + randomBytes(4).toString('hex')));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });
  return dir;
}

export function makeStoreOptions(overrides = {}) {
  return {
    root: overrides.root,
    activeScopeId: overrides.activeScopeId ?? 'amber',
    policy: overrides.policy ?? stubEvaluateMutation,
    renderL1: overrides.renderL1 ?? stubRenderL1,
    config: overrides.config ?? TEST_CONFIG,
    ...overrides,
  };
}

/** 直接在磁盘放置 core.md（夹具，不走 store）。 */
export async function putCore(root, scopeId, text) {
  const dir = path.join(root, 'scopes', scopeId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'core.md'), Buffer.from(text, 'utf8'));
}

export function topicObject(overrides = {}) {
  return {
    title: overrides.title ?? '示例专题',
    summary: overrides.summary ?? '示例摘要',
    updated: overrides.updated ?? '2026-10-24T00:00:00.000Z',
    body: overrides.body ?? '正文内容',
    ...overrides,
  };
}

/** 拼一个符合严格 front-matter 格式的 topic 文件文本（供 raw text 用例）。 */
export function topicRawText({ key, scopeId, ...rest }) {
  const meta = {
    key,
    title: rest.title ?? '示例专题',
    summary: rest.summary ?? '示例摘要',
    updated: rest.updated ?? '2026-10-24T00:00:00.000Z',
    scopeId,
  };
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) lines.push(`${k}: ${JSON.stringify(v)}`);
  lines.push('---');
  return lines.join('\n') + '\n' + (rest.body ?? '正文');
}

const binDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin');

/**
 * 派生测试子进程。args 传给 bin/<script>.mjs；
 * 返回 {promise, result} —— result 在进程退出后填充 {code,signal,stdout,stderr}。
 */
export function spawnNode(script, args, { timeoutMs = 30_000 } = {}) {
  const child = spawn(process.execPath, [path.join(binDir, script), ...args], {
    cwd: os.tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, promise };
}

/** 等待文件出现（子进程就绪/结果文件）。 */
export async function waitForFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fsp.access(file);
      return true;
    } catch {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

export async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}
