import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  defaultMacReleaseArtifacts,
  MAC_RELEASE_COMMANDS,
  parseArm64Architecture,
  parseDeveloperIdSignature,
  parseMacReleaseArguments,
  runMacReleaseVerifier,
  verifyMacRelease,
} from "../scripts/verify-macos-release.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID_SIGNATURE = [
  "Executable=/release/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio",
  "Identifier=com.dreamskin.studio",
  "Format=app bundle with Mach-O thin (arm64)",
  "Authority=Developer ID Application: DreamSkin Contributors (TEAM123456)",
  "Authority=Developer ID Certification Authority",
  "Authority=Apple Root CA",
  "TeamIdentifier=TEAM123456",
  "flags=0x10000(runtime)",
  "Runtime Version=15.0.0",
].join("\n");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function releaseFixture(t, {
  dmgContents = "notarized dmg\n",
  zipContents = "notarized zip\n",
  includeDmg = true,
  includeZip = true,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-release-verifier-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const artifacts = {
    app: path.join(root, "mac-arm64", "DreamSkin Studio.app"),
    dmg: path.join(root, "DreamSkin-Studio-0.3.0-mac-arm64.dmg"),
    zip: path.join(root, "DreamSkin-Studio-0.3.0-mac-arm64.zip"),
  };
  await fs.mkdir(path.join(artifacts.app, "Contents", "MacOS"), { recursive: true });
  await fs.writeFile(path.join(artifacts.app, "Contents", "MacOS", "DreamSkin Studio"), "mach-o");
  if (includeDmg) await fs.writeFile(artifacts.dmg, dmgContents);
  if (includeZip) await fs.writeFile(artifacts.zip, zipContents);
  return { artifacts, dmgContents, zipContents, root };
}

function fakeRunner({
  signature = VALID_SIGNATURE,
  bundleExecutable = "DreamSkin Studio",
  architectures = "arm64",
  failAt = -1,
} = {}) {
  const calls = [];
  return {
    calls,
    runner: {
      async run(command, args, options) {
        const index = calls.length;
        calls.push({ command, args: [...args], options: { ...options } });
        if (index === failAt) {
          const error = new Error(`command ${index} failed`);
          error.stdout = "partial stdout";
          error.stderr = "verification rejected";
          throw error;
        }
        if (command === MAC_RELEASE_COMMANDS.codesign && args[0] === "-dv") {
          return { stdout: "", stderr: signature };
        }
        if (command === MAC_RELEASE_COMMANDS.plutil) {
          return { stdout: `${bundleExecutable}\n`, stderr: "" };
        }
        if (command === MAC_RELEASE_COMMANDS.lipo) {
          return { stdout: `${architectures}\n`, stderr: "" };
        }
        if (command === MAC_RELEASE_COMMANDS.ditto && args[0] === "-x") {
          await fs.mkdir(path.join(args[3], "DreamSkin Studio.app"), { recursive: true });
        }
        return { stdout: "accepted", stderr: "" };
      },
    },
  };
}

test("default macOS release artifacts resolve the arm64 app, DMG, and ZIP", () => {
  const projectRoot = path.resolve("/workspace/dreamskin");
  const artifacts = defaultMacReleaseArtifacts({
    projectRoot,
    packageManifest: {
      name: "trae-dream-skin",
      version: "0.3.0",
      build: {
        productName: "DreamSkin Studio",
        artifactName: "DreamSkin-Studio-${version}-${os}-${arch}.${ext}",
        directories: { output: "dist-desktop" },
      },
    },
  });
  assert.deepEqual(artifacts, {
    app: path.join(projectRoot, "dist-desktop", "mac-arm64", "DreamSkin Studio.app"),
    dmg: path.join(projectRoot, "dist-desktop", "DreamSkin-Studio-0.3.0-mac-arm64.dmg"),
    zip: path.join(projectRoot, "dist-desktop", "DreamSkin-Studio-0.3.0-mac-arm64.zip"),
  });
});

test("release verification runs every macOS trust check without a shell and hashes artifacts", async (t) => {
  const fixture = await releaseFixture(t);
  const fake = fakeRunner();
  const result = await verifyMacRelease({
    artifacts: fixture.artifacts,
    runner: fake.runner,
    platform: "darwin",
  });
  const executablePath = path.join(
    fixture.artifacts.app,
    "Contents",
    "MacOS",
    "DreamSkin Studio",
  );

  assert.deepEqual(fake.calls.slice(0, 10).map(({ command, args }) => ({ command, args })), [
    {
      command: MAC_RELEASE_COMMANDS.codesign,
      args: ["-dv", "--verbose=4", fixture.artifacts.app],
    },
    {
      command: MAC_RELEASE_COMMANDS.plutil,
      args: [
        "-extract",
        "CFBundleExecutable",
        "raw",
        "-o",
        "-",
        path.join(fixture.artifacts.app, "Contents", "Info.plist"),
      ],
    },
    {
      command: MAC_RELEASE_COMMANDS.lipo,
      args: ["-archs", executablePath],
    },
    {
      command: MAC_RELEASE_COMMANDS.codesign,
      args: ["--verify", "--deep", "--strict", "--verbose=4", fixture.artifacts.app],
    },
    {
      command: MAC_RELEASE_COMMANDS.spctl,
      args: ["--assess", "--type", "execute", "--verbose=4", fixture.artifacts.app],
    },
    {
      command: MAC_RELEASE_COMMANDS.xcrun,
      args: ["stapler", "validate", fixture.artifacts.app],
    },
    {
      command: MAC_RELEASE_COMMANDS.hdiutil,
      args: ["verify", fixture.artifacts.dmg],
    },
    {
      command: MAC_RELEASE_COMMANDS.spctl,
      args: [
        "--assess",
        "--type",
        "open",
        "--context",
        "context:primary-signature",
        "--verbose=4",
        fixture.artifacts.dmg,
      ],
    },
    {
      command: MAC_RELEASE_COMMANDS.xcrun,
      args: ["stapler", "validate", fixture.artifacts.dmg],
    },
    {
      command: MAC_RELEASE_COMMANDS.unzip,
      args: ["-t", fixture.artifacts.zip],
    },
  ]);
  const extraction = fake.calls[10];
  assert.equal(extraction.command, MAC_RELEASE_COMMANDS.ditto);
  assert.deepEqual(extraction.args.slice(0, 3), ["-x", "-k", fixture.artifacts.zip]);
  const zipApp = path.join(extraction.args[3], "DreamSkin Studio.app");
  assert.deepEqual(fake.calls.slice(11).map(({ command, args }) => ({ command, args })), [
    {
      command: MAC_RELEASE_COMMANDS.codesign,
      args: ["--verify", "--deep", "--strict", "--verbose=4", zipApp],
    },
    {
      command: MAC_RELEASE_COMMANDS.spctl,
      args: ["--assess", "--type", "execute", "--verbose=4", zipApp],
    },
    {
      command: MAC_RELEASE_COMMANDS.xcrun,
      args: ["stapler", "validate", zipApp],
    },
  ]);
  assert.equal(fake.calls.every((call) => call.options.shell === false), true);
  assert.equal(result.ok, true);
  assert.equal(result.app.authority, "Developer ID Application: DreamSkin Contributors (TEAM123456)");
  assert.equal(result.app.teamIdentifier, "TEAM123456");
  assert.equal(result.app.hardenedRuntime, true);
  assert.equal(result.app.executablePath, executablePath);
  assert.equal(result.app.notarizationTicket, "valid");
  assert.equal(result.architecture, "arm64");
  assert.deepEqual(result.artifacts.dmg, {
    path: fixture.artifacts.dmg,
    bytes: Buffer.byteLength(fixture.dmgContents),
    sha256: sha256(fixture.dmgContents),
    gatekeeper: "accepted",
    notarizationTicket: "valid",
  });
  assert.deepEqual(result.artifacts.zip, {
    path: fixture.artifacts.zip,
    bytes: Buffer.byteLength(fixture.zipContents),
    sha256: sha256(fixture.zipContents),
    appName: "DreamSkin Studio.app",
    codesign: "valid",
    gatekeeper: "accepted",
    notarizationTicket: "valid",
  });
});

test("ad-hoc, non-Developer-ID, and mismatched-team signatures are rejected", async (t) => {
  const fixture = await releaseFixture(t);
  const invalidSignatures = [
    [
      "Signature=adhoc",
      "TeamIdentifier=not set",
      "flags=0x2(adhoc)",
    ].join("\n"),
    [
      "Authority=Apple Development: DreamSkin Contributors (TEAM123456)",
      "TeamIdentifier=TEAM123456",
    ].join("\n"),
    [
      "Authority=Developer ID Application: DreamSkin Contributors (OTHERTEAM1)",
      "TeamIdentifier=TEAM123456",
    ].join("\n"),
  ];

  for (const signature of invalidSignatures) {
    const fake = fakeRunner({ signature });
    await assert.rejects(
      verifyMacRelease({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
      (error) => error.code === "MAC_RELEASE_SIGNATURE_INVALID",
    );
    assert.equal(fake.calls.length, 1);
  }
});

test("a Developer ID signature without the hardened runtime flag is rejected", async (t) => {
  const fixture = await releaseFixture(t);
  const signature = VALID_SIGNATURE
    .split("\n")
    .filter((line) => !line.startsWith("flags="))
    .join("\n");
  const fake = fakeRunner({ signature });
  await assert.rejects(
    verifyMacRelease({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
    (error) => error.code === "MAC_RELEASE_HARDENED_RUNTIME_MISSING"
      && error.details.hardenedRuntime === false,
  );
  assert.equal(fake.calls.length, 1);
});

test("release architecture inspection accepts only a thin arm64 main executable", async (t) => {
  assert.equal(parseArm64Architecture("arm64\n", "/release/app"), "arm64");
  for (const architectures of ["x86_64", "x86_64 arm64", ""]) {
    const fixture = await releaseFixture(t);
    const fake = fakeRunner({ architectures });
    await assert.rejects(
      verifyMacRelease({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
      (error) => error.code === "MAC_RELEASE_ARCHITECTURE_INVALID"
        && error.details.path.endsWith("/Contents/MacOS/DreamSkin Studio"),
    );
    assert.equal(fake.calls.length, 3);
  }
});

test("bundle executable and architecture command failures block the release", async (t) => {
  const cases = [
    { failAt: 1, code: "MAC_RELEASE_EXECUTABLE_INSPECTION_FAILED" },
    { failAt: 2, code: "MAC_RELEASE_ARCHITECTURE_INSPECTION_FAILED" },
  ];
  for (const entry of cases) {
    const fixture = await releaseFixture(t);
    const fake = fakeRunner(entry);
    await assert.rejects(
      verifyMacRelease({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
      (error) => error.code === entry.code
        && error.details.stderr === "verification rejected",
    );
    assert.equal(fake.calls.length, entry.failAt + 1);
  }
});

test("missing or empty notarized artifacts fail before trust commands run", async (t) => {
  const missing = await releaseFixture(t, { includeZip: false });
  const missingRunner = fakeRunner();
  await assert.rejects(
    verifyMacRelease({ artifacts: missing.artifacts, runner: missingRunner.runner, platform: "darwin" }),
    (error) => error.code === "MAC_RELEASE_ARTIFACT_MISSING"
      && error.details.type === "zip",
  );
  assert.equal(missingRunner.calls.length, 0);

  const empty = await releaseFixture(t, { dmgContents: "" });
  const emptyRunner = fakeRunner();
  await assert.rejects(
    verifyMacRelease({ artifacts: empty.artifacts, runner: emptyRunner.runner, platform: "darwin" }),
    (error) => error.code === "MAC_RELEASE_ARTIFACT_INVALID"
      && error.details.type === "dmg",
  );
  assert.equal(emptyRunner.calls.length, 0);
});

test("codesign, Gatekeeper, and stapler failures each block the release", async (t) => {
  const cases = [
    { failAt: 3, code: "MAC_RELEASE_CODESIGN_FAILED" },
    { failAt: 4, code: "MAC_RELEASE_GATEKEEPER_FAILED" },
    { failAt: 5, code: "MAC_RELEASE_NOTARIZATION_FAILED" },
  ];
  for (const entry of cases) {
    const fixture = await releaseFixture(t);
    const fake = fakeRunner(entry);
    await assert.rejects(
      verifyMacRelease({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
      (error) => error.code === entry.code
        && error.details.stderr === "verification rejected",
    );
    assert.equal(fake.calls.length, entry.failAt + 1);
  }
});

test("invalid DMG, DMG trust, and ZIP containers each block the release", async (t) => {
  const cases = [
    { failAt: 6, code: "MAC_RELEASE_DMG_VERIFICATION_FAILED" },
    { failAt: 7, code: "MAC_RELEASE_DMG_GATEKEEPER_FAILED" },
    { failAt: 8, code: "MAC_RELEASE_DMG_NOTARIZATION_FAILED" },
    { failAt: 9, code: "MAC_RELEASE_ZIP_VERIFICATION_FAILED" },
  ];
  for (const entry of cases) {
    const fixture = await releaseFixture(t);
    const fake = fakeRunner(entry);
    await assert.rejects(
      verifyMacRelease({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
      (error) => error.code === entry.code
        && error.details.stderr === "verification rejected",
    );
    assert.equal(fake.calls.length, entry.failAt + 1);
  }
});

test("ZIP app extraction, signature, Gatekeeper, and stapler failures block the release", async (t) => {
  const cases = [
    { failAt: 10, code: "MAC_RELEASE_ZIP_EXTRACTION_FAILED" },
    { failAt: 11, code: "MAC_RELEASE_ZIP_CODESIGN_FAILED" },
    { failAt: 12, code: "MAC_RELEASE_ZIP_GATEKEEPER_FAILED" },
    { failAt: 13, code: "MAC_RELEASE_ZIP_NOTARIZATION_FAILED" },
  ];
  for (const entry of cases) {
    const fixture = await releaseFixture(t);
    const fake = fakeRunner(entry);
    await assert.rejects(
      verifyMacRelease({ artifacts: fixture.artifacts, runner: fake.runner, platform: "darwin" }),
      (error) => error.code === entry.code
        && error.details.stderr === "verification rejected",
    );
    assert.equal(fake.calls.length, entry.failAt + 1);
  }
});

test("signature inspection failure and non-macOS execution cannot pass", async (t) => {
  const fixture = await releaseFixture(t);
  const failedInspection = fakeRunner({ failAt: 0 });
  await assert.rejects(
    verifyMacRelease({ artifacts: fixture.artifacts, runner: failedInspection.runner, platform: "darwin" }),
    (error) => error.code === "MAC_RELEASE_SIGNATURE_INSPECTION_FAILED",
  );
  await assert.rejects(
    verifyMacRelease({ artifacts: fixture.artifacts, runner: fakeRunner().runner, platform: "linux" }),
    (error) => error.code === "MAC_RELEASE_PLATFORM_UNSUPPORTED",
  );
});

test("CLI argument parsing resolves paths and rejects duplicate or unknown flags", () => {
  const cwd = path.resolve("/workspace");
  assert.deepEqual(
    parseMacReleaseArguments([
      "--project-root", "project",
      "--app=release/DreamSkin Studio.app",
      "--dmg", "release/app.dmg",
      "--zip=release/app=final.zip",
    ], { cwd }),
    {
      projectRoot: path.join(cwd, "project"),
      app: path.join(cwd, "release", "DreamSkin Studio.app"),
      dmg: path.join(cwd, "release", "app.dmg"),
      zip: path.join(cwd, "release", "app=final.zip"),
    },
  );
  assert.throws(
    () => parseMacReleaseArguments(["--app", "one", "--app", "two"]),
    (error) => error.code === "MAC_RELEASE_ARGUMENT_INVALID",
  );
  assert.throws(
    () => parseMacReleaseArguments(["--shell-command", "codesign"]),
    (error) => error.code === "MAC_RELEASE_ARGUMENT_INVALID",
  );
});

test("CLI defaults are derived from package metadata and remain runner-injectable", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-release-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const packageManifest = {
    name: "trae-dream-skin",
    version: "9.8.7",
    build: {
      productName: "DreamSkin Studio",
      artifactName: "DreamSkin-Studio-${version}-${os}-${arch}.${ext}",
      directories: { output: "release" },
    },
  };
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(packageManifest));
  const artifacts = defaultMacReleaseArtifacts({ projectRoot: root, packageManifest });
  await fs.mkdir(path.join(artifacts.app, "Contents", "MacOS"), { recursive: true });
  await fs.writeFile(path.join(artifacts.app, "Contents", "MacOS", "DreamSkin Studio"), "mach-o");
  await fs.writeFile(artifacts.dmg, "dmg");
  await fs.writeFile(artifacts.zip, "zip");
  const fake = fakeRunner();

  const result = await runMacReleaseVerifier(["--project-root", root], {
    runner: fake.runner,
    platform: "darwin",
    cwd: "/",
  });
  assert.equal(result.app.path, artifacts.app);
  assert.equal(result.artifacts.dmg.path, artifacts.dmg);
  assert.equal(result.artifacts.zip.path, artifacts.zip);
});

test("package scripts run the verifier after the signed notarized build", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.scripts["desktop:verify:mac"], "node ./scripts/verify-macos-release.mjs");
  assert.match(
    manifest.scripts["desktop:release:mac"],
    /electron-builder --mac --arm64 --publish never .*&& npm run desktop:verify:mac && npm run desktop:verify:installed -- --screenshot dist-desktop\/installed-smoke\.png$/,
  );
});

test("signature parser accepts a valid Developer ID identity", () => {
  assert.deepEqual(parseDeveloperIdSignature(VALID_SIGNATURE), {
    authority: "Developer ID Application: DreamSkin Contributors (TEAM123456)",
    teamIdentifier: "TEAM123456",
    hardenedRuntime: true,
  });
});
