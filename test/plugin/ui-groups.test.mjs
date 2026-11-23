// S3.4 分组管理 UI 测试（0.4）。证据级别与 ui-0.3.test.mjs 相同：真实执行
// client/index.js（fake window.__ModuleLoader__ + 有状态 react stub + 真实宿主
// zod 经绝对 file URL 导入），synthetic 渲染树，非浏览器实机。
// 覆盖：建组 / 改名 / 改摘要 / 调序 / 删空组 / 删非空组的迁移确认（列成员 + 选
// migrateTo 目标组）/ 成员浏览复用平铺行组件；全部走 group_manage 工具，
// 断言 executeTool payload 形状（不新开后端接口）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKQ = join(HERE, "..", "..");
const NPM_GLOBAL = process.env.DSH_NPM_GLOBAL
  ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
const HOST_MODULES = process.env.DSH_HOST_MODULES ?? join(NPM_GLOBAL, "@deepseek-ai", "dsh", "node_modules");

const zod = await import(`file:///${HOST_MODULES}/zod/index.js`);

// ---------------------------------------------------------------------------
// harness（照 ui-0.3.test.mjs：有状态 react stub + 真实 slot 渲染定位 tab）
// ---------------------------------------------------------------------------

const registrations = [];
globalThis.window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } };
await import(pathToFileURL(join(WORKQ, "client", "index.js")).href);

function makeStatefulReact() {
  const states = [];
  const effects = [];
  const cursor = { v: 0 };
  const runEffects = { v: false };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    Fragment: "fragment",
    useState: (initial) => {
      const i = cursor.v++;
      if (!(i in states)) states[i] = typeof initial === "function" ? initial() : initial;
      return [states[i], (v) => { states[i] = typeof v === "function" ? v(states[i]) : v; }];
    },
    useEffect: (fn) => { if (runEffects.v) effects.push(fn); },
    useMemo: (factory) => factory(),
    useRef: () => ({ current: null }),
  };
  return { react, states, effects, cursor, runEffects };
}

function flattenVNode(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) flattenVNode(child, out); return out; }
  if (!node || typeof node !== "object") return out;
  out.push(node);
  if (node.children) flattenVNode(node.children, out);
  return out;
}

function collectText(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out.join(""); }
  if (node === null || node === undefined || typeof node === "boolean") return out.join("");
  if (typeof node !== "object") { out.push(String(node)); return out.join(""); }
  if (node.children) collectText(node.children, out);
  return out.join("");
}

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

function findButton(tree, label) {
  return flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === label) || null;
}

function findButtons(tree, label) {
  return flattenVNode(tree).filter((n) => n.type === "button" && collectText(n) === label);
}

function findCard(tree, role) {
  return flattenVNode(tree).find((n) => n.props && n.props["data-role"] === role) || null;
}

// CandidatesTab useState（0.4 S3.4 追加后）：data / error / busy / proposal(槽位保留) /
// preview / previewError / guard / topics / titles / filter / search /
// groups / groupForm / memberView / migration / groupBusy / groupError /
// archivePage / candidatesPage。预置只填前 7 个（与 ui-0.3 同口径），其余自动初始化。
const CANDIDATE_BASE_STATES = (data) => [data, null, false, "", null, null, { sessionId: "session-A", gen: 0 }];

