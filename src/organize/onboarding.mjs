// Shiori 0.5 批次 4 · C 线：整理向导纯函数（首启引导 + 纯规则候选组）。
//
// 职责（0.5-DEV-PLAN §11.2.7 整理向导；批次 4 子任务 task-…-s2）：
// - needsOnboarding：五态判定。准入 =「无任何 topic 挂组」（挂载口径，经主审
//   追认——宿主激活路径必写默认模板组 general，字面「组清单为空」恒为假）&&
//   topic 显式 historical 计数为 0 && topic 数 ≥ 5 且标记位无
//   completedAt/dismissedAt；返回 {needed, reason}。
// - proposeGroups：纯规则聚类（标题/摘要关键词 + 共同词），输出 3–6 个候选组
//   {key, title, members[], defaultRetention}；成员不重不漏（完整划分——无信号
//   topic 收进兜底组，用户可跳过）；确定性排序（同输入同输出，含数组排列差异）。
// - proposalHash：稳定摘要（sha256，预览与应用的内容绑定 + 标记位比对）。
//
// 硬边界（对齐 organize 槽位既有约定，同 analyze/queue）：
// - 只 import node:crypto：零 fs、零副作用、不修改入参；
// - retention 枚举与 DEFAULT_RETENTION 镜像自 src/core/topics.mjs（批次 2 A 线），
//   一致性由 test/organize/onboarding.test.mjs 交叉锁定；
// - 所有排序按 UTF-16 码点二进制序，绝不依赖系统 locale；
// - 聚类全规则化：分词停用词表内建，无随机值、无时间戳、无 LLM 建议；
// - 候选组只是建议，不含任何批准 / 执行语义（应用走 management 层既有通道）。
// - 归档口径：本模块不自行剔除归档 topic——调用方（plugin/management.mjs 的
//   onboardingTopicsFor）先过滤出未归档行再传入，needsOnboarding / proposeGroups
//   拿到的就是未归档人群。因此向导预览的计数只含未归档，与 group_manage list
//   的组行计数（含已归档、按主组计）天然不同，不是计数 bug。
//
// 错误码统一 Error.code = INVALID_INPUT（形状 / 数据错误即刻显式失败，不静默纠正）。

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 常量（镜像冻结实现的同一规则，仅作输入校验 / 输出缺省，不改变其语义）
// ---------------------------------------------------------------------------

/** 首启触发下限：topic 数不足该值不触发、proposeGroups 返回空。 */
export const ONBOARDING_MIN_TOPICS = 5;

/** 候选组数量边界（§11.2.7：3–6 个）。 */
export const ONBOARDING_MIN_GROUPS = 3;
export const ONBOARDING_MAX_GROUPS = 6;

/** 提案版本（proposal 稳定序列化与标记位比对用；形状变化时递增）。 */
export const ONBOARDING_PROPOSAL_VERSION = 1;

// retention 枚举镜像自 src/core/topics.mjs（RETENTION_VALUES / DEFAULT_RETENTION）。
// 组条目与 topic 元数据的合法枚举同源；一致性由测试交叉锁定。
export const ONBOARDING_RETENTION_VALUES = Object.freeze(["standing", "historical"]);
export const ONBOARDING_DEFAULT_RETENTION = "standing";

/** 兜底组（无信号 topic 的收留组；用户可跳过——跳过组的成员不归组）。 */
export const ONBOARDING_LEFTOVER_KEY = "uncategorized";
export const ONBOARDING_LEFTOVER_TITLE = "未归类";

