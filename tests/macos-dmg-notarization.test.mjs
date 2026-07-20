import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DMG_NOTARIZATION_COMMANDS,
  notarizeMacDmg,
  parseDeveloperIdDmgSignature,
  parseDmgNotarizationArguments,
  parseNotarytoolSubmission,
  resolveNotarytoolCredentials,
} from "../scripts/notarize-macos-dmg.mjs";

const TEAM_ID = "ABCDE12345";
const SIGNATURE = [
  `Authority=Developer ID Application: DreamSkin Studio (${TEAM_ID})`,
  "Authority=Developer ID Certification Authority",
  `TeamIdentifier=${TEAM_ID}`,
].join("\n");

async function dmgFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-dmg-notary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dmgPath = path.join(root, "DreamSkin-Studio-0.3.0-mac-arm64.dmg");
  await fs.writeFile(dmgPath, "test dmg");
  const updateManifestPath = path.join(root, "latest-mac.yml");
  await fs.writeFile(updateManifestPath, [
    "version: 0.3.0",
    "files:",
    "  - url: DreamSkin-Studio-0.3.0-mac-arm64.zip",
    "    sha512: zip-sha512",
    "    size: 16",
    "  - url: DreamSkin-Studio-0.3.0-mac-arm64.dmg",
    "    sha512: stale-dmg-sha512",
    "    size: 1",
    "path: DreamSkin-Studio-0.3.0-mac-arm64.zip",
    "sha512: zip-sha512",
    "",
  ].join("\n"));
  return { root, dmgPath, updateManifestPath };
}

function appleIdEnvironment() {
  return {
    APPLE_ID: "release@example.com",
    APPLE_APP_SPECIFIC_PASSWORD: "secret-password",
    APPLE_TEAM_ID: TEAM_ID,
  };
}

