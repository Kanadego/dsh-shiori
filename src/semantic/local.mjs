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
// S5：模型下载（progress_callback 驱动）也住本模块——它同样是 transformers.js
// 运行时之上的薄层，与 embed 共享同一套懒加载/环境配置口径；测试经
// loadTransformers 注入假模块，绝不真下载（F1b 铁律不变）。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

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
 *   （「用 <dataRoot>/models」——0.4-S5 起模型跟业务数据走，升级插件、重装包
 *   都不用重下）由 controller 在构造 provider 前解析
 *   （见 controller.mjs semanticProviderConfig）：只有 controller 同时知道
 *   dataRoot 与配置，本模块不猜路径。测试/评测脚本可显式传 cacheDir。
 * @param {string} [options.mirror]  HuggingFace 镜像 host（如 "https://hf-mirror.com/"）；
 *   缺省不设置（直连 huggingface.co，国内环境一般不可达，配置线默认填镜像）。
 * @param {() => Promise<object>} [options.loadTransformers]  运行时加载器；缺省
 *   动态 import("@huggingface/transformers")。仅测试注入假模块用（与
 *   createLocalModelDownloader 的同名参数同口径），默认行为逐字不变。
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
  loadTransformers = () => import("@huggingface/transformers"),
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
      transformers = await loadTransformers();
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
      // C-fix C5：与下方归因处（:479 一带）同一口径——普通对象抛错优先取
      // .message，不许丢成 "[object Object]"。
      throw unavailable(
        `本地 embedding 推理失败（model: ${model}）：${typeof cause?.message === "string" ? cause.message : String(cause)}`,
        cause,
      );
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

// ─────────────────────────────────────────────────────────
// S5 · 模型下载（面板「下载模型」按钮的服务端实现层）
// ─────────────────────────────────────────────────────────
//
// 边界：
// - 下载本身就是一次 pipeline("feature-extraction") 构造：transformers.js 的
//   progress_callback（五态 initiate/download/progress/done/ready）是唯一的
//   进度来源，本模块不自己写下载器、不发自己的 HTTP 请求。
// - 多源回退（镜像失败回落官方源）在本模块逐源尝试；env.remoteHost 是模块级
//   全局单例，每次尝试前整体重设（与 initExtractor 同口径）。
// - 取消是协作式的：progress_callback 里查 isCancelled() 并抛
//   code="DOWNLOAD_CANCELLED" 的哨兵错误，让 pipeline 构造 promise 以异常收场；
//   pipeline 落定后再查一次 isCancelled()（兜底 callback 抛错未被透传的运行时）。
// - 下载完成 ≠ 可用：必须通过「文件名齐全 + 真实推理维度」双校验才返回 done，
//   controller 侧据此才放行建索引（S5 验收 c 条）。
// - 进度聚合（S5 验收 e 条）：一条 pipeline 会拉多个文件（config/tokenizer/onnx），
//   事件按 file 去重、按 total 字节加权，避免进度条来回跳。

/** 取消哨兵错误码（controller 据此把任务态标为 cancelled 而不是 error）。 */
export const DOWNLOAD_CANCELLED = "DOWNLOAD_CANCELLED";

/**
 * 可选依赖缺失错误码（0.4-S5 复审 P1）：@huggingface/transformers 没装与
 * 「全部下载源不可达」是两类故障——前者与网络无关，混在逐源回退里被汇总成
 * 「全部下载源均失败」会把用户引去查网络。controller 据此把 installHint /
 * 前端报错卡片的归因文案改准（依赖缺失 → 先 npm install，不是查网络）。
 */
export const DOWNLOAD_DEPENDENCY_MISSING = "DOWNLOAD_DEPENDENCY_MISSING";

/**
 * 运行时加载失败错误码（0.4 收账遗留 1）：依赖已装、但 import 仍失败
 * （EACCES / 版本不兼容 / 包内部报错等）。它不是「缺依赖」——照旧把这类
 * 错误归成 DOWNLOAD_DEPENDENCY_MISSING 会引导用户去 npm i（装了也没用）。
 * 只有模块确实找不到（isModuleNotFoundError）才归缺依赖；其余加载失败归此码。
 */
export const DOWNLOAD_RUNTIME_LOAD_FAILED = "DOWNLOAD_RUNTIME_LOAD_FAILED";

/**
 * 从「Cannot find module/package」类 message 里取真正缺失的模块标识
 * （引号内外都兼容；解析不出返回 null）。用于把归因文案写到点子上：
 * 缺的是谁就写谁，不许一律写 @huggingface/transformers。
 */
function missingSpecifierOf(message) {
  if (typeof message !== "string") return null;
  const match = message.match(/Cannot find (?:module|package)\s+'?([^'\s]+)'?/i);
  return match === null ? null : match[1];
}

/** 错误是否为 Node 模块解析失败（ERR_MODULE_NOT_FOUND / MODULE_NOT_FOUND / 同义 message）。 */
function isModuleNotFoundError(error) {
  if (error === null || typeof error !== "object") return false;
  if (error.code === "ERR_MODULE_NOT_FOUND" || error.code === "MODULE_NOT_FOUND") return true;
  const message = typeof error.message === "string" ? error.message : "";
  return message.includes("Cannot find module") || message.includes("Cannot find package");
}