// 停用词表（小写 ASCII 词 + CJK 高频二元组）：纯停用，不追求完备——只求把最
// 明显的噪声词从聚类信号里去掉。命中表即丢弃，不影响其余词。
const STOPWORDS = new Set([
  // 英文功能词（频率最高的一小撮）
  "the", "and", "for", "with", "this", "that", "from", "are", "was", "were",
  "have", "has", "had", "not", "but", "all", "can", "will", "one", "two",
  "into", "out", "about", "after", "before", "when", "then", "than", "there",
  "here", "what", "which", "who", "how", "why", "where", "also", "just",
  "only", "more", "most", "some", "any", "each", "other", "been", "being",
  // 英文泛化动词/代词（对专题名无区分度）
  "use", "used", "using", "get", "got", "make", "made", "do", "does", "did",
  "you", "your", "our", "their", "his", "her", "them", "they",
  // 中文高频功能字/词的二元组（单字不成词，见分词实现）
  "一个", "一些", "一点", "一下", "什么", "怎么", "怎样", "可以", "可能",
  "应该", "需要", "我们", "你们", "他们", "自己", "这个", "那个", "这些",
  "那些", "时候", "问题", "方面", "地方", "内容", "东西", "事情", "如果",
  "因为", "所以", "但是", "然后", "或者", "以及", "通过", "进行", "出现",
  "没有", "不是", "就是", "还是", "已经", "正在", "不了", "的话", "来说",
  "相关", "之间", "上面", "下面", "里面", "外面", "以前", "以后", "今天",
]);

// Windows 保留设备名 / Shiori 保留别名（镜像 src/core/keys.mjs，用于兜底组与
// 派生组 key 的防碰撞改写；一致性由测试锁定）。
const RESERVED_KEYS = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
  "CORE",
]);

/** UTF-16 码点二进制比较（与平台 locale 无关）。 */
const byCodepoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fail(message, details) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  if (details !== undefined) error.details = details;
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** 组 key 防碰撞改写：保留名加前缀、重复名追加序号（确定性）。 */
function dedupeKey(candidate, taken) {
  let base = candidate;
  if (RESERVED_KEYS.has(base.toUpperCase()) || base.toLowerCase() === "core") base = `g-${base}`;
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const next = `${base}-${i}`;
    if (!taken.has(next)) return next;
  }
}

// ---------------------------------------------------------------------------
// 输入校验（轻量：topic 行形状按 service.listTopics 的实际产出约束）
// ---------------------------------------------------------------------------

/**
 * 校验 topic 行数组（listTopics 行的子集形状）：key/title/summary 必须满足
 * core validateTopic 的同款不变量（key/title 非空串、summary 串）；retention
 * 在场时必须是合法枚举；group 在场时必须是非空字符串数组（空数组/缺省 =
 * 未分组）。坏数据显式失败，不静默纠正。返回原数组引用（不改入参）。
 */
function validateTopicRows(topics, where) {
  if (!Array.isArray(topics)) fail(`${where} 必须是数组`, { where });
  const seenKeys = new Set();
  for (let i = 0; i < topics.length; i += 1) {
    const topic = topics[i];
    if (!isPlainObject(topic)) fail(`${where}[${i}] 必须是普通对象`, { index: i });
    if (typeof topic.key !== "string" || topic.key.length === 0) {
      fail(`${where}[${i}].key 必须是非空字符串`, { index: i });
    }
    // key 是 proposeGroups 的成员身份（分组映射以 key 为键），同 scope 重复 key
    // 是存储层错误——这里显式拒绝，不做静默去重。
    if (seenKeys.has(topic.key)) {
      fail(`${where} 存在重复 key "${topic.key}"`, { index: i, key: topic.key });
    }
    seenKeys.add(topic.key);
    if (typeof topic.title !== "string" || topic.title.length === 0) {
      fail(`${where}[${i}].title 必须是非空字符串`, { index: i, key: topic.key });
    }
    if (typeof topic.summary !== "string") {
      fail(`${where}[${i}].summary 必须是字符串`, { index: i, key: topic.key });
    }
    if (topic.retention !== undefined
      && !ONBOARDING_RETENTION_VALUES.includes(topic.retention)) {
      fail(`${where}[${i}].retention 必须是 standing/historical 之一`, {
        index: i, key: topic.key, retention: topic.retention,
      });
    }
    if (topic.group !== undefined && topic.group !== null && !Array.isArray(topic.group)) {
      fail(`${where}[${i}].group 必须是非空字符串数组或 null`, { index: i, key: topic.key });
    }
  }
  return topics;
}

