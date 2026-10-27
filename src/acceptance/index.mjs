/**
 * Shiori P1-ACCEPTANCE — 出站证据与验收矩阵（CONTRACTS.md「F：出站证据与矩阵接口」）。
 *
 * 公开接口：
 * - validateEvidenceBundle(bundle) → {valid, cases, errors}：结构与语义校验；无效不得 valid=true。
 * - runAcceptanceMatrix({runtimeFactory, completionFactory, capture, fixtureRoot, evidenceRoot, ...})
 *   → schemaVersion=1 的 bundle。runner 在写报告前独立核验 artifact 文件存在、字节与 SHA256，
 *   拒绝越根路径与 symlink；任何真实通过必须有对应捕获证据。
 *
 * 证据等级纪律（tasks/F.md「必做」第 3 条）：
 * - 普通HTTP客户端自发请求只能是 synthetic；replay 是 replay；不能标 isolated-dsh。
 * - source 自报（runtimeVersion/profileKind）不能升级证据等级 —— bundle 级 evidenceType
 *   只能由全部 passed case 的 case 级 evidenceType 推导，且 validate 强制一致。
 * - 缺真实环境/缺注入工厂的组合 → not-run，附重跑步骤；不可 skip 后总通过。
 *
 * 依赖注入边界：runtimeFactory 须返回 D 契约形状的 runtime
 * （{start, stop, refresh, diagnostics, service, bridge, host}）；completionFactory 须返回
 * E 契约形状的 openCompletionState({root, scopeId})。D/E 未 accepted 时用标明 synthetic
 * 的替身（见 ./synthetic.mjs），产出的 bundle evidenceType=synthetic，不声称真实宿主通过。
 */
import { createHash } from "node:crypto";
import { mkdir, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLoopbackCapture, sendProviderRequest } from "./loopback-capture.mjs";

/** 契约固定的矩阵 case（CONTRACTS.md「固定至少」11 项）+ 反馈增补项；bundle 必须包含全部 id。 */
export const REQUIRED_CASE_IDS = Object.freeze([
  "shadow-clean",
  "active-ownership-conflict",
  "full-system-first",
  "write-next-request",
  "route-switch",
  "compress-direct",
  "compress-ptc",
  "compress-negative",
  "restart-dedup",
  // 反馈(attempt 4) F3：进程边界参考实现独立命名，紧跟 restart-dedup。
  "restart-dedup-process",
  "operation-replay",
  "stop-cleanup",
  // 反馈(attempt 3) F1 增补：
  "global-fallback",
]);

export const EVIDENCE_TYPES = Object.freeze(["synthetic", "replay", "isolated-dsh"]);
export const CASE_STATUSES = Object.freeze(["passed", "failed", "not-run"]);
/** runner 允许调用方声明的 case 证据等级；isolated-dsh 只能由负责人 P1b 授予（见 README §4）。 */
export const RUNNABLE_CASE_EVIDENCE_TYPES = Object.freeze(["synthetic", "replay"]);

// ─────────────────────────────────────────────────────────────────────────────
// 独立夹具（反馈 B1 的核心修复）
// ─────────────────────────────────────────────────────────────────────────────
// 期望字节来自这组**固定常量**：矩阵把夹具注入 runtimeFactory（工厂必须按夹具原样
// 播种 service），再用自己的 renderTopicIndex() 按文档化的派生索引格式独立拼出期望
// system，与捕获到的 raw wire 字节做 Buffer.compare。绝不从 service 的返回值反推期望
// ——那是对同一实现走两条路径的自证。若注入 service 的派生索引不符合文档格式，
// full-system-first 会如实 failed（这就是夹具要挑戰的投影偏差）。
const FIXTURE_HOST_OWN = "FIXTURE-HOST-OWN: synthetic harness host text, must survive every projection byte-for-byte.";
const FIXTURE_PERSONA = "# FIXTURE-P0 独立夹具人设\n这是验收矩阵自带的固定 L0 文本，与 service 返回值无关。";
const FIXTURE_CORE_BASE = "## FIXTURE-L1-BASE 独立夹具铁律\n这是验收矩阵自带的固定 L1 正文。";
const FIXTURE_TOPICS = Object.freeze([
  Object.freeze({ key: "fix-topic-a", title: "夹具主题A", summary: "独立夹具摘要A", body: "## 2026-10-24 — 夹具\nFIXTURE-TOPIC-A 的固定正文。" }),
  Object.freeze({ key: "fix-topic-b", title: "夹具主题B", summary: "独立夹具摘要B", body: "## 2026-10-24 — 夹具\nFIXTURE-TOPIC-B 的固定正文。" }),
]);
const FIXTURE_CORE_WRITTEN = "## FIXTURE-L1-WRITTEN 独立夹具写后正文\n写后下一请求必须逐字节出现的固定内容（FIXTURE-WRITE-MARKER-W1）。";
// global-fallback 夹具（反馈 F1）：种进 global scope 的固定 L1 字节 + 活动域私有写后字节。
const FIXTURE_GLOBAL_CORE = "## FIXTURE-GLOBAL-CORE 全局种子\n这是验收矩阵种进 global scope 的固定 L1 正文；活动域的任何写不得改动这些字节。";
const FIXTURE_ACTIVE_SHADOW = `${FIXTURE_GLOBAL_CORE}\nFIXTURE-ACTIVE-SHADOW-W1 活动域私有正文（写必须只落 active scope）。`;

/** 矩阵矩阵夹具（冻结；工厂注入与期望构造共用同一份常量，但期望不经 service 返回值）。 */
export const MATRIX_FIXTURE = Object.freeze({
  hostOwnSystem: FIXTURE_HOST_OWN,
  personaText: FIXTURE_PERSONA,
  coreText: FIXTURE_CORE_BASE,
  coreWrittenText: FIXTURE_CORE_WRITTEN,
  topics: FIXTURE_TOPICS,
  globalCoreText: FIXTURE_GLOBAL_CORE,
  activeShadowText: FIXTURE_ACTIVE_SHADOW,
});

/**
 * 按文档化约定渲染派生主题索引（与 docs/core/INTERFACE.md、基线 fake service 一致）：
 * 标题行 + 按 key 升序的 `- <key> [<scopeId>] — <summary>` 行。
 * 这是矩阵【独立】构造期望 L1 的依据；注入 service 必须实现同一文档格式。
 */
export function renderTopicIndex(topics) {
  const list = (Array.isArray(topics) ? topics : []).filter((t) => t && typeof t.key === "string");
  if (list.length === 0) return "";
  const lines = [...list]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((t) => `- ${t.key} [${t.scopeId ?? "scope-matrix"}] — ${t.summary ?? ""}`);
  return `## 主题记忆索引 / Topic memory index\n${lines.join("\n")}`;
}

/** 独立构造完整 L1 视图期望：core 正文 + （非空时的）派生索引。 */
export function expectedCoreView(coreText, topics) {
  const index = renderTopicIndex(topics);
  if (coreText.length > 0 && index.length > 0) return `${coreText}\n\n${index}`;
  return `${coreText}${index}`;
}

/** 独立构造完整出站 system 期望字节：宿主自有 + L0 + 完整 L1（含派生索引）。 */
export function expectedCompleteSystemFromFixture(fixture = MATRIX_FIXTURE) {
  return [
    fixture.hostOwnSystem,
    fixture.personaText,
    expectedCoreView(fixture.coreText, fixture.topics),
  ].join("\n\n");
}

