import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatStartupFailure,
  reportDesktopStartupFailure,
} from "../desktop/startup-diagnostics.mjs";

test("startup failures are formatted deterministically", () => {
  const now = new Date("2026-07-20T08:30:00.000Z");
  const error = Object.assign(new Error("Bundled resources are invalid."), {
    code: "RESOURCE_INTEGRITY_FAILED",
  });
  const result = formatStartupFailure(error, { now });

  assert.equal(result.code, "RESOURCE_INTEGRITY_FAILED");
  assert.equal(result.message, "Bundled resources are invalid.");
  assert.equal(result.timestamp, now.toISOString());
  assert.match(result.logEntry, /^\[2026-07-20T08:30:00\.000Z\] RESOURCE_INTEGRITY_FAILED/m);
  assert.match(result.logEntry, /Bundled resources are invalid\./);
});

test("startup reporting writes a private diagnostic log and shows a useful dialog", async (t) => {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-startup-report-"));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const dialogs = [];
  const error = Object.assign(new Error("Runtime installation failed."), {
    code: "RUNTIME_INSTALL_FAILED",
  });

  const result = await reportDesktopStartupFailure({
    app: {
      getPath(name) { assert.equal(name, "userData"); return userDataPath; },
      isReady: () => true,
    },
    dialog: { showMessageBox: async (options) => dialogs.push(options) },
    error,
    now: new Date("2026-07-20T09:00:00.000Z"),
  });

  assert.equal(result.logPath, path.join(userDataPath, "dreamskin", "logs", "startup.log"));
  assert.match(await fs.readFile(result.logPath, "utf8"), /RUNTIME_INSTALL_FAILED/);
  assert.equal((await fs.stat(result.logPath)).mode & 0o777, 0o600);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].title, "DreamSkin Studio 无法启动");
  assert.match(dialogs[0].detail, /RUNTIME_INSTALL_FAILED/);
  assert.match(dialogs[0].detail, /startup\.log/);
});

test("startup reporting still presents the error when the log cannot be written", async () => {
  const calls = [];
  const errors = [];
  const result = await reportDesktopStartupFailure({
    app: {
      getPath: () => "/read-only/user-data",
      isReady: () => false,
      whenReady: async () => calls.push("ready"),
    },
    dialog: { showMessageBox: async (options) => calls.push(options) },
    error: new Error("Could not load Studio."),
    fileSystem: {
      mkdir: async () => { throw new Error("read only"); },
      appendFile: async () => {},
    },
    logger: { error: (...args) => errors.push(args) },
  });

  assert.equal(result.logPath, null);
  assert.equal(calls[0], "ready");
  assert.equal(calls[1].type, "error");
  assert.equal(calls[1].detail.includes("诊断日志"), false);
  assert.equal(errors.length, 1);
});
