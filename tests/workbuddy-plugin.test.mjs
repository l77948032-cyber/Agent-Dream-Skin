import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  WORKBUDDY_BLANK_ID_PREFIX,
  WORKBUDDY_BLANK_SOURCE_ID,
  WORKBUDDY_CATALOG,
  WORKBUDDY_CATALOG_METADATA,
  createWorkBuddyBlankTheme,
} from "../plugins/workbuddy/catalog.mjs";
import {
  WORKBUDDY_PLUGIN_ROOT,
  createWorkBuddyPlugin,
  loadWorkBuddyPluginManifest,
} from "../plugins/workbuddy/plugin.mjs";
import { PluginManager } from "../src/core/plugin-manager.mjs";
import { ThemeRepository } from "../src/core/theme-repository.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG_ROOT = path.join(WORKBUDDY_PLUGIN_ROOT, "catalog");
const RESOURCE_ROOT = path.join(WORKBUDDY_PLUGIN_ROOT, "resources");
const TEMPLATE_IDS = ["harbor-focus", "orchid-night", "paper-garden"];
const REQUIRED_COMPONENTS = [
  "shell.workspace",
  "shell.titlebar",
  "sidebar.navigation",
  "sidebar.project",
  "home.hero",
  "home.quickAction",
  "chat.timeline",
  "chat.message.user",
  "chat.message.agent",
  "chat.toolCall",
  "composer.surface",
  "composer.tool",
  "action.primary",
  "result.shell",
  "result.tabs",
  "result.artifact",
  "result.fileTree",
  "market.toolbar",
  "market.card",
  "automation.task",
  "automation.run",
  "project.card",
  "settings.section",
  "input.field",
  "selection.control",
  "overlay.menu",
  "overlay.dialog",
  "overlay.tooltip",
  "status.badge",
  "status.toast",
  "loading.skeleton",
  "empty.state",
];

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function ruleBodiesFor(css, selectorToken) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].includes(selectorToken))
    .map((match) => match[2])
    .join("\n");
}

