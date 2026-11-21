// S3 分组主链路（0.4 §S3.1）：store.mjs 的 group/pinned 写入接线、读取接线、
// 未识别键拒绝、组存在性校验、默认值注入不改写文件。
// 证据级别与 test/storage/commit.test.mjs 一致：真实 FileStore + 真实磁盘临时 root；
// 组清单复用 S3-a 的 ensureGroupsFile（真实 groups.json，不走 stub）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { createFileStore, groupsFilePath } from '../../src/storage/index.mjs';
import { ensureGroupsFile, readGroups, writeGroups } from '../../src/storage/groups.mjs';
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

// 默认模板已收敛成单组 general；多组语义（dev/project/life/self）的用例需要自己
// 显式种一份四组清单，避免被模板变更牵连。
const TEST_GROUPS = [
  { key: 'dev', title: '开发与配置', summary: '', order: 10 },
  { key: 'self', title: '自我与关系', summary: '', order: 20 },
  { key: 'project', title: '项目与工具', summary: '', order: 30 },
  { key: 'life', title: '生活与偏好', summary: '', order: 40 },
];

/** 建仓 + 初始化组清单：groups:'default' 走真实默认模板，其余种四组夹具。 */
async function makeStore(t, { groups = true } = {}) {
  const root = await makeTmpRoot(t);
  if (groups === 'default') await ensureGroupsFile({ dataRoot: root, scopeId: 'amber' });
  else if (groups) await writeGroups({ dataRoot: root, scopeId: 'amber', groups: TEST_GROUPS, expectedRevision: null });
  const store = await createFileStore(opts({ root }));
  return { root, store };
}

describe('S3 group/pinned 主链路（端到端）', () => {
  it('commit group/pinned → 落盘 front-matter → readTopic → listTopics → 快照 全程不丢字段', async (t) => {
    const { root, store } = await makeStore(t);
    const result = await store.commit({
      operationId: 's3-e2e', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 'proj-x', expectedRevision: null,
        topic: topicObject({ group: ['dev', 'project'], pinned: true }),
      }],
    });
    assert.equal(result.changes[0].kind, 'topic');

    // 1) 直接读文件：front-matter 有 group 数组标量与 pinned: true。
    const raw = await fsp.readFile(path.join(root, 'scopes', 'amber', 'topics', 'proj-x.md'), 'utf8');
    assert.match(raw, /^group: \["dev", ?"project"\]$/m);
    assert.match(raw, /^pinned: true$/m);

    // 2) readTopic 返回强类型 group/pinned。
    const topic = await store.readTopic('proj-x');
    assert.deepEqual(topic.group, ['dev', 'project']);
    assert.equal(topic.pinned, true);

    // 3) listTopics 同样携带。
    const listed = (await store.listTopics()).find((x) => x.key === 'proj-x');
    assert.deepEqual(listed.group, ['dev', 'project']);
    assert.equal(listed.pinned, true);

    // 4) 快照不丢字段。
    const snap = await store.snapshot();
    const inSnap = snap.topics.find((x) => x.key === 'proj-x');
    assert.deepEqual(inSnap.group, ['dev', 'project']);
    assert.equal(inSnap.pinned, true);
  });

  it('group 空数组 / pinned false 不落盘（缺省省略），读取补默认值', async (t) => {
    const { root, store } = await makeStore(t);
    await store.commit({
      operationId: 's3-default', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 'plain', expectedRevision: null,
        topic: topicObject({ group: [], pinned: false }),
      }],
    });
    const raw = await fsp.readFile(path.join(root, 'scopes', 'amber', 'topics', 'plain.md'), 'utf8');
    assert.doesNotMatch(raw, /^group:/m, '空数组整行省略');
    assert.doesNotMatch(raw, /^pinned:/m, 'false 整行省略');
    const topic = await store.readTopic('plain');
    assert.deepEqual(topic.group, []);
    assert.equal(topic.pinned, false);
  });

  it('默认值注入不改写未触碰文件：读路径补 [] / false，磁盘字节原样保留', async (t) => {
    const { root, store } = await makeStore(t);
    // 直接放置无 group/pinned 字段的 topic 文件（夹具，不走 store）。
    const file = path.join(root, 'scopes', 'amber', 'topics', 'legacy.md');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const rawText = [
      '---',
      'key: "legacy"',
      'title: "老专题"',
      'summary: "老摘要"',
      'updated: "2026-10-24T00:00:00.000Z"',
      'scopeId: "amber"',
      '---',
      '老正文',
      '',
    ].join('\n');
    await fsp.writeFile(file, Buffer.from(rawText, 'utf8'));
    const before = sha256(Buffer.from(rawText, 'utf8'));

    const topic = await store.readTopic('legacy');
    assert.deepEqual(topic.group, []);
    assert.equal(topic.pinned, false);
    const listed = (await store.listTopics()).find((x) => x.key === 'legacy');
    assert.deepEqual(listed.group, []);

    // 文件字节未被读取路径改写。
    const after = sha256(await fsp.readFile(file));
    assert.equal(after, before, '读路径绝不写盘：老文件 front-matter 原样保留');
  });

  it('更新改组：带上新 group 提交后 front-matter 与读取同步变化', async (t) => {
    const { store } = await makeStore(t);
    const created = await store.commit({
      operationId: 's3-up-1', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 't1', expectedRevision: null,
        topic: topicObject({ group: ['dev'] }),
      }],
    });
    await store.commit({
      operationId: 's3-up-2',
      changes: [{
        kind: 'topic', key: 't1', expectedRevision: created.changes[0].afterRevision,
        topic: topicObject({ group: ['life'], pinned: true }),
      }],
    });
    const topic = await store.readTopic('t1');
    assert.deepEqual(topic.group, ['life']);
    assert.equal(topic.pinned, true);
  });
});

