// Shiori P4 · test/forgetting/combination.test.mjs
// O 槽真实组合测试：M(decay) + N(store 提案) + O(executor/cold-search)。
// 契约：phase5/collab/CONTRACTS.md §5/§7；主审 a1 返工 D-2/D-3。
//
// 集成门：通过 import.meta.url 解析当前项目根，强制加载真实 M/N/O 生产模块。
// 不读取外部 stage 环境变量，不允许 skip，也不使用 stub 替代生产组合。
// D-2：核心验收断言一律无条件执行——fixture 造数失败会让断言直接失败，
// 不允许用 if 包住断言把造数问题变成静默通过。
//
// 全部使用合成临时 dataRoot（os.tmpdir），用后清理；不触碰真实 DSH/profile。

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const SCOPE = 'amber';
const POLICY = Object.freeze({ baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });

/** 动态 import stage 内相对模块（唯一入口，防止绕过 stage）。 */
function stageImport(rel) {
  return import(pathToFileURL(path.join(STAGE, rel)).href);
}

/** 合成临时 dataRoot；测试结束自动清理。 */
async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shiori-p4-combo-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function openStore(root) {
  const { openSparkStore } = await stageImport('src/sparks/store.mjs');
  return openSparkStore({ root, scopeId: SCOPE });
}

async function saveCard(store, id, { title = `${id}-title`, content = `${id}-content zeta-marker`, triggers = [`${id}-trig`], vitality = 'ephemeral' } = {}) {
  return store.save({ id, title, summary: `${id}-summary`, content, triggers, entities: [`${id}-ent`], vitality });
}

/** 建库：五张卡（createdAt 即各自真实锚点），含替代关系与四次有用反馈。 */
async function seedLibrary(store) {
  const saved = {};
  for (const id of ['c-old-a', 'c-old-b', 'c-old-ever', 'c-old-repl', 'c-old-used']) {
    saved[id] = await saveCard(store, id, id === 'c-old-ever' ? { vitality: 'evergreen' } : {});
  }
  // 替代关系：c-old-a 被 c-old-repl 承接 → a 退休、repl 受保护
  await store.forget('c-old-a', { mode: 'supersede', replacementId: 'c-old-repl' });
  // 有用反馈 ×4：c-old-used 半衰期封顶 240 天
  for (let i = 0; i < 4; i++) {
    await store.recordUsefulFeedback('c-old-used', { used: true, sourceEventId: `evt-fb-${i}` });
  }
  return saved;
}

