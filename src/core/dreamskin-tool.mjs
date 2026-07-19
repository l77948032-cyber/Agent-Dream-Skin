import { DREAMSKIN_THEME_TOOL_NAME, THEME_TOOL_ACTIONS } from "./plugin-api.mjs";
import { ToolError } from "./errors.mjs";

const ACTIONS = new Set(THEME_TOOL_ACTIONS);
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const ACTION_KEYS = Object.freeze({
  inspect: new Set(["action", "pluginId"]),
  list: new Set(["action", "pluginId"]),
  read: new Set(["action", "pluginId", "themeId"]),
  create: new Set(["action", "pluginId", "themeId", "themePatch", "sourceId", "dryRun"]),
  update: new Set(["action", "pluginId", "themeId", "themePatch", "expectedRevision", "dryRun"]),
  validate: new Set(["action", "pluginId", "themeId", "theme"]),
});

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("INVALID_TOOL_INPUT", `${label} must be an object.`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolError("INVALID_TOOL_INPUT", `${label} must be a non-empty string.`);
  }
  return value;
}

function normalizeInput(rawInput, defaultPluginId) {
  const input = plainObject(rawInput, "DreamSkin Tool input");
  const action = requiredString(input.action, "action");
  if (!ACTIONS.has(action)) {
    throw new ToolError("TOOL_ACTION_NOT_SUPPORTED", `DreamSkin Tool action '${action}' is not supported.`, { action });
  }
  const unknown = Object.keys(input).filter((key) => !ACTION_KEYS[action].has(key));
  if (unknown.length) {
    throw new ToolError("INVALID_TOOL_INPUT", `Action '${action}' contains unknown fields: ${unknown.join(", ")}.`, {
      action,
      unknown,
    });
  }
  const pluginId = input.pluginId ?? defaultPluginId;
  requiredString(pluginId, "pluginId");
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    throw new ToolError("INVALID_TOOL_INPUT", "pluginId has an invalid format.");
  }

  const normalized = { action, pluginId };
  if (["read", "create", "update"].includes(action)) {
    normalized.themeId = requiredString(input.themeId, "themeId");
  }
  if (action === "create" || action === "update") {
    normalized.themePatch = structuredClone(plainObject(input.themePatch, "themePatch"));
    if (input.dryRun !== undefined && typeof input.dryRun !== "boolean") {
      throw new ToolError("INVALID_TOOL_INPUT", "dryRun must be a boolean.");
    }
    if (input.dryRun !== undefined) normalized.dryRun = input.dryRun;
  }
  if (action === "create" && input.sourceId !== undefined) {
    normalized.sourceId = requiredString(input.sourceId, "sourceId");
  }
  if (action === "update") {
    normalized.expectedRevision = requiredString(input.expectedRevision, "expectedRevision");
  }
  if (action === "validate") {
    const hasId = input.themeId !== undefined;
    const hasTheme = input.theme !== undefined;
    if (hasId === hasTheme) {
      throw new ToolError("INVALID_TOOL_INPUT", "validate requires exactly one of themeId or theme.");
    }
    if (hasId) normalized.themeId = requiredString(input.themeId, "themeId");
    else normalized.theme = structuredClone(plainObject(input.theme, "theme"));
  }
  return normalized;
}

function pluginInput(input) {
  const { action: _action, pluginId: _pluginId, themeId, ...fields } = input;
  return {
    ...fields,
    ...(themeId === undefined ? {} : { id: themeId }),
  };
}

export class DreamSkinToolCore {
  constructor({ pluginManager, defaultPluginId = "dreamskin.trae" } = {}) {
    if (!pluginManager || typeof pluginManager.runThemeAction !== "function") {
      throw new ToolError("INVALID_TOOL_DEPENDENCY", "DreamSkin Tool requires a PluginManager.");
    }
    this.pluginManager = pluginManager;
    this.defaultPluginId = defaultPluginId;
  }

  descriptor() {
    return {
      id: DREAMSKIN_THEME_TOOL_NAME,
      actions: [...THEME_TOOL_ACTIONS],
      defaultPluginId: this.defaultPluginId,
    };
  }

  execute(rawInput) {
    const input = normalizeInput(rawInput, this.defaultPluginId);
    return this.pluginManager.runThemeAction(input.pluginId, input.action, pluginInput(input));
  }

  inspect(pluginId = this.defaultPluginId) {
    return this.execute({ action: "inspect", pluginId });
  }

  listThemes(pluginId = this.defaultPluginId) {
    return this.execute({ action: "list", pluginId });
  }

  readTheme(themeId, pluginId = this.defaultPluginId) {
    return this.execute({ action: "read", pluginId, themeId });
  }

  createTheme(input, pluginId = this.defaultPluginId) {
    return this.execute({ action: "create", pluginId, ...input });
  }

  updateTheme(input, pluginId = this.defaultPluginId) {
    return this.execute({ action: "update", pluginId, ...input });
  }

  validateTheme(input, pluginId = this.defaultPluginId) {
    return this.execute({ action: "validate", pluginId, ...input });
  }
}
