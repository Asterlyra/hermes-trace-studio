import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn("node", ["--watch", "server/index.mjs"], { stdio: "inherit", env: process.env }),
  spawn(npm, ["run", "dev:ui"], { stdio: "inherit", env: process.env }),
];

let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 600).unref();
}

for (const child of children) {
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping && (code !== 0 || signal)) stop(code || 1);
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
