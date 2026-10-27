import { test } from "node:test";
import assert from "node:assert/strict";
import { renderL1 } from "../../src/core/render.mjs";

const HEADER = "## 主题记忆索引 / Topic memory index";

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

function assertRejected(input, pattern) {
  assert.throws(
    () => renderL1(input),
    (error) => {
      assert.equal(error.code, "INVALID_INPUT");
      if (pattern) assert.match(error.message, pattern);
      return true;
    },
  );
}

test("renders the exact fixed index format joined to core by two LFs", () => {
  const result = renderL1({
    coreText: "## 铁律\n正文",
    topics: [makeTopic({ key: "onion", scopeId: "amber", summary: "切洋葱梗" })],
  });
  assert.equal(result.text, "## 铁律\n正文\n\n## 主题记忆索引 / Topic memory index\n- onion [amber] — 切洋葱梗");
  assert.equal(result.indexText, `${HEADER}\n- onion [amber] — 切洋葱梗`);
  assert.equal(result.chars, result.text.length);
});

test("no topics means no index header and text equals coreText verbatim", () => {
  const result = renderL1({ coreText: "## 铁律\n正文", topics: [] });
  assert.equal(result.text, "## 铁律\n正文");
  assert.equal(result.indexText, "");
  assert.equal(result.chars, "## 铁律\n正文".length);
  assert.ok(!result.text.includes("主题记忆索引"));
});

test("empty core renders index only, without a leading separator", () => {
  const result = renderL1({ coreText: "", topics: [makeTopic({ key: "k", summary: "s" })] });
  assert.equal(result.text, result.indexText);
  assert.ok(result.text.startsWith(HEADER));
  assert.ok(result.text.endsWith("- k [global] — s"));
});

test("empty core and no topics render an empty string", () => {
  const result = renderL1({ coreText: "", topics: [] });
  assert.equal(result.text, "");
  assert.equal(result.chars, 0);
  assert.equal(result.bytes, 0);
  assert.equal(result.indexText, "");
});

test("index header and source markers count toward chars", () => {
  const coreText = "abc";
  const result = renderL1({ coreText, topics: [makeTopic({ key: "k", summary: "s" })] });
  // text = core(3) + "\n\n"(2) + header + "\n" + "- k [global] — s"
  assert.equal(result.chars, 3 + 2 + result.indexText.length);
  assert.ok(result.chars > coreText.length + 2);
  // 来源标记 [global] 确实在最终文本中
  assert.ok(result.text.includes("[global]"));
});

test("UTF-16 chars and UTF-8 bytes are counted separately", () => {
  const zh = renderL1({ coreText: "中", topics: [] });
  assert.equal(zh.chars, 1);
  assert.equal(zh.bytes, 3);

  const emoji = renderL1({ coreText: "😀", topics: [] });
  assert.equal(emoji.chars, 2, "emoji 计 2 个 UTF-16 码元");
  assert.equal(emoji.bytes, 4);

  const mixed = renderL1({ coreText: "中😀a", topics: [] });
  assert.equal(mixed.chars, 4);
  assert.equal(mixed.bytes, 3 + 4 + 1);
});

test("emoji in summary counts as 2 UTF-16 chars toward the 60 limit", () => {
  const ok = renderL1({ coreText: "x", topics: [makeTopic({ key: "k", summary: "😀".repeat(30) })] });
  assert.equal(ok.text.includes("😀".repeat(30)), true);
  assertRejected(
    { coreText: "x", topics: [makeTopic({ key: "k", summary: "😀".repeat(31) })] },
    /summary is 62 UTF-16 chars, max is 60/,
  );
});

test("summary of exactly 60 chars is accepted, 61 is rejected", () => {
  renderL1({ coreText: "x", topics: [makeTopic({ key: "k", summary: "a".repeat(60) })] });
  assertRejected(
    { coreText: "x", topics: [makeTopic({ key: "k", summary: "a".repeat(61) })] },
    /summary is 61 UTF-16 chars, max is 60/,
  );
});

test("empty summary is allowed and renders deterministically", () => {
  const result = renderL1({ coreText: "x", topics: [makeTopic({ key: "k", summary: "" })] });
  assert.ok(result.text.endsWith("- k [global] — "));
});

test("topics are sorted by key in UTF-16 code-unit order", () => {
  const result = renderL1({
    coreText: "core",
    topics: [
      makeTopic({ key: "b", summary: "1" }),
      makeTopic({ key: "A", summary: "2" }),
      makeTopic({ key: "a", summary: "3" }),
      makeTopic({ key: "0", summary: "4" }),
    ],
  });
  const lines = result.indexText.split("\n").slice(1);
  assert.deepEqual(
    lines,
    ["- 0 [global] — 4", "- A [global] — 2", "- a [global] — 3", "- b [global] — 1"],
  );
});

test("rendering is verbatim-stable for unchanged input, order-insensitive, and repeatable", () => {
  const topics = [
    makeTopic({ key: "beta", summary: "B" }),
    makeTopic({ key: "alpha", summary: "A" }),
    makeTopic({ key: "gamma", summary: "G" }),
  ];
  const first = renderL1({ coreText: "core text", topics });
  const second = renderL1({ coreText: "core text", topics });
  assert.equal(first.text, second.text);
  assert.equal(first.bytes, second.bytes);

  const reordered = renderL1({ coreText: "core text", topics: [topics[2], topics[0], topics[1]] });
  assert.equal(reordered.text, first.text);

  // 全新但内容相同的对象也逐字一致
  const fresh = renderL1({
    coreText: "core text",
    topics: [
      makeTopic({ key: "gamma", summary: "G" }),
      makeTopic({ key: "alpha", summary: "A" }),
      makeTopic({ key: "beta", summary: "B" }),
    ],
  });
  assert.equal(fresh.text, first.text);
});

