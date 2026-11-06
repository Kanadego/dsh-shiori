// Shiori F1b · 离线召回评测（不进 npm test；需要真实模型）。
//
// 用 test/semantic/eval-fixtures.json 的全部夹具跑三种模式的 recall@k 对照：
//   literal — 现有字面匹配（matchSparks 的 seeds ∪ related 是否含期望卡）；
//   vector  — 纯向量 top-k（不经历闸门，纯检索口径：cosine 排序前 k 是否含期望卡）；
//   merged  — F1b 合并召回（mergeSemanticRecall 的 seeds ∪ related 是否含期望卡）。
//
// 用法：
//   node scripts/eval-recall.mjs [--dtype q8|fp32|fp16] [--k 5] [--model <repo-id>] [--cache-dir <path>]
//
// 模型缓存解析顺序（任务书 i 条：模型不存在时可用 SPIKE 环境变量指向 spike 目录）：
//   1) --cache-dir 参数；
//   2) 环境变量 SPIKE_MODELS（或 SPIKE），如 /path/to/spike/models；
//   3) 空字符串（transformers.js 默认缓存位置；首次会经 mirror 下载 23–91MB）。
// 镜像默认 https://hf-mirror.com/（与配置线默认一致；可用 --mirror 覆盖）。
//
// 注意：本脚本会真实加载模型（q8 23MB / fp32 91MB），不属于测试套件；
// CI / npm test 永远不会执行它。

import { readFileSync } from "node:fs";
import { createEmbeddingProvider, cosineSimilarity } from "../src/semantic/index.mjs";
import { matchSparks } from "../src/sparks/match.mjs";
import { mergeSemanticRecall } from "../src/sparks/semantic-recall.mjs";

// ── 参数解析 ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { dtype: "q8", k: 5 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dtype") args.dtype = argv[++i];
    else if (arg === "--k") args.k = Number(argv[++i]);
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--cache-dir") args.cacheDir = argv[++i];
    else if (arg === "--mirror") args.mirror = argv[++i];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("用法: node scripts/eval-recall.mjs [--dtype q8|fp32|fp16] [--k 5] [--model <repo-id>] [--cache-dir <path>] [--mirror <url>]");
  console.log("模型缓存: --cache-dir > 环境变量 SPIKE_MODELS/SPIKE > transformers.js 默认缓存");
  process.exit(0);
}

const cacheDir = args.cacheDir ?? process.env.SPIKE_MODELS ?? process.env.SPIKE ?? "";
const mirror = args.mirror ?? "https://hf-mirror.com/";
const model = args.model ?? "Xenova/bge-small-zh-v1.5";
const k = Number.isInteger(args.k) && args.k > 0 ? args.k : 5;

const fixtures = JSON.parse(readFileSync(new URL("../test/semantic/eval-fixtures.json", import.meta.url), "utf8"));
const SCOPE = "eval-scope";
const SESSION = "eval-session";
const EPOCH = 0;

// 夹具卡片 → matchSparks 卡片形状（revision≥1 才有种子资格）。
const cards = fixtures.cards.map((card) => ({
  id: card.id,
  title: card.title,
  triggers: card.triggers,
  entities: card.entities ?? [],
  links: [],
  scopeId: SCOPE,
  state: "active",
  revision: 1,
}));

console.log(`模型: ${model}  dtype: ${args.dtype}  cacheDir: ${cacheDir || "(transformers 默认)"}  mirror: ${mirror}`);
console.log(`夹具: ${fixtures.cases.length} 条用例 / ${cards.length} 张卡  k=${k}`);

let provider;
try {
  provider = createEmbeddingProvider({
    provider: "local",
    local: { model, dims: 512, dtype: args.dtype, cacheDir, mirror },
  });
} catch (error) {
  console.error(`创建 provider 失败（${error.code ?? "UNCODED"}）：${error.message}`);
  process.exit(1);
}

