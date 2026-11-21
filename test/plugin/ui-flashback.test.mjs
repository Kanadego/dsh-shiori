// 0.5-5D 闪回按钮 turnRef 重做：按钮形态（线稿图标 + N 徽标 + 无投递不占位）、
// sourceMessageId 精确匹配与 10 分钟窗口回落、浮层卡片列表（有用/没用 → spark_feedback、
// 点标题跳图谱、底部汇总）、浮层脱离宿主布局（position:fixed + 合成 offsetTop 模型）、
// level 2 跨簇边外部端点小标记可跳簇。
//
// 证据级别：createUiHarness 真实重渲染循环（client/index.js 组件函数真执行 → fake DOM
// → flush 跑 effect → 状态变更 → 组件函数重执行 → DOM 更新），SYNTHETIC，非浏览器实机。
// offsetTop/offsetHeight 是 harness 的合成布局模型（ui-harness.mjs 顶部有建模说明）：
// 按「实测缺陷」建模——真机上 absolute 版浮层在该插槽里参与了布局，把按钮顶到上一行，
// 因此模型里只有 style.position === "fixed" 按「脱离布局」计 0 贡献，其余一律参与。
//
// 清理纪律：每个用例 try/finally 强制 unmount/restore——变异自测会把断言打红，
// 中途抛出也不能把 harness 的 fake window/定时器泄漏给后续用例（否则真实 setTimeout
// 被 fake 替身吞掉，flushAsync 会永远挂起，红变成挂）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createUiHarness } from "./ui-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const CLIENT_SRC = join(WORKQ, "client", "index.js");

const harness = createUiHarness({ clientSource: CLIENT_SRC });

// ── 夹具 ────────────────────────────────────────────────────────────────────

function makeDsh(graph, log) {
  return {
    call: async (method, sessionId, payload) => {
      log.push({ method, sessionId, payload });
      if (method === "getGraph") return graph;
      return { ok: true };
    },
  };
}

function cardNode(id, title, summary) {
  return {
    id,
    title,
    summary: summary ?? null,
    vitality: "ephemeral",
    revision: 1,
    state: "active",
    hitCount: 0,
    lastHitAt: null,
    createdAt: null,
  };
}

// 挂载 assistant-actions 插槽的 FlashbackActions（默认 messageId=m-1 / session-A）。
async function mountFlashback({ graph, log = [], slotProps = {} } = {}) {
  const dsh = makeDsh(graph, log);
  const ui = await harness.mountSlot("conversation.chat.assistant-actions", {
    dsh,
    injectArg: "session-A",
    slotProps: { messageId: "m-1", shioriSessionId: "session-A", ...slotProps },
  });
  return { ui, dsh, log };
}

// 挂载 → 首渲染 → flush（跑挂载拉取 effect）→ 重渲染：徽标 N 已就绪的稳定态。
async function bootFlashback(options) {
  const { ui, dsh, log } = await mountFlashback(options);
  ui.render();
  await ui.flush();
  ui.rerender();
  return { ui, dsh, log };
}

async function flushAsync() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// 打开浮层（走主按钮的 aria-label 精确点击，避开浮层里的「有用/没用」按钮）。
function openPopup(ui, badgeCount) {
  return ui.click(`button[aria-label=闪回 ${badgeCount}]`);
}

// 浮层根节点：全内联样式的 div（position:fixed）。
function findPopup(ui) {
  return ui.findAll("div").find((el) => el.style && el.style.position === "fixed");
}

// ── ①无投递不占位 ──────────────────────────────────────────────────────────

test("5D ①无投递不占位：挂载拉取后确认窗口内无投递 → 动作位整位不渲染", async () => {
  const graph = {
    deliveries: [
      // 11 分钟前的旧投递：窗口外不显示（近似口径也拿不到它）。
      { deliveryId: "d-old", at: new Date(harness.timers.now() - 11 * 60_000).toISOString(), sessionId: "session-A", cards: [] },
    ],
    nodes: [],
  };
  const { ui, log } = await bootFlashback({ graph });
  try {
    assert.equal(log.some((c) => c.method === "getGraph"), true, "挂载即拉一次 getGraph（徽标与占位判定都需要）");
    assert.equal(log.find((c) => c.method === "getGraph").sessionId, "session-A", "按注入的会话 id 拉取");
    assert.equal(ui.find("button"), null, "无投递：按钮不占位");
    assert.equal(ui.text(), "", "无投递：动作位无任何文本");
  } finally {
    ui.unmount();
  }
});

