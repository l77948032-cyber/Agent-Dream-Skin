import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { TRAE_PLUGIN_ROOT } from "../../plugins/trae/plugin.mjs";

import { createTraeApplicationContext } from "./application-context.mjs";
import { ToolError } from "./errors.mjs";
import {
  PROJECT_ROOT,
  REGISTRY_PATH,
  STUDIO_DATA_ROOT,
  STUDIO_LIBRARY_PATH,
  STUDIO_THEMES_ROOT,
} from "./paths.mjs";
import { StudioLibrary } from "./studio-library.mjs";

function activeThemeId(status) {
  return (status?.session === "active" || status?.session === "degraded")
    && typeof status.themeId === "string"
    && status.themeId
    ? status.themeId
    : null;
}

function withoutPluginId(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { pluginId: _pluginId, ...rest } = input;
  return rest;
}

function studioTargetEntries(targets) {
  if (targets instanceof Map) return [...targets.values()];
  if (Array.isArray(targets)) return targets;
  if (targets && typeof targets === "object") return Object.values(targets);
  return [];
}

function studioTargetMap(targets, defaults) {
  const entries = studioTargetEntries(targets);
  if (entries.length === 0) entries.push(defaults);
  const result = new Map();
  for (const target of entries) {
    const pluginId = target.pluginId || target.plugin?.manifest?.id;
    if (typeof pluginId !== "string" || !pluginId || !target.library) {
      throw new ToolError(
        "INVALID_STUDIO_DEPENDENCY",
        "Every Studio target requires pluginId and library.",
      );
    }
    if (result.has(pluginId)) {
      throw new ToolError(
        "INVALID_STUDIO_DEPENDENCY",
        `Studio target '${pluginId}' is configured more than once.`,
        { pluginId },
      );
    }
    result.set(pluginId, Object.freeze({
      ...target,
      pluginId,
      targetId: target.targetId || target.plugin?.manifest?.target?.id,
      targetName: target.targetName || target.plugin?.manifest?.target?.name,
      registryPath: target.registryPath || defaults.registryPath,
      themesRoot: path.resolve(target.themesRoot || defaults.themesRoot),
      dataRoot: path.resolve(target.dataRoot || defaults.dataRoot),
      backupsRoot: path.resolve(
        target.backupsRoot
          || target.library.userRepository?.backupsRoot
          || defaults.backupsRoot
          || path.join(target.dataRoot || defaults.dataRoot, "backups"),
      ),
    }));
  }
  return result;
}

export class StudioBackend {
  constructor({
    tool,
    runtimeManager,
    pluginManager,
    library,
    cliManager = null,
    registryPath = REGISTRY_PATH,
    themesRoot = STUDIO_THEMES_ROOT,
    dataRoot = STUDIO_DATA_ROOT,
    backupsRoot,
    targets,
    defaultPluginId = runtimeManager?.defaultPluginId || "dreamskin.trae",
    runtimeMutationsEnabled = true,
    runtimeListCacheMs = 10_000,
    now = Date.now,
  }) {
    this.tool = tool;
    this.runtimeManager = runtimeManager;
    this.pluginManager = pluginManager;
    this.defaultPluginId = defaultPluginId;
    this.targets = studioTargetMap(targets, {
      pluginId: defaultPluginId,
      library,
      registryPath,
      themesRoot,
      dataRoot,
      backupsRoot: backupsRoot || library?.userRepository?.backupsRoot || path.join(dataRoot, "backups"),
    });
    if (!this.targets.has(defaultPluginId)) {
      throw new ToolError(
        "PLUGIN_NOT_FOUND",
        `Default Studio plugin '${defaultPluginId}' is not configured.`,
        { pluginId: defaultPluginId },
      );
    }
    const defaultTarget = this.targets.get(defaultPluginId);
    this.library = defaultTarget.library;
    this.cliManager = cliManager;
    this.registryPath = defaultTarget.registryPath;
    this.themesRoot = defaultTarget.themesRoot;
    this.previewRoot = path.join(path.resolve(dataRoot), "previews");
    this.runtimeMutationsEnabled = runtimeMutationsEnabled;
    this.runtimeListCacheMs = runtimeListCacheMs;
    this.now = now;
    this.runtimeListCache = new Map();
    this.registries = new Map();
    this.themeLifecycleQueue = Promise.resolve();
  }