function coded(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
const INVALID_INPUT = (m, d) => coded("INVALID_INPUT", m, d);
const INVALID_STATE = (m, d) => coded("INVALID_STATE", m, d);

function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** artifact 路径安全性：相对、正斜杠、无 . ./ .. 段、无盘符、无反斜杠。 */
export function isSafeRelativeArtifactPath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  if (p.startsWith("/")) return false;
  if (p.endsWith("/")) return false;
  if (path.isAbsolute(p)) return false;
  const segments = p.split("/");
  return segments.every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

const SHA256_RE = /^[0-9a-f]{64}$/;

// ─────────────────────────────────────────────────────────────────────────────
// validateEvidenceBundle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 结构与语义校验一个证据 bundle。任何一项不满足都 valid=false（绝不部分豁免）。
 * @returns {{valid: boolean, cases: Array<{id:string,status:string,evidenceType:string,artifactCount:number}>, errors: Array<{code:string,message:string,caseId?:string,path?:string}>}}
 */
export function validateEvidenceBundle(bundle) {
  const errors = [];
  const add = (code, message, extra = {}) => errors.push({ code, message, ...extra });

  if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) {
    return { valid: false, cases: [], errors: [{ code: "INVALID_INPUT", message: "bundle must be an object" }] };
  }

  if (bundle.schemaVersion !== 1) {
    add("SCHEMA_VERSION", `schemaVersion must be 1, got ${JSON.stringify(bundle.schemaVersion)}`);
  }
  if (typeof bundle.runId !== "string" || bundle.runId.trim().length === 0) {
    add("RUN_ID", "runId must be a non-empty string");
  }
  if (!EVIDENCE_TYPES.includes(bundle.evidenceType)) {
    add("EVIDENCE_TYPE", `bundle.evidenceType must be one of ${EVIDENCE_TYPES.join("|")}, got ${JSON.stringify(bundle.evidenceType)}`);
  }

  // source：自报元数据。只要求字段存在且形状正确；绝不据此升级证据等级。
  const source = bundle.source;
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    add("SOURCE", "source must be an object {runtimeVersion, sourceHashes, profileKind}");
  } else {
    if (typeof source.runtimeVersion !== "string" || source.runtimeVersion.trim().length === 0) {
      add("SOURCE_RUNTIME_VERSION", "source.runtimeVersion must be a non-empty string");
    }
    if (source.sourceHashes === null || typeof source.sourceHashes !== "object" || Array.isArray(source.sourceHashes)) {
      add("SOURCE_HASHES", "source.sourceHashes must be an object mapping relative paths to sha256");
    } else {
      for (const [p, hash] of Object.entries(source.sourceHashes)) {
        if (!isSafeRelativeArtifactPath(p)) {
          add("SOURCE_HASH_PATH", `source.sourceHashes key must be a safe relative path, got ${JSON.stringify(p)}`);
        } else if (typeof hash !== "string" || !SHA256_RE.test(hash)) {
          add("SOURCE_HASH_VALUE", `source.sourceHashes["${p}"] must be a lowercase 64-hex sha256`);
        }
      }
    }
    if (typeof source.profileKind !== "string" || source.profileKind.trim().length === 0) {
      add("SOURCE_PROFILE_KIND", "source.profileKind must be a non-empty string");
    }
  }

  // cases：固定 11 项至少齐全，id 唯一。
  const cases = bundle.cases;
  if (!Array.isArray(cases) || cases.length === 0) {
    add("CASES", "cases must be a non-empty array");
  } else {
    const seen = new Map();
    for (const c of cases) {
      if (c === null || typeof c !== "object" || Array.isArray(c)) {
        add("CASE_SHAPE", "every case must be an object");
        continue;
      }
      const { id, status, evidenceType, artifacts, reason } = c;
      if (typeof id !== "string" || id.trim().length === 0) {
        add("CASE_ID", "case id must be a non-empty string");
        continue;
      }
      if (seen.has(id)) add("CASE_DUPLICATE", `duplicate case id "${id}"`, { caseId: id });
      seen.set(id, true);

      if (!CASE_STATUSES.includes(status)) {
        add("CASE_STATUS", `case "${id}" status must be one of ${CASE_STATUSES.join("|")}, got ${JSON.stringify(status)}`, { caseId: id });
      }
      if (!EVIDENCE_TYPES.includes(evidenceType)) {
        add("CASE_EVIDENCE_TYPE", `case "${id}" evidenceType must be one of ${EVIDENCE_TYPES.join("|")}, got ${JSON.stringify(evidenceType)}`, { caseId: id });
      }
      if (!Array.isArray(artifacts)) {
        add("CASE_ARTIFACTS", `case "${id}" artifacts must be an array`, { caseId: id });
      } else {
        for (const a of artifacts) {
          if (a === null || typeof a !== "object" || Array.isArray(a)) {
            add("ARTIFACT_SHAPE", `case "${id}" artifact must be an object`, { caseId: id });
            continue;
          }
          if (!isSafeRelativeArtifactPath(a.path)) {
            add("ARTIFACT_PATH", `case "${id}" artifact path must be a safe relative path under evidenceRoot, got ${JSON.stringify(a.path)}（拒绝越根/绝对路径/..）`, { caseId: id, path: typeof a.path === "string" ? a.path : undefined });
          }
          if (typeof a.sha256 !== "string" || !SHA256_RE.test(a.sha256)) {
            add("ARTIFACT_SHA256", `case "${id}" artifact ${JSON.stringify(a.path)} sha256 must be lowercase 64-hex`, { caseId: id });
          }
          if (!Number.isInteger(a.bytes) || a.bytes <= 0) {
            add("ARTIFACT_BYTES", `case "${id}" artifact ${JSON.stringify(a.path)} bytes must be a positive integer`, { caseId: id });
          }
          if (typeof a.kind !== "string" || a.kind.trim().length === 0) {
            add("ARTIFACT_KIND", `case "${id}" artifact ${JSON.stringify(a.path)} kind must be a non-empty string`, { caseId: id });
          }
        }
      }
      if (status === "not-run" && (typeof reason !== "string" || reason.trim().length === 0)) {
        add("NOT_RUN_REASON", `case "${id}" is not-run and must state a reason with rerun steps`, { caseId: id });
      }
      if (status === "failed" && (typeof reason !== "string" || reason.trim().length === 0)) {
        add("FAILED_REASON", `case "${id}" is failed and must state the concrete failure`, { caseId: id });
      }
      // 语义：任何 passed 都必须有证据；真实等级的 passed 必须有原始捕获证据，
      // 不能只相信 case.status（反馈 B2：synthetic passed 也不允许 artifacts=[]）。
      if (status === "passed") {
        if (!Array.isArray(artifacts) || artifacts.length === 0) {
          add("PASSED_WITHOUT_EVIDENCE",
            `case "${id}" is marked passed but carries no artifacts; every passed case must have at least a case-result artifact`,
            { caseId: id });
        } else if (evidenceType === "replay" || evidenceType === "isolated-dsh") {
          const hasRaw = artifacts.some((a) => a?.kind === "raw-request" || a?.kind === "raw-event");
          if (!hasRaw) {
            add("REAL_PASSED_WITHOUT_EVIDENCE",
              `case "${id}" claims ${evidenceType} passed but has no raw-request/raw-event capture artifact; a real pass must carry captured evidence`,
              { caseId: id });
          }
        }
      }
    }
    for (const required of REQUIRED_CASE_IDS) {
      if (!seen.has(required)) {
        add("CASE_MISSING", `required case "${required}" is missing from the bundle`);
      }
    }
  }

  // 语义：bundle 级证据等级与每个 passed case 的等级必须完全一致 —— 单个 case 不得高于
  // bundle（摘要掩盖真实声称），bundle 也不得高于 case（source 自报不能升级）。
  const passedCases = Array.isArray(cases) ? cases.filter((c) => c?.status === "passed") : [];
  if (EVIDENCE_TYPES.includes(bundle.evidenceType)) {
    const levelRank = { synthetic: 0, replay: 1, "isolated-dsh": 2 };
    const bundleRank = levelRank[bundle.evidenceType];
    for (const c of passedCases) {
      const caseRank = levelRank[c.evidenceType];
      if (caseRank === undefined) continue;
      if (caseRank !== bundleRank) {
        add("EVIDENCE_LEVEL_MISMATCH",
          `case "${c.id}" passed with evidenceType ${c.evidenceType} but the bundle claims ${bundle.evidenceType}; the bundle level must exactly describe the passed evidence`,
          { caseId: c.id });
      }
    }
    if (bundle.evidenceType === "isolated-dsh" && passedCases.length === 0) {
      add("EVIDENCE_LEVEL_MISMATCH", "bundle claims isolated-dsh but no case passed");
    }
  }

  return {
    valid: errors.length === 0,
    cases: (Array.isArray(cases) ? cases : [])
      .filter((c) => c && typeof c.id === "string")
      .map((c) => ({ id: c.id, status: c.status, evidenceType: c.evidenceType, artifactCount: Array.isArray(c.artifacts) ? c.artifacts.length : 0 })),
    errors,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// runner 侧：artifact 落盘与磁盘核验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把一份证据写入 evidenceRoot/<caseId>/<fileName>，返回 artifact 描述。
 * 内容为 Buffer 或 string；SHA256 与字节数由写入方实际计算。
 */
export async function writeArtifact(evidenceRoot, caseId, fileName, content, kind) {
  if (!isSafeRelativeArtifactPath(`${caseId}/${fileName}`)) {
    throw INVALID_INPUT(`artifact target must be a safe relative path, got ${caseId}/${fileName}`, {});
  }
  const dir = path.join(evidenceRoot, caseId);
  await mkdir(dir, { recursive: true });
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), "utf8");
  const full = path.join(dir, fileName);
  await writeFile(full, buffer);
  return { path: `${caseId}/${fileName}`, sha256: sha256Hex(buffer), bytes: buffer.length, kind };
}

/**
 * runner 在采信任何 case 结果前对 bundle 的 artifact 做磁盘核验：
 * 文件存在、是普通文件（symlink/junction 拒绝）、字节数与 SHA256 一致、路径不越 evidenceRoot。
 * 路径的每一级父目录也必须逐级核验是真实目录（lstat）：链接/junction 父目录可以把一个
 * 字节与 hash 都正确的普通文件指向 evidenceRoot 之外（反馈 F2），只查末级与字符串前缀拦不住。
 * @returns {Promise<{ok: boolean, errors: Array<{code,message,caseId,path}>}>}
 */
