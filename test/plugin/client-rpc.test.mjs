// 0.5 批次 4 · B 线：wire 契约三处一致性 + 热度参数三方法的 RPC 契约测试。
//
// 三处清单必须逐字同集合、同顺序（任务书验收）：
//   1) src/plugin/protocol.mjs 的 MANAGEMENT_METHODS 键序；
//   2) src/plugin/client-rpc.mjs 的 CONTRACT_METHODS；
//   3) src/plugin/controller.mjs 的 DRAINED_MANAGEMENT_METHODS（= CONTRACT 去掉
//      纯内存 getStatus，同序）。
// controller 在构造期用 methodSetMismatch 做集合级硬闸；顺序由本测试从源码
// 抽取数组文本钉死（DRAINED 未导出，源码级抽取避免为测试扩 API）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const load = (rel) => import(pathToFileURL(join(WORKQ, rel)).href);

const { MANAGEMENT_METHODS, MANAGEMENT_METHOD_NAMES, validateManagementPayload } = await load("src/plugin/protocol.mjs");
const { CONTRACT_METHODS } = await load("src/plugin/client-rpc.mjs");
const { createShioriPluginController } = await load("src/plugin/controller.mjs");

test("wire 21：protocol / CONTRACT_METHODS / DRAINED 三处逐字同集合、同顺序（auto 四方法在末尾）", async () => {
  // 规格连带：wire 17→21（0.5 批次 5 A 线 auto 冷却/恢复四方法 getAutoStatus /
  // runAutoEvaluation / applyAutoChanges / undoAutoRun 追加在末尾；DRAINED 16→20）。
  assert.deepEqual([...MANAGEMENT_METHOD_NAMES], [...CONTRACT_METHODS], "protocol 键序与 CONTRACT_METHODS 逐字一致");
  assert.equal(CONTRACT_METHODS.length, 21);
  assert.deepEqual(
    [...CONTRACT_METHODS.slice(14, 17)],
    ["getTemperatureSettings", "simulateTemperature", "recordTemperatureChange"],
    "热度参数三方法仍在第 15/16/17 位（B 线位置不动）",
  );
  assert.deepEqual(
    [...CONTRACT_METHODS.slice(-4)],
    ["getAutoStatus", "runAutoEvaluation", "applyAutoChanges", "undoAutoRun"],
    "auto 四方法按声明顺序追加在 recordTemperatureChange 之后",
  );

  const source = readFileSync(join(WORKQ, "src", "plugin", "controller.mjs"), "utf8");
  const match = /const DRAINED_MANAGEMENT_METHODS = \[([\s\S]*?)\];/.exec(source);
  assert.ok(match, "controller.mjs 必须存在 DRAINED_MANAGEMENT_METHODS 数组");
  const drained = [...match[1].matchAll(/"([^"]+)"/g)].map((hit) => hit[1]);
  assert.deepEqual(drained, CONTRACT_METHODS.filter((name) => name !== "getStatus"), "DRAINED 与 CONTRACT（去 getStatus）同序同字");

  // 真实构造（inert：shadow + 双 null 根）不抛 → controller 内部集合闸通过。
  const ctx = { systemPrompt: { section: () => () => {} }, tools: { register: () => () => {} }, on: () => () => {} };
  const controller = await createShioriPluginController(ctx, {
    mode: "shadow", allowActive: false, dataRoot: null, stateRoot: null,
  });
  assert.equal(typeof controller.management.getTemperatureSettings, "function");
  assert.equal(typeof controller.management.simulateTemperature, "function");
  assert.equal(typeof controller.management.recordTemperatureChange, "function");
  // 0.5 批次 5 · A 线：auto 四方法挂载即存在（真实 management 入口）。
  assert.equal(typeof controller.management.getAutoStatus, "function");
  assert.equal(typeof controller.management.runAutoEvaluation, "function");
  assert.equal(typeof controller.management.applyAutoChanges, "function");
  assert.equal(typeof controller.management.undoAutoRun, "function");
});

test("wire 17：三新方法 schema 闭合（input/output 显式 false）、必填字段与输出键冻结", () => {
  const getSettings = MANAGEMENT_METHODS.getTemperatureSettings;
  assert.equal(getSettings.inputSchema.additionalProperties, false);
  assert.deepEqual(getSettings.inputSchema.properties, {});
  assert.deepEqual(getSettings.outputSchema.required,
    ["current", "defaults", "specs", "crossChecks", "hysteresis", "audit"]);
  assert.equal(getSettings.outputSchema.additionalProperties, false);
  assert.deepEqual(getSettings.outputSchema.properties.auditError, { type: "string" });

  const simulate = MANAGEMENT_METHODS.simulateTemperature;
  assert.deepEqual(simulate.inputSchema.required, ["params"]);
  assert.deepEqual(simulate.inputSchema.properties.params, { type: "object", additionalProperties: true });
  assert.deepEqual(simulate.outputSchema.required, ["base", "candidate", "transitions", "l1DeltaChars", "alarms"]);
  assert.deepEqual(simulate.outputSchema.properties.l1DeltaChars, { type: "integer" }, "字符净变化可为负，只声明整数");

  const record = MANAGEMENT_METHODS.recordTemperatureChange;
  assert.deepEqual(record.inputSchema.required, ["params", "operationId"]);
  assert.deepEqual(record.outputSchema.required, ["recorded", "replay", "changes"]);
});

