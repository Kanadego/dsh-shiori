// Shiori P2-L2 · matchSparks 确定性检索测试（合成，纯函数，无磁盘/无 store）。
// 覆盖 tasks/H.md 必测反例：非用户正文无扫描、多触发词/NFC/大小写/英文
// 词边界/别名、3+2 截断与防饿死、seen 锚点、1 跳边界、泛化 entity、
// archived/异 scope/redirect 排除、稳定排序与入参校验。

import test from "node:test";
import assert from "node:assert/strict";
import { matchSparks, seenKeyFor, MAX_ANCHORS } from "../../src/sparks/match.mjs";

const SCOPE = "amber";
const SESSION = "sess-1";
const EPOCH = 0;

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

function ids(result, key) {
  return result[key].map((item) => item.id);
}

function seenKeysOf(cards, { sessionId = SESSION, contextEpoch = EPOCH } = {}) {
  return cards.map((c) => seenKeyFor({
    scopeId: SCOPE, sessionId, contextEpoch, sparkId: c.id, revision: c.revision,
  }));
}

// ---------------------------------------------------------------------------
// 非用户正文：system/assistant/tool/历史/插件附件必须无扫描结果
// ---------------------------------------------------------------------------

test("非 user 角色消息一律无扫描结果", () => {
  const sparks = [card({ id: "a", triggers: ["洋葱"] })];
  for (const role of ["system", "assistant", "tool", "history", "plugin-attachment"]) {
    const result = matchSparks({
      scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
      userText: { role, text: "洋葱" }, sparks,
    });
    assert.deepEqual({ seeds: result.seeds, related: result.related, anchors: result.anchors },
      { seeds: [], related: [], anchors: [] }, `role=${role} 不应产生扫描结果`);
  }
});

test("user 角色消息对象正常扫描；空正文无结果", () => {
  const sparks = [card({ id: "a", triggers: ["洋葱"] })];
  const hit = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: { role: "user", text: "说说洋葱" }, sparks,
  });
  assert.deepEqual(ids(hit, "seeds"), ["a"]);
  const empty = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "", sparks,
  });
  assert.deepEqual(ids(empty, "seeds"), []);
});

// ---------------------------------------------------------------------------
// 触发词匹配：多触发词、NFC、大小写、英文词边界、显式别名
// ---------------------------------------------------------------------------

test("多触发词取最长命中者参与排序；任意一个命中即可唤醒", () => {
  const sparks = [
    card({ id: "short", triggers: ["洋葱", "泪"] }),
    card({ id: "long", triggers: ["眼里常含泪水"] }),
  ];
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱？眼里常含泪水？", sparks,
  });
  // 两卡都命中；"眼里常含泪水"(6) 长于 "洋葱"(2) 与 "泪"(1)，long 第一。
  assert.deepEqual(ids(result, "seeds"), ["long", "short"]);
  assert.equal(result.seeds[1].trigger, "洋葱");
});

test("NFC 归一化：分解形态的片假名命中组合形态的触发词", () => {
  const composed = "ガイド"; // U+30AC 组合形态
  const decomposed = "カ\u3099イド"; // U+30AB + U+3099
  const sparks = [card({ id: "g", triggers: [composed] })];
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: `这是${decomposed}吗`, sparks,
  });
  assert.deepEqual(ids(result, "seeds"), ["g"]);
});

test("英文大小写折叠命中，原文不改", () => {
  const sparks = [card({ id: "e", triggers: ["Onion"] })];
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "the ONION is here", sparks,
  });
  assert.deepEqual(ids(result, "seeds"), ["e"]);
  assert.equal(result.seeds[0].trigger, "Onion");
});

test("英文词边界：cat 不命中 concatenate，可命中独立词", () => {
  const sparks = [card({ id: "cat", triggers: ["cat"] })];
  const miss = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "concatenate the list", sparks,
  });
  assert.deepEqual(ids(miss, "seeds"), []);
  const hit = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "a cat!", sparks,
  });
  assert.deepEqual(ids(hit, "seeds"), ["cat"]);
});

test("显式别名（谐音/外号）正常唤醒", () => {
  const sparks = [card({ id: "alias", triggers: ["小葱", "洋葱精"] })];
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "小葱上线了吗", sparks,
  });
  assert.deepEqual(ids(result, "seeds"), ["alias"]);
});

// ---------------------------------------------------------------------------
// 稳定排序与 3+2 截断
// ---------------------------------------------------------------------------

