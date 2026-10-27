// Shiori P2-SPARKS · Spark 存储错误类型
// 契约（CONTRACTS §G）要求至少区分 INVALID_INPUT / INVALID_STATE /
// REVISION_CONFLICT / NOT_FOUND / LOCK_BUSY / UNSUPPORTED。
// IO_ERROR 为本模块补充：底层文件系统失败（权限、磁盘、设备错误）时
// 显式抛出并保留 cause，绝不吞错回成功、绝不静默归零。
//
// 形状与 P1 src/storage/errors.mjs 的 StorageError 对齐（name/code/details），
// 但刻意不继承：sparks 层的错误判定只看 code 字段，两层互不强绑。

export class SparkStoreError extends Error {
  /**
   * @param {string} code 稳定错误码
   * @param {string} message 人类可读描述
   * @param {object} [details] 结构化补充信息（仅供诊断，不用于判断逻辑）
   */
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'SparkStoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function invalidInput(message, details) {
  return new SparkStoreError('INVALID_INPUT', message, details);
}

export function invalidState(message, details) {
  return new SparkStoreError('INVALID_STATE', message, details);
}

export function revisionConflict(message, details) {
  return new SparkStoreError('REVISION_CONFLICT', message, details);
}

export function notFound(message, details) {
  return new SparkStoreError('NOT_FOUND', message, details);
}

/** 本模块自身不主动抛出；跨进程锁（复用 P1 withLock）的争用会带着
 *  同名 code 冒泡。保留工厂以保证错误码集合完整、便于上层包装。 */
export function lockBusy(message, details) {
  return new SparkStoreError('LOCK_BUSY', message, details);
}

export function unsupported(message, details) {
  return new SparkStoreError('UNSUPPORTED', message, details);
}

/** 文件系统层失败（EACCES/EPERM/ENOSPC/ENOTDIR 等）。 */
export function ioError(message, details) {
  return new SparkStoreError('IO_ERROR', message, details);
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
