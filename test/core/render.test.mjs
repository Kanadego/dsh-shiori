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

test("归档专题跳过索引条目，末尾出现 N 篇冷专题钩子行（global 与 amber scope 都生效）", () => {
  const result = renderL1({
    coreText: "## 铁律",
    topics: [
      makeTopic({ key: "warm-amber", scopeId: "amber", summary: "热专题" }),
      makeTopic({ key: "cold-a", scopeId: "amber", summary: "冷专题A", archivedAt: "2026-11-07T00:00:00.000Z" }),
      makeTopic({ key: "cold-g", scopeId: "global", summary: "冷专题G", archivedAt: "2026-11-06T00:00:00.000Z" }),
    ],
  });
  assert.ok(result.text.includes("- warm-amber [amber] — 热专题"));
  assert.ok(!result.text.includes("- cold-a"));
  assert.ok(!result.text.includes("冷专题A"), "归档专题 summary 不得出现在索引");
  assert.ok(result.text.endsWith("另有 2 篇冷专题，memory_search 可查"));
  assert.equal(result.indexText, `${HEADER}\n- warm-amber [amber] — 热专题\n另有 2 篇冷专题，memory_search 可查`);
});

test("N=0（无归档专题）时钩子行整行不出现，格式与旧版完全一致", () => {
  const result = renderL1({
    coreText: "## 铁律",
    topics: [makeTopic({ key: "warm", summary: "热专题" })],
  });
  assert.ok(!result.text.includes("冷专题"), "无归档时不出现钩子行");
  assert.equal(result.indexText, `${HEADER}\n- warm [global] — 热专题`);
});

test("全部 topic 已归档：索引只剩标题行与钩子行；空 topics + 无归档仍无索引", () => {
  const onlyArchived = renderL1({
    coreText: "",
    topics: [makeTopic({ key: "cold", summary: "冷", archivedAt: "2026-11-07T00:00:00.000Z" })],
  });
  assert.equal(onlyArchived.indexText, `${HEADER}\n另有 1 篇冷专题，memory_search 可查`);

  const none = renderL1({ coreText: "core", topics: [] });
  assert.equal(none.indexText, "");
});

test("archivedAt 非法形状（空串/非字符串/含换行）显式拒绝", () => {
  assertRejected({ coreText: "x", topics: [makeTopic({ archivedAt: "" })], }, /archivedAt/);
  assertRejected({ coreText: "x", topics: [makeTopic({ archivedAt: 7 })], }, /archivedAt/);
  assertRejected({ coreText: "x", topics: [makeTopic({ archivedAt: "a\nb" })], }, /archivedAt/);
});

// ---------- 0.5 批次 2 A 线：renderL1 组布局（input.groups 可选输入） ----------

function makeGroup(overrides = {}) {
  return {
    key: "dev",
    title: "开发与配置",
    summary: "",
    pinned: false,
    members: [],
    ...overrides,
  };
}

test("A-0.5 金样：独立 topic + 组摘要（带摘要）+ pinned 成员 + 冷钩子四类各≥1，逐字稳定", () => {
  const result = renderL1({
    coreText: "## 铁律\n正文",
    topics: [
      makeTopic({ key: "standalone", scopeId: "amber", summary: "独立活跃专题" }),
      makeTopic({ key: "gone", scopeId: "amber", summary: "冷专题", archivedAt: "2026-11-07T00:00:00.000Z" }),
    ],
    groups: [
      makeGroup({
        key: "dev",
        title: "开发与配置",
        summary: "工具与脚本",
        members: [
          { key: "member-hot", title: "热成员", summary: "钉住的热成员", pinned: true, archived: false },
          { key: "member-warm", title: "普通成员", summary: "不钉住", pinned: false, archived: false },
          { key: "member-cold", title: "冷成员", summary: "钉住但已归档", pinned: true, archived: true },
        ],
      }),
      makeGroup({
        key: "old",
        title: "全冷组",
        summary: "这组全归档了",
        members: [
          { key: "cold-1", summary: "冷", archived: true },
          { key: "cold-2", summary: "也冷", archived: true },
        ],
      }),
    ],
  });
  const expected = [
    "## 主题记忆索引 / Topic memory index",
    "- standalone [amber] — 独立活跃专题",
    "- group:dev — 开发与配置（3 名成员） — 工具与脚本",
    "  - member-hot — 钉住的热成员",
    "- group:old — 全冷组（2 篇冷专题，memory_search 可查）",
    "另有 1 篇冷专题，memory_search 可查",
  ].join("\n");
  assert.equal(result.indexText, expected);
  assert.equal(result.text, "## 铁律\n正文\n\n" + expected);
  // 归档成员（含 pinned 归档）不列行——冷内容不上索引
  assert.ok(!result.text.includes("member-cold"));
  assert.ok(!result.text.includes("冷成员"));
  // chars/bytes 口径不变（完整渲染计数）
  assert.equal(result.chars, result.text.length);
  assert.equal(result.bytes, Buffer.byteLength(result.text, "utf8"));
});

