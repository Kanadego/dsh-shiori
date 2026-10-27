/**
 * Shiori P1-ACCEPTANCE — global-fallback 跨进程重放子脚本（反馈 F1）。
 *
 * 由 runAcceptanceMatrix 的 global-fallback case 以【独立 node 进程】执行：
 *   node global-fallback-child.mjs <root> <activeScopeId> <payloadPath> <outPath>
 *
 * payload JSON = { operationId, content, expectedRevision, expectedActiveText, expectedGlobalSha256 }
 *
 * 子进程用【真实基线】service/store 在同一 root 上重放同一 operationId 的 core 写
 * （HANDOFF「工具写 CAS 与同 operationId 重试必须跨实际重启稳定」的进程边界证据），
 * 把回执、global/活动域字节 SHA256 与期望比对结果写进 outPath，由父进程断言：
 * 跨进程重试幂等、global 不得被改动、活动域不得被二次应用。
 * 只含合成正文；root 是矩阵创建的临时目录。
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createShioriService } from "../service/index.mjs";
import { createCompatTools } from "../host/tools.mjs";

const sha256Hex = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function main() {
  const [root, activeScopeId, payloadPath, outPath] = process.argv.slice(2);
  if (!root || !activeScopeId || !payloadPath || !outPath) {
    throw new Error("usage: global-fallback-child.mjs <root> <activeScopeId> <payloadPath> <outPath>");
  }
  const payload = JSON.parse(await readFile(payloadPath, "utf8"));
  // now 固定：回执可复现性不依赖新时间戳（B 的 durable replay 先于 token 时效检查）。
  const service = await createShioriService({
    root,
    activeScopeId,
    now: () => new Date("2026-10-24T12:00:00.000Z"),
  });
  const tools = createCompatTools({
    service,
    getSessionInfo: () => ({ sessionId: "sess-matrix-gfallback-child", scopeId: activeScopeId }),
  });
  const coreWrite = tools.find((tool) => tool.name === "core_write");
  if (!coreWrite) throw new Error("compat tools do not expose core_write");

  let receipt = null;
  let error = null;
  try {
    receipt = await coreWrite.execute({
      content: payload.content,
      expectedRevision: payload.expectedRevision,
      operationId: payload.operationId,
    });
  } catch (e) {
    error = { code: e?.code ?? null, message: e instanceof Error ? e.message : String(e) };
  }

  const globalFile = path.join(root, "scopes", "global", "core.md");
  const globalBytes = await readFile(globalFile);
  const visible = await service.readCore();
  const result = {
    childPid: process.pid,
    receipt,
    error,
    globalSha256: sha256Hex(globalBytes),
    globalBytesLength: globalBytes.length,
    globalByteEqualsExpected: sha256Hex(globalBytes) === payload.expectedGlobalSha256,
    visibleScopeId: visible.scopeId,
    visibleTextSha256: sha256Hex(Buffer.from(visible.text, "utf8")),
    visibleByteEqualsExpected: visible.text === payload.expectedActiveText,
  };
  await writeFile(outPath, JSON.stringify(result, null, 2), "utf8");
}

// 仅作为脚本直接执行时运行 main（被 import 时不执行副作用）。
const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
  : false;
if (invokedAsScript) {
  await main();
}
