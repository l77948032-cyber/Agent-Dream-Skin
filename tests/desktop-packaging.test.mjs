import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_FUSE_CONFIG,
  hardenMacInfoPlist,
  packagedExecutablePath,
  UNUSED_MAC_PRIVACY_KEYS,
} from "../scripts/after-pack.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("desktop packaging defines every current Electron fuse explicitly", () => {
  assert.equal(DESKTOP_FUSE_CONFIG.strictlyRequireAllFuses, true);
  assert.deepEqual(Object.keys(DESKTOP_FUSE_CONFIG).sort(), [
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "strictlyRequireAllFuses", "version",
  ]);
  assert.equal(DESKTOP_FUSE_CONFIG[0], true);
  assert.equal(DESKTOP_FUSE_CONFIG[2], false);
  assert.equal(DESKTOP_FUSE_CONFIG[3], false);
  assert.equal(DESKTOP_FUSE_CONFIG[4], true);
  assert.equal(DESKTOP_FUSE_CONFIG[5], true);
  assert.equal(DESKTOP_FUSE_CONFIG[7], false);
  assert.equal(DESKTOP_FUSE_CONFIG[8], false);
});

test("macOS packaging removes broad ATS and unused privacy declarations", async () => {
  const calls = [];
  await hardenMacInfoPlist("/build/DreamSkin Studio.app/Contents/Info.plist", {
    run: async (command, args) => calls.push({ command, args }),
  });
  assert.equal(calls.length, UNUSED_MAC_PRIVACY_KEYS.length + 1);
  assert.equal(calls.every((call) => call.command === "/usr/libexec/PlistBuddy"), true);
  assert.deepEqual(calls.map((call) => call.args[1]), [
    "Delete :NSAppTransportSecurity",
    ...UNUSED_MAC_PRIVACY_KEYS.map((key) => `Delete :${key}`),
  ]);
});

test("packaging resolves the platform executable without shell interpolation", () => {
  const base = {
    appOutDir: "/build/mac-arm64",
    packager: { appInfo: { productFilename: "DreamSkin Studio" } },
  };
  assert.equal(packagedExecutablePath({ ...base, electronPlatformName: "darwin" }), path.join(base.appOutDir, "DreamSkin Studio.app"));
  assert.equal(packagedExecutablePath({ ...base, electronPlatformName: "win32" }), path.join(base.appOutDir, "DreamSkin Studio.exe"));
  assert.equal(packagedExecutablePath({ ...base, electronPlatformName: "linux" }), path.join(base.appOutDir, "DreamSkin Studio"));
});

test("macOS packaging provides a branded drag-to-Applications installer", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));

  assert.equal(manifest.build.productName, "DreamSkin Studio");
  assert.equal(manifest.build.mac.icon, "desktop/assets/icon.icns");
  assert.deepEqual(manifest.build.mac.target, ["dmg", "zip"]);
  assert.deepEqual(manifest.build.dmg.window, { width: 660, height: 420 });
  assert.equal(manifest.build.dmg.iconSize, 128);
  assert.deepEqual(manifest.build.dmg.contents, [
    { x: 180, y: 205, type: "file" },
    { x: 480, y: 205, type: "link", path: "/Applications" },
  ]);
});

test("desktop package metadata and release channel belong to the current repository", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));

  assert.equal(manifest.author.name, "l77948032-cyber");
  assert.match(manifest.repository.url, /l77948032-cyber\/Agent-Dream-Skin/);
  assert.deepEqual(manifest.build.publish, {
    provider: "github",
    owner: "l77948032-cyber",
    repo: "Agent-Dream-Skin",
    channel: "latest",
    releaseType: "release",
  });
  assert.match(manifest.scripts["desktop:installer:mac"], /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.match(manifest.scripts["desktop:installer:mac"], /desktop:verify:installer/);
  assert.match(manifest.scripts["desktop:installer:mac"], /desktop:verify:installed -- --screenshot dist-desktop\/installed-smoke\.png$/);
  assert.match(manifest.scripts["desktop:release:mac"], /electron-builder --mac --arm64 --publish never/);
  assert.match(manifest.scripts["desktop:release:mac"], /desktop:verify:installed -- --screenshot dist-desktop\/installed-smoke\.png$/);
  assert.equal(manifest.dependencies["electron-updater"], "^6.8.9");
  assert.equal(manifest.build.generateUpdatesFilesForAllChannels, undefined);
});

test("macOS release workflow publishes only the stable latest channel after draft validation", async () => {
  const source = await fs.readFile(path.join(PROJECT_ROOT, ".github", "workflows", "release-macos.yml"), "utf8");
  assert.match(source, /dist-desktop\/latest-mac\.yml/);
  assert.match(source, /dist-desktop\/\*\.dmg\.blockmap/);
  assert.match(source, /dist-desktop\/\*\.zip\.blockmap/);
  assert.match(source, /docs\/releases\/\$\{GITHUB_REF_NAME\}\.md/);
  assert.match(source, /--notes-file/);
  assert.match(source, /--generate-notes/);
  assert.match(source, /only publishes stable versions with latest-mac\.yml/);
  assert.match(source, /--prerelease=false/);
  assert.doesNotMatch(source, /steps\.release\.outputs\.prerelease/);
  const createDraft = source.indexOf("Create draft GitHub Release");
  const validateAssets = source.indexOf("Validate draft release assets");
  const publishRelease = source.indexOf("Publish verified GitHub Release");
  assert.equal(createDraft > 0, true);
  assert.equal(validateAssets > createDraft, true);
  assert.equal(publishRelease > validateAssets, true);
});

test("macOS release workflow rebuilds an existing draft but refuses to replace a published release", async () => {
  const source = await fs.readFile(path.join(PROJECT_ROOT, ".github", "workflows", "release-macos.yml"), "utf8");
  const inspectExisting = source.indexOf("existing_release=\"$(gh release view");
  const rejectPublished = source.indexOf("is already published; refusing to replace it");
  const deleteDraft = source.indexOf("gh release delete");
  const createDraft = source.indexOf("release create \"${GITHUB_REF_NAME}\"");
  assert.equal(inspectExisting > 0, true);
  assert.equal(rejectPublished > inspectExisting, true);
  assert.equal(deleteDraft > rejectPublished, true);
  assert.equal(createDraft > deleteDraft, true);
  assert.match(source, /gh release delete "\$\{GITHUB_REF_NAME\}" --repo "\$\{GITHUB_REPOSITORY\}" --yes/);
  assert.match(source, /release not found\|HTTP 404/);
});
