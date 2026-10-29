// Shiori P5-PLUGIN · 可信 scope 解析、settings 校验与身份固定（slot P）。
//
// 边界（CONTRACTS §2/§3）：
// - settings 由 Q 归一化后传入，P 在此完整再校验（未知键拒绝；路径/预算/映射复核）；
// - scope 只能从可信证据解析：工具 exec.agent.session.id、waterfall/pres-step 的
//   agent、RPC trustedContext 的宿主资源引用。payload 中的 ownerId/scopeId/persona/
//   authorize/root 一律拒绝；
// - 可信会话选卡：sessionPersonas 精确匹配 → workspacePersonas 规范路径最长匹配
//   （仅匹配路径边界）→ defaultPersona；persona null = global memory（scopeId 'global'）；
// - 每次 resolveScope 返回冻结的 {sessionId, scopeId, ownerId, generation}，
//   跨 await 不得改写请求目标；
// - 单用户本地 profile 是本批安全边界：多用户身份不可信时拒绝，不默认共享。

import path from "node:path";
import { validateConfig } from "../core/index.mjs";
import { normalizeForgetPolicy } from "../forgetting/decay.mjs";
import { GLOBAL_SCOPE_ID } from "../core/topics.mjs";

/** persona 为 null（无卡）时的 scopeId：global memory。 */
export { GLOBAL_SCOPE_ID as NULL_PERSONA_SCOPE };

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

const isPlainRecord = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** settings 顶层键（与冻结契约 §2 完全一致；未知键拒绝）。 */
const SETTINGS_KEYS = [
  "mode", "allowActive", "dataRoot", "stateRoot", "ownerId",
  "defaultPersona", "sessionPersonas", "workspacePersonas",
  "budgets", "l2", "organize", "forgetting",
];

/** 绝对路径校验（不要求目录已存在；越界判定在 validateRoots）。 */
function requireAbsoluteRoot(value, field) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    fail("INVALID_INPUT", `settings.${field} must be an absolute path when provided`, {
      field, received: typeof value,
    });
  }
  return value;
}

function requirePersonaName(value, field) {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    fail("INVALID_INPUT", `settings.${field} must be a non-empty persona name or null`, { field });
  }
  return value;
}

function validateMappings(value, field, keyField) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    fail("INVALID_INPUT", `settings.${field} must be an array`, { field });
  }
  return value.map((entry, index) => {
    if (!isPlainRecord(entry)) {
      fail("INVALID_INPUT", `settings.${field}[${index}] must be an object`, { field, index });
    }
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes(keyField) || !keys.includes("persona")) {
      fail("INVALID_INPUT", `settings.${field}[${index}] must have exactly {${keyField}, persona}`, {
        field, index, keys,
      });
    }
    const key = entry[keyField];
    if (typeof key !== "string" || key.trim().length === 0) {
      fail("INVALID_INPUT", `settings.${field}[${index}].${keyField} must be a non-empty string`, { field, index });
    }
    return { [keyField]: key, persona: requirePersonaName(entry.persona, `${field}[${index}].persona`) };
  });
}

function validateModuleSwitch(value, field) {
  if (value === undefined) {
    // forgetting 缺省也带默认策略（30/240/.25）：供执行门面直接消费。
    return field === "forgetting"
      ? { enabled: false, policy: normalizeForgetPolicy({}) }
      : { enabled: false };
  }
  if (!isPlainRecord(value) || !Object.hasOwn(value, "enabled") || typeof value.enabled !== "boolean") {
    fail("INVALID_INPUT", `settings.${field}.enabled must be a boolean`, { field });
  }
  const keys = Object.keys(value);
  const allowed = field === "forgetting" ? ["enabled", "policy"] : ["enabled"];
  for (const key of keys) {
    if (!allowed.includes(key)) {
      fail("INVALID_INPUT", `settings.${field} has unknown property "${key}"`, { field, key });
    }
  }
  const result = { enabled: value.enabled };
  if (field === "forgetting") {
    try {
      result.policy = normalizeForgetPolicy(value.policy ?? {});
    } catch (error) {
      fail("INVALID_INPUT", `settings.forgetting.policy invalid: ${error instanceof Error ? error.message : String(error)}`, {});
    }
  }
  return result;
}

/**
 * P 侧 settings 完整校验（Q 归一化后再核验；防御直接构造的 settings）。
 * 通过返回冻结的规范化 settings；不修改输入。
 */
