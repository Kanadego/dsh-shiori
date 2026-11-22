// Shiori P0-STORAGE · topic front-matter（合法 YAML 的 JSON 双引号标量严格子集）
//
// 输出格式（本模块序列化的唯一权威形态）：
//   ---
//   key: "topic-key"
//   title: "标题"
//   summary: "≤60 UTF16，允许空串"
//   updated: "2026-10-24T00:00:00.000Z"
//   scopeId: "amber"
//   archivedAt: "2026-11-07T00:00:00.000Z"   ← 可选；空/缺省时整行省略
//   archiveOrigin: "auto-inactive"           ← 可选（0.5 A 线）；缺省 manual 整行省略
//   retention: "historical"                  ← 可选（0.5 A 线）；缺省 standing 整行省略
//                                             （显式写 standing 也省略属有意归一化，
//                                              见下方写入策略说明）
//   group: ["dev", "self"]                   ← 可选（0.4 S3）；空数组/缺省时整行省略
//   pinned: true                             ← 可选（0.4 S3）；false/缺省时整行省略
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
// - archivedAt（归档标记，ISO 时间串）：可选字段，磁盘上有值即归档、
//   删掉即恢复（真相只在专题文件本身，不另开账本）；老文件没有该字段 = 未归档；
// - archiveOrigin / retention（0.5 批次 2 A 线保留策略）：可选枚举标量，磁盘上
//   没有时按默认值读（archiveOrigin = "manual"——已有 archivedAt 但无来源的旧
//   文件即人工归档；retention = "standing"），不回写磁盘，老文件原样保留；
//   磁盘上的非法枚举值 → INVALID_STATE（显式拒绝，不静默纠正成默认值——
//   静默纠正会把「手改坏数据」伪装成合法状态）；
// - 显式写 standing（0.5 批次 8-4 口径钉死）：standing 是缺省值，写出侧
//   对「显式 standing」与「缺省」一视同仁地省略整行，属**有意的归一化**而非
//   信息丢失——读取侧两者都还原为 standing，语义等价；因此磁盘上显式写下的
//   retention: "standing" 经 parse → rewrite 后会消失。需要「磁盘保留用户
//   原样字节」的场景不适用本模块（写入侧只承诺语义往返，不承诺字节保持）。
//   测试见 test/storage/frontmatter.test.mjs「有意归一化」用例；
// - group（0.4 S3 分组）：可选，JSON 双引号字符串数组标量（如 ["dev","self"]，
//   是 YAML 流序列的合法子集）；元素必须为非空字符串且不重复；缺省 = 未分组。
//   group/pinned 与新字段不混入 meta 字符串记录，作为独立字段随解析结果返回
//   （缺省补 [] / false / standing / manual），读取路径绝不写盘——老文件
//   front-matter 原样保留；
// - pinned（0.4 S3 钉住标记）：可选，仅接受 plain 标量 true/false；缺省 = false；
// - 解码后的值含孤立代理码元 → INVALID_STATE（无法无损再序列化）；
// - 未知字段允许（前向兼容），但必须也是单行标量；
// - 闭合 --- 之后的全部字节为 body，逐字保留（含 CRLF）。

import { invalidInput, invalidState } from './errors.mjs';
import { decodeUtf8Strict, hasLoneSurrogate, isCanonicalIso } from './fsutil.mjs';
// 枚举与默认值以 core/topics.mjs 为唯一权威（0.5 A 线），storage 侧只引用不复制，
// 避免两处常量漂移（storage → core 单向依赖，与 groups 的 I/O 下沉同向）。
import {
  DEFAULT_RETENTION, DEFAULT_ARCHIVE_ORIGIN, RETENTION_VALUES, ARCHIVE_ORIGIN_VALUES,
} from '../core/topics.mjs';

const REQUIRED_FIELDS = ['key', 'title', 'summary', 'updated', 'scopeId'];
const NON_EMPTY_FIELDS = ['key', 'title', 'updated', 'scopeId'];

