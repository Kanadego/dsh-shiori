// F7 座位心跳 e2e 用的真实子进程宿主。
// 真进程、真定时器、真文件系统：stdin 一行一条命令，stdout 一行一个 JSON 回执。
// 用法：node test/host/seat-holder.mjs <dataRoot>
import { createSeatGuard } from "../../src/host/seat.mjs";
import { createCompatTools } from "../../src/host/tools.mjs";
import { createFakeService } from "./helpers.mjs";

const dataRoot = process.argv[2];
if (typeof dataRoot !== "string" || dataRoot.length === 0) {
  process.stderr.write("usage: node test/host/seat-holder.mjs <dataRoot>\n");
  process.exit(2);
}

const seat = await createSeatGuard({ dataRoot });
const service = createFakeService();
const toolByName = new Map(
  createCompatTools({
    service,
    getSessionInfo: () => ({ sessionId: "seat-holder", scopeId: "amber" }),
    readonlyGuard: seat.guard,
  }).map((tool) => [tool.name, tool]),
);

/** 当前可写性快照，每条回执都带上，方便父进程断言状态没有漂移。 */
function writableInfo() {
  const status = seat.status();
  return {
    writable: status.writable,
    readonly: status.readonly,
    holder: status.holder,
    seat: {
      degraded: status.seat.degraded,
      announced: status.seat.announced,
      instanceId: status.seat.instanceId,
    },
  };
}

async function runCommand(command) {
  if (command === "status") {
    return { tag: "status", ...writableInfo() };
  }
  if (command === "write") {
    try {
      await toolByName.get("soul_update").execute({ content: "# 子进程写入\n" });
      return { tag: "write", ok: true, ...writableInfo() };
    } catch (error) {
      return { tag: "write", ok: false, code: error?.code ?? null, ...writableInfo() };
    }
  }
  if (command === "read") {
    try {
      const result = await toolByName.get("soul_read").execute({});
      return { tag: "read", ok: true, exists: result.exists, ...writableInfo() };
    } catch (error) {
      return { tag: "read", ok: false, code: error?.code ?? null };
    }
  }
  return { tag: "unknown", command };
}

function writeLine(payload) {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(payload) + "\n", resolve);
  });
}

let queue = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length === 0) continue;
    queue = queue.then(async () => {
      if (line === "exit") {
        await seat.stop();
        await writeLine({ tag: "bye", ...writableInfo() });
        process.exit(0);
      }
      await writeLine(await runCommand(line));
    }).catch(async (error) => {
      await writeLine({ tag: "error", message: String(error?.message ?? error) });
    });
  }
});
process.stdin.on("end", () => {
  void queue.then(() => seat.stop()).then(() => process.exit(0));
});

await writeLine({ tag: "ready", ...writableInfo() });
