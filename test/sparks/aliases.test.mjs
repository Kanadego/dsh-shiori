// 0.5 批次 6B-3 · src/sparks/aliases.mjs 独立测试（node:test，被测模块只读零改动）。
// 覆盖五类：归一化 / 内置表 / 手写表（优先·单跳·miss 回落）/ sidecar 降级（损坏·版本·超限）/ 零 IO。
// 所有 IO 用例一律 mkdtemp 到 os.tmpdir 并在 t.after 递归清理，绝不写仓库内路径。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_ENTITY_ALIASES,
  normalizeEntityText,
  resolveAlias,
  loadAliasTable,
  loadClusterOverrides,
} from "../../src/sparks/aliases.mjs";

/** 每个 IO 用例独立临时目录（os.tmpdir 下 mkdtemp），t.after 递归清理。 */
async function mkTmp(t) {
  const dir = await mkdtemp(join(tmpdir(), "shiori-aliases-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** 在临时目录写一个 sidecar 文件：value 传对象时 JSON.stringify，传字符串时原样落盘（坏 JSON 用）。 */
async function writeSidecar(dir, name, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(join(dir, name), text, "utf8");
}

// ── 1. normalizeEntityText：NFKC / trim / 空白折叠 / 小写 / 脏值 ────────────

test("normalizeEntityText：NFKC 全角折叠——ＪＳ→js、全角数字 Ｋ８Ｓ→k8s、全角空格参与折叠", () => {
  assert.equal(normalizeEntityText("ＪＳ"), "js");
  assert.equal(normalizeEntityText("Ｋ８Ｓ"), "k8s");
  assert.equal(normalizeEntityText("Ｆｏｏ　Ｂａｒ"), "foo bar"); // U+3000 全角空格 → 半角后折叠为单空格
});

test("normalizeEntityText：内部连续空白（空格/制表/换行）折叠为单个空格", () => {
  assert.equal(normalizeEntityText("foo   bar"), "foo bar");
  assert.equal(normalizeEntityText("foo\tbar\nbaz"), "foo bar baz");
});

test("normalizeEntityText：首尾 trim 与大小写折叠", () => {
  assert.equal(normalizeEntityText("  Foo Bar  "), "foo bar");
  assert.equal(normalizeEntityText("JavaScript"), "javascript");
});

test("normalizeEntityText：非字符串一律返回空串（null/undefined/数字/布尔/对象/数组）", () => {
  for (const bad of [null, undefined, 42, true, {}, ["js"]]) {
    assert.equal(normalizeEntityText(bad), "", `输入 ${String(bad)} 应归一为空串`);
  }
});

test("normalizeEntityText：空串与纯空白返回空串", () => {
  assert.equal(normalizeEntityText(""), "");
  assert.equal(normalizeEntityText("   "), "");
  assert.equal(normalizeEntityText(" \t\n "), "");
});

// ── 2. 内置别名表命中 ──────────────────────────────────────────────────────

test("内置表：8 条映射全命中（K8S→kubernetes、Py3→python 等大小写不敏感）且对象冻结", () => {
  assert.equal(Object.isFrozen(BUILTIN_ENTITY_ALIASES), true);
  const expected = {
    js: "javascript",
    nodejs: "node",
    ts: "typescript",
    py: "python",
    py3: "python",
    k8s: "kubernetes",
    reactjs: "react",
    vuejs: "vue",
  };
  assert.deepEqual({ ...BUILTIN_ENTITY_ALIASES }, expected);
  assert.equal(resolveAlias("K8S"), "kubernetes"); // 任务点名的混合大小写
  assert.equal(resolveAlias("Py3"), "python");
  for (const [alias, canonical] of Object.entries(expected)) {
    assert.equal(resolveAlias(alias.toUpperCase()), canonical, `${alias} 大写形式也应命中`);
  }
});

// ── 3. 手写表优先 / 内置回落 / 空值穿透 ────────────────────────────────────

test("手写表优先于内置表：table 里 js→ecmascript 时 JS 归 ecmascript 而非 javascript", () => {
  const table = new Map([["js", "ecmascript"]]);
  assert.equal(resolveAlias("JS", table), "ecmascript");
  assert.equal(resolveAlias("js", table), "ecmascript");
});

test("手写表 miss 时回落内置表：表里只有 foo→bar，K8S 仍归 kubernetes；空 Map 同样回落", () => {
  const table = new Map([["foo", "bar"]]);
  assert.equal(resolveAlias("K8S", table), "kubernetes");
  assert.equal(resolveAlias("js", new Map()), "javascript"); // 空 Map = 只走内置表
});

test("手写表命中但值为空串时穿透到内置表（命中且非空字符串才返回）", () => {
  const table = new Map([["js", ""]]);
  assert.equal(resolveAlias("js", table), "javascript");
});

// ── 4. 单跳映射：canonical 不再过表、不成环、不传递 ─────────────────────────

test("单跳：table {a→b, b→c} 下 a 归 b 而非 c（不做传递解析）", () => {
  const table = new Map([["a", "b"], ["b", "c"], ["c", "a"]]); // 人为成环也不许死循环
  assert.equal(resolveAlias("a", table), "b");
  assert.equal(resolveAlias("b", table), "c");
});

test("单跳：手写表 canonical 原样返回，不再被内置表二次映射（nodejs→js 停在 js）", () => {
  const table = new Map([["nodejs", "js"]]);
  assert.equal(resolveAlias("nodejs", table), "js"); // 若 canonical 二次过表会变成 javascript
});

// ── 5. miss 回落归一化原词；非字符串/空 → "" ───────────────────────────────

test("miss 回落：未命中任何表时返回归一化后的原词（Foo  Bar → foo bar）", () => {
  assert.equal(resolveAlias("Foo  Bar"), "foo bar");
  assert.equal(resolveAlias("  Rust Lang  "), "rust lang");
});

test("resolveAlias 非字符串/空输入返回空串（空串/纯空白/undefined/null/数字）", () => {
  assert.equal(resolveAlias(""), "");
  assert.equal(resolveAlias("   "), "");
  assert.equal(resolveAlias(undefined), "");
  assert.equal(resolveAlias(null), "");
  assert.equal(resolveAlias(42), "");
});

// ── 6. loadAliasTable：缺失 / 坏根 / 损坏 / 形状 / 校验 / 重复 / 超限 ────────

test("loadAliasTable：文件缺失（ENOENT）→空表 + error null + file 为 join 路径", async (t) => {
  const dir = await mkTmp(t);
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 0);
  assert.equal(r.error, null);
  assert.equal(r.file, join(dir, "aliases.json"));
});

test("loadAliasTable/loadClusterOverrides：sidecar 路径是目录（EISDIR，非 ENOENT 读取失败）→ 空 + error 含「读取失败」", async (t) => {
  const dir = await mkTmp(t);
  await mkdir(join(dir, "aliases.json")); // 建成目录：readFile 得 EISDIR，走「读取失败」分支
  const r1 = await loadAliasTable(dir);
  assert.equal(r1.table.size, 0);
  assert.equal(r1.file, join(dir, "aliases.json"));
  assert.match(r1.error, /读取失败/);
  const dir2 = await mkTmp(t);
  await mkdir(join(dir2, "spark-clusters.json"));
  const r2 = await loadClusterOverrides(dir2, "s");
  assert.equal(r2.overrides.size, 0);
  assert.equal(r2.file, join(dir2, "spark-clusters.json"));
  assert.match(r2.error, /读取失败/);
});

test("loadAliasTable：dataRoot 非字符串/空 → 空表 + error null + file null", async () => {
  for (const bad of [undefined, null, "", 123]) {
    const r = await loadAliasTable(bad);
    assert.equal(r.table.size, 0);
    assert.equal(r.error, null);
    assert.equal(r.file, null);
  }
});

test("loadAliasTable：坏 JSON → 降级空表 + error 含「不是合法 JSON」", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", "{ oops");
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 0);
  assert.match(r.error, /不是合法 JSON/);
});

test("loadAliasTable：顶层是数组 → error 含「顶层必须是对象」", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", []);
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 0);
  assert.match(r.error, /顶层必须是对象/);
});