// ---------------------------------------------------------------------------
// needsOnboarding：五态判定
// ---------------------------------------------------------------------------

// 五态（reason 枚举；优先级从上到下）：
//   marked          —— completedAt / dismissedAt 已存在（markedKind 区分子态）
//   grouped         —— 任一 topic 已挂组（挂载口径）
//   has-historical  —— topic 显式 retention=historical 计数 > 0（迁移已完成过）
//   too-few-topics  —— topic 数 < 5（没有聚类价值）
//   needed          —— 以上全不成立：向导应触发
// 口径说明（两处都经评审确认）：
// - 「已归组」按挂载口径（∃topic.group 非空）而非 groups.length === 0——宿主
//   激活路径总写默认模板组 general（controller resourcesFor → ensureGroupsFile），
//   字面上的「组清单为空」在真实部署里恒为假，向导将永不触发；
// - 组级 retention 策略（groups.json 条目的 retention）不参与「historical 为 0」
//   判定——§11.2.7 按 topic 显式字段计数。
// groups 参数仍必传：参与输入校验与计数透出（面板卡片显示当前组数），不参与
// 五态判定本身。
export const ONBOARDING_REASONS = Object.freeze([
  "marked", "grouped", "has-historical", "too-few-topics", "needed",
]);

/**
 * 首启向导触发判定（纯函数）。
 *
 * @param {object} input
 * @param {Array<{key:string, retention?:string}>} input.topics     当前 scope 可见 topic 行
 * @param {Array<object>} input.groups     当前 scope 组清单条目（空数组 = 未分组）
 * @param {{dismissedAt?:string, completedAt?:string}|null} [input.onboarding]
 *        stateRoot/onboarding.json 解析结果；null/undefined = 无标记位
 * @returns {{needed: boolean, reason: string, markedKind: "completed"|"dismissed"|null}}
 */
export function needsOnboarding(input) {
  if (!isPlainObject(input)) fail("needsOnboarding 参数必须是对象");
  const allowed = new Set(["topics", "groups", "onboarding"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) fail(`needsOnboarding 含未知字段 "${key}"（允许：topics/groups/onboarding）`, { key });
  }
  if (!Array.isArray(input.groups)) fail("needsOnboarding groups 必须是数组");
  const { topics, groups, onboarding } = input;
  validateTopicRows(topics, "needsOnboarding topics");

  let flag = null;
  if (onboarding !== undefined && onboarding !== null) {
    if (!isPlainObject(onboarding)) fail("needsOnboarding onboarding 必须是对象或 null");
    for (const field of ["dismissedAt", "completedAt"]) {
      const value = onboarding[field];
      // null = 无标记（state.onboardingStore.read 的归一化形状）；空串/非串仍拒。
      if (value !== undefined && value !== null && (typeof value !== "string" || value.length === 0)) {
        fail(`needsOnboarding onboarding.${field} 必须是非空字符串、null 或缺省`, { field });
      }
    }
    flag = onboarding;
  }

  const markedKind = flag?.completedAt ? "completed" : (flag?.dismissedAt ? "dismissed" : null);
  if (markedKind !== null) return { needed: false, reason: "marked", markedKind };
  const mounted = topics.some((topic) => Array.isArray(topic.group) && topic.group.length > 0);
  if (mounted) return { needed: false, reason: "grouped", markedKind: null };
  const historicalCount = topics.filter((t) => t.retention === "historical").length;
  if (historicalCount > 0) return { needed: false, reason: "has-historical", markedKind: null };
  if (topics.length < ONBOARDING_MIN_TOPICS) {
    return { needed: false, reason: "too-few-topics", markedKind: null };
  }
  return { needed: true, reason: "needed", markedKind: null };
}

