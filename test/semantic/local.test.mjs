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
//
// S5 追加（模型下载层，同样零网络）：progress 聚合器（去重/加权）、下载器的
// 多源回退 / 协作取消 / 文件名 + 维度双校验、isLocalModelInstalled——全部经
// loadTransformers 注入假运行时，绝不 import 真实 transformers.js。

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalEmbeddingProvider,
  SEMANTIC_UNAVAILABLE,
  DOWNLOAD_CANCELLED,
  DOWNLOAD_DEPENDENCY_MISSING,
  DOWNLOAD_RUNTIME_LOAD_FAILED,
  createLocalModelDownloader,
  createModelProgressAggregator,
  expectedModelFiles,
  isLocalModelInstalled,
  localModelDir,
} from "../../src/semantic/local.mjs";
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

// ─────────────────────────────────────────────────────────
// S5 · 模型下载层（零网络：假运行时注入）
// ─────────────────────────────────────────────────────────

test("S5 进度聚合：按 file 去重、按 total 字节加权、done 补齐、无 total 文件不进分母", () => {
  const agg = createModelProgressAggregator();
  // 无文件事件（ready 等）与垃圾输入直接忽略。
  agg.push({ status: "ready" });
  agg.push(null);
  agg.push("junk");
  agg.push({ status: "initiate", file: "config.json" });
  agg.push({ status: "progress", file: "config.json", loaded: 100, total: 200 });
  // 同一文件的后续 progress 覆盖旧值（去重），不累加。
  agg.push({ status: "progress", file: "config.json", loaded: 160, total: 200 });
  // 另一个大文件参与加权：总 200+800，已下 160+0 → 16%。
  agg.push({ status: "initiate", file: "onnx/model_quantized.onnx" });
  agg.push({ status: "progress", file: "onnx/model_quantized.onnx", loaded: 0, total: 800 });
  let snap = agg.snapshot();
  assert.deepEqual(snap, { percent: 16, loadedBytes: 160, totalBytes: 1000, filesDone: 0, filesTotal: 2 });
  // unknown total 的文件只计入已下载字节，不进百分比分母。
  agg.push({ status: "progress", file: "tokenizer.json", loaded: 30 });
  snap = agg.snapshot();
  assert.equal(snap.totalBytes, 1000, "无 total 文件不进分母");
  assert.equal(snap.loadedBytes, 190, "已下载字节含无 total 文件");
  assert.equal(snap.percent, 16, "百分比只按已知 total 加权");
  assert.equal(snap.filesTotal, 3);
  // done：loaded 补齐为 total；unknown-total 的 done 也计数。
  agg.push({ status: "done", file: "config.json" });
  agg.push({ status: "done", file: "tokenizer.json" });
  snap = agg.snapshot();
  assert.equal(snap.filesDone, 2);
  // tokenizer.json 无 total：done 只标完成，loaded 保持 30（200+30），不凭空补齐。
  assert.equal(snap.loadedBytes, 230);
  // 全零分母 → percent null（不显示 0% 假象）。
  const empty = createModelProgressAggregator();
  assert.deepEqual(empty.snapshot(), { percent: null, loadedBytes: 0, totalBytes: 0, filesDone: 0, filesTotal: 0 });
});

test("S5 expectedModelFiles / localModelDir：dtype→文件清单与 <cacheDir>/<org>/<model> 布局；非法入参拒绝", () => {
  assert.deepEqual(expectedModelFiles("q8"), ["config.json", "tokenizer.json", "onnx/model_quantized.onnx"]);
  assert.deepEqual(expectedModelFiles("fp32")[2], "onnx/model.onnx");
  assert.deepEqual(expectedModelFiles("fp16")[2], "onnx/model_fp16.onnx");
  assert.throws(() => expectedModelFiles("int8"), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => localModelDir("", "a/b"), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => localModelDir("/tmp/x", "bge"), (e) => e.code === "INVALID_INPUT"); // 短名不是完整 repo id
  // P0#3：localModelDir 是目录解析的防御二道闸——相对路径与含 .. 片段一律拒绝
  //（config 层已拦手动目录，这里挡「绕过 config 直接调本模块」的路径）。
  assert.throws(() => localModelDir(join("cache", "root"), "Xenova/bge-small-zh-v1.5"),
    (e) => e.code === "INVALID_INPUT" && /absolute path/.test(e.message),
    "相对路径 cacheDir 被拒（P0#3）");
  assert.throws(() => localModelDir(join(tmpdir(), "cache") + "/../root", "Xenova/bge-small-zh-v1.5"),
    (e) => e.code === "INVALID_INPUT" && /\.\./.test(e.message),
    "含 .. 片段的 cacheDir 被拒（P0#3）");
  // 规范绝对路径照常通过：布局契约不变（纯路径计算，无 IO）。
  const dir = localModelDir(join(tmpdir(), "cache", "root"), "Xenova/bge-small-zh-v1.5");
  assert.ok(dir.includes(join(tmpdir(), "cache", "root", "Xenova", "bge-small-zh-v1.5")));
});

