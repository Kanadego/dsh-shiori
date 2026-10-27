import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileStore } from '../../src/storage/index.mjs';
import { createShioriService } from '../../src/service/index.mjs';
import { renderL1, evaluateMutation, validateConfig } from '../../src/core/index.mjs';
import { createHostBridge, SECTION_CORE } from '../../src/host/index.mjs';
import { createFakeHost, ACTIVE_CONFIG } from '../host/helpers.mjs';

async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-e2e-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('shiori-e2e-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  const cfg = validateConfig(config);
  const global = await createFileStore({root, activeScopeId:'global', config:cfg, renderL1, policy:evaluateMutation});
  await global.commit({operationId:'seed', expectedGeneration:0, changes:[
    {kind:'core', expectedRevision:null, text:'global core'},
    {kind:'topic', key:'shared', expectedRevision:null, topic:{title:'Shared',summary:'共同约定',updated:'2026-10-24',body:'global topic'}},
  ]});
  const service = await createShioriService({root, activeScopeId:'amber', config});
  const host = createFakeHost({asyncSectionText:false});
  const bridge = createHostBridge({host,service,mode:'active',config:ACTIVE_CONFIG});
  t.after(() => bridge.stop());
  await bridge.start();
  const call = (name,args={}) => host.tools.get(name).execute(args);
  return {root,global,service,host,bridge,call};
}

test('real A/B/service/C: global topic copy-on-write reports active scope and survives restart', async t => {
  const {root,global,service,host,call} = await fixture(t);
  const receipt = await call('memory_append',{topic:'shared',section:'补充',content:'active-only'});
  assert.equal(receipt.scope,'amber');
  assert.equal(receipt.projection,'written-pending-projection');
  const topic = await service.readTopic('shared');
  assert.equal(topic.scopeId,'amber');
  assert.match(topic.body,/global topic/); assert.match(topic.body,/active-only/);
  assert.equal((await global.readTopic('shared')).body,'global topic');
  assert.ok((await host.renderSection(SECTION_CORE)).includes('shared [amber]'));
  const restarted = await createShioriService({root,activeScopeId:'amber'});
  assert.equal((await restarted.readTopic('shared')).body,topic.body);
  await call('memory_append',{section:'核心补充',content:'active core'});
  const diskCore = await fs.readFile(path.join(root,'scopes','amber','core.md'),'utf8');
  assert.match(diskCore,/global core/); assert.match(diskCore,/active core/);
  assert.ok(!diskCore.includes('Topic memory index'));
  assert.match(await host.renderSection(SECTION_CORE),/active core/);
});

test('real A full rendered index consumes budget and rejection leaves disk unchanged',async t => {
  const {root,service,call} = await fixture(t,{core:{targetChars:160,hardCapChars:200}});
  const before = await service.readCoreView();
  const candidate = 'x'.repeat(190);
  await assert.rejects(call('core_write',{content:candidate,expectedRevision:before.revision,operationId:'too-large'}),{code:'BUDGET_REJECTED'});
  assert.equal((await service.readCore()).text,'global core');
  await assert.rejects(fs.stat(path.join(root,'scopes','amber','core.md')),{code:'ENOENT'});
});

test('view revision includes topic generation and forbids stale core write',async t => {
  const {service,call} = await fixture(t);
  const stale = await service.readCoreView();
  await call('topic_append',{topic:'shared',section:'变化',content:'new fact'});
  await assert.rejects(call('core_write',{content:'replacement',expectedRevision:stale.revision,operationId:'stale-index'}),{code:'REVISION_CONFLICT'});
  assert.equal((await service.readCore()).text,'global core');
});

test('shadow bridge with real service adds no tools/sections and makes no data mutation',async t => {
  const {service} = await fixture(t);
  const before = await service.readCoreView();
  const host = createFakeHost();
  const shadow = createHostBridge({host,service}); t.after(() => shadow.stop());
  await shadow.start();
  assert.equal(host.tools.size,0); assert.equal(host.sections.size,0);
  assert.equal((await service.readCoreView()).text,before.text);
});

test('completed compression advances exactly once only with actual created-block evidence',async t => {
  const {bridge} = await fixture(t);
  const base = {sessionId:'sess-fixture',name:'compress',success:true};
  const epoch = () => bridge.diagnostics().probe.epoch;
  const start = epoch();
  await bridge.onCompletedTool({...base,eventId:'zero',blocksCreated:0});
  await bridge.onCompletedTool({...base,eventId:'failed',success:false,blocksCreated:2});
  assert.equal(epoch(),start);
  await bridge.onCompletedTool({...base,eventId:'actual',blocksCreated:2});
  assert.equal(epoch(),start+1);
  await bridge.onCompletedTool({...base,eventId:'actual',blocksCreated:2});
  assert.equal(epoch(),start+1);
});