// ---------------------------------------------------------------------------
// proposeGroups：纯规则聚类
// ---------------------------------------------------------------------------

const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;
const ASCII_WORD = /[a-z0-9]+/g;

/**
 * 提取一个文本源的分词（小写 ASCII 词 ≥2 字符 + CJK 串的二元组；命中停用词
 * 表即丢弃；长度 > MAX_TOKEN_CHARS 的 ASCII 词直接丢弃——超长词多为粘贴噪声，
 * 用作组 key 会撞 core/keys.mjs 的 MAX_KEY_CHARS=128 且面板改不了 key，宁可
 * 不让它进聚类信号）。确定性：正则全局序 = 文本序；输出去重保序。
 */
const MAX_TOKEN_CHARS = 32;

function tokenizeSource(text) {
  const out = [];
  const seen = new Set();
  const push = (token) => {
    if (token.length < 2 || token.length > MAX_TOKEN_CHARS || STOPWORDS.has(token) || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  const lower = text.toLowerCase();
  for (const word of lower.match(ASCII_WORD) ?? []) push(word);
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 1 < run.length; i += 1) push(run.slice(i, i + 2));
  }
  return out;
}

/**
 * 分词：标题（权重 2）+ 摘要（权重 1）。返回 {all: Set, title: Set}——
 * all 供文档频率与共现边，title 供标题关键词加权。
 */
function tokenizeTopic(topic) {
  const title = new Set(tokenizeSource(typeof topic.title === "string" ? topic.title : ""));
  const all = new Set(title);
  for (const token of tokenizeSource(typeof topic.summary === "string" ? topic.summary : "")) {
    all.add(token);
  }
  return { all, title };
}

/**
 * 并查集（连通分量与合并顺序无关，天然输入序不变）。
 */
function unionFind(count) {
  const parent = new Array(count);
  for (let i = 0; i < count; i += 1) parent[i] = i;
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  return {
    union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    },
    components() {
      const map = new Map();
      for (let i = 0; i < count; i += 1) {
        const root = find(i);
        if (!map.has(root)) map.set(root, []);
        map.get(root).push(i);
      }
      return [...map.values()];
    },
  };
}

/**
 * 在一个组内找拆分用判别词：df ∈ [2, size) 的成员共享词，按 (df 降序, 词码点升序)
 * 取第一个能把组分成两个非空部分的；找不到返回 null。
 */
function findSplitToken(memberIndexes, topicRows, tokensByIndex) {
  const df = new Map();
  for (const index of memberIndexes) {
    for (const token of tokensByIndex[index].all) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const size = memberIndexes.length;
  const candidates = [...df.entries()]
    .filter(([, count]) => count >= 2 && count < size)
    .sort((a, b) => b[1] - a[1] || byCodepoint(a[0], b[0]));
  for (const [token] of candidates) {
    const left = memberIndexes.filter((index) => tokensByIndex[index].all.has(token));
    const right = memberIndexes.filter((index) => !tokensByIndex[index].all.has(token));
    if (left.length > 0 && right.length > 0) return { token, left, right };
  }
  return null;
}

/** 确定性拆最大组：优先判别词二分，无判别词时按 key 序对半开。 */
function splitLargest(groups, topicRows, tokensByIndex) {
  let largest = -1;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i].length < 2) continue;
    if (largest === -1
      || groups[i].length > groups[largest].length
      || (groups[i].length === groups[largest].length
        && byCodepoint(topicRows[groups[i][0]].key, topicRows[groups[largest][0]].key) < 0)) {
      largest = i;
    }
  }
  if (largest === -1) return false; // 全是单元素组，拆不动
  const members = groups[largest];
  const sorted = members.slice().sort((a, b) => byCodepoint(topicRows[a].key, topicRows[b].key));
  const split = findSplitToken(sorted, topicRows, tokensByIndex);
  let left;
  let right;
  if (split !== null) {
    left = split.left;
    right = split.right;
  } else {
    const half = Math.floor(sorted.length / 2);
    left = sorted.slice(0, half);
    right = sorted.slice(half);
  }
  groups.splice(largest, 1, left, right);
  return true;
}