test("DMG notarization verifies Developer ID, staples, and refreshes update metadata", async (t) => {
  const { dmgPath, updateManifestPath } = await dmgFixture(t);
  const calls = [];
  const runner = {
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === DMG_NOTARIZATION_COMMANDS.codesign && args[0] === "-dv") {
        return { stdout: "", stderr: SIGNATURE };
      }
      if (command === DMG_NOTARIZATION_COMMANDS.xcrun && args[0] === "notarytool") {
        return { stdout: JSON.stringify({ id: "11111111-2222-3333-4444-555555555555", status: "Accepted" }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  };

  const result = await notarizeMacDmg({ dmgPath, env: appleIdEnvironment() }, { platform: "darwin", runner });

  assert.equal(result.ok, true);
  assert.equal(result.signature.teamIdentifier, TEAM_ID);
  assert.equal(result.notarization.status, "Accepted");
  assert.equal(result.staple, "valid");
  assert.equal(result.gatekeeper, "accepted");
  assert.equal(result.updateMetadata.size, Buffer.byteLength("test dmg"));
  assert.equal(result.updateMetadata.blockmapPath, `${dmgPath}.blockmap`);
  const refreshedManifest = await fs.readFile(updateManifestPath, "utf8");
  assert.doesNotMatch(refreshedManifest, /stale-dmg-sha512/);
  assert.match(refreshedManifest, new RegExp(`sha512: ${result.updateMetadata.sha512.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal((await fs.stat(`${dmgPath}.blockmap`)).size > 0, true);
  assert.deepEqual(calls.map(({ command, args }) => [command, args.slice(0, 2)]), [
    [DMG_NOTARIZATION_COMMANDS.hdiutil, ["verify", dmgPath]],
    [DMG_NOTARIZATION_COMMANDS.codesign, ["--verify", "--strict"]],
    [DMG_NOTARIZATION_COMMANDS.codesign, ["-dv", "--verbose=4"]],
    [DMG_NOTARIZATION_COMMANDS.xcrun, ["notarytool", "submit"]],
    [DMG_NOTARIZATION_COMMANDS.xcrun, ["stapler", "staple"]],
    [DMG_NOTARIZATION_COMMANDS.xcrun, ["stapler", "validate"]],
    [DMG_NOTARIZATION_COMMANDS.spctl, ["--assess", "--type"]],
    [DMG_NOTARIZATION_COMMANDS.codesign, ["--verify", "--strict"]],
    [DMG_NOTARIZATION_COMMANDS.hdiutil, ["verify", dmgPath]],
  ]);
  const submit = calls.find(({ command, args }) => command === DMG_NOTARIZATION_COMMANDS.xcrun && args[0] === "notarytool");
  assert.deepEqual(submit.args.slice(-3), ["--wait", "--output-format", "json"]);
  assert.ok(submit.args.includes("--apple-id"));
  assert.ok(submit.args.includes("--password"));
  assert.ok(submit.args.includes("--team-id"));
});

test("DMG notarization rejects non-Developer-ID signatures before contacting Apple", async (t) => {
  const { dmgPath } = await dmgFixture(t);
  const calls = [];
  const runner = {
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === DMG_NOTARIZATION_COMMANDS.codesign && args[0] === "-dv") {
        return { stdout: "", stderr: "Signature=adhoc\nTeamIdentifier=not set\n" };
      }
      return { stdout: "", stderr: "" };
    },
  };
  await assert.rejects(
    () => notarizeMacDmg({ dmgPath, env: appleIdEnvironment() }, { platform: "darwin", runner }),
    { code: "DMG_DEVELOPER_ID_SIGNATURE_MISSING" },
  );
  assert.equal(calls.some(({ args }) => args[0] === "notarytool"), false);
});

test("notarytool rejection cannot proceed to staple", async (t) => {
  const { dmgPath } = await dmgFixture(t);
  const calls = [];
  const runner = {
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === DMG_NOTARIZATION_COMMANDS.codesign && args[0] === "-dv") {
        return { stdout: "", stderr: SIGNATURE };
      }
      if (command === DMG_NOTARIZATION_COMMANDS.xcrun && args[0] === "notarytool") {
        return { stdout: JSON.stringify({ id: "submission-id", status: "Invalid" }), stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  };
  await assert.rejects(
    () => notarizeMacDmg({ dmgPath, env: appleIdEnvironment() }, { platform: "darwin", runner }),
    { code: "DMG_NOTARIZATION_REJECTED" },
  );
  assert.equal(calls.some(({ args }) => args[0] === "stapler"), false);
});

test("notarytool command failures redact Apple credentials", async (t) => {
  const { dmgPath } = await dmgFixture(t);
  const environment = appleIdEnvironment();
  const runner = {
    async run(command, args) {
      if (command === DMG_NOTARIZATION_COMMANDS.codesign && args[0] === "-dv") {
        return { stdout: "", stderr: SIGNATURE };
      }
      if (command === DMG_NOTARIZATION_COMMANDS.xcrun && args[0] === "notarytool") {
        const error = new Error("notarytool failed");
        error.stdout = `account ${environment.APPLE_ID}`;
        error.stderr = `password ${environment.APPLE_APP_SPECIFIC_PASSWORD}`;
        throw error;
      }
      return { stdout: "", stderr: "" };
    },
  };
  await assert.rejects(
    () => notarizeMacDmg({ dmgPath, env: environment }, { platform: "darwin", runner }),
    (error) => {
      assert.equal(error.code, "DMG_NOTARIZATION_SUBMISSION_FAILED");
      const diagnostic = JSON.stringify(error.details);
      assert.equal(diagnostic.includes(environment.APPLE_ID), false);
      assert.equal(diagnostic.includes(environment.APPLE_APP_SPECIFIC_PASSWORD), false);
      assert.match(diagnostic, /<redacted>/);
      return true;
    },
  );
});

test("notary credentials require exactly one complete mode", () => {
  assert.throws(
    () => resolveNotarytoolCredentials({ APPLE_ID: "release@example.com" }),
    { code: "DMG_NOTARIZATION_CREDENTIALS_INCOMPLETE" },
  );
  assert.throws(
    () => resolveNotarytoolCredentials({ APPLE_KEYCHAIN: "/secure/release.keychain-db" }),
    { code: "DMG_NOTARIZATION_CREDENTIALS_INCOMPLETE" },
  );
  assert.throws(
    () => resolveNotarytoolCredentials({
      ...appleIdEnvironment(),
      APPLE_KEYCHAIN_PROFILE: "dreamskin-notary",
    }),
    { code: "DMG_NOTARIZATION_CREDENTIALS_INVALID" },
  );
  const apiKey = resolveNotarytoolCredentials({
    APPLE_API_KEY: "/secure/AuthKey.p8",
    APPLE_API_KEY_ID: "KEY123",
    APPLE_API_ISSUER: "issuer-id",
  });
  assert.equal(apiKey.mode, "api-key");
  assert.equal(apiKey.displayArgs.includes("/secure/AuthKey.p8"), false);
  const keychain = resolveNotarytoolCredentials({
    APPLE_KEYCHAIN_PROFILE: "dreamskin-notary",
    APPLE_KEYCHAIN: "/secure/release.keychain-db",
  });
  assert.equal(keychain.mode, "keychain-profile");
});

test("signature, submission, and CLI parsers fail closed", () => {
  assert.deepEqual(parseDeveloperIdDmgSignature(SIGNATURE, { expectedTeamId: TEAM_ID }), {
    authority: `Developer ID Application: DreamSkin Studio (${TEAM_ID})`,
    teamIdentifier: TEAM_ID,
  });
  assert.throws(
    () => parseDeveloperIdDmgSignature(SIGNATURE, { expectedTeamId: "ZZZZZ99999" }),
    { code: "DMG_NOTARIZATION_TEAM_MISMATCH" },
  );
  assert.deepEqual(parseNotarytoolSubmission('{"id":"submission-id","status":"Accepted"}'), {
    id: "submission-id",
    status: "Accepted",
  });
  assert.throws(() => parseNotarytoolSubmission("not json"), { code: "DMG_NOTARIZATION_RESPONSE_INVALID" });
  assert.deepEqual(parseDmgNotarizationArguments([
    "--dmg=release.dmg",
    "--project-root",
    "project",
  ], { cwd: "/tmp" }), {
    dmgPath: "/tmp/release.dmg",
    projectRoot: "/tmp/project",
  });
  assert.throws(() => parseDmgNotarizationArguments(["--unknown"]), {
    code: "DMG_NOTARIZATION_ARGUMENT_INVALID",
  });
});

test("desktop release signs and notarizes the final DMG before strict verification", async () => {
  const manifest = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  const release = manifest.scripts["desktop:release:mac"];
  assert.equal(manifest.build.dmg.sign, true);
  assert.equal(manifest.scripts["desktop:notarize:dmg"], "node ./scripts/notarize-macos-dmg.mjs");
  assert.match(
    release,
    /electron-builder[^&]+&& npm run desktop:notarize:dmg && npm run desktop:verify:packaged/,
  );
  assert.ok(release.indexOf("desktop:notarize:dmg") < release.indexOf("desktop:verify:mac"));
  assert.match(await fs.readFile(new URL("../scripts/notarize-macos-dmg.mjs", import.meta.url), "utf8"), /refreshDmgUpdateMetadata/);
});
