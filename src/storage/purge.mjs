// Shiori 0.4-S6 · dataRoot 清点与焚毁（卸载与焚毁；唯一共享删除实现）。
//
// 调用方：bin/admin.mjs（命令行 status/destroy）与 src/plugin/management.mjs
// 的 destroyData（面板 RPC，0.4 S6 第 11 个管理方法）。两个入口必须走本模块，
// 不许各写一套删除/校验逻辑——破坏性功能的边界只实现一次。
//
// 安全边界（fail-closed，任一不满足即拒绝，绝不「先删了再说」）：
//   - 目标必须是非空字符串的绝对路径（Windows 盘相对路径 "C:foo" 不是绝对，
//     一并在 isAbsolute 拦下）；
//   - 不得含 ".." 段（normalize 前后都查，不做折叠收缩——与 config.mjs 对
//     cacheDir 的口径一致：手写路径必须给规范形式）；
//   - 真实 link（symlink/junction）解析后与 stateRoot 必须互不相交（相等、
//     目标在 stateRoot 内、stateRoot 在目标内三者都拒绝——删父目录会连带
//     删掉 stateRoot，同样不可接受）；stateRoot 缺失/不可解析时 fail-closed
//     拒绝（没有参照系就不许删）；
//   - 不是盘符根 / POSIX 根（"C:\" / "/" / "C:" 形态）；
//   - 不是用户主目录（os.homedir()），也不是主目录的祖先；「目标位于主目录
//     之内」必须允许——默认 dataRoot 就是 <~/.dsh>/shiori-data；
//   - 不是仓库根（从本模块文件向上找最近 package.json；可用 options.repoRoot
//     显式覆盖供测试注入），也不是仓库根的祖先（删仓库的祖先 = 连带删仓库，
//     拒绝）；目标位于仓库根之内允许（开发期临时数据目录）；
//   - 目标路径本身存在时必须是普通目录；symlink/junction 一律拒绝（不解析、
//     不跟随，fail-closed）；
//   - options.expectedRoot 给出时（面板 RPC 路径）：目标必须与 expectedRoot
//     同源（comparable 形状相等），否则拒绝——防「确认的是 A、删的是 B」错位。
//
// 删除实现（绝不递归删软链目标）：逐项 lstat（readdir withFileTypes）——
// symlink/junction 只删链接本身（unlink，Windows 目录链接降级 rmdir 移除
// reparse 点），目录先清空再 rmdir，普通文件 unlink 并按 lstat size 计数；
// 全部清空后移除 dataRoot 目录本身。每一层目录（含根）进入前 lstat 复检
// 仍是普通目录（L4：关死「校验后换根成 junction」的 TOCTOU 窗口）。
// 删除中任何 IO 失败原样上抛——调用方绝不拿到「忽略错误继续」的假成功。
//
// 计数口径与 describeDataRoot 一致（topics = scopes/<scope>/topics/*.md）。
//
// 错误：安全边界不满足抛 PurgeSafetyError（name 可判别、code=INVALID_INPUT、
// details.rule 记具体规则）；路径形状非法同样走 PurgeSafetyError——对调用方
// 而言「这个路径不许删」只有一种结果：拒绝。

import { promises as fsp, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { comparableRoot, resolveWithLinks } from "./path-canon.mjs";

// ---------------------------------------------------------------------------
// 错误类型
// ---------------------------------------------------------------------------

export class PurgeSafetyError extends Error {
  constructor(message, rule, details) {
    super(message);
    this.name = "PurgeSafetyError";
    this.code = "INVALID_INPUT";
    this.details = { rule, ...(details ?? {}) };
  }
}

// ---------------------------------------------------------------------------
// 仓库根探测（本模块文件向上找最近 package.json；测试可经 options 覆盖）
// ---------------------------------------------------------------------------

let cachedRepoRoot;

function detectRepoRoot() {
  if (cachedRepoRoot !== undefined) return cachedRepoRoot;
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      statSync(join(current, "package.json"));
      cachedRepoRoot = current;
      return cachedRepoRoot;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        cachedRepoRoot = null;
        return null;
      }
      current = parent;
    }
  }
}

