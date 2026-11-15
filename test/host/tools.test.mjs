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
  const receipt = await host.tools.get("soul_update").execute({ content: "# 示例 修订版" });
  assert.equal(receipt.changes[0].kind, "persona");
  const persona = await service.readPersona();
  assert.equal(persona.text, "# 示例 修订版");
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

test("memory_search：归档摘要条目原样透传（state=archived、score=0、排在未归档之后），limit 截断不吞未归档结果", async () => {
  const { host, service, bridge } = await activeBridge();
  // 服务层已保证排序（未归档在前、归档在后且只回摘要级）；桥透传并只做 limit 截断
  service.search = async (query) => [
    { key: "warm", title: "热专题", summary: "排障热版", scopeId: "amber", score: 2 },
    { key: "cold-1", title: "冷专题一", summary: "排障冷版一", scopeId: "amber", score: 0, state: "archived" },
    { key: "cold-2", title: "冷专题二", summary: "排障冷版二", scopeId: "amber", score: 0, state: "archived" },
  ];
  const found = await host.tools.get("memory_search").execute({ query: "排障" });
  assert.deepEqual(found.matches.map((m) => [m.key, m.score, m.state ?? null]), [
    ["warm", 2, null],
    ["cold-1", 0, "archived"],
    ["cold-2", 0, "archived"],
  ]);
  for (const m of found.matches) {
    assert.ok(!("body" in m), "memory_search 不回正文");
  }
  // limit=1 只保留未归档首条：归档条目永远排在未归档之后
  const limited = await host.tools.get("memory_search").execute({ query: "排障", limit: 1 });
  assert.deepEqual(limited.matches.map((m) => m.key), ["warm"]);
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

test("core 正文自带派生索引一律拒绝：core_write / memory_rewrite / memory_append", async () => {
  const { host, service, bridge } = await activeBridge();
  const core = await service.readCore();
  const tainted = "正常正文。\n\n## 主题记忆索引 / Topic memory index\n- proj-x [amber] — 排障手册";
  await assert.rejects(
    () => host.tools.get("core_write").execute({ content: tainted, expectedRevision: core.revision }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /derived topic index/.test(e.message),
  );
  await assert.rejects(
    () => host.tools.get("memory_rewrite").execute({ content: tainted }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /derived topic index/.test(e.message),
  );
  await assert.rejects(
    () => host.tools.get("memory_append").execute({ section: "夹索引", content: tainted }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /derived topic index/.test(e.message),
  );
  assert.equal(service.mutateLog.length, 0, "拒绝时不得有任何写入");
  // 干净正文照常写；topic 正文不受这条限制（只有 core 渲染时拼索引）
  await host.tools.get("core_write").execute({ content: "干净的正文。", expectedRevision: core.revision });
  assert.equal((await service.readCore()).text, "干净的正文。");
  await host.tools.get("memory_append").execute({ section: "记录", content: tainted, topic: "proj-x" });
  assert.ok((await service.readTopic("proj-x")).body.includes("主题记忆索引"));
  await bridge.stop();
});

// ---------------------------------------------------------------------------
// S3 分组（0.4）：topic_create / topic_append 的可选 group、memory_read /
// memory_list_topics 反映 group/pinned、group_manage 四个 action。
// group_manage 直接用真实 createGroupManageTool + 真实 groups.json（临时 root）+
// createFakeService（真实 CAS 语义的 topic 内存账）；不经过 host bridge。
// ---------------------------------------------------------------------------

import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGroupManageTool, createTopicCreateTool } from "../../src/host/tools.mjs";
import { ensureGroupsFile, groupsFilePath } from "../../src/core/groups.mjs";
import { withLock } from "../../src/storage/lockfile.mjs";
import { atomicReplace } from "../../src/storage/fsutil.mjs";

async function makeGroupFixture(t, initial = {}) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "shiori-s3-groupmanage-"));
  t.after(async () => {
    await fsp.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });
  await ensureGroupsFile({ dataRoot: base, scopeId: "amber" });
  const service = createFakeService({
    scopeId: "amber",
    topics: [
      { key: "proj-x", title: "项目X", summary: "排障手册", body: "内容", group: ["dev"] },
      { key: "diary", title: "日记", summary: "生活记录", body: "内容", group: ["life"] },
    ],
    ...initial,
  });
  const tool = createGroupManageTool({ service, dataRoot: base, scopeId: "amber" });
  return { base, service, tool };
}

test("S3 topic_create：可选 group 写入 front-matter；超软上限只给 warning 不报错", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "shiori-s3-create-"));
  t.after(async () => {
    await fsp.rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });
  await ensureGroupsFile({ dataRoot: base, scopeId: "amber" });
  const baseService = createFakeService({ scopeId: "amber" });
  // topic_create 的可见性探测以 NOT_FOUND 判「不存在」（真实 service 语义）；
  // fake service 缺 topic 抛 INVALID_STATE，这里对齐真实 code。
  const service = {
    ...baseService,
    async readTopic(key) {
      try {
        return await baseService.readTopic(key);
      } catch {
        const error = new Error(`topic "${key}" does not exist`);
        error.code = "NOT_FOUND";
        throw error;
      }
    },
  };
  // topic_create 不在 host bridge 的 9 兼容工具集里，直接用真实工厂装配。
  const tool = createTopicCreateTool({ service, getSessionInfo: () => ({ sessionId: null, scopeId: "amber" }) });
  // fake service 的 mutate 把 change.topic 展开进 topic 记录（含 group）。
  const receipt = await tool.execute({
    topic: "grouped", title: "有组专题", summary: "带组创建", group: ["dev", "self"],
  });
  assert.equal(receipt.created, true);
  const topic = await service.readTopic("grouped");
  assert.deepEqual(topic.group, ["dev", "self"]);
  assert.equal(receipt.warning, undefined, "2 组不超软上限，无 warning");

  // 4 组 > 软上限 3：仍成功，回执带 warning 文本。
  const receipt4 = await tool.execute({
    topic: "many", title: "多组专题", summary: "超软上限", group: ["dev", "self", "project", "life"],
  });
  assert.equal(receipt4.created, true);
  assert.ok(typeof receipt4.warning === "string" && /软上限/.test(receipt4.warning));
});

