import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  configureDesktopProductIdentity,
  DESKTOP_PRODUCT_NAME,
  LEGACY_MIGRATION_MARKER,
  migrateLegacyDreamSkinData,
} from "../desktop/product-identity.mjs";

async function temporaryRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-product-identity-"));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function library(pluginId, ids) {
  return {
    schemaVersion: 1,
    settings: { autoVerify: true, motionEnabled: true, selectedAgentId: "codex" },
    entries: ids.map((id) => ({ id, pluginId, origin: "template" })),
  };
}

test("desktop product identity uses the public product name for user data", () => {
  const calls = [];
  const result = configureDesktopProductIdentity({
    app: {
      getPath: (name) => ({
        appData: "/Users/test/Library/Application Support",
        home: "/Users/test",
      })[name],
      setName: (name) => calls.push(["name", name]),
      setPath: (name, value) => calls.push(["path", name, value]),
    },
  });
  assert.equal(DESKTOP_PRODUCT_NAME, "DreamSkin Studio");
  assert.equal(result.userDataPath, "/Users/test/Library/Application Support/DreamSkin Studio");
  assert.equal(result.legacyUserDataPath, "/Users/test/Library/Application Support/trae-dream-skin");
  assert.equal(result.legacyStudioPath, "/Users/test/.dreamskin");
  assert.equal(result.migrationEnabled, true);
  assert.deepEqual(calls, [
    ["name", "DreamSkin Studio"],
    ["path", "userData", "/Users/test/Library/Application Support/DreamSkin Studio"],
  ]);
});

test("desktop product identity preserves an explicit verifier user-data directory", () => {
  const calls = [];
  const result = configureDesktopProductIdentity({
    app: {
      commandLine: { hasSwitch: (name) => name === "user-data-dir" },
      getPath: (name) => ({
        appData: "/Users/test/Library/Application Support",
        home: "/Users/test",
        userData: "/private/tmp/dreamskin-packaged-e2e",
      })[name],
      setName: (name) => calls.push(["name", name]),
      setPath: (name, value) => calls.push(["path", name, value]),
    },
  });

  assert.equal(result.userDataPath, "/private/tmp/dreamskin-packaged-e2e");
  assert.equal(result.migrationEnabled, false);
  assert.deepEqual(calls, [["name", "DreamSkin Studio"]]);
});

test("legacy Electron data migration preserves authored data but never copies bundled runtime", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "trae-dream-skin");
  const current = path.join(root, "DreamSkin Studio");
  const oldProduct = path.join(legacy, "dreamskin");
  await fs.mkdir(path.join(oldProduct, "themes", "dreamskin.trae", "theme-a"), { recursive: true });
  await fs.writeFile(path.join(oldProduct, "themes", "dreamskin.trae", "theme-a", "theme.json"), "preserved");
  await writeJson(path.join(oldProduct, "state", "dreamskin.trae", "library.json"), library("dreamskin.trae", ["theme-a"]));
  await fs.mkdir(path.join(oldProduct, "runtime", "dreamskin.trae", "versions", "0.2.0"), { recursive: true });
  await fs.writeFile(path.join(oldProduct, "runtime", "dreamskin.trae", "versions", "0.2.0", "old"), "stale");

  const result = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacy,
    userDataPath: current,
    migrationId: "test",
  });
  assert.equal(result.migrated, true);
  assert.equal(
    await fs.readFile(path.join(current, "dreamskin", "themes", "dreamskin.trae", "theme-a", "theme.json"), "utf8"),
    "preserved",
  );
  await assert.rejects(fs.access(path.join(current, "dreamskin", "runtime")), { code: "ENOENT" });
  const marker = JSON.parse(await fs.readFile(path.join(current, "dreamskin", LEGACY_MIGRATION_MARKER), "utf8"));
  assert.equal(marker.status, "completed");
  assert.equal(marker.copied.themes, 1);
});