describe('S3 防静默丢字段：未识别键拒绝', () => {
  it('topic 对象出现未识别键 → INVALID_INPUT 并列出键名', async (t) => {
    const { store } = await makeStore(t);
    await assert.rejects(() => store.commit({
      operationId: 's3-unknown', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 't2', expectedRevision: null,
        topic: topicObject({ grp: ['dev'] }),
      }],
    }), (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /未识别字段/);
      assert.match(err.message, /"grp"/);
      return true;
    });
  });

  it('多个未识别键全部列出；允许字段列表在报错文案中给出', async (t) => {
    const { store } = await makeStore(t);
    await assert.rejects(() => store.commit({
      operationId: 's3-unknown2', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 't3', expectedRevision: null,
        topic: topicObject({ groups: ['dev'], pinnedWhen: true }),
      }],
    }), (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /"groups"/);
      assert.match(err.message, /"pinnedWhen"/);
      return true;
    });
  });

  it('未识别键拒绝发生在写入前：目标文件保持不存在', async (t) => {
    const { root, store } = await makeStore(t);
    await assert.rejects(() => store.commit({
      operationId: 's3-unknown3', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 't4', expectedRevision: null,
        topic: topicObject({ oops: 1 }),
      }],
    }), (err) => err.code === 'INVALID_INPUT');
    await assert.rejects(() => fsp.access(path.join(root, 'scopes', 'amber', 'topics', 't4.md')));
  });
});

describe('S3 组存在性校验（commit 侧）', () => {
  it('group 引用不存在的组 → INVALID_INPUT 提示先建组并列出现有组', async (t) => {
    const { store } = await makeStore(t);
    await assert.rejects(() => store.commit({
      operationId: 's3-miss', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 't5', expectedRevision: null,
        topic: topicObject({ group: ['dev', 'nope'] }),
      }],
    }), (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /"nope"/);
      assert.match(err.message, /先建组/);
      assert.match(err.message, /dev/); // 现有组列表
      return true;
    });
  });

  it('groups.json 缺失 → 非空 group 一律拒绝（清单缺失视为无组）', async (t) => {
    const { store } = await makeStore(t, { groups: false });
    await assert.rejects(() => store.commit({
      operationId: 's3-nofile', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 't6', expectedRevision: null,
        topic: topicObject({ group: ['dev'] }),
      }],
    }), (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /先建组/);
      return true;
    });
  });

  it('groups.json 缺失时无 group 的提交不受影响（校验只针对非空 group）', async (t) => {
    const { store } = await makeStore(t, { groups: false });
    await store.commit({
      operationId: 's3-nogroup', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 't7', expectedRevision: null, topic: topicObject() }],
    });
    const topic = await store.readTopic('t7');
    assert.deepEqual(topic.group, []);
  });

  it('裸 text 路径：front-matter 携带 group 同样受组存在性校验', async (t) => {
    const { store } = await makeStore(t);
    const rawText = [
      '---',
      'key: "t8"',
      'title: "文本路径"',
      'summary: "裸 text"',
      'updated: "2026-10-24T00:00:00.000Z"',
      'scopeId: "amber"',
      'group: ["nope-text"]',
      '---',
      '正文',
    ].join('\n');
    await assert.rejects(() => store.commit({
      operationId: 's3-text', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 't8', expectedRevision: null, text: rawText }],
    }), (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /"nope-text"/);
      return true;
    });
    // 合法组时裸 text 写入成功且字段落盘。
    const okText = rawText.replace('nope-text', 'dev');
    await store.commit({
      operationId: 's3-text-ok',
      changes: [{ kind: 'topic', key: 't8', expectedRevision: null, text: okText }],
    });
    const topic = await store.readTopic('t8');
    assert.deepEqual(topic.group, ['dev']);
  });
});

