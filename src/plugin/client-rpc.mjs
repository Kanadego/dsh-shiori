// Shiori P5-Q · 服务端 RPC 挂载（公共契约导出 mountShioriRpc）。
//
// 职责（CONTRACTS §2/§6/§7，HOST-API-NOTES「可信身份 / RPC / client」）：
//   - 挂载真实 TypertRemoteService（bindTypertRemote 由基类构造完成）与 Remote 标记，
//     由宿主 Gateway 以 source-mode 发现并导出；不是任意普通 class；
//   - wire 固定为 namespace `shiori` 的各 management 方法 (sessionId, payload)：
//     参数名 `session` 命中宿主 session lookup（wire 字段 sessionId，解析为真实
//     Session 宿主对象，不存在即由 Gateway 拒绝），`payload` 为业务字段，
//     末位 `signal` 为真实调用取消信号；
//   - 授权只认服务端绑定身份：this.ctx.invocation.peer.principal（本批仅
//     principal.kind === "owner"），payload / wire 永不携带 trustedContext，
//     存在 sessionId 不等于获授权；
//   - trustedContext 固定形状 { agent, session, principal, source: "panel-rpc", signal }，
//     agent 由宿主 agents 注册表按 session.id 解析（可能缺省，由 P 决策）；
//   - 输入校验只用 P 的 src/plugin/protocol.mjs（MANAGEMENT_METHODS +
//     validateManagementPayload）；Q 不复制业务校验；
//   - 失败保留 code：management 抛出的 Error.code 经 RemoteError 原样过线，
//     不把失败伪装成功；
//   - stop()：禁新 → 撤销自有取消信号 → 排空在途调用（服务注销随插件 fiber
//     释放链完成，顺序与「RPC stop → controller stop」一致）。
//
// Cordis receiver 兼容（owner review R2）：Gateway 不以裸实例调用方法，而是
// `receiverContext.get(key)` 取 Cordis traceable proxy，再把 shadow receiver
// （覆盖了调用时 ctx 的 withProps proxy）作为 this 传进来。因此：
//   1) 本类禁用 `#` 私有成员——私有方法/字段的品牌检查对 shadow receiver 直接
//      TypeError（"Receiver must be an instance of class ..."）；
//   2) 全部可变状态放在公共 own 字段 this.rpcState / this.management / this.settings，
//      shadow proxy 的 get 链会把属性读取转发到真实实例；
//   3) per-invocation 身份只用 this.ctx——Cordis 约定 tracker.property === "ctx"，
//      方法被 shadow receiver 调用时 this.ctx 即携带本次 invocation 的接收上下文；
//      裸实例直调时 this.ctx 是构造 ctx（无 invocation → 一律拒绝）。
//
// 本模块不 import 宿主以外的新依赖；不读取业务数据（全部经 P management）。

import { Remote, RemoteError, TypertRemoteService, remoteErrorOf } from "@deepseek-ai/dsh-typert-protocol";
import { MANAGEMENT_METHODS, validateManagementPayload } from "./protocol.mjs";

/** wire 命名空间（与 Cordis 插件 id / settings 命名空间一致）。 */
export const RPC_NAMESPACE = "shiori";
/** 宿主 Cordis 服务键。 */
export const RPC_SERVICE_KEY = "shiori.panel";

// 冻结契约的方法清单（CONTRACTS §6）。若 P 的 MANAGEMENT_METHODS 与之不一致，
// 挂载时立刻失败并指出差异——契约问题上报 owner，不静默兼容。
const CONTRACT_METHODS = Object.freeze([
  "getStatus", "getMemoryView", "getGraph", "executeTool",
  "listCandidates", "analyze", "reviewCandidate", "previewPlan", "executePlan",
]);

function methodSetMismatch(actual, expected) {
  const left = new Set(actual);
  const right = new Set(expected);
  const missing = [...right].filter((name) => !left.has(name));
  const extra = [...left].filter((name) => !right.has(name));
  const parts = [];
  if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
  if (extra.length) parts.push(`unexpected: ${extra.join(", ")}`);
  return parts.join("; ");
}

// 宿主客户端（dsh-client-connection client.browser.js）解码失败响应时要求
// error.details 是 record（typeof "object" && !== null && 非 Array）；gateway
// 原样搬运 details，undefined 键在 JSON 序列化后丢失 → 客户端一律抛
// "connection: invalid server-response failure"，业务错误全被遮断。
// 因此本服务所有 RemoteError 出口的 details 恒为对象。
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * RemoteError details 规整：业务错误优先透传 P protocol failInvalid 携带的
 * details（如 { violations } / { planId } / { candidateId }，这些上下文不应在本层丢失）；
 * 没有可透传的 record 时给 { code } 兜底——绝不返回 undefined / null。
 */
