import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  appendRawEvent,
  createTrace,
  setPromptLayers,
  updateTrace,
  upsertEvent,
} from "../store.mjs";
import { classifyTool, promptLayer, titleFromPrompt } from "./normalizer.mjs";

function hermesHome(profile) {
  const root = resolve(process.env.HERMES_HOME || `${homedir()}/.hermes`);
  if (!profile) return root;
  const safe = String(profile).trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(safe)) throw new Error("Hermes Profile 名称无效。");
  return resolve(root, "profiles", safe);
}

export function hermesStatePath(profile) {
  return resolve(hermesHome(profile), "state.db");
}

function openState(profile) {
  const path = hermesStatePath(profile);
  if (!existsSync(path)) return null;
  return new DatabaseSync(path, { readOnly: true });
}

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function asIso(value, fallback = new Date().toISOString()) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    return new Date(number < 10_000_000_000 ? number * 1000 : number).toISOString();
  }
  return fallback;
}

function contentText(value) {
  if (typeof value !== "string") return String(value || "");
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return value;
  return parsed
    .map((part) => (typeof part === "string" ? part : part?.text || part?.content || ""))
    .filter(Boolean)
    .join("\n");
}

function safeToolArguments(value) {
  if (value && typeof value === "object") return value;
  return parseJson(value, value || {});
}

function toolCalls(message) {
  const parsed = parseJson(message.tool_calls, []);
  return Array.isArray(parsed) ? parsed : [];
}

async function optionalText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

export async function promptLayersForSession(session, userPrompt) {
  const layers = [];
  if (session.system_prompt) {
    layers.push(
      promptLayer(
        "effective-system",
        "Hermes Effective System Prompt",
        "state.db.sessions.system_prompt",
        session.system_prompt,
        "reconciled",
      ),
    );
  }

  const home = hermesHome(session.profile_name || undefined);
  const soul = await optionalText(resolve(home, "SOUL.md"));
  if (soul) layers.push(promptLayer("identity", "SOUL.md", resolve(home, "SOUL.md"), soul, "direct"));

  if (session.cwd) {
    for (const name of [".hermes.md", "AGENTS.md", "CLAUDE.md", ".cursorrules"]) {
      const path = resolve(session.cwd, name);
      const content = await optionalText(path);
      if (content) layers.push(promptLayer("project", name, path, content, "direct"));
    }
  }

  if (userPrompt) {
    layers.push(promptLayer("user", "用户请求", "state.db.messages[user]", userPrompt, "direct"));
  }
  return layers;
}

export function getHermesStorageStatus(profile) {
  const path = hermesStatePath(profile);
  if (!existsSync(path)) return { available: false, path, schemaVersion: null };
  let db;
  try {
    db = openState(profile);
    const row = db?.prepare("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1").get();
    return { available: true, path, schemaVersion: Number(row?.version || 0) || null };
  } catch (error) {
    return { available: false, path, schemaVersion: null, error: error.message };
  } finally {
    db?.close();
  }
}

export function listHermesSessions(limit = 100, profile) {
  const db = openState(profile);
  if (!db) return [];
  try {
    const rows = db
      .prepare(`
        SELECT s.*,
          COALESCE(
            (SELECT content FROM messages m
             WHERE m.session_id = s.id AND m.role = 'user' AND m.active = 1
               AND (m.display_kind IS NULL OR m.display_kind = '')
             ORDER BY m.id DESC LIMIT 1),
            ''
          ) AS preview
        FROM sessions s
        WHERE LOWER(COALESCE(s.source, '')) NOT IN ('tool', 'kanban')
        ORDER BY COALESCE(s.ended_at, s.started_at) DESC
        LIMIT ?
      `)
      .all(Math.max(1, Math.min(Number(limit) || 100, 500)));
    return rows.map((row) => ({
      id: row.id,
      title: row.title || titleFromPrompt(contentText(row.preview)),
      preview: contentText(row.preview),
      cwd: row.cwd,
      model: row.model,
      source: row.source,
      profile: row.profile_name || profile || null,
      timestamp: asIso(row.ended_at || row.started_at),
      messageCount: Number(row.message_count || 0),
      toolCallCount: Number(row.tool_call_count || 0),
      parentSessionId: row.parent_session_id,
      costUsd: Number(row.actual_cost_usd ?? row.estimated_cost_usd ?? 0),
    }));
  } finally {
    db.close();
  }
}

