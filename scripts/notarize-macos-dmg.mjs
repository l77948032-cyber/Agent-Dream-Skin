import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const require = createRequire(import.meta.url);
const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap");
const yaml = require("js-yaml");
const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
export const DMG_NOTARIZATION_COMMANDS = Object.freeze({
  codesign: "/usr/bin/codesign",
  hdiutil: "/usr/bin/hdiutil",
  spctl: "/usr/sbin/spctl",
  xcrun: "/usr/bin/xcrun",
});

export const defaultCommandRunner = Object.freeze({
  run(command, args, options) {
    return execFile(command, args, options);
  },
});

export class DmgNotarizationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DmgNotarizationError";
    this.code = code;
    this.details = details;
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_ARGUMENT_INVALID",
      `${label} must be a non-empty string.`,
      { label },
    );
  }
  return value.trim();
}

async function requireRegularFile(target, label) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_ARTIFACT_MISSING",
      `${label} is missing.`,
      { path: target },
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_ARTIFACT_INVALID",
      `${label} must be a non-empty regular file.`,
      { path: target },
    );
  }
}

function credentialValue(env, name) {
  const value = env?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function completeCredentialMode(env, names) {
  const values = names.map((name) => credentialValue(env, name));
  const present = values.filter(Boolean).length;
  if (present === 0) return null;
  if (present !== names.length) {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_CREDENTIALS_INCOMPLETE",
      `Apple notarization credentials are incomplete for ${names.join(", ")}.`,
      { required: names },
    );
  }
  return Object.fromEntries(names.map((name, index) => [name, values[index]]));
}

export function resolveNotarytoolCredentials(env = process.env) {
  const apiKey = completeCredentialMode(env, ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]);
  const appleId = completeCredentialMode(env, ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]);
  const keychainProfileName = credentialValue(env, "APPLE_KEYCHAIN_PROFILE");
  if (credentialValue(env, "APPLE_KEYCHAIN") && !keychainProfileName) {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_CREDENTIALS_INCOMPLETE",
      "APPLE_KEYCHAIN requires APPLE_KEYCHAIN_PROFILE.",
      { required: ["APPLE_KEYCHAIN_PROFILE"] },
    );
  }
  const keychain = keychainProfileName
    ? {
        APPLE_KEYCHAIN_PROFILE: keychainProfileName,
        APPLE_KEYCHAIN: credentialValue(env, "APPLE_KEYCHAIN"),
      }
    : null;
  const modes = [apiKey && "api-key", appleId && "apple-id", keychain && "keychain-profile"].filter(Boolean);
  if (modes.length !== 1) {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_CREDENTIALS_INVALID",
      "Configure exactly one complete Apple notarization credential mode.",
      { configuredModes: modes },
    );
  }

  if (apiKey) {
    return Object.freeze({
      mode: "api-key",
      expectedTeamId: null,
      args: Object.freeze([
        "--key", apiKey.APPLE_API_KEY,
        "--key-id", apiKey.APPLE_API_KEY_ID,
        "--issuer", apiKey.APPLE_API_ISSUER,
      ]),
      displayArgs: Object.freeze([
        "--key", "<redacted>",
        "--key-id", "<redacted>",
        "--issuer", "<redacted>",
      ]),
      sensitiveValues: Object.freeze(Object.values(apiKey)),
    });
  }
  if (appleId) {
    return Object.freeze({
      mode: "apple-id",
      expectedTeamId: appleId.APPLE_TEAM_ID,
      args: Object.freeze([
        "--apple-id", appleId.APPLE_ID,
        "--password", appleId.APPLE_APP_SPECIFIC_PASSWORD,
        "--team-id", appleId.APPLE_TEAM_ID,
      ]),
      displayArgs: Object.freeze([
        "--apple-id", "<redacted>",
        "--password", "<redacted>",
        "--team-id", appleId.APPLE_TEAM_ID,
      ]),
      sensitiveValues: Object.freeze([appleId.APPLE_ID, appleId.APPLE_APP_SPECIFIC_PASSWORD]),
    });
  }
  const args = ["--keychain-profile", keychain.APPLE_KEYCHAIN_PROFILE];
  const displayArgs = ["--keychain-profile", "<redacted>"];
  const sensitiveValues = [keychain.APPLE_KEYCHAIN_PROFILE];
  if (keychain.APPLE_KEYCHAIN) {
    args.push("--keychain", keychain.APPLE_KEYCHAIN);
    displayArgs.push("--keychain", "<redacted>");
    sensitiveValues.push(keychain.APPLE_KEYCHAIN);
  }
  return Object.freeze({
    mode: "keychain-profile",
    expectedTeamId: null,
    args: Object.freeze(args),
    displayArgs: Object.freeze(displayArgs),
    sensitiveValues: Object.freeze(sensitiveValues),
  });
}

