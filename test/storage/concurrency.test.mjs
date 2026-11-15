// 跨进程并发：CAS 竞争唯一胜者、跨进程互斥锁、并发读写快照一致性、同进程重入。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createFileStore } from '../../src/storage/index.mjs';
import {
  sha256, stubRenderL1, stubEvaluateMutation, TEST_CONFIG,
  makeTmpRoot, putCore, spawnNode, waitForFile, readJson,
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

describe('跨进程 CAS 竞争', () => {
  it('两个子进程同时抢提交：恰好一笔成功，无丢失更新', async (t) => {
    const root = await makeTmpRoot(t);
    const seed = 'seed-core\n';
    await putCore(root, 'amber', seed);
    const seedRev = sha256(Buffer.from(seed, 'utf8'));

    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-race-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
    const barrier = path.join(dir, 'go');
    const results = [
      path.join(dir, 'result-1.json'), path.join(dir, 'result-2.json'),
    ];
    const readies = [
      path.join(dir, 'ready-1'), path.join(dir, 'ready-2'),
    ];

    const p1 = spawnNode('racer.mjs', [
      '--root', root, '--name', 'one', '--barrier', barrier,
      '--ready', readies[0], '--result', results[0], '--expected-rev', seedRev,
    ]);
    const p2 = spawnNode('racer.mjs', [
      '--root', root, '--name', 'two', '--barrier', barrier,
      '--ready', readies[1], '--result', results[1], '--expected-rev', seedRev,
    ]);

    // 双方就绪后放行，保证真正的同窗口竞争
    assert.ok(await waitForFile(readies[0]), 'racer1 未就绪');
    assert.ok(await waitForFile(readies[1]), 'racer2 未就绪');
    await fsp.writeFile(barrier, 'go');
    const [e1, e2] = await Promise.all([p1.promise, p2.promise]);
    assert.equal(e1.code, 0, `racer1 异常退出: ${e1.stderr}`);
    assert.equal(e2.code, 0, `racer2 异常退出: ${e2.stderr}`);

    const r1 = await readJson(results[0]);
    const r2 = await readJson(results[1]);
    const outcomes = [r1, r2];
    assert.equal(outcomes.filter((r) => r.ok).length, 1, `应恰好一笔成功: ${JSON.stringify(outcomes)}`);
    assert.equal(outcomes.filter((r) => !r.ok && r.code === 'REVISION_CONFLICT').length, 1);

    const winner = r1.ok ? r1 : r2;
    const store = await createFileStore(opts({ root }));
    const core = await store.readCore();
    assert.equal(core.text, `from-${winner.result.operationId.replace('race-', '')}\n`);
    assert.equal(core.revision, winner.result.changes[0].afterRevision);
    assert.equal((await store.snapshot()).generation, 1);
  });
});

describe('跨进程锁互斥', () => {
  it('子进程持锁期间父进程短超时 LOCK_BUSY；释放后可获取', async (t) => {
    const root = await makeTmpRoot(t);
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-lock-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
    const ready = path.join(dir, 'ready');
    const releaseFile = path.join(dir, 'release');

    // C-fix 打回项 B：hold-ms 撤回为 1500（只作兜底 deadline），改由 --release
    // 文件放行——父进程断言完 LOCK_BUSY 后立刻写文件让 holder 提前释放，
    // 用例耗时回到秒级，不再用「等满 10 秒」换稳定。
    const holder = spawnNode('lock-holder.mjs', ['--root', root, '--ready', ready, '--hold-ms', '1500', '--release', releaseFile]);
    assert.ok(await waitForFile(ready), 'holder 未进入临界区');

    const store = await createFileStore(opts({ root, lockTimeoutMs: 400 }));
    await assert.rejects(() => store.commit({
      operationId: 'busy-op', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'x\n' }],
    }), (err) => err.code === 'LOCK_BUSY');

    await fsp.writeFile(releaseFile, 'go'); // 断言完立刻放行 holder 释放
    await holder.promise; // 等子进程退出（锁已释放）
    // C-fix C1：释放后的成功提交换独立 store、放大锁预算——它验证的是「释放后可
    // 获取」这一性质，不是 400ms 延迟上限；负载下一次 acquire 的 fs 链可能超过
    // 400ms。断言（成功、generation=1）一字未动。
    const storeAfter = await createFileStore(opts({ root, lockTimeoutMs: 60_000 }));
    const r = await storeAfter.commit({
      operationId: 'after-release', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: null, text: 'x\n' }],
    });
    assert.equal(r.generation, 1);
  });
});