function topLevelSelectors(selectorText) {
  const selectors = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < selectorText.length; index += 1) {
    const character = selectorText[index];
    if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) {
      selectors.push(selectorText.slice(start, index));
      start = index + 1;
    }
  }
  selectors.push(selectorText.slice(start));
  return selectors.map((selector) => selector.replace(/\/\*[\s\S]*?\*\//g, "").trim()).filter(Boolean);
}

test("WorkBuddy manifest registers as a macOS target with complete plugin resources", async () => {
  const manifest = await loadWorkBuddyPluginManifest();
  assert.equal(manifest.id, "dreamskin.workbuddy");
  assert.equal(manifest.target.id, "workbuddy");
  assert.deepEqual(manifest.target.platforms, ["darwin"]);

  const plugin = await createWorkBuddyPlugin({ service: {} });
  const manager = new PluginManager();
  const descriptor = await manager.register(plugin, { rootPath: WORKBUDDY_PLUGIN_ROOT });
  assert.equal(descriptor.manifest.id, "dreamskin.workbuddy");
  assert.deepEqual(Object.keys(manager.resources("dreamskin.workbuddy")).sort(), [
    "catalogRoot",
    "entryPath",
    "registryPath",
    "runtimeMappingPath",
    "schemaPath",
  ]);
  assert.equal((await manager.activate("dreamskin.workbuddy")).active, true);
  assert.deepEqual(await plugin.activate(), { pluginId: "dreamskin.workbuddy", target: "workbuddy" });
});

test("WorkBuddy catalog exposes three target-owned templates and a deterministic blank recipe", async () => {
  assert.deepEqual(Object.keys(WORKBUDDY_CATALOG_METADATA), TEMPLATE_IDS);
  assert.equal(WORKBUDDY_CATALOG.targetId, "workbuddy");
  assert.equal(WORKBUDDY_CATALOG.targetName, "WorkBuddy");
  assert.equal(WORKBUDDY_BLANK_SOURCE_ID, "harbor-focus");
  assert.equal(WORKBUDDY_BLANK_ID_PREFIX, "workbuddy-blank");
  assert.equal(WORKBUDDY_CATALOG.hasTemplate("orchid-night"), true);
  assert.equal(WORKBUDDY_CATALOG.hasTemplate("paper-orbit"), false);
  assert.equal(WORKBUDDY_CATALOG.inferTemplateSource("paper-garden-0a1b2c3d"), "paper-garden");
  assert.equal(WORKBUDDY_CATALOG.inferTemplateSource("paper-garden-0A1B2C3D"), undefined);
  assert.deepEqual(WORKBUDDY_CATALOG_METADATA["harbor-focus"].categories, ["精选", "美景", "极简"]);
  assert.ok(Object.values(WORKBUDDY_CATALOG_METADATA).every(({ categories }) =>
    categories.every((category) => ["精选", "明星", "美景", "动漫", "游戏", "极简", "科技", "国风"].includes(category))));

  const source = await readJson(path.join(CATALOG_ROOT, WORKBUDDY_BLANK_SOURCE_ID, "theme.json"));
  const before = structuredClone(source);
  const blank = createWorkBuddyBlankTheme({ sourceTheme: source, id: "workbuddy-blank-0a1b2c3d" });
  assert.deepEqual(source, before);
  assert.equal(blank.id, "workbuddy-blank-0a1b2c3d");
  assert.equal(blank.name, "未命名 WorkBuddy 主题");
  assert.equal(blank.image, "background.png");
  assert.equal(blank.appearance.colorScheme, "light");
  assert.equal(blank.appearance.backgroundOpacity, 0);
  assert.equal(blank.visual.ornament, "none");
});

test("WorkBuddy component registry and Studio scenes cover every product surface", async () => {
  const [registry, scenes, mapping] = await Promise.all([
    readJson(path.join(RESOURCE_ROOT, "components.v1.json")),
    readJson(path.join(RESOURCE_ROOT, "studio-scenes.v1.json")),
    readJson(path.join(RESOURCE_ROOT, "theme-runtime.v1.json")),
  ]);
  const componentIds = registry.components.map(({ id }) => id);
  assert.deepEqual(componentIds, REQUIRED_COMPONENTS);
  assert.equal(new Set(componentIds).size, componentIds.length);
  assert.ok(registry.components.every((component) =>
    component.description && component.states.length > 0 && component.visualSlots.length > 0 && component.selectors.length > 0));

  assert.deepEqual(scenes.scenes.map(({ id }) => id), [
    "home", "assistant", "chat", "result", "market", "automation", "project", "settings", "overlays",
  ]);
  const covered = new Set(scenes.scenes.flatMap(({ componentIds: ids }) => ids));
  assert.deepEqual(componentIds.filter((id) => !covered.has(id)), []);
  assert.ok(scenes.scenes.every(({ componentIds: ids }) => ids.every((id) => componentIds.includes(id))));

  assert.equal(mapping.target, "workbuddy");
  assert.equal(mapping.selectorProfile, "5.2");
  assert.equal(mapping.colors.background, "--dreamskin-bg");
  assert.equal(mapping.states.surfaceHover, "--dreamskin-hover");
  assert.equal(mapping.appearance.surfaceOpacity.variable, "--dreamskin-surface-opacity");
  assert.equal(mapping.visualAttributes.iconTreatment, "data-workbuddy-skin-icon-treatment");
  assert.ok(mapping.nativeAliases.shell.includes("--wb-bg-primary"));
  assert.ok(mapping.nativeAliases.shell.includes("--vscode-editor-background"));
});

test("WorkBuddy catalog themes are valid ThemeRepository documents with real PNG art", async () => {
  const repository = new ThemeRepository({
    themesRoot: CATALOG_ROOT,
    projectRoot: WORKBUDDY_PLUGIN_ROOT,
  });
  const listed = await repository.list();
  assert.equal(listed.count, 3);
  assert.deepEqual(listed.themes.map(({ id }) => id).sort(), [...TEMPLATE_IDS].sort());

  for (const id of TEMPLATE_IDS) {
    const result = await repository.read(id);
    assert.equal(result.theme.id, id);
    assert.equal(result.asset.mime, "image/png");
    assert.ok(result.asset.bytes > 100_000);
    assert.ok(result.asset.bytes < 16 * 1024 * 1024);
    const image = await fs.readFile(path.join(CATALOG_ROOT, id, result.theme.image));
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(image.readUInt32BE(16) >= 1600);
    assert.ok(image.readUInt32BE(20) >= 700);
    assert.equal(result.theme.brandSubtitle.startsWith("WORKBUDDY /"), true);
  }
});

test("WorkBuddy themes support the existing normalize, patch, and revision workflow", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-workbuddy-plugin-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const repository = new ThemeRepository({
    themesRoot: path.join(temporary, "themes"),
    dataRoot: path.join(temporary, "data"),
    backupsRoot: path.join(temporary, "backups"),
    projectRoot: WORKBUDDY_PLUGIN_ROOT,
  });
  const imagePath = path.join(CATALOG_ROOT, "harbor-focus", "background.png");
  const created = await repository.write({
    id: "workbuddy-agent-theme",
    imagePath,
    expectedRevision: null,
    themePatch: {
      name: "Agent WorkBuddy Theme",
      brandSubtitle: "WORKBUDDY / AGENT",
      colors: { accent: "#275F73", secondary: "#A95F64" },
      states: { focus: "#3E8795", surfaceActive: "rgba(39, 95, 115, 0.18)" },
      visual: { motif: "editorial", iconTreatment: "tile", cardTreatment: "split" },
      appearance: { colorScheme: "light", treatment: "neutral", radius: 6 },
    },
  });
  assert.equal(created.beforeRevision, null);
  const first = await repository.read("workbuddy-agent-theme");
  assert.equal(first.theme.colors.accent, "#275F73");
  assert.equal(first.theme.colors.success, "#51c9b6");

  const updated = await repository.write({
    id: "workbuddy-agent-theme",
    expectedRevision: first.revision,
    themePatch: {
      colors: { accentAlt: "#C77761" },
      visual: { ornament: "rules" },
      appearance: { backgroundPosition: "right center" },
    },
  });
  const second = await repository.read("workbuddy-agent-theme");
  assert.equal(second.revision, updated.afterRevision);
  assert.equal(second.theme.colors.accent, "#275F73");
  assert.equal(second.theme.colors.accentAlt, "#C77761");
  assert.equal(second.theme.visual.ornament, "rules");
  assert.equal(second.theme.appearance.backgroundPosition, "right center");
});

