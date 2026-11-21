// 0.5 批次 4 · D 线（评审 R11）：「投递体检」页签 UI 测试（批次 3 ui-harness）。
// 证据级别：真实执行 client/index.js（fake window.__ModuleLoader__ + 有状态 react
// stub + 真实宿主 zod 经 harness 导入），SYNTHETIC，非浏览器实机。
//
// 覆盖：
// ① 程序化比对 client/index.js 内联 .dshi_tabIco-delivery 与 client/shiori.css 的
//    同名规则逐字符相同（读文件字符串比较，不手抄——两处 CSS 分歧无守卫会漂）；
// ② 挂载投递体检页签（单 host + 按树序展开函数组件，hooks 游标与真实渲染同序，
//    effects 真实执行）：tab label / 空态（available:false）/ 无卡 / 全投过 /
//    分页可翻（单页数据无页码条=越界无发生面）；
// ③ 「生成 spark_update 补丁」只产生本地预览字符串——整个过程零 executeTool /
//    零写方法调用（面板永不自动写）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createUiHarness } from "./ui-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const CLIENT_SRC = join(WORKQ, "client", "index.js");

// ---------------------------------------------------------------------------
// ① 两处 CSS 的 delivery 图标规则逐字符同源（防漂移守卫，与 client.test.mjs 的
//    「内嵌 CSS 与 shiori.css 规则一致」全量比较互补：本条只盯新增规则本身，
//    改坏一个字符也红）。
// ---------------------------------------------------------------------------

function extractDeliveryRule(source) {
  return source.match(/\.dshi_tabIco-delivery\{[^{}\n]*\}/g);
}

test("① dshi_tabIco-delivery 规则在 client/index.js 内嵌 CSS 与 client/shiori.css 逐字符相同", () => {
  const bundle = readFileSync(join(WORKQ, "client", "index.js"), "utf8");
  const cssFile = readFileSync(join(WORKQ, "client", "shiori.css"), "utf8");
  const inlineRules = extractDeliveryRule(bundle);
  const fileRules = extractDeliveryRule(cssFile);
  assert.ok(Array.isArray(inlineRules) && inlineRules.length === 1, "index.js 内嵌 CSS 恰有一条 delivery 图标规则");
  assert.ok(Array.isArray(fileRules) && fileRules.length === 1, "shiori.css 恰有一条 delivery 图标规则");
  assert.equal(inlineRules[0], fileRules[0], "两处规则逐字符相同（属性顺序/空格/引号都算差异）");
  assert.ok(inlineRules[0].includes("--dshi-tab-ico:url('data:image/svg+xml,"), "规则走 CSS mask 内联 SVG");
});

// ---------------------------------------------------------------------------
// ② ③ harness 挂载（单 host + 按树序展开函数组件；hooks 游标连续即与真实
//    React 执行顺序一致——父组件渲染返回的树里，子组件按出现顺序执行）。
// ---------------------------------------------------------------------------

/** 覆盖率/清单夹具。 */
function checkupFixture({ coverageCount = 0, neverCount = 0, rounds = 0, attribution = null } = {}) {
  const coverage = [];
  const neverDelivered = [];
  for (let i = 0; i < coverageCount; i++) {
    coverage.push({ id: `cov-${i}`, title: `覆盖卡${i}`, revision: 1, triggers: ["词"], createdAt: null, deliveries: 1, used: 1, usedScope: "all-time", lastHitAt: null, lastDeliveryAt: null });
  }
  for (let i = 0; i < neverCount; i++) {
    const entry = {
      id: `miss-${String(i).padStart(2, "0")}`, title: `沉默卡${i}`, revision: 2, triggers: ["旧词"],
      createdAt: null, deliveries: 0, used: 0, usedScope: "all-time", lastHitAt: null, lastDeliveryAt: null,
      // 评审 R19：attribution 可由用例覆盖（not-scored 回归守卫用）。
      attribution: attribution || { kind: "below-threshold", rounds: 3, scoredRounds: 2, topScore: 0.41 },
    };
    coverage.push(entry);
    neverDelivered.push(entry);
  }
  return {
    available: true,
    days: 7,
    window: { from: "2026-11-15T00:00:00.000Z", to: "2026-11-22T00:00:00.000Z" },
    rounds,
    coverage,
    neverDelivered,
    highDeliveryLowUsage: [],
    writer: { appended: 1, failed: 0, lastError: null, lastSuccessAt: null },
  };
}