function detailsFor(error, fallbackCode) {
  if (isRecord(error) && isRecord(error.details)) return error.details;
  return { code: fallbackCode };
}

/**
 * 以协议公开的 Remote 装饰器为原型方法打标记（与生成物同一 version-1 descriptor；
 * 标准 JS 无装饰器语法，这里按装饰器契约手动执行同一初始化路径）。
 */
function applyRemoteMarker(klass, method) {
  const initializers = [];
  const decorator = Remote(method);
  decorator(klass.prototype[method], {
    kind: "method",
    name: method,
    static: false,
    private: false,
    access: { has: (object) => method in object, get: (object) => object[method] },
    addInitializer: (fn) => initializers.push(fn),
  });
  // 初始化器以实例身份运行，但只读取原型；用原型派生的空对象即可完成标记。
  for (const init of initializers) init.call(Object.create(klass.prototype));
}

/**
 * 方法体统一入口。self 是「调用方 receiver」：Gateway 路径下是 Cordis shadow
 * proxy，直调路径下是实例本身——两者都支持属性读取转发与 this.ctx 覆盖。
 * 每个方法的参数名必须保持 (session, payload, signal)：
 * Gateway 以 Function.toString 解析参数名并映射 wire 字段，不得使用解构/默认值/rest。
 */
async function dispatchShioriCall(self, method, session, payload, callSignal) {
  const state = self.rpcState;
  if (state.closed) {
    throw new RemoteError("shiori/rpc-stopped", `shiori panel RPC is stopping; ${method} rejected`, { code: "shiori/rpc-stopped", method });
  }
  const invocation = self.ctx.invocation;
  const peer = invocation?.peer;
  const principal = peer?.principal;
  // 授权只来自服务端绑定的连接身份；本批单 owner。无 invocation（非 Gateway 调用）
  // 或非 owner 一律拒绝，绝不回退到 payload 里的任何身份字段。
  if (!principal || principal.kind !== "owner") {
    throw new RemoteError("shiori/unauthorized", `shiori panel RPC requires an owner peer (got ${principal ? principal.kind : "none"})`, { code: "shiori/unauthorized", principalKind: principal ? String(principal.kind) : null });
  }
  // session 由宿主 lookup 解析为真实 Session 对象；这里只接受带 id 的宿主对象。
  const sessionId = session && typeof session === "object" && typeof session.id === "string" ? session.id : null;
  if (sessionId === null) {
    throw new RemoteError("shiori/invalid-session", "shiori panel RPC requires a host-resolved session", { code: "shiori/invalid-session", method });
  }
  const management = self.management;
  const handler = management[method];
  if (typeof handler !== "function") {
    throw new RemoteError("shiori/unsupported", `management method "${method}" is unavailable`, { code: "shiori/unsupported", method });
  }

  // 真实调用取消信号优先；缺失时自有信号由 stop() 撤销（HOST-API-NOTES 约定）。
  let signal = callSignal;
  if (!signal || typeof signal.addEventListener !== "function") {
    const controller = new AbortController();
    state.ownedControllers.add(controller);
    signal = controller.signal;
  }

  let agent;
  const agents = self.ctx.get("agents");
  if (agents && typeof agents.get === "function") {
    try {
      agent = agents.get(sessionId);
    } catch {
      agent = undefined; // 注册表自身异常不阻断诊断类调用；由 P 决定业务影响
    }
  }
  const trustedContext = { agent, session, principal, source: "panel-rpc", signal };

  const call = (async () => {
    try {
      validateManagementPayload(method, payload);
      return await handler.call(management, trustedContext, payload);
    } catch (error) {
      if (remoteErrorOf(error) !== undefined) throw error;
      const code = typeof error?.code === "string" && error.code ? error.code : "INTERNAL";
      throw new RemoteError(code, String(error?.message ?? error), detailsFor(error, code));
    }
  })();
  state.inFlight.add(call);
  try {
    return await call;
  } finally {
    state.inFlight.delete(call);
  }
}

/** stop 主体：禁新 → 撤销自有取消信号 → 排空在途调用。幂等。 */
async function stopShioriPanelService(self) {
  const state = self.rpcState;
  if (state.stopped) return;
  state.closed = true;
  for (const controller of state.ownedControllers) {
    try {
      controller.abort(new RemoteError("shiori/rpc-stopped", "shiori panel RPC stopped", { code: "shiori/rpc-stopped" }));
    } catch { /* 已中止 */ }
  }
  state.ownedControllers.clear();
  if (state.inFlight.size > 0) {
    await Promise.allSettled([...state.inFlight]);
  }
  state.stopped = true;
}