async function mountCandidates(data) {
  const host = makeStatefulReact();
  const mod = registrations[0].factory((n) => (n === "react" ? host.react : zod));
  let renderSlot = null;
  await mod.apply({
    remote: { $mount: async () => async () => {} },
    slots: {
      inject: (name, fn) => fn(),
      register: (meta, render) => { renderSlot = render; return () => {}; },
    },
  });
  const sectionVNode = renderSlot({ entryKey: "dsh-shiori" });
  host.states.length = 0;
  host.states.push("candidates", "session-A", "", null, { mode: "active" });
  host.cursor.v = 0;
  const sectionTree = sectionVNode.type(sectionVNode.props);
  const tab = flattenVNode(sectionTree).find((n) => typeof n.type === "function" && n.type.name === "CandidatesTab");
  assert.ok(tab, "CandidatesTab reached through real slot render");
  host.states.length = 0;
  host.states.push(...CANDIDATE_BASE_STATES(data));
  // states 预置一次后跨渲染保留（异步 setGroups / setMigration 等在重渲染时可见）。
  const renderRaw = (dsh) => {
    host.cursor.v = 0;
    host.runEffects.v = false;
    return tab.type({ dsh, sessionId: "session-A", readOnly: false });
  };
  // 0.5.0 转正：索引归档 / 分组管理改互斥手风琴（默认只开归档块）。本文件只测分组
  // 管理，挂载后自动点开「分组管理」块；之后状态保留，重渲染仍是展开态。
  let groupsAutoOpened = false;
  const render = (dsh) => {
    let tree = renderRaw(dsh);
    if (!groupsAutoOpened && !findCard(tree, "group-manage")) {
      const head = findCard(tree, "organize-acc-head-groups");
      if (head && head.props && typeof head.props.onClick === "function") {
        head.props.onClick();
        groupsAutoOpened = true;
        tree = renderRaw(dsh);
      }
    }
    return tree;
  };
  return { host, render };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const emptyCandidates = { queueRevision: 5, items: [], plans: [] };

const groupListFixture = () => ({
  scope: "amber",
  action: "list",
  revision: "grev-1",
  groups: [
    { key: "dev", title: "开发与配置", summary: "DSH / 插件", order: 10, topics: 2 },
    { key: "life", title: "生活与偏好", summary: "", order: 20, topics: 0 },
  ],
});

const topicsFixture = () => [
  { key: "t-deploy", title: "部署笔记", summary: "s", updated: "2026-11-05T09:56:36.451Z", revision: "shiori-r1.eyJhbWJlciJ9.abcdef0123456789", group: ["dev"], pinned: false },
  { key: "t-editor", title: "编辑器配置", summary: "s", updated: "2026-11-06T10:00:00.000Z", revision: "shiori-r1.x.y", group: ["dev"], pinned: false },
];

// 记录 group_manage 全部调用；按 args.action 可注入成功/失败。
function makeGroupDsh(options = {}) {
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, name: payload && payload.name, args: payload && payload.args });
      if (method === "listCandidates") return emptyCandidates;
      if (method === "executeTool" && payload.name === "group_manage") {
        const action = payload.args.action;
        if (options.failActions && options.failActions.includes(action)) {
          throw Object.assign(new Error("rejected: " + action), { code: "INVALID_INPUT" });
        }
        if (action === "list") return options.list ? options.list() : groupListFixture();
        if (action === "create") return { scope: "amber", action, key: payload.args.key, created: true, revision: "grev-2" };
        if (action === "update") return { scope: "amber", action, key: payload.args.key, updated: true, revision: "grev-3" };
        if (action === "delete") {
          if (options.deleteFails && options.deleteFails(payload.args)) {
            throw Object.assign(new Error("组 \"dev\" 内仍有 2 个 topic，拒绝删除"), {
              code: "INVALID_STATE",
              details: { key: payload.args.key, members: ["t-deploy", "t-editor"] },
            });
          }
          return { scope: "amber", action, key: payload.args.key, deleted: true, migrated: [], revision: "grev-4" };
        }
        return {};
      }
      if (method === "executeTool" && payload.name === "memory_list_topics") {
        return { topics: options.topics ? options.topics() : topicsFixture() };
      }
      return {};
    },
  };
  return { dsh, calls };
}

const groupCalls = (calls) => calls.filter((c) => c.name === "group_manage");

// ---------------------------------------------------------------------------
// a) 清单载入与展示
// ---------------------------------------------------------------------------

test("分组管理：载入发 group_manage {action:'list'}；行渲染 key/标题/摘要/topic 数/order 且按 order 排序", async () => {
  const { dsh, calls } = makeGroupDsh();
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  assert.ok(findCard(tree, "group-manage"), "「分组管理」卡挂在遗忘页");
  assert.ok(collectText(tree).includes("点「载入 / 刷新组」"), "未载入时给引导");
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  const listCalls = groupCalls(calls).filter((c) => c.args.action === "list");
  assert.equal(listCalls.length, 1, "list 恰好一次");
  assert.deepEqual(listCalls[0].args, { action: "list" }, "list 不带多余参数（scope 由服务端可信注入）");
  const text = collectText(tree);
  assert.ok(text.includes("dev") && text.includes("开发与配置"), "组 key 与标题");
  assert.ok(text.includes("DSH / 插件"), "组摘要");
  assert.ok(text.includes("2 个 topic"), "topic 计数（list 投影）");
  assert.ok(text.includes("order 10") && text.includes("order 20"), "排序值可见");
  assert.ok(text.indexOf("dev") < text.indexOf("life"), "按 order 升序排列");
  assert.ok(text.includes("共 2 个组"), "组计数提示");
});