/** 统一 dsh stub：getStatus 返回可编程 payload；任何其他方法直接抛（零写守卫）。 */
function makeDsh(getStatusPayload, calls) {
  return async function call(method, sid, payload) {
    calls.push({ method, sid, payload });
    if (method !== "getStatus") throw new Error(`unexpected RPC method: ${method}`);
    return typeof getStatusPayload === "function" ? getStatusPayload() : getStatusPayload;
  };
}

/**
 * 挂载面板（可指定 tab 与可编程 dsh stub）：单 host、一次渲染 = 执行
 * ShioriSection 并按树序展开全部函数组件（hooks 游标连续 = 真实渲染顺序），
 * effects 真实执行直至数据落地。
 */
async function mountPanel(harness, { tab = "delivery", dshCall } = {}) {
  const host = harness.makeStatefulReact();
  host.runEffects.v = true; // useEffect 真收集，由驱动循环执行
  const { sectionVNode } = await harness.applyPanel(host);
  host.states.length = 0;
  host.states.push(tab, "session-A", "", null, { mode: "active" });
  // ShioriSection 经 props.dsh 发起 RPC（harness.mount 同款注入面）；listSessions
  // 必须给——缺失时 session 探测走 1.2s 真实重试且探测期不渲染数据页签。
  const sectionProps = {
    ...sectionVNode.props,
    dsh: { call: dshCall, listSessions: async () => [{ sessionId: "session-A" }] },
  };
  // 记录最新一帧 DeliveryCheckupTab 的 useState 槽位基址（树里可能同时存在
  // 旧一帧的子树副本——stub 无协调器，展开顺序即真实调用顺序，最新调用的
  // 帧才是当前数据帧；交互拨槽必须拨到最新帧）。
  let frameBase = -1;
  const expand = (node, out) => {
    if (Array.isArray(node)) { for (const child of node) expand(child, out); return out; }
    if (!node || typeof node !== "object") return out;
    out.push(node);
    if (typeof node.type === "function") {
      const base = host.cursor.v;
      const result = node.type(node.props || {});
      if (node.type.name === "DeliveryCheckupTab") frameBase = base;
      return expand(result, out);
    }
    if (node.children) expand(node.children, out);
    return out;
  };
  let nodes = []; // 先声明：renderPass 需要赋回帧（TDZ 规避）
  const renderPass = () => {
    host.cursor.v = 0;
    host.refCursor.v = 0;
    host.effectCursor.v = 0;
    nodes = expand(sectionVNode.type(sectionProps), []); // 赋回 nodes：settle 之后的交互渲染也必须更新帧
    return nodes;
  };
  nodes = renderPass();
  const settle = async () => {
    for (let round = 0; round < 6; round++) {
      for (const fn of host.effects.splice(0, host.effects.length)) {
        const cleanup = typeof fn === "function" ? fn() : undefined;
        void cleanup;
      }
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      nodes = renderPass();
    }
  };
  await settle();
  return {
    host,
    get nodes() { return nodes; },
    frameBase: () => frameBase,
    renderPass,
    settle,
    findButton: (label) => {
      const matches = nodes.filter((n) => n.type === "button" && harness.collectText(n) === label);
      return matches.length > 0 ? matches[matches.length - 1] : null; // 取最新一帧（树里嵌有旧子树副本，见下）
    },
    findInput: (placeholderPart) => {
      const matches = nodes.filter((n) => n.type === "input" && String((n.props && n.props.placeholder) || "").includes(placeholderPart));
      return matches.length > 0 ? matches[matches.length - 1] : null;
    },
    text: () => nodes.map((n) => harness.collectText(n)).join(""),
  };
}

test("② tab 栏含「投递体检」label（插在闪回命中与记忆预算之间）", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  await harness.install();
  try {
    const calls = [];
    const panel = await mountPanel(harness, {
      tab: "status",
      dshCall: makeDsh({ mode: "active", configured: true }, calls),
    });
    // 页签栏是纯元素节点：取最近一次渲染的 tab 按钮清单。
    const tabButtons = panel.nodes
      .filter((n) => n.type === "button" && String((n.props && n.props.className) || "").includes("dshi_tab"))
      .map((n) => harness.collectText(n));
    assert.deepEqual(tabButtons, ["状态", "最近变更", "记忆内容", "闪回图谱", "遗忘", "专题", "闪回命中", "投递体检", "记忆预算"]);
    // 合并口径（0.5-4D × 0.5-4C × 0.5-4B）：C 线首屏会主动探测一次 onboardingPreview，
    // B 线状态页要画冷热分布会读 getTemperatureSettings，因此这里只钉「除 getStatus /
    // onboardingPreview / getTemperatureSettings 外零调用」——三者都是只读首屏探测
    // （探活 / 探向导 / 画冷热分布），投递体检页签自身仍不得触发任何数据方法
    // （onboardingPreview 的次数上限由 client.test.mjs 守卫）。
    assert.deepEqual(
      calls.filter((c) => c.method !== "getStatus" && c.method !== "onboardingPreview" && c.method !== "getTemperatureSettings"),
      [],
      "除 getStatus / onboardingPreview / getTemperatureSettings 外零 RPC 调用",
    );
  } finally {
    harness.restore();
  }
});

