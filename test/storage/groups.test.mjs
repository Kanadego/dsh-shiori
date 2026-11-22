// 0.5 批次 1-A（P1#7 解环 + P2#12b 删组单事务）storage 侧测试。
//
// 覆盖两块：
// 1) 依赖方向断言（P1#7 验收）：storage 各模块对 core 的反向导入只允许纯逻辑
//    名单（校验/序列化/常量），core/groups.mjs 不再导出任何文件 I/O 函数；
// 2) store.commit 的 groups 条目（P2#12b）：与 core/topic 变更同一 journal/
//    staging/原子替换/崩溃恢复事务；CAS 失败整体不生效；并发窗口内新挂成员
//    → 整体拒绝回滚、重跑可完成、无悬空 key。
// 证据级别与 test/storage/commit.test.mjs 一致：真实 FileStore + 真实磁盘临时 root。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFileStore, groupsFilePath } from '../../src/storage/index.mjs';
import {
  ensureGroupsFile, readGroups, writeGroups, deleteGroup,
} from '../../src/storage/groups.mjs';
import * as coreGroups from '../../src/core/groups.mjs';
import { serializeGroupsFile } from '../../src/core/groups.mjs';
import {
  sha256, stubRenderL1, stubEvaluateMutation, TEST_CONFIG,
  makeTmpRoot, topicObject,
} from './helpers.mjs';

function opts(overrides = {}) {
  return {
    root: overrides.root,
    activeScopeId: overrides.activeScopeId ?? 'amber',
    policy: stubEvaluateMutation,
    renderL1: stubRenderL1,
    config: TEST_CONFIG,
    ...overrides,
  };
}

// 多组语义夹具（默认模板已收敛成单组 general）。
const TEST_GROUPS = [
  { key: 'dev', title: '开发与配置', summary: '', order: 10 },
  { key: 'self', title: '自我与关系', summary: '', order: 20 },
  { key: 'project', title: '项目与工具', summary: '', order: 30 },
  { key: 'life', title: '生活与偏好', summary: '', order: 40 },
];

async function makeStore(t, { groups = true } = {}) {
  const root = await makeTmpRoot(t);
  if (groups) await writeGroups({ dataRoot: root, scopeId: 'amber', groups: TEST_GROUPS, expectedRevision: null });
  const store = await createFileStore(opts({ root }));
  return { root, store };
}

/** 建一个挂 dev 组的 topic（真实提交路径）。 */
async function putTopic(store, operationId, key, group, expectedRevision = null) {
  return store.commit({
    operationId, expectedGeneration: undefined,
    changes: [{ kind: 'topic', key, expectedRevision, topic: topicObject({ group }) }],
  });
}

/** 组清单文件原始字节 + sha256（CAS 入参）。 */
async function groupsBytes(root, scopeId = 'amber') {
  const raw = await fsp.readFile(groupsFilePath(root, scopeId));
  return { raw, revision: sha256(raw) };
}

// ---------- P1#7：依赖方向断言 ----------

describe('P1#7 依赖方向（解环验收）', () => {
  it('core/groups.mjs 不再导出文件 I/O 函数（readGroups/ensureGroupsFile/writeGroups/deleteGroup）', () => {
    for (const ioName of ['readGroups', 'ensureGroupsFile', 'writeGroups', 'deleteGroup']) {
      assert.equal(coreGroups[ioName], undefined, `core/groups.mjs 不得导出 I/O 函数 ${ioName}`);
    }
    // 纯逻辑导出仍在（既有消费方依赖）。
    for (const pureName of ['GROUPS_VERSION', 'validateGroupKey', 'validateGroupsData', 'assertGroupsExist', 'planGroupMigration']) {
      assert.equal(typeof coreGroups[pureName] !== 'undefined', true, `core/groups.mjs 应导出 ${pureName}`);
    }
  });

  it('storage 各模块对 core 的反向导入只含纯逻辑名单，无 core I/O 函数', async () => {
    const storageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'storage');
    const names = (await fsp.readdir(storageDir)).filter((n) => n.endsWith('.mjs'));
    const forbidden = ['readGroups', 'ensureGroupsFile', 'writeGroups', 'deleteGroup'];
    for (const name of names) {
      const text = await fsp.readFile(path.join(storageDir, name), 'utf8');
      // 抓「import {...} from '../core/...'」的具名导入（含跨行）。
      const re = /import\s*\{([^}]*)\}\s*from\s*['"]\.\.\/core\//g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const imported = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        const offenders = imported.filter((n) => forbidden.includes(n));
        assert.deepEqual(offenders, [], `${name} 从 core 导入了 I/O 函数: ${offenders.join(', ')}`);
      }
    }
  });
});

