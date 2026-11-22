// 0.4 S3 · 组清单（groups.json）数据层测试。
// 夹具：临时 dataRoot（mkdtemp），每个用例独立目录，结束即清理；
// 覆盖 dev-plan §S3.5 要求的四类场景：多组挂载、删组拒绝、迁移、group 不存在报错，
// 外加 frontmatter 的 group/pinned 序列化/解析往返与默认模板契约。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// P1#7 解环（0.5-1A）：core/groups.mjs 只留纯逻辑；文件 I/O（readGroups /
// ensureGroupsFile / writeGroups / deleteGroup）改从 src/storage/groups.mjs 导入，
// groupsFilePath 来自 src/storage/paths.mjs。既有用例与断言原样保留。
import {
  GROUPS_VERSION,
  DEFAULT_GROUPS_TEMPLATE,
  defaultGroupsTemplate,
  validateGroupKey,
  validateGroupEntry,
  validateGroupEntryShared,
  validateGroupsData,
  assertGroupsExist,
  migrateGroupArray,
  planGroupMigration,
} from "../../src/core/groups.mjs";
import { renderL1 } from "../../src/core/render.mjs";
import {
  readGroups,
  ensureGroupsFile,
  writeGroups,
  deleteGroup,
} from "../../src/storage/groups.mjs";
import { groupsFilePath } from "../../src/storage/paths.mjs";
import { serializeTopicFile, parseTopicFile } from "../../src/storage/frontmatter.mjs";

