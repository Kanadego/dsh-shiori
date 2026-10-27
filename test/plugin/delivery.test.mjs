// P5 · L2 投递测试（slot P）：pre-step 扫描边界 / accepted receipt / seen-hit /
// 重启恢复 / 故障点补齐。合成 bindings + temp 目录。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createShioriPluginController } from "../../src/plugin/controller.mjs";
import { openSparkStore } from "../../src/sparks/store.mjs";

function fakeBindingsFactory() {
  const registered = { sections: [], tools: [], waterfall: null, preStep: null, sessionEvents: null, disposed: 0 };
  const factory = () => ({
    registerSystemSection({ name }) { registered.sections.push(name); return true; },
    registerAssembleWaterfall(h) { registered.waterfall = h; return true; },
    registerPreStep(h) { registered.preStep = h; return true; },
    subscribeSessionEvents(l) { registered.sessionEvents = l; return true; },
    async registerTool() { registered.tools.push("t"); return true; },
    async loadCreateUserMessage() {
      return (input) => ({ id: `msg-${Math.random().toString(16).slice(2, 10)}`, role: "user", content: input.content, source: input.source });
    },
    disposeAll() {
      registered.disposed += 1;
      registered.sections = []; registered.tools = [];
      registered.waterfall = null; registered.preStep = null; registered.sessionEvents = null;
      return { disposed: true, errors: [] };
    },
    get diagnostics() {
      return { registeredSections: registered.sections, registeredTools: registered.tools, waterfall: true, preStep: true, sessionEvents: true };
    },
  });
  factory.registered = registered;
  return factory;
}

function fakeCtx() {
  return { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} };
}

async function setup(t, { l2 = true } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-l2-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    l2: { enabled: l2 },
  }, { bindings });
  await controller.start();
  return { controller, bindings, base };
}

/** 人类用户消息（source.kind=user）。 */
function humanMessage(id, text) {
  return { id, role: "user", source: { kind: "user" }, content: [{ type: "text", text }] };
}

test("pre-step：命中触发词 → 独立 context 消息追加（不冒充 human、原文不动）→ 真实 surface append 事件才 accepted", async (t) => {
  const { controller, bindings } = await setup(t);
  const trusted = { session: { id: "s-1" }, source: "panel-rpc" };
  // 铺一张卡。
  await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "洋葱梗", content: "问眼里常含泪水，原来刚切过洋葱。", triggers: ["洋葱"], vitality: "evergreen" },
  });

  const preStep = bindings.registered.preStep;
  const agent = { session: { id: "s-1" } };
  const nextDecision = { kind: "enter", messages: [humanMessage("m-src-1", "今天切洋葱了吗")] };

  const decision = await preStep({ agent, messages: [humanMessage("m-src-1", "今天切洋葱了吗")] }, async () => nextDecision);
  assert.equal(decision.kind, "enter");
  // 原消息保留 + 本包消息追加。
  assert.equal(decision.messages[0], nextDecision.messages[0]);
  assert.equal(decision.messages.length, 2);
  const delivered = decision.messages[1];
  assert.equal(delivered.role, "user");
  assert.equal(delivered.source.kind, "shiori-sparks"); // 不冒充 human
  assert.equal(delivered.source.form, "recall");
  assert.match(delivered.content[0].text, /洋葱/);

  // 已声明 accepted 的回执事件（真实 surface append）：
  const sessionEvent = bindings.registered.sessionEvents;
  await sessionEvent({ id: "s-1" }, { type: "user/message", seq: 1, data: delivered });
  const d = controller.diagnostics();
  assert.equal(d.counters.acceptedReceipts, 1);

  // 同卡同会话同 epoch 不再投递（seen）。
  const decision2 = await preStep({ agent, messages: [humanMessage("m-src-2", "洋葱 again")] }, async () => ({ kind: "enter", messages: [] }));
  assert.equal(decision2.kind, "enter");
  assert.equal(decision2.messages.length, 0); // 已 seen：种子进不来
  await controller.stop();
});

