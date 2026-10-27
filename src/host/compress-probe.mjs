/**
 * Shiori host bridge — 压缩完成事件探针（P0）。
 *
 * 依据 CONTRACTS.md「C：宿主适配接口」与 DESIGN.md §11.2：
 * - 完成事件归一化为 {eventId, sessionId, name, success, blocksCreated}（seq 为适配层扩展，见下）；
 * - 只有 name === COMPRESS_TOOL 且 success 且 blocksCreated 为 >0 整数（实际创建块证据）才推进 contextEpoch；
 * - 失败 / 零块 / 无块证据不推进；一次 batch/partial 只要创建块只推进一次；
 * - 重复 eventId 不重复推进；不得靠 token 骤降推断（本模块根本不接受 token 信号）；
 * - epoch 与压缩事件去重持久化，重启后重放不再推进。
 *
 * 去重策略（第一轮 R4、第二轮 L4 的修复）：
 * - 【会话内单调序号水位，不淘汰】适配层事件带 seq（宿主持久会话事件的单调序号，
 *   eventId 由适配层编码为 `<sessionId>:<type>:<seq>`）。探针按 sessionId 维护已处理
 *   到的最大 seq 水位并持久化：重启后任何 seq ≤ 水位的同会话事件一律视为已处理
 *   （duplicate）。水位是可重放会话的持久去重依据，**不因其他会话/事件数量淘汰**
 *   （第二轮反例：256 条会话水位上限会在跨会话洪泛后丢掉最早会话的水位，导致重放
 *   重新推进）。乱序策略：会话事件流内 seq 单调到达（订阅顺序即 append 顺序）；
 *   跨重启后迟到的 seq ≤ 水位事件按已处理处理。
 * - 【持久去重只存压缩事件】普通工具事件的重复观测无害（不推进），不进持久层，
 *   因此不会把压缩事件的去重记录挤掉（第一轮 bug 的根因）。
 * - 压缩 eventId 持久集合保留 4096 条 FIFO，仅兜底**无 seq** 的事件（如测试注入）；
 *   带 seq 的真实适配路径完全依赖水位，不依赖该集合。
 * - 【会话归档与过期重放拒绝】集成方可用 forgetSession(sessionId) 显式终止/归档会话：
 *   删除其水位并加入持久 expired 集合，此后该会话的一切压缩事件按 duplicate 语义拒绝
 *   （reason "expired-session"）——宁可漏推进也不把旧事件当成新压缩（fail-safe）。
 *   这是唯一能让水位条目减少的途径，属显式资源管理。
 * - 资源边界（明确）：watermarks 与 expiredSessions 随**不同会话数**线性增长
 *   （每条 ≈ sessionId 长度 + 数字；千级会话 ≈ 数十 KB），compressSeen 固定 ≤4096 条；
 *   持久化为单个 JSON。若未来确需压缩/合并水位，属后续任务的显式变更。
 *
 * 块证据来源（只读核对，见 docs/host/README.md §1.4/§3 与 docs/completion/README.md；
 * 2026-10-24 重新实测，不猜、不用测试自造字段冒充）：
 * - 本机历史会话（session.v4.jsonl.zstd 只读解码，5 个样本）：成功回执固定首行
 *   `[Compressed m…–m…, m…–m… → N block(s), ~M tokens saved.]`，data 无 blocksCreated 字段；
 * - 2026-10-26 真实 desktop 会话复核（seq=124，session-a6026977-5…）：成功回执可在闭合 `]`
 *   **之前**内嵌警告，形如 `[Compressed … → 5 block(s), ~57512 tokens saved. Excluded 1
 *   protected message(s) m00019 from compression range (recent/last-user zone) — …; Excluded …
 *   m00022 …]`——生成端（billion-context dist/index.js:3551124）为
 *   `[Compressed ${detail} → ${blocksCreated} block(s), ~${tokensCompressed} tokens saved.${warn}${errors}]`，
 *   warn = " " + warnings.join("; ")，errors = "" 或 " Errors: …"。故成功行必须容忍 `saved.`
 *   与闭合 `]` 之间的非 `]` 尾串（仍行首/行尾双向锚定；缺失闭合 `]` 或括号外尾随文本不解析）；
 * - billion-context 0.1.206 dsh-native.js:128（SHA256 8dab8328…，2026-10-25 复核）：partialOutcomeNote
 *   模板为 `` `[acp-result: PARTIAL \u2014 ${created}some requested range(s) were NOT folded.
 *   Retry ONLY the failed range(s) listed above; do not re-fold the ranges that were applied.]` ``，
 *   其中 `created = `${blocksCreated} block(s) created; ` ``（blocksCreated 为 undefined 时为空串，
 *   即无块数变体不携带块证据）。整行端到端确定 ⇒ PARTIAL 匹配必须行尾锚定到该固定尾缀，
 *   parseBlocksCreated 只接受 ≥0 整数。
 *
 * 第三轮严格化（P1-COMPLETION）：
 * - 【文本证据必须整行锚定】成功/PARTIAL 两种已证回执格式都按「完整行」匹配：
 *   普通工具输出里任意出现 `→ N block(s)` 箭头或片段不再被当成压缩证据（此前
 *   无锚定的子串匹配会把无关文本误判为块证据）。
 * - 【metaConflict】归一化事件可带 metaConflict:true（适配层发现数值元数据与
 *   文本证据矛盾时设置）：保守不推进，仍记为已处理（水位/去重照常记录）。
 * - 【call identity 去重】同一底层调用经 direct 与 PTC 双路径上报完成时，若两
 *   事件携带相同 callId（适配层用 direct callId ↔ PTC parentCallId 关联），只推进
 *   一次（reason "duplicate-call"）。该集合为内存态、FIFO 上限；跨重启去重仍由
 *   seq 水位承担。无 callId 的推进会在 diagnostics.advancesWithoutCallIdentity
 *   计数 —— 即「明确无法关联」的如实披露，不谎称跨路径 exactly-once。
 */