/** 组主词（组内 df 最高；并列取码点最小），无共享词时返回 null。 */
function dominantToken(memberIndexes, tokensByIndex) {
  const df = new Map();
  for (const index of memberIndexes) {
    for (const token of tokensByIndex[index].all) df.set(token, (df.get(token) ?? 0) + 1);
  }
  let best = null;
  for (const [token, count] of df) {
    if (count < 2) continue; // 组内只出现一次的词不配命名
    if (best === null || count > df.get(best) || (count === df.get(best) && byCodepoint(token, best) < 0)) {
      best = token;
    }
  }
  return best;
}

/** 组展示名：ASCII 词首字母大写；CJK 词原样。 */
function titleOfToken(token) {
  if (/^[a-z]/.test(token)) return token.charAt(0).toUpperCase() + token.slice(1);
  return token;
}

/**
 * 纯规则聚类提议（零写入；确定性；成员不重不漏）。
 *
 * 前置（不满足返回 []，与 needsOnboarding 同口径）：
 *   - topics < 5 条；
 *   - 任一 topic 已挂组（group 数组非空）。
 * 聚类管线：
 *   1. 分词：标题 + 摘要（ASCII 词 ≥2 且 ≤32 字符 + CJK 二元组，内建停用词
 *      表；超长词丢弃——见 tokenizeSource）；
 *   2. 连边：两 topic 共享任一「共享词」（df ∈ [2, N)）即连边，权重 =
 *      标题共享词×2 + 其余共享词×1；并查集取连通分量（与输入顺序无关）；
 *   3. 收敛到 ≤5 个实质簇：按（成员数降序, 首成员 key 升序）排序，多余簇
 *      并入兜底组；兜底组非空时占第 6 席（总 ≤6）；
 *   4. 不足 3 组时确定性拆最大组（判别词二分优先，退化按 key 序对半开）；
 *   5. 命名：组内 df 最高的共享词（并列取码点最小）；无共享词的组——单成员
 *      用该 topic 的标题命名，多成员用兜底名「未归类」；key 冲突/保留名自动
 *      改写去重。
 *
 * @param {Array<{key:string, title:string, summary:string, group?:string[]}>} topics
 * @param {object} [options] 闭合：{ takenKeys?: string[] }——既有组清单的 key
 *   （management 传入），预置进命名去重集合，保证提案 key 恒不与既有组撞名
 *   （面板只能改 title、key 只读，撞名即死路，故在提议源头规避）。
 * @returns {Array<{key:string, title:string, members:string[], defaultRetention:string}>}
 */
