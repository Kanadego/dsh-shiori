// ui-harness 自身验证（R3）：走一条真实重渲染循环 + unmount 无泄漏，
// 并对可控定时器、useEffect deps/cleanup、useRef 持久、useState 合并、rerender 的
// diff 渲染语义（§9 债 4②）与表单交互钩子 find/findAll/change/textOf（§9 债 7）
// 做判别性断言。
// 证据级别：真实执行 client/index.js（ShioriSection → MemoryTab 组件函数真执行），
// harness 的 renderer 把 vnode 落地为 fake document element 树，click 触发 onClick →
// useState 变更 → rerender 重新执行组件函数 → DOM 文本变化。非浏览器实机。

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createUiHarness } from "./ui-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const CLIENT_SRC = join(WORKQ, "client", "index.js");

const MEMORY_VIEW = {
  scope: "amber",
  l0: { text: "# 人设卡标题\n常驻身份说明", revision: "r0", chars: 12, stale: false },
  l1: { text: "CORE BODY", body: "CORE BODY", revision: "r1", chars: 9 },
  budgets: { persona: { maxChars: 12000 }, core: { targetChars: 8000 } },
};

function makeDsh() {
  const calls = [];
  const dsh = {
    call: async (method, sessionId, payload) => {
      calls.push({ method, payload });
      if (method === "getMemoryView") return MEMORY_VIEW;
      if (method === "getStatus") return { mode: "active", diagnostics: { readonly: null } };
      return {};
    },
  };
  dsh.calls = calls;
  return dsh;
}

// ── H1 真实重渲染循环 ───────────────────────────────────────────────
test("H1 真实重渲染：挂载 memory tab → click 编辑 → rerender → DOM 文本变化", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const dsh = makeDsh();

  const mounted = await harness.mount({ tab: "memory", dsh });
  try {
    mounted.render();
    await mounted.flush();   // 跑 getMemoryView effect → setView
    mounted.rerender();      // view 就位后重渲染

    const before = mounted.text();
    assert.ok(before.includes("记忆内容"), "初始渲染含 tab 标签");
    assert.ok(before.includes("编辑"), "初始渲染含编辑按钮");

    const clicked = mounted.click('button[text=编辑]');
    assert.equal(clicked, true, "click 命中编辑按钮");
    mounted.rerender();

    const after = mounted.text();
    assert.ok(after.includes("取消"), "进编辑态后出现取消按钮");
    assert.notEqual(after, before, "重渲染后文本与初始不同（状态变更已生效）");
  } finally {
    mounted.unmount();
  }
});

// ── H2 unmount 定时器清空 + 全局逐字节还原 ───────────────────────────
// 判别性：mount 默认安装可控定时器；restore 卸载并逐字节还原 4 个全局引用。
// 删掉 restore 里的 fakeTimers.restore() 调用，下面两条会红。
test("H2a 正常 mount→unmount 后：4 个定时器全局逐字节还原 + pendingCount 0", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const stBefore = globalThis.setTimeout;
  const siBefore = globalThis.setInterval;
  const ctBefore = globalThis.clearTimeout;
  const ciBefore = globalThis.clearInterval;

  const mounted = await harness.mount({ tab: "memory" });
  // mount 默认装了可控定时器：全局已被替换
  assert.notEqual(globalThis.setTimeout, stBefore, "mount 后 setTimeout 已被替换为可控实现");

  mounted.render();
  await mounted.flush();
  mounted.rerender();
  mounted.unmount();

  assert.equal(globalThis.setTimeout, stBefore, "setTimeout 逐字节还原");
  assert.equal(globalThis.setInterval, siBefore, "setInterval 逐字节还原");
  assert.equal(globalThis.clearTimeout, ctBefore, "clearTimeout 逐字节还原");
  assert.equal(globalThis.clearInterval, ciBefore, "clearInterval 逐字节还原");
  assert.equal(harness.timers.pendingCount(), 0, "restore 后无残留定时器");
});

