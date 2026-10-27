// 锁持有子进程：持锁指定毫秒后退出，用于跨进程互斥验证。
// 用法：node lock-holder.mjs --root <abs> --ready <file> --hold-ms <n>

import { promises as fsp } from 'node:fs';
import { withLock } from '../../../src/storage/lockfile.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const root = arg('root');
const ready = arg('ready');
const holdMs = Number(arg('hold-ms') ?? 1500);

await withLock(root, { timeoutMs: 10_000 }, async () => {
  await fsp.writeFile(ready, 'held');
  await new Promise((r) => setTimeout(r, holdMs));
});
process.exit(0);
