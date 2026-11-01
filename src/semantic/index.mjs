// Shiori F1a/F1b · 语义召回 Provider 接口契约。
//
// 边界：本模块只定义契约与纯函数。F1b（本地 embedding，transformers.js + ONNX）
// 已按 spike 通过的方案接入：provider="local" 时返回真实 provider，模型运行时
// 的加载被推迟到首次 embed()（见 local.mjs 的懒加载说明）——本模块顶层与
// createEmbeddingProvider 调用路径仍然零模型加载、零网络请求。provider="api"
// 本期仍未实现（接口预留），显式 NOT_IMPLEMENTED，绝不静默降级。
//
// 契约（迭代清单 F1a，F1b 未改一字节）：
//   createEmbeddingProvider(semanticConfig)
//     -> null
//      | { kind: "local" | "api", dims: number, embed(text): Promise<Float32Array> }
//
//   semanticConfig 形状由配置线固定（缺段按鸭子类型当 none 处理）：
//     { provider: "none" | "local" | "api",
//       local: { model, dims, dtype, cacheDir, mirror },   // 后三项 F1b 新增
//       api:   { endpoint, keyRef } }
//
// 拍板说明（F1a 原文，local 分支的 NOT_IMPLEMENTED 已被 F1b 取代）：
// 调用方（召回合并层）只需区分「没开启（null，回退纯字面）」与「开启但不可用
// （embed 抛 SEMANTIC_UNAVAILABLE，须上报诊断）」两种状态。local 的不可用性
// 在首次 embed 时才暴露（懒加载契约），召回合并层必须把它当作「回退纯字面 +
// 记录诊断」处理，不许让单次召回失败外溢——这与 api 的创建期抛错口径不同，
// 是 F1b 的显式拍板（见任务书 d 条：provider 不可用时行为与纯字面逐字节等价）。

import { createLocalEmbeddingProvider } from "./local.mjs";

// semanticConfig.provider 的合法取值。
const PROVIDERS = new Set(["none", "local", "api"]);