test("最长 trigger 优先，平局按 id 升序", () => {
  const sparks = [
    card({ id: "b", triggers: ["泪"] }),
    card({ id: "a", triggers: ["泪"] }),
    card({ id: "c", triggers: ["眼里常含泪水"] }),
  ];
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "眼里常含泪水", sparks,
  });
  // a/b 命中 "泪"(1)，c 命中 "眼里常含泪水"(6)：c 最先，a、b 按 id 平局。
  assert.deepEqual(ids(result, "seeds"), ["c", "a", "b"]);
});

test("最多 3 个未 seen 种子，第四张不入 seeds", () => {
  const sparks = ["s1", "s2", "s3", "s4"].map((id) => card({ id, triggers: ["梗"] }));
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "这个梗", sparks,
  });
  assert.deepEqual(ids(result, "seeds"), ["s1", "s2", "s3"]);
});

test("防饿死：三个已 seen 种子不阻止第四个未 seen 种子入选", () => {
  const seenCards = ["s1", "s2", "s3"].map((id) => card({ id, triggers: ["梗"] }));
  const fresh = card({ id: "s4", triggers: ["梗"] });
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "这个梗", sparks: [...seenCards, fresh],
    seenKeys: seenKeysOf(seenCards),
  });
  // seen 过滤发生在截断之前：s4 独占种子；已 seen 三张只作锚点。
  assert.deepEqual(ids(result, "seeds"), ["s4"]);
  assert.deepEqual(ids(result, "anchors"), ["s1", "s2", "s3"]);
  assert.ok(result.anchors.length <= MAX_ANCHORS);
});

// ---------------------------------------------------------------------------
// 1 跳扩散
// ---------------------------------------------------------------------------

test("种子沿显式 links 扩散一次；关联不再扩散（禁两跳）", () => {
  const grandchild = card({ id: "grand", links: [] });
  const child = card({ id: "child", links: [{ target: "grand", rel: "衍生" }] });
  const seed = card({ id: "seed", triggers: ["洋葱"], links: [{ target: "child", rel: "衍生梗" }] });
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seed, child, grandchild],
  });
  assert.deepEqual(ids(result, "seeds"), ["seed"]);
  assert.deepEqual(ids(result, "related"), ["child"]);
  assert.equal(result.related[0].via.kind, "link");
  assert.equal(result.related[0].via.from, "seed");
  // 两跳被禁止：grand 既不在 seeds 也不在 related。
  assert.ok(!ids(result, "related").includes("grand"));
  assert.ok(!ids(result, "seeds").includes("grand"));
});

test("已 seen 卡可作关联锚点，但其自身不重复投递", () => {
  const seenSeed = card({ id: "seen", triggers: ["洋葱"], links: [{ target: "child", rel: "衍生" }] });
  const child = card({ id: "child", links: [] });
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seenSeed, child],
    seenKeys: seenKeysOf([seenSeed]),
  });
  assert.deepEqual(ids(result, "seeds"), []);
  assert.deepEqual(ids(result, "anchors"), ["seen"]);
  // 锚点扩散出的 child 可作为关联进入附件（它是未 seen 的新卡）。
  assert.deepEqual(ids(result, "related"), ["child"]);
  // seen 卡自身绝不进 seeds/related。
  assert.ok(!ids(result, "related").includes("seen"));
});

test("显式 links 优先于 entity 共现候选", () => {
  const viaLink = card({ id: "link-card", entities: [] });
  const viaEntity = card({ id: "entity-card", entities: ["做饭"] });
  const seed = card({
    id: "seed", triggers: ["洋葱"],
    entities: ["做饭"], links: [{ target: "link-card", rel: "r" }],
  });
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seed, viaLink, viaEntity],
    maxRelated: 1,
  });
  // 只剩 1 个关联名额时，显式 link 候选胜出。
  assert.deepEqual(ids(result, "related"), ["link-card"]);
});

test("关联最多 2 个；已 seen 的关联候选被过滤", () => {
  const seed = card({
    id: "seed", triggers: ["洋葱"], entities: ["做饭"],
    links: [{ target: "l1" }, { target: "l2" }, { target: "l3" }],
  });
  const l1 = card({ id: "l1" });
  const l2 = card({ id: "l2" });
  const l3 = card({ id: "l3" });
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seed, l1, l2, l3],
  });
  assert.deepEqual(ids(result, "related"), ["l1", "l2"]);

  const resultSeen = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seed, l1, l2, l3],
    seenKeys: seenKeysOf([l1]),
  });
  assert.deepEqual(ids(resultSeen, "related"), ["l2", "l3"]);
});

test("entity 共现扩散：共享小众标签产生关联，via 记录来源", () => {
  const seed = card({ id: "seed", triggers: ["洋葱"], entities: ["艾青"] });
  const peer = card({ id: "peer", entities: ["艾青"] });
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seed, peer],
  });
  assert.deepEqual(ids(result, "related"), ["peer"]);
  assert.equal(result.related[0].via.kind, "entity");
  assert.equal(result.related[0].via.entity, "艾青");
});