test("loadAliasTable：version:2 → error 含「版本不识别」", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 2, aliases: [] });
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 0);
  assert.match(r.error, /版本不识别/);
});

test("loadAliasTable：aliases 缺失或非数组 → error「aliases 字段缺失或不是数组」", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1 });
  const r1 = await loadAliasTable(dir);
  assert.equal(r1.table.size, 0);
  assert.match(r1.error, /aliases 字段缺失或不是数组/);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: "js" });
  const r2 = await loadAliasTable(dir);
  assert.match(r2.error, /aliases 字段缺失或不是数组/);
});

test("loadAliasTable：条目非对象（字符串）→ error「aliases 条目必须是对象」", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: ["js"] });
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 0);
  assert.match(r.error, /aliases 条目必须是对象/);
});

test("loadAliasTable：条目带多余字段（恰好 alias/canonical/source 之外的键）→ 丢弃 + error", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "js", canonical: "javascript", source: "manual", extra: true },
  ]});
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 0);
  assert.match(r.error, /只允许恰好 alias\/canonical\/source/);
});

test("loadAliasTable：alias 65 字 → error 含「1..64」；恰 64 字合法", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "a".repeat(65), canonical: "javascript", source: "manual" },
  ]});
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 0);
  assert.match(r.error, /1\.\.64/);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "a".repeat(64), canonical: "b".repeat(64), source: "manual" },
  ]});
  const ok = await loadAliasTable(dir);
  assert.equal(ok.error, null);
  assert.equal(ok.table.size, 1);
});

