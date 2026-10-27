import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "../../src/core/index.mjs";

const { DEFAULT_CONFIG, validateConfig, renderL1, evaluateMutation, selectVisibleTopics, validateKey } = core;

function makeTopic(overrides = {}) {
  return {
    key: "onion",
    title: "洋葱梗",
    summary: "问眼里常含泪水，原来刚切过洋葱。",
    scopeId: "global",
    revision: "rev-1",
    updated: "2026-10-16T22:10:00+08:00",
    body: "一段正文。",
    ...overrides,
  };
}

test("public entry exports exactly the six contract members", () => {
  assert.deepEqual(Object.keys(core).sort(), [
    "DEFAULT_CONFIG",
    "evaluateMutation",
    "renderL1",
    "selectVisibleTopics",
    "validateConfig",
    "validateKey",
  ]);
  assert.equal(typeof validateConfig, "function");
  assert.equal(typeof renderL1, "function");
  assert.equal(typeof evaluateMutation, "function");
  assert.equal(typeof selectVisibleTopics, "function");
  assert.equal(typeof validateKey, "function");
  assert.ok(DEFAULT_CONFIG && typeof DEFAULT_CONFIG === "object");
});

test("full pipeline: scopes -> visible topics -> render -> budget", () => {
  const topics = [
    makeTopic({ key: "onion", scopeId: "global", summary: "全局洋葱" }),
    makeTopic({ key: "onion", scopeId: "amber", summary: "示例洋葱" }),
    makeTopic({ key: "private", scopeId: "other-card", summary: "第三卡不可见" }),
    makeTopic({ key: "shared", scopeId: "global", summary: "共享条目" }),
  ];
  const visible = selectVisibleTopics({ activeScopeId: "amber", topics });
  assert.deepEqual(visible.map((t) => t.key), ["onion", "shared"]);
  assert.equal(visible[0].summary, "示例洋葱");

  const rendered = renderL1({ coreText: "## 铁律\n正文", topics: visible });
  assert.ok(rendered.text.includes("- onion [amber] — 示例洋葱"));
  assert.ok(rendered.text.includes("- shared [global] — 共享条目"));
  assert.ok(!rendered.text.includes("第三卡"));

  const verdict = evaluateMutation({
    currentText: rendered.text,
    candidateText: rendered.text,
    config: DEFAULT_CONFIG,
  });
  assert.equal(verdict.allowed, true);
  assert.equal(verdict.candidateChars, rendered.chars);
});

test("directory growth passes through the same gates as core growth", () => {
  const config = DEFAULT_CONFIG;

  // 基线：core 8999 码元、无索引 → 8999，未到闸门
  const base = renderL1({ coreText: "a".repeat(8999), topics: [] });
  assert.equal(base.chars, 8999);

  // 新增一个专题：完整渲染 = core + "\n\n" + 标题 + 索引行（标题与来源计入）
  const withOneTopic = renderL1({
    coreText: "a".repeat(8999),
    topics: [makeTopic({ key: "k1", summary: "s" })],
  });
  assert.ok(withOneTopic.chars > 9000 && withOneTopic.chars <= 10000);
  const crossing = evaluateMutation({
    currentText: base.text,
    candidateText: withOneTopic.text,
    config,
  });
  assert.equal(crossing.allowed, true);
  assert.equal(crossing.reason, "first-crossing");
  assert.equal(crossing.candidateChars, withOneTopic.chars);

  // 再新增一批长摘要专题：完整渲染超过硬顶 → 从正常态直接拒绝
  const manyTopics = Array.from({ length: 12 }, (_, i) =>
    makeTopic({ key: `topic-${i}`, summary: "摘".repeat(60) }),
  );
  const withManyTopics = renderL1({
    coreText: "a".repeat(8999),
    topics: [makeTopic({ key: "k1", summary: "s" }), ...manyTopics],
  });
  assert.ok(withManyTopics.chars > 10000);
  const rejected = evaluateMutation({
    currentText: base.text,
    candidateText: withManyTopics.text,
    config,
  });
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.reason, "over-hard-cap");

  // 已在闸门之上时：闸门内的净增长按净增长拦截；超出硬顶则按最终防线拒绝
  const withTwoTopics = renderL1({
    coreText: "a".repeat(8999),
    topics: [makeTopic({ key: "k1", summary: "s" }), makeTopic({ key: "k2", summary: "摘".repeat(60) })],
  });
  assert.ok(withTwoTopics.chars > withOneTopic.chars && withTwoTopics.chars <= 10000);
  const blocked = evaluateMutation({
    currentText: withOneTopic.text,
    candidateText: withTwoTopics.text,
    config,
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "net-growth-blocked");

  const overCap = evaluateMutation({
    currentText: withOneTopic.text,
    candidateText: withManyTopics.text,
    config,
  });
  assert.equal(overCap.allowed, false);
  assert.equal(overCap.reason, "over-hard-cap");
});

test("budget is measured on the full render, never on core body alone", () => {
  const config = DEFAULT_CONFIG;
  const topics = Array.from({ length: 80 }, (_, i) =>
    makeTopic({ key: `t${String(i).padStart(3, "0")}`, summary: "摘要".repeat(30) }),
  );
  const rendered = renderL1({ coreText: "a".repeat(5000), topics });
  // core 正文只有 5000，但完整渲染（含索引）超过闸门与硬顶
  assert.ok(rendered.chars > 10000);
  const verdict = evaluateMutation({
    currentText: rendered.text,
    candidateText: rendered.text + "x",
    config,
  });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.level, "over-cap");
  assert.equal(verdict.reason, "repair-only");
  assert.ok(verdict.currentChars === rendered.chars && verdict.currentChars > 10000);
});

test("repair path: shrink the render until it is promotable again", () => {
  const config = DEFAULT_CONFIG;
  const big = renderL1({ coreText: "a".repeat(11000), topics: [] });
  const mid = renderL1({ coreText: "a".repeat(10500), topics: [] });
  const fixed = renderL1({ coreText: "a".repeat(10000), topics: [] });

  const partial = evaluateMutation({ currentText: big.text, candidateText: mid.text, config });
  assert.equal(partial.allowed, true);
  assert.equal(partial.promotable, false);
  assert.equal(partial.reason, "repair-over-cap");

  const done = evaluateMutation({ currentText: mid.text, candidateText: fixed.text, config });
  assert.equal(done.allowed, true);
  assert.equal(done.promotable, true);
  assert.equal(done.reason, "repair");
});

test("validateKey, validateConfig and renderL1 compose without shared state", () => {
  const key = validateKey("integration-key");
  const config = validateConfig({});
  const rendered = renderL1({
    coreText: "c",
    topics: [makeTopic({ key, scopeId: "amber" })],
  });
  const verdict = evaluateMutation({ currentText: "", candidateText: rendered.text, config });
  assert.deepEqual(
    { allowed: verdict.allowed, promotable: verdict.promotable },
    { allowed: true, promotable: true },
  );
});
