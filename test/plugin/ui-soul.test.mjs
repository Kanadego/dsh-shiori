// 0.5-13-4：人设与核心（soul）新页测试。
// 证据级别与 ui-memory / ui-budget 一致：真实执行 client/index.js（ui-harness 的
// fake window.__ModuleLoader__ + 有状态 react stub + 真实宿主 zod），直接渲染
// SoulTab 组件函数（SYNTHETIC，非浏览器实机）。
//
// 覆盖：
// - 三段结构（选卡 / 编辑 / 每轮注入的顺序）；
// - 选卡：工作区 select / 会话 select / 当前生效卡徽标 / 默认人设卡 select + 保存回调；
// - 注入顺序五行：数字全部来自 DTO（换 DTO 数字随之变化、取不到写「—」）；
// - 编辑：核心记忆保存带 expectedRevision；冲突提示「记忆已在别处更新」且保留草稿；
//   对比改动 / 恢复上一版。

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createUiHarness, PANEL_STATES } from "./ui-harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const CLIENT_SRC = join(WORKQ, "client", "index.js");

const harness = createUiHarness({ clientSource: CLIENT_SRC });
await harness.install();

const { makeStatefulReact, flattenVNode, collectText, applyPanel } = harness;

test.after(() => {
  harness.restore();
});

function statusDto(overrides = {}) {
  return Object.assign({
    mode: "active",
    scope: "amber",
    personas: ["amber", "engine"],
    occupancy: { l0Chars: 111, l1Chars: 2222, l0Budget: 12000, l1HardCap: 14000 },
    capabilities: { l2: true, organize: true, forgetting: true, tools: true, sections: true },
    diagnostics: {},
  }, overrides);
}

function memoryView(l1Text, extra = {}) {
  return Object.assign({
    scope: "amber",
    l0: { text: "PERSONA", revision: "l0-rev", chars: 7, budget: 12000, stale: false },
    l1: { text: l1Text, body: l1Text.split("## 主题记忆索引")[0].trim(), revision: "rev-1", chars: l1Text.length, budget: 8000, hardCap: 14000 },
  }, extra);
}

// SoulTab useState 顺序（面板 9 个之后）：status / view / loadError / editKind /
// drafts / busy / saveError / saveOk / diffOpen / guard。
const SOUL_STATES = 10;