/**
 * 判断加载错误是不是「@huggingface/transformers 本身没装」（缺可选依赖）：
 * 模块解析失败，且 message 指名的缺失模块就是它自己。包已装但内部缺模块、
 * 包存在但入口缺失——缺失的不是它自己——不归此类（复审 P2-1）：那两种形态
 * 归运行时加载失败，文案指出 message 里真正的模块名，不许把责任指错包
 * （用户照「npm i @huggingface/transformers」去装也修不好）。
 * code 命中但 message 解析不出模块名时保守按「包本身缺失」归因——指不出
 * 真凶时宁可走通用缺依赖文案，不冒充能指出真凶。
 */
function isTransformersPackageMissing(error) {
  if (!isModuleNotFoundError(error)) return false;
  const specifier = missingSpecifierOf(typeof error.message === "string" ? error.message : "");
  if (specifier === null) return true;
  return specifier === "@huggingface/transformers"
    || specifier.startsWith("@huggingface/transformers/");
}

/**
 * 原始错误的单行可读摘要（0.4 收账遗留 1 + 复审 P3-1）：对象抛出优先取
 * .message，没有则 JSON.stringify 兜底（绝不丢成 "[object Object]"）；
 * error.cause 链的 message 一并带上（有界防环）；message 本不含堆栈帧，
 * 不做帧过滤；截断到约 200 字符并以「…」结尾示意截断。
 */
function errorDigest(error) {
  const describe = (e) => {
    if (e === null || typeof e !== "object") return String(e);
    if (typeof e.message === "string" && e.message.length > 0) return e.message;
    try {
      const json = JSON.stringify(e);
      return json === undefined ? Object.prototype.toString.call(e) : json;
    } catch {
      return Object.prototype.toString.call(e); // 环形引用等 stringify 失败：至少给出类型
    }
  };
  const parts = [];
  const seen = new Set();
  for (let cur = error; cur !== undefined && cur !== null && parts.length < 5; cur = cur.cause) {
    if (seen.has(cur)) break; // cause 自引用成环：见好就收
    seen.add(cur);
    parts.push(describe(cur));
  }
  // P3-4（B 批收账）：分段截断——先 join 整串再整体截 200，外层 message 很长时
  // cause 段被整段截掉，「带上 cause」实际失效。每段先压成单行再各自限量。
  // C-fix C2：额度按剩余空间分配——非末段额度 = min(基础额度, 200 − 已用 −
  // 后续每层的预留（分隔符 4 + 最小特征片段 8）)，深链的中间段给深层让位，
  // 保证 4 层以上 cause 链每层都至少露出约 7 字符的特征片段，不再整段消失。
  // 末段不做剩余额度收缩（保留基础额度），超出 200 的尾量交给下面的整串
  // 兜底截断——兜底因此始终活跃（C3 用例钉住它）。1～2 层链与旧行为逐字一致：
  // 外段 200−12 ≥ 120 恒取基础额度 120。
  const LIMIT = 200;
  const SEP = "；起因：";
  const RESERVE_PER_LAYER = SEP.length + 8;
  const cap = (text, limit) => (text.length > limit ? text.slice(0, limit) + "…" : text);
  let used = 0;
  const singleLine = parts
    .map((text, index) => {
      const flat = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .join("；");
      const base = index === 0 ? 120 : 40;
      const sepLen = index > 0 ? SEP.length : 0;
      const isLast = index === parts.length - 1;
      const budget = isLast
        ? base
        : Math.max(1, Math.min(base, LIMIT - used - sepLen - RESERVE_PER_LAYER * (parts.length - 1 - index)));
      const segment = cap(flat, budget);
      used += sepLen + segment.length;
      return segment;
    })
    .join(SEP);
  return singleLine.length > LIMIT ? singleLine.slice(0, LIMIT) + "…" : singleLine;
}

/** dtype → ONNX 权重文件名（transformers.js 按 dtype 选择对应量化文件）。 */
const ONNX_FILE_BY_DTYPE = Object.freeze({
  fp32: "onnx/model.onnx",
  fp16: "onnx/model_fp16.onnx",
  q8: "onnx/model_quantized.onnx",
});

/**
 * 一次完整安装必须落盘的文件清单（相对 <cacheDir>/<org>/<model>/ 的路径）。
 * config.json + tokenizer.json 是 feature-extraction pipeline 的硬依赖；
 * ONNX 权重按 dtype 选定。
 */
export function expectedModelFiles(dtype) {
  if (!Object.hasOwn(ONNX_FILE_BY_DTYPE, dtype)) {
    fail("INVALID_INPUT", `expectedModelFiles: dtype must be one of fp32|fp16|q8, got ${String(dtype)}`, {
      dtype,
    });
  }
  return ["config.json", "tokenizer.json", ONNX_FILE_BY_DTYPE[dtype]];
}

