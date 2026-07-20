import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "node:vm";

import {
  DevToolsClient,
  REQUIRED_PACKAGED_TARGETS,
  assertPackagedProductBootstrap,
  runWorkBuddyScopedSmoke,
  stopChild,
  verifyPackagedDesktop,
  waitForStudioContext,
} from "../scripts/verify-packaged-desktop.mjs";

class SilentWebSocket extends EventTarget {
  static OPEN = 1;

  constructor() {
    super();
    this.readyState = 0;
  }

  close() {
    this.readyState = 3;
  }

  send() {}
}

class OpenWebSocket extends SilentWebSocket {
  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = OpenWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }
}

class ProtocolErrorWebSocket extends OpenWebSocket {
  send(payload, callback) {
    callback?.();
    const { id } = JSON.parse(payload);
    queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
      data: JSON.stringify({
        id,
        error: { code: -32000, message: "Cannot find default execution context", data: "frame pending" },
      }),
    })));
  }
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  return child;
}

test("packaged verifier requires both product targets and their matching runtimes", () => {
  const base = {
    info: {
      appVersion: "0.2.0",
      runtimeVersions: {
        "dreamskin.trae": "0.2.0",
        "dreamskin.workbuddy": "0.2.0",
      },
    },
    targetPluginIds: [...REQUIRED_PACKAGED_TARGETS],
  };
  assert.doesNotThrow(() => assertPackagedProductBootstrap(base));

  assert.throws(
    () => assertPackagedProductBootstrap({
      ...base,
      targetPluginIds: ["dreamskin.trae"],
    }),
    /must include dreamskin\.workbuddy/,
  );
  assert.throws(
    () => assertPackagedProductBootstrap({
      ...base,
      info: {
        ...base.info,
        runtimeVersions: {
          ...base.info.runtimeVersions,
          "dreamskin.workbuddy": null,
        },
      },
    }),
    /dreamskin\.workbuddy runtime must match the app version/,
  );
});

test("skip-agent smoke creates, reads, and deletes a blank WorkBuddy theme without applying it", async () => {
  const calls = [];
  let theme = null;
  const studio = {
    createTheme: async (input, pluginId) => {
      calls.push(["create", input, pluginId]);
      theme = {
        localId: "blank-workbuddy-fixture",
        pluginId,
        revisionHash: "revision-one",
      };
      return theme;
    },
    getTheme: async (themeId, pluginId) => {
      calls.push(["read", themeId, pluginId]);
      return { ...theme };
    },
    deleteTheme: async (themeId, input, pluginId) => {
      calls.push(["delete", themeId, input, pluginId]);
      theme = null;
      return { deleted: true, themeId };
    },
    listThemes: async (pluginId) => {
      calls.push(["list", pluginId]);
      return theme ? [theme] : [];
    },
    applyTheme: async () => assert.fail("packaged CRUD smoke must not apply a theme"),
  };
  const client = {
    evaluate: (expression) => vm.runInNewContext(expression, {
      window: { dreamskin: { studio } },
    }),
  };

  const result = await runWorkBuddyScopedSmoke(client);
  assert.equal(result.absentAfterDelete, true);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["create", { kind: "blank" }, "dreamskin.workbuddy"],
    ["read", "blank-workbuddy-fixture", "dreamskin.workbuddy"],
    ["delete", "blank-workbuddy-fixture", { expectedRevision: "revision-one" }, "dreamskin.workbuddy"],
    ["list", "dreamskin.workbuddy"],
  ]);
});

test("packaged verifier always stops the app and removes temp data after renderer discovery fails", async () => {
  const child = fakeChild();
  const original = new Error("renderer discovery failed");
  const calls = [];

  await assert.rejects(() => verifyPackagedDesktop({
    appPath: "/tmp/DreamSkin Studio.app",
    runAgent: false,
  }, {
    platform: "darwin",
    access: async () => {},
    makeTempDirectory: async () => "/tmp/dreamskin-verifier-fixture",
    reservePort: async () => 43123,
    spawnProcess: (_command, args) => {
      calls.push(["spawn", args]);
      return child;
    },
    waitForRenderer: async () => {
      child.stderr.emit("data", "startup diagnostic\n");
      throw original;
    },
    stopProcess: async (target) => {
      assert.equal(target, child);
      calls.push(["stop"]);
      return { forced: false };
    },
    removeDirectory: async (target) => {
      calls.push(["remove", target]);
    },
  }), (error) => {
    assert.equal(error, original);
    assert.match(error.message, /renderer discovery failed/);
    assert.match(error.message, /startup diagnostic/);
    return true;
  });

  assert.deepEqual(calls.map(([operation]) => operation), ["spawn", "stop", "remove"]);
  assert.equal(calls[2][1], "/tmp/dreamskin-verifier-fixture");
});

test("packaged verifier preserves a caller-owned data root for restart checks", async () => {
  const child = fakeChild();
  const calls = [];
  const dataRoot = "/tmp/dreamskin-caller-owned-user-data";

  await assert.rejects(() => verifyPackagedDesktop({
    appPath: "/tmp/DreamSkin Studio.app",
    dataRoot,
    runAgent: false,
  }, {
    platform: "darwin",
    access: async () => {},
    ensureDirectory: async (target) => calls.push(["ensure", target]),
    makeTempDirectory: async () => assert.fail("caller-owned data must not create a temporary root"),
    reservePort: async () => 43123,
    spawnProcess: () => child,
    waitForRenderer: async () => { throw new Error("expected discovery failure"); },
    stopProcess: async () => {
      calls.push(["stop"]);
      return { forced: false };
    },
    removeDirectory: async () => assert.fail("caller-owned data must not be removed"),
  }), /expected discovery failure/);

  assert.deepEqual(calls, [
    ["ensure", dataRoot],
    ["stop"],
  ]);
});

