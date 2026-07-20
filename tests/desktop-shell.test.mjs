import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DREAMSKIN_START_URL, IPC_CHANNELS } from "../desktop/constants.mjs";
import { secureBrowserWindowOptions, startDesktopApplication } from "../desktop/shell.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for desktop test state.");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function electronFixture({
  lock = true,
  packaged = false,
  appPath = "/tmp/dreamskin-app",
  userDataPath = "/tmp/dreamskin-user-data",
  version = "1.0.0",
  loadURL = async () => {},
  handleProtocol = async () => {},
} = {}) {
  const calls = [];
  let nextId = 1;
  class App extends EventEmitter {
    constructor() {
      super();
      this.isPackaged = packaged;
      this.quitCount = 0;
      this.exitCount = 0;
    }
    requestSingleInstanceLock() { calls.push("request-lock"); return lock; }
    releaseSingleInstanceLock() { calls.push("release-lock"); }
    whenReady() { calls.push("when-ready"); return Promise.resolve(); }
    getAppPath() { return appPath; }
    getPath(name) { assert.equal(name, "userData"); return userDataPath; }
    getVersion() { return version; }
    setAppUserModelId(id) { calls.push(["app-id", id]); }
    quit() { this.quitCount += 1; calls.push("quit"); }
    exit(code) { this.exitCount += 1; calls.push(["exit", code]); }
  }
  class WebContents extends EventEmitter {
    constructor() {
      super();
      this.id = nextId++;
      this.mainFrame = { url: DREAMSKIN_START_URL };
    }
    setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
  }
  class BrowserWindow extends EventEmitter {
    static instances = [];
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new WebContents();
      this.destroyed = false;
      this.shown = 0;
      this.focused = 0;
      BrowserWindow.instances.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return false; }
    show() { this.shown += 1; }
    focus() { this.focused += 1; }
    loadURL(url) { this.url = url; return loadURL(url, this); }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
  }
  const ipcHandlers = new Map();
  const ipcMain = {
    handle: (channel, handler) => ipcHandlers.set(channel, handler),
    removeHandler: (channel) => ipcHandlers.delete(channel),
  };
  const handledProtocols = new Map();
  const sessionProtocol = {
    handle: async (scheme, handler) => {
      handledProtocols.set(scheme, handler);
      return handleProtocol(scheme, handler);
    },
    unhandle: (scheme) => { calls.push(["unhandle", scheme]); handledProtocols.delete(scheme); },
  };
  const defaultSession = {
    protocol: sessionProtocol,
    setPermissionRequestHandler: (handler) => { defaultSession.permissionRequest = handler; },
    setPermissionCheckHandler: (handler) => { defaultSession.permissionCheck = handler; },
    setDevicePermissionHandler: (handler) => { defaultSession.devicePermission = handler; },
  };
  const protocol = {
    registerSchemesAsPrivileged: (schemes) => { calls.push(["register-schemes", schemes]); },
  };
  return {
    calls,
    app: new App(),
    BrowserWindow,
    ipcMain,
    protocol,
    session: { defaultSession },
    defaultSession,
    ipcHandlers,
    handledProtocols,
  };
}

test("BrowserWindow options keep renderer isolation enabled", () => {
  const options = secureBrowserWindowOptions({ preloadPath: "/tmp/preload.mjs", platform: "darwin" });
  assert.equal(options.titleBarStyle, "hiddenInset");
  assert.equal(options.webPreferences.sandbox, true);
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.webSecurity, true);
  assert.equal(options.webPreferences.allowRunningInsecureContent, false);
  assert.equal(options.webPreferences.devTools, false);
});