test("loadAliasTable：alias 非字符串 / canonical 非字符串 / canonical 65 字 → 同走「1..64」错误分支", async (t) => {
  const dir = await mkTmp(t);
  // ① alias 非字符串（源码 :165 typeof alias !== "string"）
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: 42, canonical: "x", source: "manual" },
  ]});
  const r1 = await loadAliasTable(dir);
  assert.equal(r1.table.size, 0);
  assert.match(r1.error, /1\.\.64/);
  // ② canonical 非字符串（同一分支的 typeof canonical !== "string"）
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "ok", canonical: 42, source: "manual" },
  ]});
  const r2 = await loadAliasTable(dir);
  assert.equal(r2.table.size, 0);
  assert.match(r2.error, /1\.\.64/);
  // ③ canonical 65 字超限（同一分支的 canonical.length > 64）
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "ok", canonical: "b".repeat(65), source: "manual" },
  ]});
  const r3 = await loadAliasTable(dir);
  assert.equal(r3.table.size, 0);
  assert.match(r3.error, /1\.\.64/);
});

test("loadAliasTable：source 非法（\"x\"）→ error 提到 manual 或 learned", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "js", canonical: "javascript", source: "x" },
  ]});
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 0);
  assert.match(r.error, /manual 或 learned/);
});

test("loadAliasTable：归一化后 alias 重复时首条胜出（JS/js/␣js␣ 同键）", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "JS", canonical: "first-target", source: "manual" },
    { alias: "js", canonical: "second-target", source: "manual" },
    { alias: "  js  ", canonical: "third-target", source: "manual" },
  ]});
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 1);
  assert.equal(r.table.get("js"), "first-target");
});

test("loadAliasTable：error 只保留第一条错误文案，不被后续条目覆盖", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "a".repeat(65), canonical: "b", source: "manual" }, // 先发生：长度错误
    { alias: "js", canonical: "javascript", source: "x" },        // 后发生：source 错误
  ]});
  const r = await loadAliasTable(dir);
  assert.match(r.error, /1\.\.64/);
  assert.doesNotMatch(r.error, /manual 或 learned/);
});

test("loadAliasTable：坏条目之前的合法条目仍入表（已解析前缀保留）", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "js", canonical: "javascript", source: "manual" },
    { alias: "bad", canonical: "x", source: "nope" },
  ]});
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 1);
  assert.equal(r.table.get("js"), "javascript");
  assert.match(r.error, /manual 或 learned/);
});

test("loadAliasTable：513 条合法条目 → table.size 512 + error 含「上限 512」；恰 512 条无 error", async (t) => {
  const mkEntries = (count) => Array.from({ length: count }, (_, i) => ({
    alias: `a-${String(i + 1).padStart(4, "0")}`,
    canonical: `c-${String(i + 1).padStart(4, "0")}`,
    source: "manual",
  }));
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: mkEntries(513) });
  const r = await loadAliasTable(dir);
  assert.equal(r.table.size, 512);
  assert.match(r.error, /上限 512/);
  const dir2 = await mkTmp(t);
  await writeSidecar(dir2, "aliases.json", { version: 1, aliases: mkEntries(512) });
  const ok = await loadAliasTable(dir2);
  assert.equal(ok.table.size, 512);
  assert.equal(ok.error, null);
});