test("② 空态：available:false（scope 未打开）→ 占位文案", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  await harness.install();
  try {
    const calls = [];
    const panel = await mountPanel(harness, {
      tab: "delivery",
      dshCall: makeDsh({ mode: "active", diagnostics: { delivery: { available: false, reason: "scope-not-open" } } }, calls),
    });
    const text = panel.text();
    assert.ok(text.includes("投递体检数据暂不可用"), "空态占位");
    assert.ok(text.includes("记忆 scope 未打开"), "reason 友好文案");
    assert.ok(calls.length >= 1 && calls.every((c) => c.method === "getStatus"), "只允许 getStatus（探测 + 页签加载），零写方法调用");
  } finally {
    harness.restore();
  }
});

test("② 无卡：available 且 coverage 空 → 「当前 scope 没有 active 卡片」", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  await harness.install();
  try {
    const calls = [];
    const panel = await mountPanel(harness, {
      tab: "delivery",
      dshCall: makeDsh({ mode: "active", diagnostics: { delivery: checkupFixture({}) } }, calls),
    });
    const text = panel.text();
    assert.ok(text.includes("从未投递（0 张）"));
    assert.ok(text.includes("当前 scope 没有 active 卡片"));
    assert.ok(text.includes("高频投递但低使用（0 张）"));
    assert.ok(text.includes("近 7 天有效召回轮次：0"));
    assert.ok(calls.length >= 1 && calls.every((c) => c.method === "getStatus"), "只允许 getStatus（探测 + 页签加载），零写方法调用");
  } finally {
    harness.restore();
  }
});

test("② 全投过：窗口内每张卡都投出过 → 从未投递清单空态文案", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  await harness.install();
  try {
    const panel = await mountPanel(harness, {
      tab: "delivery",
      dshCall: makeDsh({ mode: "active", diagnostics: { delivery: checkupFixture({ coverageCount: 2, rounds: 4 }) } }, []),
    });
    const text = panel.text();
    assert.ok(text.includes("从未投递（0 张）"));
    assert.ok(text.includes("窗口内每张卡都至少投出过一次"));
    assert.ok(text.includes("覆盖卡片 2 张"), "汇总行覆盖卡数");
  } finally {
    harness.restore();
  }
});

test("② 分页：15 张从未投递卡分两页；越界页码被 paginateRows 钳回最后一页", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  await harness.install();
  try {
    const panel = await mountPanel(harness, {
      tab: "delivery",
      dshCall: makeDsh({ mode: "active", diagnostics: { delivery: checkupFixture({ neverCount: 15, rounds: 5 }) } }, []),
    });
    const text = panel.text();
    assert.ok(text.includes("从未投递（15 张）"));
    assert.ok(text.includes("沉默卡0"), "第 1 页含首条");
    assert.ok(!text.includes("沉默卡10"), "第 1 页不含第 11 条");
    assert.ok(text.includes("第 1 / 2 页"), "页码条显示 1/2");
    // 越界钳回：把页码状态直接拨到越界值 99 → paginateRows 的 min/max 夹逼必须
    // 钳回最后一页（第 2 页），面板如实显示第 2 页内容与 2/2 页码。
    // （state 槽位 = 组件第 7 个 useState，白盒拨页；渲染与钳回逻辑全部真实执行。）
    const pageSlot = panel.frameBase() + 6; // 组件 hook 序：data/error/guard/patch/draft/copy/【page】/lowUse
    assert.equal(String(panel.host.states[pageSlot]), "1", "初始页码为 1");
    panel.host.states[pageSlot] = 99;
    panel.renderPass();
    const page2 = panel.text();
    assert.ok(page2.includes("沉默卡10") && page2.includes("沉默卡14"), "钳回第 2 页：含第 11-15 条");
    assert.ok(!page2.includes("沉默卡9"), "第 2 页不含第 10 条");
    assert.ok(page2.includes("第 2 / 2 页"), "页码条显示 2/2");

    // 单页数据：页码条整体收起（无越界可发生的 UI 面）。
    const small = await mountPanel(harness, {
      tab: "delivery",
      dshCall: makeDsh({ mode: "active", diagnostics: { delivery: checkupFixture({ neverCount: 5, rounds: 5 }) } }, []),
    });
    const smallText = small.text();
    assert.ok(smallText.includes("从未投递（5 张）"));
    assert.ok(smallText.includes("沉默卡0"));
    assert.ok(!smallText.includes("下一页"), "单页数据无页码条");
  } finally {
    harness.restore();
  }
});