// ---------------------------------------------------------------------------
// 安全校验
// ---------------------------------------------------------------------------

/**
 * purge 目标安全校验（fail-closed）。通过返回真实 link 解析后的绝对路径；
 * 不满足抛 PurgeSafetyError（details.rule 记命中的具体规则）。
 *
 * @param {string} target 待删目标（命令行 --data 原文 / 面板 confirm 后的 dataRoot）。
 * @param {{stateRoot?: string|null, repoRoot?: string|null, homeDir?: string|null,
 *          expectedRoot?: string|null}} [options]
 * @returns {Promise<string>}
 */
export async function assertPurgeTargetSafe(target, options = {}) {
  const { stateRoot, repoRoot, homeDir, expectedRoot } = options;

  // 1) 非空字符串绝对路径
  if (typeof target !== "string" || target.length === 0 || !isAbsolute(target)) {
    throw new PurgeSafetyError(
      `purge target must be a non-empty absolute path, got "${String(target)}"`,
      "absolute-path",
      { target: String(target) },
    );
  }

  // 2) 不含 ".." 段（normalize 前后都查；正反斜杠都算分隔符）
  if (target.split(/[\\/]+/).includes("..") || normalize(target).split(/[\\/]+/).includes("..")) {
    throw new PurgeSafetyError(
      `purge target must not contain ".." path segments, got "${target}"`,
      "dotdot-segment",
      { target },
    );
  }

  const normalized = normalize(target);
  const resolved = resolveWithLinks(normalized, (m) => new PurgeSafetyError(m, "resolve"));

  // 3) 目标自身存在时必须是普通目录；symlink/junction 一律拒绝（fail-closed，
  //    不解析、不跟随——哪怕链接指向的目录看起来无害）
  let targetLstat = null;
  try {
    targetLstat = await fsp.lstat(normalized);
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw new PurgeSafetyError(`cannot lstat purge target "${normalized}": ${String(error.message || error)}`, "lstat");
    }
    // ENOENT：目标不存在，允许（purgeDataRoot 对不存在的根返回 deleted:false）
  }
  if (targetLstat !== null) {
    if (targetLstat.isSymbolicLink()) {
      throw new PurgeSafetyError(
        `purge target "${normalized}" is a symlink/junction; refusing to delete through a link`,
        "symlink-target",
      );
    }
    if (!targetLstat.isDirectory()) {
      throw new PurgeSafetyError(
        `purge target "${normalized}" exists and is not a directory`,
        "not-a-directory",
      );
    }
  }

  // 4) 与 stateRoot 互不相交（相等 / 互相嵌套都拒绝）。stateRoot 缺失 → fail-closed：
  //    没有参照系就无法证明「不会连带删掉 stateRoot」。
  if (typeof stateRoot !== "string" || stateRoot.length === 0) {
    throw new PurgeSafetyError(
      "stateRoot is required for the purge safety check (refusing without a reference frame)",
      "state-root-missing",
    );
  }
  let resolvedState;
  try {
    resolvedState = resolveWithLinks(normalize(stateRoot), (m) => new PurgeSafetyError(m, "resolve"));
  } catch (error) {
    throw new PurgeSafetyError(
      `cannot resolve stateRoot "${stateRoot}" for the purge safety check: ${String(error.message || error)}`,
      "state-root-unresolvable",
    );
  }
  const comparableTarget = comparableRoot(resolved);
  const comparableState = comparableRoot(resolvedState);
  if (comparableTarget === comparableState
    || comparableTarget.startsWith(comparableState + sep)
    || comparableState.startsWith(comparableTarget + sep)) {
    throw new PurgeSafetyError(
      `purge target "${resolved}" overlaps stateRoot "${resolvedState}" (equal or nested); refusing`,
      "state-root-overlap",
    );
  }

  // 5) 不是盘符根 / POSIX 根（comparable 折叠后只剩 "" 或裸盘符）
  if (comparableTarget === "" || /^[a-z]:$/.test(comparableTarget)) {
    throw new PurgeSafetyError(
      `purge target "${resolved}" is a filesystem root (drive root / POSIX root); refusing`,
      "filesystem-root",
    );
  }

  // 6) 不是用户主目录，也不是主目录的祖先。注意「目标位于主目录之内」必须
  //    允许——默认 dataRoot 就是 <~/.dsh>/shiori-data（用户主目录之内），
  //    双向嵌套拒绝会把默认根永远删不掉，功能即废。homeDir 可注入（测试）；
  //    缺省 os.homedir()。
  const effectiveHome = typeof homeDir === "string" && homeDir.length > 0 ? homeDir : homedir();
  const comparableHome = comparableRoot(effectiveHome);
  if (comparableTarget === comparableHome || comparableHome.startsWith(comparableTarget + sep)) {
    throw new PurgeSafetyError(
      `purge target "${resolved}" is or contains the user home directory "${effectiveHome}"; refusing`,
      "home-directory",
    );
  }

  // 7) 不是仓库根，也不是仓库根的祖先。repoRoot 可注入（测试）；缺省从本模块
  //    文件向上探测最近 package.json。目标位于仓库根之内允许。
  const effectiveRepo = typeof repoRoot === "string" && repoRoot.length > 0 ? repoRoot : detectRepoRoot();
  if (effectiveRepo !== null) {
    const comparableRepo = comparableRoot(effectiveRepo);
    if (comparableTarget === comparableRepo || comparableRepo.startsWith(comparableTarget + sep)) {
      throw new PurgeSafetyError(
        `purge target "${resolved}" is or contains the repository root "${effectiveRepo}"; refusing`,
        "repo-root",
      );
    }
  }

  // 8) expectedRoot 锁定（面板 RPC 路径）：确认与删除必须是同一个 dataRoot。
  if (typeof expectedRoot === "string" && expectedRoot.length > 0) {
    if (comparableRoot(normalize(expectedRoot)) !== comparableTarget) {
      throw new PurgeSafetyError(
        `purge target "${resolved}" does not match the expected dataRoot "${expectedRoot}"`,
        "expected-root-mismatch",
      );
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// 清点（只读）
// ---------------------------------------------------------------------------

/**
 * 递归清点一个根目录。不做安全校验（只读；删除路径的调用方必须先过
 * assertPurgeTargetSafe）。symlink/junction 只计链接本身（不跟随、不递归进
 * 目标）。topics = scopes/<scope>/topics/*.md 的普通文件数。
 *
 * @param {string} root 根目录（绝对路径）。
 * @returns {Promise<{root: string, exists: boolean, files: number, bytes: number,
 *                     topics: number, notDirectory?: boolean}>}
 */
export async function describeDataRoot(root) {
  if (typeof root !== "string" || root.length === 0) {
    throw new PurgeSafetyError("describeDataRoot requires a non-empty path string", "absolute-path");
  }
  const normalized = normalize(root);
  let rootStat = null;
  try {
    rootStat = await fsp.lstat(normalized);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { root: normalized, exists: false, files: 0, bytes: 0, topics: 0 };
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    // 存在但不是目录（普通文件 / 链接）：如实标注，不假装清点出 0 文件的目录
    return { root: normalized, exists: true, files: 0, bytes: 0, topics: 0, notDirectory: true };
  }
  const stats = { files: 0, bytes: 0, topics: 0 };
  await walkDescribe(normalized, [], stats);
  return { root: normalized, exists: true, files: stats.files, bytes: stats.bytes, topics: stats.topics };
}

// segments 是 child 相对根的目录链（不含文件名本身）：普通文件落在
// scopes/<scope>/topics/ 下时 segments = ["scopes", scope, "topics"]。
async function walkDescribe(dir, segments, stats) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // 只计链接本身（lstat size），不递归进目标
      const st = await fsp.lstat(child);
      stats.files += 1;
      stats.bytes += st.size;
      continue;
    }
    if (entry.isDirectory()) {
      await walkDescribe(child, [...segments, entry.name], stats);
      continue;
    }
    if (entry.isFile()) {
      const st = await fsp.lstat(child);
      stats.files += 1;
      stats.bytes += st.size;
      if (segments.length === 3 && segments[0] === "scopes" && segments[2] === "topics"
        && entry.name.endsWith(".md")) {
        stats.topics += 1;
      }
      continue;
    }
    // 其他类型（FIFO/socket 等特殊节点）：计数呈现；删除侧按文件 unlink 处理
    stats.files += 1;
  }
}

