// 0.5-13-4：概览页（overview）只读信息架构测试。
// 证据级别与 ui-status 一致：真实执行 client/index.js（ui-harness 的 fake
// window.__ModuleLoader__ + 有状态 react stub + 真实宿主 zod），mount() 走真实
// 重渲染循环。SYNTHETIC，非浏览器实机。
//
// 覆盖：
// - 顶部能力标签五项（闪回二级记忆 / 候选整理 / 遗忘归档 / 记忆工具 / 分区写入），
//   开启=橙色实心、关闭=灰色可读不可点，title 说明来源 getStatus.capabilities；
// - 冷热分布中文化「热 N · 温 N · 冷 N · 冻结 N」+ 四句解释；
// - 人设卡水位条标注「不计入水位」；
// - 概览页零写操作（auto 卡 / 整理向导 / 启用卡 / 语义召回 / 危险操作都不在本页）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createUiHarness } from "./ui-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const CLIENT_SRC = join(WORKQ, "client", "index.js");

const harness = createUiHarness({ clientSource: CLIENT_SRC });
await harness.install();

test.after(() => {
  harness.restore();
});

function overviewStatus(overrides = {}) {
  return Object.assign({
    mode: "active",
    configured: true,
    scope: "amber",
    personas: ["amber"],
    occupancy: { l0Chars: 120, l1Chars: 2400, l0Budget: 12000, l1HardCap: 48000 },
    capabilities: { l2: true, organize: false, forgetting: true, tools: false, sections: true },
    diagnostics: { ownerId: "local", generation: 1, started: true, configurationState: "configured" },
  }, overrides);
}

function makeDsh({ status = overviewStatus(), tiers = { active: 3, cool: 2, cold: 1, frozen: 4 } } = {}) {
  return {
    call: async (method) => {
      if (method === "getStatus") return status;
      if (method === "getTemperatureSettings") return { current: { coolThreshold: 25 }, audit: [] };
      if (method === "simulateTemperature") return { base: { tiers }, candidate: { tiers }, transitions: [], l1DeltaChars: 0 };
      if (method === "onboardingPreview") return {};
      if (method === "getAutoStatus") return { enabled: true, mode: "suggest", lastRuns: [] };
      if (method === "getMemoryView") return { l0: { text: "", revision: null, chars: 0, budget: 12000, stale: false }, l1: { text: "", body: "", revision: null, chars: 0, budget: 8000, hardCap: 14000 } };
      return {};
    },
  };
}

async function settle(panel) {
  for (let i = 0; i < 8; i += 1) {
    panel.rerender();
    await panel.flush();
  }
}

function findRole(panel, role) {
  return panel.find(`[data-role="${role}"]`);
}

test("概览：能力标签五项，开启=橙色实心、关闭=灰色且不可点，title 说明来源", async () => {
  const panel = await harness.mount({ tab: "overview", dsh: makeDsh() });
  await settle(panel);
  try {
    const order = ["l2", "organize", "forgetting", "tools", "sections"];
    const labels = { l2: "闪回二级记忆", organize: "候选整理", forgetting: "遗忘归档", tools: "记忆工具", sections: "分区写入" };
    const on = { l2: true, organize: false, forgetting: true, tools: false, sections: true };
    for (const key of order) {
      const tag = findRole(panel, "cap-tag-" + key);
      assert.ok(tag, "能力标签存在：" + key);
      assert.equal(tag.tagName, "SPAN", "标签是 span（不是按钮，天然不可点）：" + key);
      assert.equal(String(tag.getAttribute("data-on")), on[key] ? "true" : "false", "开关态标记：" + key);
      const className = String(tag.getAttribute("class") || "");
      assert.ok(className.includes(on[key] ? "dshi_capTagOn" : "dshi_capTagOff"), (on[key] ? "开启=橙色实心类：" : "关闭=灰色类：") + key);
      assert.ok(panel.textOfEl(tag).includes(labels[key] + "：" + (on[key] ? "已开启" : "已关闭")), "文案含中文主名与状态：" + key);
      assert.ok(String(tag.getAttribute("title") || "").includes("getStatus.capabilities." + key), "title 说明数据来源：" + key);
    }
    // 标签顺序固定（顶部一排五项）。
    const tags = panel.findAll("span").filter((el) => String(el.getAttribute("data-role") || "").startsWith("cap-tag-"));
    assert.deepEqual(tags.map((el) => el.getAttribute("data-role")), order.map((k) => "cap-tag-" + k), "五项顺序固定");
  } finally {
    panel.unmount();
  }
});

test("概览：冷热分布中文化「热 N · 温 N · 冷 N · 冻结 N」+ 每类一句解释", async () => {
  const panel = await harness.mount({ tab: "overview", dsh: makeDsh({ tiers: { active: 7, cool: 5, cold: 2, frozen: 1 } }) });
  await settle(panel);
  try {
    const card = findRole(panel, "temperature-status-card");
    assert.ok(card, "冷热分布卡存在");
    const text = panel.textOfEl(card);
    assert.ok(text.includes("热 7 · 温 5 · 冷 2 · 冻结 1"), "四类中文计数取自 tiers");
    assert.equal(text.includes("active "), false, "不再出现英文分级名");
    for (const [key, cn] of [["active", "热"], ["cool", "温"], ["cold", "冷"], ["frozen", "冻结"]]) {
      const note = findRole(panel, "temperature-tier-note-" + key);
      assert.ok(note, "解释行存在：" + key);
      assert.ok(panel.textOfEl(note).includes(cn + "（" + key + "）"), "解释行标注中文名与英文键：" + key);
      assert.ok(panel.textOfEl(note).length > ("（" + cn + key + "）").length + 8, "每类附一句解释：" + key);
    }
  } finally {
    panel.unmount();
  }
});

test("概览：水位条保留，人设卡标注「不计入水位」", async () => {
  const panel = await harness.mount({ tab: "overview", dsh: makeDsh() });
  await settle(panel);
  try {
    const bars = panel.findAll('[data-dshi-bar]');
    assert.equal(bars.length, 2, "L0 / L1 两条水位条都在");
    const text = panel.text();
    assert.ok(text.includes("人设卡正文已用 / 上限"), "L0 原有文案保留");
    assert.ok(text.includes("不计入水位"), "人设卡标注不计入水位");
  } finally {
    panel.unmount();
  }
});

test("概览：零写操作——auto 卡/整理向导/启用卡/语义召回/危险操作都不在概览页", async () => {
  const panel = await harness.mount({ tab: "overview", dsh: makeDsh() });
  await settle(panel);
  try {
    for (const role of ["auto-card", "enable-card", "destroy-data-card", "semantic-recall", "onboarding-card", "organize-tab"]) {
      assert.equal(findRole(panel, role), null, "概览页不渲染：" + role);
    }
    const forbidden = ["立即评估", "应用选中（0 条）", "一键全应用", "一键撤销", "启用记忆", "卸载并清除数据", "重建向量"];
    const texts = panel.findAll("button").map((el) => panel.textOfEl(el));
    for (const label of forbidden) {
      assert.equal(texts.includes(label), false, "概览页没有写操作按钮：" + label);
    }
    // 只读块仍在：能力标签 + 健康状况 + 冷热分布 + 技术细节。
    assert.ok(findRole(panel, "capability-card"), "能力标签在");
    assert.ok(findRole(panel, "health-card"), "健康状况在");
    assert.ok(findRole(panel, "temperature-status-card"), "冷热分布在");
    assert.ok(panel.text().includes("技术细节"), "技术细节折叠在");
  } finally {
    panel.unmount();
  }
});