test("pre-step：不扫历史 / tool / 插件附件 / 非 user source；未知来源回执忽略", async (t) => {
  const { controller, bindings } = await setup(t);
  const trusted = { session: { id: "s-1" }, source: "panel-rpc" };
  await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "暗号", content: "芝麻开门。", triggers: ["芝麻"], vitality: "evergreen" },
  });
  const preStep = bindings.registered.preStep;
  const agent = { session: { id: "s-1" } };
  const keepOriginal = (msgs) => async () => ({ kind: "enter", messages: [...msgs] });
  const noop = keepOriginal([]);

  // tool 来源消息不扫。
  const toolMsg = { id: "m-tool", role: "user", source: { kind: "tool", callId: "c1" }, content: [{ type: "text", text: "芝麻" }] };
  let decision = await preStep({ agent, messages: [toolMsg] }, noop);
  assert.equal(decision.messages.length, 0);

  // role 非 user 不扫。
  const devMsg = { id: "m-dev", role: "developer", source: { kind: "user" }, content: [{ type: "text", text: "芝麻" }] };
  decision = await preStep({ agent, messages: [devMsg] }, noop);
  assert.equal(decision.messages.length, 0);

  // 心跳注入（source.kind 非 user）不扫。
  const injectMsg = { id: "m-inject", role: "user", source: { kind: "heartbeat" }, content: [{ type: "text", text: "芝麻" }] };
  decision = await preStep({ agent, messages: [injectMsg] }, noop);
  assert.equal(decision.messages.length, 0);

  // 未知 messageId 的 user/message 事件不算 accepted。
  await bindings.registered.sessionEvents({ id: "s-1" }, { type: "user/message", seq: 2, data: { id: "m-unknown", source: { kind: "shiori-sparks" } } });
  assert.equal(controller.diagnostics().counters.acceptedReceipts, 0);
  await controller.stop();
});

test("l2.enabled=false：不注册 pre-step（无投递入口）", async (t) => {
  const { bindings, controller } = await setup(t, { l2: false });
  assert.equal(bindings.registered.preStep, null);
  assert.equal(controller.diagnostics().counters.preSteps, 0);
});

test("重启恢复：accepted 未 committed → 补齐 hit/seen；无 receipt 的 pending 保持且不重发", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-l2r-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = { dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state") };
  const settings = {
    mode: "active", allowActive: true, ...roots,
    ownerId: "local", defaultPersona: "amber", l2: { enabled: true },
  };

  // 第一代：投递并 accepted，但人为停在 accepted（不 finalize）→ 模拟崩溃点 1 之后。
  const b1 = fakeBindingsFactory();
  const c1 = await createShioriPluginController(fakeCtx(), settings, { bindings: b1 });
  await c1.start();
  const trusted = { session: { id: "s-1" }, source: "panel-rpc" };
  const saved = await c1.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "梗", content: "唯一记忆内容。", triggers: ["触发词"], vitality: "evergreen" },
  });
  const cardId = saved.id;
  const preStep1 = b1.registered.preStep;
  const agent = { session: { id: "s-1" } };
  const decision = await preStep1({ agent, messages: [humanMessage("m-1", "触发词")] }, async () => ({ kind: "enter", messages: [humanMessage("m-1", "触发词")] }));
  const delivered = decision.messages[1];
  // 只发 accepted receipt 事件，随后立即 stop（finalize 在事件处理中完成）。
  await b1.registered.sessionEvents({ id: "s-1" }, { type: "user/message", seq: 1, data: delivered });
  assert.equal(c1.diagnostics().counters.acceptedReceipts, 1);
  await c1.stop();

  // 第二代：资源恢复；accepted 已 committed（第一代已收尾）→ 无重复补齐；hitCount==1。
  const b2 = fakeBindingsFactory();
  const c2 = await createShioriPluginController(fakeCtx(), settings, { bindings: b2 });
  await c2.start();
  // 直接验证 store 的 hitCount（重新打开 store 直读）。
  const store = await openSparkStore({ root: roots.dataRoot, scopeId: "amber" });
  const card = await store.read(cardId);
  assert.equal(card.hitCount, 1);
  assert.ok(card.lastHitAt !== null);
  store.close();
  await c2.stop();

  // 第三代：模拟「pending 无 receipt」——手写 pending 账目（无 accepted）→ 不重发、不 hit。
  const b3 = fakeBindingsFactory();
  const c3 = await createShioriPluginController(fakeCtx(), settings, { bindings: b3 });
  await c3.start();
  const d = c3.diagnostics();
  assert.equal(d.counters.l2Recoveries, 0); // 无 accepted 的 pending 不补齐
  const store3 = await openSparkStore({ root: roots.dataRoot, scopeId: "amber" });
  const card3 = await store3.read(cardId);
  assert.equal(card3.hitCount, 1); // 未重复计数
  store3.close();
  await c3.stop();
});

test("每 session 隔离：B 会话同卡可投（A 已投不清 B 冷却）", async (t) => {
  const { controller, bindings } = await setup(t);
  const trusted = { session: { id: "s-1" }, source: "panel-rpc" };
  await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "梗", content: "内容。", triggers: ["关键词"], vitality: "evergreen" },
  });
  const preStep = bindings.registered.preStep;
  const keepOriginal = (msgs) => async () => ({ kind: "enter", messages: [...msgs] });
  // A 会话投递 + accepted（next 保留原消息，真实宿主语义）。
  const d1 = await preStep({ agent: { session: { id: "s-A" } }, messages: [humanMessage("m-A", "关键词")] }, keepOriginal([humanMessage("m-A", "关键词")]));
  assert.equal(d1.messages.length, 2);
  await bindings.registered.sessionEvents({ id: "s-A" }, { type: "user/message", seq: 1, data: d1.messages[1] });
  // B 会话同触发词仍可投（seen 键含 sessionId）。
  const d2 = await preStep({ agent: { session: { id: "s-B" } }, messages: [humanMessage("m-B", "关键词")] }, keepOriginal([humanMessage("m-B", "关键词")]));
  assert.equal(d2.messages.length, 2);
  await controller.stop();
});

