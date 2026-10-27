// Shiori P2-L2 · buildSparkAttachment / commitDelivery 测试（合成，纯函数）。
// 覆盖 tasks/H.md 必测反例：600 UTF-16 预算（元数据计入）、100 字符正文
// 门槛与 summary 降级、绝不截半句、种子优先、accepted=false 不产生
// seen/hit、accepted=true 的 key 含 scope/session/contextEpoch/id/revision。

import test from "node:test";
import assert from "node:assert/strict";
import { buildSparkAttachment, commitDelivery, SPARK_INLINE_MAX_CHARS } from "../../src/sparks/delivery.mjs";
import { seenKeyFor } from "../../src/sparks/match.mjs";

const SCOPE = "amber";
const SESSION = "sess-1";
const EPOCH = 7;

function card(overrides = {}) {
  return {
    id: "s1",
    scopeId: SCOPE,
    revision: 1,
    title: "标题",
    summary: "摘要",
    triggers: [],
    entities: [],
    links: [],
    content: "正文",
    vitality: "evergreen",
    state: "active",
    ...overrides,
  };
}

function seedItem(c, trigger = "梗") {
  return { id: c.id, revision: c.revision, spark: c, trigger };
}

function match({ seeds = [], related = [] } = {}) {
  return { scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH, seeds, related, anchors: [] };
}

function build(args) {
  return buildSparkAttachment({ scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH, ...args });
}

// ---------------------------------------------------------------------------
// buildSparkAttachment：预算与渲染
// ---------------------------------------------------------------------------

test("空 match / null match 产出空附件", () => {
  for (const m of [match(), null, undefined]) {
    const d = build({ match: m });
    assert.equal(d.text, "");
    assert.deepEqual(d.delivered, []);
    assert.deepEqual(d.dropped, []);
    assert.equal(d.chars, 0);
  }
});

test("五张短卡（正文 ≤100）全部装下且最终文本 ≤600 UTF-16", () => {
  const content = "a".repeat(100);
  const seeds = ["s1", "s2", "s3", "s4", "s5"].map((id) =>
    seedItem(card({ id, content })));
  const d = build({ match: match({ seeds }) });
  assert.equal(d.delivered.length, 5);
  assert.deepEqual(d.dropped, []);
  assert.ok(d.chars <= 600, `expected <=600, got ${d.chars}`);
  assert.equal(d.text.length, d.chars);
  // 元数据计入：id、标题、分隔符都出现在最终文本里。
  for (const id of ["s1", "s2", "s3", "s4", "s5"]) {
    assert.ok(d.text.includes(`[spark:${id} rev1]`));
  }
  assert.ok(d.text.includes("---"));
});

test("正文 >100 只带 summary + id，不泄露长正文", () => {
  const long = "长".repeat(150);
  const seeds = [seedItem(card({ id: "big", content: long, summary: "短摘要" }))];
  const d = build({ match: match({ seeds }) });
  assert.ok(d.text.includes("短摘要"));
  assert.ok(!d.text.includes(long));
});

test("预算装不下时先降级为摘要；摘要也装不下则整卡跳过，绝不截半句", () => {
  const content = "这是一句完整的短正文，必须整体出现。"; // ≤100，可带出
  const summary = "这是更短的摘要。";
  const c = card({ id: "c1", content, summary });
  // 预算只够 summary 块（头部约 18 字 + 摘要 8 字）：content 块约 37 字
  // 装不下 → 降级为 summary，完整出现。
  const d = build({ match: match({ seeds: [seedItem(c)] }), maxChars: 30 });
  assert.deepEqual(d.delivered.map((x) => x.id), ["c1"]);
  assert.ok(d.text.includes(summary));
  assert.ok(!d.text.includes(content));

  // 预算连 summary 块都装不下：整卡跳过，文本中不出现任何半截内容。
  const d2 = build({ match: match({ seeds: [seedItem(c)] }), maxChars: 10 });
  assert.deepEqual(d2.delivered, []);
  assert.deepEqual(d2.dropped, [{ id: "c1", reason: "budget" }]);
  assert.ok(!d2.text.includes("完整的短正文"));
  assert.ok(!d2.text.includes("更短的摘要"));
});

test("长正文卡的 summary 装不下时整卡跳过，不产出半句 summary", () => {
  const c = card({ id: "long", content: "x".repeat(200), summary: "y".repeat(50) });
  const d = build({ match: match({ seeds: [seedItem(c)] }), maxChars: 30 });
  assert.deepEqual(d.delivered, []);
  assert.ok(!d.text.includes("y".repeat(20)));
});

test("种子优先于关联占用预算；被挤掉的关联记为 budget drop", () => {
  const bigSeed = card({ id: "big", content: "z".repeat(100) });
  const rel1 = card({ id: "r1", content: "r".repeat(100) });
  const rel2 = card({ id: "r2", content: "q".repeat(100) });
  const d = build({
    match: match({ seeds: [seedItem(bigSeed)], related: [seedItem(rel1), seedItem(rel2)] }),
    // 单个正文块约 120 字；130 预算下种子装下后，关联的正文块与降级
    // 摘要块（约 26 字含分隔符）都装不下，只能整卡挤掉。
    maxChars: 130,
  });
  assert.deepEqual(d.delivered.map((x) => x.id), ["big"]);
  assert.deepEqual(d.dropped, [{ id: "r1", reason: "budget" }, { id: "r2", reason: "budget" }]);
});

