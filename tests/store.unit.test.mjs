import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const temp = mkdtempSync(join(tmpdir(), "agent-trace-store-"));
process.env.HERMES_TRACE_DATA_DIR = temp;
const store = await import(`../server/store.mjs?test=${Date.now()}`);

test.after(() => {
  store.closeStore();
  rmSync(temp, { recursive: true, force: true });
});

test("upserts start and completion into one trace event", () => {
  const trace = store.createTrace({
    id: "trace-1",
    externalId: "external-1",
    source: "hermes-test",
    title: "test trace",
    status: "running",
  });
  store.upsertEvent(trace.id, {
    externalId: "tool-1",
    kind: "tool_call",
    category: "tool",
    actor: "tool",
    title: "read_file",
    status: "running",
    input: { path: "README.md" },
  });
  store.upsertEvent(trace.id, {
    externalId: "tool-1",
    kind: "tool_call",
    category: "tool",
    actor: "tool",
    title: "read_file",
    status: "completed",
    durationMs: 12,
    output: { content: "ok" },
  });

  const events = store.getEvents(trace.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "completed");
  assert.equal(events[0].durationMs, 12);
  assert.deepEqual(events[0].input, { path: "README.md" });
  assert.deepEqual(events[0].output, { content: "ok" });
});

test("persists Hermes correlation and completeness fields", () => {
  const trace = store.createTrace({
    id: "trace-hermes",
    externalId: "hermes:s1:t1",
    source: "hermes-observer",
    title: "Hermes turn",
    hermesSessionId: "s1",
    hermesTurnId: "t1",
    provider: "openrouter",
    captureMode: "observer",
    captureCompleteness: "full",
  });
  store.upsertEvent(trace.id, {
    externalId: "tool:call-1",
    kind: "tool_call",
    category: "tool",
    actor: "tool",
    title: "read_file",
    toolCallId: "call-1",
    turnId: "t1",
    captureChannel: "observer",
  });

  const saved = store.getTrace(trace.id);
  const [event] = store.getEvents(trace.id);
  assert.equal(saved.hermesSessionId, "s1");
  assert.equal(saved.hermesTurnId, "t1");
  assert.equal(saved.captureCompleteness, "full");
  assert.equal(event.toolCallId, "call-1");
  assert.equal(event.captureChannel, "observer");
});
