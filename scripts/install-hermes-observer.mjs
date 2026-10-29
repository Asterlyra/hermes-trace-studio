import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const source = resolve(process.cwd(), "hermes-plugin", "agent-trace-observer");
const pluginsRoot = resolve(process.env.HERMES_HOME || `${homedir()}/.hermes`, "plugins");
const target = resolve(pluginsRoot, "agent-trace-observer");

if (!existsSync(resolve(source, "plugin.yaml"))) {
  throw new Error(`Observer source not found: ${source}`);
}

mkdirSync(pluginsRoot, { recursive: true });
cpSync(source, target, { recursive: true, force: true });

const hermes = process.env.HERMES_BINARY || resolve(homedir(), ".local", "bin", "hermes");
const enabled = spawnSync(
  hermes,
  ["plugins", "enable", "agent-trace-observer", "--no-allow-tool-override"],
  { stdio: "inherit", env: process.env },
);
if (enabled.status !== 0) {
  throw new Error("Observer 已复制，但 Hermes 未能启用它。请运行 hermes plugins enable agent-trace-observer。 ");
}

process.stdout.write(`Hermes Trace Observer installed at ${target}\n`);
