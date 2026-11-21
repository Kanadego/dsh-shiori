// Shiori P1#8 · 根目录 mkdir 失败降级挂载（controller 层）测试。
//
// 覆盖：active 模式但任一根 mkdir 失败时，start() 不抛、以只读/内存态降级挂载——
//   1) 返回值带 degraded:true + 逐根结构化诊断；
//   2) 17 工具照常注册（宿主工具面不变），执行一律 UNSUPPORTED（含 details.roots）；
//   3) getStatus 纯内存投影可用，diagnostics.roots 面板可见，started 不谎报；
//   4) diagnostics() 门面同样透出 roots（纯增量字段）；
//   5) 降级后 stop() 干净收场，再次 start 重新裁决（诊断重算）。
// 夹具：路径穿过已存在的普通文件制造确定性 mkdir 失败（ENOTDIR，跨平台一致），
// 不依赖平台 ACL/管理员权限；bindings / state 经 dependencies 注入桩，绝不触盘。

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizePluginConfig } from "../../src/plugin/config.mjs";
import { createShioriPluginController } from "../../src/plugin/controller.mjs";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiori-p1-root-diag-"));

test.after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** bindings 桩：只记录 registerTool 的 def；disposeAll 清空注册表（模拟真实
 * bindings 的代次清理，re-register 后 registeredTools 回到 17）。 */
function stubBindingsFactory() {
  const registeredTools = [];
  const factory = () => ({
    registerTool: async (def) => {
      registeredTools.push(def);
      return () => {};
    },
    registerSystemSection: () => {},
    registerAssembleWaterfall: () => {},
    registerPreStep: () => {},
    subscribeSessionEvents: () => () => {},
    loadCreateUserMessage: async () => null,
    disposeAll: () => {
      registeredTools.length = 0;
      return { errors: [] };
    },
    diagnostics: { registeredTools, registeredSections: [] },
  });
  return { factory, registeredTools };
}

/** 用「父级是普通文件」构造确定性不可写根（mkdir 递归创建必得 ENOTDIR）。 */
function blockedRoot(name) {
  const blocker = join(TMP_ROOT, name);
  writeFileSync(blocker, "not a directory", "utf8");
  return { blocker, root: join(blocker, "shiori-root") };
}

/** 构造 active 模式的降级 settings（与 apply 产物同构：normalize + 解析根回填）。 */
function degradedSettings({ dataRoot, stateRoot }) {
  const normalized = normalizePluginConfig({ mode: "active", allowActive: true, dataRoot, stateRoot });
  return Object.freeze({
    ...normalized,
    dataRoot,
    stateRoot,
    rootsSource: { dataRoot: "explicit", stateRoot: "explicit" },
  });
}

test("P1#8：dataRoot 不可写 → start 降级挂载（不抛、degraded:true、17 工具照常注册）", async () => {
  const data = blockedRoot("data-blocker");
  const stateRoot = join(TMP_ROOT, "state-ok", "shiori-state");
  const bindings = stubBindingsFactory();
  const controller = await createShioriPluginController(
    {},
    degradedSettings({ dataRoot: data.root, stateRoot }),
    { bindings: bindings.factory, createState: () => ({}) },
  );

  let result = null;
  try {
    result = await controller.start();
  } catch (error) {
    assert.fail(`degraded mount must not throw (got ${error.code}: ${error.message})`);
  }
  assert.equal(result.mode, "active");
  assert.equal(result.degraded, true, "start must report degraded mount");
  assert.equal(result.sections.length, 0, "L0/L1 sections must not register in degraded mode");
  assert.equal(result.tools.length, 17, "all 17 host tools must stay registered");
  assert.equal(result.roots.length, 1);
  assert.equal(result.roots[0].root, "dataRoot");
  assert.equal(result.roots[0].path, data.root);
  assert.equal(result.roots[0].code, "ENOTDIR");
  assert.ok(result.roots[0].reason.length > 0);
  assert.equal(bindings.registeredTools.length, 17, "stub must have observed 17 registerTool calls");

  // started 不宣称：getStatus 保持纯内存投影（面板可见诊断，不撞 scope 资源）。
  assert.equal(controller.diagnostics().started, false, "degraded mount must not claim started");

  await controller.stop(); // 降级态 stop 必须干净收场（disposeAll 桩不抛）
});

