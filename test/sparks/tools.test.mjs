// Slot I · src/sparks/tools.mjs 工具门面测试（node:test，全部合成）。
// G 的真实 store 未交付：按 CONTRACTS.md §G 的公开契约内存实现 fake store，
// 任何在这里通过的用例都只是 synthetic，不代表真实宿主/真实 store 组合。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSparkTools, isSparkToolError } from "../../src/sparks/tools.mjs";

const SCOPE = "scope-main";

// ── fake store（仅实现 §G 公开契约的最小语义，供门面测试）──────────────────

function makeFakeStore({ scopeId = SCOPE, leaky = false } = {}) {
  const calls = [];
  const records = new Map(); // id -> record（所有 scope 混存，模拟底层存储）
  const idempotent = new Map(); // operationId -> { method, fingerprint, result }
  let seq = 0;

  const stamp = (record) => ({ ...record, scopeId });
  const fingerprintOf = (method, data) => `${method}:${JSON.stringify(data)}`;

  function applyIdempotency(method, data, produce) {
    const operationId = data.options?.operationId;
    if (typeof operationId !== "string" || operationId.length === 0) return produce();
    const key = `${scopeId}\u0000${operationId}`;
    const seen = idempotent.get(key);
    if (seen) {
      if (seen.fingerprint !== fingerprintOf(method, data)) {
        const error = new Error("same operationId replayed with different semantics");
        error.code = "INVALID_INPUT";
        throw error;
      }
      return seen.result;
    }
    const result = produce();
    idempotent.set(key, { fingerprint: fingerprintOf(method, data), result });
    return result;
  }

  const own = () => [...records.values()].filter((r) => r.scopeId === scopeId);
  const findOwn = (id) => records.get(id) && records.get(id).scopeId === scopeId ? records.get(id) : undefined;

  return {
    calls,
    seed(record) { records.set(record.id, record); },
    get stored() { return records; },

    async save(input, options = {}) {
      calls.push({ method: "save", input: JSON.parse(JSON.stringify(input)), options: { ...options } });
      return applyIdempotency("save", { input, options }, () => {
        if (input.vitality !== "evergreen" && input.vitality !== "ephemeral") {
          const error = new Error("invalid vitality");
          error.code = "INVALID_INPUT";
          throw error;
        }
        if (options.expectedRevision !== undefined && options.expectedRevision !== null) {
          const error = new Error("save CAS mismatch");
          error.code = "REVISION_CONFLICT";
          throw error;
        }
        const id = `spark-${++seq}`;
        const record = stamp({
          id, revision: 1, state: "active",
          title: input.title, summary: input.summary ?? null,
          triggers: [...input.triggers], entities: [...(input.entities ?? [])],
          links: JSON.parse(JSON.stringify(input.links ?? [])),
          content: input.content, vitality: input.vitality,
        });
        records.set(id, record);
        return { ...record };
      });
    },

    async read(id) {
      calls.push({ method: "read", id });
      // leaky 模式模拟“store 缺陷”：按 id 全库返回，跨 scope 也给（门面必须兜底）。
      const record = leaky ? records.get(id) : findOwn(id);
      if (!record) {
        const error = new Error(`no spark ${id} in scope`);
        error.code = "NOT_FOUND";
        throw error;
      }
      return { ...record };
    },

    async update(id, patch, options = {}) {
      calls.push({ method: "update", id, patch: JSON.parse(JSON.stringify(patch)), options: { ...options } });
      return applyIdempotency("update", { id, patch, options }, () => {
        const record = findOwn(id);
        if (!record) {
          const error = new Error(`no spark ${id} in scope`);
          error.code = "NOT_FOUND";
          throw error;
        }
        if (options.expectedRevision !== undefined && options.expectedRevision !== record.revision) {
          const error = new Error("revision conflict");
          error.code = "REVISION_CONFLICT";
          throw error;
        }
        for (const [key, value] of Object.entries(patch)) record[key] = key === "links" ? JSON.parse(JSON.stringify(value)) : value;
        record.revision += 1;
        return { ...record };
      });
    },

    async forget(id, options = {}) {
      calls.push({ method: "forget", id, options: { ...options } });
      return applyIdempotency("forget", { id, options }, () => {
        const record = findOwn(id);
        if (!record) {
          const error = new Error(`no spark ${id} in scope`);
          error.code = "NOT_FOUND";
          throw error;
        }
        if (options.expectedRevision !== undefined && options.expectedRevision !== record.revision) {
          const error = new Error("revision conflict");
          error.code = "REVISION_CONFLICT";
          throw error;
        }
        record.state = options.mode === "supersede" ? "superseded" : "archived";
        if (options.mode === "supersede") record.supersededBy = options.replacementId;
        return { ...record };
      });
    },

    async feedback(id, options = {}) {
      calls.push({ method: "feedback", id, options: { ...options } });
      return applyIdempotency("feedback", { id, options }, () => {
        const record = findOwn(id);
        if (!record) {
          const error = new Error(`no spark ${id} in scope`);
          error.code = "NOT_FOUND";
          throw error;
        }
        if (options.used === true) {
          record.useCount = (record.useCount ?? 0) + 1;
          record.lastUsedAt = "2026-10-25T00:00:00.000Z";
        }
        return { ...record };
      });
    },

    async graph() {
      calls.push({ method: "graph" });
      // leaky：全库原样返回（异 scope / archived / superseded 混入），门面必须过滤。
      return (leaky ? [...records.values()] : own().filter((r) => r.state === "active")).map((r) => ({ ...r }));
    },

    async listActive() {
      calls.push({ method: "listActive" });
      // leaky：全库原样返回（异 scope / 非 active 混入），门面+投影必须过滤。
      return (leaky ? [...records.values()] : own().filter((r) => r.state === "active"))
        .map((r) => ({ ...r }));
    },

    async close() {},
  };
}

