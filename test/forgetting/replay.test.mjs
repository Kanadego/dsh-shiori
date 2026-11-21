// 0.5 批次 4 · B 线：回放模拟纯模块测试。
//
// 三条硬验收在此锁死：
// 1) 确定性：同输入两次调用 deepEqual，且 JSON.stringify 逐字节相同；
// 2) 同源：simulateTemperature 的每个 topic T 与直接 evaluateTopics 逐条相等
//    （≥3 组参数；T 的计算必须委托 evaluateTopics，复制公式会红）；
// 3) 迁级/字符净变化：transitions 只列 from !== to；l1DeltaChars 按
//    迁入 cold/frozen − 迁出 cold/frozen 计。

import test from "node:test";
import assert from "node:assert/strict";
import { simulateTemperature } from "../../src/forgetting/replay.mjs";
import { evaluateTopics } from "../../src/forgetting/topic-temperature.mjs";
import {
  DEFAULT_TEMPERATURE_PARAMS,
  normalizeTemperatureParams,
  toFormulaParams,
} from "../../src/forgetting/params.mjs";

const NOW = "2026-11-22T00:00:00.000Z";

function fixtures() {
  const topics = [
    // 约 326 天未动：默认参数下早已 frozen。
    { key: "alpha", scopeId: "global", updated: "2026-01-01T00:00:00.000Z", retention: "historical", chars: 100 },
    // 约 52 天：T ≈ 30（默认 coolThreshold=25 → cool）。
    { key: "beta", scopeId: "global", updated: "2026-10-01T00:00:00.000Z", retention: "historical", chars: 50 },
    // 近期 updated：active。
    { key: "gamma", scopeId: "global", updated: "2026-11-20T00:00:00.000Z", retention: "standing", chars: 20 },
  ];
  const events = [
    { at: "2026-10-02T00:00:00.000Z", scopeId: "global", kind: "read", topicKey: "beta" },
    { at: "2026-10-20T00:00:00.000Z", scopeId: "global", kind: "read", topicKey: "beta" },
    { at: "2026-11-20T00:00:00.000Z", scopeId: "global", kind: "updated", topicKey: "gamma" },
    { at: "2026-11-21T00:00:00.000Z", scopeId: "global", kind: "group_list", groupKey: "g1" },
  ];
  const groups = [{ key: "g1", retention: "historical" }];
  return { topics, groups, events };
}

const PARAM_SETS = [
  { label: "defaults", params: { ...DEFAULT_TEMPERATURE_PARAMS } },
  {
    label: "cold-line-up",
    params: {
      s0Days: 14, sMaxDays: 120, consolidateGain: 0.3, readAlpha: 0.5,
      updatedFloor: 90, readDedupHours: 12, coolThreshold: 40, restoreThreshold: 50,
      minCooldownDays: 20, minRestoreGraceDays: 10, maxOpsPerRun: 10, evaluateEveryHours: 12,
    },
  },
  {
    label: "aggressive-cool",
    params: {
      s0Days: 45, sMaxDays: 300, consolidateGain: 0.7, readAlpha: 0.2,
      updatedFloor: 60, readDedupHours: 48, coolThreshold: 35, restoreThreshold: 70,
      minCooldownDays: 60, minRestoreGraceDays: 20, maxOpsPerRun: 30, evaluateEveryHours: 48,
    },
  },
];

test("确定性：同输入两次调用 deepEqual 且 JSON 逐字节相同", () => {
  const input = { ...fixtures(), now: NOW, params: PARAM_SETS[1].params, baseParams: DEFAULT_TEMPERATURE_PARAMS };
  const first = simulateTemperature(input);
  const second = simulateTemperature(input);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  // 输入未被修改（纯模块纪律）。
  assert.deepEqual(input.topics[1], fixtures().topics[1]);
});

test("同源：≥3 组参数下每个 topic 的 T 与直接 evaluateTopics 逐条相等", () => {
  const { topics, groups, events } = fixtures();
  for (const { label, params } of PARAM_SETS) {
    const sim = simulateTemperature({ topics, groups, events, now: NOW, params, baseParams: DEFAULT_TEMPERATURE_PARAMS });
    const direct = evaluateTopics({ topics, groups, events, now: NOW, params: toFormulaParams(normalizeTemperatureParams(params)) });
    assert.equal(sim.candidate.topics.length, direct.topics.length, `${label}：topic 数一致`);
    const byKey = new Map(direct.topics.map((t) => [t.key, t]));
    for (const projected of sim.candidate.topics) {
      const reference = byKey.get(projected.key);
      assert.ok(reference, `${label}：${projected.key} 在 evaluateTopics 输出中`);
      assert.equal(projected.T, reference.T, `${label}：${projected.key} 的 T 必须与 evaluateTopics 逐条相等`);
      assert.equal(projected.tier, reference.tier, `${label}：${projected.key} 的分级一致`);
    }
    // 分级计数与逐条 tier 自洽。
    const counts = { active: 0, cool: 0, cold: 0, frozen: 0 };
    for (const topic of direct.topics) counts[topic.tier] += 1;
    assert.deepEqual(sim.candidate.tiers, counts, `${label}：tiers 计数自洽`);
  }
});