export function readHermesSession(sessionId, profile) {
  const db = openState(profile);
  if (!db) throw new Error("没有找到 Hermes state.db。");
  try {
    const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(String(sessionId));
    if (!session) throw new Error("Hermes Session 不存在。");
    const messages = db
      .prepare("SELECT * FROM messages WHERE session_id = ? AND active = 1 ORDER BY id ASC")
      .all(String(sessionId));
    return { session, messages };
  } finally {
    db.close();
  }
}

function normalizeStoredToolStart(traceId, message, call) {
  const functionCall = call.function || call;
  const name = functionCall.name || call.name || "tool";
  const callId = call.id || call.tool_call_id || `message-${message.id}-${name}`;
  const meta = classifyTool(name);
  upsertEvent(traceId, {
    externalId: `tool:${callId}`,
    timestamp: asIso(message.timestamp),
    kind: meta.kind,
    category: meta.category,
    actor: meta.actor,
    title: meta.mcp ? `${meta.mcp.server} / ${meta.mcp.tool}` : name,
    status: "running",
    evidence: "reconciled",
    captureChannel: "session_db",
    toolCallId: callId,
    input: { name, args: safeToolArguments(functionCall.arguments), ...(meta.mcp || {}) },
    raw: call,
  });
}

function normalizeStoredMessage(traceId, message) {
  const timestamp = asIso(message.timestamp);
  const text = contentText(message.content);
  const reasoning = [message.reasoning, message.reasoning_content]
    .map(contentText)
    .filter(Boolean)
    .join("\n");
  if (reasoning) {
    upsertEvent(traceId, {
      externalId: `reasoning:${message.id}`,
      timestamp,
      kind: "reasoning_summary",
      category: "reasoning",
      actor: "agent",
      title: titleFromPrompt(reasoning),
      status: "completed",
      evidence: "reconciled",
      captureChannel: "session_db",
      output: {
        text: reasoning,
        note: "Hermes SessionDB 中显式保存的 reasoning，不代表未公开的隐藏思维链。",
      },
    });
  }

  for (const call of toolCalls(message)) normalizeStoredToolStart(traceId, message, call);

  if (message.role === "tool") {
    const callId = message.tool_call_id || `message-${message.id}-${message.tool_name || "tool"}`;
    const meta = classifyTool(message.tool_name);
    upsertEvent(traceId, {
      externalId: `tool:${callId}`,
      timestamp,
      completedAt: timestamp,
      kind: meta.kind,
      category: meta.category,
      actor: meta.actor,
      title: meta.mcp
        ? `${meta.mcp.server} / ${meta.mcp.tool}`
        : message.tool_name || "Hermes Tool",
      status: message.effect_disposition === "error" ? "error" : "completed",
      evidence: "reconciled",
      captureChannel: "session_db",
      toolCallId: callId,
      output: { result: parseJson(message.content, text), finishReason: message.finish_reason },
      raw: message,
    });
    return;
  }

  if (message.role === "assistant" && text) {
    upsertEvent(traceId, {
      externalId: `message:${message.id}`,
      timestamp,
      kind: "agent_message",
      category: "agent",
      actor: "agent",
      title: titleFromPrompt(text),
      status: message.finish_reason === "error" ? "error" : "completed",
      evidence: "reconciled",
      captureChannel: "session_db",
      output: { text, finishReason: message.finish_reason },
      raw: message,
    });
  }
}

