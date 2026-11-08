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

export function notFound(message, details) {
  return new StorageError('NOT_FOUND', message, details);
}

export function lockBusy(message, details) {
  return new StorageError('LOCK_BUSY', message, details);
}

/** 文件系统层失败（EACCES/EPERM/ENOSPC/ENOTDIR 等）：与 sparks 层 IO_ERROR 约定同形
 *  （稳定 code + details.ioCode + cause 保留原始 errno），绝不吞错回成功。 */
export function ioError(message, details) {
  return new StorageError('IO_ERROR', message, details);
}

/** 包装底层 fs 错误：保留 cause 与 ioCode，调用方永远拿到带 code 的错误。 */
export function wrapIoError(where, err) {
  const wrapped = ioError(
    `${where}: 文件系统操作失败（${err?.code ?? err?.message ?? 'unknown'}），拒绝静默成功`,
    { where, ioCode: err?.code ?? null },
  );
  wrapped.cause = err;
  return wrapped;
}