import { open, readFile, rename, unlink } from "node:fs/promises";
import { INVALID_INPUT } from "./errors.mjs";

/** bili 压缩工具在宿主事件中的名字（PTC dispatch name=compress，DESIGN.md §11.2 探针记录）。 */
export const COMPRESS_TOOL = "compress";

/** 持久化的压缩 eventId 上限（FIFO；只兜底无 seq 事件，带 seq 路径依赖水位）。 */
export const COMPRESS_SEEN_LIMIT = 4096;
/** 运行期近期事件环上限（内存，不持久化；覆盖乱序重放的窗口）。 */
export const RECENT_EVENT_LIMIT = 1024;
/** 运行期 call identity 去重上限（内存，不持久化；跨重启由水位兜底）。 */
export const COMPRESS_CALL_LIMIT = 4096;

/**
 * 成功回执（整行锚定）：`[Compressed m…–m…, … → N block(s), ~M tokens saved.]`
 * 本机实测样本（脱敏）：`[Compressed m00004–m00010, m00011–m00018 → 2 block(s), ~41854 tokens saved.]`
 * 2026-10-26 真实宿主实测：`saved.` 与闭合 `]` 之间可内嵌警告/错误注记（见文件头
 * 「块证据来源」），因此允许「不含 `]` 的尾串」；行首与闭合 `]` 仍是硬锚点，尾随文本
 * （如 "… saved.] trailing"）、截断行、箭头片段一律不解析。
 */
export const SUCCESS_BLOCKS_PATTERN = /^\[Compressed .+→\s*(\d+)\s+block\(s\),\s*~\d+\s+tokens?\s+saved\.(?:[^\]]*)\]$/u;
/**
 * PARTIAL 回执（行尾锚定到 dsh-native.js:128 partialOutcomeNote 的固定全文）：
 * `[acp-result: PARTIAL — N block(s) created; some requested range(s) were NOT folded.
 *   Retry ONLY the failed range(s) listed above; do not re-fold the ranges that were applied.]`
 * 模板端到端确定（attempt 3 修复）：前缀匹配会接受带矛盾尾缀的伪造行，因此必须锚定
 * 到真实固定尾缀；其余任何变体（含无块数的空 created 变体、截断、改写尾缀）一律不解析。
 */
export const PARTIAL_BLOCKS_PATTERN = /^\[acp-result: PARTIAL — (\d+) block\(s\) created; some requested range\(s\) were NOT folded\. Retry ONLY the failed range\(s\) listed above; do not re-fold the ranges that were applied\.\]$/u;

/**
 * 严格校验并归一化一条完成事件。
 * 契约形状为 {eventId, sessionId, name, success, blocksCreated?}；
 * 扩展字段（均可选，由适配层提供）：
 * - `seq`：宿主会话事件的单调序号（跨重启去重水位）；
 * - `callId`：底层调用的可证身份（direct callId ↔ PTC parentCallId 关联）；
 * - `metaConflict`：数值元数据与文本证据矛盾（保守处理信号）。
 * @returns {{eventId:string, sessionId:string, name:string, success:boolean,
 *            blocksCreated:(number|undefined), seq:(number|undefined),
 *            callId?:(string|undefined), metaConflict?:(boolean|undefined)}}
 */
