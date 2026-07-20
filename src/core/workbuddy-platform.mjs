import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./errors.mjs";
import { PROJECT_ROOT, SCRIPTS_ROOT } from "./paths.mjs";

function parseJsonOutput(stdout, label) {
  const text = String(stdout || "").trim();
  if (!text) throw new ToolError("INVALID_RUNTIME_OUTPUT", `${label} returned no JSON output.`);
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch {}
    }
    throw new ToolError("INVALID_RUNTIME_OUTPUT", `${label} returned malformed JSON.`, {
      output: text.slice(0, 2000),
    });
  }
}

export function normalizeWorkBuddyRuntimeStatus(status) {
  if (!status || typeof status !== "object" || Array.isArray(status)) return status;
  if (status.session !== "active") return status;
  const unhealthy = [
    "injectorAlive",
    "workbuddyAlive",
    "cdpOk",
    "ownedAppJob",
    "ownedWatcherJob",
  ].some((field) => status[field] === false);
  return unhealthy ? { ...status, session: "degraded" } : status;
}

function defaultRunner(file, args, options) {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

export class WorkBuddyPlatformRuntime {
  constructor({
    platform = process.platform,
    scriptsRoot = SCRIPTS_ROOT,
    themesRoot = path.join(PROJECT_ROOT, "plugins", "workbuddy", "catalog"),
    cssPath = path.join(PROJECT_ROOT, "plugins", "workbuddy", "assets", "workbuddy-skin.css"),
    templatePath = path.join(PROJECT_ROOT, "assets", "workbuddy-renderer-inject.js"),
    registryPath = path.join(PROJECT_ROOT, "plugins", "workbuddy", "resources", "components.v1.json"),
    stateRoot,
    runner = defaultRunner,
  } = {}) {
    this.platform = platform;
    this.scriptsRoot = path.resolve(scriptsRoot);
    this.themesRoot = path.resolve(themesRoot);
    this.cssPath = path.resolve(cssPath);
    this.templatePath = path.resolve(templatePath);
    this.registryPath = path.resolve(registryPath);
    this.stateRoot = stateRoot ? path.resolve(stateRoot) : null;
    this.runner = runner;
  }

  descriptor() {
    return {
      platform: this.platform,
      supported: this.platform === "darwin",
      transport: this.platform === "darwin" ? "loopback-cdp" : null,
      host: "workbuddy",
      minimumTestedHostVersion: "5.2.0",
      appBundleModified: false,
    };
  }

  command(operation, { themeId, themeRevision, screenshotPath } = {}) {
    if (this.platform !== "darwin") {
      throw new ToolError("UNSUPPORTED_PLATFORM", "WorkBuddy Dream Skin currently supports macOS.", {
        platform: this.platform,
      });
    }
    if (themeRevision !== undefined && themeRevision !== null
      && (typeof themeRevision !== "string" || !/^[a-f0-9]{64}$/.test(themeRevision))) {
      throw new ToolError("INVALID_ARGUMENT", "Runtime theme revision must be a SHA-256 digest.");
    }
    const files = {
      status: "status-workbuddy-skin-macos.sh",
      apply: "start-workbuddy-skin-macos.sh",
      verify: "verify-workbuddy-skin-macos.sh",
      restore: "stop-workbuddy-skin-macos.sh",
    };
    if (!files[operation]) throw new ToolError("INVALID_ARGUMENT", `Unknown runtime operation: ${operation}`);
    const args = [path.join(this.scriptsRoot, files[operation])];
    if (operation === "apply") {
      args.push("--theme", themeId);
      if (themeRevision) args.push("--revision", themeRevision);
    }
    if (operation === "verify" && screenshotPath) args.push("--screenshot", screenshotPath);
    return { file: "/bin/bash", args };
  }

  async execute(operation, options = {}) {
    const command = this.command(operation, options);
    try {
      const result = await this.runner(command.file, command.args, {
        cwd: path.dirname(this.scriptsRoot),
        env: {
          ...process.env,
          WORKBUDDY_DREAM_SKIN_THEMES_ROOT: this.themesRoot,
          WORKBUDDY_DREAM_SKIN_CSS_PATH: this.cssPath,
          WORKBUDDY_DREAM_SKIN_TEMPLATE_PATH: this.templatePath,
          WORKBUDDY_DREAM_SKIN_REGISTRY_PATH: this.registryPath,
          ...(this.stateRoot ? { WORKBUDDY_DREAM_SKIN_HOME: this.stateRoot } : {}),
        },
        encoding: "utf8",
        timeout: operation === "status" ? 60_000 : 180_000,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
      });
      return {
        operation,
        stdout: String(result.stdout || "").trim(),
        stderr: String(result.stderr || "").trim(),
      };
    } catch (error) {
      throw new ToolError("RUNTIME_COMMAND_FAILED", `${operation} failed: ${error.message}`, {
        operation,
        exitCode: error.code,
        stdout: String(error.stdout || "").trim().slice(0, 4000),
        stderr: String(error.stderr || "").trim().slice(0, 4000),
      });
    }
  }

  async status() {
    const result = await this.execute("status");
    return {
      ...normalizeWorkBuddyRuntimeStatus(parseJsonOutput(result.stdout, "status")),
      diagnostics: result.stderr || undefined,
    };
  }

  async apply(themeId, { revision } = {}) {
    const result = await this.execute("apply", { themeId, themeRevision: revision });
    return {
      applied: true,
      themeId,
      revision: revision || null,
      message: result.stdout,
      diagnostics: result.stderr || undefined,
    };
  }

  async verify({ screenshotPath } = {}) {
    if (screenshotPath) await fs.mkdir(path.dirname(path.resolve(screenshotPath)), { recursive: true });
    const result = await this.execute("verify", {
      screenshotPath: screenshotPath && path.resolve(screenshotPath),
    });
    return parseJsonOutput(result.stdout, "verify");
  }

  async restore() {
    const result = await this.execute("restore");
    return { restored: true, message: result.stdout, diagnostics: result.stderr || undefined };
  }
}
