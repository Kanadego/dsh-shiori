/**
 * Shiori host bridge — coded errors.
 *
 * CONTRACTS.md 要求错误使用带 code 的 Error，至少区分
 * INVALID_INPUT / REVISION_CONFLICT / BUDGET_REJECTED / INVALID_STATE / UNSUPPORTED。
 * 不静默截断、不用空字符串/零掩盖错误。
 */

const CODES = new Set([
  "INVALID_INPUT",
  "REVISION_CONFLICT",
  "BUDGET_REJECTED",
  "INVALID_STATE",
  "UNSUPPORTED",
]);

/** 判断一个值是否是本模块体系内的 coded error。 */
export function isCodedError(value) {
  return value instanceof Error
    && typeof value.code === "string"
    && CODES.has(value.code);
}

/**
 * 构造带 code 的错误。
 * @param {string} code 上述五个 code 之一
 * @param {string} message 人读说明（中文/英文均可，必须具体）
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
