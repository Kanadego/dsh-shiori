// P5-Q 包清单测试：复用 scripts/verify-package.mjs 的纯函数核查 + tarball 白名单断言。
// tarball 检查执行真实 `npm pack --dry-run --json`（本地、离线、不产出文件）。
//
// R5（owner review r-596f3955）：单槽 / 组合两种验收模式必须显式。
//   - single：本工作副本（基线 + Q）。expected-from-P 只作 pending 信息，
//     complete=false 如实标注「不可独立发行」。
//   - combined：任何生产相对 import 缺失即失败；用 temp 合成树（SYNTHETIC 标注）
//     验证模式语义，真实 P 组合闭包由 dsh-smoke 的 combined 路径覆盖（immutable
//     P 提交存在时运行，否则如实 not-run）。
//
// R6（owner review r-abffad61）：断言不得把「Q 单槽提交态」硬编码成产品不变量。
//   最终合成树（P 的 controller.mjs / protocol.mjs 在位）里 WORKQ 自身就是完整
//   闭包，原两条 WORKQ 断言必然翻红。因此按树内实际状态自适应：
//   - hasPFiles=false（单槽提交树）→ 保留 single 断言（expectedFromP 恰为两文件、
//     complete=false、combined 对 WORKQ 必须失败）；
//   - hasPFiles=true（owner 合并树）→ 断言 WORKQ 即完整闭包（complete=true、
//     expectedFromP=[]、combined 通过）。两种形态都有 temp 树证据分支，互不依赖
//     WORKQ 的提交形态。

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runChecks,
  checkPackageJson,
  checkPatchYml,
  checkClientBundle,
  checkTarball,
  checkImports,
  EXPECTED_FROM_P,
} from "../../scripts/verify-package.mjs";

const WORKQ = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(join(WORKQ, "package.json"), "utf8"));

// 树形态判定（R6）：两个跨槽生产文件是否已在树内。owner 合并树 = true。
const hasPFilesInTree = existsSync(join(WORKQ, "src", "plugin", "controller.mjs"))
  && existsSync(join(WORKQ, "src", "plugin", "protocol.mjs"));

// owner 归档的 immutable P 提交（board submissions 目录；绝不读 P 工作副本）。
// 取最新（attempt/createdAt 排序），供 temp 真实叠加树用；不可用时返回 null，
// 相关用例如实 not-run。
function findLatestPSubmission() {
  const submissionsDir = join(WORKQ, "..", "..", "submissions", "P");
  if (!existsSync(submissionsDir)) return null;
  const candidates = [];
  for (const entry of readdirSync(submissionsDir)) {
    const manifestPath = join(submissionsDir, entry, "manifest.json");
    const filesDir = join(submissionsDir, entry, "files");
    if (!existsSync(join(filesDir, "src", "plugin", "controller.mjs"))) continue;
    if (!existsSync(join(filesDir, "src", "plugin", "protocol.mjs"))) continue;
    let attempt = 0;
    let createdAt = "";
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      attempt = Number(manifest.attempt) || 0;
      createdAt = String(manifest.createdAt ?? "");
    } catch { /* 无法解析的清单按最旧处理 */ }
    candidates.push({ entry, files: filesDir, attempt, createdAt });
  }
  candidates.sort((a, b) => (b.attempt - a.attempt) || b.createdAt.localeCompare(a.createdAt) || b.entry.localeCompare(a.entry));
  return candidates[0] ?? null;
}

const pSubmission = findLatestPSubmission();

test("package.json：包名/版本/license 如实标注（公开发布态）", () => {
  assert.equal(pkg.name, "dsh-shiori");
  assert.equal(pkg.version, "0.1.0");
  assert.equal(pkg.private, undefined, "publishing requires the private flag to be gone");
  assert.equal(pkg.license, "CC-BY-NC-SA-4.0", "license is CC BY-NC-SA 4.0, matching the LICENSE file");
  assert.equal(pkg.type, "module");
});

test("package.json：npm test 显式纳入 test/plugin 且保留旧域脚本", () => {
  assert.ok(pkg.scripts.test.includes("test/plugin/*.test.mjs"), "npm test covers test/plugin");
  for (const domain of ["test/core", "test/host", "test/storage", "test/service", "test/integration", "test/runtime", "test/completion", "test/acceptance", "test/sparks", "test/organize", "test/forgetting"]) {
    assert.ok(pkg.scripts.test.includes(domain), `npm test keeps ${domain}`);
  }
  assert.ok(pkg.scripts["test:p5"].includes("test/plugin"));
  assert.ok(pkg.scripts["verify:package"].includes("verify-package.mjs"));
});

