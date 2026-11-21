// Shiori 0.5 批次 4 · C 线：整理向导纯函数测试（node:test，零新增依赖）。
//
// 覆盖（子任务验收判据）：
// - needsOnboarding 五态各一条（needed / marked / grouped / has-historical /
//   too-few-topics）+ 优先级与挂载口径（默认模板组 general 在场仍触发）；
// - proposeGroups 确定性（两次调用 deepEqual + 打乱输入同输出）、候选数 3–6、
//   成员不重不漏（含兜底组）、输入不被修改、前置不满足返回 []；
// - validateProposal / assertProposalCoversTopics 的形状与完整性反例；
// - proposalHash 稳定性（组/成员/键排列无关）与内容敏感性。
//
// 变红自证锚点（提交 note 引用）：删掉 needsOnboarding 的 historical 判断 →
// 「五态：has-historical」用例红；删掉 proposeGroups 的已归组前置 →
// 「proposeGroups：已归组返回 []」用例红。
//
// 常量交叉锁定：ONBOARDING_RETENTION_VALUES / DEFAULT_RETENTION 与
// src/core/topics.mjs 的 RETENTION_VALUES / DEFAULT_RETENTION 逐字相等（镜像
// 一致性，同 queue.test.mjs 对 digest 的交叉验证口径）。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  needsOnboarding, proposeGroups, proposalHash, validateProposal,
  assertProposalCoversTopics,
  ONBOARDING_MIN_TOPICS, ONBOARDING_MIN_GROUPS, ONBOARDING_MAX_GROUPS,
  ONBOARDING_RETENTION_VALUES, ONBOARDING_DEFAULT_RETENTION,
  ONBOARDING_REASONS, ONBOARDING_PROPOSAL_VERSION,
} from '../../src/organize/onboarding.mjs';
import { RETENTION_VALUES, DEFAULT_RETENTION } from '../../src/core/topics.mjs';

const SCOPE = 'amber';

// --- 夹具 -------------------------------------------------------------------

/** 构造 listTopics 行的向导子集（key/title/summary 必填，retention/group 可选）。 */
function topic(key, over = {}) {
  return {
    key,
    title: over.title ?? `主题 ${key}`,
    summary: over.summary ?? `${key} 的摘要`,
    scopeId: SCOPE,
    revision: 'rev-token',
    updated: '2026-01-01T00:00:00.000Z',
    retention: over.retention,
    group: over.group,
  };
}

function fiveTopics() {
  return [topic('a'), topic('b'), topic('c'), topic('d'), topic('e')];
}

/** 深冻结夹具（proposeGroups 不改入参的证明）。 */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// 有信号的语料：两个主题族 + 无关键词散卡（验证兜底组）。
function corpus() {
  return [
    topic('shiori-panel', { title: 'Shiori 面板开发', summary: '面板 RPC 与卡片渲染' }),
    topic('shiori-queue', { title: 'Shiori 整理队列', summary: '候选队列与审阅草案' }),
    topic('shiori-wizard', { title: 'Shiori 整理向导', summary: '首启引导与候选组' }),
    topic('shiori-state', { title: 'Shiori 状态账本', summary: 'stateRoot 持久化' }),
    topic('shiori-wire', { title: 'Shiori wire 契约', summary: '管理 API 契约冻结' }),
    topic('comfy-download', { title: 'Comfy 模型下载', summary: '模型缓存目录与下载任务' }),
    topic('comfy-workflow', { title: 'Comfy 工作流', summary: '模板与工作流执行' }),
    topic('comfy-vram', { title: 'Comfy 显存', summary: '显存占用与释放' }),
    topic('comfy-nodes', { title: 'Comfy 节点', summary: '自定义节点安装' }),
    topic('misc-a', { title: '杂项甲', summary: '无关词一' }),
    topic('misc-b', { title: '杂项乙', summary: '无关词二' }),
  ];
}

// --- 常量交叉锁定 ------------------------------------------------------------

