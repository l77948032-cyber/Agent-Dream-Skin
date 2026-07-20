import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { IPC_CHANNELS } from "../desktop/constants.mjs";
import { assertSafeIpcPayload, createSenderValidator, registerDesktopIpc } from "../desktop/ipc.mjs";
import { createPreloadApi } from "../desktop/preload-api.mjs";

function senderEvent({ id = 7, url = "dreamskin://studio/", subframe = false } = {}) {
  const mainFrame = { url };
  const sender = { id, mainFrame, getURL: () => url, isDestroyed: () => false };
  return { sender, senderFrame: subframe ? { url } : mainFrame };
}

function softwareUpdateFixture() {
  const listeners = new Set();
  const state = {
    enabled: false,
    reason: "development",
    phase: "disabled",
    currentVersion: "0.2.0",
    prerelease: false,
    update: null,
    progress: null,
    error: null,
    canCheck: false,
    canDownload: false,
    canInstall: false,
  };
  return {
    state,
    getState: () => state,
    check: async () => state,
    download: async () => state,
    install: () => state,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    emit: (next) => listeners.forEach((listener) => listener(next)),
  };
}

test("desktop IPC sender validation requires the registered Studio main frame", () => {
  const allowed = new Set([7]);
  const validate = createSenderValidator({ allowedWebContentsIds: () => allowed });
  assert.doesNotThrow(() => validate(senderEvent()));
  assert.throws(() => validate(senderEvent({ id: 8 })), { code: "INVALID_IPC_SENDER" });
  assert.throws(() => validate(senderEvent({ url: "https://attacker.example" })), { code: "INVALID_IPC_SENDER" });
  assert.throws(() => validate(senderEvent({ subframe: true })), { code: "INVALID_IPC_SENDER" });
  const noSenderFrame = senderEvent();
  noSenderFrame.senderFrame = null;
  assert.throws(() => validate(noSenderFrame), { code: "INVALID_IPC_SENDER" });
  const noMainFrame = senderEvent();
  noMainFrame.sender.mainFrame = null;
  assert.throws(() => validate(noMainFrame), { code: "INVALID_IPC_SENDER" });
});

test("desktop IPC accepts only bounded JSON-compatible payloads", () => {
  assert.doesNotThrow(() => assertSafeIpcPayload({ colors: { accent: "#ff0000" }, enabled: true }));
  assert.throws(() => assertSafeIpcPayload({ value: Number.NaN }), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => assertSafeIpcPayload({ date: new Date() }), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => assertSafeIpcPayload({ text: "x".repeat(1024 * 1024 + 1) }), { code: "INVALID_IPC_PAYLOAD" });
  const unsafe = Object.create(null);
  unsafe.constructor = "pollute";
  assert.throws(() => assertSafeIpcPayload(unsafe), { code: "INVALID_IPC_PAYLOAD" });
});

test("IPC registration envelopes backend results and rejects untrusted senders", async () => {
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const softwareUpdate = softwareUpdateFixture();
  const updateStates = [];
  const registration = registerDesktopIpc({
    ipcMain,
    router: { invoke: async (operation, input) => ({ operation, input }) },
    assertTrustedSender: createSenderValidator({ allowedWebContentsIds: () => new Set([7]) }),
    getDesktopInfo: () => ({ platform: "darwin" }),
    softwareUpdate,
    sendSoftwareUpdateState: (state) => updateStates.push(state),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.desktopInfo)(senderEvent()), {
    ok: true,
    result: { platform: "darwin" },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.studioApi)(senderEvent(), "themes.read", { themeId: "sunlit-spark" }), {
    ok: true,
    result: { operation: "themes.read", input: { themeId: "sunlit-spark" } },
  });
  for (const operation of ["cli.status", "cli.install", "cli.uninstall"]) {
    assert.deepEqual(await handlers.get(IPC_CHANNELS.studioApi)(senderEvent(), operation, {}), {
      ok: true,
      result: { operation, input: {} },
    });
  }
  assert.deepEqual(await handlers.get(IPC_CHANNELS.softwareUpdateGetState)(senderEvent()), {
    ok: true,
    result: softwareUpdate.state,
  });
  softwareUpdate.emit(softwareUpdate.state);
  assert.deepEqual(updateStates, [softwareUpdate.state]);
  const rejected = await handlers.get(IPC_CHANNELS.studioApi)(senderEvent({ id: 9 }), "themes.list", {});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "INVALID_IPC_SENDER");

  registration.unregister();
  await registration.drain();
  assert.equal(handlers.size, 0);
});

