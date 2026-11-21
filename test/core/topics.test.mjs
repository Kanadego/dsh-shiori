import { test } from "node:test";
import assert from "node:assert/strict";
import { selectVisibleTopics, groupSoftLimitWarning, GROUP_SOFT_LIMIT } from "../../src/core/topics.mjs";
import { renderL1 } from "../../src/core/render.mjs";

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

test("archivedAt 归档标记：合法 ISO 串可通过校验并透传；非法形状显式拒绝", () => {
  const ok = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [makeTopic({ key: "cold", scopeId: "amber", archivedAt: "2026-11-07T00:00:00.000Z" })],
  });
  assert.equal(ok[0].archivedAt, "2026-11-07T00:00:00.000Z");

  // 老文件没有该字段 = 未归档，行为不变
  const old = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [makeTopic({ key: "warm", scopeId: "amber" })],
  });
  assert.equal(old[0].archivedAt, undefined);

  // 归档与否不影响 scope 可见性（归档专题仍参与 active 覆盖 global 的去重）
  const dedup = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [
      makeTopic({ key: "k", scopeId: "global", archivedAt: "2026-11-07T00:00:00.000Z" }),
      makeTopic({ key: "k", scopeId: "amber" }),
    ],
  });
  assert.equal(dedup.length, 1);
  assert.equal(dedup[0].scopeId, "amber");
  assert.equal(dedup[0].archivedAt, undefined);

  for (const bad of ["", 123, "a\nb"]) {
    assert.throws(
      () => selectVisibleTopics({ activeScopeId: "amber", topics: [makeTopic({ key: "bad", scopeId: "amber", archivedAt: bad })] }),
      (error) => error.code === "INVALID_INPUT" && /archivedAt/.test(error.message),
    );
  }
});

// ---------- 0.4 S3：group/pinned 分组元数据（可选字段） ----------

test("S3: group/pinned 可选字段通过校验并原样透传（首个是主组）", () => {
  const topic = makeTopic({ key: "grouped", scopeId: "amber", group: ["dev", "self"], pinned: true });
  const result = selectVisibleTopics({ activeScopeId: "amber", topics: [topic] });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].group, ["dev", "self"]);
  assert.equal(result[0].pinned, true);
  // 主组 = 首个元素：核心层只透传数组，不重排、不拆主组
  assert.equal(result[0].group[0], "dev");
});

test("S3: 老数据没有 group/pinned 字段时行为不变，读取不注入默认值", () => {
  const topic = makeTopic({ key: "legacy", scopeId: "amber" });
  const result = selectVisibleTopics({ activeScopeId: "amber", topics: [topic] });
  assert.equal(result[0].group, undefined);
  assert.equal(result[0].pinned, undefined);
});

test("S3: group 形状违规被拒绝（非数组/空元素/坏 key/重复）", () => {
  const cases = [
    [{ group: "dev" }, /group must be an array/],
    [{ group: 42 }, /group must be an array/],
    [{ group: [42] }, /group\[0\] must be a non-empty string/],
    [{ group: [""] }, /group\[0\] must be a non-empty string/],
    [{ group: ["a", "a"] }, /duplicate key "a"/],
    [{ group: ["dev", "bad<key"] }, /group\[1\]/],
    [{ group: ["dev", ""] }, /group\[1\] must be a non-empty string/],
  ];
  for (const [overrides, pattern] of cases) {
    assertRejected(
      { activeScopeId: "amber", topics: [makeTopic({ key: "g", scopeId: "amber", ...overrides })] },
      pattern,
    );
  }
});

test("S3: pinned 只接受布尔值", () => {
  for (const bad of [1, "true", null, 0]) {
    assertRejected(
      { activeScopeId: "amber", topics: [makeTopic({ key: "p", scopeId: "amber", pinned: bad })] },
      /pinned must be a boolean/,
    );
  }
  // pinned: false 合法（显式不钉住）
  const ok = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [makeTopic({ key: "p", scopeId: "amber", pinned: false })],
  });
  assert.equal(ok[0].pinned, false);
});

test("S3: group 软上限超 3 个组不拒绝，只给提示文案", () => {
  assert.equal(GROUP_SOFT_LIMIT, 3);
  // 4 组：校验通过（软约束不拒绝）
  const four = makeTopic({ key: "g4", scopeId: "amber", group: ["a", "b", "c", "d"] });
  const result = selectVisibleTopics({ activeScopeId: "amber", topics: [four] });
  assert.equal(result.length, 1);
  assert.match(groupSoftLimitWarning(four), /软上限 3/);
  assert.match(groupSoftLimitWarning(four), /主组为 "a"/);
  // 3 组与未分组：无提示
  const three = makeTopic({ key: "g3", scopeId: "amber", group: ["a", "b", "c"] });
  assert.equal(groupSoftLimitWarning(three), null);
  assert.equal(groupSoftLimitWarning(makeTopic({ key: "g0", scopeId: "amber" })), null);
});

