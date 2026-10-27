// R1–R9 边界回归（对应琥珀 attempt1 独立验收的 9 项阻塞，等价用例指向新实现）。
// 全部使用自建临时目录合成夹具；不读写真实记忆，不联网。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { createFileStore } from '../../src/storage/index.mjs';
import { withLock } from '../../src/storage/lockfile.mjs';
import {
  sha256, stubRenderL1, stubEvaluateMutation, TEST_CONFIG,
  makeTmpRoot, putCore, topicObject, waitForFile, spawnNode, readJson,
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

/** 造一个已死的 pid：起一个立即退出的子进程并返回其 pid。 */
async function makeDeadPid() {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid;
}

describe('R1 · 幂等身份包含可信 scopeId', () => {
  it('amber 成功提交后，other 用完全相同请求不得命中其成功结果；同 scope 重放仍幂等', async (t) => {
    const root = await makeTmpRoot(t);
    const seed = 'seed\n';
    await putCore(root, 'amber', seed);
    const storeA = await createFileStore(opts({ root, activeScopeId: 'amber' }));
    const storeO = await createFileStore(opts({ root, activeScopeId: 'other' }));

    const request = {
      operationId: 'replay-x',
      expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from(seed)), text: 'A\n' }],
    };
    const first = await storeA.commit(request);
    assert.equal(first.generation, 1);

    // 跨 scope 同请求：不得当成功重放
    await assert.rejects(() => storeO.commit({ ...request }),
      (err) => err.code === 'REVISION_CONFLICT');
    // 磁盘上 amber 的 core 如实可见且未被 other 的请求改动
    assert.equal(await fsp.readFile(path.join(root, 'scopes', 'amber', 'core.md'), 'utf8'), 'A\n');
    assert.equal((await storeO.readCore()).text, ''); // other 自身 scope 视图为空

    // 同 scope 同 payload：幂等重放有效
    const again = await storeA.commit({ ...request });
    assert.equal(again.generation, first.generation);
    assert.equal(again.operationId, 'replay-x');
  });
});

describe('R2 · 锁接管安全', () => {
  it('空锁文件（未知持有者）不得被接管：等待至超时 LOCK_BUSY', async (t) => {
    const root = await makeTmpRoot(t);
    const lockPath = path.join(root, '.shiori-lock');
    await fsp.writeFile(lockPath, ''); // 模拟未知/不完整持有者
    const store = await createFileStore(opts({ root, lockTimeoutMs: 600 }));
    await assert.rejects(() => store.commit({
      operationId: 'op', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'x\n' }],
    }), (err) => err.code === 'LOCK_BUSY');
    // 空锁未被改动、未进入临界区
    assert.equal(await fsp.readFile(lockPath, 'utf8'), '');
  });

  it('持有者 pid 已死的陈旧锁：接管成功（跨进程语义）', async (t) => {
    const root = await makeTmpRoot(t);
    const dead = await makeDeadPid();
    const lockPath = path.join(root, '.shiori-lock');
    await fsp.writeFile(lockPath, JSON.stringify({ pid: dead, token: 'stale', acquiredAt: '2020-01-01' }));
    const store = await createFileStore(opts({ root }));
    const r = await store.commit({
      operationId: 'takeover', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'ok\n' }],
    });
    assert.equal(r.generation, 1);
    // 释放后锁文件已删除
    assert.equal(await fsp.access(lockPath).then(() => true, () => false), false);
  });

  it('临界区内抛错后锁被释放：下一次操作不受影响（异步生命周期）', async (t) => {
    const root = await makeTmpRoot(t);
    let boomOnce = false;
    const store = await createFileStore(opts({
      root,
      policy: (input) => {
        if (!boomOnce) {
          boomOnce = true;
          throw new Error('boom');
        }
        return stubEvaluateMutation(input);
      },
    }));
    await assert.rejects(() => store.commit({
      operationId: 'boom', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'x\n' }],
    }), /boom/);
    const r = await store.commit({
      operationId: 'next', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'y\n' }],
    });
    assert.equal(r.generation, 1);
  });

  it('withLock 同进程串行：第二个调用在第一个完成后执行（进程间互斥由 concurrency 覆盖）', async (t) => {
    const root = await makeTmpRoot(t, 'shiori-lockit-');
    const order = [];
    const first = withLock(root, { timeoutMs: 5000 }, async () => {
      order.push('first-start');
      await new Promise((r) => setTimeout(r, 120));
      order.push('first-end');
    });
    const second = withLock(root, { timeoutMs: 5000 }, async () => {
      order.push('second');
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  });
});

