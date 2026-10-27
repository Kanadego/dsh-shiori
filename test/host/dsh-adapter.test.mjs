import assert from "node:assert/strict";
import { test } from "node:test";
import { assembleDshShioriHost, createDshHostAbstraction, mapRawSessionEvent } from "../../src/host/dsh-adapter.mjs";
import { createHostBridge } from "../../src/host/index.mjs";
import { ACTIVE_CONFIG, createFakeService } from "./helpers.mjs";
// 真实 desktop 宿主 2026-10-26 实测回执（session-a6026977-5… seq=124；节选：5 段警告取前两段，
// 其余三段同模板；字符串本身逐字）：警告内嵌在
// 闭合 ] 之前；tool message 形状见「回归（真实宿主 2026-10-26）」测试。
const REAL_DESKTOP_RECEIPT = "[Compressed m00020–m00021, m00023–m00024, m00026–m00027, m00029–m00030, m00041–m00042 → 5 block(s), ~57512 tokens saved. Excluded 1 protected message(s) m00019 from compression range (recent/last-user zone) — they stay visible outside the new block; do not target them in another compress call.; Excluded 1 protected message(s) m00022 from compression range (recent/last-user zone) — they stay visible outside the new block; do not target them in another compress call.]\n · b1 full summary …\n · b2 full summary …\n · b3 full summary …\n · b4 full summary …\n · b5 full summary …";

test("mapRawSessionEvent：直接模式 tool/call→tool/result 归因", () => {
  const callNames = new Map();
  const session = { id: "sess-direct" };
  const call = { type: "tool/call", seq: 10, data: { callId: "call-1", name: "memory_read", arguments: {} } };
  assert.equal(mapRawSessionEvent(session, call, callNames), null);

  const result = {
    type: "tool/result",
    seq: 11,
    data: { message: { callId: "call-1", content: [{ type: "text", text: "…" }], isError: false } },
  };
  // P1：归一化输出新增 callId（direct/PTC 双报告去重的底层调用身份）
  assert.deepEqual(mapRawSessionEvent(session, result, callNames), {
    eventId: "sess-direct:tool/result:11",
    sessionId: "sess-direct",
    name: "memory_read",
    success: true,
    callId: "call-1",
    seq: 11,
  });

  const failed = { type: "tool/result", seq: 12, data: { message: { callId: "call-1", content: [], isError: true } } };
  const mapped = mapRawSessionEvent(session, failed, callNames);
  assert.equal(mapped.success, false);

  // 无法归因（缺 tool/call）→ 不猜测
  const orphan = { type: "tool/result", seq: 13, data: { message: { callId: "call-unknown", content: [], isError: false } } };
  assert.equal(mapRawSessionEvent(session, orphan, callNames), null);
});

test("回归（真实宿主 2026-10-26）：tool/result 无 message.callId，仅 toolCallId + source.callId 仍归因并解析内嵌警告回执", () => {
  const callNames = new Map();
  const session = { id: "session-a6026977-53a1-4fdf-82f1-87806ed85125" };
  const callId = "call_00_yb6bngk1y198358w77ugnxm9";
  // seq=123：真实 tool/call data 形状（turn/step/callId/name/arguments）
  assert.equal(mapRawSessionEvent(session, {
    type: "tool/call",
    seq: 123,
    data: { turn: 4, callId, name: "compress", arguments: "{}" },
  }, callNames), null);

  // seq=124：真实 tool/result data.message 形状——键为 role/source/toolCallId/content/isError/id，
  // 没有 message.callId（旧实现取 data.message?.callId 恒为 undefined → 永远无法归因）。
  const message = {
    role: "tool",
    source: { kind: "tool", callId },
    toolCallId: callId,
    content: [{ type: "text", text: REAL_DESKTOP_RECEIPT }],
    isError: false,
    id: "msg_real_124",
  };
  assert.deepEqual(Object.keys(message), ["role", "source", "toolCallId", "content", "isError", "id"]);

  assert.deepEqual(mapRawSessionEvent(session, { type: "tool/result", seq: 124, data: { turn: 4, message, meta: undefined } }, callNames), {
    eventId: "session-a6026977-53a1-4fdf-82f1-87806ed85125:tool/result:124",
    sessionId: "session-a6026977-53a1-4fdf-82f1-87806ed85125",
    name: "compress",
    success: true,
    callId,
    blocksCreated: 5,
    seq: 124,
  });
});

