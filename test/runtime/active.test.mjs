/**
 * P1-RUNTIME active 模式：显式 allowActive、真实 service 装配（默认工厂）、
 * 注册可见性、写后下次 assemble 可见、工具 payload 越 scope 拒绝。
 * loadDshTools 注入 synthetic defineTool；E 工厂为 synthetic 替身。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createShioriRuntime } from "../../src/runtime/index.mjs";
import { SECTION_CORE } from "../../src/host/index.mjs";
import { createFakeService } from "../host/helpers.mjs";
import {
  createFakePluginCtx, createSyntheticCompletionFactory, isCode,
  makeTempDir, removeTempDir, waitFor,
} from "./_helpers.mjs";

const ACTIVE = { hostBridge: { allowActive: true } };
const fakeDshTools = async () => ({ defineTool: (def) => def });

test("active：真实 service 默认工厂装配，注册 section 与兼容工具；dataRoot 由 service 初始化（预期行为）", async () => {
  const base = await makeTempDir("shiori-active-");
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx, dataRoot, stateRoot, activeScopeId: "scope-a",
      mode: "active", config: ACTIVE, loadDshTools: fakeDshTools,
    }, { openCompletionState: factory.openCompletionState });

    const started = await runtime.start();
    assert.equal(started.mode, "active");
    assert.deepEqual(new Set([...pluginCtx.sections.keys()]), new Set(["shiori:persona", "shiori:core"]));
    assert.equal(pluginCtx.registeredTools.size, 9, "兼容工具全集注册（9 个）");
    assert.ok(pluginCtx.registeredTools.has("soul_read") && pluginCtx.registeredTools.has("core_write"));

    const diag = runtime.diagnostics();
    assert.equal(diag.service.kind, "created", "默认工厂创建真实 service");
    assert.equal(diag.dependencyProvenance.createService, "baseline-default (createShioriService)");
    assert.equal(typeof runtime.service.readCoreView, "function");
    assert.equal(runtime.host.getSessionInfo().scopeId, "scope-a", "scope 只来自可信 factory 参数");

    // active 模式 dataRoot 被存储层初始化是预期（shadow 才禁止）；stateRoot 独立存在。
    await waitFor(() => factory.orderLog.includes("load"));
    assert.ok(await stat(dataRoot), "active: dataRoot 由 service 初始化（显式开启后的预期写入）");

    const report = await runtime.stop();
    assert.equal(report.stopped, true);
    assert.equal(pluginCtx.sections.size, 0, "stop 回收全部 section 注册");
    assert.equal(pluginCtx.registeredTools.size, 0, "stop 回收全部工具注册");
  } finally {
    await removeTempDir(base);
  }
});

test("写后下次 assemble 可见：memory_append 提交后 section 文本立即可见（同步快照刷新）", async () => {
  const base = await makeTempDir("shiori-write-");
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx, dataRoot, stateRoot, activeScopeId: "scope-a",
      mode: "active", config: ACTIVE, loadDshTools: fakeDshTools,
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();

    const coreSection = pluginCtx.sections.get(SECTION_CORE);
    const before = coreSection.text();
    assert.equal(before, "", "初始 core 视图为空");

    const append = pluginCtx.registeredTools.get("memory_append");
    const receipt = await append.execute({ section: "验收", content: "写后投影必须可见" });
    assert.equal(receipt.projection, "written-pending-projection", "回执不提前宣称投影生效");

    const after = coreSection.text();
    assert.ok(after.includes("写后投影必须可见"), "提交后的下次 assemble 必须看到新内容");
    assert.ok(after.includes("## "), "追加块为带日期标题的 markdown 块");

    // 手动 refresh 亦成功且不误报。
    const refreshed = await runtime.refresh();
    assert.equal(refreshed.refreshed, true);
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("工具 payload 不能越 scope：携带 scope 的读写一律 INVALID_INPUT", async () => {
  const base = await makeTempDir("shiori-scope-");
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx, dataRoot, stateRoot, activeScopeId: "scope-a",
      mode: "active", config: ACTIVE, loadDshTools: fakeDshTools,
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();

    await assert.rejects(
      pluginCtx.registeredTools.get("soul_read").execute({ scope: "global" }),
      isCode("INVALID_INPUT"),
    );
    await assert.rejects(
      pluginCtx.registeredTools.get("memory_append").execute({ section: "x", content: "y", scope: "other-scope" }),
      isCode("INVALID_INPUT"),
    );
    // service 层同样拒绝 scope 字段（factory-only）
    await assert.rejects(
      runtime.service.mutate({ operationId: "op-1", changes: [{ kind: "core", text: "x", expectedRevision: null, scope: "evil" }] }),
      isCode("INVALID_INPUT"),
    );
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("active + 显式注入 synthetic service：dataRoot 完全不被触碰（隔离测试路径）", async () => {
  const base = await makeTempDir("shiori-activeinj-");
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const synthetic = createFakeService({ scopeId: "scope-a" });
    const runtime = await createShioriRuntime({
      pluginCtx, dataRoot, stateRoot, activeScopeId: "scope-a",
      mode: "active", config: ACTIVE, loadDshTools: fakeDshTools,
      service: synthetic,
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();
    assert.equal(runtime.diagnostics().service.kind, "injected");
    assert.equal(pluginCtx.registeredTools.size, 9);

    // 注入 service 的读路径正常（写后可见走注入 service 的 CAS）
    const view = await runtime.service.readCoreView();
    assert.ok(view.text.includes("铁律"), "synthetic service 初始 core 可读");
    const receipt = await pluginCtx.registeredTools.get("memory_append").execute({ section: "s", content: "c" });
    assert.ok(receipt.revision, "synthetic CAS 提交成功");
    await runtime.stop();
    await assert.rejects(stat(dataRoot), (error) => error.code === "ENOENT", "注入 service 时 dataRoot 不被创建");
  } finally {
    await removeTempDir(base);
  }
});

test("无 personaAdapter：魂卡保持不支持（soul_read 报不存在，不从真实卡读资料）", async () => {
  const base = await makeTempDir("shiori-nopersona-");
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  const factory = createSyntheticCompletionFactory();
  const pluginCtx = createFakePluginCtx();
  try {
    const runtime = await createShioriRuntime({
      pluginCtx, dataRoot, stateRoot, activeScopeId: "scope-a",
      mode: "active", config: ACTIVE, loadDshTools: fakeDshTools,
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();
    const result = await pluginCtx.registeredTools.get("soul_read").execute({});
    assert.equal(result.exists, false, "无 adapter 时 persona 明确不存在，不假装读取");
    const personaSection = pluginCtx.sections.get("shiori:persona");
    assert.equal(personaSection.text(), "", "persona section 为空文本（真实的不存在，非伪造）");
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});
