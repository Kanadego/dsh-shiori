/**
 * 证据完整性测试：runner 的磁盘核验必须抓出篡改、丢失、symlink、越根；
 * validate 必须拒绝伪造的真实等级标签；CLI validate 的退出码与结论一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runAcceptanceMatrix, validateEvidenceBundle, verifyArtifactsOnDisk } from "../../src/acceptance/index.mjs";
import { createSyntheticCompletionFactory, createSyntheticRuntimeFactory } from "../../src/acceptance/synthetic.mjs";
import { withTempDir } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const WORKSPACE_ROOT = path.resolve(import.meta.dirname, "../..");

async function runMatrixInto(root) {
  const bundle = await runAcceptanceMatrix({
    runtimeFactory: createSyntheticRuntimeFactory,
    completionFactory: createSyntheticCompletionFactory(),
    evidenceRoot: root,
    runId: "integrity-run",
  });
  const verdict = validateEvidenceBundle(bundle);
  assert.equal(verdict.valid, true, JSON.stringify(verdict.errors));
  return bundle;
}

test("a clean run's artifacts verify on disk", async () => {
  await withTempDir("shiori-accept-int-", async (root) => {
    const bundle = await runMatrixInto(root);
    const disk = await verifyArtifactsOnDisk(bundle, root);
    assert.equal(disk.ok, true, JSON.stringify(disk.errors));
  });
});

test("tampered artifact bytes are caught by hash mismatch", async () => {
  await withTempDir("shiori-accept-int-", async (root) => {
    const bundle = await runMatrixInto(root);
    const artifact = bundle.cases.find((c) => c.artifacts.length > 0).artifacts[0];
    const full = path.join(root, artifact.path);
    // 原位翻转一个字节：字节数不变，只有 hash 变 —— 单测 hash 校验本身。
    const original = await readFile(full);
    original[0] = original[0] ^ 0xff;
    await writeFile(full, original);
    const disk = await verifyArtifactsOnDisk(bundle, root);
    assert.equal(disk.ok, false);
    assert.ok(disk.errors.some((e) => e.code === "ARTIFACT_HASH_MISMATCH" && e.path === artifact.path), JSON.stringify(disk.errors));
    assert.ok(!disk.errors.some((e) => e.code === "ARTIFACT_BYTES_MISMATCH"), "same-length tamper must not be reported as a bytes mismatch");
  });
});

test("deleted artifact files are caught", async () => {
  await withTempDir("shiori-accept-int-", async (root) => {
    const bundle = await runMatrixInto(root);
    const artifact = bundle.cases.find((c) => c.artifacts.length > 0).artifacts[0];
    await unlink(path.join(root, artifact.path));
    const disk = await verifyArtifactsOnDisk(bundle, root);
    assert.equal(disk.ok, false);
    assert.ok(disk.errors.some((e) => e.code === "ARTIFACT_MISSING"));
  });
});

test("artifact replaced by a symlink is rejected (when the FS allows symlink creation)", async () => {
  await withTempDir("shiori-accept-int-", async (root) => {
    const bundle = await runMatrixInto(root);
    const artifact = bundle.cases.find((c) => c.artifacts.length > 0).artifacts[0];
    const full = path.join(root, artifact.path);
    const target = path.join(root, "link-target.txt");
    await writeFile(target, "outside content", "utf8");
    try {
      await unlink(full);
      await symlink(target, full, "file");
    } catch (error) {
      // Windows 无符号链接权限（非开发者模式）时跳过本项，但必须如实标注。
      assert.match(String(error.code ?? error), /EPERM|ENOENT|EACCES|symlink/i);
      return;
    }
    const disk = await verifyArtifactsOnDisk(bundle, root);
    assert.equal(disk.ok, false);
    assert.ok(disk.errors.some((e) => e.code === "ARTIFACT_SYMLINK"));
  });
});

test("a valid file under a symlink/junction PARENT is rejected（反馈 F2 链接父目录越根）", async () => {
  await withTempDir("shiori-accept-int-", async (root) => {
    // 外部目标放独立临时目录：证明确实指向 evidenceRoot 之外，且测试自清理。
    await withTempDir("shiori-accept-outside-", async (outsideDir) => {
      const bundle = await runMatrixInto(root);
      const caseEntry = bundle.cases.find((c) => c.artifacts.length > 0);
      const artifact = caseEntry.artifacts[0];
      const fileName = path.basename(artifact.path);
      // 把真实 artifact 文件移到 root 外；bundle 登记路径改为穿过链接父目录。
      // 字节数与 SHA256 都保持"正确"—— 只有父目录是链接，核验必须拒绝。
      await rename(path.join(root, artifact.path), path.join(outsideDir, fileName));
      await mkdir(path.join(root, caseEntry.id, "link-holder"), { recursive: true });
      const linkPath = path.join(root, caseEntry.id, "link-holder", "link");
      try {
        await symlink(outsideDir, linkPath, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        assert.match(String(error.code ?? error), /EPERM|EACCES|symlink/i);
        return;
      }
      artifact.path = `${caseEntry.id}/link-holder/link/${fileName}`;
      const disk = await verifyArtifactsOnDisk(bundle, root);
      assert.equal(disk.ok, false, "a link parent must not verify even with correct bytes and sha256");
      assert.ok(
        disk.errors.some((e) => e.code === "ARTIFACT_PARENT_LINK" && e.path === artifact.path),
        JSON.stringify(disk.errors),
      );
    });
  });
});

test("artifact paths escaping the evidence root are rejected by the verifier", async () => {
  await withTempDir("shiori-accept-int-", async (root) => {
    const bundle = await runMatrixInto(root);
    // 直接把一个真实存在但越根的文件塞进 bundle（模拟清单造假）。
    const escapeTarget = path.join(path.dirname(root), "outside.txt");
    await writeFile(escapeTarget, "out of root", "utf8");
    const caseEntry = bundle.cases[0];
    caseEntry.artifacts.push({
      path: "../outside.txt",
      sha256: "b".repeat(64),
      bytes: 12,
      kind: "raw-request",
    });
    const disk = await verifyArtifactsOnDisk(bundle, root);
    assert.equal(disk.ok, false);
    assert.ok(disk.errors.some((e) => e.code === "ARTIFACT_PATH" && e.path === "../outside.txt"));
  });
});

test("claiming isolated-dsh on synthetic evidence is rejected by validate", async () => {
  await withTempDir("shiori-accept-int-", async (root) => {
    const bundle = await runMatrixInto(root);
    // 伪造 1：bundle 级升级。
    const upgraded = { ...bundle, evidenceType: "isolated-dsh" };
    assert.equal(validateEvidenceBundle(upgraded).valid, false);
    // 伪造 2：case 级升级（即便带上 artifact 也只是 synthetic 内容）。
    const caseUpgraded = JSON.parse(JSON.stringify(bundle));
    caseUpgraded.cases[0].evidenceType = "isolated-dsh";
    assert.equal(validateEvidenceBundle(caseUpgraded).valid, false);
    // 伪造 3：case 级升级为 replay —— 即便有 raw-request artifact，case 等级也不得高于 bundle。
    const replayUpgraded = JSON.parse(JSON.stringify(bundle));
    replayUpgraded.cases[0].evidenceType = "replay";
    const verdict = validateEvidenceBundle(replayUpgraded);
    assert.equal(verdict.valid, false);
    assert.ok(verdict.errors.some((e) => e.code === "EVIDENCE_LEVEL_MISMATCH"), JSON.stringify(verdict.errors));
  });
});

test("CLI validate exits 0 on a clean bundle and 1 on a tampered one", async () => {
  await withTempDir("shiori-accept-int-", async (root) => {
    const bundle = await runMatrixInto(root);
    const bundlePath = path.join(root, "bundle.json");
    await writeFile(bundlePath, JSON.stringify(bundle), "utf8");
    const clean = await execFileAsync(process.execPath, [
      "src/acceptance/cli.mjs", "validate", "--bundle", bundlePath, "--evidence-root", root,
    ], { cwd: WORKSPACE_ROOT, timeout: 60_000 });
    assert.equal(JSON.parse(clean.stdout).valid, true);

    const tampered = JSON.parse(await readFile(bundlePath, "utf8"));
    const artifact = tampered.cases.find((c) => c.artifacts.length > 0).artifacts[0];
    await writeFile(path.join(root, artifact.path), "TAMPERED", "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, [
        "src/acceptance/cli.mjs", "validate", "--bundle", bundlePath, "--evidence-root", root,
      ], { cwd: WORKSPACE_ROOT, timeout: 60_000 }),
      (error) => error.code === 1 && /ARTIFACT_HASH_MISMATCH|diskVerification/.test(error.stdout),
    );
  });
});

test("CLI validate on a structurally broken bundle exits 1", async () => {
  await withTempDir("shiori-accept-int-", async (root) => {
    const bundlePath = path.join(root, "broken.json");
    await writeFile(bundlePath, JSON.stringify({ schemaVersion: 1, runId: "x", evidenceType: "synthetic", source: {}, cases: [] }), "utf8");
    await assert.rejects(
      execFileAsync(process.execPath, ["src/acceptance/cli.mjs", "validate", "--bundle", bundlePath], { cwd: WORKSPACE_ROOT, timeout: 60_000 }),
      (error) => error.code === 1,
    );
  });
});