test("mapRawSessionEvent：callId 三来源逐个可用（callId / toolCallId / source.callId），全缺或非字符串/空串 → null 不猜", () => {
  const variants = [
    { label: "message.callId（旧形状，向后兼容）", message: { callId: "c-old" }, expect: "c-old" },
    { label: "message.toolCallId（desktop 实测）", message: { toolCallId: "c-tool" }, expect: "c-tool" },
    { label: "message.source.callId（desktop 实测）", message: { source: { callId: "c-src" } }, expect: "c-src" },
  ];
  for (const { label, message, expect } of variants) {
    const session = { id: `sess-${expect}` };
    const callNames = new Map();
    // 名字登记走真实 tool/call 事件（证明全链路，而不是预先往 Map 里塞）。
    mapRawSessionEvent(session, { type: "tool/call", seq: 1, data: { callId: expect, name: "compress" } }, callNames);
    const mapped = mapRawSessionEvent(session, {
      type: "tool/result",
      seq: 2,
      data: { message: { role: "tool", content: [], isError: false, ...message } },
    }, callNames);
    assert.equal(mapped?.callId, expect, label);
    assert.equal(mapped?.name, "compress", label);
    assert.equal(mapped?.blocksCreated, undefined, `${label}：无块证据不猜`);
  }

  // 三者皆缺 / 非字符串 / 空串 → 保持「无法归因」返回 null，不猜。
  const s = { id: "sess-missing" };
  const names = new Map();
  names.set("sess-missing:c-any", "compress");
  const missingCases = [
    { role: "tool", content: [], isError: false },
    { role: "tool", callId: "", toolCallId: "", source: { callId: "" }, content: [], isError: false },
    { role: "tool", callId: 42, toolCallId: null, source: { callId: {} }, content: [], isError: false },
    { role: "tool", source: null, content: [], isError: false },
  ];
  for (const message of missingCases) {
    assert.equal(
      mapRawSessionEvent(s, { type: "tool/result", seq: 3, data: { message } }, names),
      null,
      JSON.stringify(message),
    );
  }
});

test("mapRawSessionEvent：tool/result 携带 meta.blocksCreated 时透传", () => {
  const callNames = new Map();
  const session = { id: "s" };
  callNames.set("s:call-9", "compress");
  const event = {
    type: "tool/result",
    seq: 20,
    data: { message: { callId: "call-9", content: [], isError: false }, meta: { blocksCreated: 3 } },
  };
  assert.equal(mapRawSessionEvent(session, event, callNames).blocksCreated, 3);
});