test("A-0.5 金样：组摘要无摘要时省略尾部，pinned 空摘要照渲染（与专题条目同规）", () => {
  const result = renderL1({
    coreText: "",
    topics: [],
    groups: [
      makeGroup({
        key: "g",
        title: "空摘要组",
        summary: "",
        members: [{ key: "m", title: "成员", summary: "", pinned: true, archived: false }],
      }),
    ],
  });
  assert.equal(result.indexText, [
    "## 主题记忆索引 / Topic memory index",
    "- group:g — 空摘要组（1 名成员）",
    "  - m — ",
  ].join("\n"));
});

test("A-0.5：groups 缺省 / undefined / 空数组时输出与旧版逐字节一致（回归零变化）", () => {
  const topics = [
    makeTopic({ key: "b", summary: "B" }),
    makeTopic({ key: "a", summary: "A" }),
    makeTopic({ key: "cold", summary: "冷", archivedAt: "2026-11-07T00:00:00.000Z" }),
  ];
  const legacy = renderL1({ coreText: "core", topics });
  assert.equal(renderL1({ coreText: "core", topics, groups: [] }).text, legacy.text);
  assert.equal(renderL1({ coreText: "core", topics, groups: [] }).bytes, legacy.bytes);
  assert.deepEqual(renderL1({ coreText: "core", topics, groups: [] }).indexText, legacy.indexText);
  // groups 键完全不存在（旧签名调用方）
  const withoutKey = { coreText: "core", topics };
  assert.equal(renderL1(withoutKey).text, legacy.text);
  // 空 core + 只有归档专题：钩子行位置不变（末尾）
  const hookOnly = renderL1({ coreText: "", topics: [makeTopic({ key: "c", archivedAt: "2026-11-08T00:00:00.000Z" })] });
  assert.equal(
    renderL1({ coreText: "", topics: [makeTopic({ key: "c", archivedAt: "2026-11-08T00:00:00.000Z" })], groups: [] }).indexText,
    hookOnly.indexText,
  );
});