const VALID_SAVE = {
  content: "2026-10-16 问为什么眼里常含泪水，答刚切完洋葱。",
  title: "洋葱梗",
  triggers: ["洋葱", "切洋葱"],
  vitality: "evergreen",
};

function tools(store = makeFakeStore()) {
  return { facade: createSparkTools({ scopeId: SCOPE, store }), store };
}

/** 统一断言：action（函数或 promise）必须以指定 code 拒绝（含同步抛错），绝不产生 ok:true。 */
async function rejectsCode(action, code) {
  const run = async () => (typeof action === "function" ? action() : action);
  await assert.rejects(run, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

// ── 工厂校验 ─────────────────────────────────────────────────────────────

test("factory rejects invalid scopeId / store shape", async () => {
  for (const bad of [undefined, "", 42, null]) {
    await rejectsCode(() => createSparkTools({ scopeId: bad, store: makeFakeStore() }), "INVALID_INPUT");
  }
  await rejectsCode(() => createSparkTools({ scopeId: SCOPE }), "INVALID_INPUT");
  const noSave = { read() {}, update() {}, forget() {}, feedback() {}, graph() {} };
  await rejectsCode(() => createSparkTools({ scopeId: SCOPE, store: noSave }), "INVALID_INPUT");
  // spark_graph 依赖 listActive() 提供完整 public record（GI 组合返工要求）
  const noListActive = { save() {}, read() {}, update() {}, forget() {}, feedback() {}, graph() {} };
  await rejectsCode(() => createSparkTools({ scopeId: SCOPE, store: noListActive }), "INVALID_INPUT");
});

test("exposes six L2 tools; list() carries no execute functions", () => {
  const { facade } = tools();
  assert.deepEqual(facade.names,
    ["spark_save", "spark_read", "spark_update", "spark_forget", "spark_feedback", "spark_graph"]);
  assert.equal(facade.tools.length, 6);
  for (const descriptor of facade.list()) {
    assert.equal(typeof descriptor.name, "string");
    assert.equal(typeof descriptor.description, "string");
    assert.equal(typeof descriptor.inputSchema, "object");
    assert.equal(descriptor.execute, undefined);
  }
});

// ── scope/root 走私（必测反例：payload 不得改变 scope/root）────────────────

test("payload keys scope/scopeId/root are rejected on every tool and never reach the store", async () => {
  const { facade, store } = tools();
  const cases = [
    ["spark_save", { ...VALID_SAVE, scope: SCOPE }],
    ["spark_save", { ...VALID_SAVE, scopeId: "other" }],
    ["spark_read", { id: "spark-1", root: "/etc" }],
    ["spark_update", { id: "spark-1", patch: { title: "x" }, scope: "other" }],
    ["spark_update", { id: "spark-1", patch: { title: "x", scopeId: "other" } }],
    ["spark_update", { id: "spark-1", patch: { title: "x", root: "/tmp" } }],
    ["spark_forget", { id: "spark-1", mode: "archive", scope: SCOPE }],
    ["spark_feedback", { id: "spark-1", used: true, scopeId: SCOPE }],
    ["spark_graph", { scope: "other" }],
  ];
  for (const [name, payload] of cases) {
    await rejectsCode(facade.execute(name, payload), "INVALID_INPUT");
  }
  assert.equal(store.calls.length, 0, "store must not be touched by rejected payloads");
});

test("a smuggled scope key is rejected even when the value equals the trusted scope", async () => {
  const { facade, store } = tools();
  await rejectsCode(facade.execute("spark_read", { id: "x", scopeId: SCOPE }), "INVALID_INPUT");
  assert.equal(store.calls.length, 0);
});

// ── spark_save ───────────────────────────────────────────────────────────

test("spark_save validates and forwards to store with a generated operationId", async () => {
  const { facade, store } = tools();
  const receipt = await facade.execute("spark_save", VALID_SAVE);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.tool, "spark_save");
  assert.equal(receipt.scope, SCOPE);
  assert.equal(receipt.id, "spark-1");
  assert.equal(receipt.revision, 1);
  assert.equal(receipt.state, "active");
  assert.equal(receipt.vitality, "evergreen");
  assert.match(receipt.operationId, /^[0-9a-f-]{36}$/); // 缺省时门面生成 UUID
  assert.equal(store.calls.length, 1);
  const call = store.calls[0];
  assert.equal(call.method, "save");
  assert.deepEqual(call.input, {
    content: VALID_SAVE.content, title: VALID_SAVE.title,
    triggers: VALID_SAVE.triggers, vitality: VALID_SAVE.vitality,
  });
  assert.equal(call.options.operationId, receipt.operationId);
  assert.equal("expectedRevision" in call.options, false);
});

test("spark_save passes through explicit expectedRevision / operationId and optional fields", async () => {
  const { facade, store } = tools();
  const receipt = await facade.execute("spark_save", {
    ...VALID_SAVE,
    summary: "切洋葱梗",
    entities: ["做饭"],
    links: [{ target: "spark-9", rel: "衍生梗" }],
    expectedRevision: null,
    operationId: "op-save-1",
  });
  assert.equal(receipt.operationId, "op-save-1");
  const call = store.calls[0];
  assert.equal(call.options.operationId, "op-save-1");
  assert.equal(call.options.expectedRevision, null);
  assert.deepEqual(call.input.entities, ["做饭"]);
  assert.deepEqual(call.input.links, [{ target: "spark-9", rel: "衍生梗" }]);
  assert.equal(call.input.summary, "切洋葱梗");
});

test("spark_save validation rejects bad payloads without touching the store", async () => {
  const { facade, store } = tools();
  const bad = [
    undefined, "string", 42, [],
    { title: "t", triggers: [], vitality: "evergreen" }, // 缺 content
    { content: "c", triggers: [], vitality: "evergreen" }, // 缺 title
    { content: "c", title: "t", vitality: "evergreen" }, // 缺 triggers
    { content: "", title: "t", triggers: [], vitality: "evergreen" },
    { content: "c", title: "t", triggers: [], vitality: "daily" },
    { content: "c", title: "t", triggers: "洋葱", vitality: "evergreen" },
    { content: "c", title: "t", triggers: [""], vitality: "evergreen" },
    { content: "c", title: "t", triggers: [42], vitality: "evergreen" },
    { content: "c", title: "t", triggers: [], vitality: "evergreen", entities: "做饭" },
    { content: "c", title: "t", triggers: [], vitality: "evergreen", links: [{ rel: "x" }] },
    { content: "c", title: "t", triggers: [], vitality: "evergreen", links: [{ target: 42 }] },
    { content: "c", title: "t", triggers: [], vitality: "evergreen", id: "smuggled-id" },
    { content: "c", title: "t", triggers: [], vitality: "evergreen", whatever: 1 },
    { content: "c\uDC80", title: "t", triggers: [], vitality: "evergreen" }, // 孤立代理对
  ];
  for (const payload of bad) {
    await rejectsCode(facade.execute("spark_save", payload), "INVALID_INPUT");
  }
  assert.equal(store.calls.length, 0);
});

test("spark_save with the same operationId replays idempotently at the store boundary", async () => {
  const { facade } = tools();
  const payload = { ...VALID_SAVE, operationId: "op-idem" };
  const first = await facade.execute("spark_save", payload);
  const second = await facade.execute("spark_save", payload);
  assert.equal(second.id, first.id);
  assert.equal(second.revision, first.revision);
});

// ── spark_read ───────────────────────────────────────────────────────────

test("spark_read returns the full card in the current scope", async () => {
  const { facade, store } = tools();
  await facade.execute("spark_save", VALID_SAVE);
  const receipt = await facade.execute("spark_read", { id: "spark-1" });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.tool, "spark_read");
  assert.equal(receipt.scope, SCOPE);
  assert.equal(receipt.content, VALID_SAVE.content);
  assert.deepEqual(receipt.triggers, VALID_SAVE.triggers);
  assert.equal(receipt.state, "active");
});

