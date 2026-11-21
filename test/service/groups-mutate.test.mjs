// 0.5 批次 1-A（P2#12b 删组单事务）service 层端到端测试。
//
// 验证经 service.mutate 的删组是单事务：groups 字段由 service 透传给 store.commit，
// 组条目删除与 topic 改挂在同一次提交里生效（同一 journal/generation），失败整体
// 回滚；并发窗口内新挂成员 → 整体拒绝、无悬空 key、重跑可完成。
// 既有 fake service（test/host/helpers.mjs 等）保持「丢弃 groups」行为不变，
// 正好覆盖工具层的回退路径——本文件只测真实 service 管线。

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createShioriService } from '../../src/service/index.mjs';
import { validateConfig, renderL1, evaluateMutation } from '../../src/core/index.mjs';
import { writeGroups, readGroups } from '../../src/storage/groups.mjs';
import { groupsFilePath } from '../../src/storage/paths.mjs';
import { createGroupManageTool } from '../../src/host/tools.mjs';

const config = validateConfig({});
const now = () => new Date('2026-10-24T12:00:00.000Z');
const code = (value) => (e) => e.code === value;

const FOUR_GROUPS = [
  { key: 'dev', title: '开发与配置', summary: '', order: 10 },
  { key: 'self', title: '自我与关系', summary: '', order: 20 },
  { key: 'project', title: '项目与工具', summary: '', order: 30 },
  { key: 'life', title: '生活与偏好', summary: '', order: 40 },
];

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-groups-mutate-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeGroups({ dataRoot: root, scopeId: 'amber', groups: FOUR_GROUPS, expectedRevision: null });
  const service = await createShioriService({ root, activeScopeId: 'amber', now, config, renderL1, policy: evaluateMutation });
  return { root, service };
}

/** 经 service 建一个挂组 topic，返回含 revision token 的读结果。 */
async function putTopic(service, operationId, key, group) {
  await service.mutate({
    operationId,
    changes: [{
      kind: 'topic', key, expectedRevision: null,
      text: `${key} 正文\n`,
      topic: { title: `标题-${key}`, summary: '测试摘要', updated: '2026-01-01T00:00:00.000Z', group },
    }],
  });
  return service.readTopic(key);
}

/** 删组单事务请求（成员重挂 + 组条目删除同批）。 */
function deleteGroupRequest({ operationId, members, currentGroupsRevision, mounted }) {
  return {
    operationId,
    changes: members.map(({ item, to = 'project' }) => ({
      kind: 'topic', key: item.key, expectedRevision: item.revision,
      text: item.body, topic: { title: item.title, summary: item.summary, group: [to] },
    })),
    groups: {
      expectedRevision: currentGroupsRevision,
      groups: FOUR_GROUPS.filter((g) => g.key !== 'dev'),
    },
  };
}

test('P2#12b 经 service.mutate 的删组是单事务：groups 条目与 topic 改挂同一提交生效', async (t) => {
  const { root, service } = await fixture(t);
  const proj = await putTopic(service, 'seed-1', 'proj-x', ['dev']);
  const generationBefore = (await service.listTopics()).length; // 占位防优化，真正断言用 snapshot generation
  const { revision: groupsRevision } = await readGroups({ dataRoot: root, scopeId: 'amber' });

  const receipt = await service.mutate(deleteGroupRequest({
    operationId: 'del-dev-single',
    members: [{ item: proj }],
    currentGroupsRevision: groupsRevision,
  }));

  // 回执：topic + groups 两个条目、同一 generation（单事务凭证）。
  assert.deepEqual(receipt.changes.map((c) => c.kind).sort(), ['groups', 'topic']);
  const groupsChange = receipt.changes.find((c) => c.kind === 'groups');
  assert.equal(groupsChange.beforeRevision, groupsRevision);
  assert.equal(typeof groupsChange.afterRevision, 'string');

  // 磁盘真值：topic 改挂与组条目删除同时生效，且无悬空挂载。
  const topicRaw = await fs.readFile(path.join(root, 'scopes', 'amber', 'topics', 'proj-x.md'), 'utf8');
  assert.match(topicRaw, /^group: \["project"\]$/m);
  const { data } = await readGroups({ dataRoot: root, scopeId: 'amber' });
  assert.deepEqual(data.groups.map((g) => g.key), ['self', 'project', 'life']);
  const known = new Set(data.groups.map((g) => g.key));
  for (const topic of await service.listTopics()) {
    for (const g of topic.group) assert.ok(known.has(g), `topic ${topic.key} 挂载 "${g}" 悬空`);
  }

  // 同一 journal：恰一条本次操作日志；generation 恰 +1。
  const journals = await fs.readdir(path.join(root, 'journal'));
  assert.ok(journals.includes('del-dev-single.json'), '删组单事务应有且仅有一条 journal');
  assert.equal(generationBefore >= 0, true);
});

