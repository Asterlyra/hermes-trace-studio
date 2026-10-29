import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseJson, redactText, safeJson } from "./redaction.mjs";

const DATA_DIR = resolve(process.env.HERMES_TRACE_DATA_DIR || ".hermes-trace");
export const DATABASE_PATH = resolve(DATA_DIR, "traces.db");

mkdirSync(dirname(DATABASE_PATH), { recursive: true });

const db = new DatabaseSync(DATABASE_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    external_id TEXT UNIQUE,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    cwd TEXT,
    model TEXT,
    user_prompt TEXT,
    session_path TEXT,
    prompt_layers_json TEXT NOT NULL DEFAULT '[]',
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_ms INTEGER,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trace_events (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    duration_ms INTEGER,
    kind TEXT NOT NULL,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    actor TEXT NOT NULL,
    status TEXT NOT NULL,
    evidence TEXT NOT NULL,
    parent_id TEXT,
    input_json TEXT,
    output_json TEXT,
    detail_json TEXT,
    raw_json TEXT,
    UNIQUE(trace_id, external_id)
  );

  CREATE TABLE IF NOT EXISTS raw_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL REFERENCES traces(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    source_type TEXT NOT NULL,
    payload_json TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_traces_started_at
  ON traces(started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_trace_events_trace_seq
  ON trace_events(trace_id, seq);

  CREATE INDEX IF NOT EXISTS idx_raw_events_trace_seq
  ON raw_events(trace_id, seq);
`);

function ensureColumn(table, name, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((column) => column.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

// Hermes evolves its runtime and telemetry independently of this local store.
// Keep the migration additive so existing local traces remain readable while
// the active product surface becomes Hermes-only.
for (const [name, definition] of [
  ["hermes_session_id", "TEXT"],
  ["hermes_turn_id", "TEXT"],
  ["hermes_version", "TEXT"],
  ["provider", "TEXT"],
  ["profile", "TEXT"],
  ["capture_mode", "TEXT NOT NULL DEFAULT 'gateway'"],
  ["capture_completeness", "TEXT NOT NULL DEFAULT 'partial'"],
  ["cost_usd", "REAL NOT NULL DEFAULT 0"],
]) {
  ensureColumn("traces", name, definition);
}

for (const [name, definition] of [
  ["capture_channel", "TEXT NOT NULL DEFAULT 'gateway'"],
  ["turn_id", "TEXT"],
  ["api_request_id", "TEXT"],
  ["tool_call_id", "TEXT"],
  ["child_session_id", "TEXT"],
  ["telemetry_schema_version", "TEXT"],
]) {
  ensureColumn("trace_events", name, definition);
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_traces_hermes_session_turn
  ON traces(hermes_session_id, hermes_turn_id);

  CREATE INDEX IF NOT EXISTS idx_trace_events_tool_call
  ON trace_events(trace_id, tool_call_id);
`);
db.exec("PRAGMA optimize");

function nowIso() {
  return new Date().toISOString();
}

function nextEventSequence(traceId) {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM trace_events WHERE trace_id = ?")
    .get(traceId);
  return Number(row?.seq || 1);
}

function nextRawSequence(traceId) {
  const row = db
    .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM raw_events WHERE trace_id = ?")
    .get(traceId);
  return Number(row?.seq || 1);
}

function mapTrace(row) {
  if (!row) return null;
  return {
    id: row.id,
    externalId: row.external_id,
    source: row.source,
    hermesSessionId: row.hermes_session_id,
    hermesTurnId: row.hermes_turn_id,
    hermesVersion: row.hermes_version,
    provider: row.provider,
    profile: row.profile,
    captureMode: row.capture_mode,
    captureCompleteness: row.capture_completeness,
    costUsd: Number(row.cost_usd || 0),
    title: row.title,
    status: row.status,
    cwd: row.cwd,
    model: row.model,
    userPrompt: row.user_prompt,
    sessionPath: row.session_path,
    promptLayers: parseJson(row.prompt_layers_json, []),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    cachedInputTokens: Number(row.cached_input_tokens || 0),
    reasoningTokens: Number(row.reasoning_tokens || 0),
    errorMessage: row.error_message,
    eventCount: Number(row.event_count || 0),
    toolCallCount: Number(row.tool_call_count || 0),
    errorCount: Number(row.error_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row) {
  return {
    id: row.id,
    traceId: row.trace_id,
    externalId: row.external_id,
    seq: Number(row.seq),
    timestamp: row.timestamp,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    kind: row.kind,
    category: row.category,
    title: row.title,
    actor: row.actor,
    status: row.status,
    evidence: row.evidence,
    captureChannel: row.capture_channel,
    turnId: row.turn_id,
    apiRequestId: row.api_request_id,
    toolCallId: row.tool_call_id,
    childSessionId: row.child_session_id,
    telemetrySchemaVersion: row.telemetry_schema_version,
    parentId: row.parent_id,
    input: parseJson(row.input_json),
    output: parseJson(row.output_json),
    detail: parseJson(row.detail_json),
    raw: parseJson(row.raw_json),
  };
}

export function createTrace(trace) {
  const createdAt = trace.createdAt || nowIso();
  const startedAt = trace.startedAt || createdAt;
  const externalId = trace.externalId || trace.id;
  db.prepare(`
    INSERT INTO traces (
      id, external_id, source, title, status, cwd, model, user_prompt,
      session_path, prompt_layers_json, started_at, created_at, updated_at,
      hermes_session_id, hermes_turn_id, hermes_version, provider, profile,
      capture_mode, capture_completeness, cost_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_id) DO UPDATE SET
      title = excluded.title,
      status = excluded.status,
      cwd = COALESCE(excluded.cwd, traces.cwd),
      model = COALESCE(excluded.model, traces.model),
      user_prompt = COALESCE(excluded.user_prompt, traces.user_prompt),
      session_path = COALESCE(excluded.session_path, traces.session_path),
      hermes_session_id = COALESCE(excluded.hermes_session_id, traces.hermes_session_id),
      hermes_turn_id = COALESCE(excluded.hermes_turn_id, traces.hermes_turn_id),
      hermes_version = COALESCE(excluded.hermes_version, traces.hermes_version),
      provider = COALESCE(excluded.provider, traces.provider),
      profile = COALESCE(excluded.profile, traces.profile),
      capture_mode = COALESCE(excluded.capture_mode, traces.capture_mode),
      capture_completeness = COALESCE(excluded.capture_completeness, traces.capture_completeness),
      cost_usd = COALESCE(excluded.cost_usd, traces.cost_usd),
      updated_at = excluded.updated_at
  `).run(
    trace.id,
    externalId,
    trace.source || "hermes-gateway",
    redactText(trace.title || "未命名 Trace"),
    trace.status || "running",
    trace.cwd || null,
    trace.model || null,
    redactText(trace.userPrompt || ""),
    trace.sessionPath || null,
    safeJson(trace.promptLayers || []),
    startedAt,
    createdAt,
    createdAt,
    trace.hermesSessionId || null,
    trace.hermesTurnId || null,
    trace.hermesVersion || null,
    trace.provider || null,
    trace.profile || null,
    trace.captureMode || "gateway",
    trace.captureCompleteness || "partial",
    Number(trace.costUsd || 0),
  );
  return findTraceByExternalId(externalId);
}

export function findTraceByExternalId(externalId) {
  return mapTrace(db.prepare("SELECT * FROM traces WHERE external_id = ?").get(externalId));
}

export function findTraceByHermesTurn(sessionId, turnId) {
  if (!sessionId) return null;
  if (turnId) {
    return mapTrace(
      db
        .prepare(
          "SELECT * FROM traces WHERE hermes_session_id = ? AND hermes_turn_id = ? ORDER BY started_at DESC LIMIT 1",
        )
        .get(sessionId, turnId),
    );
  }
  return mapTrace(
    db
      .prepare(
        "SELECT * FROM traces WHERE hermes_session_id = ? ORDER BY started_at DESC LIMIT 1",
      )
      .get(sessionId),
  );
}

export function updateTrace(traceId, patch) {
  const allowed = {
    status: "status",
    title: "title",
    cwd: "cwd",
    model: "model",
    userPrompt: "user_prompt",
    sessionPath: "session_path",
    startedAt: "started_at",
    endedAt: "ended_at",
    durationMs: "duration_ms",
    errorMessage: "error_message",
    hermesSessionId: "hermes_session_id",
    hermesTurnId: "hermes_turn_id",
    hermesVersion: "hermes_version",
    provider: "provider",
    profile: "profile",
    captureMode: "capture_mode",
    captureCompleteness: "capture_completeness",
    costUsd: "cost_usd",
  };
  const entries = Object.entries(patch).filter(([key, value]) => key in allowed && value !== undefined);
  if (!entries.length) return getTrace(traceId);
  const assignments = entries.map(([key]) => `${allowed[key]} = ?`);
  const values = entries.map(([key, value]) =>
    ["title", "userPrompt", "errorMessage"].includes(key) && value != null
      ? redactText(value)
      : value,
  );
  assignments.push("updated_at = ?");
  values.push(nowIso(), traceId);
  db.prepare(`UPDATE traces SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
  return getTrace(traceId);
}

export function updateUsage(traceId, usage = {}) {
  db.prepare(`
    UPDATE traces SET
      input_tokens = ?,
      output_tokens = ?,
      cached_input_tokens = ?,
      reasoning_tokens = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    Number(usage.inputTokens || 0),
    Number(usage.outputTokens || 0),
    Number(usage.cachedInputTokens || 0),
    Number(usage.reasoningOutputTokens || usage.reasoningTokens || 0),
    nowIso(),
    traceId,
  );
}

export function setPromptLayers(traceId, layers) {
  db.prepare("UPDATE traces SET prompt_layers_json = ?, updated_at = ? WHERE id = ?").run(
    safeJson(layers || []),
    nowIso(),
    traceId,
  );
}

export function appendRawEvent(traceId, sourceType, payload, timestamp = nowIso()) {
  const seq = nextRawSequence(traceId);
  db.prepare(`
    INSERT INTO raw_events (trace_id, seq, timestamp, source_type, payload_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(traceId, seq, timestamp, sourceType, safeJson(payload));
  return seq;
}

export function upsertEvent(traceId, event) {
  const externalId = String(event.externalId || event.id || `event-${Date.now()}`);
  const id = `${traceId}:${externalId}`;
  const existing = db
    .prepare("SELECT seq FROM trace_events WHERE trace_id = ? AND external_id = ?")
    .get(traceId, externalId);
  const seq = existing ? Number(existing.seq) : nextEventSequence(traceId);
  const timestamp = event.timestamp || nowIso();

  db.prepare(`
    INSERT INTO trace_events (
      id, trace_id, external_id, seq, timestamp, started_at, completed_at,
      duration_ms, kind, category, title, actor, status, evidence, parent_id,
      input_json, output_json, detail_json, raw_json, capture_channel, turn_id,
      api_request_id, tool_call_id, child_session_id, telemetry_schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trace_id, external_id) DO UPDATE SET
      timestamp = excluded.timestamp,
      started_at = COALESCE(trace_events.started_at, excluded.started_at),
      completed_at = COALESCE(excluded.completed_at, trace_events.completed_at),
      duration_ms = COALESCE(excluded.duration_ms, trace_events.duration_ms),
      kind = excluded.kind,
      category = excluded.category,
      title = excluded.title,
      actor = excluded.actor,
      status = excluded.status,
      evidence = excluded.evidence,
      parent_id = COALESCE(excluded.parent_id, trace_events.parent_id),
      input_json = COALESCE(excluded.input_json, trace_events.input_json),
      output_json = COALESCE(excluded.output_json, trace_events.output_json),
      detail_json = COALESCE(excluded.detail_json, trace_events.detail_json),
      raw_json = COALESCE(excluded.raw_json, trace_events.raw_json),
      capture_channel = COALESCE(excluded.capture_channel, trace_events.capture_channel),
      turn_id = COALESCE(excluded.turn_id, trace_events.turn_id),
      api_request_id = COALESCE(excluded.api_request_id, trace_events.api_request_id),
      tool_call_id = COALESCE(excluded.tool_call_id, trace_events.tool_call_id),
      child_session_id = COALESCE(excluded.child_session_id, trace_events.child_session_id),
      telemetry_schema_version = COALESCE(
        excluded.telemetry_schema_version,
        trace_events.telemetry_schema_version
      )
  `).run(
    id,
    traceId,
    externalId,
    seq,
    timestamp,
    event.startedAt || null,
    event.completedAt || null,
    event.durationMs ?? null,
    event.kind || "unknown",
    event.category || "system",
    redactText(event.title || "未识别事件"),
    event.actor || "system",
    event.status || "completed",
    event.evidence || "direct",
    event.parentId || null,
    event.input == null ? null : safeJson(event.input),
    event.output == null ? null : safeJson(event.output),
    event.detail == null ? null : safeJson(event.detail),
    event.raw == null ? null : safeJson(event.raw),
    event.captureChannel || "gateway",
    event.turnId || null,
    event.apiRequestId || null,
    event.toolCallId || null,
    event.childSessionId || null,
    event.telemetrySchemaVersion || null,
  );

  db.prepare("UPDATE traces SET updated_at = ? WHERE id = ?").run(nowIso(), traceId);
  return getEvent(traceId, externalId);
}

export function getEvent(traceId, externalId) {
  return mapEvent(
    db
      .prepare("SELECT * FROM trace_events WHERE trace_id = ? AND external_id = ?")
      .get(traceId, externalId),
  );
}

export function listTraces(limit = 100) {
  const rows = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM trace_events e WHERE e.trace_id = t.id) AS event_count,
      (SELECT COUNT(*) FROM trace_events e WHERE e.trace_id = t.id AND e.category IN ('tool', 'mcp', 'web')) AS tool_call_count,
      (SELECT COUNT(*) FROM trace_events e WHERE e.trace_id = t.id AND e.status IN ('failed', 'error', 'declined')) AS error_count
    FROM traces t
    WHERE t.source LIKE 'hermes-%'
    ORDER BY t.started_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(Number(limit) || 100, 500)));
  return rows.map(mapTrace);
}

export function getTrace(traceId) {
  const row = db.prepare(`
    SELECT t.*,
      (SELECT COUNT(*) FROM trace_events e WHERE e.trace_id = t.id) AS event_count,
      (SELECT COUNT(*) FROM trace_events e WHERE e.trace_id = t.id AND e.category IN ('tool', 'mcp', 'web')) AS tool_call_count,
      (SELECT COUNT(*) FROM trace_events e WHERE e.trace_id = t.id AND e.status IN ('failed', 'error', 'declined')) AS error_count
    FROM traces t WHERE t.id = ?
  `).get(traceId);
  return mapTrace(row);
}

export function getEvents(traceId) {
  return db
    .prepare("SELECT * FROM trace_events WHERE trace_id = ? ORDER BY seq ASC")
    .all(traceId)
    .map(mapEvent);
}

export function getRawEvents(traceId, limit = 2000) {
  return db
    .prepare(`
      SELECT seq, timestamp, source_type, payload_json
      FROM raw_events WHERE trace_id = ? ORDER BY seq ASC LIMIT ?
    `)
    .all(traceId, Math.max(1, Math.min(Number(limit) || 2000, 10_000)))
    .map((row) => ({
      seq: Number(row.seq),
      timestamp: row.timestamp,
      sourceType: row.source_type,
      payload: parseJson(row.payload_json, {}),
    }));
}

export function getTraceBundle(traceId) {
  const trace = getTrace(traceId);
  if (!trace) return null;
  return { trace, events: getEvents(traceId), rawEvents: getRawEvents(traceId) };
}

export function closeStore() {
  db.close();
}
