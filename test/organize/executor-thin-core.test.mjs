// P3 thin-core 执行补完（F6 ②，主审 q-b40eda3bfee42fa0 拍板 A：内容判定重放）：
// 成功替换 L1 core、before 不匹配拒写、同 operationId 重放幂等零写、
// 写前备份（stateRoot 提供 / 缺失 / 落盘失败 fail-closed）、bind 跳过显式记录。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createOrganizerExecutor, digestPlan } from '../../src/organize/executor.mjs';
import { createShioriService } from '../../src/service/index.mjs';

const sha = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const grantAll = () => async () => true;

async function makeDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  });
  return dir;
}

/** 派生 tc 子 operationId（与 executor.mjs deriveStageOperationId 同算法独立实现）。 */
const tcIdOf = (scopeId, operationId) => {
  const h = createHash('sha256')
    .update(JSON.stringify([scopeId, operationId, 'tc']))
    .digest('hex')
    .slice(0, 40);
  return `tc-${h}`;
};

async function seedCore(service, text) {
  return service.mutate({
    operationId: `seed-core-${createHash('sha256').update(text).digest('hex').slice(0, 8)}`,
    changes: [{ kind: 'core', expectedRevision: null, text }],
  });
}

function makePlan(scopeId, before, after) {
  return {
    version: 1,
    scopeId,
    candidateId: 'c'.repeat(64),
    kind: 'thin-core',
    sources: [{ id: 'card-a', revision: 1 }],
    core: { before, after },
  };
}

const round = (plan, operationId) => ({
  plan,
  approval: { actor: 'main-session', planDigest: digestPlan(plan) },
  operationId,
});

async function readCoreText(root, scopeId = 'amber') {
  return fsp.readFile(path.join(root, 'scopes', scopeId, 'core.md'), 'utf8');
}

// ---------------------------------------------------------------------------