test("spark_read maps a cross-scope record from a leaky store to NOT_FOUND (no existence leak)", async () => {
  const store = makeFakeStore({ leaky: true });
  store.seed({ id: "foreign-1", scopeId: "scope-other", revision: 1, title: "t", summary: null, triggers: [], entities: [], links: [], content: "OTHER-SCOPE-BODY", vitality: "evergreen", state: "active" });
  const { facade } = tools(store);
  await rejectsCode(facade.execute("spark_read", { id: "foreign-1" }), "NOT_FOUND");
});

test("spark_read rejects malformed store results instead of fabricating a card", async () => {
  const store = makeFakeStore();
  store.read = async () => "garbage";
  const { facade } = tools(store);
  await rejectsCode(facade.execute("spark_read", { id: "x" }), "INVALID_STATE");
});

test("spark_read rejects bad payloads and unknown keys", async () => {
  const { facade, store } = tools();
  for (const payload of [undefined, {}, { id: "" }, { id: 42 }, { id: "x", extra: 1 }, { id: "x", content: "smuggle"}]) {
    await rejectsCode(facade.execute("spark_read", payload), "INVALID_INPUT");
  }
  assert.equal(store.calls.length, 0);
});

// ── spark_update ─────────────────────────────────────────────────────────

test("spark_update forwards patch + CAS options verbatim", async () => {
  const { facade, store } = tools();
  await facade.execute("spark_save", VALID_SAVE);
  const receipt = await facade.execute("spark_update", {
    id: "spark-1",
    patch: { vitality: "ephemeral", triggers: ["洋葱", "泪水"] },
    expectedRevision: 1,
    operationId: "op-upd-1",
  });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.tool, "spark_update");
  assert.equal(receipt.vitality, "ephemeral");
  assert.equal(receipt.revision, 2);
  const call = store.calls[1];
  assert.equal(call.method, "update");
  assert.deepEqual(call.patch, { vitality: "ephemeral", triggers: ["洋葱", "泪水"] });
  assert.equal(call.options.expectedRevision, 1);
  assert.equal(call.options.operationId, "op-upd-1");
});

