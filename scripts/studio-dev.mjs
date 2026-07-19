import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn(process.execPath, ["./src/studio-server.mjs"], { stdio: "inherit" }),
  spawn(npm, ["--prefix", "studio", "run", "dev"], { stdio: "inherit" }),
];

let stopping = false;

function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

const result = await Promise.race(children.map((child) => new Promise((resolve) => {
  child.once("error", (error) => resolve({ code: 1, error }));
  child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0) }));
})));

stop();
if (result.error) console.error(result.error.stack || result.error.message);
process.exitCode = result.code;
