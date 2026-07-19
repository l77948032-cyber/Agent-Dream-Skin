import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TRAE_BLANK_ID_PREFIX,
  TRAE_BLANK_SOURCE_ID,
  TRAE_CATALOG,
  TRAE_CATALOG_METADATA,
  createTraeBlankTheme,
} from "../plugins/trae/catalog.mjs";
import { createTraePlugin } from "../plugins/trae/plugin.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Trae owns the existing Studio catalog metadata and template identity rules", () => {
  assert.deepEqual(Object.keys(TRAE_CATALOG_METADATA), [
    "sunlit-spark",
    "violet-rift",
    "neon-portal",
    "ember-glass",
    "paper-aurora",
    "spark-atelier",
  ]);
  assert.deepEqual(TRAE_CATALOG_METADATA["sunlit-spark"], {
    author: "DreamSkin Official",
    categories: ["精选", "明星", "动漫"],
    featured: true,
    downloads: "12.8k",
    version: "1.4",
  });
  assert.deepEqual(TRAE_CATALOG_METADATA["spark-atelier"], {
    author: "DreamSkin Labs",
    categories: ["动漫", "明星"],
    downloads: "3.9k",
    version: "0.9 beta",
    experimental: true,
  });
  assert.equal(TRAE_CATALOG.targetId, "trae");
  assert.equal(TRAE_CATALOG.targetName, "Trae");
  assert.equal(TRAE_CATALOG.hasTemplate("paper-aurora"), true);
  assert.equal(TRAE_CATALOG.hasTemplate("unknown"), false);
  assert.equal(TRAE_CATALOG.inferTemplateSource("sunlit-spark-0a1b2c3d"), "sunlit-spark");
  assert.equal(TRAE_CATALOG.inferTemplateSource("sunlit-spark-0A1B2C3D"), undefined);
  assert.equal(TRAE_CATALOG.inferTemplateSource("sunlit-spark-too-long"), undefined);
  assert.equal(Object.isFrozen(TRAE_CATALOG_METADATA["sunlit-spark"].categories), true);
});

test("Trae blank recipe preserves the current valid empty-theme result", async () => {
  const sourceTheme = JSON.parse(await fs.readFile(
    path.join(ROOT, "themes", TRAE_BLANK_SOURCE_ID, "theme.json"),
    "utf8",
  ));
  const sourceBefore = structuredClone(sourceTheme);
  const theme = createTraeBlankTheme({ sourceTheme, id: "blank-0a1b2c3d" });

  assert.deepEqual(sourceTheme, sourceBefore);
  assert.equal(TRAE_BLANK_SOURCE_ID, "paper-aurora");
  assert.equal(TRAE_BLANK_ID_PREFIX, "blank");
  assert.equal(theme.schemaVersion, sourceTheme.schemaVersion);
  assert.equal(theme.image, sourceTheme.image);
  assert.equal(theme.id, "blank-0a1b2c3d");
  assert.equal(theme.name, "未命名主题");
  assert.equal(theme.description, "通过与 Agent 对话，从空白开始生成。");
  assert.equal(theme.brandSubtitle, "YOUR DREAM SKIN");
  assert.equal(theme.tagline, "Describe a feeling. Build a theme.");
  assert.equal(theme.statusText, "DRAFT THEME");
  assert.equal(theme.quote, "START WITH A BLANK CANVAS");
  assert.equal(theme.layout, "classic");
  assert.deepEqual(theme.colors, {
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
  });
  assert.deepEqual(theme.states, {
    surfaceHover: "rgba(31, 41, 51, 0.06)",
    surfaceActive: "rgba(31, 41, 51, 0.1)",
    focus: "#66717d",
    tooltipBackground: "rgba(27, 33, 40, 0.96)",
    tooltipText: "#ffffff",
  });
  assert.deepEqual(theme.visual, {
    motif: "editorial",
    iconTreatment: "outline",
    surfaceTreatment: "quiet",
    accentPlacement: "rail",
    cardTreatment: "quiet",
    ornament: "none",
  });
  assert.deepEqual(theme.appearance, {
    ...sourceTheme.appearance,
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
  });
  assert.notEqual(theme.appearance, sourceTheme.appearance);
});

test("Trae plugin exposes catalog behavior as a host-facing plugin capability", async () => {
  const plugin = await createTraePlugin({ service: {} });

  assert.equal(plugin.catalog, TRAE_CATALOG);
  assert.equal(plugin.catalog.blank.sourceId, "paper-aurora");
  assert.equal(plugin.catalog.blank.idPrefix, "blank");
  assert.equal(plugin.catalog.createBlankTheme, createTraeBlankTheme);
  assert.equal(Object.isFrozen(plugin.catalog), true);
});

test("Trae blank recipe rejects incomplete host inputs", () => {
  assert.throws(
    () => createTraeBlankTheme(),
    (error) => error.code === "INVALID_PLUGIN_DEPENDENCY",
  );
  assert.throws(
    () => createTraeBlankTheme({ sourceTheme: null, id: "blank-0a1b2c3d" }),
    (error) => error.code === "INVALID_PLUGIN_DEPENDENCY",
  );
  assert.throws(
    () => createTraeBlankTheme({ sourceTheme: {}, id: "" }),
    (error) => error.code === "INVALID_TOOL_INPUT",
  );
});
