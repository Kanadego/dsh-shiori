// 锁持有子进程：持锁至多 hold-ms 毫秒后退出，用于跨进程互斥验证。
// 用法：node lock-holder.mjs --root <abs> --ready <file> --hold-ms <n> [--release <file>]
// C-fix 打回项 B：传 --release <file> 时轮询该文件，出现即提前释放退出——
// 父进程断言完 LOCK_BUSY 后立刻写该文件放行，用例耗时回到秒级，
// 不再用「等满 hold-ms」换稳定（hold-ms 只作为兜底 deadline）。

import { promises as fsp } from 'node:fs';
import { withLock } from '../../../src/storage/lockfile.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const root = arg('root');
const ready = arg('ready');
const holdMs = Number(arg('hold-ms') ?? 1500);
const release = arg('release');

await withLock(root, { timeoutMs: 10_000 }, async () => {
  await fsp.writeFile(ready, 'held');
  const deadline = Date.now() + holdMs;
  for (;;) {
    if (release !== undefined && await fsp.access(release).then(() => true, () => false)) break;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 10));
  }
});
process.exit(0);
