import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TRAE_CATALOG, TRAE_CATALOG_METADATA } from "../plugins/trae/catalog.mjs";
import { createTraeApplicationContext } from "../src/core/application-context.mjs";
import { StudioLibrary } from "../src/core/studio-library.mjs";
import { ThemeRepository } from "../src/core/theme-repository.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function libraryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-studio-library-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const catalogRoot = path.join(root, "catalog");
  const userRoot = path.join(root, "library", "themes");
  for (const id of Object.keys(TRAE_CATALOG_METADATA)) {
    const themeRoot = path.join(catalogRoot, id);
    await fs.mkdir(themeRoot, { recursive: true });
    await fs.copyFile(path.join(ROOT, "themes", id, "theme.json"), path.join(themeRoot, "theme.json"));
    await fs.writeFile(path.join(themeRoot, "background.png"), PNG_SIGNATURE);
  }

  const catalogRepository = new ThemeRepository({
    themesRoot: catalogRoot,
    dataRoot: path.join(root, "catalog-data"),
    backupsRoot: path.join(root, "catalog-data", "backups"),
    projectRoot: ROOT,
  });
  const userRepository = new ThemeRepository({
    themesRoot: userRoot,
    dataRoot: path.join(root, "user-data"),
    backupsRoot: path.join(root, "user-data", "backups"),
    projectRoot: ROOT,
  });
  const manifestPath = path.join(root, "library", "library.json");
  const context = await createTraeApplicationContext({
    repository: userRepository,
    catalogRepository,
    dataRoot: path.join(root, "user-data"),
    backupsRoot: path.join(root, "user-data", "backups"),
    projectRoot: ROOT,
  });
  t.after(() => Promise.allSettled([
    context.pluginManager.deactivate(context.plugin.manifest.id),
  ]));
  const toolCalls = [];
  const tool = {
    createTheme(input, pluginId) {
      toolCalls.push({ action: "create", input: structuredClone(input), pluginId });
      return context.tool.createTheme(input, pluginId);
    },
    updateTheme(input, pluginId) {
      toolCalls.push({ action: "update", input: structuredClone(input), pluginId });
      return context.tool.updateTheme(input, pluginId);
    },
  };
  let currentTime = Date.parse("2026-07-19T12:00:00.000Z");
  const now = () => new Date(currentTime);
  const advanceTime = (milliseconds = 1000) => { currentTime += milliseconds; };
  const library = new StudioLibrary({
    catalogRepository,
    userRepository,
    tool,
    pluginId: context.plugin.manifest.id,
    catalog: TRAE_CATALOG,
    manifestPath,
    now,
  });
  return {
    root,
    catalogRoot,
    userRoot,
    catalogRepository,
    userRepository,
    manifestPath,
    library,
    now,
    advanceTime,
    context,
    tool,
    toolCalls,
  };
}