// ── ②有投递显示 N ──────────────────────────────────────────────────────────

test("5D ②有投递显示 N：线稿图标 + 文案「闪回」+ 徽标 N，aria-label「闪回 N」", async () => {
  const graph = {
    deliveries: [
      { deliveryId: "d-1", sourceMessageId: "m-1", at: new Date(harness.timers.now() - 60_000).toISOString(), sessionId: "session-A",
        cards: [{ sparkId: "s1", trigger: "触发词A", source: "seed" }, { sparkId: "s2", trigger: null, source: "related" }] },
    ],
    nodes: [cardNode("s1", "卡片甲", "第一条摘要"), cardNode("s2", "卡片乙", null)],
  };
  const { ui } = await bootFlashback({ graph });
  try {
    const btn = ui.find("button");
    assert.ok(btn, "有投递：按钮占位");
    assert.equal(ui.textOf("button"), "闪回2", "文案「闪回」+ 数字徽标 N=2");
    assert.equal(btn.getAttribute("aria-label"), "闪回 2", "可访问名称带 N");
    const svg = ui.find("svg");
    assert.ok(svg, "线稿图标（内联 SVG）");
    assert.equal(svg.getAttribute("stroke"), "currentColor", "配色沿用侧边栏 stroke/currentColor");
  } finally {
    ui.unmount();
  }
});

// ── ③浮层脱离宿主布局（offsetTop 回归 + fixed 定位）──────────────────────────

test("5D ③浮层脱离宿主布局：开合前后主按钮 offsetTop 不变；浮层 position:fixed + 按钮矩形定位", async () => {
  const graph = {
    deliveries: [
      { deliveryId: "d-1", sourceMessageId: "m-1", at: new Date(harness.timers.now() - 60_000).toISOString(), sessionId: "session-A",
        cards: [{ sparkId: "s1", trigger: "触发词A", source: "seed" }, { sparkId: "s2", trigger: null, source: "related" }] },
    ],
    nodes: [cardNode("s1", "卡片甲", null), cardNode("s2", "卡片乙", null)],
  };
  const { ui } = await bootFlashback({ graph });
  try {
    // offsetTop 断言必须钉在真实主按钮上（review R1）：浮层里的「有用/没用」按钮
    // 没有 aria-label，主按钮的 aria-label 以「闪回」开头——用精确 aria-label 定位
    //（harness 的 matchesSelector 只支持 [attr=value] 精确匹配，不支持 ^= 前缀）。
    // 断言顺序也按 review R1 调整：offsetTop 先于样式断言——M1（fixed→absolute）
    // 必须直接红在 offsetTop 这条上，而不是先被样式检查截住、让 offsetTop 变恒真。
    const mainButton = () => ui.find('button[aria-label=闪回 2]');
    const btn = mainButton();
    assert.ok(btn, "主按钮存在");
    const topBefore = btn.offsetTop;
    const wrap = ui.find("div");
    const heightBefore = wrap.offsetHeight;
    // 钉锚点矩形：模拟宿主布局里按钮的真实位置（真实浏览器由布局引擎决定）。
    btn._rect = { left: 100, top: 500, right: 180, bottom: 528, width: 80, height: 28 };

    assert.equal(openPopup(ui, 2), true, "点开浮层");
    ui.rerender();
    assert.equal(mainButton().offsetTop, topBefore, "开合前后主按钮 offsetTop 不变（fixed 浮层不计布局）");
    assert.equal(ui.find("div").offsetHeight, heightBefore, "开合前后宿主容器（wrap）高度不变");

    const popup = findPopup(ui);
    assert.ok(popup, "浮层渲染且 position:fixed 是内联样式（不靠 className 注入）");
    assert.equal(popup.style.left, "8px", "按钮右缘对齐、画布左缘钳制（180-320 < 8）");
    assert.equal(popup.style.top, "494px", "浮层底缘悬在按钮上方 6px（500-6）");
    assert.equal(popup.style.transform, "translateY(-100%)", "translateY(-100%) 等价旧版 bottom:calc(100%+6px)");

    assert.equal(openPopup(ui, 2), true, "再点关闭");
    ui.rerender();
    assert.equal(findPopup(ui), undefined, "关闭后浮层卸载");
    assert.equal(mainButton().offsetTop, topBefore, "关闭后主按钮 offsetTop 仍不变");
  } finally {
    ui.unmount();
  }
});

