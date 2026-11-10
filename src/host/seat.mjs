// Shiori F7 · 第二宿主只读判据——座位心跳（seat heartbeat）。
//
// 语义（D2 拍板）：双端同时开同一个 dataRoot 时，先启动的宿主持有写权，后启动的
// 宿主一律只读；不抢锁、不让位、不按会话分流。先启动的宿主退出或崩掉后，后启动的
// 宿主在老化窗口内自动恢复可写。
//
// 为什么不再用「写锁争用」当判据：withLock 单次只持有 1–5ms，而判据要求连续 5 秒
// 检测到外部持有——真实并发下几乎撞不上，等于永不触发（见 readonly-guard.mjs 的
// READONLY_HOLD_MS 滞回）。座位不是「此刻谁在写」，而是「谁先来」的事实，重启、
// 空闲、长写都不影响它。
//
// 判据（每个会写库的宿主启动时占一个座位）：
// - 座位目录 <dataRoot>/.shiori-seats/，每个宿主一个 <pid>-<instanceId>.json；
// - 文件 mtime 每 heartbeatMs 刷新一次（fs.utimes 只动时间戳，见 heartbeat 注释）；
// - pid 不存活（ESRCH）= 已退出，立刻回收（kill -9 由 pid 判据自愈；EPERM 等保守
//   视为存活，与 storage/lockfile 一致）；
// - mtime 超过 staleMs 只说明这个宿主卡住了，不能当成它死了：仍是先来的那个，
//   继续占着写权（标记 stale 供诊断）。删掉活 pid 的座位会让它下一拍「座位丢了→
//   重新占座」，于是两个宿主各写各的——这就是双写窗口的根因；
// - 但 pid 存活也可能是号码被系统复用了（宿主被 kill -9，pid 给了无关进程）：这种
//   座位 mtime 永停、isPidAlive 恒真，永远回收不掉，而且恒为「最先来」，此后所有新
//   宿主永久只读。所以再加一层长阈值接管——心跳停超过 takeoverMs（默认 60s，远大于
//   staleMs）就判为 pid 复用，删座位重占，并把这次接管记进 status().recentTakeovers。
//   卡住的真宿主醒来时按新占座重来（见 reclaimSeat），自动降为后来者，不会双写；
// - 只有「更早启动」的活座位才把本宿主翻成只读。同一毫秒启动时按 instanceId
//   字典序决胜——严格全序，不可能两边同时只读、也不会两边都可写。
//
// 只读只挡写工具（HOST_LOCKED）；读工具、人设卡/记忆注入完全不受影响。
//
// fail-open：座位目录不可写（EACCES / ENOTDIR / 路径被普通文件占了…）时不能把
// 整台机器翻成只读——那会让人既写不了也不知道为什么。此时降级为「无座位判据」
// （保持可写），并在 status().degraded / lastError 里如实记下原因，诊断可查。
// 取舍：目录坏掉时两个宿主都可能写（退回旧行为），但比「谁都写不了」可恢复。

import { randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { createReadonlyGuard } from "./readonly-guard.mjs";

export const SEAT_DIR_NAME = ".shiori-seats";
export const SEAT_HEARTBEAT_MS = 2000;
export const SEAT_STALE_MS = 6000;
// pid 存活但心跳停了这么久，基本是 pid 被复用（宿主早死了）：超过就回收座位。
// 必须远大于 staleMs——卡住几秒的真宿主还会醒来，不能把它当死的。
export const SEAT_TAKEOVER_MS = 60_000;
// 恢复可写也要连续 miss 两个心跳：一次 readdir 抖动不该让后启动的宿主抢到写权。
export const SEAT_RELEASE_MS = 4000;
// 命中即只读（0）：启动时立刻判一次，后启动的宿主不要先可写几秒再翻。
export const SEAT_HOLD_MS = 0;

function toErrorInfo(error) {
  return {
    code: typeof error?.code === "string" ? error.code : "UNKNOWN",
    message: error?.message ?? String(error),
  };
}

/**
 * pid 是否存活。与 storage/lockfile.isPidAlive 同一口径：只有 ESRCH 判死；
 * EPERM 说明进程存在但本进程无权 signal（Windows 上常见），保守算活。
 * 不能只看 pid：被杀进程的 pid 很快会被复用，所以老化判据（mtime）才是主判据。
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function unlinkQuiet(file) {
  try {
    await fsp.unlink(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 座位登记表：占座 / 心跳 / 清扫 / 判定，全是一个 dataRoot 内的事实。
 *
 * @param {object} opts
 * @param {string} opts.dataRoot 记忆数据根（绝对路径；座位目录建在它下面）
 * @param {number} [opts.heartbeatMs] 心跳间隔（默认 2000）
 * @param {number} [opts.staleMs] 老化窗口（默认 6000，必须大于 heartbeatMs）
 * @param {number} [opts.takeoverMs] 接管窗口（默认 60000，必须大于 staleMs）：
 *   活 pid + 心跳停超过这个窗口 = 判为 pid 复用，回收座位
 * @param {string} [opts.instanceId] 本宿主身份（默认 randomUUID；测试可注入）
 * @param {number} [opts.startedAt] 启动时刻（默认 Date.now；测试可注入以造出先/后）
 */
export function createSeatRegistry({
  dataRoot,
  heartbeatMs = SEAT_HEARTBEAT_MS,
  staleMs = SEAT_STALE_MS,
  takeoverMs = SEAT_TAKEOVER_MS,
  instanceId = randomUUID(),
  startedAt: initialStartedAt = Date.now(),
} = {}) {
  if (typeof dataRoot !== "string" || dataRoot.length === 0 || !path.isAbsolute(dataRoot)) {
    throw new TypeError("createSeatRegistry requires an absolute dataRoot path");
  }
  if (!Number.isFinite(heartbeatMs) || heartbeatMs <= 0) {
    throw new TypeError("Invalid seat heartbeat interval");
  }
  if (!Number.isFinite(staleMs) || staleMs <= heartbeatMs) {
    // staleMs ≤ 心跳间隔时自家座位会被别的宿主当成死的，判据失效。
    throw new TypeError("Seat stale window must be greater than the heartbeat interval");
  }
  if (!Number.isFinite(takeoverMs) || takeoverMs <= staleMs) {
    // 接管窗口不大于老化窗口时，卡住的真宿主还没醒就要被当死的，判据失准。
    throw new TypeError("Seat takeover window must be greater than the stale window");
  }
  if (typeof instanceId !== "string" || instanceId.length === 0) {
    throw new TypeError("Invalid seat instanceId");
  }
  if (!Number.isFinite(initialStartedAt)) {
    throw new TypeError("Invalid seat startedAt");
  }
  // 可变：座位丢了或被别人顶掉时本宿主按「新占座」重来，startedAt 取当前时刻。
  let startedAt = initialStartedAt;

  const dir = path.join(dataRoot, SEAT_DIR_NAME);
  const ownPid = process.pid;
  const ownName = `${ownPid}-${instanceId}.json`;
  const ownFile = path.join(dir, ownName);

  let announced = false;
  let degraded = false;
  let lastError = null;
  let heartbeats = 0;
  let lastHeartbeatAt = null;
  let timer = null;
  // 最近若干次接管（pid 复用的自愈）：诊断要能看出「谁被当幽灵删了」，只留尾部。
  const TAKEOVER_LOG_LIMIT = 20;
  const recentTakeovers = [];

  function noteTakeover(seat, ageMs) {
    recentTakeovers.push({
      pid: seat.pid,
      instanceId: seat.instanceId,
      startedAt: seat.startedAt,
      heartbeatAgeMs: ageMs,
      at: Date.now(),
    });
    if (recentTakeovers.length > TAKEOVER_LOG_LIMIT) recentTakeovers.shift();
  }

  async function writeSeat() {
    const payload = JSON.stringify({
      pid: ownPid,
      instanceId,
      startedAt,
      heartbeatAt: Date.now(),
    });
    // 同目录 tmp + rename：读取方永远看不到半截 JSON（Windows 上 rename 会覆盖）。
    const tmp = path.join(dir, `${ownName}.${randomUUID()}.tmp`);
    try {
      await fsp.writeFile(tmp, payload, "utf8");
      await fsp.rename(tmp, ownFile);
    } catch (error) {
      await unlinkQuiet(tmp);
      throw error;
    }
  }

  /** 读一个座位文件；畸形返回 { invalid:true }，读时已消失返回 null。 */
  async function readSeat(name) {
    const file = path.join(dir, name);
    let stat;
    try {
      stat = await fsp.stat(file);
      if (!stat.isFile()) return { invalid: true };
      const text = await fsp.readFile(file, "utf8");
      const payload = JSON.parse(text);
      if (!isPlainObject(payload)) return { invalid: true };
      const { pid, instanceId: seatInstance, startedAt: seatStartedAt } = payload;
      if (!Number.isInteger(pid) || pid <= 0 || pid > 2147483647) return { invalid: true };
      if (typeof seatInstance !== "string" || seatInstance.length === 0) return { invalid: true };
      if (!Number.isFinite(seatStartedAt)) return { invalid: true };
      return {
        pid,
        instanceId: seatInstance,
        startedAt: seatStartedAt,
        heartbeatAt: Number.isFinite(payload.heartbeatAt) ? payload.heartbeatAt : null,
        mtimeMs: stat.mtimeMs,
        path: file,
      };
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) return { invalid: true };
      throw error;
    }
  }

  /**
   * 扫一遍座位目录：清掉死的、畸形的、老化的、以及崩溃残留的 .tmp，返回活座位。
   * 单条 IO 错误只跳过这一条，绝不因为一个坏文件让整个判定失败。
   */
  async function scan() {
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const alive = [];
    const nowMs = Date.now();
    for (const name of names) {
      if (name === ownName) continue;
      const file = path.join(dir, name);
      try {
        if (name.endsWith(".tmp")) {
          const stat = await fsp.stat(file);
          if (nowMs - stat.mtimeMs > staleMs) await unlinkQuiet(file);
          continue;
        }
        if (!name.endsWith(".json")) continue;
        const seat = await readSeat(name);
        if (seat === null) continue;
        if (seat.invalid) {
          await unlinkQuiet(file);
          continue;
        }
        // pid 已退出 → 立刻回收。pid 存活但心跳停了 → 不删，只标 stale：
        // 它还活着、还是先来的那个，删了它下一拍就会重新占座，两边都写。
        if (!isPidAlive(seat.pid)) {
          await unlinkQuiet(file);
          continue;
        }
        // 但心跳停到接管窗口之外就不是「卡住」了：pid 被复用（宿主已死、号码给了
        // 无关进程）。这种座位永远等不到它自己退出，只能删掉重占；真宿主若还活着，
        // 醒来发现座位没了会按新占座重来，自动降为后来者，所以不会双写。
        const heartbeatAgeMs = nowMs - seat.mtimeMs;
        if (heartbeatAgeMs > takeoverMs) {
          if (await unlinkQuiet(file)) noteTakeover(seat, heartbeatAgeMs);
          continue;
        }
        alive.push({ ...seat, stale: heartbeatAgeMs > staleMs });
      } catch {
        // 单个条目不可读（权限 / 正在被删）不阻塞整体判定。
      }
    }
    return alive;
  }

  /** 自己的座位文件还在、且内容仍属于本宿主？读失败/被删/被替换都算「不在」。 */
  async function ownSeatIntact() {
    let text;
    try {
      text = await fsp.readFile(ownFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return false;
    }
    if (!isPlainObject(payload)) return false;
    return payload.pid === ownPid && payload.instanceId === instanceId;
  }

  /**
   * 座位丢了或被别人顶掉：不许悄悄恢复原座次（原座次意味着「我先来」，两边都这么
   * 认就是双写）。按新占座处理——startedAt 取当前时刻，于是本宿主在下一次 evaluate
   * 里变成「后启动者」，自动翻只读。
   */
  async function reclaimSeat(t) {
    startedAt = t.getTime();
    await writeSeat();
    heartbeats += 1;
    lastHeartbeatAt = startedAt;
    lastError = null;
  }

  /**
   * 心跳：只刷 mtime，不重写内容——省 IO，也让并发读取方永远看不到半截文件
   * （utimes 是原子的元数据操作）。刷之前先确认座位还是自己的：丢了/被替换就按
   * 新占座重来（见 reclaimSeat），绝不悄悄续上原座次。
   * 失败只记 lastError：瞬时 IO 抖动不该把活得好好的宿主翻成只读。
   */
  async function heartbeat() {
    if (!announced) return;
    const t = new Date();
    try {
      if (!(await ownSeatIntact())) {
        await reclaimSeat(t);
        return;
      }
      await fsp.utimes(ownFile, t, t);
      heartbeats += 1;
      lastHeartbeatAt = t.getTime();
      lastError = null;
    } catch (error) {
      if (error?.code === "ENOENT") {
        try {
          await reclaimSeat(t);
          return;
        } catch (reclaimError) {
          lastError = toErrorInfo(reclaimError);
          return;
        }
      }
      lastError = toErrorInfo(error);
    }
  }

  function startHeartbeat() {
    if (timer !== null) return;
    timer = setInterval(() => { void heartbeat(); }, heartbeatMs);
    timer.unref?.();
  }

  /** 启动占座：建目录 → 清扫旧座位 → 原子写自己 → 起心跳。失败降级（fail-open）。 */
  async function announce() {
    if (announced) return { ok: true, alreadyAnnounced: true };
    try {
      await fsp.mkdir(dir, { recursive: true });
      // 先把死的清掉，免得自己一上来被幽灵座位顶成只读（尤其是崩溃后重启）。
      await scan();
      await writeSeat();
      announced = true;
      degraded = false;
      startHeartbeat();
      return { ok: true };
    } catch (error) {
      degraded = true;
      lastError = toErrorInfo(error);
      announced = false;
      return { ok: false, error: lastError };
    }
  }

  /**
   * 判定本宿主该不该只读。
   * - held:true 时 owner 是那个「更早启动的活座位」；owner.instanceId 用于诊断。
   * - unavailable:true 表示无法判定（目录不可读/不可写），调用方 fail-open。
   */
  async function evaluate() {
    if (!announced) {
      // 没占座就没资格判别人：纯读取进程（只调 registry 不 announce）不参与。
      return { held: false, owner: null, unannounced: true };
    }
    if (degraded) {
      return { held: false, owner: null, unavailable: true, reason: lastError?.code ?? "SEAT_UNAVAILABLE" };
    }
    let seats;
    try {
      seats = await scan();
    } catch (error) {
      return { held: false, owner: null, unavailable: true, reason: toErrorInfo(error).code };
    }
    const ownKey = `${ownPid}:${instanceId}`;
    const earlier = seats
      .filter((seat) => `${seat.pid}:${seat.instanceId}` !== ownKey)
      .filter((seat) => seat.startedAt < startedAt
        || (seat.startedAt === startedAt && seat.instanceId < instanceId))
      .sort((a, b) => (a.startedAt - b.startedAt)
        || (a.instanceId < b.instanceId ? -1 : a.instanceId > b.instanceId ? 1 : 0));
    if (earlier.length === 0) return { held: false, owner: null };
    const holder = earlier[0];
    return {
      held: true,
      owner: {
        pid: holder.pid,
        instanceId: holder.instanceId,
        startedAt: holder.startedAt,
        heartbeatAt: holder.heartbeatAt,
        stale: holder.stale === true,
      },
    };
  }

  /** 退出时让座：先停心跳再删文件，删不掉也不算错（下个宿主靠老化清理）。 */
  async function withdraw() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (!announced) return { removed: false };
    announced = false;
    try {
      await fsp.unlink(ownFile);
      return { removed: true };
    } catch (error) {
      if (error?.code === "ENOENT") return { removed: false };
      lastError = toErrorInfo(error);
      return { removed: false, error: lastError };
    }
  }

  function status() {
    return {
      dir,
      file: ownFile,
      pid: ownPid,
      instanceId,
      startedAt,
      announced,
      degraded,
      heartbeatMs,
      staleMs,
      takeoverMs,
      heartbeats,
      lastHeartbeatAt,
      lastError,
      /** 最近被当作 pid 复用回收掉的座位（tail，最多 20 条）。 */
      recentTakeovers: recentTakeovers.map((entry) => ({ ...entry })),
    };
  }

  return {
    announce,
    heartbeat,
    scan,
    evaluate,
    withdraw,
    status,
    dir,
    file: ownFile,
    instanceId,
    // 座次会被心跳改写（座位丢了/被顶掉 → 按新占座重来），必须是活读数。
    get startedAt() { return startedAt; },
  };
}