test("spark_update refuses to patch identity/lifecycle fields", async () => {
  const { facade, store } = tools();
  await facade.execute("spark_save", VALID_SAVE);
  for (const patch of [
    {}, // 空 patch
    { id: "other" },
    { state: "archived" },
    { scopeId: "other" },
    { revision: 99 },
    { root: "/x" },
    { nope: 1 },
    { vitality: "sometimes" },
    { triggers: "洋葱" },
  ]) {
    await rejectsCode(facade.execute("spark_update", { id: "spark-1", patch }), "INVALID_INPUT");
  }
  assert.equal(store.calls.length, 1); // 只有最初的 save
});

// ── spark_forget ─────────────────────────────────────────────────────────

test("spark_forget archive and supersede forward mode/options correctly", async () => {
  const { facade, store } = tools();
  await facade.execute("spark_save", VALID_SAVE);
  await facade.execute("spark_save", { ...VALID_SAVE, title: "洋葱梗 v2", operationId: "op-2" });
  const receipt = await facade.execute("spark_forget", { id: "spark-1", mode: "archive", operationId: "op-f1" });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.state, "archived");
  assert.equal(receipt.mode, "archive");
  assert.equal(receipt.replacementId, null);
  const call = store.calls[2];
  assert.equal(call.method, "forget");
  assert.equal(call.options.mode, "archive");
  assert.equal(call.options.operationId, "op-f1");
  assert.equal("replacementId" in call.options, false);

  const sup = await facade.execute("spark_forget", { id: "spark-2", mode: "supersede", replacementId: "spark-1", expectedRevision: 1, operationId: "op-f2" });
  assert.equal(sup.state, "superseded");
  assert.equal(sup.replacementId, "spark-1");
  const supCall = store.calls[3];
  assert.equal(supCall.options.mode, "supersede");
  assert.equal(supCall.options.replacementId, "spark-1");
  assert.equal(supCall.options.expectedRevision, 1);
});

