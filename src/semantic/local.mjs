// Shiori F1b · 本地 embedding provider（transformers.js + ONNX，懒加载）。
//
// 边界（F1b 任务书 a 条）：
// - 本模块顶层绝不 import("@huggingface/transformers")：只在首次 embed() 时
//   动态 import（懒加载）。apply 路径 / 模块加载路径都不许碰模型运行时。
// - model 必须是完整仓库 id（org/name，如 "Xenova/bge-small-zh-v1.5"）。
//   短名（"bge-small-zh-v1.5"）不是合法 id，本模块不做前缀补齐——静默补齐
//   会把「配错了模型」伪装成「功能可用」。
// - 初始化失败（模块缺失 / 模型下载失败 / 原生库被杀软拦截等）抛
//   code="SEMANTIC_UNAVAILABLE" 的 coded error，带底层 cause 与中文可读
//   message；绝不静默降级冒充可用。是否回退纯字面由召回合并层决定。
// - embed(text) 返回 Float32Array(dims)：pipeline("feature-extraction")
//   + pooling mean + normalize，与 spike（见 spike 目录的结论.md）
//   实测配置一致（q8 短文本 p95 3.98ms，512 维）。

// 本模块不引入宿主依赖；fail 与 index.mjs 同风格（可序列化 .code + .details）。
function fail(code, message, details) {
  const error = new Error(message);
  error.name = "ShioriError";
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

/** 初始化 / 运行失败的统一错误码（调用方据此区分「没开启」与「开了但不可用」）。 */
export const SEMANTIC_UNAVAILABLE = "SEMANTIC_UNAVAILABLE";

// dtype 合法取值（与配置线 semantic.local.dtype 白名单一致）。
const DTYPES = new Set(["fp32", "fp16", "q8"]);

function unavailable(message, cause) {
  const error = new Error(message);
  error.name = "ShioriError";
  error.code = SEMANTIC_UNAVAILABLE;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/**
 * 创建本地 embedding provider（F1b）。
 *
 * @param {object} [options]
 * @param {string} options.model  完整仓库 id（org/name）；必填非空字符串。
 * @param {number} options.dims   输出向量维度；必填正整数（embed 产出长度必须等于它）。
 * @param {"fp32"|"fp16"|"q8"} [options.dtype="fp32"]  ONNX 精度；q8 23MB/最快，
 *   fp32 91MB/精度基线（spike §四.1）。默认 fp32 由配置线决定，本函数不再改写。
 * @param {string} [options.cacheDir=""]  模型缓存目录；空字符串 = 不设置 env.cacheDir
 *   （transformers.js 用它自己的默认缓存位置）。生产路径的空串承诺
 *   （「用 <stateRoot>/semantic/models」）由 controller 在构造 provider 前解析
 *   （见 controller.mjs semanticProviderConfig）：只有 controller 同时知道
 *   stateRoot 与配置，本模块不猜路径。测试/评测脚本可显式传 cacheDir。
 * @param {string} [options.mirror]  HuggingFace 镜像 host（如 "https://hf-mirror.com/"）；
 *   缺省不设置（直连 huggingface.co，国内环境一般不可达，配置线默认填镜像）。
 * @returns {{kind:"local", dims:number, embed(text:string):Promise<Float32Array>}}
 *   冻结的 provider 对象（契约形状与 F1a 一致，零额外字段）。
 * @throws {Error} code="INVALID_INPUT"：必填参数缺失或非法（创建期即可诊断）。
 *   注意：transformers 运行时的加载/初始化错误不在这里抛——那是首次 embed 的
 *   懒加载路径（构造 provider 不允许触发任何模型/网络/磁盘行为）。因此本工厂
 *   是同步函数：createEmbeddingProvider（index.mjs）的契约签名保持同步不变。
 */
export function createLocalEmbeddingProvider({
  model,
  dims,
  dtype = "fp32",
  cacheDir = "",
  mirror,
} = {}) {
  if (typeof model !== "string" || model.length === 0) {
    fail("INVALID_INPUT", "createLocalEmbeddingProvider: model must be a non-empty string (full repo id org/name)", {
      received: model === undefined ? "absent" : String(model),
    });
  }
  if (!Number.isInteger(dims) || dims <= 0) {
    fail("INVALID_INPUT", `createLocalEmbeddingProvider: dims must be a positive integer, got ${String(dims)}`, {
      dims,
    });
  }
  if (!DTYPES.has(dtype)) {
    fail("INVALID_INPUT", `createLocalEmbeddingProvider: dtype must be one of fp32|fp16|q8, got ${String(dtype)}`, {
      dtype,
    });
  }
  if (typeof cacheDir !== "string") {
    fail("INVALID_INPUT", `createLocalEmbeddingProvider: cacheDir must be a string ("" = caller decides), got ${String(cacheDir)}`, {});
  }
  if (mirror !== undefined && (typeof mirror !== "string" || mirror.length === 0)) {
    fail("INVALID_INPUT", `createLocalEmbeddingProvider: mirror must be a non-empty string or undefined, got ${String(mirror)}`, {});
  }

  // 单飞初始化：并发 embed 共享同一次 import + pipeline 构造。
  // 初始化失败后清空 promise，下一次 embed 可以重试（面板「可重试」语义）。
  let pipelinePromise = null;

  async function initExtractor() {
    let transformers;
    try {
      // 懒加载核心：首次 embed 才 import。模块缺失（依赖没装 / 被裁剪）在这里暴露。
      transformers = await import("@huggingface/transformers");
    } catch (cause) {
      throw unavailable(
        "本地 embedding 运行时（@huggingface/transformers）加载失败：插件依赖可能未完整安装。"
        + `请在插件目录重新 npm install 后重试。`,
        cause,
      );
    }
    try {
      const { pipeline, env } = transformers;
      // 与 spike bench 完全一致的 env 配置（见 spike 目录的 bench2.mjs）：
      // allowLocalModels=true + cacheDir + remoteHost（hf-mirror）。
      // 注意 env 是该模块的全局单例：本插件是进程内唯一的 transformers 消费方。
      env.allowLocalModels = true;
      if (typeof mirror === "string" && mirror.length > 0) env.remoteHost = mirror;
      if (cacheDir.length > 0) env.cacheDir = cacheDir;
      return await pipeline("feature-extraction", model, { dtype });
    } catch (cause) {
      throw unavailable(
        `本地 embedding 模型「${model}」初始化失败：可能是模型未下载且镜像不可达、`
        + "缓存目录不可写、或杀毒软件拦截了 ONNX 原生库。请检查网络/磁盘后重试，"
        + "或在面板「重建向量」处重试。",
        cause,
      );
    }
  }

  async function embed(text) {
    if (typeof text !== "string") {
      fail("INVALID_INPUT", `embed: text must be a string, got ${text === null ? "null" : typeof text}`, {});
    }
    if (pipelinePromise === null) pipelinePromise = initExtractor();
    let extractor;
    try {
      extractor = await pipelinePromise;
    } catch (error) {
      pipelinePromise = null; // 允许下次重试，不把失败永久固化进 provider
      throw error;
    }
    let output;
    try {
      // mean pooling + L2 归一化：与 cosineSimilarity（index.mjs）的输入约定一致，
      // 归一化后余弦即点积，但召回层仍走通用 cosineSimilarity 保持单一实现。
      output = await extractor(text, { pooling: "mean", normalize: true });
    } catch (cause) {
      throw unavailable(`本地 embedding 推理失败（model: ${model}）：${cause instanceof Error ? cause.message : String(cause)}`, cause);
    }
    const data = output?.data;
    const isVectorLike = data instanceof Float32Array || data instanceof Float64Array
      || (Array.isArray(data) && data.every((n) => typeof n === "number"));
    if (!isVectorLike || data.length !== dims) {
      throw unavailable(
        `本地 embedding 输出维度不匹配：期望 ${dims} 维，实际 ${isVectorLike ? data.length : typeof data}。`
        + `模型「${model}」与配置的 semantic.local.dims 不符，请修正 dims 或更换模型。`,
      );
    }
    // 拷贝成精确长度的 Float32Array：与上游张量内存解耦（张量可能被复用/释放）。
    const out = new Float32Array(dims);
    out.set(data);
    return out;
  }

  return Object.freeze({ kind: "local", dims, embed });
}