test("S3 topic_append：缺省保持原组；显式 group 改挂组并给软上限 warning", async (t) => {
  const { service } = await makeGroupFixture(t);
  const host = createFakeHost();
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();
  // 缺省：append 不带 group → topic 记录保持原组（fake service 展开语义）。
  await host.tools.get("topic_append").execute({ topic: "proj-x", section: "新段", content: "追加" });
  const appended = await service.readTopic("proj-x");
  assert.deepEqual(appended.group, ["dev"], "缺省保持原组");
  const lastChange = service.mutateLog.at(-1).request.changes[0];
  assert.equal(lastChange.topic.group, undefined, "append 缺省不发 group（由 service 继承）");

  // 显式改挂组（1 组 → 4 组）→ warning。
  const receipt = await host.tools.get("topic_append").execute({
    topic: "proj-x", section: "再段", content: "再追加",
    group: ["dev", "self", "project", "life"],
  });
  assert.ok(receipt.warning && /软上限/.test(receipt.warning));
  assert.deepEqual((await service.readTopic("proj-x")).group, ["dev", "self", "project", "life"]);
  await bridge.stop();
});

test("S3 memory_read / memory_list_topics：返回体反映 group 与 pinned", async (t) => {
  const { service } = await makeGroupFixture(t);
  const host = createFakeHost();
  const bridge = createHostBridge({ host, service, mode: "active", config: ACTIVE_CONFIG });
  await bridge.start();
  const read = await host.tools.get("memory_read").execute({ topic: "proj-x" });
  assert.deepEqual(read.group, ["dev"]);
  assert.equal(read.pinned, false);
  const listed = await host.tools.get("memory_list_topics").execute({});
  const row = listed.topics.find((x) => x.key === "diary");
  assert.deepEqual(row.group, ["life"]);
  assert.equal(row.pinned, false);
  // core 读分支也有确定的缺省形状（group [] / pinned false）。
  const core = await host.tools.get("memory_read").execute({});
  assert.deepEqual(core.group, []);
  assert.equal(core.pinned, false);
  await bridge.stop();
});

test("S3 group_manage list：组清单 + 各组 topic 计数", async (t) => {
  const { tool } = await makeGroupFixture(t);
  const out = await tool.execute({ action: "list" });
  assert.equal(out.scope, "amber");
  assert.equal(out.action, "list");
  assert.ok(typeof out.revision === "string" && out.revision.length > 0);
  const dev = out.groups.find((g) => g.key === "dev");
  assert.equal(dev.topics, 1, "dev 组挂 1 个 topic");
  assert.equal(dev.title, "开发与配置");
  assert.equal(out.groups.length, 4, "默认模板四组");
});