test("spark_forget rejects bad modes, self-supersede and stray replacementId", async () => {
  const { facade, store } = tools();
  await facade.execute("spark_save", VALID_SAVE);
  for (const payload of [
    { id: "spark-1", mode: "delete" },
    { id: "spark-1", mode: "supersede" }, // 缺 replacementId
    { id: "spark-1", mode: "supersede", replacementId: "spark-1" }, // 自替代
    { id: "spark-1", mode: "archive", replacementId: "spark-2" }, // archive 不接受 replacementId
    { id: "spark-1", mode: "archive", expectedRevision: true },
    { id: "spark-1", mode: "archive", expectedRevision: {} },
    { id: "spark-1" },
  ]) {
    await rejectsCode(facade.execute("spark_forget", payload), "INVALID_INPUT");
  }
  assert.equal(store.calls.length, 1);
});

// ── spark_feedback ───────────────────────────────────────────────────────

test("spark_feedback requires an explicit boolean used and forwards the event id", async () => {
  const { facade, store } = tools();
  await facade.execute("spark_save", VALID_SAVE);
  const receipt = await facade.execute("spark_feedback", { id: "spark-1", used: true, sourceEventId: "evt-9", operationId: "op-fb-1" });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.used, true);
  assert.equal(receipt.sourceEventId, "evt-9");
  const call = store.calls[1];
  assert.equal(call.method, "feedback");
  assert.deepEqual(call.options, { used: true, operationId: "op-fb-1", sourceEventId: "evt-9" });

  const off = await facade.execute("spark_feedback", { id: "spark-1", used: false });
  assert.equal(off.used, false);
  assert.equal(off.sourceEventId, null);
});

test("spark_feedback rejects non-boolean used", async () => {
  const { facade, store } = tools();
  for (const used of ["yes", 1, undefined, null]) {
    await rejectsCode(facade.execute("spark_feedback", { id: "x", used }), "INVALID_INPUT");
  }
  assert.equal(store.calls.length, 0);
});