async function makeRoot() {
  return mkdtemp(path.join(tmpdir(), "shiori-groups-test-"));
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

// 多组用例的夹具：默认模板已经收敛成一个「通用」组，凡是要验证多组语义
// （删组、迁移、组不存在报错）的用例，显式写这四组，语义与旧模板一致。
const FOUR_GROUPS = [
  { key: "dev", title: "开发与配置", summary: "DSH / 插件 / 发版 / 沙箱", order: 10 },
  { key: "self", title: "自我与关系", summary: "身份 / 情绪 / 人际边界", order: 20 },
  { key: "project", title: "项目与工具", summary: "在跟的项目 / 常用工具与流程", order: 30 },
  { key: "life", title: "生活与偏好", summary: "作息 / 口味 / 日常安排", order: 40 },
];
const seedGroups = async (root, scopeId = "amber") =>
  writeGroups({ dataRoot: root, scopeId, groups: FOUR_GROUPS, expectedRevision: null });

function assertCode(error, code, pattern) {
  assert.equal(error.code, code, `期望 ${code}，实际 ${error.code}: ${error.message}`);
  if (pattern) assert.match(error.message, pattern);
  return true;
}

// ---------- 默认模板契约（§S3.2：随包常量，UI 与工具引同一份） ----------

test("默认模板：只预置一个「通用」组，深冻结不可变", () => {
  assert.deepEqual(DEFAULT_GROUPS_TEMPLATE.map((g) => g.key), ["general"]);
  assert.deepEqual(DEFAULT_GROUPS_TEMPLATE.map((g) => g.title), ["通用"]);
  assert.deepEqual(DEFAULT_GROUPS_TEMPLATE.map((g) => g.order), [10]);
  for (const entry of DEFAULT_GROUPS_TEMPLATE) {
    assert.equal(Object.isFrozen(entry), true);
    for (const value of Object.values(entry)) {
      if (typeof value === "string") assert.equal(Object.isFrozen(value), true);
    }
  }
  assert.equal(Object.isFrozen(DEFAULT_GROUPS_TEMPLATE), true);
});

test("defaultGroupsTemplate 返回可变深拷贝，与常量内容一致", () => {
  const copy = defaultGroupsTemplate();
  assert.deepEqual(copy, DEFAULT_GROUPS_TEMPLATE);
  assert.notEqual(copy, DEFAULT_GROUPS_TEMPLATE);
  copy[0].title = "改过的标题";
  assert.equal(DEFAULT_GROUPS_TEMPLATE[0].title, "通用");
});

// ---------- 首次初始化与读取（§S3.2） ----------

test("ensureGroupsFile 首次写入默认模板；再次调用幂等不覆盖", async () => {
  const root = await makeRoot();
  try {
    const first = await ensureGroupsFile({ dataRoot: root, scopeId: "amber" });
    assert.equal(first.created, true);
    assert.equal(first.data.version, GROUPS_VERSION);
    assert.deepEqual(first.data.groups, DEFAULT_GROUPS_TEMPLATE.map((g) => ({ ...g })));
    // 落盘结构：{version, groups:[{key,title,summary,order}]}
    const onDisk = JSON.parse(await readFile(groupsFilePath(root, "amber"), "utf8"));
    assert.deepEqual(Object.keys(onDisk).sort(), ["groups", "version"]);
    assert.equal(onDisk.version, 1);
    assert.deepEqual(
      onDisk.groups.map((g) => Object.keys(g).sort()),
      DEFAULT_GROUPS_TEMPLATE.map(() => ["key", "order", "summary", "title"]),
    );
    // 幂等：created:false 且内容不变
    const second = await ensureGroupsFile({ dataRoot: root, scopeId: "amber" });
    assert.equal(second.created, false);
    assert.deepEqual(second.data, first.data);
    assert.equal(second.revision, first.revision);
  } finally {
    await cleanup(root);
  }
});

test("ensureGroupsFile 对 global scope 也可初始化（scopes/global/groups.json）", async () => {
  const root = await makeRoot();
  try {
    const result = await ensureGroupsFile({ dataRoot: root, scopeId: "global" });
    assert.equal(result.created, true);
    assert.equal(
      groupsFilePath(root, "global"),
      path.join(root, "scopes", "global", "groups.json"),
    );
  } finally {
    await cleanup(root);
  }
});

test("readGroups 清单缺失抛 NOT_FOUND（读路径绝不写盘），root 相对路径被拒", async () => {
  const root = await makeRoot();
  try {
    await assert.rejects(
      readGroups({ dataRoot: root, scopeId: "amber" }),
      (e) => assertCode(e, "NOT_FOUND", /组清单不存在/),
    );
    // 读路径不写盘：目录不应被创建
    await assert.rejects(
      readGroups({ dataRoot: root, scopeId: "amber" }),
      (e) => assertCode(e, "NOT_FOUND", /ensureGroupsFile/),
    );
    await assert.rejects(
      readGroups({ dataRoot: "not/absolute", scopeId: "amber" }),
      (e) => assertCode(e, "INVALID_INPUT", /绝对路径/),
    );
    await assert.rejects(
      readGroups({ dataRoot: path.join(root, "missing-root"), scopeId: "amber" }),
      (e) => assertCode(e, "NOT_FOUND", /dataRoot 不存在/),
    );
  } finally {
    await cleanup(root);
  }
});

test("readGroups 读取手改损坏的清单：坏 JSON / 版本不符 / 组重复 显式 INVALID_STATE", async () => {
  const root = await makeRoot();
  try {
    const file = groupsFilePath(root, "amber");
    await ensureGroupsFile({ dataRoot: root, scopeId: "amber" });

    await writeFile(file, "{ not json", "utf8");
    await assert.rejects(
      readGroups({ dataRoot: root, scopeId: "amber" }),
      (e) => assertCode(e, "INVALID_STATE", /不是合法 JSON/),
    );

    await writeFile(file, JSON.stringify({ version: 2, groups: [] }), "utf8");
    await assert.rejects(
      readGroups({ dataRoot: root, scopeId: "amber" }),
      (e) => assertCode(e, "INVALID_STATE", /version 必须是 1/),
    );

    await writeFile(file, JSON.stringify({
      version: 1,
      groups: [
        { key: "dev", title: "A", summary: "", order: 10 },
        { key: "dev", title: "B", summary: "", order: 20 },
      ],
    }), "utf8");
    await assert.rejects(
      readGroups({ dataRoot: root, scopeId: "amber" }),
      (e) => assertCode(e, "INVALID_STATE", /组 key 重复: "dev"/),
    );
  } finally {
    await cleanup(root);
  }
});

// ---------- 写入 CAS（§S3.2：原子写 + 与 topic 同一把锁） ----------

test("writeGroups CAS：新建必须 expectedRevision=null；哈希不符抛 REVISION_CONFLICT", async () => {
  const root = await makeRoot();
  try {
    const groups = [{ key: "dev", title: "开发与配置", summary: "", order: 10 }];
    await assert.rejects(
      writeGroups({ dataRoot: root, scopeId: "amber", groups, expectedRevision: undefined }),
      (e) => assertCode(e, "INVALID_INPUT", /expectedRevision 必须显式提供/),
    );
    await writeGroups({ dataRoot: root, scopeId: "amber", groups, expectedRevision: null });
    const { revision } = await readGroups({ dataRoot: root, scopeId: "amber" });
    // 用 null 覆盖已有文件 → 冲突
    await assert.rejects(
      writeGroups({ dataRoot: root, scopeId: "amber", groups, expectedRevision: null }),
      (e) => assertCode(e, "REVISION_CONFLICT", /CAS 失败/),
    );
    // 哈希不符 → 冲突
    await assert.rejects(
      writeGroups({ dataRoot: root, scopeId: "amber", groups, expectedRevision: "0".repeat(64) }),
      (e) => assertCode(e, "REVISION_CONFLICT", /CAS 失败/),
    );
    // 正确哈希 → 成功且 revision 前进
    const updated = await writeGroups({
      dataRoot: root, scopeId: "amber",
      groups: [...groups, { key: "life", title: "生活与偏好", summary: "", order: 40 }],
      expectedRevision: revision,
    });
    assert.notEqual(updated.revision, revision);
    assert.equal(updated.data.groups.length, 2);
  } finally {
    await cleanup(root);
  }
});

test("writeGroups 并发同哈希：共享锁串行化 + CAS，恰好一个成功", async () => {
  const root = await makeRoot();
  try {
    await ensureGroupsFile({ dataRoot: root, scopeId: "amber" });
    const { revision } = await readGroups({ dataRoot: root, scopeId: "amber" });
    const groups = [{ key: "dev", title: "开发与配置", summary: "", order: 10 }];
    const results = await Promise.allSettled([
      writeGroups({ dataRoot: root, scopeId: "amber", groups, expectedRevision: revision }),
      writeGroups({ dataRoot: root, scopeId: "amber", groups, expectedRevision: revision }),
    ]);
    const states = results.map((r) => r.status);
    assert.deepEqual(states.sort(), ["fulfilled", "rejected"]);
    const failed = results.find((r) => r.status === "rejected").reason;
    assert.equal(failed.code, "REVISION_CONFLICT");
  } finally {
    await cleanup(root);
  }
});

test("writeGroups 形状校验：坏 key/缺字段/重复 key 拒绝且不落盘", async () => {
  const root = await makeRoot();
  try {
    const cases = [
      // 0.5 债收口 R2：key/title/summary 共享规则走 validateGroupEntryShared
      // 单一实现，报错措辞与渲染侧（core/render.mjs）同族（validateTopic 风格）。
      { groups: [{ title: "T", summary: "", order: 1 }], pattern: /is missing required property "key"/ },
      { groups: [{ key: "dev", title: "", summary: "", order: 1 }], pattern: /title must be a non-empty string/ },
      { groups: [{ key: "dev", title: "T", summary: 5, order: 1 }], pattern: /summary must be a string when present/ },
      { groups: [{ key: "dev", title: "T", summary: "", order: "10" }], pattern: /order must be a finite number/ },
      { groups: [{ key: "bad<key", title: "T", summary: "", order: 1 }], pattern: /forbidden filename character/ },
      {
        groups: [
          { key: "dev", title: "A", summary: "", order: 1 },
          { key: "dev", title: "B", summary: "", order: 2 },
        ],
        pattern: /组 key 重复: "dev"/,
        code: "INVALID_STATE", // 与读路径同一校验实现，重复 key = 数据错误
      },
    ];
    for (const { groups, pattern, code = "INVALID_INPUT" } of cases) {
      await assert.rejects(
        writeGroups({ dataRoot: root, scopeId: "amber", groups, expectedRevision: null }),
        (e) => assertCode(e, code, pattern),
      );
    }
    // 全部失败后磁盘上仍无文件（校验先于落盘）
    await assert.rejects(
      readGroups({ dataRoot: root, scopeId: "amber" }),
      (e) => assertCode(e, "NOT_FOUND"),
    );
  } finally {
    await cleanup(root);
  }
});

// ---------- 校验助手 ----------

test("validateGroupKey / validateGroupEntry / validateGroupsData / assertGroupsExist", () => {
  assert.equal(validateGroupKey("dev"), "dev");
  assert.throws(() => validateGroupKey(""), (e) => assertCode(e, "INVALID_INPUT", /非空字符串/));
  assert.throws(() => validateGroupKey("bad:key"), (e) => assertCode(e, "INVALID_INPUT", /key 规范/));

  const entry = validateGroupEntry({ key: "dev", title: "开发与配置", summary: "s", order: 10 }, "g[0]");
  assert.deepEqual(entry, { key: "dev", title: "开发与配置", summary: "s", order: 10 });
  // 未知字段读取时容忍，归一化时丢弃（前向兼容）
  assert.deepEqual(
    validateGroupEntry({ key: "dev", title: "T", summary: "", order: 1, extra: "x" }, "g[0]"),
    { key: "dev", title: "T", summary: "", order: 1 },
  );

  const data = validateGroupsData({ version: 1, groups: [{ key: "dev", title: "T", summary: "", order: 1 }] });
  assert.deepEqual(data, { version: 1, groups: [{ key: "dev", title: "T", summary: "", order: 1 }] });

  assertGroupsExist(data, ["dev"]);
  assert.throws(
    () => assertGroupsExist(data, ["dev", "ghost"]),
    (e) => assertCode(e, "INVALID_INPUT", /"ghost" 不存在，请先建组/),
  );
});

// ---------- 0.5 债收口 R2：组条目校验单一契约 ----------

test("R2 债收口：validateGroupEntry 单一契约——groups.mjs 记录层与 renderL1 渲染层对照", () => {
  // 契约对照表：同一组条目形状喂给两个入口。共享字段（plain record / key /
  // title / summary 类型与换行禁令）走 validateGroupEntryShared 单一实现，
  // 接受/拒绝、错误码与报错措辞必须逐条一致；层内字段按各自口径：
  // order/retention 只属于记录层（渲染层容忍透传），pinned/members 只属于
  // 渲染层强校验（记录层当作未知字段容忍丢弃）。
  const recordSide = (entry) => validateGroupEntry(entry, "g[0]");
  const renderSide = (entry) => renderL1({ coreText: "", topics: [], groups: [entry] });

  // 共享字段一致接受：归一化结果同形（渲染层 summary 缺省补 ''）
  assert.deepEqual(
    recordSide({ key: "dev", title: "T", summary: "s", order: 1 }),
    { key: "dev", title: "T", summary: "s", order: 1 },
  );
  assert.deepEqual(
    validateGroupEntry({ key: "dev", title: "T", summary: "", order: 1, members: [{ key: "m" }], pinned: true }, "g[0]"),
    { key: "dev", title: "T", summary: "", order: 1 },
  );
  renderSide({ key: "dev", title: "T" }); // 渲染层 summary 缺省合法（补 ''）

  // R2-extra-field（review-rework）：中性「多余字段」双入口对照——未知字段
  // 两侧容忍：记录层归一化丢弃（extra 不进结果），渲染层透传不抛。把
  // 「未知字段容忍但丢弃」的前向兼容承诺钉死在两侧，不靠 members/pinned
  // 这类层内一等字段间接体现。
  assert.deepEqual(
    recordSide({ key: "dev", title: "T", summary: "", order: 1, extra: "x" }),
    { key: "dev", title: "T", summary: "", order: 1 },
  );
  renderSide({ key: "dev", title: "T", summary: "", order: 1, extra: "x" });

  // 共享字段一致拒绝：错误码（INVALID_INPUT）与措辞逐条对照
  const sharedViolations = [
    { entry: { title: "T", summary: "", order: 1 }, pattern: /is missing required property "key"/ },
    { entry: { key: "", title: "T", summary: "", order: 1 }, pattern: /key must be a non-empty string/ },
    { entry: { key: "bad<key", title: "T", summary: "", order: 1 }, pattern: /forbidden filename character/ },
    // R2-key-len（review-rework）：key 超长——validateKey 的长度上限（keys.mjs
    // MAX_KEY_CHARS=128）对两侧入口同时可达，129 字符必拒
    { entry: { key: "k".repeat(129), title: "T", summary: "", order: 1 }, pattern: /at most 128/ },
    { entry: { key: "dev", summary: "", order: 1 }, pattern: /is missing required property "title"/ },
    { entry: { key: "dev", title: "", summary: "", order: 1 }, pattern: /title must be a non-empty string/ },
    { entry: { key: "dev", title: "T", summary: 5, order: 1 }, pattern: /summary must be a string when present/ },
    { entry: { key: "dev", title: "T", summary: "a\nb", order: 1 }, pattern: /summary must not contain line breaks/ },
    { entry: { key: "dev", title: "T", summary: "a\rb", order: 1 }, pattern: /summary must not contain line breaks/ },
    { entry: null, pattern: /must be a plain object/ },
    { entry: [1], pattern: /must be a plain object/ },
  ];
  for (const { entry, pattern } of sharedViolations) {
    assert.throws(
      () => recordSide(entry),
      (e) => e.code === "INVALID_INPUT" && pattern.test(e.message),
      `记录层未按契约拒绝: ${JSON.stringify(entry)}`,
    );
    assert.throws(
      () => renderSide(entry),
      (e) => e.code === "INVALID_INPUT" && pattern.test(e.message),
      `渲染层未按契约拒绝: ${JSON.stringify(entry)}`,
    );
  }

  // 记录层必填是层内规则：渲染层允许缺省的 summary/order，记录层缺失必拒
  assert.throws(
    () => recordSide({ key: "dev", title: "T", order: 1 }),
    (e) => e.code === "INVALID_INPUT" && /is missing required property "summary"/.test(e.message),
  );
  assert.throws(
    () => recordSide({ key: "dev", title: "T", summary: "" }),
    (e) => e.code === "INVALID_INPUT" && /is missing required property "order"/.test(e.message),
  );
  renderSide({ key: "dev", title: "T" }); // 渲染层无 order 概念，合法

  // members 非数组（R2 变异锚点）：记录层=未知字段容忍丢弃（前向兼容），
  // 渲染层=一等输入强校验 INVALID_INPUT。任一侧把这条处理改成直接抛错/
  // 改码/放行，本对照用例必红。
  assert.deepEqual(
    validateGroupEntry({ key: "dev", title: "T", summary: "", order: 1, members: "no" }, "g[0]"),
    { key: "dev", title: "T", summary: "", order: 1 },
  );
  assert.throws(
    () => renderSide({ key: "dev", title: "T", summary: "", members: "no" }),
    (e) => e.code === "INVALID_INPUT" && /members must be an array/.test(e.message),
  );

  // pinned 非布尔：与 members 同一条层内分界线
  assert.deepEqual(
    validateGroupEntry({ key: "dev", title: "T", summary: "", order: 1, pinned: "yes" }, "g[0]"),
    { key: "dev", title: "T", summary: "", order: 1 },
  );
  assert.throws(
    () => renderSide({ key: "dev", title: "T", summary: "", pinned: "yes" }),
    (e) => e.code === "INVALID_INPUT" && /pinned must be a boolean/.test(e.message),
  );
});

test("R2 债收口：validateGroupEntryShared 直连契约（plain record / 换行禁令对写入侧生效）", () => {
  // 直连共享实现的最小形状：返回归一化共享字段，summary 缺省补 ''
  assert.deepEqual(
    validateGroupEntryShared({ key: "dev", title: "T" }, "g[0]"),
    { key: "dev", title: "T", summary: "" },
  );
  // 写入侧换行禁令（此前记录层放行含换行摘要、渲染侧拒绝的漂移实证）：
  // 经 validateGroupsData → parseGroupsFile 读路径应得 INVALID_STATE
  assert.throws(
    () => validateGroupsData({ version: 1, groups: [{ key: "dev", title: "T", summary: "a\nb", order: 1 }] }),
    (e) => e.code === "INVALID_INPUT" && /summary must not contain line breaks/.test(e.message),
  );
});

// ---------- 删组与迁移（§S3.3 delete / §S3.5） ----------

test("migrateGroupArray：toKey 顶替原位置保主组语义；非成员返回 null", () => {
  // 主组被迁：life 顶替 dev 的主组位
  assert.deepEqual(migrateGroupArray(["dev", "self"], "dev", "life"), ["life", "self"]);
  // 兼属组被迁：主组不变
  assert.deepEqual(migrateGroupArray(["self", "dev"], "dev", "life"), ["self", "life"]);
  // toKey 已在剩余组里：不重复添加
  assert.deepEqual(migrateGroupArray(["dev", "life"], "dev", "life"), ["life"]);
  // 不给 toKey：只摘出
  assert.deepEqual(migrateGroupArray(["dev", "self"], "dev"), ["self"]);
  assert.equal(migrateGroupArray(["self"], "dev", "life"), null);
});

test("planGroupMigration：只为成员产计划，非成员跳过", () => {
  const topics = [
    { key: "t1", group: ["dev", "self"] },
    { key: "t2", group: ["self"] },
    { key: "t3", group: [] },
    { key: "t4" }, // group 缺省 = []（读取口径）
  ];
  assert.deepEqual(planGroupMigration(topics, "dev", "life"), [
    { topicKey: "t1", group: ["life", "self"] },
  ]);
  assert.deepEqual(planGroupMigration(topics, "self"), [
    { topicKey: "t1", group: ["dev"] },
    { topicKey: "t2", group: [] },
  ]);
  assert.throws(
    () => planGroupMigration(topics, "dev", "dev"),
    (e) => assertCode(e, "INVALID_INPUT", /migrateTo 不能等于/),
  );
});

test("deleteGroup：组不存在报可读 NOT_FOUND；migrateTo 不存在 / 等于自身 报 INVALID_INPUT", async () => {
  const root = await makeRoot();
  try {
    await seedGroups(root);
    await assert.rejects(
      deleteGroup({ dataRoot: root, scopeId: "amber", key: "ghost", topics: [] }),
      (e) => assertCode(e, "NOT_FOUND", /组 "ghost" 不存在.*现有组: dev, self, project, life/),
    );
    await assert.rejects(
      deleteGroup({ dataRoot: root, scopeId: "amber", key: "life", migrateTo: "ghost", topics: [] }),
      (e) => assertCode(e, "INVALID_INPUT", /migrateTo 指向的组 "ghost" 不存在/),
    );
    await assert.rejects(
      deleteGroup({ dataRoot: root, scopeId: "amber", key: "life", migrateTo: "life", topics: [] }),
      (e) => assertCode(e, "INVALID_INPUT", /migrateTo 不能等于/),
    );
    // 全部失败后清单原样（四组俱在）
    const { data } = await readGroups({ dataRoot: root, scopeId: "amber" });
    assert.equal(data.groups.length, 4);
  } finally {
    await cleanup(root);
  }
});

test("deleteGroup：组内仍有 topic 且未给 migrateTo 一律拒绝（§S3.5）", async () => {
  const root = await makeRoot();
  try {
    await seedGroups(root);
    const topics = [
      { key: "topic-a", group: ["dev", "self"] },
      { key: "topic-b", group: ["dev"] },
      { key: "topic-c", group: ["self"] },
    ];
    await assert.rejects(
      deleteGroup({ dataRoot: root, scopeId: "amber", key: "dev", topics }),
      (e) => assertCode(e, "INVALID_STATE", /内仍有 2 个 topic（topic-a, topic-b）.*migrateTo/),
    );
    // 清单未被动过
    const { data } = await readGroups({ dataRoot: root, scopeId: "amber" });
    assert.equal(data.groups.length, 4);
  } finally {
    await cleanup(root);
  }
});

test("deleteGroup：空组直接删；给 migrateTo 时删组并返回迁移计划", async () => {
  const root = await makeRoot();
  try {
    await seedGroups(root);
    const topics = [
      { key: "topic-a", group: ["dev", "self"] },
      { key: "topic-b", group: ["dev"] },
      { key: "topic-c", group: ["self"] },
    ];
    // 空组（无成员）直接删
    const empty = await deleteGroup({
      dataRoot: root, scopeId: "amber", key: "project", topics, expectedRevision: undefined,
    });
    assert.deepEqual(empty.members, []);
    assert.deepEqual(empty.migration, []);
    assert.equal(empty.data.groups.length, 3);

    // 给 migrateTo：删组 + 迁移计划（主组语义保持）
    const { revision } = await readGroups({ dataRoot: root, scopeId: "amber" });
    const migrated = await deleteGroup({
      dataRoot: root, scopeId: "amber", key: "dev", migrateTo: "life", topics, expectedRevision: revision,
    });
    assert.deepEqual(migrated.members, ["topic-a", "topic-b"]);
    assert.deepEqual(migrated.migration, [
      { topicKey: "topic-a", group: ["life", "self"] }, // life 顶替 dev 的主组位
      { topicKey: "topic-b", group: ["life"] },
    ]);
    assert.deepEqual(migrated.data.groups.map((g) => g.key), ["self", "life"]);
  } finally {
    await cleanup(root);
  }
});

test("deleteGroup 可选 CAS：expectedRevision 不符时拒绝删除", async () => {
  const root = await makeRoot();
  try {
    await seedGroups(root);
    await assert.rejects(
      deleteGroup({
        dataRoot: root, scopeId: "amber", key: "dev", topics: [],
        expectedRevision: "0".repeat(64),
      }),
      (e) => assertCode(e, "REVISION_CONFLICT", /CAS 失败/),
    );
  } finally {
    await cleanup(root);
  }
});

// ---------- 路径助手 ----------

test("groupsFilePath：scope 目录语义校验复用 paths 层，非法 scopeId 被拒", () => {
  const root = path.join(tmpdir(), "whatever-root");
  assert.equal(
    groupsFilePath(root, "amber"),
    path.join(root, "scopes", "amber", "groups.json"),
  );
  assert.throws(() => groupsFilePath(root, "bad<scope>"), (e) => assertCode(e, "INVALID_INPUT"));
  assert.throws(() => groupsFilePath(root, ""), (e) => assertCode(e, "INVALID_INPUT"));
});

// ---------- frontmatter：group/pinned 序列化与解析（0.4 S3 新增可选字段） ----------

function makeMeta(overrides = {}) {
  return {
    key: "topic-key",
    title: "标题",
    summary: "摘要",
    updated: "2026-11-13T00:00:00.000Z",
    scopeId: "amber",
    ...overrides,
  };
}

test("frontmatter 往返：group 数组 + pinned=true 序列化后可无损解析", () => {
  const buffer = serializeTopicFile({ ...makeMeta(), group: ["dev", "self"], pinned: true }, "正文");
  const text = buffer.toString("utf8");
  assert.match(text, /^group: \["dev","self"\]$/m);
  assert.match(text, /^pinned: true$/m);
  const parsed = parseTopicFile(buffer);
  assert.deepEqual(parsed.group, ["dev", "self"]);
  assert.equal(parsed.pinned, true);
  assert.equal(parsed.body, "正文");
  assert.equal(parsed.meta.key, "topic-key");
});

test("frontmatter 缺省：老文件没有 group/pinned 时解析补 [] / false，且字节里没有新行", () => {
  const buffer = serializeTopicFile(makeMeta(), "正文");
  const text = buffer.toString("utf8");
  assert.doesNotMatch(text, /^group:/m);
  assert.doesNotMatch(text, /^pinned:/m);
  const parsed = parseTopicFile(buffer);
  assert.deepEqual(parsed.group, []);
  assert.equal(parsed.pinned, false);
  // 老文件 front-matter 原样保留（缺省读取不回写）
  assert.equal(parsed.meta.title, "标题");
});

test("frontmatter 解析：手写文件含空格数组 / pinned:false / archivedAt 共存均按口径读取", () => {
  const raw = [
    "---",
    'key: "k"',
    'title: "t"',
    'summary: ""',
    'updated: "2026-11-13T00:00:00.000Z"',
    'scopeId: "amber"',
    'archivedAt: "2026-11-13T00:00:00.000Z"',
    'group: ["dev", "self"]',
    "pinned: false",
    "---",
    "正文",
    "",
  ].join("\n");
  const parsed = parseTopicFile(Buffer.from(raw, "utf8"));
  assert.deepEqual(parsed.group, ["dev", "self"]);
  assert.equal(parsed.pinned, false);
  assert.equal(parsed.meta.archivedAt, "2026-11-13T00:00:00.000Z");
  // group/pinned 是一等字段，不混入 meta 字符串记录
  assert.equal(parsed.meta.group, undefined);
  assert.equal(parsed.meta.pinned, undefined);
});

test("frontmatter 解析：group/pinned 非法形态显式 INVALID_STATE", async () => {
  const base = [
    "---",
    'key: "k"',
    'title: "t"',
    'summary: ""',
    'updated: "2026-11-13T00:00:00.000Z"',
    'scopeId: "amber"',
  ];
  const cases = [
    [["group: dev"], /字段 "group" 必须是 JSON 字符串数组/],
    [["group: [dev]"], /数组标量不是合法 JSON/],
    [["group: []"], null], // 空数组合法 = 未分组
    [["group: {}"], /必须是 JSON 字符串数组/],
    [["group: [1]"], /元素必须是非空字符串/],
    [["group: [\"\"]"], /元素必须是非空字符串/],
    [["group: [\"a\",\"a\"]"], /含重复组 key: "a"/],
    [["group: [\"a\"]", "group: [\"b\"]"], /字段重复: "group"/],
    [["pinned: yes"], /字段 "pinned" 必须是 true\/false 布尔标量/],
    [["pinned: \"true\""], /字段 "pinned" 必须是 true\/false 布尔标量/],
    [["pinned: true", "pinned: false"], /字段重复: "pinned"/],
    [["pinned: 1"], /字段 "pinned" 必须是 true\/false 布尔标量/],
  ];
  for (const [lines, pattern] of cases) {
    const raw = [...base, ...lines, "---", "正文"].join("\n");
    if (pattern) {
      assert.throws(
        () => parseTopicFile(Buffer.from(raw, "utf8")),
        (e) => assertCode(e, "INVALID_STATE", pattern),
      );
    } else {
      const parsed = parseTopicFile(Buffer.from(raw, "utf8"));
      assert.deepEqual(parsed.group, []);
    }
  }
});

test("frontmatter 序列化：group/pinned 非法入参显式拒绝；空数组/省略不落行", () => {
  assert.throws(
    () => serializeTopicFile({ ...makeMeta(), group: "dev" }, ""),
    (e) => assertCode(e, "INVALID_INPUT", /"group" 必须是字符串数组/),
  );
  assert.throws(
    () => serializeTopicFile({ ...makeMeta(), group: ["a", "a"] }, ""),
    (e) => assertCode(e, "INVALID_INPUT", /含重复组 key/),
  );
  assert.throws(
    () => serializeTopicFile({ ...makeMeta(), group: ["a", 1] }, ""),
    (e) => assertCode(e, "INVALID_INPUT", /元素必须是非空字符串/),
  );
  assert.throws(
    () => serializeTopicFile({ ...makeMeta(), pinned: "true" }, ""),
    (e) => assertCode(e, "INVALID_INPUT", /"pinned" 必须是布尔值/),
  );
  // 空数组 / pinned:false / 缺省 → 整行省略
  for (const meta of [makeMeta(), { ...makeMeta(), group: [] }, { ...makeMeta(), pinned: false }]) {
    const text = serializeTopicFile(meta, "").toString("utf8");
    assert.doesNotMatch(text, /^group:/m);
    assert.doesNotMatch(text, /^pinned:/m);
  }
});

// ---------- P1#7 解环（0.5-1A）：core/groups.mjs 无 storage 导入 ----------

test("P1#7：core/groups.mjs 源码零 storage 导入（纯逻辑层不触 storage 模块）", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = await readFile(path.join(here, "..", "..", "src", "core", "groups.mjs"), "utf8");
  // 剥掉注释再扫，避免说明文字里的「storage」字样误报；import/export 语句里
  // 出现 ../storage/ 即违规（core 只依赖 node 内置模块与 core 内部模块）。
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(stripped, /['"]\.\.\/storage\//, "core/groups.mjs 不得 import ../storage/*");
  // 依赖白名单：除 node: 内置与 core 内部相对导入外，不允许任何其他来源。
  const sources = [...stripped.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1]);
  for (const src of sources) {
    assert.ok(
      src.startsWith("node:") || src.startsWith("./") || src.startsWith("../"),
      `core/groups.mjs 的导入来源越界: ${src}`,
    );
    if (src.startsWith("../")) {
      assert.ok(!src.includes("storage"), `core/groups.mjs 不得越级导入 storage 层: ${src}`);
    }
  }
});

// ---------- 0.5 批次 2 A 线：组级 retention 策略（groups.json 可选字段） ----------

test("A-0.5: validateGroupEntry 组级 retention 合法值保留进归一化结果，缺省不带该键", () => {
  const withPolicy = validateGroupEntry(
    { key: "dev", title: "开发", summary: "", order: 10, retention: "historical" },
    "g[0]",
  );
  assert.equal(withPolicy.retention, "historical");
  // 其余四字段原样
  assert.equal(withPolicy.key, "dev");
  assert.equal(withPolicy.order, 10);

  const withoutPolicy = validateGroupEntry(
    { key: "dev", title: "开发", summary: "", order: 10 },
    "g[0]",
  );
  assert.equal("retention" in withoutPolicy, false, "缺省时归一化结果不带 retention 键（老清单字节形状不变）");

  // 未知键仍被忽略（容错口径不变）
  const unknown = validateGroupEntry(
    { key: "dev", title: "开发", summary: "", order: 10, temperature: "cold", memo: "x" },
    "g[0]",
  );
  assert.equal("temperature" in unknown, false);
  assert.equal("memo" in unknown, false);
});

test("A-0.5: 组级 retention 非法值拒绝（INVALID_INPUT），不许静默纠正", () => {
  for (const bad of ["bogus", "STANDING", "", 42, true, null]) {
    // null 与 undefined 同义（缺省），不算非法
    if (bad === null) continue;
    assert.throws(
      () => validateGroupEntry({ key: "dev", title: "T", summary: "", order: 1, retention: bad }, "g[0]"),
      (error) => error.code === "INVALID_INPUT" && /retention/.test(error.message),
      `retention=${String(bad)}`,
    );
  }
});

test("A-0.5: 组级 retention 随清单序列化/解析往返保留（round-trip）", () => {
  const data = {
    version: GROUPS_VERSION,
    groups: [
      { key: "dev", title: "开发", summary: "", order: 10, retention: "historical" },
      { key: "general", title: "通用", summary: "", order: 20 },
    ],
  };
  const raw = serializeGroupsFile(data);
  const text = raw.toString("utf8");
  assert.match(text, /"retention": "historical"/, "组级策略落盘 JSON");
  const parsed = parseGroupsFile(raw, "groups.json(test)");
  assert.equal(parsed.groups[0].retention, "historical");
  assert.equal("retention" in parsed.groups[1], false);
  // 再序列化逐字节稳定（幂等）
  assert.equal(serializeGroupsFile(parsed).toString("utf8"), text);
});

test("A-0.5: 无 retention 的老清单序列化输出与 0.4 版本字节一致", () => {
  const data = {
    version: GROUPS_VERSION,
    groups: [{ key: "dev", title: "开发", summary: "", order: 10 }],
  };
  const text = serializeGroupsFile(data).toString("utf8");
  assert.equal(text, `${JSON.stringify({
    version: 1,
    groups: [{ key: "dev", title: "开发", summary: "", order: 10 }],
  }, null, 2)}\n`);
  assert.ok(!text.includes("retention"));
});

// 本段补充导入（ESM 顶层 import 提升生效；不改动上方既有 import 区，便于 review 对照）
import { serializeGroupsFile, parseGroupsFile } from "../../src/core/groups.mjs";

// ---------- 0.5 批次 8-4：磁盘解析错误族统一（与 topic 解析同为 INVALID_STATE） ----------

test("A-8-4: parseGroupsFile 磁盘字节入口一律 INVALID_STATE；写入口仍 INVALID_INPUT", () => {
  const diskCases = [
    ["坏 JSON", Buffer.from("{not json", "utf8"), /不是合法 JSON/],
    ["缺 title", Buffer.from(JSON.stringify({ version: 1, groups: [{ key: "dev", summary: "", order: 10 }] }), "utf8"), /title/],
    ["retention 非法", Buffer.from(JSON.stringify({
      version: 1, groups: [{ key: "dev", title: "T", summary: "", order: 1, retention: "bogus" }],
    }), "utf8"), /retention/],
  ];
  for (const [label, raw, messagePattern] of diskCases) {
    // 磁盘字节入口属数据损坏族：与 parseTopicFile 一致，不得抛成用户入参族。
    assert.throws(
      () => parseGroupsFile(raw, "groups.json(disk)"),
      (error) => error.code === "INVALID_STATE" && messagePattern.test(error.message),
      `${label} 应报 INVALID_STATE（message 原样保留）`,
    );
  }
  // 同一份非法 payload 走写入口：仍是 INVALID_INPUT（service/store 的入参校验族不变）。
  assert.throws(
    () => validateGroupsData({ version: 1, groups: [{ key: "dev", summary: "", order: 10 }] }, "groups.json(写)"),
    (error) => error.code === "INVALID_INPUT" && /title/.test(error.message),
    "写入口缺 title 必须仍是 INVALID_INPUT",
  );
  assert.throws(
    () => serializeGroupsFile({ version: 1, groups: [{ key: "dev", title: "T", summary: "", order: 1, retention: "bogus" }] }),
    (error) => error.code === "INVALID_INPUT" && /retention/.test(error.message),
    "写入口非法 retention 必须仍是 INVALID_INPUT",
  );
});
