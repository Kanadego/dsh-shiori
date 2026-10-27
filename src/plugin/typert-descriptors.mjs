// Shiori P5-PLUGIN · Gateway 严格 codec 描述符（slot P；P-C）。
//
// 职责：为本插件九个管理方法手写严格 typert invocation 描述符，经
// `ctx.typert.register(...)` 注册进宿主 dsh-typert-registry——Gateway 的
// resolveDescriptor 优先取 `ctx.typert.local.get(endpoint)` 的严格定义
// （dsh-api-gateway lib/index.js:1224-1228），取不到才回退 SRC。
//
// 语义取舍（如实）：
// - payload 参数的 parse 为恒等函数。原因：gateway 的 decode() 会把 codec
//   parse 抛错统一包装成 TypertGatewayError("gateway/input-invalid")，其码
//   原样过线（TypertGatewayError extends RemoteError）——若在此重复校验，
//   真机已验证的「无效 payload 返回 INVALID_INPUT」契约会被改变。业务校验
//   仍由 service 层 protocol.mjs 独家执行（单一权威、错误码不变）。严格
//   描述符的价值在端点面锁定（endpoint 唯一、参数 wire 绑定、cancellation
//   语义、result JSON 安全网），不在参数语义收窄。
// - session 参数为 lookup 源（宿主 dsh-session 注 wire symbol
//   "@deepseek-ai/dsh-session/types#SessionId"）：lookup 值不过 decode，
//   codec 仅参与 provider-mismatch 核验。注册前核验 provider 的
//   wireTypeSymbol 逐字匹配，不匹配即回退 SRC（宿主版本漂移时优雅降级）。
// - result codec 的 encode 做深 JSON 安全检（镜像 gateway assertJsonValue
//   约束）后原样返回——DTO 从不含字节，故无 SRC 路径的 bytes→attachments
//   分支，线上形状不变。
// - 注册失败绝不抛出：typert 服务的获取走 readOptionalCordisService（B-P2：
//   真实宿主 Cordis 对未 inject 服务的属性访问会直接抛
//   `cannot get property "typert" without inject`，插件入口 index.mjs 的
//   inject 只有 tools/systemPrompt——属性访问在取值第一行就把进程级 apply
//   打挂；ctx.get(name) 对未注册/未 inject 服务返回 undefined、不抛），
//   controller.start 的调用点另有 try/catch 兜底。任何失败都回退现状
//   {codec:'src', reason}。重复注册（上一代未干净 withdraw）时若现存描述符
//   与本次逐字节一致则沿用（adopt；无 disposer、不 withdraw），否则回退 SRC。
// - withdraw 语义：disposer 由 stop 显式调用；插件 fiber 崩溃未走 stop 时
//   描述符残留至 DSH 进程结束（registry 为进程内存态），下代注册走 adopt。
//   stop→再启窗口内 gateway 对这些端点报 definition-unavailable（与「服务
//   不在场」同窗，见 REPORT 残留窗口）。

import { MANAGEMENT_METHODS } from "./protocol.mjs";

export const SHIORI_TYPERT_PACKAGE = "dsh-shiori-panel";
export const SHIORI_RPC_NAMESPACE = "shiori";
export const SHIORI_RPC_SERVICE_KEY = "shiori.panel";

/** 宿主 dsh-session lookup provider 的 wire symbol（dsh-session lib/index.js:1741-1748）。 */
const SESSION_WIRE_TYPE_SYMBOL = "@deepseek-ai/dsh-session/types#SessionId";

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

/**
 * Cordis 服务可选读取（B-P2 修法，owner 处方）。真实宿主里插件 fiber 对未
 * inject 的服务做属性访问会直接抛 `cannot get property "X" without inject`
 * （Cordis inject 门控，fake ctx 与根级 Context 无此行为），因此服务一律走：
 * 先 ctx.get(name)（未注册/未 inject 返回 undefined、不抛），get 不可用或
 * 返回 undefined 时兜底属性访问（兼容只暴露属性形态的 fake ctx；属性访问
 * 抛错同样捕获为 undefined）。两个分支都不向外抛。
 */
export function readOptionalCordisService(ctx, name) {
  if (ctx === null || typeof ctx !== "object") return undefined;
  try {
    if (typeof ctx.get === "function") {
      const viaGet = ctx.get(name);
      if (viaGet !== undefined) return viaGet;
    }
  } catch { /* get 抛错按缺席处理 */ }
  try {
    return ctx[name];
  } catch {
    return undefined;
  }
}

/**
 * 深度 JSON 安全检（镜像 dsh-api-gateway assertJsonValue 的约束：有限数字、
 * 非稀疏数组、plain object、无 symbol 属性、无环）。encode 失败即抛——
 * 与 SRC 路径 encodeRuntimeResult 的失败面一致（同为 gateway/internal）。
 */
