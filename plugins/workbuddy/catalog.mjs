import { ToolError } from "../../src/core/errors.mjs";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

export const WORKBUDDY_CATALOG_METADATA = deepFreeze({
  "harbor-focus": {
    author: "DreamSkin Official",
    categories: ["精选", "美景", "极简"],
    featured: true,
    downloads: "New",
    version: "1.0",
  },
  "orchid-night": {
    author: "DreamSkin Official",
    categories: ["精选", "科技", "美景"],
    featured: true,
    downloads: "New",
    version: "1.0",
  },
  "paper-garden": {
    author: "DreamSkin Labs",
    categories: ["精选", "极简", "国风"],
    downloads: "New",
    version: "1.0",
  },
});

export const WORKBUDDY_BLANK_SOURCE_ID = "harbor-focus";
export const WORKBUDDY_BLANK_ID_PREFIX = "workbuddy-blank";

export function createWorkBuddyBlankTheme(input = {}) {
  const { sourceTheme, id } = input;
  if (!sourceTheme || typeof sourceTheme !== "object" || Array.isArray(sourceTheme)) {
    throw new ToolError("INVALID_PLUGIN_DEPENDENCY", "WorkBuddy blank theme generation requires a source theme.");
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new ToolError("INVALID_TOOL_INPUT", "WorkBuddy blank theme generation requires a theme id.");
  }

  return {
    ...clone(sourceTheme),
    id,
    name: "未命名 WorkBuddy 主题",
    description: "从安静的空白画布开始，通过与 Agent 对话逐步生成主题。",
    brandSubtitle: "WORKBUDDY DREAM SKIN",
    tagline: "Describe how your workspace should feel.",
    statusText: "DRAFT THEME",
    quote: "MAKE THE WORKSPACE YOURS",
    layout: "classic",
    colors: {
      background: "#EDF1F4",
      panel: "#F9FAFB",
      panelAlt: "#E6EBEF",
      accent: "#536C7A",
      accentAlt: "#6D8795",
      secondary: "#537F78",
      highlight: "#FFFFFF",
      onAccent: "#FFFFFF",
      success: "#3D8C68",
      warning: "#A97530",
      danger: "#BD5358",
      info: "#4F7FA0",
      disabled: "#A7B0B7",
      text: "#20272D",
      muted: "#66727B",
      line: "rgba(32, 39, 45, 0.14)",
      selection: "rgba(83, 108, 122, 0.15)",
      terminal: "#1C242A"
    },
    states: {
      surfaceHover: "rgba(32, 39, 45, 0.06)",
      surfaceActive: "rgba(83, 108, 122, 0.12)",
      focus: "#536C7A",
      tooltipBackground: "rgba(28, 36, 42, 0.96)",
      tooltipText: "#FFFFFF"
    },
    visual: {
      motif: "editorial",
      iconTreatment: "outline",
      surfaceTreatment: "quiet",
      accentPlacement: "rail",
      cardTreatment: "quiet",
      ornament: "none"
    },
    appearance: {
      ...clone(sourceTheme.appearance),
      treatment: "neutral",
      backgroundOverlay: "rgba(237, 241, 244, 0)",
      backgroundOpacity: 0,
      surfaceOpacity: 0.96,
      sidebarOpacity: 0.96,
      blur: 8,
      saturation: 1,
      radius: 7,
      shadow: "soft",
      colorScheme: "light"
    }
  };
}

function hasTemplate(id) {
  return typeof id === "string" && Object.hasOwn(WORKBUDDY_CATALOG_METADATA, id);
}

function inferTemplateSource(id) {
  if (typeof id !== "string") return undefined;
  return Object.keys(WORKBUDDY_CATALOG_METADATA).find((sourceId) => {
    const prefix = `${sourceId}-`;
    return id.startsWith(prefix) && /^[a-f0-9]{8}$/.test(id.slice(prefix.length));
  });
}

export const WORKBUDDY_CATALOG = Object.freeze({
  targetId: "workbuddy",
  targetName: "WorkBuddy",
  templates: WORKBUDDY_CATALOG_METADATA,
  blank: Object.freeze({
    sourceId: WORKBUDDY_BLANK_SOURCE_ID,
    idPrefix: WORKBUDDY_BLANK_ID_PREFIX,
  }),
  hasTemplate,
  inferTemplateSource,
  createBlankTheme: createWorkBuddyBlankTheme,
});
