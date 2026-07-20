import { execFile as execFileCallback } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
export const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");

export const MAC_RELEASE_COMMANDS = Object.freeze({
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  hdiutil: "/usr/bin/hdiutil",
  lipo: "/usr/bin/lipo",
  plutil: "/usr/bin/plutil",
  spctl: "/usr/sbin/spctl",
  unzip: "/usr/bin/unzip",
  xcrun: "/usr/bin/xcrun",
});

const COMMAND_OPTIONS = Object.freeze({
  encoding: "utf8",
  maxBuffer: 4 * 1024 * 1024,
  shell: false,
});

export class MacReleaseVerificationError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "MacReleaseVerificationError";
    this.code = code;
    this.details = details;
  }
}

export const defaultCommandRunner = Object.freeze({
  run(command, args, options = {}) {
    return execFile(command, args, { ...COMMAND_OPTIONS, ...options, shell: false });
  },
});

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_CONFIG_INVALID",
      `${label} must be a non-empty string.`,
      { label },
    );
  }
  return value;
}

function expandArtifactName(pattern, values) {
  const expanded = pattern.replace(/\$\{([a-zA-Z]+)\}/g, (match, key) => (
    Object.hasOwn(values, key) ? values[key] : match
  ));
  if (/\$\{[^}]+\}/.test(expanded)) {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_CONFIG_INVALID",
      "build.artifactName contains an unsupported macro.",
      { artifactName: pattern },
    );
  }
  return expanded;
}

export function defaultMacReleaseArtifacts({
  projectRoot = DEFAULT_PROJECT_ROOT,
  packageManifest,
} = {}) {
  if (!packageManifest || typeof packageManifest !== "object" || Array.isArray(packageManifest)) {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_CONFIG_INVALID",
      "A package manifest is required to resolve release artifacts.",
    );
  }
  const resolvedProjectRoot = path.resolve(projectRoot);
  const version = requireNonEmptyString(packageManifest.version, "package.version");
  const productName = requireNonEmptyString(packageManifest.build?.productName, "build.productName");
  const artifactPattern = requireNonEmptyString(
    packageManifest.build?.artifactName,
    "build.artifactName",
  );
  const configuredOutput = packageManifest.build?.directories?.output || "dist";
  const outputRoot = path.resolve(
    resolvedProjectRoot,
    requireNonEmptyString(configuredOutput, "build.directories.output"),
  );
  const artifactValues = {
    name: requireNonEmptyString(packageManifest.name, "package.name"),
    productName,
    version,
    os: "mac",
    arch: "arm64",
  };
  const artifactPath = (ext) => path.join(outputRoot, expandArtifactName(artifactPattern, {
    ...artifactValues,
    ext,
  }));

  return Object.freeze({
    app: path.join(outputRoot, "mac-arm64", `${productName}.app`),
    dmg: artifactPath("dmg"),
    zip: artifactPath("zip"),
  });
}

async function requireArtifact(target, type) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new MacReleaseVerificationError(
        "MAC_RELEASE_ARTIFACT_MISSING",
        `Required macOS ${type} artifact is missing.`,
        { type, path: target },
        { cause: error },
      );
    }
    throw error;
  }
  const validType = type === "app" ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !validType || (type !== "app" && stat.size === 0)) {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_ARTIFACT_INVALID",
      `Required macOS ${type} artifact has an invalid type or size.`,
      { type, path: target, bytes: stat.size },
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
    throw new MacReleaseVerificationError(
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

export function parseDeveloperIdSignature(output) {
  const text = String(output || "");
  const adHoc = /^Signature=adhoc$/im.test(text) || /^flags=.*\badhoc\b/im.test(text);
  const hardenedRuntime = /^flags=.*\bruntime\b/im.test(text);
  const authority = [...text.matchAll(/^Authority=(.+)$/gim)]
    .map((match) => match[1].trim())
    .find((value) => value.startsWith("Developer ID Application:"));
  const teamIdentifier = text.match(/^TeamIdentifier=(.+)$/im)?.[1]?.trim();
  if (adHoc || !authority || !teamIdentifier || teamIdentifier.toLowerCase() === "not set") {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_SIGNATURE_INVALID",
      "The app must have a non-ad-hoc Developer ID Application signature.",
      {
        adHoc,
        authority: authority || null,
        teamIdentifier: teamIdentifier || null,
      },
    );
  }
  const authorityTeam = authority.match(/\(([A-Z0-9]+)\)\s*$/)?.[1];
  if (authorityTeam && authorityTeam !== teamIdentifier) {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_SIGNATURE_INVALID",
      "The Developer ID authority and TeamIdentifier do not match.",
      { authority, authorityTeam, teamIdentifier },
    );
  }
  if (!hardenedRuntime) {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_HARDENED_RUNTIME_MISSING",
      "The app signature must enable the hardened runtime.",
      { authority, teamIdentifier, hardenedRuntime },
    );
  }
  return Object.freeze({ authority, teamIdentifier, hardenedRuntime });
}

