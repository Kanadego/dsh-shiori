// Shiori P5-PLUGIN · 真实 DSH 宿主 bindings（slot P；CONTRACTS §2）。
//
// createDshBindings(ctx, settings, deps) — 生产 bindings 来自 ctx，不依赖 Q 另
// 注入未实现的宿主 shim。包装真实宿主 API：
// - ctx.systemPrompt.section({name, order, text})          → L0/L1 section（同步 provider，
//   先求值给安全占位/缓存；真实刷新由 system-prompt/assemble waterfall 完成）；
// - ctx.on("system-prompt/assemble", waterfall)            → async waterfall（dsh-system-prompt
//   types/index.d.ts:27：assembly/context/next => Promise<PromptAssembly>）；
// - @deepseek-ai/dsh-tools defineTool                      → 工具注册（output:{schema,render}
//   必须提供——lib/index.js:842 直接读取；runner 对成功输出做 schema 校验）；
// - ctx.on("session/event")                                → 完成事件 + L2 accepted receipt；
// - ctx.on("agent/pre-step")                               → L2 投递（dsh-agent
//   runtime-types.d.ts:304；waterfall；PreStepDecision {kind:'enter',messages})；
// - @deepseek-ai/dsh-llm createUserMessage                 → L2 独立 text context message
//   （source.kind='shiori-sparks'/form='recall'；稳定 id 由冻结 message 承载）。
//
// 缺能力报 UNSUPPORTED，无静默替代。本模块只做形状映射，不做业务。

const DSH_PACKAGES = Object.freeze({
  dshTools: "@deepseek-ai/dsh-tools",
  dshLlm: "@deepseek-ai/dsh-llm",
});

function fail(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  throw error;
}

/**
 * 解析并验证一个 DSH 包的真实解析路径（M6）：先用 import.meta.resolve 拿到
 * 具体 URL（拿不到也算出可诊断结论），再据此 import，最后核验导出形状。
 * 返回 {mod, resolvedUrl}；解析/形状不符抛 UNSUPPORTED（带路径证据）。
 */
async function resolveDshModule(specifier, expectedExports, injected) {
  if (typeof injected === "function") {
    const mod = await injected();
    for (const [key, kind] of Object.entries(expectedExports)) {
      if (typeof mod?.[key] !== kind) {
        fail("UNSUPPORTED", `injected DSH loader for "${specifier}" did not provide ${key} (${kind})`, { specifier, key });
      }
    }
    return { mod, resolvedUrl: "injected-loader" };
  }
  let resolvedUrl = null;
  let resolveError = null;
  try {
    resolvedUrl = import.meta.resolve(specifier);
  } catch (error) {
    resolveError = error instanceof Error ? error.message : String(error);
  }
  let mod;
  try {
    mod = await import(resolvedUrl ?? specifier);
  } catch (error) {
    fail("UNSUPPORTED",
      `DSH bindings require "${specifier}" (resolved: ${resolvedUrl ?? `unresolved: ${resolveError}`}): ${error instanceof Error ? error.message : String(error)}`,
      { specifier, resolvedUrl });
  }
  for (const [key, kind] of Object.entries(expectedExports)) {
    if (typeof mod?.[key] !== kind) {
      fail("UNSUPPORTED",
        `"${specifier}" (resolved to ${resolvedUrl ?? "unknown"}) did not provide ${key} (${kind}); the installed package is not the expected DSH build`,
        { specifier, resolvedUrl, key });
    }
  }
  return { mod, resolvedUrl };
}

/**
 * B2 探测（三态）：扫描 systemPrompt **global 层**中已存在的 complete:true section。
 *
 * 为什么只扫 global：宿主 dsh-system-prompt 的 complete 快照只对**那一次
 * assembly** 生效（lib/index.js:381-403：assemble 前收集本次 sectionDefinitions
 * 里的 completeSections，waterfall 后若有快照则用 [completeSection] 整体替换
 * sections）。别的 scope（例如 desktop/web 默认 preset-minimal 的 persona）
 * 注册 complete:true 只影响该 scope 自己的装配，不构成对本包全局 L0/L1 的遮蔽。
 * 因此这里绝不遍历 layers.scoped。
 *
 * 返回三态对象（读唯一，不写、不注册）：
 * - { state: "ok",          sections: [...] }  global 层可读且命中 complete section；
 * - { state: "none",        sections: [] }     global 层可读、未命中；
 * - { state: "unavailable", sections: [] }     layers/global 不可读——不可判定，
 *   调用方绝不得据此宣称 L0/L1 有效（诚实度要求，见 controller completeProbe）。
 * systemPrompt 本身不存在（无 complete-prompt 组合服务）视为未命中（none）。
 */