export function validateControllerSettings(raw) {
  if (!isPlainRecord(raw)) {
    fail("INVALID_INPUT", "settings must be a plain object", { received: typeof raw });
  }
  for (const key of Object.keys(raw)) {
    if (!SETTINGS_KEYS.includes(key)) {
      fail("INVALID_INPUT", `settings has unknown property "${key}"`, { key });
    }
  }

  const mode = raw.mode ?? "shadow";
  if (mode !== "shadow" && mode !== "active") {
    fail("INVALID_INPUT", `settings.mode must be "shadow" or "active", got ${JSON.stringify(mode)}`, {});
  }
  const allowActive = raw.allowActive ?? false;
  if (typeof allowActive !== "boolean") {
    fail("INVALID_INPUT", "settings.allowActive must be a boolean", {});
  }
  if (mode === "active" && allowActive !== true) {
    fail("INVALID_INPUT", 'active mode requires settings.allowActive === true', {});
  }

  const dataRoot = raw.dataRoot ?? null;
  const stateRoot = raw.stateRoot ?? null;
  if (dataRoot !== null) requireAbsoluteRoot(dataRoot, "dataRoot");
  if (stateRoot !== null) requireAbsoluteRoot(stateRoot, "stateRoot");
  if ((dataRoot === null) !== (stateRoot === null)) {
    fail("INVALID_INPUT",
      "settings.dataRoot and settings.stateRoot must both be provided or both be null "
      + "(active, or any configured root, requires both explicit absolute roots)", {});
  }
  if (dataRoot !== null && mode !== "active") {
    // shadow 配置了 root：允许只读预览挂载（诊断可见），但必须显式知道这是 shadow。
    if (allowActive !== false) fail("INVALID_INPUT", "shadow mode must have allowActive === false", {});
  }

  const ownerId = raw.ownerId ?? "local";
  if (typeof ownerId !== "string" || ownerId.trim().length === 0) {
    fail("INVALID_INPUT", "settings.ownerId must be a non-empty string", {});
  }

  const defaultPersona = requirePersonaName(raw.defaultPersona ?? null, "defaultPersona");
  const sessionPersonas = validateMappings(raw.sessionPersonas, "sessionPersonas", "sessionId");
  const workspacePersonas = validateMappings(raw.workspacePersonas, "workspacePersonas", "workspace");
  for (const entry of workspacePersonas) {
    requireAbsoluteRoot(entry.workspace, "workspacePersonas[].workspace");
  }

  // 预算：完整由 validateConfig 验证；并强制 Q 生产安全上限（可向下调）。
  const budgetsRaw = raw.budgets ?? {};
  if (!isPlainRecord(budgetsRaw)) {
    fail("INVALID_INPUT", "settings.budgets must be a plain object", {});
  }
  let budgets;
  try {
    budgets = validateConfig(budgetsRaw);
  } catch (error) {
    fail("INVALID_INPUT", `settings.budgets invalid: ${error instanceof Error ? error.message : String(error)}`, {});
  }
  const caps = [
    // 与 src/plugin/config.mjs BUDGET_CEILINGS.persona.maxChars 保持一致（公开插件，
    // 长人设卡用户需要更高的上限；默认值仍由 DEFAULT_CONFIG 给 12000）。
    ["persona", "maxChars", 60000],
    ["spark", "maxChars", 600],
    ["spark", "inlineMaxChars", 100],
    ["spark", "maxCards", 5],
    ["spark", "seedCount", 3],
    ["spark", "linkCount", 2],
  ];
  for (const [section, field, cap] of caps) {
    if (budgets[section][field] > cap) {
      fail("INVALID_INPUT", `settings.budgets.${section}.${field} (${budgets[section][field]}) exceeds the production safety cap ${cap}`, {
        section, field, cap,
      });
    }
  }

  const l2 = validateModuleSwitch(raw.l2, "l2");
  const organize = validateModuleSwitch(raw.organize, "organize");
  const forgetting = validateModuleSwitch(raw.forgetting, "forgetting");

  return Object.freeze({
    mode,
    allowActive,
    dataRoot,
    stateRoot,
    ownerId,
    defaultPersona,
    sessionPersonas: Object.freeze(sessionPersonas.map((e) => Object.freeze(e))),
    workspacePersonas: Object.freeze(workspacePersonas.map((e) => Object.freeze(e))),
    budgets,
    l2: Object.freeze(l2),
    organize: Object.freeze(organize),
    forgetting: Object.freeze(forgetting),
  });
}

/** 折叠路径用于比较（Windows 大小写不敏感）。 */
const foldPath = process.platform === "win32"
  ? (p) => path.resolve(p).toLowerCase()
  : (p) => path.resolve(p);

/**
 * 可信会话选卡：sessionPersonas 精确 → workspace 最长前缀（仅路径边界）→ defaultPersona。
 * persona null = global memory。无任何匹配且 defaultPersona 为 null → scopeId 'global'。
 */