test("S5 isLocalModelInstalled：三文件齐全 true、缺一 false、fs 异常按未安装（不抛）", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "shiori-s5-inst-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cacheDir = base;
  const model = "Xenova/bge-small-zh-v1.5";
  const args = { cacheDir, model, dtype: "q8" };
  assert.equal(isLocalModelInstalled(args), false, "什么都没有 = 未安装");
  const modelDir = localModelDir(cacheDir, model);
  mkdirSync(join(modelDir, "onnx"), { recursive: true });
  for (const rel of expectedModelFiles("q8")) {
    writeFileSync(join(modelDir, ...rel.split("/")), "x");
  }
  assert.equal(isLocalModelInstalled(args), true, "三文件齐全 = 已安装");
  // 缺一个文件（半截下载）→ false。
  const argsFp32 = { cacheDir, model, dtype: "fp32" };
  assert.equal(isLocalModelInstalled(argsFp32), false, "fp32 的 onnx 文件没下 = 未安装");
});

/** 假 transformers.js 运行时：记录调用，按脚本回放 progress 事件。 */
function fakeTransformers({ cacheDir, script = [], extractorDims = 512, installFiles = null, pipelineError = null } = {}) {
  const env = {};
  const pipelineCalls = [];
  const module = {
    env,
    pipeline: async (task, model, opts) => {
      pipelineCalls.push({ task, model, opts });
      if (pipelineError) throw pipelineError;
      for (const event of script) {
        opts.progress_callback(event);
      }
      if (installFiles !== null) {
        // 模拟 transformers.js 的落盘：把期望文件写进 cacheDir（真下载的替身）。
        // cacheDir 必须显式给出：缺省时宁可报错也绝不往相对路径（测试 cwd）写。
        if (typeof cacheDir !== "string" || cacheDir.length === 0) {
          throw new Error("fakeTransformers: installFiles 需要显式 cacheDir");
        }
        for (const rel of installFiles) {
          const target = join(cacheDir, model, ...rel.split("/"));
          mkdirSync(join(target, ".."), { recursive: true });
          writeFileSync(target, "fake");
        }
      }
      return async () => ({ data: new Float32Array(extractorDims) });
    },
  };
  return { env, pipelineCalls, module };
}

