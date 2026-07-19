import { execFile as execFileCallback, spawn } from "node:child_process";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { promisify } from "node:util";

import * as acp from "@agentclientprotocol/sdk";

import { agentResponseFailure, agentResponseText, permissionResponse } from "./acp-policy.mjs";
import { ToolError } from "./errors.mjs";
import { PROJECT_ROOT, STUDIO_DATA_ROOT, STUDIO_THEMES_ROOT } from "./paths.mjs";

const execFile = promisify(execFileCallback);

function withTimeout(promise, milliseconds, code, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(code, message)), milliseconds);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function appendBounded(current, chunk, maximum = 16 * 1024) {
  const combined = `${current}${chunk}`;
  return combined.length > maximum ? combined.slice(-maximum) : combined;
}

function createAcpConnection(client, child) {
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  return new acp.ClientSideConnection(client, stream);
}

function environmentEntries(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input.map((entry) => ({ name: String(entry.name), value: String(entry.value) }));
  }
  if (typeof input === "object") {
    return Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([name, value]) => ({ name, value: String(value) }));
  }
  throw new ToolError("INVALID_ARGUMENT", "MCP server environment must be an object or name/value array.");
}

function mergeEnvironmentEntries(extra, required) {
  const values = new Map();
  for (const entry of [...environmentEntries(extra), ...required]) values.set(entry.name, entry.value);
  return [...values].map(([name, value]) => ({ name, value }));
}

function configuredLauncher(launchers, agentId) {
  const launcher = launchers instanceof Map ? launchers.get(agentId) : launchers?.[agentId];
  if (!launcher) return null;
  if (
    typeof launcher !== "object"
    || typeof launcher.command !== "string"
    || !launcher.command
    || (launcher.args !== undefined && (!Array.isArray(launcher.args) || launcher.args.some((arg) => typeof arg !== "string")))
    || (launcher.env !== undefined && (!launcher.env || typeof launcher.env !== "object" || Array.isArray(launcher.env)))
  ) {
    throw new ToolError("INVALID_ARGUMENT", `ACP launcher for '${agentId}' is invalid.`);
  }
  return launcher;
}

export class AcpSessionManager {
  constructor({
    agentRegistry,
    projectRoot = PROJECT_ROOT,
    themesRoot = STUDIO_THEMES_ROOT,
    dataRoot = STUDIO_DATA_ROOT,
    mcpServerPath,
    mcpServerCommand = process.execPath,
    mcpServerArgs,
    mcpServerEnv = {},
    environment = process.env,
    envPath,
    adapterLaunchers = {},
    spawnProcess = spawn,
    createConnection = createAcpConnection,
    platform = process.platform,
    killProcess = process.kill,
    runFile = execFile,
    terminationGraceMs = 2000,
    terminationForceMs = 2000,
  }) {
    this.agentRegistry = agentRegistry;
    this.projectRoot = path.resolve(projectRoot);
    this.themesRoot = path.resolve(themesRoot);
    this.dataRoot = path.resolve(dataRoot);
    this.mcpServerPath = mcpServerPath
      ? path.resolve(this.projectRoot, mcpServerPath)
      : path.join(this.projectRoot, "src", "mcp-server.mjs");
    this.mcpServerCommand = mcpServerCommand;
    this.mcpServerArgs = mcpServerArgs ? [...mcpServerArgs] : [this.mcpServerPath];
    this.mcpServerEnv = mcpServerEnv;
    this.environment = environment;
    this.envPath = envPath;
    this.adapterLaunchers = adapterLaunchers;
    this.spawnProcess = spawnProcess;
    this.createConnection = createConnection;
    this.platform = platform;
    this.killProcess = killProcess;
    this.runFile = runFile;
    this.terminationGraceMs = terminationGraceMs;
    this.terminationForceMs = terminationForceMs;
    this.connections = new Map();
    this.connectionPromises = new Map();
    this.selectedAgentId = null;
  }

  connectionState() {
    return {
      agentId: this.selectedAgentId,
      state: this.selectedAgentId ? "connected" : "disconnected",
    };
  }

  async agents() {
    const scanned = await this.agentRegistry.scan();
    return scanned.map((agent) => this.agentRegistry.public(agent, this.selectedAgentId));
  }

