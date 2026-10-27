// 崩溃安全：子进程在持久阶段被 SIGKILL 强杀后的恢复判据。
// 数据丢失判据（与 docs/storage/README.md 一致）：
//   恢复后每个目标文件必须处于且仅处于 before 态或 after 态；
//   全部 after = 完成提交（generation 前进）；存在第三方新内容 = 冲突中止且不覆盖新内容。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createFileStore } from '../../src/storage/index.mjs';
import {
  sha256, stubRenderL1, stubEvaluateMutation, TEST_CONFIG,
  makeTmpRoot, putCore, spawnNode, waitForFile, readJson, topicObject,
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

const SEED = 'seed-core\n';
const NEXT = 'next-core\n';

function makePlan() {
  return {
    operationId: 'op-crash',
    expectedGeneration: 0,
    activeScopeId: 'amber',
    changes: [
      { kind: 'core', expectedRevision: sha256(Buffer.from(SEED, 'utf8')), text: NEXT },
      { kind: 'topic', key: 't1', expectedRevision: null, topic: topicObject({ title: 'T1', summary: 'S1', body: 'B1' }) },
      { kind: 'topic', key: 't2', expectedRevision: null, topic: topicObject({ title: 'T2', summary: 'S2', body: 'B2' }) },
    ],
  };
}

async function runCrashChild(t, root, fault, plan) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-crash-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const planFile = path.join(dir, 'plan.json');
  const resultFile = path.join(dir, 'result.json');
  await fsp.writeFile(planFile, JSON.stringify(plan));
  const proc = spawnNode('crash-child.mjs', [
    '--root', root, '--fault', fault, '--plan', planFile, '--result', resultFile,
  ], { timeoutMs: 60_000 });
  const exit = await proc.promise;
  const returned = await fsp.access(resultFile).then(() => true, () => false);
  return { exit, returned, resultFile };
}

async function seedRoot(t) {
  const root = await makeTmpRoot(t);
  await putCore(root, 'amber', SEED);
  return root;
}

describe('崩溃在 prepared 阶段（准备后 / 备份后）', () => {
  for (const fault of ['prepare', 'backup']) {
    it(`fault=${fault}：恢复后干净中止，目标全部保持 before 态，generation 不变`, async (t) => {
      const root = await seedRoot(t);
      const { exit, returned } = await runCrashChild(t, root, fault, makePlan());
      assert.ok(exit.code !== 0 || exit.signal, '子进程应被强杀');
      assert.equal(returned, false, '强杀进程不应写出结果');

      // 残留：journal + staging 在场（持久的 prepare 证据）
      const journalRaw = JSON.parse(await fsp.readFile(
        path.join(root, 'journal', 'op-crash.json'), 'utf8'));
      assert.equal(journalRaw.phase, 'prepared');
      assert.ok((await fsp.readdir(path.join(root, 'staging', 'op-crash'))).length > 0);

      const store = await createFileStore(opts({ root }));
      const report = await store.recover();
      assert.equal(report.operations[0].action, 'aborted-clean');
      assert.equal(report.generation, 0);

      // 数据丢失判据：全部目标在 before 态
      assert.equal((await store.readCore()).text, SEED);
      await assert.rejects(() => store.readTopic('t1'), (e) => e.code === 'NOT_FOUND');
      await assert.rejects(() => store.readTopic('t2'), (e) => e.code === 'NOT_FOUND');
      // staging 已清理
      assert.deepEqual(await fsp.readdir(path.join(root, 'staging')), []);
      // 恢复后可正常提交
      const r = await store.commit({
        operationId: 'after-recovery', expectedGeneration: 0,
        changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from(SEED, 'utf8')), text: NEXT }],
      });
      assert.equal(r.generation, 1);
    });
  }

  it('fault=prepare 后不改文件、同 operationId 同 payload 直接重试：自动补账并成功', async (t) => {
    const root = await seedRoot(t);
    await runCrashChild(t, root, 'prepare', makePlan());
    const store = await createFileStore(opts({ root }));
    // 不先 recover：commit 内部自动补账，中止残留 prepared，再作为新尝试执行
    const plan = makePlan();
    const r = await store.commit({
      operationId: plan.operationId,
      expectedGeneration: plan.expectedGeneration,
      changes: plan.changes,
    });
    assert.equal(r.generation, 1);
    assert.equal((await store.readCore()).text, NEXT);
    assert.equal((await store.readTopic('t1')).body, 'B1');
    assert.equal((await store.readTopic('t2')).body, 'B2');
  });
});

