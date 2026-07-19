import fs from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./errors.mjs";

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
export const DREAMSKIN_THEME_TOOL_NAME = "dreamskin_theme";
export const THEME_TOOL_ACTIONS = Object.freeze([
  "inspect",
  "list",
  "read",
  "create",
  "update",
  "validate",
]);
export const RUNTIME_ACTIONS = Object.freeze(["apply", "verify", "restore"]);

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SUPPORTED_PLATFORMS = new Set(["darwin", "win32", "linux"]);
const THEME_ACTION_SET = new Set(THEME_TOOL_ACTIONS);
const RUNTIME_ACTION_SET = new Set(RUNTIME_ACTIONS);

function fail(message, field, details = undefined) {
  throw new ToolError("INVALID_PLUGIN_MANIFEST", message, {
    field,
    ...details,
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertObject(value, field) {
  if (!isPlainObject(value)) fail(`${field} must be an object.`, field);
}

function assertExactKeys(value, { required, optional = [] }, field) {
  assertObject(value, field);
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) {
    fail(`${field} is missing required fields: ${missing.join(", ")}.`, field, { missing });
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${field} contains unknown fields: ${unknown.join(", ")}.`, field, { unknown });
  }
}

function assertString(value, field, { maxLength = 160, pattern } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(`${field} must be a non-empty string no longer than ${maxLength} characters.`, field);
  }
  if (pattern && !pattern.test(value)) fail(`${field} has an invalid format.`, field);
  return value;
}

function assertBoolean(value, field) {
  if (typeof value !== "boolean") fail(`${field} must be a boolean.`, field);
  return value;
}

function assertUniqueEnumArray(value, field, allowed, { required = true } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    fail(`${field} must be ${required ? "a non-empty" : "an"} array.`, field);
  }
  const unknown = value.filter((entry) => typeof entry !== "string" || !allowed.has(entry));
  if (unknown.length > 0) fail(`${field} contains unsupported values.`, field, { values: unknown });
  if (new Set(value).size !== value.length) fail(`${field} must not contain duplicates.`, field);
  return [...value];
}

function assertPortablePath(value, field) {
  assertString(value, field, { maxLength: 240 });
  if (path.isAbsolute(value) || value.includes("\\") || value.includes("\0")) {
    fail(`${field} must be a portable project-relative path.`, field);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    fail(`${field} cannot contain empty or traversing path segments.`, field);
  }
  return value;
}

function assertResourcePath(value, field) {
  assertPortablePath(value, field);
  if (path.extname(value).toLowerCase() !== ".json") fail(`${field} must point to a JSON file.`, field);
  return value;
}

function assertEntryPath(value, field) {
  assertPortablePath(value, field);
  if (path.extname(value).toLowerCase() !== ".mjs") fail(`${field} must point to an ESM .mjs entry.`, field);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function validatePluginManifest(input) {
  assertExactKeys(input, {
    required: ["schemaVersion", "id", "name", "version", "target", "theme", "themeTool", "capabilities"],
    optional: ["description", "entry", "catalog"],
  }, "manifest");
  if (input.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) {
    fail(`manifest.schemaVersion must be ${PLUGIN_MANIFEST_SCHEMA_VERSION}.`, "manifest.schemaVersion");
  }

  assertString(input.id, "manifest.id", { maxLength: 128, pattern: PLUGIN_ID_PATTERN });
  assertString(input.name, "manifest.name", { maxLength: 80 });
  assertString(input.version, "manifest.version", { maxLength: 80, pattern: VERSION_PATTERN });
  if (input.description !== undefined) assertString(input.description, "manifest.description", { maxLength: 240 });
  const entry = input.entry === undefined ? undefined : assertEntryPath(input.entry, "manifest.entry");
  if (input.catalog !== undefined) {
    assertExactKeys(input.catalog, { required: ["root"] }, "manifest.catalog");
    assertPortablePath(input.catalog.root, "manifest.catalog.root");
  }

  assertExactKeys(input.target, { required: ["id", "name", "platforms"] }, "manifest.target");
  assertString(input.target.id, "manifest.target.id", { maxLength: 80, pattern: PLUGIN_ID_PATTERN });
  assertString(input.target.name, "manifest.target.name", { maxLength: 80 });
  const platforms = assertUniqueEnumArray(input.target.platforms, "manifest.target.platforms", SUPPORTED_PLATFORMS);

  assertExactKeys(input.theme, {
    required: ["schemaPath", "registryPath"],
    optional: ["runtimeMappingPath"],
  }, "manifest.theme");
  const theme = {
    schemaPath: assertResourcePath(input.theme.schemaPath, "manifest.theme.schemaPath"),
    registryPath: assertResourcePath(input.theme.registryPath, "manifest.theme.registryPath"),
    ...(input.theme.runtimeMappingPath === undefined
      ? {}
      : { runtimeMappingPath: assertResourcePath(input.theme.runtimeMappingPath, "manifest.theme.runtimeMappingPath") }),
  };

  assertExactKeys(input.themeTool, { required: ["name", "actions"] }, "manifest.themeTool");
  if (input.themeTool.name !== DREAMSKIN_THEME_TOOL_NAME) {
    fail(`manifest.themeTool.name must be '${DREAMSKIN_THEME_TOOL_NAME}'.`, "manifest.themeTool.name");
  }
  const themeActions = assertUniqueEnumArray(
    input.themeTool.actions,
    "manifest.themeTool.actions",
    THEME_ACTION_SET,
  );

  assertExactKeys(input.capabilities, { required: ["preview", "runtime"] }, "manifest.capabilities");
  assertExactKeys(input.capabilities.preview, {
    required: ["supported", "screenshot", "restoresPreviousState"],
  }, "manifest.capabilities.preview");
  const preview = {
    supported: assertBoolean(input.capabilities.preview.supported, "manifest.capabilities.preview.supported"),
    screenshot: assertBoolean(input.capabilities.preview.screenshot, "manifest.capabilities.preview.screenshot"),
    restoresPreviousState: assertBoolean(
      input.capabilities.preview.restoresPreviousState,
      "manifest.capabilities.preview.restoresPreviousState",
    ),
  };
  if (!preview.supported && (preview.screenshot || preview.restoresPreviousState)) {
    fail(
      "Unsupported preview capability cannot advertise screenshots or state restoration.",
      "manifest.capabilities.preview",
    );
  }

  assertExactKeys(input.capabilities.runtime, { required: ["supported", "actions"] }, "manifest.capabilities.runtime");
  const runtimeSupported = assertBoolean(
    input.capabilities.runtime.supported,
    "manifest.capabilities.runtime.supported",
  );
  const runtimeActions = assertUniqueEnumArray(
    input.capabilities.runtime.actions,
    "manifest.capabilities.runtime.actions",
    RUNTIME_ACTION_SET,
    { required: runtimeSupported },
  );
  if (!runtimeSupported && runtimeActions.length > 0) {
    fail("Unsupported runtime capability cannot advertise actions.", "manifest.capabilities.runtime.actions");
  }

  return deepFreeze({
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    version: input.version,
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(entry === undefined ? {} : { entry }),
    ...(input.catalog === undefined ? {} : { catalog: { root: input.catalog.root } }),
    target: { id: input.target.id, name: input.target.name, platforms },
    theme,
    themeTool: { name: DREAMSKIN_THEME_TOOL_NAME, actions: themeActions },
    capabilities: {
      preview,
      runtime: { supported: runtimeSupported, actions: runtimeActions },
    },
  });
}

export function assertPluginContract(plugin, manifest = validatePluginManifest(plugin?.manifest)) {
  if (!plugin || typeof plugin !== "object") {
    throw new ToolError("INVALID_PLUGIN_CONTRACT", "A plugin must be an object.");
  }
  if (typeof plugin.executeThemeAction !== "function") {
    throw new ToolError("INVALID_PLUGIN_CONTRACT", "Plugin must implement executeThemeAction(action, input).", {
      pluginId: manifest.id,
    });
  }
  for (const lifecycleMethod of ["activate", "deactivate"]) {
    if (plugin[lifecycleMethod] !== undefined && typeof plugin[lifecycleMethod] !== "function") {
      throw new ToolError("INVALID_PLUGIN_CONTRACT", `Plugin ${lifecycleMethod} must be a function.`, {
        pluginId: manifest.id,
      });
    }
  }
  if (manifest.capabilities.preview.supported && typeof plugin.createPreview !== "function") {
    throw new ToolError("INVALID_PLUGIN_CONTRACT", "Preview-capable plugin must implement createPreview(input).", {
      pluginId: manifest.id,
    });
  }
  if (manifest.capabilities.runtime.supported && typeof plugin.executeRuntimeAction !== "function") {
    throw new ToolError(
      "INVALID_PLUGIN_CONTRACT",
      "Runtime-capable plugin must implement executeRuntimeAction(action, input).",
      { pluginId: manifest.id },
    );
  }
  if (manifest.capabilities.runtime.supported && typeof plugin.runtimeStatus !== "function") {
    throw new ToolError("INVALID_PLUGIN_CONTRACT", "Runtime-capable plugin must implement runtimeStatus().", {
      pluginId: manifest.id,
    });
  }
  return plugin;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function resolvePluginResources(manifestInput, rootPath) {
  const manifest = validatePluginManifest(manifestInput);
  if (typeof rootPath !== "string" || rootPath.length === 0) {
    throw new ToolError("INVALID_PLUGIN_RESOURCE", "Plugin rootPath must be a non-empty string.", {
      pluginId: manifest.id,
    });
  }

  let realRoot;
  try {
    realRoot = await fs.realpath(path.resolve(rootPath));
  } catch (error) {
    throw new ToolError("INVALID_PLUGIN_RESOURCE", "Plugin rootPath does not exist.", {
      pluginId: manifest.id,
      rootPath: path.resolve(rootPath),
    }, { cause: error });
  }

  const resources = {};
  for (const [name, relativePath] of Object.entries(manifest.theme)) {
    const candidate = path.resolve(realRoot, relativePath);
    if (!isWithin(realRoot, candidate)) {
      throw new ToolError("INVALID_PLUGIN_RESOURCE", `Plugin resource '${name}' escapes its root.`, {
        pluginId: manifest.id,
        resource: name,
      });
    }
    try {
      const linkStat = await fs.lstat(candidate);
      if (linkStat.isSymbolicLink()) throw new Error("Resource cannot be a symbolic link.");
      const realPath = await fs.realpath(candidate);
      const stat = await fs.stat(realPath);
      if (!isWithin(realRoot, realPath) || !stat.isFile()) throw new Error("Resource is not a regular in-root file.");
      JSON.parse(await fs.readFile(realPath, "utf8"));
      resources[name] = realPath;
    } catch (error) {
      throw new ToolError("INVALID_PLUGIN_RESOURCE", `Plugin resource '${name}' is not a readable JSON file.`, {
        pluginId: manifest.id,
        resource: name,
        path: candidate,
      }, { cause: error });
    }
  }
  if (manifest.entry) {
    const candidate = path.resolve(realRoot, manifest.entry);
    try {
      const linkStat = await fs.lstat(candidate);
      if (linkStat.isSymbolicLink()) throw new Error("Entry cannot be a symbolic link.");
      const realPath = await fs.realpath(candidate);
      const stat = await fs.stat(realPath);
      if (!isWithin(realRoot, realPath) || !stat.isFile()) throw new Error("Entry is not a regular in-root file.");
      resources.entryPath = realPath;
    } catch (error) {
      throw new ToolError("INVALID_PLUGIN_RESOURCE", "Plugin entry could not be resolved safely.", {
        pluginId: manifest.id,
        resource: "entry",
      }, { cause: error });
    }
  }
  if (manifest.catalog) {
    const candidate = path.resolve(realRoot, manifest.catalog.root);
    try {
      const linkStat = await fs.lstat(candidate);
      if (linkStat.isSymbolicLink()) throw new Error("Catalog cannot be a symbolic link.");
      const realPath = await fs.realpath(candidate);
      const stat = await fs.stat(realPath);
      if (!isWithin(realRoot, realPath) || !stat.isDirectory()) throw new Error("Catalog is not an in-root directory.");
      resources.catalogRoot = realPath;
    } catch (error) {
      throw new ToolError("INVALID_PLUGIN_RESOURCE", "Plugin catalog could not be resolved safely.", {
        pluginId: manifest.id,
        resource: "catalog",
      }, { cause: error });
    }
  }
  return deepFreeze(cloneJson(resources));
}