test("WorkBuddy plugin delegates theme and runtime actions to the injected target service", async () => {
  const calls = [];
  const catalogRepository = new ThemeRepository({
    themesRoot: CATALOG_ROOT,
    projectRoot: WORKBUDDY_PLUGIN_ROOT,
  });
  const service = {
    catalogRepository,
    toolInspect: async () => ({ target: { id: "workbuddy" } }),
    themeList: async () => ({ themesRoot: "/private/root", count: 0, themes: [] }),
    themeRead: async (id) => ({ id }),
    themeWrite: async (input) => { calls.push(["write", input]); return input; },
    themeValidate: async (input) => ({ valid: true, input }),
    preview: async (id, options) => ({ id, options }),
    runtimeStatus: async () => ({ available: true, target: "workbuddy" }),
    apply: async (id) => ({ applied: id }),
    verify: async (input) => ({ verified: true, input }),
    restore: async () => ({ restored: true }),
  };
  const plugin = await createWorkBuddyPlugin({ service });
  assert.deepEqual(await plugin.executeThemeAction("inspect"), { target: { id: "workbuddy" } });
  assert.deepEqual(await plugin.executeThemeAction("list"), { count: 0, themes: [] });
  assert.deepEqual(await plugin.createPreview({ id: "harbor-focus", screenshot: true }), {
    id: "harbor-focus", options: { screenshot: true },
  });
  assert.deepEqual(await plugin.executeRuntimeAction("apply", { id: "orchid-night" }), { applied: "orchid-night" });
  assert.deepEqual(await plugin.executeRuntimeAction("restore"), { restored: true });

  const created = await plugin.executeThemeAction("create", {
    id: "created-workbuddy",
    sourceId: "paper-garden",
    themePatch: { name: "Created WorkBuddy" },
  });
  assert.equal(created.id, "created-workbuddy");
  assert.equal(created.expectedRevision, null);
  assert.equal(created.operation, "write");
  assert.equal(created.imagePath, path.join(CATALOG_ROOT, "paper-garden", "background.png"));
  assert.deepEqual(calls.at(-1), ["write", created]);
  await assert.rejects(
    () => plugin.executeThemeAction("create", { id: "bad-template", sourceId: "paper-orbit" }),
    (error) => error.code === "TEMPLATE_NOT_FOUND",
  );
});

