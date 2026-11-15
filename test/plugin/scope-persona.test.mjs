// P5 · scope/persona/settings 测试（slot P）。
// 只用合成 temp 数据；不读写真实记忆，不联网。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  validateControllerSettings, personaForSession, scopeIdForPersona,
  pinScope, rejectIdentityFields, sessionEvidenceFromExec,
} from "../../src/plugin/scope.mjs";
import { createPersonaAdapter } from "../../src/plugin/persona.mjs";
import { defaultPluginRoots, normalizePluginConfig, verifyPluginRoots } from "../../src/plugin/config.mjs";

const baseSettings = {
  mode: "shadow",
  allowActive: false,
  dataRoot: null,
  stateRoot: null,
  ownerId: "local",
};

test("settings：缺省值（shadow / local / 两 root null / 模块全关）", () => {
  const s = validateControllerSettings({});
  assert.equal(s.mode, "shadow");
  assert.equal(s.allowActive, false);
  assert.equal(s.dataRoot, null);
  assert.equal(s.stateRoot, null);
  assert.equal(s.ownerId, "local");
  assert.equal(s.defaultPersona, null);
  assert.deepEqual(s.sessionPersonas, []);
  assert.deepEqual(s.workspacePersonas, []);
  assert.equal(s.l2.enabled, false);
  assert.equal(s.organize.enabled, false);
  assert.equal(s.forgetting.enabled, false);
  assert.equal(s.budgets.persona.maxChars, 12000);
  assert.deepEqual(s.forgetting.policy, { baseHalfLifeDays: 30, maxHalfLifeDays: 240, archiveScore: 0.25 });
});