test("desktop shell registers one secure window, protocol, IPC, and awaits backend shutdown", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-desktop-shell-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const distRoot = path.join(root, "studio", "dist");
  const index = Buffer.from("studio");
  await fs.mkdir(distRoot, { recursive: true });
  await fs.writeFile(path.join(distRoot, "index.html"), index);
  await fs.writeFile(path.join(root, "resource-manifest.v1.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "dreamskin",
    version: "1.0.0",
    resources: [{
      path: "studio/dist/index.html",
      type: "file",
      sha256: crypto.createHash("sha256").update(index).digest("hex"),
      bytes: index.length,
    }],
  })}\n`);
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-desktop-shell-user-data-"));
  t.after(() => fs.rm(userDataPath, { recursive: true, force: true }));
  const electron = electronFixture({ appPath: root, userDataPath });
  const closeGate = deferred();
  let closeStarted = false;
  let closeFinished = false;
  let backendOptions;
  const backend = {
    bootstrap: async () => ({}),
    close: async () => {
      closeStarted = true;
      await closeGate.promise;
      closeFinished = true;
    },
  };

  const controller = await startDesktopApplication({
    electron,
    createBackend: async (config) => { backendOptions = config; return backend; },
    developmentResourcesPath: root,
    preloadPath: "/tmp/preload.mjs",
    platform: "darwin",
  });
  assert.equal(controller.started, true);
  assert.equal(electron.BrowserWindow.instances.length, 1);
  const window = electron.BrowserWindow.instances[0];
  assert.equal(window.url, DREAMSKIN_START_URL);
  assert.equal(electron.handledProtocols.has("dreamskin"), true);
  assert.equal(electron.ipcHandlers.has(IPC_CHANNELS.studioApi), true);
  assert.equal(backendOptions.mode, "development");
  assert.equal(backendOptions.paths.resourceRoot, root);
  assert.equal(backendOptions.paths.studioDistRoot, distRoot);
  assert.equal(backendOptions.backendOptions.projectRoot, root);
  assert.equal(backendOptions.backendOptions.pluginRoot, path.join(root, "plugins", "trae"));
  assert.equal(backendOptions.backendOptions.pluginManifestPath, path.join(root, "plugins", "trae", "plugin.json"));
  assert.equal(backendOptions.backendOptions.catalogThemesRoot, path.join(root, "plugins", "trae", "catalog"));
  assert.equal(
    backendOptions.backendOptions.registryPath,
    path.join(root, "plugins", "trae", "resources", "components.v1.json"),
  );
  assert.equal(backendOptions.backendOptions.scriptsRoot, path.join(root, "scripts"));
  assert.equal(
    backendOptions.backendOptions.userThemesRoot,
    path.join(userDataPath, "dreamskin", "themes", "dreamskin.trae"),
  );
  assert.equal(
    backendOptions.backendOptions.dataRoot,
    path.join(userDataPath, "dreamskin", "state", "dreamskin.trae"),
  );
  assert.equal(
    backendOptions.backendOptions.manifestPath,
    path.join(userDataPath, "dreamskin", "state", "dreamskin.trae", "library.json"),
  );
  assert.equal(electron.defaultSession.permissionCheck(), false);
  assert.equal(window.webContents.windowOpenHandler({ url: "https://example.com" }).action, "deny");

  let navigationPrevented = false;
  window.webContents.emit("will-navigate", { preventDefault: () => { navigationPrevented = true; } }, "https://example.com");
  assert.equal(navigationPrevented, true);
  electron.app.emit("second-instance");
  assert.equal(window.focused, 1);

  let quitPrevented = false;
  electron.app.emit("before-quit", { preventDefault: () => { quitPrevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitPrevented, true);
  assert.equal(closeStarted, true);
  assert.equal(closeFinished, false);
  assert.equal(window.destroyed, false);
  assert.equal(electron.app.quitCount, 0);
  assert.equal(electron.ipcHandlers.size, 0);

  closeGate.resolve();
  await controller.shutdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closeFinished, true);
  assert.equal(window.destroyed, false);
  assert.equal(electron.app.quitCount, 0);
  assert.equal(electron.app.exitCount, 1);
  assert.equal(electron.calls.filter((call) => call === "release-lock").length, 1);
});

test("desktop shell prepares isolated roots and backend configs for every configured target", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-desktop-multitarget-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const distRoot = path.join(root, "studio", "dist");
  await fs.mkdir(distRoot, { recursive: true });
  await fs.writeFile(path.join(distRoot, "index.html"), "studio");
  const userDataPath = path.join(root, "user-data");
  const electron = electronFixture({ appPath: root, userDataPath });
  let backendConfig;
  const controller = await startDesktopApplication({
    electron,
    createBackend: async (config) => {
      backendConfig = config;
      return { close: async () => {} };
    },
    developmentResourcesPath: root,
    preloadPath: "/tmp/preload.mjs",
    targetDefinitions: [
      { pluginId: "dreamskin.trae", pluginResourceDirectory: "trae" },
      { pluginId: "dreamskin.workbuddy", pluginResourceDirectory: "workbuddy" },
    ],
  });

  assert.deepEqual(Object.keys(backendConfig.targets), ["dreamskin.trae", "dreamskin.workbuddy"]);
  assert.equal(
    backendConfig.targets["dreamskin.workbuddy"].paths.pluginRoot,
    path.join(root, "plugins", "workbuddy"),
  );
  assert.equal(
    backendConfig.targets["dreamskin.workbuddy"].paths.userThemesRoot,
    path.join(userDataPath, "dreamskin", "themes", "dreamskin.workbuddy"),
  );
  assert.equal(
    backendConfig.targets["dreamskin.workbuddy"].backendOptions.dataRoot,
    path.join(userDataPath, "dreamskin", "state", "dreamskin.workbuddy"),
  );
  assert.equal(
    backendConfig.targets["dreamskin.workbuddy"].paths.backupsRoot,
    path.join(userDataPath, "dreamskin", "backups", "dreamskin.workbuddy"),
  );
  assert.equal(
    (await fs.stat(path.join(userDataPath, "dreamskin", "runtime", "dreamskin.workbuddy"))).isDirectory(),
    true,
  );
  await controller.shutdown();
});

test("final exit keeps the renderer alive until logical cleanup completes and terminates once", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-final-exit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "studio", "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "studio", "dist", "index.html"), "studio");
  const electron = electronFixture({ appPath: root, userDataPath: path.join(root, "user-data") });
  const closeGate = deferred();
  let backendClosed = false;
  const exits = [];
  const controller = await startDesktopApplication({
    electron,
    createBackend: async () => ({
      close: async () => {
        await closeGate.promise;
        backendClosed = true;
      },
    }),
    developmentResourcesPath: root,
    preloadPath: "/tmp/preload.cjs",
    exitApplication: (code) => {
      assert.equal(backendClosed, true);
      assert.equal(electron.ipcHandlers.size, 0);
      assert.equal(electron.handledProtocols.size, 0);
      assert.equal(electron.calls.includes("release-lock"), true);
      exits.push(code);
    },
  });
  const window = electron.BrowserWindow.instances[0];
  let prevented = 0;
  electron.app.emit("before-quit", { preventDefault: () => { prevented += 1; } });
  const first = controller.finalExit();
  const second = controller.finalExit();

  assert.equal(first, second);
  await waitUntil(() => electron.ipcHandlers.size === 0 && electron.handledProtocols.size === 0);
  assert.equal(prevented, 1);
  assert.equal(window.destroyed, false);
  assert.deepEqual(exits, []);

  closeGate.resolve();
  await first;
  assert.equal(window.destroyed, false);
  assert.deepEqual(exits, [0]);
});

test("software update installation drains the app and releases quit interception before updater restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-update-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "studio", "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "studio", "dist", "index.html"), "studio");
  const electron = electronFixture({ appPath: root, userDataPath: path.join(root, "user-data") });
  let beforeInstall;
  let updateClosed = false;
  let backendClosed = false;
  const exits = [];
  const controller = await startDesktopApplication({
    electron,
    createBackend: async () => ({ close: async () => { backendClosed = true; } }),
    createSoftwareUpdate: (options) => {
      beforeInstall = options.beforeInstall;
      const state = {
        enabled: true,
        phase: "ready",
        canCheck: false,
        canDownload: false,
        canInstall: true,
      };
      return {
        initialize: async () => state,
        getState: () => state,
        check: async () => state,
        download: async () => state,
        install: () => state,
        subscribe: () => () => {},
        close: () => { updateClosed = true; },
      };
    },
    developmentResourcesPath: root,
    preloadPath: "/tmp/preload.cjs",
    exitApplication: (code) => exits.push(code),
  });

  assert.equal(controller.started, true);
  assert.equal(electron.app.listenerCount("before-quit"), 1);
  await beforeInstall();
  assert.equal(backendClosed, true);
  assert.equal(updateClosed, true);
  assert.equal(electron.app.listenerCount("before-quit"), 0);
  assert.deepEqual(exits, []);

  let prevented = false;
  electron.app.emit("before-quit", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.deepEqual(exits, []);
});

test("desktop shell exits before backend startup when another instance owns the lock", async () => {
  const electron = electronFixture({ lock: false });
  let backendCreated = false;
  const controller = await startDesktopApplication({
    electron,
    createBackend: async () => { backendCreated = true; return {}; },
    developmentResourcesPath: "/tmp/project",
    preloadPath: "/tmp/preload.mjs",
  });
  assert.equal(controller.started, false);
  assert.equal(backendCreated, false);
  assert.equal(electron.app.quitCount, 1);
  assert.equal(electron.BrowserWindow.instances.length, 0);
});

test("desktop shell validates an existing resource manifest before creating the backend", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-desktop-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "studio", "dist", "index.html");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, "tampered");
  await fs.writeFile(path.join(root, "resource-manifest.v1.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "dreamskin",
    version: "1.0.0",
    resources: [{
      path: "studio/dist/index.html",
      type: "file",
      sha256: "0".repeat(64),
      bytes: 8,
    }],
  })}\n`);
  const electron = electronFixture({ appPath: root, userDataPath: path.join(root, "user-data") });
  let backendCreated = false;

  await assert.rejects(() => startDesktopApplication({
    electron,
    createBackend: async () => { backendCreated = true; return {}; },
    developmentResourcesPath: root,
    preloadPath: "/tmp/preload.mjs",
  }), { code: "RESOURCE_INTEGRITY_FAILED" });
  assert.equal(backendCreated, false);
  assert.equal(electron.calls.includes("release-lock"), true);
});