describe('R3 · 损坏 journal 保全与阻塞', () => {
  it('损坏 journal 的 staging 备份不被孤儿清理删除；写入被阻塞；人工移除后恢复', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'amber', 'seed\n');
    const store = await createFileStore(opts({ root }));
    const stageDir = path.join(root, 'staging', 'broken-op');
    await fsp.mkdir(stageDir, { recursive: true });
    await fsp.writeFile(path.join(stageDir, 'backup-0.bin'), 'backup-bytes');
    await fsp.writeFile(path.join(root, 'journal', 'broken-op.json'), '{corrupt json');

    const report = await store.recover();
    const blocked = report.operations.find((op) => op.action === 'blocked-corrupted-journal');
    assert.ok(blocked, 'recover 必须报告阻塞');
    assert.equal(blocked.stagingKept, true);
    // 备份证据仍在（R3 判据：不是 ENOENT）
    assert.equal(await fsp.readFile(path.join(stageDir, 'backup-0.bin'), 'utf8'), 'backup-bytes');
    assert.equal(report.healthy, false);

    // 状态不明确时不得无提示开放写入
    await assert.rejects(() => store.commit({
      operationId: 'blocked-write', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('seed\n')), text: 'x\n' }],
    }), (err) => err.code === 'INVALID_STATE');

    // 人工核验后移除损坏 journal → 恢复可写（孤儿 staging 一并清理）
    await fsp.rm(path.join(root, 'journal', 'broken-op.json'));
    const r = await store.commit({
      operationId: 'after-manual', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('seed\n')), text: 'x\n' }],
    });
    assert.equal(r.generation, 1);
    assert.equal(await fsp.access(stageDir).then(() => true, () => false), false);
  });
});

