// 测试分层运行器：dev 层（npm test）/ release 门禁层（npm run test:release）。
//
// 分层机制（0.4-REVIEW 附录 C）：不靠文件名约定猜，用目录清单在这一个脚本里
// 集中决策，并带全覆盖守卫——凡 test/ 下发现的 *.test.mjs，必须恰好归入某一层，
// 否则直接报错退出（新增文件/新目录漏注册都会被拦下，不会静默漏跑）。
//
//   dev     = LAYER_DIRS 内全部测试文件
//   release = dev ∪ RELEASE_DIRS 内全部测试文件（即「开发层 + 发版层」全量）
//
// 慢测试 / 发版闸门用例直接放进 test/release/ 目录归层（0.4 分层收口二期起
// 不再维护手写的 dev 排除清单——挪文件即是归层，不会忘改常量）。
//
// 用法：node scripts/run-tests.mjs <dev|release> [--collect-only] [选择器...]
// --collect-only：只跑全覆盖守卫并打印收集到的测试文件清单（不运行任何测试），
//                 供 verify:package 的「包内可收集」tarball 校验复用。
// 选择器两种写法（可混用，都是收窄文件集，不影响守卫）：
//   test/<dir>/*.test.mjs  —— 旧式域 glob（npm test 脚本里原样保留，映射到目录）
//   <子串>                 —— 对 test/ 下相对路径做子串过滤（如 forgetting）

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ROOT = join(ROOT, "test");

/** 开发层收集目录（与 0.4 收口前 npm test 的 glob 目录逐一对应，顺序一致）。 */
const LAYER_DIRS = [
  "core", "host", "storage", "service", "integration", "runtime", "completion",
  "acceptance", "sparks", "organize", "forgetting", "plugin", "semantic",
];

/** 发版门禁层专属目录：仅 test:release 收集。 */
const RELEASE_DIRS = ["release"];

// ---------------------------------------------------------------------------
// 串行池（§9 债 16 / 10-3）：重网络回环文件不与其它文件并发。
//
// 背景：node --test 的并行单位是文件，acceptance 里 loopback-capture（8MiB body +
// AbortSignal.timeout(8000) 等真实回环 HTTP 用例）与 matrix（runAcceptanceMatrix
// 的 local-loopback cases + 跨进程重放）对 127.0.0.1 连接挤压最敏感；此前只靠
// 文件内的跨进程车道锁「尽量错开」（两文件互相错开，但仍与其余全部文件并行抢
// 回环与 CPU），批次 8 抓到的连接层 flake（fetch failed 同族）根因未除。
//
// 实现方式：选层后把文件集一分为二——串行池内文件用第二条 node --test
// --test-concurrency=1 单独跑（文件间串行、且与本轮其它所有文件物理错开前后两
// 个进程批次，不是「失败重试洗绿」）；其余文件照旧一条 node --test 默认并发跑。
// 两批顺序执行、退出码合并（任一批非零即整体非零）。车道锁保留：串行池内两
// 文件仍靠它互斥，且防 test:p1 等绕过本运行器的直跑路径漏网。
// ---------------------------------------------------------------------------
const SERIAL_POOL_FILES = [
  "acceptance/loopback-capture.test.mjs",
  "acceptance/matrix.test.mjs",
];

const mode = process.argv[2];
const rawArgs = process.argv.slice(3);
const collectOnly = rawArgs.includes("--collect-only");

/** 解析选择器：test/<dir>/... 形式 → 目录收窄；其余 → 子串过滤。 */
function parseSelectors(args) {
  const dirs = [];
  const substrings = [];
  for (const arg of args) {
    if (arg === "--") continue; // 惯例分隔符，仅可读性
    if (arg.startsWith("test/")) {
      const seg = arg.slice("test/".length).split("/")[0];
      if (!seg) fail(`非法选择器 "${arg}"`);
      dirs.push(seg);
    } else {
      substrings.push(arg);
    }
  }
  const known = [...LAYER_DIRS, ...RELEASE_DIRS];
  for (const d of dirs) {
    if (!known.includes(d)) {
      fail(`选择器目录 "test/${d}" 不在任何分层清单（LAYER_DIRS/RELEASE_DIRS）中，请先登记进 scripts/run-tests.mjs。`);
    }
  }
  return { dirs, substrings };
}

function fail(msg) {
  console.error(`[run-tests] ${msg}`);
  process.exit(2);
}

function relPosix(p) {
  return relative(TEST_ROOT, p).split(sep).join("/");
}

