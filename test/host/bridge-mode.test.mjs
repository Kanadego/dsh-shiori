import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostBridge } from "../../src/host/index.mjs";
import { SECTION_CORE, SECTION_PERSONA } from "../../src/host/index.mjs";
import { isCodedError } from "../../src/host/errors.mjs";
import { ACTIVE_CONFIG, createFakeHost, createFakeService } from "./helpers.mjs";

const TOOL_NAMES = [
  "soul_read", "soul_update", "memory_read", "memory_search", "memory_append",
  "memory_rewrite", "core_write", "topic_append", "memory_list_topics",
];

test("createHostBridge 校验依赖与模式", () => {
  assert.throws(() => createHostBridge({}), (e) => isCodedError(e) && e.code === "INVALID_INPUT");
  assert.throws(
    () => createHostBridge({ host: createFakeHost(), service: createFakeService(), mode: "aggressive" }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT",
  );
  // active 必须显式 allowActive
  assert.throws(
    () => createHostBridge({ host: createFakeHost(), service: createFakeService(), mode: "active" }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT",
  );
});

test("shadow：零 section、零同名工具注册，零写入", async () => {
  const host = createFakeHost();
  const service = createFakeService();
  const bridge = createHostBridge({ host, service, mode: "shadow" });
  const started = await bridge.start();
  assert.equal(started.mode, "shadow");
  assert.deepEqual(started.sections, []);
  assert.deepEqual(started.tools, []);

  // 事件订阅只读；探针工作
  assert.equal(host.listenerCount(), 1);
  const obs = await bridge.onCompletedTool({
    eventId: "e1", sessionId: "s1", name: "compress", success: true, blocksCreated: 2,
  });
  assert.equal(obs.advanced, true);

  assert.equal(host.sections.size, 0);
  assert.equal(host.tools.size, 0);
  assert.equal(service.mutateLog.length, 0);
  const diag = bridge.diagnostics();
  assert.equal(diag.mode, "shadow");
  assert.equal(diag.probe.epoch, 1);
  assert.equal(diag.l2Delivery, "unsupported-in-P0");

  await bridge.stop();
  assert.equal(host.listenerCount(), 0);
  assert.equal(service.mutateLog.length, 0);
});

test("shadow：stop 后没有任何 host 状态残留（零写不因 dispose 而破坏）", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "shadow" });
  await bridge.start();
  await bridge.stop();
  assert.equal(host.sections.size, 0);
  assert.equal(host.tools.size, 0);
  assert.equal(host.listenerCount(), 0);
});

test("active：完整注册两个 section 与九个兼容工具", async () => {
  const host = createFakeHost();
  const service = createFakeService({
    topics: [{ key: "proj-x", title: "项目X", summary: "排障手册", body: "# 项目X\n内容" }],
  });
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  const started = await bridge.start();
  assert.deepEqual(started.sections.sort(), [SECTION_CORE, SECTION_PERSONA].sort());
  assert.deepEqual(started.tools.sort(), [...TOOL_NAMES].sort());
  assert.equal(bridge.diagnostics().uniqueWriter, "verified");

  const personaOrder = host.sections.get(SECTION_PERSONA).order;
  const coreOrder = host.sections.get(SECTION_CORE).order;
  assert.equal(personaOrder, 0);
  assert.equal(coreOrder, 0.5);

  await bridge.stop();
  assert.equal(host.sections.size, 0);
  assert.equal(host.tools.size, 0);
});

test("active：宿主名单显示同名工具已被占用 → 唯一写者校验失败且不注册任何东西", async () => {
  const host = createFakeHost({ preOwnedTools: ["soul_read", "memory_read"] });
  const service = createFakeService();
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await assert.rejects(
    () => bridge.start(),
    (e) => isCodedError(e) && e.code === "INVALID_STATE" && /soul_read/.test(e.message),
  );
  assert.equal(host.sections.size, 0);
  assert.equal(host.tools.size, 0);
  assert.equal(host.listenerCount(), 0, "R2：失败启动必须连订阅一起撤回");
  assert.equal(bridge.diagnostics().uniqueWriter, "verified-before-registration");

  // R2：重复失败启动不累积订阅
  for (let i = 0; i < 3; i += 1) {
    await assert.rejects(() => bridge.start(), () => true);
  }
  assert.equal(host.listenerCount(), 0);

  // 成功重启后仅一次订阅
  const host2 = createFakeHost();
  const bridge2 = createHostBridge({ host: host2, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge2.start();
  assert.equal(host2.listenerCount(), 1);
  await bridge2.stop();
});

test("active：注册时同名冲突（宿主抛 already registered）→ 中止并回收已注册 section 与订阅", async () => {
  const host = createFakeHost({ failToolRegistration: true });
  const service = createFakeService();
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await assert.rejects(
    () => bridge.start(),
    (e) => isCodedError(e) && e.code === "INVALID_STATE" && /already registered/.test(e.message),
  );
  // section 注册成功过，但回滚后必须一个不剩；订阅也不能泄漏
  assert.equal(host.sections.size, 0);
  assert.equal(host.tools.size, 0);
  assert.equal(host.listenerCount(), 0, "R2：注册冲突失败路径撤回全部注册");
});

test("R2：shadow 失败路径同样不泄漏（restore 抛错时回收订阅）", async () => {
  const host = createFakeHost();
  const badSink = {
    async load() { throw new Error("corrupted state file"); },
    async save() { throw new Error("unwritable"); },
  };
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "shadow", probeSink: badSink });
  await assert.rejects(() => bridge.start(), /corrupted state file/);
  assert.equal(host.listenerCount(), 0, "失败启动后订阅必须被撤回");
  assert.equal(host.sections.size, 0);
  assert.equal(host.tools.size, 0);
  // 失败后可以再次启动（换好 sink）
  const bridge2 = createHostBridge({ host, service: createFakeService(), mode: "shadow" });
  await bridge2.start();
  assert.equal(host.listenerCount(), 1);
  await bridge2.stop();
});