// ---------- P2#12b：store.commit 的 groups 条目（删组单事务） ----------

describe('P2#12b groups 条目：与 core/topic 同一事务', () => {
  it('topic 改挂 + 组条目删除一次提交同时生效；回执含 groups 条目；journal 恰一条', async (t) => {
    const { root, store } = await makeStore(t);
    await putTopic(store, 'seed-1', 'proj-x', ['dev']);

    const before = await store.snapshot();
    const { revision } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    const nextGroups = TEST_GROUPS.filter((g) => g.key !== 'dev');
    const result = await store.commit({
      operationId: 'del-dev-1',
      changes: [{
        kind: 'topic', key: 'proj-x',
        expectedRevision: (await store.readTopic('proj-x')).revision,
        topic: { ...topicObject(), group: ['project'] },
      }],
      groups: { expectedRevision: revision, groups: nextGroups },
    });

    // 回执：topic + groups 两个条目，同一 generation。
    assert.deepEqual(result.changes.map((c) => c.kind).sort(), ['groups', 'topic']);
    assert.equal(result.changes.length, 2);
    const groupsChange = result.changes.find((c) => c.kind === 'groups');
    assert.equal(groupsChange.beforeRevision, revision);
    assert.equal(typeof groupsChange.afterRevision, 'string');

    // 磁盘：topic 改挂与组条目删除同时生效。
    const topic = await store.readTopic('proj-x');
    assert.deepEqual(topic.group, ['project']);
    const { data } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    assert.deepEqual(data.groups.map((g) => g.key), ['self', 'project', 'life']);

    // 单事务：generation 恰 +1，同一 operationId 恰一条 journal（既往提交的 journal 留存属正常）。
    assert.equal((await store.snapshot()).generation, before.generation + 1);
    const journals = await fsp.readdir(path.join(root, 'journal'));
    assert.deepEqual(journals.filter((n) => n === 'del-dev-1.json'), ['del-dev-1.json']);
  });

  it('groups CAS 失败 → REVISION_CONFLICT，topic 改挂与组清单整体不生效', async (t) => {
    const { root, store } = await makeStore(t);
    await putTopic(store, 'seed-1', 'proj-x', ['dev']);
    const before = await store.snapshot();
    const topicBefore = await store.readTopic('proj-x');

    await assert.rejects(() => store.commit({
      operationId: 'del-dev-badcas',
      changes: [{
        kind: 'topic', key: 'proj-x',
        expectedRevision: topicBefore.revision,
        topic: { ...topicObject(), group: ['project'] },
      }],
      groups: { expectedRevision: '0'.repeat(64), groups: TEST_GROUPS.filter((g) => g.key !== 'dev') },
    }), (err) => err.code === 'REVISION_CONFLICT');

    // 整体回滚：改挂未生效、清单原样、失败操作无 journal 残留。
    assert.deepEqual((await store.readTopic('proj-x')).group, ['dev']);
    const { data } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    assert.equal(data.groups.length, 4);
    assert.equal((await store.snapshot()).generation, before.generation);
    const journals = await fsp.readdir(path.join(root, 'journal'));
    assert.ok(!journals.includes('del-dev-badcas.json'), 'CAS 失败不得留下 journal');
  });

  it('本批改挂引用被删组 → INVALID_INPUT（对照提交后清单校验）', async (t) => {
    const { root, store } = await makeStore(t);
    await putTopic(store, 'seed-1', 'proj-x', ['dev']);
    const { revision } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    await assert.rejects(async () => store.commit({
      operationId: 'del-dev-mount-removed',
      changes: [{
        kind: 'topic', key: 'proj-x',
        expectedRevision: (await store.readTopic('proj-x')).revision,
        // 改挂目标写成被删组本身：对照「提交后」清单即拒，不会先删组再留悬空。
        topic: { ...topicObject(), group: ['dev'] },
      }],
      groups: { expectedRevision: revision, groups: TEST_GROUPS.filter((g) => g.key !== 'dev') },
    }), (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /先建组/);
      return true;
    });
  });

  it('并发窗口新挂成员 → 提交复核整体拒绝（改挂与删组均未生效）；重跑纳入新成员后完成，无悬空 key', async (t) => {
    const { root, store } = await makeStore(t);
    await putTopic(store, 'seed-1', 'proj-x', ['dev']);

    // —— 快照时刻：成员只有 proj-x ——
    const { revision } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    const snapshotGroups = TEST_GROUPS.filter((g) => g.key !== 'dev');

    // —— 并发写手：快照之后、删组事务之前，新 topic 挂进 dev ——
    await putTopic(store, 'race-mount', 'new-guy', ['dev']);

    // —— 按旧快照发起删组单事务：候选复核发现 new-guy 仍挂 dev → 整体拒绝 ——
    await assert.rejects(async () => store.commit({
      operationId: 'del-dev-race',
      changes: [{
        kind: 'topic', key: 'proj-x',
        expectedRevision: (await store.readTopic('proj-x')).revision,
        topic: { ...topicObject(), group: ['project'] },
      }],
      groups: { expectedRevision: revision, groups: snapshotGroups },
    }), (err) => {
      assert.equal(err.code, 'INVALID_STATE');
      assert.match(err.message, /整体回滚/);
      assert.match(err.message, /new-guy/);
      return true;
    });

    // 复核点在 journal/staging 之前：磁盘零痕迹。
    assert.deepEqual((await store.readTopic('proj-x')).group, ['dev'], '改挂未生效');
    assert.deepEqual((await store.readTopic('new-guy')).group, ['dev'], '并发新成员原样保留');
    const { data: midData } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    assert.equal(midData.groups.length, 4, '组条目未删');
    // 复核点在 journal/staging 之前：失败操作自身零痕迹（既往成功提交的 journal 留存属正常）。
    const journalsAfterRace = await fsp.readdir(path.join(root, 'journal'));
    assert.ok(!journalsAfterRace.includes('del-dev-race.json'), '被拒绝的删组事务不得留下 journal');

    // —— 重跑：迁移计划纳入新成员，删组单事务完成 ——
    const fresh = await readGroups({ dataRoot: root, scopeId: 'amber' });
    await store.commit({
      operationId: 'del-dev-race-2',
      changes: await Promise.all(['proj-x', 'new-guy'].map(async (key) => ({
        kind: 'topic', key,
        expectedRevision: (await store.readTopic(key)).revision,
        topic: { ...topicObject(), group: ['project'] },
      }))),
      groups: { expectedRevision: fresh.revision, groups: TEST_GROUPS.filter((g) => g.key !== 'dev') },
    });

    // 无悬空 key：任何 topic 都不再挂已删除的 dev；repair 无事可做。
    for (const topic of await store.listTopics()) {
      assert.ok(!topic.group.includes('dev'), `topic ${topic.key} 不得再挂已删除的组`);
    }
    const { data: afterData } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    const known = new Set(afterData.groups.map((g) => g.key));
    for (const topic of await store.listTopics()) {
      for (const g of topic.group) assert.ok(known.has(g), `topic ${topic.key} 挂载 "${g}" 悬空`);
    }
  });

  it('payload 身份覆盖 groups：同 operationId 重放必须逐字段重复 groups 载荷', async (t) => {
    const { root, store } = await makeStore(t);
    await putTopic(store, 'seed-1', 'proj-x', ['dev']);
    const { revision } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    const topicRev = (await store.readTopic('proj-x')).revision;
    const request = (groupsPayload) => ({
      operationId: 'del-dev-idem',
      changes: [{
        kind: 'topic', key: 'proj-x', expectedRevision: topicRev,
        topic: { ...topicObject(), group: ['project'] },
      }],
      groups: groupsPayload,
    });
    const first = await store.commit(request({
      expectedRevision: revision, groups: TEST_GROUPS.filter((g) => g.key !== 'dev'),
    }));
    // 同 payload 重放幂等：返回同一结果，generation 不再前进。
    const replay = await store.commit(request({
      expectedRevision: revision, groups: TEST_GROUPS.filter((g) => g.key !== 'dev'),
    }));
    assert.equal(replay.generation, first.generation);
    // groups 载荷不同 → 视为不同 payload，拒绝重放。
    await assert.rejects(() => store.commit(request({
      expectedRevision: revision, groups: TEST_GROUPS,
    })), (err) => err.code === 'REVISION_CONFLICT');
  });

  it('groups 条目走崩溃恢复：committing 半途 → recover 补完，groups.json 与指针推进', async (t) => {
    const { root, store } = await makeStore(t);
    await putTopic(store, 'seed-1', 'proj-x', ['dev']);
    const { raw, revision } = await groupsBytes(root);
    const nextGroups = TEST_GROUPS.filter((g) => g.key !== 'dev');
    const nextBuffer = serializeGroupsFile({ version: 1, groups: nextGroups });
    const operationId = 'del-dev-crash';
    const stagingDir = path.join(root, 'staging', operationId);
    await fsp.mkdir(stagingDir, { recursive: true });
    await fsp.writeFile(path.join(stagingDir, 'after-0.bin'), nextBuffer);
    await fsp.writeFile(path.join(stagingDir, 'backup-0.bin'), raw);
    // 手写 journal：模拟进程在 rename 前被强杀（committing 半途、groups 条目在 before 态）。
    const journal = {
      version: 1,
      operationId,
      scopeId: 'amber',
      payloadHash: '0'.repeat(64),
      phase: 'committing',
      generationBefore: 1,
      generationAfter: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      changes: [{
        index: 0, kind: 'groups', file: groupsFilePath(root, 'amber'),
        stagingFile: path.join(stagingDir, 'after-0.bin'),
        backupFile: path.join(stagingDir, 'backup-0.bin'),
        beforeRevision: revision, afterRevision: sha256(nextBuffer),
      }],
    };
    await fsp.writeFile(path.join(root, 'journal', `${operationId}.json`), JSON.stringify(journal, null, 2));

    const report = await store.recover();
    const op = report.operations.find((o) => o.operationId === operationId);
    assert.equal(op?.action, 'completed', `恢复应补完 groups 条目，实际 ${op?.action}`);
    const { data } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    assert.deepEqual(data.groups.map((g) => g.key), ['self', 'project', 'life']);
    assert.equal((await store.snapshot()).generation, 2, '指针随补完推进');
    // staging 清理。
    await assert.rejects(() => fsp.access(stagingDir));
  });

  it('groups 条目走崩溃恢复：prepared 未应用 → 干净中止，groups.json 保持 before 态', async (t) => {
    const { root, store } = await makeStore(t);
    await putTopic(store, 'seed-1', 'proj-x', ['dev']);
    const { raw, revision } = await groupsBytes(root);
    const nextBuffer = serializeGroupsFile({ version: 1, groups: TEST_GROUPS.filter((g) => g.key !== 'dev') });
    const operationId = 'del-dev-crash-prepared';
    const stagingDir = path.join(root, 'staging', operationId);
    await fsp.mkdir(stagingDir, { recursive: true });
    await fsp.writeFile(path.join(stagingDir, 'after-0.bin'), nextBuffer);
    const journal = {
      version: 1,
      operationId,
      scopeId: 'amber',
      payloadHash: '0'.repeat(64),
      phase: 'prepared',
      generationBefore: 1,
      generationAfter: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      changes: [{
        index: 0, kind: 'groups', file: groupsFilePath(root, 'amber'),
        stagingFile: path.join(stagingDir, 'after-0.bin'),
        backupFile: path.join(stagingDir, 'backup-0.bin'),
        beforeRevision: revision, afterRevision: sha256(nextBuffer),
      }],
    };
    await fsp.writeFile(path.join(root, 'journal', `${operationId}.json`), JSON.stringify(journal, null, 2));

    const report = await store.recover();
    const op = report.operations.find((o) => o.operationId === operationId);
    assert.equal(op?.action, 'aborted-clean');
    const after = await groupsBytes(root);
    assert.equal(after.revision, revision, 'groups.json 保持 before 态');
    assert.equal(after.raw.equals(raw), true, '字节逐位一致');
    assert.equal((await store.snapshot()).generation, 1, '指针不前进');
  });
});

