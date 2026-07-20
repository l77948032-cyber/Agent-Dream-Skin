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
  const registration = registerDesktopIpc({
    ipcMain,
    router: { invoke: async (operation, input) => ({ operation, input }) },
    assertTrustedSender: createSenderValidator({ allowedWebContentsIds: () => new Set([7]) }),
    getDesktopInfo: () => ({ platform: "darwin" }),
  });

  assert.deepEqual(await handlers.get(IPC_CHANNELS.desktopInfo)(senderEvent()), {
    ok: true,
    result: { platform: "darwin" },
  });
  assert.deepEqual(await handlers.get(IPC_CHANNELS.studioApi)(senderEvent(), "themes.read", { themeId: "sunlit-spark" }), {
    ok: true,
    result: { operation: "themes.read", input: { themeId: "sunlit-spark" } },
  });
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
  assert.equal("invoke" in api, false);
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
  await exposed.value.studio.sendThemeMessage("theme-one", { prompt: "make it warmer" });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), [IPC_CHANNELS.studioApi, "themes.message", {
    themeId: "theme-one",
    input: { prompt: "make it warmer" },
  }]);
  await exposed.value.studio.sendThemeMessage(
    "shared",
    { prompt: "make it cooler" },
    "dreamskin.workbuddy",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), [IPC_CHANNELS.studioApi, "themes.message", {
    themeId: "shared",
    input: { prompt: "make it cooler" },
    pluginId: "dreamskin.workbuddy",
  }]);
});