test("分组管理：group_manage 失败走 ErrorBox（人话 + 原始错误折叠），不炸整页", async () => {
  const { dsh } = makeGroupDsh({ failActions: ["list"] });
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  const text = collectText(tree);
  assert.ok(text.includes("group_manage 拒绝了参数"), "人话错误出现");
  assert.ok(text.includes("rejected: list"), "原始错误可见（排查用）");
});

// ---------------------------------------------------------------------------
// b) 建组
// ---------------------------------------------------------------------------

test("建组：key/title 未填时「创建」禁用；填写后 create 参数精确（含 operationId）并刷新清单", async () => {
  const { dsh, calls } = makeGroupDsh();
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  findButton(tree, "建组").props.onClick();
  tree = render(dsh);
  let form = findCard(tree, "group-manage");
  const inputsOf = (t) => flattenVNode(flattenVNode(t).find((n) => n.props && n.props["data-role"] === "group-manage"))
    .filter((n) => n.type === "input");
  let inputs = inputsOf(tree);
  assert.equal(inputs.length, 4, "建组表单四个输入（key/title/summary/order）");
  const createBtn = () => findButtons(tree, "创建")[0] || flattenVNode(tree).filter((n) => n.type === "button" && collectText(n) === "创建")[0];
  assert.ok(createBtn().props.disabled === true, "key/title 空时创建禁用");
  inputs[0].props.onChange({ target: { value: " project " } });
  inputs[1].props.onChange({ target: { value: " 项目与工具 " } });
  inputs[2].props.onChange({ target: { value: " 在跟的项目 " } });
  inputs[3].props.onChange({ target: { value: "30" } });
  tree = render(dsh);
  createBtn().props.onClick();
  await flush();
  const createCalls = groupCalls(calls).filter((c) => c.args.action === "create");
  assert.equal(createCalls.length, 1, "create 恰好一次");
  const sent = createCalls[0].args;
  assert.equal(sent.action, "create");
  assert.equal(sent.key, "project", "key trim");
  assert.equal(sent.title, "项目与工具", "title trim");
  assert.equal(sent.summary, "在跟的项目");
  assert.equal(sent.order, 30, "order 数字化");
  assert.ok(typeof sent.operationId === "string" && sent.operationId.length > 0, "带幂等 operationId");
  tree = render(dsh);
  assert.ok(findButton(tree, "建组"), "表单已收起（建组按钮仍在）");
  assert.ok(!collectText(tree).includes("组 key（如 dev）"), "建组表单关闭");
});

// ---------------------------------------------------------------------------
// c) 编辑（改名 / 改摘要 / 调序）
// ---------------------------------------------------------------------------

test("编辑：表单回填当前值；保存发 update {key,title,summary,order}", async () => {
  const { dsh, calls } = makeGroupDsh();
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  findButton(tree, "编辑").props.onClick();
  tree = render(dsh);
  const inputs = flattenVNode(findCard(tree, "group-manage")).filter((n) => n.type === "input");
  assert.equal(inputs.length, 3, "编辑表单三个输入（title/summary/order）");
  assert.equal(inputs[0].props.value, "开发与配置", "标题回填");
  assert.equal(inputs[1].props.value, "DSH / 插件", "摘要回填");
  assert.equal(inputs[2].props.value, "10", "order 回填");
  inputs[0].props.onChange({ target: { value: "开发与配置（改）" } });
  inputs[2].props.onChange({ target: { value: "15" } });
  tree = render(dsh);
  flattenVNode(tree).find((n) => n.type === "button" && collectText(n) === "保存").props.onClick();
  await flush();
  const updateCalls = groupCalls(calls).filter((c) => c.args.action === "update");
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(updateCalls[0].args, {
    action: "update", key: "dev", title: "开发与配置（改）", summary: "DSH / 插件", order: 15,
    operationId: updateCalls[0].args.operationId,
  }, "update 参数精确（key 不可改，元信息整组发送）");
  assert.ok(typeof updateCalls[0].args.operationId === "string");
});

