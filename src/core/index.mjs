// Shiori 核心层公共入口。
// 仅导出契约规定的六个成员；实现细节分布在同目录各模块。
//
//   DEFAULT_CONFIG / validateConfig  —— 配置默认值与整体校验
//   renderL1                          —— L1 完整渲染（core + 派生索引）
//   evaluateMutation                  —— 双水位 + 绝对硬顶闸门
//   selectVisibleTopics               —— 作用域可见性与 active 覆盖 global
//   validateKey                       —— 安全 key（文件名级）校验
//
// 全部为纯函数（无 I/O、无共享可变状态）；错误一律为带 code 的 Error，
// 至少区分 INVALID_INPUT / REVISION_CONFLICT / BUDGET_REJECTED / INVALID_STATE / UNSUPPORTED
//（本模块当前只产生 INVALID_INPUT，其余 code 由 B/C 层使用）。

export { DEFAULT_CONFIG, validateConfig } from "./config.mjs";
export { evaluateMutation } from "./budget.mjs";
export { renderL1 } from "./render.mjs";
export { selectVisibleTopics } from "./topics.mjs";
export { validateKey } from "./keys.mjs";