test("preload bridge exposes explicit frozen methods instead of raw Electron IPC", async () => {
  const calls = [];
  const api = createPreloadApi({
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      return { ok: true, result: { channel, args } };
    },
  });

  assert.equal(Object.isFrozen(api), true);
  assert.equal(Object.isFrozen(api.studio), true);
  assert.equal(Object.isFrozen(api.updates), true);
  assert.equal("invoke" in api, false);
  for (const retiredMethod of ["sendThemeMessage", "listAgents", "connectAgent"]) {
    assert.equal(retiredMethod in api.studio, false);
  }
  await api.studio.updateTheme("sunlit-spark", { expectedRevision: "rev", theme: { name: "New" } });
  assert.deepEqual(calls[0], [IPC_CHANNELS.studioApi, "themes.update", {
    themeId: "sunlit-spark",
    input: { expectedRevision: "rev", theme: { name: "New" } },
  }]);
  await api.studio.applyTheme("shared", "dreamskin.workbuddy");
  assert.deepEqual(calls[1], [IPC_CHANNELS.studioApi, "themes.apply", {
    themeId: "shared",
    pluginId: "dreamskin.workbuddy",
  }]);
  await api.studio.restoreRuntime("dreamskin.workbuddy");
  assert.deepEqual(calls[2], [IPC_CHANNELS.studioApi, "runtime.restore", {
    pluginId: "dreamskin.workbuddy",
  }]);
  await api.studio.getCliStatus();
  assert.deepEqual(calls[3], [IPC_CHANNELS.studioApi, "cli.status", {}]);
  await api.studio.installCli();
  assert.deepEqual(calls[4], [IPC_CHANNELS.studioApi, "cli.install", {}]);
  await api.studio.uninstallCli();
  assert.deepEqual(calls[5], [IPC_CHANNELS.studioApi, "cli.uninstall", {}]);
  await api.updates.check();
  assert.deepEqual(calls[6], [IPC_CHANNELS.softwareUpdateCheck]);

  let updateListener;
  const eventApi = createPreloadApi({
    invoke: async () => ({ ok: true, result: null }),
    on: (channel, listener) => { assert.equal(channel, IPC_CHANNELS.softwareUpdateState); updateListener = listener; },
    removeListener: (channel, listener) => {
      assert.equal(channel, IPC_CHANNELS.softwareUpdateState);
      assert.equal(listener, updateListener);
    },
  });
  let received;
  const unsubscribe = eventApi.updates.subscribe((state) => { received = state; });
  updateListener({ sender: "hidden" }, { phase: "ready" });
  assert.deepEqual(received, { phase: "ready" });
  unsubscribe();

  const rejectedApi = createPreloadApi({ invoke: async () => ({
    ok: false,
    error: { code: "REVISION_CONFLICT", message: "Theme changed.", details: { actual: "new" } },
  }) });
  await assert.rejects(() => rejectedApi.studio.getTheme("theme-one"), (error) => {
    assert.equal(error.name, "DreamSkinDesktopError");
    assert.equal(error.code, "REVISION_CONFLICT");
    assert.deepEqual(error.details, { actual: "new" });
    return true;
  });
});

test("sandbox-compatible CommonJS preload publishes the same narrow bridge", async () => {
  const calls = [];
  let exposed;
  const preloadPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "preload.cjs");
  const source = await fs.readFile(preloadPath, "utf8");
  vm.runInNewContext(source, {
    Error,
    Object,
    require: (specifier) => {
      assert.equal(specifier, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name, value) => { exposed = { name, value }; } },
        ipcRenderer: { invoke: async (...args) => { calls.push(args); return { ok: true, result: "ok" }; } },
      };
    },
  }, { filename: preloadPath });

  assert.equal(exposed.name, "dreamskin");
  assert.equal("invoke" in exposed.value, false);
  assert.equal(Object.isFrozen(exposed.value), true);
  assert.equal(Object.isFrozen(exposed.value.studio), true);
  for (const retiredMethod of ["sendThemeMessage", "listAgents", "connectAgent"]) {
    assert.equal(retiredMethod in exposed.value.studio, false);
  }
  const reference = createPreloadApi({ invoke: async () => ({ ok: true, result: "ok" }) });
  assert.deepEqual(
    JSON.parse(JSON.stringify(Object.keys(exposed.value.studio))),
    Object.keys(reference.studio),
  );

  await exposed.value.studio.getCliStatus();
  await exposed.value.studio.installCli();
  await exposed.value.studio.uninstallCli();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    [IPC_CHANNELS.studioApi, "cli.status", {}],
    [IPC_CHANNELS.studioApi, "cli.install", {}],
    [IPC_CHANNELS.studioApi, "cli.uninstall", {}],
  ]);
});
