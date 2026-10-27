// 锁竞速子进程：等 barrier 后尝试 withLock 获取（用于死 pid 残留锁的并发接管竞速）。
// 用法：node lock-racer.mjs --root <abs> --name <n> --barrier <file> --ready <file>
//                 --result <file> --timeout <ms>
// 成功进入临界区者持有 200ms 后退出；失败写回错误码。

import { promises as fsp } from 'node:fs';
import { withLock } from '../../../src/storage/lockfile.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const root = arg('root');
const name = arg('name');
const barrier = arg('barrier');
const ready = arg('ready');
const resultFile = arg('result');
const timeoutMs = Number(arg('timeout') ?? 8000);

try {
  await fsp.writeFile(ready, 'ok');
  const deadline = Date.now() + 15_000;
  for (;;) {
    const hit = await fsp.access(barrier).then(() => true, () => false);
    if (hit || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  try {
    await withLock(root, { timeoutMs, retryMs: 5 }, async () => {
      const enterAt = Date.now();
      await fsp.writeFile(`${resultFile}.holder`, name);
      await new Promise((r) => setTimeout(r, 200));
      const leaveAt = Date.now();
      await fsp.writeFile(resultFile, JSON.stringify({ ok: true, enterAt, leaveAt }));
    });
  } catch (err) {
    await fsp.writeFile(resultFile, JSON.stringify({ ok: false, code: err.code }));
  }
  process.exit(0);
} catch (err) {
  await fsp.writeFile(resultFile, JSON.stringify({ ok: false, fatal: String(err?.stack ?? err) }));
  process.exit(1);
}
