// 跨进程竞速子进程：等 barrier 后与兄弟进程同时抢 CAS 提交。
// 用法：node racer.mjs --root <abs> --name <n> --barrier <file> --ready <file>
//                 --result <file> --expected-rev <hex|null>
// 初始 core 由父进程放好；子进程提交 core 正文 "from-<name>\n"。

import { promises as fsp } from 'node:fs';
import { createFileStore } from '../../../src/storage/index.mjs';
import {
  stubRenderL1, stubEvaluateMutation, TEST_CONFIG,
} from '../helpers.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const root = arg('root');
const name = arg('name');
const barrier = arg('barrier');
const ready = arg('ready');
const resultFile = arg('result');
const expectedRev = arg('expected-rev') === 'null' ? null : arg('expected-rev');

try {
  const store = await createFileStore({
    root,
    activeScopeId: 'amber',
    policy: stubEvaluateMutation,
    renderL1: stubRenderL1,
    config: TEST_CONFIG,
    lockTimeoutMs: 20_000,
  });
  await fsp.writeFile(ready, 'ok');
  const deadline = Date.now() + 15_000;
  for (;;) {
    const hit = await fsp.access(barrier).then(() => true, () => false);
    if (hit || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  try {
    const result = await store.commit({
      operationId: `race-${name}`,
      expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: expectedRev, text: `from-${name}\n` }],
    });
    await fsp.writeFile(resultFile, JSON.stringify({ ok: true, result }));
  } catch (err) {
    await fsp.writeFile(resultFile, JSON.stringify({
      ok: false, code: err.code, message: err.message,
    }));
  }
  process.exit(0);
} catch (err) {
  await fsp.writeFile(resultFile, JSON.stringify({ ok: false, fatal: String(err?.stack ?? err) }));
  process.exit(1);
}