test("Studio catalog stays separate from the persistent user library", async (t) => {
  const fixture = await libraryFixture(t);
  const sourceConfigPath = path.join(fixture.catalogRoot, "sunlit-spark", "theme.json");
  const sourceConfigBefore = await fs.readFile(sourceConfigPath, "utf8");

  const catalog = await fixture.library.catalog();
  assert.equal(catalog.length, Object.keys(TRAE_CATALOG_METADATA).length);
  assert.ok(catalog.every((entry) => entry.theme.builtIn));
  assert.match(catalog[0].theme.imageUrl, /^\/api\/v1\/catalog\//);
  assert.deepEqual(await fixture.library.list(), []);

  const added = await fixture.library.addTemplate("sunlit-spark");
  assert.equal(fixture.toolCalls[0].action, "create");
  assert.equal(fixture.toolCalls[0].pluginId, "dreamskin.trae");
  assert.equal(fixture.toolCalls[0].input.sourceId, "sunlit-spark");
  assert.notEqual(added.localId, "sunlit-spark");
  assert.equal(added.sourceId, "sunlit-spark");
  assert.equal(added.origin, "template");
  assert.equal(added.theme.builtIn, false);
  assert.match(added.theme.imageUrl, new RegExp(`^/api/v1/themes/${added.localId}/asset`));
  assert.equal((await fixture.library.list()).length, 1);
  assert.equal(await fs.readFile(sourceConfigPath, "utf8"), sourceConfigBefore);
  await fs.access(path.join(fixture.userRoot, added.localId, "theme.json"));
});

test("adding the same template twice is idempotent", async (t) => {
  const { library, userRoot } = await libraryFixture(t);
  const first = await library.addTemplate("violet-rift");
  const second = await library.addTemplate("violet-rift");

  assert.equal(second.localId, first.localId);
  assert.equal(second.revisionHash, first.revisionHash);
  assert.equal((await library.list()).length, 1);
  const directories = (await fs.readdir(userRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());
  assert.deepEqual(directories.map((entry) => entry.name), [first.localId]);
});

test("blank themes are valid immediately and survive a new library instance", async (t) => {
  const fixture = await libraryFixture(t);
  const blank = await fixture.library.createBlank();
  assert.equal(fixture.toolCalls[0].action, "create");
  assert.equal(fixture.toolCalls[0].input.sourceId, "paper-aurora");

  assert.match(blank.localId, /^blank-[a-f0-9]{8}$/);
  assert.equal(blank.origin, "blank");
  assert.equal(blank.status, "draft");
  assert.equal(blank.theme.name, "未命名主题");
  assert.equal(blank.theme.appearance.treatment, "neutral");
  assert.equal(blank.theme.appearance.backgroundOpacity, 0);
  assert.match(blank.revisionHash, /^[a-f0-9]{64}$/);

  const validation = await fixture.userRepository.validate({ id: blank.localId });
  assert.equal(validation.valid, true);
  const reopened = new StudioLibrary({
    catalogRepository: fixture.catalogRepository,
    userRepository: fixture.userRepository,
    tool: fixture.tool,
    pluginId: fixture.context.plugin.manifest.id,
    catalog: TRAE_CATALOG,
    manifestPath: fixture.manifestPath,
    now: fixture.now,
  });
  const persisted = await reopened.read(blank.localId);
  assert.equal(persisted.localId, blank.localId);
  assert.equal(persisted.revisionHash, blank.revisionHash);
  assert.equal(persisted.status, "draft");
});

test("Studio duplicates themes through the Tool and deletes only the inspected revision", async (t) => {
  const fixture = await libraryFixture(t);
  const source = await fixture.library.addTemplate("sunlit-spark");
  const duplicate = await fixture.library.duplicate(source.localId);

  assert.notEqual(duplicate.localId, source.localId);
  assert.match(duplicate.localId, /-copy-[a-f0-9]{8}$/);
  assert.equal(duplicate.theme.name, `${source.theme.name} 副本`);
  assert.equal(duplicate.theme.colors.accent, source.theme.colors.accent);
  assert.equal(fixture.toolCalls.at(-1).action, "create");
  assert.equal(fixture.toolCalls.at(-1).input.sourceId, "sunlit-spark");
  assert.equal((await fixture.library.list()).length, 2);

  await assert.rejects(
    () => fixture.library.delete(duplicate.localId, { expectedRevision: source.revisionHash }),
    (error) => error.code === "REVISION_CONFLICT" && error.details.actualRevision === duplicate.revisionHash,
  );
  const deleted = await fixture.library.delete(duplicate.localId, {
    expectedRevision: duplicate.revisionHash,
  });
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.themeId, duplicate.localId);
  assert.deepEqual((await fixture.library.list()).map((item) => item.localId), [source.localId]);
  await assert.rejects(
    () => fixture.userRepository.read(duplicate.localId),
    (error) => error.code === "THEME_NOT_FOUND",
  );

  await fixture.userRepository.rollback(deleted.transactionId);
  const recovered = await fixture.library.read(duplicate.localId);
  assert.equal(recovered.theme.name, duplicate.theme.name);
  assert.equal(recovered.revisionHash, duplicate.revisionHash);
});

test("Studio updates enforce optimistic revisions and preserve the winning write", async (t) => {
  const { library, toolCalls } = await libraryFixture(t);
  const added = await library.addTemplate("neon-portal");
  const updatedTheme = structuredClone(added.theme);
  updatedTheme.name = "Neon Portal Local";

  const updated = await library.update(added.localId, {
    theme: updatedTheme,
    expectedRevision: added.revisionHash,
  });
  assert.equal(toolCalls.at(-1).action, "update");
  assert.equal(toolCalls.at(-1).input.expectedRevision, added.revisionHash);
  assert.equal(updated.theme.name, "Neon Portal Local");
  assert.equal(updated.revision, 2);
  assert.notEqual(updated.revisionHash, added.revisionHash);

  const staleTheme = structuredClone(added.theme);
  staleTheme.name = "Stale Edit";
  await assert.rejects(
    () => library.update(added.localId, { theme: staleTheme, expectedRevision: added.revisionHash }),
    (error) => error.code === "REVISION_CONFLICT" && error.details.actualRevision === updated.revisionHash,
  );
  const persisted = await library.read(added.localId);
  assert.equal(persisted.theme.name, "Neon Portal Local");
  assert.equal(persisted.revision, 2);
});

test("catalog and user assets expose validated stream metadata", async (t) => {
  const { library, catalogRoot, userRoot } = await libraryFixture(t);
  const catalogAsset = await library.asset("catalog", "paper-aurora");
  assert.equal(catalogAsset.mime, "image/png");
  assert.equal(catalogAsset.bytes, PNG_SIGNATURE.length);
  assert.match(catalogAsset.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(catalogAsset.buffer, PNG_SIGNATURE);

  const added = await library.addTemplate("paper-aurora");
  const userAsset = await library.asset("theme", added.localId);
  assert.equal(userAsset.mime, "image/png");
  assert.equal(userAsset.bytes, PNG_SIGNATURE.length);
  assert.equal(userAsset.revision, added.revisionHash);
  assert.deepEqual(userAsset.buffer, PNG_SIGNATURE);

  await assert.rejects(() => library.asset("catalog", "not-a-template"), (error) => error.code === "TEMPLATE_NOT_FOUND");
  await assert.rejects(() => library.asset("theme", "not-a-theme"), (error) => error.code === "THEME_NOT_FOUND");
});

test("Studio discovers themes created directly through the shared MCP repository", async (t) => {
  const fixture = await libraryFixture(t);
  const source = await fixture.catalogRepository.read("ember-glass");
  const id = "mcp-created-theme";
  const write = await fixture.userRepository.write({
    id,
    imagePath: path.join(fixture.catalogRoot, "ember-glass", source.asset.file),
    expectedRevision: null,
    themePatch: { ...structuredClone(source.theme), id, name: "MCP Created Theme" },
  });

  const discovered = await fixture.library.read(id);
  assert.equal(discovered.localId, id);
  assert.equal(discovered.origin, "blank");
  assert.equal(discovered.theme.name, "MCP Created Theme");
  assert.equal(discovered.revision, 1);
  assert.equal(discovered.revisionHash, write.afterRevision);
  assert.equal(discovered.status, "verified");

  const manifest = JSON.parse(await fs.readFile(fixture.manifestPath, "utf8"));
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].id, id);
  assert.equal((await fixture.library.list())[0].localId, id);
});