function requireUpdateManifest(value, manifestPath, dmgName) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.files)) {
    throw new DmgNotarizationError(
      "DMG_UPDATE_METADATA_INVALID",
      "latest-mac.yml must contain an update manifest with a files array.",
      { manifestPath },
    );
  }
  const matches = value.files.filter((entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry) && entry.url === dmgName
  ));
  if (matches.length !== 1) {
    throw new DmgNotarizationError(
      "DMG_UPDATE_METADATA_INVALID",
      "latest-mac.yml must contain exactly one entry for the release DMG.",
      { manifestPath, dmgName, matches: matches.length },
    );
  }
  return { manifest: value, entry: matches[0] };
}

export async function refreshDmgUpdateMetadata(dmgPath, {
  blockMapBuilder = buildBlockMap,
} = {}) {
  const resolvedDmg = path.resolve(requireText(dmgPath, "dmgPath"));
  await requireRegularFile(resolvedDmg, "release DMG");
  const outputRoot = path.dirname(resolvedDmg);
  const dmgName = path.basename(resolvedDmg);
  const manifestPath = path.join(outputRoot, "latest-mac.yml");
  const blockmapPath = `${resolvedDmg}.blockmap`;
  await requireRegularFile(manifestPath, "macOS update manifest");

  const nonce = `${process.pid}-${Date.now()}`;
  const temporaryBlockmap = `${blockmapPath}.tmp-${nonce}`;
  const temporaryManifest = `${manifestPath}.tmp-${nonce}`;
  try {
    let document;
    try {
      document = yaml.load(await fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new DmgNotarizationError(
        "DMG_UPDATE_METADATA_INVALID",
        "latest-mac.yml could not be parsed.",
        { manifestPath, reason: error.message },
      );
    }
    const { manifest, entry } = requireUpdateManifest(document, manifestPath, dmgName);
    const updateInfo = await blockMapBuilder(resolvedDmg, "gzip", temporaryBlockmap);
    if (
      !updateInfo
      || typeof updateInfo.sha512 !== "string"
      || !updateInfo.sha512.trim()
      || !Number.isSafeInteger(updateInfo.size)
      || updateInfo.size <= 0
    ) {
      throw new DmgNotarizationError(
        "DMG_UPDATE_METADATA_INVALID",
        "The DMG blockmap builder returned invalid update metadata.",
        { blockmapPath },
      );
    }

    entry.sha512 = updateInfo.sha512;
    entry.size = updateInfo.size;
    if (manifest.path === dmgName) {
      manifest.sha512 = updateInfo.sha512;
    }
    await fs.writeFile(temporaryManifest, yaml.dump(manifest, {
      lineWidth: -1,
      noRefs: true,
      noCompatMode: true,
    }));
    await fs.rename(temporaryBlockmap, blockmapPath);
    await fs.rename(temporaryManifest, manifestPath);
    return Object.freeze({
      manifestPath,
      blockmapPath,
      sha512: updateInfo.sha512,
      size: updateInfo.size,
    });
  } catch (error) {
    if (error instanceof DmgNotarizationError) throw error;
    throw new DmgNotarizationError(
      "DMG_UPDATE_METADATA_REFRESH_FAILED",
      "Could not refresh update metadata after stapling the release DMG.",
      { manifestPath, blockmapPath, reason: error.message, code: error.code || null },
    );
  } finally {
    await Promise.all([
      fs.rm(temporaryBlockmap, { force: true }).catch(() => {}),
      fs.rm(temporaryManifest, { force: true }).catch(() => {}),
    ]);
  }
}

function redact(value, sensitiveValues = []) {
  let text = String(value || "");
  for (const sensitive of sensitiveValues) {
    if (sensitive) text = text.split(sensitive).join("<redacted>");
  }
  return text.trim();
}

async function runRequired(runner, {
  code,
  label,
  command,
  args,
  displayArgs = args,
  sensitiveValues = [],
}) {
  try {
    return await runner.run(command, args, {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      shell: false,
    });
  } catch (error) {
    throw new DmgNotarizationError(code, `${label} failed.`, {
      command,
      args: [...displayArgs],
      stdout: redact(error?.stdout, sensitiveValues),
      stderr: redact(error?.stderr, sensitiveValues),
    });
  }
}

export function parseDeveloperIdDmgSignature(output, { expectedTeamId = null } = {}) {
  const text = String(output || "");
  const authority = [...text.matchAll(/^Authority=(.+)$/gim)]
    .map((match) => match[1].trim())
    .find((value) => value.startsWith("Developer ID Application:"));
  const authorityTeamId = authority?.match(/\(([A-Z0-9]+)\)\s*$/)?.[1] || null;
  const teamIdentifier = text.match(/^TeamIdentifier=([^\s]+)$/im)?.[1] || authorityTeamId;
  if (!authority || !teamIdentifier || teamIdentifier === "not set") {
    throw new DmgNotarizationError(
      "DMG_DEVELOPER_ID_SIGNATURE_MISSING",
      "The release DMG must be signed with Developer ID Application before notarization.",
      { authority: authority || null, teamIdentifier: teamIdentifier || null },
    );
  }
  if (authorityTeamId && authorityTeamId !== teamIdentifier) {
    throw new DmgNotarizationError(
      "DMG_DEVELOPER_ID_TEAM_MISMATCH",
      "The release DMG signature contains conflicting Team IDs.",
      { authority, authorityTeamId, teamIdentifier },
    );
  }
  if (expectedTeamId && teamIdentifier !== expectedTeamId) {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_TEAM_MISMATCH",
      "The release DMG signing identity does not match APPLE_TEAM_ID.",
      { authority, expectedTeamId, teamIdentifier },
    );
  }
  return Object.freeze({ authority, teamIdentifier });
}

