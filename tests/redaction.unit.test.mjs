import assert from "node:assert/strict";
import test from "node:test";
import { redactText, redactValue } from "../server/redaction.mjs";

test("redacts common credentials in text", () => {
  const text = redactText("Authorization: Bearer abcdefghijklmnop and API_KEY=super-secret-value");
  assert.doesNotMatch(text, /abcdefghijklmnop/);
  assert.doesNotMatch(text, /super-secret-value/);
  assert.match(text, /\[REDACTED\]/);
});

test("redacts values whose object keys are sensitive", () => {
  const value = redactValue({ tool: "mcp", apiKey: "secret", nested: { password: "hidden", ok: true } });
  assert.deepEqual(value, {
    tool: "mcp",
    apiKey: "[REDACTED]",
    nested: { password: "[REDACTED]", ok: true },
  });
});
