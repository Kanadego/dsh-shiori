// Shiori P5-Q · Cordis 插件入口（named exports：name / inject / Config / apply）。
//
// apply 固定顺序（CONTRACTS §2）：
//   normalizePluginConfig → verifyPluginRoots（真实路径校验）→ createShioriPluginController
//   → controller.start → mountShioriRpc；
//   返回 async cleanup：RPC stop（禁新、卸载、排空）→ controller.stop。
//   部分启动失败逆序清理后原样抛出，不残留工具 / section / 锁。
//
// 入口不写业务状态、不做工具/section/RPC 之外的任何宿主注册；business 归 P controller。
// 本文件无 default export（禁止默认导出遮蔽 named Config / inject）。
//
// inject 只声明 P controller 真正需要的宿主基础服务；typert / Gateway 缺席时
// 由 RPC diagnostics 如实声明 UI unsupported（仅工具模式），不因此拒绝挂载。

import { normalizePluginConfig, verifyPluginRoots } from "./src/plugin/config.mjs";
import { createShioriPluginController } from "./src/plugin/controller.mjs";
import { mountShioriRpc } from "./src/plugin/client-rpc.mjs";

/** Cordis 插件 id（同时是 settings 命名空间与 RPC wire 命名空间）。 */
export const name = "shiori";

/** 宿主基础服务：P 的生产 bindings 来自 ctx（tools / systemPrompt）。 */
export const inject = ["tools", "systemPrompt"];

export { Config } from "./src/plugin/config.mjs";

/**
 * @param {object} ctx 本插件的 Cordis 上下文。
 * @param {object} config 宿主传入的原始配置（settings 命名空间承载，缺省 inert shadow）。
 * @returns {Promise<() => Promise<void>>} 卸载清理（RPC 先停，controller 后停）。
 */
export async function apply(ctx, config) {
  // 1. 权威规范化（未知键拒绝 / 预算全关系 / 忘却 policy / roots 结构规则）
  const normalized = normalizePluginConfig(config ?? {});
  // 2. apply 阶段真实路径校验（真实 link 解析后仍互不嵌套；schema dump 不能替代）；
  //    校验通过后把「解析真实 link 的 canonical 绝对路径」回填 settings，保证
  //    验证与 controller / RPC 实际使用的路径完全一致，不残留词法混排形式。
  const verified = verifyPluginRoots(normalized);
  const settings = verified.inert
    ? normalized
    : Object.freeze({ ...normalized, dataRoot: verified.dataRoot, stateRoot: verified.stateRoot });

  // 3. 构造 controller（契约签名为 async，返回 {start,stop,diagnostics,management}；
  //    不自动 start；inert shadow 由 P 以 needs-configuration 诊断挂载）
  const controller = await createShioriPluginController(ctx, settings);

  let rpc = null;
  try {
    // 4. 启动（失败逆序清理：此时尚无 RPC，直接停 controller）
    await controller.start();
    // 5. 挂载面板 RPC（自身失败自行清理并抛出；apply 再停 controller）
    rpc = await mountShioriRpc(ctx, controller.management, settings);
  } catch (error) {
    // 逆序清理尽力执行，但始终抛出原始错误（不被清理失败掩盖）
    try {
      if (rpc) await rpc.stop();
    } catch { /* 保留原始错误 */ }
    try {
      await controller.stop();
    } catch { /* 同上 */ }
    throw error;
  }

  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    try {
      // RPC 先停：禁新 → 撤销自有取消信号 → 排空在途
      await rpc.stop();
    } finally {
      // 再停 controller：禁新请求 → 撤订阅/timer/注册 → 排空 → flush → close
      await controller.stop().catch(() => {});
    }
  };
}