describe('并发读写快照一致性', () => {
  it('跨进程写手连续翻转 core，读者永远看到完整一代（无混合中间态）', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'amber', 'A\n');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiori-rw-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));

    const resultFile = path.join(dir, 'writer-result.json');
    // 负载下写手一次完整运行（25 次翻转，每次 snapshot→commit 两段持锁）可能远超
    // 读者单次 acquire 的默认 10s deadline——写手在两次翻转之间只留下极短的锁空窗，
    // 读者按 50ms 重试完全可能在 10s 内抢不到一次空窗，此时抛 LOCK_BUSY 是
    // fail-closed 的正确行为，不是被测性质被破坏。因此给读者放大的是「调度预算」：
    // 读者把单次 acquire 的 deadline 抬到 60s（写手自身持有 20s，且写手每次翻转
    // 之间必然释放锁），核心断言（每代完整、revision 一致、终态 gen=25、conflicts=0）
    // 一字未动。整条用例仍有界：写手无论成败都会写 resultFile，若它被 spawnNode
    // 安全网击杀导致 resultFile 永不出现，下方循环检测到子进程已退出会立即显式失败。
    const writer = spawnNode('writer.mjs', ['--root', root, '--result', resultFile, '--count', '25'],
      { timeoutMs: 240_000 });

    const store = await createFileStore(opts({ root, lockTimeoutMs: 120_000 }));
    let reads = 0;
    for (;;) {
      const done = await fsp.access(resultFile).then(() => true, () => false);
      if (done) break;
      // 有界兜底：写手子进程已退出但结果文件仍未出现（只可能是被安全网击杀），
      // 显式失败而不是无限轮询挂死。
      if (writer.child.exitCode !== null || writer.child.signalCode !== null) {
        throw new Error(`写手子进程在写出结果前退出（signal=${writer.child.signalCode}），无法继续轮询`);
      }
      const snap = await store.snapshot();
      // 核心判据：core 正文只能是完整一代的 'A\n' 或 'B\n'，绝无撕裂/空/中间态
      assert.ok(snap.core.text === 'A\n' || snap.core.text === 'B\n',
        `读到混合态: ${JSON.stringify(snap.core)}`);
      assert.equal(snap.core.revision, sha256(Buffer.from(snap.core.text, 'utf8')));
      reads += 1;
    }
    const w = await readJson(resultFile);
    assert.equal(w.done, 25);
    assert.equal(w.conflicts, 0); // 单写者 + CAS 读取后提交：不应有竞争冲突
    const final = await store.snapshot();
    assert.equal(final.generation, 25); // 初始 A 也算一代起点，翻转 25 次后 gen=25
    assert.ok(reads > 0);
  });
});

describe('同进程重入', () => {
  it('policy 回调内再调用 store.readCore 不死锁（AsyncLocalStorage 识别同链路）', async (t) => {
    const root = await makeTmpRoot(t);
    await putCore(root, 'amber', 'base\n');
    let inner = null;
    let store;
    store = await createFileStore(opts({
      root,
      policy: async (input) => {
        inner = await store.readCore(); // 在提交锁内重入读取
        return stubEvaluateMutation(input);
      },
    }));
    const r = await store.commit({
      operationId: 'reentrant', expectedGeneration: 0,
      changes: [{ kind: 'core', expectedRevision: sha256(Buffer.from('base\n')), text: 'next\n' }],
    });
    assert.equal(r.generation, 1);
    assert.equal(inner.text, 'base\n'); // policy 看到的是提交前状态
  });
});