describe('S3 组清单初始化与提交协同', () => {
  it('ensureGroupsFile 初始化的默认模板对 commit 可见（默认组可挂载）', async (t) => {
    const { store } = await makeStore(t, { groups: 'default' });
    await store.commit({
      operationId: 's3-tpl', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 't9', expectedRevision: null,
        topic: topicObject({ group: ['general'] }),
      }],
    });
    const topic = await store.readTopic('t9');
    assert.deepEqual(topic.group, ['general']);
  });

  it('groups.json 路径助手与 store root 一致（groupsFilePath）', async (t) => {
    const { root } = await makeStore(t, { groups: 'default' });
    const file = groupsFilePath(root, 'amber');
    const raw = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    assert.equal(data.version, 1);
    assert.deepEqual(data.groups.map((g) => g.key).sort(), ['general']);
    const { data: reread } = await readGroups({ dataRoot: root, scopeId: 'amber' });
    assert.deepEqual(reread.groups.map((g) => g.key).sort(), ['general']);
  });
});

// ---------- 0.5 批次 2 A 线：retention / archiveOrigin 读写接线 ----------

describe('0.5 A 线：retention/archiveOrigin 读传播与写路径', () => {
  it('结构化写路径：retention/archiveOrigin 落盘 front-matter，读回强类型枚举', async (t) => {
    const { root, store } = await makeStore(t);
    await store.commit({
      operationId: 'a05-write', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 'hist-x', expectedRevision: null,
        topic: topicObject({ retention: 'historical', archiveOrigin: 'auto-inactive' }),
      }],
    });
    const raw = await fsp.readFile(path.join(root, 'scopes', 'amber', 'topics', 'hist-x.md'), 'utf8');
    assert.match(raw, /^retention: "historical"$/m);
    assert.match(raw, /^archiveOrigin: "auto-inactive"$/m);
    const topic = await store.readTopic('hist-x');
    assert.equal(topic.retention, 'historical');
    assert.equal(topic.archiveOrigin, 'auto-inactive');
    const listed = (await store.listTopics()).find((x) => x.key === 'hist-x');
    assert.equal(listed.retention, 'historical');
    assert.equal(listed.archiveOrigin, 'auto-inactive');
    const snap = (await store.snapshot()).topics.find((x) => x.key === 'hist-x');
    assert.equal(snap.retention, 'historical');
  });

  it('缺省值不落盘（standing/manual/空串整行省略），读取补默认值', async (t) => {
    const { root, store } = await makeStore(t);
    for (const [i, extra] of [{}, { retention: 'standing', archiveOrigin: 'manual' },
      { retention: '', archiveOrigin: '' }].entries()) {
      const key = `plain-${i}`;
      await store.commit({
        operationId: `a05-default-${i}`,
        ...(i === 0 ? { expectedGeneration: 0 } : {}),
        changes: [{ kind: 'topic', key, expectedRevision: null, topic: topicObject(extra) }],
      });
      const raw = await fsp.readFile(path.join(root, 'scopes', 'amber', 'topics', `${key}.md`), 'utf8');
      assert.doesNotMatch(raw, /^retention:/m, `variant ${i}`);
      assert.doesNotMatch(raw, /^archiveOrigin:/m, `variant ${i}`);
      const topic = await store.readTopic(key);
      assert.equal(topic.retention, 'standing', `variant ${i}`);
      assert.equal(topic.archiveOrigin, 'manual', `variant ${i}`);
    }
  });

  it('旧文件不重写：读路径补默认值，mtime 与字节双零变化', async (t) => {
    const { root, store } = await makeStore(t);
    const file = path.join(root, 'scopes', 'amber', 'topics', 'legacy-a05.md');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const rawText = [
      '---',
      'key: "legacy-a05"',
      'title: "老专题"',
      'summary: "老摘要"',
      'updated: "2026-10-24T00:00:00.000Z"',
      'scopeId: "amber"',
      '---',
      '老正文',
      '',
    ].join('\n');
    await fsp.writeFile(file, Buffer.from(rawText, 'utf8'));
    const beforeBytes = await fsp.readFile(file);
    const beforeSha = sha256(beforeBytes);
    const beforeStat = await fsp.stat(file);

    const topic = await store.readTopic('legacy-a05');
    assert.equal(topic.retention, 'standing', '旧文件缺省读 standing');
    assert.equal(topic.archiveOrigin, 'manual', '旧文件缺省读 manual');
    const listed = (await store.listTopics()).find((x) => x.key === 'legacy-a05');
    assert.equal(listed.retention, 'standing');
    const snap = (await store.snapshot()).topics.find((x) => x.key === 'legacy-a05');
    assert.equal(snap.retention, 'standing');

    // 留出 mtime 粒度窗口后再读一轮（Windows mtime 精度足够，但显式等待证明不是碰巧）
    await new Promise((r) => setTimeout(r, 50));
    await store.readTopic('legacy-a05');
    await store.listTopics();

    const afterBytes = await fsp.readFile(file);
    assert.equal(sha256(afterBytes), beforeSha, '读路径绝不写盘：字节零变化');
    const afterStat = await fsp.stat(file);
    assert.equal(afterStat.mtimeMs, beforeStat.mtimeMs, '读路径绝不写盘：mtime 不变');
  });

  it('手改磁盘文件带 retention → 读路径照收（含非法枚举 INVALID_STATE 拒绝）', async (t) => {
    const { root, store } = await makeStore(t);
    const file = path.join(root, 'scopes', 'amber', 'topics', 'hand.md');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const rawText = [
      '---',
      'key: "hand"',
      'title: "手改"',
      'summary: "手改摘要"',
      'updated: "2026-10-24T00:00:00.000Z"',
      'scopeId: "amber"',
      'retention: "historical"',
      '---',
      '正文',
    ].join('\n');
    await fsp.writeFile(file, Buffer.from(rawText, 'utf8'));
    const topic = await store.readTopic('hand');
    assert.equal(topic.retention, 'historical');

    const badText = rawText.replace('retention: "historical"', 'retention: "bogus"');
    await fsp.writeFile(file, Buffer.from(badText, 'utf8'));
    await assert.rejects(() => store.readTopic('hand'),
      (err) => err.code === 'INVALID_STATE' && /retention/.test(err.message));
    // 扫描级读取（listTopics/snapshot）对坏文件走影子报告降级（既有口径：不炸全局），
    // 坏文件被跳过、不出现在列表中，影子报告记录原因。
    const listed = await store.listTopics();
    assert.equal(listed.find((x) => x.key === 'hand'), undefined, '坏文件不进列表');
    const report = await store.legacyReport();
    assert.ok(report.shadow.some((s) => s.file.endsWith('hand.md') && /retention/.test(s.reason)),
      '影子报告记录 front-matter 解析失败原因');
  });

  it('裸 text 路径：front-matter 携带合法枚举可写，非法枚举 INVALID_INPUT', async (t) => {
    const { store } = await makeStore(t);
    const rawText = [
      '---',
      'key: "t-raw"',
      'title: "文本路径"',
      'summary: "裸 text"',
      'updated: "2026-10-24T00:00:00.000Z"',
      'scopeId: "amber"',
      'retention: "historical"',
      'archiveOrigin: "auto-inactive"',
      '---',
      '正文',
    ].join('\n');
    await store.commit({
      operationId: 'a05-raw-ok', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 't-raw', expectedRevision: null, text: rawText }],
    });
    const topic = await store.readTopic('t-raw');
    assert.equal(topic.retention, 'historical');
    assert.equal(topic.archiveOrigin, 'auto-inactive');

    await assert.rejects(() => store.commit({
      operationId: 'a05-raw-bad',
      changes: [{
        kind: 'topic', key: 't-raw2', expectedRevision: null,
        text: rawText.replace('t-raw', 't-raw2').replace('retention: "historical"', 'retention: "nope"'),
      }],
    }), (err) => {
      // 裸 text 的 front-matter 先经 parseTopicFile（磁盘形态文档）——非法枚举
      // 在解析层即 INVALID_STATE 拒绝，先于 #validateTopicMeta 的写入侧校验。
      assert.equal(err.code, 'INVALID_STATE');
      assert.match(err.message, /retention/);
      return true;
    });
  });

  it('retention/archiveOrigin 不再是未识别字段；其他未识别键照旧拒绝', async (t) => {
    const { store } = await makeStore(t);
    await store.commit({
      operationId: 'a05-allowed', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 't-ok', expectedRevision: null,
        topic: topicObject({ retention: 'historical', archiveOrigin: 'manual' }),
      }],
    });
    await assert.rejects(() => store.commit({
      operationId: 'a05-still-unknown',
      changes: [{
        kind: 'topic', key: 't-bad', expectedRevision: null,
        topic: topicObject({ temperature: 'cold' }),
      }],
    }), (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /"temperature"/);
      return true;
    });
  });

  it('retention 非布尔/非枚举形状（数字）→ INVALID_INPUT 类型把关', async (t) => {
    const { store } = await makeStore(t);
    await assert.rejects(() => store.commit({
      operationId: 'a05-type', expectedGeneration: 0,
      changes: [{
        kind: 'topic', key: 't-num', expectedRevision: null,
        topic: topicObject({ retention: 42 }),
      }],
    }), (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /retention 必须是字符串枚举标量/);
      return true;
    });
  });
});
