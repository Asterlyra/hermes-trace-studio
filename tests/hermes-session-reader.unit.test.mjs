import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = mkdtempSync(join(tmpdir(), "hermes-session-reader-"));
process.env.HERMES_HOME = join(root, "hermes-home");
process.env.HERMES_TRACE_DATA_DIR = join(root, "trace-data");
mkdirSync(process.env.HERMES_HOME, { recursive: true });

const state = new DatabaseSync(join(process.env.HERMES_HOME, "state.db"));
state.exec(`
  CREATE TABLE schema_version (version INTEGER);
  INSERT INTO schema_version VALUES (23);
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT, model TEXT, system_prompt TEXT,
    parent_session_id TEXT, started_at REAL, ended_at REAL, message_count INTEGER,
    tool_call_count INTEGER, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, reasoning_tokens INTEGER, cwd TEXT,
    billing_provider TEXT, estimated_cost_usd REAL, actual_cost_usd REAL,
    title TEXT, profile_name TEXT
  );
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
    tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL,
    finish_reason TEXT, reasoning TEXT, reasoning_content TEXT,
    effect_disposition TEXT, display_kind TEXT, active INTEGER
  );
`);
state.prepare(`
  INSERT INTO sessions (
    id, source, model, system_prompt, started_at, ended_at, message_count,
    tool_call_count, input_tokens, output_tokens, cache_read_tokens,
    reasoning_tokens, cwd, billing_provider, title
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "s1", "cli", "model-x", "You are Hermes.", 1000, 1004, 4, 1, 100, 20, 10, 5,
  root, "openrouter", "Inspect project",
);
state.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  1, "s1", "user", "Inspect project", null, null, null, 1000, null, null, null, null, null, 1,
);
state.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  2, "s1", "assistant", "", null,
  JSON.stringify([{ id: "call-1", function: { name: "skill_view", arguments: "{\"name\":\"review\"}" } }]),
  null, 1001, "tool_calls", "Need the review skill", null, null, null, 1,
);
state.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  3, "s1", "tool", JSON.stringify({ content: "skill body" }), "call-1", null, "skill_view", 1002,
  "stop", null, null, "ok", null, 1,
);
state.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
  4, "s1", "assistant", "Done", null, null, null, 1003, "stop", null, null, null, null, 1,
);
state.close();

const reader = await import(`../server/hermes/session-reader.mjs?test=${Date.now()}`);
const store = await import("../server/store.mjs");

test.after(() => {
  store.closeStore();
  rmSync(root, { recursive: true, force: true });
});

test("lists and imports one Hermes Trace per real user turn", async () => {
  const sessions = reader.listHermesSessions();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "s1");

  const traceIds = await reader.importHermesSession("s1");
  assert.equal(traceIds.length, 1);
  const trace = store.getTrace(traceIds[0]);
  const events = store.getEvents(trace.id);
  assert.equal(trace.source, "hermes-history");
  assert.equal(trace.captureCompleteness, "history");
  assert.ok(trace.promptLayers.some((layer) => layer.kind === "effective-system"));
  assert.equal(events.filter((event) => event.category === "skill").length, 1);
  assert.equal(events.find((event) => event.category === "skill").status, "completed");
});
