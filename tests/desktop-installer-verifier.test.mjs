import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  defaultMacInstallerArtifacts,
  MAC_INSTALLER_COMMANDS,
  parseMacInstallerArguments,
  runMacInstallerVerifier,
  verifyMacInstaller,
} from "../scripts/verify-macos-installer.mjs";

const APP_NAME = "DreamSkin Studio.app";
const DEFAULT_IDENTITY = Object.freeze({
  bundleIdentifier: "com.dreamskin.studio",
  version: "0.2.0",
  buildVersion: "0.2.0",
  codeDirectoryIdentifier: "com.dreamskin.studio",
  cdHash: "0123456789abcdef0123456789abcdef01234567",
  signature: "ad-hoc",
});

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function writeApp(appPath) {
  await fs.mkdir(path.join(appPath, "Contents"), { recursive: true });
  await fs.writeFile(path.join(appPath, "Contents", "Info.plist"), "fixture\n");
}

async function installerFixture(t, {
  dmgContents = "dmg payload\n",
  zipContents = "zip payload\n",
  includeApp = true,
  includeDmg = true,
  includeZip = true,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-installer-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifacts = {
    app: path.join(root, "mac-arm64", APP_NAME),
    dmg: path.join(root, "DreamSkin-Studio-0.2.0-mac-arm64.dmg"),
    zip: path.join(root, "DreamSkin-Studio-0.2.0-mac-arm64.zip"),
  };
  await fs.mkdir(path.dirname(artifacts.app), { recursive: true });
  if (includeApp) await writeApp(artifacts.app);
  if (includeDmg) await fs.writeFile(artifacts.dmg, dmgContents);
  if (includeZip) await fs.writeFile(artifacts.zip, zipContents);
  return { artifacts, dmgContents, zipContents, root };
}

function roleForPath(target) {
  if (target.includes(`${path.sep}dmg${path.sep}`)) return "dmg";
  if (target.includes(`${path.sep}zip${path.sep}`)) return "zip";
  return "unpacked";
}

function signatureOutput(identity) {
  const signatureLines = identity.signature === "ad-hoc"
    ? ["Signature=adhoc", "TeamIdentifier=not set", "flags=0x2(adhoc)"]
    : [
        "Authority=Developer ID Application: DreamSkin Contributors (TEAM123456)",
        "TeamIdentifier=TEAM123456",
      ];
  return [
    `Identifier=${identity.codeDirectoryIdentifier}`,
    "CodeDirectory v=20500 size=1337 flags=0x2(adhoc) hashes=1+7 location=embedded",
    `CDHash=${identity.cdHash}`,
    ...signatureLines,
  ].join("\n");
}

function fakeInstallerRunner({
  identities = {},
  applicationsTarget = "/Applications",
  applicationsEntry = "symlink",
  fail = () => false,
} = {}) {
  const calls = [];
  const temporaryRoots = [];
  const identityFor = (target) => Object.freeze({
    ...DEFAULT_IDENTITY,
    ...(identities[roleForPath(target)] || {}),
  });
  return {
    calls,
    temporaryRoots,
    runner: {
      async run(command, args, options) {
        const call = { command, args: [...args], options: { ...options } };
        calls.push(call);
        if (fail(call, calls.length - 1)) {
          const error = new Error("fixture command failed");
          error.stdout = "partial output";
          error.stderr = "fixture rejection";
          throw error;
        }

        if (command === MAC_INSTALLER_COMMANDS.hdiutil && args[0] === "attach") {
          const mountPoint = args[args.indexOf("-mountpoint") + 1];
          temporaryRoots.push(path.dirname(mountPoint));
          await writeApp(path.join(mountPoint, APP_NAME));
          const applicationsPath = path.join(mountPoint, "Applications");
          if (applicationsEntry === "symlink") {
            await fs.symlink(applicationsTarget, applicationsPath);
          } else if (applicationsEntry === "directory") {
            await fs.mkdir(applicationsPath);
          }
          return { stdout: "/dev/disk42 mounted", stderr: "" };
        }
        if (command === MAC_INSTALLER_COMMANDS.unzip && args[0] === "-q") {
          const zipRoot = args[args.indexOf("-d") + 1];
          await writeApp(path.join(zipRoot, APP_NAME));
          return { stdout: "", stderr: "" };
        }
        if (command === MAC_INSTALLER_COMMANDS.codesign && args[0] === "-dv") {
          const appPath = args.at(-1);
          return { stdout: "", stderr: signatureOutput(identityFor(appPath)) };
        }
        if (command === MAC_INSTALLER_COMMANDS.plutil) {
          const infoPath = args.at(-1);
          const appPath = path.dirname(path.dirname(infoPath));
          const identity = identityFor(appPath);
          return {
            stdout: JSON.stringify({
              CFBundleIdentifier: identity.bundleIdentifier,
              CFBundleShortVersionString: identity.version,
              CFBundleVersion: identity.buildVersion,
            }),
            stderr: "",
          };
        }
        return { stdout: "accepted", stderr: "" };
      },
    },
  };
}

test("default installer paths come from the package metadata for macOS arm64", () => {
  const projectRoot = path.resolve("/workspace/dreamskin");
  assert.deepEqual(defaultMacInstallerArtifacts({
    projectRoot,
    packageManifest: {
      name: "trae-dream-skin",
      version: "3.4.5",
      build: {
        productName: "DreamSkin Studio",
        artifactName: "DreamSkin-Studio-${version}-${os}-${arch}.${ext}",
        directories: { output: "desktop-output" },
      },
    },
  }), {
    app: path.join(projectRoot, "desktop-output", "mac-arm64", APP_NAME),
    dmg: path.join(projectRoot, "desktop-output", "DreamSkin-Studio-3.4.5-mac-arm64.dmg"),
    zip: path.join(projectRoot, "desktop-output", "DreamSkin-Studio-3.4.5-mac-arm64.zip"),
  });
});

test("an ad-hoc installer verifies every app copy, layout, containers, and hashes", async (t) => {
  const fixture = await installerFixture(t);
  const fake = fakeInstallerRunner();
  const result = await verifyMacInstaller({
    artifacts: fixture.artifacts,
    runner: fake.runner,
    platform: "darwin",
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.payload, {
    bundleIdentifier: DEFAULT_IDENTITY.bundleIdentifier,
    version: DEFAULT_IDENTITY.version,
    buildVersion: DEFAULT_IDENTITY.buildVersion,
    codeDirectoryIdentifier: DEFAULT_IDENTITY.codeDirectoryIdentifier,
    cdHash: DEFAULT_IDENTITY.cdHash,
    signature: "ad-hoc",
    authority: null,
    teamIdentifier: null,
  });
  assert.equal(result.apps.unpacked.codesign, "valid");
  assert.equal(result.apps.dmg.codesign, "valid");
  assert.equal(result.apps.zip.codesign, "valid");
  assert.deepEqual(result.installer.applicationsLink, { target: "/Applications" });
  assert.deepEqual(result.artifacts.dmg, {
    path: fixture.artifacts.dmg,
    bytes: Buffer.byteLength(fixture.dmgContents),
    sha256: sha256(fixture.dmgContents),
  });
  assert.deepEqual(result.artifacts.zip, {
    path: fixture.artifacts.zip,
    bytes: Buffer.byteLength(fixture.zipContents),
    sha256: sha256(fixture.zipContents),
  });

  const codesignChecks = fake.calls.filter(({ command, args }) => (
    command === MAC_INSTALLER_COMMANDS.codesign && args[0] === "--verify"
  ));
  assert.equal(codesignChecks.length, 3);
  assert.equal(fake.calls.some(({ command, args }) => (
    command === MAC_INSTALLER_COMMANDS.hdiutil
      && args[0] === "verify"
      && args[1] === fixture.artifacts.dmg
  )), true);
  assert.equal(fake.calls.some(({ command, args }) => (
    command === MAC_INSTALLER_COMMANDS.unzip
      && args[0] === "-t"
      && args[1] === fixture.artifacts.zip
  )), true);
  assert.equal(fake.calls.some(({ command, args }) => (
    command === MAC_INSTALLER_COMMANDS.hdiutil && args[0] === "detach"
  )), true);
  assert.equal(fake.calls.every(({ options }) => options.shell === false), true);
  assert.equal(fake.temporaryRoots.length, 1);
  await assert.rejects(fs.access(fake.temporaryRoots[0]), { code: "ENOENT" });
});

test("a Developer ID signed installer is accepted without weakening signature checks", async (t) => {
  const fixture = await installerFixture(t);
  const signedIdentity = {
    signature: "signed",
    cdHash: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
  };
  const fake = fakeInstallerRunner({
    identities: {
      unpacked: signedIdentity,
      dmg: signedIdentity,
      zip: signedIdentity,
    },
  });
  const result = await verifyMacInstaller({
    artifacts: fixture.artifacts,
    runner: fake.runner,
    platform: "darwin",
  });
  assert.equal(result.payload.signature, "signed");
  assert.equal(
    result.payload.authority,
    "Developer ID Application: DreamSkin Contributors (TEAM123456)",
  );
  assert.equal(result.payload.teamIdentifier, "TEAM123456");
});

test("DMG and ZIP payload metadata must exactly match the unpacked app", async (t) => {
  const cases = [
    {
      role: "dmg",
      field: "bundleIdentifier",
      overrides: {
        bundleIdentifier: "com.example.impostor",
        codeDirectoryIdentifier: "com.example.impostor",
      },
    },
    { role: "dmg", field: "version", value: "99.0.0" },
    { role: "zip", field: "buildVersion", value: "999" },
    { role: "zip", field: "cdHash", value: "ffffffffffffffffffffffffffffffffffffffff" },
  ];
  for (const entry of cases) {
    await t.test(`${entry.role} ${entry.field}`, async (t2) => {
      const fixture = await installerFixture(t2);
      const fake = fakeInstallerRunner({
        identities: {
          [entry.role]: entry.overrides || { [entry.field]: entry.value },
        },
      });
      await assert.rejects(
        verifyMacInstaller({
          artifacts: fixture.artifacts,
          runner: fake.runner,
          platform: "darwin",
        }),
        (error) => error.code === "MAC_INSTALLER_PAYLOAD_MISMATCH"
          && error.details.mismatches.some(({ field }) => field === entry.field),
      );
      assert.equal(fake.calls.some(({ command, args }) => (
        command === MAC_INSTALLER_COMMANDS.hdiutil && args[0] === "detach"
      )), true);
      await assert.rejects(fs.access(fake.temporaryRoots[0]), { code: "ENOENT" });
    });
  }
});

test("the CodeDirectory identifier must agree with Info.plist before comparison", async (t) => {
  const fixture = await installerFixture(t);
  const fake = fakeInstallerRunner({
    identities: { unpacked: { codeDirectoryIdentifier: "com.example.wrong-signature" } },
  });
  await assert.rejects(
    verifyMacInstaller({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
    (error) => error.code === "MAC_INSTALLER_SIGNATURE_INVALID",
  );
  assert.equal(fake.calls.some(({ command }) => command === MAC_INSTALLER_COMMANDS.hdiutil), false);
});

test("the DMG must contain a real app and an exact /Applications symlink", async (t) => {
  for (const setup of [
    { applicationsTarget: "../Applications", applicationsEntry: "symlink" },
    { applicationsTarget: "/Applications", applicationsEntry: "directory" },
  ]) {
    const fixture = await installerFixture(t);
    const fake = fakeInstallerRunner(setup);
    await assert.rejects(
      verifyMacInstaller({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
      (error) => error.code === "MAC_INSTALLER_DMG_LAYOUT_INVALID",
    );
    assert.equal(fake.calls.some(({ command, args }) => (
      command === MAC_INSTALLER_COMMANDS.hdiutil && args[0] === "detach"
    )), true);
  }
});

test("verification failures after mounting always detach and remove temporary payloads", async (t) => {
  const fixture = await installerFixture(t);
  const fake = fakeInstallerRunner({
    fail: ({ command, args }) => command === MAC_INSTALLER_COMMANDS.codesign
      && args[0] === "--verify"
      && args.at(-1).includes(`${path.sep}dmg${path.sep}`),
  });
  await assert.rejects(
    verifyMacInstaller({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
    (error) => error.code === "MAC_INSTALLER_CODESIGN_FAILED"
      && error.details.stderr === "fixture rejection",
  );
  assert.equal(fake.calls.some(({ command, args }) => (
    command === MAC_INSTALLER_COMMANDS.hdiutil && args[0] === "detach"
  )), true);
  await assert.rejects(fs.access(fake.temporaryRoots[0]), { code: "ENOENT" });
});

test("a detach failure blocks an otherwise valid installer and still removes temp files", async (t) => {
  const fixture = await installerFixture(t);
  const fake = fakeInstallerRunner({
    fail: ({ command, args }) => command === MAC_INSTALLER_COMMANDS.hdiutil
      && args[0] === "detach",
  });
  await assert.rejects(
    verifyMacInstaller({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
    (error) => error.code === "MAC_INSTALLER_CLEANUP_FAILED"
      && error.details.cleanupErrors[0].code === "MAC_INSTALLER_DMG_DETACH_FAILED",
  );
  await assert.rejects(fs.access(fake.temporaryRoots[0]), { code: "ENOENT" });
});

test("missing, empty, and incorrectly typed artifacts fail before commands run", async (t) => {
  const missing = await installerFixture(t, { includeZip: false });
  const missingRunner = fakeInstallerRunner();
  await assert.rejects(
    verifyMacInstaller({
      artifacts: missing.artifacts,
      runner: missingRunner.runner,
      platform: "darwin",
    }),
    (error) => error.code === "MAC_INSTALLER_ARTIFACT_MISSING"
      && error.details.type === "zip",
  );
  assert.equal(missingRunner.calls.length, 0);

  const empty = await installerFixture(t, { dmgContents: "" });
  const emptyRunner = fakeInstallerRunner();
  await assert.rejects(
    verifyMacInstaller({
      artifacts: empty.artifacts,
      runner: emptyRunner.runner,
      platform: "darwin",
    }),
    (error) => error.code === "MAC_INSTALLER_ARTIFACT_INVALID"
      && error.details.type === "dmg",
  );
  assert.equal(emptyRunner.calls.length, 0);

  const wrongType = await installerFixture(t, { includeDmg: false });
  await fs.mkdir(wrongType.artifacts.dmg);
  const wrongTypeRunner = fakeInstallerRunner();
  await assert.rejects(
    verifyMacInstaller({
      artifacts: wrongType.artifacts,
      runner: wrongTypeRunner.runner,
      platform: "darwin",
    }),
    (error) => error.code === "MAC_INSTALLER_ARTIFACT_INVALID"
      && error.details.type === "dmg",
  );
  assert.equal(wrongTypeRunner.calls.length, 0);
});

test("non-macOS execution and invalid runners are rejected", async () => {
  await assert.rejects(
    verifyMacInstaller({ platform: "linux" }),
    (error) => error.code === "MAC_INSTALLER_PLATFORM_UNSUPPORTED",
  );
  await assert.rejects(
    verifyMacInstaller({ platform: "darwin", runner: {} }),
    (error) => error.code === "MAC_INSTALLER_RUNNER_INVALID",
  );
});

test("CLI argument parsing resolves overrides and rejects unsafe ambiguity", () => {
  const cwd = path.resolve("/workspace");
  assert.deepEqual(parseMacInstallerArguments([
    "--project-root", "project",
    "--app=release/DreamSkin Studio.app",
    "--dmg", "release/app.dmg",
    "--zip=release/app=final.zip",
  ], { cwd }), {
    projectRoot: path.join(cwd, "project"),
    app: path.join(cwd, "release", APP_NAME),
    dmg: path.join(cwd, "release", "app.dmg"),
    zip: path.join(cwd, "release", "app=final.zip"),
  });
  assert.throws(
    () => parseMacInstallerArguments(["--app", "one", "--app=two"]),
    (error) => error.code === "MAC_INSTALLER_ARGUMENT_INVALID",
  );
  assert.throws(
    () => parseMacInstallerArguments(["--app"]),
    (error) => error.code === "MAC_INSTALLER_ARGUMENT_INVALID",
  );
  assert.throws(
    () => parseMacInstallerArguments(["--shell-command", "codesign"]),
    (error) => error.code === "MAC_INSTALLER_ARGUMENT_INVALID",
  );
});

test("CLI defaults use package metadata and keep the command runner injectable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-installer-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageManifest = {
    name: "trae-dream-skin",
    version: "7.8.9",
    build: {
      productName: "DreamSkin Studio",
      artifactName: "DreamSkin-Studio-${version}-${os}-${arch}.${ext}",
      directories: { output: "release" },
    },
  };
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(packageManifest));
  const artifacts = defaultMacInstallerArtifacts({ projectRoot: root, packageManifest });
  await writeApp(artifacts.app);
  await fs.writeFile(artifacts.dmg, "cli dmg\n");
  await fs.writeFile(artifacts.zip, "cli zip\n");
  const fake = fakeInstallerRunner();

  const result = await runMacInstallerVerifier(["--project-root", root], {
    runner: fake.runner,
    platform: "darwin",
    cwd: "/",
  });
  assert.equal(result.apps.unpacked.path, artifacts.app);
  assert.equal(result.artifacts.dmg.path, artifacts.dmg);
  assert.equal(result.artifacts.zip.path, artifacts.zip);
});