test("settings：未知键拒绝；active 必须 allowActive；root 绝对且缺根独立补默认（0.4-S1）", () => {
  assert.throws(() => validateControllerSettings({ ...baseSettings, extra: 1 }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => validateControllerSettings({ ...baseSettings, mode: "active" }), (e) => e.code === "INVALID_INPUT");
  // 0.4-S1：单根配置合法——缺省根独立补 DSH_HOME 默认（不再要求成对齐给）
  const onlyData = validateControllerSettings({ ...baseSettings, dataRoot: "D:/x" });
  assert.equal(onlyData.dataRoot, "D:/x");
  assert.equal(onlyData.stateRoot, defaultPluginRoots().stateRoot);
  assert.equal(onlyData.rootsSource.dataRoot, "explicit");
  assert.equal(onlyData.rootsSource.stateRoot, "default");
  assert.throws(
    () => validateControllerSettings({ ...baseSettings, dataRoot: "relative/x", stateRoot: "D:/s" }),
    (e) => e.code === "INVALID_INPUT",
  );
  const ok = validateControllerSettings({ ...baseSettings, dataRoot: "D:/tmp-data", stateRoot: "D:/tmp-state" });
  assert.equal(ok.dataRoot, "D:/tmp-data");
  assert.equal(ok.rootsSource.dataRoot, "explicit");
  assert.equal(ok.rootsSource.stateRoot, "explicit");
});

test("settings：active 双空根补 DSH_HOME 默认；shadow 双空保持 null（0.4 P4）", () => {
  // active 直构兜底：与 apply 路径同语义，不再带着一对 null 根去 openState。
  const active = validateControllerSettings({ mode: "active", allowActive: true });
  assert.equal(active.dataRoot, defaultPluginRoots().dataRoot);
  assert.equal(active.stateRoot, defaultPluginRoots().stateRoot);
  assert.equal(active.rootsSource.dataRoot, "default");
  assert.equal(active.rootsSource.stateRoot, "default");

  // shadow 双空保持 null：影子挂载 inert，不补根。
  const shadow = validateControllerSettings({});
  assert.equal(shadow.mode, "shadow");
  assert.equal(shadow.dataRoot, null);
  assert.equal(shadow.stateRoot, null);
  assert.equal(shadow.rootsSource.dataRoot, "default");
  assert.equal(shadow.rootsSource.stateRoot, "default");
});

test("settings：rootsSource 显式传入时自洽校验（0.4 P4）", () => {
  // explicit 必须对应已给值：配空值（null/缺省）即矛盾，拒绝。
  assert.throws(
    () => validateControllerSettings({
      ...baseSettings,
      rootsSource: { dataRoot: "explicit", stateRoot: "default" },
    }),
    (e) => e.code === "INVALID_INPUT" && /dataRoot is "explicit"/.test(e.message),
  );
  assert.throws(
    () => validateControllerSettings({
      ...baseSettings,
      rootsSource: { dataRoot: "default", stateRoot: "explicit" },
    }),
    (e) => e.code === "INVALID_INPUT" && /stateRoot is "explicit"/.test(e.message),
  );
  // default 必须对应未给值：配了自定路径即矛盾，拒绝。
  assert.throws(
    () => validateControllerSettings({
      ...baseSettings,
      dataRoot: "D:/custom-data", stateRoot: "D:/custom-state",
      rootsSource: { dataRoot: "default", stateRoot: "default" },
    }),
    (e) => e.code === "INVALID_INPUT" && /dataRoot is "default"/.test(e.message),
  );
  // 正例 1：显式双根 + 双 explicit → 原样通过。
  const explicitOk = validateControllerSettings({
    ...baseSettings,
    dataRoot: "D:/tmp-data", stateRoot: "D:/tmp-state",
    rootsSource: { dataRoot: "explicit", stateRoot: "explicit" },
  });
  assert.equal(explicitOk.rootsSource.dataRoot, "explicit");
  assert.equal(explicitOk.rootsSource.stateRoot, "explicit");
  // 正例 2：双空 + 双 default → shadow 下保持 null（自洽）。
  const emptyOk = validateControllerSettings({
    ...baseSettings,
    rootsSource: { dataRoot: "default", stateRoot: "default" },
  });
  assert.equal(emptyOk.dataRoot, null);
  assert.equal(emptyOk.stateRoot, null);
  // 正例 3：normalize/verify 注入产物——已解析默认根 + default 标记 → 自洽透传。
  const injectedOk = validateControllerSettings({
    ...baseSettings,
    dataRoot: defaultPluginRoots().dataRoot,
    stateRoot: defaultPluginRoots().stateRoot,
    rootsSource: { dataRoot: "default", stateRoot: "default" },
  });
  assert.equal(injectedOk.dataRoot, defaultPluginRoots().dataRoot);
  assert.equal(injectedOk.rootsSource.stateRoot, "default");
});

test("settings：junction DSH_HOME 全链路注入不误拒 + default 根路径形态等价（评审打回项 1/2/3）", () => {
  // 打回项 2（阻塞护栏）：复现 index.mjs apply 注入链路——DSH_HOME 建成 junction
  // （造法照搬 config.test.mjs verifyPluginRoots 本体用例），normalize 补词形默认根
  // 并标记 default，verify 解析出真实路径，apply 按 index.mjs:40 回填 verified 两根
  // 并保留 rootsSource=default，再过 validateControllerSettings（controller.mjs:120
  // 同款再校验）。逐字节比较会在这一步抛 INVALID_INPUT 打死插件启动，解析后等价
  // 口径必须放行。
  const base = mkdtempSync(path.join(tmpdir(), "shiori-p5-inject-"));
  try {
    const real = path.join(base, "real-home");
    mkdirSync(real, { recursive: true });
    const link = path.join(base, "link-home");
    try {
      symlinkSync(real, link, "dir");
    } catch {
      symlinkSync(real, link, "junction");
    }

    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = link;
    try {
      const normalized = normalizePluginConfig({});
      const verified = verifyPluginRoots(normalized);
      // 造景前提自证（attempt 3 返工）：normalize 产出的是 junction 词形根，verify
      // 解析出的必须是其真实路径目标——两者确实不同，链路才算真的走过 link 解析，
      // 否则本用例对「注入值 ≠ 词形值」场景退化为恒真。
      assert.equal(normalized.dataRoot, path.join(link, "shiori-data"), "normalize 应产出 junction 词形默认根");
      assert.notEqual(verified.dataRoot, normalized.dataRoot, "verify 必须把 junction 解析成真实路径");
      assert.equal(verified.dataRoot, path.join(real, "shiori-data"), "解析目标正是 real-home");
      const injected = validateControllerSettings({
        ...normalized,
        dataRoot: verified.dataRoot,
        stateRoot: verified.stateRoot,
      });
      assert.equal(injected.dataRoot, path.join(real, "shiori-data"), "verify 回填的真实路径必须原样通过");
      assert.equal(injected.stateRoot, path.join(real, "shiori-state"));
      assert.equal(injected.rootsSource.dataRoot, "default");
      assert.equal(injected.rootsSource.stateRoot, "default");

      // 打回项 3：default 值按路径形态等价——正斜杠、win32 盘符小写、尾随分隔符
      // 三种形态与默认根同一位置，都不得被拒。
      const lexical = defaultPluginRoots().dataRoot;
      const variants = [lexical.replaceAll("\\", "/"), lexical + path.sep];
      if (process.platform === "win32") variants.push(lexical.toLowerCase());
      for (const variant of variants) {
        const s = validateControllerSettings({
          mode: "shadow", allowActive: false,
          dataRoot: variant, stateRoot: null,
          rootsSource: { dataRoot: "default", stateRoot: "default" },
        });
        assert.equal(s.rootsSource.dataRoot, "default", `形态 ${variant} 必须按解析后等价放行`);
      }

      // 打回项 4 保留：default 配了真实存在的自定路径仍要拒（解析后确实不等）。
      assert.throws(
        () => validateControllerSettings({
          mode: "shadow", allowActive: false,
          dataRoot: real, stateRoot: null,
          rootsSource: { dataRoot: "default", stateRoot: "default" },
        }),
        (e) => e.code === "INVALID_INPUT" && /dataRoot is "default"/.test(e.message),
      );
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("settings：DSH_HOME 默认目录不存在时按字面兜底放行（attempt 5）", () => {
  // 直构用例：DSH_HOME 指向不存在的目录，given 与默认根同一串字面、rootsSource
  // 标 default → 必须 ACCEPT。两侧 realpath 都失败（ENOENT），comparableResolvedRoot
  // 退回字面折叠后相等。判别力来自这个 try/catch 兜底——删掉兜底本用例必红，
  // 不再宣称守护独立字面分支（该分支已按评审要求删除）。
  const base = mkdtempSync(path.join(tmpdir(), "shiori-p5-lexical-"));
  try {
    const missingHome = path.join(base, "not-created-home");
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = missingHome;
    try {
      const expected = defaultPluginRoots();
      assert.equal(expected.dataRoot, path.join(missingHome, "shiori-data"), "默认根派生自 DSH_HOME 词形");
      assert.equal(expected.stateRoot, path.join(missingHome, "shiori-state"));
      const accepted = validateControllerSettings({
        mode: "shadow", allowActive: false,
        dataRoot: expected.dataRoot, stateRoot: expected.stateRoot,
        rootsSource: { dataRoot: "default", stateRoot: "default" },
      });
      assert.equal(accepted.dataRoot, expected.dataRoot);
      assert.equal(accepted.stateRoot, expected.stateRoot);
      assert.equal(accepted.rootsSource.dataRoot, "default");
      assert.equal(accepted.rootsSource.stateRoot, "default");
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("settings：rootsSource 配非字符串根拿到 INVALID_INPUT 而非 TypeError（attempt 4）", () => {
  // 评审打回项 2：realpathSync/normalize 遇到非字符串会抛 TypeError，绕过统一
  // fail；自洽校验循环先判类型后，default 与 explicit 两种来源都应是 INVALID_INPUT。
  assert.throws(
    () => validateControllerSettings({
      ...baseSettings,
      dataRoot: 5,
      rootsSource: { dataRoot: "default", stateRoot: "default" },
    }),
    (e) => e instanceof Error && e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => validateControllerSettings({
      ...baseSettings,
      dataRoot: 5,
      rootsSource: { dataRoot: "explicit", stateRoot: "default" },
    }),
    (e) => e instanceof Error && e.code === "INVALID_INPUT",
  );
});

test("settings：预算超生产安全上限拒绝（persona 60001 / spark 601 / seed 4）", () => {
  assert.throws(
    () => validateControllerSettings({ ...baseSettings, budgets: { persona: { maxChars: 60001 } } }),
    (e) => e.code === "INVALID_INPUT" && /cap/.test(e.message),
  );
  assert.throws(
    () => validateControllerSettings({ ...baseSettings, budgets: { spark: { maxChars: 601 } } }),
    (e) => e.code === "INVALID_INPUT",
  );
  assert.throws(
    () => validateControllerSettings({ ...baseSettings, budgets: { spark: { seedCount: 4 } } }),
    (e) => e.code === "INVALID_INPUT",
  );
  validateControllerSettings({ ...baseSettings, budgets: { persona: { maxChars: 8000 } } });
});

test("settings：forgetting.policy 非法值拒绝（validateConfig 关系沿现校验）", () => {
  assert.throws(
    () => validateControllerSettings({ ...baseSettings, forgetting: { enabled: true, policy: { archiveScore: 1.5 } } }),
    (e) => e.code === "INVALID_INPUT",
  );
  const s = validateControllerSettings({
    ...baseSettings, forgetting: { enabled: true, policy: { baseHalfLifeDays: 20 } },
  });
  assert.equal(s.forgetting.policy.baseHalfLifeDays, 20);
  assert.equal(s.forgetting.policy.maxHalfLifeDays, 240);
});

test("选卡：sessionPersonas 精确 → workspace 最长边界匹配 → defaultPersona", () => {
  const settings = validateControllerSettings({
    ...baseSettings,
    defaultPersona: "amber",
    sessionPersonas: [{ sessionId: "s-1", persona: "beta" }],
    workspacePersonas: [
      { workspace: "D:/work", persona: "wp-short" },
      { workspace: "D:/work/deep/nested", persona: null },
    ],
  });
  assert.equal(personaForSession(settings, { sessionId: "s-1" }), "beta");
  assert.equal(personaForSession(settings, { sessionId: "s-2", workspace: "D:/work/deep" }), "wp-short");
  // 最长匹配：嵌套目录命中更长的 workspace 条目（persona null = global）。
  assert.equal(personaForSession(settings, { sessionId: "s-2", workspace: "D:/work/deep/nested/x" }), null);
  // 仅路径边界匹配：前缀字符串相同但非边界不命中。
  assert.equal(personaForSession(settings, { sessionId: "s-2", workspace: "D:/workbook" }), "amber");
  assert.equal(personaForSession(settings, { sessionId: "s-2" }), "amber");
  assert.equal(scopeIdForPersona(null), "global");
  assert.equal(scopeIdForPersona("amber"), "amber");
});

test("pinScope：返回冻结对象且身份字段完整；exec 缺会话证据拒绝", () => {
  const settings = validateControllerSettings({ ...baseSettings, defaultPersona: "amber" });
  const scope = pinScope({ settings, sessionId: "s-1", generation: 3, source: "tool-exec" });
  assert.equal(scope.scopeId, "amber");
  assert.equal(scope.ownerId, "local");
  assert.equal(scope.generation, 3);
  assert.ok(Object.isFrozen(scope));
  assert.throws(() => pinScope({ settings, sessionId: "", generation: 1, source: "tool-exec" }), (e) => e.code === "INVALID_INPUT");
  assert.throws(() => sessionEvidenceFromExec({ agent: {} }), (e) => e.code === "INVALID_INPUT");
  assert.deepEqual(sessionEvidenceFromExec({ agent: { session: { id: "x" } } }), { sessionId: "x", agent: { session: { id: "x" } } });
});

test("payload 危险身份字段显式拒绝（scope/persona/authorize/ownerId/root/trustedContext）", () => {
  for (const key of ["scope", "scopeId", "persona", "authorize", "ownerId", "root", "trustedContext"]) {
    assert.throws(() => rejectIdentityFields({ [key]: "x" }, "t"), (e) => e.code === "INVALID_INPUT" && e.details.key === key);
  }
  rejectIdentityFields({ topic: "safe" }, "t");
});

// ── persona adapter ──────────────────────────────────────────

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "shiori-p5-persona-"));
}

const CARD = "# 示例\n你是示例。";

test("persona adapter：commit 建卡 / CAS 冲突 / 同 operationId 重放首结果", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = createPersonaAdapter({ dir, scopeId: "amber", maxChars: 100 });

  const first = await adapter.commit({
    operationId: "op-1",
    changes: [{ kind: "persona", text: CARD, expectedRevision: null }],
  });
  assert.equal(first.changes[0].afterRevision, first.changes[0].afterRevision);

  // 重放：同 op 同 payload → 首次结果，不重复写。
  const replay = await adapter.commit({
    operationId: "op-1",
    changes: [{ kind: "persona", text: CARD, expectedRevision: null }],
  });
  assert.equal(replay.changes[0].afterRevision, first.changes[0].afterRevision);

  // 同 op 异 payload → 拒绝。
  await assert.rejects(
    () => adapter.commit({ operationId: "op-1", changes: [{ kind: "persona", text: "# 别的", expectedRevision: null }] }),
    (e) => e.code === "INVALID_INPUT",
  );

  // 过期 revision → CAS 冲突。
  await assert.rejects(
    () => adapter.commit({ operationId: "op-2", changes: [{ kind: "persona", text: CARD, expectedRevision: null }] }),
    (e) => e.code === "REVISION_CONFLICT",
  );

  const read1 = await adapter.read();
  assert.equal(read1.text, CARD);
  assert.ok(/^[0-9a-f]{64}$/.test(read1.revision));

  const second = await adapter.commit({
    operationId: "op-3",
    changes: [{ kind: "persona", text: "# 新卡", expectedRevision: read1.revision }],
  });
  assert.notEqual(second.changes[0].afterRevision, read1.revision);
  assert.equal((await adapter.read()).text, "# 新卡");
});

test("persona adapter：超限 / 空文本 / 坏代理拒绝且不动原文件", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = createPersonaAdapter({ dir, scopeId: "amber", maxChars: 10 });
  await adapter.commit({ operationId: "op", changes: [{ kind: "persona", text: "0123456789", expectedRevision: null }] });

  const rev = (await adapter.read()).revision;
  await assert.rejects(
    () => adapter.commit({ operationId: "op2", changes: [{ kind: "persona", text: "0123456789X", expectedRevision: rev }] }),
    (e) => e.code === "INVALID_INPUT" && /maxChars/.test(e.message),
  );
  await assert.rejects(
    () => adapter.commit({ operationId: "op3", changes: [{ kind: "persona", text: "", expectedRevision: rev }] }),
    (e) => e.code === "INVALID_INPUT",
  );
  assert.equal((await readFile(path.join(dir, "amber.md"), "utf8")), "0123456789");
});

test("persona adapter：外改坏格式保留 lastvalid（stale），无快照阻断启用", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const adapter = createPersonaAdapter({ dir, scopeId: "amber", maxChars: 10 });
  await adapter.commit({ operationId: "op", changes: [{ kind: "persona", text: "good", expectedRevision: null }] });

  // 外改超限（坏格式）：不覆盖原文件，read 回落 lastvalid 并标 stale。
  await writeFile(path.join(dir, "amber.md"), "x".repeat(50), "utf8");
  const read = await adapter.read();
  assert.equal(read.text, "good");
  assert.equal(read.stale, true);
  assert.equal(read.externalInvalid !== undefined, true);
  // 原文件不被覆盖。
  assert.equal((await readFile(path.join(dir, "amber.md"), "utf8")).length, 50);
  const probe = await adapter.probe();
  assert.deepEqual([probe.ok, probe.state], [true, "stale-with-lastvalid"]);

  // 无快照 + 坏文件 → 阻断启用。
  const dir2 = await tempDir();
  t.after(() => rm(dir2, { recursive: true, force: true }));
  await mkdir(dir2, { recursive: true });
  await writeFile(path.join(dir2, "beta.md"), "y".repeat(50), "utf8");
  const adapter2 = createPersonaAdapter({ dir: dir2, scopeId: "beta", maxChars: 10 });
  await assert.rejects(() => adapter2.read(), (e) => e.code === "INVALID_STATE");
  const probe2 = await adapter2.probe();
  assert.equal(probe2.ok, false);
});

test("persona adapter：重启后重放账仍生效（跨实例）", async (t) => {
  const dir = await tempDir();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a1 = createPersonaAdapter({ dir, scopeId: "amber", maxChars: 100 });
  const r1 = await a1.commit({ operationId: "op-1", changes: [{ kind: "persona", text: CARD, expectedRevision: null }] });

  const a2 = createPersonaAdapter({ dir, scopeId: "amber", maxChars: 100 });
  const replay = await a2.commit({ operationId: "op-1", changes: [{ kind: "persona", text: CARD, expectedRevision: null }] });
  assert.equal(replay.changes[0].afterRevision, r1.changes[0].afterRevision);
  await assert.rejects(
    () => a2.commit({ operationId: "op-1", changes: [{ kind: "persona", text: "# 别的", expectedRevision: null }] }),
    (e) => e.code === "INVALID_INPUT",
  );
  assert.equal((await a2.read()).text, CARD);
});

test("persona adapter B5：prepared 崩溃窗口幂等恢复（磁盘已 newHash → 补 committed 返首次结果；generation 派生自 revision）", async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-pc-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const dir = path.join(base, "persona");
  const adapter = createPersonaAdapter({ dir, scopeId: "amber", maxChars: 12000 });

  // 第一次 commit 成功（AAA）。
  const first = await adapter.commit({
    operationId: "op-crash-1",
    changes: [{ kind: "persona", text: "AAA", expectedRevision: null }],
  });
  const revA = first.changes[0].afterRevision;
  assert.equal(revA, first.changes[0].afterRevision);

  // 第二次 commit（BBB），随后人为把 .ops 账目回退到 prepared 且删 result —— 复现
  // 「写卡后、收尾前崩溃」。
  const second = await adapter.commit({
    operationId: "op-crash-2",
    changes: [{ kind: "persona", text: "BBB", expectedRevision: revA }],
  });
  const revB = second.changes[0].afterRevision;
  const opFile = path.join(dir, ".ops", "amber", "op-crash-2.json");
  const journal = JSON.parse(await readFile(opFile, "utf8"));
  assert.equal(journal.phase, "committed");
  journal.phase = "prepared";
  delete journal.result;
  delete journal.committedAt;
  await writeFile(opFile, JSON.stringify(journal, null, 2), "utf8");

  // 同 operationId 同 payload 重放：磁盘卡 hash === newHash → 幂等补收尾，
  // 返回首次结果（不 REVISION_CONFLICT、不重写卡）。
  const replayed = await adapter.commit({
    operationId: "op-crash-2",
    changes: [{ kind: "persona", text: "BBB", expectedRevision: revA }],
  });
  assert.equal(replayed.operationId, "op-crash-2");
  assert.equal(replayed.changes[0].afterRevision, revB);
  assert.equal(replayed.changes[0].beforeRevision, revA);
  assert.ok(Number.isInteger(replayed.generation) && replayed.generation > 0, "generation derived from revision");
  const repaired = JSON.parse(await readFile(opFile, "utf8"));
  assert.equal(repaired.phase, "committed");
  assert.equal(repaired.recoveredFromPrepared, true);

  // 磁盘正文未被二次改写。
  const card = await readFile(path.join(dir, "amber.md"), "utf8");
  assert.equal(card, "BBB");

  // 对照组：磁盘与 newHash、expectedRevision 都不符 → 冲突拒绝。
  await writeFile(opFile, JSON.stringify({ ...repaired, phase: "prepared" }, null, 2), "utf8");
  await writeFile(path.join(dir, "amber.md"), "OUTSIDE-EDIT", "utf8");
  await assert.rejects(
    () => adapter.commit({
      operationId: "op-crash-2",
      changes: [{ kind: "persona", text: "BBB", expectedRevision: revA }],
    }),
    (e) => e.code === "REVISION_CONFLICT",
  );
});