test("生命周期：start 后重复 start 拒绝；重复 stop 幂等；stop→start→stop 可循环", async () => {
  const host = createFakeHost();
  const bridge = createHostBridge({ host, service: createFakeService(), mode: "shadow" });
  await bridge.start();
  await assert.rejects(() => bridge.start(), (e) => isCodedError(e) && e.code === "INVALID_STATE");

  const first = bridge.stop();
  assert.ok(first.disposed >= 1);
  const second = bridge.stop();
  assert.equal(second.disposed, 0);
  assert.equal(host.listenerCount(), 0);

  await bridge.start(); // 重新启动
  assert.equal(host.listenerCount(), 1);
  bridge.stop();
  assert.equal(bridge.diagnostics().stopCount, 3);
  assert.equal(bridge.diagnostics().startCount, 2);
});

test("R3：class 实例 service（原型方法+私有字段）经桥包装后 receiver 正确", async () => {
  class ClassService {
    #mutateCalls = 0;
    constructor() { this.personaText = "# 类服务人设"; }
    async readPersona() {
      // 依赖 this（方法内访问实例字段）：包装层若改变 receiver 会直接失败
      return { name: "琥珀", text: this.personaText, revision: `r-${this.#mutateCalls}` };
    }
    async readCoreView() { return { text: "类服务核心。", revision: "rc1", scopeId: "amber" }; }
    async readCore() { return { text: "类服务核心。", revision: "rc1", scopeId: "amber" }; }
    async readTopic(key) { throw new Error(`topic "${key}" does not exist`); }
    async listTopics() { return []; }
    async search() { return []; }
    async mutate(request) {
      this.#mutateCalls += 1; // 私有字段：this 不是真实实例时抛 TypeError
      if (request.changes[0].kind === "persona") this.personaText = request.changes[0].text;
      return {
        operationId: request.operationId,
        generation: `g-${this.#mutateCalls}`,
        changes: request.changes.map((c) => ({ kind: c.kind, key: c.key, beforeRevision: null, afterRevision: `r-${this.#mutateCalls}` })),
        budget: {},
      };
    }
  }
  const service = new ClassService();
  const host = createFakeHost({ asyncSectionText: false }); // 同步快照路径同样要经 service 读取
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();

  const soulRead = await host.tools.get("soul_read").execute({});
  assert.equal(soulRead.content, "# 类服务人设", "readPersona 经包装后 receiver 正确");

  const receipt = await host.tools.get("soul_update").execute({ content: "# 类服务修订" });
  assert.equal(receipt.changes[0].kind, "persona");
  assert.equal(service.personaText, "# 类服务修订", "mutate 经包装后 receiver 正确");
  // mutate 后自动刷新快照也走了 service（section 渲染拿到新值）
  assert.equal(await host.renderSection("shiori:persona"), "# 类服务修订");
  await bridge.stop();
});

test("L2：桥从不注册 L2 section，也不接受 l2Delivery 配置", async () => {
  const host = createFakeHost();
  const service = createFakeService();
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();

  const names = [...host.sections.keys()];
  assert.deepEqual(names.sort(), [SECTION_CORE, SECTION_PERSONA].sort());
  for (const name of names) {
    assert.ok(name.startsWith("shiori:"), `unexpected section ${name}`);
  }
  // 工具集中不允许出现 spark_* / L2 投递工具
  for (const name of host.tools.keys()) {
    assert.ok(!name.startsWith("spark_"), `L2 tool ${name} must not be registered`);
  }
  await bridge.stop();

  assert.throws(
    () => createHostBridge({
      host: createFakeHost(),
      service: createFakeService(),
      config: { hostBridge: { allowActive: true, l2Delivery: "user-attachment" } },
    }),
    (e) => isCodedError(e) && e.code === "UNSUPPORTED",
  );
});
