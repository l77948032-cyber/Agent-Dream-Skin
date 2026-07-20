import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PROJECT_ROOT,
  defaultCommandRunner,
  defaultMacInstallerArtifacts,
} from "./verify-macos-installer.mjs";
import { verifyPackagedDesktop } from "./verify-packaged-desktop.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const INSTALLED_DESKTOP_COMMANDS = Object.freeze({
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  hdiutil: "/usr/bin/hdiutil",
});

export class InstalledDesktopVerificationError extends Error {
  constructor(code, message, details = {}, options = {}) {
    super(message, options);
    this.name = "InstalledDesktopVerificationError";
    this.code = code;
    this.details = details;
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new InstalledDesktopVerificationError(
      "MAC_INSTALLED_ARGUMENT_INVALID",
      `${label} must be a non-empty string.`,
      { label },
    );
  }
  return value;
}

async function requireFile(target, label) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    throw new InstalledDesktopVerificationError(
      "MAC_INSTALLED_ARTIFACT_MISSING",
      `${label} is missing.`,
      { path: target },
      { cause: error },
    );
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new InstalledDesktopVerificationError(
      "MAC_INSTALLED_ARTIFACT_INVALID",
      `${label} must be a non-empty regular file.`,
      { path: target },
    );
  }
}

async function requireDirectory(target, label) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    throw new InstalledDesktopVerificationError(
      "MAC_INSTALLED_APP_MISSING",
      `${label} is missing.`,
      { path: target },
      { cause: error },
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new InstalledDesktopVerificationError(
      "MAC_INSTALLED_APP_INVALID",
      `${label} must be a regular application directory.`,
      { path: target },
    );
  }
}

