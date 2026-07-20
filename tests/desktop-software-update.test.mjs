import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  detectMacUpdateEligibility,
  SoftwareUpdateManager,
} from "../desktop/software-update.mjs";

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.checkResult = { updateInfo: { version: "0.3.0" } };
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.installCalls = [];
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    return this.checkResult;
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    return ["/tmp/update.zip"];
  }

  quitAndInstall(...args) {
    this.installCalls.push(args);
  }
}

function appFixture({ packaged = true, version = "0.2.0" } = {}) {
  return { isPackaged: packaged, getVersion: () => version };
}

function enabledManager(options = {}) {
  const { app: appOptions, ...managerOptions } = options;
  return new SoftwareUpdateManager({
    app: appFixture(appOptions),
    updater: options.updater || new FakeUpdater(),
    eligibility: async () => ({ enabled: true, reason: null }),
    autoCheckDelayMs: null,
    logger: { error: () => {}, warn: () => {} },
    ...managerOptions,
  });
}

test("macOS update eligibility disables development, unsupported, and ad-hoc builds", async () => {
  const runCalls = [];
  assert.deepEqual(await detectMacUpdateEligibility({
    app: appFixture({ packaged: false }),
    platform: "darwin",
    run: async (...args) => runCalls.push(args),
  }), { enabled: false, reason: "development" });
  assert.equal(runCalls.length, 0);

  assert.deepEqual(await detectMacUpdateEligibility({
    app: appFixture(),
    platform: "linux",
  }), { enabled: false, reason: "unsupported-platform" });

  assert.deepEqual(await detectMacUpdateEligibility({
    app: appFixture(),
    platform: "darwin",
    executablePath: "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio",
    run: async () => ({ stderr: "Executable=/Applications/DreamSkin Studio.app\nSignature=adhoc\nTeamIdentifier=not set\n" }),
  }), { enabled: false, reason: "unsigned" });
});

test("macOS update eligibility accepts a Developer ID Application signature", async () => {
  let invocation;
  assert.deepEqual(await detectMacUpdateEligibility({
    app: appFixture(),
    platform: "darwin",
    executablePath: "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio",
    run: async (...args) => {
      invocation = args;
      return {
        stderr: [
          "Authority=Developer ID Application: DreamSkin Studio (ABCDE12345)",
          "Authority=Developer ID Certification Authority",
          "TeamIdentifier=ABCDE12345",
        ].join("\n"),
      };
    },
  }), { enabled: true, reason: null });
  assert.deepEqual(invocation.slice(0, 2), [
    "/usr/bin/codesign",
    ["-dv", "--verbose=4", "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio"],
  ]);
});

test("update manager configures electron-updater and exposes the complete state flow", async () => {
  const updater = new FakeUpdater();
  const manager = enabledManager({ updater, app: { version: "0.3.0-beta.1" } });
  const observed = [];
  manager.subscribe((state) => observed.push(state));
  const initial = await manager.initialize();

  assert.equal(initial.phase, "idle");
  assert.equal(initial.prerelease, true);
  assert.equal(initial.canCheck, true);
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.autoRunAppAfterInstall, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, true);

  updater.emit("checking-for-update");
  assert.equal(manager.getState().phase, "checking");
  updater.emit("update-available", {
    version: "0.4.0-beta.2",
    releaseName: "  Preview\nRelease  ",
    releaseDate: "2026-07-20T12:00:00.000Z",
    releaseNotes: "must not cross the IPC boundary",
  });
  assert.equal(manager.getState().phase, "available");
  assert.equal(manager.getState().canDownload, true);
  assert.deepEqual(manager.getState().update, {
    version: "0.4.0-beta.2",
    releaseName: "Preview Release",
    releaseDate: "2026-07-20T12:00:00.000Z",
  });
  assert.equal("releaseNotes" in manager.getState().update, false);

  updater.emit("download-progress", { percent: 41.5, transferred: 415, total: 1000, bytesPerSecond: 80 });
  assert.deepEqual(manager.getState().progress, {
    percent: 41.5,
    transferred: 415,
    total: 1000,
    bytesPerSecond: 80,
  });
  updater.emit("update-downloaded", { version: "0.4.0-beta.2" });
  assert.equal(manager.getState().phase, "ready");
  assert.equal(manager.getState().canInstall, true);
  assert.equal(observed.length >= 5, true);
  manager.close();
  assert.equal(updater.listenerCount("update-available"), 0);
});

test("manual check, download, and deferred restart install form one guarded update loop", async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1;
    updater.emit("update-available", { version: "0.3.0", releaseName: "DreamSkin Studio 0.3" });
    return { updateInfo: { version: "0.3.0" } };
  };
  updater.downloadUpdate = async () => {
    updater.downloadCalls += 1;
    updater.emit("download-progress", { percent: 70, transferred: 7, total: 10 });
    updater.emit("update-downloaded", { version: "0.3.0" });
    return ["/tmp/update.zip"];
  };
  let scheduledInstall;
  const order = [];
  const manager = enabledManager({
    updater,
    beforeInstall: async () => order.push("shutdown"),
    scheduleInstall: (callback) => { scheduledInstall = callback; },
  });
  await manager.initialize();

  assert.equal((await manager.check()).phase, "available");
  assert.equal((await manager.download()).phase, "ready");
  assert.equal(manager.install().phase, "installing");
  assert.deepEqual(updater.installCalls, []);
  await scheduledInstall();
  assert.deepEqual(order, ["shutdown"]);
  assert.deepEqual(updater.installCalls, [[false, true]]);
});

test("update failures become retryable, sanitized renderer state", async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => {
    const error = new Error("request failed for https://example.invalid/private-path");
    error.code = "ERR_NETWORK";
    throw error;
  };
  const manager = enabledManager({ updater });
  await manager.initialize();
  await assert.rejects(() => manager.check(), { code: "UPDATE_CHECK_FAILED" });
  assert.deepEqual(manager.getState().error, {
    code: "UPDATE_CHECK_FAILED",
    message: "无法连接软件更新服务，请检查网络后重试。",
  });
  assert.equal(manager.getState().canCheck, true);
  assert.equal(JSON.stringify(manager.getState()).includes("private-path"), false);
});

test("disabled update builds never invoke electron-updater", async () => {
  const updater = new FakeUpdater();
  const manager = new SoftwareUpdateManager({
    app: appFixture({ packaged: false }),
    updater,
    eligibility: async () => ({ enabled: false, reason: "development" }),
    autoCheckDelayMs: null,
  });
  const state = await manager.initialize();
  assert.equal(state.phase, "disabled");
  assert.equal(state.reason, "development");
  assert.equal(state.canCheck, false);
  await assert.rejects(() => manager.check(), { code: "UPDATE_DISABLED" });
  assert.equal(updater.checkCalls, 0);
  assert.equal(updater.listenerCount("error"), 0);
});

test("a delayed automatic check never overwrites a newer manual update state", async () => {
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => {
    updater.checkCalls += 1;
    updater.emit("update-available", { version: "0.3.0" });
    return { updateInfo: { version: "0.3.0" } };
  };
  let scheduled;
  let cancelled = false;
  const manager = enabledManager({
    updater,
    autoCheckDelayMs: 5000,
    schedule: (callback) => { scheduled = callback; return { unref: () => {} }; },
    cancelSchedule: () => { cancelled = true; },
  });
  await manager.initialize();
  await manager.check();
  assert.equal(cancelled, true);
  assert.equal(manager.getState().phase, "available");
  await scheduled();
  assert.equal(updater.checkCalls, 1);
  assert.equal(manager.getState().phase, "available");
});