// ---------------------------------------------------------------------------
// 删除（唯一共享实现）
// ---------------------------------------------------------------------------

/**
 * 校验并焚毁整个 dataRoot。目录不存在返回 { deleted:false, files:0, bytes:0 }
 * （不抛错——「没有东西可删」不是失败）。删除过程中任何 IO 失败原样上抛。
 *
 * @param {string} target dataRoot（绝对路径）。
 * @param {{expectedRoot?: string|null, stateRoot?: string|null,
 *          repoRoot?: string|null, homeDir?: string|null}} [options]
 * @returns {Promise<{deleted: boolean, files: number, bytes: number, dataRoot: string}>}
 */
export async function purgeDataRoot(target, options = {}) {
  const resolved = await assertPurgeTargetSafe(target, options);
  const described = await describeDataRoot(resolved);
  if (!described.exists) {
    return { deleted: false, files: 0, bytes: 0, dataRoot: resolved };
  }
  // 校验通过后立即删除；中间出现竞态（外部把目录换成链接等）时逐项 lstat
  // 仍把 symlink 当链接本身移除，不会递归进链接目标——fail-closed 由删除
  // 算法自身兜底。
  const stats = { files: 0, bytes: 0 };
  await purgeWalk(resolved, stats);
  await fsp.rmdir(resolved); // 根目录本身一并移除（此时必已为空；失败原样上抛）
  return { deleted: true, files: stats.files, bytes: stats.bytes, dataRoot: resolved };
}