async function mountSoulTab() {
  const host = makeStatefulReact();
  const { sectionVNode } = await applyPanel(host);
  host.states.length = 0;
  host.states.push("soul", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const soulTab = flattenVNode(sectionTree)
    .find((n) => typeof typeof n.type === "function" && n.type.name === "SoulTab");
  assert.ok(soulTab, "SoulTab reached through real slot render");
  return (props) => {
    host.states.length = Math.max(host.states.length, PANEL_STATES + SOUL_STATES);
    host.cursor.v = PANEL_STATES;
    return soulTab.type(Object.assign({
      sessionId: "session-A",
      sessions: [{ sessionId: "session-A", title: "会话 A" }, { sessionId: "session-B", title: "会话 B" }],
      workspaces: [{ workspaceId: "ws-1", title: "项目甲", path: "D:/proj/a" }],
      workspaceId: "ws-1",
      defaultPersonaValue: "amber",
      defaultPersonaOptions: ["amber", "engine"],
      readOnly: false,
    }, props));
  };
}

function statefulRender(host, render) {
  // 预置 status / view 两个 state，避免跑 load effect 发 RPC。
  host.states[PANEL_STATES] = statefulRender.status;
  host.states[PANEL_STATES + 1] = statefulRender.view;
  return render({ dsh: statefulRender.dsh });
}

function baseDsh(onCall) {
  return {
    call: async (method, sessionId, payload) => {
      if (typeof onCall === "function") {
        const handled = onCall(method, sessionId, payload);
        if (handled !== undefined) return handled;
      }
      return {};
    },
  };
}

test("Soul：三段结构 + 选卡（工作区/会话/当前生效卡/默认卡保存回调）", async () => {
  const host = makeStatefulReact();
  const { sectionVNode } = await applyPanel(host);
  host.states.length = 0;
  host.states.push("soul", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const soulTab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "SoulTab");
  let saved = 0;
  host.states[PANEL_STATES] = statusDto();
  host.states[PANEL_STATES + 1] = memoryView("CORE BODY");
  host.cursor.v = PANEL_STATES;
  const tree = soulTab.type({
    sessionId: "session-A",
    dsh: baseDsh(),
    sessions: [{ sessionId: "session-A", title: "会话 A" }, { sessionId: "session-B", title: "会话 B" }],
    workspaces: [{ workspaceId: "ws-1", title: "项目甲", path: "D:/proj/a" }],
    workspaceId: "ws-1",
    defaultPersonaValue: "amber",
    defaultPersonaOptions: ["amber", "engine"],
    onSaveDefaultPersona: () => { saved += 1; },
    readOnly: false,
  });
  const flat = flattenVNode(tree);
  for (const role of ["soul-select-card", "soul-edit-card", "soul-order-card"]) {
    assert.ok(flat.some((n) => n.props && n.props["data-role"] === role), "三段结构：" + role);
  }
  const workspaceSelect = flat.find((n) => n.props && n.props["data-role"] === "soul-workspace-select");
  assert.ok(workspaceSelect && workspaceSelect.type === "select", "工作区 select 存在");
  assert.deepEqual(flattenVNode(workspaceSelect).filter((c) => c.type === "option").map((o) => collectText(o)),
    ["所有工作区", "项目甲"], "工作区选项来自宿主列表");
  const sessionSelect = flat.find((n) => n.props && n.props["data-role"] === "soul-session-select");
  assert.ok(sessionSelect && sessionSelect.type === "select", "会话 select 存在");
  assert.equal(sessionSelect.props.value, "session-A", "会话 select 回显当前会话");
  const badge = flat.find((n) => n.props && n.props["data-role"] === "soul-current-badge");
  assert.equal(badge.children.join(""), "amber", "当前生效卡徽标来自 getStatus.scope");
  const defaultSelect = flat.find((n) => n.props && n.props["data-role"] === "soul-default-select");
  assert.equal(defaultSelect.props.value, "amber", "默认人设卡 select 回显");
  const saveBtn = flat.find((n) => n.props && n.props["data-role"] === "soul-save-default");
  assert.ok(saveBtn, "保存默认卡按钮");
  saveBtn.props.onClick();
  assert.equal(saved, 1, "保存默认卡复用既有写入回调");
});

test("Soul：每轮注入顺序五行的数字来自 DTO（不写死；取不到写「—」）", async () => {
  const host = makeStatefulReact();
  const { sectionVNode } = await applyPanel(host);
  host.states.length = 0;
  host.states.push("soul", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const soulTab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "SoulTab");

  const renderWith = (status, view) => {
    host.states.length = Math.max(host.states.length, PANEL_STATES + SOUL_STATES);
    host.states[PANEL_STATES] = status;
    host.states[PANEL_STATES + 1] = view;
    host.cursor.v = PANEL_STATES;
    return soulTab.type({ sessionId: "session-A", dsh: baseDsh(), sessions: [], readOnly: false });
  };
  const indexText = "BODY\n\n## 主题记忆索引 / Topic memory index\n- a\n- bb";
  let tree = renderWith(statusDto({ occupancy: { l0Chars: 111, l1Chars: 2222, l0Budget: 12000, l1HardCap: 14000 } }), memoryView(indexText));
  const orderText = (t) => flattenVNode(t).filter((n) => n.props && String(n.props["data-role"] || "").startsWith("soul-order-")).map((n) => collectText(n)).join("|");
  assert.ok(orderText(tree).includes("1 人设卡（111 字，不计水位）"), "第 1 行取 occupancy.l0Chars");
  assert.ok(orderText(tree).includes("2 核心记忆（2222 字，计水位）"), "第 2 行取 occupancy.l1Chars");
  assert.ok(orderText(tree).includes("3 专题索引（2 行 7 字，超硬水位从尾部截断）"), "第 3 行从 l1 派生索引真实行数/字数");
  assert.ok(orderText(tree).includes("4 冷专题提示（一行）"), "第 4 行");
  assert.ok(orderText(tree).includes("5 闪回（不进系统提示，只随消息附上）"), "第 5 行");

  // 换一份 DTO：数字必须跟着变（证明不是写死）。
  tree = renderWith(statusDto({ occupancy: { l0Chars: 7, l1Chars: 9, l0Budget: 12000, l1HardCap: 14000 } }), memoryView("B\n\n## 主题记忆索引 / Topic memory index\n- zzzz"));
  const updated = orderText(tree);
  assert.ok(updated.includes("1 人设卡（7 字，不计水位）"), "第 1 行跟随 DTO");
  assert.ok(updated.includes("2 核心记忆（9 字，计水位）"), "第 2 行跟随 DTO");
  assert.ok(updated.includes("3 专题索引（1 行 6 字，超硬水位从尾部截断）"), "第 3 行跟随 DTO");

  // 取不到：occupancy 缺席 / 没有索引段 → 「—」，不编造。
  tree = renderWith(statusDto({ occupancy: null }), memoryView("NO INDEX"));
  const missing = orderText(tree);
  assert.ok(missing.includes("1 人设卡（— 字，不计水位）") && missing.includes("2 核心记忆（— 字，计水位）"), "缺失时写「—」");
  assert.ok(missing.includes("3 专题索引（— 行 — 字，超硬水位从尾部截断）"), "索引缺失写「—」");

});

test("Soul：核心记忆保存带 expectedRevision；冲突保留草稿并提示；对比改动 / 恢复上一版", async () => {
  const host = makeStatefulReact();
  const { sectionVNode } = await applyPanel(host);
  host.states.length = 0;
  host.states.push("soul", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const soulTab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "SoulTab");
  const calls = [];
  const dsh = baseDsh((method, sessionId, payload) => {
    if (method === "executeTool") {
      calls.push(payload);
      const error = new Error("版本冲突");
      error.code = "REVISION_CONFLICT";
      throw error;
    }
    return undefined;
  });
  host.states[PANEL_STATES] = statusDto();
  host.states[PANEL_STATES + 1] = memoryView("CORE BODY");
  const render = (extra = {}) => {
    host.cursor.v = PANEL_STATES;
    return soulTab.type(Object.assign({ sessionId: "session-A", dsh, sessions: [], readOnly: false }, extra));
  };
  let tree = render();
  // 切到核心记忆编辑器。
  flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "soul-edit-tab-l1").props.onClick();
  tree = render();
  let textarea = flattenVNode(tree).find((n) => n.type === "textarea");
  assert.equal(textarea.props.value, "CORE BODY", "编辑器初值取 L1 body");
  textarea.props.onChange({ target: { value: "NEW DRAFT" } });
  tree = render();
  textarea = flattenVNode(tree).find((n) => n.type === "textarea");
  assert.equal(textarea.props.value, "NEW DRAFT", "草稿进入编辑框");
  assert.ok(collectText(flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "soul-char-count")).includes("9 字"), "字数统计跟随草稿");

  // 对比改动。
  flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "soul-diff-toggle").props.onClick();
  tree = render();
  const diff = flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "soul-diff");
  assert.ok(diff, "对比改动区出现");
  const diffText = collectText(diff);
  assert.ok(diffText.includes("− CORE BODY") && diffText.includes("+ NEW DRAFT"), "对比显示旧行与新行");

  // 保存 → REVISION_CONFLICT：错误上屏、提示「记忆已在别处更新」、草稿保留。
  flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "soul-save").props.onClick();
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  tree = render();
  assert.equal(calls.length, 1, "保存发一次 executeTool");
  assert.equal(calls[0].name, "core_write", "核心记忆走 core_write");
  assert.equal(calls[0].args.expectedRevision, "rev-1", "带 expectedRevision 校验");
  assert.equal(calls[0].args.content, "NEW DRAFT", "写入草稿正文");
  textarea = flattenVNode(tree).find((n) => n.type === "textarea");
  assert.equal(textarea.props.value, "NEW DRAFT", "冲突后草稿保留在编辑框");
  const conflict = flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "soul-conflict");
  assert.ok(conflict, "冲突提示节点存在");
  assert.ok(collectText(conflict).includes("记忆已在别处更新"), "冲突文案");

  // 恢复上一版：编辑框回到服务端当前版本。
  flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "soul-restore").props.onClick();
  tree = render();
  textarea = flattenVNode(tree).find((n) => n.type === "textarea");
  assert.equal(textarea.props.value, "CORE BODY", "恢复上一版回到服务端已保存文本");
});
