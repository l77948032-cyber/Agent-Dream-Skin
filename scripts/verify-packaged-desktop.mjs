import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APP = path.join(PROJECT_ROOT, "dist-desktop", "mac-arm64", "DreamSkin Studio.app");
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CALL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const DEFAULT_KILL_TIMEOUT_MS = 5_000;
const STUDIO_URL = "dreamskin://studio/";
export const REQUIRED_PACKAGED_TARGETS = Object.freeze([
  "dreamskin.trae",
  "dreamskin.workbuddy",
]);

function parseArguments(argv) {
  const options = { appPath: DEFAULT_APP, agentId: "codex", runAgent: true, screenshotPath: null, keepData: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app") options.appPath = path.resolve(argv[++index] || "");
    else if (argument === "--agent") options.agentId = argv[++index] || "";
    else if (argument === "--skip-agent") options.runAgent = false;
    else if (argument === "--screenshot") options.screenshotPath = path.resolve(argv[++index] || "");
    else if (argument === "--keep-data") options.keepData = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.appPath || !/^[a-z0-9_-]+$/i.test(options.agentId)) throw new Error("Invalid verification arguments.");
  return options;
}

function executableFor(appPath, platform = process.platform) {
  if (platform !== "darwin" || !appPath.endsWith(".app")) {
    throw new Error("Packaged desktop verification currently requires a macOS .app bundle.");
  }
  const product = path.basename(appPath, ".app");
  return path.join(appPath, "Contents", "MacOS", product);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not reserve a loopback verification port.");
  return port;
}

function bounded(current, chunk, maximum = 24 * 1024) {
  const next = `${current}${chunk}`;
  return next.length > maximum ? next.slice(-maximum) : next;
}

