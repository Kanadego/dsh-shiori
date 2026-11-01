// Shiori F1a · 语义召回 Provider 接口契约（零依赖）。
//
// 边界：本模块只定义契约与纯函数，不含任何网络请求与模型加载代码。
// F1b（本地 embedding，transformers.js + ONNX）以 spike 通过为前提另行接入；
// 本期 local / api 两种 provider 都显式 NOT_IMPLEMENTED，绝不静默降级。
//
// 契约（迭代清单 F1a）：
//   createEmbeddingProvider(semanticConfig)
//     -> null
//      | { kind: "local" | "api", dims: number, embed(text): Promise<Float32Array> }
//
//   semanticConfig 形状由配置线固定（缺段按鸭子类型当 none 处理）：
//     { provider: "none" | "local" | "api",
//       local: { model, dims },
//       api:   { endpoint, keyRef } }
//
// 拍板说明（二选一之「抛错」）：provider 为 local / api 时，createEmbeddingProvider
// 直接抛 code="NOT_IMPLEMENTED" 的 coded error，而不是返回一个 embed() 会抛错的
// provider 假对象。理由：调用方（召回合并层）只需区分「没开启（null，回退纯字面）」
// 与「开启但不可用（抛错，须上报配置问题）」两种状态；在创建期抛错让「配置了却不
// 可用」在启动/装配路径上就暴露，避免等到第一次召回才失败，也不许冒充可用。
// 上层不得把 NOT_IMPLEMENTED 当作「回退字面」的静默信号吞掉——那是 F1b 接入点，
// 接入前开启 local/api 就是配置错误。

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
 * 创建 embedding provider（F1a 契约工厂）。
 *
 * @param {object|undefined|null} semanticConfig 见模块头注释的固定形状
 * @returns {null | {kind:"local"|"api", dims:number, embed(text:string):Promise<Float32Array>}}
 *   provider 为 "none"（或缺省）时返回 null：语义召回关闭，行为与 0.1 完全一致。
 * @throws {Error} code="NOT_IMPLEMENTED"：provider 为 local / api 时——F1b 未接入，
 *   显式失败而非冒充可用（理由见模块头注释）。
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
    fail("NOT_IMPLEMENTED",
      `semantic provider "local" (model: ${local.model}) is not implemented in this release (F1b pending spike); `
      + "either set semantic.provider to \"none\" or wait for the local embedding rollout", {
      provider: "local",
      model: local.model,
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