  target(pluginId = this.defaultPluginId) {
    const target = this.targets.get(pluginId);
    if (!target) {
      throw new ToolError("PLUGIN_NOT_FOUND", `Plugin '${pluginId}' is not configured in Studio.`, { pluginId });
    }
    return target;
  }

  scopedInput(input = {}, pluginId) {
    if (
      pluginId
      && input?.pluginId !== undefined
      && input.pluginId !== pluginId
    ) {
      throw new ToolError(
        "INVALID_ARGUMENT",
        "Body pluginId must match the target selected by the route.",
        { routePluginId: pluginId, bodyPluginId: input.pluginId },
      );
    }
    const selectedPluginId = pluginId || input?.pluginId || this.defaultPluginId;
    return { pluginId: selectedPluginId, input: withoutPluginId(input) };
  }

  screenshotOptions(input, { defaultScreenshot, prefix }) {
    const screenshot = typeof input?.screenshot === "boolean" ? input.screenshot : defaultScreenshot;
    if (!screenshot) return { screenshot: false };
    return {
      screenshot: true,
      screenshotPath: path.join(this.previewRoot, `${prefix}-${Date.now()}-${crypto.randomUUID()}.png`),
    };
  }

  themeLifecycleOperation(action) {
    const operation = this.themeLifecycleQueue.then(action);
    this.themeLifecycleQueue = operation.catch(() => {});
    return operation;
  }

  assertRuntimeMutationsEnabled(pluginId = this.defaultPluginId) {
    this.target(pluginId);
    if (this.runtimeMutationsEnabled) return;
    throw new ToolError(
      "RUNTIME_PROFILE_READ_ONLY",
      "Runtime theme changes are disabled while Studio uses an isolated user data directory.",
      { pluginId, reason: "isolated-user-data" },
    );
  }

  async runtimeStatus({ failClosed = false, pluginId = this.defaultPluginId } = {}) {
    try {
      this.target(pluginId);
      if (!this.runtimeMutationsEnabled) {
        return {
          available: false,
          session: "off",
          themeId: null,
          reason: "isolated-user-data",
        };
      }
      const status = await this.runtimeManager.status(pluginId);
      if (failClosed && (
        !status
        || typeof status !== "object"
        || Array.isArray(status)
        || status.error
      )) {
        throw new ToolError(
          status?.error?.code || "RUNTIME_UNAVAILABLE",
          status?.error?.message || "Runtime status is unavailable.",
          { pluginId, runtimeError: status?.error || null },
        );
      }
      return status;
    } catch (error) {
      if (failClosed) throw error;
      return {
        available: false,
        error: { code: error.code || "RUNTIME_UNAVAILABLE", message: error.message },
      };
    }
  }

  async runtimeStatusForThemeList(pluginId = this.defaultPluginId) {
    const cached = this.runtimeListCache.get(pluginId);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const pending = this.runtimeStatus({ pluginId });
    this.runtimeListCache.set(pluginId, { expiresAt: Number.POSITIVE_INFINITY, value: pending });
    const status = await pending;
    if (this.runtimeListCache.get(pluginId)?.value === pending) {
      this.runtimeListCache.set(pluginId, {
        expiresAt: this.now() + this.runtimeListCacheMs,
        value: status,
      });
    }
    return status;
  }

  async components(pluginId = this.defaultPluginId) {
    const target = this.target(pluginId);
    if (!this.registries.has(pluginId)) {
      this.registries.set(pluginId, JSON.parse(await fs.readFile(target.registryPath, "utf8")));
    }
    return this.registries.get(pluginId).components || [];
  }