/**
 * 序列化 topic 文件字节。所有字符串先做可无损编码校验（R5）。
 * archivedAt 为可选归档标记（ISO 时间串）：空值/缺省时整行省略（= 未归档）。
 * archiveOrigin / retention（0.5 A 线）为可选枚举标量：缺省值（manual / standing）
 * 或 null 时整行省略（= 旧文件形状不变）；非默认值必须属于合法枚举，否则
 * INVALID_INPUT（不许静默纠正）。
 * group（0.4 S3）为可选字符串数组（首个是主组）：空数组/缺省时整行省略（= 未分组）。
 * pinned（0.4 S3）为可选布尔：false/缺省时整行省略（= 不钉住）。
 * @param {{key:string,title:string,summary:string,updated:string,scopeId:string,
 *          archivedAt?:string, archiveOrigin?:string, retention?:string,
 *          group?:string[], pinned?:boolean,
 *          extra?:Record<string,string>}} meta
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
  // 归档标记：有值即归档，空/缺省 = 未归档，序列化时省略（不写空行）
  if (meta.archivedAt !== undefined && meta.archivedAt !== null && meta.archivedAt !== '') {
    const value = meta.archivedAt;
    if (typeof value !== 'string') {
      throw invalidInput('front-matter 字段 "archivedAt" 必须是字符串（ISO 时间串）');
    }
    if (hasLoneSurrogate(value)) {
      throw invalidInput('front-matter 字段 "archivedAt" 含孤立代理码元，无法无损写入');
    }
    if (!isCanonicalIso(value)) {
      // P2-1/A1：V8 宽松解析会放行英文日期/裸年份/滚动假日期，与 ISO 8601 承诺不符；
      // 写入侧统一要求规范 UTC ISO（new Date(v).toISOString()===v）。
      throw invalidInput(`front-matter 字段 "archivedAt" 必须是规范 UTC ISO 8601 时间串`
        + `（如 "2026-11-07T00:00:00.000Z"），收到: "${value.slice(0, 60)}"`);
    }
    lines.push(`archivedAt: ${JSON.stringify(value)}`);
    seen.add('archivedAt');
  }
  // 保留策略枚举（0.5 A 线）：缺省值/空值省略整行（老文件与默认数据零变化）；
  // '' 是清除哨兵（与 archivedAt 同款：写 null 清除时以空串流经继承链，序列化
  // 层省略整行 = 磁盘回到缺省口径）；其余非默认值必须是合法枚举成员，否则
  // INVALID_INPUT（不许静默纠正）。
  // 显式 standing 同样落在 fallback 分支被省略：0.5 批次 8-4 拍板为**有意的
  // 归一化**（standing 是缺省值，读取侧无差别还原；语义往返成立），不是丢数据。
  // 两个字段都在写入侧校验，与读取侧（parse 侧 INVALID_STATE）形成同一组枚举。
  for (const [name, values, fallback] of [
    ['archiveOrigin', ARCHIVE_ORIGIN_VALUES, DEFAULT_ARCHIVE_ORIGIN],
    ['retention', RETENTION_VALUES, DEFAULT_RETENTION],
  ]) {
    const value = meta[name];
    if (value === undefined || value === null || value === '' || value === fallback) continue;
    if (typeof value !== 'string') {
      throw invalidInput(`front-matter 字段 "${name}" 必须是字符串枚举标量`);
    }
    if (hasLoneSurrogate(value)) {
      throw invalidInput(`front-matter 字段 "${name}" 含孤立代理码元，无法无损写入`);
    }
    if (!values.includes(value)) {
      throw invalidInput(`front-matter 字段 "${name}" 必须是 ${values.map((v) => JSON.stringify(v)).join(' | ')} 之一，收到: ${JSON.stringify(value.slice(0, 60))}`);
    }
    lines.push(`${name}: ${JSON.stringify(value)}`);
    seen.add(name);
  }
  // 分组（0.4 S3）：非空字符串数组输出为 JSON 数组标量（YAML 流序列子集）；
  // 空数组/缺省省略（= 未分组），老文件不受影响。元素不得重复。
  if (meta.group !== undefined && meta.group !== null) {
    if (!Array.isArray(meta.group)) {
      throw invalidInput('front-matter 字段 "group" 必须是字符串数组');
    }
    if (meta.group.length > 0) {
      const groupSeen = new Set();
      for (const el of meta.group) {
        if (typeof el !== 'string' || el.length === 0) {
          throw invalidInput('front-matter 字段 "group" 的元素必须是非空字符串');
        }
        if (hasLoneSurrogate(el)) {
          throw invalidInput('front-matter 字段 "group" 含孤立代理码元，无法无损写入');
        }
        if (groupSeen.has(el)) {
          throw invalidInput(`front-matter 字段 "group" 含重复组 key: "${el}"`);
        }
        groupSeen.add(el);
      }
      lines.push(`group: ${JSON.stringify(meta.group)}`);
      seen.add('group');
    }
  }
  // 钉住标记（0.4 S3）：true 时输出；false/缺省省略（= 不钉住）。
  if (meta.pinned !== undefined && meta.pinned !== null && meta.pinned !== false) {
    if (meta.pinned !== true) {
      throw invalidInput('front-matter 字段 "pinned" 必须是布尔值 true/false');
    }
    lines.push('pinned: true');
    seen.add('pinned');
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
 * 解析 group 字段值（0.4 S3）：必须是 JSON 字符串数组标量（YAML 流序列子集）。
 * 元素必须为非空字符串、不含孤立代理码元、不重复。
 */