test("泛化 entity：出现超过 5 张 active 卡的标签不扩散", () => {
  // generalized 标签出现在 6 张 active 卡上 → 泛化；小众标签 "艾青" 正常。
  const cards = [
    card({ id: "seed", triggers: ["洋葱"], entities: ["generalized", "艾青"] }),
    ...["g1", "g2", "g3", "g4", "g5"].map((id) => card({ id, entities: ["generalized"] })),
    card({ id: "peer", entities: ["艾青"] }),
  ];
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: cards,
  });
  assert.deepEqual(ids(result, "related"), ["peer"]);
  // 正好 5 张（含种子共 5）：未超过门槛，允许扩散。
  const cardsFive = [
    card({ id: "seed", triggers: ["洋葱"], entities: ["刚好"] }),
    ...["x1", "x2", "x3", "x4"].map((id) => card({ id, entities: ["刚好"] })),
  ];
  const resultFive = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: cardsFive,
  });
  assert.equal(resultFive.related.length, 2); // x1..x4 中前 2 个（cap 2）
});

// ---------------------------------------------------------------------------
// 资格排除
// ---------------------------------------------------------------------------

test("archived / 异 scope / redirect 条目不能进入结果", () => {
  const seed = card({ id: "seed", triggers: ["洋葱"], links: [{ target: "redirected" }] });
  const sparks = [
    seed,
    card({ id: "archived", triggers: ["洋葱"], state: "archived" }),
    card({ id: "foreign", scopeId: "other", triggers: ["洋葱"] }),
    card({ id: "redirected", mergedInto: "seed", triggers: ["洋葱"] }),
    card({ id: "superseded", supersededBy: "newer", triggers: ["洋葱"] }),
  ];
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks,
  });
  assert.deepEqual(ids(result, "seeds"), ["seed"]);
  // redirect 目标已被排除，link 扩散落空。
  assert.deepEqual(ids(result, "related"), []);
});

test("self-link 与指向不存在卡片的 link 被忽略", () => {
  const seed = card({
    id: "seed", triggers: ["洋葱"],
    links: [{ target: "seed" }, { target: "ghost" }],
  });
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seed],
  });
  assert.deepEqual(ids(result, "related"), []);
});

// ---------------------------------------------------------------------------
// seen key 语义与入参校验
// ---------------------------------------------------------------------------

test("seen key 含 scope/session/contextEpoch/spark/revision；换 epoch/session/revision 视为未 seen", () => {
  const seenCard = card({ id: "seen", triggers: ["洋葱"] });
  const base = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seenCard],
    seenKeys: seenKeysOf([seenCard]),
  });
  assert.deepEqual(ids(base, "seeds"), []);

  const nextEpoch = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH + 1,
    userText: "洋葱", sparks: [seenCard],
    seenKeys: seenKeysOf([seenCard]),
  });
  assert.deepEqual(ids(nextEpoch, "seeds"), ["seen"]);

  const nextSession = matchSparks({
    scopeId: SCOPE, sessionId: "sess-2", contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seenCard],
    seenKeys: seenKeysOf([seenCard]),
  });
  assert.deepEqual(ids(nextSession, "seeds"), ["seen"]);

  const nextRevision = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [card({ id: "seen", revision: 2, triggers: ["洋葱"] })],
    seenKeys: seenKeysOf([seenCard]),
  });
  assert.deepEqual(ids(nextRevision, "seeds"), ["seen"]);
});

test("其他 scope 的 seen key 不影响本 scope 匹配", () => {
  const seenCard = card({ id: "seen", triggers: ["洋葱"] });
  const keys = [seenKeyFor({
    scopeId: "other-scope", sessionId: SESSION, contextEpoch: EPOCH,
    sparkId: "seen", revision: 1,
  })];
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seenCard], seenKeys: keys,
  });
  assert.deepEqual(ids(result, "seeds"), ["seen"]);
});

