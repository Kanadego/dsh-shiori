// Shiori F7 · 第二宿主只读降级——只读判定滞回状态机 + 写工具守门。
//
// 拍板依据（迭代清单 F7 / D2）：只读落在工具层拒写。检测到外部写锁**持续**
// 持有 ≥ READONLY_HOLD_MS 后判为只读；锁释放并持续 WRITABLE_RELEASE_MS 后
// 自动恢复可写（滞回，禁止一次采样就翻转）。读工具与 L0/L1 注入不受影响。
// 进程内状态即可，不落盘。
//
// 组成：
// - createReadonlyStateMachine：纯状态机（观察序列 → 可写/只读 + 持有者），
//   时钟注入，测试可直接驱动；
// - createReadonlyGuard：状态机 + 轮询（probe 注入；0.2 起主判据是
//   host/seat.mjs 的座位心跳，createWriteLockProbe 仅作底层锁探测的参考实现）；
//   start/stop 管理定时器，assertWritable 是写工具的同步守门入口；
// - hostLockedError：code="HOST_LOCKED" 的结构化错误，details.holder 携带
//   外部持有者信息（inspectExternalHolder 的 owner，绝不含密钥）。
//
// 本模块不 import controller/宿主；探针只读锁文件（lockfile.inspectExternalHolder）。

import { inspectExternalHolder } from "../storage/lockfile.mjs";

// 滞回窗口（迭代清单 F7 建议值：持有 5 秒才只读、释放 2 秒才恢复）。
export const READONLY_HOLD_MS = 5000;
export const WRITABLE_RELEASE_MS = 2000;

/** 构造 code="HOST_LOCKED" 的结构化错误（details.holder = 外部持有者信息）。 */
export function hostLockedError(holder) {
  const pid = holder && typeof holder === "object" ? holder.pid : undefined;
  const error = new Error(
    `HOST_LOCKED: another Shiori instance holds the write lock`
    + (pid !== undefined ? ` (pid ${pid})` : "")
    + "; this host is read-only until it releases the lock. Reads still work; writes are rejected.",
  );
  error.name = "ShioriError";
  error.code = "HOST_LOCKED";
  error.details = { holder: holder ?? null };
  return error;
}

/**
 * 只读滞回状态机（纯进程内状态，不落盘）。
 *
 * 观察语义（observe 的入参即 inspectExternalHolder 的返回）：
 * - held:true：记录首次持有时间 heldSince；持续 ≥ holdMs 后翻转为只读。
 *   持有中断（哪怕一帧 held:false）即视为连续性破坏：非只读态下清零计时，
 *   只读态下也清掉「已释放」计时（释放的 2 秒必须连续）。
 * - held:false：非只读态立即清空持有状态（瞬时争用绝不翻转）；只读态记录
 *   首次释放时间，持续 ≥ releaseMs 才恢复可写并清空全部状态。
 *
 * @param {object} [opts]
 * @param {number} [opts.holdMs] 只读翻转阈值（默认 5000）
 * @param {number} [opts.releaseMs] 恢复可写阈值（默认 2000）
 * @param {() => number} [opts.now] 时钟注入（毫秒）
 * @returns {{observe, status}}
 */
export function createReadonlyStateMachine({ holdMs = READONLY_HOLD_MS, releaseMs = WRITABLE_RELEASE_MS, now } = {}) {
  if (!Number.isFinite(holdMs) || holdMs < 0 || !Number.isFinite(releaseMs) || releaseMs < 0) {
    throw new TypeError("Invalid readonly hysteresis thresholds");
  }
  const clock = now ?? (() => Date.now());
  let writable = true;
  let heldSince = null; // 连续持有的首次观察时间
  let releasedAt = null; // 只读态下连续释放的首次观察时间
  let holder = null;
  let readonlySince = null;
  let lastProbeAt = null;

  function status() {
    return {
      writable,
      readonly: !writable,
      holder,
      heldSince,
      readonlySince,
      releasedAt,
      lastProbeAt,
    };
  }

  function observe(probe) {
    const t = clock();
    lastProbeAt = t;
    const held = probe?.held === true;
    if (held) {
      if (heldSince === null) heldSince = t;
      holder = probe.owner ?? null;
      releasedAt = null; // 释放的连续性被打破：持有重新计时
      if (writable && t - heldSince >= holdMs) {
        writable = false;
        readonlySince = t;
      }
    } else {
      if (!writable) {
        if (releasedAt === null) releasedAt = t;
        if (t - releasedAt >= releaseMs) {
          writable = true;
          heldSince = null;
          holder = null;
          readonlySince = null;
          releasedAt = null;
        }
      } else {
        // 非只读态的瞬时争用/争用消失：立即清零，绝不翻转。
        heldSince = null;
        holder = null;
      }
    }
    return status();
  }

  /**
   * 无法判定时立刻回到可写（fail-open）。只给「判据本身坏掉」的场景用：
   * 座位目录不可写、磁盘错误等。探针抛错不走这里（保持现状，见 createReadonlyGuard.poll）——
   * 瞬时不可读是「这一轮没看清」，不是「判据不存在」。
   */
  function reset() {
    writable = true;
    heldSince = null;
    releasedAt = null;
    holder = null;
    readonlySince = null;
    lastProbeAt = clock();
    return status();
  }

  return { observe, status, reset };
}