test("mapRawSessionEvent：PTC dispatch 形状以本机会话实测为准（无 data.blocksCreated 字段）", () => {
  const callNames = new Map();
  const session = { id: "sess-11aab7ab" };
  // dispatch-start 只登记，不产出完成事件
  const start = { type: "tool/ptc-dispatch-start", seq: 138, data: { name: "compress" } };
  assert.equal(mapRawSessionEvent(session, start, callNames), null);

  // 本机实测（session.v4.jsonl.zstd seq=139，脱敏）：
  // data keys = rootCallId,parentCallId,subCallId,name,arguments,isError,content；无 blocksCreated。
  // 成功回执首行：[Compressed m00004–m00010, m00011–m00018 → 2 block(s), ~41854 tokens saved.]
  const realLocal = {
    type: "tool/ptc-dispatch",
    seq: 139,
    data: {
      rootCallId: "call_x",
      parentCallId: "call_x",
      subCallId: "call_x:ptc:1",
      name: "compress",
      arguments: {},
      isError: false,
      content: [{
        type: "text",
        text: "[Compressed m00004–m00010, m00011–m00018 → 2 block(s), ~41854 tokens saved.]\n · b1 full summary …\n · b2 full summary …",
      }],
    },
  };
  // P1：PTC 归一化输出新增 callId = parentCallId（与 direct tool/call 的 callId 关联）
  assert.deepEqual(mapRawSessionEvent(session, realLocal, callNames), {
    eventId: "sess-11aab7ab:tool/ptc-dispatch:139",
    sessionId: "sess-11aab7ab",
    name: "compress",
    success: true,
    callId: "call_x",
    blocksCreated: 2,
    seq: 139,
  });

  // 数值字段与文本证据一致 → 采信（P1 起矛盾时保守，不再"数值无条件优先"）
  const withNumeric = { type: "tool/ptc-dispatch", seq: 140, data: { name: "compress", isError: false, blocksCreated: 7, content: [{ type: "text", text: "[Compressed x → 7 block(s), ~1 tokens saved.]" }] } };
  assert.equal(mapRawSessionEvent(session, withNumeric, callNames).blocksCreated, 7);

  // 数值与文本矛盾 → metaConflict（探针保守不推进），不带任何 blocksCreated
  const conflicting = { type: "tool/ptc-dispatch", seq: 140, data: { name: "compress", isError: false, blocksCreated: 7, content: [{ type: "text", text: "[Compressed x → 2 block(s), ~1 tokens saved.]" }] } };
  const conflictMapped = mapRawSessionEvent(session, conflicting, callNames);
  assert.equal(conflictMapped.blocksCreated, undefined);
  assert.equal(conflictMapped.metaConflict, true);

  // PARTIAL 已证实格式（dsh-native.js:128 partialOutcomeNote 固定全文，行尾锚定）
  const partial = {
    type: "tool/ptc-dispatch",
    seq: 141,
    data: {
      name: "compress",
      isError: false,
      content: [{ type: "text", text: "[acp-result: PARTIAL — 1 block(s) created; some requested range(s) were NOT folded. Retry ONLY the failed range(s) listed above; do not re-fold the ranges that were applied.]" }],
    },
  };
  assert.equal(mapRawSessionEvent(session, partial, callNames).blocksCreated, 1);

  // 无任何已证实块证据 → 不猜（no-block-evidence 路径）
  const noEvidence = { type: "tool/ptc-dispatch", seq: 142, data: { name: "compress", isError: false, content: [{ type: "text", text: "done" }] } };
  const mapped = mapRawSessionEvent(session, noEvidence, callNames);
  assert.equal(mapped.blocksCreated, undefined);

  // 失败 dispatch
  const failed = { type: "tool/ptc-dispatch", seq: 143, data: { name: "compress", isError: true } };
  assert.equal(mapRawSessionEvent(session, failed, callNames).success, false);

  // 无 name 的 dispatch 不归因
  assert.equal(mapRawSessionEvent(session, { type: "tool/ptc-dispatch", seq: 144, data: {} }, callNames), null);
});

function fakePluginCtx() {
  const sections = new Map();
  const registeredTools = [];
  const handlers = new Map();
  return {
    sections,
    registeredTools,
    handlers,
    systemPrompt: {
      section({ name, order, text, interpolate }) {
        sections.set(name, { order, text, interpolate });
        return () => sections.delete(name);
      },
    },
    tools: {
      register(def) {
        registeredTools.push(def);
        return () => {
          const i = registeredTools.indexOf(def);
          if (i >= 0) registeredTools.splice(i, 1);
        };
      },
    },
    on(type, handler) {
      handlers.set(type, (handlers.get(type) ?? new Set()).add(handler));
      return () => handlers.get(type)?.delete(handler);
    },
  };
}

