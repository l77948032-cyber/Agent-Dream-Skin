import { ToolError } from "../../src/core/errors.mjs";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

export const TRAE_CATALOG_METADATA = deepFreeze({
  "sunlit-spark": {
    author: "DreamSkin Official",
    categories: ["精选", "明星", "动漫"],
    featured: true,
    downloads: "12.8k",
    version: "1.4",
  },
  "violet-rift": {
    author: "Nocturne Lab",
    categories: ["精选", "游戏", "科技"],
    featured: true,
    downloads: "9.6k",
    version: "1.2",
  },
  "neon-portal": {
    author: "DreamSkin Official",
    categories: ["美景", "科技"],
    downloads: "8.1k",
    version: "1.3",
  },
  "ember-glass": {
    author: "Studio Ember",
    categories: ["美景", "极简"],
    downloads: "6.7k",
    version: "1.1",
  },
  "paper-aurora": {
    author: "Paper Plane",
    categories: ["极简", "国风"],
    downloads: "5.4k",
    version: "1.2",
  },
  "spark-atelier": {
    author: "DreamSkin Labs",
    categories: ["动漫", "明星"],
    downloads: "3.9k",
    version: "0.9 beta",
    experimental: true,
  },
  "jade-courtyard": {
    author: "Jade House",
    categories: ["精选", "国风", "美景"],
    featured: true,
    downloads: "7.4k",
    version: "1.0",
  },
  "alpine-signal": {
    author: "Northline Studio",
    categories: ["美景", "科技", "极简"],
    downloads: "6.2k",
    version: "1.0",
  },
  "cosmic-arcade": {
    author: "DreamSkin Labs",
    categories: ["精选", "游戏", "科技"],
    featured: true,
    downloads: "8.8k",
    version: "1.0",
  },
  "midnight-library": {
    author: "Nocturne Lab",
    categories: ["精选", "极简", "美景"],
    downloads: "7.9k",
    version: "1.0",
  },
});

export const TRAE_BLANK_SOURCE_ID = "paper-aurora";
export const TRAE_BLANK_ID_PREFIX = "blank";

export function createTraeBlankTheme(input = {}) {
  const { sourceTheme, id } = input;
  if (!sourceTheme || typeof sourceTheme !== "object" || Array.isArray(sourceTheme)) {
    throw new ToolError("INVALID_PLUGIN_DEPENDENCY", "Trae blank theme generation requires a source theme.");
  }
  if (typeof id !== "string" || id.length === 0) {
    throw new ToolError("INVALID_TOOL_INPUT", "Trae blank theme generation requires a theme id.");
  }

  return {
    ...clone(sourceTheme),
    id,
    name: "未命名主题",
    description: "从空白开始，让编程 Agent 通过 DreamSkin CLI 生成主题。",
    brandSubtitle: "YOUR DREAM SKIN",
    tagline: "Describe a feeling. Build a theme.",
    statusText: "DRAFT THEME",
    quote: "START WITH A BLANK CANVAS",
    layout: "classic",
    colors: {
      background: "#edf0f3",
      panel: "#f8f9fa",
      panelAlt: "#e7eaee",
      accent: "#66717d",
      accentAlt: "#7c8792",
      secondary: "#75808c",
      highlight: "#ffffff",
      onAccent: "#ffffff",
      success: "#4d9a69",
      warning: "#b78132",
      danger: "#c45454",
      info: "#4f81a8",
      disabled: "#aab1b8",
      text: "#20262d",
      muted: "#6f7882",
      line: "rgba(31, 41, 51, 0.14)",
      selection: "rgba(102, 113, 125, 0.14)",
      terminal: "#1d232a",
    },
    states: {
      surfaceHover: "rgba(31, 41, 51, 0.06)",
      surfaceActive: "rgba(31, 41, 51, 0.1)",
      focus: "#66717d",
      tooltipBackground: "rgba(27, 33, 40, 0.96)",
      tooltipText: "#ffffff",
    },
    visual: {
      motif: "editorial",
      iconTreatment: "outline",
      surfaceTreatment: "quiet",
      accentPlacement: "rail",
      cardTreatment: "quiet",
      ornament: "none",
    },
    appearance: {
      ...clone(sourceTheme.appearance),
      colorScheme: "light",
      treatment: "neutral",
      backgroundOpacity: 0,
      backgroundOverlay: "rgba(237, 240, 243, 0)",
      surfaceOpacity: 0.94,
      sidebarOpacity: 0.94,
      blur: 10,
      saturation: 1,
      radius: 7,
      shadow: "soft",
    },
  };
}

function hasTemplate(id) {
  return typeof id === "string" && Object.hasOwn(TRAE_CATALOG_METADATA, id);
}

function inferTemplateSource(id) {
  if (typeof id !== "string") return undefined;
  return Object.keys(TRAE_CATALOG_METADATA).find((sourceId) => {
    const prefix = `${sourceId}-`;
    return id.startsWith(prefix) && /^[a-f0-9]{8}$/.test(id.slice(prefix.length));
  });
}

export const TRAE_CATALOG = Object.freeze({
  targetId: "trae",
  targetName: "Trae",
  templates: TRAE_CATALOG_METADATA,
  blank: Object.freeze({
    sourceId: TRAE_BLANK_SOURCE_ID,
    idPrefix: TRAE_BLANK_ID_PREFIX,
  }),
  hasTemplate,
  inferTemplateSource,
  createBlankTheme: createTraeBlankTheme,
});
