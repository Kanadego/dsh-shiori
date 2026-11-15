// 共享测试脚手架（搭台代码，不是测试文件：fixtures 目录不被 run-tests.mjs 分层收集，
// 文件名也不带 .test.mjs 后缀）。收拢两类曾在各测试文件里各存一份的「stage 搭台」，
// dev 层与发版层（test/release/）共用，改一处两处生效：
//
//   1) 项目 stage：temp 目录复制当前项目 src/ + test/ + package.json，并补一份
//      冻结 G a2 loader 对照夹具——「旧版本 stage 生产位置运行」的搭台
//      （原 test/forgetting/store.test.mjs 与 forgetting/stage-regression.test.mjs
//      各存一份，0.4 分层收口时合并于此）。
//   2) DSH smoke stage：真实 DSH CLI 冒烟所需的环境解析、临时 profile 根、
//      包副本打包（stagePackageCopy）、进程内限时 boot 与 stderr 核查
//      （原 test/plugin/dsh-smoke.test.mjs 内部函数；boot 存活窗口用例拆至
//      test/release/dsh-boot-soak.test.mjs 后抽出共用）。

import { promises as fsp } from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, cpSync } from "node:fs";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 项目根（test/fixtures → 上两级）
const STAGE_WORK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------------------------------------------------------------------------
// 1) 项目 stage：旧版本生产位置运行（forgetting / release 层共用）
// ---------------------------------------------------------------------------

/** stage 内必须补齐的冻结 G a2 loader 对照夹具（organize 冻结对照按此路径取）。 */
export const STAGE_FROZEN_FIXTURE =
  "test/fixtures/frozen/G/a2-226d3f0e-77ea-4a4c-b097-ad6483ebc806/files/src/sparks/store.mjs";

/** 搭一个旧版本 stage：复制 src/ + test/ + package.json，补冻结夹具，返回 stage 目录。 */
export async function createProjectStage({ prefix = "shiori-stage-" } = {}) {
  const stage = await fsp.mkdtemp(join(tmpdir(), prefix));
  for (const name of ["src", "test"]) {
    await fsp.cp(join(STAGE_WORK_ROOT, name), join(stage, name), { recursive: true });
  }
  await fsp.copyFile(join(STAGE_WORK_ROOT, "package.json"), join(stage, "package.json"));
  await fsp.mkdir(dirname(join(stage, STAGE_FROZEN_FIXTURE)), { recursive: true });
  await fsp.copyFile(join(STAGE_WORK_ROOT, STAGE_FROZEN_FIXTURE), join(stage, STAGE_FROZEN_FIXTURE));
  return stage;
}