describe('R4 · 路径边界（factory 预检与 journal 路径校验）', () => {
  it('scopes/<active> 为越根 junction：createFileStore 拒绝，外部目录未改', async (t) => {
    const root = await makeTmpRoot(t);
    const outside = await fsp.mkdtemp(path.join(path.dirname(root), 'shiori-out-'));
    t.after(() => fsp.rm(outside, { recursive: true, force: true }).catch(() => {}));
    const scopeDir = path.join(root, 'scopes', 'amber');
    await fsp.mkdir(path.dirname(scopeDir), { recursive: true });
    await fsp.symlink(outside, scopeDir, 'junction');

    await assert.rejects(() => createFileStore(opts({ root })), (e) => e.code === 'INVALID_INPUT');
    assert.deepEqual(await fsp.readdir(outside), []);
  });

  for (const managed of ['journal', 'state', 'staging']) {
    it(`${managed} 目录为越根 junction：createFileStore 拒绝`, async (t) => {
      const root = await makeTmpRoot(t);
      const outside = await fsp.mkdtemp(path.join(path.dirname(root), 'shiori-out-'));
      t.after(() => fsp.rm(outside, { recursive: true, force: true }).catch(() => {}));
      const target = path.join(root, managed);
      await fsp.symlink(outside, target, 'junction');
      await assert.rejects(() => createFileStore(opts({ root })), (e) => e.code === 'INVALID_INPUT');
      assert.deepEqual(await fsp.readdir(outside), []);
    });
  }

  it('journal 引用根外路径：按不可校验事务阻塞，不执行、不清理证据', async (t) => {
    const root = await makeTmpRoot(t);
    const outside = await fsp.mkdtemp(path.join(path.dirname(root), 'shiori-out-'));
    t.after(() => fsp.rm(outside, { recursive: true, force: true }).catch(() => {}));
    await putCore(root, 'amber', 'seed\n');
    const store = await createFileStore(opts({ root })); // 先建目录，再植入恶意 journal
    const evilTarget = path.join(outside, 'evil.md');
    const journal = {
      version: 1, operationId: 'evil-op', scopeId: 'amber',
      payloadHash: '0'.repeat(64), phase: 'prepared',
      generationBefore: 0, generationAfter: 1,
      changes: [{
        index: 0, kind: 'topic', key: 'evil', file: evilTarget,
        stagingFile: path.join(outside, 'after-0.bin'),
        backupFile: path.join(outside, 'backup-0.bin'),
        beforeRevision: null, afterRevision: sha256(Buffer.from('evil')),
      }],
    };
    await fsp.writeFile(path.join(root, 'journal', 'evil-op.json'), JSON.stringify(journal));

    const report = await store.recover();
    assert.ok(report.operations.some((op) => op.action === 'blocked-invalid-journal'));
    await assert.rejects(() => store.commit({
      operationId: 'any', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('seed\n')), text: 'x\n' }],
    }), (err) => err.code === 'INVALID_STATE');
    assert.equal(await fsp.access(evilTarget).then(() => true, () => false), false, '根外文件未被创建');
  });

  it('scopes/Amber 与既有 scopes/amber 大小写互斥：factory 拒绝', async (t) => {
    const root = await makeTmpRoot(t);
    const storeA = await createFileStore(opts({ root, activeScopeId: 'amber' }));
    await storeA.commit({
      operationId: 'seed', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'k', expectedRevision: null, topic: topicObject() }],
    });
    await assert.rejects(() => createFileStore(opts({ root, activeScopeId: 'Amber' })),
      (e) => e.code === 'INVALID_INPUT');
  });
});

describe('R5/R6 · 无损编码边界', () => {
  it('core 写入孤立代理码元被拒绝；成对非 BMP（emoji）正常往返', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.commit({
      operationId: 'lone', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'a\uD800b' }],
    }), (err) => err.code === 'INVALID_INPUT');
    await store.commit({
      operationId: 'emoji', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'a🔥b\n' }],
    });
    assert.equal((await store.readCore()).text, 'a🔥b\n');
  });

  it('topic body 孤立代理码元被拒绝', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.commit({
      operationId: 'lone-body', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'k', expectedRevision: null, topic: topicObject({ body: 'x\uDC00' }) }],
    }), (err) => err.code === 'INVALID_INPUT');
  });

  it('磁盘 core 非法 UTF-8（61 C3 28）：读显式 INVALID_STATE，文件不动', async (t) => {
    const root = await makeTmpRoot(t);
    const coreFile = path.join(root, 'scopes', 'amber', 'core.md');
    await fsp.mkdir(path.dirname(coreFile), { recursive: true });
    const bad = Buffer.from([0x61, 0xc3, 0x28]);
    await fsp.writeFile(coreFile, bad);
    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.readCore(), (err) => err.code === 'INVALID_STATE');
    assert.deepEqual(await fsp.readFile(coreFile), bad); // 不自动改写损坏文件
  });

  it('磁盘 topic 非法 UTF-8：readTopic 显式 INVALID_STATE', async (t) => {
    const root = await makeTmpRoot(t);
    const f = path.join(root, 'scopes', 'amber', 'topics', 'broken.md');
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, Buffer.from([0x61, 0xc3, 0x28]));
    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.readTopic('broken'), (err) => err.code === 'INVALID_STATE');
  });
});

