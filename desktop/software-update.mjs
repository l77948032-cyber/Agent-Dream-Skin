import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { ToolError } from "../src/core/errors.mjs";

const execFile = promisify(execFileCallback);

export const SOFTWARE_UPDATE_PHASES = Object.freeze({
  disabled: "disabled",
  idle: "idle",
  checking: "checking",
  available: "available",
  downloading: "downloading",
  ready: "ready",
  upToDate: "up-to-date",
  installing: "installing",
  error: "error",
});

const UPDATE_EVENTS = Object.freeze([
  "checking-for-update",
  "update-available",
  "update-not-available",
  "download-progress",
  "update-downloaded",
  "error",
]);

function limitedString(value, maxLength = 240) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeUpdateInfo(info = {}) {
  return Object.freeze({
    version: limitedString(info.version, 80),
    releaseName: limitedString(info.releaseName, 160),
    releaseDate: limitedString(info.releaseDate, 80),
  });
}

function normalizeProgress(progress = {}) {
  return Object.freeze({
    percent: Math.min(100, finiteNonNegative(progress.percent)),
    transferred: finiteNonNegative(progress.transferred),
    total: finiteNonNegative(progress.total),
    bytesPerSecond: finiteNonNegative(progress.bytesPerSecond),
  });
}

function updaterError(error, fallbackCode) {
  if (error instanceof ToolError) return error;
  const upstreamCode = limitedString(error?.code, 100);
  return new ToolError(
    fallbackCode,
    "无法连接软件更新服务，请检查网络后重试。",
    upstreamCode ? { upstreamCode } : undefined,
    { cause: error },
  );
}

function actionFlags(enabled, phase) {
  return Object.freeze({
    canCheck: enabled && [
      SOFTWARE_UPDATE_PHASES.idle,
      SOFTWARE_UPDATE_PHASES.upToDate,
      SOFTWARE_UPDATE_PHASES.error,
    ].includes(phase),
    canDownload: enabled && phase === SOFTWARE_UPDATE_PHASES.available,
    canInstall: enabled && phase === SOFTWARE_UPDATE_PHASES.ready,
  });
}

function freezeState(state) {
  const enabled = Boolean(state.enabled);
  const phase = enabled ? state.phase : SOFTWARE_UPDATE_PHASES.disabled;
  return Object.freeze({
    enabled,
    reason: enabled ? null : state.reason || "unavailable",
    phase,
    currentVersion: state.currentVersion,
    prerelease: Boolean(state.prerelease),
    update: state.update || null,
    progress: state.progress || null,
    error: state.error || null,
    ...actionFlags(enabled, phase),
  });
}

export async function detectMacUpdateEligibility({
  app,
  platform = process.platform,
  executablePath = process.execPath,
  run = execFile,
} = {}) {
  if (!app) throw new ToolError("INVALID_ARGUMENT", "Software update eligibility requires the Electron app.");
  if (platform !== "darwin") return Object.freeze({ enabled: false, reason: "unsupported-platform" });
  if (!app.isPackaged) return Object.freeze({ enabled: false, reason: "development" });
  if (process.mas) return Object.freeze({ enabled: false, reason: "app-store" });

  try {
    const result = await run("/usr/bin/codesign", ["-dv", "--verbose=4", executablePath], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 5_000,
    });
    const diagnostic = `${result?.stdout || ""}\n${result?.stderr || ""}`;
    const developerId = /^Authority=Developer ID Application:/m.test(diagnostic);
    const teamIdentifier = diagnostic.match(/^TeamIdentifier=([^\s]+)$/m)?.[1];
    if (developerId && teamIdentifier && teamIdentifier !== "not set") {
      return Object.freeze({ enabled: true, reason: null });
    }
  } catch {
    // Unsigned and ad-hoc builds intentionally fall through to a friendly disabled state.
  }
  return Object.freeze({ enabled: false, reason: "unsigned" });
}

export class SoftwareUpdateManager {
  constructor({
    app,
    updater,
    platform = process.platform,
    executablePath = process.execPath,
    eligibility = detectMacUpdateEligibility,
    beforeInstall = async () => {},
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancelSchedule = (timer) => clearTimeout(timer),
    scheduleInstall = (callback) => setImmediate(callback),
    autoCheckDelayMs = 12_000,
    logger = console,
  } = {}) {
    if (
      !app
      || !updater
      || typeof eligibility !== "function"
      || typeof beforeInstall !== "function"
      || typeof scheduleInstall !== "function"
    ) {
      throw new ToolError("INVALID_ARGUMENT", "SoftwareUpdateManager is missing required dependencies.");
    }
    this.app = app;
    this.updater = updater;
    this.platform = platform;
    this.executablePath = executablePath;
    this.eligibility = eligibility;
    this.beforeInstall = beforeInstall;
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.scheduleInstall = scheduleInstall;
    this.autoCheckDelayMs = autoCheckDelayMs;
    this.logger = logger;
    this.listeners = new Set();
    this.updaterListeners = new Map();
    this.timer = null;
    this.operation = null;
    this.initialized = false;
    this.closed = false;
    this.installScheduled = false;
    this.state = freezeState({
      enabled: false,
      reason: "starting",
      phase: SOFTWARE_UPDATE_PHASES.disabled,
      currentVersion: app.getVersion(),
      prerelease: app.getVersion().includes("-"),
    });
  }