test("loadAliasTable：合法文件全量加载，canonical 同步归一，learned 来源同样接受", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "aliases.json", { version: 1, aliases: [
    { alias: "js", canonical: "ecmascript", source: "manual" },
    { alias: "golang", canonical: "  Go  ", source: "learned" }, // 值也过归一：trim+小写
  ]});
  const r = await loadAliasTable(dir);
  assert.equal(r.error, null);
  assert.equal(r.table.size, 2);
  assert.equal(r.table.get("js"), "ecmascript");
  assert.equal(r.table.get("golang"), "go");
});

// ── 7. loadClusterOverrides：分桶 / 缺失 / 坏形状 / 校验 / 超限 ─────────────

test("loadClusterOverrides：两 scope 各一条 → 只取本 scope 的桶，file 为 join 路径", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "spark-clusters.json", { version: 1, scopes: {
    "scope-a": { "card-1": "alpha" },
    "scope-b": { "card-2": "beta" },
  }});
  const a = await loadClusterOverrides(dir, "scope-a");
  assert.equal(a.error, null);
  assert.equal(a.overrides.size, 1);
  assert.equal(a.overrides.get("card-1"), "alpha");
  assert.equal(a.overrides.has("card-2"), false);
  assert.equal(a.file, join(dir, "spark-clusters.json"));
  const b = await loadClusterOverrides(dir, "scope-b");
  assert.equal(b.overrides.get("card-2"), "beta");
});

test("loadClusterOverrides：文件缺失 → 空 overrides + error null", async (t) => {
  const dir = await mkTmp(t);
  const r = await loadClusterOverrides(dir, "scope-a");
  assert.equal(r.overrides.size, 0);
  assert.equal(r.error, null);
  assert.equal(r.file, join(dir, "spark-clusters.json"));
});

test("loadClusterOverrides：本 scope 无桶 → 正常返回空 + error null", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "spark-clusters.json", {
    version: 1, scopes: { "scope-a": { "card-1": "alpha" } },
  });
  const r = await loadClusterOverrides(dir, "scope-other");
  assert.equal(r.overrides.size, 0);
  assert.equal(r.error, null);
});

test("loadClusterOverrides：scopeId 空串/非字符串 → error「必须是非空字符串」+ file null", async () => {
  for (const bad of ["", null, undefined, 42]) {
    const r = await loadClusterOverrides("D:/any-data-root", bad); // scopeId 校验先于读盘，不触发 IO
    assert.equal(r.overrides.size, 0);
    assert.match(r.error, /scopeId 必须是非空字符串/);
    assert.equal(r.file, null);
  }
});

test("loadClusterOverrides：dataRoot 非字符串/空（scopeId 合法）→ 空 + error null + file null", async () => {
  for (const bad of [undefined, null, "", 123]) {
    const r = await loadClusterOverrides(bad, "scope-a");
    assert.equal(r.overrides.size, 0);
    assert.equal(r.error, null);
    assert.equal(r.file, null);
  }
});

test("loadClusterOverrides：桶是数组或 null → error「必须是对象（cardId → 簇名）」", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "spark-clusters.json", { version: 1, scopes: { "s": [] } });
  const r1 = await loadClusterOverrides(dir, "s");
  assert.equal(r1.overrides.size, 0);
  assert.match(r1.error, /必须是对象/);
  await writeSidecar(dir, "spark-clusters.json", { version: 1, scopes: { "s": null } });
  const r2 = await loadClusterOverrides(dir, "s");
  assert.equal(r2.overrides.size, 0);
  assert.match(r2.error, /必须是对象/);
});

test("loadClusterOverrides：cardId 空串或超 64 字 → error「cardId 必须是 1..64 字的字符串」", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "spark-clusters.json", { version: 1, scopes: { "s": { "": "alpha" } } });
  const r1 = await loadClusterOverrides(dir, "s");
  assert.equal(r1.overrides.size, 0);
  assert.match(r1.error, /cardId 必须是 1\.\.64 字的字符串/);
  await writeSidecar(dir, "spark-clusters.json", {
    version: 1, scopes: { "s": { ["x".repeat(65)]: "alpha" } },
  });
  const r2 = await loadClusterOverrides(dir, "s");
  assert.equal(r2.overrides.size, 0);
  assert.match(r2.error, /cardId 必须是 1\.\.64 字的字符串/);
});

