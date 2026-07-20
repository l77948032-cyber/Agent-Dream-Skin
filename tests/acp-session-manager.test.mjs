import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import test from "node:test";

import { AcpSessionManager } from "../src/core/acp-session-manager.mjs";

function environment(server) {
  return Object.fromEntries(server.env.map((entry) => [entry.name, entry.value]));
}

function childProcess() {
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.stdin = {};
  child.stdout = {};
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.emit("exit", 0);
  };
  return child;
}

test("MCP server defaults to Node development mode under the injected project root", () => {
  const projectRoot = path.resolve("/bundle/dreamskin");
  const manager = new AcpSessionManager({
    agentRegistry: {},
    projectRoot,
    themesRoot: "/state/themes",
    dataRoot: "/state/data",
  });

  const server = manager.mcpServer("theme-one", "dreamskin.trae");
  assert.equal(server.command, process.execPath);
  assert.deepEqual(server.args, [path.join(projectRoot, "src", "mcp-server.mjs")]);
  assert.deepEqual(environment(server), {
    TRAE_DREAM_SKIN_PROJECT_ROOT: projectRoot,
    TRAE_DREAM_SKIN_THEMES_ROOT: path.resolve("/state/themes"),
    TRAE_DREAM_SKIN_TOOL_HOME: path.resolve("/state/data"),
    DREAMSKIN_TOOL_BACKUPS_ROOT: path.resolve("/state/data/backups"),
    DREAMSKIN_TOOL_PLUGIN_ID: "dreamskin.trae",
    DREAMSKIN_TOOL_THEME_ID: "theme-one",
  });
});

test("MCP server pins the Studio-selected revision and overrides an untrusted configured value", () => {
  const manager = new AcpSessionManager({
    agentRegistry: {},
    projectRoot: "/bundle",
    themesRoot: "/state/themes",
    dataRoot: "/state/data",
    mcpServerEnv: {
      DREAMSKIN_TOOL_EXPECTED_REVISION: "stale-revision",
    },
  });

  const pinned = environment(manager.mcpServer(
    "theme-one",
    "dreamskin.trae",
    "revision-selected-by-studio",
  ));
  assert.equal(pinned.DREAMSKIN_TOOL_EXPECTED_REVISION, "revision-selected-by-studio");
});

test("MCP server selects the theme repository from the composite plugin and theme scope", () => {
  const manager = new AcpSessionManager({
    agentRegistry: {},
    projectRoot: "/bundle",
    themesRoot: "/state/themes/trae",
    themeRoots: {
      "dreamskin.trae": "/state/themes/trae",
      "dreamskin.workbuddy": "/state/themes/workbuddy",
    },
    pluginRoots: {
      "dreamskin.trae": "/bundle/plugins/trae",
      "dreamskin.workbuddy": "/bundle/plugins/workbuddy",
    },
    dataRoots: {
      "dreamskin.trae": "/state/data/trae",
      "dreamskin.workbuddy": "/state/data/workbuddy",
    },
    backupRoots: {
      "dreamskin.trae": "/state/backups/trae",
      "dreamskin.workbuddy": "/state/backups/workbuddy",
    },
    dataRoot: "/state/data",
  });

  const trae = environment(manager.mcpServer("shared-theme", "dreamskin.trae"));
  const workBuddy = environment(manager.mcpServer("shared-theme", "dreamskin.workbuddy"));
  assert.equal(trae.TRAE_DREAM_SKIN_THEMES_ROOT, path.resolve("/state/themes/trae"));
  assert.equal(workBuddy.TRAE_DREAM_SKIN_THEMES_ROOT, path.resolve("/state/themes/workbuddy"));
  assert.equal(workBuddy.DREAMSKIN_TOOL_PLUGIN_ROOT, path.resolve("/bundle/plugins/workbuddy"));
  assert.equal(workBuddy.DREAMSKIN_TOOL_PLUGIN_ID, "dreamskin.workbuddy");
  assert.equal(workBuddy.DREAMSKIN_TOOL_THEME_ID, "shared-theme");
  assert.equal(trae.TRAE_DREAM_SKIN_TOOL_HOME, path.resolve("/state/data/trae"));
  assert.equal(workBuddy.TRAE_DREAM_SKIN_TOOL_HOME, path.resolve("/state/data/workbuddy"));
  assert.equal(trae.DREAMSKIN_TOOL_BACKUPS_ROOT, path.resolve("/state/backups/trae"));
  assert.equal(workBuddy.DREAMSKIN_TOOL_BACKUPS_ROOT, path.resolve("/state/backups/workbuddy"));
});