function assertJsonSafe(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    fail("INVALID_STATE", "non-finite number is not JSON-safe", {});
  }
  if (typeof value !== "object") {
    fail("INVALID_STATE", `${typeof value} is not JSON-safe`, {});
  }
  if (ancestors.has(value)) fail("INVALID_STATE", "cyclic value is not JSON-safe", {});
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0 || Object.keys(value).length !== value.length) {
        fail("INVALID_STATE", "sparse or decorated array is not JSON-safe", {});
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) fail("INVALID_STATE", "sparse array is not JSON-safe", {});
        assertJsonSafe(value[index], ancestors);
      }
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      fail("INVALID_STATE", "non-plain object is not JSON-safe", {});
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail("INVALID_STATE", "symbol property is not JSON-safe", {});
    }
    for (const key of Object.keys(value)) assertJsonSafe(value[key], ancestors);
  } finally {
    ancestors.delete(value);
  }
}

/** 恒等 parse（见文件头「语义取舍」）；create 满足 validateCodec 的工厂要求。 */
const identityParse = () => ({ parse: (value) => value });

function payloadCodec(method) {
  return {
    mode: "strict",
    typeSymbol: `${SHIORI_TYPERT_PACKAGE}/types#${method}Input`,
    create: identityParse,
  };
}

function resultCodec(method) {
  return {
    mode: "strict",
    typeSymbol: `${SHIORI_TYPERT_PACKAGE}/types#${method}Output`,
    create: identityParse,
    encode: (value) => {
      assertJsonSafe(value);
      return value;
    },
  };
}

/**
 * 九个方法的严格 invocation 描述符（每次调用重新构建，输入零共享）。
 * endpoint = `${namespace}/${method}`（dsh-typert-registry typertEndpoint）。
 */
export function buildShioriTypertContribution() {
  const invocations = Object.keys(MANAGEMENT_METHODS).map((method) => ({
    id: `${SHIORI_TYPERT_PACKAGE}/${method}`,
    service: SHIORI_RPC_SERVICE_KEY,
    namespace: SHIORI_RPC_NAMESPACE,
    method,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "session",
        wire: "sessionId",
        source: "lookup",
        lookup: "session",
        codec: { mode: "strict", typeSymbol: SESSION_WIRE_TYPE_SYMBOL, create: identityParse },
      },
      {
        name: "payload",
        wire: "payload",
        source: "json",
        codec: payloadCodec(method),
      },
    ],
    cancellation: { parameter: "signal" },
    result: resultCodec(method),
  }));
  return { package: SHIORI_TYPERT_PACKAGE, face: "host", schemas: [], invocations };
}

/** endpoint -> descriptor 的只读快照（adopt 比对与诊断用）。 */
function localSnapshot(typert) {
  const out = new Map();
  for (const method of Object.keys(MANAGEMENT_METHODS)) {
    const endpoint = `${SHIORI_RPC_NAMESPACE}/${method}`;
    const descriptor = typert.local?.get?.(endpoint);
    out.set(endpoint, descriptor === undefined ? null : JSON.stringify(descriptor));
  }
  return out;
}

/**
 * 注册严格描述符。返回 {codec:'strict'|'src', reason:string|null, disposer}。
 * 绝不抛出——任何失败都回退 SRC（现状行为），reason 如实记录。
 *
 * @param {object} ctx 插件 Cordis 上下文（typert 经可选读取解析，未 inject
 *   也不抛，见 readOptionalCordisService）。
 */
export function registerShioriTypert(ctx) {
  const typert = readOptionalCordisService(ctx, "typert");
  if (typert === null || typeof typert !== "object" || typeof typert.register !== "function") {
    return { codec: "src", reason: "host typert registry unavailable on this context", disposer: null };
  }
  // 注册前核验 session lookup provider（wire symbol 版本耦合的唯一接触面）。
  // 缺失或 symbol 漂移 → 回退 SRC，避免 provider-mismatch 打挂全部端点。
  try {
    const provider = typeof typert.lookups?.get === "function" ? typert.lookups.get("session") : undefined;
    if (provider === undefined || provider.wire !== "sessionId"
      || provider.wireTypeSymbol !== SESSION_WIRE_TYPE_SYMBOL) {
      return {
        codec: "src",
        reason: `session lookup provider mismatch (wire=${provider?.wire ?? "missing"}, symbol=${provider?.wireTypeSymbol ?? "missing"})`,
        disposer: null,
      };
    }
  } catch (error) {
    return { codec: "src", reason: `session lookup probe failed: ${error instanceof Error ? error.message : String(error)}`, disposer: null };
  }

  let contribution;
  try {
    contribution = buildShioriTypertContribution();
  } catch (error) {
    return { codec: "src", reason: `descriptor build failed: ${error instanceof Error ? error.message : String(error)}`, disposer: null };
  }

  try {
    const disposer = typert.register(contribution);
    return { codec: "strict", reason: null, disposer };
  } catch (error) {
    // 上一代未干净 withdraw（崩溃/热卸载）：现存描述符与本次逐字一致 → 沿用。
    try {
      const existing = localSnapshot(typert);
      let allMatch = true;
      for (const invocation of contribution.invocations) {
        const endpoint = `${invocation.namespace}/${invocation.method}`;
        if (existing.get(endpoint) !== JSON.stringify(invocation)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        return { codec: "strict", reason: "adopted-from-previous-registration (no disposer; withdrawn only at DSH process exit)", disposer: null };
      }
    } catch { /* 比对失败按回退处理 */ }
    return { codec: "src", reason: `typert.register failed: ${error instanceof Error ? error.message : String(error)}`, disposer: null };
  }
}
