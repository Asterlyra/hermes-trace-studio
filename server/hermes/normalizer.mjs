import { createHash } from "node:crypto";
import { redactText } from "../redaction.mjs";

function compactText(value, max = 88) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function eventId(prefix, ...parts) {
  const value = parts.filter(Boolean).join(":");
  if (value) return `${prefix}:${value}`;
  return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

export function titleFromPrompt(prompt) {
  return compactText(String(prompt || "").split("\n")[0], 72) || "新建 Hermes Trace";
}

export function promptLayer(kind, title, source, content, evidence = "direct") {
  const safeContent = redactText(
    typeof content === "string" ? content : JSON.stringify(content ?? null, null, 2),
  );
  return {
    id: createHash("sha256").update(`${kind}:${source}:${safeContent}`).digest("hex").slice(0, 16),
    kind,
    title,
    source,
    evidence,
    content: safeContent,
    charCount: safeContent.length,
    hash: createHash("sha256").update(safeContent).digest("hex"),
  };
}

export function parseMcpToolName(name) {
  const match = String(name || "").match(/^mcp__([^_].*?)__(.+)$/);
  return match ? { server: match[1], tool: match[2] } : null;
}

export function classifyTool(name) {
  const toolName = String(name || "tool");
  const mcp = parseMcpToolName(toolName);
  if (mcp) return { kind: "mcp_call", category: "mcp", actor: "mcp", mcp };
  if (["skill_view", "skills_list", "skill_manage"].includes(toolName)) {
    return { kind: "skill_usage", category: "skill", actor: "skill", mcp: null };
  }
  if (["delegate_task", "parallel", "spawn_agent"].includes(toolName)) {
    return { kind: "subagent_call", category: "subagent", actor: "subagent", mcp: null };
  }
  if (["web_search", "web_extract", "browser"].includes(toolName)) {
    return { kind: "web_call", category: "web", actor: "tool", mcp: null };
  }
  if (["read_file", "write_file", "patch", "search_files"].includes(toolName)) {
    return { kind: "file_tool", category: "file", actor: "tool", mcp: null };
  }
  return { kind: "tool_call", category: "tool", actor: "tool", mcp: null };
}

function statusFromGateway(value, fallback = "completed") {
  if (value === "complete" || value === "ok") return "completed";
  if (value === "error") return "error";
  if (value === "interrupted") return "interrupted";
  return value || fallback;
}

export function normalizeGatewayEvent(type, payload = {}, context = {}) {
  const timestamp = context.timestamp || new Date().toISOString();
  const base = {
    timestamp,
    captureChannel: "gateway",
    evidence: "direct",
    raw: payload,
  };

  if (type === "message.start") {
    return {
      ...base,
      externalId: "assistant:response",
      startedAt: timestamp,
      kind: "agent_message",
      category: "agent",
      actor: "agent",
      title: "Hermes 正在回复",
      status: "running",
    };
  }
  if (type === "message.delta") {
    return {
      ...base,
      externalId: "assistant:response",
      kind: "agent_message",
      category: "agent",
      actor: "agent",
      title: compactText(context.accumulatedText || payload.text) || "Hermes 正在回复",
      status: "running",
      output: { text: context.accumulatedText || payload.text || "", streaming: true },
    };
  }
  if (type === "message.interim") {
    return {
      ...base,
      externalId: eventId("assistant-interim", context.sequence),
      kind: "agent_interim",
      category: "agent",
      actor: "agent",
      title: compactText(payload.text) || "Hermes 阶段性说明",
      status: "completed",
      output: payload,
    };
  }
  if (type === "message.complete") {
    return {
      ...base,
      externalId: "assistant:response",
      completedAt: timestamp,
      kind: "agent_message",
      category: "agent",
      actor: "agent",
      title: compactText(payload.text) || "Hermes 回复完成",
      status: statusFromGateway(payload.status),
      output: {
        text: payload.text || "",
        reasoning: payload.reasoning,
        warning: payload.warning,
        billing: payload.billing,
      },
    };
  }
  if (["reasoning.delta", "thinking.delta", "reasoning.available"].includes(type)) {
    const isThinking = type === "thinking.delta";
    return {
      ...base,
      externalId: isThinking ? "thinking:stream" : "reasoning:stream",
      kind: isThinking ? "thinking_stream" : "reasoning_summary",
      category: "reasoning",
      actor: "agent",
      title: compactText(context.accumulatedText || payload.text) || "可观测推理",
      status: type.endsWith("delta") ? "running" : "completed",
      output: {
        text: context.accumulatedText || payload.text || "",
        note: "Hermes 显式提供的推理或思考文本，不代表未公开的隐藏思维链。",
      },
    };
  }
  if (type === "tool.start" || type === "tool.complete" || type === "tool.output_risk") {
    const name = payload.name || "tool";
    const meta = classifyTool(name);
    const toolId = payload.tool_id || context.sequence;
    return {
      ...base,
      externalId: eventId("tool", toolId),
      startedAt: type === "tool.start" ? timestamp : undefined,
      completedAt: type === "tool.complete" ? timestamp : undefined,
      durationMs:
        payload.duration_s == null ? undefined : Math.max(0, Math.round(payload.duration_s * 1000)),
      kind: type === "tool.output_risk" ? "tool_output_risk" : meta.kind,
      category: type === "tool.output_risk" ? "error" : meta.category,
      actor: meta.actor,
      title: meta.mcp ? `${meta.mcp.server} / ${meta.mcp.tool}` : name,
      status: type === "tool.start" ? "running" : type === "tool.output_risk" ? "warning" : "completed",
      toolCallId: payload.tool_id || null,
      input: {
        name,
        args: payload.args,
        context: payload.context,
        ...(meta.mcp || {}),
      },
      output:
        type === "tool.complete"
          ? { result: payload.result, summary: payload.summary, inlineDiff: payload.inline_diff }
          : type === "tool.output_risk"
            ? payload
            : undefined,
      detail: { argsText: payload.args_text, resultText: payload.result_text },
    };
  }
  if (type.startsWith("subagent.")) {
    const identity = payload.subagent_id || payload.child_session_id || context.sequence;
    const completed = type === "subagent.complete";
    return {
      ...base,
      externalId: eventId("subagent", identity),
      startedAt: type === "subagent.start" ? timestamp : undefined,
      completedAt: completed ? timestamp : undefined,
      durationMs:
        payload.duration_seconds == null
          ? undefined
          : Math.max(0, Math.round(payload.duration_seconds * 1000)),
      kind: type.replaceAll(".", "_"),
      category: "subagent",
      actor: "subagent",
      title: compactText(payload.goal || payload.summary || payload.text) || "Hermes 子 Agent",
      status: completed ? statusFromGateway(payload.status) : "running",
      childSessionId: payload.child_session_id || null,
      parentId: payload.parent_id ? `subagent:${payload.parent_id}` : null,
      input: { goal: payload.goal, model: payload.model, toolsets: payload.toolsets },
      output: completed ? payload : undefined,
      detail: payload,
    };
  }
  if (type.endsWith(".request") || type.endsWith(".expire")) {
    const family = type.split(".")[0];
    return {
      ...base,
      externalId: eventId(family, payload.request_id || context.sequence),
      kind: type.replaceAll(".", "_"),
      category: family === "approval" ? "approval" : "interaction",
      actor: "system",
      title: type.endsWith(".expire") ? `${family} 请求已过期` : `${family} 请求等待响应`,
      status: type.endsWith(".expire") ? "expired" : "waiting",
      input: payload,
    };
  }
  if (type === "status.update") {
    return {
      ...base,
      externalId: eventId("status", context.sequence),
      kind: payload.kind === "compacting" ? "context_compaction" : "status_update",
      category: payload.kind === "compacting" ? "context" : "system",
      actor: "system",
      title: compactText(payload.text) || "Hermes 状态更新",
      status: "completed",
      output: payload,
    };
  }
  if (type === "error") {
    return {
      ...base,
      externalId: eventId("error", context.sequence),
      kind: "runtime_error",
      category: "error",
      actor: "system",
      title: compactText(payload.message) || "Hermes 运行错误",
      status: "error",
      output: payload,
    };
  }
  if (type === "session.info") {
    return {
      ...base,
      externalId: "session:info",
      kind: "session_info",
      category: "system",
      actor: "system",
      title: "Hermes Session 信息",
      status: "completed",
      output: payload,
    };
  }
  return {
    ...base,
    externalId: eventId("unknown", type, context.sequence),
    kind: type || "unknown",
    category: "system",
    actor: "system",
    title: `未识别 Hermes 事件 · ${type || "unknown"}`,
    status: "completed",
    detail: payload,
  };
}

export function normalizeObserverHook(hook, payload = {}, timestamp = new Date().toISOString()) {
  const common = {
    timestamp,
    captureChannel: "observer",
    telemetrySchemaVersion: payload.telemetry_schema_version,
    turnId: payload.turn_id,
    apiRequestId: payload.api_request_id,
    toolCallId: payload.tool_call_id,
    evidence: "direct",
    raw: payload,
  };

  if (hook === "pre_llm_call" || hook === "post_llm_call") {
    const completed = hook === "post_llm_call";
    return {
      ...common,
      externalId: eventId("turn", payload.turn_id || payload.session_id),
      startedAt: completed ? undefined : timestamp,
      completedAt: completed ? timestamp : undefined,
      kind: completed ? "turn_completed" : "turn_started",
      category: "agent",
      actor: "agent",
      title: completed ? "Hermes Turn 完成" : compactText(payload.user_message) || "Hermes Turn 开始",
      status: completed ? "completed" : "running",
      input: completed ? undefined : { userMessage: payload.user_message, model: payload.model },
      output: completed ? { assistantResponse: payload.assistant_response } : undefined,
      detail: { platform: payload.platform, isFirstTurn: payload.is_first_turn },
    };
  }
  if (["pre_api_request", "post_api_request", "api_request_error"].includes(hook)) {
    const started = hook === "pre_api_request";
    const failed = hook === "api_request_error";
    return {
      ...common,
      externalId: eventId("llm", payload.api_request_id || payload.api_call_count),
      startedAt: started ? timestamp : undefined,
      completedAt: started ? undefined : timestamp,
      durationMs:
        payload.api_duration == null ? undefined : Math.max(0, Math.round(payload.api_duration * 1000)),
      kind: "llm_request",
      category: "llm",
      actor: "agent",
      title: `${payload.provider || "provider"} / ${payload.model || "model"}`,
      status: started ? "running" : failed ? "error" : "completed",
      input: { request: payload.request, messageCount: payload.message_count, toolCount: payload.tool_count },
      output: failed ? { error: payload.error } : { response: payload.response, usage: payload.usage },
      detail: {
        apiMode: payload.api_mode,
        baseUrl: payload.base_url,
        finishReason: payload.finish_reason,
        retryCount: payload.retry_count,
      },
    };
  }
  if (hook === "pre_tool_call" || hook === "post_tool_call") {
    const completed = hook === "post_tool_call";
    const meta = classifyTool(payload.tool_name);
    return {
      ...common,
      externalId: eventId("tool", payload.tool_call_id || payload.tool_name),
      startedAt: completed ? undefined : timestamp,
      completedAt: completed ? timestamp : undefined,
      durationMs: payload.duration_ms,
      kind: meta.kind,
      category: meta.category,
      actor: meta.actor,
      title: meta.mcp ? `${meta.mcp.server} / ${meta.mcp.tool}` : payload.tool_name || "tool",
      status: completed ? statusFromGateway(payload.status) : "running",
      input: { name: payload.tool_name, args: payload.args, ...(meta.mcp || {}) },
      output: completed ? { result: payload.result, error: payload.error_message } : undefined,
      detail: { errorType: payload.error_type },
    };
  }
  if (hook === "subagent_start" || hook === "subagent_stop") {
    const completed = hook === "subagent_stop";
    const child = payload.child_subagent_id || payload.child_session_id;
    return {
      ...common,
      externalId: eventId("subagent", child),
      startedAt: completed ? undefined : timestamp,
      completedAt: completed ? timestamp : undefined,
      durationMs: payload.duration_ms,
      kind: completed ? "subagent_completed" : "subagent_started",
      category: "subagent",
      actor: "subagent",
      title: compactText(payload.child_goal || payload.child_summary) || "Hermes 子 Agent",
      status: completed ? statusFromGateway(payload.status) : "running",
      childSessionId: payload.child_session_id,
      input: { goal: payload.child_goal, role: payload.child_role },
      output: completed ? { summary: payload.child_summary, toolHistory: payload.tool_call_history } : undefined,
    };
  }
  if (hook === "pre_approval_request" || hook === "post_approval_response") {
    const completed = hook === "post_approval_response";
    return {
      ...common,
      externalId: eventId("approval", payload.pattern_key || payload.command),
      startedAt: completed ? undefined : timestamp,
      completedAt: completed ? timestamp : undefined,
      kind: completed ? "approval_resolved" : "approval_requested",
      category: "approval",
      actor: "system",
      title: completed ? `审批结果 · ${payload.choice || "unknown"}` : "Hermes 请求危险操作审批",
      status: completed ? statusFromGateway(payload.choice, "completed") : "waiting",
      input: completed ? undefined : { command: payload.command, description: payload.description },
      output: completed ? { choice: payload.choice } : undefined,
      detail: { surface: payload.surface, patternKey: payload.pattern_key },
    };
  }
  return {
    ...common,
    externalId: eventId("observer", hook, payload.turn_id, payload.api_request_id),
    kind: hook,
    category: "system",
    actor: "system",
    title: `Hermes Observer · ${hook}`,
    status: "completed",
    detail: payload,
  };
}

export function normalizeUsage(usage = {}) {
  const inputTokens = Number(
    usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens ?? 0,
  );
  const outputTokens = Number(
    usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens ?? 0,
  );
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: Number(
      usage.cache_read_tokens ?? usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
    ),
    reasoningTokens: Number(usage.reasoning_tokens ?? usage.reasoningTokens ?? 0),
  };
}