test("S3: L1 渲染结果与 0.3.1 完全一致（group/pinned 不参与渲染）", () => {
  const base = [
    makeTopic({ key: "a", scopeId: "amber" }),
    makeTopic({ key: "b", scopeId: "amber" }),
    makeTopic({ key: "c", scopeId: "global", archivedAt: "2026-11-07T00:00:00.000Z" }),
  ];
  const without = renderL1({ coreText: "正文。", topics: base });
  const withMeta = base.map((t) => ({ ...t, group: ["dev", "self"], pinned: true }));
  const withIt = renderL1({ coreText: "正文。", topics: withMeta });
  assert.equal(withIt.text, without.text);
  assert.equal(withIt.chars, without.chars);
  assert.deepEqual(withIt.indexText, without.indexText);
});

// ---------- 0.5 批次 2 A 线：retention / archiveOrigin 保留策略字段 ----------

test("A-0.5: retention/archiveOrigin 合法枚举值通过校验并原样透传", () => {
  const result = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [
      makeTopic({ key: "hist", scopeId: "amber", retention: "historical" }),
      makeTopic({ key: "auto", scopeId: "amber", archiveOrigin: "auto-inactive" }),
      makeTopic({ key: "both", scopeId: "amber", retention: "standing", archiveOrigin: "manual" }),
    ],
  });
  assert.equal(result.length, 3);
  assert.equal(result.find((t) => t.key === "hist").retention, "historical");
  assert.equal(result.find((t) => t.key === "auto").archiveOrigin, "auto-inactive");
  assert.equal(result.find((t) => t.key === "both").retention, "standing");
});

test("A-0.5: 老数据没有 retention/archiveOrigin 字段时行为不变，校验层不注入默认值", () => {
  // 与 S3 group/pinned 同规：核心校验层只验形状，不注入、不回写；
  // 缺省值注入由 frontmatter 读取侧承担（frontmatter.test.mjs 覆盖）。
  const result = selectVisibleTopics({
    activeScopeId: "amber",
    topics: [makeTopic({ key: "legacy", scopeId: "amber" })],
  });
  assert.equal(result[0].retention, undefined);
  assert.equal(result[0].archiveOrigin, undefined);
});

test("A-0.5: retention 非法值一律 INVALID_INPUT（含 null 与类型错），不许静默纠正", () => {
  const cases = ["bogus", "STANDING", "", 42, true, null];
  for (const bad of cases) {
    assertRejected(
      { activeScopeId: "amber", topics: [makeTopic({ key: "bad", scopeId: "amber", retention: bad })] },
      /retention must be one of/,
    );
  }
});

test("A-0.5: archiveOrigin 非法值一律 INVALID_INPUT（含 null 与类型错），不许静默纠正", () => {
  const cases = ["bogus", "MANUAL", "", 7, false, null];
  for (const bad of cases) {
    assertRejected(
      { activeScopeId: "amber", topics: [makeTopic({ key: "bad", scopeId: "amber", archiveOrigin: bad })] },
      /archiveOrigin must be one of/,
    );
  }
});

test("A-0.5: renderL1 拒绝非法保留策略值（核心校验共用）", () => {
  assert.throws(
    () => renderL1({ coreText: "x", topics: [makeTopic({ key: "bad", scopeId: "amber", retention: "frozen" })] }),
    (error) => error.code === "INVALID_INPUT" && /retention must be one of/.test(error.message),
  );
  assert.throws(
    () => renderL1({ coreText: "x", topics: [makeTopic({ key: "bad", scopeId: "amber", archiveOrigin: "auto" })] }),
    (error) => error.code === "INVALID_INPUT" && /archiveOrigin must be one of/.test(error.message),
  );
});

test("A-0.5: resolveRetention 组默认值 + topic 显式值覆盖组 + 双缺省回 standing", () => {
  // topic 显式值覆盖组策略
  assert.equal(resolveRetention({ retention: "standing" }, { retention: "historical" }), "standing");
  assert.equal(resolveRetention({ retention: "historical" }, { retention: "standing" }), "historical");
  // topic 缺省 → 组策略生效（组默认值语义）
  assert.equal(resolveRetention({}, { retention: "historical" }), "historical");
  // 双缺省 → standing
  assert.equal(resolveRetention({}, {}), "standing");
  assert.equal(resolveRetention({}, undefined), "standing");
  assert.equal(resolveRetention(undefined, undefined), "standing");
  // 组条目缺 retention 键（老清单形状）→ 回 standing
  assert.equal(resolveRetention({}, { key: "dev", title: "T", summary: "", order: 10 }), "standing");
  // null 组条目容忍（调用方未取到组时的形状）
  assert.equal(resolveRetention({}, null), "standing");
});

test("A-0.5: resolveRetention 组策略非法值拒绝（INVALID_INPUT），topic 非法值同样拒绝", () => {
  assert.throws(
    () => resolveRetention({}, { retention: "bogus" }),
    (error) => error.code === "INVALID_INPUT" && /group retention policy must be one of/.test(error.message),
  );
  assert.throws(
    () => resolveRetention({}, { retention: 42 }),
    (error) => error.code === "INVALID_INPUT" && /group retention policy must be one of/.test(error.message),
  );
  // topic 显式值非法不被组策略掩盖
  assert.throws(
    () => resolveRetention({ retention: "nope" }, { retention: "historical" }),
    (error) => error.code === "INVALID_INPUT" && /topic retention must be one of/.test(error.message),
  );
});

// 本段补充导入（ESM 顶层 import 提升生效；不改动上方既有 import 区，保持既有行零改动）
import { resolveRetention } from "../../src/core/topics.mjs";