test('常量：retention 枚举与 DEFAULT_RETENTION 与 core/topics.mjs 镜像逐字一致', () => {
  assert.deepEqual(ONBOARDING_RETENTION_VALUES, RETENTION_VALUES);
  assert.equal(ONBOARDING_DEFAULT_RETENTION, DEFAULT_RETENTION);
  assert.deepEqual(ONBOARDING_REASONS, ['marked', 'grouped', 'has-historical', 'too-few-topics', 'needed']);
  assert.equal(ONBOARDING_MIN_TOPICS, 5);
  assert.equal(ONBOARDING_MAX_GROUPS, 6);
  assert.equal(ONBOARDING_PROPOSAL_VERSION, 1);
});

// --- needsOnboarding：五态（每态一条）----------------------------------------

test('五态：needed（组清单空 / 默认模板组在场但无挂载 / historical 0 / topic≥5 / 无标记位）', () => {
  assert.deepEqual(
    needsOnboarding({ topics: fiveTopics(), groups: [], onboarding: null }),
    { needed: true, reason: 'needed', markedKind: null },
  );
  // 挂载口径：宿主激活路径总写默认模板组 general——字面「组清单为空」恒为假，
  // 「已归组」按 ∃topic.group 非空判定，默认模板在场仍触发。
  assert.deepEqual(
    needsOnboarding({ topics: fiveTopics(), groups: [{ key: 'general', title: '通用' }], onboarding: null }),
    { needed: true, reason: 'needed', markedKind: null },
  );
  assert.equal(needsOnboarding({ topics: fiveTopics(), groups: [] }).needed, true); // onboarding 缺省=无标记位
});

