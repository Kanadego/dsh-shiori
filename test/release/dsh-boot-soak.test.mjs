// boot 存活窗口（发版门禁层）——combined 路径真实 DSH boot soak。
//
// 0.4 分层收口二期自 test/plugin/dsh-smoke.test.mjs 拆入 test/release/：
// 该用例（timeout 90s，进程内 30s 存活窗口 + 真实 pnpm add）是 dev 层
// 最大耗时项（docs/0.4-DEV-PLAN.md #49a160），拆层后 dev 只保留 add /
// dump-config / single boot 等快用例，本文件随 `npm run test:release`
// 全量跑。断言原样搬移，一句未删未改。
//
// 搭台三件套（DSH 入口解析 / P 提交解析 / 包副本打包 / 进程内限时 boot /
// stderr 核查）复用 test/fixtures/stage.mjs 共享脚手架。
//
// 证据级别如实标注（CONTRACTS §8）：combined 路径不写任何 stub——owner 合并树
// 里 P 的真实 controller/protocol 已在位时直接用树本体打包；否则要求 owner
// 归档的 immutable P 提交可解析，都不可用时本用例如实 not-run。

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveDshBin, findLatestPSubmission, treeHasRealPController, createDshStageRoot,
  seedBuildApprovals, stagePackageCopy, dshExec, bootDsh, assertCleanBootStderr,
  removeDshStageRoot,
} from "../fixtures/stage.mjs";

const WORKQ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DSH_BIN = resolveDshBin();

if (!existsSync(DSH_BIN)) {
  test("dsh-boot-soak：本机无 DSH 0.2.1-rc.2 安装，按契约如实 not-run", () => {
    assert.ok(true, "DSH host not installed on this machine; smoke not-run per contract");
  });
} else {
  runSuite();
}

function runSuite() {
  const pSubmission = findLatestPSubmission(WORKQ);
  const pFiles = pSubmission ? pSubmission.files : null;
  const treeHasRealP = treeHasRealPController(WORKQ);
  // 实际使用的 P 来源（写进 combined 测试名；P_SUBMISSION_ID 供 REPORT/RESULT 引用）
  globalThis.P_SUBMISSION_ID = pSubmission ? pSubmission.id : (treeHasRealP ? "worktree(merged tree)" : null);
  const combinedAvailable = Boolean(pFiles || treeHasRealP);
  const combinedLabel = pSubmission
    ? `combined（P submission ${pSubmission.id}，无 stub）`
    : treeHasRealP
      ? "combined（合并树本体含真实 P controller，无 stub）"
      : "combined（owner 归档 P 提交不可用：如实 not-run）";
  let combined = null;

  before(() => {
    if (!combinedAvailable) return;
    combined = createDshStageRoot("shiori-q-dsh-combined-");
    combined.profile = join(combined.home, "profiles", "shiori-smoke-p");
    combined.tgz = stagePackageCopy({ workQ: WORKQ, targetPkg: combined.pkg, overlayP: Boolean(pFiles), pFiles });
    seedBuildApprovals(combined.profile);
    // R6 追加第 4 条：combined 必须真的加载 P 的 controller，不许「声明 combined 却跑 stub」。
    const combinedController = readFileSync(join(combined.pkg, "src", "plugin", "controller.mjs"), "utf8");
    assert.ok(!combinedController.includes("SYNTHETIC TEST STUB"), "combined pkg must not contain the synthetic stub controller");
    if (pSubmission) {
      assert.equal(combinedController,
        readFileSync(join(pSubmission.files, "src", "plugin", "controller.mjs"), "utf8"),
        "combined pkg controller.mjs must be byte-identical to the P submission");
    }
    // 拆层前置：原文件里本用例跑在「真实 add + dump-config」用例之后（复用其
    // 安装好的 profile）；独立成层后自行安装（setup，非被搬移用例的断言）。
    dshExec({ dshBin: DSH_BIN, root: combined, args: ["plugin", "--profile", "shiori-smoke-p", "add", combined.tgz] });
  });

  after(() => {
    removeDshStageRoot(combined);
    combined = null;
  });

  test(`${combinedLabel}：boot 存活窗口（inert shadow，无激活失败/无崩溃签名，由本测试显式终止）`, { timeout: 90_000 }, async () => {
    if (!combinedAvailable) return;
    const result = await bootDsh({ dshBin: DSH_BIN, root: combined, profile: "shiori-smoke-p" });
    assert.ok(result.outcome === "soaked" || result.outcome === "reached-marker",
      `combined boot outcome=${result.outcome} exit=${result.exitCode} signal=${result.signal}\nstderr: ${result.stderr.slice(0, 2000)}`);
    assertCleanBootStderr(result, "combined boot");
  });
}
