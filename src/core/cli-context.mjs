import os from "node:os";
import path from "node:path";

import { validateDesktopResourceManifest } from "./desktop-layout.mjs";
import { ToolError } from "./errors.mjs";
import { createDreamSkinApplicationContext } from "./product-application-context.mjs";
import { PROJECT_ROOT } from "./paths.mjs";

export const DREAMSKIN_PLUGIN_IDS = Object.freeze([
  "dreamskin.trae",
  "dreamskin.workbuddy",
]);

function defaultUserDataRoot(platform = process.platform, homeDir = os.homedir(), environment = process.env) {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "DreamSkin Studio");
  }
  if (platform === "win32") {
    return path.join(
      environment.APPDATA || path.join(homeDir, "AppData", "Roaming"),
      "DreamSkin Studio",
    );
  }
  return path.join(environment.XDG_CONFIG_HOME || path.join(homeDir, ".config"), "dreamskin-studio");
}

function targetPaths({ resourceRoot, dataRoot, pluginId, directory }) {
  const stateRoot = path.join(dataRoot, "state", pluginId);
  const pluginRoot = path.join(resourceRoot, "plugins", directory);
  return Object.freeze({
    pluginId,
    pluginRoot,
    pluginManifestPath: path.join(pluginRoot, "plugin.json"),
    catalogThemesRoot: path.join(pluginRoot, "catalog"),
    registryPath: path.join(pluginRoot, "resources", "components.v1.json"),
    themesRoot: path.join(dataRoot, "themes", pluginId),
    dataRoot: stateRoot,
    backupsRoot: path.join(dataRoot, "backups", pluginId),
    manifestPath: path.join(stateRoot, "library.json"),
  });
}

export function resolveDreamSkinCliPaths({
  platform = process.platform,
  homeDir = os.homedir(),
  environment = process.env,
} = {}) {
  const resourceRoot = path.resolve(environment.DREAMSKIN_RESOURCE_ROOT || PROJECT_ROOT);
  const userDataRoot = path.resolve(
    environment.DREAMSKIN_USER_DATA_ROOT || defaultUserDataRoot(platform, homeDir, environment),
  );
  const dataRoot = path.resolve(environment.DREAMSKIN_DATA_ROOT || path.join(userDataRoot, "dreamskin"));
  const appDataRoot = path.dirname(userDataRoot);
  const trae = targetPaths({
    resourceRoot,
    dataRoot,
    pluginId: "dreamskin.trae",
    directory: "trae",
  });
  const workBuddy = targetPaths({
    resourceRoot,
    dataRoot,
    pluginId: "dreamskin.workbuddy",
    directory: "workbuddy",
  });
  return Object.freeze({
    resourceRoot,
    userDataRoot,
    dataRoot,
    packaged: environment.DREAMSKIN_PACKAGED === "1",
    runtimeStateRoots: Object.freeze({
      "dreamskin.trae": path.resolve(
        environment.DREAMSKIN_TRAE_RUNTIME_STATE_ROOT || path.join(appDataRoot, "TraeDreamSkin"),
      ),
      "dreamskin.workbuddy": path.resolve(
        environment.DREAMSKIN_WORKBUDDY_RUNTIME_STATE_ROOT || path.join(appDataRoot, "WorkBuddyDreamSkin"),
      ),
    }),
    targets: Object.freeze({
      "dreamskin.trae": trae,
      "dreamskin.workbuddy": workBuddy,
    }),
  });
}

export async function createDreamSkinCliContext(options = {}) {
  const paths = resolveDreamSkinCliPaths(options);
  if (paths.packaged) {
    await validateDesktopResourceManifest({ resourceRoot: paths.resourceRoot });
  }
  process.env.TRAE_DREAM_SKIN_HOME = paths.runtimeStateRoots["dreamskin.trae"];
  const scriptsRoot = path.join(paths.resourceRoot, "scripts");
  const registration = (target) => ({
    themesRoot: target.themesRoot,
    dataRoot: target.dataRoot,
    backupsRoot: target.backupsRoot,
    projectRoot: paths.resourceRoot,
    pluginRoot: target.pluginRoot,
    pluginManifestPath: target.pluginManifestPath,
    catalogThemesRoot: target.catalogThemesRoot,
    registryPath: target.registryPath,
    scriptsRoot,
  });
  const context = await createDreamSkinApplicationContext({
    projectRoot: paths.resourceRoot,
    dataRoot: paths.dataRoot,
    themesRoot: path.join(paths.dataRoot, "themes"),
    traeOptions: registration(paths.targets["dreamskin.trae"]),
    workBuddyOptions: {
      ...registration(paths.targets["dreamskin.workbuddy"]),
      cssPath: path.join(paths.targets["dreamskin.workbuddy"].pluginRoot, "assets", "workbuddy-skin.css"),
      templatePath: path.join(paths.resourceRoot, "assets", "workbuddy-renderer-inject.js"),
      stateRoot: paths.runtimeStateRoots["dreamskin.workbuddy"],
    },
  });
  return Object.freeze({
    paths,
    context,
    tool: context.tool,
    targets: () => context.pluginManager.list().map((entry) => ({
      pluginId: entry.id,
      targetId: entry.manifest.target.id,
      name: entry.manifest.target.name,
      version: entry.manifest.version,
      active: entry.active,
    })),
    async close() {
      const active = context.pluginManager.list({ state: "active" });
      const settled = await Promise.allSettled(active.map((entry) => context.pluginManager.deactivate(entry.id)));
      const failure = settled.find((entry) => entry.status === "rejected");
      if (failure) {
        throw new ToolError("CLI_SHUTDOWN_FAILED", "DreamSkin CLI could not close its plugin context.", undefined, {
          cause: failure.reason,
        });
      }
    },
  });
}
