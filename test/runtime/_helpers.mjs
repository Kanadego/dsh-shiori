/**
 * test/runtime 共用夹具 —— 全部 SYNTHETIC（契约 D：E 未验收时只允许明确标注 synthetic 的注入替身）。
 *
 * - createSyntheticCompletionFactory：满足 CONTRACTS §E 句柄形状的假 openCompletionState
 *   （真实文件落盘到临时 stateRoot、单-owner 互斥、close 后 save 拒绝、可注入 save 门闸）。
 *   仅用于 D 的独立单测，不得冒充真实隔离 DSH 证据。
 * - createFakePluginCtx：驱动真实 createDshHostAbstraction 的假 cordis 上下文。
 * - 事件/目录工具：fs.mkdtemp 建临时目录，调用方 finally 清理；禁用真实记忆。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function makeTempDir(prefix = "shiori-runtime-") {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeTempDir(dir) {
  await rm(dir, { recursive: true, force: true });
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮轮等待条件成立（真实文件 I/O 的确定性边界）；超时抛错，不静默通过。 */
export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error("waitFor: condition not met before timeout");
    await delay(intervalMs);
  }
}

/** coded error 断言辅助。 */
export function isCode(code) {
  return (error) => {
    assert.ok(error instanceof Error && error.code === code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    return true;
  };
}

/**
 * SYNTHETIC openCompletionState 工厂替身。
 * @param {object} [options]
 * @param {() => Promise} [options.saveGate] 每次 sink.save 先等待该门闸（排空测试用）
 * @returns {{ openCompletionState: Function, orderLog: string[], handles: object[] }}
 */
export function createSyntheticCompletionFactory({ saveGate } = {}) {
  const orderLog = [];
  const handles = [];
  const openKeys = new Set();
  const keyOf = (root, scopeId) => `${root.toLowerCase()}::${scopeId}`;

  async function openCompletionState({ root, scopeId }) {
    assert.equal(typeof root, "string", "synthetic openCompletionState: root required");
    assert.equal(typeof scopeId, "string", "synthetic openCompletionState: scopeId required");
    const key = keyOf(path.resolve(root), scopeId);
    if (openKeys.has(key)) {
      const error = new Error(`synthetic completion state: ${root}#${scopeId} already has an active owner`);
      error.code = "LOCK_BUSY";
      throw error;
    }
    openKeys.add(key);
    orderLog.push("open");
    const file = path.join(root, `completion-${scopeId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
    let closed = false;
    let saving = Promise.resolve();
    let saveCount = 0;
    const sink = {
      async load() {
        if (closed) {
          const error = new Error("synthetic completion state: handle closed"); error.code = "INVALID_STATE"; throw error;
        }
        orderLog.push("load");
        let raw;
        try {
          raw = await readFile(file, "utf8");
        } catch (error) {
          if (error.code === "ENOENT" || error.code === "EISDIR") return null;
          throw error;
        }
        if (raw.trim().length === 0) return null;
        return JSON.parse(raw);
      },
      async save(snapshot) {
        if (closed) {
          const error = new Error("synthetic completion state: save rejected after close"); error.code = "INVALID_STATE"; throw error;
        }
        saveCount += 1;
        const n = saveCount;
        orderLog.push(`save:start:${n}`);
        const run = (async () => {
          if (saveGate) await saveGate();
          await mkdir(path.dirname(file), { recursive: true });
          const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${n}`;
          await writeFile(tmp, JSON.stringify(snapshot, null, 2), "utf8");
          await rename(tmp, file);
          orderLog.push(`save:done:${n}`);
        })();
        saving = saving.then(() => run, () => run);
        await run;
      },
    };
    const handle = {
      sink,
      async flush() {
        orderLog.push("flush");
        await saving;
      },
      async close() {
        if (closed) {
          orderLog.push("close:idempotent");
          return;
        }
        await saving;
        closed = true;
        openKeys.delete(key);
        orderLog.push("close");
      },
      diagnostics() {
        return {
          synthetic: true,
          root,
          scopeId,
          closed,
          saveCount,
          openedAt: undefined,
        };
      },
    };
    handles.push(handle);
    return handle;
  }
  return { openCompletionState, orderLog, handles };
}

/**
 * 假 cordis pluginCtx：驱动真实 createDshHostAbstraction。
 * - tools.register 重复注册抛 "already registered"（触发桥的唯一写者冲突检测）；
 * - failOnSectionName 指定名字的 section 注册抛错（启动失败回滚测试）；
 * - emit(session, event) 派发原始 session 事件（走真实 mapRawSessionEvent 映射）。
 */
export function createFakePluginCtx({ failOnSectionName = null, preRegisteredToolNames = [] } = {}) {
  const sections = new Map();
  const registeredTools = new Map();
  const listeners = new Set();
  for (const name of preRegisteredToolNames) registeredTools.set(name, { name, foreign: true });
  return {
    systemPrompt: {
      section(def) {
        if (def.name === failOnSectionName) throw new Error(`section ${def.name} already registered`);
        sections.set(def.name, def);
        return () => sections.delete(def.name);
      },
    },
    tools: {
      register(def) {
        if (registeredTools.has(def.name)) throw new Error(`${def.name} already registered by another provider`);
        registeredTools.set(def.name, def);
        return () => registeredTools.delete(def.name);
      },
    },
    on(type, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // —— synthetic 测试辅助 ——
    sections,
    registeredTools,
    listenerCount: () => listeners.size,
    emit(session, event) {
      for (const listener of [...listeners]) listener(session, event);
    },
  };
}

/** 以原始 session 事件形状派发一次 compress 完成（经真实 dsh-adapter 映射）。 */
export async function emitPtcCompress(pluginCtx, sessionId, seq, blocks = 2) {
  pluginCtx.emit({ id: sessionId }, {
    type: "tool/ptc-dispatch",
    seq,
    data: {
      name: "compress",
      isError: false,
      content: `[Compressed m1–m2, m3–m4 → ${blocks} block(s), ~41854 tokens saved.]`,
    },
  });
  // 事件处理是异步链（监听器 Promise），给排空断言一个确定性的微任务边界。
  await new Promise((resolve) => setImmediate(resolve));
}
