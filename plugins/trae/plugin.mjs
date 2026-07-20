import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ToolError } from "../../src/core/errors.mjs";
import { validatePluginManifest } from "../../src/core/plugin-api.mjs";
import { mergeThemePatch } from "../../src/core/theme-patch.mjs";
import { TraeDreamSkinService } from "../../src/core/service.mjs";
import { TRAE_CATALOG } from "./catalog.mjs";

const sourcePluginRoot = path.dirname(fileURLToPath(import.meta.url));
export const TRAE_PLUGIN_ROOT = sourcePluginRoot;
export const TRAE_PLUGIN_CATALOG_ROOT = path.join(sourcePluginRoot, "catalog");
export const TRAE_PLUGIN_MANIFEST_PATH = path.join(sourcePluginRoot, "plugin.json");

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function pluginLocation({ pluginRoot = TRAE_PLUGIN_ROOT, manifestPath } = {}) {
  if (typeof pluginRoot !== "string" || pluginRoot.length === 0) {
    throw new ToolError("INVALID_PLUGIN_RESOURCE", "Trae pluginRoot must be a non-empty string.");
  }
  const rootPath = path.resolve(pluginRoot);
  const resolvedManifestPath = path.resolve(manifestPath || path.join(rootPath, "plugin.json"));
  if (!isWithin(rootPath, resolvedManifestPath)) {
    throw new ToolError("INVALID_PLUGIN_RESOURCE", "Trae plugin manifest must stay inside its plugin root.");
  }
  return { rootPath, manifestPath: resolvedManifestPath };
}

function assertInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolError("INVALID_TOOL_INPUT", "DreamSkin Tool input must be an object.");
  }
  return input;
}

function requireId(input) {
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new ToolError("INVALID_TOOL_INPUT", "A non-empty theme id is required.");
  }
  return input.id;
}

function requireEmpty(input, action) {
  if (Object.keys(input).length > 0) {
    throw new ToolError("INVALID_TOOL_INPUT", `Theme action '${action}' does not accept input.`);
  }
}

export async function loadTraePluginManifest(options = {}) {
  const location = pluginLocation(options);
  let manifest;
  try {
    const [rootRealPath, manifestStat, manifestRealPath] = await Promise.all([
      fs.realpath(location.rootPath),
      fs.lstat(location.manifestPath),
      fs.realpath(location.manifestPath),
    ]);
    if (manifestStat.isSymbolicLink() || !manifestStat.isFile() || !isWithin(rootRealPath, manifestRealPath)) {
      throw new Error("Manifest must be a regular file inside the plugin root.");
    }
    manifest = JSON.parse(await fs.readFile(manifestRealPath, "utf8"));
  } catch (error) {
    throw new ToolError("INVALID_PLUGIN_MANIFEST", "Could not read the Trae plugin manifest.", {
      path: location.manifestPath,
    }, { cause: error });
  }
  return validatePluginManifest(manifest);
}

export async function createTraePlugin({
  service = new TraeDreamSkinService(),
  pluginRoot = TRAE_PLUGIN_ROOT,
  manifestPath,
} = {}) {
  const location = pluginLocation({ pluginRoot, manifestPath });
  const manifest = await loadTraePluginManifest({
    pluginRoot: location.rootPath,
    manifestPath: location.manifestPath,
  });
  if (!service || typeof service !== "object") {
    throw new ToolError("INVALID_PLUGIN_DEPENDENCY", "Trae plugin requires a DreamSkin service.");
  }

  return Object.freeze({
    manifest,
    rootPath: location.rootPath,
    catalog: TRAE_CATALOG,

    async activate() {
      return { pluginId: manifest.id, target: manifest.target.id };
    },

    async deactivate() {
      return { pluginId: manifest.id, deactivated: true };
    },

    async executeThemeAction(action, rawInput = {}) {
      const input = assertInput(rawInput);
      switch (action) {
        case "inspect":
          requireEmpty(input, action);
          return Promise.resolve(
            typeof service.toolInspect === "function" ? service.toolInspect() : service.inspect(),
          ).then((result) => ({
            ...result,
            catalog: {
              targetId: TRAE_CATALOG.targetId,
              targetName: TRAE_CATALOG.targetName,
              blankSourceId: TRAE_CATALOG.blank.sourceId,
              templates: Object.entries(TRAE_CATALOG.templates).map(([id, metadata]) => ({ id, ...metadata })),
            },
          }));
        case "list":
          requireEmpty(input, action);
          return Promise.resolve(service.themeList()).then(({ themesRoot: _themesRoot, ...result }) => result);
        case "read":
          return service.themeRead(requireId(input));
        case "create": {
          const id = requireId(input);
          const blankRequested = input.sourceId === undefined || input.sourceId === "blank";
          const sourceId = blankRequested ? TRAE_CATALOG.blank.sourceId : input.sourceId;
          if (!TRAE_CATALOG.hasTemplate(sourceId)) {
            throw new ToolError("TEMPLATE_NOT_FOUND", `Template '${sourceId}' does not exist in the Trae plugin.`);
          }
          if (!service.catalogRepository) {
            throw new ToolError("INVALID_PLUGIN_DEPENDENCY", "Trae theme creation requires its catalog repository.");
          }
          const source = await service.catalogRepository.read(sourceId);
          const imagePath = path.join(service.catalogRepository.themePath(sourceId), source.asset.file);
          const baseTheme = blankRequested
            ? TRAE_CATALOG.createBlankTheme({ sourceTheme: source.theme, id })
            : source.theme;
          const themePatch = mergeThemePatch(baseTheme, input.themePatch || {});
          themePatch.id = id;
          return service.themeWrite({
            id,
            imagePath,
            themePatch,
            provenance: blankRequested
              ? { schemaVersion: 1, origin: "blank" }
              : { schemaVersion: 1, origin: "template", sourceId },
            ...(input.dryRun ? { dryRun: true } : {}),
            operation: "write",
            expectedRevision: null,
          });
        }
        case "update": {
          const id = requireId(input);
          const { operation: _operation, transactionId: _transactionId, ...writeInput } = input;
          return service.themeWrite({ ...writeInput, id, operation: "write" });
        }
        case "importAsset": {
          const id = requireId(input);
          return service.themeWrite({
            id,
            imagePath: input.assetPath,
            themePatch: {},
            expectedRevision: input.expectedRevision,
            ...(input.dryRun ? { dryRun: true } : {}),
            operation: "write",
          });
        }
        case "validate":
          return service.themeValidate(input);
        default:
          throw new ToolError("PLUGIN_ACTION_NOT_SUPPORTED", `Theme action '${action}' is not supported.`, {
            pluginId: manifest.id,
            action,
          });
      }
    },

    async createPreview(rawInput = {}) {
      const input = assertInput(rawInput);
      const id = requireId(input);
      const { id: _id, ...options } = input;
      return service.preview(id, options);
    },

    async runtimeStatus() {
      if (typeof service.runtimeStatus === "function") return service.runtimeStatus();
      const inspected = await service.inspect();
      return inspected.status;
    },

    async executeRuntimeAction(action, rawInput = {}) {
      const input = assertInput(rawInput);
      switch (action) {
        case "apply":
          return service.apply(requireId(input));
        case "verify":
          return service.verify(input);
        case "restore":
          requireEmpty(input, action);
          return service.restore();
        default:
          throw new ToolError("PLUGIN_ACTION_NOT_SUPPORTED", `Runtime action '${action}' is not supported.`, {
            pluginId: manifest.id,
            action,
          });
      }
    },
  });
}
