/**
 * Shiori P1-ACCEPTANCE — 本地 loopback 捕获 provider（零付费）。
 *
 * 职责（tasks/F.md「必做」第 1、2 条）：
 * - 绑定 127.0.0.1 随机空闲端口（port 0 由 OS 分配），不联外网、不调用付费模型、
 *   不启动替代当前 GUI；明确 start/stop 与资源清理；超时失败不吞。
 * - 捕获真实发给 provider 的【完整序列化请求体】（raw bytes + SHA256 + 字节数），
 *   同时给出【正规化 system 视图】（解析后的 system 字符串），两者分开存储：
 *   assembled-section（宿主拼接的系统提示）与真正序列化的请求是两种证据，不得混用。
 * - 证据边界：请求/响应/诊断不落 Authorization、API key、Cookie 等敏感头（白名单头，
 *   其余只记「header 名 + 是否存在」）。证据只含合成正文。
 *
 * 捕获 ≠ 放行：本模块只是 HTTP 接收端。谁把请求发到它是调用方（矩阵 runner 或
 * 真实宿主的出站配置）。普通 HTTP 客户端自发请求只能算 synthetic 证据 ——
 * 证据等级由调用方声明并经 validateEvidenceBundle 语义校验，本模块不背书。
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

/** 只保留的请求头白名单；其余头一律不落盘（防止凭证进入证据）。 */
const SAFE_REQUEST_HEADERS = new Set(["content-type", "content-length", "user-agent"]);
const SAFE_RESPONSE_HEADERS = { "content-type": "application/json; charset=utf-8" };

/** 固定的假 provider 回执（合成、零成本；形状仅示意，不做 provider 兼容性声明）。 */
const FAKE_PROVIDER_RESPONSE = JSON.stringify({
  id: "shiori-loopback-capture",
  synthetic: true,
  choices: [{ index: 0, message: { role: "assistant", content: "loopback-ok" } }],
});

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * 解析捕获的原始请求体为正规化视图。
 * 请求体必须是 UTF-8 JSON，且含 string 型 system 字段（完整出站系统提示）。
 * 解析失败抛 INVALID_INPUT —— 不能把无法解析的请求伪装成有效证据。
 */
export function normalizeCapturedRequest(rawBody) {
  let parsed;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    const err = new Error(`captured request body is not valid UTF-8 JSON: ${error instanceof Error ? error.message : String(error)}`);
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const err = new Error("captured request body must be a JSON object");
    err.code = "INVALID_INPUT";
    throw err;
  }
  if (typeof parsed.system !== "string") {
    const err = new Error("captured request has no string `system` field; complete outbound system cannot be verified");
    err.code = "INVALID_INPUT";
    throw err;
  }
  return {
    system: parsed.system,
    model: typeof parsed.model === "string" ? parsed.model : null,
    messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
  };
}

/**
 * 创建一个 loopback 捕获会话。
 * @param {object} [options]
 * @param {number} [options.requestTimeoutMs=10000] 单个请求的接收超时；超时销毁连接并
 *     显式记录错误（不吞、不静默丢弃）。
 * @param {number} [options.maxRequests=64] 捕获上限；超出后连接被拒并记录（防失控）。
 * @returns 捕获会话：{start, stop, url, requests, errors, diagnostics}
 */
