// Shiori P0-STORAGE · 路径与命名校验
// key 规则与 P0-CORE 的 keys.mjs（A 提交 a2）逐条对齐（R9）：Unicode 合法、
// 128 UTF-16 上限、拒绝孤立代理码元、控制字符、Windows 禁用文件名字符、
// 全点串、首空格、尾点/尾空格、Windows 保留设备名（首段+剥尾点空格+大写）、
// 与保留别名 core/core.md 冲突。B 不独自收窄公共接口。
// scopeId 在 A 语义（非空、≤128、首尾无空白、无孤立代理/控制字符）之上，
// 叠加 B 的物理映射强化：scopeId 会成为 scopes/ 下的目录名，因此额外拒绝
// 禁用文件名字符、Windows 保留名与尾点/尾空格。
// 另含：大小写碰撞检查、越根 symlink/junction 防线（含创建前预检）。

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { invalidInput } from './errors.mjs';

// Windows 保留设备名：任意大小写、任意扩展名下都不可用作文件名
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

// DESIGN §10：新 id/key 不得与 core、core.md 等保留别名冲突（小写比较）
const SHIORI_RESERVED = new Set(['core', 'core.md']);

const FORBIDDEN_CHARS = new Set([...`<>:"/\\|?*`]);

// 与 A 对齐：最终路径 <root>/scopes/<scopeId>/topics/<key>.md，
// 128 个 UTF-16 单元保证常见根路径下不超文件系统限制。
export const MAX_KEY_CHARS = 128;

function rejectPerChar(kind, value) {
  // for...of 按码点迭代：合法代理对（非 BMP 字符）不会落入孤立代理区间
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp >= 0xd800 && cp <= 0xdfff) {
      throw invalidInput(`${kind} 含孤立代理码元（U+${cp.toString(16).toUpperCase()}），UTF-8 编码会静默替换`, { kind });
    }
    if (cp <= 0x1f || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      throw invalidInput(`${kind} 含控制字符（U+${hex}）`, { kind });
    }
    if (FORBIDDEN_CHARS.has(ch)) {
      throw invalidInput(`${kind} 含 Windows 禁用文件名字符 "${ch}"`, { kind });
    }
  }
}

/** 与 A 的 validateKey 同一规则（R9 对齐，含 Unicode）。 */
export function validateKey(key) {
  if (typeof key !== 'string') {
    throw invalidInput(`topic key 必须是字符串，得到 ${typeof key}`);
  }
  if (key.length === 0) {
    throw invalidInput('topic key 不得为空');
  }
  if (key.length > MAX_KEY_CHARS) {
    throw invalidInput(`topic key 超 ${MAX_KEY_CHARS} UTF16（实际 ${key.length}）`);
  }
  rejectPerChar('topic key', key);
  if (/^\.+$/.test(key)) {
    throw invalidInput('topic key 不得全为点');
  }
  if (key.startsWith(' ')) {
    throw invalidInput('topic key 不得以空格开头');
  }
  if (key.endsWith(' ') || key.endsWith('.')) {
    throw invalidInput('topic key 不得以空格或点结尾（Windows 语义）');
  }
  const firstSegment = key.split('.')[0].replace(/[. ]+$/, '').toUpperCase();
  if (WINDOWS_RESERVED.has(firstSegment)) {
    throw invalidInput(`topic key "${key}" 与 Windows 保留设备名冲突`);
  }
  if (SHIORI_RESERVED.has(key.toLowerCase())) {
    throw invalidInput(`topic key "${key}" 与 Shiori 保留别名 core 冲突`);
  }
  return key;
}

/**
 * scopeId = A.validateScopeId 语义（非空、≤128、首尾无空白、无孤立代理/控制字符）
 * ∩ B 物理映射强化（目录名）：拒绝禁用文件名字符、Windows 保留名、尾点/尾空格。
 * 字面量 "global" 是共享 scope 的固定标记，直接放行。
 */
