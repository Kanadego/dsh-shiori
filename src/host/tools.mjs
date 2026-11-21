/**
 * Shiori host bridge — 兼容工具（P0）。
 *
 * 覆盖 CONTRACTS.md 要求的最小集合：soul_read / soul_update、memory_read / search /
 * append / rewrite、core_write、topic_append、memory_list_topics。
 *
 * 硬边界：
 * - 读 payload 一律不接受 scope 参数（scope 只能来自宿主可信来源注入 service 的 factory）；
 * - 所有写都委托 service.mutate（即 B 的 commit），携带 expectedRevision 做 CAS，绝不绕过；
 * - 旧工具（soul_update / memory_append / memory_rewrite / topic_append）没有 expectedRevision
 *   入参：执行时先经 service 读当前版本，再以读到的真实 revision 发起 CAS（read-then-CAS），
 *   不假造 revision。读与 CAS 之间的窗口由 B 的跨进程锁 + CAS 兜底（冲突即 REVISION_CONFLICT）。
 * - persona 的独立 CAS 持久化由后续集成 service 实现；本模块只以 kind:"persona" 委托并
 *   用测试 stub 验证（已知依赖，见 REPORT.md）。
 * - 工具回执的投影状态恒为 "written-pending-projection"（已落盘、待下一次请求投影）：
 *   桥不预测下一次请求，不提前回报「已生效」。
 * - 不静默截断：memory_read 返回全文，无 truncated 逻辑（与 soul-md 的 20000 字符截断不同，
 *   属有意分歧，见 REPORT.md）。
 */
import { randomUUID } from "node:crypto";
import { INVALID_INPUT, INVALID_STATE, UNSUPPORTED } from "./errors.mjs";
import { TOOL_OUTPUT_SCHEMAS, renderToolOutput } from "../plugin/tool-schemas.mjs";
import { assertNotHostLocked, validateReadonlyGuard } from "./readonly-guard.mjs";
// S3：group 软上限提示文案（超限只 warning 不报错，与 A 层口径一致）。
import { groupSoftLimitWarning } from "../core/topics.mjs";
// S3 group_manage（P1#7 解环，0.5-1A）：组清单文件 I/O（groups.json 读写 / CAS /
// 删组）从 src/storage/groups.mjs 导入；迁移计划与条目校验等纯逻辑仍从
// core/groups.mjs 导入。core 只留纯逻辑、storage 承接文件 I/O，依赖单向无环。
import { readGroups, writeGroups, deleteGroup } from "../storage/groups.mjs";
import { planGroupMigration, validateGroupEntry } from "../core/groups.mjs";

/** 派生索引标题（= src/core/render.mjs 的 INDEX_HEADER）。正文与索引在读取时拼接，正文里不得自带。 */
const DERIVED_INDEX_HEADER = "## 主题记忆索引";

/** core 正文禁止自带派生索引：否则读取渲染时会再拼一份，索引重复。 */
function rejectDerivedIndex(content, toolName) {
  if (typeof content === "string" && content.includes(DERIVED_INDEX_HEADER)) {
    throw INVALID_INPUT(
      `${toolName}: core body must not contain the derived topic index (found "${DERIVED_INDEX_HEADER}"); pass only the body, the index is generated on read`,
      { header: DERIVED_INDEX_HEADER },
    );
  }
}

/** 宿主 system 的 section 名（与 soul-md 的 soul:persona/soul:memory 不同名，便于唯一写者判定）。 */
export const SECTION_PERSONA = "shiori:persona";
export const SECTION_CORE = "shiori:core";

/** config 缺省时的 persona 上限兜底；正式值以注入的已校验 config 为准。 */
const FALLBACK_PERSONA_MAX_CHARS = 12000;

function requireObject(args) {
  if (args === undefined || args === null) return {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw INVALID_INPUT("tool arguments must be an object", { received: typeof args });
  }
  return args;
}

/** 读 payload 不接受任意 scope：schema 不暴露，payload 混入也拒绝。 */
function rejectScope(args) {
  if (args.scope !== undefined) {
    throw INVALID_INPUT("scope cannot be passed in tool payloads; scope comes from the trusted host factory", {});
  }
}

function requireString(args, field, { allowEmpty = false } = {}) {
  const value = args[field];
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw INVALID_INPUT(`\`${field}\` must be a non-empty string`, { field });
  }
  return value;
}

function optionalString(args, field) {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw INVALID_INPUT(`\`${field}\` must be a string when present`, { field });
  }
  return value;
}

function byteLen(text) {
  return Buffer.byteLength(text, "utf8");
}

/**
 * 旧 soul-md 工具的 topic 参数解析（与 memory-layout.js:27-31 normalizeMemoryTopic 对齐）：
 * 缺省/空 → core；`core` / `core.md`（大小写不敏感，trim 后）→ core；其余为 topic key。
 * DESIGN.md §10：core、core.md 是保留别名，真实 topic key 不得与之冲突。
 */
export function resolveTopicArg(value) {
  const topic = String(value ?? "").trim();
  if (!topic || /^(core|core\.md)$/i.test(topic)) return null; // null = core 路径
  return topic;
}

/** 与 soul-md memory_append 一致的日期标题格式。 */
export function datedHeading(section, date) {
  const d = date ?? new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `## ${stamp} — ${section}`;
}

/** 拼接追加块；空正文不加前导换行。 */
export function appendBlock(existingText, section, content, date) {
  const block = `\n${datedHeading(section, date)}\n\n${content}\n`;
  return existingText.length === 0 ? block.replace(/^\n/, "") : existingText + block;
}

/**
 * 0.5-2B R3：topic-activity 事件入账（fire-and-forget，绝不阻塞工具返回）。
 * 账本 append 内部已兜底（永不抛 / 永不 reject，写失败只记账本诊断）；这里再兜
 * 一层是防调用方注入缺 append 接口的对象。事件在工具成功路径上入账——失败的
 * 工具调用（校验拒绝 / CAS 冲突）不入账，账本不记未发生的操作。
 * scopeId 由调用方按 targetScopeId 口径给出（被操作记忆所属 scope），本函数不猜。
 */
function noteActivity(activity, event) {
  try {
    activity?.append?.(event);
  } catch {
    // 双保险：账本故障绝不影响工具语义。
  }
}

/**
 * 统一从 mutate 回执构造工具回执。
 * 投影状态恒为 written-pending-projection：已落盘、待投影，绝不提前声称已生效。
 */
function writeReceipt(mutateResult, scopeFallback) {
  const changes = mutateResult.changes ?? [];
  const first = changes[0] ?? {};
  return {
    operationId: mutateResult.operationId,
    generation: mutateResult.generation,
    revision: first.afterRevision ?? null,
    scope: first.scope ?? scopeFallback ?? null,
    projection: "written-pending-projection",
    changes,
  };
}

