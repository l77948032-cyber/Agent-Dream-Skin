import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./errors.mjs";
import { SCRIPTS_ROOT } from "./paths.mjs";

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

function defaultRunner(file, args, options) {
  return new Promise((resolve, reject) => {
    execFileCallback(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else resolve({ stdout, stderr });
    });
  });
}

export class PlatformRuntime {
  constructor({ platform = process.platform, scriptsRoot = SCRIPTS_ROOT, runner = defaultRunner } = {}) {
    this.platform = platform;
    this.scriptsRoot = path.resolve(scriptsRoot);
    this.runner = runner;
  }

  descriptor() {
    const supported = this.platform === "darwin" || this.platform === "win32";
    return {
      platform: this.platform,
      supported,
      transport: supported ? "loopback-cdp" : null,
      appBundleModified: false,
    };
  }

  command(operation, { themeId, screenshotPath } = {}) {
    if (this.platform === "darwin") {
      const files = {
        status: "status-trae-skin-macos.sh",
        apply: "start-trae-skin-macos.sh",
        verify: "verify-trae-skin-macos.sh",
        restore: "stop-trae-skin-macos.sh",
      };
      const args = [path.join(this.scriptsRoot, files[operation])];
      if (operation === "apply") args.push("--theme", themeId);
      if (operation === "verify" && screenshotPath) args.push("--screenshot", screenshotPath);
      return { file: "/bin/bash", args };
    }
    if (this.platform === "win32") {
      const files = {
        status: "status-trae-skin-windows.ps1",
        apply: "start-trae-skin-windows.ps1",
        verify: "verify-trae-skin-windows.ps1",
        restore: "stop-trae-skin-windows.ps1",
      };
      const args = [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", path.join(this.scriptsRoot, files[operation]),
      ];
      if (operation === "apply") args.push("-Theme", themeId);
      if (operation === "verify" && screenshotPath) args.push("-ScreenshotPath", screenshotPath);
      return { file: "powershell.exe", args };
    }
    throw new ToolError("UNSUPPORTED_PLATFORM", "Trae-Dream-Skin currently supports macOS and Windows.", {
      platform: this.platform,
    });
  }

  async execute(operation, options = {}) {
    const command = this.command(operation, options);
    try {
      const result = await this.runner(command.file, command.args, {
        cwd: path.dirname(this.scriptsRoot),
        encoding: "utf8",
        timeout: operation === "status" ? 60000 : 180000,
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
    return { ...parseJsonOutput(result.stdout, "status"), diagnostics: result.stderr || undefined };
  }

  async apply(themeId) {
    const result = await this.execute("apply", { themeId });
    return { applied: true, themeId, message: result.stdout, diagnostics: result.stderr || undefined };
  }

  async verify({ screenshotPath } = {}) {
    if (screenshotPath) await fs.mkdir(path.dirname(path.resolve(screenshotPath)), { recursive: true });
    const result = await this.execute("verify", { screenshotPath: screenshotPath && path.resolve(screenshotPath) });
    return parseJsonOutput(result.stdout, "verify");
  }

  async restore() {
    const result = await this.execute("restore");
    return { restored: true, message: result.stdout, diagnostics: result.stderr || undefined };
  }
}