// 评审 R19：not-scored 两分支的文案回归守卫——attempt-2 的核心是「文案不得把
// 用户指向默认禁用（provider=none）的『重建向量』按钮」，此处钉死：语义未开启
// 时整块文案不得出现该建议；语义已开启时才允许出现；徽章恒为「从未被评分」。
test("② not-scored × 语义未开启：文案不得出现「重建向量」建议，徽章为「从未被评分」", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  await harness.install();
  try {
    const panel = await mountPanel(harness, {
      tab: "delivery",
      dshCall: makeDsh({ mode: "active", diagnostics: { delivery: checkupFixture({
        neverCount: 1, rounds: 3,
        attribution: { kind: "not-scored", rounds: 3, scoredRounds: 0, topScore: null, semanticEnabled: false },
      }) } }, []),
    });
    const text = panel.text();
    assert.ok(text.includes("从未被语义评分（轮次 3）"), "not-scored 文案存在");
    assert.ok(text.includes("从未被评分"), "徽章「从未被评分」");
    assert.ok(!text.includes("点状态页「重建向量」可修复"), "语义未开启时不得出现重建向量建议");
    assert.ok(text.includes("语义召回未开启"), "改为说明语义未开启/向量缺失");
  } finally {
    harness.restore();
  }
});

test("② not-scored × 语义已开启：才允许出现「重建向量」建议", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  await harness.install();
  try {
    const panel = await mountPanel(harness, {
      tab: "delivery",
      dshCall: makeDsh({ mode: "active", diagnostics: { delivery: checkupFixture({
        neverCount: 1, rounds: 3,
        attribution: { kind: "not-scored", rounds: 3, scoredRounds: 0, topScore: null, semanticEnabled: true },
      }) } }, []),
    });
    const text = panel.text();
    assert.ok(text.includes("从未被语义评分（轮次 3）"), "not-scored 文案存在");
    assert.ok(text.includes("点状态页「重建向量」可修复"), "语义已开启时才建议重建");
    assert.ok(!text.includes("语义召回未开启"), "不再显示未开启说明");
  } finally {
    harness.restore();
  }
});

test("③ 生成 spark_update 补丁：只拼本地预览字符串，全程零 executeTool / 零写方法调用", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  await harness.install();
  try {
    const calls = [];
    const panel = await mountPanel(harness, {
      tab: "delivery",
      dshCall: makeDsh({ mode: "active", diagnostics: { delivery: checkupFixture({ neverCount: 1, rounds: 3 }) } }, calls),
    });
    // 触发词草稿直接写入草稿 state 槽（组件第 5 个 useState，倒数第 4 个）——
    // 跨渲染闭包时序在 stub 下不稳定，白盒预置后走真实点击与渲染路径。
    const draftSlot = panel.frameBase() + 4; // 组件 hook 序：data/error/guard/patch/【draft】/copy/page/lowUse
    panel.host.states[draftSlot] = { "miss-00": "新词甲, 新词乙" };
    panel.renderPass();
    const patchBtn = panel.findButton("生成 spark_update 补丁");
    assert.ok(patchBtn, "生成补丁按钮存在");
    patchBtn.props.onClick();
    panel.renderPass();
    const text = panel.text();
    assert.ok(text.includes("（预览，不自动写入）"), "预览框明示不自动写入");
    assert.ok(text.includes("spark_update"), "补丁目标工具名");
    assert.ok(text.includes("新词甲") && text.includes("新词乙"), "用户填的触发词进补丁");
    assert.ok(text.includes('"expectedRevision": 2'), "带 CAS 期望 revision");
    assert.ok(text.includes('"id": "miss-00"'), "补丁只针对目标卡");
    assert.ok(text.includes('"triggers"'), "补丁含 triggers 字段");
    // 评审 R11③：整个过程只读——除 getStatus 外零调用（executeTool/spark_update 都不许出现）。
    assert.ok(calls.length >= 1 && calls.every((c) => c.method === "getStatus"), "只允许 getStatus（探测 + 页签加载），零写方法调用");
  } finally {
    harness.restore();
  }
});
