#!/usr/bin/env node
// Shiori 0.4-S6 · dsh-shiori-admin 管理命令行（卸载与焚毁）。
//
// 子命令：
//   dsh-shiori-admin status [--data <path>] [--state <path>]
//       只读清点：打印 dataRoot / stateRoot 的路径、文件数、总字节、topic 数。
//       根路径显式给 --data / --state；缺省用插件同一套默认根派生逻辑
//       （src/plugin/config.mjs 的 defaultPluginRoots——不复制一份路径逻辑）。
//   dsh-shiori-admin destroy --data <path> [--state <path>] [--yes]
//       焚毁整个 dataRoot（stateRoot 与 DSH 配置不动）。必须显式给 --data
//       （绝对路径）；没有 --yes 时要求手动输入 dataRoot 原文，逐字符相等
//       才继续；--yes 跳过确认。
//
// 安全校验（任一不满足即拒绝，退出码 3）：目标必须是绝对路径、不含 ".." 段、
// 真实解析后与 stateRoot 互不相交、不是盘符根、不是用户主目录、不是仓库根
// （或其祖先）、路径存在时必须是目录。校验与删除都在共享模块
// src/storage/purge.mjs（与面板 RPC 同一份实现，行为一致）。
//
// 退出码：0 成功 / 1 用法错误或操作失败 / 2 用户取消 / 3 安全校验失败。

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argv as nodeArgv } from "node:process";
import { createInterface } from "node:readline";
import {
  assertPurgeTargetSafe, describeDataRoot, purgeDataRoot, PurgeSafetyError,
} from "../src/storage/purge.mjs";
import { defaultPluginRoots } from "../src/plugin/config.mjs";

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_CANCELLED = 2;
const EXIT_UNSAFE = 3;

function usage(stream = process.stdout) {
  stream.write(`dsh-shiori-admin — Shiori 记忆数据管理（0.4 S6 卸载与焚毁）

用法：
  dsh-shiori-admin status  [--data <path>] [--state <path>]
      只读清点两个根：路径、文件数、总字节、topic 数。
      缺省根 = <DSH_HOME>/shiori-data 与 <DSH_HOME>/shiori-state
      （DSH_HOME 取环境变量，未设置时为 ~/.dsh；与插件默认根同一套派生逻辑）。

  dsh-shiori-admin destroy --data <path> [--state <path>] [--yes]
      焚毁整个 dataRoot 目录（只删 dataRoot；stateRoot 与 DSH 配置不受影响）。
      必须显式给 --data（绝对路径）。
      没有 --yes 时要求手动输入 dataRoot 原文确认（逐字符相等才执行）。

退出码：0 成功 / 1 用法错误或操作失败 / 2 用户取消 / 3 安全校验失败。
`);
}

function parseFlags(argv) {
  const flags = { data: undefined, state: undefined, yes: false, unknown: [], positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--data") {
      const value = argv[++i];
      if (value === undefined) { flags.unknown.push("--data（缺值）"); continue; }
      flags.data = value;
    } else if (arg === "--state") {
      const value = argv[++i];
      if (value === undefined) { flags.unknown.push("--state（缺值）"); continue; }
      flags.state = value;
    } else if (arg === "--yes") {
      flags.yes = true;
    } else if (arg.startsWith("--")) {
      flags.unknown.push(arg);
    } else {
      flags.positional.push(arg);
    }
  }
  return flags;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0";
  return `${bytes}`;
}

function printDescribe(label, described) {
  process.stdout.write(`${label}: ${described.root}\n`);
  process.stdout.write(`  存在:      ${described.exists ? (described.notDirectory ? "是（但不是目录）" : "是") : "否"}\n`);
  process.stdout.write(`  文件数:    ${described.files}\n`);
  process.stdout.write(`  总字节:    ${formatBytes(described.bytes)}\n`);
  process.stdout.write(`  topic 数:  ${described.topics}\n`);
}

async function cmdStatus(flags) {
  const defaults = defaultPluginRoots();
  const dataRoot = flags.data ?? defaults.dataRoot;
  const stateRoot = flags.state ?? defaults.stateRoot;
  printDescribe("dataRoot", await describeDataRoot(dataRoot));
  printDescribe("stateRoot", await describeDataRoot(stateRoot));
  return EXIT_OK;
}

