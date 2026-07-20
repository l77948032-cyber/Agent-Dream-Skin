import path from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, protocol, session } from "electron";
import electronUpdater from "electron-updater";

import { DreamSkinCliManager } from "./cli-manager.mjs";
import { createDesktopProcessTerminator } from "./process-lifecycle.mjs";
import {
  configureDesktopProductIdentity,
  migrateLegacyDreamSkinData,
} from "./product-identity.mjs";
import { startDesktopApplication } from "./shell.mjs";
import { reportDesktopStartupFailure } from "./startup-diagnostics.mjs";
import { createSoftwareUpdateManager } from "./software-update.mjs";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(desktopRoot, "..");
const productIdentity = configureDesktopProductIdentity({ app });
const processTerminator = createDesktopProcessTerminator({ app });
const { autoUpdater } = electronUpdater;
let legacyMigrationPromise = null;

function ensureLegacyDataMigrated() {
  if (!productIdentity.migrationEnabled) return Promise.resolve(null);
  if (!legacyMigrationPromise) {
    legacyMigrationPromise = migrateLegacyDreamSkinData({
      legacyUserDataPath: productIdentity.legacyUserDataPath,
      legacyStudioPath: productIdentity.legacyStudioPath,
      userDataPath: productIdentity.userDataPath,
    }).then((result) => {
      if (result.warnings?.length) {
        console.warn("DreamSkin legacy data migration completed with warnings.", result.warnings);
      }
      return result;
    }).catch((error) => {
      console.error("DreamSkin legacy data migration failed; startup will continue with preserved source data.", error);
      return Object.freeze({ migrated: false, reason: "migration-failed", error });
    });
  }
  return legacyMigrationPromise;
}

function targetRuntimeStateRoot(directoryName) {
  if (productIdentity.migrationEnabled) {
    return path.join(productIdentity.appDataPath, directoryName);
  }
  return path.join(productIdentity.userDataPath, "runtime-state", directoryName);
}

async function createDesktopBackend(config) {
  await ensureLegacyDataMigrated();
  const targetConfigs = config.targets || { [config.pluginId]: config };
  const traeConfig = targetConfigs["dreamskin.trae"];
  const workBuddyConfig = targetConfigs["dreamskin.workbuddy"];
  if (!traeConfig || !workBuddyConfig) {
    throw new Error("DreamSkin Studio requires both Trae and WorkBuddy desktop target resources.");
  }
  // Resolve path constants against the packaged resource root before loading the
  // backend graph. The standalone CLI receives the same roots from its launcher.
  process.env.TRAE_DREAM_SKIN_PROJECT_ROOT = config.paths.resourceRoot;
  process.env.TRAE_DREAM_SKIN_THEMES_ROOT = traeConfig.paths.userThemesRoot;
  process.env.TRAE_DREAM_SKIN_TOOL_HOME = traeConfig.paths.stateRoot;
  process.env.TRAE_DREAM_SKIN_HOME = targetRuntimeStateRoot("TraeDreamSkin");
  process.env.DREAMSKIN_STUDIO_HOME = config.layout.dataRoot;
  process.env.DREAMSKIN_STUDIO_THEMES_ROOT = config.layout.themesRoot;
  const [
    { createDreamSkinApplicationContext },
    { createStudioBackend },
  ] = await Promise.all([
    import("../src/core/product-application-context.mjs"),
    import("../src/core/studio-backend.mjs"),
  ]);
  const registrationOptions = (target) => ({
    themesRoot: target.paths.userThemesRoot,
    dataRoot: target.paths.stateRoot,
    backupsRoot: target.paths.backupsRoot,
    projectRoot: target.paths.resourceRoot,
    pluginRoot: target.paths.pluginRoot,
    pluginManifestPath: target.paths.pluginManifestPath,
    catalogThemesRoot: target.paths.catalogThemesRoot,
    registryPath: target.paths.registryPath,
    scriptsRoot: target.backendOptions.scriptsRoot,
  });
  const applicationContext = await createDreamSkinApplicationContext({
    projectRoot: config.paths.resourceRoot,
    dataRoot: config.layout.dataRoot,
    themesRoot: config.layout.themesRoot,
    defaultPluginId: config.pluginId,
    traeOptions: registrationOptions(traeConfig),
    workBuddyOptions: {
      ...registrationOptions(workBuddyConfig),
      cssPath: path.join(workBuddyConfig.paths.pluginRoot, "assets", "workbuddy-skin.css"),
      templatePath: path.join(config.paths.resourceRoot, "assets", "workbuddy-renderer-inject.js"),
      stateRoot: targetRuntimeStateRoot("WorkBuddyDreamSkin"),
    },
  });
  const targetOptions = Object.fromEntries(Object.entries(targetConfigs).map(([pluginId, target]) => [
    pluginId,
    {
      themesRoot: target.paths.userThemesRoot,
      dataRoot: target.paths.stateRoot,
      backupsRoot: target.paths.backupsRoot,
      manifestPath: target.paths.manifestPath,
      registryPath: target.paths.registryPath,
      pluginRoot: target.paths.pluginRoot,
    },
  ]));
  return createStudioBackend({
    ...config.backendOptions,
    applicationContext,
    defaultPluginId: config.pluginId,
    targetOptions,
    dataRoot: config.layout.dataRoot,
    runtimeMutationsEnabled: productIdentity.migrationEnabled,
    cliManager: app.isPackaged ? new DreamSkinCliManager({
      executablePath: process.execPath,
      resourcesPath: process.resourcesPath,
      userDataPath: productIdentity.userDataPath,
    }) : null,
  });
}

void startDesktopApplication({
  electron: { app, BrowserWindow, ipcMain, protocol, session },
  createBackend: createDesktopBackend,
  developmentResourcesPath: projectRoot,
  resourcesPath: process.resourcesPath,
  preloadPath: path.join(desktopRoot, "preload.cjs"),
  createSoftwareUpdate: (options) => createSoftwareUpdateManager({
    ...options,
    updater: autoUpdater,
    executablePath: process.execPath,
  }),
  targetDefinitions: [
    { pluginId: "dreamskin.trae", pluginResourceDirectory: "trae" },
    { pluginId: "dreamskin.workbuddy", pluginResourceDirectory: "workbuddy" },
  ],
  development: !app.isPackaged,
  exitApplication: (code) => processTerminator.terminate(code),
})
  .then((controller) => {
    if (!controller.started) return;
    const shutdownFromSignal = () => {
      void controller.finalExit();
    };
    for (const signal of ["SIGINT", "SIGTERM"]) {
      processTerminator.listen(signal, shutdownFromSignal);
    }
  })
  .catch(async (error) => {
    console.error(error.stack || error.message);
    await reportDesktopStartupFailure({ app, dialog, error });
    app.exit(1);
  });