// ── ④sourceMessageId 精确匹配 ──────────────────────────────────────────────

test("5D ④精确匹配：只显示 sourceMessageId === 本条消息的投递，别的消息的投递不重复出现", async () => {
  const graph = {
    deliveries: [
      { deliveryId: "d-mine", sourceMessageId: "m-1", at: new Date(harness.timers.now() - 60_000).toISOString(), sessionId: "session-A",
        cards: [{ sparkId: "s1", trigger: "本轮词", source: "seed" }] },
      // 更近的另一条消息的投递：不落到本消息下（同一次投递不再重复出现）。
      { deliveryId: "d-other", sourceMessageId: "m-9", at: new Date(harness.timers.now() - 30_000).toISOString(), sessionId: "session-A",
        cards: [{ sparkId: "s2", trigger: "别条消息的词", source: "seed" }] },
    ],
    nodes: [cardNode("s1", "卡片甲", null), cardNode("s2", "卡片乙", null)],
  };
  const { ui } = await bootFlashback({ graph });
  try {
    assert.equal(ui.textOf("button"), "闪回1", "徽标只数本条消息的投递（N=1，不是 2）");
    assert.equal(openPopup(ui, 1), true);
    ui.rerender();
    const text = ui.text();
    assert.ok(text.includes("已精确关联本轮回复（sourceMessageId）"), "精确口径如实标注");
    assert.ok(text.includes("卡片甲"), "本轮投递的卡片在列");
    assert.equal(text.includes("别条消息的词"), false, "别的消息的投递不出现");
    assert.equal(text.includes("最近一次投递（10 分钟内）"), false, "精确命中时不再标近似口径");
  } finally {
    ui.unmount();
  }
});

// ── ④旧记录回落 10 分钟窗口 ────────────────────────────────────────────────

test("5D ④旧记录回落：无 sourceMessageId 的投递按 10 分钟窗口近似关联并如实标注", async () => {
  const graph = {
    deliveries: [
      { deliveryId: "d-legacy", at: new Date(harness.timers.now() - 60_000).toISOString(), sessionId: "session-A",
        cards: [{ sparkId: "s1", trigger: "老词", source: "related" }] },
    ],
    nodes: [cardNode("s1", "旧卡片", null)],
  };
  const { ui } = await bootFlashback({ graph });
  try {
    assert.equal(ui.textOf("button"), "闪回1", "旧记录窗口回落：按钮占位显示 N");
    assert.equal(openPopup(ui, 1), true);
    ui.rerender();
    const text = ui.text();
    assert.ok(text.includes("最近一次投递（10 分钟内）"), "近似口径如实标注");
    assert.ok(text.includes("无法精确到单条消息"), "绝不假装精确到具体消息");
    assert.ok(text.includes("旧卡片"), "回落命中的卡片在列");
  } finally {
    ui.unmount();
  }
});

// ── ④宿主缺 messageId：回落但不许误标精确（review R2）──────────────────────