test("调序：↓ 与下一组交换 order（两次 update）；↑ 在首位禁用", async () => {
  const { dsh, calls } = makeGroupDsh();
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  const ups = findButtons(tree, "↑");
  const downs = findButtons(tree, "↓");
  assert.equal(ups.length, 2, "每组一个 ↑");
  assert.equal(ups[0].props.disabled, true, "首组 ↑ 禁用");
  assert.equal(downs[1].props.disabled, true, "末组 ↓ 禁用");
  downs[0].props.onClick();
  await flush();
  const updateCalls = groupCalls(calls).filter((c) => c.args.action === "update");
  assert.equal(updateCalls.length, 2, "相邻交换发两次 update");
  assert.deepEqual(
    updateCalls.map((c) => [c.args.key, c.args.order]).sort((a, b) => a[0] < b[0] ? -1 : 1),
    [["dev", 20], ["life", 10]],
    "order 互换（dev↔life）",
  );
  for (const c of updateCalls) {
    assert.equal(c.args.action, "update");
    assert.ok(typeof c.args.operationId === "string");
    assert.equal(c.args.title, undefined, "调序只动 order，不带元信息键");
  }
});

// ---------------------------------------------------------------------------
// d) 删除：空组直接删；非空组先迁移确认
// ---------------------------------------------------------------------------

test("删空组：直接发 delete（不带 migrateTo）；成功后清单刷新", async () => {
  const { dsh, calls } = makeGroupDsh();
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  // 两组：dev(2 个 topic) / life(0)。「删除」按钮取第二组所在行。
  const rows = flattenVNode(findCard(tree, "group-manage")).filter((n) => n.props && n.props.className === "dshi_item");
  assert.equal(rows.length, 2, "渲染两个组行");
  const lifeRow = rows.find((r) => collectText(r).includes("life"));
  const del = flattenVNode(lifeRow).find((n) => n.type === "button" && collectText(n) === "删除");
  assert.equal(del.props.disabled, false, "空组删除可点");
  del.props.onClick();
  await flush();
  const deleteCalls = groupCalls(calls).filter((c) => c.args.action === "delete");
  assert.equal(deleteCalls.length, 1);
  assert.deepEqual(deleteCalls[0].args, { action: "delete", key: "life", operationId: deleteCalls[0].args.operationId },
    "空组直接删，不带 migrateTo");
  // 成功后重新拉清单（list 两次：载入 + 删除后刷新）。
  assert.equal(groupCalls(calls).filter((c) => c.args.action === "list").length, 2, "删除后刷新组清单");
});

test("删非空组：先弹迁移确认（列成员 + 目标组下拉来自现有组），确认后 delete 带 migrateTo，组消失", async () => {
  const { dsh, calls } = makeGroupDsh();
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  const rows = () => flattenVNode(findCard(tree, "group-manage")).filter((n) => n.props && n.props.className === "dshi_item");
  const devRow = rows().find((r) => collectText(r).includes("dev"));
  flattenVNode(devRow).find((n) => n.type === "button" && collectText(n) === "删除").props.onClick();
  await flush();
  tree = render(dsh);
  const migration = findCard(tree, "group-migration");
  assert.ok(migration, "非空组删除弹出迁移确认卡");
  const mText = collectText(migration);
  assert.ok(mText.includes("dev"), "确认卡点名被删组");
  assert.ok(mText.includes("t-deploy") && mText.includes("t-editor"), "成员清单可见");
  const select = flattenVNode(migration).find((n) => n.type === "select");
  assert.ok(select, "迁移目标组下拉存在");
  const optionValues = flattenVNode(select).filter((o) => o.type === "option" && o.props.value !== "").map((o) => o.props.value);
  // 目标组只要求「来自现有组清单、不含被删组」，不写死具体组名与顺序（0.4 收尾解绑）。
  assert.ok(optionValues.length > 0, "目标组下拉存在可选项");
  assert.ok(optionValues.every((v) => typeof v === "string" && v.length > 0), "每项都是非空组 key");
  assert.ok(!optionValues.includes("dev"), "目标组不含被删组");
  // 服务端兜底拒绝（INVALID_STATE 带成员）也自动转迁移确认：delete 直接发一次试试。
  // 先只验证确认路径：未选目标（默认选了第一项）→ 确认发 delete {key, migrateTo}。
  flattenVNode(migration).find((n) => n.type === "button" && collectText(n) === "确认迁移并删除").props.onClick();
  await flush();
  const deleteCalls = groupCalls(calls).filter((c) => c.args.action === "delete");
  assert.equal(deleteCalls.length, 1);
  assert.equal(deleteCalls[0].args.key, "dev");
  assert.equal(deleteCalls[0].args.migrateTo, optionValues[0], "迁移目标随选择下发（取下拉首项，不写死组名）");
  await flush();
  tree = render(dsh);
  assert.equal(findCard(tree, "group-migration"), null, "迁移确认卡关闭");
  assert.equal(groupCalls(calls).filter((c) => c.args.action === "list").length >= 2, true, "迁移删除后刷新组清单");
  // 迁移删除后专题列表一并刷新（confirmMigration 里 loadGroups()+loadTopics()）：
  // 归档卡还能正常拉清单、渲染出成员 topic，不是空壳。归档块在另一只手风琴里，
  // 先切过去再拉清单。
  flattenVNode(tree).find((n) => n.props && n.props["data-role"] === "organize-acc-head-archive").props.onClick();
  tree = render(dsh);
  assert.notEqual(findButton(tree, "载入 / 刷新专题"), null, "迁移删除后归档专题卡仍在");
  findButton(tree, "载入 / 刷新专题").props.onClick();
  await flush();
  tree = render(dsh);
  assert.ok(collectText(tree).includes("t-deploy"), "迁移后专题列表仍正常加载渲染");
});

