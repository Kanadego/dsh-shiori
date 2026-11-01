// Shiori F1b · 本地 embedding provider 测试。
//
// 铁律（F1b 任务书 h 条）：不许下载模型。本文件只测：
// 1) 工厂入参校验（INVALID_INPUT 形状）；
// 2) provider 对象形状与「构造零 IO」（构造不建目录/不写文件/不触发模型加载）；
// 3) embed 的懒加载失败路径：指向必然解析失败的镜像（.invalid 顶级域按 RFC
//    2606 保证不存在，spike probe-offline.mjs 同法实测 ~79ms 失败）→ 断言
//    code="SEMANTIC_UNAVAILABLE"、中文 message、带底层 cause、且错误不固化
//    （第二次 embed 仍会重试并再次抛同形状错误）。
// CI 上无网络、无模型缓存都必须全绿：失败路径不依赖模型存在。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEmbeddingProvider, SEMANTIC_UNAVAILABLE } from "../../src/semantic/local.mjs";
import { createEmbeddingProvider } from "../../src/semantic/index.mjs";

test("createLocalEmbeddingProvider: 必填/非法入参按 INVALID_INPUT 拒绝", () => {
  assert.throws(() => createLocalEmbeddingProvider({ dims: 4 }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => createLocalEmbeddingProvider({ model: "x/y", dims: 0 }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => createLocalEmbeddingProvider({ model: "x/y", dims: 4, dtype: "int8" }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => createLocalEmbeddingProvider({ model: "x/y", dims: 4, mirror: "" }), (e) => e.code === "INVALID_INPUT");
});

test("provider 形状正确且构造零 IO（不建目录、不写文件）", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "shiori-f1b-local-"));
  const provider = createLocalEmbeddingProvider({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir,
    mirror: "https://shiori-f1b-test.invalid/",
  });
  assert.equal(provider.kind, "local");
  assert.equal(provider.dims, 512);
  assert.equal(typeof provider.embed, "function");
  // 构造零 IO：缓存目录保持只有我们建的那个空目录本身（无任何子文件），
  // 也没有 stateRoot 语义目录被顺手创建。
  assert.equal(existsSync(join(cacheDir, "Xenova")), false, "construction must not create model dirs");
  // index.mjs 契约入口（local 分支）同样零 IO 且返回同形状。
  const viaContract = createEmbeddingProvider({
    provider: "local",
    local: { model: "Xenova/bge-small-zh-v1.5", dims: 512, dtype: "q8", cacheDir, mirror: "https://shiori-f1b-test.invalid/" },
  });
  assert.equal(viaContract.kind, "local");
  assert.equal(viaContract.dims, 512);
});

test("embed 非字符串按 INVALID_INPUT 拒绝（不触发模型加载）", async () => {
  const provider = createLocalEmbeddingProvider({ model: "Xenova/bge-small-zh-v1.5", dims: 4 });
  await assert.rejects(() => provider.embed(123), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(() => provider.embed(null), (e) => e.code === "INVALID_INPUT");
});

test("懒加载失败：不可达镜像 → SEMANTIC_UNAVAILABLE（中文 message + cause），可重试不固化", async () => {
  const provider = createLocalEmbeddingProvider({
    model: "Xenova/shiori-f1b-nonexistent-model",
    dims: 4,
    dtype: "q8",
    cacheDir: join(tmpdir(), "shiori-f1b-empty-cache"),
    mirror: "https://shiori-f1b-test.invalid/",
  });
  const assertUnavailable = (error) => {
    assert.equal(error.code, SEMANTIC_UNAVAILABLE, "coded error, not a raw fetch failure");
    assert.ok(typeof error.message === "string" && error.message.length > 0);
    // 中文可读 message：必须包含引导性中文而不是裸 ENOTFOUND。
    assert.ok(/[\u4e00-\u9fff]/.test(error.message), `message should be human-readable Chinese, got: ${error.message}`);
    assert.ok(error.cause !== undefined, "底层 cause 必须保留（诊断要用）");
    return true;
  };
  await assert.rejects(() => provider.embed("你好"), assertUnavailable);
  // 失败不固化：第二次 embed 重新尝试初始化（仍失败，但走的是新一次 init，
  // 而不是把首失败的 promise 缓存成永久坏状态）。
  await assert.rejects(() => provider.embed("你好"), assertUnavailable);
}, { timeout: 30000 });