function parseBundleExecutable(output, appPath) {
  const executableName = String(output || "").trim();
  if (
    !executableName
    || executableName === "."
    || executableName === ".."
    || path.basename(executableName) !== executableName
  ) {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_EXECUTABLE_INVALID",
      "The app bundle must declare a safe main executable name.",
      { path: appPath, executableName: executableName || null },
    );
  }
  return path.join(appPath, "Contents", "MacOS", executableName);
}

export function parseArm64Architecture(output, executablePath) {
  const architectures = String(output || "").trim().split(/\s+/).filter(Boolean);
  if (architectures.length !== 1 || architectures[0] !== "arm64") {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_ARCHITECTURE_INVALID",
      "The macOS release executable must be thin arm64.",
      { path: executablePath, architectures },
    );
  }
  return "arm64";
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

async function verifyZipAppTrust(runner, { app, zip }) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-release-zip-"));
  const zipApp = path.join(temporaryRoot, path.basename(app));
  let primaryError = null;
  let result = null;
  try {
    await runRequiredCommand(runner, {
      code: "MAC_RELEASE_ZIP_EXTRACTION_FAILED",
      label: "ZIP extraction",
      command: MAC_RELEASE_COMMANDS.ditto,
      args: ["-x", "-k", zip, temporaryRoot],
    });
    await requireArtifact(zipApp, "app");
    await runRequiredCommand(runner, {
      code: "MAC_RELEASE_ZIP_CODESIGN_FAILED",
      label: "ZIP app strict code-signature verification",
      command: MAC_RELEASE_COMMANDS.codesign,
      args: ["--verify", "--deep", "--strict", "--verbose=4", zipApp],
    });
    await runRequiredCommand(runner, {
      code: "MAC_RELEASE_ZIP_GATEKEEPER_FAILED",
      label: "ZIP app Gatekeeper assessment",
      command: MAC_RELEASE_COMMANDS.spctl,
      args: ["--assess", "--type", "execute", "--verbose=4", zipApp],
    });
    await runRequiredCommand(runner, {
      code: "MAC_RELEASE_ZIP_NOTARIZATION_FAILED",
      label: "ZIP app notarization ticket validation",
      command: MAC_RELEASE_COMMANDS.xcrun,
      args: ["stapler", "validate", zipApp],
    });
    result = Object.freeze({
      appName: path.basename(zipApp),
      codesign: "valid",
      gatekeeper: "accepted",
      notarizationTicket: "valid",
    });
  } catch (error) {
    primaryError = error;
  }

  try {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    if (primaryError) {
      primaryError.details = {
        ...(primaryError.details || {}),
        cleanupError: { message: error.message, code: error.code || null },
      };
    } else {
      primaryError = new MacReleaseVerificationError(
        "MAC_RELEASE_ZIP_CLEANUP_FAILED",
        "The release verifier could not remove the extracted ZIP payload.",
        { path: temporaryRoot, code: error.code || null },
        { cause: error },
      );
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

export async function verifyMacRelease({
  artifacts,
  runner = defaultCommandRunner,
  platform = process.platform,
} = {}) {
  if (platform !== "darwin") {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_PLATFORM_UNSUPPORTED",
      "macOS releases must be verified on macOS.",
      { platform },
    );
  }
  if (!runner || typeof runner.run !== "function") {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_RUNNER_INVALID",
      "The release verifier requires a command runner.",
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

  const signatureDetails = await runRequiredCommand(runner, {
    code: "MAC_RELEASE_SIGNATURE_INSPECTION_FAILED",
    label: "Developer ID signature inspection",
    command: MAC_RELEASE_COMMANDS.codesign,
    args: ["-dv", "--verbose=4", resolved.app],
  });
  const signature = parseDeveloperIdSignature(commandOutput(signatureDetails));

  const bundleExecutableResult = await runRequiredCommand(runner, {
    code: "MAC_RELEASE_EXECUTABLE_INSPECTION_FAILED",
    label: "Bundle executable inspection",
    command: MAC_RELEASE_COMMANDS.plutil,
    args: [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      path.join(resolved.app, "Contents", "Info.plist"),
    ],
  });
  const executablePath = parseBundleExecutable(bundleExecutableResult.stdout, resolved.app);
  await requireArtifact(executablePath, "executable");
  const architectureResult = await runRequiredCommand(runner, {
    code: "MAC_RELEASE_ARCHITECTURE_INSPECTION_FAILED",
    label: "Main executable architecture inspection",
    command: MAC_RELEASE_COMMANDS.lipo,
    args: ["-archs", executablePath],
  });
  const architecture = parseArm64Architecture(architectureResult.stdout, executablePath);

  await runRequiredCommand(runner, {
    code: "MAC_RELEASE_CODESIGN_FAILED",
    label: "Strict code-signature verification",
    command: MAC_RELEASE_COMMANDS.codesign,
    args: ["--verify", "--deep", "--strict", "--verbose=4", resolved.app],
  });
  await runRequiredCommand(runner, {
    code: "MAC_RELEASE_GATEKEEPER_FAILED",
    label: "Gatekeeper assessment",
    command: MAC_RELEASE_COMMANDS.spctl,
    args: ["--assess", "--type", "execute", "--verbose=4", resolved.app],
  });
  await runRequiredCommand(runner, {
    code: "MAC_RELEASE_NOTARIZATION_FAILED",
    label: "Notarization ticket validation",
    command: MAC_RELEASE_COMMANDS.xcrun,
    args: ["stapler", "validate", resolved.app],
  });
  await runRequiredCommand(runner, {
    code: "MAC_RELEASE_DMG_VERIFICATION_FAILED",
    label: "DMG container verification",
    command: MAC_RELEASE_COMMANDS.hdiutil,
    args: ["verify", resolved.dmg],
  });
  await runRequiredCommand(runner, {
    code: "MAC_RELEASE_DMG_GATEKEEPER_FAILED",
    label: "DMG Gatekeeper assessment",
    command: MAC_RELEASE_COMMANDS.spctl,
    args: [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      resolved.dmg,
    ],
  });
  await runRequiredCommand(runner, {
    code: "MAC_RELEASE_DMG_NOTARIZATION_FAILED",
    label: "DMG notarization ticket validation",
    command: MAC_RELEASE_COMMANDS.xcrun,
    args: ["stapler", "validate", resolved.dmg],
  });
  await runRequiredCommand(runner, {
    code: "MAC_RELEASE_ZIP_VERIFICATION_FAILED",
    label: "ZIP container verification",
    command: MAC_RELEASE_COMMANDS.unzip,
    args: ["-t", resolved.zip],
  });
  const zipTrust = await verifyZipAppTrust(runner, resolved);

  const [dmg, zip] = await Promise.all([sha256File(resolved.dmg), sha256File(resolved.zip)]);
  return Object.freeze({
    ok: true,
    platform: "darwin",
    architecture,
    app: Object.freeze({
      path: resolved.app,
      executablePath,
      ...signature,
      codesign: "valid",
      gatekeeper: "accepted",
      notarizationTicket: "valid",
    }),
    artifacts: Object.freeze({
      dmg: Object.freeze({ ...dmg, gatekeeper: "accepted", notarizationTicket: "valid" }),
      zip: Object.freeze({ ...zip, ...zipTrust }),
    }),
  });
}

function setArgument(target, key, value) {
  if (target[key] !== undefined) {
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_ARGUMENT_INVALID",
      `Argument '${key}' was provided more than once.`,
      { argument: key },
    );
  }
  target[key] = value;
}

export function parseMacReleaseArguments(argv, { cwd = process.cwd() } = {}) {
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
      throw new MacReleaseVerificationError(
        "MAC_RELEASE_ARGUMENT_INVALID",
        `Unknown argument '${raw}'.`,
        { argument: raw },
      );
    }
    const value = inline === undefined ? argv[++index] : inline;
    if (!value || value.startsWith("--")) {
      throw new MacReleaseVerificationError(
        "MAC_RELEASE_ARGUMENT_INVALID",
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
    throw new MacReleaseVerificationError(
      "MAC_RELEASE_CONFIG_INVALID",
      "Could not read the project package manifest.",
      { packagePath },
      { cause: error },
    );
  }
}

export async function runMacReleaseVerifier(argv = process.argv.slice(2), {
  runner = defaultCommandRunner,
  platform = process.platform,
  cwd = process.cwd(),
} = {}) {
  const arguments_ = parseMacReleaseArguments(argv, { cwd });
  const projectRoot = arguments_.projectRoot || DEFAULT_PROJECT_ROOT;
  const defaults = defaultMacReleaseArtifacts({
    projectRoot,
    packageManifest: await readPackageManifest(projectRoot),
  });
  return verifyMacRelease({
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
  runMacReleaseVerifier()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      const payload = {
        ok: false,
        error: {
          code: error.code || "MAC_RELEASE_VERIFICATION_FAILED",
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
      process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
      process.exitCode = 1;
    });
}
