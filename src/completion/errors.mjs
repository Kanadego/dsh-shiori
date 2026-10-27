/**
 * Shiori completion state — coded errors。
 *
 * CONTRACTS.md 共享标准：Error.code 至少区分
 * INVALID_INPUT / INVALID_STATE / UNSUPPORTED / REVISION_CONFLICT / LOCK_BUSY。
 * 完成状态模块需要 LOCK_BUSY（root/scope 互斥的第二活 owner 拒绝），
 * 而 src/host/errors.mjs 的 CODES 集不含 LOCK_BUSY 且不在 slot E 归属内，
 * 故本模块维护独立错误工厂；语义与 src/host/errors.mjs 保持一致。
 */

const CODES = new Set([
  "INVALID_INPUT",
  "REVISION_CONFLICT",
  "BUDGET_REJECTED",
  "INVALID_STATE",
  "UNSUPPORTED",
  "LOCK_BUSY",
]);

/** 判断一个值是否是本模块体系内的 coded error。 */
export function isCodedError(value) {
  return value instanceof Error
    && typeof value.code === "string"
    && CODES.has(value.code);
}

/**
 * 构造带 code 的错误。
 * @param {string} code 上述 code 之一
 * @param {string} message 人读说明（必须具体）
 * @param {object} [details] 附加上下文（不得含密钥等敏感信息）
 */
export function codedError(code, message, details = undefined) {
  if (!CODES.has(code)) {
    throw new Error(`internal: unknown error code "${String(code)}"`);
  }
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export const INVALID_INPUT = (message, details) => codedError("INVALID_INPUT", message, details);
export const REVISION_CONFLICT = (message, details) => codedError("REVISION_CONFLICT", message, details);
export const BUDGET_REJECTED = (message, details) => codedError("BUDGET_REJECTED", message, details);
export const INVALID_STATE = (message, details) => codedError("INVALID_STATE", message, details);
export const UNSUPPORTED = (message, details) => codedError("UNSUPPORTED", message, details);
export const LOCK_BUSY = (message, details) => codedError("LOCK_BUSY", message, details);
