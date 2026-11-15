// 测试分层运行器：dev 层（npm test）/ release 门禁层（npm run test:release）。
//
// 分层机制（0.4-REVIEW 附录 C）：不靠文件名约定猜，用「目录清单 + 显式排除清单」
// 在这一个脚本里集中决策，并带全覆盖守卫——凡 test/ 下发现的 *.test.mjs，
// 必须恰好归入某一层，否则直接报错退出（新增文件/新目录漏注册都会被拦下，
// 不会静默漏跑）。
//
//   dev     = LAYER_DIRS 内全部测试文件，剔除 EXCLUDE_FROM_DEV（发版层专属文件）
//   release = dev ∪ RELEASE_DIRS 内全部测试文件（即「开发层 + 发版层」全量）
//
// 用法：node scripts/run-tests.mjs <dev|release> [选择器...]
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

/** 开发层显式排除清单（精确路径，整文件进发版层）。 */
const EXCLUDE_FROM_DEV = ["forgetting/stage-regression.test.mjs"];

const mode = process.argv[2];

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
const excluded = [];
for (const ex of EXCLUDE_FROM_DEV) {
  if (!all.includes(ex)) {
    fail(`EXCLUDE_FROM_DEV 里的 "${ex}" 在 test/ 下不存在——排除清单写错或文件被改名，拒绝猜测，请修正清单。`);
  }
  excluded.push(ex);
}

const devCandidates = all.filter((rel) => inDirs(rel, LAYER_DIRS));
const releaseOnly = all.filter((rel) => !inDirs(rel, LAYER_DIRS) && inDirs(rel, RELEASE_DIRS));
const unlayered = all.filter((rel) => !inDirs(rel, LAYER_DIRS) && !inDirs(rel, RELEASE_DIRS));

if (unlayered.length > 0) {
  fail(`发现未分层的测试文件（不在 LAYER_DIRS 也不在 RELEASE_DIRS），为防漏跑拒绝运行：\n  ${unlayered.join("\n  ")}\n请把它们登记进 scripts/run-tests.mjs 的对应目录清单。`);
}

const dev = devCandidates.filter((rel) => !excluded.includes(rel));

// ---------------------------------------------------------------------------
// 按模式选层（release = dev 全量 + 发版层专属目录）
// ---------------------------------------------------------------------------

const { dirs: selDirs, substrings: selSubs } = parseSelectors(process.argv.slice(3));

let files;
if (mode === "dev") {
  files = dev;
} else if (mode === "release") {
  if (releaseOnly.length === 0) {
    fail("发版门禁层（test/release/）没有收集到任何测试文件——门禁空转，拒绝运行。");
  }
  // release 层 = 开发层候选全量（含 EXCLUDE_FROM_DEV——那只是 dev 层的排除）
  //             + 发版层专属目录。守卫已确保 all 里没有未分层文件。
  files = [...devCandidates, ...releaseOnly];
} else {
  fail(`用法：node scripts/run-tests.mjs <dev|release> [选择器...]，收到 mode="${mode ?? ""}"`);
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

const layerTag = mode === "release" ? `release（开发层 ${devCandidates.length} + 发版层专属 ${releaseOnly.length}）` : `dev（发版层专属 ${excluded.length} 个文件 + test/release/ 整目录已排除）`;
console.error(`[run-tests] ${mode} 层：${files.length} 个测试文件（${layerTag}）`);

const res = spawnSync(process.execPath, ["--test", ...files.map((rel) => join(TEST_ROOT, rel))], {
  stdio: "inherit",
  cwd: ROOT,
});
process.exit(res.status ?? 1);