test("入参校验：非法输入按 INVALID_INPUT 拒绝", () => {
  const base = { scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH, userText: "x", sparks: [] };
  assert.throws(() => matchSparks({ ...base, scopeId: "" }), /INVALID_INPUT|scopeId/);
  assert.throws(() => matchSparks({ ...base, scopeId: 7 }), /INVALID_INPUT|scopeId/);
  assert.throws(() => matchSparks({ ...base, sessionId: "" }), /INVALID_INPUT|sessionId/);
  assert.throws(() => matchSparks({ ...base, contextEpoch: -1 }), /INVALID_INPUT|contextEpoch/);
  assert.throws(() => matchSparks({ ...base, contextEpoch: 1.5 }), /INVALID_INPUT|contextEpoch/);
  assert.throws(() => matchSparks({ ...base, sparks: "nope" }), /INVALID_INPUT|sparks/);
  assert.throws(() => matchSparks({ ...base, seenKeys: "nope" }), /INVALID_INPUT|seenKeys/);
  assert.throws(() => matchSparks({ ...base, seenKeys: [42] }), /INVALID_INPUT|seenKeys/);
  assert.throws(() => matchSparks({ ...base, userText: 42 }), /INVALID_INPUT|userText/);
  assert.throws(() => matchSparks({ ...base, userText: { role: "user" } }), /INVALID_INPUT|userText/);
  assert.throws(() => matchSparks({ ...base, maxSeeds: -1 }), /INVALID_INPUT|maxSeeds/);
  assert.throws(() => matchSparks({ ...base, maxRelated: 1.5 }), /INVALID_INPUT|maxRelated/);
});

test("seenKeys 接受 Set；返回结果恒为 plain object", () => {
  const seenCard = card({ id: "seen", triggers: ["洋葱"] });
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seenCard],
    seenKeys: new Set(seenKeysOf([seenCard])),
  });
  assert.deepEqual(ids(result, "seeds"), []);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
});

// ---------------------------------------------------------------------------
// 评审 rework 回归（attempt 2）
// ---------------------------------------------------------------------------

test("硬上限钳制：maxSeeds=4 / maxRelated=3 也不得超过 3 种子、2 关联、5 张卡", () => {
  const sparks = ["s1", "s2", "s3", "s4"].map((id) =>
    card({ id, triggers: ["梗"], links: [{ target: `r${id}` }] }));
  const relatedCards = ["rs1", "rs2", "rs3", "rs4"].map((id) => card({ id }));
  const result = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "这个梗", sparks: [...sparks, ...relatedCards],
    maxSeeds: 4, maxRelated: 3,
  });
  assert.equal(result.seeds.length, 3, "maxSeeds=4 必须被钳制到 3");
  assert.equal(result.related.length, 2, "maxRelated=3 必须被钳制到 2");
  assert.ok(result.seeds.length + result.related.length <= 5, "总卡数不得超过 5");
  // 未超限的自定义值仍被尊重：maxSeeds=2 取 2 个。
  const two = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "这个梗", sparks,
    maxSeeds: 2, maxRelated: 0,
  });
  assert.equal(two.seeds.length, 2);
});

test("关联选择与传入顺序无关：links 置换（maxRelated=1）结果一致", () => {
  const seed = card({
    id: "seed", triggers: ["洋葱"],
    links: [{ target: "l-b", rel: "r" }, { target: "l-a", rel: "r" }],
  });
  const lb = card({ id: "l-b" });
  const la = card({ id: "l-a" });
  const one = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seed, lb, la], maxRelated: 1,
  });
  const two = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [la, seed, lb], maxRelated: 1,
  });
  // 稳定键：卡片 id 升序 → 无论输入顺序如何都选中 l-a。
  assert.deepEqual(ids(one, "related"), ["l-a"]);
  assert.deepEqual(ids(two, "related"), ["l-a"]);
});

test("关联选择与传入顺序无关：entity 置换（maxRelated=1）结果一致", () => {
  const seed = card({ id: "seed", triggers: ["洋葱"], entities: ["B标签", "A标签"] });
  const e2 = card({ id: "e2", entities: ["B标签"] });
  const e1 = card({ id: "e1", entities: ["A标签"] });
  const one = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seed, e2, e1], maxRelated: 1,
  });
  const two = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [e1, e2, seed], maxRelated: 1,
  });
  assert.deepEqual(ids(one, "related"), ["e1"]);
  assert.deepEqual(ids(two, "related"), ["e1"]);
  assert.equal(one.related[0].via.entity, "A标签");
});

test("同一卡多条扩散路径时按稳定键取最小 via（link 优先于 entity）", () => {
  const seed = card({
    id: "seed", triggers: ["洋葱"], entities: ["做饭"],
    links: [{ target: "both", rel: "显式边" }],
  });
  const both = card({ id: "both", entities: ["做饭"] });
  const one = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [seed, both], maxRelated: 1,
  });
  assert.equal(one.related[0].via.kind, "link");
  const two = matchSparks({
    scopeId: SCOPE, sessionId: SESSION, contextEpoch: EPOCH,
    userText: "洋葱", sparks: [both, seed], maxRelated: 1,
  });
  assert.equal(two.related[0].via.kind, "link");
});
