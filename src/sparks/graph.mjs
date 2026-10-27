// Shiori P2 · L2 Sparks 安全图谱投影（Slot I）。
//
// 职责（CONTRACTS.md §I / DESIGN.md §4.3.5）：
// - 只投影当前可信 scope 的 active 节点：archived、其他 scope、superseded、merged
//   一律过滤，即便 store 返回了它们（防御 store 缺陷，不信任上游形状）；
// - 边只从节点自身的 links 派生（links 是显式关联的唯一来源；supersedes/mergedInto
//   是有向关系，不属于可投影边）；悬空边（端点不在 active 集合）、自环、重复边、
//   跨 scope 边全部丢弃并计数；
// - 输出绝不携带 content / triggers 正文：模型侧与面板初绘都只拿元数据，
//   正文必须显式走 spark_read(id)；
// - 全部排序用 UTF-16 code-unit 比较（不用 localeCompare），输入乱序输出不变，
//   不含时间戳，结果可复现（测试与审计友好）。
//
// 本模块自包含：不 import G/H 或 P1 的任何文件，唯一依赖是传入的 public record
// 形状（id, scopeId, revision, title, summary, triggers, entities, links, content,
// vitality, state —— 见 CONTRACTS.md §G）。

const VITALITY_UNKNOWN = "unknown";
/** 这些字段非空表示该卡已被合并/替代，即使 state 仍是 active 也不可投影。 */
const REDIRECT_MARKER_FIELDS = ["mergedInto", "supersededBy", "replacedBy"];

