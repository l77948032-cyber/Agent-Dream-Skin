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
    releaseType: "release",
  });
  assert.match(manifest.scripts["desktop:installer:mac"], /CSC_IDENTITY_AUTO_DISCOVERY=false/);
  assert.match(manifest.scripts["desktop:installer:mac"], /desktop:verify:installer$/);
});