export function detectCompletePromptSections(systemPrompt) {
  if (systemPrompt === null || systemPrompt === undefined) return { state: "none", sections: [] };
  let sections;
  try {
    const layers = systemPrompt.layers;
    if (layers === null || typeof layers !== "object") return { state: "unavailable", sections: [] };
    sections = layers.global?.sections;
    if (sections === null || typeof sections !== "object") return { state: "unavailable", sections: [] };
    const entries = typeof sections.entries === "function"
      ? sections.entries()
      : sections.data instanceof Map
        ? sections.data.entries()
        : null;
    if (entries === null) return { state: "unavailable", sections: [] };
    const found = [];
    for (const [name, section] of entries) {
      if (section?.complete === true) found.push({ name: String(name), scope: "global" });
    }
    return { state: found.length > 0 ? "ok" : "none", sections: found };
  } catch {
    return { state: "unavailable", sections: [] };
  }
}

/**
 * B2 运行期探测：**本次 assembly 的 scope** 里生效的 complete:true section。
 *
 * 宿主 dsh-system-prompt 的 enforce 逻辑（lib/index.js:380-403）在 waterfall
 * 之前就按本次 scope 合并 sectionDefinitions 并收集 completeSections，而交给
 * waterfall 的 assembly.sections 已被映射成 {name,text[,interpolate]}——**不再
 * 携带 complete 标记**（:385-393）。因此运行期不能用入口 section 的 complete
 * 字段判定；这里用与宿主同一份合并结果（layers.merge(scope, layer=>layer.sections)）
 * 在本 scope 内判定，绝不跨 scope 推断全局。
 *
 * 返回三态：{ state: "ok", sections }（本 scope 确实有 complete section，
 * 本次装配的 sections 会被 [completeSection] 整体替换）/
 * { state: "none", sections: [] }（本 scope 没有）/
 * { state: "unavailable", sections: [] }（注册表不可读——不可判定）。
 */
export function detectCompleteSectionsForScope(systemPrompt, scope) {
  if (systemPrompt === null || systemPrompt === undefined) return { state: "none", sections: [] };
  try {
    const layers = systemPrompt.layers;
    if (layers === null || typeof layers !== "object") return { state: "unavailable", sections: [] };
    if (typeof layers.merge !== "function") return { state: "unavailable", sections: [] };
    const merged = layers.merge(scope, (layer) => layer.sections);
    if (!(merged instanceof Map)) return { state: "unavailable", sections: [] };
    const found = [];
    for (const [name, section] of merged) {
      if (section?.complete === true) found.push({ name: String(name), scope: scope === undefined ? "global" : String(scope) });
    }
    return { state: found.length > 0 ? "ok" : "none", sections: found };
  } catch {
    return { state: "unavailable", sections: [] };
  }
}

/**
 * @param {object} ctx cordis 插件上下文（systemPrompt / tools / on）
 * @param {object} _settings 已校验 settings（本层不消费业务，仅保留签名一致）
 * @param {object} [deps]
 * @param {() => Promise<object>} [deps.loadDshTools] 注入 dsh-tools 加载器（隔离测试用）
 * @param {() => Promise<object>} [deps.loadDshLlm]   注入 dsh-llm 加载器（隔离测试用）
 */
