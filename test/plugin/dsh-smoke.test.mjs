// P5-Q 隔离真实 DSH CLI 冒烟：全新 temp profile（独立 DSH_HOME / DSH_AGENTS_HOME / cwd），
// 用本地 tgz 走原生 `dsh plugin --profile <n> add/remove`，验证激活 / 重复安装不重复 bundle /
// dump-config 装配 / boot 真实挂载 / 卸载保留数据。
//
// 证据级别如实标注（CONTRACTS §8）：
//   - single 路径：controller.mjs / protocol.mjs 为 SYNTHETIC stub（P 未组合；只存在于
//     本测试的一次性 temp 包副本，绝不进入工作副本白名单或 tarball）；
//   - combined 路径（owner review R5 要求的「无 stub 替换」）：当 owner 归档的 immutable
//     P 提交（phase6/collab/submissions/P/<id>/files，含 src/plugin/controller.mjs 与
//     protocol.mjs）存在时，叠加其全部已提交生产文件后 pack/add/dump/boot——此时不写
//     任何 stub。P 提交不存在时该路径如实 not-run（绝不读 P 工作副本）。
//     R6 追加（owner review r-abffad61 §五.1）：取该槽「最新」提交（attempt/createdAt
//     排序），不再硬编码 a1-；可用环境变量 SHIORI_P_SUBMISSION 显式指定提交 id 覆盖。
//     实际使用的 submission id 写入测试名并经 P_SUBMISSION_ID 暴露给 REPORT/RESULT。
//   - boot 终止语义（owner review R5：不依赖外部 timeout 命令——GNU timeout 在 Windows
//     PowerShell 下解析为 timeout.exe，语义完全不同）：Node 进程内轮询 marker / 存活窗口，
//     由本测试显式终止子进程并核对 stderr。限时 boot 三件套（boot / dsh / stderr 核查）
//     抽至 test/fixtures/stage.mjs 共享脚手架，与发版层共用。
//   - 不触真实 profile / 记忆 / 凭据；不联网装依赖；不发模型请求；3080 不受影响。
//
// 本测试耗时较长（多次真实 pnpm add/remove + 限时 boot），属于发布闸门级用例。
// 0.4 分层收口二期：combined 的「boot 存活窗口」用例（timeout 90s，dev 层最大
// 耗时项）已拆至 test/release/dsh-boot-soak.test.mjs（发版门禁层，断言原样搬移）。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveDshBin, findLatestPSubmission, treeHasRealPController, createDshStageRoot,
  seedBuildApprovals, stagePackageCopy, dshExec, bootDsh, assertCleanBootStderr,
  removeDshStageRoot,
} from "../fixtures/stage.mjs";

const WORKQ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DSH_BIN = resolveDshBin();

if (!existsSync(DSH_BIN)) {
  test("dsh-smoke：本机无 DSH 0.2.1-rc.2 安装，按契约如实 not-run", () => {
    assert.ok(true, "DSH host not installed on this machine; smoke not-run per contract");
  });
}