  getState() {
    return this.state;
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new ToolError("INVALID_ARGUMENT", "Update subscriber must be a function.");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(patch) {
    this.state = freezeState({ ...this.state, ...patch });
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (error) {
        this.logger.error?.("DreamSkin software update listener failed.", error);
      }
    }
    return this.state;
  }

  listen(eventName, handler) {
    this.updater.on(eventName, handler);
    this.updaterListeners.set(eventName, handler);
  }

  async initialize() {
    if (this.initialized) return this.state;
    this.initialized = true;
    const eligibility = await this.eligibility({
      app: this.app,
      platform: this.platform,
      executablePath: this.executablePath,
    });
    if (!eligibility?.enabled) {
      return this.emit({ enabled: false, reason: eligibility?.reason || "unavailable" });
    }

    this.updater.autoDownload = false;
    // Downloading an update must not turn an ordinary quit into an implicit install.
    // Installation only starts after the renderer calls install() and quitAndInstall().
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowDowngrade = false;
    this.updater.allowPrerelease = this.state.prerelease;
    this.updater.logger = this.logger;

    this.listen("checking-for-update", () => this.emit({
      phase: SOFTWARE_UPDATE_PHASES.checking,
      error: null,
      progress: null,
    }));
    this.listen("update-available", (info) => this.emit({
      phase: SOFTWARE_UPDATE_PHASES.available,
      update: normalizeUpdateInfo(info),
      progress: null,
      error: null,
    }));
    this.listen("update-not-available", () => this.emit({
      phase: SOFTWARE_UPDATE_PHASES.upToDate,
      update: null,
      progress: null,
      error: null,
    }));
    this.listen("download-progress", (progress) => this.emit({
      phase: SOFTWARE_UPDATE_PHASES.downloading,
      progress: normalizeProgress(progress),
      error: null,
    }));
    this.listen("update-downloaded", (info) => this.emit({
      phase: SOFTWARE_UPDATE_PHASES.ready,
      update: normalizeUpdateInfo(info),
      progress: normalizeProgress({ percent: 100 }),
      error: null,
    }));
    this.listen("error", (error) => {
      const normalized = updaterError(error, "UPDATE_FAILED");
      this.logger.error?.("DreamSkin software update failed.", error);
      this.emit({
        phase: SOFTWARE_UPDATE_PHASES.error,
        progress: null,
        error: Object.freeze({ code: normalized.code, message: normalized.message }),
      });
    });

    const state = this.emit({
      enabled: true,
      reason: null,
      phase: SOFTWARE_UPDATE_PHASES.idle,
      error: null,
    });
    if (Number.isFinite(this.autoCheckDelayMs) && this.autoCheckDelayMs >= 0) {
      this.timer = this.schedule(() => {
        this.timer = null;
        void this.check({ automatic: true });
      }, this.autoCheckDelayMs);
      this.timer?.unref?.();
    }
    return state;
  }

  assertEnabled() {
    if (!this.state.enabled) {
      throw new ToolError("UPDATE_DISABLED", "此构建不支持软件更新。", { reason: this.state.reason });
    }
    if (this.closed) throw new ToolError("UPDATE_CLOSED", "软件更新服务已停止。");
  }

  async runExclusive(label, operation) {
    this.assertEnabled();
    if (this.operation) {
      throw new ToolError("UPDATE_BUSY", "另一项软件更新操作正在进行。", { operation: this.operation });
    }
    this.operation = label;
    try {
      return await operation();
    } finally {
      this.operation = null;
    }
  }

