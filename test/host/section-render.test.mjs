import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostBridge, SECTION_CORE, SECTION_PERSONA } from "../../src/host/index.mjs";
import { ACTIVE_CONFIG, createFakeHost, createFakeService } from "./helpers.mjs";

test("async section：逐次渲染，每次取到最新 persona / core / index", async () => {
  const host = createFakeHost({ asyncSectionText: true });
  const service = createFakeService({
    personaText: "# 琥珀 v1",
    coreText: "## 铁律\n第一版规则。",
    topics: [{ key: "topic-a", title: "A", summary: "第一条专题", body: "A 的正文" }],
  });
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();

  const persona1 = await host.renderSection(SECTION_PERSONA);
  const core1 = await host.renderSection(SECTION_CORE);
  assert.equal(persona1, "# 琥珀 v1");
  assert.ok(core1.includes("第一版规则。"), "core body rendered");
  assert.ok(core1.includes("## 主题记忆索引 / Topic memory index"), "derived index rendered");
  assert.ok(core1.includes("- topic-a [amber] — 第一条专题"), "index line rendered");

  // 外部变化（模拟下一次渲染前记忆被更新）→ 下一次渲染必须拿到最新内容
  service.state.persona.text = "# 琥珀 v2";
  service.state.core.text = "## 铁律\n第二版规则。";
  service.state.topics.set("topic-b", {
    key: "topic-b", title: "B", summary: "第二条", scopeId: "amber",
    updated: "2026-10-24", revision: "rev-t2", body: "B 的正文",
  });

  const persona2 = await host.renderSection(SECTION_PERSONA);
  const core2 = await host.renderSection(SECTION_CORE);
  assert.equal(persona2, "# 琥珀 v2", "persona re-read per render");
  assert.ok(core2.includes("第二版规则。"));
  assert.ok(core2.includes("- topic-a [amber] — 第一条专题"));
  assert.ok(core2.includes("- topic-b [amber] — 第二条"), "new topic appears in index");

  await bridge.stop();
});

test("sync snapshot（真实宿主形态）：快照在 start / mutate / 完成事件后刷新", async () => {
  const host = createFakeHost({ asyncSectionText: false });
  const service = createFakeService({ personaText: "# 琥珀 v1", coreText: "规则 v1。" });
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();

  assert.equal(await host.renderSection(SECTION_PERSONA), "# 琥珀 v1");

  // 外部直接改盘：快照窗口内不可见（已知限制，见 REPORT.md）
  service.state.persona.text = "# 琥珀 v2（手改）";
  assert.equal(await host.renderSection(SECTION_PERSONA), "# 琥珀 v1");

  // 手动 refresh 后可见
  await bridge.refresh();
  assert.equal(await host.renderSection(SECTION_PERSONA), "# 琥珀 v2（手改）");

  // 工具写入提交后自动刷新（soul_update → mutate → refreshSnapshot）
  const tools = host.tools;
  const soulUpdate = tools.get("soul_update");
  const receipt = await soulUpdate.execute({ content: "# 琥珀 v3（工具写入）" });
  assert.equal(receipt.projection, "written-pending-projection");
  assert.equal(await host.renderSection(SECTION_PERSONA), "# 琥珀 v3（工具写入）");

  await bridge.stop();
});

test("section 渲染只包含 L0/L1：core 渲染来自 readCoreView，桥不做本地渲染", async () => {
  const host = createFakeHost({ asyncSectionText: true });
  const service = createFakeService({
    coreText: "核心正文。",
    topics: [{ key: "t", title: "T", summary: "摘要", body: "正文" }],
  });
  // 监视 service 调用：section 文本必须来自 service（B 的渲染器），桥不得自行拼索引
  let coreViewCalls = 0;
  const orig = service.readCoreView.bind(service);
  service.readCoreView = async (...args) => {
    coreViewCalls += 1;
    return orig(...args);
  };
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();
  const before = coreViewCalls;
  const rendered = await host.renderSection(SECTION_CORE);
  assert.ok(coreViewCalls > before, "core section text must read through service.readCoreView");
  // 桥注册的 text 函数交还宿主投影；桥自己不调用 system/project
  assert.equal(typeof host.sections.get(SECTION_CORE).text, "function");
  assert.ok(rendered.includes("核心正文。"));
  await bridge.stop();
});