test("A-0.5 顺序硬约束：topics/groups/members 全部打乱输入顺序 → 输出逐字节一致", () => {
  const topics = [
    makeTopic({ key: "beta", scopeId: "amber", summary: "B" }),
    makeTopic({ key: "alpha", scopeId: "amber", summary: "A" }),
    makeTopic({ key: "mid", scopeId: "global", summary: "M" }),
    makeTopic({ key: "cold", scopeId: "amber", summary: "冷", archivedAt: "2026-11-07T00:00:00.000Z" }),
  ];
  const groups = [
    makeGroup({
      key: "zeta",
      title: "Z组",
      summary: "最后",
      members: [
        { key: "m2", summary: "成员2", pinned: true, archived: false },
        { key: "m1", summary: "成员1", pinned: true, archived: false },
        { key: "m3", summary: "不钉", pinned: false, archived: false },
      ],
    }),
    makeGroup({
      key: "alpha-g",
      title: "A组",
      summary: "第一",
      members: [
        { key: "p1", summary: "钉住", pinned: true, archived: false },
        { key: "p2", summary: "也钉住", pinned: true, archived: false },
      ],
    }),
    makeGroup({
      key: "coldg",
      title: "冷组",
      members: [
        { key: "c2", summary: "冷2", archived: true },
        { key: "c1", summary: "冷1", archived: true },
      ],
    }),
  ];
  const first = renderL1({ coreText: "core text", topics, groups });
  // 倒序 + 多组洗牌（多轮不同排列），每组内部成员也乱序
  const shuffles = [
    [...topics].reverse(),
    [topics[2], topics[0], topics[3], topics[1]],
    [topics[3], topics[1], topics[2], topics[0]],
  ];
  const groupShuffles = [
    [...groups].reverse(),
    [groups[2], groups[0], groups[1]],
    [groups[1], groups[2], groups[0]],
  ];
  for (let i = 0; i < shuffles.length; i++) {
    const again = renderL1({
      coreText: "core text",
      topics: shuffles[i],
      groups: groupShuffles[i].map((g) => ({ ...g, members: [...g.members].reverse() })),
    });
    assert.equal(again.text, first.text, `第 ${i} 轮打乱后输出必须逐字节一致`);
    assert.equal(again.indexText, first.indexText);
    assert.equal(again.bytes, first.bytes);
  }
  // 组内成员行同样按 key 字典序（m1 < m2），与输入顺序无关
  assert.ok(first.text.indexOf("  - m1 — 成员1") < first.text.indexOf("  - m2 — 成员2"));
  // 组行按 key 字典序：alpha-g < coldg < zeta；独立 topic 行先于全部组行
  const lines = first.indexText.split("\n");
  assert.equal(lines[1], "- alpha [amber] — A");
  assert.equal(lines[2], "- beta [amber] — B");
  assert.equal(lines[3], "- mid [global] — M");
  assert.equal(lines[4], "- group:alpha-g — A组（2 名成员） — 第一");
  assert.equal(lines[5], "  - p1 — 钉住");
  assert.equal(lines[6], "  - p2 — 也钉住");
  assert.equal(lines[7], "- group:coldg — 冷组（2 篇冷专题，memory_search 可查）");
});

test("A-0.5：组条目 order/retention 等未知字段容忍透传，不参与排序（顺序仍按 key）", () => {
  const result = renderL1({
    coreText: "",
    topics: [],
    groups: [
      makeGroup({ key: "b", title: "B组", order: 10, retention: "historical", extra: "随便" }),
      makeGroup({ key: "a", title: "A组", order: 99 }),
    ],
  });
  const lines = result.indexText.split("\n").slice(1);
  assert.deepEqual(lines, ["- group:a — A组（0 名成员）", "- group:b — B组（0 名成员）"]);
});

test("A-0.5：只有组没有 topic 时索引照常出现（标题 + 组行），无 topic 无归档无组仍无索引", () => {
  const onlyGroups = renderL1({
    coreText: "core",
    topics: [],
    groups: [makeGroup({ key: "g", title: "组", members: [] })],
  });
  assert.ok(onlyGroups.text.startsWith("core\n\n## 主题记忆索引"));
  const empty = renderL1({ coreText: "core", topics: [], groups: [] });
  assert.equal(empty.text, "core");
  assert.equal(empty.indexText, "");
});

test("A-0.5：部分归档的组仍走活跃组摘要行，全局归档钩子行保持在索引末尾", () => {
  const result = renderL1({
    coreText: "",
    topics: [makeTopic({ key: "gone", summary: "冷", archivedAt: "2026-11-07T00:00:00.000Z" })],
    groups: [
      makeGroup({
        key: "mixed",
        title: "混合组",
        members: [
          { key: "hot", summary: "热", archived: false },
          { key: "cold", summary: "冷", archived: true },
        ],
      }),
    ],
  });
  const lines = result.indexText.split("\n").slice(1);
  assert.deepEqual(lines, [
    "- group:mixed — 混合组（2 名成员）",
    "另有 1 篇冷专题，memory_search 可查",
  ]);
  // 部分归档组没有组级冷钩子（归档成员可发现性由全局钩子承担）
  assert.ok(!result.text.includes("- group:mixed — 混合组（2 篇冷专题"));
});