test("WorkBuddy structural CSS is version guarded and mirrored for ThemeLoader compatibility", async () => {
  const [canonical, compatibility] = await Promise.all([
    fs.readFile(path.join(WORKBUDDY_PLUGIN_ROOT, "assets", "workbuddy-skin.css"), "utf8"),
    fs.readFile(path.join(WORKBUDDY_PLUGIN_ROOT, "assets", "trae-skin.css"), "utf8"),
  ]);
  assert.equal(compatibility, canonical);
  assert.match(canonical, /html\.workbuddy-dream-skin/);
  assert.match(canonical, /data-workbuddy-skin-compat="5\.2"/);
  assert.match(canonical, /--wb-bg-primary:/);
  assert.match(canonical, /--cb-bg-primary:/);
  assert.match(canonical, /--vscode-editor-background:/);
  assert.match(canonical, /data-workbuddy-skin-icon-treatment/);
  assert.match(canonical, /data-workbuddy-skin-surface-treatment/);
  assert.match(canonical, /data-workbuddy-skin-card-treatment/);
  const hostSelectors = [...canonical.matchAll(/([^{}]+)\{[^{}]*\}/g)]
    .flatMap((match) => topLevelSelectors(match[1]))
    .filter((selector) => /(?:\.conversation-sidebar|\.wb-home-page|\.workbuddy-topbar)\b/.test(selector));
  assert.ok(hostSelectors.length > 0);
  assert.ok(hostSelectors.every((selector) => selector.startsWith("html.workbuddy-dream-skin")));
});