// R6：按树形态自适应（不把「Q 单槽提交态」当不变量）。
//   - 单槽提交树：expectedFromP 恰为两个跨槽文件且 complete=false（诚实标注不可独立发行）；
//   - owner 合并树（P 文件在位）：WORKQ 即完整闭包，complete=true、expectedFromP=[]。
test("imports 核查：按树内 P 文件在位与否自适应（single 模式六项全过）", () => {
  const checks = runChecks({ withTarball: false, mode: "single" });
  for (const check of checks) {
    assert.deepEqual(check.detail, [], `${check.name}: ${check.detail.join("; ")}`);
  }
  const imports = checks.find((c) => c.name === "relative imports");
  if (!hasPFilesInTree) {
    assert.deepEqual(imports.expectedFromP.map((line) => line.split(" ")[0]).sort(), [...EXPECTED_FROM_P].sort(),
      "单槽提交树：expected-from-P 恰为两个跨槽文件（owner 组合后必须在包内）");
    assert.equal(imports.complete, false, "single-slot package is not distributable on its own");
  } else {
    assert.deepEqual(imports.expectedFromP, [], "合并树：跨槽文件已在位，无 pending-from-P");
    assert.equal(imports.complete, true, "合并树即完整闭包，single 模式下也必须 complete");
  }
});