// ---------- 0.5 债收口 R1：topic 行与组内 member 行同 key 去重 ----------

test("A-0.5 R1 债收口：同 key 已有 topic 行时不再输出成员行（topic 行为准），组照常渲染其它成员", () => {
  const result = renderL1({
    coreText: "",
    topics: [
      makeTopic({ key: "shared", scopeId: "amber", summary: "topic 行摘要" }),
      makeTopic({ key: "solo", scopeId: "amber", summary: "独立专题" }),
    ],
    groups: [
      makeGroup({
        key: "dev",
        title: "开发与配置",
        members: [
          { key: "shared", summary: "成员行摘要", pinned: true, archived: false },
          { key: "other", summary: "其它成员", pinned: true, archived: false },
          { key: "plain", summary: "不钉成员", pinned: false, archived: false },
        ],
      }),
    ],
  });
  const lines = result.indexText.split("\n");
  assert.deepEqual(lines, [
    "## 主题记忆索引 / Topic memory index",
    "- shared [amber] — topic 行摘要",
    "- solo [amber] — 独立专题",
    "- group:dev — 开发与配置（3 名成员）",
    "  - other — 其它成员",
  ]);
  // 成员行形态不得出现；该 key 在 L1 只出现一次（topic 行）
  assert.ok(!result.text.includes("  - shared"), "同 key 成员行必须被去重");
  assert.equal(result.text.split("- shared").length - 1, 1, "同 key 在 L1 只出现一次");
  // 组行「N 名成员」是数据真相：去重只影响行，不改计数
  assert.ok(result.text.includes("- group:dev — 开发与配置（3 名成员）"));
});

test("A-0.5 R1 债收口：指向已归档或不存在 topic 的成员行照常输出（无 topic 行可冲突，口径不变）", () => {
  const result = renderL1({
    coreText: "",
    topics: [
      makeTopic({ key: "gone", scopeId: "amber", summary: "冷专题", archivedAt: "2026-11-07T00:00:00.000Z" }),
    ],
    groups: [
      makeGroup({
        key: "dev",
        title: "开发与配置",
        members: [
          { key: "ghost", summary: "指向不存在 topic 的成员", pinned: true, archived: false },
          { key: "gone", summary: "指向已归档 topic 的成员", pinned: true, archived: false },
        ],
      }),
    ],
  });
  const lines = result.indexText.split("\n");
  assert.deepEqual(lines, [
    "## 主题记忆索引 / Topic memory index",
    "- group:dev — 开发与配置（2 名成员）",
    "  - ghost — 指向不存在 topic 的成员",
    "  - gone — 指向已归档 topic 的成员",
    "另有 1 篇冷专题，memory_search 可查",
  ]);
});

test("A-0.5 R1 债收口：同 key 兼属多组且已有 topic 行时，任何一组都不再输出成员行", () => {
  const result = renderL1({
    coreText: "",
    topics: [makeTopic({ key: "dup", scopeId: "global", summary: "topic 行" })],
    groups: [
      makeGroup({ key: "a", title: "A组", members: [{ key: "dup", summary: "A 组成员", pinned: true, archived: false }] }),
      makeGroup({ key: "b", title: "B组", members: [{ key: "dup", summary: "B 组成员", pinned: true, archived: false }] }),
    ],
  });
  const lines = result.indexText.split("\n");
  assert.deepEqual(lines, [
    "## 主题记忆索引 / Topic memory index",
    "- dup [global] — topic 行",
    "- group:a — A组（1 名成员）",
    "- group:b — B组（1 名成员）",
  ]);
});

