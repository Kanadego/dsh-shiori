// Shiori P0-STORAGE · 错误类型
// 契约要求至少区分 INVALID_INPUT / REVISION_CONFLICT / BUDGET_REJECTED /
// INVALID_STATE / UNSUPPORTED；NOT_FOUND 与 LOCK_BUSY 为本模块补充，
// 便于上层精确处理（见 docs/storage/TROUBLESHOOTING.md）。

export class StorageError extends Error {
  /**
   * @param {string} code 稳定错误码
   * @param {string} message 人类可读描述
   * @param {object} [details] 结构化补充信息（不用于判断逻辑，仅供诊断）
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function invalidInput(message, details) {
  return new StorageError('INVALID_INPUT', message, details);
}

export function revisionConflict(message, details) {
  return new StorageError('REVISION_CONFLICT', message, details);
}

export function budgetRejected(message, details) {
  return new StorageError('BUDGET_REJECTED', message, details);
}

export function invalidState(message, details) {
  return new StorageError('INVALID_STATE', message, details);
}

export function unsupported(message, details) {
  return new StorageError('UNSUPPORTED', message, details);
}

export function notFound(message, details) {
  return new StorageError('NOT_FOUND', message, details);
}

export function lockBusy(message, details) {
  return new StorageError('LOCK_BUSY', message, details);
}
