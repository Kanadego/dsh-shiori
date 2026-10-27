/**
 * test/acceptance 共享夹具：临时目录（mkdtemp + finally 清理）与最小合法 bundle 构造器。
 * 只用合成数据；不读写真实记忆，不联网（127.0.0.1 loopback 除外）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { REQUIRED_CASE_IDS } from "../../src/acceptance/index.mjs";

/** 在临时目录中执行 fn，结束（含抛错）后递归清理。 */
export async function withTempDir(prefix, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function sha256Of() {
  // 64 个十六进制字符的占位 sha256（validate 只查形状，磁盘核验才查内容）。
  return "a".repeat(64);
}

/** 构造一个结构合法、全部必需 case 齐全的最小 bundle；overrides 深度仅作用于顶层字段。 */
export function makeMinimalBundle({
  caseStatus = "passed",
  caseEvidenceType = "synthetic",
  caseArtifacts = [{ path: "case/case-result.json", sha256: sha256Of(), bytes: 16, kind: "case-log" }],
  bundleEvidenceType = "synthetic",
  caseOverrides = {},
  bundleOverrides = {},
} = {}) {
  const bundle = {
    schemaVersion: 1,
    runId: "test-run-0001",
    evidenceType: bundleEvidenceType,
    source: {
      runtimeVersion: "v24.22.1",
      sourceHashes: { "src/acceptance/index.mjs": sha256Of() },
      profileKind: "synthetic-fixture",
    },
    cases: REQUIRED_CASE_IDS.map((id) => ({
      id,
      status: caseStatus,
      evidenceType: caseEvidenceType,
      artifacts: caseArtifacts,
      ...(caseStatus === "passed" || caseStatus === "failed" || caseStatus === "not-run"
        ? (caseStatus === "passed" ? {} : { reason: "合成原因：测试占位" })
        : {}),
      ...caseOverrides,
    })),
    ...bundleOverrides,
  };
  return bundle;
}