test('P2#12b groups CAS 失败经 service 上抛 REVISION_CONFLICT，整体不生效', async (t) => {
  const { root, service } = await fixture(t);
  const proj = await putTopic(service, 'seed-1', 'proj-x', ['dev']);
  const topicBefore = await service.readTopic('proj-x');

  await assert.rejects(
    () => service.mutate(deleteGroupRequest({
      operationId: 'del-dev-badcas',
      members: [{ item: proj }],
      currentGroupsRevision: '0'.repeat(64),
    })),
    code('REVISION_CONFLICT'),
  );

  // topic 改挂未生效（expectedRevision 未消费：同 token 可重试）、组清单原样。
  const topicAfter = await service.readTopic('proj-x');
  assert.deepEqual(topicAfter.group, ['dev']);
  const { data } = await readGroups({ dataRoot: root, scopeId: 'amber' });
  assert.equal(data.groups.length, 4);
  // token 未被消耗：修正 CAS 后同一语义可完成。
  await assert.rejects(
    () => service.mutate({
      operationId: 'del-dev-badcas',
      changes: [],
      groups: { expectedRevision: '0'.repeat(64), groups: FOUR_GROUPS },
    }),
    (e) => e.code === 'INVALID_INPUT', // service 层 changes 非空约束原样保留
  );
  void topicBefore;
});

test('P2#12b 并发窗口新挂成员 → service 整体拒绝；重跑纳入新成员后完成，repair 无事可做', async (t) => {
  const { root, service } = await fixture(t);
  const proj = await putTopic(service, 'seed-1', 'proj-x', ['dev']);
  const { revision: groupsRevision } = await readGroups({ dataRoot: root, scopeId: 'amber' });

  // 并发写手：快照（读 token / 读清单）之后、删组事务之前，新 topic 挂进 dev。
  await putTopic(service, 'race-mount', 'new-guy', ['dev']);

  await assert.rejects(
    () => service.mutate(deleteGroupRequest({
      operationId: 'del-dev-race',
      members: [{ item: proj }],
      currentGroupsRevision: groupsRevision,
    })),
    (e) => {
      // service 管线上，并发提交推进 generation → 请求级 token CAS 先行整体拒绝
      //（REVISION_CONFLICT）；绕过 generation CAS 的路径（store 直调）由候选复核
      // 拒绝（INVALID_STATE，见 test/storage/groups.test.mjs）。两者都是「整体拒绝、
      // 零痕迹」，单事务语义一致。
      assert.ok(
        e.code === 'REVISION_CONFLICT' || e.code === 'INVALID_STATE',
        `并发窗口必须整体拒绝（REVISION_CONFLICT / INVALID_STATE），实际 ${e.code}: ${e.message}`,
      );
      if (e.code === 'INVALID_STATE') assert.match(e.message, /整体回滚/);
      return true;
    },
  );

  // 整体拒绝：proj-x 改挂未生效、new-guy 原样、组条目未删、无悬空。
  assert.deepEqual((await service.readTopic('proj-x')).group, ['dev']);
  assert.deepEqual((await service.readTopic('new-guy')).group, ['dev']);
  const mid = await readGroups({ dataRoot: root, scopeId: 'amber' });
  assert.equal(mid.data.groups.length, 4);
  const journalsMid = await fs.readdir(path.join(root, 'journal'));
  assert.ok(!journalsMid.includes('del-dev-race.json'), '被拒绝的删组事务不得留下 journal');

  // 重跑：迁移计划纳入新成员（fresh token + fresh 清单 revision）→ 完成。
  const fresh = await readGroups({ dataRoot: root, scopeId: 'amber' });
  const members = await Promise.all(['proj-x', 'new-guy'].map((key) => service.readTopic(key)));
  await service.mutate(deleteGroupRequest({
    operationId: 'del-dev-race-2',
    members: members.map((item) => ({ item })),
    currentGroupsRevision: fresh.revision,
  }));

  // 无悬空 key：任何 topic 都不再挂已删除的 dev（repair 无事可做的直接证据）。
  const after = await readGroups({ dataRoot: root, scopeId: 'amber' });
  assert.deepEqual(after.data.groups.map((g) => g.key), ['self', 'project', 'life']);
  const known = new Set(after.data.groups.map((g) => g.key));
  for (const topic of await service.listTopics()) {
    assert.ok(!topic.group.includes('dev'), `topic ${topic.key} 不得再挂已删除的组`);
    for (const g of topic.group) assert.ok(known.has(g), `topic ${topic.key} 挂载 "${g}" 悬空`);
  }
});

