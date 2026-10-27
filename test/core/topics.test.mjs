import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVisibleTopics } from "../../src/core/topics.mjs";

function makeTopic(overrides = {}) {
  return {
    key: "onion",
    title: "洋葱梗",
    summary: "问眼里常含泪水，原来刚切过洋葱。",
    scopeId: "global",
    revision: "rev-global-1",
    updated: "2026-10-16T22:10:00+08:00",
    body: "一段正文。",
    ...overrides,
  };
}

function assertRejected(input, pattern) {
  assert.throws(
    () => selectVisibleTopics(input),
    (error) => {
      assert.equal(error.code, "INVALID_INPUT");
      if (pattern) assert.match(error.message, pattern);
      return true;
    },
  );
}

test("active topic overrides global topic with the same key", () => {
  const globalTopic = makeTopic({ revision: "rev-global-1" });
  const activeTopic = makeTopic({ scopeId: "amber", revision: "rev-amber-1" });
  const result = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [globalTopic, activeTopic],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].revision, "rev-amber-1");
  assert.equal(result[0], activeTopic);
});

test("topics from a third scope are invisible", () => {
  const result = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [
      makeTopic({ key: "shared", scopeId: "global", summary: "全局版本" }),
      makeTopic({ key: "shared", scopeId: "amber", summary: "示例版本" }),
      makeTopic({ key: "shared", scopeId: "other-card", summary: "别的卡的版本" }),
      makeTopic({ key: "private-other", scopeId: "other-card" }),
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "shared");
  assert.equal(result[0].summary, "示例版本");
});

test("global topics without an active override stay visible", () => {
  const result = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [
      makeTopic({ key: "alpha", scopeId: "global" }),
      makeTopic({ key: "beta", scopeId: "amber" }),
      makeTopic({ key: "gamma", scopeId: "elsewhere" }),
    ],
  });
  assert.deepEqual(result.map((t) => t.key), ["alpha", "beta"]);
});

test("activeScopeId 'global' yields a global-only view", () => {
  const result = selectVisibleTopics({
    activeScopeId: "global",
    topics: [
      makeTopic({ key: "shared", scopeId: "global", summary: "全局版本" }),
      makeTopic({ key: "shared", scopeId: "amber", summary: "示例版本" }),
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].summary, "全局版本");
});

test("result is sorted by key in UTF-16 code-unit order, not locale order", () => {
  const result = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [
      makeTopic({ key: "b", scopeId: "amber" }),
      makeTopic({ key: "A", scopeId: "amber" }),
      makeTopic({ key: "中", scopeId: "amber" }),
      makeTopic({ key: "a", scopeId: "amber" }),
      makeTopic({ key: "B", scopeId: "amber" }),
      makeTopic({ key: "0", scopeId: "amber" }),
    ],
  });
  // 码元序：数字 < 大写 < 小写 < CJK；localeCompare 会给出不同顺序
  assert.deepEqual(result.map((t) => t.key), ["0", "A", "B", "a", "b", "中"]);
});

test("returns topic object references and does not mutate the input array", () => {
  const t1 = makeTopic({ key: "z", scopeId: "amber" });
  const t2 = makeTopic({ key: "a", scopeId: "amber" });
  const topics = [t1, t2];
  const result = selectVisibleTopics({ activeScopeId: "amber", topics });
  assert.equal(result[0], t2);
  assert.equal(result[1], t1);
  assert.deepEqual(topics.map((t) => t.key), ["z", "a"]);
});

test("empty topics list yields an empty result", () => {
  assert.deepEqual(selectVisibleTopics({ activeScopeId: "amber", topics: [] }), []);
});

test("same key in different scopes is allowed as long as scopes differ", () => {
  const result = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [
      makeTopic({ key: "x", scopeId: "amber" }),
      makeTopic({ key: "x", scopeId: "global" }),
      makeTopic({ key: "x", scopeId: "third" }),
      makeTopic({ key: "x", scopeId: "fourth" }),
    ],
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].scopeId, "amber");
});

test("duplicate key within the same scope is rejected, including invisible scopes", () => {
  assertRejected(
    { activeScopeId: "amber", topics: [makeTopic({ key: "x", scopeId: "amber" }), makeTopic({ key: "x", scopeId: "amber", title: "第二份" })] },
    /duplicate topic key "x" within scope "amber"/,
  );
  assertRejected(
    { activeScopeId: "amber", topics: [makeTopic({ key: "x", scopeId: "global" }), makeTopic({ key: "x", scopeId: "global", title: "第二份" })] },
    /duplicate topic key "x" within scope "global"/,
  );
  assertRejected(
    { activeScopeId: "amber", topics: [makeTopic({ key: "x", scopeId: "third" }), makeTopic({ key: "x", scopeId: "third", title: "第二份" })] },
    /duplicate topic key "x" within scope "third"/,
  );
});

test("invalid activeScopeId is rejected", () => {
  const topics = [makeTopic()];
  assertRejected({ topics }, /missing required property "activeScopeId"/);
  assertRejected({ activeScopeId: "", topics }, /activeScopeId must be a non-empty string/);
  assertRejected({ activeScopeId: 42, topics }, /activeScopeId must be a non-empty string/);
  assertRejected({ activeScopeId: " amber", topics }, /must not start or end with whitespace/);
  assertRejected({ activeScopeId: "am\nber", topics }, /control characters/);
});

