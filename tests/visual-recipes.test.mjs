import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { loadTheme } from "../src/core/theme-loader.mjs";
import { VISUAL_DEFAULTS } from "../src/core/theme-model.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const RECIPE_BY_TEMPLATE = Object.freeze({
  "neon-portal": "midnight-neon",
  "ember-glass": "ember-vignette",
  "paper-aurora": "paper-wash",
  "sunlit-spark": "sunlit-immersive",
  "violet-rift": "violet-rift",
  "spark-atelier": "spark-collage",
});

function ruleBodiesFor(css, selectorToken) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].includes(selectorToken))
    .map((match) => match[2])
    .join("\n");
}

test("component registry exposes complete visual slots and runtime-owned selectors", async () => {
  const registry = JSON.parse(await fs.readFile(path.join(ROOT, "registry", "components.v1.json"), "utf8"));
  const runtimeMapping = JSON.parse(await fs.readFile(path.join(ROOT, "registry", "theme-runtime.v1.json"), "utf8"));
  const ids = new Set(registry.components.map((component) => component.id));

  assert.equal(registry.registryVersion, "1.1.0");
  assert.equal(registry.components.length, 20);
  for (const expected of [
    "mode.switcher", "action.primary", "home.sceneTab", "home.scenePanel",
    "home.sceneCard", "input.field", "selection.control", "status.badge", "toast.surface",
  ]) assert.equal(ids.has(expected), true, `missing semantic component: ${expected}`);

  for (const component of registry.components) {
    assert.ok(component.selectors.length > 0, `${component.id} has no runtime selector`);
    assert.ok(component.visualSlots.length > 0, `${component.id} has no visual slot`);
  }
  assert.deepEqual(
    Object.keys(runtimeMapping.visualAttributes).sort(),
    Object.keys(VISUAL_DEFAULTS).sort(),
  );
});

