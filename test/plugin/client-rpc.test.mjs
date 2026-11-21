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

test("wire 17：protocol / CONTRACT_METHODS / DRAINED 三处逐字同集合、同顺序（热度参数三方法在末尾）", async () => {
  assert.deepEqual([...MANAGEMENT_METHOD_NAMES], [...CONTRACT_METHODS], "protocol 键序与 CONTRACT_METHODS 逐字一致");
  assert.equal(CONTRACT_METHODS.length, 17);
  assert.deepEqual([...CONTRACT_METHODS.slice(-3)], ["getTemperatureSettings", "simulateTemperature", "recordTemperatureChange"]);

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