describe('P3 thin-core 执行', () => {
  it('成功替换：core 变为 after、回执含 before/after revision 与 generation、备份落盘', async (t) => {
    const root = await makeDir(t, 'shiori-thin-data-');
    const stateRoot = await makeDir(t, 'shiori-thin-state-');
    const service = await createShioriService({ root, activeScopeId: 'amber' });
    await seedCore(service, '旧核心正文');

    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber', authorize: grantAll(), stateRoot,
    });
    const plan = makePlan('amber', '旧核心正文', '新核心正文');
    const result = await exec.executeRound(round(plan, 'round-t1'));
    exec.close();

    assert.equal(result.status, 'completed');
    assert.equal(result.kind, 'thin-core');
    assert.equal(result.changedItems, 1);
    assert.equal(result.replayed, undefined, '首跑不带 replayed 标记');
    assert.equal(result.core.beforeRevision, sha('旧核心正文'));
    assert.equal(result.core.afterRevision, sha('新核心正文'));
    assert.equal(result.core.operationId, tcIdOf('amber', 'round-t1'));
    assert.ok(Number.isInteger(result.core.generation), '回执带 generation');
    assert.equal(await readCoreText(root), '新核心正文', 'L1 core 已替换');

    // 备份：旧正文逐字节落 <stateRoot>/core-backups/<tc-id>.md
    const backupPath = path.join(stateRoot, 'core-backups', `${tcIdOf('amber', 'round-t1')}.md`);
    const backup = await fsp.readFile(backupPath, 'utf8');
    assert.equal(backup, '旧核心正文');
    assert.equal(result.backup.skipped, false);
    assert.equal(result.backup.path, backupPath);
    assert.equal(result.backup.bytes, Buffer.byteLength('旧核心正文', 'utf8'));
  });

  it('回执显式记录 bind 跳过（thin-core 不动卡，不静默）', async (t) => {
    const root = await makeDir(t, 'shiori-thin-data-');
    const service = await createShioriService({ root, activeScopeId: 'amber' });
    await seedCore(service, '旧');
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const result = await exec.executeRound(round(makePlan('amber', '旧', '新'), 'round-bind'));
    exec.close();
    assert.deepEqual(result.binding, {
      skipped: true,
      reason: 'bindOrganizeRound rejects thin-core plans and thin-core touches no spark cards',
    });
  });

  it('before 不匹配拒写：REVISION_CONFLICT、core 不变、不建备份', async (t) => {
    const root = await makeDir(t, 'shiori-thin-data-');
    const stateRoot = await makeDir(t, 'shiori-thin-state-');
    const service = await createShioriService({ root, activeScopeId: 'amber' });
    await seedCore(service, '外部已改的正文');

    let calls = 0;
    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber', authorize: async () => { calls += 1; return true; }, stateRoot,
    });
    const plan = makePlan('amber', '旧核心正文', '新核心正文');
    await assert.rejects(
      exec.executeRound(round(plan, 'round-stale')),
      (e) => e.code === 'REVISION_CONFLICT' && e.details?.phase === 'core-precheck' && e.details?.coreCommitted === false,
    );
    exec.close();

    assert.equal(await readCoreText(root), '外部已改的正文', 'core 未被改写');
    assert.equal(calls, 1, '冲突发生在授权判定之后（照 link/merge 主流程）');
    await assert.rejects(
      fsp.stat(path.join(stateRoot, 'core-backups')),
      { code: 'ENOENT' },
      '拒写路径不建备份目录',
    );
  });

  it('同 operationId 重放：零写、返回首次回执语义（replayed）', async (t) => {
    const root = await makeDir(t, 'shiori-thin-data-');
    const stateRoot = await makeDir(t, 'shiori-thin-state-');
    const service = await createShioriService({ root, activeScopeId: 'amber' });
    await seedCore(service, '旧核心正文');

    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber', authorize: grantAll(), stateRoot,
    });
    const plan = makePlan('amber', '旧核心正文', '新核心正文');
    const first = await exec.executeRound(round(plan, 'round-replay'));

    const replay = await exec.executeRound({
      plan,
      approval: { actor: 'main-session', planDigest: digestPlan(plan) },
      operationId: 'round-replay',
    });

    assert.equal(replay.status, 'completed');
    assert.equal(replay.replayed, true, '重放显式标记');
    assert.equal(replay.changedItems, 1);
    assert.equal(replay.core.afterRevision, first.core.afterRevision);
    assert.equal(replay.core.operationId, first.core.operationId);
    assert.equal(await readCoreText(root), '新核心正文', '重放零写：正文不变');
    assert.equal(replay.backup, null, '重放不重复备份');

    // 重启重放：关闭重开执行器后同 round 依旧幂等（内容判定不依赖内存态）
    exec.close();
    const exec2 = await createOrganizerExecutor({
      root, scopeId: 'amber', authorize: grantAll(), stateRoot,
    });
    const replay2 = await exec2.executeRound(round(plan, 'round-replay'));
    exec2.close();
    assert.equal(replay2.replayed, true);
    assert.equal(await readCoreText(root), '新核心正文');
    const backupFiles = await fsp.readdir(path.join(stateRoot, 'core-backups'));
    assert.deepEqual(backupFiles, [`${tcIdOf('amber', 'round-replay')}.md`], '重放不新增备份文件');
    const gen = JSON.parse(await fsp.readFile(path.join(root, 'state', 'current.json'), 'utf8')).generation;
    assert.equal(gen, first.core.generation, '重放零写：generation 未前进');
  });

  it('stateRoot 缺失：备份跳过但回执如实标注（不静默），core 照常替换', async (t) => {
    const root = await makeDir(t, 'shiori-thin-data-');
    const service = await createShioriService({ root, activeScopeId: 'amber' });
    await seedCore(service, '旧核心正文');

    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const result = await exec.executeRound(round(makePlan('amber', '旧核心正文', '新核心正文'), 'round-nostate'));
    exec.close();

    assert.deepEqual(result.backup, { skipped: true, reason: 'stateRoot not provided by caller' });
    assert.equal(await readCoreText(root), '新核心正文');
  });

  it('stateRoot 非绝对路径 → 创建即拒绝', async (t) => {
    const root = await makeDir(t, 'shiori-thin-data-');
    await assert.rejects(
      createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll(), stateRoot: 'relative/path' }),
      (e) => e.code === 'INVALID_INPUT' && String(e.message).includes('stateRoot'),
    );
  });

  it('备份落盘失败 fail-closed：抛错中止、core 不写', async (t) => {
    const root = await makeDir(t, 'shiori-thin-data-');
    const stateRoot = await makeDir(t, 'shiori-thin-state-');
    const service = await createShioriService({ root, activeScopeId: 'amber' });
    await seedCore(service, '旧核心正文');
    // 占位：core-backups 位置被文件占用 → mkdir 必失败
    await fsp.writeFile(path.join(stateRoot, 'core-backups'), 'not a dir', 'utf8');

    const exec = await createOrganizerExecutor({
      root, scopeId: 'amber', authorize: grantAll(), stateRoot,
    });
    await assert.rejects(
      exec.executeRound(round(makePlan('amber', '旧核心正文', '新核心正文'), 'round-bkfail')),
      (e) => e.code === 'INVALID_STATE' && e.details?.phase === 'core-backup' && e.details?.coreCommitted === false,
    );
    exec.close();

    assert.equal(await readCoreText(root), '旧核心正文', '备份失败时 core 未写');
  });

  it('授权照 link/merge：actor 白名单 + planDigest 绑定，不匹配零写', async (t) => {
    const root = await makeDir(t, 'shiori-thin-data-');
    const service = await createShioriService({ root, activeScopeId: 'amber' });
    await seedCore(service, '旧核心正文');
    const exec = await createOrganizerExecutor({ root, scopeId: 'amber', authorize: grantAll() });
    const plan = makePlan('amber', '旧核心正文', '新核心正文');

    await assert.rejects(
      exec.executeRound({ plan, approval: { actor: 'main-session', planDigest: 'deadbeef' }, operationId: 'round-auth' }),
      (e) => e.code === 'APPROVAL_REQUIRED',
    );
    await assert.rejects(
      exec.executeRound({ plan, approval: { actor: 'background-daemon', planDigest: digestPlan(plan) }, operationId: 'round-auth' }),
      (e) => e.code === 'APPROVAL_REQUIRED',
    );
    exec.close();

    assert.equal(await readCoreText(root), '旧核心正文', '授权失败零写');
  });
});
