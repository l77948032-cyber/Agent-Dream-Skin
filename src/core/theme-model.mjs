import path from "node:path";

export const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const MAX_ART_BYTES = 16 * 1024 * 1024;
export const MAX_CSS_BYTES = 1024 * 1024;
export const MAX_CONFIG_BYTES = 64 * 1024;

export const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

export const COLOR_DEFAULTS = Object.freeze({
  background: "#0b1020",
  panel: "rgba(17, 24, 39, 0.88)",
  panelAlt: "rgba(25, 34, 49, 0.82)",
  accent: "#6ee7b7",
  accentAlt: "#a7f3d0",
  secondary: "#67e8f9",
  highlight: "#c084fc",
  onAccent: "#071216",
  success: "#51c9b6",
  warning: "#f2c566",
  danger: "#ee7d8e",
  info: "#67e8f9",
  disabled: "#718096",
  text: "#f8fafc",
  muted: "#a8b3c7",
  line: "rgba(255, 255, 255, 0.16)",
  selection: "rgba(103, 232, 249, 0.26)",
  terminal: "#080d16",
});

export const STATE_DEFAULTS = Object.freeze({
  surfaceHover: "rgba(167, 243, 208, 0.11)",
  surfaceActive: "rgba(110, 231, 183, 0.18)",
  focus: "#a7f3d0",
  tooltipBackground: "rgba(25, 34, 49, 0.96)",
  tooltipText: "#f8fafc",
});

export const VISUAL_DEFAULTS = Object.freeze({
  motif: "circuit",
  iconTreatment: "outline",
  surfaceTreatment: "quiet",
  accentPlacement: "rail",
  cardTreatment: "quiet",
  ornament: "none",
});

const VISUAL_OPTIONS = Object.freeze({
  motif: new Set(["circuit", "forge", "editorial", "collage", "sketch", "prism"]),
  iconTreatment: new Set(["outline", "tile", "medallion", "stamp"]),
  surfaceTreatment: new Set(["quiet", "glass", "paper", "layered"]),
  accentPlacement: new Set(["rail", "corner", "underline", "glow"]),
  cardTreatment: new Set(["quiet", "badge", "split", "poster"]),
  ornament: new Set(["none", "nodes", "sparks", "rules", "tape", "strokes", "facets"]),
});

export const APPEARANCE_DEFAULTS = Object.freeze({
  treatment: "midnight-neon",
  backgroundPosition: "center center",
  backgroundSize: "cover",
  backgroundOverlay: "rgba(4, 8, 18, 0.28)",
  backgroundBlendMode: "normal",
  backgroundOpacity: 1,
  surfaceOpacity: 0.88,
  sidebarOpacity: 0.84,
  blur: 16,
  saturation: 1,
  radius: 8,
  shadow: "soft",
  colorScheme: "dark",
});

export const THEME_VARIABLES = Object.freeze([
  "--trae-skin-art",
  "--trae-skin-bg",
  "--trae-skin-panel",
  "--trae-skin-panel-alt",
  "--trae-skin-accent",
  "--trae-skin-accent-alt",
  "--trae-skin-secondary",
  "--trae-skin-highlight",
  "--trae-skin-on-accent",
  "--trae-skin-success",
  "--trae-skin-warning",
  "--trae-skin-danger",
  "--trae-skin-info",
  "--trae-skin-disabled",
  "--trae-skin-text",
  "--trae-skin-muted",
  "--trae-skin-line",
  "--trae-skin-selection",
  "--trae-skin-terminal",
  "--trae-skin-focus",
  "--trae-skin-surface-hover",
  "--trae-skin-surface-active",
  "--trae-skin-tooltip-bg",
  "--trae-skin-tooltip-text",
  "--trae-skin-color-scheme",
  "--trae-skin-art-position",
  "--trae-skin-art-size",
  "--trae-skin-art-opacity",
  "--trae-skin-art-blend",
  "--trae-skin-overlay",
  "--trae-skin-surface-mix",
  "--trae-skin-sidebar-mix",
  "--trae-skin-blur",
  "--trae-skin-saturation",
  "--trae-skin-radius",
  "--trae-skin-shadow",
]);

export function validColor(value, fallback) {
  if (typeof value !== "string") return fallback;
  const color = value.trim();
  const hex = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  const functional = /^(?:rgb|rgba|hsl|hsla)\([0-9a-z.,%/ +\-]+\)$/i;
  return color === "transparent" || hex.test(color) || functional.test(color) ? color : fallback;
}

function rangedNumber(value, fallback, minimum, maximum, allowPx = false) {
  let candidate = value;
  if (allowPx && typeof candidate === "string" && /^\d+(?:\.\d+)?px$/.test(candidate.trim())) {
    candidate = candidate.trim().slice(0, -2);
  }
  if (typeof candidate === "string" && /^\d+(?:\.\d+)?$/.test(candidate.trim())) {
    candidate = Number(candidate);
  }
  return Number.isFinite(candidate) && candidate >= minimum && candidate <= maximum
    ? Number(candidate)
    : fallback;
}

function safePosition(value, fallback) {
  if (typeof value !== "string") return fallback;
  const tokens = value.trim().split(/\s+/);
  const tokenPattern = /^(?:left|right|top|bottom|center|-?\d+(?:\.\d+)?(?:%|px))$/;
  return tokens.length >= 1 && tokens.length <= 2 && tokens.every((token) => tokenPattern.test(token))
    ? tokens.join(" ")
    : fallback;
}