/** 模型在本机缓存里的目录：<cacheDir>/<org>/<model>/（transformers.js 的落盘布局）。 */
export function localModelDir(cacheDir, model) {
  if (typeof cacheDir !== "string" || cacheDir.length === 0) {
    fail("INVALID_INPUT", `localModelDir: cacheDir must be a non-empty string, got ${String(cacheDir)}`, {});
  }
  // P0#3（0.4 审查报告）防御层：config 已拦一层（手动目录必须绝对路径 + 拒 ..），
  // 这里在目录解析处同步再拒一次——挡「绕过 config 直接调本模块」（controller 直构
  // / 评测脚本 / 测试）把相对路径或 ../ 逃逸写法喂进 transformers.js 落盘布局。
  if (!isAbsolute(cacheDir)) {
    fail("INVALID_INPUT", `localModelDir: cacheDir must be an absolute path, got "${cacheDir}"`, {});
  }
  if (cacheDir.split(/[\\/]+/).includes("..")) {
    fail("INVALID_INPUT", `localModelDir: cacheDir must not contain ".." path segments, got "${cacheDir}"`, {});
  }
  if (typeof model !== "string" || model.split("/").length !== 2 || model.split("/").some((p) => p.length === 0)) {
    fail("INVALID_INPUT", `localModelDir: model must be a full repo id (org/name), got ${String(model)}`, { model });
  }
  return join(cacheDir, ...model.split("/"));
}

/** expectedModelFiles 里的相对路径展开成绝对路径。 */
function absoluteModelFile(cacheDir, model, relativeFile) {
  return join(localModelDir(cacheDir, model), ...relativeFile.split("/"));
}

/**
 * 模型是否已完整安装（全部期望文件存在）。只做存在性检查，不校验内容——
 * 内容校验（维度）在下载收尾的真实推理里做，这条轻检查供getStatus高频读取。
 * 任何 fs 异常（权限等）按「未安装」处理，绝不抛——诊断路径不许炸。
 */