test('真实 M/N/O 组合（当前项目生产模块；强制零 skip）', async (t) => {
  await t.test('M 分析 59/60/61 边界、evergreen 免疫、承接保护、反馈续锚、不改输入', async (st) => {
    const root = await tempRoot(st);
    const store = await openStore(root);
    const saved = await seedLibrary(store);
    const { analyzeForgetting } = await stageImport('src/forgetting/decay.mjs');

    // 以 c-old-b 的 createdAt 为统一锚点构造 59/60/61 天
    const anchor = new Date(saved['c-old-b'].createdAt).getTime();
    const now61 = iso(anchor + 61 * DAY);
    const sparks = await store.listActive();
    const before = structuredClone(sparks);

    const result = analyzeForgetting({ scopeId: SCOPE, sparks, now: now61, policy: {} });
    assert.equal(result.kind, 'forget-analysis');
    assert.equal(result.scopeId, SCOPE);
    assert.equal(result.now, now61);

    const byId = new Map(result.assessments.map((a) => [a.id, a]));
    // 61 天未用：c-old-b 可归档；退休卡 c-old-a 不进入分析输入（listActive 只含 active）
    assert.ok(byId.get('c-old-b').eligible === true, '61 天卡可归档');
    assert.ok(byId.get('c-old-b').score < POLICY.archiveScore, '61 天分数严格低于阈值');
    assert.ok(byId.get('c-old-b').elapsedDays >= 61);
    assert.ok(byId.get('c-old-ever').eligible === false, 'evergreen 免疫');
    assert.equal(byId.get('c-old-ever').halfLifeDays, null);
    assert.equal(byId.get('c-old-ever').score, 1);
    assert.ok(byId.get('c-old-repl').eligible === false, '承接替代卡受保护');
    assert.ok(byId.get('c-old-used').eligible === false, 'useCount=4 半衰期封顶 240，61 天分数仍高于阈值');
    assert.equal(byId.get('c-old-a'), undefined, '退休卡不是分析输入');
    assert.ok(result.plan !== null && result.plan.sources.some((s) => s.id === 'c-old-b'));
    assert.deepEqual(sparks, before, '分析不改输入卡');

    // 59/60 天边界：c-old-b 在锚点 +59/+60 天不可归档（too-recent / 分数未严格低于）
    for (const [days, label] of [[59, '59 天'], [60, '60 天等于阈值']]) {
      const r = analyzeForgetting({ scopeId: SCOPE, sparks, now: iso(anchor + days * DAY), policy: {} });
      const a = r.assessments.find((x) => x.id === 'c-old-b');
      assert.ok(a.eligible === false, `${label}不可归档`);
      assert.equal(r.plan, null, `${label}无候选计划`);
    }
    store.close();
  });

  await t.test('O 执行 M 计划（真实授权+时钟注入）→ N 原子软归档，正文/统计原样，匹配不复活', async (st) => {
    const root = await tempRoot(st);
    const store = await openStore(root);
    const saved = await seedLibrary(store);
    const { analyzeForgetting } = await stageImport('src/forgetting/decay.mjs');
    const { createForgetExecutor } = await stageImport('src/forgetting/executor.mjs');
    const { matchSparks } = await stageImport('src/sparks/match.mjs');

    const anchor = new Date(saved['c-old-b'].createdAt).getTime();
    const planNow = iso(anchor + 61 * DAY);
    const executedAt = iso(anchor + 61 * DAY + 3_600_000);
    const plan = analyzeForgetting({ scopeId: SCOPE, sparks: await store.listActive(), now: planNow, policy: {} }).plan;
    assert.ok(plan !== null, 'fixture 必须产生非空计划');

    let authCalls = 0;
    const executor = createForgetExecutor({
      store, scopeId: SCOPE,
      authorize: (req) => { authCalls += 1; return req.kind === 'forget-archive' && req.scopeId === SCOPE; },
      now: () => executedAt,
    });
    const receipt = await executor.execute(plan, { operationId: 'combo-exec-1' });
    assert.equal(authCalls, 1);
    assert.equal(receipt.kind, 'forget-archive-result');
    assert.equal(receipt.operationId, 'combo-exec-1');
    assert.equal(receipt.archivedAt, executedAt);
    const item = receipt.items.find((x) => x.id === 'c-old-b');
    assert.ok(item, '回执包含归档卡');
    assert.equal(item.state, 'archived');
    assert.equal(item.revision, saved['c-old-b'].revision + 1, 'revision+1');
    assert.equal(item.archivedAt, executedAt);

    // 持久层核验：正文/链接/统计原样，仅状态与归档元数据变化
    const card = await store.read('c-old-b');
    assert.equal(card.state, 'archived');
    assert.equal(card.archivedAt, executedAt);
    assert.equal(card.updatedAt, executedAt);
    assert.equal(card.title, saved['c-old-b'].title);
    assert.equal(card.content, saved['c-old-b'].content);
    assert.equal(card.useCount, saved['c-old-b'].useCount);
    assert.equal(card.hitCount, saved['c-old-b'].hitCount);

    // 自动匹配不复活：归档卡不再是种子（isEligible 过滤非 active）
    const activeIds = (await store.listActive()).map((c) => c.id);
    assert.ok(!activeIds.includes('c-old-b'), 'listActive 不含归档卡');
    const m = matchSparks({
      scopeId: SCOPE, userText: 'c-old-b-trig', sparks: [card],
      sessionId: 's-combo', contextEpoch: 1,
    });
    assert.equal(m.seeds.length, 0, '归档卡不能成为匹配种子');
    assert.equal(m.related.length, 0);
    store.close();
  });

  await t.test('归档后冷库检索（O+N）——按 content 命中、只回摘要、截断', async (st) => {
    const root = await tempRoot(st);
    const store = await openStore(root);
    const saved = await seedLibrary(store);
    const { analyzeForgetting } = await stageImport('src/forgetting/decay.mjs');
    const { createForgetExecutor } = await stageImport('src/forgetting/executor.mjs');
    const { createColdSearch } = await stageImport('src/forgetting/cold-search.mjs');

    const anchor = new Date(saved['c-old-b'].createdAt).getTime();
    const planNow = iso(anchor + 61 * DAY);
    // 第二张同关键词旧卡：c-old-c 与 c-old-b 同龄且无反馈 → 必然同批候选
    await saveCard(store, 'c-old-c');
    const plan = analyzeForgetting({ scopeId: SCOPE, sparks: await store.listActive(), now: planNow, policy: {} }).plan;
    assert.ok(plan !== null, 'fixture 必须产生非空计划');
    assert.ok(plan.sources.length >= 2, `fixture 必须归档 >=2 张同关键词卡（实际 ${plan.sources.length}）`);
    await createForgetExecutor({
      store, scopeId: SCOPE, authorize: () => true, now: () => planNow,
    }).execute(plan, { operationId: 'combo-exec-2' });

    const search = createColdSearch({ store, scopeId: SCOPE }).search;
    const r = await search({ query: 'ZETA-MARKER' });
    assert.equal(r.kind, 'cold-search');
    assert.equal(r.scopeId, SCOPE);
    assert.equal(r.query, 'ZETA-MARKER');
    // D-2：命中数无条件断言 >=2，造数失败直接测试失败，不静默跳过
    assert.ok(r.items.length >= 2, `同关键词冷库命中必须 >=2（实际 ${r.items.length}）`);
    for (const it of r.items) {
      assert.equal(it.state, 'archived');
      assert.deepEqual(
        Object.keys(it).sort(),
        ['archivedAt', 'id', 'revision', 'state', 'summary', 'title'],
        '条目只含摘要字段，不输出正文',
      );
    }
    assert.ok(r.items.every((it) => it.id !== 'c-old-ever' && it.id !== 'c-old-repl'), '不查未归档卡');

    // D-2：截断断言无条件执行（上游已证命中 >=2）
    const limited = await search({ query: 'zeta-marker', limit: 1 });
    assert.equal(limited.truncated, true, '命中数 > limit → 截断');
    assert.equal(limited.items.length, 1);

    // 检索是只读的：再查一次归档元数据不变
    const card = await store.read(r.items[0].id);
    assert.equal(card.state, 'archived');
    assert.equal(card.archivedAt, planNow, '检索不复活/不续期/不改归档时间');
    store.close();
  });

  await t.test('59/60 天计划直接执行 → N INVALID_STATE，库零变化', async (st) => {
    const root = await tempRoot(st);
    const store = await openStore(root);
    const saved = await seedLibrary(store);
    const { createForgetExecutor } = await stageImport('src/forgetting/executor.mjs');

    const anchor = new Date(saved['c-old-b'].createdAt).getTime();
    const before = structuredClone(await store.read('c-old-b'));
    for (const days of [59, 60]) {
      const at = iso(anchor + days * DAY);
      const plan = {
        version: 1, kind: 'archive-ephemeral', scopeId: SCOPE, now: at, policy: { ...POLICY },
        sources: [{
          id: 'c-old-b', revision: before.revision, createdAt: before.createdAt,
          lastUsedAt: before.lastUsedAt, useCount: before.useCount,
        }],
      };
      await assert.rejects(
        createForgetExecutor({ store, scopeId: SCOPE, authorize: () => true, now: () => at })
          .execute(plan, { operationId: `combo-exec-not-${days}` }),
        (e) => e.code === 'INVALID_STATE',
        `${days} 天不可归档`,
      );
    }
    const after = await store.read('c-old-b');
    assert.deepEqual(after, before, '失败后原卡逐字节不变');
    store.close();
  });

  await t.test('N/O 对同一非法 Plan 的 INVALID_INPUT 一致性（§7）', async (st) => {
    const root = await tempRoot(st);
    const store = await openStore(root);
    const saved = await seedLibrary(store);
    const { createForgetExecutor } = await stageImport('src/forgetting/executor.mjs');
    const executor = createForgetExecutor({ store, scopeId: SCOPE, authorize: () => true, now: () => iso(new Date(saved['c-old-b'].createdAt).getTime() + 61 * DAY) });

    const goodSource = {
      id: 'c-old-b', revision: 2, createdAt: saved['c-old-b'].createdAt, lastUsedAt: null, useCount: 0,
    };
    const base = {
      version: 1, kind: 'archive-ephemeral', scopeId: SCOPE,
      now: iso(new Date(saved['c-old-b'].createdAt).getTime() + 61 * DAY),
      policy: { ...POLICY }, sources: [goodSource],
    };
    const mk21 = () => Array.from({ length: 21 }, (_, i) => ({ ...goodSource, id: `spk-x${String(i).padStart(2, '0')}` }));
    const illegal = [
      ['plan 未知键', { ...base, extra: 1 }],
      ['空 sources', { ...base, sources: [] }],
      ['21 项 sources', { ...base, sources: mk21() }],
      ['policy 部分（缺字段）', { ...base, policy: { baseHalfLifeDays: 30 } }],
      ['source 未知键', { ...base, sources: [{ ...goodSource, extra: 1 }] }],
    ];
    let i = 0;
    for (const [label, plan] of illegal) {
      i += 1;
      await assert.rejects(
        executor.execute(plan, { operationId: `combo-illegal-o-${i}` }),
        (e) => e.code === 'INVALID_INPUT',
        `O 门面拒绝：${label}`,
      );
      await assert.rejects(
        store.archiveEphemeral(plan, { operationId: `combo-illegal-n-${i}`, executedAt: base.now }),
        (e) => e.code === 'INVALID_INPUT',
        `N store 拒绝：${label}`,
      );
    }
    store.close();
  });

  await t.test('sources 顺序规范化后同 operationId 重放首次结果，零写（§7）', async (st) => {
    const root = await tempRoot(st);
    const store = await openStore(root);
    const saved = await seedLibrary(store);
    await saveCard(store, 'c-old-c');
    const { analyzeForgetting } = await stageImport('src/forgetting/decay.mjs');
    const { createForgetExecutor } = await stageImport('src/forgetting/executor.mjs');

    const anchor = new Date(saved['c-old-b'].createdAt).getTime();
    const planNow = iso(anchor + 61 * DAY);
    const plan = analyzeForgetting({ scopeId: SCOPE, sparks: await store.listActive(), now: planNow, policy: {} }).plan;
    assert.ok(plan.sources.length >= 2, `本用例需要 >=2 个候选源（实际 ${plan.sources.length}）`);
    const executor = createForgetExecutor({
      store, scopeId: SCOPE, authorize: () => true, now: () => planNow,
    });
    const first = await executor.execute(plan, { operationId: 'combo-replay' });
    const firstIds = first.items.map((x) => x.id);

    // 同 op、sources 逆序（规范化后同语义）、更晚的执行时钟 → 重放首次快照
    const reordered = { ...plan, sources: [...plan.sources].reverse() };
    const later = iso(anchor + 62 * DAY);
    const executor2 = createForgetExecutor({ store, scopeId: SCOPE, authorize: () => true, now: () => later });
    const replay = await executor2.execute(reordered, { operationId: 'combo-replay' });
    assert.equal(replay.archivedAt, first.archivedAt, '重放返回首次 executedAt，不采用本次时钟');
    assert.deepEqual(replay.items.map((x) => x.id), firstIds);
    for (const id of firstIds) {
      const card = await store.read(id);
      assert.equal(card.archivedAt, first.archivedAt, '重放零写：归档时间不变');
      assert.equal(card.revision, first.items.find((x) => x.id === id).revision, '重放不追加 revision');
    }
    // 重放不改变冷库可见性语义
    const { createColdSearch } = await stageImport('src/forgetting/cold-search.mjs');
    const r = await createColdSearch({ store, scopeId: SCOPE }).search({ query: 'zeta-marker' });
    assert.deepEqual(r.items.map((x) => x.id).sort(), [...firstIds].sort());
    store.close();
  });

  await t.test('同 operationId 异 plan → INVALID_INPUT（§7）', async (st) => {
    const root = await tempRoot(st);
    const store = await openStore(root);
    const saved = await seedLibrary(store);
    const { analyzeForgetting } = await stageImport('src/forgetting/decay.mjs');
    const { createForgetExecutor } = await stageImport('src/forgetting/executor.mjs');

    const anchor = new Date(saved['c-old-b'].createdAt).getTime();
    const planNow = iso(anchor + 61 * DAY);
    const plan = analyzeForgetting({ scopeId: SCOPE, sparks: await store.listActive(), now: planNow, policy: {} }).plan;
    assert.ok(plan !== null, 'fixture 必须产生非空计划');
    const executor = createForgetExecutor({ store, scopeId: SCOPE, authorize: () => true, now: () => planNow });
    await executor.execute(plan, { operationId: 'combo-sameop' });

    // 同 op、不同 plan（now 前移 1ms）：语义不同 → INVALID_INPUT
    const different = { ...plan, now: iso(new Date(planNow).getTime() - 1) };
    const earlier = createForgetExecutor({
      store, scopeId: SCOPE, authorize: () => true, now: () => iso(new Date(planNow).getTime() - 1),
    });
    await assert.rejects(
      earlier.execute(different, { operationId: 'combo-sameop' }),
      (e) => e.code === 'INVALID_INPUT',
      '同 operationId 异 plan 拒绝',
    );
    store.close();
  });

  await t.test('独立 fixture：反馈后陈旧计划 → REVISION_CONFLICT，整批零归档（§7/D-2）', async (st) => {
    // D-2：独立真实 fixture，不再复用已归档候选的库；全部断言无条件执行。
    const root = await tempRoot(st);
    const store = await openStore(root);
    const { analyzeForgetting } = await stageImport('src/forgetting/decay.mjs');
    const { createForgetExecutor } = await stageImport('src/forgetting/executor.mjs');

    // 专属卡组：stale-1/stale-2 无替代、无反馈、ephemeral → 必为候选
    const s1 = await saveCard(store, 'stale-1');
    await saveCard(store, 'stale-2');
    const anchor = new Date(s1.createdAt).getTime();
    const planNow = iso(anchor + 61 * DAY);
    const plan = analyzeForgetting({ scopeId: SCOPE, sparks: await store.listActive(), now: planNow, policy: {} }).plan;
    assert.ok(plan !== null, 'fixture 必须产生非空计划（stale-1/stale-2 均为 61 天候选）');
    assert.ok(plan.sources.length >= 1, '计划至少包含一个源');
    const srcId = plan.sources[0].id;

    // 计划内每张卡执行前都是 active（前置条件，无条件断言）
    for (const s of plan.sources) {
      const c = await store.read(s.id);
      assert.equal(c.state, 'active', `${s.id} 执行前必须 active`);
    }

    // 对首个源发一次有用反馈：revision 不变，useCount/lastUsedAt 必须变化
    const before = structuredClone(await store.read(srcId));
    await store.recordUsefulFeedback(srcId, { used: true, sourceEventId: 'evt-stale-1' });
    const after = await store.read(srcId);
    assert.equal(after.revision, before.revision, '反馈不改 revision（不能只核 revision）');
    assert.equal(after.useCount, before.useCount + 1, 'used=true → useCount+1');
    assert.notEqual(after.lastUsedAt, before.lastUsedAt, 'used=true → lastUsedAt 更新');

    // 陈旧计划执行 → 五字段 CAS 失败，REVISION_CONFLICT
    await assert.rejects(
      createForgetExecutor({ store, scopeId: SCOPE, authorize: () => true, now: () => planNow })
        .execute(plan, { operationId: 'combo-stale' }),
      (e) => e.code === 'REVISION_CONFLICT',
      '反馈后快照变化 → REVISION_CONFLICT',
    );

    // 整批零归档：计划内全部源仍 active，冷库为空
    for (const s of plan.sources) {
      const c = await store.read(s.id);
      assert.equal(c.state, 'active', `${s.id} 冲突后必须仍 active（整批回滚）`);
    }
    assert.equal((await store.listArchived()).length, 0, '冲突执行后冷库必须为空');
    store.close();
  });

  await t.test('授权拒绝与时钟回拨不触碰库（真实 store 验证零变化）', async (st) => {
    const root = await tempRoot(st);
    const store = await openStore(root);
    const saved = await seedLibrary(store);
    const { analyzeForgetting } = await stageImport('src/forgetting/decay.mjs');
    const { createForgetExecutor } = await stageImport('src/forgetting/executor.mjs');

    const anchor = new Date(saved['c-old-b'].createdAt).getTime();
    const planNow = iso(anchor + 61 * DAY);
    const plan = analyzeForgetting({ scopeId: SCOPE, sparks: await store.listActive(), now: planNow, policy: {} }).plan;
    assert.ok(plan !== null, 'fixture 必须产生非空计划');
    const before = structuredClone(await store.listActive());

    await assert.rejects(
      createForgetExecutor({ store, scopeId: SCOPE, authorize: () => false, now: () => planNow })
        .execute(plan, { operationId: 'combo-denied' }),
      (e) => e.code === 'AUTHORIZATION_REQUIRED',
    );
    await assert.rejects(
      createForgetExecutor({ store, scopeId: SCOPE, authorize: () => true, now: () => iso(anchor + 60 * DAY) })
        .execute(plan, { operationId: 'combo-denied' }),
      (e) => e.code === 'INVALID_STATE',
      'now < plan.now 门面 fail-closed',
    );
    assert.deepEqual(await store.listActive(), before, '两次拒绝后库零变化');
    store.close();
  });
});