test("loadClusterOverrides：簇名 trim 后入表（\" 组 \"→\"组\"）；非字符串簇名 → error", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "spark-clusters.json", {
    version: 1, scopes: { "s": { "card-1": " 组 " } },
  });
  const r = await loadClusterOverrides(dir, "s");
  assert.equal(r.error, null);
  assert.equal(r.overrides.get("card-1"), "组");
  await writeSidecar(dir, "spark-clusters.json", {
    version: 1, scopes: { "s": { "card-1": 42 } },
  });
  const r2 = await loadClusterOverrides(dir, "s");
  assert.match(r2.error, /覆盖簇名/);
  assert.match(r2.error, /card-1/); // 错误文案须点名违规 cardId，便于定位
});

test("loadClusterOverrides：混合桶（合法+非法条目共存）→ 非法条目跳过不清空，合法条目保留 + error", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "spark-clusters.json", {
    version: 1, scopes: { "s": { "good": "alpha", "bad": 42, "good2": "  beta  " } },
  });
  const r = await loadClusterOverrides(dir, "s");
  assert.match(r.error, /覆盖簇名/); // 坏条目（簇名 42）记 error
  assert.equal(r.overrides.size, 2); // 非法条目被跳过；合法条目不因坏条目被清空
  assert.equal(r.overrides.get("good"), "alpha");
  assert.equal(r.overrides.get("good2"), "beta"); // 合法条目 trim 后照常入表
  assert.equal(r.overrides.has("bad"), false);
});

test("loadClusterOverrides：坏 JSON → 空 + error 含「不是合法 JSON」", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "spark-clusters.json", "{{{");
  const r = await loadClusterOverrides(dir, "s");
  assert.equal(r.overrides.size, 0);
  assert.match(r.error, /不是合法 JSON/);
});

test("loadClusterOverrides：version:2 → 「版本不识别」；scopes 非对象 → 「scopes 字段缺失或不是对象」", async (t) => {
  const dir = await mkTmp(t);
  await writeSidecar(dir, "spark-clusters.json", { version: 2, scopes: {} });
  const r1 = await loadClusterOverrides(dir, "s");
  assert.match(r1.error, /版本不识别/);
  await writeSidecar(dir, "spark-clusters.json", { version: 1, scopes: "nope" });
  const r2 = await loadClusterOverrides(dir, "s");
  assert.equal(r2.overrides.size, 0);
  assert.match(r2.error, /scopes 字段缺失或不是对象/);
});

test("loadClusterOverrides：单 scope 513 条 → 截断为 512 + error 含「上限 512」", async (t) => {
  const dir = await mkTmp(t);
  const bucket = {};
  for (let i = 1; i <= 513; i++) bucket[`card-${String(i).padStart(4, "0")}`] = `簇-${i}`;
  await writeSidecar(dir, "spark-clusters.json", { version: 1, scopes: { "s": bucket } });
  const r = await loadClusterOverrides(dir, "s");
  assert.equal(r.overrides.size, 512);
  assert.match(r.error, /上限 512/);
  assert.match(r.error, /超出部分丢弃 1 条/); // dropped 计数文案精确到 1（513 - 512）
});

// ── 8. 零 IO：loader 只读、不写盘、不建目录 ─────────────────────────────────

test("零 IO：空 tmpdir 上调两个 loader 后目录内容不变，缺失的 dataRoot 也不会被建出来", async (t) => {
  const dir = await mkTmp(t);
  assert.deepEqual(await readdir(dir), []);
  await loadAliasTable(dir);
  await loadClusterOverrides(dir, "scope-a");
  assert.deepEqual(await readdir(dir), []); // 没有任何文件/目录落地
  const missing = join(dir, "no-such-root");
  await loadAliasTable(missing);
  await loadClusterOverrides(missing, "scope-a");
  assert.equal(existsSync(missing), false); // 只读不建目录
  assert.deepEqual(await readdir(dir), []);
});
