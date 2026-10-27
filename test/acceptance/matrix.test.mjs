/**
 * runAcceptanceMatrix 测试：synthetic 全绿路径、缺注入工厂的 not-run（含重跑步骤）、
 * 坏实现必须 failed（不吞）、超时即失败、bundle 自检合法。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { REQUIRED_CASE_IDS, runAcceptanceMatrix, validateEvidenceBundle } from "../../src/acceptance/index.mjs";
import { createSyntheticCompletionFactory, createSyntheticRuntimeFactory } from "../../src/acceptance/synthetic.mjs";
import { withTempDir } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

function statusOf(bundle, caseId) {
  return bundle.cases.find((c) => c.id === caseId);
}

test("full synthetic matrix run: all required cases passed, bundle valid, evidenceType synthetic", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    const bundle = await runAcceptanceMatrix({
      runtimeFactory: createSyntheticRuntimeFactory,
      completionFactory: createSyntheticCompletionFactory(),
      evidenceRoot,
      runId: "test-full-run",
    });
    assert.equal(bundle.schemaVersion, 1);
    assert.equal(bundle.runId, "test-full-run");
    assert.equal(bundle.evidenceType, "synthetic", "synthetic 运行不得升级证据等级");
    for (const c of bundle.cases) {
      assert.equal(c.status, "passed", `${c.id}: ${c.reason ?? ""}`);
      assert.equal(c.evidenceType, "synthetic");
    }
    assert.deepEqual(bundle.cases.map((c) => c.id), REQUIRED_CASE_IDS);
    assert.ok(REQUIRED_CASE_IDS.includes("global-fallback"), "反馈 F1：global-fallback 必须是矩阵项");
    const verdict = validateEvidenceBundle(bundle);
    assert.equal(verdict.valid, true, JSON.stringify(verdict.errors));
    // 每个 passed case 都必须有证据（反馈 B2）。
    for (const c of bundle.cases) assert.ok(c.artifacts.length > 0, `${c.id} must carry at least a case-log artifact`);
    // 出站 case 必须留下 raw + normalized 双证据；多请求 case（write-next-request/route-switch）逐条留档。
    const rawCount = bundle.cases.reduce((n, c) => n + c.artifacts.filter((a) => a.kind === "raw-request").length, 0);
    const normalizedCount = bundle.cases.reduce((n, c) => n + c.artifacts.filter((a) => a.kind === "normalized-system").length, 0);
    assert.equal(rawCount, 6, "shadow-clean(1) + full-system-first(1) + write-next-request(2) + route-switch(2)");
    assert.equal(normalizedCount, 6);
    // 反馈(attempt 4) F2：restart-dedup 消费注入工厂，进程边界证据在 restart-dedup-process。
    const dedupDetail = JSON.parse(await readFile(path.join(evidenceRoot, "restart-dedup", "case-result.json"), "utf8"));
    for (const key of ["first compress must advance through the INJECTED runtime/completion path",
      "second open must restore persisted dedup state (restoredFromSink)",
      "replayed event after reopen must not re-advance",
      "new event after reopen must advance on top of the restored epoch"]) {
      assert.equal(dedupDetail.assertions[key], true, `${key} must hold`);
    }
    const processDetail = JSON.parse(await readFile(path.join(evidenceRoot, "restart-dedup-process", "case-result.json"), "utf8"));
    const { advance, replay } = processDetail.childResults;
    assert.ok(Number.isInteger(advance.childPid) && Number.isInteger(replay.childPid));
    assert.notEqual(advance.childPid, replay.childPid, "advance/replay must be separate processes");
    assert.equal(replay.restoredFromSink, true);
    assert.equal(replay.replayReason, "duplicate");
    assert.equal(replay.epochAfterNew, 2);
    // 反馈 F1：global-fallback 的证据必须含真实基线回执与跨进程重放结果。
    const gfallbackDetail = JSON.parse(await readFile(path.join(evidenceRoot, "global-fallback", "case-result.json"), "utf8"));
    assert.ok(Number.isInteger(gfallbackDetail.child.pid), "child replay pid must be recorded");
    assert.notEqual(gfallbackDetail.child.pid, process.pid, "replay must have run in a separate process");
    assert.equal(gfallbackDetail.child.receipt.projection, "written-pending-projection");
    assert.equal(gfallbackDetail.child.receipt.scope, "scope-matrix-gfallback");
  });
});

test("declared replay level: bundle evidenceType=replay, raw evidence present for event and outbound cases", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    const bundle = await runAcceptanceMatrix({
      runtimeFactory: createSyntheticRuntimeFactory,
      completionFactory: createSyntheticCompletionFactory(),
      evidenceRoot,
      runId: "test-replay-run",
      caseEvidenceType: "replay",
    });
    assert.equal(bundle.evidenceType, "replay");
    for (const c of bundle.cases) {
      assert.equal(c.status, "passed", `${c.id}: ${c.reason ?? ""}`);
      assert.equal(c.evidenceType, "replay");
    }
    const verdict = validateEvidenceBundle(bundle);
    assert.equal(verdict.valid, true, JSON.stringify(verdict.errors));
    // 事件型 case 必须有 raw-event 证据；出站 case 必须有 raw-request 证据。
    for (const id of ["compress-direct", "compress-ptc", "compress-negative", "restart-dedup", "restart-dedup-process", "operation-replay", "global-fallback"]) {
      const c = statusOf(bundle, id);
      assert.ok(c.artifacts.some((a) => a.kind === "raw-event"), `${id} must carry raw-event evidence`);
    }
    for (const id of ["shadow-clean", "full-system-first", "write-next-request", "route-switch"]) {
      const c = statusOf(bundle, id);
      assert.ok(c.artifacts.some((a) => a.kind === "raw-request"), `${id} must carry raw-request evidence`);
    }
  });
});

test("isolated-dsh cannot be self-declared through the runner（负责人 P1b 专属）", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    await assert.rejects(
      runAcceptanceMatrix({
        runtimeFactory: createSyntheticRuntimeFactory,
        completionFactory: createSyntheticCompletionFactory(),
        evidenceRoot,
        caseEvidenceType: "isolated-dsh",
      }),
      (e) => e.code === "INVALID_INPUT" && /isolated-dsh/.test(e.message),
    );
  });
});

test("missing completionFactory: restart-dedup is not-run; process-boundary reference case still runs", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    const bundle = await runAcceptanceMatrix({
      runtimeFactory: createSyntheticRuntimeFactory,
      evidenceRoot,
    });
    // 反馈(attempt 4) F3：restart-dedup 必须消费注入 completionFactory，缺 E → not-run；
    // restart-dedup-process 是参考实现的进程边界 case（不消费注入工厂），照常通过。
    const dedup = statusOf(bundle, "restart-dedup");
    assert.equal(dedup.status, "not-run");
    assert.match(dedup.reason, /completionFactory/);
    assert.match(dedup.reason, /重跑步骤/);
    for (const c of bundle.cases) {
      if (c.id !== "restart-dedup") assert.equal(c.status, "passed", `${c.id}: ${c.reason ?? ""}`);
    }
    assert.equal(validateEvidenceBundle(bundle).valid, true);
  });
});

test("missing runtimeFactory: injectable cases are not-run; child-process cases still run", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    const bundle = await runAcceptanceMatrix({ evidenceRoot });
    // restart-dedup-process 与 global-fallback 自带进程边界与真实基线 service，
    // 无 runtimeFactory 也能运行（synthetic 证据）；其余 11 项（含 restart-dedup）必须
    // not-run 附重跑步骤。
    for (const c of bundle.cases) {
      if (c.id === "restart-dedup-process" || c.id === "global-fallback") {
        assert.equal(c.status, "passed", `${c.id}: ${c.reason ?? ""}`);
      } else {
        assert.equal(c.status, "not-run", `${c.id} must be not-run without runtimeFactory`);
        assert.match(c.reason, /runtimeFactory/);
        assert.match(c.reason, /重跑步骤/);
      }
    }
    assert.equal(bundle.evidenceType, "synthetic", "无注入工厂的运行不得升级证据等级");
    assert.equal(validateEvidenceBundle(bundle).valid, true);
  });
});

test("an asynchronous stop rejection must FAIL the affected cases（反馈 F1：stop 必须 await）", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    // 坏实现：stop 返回的 promise 在一个宏任务后才拒绝 —— 旧的裸调用会完全漏掉它。
    const asyncStopFactory = async (options) => {
      const runtime = await createSyntheticRuntimeFactory(options);
      runtime.stop = async () => {
        await new Promise((resolve) => setImmediate(resolve));
        throw new Error("async stop rejected");
      };
      return runtime;
    };
    const bundle = await runAcceptanceMatrix({
      runtimeFactory: asyncStopFactory,
      completionFactory: createSyntheticCompletionFactory(),
      evidenceRoot,
    });
    const stopCleanup = statusOf(bundle, "stop-cleanup");
    assert.equal(stopCleanup.status, "failed");
    assert.match(stopCleanup.reason, /async stop rejected/);
    const fsf = statusOf(bundle, "full-system-first");
    assert.equal(fsf.status, "failed");
    assert.match(fsf.reason, /async stop rejected/, "body 成功而 stop 异步拒绝的 case 也必须 failed");
    // 不使用注入 runtime 的 case 不受影响。
    assert.equal(statusOf(bundle, "restart-dedup-process").status, "passed");
    assert.equal(statusOf(bundle, "global-fallback").status, "passed");
    assert.equal(validateEvidenceBundle(bundle).valid, true);
  });
});

test("a broken shadow implementation must FAIL the matrix, not pass silently", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    // 坏实现：shadow 启动后偷偷注册 rogue section（shadow 必须零注册）。
    const brokenFactory = async (options) => {
      const runtime = await createSyntheticRuntimeFactory(options);
      const originalStart = runtime.start;
      runtime.start = async () => {
        const receipt = await originalStart();
        if (options.mode === "shadow") {
          runtime.host.registerSystemSection({ name: "rogue", order: 9, text: async () => "rogue content" });
        }
        return receipt;
      };
      return runtime;
    };
    const bundle = await runAcceptanceMatrix({
      runtimeFactory: brokenFactory,
      completionFactory: createSyntheticCompletionFactory(),
      evidenceRoot,
    });
    const shadow = statusOf(bundle, "shadow-clean");
    assert.equal(shadow.status, "failed");
    assert.match(shadow.reason, /shadow-clean failed/);
    // rogue section 只在 shadow 模式注入：active 路径不受影响，仍应通过。
    assert.equal(statusOf(bundle, "full-system-first").status, "passed");
    // stop-cleanup 仍应通过：rogue 注册未登记进桥的代际，stop 回收的是桥自己的注册。
    assert.equal(statusOf(bundle, "stop-cleanup").status, "passed");
    assert.equal(validateEvidenceBundle(bundle).valid, true);
  });
});

test("tampered projection content must fail full-system-first (byte-exact, not includes)", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    // 坏实现：core section 渲染时多拼一段（模拟「短 system/额外内容」冒充完整投影）。
    const tamperingFactory = async (options) => {
      const runtime = await createSyntheticRuntimeFactory(options);
      if (options.mode === "active") {
        const originalStart = runtime.start;
        runtime.start = async () => {
          const receipt = await originalStart();
          const sections = runtime.host.listSections();
          const coreSection = sections.find((s) => s.name === "shiori:core");
          const originalText = coreSection.text;
          coreSection.text = async (arg) => `${await originalText(arg)}\n[extra marker]`;
          return receipt;
        };
      }
      return runtime;
    };
    const bundle = await runAcceptanceMatrix({
      runtimeFactory: tamperingFactory,
      evidenceRoot,
    });
    assert.equal(statusOf(bundle, "full-system-first").status, "failed");
    assert.match(statusOf(bundle, "full-system-first").reason, /byte-identical/);
    // route-switch 的完整投影一致性同样被破坏。
    assert.equal(statusOf(bundle, "route-switch").status, "failed");
  });
});

test("case timeout is a failure, never a silent pass", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    const bundle = await runAcceptanceMatrix({
      runtimeFactory: createSyntheticRuntimeFactory,
      evidenceRoot,
      caseTimeoutMs: 1,
    });
    const first = bundle.cases[0];
    assert.equal(first.status, "failed");
    assert.match(first.reason, /timed out after 1ms/);
  });
});

test("invalid options are rejected up front", async () => {
  await assert.rejects(runAcceptanceMatrix({}), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(runAcceptanceMatrix({ evidenceRoot: "x", runtimeFactory: 42 }), (e) => e.code === "INVALID_INPUT");
  await assert.rejects(runAcceptanceMatrix({ evidenceRoot: "x", caseTimeoutMs: 0 }), (e) => e.code === "INVALID_INPUT");
});

// ── 反馈 F3 回归：清理失败必须让整次矩阵运行失败，不得打印后照常返回有效 bundle ──

test("a capture that still reports started after stop must fail the whole run (no valid bundle)", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    const lyingCapture = () => ({
      async start() { return { url: "http://127.0.0.1:1", port: 1 }; },
      async stop() { return { alreadyStopped: false }; },
      get url() { return "http://127.0.0.1:1"; },
      requests: [],
      diagnostics() { return { started: true, stopped: false, lying: true }; },
    });
    await assert.rejects(
      runAcceptanceMatrix({ runtimeFactory: createSyntheticRuntimeFactory, capture: lyingCapture, evidenceRoot }),
      (e) => e.code === "INVALID_STATE" && e.details?.phase === "teardown" && /still reports started/.test(e.message),
    );
  });
});

test("a capture whose stop() throws must fail the whole run with a structured teardown error", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    const brokenStopCapture = () => ({
      async start() { return { url: "http://127.0.0.1:1", port: 1 }; },
      async stop() { throw new Error("server.close exploded"); },
      get url() { return "http://127.0.0.1:1"; },
      requests: [],
      diagnostics() { return { started: false, stopped: true }; },
    });
    await assert.rejects(
      runAcceptanceMatrix({ runtimeFactory: createSyntheticRuntimeFactory, capture: brokenStopCapture, evidenceRoot }),
      (e) => e.code === "INVALID_STATE" && e.details?.phase === "teardown" && /server\.close exploded/.test(e.message),
    );
  });
});

test("a primary case-loop failure is not masked by a concurrent teardown failure", async () => {
  await withTempDir("shiori-accept-mx-", async (evidenceRoot) => {
    // 主流程错误：capture.start() 失败；teardown 的 stop() 也失败 —— 原始错误必须优先，
    // teardown 错误附在 details.teardownErrors 上，不覆盖、不吞。
    const failingStartCapture = () => ({
      async start() { throw new Error("capture failed to listen"); },
      async stop() { throw new Error("teardown boom"); },
      get url() { return "http://127.0.0.1:1"; },
      requests: [],
      diagnostics() { return { started: false, stopped: true }; },
    });
    await assert.rejects(
      runAcceptanceMatrix({ runtimeFactory: createSyntheticRuntimeFactory, capture: failingStartCapture, evidenceRoot }),
      (e) => {
        assert.match(e.message, /capture failed to listen/);
        assert.ok(Array.isArray(e.details?.teardownErrors) && /teardown boom/.test(e.details.teardownErrors.join("; ")));
        return true;
      },
    );
  });
});

test("CLI matrix command writes a valid bundle file and exits 0", async () => {
  await withTempDir("shiori-accept-cli-", async (root) => {
    const evidenceRoot = path.join(root, "evidence");
    const workspaceRoot = path.resolve(import.meta.dirname, "../..");
    const { stdout } = await execFileAsync(process.execPath, [
      "src/acceptance/cli.mjs", "matrix",
      "--evidence-root", evidenceRoot,
      "--run-id", "cli-test-run",
    ], { cwd: workspaceRoot, timeout: 120_000 });
    const summary = JSON.parse(stdout);
    assert.equal(summary.validate.valid, true);
    const bundle = JSON.parse(await readFile(path.join(evidenceRoot, "bundle.json"), "utf8"));
    assert.equal(bundle.runId, "cli-test-run");
    assert.equal(bundle.cases.length, REQUIRED_CASE_IDS.length);
    await writeFile(path.join(root, "copy.json"), JSON.stringify(bundle), "utf8");
  });
});
