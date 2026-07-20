import { ToolError } from "../src/core/errors.mjs";

const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function assertRecord(value, label = "input") {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolError("INVALID_ARGUMENT", `${label} must be an object.`);
  }
  return value;
}

function assertId(value, label, pattern = THEME_ID_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ToolError("INVALID_ARGUMENT", `${label} is invalid.`);
  }
  return value;
}

function inputId(input, label = "themeId") {
  return assertId(assertRecord(input)[label], label);
}

function inputPluginId(input) {
  const value = assertRecord(input).pluginId;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 128 || !PLUGIN_ID_PATTERN.test(value)) {
    throw new ToolError("INVALID_ARGUMENT", "pluginId is invalid.");
  }
  return value;
}

function withoutPluginId(input) {
  const { pluginId: _pluginId, ...rest } = input;
  return rest;
}

export const DESKTOP_STUDIO_OPERATIONS = Object.freeze([
  "bootstrap",
  "catalog.list",
  "themes.list",
  "themes.create",
  "themes.duplicate",
  "themes.delete",
  "themes.read",
  "themes.update",
  "themes.apply",
  "themes.validate",
  "themes.preview",
  "settings.read",
  "settings.update",
  "cli.status",
  "cli.install",
  "cli.uninstall",
  "runtime.verify",
  "runtime.restore",
]);

const OPERATION_SET = new Set(DESKTOP_STUDIO_OPERATIONS);

export class DesktopStudioApiRouter {
  constructor({ backend }) {
    if (!backend) throw new ToolError("INVALID_BACKEND", "Desktop Studio routing requires an initialized backend.");
    this.backend = backend;
  }

  async invoke(operation, rawInput = {}) {
    if (!OPERATION_SET.has(operation)) {
      throw new ToolError("INVALID_OPERATION", `Unsupported desktop operation: ${String(operation)}`);
    }
    const input = assertRecord(rawInput);
    const pluginId = inputPluginId(input);

    if (operation === "bootstrap") return this.backend.bootstrap();
    if (operation === "catalog.list") return this.backend.catalog(pluginId);
    if (operation === "themes.list") return this.backend.themes(pluginId);
    if (operation === "themes.create") return this.backend.createTheme(withoutPluginId(input), pluginId);
    if (operation === "settings.read") return this.backend.settings();
    if (operation === "settings.update") return this.backend.updateSettings(input);
    if (operation === "cli.status") return this.backend.cliStatus();
    if (operation === "cli.install") return this.backend.installCli();
    if (operation === "cli.uninstall") return this.backend.uninstallCli();
    if (operation === "runtime.verify") return this.backend.verify(withoutPluginId(input), pluginId);
    if (operation === "runtime.restore") return this.backend.restore(pluginId);

    const themeId = inputId(input);
    if (operation === "themes.read") return this.backend.theme(themeId, pluginId);
    if (operation === "themes.duplicate") return this.backend.duplicateTheme(themeId, pluginId);
    if (operation === "themes.delete") {
      return this.backend.deleteTheme(themeId, assertRecord(input.input, "input.input"), pluginId);
    }
    if (operation === "themes.update") return this.backend.updateTheme(themeId, assertRecord(input.input, "input.input"), pluginId);
    if (operation === "themes.apply") return this.backend.applyTheme(themeId, pluginId);
    if (operation === "themes.validate") return this.backend.validateTheme(themeId, pluginId);
    if (operation === "themes.preview") return this.backend.previewTheme(themeId, assertRecord(input.input, "input.input"), pluginId);
    throw new ToolError("INVALID_OPERATION", `Unsupported desktop operation: ${operation}`);
  }

  asset(kind, id, pluginId) {
    if (kind !== "catalog" && kind !== "theme") {
      throw new ToolError("INVALID_ARGUMENT", "Asset kind must be 'catalog' or 'theme'.");
    }
    const scope = inputPluginId({ pluginId });
    return this.backend.asset(kind, assertId(id, `${kind}Id`), scope);
  }
}