test("packaged desktop startup fails closed when the resource manifest is missing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-packaged-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, "resources");
  const resourceRoot = path.join(resourcesPath, "dreamskin");
  await fs.mkdir(path.join(resourceRoot, "studio", "dist"), { recursive: true });
  await fs.writeFile(path.join(resourceRoot, "studio", "dist", "index.html"), "studio");
  const electron = electronFixture({
    packaged: true,
    appPath: path.join(root, "app.asar"),
    userDataPath: path.join(root, "user-data"),
  });
  let backendCreated = false;

  await assert.rejects(() => startDesktopApplication({
    electron,
    createBackend: async () => { backendCreated = true; return {}; },
    developmentResourcesPath: root,
    resourcesPath,
    preloadPath: "/tmp/preload.cjs",
  }), { code: "RESOURCE_MANIFEST_MISSING" });
  assert.equal(backendCreated, false);
});

test("packaged desktop installs and selects the verified bundled runtime", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-packaged-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, "resources");
  const resourceRoot = path.join(resourcesPath, "dreamskin");
  const runtimeRoot = path.join(resourceRoot, "runtime", "dreamskin.trae");
  const index = Buffer.from("studio");
  const script = Buffer.from("#!/bin/bash\nexit 0\n");
  const runtimeManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    namespace: "dreamskin.trae",
    version: "0.2.0",
    files: [{
      path: "scripts/status-trae-skin-macos.sh",
      sha256: crypto.createHash("sha256").update(script).digest("hex"),
      bytes: script.length,
      mode: 0o755,
    }],
  }, null, 2)}\n`);
  const resources = [
    ["studio/dist/index.html", index],
    ["runtime/dreamskin.trae/scripts/status-trae-skin-macos.sh", script],
    ["runtime/dreamskin.trae/runtime-manifest.v1.json", runtimeManifest],
  ];
  for (const [relative, buffer] of resources) {
    const target = path.join(resourceRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
  }
  await fs.writeFile(path.join(resourceRoot, "resource-manifest.v1.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "dreamskin",
    version: "0.2.0",
    resources: resources.map(([relative, buffer]) => ({
      path: relative,
      type: "file",
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length,
    })),
  }, null, 2)}\n`);

  const userDataPath = path.join(root, "user-data");
  const electron = electronFixture({
    packaged: true,
    appPath: path.join(root, "app.asar"),
    userDataPath,
    version: "0.2.0",
  });
  let backendConfig;
  const controller = await startDesktopApplication({
    electron,
    createBackend: async (config) => {
      backendConfig = config;
      return { close: async () => {} };
    },
    developmentResourcesPath: root,
    resourcesPath,
    preloadPath: "/tmp/preload.cjs",
  });

  assert.equal(controller.started, true);
  assert.equal(backendConfig.paths.activeRuntimeRoot, path.join(
    userDataPath,
    "dreamskin",
    "runtime",
    "dreamskin.trae",
    "versions",
    "0.2.0",
  ));
  assert.equal(
    backendConfig.backendOptions.scriptsRoot,
    path.join(backendConfig.paths.activeRuntimeRoot, "scripts"),
  );
  assert.equal(await fs.readFile(path.join(
    backendConfig.backendOptions.scriptsRoot,
    "status-trae-skin-macos.sh",
  ), "utf8"), script.toString("utf8"));
  await controller.shutdown();
  assert.equal(electron.BrowserWindow.instances[0].destroyed, true);

  const mismatchedApp = electronFixture({
    packaged: true,
    appPath: path.join(root, "mismatched-app.asar"),
    userDataPath: path.join(root, "mismatched-user-data"),
    version: "0.3.0",
  });
  await assert.rejects(() => startDesktopApplication({
    electron: mismatchedApp,
    createBackend: async () => ({}),
    developmentResourcesPath: root,
    resourcesPath,
    preloadPath: "/tmp/preload.cjs",
  }), { code: "RESOURCE_VERSION_MISMATCH" });

  const resourceManifestPath = path.join(resourceRoot, "resource-manifest.v1.json");
  const resourceManifest = JSON.parse(await fs.readFile(resourceManifestPath, "utf8"));
  resourceManifest.version = "0.3.0";
  await fs.writeFile(resourceManifestPath, `${JSON.stringify(resourceManifest, null, 2)}\n`);
  const mismatchedRuntime = electronFixture({
    packaged: true,
    appPath: path.join(root, "mismatched-runtime.asar"),
    userDataPath: path.join(root, "mismatched-runtime-user-data"),
    version: "0.3.0",
  });
  await assert.rejects(() => startDesktopApplication({
    electron: mismatchedRuntime,
    createBackend: async () => ({}),
    developmentResourcesPath: root,
    resourcesPath,
    preloadPath: "/tmp/preload.cjs",
  }), { code: "RUNTIME_VERSION_MISMATCH" });
});