test("legacy Electron ACP state backups merge into the new backup root without overwriting", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "legacy");
  const current = path.join(root, "current");
  const oldProduct = path.join(legacy, "dreamskin");
  const destinationBackups = path.join(current, "dreamskin", "backups", "dreamskin.trae");

  await fs.mkdir(path.join(oldProduct, "backups", "dreamskin.trae", "root-only"), { recursive: true });
  await fs.writeFile(
    path.join(oldProduct, "backups", "dreamskin.trae", "root-only", "recovery.json"),
    "root backup",
  );
  await fs.mkdir(path.join(oldProduct, "state", "dreamskin.trae", "backups", "state-only"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(oldProduct, "state", "dreamskin.trae", "backups", "state-only", "recovery.json"),
    "state backup",
  );
  await fs.mkdir(path.join(oldProduct, "state", "dreamskin.trae", "backups", "shared"), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(oldProduct, "state", "dreamskin.trae", "backups", "shared", "recovery.json"),
    "legacy shared",
  );
  await fs.mkdir(path.join(destinationBackups, "shared"), { recursive: true });
  await fs.writeFile(path.join(destinationBackups, "shared", "recovery.json"), "current shared");

  const result = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacy,
    userDataPath: current,
    migrationId: "state-backups",
  });

  assert.equal(result.copied.backups, 2);
  assert.equal(
    await fs.readFile(path.join(destinationBackups, "root-only", "recovery.json"), "utf8"),
    "root backup",
  );
  assert.equal(
    await fs.readFile(path.join(destinationBackups, "state-only", "recovery.json"), "utf8"),
    "state backup",
  );
  assert.equal(
    await fs.readFile(path.join(destinationBackups, "shared", "recovery.json"), "utf8"),
    "current shared",
  );
  assert.ok(result.completedOperations.includes("legacy-electron:dreamskin.trae:backups"));
  assert.ok(result.completedOperations.includes("legacy-electron:dreamskin.trae:state-backups"));
});

test("legacy Web Studio data is converted and merged with current target libraries", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacyElectron = path.join(root, "old-electron");
  const legacyWeb = path.join(root, ".dreamskin");
  const current = path.join(root, "DreamSkin Studio");
  await fs.mkdir(path.join(legacyWeb, "themes", "trae-old"), { recursive: true });
  await fs.writeFile(path.join(legacyWeb, "themes", "trae-old", "theme.json"), "trae");
  await fs.mkdir(path.join(legacyWeb, "themes", "dreamskin.workbuddy", "work-old"), { recursive: true });
  await fs.writeFile(path.join(legacyWeb, "themes", "dreamskin.workbuddy", "work-old", "theme.json"), "workbuddy");
  await writeJson(path.join(legacyWeb, "library.json"), library("dreamskin.trae", ["trae-old"]));
  await writeJson(
    path.join(legacyWeb, "libraries", "dreamskin.workbuddy.json"),
    library("dreamskin.workbuddy", ["work-old"]),
  );
  await fs.mkdir(path.join(current, "dreamskin", "themes", "dreamskin.trae", "current-theme"), { recursive: true });
  await writeJson(
    path.join(current, "dreamskin", "state", "dreamskin.trae", "library.json"),
    library("dreamskin.trae", ["current-theme"]),
  );

  const result = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacyElectron,
    legacyStudioPath: legacyWeb,
    userDataPath: current,
    migrationId: "web-test",
  });
  assert.equal(result.copied.themes, 2);
  const traeLibrary = JSON.parse(await fs.readFile(
    path.join(current, "dreamskin", "state", "dreamskin.trae", "library.json"),
    "utf8",
  ));
  assert.deepEqual(traeLibrary.entries.map((entry) => entry.id), ["current-theme", "trae-old"]);
  const workBuddyLibrary = JSON.parse(await fs.readFile(
    path.join(current, "dreamskin", "state", "dreamskin.workbuddy", "library.json"),
    "utf8",
  ));
  assert.deepEqual(workBuddyLibrary.entries.map((entry) => entry.id), ["work-old"]);
  await assert.doesNotReject(fs.access(path.join(
    current,
    "dreamskin",
    "themes",
    "dreamskin.workbuddy",
    "work-old",
    "theme.json",
  )));
  await assert.rejects(fs.access(path.join(
    current,
    "dreamskin",
    "themes",
    "dreamskin.trae",
    "dreamskin.workbuddy",
  )), { code: "ENOENT" });
});