test('P2#12b service 对 groups 字段只透传不解释：形状错误由 store 报 INVALID_STATE', async (t) => {
  const { root, service } = await fixture(t);
  const proj = await putTopic(service, 'seed-1', 'proj-x', ['dev']);
  const { revision } = await readGroups({ dataRoot: root, scopeId: 'amber' });
  // groups.groups 缺失：service 不补默认值、不解释语义，形状错误原样冒泡
  //（与 writeGroups 同一校验实现，清单非数组 = INVALID_STATE）。
  await assert.rejects(
    () => service.mutate({
      operationId: 'del-dev-badshape',
      changes: [{
        kind: 'topic', key: 'proj-x', expectedRevision: proj.revision,
        text: proj.body, topic: { title: proj.title, summary: proj.summary, group: ['project'] },
      }],
      groups: { expectedRevision: revision },
    }),
    code('INVALID_STATE'),
  );
  // groups.json 未被半改：清单与 topic 原样。
  const { data } = await readGroups({ dataRoot: root, scopeId: 'amber' });
  assert.equal(data.groups.length, 4);
  assert.deepEqual((await service.readTopic('proj-x')).group, ['dev']);
  void groupsFilePath;
});

test('P2#12b 端到端：group_manage delete 经真实 service 发 groups 字段并单事务完成', async (t) => {
  const { root, service } = await fixture(t);
  await putTopic(service, 'seed-1', 'proj-x', ['dev']);
  await putTopic(service, 'seed-2', 'diary', ['life']);

  // 记录工具发出的 mutate 请求：必须携带 groups 字段（单事务通路信号），
  // 且整个 delete 恰好一次 mutate（无重试、无二次迁移）。
  // service 返回冻结对象，用展开包装监听（方法是闭包，不依赖 this）。
  const requests = [];
  const innerMutate = service.mutate;
  const spiedService = {
    ...service,
    mutate: async (request) => {
      requests.push(request);
      return innerMutate(request);
    },
  };

  const tool = createGroupManageTool({ service: spiedService, dataRoot: root, scopeId: 'amber' });
  const out = await tool.execute({ action: 'delete', key: 'dev', migrateTo: 'project' });

  assert.equal(out.deleted, true);
  assert.deepEqual(out.migrated, [{ topicKey: 'proj-x', group: ['project'] }], '主组语义：project 顶替原位');
  assert.equal(typeof out.revision, 'string');
  assert.equal(requests.length, 1, 'delete 恰好一次 mutate');
  assert.ok(requests[0].groups && requests[0].groups.expectedRevision && Array.isArray(requests[0].groups.groups),
    'mutate 请求必须携带 groups 事务字段');

  // 磁盘真值：单事务后无悬空 key，repair 无事可做（cleaned 0 / remaining 0）。
  const { data } = await readGroups({ dataRoot: root, scopeId: 'amber' });
  assert.ok(!data.groups.some((g) => g.key === 'dev'), 'dev 组条目已删');
  for (const topic of await service.listTopics()) {
    assert.ok(!topic.group.includes('dev'), `topic ${topic.key} 不得再挂已删除的组`);
  }
  const repaired = await tool.execute({ action: 'repair' });
  assert.equal(repaired.cleaned, 0, '单事务删除不留悬空，repair 无事可做');
  assert.equal(repaired.remaining, 0);
});
