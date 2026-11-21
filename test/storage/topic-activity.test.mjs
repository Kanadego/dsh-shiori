// Shiori 0.5-2B · topic-activity 事件账本测试。
//
// 覆盖任务书验收面：四类事件形状与校验、两个 scope 交叉操作归属正确、
// 坏尾行容忍（读取侧跳过且不带坏后续行）、写失败 fs 桩下 append 绝不抛
// （返回 {ok:false} + 诊断计数）、并发入账整行原子与行序、尾部补换行防线。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fsp } from 'node:fs';

import {
  TOPIC_ACTIVITY_KINDS,
  createTopicActivityLedger,
  readTopicActivity,
  topicActivityStats,
  topicActivityFilePath,
} from '../../src/storage/topic-activity.mjs';
import { makeTmpRoot } from './helpers.mjs';

const FIXED_NOW = new Date('2026-11-21T08:30:00.000Z');
const clock = () => FIXED_NOW;

/** 合法事件工厂（kind/scopeId 可覆盖）。 */
function evt(overrides = {}) {
  return { scopeId: 'amber', kind: 'read', topicKey: 'proj-x', ...overrides };
}

function makeLedger(root, overrides = {}) {
  return createTopicActivityLedger({ stateRoot: root, now: clock, ...overrides });
}

test('四类事件全部入账：文件为 JSONL、行序稳定、at 由注入时钟补齐', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const ledger = makeLedger(root);
  const kinds = ['read', 'updated', 'search_hit', 'group_list'];
  for (const kind of kinds) {
    const result = await ledger.append(kind === 'group_list'
      ? evt({ kind, topicKey: undefined, groupKey: 'dev' })
      : evt({ kind }));
    assert.equal(result.ok, true, `kind=${kind} 应写入成功`);
    assert.ok(typeof result.bytes === 'number' && result.bytes > 0);
  }
  await ledger.flush();

  const raw = await fsp.readFile(topicActivityFilePath(root), 'utf8');
  const lines = raw.split('\n');
  assert.equal(lines[lines.length - 1], '', '文件以 \\n 结尾');
  assert.equal(lines.length - 1, 4, '每事件恰好一行');

  const { events, skipped } = await readTopicActivity({ stateRoot: root });
  assert.equal(skipped, 0);
  assert.deepEqual(events.map((e) => e.kind), kinds, '四类事件按入队序落盘');
  for (const event of events) {
    assert.equal(event.at, '2026-11-21T08:30:00.000Z', '缺省 at 由注入时钟补齐（规范 UTC ISO）');
    assert.equal(event.scopeId, 'amber');
  }
  assert.deepEqual(events[3], { at: FIXED_NOW.toISOString(), scopeId: 'amber', kind: 'group_list', groupKey: 'dev' },
    'group_list 事件不带 topicKey、带 groupKey');
  assert.equal(events[0].groupKey, undefined, 'read 事件不带 groupKey');
});

test('非法事件拒绝入账且不触盘：未知 kind / 空 scopeId / 坏 at / 坏 topicKey，诊断进 stats', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const ledger = makeLedger(root);
  const bad = [
    { ...evt(), kind: 'manual_restored' },   // 未知 kind：写入侧白名单四类
    { ...evt(), kind: 42 },
    { ...evt(), scopeId: '' },
    { ...evt(), scopeId: 7 },
    { ...evt(), at: '2026-11-21 08:30' },    // 非规范 UTC ISO
    { ...evt(), topicKey: '' },
    { ...evt(), topicKey: null },
    { ...evt(), groupKey: 3 },
    'not-an-object',
    null,
  ];
  for (const event of bad) {
    const result = await ledger.append(event);
    assert.equal(result.ok, false, `非法事件应拒绝：${JSON.stringify(event)}`);
    assert.equal(result.code, 'INVALID_INPUT');
    assert.ok(typeof result.error === 'string' && result.error.length > 0);
  }
  await ledger.flush();
  assert.equal(ledger.stats().appended, 0, '零写入');
  assert.equal(ledger.stats().failed, bad.length);
  assert.ok(typeof ledger.stats().lastError === 'string' && ledger.stats().lastError.length > 0);
  const { events } = await readTopicActivity({ stateRoot: root });
  assert.equal(events.length, 0);
});