test("5D ④无 messageId：投递带 sourceMessageId 也只能走窗口回落，浮层不出现「已精确关联」", async () => {
  const graph = {
    deliveries: [
      { deliveryId: "d-1", sourceMessageId: "m-9", at: new Date(harness.timers.now() - 60_000).toISOString(), sessionId: "session-A",
        cards: [{ sparkId: "s1", trigger: "词一", source: "seed" }] },
    ],
    nodes: [cardNode("s1", "卡片甲", null)],
  };
  // 故意不传 messageId（宿主没给 assistant 消息 id）。
  const { ui } = await bootFlashback({ graph, slotProps: { messageId: "" } });
  try {
    assert.equal(ui.textOf("button"), "闪回1", "无 messageId：窗口回落命中，按钮占位显示 N");
    assert.equal(openPopup(ui, 1), true);
    ui.rerender();
    const text = ui.text();
    assert.equal(text.includes("已精确关联本轮回复"), false, "回落口径不许误标「已精确关联」（review R2）");
    assert.ok(text.includes("最近一次投递（10 分钟内）"), "如实标注近似口径");
  } finally {
    ui.unmount();
  }
});

// ── ⑤有用/没用 → spark_feedback ────────────────────────────────────────────

test("5D ⑤有用/没用：executeTool 调 spark_feedback 的 used 值正确、带 sourceEventId，已反馈置灰防重复", async () => {
  const graph = {
    deliveries: [
      { deliveryId: "d-1", sourceMessageId: "m-1", at: new Date(harness.timers.now() - 60_000).toISOString(), sessionId: "session-A",
        cards: [{ sparkId: "s1", trigger: "触发词A", source: "seed" }, { sparkId: "s2", trigger: null, source: "related" }] },
    ],
    nodes: [cardNode("s1", "卡片甲", null), cardNode("s2", "卡片乙", null)],
  };
  const { ui, log } = await bootFlashback({ graph });
  try {
    assert.equal(openPopup(ui, 2), true);
    ui.rerender();
    // 浮层里的反馈按钮没有 aria-label（主按钮有）——按这个差别挑出来。
    const feedbackButtons = () => ui.findAll("button").filter((el) => el.getAttribute("aria-label") === null);
    assert.deepEqual(feedbackButtons().map((el) => ui.textOfEl(el)), ["有用", "没用", "有用", "没用"], "每张卡两个动作");

    feedbackButtons()[0].onclick(); // 卡一「有用」
    await ui.flush();
    const feedbackCalls = log.filter((c) => c.method === "executeTool");
    assert.deepEqual(feedbackCalls, [
      { method: "executeTool", sessionId: "session-A", payload: { name: "spark_feedback", args: { id: "s1", used: true, sourceEventId: "d-1" } } },
    ], "「有用」→ spark_feedback used:true + sourceEventId=投递 id");

    ui.rerender();
    let buttons = feedbackButtons();
    assert.equal(ui.textOfEl(buttons[0]), "已反馈有用", "已反馈置灰改文案");
    assert.equal(String(buttons[0].getAttribute("disabled")), "true", "disabled 防重复");
    const callsBefore = log.length;
    buttons[0].onclick(); // 手滑再点：本地守卫拦下
    await ui.flush();
    assert.equal(log.length, callsBefore, "已反馈的卡不再重复打 spark_feedback");

    feedbackButtons()[3].onclick(); // 卡二「没用」
    await ui.flush();
    const second = log.filter((c) => c.method === "executeTool")[1];
    assert.deepEqual(second.payload.args, { id: "s2", used: false, sourceEventId: "d-1" }, "「没用」→ used:false");
  } finally {
    ui.unmount();
  }
});

// ── ⑥点卡片标题跳图谱节点（jump 总线）──────────────────────────────────────