test("WorkBuddy consumes theme opacity without covering the conversation artwork", async () => {
  const [canonical, compatibility, renderer] = await Promise.all([
    fs.readFile(path.join(WORKBUDDY_PLUGIN_ROOT, "assets", "workbuddy-skin.css"), "utf8"),
    fs.readFile(path.join(WORKBUDDY_PLUGIN_ROOT, "assets", "trae-skin.css"), "utf8"),
    fs.readFile(path.join(ROOT, "assets", "workbuddy-renderer-inject.js"), "utf8"),
  ]);
  assert.equal(compatibility, canonical, "the compatibility asset must mirror canonical WorkBuddy CSS");

  const artworkLayerCss = ruleBodiesFor(canonical, ".teams-container::before");
  assert.match(artworkLayerCss, /background-image:\s*var\(--dreamskin-art\)/);
  assert.match(artworkLayerCss, /opacity:\s*var\(--dreamskin-art-opacity/);

  for (const selector of [
    ".teams-content-wrapper",
    ".main-content--chat",
    ".chat-container",
    ".ai-chat-content",
    ".wb-home-page",
    "[data-view-id]:not(.conversation-sidebar):not(.detail-panel-container)",
    "*:has(> .teams-content-wrapper)",
  ]) {
    const structureCss = ruleBodiesFor(canonical, selector);
    assert.match(structureCss, /background:\s*transparent/, `${selector} must not paint over the theme artwork`);
    if (!selector.startsWith("*:has")) {
      assert.match(structureCss, /backdrop-filter:\s*none/, `${selector} must not add a second glass layer`);
    }
  }

  const shellAliases = ruleBodiesFor(canonical, ".teams-container.is-mac");
  assert.match(shellAliases, /--wb-home-bg-primary:\s*transparent/);
  assert.match(shellAliases, /--wb-home-bg-secondary:\s*transparent/);

  const assistantCss = ruleBodiesFor(canonical, 'data-workbuddy-skin-runtime-role~="assistant.prose"');
  assert.match(assistantCss, /border:\s*0/);
  assert.match(assistantCss, /background:\s*transparent/);
  assert.match(assistantCss, /box-shadow:\s*none/);
  assert.match(assistantCss, /backdrop-filter:\s*none/);

  const composerCss = ruleBodiesFor(canonical, 'data-workbuddy-skin-runtime-role~="composer.surface"');
  assert.match(composerCss, /background:\s*var\(--ds-composer-surface\)/);
  assert.match(composerCss, /--cb-input-background:\s*transparent/);
  assert.match(composerCss, /backdrop-filter:\s*none/);

  for (const variable of [
    "--dreamskin-reading-mix",
    "--dreamskin-composer-mix",
    "--dreamskin-sidebar-readable-mix",
  ]) {
    assert.ok(canonical.includes(`var(${variable}`), `${variable} must be consumed by canonical CSS`);
    assert.ok(renderer.includes(`"${variable}"`), `${variable} must be produced by the renderer`);
  }
  assert.match(renderer, /surfacePercent\s*=\s*Number\(theme\.appearance\.surfaceOpacity\)\s*\*\s*100/);
  assert.match(renderer, /sidebarPercent\s*=\s*Number\(theme\.appearance\.sidebarOpacity\)\s*\*\s*100/);
});

test("WorkBuddy runtime covers every first-party business module with scoped surfaces", async () => {
  const [canonical, compatibility, renderer] = await Promise.all([
    fs.readFile(path.join(WORKBUDDY_PLUGIN_ROOT, "assets", "workbuddy-skin.css"), "utf8"),
    fs.readFile(path.join(WORKBUDDY_PLUGIN_ROOT, "assets", "trae-skin.css"), "utf8"),
    fs.readFile(path.join(ROOT, "assets", "workbuddy-renderer-inject.js"), "utf8"),
  ]);
  assert.equal(compatibility, canonical);

  for (const [route, selector] of [
    ["project", ".main-content--projects"],
    ["assistant", ".claw-workspace"],
    ["market", ".expert-center-page"],
    ["market", ".skills-view"],
    ["market", ".connector-panel"],
    ["automation", ".automation-main-page"],
    ["more", ".conversation-list-more-dropdown[role=menu]"],
  ]) {
    assert.ok(renderer.includes(`["${route}",`), `${route} must be a detectable WorkBuddy route`);
    assert.ok(renderer.includes(selector), `${selector} must participate in runtime route detection or marking`);
  }

  for (const selector of [
    ".workbuddy-collab",
    ".landing",
    ".project-detail-view",
    ".claw-workspace",
    ".expert-center-page",
    ".ec-main-content",
    ".skills-view",
    ".connector-panel",
    ".automation-panel",
  ]) {
    const canvasCss = ruleBodiesFor(canonical, selector);
    assert.match(canvasCss, /background:\s*transparent\s*!important/, `${selector} must reveal the shared artwork`);
    assert.match(canvasCss, /backdrop-filter:\s*none\s*!important/, `${selector} must not add a full-page glass layer`);
  }

  for (const selector of [
    ".project-grid__card",
    ".landing-template-card",
    ".wb-config-card",
    ".ec-expert-card",
    ".skill-card",
    ".connector-card",
    ".atm-template-card",
    ".atm-run-history-item",
  ]) {
    assert.ok(renderer.includes(selector), `${selector} must receive a stable semantic component or role`);
  }
  assert.match(renderer, /registryComponentGuards/);
  assert.match(renderer, /"market\.card":\s*\(node\)\s*=>\s*node\.matches/);
  assert.doesNotMatch(canonical, /\[class\*="skill-card"\]/,
    "skill-card descendants must not be promoted into nested themed cards");

  const cardCss = ruleBodiesFor(canonical, 'data-workbuddy-skin-runtime-role~="business.card"');
  assert.match(cardCss, /background:\s*var\(--ds-component-surface\)/);
  assert.match(cardCss, /border:\s*1px solid var\(--ds-line\)/);

  const panelCss = ruleBodiesFor(canonical, 'data-workbuddy-skin-runtime-role~="business.panel"');
  assert.match(panelCss, /background:\s*var\(--ds-business-panel\)\s*!important/);
  assert.match(panelCss, /backdrop-filter:\s*blur\(var\(--ds-blur\)\)/);

  const automationCss = ruleBodiesFor(canonical, ".automation-panel");
  assert.match(automationCss, /--atm-template-card-bg:\s*var\(--ds-component-surface\)/);
  assert.match(automationCss, /--atm-modal-bg:\s*var\(--ds-overlay-surface\)/);
  assert.match(automationCss, /--atm-text-primary:\s*var\(--ds-text\)/);

  const activityChipCss = ruleBodiesFor(canonical, ".mine-activity-card__chip");
  assert.match(activityChipCss, /color:\s*var\(--ds-accent\)\s*!important/);
  assert.match(activityChipCss, /background:\s*var\(--ds-selection\)\s*!important/);

  const marketplaceNextCss = ruleBodiesFor(canonical, ".ec-category-tabs-next");
  assert.match(marketplaceNextCss, /color:\s*var\(--ds-text\)\s*!important/);
  assert.match(marketplaceNextCss, /background:\s*var\(--ds-overlay-surface\)\s*!important/);

  assert.match(canonical, /background:\s*var\(--ds-form-surface\)/);
  assert.match(canonical, /background:\s*var\(--ds-overlay-surface\)/);
  assert.doesNotMatch(canonical, /\.teams-container\s+\*\s*\{/,
    "business-page coverage must not use a broad descendant background reset");
});

test("WorkBuddy blank recipe and factory fail closed on missing host input", async () => {
  assert.throws(() => createWorkBuddyBlankTheme(), (error) => error.code === "INVALID_PLUGIN_DEPENDENCY");
  assert.throws(
    () => createWorkBuddyBlankTheme({ sourceTheme: {}, id: "" }),
    (error) => error.code === "INVALID_TOOL_INPUT",
  );
  await assert.rejects(
    () => createWorkBuddyPlugin(),
    (error) => error.code === "INVALID_PLUGIN_DEPENDENCY",
  );
  assert.equal(path.resolve(ROOT, "plugins/workbuddy"), WORKBUDDY_PLUGIN_ROOT);
});
