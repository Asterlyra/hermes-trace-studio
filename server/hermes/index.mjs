import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  appendRawEvent,
  createTrace,
  findTraceByHermesTurn,
  getTrace,
  setPromptLayers,
  updateTrace,
  updateUsage,
  upsertEvent,
} from "../store.mjs";
import { HermesGatewayClient } from "./gateway-client.mjs";
import {
  normalizeGatewayEvent,
  normalizeObserverHook,
  normalizeUsage,
  promptLayer,
  titleFromPrompt,
} from "./normalizer.mjs";
import {
  getHermesStorageStatus,
  importHermesSession,
  listHermesSessions,
  reconcileTracePrompt,
} from "./session-reader.mjs";

const HERMES_HOME = resolve(process.env.HERMES_HOME || `${homedir()}/.hermes`);
const OBSERVER_TOKEN_PATH = resolve(
  process.env.HERMES_TRACE_OBSERVER_TOKEN_FILE || `${HERMES_HOME}/agent-trace-observer.token`,
);
const OBSERVER_PLUGIN_PATH = resolve(HERMES_HOME, "plugins", "agent-trace-observer", "plugin.yaml");

function hermesBinary() {
  if (process.env.HERMES_BINARY) return process.env.HERMES_BINARY;
  const local = resolve(homedir(), ".local", "bin", "hermes");
  return existsSync(local) ? local : "hermes";
}