export async function verifyArtifactsOnDisk(bundle, evidenceRoot) {
  const errors = [];
  const rootAbs = path.resolve(evidenceRoot);
  for (const c of bundle.cases ?? []) {
    for (const a of c.artifacts ?? []) {
      const fail = (code, message) => errors.push({ code, message, caseId: c.id, path: a.path });
      if (!isSafeRelativeArtifactPath(a.path)) {
        fail("ARTIFACT_PATH", `artifact path ${JSON.stringify(a.path)} is not a safe relative path`);
        continue;
      }
      const full = path.resolve(rootAbs, a.path);
      if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) {
        fail("ARTIFACT_ESCAPE", `artifact ${a.path} resolves outside evidenceRoot`);
        continue;
      }
      // 逐级核验父目录：任何一级是 symlink/junction（Windows 上 lstat 同样报 symlink）
      // 或非目录，都拒绝 —— 链接父目录下的"合法"文件可能实际位于 evidenceRoot 之外。
      const segments = a.path.split("/");
      let parentLinkRejected = false;
      let cursor = rootAbs;
      for (let i = 0; i < segments.length - 1 && !parentLinkRejected; i += 1) {
        cursor = path.join(cursor, segments[i]);
        let parentStat;
        try {
          parentStat = await lstat(cursor);
        } catch {
          fail("ARTIFACT_PARENT_MISSING", `parent directory of ${a.path} does not exist under evidenceRoot (${segments[i]})`);
          parentLinkRejected = true;
          break;
        }
        if (parentStat.isSymbolicLink()) {
          fail("ARTIFACT_PARENT_LINK", `parent "${segments.slice(0, i + 1).join("/")}" of artifact ${a.path} is a symlink/junction; evidence must live under real directories inside evidenceRoot`);
          parentLinkRejected = true;
          break;
        }
        if (!parentStat.isDirectory()) {
          fail("ARTIFACT_PARENT_NOT_DIR", `parent "${segments.slice(0, i + 1).join("/")}" of artifact ${a.path} is not a directory`);
          parentLinkRejected = true;
          break;
        }
      }
      if (parentLinkRejected) continue;
      let st;
      try {
        st = await lstat(full);
      } catch {
        fail("ARTIFACT_MISSING", `artifact file ${a.path} does not exist under evidenceRoot`);
        continue;
      }
      if (st.isSymbolicLink()) {
        fail("ARTIFACT_SYMLINK", `artifact ${a.path} is a symlink; evidence must be plain files`);
        continue;
      }
      if (!st.isFile()) {
        fail("ARTIFACT_NOT_FILE", `artifact ${a.path} is not a regular file`);
        continue;
      }
      if (st.size !== a.bytes) {
        fail("ARTIFACT_BYTES_MISMATCH", `artifact ${a.path} has ${st.size} bytes on disk but bundle claims ${a.bytes}`);
        // 字节数不符也继续核验 hash：篡改往往同时改变两者，两类证据都要落。
      }
      const content = await readFile(full);
      const actual = sha256Hex(content);
      if (actual !== a.sha256) {
        fail("ARTIFACT_HASH_MISMATCH", `artifact ${a.path} sha256 mismatch (tampered or stale bundle): disk=${actual} claimed=${a.sha256}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// runAcceptanceMatrix
// ─────────────────────────────────────────────────────────────────────────────

const RERUN_RUNTIME = "重跑步骤：注入 runtimeFactory（返回 {start,stop,refresh,diagnostics,service,bridge,host}，可用 src/acceptance/synthetic.mjs 的 createSyntheticRuntimeFactory 作参考）后重新运行矩阵。";
const RERUN_COMPLETION = "重跑步骤：注入 completionFactory（E 的 openCompletionState({root,scopeId}) → {sink,flush,close,diagnostics}）后重新运行矩阵。";
const RERUN_REAL = "重跑步骤：在隔离测试 profile/data root 接真实 DSH 宿主并由负责人运行 P1b 采集（见 docs/HOST-ACCEPTANCE.md）；synthetic 运行不能升级本项。";

function describeError(error) {
  if (error instanceof Error) {
    return `${error.code ? `[${error.code}] ` : ""}${error.message}`;
  }
  return String(error);
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(INVALID_STATE(`${label} timed out after ${ms}ms（超时即失败，不吞）`, {})), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** teardown 前等待超时 case 遗留工作的预算（有界；case 状态已按超时记 failed，不因此改变）。 */
const ABANDONED_SETTLE_MS = 20_000;

/**
 * 递归删除 + Windows delete-pending 竞态的有限重试（ENOTEMPTY/EBUSY/EPERM）。
 * 重试耗尽仍失败则抛出 —— 由 teardown 纪律显式上报，绝不静默（不掩盖问题）。
 */
async function rmWithRetry(target, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

/** 校验 runtimeFactory 返回值满足 D 契约形状。 */
function requireRuntimeShape(runtime, label) {
  const missing = [];
  for (const field of ["start", "stop", "refresh", "diagnostics"]) {
    if (typeof runtime?.[field] !== "function") missing.push(field);
  }
  for (const field of ["service", "bridge", "host"]) {
    if (runtime?.[field] === null || typeof runtime?.[field] !== "object") missing.push(field);
  }
  if (missing.length > 0) {
    throw INVALID_STATE(`${label} must return {start,stop,refresh,diagnostics,service,bridge,host}; missing: ${missing.join(", ")}`, {});
  }
  return runtime;
}

async function startRuntime(runtime) {
  const result = await runtime.start();
  return result ?? {};
}

/**
 * 执行 case 主体并在结束时 await stop（反馈 F1：D 契约 stop 可为异步，绝不许裸调用）。
 * 主体错误优先；stop 失败在主体成功时抛出、在主体失败时附到 details.stopError ——
 * 两个错误都不吞、互不掩盖。状态检查只能发生在 stop settle 之后。
 */
async function runCaseBodyWithStop(runtime, body) {
  let bodyError = null;
  let value;
  try {
    value = await body();
  } catch (error) {
    bodyError = error;
  }
  let stopError = null;
  try {
    await runtime.stop();
  } catch (error) {
    stopError = error;
  }
  if (bodyError !== null) {
    if (stopError !== null) {
      bodyError.details = { ...(bodyError.details ?? {}), stopError: describeError(stopError) };
    }
    throw bodyError;
  }
  if (stopError !== null) throw stopError;
  return value;
}

function hostToolNames(runtime) {
  const host = runtime.host;
  if (typeof host.listToolNames === "function") return host.listToolNames();
  if (host.tools instanceof Map) return [...host.tools.keys()];
  return [];
}

function hostSectionNames(runtime) {
  const host = runtime.host;
  if (typeof host.listSections === "function") return host.listSections().map((s) => s.name);
  return [];
}

function writeCountOf(runtime) {
  const service = runtime.service;
  return typeof service.getWriteCount === "function" ? service.getWriteCount() : null;
}

function byteEquals(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")) === 0;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count += 1;
    pos = haystack.indexOf(needle, pos + 1);
  }
  return count;
}

// ── 各 case 的实现。每个 run(ctx) 抛错即 failed；返回 {assertions, detail} 供证据记录。──

const CASES = [
  {
    id: "shadow-clean",
    needsRuntime: true,
    async run(ctx) {
      const runtime = requireRuntimeShape(
        await ctx.runtimeFactory({ mode: "shadow", config: {}, fixture: MATRIX_FIXTURE }),
        "runtimeFactory",
      );
      const started = await startRuntime(runtime);
      const { sent } = await runCaseBodyWithStop(runtime, async () => ({
        sent: await sendProviderRequest({
          capture: ctx.capture,
          host: runtime.host,
          hostOwnSystem: MATRIX_FIXTURE.hostOwnSystem,
          model: "synthetic-shadow",
          messages: [{ role: "user", content: "shadow baseline" }],
        }),
      }));
      const captured = ctx.capture.requests[sent.captureIndex];
      if (!captured?.normalized) throw INVALID_STATE(`captured shadow request is not parseable: ${captured?.normalizeError ?? "unknown"}`, {});
      const sections = hostSectionNames(runtime);
      const tools = hostToolNames(runtime);
      const writes = writeCountOf(runtime);
      const assertions = {
        "shadow system must be byte-identical to the FIXED fixture host-own system（独立夹具，零注入）": byteEquals(captured.normalized.system, MATRIX_FIXTURE.hostOwnSystem),
        "shadow must register zero sections": sections.length === 0,
        "shadow must register zero tools": tools.length === 0,
        "shadow must perform zero memory writes": writes === null ? true : writes === 0,
        "bridge diagnostics must report shadow mode, started then stopped": (() => {
          const diag = runtime.diagnostics();
          return diag.mode === "shadow" && diag.started === false && diag.sections.length === 0 && diag.tools.length === 0;
        })(),
        "start receipt must contain no sections/tools": (started.sections?.length ?? 0) === 0 && (started.tools?.length ?? 0) === 0,
      };
      for (const [name, ok] of Object.entries(assertions)) {
        if (!ok) throw INVALID_STATE(`shadow-clean failed: ${name}`, { assertions });
      }
      return {
        assertions: { ...assertions, writeCountObserved: writes },
        note: "writes===null 表示注入 service 未暴露 getWriteCount()；其余断言仍全部通过",
      };
    },
  },
  {
    id: "active-ownership-conflict",
    needsRuntime: true,
    async run(ctx) {
      let startError = null;
      const runtime = requireRuntimeShape(
        await ctx.runtimeFactory({ mode: "active", config: { hostBridge: { allowActive: true } }, preOwnedTools: ["soul_read"] }),
        "runtimeFactory",
      );
      try {
        await startRuntime(runtime);
      } catch (error) {
        startError = error;
      }
      if (!startError) {
        throw INVALID_STATE("active start resolved despite a pre-owned tool name; ownership conflict was NOT detected", {});
      }
      const sections = hostSectionNames(runtime);
      const tools = hostToolNames(runtime);
      const writes = writeCountOf(runtime);
      const assertions = {
        "start must reject with an error": true,
        "conflict error should carry a code (baseline uses INVALID_STATE)": typeof startError.code === "string",
        "no section may remain registered after the aborted start": sections.length === 0,
        "no tool may remain registered after the aborted start": tools.length === 0,
        "no memory write may happen during the aborted start": writes === null ? true : writes === 0,
      };
      for (const [name, ok] of Object.entries(assertions)) {
        if (!ok) throw INVALID_STATE(`active-ownership-conflict failed: ${name}`, { assertions });
      }
      return {
        assertions: { ...assertions, writeCountObserved: writes, rejectedWith: describeError(startError) },
        rawInteractions: [{ kind: "start-error", message: describeError(startError) }],
      };
    },
  },
  {
    id: "full-system-first",
    needsRuntime: true,
    async run(ctx) {
      if (MATRIX_FIXTURE.hostOwnSystem.length === 0 || MATRIX_FIXTURE.personaText.length === 0 || MATRIX_FIXTURE.coreText.length === 0) {
        throw INVALID_STATE("matrix fixture must provide non-empty host-own/persona/core texts", {});
      }
      const runtime = requireRuntimeShape(
        await ctx.runtimeFactory({ mode: "active", config: { hostBridge: { allowActive: true } }, includeTopics: true, fixture: MATRIX_FIXTURE }),
        "runtimeFactory",
      );
      await startRuntime(runtime);
      const sections = hostSectionNames(runtime);
      const { sent } = await runCaseBodyWithStop(runtime, async () => ({
        sent: await sendProviderRequest({
          capture: ctx.capture,
          host: runtime.host,
          hostOwnSystem: MATRIX_FIXTURE.hostOwnSystem,
          model: "synthetic-active",
          messages: [{ role: "user", content: "first request" }],
        }),
      }));
      const captured = ctx.capture.requests[sent.captureIndex];
      if (!captured?.normalized) throw INVALID_STATE(`captured first request is not parseable: ${captured?.normalizeError ?? "unknown"}`, {});
      // 期望字节完全来自固定夹具常量（含矩阵自渲染的派生索引），不经 service 返回值。
      const expected = expectedCompleteSystemFromFixture(MATRIX_FIXTURE);
      const assertions = {
        "first request system must be byte-identical to the FIXTURE-derived L0+complete-L1 bytes（独立夹具，禁止 includes/marker 式断言）": byteEquals(captured.normalized.system, expected),
        "expected fixture system must include the derived topic index": expected.includes("主题记忆索引"),
        "expected fixture system must include the L0 persona text": expected.includes(MATRIX_FIXTURE.personaText),
        "active projection must register exactly the two shiori sections": JSON.stringify(sections) === JSON.stringify(["shiori:persona", "shiori:core"]),
      };
      for (const [name, ok] of Object.entries(assertions)) {
        if (!ok) throw INVALID_STATE(`full-system-first failed: ${name}`, { assertions });
      }
      return { assertions, expectedSha256: sha256Hex(Buffer.from(expected, "utf8")), capturedSha256: captured.sha256, expectedSource: "MATRIX_FIXTURE constants + renderTopicIndex()（独立夹具）" };
    },
  },
  {
    id: "write-next-request",
    needsRuntime: true,
    async run(ctx) {
      const runtime = requireRuntimeShape(
        await ctx.runtimeFactory({ mode: "active", config: { hostBridge: { allowActive: true } }, includeTopics: true, fixture: MATRIX_FIXTURE }),
        "runtimeFactory",
      );
      await startRuntime(runtime);
      const done = await runCaseBodyWithStop(runtime, async () => {
        const sentBefore = await sendProviderRequest({
          capture: ctx.capture, host: runtime.host, hostOwnSystem: MATRIX_FIXTURE.hostOwnSystem,
          model: "synthetic-active", messages: [{ role: "user", content: "before write" }],
        });
        const readTool = typeof runtime.host.getTool === "function" ? runtime.host.getTool("memory_read") : undefined;
        const writeTool = typeof runtime.host.getTool === "function" ? runtime.host.getTool("core_write") : undefined;
        if (!readTool || !writeTool) throw INVALID_STATE("runtime host does not expose memory_read/core_write tools; cannot exercise the write path", {});
        const current = await readTool.execute({});
        // 写入内容是夹具常量（独立字节），不是从运行时状态拼出来的。
        const writeReceipt = await writeTool.execute({ content: MATRIX_FIXTURE.coreWrittenText, expectedRevision: current.revision });
        const sentAfter = await sendProviderRequest({
          capture: ctx.capture, host: runtime.host, hostOwnSystem: MATRIX_FIXTURE.hostOwnSystem,
          model: "synthetic-active", messages: [{ role: "user", content: "after write" }],
        });
        return { sentBefore, writeReceipt, sentAfter };
      });
      const { sentBefore, writeReceipt, sentAfter } = done;
      const before = ctx.capture.requests[sentBefore.captureIndex];
      const after = ctx.capture.requests[sentAfter.captureIndex];
      if (!after?.normalized) throw INVALID_STATE(`captured post-write request is not parseable: ${after?.normalizeError ?? "unknown"}`, {});
      // 期望：夹具写后正文 + 独立渲染的派生索引（与宿主自有/L0 常量拼接）。
      const expectedAfter = [
        MATRIX_FIXTURE.hostOwnSystem,
        MATRIX_FIXTURE.personaText,
        expectedCoreView(MATRIX_FIXTURE.coreWrittenText, MATRIX_FIXTURE.topics),
      ].join("\n\n");
      const assertions = {
        "write must go through service mutate and return a receipt": writeReceipt?.projection === "written-pending-projection",
        "post-write complete L1 must contain the fixture write marker exactly once": countOccurrences(expectedAfter, "FIXTURE-WRITE-MARKER-W1") === 1,
        "post-write captured system must be byte-identical to the FIXTURE-derived updated L0+L1 projection": byteEquals(after.normalized.system, expectedAfter),
        "post-write system must differ from the pre-write system（投影确实更新）": !byteEquals(after.normalized.system, before.normalized?.system ?? ""),
      };
      for (const [name, ok] of Object.entries(assertions)) {
        if (!ok) throw INVALID_STATE(`write-next-request failed: ${name}`, { assertions });
      }
      return { assertions, expectedSha256: sha256Hex(Buffer.from(expectedAfter, "utf8")) };
    },
  },
  {
    id: "route-switch",
    needsRuntime: true,
    async run(ctx) {
      const runtime = requireRuntimeShape(
        await ctx.runtimeFactory({ mode: "active", config: { hostBridge: { allowActive: true } }, includeTopics: true, fixture: MATRIX_FIXTURE }),
        "runtimeFactory",
      );
      await startRuntime(runtime);
      const { sentA, sentB } = await runCaseBodyWithStop(runtime, async () => ({
        sentA: await sendProviderRequest({
          capture: ctx.capture, host: runtime.host, hostOwnSystem: MATRIX_FIXTURE.hostOwnSystem,
          model: "route-a", messages: [{ role: "user", content: "route a" }],
        }),
        sentB: await sendProviderRequest({
          capture: ctx.capture, host: runtime.host, hostOwnSystem: MATRIX_FIXTURE.hostOwnSystem,
          model: "route-b", messages: [{ role: "user", content: "route b" }],
        }),
      }));
      const capturedA = ctx.capture.requests[sentA.captureIndex];
      const capturedB = ctx.capture.requests[sentB.captureIndex];
      if (!capturedA?.normalized || !capturedB?.normalized) {
        throw INVALID_STATE("route-switch: captured requests are not parseable", {});
      }
      const expected = expectedCompleteSystemFromFixture(MATRIX_FIXTURE);
      const assertions = {
        "route-a captured system must be byte-identical to the FIXTURE-derived full projection": byteEquals(capturedA.normalized.system, expected),
        "route-b captured system must be byte-identical to the FIXTURE-derived full projection（路由切换后完整投影一致）": byteEquals(capturedB.normalized.system, expected),
        "route models must actually differ between the two captures": capturedA.normalized.model !== capturedB.normalized.model,
        "host's own fixture system content must be preserved in both routes": expected.startsWith(MATRIX_FIXTURE.hostOwnSystem),
      };
      for (const [name, ok] of Object.entries(assertions)) {
        if (!ok) throw INVALID_STATE(`route-switch failed: ${name}`, { assertions });
      }
      return { assertions, routeA: capturedA.normalized.model, routeB: capturedB.normalized.model };
    },
  },
  {
    id: "compress-direct",
    needsRuntime: true,
    async run(ctx) {
      const { mapRawSessionEvent } = await import("../host/dsh-adapter.mjs");
      const runtime = requireRuntimeShape(await ctx.runtimeFactory({ mode: "shadow", config: {} }), "runtimeFactory");
      await startRuntime(runtime);
      const observations = [];
      const rawEvents = [];
      const detail = await runCaseBodyWithStop(runtime, async () => {
        const session = { id: "sess-matrix-direct" };
        const callNames = new Map();
        const emitRaw = async (event) => {
          rawEvents.push(event);
          const normalized = mapRawSessionEvent(session, event, callNames);
          if (normalized === null) return null;
          observations.push(await runtime.bridge.onCompletedTool(normalized));
          return normalized;
        };
        // 直接模式：tool/call 建立归因，tool/result 携带 meta.blocksCreated 数值证据。
        await emitRaw({ type: "tool/call", seq: 1, data: { callId: "c1", name: "compress" } });
        await emitRaw({ type: "tool/result", seq: 2, data: { message: { callId: "c1", isError: false }, meta: { blocksCreated: 3 } } });
        const afterFirst = runtime.bridge.diagnostics().probe.epoch;
        await emitRaw({ type: "tool/result", seq: 2, data: { message: { callId: "c1", isError: false }, meta: { blocksCreated: 3 } } }); // 重放
        const afterReplay = runtime.bridge.diagnostics().probe.epoch;
        await emitRaw({ type: "tool/call", seq: 3, data: { callId: "c2", name: "compress" } });
        await emitRaw({ type: "tool/result", seq: 4, data: { message: { callId: "c2", isError: false }, meta: { blocksCreated: 1 } } });
        const afterSecond = runtime.bridge.diagnostics().probe.epoch;
        const assertions = {
          "first direct compress with numeric block evidence must advance exactly once": afterFirst === 1,
          "replayed direct event (same seq) must be deduplicated": afterReplay === 1,
          "second distinct direct compress must advance once more": afterSecond === 2,
          "observation receipts must record the advances": observations.filter((o) => o.advanced).length === 2,
        };
        for (const [name, ok] of Object.entries(assertions)) {
          if (!ok) throw INVALID_STATE(`compress-direct failed: ${name}`, { assertions, observations });
        }
        return { assertions, observations, rawEvents, finalEpoch: afterSecond, source: "raw DSH session events mapped by baseline mapRawSessionEvent（synthetic 注入，非真实宿主）" };
      });
      return detail;
    },
  },
  {
    id: "compress-ptc",
    needsRuntime: true,
    async run(ctx) {
      const { mapRawSessionEvent } = await import("../host/dsh-adapter.mjs");
      const runtime = requireRuntimeShape(await ctx.runtimeFactory({ mode: "shadow", config: {} }), "runtimeFactory");
      await startRuntime(runtime);
      const observations = [];
      const rawEvents = [];
      const detail = await runCaseBodyWithStop(runtime, async () => {
        const session = { id: "sess-matrix-ptc" };
        const callNames = new Map();
        const emitRaw = async (event) => {
          rawEvents.push(event);
          const normalized = mapRawSessionEvent(session, event, callNames);
          if (normalized === null) return null;
          observations.push(await runtime.bridge.onCompletedTool(normalized));
          return normalized;
        };
        // PTC 子调用：块证据只来自已证实的回执文本格式（无数值字段）。
        await emitRaw({
          type: "tool/ptc-dispatch", seq: 10,
          data: { name: "compress", isError: false, content: [{ text: "[Compressed m1–m2, m3–m4 → 4 block(s), ~500 tokens saved.]" }] },
        });
        const afterFirst = runtime.bridge.diagnostics().probe.epoch;
        await emitRaw({
          type: "tool/ptc-dispatch", seq: 10,
          data: { name: "compress", isError: false, content: [{ text: "[Compressed m1–m2, m3–m4 → 4 block(s), ~500 tokens saved.]" }] },
        }); // 重放
        const afterReplay = runtime.bridge.diagnostics().probe.epoch;
        // PARTIAL（有块 partial 推进一次）。
        await emitRaw({
          type: "tool/ptc-dispatch", seq: 11,
          data: { name: "compress", isError: false, content: "[acp-result: PARTIAL — 2 block(s) created; some requested range(s) were NOT folded. Retry ONLY the failed range(s) listed above; do not re-fold the ranges that were applied.]" },
        });
        const afterPartial = runtime.bridge.diagnostics().probe.epoch;
        const assertions = {
          "PTC success receipt with proven block format must advance exactly once": afterFirst === 1,
          "replayed PTC event (same seq) must be deduplicated": afterReplay === 1,
          "PARTIAL receipt with block evidence must advance once": afterPartial === 2,
          "observation receipts must record the advances": observations.filter((o) => o.advanced).length === 2,
        };
        for (const [name, ok] of Object.entries(assertions)) {
          if (!ok) throw INVALID_STATE(`compress-ptc failed: ${name}`, { assertions, observations });
        }
        return { assertions, observations, rawEvents, finalEpoch: afterPartial, source: "raw PTC dispatch events mapped by baseline mapRawSessionEvent（synthetic 注入，非真实宿主）" };
      });
      return detail;
    },
  },
  {
    id: "compress-negative",
    needsRuntime: true,
    async run(ctx) {
      const { mapRawSessionEvent } = await import("../host/dsh-adapter.mjs");
      const runtime = requireRuntimeShape(await ctx.runtimeFactory({ mode: "shadow", config: {} }), "runtimeFactory");
      await startRuntime(runtime);
      const observations = [];
      const rawEvents = [];
      const detail = await runCaseBodyWithStop(runtime, async () => {
        const session = { id: "sess-matrix-negative" };
        const callNames = new Map();
        const emitRaw = async (event) => {
          rawEvents.push(event);
          const normalized = mapRawSessionEvent(session, event, callNames);
          if (normalized === null) return null;
          observations.push(await runtime.bridge.onCompletedTool(normalized));
          return normalized;
        };
        // 1) 开始事件（tool/call）不是完成事件。
        await emitRaw({ type: "tool/call", seq: 1, data: { callId: "n1", name: "compress" } });
        // 2) 失败的 compress。
        await emitRaw({ type: "tool/result", seq: 2, data: { message: { callId: "n1", isError: true }, meta: { blocksCreated: 5 } } });
        // 3) 成功但零块（先 call 建立归因）。
        await emitRaw({ type: "tool/call", seq: 3, data: { callId: "n2", name: "compress" } });
        await emitRaw({ type: "tool/result", seq: 4, data: { message: { callId: "n2", isError: false }, meta: { blocksCreated: 0 } } });
        // 4) 成功但无块证据（direct 无 meta）。
        await emitRaw({ type: "tool/result", seq: 5, data: { message: { callId: "n2", isError: false } } });
        // 5) 普通工具输出恰好含「→ N block(s)」字样：绝不能凭文本 marker 判定压缩。
        await emitRaw({ type: "tool/call", seq: 6, data: { callId: "n3", name: "memory_read" } });
        await emitRaw({ type: "tool/result", seq: 7, data: { message: { callId: "n3", isError: false, content: "文档示例：→ 9 block(s) 应被忽略" } } });
        // 6) compress 回执含未证实格式的文本（无数值/已证格式）。
        await emitRaw({ type: "tool/call", seq: 8, data: { callId: "n4", name: "compress" } });
        await emitRaw({ type: "tool/result", seq: 9, data: { message: { callId: "n4", isError: false, content: "COMPRESSED! (unverified wording)" } } });

        const epoch = runtime.bridge.diagnostics().probe.epoch;
        const reasons = new Set(observations.map((o) => o.reason));
        const assertions = {
          "no observation may advance the epoch": observations.every((o) => o.advanced === false),
          "final epoch must remain 0": epoch === 0,
          "start events (tool/call) must not produce observations（9 条原始事件只映射出 5 条完成事件）": observations.length === 5,
          "every negative path must be observed with its explicit reason": reasons.has("failed") && reasons.has("zero-blocks")
            && reasons.has("no-block-evidence") && reasons.has("not-compress"),
        };
        for (const [name, ok] of Object.entries(assertions)) {
          if (!ok) throw INVALID_STATE(`compress-negative failed: ${name}`, { assertions, observations });
        }
        return { assertions, observations, rawEvents, finalEpoch: epoch, source: "negative paths must not pass on missing evidence（缺证不通过）" };
      });
      return detail;
    },
  },
  {
    // ── 反馈(attempt 4) F3：restart-dedup 必须消费注入的 completionFactory/runtimeFactory；
    // 缺任一工厂 → not-run（E 的持久化实现缺席不能被参考替身冒充）。
    // 真实进程退出/启动边界由独立 case `restart-dedup-process` 以参考 synthetic 实现验证；
    // 注入工厂是闭包、无法跨进程传递，真实 DSH/E 的跨进程组合是负责人 P1b 边界。
    id: "restart-dedup",
    needsRuntime: true,
    needsCompletion: true,
    async run(ctx) {
      const { mapRawSessionEvent } = await import("../host/dsh-adapter.mjs");
      const { RESTART_DEDUP_EVENTS } = await import("./restart-child.mjs");
      const stateRoot = path.join(ctx.fixtureRoot, "restart-state");
      const scopeId = "scope-matrix-restart";
      const session = { id: RESTART_DEDUP_EVENTS.sessionId };
      const callNames = new Map();
      const rawEvents = [];
      // 与其他 compress 案例同路径：raw PTC 会话事件 → 基线 mapRawSessionEvent → 注入 runtime 的桥。
      const dispatch = (runtime, event) => {
        rawEvents.push(event);
        const normalized = mapRawSessionEvent(session, event, callNames);
        if (normalized === null) return null;
        return runtime.bridge.onCompletedTool(normalized);
      };

      const handle1 = await ctx.completionFactory({ root: stateRoot, scopeId });
      const runtime1 = requireRuntimeShape(
        await ctx.runtimeFactory({ mode: "shadow", config: {}, completionHandle: handle1 }),
        "runtimeFactory",
      );
      await startRuntime(runtime1);
      const first = await dispatch(runtime1, RESTART_DEDUP_EVENTS.first);
      const epochBeforeRestart = runtime1.bridge.diagnostics().probe.epoch;
      await runtime1.stop();
      await handle1.flush?.();
      await handle1.close();

      // 注入工厂二次打开同一 root/scope：恢复持久化去重状态（先恢复再消费事件）。
      const handle2 = await ctx.completionFactory({ root: stateRoot, scopeId });
      const runtime2 = requireRuntimeShape(
        await ctx.runtimeFactory({ mode: "shadow", config: {}, completionHandle: handle2 }),
        "runtimeFactory",
      );
      await startRuntime(runtime2);
      const restored = runtime2.bridge.diagnostics().restoredFromSink === true;
      const replay = await dispatch(runtime2, RESTART_DEDUP_EVENTS.first);
      const epochAfterReplay = runtime2.bridge.diagnostics().probe.epoch;
      const next = await dispatch(runtime2, RESTART_DEDUP_EVENTS.next);
      const epochAfterNew = runtime2.bridge.diagnostics().probe.epoch;
      await runtime2.stop();
      await handle2.flush?.();
      await handle2.close();

      const assertions = {
        "first compress must advance through the INJECTED runtime/completion path": first.advanced === true && epochBeforeRestart === 1,
        "second open must restore persisted dedup state (restoredFromSink)": restored,
        "replayed event after reopen must not re-advance": replay.reason === "duplicate" && epochAfterReplay === 1,
        "new event after reopen must advance on top of the restored epoch": next.advanced === true && epochAfterNew === 2,
      };
      for (const [name, ok] of Object.entries(assertions)) {
        if (!ok) throw INVALID_STATE(`restart-dedup failed: ${name}`, { assertions });
      }
      return {
        assertions,
        rawEvents,
        rawInteractions: [
          { kind: "first-dispatch-receipt", receipt: first },
          { kind: "reopen-replay-receipt", receipt: replay },
          { kind: "reopen-next-receipt", receipt: next },
        ],
        boundary: "注入 runtimeFactory/completionFactory 的持久化去重链路（synthetic 注入时为参考实现）；真实进程退出/启动边界见 restart-dedup-process；真实 DSH/E 跨进程组合为负责人 P1b 边界",
      };
    },
  },
  {
    // ── 反馈(attempt 3) F2 + 反馈(attempt 4) F3 的合成：独立命名的参考实现进程边界 case。
    // 两个独立 node 子进程先后打开同一 root/scope（advance 落盘退出 / replay 恢复+去重+推进），
    // 组合真实基线 bridge/probe/mapper 与标明 synthetic 的宿主/句柄（./restart-child.mjs，
    // 源码 hash 记入 source.sourceHashes）。这是参考实现的进程边界证据，不是 E 集成证据。
    id: "restart-dedup-process",
    needsRuntime: false,
    needsCompletion: false,
    async run(ctx) {
      const { spawnSync } = await import("node:child_process");
      const { RESTART_DEDUP_EVENTS } = await import("./restart-child.mjs");

      const workRoot = await mkdtemp(path.join(ctx.fixtureRoot, "restart-"));
      const stateRoot = path.join(workRoot, "state");
      const scopeId = "scope-matrix-restart";
      try {
        const childScript = fileURLToPath(new URL("./restart-child.mjs", import.meta.url));
        const runChild = async (phase) => {
          const outPath = path.join(workRoot, `${phase}.json`);
          const run = spawnSync(process.execPath, [childScript, phase, stateRoot, scopeId, outPath], { encoding: "utf8", timeout: 30_000 });
          if (run.error) throw INVALID_STATE(`restart-dedup-process child (${phase}) failed to spawn: ${run.error.message}`, {});
          if (run.status !== 0) {
            throw INVALID_STATE(`restart-dedup-process child (${phase}) exited ${run.status}${run.signal ? ` (signal ${run.signal})` : ""}: ${(run.stderr || run.stdout || "").slice(0, 2000)}`, {});
          }
          return JSON.parse(await readFile(outPath, "utf8"));
        };
        const advance = await runChild("advance");
        const replay = await runChild("replay");

        const assertions = {
          "advance child must run in a separate process": advance.childPid !== process.pid,
          "first compress must advance to epoch 1 and persist before exit": advance.firstAdvanced === true && advance.epochAfterAdvance === 1,
          "replay child must be a DIFFERENT process from the advance child（真实进程边界）": replay.childPid !== advance.childPid && replay.childPid !== process.pid,
          "second process must restore persisted dedup state first (restoredFromSink)": replay.restoredFromSink === true,
          "replayed event across the process boundary must NOT re-advance (duplicate)": replay.replayAdvanced === false && replay.replayReason === "duplicate" && replay.epochAfterReplay === 1,
          "new event must advance on top of the restored epoch": replay.nextAdvanced === true && replay.epochAfterNew === 2,
        };
        for (const [name, ok] of Object.entries(assertions)) {
          if (!ok) throw INVALID_STATE(`restart-dedup-process failed: ${name}`, { assertions, advance, replay });
        }
        return {
          assertions,
          childResults: { advance, replay },
          rawEvents: [RESTART_DEDUP_EVENTS.first, RESTART_DEDUP_EVENTS.next],
          rawInteractions: [
            { kind: "child-advance-result", result: advance },
            { kind: "child-replay-result", result: replay },
          ],
          boundary: "参考 synthetic 实现的真实进程边界（两个独立 node 子进程、顺序执行、无跨进程互斥）；不消费注入工厂，不声称 E 集成；真实 DSH 宿主跨进程组合为负责人 P1b 边界",
        };
      } finally {
        await rmWithRetry(workRoot);
      }
    },
  },
  {
    id: "operation-replay",
    needsRuntime: true,
    async run(ctx) {
      const runtime = requireRuntimeShape(
        await ctx.runtimeFactory({ mode: "active", config: { hostBridge: { allowActive: true } } }),
        "runtimeFactory",
      );
      await startRuntime(runtime);
      const detail = await runCaseBodyWithStop(runtime, async () => {
        const readTool = runtime.host.getTool?.("memory_read");
        const writeTool = runtime.host.getTool?.("core_write");
        if (!readTool || !writeTool) throw INVALID_STATE("runtime host does not expose memory_read/core_write tools", {});
        const current = await readTool.execute({});
        const operationId = "op-replay-matrix-1";
        const payload = { content: "幂等重试验证体 REPLAY-BODY-α", expectedRevision: current.revision, operationId };
        const first = await writeTool.execute(payload);
        const viewAfterFirst = (await readTool.execute({})).content;
        const second = await writeTool.execute(payload);
        const viewAfterSecond = (await readTool.execute({})).content;
        const assertions = {
          "same operationId + same payload retry must return a stable receipt": JSON.stringify(first) === JSON.stringify(second),
          "the body must be applied exactly once（不得双写）": countOccurrences(viewAfterSecond, "REPLAY-BODY-α") === 1,
          "the visible view must not change between the first and the replayed write": viewAfterFirst === viewAfterSecond,
          "receipt must not claim projection ahead of the next request": first?.projection === "written-pending-projection",
        };
        for (const [name, ok] of Object.entries(assertions)) {
          if (!ok) throw INVALID_STATE(`operation-replay failed: ${name}`, { assertions });
        }
        return { assertions, operationId, rawInteractions: [{ kind: "core_write-receipt", receipt: first }, { kind: "core_write-receipt", receipt: second }] };
      });
      return detail;
    },
  },
  {
    id: "stop-cleanup",
    needsRuntime: true,
    async run(ctx) {
      // —— 正常 stop：用可观测资源计数器断言真实 dispose，而不只看注册表残留（反馈 B3）——
      const runtime = requireRuntimeShape(
        await ctx.runtimeFactory({ mode: "active", config: { hostBridge: { allowActive: true } }, fixture: MATRIX_FIXTURE }),
        "runtimeFactory",
      );
      await startRuntime(runtime);
      const sectionsAfterStart = hostSectionNames(runtime);
      const toolsAfterStart = hostToolNames(runtime);
      const resourcesAfterStart = typeof runtime.host.resources === "function" ? runtime.host.resources() : null;
      const stop1 = await runtime.stop(); // 等待异步 stop 排空后才检查状态（反馈 F1）
      const sectionsAfterStop = hostSectionNames(runtime);
      const toolsAfterStop = hostToolNames(runtime);
      const resourcesAfterStop = typeof runtime.host.resources === "function" ? runtime.host.resources() : null;
      const diagAfterStop = runtime.diagnostics();
      let stop2Ok = true;
      let stop2Error = null;
      try {
        await runtime.stop(); // 幂等；await 后异步拒绝同样进入此 catch
      } catch (error) {
        stop2Ok = false;
        stop2Error = describeError(error);
      }
      const restarted = await startRuntime(runtime);
      const sectionsAfterRestart = hostSectionNames(runtime);
      const toolsAfterRestart = hostToolNames(runtime);
      await runtime.stop(); // 终态 stop：等待排空再取终态计数
      const resourcesFinal = typeof runtime.host.resources === "function" ? runtime.host.resources() : null;
      const assertions = {
        "active start must register sections and tools": sectionsAfterStart.length > 0 && toolsAfterStart.length > 0,
        "start must leave the completion-event subscription ACTIVE（可观测计数器）": resourcesAfterStart === null ? true : resourcesAfterStart.activeListeners > 0 && resourcesAfterStart.subscriptionsAdded > 0,
        "stop must unregister every section": sectionsAfterStop.length === 0,
        "stop must unregister every tool": toolsAfterStop.length === 0,
        "stop must dispose the completion-event subscription（activeListeners 归零）": resourcesAfterStop === null ? true : resourcesAfterStop.activeListeners === 0 && resourcesAfterStop.subscriptionsDisposed === resourcesAfterStop.subscriptionsAdded,
        "stop must dispose every section/tool registration it made": resourcesAfterStop === null ? true : resourcesAfterStop.activeSections === 0 && resourcesAfterStop.activeTools === 0 && resourcesAfterStop.sectionsDisposed === resourcesAfterStart.sectionsRegistered && resourcesAfterStop.toolsDisposed === resourcesAfterStart.toolsRegistered,
        "stop must be reported in diagnostics (started=false)": diagAfterStop.started === false,
        "second stop must be idempotent (no throw)": stop2Ok,
        "restart after stop must re-register sections and tools": sectionsAfterRestart.length > 0 && toolsAfterRestart.length > 0,
        "restart receipt must list the same section names": JSON.stringify([...restarted.sections ?? []].sort()) === JSON.stringify([...sectionsAfterStart].sort()),
        "final stop must leave nothing registered": hostSectionNames(runtime).length === 0 && hostToolNames(runtime).length === 0,
        "final stop must leave zero active resources": resourcesFinal === null ? true : resourcesFinal.activeSections === 0 && resourcesFinal.activeTools === 0 && resourcesFinal.activeListeners === 0,
      };
      for (const [name, ok] of Object.entries(assertions)) {
        if (!ok) throw INVALID_STATE(`stop-cleanup failed: ${name}`, { assertions });
      }

      // —— 失败 start 的部分清理探针：订阅先建立、随后归属冲突失败，必须全部回收 ——
      const probeFactoryOptions = { mode: "active", config: { hostBridge: { allowActive: true } }, preOwnedTools: ["soul_read"] };
      const probe = requireRuntimeShape(await ctx.runtimeFactory(probeFactoryOptions), "runtimeFactory");
      let probeStartError = null;
      try {
        await startRuntime(probe);
      } catch (error) {
        probeStartError = error;
      }
      if (!probeStartError) {
        throw INVALID_STATE("stop-cleanup failed-start probe: start resolved despite pre-owned tool conflict", { assertions });
      }
      const probeResources = typeof probe.host.resources === "function" ? probe.host.resources() : null;
      const probeAssertions = {
        "failed start must reject with an error": true,
        "failed start must dispose the subscription it had already made": probeResources === null ? true : probeResources.activeListeners === 0,
        "failed start must leave zero active sections/tools": probeResources === null ? true : probeResources.activeSections === 0 && probeResources.activeTools === 0,
      };
      for (const [name, ok] of Object.entries(probeAssertions)) {
        if (!ok) throw INVALID_STATE(`stop-cleanup failed-start probe: ${name}`, { probeAssertions, error: describeError(probeStartError) });
      }
      return {
        assertions,
        probeAssertions,
        rawInteractions: [
          { kind: "stop-receipt", receipt: stop1 },
          { kind: "restart-receipt", receipt: restarted },
          { kind: "failed-start-error", message: describeError(probeStartError) },
        ],
        counts: {
          sectionsAfterStart: sectionsAfterStart.length,
          toolsAfterStart: toolsAfterStart.length,
          disposed: stop1?.disposed,
          secondStop: { ok: stop2Ok, error: stop2Error },
          resourcesAfterStart,
          resourcesAfterStop,
          rejectedWith: describeError(probeStartError),
        },
      };
    },
  },
  {
    // ── 反馈 F1：global fallback 写路径矩阵覆盖 ─────────────────────────────
    // 用【真实基线】service/store（B/C 归属代码，只读 import）在临时 root 上验证：
    // 读路径 active 无 core 回落 global；core_write 经 service token 提交【活动域副本】，
    // global 字节不变；same-operationId 重试同进程幂等 + 【独立子进程】跨实际重启幂等。
    // 不经注入 runtimeFactory：global fallback 是 B/C 基线语义，注入替身反而是自证；
    // 离线零付费、全部合成正文、临时 root 用后即清。
    id: "global-fallback",
    needsRuntime: false,
    needsCompletion: false,
    async run(ctx) {
      const { createShioriService } = await import("../service/index.mjs");
      const { createFileStore } = await import("../storage/index.mjs");
      const { validateConfig, renderL1, evaluateMutation } = await import("../core/index.mjs");
      const { createCompatTools } = await import("../host/tools.mjs");
      const { spawnSync } = await import("node:child_process");

      const ACTIVE_SCOPE = "scope-matrix-gfallback";
      const FIXED_NOW = () => new Date("2026-10-24T12:00:00.000Z");
      const config = validateConfig({});
      const dataRoot = await mkdtemp(path.join(ctx.fixtureRoot, "gfallback-"));
      try {
        // 1) 种子：把固定夹具字节种进 global scope（真实 B 存储 commit）。
        const globalStore = await createFileStore({ root: dataRoot, activeScopeId: "global", config, renderL1, policy: evaluateMutation });
        await globalStore.commit({
          operationId: "gfallback-seed-global",
          changes: [{ kind: "core", text: MATRIX_FIXTURE.globalCoreText, expectedRevision: null }],
        });
        const globalSeeded = await globalStore.readCore();

        // 2) 真实 service：active 域无 core → 读路径必须逐字节回落 global。
        const service = await createShioriService({ root: dataRoot, activeScopeId: ACTIVE_SCOPE, now: FIXED_NOW });
        const fallbackRead = await service.readCore();

        // 3) 工具写：core_write 用 fallback 读出的 service revision token 提交活动域副本。
        const tools = createCompatTools({
          service,
          getSessionInfo: () => ({ sessionId: "sess-matrix-gfallback", scopeId: ACTIVE_SCOPE }),
        });
        const coreWrite = tools.find((tool) => tool.name === "core_write");
        if (!coreWrite) throw INVALID_STATE("compat tools do not expose core_write; cannot exercise the global-fallback write path", {});
        const operationId = "op-global-fallback-matrix-1";
        const writePayload = { content: MATRIX_FIXTURE.activeShadowText, expectedRevision: fallbackRead.revision, operationId };
        const firstReceipt = await coreWrite.execute(writePayload);

        // 4) 同进程同 operationId 重试：幂等，回执稳定。
        const retryReceipt = await coreWrite.execute(writePayload);

        // 5) global 不得被改动；active 得到私有副本并在读路径遮蔽 fallback。
        const globalAfter = await globalStore.readCore();
        const activeStore = await createFileStore({ root: dataRoot, activeScopeId: ACTIVE_SCOPE, config, renderL1, policy: evaluateMutation });
        const activeAfter = await activeStore.readCore();
        const shadowedRead = await service.readCore();

        // 6) 跨实际进程重放：独立 node 进程重放同一 operationId 的同一 payload。
        const payloadPath = path.join(dataRoot, "child-payload.json");
        const childOut = path.join(dataRoot, "child-result.json");
        await writeFile(payloadPath, JSON.stringify({
          ...writePayload,
          expectedActiveText: MATRIX_FIXTURE.activeShadowText,
          expectedGlobalSha256: sha256Hex(Buffer.from(MATRIX_FIXTURE.globalCoreText, "utf8")),
        }), "utf8");
        const childScript = fileURLToPath(new URL("./global-fallback-child.mjs", import.meta.url));
        const run = spawnSync(process.execPath, [childScript, dataRoot, ACTIVE_SCOPE, payloadPath, childOut], { encoding: "utf8", timeout: 30_000 });
        if (run.error) throw INVALID_STATE(`global-fallback child failed to spawn: ${run.error.message}`, {});
        if (run.status !== 0) {
          throw INVALID_STATE(`global-fallback child exited ${run.status}${run.signal ? ` (signal ${run.signal})` : ""}: ${(run.stderr || run.stdout || "").slice(0, 2000)}`, {});
        }
        const childResult = JSON.parse(await readFile(childOut, "utf8"));

        const assertions = {
          "global seed must land with the FIXTURE bytes": byteEquals(globalSeeded.text, MATRIX_FIXTURE.globalCoreText),
          "active scope with no core must READ the global fallback byte-for-byte": fallbackRead.scopeId === "global" && byteEquals(fallbackRead.text, MATRIX_FIXTURE.globalCoreText),
          "core_write on the fallback view must commit through the real tool with a pending-projection receipt": firstReceipt?.projection === "written-pending-projection" && firstReceipt?.operationId === operationId,
          "the write must land in the ACTIVE scope (receipt scope)": firstReceipt?.scope === ACTIVE_SCOPE,
          "the write must create the active copy from a null base (beforeRevision null)": firstReceipt?.changes?.[0]?.beforeRevision === null,
          "global core bytes must remain UNCHANGED after the active write": byteEquals(globalAfter.text, MATRIX_FIXTURE.globalCoreText),
          "active scope must now hold its private copy": byteEquals(activeAfter.text, MATRIX_FIXTURE.activeShadowText),
          "the active copy must SHADOW the fallback on read": shadowedRead.scopeId === ACTIVE_SCOPE && byteEquals(shadowedRead.text, MATRIX_FIXTURE.activeShadowText),
          "same-operationId retry in-process must be idempotent": JSON.stringify(firstReceipt) === JSON.stringify(retryReceipt),
          "child replay must run in a DIFFERENT process": Number.isInteger(childResult.childPid) && childResult.childPid !== process.pid,
          "child same-operationId replay must reproduce the receipt exactly（跨实际重启幂等）": JSON.stringify(childResult.receipt) === JSON.stringify(firstReceipt),
          "child replay must not mutate global": childResult.globalByteEqualsExpected === true,
          "child replay must not re-apply the payload（不得双写）": childResult.visibleByteEqualsExpected === true && childResult.visibleScopeId === ACTIVE_SCOPE,
          "child replay must not report an error": childResult.error === null,
        };
        for (const [name, ok] of Object.entries(assertions)) {
          if (!ok) throw INVALID_STATE(`global-fallback failed: ${name}`, { assertions, childResult });
        }
        return {
          assertions,
          operationId,
          child: { pid: childResult.childPid, globalSha256: childResult.globalSha256, receipt: childResult.receipt },
          rawInteractions: [
            { kind: "core_read-global-fallback", scopeId: fallbackRead.scopeId, revision: fallbackRead.revision, textSha256: sha256Hex(Buffer.from(fallbackRead.text, "utf8")) },
            { kind: "core_write-receipt", receipt: firstReceipt },
            { kind: "core_write-retry-receipt", receipt: retryReceipt },
            { kind: "child-process-replay-result", result: childResult },
          ],
          boundary: "真实基线 service/store 的 global fallback 写路径（离线临时 root、合成正文）；same-operationId 跨实际重启经独立 node 子进程验证",
        };
      } finally {
        await rmWithRetry(dataRoot);
      }
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 运行 13 项验收矩阵（契约固定 11 项 + global-fallback + restart-dedup-process）并产出 schemaVersion=1 的 bundle。
 * @param {object} options
 * @param {(options: object) => Promise<object>|object} [options.runtimeFactory]
 *     D 契约形状的运行时工厂；缺省时依赖 runtime 的 case 全部 not-run。
 *     工厂收到的 options 含 {mode, config, completionHandle?, preOwnedTools?, includeTopics?, stateRoot?}。
 * @param {({root, scopeId}) => Promise<object>} [options.completionFactory]
 *     E 契约形状的 openCompletionState；缺省时 restart-dedup not-run。
 * @param {() => object|Promise<object>} [options.capture]
 *     捕获会话工厂（须返回 {start, stop, url, requests, diagnostics}）；缺省用内置 loopback 捕获。
 * @param {string} [options.fixtureRoot] 夹具根目录；缺省 mkdtemp 临时目录并在结束时清理。
 * @param {string} options.evidenceRoot 证据输出根目录（必填；相对路径按 cwd 解析）。
 * @param {string} [options.runId] 运行 id；缺省自动生成。
 * @param {string} [options.hostOwnSystem] 宿主自有 system 文本（合成）。
 * @param {number} [options.caseTimeoutMs=30000] 单 case 超时；超时即 failed。
 * @returns {Promise<object>} schemaVersion=1 的 evidence bundle（已通过 validateEvidenceBundle）。
 */
export async function runAcceptanceMatrix({
  runtimeFactory,
  completionFactory,
  capture,
  fixtureRoot,
  evidenceRoot,
  runId,
  caseEvidenceType = "synthetic",
  caseTimeoutMs = 30_000,
} = {}) {
  if (typeof evidenceRoot !== "string" || evidenceRoot.trim().length === 0) {
    throw INVALID_INPUT("runAcceptanceMatrix requires evidenceRoot (a directory for artifacts)", {});
  }
  if (runtimeFactory !== undefined && typeof runtimeFactory !== "function") {
    throw INVALID_INPUT("runtimeFactory must be a function when provided", {});
  }
  if (completionFactory !== undefined && typeof completionFactory !== "function") {
    throw INVALID_INPUT("completionFactory must be a function when provided", {});
  }
  if (!Number.isInteger(caseTimeoutMs) || caseTimeoutMs <= 0) {
    throw INVALID_INPUT("caseTimeoutMs must be a positive integer", {});
  }
  if (!RUNNABLE_CASE_EVIDENCE_TYPES.includes(caseEvidenceType)) {
    throw INVALID_INPUT(
      "caseEvidenceType must be one of " + RUNNABLE_CASE_EVIDENCE_TYPES.join("|")
      + (caseEvidenceType === "isolated-dsh"
        ? "; isolated-dsh cannot be self-declared here — it is granted only by the owner's P1b real-host run (docs/acceptance/README.md §4)"
        : ""),
      { received: caseEvidenceType },
    );
  }
  const rootAbs = path.resolve(evidenceRoot);
  await mkdir(rootAbs, { recursive: true });

  let ownFixture = false;
  let fixtureAbs;
  if (typeof fixtureRoot === "string" && fixtureRoot.trim().length > 0) {
    fixtureAbs = path.resolve(fixtureRoot);
    await mkdir(fixtureAbs, { recursive: true });
  } else {
    fixtureAbs = await mkdtemp(path.join(tmpdir(), "shiori-accept-fixture-"));
    ownFixture = true;
  }

  const captureSession = capture ? await capture() : createLoopbackCapture();
  if (typeof captureSession?.start !== "function" || typeof captureSession?.stop !== "function" || !Array.isArray(captureSession?.requests)) {
    throw INVALID_INPUT("capture factory must return {start, stop, url, requests, diagnostics}", {});
  }

  runId = typeof runId === "string" && runId.trim().length > 0 ? runId : `matrix-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const bundleCases = [];
  const pendingCasePromises = new Set();
  const teardownErrors = [];
  let bundleResult = null;
  let primaryError = null;
  try {
    await captureSession.start();
    for (const definition of CASES) {
      const caseId = definition.id;
      const entry = { id: caseId, status: "failed", evidenceType: caseEvidenceType, artifacts: [], reason: undefined };
      bundleCases.push(entry);
      const captureStartIndex = captureSession.requests.length;
      const missing = [];
      if (definition.needsRuntime && typeof runtimeFactory !== "function") {
        missing.push(`未注入 runtimeFactory（D/E 未可用或调用方未提供）。${RERUN_RUNTIME}`);
      }
      if (definition.needsCompletion && typeof completionFactory !== "function") {
        missing.push(`未注入 completionFactory，无法验证持久化去重。${RERUN_COMPLETION}`);
      }
      if (missing.length > 0) {
        entry.status = "not-run";
        entry.reason = missing.join(" ");
        continue;
      }
      const ctx = {
        runtimeFactory,
        completionFactory,
        capture: captureSession,
        evidenceRoot: rootAbs,
        fixtureRoot: fixtureAbs,
      };
      try {
        const casePromise = definition.run(ctx);
        pendingCasePromises.add(casePromise);
        const detail = await withTimeout(casePromise, caseTimeoutMs, `case "${caseId}"`);
        // 先落盘证据，再核验磁盘，最后才允许 passed。
        const artifacts = [];
        artifacts.push(await writeArtifact(rootAbs, caseId, "case-result.json", JSON.stringify({ caseId, status: "passed", ...detail }, null, 2), "case-log"));
        // 本 case 捕获窗口内的【全部】请求都留档（多请求 case 不只留最后一条）。
        const capturedInWindow = captureSession.requests.slice(captureStartIndex);
        for (const capturedRequest of capturedInWindow) {
          artifacts.push(await writeArtifact(rootAbs, caseId, `request-${capturedRequest.index}.raw.json`, capturedRequest.rawBody, "raw-request"));
          artifacts.push(await writeArtifact(rootAbs, caseId, `request-${capturedRequest.index}.normalized.json`, JSON.stringify({
            index: capturedRequest.index, sha256: capturedRequest.sha256, bytes: capturedRequest.bytes, normalized: capturedRequest.normalized,
          }, null, 2), "normalized-system"));
        }
        // 事件型 case 的原始会话事件 / 生命周期 case 的原始交互（回执、错误）留档：
        // raw-event = 原始捕获的宿主交互记录，是 replay/isolated-dsh 等级的捕获证据之一。
        const rawInteractions = [
          ...(Array.isArray(detail?.rawEvents) ? detail.rawEvents : []),
          ...(Array.isArray(detail?.rawInteractions) ? detail.rawInteractions : []),
        ];
        if (rawInteractions.length > 0) {
          artifacts.push(await writeArtifact(rootAbs, caseId, "raw-events.json", JSON.stringify(rawInteractions, null, 2), "raw-event"));
        }
        entry.artifacts = artifacts;
        const verification = await verifyArtifactsOnDisk({ cases: [{ id: caseId, artifacts }] }, rootAbs);
        if (!verification.ok) {
          entry.status = "failed";
          entry.reason = `artifact disk verification failed before reporting: ${verification.errors.map((e) => `${e.code} ${e.message}`).join("; ")}`;
        } else {
          entry.status = "passed";
        }
      } catch (error) {
        entry.status = "failed";
        entry.reason = describeError(error);
        try {
          entry.artifacts.push(await writeArtifact(rootAbs, caseId, "case-result.json", JSON.stringify({
            caseId, status: "failed", reason: entry.reason,
          }, null, 2), "case-log"));
        } catch {
          /* 证据写盘失败不能掩盖原始失败原因 */
        }
      }
    }

    // 超时的 case 不会被取消：其 promise 仍在后台推进（可能正在跑子进程/写临时目录）。
    // teardown 前先等遗留工作 settle（有界预算），避免清理与在跑 case 竞争文件系统。
    // 这不是放宽超时 —— case 状态已按超时记 failed，只是让清理排在遗留工作之后；
    // 预算耗尽仍不 settle 则记入 teardown 错误（显式上报，不吞）。
    if (pendingCasePromises.size > 0) {
      try {
        await withTimeout(Promise.allSettled([...pendingCasePromises]), ABANDONED_SETTLE_MS, "settling timed-out case work before teardown");
      } catch (error) {
        teardownErrors.push(`abandoned case work did not settle within ${ABANDONED_SETTLE_MS}ms; cleanup may race live case work: ${describeError(error)}`);
      }
    }

    // 全部 case 共用调用方声明的等级：有 passed 则 bundle 采用该等级，否则 synthetic
    //（没有通过项就不声称任何等级；validate 的双向一致性会兜底）。
    const passedCases = bundleCases.filter((c) => c.status === "passed");
    const bundleEvidenceType = passedCases.length === 0 ? "synthetic" : caseEvidenceType;

    const bundle = {
      schemaVersion: 1,
      runId,
      evidenceType: bundleEvidenceType,
      source: {
        runtimeVersion: process.version,
        sourceHashes: await computeSourceHashes(),
        profileKind: "synthetic-fixture",
      },
      cases: bundleCases,
    };

    const selfCheck = validateEvidenceBundle(bundle);
    if (!selfCheck.valid) {
      throw INVALID_STATE(`runner produced an invalid bundle (implementation bug): ${selfCheck.errors.map((e) => `${e.code} ${e.message}`).join("; ")}`, { errors: selfCheck.errors });
    }
    bundleResult = bundle;
  } catch (error) {
    primaryError = error;
  }

  // teardown：无论主流程成败都执行；失败是结构化致命错误 —— 清理失败的运行
  // 不得返回 bundle（反馈 F3：不得只打印后让进程 0 退出、bundle 仍有效）。
  // 主流程已有异常时，teardown 失败附在 details 上，绝不掩盖原始错误。
  try {
    await captureSession.stop();
    // loopback server 资源回收校验：停止后不得仍报告 started（反馈 B3/F3）。
    const diag = typeof captureSession.diagnostics === "function" ? captureSession.diagnostics() : null;
    if (diag && diag.started === true) {
      throw INVALID_STATE("capture session still reports started after stop(); server resources may be leaked", {});
    }
  } catch (error) {
    teardownErrors.push(describeError(error));
  }
  if (ownFixture) {
    try {
      await rmWithRetry(fixtureAbs);
    } catch (error) {
      teardownErrors.push(`fixture cleanup failed: ${describeError(error)}`);
    }
  }
  if (primaryError !== null) {
    if (teardownErrors.length > 0) {
      primaryError.details = { ...(primaryError.details ?? {}), teardownErrors };
    }
    throw primaryError;
  }
  if (teardownErrors.length > 0) {
    throw INVALID_STATE(
      `matrix teardown failed: ${teardownErrors.join("; ")}; the bundle is withheld — a run whose cleanup failed must not yield a valid bundle`,
      { phase: "teardown", teardownErrors },
    );
  }
  return bundleResult;
}

/** 计算与本矩阵直接相关的源码 SHA256（相对包根）。文件缺失则跳过。 */
export async function computeSourceHashes() {
  const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
  const relativePaths = [
    "src/acceptance/index.mjs",
    "src/acceptance/loopback-capture.mjs",
    "src/acceptance/global-fallback-child.mjs",
    "src/acceptance/restart-child.mjs",
    "src/host/index.mjs",
    "src/host/compress-probe.mjs",
    "src/host/dsh-adapter.mjs",
  ];
  const hashes = {};
  for (const rel of relativePaths) {
    try {
      hashes[rel] = sha256Hex(await readFile(path.join(packageRoot, rel)));
    } catch {
      /* 源文件缺失时跳过；不得编造 hash */
    }
  }
  return hashes;
}
