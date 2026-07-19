import assert from "node:assert/strict";
import test from "node:test";

import { preferredCodexPath } from "../desktop/agent-paths.mjs";

test("desktop Codex detection prefers an explicit executable", async () => {
  const visited = [];
  const result = await preferredCodexPath({
    env: { DREAMSKIN_CODEX_PATH: "/custom/codex", CODEX_PATH: "/other/codex" },
    platform: "darwin",
    homeDir: "/Users/test",
    access: async (candidate) => {
      visited.push(candidate);
      if (candidate !== "/custom/codex") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(result, "/custom/codex");
  assert.deepEqual(visited, ["/custom/codex"]);
});

test("desktop Codex detection falls back to the official app bundle on macOS", async () => {
  const expected = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const result = await preferredCodexPath({
    env: {},
    platform: "darwin",
    homeDir: "/Users/test",
    access: async (candidate) => {
      if (candidate !== expected) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  });
  assert.equal(result, expected);
});

test("desktop Codex detection does not guess app bundle paths on other platforms", async () => {
  let called = false;
  const result = await preferredCodexPath({
    env: {},
    platform: "win32",
    access: async () => { called = true; },
  });
  assert.equal(result, null);
  assert.equal(called, false);
});