// ── store 错误透传（不吞错、不伪造成功）──────────────────────────────────

test("store coded errors propagate unchanged (no fabricated success)", async () => {
  const { facade } = tools();
  await facade.execute("spark_save", VALID_SAVE);
  await rejectsCode(facade.execute("spark_update", { id: "spark-1", patch: { title: "x" }, expectedRevision: 999 }), "REVISION_CONFLICT");
  await rejectsCode(facade.execute("spark_read", { id: "ghost" }), "NOT_FOUND");

  const busy = makeFakeStore();
  busy.update = async () => {
    const error = new Error("lock busy");
    error.code = "LOCK_BUSY";
    throw error;
  };
  const { facade: busyFacade } = tools(busy);
  await rejectsCode(busyFacade.execute("spark_update", { id: "any", patch: { title: "x" } }), "LOCK_BUSY");
});

// ── spark_graph（模型侧只回句柄 + 规模摘要）───────────────────────────────

test("spark_graph model receipt carries handle and scale only — no ids/titles/bodies", async () => {
  const { facade } = tools();
  await facade.execute("spark_save", { ...VALID_SAVE, entities: ["做饭"] });
  await facade.execute("spark_save", { ...VALID_SAVE, title: "洋葱梗 v2", triggers: ["v2"], vitality: "ephemeral", operationId: "op-2" });
  const receipt = await facade.execute("spark_graph", {});
  assert.equal(receipt.ok, true);
  assert.equal(receipt.tool, "spark_graph");
  assert.equal(receipt.scope, SCOPE);
  assert.equal(receipt.handle, `spark-graph:${SCOPE}`);
  assert.equal(receipt.summary.nodes, 2);
  assert.equal(receipt.summary.edges, 0);
  assert.deepEqual(receipt.summary.vitality, { evergreen: 1, ephemeral: 1, unknown: 0 });
  assert.ok(receipt.hint.includes("spark_read"));
  const text = JSON.stringify(receipt);
  assert.ok(!text.includes("洋葱"), "no card text in model receipt");
  assert.ok(!text.includes("spark-1"), "no node ids in model receipt");
  assert.ok(text.includes("\"nodes\":2"), "scale summary is present");
});

test("spark_graph over a leaky store still reports only this scope's active cards", async () => {
  const store = makeFakeStore({ leaky: true });
  store.seed({ id: "mine-1", scopeId: SCOPE, revision: 1, title: "t", summary: null, triggers: [], entities: [], links: [], content: "BODY-MINE", vitality: "evergreen", state: "active" });
  store.seed({ id: "foreign-1", scopeId: "scope-other", revision: 1, title: "t", summary: null, triggers: [], entities: [], links: [], content: "BODY-OTHER", vitality: "evergreen", state: "active" });
  store.seed({ id: "archived-1", scopeId: SCOPE, revision: 1, title: "t", summary: null, triggers: [], entities: [], links: [], content: "BODY-OLD", vitality: "evergreen", state: "archived" });
  const { facade } = tools(store);
  const receipt = await facade.execute("spark_graph", {});
  assert.equal(receipt.summary.nodes, 1);
  assert.equal(receipt.summary.droppedRecords, 2);
  const text = JSON.stringify(receipt);
  assert.ok(!text.includes("BODY-OTHER"));
  assert.ok(!text.includes("BODY-OLD"));
});

test("spark_graph never touches the store.graph() diagnostic plane", async () => {
  // GI 组合评审反例回归：graph() 是 G 的诊断投影（节点缺 scopeId/state/links，
  // 另带 filteredEdges），绝不能当 public record 喂给 projectGraph。
  const { facade, store } = tools();
  await facade.execute("spark_save", VALID_SAVE);
  let graphCalled = false;
  store.graph = async () => {
    graphCalled = true;
    return { nodes: [{ id: "x", title: "t", vitality: "evergreen", revision: 1 }], edges: [], filteredEdges: [] };
  };
  const receipt = await facade.execute("spark_graph", {});
  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary.nodes, 1);
  assert.equal(graphCalled, false, "spark_graph must call listActive(), never graph()");
});