export function personaForSession(settings, { sessionId, workspace } = {}) {
  if (sessionId !== undefined && sessionId !== null) {
    const hit = settings.sessionPersonas.find((e) => e.sessionId === sessionId);
    if (hit !== undefined) return hit.persona;
  }
  if (workspace !== undefined && workspace !== null) {
    const ws = foldPath(workspace);
    let best = null;
    let bestLen = -1;
    for (const entry of settings.workspacePersonas) {
      const base = foldPath(entry.workspace);
      const boundary = ws === base || ws.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
      if (boundary && base.length > bestLen) {
        best = entry;
        bestLen = base.length;
      }
    }
    if (best !== null) return best.persona;
  }
  return settings.defaultPersona;
}

/** persona 名 → scopeId（null persona → global）。 */
export function scopeIdForPersona(persona) {
  return persona === null ? GLOBAL_SCOPE_ID : persona;
}

/**
 * 拒绝 payload 中的危险身份字段：模型/客户端永远不能传 ownerId/scopeId/
 * persona/authorize/root 定位 scope（出现即拒绝，即便值恰好等于可信值）。
 */
export function rejectIdentityFields(payload, where) {
  if (!isPlainRecord(payload)) {
    fail("INVALID_INPUT", `${where}: payload must be a plain object`, { where });
  }
  const dangerous = ["ownerId", "scopeId", "scope", "persona", "authorize", "root", "trustedContext"];
  for (const key of dangerous) {
    if (Object.hasOwn(payload, key)) {
      fail("INVALID_INPUT", `${where}: dangerous identity field "${key}" cannot be passed in payloads; `
        + "identity is resolved from trusted host evidence only", { where, key });
    }
  }
  return payload;
}

/**
 * 从可信证据固定一次请求的 scope 身份。返回冻结对象；跨 await 使用同一对象，
 * 不得重新解析或改写。
 *
 * @param {object} args
 * @param {object} args.settings 已校验 settings
 * @param {string} args.sessionId 可信会话 id（宿主资源；非 wire 参数）
 * @param {string} [args.workspace] 可信工作区（宿主证据）
 * @param {number} args.generation controller 启动代际
 * @param {string} args.source 'tool-exec' | 'assemble' | 'pre-step' | 'panel-rpc'
 */
export function pinScope({ settings, sessionId, workspace, generation, source }) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("INVALID_INPUT", "pinScope requires a trusted non-empty sessionId (host resource)", { source });
  }
  if (!Number.isInteger(generation) || generation < 0) {
    fail("INVALID_INPUT", "pinScope requires a non-negative integer generation", { source });
  }
  const persona = personaForSession(settings, { sessionId, workspace });
  return Object.freeze({
    sessionId,
    workspace: workspace ?? null,
    persona,
    scopeId: scopeIdForPersona(persona),
    ownerId: settings.ownerId,
    generation,
    source,
    fixedAt: Object.freeze(new Date()),
  });
}

/**
 * 从工具 exec 提取可信会话证据（dsh-native.js:131 同款：exec.agent.session.id）。
 * exec 无 agent/session → INVALID_INPUT（不猜、不回落上一个会话）。
 */
export function sessionEvidenceFromExec(exec) {
  const sessionId = exec?.agent?.session?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("INVALID_INPUT", "tool execution lacks trusted session evidence (exec.agent.session.id)", {});
  }
  return { sessionId, agent: exec.agent };
}

/**
 * 从 assemble/pre-step 的 agent 提取可信会话证据。
 */
export function sessionEvidenceFromAgent(agent) {
  const sessionId = agent?.session?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null; // 诊断装配等无 agent 场景：调用方不读业务
  }
  return { sessionId, agent };
}

/**
 * 从 RPC trustedContext 提取可信会话证据。
 * trustedContext 必须是服务端绑定的宿主资源 {agent, session, principal, source, signal}；
 * payload 永不携带 trustedContext（rejectIdentityFields 已在 wire 层拒绝）。
 * principal 校验由 Q 的 resolver 完成；P 只再核验会话证据存在。
 */
export function sessionEvidenceFromRpc(trustedContext) {
  if (!isPlainRecord(trustedContext)) {
    fail("INVALID_INPUT", "trustedContext must be a server-bound resource object", {});
  }
  const sessionId = trustedContext.session?.id ?? trustedContext.agent?.session?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    fail("INVALID_INPUT", "trustedContext lacks trusted session identity (session.id / agent.session.id)", {});
  }
  if (trustedContext.source !== "panel-rpc") {
    fail("INVALID_INPUT", `trustedContext.source must be "panel-rpc", got ${JSON.stringify(trustedContext.source)}`, {});
  }
  return { sessionId, agent: trustedContext.agent ?? null, principal: trustedContext.principal ?? null };
}