test("legacy migration never overwrites an existing theme directory", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "legacy");
  const current = path.join(root, "current");
  await fs.mkdir(path.join(legacy, "dreamskin", "themes", "dreamskin.trae", "same"), { recursive: true });
  await fs.mkdir(path.join(current, "dreamskin", "themes", "dreamskin.trae", "same"), { recursive: true });
  await fs.writeFile(path.join(legacy, "dreamskin", "themes", "dreamskin.trae", "same", "theme.json"), "legacy");
  await fs.writeFile(path.join(current, "dreamskin", "themes", "dreamskin.trae", "same", "theme.json"), "current");

  await migrateLegacyDreamSkinData({ legacyUserDataPath: legacy, userDataPath: current });
  assert.equal(
    await fs.readFile(path.join(current, "dreamskin", "themes", "dreamskin.trae", "same", "theme.json"), "utf8"),
    "current",
  );
});

test("legacy migration records completion once when no authored data exists", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const options = {
    legacyUserDataPath: path.join(root, "legacy"),
    legacyStudioPath: path.join(root, ".dreamskin"),
    userDataPath: path.join(root, "current"),
  };
  const first = await migrateLegacyDreamSkinData(options);
  const second = await migrateLegacyDreamSkinData(options);
  assert.equal(first.migrated, false);
  assert.equal(second.migrated, false);
  assert.equal(second.reason, "already-completed");
  assert.equal(second.status, "completed");
});

test("completed migration never resurrects a theme deleted from the new library", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "legacy");
  const current = path.join(root, "current");
  const oldTheme = path.join(legacy, "dreamskin", "themes", "dreamskin.trae", "old-theme");
  await fs.mkdir(oldTheme, { recursive: true });
  await fs.writeFile(path.join(oldTheme, "theme.json"), "legacy");
  await writeJson(
    path.join(legacy, "dreamskin", "state", "dreamskin.trae", "library.json"),
    library("dreamskin.trae", ["old-theme"]),
  );

  const first = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacy,
    userDataPath: current,
    migrationId: "once",
  });
  assert.equal(first.migrated, true);
  const destinationTheme = path.join(current, "dreamskin", "themes", "dreamskin.trae", "old-theme");
  await fs.rm(destinationTheme, { recursive: true, force: true });
  await writeJson(
    path.join(current, "dreamskin", "state", "dreamskin.trae", "library.json"),
    library("dreamskin.trae", []),
  );

  const second = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacy,
    userDataPath: current,
    migrationId: "twice",
  });
  assert.equal(second.reason, "already-completed");
  await assert.rejects(fs.access(destinationTheme), { code: "ENOENT" });
  const currentLibrary = JSON.parse(await fs.readFile(
    path.join(current, "dreamskin", "state", "dreamskin.trae", "library.json"),
    "utf8",
  ));
  assert.deepEqual(currentLibrary.entries, []);
});

