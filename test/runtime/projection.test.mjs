/**
 * P1-RUNTIME 直写投影可见性（review-D-a1 阻断项回归）：
 * 默认 createDshHostAbstraction 路径（sync 快照模式）下，绕过桥工具的
 * 直接 runtime.service.mutate(...) 提交后，下一次 section 读取必须是当前值，
 * 无需手动 refresh。负责人复现：修复前 visible=false，仅 refresh 后 visible=true。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { createShioriRuntime } from "../../src/runtime/index.mjs";
import { SECTION_CORE } from "../../src/host/index.mjs";
import {
  createFakePluginCtx, createSyntheticCompletionFactory, delay,
  isCode, makeTempDir, removeTempDir,
} from "./_helpers.mjs";

const ACTIVE = { hostBridge: { allowActive: true } };
const fakeDshTools = async () => ({ defineTool: (def) => def });

async function startDefaultAdapterRuntime(base, pluginCtx, extra = {}) {
  const factory = createSyntheticCompletionFactory();
  const runtime = await createShioriRuntime({
    pluginCtx,
    dataRoot: path.join(base, "data"),
    stateRoot: path.join(base, "state"),
    activeScopeId: "scope-a",
    mode: "active",
    config: ACTIVE,
    loadDshTools: fakeDshTools,
    ...extra,
  }, { openCompletionState: factory.openCompletionState });
  return { runtime, factory };
}

test("直写可见性：直接 runtime.service.mutate 后下次 section 读取即当前值（默认适配层）", async () => {
  const base = await makeTempDir("shiori-proj1-");
  const pluginCtx = createFakePluginCtx();
  try {
    const { runtime } = await startDefaultAdapterRuntime(base, pluginCtx);
    await runtime.start();
    const section = pluginCtx.sections.get(SECTION_CORE);
    assert.equal(section.text(), "", "初始快照为空");

    // 负责人复现场景：绕过桥工具的直接 service.mutate。
    await runtime.service.mutate({
      operationId: "op-direct-1",
      changes: [{ kind: "core", text: "## 直写核心\n第一次直接提交。", expectedRevision: null }],
    });
    assert.ok(
      section.text().includes("第一次直接提交"),
      "直写提交后下一次 assemble 必须可见（不得依赖手动 refresh）",
    );

    // 第二次直写：携带服务 revision token 的 CAS 路径同样立即可见。
    const core1 = await runtime.service.readCore();
    await runtime.service.mutate({
      operationId: "op-direct-2",
      changes: [{ kind: "core", text: "## 直写核心\n第二次直接提交。", expectedRevision: core1.revision }],
    });
    const text2 = section.text();
    assert.ok(text2.includes("第二次直接提交"), "第二次直写立即可见");
    assert.ok(!text2.includes("第一次直接提交"), "旧内容被 CAS 替换");

    // 桥工具路径与直写路径交替，均保持可见（双路径共享同一包装 service）。
    await pluginCtx.registeredTools.get("memory_append").execute({ section: "工具写", content: "工具内容" });
    assert.ok(section.text().includes("工具内容"), "工具写入后仍立即可见");
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("直写刷新失败如实诊断：注入 service 读取失败时不否定已提交的 mutate", async () => {
  const base = await makeTempDir("shiori-proj2-");
  const pluginCtx = createFakePluginCtx();
  // synthetic service：读在开关翻转后失败（真实模拟快照刷新读取故障）。
  const inner = {
    readPersona: async () => ({ name: null, text: null }),
    readCoreView: async () => ({ text: "", revision: "r0", scopeId: "scope-a" }),
    readCore: async () => ({ text: "", revision: null, scopeId: "scope-a" }),
    readTopic: async () => { throw Object.assign(new Error("no topic"), { code: "INVALID_INPUT" }); },
    listTopics: async () => [],
    search: async () => [],
    async mutate(request) {
      calls.push(request.operationId);
      return { operationId: request.operationId, generation: 1, changes: [], budget: { evaluated: true } };
    },
  };
  const calls = [];
  let failReads = false;
  const synthetic = {
    ...inner,
    async readCoreView() {
      if (failReads) throw Object.assign(new Error("synthetic refresh read failure"), { code: "INVALID_STATE" });
      return inner.readCoreView();
    },
  };
  try {
    const { runtime } = await startDefaultAdapterRuntime(base, pluginCtx, { service: synthetic });
    await runtime.start();
    failReads = true;
    const result = await runtime.service.mutate({
      operationId: "op-fail-refresh",
      changes: [{ kind: "core", text: "x", expectedRevision: null }],
    });
    assert.equal(result.operationId, "op-fail-refresh", "已提交的 mutate 不因刷新失败被否定");
    const diag = runtime.diagnostics();
    assert.equal(diag.service.directWriteProjection, "refresh-after-mutate");
    assert.ok(diag.service.refreshErrors.some((e) => e.includes("synthetic refresh read failure")),
      "直写刷新失败必须显式记录在诊断");
    assert.equal(diag.refresh.refreshed, false, "最近一次刷新失败保留在 refresh 诊断");
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("直写包装的代际保护：stop 后旧引用 mutate 不触碰新代、无未处理拒绝", async () => {
  const base = await makeTempDir("shiori-proj3-");
  const pluginCtx = createFakePluginCtx();
  try {
    const { runtime } = await startDefaultAdapterRuntime(base, pluginCtx);
    await runtime.start();
    const staleService = runtime.service;
    const staleBridge = runtime.bridge;
    await runtime.stop();

    // 旧引用仍可用（service 本身有效，直写提交真实落盘），但包装静默跳过刷新。
    await staleService.mutate({
      operationId: "op-stale",
      changes: [{ kind: "core", text: "## 旧代直写\nstop 后的提交。", expectedRevision: null }],
    });
    assert.equal(staleBridge.diagnostics().mode, "active", "旧桥对象可查询，未被破坏");
    assert.equal(runtime.diagnostics().state, "idle");

    // 重启新代：快照读取当前磁盘（含已提交的旧代直写——那是真实数据），一切正常。
    await runtime.start();
    const section = pluginCtx.sections.get(SECTION_CORE);
    assert.ok(section.text().includes("旧代直写"), "已提交数据在新代可见（真实数据语义）");
    const diag = runtime.diagnostics();
    assert.deepEqual(diag.service.refreshErrors, [], "新代诊断不携带旧代的刷新错误");
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});

test("shadow 不受直写包装影响：门面 mutate 仍 UNSUPPORTED、零写边界保持", async () => {
  const base = await makeTempDir("shiori-proj4-");
  const pluginCtx = createFakePluginCtx();
  try {
    const factory = createSyntheticCompletionFactory();
    const runtime = await createShioriRuntime({
      pluginCtx,
      dataRoot: path.join(base, "data"),
      stateRoot: path.join(base, "state"),
      activeScopeId: "scope-a",
      mode: "shadow",
    }, { openCompletionState: factory.openCompletionState });
    await runtime.start();
    const diag = runtime.diagnostics();
    assert.equal(diag.service.kind, "shadow-unsupported-facade");
    assert.equal(diag.service.directWriteProjection, undefined, "shadow 不做直写投影包装");
    await assert.rejects(runtime.service.mutate({ changes: [] }), isCode("UNSUPPORTED"));
    await delay(30);
    await runtime.stop();
  } finally {
    await removeTempDir(base);
  }
});
