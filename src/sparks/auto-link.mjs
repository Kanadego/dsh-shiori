// Shiori 0.5-5C · 自动连线（方案 2：只挂新卡自身）。
//
// 职责（0.5-5C 任务书模块 2；方案依据 0.5-DEV-PLAN §11.3 自动连线拍板）：
// spark_save / spark_update 提交时，取与当前卡内容相似度最高的一批老卡
// （cosine ≥ AUTO_LINK_THRESHOLD、每卡上限 AUTO_LINK_MAX、按 target 去重），
// 产出 auto:similar 候选边（相似度分存独立 score 字段，不塞 rel）。调用方
// （spark 工具门面）把候选连同卡片本体在【同一次 store mutate】里写进当前卡
// 自身 links——绝不反向修改老卡，Agent 拿到的 revision 即最终值。
//
// 降级边界（任务书硬要求「provider 不可用零报错不补写」）：
// - provider 为 null / 向量索引打不开 / embed 抛错 / 候选查询中途失败 → 返回
//   null（= 本次跳过）。门面拿到 null 不传 store 的 autoLinks 选项：什么都不写
//   （update 也【不清掉】已有 auto 边——跳过 ≠ 重算为空），零报错、绝不异步补写。
// - 向量只认「新鲜」条目（索引 revision === 卡片当前 revision，与召回层
//   semantic-recall 同判据）：过期/缺失的卡不参与候选——补齐是重建按钮与
//   写后增量队列的职责，写路径绝不隐式重建索引。
//
// 依赖边界：本模块 import semantic/index.mjs（cosineSimilarity 纯函数；模块
// 顶层零模型加载）。store.mjs 不 import 本模块——auto 边的「auto: 保留前缀」
// 校验在 store 内部自有实现，避免把 transformers.js 依赖图拖进存储层。

import { cosineSimilarity } from "../semantic/index.mjs";

/** 自动边的保留 rel（auto: 前缀是系统命名空间，人工写面一律拒绝）。 */
export const AUTO_LINK_REL = "auto:similar";

/** 相似度阈值（cosine ≥ 0.80 才成边；0.5-5C 任务书拍板值，模块常量）。 */
export const AUTO_LINK_THRESHOLD = 0.8;

/** 每卡自动边上限（≤3；0.5-5C 任务书拍板值，模块常量）。 */
export const AUTO_LINK_MAX = 3;

/** 自动连线边形状（rel 固定 auto:similar；score 为 [0,1] 余弦）。 */

/**
 * 创建一个 scope 的自动连线器。
 *
 * @param {object} args
 * @param {string} args.scopeId scope 标识（与卡 store / 向量索引同 scope）。
 * @param {object|null} args.provider F1a 契约 provider（null = 语义关闭，恒返回 null）。
 * @param {() => Promise<object|null>} args.openVectorStore 惰性打开本 scope 向量
 *   索引（controller 的共享入口；null = 索引不可用 → 跳过）。
 * @param {() => Promise<Array>} args.listActive 当前 active 卡完整记录（裸 store）。
 * @param {(cardLike: {title, summary, content}) => string} args.embedText 嵌入文本
 *   口径（controller 的 cardEmbedText 函数对象注入——与增量队列/重建同源，改口径
 *   只改一处）。
 * @param {() => boolean} [args.canEmbed] 模型是否可用（与增量队列 canEmbed 同源注入）。
 *   false → 直接跳过（不触碰 provider.embed——embed 的懒加载会尝试真实下载，
 *   写路径绝不充当下载触发器）；缺省 true（仅测试直构）。
 * @param {number} [args.threshold] 相似度阈值（默认 AUTO_LINK_THRESHOLD）。
 * @param {number} [args.max] 每卡上限（默认 AUTO_LINK_MAX）。
 * @returns {(input: {title: string, summary?: string, content: string, excludeId?: string|null}) =>
 *   Promise<Array<{target: string, rel: string, score: number}>|null>}
 *   异步：返回候选边数组（可为空数组 = 重算成功但无人过线，update 语义下会
 *   刷新/清空旧自动边）；null = 跳过本次（provider/索引不可用或查询失败）。
 *   绝不 reject——所有错误收敛为 null。
 */