test("H2b 故意留 interval：unmount 必须清掉（删 restore 的 timers.restore 会红）", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const siBefore = globalThis.setInterval; // install 前原引用（H3 windowBefore 同款保存模式）
  const mounted = await harness.mount({ tab: "memory" });
  // install 后 setInterval 必须已替换为可控实现：不再是原引用（自比恒真用例已废）
  assert.notEqual(globalThis.setInterval, siBefore, "install 后 setInterval 已替换为可控实现（非原引用）");
  // 故意在 mount 的假定时器环境里留一个 interval
  globalThis.setInterval(() => {}, 1000);
  assert.equal(harness.timers.pendingCount(), 1, "已留 1 个 interval");

  mounted.unmount();
  assert.equal(harness.timers.pendingCount(), 0, "unmount 清掉残留 interval");
  // restore 后逐字节还原原引用：再排真 interval 不会进 fakeTimers
  assert.equal(globalThis.setInterval, siBefore, "restore 后 setInterval 还原为原引用");
});

// ── H3 install/restore 成对（R5：无条件断言）────────────────────────
test("H3 install/restore 成对：全局键零残留（无条件断言）", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const hadWindow = "window" in globalThis;
  const hadDocument = "document" in globalThis;
  const windowBefore = globalThis.window;
  const documentBefore = globalThis.document;

  await harness.install();
  assert.ok(harness.registrations.length >= 1, "install 后 client 已注册");
  assert.ok(globalThis.document && globalThis.document.createElement, "install 后 document 已装");

  harness.restore();
  // R5：无条件断言——无论 install 前是否有 window/document，restore 后必须回到 install 前状态。
  assert.equal("window" in globalThis, hadWindow, "window 键存在性回到 install 前");
  assert.equal("document" in globalThis, hadDocument, "document 键存在性回到 install 前");
  if (hadWindow) assert.equal(globalThis.window, windowBefore, "window 引用逐字节还原");
  if (hadDocument) assert.equal(globalThis.document, documentBefore, "document 引用逐字节还原");
});

// ── R2 可控定时器语义（对齐真实 timer）─────────────────────────────
// 判别性：advance 按到期排序、重入、interval 漂移、Date.now 推进、句柄 unref。
// 删掉 makeFakeTimers 里的对应实现会红。

test("R2a 定时器按到期时间排序执行（先排晚到、后排早到，早到的先跑）", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  harness.timers.install();
  try {
    const order = [];
    globalThis.setTimeout(() => order.push("late"), 10);
    globalThis.setTimeout(() => order.push("early"), 5);
    await harness.timers.advance(20);
    assert.deepEqual(order, ["early", "late"], "按到期时间升序执行");
  } finally {
    harness.timers.restore();
  }
});

test("R2b 重入：回调内新排且落在本窗口内的定时器同轮执行", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  harness.timers.install();
  try {
    const order = [];
    globalThis.setTimeout(() => {
      order.push("outer");
      globalThis.setTimeout(() => order.push("inner"), 3); // 落在 advance(10) 窗口内
    }, 2);
    await harness.timers.advance(10);
    assert.deepEqual(order, ["outer", "inner"], "重入定时器同轮执行");
  } finally {
    harness.timers.restore();
  }
});

test("R2c interval 漂移：at += interval 不丢错过周期", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  harness.timers.install();
  try {
    let ticks = 0;
    globalThis.setInterval(() => { ticks++; }, 100);
    await harness.timers.advance(250);
    // 真实 setInterval(fn,100) 首次触发在 100ms。at += interval 语义下，
    // 100、200 各触发一次（at 依次 100→200→300），250 窗口内共 2 次。
    // 若实现误用 at = now + interval，首次触发后 at 会跳到 350，只触发 1 次。
    assert.equal(ticks, 2, "250ms 内 interval 触发 2 次（100/200），不丢 200 这次");
    await harness.timers.advance(50);
    assert.equal(ticks, 3, "推进到 300ms 触发第 3 次");
  } finally {
    harness.timers.restore();
  }
});

test("R2d Date.now 随 advance 推进 + 句柄带 unref/no-op", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  harness.timers.install();
  try {
    assert.equal(Date.now(), 0, "install 后 Date.now 归零");
    await harness.timers.advance(50);
    assert.equal(Date.now(), 50, "advance 后 Date.now 推进");
    const handle = globalThis.setTimeout(() => {}, 100);
    assert.equal(typeof handle.unref, "function", "句柄带 unref");
    assert.equal(handle.unref(), handle, "unref 返回自身（no-op）");
    assert.equal(typeof handle.ref, "function", "句柄带 ref");
  } finally {
    harness.timers.restore();
  }
});