function parseGroupArray(value, name) {
  if (!value.startsWith('[')) {
    throw invalidState(`front-matter 字段 "${name}" 必须是 JSON 字符串数组（如 ["dev","self"]）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidState(`front-matter 字段 "${name}" 的数组标量不是合法 JSON`);
  }
  if (!Array.isArray(parsed)) {
    throw invalidState(`front-matter 字段 "${name}" 必须是字符串数组`);
  }
  const out = [];
  const seen = new Set();
  for (const el of parsed) {
    if (typeof el !== 'string' || el.length === 0) {
      throw invalidState(`front-matter 字段 "${name}" 的元素必须是非空字符串`);
    }
    if (hasLoneSurrogate(el)) {
      throw invalidState(`front-matter 字段 "${name}" 含孤立代理码元（无法无损处理）`);
    }
    if (seen.has(el)) {
      throw invalidState(`front-matter 字段 "${name}" 含重复组 key: "${el}"`);
    }
    seen.add(el);
    out.push(el);
  }
  return out;
}

/**
 * 解析枚举标量字段（0.5 A 线 retention / archiveOrigin 共用）：
 * 值必须是合法枚举成员（双引号 JSON 字符串或 plain 标量在上方通用路径已解码），
 * 磁盘上的非法枚举值 → INVALID_STATE（显式拒绝，不静默纠正成默认值）。
 */
function parseEnumScalar(value, name, values) {
  if (!values.includes(value)) {
    throw invalidState(`front-matter 字段 "${name}" 必须是 ${values.map((v) => JSON.stringify(v)).join(' | ')} 之一，收到: ${JSON.stringify(value.slice(0, 60))}`);
  }
  return value;
}

/**
 * 解析 topic 文件字节。
 * @param {Buffer} raw 磁盘原始字节
 * @returns {{hasFrontMatter: true, meta: Record<string,string>, body: string,
 *            group: string[], pinned: boolean, retention: string, archiveOrigin: string}
 *          | {hasFrontMatter: false}}  无 front-matter 时返回 legacy 标记；
 *          group/pinned 为 0.4 S3 新增读取口径、retention/archiveOrigin 为 0.5 A 线
 *          新增读取口径：磁盘上没有该字段时补默认 [] / false / standing / manual
 *          （缺省读取，不回写磁盘，老文件 front-matter 原样保留）
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
  // 0.4 S3：group/pinned 是一等可选字段，不混入 meta 字符串记录；
  // 0.5 A 线：retention/archiveOrigin 同款处理（强类型枚举，缺省补默认值）。
  // 磁盘上出现时解析为强类型（string[] / boolean / 枚举字符串），缺省补默认值。
  let groupValue;
  let pinnedValue;
  let retentionValue;
  let archiveOriginValue;
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
    if (name === 'group') {
      if (groupValue !== undefined) {
        throw invalidState('front-matter 字段重复: "group"');
      }
      groupValue = parseGroupArray(value, name);
      continue;
    }
    if (name === 'pinned') {
      if (pinnedValue !== undefined) {
        throw invalidState('front-matter 字段重复: "pinned"');
      }
      if (value === 'true') {
        pinnedValue = true;
        continue;
      }
      if (value === 'false') {
        pinnedValue = false;
        continue;
      }
      throw invalidState(`front-matter 字段 "pinned" 必须是 true/false 布尔标量，收到: "${value.slice(0, 60)}"`);
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
    // 0.5 A 线：retention/archiveOrigin 在通用解码（双引号 JSON 标量或 plain 标量）
    // 之后做枚举校验——序列化输出为双引号形态，读取必须接受同一形态；
    // 作为一等可选字段返回（不混入 meta 字符串记录），磁盘非法枚举值
    // INVALID_STATE（显式拒绝，不静默纠正成默认值）。
    if (name === 'retention') {
      if (retentionValue !== undefined) {
        throw invalidState('front-matter 字段重复: "retention"');
      }
      retentionValue = parseEnumScalar(value, name, RETENTION_VALUES);
      continue;
    }
    if (name === 'archiveOrigin') {
      if (archiveOriginValue !== undefined) {
        throw invalidState('front-matter 字段重复: "archiveOrigin"');
      }
      archiveOriginValue = parseEnumScalar(value, name, ARCHIVE_ORIGIN_VALUES);
      continue;
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
  return {
    hasFrontMatter: true,
    meta,
    body,
    group: groupValue ?? [],
    pinned: pinnedValue ?? false,
    // 0.5 A 线：缺省读取口径——旧文件没有这两个键时按默认值读（不回写磁盘）；
    // 已有 archivedAt 但无 archiveOrigin 的文件即人工归档（manual）。
    retention: retentionValue ?? DEFAULT_RETENTION,
    archiveOrigin: archiveOriginValue ?? DEFAULT_ARCHIVE_ORIGIN,
  };
}
