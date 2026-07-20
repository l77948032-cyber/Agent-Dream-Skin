import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ThemeRepository } from "../src/core/theme-repository.mjs";
import { MAX_ART_BYTES } from "../src/core/theme-model.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const IMAGE_PATH = path.join(ROOT, "themes", "violet-rift", "background.png");

async function repositoryFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trae-agent-tool-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new ThemeRepository({
    themesRoot: path.join(root, "themes"),
    dataRoot: path.join(root, "data"),
    backupsRoot: path.join(root, "data", "backups"),
    projectRoot: ROOT,
    ...options,
  });
}

async function writeFixtureTheme(repository, {
  id = "agent-fixture",
  name,
  expectedRevision = null,
} = {}) {
  return repository.write({
    id,
    imagePath: IMAGE_PATH,
    expectedRevision,
    themePatch: {
      name,
      appearance: { colorScheme: "dark", treatment: "violet-rift" },
    },
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function fileSystemWithFaults({ rename, rm } = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (property === "rename" && rename) {
        return async (source, destination) => {
          if (rename(source, destination)) {
            const error = new Error(`Injected rename failure: ${path.basename(source)}`);
            error.code = "EIO";
            throw error;
          }
          return target.rename(source, destination);
        };
      }
      if (property === "rm" && rm) {
        return async (filePath, options) => {
          if (rm(filePath, options)) {
            const error = new Error(`Injected remove failure: ${path.basename(filePath)}`);
            error.code = "EIO";
            throw error;
          }
          return target.rm(filePath, options);
        };
      }
      const value = target[property];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("theme repository stages, commits, revisions, and idempotent rollback", async (t) => {
  const repository = await repositoryFixture(t);
  const imagePath = path.join(ROOT, "themes", "violet-rift", "background.png");
  const dryRun = await repository.write({
    id: "agent-fixture",
    imagePath,
    expectedRevision: null,
    dryRun: true,
    themePatch: {
      name: "Agent Fixture",
      states: { tooltipBackground: "#19172F", tooltipText: "#F4F4FF" },
      visual: { motif: "prism", iconTreatment: "tile", ornament: "facets" },
      appearance: { colorScheme: "dark", treatment: "violet-rift" },
    },
  });
  assert.equal(dryRun.dryRun, true);
  await assert.rejects(() => repository.read("agent-fixture"), (error) => error.code === "THEME_NOT_FOUND");

  const written = await repository.write({
    id: "agent-fixture",
    imagePath,
    expectedRevision: null,
    themePatch: {
      name: "Agent Fixture",
      states: { tooltipBackground: "#19172F", tooltipText: "#F4F4FF" },
      visual: { motif: "prism", iconTreatment: "tile", ornament: "facets" },
      appearance: { colorScheme: "dark", treatment: "violet-rift" },
    },
  });
  assert.equal(written.beforeRevision, null);
  const read = await repository.read("agent-fixture");
  assert.equal(read.revision, written.afterRevision);
  assert.equal(read.theme.states.tooltipBackground, "#19172F");
  assert.equal(read.theme.visual.motif, "prism");

  await assert.rejects(() => repository.write({
    id: "agent-fixture",
    expectedRevision: "stale",
    themePatch: { name: "Should Not Commit" },
  }), (error) => error.code === "REVISION_CONFLICT");

  const rolledBack = await repository.write({ operation: "rollback", transactionId: written.transactionId });
  assert.equal(rolledBack.rolledBack, true);
  await assert.rejects(() => repository.read("agent-fixture"), (error) => error.code === "THEME_NOT_FOUND");
  const repeated = await repository.write({ operation: "rollback", transactionId: written.transactionId });
  assert.equal(repeated.alreadyRolledBack, true);
});

test("theme repository preserves provenance, replaces managed assets, and reports duplicate creates", async (t) => {
  const repository = await repositoryFixture(t);
  const created = await repository.write({
    id: "provenance-theme",
    imagePath: IMAGE_PATH,
    expectedRevision: null,
    provenance: { schemaVersion: 1, origin: "template", sourceId: "violet-rift" },
    themePatch: { name: "Provenance Theme" },
  });
  assert.deepEqual(created.provenance, {
    schemaVersion: 1,
    origin: "template",
    sourceId: "violet-rift",
  });
  await assert.rejects(
    repository.write({
      id: "provenance-theme",
      expectedRevision: null,
      themePatch: { name: "Duplicate" },
    }),
    (error) => error.code === "THEME_ALREADY_EXISTS"
      && error.details.actualRevision === created.afterRevision,
  );

  const jpegPath = path.join(path.dirname(repository.themesRoot), "replacement.jpg");
  await fs.writeFile(jpegPath, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
  const imported = await repository.write({
    id: "provenance-theme",
    imagePath: jpegPath,
    expectedRevision: created.afterRevision,
    themePatch: {},
  });
  const read = await repository.read("provenance-theme");
  assert.equal(read.revision, imported.afterRevision);
  assert.equal(read.theme.image, "background.jpg");
  assert.deepEqual(read.provenance, created.provenance);
  assert.equal(await exists(path.join(repository.themePath("provenance-theme"), "background.png")), false);
  assert.deepEqual(
    await fs.readFile(path.join(repository.themePath("provenance-theme"), "background.jpg")),
    Buffer.from([0xff, 0xd8, 0xff, 0x00]),
  );
});

test("theme repository rejects unsafe imported background assets before staging", {
  skip: process.platform === "win32",
}, async (t) => {
  const repository = await repositoryFixture(t);
  const created = await writeFixtureTheme(repository, { id: "asset-safety", name: "Asset Safety" });
  const fixtureRoot = path.dirname(repository.themesRoot);
  const symlinkPath = path.join(fixtureRoot, "linked.png");
  const textPath = path.join(fixtureRoot, "asset.txt");
  const badPngPath = path.join(fixtureRoot, "bad.png");
  const oversizedPath = path.join(fixtureRoot, "oversized.png");
  await fs.symlink(IMAGE_PATH, symlinkPath);
  await fs.writeFile(textPath, "not an image");
  await fs.writeFile(badPngPath, "not a png");
  await fs.writeFile(oversizedPath, "x");
  await fs.truncate(oversizedPath, MAX_ART_BYTES + 1);

  for (const [imagePath, code] of [
    ["relative.png", "INVALID_ASSET_PATH"],
    [path.join(fixtureRoot, "missing.png"), "ASSET_NOT_FOUND"],
    [fixtureRoot, "INVALID_ASSET_PATH"],
    [symlinkPath, "INVALID_ASSET_PATH"],
    [textPath, "INVALID_IMAGE"],
    [badPngPath, "INVALID_IMAGE"],
    [oversizedPath, "ASSET_TOO_LARGE"],
  ]) {
    await assert.rejects(
      repository.write({
        id: "asset-safety",
        imagePath,
        expectedRevision: created.afterRevision,
        themePatch: {},
      }),
      (error) => error.code === code,
      imagePath,
    );
  }
  assert.equal((await repository.read("asset-safety")).revision, created.afterRevision);
});

test("theme repository rejects arbitrary fields and executable CSS values", async (t) => {
  const repository = await repositoryFixture(t);
  await assert.rejects(() => repository.write({
    id: "unsafe-theme",
    themePatch: { css: ":root { color: red }" },
  }), (error) => error.code === "INVALID_THEME_PATCH");

  await assert.rejects(() => repository.validate({
    theme: {
      schemaVersion: 1,
      id: "safe-theme",
      image: "background.png",
      states: { tooltipBackground: "url(file:///secret)" },
    },
  }), (error) => error.code === "THEME_INVALID" && error.details.fields.includes("theme.states.tooltipBackground"));

  await assert.rejects(() => repository.write({
    id: "unsafe-theme",
    themePatch: { visual: { motif: "custom-css-profile" } },
  }), (error) => error.code === "THEME_INVALID" && error.details.fields.includes("theme.visual.motif"));
});

test("theme repository rejects theme assets and directories that escape through symbolic links", {
  skip: process.platform === "win32",
}, async (t) => {
  const repository = await repositoryFixture(t);
  await repository.ensureRoots();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));

  const themeDir = repository.themePath("linked-assets");
  await fs.mkdir(themeDir, { recursive: true });
  await fs.writeFile(path.join(themeDir, "theme.json"), JSON.stringify({
    schemaVersion: 1,
    id: "linked-assets",
    image: "background.png",
  }));
  const outsideImage = path.join(outside, "outside.png");
  await fs.copyFile(path.join(ROOT, "themes", "paper-aurora", "background.png"), outsideImage);
  await fs.symlink(outsideImage, path.join(themeDir, "background.png"));
  await assert.rejects(
    () => repository.read("linked-assets"),
    (error) => error.code === "THEME_INVALID" && /symbolic link/.test(error.message),
  );

  await fs.rm(path.join(themeDir, "background.png"));
  await fs.copyFile(outsideImage, path.join(themeDir, "background.png"));
  const outsideCss = path.join(outside, "outside.css");
  await fs.writeFile(outsideCss, ":root { --linked: true; }");
  await fs.symlink(outsideCss, path.join(themeDir, "skin.css"));
  await assert.rejects(
    () => repository.read("linked-assets"),
    (error) => error.code === "THEME_INVALID" && /symbolic link/.test(error.message),
  );

  const outsideTheme = path.join(outside, "linked-theme");
  await fs.mkdir(outsideTheme);
  await fs.writeFile(path.join(outsideTheme, "theme.json"), JSON.stringify({
    schemaVersion: 1,
    id: "linked-theme",
    image: "background.png",
  }));
  await fs.copyFile(outsideImage, path.join(outsideTheme, "background.png"));
  await fs.symlink(outsideTheme, repository.themePath("linked-theme"));
  await assert.rejects(
    () => repository.read("linked-theme"),
    (error) => error.code === "THEME_INVALID" && /symbolic link/.test(error.message),
  );
});

test("rollback rejects a transaction superseded by a later revision", async (t) => {
  const repository = await repositoryFixture(t);
  const first = await writeFixtureTheme(repository, { name: "Revision A" });
  const second = await writeFixtureTheme(repository, {
    name: "Revision B",
    expectedRevision: first.afterRevision,
  });
  const third = await writeFixtureTheme(repository, {
    name: "Revision C",
    expectedRevision: second.afterRevision,
  });

  await assert.rejects(
    () => repository.rollback(second.transactionId),
    (error) => error.code === "ROLLBACK_CONFLICT"
      && error.details.expectedRevision === second.afterRevision
      && error.details.actualRevision === third.afterRevision,
  );
  const current = await repository.read("agent-fixture");
  assert.equal(current.theme.name, "Revision C");
  assert.equal(current.revision, third.afterRevision);
});

test("rollback rejects a deleted theme transaction after the same id is recreated", async (t) => {
  const repository = await repositoryFixture(t);
  const original = await writeFixtureTheme(repository, { name: "Original Theme" });
  const deleted = await repository.delete("agent-fixture", { expectedRevision: original.afterRevision });
  const recreated = await writeFixtureTheme(repository, { name: "Recreated Theme" });

  await assert.rejects(
    () => repository.rollback(deleted.transactionId),
    (error) => error.code === "ROLLBACK_CONFLICT"
      && error.details.expectedRevision === null
      && error.details.actualRevision === recreated.afterRevision,
  );
  const current = await repository.read("agent-fixture");
  assert.equal(current.theme.name, "Recreated Theme");
  assert.equal(current.revision, recreated.afterRevision);
});

test("write preserves both artifacts when install and retired-theme restoration renames fail", async (t) => {
  const repository = await repositoryFixture(t);
  const original = await writeFixtureTheme(repository, { name: "Stable Theme" });
  const targetPath = repository.themePath("agent-fixture");

  repository.fs = fileSystemWithFaults({
    rename(source, destination) {
      return destination === targetPath
        && (/\.stage-/.test(path.basename(source)) || /\.retired-/.test(path.basename(source)));
    },
  });

  let failedTransaction;
  await assert.rejects(
    () => writeFixtureTheme(repository, {
      name: "Candidate Theme",
      expectedRevision: original.afterRevision,
    }),
    (error) => {
      failedTransaction = error.details.transactionId;
      return error.code === "THEME_WRITE_RECOVERY_REQUIRED";
    },
  );

  const stagePath = path.join(repository.themesRoot, `.agent-fixture.stage-${failedTransaction}`);
  const retiredPath = path.join(repository.themesRoot, `.agent-fixture.retired-${failedTransaction}`);
  assert.equal(await exists(targetPath), false);
  assert.equal(await exists(stagePath), true);
  assert.equal(await exists(retiredPath), true);

  repository.fs = fs;
  await repository.ensureRoots();
  const recovered = await repository.read("agent-fixture");
  assert.equal(recovered.theme.name, "Stable Theme");
  assert.equal(recovered.revision, original.afterRevision);
  assert.equal(await exists(stagePath), false);
  assert.equal(await exists(retiredPath), false);
  assert.ok((await fs.readdir(repository.recoveryRoot)).some((entry) => entry.includes(".stage-")));
});

test("rollback preserves both artifacts when install and retired-theme restoration renames fail", async (t) => {
  const repository = await repositoryFixture(t);
  const original = await writeFixtureTheme(repository, { name: "Revision A" });
  const updated = await writeFixtureTheme(repository, {
    name: "Revision B",
    expectedRevision: original.afterRevision,
  });
  const targetPath = repository.themePath("agent-fixture");

  repository.fs = fileSystemWithFaults({
    rename(source, destination) {
      return destination === targetPath
        && (/\.rollback-/.test(path.basename(source)) || /\.retired-/.test(path.basename(source)));
    },
  });

  await assert.rejects(
    () => repository.rollback(updated.transactionId),
    (error) => error.code === "ROLLBACK_RECOVERY_REQUIRED",
  );
  const stagePath = path.join(repository.themesRoot, `.agent-fixture.rollback-${updated.transactionId}`);
  const retiredPath = path.join(repository.themesRoot, `.agent-fixture.retired-${updated.transactionId}`);
  assert.equal(await exists(targetPath), false);
  assert.equal(await exists(stagePath), true);
  assert.equal(await exists(retiredPath), true);

  repository.fs = fs;
  await repository.ensureRoots();
  const recovered = await repository.read("agent-fixture");
  assert.equal(recovered.theme.name, "Revision B");
  assert.equal(recovered.revision, updated.afterRevision);
  assert.equal(await exists(stagePath), false);
  assert.equal(await exists(retiredPath), false);
});

test("retired cleanup failures quarantine the old copy without undoing a committed write", async (t) => {
  const repository = await repositoryFixture(t);
  const original = await writeFixtureTheme(repository, { name: "Revision A" });

  repository.fs = fileSystemWithFaults({
    rm(filePath) {
      return /\.agent-fixture\.retired-/.test(path.basename(filePath));
    },
  });
  const updated = await writeFixtureTheme(repository, {
    name: "Revision B",
    expectedRevision: original.afterRevision,
  });

  repository.fs = fs;
  const current = await repository.read("agent-fixture");
  assert.equal(current.theme.name, "Revision B");
  assert.equal(current.revision, updated.afterRevision);
  assert.equal(
    (await fs.readdir(repository.themesRoot)).some((entry) => /\.agent-fixture\.retired-/.test(entry)),
    false,
  );
  assert.ok((await fs.readdir(repository.recoveryRoot)).some((entry) => entry.includes(".retired-")));
});

test("startup recovery fails closed when a residual artifact conflicts with a newer live revision", async (t) => {
  const repository = await repositoryFixture(t);
  const first = await writeFixtureTheme(repository, { name: "Revision A" });
  const second = await writeFixtureTheme(repository, {
    name: "Revision B",
    expectedRevision: first.afterRevision,
  });
  const third = await writeFixtureTheme(repository, {
    name: "Revision C",
    expectedRevision: second.afterRevision,
  });
  const ambiguousRetired = path.join(
    repository.themesRoot,
    `.agent-fixture.retired-${second.transactionId}`,
  );
  await fs.cp(
    path.join(repository.backupsRoot, second.transactionId, "theme"),
    ambiguousRetired,
    { recursive: true, errorOnExist: true },
  );

  await assert.rejects(
    () => repository.ensureRoots(),
    (error) => error.code === "REPOSITORY_RECOVERY_REQUIRED"
      && error.details.currentRevision === third.afterRevision,
  );
  assert.equal(await exists(ambiguousRetired), true);
  const current = await repository.read("agent-fixture");
  assert.equal(current.theme.name, "Revision C");
  assert.equal(current.revision, third.afterRevision);
});
