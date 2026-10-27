// Shiori P0-STORAGE · 持久 prepare/commit/recovery 日志
//
// journal/<operationId>.json 是提交协议的唯一进行中状态真相源：
// - phase=prepared   : staging 已写、备份未开始；恢复时验证目标均在 before 态后中止
// - phase=committing : 备份已完成，rename 可能部分发生；恢复时补完或回滚
// - phase=committed  : 全部 rename 完成；恢复时推进 generation 指针
// - phase=aborted    : 中止（含冲突详情），目标回到 before 态
//
// journal 写入 = 临时文件 + fsync + rename（atomicReplace）。

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { sha256Buffer, stableStringify, atomicReplace } from './fsutil.mjs';

export function journalPath(rootReal, operationId) {
  return path.join(rootReal, 'journal', `${operationId}.json`);
}

/**
 * 稳定 payload 哈希：trusted scopeId + expectedGeneration + changes 逐键排序后哈希。
 * scopeId 是 factory 由宿主注入的可信作用域，必须纳入操作身份：
 * 同 root 下不同 scope 用同一 operationId 重放，不得命中彼此的成功结果（R1）。
 */
export function computePayloadHash({ scopeId, expectedGeneration, changes }) {
  return sha256Buffer(
    Buffer.from(stableStringify({
      scopeId: scopeId ?? null,
      expectedGeneration: expectedGeneration ?? null,
      changes,
    })),
  );
}

export async function readJournal(rootReal, operationId) {
  const p = journalPath(rootReal, operationId);
  try {
    const raw = await fsp.readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    // 损坏的 journal 属严重状态：上抛由 recover/调用方决策，不静默跳过
    const wrapped = new Error(`journal ${operationId} 损坏: ${err.message}`);
    wrapped.code = 'INVALID_STATE';
    wrapped.cause = err;
    throw wrapped;
  }
}

export async function saveJournal(rootReal, journal) {
  journal.updatedAt = new Date().toISOString();
  await atomicReplace(journalPath(rootReal, journal.operationId), Buffer.from(JSON.stringify(journal, null, 2), 'utf8'));
}

/**
 * journal 协议形状校验（J1）：合法 JSON 但结构损坏的记录不得被静默遗漏——
 * 枚举到的每个 journal 文件要么给出有效记录，要么给出带原因的 corrupted 记录。
 * 校验先于一切清理/恢复/指针推导决策；损坏记录的路径字段一律不可信、不使用。
 */
const JOURNAL_PHASES = new Set(['prepared', 'committing', 'committed', 'aborted']);

function validateJournalShape(j, stem) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return '不是 plain object';
  const problems = [];
  if (typeof j.operationId !== 'string' || j.operationId.length === 0) {
    problems.push('缺少 operationId');
  } else if (j.operationId !== stem) {
    problems.push(`operationId "${j.operationId}" 与文件名 "${stem}" 不一致`);
  }
  if (typeof j.scopeId !== 'string' || j.scopeId.length === 0) problems.push('缺少 scopeId');
  if (typeof j.payloadHash !== 'string' || j.payloadHash.length === 0) problems.push('缺少 payloadHash');
  if (!JOURNAL_PHASES.has(j.phase)) problems.push(`phase 非法: ${JSON.stringify(j.phase)}`);
  for (const field of ['generationBefore', 'generationAfter']) {
    if (!Number.isInteger(j[field]) || j[field] < 0) problems.push(`${field} 非非负整数`);
  }
  if (!Array.isArray(j.changes)) problems.push('changes 不是数组');
  return problems.length === 0 ? null : problems.join('; ');
}

/** 列出 journal 目录全部日志，按 generationBefore 升序（链式恢复顺序）。 */
export async function listJournals(rootReal) {
  const dir = path.join(rootReal, 'journal');
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const stem = name.slice(0, -'.json'.length);
    let j = null;
    try {
      const raw = await fsp.readFile(path.join(dir, name), 'utf8');
      j = JSON.parse(raw);
    } catch (err) {
      out.push({ corrupted: true, file: name, stem, reason: `JSON 解析失败: ${err.message}` });
      continue;
    }
    const shapeProblem = validateJournalShape(j, stem);
    if (shapeProblem !== null) {
      out.push({ corrupted: true, file: name, stem, reason: `协议形状损坏: ${shapeProblem}` });
      continue;
    }
    out.push(j);
  }
  out.sort((a, b) => (a.generationBefore ?? Number.MAX_SAFE_INTEGER)
    - (b.generationBefore ?? Number.MAX_SAFE_INTEGER));
  return out;
}

/** 新 journal 骨架。scopeId 为提交发生时的可信 active 作用域（操作身份的一部分）。 */
export function newJournal({ operationId, scopeId, payloadHash, generationBefore, generationAfter, changes }) {
  return {
    version: 1,
    operationId,
    scopeId,
    payloadHash,
    phase: 'prepared',
    generationBefore,
    generationAfter,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    changes,
  };
}
