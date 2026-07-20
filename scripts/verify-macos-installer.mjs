import { execFile as execFileCallback } from "node:child_process";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { defaultMacReleaseArtifacts } from "./verify-macos-release.mjs";

const execFile = promisify(execFileCallback);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export const MAC_INSTALLER_COMMANDS = Object.freeze({
  codesign: "/usr/bin/codesign",
  hdiutil: "/usr/bin/hdiutil",
  plutil: "/usr/bin/plutil",
  unzip: "/usr/bin/unzip",
});

const COMMAND_OPTIONS = Object.freeze({
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  shell: false,
});

const PAYLOAD_FIELDS = Object.freeze([
  "bundleIdentifier",
  "version",
  "buildVersion",
  "codeDirectoryIdentifier",
  "cdHash",
]);

export class MacInstallerVerificationError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "MacInstallerVerificationError";
    this.code = code;
    this.details = details;
  }
}

export const defaultCommandRunner = Object.freeze({
  run(command, args, options = {}) {
    return execFile(command, args, { ...COMMAND_OPTIONS, ...options, shell: false });
  },
});

function requireNonEmptyString(value, label, code = "MAC_INSTALLER_CONFIG_INVALID") {
  if (typeof value !== "string" || !value.trim()) {
    throw new MacInstallerVerificationError(
      code,
      `${label} must be a non-empty string.`,
      { label },
    );
  }
  return value;
}

export function defaultMacInstallerArtifacts(options = {}) {
  return defaultMacReleaseArtifacts(options);
}

async function requireArtifact(target, type, {
  missingCode = "MAC_INSTALLER_ARTIFACT_MISSING",
  invalidCode = "MAC_INSTALLER_ARTIFACT_INVALID",
} = {}) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new MacInstallerVerificationError(
        missingCode,
        `Required macOS ${type} artifact is missing.`,
        { type, path: target },
        { cause: error },
      );
    }
    throw error;
  }

  const expectedDirectory = type === "app";
  const validType = expectedDirectory ? stat.isDirectory() : stat.isFile();
  let empty = !expectedDirectory && stat.size === 0;
  if (expectedDirectory && validType && !stat.isSymbolicLink()) {
    empty = (await fs.readdir(target)).length === 0;
  }
  if (stat.isSymbolicLink() || !validType || empty) {
    throw new MacInstallerVerificationError(
      invalidCode,
      `Required macOS ${type} artifact has an invalid type or is empty.`,
      { type, path: target, bytes: stat.size, empty },
    );
  }
  return stat;
}

function commandOutput(result = {}) {
  return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
}

async function runRequiredCommand(runner, { code, label, command, args }) {
  try {
    return await runner.run(command, args, COMMAND_OPTIONS);
  } catch (error) {
    throw new MacInstallerVerificationError(
      code,
      `${label} failed.`,
      {
        command,
        args: [...args],
        stdout: String(error.stdout || "").trim(),
        stderr: String(error.stderr || "").trim(),
      },
      { cause: error },
    );
  }
}

function parseCodeDirectory(output, appPath) {
  const text = String(output || "");
  const codeDirectoryIdentifier = text.match(/^Identifier=(.+)$/im)?.[1]?.trim();
  const cdHash = text.match(/^CDHash=([a-f0-9]+)$/im)?.[1]?.toLowerCase();
  if (!codeDirectoryIdentifier || !cdHash) {
    throw new MacInstallerVerificationError(
      "MAC_INSTALLER_SIGNATURE_INVALID",
      "The app signature does not expose a complete CodeDirectory identity.",
      {
        path: appPath,
        codeDirectoryIdentifier: codeDirectoryIdentifier || null,
        cdHash: cdHash || null,
      },
    );
  }
  const adHoc = /^Signature=adhoc$/im.test(text) || /^flags=.*\badhoc\b/im.test(text);
  const authorities = [...text.matchAll(/^Authority=(.+)$/gim)]
    .map((match) => match[1].trim());
  const rawTeamIdentifier = text.match(/^TeamIdentifier=(.+)$/im)?.[1]?.trim();
  const teamIdentifier = rawTeamIdentifier
    && rawTeamIdentifier.toLowerCase() !== "not set"
    ? rawTeamIdentifier
    : null;
  return Object.freeze({
    codeDirectoryIdentifier,
    cdHash,
    signature: adHoc ? "ad-hoc" : "signed",
    authority: authorities[0] || null,
    teamIdentifier,
  });
}