console.log("加载模型 / 生成卡片向量…");
let cardVecs; // sparkId -> { revision, vec }（与 mergeSemanticRecall 的 vectorsFor 契约一致）
try {
  cardVecs = new Map();
  for (const card of cards) {
    cardVecs.set(card.id, { revision: card.revision, vec: await provider.embed(card.title) });
  }
} catch (error) {
  console.error(`模型加载失败（${error.code ?? "UNCODED"}）：${error.message}`);
  if (error.code === "SEMANTIC_UNAVAILABLE" && !cacheDir) {
    console.error("提示：本机没有模型缓存时，可用 SPIKE 环境变量指向已有模型目录，例如：");
    console.error("  SPIKE_MODELS=/path/to/spike/models node scripts/eval-recall.mjs");
  }
  process.exit(1);
}
const vectorsFor = (sparkId) => cardVecs.get(sparkId) ?? null;

// ── 三种模式 ────────────────────────────────────────────────────────────────

// literal：matchSparks 投递面（seeds ∪ related）。
function literalHit(utterance, expectCardId) {
  const match = matchSparks({
    scopeId: SCOPE, userText: utterance, sparks: cards,
    seenKeys: [], sessionId: SESSION, contextEpoch: EPOCH,
    maxSeeds: 3, maxRelated: 2,
  });
  const ids = new Set([...match.seeds, ...match.related].map((s) => s.id));
  return ids.has(expectCardId);
}

// vector：纯相似度 top-k（检索口径，不经闸门）——逐条用例 embed 查询后
// 在主循环里直接算（见下），不封装成函数。

// merged：F1b 合并召回投递面。
async function mergedHit(utterance, expectCardId) {
  const outcome = await mergeSemanticRecall({
    scopeId: SCOPE, userText: utterance, sparks: cards,
    seenKeys: [], sessionId: SESSION, contextEpoch: EPOCH,
    maxSeeds: 3, maxRelated: 2,
    provider,
    vectorsFor,
  });
  const ids = new Set([...outcome.match.seeds, ...outcome.match.related].map((s) => s.id));
  return ids.has(expectCardId);
}

const rows = [];
let counts = { literal: 0, vector: 0, merged: 0 };
for (const testCase of fixtures.cases) {
  const query = await provider.embed(testCase.utterance);
  const ranked = cards
    .map((card) => ({ id: card.id, cos: cosineSimilarity(query, cardVecs.get(card.id).vec) }))
    .sort((a, b) => (b.cos !== a.cos ? b.cos - a.cos : (a.id < b.id ? -1 : 1)));
  const vectorHitK = ranked.slice(0, k).some((r) => r.id === testCase.expectCardId);
  const top1 = ranked[0];
  const literal = literalHit(testCase.utterance, testCase.expectCardId);
  const merged = await mergedHit(testCase.utterance, testCase.expectCardId);
  if (literal) counts.literal += 1;
  if (vectorHitK) counts.vector += 1;
  if (merged) counts.merged += 1;
  rows.push({ id: testCase.id, kind: testCase.kind, expect: testCase.expectCardId, top1: top1.id, cos: top1.cos, literal, vector: vectorHitK, merged });
}

// ── 打印对照表 ───────────────────────────────────────────────────────────────
const pad = (text, width) => String(text).padEnd(width, " ");
console.log("");
console.log(`${pad("用例", 10)}${pad("类别", 11)}${pad("期望卡", 18)}${pad("字面", 6)}${pad("向量", 6)}${pad("合并", 6)}${pad("合并top1(cos)", 24)}`);
for (const row of rows) {
  const mark = (hit) => (hit ? "✓" : "✗");
  console.log(
    `${pad(row.id, 10)}${pad(row.kind, 11)}${pad(row.expect, 18)}${pad(mark(row.literal), 6)}${pad(mark(row.vector), 6)}${pad(mark(row.merged), 6)}${pad(`${row.top1}(${row.cos.toFixed(3)})`, 24)}`,
  );
}
const total = rows.length;
const pct = (hitCount) => `${hitCount}/${total} (${((hitCount / total) * 100).toFixed(1)}%)`;
console.log("");
console.log(`recall@${k} 对照：`);
console.log(`  字面（基线, F1a）      : ${pct(counts.literal)}`);
console.log(`  向量（纯检索口径）      : ${pct(counts.vector)}`);
console.log(`  合并（F1b 实际投递面）  : ${pct(counts.merged)}`);
const paraphrase = rows.filter((r) => r.kind === "paraphrase");
const paraMerged = paraphrase.filter((r) => r.merged).length;
console.log(`  其中转述用例合并命中    : ${paraMerged}/${paraphrase.length}（字面基线为 0——这就是语义补位的净增量）`);