test('append 返回的 promise 永不 reject；fire-and-forget 用法（生产路径不 await）不产生未处理拒绝', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const ledger = makeLedger(root);
  // 生产用法：不 await、不 catch——promise 内部已兜底。
  ledger.append(evt({ kind: 'updated', topicKey: 'a' }));
  ledger.append(evt({ topicKey: 'b' }));
  await ledger.flush();
  assert.equal(ledger.stats().pending, 0, 'flush 后在途清零');
  assert.equal(ledger.stats().appended, 2);
  const { events } = await readTopicActivity({ stateRoot: root });
  assert.deepEqual(events.map((e) => e.topicKey), ['a', 'b']);
});

test('scope 归属：两个 scope 交叉操作，各自事件归属各自的 targetScopeId', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const ledger = makeLedger(root);
  // 交叉序列：A 读 → B 读 → A 写 → B 搜命中 → B 读 → A 组目录。
  // scopeId 必须是被操作记忆所属 scope（targetScopeId），不是「当前活跃 scope」——
  // global 回落读到的记忆归属 global，这里用两个真实 scope 交叉验证归属不被错记。
  const sequence = [
    evt({ scopeId: 'scope-a', kind: 'read', topicKey: 'proj-a' }),
    evt({ scopeId: 'scope-b', kind: 'read', topicKey: 'proj-b' }),
    evt({ scopeId: 'scope-a', kind: 'updated', topicKey: 'proj-a' }),
    evt({ scopeId: 'scope-b', kind: 'search_hit', topicKey: 'proj-b' }),
    evt({ scopeId: 'scope-b', kind: 'read', topicKey: 'global-note' }),
    evt({ scopeId: 'scope-a', kind: 'group_list', groupKey: 'dev' }),
  ];
  for (const event of sequence) await ledger.append(event);
  await ledger.flush();

  const all = await readTopicActivity({ stateRoot: root });
  assert.equal(all.events.length, 6);
  assert.deepEqual(all.events.map((e) => [e.scopeId, e.kind]), [
    ['scope-a', 'read'],
    ['scope-b', 'read'],
    ['scope-a', 'updated'],
    ['scope-b', 'search_hit'],
    ['scope-b', 'read'],
    ['scope-a', 'group_list'],
  ], '每条事件的 scopeId 与其 targetScopeId 逐一对应（交叉序列不错记不漏记）');

  const a = await readTopicActivity({ stateRoot: root, scopeId: 'scope-a' });
  assert.deepEqual(a.events.map((e) => e.kind), ['read', 'updated', 'group_list'], 'scope-a 过滤');
  const b = await readTopicActivity({ stateRoot: root, scopeId: 'scope-b' });
  assert.deepEqual(b.events.map((e) => e.kind), ['read', 'search_hit', 'read'], 'scope-b 过滤');

  const statsA = await topicActivityStats({ stateRoot: root, scopeId: 'scope-a' });
  const statsB = await topicActivityStats({ stateRoot: root, scopeId: 'scope-b' });
  assert.deepEqual(statsA.byKind, { read: 1, updated: 1, search_hit: 0, group_list: 1 });
  assert.deepEqual(statsB.byKind, { read: 2, updated: 0, search_hit: 1, group_list: 0 });
});

test('topicActivityStats：四类键恒齐（含 0）与 total/skipped 口径', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const ledger = makeLedger(root);
  await ledger.append(evt({ kind: 'read' }));
  await ledger.append(evt({ kind: 'updated' }));
  await ledger.append(evt({ kind: 'updated' }));
  await ledger.flush();
  const stats = await topicActivityStats({ stateRoot: root });
  assert.equal(stats.total, 3);
  assert.equal(stats.skipped, 0);
  assert.deepEqual(stats.byKind, { read: 1, updated: 2, search_hit: 0, group_list: 0 },
    '四类键恒齐：未出现的 kind 计 0');
});