// ── dispatcher 与错误判定 ────────────────────────────────────────────────

test("execute() dispatches by name and rejects unknown tools", async () => {
  const { facade, store } = tools();
  await rejectsCode(facade.execute("spark_nope", {}), "INVALID_INPUT");
  await rejectsCode(facade.execute(undefined, {}), "INVALID_INPUT");
  assert.equal(store.calls.length, 0);
  // 也可直接走描述符
  const saveTool = facade.tools.find((t) => t.name === "spark_save");
  const receipt = await saveTool.execute(VALID_SAVE);
  assert.equal(receipt.id, "spark-1");
});

test("isSparkToolError recognizes coded errors of this surface", async () => {
  const { facade } = tools();
  assert.equal(isSparkToolError(new Error("plain")), false);
  try {
    await facade.execute("spark_read", { id: "" });
    assert.fail("unreachable");
  } catch (error) {
    assert.equal(isSparkToolError(error), true);
  }
});

// ── G×I 真实组合回归（GI 组合评审要求的集成用例）──────────────────────────
// 构造真实 G openSparkStore（临时 root），用本门面保存两张带链接的卡并执行
// spark_graph，断言摘要为 2 节点 / 1 边；同时验证 scope 隔离、互逆边折叠、
// superseded 过滤与 spark_read 正文路径。G 不可达（既无同树 overlay，也无已
// 验收看板提交包）时跳过——跳过不冒充通过。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { projectGraph } from "../../src/sparks/graph.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 解析真实 G store：
 * 1) 同树 overlay（根集成布局）——src/sparks/store.mjs 与本包合并于同一棵树；
 * 2) 看板已验收 G 提交包——G 的 store 依赖基线 src/storage/*（fsutil/paths/
 *    lockfile），提交包只含 sparks 文件，因此在临时目录组装一次性 overlay
 *    （复制 G sparks + 基线 storage），用后即删。
 */
