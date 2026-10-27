// P5 · 真实宿主跨 scope 人设回归（slot P；a3 返工）。
//
// 实机缺陷（owner 在真实 dsh 0.2.1-rc.2 复现）：desktop/web 默认配置的
// preset-minimal 子上下文注册了 complete:true 的 persona section；旧实现遍历
// layers.scoped 全部 scope 做「complete 探测」，把全局 L0/L1 一起判死 →
// controller 启动时零注册、l0l1Effective:false，人设卡与 core 永不进系统提示。
//
// 本文件用真实 @deepseek-ai/cordis + dsh-system-prompt + dsh-scope 构造与宿主
// 同构的注册表，验证两件事：
// 1) scope 侧 complete section 不影响本包 L0/L1 注册与 global 装配注入；
// 2) complete 遮蔽只对**它所属的那一次 assembly** 成立（宿主
//    dsh-system-prompt lib/index.js:380-403 的可见快照替换），且 diagnostics
//    如实记账（不谎报 l0l1Effective:true）。
//
// 发现策略与 host-contract.test.mjs 一致：解析不到真实包时 skip 并如实标注。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createShioriPluginController } from "../../src/plugin/controller.mjs";

let host = null;
try {
  const [{ Context }, systemPromptMod, scopeMod] = await Promise.all([
    import("@deepseek-ai/cordis"),
    import("@deepseek-ai/dsh-system-prompt"),
    import("@deepseek-ai/dsh-scope"),
  ]);
  host = {
    Context,
    SystemPrompt: systemPromptMod.default ?? systemPromptMod.SystemPrompt,
    createScope: scopeMod.createScope,
    scopeOf: scopeMod.scopeOf,
  };
} catch {
  host = null;
}

const CARD_TEXT = "CARD-TEXT-FROM-DISK";
const CORE_TEXT = "CORE-TEXT-FROM-DISK";

test("真实宿主：preset-minimal 的 complete persona 不误杀 L0/L1，global 装配含人设卡与 core；该 scope 装配如实记账", async (t) => {
  if (!host) {
    t.skip("real @deepseek-ai/{cordis,dsh-system-prompt,dsh-scope} not resolvable on this machine (RESULT.json marks this check not-run)");
    return;
  }
  const { Context, SystemPrompt, createScope, scopeOf } = host;
  assert.equal(typeof Context, "function");
  assert.equal(typeof SystemPrompt, "function");
  assert.equal(typeof createScope, "function");

  const base = await mkdtemp(path.join(tmpdir(), "shiori-p5-host-scope-"));
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  await mkdir(path.join(dataRoot, "persona"), { recursive: true });
  await mkdir(path.join(dataRoot, "scopes", "amber"), { recursive: true });
  await writeFile(path.join(dataRoot, "persona", "amber.md"), CARD_TEXT, "utf8");
  await writeFile(path.join(dataRoot, "scopes", "amber", "core.md"), CORE_TEXT, "utf8");

  const root = new Context();
  try {
    await root.plugin(SystemPrompt, {});
    assert.equal(typeof root.systemPrompt?.assemble, "function");

    // 宿主同构：desktop/web 的 preset-minimal 子上下文注册 complete:true persona。
    const preset = createScope(root, "preset-minimal");
    await preset.ctx.inject(["systemPrompt"], async (scoped) => {
      scoped.systemPrompt.section({ name: "persona", order: -1000, text: "HOST-COMPLETE-CARD", complete: true });
    });
    const presetScope = scopeOf(preset.ctx);
    assert.equal(presetScope, "preset-minimal");

    // 本包控制器：真实 systemPrompt 服务 + 捕获 tools.register / 真实事件总线。
    const registeredTools = [];
    const hybrid = {
      systemPrompt: root.systemPrompt,
      tools: {
        register: (def) => {
          registeredTools.push(def.name);
          return () => {};
        },
      },
      on: root.on.bind(root),
    };
    const controller = await createShioriPluginController(hybrid, {
      mode: "active",
      allowActive: true,
      dataRoot,
      stateRoot,
      ownerId: "local",
      defaultPersona: "amber",
      l2: { enabled: false },
    }, {});
    try {
      const started = await controller.start();
      // 缺陷 A 修复点：跨 scope 的 complete 不参与启动期判定 → L0/L1 照常注册。
      assert.deepEqual(started.sections, ["shiori:persona", "shiori:core"]);
      assert.equal(started.completeProbe, "none");
      assert.deepEqual(started.completeShadowed, []);
      assert.equal(started.l0l1Effective, true);
      assert.equal(started.tools.length, 16);
      assert.equal(registeredTools.length, 16);

      // 1) global 装配（无 scope）：人设卡与 core 的真实文本必须出现在系统提示里。
      const globalAssembly = await root.systemPrompt.assemble({ agent: { session: { id: "s-real-global" } } });
      const globalNames = globalAssembly.sections.map((s) => s.name);
      assert.ok(globalNames.includes("shiori:persona"), `global assembly must carry shiori:persona, got: ${globalNames.join(" | ")}`);
      assert.ok(globalNames.includes("shiori:core"), `global assembly must carry shiori:core, got: ${globalNames.join(" | ")}`);
      const personaText = globalAssembly.sections.find((s) => s.name === "shiori:persona")?.text ?? "";
      const coreText = globalAssembly.sections.find((s) => s.name === "shiori:core")?.text ?? "";
      assert.ok(personaText.includes(CARD_TEXT), `persona section must carry the card text, got: ${JSON.stringify(personaText.slice(0, 120))}`);
      assert.ok(coreText.includes(CORE_TEXT), `core section must carry the core text, got: ${JSON.stringify(coreText.slice(0, 120))}`);
      let d = controller.diagnostics();
      assert.equal(d.counters.assemblies, 1);
      assert.equal(d.counters.assembliesRefreshed, 1);
      assert.equal(d.assemblyCompleteShadowed, 0);
      assert.equal(d.assemblyCompleteProbe, "none");
      assert.equal(d.l0l1Effective, true);

      // 2) preset-minimal 装配：宿主用 complete 快照整体替换 sections（只剩 persona）；
      //    本包必须如实记账这一次遮蔽，不得计入 refreshed、不得宣称 L0/L1 有效。
      const presetAssembly = await root.systemPrompt.assemble({ scope: presetScope, agent: { session: { id: "s-real-preset" } } });
      const presetNames = presetAssembly.sections.map((s) => s.name);
      assert.deepEqual(presetNames, ["persona"], "host must replace sections with the complete-section snapshot");
      d = controller.diagnostics();
      assert.equal(d.assemblyCompleteShadowed, 1);
      assert.equal(d.assemblyCompleteProbe, "ok");
      assert.equal(d.counters.assemblies, 1, "shadowed assembly must not be counted as refreshed");
      assert.ok(d.counters.assemblySkips.some((s) => s.startsWith("complete(")), "shadow must be diagnosed");
      assert.equal(d.l0l1Effective, "unknown", "不可判定 ≠ 有效");
    } finally {
      await controller.stop();
    }
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