export async function importHermesSession(sessionId, notify, profile) {
  const { session, messages } = readHermesSession(sessionId, profile);
  const userIndexes = messages
    .map((message, index) => ({ message, index }))
    .filter(
      ({ message }) =>
        message.role === "user" && (!message.display_kind || message.display_kind === ""),
    );
  const traceIds = [];

  for (let ordinal = 0; ordinal < userIndexes.length; ordinal += 1) {
    const current = userIndexes[ordinal];
    const nextIndex = userIndexes[ordinal + 1]?.index ?? messages.length;
    const group = messages.slice(current.index, nextIndex);
    const userPrompt = contentText(current.message.content);
    const startedAt = asIso(current.message.timestamp);
    const endedAt = asIso(group.at(-1)?.timestamp, startedAt);
    const externalId = `hermes-history:${session.id}:${current.message.id}`;
    const trace = createTrace({
      id: randomUUID(),
      externalId,
      source: "hermes-history",
      title: titleFromPrompt(userPrompt),
      status: session.ended_at || ordinal < userIndexes.length - 1 ? "completed" : "completed",
      cwd: session.cwd,
      model: session.model,
      provider: session.billing_provider,
      profile: session.profile_name || profile || null,
      userPrompt,
      startedAt,
      hermesSessionId: session.id,
      hermesTurnId: `message-${current.message.id}`,
      captureMode: "history",
      captureCompleteness: "history",
      promptLayers: await promptLayersForSession(session, userPrompt),
    });

    appendRawEvent(trace.id, "session_db.session", {
      id: session.id,
      source: session.source,
      model: session.model,
      cwd: session.cwd,
      parentSessionId: session.parent_session_id,
    });
    upsertEvent(trace.id, {
      externalId: `message:${current.message.id}`,
      timestamp: startedAt,
      kind: "user_message",
      category: "user",
      actor: "user",
      title: titleFromPrompt(userPrompt),
      status: "completed",
      evidence: "reconciled",
      captureChannel: "session_db",
      input: { text: userPrompt },
      raw: current.message,
    });
    for (const message of group.slice(1)) {
      appendRawEvent(trace.id, `session_db.message:${message.role}`, message, asIso(message.timestamp));
      normalizeStoredMessage(trace.id, message);
    }

    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
    updateTrace(trace.id, { status: "completed", endedAt, durationMs });
    setPromptLayers(trace.id, await promptLayersForSession(session, userPrompt));
    upsertEvent(trace.id, {
      externalId: "session:aggregate-usage",
      timestamp: endedAt,
      kind: "session_usage",
      category: "system",
      actor: "system",
      title: "Hermes Session 汇总用量",
      status: "completed",
      evidence: "reconciled",
      captureChannel: "session_db",
      output: {
        inputTokens: Number(session.input_tokens || 0),
        outputTokens: Number(session.output_tokens || 0),
        cacheReadTokens: Number(session.cache_read_tokens || 0),
        reasoningTokens: Number(session.reasoning_tokens || 0),
        costUsd: Number(session.actual_cost_usd ?? session.estimated_cost_usd ?? 0),
      },
      detail: { note: "这是整个 Session 的汇总，不能准确分摊到单个用户 Turn。" },
    });
    traceIds.push(trace.id);
    notify?.(trace.id);
  }

  return traceIds;
}

export async function reconcileTracePrompt(traceId, sessionId, userPrompt, profile) {
  try {
    const { session } = readHermesSession(sessionId, profile);
    const layers = await promptLayersForSession(session, userPrompt);
    setPromptLayers(traceId, layers);
    updateTrace(traceId, {
      captureCompleteness: "standard",
      provider: session.billing_provider,
      model: session.model,
    });
    return layers;
  } catch {
    return null;
  }
}

export function sessionFingerprint(sessionId, turnId) {
  return createHash("sha256").update(`${sessionId}:${turnId || ""}`).digest("hex").slice(0, 24);
}