test("重复 id 只渲染一次", () => {
  const c = card({ id: "dup", content: "短" });
  const d = build({ match: match({ seeds: [seedItem(c)], related: [seedItem(c)] }) });
  assert.deepEqual(d.delivered, [{ id: "dup", revision: 1 }]);
  assert.equal(d.text.split("[spark:dup rev1]").length - 1, 1);
});

test("来源字段计入块头部", () => {
  const c = card({ id: "src", content: "短", source: "2026-10-16 会话" });
  const d = build({ match: match({ seeds: [seedItem(c)] }) });
  assert.ok(d.text.includes("· 2026-10-16 会话"));
});

test("maxChars 校验：非正整数拒绝", () => {
  assert.throws(() => build({ match: match(), maxChars: 0 }), /INVALID_INPUT|maxChars/);
  assert.throws(() => build({ match: match(), maxChars: -5 }), /INVALID_INPUT|maxChars/);
  assert.throws(() => build({ match: match(), maxChars: 10.5 }), /INVALID_INPUT|maxChars/);
});

test("正文门槛常量为 100", () => {
  assert.equal(SPARK_INLINE_MAX_CHARS, 100);
});

// ---------------------------------------------------------------------------
// commitDelivery：提交语义
// ---------------------------------------------------------------------------

function buildDelivery(seeds, related = []) {
  return build({ match: match({ seeds, related }) });
}

test("accepted=false 不产生任何 seen/hit 变更（含预算挤掉与已投递卡）", () => {
  const c = card({ id: "c1", content: "短" });
  const delivery = buildDelivery([seedItem(c)]);
  const committed = commitDelivery({ delivery, accepted: false });
  assert.equal(committed.accepted, false);
  assert.deepEqual(committed.seenWrites, []);
  assert.deepEqual(committed.hitUpdates, []);
});

test("accepted=true：seen key 含 scope/session/contextEpoch/id/revision，hit 与 delivered 对齐", () => {
  const c1 = card({ id: "c1", revision: 3, content: "短" });
  const c2 = card({ id: "c2", revision: 1, content: "也短" });
  const delivery = buildDelivery([seedItem(c1)], [seedItem(c2)]);
  assert.deepEqual(delivery.delivered.map((x) => x.id), ["c1", "c2"]);

  const committed = commitDelivery({ delivery, accepted: true });
  assert.equal(committed.accepted, true);
  assert.deepEqual(committed.seenWrites.map((w) => w.key), [
    seenKeyFor({ scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH, sparkId: "c1", revision: 3 }),
    seenKeyFor({ scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH, sparkId: "c2", revision: 1 }),
  ]);
  for (const w of committed.seenWrites) {
    assert.ok(w.key.includes(SCOPE));
    assert.ok(w.key.includes(SESSION));
    assert.ok(w.key.includes(String(EPOCH)));
    assert.ok(w.key.includes(w.sparkId));
    assert.ok(w.key.includes(String(w.revision)));
  }
  assert.deepEqual(committed.hitUpdates, [
    { sparkId: "c1", revision: 3 },
    { sparkId: "c2", revision: 1 },
  ]);
});

test("预算挤掉的卡不出现在 accepted=true 的 seen 写入中", () => {
  const big = card({ id: "big", content: "z".repeat(100) });
  const rel = card({ id: "r1", content: "r".repeat(100) });
  const delivery = build({
    match: match({ seeds: [seedItem(big)], related: [seedItem(rel)] }),
    maxChars: 130,
  });
  assert.deepEqual(delivery.dropped.map((x) => x.id), ["r1"]);
  const committed = commitDelivery({ delivery, accepted: true });
  assert.deepEqual(committed.seenWrites.map((w) => w.sparkId), ["big"]);
  assert.deepEqual(committed.hitUpdates.map((h) => h.sparkId), ["big"]);
});

test("不同 session/epoch 产生不同 seen key，可再次投递", () => {
  const c = card({ id: "c1", content: "短" });
  const d1 = buildDelivery([seedItem(c)]);
  const d2 = buildSparkAttachment({
    scopeId: SCOPE, sessionId: "sess-2", contextEpoch: EPOCH + 1,
    match: match({ seeds: [seedItem(c)] }),
  });
  const w1 = commitDelivery({ delivery: d1, accepted: true }).seenWrites[0].key;
  const w2 = commitDelivery({ delivery: d2, accepted: true }).seenWrites[0].key;
  assert.notEqual(w1, w2);
});

