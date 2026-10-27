// Kill fixtures signal only at a known protocol boundary; never use random kill delays.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { withLock } from '../../../src/storage/lockfile.mjs';
const [root, mode] = process.argv.slice(2);
const guard = path.join(root, '.shiori-lock.guard');
const lock = path.join(root, '.shiori-lock');
async function freeze() {
  process.send({ mode });
  await new Promise(() => { setInterval(() => {}, 60_000); });
}
if (mode === 'guard-before-publish') {
  const original = fs.mkdir; fs.mkdir = async function(p, ...args) { const out = await original.call(this, p, ...args); if (p === guard) await freeze(); return out; };
} else if (mode === 'guard-after-publish') {
  const original = fs.link; fs.link = async function(from, to, ...args) { const out = await original.call(this, from, to, ...args); if (to === lock) await freeze(); return out; };
} else if (mode === 'guard-release') {
  let count = 0; const original = fs.mkdir; fs.mkdir = async function(p, ...args) { const out = await original.call(this, p, ...args); if (p === guard && ++count === 2) await freeze(); return out; };
}
await withLock(root, { timeoutMs: 2000, retryMs: 2 }, async () => { if (mode === 'fn') await freeze(); });
throw new Error('Kill fixture reached unexpected completion');