test("A-0.5：groups 形状违规全部 INVALID_INPUT（非数组/孔/缺 key/缺 title/重复组 key/成员缺 key/成员重复/换行摘要/坏布尔/坏 key）", () => {
  assert.throws(() => renderL1({ coreText: "x", topics: [], groups: "no" }),
    (e) => e.code === "INVALID_INPUT" && /groups must be an array/.test(e.message));
  assert.throws(() => renderL1({ coreText: "x", topics: [], groups: [null] }),
    (e) => e.code === "INVALID_INPUT" && /groups\[0\] must be a plain object/.test(e.message));
  assert.throws(() => renderL1({ coreText: "x", topics: [], groups: [(() => { const g = makeGroup(); delete g.key; return g; })()] }),
    (e) => e.code === "INVALID_INPUT" && /missing required property "key"/.test(e.message));
  assert.throws(() => renderL1({ coreText: "x", topics: [], groups: [makeGroup({ key: undefined })] }),
    (e) => e.code === "INVALID_INPUT" && /key must be a non-empty string/.test(e.message));
  assert.throws(() => renderL1({ coreText: "x", topics: [], groups: [makeGroup({ title: "" })] }),
    (e) => e.code === "INVALID_INPUT" && /title must be a non-empty string/.test(e.message));
  assert.throws(() => renderL1({ coreText: "x", topics: [], groups: [makeGroup(), makeGroup()] }),
    (e) => e.code === "INVALID_INPUT" && /duplicate group key "dev"/.test(e.message));
  assert.throws(() => renderL1({
    coreText: "x", topics: [],
    groups: [makeGroup({ members: [{ summary: "缺 key" }] })],
  }), (e) => e.code === "INVALID_INPUT" && /members\[0\] is missing required property "key"/.test(e.message));
  assert.throws(() => renderL1({
    coreText: "x", topics: [],
    groups: [makeGroup({ members: [{ key: "m" }, { key: "m" }] })],
  }), (e) => e.code === "INVALID_INPUT" && /duplicate member key "m"/.test(e.message));
  assert.throws(() => renderL1({
    coreText: "x", topics: [],
    groups: [makeGroup({ summary: "a\nb" })],
  }), (e) => e.code === "INVALID_INPUT" && /summary must not contain line breaks/.test(e.message));
  assert.throws(() => renderL1({
    coreText: "x", topics: [],
    groups: [makeGroup({ members: [{ key: "m", summary: "a\nb" }] })],
  }), (e) => e.code === "INVALID_INPUT" && /summary must not contain line breaks/.test(e.message));
  assert.throws(() => renderL1({
    coreText: "x", topics: [],
    groups: [makeGroup({ pinned: "yes" })],
  }), (e) => e.code === "INVALID_INPUT" && /pinned must be a boolean/.test(e.message));
  assert.throws(() => renderL1({
    coreText: "x", topics: [],
    groups: [makeGroup({ members: [{ key: "m", archived: 1 }] })],
  }), (e) => e.code === "INVALID_INPUT" && /archived must be a boolean/.test(e.message));
  assert.throws(() => renderL1({
    coreText: "x", topics: [],
    groups: [makeGroup({ key: "bad/key" })],
  }), (e) => e.code === "INVALID_INPUT" && /forbidden filename character/.test(e.message));
  // 未知键仍拒绝（renderL1 input 顶层），组/成员条目内部未知键容忍
  assert.throws(() => renderL1({ coreText: "x", topics: [], groups: [], extra: 1 }),
    (e) => e.code === "INVALID_INPUT" && /unknown property "extra"/.test(e.message));
  // members 非数组
  assert.throws(() => renderL1({ coreText: "x", topics: [], groups: [makeGroup({ members: "no" })] }),
    (e) => e.code === "INVALID_INPUT" && /members must be an array/.test(e.message));
});

test("A-0.5：超预算大组摘要照渲染（本函数不做预算裁决，口径与旧版一致）", () => {
  const big = "x".repeat(20000);
  const result = renderL1({
    coreText: "",
    topics: [],
    groups: [makeGroup({ key: "big", title: "大组", summary: big })],
  });
  assert.equal(result.chars, result.text.length);
  assert.ok(result.text.includes(big));
});
