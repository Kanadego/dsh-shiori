// dsh-shiori 包清单静态核查（只读，不修改、不联网、不发布）。
// 可独立运行：npm run verify:package；亦被 test/plugin/package.test.mjs 复用。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** P 槽提供、单槽副本中不存在的跨槽文件（owner 组合后必须存在）。 */
export const EXPECTED_FROM_P = ["src/plugin/controller.mjs", "src/plugin/protocol.mjs"];

export function readText(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

// ---------------------------------------------------------------------------
// 1. package.json 形状
// ---------------------------------------------------------------------------

export function checkPackageJson(pkg) {
  const problems = [];
  const expect = (condition, message) => { if (!condition) problems.push(message); };

  expect(pkg.name === "dsh-shiori", `name should be dsh-shiori, got ${pkg.name}`);
  // 版本号只认 package.json 这一处真源：这里只校验 semver 形状，不再钉死某个数字
  // （钉死会让每次发版都要改脚本，2026-11-02 发 v0.2.0 时踩过一次）。
  expect(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version), `version must be semver (prerelease allowed), got ${pkg.version}`);
  expect(pkg.private === undefined, "private must be gone (the package is published)");
  expect(pkg.type === "module", "type must be module");
  expect(pkg.main === "index.mjs", "main must be index.mjs");
  expect(pkg.exports?.["."] === "./index.mjs", 'exports["."] must be ./index.mjs');
  expect(pkg.exports?.["./client"] === "./client/index.js", 'exports["./client"] must be ./client/index.js');
  expect(pkg.engines?.node === ">=24", "engines.node must be >=24");
  expect(typeof pkg.engines?.dsh === "string" && pkg.engines.dsh.includes("0.2.1-rc.2"),
    "engines.dsh must cover the tested 0.2.1-rc.2");
  expect(pkg.dsh?.manifestVersion === 1, "dsh.manifestVersion must be 1");
  expect(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch must point to ./cordis.patch.yml");
  expect(pkg.dsh?.client?.platform === "web", "dsh.client.platform must be web");
  // dsh.client.inject 是「客户端插件图依赖」语义，不是 npm seed 声明（owner review
  // 次要修正；官方 dsh-soul-md 的 dsh.client 仅 { platform: "web" }）。shiori 的
  // client bundle 只 require Web shell 的 ModuleLoader seeds（react/zod），不声明
  // 图依赖——若未来真的加载其他客户端插件包，才在此显式列出。
  expect(pkg.dsh?.client?.inject === undefined, "dsh.client.inject must stay absent (seed require ≠ graph dependency)");
  expect(pkg.license === "CC-BY-NC-SA-4.0", "license must be CC-BY-NC-SA-4.0 (matches LICENSE)");
  expect(typeof pkg.scripts?.test === "string" && pkg.scripts.test.includes("test/plugin/*.test.mjs"),
    "npm test must explicitly include test/plugin/*.test.mjs");
  expect(pkg.scripts?.["test:p5"]?.includes("test/plugin"), "test:p5 script must exist");
  expect(pkg.scripts?.["test:p1"] && pkg.scripts?.["test:p3"] && pkg.scripts?.["test:p4"],
    "old domain scripts (p1/p3/p4) must be preserved");

  // 0.4 分层收口二期：包内可测——scripts/（run-tests 运行器）与 test/（测试本体）
  // 必须随包发布，装包后 npm test 才有运行器可找。
  expect(pkg.files.includes("scripts"), 'files must include "scripts" (in-package test runner)');
  expect(pkg.files.includes("test"), 'files must include "test" (in-package tests)');
  // 仍禁止的命名残留（phase/collab/备份/结果文件）；test 已转为有意纳入，不再排除
  for (const forbidden of [/phase\d/i, /collab/i, /_backup/i, /REPORT/i, /RESULT/i]) {
    expect(!pkg.files.some((entry) => forbidden.test(entry)), `files must not include ${forbidden}`);
  }

  const peers = pkg.peerDependencies ?? {};
  for (const name of ["@deepseek-ai/dsh-system-prompt", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-typert-protocol", "@deepseek-ai/schemastery", "react"]) {
    expect(typeof peers[name] === "string", `peerDependencies must declare ${name}`);
  }
  expect(Object.keys(pkg.dependencies ?? {}).length === 0, "no runtime dependencies (peers only)");

  return { name: "package.json", ok: problems.length === 0, detail: problems };
}

// ---------------------------------------------------------------------------
// 2. cordis.patch.yml
// ---------------------------------------------------------------------------

export function checkPatchYml(text) {
  const problems = [];
  if (!text.includes("- insert:")) problems.push("missing `- insert:`");
  if (!/id:\s*shiori\b/.test(text)) problems.push("missing row id `shiori`");
  if (!/name:\s*['"]dsh-shiori['"]/.test(text)) problems.push("missing row name 'dsh-shiori'");
  if (/\bremove\b|\bupdate\b/.test(text)) problems.push("unexpected remove/update operations");
  return { name: "cordis.patch.yml", ok: problems.length === 0, detail: problems };
}

// ---------------------------------------------------------------------------
// 3. client bundle 约束
// ---------------------------------------------------------------------------

export function checkClientBundle(source) {
  const problems = [];
  if (!source.includes("window.__ModuleLoader__.load(")) problems.push("not a ModuleLoader bundle");
  if (!/id:\s*["']dsh-shiori["']/.test(source)) problems.push("loader id must be dsh-shiori");
  if (!/factory:\s*\(?require\)?\s*=>/.test(source) && !/factory:\s*function\s*\(\s*require\s*\)/.test(source)) {
    problems.push("factory must receive require");
  }
  if (!source.includes("exports.apply = apply")) problems.push("must export apply");
  if (!source.includes("exports.inject = inject")) problems.push("must export inject");
  if (!source.includes("ctx.remote.$mount(")) problems.push("must await ctx.remote.$mount");
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  if (stripped.includes("innerHTML")) problems.push("innerHTML usage");
  if (stripped.includes("dangerouslySetInnerHTML")) problems.push("dangerouslySetInnerHTML usage");
  if (/https?:\/\//.test(stripped)) problems.push("remote URL (CDN) reference");
  if (/\beval\s*\(|new Function\s*\(/.test(stripped)) problems.push("eval / Function constructor");
  if (!/require\("react"\)/.test(stripped) || !/require\("zod"\)/.test(stripped)) {
    problems.push("factory must require react and zod only");
  }
  return { name: "client bundle", ok: problems.length === 0, detail: problems };
}

// ---------------------------------------------------------------------------
// 4. 相对 import 完整性（从 index.mjs 走全图）
//
// 模式（owner review R5：单槽 / 组合必须显式，不得把不完整包当作可发行）：
//   - single（默认）：单槽基线 + Q。EXPECTED_FROM_P 列出的跨槽文件缺席只记入
//     expectedFromP 信息清单，结果 complete=false（如实标注「待 P 组合」，不是通过）。
//   - combined：组合验收模式。任何生产相对 import 缺失即失败；若提供 pRoot
//    （owner 归档的 immutable P 提交 files 目录），从那里补读跨槽文件并继续
//     BFS 走全图，证明组合闭包完整。
// ---------------------------------------------------------------------------

const BUILTIN = /^(node:|data:)/;

function findImportTargets(file, source) {
  const targets = [];
  const importPattern = /(?:import|export)\s+(?:[\s\S]*?from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(importPattern)) {
    targets.push(match[1] ?? match[2]);
  }
  return targets;
}

export function checkImports(root = ROOT, { mode = "single", pRoot = null } = {}) {
  const problems = [];
  const expectedFromP = [];
  const providedFromP = [];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const peers = new Set([...Object.keys(pkg.peerDependencies ?? {}), "zod", "react"]);
  const seen = new Set();
  const queue = ["index.mjs"];

  const readFrom = (file) => {
    const inRoot = join(root, file);
    if (existsSync(inRoot)) return { path: inRoot, fromP: false };
    if (pRoot) {
      const inP = join(pRoot, file);
      if (existsSync(inP)) return { path: inP, fromP: true };
    }
    return null;
  };

  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const located = readFrom(file);
    if (!located) {
      const fromP = EXPECTED_FROM_P.some((candidate) => file === candidate || file.endsWith("/" + candidate));
      if (fromP && mode === "single") {
        expectedFromP.push(`${file} (provided by slot P; combined package must ship it)`);
        continue;
      }
      problems.push(`missing bundled file: ${file}${fromP ? " (provided by slot P)" : ""}`);
      continue;
    }
    if (located.fromP) providedFromP.push(file);
    const source = readFileSync(located.path, "utf8");
    for (const specifier of findImportTargets(file, source)) {
      if (BUILTIN.test(specifier)) continue;
      if (!specifier.startsWith(".")) {
        const base = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (!peers.has(base)) problems.push(`${file}: bare import "${specifier}" not declared in peerDependencies`);
        continue;
      }
      let next = specifier;
      if (!/\.[cm]?js$/u.test(next)) next += ".mjs";
      let target = join(dirname(file), next);
      if (!existsSync(join(root, target)) && !(pRoot && existsSync(join(pRoot, target)))) {
        const indexTarget = join(dirname(file), next.replace(/\.mjs$/, ""), "index.mjs");
        if (existsSync(join(root, indexTarget)) || (pRoot && existsSync(join(pRoot, indexTarget)))) target = indexTarget;
      }
      const normalized = target.split("\\").join("/");
      if (normalized.startsWith("..")) problems.push(`${file}: import escapes the package root: ${specifier}`);
      queue.push(normalized);
    }
  }
  const complete = mode === "combined" || expectedFromP.length === 0;
  return {
    name: "relative imports",
    ok: problems.length === 0,
    detail: problems,
    expectedFromP,
    providedFromP: [...new Set(providedFromP)].sort(),
    mode,
    complete,
  };
}

// ---------------------------------------------------------------------------
// 5. npm pack --dry-run 文件白名单
// ---------------------------------------------------------------------------

export function checkTarball(root = ROOT) {
  const problems = [];
  const required = [
    "package.json", "index.mjs", "client/index.js", "cordis.patch.yml",
    "src/plugin/config.mjs", "src/plugin/client-rpc.mjs", "src/core/config.mjs",
    // 包内可测（0.4 分层收口二期）：运行器 + 共享脚手架 + dev/release 两层样本
    "scripts/run-tests.mjs", "scripts/verify-package.mjs",
    "test/fixtures/stage.mjs", "test/forgetting/store.test.mjs",
    "test/release/stage-regression.test.mjs",
  ];
  let files = null;
  try {
    const stdout = execFileSync("npm pack --dry-run --json", { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, shell: true, windowsHide: true });
    const parsed = JSON.parse(stdout);
    files = (Array.isArray(parsed) ? parsed[0]?.files : parsed.files) ?? [];
  } catch (error) {
    return { name: "tarball", ok: false, detail: [`npm pack --dry-run failed: ${String(error.message).split("\n")[0]}`], files: [] };
  }
  const names = new Set(files.map((entry) => String(entry.path ?? entry.location ?? "").split("\\").join("/")));
  for (const file of required) {
    if (!names.has(file)) problems.push(`tarball missing required file: ${file}`);
  }
  // scripts/ 与 test/ 现在是有意纳入的（包内可测）；仍禁止 phase/collab/备份/
  // node_modules 混入，docs 只带 plugin 子目录。
  for (const name of names) {
    if (/^(phase\d|collab|_backup|node_modules|docs\/(?!plugin))/i.test(name)) {
      problems.push(`tarball must not include: ${name}`);
    }
    if (/REPORT\.md|RESULT\.json|\.tgz$|\.log$/i.test(name)) problems.push(`tarball must not include: ${name}`);
  }
  return { name: "tarball", ok: problems.length === 0, detail: problems, files: [...names].sort() };
}

// ---------------------------------------------------------------------------
// 5b. tarball 解包后包内测试可被运行器收集（不真跑全量）
//
// 真实 npm pack → tar 解包到临时目录 → 在解包目录里执行
// `node scripts/run-tests.mjs dev --collect-only`：该模式只跑 run-tests 的
// 全覆盖守卫并打印收集清单即退出（不运行任何测试），证明装包的人手里那份
// test/scripts 能被包自带的运行器完整收集（dev 层文件数须高于地板值）。
// ---------------------------------------------------------------------------

// dev 层测试文件数地板：实测 91，留一成余量——拦得住「测试文件成批消失」，
// 也不会因为删一两个文件就误报。
export const COLLECT_FLOOR = 80;

// 与 scripts/run-tests.mjs 的 LAYER_DIRS 保持一致（run-tests 是直接执行的脚本，
// 不能 import 复用；此处为验收显式断言用的目录清单副本）。
const LAYER_DIRS = [
  "core", "host", "storage", "service", "integration", "runtime", "completion",
  "acceptance", "sparks", "organize", "forgetting", "plugin", "semantic",
];

// 解包后必须存在的「包内可测」硬证据（owner review 口径 q-43e1a0ca62aa1859 第 3 条）：
// 运行器 + 核查脚本 + 共享脚手架 + 测试引用的冻结夹具。
const COLLECT_MUST_EXIST = [
  "scripts/run-tests.mjs",
  "scripts/verify-package.mjs",
  "test/fixtures/stage.mjs",
  "test/fixtures/frozen/G/a2-226d3f0e-77ea-4a4c-b097-ad6483ebc806/files/src/sparks/store.mjs",
];

export function checkTarballCollect(root = ROOT) {
  const problems = [];
  let collected = 0;
  const work = mkdtempSync(join(tmpdir(), "shiori-verify-collect-"));
  try {
    let tgzName = null;
    try {
      const stdout = execFileSync(`npm pack --json --pack-destination "${work}"`, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, shell: true, windowsHide: true });
      const parsed = JSON.parse(stdout);
      tgzName = (Array.isArray(parsed) ? parsed[0]?.filename : parsed.filename) ?? null;
    } catch (error) {
      // npm 的实际报错在 stderr 里；message 只有 "Command failed: ..." 一行，优先取 stderr 尾部。
      const stderr = error?.stderr == null ? "" : String(error.stderr).trim();
      const reason = stderr ? stderr.slice(-500) : String(error.message).split("\n")[0];
      return { name: "tarball collect", ok: false, detail: [`npm pack failed: ${reason}`], collected };
    }
    if (!tgzName) return { name: "tarball collect", ok: false, detail: ["npm pack --json returned no filename"], collected };
    const pkgDir = join(work, "package");
    // tar 参数一律用相对路径（cwd=work）：绝对路径里的盘符冒号会被 GNU tar
    // 当成「远程主机」而拒解（"Cannot connect to C:"）。npm tarball 自带顶层
    // package/ 目录，直接解到 work 根即可，不要再套一层。
    try {
      execFileSync("tar", ["-xzf", tgzName], { cwd: work, windowsHide: true });
    } catch (error) {
      // 解包失败也要走「返回 problems」的约定，不能把异常抛给调用方。
      return { name: "tarball collect", ok: false, detail: [`tar extract failed: ${String(error.message).split("\n")[0]}`], collected };
    }
    // 验收硬证据：运行器在包里且语法可加载、13 个层目录齐全、被引用夹具在位
    for (const rel of COLLECT_MUST_EXIST) {
      if (!existsSync(join(pkgDir, rel))) problems.push(`unpacked tarball missing: ${rel}`);
    }
    for (const dir of LAYER_DIRS) {
      if (!existsSync(join(pkgDir, "test", dir))) problems.push(`unpacked tarball missing test layer dir: test/${dir}/`);
    }
    const syntax = spawnSync(process.execPath, ["--check", "scripts/run-tests.mjs"], { cwd: pkgDir, encoding: "utf8", windowsHide: true });
    if (syntax.status !== 0) {
      problems.push(`node --check scripts/run-tests.mjs failed in unpacked package:\n${String(syntax.stderr ?? "").slice(-800)}`);
    }
    const res = spawnSync(process.execPath, ["scripts/run-tests.mjs", "dev", "--collect-only"], {
      cwd: pkgDir, encoding: "utf8", windowsHide: true, timeout: 120_000,
    });
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    if (res.status !== 0) {
      // status 为 null 时是被信号杀掉的（含 spawnSync 超时），别只写 "signal" 看不出原因。
      const why = res.status === null && res.signal
        ? `collect 超时或被信号终止（signal=${res.signal}, timeout=120000ms）`
        : `exit=${res.status}`;
      problems.push(`in-package collect failed (${why}):\n${output.slice(-1500)}`);
    } else {
      const match = output.match(/collect-only：dev 层收集到 (\d+) 个测试文件/);
      if (!match) {
        problems.push(`collect output missing summary line:\n${output.slice(-800)}`);
      } else {
        collected = Number(match[1]);
        if (collected < COLLECT_FLOOR) {
          problems.push(`in-package dev collect found ${collected} test files — below floor ${COLLECT_FLOOR}`);
        }
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return { name: "tarball collect", ok: problems.length === 0, detail: problems, collected };
}

// ---------------------------------------------------------------------------
// 6. 机器路径 / 敏感信息扫描（shipped 文件）
// ---------------------------------------------------------------------------

export function checkNoMachinePaths(root = ROOT) {
  const problems = [];
  const targets = ["index.mjs", "cordis.patch.yml", "README.md", "client/index.js", "client/shiori.css", "src/plugin/config.mjs", "src/plugin/client-rpc.mjs"];
  const patterns = [/D:\\/, /D:\//i, /C:\\Users\\/, /C:\/Users\//i, /%USERPROFILE%/, /AppData/i];
  for (const file of targets) {
    const text = readFileSync(join(root, file), "utf8");
    for (const pattern of patterns) {
      if (pattern.test(text)) problems.push(`${file}: contains machine path pattern ${pattern}`);
    }
  }
  return { name: "machine paths", ok: problems.length === 0, detail: problems };
}

// ---------------------------------------------------------------------------

export function runChecks({ withTarball = true, mode = "single", pRoot = null, root = ROOT } = {}) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const checks = [
    checkPackageJson(pkg),
    checkPatchYml(readFileSync(join(root, "cordis.patch.yml"), "utf8")),
    checkClientBundle(readFileSync(join(root, "client/index.js"), "utf8")),
    checkImports(root, { mode, pRoot }),
    checkNoMachinePaths(root),
  ];
  if (withTarball) {
    checks.push(checkTarball(root));
    checks.push(checkTarballCollect(root));
  }
  return checks;
}

function parseCliArgs(argv) {
  const args = { mode: "single", pRoot: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--combined") args.mode = "combined";
    else if (argv[i] === "--single") args.mode = "single";
    else if (argv[i] === "--p-root") args.pRoot = argv[++i] ?? null;
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { mode, pRoot } = parseCliArgs(process.argv);
  const checks = runChecks({ withTarball: true, mode, pRoot });
  let failed = 0;
  for (const check of checks) {
    const mark = check.ok ? "PASS" : "FAIL";
    if (!check.ok) failed += 1;
    console.log(`[${mark}] ${check.name} (mode=${check.mode ?? "n/a"}, complete=${check.complete ?? "n/a"})`);
    for (const line of check.detail) console.log(`       - ${line}`);
    for (const line of check.expectedFromP ?? []) console.log(`       [pending-from-P] ${line}`);
  }
  const imports = checks.find((c) => c.name === "relative imports");
  if (imports && !imports.complete) {
    console.log("verify-package: single-slot package is INCOMPLETE by design — expected-from-P files pending; combined verification (--combined) must ship them.");
  }
  console.log(failed === 0 ? `verify-package: all checks passed (mode=${mode})` : `verify-package: ${failed} check(s) failed (mode=${mode})`);
  process.exitCode = failed === 0 ? 0 : 1;
}
