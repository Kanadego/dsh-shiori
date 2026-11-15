// 0.4 S6 · bin/admin.mjs 命令行真实子进程测试（status / destroy 全路径与退出码）。
// 证据级别：真实 spawn node bin/admin.mjs（非 mock），temp 假 dataRoot / stateRoot。
// 退出码契约：0 成功 / 1 用法错误或操作失败 / 2 用户取消 / 3 安全校验失败。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKQ = path.join(HERE, "..", "..");
const ADMIN = path.join(WORKQ, "bin", "admin.mjs");

// 真实子进程：cwd 在仓库根（保证 import 解析与生产一致），stdin 可写入确认行。
function runAdmin(args, { stdin = null } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [ADMIN, ...args], {
      cwd: WORKQ,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    if (stdin !== null) child.stdin.write(stdin);
    child.stdin.end();
    const done = (code) => resolveRun({ code, stdout, stderr });
    child.on("exit", done);
    child.on("error", (error) => done(-1));
  });
}

/** 建一套假数据根：dataRoot（persona + 2 topics）+ stateRoot（哨兵文件）。 */
function makeFakeRoots(prefix) {
  const base = mkdtempSync(path.join(tmpdir(), prefix));
  const dataRoot = path.join(base, "data");
  const stateRoot = path.join(base, "state");
  mkdirSync(path.join(dataRoot, "scopes", "amber", "topics"), { recursive: true });
  mkdirSync(path.join(dataRoot, "persona"), { recursive: true });
  writeFileSync(path.join(dataRoot, "scopes", "amber", "topics", "t1.md"), "topic one\n", "utf8");
  writeFileSync(path.join(dataRoot, "scopes", "amber", "topics", "t2.md"), "topic two\n", "utf8");
  writeFileSync(path.join(dataRoot, "persona", "amber.md"), "L0 persona\n", "utf8");
  mkdirSync(path.join(stateRoot, "tool-ops"), { recursive: true });
  writeFileSync(path.join(stateRoot, "tool-ops", "a.json"), "{}\n", "utf8");
  return { base, dataRoot, stateRoot };
}