test("commitDelivery 入参校验", () => {
  const delivery = buildDelivery([seedItem(card({ id: "c1", content: "短" }))]);
  assert.throws(() => commitDelivery({ delivery, accepted: "yes" }), /INVALID_INPUT|accepted/);
  assert.throws(() => commitDelivery({ delivery: null, accepted: true }), /INVALID_INPUT|delivery/);
  assert.throws(() => commitDelivery({ delivery: { kind: "other" }, accepted: true }), /INVALID_INPUT|kind/);
  assert.throws(() => commitDelivery({
    delivery: { ...delivery, scopeId: "" }, accepted: true,
  }), /INVALID_INPUT|scopeId/);
  assert.throws(() => commitDelivery({
    delivery: { ...delivery, delivered: "nope" }, accepted: true,
  }), /INVALID_INPUT|delivered/);
});

// ---------------------------------------------------------------------------
// 评审 rework 回归（attempt 2）
// ---------------------------------------------------------------------------

test("H2：长正文且 summary 缺失 → 整卡跳过（missing-summary），accepted=true 也不写 seen/hit", () => {
  const noSummaryProp = card({ id: "long", content: "x".repeat(101) });
  delete noSummaryProp.summary;
  const emptySummary = card({ id: "long2", content: "y".repeat(150), summary: "" });
  const d = build({
    match: match({ seeds: [seedItem(noSummaryProp), seedItem(emptySummary)] }),
  });
  assert.deepEqual(d.delivered, []);
  assert.deepEqual(d.dropped, [
    { id: "long", reason: "missing-summary" },
    { id: "long2", reason: "missing-summary" },
  ]);
  assert.equal(d.text, "");

  const committed = commitDelivery({ delivery: d, accepted: true });
  assert.deepEqual(committed.seenWrites, []);
  assert.deepEqual(committed.hitUpdates, []);
});

test("H2：长正文缺 summary 的卡不挤占预算，后续合格卡正常投递", () => {
  const broken = card({ id: "broken", content: "x".repeat(101), summary: "" });
  const good = card({ id: "good", content: "短正文" });
  const d = build({ match: match({ seeds: [seedItem(broken), seedItem(good)] }) });
  assert.deepEqual(d.delivered.map((x) => x.id), ["good"]);
  assert.deepEqual(d.dropped, [{ id: "broken", reason: "missing-summary" }]);
  const committed = commitDelivery({ delivery: d, accepted: true });
  assert.deepEqual(committed.seenWrites.map((w) => w.sparkId), ["good"]);
});

test("H2：正文与 summary 均缺失 → 同样整卡跳过，不产出仅头部投递", () => {
  const blank = card({ id: "blank", content: "", summary: "" });
  const d = build({ match: match({ seeds: [seedItem(blank)] }) });
  assert.deepEqual(d.delivered, []);
  assert.deepEqual(d.dropped, [{ id: "blank", reason: "missing-summary" }]);
  assert.equal(d.text, "");
});

// ---------------------------------------------------------------------------
// 评审 attempt 3 回归：纯空白 summary 视同缺失
// ---------------------------------------------------------------------------

test("空白 summary（>100 正文）→ 整卡跳过，accepted=true 也不写 seen/hit", () => {
  const ws = card({ id: "ws", content: "x".repeat(150), summary: "   " });
  const d = build({ match: match({ seeds: [seedItem(ws)] }) });
  assert.deepEqual(d.delivered, []);
  assert.deepEqual(d.dropped, [{ id: "ws", reason: "missing-summary" }]);
  assert.ok(!d.text.includes("ws"));

  const committed = commitDelivery({ delivery: d, accepted: true });
  assert.deepEqual(committed.seenWrites, []);
  assert.deepEqual(committed.hitUpdates, []);
});

test("空白 summary 的卡不进 text/delivered/seenWrites/hitUpdates 的完整断言", () => {
  const a = card({ id: "ws1", content: "y".repeat(101), summary: "\t\n" });
  const b = card({ id: "ok", content: "短正文" });
  const d = build({ match: match({ seeds: [seedItem(a), seedItem(b)] }) });
  assert.deepEqual(d.delivered.map((x) => x.id), ["ok"]);
  assert.deepEqual(d.dropped, [{ id: "ws1", reason: "missing-summary" }]);
  const committed = commitDelivery({ delivery: d, accepted: true });
  assert.deepEqual(committed.seenWrites.map((w) => w.sparkId), ["ok"]);
  assert.deepEqual(committed.hitUpdates.map((h) => h.sparkId), ["ok"]);
  assert.ok(!committed.seenWrites.some((w) => w.key.includes("ws1")));
});

test("空白 summary 也不作为短正文的降级摘要使用", () => {
  // 短正文卡在预算内先带正文；构造预算紧张场景验证降级列表不含空白摘要。
  const c = card({ id: "c1", content: "z".repeat(60), summary: "  " });
  const d = build({ match: match({ seeds: [seedItem(c)] }), maxChars: 30 });
  // 正文块（约 70 字）装不下，降级摘要为空白（不可用）→ 整卡跳过。
  assert.deepEqual(d.delivered, []);
  assert.deepEqual(d.dropped, [{ id: "c1", reason: "budget" }]);
  assert.equal(d.text, "");
});