test("Studio synchronizes external MCP edits into manifest revision metadata", async (t) => {
  const fixture = await libraryFixture(t);
  const added = await fixture.library.addTemplate("neon-portal");
  const originalUpdatedAt = added.updatedAt;
  fixture.advanceTime();

  const external = await fixture.userRepository.write({
    id: added.localId,
    expectedRevision: added.revisionHash,
    themePatch: { name: "Neon Portal via MCP" },
  });
  const synchronized = await fixture.library.read(added.localId);

  assert.equal(synchronized.theme.name, "Neon Portal via MCP");
  assert.equal(synchronized.revision, 2);
  assert.equal(synchronized.revisionHash, external.afterRevision);
  assert.notEqual(synchronized.updatedAt, originalUpdatedAt);
  assert.equal(synchronized.status, "verified");
  assert.equal(synchronized.lastTransactionId, undefined);

  const manifest = JSON.parse(await fs.readFile(fixture.manifestPath, "utf8"));
  const entry = manifest.entries.find((candidate) => candidate.id === added.localId);
  assert.equal(entry.revisionNumber, 2);
  assert.equal(entry.revisionHash, external.afterRevision);
  assert.equal(entry.updatedAt, synchronized.updatedAt);
  assert.equal(entry.lastTransactionId, undefined);
});

test("active status is tied to the exact recorded applied revision", async (t) => {
  const fixture = await libraryFixture(t);
  const added = await fixture.library.addTemplate("paper-aurora");

  const unrecorded = await fixture.library.read(added.localId, { activeThemeId: added.localId });
  assert.equal(unrecorded.status, "verified");

  const applied = await fixture.library.markApplied(added.localId, added.revisionHash);
  assert.equal(applied.status, "applied");
  assert.equal((await fixture.library.list({ activeThemeId: added.localId }))[0].status, "applied");

  fixture.advanceTime();
  const external = await fixture.userRepository.write({
    id: added.localId,
    expectedRevision: added.revisionHash,
    themePatch: { name: "Paper Aurora New Revision" },
  });
  const staleRuntime = await fixture.library.read(added.localId, { activeThemeId: added.localId });
  assert.equal(staleRuntime.revisionHash, external.afterRevision);
  assert.equal(staleRuntime.status, "verified");

  await assert.rejects(
    () => fixture.library.markApplied(added.localId, added.revisionHash),
    (error) => error.code === "REVISION_CONFLICT" && error.details.actualRevision === external.afterRevision,
  );
  assert.equal((await fixture.library.markApplied(added.localId, external.afterRevision)).status, "applied");
});