export function proposeGroups(topics, options) {
  validateTopicRows(topics, "proposeGroups topics");
  if (options !== undefined && options !== null) {
    if (!isPlainObject(options)) fail("proposeGroups options 必须是对象或缺省");
    for (const key of Object.keys(options)) {
      if (key !== "takenKeys") fail(`proposeGroups options 含未知字段 "${key}"（允许：takenKeys）`, { key });
    }
    if (options.takenKeys !== undefined && options.takenKeys !== null) {
      if (!Array.isArray(options.takenKeys)
        || options.takenKeys.some((k) => typeof k !== "string" || k.length === 0)) {
        fail("proposeGroups options.takenKeys 必须是非空字符串数组或缺省");
      }
    }
  }
  if (topics.length < ONBOARDING_MIN_TOPICS) return [];
  for (const topic of topics) {
    if (Array.isArray(topic.group) && topic.group.length > 0) return []; // 已归组
  }

  const rows = topics.map((topic, index) => ({ topic, index }));
  const tokensByIndex = topics.map(tokenizeTopic);

  // 文档频率（title ∪ summary）；共享词 = df ∈ [2, N)：只出现一次的词连不了
  // 边，全员共享的词没有区分度（会把所有 topic 黏成一团）。
  const total = topics.length;
  const docFreq = new Map();
  for (const tokens of tokensByIndex) {
    for (const token of tokens.all) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }
  const isShared = (token) => {
    const count = docFreq.get(token);
    return count >= 2 && count < total;
  };

  // 连边 + 并查集：连通分量与合并顺序无关 → 输入数组任意排列同输出。
  const uf = unionFind(total);
  for (let i = 0; i < total; i += 1) {
    for (let j = i + 1; j < total; j += 1) {
      let weight = 0;
      for (const token of tokensByIndex[i].all) {
        if (!isShared(token) || !tokensByIndex[j].all.has(token)) continue;
        weight += tokensByIndex[i].title.has(token) && tokensByIndex[j].title.has(token) ? 2 : 1;
      }
      if (weight > 0) uf.union(i, j);
    }
  }

  // 组件整理：全程用 topic 下标（成员身份映射唯一的稳定键），成员按 topic key
  // 码点序；组件按（成员数降序, 首成员 key 升序）。
  const components = uf.components().map((members) => members
    .slice()
    .sort((a, b) => byCodepoint(topics[a].key, topics[b].key)));
  components.sort((a, b) => b.length - a.length || byCodepoint(topics[a[0]].key, topics[b[0]].key));

  // 收敛到 ≤5 实质簇 + 可选兜底（总 ≤6）。
  const leftover = [];
  while (components.length > 5) {
    leftover.push(...components.pop());
  }
  leftover.sort((a, b) => byCodepoint(topics[a].key, topics[b].key));
  const clusters = components;
  if (leftover.length > 0) clusters.push(leftover);

  // 不足 3 组：确定性拆最大组（此时无兜底组——兜底只在 >5 簇时产生）。
  while (clusters.length < ONBOARDING_MIN_GROUPS) {
    if (!splitLargest(clusters, topics, tokensByIndex)) break;
  }
  // 理论不可达（topics ≥ 5 且成员不重不漏时总可拆到 3 组）；防御性兜底：
  // 拆不动且仍 <3 时放弃聚类（宁可少提议也不给乱分组）。
  if (clusters.length < ONBOARDING_MIN_GROUPS) return [];

  // 命名 + 出线。key 冲突按「先大后小、码点序」处理（dedupeKey 确定性）；
  // takenKeys 预置既有组清单 key——提案 key 恒不与既有组撞名（R5①：撞名
  // 在提议源头规避，面板改不了 key）。
  const taken = new Set(options?.takenKeys ?? []);
  const groups = clusters.map((memberIndexes) => {
    const dominant = dominantToken(memberIndexes, tokensByIndex);
    let key;
    let title;
    if (dominant !== null) {
      key = dominant;
      title = titleOfToken(dominant);
    } else if (memberIndexes.length === 1) {
      const single = topics[memberIndexes[0]];
      key = single.key;
      title = single.title;
    } else {
      key = ONBOARDING_LEFTOVER_KEY;
      title = ONBOARDING_LEFTOVER_TITLE;
    }
    const finalKey = dedupeKey(key, taken);
    taken.add(finalKey);
    return {
      key: finalKey,
      title,
      members: memberIndexes.map((index) => topics[index].key).sort(byCodepoint),
      defaultRetention: ONBOARDING_DEFAULT_RETENTION,
    };
  });

  // 组序：成员数降序、key 码点升序（确定性；与簇排序口径一致）。
  groups.sort((a, b) => b.members.length - a.members.length || byCodepoint(a.key, b.key));
  return groups;
}

/** topic 行 key 读取（validateTopicRows 已保证非空字符串）。 */
function topicKeyOf(topic) {
  return topic.key;
}

// ---------------------------------------------------------------------------
// proposal 规范化 + proposalHash：预览与应用的内容绑定
// ---------------------------------------------------------------------------