test("迁移确认：目标组为空（无其他组）时确认被本地拦截，提示先选目标组", async () => {
  const { dsh, calls } = makeGroupDsh({
    list: () => ({ scope: "amber", action: "list", revision: "grev-1", groups: [{ key: "solo", title: "唯一组", summary: "", order: 10, topics: 1 }] }),
    topics: () => [{ key: "t1", title: "T1", summary: "", updated: "2026-11-05T09:56:36.451Z", revision: "shiori-r1.a.b", group: ["solo"], pinned: false }],
  });
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  const row = flattenVNode(findCard(tree, "group-manage")).filter((n) => n.props && n.props.className === "dshi_item")[0];
  flattenVNode(row).find((n) => n.type === "button" && collectText(n) === "删除").props.onClick();
  await flush();
  tree = render(dsh);
  const migration = findCard(tree, "group-migration");
  assert.ok(migration, "迁移确认卡出现");
  assert.ok(collectText(migration).includes("t1"), "成员列出");
  flattenVNode(migration).find((n) => n.type === "button" && collectText(n) === "确认迁移并删除").props.onClick();
  await flush();
  tree = render(dsh);
  assert.equal(groupCalls(calls).filter((c) => c.args.action === "delete").length, 0, "无目标组不发 delete");
  assert.ok(collectText(findCard(tree, "group-migration")).includes("先选择一个迁移目标组"), "本地拦截提示");
});

