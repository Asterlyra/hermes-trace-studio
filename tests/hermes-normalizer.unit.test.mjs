import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTool,
  normalizeGatewayEvent,
  normalizeObserverHook,
  parseMcpToolName,
} from "../server/hermes/normalizer.mjs";

test("recognizes Hermes MCP and Skill tools without a generic adapter", () => {
  assert.deepEqual(parseMcpToolName("mcp__github__read_issue"), {
    server: "github",
    tool: "read_issue",
  });
  assert.equal(classifyTool("mcp__github__read_issue").category, "mcp");
  assert.equal(classifyTool("skill_view").category, "skill");
});

test("merges Gateway tool lifecycle on the Hermes tool id", () => {
  const start = normalizeGatewayEvent("tool.start", {
    tool_id: "call-1",
    name: "skill_view",
    context: "code-review",
  });
  const complete = normalizeGatewayEvent("tool.complete", {
    tool_id: "call-1",
    name: "skill_view",
    args: { name: "code-review" },
    result: { content: "instructions" },
    duration_s: 0.23,
  });
  assert.equal(start.externalId, complete.externalId);
  assert.equal(complete.kind, "skill_usage");
  assert.equal(complete.durationMs, 230);
  assert.equal(complete.captureChannel, "gateway");
});

test("keeps observer correlation ids on provider requests", () => {
  const event = normalizeObserverHook("post_api_request", {
    session_id: "s1",
    turn_id: "t1",
    api_request_id: "a1",
    provider: "openrouter",
    model: "model-x",
    api_duration: 0.5,
    telemetry_schema_version: "hermes.observer.v1",
  });
  assert.equal(event.externalId, "llm:a1");
  assert.equal(event.turnId, "t1");
  assert.equal(event.apiRequestId, "a1");
  assert.equal(event.durationMs, 500);
});

test("labels exposed reasoning without claiming hidden chain of thought", () => {
  const event = normalizeGatewayEvent("reasoning.available", { text: "检查项目约束" });
  assert.equal(event.kind, "reasoning_summary");
  assert.match(event.output.note, /不代表未公开的隐藏思维链/);
});