test("MCP server accepts an Electron executable, arguments, and node-mode environment", () => {
  const manager = new AcpSessionManager({
    agentRegistry: {},
    projectRoot: "/Applications/DreamSkin Studio.app/Contents/Resources/app",
    themesRoot: "/Users/test/Library/Application Support/DreamSkin/themes",
    dataRoot: "/Users/test/Library/Application Support/DreamSkin/state",
    mcpServerPath: "helpers/mcp-server.mjs",
    mcpServerCommand: "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio",
    mcpServerArgs: ["/Applications/DreamSkin Studio.app/Contents/Resources/app/helpers/mcp-server.mjs"],
    mcpServerEnv: {
      ELECTRON_RUN_AS_NODE: "1",
      DREAMSKIN_DESKTOP: "1",
      DREAMSKIN_MCP_ENTRY: "1",
      DREAMSKIN_TOOL_PLUGIN_ROOT: "/Applications/DreamSkin Studio.app/Contents/Resources/dreamskin/plugins/trae",
      DREAMSKIN_TOOL_THEME_ID: "must-not-override-scope",
    },
  });

  const server = manager.mcpServer("selected-theme", "dreamskin.trae");
  const env = environment(server);
  assert.equal(server.command, "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio");
  assert.deepEqual(server.args, ["/Applications/DreamSkin Studio.app/Contents/Resources/app/helpers/mcp-server.mjs"]);
  assert.equal(manager.mcpServerPath, "/Applications/DreamSkin Studio.app/Contents/Resources/app/helpers/mcp-server.mjs");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.DREAMSKIN_DESKTOP, "1");
  assert.equal(env.DREAMSKIN_MCP_ENTRY, "1");
  assert.equal(env.DREAMSKIN_TOOL_PLUGIN_ROOT, "/Applications/DreamSkin Studio.app/Contents/Resources/dreamskin/plugins/trae");
  assert.equal(env.DREAMSKIN_TOOL_THEME_ID, "selected-theme");
});

test("MCP server can launch a standalone helper without appending the development entry", () => {
  const manager = new AcpSessionManager({
    agentRegistry: {},
    projectRoot: "/bundle",
    mcpServerCommand: "/bundle/helpers/dreamskin-mcp",
    mcpServerArgs: ["--stdio"],
  });

  const server = manager.mcpServer("theme-one");
  assert.equal(server.command, "/bundle/helpers/dreamskin-mcp");
  assert.deepEqual(server.args, ["--stdio"]);
});

test("Codex ACP always receives the detected CLI path and an injected GUI PATH without a shell", async () => {
  const spawnCalls = [];
  const child = childProcess();
  const agent = {
    id: "codex",
    name: "Codex CLI",
    capabilities: { acp: true },
    runtime: {
      commandPath: "/opt/homebrew/bin/codex",
      adapterPath: "/bundle/node_modules/.bin/codex-acp",
      adapterArgs: ["--stdio"],
      envPath: "/registry/path",
    },
  };
  const connection = {
    signal: new AbortController().signal,
    closed: new Promise(() => {}),
    initialize: async () => ({ protocolVersion: 1 }),
  };
  const manager = new AcpSessionManager({
    agentRegistry: { resolve: async () => agent },
    projectRoot: "/bundle",
    environment: {
      PATH: "/inherited/path",
      DREAMSKIN_CODEX_PATH: "/wrong/codex",
      CODEX_PATH: "/also/wrong/codex",
    },
    envPath: "/gui/injected/path",
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
    createConnection: (client, receivedChild) => {
      assert.equal(typeof client, "function");
      assert.equal(receivedChild, child);
      return connection;
    },
  });

  await manager.connectFresh("codex");
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, agent.runtime.adapterPath);
  assert.deepEqual(spawnCalls[0].args, ["--stdio"]);
  assert.equal(spawnCalls[0].options.cwd, path.resolve("/bundle"));
  assert.equal(spawnCalls[0].options.env.PATH, "/gui/injected/path");
  assert.equal(spawnCalls[0].options.env.CODEX_PATH, "/opt/homebrew/bin/codex");
  assert.equal(spawnCalls[0].options.shell, false);
  assert.equal(spawnCalls[0].options.detached, true);
});