async function resolveRealGStore() {
  const overlay = path.resolve(HERE, "../../src/sparks/store.mjs");
  if (fs.existsSync(overlay)) return { url: pathToFileURL(overlay).href, source: "overlay" };
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const boardFile = path.resolve(dir, "state/board.json");
    if (fs.existsSync(boardFile)) {
      const board = JSON.parse(fs.readFileSync(boardFile, "utf8"));
      const g = (board.tasks ?? []).find((t) => t.slot === "G" && t.status === "accepted" && t.submission);
      if (g) {
        const pkgSparks = path.resolve(dir, "submissions", "G", g.submission, "files/src/sparks/store.mjs");
        const baselineSrc = path.resolve(dir, "..", "baseline", "src");
        if (fs.existsSync(pkgSparks) && fs.existsSync(path.join(baselineSrc, "storage", "fsutil.mjs"))) {
          const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shiori-gi-store-"));
          await fs.promises.cp(path.dirname(pkgSparks), path.join(tmp, "src", "sparks"), { recursive: true });
          await fs.promises.cp(path.join(baselineSrc, "storage"), path.join(tmp, "src", "storage"), { recursive: true });
          return {
            url: pathToFileURL(path.join(tmp, "src", "sparks", "store.mjs")).href,
            source: `board:${g.submission}`,
            cleanup: tmp,
          };
        }
      }
      return null;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const realG = await resolveRealGStore();
const skipReason = realG ? undefined : "real G store not reachable (no overlay src/sparks/store.mjs and no accepted G submission on the board)";

test(`G×I integration with real openSparkStore [${realG?.source ?? "unavailable"}]`, { skip: skipReason }, async (t) => {
  const { openSparkStore } = await import(realG.url);
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "shiori-gi-it-"));
  const scopeA = "gi-it-a";
  const scopeB = "gi-it-b";
  const storeA = await openSparkStore({ root, scopeId: scopeA });
  const storeB = await openSparkStore({ root, scopeId: scopeB });
  t.after(async () => {
    storeA.close();
    storeB.close();
    await fs.promises.rm(root, { recursive: true, force: true });
    if (realG.cleanup) await fs.promises.rm(realG.cleanup, { recursive: true, force: true });
  });

  const facadeA = createSparkTools({ scopeId: scopeA, store: storeA });
  const facadeB = createSparkTools({ scopeId: scopeB, store: storeB });
  // 金丝雀：整个用例期间 store.graph()（诊断平面）绝不能被门面调用
  let graphCalled = 0;
  for (const store of [storeA, storeB]) {
    const original = store.graph.bind(store);
    store.graph = async (...args) => {
      graphCalled += 1;
      return original(...args);
    };
  }

  // 两张卡：a ← b（b 显式链接到 a），vitality 各占一条轨
  const a = await facadeA.execute("spark_save", { ...VALID_SAVE, vitality: "evergreen" });
  const b = await facadeA.execute("spark_save", {
    ...VALID_SAVE, title: "洋葱梗 v2", triggers: ["v2"], vitality: "ephemeral",
    links: [{ target: a.id, rel: "related" }],
  });

  // 评审要求的断言：摘要报 2 节点 / 1 边，不静默成空图
  const g1 = await facadeA.execute("spark_graph", {});
  assert.equal(g1.ok, true);
  assert.equal(g1.summary.nodes, 2, `expected 2 nodes, got ${g1.summary.nodes}`);
  assert.equal(g1.summary.edges, 1, `expected 1 edge, got ${g1.summary.edges}`);
  assert.deepEqual(g1.summary.vitality, { evergreen: 1, ephemeral: 1, unknown: 0 });
  assert.equal(g1.handle, `spark-graph:${scopeA}`);

  // scope 隔离：B 里存的卡不会出现在 A 的图谱/读取里，反之亦然
  const inB = await facadeB.execute("spark_save", { ...VALID_SAVE, title: "B 的私卡" });
  const gA2 = await facadeA.execute("spark_graph", {});
  assert.equal(gA2.summary.nodes, 2, "B-scope write must not leak into A's graph");
  const gB = await facadeB.execute("spark_graph", {});
  assert.equal(gB.summary.nodes, 1);
  assert.equal(gB.scope, scopeB);
  await rejectsCode(() => facadeA.execute("spark_read", { id: inB.id }), "NOT_FOUND");

  // spark_read 正文路径（真实 store）
  const readA = await facadeA.execute("spark_read", { id: a.id });
  assert.equal(readA.content, VALID_SAVE.content);
  assert.equal(readA.state, "active");

  // 互逆边折叠（真实记录 + 本投影）：a 补一条指向 b 的边后仍是 1 条 reciprocal 边
  const updatedA = await facadeA.execute("spark_update", {
    id: a.id, patch: { links: [{ target: b.id, rel: "back" }] },
    expectedRevision: readA.revision, operationId: "gi-it-reciprocal",
  });
  assert.equal(updatedA.ok, true);
  const folded = projectGraph({ scopeId: scopeA, records: await storeA.listActive() });
  assert.equal(folded.stats.edges, 1);
  assert.equal(folded.edges[0].reciprocal, true);
  const g2 = await facadeA.execute("spark_graph", {});
  assert.equal(g2.summary.edges, 1);

  // superseded 过滤（真实 G schema：原卡 state='superseded' + supersededBy）
  const forgotten = await facadeA.execute("spark_forget", {
    id: a.id, mode: "supersede", replacementId: b.id,
    expectedRevision: updatedA.revision, operationId: "gi-it-supersede",
  });
  assert.equal(forgotten.state, "superseded");
  const g3 = await facadeA.execute("spark_graph", {});
  assert.equal(g3.summary.nodes, 1, "superseded card must leave the projection");
  assert.equal(g3.summary.edges, 0, "its edge must leave too");

  assert.equal(graphCalled, 0, "facade must never call store.graph()");
});
