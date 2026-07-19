import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { TRAE_CATALOG } from "../plugins/trae/catalog.mjs";
import {
  createTraePlugin,
  loadTraePluginManifest,
  TRAE_PLUGIN_ROOT,
} from "../plugins/trae/plugin.mjs";
import { createTraeApplicationContext } from "../src/core/application-context.mjs";
import { createStudioBackend } from "../src/core/studio-backend.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function packagedPluginFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-packaged-plugin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resourceRoot = path.join(root, "resources", "dreamskin");
  const pluginRoot = path.join(resourceRoot, "plugins", "trae");
  await fs.mkdir(path.dirname(pluginRoot), { recursive: true });
  await fs.cp(TRAE_PLUGIN_ROOT, pluginRoot, { recursive: true });

  const catalogRoot = path.join(pluginRoot, "packaged-catalog");
  await fs.rename(path.join(pluginRoot, "catalog"), catalogRoot);
  const registryPath = path.join(pluginRoot, "resources", "packaged-components.v1.json");
  await fs.rename(path.join(pluginRoot, "resources", "components.v1.json"), registryPath);
  const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
  registry.packagedFixture = true;
  await fs.writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`);

  const sourceManifestPath = path.join(pluginRoot, "plugin.json");
  const manifest = JSON.parse(await fs.readFile(sourceManifestPath, "utf8"));
  manifest.catalog.root = "packaged-catalog";
  manifest.theme.registryPath = "resources/packaged-components.v1.json";
  const pluginManifestPath = path.join(pluginRoot, "packaged-plugin.json");
  await fs.writeFile(pluginManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rm(sourceManifestPath);
  await fs.mkdir(path.join(resourceRoot, "scripts"), { recursive: true });

  return { root, resourceRoot, pluginRoot, pluginManifestPath, catalogRoot, registryPath };
}

test("Trae factory loads an explicit packaged resource root without rebinding catalog metadata", async (t) => {
  const fixture = await packagedPluginFixture(t);
  const manifest = await loadTraePluginManifest({
    pluginRoot: fixture.pluginRoot,
    manifestPath: fixture.pluginManifestPath,
  });
  const plugin = await createTraePlugin({
    service: {},
    pluginRoot: fixture.pluginRoot,
    manifestPath: fixture.pluginManifestPath,
  });

  assert.equal(manifest.id, "dreamskin.trae");
  assert.equal(manifest.catalog.root, "packaged-catalog");
  assert.equal(plugin.rootPath, fixture.pluginRoot);
  assert.equal(plugin.catalog, TRAE_CATALOG);
  await assert.rejects(
    () => loadTraePluginManifest({
      pluginRoot: fixture.pluginRoot,
      manifestPath: path.join(fixture.root, "outside.json"),
    }),
    (error) => error.code === "INVALID_PLUGIN_RESOURCE",
  );
});

test("application context resolves schema, registry, runtime mapping, assets, and catalog from pluginRoot", async (t) => {
  const fixture = await packagedPluginFixture(t);
  const userThemesRoot = path.join(fixture.root, "user", "themes");
  const dataRoot = path.join(fixture.root, "user", "state");
  const context = await createTraeApplicationContext({
    themesRoot: userThemesRoot,
    dataRoot,
    backupsRoot: path.join(dataRoot, "backups"),
    projectRoot: fixture.resourceRoot,
    pluginRoot: fixture.pluginRoot,
    pluginManifestPath: fixture.pluginManifestPath,
  });
  t.after(() => context.pluginManager.deactivate(context.plugin.manifest.id));
  const realPluginRoot = await fs.realpath(fixture.pluginRoot);
  const realCatalogRoot = await fs.realpath(fixture.catalogRoot);
  const realRegistryPath = await fs.realpath(fixture.registryPath);

  assert.equal(context.plugin.rootPath, fixture.pluginRoot);
  assert.equal(context.repository.projectRoot, fixture.pluginRoot);
  assert.equal(context.catalogRepository.projectRoot, fixture.pluginRoot);
  assert.equal(context.catalogRepository.themesRoot, realCatalogRoot);
  assert.equal(context.platformRuntime.scriptsRoot, path.join(fixture.resourceRoot, "scripts"));
  assert.equal(context.targetService.registryPath, realRegistryPath);
  assert.equal(path.dirname(context.targetService.schemaPath), path.join(realPluginRoot, "resources"));
  assert.equal(path.dirname(context.targetService.runtimeMappingPath), path.join(realPluginRoot, "resources"));
  assert.equal(
    await fs.readFile(path.join(context.repository.projectRoot, "assets", "trae-skin.css"), "utf8")
      .then((css) => css.length > 0),
    true,
  );

  const inspect = await context.tool.inspect();
  assert.equal(inspect.registry.packagedFixture, true);
  assert.equal(JSON.stringify(inspect).includes(fixture.pluginRoot), false);
  assert.equal(JSON.stringify(inspect).includes(realPluginRoot), false);
  assert.equal(JSON.stringify(context.pluginManager.list()).includes(fixture.pluginRoot), false);
  assert.equal(JSON.stringify(context.pluginManager.list()).includes(realPluginRoot), false);
});

test("createStudioBackend threads packaged plugin, catalog, and registry paths through its real library", async (t) => {
  const fixture = await packagedPluginFixture(t);
  const dataRoot = path.join(fixture.root, "studio", "state");
  const backend = await createStudioBackend({
    pluginRoot: fixture.pluginRoot,
    pluginManifestPath: fixture.pluginManifestPath,
    catalogThemesRoot: fixture.catalogRoot,
    registryPath: fixture.registryPath,
    userThemesRoot: path.join(fixture.root, "studio", "themes"),
    dataRoot,
    manifestPath: path.join(dataRoot, "library.json"),
    projectRoot: fixture.resourceRoot,
  });
  t.after(() => backend.close());

  assert.equal(backend.registryPath, fixture.registryPath);
  assert.equal(backend.library.catalogRepository.themesRoot, fixture.catalogRoot);
  assert.equal(backend.library.userRepository.projectRoot, fixture.pluginRoot);
  assert.equal((await backend.catalog()).length, Object.keys(TRAE_CATALOG.templates).length);
  assert.equal((await backend.components())[0].id, "shell.workspace");
  assert.equal(backend.pluginManager.get("dreamskin.trae").manifest.catalog.root, "packaged-catalog");
});

test("source defaults remain valid for CLI and development Studio callers", async () => {
  const manifest = await loadTraePluginManifest();
  assert.equal(manifest.id, "dreamskin.trae");
  assert.equal(path.resolve(TRAE_PLUGIN_ROOT), TRAE_PLUGIN_ROOT);
  assert.equal(PROJECT_ROOT.endsWith("Agent-Dream-Skin"), true);
});