test("admin status：打印 dataRoot/stateRoot 路径、文件数、总字节、topic 数（exit 0）", async () => {
  const { base, dataRoot, stateRoot } = makeFakeRoots("shiori-admin-status-");
  try {
    const result = await runAdmin(["status", "--data", dataRoot, "--state", stateRoot]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes(dataRoot), "stdout 回显 dataRoot 路径");
    assert.ok(result.stdout.includes(stateRoot), "stdout 回显 stateRoot 路径");
    assert.ok(result.stdout.includes("文件数"), "有文件数行");
    assert.ok(result.stdout.includes("总字节"), "有总字节行");
    assert.ok(result.stdout.includes("topic 数"), "有 topic 数行");
    // dataRoot 3 个文件（2 topics + persona），topic 数 = 2；stateRoot 1 个文件、0 topic
    const dataBlock = result.stdout.split("stateRoot:")[0];
    assert.ok(/文件数:\s*3/.test(dataBlock), `dataRoot 文件数 3：${dataBlock}`);
    assert.ok(/topic 数:\s*2/.test(dataBlock), `dataRoot topic 数 2：${dataBlock}`);
    const stateBlock = "stateRoot:" + result.stdout.split("stateRoot:")[1];
    assert.ok(/文件数:\s*1/.test(stateBlock), `stateRoot 文件数 1：${stateBlock}`);
    assert.ok(/topic 数:\s*0/.test(stateBlock), `stateRoot topic 数 0：${stateBlock}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("admin status：缺省根走插件默认派生逻辑（DSH_HOME 注入 <tmp>/dsh）", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "shiori-admin-default-"));
  try {
    // 不给 --data/--state：应解析为 <DSH_HOME>/shiori-data 与 shiori-state。
    // 子进程注入 DSH_HOME 指向 temp——环境隔离，绝不触碰真实 ~/.dsh。
    const child = await new Promise((resolveRun) => {
      const proc = spawn(process.execPath, [ADMIN, "status"], {
        cwd: WORKQ,
        env: { ...process.env, DSH_HOME: path.join(base, "dsh") },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      proc.stdout.on("data", (chunk) => { stdout += String(chunk); });
      proc.on("exit", (code) => resolveRun({ code, stdout }));
      proc.stdin.end();
    });
    assert.equal(child.code, 0);
    assert.ok(child.stdout.includes(path.join(base, "dsh", "shiori-data")), "默认 dataRoot = <DSH_HOME>/shiori-data");
    assert.ok(child.stdout.includes(path.join(base, "dsh", "shiori-state")), "默认 stateRoot = <DSH_HOME>/shiori-state");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("admin destroy：二次确认输入错误 → exit 2，dataRoot 完好", async () => {
  const { base, dataRoot, stateRoot } = makeFakeRoots("shiori-admin-wrongcfm-");
  try {
    const result = await runAdmin(["destroy", "--data", dataRoot, "--state", stateRoot], { stdin: "not-the-root\n" });
    assert.equal(result.code, 2, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("已取消"), "提示已取消");
    assert.ok(existsSync(dataRoot), "dataRoot 未删");
    assert.ok(existsSync(path.join(stateRoot, "tool-ops", "a.json")), "stateRoot 完好");
    // 空输入（EOF）同样按取消处理（fail-closed）
    const eof = await runAdmin(["destroy", "--data", dataRoot, "--state", stateRoot], { stdin: "" });
    assert.equal(eof.code, 2, "EOF 无输入按取消处理");
    assert.ok(existsSync(dataRoot), "EOF 路径 dataRoot 未删");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("admin destroy：二次确认输入 dataRoot 原文 → exit 0，dataRoot 消失且 stateRoot 完好", async () => {
  const { base, dataRoot, stateRoot } = makeFakeRoots("shiori-admin-cfm-");
  try {
    const result = await runAdmin(["destroy", "--data", dataRoot, "--state", stateRoot], { stdin: `${dataRoot}\n` });
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("已焚毁"), "输出焚毁回执");
    assert.ok(!existsSync(dataRoot), "dataRoot 目录本身消失");
    assert.ok(existsSync(path.join(stateRoot, "tool-ops", "a.json")), "stateRoot 哨兵文件完好");
    assert.equal(readFileSync(path.join(stateRoot, "tool-ops", "a.json"), "utf8"), "{}\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("admin destroy --yes：跳过确认直接删（exit 0），删完 dataRoot 消失", async () => {
  const { base, dataRoot, stateRoot } = makeFakeRoots("shiori-admin-yes-");
  try {
    const result = await runAdmin(["destroy", "--data", dataRoot, "--state", stateRoot, "--yes"]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.ok(!existsSync(dataRoot), "dataRoot 消失");
    assert.ok(existsSync(stateRoot), "stateRoot 完好");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("admin destroy --yes：目录不存在 → exit 0（无东西可删）", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "shiori-admin-absent-"));
  try {
    const absent = path.join(base, "no-such-data");
    const result = await runAdmin(["destroy", "--data", absent, "--yes"]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("没有东西可删"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("admin destroy：安全校验 fail-closed（相对路径 / 含 .. / 指向 stateRoot 内 / 盘符根）→ exit 3", async () => {
  const { base, dataRoot, stateRoot } = makeFakeRoots("shiori-admin-unsafe-");
  try {
    const cases = [
      { args: ["destroy", "--data", "relative/path", "--yes"], rule: "absolute-path" },
      { args: ["destroy", "--data", `${dataRoot}/../elsewhere`, "--yes"], rule: "dotdot-segment" },
      // 目标是 stateRoot 本身 / stateRoot 的父目录：与 stateRoot 相交一律拒绝
      { args: ["destroy", "--data", stateRoot, "--state", stateRoot, "--yes"], rule: "state-root-overlap" },
      { args: ["destroy", "--data", base, "--state", stateRoot, "--yes"], rule: "state-root-overlap" },
      { args: ["destroy", "--data", path.parse(dataRoot).root, "--yes"], rule: "filesystem-root" },
    ];
    for (const { args, rule } of cases) {
      const result = await runAdmin(args);
      assert.equal(result.code, 3, `exit 3 for ${args.join(" ")}\nstderr: ${result.stderr}`);
      // 盘符根用例会先命中 state-root-overlap（stateRoot 必在盘根之下、互相嵌套），
      // 两条规则都成立——只要求命中规则名之一，且都是 fail-closed 拒绝。
      if (rule === "filesystem-root") {
        assert.ok(
          result.stderr.includes("filesystem-root") || result.stderr.includes("state-root-overlap"),
          `盘符根被拒（规则名出现在报错里）：${result.stderr}`,
        );
      } else {
        assert.ok(result.stderr.includes(rule), `${rule} 规则名出现在报错里：${result.stderr}`);
      }
      assert.ok(result.stderr.includes("安全校验未通过"));
    }
    assert.ok(existsSync(dataRoot), "安全拒绝路径下 dataRoot 完好");
    assert.ok(existsSync(path.join(stateRoot, "tool-ops", "a.json")), "安全拒绝路径下 stateRoot 完好");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("admin destroy：用法错误 → exit 1（缺 --data / 未知子命令 / 未知参数）", async () => {
  const missing = await runAdmin(["destroy"]);
  assert.equal(missing.code, 1, "缺 --data 是用法错误");
  assert.ok(missing.stderr.includes("--data"));
  const unknownSub = await runAdmin(["frobnicate"]);
  assert.equal(unknownSub.code, 1, "未知子命令是用法错误");
  const unknownFlag = await runAdmin(["status", "--bogus"]);
  assert.equal(unknownFlag.code, 1, "未知参数是用法错误");
});

test("admin destroy：与面板同源的安全实现——dataRoot 是 symlink 时拒绝（不跟链）", async () => {
  const { base, dataRoot, stateRoot } = makeFakeRoots("shiori-admin-link-");
  try {
    const linkPath = path.join(base, "data-link");
    try {
      symlinkSync(dataRoot, linkPath, "junction");
    } catch (error) {
      // 仅在 junction 创建本身不可用（EPERM 等系统错误）时如实跳过；
      // 代码缺陷（如未导入 symlinkSync 的 ReferenceError）必须照常变红，
      // 不许被这个 catch 静默吞掉（review-rework a1 修复）。
      if (error instanceof ReferenceError || !(typeof error.code === "string")) throw error;
      return;
    }
    const result = await runAdmin(["destroy", "--data", linkPath, "--state", stateRoot, "--yes"]);
    assert.equal(result.code, 3, `symlink 目标必须拒绝：${result.stderr}`);
    assert.ok(result.stderr.includes("symlink-target"));
    assert.ok(existsSync(dataRoot), "真实 dataRoot 完好");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// 中-3（review-rework a1）：purge 最关键的一条边界——dataRoot 内部的
// junction/符号链接只删链接本身，绝不递归进链接目标。真子进程用例锁住：
// 外部 sentinel 目录经 dataRoot 内 junction 指向，destroy --yes 后 sentinel
// 内容逐字节完好、junction 链接随 dataRoot 一起消失。退化实验（把删除实现
// 改成「递归进链接目标」）下本用例必红（sentinel 被连坐删除）。
test("admin destroy --yes：dataRoot 内部 junction 只删链接本身，外部 sentinel 完好", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "shiori-admin-junc-"));
  try {
    const dataRoot = path.join(base, "data");
    const stateRoot = path.join(base, "state");
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(path.join(stateRoot, "tool-ops.json"), "{}", "utf8");
    // 外部 sentinel（在 dataRoot 之外、stateRoot 之外）：junction 的真实目标
    const sentinel = path.join(base, "sentinel");
    mkdirSync(sentinel, { recursive: true });
    writeFileSync(path.join(sentinel, "keep.txt"), "sentinel-bytes\n", "utf8");
    // dataRoot 内部：普通文件 + 指向 sentinel 的 junction + 深层目录里的 junction
    mkdirSync(path.join(dataRoot, "scopes", "amber"), { recursive: true });
    writeFileSync(path.join(dataRoot, "plain.txt"), "plain", "utf8");
    writeFileSync(path.join(dataRoot, "scopes", "amber", "t.md"), "topic", "utf8");
    symlinkSync(sentinel, path.join(dataRoot, "link-top"), "junction");
    symlinkSync(sentinel, path.join(dataRoot, "scopes", "amber", "link-deep"), "junction");

    const result = await runAdmin(["destroy", "--data", dataRoot, "--state", stateRoot, "--yes"]);
    assert.equal(result.code, 0, `stderr: ${result.stderr}`);
    assert.ok(!existsSync(dataRoot), "dataRoot 目录消失（junction 链接随之移除，未递归进目标）");
    // 外部 sentinel 完好：目录在、文件逐字节完好（递归进链接目标的实现会把
    // sentinel 连坐删除，本断言变红）
    assert.ok(existsSync(sentinel), "外部 sentinel 目录仍在");
    assert.equal(readFileSync(path.join(sentinel, "keep.txt"), "utf8"), "sentinel-bytes\n", "sentinel 内容逐字节完好");
    assert.ok(existsSync(stateRoot), "stateRoot 完好");
    assert.equal(readFileSync(path.join(stateRoot, "tool-ops.json"), "utf8"), "{}", "stateRoot 内容完好");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