test("createDshHostAbstraction：section 映射（interpolate:false）、能力声明、事件订阅", async () => {
  const ctx = fakePluginCtx();
  const host = createDshHostAbstraction(ctx, { trustedScopeId: "amber" });

  assert.equal(host.capabilities.asyncSectionText, false, "真实宿主 section text 仅见同步用法");
  assert.equal(host.capabilities.inHistory, "unverified");
  assert.equal(host.getSessionInfo().scopeId, "amber");

  const disposeSection = host.registerSystemSection({
    name: "shiori:core",
    order: 0.5,
    text: () => "内容",
  });
  assert.equal(ctx.sections.get("shiori:core").interpolate, false);
  assert.equal(typeof disposeSection, "function");

  const events = [];
  const dispose = host.subscribeCompletedTools((event) => events.push(event));
  for (const handler of ctx.handlers.get("session/event") ?? []) {
    handler({ id: "sess-x" }, { type: "tool/ptc-dispatch", seq: 1, data: { name: "compress", isError: false, blocksCreated: 1 } });
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "compress");

  dispose();
  disposeSection();
  assert.equal(ctx.sections.size, 0);
});

test("createDshHostAbstraction + 桥：真实事件流（tool/call→result / PTC）驱动探针", async () => {
  const ctx = fakePluginCtx();
  const host = createDshHostAbstraction(ctx, { trustedScopeId: "amber" });
  const service = createFakeService();
  const bridge = createHostBridge({ host, service, mode: "shadow" });
  await bridge.start();

  const dispatch = (session, event) => {
    for (const handler of ctx.handlers.get("session/event") ?? []) handler(session, event);
  };
  const flush = () => new Promise((r) => setImmediate(r));
  // 直接模式压缩：无块证据 → 观测但不推进
  dispatch({ id: "s1" }, { type: "tool/call", seq: 1, data: { callId: "c1", name: "compress" } });
  dispatch({ id: "s1" }, { type: "tool/result", seq: 2, data: { message: { callId: "c1", content: [], isError: false } } });
  await flush();
  assert.equal(bridge.diagnostics().probe.epoch, 0);
  assert.equal(bridge.diagnostics().recentEvents.at(-1).reason, "no-block-evidence");

  // PTC 模式压缩（本机真实成功回执格式，seq=3）→ 推进
  dispatch({ id: "s1" }, {
    type: "tool/ptc-dispatch",
    seq: 3,
    data: { name: "compress", isError: false, content: [{ type: "text", text: "[Compressed m00001–m00002 → 2 block(s), ~1234 tokens saved.]" }] },
  });
  await flush();
  assert.equal(bridge.diagnostics().probe.epoch, 1);

  bridge.stop();
});

test("回归（真实宿主 2026-10-26）：direct compress 回执内嵌 Excluded 警告时仍推进压缩 epoch", async () => {
  const ctx = fakePluginCtx();
  const host = createDshHostAbstraction(ctx, { trustedScopeId: "amber" });
  const service = createFakeService();
  const bridge = createHostBridge({ host, service, mode: "shadow" });
  await bridge.start();

  const dispatch = (session, event) => {
    for (const handler of ctx.handlers.get("session/event") ?? []) handler(session, event);
  };
  const flush = () => new Promise((r) => setImmediate(r));
  const session = { id: "session-a6026977-53a1-4fdf-82f1-87806ed85125" };
  const callId = "call_00_yb6bngk1y198358w77ugnxm9";
  dispatch(session, { type: "tool/call", seq: 123, data: { turn: 4, callId, name: "compress", arguments: "{}" } });
  dispatch(session, {
    type: "tool/result",
    seq: 124,
    data: {
      turn: 4,
      message: {
        role: "tool",
        source: { kind: "tool", callId },
        toolCallId: callId,
        content: [{ type: "text", text: REAL_DESKTOP_RECEIPT }],
        isError: false,
        id: "msg_real_124",
      },
    },
  });
  await flush();

  const diagnostics = bridge.diagnostics();
  assert.equal(diagnostics.probe.epoch, 1, "真实宿主回执必须让压缩 epoch 前进（修复前因无法归因恒为 0）");
  const last = diagnostics.recentEvents.at(-1);
  assert.equal(last.reason, "advanced");
  assert.deepEqual(diagnostics.probe.lastAdvance, {
    eventId: "session-a6026977-53a1-4fdf-82f1-87806ed85125:tool/result:124",
    sessionId: "session-a6026977-53a1-4fdf-82f1-87806ed85125",
    blocksCreated: 5,
    at: diagnostics.probe.lastAdvance.at,
  });
  assert.equal(typeof diagnostics.probe.lastAdvance.at, "string");
  assert.equal(diagnostics.probe.advancesWithoutCallIdentity, 0, "有 callId 的推进不计入无身份披露");

  bridge.stop();
});