/** 拆台：删除 stage 目录（幂等，容忍已删）。 */
export async function removeStage(stage) {
  if (stage) {
    await fsp.rm(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

/** 收集 stage 内指定 test/ 子目录的全部测试文件绝对路径。 */
export async function collectStageTestFiles(stage, dirs) {
  const files = [];
  for (const d of dirs) {
    const abs = join(stage, "test", d);
    for (const e of (await fsp.readdir(abs)).sort()) {
      if (e.endsWith(".test.mjs")) files.push(join(abs, e));
    }
  }
  return files;
}

/** 在 stage 内运行旧测试（真实子进程 node --test）。
 *  须剥离子进程的 NODE_TEST_CONTEXT/NODE_TEST_TMP_DIR：否则父测试运行器
 *  会在子进程里留下「递归测试」标记，node --test 会跳过执行并只告警。 */
export function runNodeTestIn(stage, files, timeoutMs = 300_000) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_TMP_DIR;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=tap", ...files], { cwd: stage, env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** 从 TAP 输出提取 tests/pass/fail 计数。 */
export function tapCounts(out) {
  const grab = (re) => Number((out.match(re) || [])[1] ?? -1);
  return { tests: grab(/^# tests (\d+)$/m), pass: grab(/^# pass (\d+)$/m), fail: grab(/^# fail (\d+)$/m) };
}

// ---------------------------------------------------------------------------
// 2) DSH smoke stage：真实 DSH CLI 冒烟（plugin 层 / release 层共用）
// ---------------------------------------------------------------------------

/** 解析本机 DSH CLI 入口；环境变量 DSH_BIN 优先。 */
export function resolveDshBin() {
  const npmGlobal = process.env.DSH_NPM_GLOBAL
    ?? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules");
  return process.env.DSH_BIN ?? join(npmGlobal, "@deepseek-ai", "dsh", "lib", "bin.js");
}

/** owner 归档的 immutable P 提交（board submissions 目录）；绝不读 P 工作副本。
 *  R6 追加：取「最新」提交（attempt 降序 → createdAt 降序），不再硬编码 a1-；
 *  SHIORI_P_SUBMISSION 环境变量可显式指定提交 id（owner 审计用）。清单校验
 *  controller.mjs + protocol.mjs 必须同时在提交内。找不到时返回 null，combined 路径如实 not-run。 */
export function findLatestPSubmission(workQ) {
  const submissionsDir = join(workQ, "..", "..", "submissions", "P");
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

/** R6 第 4 条树形态判定（与 package.test 一致）：工作副本树里 P 的真实
 *  controller/protocol 已在位（无 stub 标记）→ combined 路径可直接用树本体打包。 */
export function treeHasRealPController(workQ) {
  const controllerPath = join(workQ, "src", "plugin", "controller.mjs");
  return existsSync(controllerPath)
    && existsSync(join(workQ, "src", "plugin", "protocol.mjs"))
    && !readFileSync(controllerPath, "utf8").includes("SYNTHETIC TEST STUB");
}

/** F1b：@huggingface/transformers 硬依赖 onnxruntime-node / protobufjs / sharp，三个包都带
 *  安装脚本。pnpm 在非交互运行里一律拒跑未审批的脚本并整体失败（ERR_PNPM_IGNORED_BUILDS），
 *  交互式 GUI 则是弹「允许运行安装脚本：{names}」再重试（dsh-plugin-manager 的
 *  build-approval 把结果写进 profile 的 pnpm-workspace.yaml allowBuilds）。
 *  CLI 安装路径把那次审批预先落盘，等价于用户在 GUI 里点了「允许」。 */
const DEFAULT_BUILD_APPROVALS = ["onnxruntime-node", "protobufjs", "sharp"];

export function seedBuildApprovals(profileDir, approvals = DEFAULT_BUILD_APPROVALS) {
  mkdirSync(profileDir, { recursive: true });
  const file = join(profileDir, "pnpm-workspace.yaml");
  const lines = [
    "packages:",
    "  - .",
    "nodeLinker: hoisted",
    "autoInstallPeers: false",
    "allowBuilds:",
    ...approvals.map((name) => `  ${name}: true`),
    "",
  ];
  writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

/** 临时 DSH 冒烟根：独立 home / agents / cwd / pkg / data / state 目录（隔离真实 profile）。 */
export function createDshStageRoot(prefix) {
  const stage = { root: mkdtempSync(join(tmpdir(), prefix)) };
  stage.home = join(stage.root, "home");
  stage.agents = join(stage.root, "agents");
  stage.cwd = join(stage.root, "cwd");
  stage.pkg = join(stage.root, "pkg");
  stage.data = join(stage.root, "data");
  stage.state = join(stage.root, "state");
  for (const dir of [stage.home, stage.agents, stage.cwd, stage.pkg, stage.data, stage.state]) mkdirSync(dir, { recursive: true });
  return stage;
}

const hostEnv = (root) => ({
  ...process.env,
  DSH_HOME: root.home,
  DSH_AGENTS_HOME: root.home,
  SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
});

/** 真实 DSH CLI 子进程执行（同步）。expectCode=null 表示不校验退出码。 */
export function dshExec({ dshBin, root, args, expectCode = 0 }) {
  let stdout = "";
  let stderr = "";
  let code = 0;
  try {
    stdout = execFileSync(process.execPath, [dshBin, ...args], {
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
}

export const BOOT_SOAK_MS = 30_000;
export const BOOT_MARKER_POLL_MS = 250;

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/** Node 进程内限时 boot（显式终止语义，owner review R5——不依赖外部 timeout 命令）：
 *   reached-marker：marker 文件出现 → 立即终止子进程 → 成功（single 路径用）
 *   soaked：        存活窗口内进程未退出且 stderr 干净 → 终止 → 成功（combined 路径用，
 *                   P 真实 controller 不产生 marker，以「无激活失败/无崩溃签名」为准）
 *   exited-early：  进程自行退出 → 失败（附 exit code 与 stderr）
 *   timeout：       marker 未出现且进程仍存活超过窗口 → 失败 */
export async function bootDsh({ dshBin, root, profile, markerPath = null, soakMs = BOOT_SOAK_MS, pollMs = BOOT_MARKER_POLL_MS }) {
  const child = spawn(process.execPath, [dshBin, "--profile", profile, "--", "--help"], {
    cwd: root.cwd,
    env: hostEnv(root),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const deadline = Date.now() + soakMs;
  let outcome = null;
  while (Date.now() < deadline) {
    if (markerPath && existsSync(markerPath)) { outcome = "reached-marker"; break; }
    if (child.exitCode !== null || child.signalCode !== null) { outcome = "exited-early"; break; }
    await sleep(pollMs);
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
}

/** boot stderr 核查：无激活失败、无崩溃签名。 */
export function assertCleanBootStderr(result, context) {
  assert.ok(!/did not activate/i.test(result.stderr), `${context}: activation failure on stderr:\n${result.stderr.slice(0, 2000)}`);
  assert.ok(!/Unhandled|TypeError|ReferenceError|SyntaxError/.test(result.stderr),
    `${context}: crash signature on stderr:\n${result.stderr.slice(0, 2000)}`);
}

/** 真实 npm pack（包副本目录内），返回 tgz 绝对路径。
 *  版本号从 package.json 读，别把文件名钉死（v0.2.0 发版时钉死过一次，smoke 全红）。 */
export function packTgz(pkgDir) {
  execFileSync("npm pack --silent", { cwd: pkgDir, encoding: "utf8", shell: true, windowsHide: true });
  const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  return join(pkgDir, `dsh-shiori-${version}.tgz`);
}

/** 工作副本 → temp 包副本（不含 REPORT/RESULT/test/collab；stub 只写入副本）。
 *  stubs 传 { controller, protocol } 时写入 SYNTHETIC 占位（single 路径专用）；
 *  overlayP + pFiles 时叠加 owner 归档的 immutable P 提交生产文件（combined 路径）。 */
export function stagePackageCopy({ workQ, targetPkg, overlayP = false, pFiles = null, writeStubs = false, stubs = null }) {
  for (const entry of ["package.json", "index.mjs", "cordis.patch.yml", "README.md", "src", "client", "docs"]) {
    cpSync(join(workQ, entry), join(targetPkg, entry), { recursive: true });
  }
  if (overlayP && pFiles) {
    // combined：叠加 owner 归档的 immutable P 提交生产文件；绝不写 stub
    cpSync(pFiles, targetPkg, { recursive: true });
  }
  if (writeStubs) {
    if (!stubs) throw new Error("writeStubs=true requires stubs: { controller, protocol }");
    writeFileSync(join(targetPkg, "src", "plugin", "controller.mjs"), stubs.controller);
    writeFileSync(join(targetPkg, "src", "plugin", "protocol.mjs"), stubs.protocol);
  }
  return packTgz(targetPkg);
}

/** 拆台：删除 DSH 冒烟临时根（幂等）。 */
export function removeDshStageRoot(stage) {
  if (stage?.root) rmSync(stage.root, { recursive: true, force: true });
}