export function validateScopeId(scopeId) {
  if (scopeId === 'global') return scopeId;
  // scopes/ 目录物理上是 Windows 大小写不敏感的：'Global'/'GLOBAL' 会与
  // 固定的共享 scope 目录 scopes/global 合并，必须在入口拒绝
  if (scopeId.toLowerCase() === 'global') {
    throw invalidInput(`scopeId "${scopeId}" 与共享作用域 global 大小写互斥（Windows 目录不区分大小写）`);
  }
  if (typeof scopeId !== 'string' || scopeId.length === 0) {
    throw invalidInput(`scopeId 必须是非空字符串，得到 ${typeof scopeId}`);
  }
  if (scopeId.length > 128) {
    throw invalidInput(`scopeId 超 128 UTF16（实际 ${scopeId.length}）`);
  }
  if (scopeId !== scopeId.trim()) {
    throw invalidInput('scopeId 不得以空白开头或结尾');
  }
  rejectPerChar('scopeId', scopeId);
  if (scopeId.endsWith(' ') || scopeId.endsWith('.')) {
    throw invalidInput('scopeId 不得以空格或点结尾（Windows 语义）');
  }
  const firstSegment = scopeId.split('.')[0].replace(/[. ]+$/, '').toUpperCase();
  if (WINDOWS_RESERVED.has(firstSegment)) {
    throw invalidInput(`scopeId "${scopeId}" 与 Windows 保留设备名冲突`);
  }
  return scopeId;
}

export function validateOperationId(operationId) {
  if (typeof operationId !== 'string' || operationId.length === 0) {
    throw invalidInput('operationId 必须是非空字符串');
  }
  if (operationId.length > 128) {
    throw invalidInput('operationId 过长（≤128）');
  }
  if (operationId !== operationId.trim()) {
    throw invalidInput('operationId 不得含首尾空白');
  }
  if (/[/\\:]/.test(operationId) || operationId === '.' || operationId === '..') {
    throw invalidInput('operationId 含非法字符', { operationId });
  }
  // operationId 用作 journal 文件名，允许大小写字母、数字、点、下划线、连字符
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(operationId) === false) {
    throw invalidInput('operationId 只允许字母/数字/点/下划线/连字符且以字母数字开头', { operationId });
  }
  const stem = operationId.replace(/\.[A-Za-z0-9_-]+$/, '');
  if (WINDOWS_RESERVED.has(stem.toUpperCase())) {
    throw invalidInput('operationId 与 Windows 保留设备名冲突', { operationId });
  }
  return operationId;
}

/**
 * 校验 dir 下不存在与 filename 大小写不同但忽略大小写相同的文件。
 * Windows 文件系统不区分大小写，两个仅大小写不同的 key 会互相覆盖
 *（R9：Windows 大小写别名碰撞在物理层拒绝）。
 */
export async function assertNoCaseCollision(dirPath, filename) {
  let entries;
  try {
    entries = await fsp.readdir(dirPath);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const lower = filename.toLowerCase();
  for (const entry of entries) {
    if (entry.toLowerCase() === lower && entry !== filename) {
      throw invalidInput(`大小写碰撞：目录已存在 "${entry}"，与 "${filename}" 在 Windows 上互斥`, {
        dir: dirPath,
        existing: entry,
        attempted: filename,
      });
    }
  }
}

/**
 * 目标路径的已存在祖先链中不得有越出管理根的 symlink/junction。
 * - 逐级 lstat：任何 symlink/junction 组件 → realpath 解析后必须仍在 rootReal 内；
 * - 完全不存在的后缀段跳过（将由创建动作落盘，均为普通目录/文件）；
 * - 根内链接解析后继续沿真实路径检查。
 */
export async function assertNoEscapeViaSymlink(rootReal, targetPath) {
  const rel = path.relative(rootReal, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw invalidInput('目标路径越出管理根', { targetPath, root: rootReal });
  }
  const parts = rel.split(path.sep);
  let probe = rootReal;
  for (const part of parts) {
    probe = path.join(probe, part);
    let st;
    try {
      st = await fsp.lstat(probe);
    } catch (err) {
      if (err.code === 'ENOENT') break; // 后续段不存在，停止向上检查
      throw err;
    }
    if (st.isSymbolicLink()) {
      const real = await fsp.realpath(probe);
      const realRel = path.relative(rootReal, real);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
        throw invalidInput('检测到越出管理根的 symlink/junction，拒绝访问', {
          link: probe,
          resolved: real,
          root: rootReal,
        });
      }
      // 根内链接：解析后继续沿真实路径检查
      probe = real;
    }
  }
}

/** realpath 结果必须仍在 rootReal 内（创建后复核，防 TOCTOU）。 */
export function assertRealInsideRoot(rootReal, realPath) {
  const rel = path.relative(rootReal, realPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw invalidInput('路径解析后越出管理根', { realPath, root: rootReal });
  }
}

/**
 * 拼接并确认目标仍位于 rootReal 内（防拼接意外逃逸）。
 */
export function joinUnder(rootReal, ...segments) {
  const full = path.join(rootReal, ...segments);
  const rel = path.relative(rootReal, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw invalidInput('拼接结果越出管理根', { segments });
  }
  return full;
}