test("S3 group_manage create：建组成功；key 冲突报错", async (t) => {
  const { tool } = await makeGroupFixture(t);
  const out = await tool.execute({ action: "create", key: "hobby", title: "兴趣", summary: "副业", order: 50 });
  assert.equal(out.created, true);
  assert.ok(typeof out.revision === "string");
  const listed = await tool.execute({ action: "list" });
  assert.ok(listed.groups.some((g) => g.key === "hobby"));

  await assert.rejects(
    () => tool.execute({ action: "create", key: "hobby", title: "重复", summary: "x", order: 60 }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /already exists/.test(e.message),
  );
  await assert.rejects(
    () => tool.execute({ action: "create", key: "a/b", title: "非法", summary: "", order: 1 }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT",
  );
});

test("S3 group_manage update：改元信息；组不存在报错", async (t) => {
  const { tool } = await makeGroupFixture(t);
  const out = await tool.execute({ action: "update", key: "dev", title: "开发配置新名", order: 15 });
  assert.equal(out.updated, true);
  const listed = await tool.execute({ action: "list" });
  const dev = listed.groups.find((g) => g.key === "dev");
  assert.equal(dev.title, "开发配置新名");
  assert.equal(dev.order, 15);
  assert.equal(dev.summary, "DSH / 插件 / 发版 / 沙箱", "未给 summary 保持原值");

  await assert.rejects(
    () => tool.execute({ action: "update", key: "ghost", title: "x" }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /does not exist/.test(e.message),
  );
});

test("S3 group_manage delete：非空组漏 migrateTo → INVALID_STATE 并列出成员", async (t) => {
  const { tool, service } = await makeGroupFixture(t);
  await assert.rejects(
    () => tool.execute({ action: "delete", key: "dev" }),
    (e) => {
      if (!isCodedError(e)) return false;
      assert.equal(e.code, "INVALID_STATE");
      assert.match(e.message, /proj-x/);
      assert.ok(Array.isArray(e.details?.members) && e.details.members.includes("proj-x"));
      return true;
    },
  );
  // 组仍在、成员组挂载未变（拒绝发生在任何写入前）。
  const listed = await tool.execute({ action: "list" });
  assert.ok(listed.groups.some((g) => g.key === "dev"));
  assert.deepEqual((await service.readTopic("proj-x")).group, ["dev"]);
  assert.equal(service.mutateLog.length, 0, "拒绝时不得有 topic 写入");
});

test("S3 group_manage delete + migrateTo：同一提交先改 topic 再删组，无悬空 key", async (t) => {
  const { tool, service, base } = await makeGroupFixture(t);
  const out = await tool.execute({ action: "delete", key: "dev", migrateTo: "project" });
  assert.equal(out.deleted, true);
  assert.deepEqual(out.migrated, [{ topicKey: "proj-x", group: ["project"] }], "key 顶替原位置（保主组语义）");
  assert.ok(typeof out.revision === "string");

  // topic 迁移是同一提交（一次 mutate、一条 change），组条目随后删除。
  assert.equal(service.mutateLog.length, 1);
  assert.equal(service.mutateLog[0].request.changes.length, 1);
  assert.deepEqual(service.mutateLog[0].request.changes[0].topic.group, ["project"]);

  // 磁盘 groups.json：dev 已删、project 仍在。
  const raw = JSON.parse(await fsp.readFile(groupsFilePath(base, "amber"), "utf8"));
  assert.ok(!raw.groups.some((g) => g.key === "dev"));
  assert.ok(raw.groups.some((g) => g.key === "project"));
  // 无悬空 key：没有任何 topic 还挂着 dev。
  for (const topic of await service.listTopics()) {
    assert.ok(!topic.group.includes("dev"), `topic ${topic.key} 不得再挂已删除的组`);
  }
  const listed = await tool.execute({ action: "list" });
  assert.equal(listed.groups.find((g) => g.key === "dev"), undefined);
});

test("S3 group_manage delete：空组直接删；migrateTo 指向不存在组报错；migrateTo=自身报错", async (t) => {
  const { tool } = await makeGroupFixture(t);
  const out = await tool.execute({ action: "delete", key: "project" }); // 无成员
  assert.equal(out.deleted, true);
  assert.deepEqual(out.migrated, []);
  const listed = await tool.execute({ action: "list" });
  assert.equal(listed.groups.find((g) => g.key === "project"), undefined);

  await assert.rejects(
    () => tool.execute({ action: "delete", key: "life", migrateTo: "project" }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /project/.test(e.message),
  );
  await assert.rejects(
    () => tool.execute({ action: "delete", key: "life", migrateTo: "life" }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /migrateTo/.test(e.message),
  );
  await assert.rejects(
    () => tool.execute({ action: "delete", key: "ghost" }),
    (e) => isCodedError(e) && e.code === "INVALID_INPUT" && /does not exist/.test(e.message),
  );
});

// 0.4 补丁（账本 #4846d2 / review a1 打回项 1）：迁移提交与组条目删除之间存在
// 并发窗口——topic 改挂已在 service.mutate 里生效、groups.json 却被并发改动导致
// deleteGroup 的 CAS 失败。旧契约是首次 CAS 失败即上抛、文案标注「迁移已生效，
// 重试幂等」让人手动重试；0.4 收尾（本单）换成自愈：重读 revision 补删组条目一次
// （绝不二次迁移），第二次仍失败才上抛。只要迁移过 topic，任何最终错误（首试非 CAS
// 错误、重试的任何错误 code）都必须带「迁移已生效」说明，但不承诺重跑幂等。

test("S3 group_manage delete + migrateTo：迁移提交后 groups.json 被并发改动 → 自愈重读 revision 补删组条目（0.4 收尾）", async (t) => {
  const { tool, service, base } = await makeGroupFixture(t);
  const file = groupsFilePath(base, "amber");
  // 并发写手：迁移 mutate 提交成功后立刻手改磁盘 groups.json（模拟另一宿主在
  // 同一窗口期写入），使 action 开头读到的 revision 与磁盘真值错开，deleteGroup
  // 的 CAS 必失败——走的是真实 deleteGroup 代码路径，不桩库函数。
  let mutateCount = 0;
  const innerMutate = service.mutate.bind(service);
  service.mutate = async (request) => {
    mutateCount += 1;
    const receipt = await innerMutate(request);
    const raw = JSON.parse(await fsp.readFile(file, "utf8"));
    const victim = raw.groups.find((g) => g.key === "life");
    victim.title = `${victim.title}（并发改动）`;
    await fsp.writeFile(file, JSON.stringify(raw), "utf8");
    return receipt;
  };
  const out = await tool.execute({ action: "delete", key: "dev", migrateTo: "project" });
  assert.equal(out.deleted, true, "第一次 CAS 失败必须由实现自愈（重读 revision 补删），不上抛");
  // 并发写手对 life.title 的改动原样保留——若重试仍用旧 revision 会二次
  // REVISION_CONFLICT 上抛，这条等价于钉住「重试读的是并发改动后的最新盘」。
  const raw = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.ok(!raw.groups.some((g) => g.key === "dev"), "dev 组已从清单删除");
  assert.match(raw.groups.find((g) => g.key === "life").title, /（并发改动）$/,
    "并发改动未被覆盖（重试基于并发后的真值 revision）");
  // 迁移恰好一次：mutate 计数钉死二次迁移禁令——重试只走 deleteGroup 补删组
  // 条目（组条目删除在本架构里不经 service.mutate）。
  assert.equal(mutateCount, 1, "service.mutate 只调 1 次（迁移），重试绝不二次迁移");
  // 组内 topic 的改挂已生效：挂载到 migrateTo，全库无任何 topic 还挂着 dev。
  assert.deepEqual((await service.readTopic("proj-x")).group, ["project"]);
  for (const topic of await service.listTopics()) {
    assert.ok(!topic.group.includes("dev"), `topic ${topic.key} 不得再挂已删除的组`);
  }
});

test("S3 group_manage delete + migrateTo：首试非 CAS 错误（清单被并发删除 → NOT_FOUND）code 保留，同样附迁移已生效说明", async (t) => {
  const { tool, service, base } = await makeGroupFixture(t);
  const file = groupsFilePath(base, "amber");
  // 并发删手：迁移提交后删掉 groups.json——首试 deleteGroup 读不到清单抛 NOT_FOUND，
  // 不是 REVISION_CONFLICT、不进重试；但迁移已经生效，错误必须照样交代后果
  //（否则调用方只看到「组清单不存在」，不知道 topic 已改挂 migrateTo）。
  const innerMutate = service.mutate.bind(service);
  service.mutate = async (request) => {
    const receipt = await innerMutate(request);
    await fsp.unlink(file);
    return receipt;
  };
  await assert.rejects(
    () => tool.execute({ action: "delete", key: "dev", migrateTo: "project" }),
    (e) => {
      // NOT_FOUND 是 storage 层补充码（host/errors.mjs 的 CODES 五元组之外），
      // 这里直接断言 code，不经过 isCodedError。
      assert.equal(e.code, "NOT_FOUND", "code 原样保留");
      assert.match(e.message, /迁移已生效/, "首试非 CAS 错误同样交代迁移后果");
      assert.match(e.message, /"project"/, "文案点名迁移目标组");
      assert.match(e.message, /本次未自动重试/, "首试失败没有重试，文案不得谎称重试过");
      return true;
    },
  );
  assert.deepEqual((await service.readTopic("proj-x")).group, ["project"], "迁移确实已生效");
});

test("S3 group_manage delete + migrateTo：重试仍 CAS 冲突 → 上抛 REVISION_CONFLICT + 迁移已生效说明，迁移只做一次（必修 3）", async (t) => {
  const { tool, service, base } = await makeGroupFixture(t);
  const file = groupsFilePath(base, "amber");
  const rootReal = await fsp.realpath(base);
  const baseGroups = JSON.parse(await fsp.readFile(file, "utf8")).groups;
  // 并发写手：持续以「语义不变、字节改变」（_seq 自增）的方式改写 groups.json，
  // 且每次改写都在存储锁内——锁队列 FIFO 保证「重试补删」在重读 revision 之后
  // 必然被再次改盘，二次 CAS 必失败（不桩任何内部函数，只注入并发写盘）。
  let stop = false;
  let seq = 0;
  const writer = (async () => {
    while (!stop) {
      try {
        await withLock(rootReal, { retryMs: 5 }, async () => {
          seq += 1;
          const body = JSON.stringify({ version: 1, groups: baseGroups, _seq: seq });
          await atomicReplace(file, Buffer.from(body, "utf8"));
        });
      } catch {
        // 并发 rename 抖动（EPERM 等）忽略，下一轮继续写。
      }
    }
  })();
  let error;
  try {
    await assert.rejects(
      () => tool.execute({ action: "delete", key: "dev", migrateTo: "project" }),
      (e) => { error = e; return true; },
    );
  } finally {
    stop = true;
    await writer;
  }
  assert.equal(error?.code, "REVISION_CONFLICT", "二次失败仍是 CAS 冲突，code 原样保留");
  assert.match(error.message, /迁移已生效/);
  assert.match(error.message, /"project"/, "文案点名迁移目标组");
  assert.match(error.message, /不一定幂等/, "不承诺重跑幂等");
  assert.equal(service.mutateLog.length, 1, "迁移只发生一次：重试只补删组条目，绝不二次迁移");
  assert.deepEqual((await service.readTopic("proj-x")).group, ["project"], "迁移已生效且只执行一次");
  // 组条目未删（整体失败），并发写手写入的字节保留。
  const raw = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.ok(raw.groups.some((g) => g.key === "dev"), "dev 条目仍在（CAS 两次失败，删除未提交）");
});

test("S3 group_manage delete + migrateTo：窗口内目标组被删（重试预检 INVALID_INPUT）→ 任何二次错误都附加迁移已生效说明（必修 3）", async (t) => {
  const { tool, service, base } = await makeGroupFixture(t);
  const file = groupsFilePath(base, "amber");
  // 并发删手：迁移提交后把目标组 project 从清单删掉——首试因字节改动 CAS 失败，
  // 重试重读后 CAS 通过、却卡在 migrateTo 预检（INVALID_INPUT）。旧实现只在二次
  // 失败也是 CAS 冲突时才加说明，调用方看不出迁移已生效。
  const innerMutate = service.mutate.bind(service);
  service.mutate = async (request) => {
    const receipt = await innerMutate(request);
    const raw = JSON.parse(await fsp.readFile(file, "utf8"));
    const next = { ...raw, groups: raw.groups.filter((g) => g.key !== "project") };
    await fsp.writeFile(file, JSON.stringify(next), "utf8");
    return receipt;
  };
  await assert.rejects(
    () => tool.execute({ action: "delete", key: "dev", migrateTo: "project" }),
    (e) => {
      assert.equal(e.code, "INVALID_INPUT", "重试在 migrateTo 预检失败，code 原样保留");
      assert.match(e.message, /迁移已生效/, "二次失败（任何 code）都必须交代迁移后果");
      assert.match(e.message, /"project"/, "文案点名迁移目标组");
      assert.match(e.message, /不一定幂等/, "不承诺重跑幂等（目标组没了）");
      return true;
    },
  );
  assert.equal(service.mutateLog.length, 1, "迁移只发生一次，重试不二次迁移");
  assert.deepEqual((await service.readTopic("proj-x")).group, ["project"], "迁移已生效");
  const raw = JSON.parse(await fsp.readFile(file, "utf8"));
  assert.ok(raw.groups.some((g) => g.key === "dev"), "dev 条目未删（整体失败）");
});