test("P1#8：降级态工具执行一律 UNSUPPORTED（写/读同口径，details.roots 带诊断）", async () => {
  const data = blockedRoot("tool-data-blocker");
  const stateRoot = join(TMP_ROOT, "tool-state-ok", "shiori-state");
  const bindings = stubBindingsFactory();
  const controller = await createShioriPluginController(
    {},
    degradedSettings({ dataRoot: data.root, stateRoot }),
    { bindings: bindings.factory, createState: () => ({}) },
  );
  await controller.start();

  const exec = { agent: { session: { id: "session-degraded" } } };
  for (const name of ["memory_append", "core_write", "soul_read", "spark_graph"]) {
    const def = bindings.registeredTools.find((d) => d.name === name);
    assert.ok(def, `tool ${name} must be registered`);
    await assert.rejects(
      () => def.execute({}, exec),
      (error) => {
        assert.equal(error.code, "UNSUPPORTED", `${name} must fail UNSUPPORTED in degraded mount`);
        assert.ok(
          String(error.message).includes("not writable"),
          `${name} message must explain the degraded read-only mount`,
        );
        assert.ok(Array.isArray(error.details?.roots), `${name} details.roots must carry diagnostics`);
        assert.equal(error.details.roots[0].root, "dataRoot");
        assert.equal(error.details.roots[0].path, data.root);
        return true;
      },
    );
  }
  await controller.stop();
});

test("P1#8：降级态 getStatus 可用——diagnostics.roots 面板可见、scope/occupancy 不触盘", async () => {
  const data = blockedRoot("status-data-blocker");
  const stateRoot = join(TMP_ROOT, "status-state-ok", "shiori-state");
  const bindings = stubBindingsFactory();
  const controller = await createShioriPluginController(
    {},
    degradedSettings({ dataRoot: data.root, stateRoot }),
    { bindings: bindings.factory, createState: () => ({}) },
  );
  await controller.start();

  // started=false → management.getStatus 走纯内存投影（trustedContext 不参与）。
  const status = await controller.management.getStatus(null, {});
  assert.equal(status.mode, "active");
  assert.equal(status.scope, null, "degraded mount must not resolve a data scope");
  assert.equal(status.occupancy, null, "degraded mount must not read occupancy from disk");
  assert.ok(status.diagnostics, "getStatus must expose diagnostics");
  assert.equal(status.diagnostics.roots.length, 1, "panel-visible root diagnostics");
  assert.equal(status.diagnostics.roots[0].root, "dataRoot");
  assert.equal(status.diagnostics.roots[0].code, "ENOTDIR");
  assert.equal(status.diagnostics.roots[0].path, data.root);

  // diagnostics() 门面同样透出（纯增量字段）。
  const diag = controller.diagnostics();
  assert.equal(diag.roots.length, 1);
  assert.equal(diag.roots[0].code, "ENOTDIR");
  assert.equal(diag.started, false);

  await controller.stop();
});

test("P1#8：两根同时不可写 → 两条诊断；stop 后再次 start 重算裁决（幂等）", async () => {
  const data = blockedRoot("both-data-blocker");
  const state = blockedRoot("both-state-blocker");
  const bindings = stubBindingsFactory();
  const controller = await createShioriPluginController(
    {},
    degradedSettings({ dataRoot: data.root, stateRoot: state.root }),
    { bindings: bindings.factory, createState: () => ({}) },
  );

  const first = await controller.start();
  assert.deepEqual(first.roots.map((d) => d.root), ["dataRoot", "stateRoot"]);
  await controller.stop();

  // 再次 start：重新探测、再次降级（诊断重算，不残留旧代状态；上一代工具
  // 已由 stop 的 disposeAll 撤销，本轮重注册后注册表回到 17）。
  const second = await controller.start();
  assert.equal(second.degraded, true);
  assert.deepEqual(second.roots.map((d) => d.root), ["dataRoot", "stateRoot"]);
  assert.equal(second.tools.length, 17, "tools re-registered on the retry attempt");
  assert.equal(bindings.registeredTools.length, 17, "registry holds only the current generation");
  await controller.stop();
});

test("P1#8：正常可写根不走降级闸（对照：可写根完整挂载成功，无 degraded 标记）", async () => {
  // 对照组验证「降级判定来自磁盘真值」：同一构造路径换可写根后，start 走
  // 完整 active 挂载（stub bindings 不触盘，service/store 落在 tmp dataRoot），
  // 结果没有 degraded 标记、started 宣称、诊断 roots 恒空。
  const base = join(TMP_ROOT, "writable-control");
  const bindings = stubBindingsFactory();
  const controller = await createShioriPluginController(
    {},
    degradedSettings({ dataRoot: join(base, "data"), stateRoot: join(base, "state") }),
    { bindings: bindings.factory, createState: () => ({}) },
  );
  const result = await controller.start();
  assert.equal(result.degraded, undefined, "writable roots must mount normally (no degraded flag)");
  assert.equal(result.mode, "active");
  assert.equal(controller.diagnostics().started, true, "normal mount claims started");
  assert.deepEqual(controller.diagnostics().roots, [], "normal mount must keep roots diagnostics empty");
  await controller.stop();
});