test("registerTool：defineTool 经注入加载器映射；加载失败 → UNSUPPORTED", async () => {
  const ctx = fakePluginCtx();
  const host = createDshHostAbstraction(ctx, {
    loadDshTools: async () => ({ defineTool: (def) => def }),
  });
  await host.registerTool({ name: "soul_read", description: "d", inputSchema: {}, execute: async () => ({}) });
  assert.equal(ctx.registeredTools.length, 1);
  assert.equal(ctx.registeredTools[0].name, "soul_read");
  assert.equal(ctx.registeredTools[0].isConcurrencySafe(), true);

  await host.registerTool({ name: "core_write", description: "d", inputSchema: {}, execute: async () => ({}) });
  assert.equal(ctx.registeredTools[1].isConcurrencySafe(), false, "写工具必须声明非并发安全");

  const noDeps = createDshHostAbstraction(fakePluginCtx(), { loadDshTools: async () => { throw new Error("module not found"); } });
  await assert.rejects(
    () => noDeps.registerTool({ name: "x", description: "d", inputSchema: {}, execute: async () => ({}) }),
    (e) => e.code === "UNSUPPORTED" && /dsh-tools/.test(e.message),
  );
});

// ── R1：adapter 与 bridge 的 active 组合（真实模块，不只各自 mock）──────────────

const passthroughLoader = async () => ({ defineTool: (def) => def });

test("R1 组合：adapter+bridge 以 active 模式真实组合启动，stop 后零残留，可重启", async () => {
  const ctx = fakePluginCtx();
  const host = createDshHostAbstraction(ctx, { trustedScopeId: "amber", loadDshTools: passthroughLoader });
  const service = createFakeService();
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });

  const started = await bridge.start();
  assert.equal(started.mode, "active");
  assert.equal(started.tools.length, 9);
  assert.equal(ctx.sections.size, 2);
  assert.equal(ctx.registeredTools.length, 9);
  // defineTool 包装后的工具经 ctx 调用仍走 serviceForTools（mutate 后刷新快照）
  const soulUpdate = ctx.registeredTools.find((t) => t.name === "soul_update");
  const receipt = await soulUpdate.execute({ content: "# 组合测试人设" });
  assert.equal(receipt.projection, "written-pending-projection");
  assert.equal((await service.readPersona()).text, "# 组合测试人设");

  const stopped = bridge.stop();
  assert.ok(stopped.disposed >= 12); // 1 订阅 + 2 section + 9 工具
  assert.equal(ctx.sections.size, 0, "stop 后不得残留 section");
  assert.equal(ctx.registeredTools.length, 0, "stop 后不得残留工具");
  assert.equal((ctx.handlers.get("session/event") ?? new Set()).size, 0, "stop 后不得残留监听器");

  // 重新启动：各注册一次，无累积
  const restarted = await bridge.start();
  assert.equal(restarted.tools.length, 9);
  assert.equal(ctx.registeredTools.length, 9);
  assert.equal(ctx.sections.size, 2);
  bridge.stop();
  assert.equal(ctx.registeredTools.length, 0);
});

test("R1 组合：active 模式下加载器拒绝 → start 抛 UNSUPPORTED 且宿主零残留", async () => {
  const ctx = fakePluginCtx();
  const host = createDshHostAbstraction(ctx, {
    trustedScopeId: "amber",
    loadDshTools: async () => { throw new Error("module not found"); },
  });
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "active", config: ACTIVE_CONFIG });
  await assert.rejects(() => bridge.start(), (e) => e.code === "UNSUPPORTED");
  // section 先于工具注册成功，也必须被回收
  assert.equal(ctx.sections.size, 0);
  assert.equal(ctx.registeredTools.length, 0);
  assert.equal((ctx.handlers.get("session/event") ?? new Set()).size, 0, "失败启动不得泄漏订阅");
});

