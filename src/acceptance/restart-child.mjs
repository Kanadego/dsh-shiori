/**
 * Shiori P1-ACCEPTANCE — restart-dedup 跨进程子脚本（反馈 F2）。
 *
 * 由 runAcceptanceMatrix 的 restart-dedup case 以【独立 node 进程】执行：
 *   node restart-child.mjs <phase> <stateRoot> <scopeId> <outPath>
 *
 * phase=advance：打开 handle+runtime，派发一条 compress 完成事件（推进 epoch=1），
 *   flush/close 后进程退出 —— 模拟一次真实进程生命周期结束。
 * phase=replay ：【新进程】二次打开同一 root/scope，验证：
 *   restoredFromSink（先恢复持久状态再消费事件）→ 重放同事件不得推进（duplicate）
 *   → 新事件在恢复的 epoch 之上推进到 2。
 *
 * 组合的是【真实基线】createHostBridge/compress-probe/mapRawSessionEvent 与标明
 * synthetic 的宿主/落盘句柄（./synthetic.mjs）；输出写进 outPath 供父进程断言。
 * synthetic sink 无跨进程互斥 owner（E 的契约边界）——两个子进程顺序执行，不并发。
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createSyntheticCompletionFactory, createSyntheticRuntimeFactory } from "./synthetic.mjs";
import { mapRawSessionEvent } from "../host/dsh-adapter.mjs";

/** 与父进程共享的固定事件（冻结：advance 与 replay 两个进程必须派发同一字节的事件）。 */
export const RESTART_DEDUP_EVENTS = Object.freeze({
  sessionId: "sess-matrix-restart",
  first: Object.freeze({
    type: "tool/ptc-dispatch",
    seq: 20,
    data: Object.freeze({
      name: "compress",
      isError: false,
      content: Object.freeze([{ text: "[Compressed m1–m2, m3–m4 → 2 block(s), ~300 tokens saved.]" }]),
    }),
  }),
  next: Object.freeze({
    type: "tool/ptc-dispatch",
    seq: 21,
    data: Object.freeze({
      name: "compress",
      isError: false,
      content: Object.freeze([{ text: "[Compressed m5–m6 → 1 block(s), ~90 tokens saved.]" }]),
    }),
  }),
});

async function main() {
  const [phase, stateRoot, scopeId, outPath] = process.argv.slice(2);
  if (!phase || !stateRoot || !scopeId || !outPath) {
    throw new Error("usage: restart-child.mjs <phase> <stateRoot> <scopeId> <outPath>");
  }
  const completionFactory = createSyntheticCompletionFactory();
  const handle = await completionFactory({ root: stateRoot, scopeId });
  const runtime = await createSyntheticRuntimeFactory({ mode: "shadow", config: {}, completionHandle: handle });
  await runtime.start();
  const session = { id: RESTART_DEDUP_EVENTS.sessionId };
  const callNames = new Map();
  const dispatch = async (event) => {
    const normalized = mapRawSessionEvent(session, event, callNames);
    if (normalized === null) throw new Error(`restart-child: event seq=${event.seq} failed to map to a completion event`);
    return runtime.bridge.onCompletedTool(normalized);
  };

  let result;
  if (phase === "advance") {
    const first = await dispatch(RESTART_DEDUP_EVENTS.first);
    result = {
      phase,
      childPid: process.pid,
      firstAdvanced: first.advanced === true,
      epochAfterAdvance: runtime.bridge.diagnostics().probe.epoch,
    };
  } else if (phase === "replay") {
    // 先恢复持久状态再消费事件（E 契约）；随后重放同事件、再派发新事件。
    const restoredFromSink = runtime.bridge.diagnostics().restoredFromSink === true;
    const replay = await dispatch(RESTART_DEDUP_EVENTS.first);
    const epochAfterReplay = runtime.bridge.diagnostics().probe.epoch;
    const next = await dispatch(RESTART_DEDUP_EVENTS.next);
    const epochAfterNew = runtime.bridge.diagnostics().probe.epoch;
    result = {
      phase,
      childPid: process.pid,
      restoredFromSink,
      replayAdvanced: replay.advanced === true,
      replayReason: replay.reason ?? null,
      epochAfterReplay,
      nextAdvanced: next.advanced === true,
      epochAfterNew,
    };
  } else {
    throw new Error(`restart-child: unknown phase "${phase}"`);
  }

  await runtime.stop(); // D 契约 stop 可为异步：等待排空再 flush/close（反馈 F1）
  await handle.flush?.();
  await handle.close();
  await writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
}

// 仅作为脚本直接执行时运行 main（被 import 时不执行副作用）。
const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  : false;
if (invokedAsScript) {
  await main();
}