export function parseNotarytoolSubmission(output) {
  let value;
  try {
    value = JSON.parse(String(output || ""));
  } catch {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_RESPONSE_INVALID",
      "notarytool did not return a valid JSON submission result.",
    );
  }
  const id = typeof value?.id === "string" && value.id.trim() ? value.id.trim() : null;
  const status = typeof value?.status === "string" && value.status.trim() ? value.status.trim() : null;
  if (!id || status !== "Accepted") {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_REJECTED",
      "Apple did not accept the release DMG for notarization.",
      { id, status },
    );
  }
  return Object.freeze({ id, status });
}

async function defaultDmgPath(projectRoot) {
  const manifest = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
  const outputDirectory = manifest.build?.directories?.output || "dist";
  const outputRoot = path.resolve(projectRoot, outputDirectory);
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const candidates = entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.toLowerCase().endsWith(".dmg"))
    .map((entry) => path.join(outputRoot, entry.name))
    .sort();
  if (candidates.length !== 1) {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_ARTIFACT_COUNT_INVALID",
      "Exactly one DMG must exist in the desktop output directory before notarization.",
      { outputRoot, count: candidates.length, candidates },
    );
  }
  return candidates[0];
}

export async function notarizeMacDmg({
  dmgPath,
  projectRoot = DEFAULT_PROJECT_ROOT,
  env = process.env,
} = {}, {
  platform = process.platform,
  runner = defaultCommandRunner,
} = {}) {
  if (platform !== "darwin") {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_PLATFORM_UNSUPPORTED",
      "DMG notarization requires macOS.",
      { platform },
    );
  }
  if (!runner || typeof runner.run !== "function") {
    throw new DmgNotarizationError(
      "DMG_NOTARIZATION_ARGUMENT_INVALID",
      "DMG notarization requires a command runner.",
    );
  }
  const root = path.resolve(requireText(projectRoot, "projectRoot"));
  const resolvedDmg = dmgPath
    ? path.resolve(requireText(dmgPath, "dmgPath"))
    : await defaultDmgPath(root);
  await requireRegularFile(resolvedDmg, "release DMG");
  const credentials = resolveNotarytoolCredentials(env);

  await runRequired(runner, {
    code: "DMG_CONTAINER_VERIFICATION_FAILED",
    label: "DMG container verification",
    command: DMG_NOTARIZATION_COMMANDS.hdiutil,
    args: ["verify", resolvedDmg],
  });
  await runRequired(runner, {
    code: "DMG_CODE_SIGNATURE_INVALID",
    label: "DMG code-signature verification",
    command: DMG_NOTARIZATION_COMMANDS.codesign,
    args: ["--verify", "--strict", "--verbose=4", resolvedDmg],
  });
  const signatureResult = await runRequired(runner, {
    code: "DMG_CODE_SIGNATURE_INSPECTION_FAILED",
    label: "DMG code-signature inspection",
    command: DMG_NOTARIZATION_COMMANDS.codesign,
    args: ["-dv", "--verbose=4", resolvedDmg],
  });
  const signature = parseDeveloperIdDmgSignature(
    `${signatureResult?.stdout || ""}\n${signatureResult?.stderr || ""}`,
    { expectedTeamId: credentials.expectedTeamId },
  );

  const notaryArgs = [
    "notarytool", "submit", resolvedDmg,
    ...credentials.args,
    "--wait", "--output-format", "json",
  ];
  const displayNotaryArgs = [
    "notarytool", "submit", resolvedDmg,
    ...credentials.displayArgs,
    "--wait", "--output-format", "json",
  ];
  const submissionResult = await runRequired(runner, {
    code: "DMG_NOTARIZATION_SUBMISSION_FAILED",
    label: "DMG notarization submission",
    command: DMG_NOTARIZATION_COMMANDS.xcrun,
    args: notaryArgs,
    displayArgs: displayNotaryArgs,
    sensitiveValues: credentials.sensitiveValues,
  });
  const submission = parseNotarytoolSubmission(submissionResult?.stdout);

  await runRequired(runner, {
    code: "DMG_NOTARIZATION_STAPLE_FAILED",
    label: "DMG notarization ticket stapling",
    command: DMG_NOTARIZATION_COMMANDS.xcrun,
    args: ["stapler", "staple", "-v", resolvedDmg],
  });
  await runRequired(runner, {
    code: "DMG_NOTARIZATION_TICKET_INVALID",
    label: "DMG notarization ticket validation",
    command: DMG_NOTARIZATION_COMMANDS.xcrun,
    args: ["stapler", "validate", "-v", resolvedDmg],
  });
  await runRequired(runner, {
    code: "DMG_GATEKEEPER_ASSESSMENT_FAILED",
    label: "DMG Gatekeeper assessment",
    command: DMG_NOTARIZATION_COMMANDS.spctl,
    args: [
      "--assess", "--type", "open",
      "--context", "context:primary-signature",
      "--verbose=4", resolvedDmg,
    ],
  });
  await runRequired(runner, {
    code: "DMG_CODE_SIGNATURE_INVALID",
    label: "Stapled DMG code-signature verification",
    command: DMG_NOTARIZATION_COMMANDS.codesign,
    args: ["--verify", "--strict", "--verbose=4", resolvedDmg],
  });
  await runRequired(runner, {
    code: "DMG_CONTAINER_VERIFICATION_FAILED",
    label: "Stapled DMG container verification",
    command: DMG_NOTARIZATION_COMMANDS.hdiutil,
    args: ["verify", resolvedDmg],
  });

  const updateMetadata = await refreshDmgUpdateMetadata(resolvedDmg);

  return Object.freeze({
    ok: true,
    dmgPath: resolvedDmg,
    credentials: credentials.mode,
    signature,
    notarization: submission,
    staple: "valid",
    gatekeeper: "accepted",
    updateMetadata,
  });
}

export function parseDmgNotarizationArguments(argv, { cwd = process.cwd() } = {}) {
  const parsed = {};
  const allowed = new Map([
    ["--dmg", "dmgPath"],
    ["--project-root", "projectRoot"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equalsIndex = raw.indexOf("=");
    const flag = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
    const key = allowed.get(flag);
    if (!key || parsed[key] !== undefined) {
      throw new DmgNotarizationError(
        "DMG_NOTARIZATION_ARGUMENT_INVALID",
        `Unknown or duplicate argument '${raw}'.`,
        { argument: raw },
      );
    }
    const value = equalsIndex === -1 ? argv[++index] : raw.slice(equalsIndex + 1);
    if (!value || value.startsWith("--")) {
      throw new DmgNotarizationError(
        "DMG_NOTARIZATION_ARGUMENT_INVALID",
        `Argument '${flag}' requires a path.`,
        { argument: flag },
      );
    }
    parsed[key] = path.resolve(cwd, value);
  }
  return parsed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  notarizeMacDmg(parseDmgNotarizationArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: {
          code: error.code || "DMG_NOTARIZATION_FAILED",
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