/** 构造带 code 的错误（与 src/host/errors.mjs 同风格；本模块不引入宿主依赖）。 */
function fail(code, message, details) {
  const error = new Error(message);
  error.name = "ShioriError";
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

function describe(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * 从 semanticConfig 解析 provider 名（鸭子类型）：
 * - undefined / null / 缺 provider 字段 / 无法识别的非字符串 → "none"（默认关闭，
 *   行为与 0.1 完全一致）；
 * - 字符串但不在合法集合内 → INVALID_INPUT（拼错配置必须报错，不能当 none 吞掉）。
 */
function resolveProviderKind(semanticConfig) {
  const raw = semanticConfig?.provider;
  if (raw === undefined || raw === null) return "none";
  if (typeof raw !== "string" || !PROVIDERS.has(raw)) {
    fail("INVALID_INPUT", `semantic.provider must be one of none|local|api, got ${describe(raw)}`, {
      provider: raw === undefined ? "absent" : String(raw),
    });
  }
  return raw;
}

/**
 * 创建 embedding provider（F1a 契约工厂；F1b 起 local 分支返回真实 provider）。
 *
 * @param {object|undefined|null} semanticConfig 见模块头注释的固定形状
 * @returns {null | {kind:"local"|"api", dims:number, embed(text:string):Promise<Float32Array>}}
 *   provider 为 "none"（或缺省）时返回 null：语义召回关闭，行为与 0.1 完全一致。
 *   provider 为 "local" 时返回懒加载 provider：构造零 IO，首次 embed 才加载
 *   transformers 运行时（失败抛 code="SEMANTIC_UNAVAILABLE"，见 local.mjs）。
 * @throws {Error} code="NOT_IMPLEMENTED"：provider 为 "api" 时——本期不做，
 *   显式失败而非冒充可用。
 * @throws {Error} code="INVALID_INPUT"：provider 字段是非法字符串；或 local/api 分支
 *   的必填子字段缺失（先校验形状，让配置错误在创建期可诊断）。
 */
export function createEmbeddingProvider(semanticConfig) {
  const kind = resolveProviderKind(semanticConfig);
  if (kind === "none") return null;

  if (kind === "local") {
    const local = semanticConfig.local;
    if (local === null || typeof local !== "object" || Array.isArray(local)) {
      fail("INVALID_INPUT", "semantic.local must be an object { model, dims } when provider is \"local\"", {
        received: describe(local),
      });
    }
    if (typeof local.model !== "string" || local.model.length === 0) {
      fail("INVALID_INPUT", "semantic.local.model must be a non-empty string when provider is \"local\"", {});
    }
    if (!Number.isInteger(local.dims) || local.dims <= 0) {
      fail("INVALID_INPUT", "semantic.local.dims must be a positive integer when provider is \"local\"", {
        dims: local.dims,
      });
    }
    // F1b：dtype / cacheDir / mirror 为可选透传字段（配置线 normalizeSemantic
    // 已做白名单校验；这里不重复校验类型，local.mjs 工厂会再校验必填形状）。
    return createLocalEmbeddingProvider({
      model: local.model,
      dims: local.dims,
      dtype: local.dtype,
      cacheDir: local.cacheDir,
      mirror: local.mirror,
    });
  }

  // kind === "api"
  const api = semanticConfig.api;
  if (api === null || typeof api !== "object" || Array.isArray(api)) {
    fail("INVALID_INPUT", "semantic.api must be an object { endpoint, keyRef } when provider is \"api\"", {
      received: describe(api),
    });
  }
  if (typeof api.endpoint !== "string" || api.endpoint.length === 0) {
    fail("INVALID_INPUT", "semantic.api.endpoint must be a non-empty string when provider is \"api\"", {});
  }
  if (typeof api.keyRef !== "string" || api.keyRef.length === 0) {
    fail("INVALID_INPUT", "semantic.api.keyRef must be a non-empty string when provider is \"api\"", {});
  }
  fail("NOT_IMPLEMENTED",
    "semantic provider \"api\" is not implemented in this release (interface reserved by F1a only); "
    + "either set semantic.provider to \"none\" or wait for the api embedding rollout", {
    provider: "api",
  });
}

// ---------------------------------------------------------------------------
// 向量纯函数（供后续向量召回与离线评测复用；本文件唯一的可执行交付）。
// ---------------------------------------------------------------------------

/** 校验输入是有限数值向量（Float32Array / Float64Array / number[] 均可），返回原引用。 */
function requireVector(value, label) {
  const isVectorLike = (value instanceof Float32Array || value instanceof Float64Array
    || (Array.isArray(value) && value.every((n) => typeof n === "number")));
  if (!isVectorLike || value.length === 0) {
    fail("INVALID_INPUT", `${label} must be a non-empty numeric vector (Float32Array/Float64Array/number[])`, {
      received: describe(value),
    });
  }
  for (const n of value) {
    if (!Number.isFinite(n)) {
      fail("INVALID_INPUT", `${label} must contain only finite numbers`, {});
    }
  }
  return value;
}

/**
 * L2 归一化：返回与输入等长的新 Float32Array，模长为 1。
 * 零向量没有方向，返回全零副本（调用方用 cosineSimilarity 时得 0，不产生 NaN）。
 */
export function normalizeVector(vector) {
  requireVector(vector, "vector");
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const out = new Float32Array(vector.length);
  if (sum === 0) return out; // 零向量：保持零，不除零
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] * inv;
  return out;
}

/**
 * 余弦相似度（浮点实现，结果钳制到 [-1, 1] 消除舍入溢出）。
 * 任一向量为零向量时相似度定义为 0（无方向可比，不产生 NaN）。
 * 维度不一致按 INVALID_INPUT 拒绝——静默对齐会掩盖上游模型/索引错配。
 */
export function cosineSimilarity(a, b) {
  requireVector(a, "a");
  requireVector(b, "b");
  if (a.length !== b.length) {
    fail("INVALID_INPUT", `cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`, {
      dimsA: a.length,
      dimsB: b.length,
    });
  }
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(-1, Math.min(1, cos));
}
