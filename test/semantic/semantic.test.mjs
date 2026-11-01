// Shiori F1a · 语义召回接口与离线评测基线测试。
//
// 覆盖（迭代清单 F1a 验收）：
// 1. provider 默认关闭（缺配置 / provider:"none"）→ createEmbeddingProvider 返回 null，
//    行为与 0.1 完全一致；
// 2. provider:"local" / "api" 显式 NOT_IMPLEMENTED（F1b 未接入，不许冒充可用）；
// 3. cosineSimilarity / normalizeVector 纯函数正确性；
// 4. 离线夹具（eval-fixtures.json）跑现有字面匹配的 recall@k 并打印数字：
//    字面用例必须全命中（recall=1），转述用例是字面基线的缺口（recall=0），
//    这个 gap 就是语义召回（F1b）要补的部分。

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createEmbeddingProvider,
  cosineSimilarity,
  normalizeVector,
} from "../../src/semantic/index.mjs";
import { matchSparks } from "../../src/sparks/match.mjs";

const fixtures = JSON.parse(
  readFileSync(new URL("./eval-fixtures.json", import.meta.url), "utf8"),
);

const SCOPE = "test-scope";

/** 夹具卡片 → matchSparks 可选卡片形状（补 scope/state/revision）。 */
function toMatchCards(cards) {
  return cards.map((card) => ({
    id: card.id,
    title: card.title,
    triggers: card.triggers,
    entities: card.entities ?? [],
    links: [],
    scopeId: SCOPE,
    state: "active",
    revision: 1,
  }));
}

