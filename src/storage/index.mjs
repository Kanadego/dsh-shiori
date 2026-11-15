// Shiori P0-STORAGE · 公共入口
// 契约接口见 CONTRACTS.md §B；详细协议与已知限制见 docs/storage/README.md。

export { createFileStore } from './store.mjs';
export { StorageError } from './errors.mjs';
// 0.4 S3 组清单：groups.json 物理路径助手（读写实现在 src/core/groups.mjs，
// 锁与原子写复用本目录 lockfile/fsutil 的现成实现）。
export { groupsFilePath } from './paths.mjs';