test('并发入账：50 个不 await 的 append 全部落盘、整行原子（无半行）、行序与调用序一致', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const ledger = makeLedger(root);
  for (let i = 0; i < 50; i += 1) ledger.append(evt({ topicKey: `t${i}` }));
  await ledger.flush();
  const { events, skipped } = await readTopicActivity({ stateRoot: root });
  assert.equal(skipped, 0, '单写队列 + 单次 appendFile 整行写入：无半行');
  assert.equal(events.length, 50);
  assert.deepEqual(events.map((e) => e.topicKey), Array.from({ length: 50 }, (_, i) => `t${i}`),
    '行序与入队序一致');
});

test('坏尾行容忍：崩溃残行被读取侧跳过，后续行照常解析不被带坏', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const file = topicActivityFilePath(root);
  // 直接拼磁盘真值模拟崩溃现场：两行好事件 + 尾部半行（无换行）。
  const good1 = JSON.stringify({ at: FIXED_NOW.toISOString(), scopeId: 'amber', kind: 'read', topicKey: 'a' });
  const good2 = JSON.stringify({ at: FIXED_NOW.toISOString(), scopeId: 'amber', kind: 'updated', topicKey: 'b' });
  const torn = '{"at":"2026-11-21T08:30:00.000Z","scopeId":"amber","kind":"re';
  await fsp.writeFile(file, `${good1}\n${good2}\n${torn}`, 'utf8');

  const { events, skipped } = await readTopicActivity({ stateRoot: root });
  assert.equal(skipped, 1, '恰好跳过 1 条坏尾行');
  assert.deepEqual(events.map((e) => e.topicKey), ['a', 'b'], '坏尾行之前的行全部完好');

  // 坏行之后的行不被带坏：残行后补一行好事件（append 路径会先补尾换行，见下一个用例；
  // 这里直接手工补 \n 模拟「残行已终结」，验证读取只看行、不因坏行中断）。
  await fsp.appendFile(file, `\n${JSON.stringify({ at: FIXED_NOW.toISOString(), scopeId: 'amber', kind: 'read', topicKey: 'c' })}\n`, 'utf8');
  const after = await readTopicActivity({ stateRoot: root });
  assert.equal(after.skipped, 1);
  assert.deepEqual(after.events.map((e) => e.topicKey), ['a', 'b', 'c'], '残行之后的行全部完好');
});

test('写侧尾部防线：重启后的账本探测到崩溃残行（尾缺 \\n）先补换行，避免残行与首个事件咬合', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const file = topicActivityFilePath(root);
  const ledgerA = makeLedger(root);
  await ledgerA.append(evt({ topicKey: 'a' }));
  await ledgerA.append(evt({ topicKey: 'b' }));
  await ledgerA.flush();

  // 模拟崩溃残行：截掉文件尾部若干字节（含末尾 \n），使最后一行缺尾换行且内容残缺。
  const raw = await fsp.readFile(file, 'utf8');
  const torn = raw.slice(0, raw.length - 24);
  assert.ok(!torn.endsWith('\n'), '截断后尾部确实缺 \\n');
  await fsp.writeFile(file, torn, 'utf8');

  // 重启后的新账本实例：首个 append 前探测尾部并补一个 \n。
  const ledgerB = makeLedger(root);
  await ledgerB.append(evt({ topicKey: 'c' }));
  await ledgerB.flush();

  const { events, skipped } = await readTopicActivity({ stateRoot: root });
  assert.deepEqual(events.map((e) => e.topicKey), ['a', 'c'],
    '残行（b 的碎片）被跳过；首个新事件不被咬合带坏');
  assert.equal(skipped, 1);
  const rawAfter = await fsp.readFile(file, 'utf8');
  assert.ok(rawAfter.includes('\n{"at'), '补写的换行分隔了残行与新事件行');
});

test('账本不存在（ENOENT）视为空账本；空文件返回零事件', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const empty = await readTopicActivity({ stateRoot: root });
  assert.deepEqual(empty, { events: [], skipped: 0 });
  const stats = await topicActivityStats({ stateRoot: root });
  assert.deepEqual(stats, { total: 0, skipped: 0, byKind: { read: 0, updated: 0, search_hit: 0, group_list: 0 } });

  const file = topicActivityFilePath(root);
  await fsp.writeFile(file, '', 'utf8');
  const blank = await readTopicActivity({ stateRoot: root });
  assert.deepEqual(blank, { events: [], skipped: 0 });
});