/**
 * 组合多把写锁的探针：逐个 root 调 inspectExternalHolder（dataRoot 与
 * sparks 两处写锁，stateRoot 账本锁不参与只读判定——迭代清单 F7），
 * 第一个报持有的即返回。全部未持有 → { held:false, owner:null }。
 * 探针只读，不抛 LOCK_BUSY（inspectExternalHolder 保证）。
 *
 * @param {{roots: string[]}} opts 参与判定的写锁目录（绝对路径）
 */
export function createWriteLockProbe({ roots } = {}) {
  if (!Array.isArray(roots) || roots.length === 0 || roots.some((r) => typeof r !== "string" || r.length === 0)) {
    throw new TypeError("createWriteLockProbe requires a non-empty array of root paths");
  }
  return async function probe() {
    for (const root of roots) {
      const result = await inspectExternalHolder(root);
      // 探针失败（锁文件不可读 / 畸形 payload）不是「未持有」：抛给 guard 的 poll
      // 让它跳过这一轮 observe，绝不把不可判定当成释放（会误恢复可写）或持有（会误翻只读）。
      if (result.error !== undefined || result.state === "unknown") {
        throw new Error(`write lock probe failed for ${root}: ${result.error ?? result.state}`);
      }
      if (!result.held) continue;
      // 自己持锁不算「外部持有」：本进程一次超过滞回窗口的长写若被当成外部占用，
      // 会把自己的 host 翻成只读，随后工具调用被 HOST_LOCKED 拒掉（自我拒绝）。
      if (result.owner?.pid === process.pid) continue;
      return result;
    }
    return { held: false, owner: null };
  };
}

/**
 * 守门用的鸭子类型校验：工具工厂的 readonlyGuard 依赖为可选；
 * 出现时必须是 createReadonlyGuard 的产物（有 assertWritable），拼错直接拒绝，
 * 不许静默跳过守门。
 */
export function validateReadonlyGuard(guard) {
  if (guard === undefined) return undefined;
  if (guard === null || typeof guard !== "object" || typeof guard.assertWritable !== "function") {
    const error = new Error("readonlyGuard dependency must expose assertWritable() (createReadonlyGuard product)");
    error.name = "ShioriError";
    error.code = "INVALID_INPUT";
    error.details = { received: guard === null ? "null" : typeof guard };
    throw error;
  }
  return guard;
}

/** 写工具入口调用：无 guard → 放行（行为与 0.1 一致）；只读态 → 抛 HOST_LOCKED。 */
export function assertNotHostLocked(guard) {
  guard?.assertWritable?.();
}

/**
 * 只读守卫：状态机 + 周期探针。
 *
 * @param {object} opts
 * @param {() => Promise<{held:boolean, owner:object|null}>} opts.probe 单次探测（见 createWriteLockProbe）
 * @param {number} [opts.intervalMs] 轮询间隔（默认 1000；探针只读一次锁文件，开销极低）
 * @param {number} [opts.holdMs] / [opts.releaseMs] 滞回阈值（透传状态机）
 * @param {() => number} [opts.now] 时钟注入
 * @returns {{poll, start, stop, assertWritable, status}}
 */
export function createReadonlyGuard({ probe, intervalMs = 1000, holdMs, releaseMs, now } = {}) {
  if (typeof probe !== "function") {
    throw new TypeError("createReadonlyGuard requires a probe() function");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError("Invalid readonly guard polling interval");
  }
  const machine = createReadonlyStateMachine({ holdMs, releaseMs, now });
  let timer = null;
  let polling = false;

  async function poll() {
    if (polling) return machine.status(); // 上一次探测在途：不重入、不堆积
    polling = true;
    try {
      const observation = await probe();
      // 判据不可用（座位目录不可写等）：fail-open 立刻回可写，绝不把整台机器锁死。
      // 原因不丢在 guard 里——宿主诊断把 seat.status().degraded / lastError 一并报出。
      if (observation?.unavailable === true) return machine.reset();
      return machine.observe(observation);
    } catch {
      // 探针失败（锁文件暂不可读等）绝不推进状态机，也不许把错误抛进定时器
      // （start 的 void poll() 会变成 unhandled rejection）。只读判定只能由
      // 一次成功观察翻转；失败保持现状，由下一次轮询重试。
      return machine.status();
    } finally {
      polling = false;
    }
  }

  return {
    /** 单次探测并推进状态机（测试与手动刷新入口）。 */
    poll,
    /** 启动周期轮询（timer unref：不阻进程退出）。幂等。 */
    start() {
      if (timer !== null) return;
      timer = setInterval(() => { void poll(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    /** 写工具守门：只读态抛 HOST_LOCKED（带持有者 info），可写态静默放行。 */
    assertWritable() {
      const status = machine.status();
      if (!status.writable) throw hostLockedError(status.holder);
    },
    status: machine.status,
  };
}
