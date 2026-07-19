import path from "node:path";

import {
  createTraePlugin,
  loadTraePluginManifest,
  TRAE_PLUGIN_ROOT,
} from "../../plugins/trae/plugin.mjs";
import { DreamSkinToolCore } from "./dreamskin-tool.mjs";
import { ToolError } from "./errors.mjs";
import {
  BACKUPS_ROOT,
  PROJECT_ROOT,
  THEMES_ROOT,
  TOOL_DATA_ROOT,
} from "./paths.mjs";
import { PlatformRuntime } from "./platform.mjs";
import { resolvePluginResources } from "./plugin-api.mjs";
import { PluginManager } from "./plugin-manager.mjs";
import { HostRuntimeManager } from "./runtime-manager.mjs";
import { TraeDreamSkinService } from "./service.mjs";
import { ThemeRepository } from "./theme-repository.mjs";

export const DEFAULT_PLUGIN_ID = "dreamskin.trae";

export class LegacyDreamSkinFacade {
  constructor({ tool, runtime, targetService, pluginId = DEFAULT_PLUGIN_ID }) {
    this.tool = tool;
    this.runtime = runtime;
    this.targetService = targetService;
    this.pluginId = pluginId;
  }

  inspect() {
    return this.tool.inspect(this.pluginId);
  }

  themeList() {
    return this.tool.listThemes(this.pluginId);
  }

  themeRead(id) {
    return this.tool.readTheme(id, this.pluginId);
  }

  themeWrite(input = {}) {
    // Compatibility callers retain image replacement and rollback semantics.
    return this.targetService.themeWrite(input);
  }

  themeValidate(input = {}) {
    return this.tool.validateTheme({
      ...(input.id === undefined ? {} : { themeId: input.id }),
      ...(input.theme === undefined ? {} : { theme: input.theme }),
    }, this.pluginId);
  }

  preview(id, options = {}) {
    return this.runtime.preview({ id, ...options }, this.pluginId);
  }

  apply(id) {
    return this.runtime.apply(id, this.pluginId);
  }

  verify(options = {}) {
    return this.runtime.verify(options, this.pluginId);
  }

  restore() {
    return this.runtime.restore(this.pluginId);
  }
}

export async function createTraeApplicationContext({
  themesRoot = THEMES_ROOT,
  dataRoot = TOOL_DATA_ROOT,
  backupsRoot = BACKUPS_ROOT,
  projectRoot = PROJECT_ROOT,
  pluginRoot = TRAE_PLUGIN_ROOT,
  pluginManifestPath,
  catalogThemesRoot,
  registryPath,
  runtimeMappingPath,
  schemaPath,
  scriptsRoot = path.join(projectRoot, "scripts"),
  catalogRepository,
  repository,
  platformRuntime,
  service,
} = {}) {
  const targetPluginRoot = path.resolve(pluginRoot);
  const manifest = await loadTraePluginManifest({
    pluginRoot: targetPluginRoot,
    manifestPath: pluginManifestPath,
  });
  const pluginResources = await resolvePluginResources(manifest, targetPluginRoot);
  const targetRepository = repository || new ThemeRepository({
    themesRoot,
    dataRoot,
    backupsRoot,
    projectRoot: targetPluginRoot,
  });
  const targetRuntime = platformRuntime || new PlatformRuntime({ themesRoot, scriptsRoot });
  const resolvedCatalogThemesRoot = catalogThemesRoot || pluginResources.catalogRoot;
  if (!catalogRepository && !resolvedCatalogThemesRoot) {
    throw new ToolError("INVALID_PLUGIN_RESOURCE", "Trae plugin manifest must declare a catalog root.", {
      pluginId: manifest.id,
      resource: "catalog",
    });
  }
  const targetCatalogRepository = catalogRepository || new ThemeRepository({
    themesRoot: resolvedCatalogThemesRoot,
    dataRoot: path.join(dataRoot, "catalog"),
    backupsRoot: path.join(dataRoot, "catalog-backups"),
    projectRoot: targetPluginRoot,
  });
  const targetService = service || new TraeDreamSkinService({
    repository: targetRepository,
    runtime: targetRuntime,
    dataRoot,
    catalogRepository: targetCatalogRepository,
    registryPath: registryPath || pluginResources.registryPath,
    runtimeMappingPath: runtimeMappingPath || pluginResources.runtimeMappingPath,
    schemaPath: schemaPath || pluginResources.schemaPath,
  });
  const pluginManager = new PluginManager({
    context: {
      dataRoot: path.resolve(dataRoot),
      projectRoot: path.resolve(projectRoot),
    },
  });
  const plugin = await createTraePlugin({
    service: targetService,
    pluginRoot: targetPluginRoot,
    manifestPath: pluginManifestPath,
  });
  await pluginManager.register(plugin, { rootPath: plugin.rootPath });
  await pluginManager.activate(plugin.manifest.id);
  const tool = new DreamSkinToolCore({ pluginManager, defaultPluginId: plugin.manifest.id });
  const runtime = new HostRuntimeManager({ pluginManager, defaultPluginId: plugin.manifest.id });
  return {
    plugin,
    pluginManager,
    tool,
    runtime,
    legacyService: new LegacyDreamSkinFacade({
      tool,
      runtime,
      targetService,
      pluginId: plugin.manifest.id,
    }),
    repository: targetRepository,
    platformRuntime: targetRuntime,
    targetService,
    catalogRepository: targetCatalogRepository,
  };
}