describe('崩溃在 committing 阶段（目标写后 / 源替换后）', () => {
  for (const fault of ['first-rename', 'renames']) {
    it(`fault=${fault}：恢复补完 rename，最终全部 after 态且 generation=1`, async (t) => {
      const root = await seedRoot(t);
      const { returned } = await runCrashChild(t, root, fault, makePlan());
      assert.equal(returned, false);

      const journalRaw = JSON.parse(await fsp.readFile(
        path.join(root, 'journal', 'op-crash.json'), 'utf8'));
      assert.equal(journalRaw.phase, 'committing');

      const store = await createFileStore(opts({ root }));
      const report = await store.recover();
      assert.equal(report.operations[0].action, 'completed');
      assert.equal(report.pointerAdvanced, true);

      // 数据丢失判据：全部目标在 after 态，无混合代
      assert.equal((await store.readCore()).text, NEXT);
      assert.equal((await store.readTopic('t1')).title, 'T1');
      assert.equal((await store.readTopic('t2')).body, 'B2');
      assert.equal((await store.snapshot()).generation, 1);
      assert.deepEqual(await fsp.readdir(path.join(root, 'staging')), []);

      // 幂等：跨进程重放同 payload 返回已记录结果
      const plan = makePlan();
      const replay = await store.commit({
        operationId: plan.operationId,
        expectedGeneration: plan.expectedGeneration,
        changes: plan.changes,
      });
      assert.equal(replay.generation, 1);
      assert.equal(replay.operationId, 'op-crash');
    });
  }
});

describe('崩溃在 committed 标记后、指针写入前', () => {
  it('fault=marker：恢复推进指针，snapshot 报告已提交代', async (t) => {
    const root = await seedRoot(t);
    await runCrashChild(t, root, 'marker', makePlan());

    const journalRaw = JSON.parse(await fsp.readFile(
      path.join(root, 'journal', 'op-crash.json'), 'utf8'));
    assert.equal(journalRaw.phase, 'committed');
    const pointer = JSON.parse(await fsp.readFile(
      path.join(root, 'state', 'current.json'), 'utf8'));
    assert.equal(pointer.generation, 0); // 指针落后

    const store = await createFileStore(opts({ root }));
    const report = await store.recover();
    assert.equal(report.pointerAdvanced, true);
    assert.equal((await store.snapshot()).generation, 1);
    assert.equal((await store.readCore()).text, NEXT);

    // 幂等重放仍返回已记录结果
    const plan = makePlan();
    const replay = await store.commit({
      operationId: plan.operationId,
      expectedGeneration: plan.expectedGeneration,
      changes: plan.changes,
    });
    assert.equal(replay.generation, 1);
  });
});

describe('恢复与手改冲突（不覆盖较新内容）', () => {
  it('prepared 阶段崩溃后手改 core：恢复判为冲突中止，手改内容原样保留', async (t) => {
    const root = await seedRoot(t);
    await runCrashChild(t, root, 'prepare', makePlan());

    const handText = 'hand edit 新内容\n';
    await fsp.writeFile(path.join(root, 'scopes', 'amber', 'core.md'), Buffer.from(handText, 'utf8'));

    const store = await createFileStore(opts({ root }));
    const report = await store.recover();
    assert.equal(report.operations[0].action, 'aborted-with-conflicts');
    assert.equal(report.generation, 0);
    // 手改不被覆盖、不被回滚
    assert.equal((await store.readCore()).text, handText);
    await assert.rejects(() => store.readTopic('t1'), (e) => e.code === 'NOT_FOUND');
    // 之后按手改后的 revision 正常提交
    const r = await store.commit({
      operationId: 'post-hand', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from(handText, 'utf8')), text: NEXT }],
    });
    assert.equal(r.generation, 1);
  });

  it('committing 阶段部分应用后另一目标出现手改：已应用条目回滚，手改保留', async (t) => {
    const root = await seedRoot(t);
    await runCrashChild(t, root, 'first-rename', makePlan());
    // 此时 core 已被 rename 为 NEXT（已应用），t1/t2 尚未应用
    // 手动制造 t1 目标的第三方内容（哈希既非 before 也非 after）
    const t1File = path.join(root, 'scopes', 'amber', 'topics', 't1.md');
    const handTopic = 'hand-written topic bytes';
    await fsp.mkdir(path.dirname(t1File), { recursive: true });
    await fsp.writeFile(t1File, Buffer.from(handTopic, 'utf8'));

    const store = await createFileStore(opts({ root }));
    const report = await store.recover();
    assert.equal(report.operations[0].action, 'aborted-with-conflicts');
    assert.equal(report.operations[0].rolledBack[0].action, 'restored-backup');
    assert.equal(report.generation, 0);

    // 判据：core 回滚到 before；t1 手改保留；t2 从未出现
    assert.equal((await store.readCore()).text, SEED);
    const t1Raw = await fsp.readFile(t1File, 'utf8');
    assert.equal(t1Raw, handTopic);
    await assert.rejects(() => store.readTopic('t2'), (e) => e.code === 'NOT_FOUND');
    // 冲突中止保留 staging 供人工挽回
    assert.ok((await fsp.readdir(path.join(root, 'staging', 'op-crash'))).length > 0);
  });
});