test("bundled themes select distinct validated visual recipes covered by runtime CSS", async () => {
  const themesRoot = path.join(ROOT, "themes");
  const entries = (await fs.readdir(themesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const css = await fs.readFile(path.join(ROOT, "assets", "trae-skin.css"), "utf8");
  const runtimeMapping = JSON.parse(await fs.readFile(path.join(ROOT, "registry", "theme-runtime.v1.json"), "utf8"));
  const profiles = new Set();

  for (const id of entries) {
    const { theme } = await loadTheme(path.join(themesRoot, id));
    const profile = Object.values(theme.visual).join("|");
    assert.equal(profiles.has(profile), false, `${id} duplicates another visual recipe`);
    profiles.add(profile);
    for (const [key, value] of Object.entries(theme.visual)) {
      const attribute = runtimeMapping.visualAttributes[key];
      assert.ok(attribute, `missing runtime attribute for visual.${key}`);
      assert.ok(css.includes(`[${attribute}="${value}"]`), `runtime CSS does not implement ${key}=${value}`);
    }
  }
  assert.equal(profiles.size, entries.length);
});

test("runtime recipes follow treatment identity so copied template ids keep their full skin", async () => {
  const runtimeCss = await fs.readFile(path.join(ROOT, "assets", "trae-skin.css"), "utf8");
  const pluginCss = await fs.readFile(path.join(ROOT, "plugins", "trae", "assets", "trae-skin.css"), "utf8");
  assert.equal(pluginCss, runtimeCss, "source and packaged runtime CSS must remain byte-identical");

  const implementedTreatments = new Set(
    [...runtimeCss.matchAll(/data-trae-skin-treatment="([^"]+)"/g)].map((match) => match[1]),
  );
  for (const [templateId, treatment] of Object.entries(RECIPE_BY_TEMPLATE)) {
    const { theme } = await loadTheme(path.join(ROOT, "themes", templateId));
    const copiedTheme = { ...theme, id: `local-copy-${templateId}` };
    assert.equal(copiedTheme.appearance.treatment, treatment);
    assert.equal(implementedTreatments.has(copiedTheme.appearance.treatment), true);
    assert.equal(
      runtimeCss.includes(`[data-trae-skin-theme="${templateId}"]`),
      false,
      `${templateId} still couples its recipe to the catalog id`,
    );
  }
  assert.equal(runtimeCss.includes("data-trae-skin-theme="), false);
});

test("Trae keeps the theme artwork visible behind transparent reading surfaces", async () => {
  const [runtimeCss, pluginCss, runtimeMapping, pluginMapping] = await Promise.all([
    fs.readFile(path.join(ROOT, "assets", "trae-skin.css"), "utf8"),
    fs.readFile(path.join(ROOT, "plugins", "trae", "assets", "trae-skin.css"), "utf8"),
    fs.readFile(path.join(ROOT, "registry", "theme-runtime.v1.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(ROOT, "plugins", "trae", "resources", "theme-runtime.v1.json"), "utf8").then(JSON.parse),
  ]);

  assert.equal(pluginCss, runtimeCss, "source and packaged runtime CSS must remain byte-identical");
  assert.equal(runtimeMapping.appearance.backgroundOverlay.variable, "--trae-skin-overlay-tint");
  assert.equal(pluginMapping.appearance.backgroundOverlay.variable, "--trae-skin-overlay-tint");

  const sessionCss = ruleBodiesFor(runtimeCss, ".session-panel");
  assert.match(sessionCss, /background:\s*transparent\s*!important/);
  assert.match(sessionCss, /box-shadow:\s*none\s*!important/);
  assert.match(sessionCss, /backdrop-filter:\s*none\s*!important/);

  const sparkWorkCss = ruleBodiesFor(
    runtimeCss,
    '[data-trae-skin-treatment="spark-collage"][data-trae-skin-mode="work"]',
  );
  assert.doesNotMatch(sparkWorkCss, /--trae-skin-art-opacity\s*:/);

  const nestedComposerCss = ruleBodiesFor(runtimeCss, ".chat-input-v2-container");
  assert.match(nestedComposerCss, /background:\s*transparent\s*!important/);
  assert.match(nestedComposerCss, /border:\s*0\s*!important/);
  assert.match(nestedComposerCss, /box-shadow:\s*none\s*!important/);
  assert.doesNotMatch(nestedComposerCss, /background:\s*color-mix/);

  const composerSurfaceCss = ruleBodiesFor(runtimeCss, '[data-trae-skin-surface="composer"]');
  assert.match(composerSurfaceCss, /background:\s*color-mix\([^;]*--trae-skin-composer-mix/);

  const userTurnCss = ruleBodiesFor(runtimeCss, ".turn__user-message");
  assert.match(userTurnCss, /background:\s*transparent\s*!important/);
  assert.match(userTurnCss, /box-shadow:\s*none\s*!important/);
});

test("distinct treatment recipes derive editable component colors from semantic variables", async () => {
  const css = await fs.readFile(path.join(ROOT, "assets", "trae-skin.css"), "utf8");
  const requiredVariables = {
    "sunlit-immersive": ["accent", "accent-alt", "panel", "text", "line", "on-accent", "terminal"],
    "violet-rift": ["accent", "accent-alt", "panel", "text", "on-accent", "terminal"],
    "spark-collage": ["accent", "accent-alt", "secondary", "highlight", "panel", "text", "on-accent", "terminal"],
  };

  for (const [treatment, variables] of Object.entries(requiredVariables)) {
    const recipeCss = ruleBodiesFor(css, `[data-trae-skin-treatment="${treatment}"]`);
    assert.ok(recipeCss.length > 0, `missing treatment recipe: ${treatment}`);
    for (const variable of variables) {
      assert.ok(
        recipeCss.includes(`var(--trae-skin-${variable})`),
        `${treatment} does not derive component styling from colors.${variable}`,
      );
    }
  }

  const collageLayoutCss = ruleBodiesFor(css, "[data-trae-skin-layout=\"studio-collage\"]");
  assert.match(collageLayoutCss, /display:\s*flex/);
  assert.match(collageLayoutCss, /var\(--trae-skin-(?:panel|text|accent)\)/);
});