test('五态：marked（dismissedAt / completedAt，completed 优先；needed=false 不再触发）', () => {
  const dismissed = needsOnboarding({ topics: fiveTopics(), groups: [], onboarding: { dismissedAt: '2026-01-01T00:00:00.000Z' } });
  assert.equal(dismissed.needed, false);
  assert.equal(dismissed.reason, 'marked');
  assert.equal(dismissed.markedKind, 'dismissed');
  const completed = needsOnboarding({ topics: fiveTopics(), groups: [], onboarding: { completedAt: '2026-01-02T00:00:00.000Z' } });
  assert.equal(completed.needed, false);
  assert.equal(completed.reason, 'marked');
  assert.equal(completed.markedKind, 'completed');
  // 优先级：completed 与 dismissed 同时在场 → completed 胜。
  const both = needsOnboarding({
    topics: fiveTopics(), groups: [],
    onboarding: { dismissedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-02T00:00:00.000Z' },
  });
  assert.equal(both.markedKind, 'completed');
  // completed 优先于 grouped（组清单非空但已完成 → marked）。
  const completedAndGrouped = needsOnboarding({
    topics: fiveTopics(), groups: [{ key: 'dev' }], onboarding: { completedAt: 'x' },
  });
  assert.equal(completedAndGrouped.reason, 'marked');
});

test('五态：grouped（任一 topic 挂组即不触发，挂载口径）', () => {
  const verdict = needsOnboarding({
    topics: [topic('a', { group: ['dev'] }), topic('b'), topic('c'), topic('d'), topic('e')],
    groups: [{ key: 'dev' }],
    onboarding: null,
  });
  assert.equal(verdict.needed, false);
  assert.equal(verdict.reason, 'grouped');
  assert.equal(verdict.markedKind, null);
});

test('五态：has-historical（显式 retention=historical 计数>0 即不触发；组级策略不参与）', () => {
  const verdict = needsOnboarding({
    topics: [topic('a'), topic('b', { retention: 'historical' }), topic('c'), topic('d'), topic('e')],
    groups: [],
    onboarding: null,
  });
  assert.equal(verdict.needed, false);
  assert.equal(verdict.reason, 'has-historical');
  // 组条目带 retention 策略但无 topic 显式 historical → 仍触发（§11.2.7 按 topic 字段计数）。
  const groupPolicyOnly = needsOnboarding({
    topics: fiveTopics(),
    groups: [{ key: 'archive', retention: 'historical' }],
    onboarding: null,
  });
  assert.equal(groupPolicyOnly.reason, 'needed');
});

test('五态：too-few-topics（<5 条不触发，含 0 条）', () => {
  for (const count of [0, 1, 4]) {
    const verdict = needsOnboarding({ topics: fiveTopics().slice(0, count), groups: [], onboarding: null });
    assert.equal(verdict.needed, false);
    assert.equal(verdict.reason, 'too-few-topics');
  }
});

test('needsOnboarding 反例：未知键 / 坏形状 / 非法 retention / 重复 key / 坏标记位 显式拒绝', () => {
  assert.throws(() => needsOnboarding({ topics: fiveTopics(), groups: [], rogue: 1 }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => needsOnboarding({ topics: 'nope', groups: [] }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => needsOnboarding({ topics: fiveTopics(), groups: 'nope' }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(
    () => needsOnboarding({ topics: [topic('a', { retention: 'cold' }), topic('b'), topic('c'), topic('d'), topic('e')], groups: [] }),
    (e) => e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => needsOnboarding({ topics: [topic('a'), topic('a')], groups: [] }),
    (e) => e.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => needsOnboarding({ topics: fiveTopics(), groups: [], onboarding: { dismissedAt: '' } }),
    (e) => e.code === 'INVALID_INPUT',
  );
});

// --- proposeGroups -----------------------------------------------------------

test('proposeGroups：两次调用 deepEqual 且打乱输入同输出（确定性，含数组排列差异）', () => {
  const rows = corpus();
  const once = proposeGroups(rows);
  const twice = proposeGroups(rows);
  assert.deepEqual(twice, once, '同输入两次调用逐字一致');
  const shuffled = rows.map((row, i) => rows[rows.length - 1 - i]);
  assert.deepEqual(proposeGroups(shuffled), once, '输入数组倒序排列同输出');
  // 深冻结夹具再跑一遍：不改入参的前提下结果仍逐字一致。
  assert.deepEqual(proposeGroups(deepFreeze(structuredClone(rows))), once, '深冻结输入同输出');
});

test('proposeGroups：候选数 3–6、成员不重不漏（兜底组计入）、排序确定性', () => {
  const rows = corpus();
  const groups = proposeGroups(rows);
  assert.ok(groups.length >= 3 && groups.length <= ONBOARDING_MAX_GROUPS, `组数 3..6（实际 ${groups.length}）`);
  const covered = groups.flatMap((g) => g.members);
  assert.equal(new Set(covered).size, covered.length, '成员不重');
  assert.deepEqual(
    [...new Set(covered)].sort(),
    [...rows.map((r) => r.key)].sort(),
    '成员不漏（并集=全部 topic）',
  );
  // 形状：{key,title,members,defaultRetention}；members 码点升序；defaultRetention=standing。
  for (const g of groups) {
    assert.deepEqual(Object.keys(g).sort(), ['defaultRetention', 'key', 'members', 'title']);
    assert.equal(typeof g.key, 'string' && g.key.length > 0 ? 'string' : 'undefined', 'key 非空串');
    assert.ok(g.title.length > 0);
    assert.ok(g.members.length > 0);
    assert.deepEqual(g.members, [...g.members].sort());
    assert.equal(g.defaultRetention, 'standing');
  }
  // 组序：成员数降序、key 码点升序（确定性口径自证）。
  for (let i = 1; i < groups.length; i += 1) {
    const prev = groups[i - 1];
    const cur = groups[i];
    assert.ok(
      prev.members.length > cur.members.length
        || (prev.members.length === cur.members.length && prev.key < cur.key),
      `组序确定性：#${i - 1}(${prev.members.length}/${prev.key}) 在 #${i}(${cur.members.length}/${cur.key}) 前`,
    );
  }
});

test('proposeGroups：共享词族聚成一组（shiori 系 5 条同组；标题关键词权重高于摘要）', () => {
  const groups = proposeGroups(corpus());
  const shiori = groups.find((g) => g.members.includes('shiori-panel'));
  const comfy = groups.find((g) => g.members.includes('comfy-download'));
  assert.ok(shiori, 'shiori 族成组');
  assert.ok(comfy, 'comfy 族成组');
  assert.deepEqual(shiori.members, ['shiori-panel', 'shiori-queue', 'shiori-state', 'shiori-wire', 'shiori-wizard']);
  assert.deepEqual(comfy.members, ['comfy-download', 'comfy-nodes', 'comfy-vram', 'comfy-workflow']);
  assert.notEqual(shiori.key, comfy.key, '两族不同组');
});

test('proposeGroups：前置不满足返回 []（<5 条 / 任一 topic 已挂组）', () => {
  assert.deepEqual(proposeGroups(fiveTopics().slice(0, 4)), [], '4 条返回空');
  assert.deepEqual(proposeGroups([]), [], '空列表返回空');
  const mounted = corpus().map((row, i) => (i === 0 ? { ...row, group: ['dev'] } : row));
  assert.deepEqual(proposeGroups(mounted), [], '任一 topic 已挂组返回空');
});

test('proposeGroups：无信号语料退化为单成员组 + 兜底（仍 3–6 组、不重不漏、key 不撞保留名）', () => {
  const rows = [];
  for (let i = 0; i < 7; i += 1) rows.push(topic(`isolated-${i}`, { title: `孤立主题${i}`, summary: `第${i}条，彼此无共享词` }));
  const groups = proposeGroups(rows);
  assert.ok(groups.length >= 3 && groups.length <= ONBOARDING_MAX_GROUPS, `组数 3..6（实际 ${groups.length}）`);
  const covered = groups.flatMap((g) => g.members);
  assert.equal(new Set(covered).size, covered.length);
  assert.deepEqual([...new Set(covered)].sort(), [...rows.map((r) => r.key)].sort());
  const keys = new Set(groups.map((g) => g.key));
  assert.equal(keys.size, groups.length, '组 key 不重复');
  for (const g of groups) {
    assert.ok(!['con', 'core'].includes(g.key.toLowerCase()), `key "${g.key}" 不撞保留名`);
  }
});

test('proposeGroups：超 6 簇收敛到 ≤6（小簇并入兜底），key 冲突自动改写去重', () => {
  // 8 个互不共享的两字族（每族标题含独占 CJK 词）→ 8 簇 → 收敛 ≤6。
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      rows.push(topic(`fam${i}-${j}`, { title: `族${i}主题${j}甲乙丙丁`, summary: `族${i}的条目` }));
    }
  }
  const groups = proposeGroups(rows);
  assert.ok(groups.length <= ONBOARDING_MAX_GROUPS, `组数 ≤6（实际 ${groups.length}）`);
  assert.ok(groups.length >= ONBOARDING_MIN_GROUPS);
  const covered = groups.flatMap((g) => g.members);
  assert.equal(new Set(covered).size, covered.length);
  assert.deepEqual([...new Set(covered)].sort(), [...rows.map((r) => r.key)].sort());
  const keys = new Set(groups.map((g) => g.key));
  assert.equal(keys.size, groups.length, '收敛后 key 仍不重复（改写去重生效）');
});

test('proposeGroups：输入不被修改（深冻结夹具）', () => {
  const rows = deepFreeze(structuredClone(corpus()));
  assert.doesNotThrow(() => proposeGroups(rows));
  const snapshot = JSON.stringify(rows);
  proposeGroups(rows);
  assert.equal(JSON.stringify(rows), snapshot, '深冻结下 JSON 逐字不变（未被改写）');
});

// --- validateProposal / assertProposalCoversTopics ---------------------------

const validProposal = {
  groups: [
    { key: 'shiori', title: 'Shiori', members: ['shiori-panel', 'shiori-queue'], defaultRetention: 'standing' },
    { key: 'comfy', title: 'Comfy', members: ['comfy-download'], defaultRetention: 'historical', overrides: { 'comfy-download': 'standing' } },
  ],
  ungrouped: ['misc-a'],
};

test('validateProposal：合法提案规范化（组按 key 序、成员去重升序、overrides 键序稳定、空 overrides 丢弃）', () => {
  const shuffled = {
    groups: [
      { key: 'comfy', title: 'Comfy', members: ['comfy-download'], defaultRetention: 'historical', overrides: { 'comfy-download': 'standing' } },
      { key: 'shiori', title: 'Shiori', members: ['shiori-queue', 'shiori-panel'], defaultRetention: 'standing' },
    ],
    ungrouped: ['misc-a', 'misc-a'],
  };
  const canonical = validateProposal(shuffled);
  assert.deepEqual(canonical, validateProposal(validProposal), '排列无关同规范形');
  assert.deepEqual(canonical.groups.map((g) => g.key), ['comfy', 'shiori'], '组按 key 序');
  assert.deepEqual(canonical.groups[1].members, ['shiori-panel', 'shiori-queue'], '成员升序');
  assert.deepEqual(canonical.groups[0].overrides, { 'comfy-download': 'standing' }, '非空 overrides 保留且键序稳定');
  const dropped = validateProposal({
    groups: [{ key: 'comfy', title: 'Comfy', members: ['comfy-download'], defaultRetention: 'historical', overrides: {} }],
    ungrouped: [],
  });
  assert.equal(Object.hasOwn(dropped.groups[0], 'overrides'), false, '空 overrides 规范化后不出键');
  // 幂等：规范化结果再入一遍逐字一致。
  assert.deepEqual(validateProposal(canonical), canonical);
});

test('validateProposal 反例：组数/未知键/缺字段/坏枚举/空组/成员重复/key 重复/overrides 键越界', () => {
  const g = (over = {}) => ({ key: 'a', title: 'A', members: ['t1'], defaultRetention: 'standing', ...over });
  assert.throws(() => validateProposal(null), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => validateProposal({ groups: [] }), (e) => e.code === 'INVALID_INPUT', '0 组拒');
  assert.throws(() => validateProposal({ groups: Array.from({ length: ONBOARDING_MAX_GROUPS + 1 }, () => g()) }), (e) => e.code === 'INVALID_INPUT', '7 组拒');
  assert.throws(() => validateProposal({ groups: [g()], rogue: 1 }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => validateProposal({ groups: [g({ members: [] })] }), (e) => e.code === 'INVALID_INPUT', '空组拒');
  assert.throws(() => validateProposal({ groups: [g({ defaultRetention: 'cold' })] }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => validateProposal({ groups: [g(), g()] }), (e) => e.code === 'INVALID_INPUT', '组 key 重复拒');
  assert.throws(() => validateProposal({ groups: [g({ members: ['t1', 't1'] })] }), (e) => e.code === 'INVALID_INPUT', '组内成员重复拒');
  assert.throws(
    () => validateProposal({ groups: [g(), g({ key: 'b', title: 'B', members: ['t1'] })], ungrouped: [] }),
    (e) => e.code === 'INVALID_INPUT',
    '跨组成员重复拒',
  );
  assert.throws(
    () => validateProposal({ groups: [g({ overrides: { 'not-a-member': 'historical' } })] }),
    (e) => e.code === 'INVALID_INPUT',
    'overrides 键不是组成员拒',
  );
  assert.throws(
    () => validateProposal({ groups: [g({ overrides: { t1: 'cold' } })] }),
    (e) => e.code === 'INVALID_INPUT',
    'overrides 值非法拒',
  );
});

test('assertProposalCoversTopics：不漏不未知；缺 topics 参数时跳过完整性', () => {
  const rows = [topic('shiori-panel'), topic('shiori-queue'), topic('comfy-download'), topic('misc-a')];
  const proposal = validateProposal({
    groups: validProposal.groups,
    ungrouped: ['misc-a'],
  });
  assert.doesNotThrow(() => assertProposalCoversTopics(proposal, rows));
  assert.doesNotThrow(() => assertProposalCoversTopics(proposal), '缺 topics 跳过完整性');
  assert.throws(
    () => assertProposalCoversTopics(proposal, rows.slice(0, 3)),
    (e) => e.code === 'INVALID_INPUT',
    '漏 topic 拒',
  );
  assert.throws(
    () => assertProposalCoversTopics(proposal, [...rows, topic('extra')]),
    (e) => e.code === 'INVALID_INPUT',
    '未知 topic 拒',
  );
});

// --- proposalHash -------------------------------------------------------------

test('proposalHash：64hex；组/成员/overrides 键排列无关；内容敏感（标题/成员/档位/override 变化即变）', () => {
  const hash = proposalHash(validProposal);
  assert.match(hash, /^[0-9a-f]{64}$/);
  const reversed = {
    groups: [
      { key: 'comfy', title: 'Comfy', members: ['comfy-download'], defaultRetention: 'historical', overrides: { 'comfy-download': 'standing' } },
      { key: 'shiori', title: 'Shiori', members: ['shiori-queue', 'shiori-panel'], defaultRetention: 'standing' },
    ],
    ungrouped: ['misc-a'],
  };
  assert.equal(proposalHash(reversed), hash, '排列无关同哈希');
  assert.equal(proposalHash(validateProposal(validProposal)), hash, '规范化后同哈希（幂等绑定）');
  assert.notEqual(proposalHash({
    groups: validProposal.groups.map((g) => (g.key === 'shiori' ? { ...g, title: 'Shiori2' } : g)),
    ungrouped: validProposal.ungrouped,
  }), hash, '标题变化 → 哈希变');
  assert.notEqual(proposalHash({
    groups: validProposal.groups.map((g) => (g.key === 'shiori' ? { ...g, members: [...g.members, 'shiori-wire'] } : g)),
    ungrouped: validProposal.ungrouped,
  }), hash, '成员变化 → 哈希变');
  assert.notEqual(proposalHash({
    groups: validProposal.groups.map((g) => (g.key === 'shiori' ? { ...g, defaultRetention: 'historical' } : g)),
    ungrouped: validProposal.ungrouped,
  }), hash, '组默认档位变化 → 哈希变');
  assert.notEqual(proposalHash({
    groups: validProposal.groups.map((g) => (g.key === 'shiori' ? { ...g, overrides: { 'shiori-panel': 'historical' } } : g)),
    ungrouped: validProposal.ungrouped,
  }), hash, '逐条 override 变化 → 哈希变');
  assert.notEqual(proposalHash({ ...validProposal, ungrouped: [] }), hash, 'ungrouped 变化 → 哈希变');
});

test('proposeGroups：takenKeys 预置既有组 key——提案 key 恒不撞既有组（R5①，面板改不了 key）', () => {
  const rows = corpus();
  // 既有清单里已经占用了 "comfy" 这个 key（例如手建的组）：提案必须绕开它。
  const groups = proposeGroups(rows, { takenKeys: ['comfy', 'general'] });
  assert.ok(groups.length >= 3 && groups.length <= ONBOARDING_MAX_GROUPS);
  const keys = groups.map((g) => g.key);
  assert.equal(keys.includes('comfy'), false, '提案 key 不与既有组撞名（改写去重生效）');
  assert.equal(keys.includes('general'), false);
  assert.equal(new Set(keys).size, keys.length, '提案内部 key 仍唯一');
  // 成员完整性与确定性不受 takenKeys 影响。
  const covered = groups.flatMap((g) => g.members);
  assert.deepEqual([...new Set(covered)].sort(), [...rows.map((r) => r.key)].sort());
  assert.deepEqual(proposeGroups(rows, { takenKeys: ['comfy', 'general'] }), groups);
  // options 反例：未知键 / 坏形状显式拒绝。
  assert.throws(() => proposeGroups(rows, { rogue: 1 }), (e) => e.code === 'INVALID_INPUT');
  assert.throws(() => proposeGroups(rows, { takenKeys: ['ok', ''] }), (e) => e.code === 'INVALID_INPUT');
});

test('proposeGroups：超长 ASCII 词（>32 字符）直接丢弃，不出组 key、不参与聚类（R5②）', () => {
  const longWord = 'x'.repeat(200);
  const rows = [
    topic('long-a', { title: `共享前缀 ${longWord}`, summary: '都有同一个超长词' }),
    topic('long-b', { title: `共享前缀 ${longWord}乙`, summary: '都有同一个超长词' }),
    topic('long-c', { title: `共享前缀丙 ${longWord}`, summary: '都有同一个超长词' }),
    topic('plain-d', { title: '普通主题丁', summary: '无关键词' }),
    topic('plain-e', { title: '普通主题戊', summary: '无关键词' }),
  ];
  const groups = proposeGroups(rows);
  assert.ok(groups.length >= 3 && groups.length <= ONBOARDING_MAX_GROUPS);
  for (const g of groups) {
    assert.ok(g.key.length <= 128, `组 key "${g.key}" 不超 MAX_KEY_CHARS=128`);
    assert.ok(!g.key.includes(longWord), '超长词不成为组 key');
    assert.ok(g.key.length <= 40, `组 key ${g.key} 不是超长词派生`);
  }
  const covered = groups.flatMap((g) => g.members);
  assert.deepEqual([...new Set(covered)].sort(), [...rows.map((r) => r.key)].sort(), '成员不重不漏不受影响');
});