test("5D ⑥点卡片标题跳图谱节点：push('spark', sparkId) 进 jump 总线", async () => {
  const pushed = [];
  const jump = { push: (type, id) => pushed.push([type, id]) };
  const graph = {
    deliveries: [
      { deliveryId: "d-1", sourceMessageId: "m-1", at: new Date(harness.timers.now() - 60_000).toISOString(), sessionId: "session-A",
        cards: [{ sparkId: "s1", trigger: "触发词A", source: "seed" }] },
    ],
    nodes: [cardNode("s1", "卡片甲", null)],
  };
  const { ui } = await bootFlashback({ graph, slotProps: { jump } });
  try {
    assert.equal(openPopup(ui, 1), true);
    ui.rerender();
    const title = ui.findAll("div").find((el) => el.getAttribute("aria-label") === "查看图谱节点：卡片甲");
    assert.ok(title, "卡片标题可定位（完整标题进 aria-label）");
    assert.equal(pushed.length, 0, "未点不动");
    title.onclick();
    assert.deepEqual(pushed, [["spark", "s1"]], "点标题 → 总线 push spark id（面板端复用 jumpFromTimeline）");
  } finally {
    ui.unmount();
  }
});

// ── ⑥面板接手 jump 总线（复用 jumpFromTimeline 链路）────────────────────────

test("5D ⑥面板接手 jump 总线：push spark → jumpFromTimeline 切图谱页", async () => {
  const handlers = [];
  const jump = {
    push: (type, id) => { for (const fn of handlers) fn(type, id); },
    setHandler: (fn) => { handlers.length = 0; handlers.push(fn); return () => {}; },
  };
  const ui = await harness.mount({ slotProps: { jump } });
  try {
    ui.render();
    await ui.flush();
    assert.equal(handlers.length, 1, "面板已接手总线");
    jump.push("spark", "s1");
    assert.equal(ui.host.states[0], "graph", "push spark → 面板切到图谱页（与时间线跳转同一链路）");
  } finally {
    ui.unmount();
  }
});

// ── ⑦底部汇总与语义分 ──────────────────────────────────────────────────────

test("5D ⑦底部汇总：本轮 N 张 / 触发词命中 x / 语义补位 y；语义卡显示语义分与来源", async () => {
  const graph = {
    deliveries: [
      { deliveryId: "d-1", sourceMessageId: "m-1", at: new Date(harness.timers.now() - 60_000).toISOString(), sessionId: "session-A",
        cards: [
          { sparkId: "s1", trigger: "词一", source: "seed" },
          { sparkId: "s2", trigger: "词二", source: "related" },
          { sparkId: "s3", trigger: null, source: "semantic", score: 0.83 },
          { sparkId: "s4", trigger: null, source: "seed" },
        ] },
    ],
    nodes: [cardNode("s1", "卡一", null), cardNode("s2", "卡二", null), cardNode("s3", "卡三", null), cardNode("s4", "卡四", null)],
  };
  const { ui } = await bootFlashback({ graph });
  try {
    assert.equal(openPopup(ui, 4), true);
    ui.rerender();
    const text = ui.text();
    assert.ok(text.includes("本轮 4 张 / 触发词命中 3 / 语义补位 1"), "底部汇总口径");
    assert.ok(text.includes("来源：语义补位"), "语义来源文案");
    assert.ok(text.includes("· 语义分 0.83"), "语义相似分（命中时）");
    assert.ok(text.includes("命中触发词：未记录 · 来源：语义补位"), "语义卡无触发词如实标注");
  } finally {
    ui.unmount();
  }
});

test("5D ⑦摘要一行：节点带摘要则显示（折叠空白 + 截断），无摘要不占行", async () => {
  const graph = {
    deliveries: [
      { deliveryId: "d-1", sourceMessageId: "m-1", at: new Date(harness.timers.now() - 60_000).toISOString(), sessionId: "session-A",
        cards: [{ sparkId: "s1", trigger: "词一", source: "seed" }, { sparkId: "s2", trigger: null, source: "related" }] },
    ],
    nodes: [cardNode("s1", "卡一", "  这是一段   带空白的摘要  "), cardNode("s2", "卡二", null)],
  };
  const { ui } = await bootFlashback({ graph });
  try {
    assert.equal(openPopup(ui, 2), true);
    ui.rerender();
    const text = ui.text();
    assert.ok(text.includes("这是一段 带空白的摘要"), "摘要折叠空白后一行显示");
    // 卡二无摘要：它的卡片区块不含多余摘要行（整个浮层只有一条摘要文本）。
    assert.equal((text.match(/这是一段/g) || []).length, 1, "无摘要的卡不渲染摘要行");
  } finally {
    ui.unmount();
  }
});