function confirmByStdin(rootPath) {
  return new Promise((resolveConfirm) => {
    process.stdout.write(`\n将永久删除上述 dataRoot 的全部内容（目录本身也会被移除）。\n`);
    process.stdout.write(`只删 dataRoot：stateRoot 与 DSH 配置不受影响。\n`);
    process.stdout.write(`请输入上方 dataRoot 原文以确认（其他任何输入都会取消）：\n> `);
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    let answered = false;
    rl.on("line", (line) => {
      if (answered) return;
      answered = true;
      rl.close();
      // 逐字符相等：不 trim、不忽略大小写——二次确认必须输入 dataRoot 原文。
      resolveConfirm(String(line) === rootPath);
    });
    rl.on("close", () => {
      if (!answered) {
        answered = true;
        resolveConfirm(false); // EOF（无输入）：fail-closed，按取消处理
      }
    });
  });
}

async function cmdDestroy(flags) {
  if (flags.data === undefined) {
    process.stderr.write("destroy 需要显式 --data <path>（绝对路径）。\n\n");
    usage(process.stderr);
    return EXIT_USAGE;
  }
  if (flags.unknown.length > 0 || flags.positional.length > 0) {
    process.stderr.write(`destroy 收到无法识别的参数：${[...flags.unknown, ...flags.positional].join(" ")}\n\n`);
    usage(process.stderr);
    return EXIT_USAGE;
  }
  const defaults = defaultPluginRoots();
  const stateRoot = flags.state ?? defaults.stateRoot;

  // 安全校验先行（fail-closed）：任何一条不满足都在删除之前拒绝。
  // 只校验不删（purgeDataRoot 在确认之后才调用，并会再做一次完整校验）。
  try {
    await assertPurgeTargetSafe(flags.data, { stateRoot });
  } catch (error) {
    if (error instanceof PurgeSafetyError) {
      process.stderr.write(`安全校验未通过（${error.details?.rule ?? "unknown"}）：${error.message}\n`);
      return EXIT_UNSAFE;
    }
    throw error;
  }

  const described = await describeDataRoot(flags.data);
  if (!described.exists) {
    process.stdout.write(`dataRoot 不存在（${described.root}）：没有东西可删。\n`);
    return EXIT_OK;
  }
  if (described.notDirectory) {
    process.stderr.write(`安全校验未通过（not-a-directory）：${described.root} 存在但不是目录。\n`);
    return EXIT_UNSAFE;
  }
  process.stdout.write(`将删除 dataRoot：${described.root}\n  文件数: ${described.files}  总字节: ${formatBytes(described.bytes)}  topic 数: ${described.topics}\n`);

  if (!flags.yes) {
    const confirmed = await confirmByStdin(described.root);
    if (!confirmed) {
      process.stdout.write("\n已取消（确认输入与 dataRoot 原文不一致或为空）。未删除任何文件。\n");
      return EXIT_CANCELLED;
    }
  }

  const result = await purgeDataRoot(described.root, { stateRoot });
  if (!result.deleted) {
    // 校验后清点前目录消失的窄窗口：按无东西可删处理，不算失败。
    process.stdout.write(`dataRoot 已不存在（${result.dataRoot}）：没有东西可删。\n`);
    return EXIT_OK;
  }
  process.stdout.write(`已焚毁 dataRoot：${result.dataRoot}\n  删除文件数: ${result.files}  释放字节: ${formatBytes(result.bytes)}\n  stateRoot 与 DSH 配置未受影响。\n`);
  return EXIT_OK;
}

export async function runAdminCli(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand === undefined) {
    usage();
    return EXIT_USAGE;
  }
  const flags = parseFlags(rest);
  if (flags.unknown.length > 0 || flags.positional.length > 0) {
    process.stderr.write(`无法识别的参数：${[...flags.unknown, ...flags.positional].join(" ")}\n\n`);
    usage(process.stderr);
    return EXIT_USAGE;
  }
  if (subcommand === "status") return cmdStatus(flags);
  if (subcommand === "destroy") return cmdDestroy(flags);
  if (subcommand === "--help" || subcommand === "-h") {
    usage();
    return EXIT_OK;
  }
  process.stderr.write(`未知子命令 "${subcommand}"。\n\n`);
  usage(process.stderr);
  return EXIT_USAGE;
}

// 直接执行入口（被测试 import 时 runAdminCli 可重入，不会触发此分支）。
// 判定：本模块是主模块（node bin/admin.mjs …）。
const isMain = (() => {
  try {
    return realpathSync(nodeArgv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exitCode = await runAdminCli(nodeArgv.slice(2));
  } catch (error) {
    process.stderr.write(`操作失败：${error && error.message ? error.message : String(error)}\n`);
    process.exitCode = EXIT_USAGE;
  }
}