/** diagnostics 主体（供挂载层补充 transport / ui 判定）。 */
function shioriPanelDiagnostics(self) {
  const state = self.rpcState;
  return {
    service: RPC_SERVICE_KEY,
    namespace: RPC_NAMESPACE,
    methods: [...CONTRACT_METHODS],
    mode: self.settings?.mode ?? null,
    inert: self.settings?.dataRoot === null && self.settings?.stateRoot === null,
    ownerOnly: true,
    closed: state.closed,
    stopped: state.stopped,
    inFlight: state.inFlight.size,
  };
}

/**
 * 宿主面板 RPC 服务。方法全部保留在原型上（Gateway source-mode 发现依赖
 * Function.toString 的参数名），方法体委托模块级 dispatchShioriCall。
 */
class ShioriPanelService extends TypertRemoteService {
  static inject = ["typert"];

  constructor(ctx, management, settings) {
    super(ctx, RPC_SERVICE_KEY, { namespace: RPC_NAMESPACE });
    // Cordis receiver 兼容（见文件头说明）：不用 # 私有成员；状态放公共字段，
    // 由模块级函数操作。inFlight / ownedControllers 是容器（内部可变），外层不可替换。
    this.management = management;
    this.settings = settings;
    this.rpcState = { closed: false, stopped: false, inFlight: new Set(), ownedControllers: new Set() };
  }

  getStatus(session, payload, signal) {
    return dispatchShioriCall(this, "getStatus", session, payload, signal);
  }

  getMemoryView(session, payload, signal) {
    return dispatchShioriCall(this, "getMemoryView", session, payload, signal);
  }

  getGraph(session, payload, signal) {
    return dispatchShioriCall(this, "getGraph", session, payload, signal);
  }

  executeTool(session, payload, signal) {
    return dispatchShioriCall(this, "executeTool", session, payload, signal);
  }

  listCandidates(session, payload, signal) {
    return dispatchShioriCall(this, "listCandidates", session, payload, signal);
  }

  analyze(session, payload, signal) {
    return dispatchShioriCall(this, "analyze", session, payload, signal);
  }

  reviewCandidate(session, payload, signal) {
    return dispatchShioriCall(this, "reviewCandidate", session, payload, signal);
  }

  previewPlan(session, payload, signal) {
    return dispatchShioriCall(this, "previewPlan", session, payload, signal);
  }

  executePlan(session, payload, signal) {
    return dispatchShioriCall(this, "executePlan", session, payload, signal);
  }

  async stop() {
    return stopShioriPanelService(this);
  }

  diagnostics() {
    return shioriPanelDiagnostics(this);
  }
}

// 模块加载即打 Remote 标记：Gateway 由此发现全部 9 个端点。
for (const method of CONTRACT_METHODS) applyRemoteMarker(ShioriPanelService, method);

/**
 * 挂载 shiori 面板 RPC 服务。
 *
 * @param {object} ctx 本插件的 Cordis 上下文。
 * @param {object} management P controller 暴露的 management 对象（业务唯一所有者）。
 * @param {object} settings normalizePluginConfig 的规范化设置。
 * @returns {Promise<{stop(): Promise<void>, diagnostics(): object}>}
 *   stop：禁新、撤销自有信号、排空在途；服务注销随插件 fiber 释放完成。
 * @throws wire 契约与 P protocol 不一致、management 缺方法或服务键冲突时整体失败，
 *   不留半挂载状态。
 */
export async function mountShioriRpc(ctx, management, settings) {
  if (!ctx || typeof ctx.get !== "function") {
    throw new Error("mountShioriRpc requires a Cordis context");
  }
  if (!management || typeof management !== "object") {
    throw new Error("mountShioriRpc requires the controller management object");
  }

  const protocolMethods = Object.keys(MANAGEMENT_METHODS ?? {});
  const mismatch = methodSetMismatch(protocolMethods, CONTRACT_METHODS);
  if (mismatch) {
    throw new Error(`shiori RPC wire contract mismatch (P protocol vs frozen contract): ${mismatch}`);
  }
  const missing = CONTRACT_METHODS.filter((name) => typeof management[name] !== "function");
  if (missing.length > 0) {
    throw new Error(`shiori RPC management is missing methods: ${missing.join(", ")}`);
  }

  const service = new ShioriPanelService(ctx, management, settings);

  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await service.stop();
    },
    diagnostics() {
      const base = service.diagnostics();
      const typert = ctx.get("typert");
      return {
        ...base,
        // 宿主 typert / Gateway 缺席时仅工具模式：如实声明，不隐藏
        transport: typert ? "typert-gateway" : "unavailable",
        ui: typert ? "native-panel" : "unsupported-no-transport",
      };
    },
  };
}
