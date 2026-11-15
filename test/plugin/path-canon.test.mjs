// 0.4-S2（#e8a569）· src/storage/path-canon.mjs 单测：
// comparableRoot 的 canonical 形状（win32 大小写/分隔符/尾随分隔符、盘根折叠）
// 与 resolveWithLinks 的「已存在祖先 realpath + 尾部」、盘根回退及错误工厂语义。
// 全部使用系统 temp 的合成目录，不写死绝对路径；用后清理。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { CASE_INSENSITIVE_FS, comparableRoot, resolveWithLinks } from "../../src/storage/path-canon.mjs";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "shiori-path-canon-"));

test.after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("CASE_INSENSITIVE_FS 跟随平台：仅 win32 为 true", () => {
  assert.equal(CASE_INSENSITIVE_FS, process.platform === "win32");
});

test("comparableRoot：盘根折叠（POSIX 根 → \"\"，win32 盘符根 → 裸盘符）", () => {
  assert.equal(comparableRoot("/"), "");
  if (CASE_INSENSITIVE_FS) {
    assert.equal(comparableRoot("C:\\"), "c:");
    assert.equal(comparableRoot("d:/"), "d:");
  }
});

test("comparableRoot：win32 下 D:/a/、D:\\a、d:/A 折叠成同一形状", { skip: process.platform !== "win32" }, () => {
  const fromForwardSlash = comparableRoot("D:/a/");
  const fromBackslash = comparableRoot("D:\\a");
  const fromMixedCase = comparableRoot("d:/A");
  assert.equal(fromForwardSlash, fromBackslash);
  assert.equal(fromForwardSlash, fromMixedCase);
  assert.equal(fromForwardSlash, "d:\\a");
});

test("comparableRoot：同名前缀目录折叠后仍是不同形状（嵌套判定不误判）", () => {
  const work = comparableRoot(join(TMP_ROOT, "work"));
  const workshop = comparableRoot(join(TMP_ROOT, "workshop"));
  assert.notEqual(work, workshop);
  assert.ok(!workshop.startsWith(work + sep), "work + sep 不是 workshop 的前缀，不能被判为嵌套");
});

test("resolveWithLinks：不存在的尾部拼在已存在祖先的 realpath 之后", () => {
  const base = join(TMP_ROOT, "existing");
  mkdirSync(base, { recursive: true });
  const target = join(base, "missing", "deeper");
  assert.equal(resolveWithLinks(target), join(realpathSync(base), "missing", "deeper"));
});

test("resolveWithLinks：已存在路径直接返回 realpath", () => {
  const base = join(TMP_ROOT, "existing");
  mkdirSync(base, { recursive: true });
  assert.equal(resolveWithLinks(base), realpathSync(base));
});

test("resolveWithLinks：退到不存在的盘根时按字面返回 target", { skip: process.platform !== "win32" }, () => {
  // 找一个当前不存在（realpath 抛 ENOENT）的盘符根；全部盘符都在时本用例无法构造盘根回退。
  let missingRoot = null;
  for (const letter of "QRSTUVWXYZAB") {
    const root = `${letter}:\\`;
    try {
      realpathSync(root);
    } catch (error) {
      if (error && error.code === "ENOENT") {
        missingRoot = root;
        break;
      }
    }
  }
  assert.ok(missingRoot !== null, "需要至少一个不存在的盘符来验证盘根回退");
  const target = join(missingRoot, "shiori-no-such-dir");
  assert.equal(resolveWithLinks(target), target);
});

test("resolveWithLinks：非 ENOENT 错误经 onError 工厂包装，抛出的正是注入的类型", () => {
  class InjectedError extends Error {}
  // NUL 字节在任何平台都会让 realpath 抛非 ENOENT 的错，用于稳定触发包装分支。
  const target = `${join(TMP_ROOT, "bad")}\u0000tail`;
  let threw = null;
  try {
    resolveWithLinks(target, (message) => new InjectedError(message));
  } catch (error) {
    threw = error;
  }
  assert.ok(threw instanceof InjectedError, "错误工厂返回的错误必须原样抛出");
  assert.ok(threw.message.startsWith(`cannot resolve "${target}":`), `message: ${threw.message}`);
});

test("resolveWithLinks：不传 onError 时抛普通 Error 且 code 为 INVALID_INPUT", () => {
  const target = `${join(TMP_ROOT, "bad")}\u0000tail`;
  let threw = null;
  try {
    resolveWithLinks(target);
  } catch (error) {
    threw = error;
  }
  assert.ok(threw instanceof Error);
  assert.equal(threw.constructor, Error, "不传工厂时必须是普通 Error（非子类）");
  assert.equal(threw.code, "INVALID_INPUT");
  assert.ok(threw.message.startsWith(`cannot resolve "${target}":`), `message: ${threw.message}`);
});
