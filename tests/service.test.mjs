import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TraeDreamSkinService } from "../src/core/service.mjs";

test("preview restores the previous active theme after verification", async () => {
  const calls = [];
  const runtime = {
    descriptor: () => ({ platform: "test", supported: true }),
    status: async () => {
      const applyCalls = calls.filter(([name]) => name === "apply");
      return applyCalls.length < 2
        ? { session: "active", themeId: "previous" }
        : { session: "active", themeId: "previous" };
    },
    apply: async (id) => { calls.push(["apply", id]); return { applied: true, themeId: id }; },
    verify: async ({ screenshotPath }) => {
      calls.push(["verify", screenshotPath]);
      return { mode: "verify", targets: [{ result: { pass: true } }] };
    },
    restore: async () => { calls.push(["restore"]); return { restored: true }; },
  };
  const repository = { read: async (id) => ({ id }) };
  const service = new TraeDreamSkinService({ repository, runtime });
  const result = await service.preview("candidate", { screenshot: false });
  assert.equal(result.restoration.themeId, "previous");
  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
    ["apply", "candidate"],
    ["verify", undefined],
    ["apply", "previous"],
  ]);
});

test("preview restores native state when no skin was active", async () => {
  const calls = [];
  const runtime = {
    descriptor: () => ({ platform: "test", supported: true }),
    status: async () => ({ session: "off" }),
    apply: async (id) => { calls.push(["apply", id]); },
    verify: async () => ({ targets: [{ result: { pass: true } }] }),
    restore: async () => { calls.push(["restore"]); },
  };
  const service = new TraeDreamSkinService({ repository: { read: async () => ({}) }, runtime });
  const result = await service.preview("candidate", { screenshot: false });
  assert.equal(result.restoration.mode, "native");
  assert.deepEqual(calls, [["apply", "candidate"], ["restore"]]);
});

test("inspect exposes semantic components without leaking runtime selectors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trae-inspect-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const registryPath = path.join(root, "registry.json");
  const schemaPath = path.join(root, "schema.json");
  await fs.writeFile(registryPath, JSON.stringify({
    schemaVersion: 1,
    components: [{ id: "composer.surface", states: ["focus"], selectors: [".private-selector"] }],
  }));
  await fs.writeFile(schemaPath, "{}");
  const service = new TraeDreamSkinService({
    repository: { list: async () => ({ themes: [] }) },
    runtime: { descriptor: () => ({ platform: "test", supported: false }) },
    registryPath,
    schemaPath,
  });
  const result = await service.inspect();
  assert.equal(result.registry.components[0].id, "composer.surface");
  assert.equal(result.registry.components[0].runtimeMappingCount, 1);
  assert.equal("selectors" in result.registry.components[0], false);
});