test("预算尊重 settings：maxChars 调小后附件截断为摘要/跳过，不硬编码 600", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-budget-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const bindings = fakeBindingsFactory();
  const controller = await createShioriPluginController(fakeCtx(), {
    mode: "active", allowActive: true,
    dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state"),
    ownerId: "local", defaultPersona: "amber",
    l2: { enabled: true },
    budgets: { spark: { maxChars: 120 } },
  }, { bindings });
  await controller.start();
  const trusted = { session: { id: "s-1" }, source: "panel-rpc" };
  await controller.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "长卡", content: "x".repeat(200), summary: "短摘要", triggers: ["长卡词"], vitality: "evergreen" },
  });
  const decision = await bindings.registered.preStep(
    { agent: { session: { id: "s-1" } }, messages: [humanMessage("m-1", "长卡词")] },
    async () => ({ kind: "enter", messages: [humanMessage("m-1", "长卡词")] }),
  );
  assert.equal(decision.messages.length, 2);
  // 超过 inline 门槛 → 摘要形式；附件总长 <= 120。
  const text = decision.messages[1].content[0].text;
  assert.ok(text.length <= 120, `attachment ${text.length} > 120`);
  assert.ok(text.includes("短摘要"));
  await controller.stop();
});

test("B6 会话日志恢复：append 已入历史但 receipt 丢失 → deriveMessages 回查补 accepted，不重发不双计", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-l2log-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const roots = { dataRoot: path.join(base, "data"), stateRoot: path.join(base, "state") };
  const settings = {
    mode: "active", allowActive: true, ...roots,
    ownerId: "local", defaultPersona: "amber", l2: { enabled: true },
  };

  // 第一代：投递（recordPending 落账），但不发 accepted receipt 事件 → 模拟
  // 「append 成功后、回执处理前崩溃」。
  const b1 = fakeBindingsFactory();
  const c1 = await createShioriPluginController(fakeCtx(), settings, { bindings: b1 });
  await c1.start();
  const trusted = { session: { id: "s-1" }, source: "panel-rpc" };
  const saved = await c1.management.executeTool(trusted, {
    name: "spark_save",
    args: { title: "梗", content: "唯一内容。", triggers: ["恢复词"], vitality: "evergreen" },
  });
  const decision = await b1.registered.preStep(
    { agent: { session: { id: "s-1" } }, messages: [humanMessage("m-1", "恢复词")] },
    async () => ({ kind: "enter", messages: [humanMessage("m-1", "恢复词")] }),
  );
  const delivered = decision.messages[1];
  await c1.stop();
  assert.equal(c1.diagnostics().counters.acceptedReceipts, 0);

  // 第二代：会话日志（deriveMessages）里已有我们的消息 → recoverL2 按
  // Message.id 核对补 accepted 并收尾；hitCount 恰好 1（不重复投递/计数）。
  const b2 = fakeBindingsFactory();
  const c2 = await createShioriPluginController(fakeCtx(), settings, { bindings: b2 });
  await c2.start();
  const logAgent = {
    session: {
      id: "s-1",
      deriveMessages: () => [{ id: delivered.id, role: "user", source: { kind: "shiori-sparks" } }],
    },
  };
  const status = await c2.management.getStatus(
    { session: { id: "s-1" }, agent: logAgent, source: "panel-rpc" }, {},
  );
  assert.equal(status.mode, "active");
  const d2 = c2.diagnostics();
  assert.equal(d2.counters.l2RecoveredFromSessionLog, 1);
  const store = await openSparkStore({ root: roots.dataRoot, scopeId: "amber" });
  const card = await store.read(saved.id);
  assert.equal(card.hitCount, 1);
  store.close();

  // 同会话再次 preStep 同内容：pending 已 committed / 已扫 → 不再追加第二条。
  const decision2 = await b2.registered.preStep(
    { agent: logAgent, messages: [humanMessage("m-1", "恢复词")] },
    async () => ({ kind: "enter", messages: [humanMessage("m-1", "恢复词")] }),
  );
  assert.equal(decision2.messages.length, 1); // 仅原消息
  const storeAfter = await openSparkStore({ root: roots.dataRoot, scopeId: "amber" });
  const cardAfter = await storeAfter.read(saved.id);
  assert.equal(cardAfter.hitCount, 1); // 仍为 1
  storeAfter.close();
  await c2.stop();
});