  async check({ automatic = false } = {}) {
    const checkablePhases = [
      SOFTWARE_UPDATE_PHASES.idle,
      SOFTWARE_UPDATE_PHASES.upToDate,
      SOFTWARE_UPDATE_PHASES.error,
    ];
    if (automatic && (!this.state.enabled || this.operation || !checkablePhases.includes(this.state.phase))) {
      return this.state;
    }
    if (!automatic && this.timer) {
      this.cancelSchedule(this.timer);
      this.timer = null;
    }
    try {
      return await this.runExclusive("check", async () => {
        if (!checkablePhases.includes(this.state.phase)) {
          throw new ToolError("UPDATE_INVALID_STATE", "当前状态不能检查软件更新。", { phase: this.state.phase });
        }
        this.emit({ phase: SOFTWARE_UPDATE_PHASES.checking, error: null, progress: null });
        const result = await this.updater.checkForUpdates();
        if (this.state.phase === SOFTWARE_UPDATE_PHASES.checking) {
          const info = result?.updateInfo;
          if (info?.version && info.version !== this.state.currentVersion) {
            this.emit({ phase: SOFTWARE_UPDATE_PHASES.available, update: normalizeUpdateInfo(info) });
          } else {
            this.emit({ phase: SOFTWARE_UPDATE_PHASES.upToDate, update: null });
          }
        }
        return this.state;
      });
    } catch (error) {
      const normalized = updaterError(error, "UPDATE_CHECK_FAILED");
      if (automatic) {
        this.logger.warn?.("DreamSkin automatic update check failed.", error);
        if (
          this.state.phase !== SOFTWARE_UPDATE_PHASES.error
          && (!(error instanceof ToolError) || ![
            "UPDATE_DISABLED",
            "UPDATE_CLOSED",
            "UPDATE_BUSY",
            "UPDATE_INVALID_STATE",
          ].includes(error.code))
        ) {
          this.emit({
            phase: SOFTWARE_UPDATE_PHASES.error,
            error: Object.freeze({ code: normalized.code, message: normalized.message }),
          });
        }
        return this.state;
      }
      if (!(error instanceof ToolError) || !["UPDATE_DISABLED", "UPDATE_CLOSED", "UPDATE_BUSY", "UPDATE_INVALID_STATE"].includes(error.code)) {
        this.emit({
          phase: SOFTWARE_UPDATE_PHASES.error,
          error: Object.freeze({ code: normalized.code, message: normalized.message }),
        });
      }
      throw normalized;
    }
  }

  async download() {
    try {
      return await this.runExclusive("download", async () => {
        if (this.state.phase !== SOFTWARE_UPDATE_PHASES.available) {
          throw new ToolError("UPDATE_INVALID_STATE", "当前没有可下载的软件更新。", { phase: this.state.phase });
        }
        this.emit({ phase: SOFTWARE_UPDATE_PHASES.downloading, progress: normalizeProgress(), error: null });
        await this.updater.downloadUpdate();
        if (this.state.phase === SOFTWARE_UPDATE_PHASES.downloading) {
          this.emit({ phase: SOFTWARE_UPDATE_PHASES.ready, progress: normalizeProgress({ percent: 100 }) });
        }
        return this.state;
      });
    } catch (error) {
      const normalized = updaterError(error, "UPDATE_DOWNLOAD_FAILED");
      if (!(error instanceof ToolError) || !["UPDATE_DISABLED", "UPDATE_CLOSED", "UPDATE_BUSY", "UPDATE_INVALID_STATE"].includes(error.code)) {
        this.emit({
          phase: SOFTWARE_UPDATE_PHASES.error,
          progress: null,
          error: Object.freeze({ code: normalized.code, message: normalized.message }),
        });
      }
      throw normalized;
    }
  }

  install() {
    this.assertEnabled();
    if (this.state.phase !== SOFTWARE_UPDATE_PHASES.ready || this.installScheduled) {
      throw new ToolError("UPDATE_INVALID_STATE", "当前没有已下载的软件更新可安装。", { phase: this.state.phase });
    }
    this.installScheduled = true;
    const state = this.emit({ phase: SOFTWARE_UPDATE_PHASES.installing, error: null });
    this.scheduleInstall(async () => {
      try {
        await this.beforeInstall();
        this.updater.quitAndInstall(false, true);
      } catch (error) {
        this.installScheduled = false;
        const normalized = updaterError(error, "UPDATE_INSTALL_FAILED");
        this.logger.error?.("DreamSkin software update installation failed.", error);
        this.emit({
          phase: SOFTWARE_UPDATE_PHASES.error,
          error: Object.freeze({ code: normalized.code, message: normalized.message }),
        });
      }
    });
    return state;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) this.cancelSchedule(this.timer);
    this.timer = null;
    for (const [eventName, listener] of this.updaterListeners) {
      // EventEmitter treats an unhandled late `error` as fatal. Keep the
      // sanitizing logger attached while an updater request may still settle.
      if (eventName === "error") continue;
      this.updater.removeListener(eventName, listener);
    }
    this.updaterListeners.clear();
    this.listeners.clear();
  }
}

export function createSoftwareUpdateManager(options) {
  return new SoftwareUpdateManager(options);
}

export function createDisabledSoftwareUpdate({ app, reason = "unavailable" } = {}) {
  const state = freezeState({
    enabled: false,
    reason,
    phase: SOFTWARE_UPDATE_PHASES.disabled,
    currentVersion: app?.getVersion?.() || "0.0.0",
    prerelease: false,
  });
  return Object.freeze({
    initialize: async () => state,
    getState: () => state,
    check: async () => { throw new ToolError("UPDATE_DISABLED", "此构建不支持软件更新。", { reason }); },
    download: async () => { throw new ToolError("UPDATE_DISABLED", "此构建不支持软件更新。", { reason }); },
    install: () => { throw new ToolError("UPDATE_DISABLED", "此构建不支持软件更新。", { reason }); },
    subscribe: () => () => {},
    close: () => {},
  });
}

export { UPDATE_EVENTS };