test('写失败 fs 桩：appendFile 抛错时 append 照常返回 {ok:false}，诊断进 stats，绝不抛绝不 reject', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const failingFs = {
    // 模拟磁盘写失败（ENOSPC/EACCES 等）：promise 拒绝。
    appendFile: async () => {
      const err = new Error('simulated disk failure');
      err.code = 'EACCES';
      throw err;
    },
    readFile: async () => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    },
  };
  const ledger = createTopicActivityLedger({ stateRoot: root, now: clock, fs: failingFs });
  const result = await ledger.append(evt({ kind: 'updated' }));
  assert.equal(result.ok, false, '写失败如实返回失败结论');
  assert.equal(result.code, 'IO_ERROR');
  assert.equal(result.error, 'EACCES');
  const fireAndForget = ledger.append(evt()); // 生产 fire-and-forget：不 await 也不 catch
  await ledger.flush();
  await fireAndForget;
  const stats = ledger.stats();
  assert.equal(stats.appended, 0);
  assert.equal(stats.failed, 2);
  assert.equal(stats.lastError, 'EACCES');
  assert.equal(stats.pending, 0);
});

test('写失败 fs 桩（同步抛）：appendFile 同步 throw 同样被兜底，工具照常拿到 {ok:false}', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const hostileFs = {
    appendFile: () => {
      throw new Error('sync boom');
    },
    readFile: async () => {
      throw Object.assign(new Error('no file'), { code: 'ENOENT' });
    },
  };
  const ledger = createTopicActivityLedger({ stateRoot: root, now: clock, fs: hostileFs });
  const result = await ledger.append(evt());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'IO_ERROR');
  assert.equal(ledger.stats().failed, 1);
  await ledger.flush();
  assert.equal(ledger.stats().pending, 0);
});

test('读取侧 IO 失败（非 ENOENT）包装 IO_ERROR 上抛，绝不静默吞错；入参非法抛 INVALID_INPUT', async (t) => {
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const deniedFs = {
    readFile: async () => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      throw err;
    },
  };
  await assert.rejects(
    () => readTopicActivity({ stateRoot: root, fs: deniedFs }),
    (e) => e.code === 'IO_ERROR' && e.details?.ioCode === 'EACCES',
  );
  await assert.rejects(() => readTopicActivity({ stateRoot: '' }), (e) => e.code === 'INVALID_INPUT');
  await assert.rejects(() => readTopicActivity({ stateRoot: null }), (e) => e.code === 'INVALID_INPUT');
  // createTopicActivityLedger 是同步工厂：必须经 async 箭头转成 rejection，
  // 否则 assert.rejects 对同步抛错会跳过校验器原样上抛（node:test 行为）。
  await assert.rejects(
    async () => createTopicActivityLedger({ stateRoot: root, fs: {} }),
    (e) => e.code === 'INVALID_INPUT' && /appendFile/.test(e.message),
  );
  await assert.rejects(() => topicActivityStats({ stateRoot: 42 }), (e) => e.code === 'INVALID_INPUT');
});

test('TOPIC_ACTIVITY_KINDS 恒为五类（0.5 批次 4 B 线追加 settings_change，冻结）；显式 at 合法值原样入账', async (t) => {
  // 本次唯一被授权的冻结集合扩展：热度参数审计事件 settings_change 正式纳入
  // 合法 kind（复用唯一 writer；温度引擎按未知 kind 忽略，不参与加热）。
  assert.deepEqual([...TOPIC_ACTIVITY_KINDS], ['read', 'updated', 'search_hit', 'group_list', 'settings_change']);
  assert.ok(Object.isFrozen(TOPIC_ACTIVITY_KINDS));
  const root = await makeTmpRoot(t, 'shiori-topic-activity-');
  const ledger = makeLedger(root);
  await ledger.append(evt({ at: '2026-11-07T00:00:00.000Z', kind: 'search_hit' }));
  await ledger.flush();
  const { events } = await readTopicActivity({ stateRoot: root });
  assert.equal(events[0].at, '2026-11-07T00:00:00.000Z', '显式规范 at 原样保留');
});