/**
 * 校验并规范化用户确认后的提案（面板编辑产物）。形状（闭合）：
 *   { groups: [{key, title, members, defaultRetention, overrides?}],
 *     ungrouped: [topicKey...] }
 * overrides（可选，逐条 retention 调整）：{topicKey: "standing"|"historical"}，
 * 键必须是该组成员、值必须合法枚举；空对象按缺省处理（规范化后不出键）。
 * 不变量：groups 1..6 且 key 唯一；每组成员 ≥1 且组内唯一（组内重复成员显式
 * 拒绝，不静默去重）；defaultRetention 合法枚举；跨组 + ungrouped 成员不重
 * （完整性=并集覆盖全部 topic，由调用方对照 topics 校验，本函数只查结构）。
 * 注意口径差异（评审 P2-8① 点名）：ungrouped 是集合语义——重复成员静默去重
 * （它表达「未归组的人群」，天然是集合）；组内 members 则严格拒绝重复。
 * 返回全新规范化对象（groups 按 key 序、members 去重升序、ungrouped 去重升序、
 * overrides 键序稳定），不改入参。
 */
export function validateProposal(proposal) {
  if (!isPlainObject(proposal)) fail("proposal 必须是普通对象");
  const allowed = new Set(["groups", "ungrouped"]);
  for (const key of Object.keys(proposal)) {
    if (!allowed.has(key)) fail(`proposal 含未知字段 "${key}"（允许：groups/ungrouped）`, { key });
  }
  if (!Array.isArray(proposal.groups)) fail("proposal.groups 必须是数组");
  if (proposal.groups.length < 1 || proposal.groups.length > ONBOARDING_MAX_GROUPS) {
    fail(`proposal.groups 必须是 1..${ONBOARDING_MAX_GROUPS} 个组（实际 ${proposal.groups.length}）`, {
      count: proposal.groups.length,
    });
  }
  if (proposal.ungrouped !== undefined && !Array.isArray(proposal.ungrouped)) {
    fail("proposal.ungrouped 必须是数组");
  }
  const seenTopicKeys = new Set();
  const claimTopic = (topicKey, where) => {
    if (typeof topicKey !== "string" || topicKey.length === 0) {
      fail(`${where} 成员必须是非空字符串`);
    }
    if (seenTopicKeys.has(topicKey)) fail(`${where} 成员 "${topicKey}" 重复（成员不重不漏）`, { topicKey });
    seenTopicKeys.add(topicKey);
  };
  const seenGroupKeys = new Set();
  const groups = proposal.groups.map((group, index) => {
    const where = `proposal.groups[${index}]`;
    if (!isPlainObject(group)) fail(`${where} 必须是普通对象`);
    for (const field of ["key", "title", "members", "defaultRetention"]) {
      if (!Object.hasOwn(group, field)) fail(`${where} 缺少必填字段 "${field}"`, { field });
    }
    for (const key of Object.keys(group)) {
      if (!["key", "title", "members", "defaultRetention", "overrides"].includes(key)) {
        fail(`${where} 含未知字段 "${key}"`, { key });
      }
    }
    if (typeof group.key !== "string" || group.key.length === 0) fail(`${where}.key 必须是非空字符串`);
    if (typeof group.title !== "string" || group.title.length === 0) fail(`${where}.title 必须是非空字符串`);
    if (!Array.isArray(group.members) || group.members.length < 1) {
      fail(`${where}.members 必须是非空数组（空组请删掉或跳过）`);
    }
    if (!ONBOARDING_RETENTION_VALUES.includes(group.defaultRetention)) {
      fail(`${where}.defaultRetention 必须是 standing/historical 之一`, { value: group.defaultRetention });
    }
    if (seenGroupKeys.has(group.key)) fail(`${where}.key "${group.key}" 重复`, { key: group.key });
    seenGroupKeys.add(group.key);
    // 成员先逐条查类型与组内唯一（显式拒绝，不静默去重——与 organize 槽位
    // applyConverge 对批内重复 id 同款 fail-closed），再规范化升序。
    const seenMembers = new Set();
    for (const member of group.members) {
      if (typeof member !== "string" || member.length === 0) {
        fail(`${where}.members 必须是非空字符串数组`, { member });
      }
      if (seenMembers.has(member)) fail(`${where}.members 存在重复成员 "${member}"`, { member });
      seenMembers.add(member);
    }
    const members = [...seenMembers].sort(byCodepoint);
    for (const member of members) claimTopic(member, where);
    // overrides（可选）：键必须是本组成员、值合法枚举；空对象按缺省丢弃。
    let overrides;
    if (group.overrides !== undefined && group.overrides !== null) {
      if (!isPlainObject(group.overrides)) fail(`${where}.overrides 必须是对象或缺省`);
      const entries = Object.entries(group.overrides);
      for (const [topicKey, value] of entries) {
        if (!members.includes(topicKey)) {
          fail(`${where}.overrides["${topicKey}"] 不是该组成员`, { topicKey });
        }
        if (!ONBOARDING_RETENTION_VALUES.includes(value)) {
          fail(`${where}.overrides["${topicKey}"] 必须是 standing/historical 之一`, { value });
        }
      }
      if (entries.length > 0) {
        overrides = {};
        for (const topicKey of Object.keys(group.overrides).sort(byCodepoint)) {
          overrides[topicKey] = group.overrides[topicKey];
        }
      }
    }
    const canonical = {
      key: group.key,
      title: group.title,
      members,
      defaultRetention: group.defaultRetention,
    };
    if (overrides !== undefined) canonical.overrides = overrides;
    return canonical;
  });
  groups.sort((a, b) => byCodepoint(a.key, b.key));
  const ungrouped = [...new Set(proposal.ungrouped ?? [])];
  for (const member of ungrouped) claimTopic(member, "proposal.ungrouped");
  ungrouped.sort(byCodepoint);
  // 返回输入同形状（无 version 键）：可再入 validateProposal/proposalHash 幂等。
  // version 由 proposalHash 包进哈希载荷，不进提案对象本身。
  return { groups, ungrouped };
}