// 主组口径改了以后（0.4 审查 P0#2 连带边界）：「只被当副组挂着」的组在 group_manage
// list 里 topics 计 0（计数只认 row.group[0]），但服务端 delete 仍会因还有成员挂着
// 而兜底拒绝。钉的行为：计数 0 的组点删除先发不带 migrateTo 的 delete；被服务端
// 拒（INVALID_STATE + details.members）后不静默失败，自动转迁移确认并按
// details.members 列成员——成员口径是「挂着就算」，与主组计数口径解耦。
test("删主组计数 0 的组（只被当副组挂着）：先直接删，服务端拒后按 details.members 转迁移确认，不静默失败", async () => {
  // 场景：life 只被 t-mixed 副组挂着，group_manage list 主组计数 0。本用例不发
  // memory_list_topics（成员取自 delete 错误的 details.members，下方有断言钉死），
  // 组清单走 makeGroupDsh 默认夹具 groupListFixture——topics 桩在此不可达，故不传。
  const base = makeGroupDsh();
  const calls = [];
  const dsh = {
    call: async (method, session, payload) => {
      calls.push({ method, name: payload && payload.name, args: payload && payload.args });
      if (method === "executeTool" && payload && payload.name === "group_manage"
        && payload.args.action === "delete" && payload.args.key === "life"
        && !payload.args.migrateTo) {
        // 服务端口径：成员判定看挂载（含副组），不看主组计数——life 虽计 0，t-mixed 仍挂着。
        throw Object.assign(new Error("组 \"life\" 内仍有 1 个 topic，拒绝删除"), {
          code: "INVALID_STATE",
          details: { key: "life", members: ["t-mixed"] },
        });
      }
      return base.dsh.call(method, session, payload);
    },
  };
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  // 默认清单：dev 2 个 topic、life 0 个（t-mixed 主组是 dev，副组挂在 life）。
  const rows = () => flattenVNode(findCard(tree, "group-manage")).filter((n) => n.props && n.props.className === "dshi_item");
  const lifeRow = rows().find((r) => collectText(r).includes("life"));
  flattenVNode(lifeRow).find((n) => n.type === "button" && collectText(n) === "删除").props.onClick();
  await flush();
  tree = render(dsh);
  // 第一步：计数 0 → 直接发 delete，不带 migrateTo（与空组同路径）。
  const deleteCalls = () => calls.filter((c) => c.name === "group_manage" && c.args.action === "delete");
  assert.equal(deleteCalls().length, 1, "计数 0 先直接发 delete");
  assert.equal(deleteCalls()[0].args.key, "life");
  assert.equal(deleteCalls()[0].args.migrateTo, undefined, "第一步 delete 不带 migrateTo");
  // 服务端拒绝后转迁移确认：成员按 details.members 列出（不再发 memory_list_topics 重查）。
  const migration = findCard(tree, "group-migration");
  assert.ok(migration, "被拒后自动转迁移确认（不静默失败）");
  const mText = collectText(migration);
  assert.ok(mText.includes("life"), "确认卡点名被删组");
  assert.ok(mText.includes("t-mixed"), "副组成员按 details.members 列出");
  assert.equal(calls.filter((c) => c.name === "memory_list_topics").length, 0, "成员直接取自错误 details，不再拉专题清单");
  // 确认迁移 → 第二次 delete 带 migrateTo，成功后确认卡关闭。迁移目标的「默认取哪个
  // 组」（当前实现取排序后第一个非被删组 others[0].key，client/index.js:3793-3795）
  // 是实现细节，不锁具体值：只钉「目标非空、来自组清单里已有的 key、不是被删组」
  //——以后默认值/排序策略变了，这条不红。
  flattenVNode(migration).find((n) => n.type === "button" && collectText(n) === "确认迁移并删除").props.onClick();
  await flush();
  assert.equal(deleteCalls().length, 2, "确认后发第二次 delete");
  assert.equal(deleteCalls()[1].args.key, "life");
  const migrateTarget = deleteCalls()[1].args.migrateTo;
  assert.ok(typeof migrateTarget === "string" && migrateTarget !== "", "迁移目标非空");
  const listedKeys = groupListFixture().groups.map((g) => g.key);
  assert.ok(listedKeys.includes(migrateTarget), "迁移目标是组清单里已有的 key（" + String(migrateTarget) + "）");
  assert.notEqual(migrateTarget, "life", "迁移目标不是被删的组");
  await flush();
  tree = render(dsh);
  assert.equal(findCard(tree, "group-migration"), null, "迁移确认卡关闭");
});

// ---------------------------------------------------------------------------
// e) 成员浏览：与平铺列表同一套行组件（renderArchiveTopicRow 复用）
// ---------------------------------------------------------------------------

test("成员浏览：拉 memory_list_topics 按 group 过滤；成员行复用平铺列表的行组件（带「移出索引」）", async () => {
  const { dsh, calls } = makeGroupDsh();
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  const row = flattenVNode(findCard(tree, "group-manage")).filter((n) => n.props && n.props.className === "dshi_item")[0];
  flattenVNode(row).find((n) => n.type === "button" && collectText(n) === "成员").props.onClick();
  await flush();
  tree = render(dsh);
  const listCalls = calls.filter((c) => c.name === "memory_list_topics");
  assert.equal(listCalls.length, 1, "成员走 memory_list_topics（不新开后端接口）");
  const card = findCard(tree, "group-manage");
  const memberRows = flattenVNode(card).filter((n) => n.type === "div" && (n.props.key === "t-deploy" || n.props.key === "t-editor"));
  assert.equal(memberRows.length, 2, "两个成员行渲染");
  for (const memberRow of memberRows) {
    assert.ok(findButton(memberRow, "移出索引"), "成员行带「移出索引」（与平铺列表同一套交互）");
  }
});

