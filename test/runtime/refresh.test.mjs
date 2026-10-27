/**
 * P1-RUNTIME refresh 诊断：未启动拒绝、成功、失败显式诊断（不回写成功、不清空快照）。
 * 失败注入使用 synthetic service（active 注入路径）；shadow 门面刷新失败亦显式 UNSUPPORTED。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { createShioriRuntime } from "../../src/runtime/index.mjs";
import { SECTION_CORE } from "../../src/host/index.mjs";
import { createFakeService } from "../host/helpers.mjs";
import {
  createFakePluginCtx, createSyntheticCompletionFactory, isCode, makeTempDir, removeTempDir,
} from "./_helpers.mjs";

const ACTIVE = { hostBridge: { allowActive: true } };
const fakeDshTools = async () => ({ defineTool: (def) => def });

test("未启动时 refresh：INVALID_STATE", async () => {
  const base = await makeTempDir("shiori-ref0-");
  const factory = createSyntheticCompletionFactory();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx: createFakePluginCtx(),
      dataRoot: path.join(base, "data"),
      stateRoot: path.join(base, "state"),
      activeScopeId: "scope-a",
      mode: "active",
      config: ACTIVE,
    }, { openCompletionState: factory.openCompletionState });
    await assert.rejects(runtime.refresh(), isCode("INVALID_STATE"));
  } finally {
    await removeTempDir(base);
  }
});

test("active 真实 service：手动 refresh 成功且如实返回", async () => {
  const base = await makeTempDir("shiori-ref1-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx,
      dataRoot: path.join(base, "data"),
      stateRoot: path.join(base, "state"),
      activeScopeId: "scope-a",
      mode: "active",
      config: ACTIVE,
      loadDshTools: fakeDshTools,
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();
    const result = await runtime.refresh();
    assert.equal(result.refreshed, true);
    assert.equal(runtime.diagnostics().refresh.refreshed, true);
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("刷新失败显式诊断：refreshed:false + error 记录；快照不被清空或误报更新", async () => {
  const base = await makeTempDir("shiori-ref2-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  // synthetic service：readCoreView 可按开关抛错（初始快照必须成功，之后才失败）。
  const inner = createFakeService({ scopeId: "scope-a", coreText: "## 初始核心\n已有内容。" });
  let failReads = false;
  const synthetic = {
    ...inner,
    async readCoreView() {
      if (failReads) {
        throw Object.assign(new Error("synthetic read failure for diagnosis"), { code: "INVALID_STATE" });
      }
      return inner.readCoreView();
    },
  };
  try {
    const runtime = await createShioriRuntime({
      pluginCtx,
      dataRoot: path.join(base, "data"),
      stateRoot: path.join(base, "state"),
      activeScopeId: "scope-a",
      mode: "active",
      config: ACTIVE,
      loadDshTools: fakeDshTools,
      service: synthetic,
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();
    const section = pluginCtx.sections.get(SECTION_CORE);
    const before = section.text();
    assert.ok(before.includes("初始核心"), "初始同步快照包含真实读取结果");

    failReads = true;
    const result = await runtime.refresh();
    assert.equal(result.refreshed, false, "刷新失败不得回写为成功");
    assert.ok(result.error.includes("synthetic read failure for diagnosis"), "失败原因如实携带");
    assert.ok(result.error.includes("INVALID_STATE"), "错误 code 显式可见");
    assert.equal(runtime.diagnostics().refresh.refreshed, false, "诊断保留最近一次失败");
    assert.equal(section.text(), before, "失败刷新不得清空/替换既有快照（无空文本冒充）");

    // 恢复读取后刷新重新成功。
    failReads = false;
    const ok = await runtime.refresh();
    assert.equal(ok.refreshed, true);
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("shadow 门面：手动 refresh 失败为显式 UNSUPPORTED 诊断，不声称投影更新", async () => {
  const base = await makeTempDir("shiori-ref3-");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx,
      dataRoot: path.join(base, "data"),
      stateRoot: path.join(base, "state"),
      activeScopeId: "scope-a",
      mode: "shadow",
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();
    const result = await runtime.refresh();
    assert.equal(result.refreshed, false);
    assert.ok(result.error.includes("UNSUPPORTED"), "门面拒绝以 UNSUPPORTED 显式呈现");
    assert.equal(runtime.diagnostics().service.facade.readAttempts >= 2, true);
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});