function fail(code, message, details) {
  const error = new Error(message);
  error.name = "ShioriError";
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

// 普通记录对象判定（与 P1 core/errors.mjs 同规则）：{}、字面量、Object.create(null)
// 为真；数组、Date、Map、类实例为假。防原型链污染。
function isPlainRecord(value) {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** UTF-16 code-unit 稳定比较（跨环境一致；localeCompare 随 locale 漂移，禁用）。 */
function compareStrings(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * 单条记录是否可进入当前 scope 的默认投影。
 * 必须同时满足：形状可辨（plain record + 非空 string id）、scope 完全相等、
 * state 恰为 "active"（archived/superseded/merged 等全部出局）、无重定向标记。
 * 注意：`supersedes` 指向被替代的旧卡，本卡是新卡，不构成排除条件。
 */
function isProjectable(record, scopeId) {
  if (!isPlainRecord(record) || !nonEmptyString(record.id)) return false;
  if (record.scopeId !== scopeId) return false;
  if (record.state !== "active") return false;
  for (const field of REDIRECT_MARKER_FIELDS) {
    if (nonEmptyString(record[field])) return false;
  }
  return true;
}

/** 记录被丢弃的原因分类（只计数，不携带被丢弃卡的 id，避免越权外泄）。 */
function dropRecordReason(record, scopeId) {
  if (!isPlainRecord(record) || !nonEmptyString(record.id)) return "malformed";
  if (record.scopeId !== scopeId) return "scope";
  if (record.state !== "active") return "state";
  for (const field of REDIRECT_MARKER_FIELDS) {
    if (nonEmptyString(record[field])) return "redirected";
  }
  return "unexpected";
}

/** vitality 标注：契约值为 evergreen/ephemeral；缺失或异形标注为 unknown 并计数，不静默猜测。 */
function labelVitality(record) {
  return record.vitality === "evergreen" || record.vitality === "ephemeral"
    ? record.vitality
    : VITALITY_UNKNOWN;
}

/**
 * 把 store.graph()（或 listActive()）的返回值规整为记录数组。
 * 接受：数组；或含 nodes/records/sparks 数组字段的 plain object
 * （若同时带 edges 数组则忽略——边一律由记录自身 links 派生，单一事实来源）。
 * undefined/null 视为空图；其余形状 INVALID_INPUT。
 */
export function normalizeGraphRecords(raw) {
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw)) return raw;
  if (isPlainRecord(raw)) {
    for (const key of ["nodes", "records", "sparks"]) {
      if (Array.isArray(raw[key])) return raw[key];
    }
  }
  return fail("INVALID_INPUT", "graph payload must be an array of records or an object with a nodes/records/sparks array", {
    received: Array.isArray(raw) ? "array" : typeof raw,
  });
}

/** 规范化一条 link 的 rel：非空字符串保留，其余记为 null。 */
function normalizeRel(rel) {
  return typeof rel === "string" && rel.trim().length > 0 ? rel : null;
}

/**
 * 安全图谱投影。
 *
 * @param {object} input
 * @param {string} input.scopeId 可信 scope（工厂注入，不由数据决定）
 * @param {Array} input.records 待投影的 public record 数组（可含异 scope/archived 等脏数据）
 * @returns {object} { scopeId, nodes, edges, stats }
 *   nodes: [{ id, title, summary, vitality, revision, degree }]，按 id 稳定排序；
 *   edges: [{ source, target, rel, reciprocal }]，按 (source, target, rel) 稳定排序；
 *   stats: 节点/边规模、vitality 分布与各类丢弃计数。
 */
export function projectGraph({ scopeId, records } = {}) {
  if (!nonEmptyString(scopeId)) {
    return fail("INVALID_INPUT", "projectGraph requires a non-empty string scopeId from a trusted source", {
      scopeId: typeof scopeId,
    });
  }
  if (!Array.isArray(records)) {
    return fail("INVALID_INPUT", "projectGraph requires records to be an array (use normalizeGraphRecords for store payloads)", {
      records: Array.isArray(records) ? "array" : typeof records,
    });
  }

  const dropped = {
    records: { scope: 0, state: 0, redirected: 0, malformed: 0, duplicateId: 0 },
    edges: { dangling: 0, self: 0, duplicate: 0, reciprocal: 0, malformed: 0 },
  };

  // ── 节点：过滤 + 同 id 去重（revision 数值更大者胜，平局取输入序靠前者） ──
  const kept = [];
  const byId = new Map();
  for (const record of records) {
    if (!isProjectable(record, scopeId)) {
      dropped.records[dropRecordReason(record, scopeId)] += 1;
      continue;
    }
    const existing = byId.get(record.id);
    if (existing === undefined) {
      byId.set(record.id, kept.length);
      kept.push(record);
      continue;
    }
    const prev = kept[existing];
    const prevRev = typeof prev.revision === "number" ? prev.revision : null;
    const nextRev = typeof record.revision === "number" ? record.revision : null;
    const replaces = nextRev !== null && (prevRev === null || nextRev > prevRev);
    if (replaces) kept[existing] = record;
    dropped.records.duplicateId += 1;
  }

  const nodes = kept
    .map((record) => ({
      id: record.id,
      title: typeof record.title === "string" ? record.title : null,
      summary: typeof record.summary === "string" ? record.summary : null,
      vitality: labelVitality(record),
      revision: record.revision ?? null,
      degree: 0,
    }))
    .sort((a, b) => compareStrings(a.id, b.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const recordById = new Map(kept.map((r) => [r.id, r]));

  // ── 边：从节点 links 派生；先按有向对去重，再把互逆对折叠为一条 ──
  // links 按 DESIGN §4.3.1 是双向遍历的显式关联，A→B 与 B→A 渲染为同一条线；
  // 折叠时 source 取 code-unit 较小的 id，rel 取字典序较小者，reciprocal 标记来源。
  const directed = new Map(); // "src\u0000tgt" -> { source, target, rel }
  for (const node of nodes) {
    const links = recordById.get(node.id).links;
    if (links === undefined || links === null) continue;
    if (!Array.isArray(links)) {
      dropped.edges.malformed += 1;
      continue;
    }
    for (const link of links) {
      if (!isPlainRecord(link) || !nonEmptyString(link.target)) {
        dropped.edges.malformed += 1;
        continue;
      }
      if (link.target === node.id) {
        dropped.edges.self += 1;
        continue;
      }
      if (!nodeById.has(link.target)) {
        // 端点不在本 scope active 集合：含跨 scope 指向与悬空引用，一律不计入。
        dropped.edges.dangling += 1;
        continue;
      }
      const rel = normalizeRel(link.rel);
      const key = `${node.id}\u0000${link.target}`;
      const existing = directed.get(key);
      if (existing === undefined) {
        directed.set(key, { source: node.id, target: link.target, rel });
      } else {
        // 同向重复：保留字典序较小的非空 rel，保证结果与输入顺序无关。
        if (existing.rel === null || (rel !== null && compareStrings(rel, existing.rel) < 0)) {
          existing.rel = rel;
        }
        dropped.edges.duplicate += 1;
      }
    }
  }

  const byPair = new Map(); // "min\u0000max" -> { source, target, rel, reciprocal }
  for (const edge of directed.values()) {
    const [lo, hi] = compareStrings(edge.source, edge.target) <= 0
      ? [edge.source, edge.target]
      : [edge.target, edge.source];
    const key = `${lo}\u0000${hi}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, { source: lo, target: hi, rel: edge.rel, reciprocal: false });
      continue;
    }
    if (edge.source !== existing.source) {
      existing.reciprocal = true; // 互逆对：两条有向边折叠为一条无向边
    }
    if (existing.rel === null || (edge.rel !== null && compareStrings(edge.rel, existing.rel) < 0)) {
      existing.rel = edge.rel;
    }
    dropped.edges.reciprocal += 1;
  }

  const edges = [...byPair.values()].sort((a, b) =>
    compareStrings(a.source, b.source) || compareStrings(a.target, b.target) || compareStrings(a.rel ?? "", b.rel ?? ""));
  for (const edge of edges) {
    nodeById.get(edge.source).degree += 1;
    nodeById.get(edge.target).degree += 1;
  }

  const vitality = { evergreen: 0, ephemeral: 0, unknown: 0 };
  for (const node of nodes) vitality[node.vitality] += 1;

  return {
    scopeId,
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      vitality,
      dropped,
    },
  };
}

/**
 * 模型侧回执：只有面板句柄与节点/边规模摘要（DESIGN §4.3.5「模型侧调用只返
 * 面板句柄 / 规模摘要」）。不含任何节点 id、标题、正文；详情必须 spark_read(id)。
 */
export function graphSummary(projection, { hint } = {}) {
  if (!isPlainRecord(projection) || !Array.isArray(projection.nodes) || !Array.isArray(projection.edges)) {
    return fail("INVALID_INPUT", "graphSummary requires a projectGraph() result", {});
  }
  const { scopeId, stats } = projection;
  return {
    handle: `spark-graph:${scopeId}`,
    scopeId,
    nodes: stats.nodes,
    edges: stats.edges,
    vitality: { ...stats.vitality },
    droppedRecords: sumCounts(stats.dropped.records),
    droppedEdges: sumCounts(stats.dropped.edges),
    hint: hint ?? `Graph overview only; read a card's full text with spark_read(id). Panel data comes from the host-side projection of scope ${scopeId}.`,
  };
}

function sumCounts(bucket) {
  let total = 0;
  for (const value of Object.values(bucket)) total += typeof value === "number" ? value : 0;
  return total;
}