test("malformed input object is rejected", () => {
  assertRejected(undefined, /must be a plain object/);
  assertRejected(null, /must be a plain object/);
  assertRejected({ activeScopeId: "amber" }, /missing required property "topics"/);
  assertRejected({ activeScopeId: "amber", topics: "not-array" }, /topics must be an array/);
  assertRejected({ activeScopeId: "amber", topics: [], extra: 1 }, /unknown property "extra"/);
});

test("all input topics are validated, even invisible ones", () => {
  assertRejected(
    { activeScopeId: "amber", topics: [makeTopic({ key: "x", scopeId: "third", summary: "a".repeat(61) })] },
    /summary is 61 UTF-16 chars, max is 60/,
  );
  assertRejected(
    { activeScopeId: "amber", topics: [makeTopic({ key: "x", scopeId: "third" }), null] },
    /topics\[1\] must be a plain object/,
  );
});

test("topic metadata violations are rejected with INVALID_INPUT", () => {
  const cases = [
    [{ key: "CON" }, /Windows reserved device name/],
    [{ title: "" }, /title must be a non-empty string/],
    [{ title: 5 }, /title must be a non-empty string/],
    [{ summary: 7 }, /summary must be a string/],
    [{ summary: "a".repeat(61) }, /summary is 61/],
    [{ summary: "line1\nline2" }, /line breaks/],
    [{ scopeId: "" }, /scopeId must be a non-empty string/],
    [{ revision: "" }, /revision must be a non-empty string/],
    [{ revision: 1 }, /revision must be a non-empty string/],
    [{ updated: undefined }, /updated/],
    [{ updated: "" }, /updated/],
    [{ updated: NaN }, /updated/],
    [{ body: 42 }, /body must be a string/],
  ];
  for (const [overrides, pattern] of cases) {
    assertRejected({ activeScopeId: "amber", topics: [makeTopic(overrides)] }, pattern);
  }
});

test("missing required topic fields are reported", () => {
  for (const field of ["key", "title", "summary", "scopeId", "revision", "updated"]) {
    const topic = makeTopic();
    delete topic[field];
    assertRejected(
      { activeScopeId: "amber", topics: [topic] },
      new RegExp(`missing required property "${field}"`),
    );
  }
});

test("updated accepts ISO string, timestamp number and Date", () => {
  for (const updated of ["2026-10-16T22:10:00+08:00", 1760629800000, new Date("2026-10-16T14:10:00Z")]) {
    const result = selectVisibleTopics({
      activeScopeId: "amber",
      topics: [makeTopic({ key: "k", scopeId: "amber", updated })],
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].updated, updated);
  }
});

test("invalid Date is rejected for updated", () => {
  assertRejected(
    { activeScopeId: "amber", topics: [makeTopic({ key: "k", scopeId: "amber", updated: new Date("not-a-date") })] },
    /updated must be a non-empty string, a finite number, or a valid Date/,
  );
});

test("R2 regression: sparse topic arrays are rejected, not silently skipped", () => {
  assertRejected(
    { activeScopeId: "global", topics: new Array(1) },
    /topics\[0\] must be a plain object/,
  );
  assertRejected(
    { activeScopeId: "amber", topics: new Array(2) },
    /topics\[0\] must be a plain object/,
  );
  // 混合孔：合法条目 + 孔
  const sparse = [makeTopic({ key: "a", scopeId: "amber" })];
  sparse[2] = makeTopic({ key: "b", scopeId: "amber" });
  assertRejected(
    { activeScopeId: "amber", topics: sparse },
    /topics\[1\] must be a plain object/,
  );
  assertRejected(
    { activeScopeId: "amber", topics: [makeTopic(), undefined] },
    /topics\[1\] must be a plain object/,
  );
  // 密集合法数组与空数组仍正常
  selectVisibleTopics({
    activeScopeId: "amber",
    topics: [makeTopic({ key: "a", scopeId: "amber" }), makeTopic({ key: "b", scopeId: "amber" })],
  });
  assert.deepEqual(selectVisibleTopics({ activeScopeId: "amber", topics: [] }), []);
});

test("R3 regression: topics with only inherited fields are rejected", () => {
  const base = makeTopic();
  // 全部字段都在原型上：既不是普通记录对象，也没有自有必填字段
  const inherited = Object.create(base);
  assertRejected(
    { activeScopeId: "amber", topics: [inherited] },
    /topics\[0\] must be a plain object/,
  );
  // Object.prototype 污染不能让缺失的必填字段通过（own-property 判定）
  const saved = Object.prototype.revision;
  Object.prototype.revision = "polluted";
  try {
    const missing = makeTopic();
    delete missing.revision;
    assertRejected(
      { activeScopeId: "amber", topics: [missing] },
      /missing required property "revision"/,
    );
  } finally {
    delete Object.prototype.revision;
    assert.equal(saved, undefined);
  }
});

test("R3 regression: Object.create(null) topics with own fields are valid records", () => {
  const topic = Object.create(null);
  topic.key = "nullproto";
  topic.title = "T";
  topic.summary = "S";
  topic.scopeId = "amber";
  topic.revision = "r";
  topic.updated = "2026-01-01";
  const result = selectVisibleTopics({ activeScopeId: "amber", topics: [topic] });
  assert.equal(result.length, 1);
  assert.equal(result[0].key, "nullproto");
});

test("unknown extra fields on topics are tolerated (data forward-compatibility)", () => {
  const topic = makeTopic({ key: "k", scopeId: "amber", archived: false });
  const result = selectVisibleTopics({ activeScopeId: "amber", topics: [topic] });
  assert.equal(result[0].archived, false);
});