// ── R4 react stub 语义（useEffect deps/cleanup、useRef 持久、useState 合并）─
// 判别性：删掉 makeStatefulReact 里的对应实现会红。

test("R4a useEffect 比较 deps 并执行清理函数", () => {
  const { makeStatefulReact } = createUiHarness({ clientSource: CLIENT_SRC });
  const host = makeStatefulReact();
  host.runEffects.v = true;
  const cleanups = [];

  // 模拟 mount 的 flush：执行收集到的 effect 并捕获 cleanup（与 ui-harness.mjs 的 flush 同口径）。
  const flushFx = () => {
    const batch = host.effects.slice();
    host.effects.length = 0;
    for (let i = 0; i < batch.length; i++) {
      const cleanup = batch[i]();
      if (typeof cleanup === "function") host.effectCleanups[i] = cleanup;
    }
  };
  const rerender = () => { host.cursor.v = 0; host.refCursor.v = 0; host.effectCursor.v = 0; };

  // 第一轮：deps=[1] 注册 effect，flush 执行并捕获 cleanup-1
  host.react.useEffect(() => () => cleanups.push("cleanup-1"), [1]);
  flushFx();

  // 第二轮：deps 变 [2] → useEffect 应先执行旧 cleanup-1
  rerender();
  host.react.useEffect(() => () => cleanups.push("cleanup-2"), [2]);
  assert.deepEqual(cleanups, ["cleanup-1"], "deps 变化时先执行旧 cleanup");
  flushFx();

  // 第三轮：deps 仍 [2] → 跳过，不跑新 effect 不跑 cleanup
  rerender();
  host.react.useEffect(() => () => cleanups.push("cleanup-3"), [2]);
  assert.deepEqual(cleanups, ["cleanup-1"], "deps 未变时跳过（不重复执行 cleanup）");
});

test("R4b useRef 跨渲染持久", () => {
  const { makeStatefulReact } = createUiHarness({ clientSource: CLIENT_SRC });
  const host = makeStatefulReact();
  const ref1 = host.react.useRef({ pending: false });
  ref1.current.pending = true;
  // 归位模拟重渲染
  host.cursor.v = 0; host.refCursor.v = 0; host.effectCursor.v = 0;
  const ref2 = host.react.useRef({ pending: false });
  assert.equal(ref1, ref2, "useRef 跨渲染返回同一对象");
  assert.equal(ref2.current.pending, true, "重渲染后 .current 保留之前写入");
});

test("R4c useState 同组件多次 set 合并（最后一次胜出）", () => {
  const { makeStatefulReact } = createUiHarness({ clientSource: CLIENT_SRC });
  const host = makeStatefulReact();
  const [value, setValue] = host.react.useState(0);
  setValue(1);
  setValue(2);
  setValue(3);
  // 同一渲染周期内多次 set，最终 state 槽位 = 最后一次（真实 React 批处理语义）。
  assert.equal(host.states[0], 3, "多次 set 后 states[0] = 最后一次");
  // 函数式 set 链式累加：每次基于最新 states[i] 计算。
  const [v2, setV2] = host.react.useState(10);
  setV2((prev) => prev + 1);
  setV2((prev) => prev + 1);
  assert.equal(host.states[1], 12, "函数式 set 基于最新值链式累加");
});

// ── H5 rerender = diff 渲染（§9 债 4② / 10-3）───────────────────────────────
// 判别性：rerender 必须是 diff 调和而不是全量重建——
//   * 根元素身份保留（退回全量重建会换新对象 → 根引用断言红）；
//   * 未变子树（刷新按钮）保持同一 DOM 引用（同上红）；
//   * 状态变更确实生效（出现取消按钮，退回 no-op rerender 红）。
test("H5 rerender 是 diff 渲染：未变子树 DOM 身份保留（退回全量 render 或 no-op 时红）", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const dsh = makeDsh();

  const mounted = await harness.mount({ tab: "memory", dsh });
  try {
    mounted.render();
    await mounted.flush(); // 跑 getMemoryView effect → setView
    const rootBefore = mounted.rerender();
    const refreshBtnBefore = mounted.find('button[text=刷新]');
    assert.ok(refreshBtnBefore, "刷新按钮可定位（未变子树锚点）");

    assert.equal(mounted.click('button[text=编辑]'), true, "点编辑进入编辑态");
    const rootAfter = mounted.rerender();
    assert.equal(rootAfter, rootBefore, "rerender 后根元素复用同一引用（diff 语义；退回全量重建必红）");
    const refreshBtnAfter = mounted.find('button[text=刷新]');
    assert.equal(refreshBtnAfter, refreshBtnBefore, "未变子树（刷新按钮）保持同一 DOM 引用（退回全量重建必红）");
    assert.ok(mounted.text().includes("取消"), "状态变更已生效（进编辑态出现取消按钮；no-op rerender 必红）");
  } finally {
    mounted.unmount();
  }
});