/**
 * 构造兼容工具定义。
 * @param {object} deps
 * @param {object} deps.service 见 docs/host/README.md 的 service 契约
 * @param {() => {sessionId:string|null, scopeId:string|null}} [deps.getSessionInfo]
 * @param {object} [deps.config] 已校验配置（persona.maxChars 等）
 * @param {() => Date} [deps.now] 时钟注入
 * @param {object} [deps.readonlyGuard] F7 只读守卫（createReadonlyGuard 产物；可选，
 *   缺省时写行为与 0.1 完全一致）。外部写锁持续持有进入只读态后，本工厂的写工具
 *   （soul_update / memory_append / memory_rewrite / core_write / topic_append）
 *   抛 code="HOST_LOCKED"；读工具与 L0/L1 注入不受影响。
 * @param {string} [deps.dataRoot] 数据根（绝对路径；0.5-2B R1 组目录读法的数据来源，
 *   groups.json 位于 <dataRoot>/scopes/<scopeId>/）。缺省时组目录特性整体停用，
 *   memory_read 行为与 0.4 完全一致（controller 是生产接线点；host bridge 旧路径
 *   未传时按设计降级）。读路径绝不写盘。
 * @param {object} [deps.activity] 0.5-2B R3 topic-activity 账本
 *   （createTopicActivityLedger 产物）。缺省时事件入账停用（行为与 0.4 一致）；
 *   注入后 memory_read / memory_search 的成功读与 memory_append / memory_rewrite
 *   的成功写在返回后 fire-and-forget 入账，绝不阻塞、绝不影响工具语义。
 */