export function createLoopbackCapture({ requestTimeoutMs = 10_000, maxRequests = 64 } = {}) {
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
    const err = new Error("requestTimeoutMs must be a positive integer"); err.code = "INVALID_INPUT"; throw err;
  }
  if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
    const err = new Error("maxRequests must be a positive integer"); err.code = "INVALID_INPUT"; throw err;
  }

  /** @type {import("node:http").Server|null} */
  let server = null;
  let port = null;
  let started = false;
  let stopped = false;
  /** @type {Array<object>} */
  const requests = [];
  /** @type {Array<string>} */
  const errors = [];

  function recordError(message) {
    errors.push(`${new Date().toISOString()} ${message}`);
  }

  async function start() {
    if (stopped) {
      const err = new Error("capture already stopped; a stopped capture cannot be restarted (create a new one)");
      err.code = "INVALID_STATE";
      throw err;
    }
    if (started) {
      const err = new Error("capture already started"); err.code = "INVALID_STATE"; throw err;
    }
    server = createServer((req, res) => {
      const chunks = [];
      let byteLength = 0;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        recordError(`request timed out after ${requestTimeoutMs}ms (headers received: ${req.headers ? "yes" : "no"}); connection destroyed`);
        res.destroy();
      }, requestTimeoutMs);

      req.on("data", (chunk) => {
        byteLength += chunk.length;
        if (byteLength > 8 * 1024 * 1024) {
          if (!settled) { settled = true; clearTimeout(timer); }
          recordError("request body exceeds 8MiB capture limit; connection destroyed");
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        recordError(`request stream error: ${error instanceof Error ? error.message : String(error)}`);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (requests.length >= maxRequests) {
          recordError(`capture limit ${maxRequests} reached; request rejected`);
          res.writeHead(503, SAFE_RESPONSE_HEADERS);
          res.end(JSON.stringify({ error: "capture-limit-reached" }));
          return;
        }
        const rawBody = Buffer.concat(chunks);
        const safeHeaders = {};
        for (const [name, value] of Object.entries(req.headers)) {
          if (SAFE_REQUEST_HEADERS.has(name)) safeHeaders[name] = value;
        }
        const sensitivePresent = Object.keys(req.headers)
          .filter((name) => !SAFE_REQUEST_HEADERS.has(name))
          .map((name) => ({ name, present: true }));
        let normalized = null;
        let normalizeError = null;
        try {
          normalized = normalizeCapturedRequest(rawBody);
        } catch (error) {
          normalizeError = error instanceof Error ? error.message : String(error);
        }
        requests.push({
          index: requests.length,
          receivedAt: new Date().toISOString(),
          method: req.method,
          path: req.url,
          bytes: rawBody.length,
          sha256: sha256Hex(rawBody),
          rawBody,
          headers: safeHeaders,
          otherHeadersPresent: sensitivePresent,
          normalized,
          normalizeError,
        });
        res.writeHead(200, SAFE_RESPONSE_HEADERS);
        res.end(FAKE_PROVIDER_RESPONSE);
      });
    });
    // IPv4 回环显式绑定：不监听非回环地址。
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    port = server.address().port;
    started = true;
    return { url: `http://127.0.0.1:${port}`, port };
  }

  async function stop() {
    if (stopped) return { alreadyStopped: true };
    stopped = true;
    if (!server || !started) return { alreadyStopped: true };
    // 先关闭监听（新连接拒绝），再等既有连接排空；有强制兜底超时防挂死。
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      const force = setTimeout(() => {
        recordError("stop(): connections did not drain in time; forcing close");
        server.closeAllConnections?.();
      }, Math.min(requestTimeoutMs, 5000));
      server.once("close", () => clearTimeout(force));
    });
    server = null;
    port = null;
    // started 必须随 stop 归位：diagnostics() 在停止后不得仍报告 started=true，
    // 否则 runner 的资源回收校验会（正确地）把整次运行判为 teardown 失败（反馈 F3）。
    started = false;
    return { alreadyStopped: false };
  }

  return {
    start,
    stop,
    get url() {
      if (!started || !port) {
        const err = new Error("capture not started; url is unavailable before start()");
        err.code = "INVALID_STATE";
        throw err;
      }
      return `http://127.0.0.1:${port}`;
    },
    get port() {
      if (!started || !port) {
        const err = new Error("capture not started"); err.code = "INVALID_STATE"; throw err;
      }
      return port;
    },
    requests,
    errors,
    diagnostics() {
      return {
        started,
        stopped,
        capturedCount: requests.length,
        errorCount: errors.length,
        requestTimeoutMs,
        maxRequests,
        // 诊断只含计数与错误摘要，不含任何请求正文或头（凭证防护）。
        errors: [...errors],
      };
    },
  };
}

/**
 * 把宿主注册的 section 投影为【完整出站 system】。
 * 投影规则（docs/acceptance/README.md §投影契约）：宿主自有正文在前，其后按 (order, 注册
 * 先后) 稳定排序的各 section，以 "\n\n" 连接；宿主自有内容必须保留。
 * 支持 sync 与 async section text（真实桥两种模式都会注册）。
 * @param {object} host 暴露 listSections() 的宿主抽象（synthetic 宿主或适配器）
 * @param {string} hostOwnSystem 宿主自有 system 文本（不含 Shiori 注入部分）
 */
export async function assembleCompleteSystem(host, hostOwnSystem) {
  if (typeof host?.listSections !== "function") {
    const err = new Error("host must expose listSections() for complete-system projection");
    err.code = "INVALID_INPUT";
    throw err;
  }
  const parts = [];
  if (typeof hostOwnSystem === "string" && hostOwnSystem.length > 0) parts.push(hostOwnSystem);
  for (const section of host.listSections()) {
    const rendered = typeof section.text === "function" ? await section.text({}) : section.text;
    if (typeof rendered !== "string") {
      const err = new Error(`section "${section.name}" did not render to a string`);
      err.code = "INVALID_STATE";
      throw err;
    }
    parts.push({ order: section.order, seq: parts.length, text: rendered, name: section.name });
  }
  const sectionParts = parts.filter((p) => typeof p === "object");
  sectionParts.sort((a, b) => (a.order - b.order) || (a.seq - b.seq));
  const ordered = [
    ...parts.filter((p) => typeof p === "string"),
    ...sectionParts.map((p) => p.text),
  ];
  return ordered.join("\n\n");
}

/**
 * 向捕获 provider 发送一次【真实 HTTP】请求（127.0.0.1 loopback）。
 * 序列化是确定性的：JSON 字段按给定顺序写出，raw body 的 SHA256 可复算。
 * @param {object} capture createLoopbackCapture 返回的捕获会话（须已 start）
 * @returns {Promise<{captureIndex:number, status:number, system:string, rawSha256:string, systemSha256:string}>}
 */
export async function sendProviderRequest({ capture, host, hostOwnSystem, model, messages, timeoutMs = 10_000 }) {
  if (!capture || typeof capture.url !== "string" || !capture.url.startsWith("http://127.0.0.1:")) {
    const err = new Error("capture must be a started loopback capture session");
    err.code = "INVALID_INPUT";
    throw err;
  }
  const system = await assembleCompleteSystem(host, hostOwnSystem);
  const body = JSON.stringify({
    model,
    system,
    messages,
  });
  const response = await fetch(`${capture.url}/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const err = new Error(`capture provider responded ${response.status}`);
    err.code = "INVALID_STATE";
    throw err;
  }
  await response.arrayBuffer();
  if (capture.requests.length === 0) {
    const err = new Error("capture recorded no request after a successful HTTP POST; capture session is not the receiving endpoint");
    err.code = "INVALID_STATE";
    throw err;
  }
  return {
    captureIndex: capture.requests.length - 1,
    status: response.status,
    system,
    rawSha256: sha256Hex(Buffer.from(body, "utf8")),
    systemSha256: sha256Hex(Buffer.from(system, "utf8")),
  };
}