// ── H4 表单交互钩子直测（§9 债 7 / 10-3）：find/findAll/change/textOf ────────
// 此前四个钩子在 harness 里零引用零自测。判别性：删掉 harness 里任一钩子实现或
// 改坏其语义，对应用例红。

test("H4a find：命中返回元素本体，selector 不匹配返回 null", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const mounted = await harness.mount({ tab: "memory", dsh: makeDsh() });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();
    const btn = mounted.find('button[text=编辑]');
    assert.ok(btn, "命中返回元素（编辑按钮）");
    assert.equal(btn.tagName, "BUTTON", "返回的是 fake DOM 元素本体");
    assert.equal(mounted.find('button[text=不存在的按钮]'), null, "selector 不匹配返回 null");
  } finally {
    mounted.unmount();
  }
});

test("H4b findAll：命中返回元素数组，不匹配返回空数组", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const mounted = await harness.mount({ tab: "memory", dsh: makeDsh() });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();
    const buttons = mounted.findAll('button');
    assert.ok(Array.isArray(buttons), "返回数组");
    assert.ok(buttons.length >= 2, "命中多个按钮（tab 条 + 卡片动作）");
    for (const b of buttons) assert.equal(b.tagName, "BUTTON", "数组元素都是命中元素本体");
    assert.deepEqual(mounted.findAll('button[text=不存在的按钮]'), [], "selector 不匹配返回空数组");
  } finally {
    mounted.unmount();
  }
});

test("H4c change：触发 input+change 事件（先 input 后 change 均带新值）；无命中/无 handler 返回 false", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const mounted = await harness.mount({ tab: "memory", dsh: makeDsh() });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();
    assert.equal(mounted.click('button[text=编辑]'), true, "进入编辑态");
    mounted.rerender();
    assert.ok(mounted.find('textarea'), "编辑态出现 textarea（面板自带 onChange）");

    // 集成位：change 触发面板 onChange → setDraft → 重渲染后 value 属性更新。
    assert.equal(mounted.change('textarea', '新草稿内容'), true, "命中带 onChange 的元素返回 true");
    mounted.rerender();
    assert.equal(mounted.find('textarea').getAttribute('value'), '新草稿内容',
      "change 触发面板 onChange → draft 更新 → textarea value 跟随");

    // 直测事件分发：挂两个监听验证 input 先、change 后，事件均携带新值。
    const events = [];
    const ta = mounted.find('textarea');
    ta.oninput = (e) => events.push(['input', e.target.value]);
    ta.onchange = (e) => events.push(['change', e.target.value]);
    assert.equal(mounted.change('textarea', 'XYZ'), true);
    assert.deepEqual(events, [['input', 'XYZ'], ['change', 'XYZ']], "先 input 后 change，均带 target.value");

    // 无 handler：按钮只有 onclick，change 不算命中；selector 不匹配同样 false
    // （属性名用拉丁字母——matchesSelector 的属性段只认 [a-zA-Z-]+）。
    assert.equal(mounted.change('button[text=刷新]', 'x'), false, "元素无 input/change handler 返回 false");
    assert.equal(mounted.change('textarea[data-harness-nope]', 'x'), false, "selector 不匹配返回 false");
  } finally {
    mounted.unmount();
  }
});

test("H4d textOf：取命中元素文本（含嵌套），selector 不匹配取空文本", async () => {
  const harness = createUiHarness({ clientSource: CLIENT_SRC });
  const mounted = await harness.mount({ tab: "memory", dsh: makeDsh() });
  try {
    mounted.render();
    await mounted.flush();
    mounted.rerender();
    assert.equal(mounted.textOf('button[text=编辑]'), '编辑', "取命中元素文本");
    assert.equal(mounted.textOf('button[text=不存在的按钮]'), '', "selector 不匹配返回空文本");
  } finally {
    mounted.unmount();
  }
});
