import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createDesktopBackendConfig } from "../desktop/shell.mjs";
import {
  createDreamSkinCliContext,
  DREAMSKIN_PLUGIN_IDS,
  resolveDreamSkinCliPaths,
} from "../src/core/cli-context.mjs";
import { DesktopPathLayout } from "../src/core/desktop-layout.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRAE = "dreamskin.trae";
const WORKBUDDY = "dreamskin.workbuddy";
const TARGETS = Object.freeze([
  [TRAE, "trae"],
  [WORKBUDDY, "workbuddy"],
]);

test("CLI paths use the canonical desktop user-data layout for both targets", () => {
  const homeDir = path.join(path.parse(PROJECT_ROOT).root, "Users", "dreamskin-test");
  const resourceRoot = path.join(homeDir, "DreamSkin Resources");
  const paths = resolveDreamSkinCliPaths({
    platform: "darwin",
    homeDir,
    environment: { DREAMSKIN_RESOURCE_ROOT: resourceRoot },
  });
  const userDataRoot = path.join(
    homeDir,
    "Library",
    "Application Support",
    "DreamSkin Studio",
  );
  const layout = new DesktopPathLayout({
    appPath: resourceRoot,
    developmentResourcesPath: resourceRoot,
    userDataPath: userDataRoot,
  });

  assert.equal(paths.userDataRoot, userDataRoot);
  assert.equal(paths.dataRoot, layout.dataRoot);
  assert.deepEqual(Object.keys(paths.targets), [...DREAMSKIN_PLUGIN_IDS]);

  for (const [pluginId, pluginResourceDirectory] of TARGETS) {
    const desktop = createDesktopBackendConfig({
      layout,
      pluginId,
      pluginResourceDirectory,
    });
    const cli = paths.targets[pluginId];
    assert.deepEqual(
      {
        pluginRoot: cli.pluginRoot,
        pluginManifestPath: cli.pluginManifestPath,
        catalogThemesRoot: cli.catalogThemesRoot,
        registryPath: cli.registryPath,
        themesRoot: cli.themesRoot,
        dataRoot: cli.dataRoot,
        backupsRoot: cli.backupsRoot,
        manifestPath: cli.manifestPath,
      },
      {
        pluginRoot: desktop.paths.pluginRoot,
        pluginManifestPath: desktop.paths.pluginManifestPath,
        catalogThemesRoot: desktop.paths.catalogThemesRoot,
        registryPath: desktop.paths.registryPath,
        themesRoot: desktop.paths.userThemesRoot,
        dataRoot: desktop.paths.stateRoot,
        backupsRoot: desktop.paths.backupsRoot,
        manifestPath: desktop.paths.manifestPath,
      },
      pluginId,
    );
  }

  assert.notEqual(paths.targets[TRAE].themesRoot, paths.targets[WORKBUDDY].themesRoot);
  assert.notEqual(paths.targets[TRAE].dataRoot, paths.targets[WORKBUDDY].dataRoot);
  assert.notEqual(paths.targets[TRAE].backupsRoot, paths.targets[WORKBUDDY].backupsRoot);
});

test("path resolution uses only the injected environment and honors explicit roots", () => {
  const fixtureRoot = path.join(path.parse(PROJECT_ROOT).root, "fixtures", "dreamskin-cli");
  const xdgRoot = path.join(fixtureRoot, "xdg");
  const implicit = resolveDreamSkinCliPaths({
    platform: "linux",
    homeDir: path.join(fixtureRoot, "home"),
    environment: {
      XDG_CONFIG_HOME: xdgRoot,
      DREAMSKIN_RESOURCE_ROOT: path.join(fixtureRoot, "resources"),
    },
  });
  assert.equal(implicit.userDataRoot, path.join(xdgRoot, "dreamskin-studio"));
  assert.equal(implicit.dataRoot, path.join(xdgRoot, "dreamskin-studio", "dreamskin"));

  const explicit = resolveDreamSkinCliPaths({
    platform: "darwin",
    homeDir: path.join(fixtureRoot, "ignored-home"),
    environment: {
      DREAMSKIN_PACKAGED: "1",
      DREAMSKIN_RESOURCE_ROOT: path.join(fixtureRoot, "bundle"),
      DREAMSKIN_USER_DATA_ROOT: path.join(fixtureRoot, "user data"),
      DREAMSKIN_DATA_ROOT: path.join(fixtureRoot, "mutable data"),
      DREAMSKIN_TRAE_RUNTIME_STATE_ROOT: path.join(fixtureRoot, "trae runtime"),
      DREAMSKIN_WORKBUDDY_RUNTIME_STATE_ROOT: path.join(fixtureRoot, "workbuddy runtime"),
    },
  });
  assert.equal(explicit.packaged, true);
  assert.equal(explicit.resourceRoot, path.join(fixtureRoot, "bundle"));
  assert.equal(explicit.userDataRoot, path.join(fixtureRoot, "user data"));
  assert.equal(explicit.dataRoot, path.join(fixtureRoot, "mutable data"));
  assert.deepEqual(explicit.runtimeStateRoots, {
    [TRAE]: path.join(fixtureRoot, "trae runtime"),
    [WORKBUDDY]: path.join(fixtureRoot, "workbuddy runtime"),
  });
});