/** 递归收集 test/ 下全部 *.test.mjs（跳过夹具目录 test/fixtures——冻结对照夹具，从不运行）。 */
function discoverAll() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "fixtures" && dir === TEST_ROOT) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && e.name.endsWith(".test.mjs")) out.push(relPosix(abs));
    }
  };
  walk(TEST_ROOT);
  return out.sort();
}

function inDirs(rel, dirs) {
  return dirs.some((d) => rel === `${d}` || rel.startsWith(`${d}/`));
}

// ---------------------------------------------------------------------------
// 守卫：全覆盖断言（漏跑防护的核心）
// ---------------------------------------------------------------------------

const all = discoverAll();

const devCandidates = all.filter((rel) => inDirs(rel, LAYER_DIRS));
const releaseOnly = all.filter((rel) => !inDirs(rel, LAYER_DIRS) && inDirs(rel, RELEASE_DIRS));
const unlayered = all.filter((rel) => !inDirs(rel, LAYER_DIRS) && !inDirs(rel, RELEASE_DIRS));

if (unlayered.length > 0) {
  fail(`发现未分层的测试文件（不在 LAYER_DIRS 也不在 RELEASE_DIRS），为防漏跑拒绝运行：\n  ${unlayered.join("\n  ")}\n请把它们登记进 scripts/run-tests.mjs 的对应目录清单。`);
}

const dev = devCandidates;

// ---------------------------------------------------------------------------
// 按模式选层（release = dev 全量 + 发版层专属目录）
// ---------------------------------------------------------------------------

const { dirs: selDirs, substrings: selSubs } = parseSelectors(rawArgs.filter((arg) => arg !== "--collect-only"));

let files;
if (mode === "dev") {
  files = dev;
} else if (mode === "release") {
  if (releaseOnly.length === 0) {
    fail("发版门禁层（test/release/）没有收集到任何测试文件——门禁空转，拒绝运行。");
  }
  // release 层 = 开发层全量 + 发版层专属目录。守卫已确保 all 里没有未分层文件。
  files = [...devCandidates, ...releaseOnly];
} else {
  fail(`用法：node scripts/run-tests.mjs <dev|release> [--collect-only] [选择器...]，收到 mode="${mode ?? ""}"`);
}

if (selDirs.length > 0 || selSubs.length > 0) {
  files = files.filter((rel) => {
    const dir = rel.split("/")[0];
    const dirOk = selDirs.length === 0 || selDirs.includes(dir);
    const subOk = selSubs.length === 0 || selSubs.some((f) => rel.includes(f));
    return dirOk && subOk;
  });
  if (files.length === 0) {
    fail(`选择器 ${JSON.stringify([...selDirs, ...selSubs])} 没有匹配到任何 ${mode} 层测试文件。`);
  }
}

const layerTag = mode === "release" ? `release（开发层 ${devCandidates.length} + 发版层专属 ${releaseOnly.length}）` : `dev（test/release/ 整目录已排除）`;
console.error(`[run-tests] ${mode} 层：${files.length} 个测试文件（${layerTag}）`);

if (collectOnly) {
  // --collect-only：守卫已跑完（走到这里说明全覆盖断言通过），打印清单即收，
  // 不运行任何测试。verify:package 的 tarball 校验靠这一步证明「包内测试可收集」。
  console.log(`[run-tests] collect-only：${mode} 层收集到 ${files.length} 个测试文件（守卫通过，未运行）：`);
  for (const rel of files) console.log(`  ${rel}`);
  console.log(`[run-tests] collect-only OK`);
  process.exit(0);
}

const poolFiles = files.filter((rel) => SERIAL_POOL_FILES.includes(rel));
const restFiles = files.filter((rel) => !SERIAL_POOL_FILES.includes(rel));
if (poolFiles.length > 0) {
  console.error(`[run-tests] 串行池：${poolFiles.length} 个重网络文件单批 --test-concurrency=1 后跑（${poolFiles.join(", ")}），其余 ${restFiles.length} 个文件先行默认并发`);
}

const spawnTests = (extraArgs, rels) => {
  const r = spawnSync(process.execPath, [...extraArgs, ...rels.map((rel) => join(TEST_ROOT, rel))], {
    stdio: "inherit",
    cwd: ROOT,
  });
  return r.status ?? 1;
};

let exitStatus = 0;
if (restFiles.length > 0) {
  exitStatus = spawnTests(["--test"], restFiles);
}
if (poolFiles.length > 0) {
  // 串行池无论前批结果如何都跑完（红跑也给全量诊断），退出码取首个非零。
  const poolStatus = spawnTests(["--test", "--test-concurrency=1"], poolFiles);
  if (exitStatus === 0) exitStatus = poolStatus;
}
process.exit(exitStatus);