/** 探针：座位判定就是 inspect 的正身；形状不对直接拒绝（tool 工厂依赖拼错不许静默）。 */
export function createSeatProbe({ registry } = {}) {
  if (registry === null || typeof registry !== "object" || typeof registry.evaluate !== "function") {
    throw new TypeError("createSeatProbe requires a registry from createSeatRegistry");
  }
  return async function probe() {
    return registry.evaluate();
  };
}

/**
 * 座位守卫：占座 + 只读判定 + 写工具守门，一个对象给宿主接上。
 * 启动时立刻 poll 一次，后启动的宿主第一次写就吃到 HOST_LOCKED。
 *
 * @param {object} opts
 * @param {string} opts.dataRoot 记忆数据根（绝对路径）
 * @param {number} [opts.heartbeatMs] / [opts.staleMs] / [opts.takeoverMs] / [opts.releaseMs] 判据参数
 * @param {number} [opts.intervalMs] 判定轮询间隔（默认等于心跳间隔）
 * @param {() => number} [opts.now] 时钟注入（测试）
 * @returns {Promise<{registry, guard, degraded, status, stop}>}
 */
export async function createSeatGuard({
  dataRoot,
  heartbeatMs = SEAT_HEARTBEAT_MS,
  staleMs = SEAT_STALE_MS,
  takeoverMs = SEAT_TAKEOVER_MS,
  releaseMs = SEAT_RELEASE_MS,
  intervalMs,
  now,
  instanceId,
  startedAt,
} = {}) {
  const registry = createSeatRegistry({ dataRoot, heartbeatMs, staleMs, takeoverMs, instanceId, startedAt });
  const guard = createReadonlyGuard({
    probe: createSeatProbe({ registry }),
    intervalMs: intervalMs ?? heartbeatMs,
    holdMs: SEAT_HOLD_MS,
    releaseMs,
    now,
  });
  const announceResult = await registry.announce();
  // 启动立即判：晚启动的宿主不该先可写几秒再翻只读。
  await guard.poll();
  guard.start();
  return {
    registry,
    guard,
    degraded: announceResult.ok !== true,
    status() {
      return { ...guard.status(), seat: registry.status() };
    },
    async stop() {
      guard.stop();
      return registry.withdraw();
    },
  };
}