async function runRequired(runner, { code, label, command, args }) {
  try {
    return await runner.run(command, args, { encoding: "utf8", shell: false });
  } catch (error) {
    throw new InstalledDesktopVerificationError(
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

export async function verifyInstalledMacDesktop({
  dmgPath,
  productName = "DreamSkin Studio",
  runCli = true,
  screenshotPath = null,
} = {}, {
  platform = process.platform,
  runner = defaultCommandRunner,
  verifyPackaged = verifyPackagedDesktop,
  makeTemporaryDirectory = (prefix) => fs.mkdtemp(prefix),
  removeDirectory = (target) => fs.rm(target, { recursive: true, force: true }),
} = {}) {
  if (platform !== "darwin") {
    throw new InstalledDesktopVerificationError(
      "MAC_INSTALLED_PLATFORM_UNSUPPORTED",
      "Installed desktop verification requires macOS.",
      { platform },
    );
  }
  const resolvedDmg = path.resolve(requireText(dmgPath, "dmgPath"));
  const safeProductName = requireText(productName, "productName");
  if (safeProductName.includes("/") || safeProductName === "." || safeProductName === "..") {
    throw new InstalledDesktopVerificationError(
      "MAC_INSTALLED_ARGUMENT_INVALID",
      "productName must be a single application name.",
      { productName: safeProductName },
    );
  }
  await requireFile(resolvedDmg, "macOS DMG");

  const temporaryRoot = await makeTemporaryDirectory(path.join(os.tmpdir(), "dreamskin-installed-e2e-"));
  const mountPoint = path.join(temporaryRoot, "mount");
  const applicationsRoot = path.join(temporaryRoot, "Applications");
  const sourceApp = path.join(mountPoint, `${safeProductName}.app`);
  const installedApp = path.join(applicationsRoot, `${safeProductName}.app`);
  const restartDataRoot = path.join(temporaryRoot, "UserData");
  let mounted = false;
  let result;
  let primaryError = null;
  try {
    await fs.mkdir(mountPoint, { recursive: true });
    await fs.mkdir(applicationsRoot, { recursive: true });
    await runRequired(runner, {
      code: "MAC_INSTALLED_DMG_ATTACH_FAILED",
      label: "DMG mount",
      command: INSTALLED_DESKTOP_COMMANDS.hdiutil,
      args: ["attach", resolvedDmg, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountPoint],
    });
    mounted = true;
    await requireDirectory(sourceApp, "DMG application");
    await runRequired(runner, {
      code: "MAC_INSTALLED_COPY_FAILED",
      label: "Application installation copy",
      command: INSTALLED_DESKTOP_COMMANDS.ditto,
      args: [sourceApp, installedApp],
    });
    await requireDirectory(installedApp, "Installed application");
    await runRequired(runner, {
      code: "MAC_INSTALLED_DMG_DETACH_FAILED",
      label: "DMG detach",
      command: INSTALLED_DESKTOP_COMMANDS.hdiutil,
      args: ["detach", mountPoint, "-force"],
    });
    mounted = false;
    await runRequired(runner, {
      code: "MAC_INSTALLED_CODESIGN_FAILED",
      label: "Installed application code-signature verification",
      command: INSTALLED_DESKTOP_COMMANDS.codesign,
      args: ["--verify", "--deep", "--strict", "--verbose=4", installedApp],
    });
    const packaged = await verifyPackaged({
      appPath: installedApp,
      runCli,
      screenshotPath,
      dataRoot: restartDataRoot,
    });
    const restarted = await verifyPackaged({
      appPath: installedApp,
      runCli,
      dataRoot: restartDataRoot,
    });
    result = Object.freeze({
      ok: true,
      platform: "darwin",
      architecture: "arm64",
      installation: Object.freeze({
        copiedFromDmg: true,
        detachedBeforeLaunch: true,
        codeSignature: "valid",
        restartVerified: true,
      }),
      packaged,
      restart: Object.freeze({
        verified: true,
        appVersion: restarted.info?.appVersion || null,
        runtimeVersions: restarted.info?.runtimeVersions || null,
        resourcesVerified: restarted.info?.resourcesVerified === true,
      }),
    });
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanupErrors = [];
    if (mounted) {
      try {
        await runRequired(runner, {
          code: "MAC_INSTALLED_DMG_DETACH_FAILED",
          label: "DMG cleanup detach",
          command: INSTALLED_DESKTOP_COMMANDS.hdiutil,
          args: ["detach", mountPoint, "-force"],
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await removeDirectory(temporaryRoot);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      if (primaryError) {
        primaryError.details = {
          ...(primaryError.details && typeof primaryError.details === "object" ? primaryError.details : {}),
          cleanupErrors: cleanupErrors.map((error) => ({ code: error.code, message: error.message })),
        };
      } else {
        primaryError = new InstalledDesktopVerificationError(
          "MAC_INSTALLED_CLEANUP_FAILED",
          "Installed desktop verification could not clean up temporary resources.",
          { cleanupErrors: cleanupErrors.map((error) => ({ code: error.code, message: error.message })) },
        );
      }
    }
  }
  if (primaryError) throw primaryError;
  return result;
}

export function parseInstalledDesktopArguments(argv, { cwd = process.cwd() } = {}) {
  const parsed = { runCli: true };
  const pathFlags = new Map([
    ["--project-root", "projectRoot"],
    ["--dmg", "dmgPath"],
    ["--screenshot", "screenshotPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--skip-cli") {
      parsed.runCli = false;
      continue;
    }
    const equalsIndex = raw.indexOf("=");
    const flag = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex);
    const key = pathFlags.get(flag);
    if (!key) {
      throw new InstalledDesktopVerificationError(
        "MAC_INSTALLED_ARGUMENT_INVALID",
        `Unknown argument '${raw}'.`,
        { argument: raw },
      );
    }
    const value = equalsIndex === -1 ? argv[++index] : raw.slice(equalsIndex + 1);
    if (!value || value.startsWith("--")) {
      throw new InstalledDesktopVerificationError(
        "MAC_INSTALLED_ARGUMENT_INVALID",
        `Argument '${flag}' requires a path.`,
        { argument: flag },
      );
    }
    if (parsed[key] !== undefined) {
      throw new InstalledDesktopVerificationError(
        "MAC_INSTALLED_ARGUMENT_INVALID",
        `Argument '${flag}' was provided more than once.`,
        { argument: flag },
      );
    }
    parsed[key] = path.resolve(cwd, value);
  }
  return parsed;
}

async function readManifest(projectRoot) {
  return JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
}

export async function runInstalledDesktopVerifier(argv = process.argv.slice(2)) {
  const options = parseInstalledDesktopArguments(argv);
  const projectRoot = options.projectRoot || DEFAULT_PROJECT_ROOT;
  const manifest = await readManifest(projectRoot);
  const defaults = defaultMacInstallerArtifacts({ projectRoot, packageManifest: manifest });
  return verifyInstalledMacDesktop({
    dmgPath: options.dmgPath || defaults.dmg,
    productName: manifest.build?.productName || manifest.productName,
    runCli: options.runCli,
    screenshotPath: options.screenshotPath || null,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runInstalledDesktopVerifier()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({
        ok: false,
        error: {
          code: error.code || "MAC_INSTALLED_VERIFICATION_FAILED",
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      }, null, 2)}\n`);
      process.exitCode = 1;
    });
}
