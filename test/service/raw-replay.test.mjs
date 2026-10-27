import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createShioriService } from '../../src/service/index.mjs';

for (const rawKind of ['null', 'sha256']) {
  test(`raw ${rawKind} CAS retries remain idempotent after restart and later writes`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-raw-replay-'));
    t.after(async () => {
      assert.equal(path.dirname(root), os.tmpdir());
      assert.ok(path.basename(root).startsWith('shiori-raw-replay-'));
      await fs.rm(root, { recursive: true, force: true });
    });
    const options = { root, activeScopeId: 'amber' };
    const service = await createShioriService(options);
    let revision = null;
    if (rawKind === 'sha256') {
      const seed = await service.mutate({ operationId: 'seed', changes: [
        { kind: 'core', expectedRevision: null, text: 'seed body' },
      ] });
      revision = seed.changes[0].afterRevision;
      assert.match(revision, /^[a-f0-9]{64}$/);
    }
    const request = { operationId: 'stable-raw-retry', changes: [
      { kind: 'core', expectedRevision: revision, text: 'first body' },
    ] };
    const first = await service.mutate(request);
    const restarted = await createShioriService(options);
    assert.deepEqual(await restarted.mutate(request), first);
    const current = await restarted.readCore();
    const later = await restarted.mutate({ operationId: 'later-write', changes: [
      { kind: 'core', expectedRevision: current.revision, text: 'later body' },
    ] });
    assert.deepEqual(await restarted.mutate(request), first);
    assert.equal((await restarted.readCore()).text, 'later body');
    assert.equal(later.generation, first.generation + 1);
    await assert.rejects(restarted.mutate({ ...request, changes: [
      { ...request.changes[0], text: 'different payload' },
    ] }), { code: 'REVISION_CONFLICT' });
  });
}
