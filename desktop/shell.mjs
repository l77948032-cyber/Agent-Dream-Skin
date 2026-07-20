import fs from "node:fs/promises";
import path from "node:path";

import { DesktopPathLayout } from "../src/core/desktop-layout.mjs";
import { ToolError } from "../src/core/errors.mjs";
import { VersionedRuntimeInstaller } from "../src/core/versioned-runtime-installer.mjs";
import { DesktopStudioApiRouter } from "./api-router.mjs";
import { DREAMSKIN_HOST, DREAMSKIN_SCHEME, DREAMSKIN_START_URL } from "./constants.mjs";
import { createSenderValidator, registerDesktopIpc } from "./ipc.mjs";
import { createDreamSkinProtocolHandler, DESKTOP_PROTOCOL_PRIVILEGES } from "./protocol-router.mjs";

function isTrustedStudioUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === `${DREAMSKIN_SCHEME}:`
      && url.hostname === DREAMSKIN_HOST
      && !url.port
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function secureBrowserWindowOptions({ preloadPath, platform = process.platform, development = false } = {}) {
  if (!preloadPath) throw new ToolError("INVALID_ARGUMENT", "Desktop BrowserWindow requires a preload path.");
  return {
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#f5f5f7",
    autoHideMenuBar: true,
    ...(platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
    webPreferences: {
      preload: path.resolve(preloadPath),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: development,
      spellcheck: true,
    },
  };
}

function hardenSession(session) {
  session.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler?.(() => false);
  session.setDevicePermissionHandler?.(() => false);
}

function hardenWebContents(webContents) {
  webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
  const preventUntrustedNavigation = (event, targetUrl) => {
    if (!isTrustedStudioUrl(targetUrl)) event.preventDefault();
  };
  webContents.on?.("will-navigate", preventUntrustedNavigation);
  webContents.on?.("will-redirect", preventUntrustedNavigation);
  webContents.on?.("will-attach-webview", (event) => event.preventDefault());
}

function focusWindow(window) {
  if (!window || window.isDestroyed?.()) return;
  if (window.isMinimized?.()) window.restore();
  window.show?.();
  window.focus?.();
}

function trackedHandler(handler) {
  const inFlight = new Set();
  const tracked = (request) => {
    const promise = Promise.resolve().then(() => handler(request));
    inFlight.add(promise);
    void promise.then(
      () => inFlight.delete(promise),
      () => inFlight.delete(promise),
    );
    return promise;
  };
  tracked.drain = async () => {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
  };
  return tracked;
}

async function validateResourceManifest(layout) {
  if (layout.isPackaged) return layout.validateResources();
  try {
    await fs.lstat(layout.resourceManifestPath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  return layout.validateResources();
}

async function settleWithin(promises, milliseconds) {
  const pending = promises.filter(Boolean).map((promise) => Promise.resolve(promise));
  if (!pending.length) return true;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  const settled = Promise.allSettled(pending).then(() => true);
  const completed = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return completed;
}

async function assertStudioBuild(distRoot) {
  const indexPath = path.join(distRoot, "index.html");
  let stat;
  try {
    stat = await fs.lstat(indexPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ToolError("STUDIO_NOT_BUILT", "Build DreamSkin Studio before starting the desktop app.", {
        indexPath,
      });
    }
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ToolError("STUDIO_NOT_BUILT", "Desktop Studio index.html must be a regular file.", {
      indexPath,
    });
  }
}

export function createDesktopBackendConfig({
  layout,
  pluginId = "dreamskin.trae",
  pluginResourceDirectory = "trae",
  activeRuntimeRoot = null,
} = {}) {
  if (!(layout instanceof DesktopPathLayout)) {
    throw new ToolError("INVALID_ARGUMENT", "Desktop backend configuration requires a DesktopPathLayout.");
  }
  const stateRoot = layout.namespaceStateRoot(pluginId);
  const pluginRoot = path.join(layout.bundledPluginsRoot, pluginResourceDirectory);
  const paths = Object.freeze({
    resourceRoot: layout.resourceRoot,
    resourceManifestPath: layout.resourceManifestPath,
    studioDistRoot: path.join(layout.resourceRoot, "studio", "dist"),
    pluginRoot,
    pluginManifestPath: path.join(pluginRoot, "plugin.json"),
    catalogThemesRoot: path.join(pluginRoot, "catalog"),
    registryPath: path.join(pluginRoot, "resources", "components.v1.json"),
    scriptsRoot: path.join(layout.resourceRoot, "scripts"),
    userThemesRoot: layout.themeRoot(pluginId),
    stateRoot,
    manifestPath: path.join(stateRoot, "library.json"),
    bundledRuntimePackageRoot: layout.bundledRuntimeNamespaceRoot(pluginId),
    runtimeRoot: layout.runtimeNamespaceRoot(pluginId),
    activeRuntimeRoot,
    backupsRoot: layout.namespaceBackupsRoot(pluginId),
    logsRoot: layout.logsRoot,
  });
  const runtimeScriptsRoot = activeRuntimeRoot
    ? path.join(activeRuntimeRoot, "scripts")
    : paths.scriptsRoot;
  return Object.freeze({
    pluginId,
    mode: layout.isPackaged ? "packaged" : "development",
    layout,
    paths,
    backendOptions: Object.freeze({
      pluginRoot: paths.pluginRoot,
      pluginManifestPath: paths.pluginManifestPath,
      catalogThemesRoot: paths.catalogThemesRoot,
      registryPath: paths.registryPath,
      userThemesRoot: paths.userThemesRoot,
      dataRoot: paths.stateRoot,
      manifestPath: paths.manifestPath,
      projectRoot: paths.resourceRoot,
      scriptsRoot: runtimeScriptsRoot,
    }),
  });
}

async function installPackagedRuntime(layout, pluginId) {
  if (!layout.isPackaged) return null;
  const installer = new VersionedRuntimeInstaller({
    runtimeRoot: layout.runtimeRoot,
    namespace: pluginId,
  });
  return installer.install({
    sourceRoot: layout.bundledRuntimeNamespaceRoot(pluginId),
    activate: true,
  });
}

function normalizeDesktopTargetDefinitions({
  pluginId,
  pluginResourceDirectory,
  targetDefinitions,
}) {
  const configured = targetDefinitions === undefined
    ? [{ pluginId, pluginResourceDirectory }]
    : targetDefinitions;
  if (!Array.isArray(configured) || configured.length === 0) {
    throw new ToolError("INVALID_ARGUMENT", "Desktop startup requires at least one target definition.");
  }
  const seen = new Set();
  const normalized = configured.map((target, index) => {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      throw new ToolError("INVALID_ARGUMENT", `Desktop target at index ${index} must be an object.`);
    }
    const targetPluginId = target.pluginId;
    const resourceDirectory = target.pluginResourceDirectory;
    if (typeof targetPluginId !== "string" || !targetPluginId) {
      throw new ToolError("INVALID_ARGUMENT", `Desktop target at index ${index} requires pluginId.`);
    }
    if (
      typeof resourceDirectory !== "string"
      || !/^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/.test(resourceDirectory)
      || resourceDirectory === "."
      || resourceDirectory === ".."
    ) {
      throw new ToolError(
        "INVALID_ARGUMENT",
        `Desktop target '${targetPluginId}' has an invalid plugin resource directory.`,
      );
    }
    if (seen.has(targetPluginId)) {
      throw new ToolError("INVALID_ARGUMENT", `Desktop target '${targetPluginId}' is configured more than once.`);
    }
    seen.add(targetPluginId);
    return Object.freeze({ pluginId: targetPluginId, pluginResourceDirectory: resourceDirectory });
  });
  if (!seen.has(pluginId)) {
    throw new ToolError("INVALID_ARGUMENT", `Default desktop target '${pluginId}' is not configured.`);
  }
  return Object.freeze(normalized);
}

export async function startDesktopApplication({
  electron,
  createBackend,
  developmentResourcesPath,
  resourcesPath,
  preloadPath,
  pluginId = "dreamskin.trae",
  pluginResourceDirectory = "trae",
  targetDefinitions,
  platform = process.platform,
  development = false,
  logger = console,
  shutdownTimeoutMs = 10_000,
  exitApplication = null,
} = {}) {
  const { app, BrowserWindow, ipcMain, protocol, session } = electron || {};
  if (!app || !BrowserWindow || !ipcMain || !protocol || !session || typeof createBackend !== "function") {
    throw new ToolError("INVALID_ARGUMENT", "Desktop startup is missing Electron or backend dependencies.");
  }
  if (!developmentResourcesPath || !preloadPath || (app.isPackaged && !resourcesPath)) {
    throw new ToolError(
      "INVALID_ARGUMENT",
      "Desktop startup requires developmentResourcesPath, preloadPath, and packaged resourcesPath.",
    );
  }
  if (!Number.isFinite(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
    throw new ToolError("INVALID_ARGUMENT", "shutdownTimeoutMs must be a positive number.");
  }
  if (exitApplication !== null && typeof exitApplication !== "function") {
    throw new ToolError("INVALID_ARGUMENT", "Desktop exitApplication must be a function when provided.");
  }

  const desktopTargets = normalizeDesktopTargetDefinitions({
    pluginId,
    pluginResourceDirectory,
    targetDefinitions,
  });

  const terminateApplication = exitApplication || ((code) => {
    if (typeof app.exit === "function") app.exit(code);
    else app.quit();
  });

  protocol.registerSchemesAsPrivileged([DESKTOP_PROTOCOL_PRIVILEGES]);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return { started: false, shutdown: async () => {}, quit: () => app.quit() };
  }

  let mainWindow = null;
  let backend = null;
  let protocolTarget = null;
  let protocolHandler = null;
  let ipcRegistration = null;
  let desktopConfig = null;
  let resourceValidation = null;
  let initializationPromise = null;
  let cleanupPromise = null;
  let shutdownPromise = null;
  let finalExitPromise = null;
  let backendClosePromise = null;
  let protocolUnhandlePromise = null;
  let protocolHandled = false;
  let windowCreationPromise = null;
  let lifecycle = "starting";
  let allowFinalQuit = false;
  let applicationHooksReleased = false;
  const allowedWebContentsIds = new Set();

  const stopping = () => lifecycle === "stopping" || lifecycle === "stopped";

  const destroyWindow = (window = mainWindow) => {
    if (!window || window.isDestroyed?.()) return;
    try {
      window.destroy?.();
    } catch (error) {
      logger.error?.("DreamSkin Studio window cleanup failed.", error);
    }
  };

  const createWindow = async () => {
    if (stopping()) return null;
    if (mainWindow && !mainWindow.isDestroyed?.()) return mainWindow;
    if (windowCreationPromise) return windowCreationPromise;
    windowCreationPromise = (async () => {
      const window = new BrowserWindow(secureBrowserWindowOptions({ preloadPath, platform, development }));
      mainWindow = window;
      allowedWebContentsIds.add(window.webContents.id);
      hardenWebContents(window.webContents);
      window.on?.("closed", () => {
        allowedWebContentsIds.delete(window.webContents.id);
        if (mainWindow === window) mainWindow = null;
      });
      try {
        await window.loadURL(DREAMSKIN_START_URL);
      } catch (error) {
        destroyWindow(window);
        throw new ToolError("STUDIO_LOAD_FAILED", "DreamSkin Studio could not load its desktop interface.", {
          url: DREAMSKIN_START_URL,
        }, { cause: error });
      }
      if (stopping()) {
        destroyWindow(window);
        return null;
      }
      window.show?.();
      return window;
    })();
    try {
      return await windowCreationPromise;
    } finally {
      windowCreationPromise = null;
    }
  };

  const closeBackend = () => {
    if (!backend) return Promise.resolve();
    if (!backendClosePromise) {
      backendClosePromise = Promise.resolve()
        .then(() => backend.close?.())
        .catch((error) => logger.error?.("DreamSkin Studio backend shutdown failed.", error));
    }
    return backendClosePromise;
  };

  const unhandleProtocol = () => {
    if (!protocolHandled || !protocolTarget?.unhandle) return Promise.resolve();
    if (!protocolUnhandlePromise) {
      protocolHandled = false;
      protocolUnhandlePromise = Promise.resolve()
        .then(() => protocolTarget.unhandle(DREAMSKIN_SCHEME))
        .catch((error) => logger.error?.("DreamSkin desktop protocol cleanup failed.", error));
    }
    return protocolUnhandlePromise;
  };

  const bestEffort = (label, operation) => Promise.resolve()
    .then(operation)
    .catch((error) => logger.error?.(label, error));

  const cleanup = ({ destroyRenderer = true } = {}) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      const registration = ipcRegistration;
      ipcRegistration = null;
      try {
        registration?.unregister();
      } catch (error) {
        logger.error?.("DreamSkin desktop IPC cleanup failed.", error);
      }
      if (destroyRenderer) destroyWindow();
      const completed = await settleWithin([
        closeBackend(),
        unhandleProtocol(),
        bestEffort("DreamSkin desktop IPC drain failed.", () => registration?.drain?.()),
        bestEffort("DreamSkin desktop protocol drain failed.", () => protocolHandler?.drain?.()),
      ], shutdownTimeoutMs);
      if (!completed) logger.error?.(`DreamSkin Studio shutdown exceeded ${shutdownTimeoutMs}ms.`);
    })();
    return cleanupPromise;
  };

  const shutdown = ({ destroyRenderer = true } = {}) => {
    if (!shutdownPromise) {
      lifecycle = "stopping";
      shutdownPromise = (async () => {
        const completed = await settleWithin([
          cleanup({ destroyRenderer }),
          initializationPromise,
        ], shutdownTimeoutMs);
        if (!completed) logger.error?.(`DreamSkin Studio initialization did not stop within ${shutdownTimeoutMs}ms.`);
        lifecycle = "stopped";
        releaseApplicationHooks();
      })();
    }
    return shutdownPromise;
  };

  const finalExit = () => {
    if (finalExitPromise) return finalExitPromise;
    finalExitPromise = shutdown({ destroyRenderer: false })
      .catch((error) => logger.error?.("DreamSkin Studio shutdown failed.", error))
      .finally(() => {
        allowFinalQuit = true;
        terminateApplication(0);
      });
    return finalExitPromise;
  };

  const requestFinalQuit = () => { void finalExit(); };

  const onBeforeQuit = (event) => {
    if (allowFinalQuit) return;
    event.preventDefault();
    requestFinalQuit();
  };
  const onWindowAllClosed = () => {
    if (lifecycle === "running" && platform !== "darwin") app.quit();
  };
  const onActivate = () => {
    if (lifecycle !== "running") return;
    if (!mainWindow || mainWindow.isDestroyed?.()) {
      void createWindow().catch((error) => logger.error?.("DreamSkin Studio window could not be recreated.", error));
    }
    else focusWindow(mainWindow);
  };
  const onSecondInstance = () => {
    if (lifecycle === "running") focusWindow(mainWindow);
  };

  const releaseApplicationHooks = () => {
    if (applicationHooksReleased) return;
    applicationHooksReleased = true;
    app.removeListener?.("before-quit", onBeforeQuit);
    app.removeListener?.("window-all-closed", onWindowAllClosed);
    app.removeListener?.("activate", onActivate);
    app.removeListener?.("second-instance", onSecondInstance);
    app.releaseSingleInstanceLock?.();
  };

  app.on("before-quit", onBeforeQuit);
  app.on("window-all-closed", onWindowAllClosed);
  app.on("activate", onActivate);
  app.on("second-instance", onSecondInstance);

  const initialize = async () => {
    await app.whenReady();
    if (stopping()) return;
    app.setAppUserModelId?.("com.dreamskin.studio");
    hardenSession(session.defaultSession);

    const layout = new DesktopPathLayout({
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath,
      userDataPath: app.getPath("userData"),
      developmentResourcesPath: path.resolve(developmentResourcesPath),
    });
    await Promise.all(desktopTargets.map((target) => layout.ensureMutableRoots(target.pluginId)));
    if (stopping()) return;
    resourceValidation = await validateResourceManifest(layout);
    const appVersion = app.getVersion();
    if (layout.isPackaged && resourceValidation?.version !== appVersion) {
      throw new ToolError("RESOURCE_VERSION_MISMATCH", "Desktop resources do not match the application version.", {
        expected: appVersion,
        actual: resourceValidation?.version || null,
      });
    }
    if (stopping()) return;
    const runtimeInstallations = new Map(await Promise.all(desktopTargets.map(async (target) => [
      target.pluginId,
      await installPackagedRuntime(layout, target.pluginId),
    ])));
    for (const target of desktopTargets) {
      const installation = runtimeInstallations.get(target.pluginId);
      if (layout.isPackaged && installation?.version !== appVersion) {
        throw new ToolError("RUNTIME_VERSION_MISMATCH", "A bundled target runtime does not match the application version.", {
          pluginId: target.pluginId,
          expected: appVersion,
          actual: installation?.version || null,
        });
      }
    }
    const targetConfigs = Object.fromEntries(desktopTargets.map((target) => {
      const installation = runtimeInstallations.get(target.pluginId);
      return [target.pluginId, createDesktopBackendConfig({
        layout,
        pluginId: target.pluginId,
        pluginResourceDirectory: target.pluginResourceDirectory,
        activeRuntimeRoot: installation?.root || null,
      })];
    }));
    const defaultConfig = targetConfigs[pluginId];
    desktopConfig = Object.freeze({
      ...defaultConfig,
      targets: Object.freeze(targetConfigs),
    });
    await assertStudioBuild(desktopConfig.paths.studioDistRoot);
    if (stopping()) return;
    const createdBackend = await createBackend(desktopConfig);
    backend = createdBackend;
    if (stopping()) {
      void closeBackend();
      return;
    }
    const router = new DesktopStudioApiRouter({ backend });
    protocolTarget = session.defaultSession.protocol || protocol;
    protocolHandler = trackedHandler(createDreamSkinProtocolHandler({
      router,
      distRoot: desktopConfig.paths.studioDistRoot,
    }));
    await protocolTarget.handle(DREAMSKIN_SCHEME, protocolHandler);
    protocolHandled = true;
    if (stopping()) {
      void unhandleProtocol();
      void closeBackend();
      return;
    }

    const assertTrustedSender = createSenderValidator({
      allowedWebContentsIds: () => allowedWebContentsIds,
    });
    ipcRegistration = registerDesktopIpc({
      ipcMain,
      router,
      assertTrustedSender,
      getDesktopInfo: () => ({
        appVersion,
        electronVersion: process.versions.electron || null,
        mode: desktopConfig.mode,
        packaged: Boolean(app.isPackaged),
        platform,
        resourcesVerified: Boolean(resourceValidation?.valid),
        runtimeVersion: runtimeInstallations.get(pluginId)?.version || null,
        runtimeVersions: Object.fromEntries(desktopTargets.map((target) => [
          target.pluginId,
          runtimeInstallations.get(target.pluginId)?.version || null,
        ])),
      }),
    });
    if (stopping()) {
      ipcRegistration.unregister();
      ipcRegistration = null;
      void unhandleProtocol();
      void closeBackend();
      return;
    }
    await createWindow();
    if (!stopping()) lifecycle = "running";
  };

  initializationPromise = initialize();
  try {
    await initializationPromise;
  } catch (error) {
    if (stopping()) {
      await shutdown();
      return { started: false, shutdown, quit: () => app.quit() };
    }
    lifecycle = "stopping";
    await cleanup();
    lifecycle = "stopped";
    releaseApplicationHooks();
    throw error;
  }

  if (lifecycle !== "running") {
    await shutdown();
    return { started: false, shutdown, quit: () => app.quit() };
  }

  return {
    started: true,
    getWindow: () => mainWindow,
    getDesktopConfig: () => desktopConfig,
    shutdown: () => shutdown({ destroyRenderer: true }),
    finalExit,
    quit: () => app.quit(),
  };
}

export { isTrustedStudioUrl };