export function normalizeCompletionEvent(raw) {
  if (raw === null || typeof raw !== "object") {
    throw INVALID_INPUT("completion event must be an object", { received: typeof raw });
  }
  const { eventId, sessionId, name, success, blocksCreated, seq, callId, metaConflict } = raw;
  if (typeof eventId !== "string" || eventId.length === 0) {
    throw INVALID_INPUT("completion event eventId must be a non-empty string", { eventId });
  }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw INVALID_INPUT(`completion event "${eventId}" sessionId must be a non-empty string`, {});
  }
  if (typeof name !== "string" || name.length === 0) {
    throw INVALID_INPUT(`completion event "${eventId}" name must be a non-empty string`, {});
  }
  if (typeof success !== "boolean") {
    throw INVALID_INPUT(`completion event "${eventId}" success must be a boolean`, { success });
  }
  let normalizedBlocks;
  if (blocksCreated !== undefined) {
    if (!Number.isInteger(blocksCreated) || blocksCreated < 0) {
      throw INVALID_INPUT(`completion event "${eventId}" blocksCreated must be a non-negative integer or undefined`, { blocksCreated });
    }
    normalizedBlocks = blocksCreated;
  }
  let normalizedSeq;
  if (seq !== undefined) {
    if (!Number.isInteger(seq) || seq < 0) {
      throw INVALID_INPUT(`completion event "${eventId}" seq must be a non-negative integer or undefined`, { seq });
    }
    normalizedSeq = seq;
  }
  let normalizedCallId;
  if (callId !== undefined) {
    if (typeof callId !== "string" || callId.length === 0) {
      throw INVALID_INPUT(`completion event "${eventId}" callId must be a non-empty string or undefined`, { callId });
    }
    normalizedCallId = callId;
  }
  let normalizedMetaConflict;
  if (metaConflict !== undefined) {
    if (typeof metaConflict !== "boolean") {
      throw INVALID_INPUT(`completion event "${eventId}" metaConflict must be a boolean or undefined`, { metaConflict });
    }
    normalizedMetaConflict = metaConflict;
  }
  return {
    eventId,
    sessionId,
    name,
    success,
    blocksCreated: normalizedBlocks,
    seq: normalizedSeq,
    ...(normalizedCallId !== undefined ? { callId: normalizedCallId } : {}),
    ...(normalizedMetaConflict !== undefined ? { metaConflict: normalizedMetaConflict } : {}),
  };
}

/**
 * 从 bili 工具回执（{text, failed, outcome?, blocksCreated?}）判断成功与块证据。
 * 这是薄适配层把原始回执映射为归一化事件时的共用判定；blocksCreated 缺失时
 * 调用方再从回执文本按已证实格式解析（见 dsh-adapter.mjs）。
 */
export function receiptToSuccessAndBlocks(receipt) {
  if (receipt === null || typeof receipt !== "object") {
    throw INVALID_INPUT("tool receipt must be an object", { received: typeof receipt });
  }
  const failed = receipt.failed === true
    || receipt.outcome === "failure"
    || receipt.outcome === "refused";
  const success = !failed;
  const blocksCreated = Number.isInteger(receipt.blocksCreated) && receipt.blocksCreated >= 0
    ? receipt.blocksCreated
    : undefined;
  return { success, blocksCreated };
}

/**
 * 从回执文本按已证实格式解析块计数；整行锚定，逐行匹配。
 * 两种已证格式之外返回 undefined（不猜）：无关文本夹带 `→ N block(s)`、
 * 回执片段、前后带其他文字的行都不得解析。
 */
export function blocksFromReceiptText(text) {
  if (typeof text !== "string") return undefined;
  for (const line of text.split(/\r?\n/)) {
    const partial = PARTIAL_BLOCKS_PATTERN.exec(line);
    if (partial) return Number.parseInt(partial[1], 10);
    const success = SUCCESS_BLOCKS_PATTERN.exec(line);
    if (success) return Number.parseInt(success[1], 10);
  }
  return undefined;
}

