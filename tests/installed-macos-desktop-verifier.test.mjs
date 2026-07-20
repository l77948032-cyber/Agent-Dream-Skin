import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INSTALLED_DESKTOP_COMMANDS,
  parseInstalledDesktopArguments,
  verifyInstalledMacDesktop,
} from "../scripts/verify-installed-macos-desktop.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-installed-verifier-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dmgPath = path.join(root, "DreamSkin.dmg");
  await fs.writeFile(dmgPath, "dmg");
  return { root, dmgPath };
}

function fakeDependencies({ failCopy = false, failPackaged = false } = {}) {
  const calls = [];
  const packagedCalls = [];
  let detached = false;
  const runner = {
    async run(command, args) {
      calls.push([command, [...args]]);
      if (command === INSTALLED_DESKTOP_COMMANDS.hdiutil && args[0] === "attach") {
        const mountPoint = args.at(-1);
        await fs.mkdir(path.join(mountPoint, "DreamSkin Studio.app", "Contents"), { recursive: true });
      }
      if (command === INSTALLED_DESKTOP_COMMANDS.ditto) {
        if (failCopy) throw new Error("copy failed");
        await fs.cp(args[0], args[1], { recursive: true });
      }
      if (command === INSTALLED_DESKTOP_COMMANDS.hdiutil && args[0] === "detach") detached = true;
      return { stdout: "", stderr: "" };
    },
  };
  return {
    calls,
    dependencies: {
      platform: "darwin",
      runner,
      async verifyPackaged(options) {
        assert.equal(detached, true, "DMG must be detached before the copied application starts");
        packagedCalls.push({ ...options });
        if (failPackaged) throw new Error("packaged smoke failed");
        assert.match(options.appPath, /Applications\/DreamSkin Studio\.app$/);
        return {
          title: "DreamSkin Studio",
          packaged: true,
          info: {
            appVersion: "0.3.0",
            runtimeVersions: {
              "dreamskin.trae": "0.3.0",
              "dreamskin.workbuddy": "0.3.0",
            },
            resourcesVerified: true,
          },
        };
      },
    },
    packagedCalls,
  };
}

test("installed verifier copies, detaches, verifies and starts the DMG application", async (t) => {
  const { dmgPath } = await fixture(t);
  const fake = fakeDependencies();
  const result = await verifyInstalledMacDesktop({ dmgPath, screenshotPath: "/tmp/smoke.png" }, fake.dependencies);
  assert.equal(result.ok, true);
  assert.equal(result.installation.detachedBeforeLaunch, true);
  assert.equal(result.installation.restartVerified, true);
  assert.equal(result.packaged.title, "DreamSkin Studio");
  assert.equal(result.restart.appVersion, "0.3.0");
  assert.equal(result.restart.resourcesVerified, true);
  assert.equal(fake.packagedCalls.length, 2);
  assert.equal(fake.packagedCalls[0].dataRoot, fake.packagedCalls[1].dataRoot);
  assert.equal(fake.packagedCalls[0].screenshotPath, "/tmp/smoke.png");
  assert.equal(fake.packagedCalls[1].screenshotPath, undefined);
  assert.equal(fake.packagedCalls[1].runAgent, false);
  assert.deepEqual(fake.calls.map(([command, args]) => [path.basename(command), args[0]]), [
    ["hdiutil", "attach"],
    ["ditto", fake.calls[1][1][0]],
    ["hdiutil", "detach"],
    ["codesign", "--verify"],
  ]);
});

test("installed verifier cleans up a mounted image after copy failure", async (t) => {
  const { dmgPath } = await fixture(t);
  const fake = fakeDependencies({ failCopy: true });
  await assert.rejects(
    verifyInstalledMacDesktop({ dmgPath }, fake.dependencies),
    (error) => error.code === "MAC_INSTALLED_COPY_FAILED",
  );
  const detachCalls = fake.calls.filter(([command, args]) => (
    command === INSTALLED_DESKTOP_COMMANDS.hdiutil && args[0] === "detach"
  ));
  assert.equal(detachCalls.length, 1);
});

test("installed verifier propagates a copied application startup failure", async (t) => {
  const { dmgPath } = await fixture(t);
  const fake = fakeDependencies({ failPackaged: true });
  await assert.rejects(verifyInstalledMacDesktop({ dmgPath }, fake.dependencies), /packaged smoke failed/);
});

test("installed verifier refuses unsupported platforms before mounting", async (t) => {
  const { dmgPath } = await fixture(t);
  await assert.rejects(
    verifyInstalledMacDesktop({ dmgPath }, { platform: "win32" }),
    (error) => error.code === "MAC_INSTALLED_PLATFORM_UNSUPPORTED",
  );
});

test("installed verifier parses path and agent options", () => {
  assert.deepEqual(
    parseInstalledDesktopArguments([
      "--project-root=project",
      "--dmg",
      "release/DreamSkin.dmg",
      "--screenshot",
      "artifacts/installed.png",
      "--with-agent",
      "--agent",
      "codex",
    ], { cwd: "/repo" }),
    {
      runAgent: true,
      agentId: "codex",
      projectRoot: "/repo/project",
      dmgPath: "/repo/release/DreamSkin.dmg",
      screenshotPath: "/repo/artifacts/installed.png",
    },
  );
});