// ---------- 既有 storage 层 I/O 行为锚定（P1#7 搬家后语义不变） ----------

describe('storage/groups.mjs I/O 语义锚定', () => {
  it('deleteGroup 非空组漏 migrateTo → INVALID_STATE；空组直删（搬迁后行为不变）', async (t) => {
    const { root } = await makeStore(t);
    await assert.rejects(
      () => deleteGroup({ dataRoot: root, scopeId: 'amber', key: 'dev', topics: [{ key: 'proj-x', group: ['dev'] }] }),
      (e) => e.code === 'INVALID_STATE' && /内仍有 1 个 topic/.test(e.message),
    );
    const empty = await deleteGroup({ dataRoot: root, scopeId: 'amber', key: 'life', topics: [] });
    assert.deepEqual(empty.members, []);
    assert.deepEqual(empty.migration, []);
    const { data } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    assert.deepEqual(data.groups.map((g) => g.key), ['dev', 'self', 'project']);
  });

  it('ensureGroupsFile 幂等初始化默认模板（I/O 归位 storage 后入口不变）', async (t) => {
    const root = await makeTmpRoot(t, 'shiori-groups-io-');
    const first = await ensureGroupsFile({ dataRoot: root, scopeId: 'amber' });
    assert.equal(first.created, true);
    assert.deepEqual(first.data.groups.map((g) => g.key), ['general']);
    const second = await ensureGroupsFile({ dataRoot: root, scopeId: 'amber' });
    assert.equal(second.created, false);
    assert.equal(second.revision, first.revision);
  });

  it('磁盘 groups.json 字段级损坏 → INVALID_STATE（与 topic 磁盘解析同族）；写入口仍是 INVALID_INPUT', async (t) => {
    // 批次 8-4 债：parseGroupsFile 对「单条字段错」曾抛 INVALID_INPUT（用户入参族），
    // 而 topic 磁盘损坏一律 INVALID_STATE（数据损坏族）。磁盘字节入口统一为
    // INVALID_STATE；service/store 的写 payload 校验（validateGroupsData）保持
    // INVALID_INPUT 不变。
    const root = await makeTmpRoot(t, 'shiori-groups-code-');
    const file = groupsFilePath(root, 'amber');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // 合法 JSON、合法顶层，但单条缺 title / 组级 retention 非法：只会在字段校验层炸。
    const corrupt = {
      version: 1,
      groups: [{ key: 'dev', summary: '', order: 10 }],
    };
    await fsp.writeFile(file, `${JSON.stringify(corrupt, null, 2)}\n`, 'utf8');
    await assert.rejects(
      () => readGroups({ dataRoot: root, scopeId: 'amber' }),
      (e) => e.code === 'INVALID_STATE' && /title/.test(e.message),
      '磁盘解析错误码必须与 topic 解析同族（INVALID_STATE）',
    );
    // 对照：同一形状作为「写入入参」仍是 INVALID_INPUT（入参族不变）。
    await assert.rejects(
      () => writeGroups({
        dataRoot: root, scopeId: 'amber', groups: corrupt.groups, expectedRevision: null,
      }),
      (e) => e.code === 'INVALID_INPUT',
      '写入口的用户 payload 校验不得被改成 INVALID_STATE',
    );
    // 对照：topic 文件字段损坏也是 INVALID_STATE（同族证据，防单边断言漂移）。
    const parsedTopic = await import('../../src/storage/frontmatter.mjs');
    assert.throws(
      () => parsedTopic.parseTopicFile(Buffer.from(
        '---\nkey: "a"\nsummary: "s"\nupdated: "2026-01-01T00:00:00.000Z"\nscopeId: "amber"\n---\nb', 'utf8',
      )),
      (e) => e.code === 'INVALID_STATE',
    );
  });
});
