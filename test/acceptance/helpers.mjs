/**
 * test/acceptance 共享夹具：临时目录（mkdtemp + finally 清理）与最小合法 bundle 构造器。
 * 只用合成数据；不读写真实记忆，不联网（127.0.0.1 loopback 除外）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
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

// ─── 回环车道锁（0.5 批次 8-1 审阅者拍板方案 A；§9 债 15c/10-3 自两份内联实现抽取）───
// 目的：node --test 的并行单位是文件；loopback-capture.test.mjs 与 matrix.test.mjs
// 两个重网络文件此前各带一份逐字同款的内联锁（跨进程互斥把彼此错开，降低回环连接
// 在并行负载下被挤掉的概率）。现抽到本处，两文件各一行 `await acquireLoopbackLane()`
// 调用，行为逐项等价：
//   ① best-effort——抢锁异常或等待超 30s 一律放行照跑并打一行说明，绝不 skip/fail/
//      少跑用例；非 EEXIST 的意外异常同样打说明放行（与抽取前外层 catch 同款）；
//   ② 防盗死锁——锁内写持有者 PID，持锁进程死亡（process.kill(pid,0) 探测）或
//      锁超龄 120s 即接管清理；
//   ③ 判据零改动——锁只在文件加载时抢，不介入用例内部；锁只用来「尽量错开」，
//      不是正确性门禁；
//   ④ 死 PID/超龄立即接管；活 PID 等待 30s 后放行；放行不 skip 用例。
// 变异锚点（15c 守护，10-3）：deadline 放行的 `break` 刻意放在任何 try/catch 之外
// ——把它改成 throw 会炸穿调用方模块加载（两文件用例全红），证明两文件真的在用
// 本共享实现而不是残留内联拷贝。
const LANE_DIR = path.join(tmpdir(), "shiori-acceptance-loopback-lane");
const LANE_WAIT_MS = 30_000;
const LANE_STALE_MS = 120_000;

export async function acquireLoopbackLane() {
  let laneOwned = false;
  process.on("exit", () => {
    if (laneOwned) { try { rmSync(LANE_DIR, { recursive: true, force: true }); } catch { /* 退出清理失败无碍 */ } }
  });
  const laneDeadline = Date.now() + LANE_WAIT_MS;
  for (;;) {
    let giveUp = false;
    let retryMs = null; // null=立即重试（等价抽取前接管成功后的裸 continue）；数字=睡 N ms 再试
    try {
      try {
        mkdirSync(LANE_DIR); // 原子抢占；EEXIST = 已有人持锁
        writeFileSync(path.join(LANE_DIR, "pid"), String(process.pid));
        laneOwned = true;
        break; // 抢到锁：退出循环
      } catch (error) {
        if (error?.code !== "EEXIST") throw error; // 非「已存在」异常 → 外层放行照跑
        let steal = true;
        try {
          const holder = Number(readFileSync(path.join(LANE_DIR, "pid"), "utf8").trim());
          const age = Date.now() - statSync(LANE_DIR).mtimeMs;
          let holderAlive = false;
          try { process.kill(holder, 0); holderAlive = true; } catch (e) { holderAlive = e?.code === "EPERM"; }
          if (Number.isInteger(holder) && holder > 0 && holderAlive && age < LANE_STALE_MS) steal = false;
        } catch { /* pid 文件缺失/读失败 → 视为可接管 */ }
        if (steal) {
          let cleared = true;
          try { rmSync(LANE_DIR, { recursive: true, force: true }); } catch { cleared = false; }
          if (cleared) {
            retryMs = null;
          } else if (Date.now() >= laneDeadline) {
            console.error(`[loopback-lane] 接管清理失败且已等超 ${LANE_WAIT_MS}ms，放行照跑（best-effort，不改变判据）`);
            giveUp = true;
          } else {
            // 批次 9-1（R2）：接管清理失败原先裸 continue——不 sleep 不查 deadline，
            // 锁目录一直删不掉时会忙空转挂死。改为失败后睡一小段并查 deadline，
            // 超时走 best-effort 放行（打说明行照跑用例，绝不 skip / fail / 少跑）。
            retryMs = 40;
          }
        } else if (Date.now() >= laneDeadline) {
          console.error(`[loopback-lane] 等待回环车道锁超 ${LANE_WAIT_MS}ms，放行照跑（best-effort，不改变判据）`);
          giveUp = true;
        } else {
          retryMs = 25;
        }
      }
    } catch (error) {
      // ① best-effort 兜底（与抽取前外层 catch 同款）：意外异常打一行说明放行照跑。
      console.error(`[loopback-lane] 锁机制异常（${error?.message ?? error}），放行照跑（best-effort，不改变判据）`);
      giveUp = true;
    }
    // 放行出口刻意放在两个 try/catch 之外：deadline 放行只走这里的 break；变异把
    // break 改成 throw 时不会被任何 best-effort 兜底吞掉，直接炸穿模块加载。
    if (giveUp) break;
    if (retryMs !== null && retryMs > 0) await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
}
