/**
 * 测试子进程：打开完成状态后持有锁存活，等 stdin 关闭或超时再释放退出。
 * 用法：node hold-child.mjs --root <dir> --scope <id>
 * 协议：打开成功后打印 "ready"（带 pid）；父进程向 stdin 写入 EOF 触发优雅 close；
 * 父进程也可 SIGKILL 强杀以制造锁残留。
 */
import { openCompletionState } from "../../../src/completion/index.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const handle = await openCompletionState({ root: arg("root"), scopeId: arg("scope") });
process.stdout.write(`ready ${process.pid}\n`);

const finish = async () => {
  await handle.close();
  process.exit(0);
};
process.stdin.resume();
process.stdin.on("end", finish);
// 安全超时：父进程异常时不永久挂起
const timer = setTimeout(finish, 30_000);
process.stdin.on("end", () => clearTimeout(timer));
