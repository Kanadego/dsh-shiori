// 0.5 · 语义向量写后增量队列单元测试（不触宿主：内存假 spark store + 真向量索引落 temp）。
//
// 覆盖面（对应 src/semantic/incremental.mjs 头注释的三件事）：
//   ① 写后增量：防抖合并、批量 embed → upsert → 落盘、forget 剔除、supersede
//      双卡、失败静默重试一次（成功 / 仍失败两支）；
//   ② 单飞并发防线：闸被占（模拟重建）时 flush 零写索引、放行后按差集补齐；
//   ③ 启动差集兜底：过期 revision 补嵌、残留条目 retainOnly 剔除、新鲜卡零 embed；
//   ④ 降级：canWrite=false（HOST_LOCKED）/ canEmbed=false（模型未装）零副作用、
//      诊断可见、pending 保留；
//   ⑤ 写钩子包装：成功路径入队、失败路径不入队、其余方法透传、supersededBy 双标。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createSemanticGate,
  createSemanticIncrementalQueue,
  wrapSparkStoreWithIncrementalHooks,
} from "../../src/semantic/incremental.mjs";
import { openSemanticVectorStore } from "../../src/semantic/store.mjs";

// 有界轮询等待（事件门控；断言竞态不许用裸 sleep 糊——超时前最后一次也假就让断言红）。
const waitFor = async (condition, capMs = 3000, stepMs = 10) => {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return await condition();
};

/** 内存假 spark store：只含队列真正消费的两个读口 + 测试操纵口 _put。 */
function makeSparkCards(initial = []) {
  const cards = new Map();
  for (const card of initial) cards.set(card.id, { ...card });
  return {
    cards,
    async read(id) {
      const card = cards.get(id);
      if (card === undefined) {
        const error = new Error(`卡片 "${id}" 不存在于 scope "amber"`);
        error.code = "NOT_FOUND";
        throw error;
      }
      return { ...card };
    },
    async listActive() {
      return [...cards.values()].filter((c) => c.state === "active").map((c) => ({ ...c }));
    },
    _put(card) { cards.set(card.id, { ...card }); },
  };
}

/**
 * 嵌入桩：attempts 记每次调用（含失败），calls 只记成功；向量 one-hot 于文本
 * 哈希桶——同文本同向量、异文本低相似，足以断言「嵌的是谁」。
 */
function stubProvider({ dims = 8, failTexts = new Set(), failOncePerText = false } = {}) {
  const calls = [];
  const failedTexts = new Set();
  let attemptsCount = 0;
  return {
    calls,
    kind: "local",
    dims,
    get attempts() { return attemptsCount; },
    async embed(text) {
      attemptsCount += 1;
      if (failTexts.has(text) && (!failOncePerText || !failedTexts.has(text))) {
        failedTexts.add(text);
        throw new Error(`SEMANTIC_UNAVAILABLE 桩：${text} 嵌入失败`);
      }
      calls.push(text);
      const vec = new Float32Array(dims);
      let hash = 0;
      for (const ch of text) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
      vec[hash % dims] = 1;
      return vec;
    },
  };
}