test("CLI context keeps equal theme ids isolated between Trae and WorkBuddy", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-cli-context-"));
  const previousTraeHome = process.env.TRAE_DREAM_SKIN_HOME;
  let cli;
  t.after(async () => {
    if (cli) await cli.close();
    if (previousTraeHome === undefined) delete process.env.TRAE_DREAM_SKIN_HOME;
    else process.env.TRAE_DREAM_SKIN_HOME = previousTraeHome;
    await fs.rm(root, { recursive: true, force: true });
  });

  cli = await createDreamSkinCliContext({
    environment: {
      DREAMSKIN_RESOURCE_ROOT: PROJECT_ROOT,
      DREAMSKIN_USER_DATA_ROOT: path.join(root, "user data"),
    },
  });
  assert.deepEqual(cli.targets().map(({ pluginId, targetId, active }) => ({
    pluginId,
    targetId,
    active,
  })), [
    { pluginId: TRAE, targetId: "trae", active: true },
    { pluginId: WORKBUDDY, targetId: "workbuddy", active: true },
  ]);

  await cli.tool.execute({
    action: "create",
    pluginId: TRAE,
    themeId: "shared-id",
    sourceId: "paper-aurora",
    themePatch: { name: "Trae Shared Theme" },
  });
  await cli.tool.execute({
    action: "create",
    pluginId: WORKBUDDY,
    themeId: "shared-id",
    sourceId: "paper-garden",
    themePatch: { name: "WorkBuddy Shared Theme" },
  });

  const [traeTheme, workBuddyTheme] = await Promise.all([
    cli.tool.execute({ action: "read", pluginId: TRAE, themeId: "shared-id" }),
    cli.tool.execute({ action: "read", pluginId: WORKBUDDY, themeId: "shared-id" }),
  ]);
  assert.equal(traeTheme.theme.name, "Trae Shared Theme");
  assert.equal(workBuddyTheme.theme.name, "WorkBuddy Shared Theme");
  const [traeSource, workBuddySource] = await Promise.all([
    fs.readFile(path.join(PROJECT_ROOT, "plugins", "trae", "catalog", "paper-aurora", "theme.json"), "utf8").then(JSON.parse),
    fs.readFile(path.join(PROJECT_ROOT, "plugins", "workbuddy", "catalog", "paper-garden", "theme.json"), "utf8").then(JSON.parse),
  ]);
  assert.equal(traeTheme.theme.description, traeSource.description);
  assert.equal(traeTheme.theme.colors.accent, traeSource.colors.accent);
  assert.equal(workBuddyTheme.theme.tagline, workBuddySource.tagline);
  assert.equal(workBuddyTheme.theme.visual.motif, workBuddySource.visual.motif);
  assert.deepEqual(traeTheme.provenance, {
    schemaVersion: 1,
    origin: "template",
    sourceId: "paper-aurora",
  });
  assert.deepEqual(workBuddyTheme.provenance, {
    schemaVersion: 1,
    origin: "template",
    sourceId: "paper-garden",
  });
  assert.notEqual(traeTheme.asset.sha256, workBuddyTheme.asset.sha256);

  const [traeImport, workBuddyImport] = await Promise.all([
    cli.tool.execute({
      action: "importAsset",
      pluginId: TRAE,
      themeId: "shared-id",
      assetPath: path.join(PROJECT_ROOT, "plugins", "trae", "catalog", "violet-rift", "background.png"),
      expectedRevision: traeTheme.revision,
    }),
    cli.tool.execute({
      action: "importAsset",
      pluginId: WORKBUDDY,
      themeId: "shared-id",
      assetPath: path.join(PROJECT_ROOT, "plugins", "workbuddy", "catalog", "coral-studio", "background.png"),
      expectedRevision: workBuddyTheme.revision,
    }),
  ]);
  const [traeImported, workBuddyImported] = await Promise.all([
    cli.tool.execute({ action: "read", pluginId: TRAE, themeId: "shared-id" }),
    cli.tool.execute({ action: "read", pluginId: WORKBUDDY, themeId: "shared-id" }),
  ]);
  assert.equal(traeImported.revision, traeImport.afterRevision);
  assert.equal(workBuddyImported.revision, workBuddyImport.afterRevision);
  assert.notEqual(traeImported.asset.sha256, traeTheme.asset.sha256);
  assert.notEqual(workBuddyImported.asset.sha256, workBuddyTheme.asset.sha256);
  assert.deepEqual(traeImported.provenance, traeTheme.provenance);
  assert.deepEqual(workBuddyImported.provenance, workBuddyTheme.provenance);
  await assert.rejects(
    cli.tool.execute({
      action: "create",
      pluginId: TRAE,
      themeId: "shared-id",
      themePatch: { name: "Duplicate" },
    }),
    (error) => error.code === "THEME_ALREADY_EXISTS",
  );
  await Promise.all([
    fs.access(path.join(cli.paths.targets[TRAE].themesRoot, "shared-id", "theme.json")),
    fs.access(path.join(cli.paths.targets[WORKBUDDY].themesRoot, "shared-id", "theme.json")),
  ]);

  assert.throws(
    () => cli.tool.execute({ action: "list", pluginId: "dreamskin.unknown" }),
    (error) => error.code === "PLUGIN_NOT_FOUND",
  );
});

test("packaged CLI context validates resources before activating plugins", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-cli-packaged-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resourceRoot = path.join(root, "resources", "dreamskin");
  await fs.mkdir(resourceRoot, { recursive: true });

  await assert.rejects(
    createDreamSkinCliContext({
      environment: {
        DREAMSKIN_PACKAGED: "1",
        DREAMSKIN_RESOURCE_ROOT: resourceRoot,
        DREAMSKIN_USER_DATA_ROOT: path.join(root, "user data"),
      },
    }),
    (error) => error.code === "RESOURCE_MANIFEST_MISSING",
  );
});
