// Shiori P0-STORAGE · topic front-matter（合法 YAML 的 JSON 双引号标量严格子集）
//
// 输出格式（本模块序列化的唯一权威形态）：
//   ---
//   key: "topic-key"
//   title: "标题"
//   summary: "≤60 UTF16，允许空串"
//   updated: "2026-10-24T00:00:00.000Z"
//   scopeId: "amber"
//   ---
//   <body 逐字节保留>
//
// 解析规则（严格子集，不引入 yaml 依赖）：
// - 磁盘字节必须为合法 UTF-8（严格解码，损坏显式 INVALID_STATE，不静默替换）；
// - 文件以 BOM 开头 → INVALID_STATE（不静默剥离，避免"精确 body"失真）；
// - 首行必须是 ---，随后是 name: value 行，直到闭合 --- 行；
// - value 支持 JSON 双引号标量（JSON.parse，是 YAML 双引号的子集）
//   或保守的单行 plain 标量；块标量/列表/嵌套 map → INVALID_STATE；
// - 必填字段：key/title/summary/updated/scopeId 必须存在；summary 允许空串，
//   其余不得为空（与 A.validateTopic 的读写规则一致，R7）；
// - 解码后的值含孤立代理码元 → INVALID_STATE（无法无损再序列化）；
// - 未知字段允许（前向兼容），但必须也是单行标量；
// - 闭合 --- 之后的全部字节为 body，逐字保留（含 CRLF）。

import { invalidInput, invalidState } from './errors.mjs';
import { decodeUtf8Strict, hasLoneSurrogate } from './fsutil.mjs';

const REQUIRED_FIELDS = ['key', 'title', 'summary', 'updated', 'scopeId'];
const NON_EMPTY_FIELDS = ['key', 'title', 'updated', 'scopeId'];

/**
 * 序列化 topic 文件字节。所有字符串先做可无损编码校验（R5）。
 * @param {{key:string,title:string,summary:string,updated:string,scopeId:string, extra?:Record<string,string>}} meta
 * @param {string} body
 * @returns {Buffer}
 */
export function serializeTopicFile(meta, body) {
  const lines = ['---'];
  const order = ['key', 'title', 'summary', 'updated', 'scopeId'];
  const seen = new Set();
  const emit = (name, value) => {
    if (typeof value !== 'string') {
      throw invalidInput(`front-matter 字段 "${name}" 必须是字符串`);
    }
    if (hasLoneSurrogate(value)) {
      throw invalidInput(`front-matter 字段 "${name}" 含孤立代理码元，无法无损写入`);
    }
    lines.push(`${name}: ${JSON.stringify(value)}`);
  };
  for (const name of order) {
    emit(name, String(meta[name] ?? ''));
    seen.add(name);
  }
  if (meta.extra) {
    for (const name of Object.keys(meta.extra).sort()) {
      if (!seen.has(name)) {
        emit(name, meta.extra[name]);
      }
    }
  }
  if (hasLoneSurrogate(body)) {
    throw invalidInput('topic body 含孤立代理码元，无法无损写入');
  }
  lines.push('---');
  const head = `${lines.join('\n')}\n`;
  return Buffer.from(head + body, 'utf8');
}

/**
 * 解析 topic 文件字节。
 * @param {Buffer} raw 磁盘原始字节
 * @returns {{hasFrontMatter: true, meta: Record<string,string>, body: string}
 *          | {hasFrontMatter: false}}  无 front-matter 时返回 legacy 标记
 */
export function parseTopicFile(raw) {
  const text = decodeUtf8Strict(raw, 'topic 文件');
  if (text.charCodeAt(0) === 0xfeff) {
    throw invalidState('topic 文件带 UTF-8 BOM，属不支持格式（请另存为无 BOM UTF-8）');
  }

  const nl = text.indexOf('\n');
  const firstLine = (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, '');
  if (firstLine !== '---') {
    return { hasFrontMatter: false };
  }

  // 扫描 front-matter 行与闭合分隔线
  let pos = nl + 1;
  const metaLines = [];
  let bodyStart = -1;
  for (;;) {
    if (pos >= text.length) {
      throw invalidState('front-matter 缺少闭合 --- 分隔线');
    }
    const nl2 = text.indexOf('\n', pos);
    const line = (nl2 === -1 ? text.slice(pos) : text.slice(pos, nl2)).replace(/\r$/, '');
    const after = nl2 === -1 ? text.length : nl2 + 1;
    if (line === '---') {
      bodyStart = after;
      break;
    }
    metaLines.push(line);
    pos = after;
  }
  const body = text.slice(bodyStart); // 逐字保留，含行尾风格

  const meta = {};
  for (const line of metaLines) {
    if (line.trim() === '') {
      throw invalidState('front-matter 含空行，属不支持格式');
    }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?$/.exec(line);
    if (!m) {
      throw invalidState(`front-matter 行无法按严格子集解析: "${line.slice(0, 60)}"`);
    }
    const name = m[1];
    let value = m[2];
    if (value === undefined) {
      // `field:`（裸空值）是 YAML null 语义，不属于本严格子集
      throw invalidState(`front-matter 字段 "${name}" 缺少值（空字符串请写 "..."）`);
    }
    if (value.startsWith('"')) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed !== 'string') {
          throw new Error('not a string');
        }
        value = parsed;
      } catch {
        throw invalidState(`front-matter 字段 "${name}" 的双引号标量不是合法 JSON 字符串`);
      }
    } else {
      // 保守 plain 标量：单行、无 YAML 特殊指示符开头、无 ": " / " #"
      if (value === '') {
        throw invalidState(`front-matter 字段 "${name}" 值为空`);
      }
      if (/^[-?!&*{}[\],>|>%@`#]/.test(value) || /:\s/.test(value) || /\s#/.test(value)
          || value !== value.trim()) {
        throw invalidState(`front-matter 字段 "${name}" 使用了严格子集之外的 YAML 语法`);
      }
    }
    if (hasLoneSurrogate(value)) {
      throw invalidState(`front-matter 字段 "${name}" 含孤立代理码元（无法无损处理）`);
    }
    if (Object.prototype.hasOwnProperty.call(meta, name)) {
      throw invalidState(`front-matter 字段重复: "${name}"`);
    }
    meta[name] = value;
  }

  // 必填字段必须存在；summary 允许空串，其余不得为空（R7：区分缺失与空值）
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(meta, field)) {
      throw invalidState(`front-matter 缺少必填字段 "${field}"`);
    }
  }
  for (const field of NON_EMPTY_FIELDS) {
    if (meta[field].length === 0) {
      throw invalidState(`front-matter 字段 "${field}" 不得为空`);
    }
  }
  return { hasFrontMatter: true, meta, body };
}

/**
 * 从无 front-matter 的旧 Markdown 提取可读元数据（只读兼容，影子报告用）。
 * title 取首个 `# ` 标题；summary 取首个非空正文行（不截断，
 * 截断策略由 store 层按影子规则处理并留报告）。
 */
export function parseLegacyMarkdown(raw) {
  const text = decodeUtf8Strict(raw, 'topic 文件(legacy)');
  let title = null;
  let summary = null;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (title === null && /^#\s+/.test(t)) {
      title = t.replace(/^#\s+/, '');
      continue;
    }
    if (t !== '' && !/^#/.test(t) && summary === null) {
      summary = t;
    }
    if (title !== null && summary !== null) break;
  }
  return { title: title ?? '', summary: summary ?? '', body: text };
}
