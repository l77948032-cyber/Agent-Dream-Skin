import fs from "node:fs/promises";
import path from "node:path";

const STARTUP_LOG_RELATIVE_PATH = Object.freeze(["dreamskin", "logs", "startup.log"]);

function errorCode(error) {
  return typeof error?.code === "string" && error.code.trim()
    ? error.code.trim()
    : "DESKTOP_STARTUP_FAILED";
}

function errorMessage(error) {
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  return String(error || "DreamSkin Studio could not start.");
}

export function formatStartupFailure(error, { now = new Date() } = {}) {
  const code = errorCode(error);
  const message = errorMessage(error);
  const stack = typeof error?.stack === "string" && error.stack.trim()
    ? error.stack.trim()
    : `${code}: ${message}`;
  return Object.freeze({
    code,
    message,
    timestamp: now.toISOString(),
    logEntry: `[${now.toISOString()}] ${code}\n${stack}\n\n`,
  });
}

export async function reportDesktopStartupFailure({
  app,
  dialog,
  error,
  fileSystem = fs,
  logger = console,
  now = new Date(),
} = {}) {
  const failure = formatStartupFailure(error, { now });
  let logPath = null;

  try {
    const userDataPath = app?.getPath?.("userData");
    if (typeof userDataPath === "string" && userDataPath) {
      logPath = path.join(userDataPath, ...STARTUP_LOG_RELATIVE_PATH);
      await fileSystem.mkdir(path.dirname(logPath), { recursive: true });
      await fileSystem.appendFile(logPath, failure.logEntry, { encoding: "utf8", mode: 0o600 });
    }
  } catch (logError) {
    logPath = null;
    logger.error?.("DreamSkin Studio could not write its startup log.", logError);
  }

  const detail = [
    `错误代码：${failure.code}`,
    failure.message,
    ...(logPath ? [`诊断日志：${logPath}`] : []),
  ].join("\n\n");

  try {
    if (typeof app?.isReady === "function" && !app.isReady()) await app.whenReady?.();
    await dialog?.showMessageBox?.({
      type: "error",
      title: "DreamSkin Studio 无法启动",
      message: "DreamSkin Studio 无法完成启动。",
      detail,
      buttons: ["退出"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
  } catch (dialogError) {
    logger.error?.("DreamSkin Studio could not show its startup error dialog.", dialogError);
  }

  return Object.freeze({
    ...failure,
    logPath,
  });
}
