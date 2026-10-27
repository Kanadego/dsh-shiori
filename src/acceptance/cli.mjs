/**
 * Shiori P1-ACCEPTANCE CLI —— 零付费离线入口。
 *
 * 用法（在 F 工作区根目录运行；详见 docs/acceptance/README.md）：
 *
 *   # 1) 用 synthetic 注入替身完整跑一遍 11 项矩阵（离线、loopback、零付费）：
 *   node src/acceptance/cli.mjs matrix --evidence-root evidence/local --run-id cli-demo
 *
 *   # 2) 校验一份证据 bundle（结构/语义；给 --evidence-root 时同时核验磁盘 artifact）：
 *   node src/acceptance/cli.mjs validate --bundle evidence/local/bundle.json --evidence-root evidence/local
 *
 * CLI 默认使用 synthetic 工厂 —— 产出证据永远是 synthetic 等级；
 * replay/isolated-dsh 必须由调用方注入真实 runtimeFactory/completionFactory 运行（P1b）。
 */
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { runAcceptanceMatrix, validateEvidenceBundle, verifyArtifactsOnDisk } from "./index.mjs";
import { createSyntheticCompletionFactory, createSyntheticRuntimeFactory } from "./synthetic.mjs";

function usage() {
  return [
    "用法：",
    "  node src/acceptance/cli.mjs matrix --evidence-root <dir> [--fixture-root <dir>] [--run-id <id>] [--case-evidence-type synthetic|replay] [--no-completion] [--case-timeout-ms <ms>]",
    "  node src/acceptance/cli.mjs validate --bundle <bundle.json> [--evidence-root <dir>]",
    "",
    "说明：CLI 默认 synthetic 工厂，产出 synthetic 等级证据；isolated-dsh 不能由本 CLI 声明（负责人 P1b 专属）。",
  ].join("\n");
}

/** 无值的布尔旗标。 */
const BOOLEAN_FLAGS = new Set(["no-completion"]);

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new Error(`unexpected argument: ${token}\n${usage()}`);
    }
    const key = token.slice(2);
    if (key === "help") {
      args.help = true;
      continue;
    }
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${key}\n${usage()}`);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

async function cmdMatrix(args) {
  if (!args["evidence-root"]) throw new Error(`matrix requires --evidence-root\n${usage()}`);
  const bundle = await runAcceptanceMatrix({
    runtimeFactory: createSyntheticRuntimeFactory,
    completionFactory: args["no-completion"] ? undefined : createSyntheticCompletionFactory(),
    evidenceRoot: args["evidence-root"],
    fixtureRoot: args["fixture-root"],
    runId: args["run-id"],
    caseEvidenceType: args["case-evidence-type"] || undefined,
    caseTimeoutMs: args["case-timeout-ms"] ? Number(args["case-timeout-ms"]) : undefined,
  });
  const bundlePath = `${args["evidence-root"].replace(/[\\/]+$/, "")}/bundle.json`;
  await writeFile(bundlePath, JSON.stringify(bundle, null, 2), "utf8");
  const verdict = validateEvidenceBundle(bundle);
  const summary = {
    bundlePath,
    evidenceType: bundle.evidenceType,
    cases: bundle.cases.map((c) => ({ id: c.id, status: c.status, evidenceType: c.evidenceType })),
    validate: { valid: verdict.valid, errors: verdict.errors },
    note: "synthetic 运行：不声称真实宿主通过；isolated-dsh 需负责人 P1b 真实采集。",
  };
  console.log(JSON.stringify(summary, null, 2));
  return verdict.valid ? 0 : 1;
}

async function cmdValidate(args) {
  if (!args.bundle) throw new Error(`validate requires --bundle\n${usage()}`);
  const bundle = JSON.parse(await readFile(args.bundle, "utf8"));
  const verdict = validateEvidenceBundle(bundle);
  const result = { bundle: args.bundle, valid: verdict.valid, errors: verdict.errors, cases: verdict.cases };
  if (args["evidence-root"]) {
    const disk = await verifyArtifactsOnDisk(bundle, args["evidence-root"]);
    result.diskVerification = { ok: disk.ok, errors: disk.errors };
    result.valid = verdict.valid && disk.ok;
  }
  console.log(JSON.stringify(result, null, 2));
  return result.valid ? 0 : 1;
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "help" || command === "--help") {
  console.log(usage());
  process.exit(0);
}
const args = parseArgs(rest);
const handlers = { matrix: cmdMatrix, validate: cmdValidate };
const handler = handlers[command];
if (!handler) {
  console.error(`unknown command "${command}"\n${usage()}`);
  process.exit(2);
}
try {
  process.exit(await handler(args));
} catch (error) {
  const label = error instanceof Error ? `${error.code ? `[${error.code}] ` : ""}${error.message}` : String(error);
  console.error(`[shiori-acceptance] ${command} failed: ${label}`);
  process.exit(1);
}
