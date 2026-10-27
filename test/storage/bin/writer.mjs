// 连续写入子进程：交替把 core 提交为 'A\n' / 'B\n'，供并发读一致性验证。
// 用法：node writer.mjs --root <abs> --result <file> --count <n>

import { promises as fsp } from 'node:fs';
import { createFileStore } from '../../../src/storage/index.mjs';
import { stubRenderL1, stubEvaluateMutation, TEST_CONFIG } from '../helpers.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const root = arg('root');
const resultFile = arg('result');
const count = Number(arg('count') ?? 30);

try {
  const store = await createFileStore({
    root,
    activeScopeId: 'amber',
    policy: stubEvaluateMutation,
    renderL1: stubRenderL1,
    config: TEST_CONFIG,
    lockTimeoutMs: 20_000,
  });
  let done = 0; let conflicts = 0;
  for (let i = 0; i < count; i += 1) {
    let ok = false;
    for (let attempt = 0; attempt < 100 && !ok; attempt += 1) {
      const snap = await store.snapshot();
      const target = snap.core.text === 'A\n' ? 'B\n' : 'A\n';
      try {
        // eslint-disable-next-line no-await-in-loop
        await store.commit({
          operationId: `w-${i}-${attempt}`,
          expectedGeneration: snap.generation,
          changes: [{ kind: 'core', expectedRevision: snap.core.revision, text: target }],
        });
        done += 1;
        ok = true;
      } catch (err) {
        if (err.code === 'REVISION_CONFLICT') { conflicts += 1; continue; }
        throw err;
      }
    }
    if (!ok) throw new Error(`writer 第 ${i} 次翻转在 100 次重试后仍未成功`);
  }
  await fsp.writeFile(resultFile, JSON.stringify({ done, conflicts }));
  process.exit(0);
} catch (err) {
  await fsp.writeFile(resultFile, JSON.stringify({ fatal: String(err?.stack ?? err) }));
  process.exit(1);
}