function runSuite() {
  const pSubmission = findLatestPSubmission(WORKQ);
  const pFiles = pSubmission ? pSubmission.files : null;
  // R6 追加第 4 条：树形态判定与 package.test 一致——owner 合并树里 P 的真实
  // controller/protocol 已在 WORKQ（无 stub 标记），combined 路径直接用树本体
  // 打包（不写 stub、不依赖 submissions 目录可达）；单槽提交树则仍要求
  // immutable P 提交可解析，否则 combined 如实 not-run。
  const treeHasRealP = treeHasRealPController(WORKQ);
  // 实际使用的 P 来源（写进 combined 测试名；RESULT.json 引用）
  globalThis.P_SUBMISSION_ID = pSubmission ? pSubmission.id : (treeHasRealP ? "worktree(merged tree)" : null);
  let smoke = null;
  let combined = null;

  // 薄包装：保持原有调用点形状；实现统一在 test/fixtures/stage.mjs（与发版层共用）
  const dsh = (root, profile, args, { expectCode = 0 } = {}) => dshExec({ dshBin: DSH_BIN, root, args, expectCode });
  const boot = (root, profile, { markerPath = null } = {}) => bootDsh({ dshBin: DSH_BIN, root, profile, markerPath });
  const profileManifest = (root) => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const stagePkgCopy = (targetPkg, opts = {}) =>
    stagePackageCopy({ workQ: WORKQ, targetPkg, pFiles, ...opts });

  before(() => {
    smoke = createDshStageRoot("shiori-q-dsh-smoke-");
    smoke.profile = join(smoke.home, "profiles", "shiori-smoke");
    smoke.tgz = stagePkgCopy(smoke.pkg, { writeStubs: true, stubs: { controller: STUB_CONTROLLER, protocol: STUB_PROTOCOL } });
    seedBuildApprovals(smoke.profile);

    if (pFiles || treeHasRealP) {
      combined = createDshStageRoot("shiori-q-dsh-combined-");
      combined.profile = join(combined.home, "profiles", "shiori-smoke-p");
      combined.tgz = stagePkgCopy(combined.pkg, { overlayP: Boolean(pFiles) });
      seedBuildApprovals(combined.profile);
      // R6 追加第 4 条：combined 必须真的加载 P 的 controller，不许「声明 combined 却跑 stub」。
      const combinedController = readFileSync(join(combined.pkg, "src", "plugin", "controller.mjs"), "utf8");
      assert.ok(!combinedController.includes("SYNTHETIC TEST STUB"), "combined pkg must not contain the synthetic stub controller");
      if (pSubmission) {
        assert.equal(combinedController,
          readFileSync(join(pSubmission.files, "src", "plugin", "controller.mjs"), "utf8"),
          "combined pkg controller.mjs must be byte-identical to the P submission");
      }
    }
  });

  after(() => {
    for (const stage of [smoke, combined]) removeDshStageRoot(stage);
  });

  // ---------------------------------------------------------------------------
  // single 路径（SYNTHETIC controller/protocol stub，仅存在于 temp 包副本）
  // ---------------------------------------------------------------------------

  test("single：真实 dsh plugin add——tgz 激活为 bundle，profile 清单追加 dsh-shiori", () => {
    const result = dsh(smoke, "shiori-smoke", ["plugin", "--profile", "shiori-smoke", "add", smoke.tgz]);
    assert.match(result.stdout, /dsh-shiori \d+\.\d+\.\d+/, `pnpm installed the package:\n${result.stdout.slice(-500)}`);
    const bundles = profileManifest(smoke.profile).dsh.profile.bundles;
    assert.ok(bundles.includes("dsh-shiori"), "dsh.profile.bundles gains dsh-shiori");
    assert.ok(bundles.includes("@deepseek-ai/dsh-base"), "base bundle retained");
  });

  test("single：重复 add 不重复 bundle", () => {
    dsh(smoke, "shiori-smoke", ["plugin", "--profile", "shiori-smoke", "add", smoke.tgz]);
    const bundles = profileManifest(smoke.profile).dsh.profile.bundles;
    assert.equal(bundles.filter((name) => name === "dsh-shiori").length, 1, "no duplicate bundle row");
  });

  test("single：--dump-config 真实 Cordis 装配 + Config schema 编译（EXIT=0，含 shiori 行）", () => {
    const result = dsh(smoke, "shiori-smoke", ["--profile", "shiori-smoke", "--dump-config"]);
    assert.ok(result.stdout.includes("id: shiori") && result.stdout.includes("name: dsh-shiori"),
      "composed tree contains the shiori entry");
  });

  test("single：boot（active 配置）真实 apply 执行，Node 进程内限时 + 显式终止 + stderr 核查", async () => {
    writeFileSync(join(smoke.profile, "cordis.patch.yml"),
      `- id: shiori\n  config:\n    mode: active\n    allowActive: true\n    dataRoot: ${smoke.data.replace(/\\/g, "/")}\n    stateRoot: ${smoke.state.replace(/\\/g, "/")}\n`);
    const marker = join(smoke.data, "shiori-smoke-start-marker.txt");
    const first = await boot(smoke, "shiori-smoke", { markerPath: marker });
    assert.equal(first.outcome, "reached-marker", `boot #1 outcome=${first.outcome} exit=${first.exitCode} signal=${first.signal}\nstderr: ${first.stderr.slice(0, 2000)}`);
    assertCleanBootStderr(first, "boot #1");
    assert.match(readFileSync(marker, "utf8"), /^SYNTHETIC controller start #\d+\n$/);
    // 第二次 boot（全新进程）：真实重新挂载，start 再次执行（计数按进程重置，属预期）
    rmSync(marker);
    const second = await boot(smoke, "shiori-smoke", { markerPath: marker });
    assert.equal(second.outcome, "reached-marker", `boot #2 outcome=${second.outcome}\nstderr: ${second.stderr.slice(0, 2000)}`);
    assertCleanBootStderr(second, "boot #2");
    assert.ok(existsSync(marker), "second boot remounts and start runs again");
  });

  test("single：真实 dsh plugin remove——包/挂载/dump-config 三重验证移除，dataRoot 数据保留", () => {
    const keep = join(smoke.data, "uninstall-keep.txt");
    writeFileSync(keep, "data survives uninstall\n");
    const result = dsh(smoke, "shiori-smoke", ["plugin", "--profile", "shiori-smoke", "remove", "dsh-shiori"]);
    assert.equal(result.code, 0);
    const bundles = profileManifest(smoke.profile).dsh.profile.bundles;
    assert.ok(!bundles.includes("dsh-shiori"), "bundle row removed");
    assert.ok(!existsSync(join(smoke.profile, "node_modules", "dsh-shiori")), "package directory removed from profile");
    // dump-config 不再含 shiori 装配行（真实 CLI 证据，而非仅清单文件断言）
    const dump = dsh(smoke, "shiori-smoke", ["--profile", "shiori-smoke", "--dump-config"]);
    assert.ok(!dump.stdout.includes("name: dsh-shiori"), "shiori no longer composes after remove");
    assert.ok(existsSync(keep), "dataRoot contents survive uninstall");
  });

  // ---------------------------------------------------------------------------
  // combined 路径（owner 归档 immutable P 提交，无 stub 替换；不可用时如实 not-run）
  //
  // 「boot 存活窗口」用例（timeout 90s，dev 层最大耗时项）已拆至
  // test/release/dsh-boot-soak.test.mjs（发版门禁层，断言原样搬移）。
  // ---------------------------------------------------------------------------

  const combinedAvailable = Boolean(pFiles || treeHasRealP);
  const combinedLabel = pSubmission
    ? `combined（P submission ${pSubmission.id}，无 stub）`
    : treeHasRealP
      ? "combined（合并树本体含真实 P controller，无 stub）"
      : "combined（owner 归档 P 提交不可用：如实 not-run）";

  test(`${combinedLabel}：真实 add + dump-config（无 stub 的 P controller/protocol 参与装配）`, () => {
    if (!combinedAvailable) return;
    const result = dsh(combined, "shiori-smoke-p", ["plugin", "--profile", "shiori-smoke-p", "add", combined.tgz]);
    assert.match(result.stdout, /dsh-shiori \d+\.\d+\.\d+/, `combined add output:\n${result.stdout.slice(-500)}`);
    const bundles = profileManifest(combined.profile).dsh.profile.bundles;
    assert.ok(bundles.includes("dsh-shiori"), "combined profile bundles gains dsh-shiori");
    const dump = dsh(combined, "shiori-smoke-p", ["--profile", "shiori-smoke-p", "--dump-config"]);
    assert.ok(dump.stdout.includes("id: shiori") && dump.stdout.includes("name: dsh-shiori"),
      "combined composed tree contains the shiori entry (real P controller + Q shell)");
  });
}

// ---------------------------------------------------------------------------
// SYNTHETIC stubs（single 路径专用；仅写入 temp 包副本，如实标注，
// 绝不进入工作副本/白名单/tarball；combined 路径不使用）
// ---------------------------------------------------------------------------

const STUB_CONTROLLER = `// SYNTHETIC TEST STUB — slot Q single-slot smoke verification ONLY (never shipped).
// Stands in for P's src/plugin/controller.mjs (single-slot mode only). With explicit
// roots + allowActive it writes a start marker under dataRoot to prove real
// mounting under the host and to demonstrate that remove preserves data.
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function createShioriPluginController(ctx, settings) {
  const state = { started: 0, stopped: 0, mode: settings.mode, dataRoot: settings.dataRoot };
  // 桩的 management 方法清单同为 CONTRACT_METHODS 镜像（与下方 STUB_PROTOCOL 同步维护；
  // 0.5 批次 4 C 线 wire 11→14：destroyData 之后依次追加 onboardingPreview/Apply/Mark）。
  const methods = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan", "getTimeline", "destroyData", "onboardingPreview", "onboardingApply", "onboardingMark"];
  const management = Object.fromEntries(methods.map((method) => [
    method,
    async () => ({ mode: state.mode, method, synthetic: true, started: state.started, stopped: state.stopped }),
  ]));
  return {
    management,
    async start() {
      state.started += 1;
      if (state.mode === "active" && state.dataRoot) {
        await mkdir(state.dataRoot, { recursive: true });
        // marker 先写临时文件再 rename：文件对轮询方（boot 的 existsSync 轮询）
        // 原子可见。直接 writeFile 时 open→write 之间文件已存在但内容为空，
        // 轮询恰好落进该窗口就会读到空串、令 assert.match 假红（满载并发下
        // 偶发）。rename 同目录原子生效，可见即完整。
        const marker = join(state.dataRoot, "shiori-smoke-start-marker.txt");
        const tmp = marker + ".tmp";
        await writeFile(tmp, "SYNTHETIC controller start #" + state.started + "\\n", "utf8");
        await rename(tmp, marker);
      }
    },
    async stop() { state.stopped += 1; },
    diagnostics() { return state; },
  };
}
`;

const STUB_PROTOCOL = `// SYNTHETIC TEST STUB — slot Q single-slot smoke verification ONLY (never shipped).
// Mirrors the frozen CONTRACTS §6 wire for mountShioriRpc wiring.
// 本桩是 wire 契约的镜像，不是独立实现的自由：方法清单须与 src/plugin/client-rpc.mjs
// 的 CONTRACT_METHODS 逐项同步（同序同字），否则 mountShioriRpc 的挂载闸会当场拒绝。
export const MANAGEMENT_METHODS = {
  getStatus: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  getMemoryView: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  getGraph: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  executeTool: { inputSchema: { type: "object", required: ["name", "args"] }, outputSchema: { type: "object" } },
  listCandidates: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  analyze: { inputSchema: { type: "object", required: ["kind"] }, outputSchema: { type: "object" } },
  reviewCandidate: { inputSchema: { type: "object", required: ["candidateId", "decision"] }, outputSchema: { type: "object" } },
  previewPlan: { inputSchema: { type: "object", required: ["kind"] }, outputSchema: { type: "object" } },
  executePlan: { inputSchema: { type: "object", required: ["planId", "planDigest", "operationId", "confirmed"] }, outputSchema: { type: "object" } },
  getTimeline: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  destroyData: { inputSchema: { type: "object", required: ["confirm"] }, outputSchema: { type: "object" } },
  onboardingPreview: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
  onboardingApply: { inputSchema: { type: "object", required: ["proposal", "hash", "operationId", "confirmed"] }, outputSchema: { type: "object" } },
  onboardingMark: { inputSchema: { type: "object" }, outputSchema: { type: "object" } },
};
const ALLOWED = {
  getStatus: [], getMemoryView: [], getGraph: [], listCandidates: [],
  executeTool: ["name", "args"],
  analyze: ["kind", "operationId", "expectedQueueRevision"],
  reviewCandidate: ["candidateId", "decision", "expectedQueueRevision", "operationId"],
  previewPlan: ["kind", "candidateId", "proposal", "expectedQueueRevision", "operationId", "planId"],
  executePlan: ["planId", "planDigest", "operationId", "confirmed"],
  getTimeline: ["offset", "limit"],
  destroyData: ["confirm"],
  onboardingPreview: ["proposal"],
  onboardingApply: ["proposal", "hash", "operationId", "confirmed"],
  onboardingMark: ["dismiss", "restart", "hash"],
};
export function validateManagementPayload(name, payload) {
  const fail = (message) => { const e = new Error(message); e.code = "INVALID_INPUT"; throw e; };
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, name)) fail("unknown method " + name);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) fail("payload must be a plain object");
  for (const key of Object.keys(payload)) if (!ALLOWED[name].includes(key)) fail('unknown key "' + key + '"');
  for (const key of MANAGEMENT_METHODS[name].inputSchema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) fail('missing required key "' + key + '"');
  }
}
`;

runSuite();