test("成员浏览分页：12 个成员按每页 10 条切两页，页码可点、翻回条数不变（评审 rework 阻塞 2）", async () => {
  // 12 个 topic 全在 dev 组：成员列表第 1 页 10 条、第 2 页 2 条。
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    key: "t-m" + String(i + 1),
    title: "成员卡" + String(i + 1),
    summary: "s",
    updated: "2026-11-06T10:00:00.000Z",
    revision: "shiori-r1.x.y",
    group: ["dev"],
    pinned: false,
  }));
  const { dsh, calls } = makeGroupDsh({ topics: () => twelve });
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  const row = flattenVNode(findCard(tree, "group-manage")).filter((n) => n.props && n.props.className === "dshi_item")[0];
  flattenVNode(row).find((n) => n.type === "button" && collectText(n) === "成员").props.onClick();
  await flush();
  tree = render(dsh);
  const memberNodes = () => flattenVNode(findCard(tree, "group-manage"));
  // renderArchiveTopicRow 行头是 dshi_mono span（topic key），以其识别可见成员行。
  const visibleTitles = () => memberNodes().filter((n) => n.type === "span" && n.props.className === "dshi_mono" && /^t-m\d+$/.test(collectText(n))).map((n) => collectText(n));
  let titles = visibleTitles();
  assert.equal(titles.length, 10, "第 1 页恰好 10 条成员");
  assert.ok(titles.includes("t-m1") && titles.includes("t-m10"), "第 1 页是前 10 个成员");
  assert.equal(titles.includes("t-m11"), false, "第 11 条不在第 1 页");
  assert.ok(memberNodes().some((n) => n.props && n.props.className === "dshi_pageBar"), "成员列表带统一页码条");
  assert.ok(collectText(findCard(tree, "group-manage")).includes("第 1 / 2 页（每页 10 条）"), "页脚计数一致");
  // 点「2」翻到第 2 页：恰好 2 条，memory_list_topics 不重发（纯本地分页）。
  memberNodes().find((n) => n.type === "button" && collectText(n) === "2").props.onClick();
  tree = render(dsh);
  titles = visibleTitles();
  assert.equal(titles.length, 2, "第 2 页恰好 2 条");
  assert.ok(titles.includes("t-m11") && titles.includes("t-m12"), "第 2 页是后 2 个成员");
  assert.equal(calls.filter((c) => c.name === "memory_list_topics").length, 1, "翻页纯本地，不重复拉清单");
  // 翻回第 1 页：条数与内容可回退。
  flattenVNode(findCard(tree, "group-manage")).find((n) => n.type === "button" && collectText(n) === "1").props.onClick();
  tree = render(dsh);
  titles = visibleTitles();
  assert.equal(titles.length, 10, "翻回第 1 页仍是 10 条");
  assert.ok(titles.includes("t-m10"), "翻回后内容正确（状态可回退）");
});