test("S5 下载器：镜像失败回落官方源；进度透传；env.remoteHost 逐源重设；done 后文件齐全", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "shiori-s5-dl-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const cacheDir = base;
  const mirror = "https://hf-mirror.com/";
  const official = "https://huggingface.co/";
  // 复审 P1 新契约：运行时只加载一次；镜像源失败 / 官方源成功的分歧由
  // env.remoteHost 表达（与真实 transformers.js 的单例 env 同构），不再
  // 逐源注入不同模块。
  const runtime = fakeTransformers({
    cacheDir,
    script: [
      { status: "initiate", file: "config.json" },
      { status: "progress", file: "config.json", loaded: 100, total: 100 },
      { status: "done", file: "config.json" },
    ],
    installFiles: expectedModelFiles("q8"),
  });
  const remoteHostsSeen = [];
  const realPipeline = runtime.module.pipeline;
  runtime.module.pipeline = async (task, model, opts) => {
    remoteHostsSeen.push(runtime.env.remoteHost);
    if (runtime.env.remoteHost === mirror) throw new Error("ENOTFOUND mirror");
    return realPipeline(task, model, opts);
  };
  const progressSnaps = [];
  const sources = [];
  const phases = [];
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir,
    mirrors: [mirror, official],
    loadTransformers: async () => runtime.module,
  });
  const result = await downloader.download({
    onProgress: (snap) => progressSnaps.push(snap),
    onSource: (source) => sources.push(source),
    onPhase: (phase) => phases.push(phase),
  });
  assert.deepEqual(result, { ok: "done", source: official, attempts: [ { source: mirror, error: "ENOTFOUND mirror" } ] },
    "镜像失败后回落官方源，attempts 留痕");
  assert.equal(sources[0], mirror, "先试镜像（env.remoteHost 口径）");
  assert.equal(sources[1], official, "失败回落官方源");
  assert.deepEqual(remoteHostsSeen, [mirror, official], "env.remoteHost 逐源重设（镜像先、官方后）");
  assert.equal(runtime.env.cacheDir, cacheDir, "cacheDir 交给 env");
  assert.ok(progressSnaps.length > 0, "progress_callback 快照透传");
  assert.equal(progressSnaps[progressSnaps.length - 1].percent, 100);
  assert.ok(phases.includes("downloading") && phases.includes("verifying"), "阶段推进 downloading → verifying");
  assert.equal(isLocalModelInstalled({ cacheDir, model: "Xenova/bge-small-zh-v1.5", dtype: "q8" }), true,
    "假运行时落盘的文件使 isLocalModelInstalled 为 true");
});

test("S5 下载器：维度校验失败 → ok=error 且 message 可读（期望/实际 dims）", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "shiori-s5-dim-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fake = fakeTransformers({ cacheDir: base, extractorDims: 768, installFiles: expectedModelFiles("fp32") });
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "fp32",
    cacheDir: base,
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => fake.module,
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.match(result.error, /512/);
  assert.match(result.error, /768/);
  assert.match(result.error, /维度/);
});

test("S5 下载器：文件缺失（半截下载）→ ok=error 且 message 点名缺失文件", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "shiori-s5-miss-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const fake = fakeTransformers({ cacheDir: base, extractorDims: 512, installFiles: ["config.json"] }); // 只写了 config.json
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: base,
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => fake.module,
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.match(result.error, /tokenizer\.json/);
  assert.match(result.error, /onnx[/\\]model_quantized\.onnx/);
});

test("S5 下载器：协作取消——progress_callback 抛 DOWNLOAD_CANCELLED 哨兵；落定后再查兜底", async (t) => {
  const base = await mkdtemp(join(tmpdir(), "shiori-s5-cancel-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  // 路径 A：isCancelled 翻转后 progress_callback 抛哨兵，pipeline promise 异常收场。
  let cancelled = false;
  const fake = fakeTransformers({
    cacheDir: base,
    script: [
      { status: "initiate", file: "config.json" },
      { status: "progress", file: "config.json", loaded: 1, total: 100 },
    ],
    installFiles: expectedModelFiles("q8"),
    extractorDims: 512,
  });
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: base,
    mirrors: ["https://hf-mirror.com/", "https://huggingface.co/"],
    loadTransformers: async () => {
      // 0.4 收账遗留 2：运行时加载已提到下载源循环外（只跑一次），取消标志在
      // loadTransformers 里翻转 = 进入任何下载源之前就生效；入口检查与逐源
      // 检查都会命中（不再有「第二源」前提）。
      cancelled = true;
      return fake.module;
    },
  });
  const resultA = await downloader.download({ isCancelled: () => cancelled });
  assert.equal(resultA.ok, "cancelled", "取消不以 error 收场");
  assert.equal(resultA.attempts.length, 0, "取消不算失败尝试");
  assert.equal(DOWNLOAD_CANCELLED, "DOWNLOAD_CANCELLED");

  // 路径 B（兜底）：progress_callback 抛哨兵但假 pipeline 不透传（吞掉），pipeline
  // 正常落定 → downloader 落定后再查 isCancelled，仍返回 cancelled 不误报 done。
  let cancelled2 = false;
  const moduleB = {
    env: {},
    pipeline: async (task, model, opts) => {
      try { opts.progress_callback({ status: "progress", file: "config.json", loaded: 5, total: 100 }); }
      catch { /* 假装运行时吞掉了哨兵 */ }
      cancelled2 = true; // pipeline 落定前用户取消
      return async () => ({ data: new Float32Array(512) });
    },
  };
  const downloaderB = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: base,
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => moduleB,
  });
  const resultB = await downloaderB.download({ isCancelled: () => cancelled2 });
  assert.equal(resultB.ok, "cancelled", "落定后复查取消，不误报 done");
});

