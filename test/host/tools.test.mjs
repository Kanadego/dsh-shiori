import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostBridge } from "../../src/host/index.mjs";
import { isCodedError } from "../../src/host/errors.mjs";
import { ACTIVE_CONFIG, createFakeHost, createFakeService } from "./helpers.mjs";

async function activeBridge({ service, host } = {}) {
  const h = host ?? createFakeHost({ asyncSectionText: true });
  const s = service ?? createFakeService({
    topics: [{ key: "proj-x", title: "项目X", summary: "排障手册", body: "# 项目X\n已有内容" }],
  });
  const bridge = createHostBridge({ host: h, service: s, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();
  return { bridge, host: h, service: s };
}

test("读 payload 不接受任意 scope：混入 scope 一律 INVALID_INPUT", async () => {
  const { host, bridge } = await activeBridge();
  for (const name of ["soul_read", "soul_update", "memory_read", "memory_search", "memory_append", "memory_rewrite", "core_write", "topic_append", "memory_list_topics"]) {
    const tool = host.tools.get(name);
    const args = name === "core_write"
      ? { content: "x", expectedRevision: null, scope: "someone-else" }
      : name === "memory_read" ? { topic: "proj-x", scope: "someone-else" }
      : name === "memory_search" ? { query: "x", scope: "someone-else" }
      : { scope: "someone-else" };
    await assert.rejects(
      () => tool.execute(args),
      (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /scope/.test(e.message),
      `${name} must reject scope`,
    );
  }
  await bridge.stop();
});

test("所有写都走 service.mutate 且携带 expectedRevision（CAS），无旁路写", async () => {
  const { host, service, bridge } = await activeBridge();
  const soul = await host.tools.get("soul_update").execute({ content: "# 新人设" });
  const append = await host.tools.get("memory_append").execute({ section: "偏好", content: "少说废话" });
  const appendTopic = await host.tools.get("memory_append").execute({ section: "记录", content: "追加", topic: "proj-x" });
  const rewrite = await host.tools.get("memory_rewrite").execute({ content: "重写后的核心。" });
  const rewriteTopic = await host.tools.get("memory_rewrite").execute({ content: "重写专题。", topic: "proj-x" });
  const core = await service.readCore();
  const coreWrite = await host.tools.get("core_write").execute({ content: "全新核心。", expectedRevision: core.revision });
  const topicAppend = await host.tools.get("topic_append").execute({ topic: "proj-x", section: "新段", content: "新内容" });

  // 每次写都有且只有一条 mutate 记录，且每个 change 都带 expectedRevision
  assert.equal(service.mutateLog.length, 7);
  for (const entry of service.mutateLog) {
    for (const change of entry.request.changes) {
      assert.ok("expectedRevision" in change, "every change must carry expectedRevision");
    }
  }
  // fake service 的 mutate 本身执行 CAS：写入成功即证明 expectedRevision 与当时版本一致
  assert.ok(typeof service.mutateLog[1].request.changes[0].expectedRevision === "string");
  // 回执：revision、projection 状态、operationId
  for (const receipt of [soul, append, appendTopic, rewrite, rewriteTopic, coreWrite, topicAppend]) {
    assert.equal(receipt.projection, "written-pending-projection");
    assert.ok(receipt.revision === null || typeof receipt.revision === "string");
    assert.ok(typeof receipt.operationId === "string");
  }
  // topic 追加确实经服务生效
  const topic = await service.readTopic("proj-x");
  assert.ok(topic.body.includes("新内容"));
  await bridge.stop();
});

test("CAS 冲突如实上抛 REVISION_CONFLICT，不重试覆盖", async () => {
  const service = createFakeService();
  const failing = {
    ...service,
    async mutate(request) {
      const err = new Error("simulated concurrent writer");
      err.code = "REVISION_CONFLICT";
      throw err;
    },
  };
  const { host, bridge } = await activeBridge({ service: failing });
  await assert.rejects(
    () => host.tools.get("memory_rewrite").execute({ content: "覆盖尝试" }),
    (e) => isCodedError(e) && e.code === "REVISION_CONFLICT",
  );
  await bridge.stop();
});

test("core_write：expectedRevision 必须显式；section 参数 UNSUPPORTED；operationId 幂等透传", async () => {
  const { host, service, bridge } = await activeBridge();
  const tool = host.tools.get("core_write");

  await assert.rejects(
    () => tool.execute({ content: "x" }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () => tool.execute({ content: "x", expectedRevision: "wrong" }),
    (e) => isCodedError(e) && e.code === "REVISION_CONFLICT",
  );
  await assert.rejects(
    () => tool.execute({ content: "x", expectedRevision: null, section: "偏好" }),
    (e) => isCodedError(e) && e.code === "UNSUPPORTED" && /section/.test(e.message),
  );

  const core = await service.readCore();
  const receipt = await tool.execute({ content: "新核心", expectedRevision: core.revision, operationId: "op-123" });
  assert.equal(receipt.operationId, "op-123");
  assert.equal(service.mutateLog.at(-1).request.operationId, "op-123");
  await bridge.stop();
});

test("core_write：新文件 expectedRevision=null 可首次创建；已有文件传 null 冲突", async () => {
  const service = createFakeService({ coreText: "" });
  const { host, bridge } = await activeBridge({ service });
  const tool = host.tools.get("core_write");
  const receipt = await tool.execute({ content: "首次创建的核心。", expectedRevision: null });
  assert.equal(receipt.changes[0].beforeRevision, null);
  assert.ok(typeof receipt.revision === "string");

  await assert.rejects(
    () => tool.execute({ content: "再次用 null", expectedRevision: null }),
    (e) => isCodedError(e) && e.code === "REVISION_CONFLICT",
  );
  await bridge.stop();
});

test("memory_append 无 topic：追加到磁盘 core 正文，日期标题格式与 soul-md 兼容", async () => {
  const { host, service, bridge } = await activeBridge();
  await host.tools.get("memory_append").execute({ section: "踩坑", content: "Windows 路径要转义" });
  const core = await service.readCore();
  assert.match(core.text, /## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — 踩坑\n\nWindows 路径要转义\n$/);
  await bridge.stop();
});

test("soul_update：persona 委托（后续集成 service 实现独立 CAS 持久化，此处以 stub 验证）", async () => {
  const { host, service, bridge } = await activeBridge();
  const receipt = await host.tools.get("soul_update").execute({ content: "# 琥珀 修订版" });
  assert.equal(receipt.changes[0].kind, "persona");
  const persona = await service.readPersona();
  assert.equal(persona.text, "# 琥珀 修订版");
  // 超上限拒绝（config.persona.maxChars）
  const tightConfig = { ...ACTIVE_CONFIG, persona: { maxChars: 10 } };
  const host2 = createFakeHost();
  const service2 = createFakeService();
  const bridge2 = createHostBridge({ host: host2, service: service2, mode: "active", config: tightConfig });
  await bridge2.start();
  await assert.rejects(
    () => host2.tools.get("soul_update").execute({ content: "太长的人设内容，超过十个字符" }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /maxChars/.test(e.message),
  );
  await bridge2.stop();
  await bridge.stop();
});

test("memory_read：无参读完整渲染视图；topic 读全文；不静默截断", async () => {
  const longBody = "字".repeat(5000);
  const { host, service, bridge } = await activeBridge({
    service: createFakeService({
      topics: [{ key: "long", title: "长文", summary: "很长", body: longBody }],
    }),
  });
  const view = await host.tools.get("memory_read").execute({});
  assert.ok(view.exists);
  assert.ok(view.content.includes("## 主题记忆索引 / Topic memory index"));
  assert.equal(view.truncated, false);

  const topic = await host.tools.get("memory_read").execute({ topic: "long" });
  assert.equal(topic.content, longBody);
  assert.equal(topic.bytes, Buffer.byteLength(longBody, "utf8"));

  await assert.rejects(
    () => host.tools.get("memory_read").execute({ topic: "不存在" }),
    (e) => isCodedError(e) && e.code === "INVALID_STATE",
  );
  await bridge.stop();
});

test("memory_search / memory_list_topics：结果形状与 limit 校验", async () => {
  const { host, bridge } = await activeBridge();
  const found = await host.tools.get("memory_search").execute({ query: "排障" });
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].key, "proj-x");

  await assert.rejects(
    () => host.tools.get("memory_search").execute({ query: "x", limit: 0 }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT",
  );
  await assert.rejects(
    () => host.tools.get("memory_search").execute({ query: "x", limit: 99 }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT",
  );

  const listed = await host.tools.get("memory_list_topics").execute({});
  assert.equal(listed.topics.length, 1);
  assert.equal(listed.topics[0].key, "proj-x");
  assert.equal(typeof listed.topics[0].chars, "number");
  assert.equal(typeof listed.topics[0].bytes, "number");
  assert.equal(listed.topics[0].body, undefined, "list must not leak bodies");
  await bridge.stop();
});

test("service 缺 readCore 时核心写路径显式 UNSUPPORTED（不拿渲染视图回写）", async () => {
  const service = createFakeService();
  delete service.readCore;
  const { host, bridge } = await activeBridge({ service });
  await assert.rejects(
    () => host.tools.get("memory_rewrite").execute({ content: "试图覆盖" }),
    (e) => isCodedError(e) && e.code === "UNSUPPORTED" && /readCore/.test(e.message),
  );
  await bridge.stop();
});

test("R5：persona 上限按 UTF-16 code units 计，UTF-8 bytes 仅作诊断", async () => {
  const config = { ...ACTIVE_CONFIG, persona: { maxChars: 100 } };
  const host = createFakeHost();
  const service = createFakeService();
  const bridge = createHostBridge({ host, service, mode: "active", config });
  await bridge.start();
  const tool = host.tools.get("soul_update");

  // 5000 个中文字符 = 5000 UTF16（15000 UTF8 bytes）：按 UTF16 计 100 上限时拒绝，
  // 但错误详情里必须显示 bytes 只是诊断信息
  await assert.rejects(
    () => tool.execute({ content: "汉".repeat(150) }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && e.details.chars === 150 && e.details.bytes === 450,
  );

  // 恰好 100 个 UTF16：通过
  await tool.execute({ content: "汉".repeat(100) });
  // 101 个：拒绝
  await assert.rejects(() => tool.execute({ content: "汉".repeat(101) }), (e) => e.code === "INVALID_INPUT");

  // 合法成对非 BMP（emoji 对 = 2 UTF16 units）：50 个 emoji = 100 units，通过
  await tool.execute({ content: "😀".repeat(50) });
  // 51 个 emoji = 102 units：拒绝
  await assert.rejects(() => tool.execute({ content: "😀".repeat(51) }), (e) => e.code === "INVALID_INPUT");
  await bridge.stop();
});

test("R5：孤立代理（会破坏无损编码的文本）显式拒绝", async () => {
  const host = createFakeHost();
  const bridge = await (async () => {
    const b = createHostBridge({ host, service: createFakeService(), mode: "active", config: ACTIVE_CONFIG });
    await b.start();
    return b;
  })();
  await assert.rejects(
    () => host.tools.get("soul_update").execute({ content: "好人设\uD800" }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /surrogate/i.test(e.message),
  );
  await bridge.stop();
});

test("R6：旧 memory 工具的 core / core.md 别名指向 core（大小写不敏感，trim 生效）", async () => {
  const { host, service, bridge } = await activeBridge();
  // 读：别名与无参一致，都返回完整渲染视图
  const bare = await host.tools.get("memory_read").execute({});
  for (const alias of ["core", "core.md", "CORE", "Core.MD", "  core  "]) {
    const viaAlias = await host.tools.get("memory_read").execute({ topic: alias });
    assert.equal(viaAlias.content, bare.content, `alias "${alias}"`);
    assert.ok(viaAlias.content.includes("## 主题记忆索引"), "渲染视图（含索引）");
  }
  // 追加：别名写入磁盘 core 正文（不是 topic），带日期标题
  await host.tools.get("memory_append").execute({ section: "别名追加", content: "走 core", topic: "core.md" });
  const core = await service.readCore();
  assert.match(core.text, /## \d{4}-\d{2}-\d{2} \d{2}:\d{2} — 别名追加\n\n走 core\n$/);
  assert.equal(service.state.topics.has("core"), false, "不得误建名为 core 的 topic");
  // 重写：别名替换磁盘 core
  await host.tools.get("memory_rewrite").execute({ content: "别名重写后的核心。", topic: "CORE" });
  assert.equal((await service.readCore()).text, "别名重写后的核心。");
  await bridge.stop();
});

test("R6：topic_append 显式拒绝 core 别名；正常 topic 分支不受影响", async () => {
  const { host, service, bridge } = await activeBridge();
  for (const alias of ["core", "core.md", "CORE.MD"]) {
    await assert.rejects(
      () => host.tools.get("topic_append").execute({ topic: alias, section: "s", content: "c" }),
      (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /reserved core alias/.test(e.message),
    );
  }
  assert.equal(service.mutateLog.length, 0, "拒绝时不得有任何写入");
  await host.tools.get("topic_append").execute({ topic: "proj-x", section: "正常", content: "内容" });
  assert.ok((await service.readTopic("proj-x")).body.includes("内容"));
  await bridge.stop();
});