// 0.4 B 批（B3）：成员列表迟到响应不得覆盖当前组——同会话换组（session/gen 的
// isStale 兜不住），A 组挂起的响应晚于 B 组返回时，闭包 key 直写会把 B 组顶掉。
// openMembers 已改函数式 setMemberView（prev.key === key 才写入），本用例端到端
// 复现竞态时序。
test("0.4 B3：成员列表迟到响应——A 组挂起、切 B 组先返回、放 A 返回后列表仍是 B 的内容", async () => {
  const base = makeGroupDsh();
  const devTopics = () => [
    { key: "t-a1", title: "A组卡一", summary: "s", updated: "2026-11-06T10:00:00.000Z", revision: "shiori-r1.x.y", group: ["dev"], pinned: false },
    { key: "t-a2", title: "A组卡二", summary: "s", updated: "2026-11-06T10:00:00.000Z", revision: "shiori-r1.x.y", group: ["dev"], pinned: false },
  ];
  const lifeTopics = () => [
    { key: "t-b1", title: "B组卡一", summary: "s", updated: "2026-11-06T10:00:00.000Z", revision: "shiori-r1.x.y", group: ["life"], pinned: false },
  ];
  // memory_list_topics 第 1 次（A 组 dev）挂起在 gate 上；之后（B 组 life）立即返回。
  let listSeq = 0;
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const dsh = {
    call: async (method, session, payload) => {
      if (method === "executeTool" && payload && payload.name === "memory_list_topics") {
        listSeq += 1;
        // C-fix C6：payload 必须在 await 之前取成局部变量——原先
        // `return { topics: listSeq === 1 ? devTopics() : lifeTopics() }` 在
        // await gateA 之后才求值，此刻 listSeq 已被 B 组调用推到 2，迟到的
        // A 响应实际携带的是 B 组数据，:528 的「A 组行不出现」因此空转
        // （永远为真，测不到守卫的真实作用）。
        const payloadTopics = listSeq === 1 ? devTopics() : lifeTopics();
        if (listSeq === 1) await gateA;
        return { topics: payloadTopics };
      }
      return base.dsh.call(method, session, payload);
    },
  };
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  const rowsOf = (t) => flattenVNode(findCard(t, "group-manage")).filter((n) => n.props && n.props.className === "dshi_item");
  const membersButtonOf = (row) => flattenVNode(row).find((n) => n.type === "button" && collectText(n) === "成员");
  // 展开 A 组（dev，第 1 行）：请求挂起。
  membersButtonOf(rowsOf(tree)[0]).props.onClick();
  await flush();
  tree = render(dsh);
  // 同会话切到 B 组（life，第 2 行）：B 先返回并渲染。
  membersButtonOf(rowsOf(tree)[1]).props.onClick();
  await flush();
  tree = render(dsh);
  assert.ok(collectText(tree).includes("B组卡一"), "B 组成员已渲染（B 先返回）");
  assert.equal(listSeq, 2, "恰好两次 memory_list_topics（A 一次 + B 一次）");
  // 放 A 返回：迟到响应不得覆盖当前组（B 的行保留、A 的行不出现、列表未被顶开）。
  releaseA();
  await flush();
  tree = render(dsh);
  const text = collectText(tree);
  assert.ok(text.includes("B组卡一"), "成员列表仍是 B 的内容");
  assert.ok(!text.includes("A组卡一") && !text.includes("A组卡二"), "A 组的行不出现（迟到响应被 prev.key 守卫拦下）");
});

// ---------------------------------------------------------------------------
// f) 主组口径（0.4 审查 P0#2 连带，用户 2026-11-14 拍板）：多组 topic 只归属
// 主组 row.group[0]。挂了 ["life","dev"] 的 topic 出现在 life 的成员列表里，
// 不出现在 dev 的成员列表里——成员列表条数与 group_manage list 的主组计数对得上。
// ---------------------------------------------------------------------------

test("成员浏览主组口径：多组 topic 只出现在主组成员列表，非主组不漏出（row.group[0] === key）", async () => {
  const mixedTopics = () => [
    { key: "t-only-dev", title: "只在开发组", summary: "s", updated: "2026-11-06T10:00:00.000Z", revision: "shiori-r1.x.y", group: ["dev"], pinned: false },
    { key: "t-mixed", title: "双组卡主组是生活", summary: "s", updated: "2026-11-06T10:00:00.000Z", revision: "shiori-r1.x.y", group: ["life", "dev"], pinned: false },
  ];
  const { dsh } = makeGroupDsh({ topics: mixedTopics });
  const { render } = await mountCandidates(emptyCandidates);
  let tree = render(dsh);
  findButton(tree, "载入 / 刷新组").props.onClick();
  await flush();
  tree = render(dsh);
  const memberRows = () => flattenVNode(findCard(tree, "group-manage")).filter((n) => n.props && n.props.className === "dshi_item");
  // 展开第一个组行（dev，order 10 在前）的成员。
  flattenVNode(memberRows()[0]).find((n) => n.type === "button" && collectText(n) === "成员").props.onClick();
  await flush();
  tree = render(dsh);
  let text = collectText(findCard(tree, "group-manage"));
  assert.ok(text.includes("t-only-dev"), "dev 主组成员可见");
  assert.ok(!text.includes("t-mixed"), "双组 topic 主组是 life，不出现在 dev 成员列表（indexOf 口径会漏出）");
  // 收起 dev，展开 life 的成员。
  flattenVNode(memberRows()[0]).find((n) => n.type === "button" && collectText(n) === "收起成员").props.onClick();
  await flush();
  tree = render(dsh);
  flattenVNode(memberRows()[1]).find((n) => n.type === "button" && collectText(n) === "成员").props.onClick();
  await flush();
  tree = render(dsh);
  text = collectText(findCard(tree, "group-manage"));
  assert.ok(text.includes("t-mixed"), "life 是主组，双组 topic 出现在 life 成员列表");
  assert.ok(!text.includes("t-only-dev"), "dev 的成员不漏进 life");
});
