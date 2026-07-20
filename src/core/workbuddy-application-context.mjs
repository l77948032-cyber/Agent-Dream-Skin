import path from "node:path";

import {
  createWorkBuddyPlugin,
  loadWorkBuddyPluginManifest,
  WORKBUDDY_PLUGIN_ROOT,
} from "../../plugins/workbuddy/plugin.mjs";
import { createApplicationContext, LegacyDreamSkinFacade } from "./application-context.mjs";
import { ToolError } from "./errors.mjs";
import {
  PROJECT_ROOT,
  STUDIO_THEMES_ROOT,
  TOOL_DATA_ROOT,
} from "./paths.mjs";
import { resolvePluginResources } from "./plugin-api.mjs";
import { TraeDreamSkinService } from "./service.mjs";
import { ThemeRepository } from "./theme-repository.mjs";
import { WorkBuddyPlatformRuntime } from "./workbuddy-platform.mjs";

export const WORKBUDDY_PLUGIN_ID = "dreamskin.workbuddy";

export async function createWorkBuddyTargetRegistration({
  themesRoot = path.join(STUDIO_THEMES_ROOT, WORKBUDDY_PLUGIN_ID),
  dataRoot = path.join(TOOL_DATA_ROOT, "workbuddy"),
  backupsRoot = path.join(dataRoot, "backups"),
  projectRoot = PROJECT_ROOT,
  pluginRoot = WORKBUDDY_PLUGIN_ROOT,
  pluginManifestPath,
  catalogThemesRoot,
  registryPath,
  runtimeMappingPath,
  schemaPath,
  scriptsRoot = path.join(projectRoot, "scripts"),
  cssPath,
  templatePath,
  stateRoot,
  catalogRepository,
  repository,
  platformRuntime,
  service,
} = {}) {
  const targetPluginRoot = path.resolve(pluginRoot);
  const manifest = await loadWorkBuddyPluginManifest({
    pluginRoot: targetPluginRoot,
    manifestPath: pluginManifestPath,
  });
  const resources = await resolvePluginResources(manifest, targetPluginRoot);
  const targetRepository = repository || new ThemeRepository({
    themesRoot,
    dataRoot,
    backupsRoot,
    projectRoot: targetPluginRoot,
  });
  const targetRuntime = platformRuntime || new WorkBuddyPlatformRuntime({
    themesRoot,
    scriptsRoot,
    cssPath: cssPath || path.join(targetPluginRoot, "assets", "workbuddy-skin.css"),
    templatePath: templatePath || path.join(projectRoot, "assets", "workbuddy-renderer-inject.js"),
    registryPath: registryPath || resources.registryPath,
    stateRoot,
  });
  const resolvedCatalogRoot = catalogThemesRoot || resources.catalogRoot;
  if (!catalogRepository && !resolvedCatalogRoot) {
    throw new ToolError("INVALID_PLUGIN_RESOURCE", "WorkBuddy plugin manifest must declare a catalog root.", {
      pluginId: manifest.id,
      resource: "catalog",
    });
  }
  const targetCatalogRepository = catalogRepository || new ThemeRepository({
    themesRoot: resolvedCatalogRoot,
    dataRoot: path.join(dataRoot, "catalog"),
    backupsRoot: path.join(dataRoot, "catalog-backups"),
    projectRoot: targetPluginRoot,
  });
  const targetService = service || new TraeDreamSkinService({
    repository: targetRepository,
    runtime: targetRuntime,
    dataRoot,
    catalogRepository: targetCatalogRepository,
    registryPath: registryPath || resources.registryPath,
    runtimeMappingPath: runtimeMappingPath || resources.runtimeMappingPath,
    schemaPath: schemaPath || resources.schemaPath,
    target: manifest.target,
    product: "WorkBuddy-Dream-Skin",
  });
  const plugin = await createWorkBuddyPlugin({
    service: targetService,
    pluginRoot: targetPluginRoot,
    manifestPath: pluginManifestPath,
  });
  return {
    plugin,
    rootPath: plugin.rootPath,
    repository: targetRepository,
    platformRuntime: targetRuntime,
    targetService,
    catalogRepository: targetCatalogRepository,
    themesRoot: path.resolve(themesRoot),
    dataRoot: path.resolve(dataRoot),
    registryPath: registryPath || resources.registryPath,
  };
}

export async function createWorkBuddyApplicationContext(options = {}) {
  const target = await createWorkBuddyTargetRegistration(options);
  const context = await createApplicationContext({
    dataRoot: options.dataRoot || target.dataRoot,
    projectRoot: options.projectRoot || PROJECT_ROOT,
    defaultPluginId: target.plugin.manifest.id,
    targets: [target],
  });
  return {
    ...context,
    legacyService: new LegacyDreamSkinFacade({
      tool: context.tool,
      runtime: context.runtime,
      targetService: target.targetService,
      pluginId: target.plugin.manifest.id,
    }),
  };
}
