import { ToolError } from "../src/core/errors.mjs";

const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const AGENT_ID_PATTERN = /^[a-z0-9_-]+$/;

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
  "themes.message",
  "agents.list",
  "agents.connect",
  "settings.read",
  "settings.update",
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

    if (operation === "bootstrap") return this.backend.bootstrap();
    if (operation === "catalog.list") return this.backend.catalog();
    if (operation === "themes.list") return this.backend.themes();
    if (operation === "themes.create") return this.backend.createTheme(input);
    if (operation === "agents.list") return this.backend.agents();
    if (operation === "settings.read") return this.backend.settings();
    if (operation === "settings.update") return this.backend.updateSettings(input);
    if (operation === "runtime.verify") return this.backend.verify(input);
    if (operation === "runtime.restore") return this.backend.restore();

    if (operation === "agents.connect") {
      return this.backend.connectAgent(assertId(input.agentId, "agentId", AGENT_ID_PATTERN));
    }

    const themeId = inputId(input);
    if (operation === "themes.read") return this.backend.theme(themeId);
    if (operation === "themes.duplicate") return this.backend.duplicateTheme(themeId);
    if (operation === "themes.delete") {
      return this.backend.deleteTheme(themeId, assertRecord(input.input, "input.input"));
    }
    if (operation === "themes.update") return this.backend.updateTheme(themeId, assertRecord(input.input, "input.input"));
    if (operation === "themes.apply") return this.backend.applyTheme(themeId);
    if (operation === "themes.validate") return this.backend.validateTheme(themeId);
    if (operation === "themes.preview") return this.backend.previewTheme(themeId, assertRecord(input.input, "input.input"));
    if (operation === "themes.message") return this.backend.message(themeId, assertRecord(input.input, "input.input"));

    throw new ToolError("INVALID_OPERATION", `Unsupported desktop operation: ${operation}`);
  }

  asset(kind, id) {
    if (kind !== "catalog" && kind !== "theme") {
      throw new ToolError("INVALID_ARGUMENT", "Asset kind must be 'catalog' or 'theme'.");
    }
    return this.backend.asset(kind, assertId(id, `${kind}Id`));
  }
}