async function purgeWalk(dir, stats) {
  // L4 TOCTOU 复检（review-rework a1 L4）：进入每一层（含根）前 lstat 复核
  // 它仍是普通目录（非 symlink/junction）——「校验后把根换成 junction」的
  // 竞态窗口在这里关死：不是普通目录就拒绝，绝不递归进链接目标。
  const dirStat = await fsp.lstat(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new PurgeSafetyError(
      `"${dir}" is no longer a plain directory during purge (possible junction swap); refusing`,
      "purge-race",
    );
  }
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      await unlinkLink(child);
      stats.files += 1;
      continue;
    }
    if (entry.isDirectory()) {
      await purgeWalk(child, stats);
      await fsp.rmdir(child);
      continue;
    }
    // 普通文件（FIFO/socket 等特殊节点同样按 unlink 处理，失败上抛）
    const st = await fsp.lstat(child);
    await fsp.unlink(child);
    stats.files += 1;
    stats.bytes += st.size;
  }
}

/** symlink/junction 只删链接本身；unlink 失败（个别平台对目录链接拒绝）降级 rmdir。 */
async function unlinkLink(linkPath) {
  try {
    await fsp.unlink(linkPath);
  } catch (error) {
    if (error && (error.code === "EPERM" || error.code === "EISDIR")) {
      await fsp.rmdir(linkPath); // Windows 目录链接：rmdir 移除 reparse 点本身
      return;
    }
    throw error;
  }
}
