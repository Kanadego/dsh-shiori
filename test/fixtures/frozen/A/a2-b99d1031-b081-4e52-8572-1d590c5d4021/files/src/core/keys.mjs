// Shiori P0-CORE · 安全 key 校验（公共契约导出 validateKey）。
// key 将成为 `topics/<key>.md` 的文件名（由 B 落盘），因此按最严格的
// 跨平台文件名规则校验：拒绝路径分隔符、盘符字符、Windows 保留设备名、
// 尾点/尾空格、控制字符，以及与 Shiori 保留别名（core）的冲突。

import { fail } from "./errors.mjs";

// Windows 保留设备名：任意大小写、任意扩展名下都不可用作文件名
//（CON.md 与 CON 同样非法）。Windows 还会忽略名字末尾的点和空格，
// 因此先剥掉再比较。
const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

// DESIGN §10：新 id/key 不得与 core、core.md 等保留别名冲突。
// 文件系统大小写不敏感，故按小写比较。
const SHIORI_RESERVED = new Set(["core", "core.md"]);

// key 上限：最终路径为 <root>/scopes/<scopeId>/topics/<key>.md，
// 128 个 UTF-16 单元可保证在常见根路径下不超文件系统限制。
export const MAX_KEY_CHARS = 128;

const FORBIDDEN_CHARS = new Set([...`<>:"/\\|?*`]);

export function validateKey(key) {
  if (typeof key !== "string") {
    fail("INVALID_INPUT", `key must be a string, got ${typeof key}`);
  }
  if (key.length === 0) {
    fail("INVALID_INPUT", "key must not be empty");
  }
  if (key.length > MAX_KEY_CHARS) {
    fail("INVALID_INPUT", `key must be at most ${MAX_KEY_CHARS} UTF-16 chars, got ${key.length}`);
  }
  // 孤立代理码元（未配对的高/低代理）在 UTF-8 编码时会被替换为 U+FFFD，
  // 两个不同的非法 key 会静默归并为同一字节序列（efbfbd），造成身份碰撞；
  // for...of 按码点迭代，合法代理对（非 BMP 字符）不会落入此区间。
  for (const ch of key) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      fail("INVALID_INPUT", `key must not contain lone surrogate code units (found U+${cp.toString(16).toUpperCase()})`);
    }
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      const hex = cp.toString(16).toUpperCase().padStart(4, "0");
      fail("INVALID_INPUT", `key must not contain control characters (found U+${hex})`);
    }
    if (FORBIDDEN_CHARS.has(ch)) {
      fail("INVALID_INPUT", `key must not contain forbidden filename character "${ch}"`);
    }
  }
  if (/^\.+$/.test(key)) {
    fail("INVALID_INPUT", "key must not consist only of dots");
  }
  if (key.startsWith(" ")) {
    fail("INVALID_INPUT", "key must not start with a space");
  }
  if (key.endsWith(" ") || key.endsWith(".")) {
    fail("INVALID_INPUT", "key must not end with a space or dot (invalid on Windows)");
  }
  const firstSegment = key.split(".")[0].replace(/[. ]+$/, "").toUpperCase();
  if (WINDOWS_RESERVED.has(firstSegment)) {
    fail("INVALID_INPUT", `key "${key}" collides with a Windows reserved device name`);
  }
  if (SHIORI_RESERVED.has(key.toLowerCase())) {
    fail("INVALID_INPUT", `key "${key}" collides with the reserved Shiori alias "core"`);
  }
  return key;
}