function nearlyEqual(actual, expected, eps = 1e-6) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} to be within ${eps} of ${expected}`,
  );
}

// ── 1. provider 默认关闭 ─────────────────────────────────────────────────────

test("createEmbeddingProvider: 缺配置 / provider none 一律返回 null（默认关闭）", () => {
  assert.equal(createEmbeddingProvider(undefined), null);
  assert.equal(createEmbeddingProvider(null), null);
  assert.equal(createEmbeddingProvider({}), null);
  assert.equal(createEmbeddingProvider({ provider: "none" }), null);
  assert.equal(
    createEmbeddingProvider({ provider: "none", local: { model: "bge-small-zh-v1.5", dims: 512 } }),
    null,
  );
});

// ── 2. local / api 显式 NOT_IMPLEMENTED ─────────────────────────────────────

test("createEmbeddingProvider: local 返回 provider 形状（F1b 已实现，构造期不加载模型）；api 仍 NOT_IMPLEMENTED", () => {
  // F1b：local 不再是 NOT_IMPLEMENTED，但必须遵守「构造不加载模型、不产文件」的懒加载契约。
  const local = createEmbeddingProvider({
    provider: "local",
    local: { model: "Xenova/bge-small-zh-v1.5", dims: 512, dtype: "fp32", cacheDir: "", mirror: "https://hf-mirror.com/" },
  });
  assert.equal(local.kind, "local");
  assert.equal(local.dims, 512);
  assert.equal(typeof local.embed, "function");
  // 构造阶段不许 import 真正的推理后端（否则 apply 路径会被拖慢/拖挂）。
  assert.equal(
    Object.keys(local).filter((key) => key !== "kind" && key !== "dims" && key !== "embed").length,
    0,
    "provider 只暴露契约形状，不带内部句柄",
  );
  // api 本期不做：仍必须显式失败，绝不静默返回 null。
  assert.throws(
    () => createEmbeddingProvider({ provider: "api", api: { endpoint: "https://example.invalid/embed", keyRef: "ENV_VAR" } }),
    (error) => error.code === "NOT_IMPLEMENTED",
    "provider api must fail loudly, not pretend to be available",
  );
});

test("createEmbeddingProvider: 非法 provider 名与缺子字段按 INVALID_INPUT 拒绝", () => {
  assert.throws(
    () => createEmbeddingProvider({ provider: "hybrid" }),
    (error) => error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => createEmbeddingProvider({ provider: "local", local: { model: "m" } }),
    (error) => error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => createEmbeddingProvider({ provider: "api", api: { endpoint: "https://x" } }),
    (error) => error.code === "INVALID_INPUT",
  );
});

// ── 3. 向量纯函数 ────────────────────────────────────────────────────────────

test("cosineSimilarity: 同向 1 / 反向 -1 / 正交 0 / 45° √½", () => {
  nearlyEqual(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([2, 0])), 1);
  nearlyEqual(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-3, 0])), -1);
  nearlyEqual(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 5])), 0);
  nearlyEqual(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 1])), Math.SQRT1_2);
});

test("cosineSimilarity: 零向量得 0（不产生 NaN）；维度不匹配拒绝；非有限数拒绝", () => {
  nearlyEqual(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2])), 0);
  assert.throws(
    () => cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0, 0])),
    (error) => error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => cosineSimilarity(new Float32Array([1, Number.NaN]), new Float32Array([1, 0])),
    (error) => error.code === "INVALID_INPUT",
  );
  assert.throws(
    () => cosineSimilarity(new Float32Array([]), new Float32Array([])),
    (error) => error.code === "INVALID_INPUT",
  );
});

test("normalizeVector: [3,4] → [0.6,0.8]；结果模长 1；零向量保持零", () => {
  const normalized = normalizeVector([3, 4]);
  assert.ok(normalized instanceof Float32Array);
  nearlyEqual(normalized[0], 0.6);
  nearlyEqual(normalized[1], 0.8);
  let norm = 0;
  for (const v of normalized) norm += v * v;
  nearlyEqual(Math.sqrt(norm), 1);

  const zero = normalizeVector(new Float32Array([0, 0, 0]));
  assert.deepEqual([...zero], [0, 0, 0]);

  assert.throws(
    () => normalizeVector([1, Number.POSITIVE_INFINITY]),
    (error) => error.code === "INVALID_INPUT",
  );
});

// ── 4. 离线评测：字面基线 recall@k ───────────────────────────────────────────

test("eval fixtures: 夹具完整性（数量、引用、字面/转述的前置条件）", () => {
  assert.ok(Array.isArray(fixtures.cards) && fixtures.cards.length >= 2);
  assert.ok(Array.isArray(fixtures.cases) && fixtures.cases.length >= 20, "至少 20 条用例");
  const cardIds = new Set(fixtures.cards.map((c) => c.id));
  assert.equal(cardIds.size, fixtures.cards.length, "卡片 id 不得重复");
  for (const card of fixtures.cards) {
    assert.ok(Array.isArray(card.triggers) && card.triggers.length > 0, `卡片 ${card.id} 需要触发词`);
  }
  const paraphrases = fixtures.cases.filter((c) => c.kind === "paraphrase");
  assert.ok(paraphrases.length >= 8, "至少 8 条转述类用例");
  for (const item of fixtures.cases) {
    assert.ok(cardIds.has(item.expectCardId), `用例 ${item.id} 引用了不存在的卡片`);
    const text = item.utterance.normalize("NFC").toLowerCase();
    const card = fixtures.cards.find((c) => c.id === item.expectCardId);
    if (item.kind === "literal") {
      assert.equal(typeof item.expectTrigger, "string");
      assert.ok(
        text.includes(item.expectTrigger.normalize("NFC").toLowerCase()),
        `字面用例 ${item.id} 必须原样包含触发词`,
      );
    } else {
      for (const trigger of card.triggers) {
        assert.ok(
          !text.includes(trigger.normalize("NFC").toLowerCase()),
          `转述用例 ${item.id} 不得出现卡片触发词「${trigger}」`,
        );
      }
    }
  }
});

test("eval fixtures: 字面匹配基线 recall@5（打印数字回填迭代清单 F1）", () => {
  const k = fixtures.k ?? 5;
  const cards = toMatchCards(fixtures.cards);
  const hits = { literal: 0, paraphrase: 0 };
  const misses = [];

  for (const item of fixtures.cases) {
    const result = matchSparks({
      scopeId: SCOPE,
      userText: item.utterance,
      sparks: cards,
      seenKeys: [],
      sessionId: "session-eval",
      contextEpoch: 0,
    });
    // 现有四道闸门下的实际投递面：种子 + 1 跳关联，合计 ≤5。
    const delivered = [...result.seeds, ...result.related].map((entry) => entry.id).slice(0, k);
    if (delivered.includes(item.expectCardId)) {
      hits[item.kind] += 1;
    } else {
      misses.push(item.id);
    }
    if (item.kind === "literal") {
      const seed = result.seeds.find((entry) => entry.id === item.expectCardId);
      assert.ok(seed, `字面用例 ${item.id} 的应命中卡片必须以种子身份入选`);
      assert.equal(seed.trigger, item.expectTrigger, `字面用例 ${item.id} 应命中声明的触发词`);
    }
  }

  const total = fixtures.cases.length;
  const literalTotal = fixtures.cases.filter((c) => c.kind === "literal").length;
  const paraphraseTotal = total - literalTotal;
  const literalRecall = hits.literal / literalTotal;
  const paraphraseRecall = hits.paraphrase / paraphraseTotal;
  const overallRecall = (hits.literal + hits.paraphrase) / total;

  // 基线数字回填：迭代清单 F1「先跑字面基线拿 recall@5，再定合并后目标」。
  console.log(`[semantic-eval] 字面基线 recall@${k}（字面用例）= ${literalRecall.toFixed(3)} (${hits.literal}/${literalTotal})`);
  console.log(`[semantic-eval] 字面基线 recall@${k}（转述用例）= ${paraphraseRecall.toFixed(3)} (${hits.paraphrase}/${paraphraseTotal})`);
  console.log(`[semantic-eval] 字面基线 recall@${k}（全体）    = ${overallRecall.toFixed(3)} (${hits.literal + hits.paraphrase}/${total})`);
  if (misses.length > 0) {
    console.log(`[semantic-eval] 未命中用例: ${misses.join(", ")}`);
  }

  assert.equal(literalRecall, 1, "字面用例（触发词原样出现）必须全部命中");
  assert.equal(paraphraseRecall, 0, "转述用例是字面基线的缺口，语义召回前预期全部落空");
});
