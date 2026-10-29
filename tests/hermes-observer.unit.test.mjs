import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("observer plugin is syntactically valid and observer-only", async () => {
  const path = new URL("../hermes-plugin/agent-trace-observer/__init__.py", import.meta.url);
  const source = await readFile(path, "utf8");
  const compiled = spawnSync(
    "python3",
    ["-c", "import sys; compile(sys.stdin.read(), 'observer.py', 'exec')"],
    { input: source, encoding: "utf8" },
  );
  assert.equal(compiled.status, 0, compiled.stderr);
  assert.match(source, /ctx\.register_hook/);
  assert.doesNotMatch(source, /transform_tool_result|transform_llm_output|action["']?\s*:\s*["']block/);
});