export function isLocalModelInstalled({ cacheDir, model, dtype }) {
  try {
    for (const file of expectedModelFiles(dtype)) {
      if (!existsSync(absoluteModelFile(cacheDir, model, file))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建进度聚合器：按 file 去重（每文件只保留最新 loaded/total）、按 total 字节
 * 加权求整体百分比。push() 吃 transformers.js 的 progress_callback 事件
 * （{status, file, loaded, total}），snapshot() 返回整体快照。
 * 未知 total 的文件只累计已下载字节，不参与百分比分母（分母失真比不显示更糟）。
 */
export function createModelProgressAggregator() {
  const files = new Map(); // file → { loaded, total, done }
  function push(event) {
    if (event === null || typeof event !== "object") return;
    const file = event.file;
    if (typeof file !== "string" || file.length === 0) return; // ready 等无文件事件
    let entry = files.get(file);
    if (entry === undefined) {
      entry = { loaded: 0, total: null, done: false };
      files.set(file, entry);
    }
    const status = event.status;
    if (status === "progress") {
      if (typeof event.loaded === "number" && Number.isFinite(event.loaded) && event.loaded >= 0) {
        entry.loaded = event.loaded;
      }
      if (typeof event.total === "number" && Number.isFinite(event.total) && event.total > 0) {
        entry.total = event.total;
      }
    } else if (status === "done") {
      entry.done = true;
      if (entry.total !== null) entry.loaded = entry.total;
    }
    // initiate / download / ready：只登记文件，不动进度。
  }
  function snapshot() {
    let loadedBytes = 0;
    let loadedKnown = 0;
    let totalBytes = 0;
    let filesDone = 0;
    for (const entry of files.values()) {
      loadedBytes += entry.loaded;
      if (entry.total !== null) {
        loadedKnown += entry.loaded;
        totalBytes += entry.total;
      }
      if (entry.done) filesDone += 1;
    }
    const percent = totalBytes > 0 ? Math.min(100, Math.round((loadedKnown / totalBytes) * 100)) : null;
    return { percent, loadedBytes, totalBytes, filesDone, filesTotal: files.size };
  }
  return { push, snapshot };
}

/**
 * 创建本地模型下载器（S5）。download() 单次调用内逐源尝试：每个源重设
 * env.remoteHost → pipeline 构造（progress_callback 驱动进度与协作取消）→
 * 文件名齐全校验 → 真实推理维度校验；某源失败记入 attempts 并继续下一源，
 * 全部失败返回 {ok:"error"}（controller 负责把可读报错卡片数据写进诊断）。
 *
 * @param {object} options
 * @param {string} options.model  完整仓库 id（org/name）。
 * @param {number} options.dims   期望输出维度（下载后真实推理校验）。
 * @param {"fp32"|"fp16"|"q8"} options.dtype  ONNX 精度（决定下载哪个权重文件）。
 * @param {string} options.cacheDir  非空缓存根目录（transformers.js env.cacheDir）。
 * @param {string[]} options.mirrors  源列表（按顺序尝试；如 [镜像, 官方源]）。
 * @param {() => Promise<object>} [options.loadTransformers]  运行时加载器；缺省
 *   动态 import("@huggingface/transformers")。测试注入假模块，绝不真下载。
 * @returns {{download(options: {
 *   onProgress?: (snapshot) => void,
 *   onPhase?: (phase: "downloading"|"verifying") => void,
 *   onSource?: (source: string) => void,
 *   isCancelled?: () => boolean,
 * }): Promise<{ok:"done"|"cancelled"|"error", source?, attempts?, error?}>}}
 */
export function createLocalModelDownloader({
  model,
  dims,
  dtype,
  cacheDir,
  mirrors,
  loadTransformers,
} = {}) {
  if (typeof model !== "string" || model.split("/").length !== 2 || model.split("/").some((p) => p.length === 0)) {
    fail("INVALID_INPUT", `createLocalModelDownloader: model must be a full repo id (org/name), got ${String(model)}`, {
      model,
    });
  }
  if (!Number.isInteger(dims) || dims <= 0) {
    fail("INVALID_INPUT", `createLocalModelDownloader: dims must be a positive integer, got ${String(dims)}`, { dims });
  }
  if (!DTYPES.has(dtype)) {
    fail("INVALID_INPUT", `createLocalModelDownloader: dtype must be one of fp32|fp16|q8, got ${String(dtype)}`, { dtype });
  }
  if (typeof cacheDir !== "string" || cacheDir.length === 0) {
    fail("INVALID_INPUT", `createLocalModelDownloader: cacheDir must be a non-empty string, got ${String(cacheDir)}`, {});
  }
  if (!Array.isArray(mirrors) || mirrors.length === 0 || mirrors.some((m) => typeof m !== "string" || m.length === 0)) {
    fail("INVALID_INPUT", "createLocalModelDownloader: mirrors must be a non-empty array of non-empty strings", {});
  }

  function cancelledError() {
    const error = new Error("模型下载已被用户取消。");
    error.name = "ShioriError";
    error.code = DOWNLOAD_CANCELLED;
    return error;
  }
  const isCancelError = (error) => error !== null && typeof error === "object" && error.code === DOWNLOAD_CANCELLED;

  async function download({ onProgress, onPhase, onSource, isCancelled } = {}) {
    const cancelled = () => typeof isCancelled === "function" && isCancelled() === true;
    const attempts = [];
    if (cancelled()) return { ok: "cancelled", attempts };
    // 运行时加载单独做一次、放在逐源循环之外（0.4-S5 复审 P1）：模块缺失
    // （ERR_MODULE_NOT_FOUND，可选依赖没装）与「网络不可达」是两类故障——
    // 放进逐源 try 里会被每个源各记一笔、最终汇总成「全部下载源均失败」，
    // 把用户引去查网络。这里一次定归因：缺失即返回依赖缺失错误码，不进源循环。
    let transformers;
    try {
      transformers = typeof loadTransformers === "function"
        ? await loadTransformers()
        : await import("@huggingface/transformers");
    } catch (cause) {
      // 0.4 收账遗留 1 + 复审 P2-1：加载失败分三类归因——
      // ① 包本身没装（缺失的模块就是 @huggingface/transformers 自己）：缺依赖，
      //    引导 npm i；
      // ② 包已装但内部缺模块 / 入口缺失（Cannot find 的不是它自己）：运行时
      //    加载失败，文案指出 message 里真正的模块名——npm i @huggingface/transformers
      //    修不好，把责任指错包只会误导用户；
      // ③ 其余（EACCES / 版本不兼容 / 包内部报错等）：运行时加载失败。
      // 三类都把原始错误摘要带出去（见 errorDigest），不许吞成一句模板话。
      if (isTransformersPackageMissing(cause)) {
        return {
          ok: "error",
          code: DOWNLOAD_DEPENDENCY_MISSING,
          attempts,
          error: "缺少可选依赖 @huggingface/transformers（未随插件包安装）。这不是网络问题，"
            + "无需检查下载源——请在插件目录执行 npm i @huggingface/transformers 后重试。"
            + `（原始错误：${errorDigest(cause)}）`,
        };
      }
      // P3-1（B 批收账）：普通对象抛错也读 .message（真实世界有库直接 throw
      // 普通对象）——String(cause) 会丢成 "[object Object]"，missingSpecifierOf
      // 解析不出真名，主句退化为不点名的通用文案。
      const missing = missingSpecifierOf(typeof cause?.message === "string" ? cause.message : String(cause));
      if (missing !== null) {
        return {
          ok: "error",
          code: DOWNLOAD_RUNTIME_LOAD_FAILED,
          attempts,
          error: `可选依赖 @huggingface/transformers 已安装，但它缺少的模块或入口文件「${missing}」加载失败`
            + "（内部依赖缺失或入口缺失；不是网络问题）。npm i @huggingface/transformers 不一定解决——"
            + "请按错误信息修复该模块（如重装插件依赖）后重试。"
            + `（原始错误：${errorDigest(cause)}）`,
        };
      }
      return {
        ok: "error",
        code: DOWNLOAD_RUNTIME_LOAD_FAILED,
        attempts,
        error: "可选依赖 @huggingface/transformers 已安装，但运行时加载失败（不是网络问题，也不是缺依赖）。"
          + "请先查看错误信息，修复依赖环境（文件权限、版本兼容等）后重试。"
          + `（原始错误：${errorDigest(cause)}）`,
      };
    }
    for (const mirror of mirrors) {
      if (cancelled()) return { ok: "cancelled", attempts };
      onSource?.(mirror);
      onPhase?.("downloading");
      let extractor = null;
      try {
        const { pipeline, env } = transformers;
        // env 是该模块的全局单例：每次尝试整体重设（与 initExtractor 同口径），
        // 失败回落官方源时 remoteHost 被换成官方地址。
        env.allowLocalModels = true;
        env.cacheDir = cacheDir;
        env.remoteHost = mirror;
        const aggregator = createModelProgressAggregator();
        const progress_callback = (event) => {
          aggregator.push(event);
          onProgress?.(aggregator.snapshot());
          if (cancelled()) throw cancelledError(); // 协作取消：让 pipeline promise 异常收场
        };
        extractor = await pipeline("feature-extraction", model, { dtype, progress_callback });
        // 兜底：progress_callback 抛哨兵未被运行时透传时，落定后再查一次。
        if (cancelled()) return { ok: "cancelled", attempts };
        // 校验一：文件名齐全（半截下载在这里拦下，不许冒充安装完成）。
        const modelDir = localModelDir(cacheDir, model);
        const missing = expectedModelFiles(dtype)
          .filter((file) => !existsSync(absoluteModelFile(cacheDir, model, file)));
        if (missing.length > 0) {
          throw new Error(
            `模型文件缺失：${missing.join("、")}（目录 ${modelDir}）。可能是下载被中断，请重新下载。`,
          );
        }
        // 校验二：真实推理维度（通过才允许建索引；同时把 ONNX 原生库可用性一起验掉）。
        onPhase?.("verifying");
        const output = await extractor("shiori 下载校验", { pooling: "mean", normalize: true });
        const actual = output?.data?.length;
        if (actual !== dims) {
          throw new Error(
            `模型输出维度校验失败：期望 ${dims} 维，实际 ${actual === undefined ? "未知" : actual}。`
            + `模型「${model}」与配置的 semantic.local.dims 不符，请修正 dims 或更换模型。`,
          );
        }
        return { ok: "done", source: mirror, attempts };
      } catch (error) {
        if (isCancelError(error) || cancelled()) return { ok: "cancelled", attempts };
        attempts.push({
          source: mirror,
          // C-fix C5：普通对象抛错同样优先取 .message（与 :479 同口径），
          // String(error) 会丢成 "[object Object]"。
          error: typeof error?.message === "string" ? error.message : String(error),
        });
        // 换下一源重试；全部失败在循环外统一汇报。
      }
    }
    const detail = attempts.map((a) => `源 ${a.source}：${a.error}`).join("；");
    return {
      ok: "error",
      attempts,
      error: `全部下载源均失败（共 ${mirrors.length} 个）。${detail}`,
    };
  }

  return Object.freeze({ download });
}

// ─────────────────────────────────────────────────────────
// P2#12a · 0.3.x 旧模型缓存一次性迁移
// ─────────────────────────────────────────────────────────
//
// 背景：0.3.x 时期 semantic.local.cacheDir 留空时，createLocalEmbeddingProvider
// 不设置 env.cacheDir，模型交给 transformers.js 的默认缓存位置。经查证
// （node_modules/@huggingface/transformers@3.8.1 src/env.js）：
//   DEFAULT_CACHE_DIR = path.join(dirname(dirname(fileURLToPath(import.meta.url))), ".cache")
// env.js 位于 <包根>/src/ 下，上两级即包根——旧缓存永远在「0.3.x 实际安装的
// transformers 包根」下的 .cache。
//
// 包根在哪（R1，attempt-1 评审打回项）：npm 安装普遍做依赖提升（hoisting），包
// 可能挂在插件目录自己的 node_modules（嵌套布局），也可能提升到任意上层
// node_modules（提升布局）——只拼 <pluginDir>/node_modules/... 会对多数升级
// 用户静默 no-op。解析顺序：
//   ① createRequire（以 pluginDir 为基准）resolve 真实包入口 → 向上定位包根
//     （与运行时 import 同一解析算法，穿透 junction/symlink 得到真实安装位置）；
//   ② 解析失败（未安装 / exports 变动 / 解析 API 缺失）→ 从 pluginDir 逐级上溯
//     探测 <dir>/node_modules/@huggingface/transformers/.cache（覆盖嵌套与各级
//     提升布局）。R2（交叉审查补漏）：每个回退候选须过两道关才算命中——
//     归属校验（包目录的 package.json 写着别人的名字 → 跳过：别人家的 .cache，
//     搬走等于劫持别的包的数据）与「非空」（.cache 存在但 readdir 零条目 →
//     不是命中，继续扫下一个候选，不让空缓存抢先返回造成漏搬）；
//   ③ 全部落空 → null（迁移层按 absent 零动作处理）。
//
// 边界：
// - 本模块顶层 / 本函数绝不 import transformers 运行时（apply 路径铁律）：
//   旧落点由 legacyPluginModelCacheDir 纯路径拼装得出，不做任何模块解析。
// - 迁移策略选「搬」（同卷 rename；跨卷 EXDEV 回退拷贝+删源），不选软链：
//   Windows 符号链接需要特权，junction 不可跨卷且会让 dataRoot 备份/焚毁
//   （purgeDataRoot）语义变复杂——搬运后 dataRoot 自包含，语义最干净。
// - 幂等口径：marker 存在 → skipped；旧落点缺失 → absent（零动作，不写
//   marker——此后每次启动只多一次 readdir 级探测）；旧落点为空 → empty（零
//   动作）；全部条目处理成功（含与目标重名被跳过的）→ 写 marker 只做一次；
//   任一 IO 失败 → failed，不写 marker，下次启动自动重试。
// - 不覆盖目标已有条目（重名跳过并记录）：迁移永不破坏新缓存里的现成模型。
// - 失败只返回结构化结果，由调用方（index.mjs apply）告警，绝不阻塞启动。

/** 迁移完成标记文件名（落在目标缓存目录内；仅实际处理过旧落点才写）。 */
export const LEGACY_MODEL_MIGRATION_MARKER = ".shiori-legacy-0.3-models-migrated.json";

/** 从包入口文件向上定位包根（<dir>/package.json 的 name 匹配为止；有界防逃逸）。 */
function packageRootOfEntry(entryPath) {
  let dir = dirname(entryPath);
  for (let hops = 0; hops < 8 && dirname(dir) !== dir; hops += 1) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (manifest?.name === "@huggingface/transformers") return dir;
    } catch {
      // 该层无 manifest / 解析失败 → 继续上溯（有界，到文件系统根自动停）。
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * 生产默认的包根解析（R1）：createRequire 以 pluginDir 为基准 resolve
 * @huggingface/transformers 真实包入口 → 向上定位包根。与运行时 import 走同一
 * 份 Node 解析算法（穿透 junction/symlink），解析到哪旧缓存就在哪的包根下。
 * 失败（未安装 / exports 变动 / 解析异常）返回 null，调用方走候选回退。
 */
function resolveTransformersPackageRootDefault(pluginDir) {
  try {
    const entry = createRequire(join(pluginDir, "package.json")).resolve("@huggingface/transformers");
    // createRequire.resolve 常规返回绝对路径；个别运行时可能给 file:// URL，归一化。
    const entryPath = typeof entry === "string" && entry.startsWith("file:") ? fileURLToPath(entry) : entry;
    return packageRootOfEntry(entryPath);
  } catch {
    return null;
  }
}

/**
 * R2：旧缓存候选探测分类（交叉审查补漏）。
 * - "populated"：目录可读且有条目 → 可命中；
 * - "empty"：存在但 readdir 零条目 → 不算命中（没东西可搬），继续扫下一个
 *   候选，不让空缓存抢先返回造成漏搬；
 * - "absent"：不存在 / 不是目录（ENOENT/ENOTDIR）→ 继续扫下一个候选；
 * - "unreadable"：其它 IO 失败（EACCES 等）→ 按「存在」处理返回候选，让迁移
 *   层的 failed + 错误摘要如实上报——探测层不许把故障静默降级成 absent
 *   （与本模块「不把故障伪装成正常」的一贯口径一致）。
 */
function probeLegacyCacheKind(cacheDir) {
  let entries;
  try {
    entries = readdirSync(cacheDir, { withFileTypes: true });
  } catch (cause) {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") return "absent";
    return "unreadable";
  }
  return entries.length === 0 ? "empty" : "populated";
}

/**
 * R2：回退候选的归属判定——候选 .cache 的父级目录（即包根）里的 package.json
 * 指向谁。三种结论：
 * - "foreign"：manifest 存在且 name 明确写着别的包名 → 是「别人家的 .cache」，
 *   跳过继续扫（评审拍板：只有证据确凿才拒）；
 * - "match"：manifest 的 name 就是 @huggingface/transformers → 归属明确；
 * - "no-evidence"：manifest 缺失 / 不可读 / 解析失败 / 无合法 name → 没有任何
 *   证据说它属于别的包，放行——半卸载留下的孤儿旧缓存维持既有「目录形状
 *   命中」口径（评审拍板选 A；既有嵌套/提升布局用例的夹具无 manifest，
 *   全绿依赖此口径），避免把孤儿旧缓存漏搬。
 * 归属判定只对回退候选生效：createRequire 解析命中的首候选，解析本身就是
 * 归属证明，不经此检查（R1 口径：解析命中仍最优先）。
 */
function packageOwnershipOf(packageDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch {
    return "no-evidence";
  }
  const name = manifest?.name;
  if (typeof name !== "string" || name.length === 0) return "no-evidence";
  return name === "@huggingface/transformers" ? "match" : "foreign";
}

/**
 * 解析 0.3.x 旧模型缓存的真实落点（R1：兼容 npm 依赖提升布局）。
 *
 * 候选顺序：① 注入点解析出的包根下的 .cache（生产 = createRequire 真实解析，
 * 穿透 junction 得到 0.3.x 实际安装位置；解析即归属证明，不经回退候选的
 * 归属判定；解析命中但 .cache 为空同样不算命中——空缓存口径对所有候选生效，
 * 有内容的解析候选仍最优先）；② 从 pluginDir 逐级上溯（有界 8 层）探测
 * <dir>/node_modules/@huggingface/transformers/.cache——嵌套布局（level 0）
 * 与 reviewer 所列 pluginDir/../node_modules、pluginDir/../../node_modules 等
 * 各级提升位置的超集，但每个回退候选都要过两道关（R2，交叉审查补漏）：
 * 归属判定（包目录的 package.json 明确写着别的包名 → 跳过，绝不动别人家的
 * .cache）与「非空」（.cache 存在但 readdir 零条目 → 不是命中，继续扫下一个
 * 候选，不让空缓存抢先返回造成漏搬）。命中第一个过两道关的候选；全部落空
 * 返回 null（migrateLegacyModelCache 按 absent 零动作处理，绝不猜一个不存在
 * 的路径）。
 *
 * R2 评审补充：跳过/命中的原因不许吞掉——probeTrace 传数组时按扫描顺序逐
 * 候选追加探测轨迹 {candidate, source, outcome, reason}，reason 取值
 * wrong-package（manifest 明确写着别的包名）/ empty（存在但零条目）/ absent
 * （不存在/不是目录）/ missing-manifest-allowed（无 manifest 证据放行且有货）/
 * populated（有货且归属明确）/ unreadable（读不了但存在，迁移层如实报 failed）；
 * 命中即停，其后的候选不产生轨迹。缺省不收集，零行为变化。
 *
 * @param {string} pluginDir 插件目录（index.mjs 所在目录；生产 = 装插件的那个目录）。
 * @param {{resolvePackageRoot?: (pluginDir: string) => ?string,
 *     probeTrace?: Array<{candidate: string, source: "resolved"|"fallback",
 *       outcome: "hit"|"skip", reason: string}>}} [options]
 *   包根解析注入点（缺省 createRequire 实现；测试注入桩替换）与探测轨迹收集
 *   数组（可选；传入时逐候选追加，供测试断言「拒绝确实发生过」）。
 * @returns {?string} 真实存在且可迁移的旧缓存目录；不存在 → null。
 * @throws {Error} code="INVALID_INPUT"：pluginDir 缺失或非非空字符串。
 */
export function legacyPluginModelCacheDir(pluginDir, { resolvePackageRoot = resolveTransformersPackageRootDefault, probeTrace } = {}) {
  if (typeof pluginDir !== "string" || pluginDir.length === 0) {
    fail("INVALID_INPUT", `legacyPluginModelCacheDir: pluginDir must be a non-empty string, got ${String(pluginDir)}`, {
      received: pluginDir === undefined ? "absent" : String(pluginDir),
    });
  }
  if (resolvePackageRoot !== undefined && typeof resolvePackageRoot !== "function") {
    fail("INVALID_INPUT", "legacyPluginModelCacheDir: resolvePackageRoot must be a function when provided", {});
  }
  if (probeTrace !== undefined && !Array.isArray(probeTrace)) {
    fail("INVALID_INPUT", "legacyPluginModelCacheDir: probeTrace must be an array when provided", {});
  }
  const trace = (event) => {
    if (probeTrace !== undefined) probeTrace.push(event);
  };
  const candidates = [];
  const resolvedRoot = resolvePackageRoot(pluginDir);
  if (typeof resolvedRoot === "string" && resolvedRoot.length > 0) {
    candidates.push({ path: join(resolvedRoot, ".cache"), ownershipProven: true });
  }
  // 回退候选：从插件目录逐级上溯探测（嵌套布局与各级依赖提升位置的超集）。
  let dir = pluginDir;
  for (let hops = 0; hops < 8 && dirname(dir) !== dir; hops += 1) {
    candidates.push({ path: join(dir, "node_modules", "@huggingface", "transformers", ".cache"), ownershipProven: false });
    dir = dirname(dir);
  }
  for (const candidate of candidates) {
    const source = candidate.ownershipProven ? "resolved" : "fallback";
    try {
      // R2：回退候选先过归属判定——package.json 明确写着别的包名 → 跳过继续扫
      //（别人家的 .cache，搬走等于劫持别的包的数据）。解析命中的首候选不经此
      // 检查（解析即归属证明，仍最优先）。
      const ownership = candidate.ownershipProven ? "resolved" : packageOwnershipOf(dirname(candidate.path));
      if (ownership === "foreign") {
        trace({ candidate: candidate.path, source, outcome: "skip", reason: "wrong-package" });
        continue;
      }
      const kind = existsSync(candidate.path) ? probeLegacyCacheKind(candidate.path) : "absent";
      // R2：absent（不存在/不是目录）与 empty（存在但零条目）都不是命中，
      // 继续扫下一个候选，不让空缓存抢先返回造成漏搬。
      if (kind === "absent" || kind === "empty") {
        trace({ candidate: candidate.path, source, outcome: "skip", reason: kind });
        continue;
      }
      // populated（有货）与 unreadable（读不了）：命中并返回——迁移层会把
      // 读不了的落点按 failed + 错误摘要如实上报，探测层不静默吞故障。
      // 命中原因如实标注：无 manifest 证据放行的孤儿缓存标 missing-manifest-
      // allowed（评审拍板口径 A），归属明确的标 populated，读不了的标 unreadable。
      const hitReason = kind === "unreadable"
        ? "unreadable"
        : (ownership === "no-evidence" ? "missing-manifest-allowed" : "populated");
      trace({ candidate: candidate.path, source, outcome: "hit", reason: hitReason });
      return candidate.path;
    } catch {
      // 单候选探测异常（防御保留旧口径）→ 换下一个候选，绝不因单点探测
      // 异常放弃整条链。
    }
  }
  return null;
}

/** 迁移入参的路径校验（与 localModelDir 同口径：非空、绝对路径、拒 .. 逃逸）。 */
function requireMigratablePath(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_INPUT", `migrateLegacyModelCache: ${field} must be a non-empty string, got ${String(value)}`, {});
  }
  if (!isAbsolute(value)) {
    fail("INVALID_INPUT", `migrateLegacyModelCache: ${field} must be an absolute path, got "${value}"`, {});
  }
  if (value.split(/[\\/]+/).includes("..")) {
    fail("INVALID_INPUT", `migrateLegacyModelCache: ${field} must not contain ".." path segments, got "${value}"`, {});
  }
}

/**
 * 把 0.3.x 默认缓存里的模型一次性搬到新缓存根（P2#12a）。
 *
 * 状态机：skipped（marker 已存在 / 新旧同目录）→ absent（旧落点不存在，零动作
 * 不写 marker）→ empty（旧落点存在但为空，零动作不写 marker）→ migrated（条目
 * 全部处理成功，写 marker 只做一次）→ failed（任一 IO 失败，不写 marker，
 * 下次启动重试；已搬成功的条目保留在目标侧）。
 *
 * @param {object} options
 * @param {string} options.targetCacheDir  新缓存根（controller 口径：显式
 *   semantic.local.cacheDir 优先，否则 <dataRoot>/models）。只在这里 mkdir。
 * @param {?string} options.legacyCacheDir  旧缓存根（legacyPluginModelCacheDir 的
 *   产物；null = 解析不到旧包位置 → absent 零动作，R1 契约）。
 * @param {string} [options.markerPath]    标记文件路径；缺省 <targetCacheDir>/.shiori-legacy-0.3-models-migrated.json。
 * @param {() => string} [options.nowIso]  时间戳来源（marker 内容用）。
 * @param {(from: string, to: string) => void} [options.renameImpl]  rename 注入点
 *   （缺省 node:fs renameSync）；测试注入 EXDEV 桩验证跨卷回退，生产零行为变化。
 * @returns {Promise<{status: "skipped"|"absent"|"empty"|"migrated"|"failed",
 *     markerPath: string, moved?: string[], skippedEntries?: string[], reason?: string, error?: string}>}
 *   结构化结果；failed 时 error 为有界错误摘要（errorDigest 同款）。本函数自身
 *   不抛（入参校验的 INVALID_INPUT 除外），调用方按 status 告警即可。
 */
export async function migrateLegacyModelCache({
  targetCacheDir,
  legacyCacheDir,
  markerPath,
  nowIso = () => new Date().toISOString(),
  renameImpl = renameSync,
} = {}) {
  requireMigratablePath(targetCacheDir, "targetCacheDir");
  const marker = markerPath ?? join(targetCacheDir, LEGACY_MODEL_MIGRATION_MARKER);
  if (markerPath !== undefined) requireMigratablePath(markerPath, "markerPath");
  if (renameImpl !== undefined && typeof renameImpl !== "function") {
    fail("INVALID_INPUT", "migrateLegacyModelCache: renameImpl must be a function when provided", {});
  }
  // R1：调用方解析不到旧包位置（包未安装 / 布局变更）→ 无旧模型，absent 零动作。
  if (legacyCacheDir === null || legacyCacheDir === undefined) {
    return { status: "absent", markerPath: marker };
  }
  requireMigratablePath(legacyCacheDir, "legacyCacheDir");
  const failedResult = (cause, extra = {}) => ({
    status: "failed",
    markerPath: marker,
    error: errorDigest(cause instanceof Error ? cause : new Error(String(cause))),
    ...extra,
  });

  // 1) marker 已存在：只做一次的承诺兑现，直接跳过。
  try {
    if (existsSync(marker)) return { status: "skipped", markerPath, reason: "marker-exists" };
  } catch (cause) {
    return failedResult(cause);
  }
  // 2) 新旧同目录（配置自相矛盾的退化场景）：无东西可搬，视为已处理。
  if (targetCacheDir === legacyCacheDir) {
    return { status: "skipped", markerPath: marker, reason: "same-directory" };
  }
  // 3) 探测旧落点：缺失 / 非目录（ENOTDIR）→ absent，零动作。
  let entries;
  try {
    entries = readdirSync(legacyCacheDir, { withFileTypes: true });
  } catch (cause) {
    if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") {
      return { status: "absent", markerPath: marker };
    }
    return failedResult(cause);
  }
  // 4) 空目录：没有旧模型，零动作（不建目标目录、不写 marker）。
  if (entries.length === 0) {
    return { status: "empty", markerPath: marker };
  }
  // 5) 逐条目搬运：目标已有同名条目跳过（不覆盖）；同卷 rename、跨卷（EXDEV）
  //    回退「拷到目标同卷临时名 → 原子改名 → 删源」，拷贝失败清理临时件。
  const moved = [];
  const skippedEntries = [];
  try {
    mkdirSync(targetCacheDir, { recursive: true });
    for (const entry of entries) {
      const from = join(legacyCacheDir, entry.name);
      const to = join(targetCacheDir, entry.name);
      if (existsSync(to)) {
        skippedEntries.push(entry.name);
        continue;
      }
      try {
        renameImpl(from, to);
        moved.push(entry.name);
      } catch (cause) {
        if (cause?.code !== "EXDEV") throw cause;
        const staging = `${to}.migrating-${process.pid}-${Date.now()}`;
        try {
          cpSync(from, staging, { recursive: true });
          renameSync(staging, to);
          rmSync(from, { recursive: true, force: true });
          moved.push(entry.name);
        } catch (copyCause) {
          try {
            rmSync(staging, { recursive: true, force: true });
          } catch { /* 清理尽力而为：失败随 failedResult 一并上报 */ }
          throw copyCause;
        }
      }
    }
  } catch (cause) {
    return failedResult(cause, { moved: [...moved], skippedEntries: [...skippedEntries] });
  }
  // 6) 全部处理成功：写 marker 只做一次。写失败按 failed 上报（已搬条目保留；
  //    下次启动旧落点变空 → empty，不会重复搬运）。
  try {
    writeFileSync(marker, `${JSON.stringify({
      migratedAt: nowIso(),
      from: legacyCacheDir,
      to: targetCacheDir,
      moved: [...moved],
      skippedEntries: [...skippedEntries],
    }, null, 2)}\n`, "utf8");
  } catch (cause) {
    return failedResult(cause, { moved: [...moved], skippedEntries: [...skippedEntries] });
  }
  return { status: "migrated", markerPath: marker, moved, skippedEntries };
}