/**
 * 提案完整性校验（可选第二参 topics）：groups ∪ ungrouped 必须恰好覆盖全部
 * topic（不重由 validateProposal 保证，不漏在此检查）。缺 topics 时跳过完整性。
 */
export function assertProposalCoversTopics(proposal, topics) {
  if (topics === undefined) return;
  validateTopicRows(topics, "assertProposalCoversTopics topics");
  const allKeys = new Set(topics.map(topicKeyOf));
  const covered = new Set([
    ...proposal.groups.flatMap((group) => group.members),
    ...proposal.ungrouped,
  ]);
  for (const key of allKeys) {
    if (!covered.has(key)) fail(`提案未覆盖 topic "${key}"（成员不重不漏）`, { topicKey: key });
  }
  for (const key of covered) {
    if (!allKeys.has(key)) fail(`提案引用了未知 topic "${key}"`, { topicKey: key });
  }
}

/**
 * 稳定摘要：对规范化后的提案计算 sha256（稳定序列化——键排序、数组保序）。
 * 同一提案（组/成员任意排列）同哈希；预览、应用与标记位比对共用。
 * 返回小写 64 hex。
 */
export function proposalHash(proposal) {
  const canonical = validateProposal(proposal);
  return sha256Stable({ version: ONBOARDING_PROPOSAL_VERSION, groups: canonical.groups, ungrouped: canonical.ungrouped });
}

/** 稳定序列化 + sha256（键递归排序；数组顺序保持）。 */
function sha256Stable(value) {
  return createHash("sha256").update(Buffer.from(stableStringify(value), "utf8")).digest("hex");
}

/** 递归键排序序列化（与 organize 槽位 stable 同公式）。 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort(byCodepoint);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