export function createAutoLinker({
  scopeId,
  provider,
  openVectorStore,
  listActive,
  embedText,
  canEmbed = () => true,
  threshold = AUTO_LINK_THRESHOLD,
  max = AUTO_LINK_MAX,
} = {}) {
  // 接线错误 fail-fast（controller 接线是编程行为）。
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    throw new TypeError("createAutoLinker: scopeId must be a non-empty string");
  }
  for (const [name, fn] of [["openVectorStore", openVectorStore], ["listActive", listActive], ["embedText", embedText]]) {
    if (typeof fn !== "function") {
      throw new TypeError(`createAutoLinker: ${name} must be a function`);
    }
  }
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new TypeError(`createAutoLinker: threshold must be in (0,1], got ${String(threshold)}`);
  }
  if (!Number.isInteger(max) || max < 0) {
    throw new TypeError(`createAutoLinker: max must be a non-negative integer, got ${String(max)}`);
  }

  return async function autoLinksForCard({ title, summary, content, excludeId = null } = {}) {
    try {
      if (provider === null || provider === undefined || typeof provider.embed !== "function") return null;
      // 模型未装 → 跳过且不触碰 provider.embed：embed 的懒加载会尝试真实下载
      // （网络 + 分钟级耗时），写路径绝不充当下载触发器（与增量队列 canEmbed 同闸）。
      let embeddable = true;
      try {
        embeddable = canEmbed() !== false;
      } catch {
        embeddable = false; // 守卫自身抛错按不可用处理（fail-closed）
      }
      if (!embeddable) return null;
      // 嵌入文本口径与重建/增量队列同一函数对象（title/summary/content 按行拼接）。
      const text = embedText({
        title: typeof title === "string" ? title : "",
        summary: typeof summary === "string" ? summary : "",
        content: typeof content === "string" ? content : "",
      });
      if (typeof text !== "string" || text.trim().length === 0) return null;
      let query;
      try {
        query = await provider.embed(text);
      } catch {
        return null; // 模型没装 / 推理异常：跳过本次，零报错不补写
      }
      if (!(query instanceof Float32Array) && !Array.isArray(query)) return null;
      const store = await openVectorStore();
      if (store === null) return null; // 索引不可用：跳过（诊断由增量队列/召回层承担）
      const cards = await listActive();
      if (!Array.isArray(cards)) return null;
      const ranked = [];
      for (const card of cards) {
        if (card === null || typeof card !== "object") continue;
        if (typeof card.id !== "string" || card.id.length === 0) continue;
        if (card.scopeId !== scopeId) continue; // 跨 scope 防御（listActive 契约内不该出现）
        if (card.state !== "active" || card.mergedInto || card.supersededBy) continue;
        if (excludeId !== null && card.id === excludeId) continue; // 不与自己连边
        if (!Number.isInteger(card.revision) || card.revision < 0) continue;
        const entry = store.get(card.id);
        if (entry === null || entry === undefined) continue;
        if (entry.revision !== card.revision) continue; // 过期向量：不参与候选（不隐式重建）
        if (entry.vec.length !== query.length) continue; // 维度错配：索引与模型不一致，跳过不抛
        let cos;
        try {
          cos = cosineSimilarity(query, entry.vec);
        } catch {
          continue; // 单条坏数据不炸整批
        }
        if (Number.isFinite(cos) && cos >= threshold) ranked.push({ id: card.id, cos });
      }
      // 排序确定性：相似度降序，平局按 id 码点升序；截取每卡上限。
      ranked.sort((a, b) => (b.cos !== a.cos ? b.cos - a.cos : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const picked = ranked.slice(0, max);
      return picked.map((c) => ({ target: c.id, rel: AUTO_LINK_REL, score: c.cos }));
    } catch {
      // openVectorStore / listActive 等基础设施错误：与 provider 失败同口径，
      // 跳过本次（null），绝不把自动连线的故障外溢成保存失败。
      return null;
    }
  };
}