function parseBundleInfo(output, appPath) {
  let manifest;
  try {
    manifest = JSON.parse(String(output || ""));
  } catch (error) {
    throw new MacInstallerVerificationError(
      "MAC_INSTALLER_BUNDLE_INFO_INVALID",
      "The app Info.plist could not be decoded.",
      { path: appPath },
      { cause: error },
    );
  }
  const fields = [
    ["CFBundleIdentifier", "bundleIdentifier"],
    ["CFBundleShortVersionString", "version"],
    ["CFBundleVersion", "buildVersion"],
  ];
  const parsed = {};
  for (const [plistKey, outputKey] of fields) {
    const value = manifest?.[plistKey];
    if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
      throw new MacInstallerVerificationError(
        "MAC_INSTALLER_BUNDLE_INFO_INVALID",
        `The app Info.plist is missing ${plistKey}.`,
        { path: appPath, key: plistKey },
      );
    }
    parsed[outputKey] = String(value);
  }
  return Object.freeze(parsed);
}

async function inspectAppPayload(runner, appPath, role) {
  await requireArtifact(appPath, "app", {
    missingCode: "MAC_INSTALLER_PAYLOAD_MISSING",
    invalidCode: "MAC_INSTALLER_PAYLOAD_INVALID",
  });
  await runRequiredCommand(runner, {
    code: "MAC_INSTALLER_CODESIGN_FAILED",
    label: `${role} strict code-signature verification`,
    command: MAC_INSTALLER_COMMANDS.codesign,
    args: ["--verify", "--deep", "--strict", "--verbose=4", appPath],
  });
  const signatureResult = await runRequiredCommand(runner, {
    code: "MAC_INSTALLER_SIGNATURE_INSPECTION_FAILED",
    label: `${role} CodeDirectory inspection`,
    command: MAC_INSTALLER_COMMANDS.codesign,
    args: ["-dv", "--verbose=4", appPath],
  });
  const signature = parseCodeDirectory(commandOutput(signatureResult), appPath);
  const infoPath = path.join(appPath, "Contents", "Info.plist");
  const bundleResult = await runRequiredCommand(runner, {
    code: "MAC_INSTALLER_BUNDLE_INFO_FAILED",
    label: `${role} Info.plist inspection`,
    command: MAC_INSTALLER_COMMANDS.plutil,
    args: ["-convert", "json", "-o", "-", infoPath],
  });
  const bundle = parseBundleInfo(bundleResult.stdout, appPath);
  if (bundle.bundleIdentifier !== signature.codeDirectoryIdentifier) {
    throw new MacInstallerVerificationError(
      "MAC_INSTALLER_SIGNATURE_INVALID",
      "The bundle identifier and CodeDirectory identifier do not match.",
      {
        path: appPath,
        bundleIdentifier: bundle.bundleIdentifier,
        codeDirectoryIdentifier: signature.codeDirectoryIdentifier,
      },
    );
  }
  return Object.freeze({
    role,
    path: appPath,
    ...bundle,
    ...signature,
    codesign: "valid",
  });
}

function comparePayloads(unpacked, candidates) {
  for (const candidate of candidates) {
    const mismatches = PAYLOAD_FIELDS
      .filter((field) => candidate[field] !== unpacked[field])
      .map((field) => Object.freeze({
        field,
        expected: unpacked[field],
        actual: candidate[field],
      }));
    if (mismatches.length > 0) {
      throw new MacInstallerVerificationError(
        "MAC_INSTALLER_PAYLOAD_MISMATCH",
        `${candidate.role} does not contain the verified unpacked app payload.`,
        {
          referencePath: unpacked.path,
          candidatePath: candidate.path,
          mismatches,
        },
      );
    }
  }
}