/** 组装：temp 状态根 + 真（磁盘）向量索引 + 内存卡 + 队列。 */
async function setup({
  cards = [],
  provider: providerOpts = {},
  debounceMs = 20,
  gate = createSemanticGate(),
  canEmbed = () => true,
  canWrite = () => true,
} = {}) {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-incr-"));
  const stateRoot = path.join(base, "state");
  const spark = makeSparkCards(cards);
  const provider = stubProvider(providerOpts);
  const vectorStore = await openSemanticVectorStore({
    stateRoot, scopeId: "amber", model: "stub/model", dims: provider.dims,
  });
  const queue = createSemanticIncrementalQueue({
    scopeId: "amber",
    provider,
    openVectorStore: async () => vectorStore,
    readCard: spark.read,
    listActive: spark.listActive,
    embedText: (card) => [card.title, card.summary, card.content]
      .filter((part) => typeof part === "string" && part.length > 0)
      .join("\n"),
    gate,
    canEmbed,
    canWrite,
    debounceMs,
  });
  return {
    base, stateRoot, spark, provider, vectorStore, queue,
    cleanup: async () => {
      queue.close();
      vectorStore.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}

const cardA = (revision = 1) => ({ id: "sp-a", revision, state: "active", title: "标题A", content: "正文A" });
const embedTextOf = (card) => [card.title, card.content].filter((p) => p !== undefined).join("\n");

test("写后增量：markDirty 防抖合并 → 批量 embed → upsert → 落盘（revision 对齐，重复标记合并）", async (t) => {
  const { provider, vectorStore, queue, stateRoot, cleanup } = await setup({
    cards: [cardA(1), { id: "sp-b", revision: 3, state: "active", title: "标题B", summary: "摘要B", content: "正文B" }],
  });
  t.after(cleanup);
  queue.markDirty("sp-a");
  queue.markDirty("sp-b");
  queue.markDirty("sp-a"); // 同卡重复标记合并
  assert.equal(queue.stats().pending, 2, "同卡去重后 pending=2");
  assert.ok(
    await waitFor(() => queue.stats().running === false && queue.stats().pending === 0 && queue.stats().flushes === 1),
    "flush 收尾完全落地（含轮末 saveIfDirty）",
  );
  assert.equal(vectorStore.size(), 2);
  assert.equal(vectorStore.get("sp-a").revision, 1);
  assert.equal(vectorStore.get("sp-b").revision, 3);
  assert.deepEqual(
    [...provider.calls].sort(),
    ["标题A\n正文A", "标题B\n摘要B\n正文B"].sort(),
    "每张卡恰嵌入一次，文本口径 title/summary/content",
  );
  // 落盘真值：另开只读实例能看到同批条目（saveIfDirty 真的落了盘）。
  const disk = await openSemanticVectorStore({ stateRoot, scopeId: "amber", model: "stub/model", dims: 8 });
  try {
    assert.equal(disk.size(), 2, "索引已原子落盘");
    assert.equal(disk.get("sp-a").revision, 1);
  } finally {
    disk.close();
  }
});

test("同一卡窗口内连续变更：只 embed 最新态（revision 取读卡真值，embed 恰一次）", async (t) => {
  const { spark, provider, vectorStore, queue, cleanup } = await setup({ cards: [cardA(1)] });
  t.after(cleanup);
  queue.markDirty("sp-a");
  spark.cards.set("sp-a", { ...cardA(2), title: "标题A2" }); // 防抖窗口内卡又被改（revision 2）
  queue.markDirty("sp-a");
  assert.ok(await waitFor(() => queue.stats().flushes === 1 && queue.stats().pending === 0));
  assert.equal(vectorStore.get("sp-a").revision, 2, "索引写的是最新 revision");
  assert.deepEqual(provider.calls, ["标题A2\n正文A"], "只嵌最新文本一次");
  assert.equal(provider.attempts, 1);
});

test("spark_forget 语义：入队后读到的卡非 active → 索引剔除 + 落盘无残留", async (t) => {
  const { spark, provider, vectorStore, queue, stateRoot, cleanup } = await setup({ cards: [cardA(2)] });
  t.after(cleanup);
  // 预置索引已有该卡条目（save 后又被 archive 的场景）。
  vectorStore.upsert("sp-a", 1, new Float32Array(8).fill(0.1));
  await vectorStore.save();
  spark.cards.set("sp-a", { ...cardA(3), state: "archived" }); // forget 已发生（archive）
  queue.markDirty("sp-a");
  assert.ok(await waitFor(() => queue.stats().flushes === 1 && queue.stats().pending === 0));
  assert.equal(vectorStore.size(), 0, "内存索引无残留");
  assert.equal(queue.stats().removed, 1);
  assert.equal(provider.attempts, 0, "非 active 卡零 embed（不复活旧向量）");
  const disk = await openSemanticVectorStore({ stateRoot, scopeId: "amber", model: "stub/model", dims: 8 });
  try {
    assert.equal(disk.size(), 0, "落盘无残留条目");
  } finally {
    disk.close();
  }
});

test("spark_forget supersede：原卡剔除、替代卡差集重嵌到新 revision", async (t) => {
  const { spark, provider, vectorStore, queue, cleanup } = await setup({
    cards: [
      { id: "sp-old", revision: 5, state: "superseded", supersededBy: "sp-new", title: "旧卡", content: "旧" },
      { id: "sp-new", revision: 2, state: "active", title: "新卡", content: "新" },
    ],
  });
  t.after(cleanup);
  // 预置：旧卡残留向量 + 替代卡过期向量（替代卡正文未变但 revision +1，需重嵌刷新）。
  vectorStore.upsert("sp-old", 4, new Float32Array(8).fill(0.2));
  vectorStore.upsert("sp-new", 1, new Float32Array(8).fill(0.3));
  await vectorStore.save();
  queue.markDirty("sp-old");
  queue.markDirty("sp-new");
  assert.ok(await waitFor(() => queue.stats().flushes === 1 && queue.stats().pending === 0));
  assert.equal(vectorStore.size(), 1, "原卡条目已剔除");
  assert.equal(vectorStore.get("sp-old"), null);
  assert.equal(vectorStore.get("sp-new").revision, 2, "替代卡按新 revision 重嵌");
  assert.deepEqual(provider.calls, ["新卡\n新"], "只重嵌替代卡（原卡非 active 直接剔除）");
  assert.equal(queue.stats().removed, 1);
});

test("失败静默重试一次：首嵌失败后同轮重试成功，pending 清零、lastError 不残留", async (t) => {
  const { vectorStore, queue, provider, cleanup } = await setup({
    cards: [cardA(1)],
    provider: { failTexts: new Set([embedTextOf(cardA(1))]), failOncePerText: true },
  });
  t.after(cleanup);
  queue.markDirty("sp-a");
  await queue.flushNow(); // 事件门控：直接等本轮收场
  assert.equal(vectorStore.size(), 1);
  assert.equal(vectorStore.get("sp-a").revision, 1);
  assert.equal(provider.attempts, 2, "失败一次 + 静默重试一次");
  assert.equal(provider.calls.length, 1, "重试成功后只留一次成功嵌入");
  assert.equal(queue.stats().pending, 0);
  assert.equal(queue.stats().lastError, null, "重试成功：错误不残留（面板只见当前故障）");
});

test("重试仍失败：该卡保留 pending、lastError 可见，其余卡正常入索引不受牵连", async (t) => {
  const badCard = { id: "sp-bad", revision: 1, state: "active", title: "坏卡", content: "X" };
  const { vectorStore, queue, provider, cleanup } = await setup({
    cards: [cardA(1), badCard],
    provider: { failTexts: new Set([embedTextOf(badCard)]) },
  });
  t.after(cleanup);
  queue.markDirty("sp-a");
  queue.markDirty("sp-bad");
  await queue.flushNow();
  assert.equal(vectorStore.size(), 1, "成功卡已入索引");
  assert.equal(vectorStore.get("sp-a").revision, 1);
  const stats = queue.stats();
  assert.equal(stats.pending, 1, "失败卡保留 pending 等下次触发");
  assert.match(stats.lastError, /sp-bad/, "失败诊断可见（含卡 id）");
  assert.equal(provider.attempts, 3,
    `成功卡 1 次 + 失败卡首试 1 次 + 静默重试 1 次（实际 ${provider.attempts}）`);
});

test("单飞闸：闸被占（模拟重建持锁）时 flush 零写索引零 embed；放行后按差集补齐", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const gate = createSemanticGate();
  const holder = gate.run(async () => { await held; }); // 模拟 runSemanticRebuild 持锁中
  const { vectorStore, queue, provider, cleanup } = await setup({ gate, cards: [cardA(1)] });
  t.after(cleanup);
  queue.markDirty("sp-a");
  const flushed = queue.flushNow(); // 不 await：应卡在闸外
  assert.ok(await waitFor(() => queue.stats().running === true), "flush 轮已启动并被闸拦下");
  assert.equal(vectorStore.size(), 0, "持锁期间索引零写入（严禁与 clear/retainOnly 交错）");
  assert.equal(provider.attempts, 0, "持锁期间零嵌入调用");
  release();
  await holder;
  await flushed; // 闸放行后本轮收场
  assert.equal(vectorStore.size(), 1, "锁释放后按差集补齐");
  assert.equal(vectorStore.get("sp-a").revision, 1);
  assert.equal(queue.stats().pending, 0);
});

test("降级 HOST_LOCKED：canWrite=false → 零 embed 零写、pending 保留、skip 原因可诊断", async (t) => {
  const { vectorStore, queue, provider, cleanup } = await setup({ canWrite: () => false, cards: [cardA(1)] });
  t.after(cleanup);
  queue.markDirty("sp-a");
  await queue.flushNow();
  assert.equal(provider.attempts, 0);
  assert.equal(vectorStore.size(), 0);
  assert.equal(queue.stats().pending, 1, "pending 保留（写权回来后下次触发收敛）");
  assert.equal(queue.stats().lastSkipReason, "host-readonly");
});

test("降级 模型未装：canEmbed=false → 同款零副作用，skip 原因 model-not-installed", async (t) => {
  const { vectorStore, queue, provider, cleanup } = await setup({ canEmbed: () => false, cards: [cardA(1)] });
  t.after(cleanup);
  queue.markDirty("sp-a");
  await queue.flushNow();
  assert.equal(provider.attempts, 0);
  assert.equal(vectorStore.size(), 0);
  assert.equal(queue.stats().pending, 1);
  assert.equal(queue.stats().lastSkipReason, "model-not-installed");
});

test("启动差集兜底：过期 revision 补嵌、残留条目剔除、新鲜卡零 embed（retainOnly 只在真有残留时触碰）", async (t) => {
  const { spark, vectorStore, queue, provider, cleanup } = await setup({
    cards: [
      { id: "sp-x", revision: 2, state: "active", title: "过期卡", content: "X" },
      { id: "sp-n", revision: 1, state: "active", title: "新鲜卡", content: "N" },
    ],
  });
  t.after(cleanup);
  // 预置：sp-x 过期（索引 rev1 / 真值 rev2）+ 幽灵残留 + sp-n 新鲜。
  vectorStore.upsert("sp-x", 1, new Float32Array(8).fill(0.1));
  vectorStore.upsert("sp-ghost", 1, new Float32Array(8).fill(0.2));
  vectorStore.upsert("sp-n", 1, new Float32Array(8).fill(0.3));
  await vectorStore.save();
  await queue.kickStartupSync(); // 事件门控：直接等差集轮收场
  const stats = queue.stats();
  assert.equal(stats.startupSyncs, 1);
  assert.equal(vectorStore.get("sp-x").revision, 2, "过期卡已按真值补嵌");
  assert.equal(vectorStore.get("sp-ghost"), null, "残留条目已剔除");
  assert.equal(vectorStore.get("sp-n").revision, 1, "新鲜卡条目原样保留");
  assert.equal(stats.removed, 1);
  assert.deepEqual(provider.calls, ["过期卡\nX"], "只补嵌过期卡（新鲜卡零 embed）");
  assert.equal(provider.attempts, 1);
  assert.equal(spark.cards.size, 2, "差集不改卡数据（只读比对）");
});

test("启动差集单卡失败：失败卡转入 dirty 队列自动排下一轮 flush 重试", async (t) => {
  const badCard = { id: "sp-bad", revision: 1, state: "active", title: "坏卡", content: "X" };
  const { queue, provider, vectorStore, cleanup } = await setup({
    cards: [badCard, { id: "sp-ok", revision: 1, state: "active", title: "好卡", content: "Y" }],
    provider: { failTexts: new Set([embedTextOf(badCard)]) },
  });
  t.after(cleanup);
  await queue.kickStartupSync();
  assert.equal(vectorStore.get("sp-ok").revision, 1, "成功卡已补嵌");
  assert.equal(queue.stats().pending, 1, "失败卡已转入 dirty 队列");
  // 失败卡经下一轮 flush（防抖自动排程）重试仍失败 → 保留 pending，不无限循环。
  assert.ok(await waitFor(() => queue.stats().flushes === 1 && queue.stats().running === false));
  assert.equal(vectorStore.get("sp-bad"), null);
  assert.equal(queue.stats().pending, 1, "flush 重试仍失败：保留 pending（不无限重试）");
});

test("close()：防抖 timer 清除、markDirty 变 no-op、flushNow 即刻空转收场", async (t) => {
  const { vectorStore, queue, provider, cleanup } = await setup({ cards: [cardA(1)] });
  t.after(cleanup);
  queue.close();
  queue.markDirty("sp-a");
  assert.equal(queue.stats().pending, 0, "close 后标记被忽略");
  await queue.flushNow();
  assert.equal(queue.stats().flushes, 0, "close 后 flush 为空转（不计轮次）");
  assert.equal(vectorStore.size(), 0);
  assert.equal(provider.attempts, 0);
});

test("防抖窗口内三张卡合并为一轮 flush：批量 embed（flushes===1、轮末一次落盘）", async (t) => {
  const { vectorStore, queue, provider, cleanup } = await setup({
    cards: [
      { id: "sp-1", revision: 1, state: "active", title: "一", content: "甲" },
      { id: "sp-2", revision: 1, state: "active", title: "二", content: "乙" },
      { id: "sp-3", revision: 1, state: "active", title: "三", content: "丙" },
    ],
  });
  t.after(cleanup);
  queue.markDirty("sp-1");
  queue.markDirty("sp-2");
  queue.markDirty("sp-3");
  assert.ok(await waitFor(() => queue.stats().flushes === 1 && queue.stats().pending === 0 && queue.stats().running === false));
  assert.equal(vectorStore.size(), 3);
  assert.equal(provider.calls.length, 3);
  assert.equal(queue.stats().embedded, 3);
});

test("wrapSparkStoreWithIncrementalHooks：save/update/forget 成功入队、失败不入队、其余方法透传、supersede 双标", async (t) => {
  const marked = [];
  const queue = { markDirty: (id) => marked.push(id) };
  const resultCard = (id, extra = {}) => ({ id, revision: 1, state: "active", ...extra });
  let forgetShouldThrow = false;
  const bare = {
    savedWith: [],
    async save(input, opts) { this.savedWith.push({ input, opts }); return resultCard("sp-1"); },
    async update(id, patch) { return resultCard(id, { patched: patch }); },
    async forget(id) {
      if (forgetShouldThrow) throw Object.assign(new Error("REVISION_CONFLICT 桩"), { code: "REVISION_CONFLICT" });
      return resultCard(id, { state: "superseded", supersededBy: "sp-replacement" });
    },
    async read(id) { return resultCard(id); },
  };
  const wrapped = wrapSparkStoreWithIncrementalHooks(bare, queue);
  // save / update：成功 → result 原样透传 + id 入队。
  const saveResult = await wrapped.save({ title: "t" }, { operationId: "op-1" });
  assert.deepEqual(saveResult, resultCard("sp-1"));
  assert.deepEqual(bare.savedWith, [{ input: { title: "t" }, opts: { operationId: "op-1" } }], "入参原样透传");
  await wrapped.update("sp-2", { title: "t2" });
  assert.deepEqual(marked, ["sp-1", "sp-2"]);
  // forget（supersede）：原卡 + 替代卡双双入队。
  await wrapped.forget("sp-3");
  assert.deepEqual(marked, ["sp-1", "sp-2", "sp-3", "sp-replacement"]);
  // 失败路径：写抛错 → 不入队、错误原样上抛（不吞错回 success）。
  forgetShouldThrow = true;
  await assert.rejects(() => wrapped.forget("sp-4"), (e) => e.code === "REVISION_CONFLICT");
  assert.equal(marked.length, 4, "失败的写不挂钩子");
  // 其余方法/结构判定透传：read 可用，isPlainRecord 风格判定不受 Proxy 影响。
  assert.deepEqual(await wrapped.read("sp-5"), resultCard("sp-5"));
  assert.equal(Object.getPrototypeOf(wrapped), Object.prototype, "原型链与裸 store 一致（工具门面结构判定不破）");
  assert.equal(wrapped.read, wrapped.read, "透传方法引用稳定（bound 缓存）");
});

test("接线校验：缺 provider/gate 等必填依赖当场 INVALID_INPUT（fail-fast，不带病运行）", () => {
  const gate = createSemanticGate();
  const base = {
    scopeId: "amber",
    provider: { embed: async () => new Float32Array(8) },
    openVectorStore: async () => null,
    readCard: async () => null,
    listActive: async () => [],
    embedText: () => "",
    gate,
  };
  assert.throws(() => createSemanticIncrementalQueue({ ...base, provider: null }), /provider/);
  assert.throws(() => createSemanticIncrementalQueue({ ...base, gate: null }), /gate/);
  assert.throws(() => createSemanticIncrementalQueue({ ...base, readCard: undefined }), /readCard/);
  assert.throws(() => createSemanticIncrementalQueue({ ...base, debounceMs: 0 }), /debounceMs/);
  assert.throws(() => createSemanticIncrementalQueue({ ...base, debounceMs: -1 }), /debounceMs/);
  assert.throws(() => createSemanticIncrementalQueue({ ...base, batchSize: 0 }), /batchSize/);
  assert.throws(() => wrapSparkStoreWithIncrementalHooks(null, { markDirty() {} }), /store/);
  assert.throws(() => wrapSparkStoreWithIncrementalHooks({}, null), /markDirty/);
});
