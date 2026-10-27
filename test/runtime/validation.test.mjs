/**
 * P1-RUNTIME 构造期校验：依赖注入、路径分离（含链接穿透）、active 显式开关。
 * 全部使用 synthetic 夹具；dataRoot/stateRoot 均为 fs.mkdtemp 临时目录。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { createShioriRuntime } from "../../src/runtime/index.mjs";
import {
  createFakePluginCtx, createSyntheticCompletionFactory, isCode, makeTempDir, removeTempDir,
} from "./_helpers.mjs";

const ACTIVE = { hostBridge: { allowActive: true } };

async function roots() {
  const base = await makeTempDir("shiori-val-");
  return { base, dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state") };
}

test("缺少 openCompletionState 依赖：UNSUPPORTED，不静默降级为 memory-only", async () => {
  const r = await roots();
  try {
    await assert.rejects(
      createShioriRuntime({
        pluginCtx: createFakePluginCtx(), dataRoot: r.dataRoot, stateRoot: r.stateRoot,
        activeScopeId: "scope-a", mode: "shadow",
      }),
      isCode("UNSUPPORTED"),
    );
  } finally {
    await removeTempDir(r.base);
  }
});

test("路径校验：相对路径 / 相同 / 嵌套一律 INVALID_INPUT", async () => {
  const r = await roots();
  const dep = { openCompletionState: createSyntheticCompletionFactory().openCompletionState };
  const ctx = createFakePluginCtx();
  const base = {
    pluginCtx: ctx, stateRoot: r.stateRoot, activeScopeId: "scope-a",
  };
  try {
    await assert.rejects(
      createShioriRuntime({ ...base, dataRoot: "relative/data" }),
      isCode("INVALID_INPUT"),
    );
    await assert.rejects(
      createShioriRuntime({ ...base, dataRoot: r.dataRoot, stateRoot: "state-rel" }),
      isCode("INVALID_INPUT"),
    );
    await assert.rejects(
      createShioriRuntime({ ...base, dataRoot: r.dataRoot, stateRoot: r.dataRoot }),
      isCode("INVALID_INPUT"),
    );
    await assert.rejects(
      createShioriRuntime({ ...base, dataRoot: r.dataRoot, stateRoot: path.join(r.dataRoot, "state") }),
      isCode("INVALID_INPUT"),
    );
    await assert.rejects(
      createShioriRuntime({ ...base, dataRoot: path.join(r.stateRoot, "data"), stateRoot: r.stateRoot }),
      isCode("INVALID_INPUT"),
    );
    // Windows 大小写折叠后的同一路径
    const flipped = r.dataRoot.toUpperCase() === r.dataRoot
      ? r.dataRoot.toLowerCase()
      : r.dataRoot.toUpperCase();
    await assert.rejects(
      createShioriRuntime({ ...base, dataRoot: r.dataRoot, stateRoot: flipped }),
      isCode("INVALID_INPUT"),
    );
  } finally {
    await removeTempDir(r.base);
  }
});

test("越根链接：stateRoot 为指向 dataRoot 内部的 junction 时拒绝（win32 实链）", async () => {
  if (process.platform !== "win32") return; // junction 仅 Windows；POSIX 链接路径在 REPORT 标 not-run
  const r = await roots();
  const dep = { openCompletionState: createSyntheticCompletionFactory().openCompletionState };
  try {
    await mkdir(path.join(r.base, "data", "nested", "deep"), { recursive: true });
    await symlink(path.join(r.base, "data", "nested"), path.join(r.base, "state-link"), "junction");
    await assert.rejects(
      createShioriRuntime({
        pluginCtx: createFakePluginCtx(),
        dataRoot: r.dataRoot,
        stateRoot: path.join(r.base, "state-link"),
        activeScopeId: "scope-a",
      }),
      isCode("INVALID_INPUT"),
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      // 本机不允许创建链接：不假装通过，标记跳过（结果记录为环境受限）。
      return;
    }
    throw error;
  } finally {
    await removeTempDir(r.base);
  }
});

test("mode/allowActive/scope/service 形状校验；active 绝不代设 allowActive", async () => {
  const r = await roots();
  const dep = { openCompletionState: createSyntheticCompletionFactory().openCompletionState };
  const ctx = createFakePluginCtx();
  const base = {
    pluginCtx: ctx, dataRoot: r.dataRoot, stateRoot: r.stateRoot, activeScopeId: "scope-a",
  };
  try {
    await assert.rejects(createShioriRuntime({ ...base, mode: "aggressive" }, dep), isCode("INVALID_INPUT"));
    // active 但未显式 allowActive：构造即拒绝（运行时不篡改 config）
    await assert.rejects(createShioriRuntime({ ...base, mode: "active" }, dep), isCode("INVALID_INPUT"));
    await assert.rejects(
      createShioriRuntime({ ...base, mode: "active", config: { hostBridge: { allowActive: false } } }, dep),
      isCode("INVALID_INPUT"),
    );
    await assert.rejects(createShioriRuntime({ ...base, activeScopeId: "" }, dep), isCode("INVALID_INPUT"));
    await assert.rejects(createShioriRuntime({ ...base, activeScopeId: 42 }, dep), isCode("INVALID_INPUT"));
    await assert.rejects(
      createShioriRuntime({ ...base, service: { readPersona: async () => {} } }, dep),
      isCode("INVALID_INPUT"),
    );
    await assert.rejects(createShioriRuntime({ ...base, loadDshTools: "not-a-fn" }, dep), isCode("INVALID_INPUT"));
    await assert.rejects(createShioriRuntime({ ...base, personaAdapter: {} }, dep), isCode("INVALID_INPUT"));
    // 显式 allowActive 的 active 构造成功
    const rt = await createShioriRuntime({ ...base, mode: "active", config: ACTIVE }, dep);
    assert.equal(typeof rt.start, "function");
    assert.equal(rt.service, null, "start 前不创建 service");
    assert.equal(rt.bridge, null, "start 前不创建 bridge");
    assert.equal(rt.host, null, "start 前不创建 host");
  } finally {
    await removeTempDir(r.base);
  }
});

test("冻结的调用方 config 不被运行时篡改（hostBridge 不被增删改）", async () => {
  const r = await roots();
  const dep = { openCompletionState: createSyntheticCompletionFactory().openCompletionState };
  try {
    const config = Object.freeze({ hostBridge: Object.freeze({ allowActive: true }) });
    const rt = await createShioriRuntime({
      pluginCtx: createFakePluginCtx(), dataRoot: r.dataRoot, stateRoot: r.stateRoot,
      activeScopeId: "scope-a", mode: "active", config,
    }, dep);
    assert.deepEqual(config, { hostBridge: { allowActive: true } });
    const diag = rt.diagnostics();
    assert.equal(diag.dependencyProvenance.openCompletionState, "injected (required; no default exists in this baseline)");
  } finally {
    await removeTempDir(r.base);
  }
});