test("packaged ACP launcher can run a physical adapter through Electron node mode", async () => {
  const spawnCalls = [];
  const child = childProcess();
  const agent = {
    id: "codex",
    name: "Codex CLI",
    capabilities: { acp: true },
    runtime: {
      commandPath: "/opt/homebrew/bin/codex",
      adapterPath: "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio",
      adapterArgs: [],
      envPath: "/opt/homebrew/bin:/usr/bin",
    },
  };
  const connection = {
    signal: new AbortController().signal,
    closed: new Promise(() => {}),
    initialize: async () => ({ protocolVersion: 1 }),
  };
  const manager = new AcpSessionManager({
    agentRegistry: { resolve: async () => agent },
    projectRoot: "/Applications/DreamSkin Studio.app/Contents/Resources/app.asar",
    adapterLaunchers: {
      codex: {
        command: "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio",
        args: ["/Applications/DreamSkin Studio.app/Contents/Resources/dreamskin/acp/codex-acp.mjs"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      },
    },
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      return child;
    },
    createConnection: () => connection,
  });

  await manager.connectFresh("codex");
  assert.equal(spawnCalls[0].command, "/Applications/DreamSkin Studio.app/Contents/MacOS/DreamSkin Studio");
  assert.deepEqual(spawnCalls[0].args, [
    "/Applications/DreamSkin Studio.app/Contents/Resources/dreamskin/acp/codex-acp.mjs",
  ]);
  assert.equal(spawnCalls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(spawnCalls[0].options.env.CODEX_PATH, "/opt/homebrew/bin/codex");
  assert.equal(spawnCalls[0].options.shell, false);
});

test("ACP sessions deduplicate a concurrent revision, accept its successor, and roll over on a new revision", async () => {
  const requests = [];
  const state = {
    agent: { name: "Codex CLI" },
    child: { exitCode: null },
    connection: {
      signal: new AbortController().signal,
      newSession: async (request) => {
        requests.push(request);
        return { sessionId: `session-${requests.length}` };
      },
    },
    initialized: { protocolVersion: 1 },
    sessions: new Map(),
    sessionPromises: new Map(),
    sessionPolicies: new Map(),
    updates: new Map(),
    stderr: () => "",
  };
  const manager = new AcpSessionManager({
    agentRegistry: {},
    projectRoot: "/bundle",
  });
  manager.connections.set("codex", state);

  const [first, duplicate] = await Promise.all([
    manager.session("codex", "selected", "dreamskin.trae", "revision-1"),
    manager.session("codex", "selected", "dreamskin.trae", "revision-1"),
  ]);
  assert.equal(requests.length, 1);
  assert.strictEqual(first.session, duplicate.session);
  assert.equal(
    environment(requests[0].mcpServers[0]).DREAMSKIN_TOOL_EXPECTED_REVISION,
    "revision-1",
  );

  assert.equal(manager.acceptRevision({
    agentId: "codex",
    pluginId: "dreamskin.trae",
    themeId: "selected",
    sessionId: first.session.sessionId,
    revision: "revision-2",
  }), true);
  const accepted = await manager.session("codex", "selected", "dreamskin.trae", "revision-2");
  assert.strictEqual(accepted.session, first.session);
  assert.equal(requests.length, 1);
  assert.deepEqual(state.sessionPolicies.get(first.session.sessionId), {
    pluginId: "dreamskin.trae",
    themeId: "selected",
    expectedRevision: "revision-2",
  });

  const rolled = await manager.session("codex", "selected", "dreamskin.trae", "revision-3");
  assert.notStrictEqual(rolled.session, first.session);
  assert.equal(rolled.session.sessionId, "session-2");
  assert.equal(rolled.session.expectedRevision, "revision-3");
  assert.equal(requests.length, 2);
  assert.equal(
    environment(requests[1].mcpServers[0]).DREAMSKIN_TOOL_EXPECTED_REVISION,
    "revision-3",
  );
  assert.equal(state.sessionPolicies.has(first.session.sessionId), false);
});

test("concurrent requests for different revisions serialize without sharing an ACP session", async () => {
  const pending = [];
  const state = {
    agent: { name: "Codex CLI" },
    child: { exitCode: null },
    connection: {
      signal: new AbortController().signal,
      newSession: (request) => new Promise((resolve) => pending.push({ request, resolve })),
    },
    initialized: { protocolVersion: 1 },
    sessions: new Map(),
    sessionPromises: new Map(),
    sessionPolicies: new Map(),
    updates: new Map(),
    stderr: () => "",
  };
  const manager = new AcpSessionManager({ agentRegistry: {}, projectRoot: "/bundle" });
  manager.connections.set("codex", state);

  const revisionA = manager.session("codex", "selected", "dreamskin.trae", "revision-a");
  const revisionB = manager.session("codex", "selected", "dreamskin.trae", "revision-b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);
  assert.equal(
    environment(pending[0].request.mcpServers[0]).DREAMSKIN_TOOL_EXPECTED_REVISION,
    "revision-a",
  );

  pending[0].resolve({ sessionId: "session-a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 2);
  assert.equal(
    environment(pending[1].request.mcpServers[0]).DREAMSKIN_TOOL_EXPECTED_REVISION,
    "revision-b",
  );
  pending[1].resolve({ sessionId: "session-b" });
  const [createdA, createdB] = await Promise.all([revisionA, revisionB]);
  assert.equal(createdA.session.sessionId, "session-a");
  assert.equal(createdA.session.expectedRevision, "revision-a");
  assert.equal(createdB.session.sessionId, "session-b");
  assert.equal(createdB.session.expectedRevision, "revision-b");
  assert.notStrictEqual(createdA.session, createdB.session);
});

test("POSIX shutdown signals the entire ACP process group and escalates once", async () => {
  const signals = [];
  let groupAlive = true;
  const child = {
    pid: 4242,
    exitCode: null,
    kill: () => assert.fail("POSIX group shutdown must not target only the adapter process"),
  };
  const manager = new AcpSessionManager({
    agentRegistry: {},
    platform: "darwin",
    terminationGraceMs: 0,
    terminationForceMs: 0,
    killProcess: (pid, signal) => {
      assert.equal(pid, -child.pid);
      signals.push(signal);
      if (signal === 0 && !groupAlive) {
        const error = new Error("No such process group");
        error.code = "ESRCH";
        throw error;
      }
      if (signal === "SIGKILL") groupAlive = false;
    },
  });
  const state = {
    child,
    processGroup: true,
    terminating: false,
    terminationPromise: null,
  };

  const first = manager.terminateState(state);
  const duplicate = manager.terminateState(state);
  assert.strictEqual(first, duplicate);
  await first;
  assert.deepEqual(signals, ["SIGTERM", 0, "SIGKILL", 0]);
  assert.equal(state.terminating, false);
});

test("an unexpectedly exited POSIX adapter still cleans up its living process group", async () => {
  const signals = [];
  let groupAlive = true;
  const child = childProcess();
  child.pid = 5252;
  child.kill = () => assert.fail("orphan cleanup must target the detached process group");
  const agent = {
    id: "codex",
    name: "Codex CLI",
    capabilities: { acp: true },
    runtime: {
      commandPath: "/opt/homebrew/bin/codex",
      adapterPath: "/bundle/node_modules/.bin/codex-acp",
      adapterArgs: ["--stdio"],
    },
  };
  const connection = {
    signal: new AbortController().signal,
    closed: Promise.resolve(),
    initialize: async () => ({ protocolVersion: 1 }),
  };
  const manager = new AcpSessionManager({
    agentRegistry: { resolve: async () => agent },
    projectRoot: "/bundle",
    platform: "darwin",
    terminationGraceMs: 0,
    terminationForceMs: 0,
    spawnProcess: () => child,
    createConnection: () => connection,
    killProcess: (pid, signal) => {
      assert.equal(pid, -child.pid);
      signals.push(signal);
      if (signal === 0 && !groupAlive) {
        const error = new Error("No such process group");
        error.code = "ESRCH";
        throw error;
      }
      if (signal === "SIGKILL") groupAlive = false;
    },
  });

  const state = await manager.connectFresh("codex");
  assert.strictEqual(manager.connections.get("codex"), state);
  child.exitCode = 1;
  child.emit("exit", 1);
  for (let attempt = 0; attempt < 10 && manager.connections.has("codex"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(manager.connections.has("codex"), false);
  assert.equal(groupAlive, false);
  assert.deepEqual(signals, [0, "SIGTERM", 0, "SIGKILL", 0]);
});

test("an old adapter exit cannot clear a newly selected connection with the same agent id", async () => {
  const child = childProcess();
  child.pid = 6262;
  const agent = {
    id: "codex",
    name: "Codex CLI",
    capabilities: { acp: true },
    runtime: {
      commandPath: "/opt/homebrew/bin/codex",
      adapterPath: "/bundle/node_modules/.bin/codex-acp",
      adapterArgs: ["--stdio"],
    },
  };
  const connection = {
    signal: new AbortController().signal,
    closed: Promise.resolve(),
    initialize: async () => ({ protocolVersion: 1 }),
  };
  let finishCleanup;
  const cleanupGate = new Promise((resolve) => { finishCleanup = resolve; });
  const manager = new AcpSessionManager({
    agentRegistry: { resolve: async () => agent },
    projectRoot: "/bundle",
    platform: "darwin",
    spawnProcess: () => child,
    createConnection: () => connection,
    killProcess: () => {},
  });
  manager.waitForTermination = () => cleanupGate;

  const oldState = await manager.connect("codex");
  assert.equal(manager.selectedAgentId, "codex");
  child.exitCode = 1;
  child.emit("exit", 1);
  for (let attempt = 0; attempt < 10 && !oldState.terminationPromise; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(oldState.terminationPromise);

  const replacementState = { agent: { id: "codex" }, marker: "replacement" };
  manager.connections.set("codex", replacementState);
  manager.selectedAgentId = "codex";
  finishCleanup(true);
  await oldState.terminationPromise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.strictEqual(manager.connections.get("codex"), replacementState);
  assert.equal(manager.selectedAgentId, "codex");
});

test("Windows shutdown uses taskkill for the process tree before forcing it", async () => {
  const calls = [];
  const childSignals = [];
  const manager = new AcpSessionManager({
    agentRegistry: {},
    platform: "win32",
    runFile: async (...args) => { calls.push(args); },
  });
  let terminationChecks = 0;
  manager.waitForTermination = async () => {
    terminationChecks += 1;
    return terminationChecks > 1;
  };
  const state = {
    child: {
      pid: 31337,
      exitCode: null,
      kill: (signal) => childSignals.push(signal),
    },
    processGroup: false,
    terminating: false,
    terminationPromise: null,
  };

  await manager.terminateState(state);
  assert.deepEqual(calls, [
    ["taskkill", ["/PID", "31337", "/T"], { windowsHide: true, shell: false }],
    ["taskkill", ["/PID", "31337", "/T", "/F"], { windowsHide: true, shell: false }],
  ]);
  assert.deepEqual(childSignals, []);
});