// ── ⑧插槽注册与 jump 总线接线 ──────────────────────────────────────────────

test("5D ⑧apply 接线：assistant-actions 注入 jump 总线；ctx.shioriJump 暴露 push/setHandler", async () => {
  await harness.install();
  try {
    const host = harness.makeStatefulReact();
    const zod = await harness.ensureZod();
    const mod = harness.registrations[0].factory((n) => (n === "react" ? host.react : zod));
    const registered = {};
    const ctx = {
      remote: { $mount: async () => () => {} },
      slots: {
        inject: (name, fn) => fn(),
        register: (meta, render) => { registered[meta.name] = { meta, render }; return () => {}; },
      },
    };
    const cleanup = await mod.apply(ctx);
    assert.ok(ctx.shioriJump, "ctx.shioriJump 可选入口已挂");
    assert.equal(typeof ctx.shioriJump.push, "function", "push 可调");
    assert.equal(typeof ctx.shioriJump.setHandler, "function", "setHandler 可调");
    const action = registered["conversation.chat.assistant-actions"];
    assert.ok(action, "assistant-actions 插槽已注册");
    assert.equal(action.meta.id, "shiori-flashbacks", "插槽 id 不变");
    const vnode = action.render({ messageId: "m-1", shioriSessionId: "session-A" });
    assert.equal(vnode.type.name, "FlashbackActions", "render 落到按钮组件");
    // apply 内部创建的总线与 ctx.shioriJump 是同源暴露（同一组 push/setHandler 函数）。
    assert.equal(vnode.props.jump.push, ctx.shioriJump.push, "FlashbackActions 拿到的 push 与 ctx 暴露同源");
    assert.equal(vnode.props.jump.setHandler, ctx.shioriJump.setHandler, "FlashbackActions 拿到的 setHandler 与 ctx 暴露同源");
  } finally {
    harness.restore();
  }
});

// ── ⑨level 2 跨簇边：外部端点小标记可跳簇 ──────────────────────────────────

function level1Fixture() {
  return {
    scope: "amber",
    level: 1,
    clusters: [
      { key: "项目甲", label: "项目甲", count: 2, samples: ["卡一", "卡二"] },
      { key: "项目乙", label: "项目乙", count: 1, samples: ["卡四"] },
    ],
    total: 3,
  };
}

function level2Fixture() {
  return {
    scope: "amber",
    level: 2,
    cluster: { key: "项目甲", label: "项目甲", count: 2 },
    nodes: [cardNode("spk-1", "卡一", null), cardNode("spk-2", "卡二", null)],
    edges: [
      { source: "spk-1", target: "spk-2", rel: null },                          // 簇内边：照旧
      { source: "spk-1", target: "spk-out", rel: null, toCluster: "项目乙" },    // 跨簇边（5C 约定带端点簇信息）
      { source: "spk-2", target: "spk-x", rel: null },                          // 跨簇边（无簇信息：静态标记）
    ],
    deliveries: [],
    deliveryStats: { rounds: 0, totalDelivered: 0, uniqueCards: 0 },
  };
}