test("迁级：cool→cold 出一条 transition，l1DeltaChars 计入字符净变化", () => {
  const { topics, groups, events } = fixtures();
  const coldLineUp = PARAM_SETS[1].params; // coolThreshold=40 → beta 30 落入 cold
  const sim = simulateTemperature({ topics, groups, events, now: NOW, params: coldLineUp, baseParams: DEFAULT_TEMPERATURE_PARAMS });
  const beta = sim.transitions.find((t) => t.key === "beta");
  assert.ok(beta, "beta 必须出现在迁级清单");
  assert.equal(beta.from, "cool");
  assert.equal(beta.to, "cold");
  assert.equal(beta.chars, 50);
  assert.ok(typeof beta.reason === "string" && beta.reason.length > 0, "每条迁级都带理由");
  assert.equal(sim.transitions.length, 1, "只列 from !== to 的 topic");
  assert.equal(sim.l1DeltaChars, 50, "迁入 cold 计 +chars");
});

test("迁级：cold→cool 返回负的字符净变化（迁出 cold/frozen 计 −chars）", () => {
  const { topics, groups, events } = fixtures();
  const coldLineUp = PARAM_SETS[1].params;
  const sim = simulateTemperature({ topics, groups, events, now: NOW, params: DEFAULT_TEMPERATURE_PARAMS, baseParams: coldLineUp });
  const beta = sim.transitions.find((t) => t.key === "beta");
  assert.ok(beta);
  assert.equal(beta.from, "cold");
  assert.equal(beta.to, "cool");
  assert.equal(sim.l1DeltaChars, -50);
});

test("时钟回拨告警透传（候选侧 alarms 原样上报）", () => {
  const { topics, groups } = fixtures();
  const events = [{ at: "2027-01-01T00:00:00.000Z", scopeId: "global", kind: "read", topicKey: "beta" }];
  const sim = simulateTemperature({ topics, groups, events, now: NOW, params: DEFAULT_TEMPERATURE_PARAMS, baseParams: DEFAULT_TEMPERATURE_PARAMS });
  assert.ok(sim.alarms.some((a) => a.code === "CLOCK_ROLLBACK"));
  assert.equal(sim.transitions.length, 0);
});

test("非法参数：交叉校验失败 → INVALID_INPUT，message 带键名与规则", () => {
  const { topics, groups, events } = fixtures();
  assert.throws(
    () => simulateTemperature({
      topics, groups, events, now: NOW,
      params: { ...DEFAULT_TEMPERATURE_PARAMS, restoreThreshold: 30 }, // 30 < 25+10
      baseParams: DEFAULT_TEMPERATURE_PARAMS,
    }),
    (error) => error.code === "INVALID_INPUT" && /restoreThreshold/.test(error.message),
  );
  assert.throws(
    () => simulateTemperature({ topics: "not-array", groups, events, now: NOW, params: DEFAULT_TEMPERATURE_PARAMS }),
    (error) => error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => simulateTemperature({ topics, groups, events, now: undefined, params: DEFAULT_TEMPERATURE_PARAMS }),
    (error) => error.code === "INVALID_INPUT",
  );
});

test("chars 缺失按 0；负字符数拒绝（不把估算变成负数来源）", () => {
  const { groups, events } = fixtures();
  const topics = [{ key: "beta", scopeId: "global", updated: "2026-10-01T00:00:00.000Z" }];
  const sim = simulateTemperature({ topics, groups, events, now: NOW, params: PARAM_SETS[1].params, baseParams: DEFAULT_TEMPERATURE_PARAMS });
  assert.equal(sim.transitions.find((t) => t.key === "beta").chars, 0);
  assert.equal(sim.l1DeltaChars, 0);
  assert.throws(
    () => simulateTemperature({ topics: [{ ...topics[0], chars: -1 }], groups, events, now: NOW, params: DEFAULT_TEMPERATURE_PARAMS }),
    (error) => error.code === "INVALID_INPUT",
  );
});