describe('R7/R9 · 空 summary 与 key 对齐', () => {
  it('空 summary 提交后可读回，列表可见', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await store.commit({
      operationId: 'empty-summary', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'k', expectedRevision: null, topic: topicObject({ summary: '' }) }],
    });
    const topic = await store.readTopic('k');
    assert.equal(topic.summary, '');
    assert.deepEqual((await store.listTopics()).map((x) => x.key), ['k']);
  });

  it('A 合法的 Unicode key（中文专题）可提交落盘', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await store.commit({
      operationId: 'cn-key', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: '中文专题', expectedRevision: null, topic: topicObject() }],
    });
    assert.equal((await store.readTopic('中文专题')).key, '中文专题');
    assert.ok((await fsp.readdir(path.join(root, 'scopes', 'amber', 'topics'))).includes('中文专题.md'));
  });

  it('summary 含换行被拒绝（与 A.validateTopic 一致）', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    await assert.rejects(() => store.commit({
      operationId: 'nl-summary', expectedGeneration: 0,
      changes: [{ kind: 'topic', key: 'k', expectedRevision: null, topic: topicObject({ summary: 'a\nb' }) }],
    }), (err) => err.code === 'INVALID_INPUT');
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const LOCKFILE_URL = new URL('../../src/storage/lockfile.mjs', import.meta.url).href;

describe('J1 · 合法 JSON 的坏 shape journal（不得静默遗漏）', () => {
  it('琥珀原样用例：无 operationId 的 committing journal → staging 保留 + 写入阻塞 + 人工移除后恢复', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'amber', 'seed\n');
    const store = await createFileStore(opts({ root }));
    const stageDir = path.join(root, 'staging', 'shape-broken');
    await fsp.mkdir(stageDir, { recursive: true });
    await fsp.writeFile(path.join(stageDir, 'backup-0.bin'), 'ONLY RECOVERY COPY');
    await fsp.writeFile(path.join(root, 'journal', 'shape-broken.json'),
      JSON.stringify({ phase: 'committing', changes: [] }));

    const report = await store.recover();
    const blocked = report.operations.find((op) => op.action === 'blocked-corrupted-journal');
    assert.ok(blocked, 'recover 必须报告 blocked');
    assert.ok(String(blocked.reason).includes('operationId'));
    assert.equal(blocked.stagingKept, true);
    // 唯一恢复副本未被孤儿清理删除（J1 判据：不是 ENOENT）
    assert.equal(await fsp.readFile(path.join(stageDir, 'backup-0.bin'), 'utf8'), 'ONLY RECOVERY COPY');
    assert.equal(report.healthy, false);

    await assert.rejects(() => store.commit({
      operationId: 'later', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'later' }],
    }), (err) => err.code === 'INVALID_STATE');

    await fsp.rm(path.join(root, 'journal', 'shape-broken.json'));
    const r = await store.commit({
      operationId: 'later', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('seed\n')), text: 'later' }],
    });
    assert.equal(r.generation, 1);
  });

  it('形状损坏变体全部 blocked：{} / null / [] / 缺字段 / 错 phase / stem 不一致', async (t) => {
    const root = await makeTmpRoot(t);
    const store = await createFileStore(opts({ root }));
    const variants = [
      ['empty-object', '{}'],
      ['null-record', 'null'],
      ['array-record', '[]'],
      ['missing-opid', JSON.stringify({ phase: 'prepared', scopeId: 'amber', payloadHash: 'a', generationBefore: 0, generationAfter: 1, changes: [] })],
      ['bad-phase', JSON.stringify({ operationId: 'bad-phase', scopeId: 'amber', payloadHash: 'a', phase: 'flying', generationBefore: 0, generationAfter: 1, changes: [] })],
      ['bad-gen', JSON.stringify({ operationId: 'bad-gen', scopeId: 'amber', payloadHash: 'a', phase: 'prepared', generationBefore: 'x', generationAfter: 1, changes: [] })],
      ['missing-changes', JSON.stringify({ operationId: 'missing-changes', scopeId: 'amber', payloadHash: 'a', phase: 'prepared', generationBefore: 0, generationAfter: 1 })],
      ['stem-mismatch', JSON.stringify({ operationId: 'another-name', scopeId: 'amber', payloadHash: 'a', phase: 'prepared', generationBefore: 0, generationAfter: 1, changes: [] })],
    ];
    for (const [stem, content] of variants) {
      // eslint-disable-next-line no-await-in-loop
      await fsp.writeFile(path.join(root, 'journal', `${stem}.json`), content);
    }
    const report = await store.recover();
    const blocked = report.operations.filter((op) => String(op.action).startsWith('blocked-'));
    assert.equal(blocked.length, variants.length);
    assert.equal(report.healthy, false);
    await assert.rejects(() => store.commit({
      operationId: 'any', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'x\n' }],
    }), (err) => err.code === 'INVALID_STATE');
  });
});