  async bootstrap() {
    const [targetResults, settings] = await Promise.all([
      Promise.all([...this.targets.values()].map(async (target) => {
        const [inspect, runtime, catalog, components] = await Promise.all([
          this.tool.inspect(target.pluginId),
          this.runtimeStatus({ pluginId: target.pluginId }),
          target.library.catalog(),
          this.components(target.pluginId),
        ]);
        const plugin = typeof this.pluginManager.get === "function"
          ? this.pluginManager.get(target.pluginId)
          : null;
        return {
          pluginId: target.pluginId,
          targetId: target.targetId || plugin?.manifest?.target?.id,
          targetName: target.targetName || plugin?.manifest?.target?.name,
          plugin,
          catalog,
          themes: await target.library.list({ activeThemeId: activeThemeId(runtime) }),
          inspect,
          runtime,
          components,
          themesRoot: target.themesRoot,
        };
      })),
      this.library.settings(),
    ]);
    const defaultTarget = targetResults.find((target) => target.pluginId === this.defaultPluginId);
    return {
      // Legacy fields continue to describe the default target.
      catalog: defaultTarget.catalog,
      themes: defaultTarget.themes,
      plugins: this.pluginManager.list(),
      activePluginId: this.defaultPluginId,
      targets: targetResults,
      settings: {
        ...settings,
        themesRoot: this.themesRoot,
        themeRoots: Object.fromEntries(targetResults.map((target) => [target.pluginId, target.themesRoot])),
      },
      inspect: defaultTarget.inspect,
      runtime: defaultTarget.runtime,
    };
  }

  async themes(pluginId = this.defaultPluginId) {
    const target = this.target(pluginId);
    const status = await this.runtimeStatusForThemeList(pluginId);
    return target.library.list({ activeThemeId: activeThemeId(status) });
  }

  async theme(id, pluginId = this.defaultPluginId) {
    const target = this.target(pluginId);
    const status = await this.runtimeStatus({ pluginId });
    return target.library.read(id, { activeThemeId: activeThemeId(status) });
  }

  async createTheme(rawInput = {}, explicitPluginId) {
    const { pluginId, input } = this.scopedInput(rawInput, explicitPluginId);
    const target = this.target(pluginId);
    const status = await this.runtimeStatus({ pluginId });
    const options = { activeThemeId: activeThemeId(status) };
    if (input.kind === "template") return target.library.addTemplate(input.sourceId, options);
    if (input.kind === "blank") return target.library.createBlank(options);
    throw new ToolError("INVALID_ARGUMENT", "kind must be 'template' or 'blank'.");
  }

  async duplicateTheme(id, pluginId = this.defaultPluginId) {
    const target = this.target(pluginId);
    const status = await this.runtimeStatus({ pluginId });
    return target.library.duplicate(id, { activeThemeId: activeThemeId(status) });
  }

  async deleteTheme(id, rawInput = {}, explicitPluginId) {
    const { pluginId, input } = this.scopedInput(rawInput, explicitPluginId);
    const target = this.target(pluginId);
    if (typeof input.expectedRevision !== "string" || !input.expectedRevision) {
      throw new ToolError("INVALID_ARGUMENT", "expectedRevision is required when deleting a theme.");
    }
    return this.themeLifecycleOperation(async () => {
      const status = await this.runtimeStatus({ failClosed: true, pluginId });
      const appliedThemeId = activeThemeId(status);
      const ambiguousOwnedSession = status.session === "orphaned"
        || status.session === "orphaned-unverified"
        || ((status.session === "active" || status.session === "degraded") && !appliedThemeId);
      if (ambiguousOwnedSession) {
        throw new ToolError(
          "THEME_ACTIVE",
          "Restore the runtime before deleting themes while its active theme identity is unavailable.",
          { pluginId, themeId: null, runtimeSession: status.session },
        );
      }
      if (appliedThemeId === id) {
        throw new ToolError("THEME_ACTIVE", "Restore or apply another theme before deleting the active theme.", {
          pluginId,
          themeId: id,
        });
      }
      return target.library.delete(id, { expectedRevision: input.expectedRevision });
    });
  }

  async updateTheme(id, rawInput = {}, explicitPluginId) {
    const { pluginId, input } = this.scopedInput(rawInput, explicitPluginId);
    const target = this.target(pluginId);
    if (typeof input.expectedRevision !== "string" || !input.expectedRevision) {
      throw new ToolError("INVALID_ARGUMENT", "expectedRevision is required when updating an existing theme.");
    }
    return this.themeLifecycleOperation(async () => {
      const status = await this.runtimeStatus({ pluginId });
      return target.library.update(id, input, { activeThemeId: activeThemeId(status) });
    });
  }