/**
 * 默认持久化槽：JSON 文件（O_EXCL 临时写 + fsync + rename 原子替换）。
 * load 在文件不存在时返回 null（唯一的新状态路径）；空文件 / 目录 / symlink /
 * 权限异常 / 损坏 JSON 一律抛错 —— 绝不静默重置为 epoch 0（P1 契约）。
 * 生产路径应使用 openCompletionState 的 sink（含 root/scope 互斥）。
 */
export function createJsonFileSink(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw INVALID_INPUT("createJsonFileSink requires a file path", {});
  }
  return {
    async load() {
      let raw;
      try {
        raw = await readFile(filePath, "utf8");
      } catch (error) {
        if (error && error.code === "ENOENT") return null;
        // EISDIR / EACCES 等：不得当成新状态
        throw INVALID_INPUT(`state file read failed (${error?.code ?? error.message}); refusing to treat as new state`, { filePath, fsCode: error?.code });
      }
      if (raw.trim().length === 0) {
        throw INVALID_INPUT("state file is empty; refusing to treat as new state", { filePath });
      }
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw INVALID_INPUT(`state file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, { filePath });
      }
    },
    async save(snapshot) {
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
      try {
        const fh = await open(tmp, "wx");
        try {
          await fh.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
          await fh.sync();
        } finally {
          await fh.close().catch(() => {});
        }
        await rename(tmp, filePath);
      } catch (error) {
        await unlink(tmp).catch(() => {});
        throw error;
      }
    },
  };
}

/**
 * contextEpoch 探针。
 * @param {object} [options]
 * @param {{load: () => Promise<object|null>, save: (snapshot: object) => Promise<void>}} [options.sink]
 *     持久化槽；缺省为纯内存（diagnostics 会标注 persistence:"memory"）。
 * @param {() => string} [options.now] 时钟注入（测试用）。
 */
export function createCompressProbe({ sink, now = () => new Date().toISOString() } = {}) {
  let epoch = 0;
  /** 持久：压缩事件 eventId -> true（FIFO 上限；只兜底无 seq 事件）。 */
  const compressSeen = new Map();
  /** 持久：sessionId -> 已处理最大 seq。不淘汰（可重放会话的持久去重依据，见模块头注释）。 */
  const watermarks = new Map();
  /** 持久：显式归档的会话（forgetSession）。其压缩事件一律拒绝（fail-safe）。 */
  const expiredSessions = new Map();
  /** 内存：近期全部事件 eventId -> true（运行期重复判定与诊断）。 */
  const recentRing = new Map();
  /** 内存：已处理过（无论成败）的底层调用身份 `${sessionId}:${callId}` -> true。
   *  同一调用的 direct/PTC 双报告只允许第一次推进（reason "duplicate-call"）。
   *  跨重启由 seq 水位兜底；本集合不持久化（FIFO 上限）。 */
  const seenCalls = new Map();
  let lastAdvance = null;
  let sinkError = null;
  let saving = Promise.resolve();
  /** 诊断计数：被 call identity 去重挡下的压缩事件数 / 无 callId 的推进数 / metaConflict 数。 */
  let duplicateCallEvents = 0;
  let advancesWithoutCallIdentity = 0;
  let metaConflictEvents = 0;

  function evictOldest(map, limit) {
    while (map.size > limit) {
      map.delete(map.keys().next().value);
    }
  }

  function snapshot() {
    return {
      epoch,
      compressSeenIds: [...compressSeen.keys()],
      watermarks: Object.fromEntries(watermarks),
      expiredSessionIds: [...expiredSessions.keys()],
      lastAdvance,
      updatedAt: now(),
    };
  }

  async function persist() {
    if (!sink) return;
    saving = saving.then(async () => {
      try {
        await sink.save(snapshot());
        sinkError = null;
      } catch (error) {
        // 持久化失败不回滚内存 epoch，但必须在诊断里如实暴露。
        sinkError = `persist failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
    await saving;
  }

  /**
   * 观察一条归一化完成事件。
   * @returns {Promise<{advanced:boolean, epoch:number, reason:string}>}
   * reason ∈ duplicate | not-compress | expired-session | duplicate-call | meta-conflict
   *          | failed | zero-blocks | no-block-evidence | advanced
   */
  async function observe(rawEvent) {
    const event = normalizeCompletionEvent(rawEvent);
    // 1) 运行期重复：近期环（全部事件）
    if (recentRing.has(event.eventId)) {
      return { advanced: false, epoch, reason: "duplicate" };
    }
    // 2) 跨重启重复：压缩事件持久集合（无 seq 兜底）
    if (compressSeen.has(event.eventId)) {
      return { advanced: false, epoch, reason: "duplicate" };
    }
    // 3) 跨重启重复：会话序号水位（持久去重依据，不淘汰）
    if (event.seq !== undefined) {
      const watermark = watermarks.get(event.sessionId);
      if (watermark !== undefined && event.seq <= watermark) {
        return { advanced: false, epoch, reason: "duplicate" };
      }
    }
    recentRing.set(event.eventId, true);
    evictOldest(recentRing, RECENT_EVENT_LIMIT);

    if (event.name !== COMPRESS_TOOL) {
      // 普通事件不进持久层：重复观测无害，也不会挤掉压缩去重记录。
      return { advanced: false, epoch, reason: "not-compress" };
    }
    // 4) 显式归档的会话：一切压缩事件拒绝（fail-safe，宁可漏推进不误判为新压缩）。
    if (expiredSessions.has(event.sessionId)) {
      await persist();
      return { advanced: false, epoch, reason: "expired-session" };
    }
    // 压缩事件：进入持久去重并推进水位（无论成败，都视为“已处理”）。
    compressSeen.set(event.eventId, true);
    evictOldest(compressSeen, COMPRESS_SEEN_LIMIT);
    if (event.seq !== undefined) {
      const watermark = watermarks.get(event.sessionId) ?? -1;
      watermarks.set(event.sessionId, Math.max(watermark, event.seq));
    }

    // 5) call identity 去重：同一底层调用的双路径（direct/PTC）报告只推进一次。
    //    无论成败都登记 callId（同一调用先失败后成功的矛盾报告同样不二次推进）。
    const callKey = event.callId !== undefined ? `${event.sessionId}:${event.callId}` : null;
    if (callKey !== null) {
      if (seenCalls.has(callKey)) {
        duplicateCallEvents += 1;
        await persist();
        return { advanced: false, epoch, reason: "duplicate-call" };
      }
      seenCalls.set(callKey, true);
      evictOldest(seenCalls, COMPRESS_CALL_LIMIT);
    }

    // 6) 元数据与文本矛盾：保守不推进（已记为处理过，重放也不得改判）。
    if (event.metaConflict === true) {
      metaConflictEvents += 1;
      await persist();
      return { advanced: false, epoch, reason: "meta-conflict" };
    }

    if (!event.success) {
      await persist();
      return { advanced: false, epoch, reason: "failed" };
    }
    if (event.blocksCreated === undefined) {
      // 成功但没有「实际创建块」的数值/已证实格式证据：按契约不推进，也不猜。
      await persist();
      return { advanced: false, epoch, reason: "no-block-evidence" };
    }
    if (event.blocksCreated === 0) {
      await persist();
      return { advanced: false, epoch, reason: "zero-blocks" };
    }

    epoch += 1;
    if (callKey === null) {
      // 无 callId 的推进：无法与 direct/PTC 另一路径关联 —— diagnostics 如实披露，
      // 不谎称跨路径 exactly-once。
      advancesWithoutCallIdentity += 1;
    }
    lastAdvance = {
      eventId: event.eventId,
      sessionId: event.sessionId,
      blocksCreated: event.blocksCreated,
      at: now(),
    };
    await persist();
    return { advanced: true, epoch, reason: "advanced" };
  }

  /**
   * 恢复：完整验证候选快照后一次性替换内存状态；任何字段损坏都在替换前抛错，
   * 旧 epoch / seen / watermarks / lastAdvance 原样保留（第一轮 R7 的修复）。
   *
   * 生命周期把守（第二轮 S2 的修复）：{@link options.isCurrent} 在 load 返回并校验
   * 通过之后、提交共享状态之前调用——返回 false 时丢弃候选（返回
   * {restored:false, cancelled:true}），绝不替换当前 epoch/去重/水位/归档/lastAdvance。
   * 因此 load 等待期间发生的新代事件不会被旧代恢复回滚或丢掉去重依据。
   * @param {{isCurrent?: () => boolean}} [options] 桥提供的取消/代际校验；缺省恒提交
   */
  async function restore({ isCurrent } = {}) {
    if (!sink) return { restored: false, epoch };
    const loaded = await sink.load();
    if (loaded === null || loaded === undefined) {
      return { restored: false, epoch };
    }
    if (typeof loaded !== "object" || Array.isArray(loaded)) {
      throw INVALID_INPUT("probe snapshot must be an object or null", {});
    }

    // —— 先全部校验到候选值，再一次性提交 ——
    const candidateEpoch = loaded.epoch;
    if (!Number.isInteger(candidateEpoch) || candidateEpoch < 0) {
      throw INVALID_INPUT(`probe snapshot epoch must be a non-negative integer, got ${JSON.stringify(candidateEpoch)}`, {});
    }
    const rawIds = loaded.compressSeenIds ?? loaded.seenEventIds; // 兼容第一轮字段名
    if (!Array.isArray(rawIds)) {
      throw INVALID_INPUT("probe snapshot compressSeenIds must be an array", {});
    }
    const candidateIds = [];
    for (const id of rawIds.slice(-COMPRESS_SEEN_LIMIT)) {
      if (typeof id !== "string" || id.length === 0) {
        throw INVALID_INPUT("probe snapshot compressSeenIds must be non-empty strings", { id: String(id) });
      }
      candidateIds.push(id);
    }
    const rawWatermarks = loaded.watermarks ?? {};
    if (typeof rawWatermarks !== "object" || Array.isArray(rawWatermarks)) {
      throw INVALID_INPUT("probe snapshot watermarks must be an object", {});
    }
    const candidateWatermarks = new Map();
    for (const [sessionId, seq] of Object.entries(rawWatermarks)) {
      if (typeof sessionId !== "string" || sessionId.length === 0 || !Number.isInteger(seq) || seq < 0) {
        throw INVALID_INPUT("probe snapshot watermarks must map sessionId to non-negative integers", { sessionId });
      }
      candidateWatermarks.set(sessionId, seq);
    }
    const rawExpired = loaded.expiredSessionIds ?? [];
    if (!Array.isArray(rawExpired)) {
      throw INVALID_INPUT("probe snapshot expiredSessionIds must be an array", {});
    }
    const candidateExpired = [];
    for (const sessionId of rawExpired) {
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        throw INVALID_INPUT("probe snapshot expiredSessionIds must be non-empty strings", { sessionId: String(sessionId) });
      }
      candidateExpired.push(sessionId);
    }
    const rawLastAdvance = loaded.lastAdvance;
    if (rawLastAdvance !== null && rawLastAdvance !== undefined && (typeof rawLastAdvance !== "object" || Array.isArray(rawLastAdvance))) {
      throw INVALID_INPUT("probe snapshot lastAdvance must be an object or null", {});
    }
    if (loaded.updatedAt !== undefined && typeof loaded.updatedAt !== "string") {
      throw INVALID_INPUT("probe snapshot updatedAt must be a string or undefined", {});
    }

    // —— 候选校验完毕；提交前把守生命周期（S2）：旧代的恢复不得替换新代状态 ——
    if (typeof isCurrent === "function" && !isCurrent()) {
      return { restored: false, cancelled: true, epoch };
    }

    // —— 提交 ——
    epoch = candidateEpoch;
    compressSeen.clear();
    for (const id of candidateIds) compressSeen.set(id, true);
    watermarks.clear();
    for (const [k, v] of candidateWatermarks) watermarks.set(k, v);
    expiredSessions.clear();
    for (const id of candidateExpired) expiredSessions.set(id, true);
    lastAdvance = rawLastAdvance ?? null;
    return { restored: true, epoch };
  }

  /**
   * 显式终止/归档一个会话（集成方的资源管理入口）：
   * 删除其水位并加入持久 expired 集合；此后该会话的一切压缩事件按 duplicate 语义
   * 拒绝（reason "expired-session"），绝不重新当成新压缩（fail-safe）。
   */
  async function forgetSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw INVALID_INPUT("forgetSession requires a non-empty sessionId", { sessionId });
    }
    const wasTracked = watermarks.has(sessionId) || expiredSessions.has(sessionId);
    watermarks.delete(sessionId);
    expiredSessions.set(sessionId, true);
    await persist();
    return { forgotten: true, wasTracked };
  }

  return {
    observe,
    restore,
    forgetSession,
    /** 当前 epoch（只读快照，供诊断/测试）。 */
    epoch: () => epoch,
    /** 诊断信息。 */
    diagnostics: () => ({
      epoch,
      compressSeenCount: compressSeen.size,
      watermarkSessions: watermarks.size,
      expiredSessions: expiredSessions.size,
      recentCount: recentRing.size,
      callIdentityTracked: seenCalls.size,
      duplicateCallEvents,
      advancesWithoutCallIdentity,
      metaConflictEvents,
      lastAdvance,
      persistence: sink ? "sink" : "memory",
      sinkError,
    }),
    /** 测试/检查点用：当前可持久化快照。 */
    snapshot,
  };
}