test("duplicate keys in the topic list are rejected, across scopes too", () => {
  assertRejected(
    {
      coreText: "x",
      topics: [makeTopic({ key: "dup", scopeId: "amber" }), makeTopic({ key: "dup", scopeId: "global" })],
    },
    /duplicate topic key "dup"/,
  );
  assertRejected(
    { coreText: "x", topics: [makeTopic({ key: "dup" }), makeTopic({ key: "dup" })] },
    /duplicate topic key "dup"/,
  );
});

test("coreText is never trimmed or altered", () => {
  const trailing = renderL1({ coreText: "abc\n", topics: [makeTopic({ key: "k", summary: "s" })] });
  assert.ok(trailing.text.startsWith("abc\n\n\n" + HEADER));
  const spaces = renderL1({ coreText: "   ", topics: [] });
  assert.equal(spaces.text, "   ");
});

test("renders over-cap text without enforcing any budget", () => {
  const result = renderL1({ coreText: "a".repeat(20000), topics: [] });
  assert.equal(result.chars, 20000);
});

test("body and title are never part of the L1 render", () => {
  const topic = makeTopic({ key: "k", title: "绝密标题", body: "绝密正文不应出现在 L1" });
  const result = renderL1({ coreText: "core", topics: [topic] });
  assert.ok(!result.text.includes("绝密标题"));
  assert.ok(!result.text.includes("绝密正文"));
});

test("large topic sets render once header and stay deterministic", () => {
  const topics = Array.from({ length: 100 }, (_, i) =>
    makeTopic({ key: `topic-${String(i).padStart(3, "0")}`, summary: `摘要${i}` }),
  );
  const result = renderL1({ coreText: "core", topics });
  const lines = result.indexText.split("\n");
  assert.equal(lines.length, 101);
  assert.equal(lines[0], HEADER);
  const again = renderL1({ coreText: "core", topics: [...topics].reverse() });
  assert.equal(again.text, result.text);
});

test("malformed input is rejected with INVALID_INPUT", () => {
  assertRejected(undefined, /must be a plain object/);
  assertRejected(null, /must be a plain object/);
  assertRejected({ coreText: "x" }, /missing required property "topics"/);
  assertRejected({ topics: [] }, /missing required property "coreText"/);
  assertRejected({ coreText: "x", topics: [] , extra: true }, /unknown property "extra"/);
  assertRejected({ coreText: 5, topics: [] }, /coreText must be a string/);
  assertRejected({ coreText: "x", topics: "no" }, /topics must be an array/);
  assertRejected({ coreText: "x", topics: [null] }, /topics\[0\] must be a plain object/);
  assertRejected({ coreText: "x", topics: [[]] }, /topics\[0\] must be a plain object/);
  assertRejected(
    { coreText: "x", topics: [makeTopic({ key: "a/b" })] },
    /forbidden filename character/,
  );
  assertRejected(
    { coreText: "x", topics: [makeTopic({ summary: "a".repeat(61) })] },
    /summary is 61/,
  );
});

test("R2 regression: sparse topic arrays are rejected, not silently skipped", () => {
  // new Array(1) 是长度 1 的稀疏数组，孔必须被显式拒绝而不是当作无 topic
  assertRejected({ coreText: "x", topics: new Array(1) }, /topics\[0\] must be a plain object/);
  assertRejected({ coreText: "x", topics: new Array(3) }, /topics\[0\] must be a plain object/);
  // 混合孔：合法条目 + 孔 + 合法条目
  const sparse = [makeTopic({ key: "a", scopeId: "amber" })];
  sparse[2] = makeTopic({ key: "b", scopeId: "amber" });
  assertRejected({ coreText: "x", topics: sparse }, /topics\[1\] must be a plain object/);
  // 显式 undefined / null 同样拒绝
  assertRejected({ coreText: "x", topics: [undefined] }, /topics\[0\] must be a plain object/);
  assertRejected({ coreText: "x", topics: [makeTopic(), null] }, /topics\[1\] must be a plain object/);
  // 密集合法数组与空数组仍然正常
  renderL1({ coreText: "x", topics: [makeTopic({ key: "a" }), makeTopic({ key: "b" })] });
  renderL1({ coreText: "x", topics: [] });
});

test("R3 regression: input and topics must be plain records with own properties", () => {
  // 仅靠原型链携带字段的输入对象：不是普通记录对象
  const proto = { coreText: "x", topics: [] };
  assertRejected(Object.create(proto), /renderL1 input must be a plain object/);
  assertRejected(Object.create(null), /missing required property "coreText"/);
  // Object.create(null) + 自有字段是合法的普通记录对象
  const nullProto = Object.create(null);
  nullProto.coreText = "x";
  nullProto.topics = [];
  assert.equal(renderL1(nullProto).text, "x");
  // 原型上携带完整字段的 Topic：自身无 own 字段，必填判定不过
  const inheritedTopic = Object.create(makeTopic());
  assertRejected(
    { coreText: "x", topics: [inheritedTopic] },
    /topics\[0\] must be a plain object|missing required property/,
  );
  // Object.prototype 污染不能弥补缺失的必填字段（own-property 判定）
  const saved = Object.prototype.summary;
  Object.prototype.summary = "污染摘要";
  try {
    const missing = makeTopic();
    delete missing.summary;
    assertRejected({ coreText: "x", topics: [missing] }, /missing required property "summary"/);
  } finally {
    delete Object.prototype.summary;
    assert.equal(saved, undefined);
  }
});