test("packaged desktop installs every configured target runtime independently", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-packaged-multitarget-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resourcesPath = path.join(root, "resources");
  const resourceRoot = path.join(resourcesPath, "dreamskin");
  const files = [["studio/dist/index.html", Buffer.from("studio")]];
  for (const [namespace, scriptName] of [
    ["dreamskin.trae", "status-trae-skin-macos.sh"],
    ["dreamskin.workbuddy", "status-workbuddy-skin-macos.sh"],
  ]) {
    const script = Buffer.from("#!/bin/bash\nexit 0\n");
    const manifest = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      namespace,
      version: "0.2.0",
      files: [{
        path: `scripts/${scriptName}`,
        sha256: crypto.createHash("sha256").update(script).digest("hex"),
        bytes: script.length,
        mode: 0o755,
      }],
    }, null, 2)}\n`);
    files.push([`runtime/${namespace}/scripts/${scriptName}`, script]);
    files.push([`runtime/${namespace}/runtime-manifest.v1.json`, manifest]);
  }
  for (const [relative, buffer] of files) {
    const target = path.join(resourceRoot, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
  }
  await fs.writeFile(path.join(resourceRoot, "resource-manifest.v1.json"), `${JSON.stringify({
    schemaVersion: 1,
    product: "dreamskin",
    version: "0.2.0",
    resources: files.map(([relative, buffer]) => ({
      path: relative,
      type: "file",
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.length,
    })),
  }, null, 2)}\n`);

  const userDataPath = path.join(root, "user-data");
  const electron = electronFixture({
    packaged: true,
    appPath: path.join(root, "app.asar"),
    userDataPath,
    version: "0.2.0",
  });
  let backendConfig;
  const controller = await startDesktopApplication({
    electron,
    createBackend: async (config) => {
      backendConfig = config;
      return { close: async () => {} };
    },
    developmentResourcesPath: root,
    resourcesPath,
    preloadPath: "/tmp/preload.cjs",
    targetDefinitions: [
      { pluginId: "dreamskin.trae", pluginResourceDirectory: "trae" },
      { pluginId: "dreamskin.workbuddy", pluginResourceDirectory: "workbuddy" },
    ],
  });

  for (const pluginId of ["dreamskin.trae", "dreamskin.workbuddy"]) {
    assert.equal(
      backendConfig.targets[pluginId].paths.activeRuntimeRoot,
      path.join(userDataPath, "dreamskin", "runtime", pluginId, "versions", "0.2.0"),
    );
    assert.equal(
      (await fs.stat(path.join(backendConfig.targets[pluginId].paths.activeRuntimeRoot, "scripts"))).isDirectory(),
      true,
    );
  }
  await controller.shutdown();
});

test("quit and activate during backend startup cannot create or leak a running desktop", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-startup-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "studio", "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "studio", "dist", "index.html"), "studio");
  const electron = electronFixture({ appPath: root, userDataPath: path.join(root, "user-data") });
  const backendGate = deferred();
  let backendRequested = false;
  let backendClosed = 0;
  const startup = startDesktopApplication({
    electron,
    createBackend: async () => {
      backendRequested = true;
      return backendGate.promise;
    },
    developmentResourcesPath: root,
    preloadPath: "/tmp/preload.cjs",
    shutdownTimeoutMs: 1000,
  });
  await waitUntil(() => backendRequested);

  electron.app.emit("activate");
  assert.equal(electron.BrowserWindow.instances.length, 0);
  electron.app.emit("before-quit", { preventDefault() {} });
  backendGate.resolve({ close: async () => { backendClosed += 1; } });

  const controller = await startup;
  assert.equal(controller.started, false);
  await controller.shutdown();
  await waitUntil(() => electron.app.exitCount === 1);
  assert.equal(backendClosed, 1);
  assert.equal(electron.BrowserWindow.instances.length, 0);
  assert.equal(electron.handledProtocols.size, 0);
  assert.equal(electron.ipcHandlers.size, 0);
});

test("quit during protocol registration unhandles late registration and closes backend", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-protocol-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "studio", "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "studio", "dist", "index.html"), "studio");
  const protocolGate = deferred();
  let protocolStarted = false;
  const electron = electronFixture({
    appPath: root,
    userDataPath: path.join(root, "user-data"),
    handleProtocol: async () => {
      protocolStarted = true;
      await protocolGate.promise;
    },
  });
  let backendClosed = 0;
  const startup = startDesktopApplication({
    electron,
    createBackend: async () => ({ close: async () => { backendClosed += 1; } }),
    developmentResourcesPath: root,
    preloadPath: "/tmp/preload.cjs",
    shutdownTimeoutMs: 1000,
  });
  await waitUntil(() => protocolStarted);
  electron.app.emit("before-quit", { preventDefault() {} });
  protocolGate.resolve();

  const controller = await startup;
  assert.equal(controller.started, false);
  await controller.shutdown();
  assert.equal(backendClosed, 1);
  assert.equal(electron.handledProtocols.size, 0);
  assert.equal(electron.calls.some((call) => Array.isArray(call) && call[0] === "unhandle"), true);
  assert.equal(electron.BrowserWindow.instances.length, 0);
});

test("initial loadURL failure aborts startup and closes every registered resource", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-load-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "studio", "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "studio", "dist", "index.html"), "studio");
  const electron = electronFixture({
    appPath: root,
    userDataPath: path.join(root, "user-data"),
    loadURL: async () => { throw new Error("renderer failed"); },
  });
  let backendClosed = 0;

  await assert.rejects(() => startDesktopApplication({
    electron,
    createBackend: async () => ({ close: async () => { backendClosed += 1; } }),
    developmentResourcesPath: root,
    preloadPath: "/tmp/preload.cjs",
  }), { code: "STUDIO_LOAD_FAILED" });
  assert.equal(backendClosed, 1);
  assert.equal(electron.BrowserWindow.instances[0].destroyed, true);
  assert.equal(electron.handledProtocols.size, 0);
  assert.equal(electron.ipcHandlers.size, 0);
});

test("desktop shutdown has a bounded final timeout when backend cancellation hangs", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-shutdown-timeout-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "studio", "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "studio", "dist", "index.html"), "studio");
  const electron = electronFixture({ appPath: root, userDataPath: path.join(root, "user-data") });
  const never = new Promise(() => {});
  const errors = [];
  const controller = await startDesktopApplication({
    electron,
    createBackend: async () => ({ close: () => never }),
    developmentResourcesPath: root,
    preloadPath: "/tmp/preload.cjs",
    shutdownTimeoutMs: 20,
    logger: { error: (...args) => errors.push(args) },
  });

  electron.app.emit("before-quit", { preventDefault() {} });
  await controller.shutdown();
  await waitUntil(() => electron.app.exitCount === 1);
  assert.equal(errors.some(([message]) => String(message).includes("shutdown exceeded")), true);
});