test("S5 下载器：非法入参 INVALID_INPUT（镜像表空 / 短名 model / 空 cacheDir）", () => {
  const base = { model: "Xenova/bge-small-zh-v1.5", dims: 512, dtype: "q8", cacheDir: "/tmp/x" };
  assert.throws(() => createLocalModelDownloader({ ...base, mirrors: [] }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => createLocalModelDownloader({ ...base, mirrors: ["", "https://a/"] }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => createLocalModelDownloader({ ...base, mirrors: ["https://a/"], model: "bge" }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => createLocalModelDownloader({ ...base, mirrors: ["https://a/"], cacheDir: "" }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => createLocalModelDownloader({ ...base, mirrors: ["https://a/"], dims: 0 }), (e) => e.code === "INVALID_INPUT");
});

test("S5 复审 P1：运行时加载失败 → 依赖缺失归因（DOWNLOAD_DEPENDENCY_MISSING），不进源循环、不误报网络", async () => {
  let loadCalls = 0;
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x", // 依赖缺失路径零 IO：不落盘、不需要真实临时目录
    mirrors: ["https://hf-mirror.com/", "https://huggingface.co/"],
    loadTransformers: async () => {
      loadCalls += 1;
      throw new Error("Cannot find package '@huggingface/transformers'");
    },
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.equal(result.code, DOWNLOAD_DEPENDENCY_MISSING, "归因码区分「缺依赖」与「网络不可达」");
  assert.deepEqual(result.attempts, [], "不进逐源循环：不把依赖缺失记成各源失败");
  assert.equal(loadCalls, 1, "运行时只加载一次（不再每源重复 import）");
  assert.match(result.error, /缺少可选依赖 @huggingface\/transformers/);
  assert.match(result.error, /npm i @huggingface\/transformers/);
  assert.match(result.error, /不是网络问题/, "文案明确这不是网络故障，不把用户引去查下载源");
});

// 0.4 收账遗留 1（+ 复审 P2-1 / P2-3）：加载失败按「缺的到底是谁」细分三类——
// ① 包本身没装（Cannot find 的就是 @huggingface/transformers）→ DEPENDENCY_MISSING；
// ② 包已装但内部缺模块 / 入口缺失（Cannot find 的是别的模块）→ RUNTIME_LOAD_FAILED，
//    文案指出 message 里真正的模块名，不许把责任指错包；
// ③ 其余（EACCES / 版本不兼容 / 包内部报错等）→ RUNTIME_LOAD_FAILED。
// 三类都把原始错误摘要带出去。用例形状取真实 Node 的错误形态（复审 P2-3：
// 版本不兼容是 SyntaxError、无 code——MODULE_NOT_FOUND 配 named-export 缺失
// 的形状真实 Node 不会出现，不再固化）。
test("0.4 收账：依赖已装但运行时加载失败（非 module-not-found）→ DOWNLOAD_RUNTIME_LOAD_FAILED，错误含原始 message", async () => {
  const rawMessage = "EACCES: permission denied, open '<插件目录>/node_modules/@huggingface/transformers/dist/transformers.mjs'";
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x", // 加载失败路径零 IO：不落盘、不需要真实临时目录
    mirrors: ["https://hf-mirror.com/", "https://huggingface.co/"],
    loadTransformers: async () => {
      throw Object.assign(new Error(rawMessage), { code: "EACCES" });
    },
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.equal(result.code, DOWNLOAD_RUNTIME_LOAD_FAILED, "不再是缺依赖归因（npm i 也修不好 EACCES）");
  assert.deepEqual(result.attempts, [], "同样不进逐源循环：加载失败与网络源无关");
  assert.match(result.error, /已安装，但运行时加载失败/);
  assert.match(result.error, /不是网络问题/);
  // 原始错误的可读摘要带出去（不许吞成一句模板话）。
  assert.ok(result.error.includes("EACCES: permission denied"), `错误串要含原始 message，实际：${result.error}`);
});

test("0.4 收账·复审 P2-3：真实形态——无 code 的 SyntaxError（named export 缺失）→ DOWNLOAD_RUNTIME_LOAD_FAILED", async () => {
  // 真实 Node 里版本不兼容长这样：SyntaxError、无 code。归因不看 code 猜，
  // message 里 Cannot find 的判断不再被这种形状误命中。
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x",
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => {
      throw new SyntaxError("The requested module '@huggingface/transformers' does not provide an export named 'pipeline'");
    },
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.equal(result.code, DOWNLOAD_RUNTIME_LOAD_FAILED, "无 code 的 SyntaxError 不是模块解析失败：归运行时加载失败");
  assert.deepEqual(result.attempts, []);
  assert.match(result.error, /已安装，但运行时加载失败/);
  assert.ok(result.error.includes("does not provide an export named 'pipeline'"),
    `错误串要含原始 message，实际：${result.error}`);
});

test("0.4 收账·复审 P2-1 形态①：包本身缺失（Cannot find package '@huggingface/transformers'）→ DOWNLOAD_DEPENDENCY_MISSING", async () => {
  // 真实 ESM 缺包形状：code=ERR_MODULE_NOT_FOUND + Cannot find package。
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x",
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => {
      throw Object.assign(new Error(
        "Cannot find package '@huggingface/transformers' imported from D:/app/node_modules/shiori-plugin/index.mjs",
      ), { code: "ERR_MODULE_NOT_FOUND" });
    },
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.equal(result.code, DOWNLOAD_DEPENDENCY_MISSING, "缺失的就是 @huggingface/transformers 自己：缺依赖归因");
  assert.match(result.error, /缺少可选依赖 @huggingface\/transformers（未随插件包安装）/);
  assert.ok(result.error.includes("Cannot find package '@huggingface/transformers'"),
    `原始错误摘要带出去，实际：${result.error}`);
});

test("0.4 收账·复审 P2-1 形态②：包已装但内部缺模块（缺失的不是它自己）→ RUNTIME_LOAD_FAILED，文案指出真模块名", async () => {
  // 嵌套依赖缺失：缺的是 transformers 的内部依赖（onnxruntime-node）——
  // 不许再报「缺少 @huggingface/transformers（未随插件包安装）」指错包。
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x",
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => {
      throw Object.assign(new Error(
        "Cannot find package 'onnxruntime-node' imported from D:/app/node_modules/@huggingface/transformers/dist/index.js",
      ), { code: "ERR_MODULE_NOT_FOUND" });
    },
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.equal(result.code, DOWNLOAD_RUNTIME_LOAD_FAILED, "包已装、缺的是它的内部依赖：运行时加载失败");
  assert.ok(result.error.includes("「onnxruntime-node」"), `文案要指出 message 里真正的模块名，实际：${result.error}`);
  assert.equal(/缺少可选依赖 @huggingface\/transformers（未随插件包安装）/.test(result.error), false,
    "不许把责任指错包（npm i @huggingface/transformers 修不好内部依赖缺失）");
});

test("0.4 收账·复审 P2-1 形态③：包存在但入口缺失 → RUNTIME_LOAD_FAILED，文案指出真正缺失的入口", async () => {
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x",
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => {
      throw Object.assign(new Error(
        "Cannot find module 'D:/app/node_modules/@huggingface/transformers/dist/index.js' imported from D:/app/node_modules/shiori-plugin/index.mjs",
      ), { code: "ERR_MODULE_NOT_FOUND" });
    },
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.equal(result.code, DOWNLOAD_RUNTIME_LOAD_FAILED, "包存在但入口缺失：运行时加载失败");
  // P3-3（B 批收账）：入口缺失也是这个支——文案对两种形态都成立（「模块或入口文件」），
  // 且仍要点出 message 里真正缺失的入口。
  assert.ok(result.error.includes("缺少的模块或入口文件「D:/app/node_modules/@huggingface/transformers/dist/index.js」"),
    `文案指出 message 里真正缺失的入口，实际：${result.error}`);
  assert.equal(/缺少可选依赖 @huggingface\/transformers（未随插件包安装）/.test(result.error), false,
    "不许把责任指错包");
});

// P3-1（B 批收账）：普通对象抛错也读 .message——String(cause) 会丢成
// "[object Object]"，missingSpecifierOf 解析不出真名，主句退化为不点名的通用文案。
test("0.4 B 批 P3-1：loadTransformers 抛带 message 的普通对象 → RUNTIME 且主句点出真模块名", async () => {
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x",
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => {
      // 真实世界有库直接 throw 普通对象：带 message、无 code、非 Error 实例。
      throw { message: "Cannot find package 'onnxruntime-node' imported from D:/app/node_modules/@huggingface/transformers/dist/index.js" };
    },
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.equal(result.code, DOWNLOAD_RUNTIME_LOAD_FAILED, "普通对象抛错同样走类型安全取 message 的归因");
  assert.ok(result.error.includes("缺少的模块或入口文件「onnxruntime-node」"),
    `主句要点出 message 里真正的模块名，实际：${result.error}`);
  assert.ok(result.error.includes("onnxruntime-node' imported from"),
    "原始错误摘要同样带出（普通对象不经 Error 分支也不丢）");
});

test("0.4 收账·复审 P3-1：errorDigest——对象取 .message、无则 JSON.stringify；截断加省略号；cause 一并带上", async () => {
  const downloaderOf = (loadTransformers) => createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x",
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers,
  });
  const digestOf = (error) => {
    const marker = "（原始错误：";
    const start = error.indexOf(marker);
    return error.slice(start + marker.length, -1);
  };

  // a) 超长外层 + 独立 cause（P3-4）：分段截断——外层最多 120 字符（以「…」示意
  // 截断），cause 那句不再被整段截掉，仍然可见。
  const longMessage = "y".repeat(300);
  const r1 = await downloaderOf(async () => {
    throw Object.assign(new Error(longMessage), { cause: new Error("底层：EACCES 权限拒绝") });
  }).download({});
  const digest1 = digestOf(r1.error);
  assert.ok(digest1.startsWith("y".repeat(120) + "…"), "外层段截到 120 字符并以「…」示意截断");
  assert.ok(digest1.includes("；起因：底层：EACCES 权限拒绝"),
    `cause 那句仍可见（分段截断给它留了额度），实际：${digest1}`);

  // b) 短外层 + 短 cause：整句原样（「；起因：」连接），不被截断。
  const r2 = await downloaderOf(async () => {
    throw Object.assign(new Error("外层：运行时加载失败"), { cause: new Error("底层：EACCES 权限拒绝") });
  }).download({});
  assert.ok(r2.error.includes("外层：运行时加载失败"), "外层 message 可见");
  assert.ok(r2.error.includes("；起因：底层：EACCES 权限拒绝"), `cause 的 message 一并带出，实际：${r2.error}`);

  // c) 非 Error 对象抛出：无 .message → JSON.stringify 兜底，绝不丢成 [object Object]。
  const r3 = await downloaderOf(async () => {
    throw { code: "EACCES", errno: -13 }; // 真实世界有库直接 throw 普通对象
  }).download({});
  assert.ok(r3.error.includes('{"code":"EACCES","errno":-13}'), `JSON.stringify 兜底可见，实际：${r3.error}`);
  assert.ok(!r3.error.includes("[object Object]"), "不丢信息");
});

// C-fix C2：深 cause 链额度分配——旧实现外段固定 120、其余固定 40，三段即 211 超
// 200 兜底，四段链的第四段整段消失。新实现非末段按剩余额度让位（给后续每层预留
// 「分隔符 + 最小特征片段」的空间），每层都至少露出一个特征片段。
test("C-fix C2：errorDigest 四层 cause 链——按剩余额度分配，四层标记全部可见", async () => {
  const inner3 = new Error("丁标记" + "d".repeat(6));
  const inner2 = new Error("丙标记" + "2".repeat(60));
  inner2.cause = inner3;
  const inner1 = new Error("乙标记" + "1".repeat(60));
  inner1.cause = inner2;
  const outer = new Error("甲标记" + "0".repeat(130));
  outer.cause = inner1;
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x",
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => { throw outer; },
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.equal(result.code, DOWNLOAD_RUNTIME_LOAD_FAILED);
  const marker = "（原始错误：";
  const digest = result.error.slice(result.error.indexOf(marker) + marker.length, -1);
  assert.ok(digest.includes("甲标记"), `外层标记可见，实际：${digest}`);
  assert.ok(digest.includes("乙标记"), `第二层标记可见，实际：${digest}`);
  assert.ok(digest.includes("丙标记"), `第三层标记可见（让位后仍有特征片段），实际：${digest}`);
  assert.ok(digest.includes("丁标记"), `第四层标记可见（旧实现整段消失），实际：${digest}`);
  assert.equal(digest.split("；起因：").length, 4, "四层以「；起因：」串联");
  assert.ok(digest.length <= 201, `整串仍以 200 为界兜底，实际长度：${digest.length}`);
});

// C-fix C3：200 整串兜底的断言覆盖——三段长链各段都被基础额度截断后拼出 211，
// 兜底截到 200 +「…」= 201。删掉末尾兜底此用例必红（长度变 211）。
test("C-fix C3：errorDigest 三段长链触发 200 兜底——length===201 且以「…」结尾", async () => {
  const inner2 = new Error("内" + "w".repeat(80));
  const inner1 = new Error("中" + "z".repeat(80));
  inner1.cause = inner2;
  const outer = new Error("外" + "y".repeat(200));
  outer.cause = inner1;
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x",
    mirrors: ["https://hf-mirror.com/"],
    loadTransformers: async () => { throw outer; },
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  const marker = "（原始错误：";
  const digest = result.error.slice(result.error.indexOf(marker) + marker.length, -1);
  assert.equal(digest.length, 201, `兜底截断为 200 +「…」，实际长度：${digest.length}`);
  assert.ok(digest.endsWith("…"), "末尾以「…」示意截断");
  assert.ok(digest.startsWith("外" + "y".repeat(119) + "…"), "外层段仍按 120 截断");
  assert.ok(digest.includes("中"), "第二层可见");
  assert.ok(digest.includes("内"), "第三层可见");
});

// C-fix C5①：embed 推理阶段（extractor 调用）抛普通对象——文案与归因处同口径
// 优先取 .message，不丢成 "[object Object]"。经 loadTransformers 注入假运行时。
test("C-fix C5：embed 推理失败抛普通对象 → 文案取 .message 不丢成 [object Object]", async () => {
  const provider = createLocalEmbeddingProvider({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 4,
    loadTransformers: async () => ({
      env: {},
      pipeline: async () => async () => { throw { message: "推理爆炸：onnx 输出非向量" }; },
    }),
  });
  await assert.rejects(() => provider.embed("你好"), (e) =>
    e.code === SEMANTIC_UNAVAILABLE
    && e.message.includes("本地 embedding 推理失败")
    && e.message.includes("推理爆炸：onnx 输出非向量")
    && !e.message.includes("[object Object]"));
});

// C-fix C5②：下载逐源失败抛普通对象——attempts[].error 同口径取 .message。
test("C-fix C5：下载逐源失败抛普通对象 → attempts.error 取 .message 不丢成 [object Object]", async () => {
  const downloader = createLocalModelDownloader({
    model: "Xenova/bge-small-zh-v1.5",
    dims: 512,
    dtype: "q8",
    cacheDir: "/tmp/x",
    mirrors: ["https://hf-mirror.com/", "https://huggingface.co/"],
    loadTransformers: async () => ({
      env: {},
      pipeline: async () => { throw { message: "源内爆炸：磁盘满" }; },
    }),
  });
  const result = await downloader.download({});
  assert.equal(result.ok, "error");
  assert.deepEqual(result.attempts.map((a) => a.error), ["源内爆炸：磁盘满", "源内爆炸：磁盘满"],
    "两个源的 attempts.error 都取 .message（旧实现是 [object Object]）");
  assert.ok(result.error.includes("源内爆炸：磁盘满"), `汇总文案带出真实原因，实际：${result.error}`);
  assert.ok(!result.error.includes("[object Object]"), "不丢信息");
});