  async applyTheme(id, pluginId = this.defaultPluginId) {
    this.assertRuntimeMutationsEnabled(pluginId);
    const target = this.target(pluginId);
    return this.themeLifecycleOperation(async () => {
      const before = await target.library.read(id);
      await this.tool.validateTheme({ themeId: id }, pluginId);
      const runtime = await this.runtimeManager.apply(id, pluginId);
      this.runtimeListCache.delete(pluginId);
      try {
        return {
          theme: await target.library.markApplied(id, before.revisionHash),
          runtime,
        };
      } catch (error) {
        await this.runtimeManager.restore(pluginId).catch(() => {});
        throw error;
      }
    });
  }

  async validateTheme(id, pluginId = this.defaultPluginId) {
    const target = this.target(pluginId);
    await target.library.read(id);
    return this.tool.validateTheme({ themeId: id }, pluginId);
  }

  async previewTheme(id, rawInput = {}, explicitPluginId) {
    const { pluginId, input } = this.scopedInput(rawInput, explicitPluginId);
    this.assertRuntimeMutationsEnabled(pluginId);
    const target = this.target(pluginId);
    return this.themeLifecycleOperation(async () => {
      await target.library.read(id);
      return this.runtimeManager.preview({ id, ...this.screenshotOptions(input, {
        defaultScreenshot: true,
        prefix: "preview",
      }) }, pluginId);
    });
  }

  catalog(pluginId = this.defaultPluginId) {
    return this.target(pluginId).library.catalog();
  }

  asset(kind, id, pluginId = this.defaultPluginId) {
    return this.target(pluginId).library.asset(kind, id);
  }

  async settings() {
    return {
      ...await this.library.settings(),
      themesRoot: this.themesRoot,
      themeRoots: Object.fromEntries(
        [...this.targets.values()].map((target) => [target.pluginId, target.themesRoot]),
      ),
    };
  }

  async updateSettings(input) {
    return {
      ...await this.library.updateSettings(input),
      themesRoot: this.themesRoot,
      themeRoots: Object.fromEntries(
        [...this.targets.values()].map((target) => [target.pluginId, target.themesRoot]),
      ),
    };
  }

  async cliStatus() {
    if (this.cliManager?.status) return this.cliManager.status();
    return {
      supported: false,
      state: "unsupported",
      installed: false,
      current: false,
      available: false,
      command: "dreamskin",
      path: null,
      targetPath: "",
      pathAvailable: false,
      message: "CLI 安装仅在 macOS 桌面安装包中提供。",
    };
  }

  async installCli() {
    if (!this.cliManager?.install) {
      throw new ToolError("CLI_INSTALL_UNSUPPORTED", "DreamSkin CLI installation is not available in this Studio mode.");
    }
    return this.cliManager.install();
  }

  async uninstallCli() {
    if (!this.cliManager?.uninstall) {
      throw new ToolError("CLI_INSTALL_UNSUPPORTED", "DreamSkin CLI installation is not available in this Studio mode.");
    }
    return this.cliManager.uninstall();
  }

  verify(rawInput = {}, explicitPluginId) {
    const { pluginId, input } = this.scopedInput(rawInput, explicitPluginId);
    this.assertRuntimeMutationsEnabled(pluginId);
    return this.runtimeManager.verify(this.screenshotOptions(input, {
      defaultScreenshot: false,
      prefix: "verify",
    }), pluginId);
  }

  restore(pluginId = this.defaultPluginId) {
    this.assertRuntimeMutationsEnabled(pluginId);
    return this.themeLifecycleOperation(async () => {
      const restored = await this.runtimeManager.restore(pluginId);
      this.runtimeListCache.delete(pluginId);
      return restored;
    });
  }

  async close() {
    const active = this.pluginManager.list({ state: "active" });
    await Promise.allSettled(active.map((entry) => this.pluginManager.deactivate(entry.id)));
  }
}

