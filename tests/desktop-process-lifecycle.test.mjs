import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createDesktopProcessTerminator } from "../desktop/process-lifecycle.mjs";

function processFixture(platform) {
  const processRef = new EventEmitter();
  processRef.platform = platform;
  processRef.pid = 31415;
  processRef.kills = [];
  processRef.kill = (pid, signal) => { processRef.kills.push([pid, signal]); };
  return processRef;
}

test("macOS final termination restores default signal handling before self-SIGTERM", () => {
  const processRef = processFixture("darwin");
  const app = { exit: () => assert.fail("macOS final termination must use the default signal disposition") };
  const terminator = createDesktopProcessTerminator({ app, processRef });
  let handled = 0;
  const handler = () => { handled += 1; };
  terminator.listen("SIGINT", handler);
  terminator.listen("SIGTERM", handler);

  terminator.terminate(0);
  processRef.emit("SIGTERM");
  terminator.terminate(0);

  assert.equal(handled, 0);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.deepEqual(processRef.kills, [[31415, "SIGTERM"]]);
});

test("non-macOS final termination remains an idempotent Electron app exit", () => {
  const processRef = processFixture("linux");
  const exits = [];
  const terminator = createDesktopProcessTerminator({
    app: { exit: (code) => exits.push(code) },
    processRef,
  });

  terminator.terminate(7);
  terminator.terminate(9);

  assert.deepEqual(exits, [7]);
  assert.deepEqual(processRef.kills, []);
});