function safeBackgroundSize(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (["cover", "contain", "auto"].includes(normalized)) return normalized;
  const tokens = normalized.split(/\s+/);
  const tokenPattern = /^(?:auto|\d+(?:\.\d+)?(?:%|px))$/;
  return tokens.length >= 1 && tokens.length <= 2 && tokens.every((token) => tokenPattern.test(token))
    ? tokens.join(" ")
    : fallback;
}

function safeShadow(value, fallback) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) return fallback;
  if (/[;{}]|(?:url|var|expression)\s*\(/i.test(normalized)) return fallback;
  return new Set(["soft", "deep", "none"]).has(normalized) ? normalized : fallback;
}

export function normalizeTheme(raw, source = "theme.json") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schemaVersion !== 1) {
    throw new Error(`${source} has an unsupported schemaVersion`);
  }
  if (typeof raw.id !== "string" || !THEME_ID_PATTERN.test(raw.id)) {
    throw new Error(`${source} has an invalid theme id`);
  }
  if (typeof raw.image !== "string" || path.basename(raw.image) !== raw.image || !raw.image) {
    throw new Error(`${source} image must be a file name inside the theme directory`);
  }
  const text = (value, fallback, maximum) => typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximum)
    : fallback;
  const colors = {};
  for (const [name, fallback] of Object.entries(COLOR_DEFAULTS)) {
    colors[name] = validColor(raw.colors?.[name], fallback);
  }
  const states = {};
  for (const [name, fallback] of Object.entries(STATE_DEFAULTS)) {
    states[name] = validColor(raw.states?.[name], fallback);
  }
  const visual = {};
  for (const [name, fallback] of Object.entries(VISUAL_DEFAULTS)) {
    const requested = typeof raw.visual?.[name] === "string" ? raw.visual[name].trim() : "";
    visual[name] = VISUAL_OPTIONS[name].has(requested) ? requested : fallback;
  }
  const blends = new Set([
    "normal", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge",
    "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue",
    "saturation", "color", "luminosity",
  ]);
  const colorSchemes = new Set(["dark", "light", "system"]);
  const treatments = new Set([
    "midnight-neon", "ember-vignette", "paper-wash", "spark-collage",
    "sunlit-immersive", "violet-rift", "neutral",
  ]);
  const layouts = new Set(["classic", "studio-collage"]);
  const requestedBlend = typeof raw.appearance?.backgroundBlendMode === "string"
    ? raw.appearance.backgroundBlendMode.trim()
    : "";
  const requestedScheme = typeof raw.appearance?.colorScheme === "string"
    ? raw.appearance.colorScheme.trim()
    : "";
  const requestedTreatment = typeof raw.appearance?.treatment === "string"
    ? raw.appearance.treatment.trim()
    : "";
  const requestedLayout = typeof raw.layout === "string" ? raw.layout.trim() : "";
  const appearance = {
    treatment: treatments.has(requestedTreatment) ? requestedTreatment : APPEARANCE_DEFAULTS.treatment,
    backgroundPosition: safePosition(raw.appearance?.backgroundPosition, APPEARANCE_DEFAULTS.backgroundPosition),
    backgroundSize: safeBackgroundSize(raw.appearance?.backgroundSize, APPEARANCE_DEFAULTS.backgroundSize),
    backgroundOverlay: validColor(raw.appearance?.backgroundOverlay, APPEARANCE_DEFAULTS.backgroundOverlay),
    backgroundBlendMode: blends.has(requestedBlend) ? requestedBlend : APPEARANCE_DEFAULTS.backgroundBlendMode,
    backgroundOpacity: rangedNumber(raw.appearance?.backgroundOpacity, APPEARANCE_DEFAULTS.backgroundOpacity, 0, 1),
    surfaceOpacity: rangedNumber(raw.appearance?.surfaceOpacity, APPEARANCE_DEFAULTS.surfaceOpacity, 0, 1),
    sidebarOpacity: rangedNumber(raw.appearance?.sidebarOpacity, APPEARANCE_DEFAULTS.sidebarOpacity, 0, 1),
    blur: rangedNumber(raw.appearance?.blur, APPEARANCE_DEFAULTS.blur, 0, 48, true),
    saturation: rangedNumber(raw.appearance?.saturation, APPEARANCE_DEFAULTS.saturation, 0, 3),
    radius: rangedNumber(raw.appearance?.radius, APPEARANCE_DEFAULTS.radius, 0, 32, true),
    shadow: safeShadow(raw.appearance?.shadow, APPEARANCE_DEFAULTS.shadow),
    colorScheme: colorSchemes.has(requestedScheme) ? requestedScheme : APPEARANCE_DEFAULTS.colorScheme,
  };
  return {
    schemaVersion: 1,
    id: raw.id,
    name: text(raw.name, raw.id, 80),
    description: text(raw.description, "", 240),
    layout: layouts.has(requestedLayout) ? requestedLayout : "classic",
    brandSubtitle: text(raw.brandSubtitle, "TRAE DREAM SKIN", 80),
    tagline: text(raw.tagline, "A calmer workspace.", 160),
    statusText: text(raw.statusText, "SKIN ACTIVE", 80),
    quote: text(raw.quote, "BUILD SOMETHING WORTH KEEPING", 160),
    image: raw.image,
    colors,
    states,
    visual,
    appearance,
  };
}

export function matchesImageSignature(buffer, extension) {
  if (extension === ".png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (extension === ".webp") {
    return buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" &&
      buffer.toString("ascii", 8, 12) === "WEBP";
  }
  return false;
}