test("partial migration retries only failed operations and never resurrects a migrated theme", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "legacy");
  const current = path.join(root, "current");
  const product = path.join(legacy, "dreamskin");
  await fs.mkdir(path.join(product, "themes", "dreamskin.workbuddy", "safe-theme"), { recursive: true });
  await fs.writeFile(
    path.join(product, "themes", "dreamskin.workbuddy", "safe-theme", "theme.json"),
    "safe",
  );
  await fs.mkdir(path.join(product, "state", "dreamskin.trae"), { recursive: true });
  await fs.writeFile(path.join(product, "state", "dreamskin.trae", "library.json"), "{broken");

  const first = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacy,
    userDataPath: current,
    migrationId: "partial",
    now: () => new Date("2026-07-20T12:00:00.000Z"),
  });
  assert.equal(first.status, "partial");
  assert.equal(first.reason, "legacy-data-partially-copied");
  assert.equal(first.copied.themes, 1);
  assert.equal(first.warnings.length, 1);
  assert.equal(first.warnings[0].operation, "dreamskin.trae:library");
  assert.ok(first.completedOperations.includes("legacy-electron:dreamskin.workbuddy:themes"));
  assert.ok(!first.completedOperations.includes("legacy-electron:dreamskin.trae:library"));
  const destinationTheme = path.join(
    current,
    "dreamskin",
    "themes",
    "dreamskin.workbuddy",
    "safe-theme",
  );
  await assert.doesNotReject(fs.access(path.join(destinationTheme, "theme.json")));

  await fs.rm(destinationTheme, { recursive: true, force: true });
  await writeJson(
    path.join(product, "state", "dreamskin.trae", "library.json"),
    library("dreamskin.trae", ["late-library-entry"]),
  );
  const second = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacy,
    userDataPath: current,
    migrationId: "partial-retry",
    now: () => new Date("2026-07-20T12:05:00.000Z"),
  });

  assert.equal(second.status, "completed");
  assert.equal(second.reason, "legacy-data-copied");
  assert.deepEqual(second.copied, {
    themes: 1,
    backups: 0,
    libraryEntries: 1,
    previews: 0,
  });
  await assert.rejects(fs.access(destinationTheme), { code: "ENOENT" });
  const migratedLibrary = JSON.parse(await fs.readFile(
    path.join(current, "dreamskin", "state", "dreamskin.trae", "library.json"),
    "utf8",
  ));
  assert.deepEqual(migratedLibrary.entries.map((entry) => entry.id), ["late-library-entry"]);

  const marker = JSON.parse(await fs.readFile(second.markerPath, "utf8"));
  assert.equal(marker.status, "completed");
  assert.equal(marker.completedAt, "2026-07-20T12:05:00.000Z");
  assert.deepEqual(marker.warnings, []);
  assert.deepEqual(marker.copied, second.copied);
  assert.ok(marker.completedOperations.includes("legacy-electron:dreamskin.workbuddy:themes"));
  assert.ok(marker.completedOperations.includes("legacy-electron:dreamskin.trae:library"));

  const third = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacy,
    userDataPath: current,
    migrationId: "after-completion",
  });
  assert.equal(third.reason, "already-completed");
  await assert.rejects(fs.access(destinationTheme), { code: "ENOENT" });
});

test("partial child copy retries only the failed child and keeps cumulative counts accurate", async (t) => {
  const root = await temporaryRoot();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "legacy");
  const current = path.join(root, "current");
  const sourceThemes = path.join(legacy, "dreamskin", "themes", "dreamskin.trae");
  const destinationThemes = path.join(current, "dreamskin", "themes", "dreamskin.trae");
  for (const id of ["a-migrated", "z-retry"]) {
    await fs.mkdir(path.join(sourceThemes, id), { recursive: true });
    await fs.writeFile(path.join(sourceThemes, id, "theme.json"), id);
  }
  await fs.mkdir(destinationThemes, { recursive: true });
  await fs.writeFile(path.join(destinationThemes, "z-retry"), "blocks the first copy");

  const first = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacy,
    userDataPath: current,
    migrationId: "child-partial",
  });
  assert.equal(first.status, "partial");
  assert.equal(first.copied.themes, 1);
  assert.equal(first.warnings.length, 1);
  assert.equal(first.warnings[0].operation, "dreamskin.trae:themes/z-retry");
  assert.ok(first.completedOperations.includes("legacy-electron:dreamskin.trae:themes/a-migrated"));
  assert.ok(!first.completedOperations.includes("legacy-electron:dreamskin.trae:themes/z-retry"));

  await fs.rm(path.join(destinationThemes, "a-migrated"), { recursive: true, force: true });
  await fs.rm(path.join(destinationThemes, "z-retry"), { force: true });
  const second = await migrateLegacyDreamSkinData({
    legacyUserDataPath: legacy,
    userDataPath: current,
    migrationId: "child-retry",
  });

  assert.equal(second.status, "completed");
  assert.equal(second.copied.themes, 2);
  await assert.rejects(fs.access(path.join(destinationThemes, "a-migrated")), { code: "ENOENT" });
  assert.equal(
    await fs.readFile(path.join(destinationThemes, "z-retry", "theme.json"), "utf8"),
    "z-retry",
  );
});