  async connect(agentId) {
    const current = this.connections.get(agentId);
    if (current?.initialized && !current.connection.signal.aborted && current.child.exitCode === null) {
      this.selectedAgentId = agentId;
      return current;
    }
    const pending = this.connectionPromises.get(agentId);
    if (pending) {
      const state = await pending;
      this.selectedAgentId = agentId;
      return state;
    }
    const operation = this.connectFresh(agentId);
    this.connectionPromises.set(agentId, operation);
    try {
      const state = await operation;
      this.selectedAgentId = agentId;
      return state;
    } finally {
      if (this.connectionPromises.get(agentId) === operation) this.connectionPromises.delete(agentId);
    }
  }

  async connectFresh(agentId) {
    const agent = await this.agentRegistry.resolve(agentId);
    if (!agent || !agent.capabilities.acp || !agent.runtime.adapterPath) {
      throw new ToolError("AGENT_UNAVAILABLE", `Agent '${agentId}' is not available through ACP.`);
    }

    const launcher = configuredLauncher(this.adapterLaunchers, agentId);
    const env = { ...this.environment, ...(launcher?.env || {}) };
    const searchPath = this.envPath || agent.runtime.envPath || env.PATH;
    if (searchPath) env.PATH = searchPath;
    if (agentId === "codex") env.CODEX_PATH = agent.runtime.commandPath;
    const child = this.spawnProcess(
      launcher?.command || agent.runtime.adapterPath,
      launcher?.args ? [...launcher.args] : agent.runtime.adapterArgs,
      {
      cwd: this.projectRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: this.platform !== "win32",
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => { stderr = appendBounded(stderr, error.message); });

    const updates = new Map();
    const knownToolCalls = new Map();
    const sessionPolicies = new Map();
    const connection = this.createConnection(() => ({
      requestPermission: async (params) => {
        const known = knownToolCalls.get(params.toolCall.toolCallId) || {};
        return permissionResponse({
          ...params,
          toolCall: {
            ...known,
            ...params.toolCall,
          },
        }, sessionPolicies.get(params.sessionId || known.sessionId));
      },
      sessionUpdate: async (params) => {
        if (params.update?.sessionUpdate === "tool_call") {
          knownToolCalls.set(params.update.toolCallId, { ...params.update, sessionId: params.sessionId });
        } else if (params.update?.sessionUpdate === "tool_call_update") {
          const previous = knownToolCalls.get(params.update.toolCallId) || {};
          knownToolCalls.set(params.update.toolCallId, { ...previous, ...params.update, sessionId: params.sessionId });
        }
        const target = updates.get(params.sessionId);
        if (target) target.push(params.update);
      },
    }), child);
    const state = {
      agent,
      child,
      connection,
      initialized: null,
      sessions: new Map(),
      sessionPromises: new Map(),
      sessionPolicies,
      updates,
      stderr: () => stderr,
      processGroup: this.platform !== "win32" && Number.isInteger(child.pid) && child.pid > 0,
      terminating: false,
      terminationPromise: null,
    };
    this.connections.set(agentId, state);
    child.once("exit", () => {
      const finalize = async () => {
        if (!state.terminating && state.processGroup && this.processGroupAlive(state)) {
          await this.terminateState(state);
        }
        if (this.connections.get(agentId) === state) {
          this.connections.delete(agentId);
          if (this.selectedAgentId === agentId) this.selectedAgentId = null;
        }
      };
      void finalize().catch(() => {
        if (this.connections.get(agentId) === state) {
          this.connections.delete(agentId);
          if (this.selectedAgentId === agentId) this.selectedAgentId = null;
        }
      });
    });

    try {
      state.initialized = await withTimeout(connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "dreamskin-studio", version: "0.2.0" },
      }), 20_000, "AGENT_CONNECT_TIMEOUT", `${agent.name} did not finish the ACP handshake.`);
    } catch (error) {
      await this.terminateState(state);
      this.connections.delete(agentId);
      throw new ToolError("AGENT_CONNECT_FAILED", `${agent.name} could not be connected.`, {
        cause: error.message,
        stderr: stderr.trim().slice(-4000),
      });
    }
    return state;
  }

  mcpServer(themeId, pluginId = "dreamskin.trae", expectedRevision = null) {
    const requiredEnvironment = [
      { name: "TRAE_DREAM_SKIN_PROJECT_ROOT", value: this.projectRoot },
      { name: "TRAE_DREAM_SKIN_THEMES_ROOT", value: this.themesRoot },
      { name: "TRAE_DREAM_SKIN_TOOL_HOME", value: this.dataRoot },
      { name: "DREAMSKIN_TOOL_PLUGIN_ID", value: pluginId },
      { name: "DREAMSKIN_TOOL_THEME_ID", value: themeId },
      ...(expectedRevision ? [{ name: "DREAMSKIN_TOOL_EXPECTED_REVISION", value: expectedRevision }] : []),
    ];
    return {
      name: "dreamskin-tool-compat",
      command: this.mcpServerCommand,
      args: [...this.mcpServerArgs],
      env: mergeEnvironmentEntries(this.mcpServerEnv, requiredEnvironment),
    };
  }

  async session(agentId, themeId, pluginId = "dreamskin.trae", expectedRevision = null) {
    const state = await this.connect(agentId);
    const sessionKey = `${pluginId}:${themeId}`;
    while (true) {
      const existing = state.sessions.get(sessionKey);
      if (existing && (!expectedRevision || existing.expectedRevision === expectedRevision)) {
        return { state, session: existing };
      }
      if (existing) {
        state.sessions.delete(sessionKey);
        state.sessionPolicies.delete(existing.sessionId);
      }
      const pending = state.sessionPromises.get(sessionKey);
      if (pending) {
        await pending;
        continue;
      }
      const operation = this.createSession(state, themeId, pluginId, expectedRevision);
      state.sessionPromises.set(sessionKey, operation);
      try {
        return { state, session: await operation };
      } finally {
        if (state.sessionPromises.get(sessionKey) === operation) state.sessionPromises.delete(sessionKey);
      }
    }
  }

  async createSession(state, themeId, pluginId, expectedRevision = null) {
    let created;
    try {
      created = await withTimeout(state.connection.newSession({
        cwd: this.projectRoot,
        mcpServers: [this.mcpServer(themeId, pluginId, expectedRevision)],
      }), 45_000, "AGENT_SESSION_TIMEOUT", `${state.agent.name} did not create an ACP session.`);
    } catch (error) {
      throw new ToolError("AGENT_SESSION_FAILED", `${state.agent.name} could not start a theme session.`, {
        cause: error.message,
        stderr: state.stderr().trim().slice(-4000),
      });
    }
    const session = {
      sessionId: created.sessionId,
      promptQueue: Promise.resolve(),
      policy: { pluginId, themeId, expectedRevision: null },
      expectedRevision,
    };
    state.sessions.set(`${pluginId}:${themeId}`, session);
    state.sessionPolicies.set(session.sessionId, session.policy);
    return session;
  }

  async terminateConnection(agentId, state) {
    if (this.connections.get(agentId) === state) this.connections.delete(agentId);
    if (this.selectedAgentId === agentId) this.selectedAgentId = null;
    await this.terminateState(state);
    await withTimeout(
      state.connection.closed,
      2000,
      "AGENT_CLOSE_TIMEOUT",
      "ACP connection did not close promptly.",
    ).catch(() => {});
  }

  async prompt({
    agentId,
    themeId,
    prompt,
    context,
    expectedRevision,
    pluginId = "dreamskin.trae",
  }) {
    const { state, session } = await this.session(agentId, themeId, pluginId, expectedRevision);
    const run = async () => {
      const updates = [];
      state.updates.set(session.sessionId, updates);
      session.policy = { pluginId, themeId, expectedRevision };
      state.sessionPolicies.set(session.sessionId, session.policy);
      const promptRequest = state.connection.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: `${context}\n\nUser request:\n${prompt}` }],
      });
      try {
        const response = await withTimeout(
          promptRequest,
          5 * 60_000,
          "AGENT_PROMPT_TIMEOUT",
          `${state.agent.name} did not finish the request.`,
        );
        const failure = agentResponseFailure(updates);
        if (failure) {
          throw new ToolError("AGENT_RESPONSE_ERROR", failure, {
            agentId,
            sessionId: session.sessionId,
          });
        }
        return {
          response,
          updates,
          text: agentResponseText(updates),
          agentId,
          sessionId: session.sessionId,
        };
      } catch (error) {
        if (error.code === "AGENT_PROMPT_TIMEOUT") {
          try {
            await state.connection.cancel({ sessionId: session.sessionId });
            await withTimeout(
              promptRequest,
              10_000,
              "AGENT_CANCEL_TIMEOUT",
              `${state.agent.name} did not stop the cancelled request.`,
            );
          } catch {
            await this.terminateConnection(agentId, state);
          }
          throw error;
        }
        throw new ToolError("AGENT_PROMPT_FAILED", `${state.agent.name} could not finish the theme change.`, {
          cause: error.message,
          stderr: state.stderr().trim().slice(-4000),
        });
      } finally {
        state.updates.delete(session.sessionId);
      }
    };

    const operation = session.promptQueue.then(run, run);
    session.promptQueue = operation.catch(() => {});
    return operation;
  }

  acceptRevision({ agentId, themeId, pluginId = "dreamskin.trae", sessionId, revision }) {
    if (typeof revision !== "string" || !revision) return false;
    const state = this.connections.get(agentId);
    const session = state?.sessions.get(`${pluginId}:${themeId}`);
    if (!session || session.sessionId !== sessionId) return false;
    session.expectedRevision = revision;
    session.policy = { pluginId, themeId, expectedRevision: revision };
    state.sessionPolicies.set(session.sessionId, session.policy);
    return true;
  }

  async waitForExit(child, milliseconds) {
    if (child.exitCode !== null) return true;
    return Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref?.();
      }),
    ]);
  }

  processGroupAlive(state) {
    if (!state.processGroup) return state.child.exitCode === null;
    try {
      this.killProcess(-state.child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      if (error.code === "EPERM") return true;
      throw error;
    }
  }

  async waitForTermination(state, milliseconds) {
    if (!state.processGroup) return this.waitForExit(state.child, milliseconds);
    const deadline = Date.now() + milliseconds;
    while (this.processGroupAlive(state)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
    }
    return true;
  }

  signalState(state, signal) {
    if (state.processGroup) {
      try {
        this.killProcess(-state.child.pid, signal);
        return true;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (state.child.exitCode === null) return state.child.kill(signal);
    return false;
  }

  terminateState(state) {
    if (state.terminationPromise) return state.terminationPromise;
    state.terminating = true;
    state.terminationPromise = (async () => {
      if (this.platform === "win32" && Number.isInteger(state.child.pid) && state.child.pid > 0) {
        await this.runFile("taskkill", ["/PID", String(state.child.pid), "/T"], {
          windowsHide: true,
          shell: false,
        }).catch(() => state.child.kill("SIGTERM"));
      } else if (this.platform === "win32" && state.child.exitCode === null) {
        state.child.kill("SIGTERM");
      } else {
        this.signalState(state, "SIGTERM");
      }
      if (await this.waitForTermination(state, this.terminationGraceMs)) return;
      if (this.platform === "win32" && Number.isInteger(state.child.pid) && state.child.pid > 0) {
        await this.runFile("taskkill", ["/PID", String(state.child.pid), "/T", "/F"], {
          windowsHide: true,
          shell: false,
        }).catch(() => state.child.kill("SIGKILL"));
      } else {
        this.signalState(state, "SIGKILL");
      }
      await this.waitForTermination(state, this.terminationForceMs);
    })().finally(() => {
      state.terminating = false;
    });
    return state.terminationPromise;
  }

  async close() {
    const states = [...this.connections.values()];
    this.connections.clear();
    this.connectionPromises.clear();
    this.selectedAgentId = null;
    await Promise.allSettled(states.map((state) => this.terminateState(state)));
    await Promise.allSettled(states.map((state) => withTimeout(
      state.connection.closed,
      2000,
      "AGENT_CLOSE_TIMEOUT",
      "ACP connection did not close promptly.",
    )));
  }
}
