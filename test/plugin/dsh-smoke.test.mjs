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
//     由本测试显式终止子进程并核对 stderr。
//   - 不触真实 profile / 记忆 / 凭据；不联网装依赖；不发模型请求；3080 不受影响。
//
// 本测试耗时较长（多次真实 pnpm add/remove + 限时 boot），属于发布闸门级用例。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";

const WORKQ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DSH_BIN = "C:/Users/crash/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/lib/bin.js";
const BOOT_SOAK_MS = 30_000;
const BOOT_MARKER_POLL_MS = 250;

if (!existsSync(DSH_BIN)) {
  test("dsh-smoke：本机无 DSH 0.2.1-rc.2 安装，按契约如实 not-run", () => {
    assert.ok(true, "DSH host not installed on this machine; smoke not-run per contract");
  });
}

// owner 归档的 immutable P 提交（board submissions 目录）；绝不读 P 工作副本。
// R6 追加：取「最新」提交（attempt 降序 → createdAt 降序），不再硬编码 a1-；
// SHIORI_P_SUBMISSION 环境变量可显式指定提交 id（owner 审计用）。清单校验
// controller.mjs + protocol.mjs 必须同时在提交内。找不到时返回 null，combined 路径如实 not-run。
function findLatestPSubmission() {
  const submissionsDir = join(WORKQ, "..", "..", "submissions", "P");
  const explicit = process.env.SHIORI_P_SUBMISSION;
  if (explicit) {
    const files = join(submissionsDir, explicit, "files");
    if (!existsSync(join(files, "src", "plugin", "controller.mjs")) || !existsSync(join(files, "src", "plugin", "protocol.mjs"))) {
      return null;
    }
    return { id: explicit, files };
  }
  if (!existsSync(submissionsDir)) return null;
  const candidates = [];
  for (const entry of readdirSync(submissionsDir)) {
    const files = join(submissionsDir, entry, "files");
    if (!existsSync(join(files, "src", "plugin", "controller.mjs"))) continue;
    if (!existsSync(join(files, "src", "plugin", "protocol.mjs"))) continue;
    let attempt = 0;
    let createdAt = "";
    try {
      const manifest = JSON.parse(readFileSync(join(submissionsDir, entry, "manifest.json"), "utf8"));
      attempt = Number(manifest.attempt) || 0;
      createdAt = String(manifest.createdAt ?? "");
    } catch { /* 清单不可解析按最旧处理 */ }
    candidates.push({ id: entry, files, attempt, createdAt });
  }
  candidates.sort((a, b) => (b.attempt - a.attempt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return candidates[0] ?? null;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function runSuite() {
  const pSubmission = findLatestPSubmission();
  const pFiles = pSubmission ? pSubmission.files : null;
  // R6 追加第 4 条：树形态判定与 package.test 一致——owner 合并树里 P 的真实
  // controller/protocol 已在 WORKQ（无 stub 标记），combined 路径直接用树本体
  // 打包（不写 stub、不依赖 submissions 目录可达）；单槽提交树则仍要求
  // immutable P 提交可解析，否则 combined 如实 not-run。
  const workqControllerPath = join(WORKQ, "src", "plugin", "controller.mjs");
  const treeHasRealP = existsSync(workqControllerPath)
    && existsSync(join(WORKQ, "src", "plugin", "protocol.mjs"))
    && !readFileSync(workqControllerPath, "utf8").includes("SYNTHETIC TEST STUB");
  // 实际使用的 P 来源（写进 combined 测试名；RESULT.json 引用）
  globalThis.P_SUBMISSION_ID = pSubmission ? pSubmission.id : (treeHasRealP ? "worktree(merged tree)" : null);
  let smoke = null;
  let combined = null;

  const hostEnv = (root) => ({
    ...process.env,
    DSH_HOME: root.home,
    DSH_AGENTS_HOME: root.home,
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
  });

  const dsh = (root, profile, args, { expectCode = 0 } = {}) => {
    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      stdout = execFileSync(process.execPath, [DSH_BIN, ...args], {
        cwd: root.cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: 240_000,
        env: hostEnv(root),
      });
    } catch (error) {
      code = error.status ?? 1;
      stdout = String(error.stdout ?? "");
      stderr = String(error.stderr ?? "");
    }
    if (expectCode !== null) assert.equal(code, expectCode, `dsh ${args.join(" ")} exit=${code}\nstderr: ${stderr.slice(0, 2000)}`);
    return { code, stdout, stderr };
  };

  // Node 进程内限时 boot（显式终止语义，owner review R5）：
  //   reached-marker：marker 文件出现 → 立即终止子进程 → 成功（single 路径用）
  //   soaked：        存活窗口内进程未退出且 stderr 干净 → 终止 → 成功（combined 路径用，
  //                   P 真实 controller 不产生 marker，以「无激活失败/无崩溃签名」为准）
  //   exited-early：  进程自行退出 → 失败（附 exit code 与 stderr）
  //   timeout：       marker 未出现且进程仍存活超过窗口 → 失败
  const boot = async (root, profile, { markerPath = null } = {}) => {
    const child = spawn(process.execPath, [DSH_BIN, "--profile", profile, "--", "--help"], {
      cwd: root.cwd,
      env: hostEnv(root),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const deadline = Date.now() + BOOT_SOAK_MS;
    let outcome = null;
    while (Date.now() < deadline) {
      if (markerPath && existsSync(markerPath)) { outcome = "reached-marker"; break; }
      if (child.exitCode !== null || child.signalCode !== null) { outcome = "exited-early"; break; }
      await sleep(BOOT_MARKER_POLL_MS);
    }
    if (outcome === null) outcome = markerPath ? "timeout" : "soaked";
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
    await new Promise((resolveExit) => {
      if (child.exitCode !== null || child.signalCode !== null) resolveExit();
      else {
        child.once("exit", resolveExit);
        setTimeout(resolveExit, 5000);
      }
    });
    return { outcome, stderr, exitCode: child.exitCode, signal: child.signalCode };
  };

  const assertCleanBootStderr = (result, context) => {
    assert.ok(!/did not activate/i.test(result.stderr), `${context}: activation failure on stderr:\n${result.stderr.slice(0, 2000)}`);
    assert.ok(!/Unhandled|TypeError|ReferenceError|SyntaxError/.test(result.stderr),
      `${context}: crash signature on stderr:\n${result.stderr.slice(0, 2000)}`);
  };

  const packTgz = (pkgDir) => {
    execFileSync("npm pack --silent", { cwd: pkgDir, encoding: "utf8", shell: true, windowsHide: true });
    return join(pkgDir, "dsh-shiori-0.1.0-alpha.1.tgz");
  };

  const stagePackageCopy = (targetPkg, { overlayP = false, writeStubs = false } = {}) => {
    // 工作副本 → temp 包副本（不含 REPORT/RESULT/test/collab；stub 只写入副本）
    for (const entry of ["package.json", "index.mjs", "cordis.patch.yml", "README.md", "src", "client", "docs"]) {
      cpSync(join(WORKQ, entry), join(targetPkg, entry), { recursive: true });
    }
    if (overlayP && pFiles) {
      // combined：叠加 owner 归档的 immutable P 提交生产文件；绝不写 stub
      cpSync(pFiles, targetPkg, { recursive: true });
    }
    if (writeStubs) {
      writeFileSync(join(targetPkg, "src", "plugin", "controller.mjs"), STUB_CONTROLLER);
      writeFileSync(join(targetPkg, "src", "plugin", "protocol.mjs"), STUB_PROTOCOL);
    }
    return packTgz(targetPkg);
  };

  const profileManifest = (root) => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  before(() => {
    smoke = { root: mkdtempSync(join(tmpdir(), "shiori-q-dsh-smoke-")) };
    smoke.home = join(smoke.root, "home");
    smoke.agents = join(smoke.root, "agents");
    smoke.cwd = join(smoke.root, "cwd");
    smoke.pkg = join(smoke.root, "pkg");
    smoke.data = join(smoke.root, "data");
    smoke.state = join(smoke.root, "state");
    smoke.profile = join(smoke.home, "profiles", "shiori-smoke");
    for (const dir of [smoke.home, smoke.agents, smoke.cwd, smoke.pkg, smoke.data, smoke.state]) mkdirSync(dir, { recursive: true });
    smoke.tgz = stagePackageCopy(smoke.pkg, { writeStubs: true });

    if (pFiles || treeHasRealP) {
      combined = { root: mkdtempSync(join(tmpdir(), "shiori-q-dsh-combined-")) };
      combined.home = join(combined.root, "home");
      combined.agents = join(combined.root, "agents");
      combined.cwd = join(combined.root, "cwd");
      combined.pkg = join(combined.root, "pkg");
      combined.data = join(combined.root, "data");
      combined.state = join(combined.root, "state");
      combined.profile = join(combined.home, "profiles", "shiori-smoke-p");
      for (const dir of [combined.home, combined.agents, combined.cwd, combined.pkg, combined.data, combined.state]) mkdirSync(dir, { recursive: true });
      combined.tgz = stagePackageCopy(combined.pkg, { overlayP: Boolean(pFiles) });
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
    for (const stage of [smoke, combined]) {
      if (stage?.root) rmSync(stage.root, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // single 路径（SYNTHETIC controller/protocol stub，仅存在于 temp 包副本）
  // ---------------------------------------------------------------------------

  test("single：真实 dsh plugin add——tgz 激活为 bundle，profile 清单追加 dsh-shiori", () => {
    const result = dsh(smoke, "shiori-smoke", ["plugin", "--profile", "shiori-smoke", "add", smoke.tgz]);
    assert.ok(result.stdout.includes("dsh-shiori 0.1.0-alpha.1"), `pnpm installed the package:\n${result.stdout.slice(-500)}`);
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
    assert.ok(result.stdout.includes("dsh-shiori 0.1.0-alpha.1"), `combined add output:\n${result.stdout.slice(-500)}`);
    const bundles = profileManifest(combined.profile).dsh.profile.bundles;
    assert.ok(bundles.includes("dsh-shiori"), "combined profile bundles gains dsh-shiori");
    const dump = dsh(combined, "shiori-smoke-p", ["--profile", "shiori-smoke-p", "--dump-config"]);
    assert.ok(dump.stdout.includes("id: shiori") && dump.stdout.includes("name: dsh-shiori"),
      "combined composed tree contains the shiori entry (real P controller + Q shell)");
  });

  test(`${combinedLabel}：boot 存活窗口（inert shadow，无激活失败/无崩溃签名，由本测试显式终止）`, { timeout: 90_000 }, async () => {
    if (!combinedAvailable) return;
    const result = await boot(combined, "shiori-smoke-p");
    assert.ok(result.outcome === "soaked" || result.outcome === "reached-marker",
      `combined boot outcome=${result.outcome} exit=${result.exitCode} signal=${result.signal}\nstderr: ${result.stderr.slice(0, 2000)}`);
    assertCleanBootStderr(result, "combined boot");
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
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function createShioriPluginController(ctx, settings) {
  const state = { started: 0, stopped: 0, mode: settings.mode, dataRoot: settings.dataRoot };
  const methods = ["getStatus", "getMemoryView", "getGraph", "executeTool", "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan"];
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
        await writeFile(join(state.dataRoot, "shiori-smoke-start-marker.txt"),
          "SYNTHETIC controller start #" + state.started + "\\n", "utf8");
      }
    },
    async stop() { state.stopped += 1; },
    diagnostics() { return state; },
  };
}
`;

const STUB_PROTOCOL = `// SYNTHETIC TEST STUB — slot Q single-slot smoke verification ONLY (never shipped).
// Mirrors the frozen CONTRACTS §6 wire for mountShioriRpc wiring.
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
};
const ALLOWED = {
  getStatus: [], getMemoryView: [], getGraph: [], listCandidates: [],
  executeTool: ["name", "args"],
  analyze: ["kind", "operationId", "expectedQueueRevision"],
  reviewCandidate: ["candidateId", "decision", "expectedQueueRevision", "operationId"],
  previewPlan: ["kind", "candidateId", "proposal", "expectedQueueRevision", "operationId", "planId"],
  executePlan: ["planId", "planDigest", "operationId", "confirmed"],
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