export function createCompatTools({ service, getSessionInfo, config, now, readonlyGuard, dataRoot, activity } = {}) {
  if (!service || typeof service.mutate !== "function") {
    throw INVALID_INPUT("service with mutate() is required", {});
  }
  validateReadonlyGuard(readonlyGuard);
  const personaMaxChars = Number.isInteger(config?.persona?.maxChars) && config.persona.maxChars > 0
    ? config.persona.maxChars
    : FALLBACK_PERSONA_MAX_CHARS;
  const clock = now ?? (() => new Date());

  async function scopeIdOf() {
    try {
      return getSessionInfo?.()?.scopeId ?? null;
    } catch {
      return null;
    }
  }

  /**
   * 0.5-2B R1：读当前 scope 组清单（memory_read 组目录分支与同名组 note 共用）。
   * dataRoot 未注入（host bridge 旧路径 / 嵌入直构）或清单缺失、dataRoot 缺失、
   * 读取失败（含 LOCK_BUSY / IO_ERROR）时返回 null——组目录与 note 是读路径上的
   * 增强特性，绝不让既有「topic 正文读取 / NOT_FOUND」语义因组清单不可读而退化
   * （这是有意的降级口径：memory_read 在 0.4 及以前完全不依赖 groups.json）。
   */
  async function readGroupsSafe(scopeId) {
    if (typeof dataRoot !== "string" || dataRoot.length === 0 || scopeId === null) return null;
    try {
      const { revision, data } = await readGroups({ dataRoot, scopeId });
      return { revision, groups: data.groups };
    } catch {
      return null;
    }
  }

  /** 核心写路径需要磁盘正文视图；渲染视图（含派生索引）绝不能回写。 */
  async function readDiskCore() {
    if (typeof service.readCore !== "function") {
      throw UNSUPPORTED(
        "core write paths require service.readCore() (disk body without the derived index); "
        + "the injected service does not provide it. Rendered views must never be written back.",
        {},
      );
    }
    return service.readCore();
  }

  const tools = [
    // ── L0 persona ────────────────────────────────────────────────────────
    {
      name: "soul_read",
      description: "Read the persona card active for the current scope, exactly as stored (Shiori bridge; delegates to the injected memory service).",
      inputSchema: {},
      outputSchema: TOOL_OUTPUT_SCHEMAS["soul_read"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const persona = await service.readPersona();
        return {
          exists: persona?.name != null && persona?.text != null,
          persona: persona?.name ?? "none",
          content: persona?.text ?? "",
          revision: persona?.revision ?? null,
        };
      },
    },
    {
      name: "soul_update",
      description: "Replace the active persona card with new content. CAS-protected: the bridge reads the current revision and commits through service.mutate; concurrent modifications are rejected instead of overwritten.",
      inputSchema: {
        content: { type: "string", required: true, description: "The complete new persona card (markdown)." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry (P5)." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["soul_update"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        assertNotHostLocked(readonlyGuard);
        const content = requireString(a, "content");
        // DESIGN.md:110：L0 上限按 UTF-16 code units（content.length）计，UTF-8 bytes 仅作诊断。
        if (!content.isWellFormed()) {
          throw INVALID_INPUT("soul_update: content contains unpaired surrogates and would not survive lossless UTF-8 encoding", {});
        }
        if (content.length > personaMaxChars) {
          throw INVALID_INPUT(`soul_update: content exceeds persona.maxChars (${personaMaxChars} UTF-16 chars)`, {
            chars: content.length,
            bytes: byteLen(content),
            limit: personaMaxChars,
          });
        }
        const current = await service.readPersona();
        const result = await service.mutate({
          operationId: typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID(),
          changes: [{
            kind: "persona",
            text: content,
            expectedRevision: current?.revision ?? null,
          }],
        });
        return writeReceipt(result, await scopeIdOf());
      },
    },

    // ── L1 core 读取 ──────────────────────────────────────────────────────
    {
      name: "memory_read",
      description: "Read long-term memory. Without arguments returns the complete rendered L1 view (core body + derived topic index). With a topic key returns that topic's full body. With a group key (a key in the current scope's group list that is not a topic) returns the group's member directory: kind='group', one entry per member topic with key/title/summary/retention/archived/updated/chars — never any body text (content is empty; pick a member key and read it separately). If a key matches both a topic and a group, the topic body wins and the response carries a note about the same-named group. An unknown key (neither topic nor group) is NOT_FOUND — use memory_list_topics to see existing topics. Scope is fixed by the host; it cannot be passed.",
      inputSchema: {
        topic: {
          type: "string",
          description: "Optional key. Omit or pass core/core.md for the rendered core view (legacy alias). Topic key → that topic's full body. Group key (not a topic) → the group's member directory (metadata only, no bodies).",
        },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_read"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const topicArg = optionalString(a, "topic");
        const topic = resolveTopicArg(topicArg); // core / core.md / 空 → core 路径
        const sessionScope = await scopeIdOf();
        if (topic === null) {
          const view = await service.readCoreView();
          const text = view?.text ?? "";
          // 0.5-2B R3：core 正文读取入账 read 事件（成功返回后 fire-and-forget）。
          // core 无 topicKey；scopeId 取 core 视图所属 scope（global 回落时是 global）。
          noteActivity(activity, { kind: "read", scopeId: view?.scopeId ?? sessionScope });
          return {
            exists: text.length > 0,
            bytes: byteLen(text),
            truncated: false,
            source: view?.scopeId ?? null,
            topic: "",
            content: text,
            revision: view?.revision ?? null,
            // core 无分组概念，给确定缺省形状（与 topic 读分支同形状，方便消费方）。
            group: [],
            pinned: false,
          };
        }
        let t = null;
        try {
          t = await service.readTopic(topic);
        } catch (error) {
          // 非 NOT_FOUND（fake service 的 INVALID_STATE / 其他 IO 失败）原样上抛，
          // 与 0.4 行为逐字节一致；组目录探测只挂在 NOT_FOUND 路径上。
          if (error?.code !== "NOT_FOUND") throw error;
          // 0.5-2B R1 组目录分支：key 不是可见 topic，但可能是当前 scope 的组 key。
          // 组清单不可读（dataRoot 未注入 / 缺失 / 失败）时 readGroupsSafe 返回 null，
          // 直接落 NOT_FOUND（组目录特性整体降级，不改变既有语义）。
          const listing = await readGroupsSafe(sessionScope);
          const group = listing?.groups.find((g) => g?.key === topic) ?? null;
          if (group === null) {
            // 未知 key：NOT_FOUND 原样保留 code，文案补 memory_list_topics 提示。
            error.message += `（如需查看现有 topic 清单，请使用 memory_list_topics；`
              + `传组 key 可读组成员目录）`;
            throw error;
          }
          // 成员目录：与 group_manage list 的成员口径一致——当前 scope 可见 topic
          // 快照按 t.group.includes(组key) 过滤（主组/多组挂载都算成员）。绝不含正文。
          const topics = await service.listTopics();
          const members = (Array.isArray(topics) ? topics : [])
            .filter((x) => Array.isArray(x?.group) && x.group.includes(group.key))
            .map((x) => ({
              key: x.key,
              title: x.title,
              summary: x.summary,
              // retention 是 0.5 阶段 A 的 A 线字段（默认 standing）；本线不改数据层，
              // fake/旧 service 缺该字段时按方案缺省口径补齐，A 线落地后透传真值。
              retention: x.retention === undefined ? "standing" : x.retention,
              archived: x.archived === true,
              updated: x.updated ?? null,
              chars: (x.body ?? "").length,
            }));
          // R3：组目录读取入账 group_list 事件（组清单挂在当前 scope）。
          noteActivity(activity, { kind: "group_list", scopeId: sessionScope, groupKey: group.key });
          return {
            exists: true,
            kind: "group",
            bytes: 0,
            truncated: false,
            source: sessionScope,
            topic: group.key,
            // 组目录绝不含正文：content 恒空串、bytes 恒 0（schema required 字段给
            // 确定缺省形状，与 core 分支同款口径）。
            content: "",
            revision: listing.revision,
            groupTitle: group.title ?? "",
            groupSummary: group.summary ?? "",
            members,
          };
        }
        // topic 正文分支（同名组冲突规则写死：topic 优先，正文读取语义不变）。
        const sameNameListing = await readGroupsSafe(sessionScope);
        const sameNameGroup = sameNameListing?.groups.find((g) => g?.key === t.key) ?? null;
        // R3：topic 正文读取入账 read 事件（scopeId=targetScopeId；global 回落的
        // topic 归属 global，绝不记成当前活跃 scope）。
        noteActivity(activity, { kind: "read", scopeId: t.scopeId ?? sessionScope, topicKey: t.key });
        return {
          exists: true,
          bytes: byteLen(t.body ?? ""),
          truncated: false,
          source: t.scopeId,
          topic: t.key,
          content: t.body ?? "",
          revision: t.revision,
          // S3：分组元数据随读返回（fake/旧 service 缺字段时按缺省口径补齐）。
          group: Array.isArray(t.group) ? t.group : [],
          pinned: t.pinned === true,
          // 0.5-2B R1 同名组：仅当当前 scope 存在同 key 组时附 note（不改变正文语义）。
          ...(sameNameGroup !== null ? {
            note: `同名组提示：当前 scope 存在与 topic "${t.key}" 同名的组；本回执按 topic 正文语义返回`
              + `（topic 优先于同名组），该组成员目录不可经本工具按此 key 读取，`
              + `可用 group_manage action=list 查看组清单`,
          } : {}),
        };
      },
    },

    // ── L2/L3 检索 ────────────────────────────────────────────────────────
    {
      name: "memory_search",
      description: "Keyword search over visible topics; archived (cold) topics are included by default but return summary-level entries only (state='archived', score=0, listed after active hits) — never full text; use memory_read(topic) for full text. Returns keys, titles and summaries only. Lexical search, not semantic matching.",
      inputSchema: {
        query: { type: "string", required: true, description: "Keywords or a short question." },
        limit: { type: "integer", description: "Maximum results, 1–20 (default 5)." },
        includeArchived: { type: "boolean", description: "Explicitly include archived (cold) spark cards; only affects spark cold cards — topic archives are always included as summary entries. Always read-only; archived cards are never revived or re-matched automatically." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_search"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const query = requireString(a, "query");
        let limit = 5;
        if (a.limit !== undefined) {
          if (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 20) {
            throw INVALID_INPUT("`limit` must be an integer between 1 and 20", { limit: a.limit });
          }
          limit = a.limit;
        }
        const sessionScope = await scopeIdOf();
        const matches = await service.search(query);
        const result = { matches: Array.isArray(matches) ? matches.slice(0, limit) : [] };
        if (a.includeArchived === true) {
          if (typeof service.searchArchived !== "function") {
            throw UNSUPPORTED(
              "memory_search includeArchived requires service.searchArchived() (cold-store reader); "
              + "the injected service does not provide it. Archived cards are never auto-searched.",
              {},
            );
          }
          const archived = await service.searchArchived(query);
          const merged = [
            ...result.matches,
            ...(Array.isArray(archived) ? archived : []).map((m) => ({ score: 0, ...m, state: "archived" })),
          ];
          result.matches = merged.slice(0, limit);
        }
        // 0.5-2B R3：每个最终返回给模型的命中入账一条 search_hit（每命中一条一条，
        // 含归档冷命中——模型确实看到了这些摘要条目）。scopeId 取命中条目的
        // targetScopeId，fake/旧 service 缺该字段时回落当前 scope。
        for (const match of result.matches) {
          noteActivity(activity, {
            kind: "search_hit",
            scopeId: match?.scopeId ?? sessionScope,
            topicKey: match?.key,
          });
        }
        return result;
      },
    },

    // ── 追加 / 重写（旧工具：read-then-CAS）────────────────────────────────
    {
      name: "memory_append",
      description: "Append a dated Markdown block to memory in the CURRENT scope. Write proactively: durable rules, decisions, fixes and facts should be recorded when they happen, not when the user asks — if it matters past this conversation, append it now. Omit topic for the always-visible core body; pass a topic key for that topic file. The append is committed through service.mutate with CAS.",
      inputSchema: {
        section: { type: "string", required: true, description: "Short heading for the entry." },
        content: { type: "string", required: true, description: "The markdown text to remember." },
        topic: { type: "string", description: "Optional topic key. Omit or pass core/core.md for the core body (legacy alias)." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry (P5)." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_append"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        assertNotHostLocked(readonlyGuard);
        const section = requireString(a, "section");
        const content = requireString(a, "content");
        const topic = resolveTopicArg(optionalString(a, "topic")); // core / core.md / 空 → core 路径
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        if (topic === null) {
          rejectDerivedIndex(content, "memory_append");
          const current = await readDiskCore();
          const candidate = appendBlock(current.text ?? "", section, content, clock());
          const result = await service.mutate({
            operationId,
            changes: [{ kind: "core", text: candidate, expectedRevision: current.revision }],
          });
          const receipt = writeReceipt(result, current.scopeId);
          // 0.5-2B R3：成功提交后入账 updated（core 分支无 topicKey；scopeId 取
          // 提交回执的实际落点 scope——global 回落的写会落在活跃 scope）。
          noteActivity(activity, { kind: "updated", scopeId: receipt.scope ?? current.scopeId });
          return receipt;
        }
        const current = await service.readTopic(topic);
        const candidate = appendBlock(current.body ?? "", section, content, clock());
        const result = await service.mutate({
          operationId,
          changes: [{
            kind: "topic",
            key: current.key,
            text: candidate,
            expectedRevision: current.revision,
            topic: { title: current.title, summary: current.summary },
          }],
        });
        const receipt = writeReceipt(result, current.scopeId);
        // 0.5-2B R3：成功提交后入账 updated（scopeId 同上，取提交回执实际落点）。
        noteActivity(activity, { kind: "updated", scopeId: receipt.scope ?? current.scopeId, topicKey: current.key });
        return receipt;
      },
    },
    {
      name: "memory_rewrite",
      description: "Replace one memory body in the CURRENT scope: omit topic for the core body, or pass a topic key to replace that topic's body (topic front-matter metadata is preserved by the service). Keep bodies accurate — stale wording is worse than no memory. Build the new content from memory_read output unless you deliberately drop entries.",
      inputSchema: {
        content: { type: "string", required: true, description: "The new full body content (markdown)." },
        topic: { type: "string", description: "Optional topic key. Omit or pass core/core.md for the core body (legacy alias)." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry (P5)." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_rewrite"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        assertNotHostLocked(readonlyGuard);
        const content = requireString(a, "content", { allowEmpty: true });
        const topic = resolveTopicArg(optionalString(a, "topic")); // core / core.md / 空 → core 路径
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        if (topic === null) {
          rejectDerivedIndex(content, "memory_rewrite");
          const current = await readDiskCore();
          const result = await service.mutate({
            operationId,
            changes: [{ kind: "core", text: content, expectedRevision: current.revision }],
          });
          const receipt = writeReceipt(result, current.scopeId);
          // 0.5-2B R3：成功提交后入账 updated（core 分支无 topicKey）。
          noteActivity(activity, { kind: "updated", scopeId: receipt.scope ?? current.scopeId });
          return receipt;
        }
        const current = await service.readTopic(topic);
        const result = await service.mutate({
          operationId,
          changes: [{
            kind: "topic",
            key: current.key,
            text: content,
            expectedRevision: current.revision,
            topic: { title: current.title, summary: current.summary },
          }],
        });
        const receipt = writeReceipt(result, current.scopeId);
        // 0.5-2B R3：成功提交后入账 updated（scopeId 取提交回执实际落点 scope）。
        noteActivity(activity, { kind: "updated", scopeId: receipt.scope ?? current.scopeId, topicKey: current.key });
        return receipt;
      },
    },

    // ── 新式写工具（expectedRevision 必须显式给出）─────────────────────────
    {
      name: "core_write",
      description: "Replace the disk core body (L1, without the derived index). Pass the opaque revision from memory_read(); null only when no visible core exists. Global fallback is validated before an active-scope copy is created. The service enforces the complete rendered L1 budget. Keep the core for rules that must be visible in every turn; move detail into topics so the budget stays healthy.",
      inputSchema: {
        content: { type: "string", required: true, description: "The new core body (markdown)." },
        expectedRevision: {
          oneOf: [{ type: "string" }, { type: "null" }],
          required: true,
          description: "Opaque revision returned by memory_read() or the service. Do not parse or construct it. Null is allowed only when no visible core exists.",
        },
        operationId: { type: "string", description: "Client-supplied operation id for idempotent retry." },
        section: { type: "string", description: "NOT supported in P0; must be omitted." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["core_write"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        assertNotHostLocked(readonlyGuard);
        const content = requireString(a, "content", { allowEmpty: true });
        const section = optionalString(a, "section");
        if (section !== undefined && section.length > 0) {
          throw UNSUPPORTED("core_write(section) is not supported in P0; rewrite the whole body instead", { section });
        }
        rejectDerivedIndex(content, "core_write");
        if (!("expectedRevision" in a)) {
          throw INVALID_INPUT("core_write requires explicit expectedRevision (string, or null for first creation)", {});
        }
        const expectedRevision = a.expectedRevision;
        if (expectedRevision !== null && typeof expectedRevision !== "string") {
          throw INVALID_INPUT("`expectedRevision` must be a string or null", { expectedRevision });
        }
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        const result = await service.mutate({
          operationId,
          changes: [{ kind: "core", text: content, expectedRevision }],
        });
        return writeReceipt(result, await scopeIdOf());
      },
    },
    {
      name: "topic_append",
      description: "Append a dated section to an L3 topic body. Use it whenever a project gains detail worth keeping — findings, fixes, changed decisions, lessons — instead of letting it evaporate with the conversation. The topic must already exist (P0 does not create topics). Committed through service.mutate with CAS.",
      inputSchema: {
        topic: { type: "string", required: true, description: "Topic key." },
        section: { type: "string", required: true, description: "Short heading for the appended section." },
        content: { type: "string", required: true, description: "The markdown text to append." },
        group: { type: "array", items: { type: "string" }, description: "Optional group keys (first is primary). Omit to keep the topic's existing groups; every key must already exist in the scope's group list. More than 3 groups only yields a warning." },
        operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry (P5)." },
      },
      outputSchema: TOOL_OUTPUT_SCHEMAS["topic_append"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const topicArg = requireString(a, "topic");
        if (resolveTopicArg(topicArg) === null) {
          throw INVALID_INPUT(
            `topic_append: "${topicArg}" is a reserved core alias; use core_write or memory_append/rewrite without a topic for the core body`,
            { topic: topicArg },
          );
        }
        const topic = topicArg;
        const section = requireString(a, "section");
        const content = requireString(a, "content");
        assertNotHostLocked(readonlyGuard);
        const current = await service.readTopic(topic);
        const candidate = appendBlock(current.body ?? "", section, content, clock());
        // S3：可选 group——缺省不传（继承 token 里的原组，append 不改组）；
        // 显式给出则改挂组（组存在性由 store 校验）。超软上限只给 warning。
        const group = a.group;
        const effectiveGroup = group !== undefined ? group : (Array.isArray(current.group) ? current.group : []);
        const warning = groupSoftLimitWarning({ key: current.key, group: effectiveGroup });
        const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
        const result = await service.mutate({
          operationId,
          changes: [{
            kind: "topic",
            key: current.key,
            text: candidate,
            expectedRevision: current.revision,
            topic: {
              title: current.title,
              summary: current.summary,
              ...(group !== undefined ? { group } : {}),
            },
          }],
        });
        return { ...writeReceipt(result, current.scopeId), ...(warning !== null ? { warning } : {}) };
      },
    },

    // ── L3 目录枚举 ───────────────────────────────────────────────────────
    {
      name: "memory_list_topics",
      description: "List visible topics with size (characters and UTF-8 bytes of the body) for consolidation workflows. Does not return bodies; use memory_read(topic).",
      inputSchema: {},
      outputSchema: TOOL_OUTPUT_SCHEMAS["memory_list_topics"],
      outputRender: renderToolOutput,
      async execute(args) {
        const a = requireObject(args);
        rejectScope(a);
        const topics = await service.listTopics();
        return {
          topics: (Array.isArray(topics) ? topics : []).map((t) => ({
            key: t.key,
            title: t.title,
            summary: t.summary,
            scopeId: t.scopeId,
            revision: t.revision,
            updated: t.updated,
            // S3：分组元数据随列表返回（L1 索引保持平铺，这里只做数据透传）。
            group: Array.isArray(t.group) ? t.group : [],
            pinned: t.pinned === true,
            chars: (t.body ?? "").length,
            bytes: byteLen(t.body ?? ""),
          })),
        };
      },
    },
  ];

  return tools;
}

/**
 * P5 topic_create 工具（独立工厂：保持既有 createCompatTools 恒为 9 个兼容工具，
 * controller 负责把 topic_create、group_manage 与 6 个 Spark 工具一起追加成 17 工具全集）。
 * 创建走 service.mutate（kind:topic + expectedRevision null）：派生目录 / 索引
 * 增长 / 完整 L1 预算由底层 policy 在候选快照上统一裁决，绝不绕 policy 直接 fs 写。
 *
 * @param {object} deps
 * @param {object} deps.service 见 docs/host/README.md 的 service 契约
 * @param {() => {sessionId:string|null, scopeId:string|null}} [deps.getSessionInfo]
 * @param {() => Date} [deps.now] 时钟注入
 * @param {object} [deps.readonlyGuard] F7 只读守卫（可选；只读态下 topic_create 抛 HOST_LOCKED）
 * @param {object} [deps.activity] 0.5-2B R3 topic-activity 账本（可选；成功创建后
 *   fire-and-forget 入账 updated 事件，绝不阻塞、绝不影响工具语义）
 */
export function createTopicCreateTool({ service, getSessionInfo, now, readonlyGuard, activity } = {}) {
  if (!service || typeof service.mutate !== "function") {
    throw INVALID_INPUT("service with mutate() is required", {});
  }
  validateReadonlyGuard(readonlyGuard);
  const clock = now ?? (() => new Date());

  async function scopeIdOf() {
    try {
      return getSessionInfo?.()?.scopeId ?? null;
    } catch {
      return null;
    }
  }

  return {
  name: "topic_create",
  description: "Create a new L3 topic in the CURRENT scope with title and summary (front-matter metadata; the body starts empty). Create one as soon as a durable theme appears — a new project, a recurring subject, a long investigation; title plus a one-line summary is enough, detail can be appended later. If a topic with the same key exists in the active scope this is a conflict; if it only exists in global fallback an active-scope shadow is created so the active card gets its own copy. The complete visible L1 budget (index growth) is validated by the service before commit.",
  inputSchema: {
    topic: { type: "string", required: true, description: "Topic key (must be a safe filename; 'core' is reserved)." },
    title: { type: "string", required: true, description: "Human-readable topic title." },
    summary: { type: "string", required: true, description: "One-line summary for the derived L1 index (single line)." },
    group: { type: "array", items: { type: "string" }, description: "Optional group keys (first is primary). Every key must already exist in the scope's group list (create groups via group_manage). More than 3 groups only yields a warning." },
    operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry." },
  },
  outputSchema: TOOL_OUTPUT_SCHEMAS["topic_create"],
  outputRender: renderToolOutput,
  async execute(args) {
    const a = requireObject(args);
    rejectScope(a);
    assertNotHostLocked(readonlyGuard);
    const topicArg = requireString(a, "topic");
    if (resolveTopicArg(topicArg) === null) {
      throw INVALID_INPUT(
        `topic_create: "${topicArg}" is a reserved core alias; core is not a creatable topic`,
        { topic: topicArg },
      );
    }
    const title = requireString(a, "title");
    const summary = requireString(a, "summary");
    if (summary.includes("\n") || summary.includes("\r")) {
      throw INVALID_INPUT("topic_create: `summary` must be a single line (it feeds the derived L1 index)", {});
    }
    if (title.length > 200) {
      throw INVALID_INPUT("topic_create: `title` must be at most 200 UTF-16 chars", { length: title.length });
    }
    const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
    // 可见性探测：active 已存在 → conflict；仅 global 同 key → active shadow；
    // 都不存在 → 新建。创建走 service.mutate（kind:topic + expectedRevision null），
    // 派生目录 / 索引增长 / 完整 L1 预算由底层 policy 在候选快照上统一裁决。
    let visible = null;
    try {
      visible = await service.readTopic(topicArg);
    } catch (error) {
      if (error?.code !== "NOT_FOUND") throw error;
    }
    const alreadyActive = visible !== null && visible.scopeId === (await scopeIdOf());
    if (alreadyActive) {
      throw INVALID_INPUT(
        `topic_create: topic "${topicArg}" already exists in the active scope (use topic_append / memory_rewrite instead)`,
        { topic: topicArg, scope: visible.scopeId },
      );
    }
    const updated = clock().toISOString();
    // S3：可选 group（缺省 [] = 未分组）；组存在性由 store.commit 校验，
    // 超软上限只给 warning 文本不报错。
    const group = a.group;
    const result = await service.mutate({
      operationId,
      changes: [{
        kind: "topic",
        key: topicArg,
        expectedRevision: null, // active scope 内创建（store 对新文件执行 null CAS）
        text: "",
        topic: { title, summary, updated, ...(group !== undefined ? { group } : {}) },
      }],
    });
    const receipt = writeReceipt(result, await scopeIdOf());
    const warning = groupSoftLimitWarning({ key: topicArg, group: Array.isArray(group) ? group : [] });
    // 0.5-2B R3：成功创建后入账 updated（scopeId 取提交回执实际落点 scope）。
    noteActivity(activity, { kind: "updated", scopeId: receipt.scope ?? (await scopeIdOf()), topicKey: topicArg });
    return {
      ...receipt,
      created: true,
      alreadyExists: false,
      topic: topicArg,
      ...(warning !== null ? { warning } : {}),
    };
  },
};
};

/**
 * 迁移已提交、随后删组失败时的错误注解（0.4 收尾，必修 3）。
 * 只要本次 action 真的迁移过 topic，不论首试还是重试失败、也不论 error.code，
 * 调用方都必须知道「迁移已生效」——否则看到「组清单不存在 / migrateTo 不存在」
 * 会误以为整体失败。文案不承诺重跑幂等（目标组没了会卡在 migrateTo 预检）。
 */
function noteMigrationTookEffect(error, { key, migrateTo, retried }) {
  error.message += `（迁移已生效：组内 topic 已迁至 "${migrateTo}"，组条目 "${key}" 可能已不存在或尚未删除；`
    + (retried
      ? `自动重试一次仍失败（${error.code ?? "未知错误"}），重跑本 action 不一定幂等`
        + `（"${migrateTo}" 若已不存在会卡在 migrateTo 预检），请先核对组清单再收尾）`
      : `本次未自动重试（${error.code ?? "未知错误"}），请先核对组清单再收尾）`);
  return error;
}

/**
 * S3 group_manage 工具（第 17 个宿主工具，agent 可调；action=list/create/update/delete，
 * 0.4 收尾新增 action=repair：清理 list 里 dangling 字段报出的悬空组引用）。
 * 组清单文件 I/O 复用 src/storage/groups.mjs（P1#7 解环后 groups.json 读写 / CAS
 * 住 storage 层），迁移计划等纯逻辑来自 src/core/groups.mjs；topic 文件的组迁移
 * 改写走 service.mutate（store 提交协议：journal/CAS/预算），绝不绕过存储层直写。
 *
 * 删除语义（§S3.5 + P2#12b 单事务，0.5-1A）：组空直接删（storage 层 CAS 写）；
 * 非空必须给 migrateTo（漏给报 INVALID_STATE 并列出成员）。非空组的删组收敛为
 * 一次 CAS 提交：成员重挂（topic changes）与组条目删除（mutate 请求的 groups
 * 字段）经 service 透传进 store.commit，作为同一 journal 事务的两个条目——
 * 失败整体回滚，不存在半迁移；提交期候选复核发现并发新挂成员时整体拒绝
 * （任何时刻无悬空 key），重跑会把新成员一并迁移，repair 对单事务删除的组
 * 无事可做。service 不认识 groups 字段时（测试 fake / 旧实现）回执无 groups
 * 条目，回退到既有两步路径（迁移提交 → deleteGroup CAS 删组 + 自愈重试），
 * 行为与 0.4 收尾版完全一致。
 *
 * @param {object} deps
 * @param {object} deps.service 见 docs/host/README.md 的 service 契约（mutate/readTopic/listTopics）
 * @param {string} deps.dataRoot 数据根（绝对路径；groups.json 位于 <dataRoot>/scopes/<scopeId>/）
 * @param {string} deps.scopeId 当前工具面绑定的 scope（宿主可信来源，不接受 payload 指定）
 * @param {() => Date} [deps.now] 时钟注入
 * @param {object} [deps.readonlyGuard] F7 只读守卫（可选；只读态下 create/update/delete 抛 HOST_LOCKED）
 */
export function createGroupManageTool({ service, dataRoot, scopeId, now, readonlyGuard } = {}) {
  if (!service || typeof service.mutate !== "function") {
    throw INVALID_INPUT("service with mutate() is required", {});
  }
  if (typeof dataRoot !== "string" || dataRoot.length === 0) {
    throw INVALID_INPUT("group_manage requires an explicit dataRoot (groups.json location)", {});
  }
  if (typeof scopeId !== "string" || scopeId.length === 0) {
    throw INVALID_INPUT("group_manage requires the trusted scopeId", {});
  }
  validateReadonlyGuard(readonlyGuard);

  function topicSnapshotOf(topics) {
    return (Array.isArray(topics) ? topics : []).map((t) => ({
      key: String(t?.key ?? ""),
      group: Array.isArray(t?.group) ? t.group : [],
    }));
  }

  /**
   * 悬空引用清单（0.4 收尾）：挂载里指向不存在组的条目，形如 [{topicKey, group}]，
   * 按 (topicKey, group) 对去重，顺序随 topic 遍历序。list 与 repair 共用一套口径。
   */
  function danglingPairsOf(snapshot, known) {
    const dangling = [];
    for (const t of snapshot) {
      const seen = new Set();
      for (const g of t.group) {
        if (typeof g !== "string" || g.length === 0 || known.has(g) || seen.has(g)) continue;
        seen.add(g);
        dangling.push({ topicKey: t.key, group: g });
      }
    }
    return dangling;
  }

  async function readGroupsOrEmpty() {
    try {
      return await readGroups({ dataRoot, scopeId });
    } catch (error) {
      if (error?.code === "NOT_FOUND") {
        // 组清单缺失：等价「无任何组」（默认模板由宿主激活路径负责初始化，
        // 这里不静默初始化——读路径绝不写盘）。
        return { revision: null, data: { version: 1, groups: [] } };
      }
      throw error;
    }
  }

  return {
    name: "group_manage",
    description: "Manage topic groups for the current scope: list groups (with per-group topic counts and the dangling field reporting topic.group entries that point at groups no longer in the list), create/update group metadata (key/title/summary/order), delete a group, or repair dangling references. Create a group once topics naturally cluster: grouping early keeps L1 readable and stops related memories from piling up ungrouped. Deleting a non-empty group requires migrateTo: the topic re-mounts and the group-entry deletion are committed together as ONE atomic store transaction (same journal, all-or-nothing); if a topic is mounted into the dying group concurrently during the commit, the whole delete is rejected with nothing applied — rerun the delete and the new member is migrated too, so no dangling keys are left for repair to clean. A service that predates the groups transaction field falls back to the legacy two-step flow: the group's topics are re-grouped in one commit first, and the group entry is removed afterwards as a second, separate step; if that second step hits a revision conflict after the migration already committed, the revision is re-read and the entry deletion is retried once automatically (never a second migration); if that retry also fails, the error is rethrown annotated with the fact that the migration already took effect (rerunning is not guaranteed to be idempotent), and a topic newly attached between the two steps may be left with a dangling key — action=repair removes exactly those dangling references and reports cleaned/remaining (one CAS'd mutate commit with operationId; cleaned counts only pairs actually removed at write time; valid groups and card bodies untouched; refused with INVALID_STATE when the group list is empty but topics carry mounts, to avoid wiping every mount). repair re-reads the group list right before committing, but that recheck is NOT atomic with the mutate: a group created in the window right after the recheck can still make a fresh mount removable — this residual window is reported as-is, not closed. If the post-commit re-read fails, the result still reports cleaned plus a warning and omits remaining rather than inventing a value. Groups are per-scope and referenced from topic front-matter; a topic's first group is its primary group (soft limit: 3 groups per topic, more only yields a warning).",
    inputSchema: {
      action: { type: "string", required: true, description: "One of: list, create, update, delete, repair." },
      key: { type: "string", description: "Group key (create/update/delete)." },
      title: { type: "string", description: "Group title (required for create; optional for update)." },
      summary: { type: "string", description: "Group summary (required for create; optional for update)." },
      order: { type: "number", description: "Sort order (required for create; optional for update)." },
      migrateTo: { type: "string", description: "delete: move this group's topics into an existing group; required when the group is not empty." },
      operationId: { type: "string", description: "Idempotency key; reuse it verbatim on retry." },
    },
    outputSchema: TOOL_OUTPUT_SCHEMAS["group_manage"],
    outputRender: renderToolOutput,
    async execute(args) {
      const a = requireObject(args);
      rejectScope(a);
      const action = requireString(a, "action");
      if (action === "list") {
        // 读序约束（0.4 收尾，交叉审查必修 1）：必须先读 topic 快照、后读组清单。
        // 组可见性本身保证了挂载发生在建组之后——若某个组在这两次读之间被建出、
        // topic 随即挂上它，后读的 groups 必然看得到该组；反序（先 groups 定格
        // known、后读 topics）会把这条件正当挂载误判成悬空引用。
        const snapshot = topicSnapshotOf(await service.listTopics());
        const { revision, data } = await readGroupsOrEmpty();
        // 主组口径（0.4 审查 P0#2，用户 2026-11-14 拍板）：一个 topic 可以挂多组，
        // 但计数只认主组 t.group[0]，多组 topic 不在非主组重复计数——否则组行计数
        // 总和会虚高，且与面板成员列表（row.group[0] === key）口径不一致。
        // 主组判据收紧（0.4 收尾）：稀疏数组空洞让 group[0] 取出 undefined，
        // 旧判据 primary !== null 放行 undefined，计数表混进 undefined 键——
        // 改为「非空字符串」才算合法主组。
        const counts = new Map();
        // 悬空引用检测（0.4 收尾）：挂载指向不存在组的条目。删除组的「迁移成员 +
        // CAS 删组」是两步提交，并发窗口会留下「卡片指向已不存在的组」——list
        // 把它们显式暴露出来（按 topicKey+group 去重），repair 负责清理。
        const known = new Set(data.groups.map((g) => g.key));
        for (const t of snapshot) {
          const primary = t.group.length > 0 ? t.group[0] : null;
          if (typeof primary === "string" && primary.length > 0) {
            counts.set(primary, (counts.get(primary) ?? 0) + 1);
          }
        }
        const dangling = danglingPairsOf(snapshot, known);
        return {
          scope: scopeId,
          action,
          revision,
          groups: data.groups.map((g) => ({ ...g, topics: counts.get(g.key) ?? 0 })),
          dangling,
        };
      }
      // 以下三个 action 都是写：只读态直接拒绝（与既有写工具同一守卫）。
      assertNotHostLocked(readonlyGuard);
      const operationId = typeof a.operationId === "string" && a.operationId.length > 0 ? a.operationId : randomUUID();
      if (action === "create") {
        const entry = validateGroupEntry({
          key: requireString(a, "key"),
          title: requireString(a, "title"),
          summary: optionalString(a, "summary") ?? "",
          order: a.order,
        }, "group_manage.create");
        const { revision, data } = await readGroupsOrEmpty();
        if (data.groups.some((g) => g.key === entry.key)) {
          throw INVALID_INPUT(
            `group_manage: group "${entry.key}" already exists (use action=update to change its metadata)`,
            { key: entry.key, known: data.groups.map((g) => g.key) },
          );
        }
        const written = await writeGroups({
          dataRoot, scopeId, groups: [...data.groups, entry], expectedRevision: revision,
        });
        return { scope: scopeId, action, key: entry.key, created: true, revision: written.revision };
      }
      if (action === "update") {
        const key = requireString(a, "key");
        const { revision, data } = await readGroupsOrEmpty();
        const existing = data.groups.find((g) => g.key === key);
        if (!existing) {
          throw INVALID_INPUT(
            `group_manage: group "${key}" does not exist（现有组: ${data.groups.map((g) => g.key).join(", ") || "无"}）`,
            { key, known: data.groups.map((g) => g.key) },
          );
        }
        const title = optionalString(a, "title") ?? existing.title;
        const summary = optionalString(a, "summary") ?? existing.summary;
        const order = a.order === undefined ? existing.order : a.order;
        const entry = validateGroupEntry({ key, title, summary, order }, "group_manage.update");
        const next = data.groups.map((g) => (g.key === key ? entry : g));
        const written = await writeGroups({
          dataRoot, scopeId, groups: next, expectedRevision: revision,
        });
        return { scope: scopeId, action, key, updated: true, revision: written.revision };
      }
      if (action === "delete") {
        const key = requireString(a, "key");
        const migrateTo = optionalString(a, "migrateTo");
        const { revision, data } = await readGroupsOrEmpty();
        if (!data.groups.some((g) => g.key === key)) {
          throw INVALID_INPUT(
            `group_manage: group "${key}" does not exist（现有组: ${data.groups.map((g) => g.key).join(", ") || "无"}）`,
            { key, known: data.groups.map((g) => g.key) },
          );
        }
        if (migrateTo !== undefined) {
          if (migrateTo === key) {
            throw INVALID_INPUT("group_manage: migrateTo 不能等于被删除的组 key", { key, migrateTo });
          }
          if (!data.groups.some((g) => g.key === migrateTo)) {
            throw INVALID_INPUT(
              `group_manage: migrateTo 指向的组 "${migrateTo}" 不存在，请先建组`
              + `（现有组: ${data.groups.map((g) => g.key).join(", ") || "无"}）`,
              { key, migrateTo, known: data.groups.map((g) => g.key) },
            );
          }
        }
        // 成员判定用当前可见 topic 快照（组已存在，读到的 group 都可对照清单）。
        const snapshot = topicSnapshotOf(await service.listTopics());
        const members = snapshot.filter((t) => t.group.includes(key)).map((t) => t.key);
        if (members.length > 0 && migrateTo === undefined) {
          throw INVALID_STATE(
            `group_manage: 组 "${key}" 内仍有 ${members.length} 个 topic（${members.join(", ")}），拒绝删除；`
            + "请提供 migrateTo 指定迁移目标组，或先把组内 topic 迁出",
            { key, members },
          );
        }
        let migrated = [];
        if (members.length > 0) {
          // 同一提交里完成全部组内 topic 的改挂（此刻组仍在清单里，中途失败
          // 组与成员关系原样保留，绝不留悬空 key）。
          const plan = planGroupMigration(snapshot, key, migrateTo);
          const changes = [];
          for (const item of plan) {
            const current = await service.readTopic(item.topicKey);
            changes.push({
              kind: "topic",
              key: item.topicKey,
              expectedRevision: current.revision,
              text: current.body ?? "",
              topic: { title: current.title, summary: current.summary, group: item.group },
            });
          }
          // P2#12b 删组单事务（0.5-1A）：成员重挂（changes）与组条目删除（groups
          // 字段，expectedRevision 取本 action 开头的清单读取）放进同一次 mutate。
          // 认识该字段的 service（src/service/index.mjs 已透传）把它转成 store
          // 提交协议里的 groups 条目，与 topic 改挂同一 journal/staging/原子替换/
          // 崩溃恢复事务：失败整体回滚，不存在「迁移已提交、删组失败」的半迁移；
          // 提交期候选复核发现并发新挂成员时整体拒绝（任何时刻无悬空 key），重跑
          // 会把新成员一并纳入迁移计划。不认识该字段的 service（测试 fake / 旧实现）
          // 会静默丢弃 groups——回执里没有 groups 条目即为信号，走下方回退两步路径。
          // 单事务提交失败 = 什么都没发生（原子回滚），错误原样上抛，不再需要
          // 「迁移已生效」的补救注解。
          const singleReceipt = await service.mutate({
            operationId,
            changes,
            groups: {
              expectedRevision: revision,
              groups: data.groups.filter((g) => g.key !== key),
            },
          });
          const appliedGroups = (singleReceipt?.changes ?? []).find((c) => c?.kind === "groups");
          if (appliedGroups) {
            // 单事务完成：回执里的 groups 条目即删组凭证（afterRevision 为删组后
            // 清单哈希），无需任何回退步骤。
            return {
              scope: scopeId,
              action,
              key,
              deleted: true,
              migrated: plan,
              revision: appliedGroups.afterRevision,
            };
          }
          migrated = plan;
        }
        // 回退路径（P2#12b）：service 丢弃了 groups 字段（测试 fake / 旧实现）——
        // topic 改挂已生效、组条目还在。以下为 0.4 收尾版的两步删除 + 自愈，原样保留：
        // 组条目删除（CAS：revision 取本 action 开头的清单读取；topic 迁移不改
        // groups.json，CAS 仍成立）。postSnapshot 的读取也放进 try：迁移已提交后
        // 若这里 listTopics 读失败，同样属于「迁移已生效但收尾失败」，必须走下面的
        // 注解分支，不能让裸错误无说明上抛（review a3 项 2）。
        let postSnapshot;
        let deleted;
        try {
          postSnapshot = topicSnapshotOf(await service.listTopics());
          deleted = await deleteGroup({
            dataRoot, scopeId, key, migrateTo, topics: postSnapshot, expectedRevision: revision,
          });
        } catch (error) {
          // 迁移提交与组条目删除之间存在并发窗口：topic 改挂已经生效、只是
          // groups.json 被并发改动导致 CAS 失败。此时自愈（0.4 收尾）：重读清单
          // revision 补删组条目一次——重试只走 deleteGroup、不带迁移语义，绝不
          // 二次迁移。不变量：重试只做一次、绝不循环。
          // 只要迁移过 topic，任何最终错误（首试的非 CAS 错误、重试的任何错误）都要
          // 交代迁移后果：目标组恰在窗口内被删时，内部预检抛的是 INVALID_INPUT
          //（"migrateTo 不存在"）；groups.json 被整个删掉时首试抛 NOT_FOUND——调用方
          // 都看不出迁移已经生效。文案不承诺重跑幂等。
          if (error?.code === "REVISION_CONFLICT" && migrated.length > 0) {
            try {
              const fresh = await readGroupsOrEmpty();
              deleted = await deleteGroup({
                dataRoot, scopeId, key, migrateTo, topics: postSnapshot, expectedRevision: fresh.revision,
              });
            } catch (retryError) {
              throw noteMigrationTookEffect(retryError, { key, migrateTo, retried: true });
            }
          } else {
            if (migrated.length > 0) {
              noteMigrationTookEffect(error, { key, migrateTo, retried: false });
            }
            throw error;
          }
        }
        return { scope: scopeId, action, key, deleted: true, migrated, revision: deleted.revision };
      }
      if (action === "repair") {
        // 悬空引用自愈（0.4 收尾，命名口径经评审 amber-review-04 拍板）：只清
        // topic.group 里指向不存在组的条目，有效挂载与卡片正文原样保留；走
        // service.mutate 单提交（CAS + operationId，与迁移同一提交协议）。
        // 返回 cleaned（清理条数，按 topicKey+group 对计数）与 remaining
        // （清理后重读快照再算的剩余悬空条数，正常路径为 0）。
        // 读序约束（同必修 1）：先 topics 后 groups——组可见即说明挂载发生在建组
        // 之后，后读的 known 必然包含它；反序会把两次读之间新建组的合法挂载当成
        // 悬空引用静默摘掉。
        const snapshot = topicSnapshotOf(await service.listTopics());
        const { revision, data } = await readGroupsOrEmpty();
        const known = new Set(data.groups.map((g) => g.key));
        // 清单缺失/为空（readGroupsOrEmpty 的兜底）时，known 为空会把每条挂载都
        // 判成悬空、一次 mutate 全摘——这不是修复，是把用户数据清空。拒绝并要求
        // 先用 group_manage action=create 初始化组清单（宿主激活路径也会写默认模板）。提交前复核
        // 读到空清单时同样适用。
        const assertNotWipingAll = (knownSet) => {
          if (knownSet.size === 0 && snapshot.some((t) => t.group.length > 0)) {
            throw INVALID_STATE(
              "group_manage: 组清单为空或缺失（groups.json 尚未初始化），拒绝 repair——"
              + "会把全部 topic 挂载当作悬空引用清空；请先用 group_manage action=create 初始化组清单",
              { scope: scopeId, mountedTopics: snapshot.filter((t) => t.group.length > 0).map((t) => t.key) },
            );
          }
        };
        assertNotWipingAll(known);
        const dangling = danglingPairsOf(snapshot, known);
        if (dangling.length === 0) {
          // 无悬空引用：空修复不触写路径（重放幂等）。
          return { scope: scopeId, action, cleaned: 0, remaining: 0, revision };
        }
        const ghostsOf = (pairs) => {
          const map = new Map();
          for (const { topicKey, group } of pairs) {
            if (!map.has(topicKey)) map.set(topicKey, new Set());
            map.get(topicKey).add(group);
          }
          return map;
        };
        const buildChanges = async (ghostsByTopic) => {
          const changes = [];
          let removed = 0;
          for (const [topicKey, ghosts] of ghostsByTopic) {
            const current = await service.readTopic(topicKey);
            const currentGroup = Array.isArray(current.group) ? current.group : [];
            // cleaned 按实际摘除的 (topicKey, group) 对数累加（review a3 项 5）：
            // 悬空判定基于较早快照，读改写时该挂载可能已被别处摘掉——只数本次
            // 真正移除的条目，避免高报。
            const present = new Set(currentGroup.filter((g) => typeof g === "string" && ghosts.has(g)));
            removed += present.size;
            changes.push({
              kind: "topic",
              key: topicKey,
              expectedRevision: current.revision,
              text: current.body ?? "",
              topic: {
                title: current.title,
                summary: current.summary,
                // 只摘除悬空引用：字符串挂载里指向不存在组的条目，其余原样保留。
                group: currentGroup.filter((g) => !(typeof g === "string" && ghosts.has(g))),
              },
            });
          }
          return { changes, removed };
        };
        let { changes, removed } = await buildChanges(ghostsOf(dangling));
        let cleaned = removed;
        let commitRevision = revision;
        // 空提交拦截（review a3 项 2）：buildChanges 会按最新 revision 重读 topic，
        // 快照里判成悬空的挂载可能已被别处摘掉——removed 为 0 说明本次 changes 不会
        // 真正改动任何 topic.group，mutate 只是白涨 groups.json 的 revision。既然已
        // 无实际变更，直接按空修复返回（与顶部「无悬空」分支同构），不触写。
        if (removed === 0) {
          return { scope: scopeId, action, cleaned: 0, remaining: 0, revision };
        }
        // 提交前复核（0.4 收尾必修 2）：从读清单到 mutate 之间若有人建组修好了
        // 这些悬空，本次 mutate 会把刚修好的挂载再摘一次。revision 变了就按新
        // 清单重算悬空：已不再悬空则不触写、按空修复返回。
        // 边界（review a3 项 6）：复核与 mutate 无法原子化——复核后到提交前若又
        // 有人新建组，仍可能摘掉一条刚变合法的挂载；该残余窗口如实告知，不在此处
        // 再叠一轮读写（跨文件单事务超出本单范围）。
        const approval = await readGroupsOrEmpty();
        if (approval.revision !== revision) {
          const freshKnown = new Set(approval.data.groups.map((g) => g.key));
          assertNotWipingAll(freshKnown);
          const freshDangling = danglingPairsOf(snapshot, freshKnown);
          if (freshDangling.length === 0) {
            // 窗口内悬空已被别处修好：不触写，空修复返回（cleaned 0）。
            return { scope: scopeId, action, cleaned: 0, remaining: 0, revision: approval.revision };
          }
          const rebuilt = await buildChanges(ghostsOf(freshDangling));
          changes = rebuilt.changes;
          cleaned = rebuilt.removed;
          commitRevision = approval.revision;
          // 同「空提交拦截」：复核后重读的 topic 已没有可摘条目时，不触写。
          if (rebuilt.removed === 0) {
            return { scope: scopeId, action, cleaned: 0, remaining: 0, revision: approval.revision };
          }
        }
        await service.mutate({ operationId, changes });
        // remaining 如实重算（必修 3）：提交后先重读 topics、再读 groups（读序约束），
        // 用提交后的最新清单算剩余悬空——提交期间某组被删时不会少算残余。
        // revision 与 remaining 同源（review a3 项 4）：都取提交后重读的清单快照。
        // 重读失败时已提交的 cleaned 不能吞掉（review a3 项 3）：返回 cleaned 与
        // warning，remaining 无从计算就不给（绝不臆造数值）。
        try {
          const afterSnapshot = topicSnapshotOf(await service.listTopics());
          const afterGroups = await readGroupsOrEmpty();
          const afterKnown = new Set(afterGroups.data.groups.map((g) => g.key));
          const remaining = danglingPairsOf(afterSnapshot, afterKnown).length;
          return { scope: scopeId, action, cleaned, remaining, revision: afterGroups.revision };
        } catch (error) {
          return {
            scope: scopeId,
            action,
            cleaned,
            revision: commitRevision,
            warning: `repair 已提交（cleaned=${cleaned}），但提交后重读快照失败（${error?.code ?? "未知错误"}）：`
              + "remaining 无法计算，请重新执行 group_manage list 核对剩余悬空引用",
          };
        }
      }
      throw INVALID_INPUT(
        `group_manage: action 必须是 list / create / update / delete / repair，收到 "${action}"`,
        { action },
      );
    },
  };
}
