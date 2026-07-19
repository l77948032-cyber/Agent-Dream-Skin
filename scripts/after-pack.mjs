import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";

const execFile = promisify(execFileCallback);

export const UNUSED_MAC_PRIVACY_KEYS = Object.freeze([
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
]);

export const DESKTOP_FUSE_CONFIG = Object.freeze({
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: false,
});

async function deletePlistKey(plistPath, key, run = execFile) {
  try {
    await run("/usr/libexec/PlistBuddy", ["-c", `Delete :${key}`, plistPath]);
  } catch (error) {
    const output = `${error.stderr || ""}\n${error.message || ""}`;
    if (!/does not exist/i.test(output)) throw error;
  }
}

export async function hardenMacInfoPlist(plistPath, { run = execFile } = {}) {
  await deletePlistKey(plistPath, "NSAppTransportSecurity", run);
  for (const key of UNUSED_MAC_PRIVACY_KEYS) await deletePlistKey(plistPath, key, run);
}

export function packagedExecutablePath(context) {
  const product = context.packager.appInfo.productFilename;
  if (context.electronPlatformName === "darwin") return path.join(context.appOutDir, `${product}.app`);
  if (context.electronPlatformName === "win32") return path.join(context.appOutDir, `${product}.exe`);
  return path.join(context.appOutDir, product);
}

export default async function afterPack(context) {
  const executable = packagedExecutablePath(context);
  if (context.electronPlatformName === "darwin") {
    await hardenMacInfoPlist(path.join(executable, "Contents", "Info.plist"));
  }
  await flipFuses(executable, {
    ...DESKTOP_FUSE_CONFIG,
    resetAdHocDarwinSignature: context.electronPlatformName === "darwin",
  });
}