test("packaged verifier retains the primary error when cleanup also fails", async () => {
  const primary = new Error("primary verification failure");
  const child = fakeChild();

  await assert.rejects(() => verifyPackagedDesktop({
    appPath: "/tmp/DreamSkin Studio.app",
    runAgent: false,
  }, {
    platform: "darwin",
    access: async () => {},
    makeTempDirectory: async () => "/tmp/dreamskin-verifier-fixture",
    reservePort: async () => 43123,
    spawnProcess: () => child,
    waitForRenderer: async () => { throw primary; },
    stopProcess: async () => { throw new Error("stop failed"); },
    removeDirectory: async () => { throw new Error("remove failed"); },
  }), (error) => {
    assert.equal(error, primary);
    assert.match(error.message, /Cleanup failure:/);
    assert.match(error.message, /stop failed/);
    assert.match(error.message, /remove failed/);
    return true;
  });
});

test("DevTools client bounds both connection and command waits", async () => {
  const disconnected = new DevToolsClient("ws://fixture", {
    WebSocketClass: SilentWebSocket,
    connectTimeoutMs: 10,
  });
  await assert.rejects(() => disconnected.connect(), /connection timed out after 10ms/);

  const connected = new DevToolsClient("ws://fixture", {
    WebSocketClass: OpenWebSocket,
    connectTimeoutMs: 100,
    callTimeoutMs: 10,
  });
  await connected.connect();
  await assert.rejects(() => connected.call("Runtime.evaluate"), /command 'Runtime\.evaluate' timed out after 10ms/);
  assert.equal(connected.pending.size, 0);
  connected.close();
});

test("DevTools protocol errors retain their structured code and data", async () => {
  const client = new DevToolsClient("ws://fixture", {
    WebSocketClass: ProtocolErrorWebSocket,
    connectTimeoutMs: 100,
  });
  await client.connect();
  await assert.rejects(() => client.evaluate("document.readyState"), (error) => {
    assert.equal(error.name, "DevToolsProtocolError");
    assert.equal(error.code, -32000);
    assert.equal(error.message, "Cannot find default execution context");
    assert.equal(error.data, "frame pending");
    return true;
  });
  client.close();
});

test("Studio readiness retries only a missing default context", async () => {
  const missing = Object.assign(new Error("Cannot find default execution context"), { code: -32000 });
  const states = [
    missing,
    { url: "about:blank", readyState: "complete", bridge: false, marker: null },
    { url: "dreamskin://studio/", readyState: "loading", bridge: true, marker: null },
    { url: "dreamskin://studio/", readyState: "complete", bridge: true, marker: null },
  ];
  let calls = 0;
  const client = {
    evaluate: async () => {
      const value = states[calls++];
      if (value instanceof Error) throw value;
      return value;
    },
  };

  const state = await waitForStudioContext(client, { timeoutMs: 1_000, sleep: async () => {} });
  assert.equal(calls, 4);
  assert.equal(state.url, "dreamskin://studio/");
});

test("Studio readiness fails immediately for a missing bridge or unrelated CDP error", async () => {
  let bridgeCalls = 0;
  await assert.rejects(() => waitForStudioContext({
    evaluate: async () => {
      bridgeCalls += 1;
      return { url: "dreamskin://studio/", readyState: "complete", bridge: false, marker: null };
    },
  }, { timeoutMs: 1_000, sleep: async () => {} }), /without its sandboxed preload bridge/);
  assert.equal(bridgeCalls, 1);

  const original = Object.assign(new Error("Renderer evaluation failed"), { code: -32000 });
  let errorCalls = 0;
  await assert.rejects(() => waitForStudioContext({
    evaluate: async () => {
      errorCalls += 1;
      throw original;
    },
  }, { timeoutMs: 1_000, sleep: async () => {} }), (error) => error === original);
  assert.equal(errorCalls, 1);
});

test("Studio reload readiness rejects the stale execution context", async () => {
  const states = [
    { url: "dreamskin://studio/", readyState: "complete", bridge: true, marker: "old-context" },
    { url: "dreamskin://studio/", readyState: "complete", bridge: true, marker: null },
  ];
  let calls = 0;
  const state = await waitForStudioContext({
    evaluate: async () => states[calls++],
  }, { staleMarker: "old-context", timeoutMs: 1_000, sleep: async () => {} });

  assert.equal(calls, 2);
  assert.equal(state.marker, null);
});

test("closing a DevTools client rejects commands that are still pending", async () => {
  const client = new DevToolsClient("ws://fixture", {
    WebSocketClass: OpenWebSocket,
    connectTimeoutMs: 100,
    callTimeoutMs: 1_000,
  });
  await client.connect();
  const pending = client.call("Page.captureScreenshot");
  client.close();
  await assert.rejects(() => pending, /DevTools client was closed/);
  assert.equal(client.pending.size, 0);
});

test("process cleanup recognizes signal exits and bounds forced termination", async () => {
  const alreadyExited = fakeChild();
  alreadyExited.signalCode = "SIGTERM";
  alreadyExited.kill = () => assert.fail("an exited child must not be signaled again");
  assert.deepEqual(await stopChild(alreadyExited), { forced: false });

  const hanging = fakeChild();
  const signals = [];
  hanging.kill = (signal) => {
    signals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => {
        hanging.signalCode = signal;
        hanging.emit("exit", null, signal);
      });
    }
    return true;
  };
  assert.deepEqual(await stopChild(hanging, { gracefulTimeoutMs: 5, killTimeoutMs: 100 }), { forced: true });
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