async function mountGraphTab() {
  await harness.install();
  const host = harness.makeStatefulReact();
  const zod = await harness.ensureZod();
  const mod = harness.registrations[0].factory((n) => (n === "react" ? host.react : zod));
  let sectionVNode = null;
  await mod.apply({
    remote: { $mount: async () => () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { sectionVNode = render({ entryKey: "dsh-shiori" }); return () => {}; },
    },
  });
  // 面板是函数组件：预置 tab=graph 后执行一次组件函数拿到展开后的树，才能从中
  // 找到 GraphTab（与既有 ui-flashbacks 的 mountSection 同款做法；effects 不跑，
  // states 随后由用例重置）。
  host.states.length = 0;
  host.states.push("graph", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const tab = harness.flattenVNode(sectionTree).find((n) => n && n.type && n.type.name === "GraphTab");
  assert.ok(tab, "GraphTab 经真实插槽挂载");
  return { host, tab };
}

test("5D ⑨跨簇边：level 2 保留指向簇外的边，外部端点画小标记、点击跳到对应簇", async () => {
  const { host, tab } = await mountGraphTab();
  try {
    const calls = [];
    const dsh = {
      call: async (method, session, payload) => {
        calls.push({ method, session, payload });
        return payload && payload.level === 2 ? level2Fixture() : level1Fixture();
      },
    };
    host.states.length = 0;
    host.states.push(level1Fixture(), null, null, { x: 0, y: 0, k: 1 }, null, "", false, { sessionId: "session-A", gen: 0 }, null);
    host.cursor.v = 0;
    let tree = tab.type({ dsh, sessionId: "session-A" });

    const clusterG = harness.flattenVNode(tree).find(
      (n) => n.type === "g" && String(n.props["aria-label"] || "").indexOf("项目甲") >= 0);
    assert.ok(clusterG, "首屏簇圆可定位");
    clusterG.props.onPointerUp();
    await flushAsync();
    host.cursor.v = 0;
    tree = tab.type({ dsh, sessionId: "session-A" });

    const jumpMarkers = harness.flattenVNode(tree).filter(
      (n) => n.type === "g" && String(n.props["aria-label"] || "").indexOf("跳转到簇 ") === 0);
    assert.equal(jumpMarkers.length, 1, "带端点簇信息的跨簇边 → 可跳转的外部端点标记");
    assert.equal(jumpMarkers[0].props["aria-label"], "跳转到簇 项目乙", "标记指向目标簇");
    assert.equal(harness.flattenVNode(tree).filter((n) => n.type === "g" && n.props["aria-label"] === "指向簇外的卡片").length, 1,
      "无簇信息的跨簇边 → 静态外部端点标记（不再静默丢弃）");
    assert.equal(harness.flattenVNode(tree).filter((n) => n.type === "line").length, 3,
      "跨簇边画线到外部端点（簇内 1 + 跨簇 2）");
    const smallCircles = harness.flattenVNode(tree).filter((n) => n.type === "circle" && n.props.r === 5);
    assert.equal(smallCircles.length, 2, "外部端点是小标记（r=5）");

    jumpMarkers[0].props.onPointerUp();
    await flushAsync();
    assert.deepEqual(calls[calls.length - 1].payload, { level: 2, cluster: "项目乙" }, "点标记 → enterCluster 拉目标簇 level=2");
  } finally {
    harness.restore();
  }
});

test("5D ⑨跨簇边边界：两端都不在本簇节点集的边不属于本视图，不渲染", async () => {
  const { host, tab } = await mountGraphTab();
  try {
    const level2 = {
      ...level2Fixture(),
      edges: [
        { source: "spk-out-a", target: "spk-out-b", rel: null, toCluster: "项目乙", fromCluster: "项目乙" },
      ],
    };
    const dsh = {
      call: async (method, session, payload) => (payload && payload.level === 2 ? level2 : level1Fixture()),
    };
    host.states.length = 0;
    host.states.push(level1Fixture(), null, null, { x: 0, y: 0, k: 1 }, null, "", false, { sessionId: "session-A", gen: 0 }, null);
    host.cursor.v = 0;
    let tree = tab.type({ dsh, sessionId: "session-A" });
    const clusterG = harness.flattenVNode(tree).find(
      (n) => n.type === "g" && String(n.props["aria-label"] || "").indexOf("项目甲") >= 0);
    clusterG.props.onPointerUp();
    await flushAsync();
    host.cursor.v = 0;
    tree = tab.type({ dsh, sessionId: "session-A" });
    assert.equal(harness.flattenVNode(tree).filter((n) => n.type === "line").length, 0, "两端缺席的边不画线");
    assert.equal(harness.flattenVNode(tree).filter((n) => n.type === "g" && String(n.props["aria-label"] || "").indexOf("跳转到簇") === 0).length, 0,
      "两端缺席的边不渲染标记");
  } finally {
    harness.restore();
  }
});