function detectHermes() {
  const result = spawnSync(hermesBinary(), ["--version"], {
    encoding: "utf8",
    timeout: 8_000,
    env: process.env,
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  const match = output.match(/Hermes Agent v([^\s]+)/i);
  return {
    installed: result.status === 0 && Boolean(match),
    version: match?.[1] || null,
    binary: hermesBinary(),
    error: result.status === 0 ? null : output.split("\n")[0] || "Hermes CLI 不可用。",
  };
}

function isObserverEnabled() {
  try {
    const config = readFileSync(resolve(HERMES_HOME, "config.yaml"), "utf8");
    return /(?:^|\n)\s*-\s*(?:observability\/)?agent-trace-observer\s*(?:#.*)?$/m.test(config);
  } catch {
    return false;
  }
}

function ensureObserverToken() {
  if (process.env.HERMES_TRACE_OBSERVER_TOKEN) return process.env.HERMES_TRACE_OBSERVER_TOKEN;
  try {
    const existing = readFileSync(OBSERVER_TOKEN_PATH, "utf8").trim();
    if (existing.length >= 24) return existing;
  } catch {
    // Create a new local-only credential below.
  }
  mkdirSync(dirname(OBSERVER_TOKEN_PATH), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(OBSERVER_TOKEN_PATH, `${token}\n`, { mode: 0o600 });
  return token;
}

function toGatewayUrl(base, token) {
  const url = new URL(base);
  if (!/^wss?:$/.test(url.protocol)) {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  }
  if (!url.pathname || url.pathname === "/") url.pathname = "/api/ws";
  url.searchParams.set("token", token);
  return url.toString();
}

function traceDuration(trace, endedAt) {
  return Math.max(0, Date.parse(endedAt) - Date.parse(trace.startedAt));
}

class HermesRuntime {
  #gateway = new HermesGatewayClient();
  #serveProcess = null;
  #connectPromise = null;
  #notify = null;
  #probe = detectHermes();
  #runtimeCheck = null;
  #gatewayUrl = null;
  #lastError = null;
  #activeBySession = new Map();
  #runState = new Map();

  constructor() {
    this.#gateway.on("event", (event) => this.#recordGatewayEvent(event));
    this.#gateway.on("disconnect", (error) => {
      this.#lastError = error.message;
      for (const [traceId] of this.#runState) {
        const trace = getTrace(traceId);
        if (trace && ["starting", "running"].includes(trace.status)) {
          updateTrace(traceId, {
            status: "interrupted",
            endedAt: new Date().toISOString(),
            errorMessage: "Hermes Gateway 连接中断，SessionDB 补全仍可继续使用。",
            captureCompleteness: "partial",
          });
          this.#notify?.(traceId);
        }
      }
    });
  }

  setNotify(notify) {
    this.#notify = notify;
  }

  status() {
    const storage = getHermesStorageStatus();
    return {
      ...this.#probe,
      connected: this.#gateway.connected,
      gatewayUrl: this.#gatewayUrl,
      runtimeCheck: this.#runtimeCheck,
      storage,
      observer: {
        installed: existsSync(OBSERVER_PLUGIN_PATH),
        enabled: isObserverEnabled(),
        tokenReady: existsSync(OBSERVER_TOKEN_PATH),
        sourcePath: resolve(process.cwd(), "hermes-plugin", "agent-trace-observer"),
      },
      captureChannels: {
        gateway: this.#gateway.connected,
        observer: existsSync(OBSERVER_PLUGIN_PATH) && isObserverEnabled(),
        sessionDb: storage.available,
      },
      lastError: this.#lastError,
    };
  }

  async connect() {
    if (this.#gateway.connected) return this.status();
    if (this.#connectPromise) return this.#connectPromise;
    if (!this.#probe.installed) throw new Error(this.#probe.error || "没有安装 Hermes CLI。");

    this.#connectPromise = this.#connect();
    try {
      await this.#connectPromise;
      return this.status();
    } finally {
      this.#connectPromise = null;
    }
  }

  async #connect() {
    const token = ensureObserverToken();
    const configuredUrl = process.env.HERMES_GATEWAY_URL;
    const configuredToken = process.env.HERMES_GATEWAY_TOKEN;
    if (configuredUrl) {
      if (!configuredToken) {
        throw new Error("设置 HERMES_GATEWAY_URL 时必须同时提供 HERMES_GATEWAY_TOKEN。");
      }
      const wsUrl = toGatewayUrl(configuredUrl, configuredToken);
      await this.#gateway.connect(wsUrl);
      this.#gatewayUrl = new URL(wsUrl).origin.replace(/^http/, "ws");
    } else {
      const port = Number(process.env.HERMES_TRACE_GATEWAY_PORT || 9124);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        throw new Error("HERMES_TRACE_GATEWAY_PORT 必须是 1024–65535 的端口。");
      }
      const base = `ws://127.0.0.1:${port}`;
      const wsUrl = toGatewayUrl(base, token);
      await this.#startServe(port, token);
      await this.#gateway.connect(wsUrl, 30_000);
      this.#gatewayUrl = base;
    }

    const [runtimeCheck, models, toolsets] = await Promise.all([
      this.#gateway.request("setup.runtime_check", {}, 20_000).catch((error) => ({ ok: false, error: error.message })),
      this.#gateway.request("model.options", { explicit_only: true }, 20_000).catch(() => null),
      this.#gateway.request("toolsets.list", {}, 20_000).catch(() => null),
    ]);
    this.#runtimeCheck = {
      ...runtimeCheck,
      modelOptionsAvailable: Boolean(models),
      toolsetCount: Array.isArray(toolsets?.toolsets) ? toolsets.toolsets.length : null,
    };
    this.#lastError = null;
  }

  #startServe(port, observerToken) {
    if (this.#serveProcess && this.#serveProcess.exitCode == null) return Promise.resolve();
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        hermesBinary(),
        ["serve", "--host", "127.0.0.1", "--port", String(port), "--skip-build"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            HERMES_DASHBOARD_SESSION_TOKEN: observerToken,
            HERMES_TRACE_OBSERVER_TOKEN: observerToken,
            HERMES_TRACE_OBSERVER_URL:
              process.env.HERMES_TRACE_OBSERVER_URL ||
              `http://127.0.0.1:${process.env.HERMES_TRACE_PORT || 4318}/api/hermes/observer/events`,
          },
        },
      );
      this.#serveProcess = child;
      let settled = false;
      let stderr = "";
      const timeout = setTimeout(() => finish(new Error("启动 hermes serve 超时。")), 30_000);

      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        if (text.includes("HERMES_BACKEND_READY") || text.includes("Hermes backend listening")) {
          finish();
        }
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 16_000) stderr += String(chunk);
      });
      child.on("error", (error) => finish(error));
      child.on("exit", (code) => {
        this.#serveProcess = null;
        if (!settled) {
          finish(
            new Error(
              stderr.trim().split("\n").at(-1) || `hermes serve 提前退出（code ${code ?? "?"}）。`,
            ),
          );
        }
      });
    });
  }

  async startTurn(options) {
    await this.connect();
    const created = await this.#gateway.request("session.create", {
      cwd: options.cwd,
      title: titleFromPrompt(options.prompt),
      source: "hermes-trace-studio",
      close_on_disconnect: false,
      ...(options.model ? { model: options.model } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
      ...(options.fast != null ? { fast: Boolean(options.fast) } : {}),
    });
    const traceId = randomUUID();
    const liveSessionId = created.session_id;
    const storedSessionId = created.stored_session_id || liveSessionId;
    const startedAt = new Date().toISOString();
    const trace = createTrace({
      id: traceId,
      externalId: `hermes-gateway:${storedSessionId}:${traceId}`,
      source: "hermes-gateway",
      title: titleFromPrompt(options.prompt),
      status: "starting",
      cwd: options.cwd,
      model: options.model || created.info?.model,
      provider: options.provider || created.info?.provider,
      profile: options.profile || created.info?.profile_name,
      userPrompt: options.prompt,
      startedAt,
      hermesSessionId: storedSessionId,
      hermesVersion: this.#probe.version,
      captureMode: "gateway",
      captureCompleteness: "partial",
      promptLayers: [promptLayer("user", "用户请求", "prompt.submit.text", options.prompt)],
    });

    const state = {
      traceId,
      liveSessionId,
      storedSessionId,
      sequence: 0,
      assistantText: "",
      reasoningText: "",
      thinkingText: "",
      observerSeen: false,
      observerUsage: new Map(),
    };
    this.#runState.set(traceId, state);
    this.#activeBySession.set(liveSessionId, traceId);
    this.#activeBySession.set(storedSessionId, traceId);

    appendRawEvent(traceId, "gateway.session.create", created, startedAt);
    upsertEvent(traceId, {
      externalId: "user:request",
      timestamp: startedAt,
      kind: "user_message",
      category: "user",
      actor: "user",
      title: titleFromPrompt(options.prompt),
      status: "completed",
      evidence: "direct",
      captureChannel: "gateway",
      input: { text: options.prompt },
    });
    this.#notify?.(traceId);

    try {
      const submit = await this.#gateway.request("prompt.submit", {
        session_id: liveSessionId,
        text: options.prompt,
      });
      appendRawEvent(traceId, "gateway.prompt.submit", submit);
      updateTrace(traceId, { status: "running" });
      this.#notify?.(traceId);
      return getTrace(traceId);
    } catch (error) {
      const endedAt = new Date().toISOString();
      updateTrace(traceId, {
        status: "failed",
        endedAt,
        durationMs: traceDuration(trace, endedAt),
        errorMessage: error.message,
      });
      this.#notify?.(traceId);
      throw error;
    }
  }

  #recordGatewayEvent(event) {
    const traceId = this.#activeBySession.get(event.sessionId);
    if (!traceId) return;
    const state = this.#runState.get(traceId);
    if (!state) return;
    state.sequence += 1;
    const timestamp = new Date().toISOString();
    appendRawEvent(traceId, `gateway.${event.type}`, event.raw, timestamp);

    if (event.type === "message.delta") state.assistantText += String(event.payload.text || "");
    if (event.type === "reasoning.delta") state.reasoningText += String(event.payload.text || "");
    if (event.type === "thinking.delta") state.thinkingText += String(event.payload.text || "");

    const accumulatedText =
      event.type === "message.delta"
        ? state.assistantText
        : event.type === "reasoning.delta"
          ? state.reasoningText
          : event.type === "thinking.delta"
            ? state.thinkingText
            : undefined;
    const normalized = normalizeGatewayEvent(event.type, event.payload, {
      sequence: state.sequence,
      timestamp,
      accumulatedText,
    });
    if (normalized) upsertEvent(traceId, normalized);

    if (event.type === "session.info") {
      updateTrace(traceId, {
        model: event.payload.model,
        provider: event.payload.provider,
        profile: event.payload.profile_name,
        cwd: event.payload.cwd,
      });
    }
    if (event.type === "message.complete") {
      const trace = getTrace(traceId);
      const endedAt = timestamp;
      const status =
        event.payload.status === "error"
          ? "failed"
          : event.payload.status === "interrupted"
            ? "interrupted"
            : "completed";
      updateTrace(traceId, {
        status,
        endedAt,
        durationMs: traceDuration(trace, endedAt),
        errorMessage: event.payload.error || null,
        captureCompleteness: state.observerSeen ? "full" : "standard",
      });
      updateUsage(traceId, normalizeUsage(event.payload.usage || {}));
      setTimeout(() => {
        void reconcileTracePrompt(traceId, state.storedSessionId, trace.userPrompt, trace.profile).then(
          () => this.#notify?.(traceId),
        );
      }, 250).unref();
    }
    this.#notify?.(traceId);
  }

  listSessions(limit, profile) {
    return listHermesSessions(limit, profile);
  }

  importSession(sessionId, profile) {
    return importHermesSession(sessionId, this.#notify, profile);
  }

  async control(traceId, action) {
    const state = this.#runState.get(traceId);
    if (!state) throw new Error("该 Trace 没有可控制的 Hermes Live Session。");
    const sessionId = state.liveSessionId;
    if (action.type === "interrupt") {
      return this.#gateway.request("session.interrupt", { session_id: sessionId });
    }
    if (action.type === "steer") {
      return this.#gateway.request("session.steer", { session_id: sessionId, text: action.text });
    }
    if (action.type === "approval") {
      return this.#gateway.request("approval.respond", {
        session_id: sessionId,
        choice: action.choice || "deny",
        all: Boolean(action.all),
      });
    }
    if (action.type === "clarify") {
      return this.#gateway.request("clarify.respond", {
        session_id: sessionId,
        request_id: action.requestId,
        answer: action.answer || "",
      });
    }
    if (action.type === "sudo") {
      return this.#gateway.request("sudo.respond", {
        session_id: sessionId,
        request_id: action.requestId,
        password: action.value || "",
      });
    }
    if (action.type === "secret") {
      return this.#gateway.request("secret.respond", {
        session_id: sessionId,
        request_id: action.requestId,
        value: action.value || "",
      });
    }
    throw new Error(`不支持的 Hermes 控制动作：${action.type || "unknown"}`);
  }

  async ingestObserver(event) {
    const hook = String(event.hook || "");
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    if (!hook) throw new Error("Observer 事件缺少 hook。");
    const sessionId = String(payload.session_id || payload.task_id || "");
    const turnId = String(payload.turn_id || "");
    let traceId = this.#activeBySession.get(sessionId);
    if (!traceId) traceId = findTraceByHermesTurn(sessionId, turnId)?.id;

    if (!traceId && hook === "pre_llm_call" && sessionId) {
      const userPrompt = String(payload.user_message || "");
      const trace = createTrace({
        id: randomUUID(),
        externalId: `hermes-observer:${sessionId}:${turnId || randomUUID()}`,
        source: "hermes-observer",
        title: titleFromPrompt(userPrompt),
        status: "running",
        model: payload.model,
        provider: payload.provider,
        userPrompt,
        hermesSessionId: sessionId,
        hermesTurnId: turnId || null,
        hermesVersion: this.#probe.version,
        captureMode: "observer",
        captureCompleteness: "partial",
        promptLayers: [promptLayer("user", "用户请求", "observer.pre_llm_call", userPrompt)],
      });
      traceId = trace.id;
      this.#activeBySession.set(sessionId, traceId);
      this.#runState.set(traceId, {
        traceId,
        liveSessionId: sessionId,
        storedSessionId: sessionId,
        sequence: 0,
        assistantText: "",
        reasoningText: "",
        thinkingText: "",
        observerSeen: true,
        observerUsage: new Map(),
      });
      upsertEvent(traceId, {
        externalId: "user:request",
        timestamp: event.timestamp,
        kind: "user_message",
        category: "user",
        actor: "user",
        title: titleFromPrompt(userPrompt),
        status: "completed",
        evidence: "direct",
        captureChannel: "observer",
        turnId,
        input: { text: userPrompt },
      });
    }
    if (!traceId) return { accepted: false, reason: "no-active-turn" };

    const state = this.#runState.get(traceId);
    if (state) state.observerSeen = true;
    const timestamp = event.timestamp || new Date().toISOString();
    appendRawEvent(traceId, `observer.${hook}`, payload, timestamp);
    const normalized = normalizeObserverHook(hook, payload, timestamp);
    upsertEvent(traceId, normalized);
    updateTrace(traceId, {
      hermesTurnId: turnId || undefined,
      captureCompleteness: "full",
      model: payload.model || undefined,
      provider: payload.provider || undefined,
    });

    if (hook === "pre_api_request" && payload.request) {
      const trace = getTrace(traceId);
      const layer = promptLayer(
        "provider-request",
        `Provider 请求 ${payload.api_call_count || ""}`.trim(),
        `observer.pre_api_request:${payload.api_request_id || "unknown"}`,
        payload.request,
      );
      const layers = [...(trace.promptLayers || []).filter((item) => item.id !== layer.id), layer];
      setPromptLayers(traceId, layers);
    }
    if (hook === "post_api_request" && payload.usage) {
      const usage = normalizeUsage(payload.usage);
      const usageState = this.#runState.get(traceId);
      if (usageState) {
        usageState.observerUsage ||= new Map();
        usageState.observerUsage.set(
          payload.api_request_id || `request-${usageState.observerUsage.size + 1}`,
          usage,
        );
        const total = [...usageState.observerUsage.values()].reduce(
          (sum, item) => ({
            inputTokens: sum.inputTokens + item.inputTokens,
            outputTokens: sum.outputTokens + item.outputTokens,
            cachedInputTokens: sum.cachedInputTokens + item.cachedInputTokens,
            reasoningTokens: sum.reasoningTokens + item.reasoningTokens,
          }),
          { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
        );
        updateUsage(traceId, total);
      } else {
        updateUsage(traceId, usage);
      }
    }
    if (hook === "post_llm_call") {
      const trace = getTrace(traceId);
      const endedAt = timestamp;
      updateTrace(traceId, {
        status: "completed",
        endedAt,
        durationMs: traceDuration(trace, endedAt),
        captureCompleteness: "full",
      });
      setTimeout(() => {
        void reconcileTracePrompt(traceId, sessionId, trace.userPrompt, trace.profile).then(() =>
          this.#notify?.(traceId),
        );
      }, 250).unref();
    }
    this.#notify?.(traceId);
    return { accepted: true, traceId };
  }

  observerTokenMatches(value) {
    if (!value) return false;
    try {
      return value === ensureObserverToken();
    } catch {
      return false;
    }
  }

  shutdown() {
    this.#gateway.close();
    if (this.#serveProcess && this.#serveProcess.exitCode == null) {
      this.#serveProcess.kill("SIGTERM");
    }
    this.#serveProcess = null;
  }
}

export const hermesRuntime = new HermesRuntime();