async function waitForTarget(port, child, timeout = 30_000) {
  let spawnError = null;
  const onSpawnError = (error) => { spawnError = error; };
  child.once("error", onSpawnError);
  const deadline = Date.now() + timeout;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw new Error("DreamSkin Studio could not be started.", { cause: spawnError });
      if (child.exitCode !== null || child.signalCode !== null) {
        const status = child.exitCode !== null ? `exit code ${child.exitCode}` : `signal ${child.signalCode}`;
        throw new Error(`DreamSkin Studio exited before opening its renderer (${status}).`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
        const targets = await response.json();
        const target = targets.find((entry) => entry.type === "page" && entry.url === "dreamskin://studio/");
        if (target?.webSocketDebuggerUrl) return target;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("DreamSkin Studio did not expose its loopback verification target in time.");
  } finally {
    child.removeListener("error", onSpawnError);
  }
}

export class DevToolsClient {
  constructor(url, {
    WebSocketClass = WebSocket,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
  } = {}) {
    this.url = url;
    this.WebSocketClass = WebSocketClass;
    this.connectTimeoutMs = connectTimeoutMs;
    this.callTimeoutMs = callTimeoutMs;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new this.WebSocketClass(this.url);
    this.socket.addEventListener("error", (event) => {
      this.rejectPending(event?.error || new Error("DevTools WebSocket failed."));
    });
    this.socket.addEventListener("close", () => {
      this.rejectPending(new Error("DevTools WebSocket closed before the command completed."));
    });
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
        this.socket.removeEventListener("close", onClose);
      };
      const finish = (error) => {
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => finish();
      const onError = (event) => finish(event?.error || new Error("DevTools WebSocket connection failed."));
      const onClose = () => finish(new Error("DevTools WebSocket closed before connecting."));
      this.socket.addEventListener("open", onOpen);
      this.socket.addEventListener("error", onError);
      this.socket.addEventListener("close", onClose);
      timer = setTimeout(() => {
        finish(new Error(`DevTools WebSocket connection timed out after ${this.connectTimeoutMs}ms.`));
        try {
          this.socket.close();
        } catch {}
      }, this.connectTimeoutMs);
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        this.rejectPending(new Error("DevTools WebSocket returned an invalid message."));
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || JSON.stringify(message.error));
        error.name = "DevToolsProtocolError";
        if (message.error.code !== undefined) error.code = message.error.code;
        if (message.error.data !== undefined) error.data = message.error.data;
        pending.reject(error);
      }
      else pending.resolve(message.result);
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  call(method, params = {}, { timeoutMs = this.callTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== this.WebSocketClass.OPEN) {
        reject(new Error("DevTools WebSocket is not connected."));
        return;
      }
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`DevTools command '${method}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }), (error) => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        });
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(pending?.timer);
        reject(error);
      }
    });
  }

  async evaluate(expression, options) {
    const response = await this.call(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      options,
    );
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }

  close() {
    this.rejectPending(new Error("DevTools client was closed."));
    this.socket?.close();
  }
}

function missingDefaultContext(error) {
  return error?.code === -32000 && error.message === "Cannot find default execution context";
}

export async function waitForStudioContext(client, {
  timeoutMs = 15_000,
  pollIntervalMs = 100,
  staleMarker = null,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      lastState = await client.evaluate(`({
        url: window.location.href,
        readyState: document.readyState,
        bridge: typeof window.dreamskin === "object"
          && typeof window.dreamskin.getInfo === "function"
          && typeof window.dreamskin.studio?.bootstrap === "function",
        marker: window.__dreamskinVerifierReloadMarker || null,
      })`, { timeoutMs: Math.max(1, Math.min(2_000, deadline - Date.now())) });
    } catch (error) {
      if (!missingDefaultContext(error)) throw error;
      lastState = null;
    }
    if (
      lastState?.url === STUDIO_URL
      && lastState.readyState === "complete"
      && (staleMarker === null || lastState.marker !== staleMarker)
    ) {
      if (!lastState.bridge) {
        throw new Error("Packaged Studio completed loading without its sandboxed preload bridge.");
      }
      return lastState;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await sleep(Math.min(pollIntervalMs, remaining));
  }
  const diagnostic = lastState ? ` Last renderer state: ${JSON.stringify(lastState)}` : "";
  throw new Error(`Packaged Studio did not establish a ready default execution context in time.${diagnostic}`);
}

async function waitForStudioUi(client, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  let state = null;
  while (Date.now() < deadline) {
    state = await client.evaluate(`({
      heading: document.querySelector("main h1, main h2")?.textContent?.trim() || "",
      cards: document.querySelectorAll(".template-card, .local-theme-card, .blank-theme-card").length,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      error: document.querySelector("[role=alert]")?.textContent?.trim() || "",
    })`, { timeoutMs: Math.max(1, Math.min(2_000, deadline - Date.now())) });
    if (state.heading && state.cards > 0) return state;
    if (state.error) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return state || { heading: "", cards: 0, horizontalOverflow: false, error: "" };
}

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child, timeoutMs) {
  if (childExited(child)) return true;
  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    if (childExited(child)) {
      finish(true);
      return;
    }
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export async function stopChild(child, {
  gracefulTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
  killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
} = {}) {
  if (childExited(child)) return { forced: false };
  child.kill("SIGTERM");
  if (await waitForChildExit(child, gracefulTimeoutMs)) return { forced: false };
  child.kill("SIGKILL");
  if (!await waitForChildExit(child, killTimeoutMs)) {
    throw new Error(`DreamSkin Studio did not exit after SIGKILL within ${killTimeoutMs}ms.`);
  }
  return { forced: true };
}

const DEFAULT_RUNTIME = Object.freeze({
  access: (target, mode) => fs.access(target, mode),
  createClient: (url) => new DevToolsClient(url),
  makeTempDirectory: (prefix) => fs.mkdtemp(prefix),
  platform: process.platform,
  removeDirectory: (target) => fs.rm(target, { recursive: true, force: true }),
  reservePort: availablePort,
  spawnProcess: spawn,
  stopProcess: stopChild,
  waitForRenderer: waitForTarget,
});

function appendDiagnostic(error, message) {
  if (!message) return;
  error.message = `${error.message}\n${message}`;
}

export function assertPackagedProductBootstrap(base) {
  assert.ok(base && typeof base === "object", "Packaged bootstrap result must be an object");
  assert.ok(Array.isArray(base.targetPluginIds), "Packaged bootstrap must expose target plugin ids");
  for (const pluginId of REQUIRED_PACKAGED_TARGETS) {
    assert.ok(
      base.targetPluginIds.includes(pluginId),
      `Packaged bootstrap must include ${pluginId}`,
    );
    assert.equal(
      base.info?.runtimeVersions?.[pluginId],
      base.info?.appVersion,
      `Packaged ${pluginId} runtime must match the app version`,
    );
  }
}

export async function runWorkBuddyScopedSmoke(client) {
  const result = await client.evaluate(`(async () => {
    const pluginId = "dreamskin.workbuddy";
    const created = await window.dreamskin.studio.createTheme({ kind: "blank" }, pluginId);
    const read = await window.dreamskin.studio.getTheme(created.localId, pluginId);
    const deleted = await window.dreamskin.studio.deleteTheme(
      read.localId,
      { expectedRevision: read.revisionHash },
      pluginId,
    );
    const remaining = await window.dreamskin.studio.listThemes(pluginId);
    return {
      pluginId,
      created: {
        localId: created.localId,
        pluginId: created.pluginId,
        revisionHash: created.revisionHash,
      },
      read: {
        localId: read.localId,
        pluginId: read.pluginId,
        revisionHash: read.revisionHash,
      },
      deleted,
      absentAfterDelete: !remaining.some((theme) => theme.localId === created.localId),
    };
  })()`);
  assert.equal(result.pluginId, "dreamskin.workbuddy");
  assert.equal(result.created?.pluginId, result.pluginId);
  assert.equal(result.read?.pluginId, result.pluginId);
  assert.equal(result.read?.localId, result.created?.localId);
  assert.equal(result.read?.revisionHash, result.created?.revisionHash);
  assert.equal(result.deleted?.deleted, true);
  assert.equal(result.deleted?.themeId, result.created?.localId);
  assert.equal(result.absentAfterDelete, true);
  return result;
}

export async function verifyPackagedDesktop(options = {}, dependencies = {}) {
  const runtime = { ...DEFAULT_RUNTIME, ...dependencies };
  const appPath = path.resolve(options.appPath || DEFAULT_APP);
  const agentId = options.agentId || "codex";
  const runAgent = options.runAgent !== false;
  const executable = executableFor(appPath, runtime.platform);
  let dataRoot = null;
  let logs = "";
  let child = null;
  let client = null;
  let verificationError = null;
  let verificationResult;
  let stopped = { forced: false };
  try {
    await runtime.access(executable, fs.constants.X_OK);
    dataRoot = await runtime.makeTempDirectory(path.join(os.tmpdir(), "dreamskin-packaged-e2e-"));
    const port = await runtime.reservePort();
    child = runtime.spawnProcess(executable, [
      `--user-data-dir=${dataRoot}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--enable-logging=stderr",
    ], { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    child.stdout?.on("data", (chunk) => { logs = bounded(logs, chunk); });
    child.stderr?.on("data", (chunk) => { logs = bounded(logs, chunk); });
    const target = await runtime.waitForRenderer(port, child);
    client = runtime.createClient(target.webSocketDebuggerUrl);
    await client.connect();
    await waitForStudioContext(client);
    const base = await client.evaluate(`(async () => {
      const [info, bootstrap] = await Promise.all([
        window.dreamskin.getInfo(),
        window.dreamskin.studio.bootstrap(),
      ]);
      return {
        info,
        templates: bootstrap.catalog.length,
        targetPluginIds: (bootstrap.targets || []).map((entry) => entry.pluginId),
        agent: bootstrap.agents.find((entry) => entry.id === ${JSON.stringify(agentId)}) || null,
        title: document.title,
        readyState: document.readyState,
      };
    })()`);
    assert.equal(base.info.packaged, true);
    assert.equal(base.info.resourcesVerified, true);
    assert.equal(base.info.runtimeVersion, base.info.appVersion);
    assertPackagedProductBootstrap(base);
    assert.equal(base.title, "DreamSkin Studio");
    assert.equal(base.readyState, "complete");
    assert.ok(base.templates > 0);
    const ui = await waitForStudioUi(client);
    assert.ok(ui.heading, `Studio must render a visible page heading${ui.error ? `: ${ui.error}` : ""}`);
    assert.ok(ui.cards > 0, "Studio must render theme cards");
    assert.equal(ui.horizontalOverflow, false, "Studio must not overflow the packaged viewport horizontally");

    const workBuddySmoke = runAgent ? null : await runWorkBuddyScopedSmoke(client);
    let agentResult = null;
    if (runAgent) {
      assert.equal(base.agent?.state, "detected", `${agentId} must be installed and ACP-ready`);
      agentResult = await client.evaluate(`(async () => {
        const created = await window.dreamskin.studio.createTheme({ kind: "blank" });
        await window.dreamskin.studio.connectAgent(${JSON.stringify(agentId)});
        const result = await window.dreamskin.studio.sendThemeMessage(created.localId, {
          agentId: ${JSON.stringify(agentId)},
          expectedRevision: created.revisionHash,
          prompt: "把强调色和焦点色统一改为 #2F7CF6，其他内容保持不变。",
        });
        return {
          themeId: created.localId,
          before: created.revisionHash,
          after: result.theme.revisionHash,
          accent: result.theme.theme.colors.accent,
          focus: result.theme.theme.states.focus,
          changes: result.changes,
          sessionId: result.sessionId,
          stopReason: result.stopReason,
        };
      })()`);
      assert.notEqual(agentResult.after, agentResult.before);
      assert.equal(agentResult.accent, "#2F7CF6");
      assert.equal(agentResult.focus, "#2F7CF6");
      assert.equal(agentResult.stopReason, "end_turn");
    }

    if (options.screenshotPath) {
      const reloadMarker = `dreamskin-reload-${Date.now()}`;
      await client.evaluate(`window.__dreamskinVerifierReloadMarker = ${JSON.stringify(reloadMarker)}`);
      await client.call("Page.reload", { ignoreCache: true });
      await waitForStudioContext(client, { staleMarker: reloadMarker });
      await waitForStudioUi(client);
      const screenshot = await client.call("Page.captureScreenshot", { format: "png", fromSurface: true });
      await fs.mkdir(path.dirname(options.screenshotPath), { recursive: true });
      await fs.writeFile(options.screenshotPath, Buffer.from(screenshot.data, "base64"));
    }
    verificationResult = {
      ...base,
      ui,
      workBuddySmoke,
      agentResult,
      dataRoot: options.keepData ? dataRoot : undefined,
      screenshotPath: options.screenshotPath || undefined,
    };
  } catch (error) {
    verificationError = error instanceof Error ? error : new Error(String(error));
    appendDiagnostic(verificationError, `Desktop log tail:\n${logs.trim()}`);
  } finally {
    const cleanupErrors = [];
    try {
      client?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (child) {
      try {
        stopped = await runtime.stopProcess(child);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (dataRoot && !options.keepData) {
      try {
        await runtime.removeDirectory(dataRoot);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      const diagnostic = cleanupErrors.map((error) => error?.message || String(error)).join("\n");
      if (verificationError) appendDiagnostic(verificationError, `Cleanup failure:\n${diagnostic}`);
      else verificationError = new Error(`Packaged verification cleanup failed:\n${diagnostic}`, {
        cause: cleanupErrors[0],
      });
    }
  }
  if (verificationError) {
    if (stopped.forced) verificationError.message += "\nDreamSkin Studio also required SIGKILL during cleanup.";
    throw verificationError;
  }
  if (stopped.forced) {
    throw new Error(`DreamSkin Studio did not shut down gracefully after packaged verification.\nDesktop log tail:\n${logs.trim()}`);
  }
  return verificationResult;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  verifyPackagedDesktop(parseArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
