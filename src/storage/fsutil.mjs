// Shiori P0-STORAGE · 文件系统基础操作
// fsync 文件必须显式调用；Windows 不支持目录 fsync（open 目录句柄会失败），
// 此处提供 best-effort 版本，POSIX 上生效，Windows 上静默跳过——
// 这是已知限制，崩溃安全主要由 journal 协议保证，见 docs/storage/README.md。

import { createHash, randomBytes } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { invalidInput, invalidState } from './errors.mjs';

// ignoreBOM:true = 保留 U+FEFF 于输出（默认会把 BOM 剥掉，导致 BOM 检测失效）
const strictDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * 严格 UTF-8 解码：磁盘字节损坏（无效序列）时抛 INVALID_STATE，
 * 绝不静默生成 U+FFFD 替换字符（R6）。
 */
export function decodeUtf8Strict(buf, where) {
  try {
    return strictDecoder.decode(buf);
  } catch (err) {
    throw invalidState(`${where}: 文件字节不是合法 UTF-8，拒绝静默替换`, {
      where,
      error: err.message,
    });
  }
}

/** 是否含孤立 UTF-16 代理码元（无法无损编码为 UTF-8，会静默变 U+FFFD）。 */
export function hasLoneSurrogate(str) {
  for (let i = 0; i < str.length; i += 1) {
    const c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
      if (!(d >= 0xdc00 && d <= 0xdfff)) return true;
      i += 1; // 合法代理对，跳过低代理
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** 写入路径守卫：拒绝不可无损编码的字符串（R5）。成对非 BMP 字符不受影响。 */
export function assertEncodableUtf8(str, where) {
  if (hasLoneSurrogate(str)) {
    throw invalidInput(`${where} 含孤立 UTF-16 代理码元，无法无损写入（拒绝静默替换）`, { where });
  }
}

/** @returns {string} 64 位小写 hex SHA256 */
export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** 读取文件字节；不存在返回 null。 */
export async function readFileOrNull(filePath) {
  try {
    return await fsp.readFile(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 文件在磁盘上的实际 UTF-8 字节哈希；不存在返回 null。
 * 契约：revision = SHA256(磁盘实际文件字节)。
 */
export async function hashFileOrNull(filePath) {
  const buf = await readFileOrNull(filePath);
  return buf === null ? null : sha256Buffer(buf);
}

/**
 * 写入并 fsync 单个文件。覆盖已有内容。
 */
export async function writeFileSynced(filePath, data) {
  const handle = await fsp.open(filePath, 'w');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * 原子替换：同目录写临时文件 + fsync + rename 覆盖目标。
 * Windows 上 Node 的 rename 使用 MoveFileExW(REPLACE_EXISTING)。
 */
export async function atomicReplace(filePath, data) {
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${randomBytes(6).toString('hex')}`,
  );
  try {
    await writeFileSynced(tmp, data);
    await fsp.rename(tmp, filePath);
  } finally {
    await fsp.unlink(tmp).catch(() => {});
  }
}

/** best-effort 目录 fsync；Windows 跳过。 */
export async function fsyncDirBestEffort(dirPath) {
  try {
    const handle = await fsp.open(dirPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows / 平台不支持目录句柄：由 journal 协议兜底
  }
}

/**
 * 稳定 JSON 序列化：键排序后拼接，用于 payload 哈希，
 * 保证同 payload 不同对象键序产生相同哈希。
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