// ── P1-COMPLETION：监听器 Promise 跟踪与 flushCompletedTools 排空 ─────────────

test("P1 flushCompletedTools：等待在途 Promise 监听器并报告失败；disposer 签名不变", async () => {
  const ctx = fakePluginCtx();
  const host = createDshHostAbstraction(ctx, { trustedScopeId: "amber" });
  assert.equal(host.capabilities.completedToolFlush, true);

  const processed = [];
  let rejectNext = false;
  let throwNext = false;
  const dispose = host.subscribeCompletedTools((event) => {
    if (throwNext) { throwNext = false; throw new Error("sync boom"); }
    if (rejectNext) {
      rejectNext = false;
      return Promise.reject(new Error("async boom"));
    }
    return new Promise((resolve) => setTimeout(() => { processed.push(event.eventId); resolve(); }, 5));
  });
  assert.equal(typeof dispose, "function");

  const dispatch = (event) => {
    for (const handler of ctx.handlers.get("session/event") ?? []) handler({ id: "s" }, event);
  };
  rejectNext = true;
  dispatch({ type: "tool/ptc-dispatch", seq: 1, data: { name: "compress", isError: false, blocksCreated: 1 } });
  throwNext = true;
  dispatch({ type: "tool/ptc-dispatch", seq: 2, data: { name: "compress", isError: false, blocksCreated: 1 } });
  dispatch({ type: "tool/ptc-dispatch", seq: 3, data: { name: "compress", isError: false, blocksCreated: 1 } });
  // 未 flush 前：在途回调尚未完成
  assert.ok(processed.length < 2);

  const report = await host.flushCompletedTools();
  assert.equal(report.waited, 2, "同步 throw 不进在途集合；Promise 监听器 2 个在途");
  assert.equal(processed.length, 1, "seq1 走拒绝分支、seq2 同步 throw，只有 seq3 入列");
  assert.equal(report.failures.length, 2, JSON.stringify(report.failures));
  assert.ok(report.failures.some((f) => /async boom/.test(f)), report.failures.join(" | "));
  assert.ok(report.failures.some((f) => /sync boom/.test(f)), report.failures.join(" | "));
  // 失败清单消费后清零（不重复上报）
  const second = await host.flushCompletedTools();
  assert.equal(second.failures.length, 0);
  assert.equal(second.dispatched, 3);

  // 旧式无返回值监听器：fire-and-forget，不进在途集合
  dispose();
  const dispose2 = host.subscribeCompletedTools(() => {});
  dispatch({ type: "tool/ptc-dispatch", seq: 4, data: { name: "compress", isError: false, blocksCreated: 1 } });
  const third = await host.flushCompletedTools();
  assert.equal(third.waited, 0);
  assert.equal(third.dispatched, 4);
  assert.equal(third.syncListenerFailures, 1, "同步抛出必须显式计数（attempt 3）");
  dispose2();
});

test("P1 flushCompletedTools（attempt 3）：归一化失败与同步抛出对 flush/diagnostics 显式可见", async () => {
  const ctx = fakePluginCtx();
  const host = createDshHostAbstraction(ctx, { trustedScopeId: "amber" });
  const dispose = host.subscribeCompletedTools((event) => ({ advanced: false, reason: "ignored" }));

  const dispatch = (event) => {
    for (const handler of ctx.handlers.get("session/event") ?? []) handler({ id: "s" }, event);
  };

  // 路径 1：归一化失败（data getter 抛错 → mapRawSessionEvent 抛出被丢弃）
  dispatch({
    type: "tool/ptc-dispatch",
    seq: 1,
    get data() { throw new Error("corrupt payload"); },
  });

  // 路径 2：监听器同步抛出
  const thrower = host.subscribeCompletedTools(() => { throw new Error("sync kaboom"); });
  dispatch({ type: "tool/ptc-dispatch", seq: 2, data: { name: "compress", isError: false, blocksCreated: 1 } });

  const report = await host.flushCompletedTools();
  assert.equal(report.normalizeFailures, 1, `归一化失败必须可观测：${JSON.stringify(report)}`);
  assert.equal(report.syncListenerFailures, 1, `同步抛出必须可观测：${JSON.stringify(report)}`);
  assert.ok(report.failures.some((f) => /sync kaboom/.test(f)), report.failures.join(" | "));
  // diagnostics 同样可见（不只散落在 droppedEvents）
  const diag = host.diagnostics();
  assert.equal(diag.normalizeFailures, 1);
  assert.equal(diag.syncListenerFailures, 1);
  assert.equal(diag.droppedEvents.length, 1, "归一化失败仍保留 droppedEvents 证据");
  // 计数为累计值：再次 flush 不清零（与 failures 清单的「消费后清零」语义区分）
  const again = await host.flushCompletedTools();
  assert.equal(again.normalizeFailures, 1);
  assert.equal(again.syncListenerFailures, 1);
  assert.equal(again.failures.length, 0);

  dispose();
  thrower();
});

