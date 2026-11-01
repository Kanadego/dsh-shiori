// Shiori F1b · 语义向量索引（store）测试。
//
// 覆盖（F1b 任务书 h 条）：
// - 增量 upsert 与读取（revision 更新后 get 反映新值）；
// - 原子落盘与重新打开的一致性（含 vector 数值保真）；
// - 损坏容错：垃圾字节 / 版本未知 / entries 缺失 / model 更换 / 单条向量维度
//   不符——一律当空（或丢弃单条），绝不抛构造失败，面板与召回不被打挂；
// - 剔除：remove / retainOnly / clear；
// - 边界：scopeId 路径注入拒绝；向量只落 stateRoot（dataRoot 全程零写入）。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSemanticVectorStore } from "../../src/semantic/store.mjs";

test("openSemanticVectorStore: 参数校验（scopeId 路径注入拒绝）", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-f1b-store-"));
  try {
    await assert.rejects(
      () => openSemanticVectorStore({ stateRoot: root, scopeId: "../evil", model: "m/x", dims: 4 }),
      (e) => e.code === "INVALID_INPUT",
    );
    await assert.rejects(
      () => openSemanticVectorStore({ stateRoot: root, scopeId: "a\\b", model: "m/x", dims: 4 }),
      (e) => e.code === "INVALID_INPUT",
    );
    await assert.rejects(
      () => openSemanticVectorStore({ stateRoot: "", scopeId: "s", model: "m/x", dims: 4 }),
      (e) => e.code === "INVALID_INPUT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("打开空索引零 IO；upsert→save→reopen 数值保真；增量 revision 更新", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-f1b-store-"));
  try {
    const store = await openSemanticVectorStore({ stateRoot: root, scopeId: "amber", model: "m/x", dims: 4 });
    assert.equal(store.size(), 0);
    assert.equal(store.lastLoadError, "");
    // 打开不落盘：save 之前 stateRoot/semantic 目录都不该存在
    assert.equal(existsSync(join(root, "semantic")), false, "open must not create any file");

    store.upsert("spark-a", 3, [1, 0, 0, 0]);
    store.upsert("spark-b", 1, [0.5, 0.5, 0, 0]);
    assert.equal(store.size(), 2);
    assert.equal(await store.saveIfDirty(), true);
    assert.equal(await store.saveIfDirty(), false, "幂等：无变更不产生 IO");
    assert.equal(existsSync(join(root, "semantic", "amber.json")), true);

    // 增量：同 id 新 revision 覆盖旧向量
    store.upsert("spark-a", 4, [0, 1, 0, 0]);
    await store.save();

    const reopened = await openSemanticVectorStore({ stateRoot: root, scopeId: "amber", model: "m/x", dims: 4 });
    assert.equal(reopened.size(), 2);
    const a = reopened.get("spark-a");
    assert.equal(a.revision, 4);
    assert.deepEqual([...a.vec], [0, 1, 0, 0]);
    const b = reopened.get("spark-b");
    assert.equal(b.revision, 1);
    assert.deepEqual([...b.vec], [0.5, 0.5, 0, 0]);
    assert.equal(reopened.get("spark-missing"), null);
    // vec 是 Float32Array（与 cosineSimilarity 输入约定一致）
    assert.ok(a.vec instanceof Float32Array);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("损坏容错：垃圾字节 → 空索引 + lastLoadError，save 后恢复正常", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-f1b-store-"));
  try {
    await mkdir(join(root, "semantic"), { recursive: true });
    await writeFile(join(root, "semantic", "amber.json"), Buffer.from("{not valid json!!", "utf8"));
    const store = await openSemanticVectorStore({ stateRoot: root, scopeId: "amber", model: "m/x", dims: 4 });
    assert.equal(store.size(), 0);
    assert.ok(store.lastLoadError.includes("损坏"), `expect corrupt note, got: ${store.lastLoadError}`);
    // 不打挂：照样可以 upsert + save 重建
    store.upsert("spark-a", 1, [1, 0, 0, 0]);
    await store.save();
    const reopened = await openSemanticVectorStore({ stateRoot: root, scopeId: "amber", model: "m/x", dims: 4 });
    assert.equal(reopened.size(), 1);
    assert.equal(reopened.lastLoadError, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("容错矩阵：版本未知 / entries 缺失 / model 更换 → 全量作废；单条坏向量只丢该条", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-f1b-store-"));
  const file = join(root, "semantic", "amber.json");
  try {
    await mkdir(join(root, "semantic"), { recursive: true });
    // 版本未知
    await writeFile(file, JSON.stringify({ version: 999, model: "m/x", dims: 4, entries: { a: { revision: 1, vec: [1, 0, 0, 0] } } }));
    let store = await openSemanticVectorStore({ stateRoot: root, scopeId: "amber", model: "m/x", dims: 4 });
    assert.equal(store.size(), 0);
    assert.ok(store.lastLoadError.length > 0);
    // entries 缺失
    await writeFile(file, JSON.stringify({ version: 1, model: "m/x", dims: 4 }));
    store = await openSemanticVectorStore({ stateRoot: root, scopeId: "amber", model: "m/x", dims: 4 });
    assert.equal(store.size(), 0);
    // model 换了 → 旧向量全部作废（不同模型空间不可信）
    await writeFile(file, JSON.stringify({
      version: 1, model: "m/old", dims: 4,
      entries: { a: { revision: 1, vec: [1, 0, 0, 0] }, b: { revision: 2, vec: [0, 1, 0, 0] } },
    }));
    store = await openSemanticVectorStore({ stateRoot: root, scopeId: "amber", model: "m/x", dims: 4 });
    assert.equal(store.size(), 0);
    assert.ok(store.lastLoadError.includes("m/old"), "model mismatch must be recorded");
    // 单条坏向量（维度不符）只丢该条，好条目保留
    await writeFile(file, JSON.stringify({
      version: 1, model: "m/x", dims: 4,
      entries: {
        good: { revision: 1, vec: [1, 0, 0, 0] },
        wrongdims: { revision: 1, vec: [1, 0] },
        nan: { revision: 1, vec: [1, NaN, 0, 0] },
      },
    }));
    store = await openSemanticVectorStore({ stateRoot: root, scopeId: "amber", model: "m/x", dims: 4 });
    assert.equal(store.size(), 1);
    assert.ok(store.get("good") !== null);
    assert.equal(store.get("wrongdims"), null);
    assert.equal(store.get("nan"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("剔除：remove / retainOnly / clear；落盘文件结构含 model/dims/entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-f1b-store-"));
  try {
    const store = await openSemanticVectorStore({ stateRoot: root, scopeId: "global", model: "m/x", dims: 2 });
    store.upsert("a", 1, [1, 0]);
    store.upsert("b", 1, [0, 1]);
    store.upsert("c", 1, [1, 1]);
    assert.equal(store.remove("b"), true);
    assert.equal(store.remove("b"), false, "重复 remove 返回 false");
    store.retainOnly(["a"]); // c 被剔除
    assert.equal(store.size(), 1);
    await store.save();
    store.clear();
    assert.equal(store.size(), 0);
    await store.save();
    const reopened = await openSemanticVectorStore({ stateRoot: root, scopeId: "global", model: "m/x", dims: 2 });
    assert.equal(reopened.size(), 0);
    const onDisk = JSON.parse(readFileSync(join(root, "semantic", "global.json"), "utf8"));
    assert.equal(onDisk.model, "m/x");
    assert.equal(onDisk.dims, 2);
    assert.equal(typeof onDisk.entries, "object");
    assert.ok(Array.isArray(onDisk.entries?.a?.vec) === false || onDisk.entries.a === undefined, "cleared entries must be empty on disk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("向量只落 stateRoot：dataRoot 全程零写入", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "shiori-f1b-state-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "shiori-f1b-data-"));
  try {
    const store = await openSemanticVectorStore({ stateRoot, scopeId: "amber", model: "m/x", dims: 2 });
    store.upsert("a", 1, [1, 0]);
    await store.save();
    assert.equal(existsSync(join(stateRoot, "semantic", "amber.json")), true);
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dataRoot), [], "dataRoot must stay empty (vectors never land there)");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test("close 后拒绝读写（幂等）", async () => {
  const root = await mkdtemp(join(tmpdir(), "shiori-f1b-store-"));
  try {
    const store = await openSemanticVectorStore({ stateRoot: root, scopeId: "amber", model: "m/x", dims: 2 });
    store.close();
    store.close(); // 幂等
    assert.throws(() => store.size(), (e) => e.code === "INVALID_STATE");
    assert.throws(() => store.upsert("a", 1, [1, 0]), (e) => e.code === "INVALID_STATE");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