export async function createStudioBackend({
  pluginRoot = TRAE_PLUGIN_ROOT,
  pluginManifestPath,
  catalogThemesRoot,
  registryPath,
  userThemesRoot = STUDIO_THEMES_ROOT,
  dataRoot = STUDIO_DATA_ROOT,
  manifestPath = STUDIO_LIBRARY_PATH,
  projectRoot = PROJECT_ROOT,
  scriptsRoot = path.join(projectRoot, "scripts"),
  cliManager,
  applicationContext,
  defaultPluginId,
  targetOptions = {},
  runtimeMutationsEnabled = true,
} = {}) {
  const context = applicationContext || await createTraeApplicationContext({
    themesRoot: userThemesRoot,
    dataRoot,
    backupsRoot: path.join(dataRoot, "backups"),
    projectRoot,
    pluginRoot,
    pluginManifestPath,
    catalogThemesRoot,
    registryPath,
    scriptsRoot,
  });
  const resolvedDefaultPluginId = defaultPluginId
    || context.defaultPluginId
    || context.runtime.defaultPluginId
    || context.plugin.manifest.id;
  const applicationTargets = context.targets instanceof Map
    ? [...context.targets.values()]
    : [{
        plugin: context.plugin,
        pluginId: context.plugin.manifest.id,
        repository: context.repository,
        catalogRepository: context.catalogRepository,
        resources: context.pluginManager.resources(context.plugin.manifest.id),
        themesRoot: userThemesRoot,
      }];
  const studioTargets = applicationTargets.map((target) => {
    const pluginId = target.pluginId || target.plugin.manifest.id;
    const options = targetOptions instanceof Map
      ? targetOptions.get(pluginId) || {}
      : targetOptions[pluginId] || {};
    const isDefault = pluginId === resolvedDefaultPluginId;
    const targetManifestPath = options.manifestPath
      || target.manifestPath
      || (isDefault
        ? manifestPath
        : path.join(path.dirname(manifestPath), "libraries", `${pluginId}.json`));
    const targetThemesRoot = options.themesRoot || target.themesRoot;
    const targetPlugin = target.plugin;
    if (!targetThemesRoot || (!options.library && (
      !target.repository
      || !target.catalogRepository
      || !targetPlugin?.catalog
    ))) {
      throw new ToolError(
        "INVALID_STUDIO_DEPENDENCY",
        `Studio target '${pluginId}' requires repositories, catalog, and themesRoot.`,
        { pluginId },
      );
    }
    const library = options.library || new StudioLibrary({
      catalogRepository: target.catalogRepository,
      userRepository: target.repository,
      tool: context.tool,
      pluginId,
      catalog: targetPlugin.catalog,
      manifestPath: targetManifestPath,
      apiPrefix: options.apiPrefix || (isDefault
        ? "/api/v1"
        : `/api/v1/plugins/${encodeURIComponent(pluginId)}`),
    });
    const targetDataRoot = options.dataRoot || target.dataRoot || (isDefault
      ? dataRoot
      : path.join(dataRoot, "targets", pluginId));
    return {
      pluginId,
      targetId: target.targetId || targetPlugin?.manifest?.target?.id,
      targetName: target.targetName || targetPlugin?.manifest?.target?.name,
      plugin: targetPlugin,
      pluginRoot: options.pluginRoot || target.rootPath || targetPlugin?.rootPath,
      library,
      registryPath: options.registryPath
        || target.registryPath
        || target.resources?.registryPath
        || context.pluginManager.resources(pluginId).registryPath,
      themesRoot: targetThemesRoot,
      dataRoot: targetDataRoot,
      backupsRoot: options.backupsRoot
        || target.repository?.backupsRoot
        || library.userRepository?.backupsRoot
        || path.join(targetDataRoot, "backups"),
    };
  });
  const defaultTarget = studioTargets.find((target) => target.pluginId === resolvedDefaultPluginId);
  if (!defaultTarget) {
    throw new ToolError("PLUGIN_NOT_FOUND", `Default Studio plugin '${resolvedDefaultPluginId}' is not configured.`, {
      pluginId: resolvedDefaultPluginId,
    });
  }
  return new StudioBackend({
    tool: context.tool,
    runtimeManager: context.runtime,
    pluginManager: context.pluginManager,
    library: defaultTarget.library,
    cliManager,
    registryPath: defaultTarget.registryPath,
    themesRoot: defaultTarget.themesRoot,
    targets: studioTargets,
    defaultPluginId: resolvedDefaultPluginId,
    dataRoot,
    runtimeMutationsEnabled,
  });
}
