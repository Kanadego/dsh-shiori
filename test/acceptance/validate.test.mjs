/**
 * validateEvidenceBundle 的结构与语义校验测试。
 * 负样本覆盖：缺 case、重复 id、坏 schema、越根路径、坏 hash/bytes/kind、
 * not-run 无原因、真实等级 passed 无捕获证据、假 isolated-dsh 标签。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_CASE_IDS, validateEvidenceBundle } from "../../src/acceptance/index.mjs";
import { makeMinimalBundle, sha256Of } from "./helpers.mjs";

function codesOf(bundle) {
  return new Set(validateEvidenceBundle(bundle).errors.map((e) => e.code));
}

test("minimal valid bundle (11 synthetic passed cases) is valid", () => {
  const result = validateEvidenceBundle(makeMinimalBundle());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.cases.length, REQUIRED_CASE_IDS.length);
  assert.deepEqual(result.errors, []);
});

test("missing a required case id is invalid", () => {
  const bundle = makeMinimalBundle();
  bundle.cases = bundle.cases.filter((c) => c.id !== "compress-negative");
  const codes = codesOf(bundle);
  assert.ok(codes.has("CASE_MISSING"), [...codes].join(","));
  assert.equal(bundle.cases.length, REQUIRED_CASE_IDS.length - 1);
});

test("duplicate case id is invalid", () => {
  const bundle = makeMinimalBundle();
  bundle.cases[1] = { ...bundle.cases[0] };
  assert.ok(codesOf(bundle).has("CASE_DUPLICATE"));
});

test("wrong schemaVersion / runId / evidenceType are invalid", () => {
  assert.ok(codesOf(makeMinimalBundle({ bundleOverrides: { schemaVersion: 2 } })).has("SCHEMA_VERSION"));
  assert.ok(codesOf(makeMinimalBundle({ bundleOverrides: { runId: "" } })).has("RUN_ID"));
  assert.ok(codesOf(makeMinimalBundle({ bundleOverrides: { evidenceType: "real" } })).has("EVIDENCE_TYPE"));
});

test("empty cases array is invalid", () => {
  assert.ok(codesOf(makeMinimalBundle({ bundleOverrides: { cases: [] } })).has("CASES"));
});

test("bad case status / evidenceType are invalid", () => {
  assert.ok(codesOf(makeMinimalBundle({ caseStatus: "skipped" })).has("CASE_STATUS"));
  assert.ok(codesOf(makeMinimalBundle({ caseEvidenceType: "isolated" })).has("CASE_EVIDENCE_TYPE"));
});

test("artifact path escapes are rejected (.. / absolute / drive / backslash)", () => {
  for (const bad of ["../escape.json", "/abs/x.json", "C:/x.json", "a\\b.json", "a/../../b.json", "./x.json", "dir/"]) {
    const bundle = makeMinimalBundle({ caseArtifacts: [{ path: bad, sha256: sha256Of(), bytes: 12, kind: "raw-request" }] });
    const codes = codesOf(bundle);
    assert.ok(codes.has("ARTIFACT_PATH"), `expected ARTIFACT_PATH for ${JSON.stringify(bad)}, got ${[...codes].join(",")}`);
  }
});

test("artifact sha256 / bytes / kind shape is enforced", () => {
  const base = { path: "case/x.json", bytes: 12, kind: "raw-request" };
  assert.ok(codesOf(makeMinimalBundle({ caseArtifacts: [{ ...base, sha256: "nothex" }] })).has("ARTIFACT_SHA256"));
  assert.ok(codesOf(makeMinimalBundle({ caseArtifacts: [{ ...base, sha256: "A".repeat(64) }] })).has("ARTIFACT_SHA256"));
  for (const bytes of [0, -1, 1.5, "12", undefined]) {
    assert.ok(codesOf(makeMinimalBundle({ caseArtifacts: [{ ...base, sha256: sha256Of(), bytes }] })).has("ARTIFACT_BYTES"), String(bytes));
  }
  assert.ok(codesOf(makeMinimalBundle({ caseArtifacts: [{ ...base, sha256: sha256Of(), kind: "" }] })).has("ARTIFACT_KIND"));
});

test("source shape is enforced but never upgrades evidence level", () => {
  const noRuntime = makeMinimalBundle({ bundleOverrides: { source: { sourceHashes: {}, profileKind: "synthetic-fixture" } } });
  assert.ok(codesOf(noRuntime).has("SOURCE_RUNTIME_VERSION"));
  const badHash = makeMinimalBundle({ bundleOverrides: { source: { runtimeVersion: "v24", sourceHashes: { "../x": sha256Of() }, profileKind: "synthetic-fixture" } } });
  assert.ok(codesOf(badHash).has("SOURCE_HASH_PATH"));
  const badProfile = makeMinimalBundle({ bundleOverrides: { source: { runtimeVersion: "v24", sourceHashes: {}, profileKind: "real-dsh" } } });
  // profileKind 自报为 real-dsh 不构成错误（只是元数据），但也绝不把等级升为 isolated-dsh：
  assert.equal(validateEvidenceBundle(badProfile).valid, true);
  assert.equal(badProfile.evidenceType, "synthetic");
});

test("not-run and failed cases require a reason", () => {
  const notRun = makeMinimalBundle({ caseStatus: "not-run" });
  // helpers 会为非 passed 附上 reason；去掉后必须 invalid。
  for (const c of notRun.cases) delete c.reason;
  assert.ok(codesOf(notRun).has("NOT_RUN_REASON"));
  const failed = makeMinimalBundle({ caseStatus: "failed" });
  for (const c of failed.cases) delete c.reason;
  assert.ok(codesOf(failed).has("FAILED_REASON"));
});

test("every passed case must carry at least one artifact（反馈 B2 负样本）", () => {
  const emptyEvidence = makeMinimalBundle({ caseArtifacts: [] });
  assert.ok(codesOf(emptyEvidence).has("PASSED_WITHOUT_EVIDENCE"), [...codesOf(emptyEvidence)].join(","));
  // 即便整包全 passed，空 artifacts 也绝不能 valid=true。
  assert.equal(validateEvidenceBundle(emptyEvidence).valid, false);
});

test("replay/isolated-dsh passed case without a raw-request artifact is invalid", () => {
  const bundle = makeMinimalBundle({ caseEvidenceType: "replay", bundleEvidenceType: "replay" });
  assert.ok(codesOf(bundle).has("REAL_PASSED_WITHOUT_EVIDENCE"));
  const withRaw = makeMinimalBundle({
    caseEvidenceType: "replay",
    bundleEvidenceType: "replay",
    caseArtifacts: [{ path: "case/request-0.raw.json", sha256: sha256Of(), bytes: 120, kind: "raw-request" }],
  });
  assert.equal(validateEvidenceBundle(withRaw).valid, true, JSON.stringify(validateEvidenceBundle(withRaw).errors));
  // raw-event 同样可作为真实等级的捕获证据（事件型 case）。
  const withRawEvent = makeMinimalBundle({
    caseEvidenceType: "replay",
    bundleEvidenceType: "replay",
    caseArtifacts: [{ path: "case/raw-events.json", sha256: sha256Of(), bytes: 120, kind: "raw-event" }],
  });
  assert.equal(validateEvidenceBundle(withRawEvent).valid, true, JSON.stringify(validateEvidenceBundle(withRawEvent).errors));
});

test("fake isolated-dsh bundle label over synthetic passed cases is rejected", () => {
  const bundle = makeMinimalBundle();
  bundle.evidenceType = "isolated-dsh";
  const codes = codesOf(bundle);
  assert.ok(codes.has("EVIDENCE_LEVEL_MISMATCH"), [...codes].join(","));
  const emptyPassed = makeMinimalBundle({ caseStatus: "not-run", bundleEvidenceType: "isolated-dsh" });
  assert.ok(codesOf(emptyPassed).has("EVIDENCE_LEVEL_MISMATCH"));
});

test("replay bundle label tolerates isolated-dsh cases but not synthetic ones", () => {
  const mixed = makeMinimalBundle({ caseEvidenceType: "synthetic", bundleEvidenceType: "replay" });
  assert.ok(codesOf(mixed).has("EVIDENCE_LEVEL_MISMATCH"));
  const consistent = makeMinimalBundle({ caseStatus: "not-run" });
  // 全部 not-run（带 reason）→ 没有 passed case，bundle evidenceType=synthetic 合法。
  assert.equal(validateEvidenceBundle(consistent).valid, true);
});

test("non-object bundles are invalid without throwing", () => {
  for (const bad of [null, undefined, 42, "bundle", [], true]) {
    const result = validateEvidenceBundle(bad);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});