test("P1 双路径去重（端到端）：direct tool/result 与同调用 PTC dispatch 只推进一次", async () => {
  const ctx = fakePluginCtx();
  const host = createDshHostAbstraction(ctx, { trustedScopeId: "amber" });
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "shadow" });
  await bridge.start();

  const dispatch = (session, event) => {
    for (const handler of ctx.handlers.get("session/event") ?? []) handler(session, event);
  };
  const flush = () => new Promise((r) => setImmediate(r));
  // direct：compress tool/call c9 → tool/result（meta.blocksCreated=2）→ 推进
  dispatch({ id: "s1" }, { type: "tool/call", seq: 1, data: { callId: "c9", name: "compress", arguments: {} } });
  dispatch({ id: "s1" }, {
    type: "tool/result", seq: 2,
    data: { message: { callId: "c9", content: [], isError: false }, meta: { blocksCreated: 2 } },
  });
  await flush();
  assert.equal(bridge.diagnostics().probe.epoch, 1);

  // PTC：同一底层调用（parentCallId=c9）带文本证据 2 → duplicate-call，不再推进
  dispatch({ id: "s1" }, {
    type: "tool/ptc-dispatch", seq: 3,
    data: {
      rootCallId: "c9", parentCallId: "c9", subCallId: "c9:ptc:1",
      name: "compress", isError: false,
      content: [{ type: "text", text: "[Compressed m00001–m00002 → 2 block(s), ~1234 tokens saved.]" }],
    },
  });
  await flush();
  assert.equal(bridge.diagnostics().probe.epoch, 1, "同一底层调用不得双计");
  assert.equal(bridge.diagnostics().probe.duplicateCallEvents, 1);
  // 诊断里能看到该事件的 duplicate-call 原因
  assert.equal(bridge.diagnostics().recentEvents.at(-1).reason, "duplicate-call");

  bridge.stop();
});

test("P1 assembleDshShioriHost：probeSink 原样转交桥（合成 sink，不落真实磁盘）", async () => {
  const ctx = fakePluginCtx();
  const saved = [];
  const probeSink = {
    async load() { return saved.at(-1) ?? null; },
    async save(snapshot) { saved.push(snapshot); },
  };
  const assembled = await assembleDshShioriHost(ctx, {
    service: createFakeService(),
    mode: "shadow",
    probeSink,
  });
  await assembled.start();
  for (const handler of ctx.handlers.get("session/event") ?? []) {
    handler({ id: "s1" }, {
      type: "tool/ptc-dispatch", seq: 1,
      data: { name: "compress", isError: false, blocksCreated: 2 },
    });
  }
  await new Promise((r) => setImmediate(r));
  assert.equal(assembled.bridge.diagnostics().probe.persistence, "sink", "probeSink 必须真实接桥");
  assert.ok(saved.length >= 1);
  assert.equal(saved.at(-1).epoch, 1);
  // host 的 flushCompletedTools 可用（转交自 createDshShioriHost）
  const report = await assembled.host.flushCompletedTools();
  assert.equal(report.failures.length, 0);
  assembled.stop();
});