test("combined 模式（temp 合成树）：import 闭包完整则通过；缺任一生产文件即失败", async () => {
  const root = mkdtempSync(join(tmpdir(), "shiori-q-pkg-combined-"));
  try {
    // temp 组合树：Q 全部生产文件 + SYNTHETIC 占位的 P 跨槽文件（仅测模式语义，不发布）
    for (const entry of ["package.json", "index.mjs", "src", "client", "cordis.patch.yml"]) {
      cpSync(join(WORKQ, entry), join(root, entry), { recursive: true });
    }
    writeFileSync(join(root, "src", "plugin", "controller.mjs"),
      "// SYNTHETIC TEST STUB (combined-mode packaging semantics only; NOT shipped).\nexport async function createShioriPluginController() { return {}; }\n");
    writeFileSync(join(root, "src", "plugin", "protocol.mjs"),
      "// SYNTHETIC TEST STUB (combined-mode packaging semantics only; NOT shipped).\nexport const MANAGEMENT_METHODS = {};\nexport function validateManagementPayload() {}\n");
    const ok = checkImports(root, { mode: "combined" });
    assert.equal(ok.ok, true, `combined closure must pass: ${ok.detail.join("; ")}`);
    assert.equal(ok.complete, true);
    assert.deepEqual(ok.expectedFromP, [], "no pending-from-P left in combined tree");

    // 删除任一生产文件 → combined 校验必须失败（不完整包不得视为可发行）
    rmSync(join(root, "src", "plugin", "client-rpc.mjs"));
    const broken = checkImports(root, { mode: "combined" });
    assert.equal(broken.ok, false);
    assert.ok(broken.detail.some((line) => line.includes("client-rpc.mjs")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// R6：WORKQ 断言按树形态自适应——单槽树 combined 必须失败；合并树 combined 必须通过。
test("combined 模式对 WORKQ：单槽树失败 / 合并树通过（按树内 P 文件自适应）", () => {
  const result = checkImports(WORKQ, { mode: "combined" });
  if (!hasPFilesInTree) {
    assert.equal(result.ok, false, "combined mode without P files must fail");
    for (const file of EXPECTED_FROM_P) {
      assert.ok(result.detail.some((line) => line.includes(file)), `combined failure mentions ${file}`);
    }
  } else {
    assert.equal(result.ok, true, `merged tree is a complete combined closure: ${result.detail.join("; ")}`);
    assert.equal(result.complete, true);
    assert.deepEqual(result.expectedFromP, []);
  }
});

// R6 要求 2：两种形态都要有 temp 树证据，且不依赖 WORKQ 的提交形态。
//   - 缺席形态：Q 生产文件 + 无 P → combined 失败并点名两个跨槽文件；
//   - 在位形态：叠加 owner 归档最新 P 提交的真实生产文件（绝不写 stub）→ combined 通过。
test("combined 模式（temp 双形态树）：缺 P 失败、叠真实 P 提交通过（范式切换正确）", () => {
  const absent = mkdtempSync(join(tmpdir(), "shiori-q-pkg-absent-"));
  const present = pSubmission ? mkdtempSync(join(tmpdir(), "shiori-q-pkg-present-")) : null;
  try {
    for (const entry of ["package.json", "index.mjs", "src", "client", "cordis.patch.yml"]) {
      cpSync(join(WORKQ, entry), join(absent, entry), { recursive: true });
    }
    // absent 形态与树形态无关：合并树里 cpSync 会带上在位的 P 文件，这里显式移除，
    // 保证「缺 P 必失败」分支在任何提交形态下都真实成立
    rmSync(join(absent, "src", "plugin", "controller.mjs"), { force: true });
    rmSync(join(absent, "src", "plugin", "protocol.mjs"), { force: true });
    const missing = checkImports(absent, { mode: "combined" });
    assert.equal(missing.ok, false, "Q-only temp tree must fail combined");
    for (const file of EXPECTED_FROM_P) {
      assert.ok(missing.detail.some((line) => line.includes(file)), `combined failure mentions ${file}`);
    }

    if (!present) {
      assert.ok(true, "owner 归档 P 提交不可用：真实叠加分支如实 not-run（合成树分支已覆盖语义）");
      return;
    }
    for (const entry of ["package.json", "index.mjs", "src", "client", "cordis.patch.yml"]) {
      cpSync(join(WORKQ, entry), join(present, entry), { recursive: true });
    }
    // 只叠 P 提交的 src 子树（生产文件）；不碰 package.json（P 不持有它）
    cpSync(join(pSubmission.files, "src"), join(present, "src"), { recursive: true });
    const merged = checkImports(present, { mode: "combined" });
    assert.equal(merged.ok, true, `real-P overlay temp tree must pass combined: ${merged.detail.join("; ")}`);
    assert.equal(merged.complete, true);
    assert.deepEqual(merged.expectedFromP, []);
    // 叠加的是真实 P 提交字节（不是 stub）：与 immutable 提交逐字节一致
    assert.equal(readFileSync(join(present, "src", "plugin", "controller.mjs"), "utf8"),
      readFileSync(join(pSubmission.files, "src", "plugin", "controller.mjs"), "utf8"),
      "overlaid controller.mjs must be the real P submission content");
    assert.ok(!readFileSync(join(present, "src", "plugin", "controller.mjs"), "utf8").includes("SYNTHETIC TEST STUB"));
  } finally {
    rmSync(absent, { recursive: true, force: true });
    if (present) rmSync(present, { recursive: true, force: true });
  }
});

test("tarball：真实 npm pack --dry-run 白名单", () => {
  const result = checkTarball();
  assert.deepEqual(result.detail, [], result.detail.join("; "));
  assert.ok(result.files.includes("index.mjs"));
  assert.ok(result.files.includes("client/index.js"));
  assert.ok(result.files.includes("cordis.patch.yml"));
  assert.ok(result.files.includes("src/plugin/config.mjs"));
  assert.ok(result.files.includes("icon.png"), "tarball carries the package icon");
  for (const file of result.files) {
    assert.ok(!/^(phase\d|collab|test|_backup|node_modules)/i.test(file), `tarball excludes ${file}`);
    assert.ok(!/REPORT\.md|RESULT\.json|\.tgz$|\.log$/i.test(file), `tarball excludes ${file}`);
  }
});


// 宿主图标契约（dsh-app-boot MAX_ICON_BYTES = 256 * 1024，材料只认 svg/png/jpg/jpeg/webp，
// 且 icon 必须是包目录内的相对路径，最终转 data URL）。owner 提供的原始 PNG 超限，
// 这里锁定压缩后的成品仍满足上限与格式。
test("icon：包根 icon.png 为 ≤256KiB 的 PNG，package.json.icon 声明且进 files 白名单", () => {
  const iconPath = join(WORKQ, "icon.png");
  assert.ok(existsSync(iconPath), "icon.png present at package root");
  const bytes = readFileSync(iconPath);
  assert.ok(bytes.length > 0 && bytes.length <= 256 * 1024, `icon within 262144 bytes (got ${bytes.length})`);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG magic");
  // PNG IHDR：宽度/高度为大端 uint32，位于偏移 16 / 20
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(width, 512, "icon width 512");
  assert.equal(height, 512, "icon height 512");
  assert.ok(width >= 256 && height >= 256, "never below the 256x256 floor");
  // PNG IHDR 布局：width@16、height@20、bitDepth@24、colorType@25（即 IHDR 第 10 字节）。
  // 图标现为透明背景版本，colorType 必须是 6（RGBA，带 alpha 通道），否则会退回白底/丢透明。
  assert.equal(bytes[25], 6, `icon colorType must be 6 (RGBA / alpha channel), got ${bytes[25]}`);
  assert.equal(pkg.icon, "./icon.png", "package.json icon is the relative package-root path");
  assert.ok(pkg.files.includes("icon.png"), "icon.png whitelisted in files");
  // 图标路径必须留在包目录内（宿主拒绝越界相对路径）
  const resolved = new URL(pkg.icon, "file:///" + WORKQ.replaceAll("\\", "/") + "/package.json");
  const rootUrl = new URL("file:///" + WORKQ.replaceAll("\\", "/") + "/");
  assert.ok(resolved.href.startsWith(rootUrl.href), "icon path stays inside the package directory");
});

test("单项核查函数可独立复用（坏输入报错）", () => {
  const broken = checkPackageJson({ ...pkg, name: "other", dsh: {} });
  assert.equal(broken.ok, false);
  assert.ok(broken.detail.some((line) => line.includes("name")));
  const badPatch = checkPatchYml("# nothing");
  assert.equal(badPatch.ok, false);
  const badBundle = checkClientBundle("export default {};");
  assert.equal(badBundle.ok, false);
});