test("wire 17：payload 闭包校验（未知键/缺必填/operationId 非法一律 INVALID_INPUT）", () => {
  assert.throws(() => validateManagementPayload("getTemperatureSettings", { rogue: 1 }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("simulateTemperature", {}), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("simulateTemperature", { params: {}, rogue: 1 }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("recordTemperatureChange", { params: {} }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("recordTemperatureChange", { params: {}, operationId: "" }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("recordTemperatureChange", { params: {}, operationId: "has space" }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("recordTemperatureChange", { params: {}, operationId: "x".repeat(129) }), (e) => e.code === "INVALID_INPUT");
  assert.deepEqual(validateManagementPayload("recordTemperatureChange", { params: { s0Days: 30 }, operationId: "op-1" }),
    { params: { s0Days: 30 }, operationId: "op-1" });
});

// ── 0.5 批次 5 · A 线（wire 18/19/20/21）：auto 四方法 schema 契约 ─────────────

test("wire 21：auto 四方法 schema 闭合（input/output 显式 false）、必填字段与输出键冻结", () => {
  const getAutoStatus = MANAGEMENT_METHODS.getAutoStatus;
  assert.equal(getAutoStatus.inputSchema.additionalProperties, false);
  assert.deepEqual(getAutoStatus.inputSchema.properties, {});
  assert.deepEqual(getAutoStatus.outputSchema.required,
    ["scope", "enabled", "mode", "lastEvaluatedAt", "lastEvaluatedBy", "nextTrigger", "fuse", "stats", "params", "lastRuns"]);
  assert.equal(getAutoStatus.outputSchema.additionalProperties, false);
  assert.deepEqual(getAutoStatus.outputSchema.properties.mode, { enum: ["off", "suggest", "auto"] });

  const runAutoEvaluation = MANAGEMENT_METHODS.runAutoEvaluation;
  assert.deepEqual(runAutoEvaluation.inputSchema.properties, {});
  assert.deepEqual(runAutoEvaluation.outputSchema.required,
    ["scope", "evaluatedAt", "trigger", "fused", "fuse", "stats", "replay", "candidates", "plan"]);
  assert.deepEqual(runAutoEvaluation.outputSchema.properties.trigger, { enum: ["manual", "human-turn", "soft-watermark"] });

  const applyAutoChanges = MANAGEMENT_METHODS.applyAutoChanges;
  assert.deepEqual(applyAutoChanges.inputSchema.required, ["operationId"]);
  assert.deepEqual(applyAutoChanges.outputSchema.required,
    ["runId", "replay", "evaluatedAt", "trigger", "applied", "skipped", "failed", "truncated", "ops", "groupRestore"]);
  assert.deepEqual(applyAutoChanges.outputSchema.properties.applied, { type: "integer", minimum: 0 });

  const undoAutoRun = MANAGEMENT_METHODS.undoAutoRun;
  assert.deepEqual(undoAutoRun.inputSchema.required, ["runId"]);
  assert.deepEqual(undoAutoRun.outputSchema.required,
    ["runId", "replay", "undoneAt", "reverted", "alreadyUndone", "skipped", "failed", "ops"]);
  assert.deepEqual(undoAutoRun.outputSchema.properties.replay, { type: "boolean" });
});

test("wire 21：auto 四方法 payload 闭包校验（未知键/缺必填一律 INVALID_INPUT）", () => {
  assert.throws(() => validateManagementPayload("getAutoStatus", { rogue: 1 }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("runAutoEvaluation", { rogue: 1 }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("applyAutoChanges", {}), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("applyAutoChanges", { operationId: "op-1", rogue: 1 }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("undoAutoRun", {}), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateManagementPayload("undoAutoRun", { runId: "" }), (e) => e.code === "INVALID_INPUT");
  assert.deepEqual(validateManagementPayload("getAutoStatus", {}), {});
  assert.deepEqual(validateManagementPayload("applyAutoChanges", { operationId: "op-1" }), { operationId: "op-1" });
  assert.deepEqual(validateManagementPayload("undoAutoRun", { runId: "auto-1-abc" }), { runId: "auto-1-abc" });
});
