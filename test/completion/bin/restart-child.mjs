/**
 * 测试子进程：以真实独立进程打开完成状态并观察事件（用于跨进程重启/崩溃注入测试）。
 * 用法：
 *   node restart-child.mjs --root <dir> --scope <id> --events <json文件> [--crash]
 * 行为：打开 openCompletionState → createCompressProbe(restore) → 逐条 observe →
 *   向 stdout 打印一行 JSON 结果 → --crash 则不 close 直接 exit(7)（制造锁残留），
 *   否则 flush+close 后 exit(0)。
 * 只用合成数据；不读写真实记忆。
 */
import { readFile } from "node:fs/promises";
import { openCompletionState } from "../../../src/completion/index.mjs";
import { createCompressProbe } from "../../../src/host/compress-probe.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const root = arg("root");
const scopeId = arg("scope");
const eventsFile = arg("events");
const crash = process.argv.includes("--crash");

const handle = await openCompletionState({ root, scopeId });
const probe = createCompressProbe({ sink: handle.sink });
await probe.restore();

const events = JSON.parse(await readFile(eventsFile, "utf8"));
const results = [];
for (const event of events) {
  results.push(await probe.observe(event));
}

process.stdout.write(`${JSON.stringify({ ok: true, epoch: probe.epoch(), results })}\n`);
// 确保结果行已刷出（崩溃模式也要先看到结果再死）
await new Promise((resolve) => setImmediate(resolve));

if (crash) {
  // 故意不 close：模拟进程崩溃，锁与可能的目录项残留由父进程测试接管逻辑。
  process.exit(7);
}
await handle.flush();
await handle.close();
process.exit(0);