describe('K2 · 同 PID 活锁不可接管（发布/登记生命周期）', () => {
  it('门控序列：A 建锁后 readdir 快照挂起，B 读同 PID 锁必须 LOCK_BUSY，无双重持锁', async (t) => {
    const root = await makeTmpRoot(t, 'shiori-k2-');
    const lockPath = path.join(root, '.shiori-lock');
    const a = await import(`${LOCKFILE_URL}?k2-a`);
    const b = await import(`${LOCKFILE_URL}?k2-b`);

    // 门控：挂起 A 的第一次 readdir 返回（拿到真实快照后、交还 A 前暂停），
    // 复刻琥珀 K2 的"目录快照已读出但尚未生效"窗口
    const parked = deferred(); const releaseSnap = deferred();
    let gated = false;
    const originalReaddir = fsp.readdir;
    fsp.readdir = async function gatedReaddir(dir, options) {
      const names = await originalReaddir.call(this, dir, options);
      if (!gated && dir === root) {
        gated = true;
        parked.resolve();
        await releaseSnap.promise;
      }
      return names;
    };

    let overlap = false; let inB = false;
    let holding; let bAttempt;
    try {
      holding = a.withLock(root, { timeoutMs: 8000 }, async () => {
        // A 进入临界区：此时 B 的尝试必须已被拒绝
        overlap = inB;
      });
      await parked.promise; // A 已发布锁并读出无标记快照，尚未复查完

      // B 读到 A 的同 PID 锁：token 是否登记不可作为陈旧证据（K2），必须等待
      bAttempt = b.withLock(root, { timeoutMs: 700, retryMs: 10 }, async () => {
        inB = true;
      });
      await assert.rejects(() => bAttempt, (err) => err.code === 'LOCK_BUSY');
      assert.equal(inB, false, 'B 不得进入临界区');

      releaseSnap.resolve(); // 放行 A 的旧快照：A 复查（可能误见标记？标记不存在）→ 进入
      await holding;
      assert.equal(overlap, false, '两个持有者不得同时进入临界区');
      // A 释放后锁位清空
      assert.equal(await fsp.access(lockPath).then(() => true, () => false), false);
    } finally {
      parked.resolve();
      releaseSnap.resolve();
      if (holding) await holding.catch(() => {});
      if (bAttempt) await bAttempt.catch(() => {});
      fsp.readdir = originalReaddir;
    }
  });

  it('同进程另一实例正持锁：等待不接管，锁文件不动，释放后可正常获取', async (t) => {
    const root = await makeTmpRoot(t, 'shiori-k1b-');
    const lockPath = path.join(root, '.shiori-lock');
    const a = await import(`${LOCKFILE_URL}?k1b-a`);
    const b = await import(`${LOCKFILE_URL}?k1b-b`);
    const releaseA = deferred();
    const holding = a.withLock(root, { timeoutMs: 5000 }, async () => {
      await releaseA.promise;
    });
    assert.ok(await waitForFile(lockPath), '实例 A 未进入临界区');
    const aToken = JSON.parse(await fsp.readFile(lockPath, 'utf8')).token;

    await assert.rejects(() => b.withLock(root, { timeoutMs: 700, retryMs: 10 }, async () => {
      assert.fail('实例 B 不应进入临界区');
    }), (err) => err.code === 'LOCK_BUSY');

    // A 的锁文件未被挪动/替换
    assert.equal(JSON.parse(await fsp.readFile(lockPath, 'utf8')).token, aToken);
    releaseA.resolve();
    await holding;
    // 释放后其他实例可正常获取
    const r = await b.withLock(root, { timeoutMs: 5000 }, async () => 'entered');
    assert.equal(r, 'entered');
  });

  it('死 pid 残留锁并发接管竞速：恰好一个成功，无双重持锁', async (t) => {
    const root = await makeTmpRoot(t, 'shiori-k1c-');
    const dead = await makeDeadPid();
    const lockPath = path.join(root, '.shiori-lock');
    await fsp.writeFile(lockPath, JSON.stringify({ pid: dead, token: 'from-crashed', acquiredAt: '2020-01-01' }));

    const dir = await fsp.mkdtemp(path.join(path.dirname(root), 'shiori-lr-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
    const barrier = path.join(dir, 'go');
    const readies = [path.join(dir, 'ready-1'), path.join(dir, 'ready-2')];
    const results = [path.join(dir, 'result-1.json'), path.join(dir, 'result-2.json')];
    const p1 = spawnNode('lock-racer.mjs', ['--root', root, '--name', 'one', '--barrier', barrier,
      '--ready', readies[0], '--result', results[0], '--timeout', '8000']);
    const p2 = spawnNode('lock-racer.mjs', ['--root', root, '--name', 'two', '--barrier', barrier,
      '--ready', readies[1], '--result', results[1], '--timeout', '8000']);
    assert.ok(await waitForFile(readies[0]), 'racer1 未就绪');
    assert.ok(await waitForFile(readies[1]), 'racer2 未就绪');
    await fsp.writeFile(barrier, 'go');
    const [e1, e2] = await Promise.all([p1.promise, p2.promise]);
    assert.equal(e1.code, 0, `racer1 异常: ${e1.stderr}`);
    assert.equal(e2.code, 0, `racer2 异常: ${e2.stderr}`);

    const r1 = await readJson(results[0]);
    const r2 = await readJson(results[1]);
    // 两个 racer 都允许最终成功（先后获取），但临界区时间区间不得重叠
    const ok = [r1, r2].filter((r) => r.ok);
    assert.equal(ok.length, 2, `两进程最终都应获取成功: ${JSON.stringify([r1, r2])}`);
    const [first, second] = r1.enterAt <= r2.enterAt ? [r1, r2] : [r2, r1];
    assert.ok(second.enterAt >= first.leaveAt,
      `临界区重叠: ${JSON.stringify([r1, r2])}`);
    // 持有者标记与进入顺序一致
    assert.equal(await fsp.readFile(`${results[0]}.holder`, 'utf8'), r1.ok ? 'one' : 'two');
    assert.equal(await fsp.readFile(`${results[1]}.holder`, 'utf8'), r2.ok ? 'two' : 'one');
    // 接管完成后死锁残留已被清理、锁位释放
    assert.equal(await fsp.access(lockPath).then(() => true, () => false), false);
  });

  it('移动标记残留：fail-closed 等待至 LOCK_BUSY，标记不被清动', async (t) => {
    const root = await makeTmpRoot(t, 'shiori-k1d-');
    const marker = path.join(root, '.shiori-lock.moving-leftover');
    await fsp.writeFile(marker, '{"pid":1,"token":"x"}');
    const store = await createFileStore(opts({ root, lockTimeoutMs: 600 }));
    await assert.rejects(() => store.commit({
      operationId: 'op', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'x\n' }],
    }), (err) => err.code === 'LOCK_BUSY');
    assert.ok(await fsp.access(marker).then(() => true, () => false), '标记残留应保留待人工处理');
  });
});