export function createDshBindings(ctx, _settings = {}, deps = {}) {
  if (ctx === null || typeof ctx !== "object") {
    fail("INVALID_INPUT", "ctx must be an object", {});
  }
  for (const field of ["systemPrompt", "tools", "on"]) {
    if (ctx[field] === undefined) {
      fail("UNSUPPORTED", `host ctx.${field} is required by the DSH bindings (capability missing)`, { field });
    }
  }

  const disposers = [];
  const diagnostics = {
    registeredTools: [], registeredSections: [], waterfall: false, preStep: false, sessionEvents: false,
    dshToolsResolved: null, dshLlmResolved: null,
  };

  function track(disposer, kind, name) {
    const fn = typeof disposer === "function" ? disposer : disposer?.dispose;
    if (typeof fn !== "function") {
      fail("INVALID_STATE", `host ${kind} registration for "${name}" did not return a disposer`, { kind, name });
    }
    disposers.push(fn);
    return fn;
  }

  return {
    /** 注册 system section（同步 text provider；waterfall 负责真实刷新）。 */
    registerSystemSection({ name, order, text }) {
      const disposer = ctx.systemPrompt.section({ name, order, text, interpolate: false });
      track(disposer, "section", name);
      diagnostics.registeredSections.push(name);
      return true;
    },

    /** 注册 system-prompt/assemble waterfall（真实 async 刷新路径）。 */
    registerAssembleWaterfall(handler) {
      const disposer = ctx.on("system-prompt/assemble", handler);
      track(disposer, "waterfall", "system-prompt/assemble");
      diagnostics.waterfall = true;
      return true;
    },

    /** 注册 agent/pre-step waterfall（L2 投递入口）。 */
    registerPreStep(handler) {
      const disposer = ctx.on("agent/pre-step", handler);
      track(disposer, "pre-step", "agent/pre-step");
      diagnostics.preStep = true;
      return true;
    },

    /** 订阅真实 session 事件（原始 (session, event) 形状；调用方自行归一化）。 */
    subscribeSessionEvents(listener) {
      const disposer = ctx.on("session/event", listener);
      track(disposer, "subscription", "session/event");
      diagnostics.sessionEvents = true;
      return true;
    },

    /**
     * 经真实 defineTool + ctx.tools.register 注册一个工具。
     * output:{schema, render} 必须存在（dsh-tools lib/index.js:842 直接读取
     * options.output.render；runner 对成功输出按 output.schema 校验）。
     */
    async registerTool(tool) {
      const { mod, resolvedUrl } = await resolveDshModule(
        DSH_PACKAGES.dshTools,
        { defineTool: "function" },
        deps.loadDshTools,
      );
      diagnostics.dshToolsResolved = resolvedUrl;
      const defineTool = mod.defineTool;
      if (typeof tool.outputSchema !== "object" || tool.outputSchema === null) {
        fail("INVALID_INPUT", `tool "${tool.name}" must declare outputSchema (never an empty closed object)`, {});
      }
      const registered = ctx.tools.register(defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        isConcurrencySafe: typeof tool.isConcurrencySafe === "function" ? tool.isConcurrencySafe : () => true,
        async execute(args, exec) {
          return tool.execute(args, exec);
        },
        output: {
          schema: tool.outputSchema,
          // render 必须返回 content block 数组：宿主把返回值直接当 result.content
          // 并对其调 .some(...)（dsh-tools lib/index.js:3637-3648 / :1454）。
          render: tool.outputRender ?? ((args, value) => [{ type: "text", text: JSON.stringify(value) }]),
        },
        ...(tool.presentCall !== undefined ? { presentCall: tool.presentCall } : {}),
      }));
      const fn = typeof registered === "function" ? registered : registered?.dispose;
      if (typeof fn !== "function") {
        fail("INVALID_STATE", `host tool registration for "${tool.name}" did not return a disposer`, {});
      }
      disposers.push(fn);
      diagnostics.registeredTools.push(tool.name);
      return true;
    },

    /** createUserMessage（dsh-llm）：L2 独立 text context message。 */
    async loadCreateUserMessage() {
      const { mod, resolvedUrl } = await resolveDshModule(
        DSH_PACKAGES.dshLlm,
        { createUserMessage: "function" },
        deps.loadDshLlm,
      );
      diagnostics.dshLlmResolved = resolvedUrl;
      return mod.createUserMessage;
    },

    /** 逆序撤销全部注册。 */
    disposeAll() {
      const errors = [];
      while (disposers.length > 0) {
        const fn = disposers.pop();
        try {
          fn();
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      }
      diagnostics.registeredTools = [];
      diagnostics.registeredSections = [];
      diagnostics.waterfall = false;
      diagnostics.preStep = false;
      diagnostics.sessionEvents = false;
      return { disposed: true, errors };
    },

    diagnostics,
  };
}
