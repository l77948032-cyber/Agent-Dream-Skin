import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ToolError } from "../src/core/errors.mjs";

export const DREAMSKIN_CLI_COMMAND = "dreamskin";
export const DREAMSKIN_CLI_MARKER = "# DreamSkin Studio CLI launcher v1";
const DREAMSKIN_CLI_MARKER_PATTERN = /^#!\/bin\/sh\n# DreamSkin Studio CLI launcher v[1-9][0-9]*\n/;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function pathEntries(value, platform = process.platform) {
  return String(value || "")
    .split(platform === "win32" ? ";" : ":")
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

async function entryState(target) {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function isManagedLauncher(target) {
  if (await entryState(target) !== "file") return false;
  try {
    return DREAMSKIN_CLI_MARKER_PATTERN.test(await fs.readFile(target, "utf8"));
  } catch {
    return false;
  }
}

async function launcherRecord(target) {
  if (!(await isManagedLauncher(target))) return null;
  let executable = true;
  try {
    await fs.access(target, fs.constants.X_OK);
  } catch {
    executable = false;
  }
  return {
    path: target,
    contents: await fs.readFile(target, "utf8"),
    executable,
  };
}

function uniquePaths(entries) {
  return [...new Set(entries.map((entry) => path.resolve(entry)))];
}

function defaultInstallDirectories({ homeDir, pathValue, platform }) {
  const conventional = uniquePaths([
    "/usr/local/bin",
    "/opt/homebrew/bin",
    path.join(homeDir, ".local", "bin"),
  ]);
  const conventionalSet = new Set(conventional);
  const onPath = pathEntries(pathValue, platform).filter((entry) => conventionalSet.has(entry));
  return uniquePaths([...onPath, ...conventional]);
}

async function writableDirectory(directory, { create = false } = {}) {
  try {
    if (create) await fs.mkdir(directory, { recursive: true, mode: 0o755 });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    await fs.access(directory, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export class DreamSkinCliManager {
  constructor({
    platform = process.platform,
    homeDir = os.homedir(),
    executablePath,
    resourcesPath,
    userDataPath,
    pathValue = process.env.PATH,
    installDirectories,
  } = {}) {
    this.platform = platform;
    this.homeDir = path.resolve(homeDir);
    this.executablePath = executablePath ? path.resolve(executablePath) : null;
    this.resourcesPath = resourcesPath ? path.resolve(resourcesPath) : null;
    this.userDataPath = userDataPath ? path.resolve(userDataPath) : null;
    this.pathValue = pathValue || "";
    this.userInstallDirectory = path.join(this.homeDir, ".local", "bin");
    this.installDirectories = installDirectories
      ? uniquePaths(installDirectories)
      : defaultInstallDirectories({
        homeDir: this.homeDir,
        pathValue: this.pathValue,
        platform: this.platform,
      });
  }

  get supported() {
    return this.platform === "darwin"
      && Boolean(this.executablePath && this.resourcesPath && this.userDataPath);
  }

  launcherContents() {
    if (!this.supported) {
      throw new ToolError("CLI_INSTALL_UNSUPPORTED", "DreamSkin CLI installation is currently available in the packaged macOS app.");
    }
    const appDataPath = path.dirname(this.userDataPath);
    const entryPath = path.join(this.resourcesPath, "app.asar", "bin", "dreamskin.mjs");
    const resourceRoot = path.join(this.resourcesPath, "dreamskin");
    const dataRoot = path.join(this.userDataPath, "dreamskin");
    const environment = {
      DREAMSKIN_PACKAGED: "1",
      DREAMSKIN_RESOURCE_ROOT: resourceRoot,
      DREAMSKIN_USER_DATA_ROOT: this.userDataPath,
      DREAMSKIN_DATA_ROOT: dataRoot,
      DREAMSKIN_TRAE_RUNTIME_STATE_ROOT: path.join(appDataPath, "TraeDreamSkin"),
      DREAMSKIN_WORKBUDDY_RUNTIME_STATE_ROOT: path.join(appDataPath, "WorkBuddyDreamSkin"),
      ELECTRON_RUN_AS_NODE: "1",
    };
    const lines = ["#!/bin/sh", DREAMSKIN_CLI_MARKER];
    for (const [name, value] of Object.entries(environment)) {
      lines.push(`export ${name}=${shellQuote(value)}`);
    }
    lines.push(`exec ${shellQuote(this.executablePath)} ${shellQuote(entryPath)} "$@"`);
    return `${lines.join("\n")}\n`;
  }

  candidatePaths() {
    return this.installDirectories.map((directory) => path.join(directory, DREAMSKIN_CLI_COMMAND));
  }

  async launcherRecords() {
    const records = [];
    for (const candidate of this.candidatePaths()) {
      const record = await launcherRecord(candidate);
      if (record) records.push(record);
    }
    return records;
  }

  async installedPath() {
    return (await this.launcherRecords())[0]?.path || null;
  }

  async preferredPath() {
    const installed = await this.installedPath();
    if (installed) return installed;
    for (const directory of this.installDirectories) {
      if (await writableDirectory(directory, { create: directory === this.userInstallDirectory })) {
        return path.join(directory, DREAMSKIN_CLI_COMMAND);
      }
    }
    return path.join(this.installDirectories.at(-1), DREAMSKIN_CLI_COMMAND);
  }

  async unavailableResources() {
    if (!this.supported) return [];
    const checks = [
      { kind: "app-executable", path: this.executablePath, type: "file", executable: true },
      {
        kind: "cli-entrypoint",
        path: path.join(this.resourcesPath, "app.asar", "bin", "dreamskin.mjs"),
        type: "file",
      },
      { kind: "resource-root", path: path.join(this.resourcesPath, "dreamskin"), type: "directory" },
      {
        kind: "resource-manifest",
        path: path.join(this.resourcesPath, "dreamskin", "resource-manifest.v1.json"),
        type: "file",
      },
    ];
    const missing = [];
    for (const check of checks) {
      if (await entryState(check.path) !== check.type) {
        missing.push({ kind: check.kind, path: check.path });
        continue;
      }
      if (check.executable) {
        try {
          await fs.access(check.path, fs.constants.X_OK);
        } catch {
          missing.push({ kind: check.kind, path: check.path });
        }
      }
    }
    return missing;
  }

  async status() {
    const targetPath = await this.preferredPath();
    const launcher = (await this.launcherRecords())[0] || null;
    const installed = Boolean(launcher);
    const current = Boolean(this.supported && launcher?.contents === this.launcherContents());
    const unavailableResources = await this.unavailableResources();
    const state = !this.supported
      ? "unsupported"
      : unavailableResources.length
        ? "unavailable"
        : !installed
          ? "not-installed"
          : !current || !launcher.executable
            ? "stale"
            : "ready";
    const directory = path.dirname(launcher?.path || targetPath);
    const pathAvailable = pathEntries(this.pathValue, this.platform).includes(directory);
    return {
      supported: this.supported,
      state,
      installed,
      current,
      available: state === "ready",
      command: DREAMSKIN_CLI_COMMAND,
      path: launcher?.path || null,
      targetPath,
      pathAvailable,
      message: state === "unsupported"
        ? "CLI 安装仅在 macOS 桌面安装包中提供。"
        : state === "unavailable"
          ? "当前 DreamSkin 应用或 CLI 资源不可用，请重新安装应用后再试。"
          : state === "stale"
            ? "CLI 启动器已过期或不可执行，请重新安装。"
            : state === "ready" && pathAvailable
              ? "DreamSkin CLI 已就绪。"
              : state === "ready"
                ? "CLI 已安装；当前终端 PATH 尚未包含它的目录。"
                : "CLI 尚未安装。",
    };
  }

  async install() {
    if (!this.supported) {
      throw new ToolError("CLI_INSTALL_UNSUPPORTED", "DreamSkin CLI installation is currently available in the packaged macOS app.");
    }
    const unavailableResources = await this.unavailableResources();
    if (unavailableResources.length) {
      throw new ToolError("CLI_RUNTIME_UNAVAILABLE", "The current DreamSkin application cannot provide a working CLI launcher.", {
        unavailableResources,
      });
    }
    const target = await this.preferredPath();
    const state = await entryState(target);
    if (state !== "missing" && !(state === "file" && await isManagedLauncher(target))) {
      throw new ToolError("CLI_PATH_OCCUPIED", "The DreamSkin CLI destination is already occupied by another file.", {
        path: target,
      });
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.writeFile(temporary, this.launcherContents(), { mode: 0o755 });
      await fs.chmod(temporary, 0o755);
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return this.status();
  }

  async uninstall() {
    const launchers = await this.launcherRecords();
    await Promise.all(launchers.map((launcher) => fs.rm(launcher.path)));
    return this.status();
  }
}