async function requireApplicationsLink(mountPoint) {
  const linkPath = path.join(mountPoint, "Applications");
  let stat;
  try {
    stat = await fs.lstat(linkPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new MacInstallerVerificationError(
        "MAC_INSTALLER_DMG_LAYOUT_INVALID",
        "The DMG is missing its Applications shortcut.",
        { path: linkPath },
        { cause: error },
      );
    }
    throw error;
  }
  const target = stat.isSymbolicLink() ? await fs.readlink(linkPath) : null;
  if (!stat.isSymbolicLink() || target !== "/Applications") {
    throw new MacInstallerVerificationError(
      "MAC_INSTALLER_DMG_LAYOUT_INVALID",
      "The DMG Applications shortcut must be a symlink to /Applications.",
      { path: linkPath, target },
    );
  }
  return Object.freeze({ path: linkPath, target });
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return Object.freeze({
    path: filePath,
    bytes,
    sha256: hash.digest("hex"),
  });
}

function cleanupFailureDetails(error) {
  return Object.freeze({
    message: error.message,
    code: error.code || null,
    stderr: String(error.details?.stderr || error.stderr || "").trim(),
  });
}

export async function verifyMacInstaller({
  artifacts,
  runner = defaultCommandRunner,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") {
    throw new MacInstallerVerificationError(
      "MAC_INSTALLER_PLATFORM_UNSUPPORTED",
      "macOS installers must be verified on macOS.",
      { platform },
    );
  }
  if (!runner || typeof runner.run !== "function") {
    throw new MacInstallerVerificationError(
      "MAC_INSTALLER_RUNNER_INVALID",
      "The installer verifier requires a command runner.",
    );
  }
  const resolved = Object.freeze({
    app: path.resolve(requireNonEmptyString(artifacts?.app, "artifacts.app")),
    dmg: path.resolve(requireNonEmptyString(artifacts?.dmg, "artifacts.dmg")),
    zip: path.resolve(requireNonEmptyString(artifacts?.zip, "artifacts.zip")),
  });
  await Promise.all([
    requireArtifact(resolved.app, "app"),
    requireArtifact(resolved.dmg, "dmg"),
    requireArtifact(resolved.zip, "zip"),
  ]);

  const unpacked = await inspectAppPayload(runner, resolved.app, "unpacked app");
  await runRequiredCommand(runner, {
    code: "MAC_INSTALLER_DMG_VERIFICATION_FAILED",
    label: "DMG container verification",
    command: MAC_INSTALLER_COMMANDS.hdiutil,
    args: ["verify", resolved.dmg],
  });
  await runRequiredCommand(runner, {
    code: "MAC_INSTALLER_ZIP_VERIFICATION_FAILED",
    label: "ZIP container verification",
    command: MAC_INSTALLER_COMMANDS.unzip,
    args: ["-t", resolved.zip],
  });

  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-installer-verifier-"));
  const mountPoint = path.join(temporaryRoot, "dmg");
  const zipRoot = path.join(temporaryRoot, "zip");
  const appName = path.basename(resolved.app);

  let attachAttempted = false;
  let primaryError = null;
  let result = null;
  try {
    await Promise.all([
      fs.mkdir(mountPoint),
      fs.mkdir(zipRoot),
    ]);
    attachAttempted = true;
    await runRequiredCommand(runner, {
      code: "MAC_INSTALLER_DMG_MOUNT_FAILED",
      label: "DMG read-only mount",
      command: MAC_INSTALLER_COMMANDS.hdiutil,
      args: ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, resolved.dmg],
    });
    const applicationsLink = await requireApplicationsLink(mountPoint);
    const dmgPayload = await inspectAppPayload(
      runner,
      path.join(mountPoint, appName),
      "DMG app",
    );

    await runRequiredCommand(runner, {
      code: "MAC_INSTALLER_ZIP_EXTRACTION_FAILED",
      label: "ZIP extraction",
      command: MAC_INSTALLER_COMMANDS.unzip,
      args: ["-q", resolved.zip, "-d", zipRoot],
    });
    const zipPayload = await inspectAppPayload(
      runner,
      path.join(zipRoot, appName),
      "ZIP app",
    );
    comparePayloads(unpacked, [dmgPayload, zipPayload]);

    const [dmg, zip] = await Promise.all([
      sha256File(resolved.dmg),
      sha256File(resolved.zip),
    ]);
    result = Object.freeze({
      ok: true,
      platform: "darwin",
      architecture: "arm64",
      payload: Object.freeze({
        bundleIdentifier: unpacked.bundleIdentifier,
        version: unpacked.version,
        buildVersion: unpacked.buildVersion,
        codeDirectoryIdentifier: unpacked.codeDirectoryIdentifier,
        cdHash: unpacked.cdHash,
        signature: unpacked.signature,
        authority: unpacked.authority,
        teamIdentifier: unpacked.teamIdentifier,
      }),
      apps: Object.freeze({ unpacked, dmg: dmgPayload, zip: zipPayload }),
      installer: Object.freeze({
        applicationsLink: Object.freeze({ target: applicationsLink.target }),
      }),
      artifacts: Object.freeze({ dmg, zip }),
    });
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    if (attachAttempted) {
      try {
        await runRequiredCommand(runner, {
          code: "MAC_INSTALLER_DMG_DETACH_FAILED",
          label: "DMG detach",
          command: MAC_INSTALLER_COMMANDS.hdiutil,
          args: ["detach", mountPoint, "-force"],
        });
      } catch (error) {
        cleanupErrors.push(cleanupFailureDetails(error));
      }
    }
    try {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(cleanupFailureDetails(error));
    }
    if (cleanupErrors.length > 0) {
      if (primaryError) {
        const currentDetails = primaryError.details && typeof primaryError.details === "object"
          ? primaryError.details
          : {};
        primaryError.details = { ...currentDetails, cleanupErrors };
      } else {
        primaryError = new MacInstallerVerificationError(
          "MAC_INSTALLER_CLEANUP_FAILED",
          "The installer verifier could not clean up its mounted or extracted payloads.",
          { cleanupErrors },
        );
      }
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

function setArgument(target, key, value) {
  if (target[key] !== undefined) {
    throw new MacInstallerVerificationError(
      "MAC_INSTALLER_ARGUMENT_INVALID",
      `Argument '${key}' was provided more than once.`,
      { argument: key },
    );
  }
  target[key] = value;
}

export function parseMacInstallerArguments(argv, { cwd = process.cwd() } = {}) {
  const parsed = {};
  const names = new Map([
    ["--project-root", "projectRoot"],
    ["--app", "app"],
    ["--dmg", "dmg"],
    ["--zip", "zip"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    const equalsIndex = raw.indexOf("=");
    const flag = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
    const inline = equalsIndex === -1 ? undefined : raw.slice(equalsIndex + 1);
    const key = names.get(flag);
    if (!key) {
      throw new MacInstallerVerificationError(
        "MAC_INSTALLER_ARGUMENT_INVALID",
        `Unknown argument '${raw}'.`,
        { argument: raw },
      );
    }
    const value = inline === undefined ? argv[++index] : inline;
    if (!value || value.startsWith("--")) {
      throw new MacInstallerVerificationError(
        "MAC_INSTALLER_ARGUMENT_INVALID",
        `Argument '${flag}' requires a path.`,
        { argument: flag },
      );
    }
    setArgument(parsed, key, path.resolve(cwd, value));
  }
  return parsed;
}

async function readPackageManifest(projectRoot) {
  const packagePath = path.join(projectRoot, "package.json");
  try {
    return JSON.parse(await fs.readFile(packagePath, "utf8"));
  } catch (error) {
    throw new MacInstallerVerificationError(
      "MAC_INSTALLER_CONFIG_INVALID",
      "Could not read the project package manifest.",
      { packagePath },
      { cause: error },
    );
  }
}

export async function runMacInstallerVerifier(argv = process.argv.slice(2), {
  runner = defaultCommandRunner,
  platform = process.platform,
  cwd = process.cwd(),
} = {}) {
  const arguments_ = parseMacInstallerArguments(argv, { cwd });
  const projectRoot = arguments_.projectRoot || DEFAULT_PROJECT_ROOT;
  const defaults = defaultMacInstallerArtifacts({
    projectRoot,
    packageManifest: await readPackageManifest(projectRoot),
  });
  return verifyMacInstaller({
    artifacts: {
      app: arguments_.app || defaults.app,
      dmg: arguments_.dmg || defaults.dmg,
      zip: arguments_.zip || defaults.zip,
    },
    runner,
    platform,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runMacInstallerVerifier()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      const payload = {
        ok: false,
        error: {
          code: error.code || "MAC_INSTALLER_VERIFICATION_FAILED",
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
      process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exitCode = 1;
    });
}
