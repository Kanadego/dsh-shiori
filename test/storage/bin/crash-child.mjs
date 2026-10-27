// 故障注入子进程：在提交协议的指定持久阶段被 SIGKILL 强杀。
// 用法：node crash-child.mjs --root <abs> --fault <prepare|backup|first-rename|renames|marker>
//                 --plan <plan.json> --result <resultFile>
// plan.json: {operationId, expectedGeneration, changes, activeScopeId?}
// 若 fault 点触发，进程在 commit 内部被杀，不会写出 result 文件。

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
const fault = arg('fault');
const planFile = arg('plan');
const resultFile = arg('result');

const plan = JSON.parse(await fsp.readFile(planFile, 'utf8'));

try {
  const store = await createFileStore({
    root,
    activeScopeId: plan.activeScopeId ?? 'amber',
    policy: stubEvaluateMutation,
    renderL1: stubRenderL1,
    config: TEST_CONFIG,
    lockTimeoutMs: 20_000,
    faultAfter: fault,
  });
  try {
    const result = await store.commit({
      operationId: plan.operationId,
      expectedGeneration: plan.expectedGeneration,
      changes: plan.changes,
    });
    await fsp.writeFile(resultFile, JSON.stringify({ returned: true, result }));
  } catch (err) {
    await fsp.writeFile(resultFile, JSON.stringify({
      returned: false, code: err.code, message: err.message,
    }));
  }
  process.exit(0);
} catch (err) {
  await fsp.writeFile(resultFile, JSON.stringify({ returned: false, fatal: String(err?.stack ?? err) }));
  process.exit(1);
}
