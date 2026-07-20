import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createTraePlugin } from "../plugins/trae/plugin.mjs";
import { PluginManager } from "../src/core/plugin-manager.mjs";
import { validatePluginManifest } from "../src/core/plugin-api.mjs";

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "test.target",
    name: "Test Target",
    version: "1.0.0",
    target: { id: "test", name: "Test", platforms: ["darwin"] },
    theme: { schemaPath: "schema.json", registryPath: "registry.json" },
    themeTool: {
      name: "dreamskin_theme",
      actions: ["inspect", "read", "update", "validate"],
    },
    capabilities: {
      preview: { supported: true, screenshot: false, restoresPreviousState: true },
      runtime: { supported: true, actions: ["apply", "restore"] },
    },
    ...overrides,
  };
}

async function fixtureRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-plugin-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "schema.json"), "{}\n");
  await fs.writeFile(path.join(root, "registry.json"), "{}\n");
  return root;
}

function testPlugin(pluginManifest, calls = []) {
  return {
    manifest: pluginManifest,
    activate: async () => { calls.push("activate"); },
    deactivate: async () => { calls.push("deactivate"); },
    executeThemeAction: async (action, input) => {
      calls.push(["theme", action, input]);
      return { action, input };
    },
    createPreview: async (input) => {
      calls.push(["preview", input]);
      return { preview: input };
    },
    executeRuntimeAction: async (action, input) => {
      calls.push(["runtime", action, input]);
      return { action, input };
    },
    runtimeStatus: async () => {
      calls.push(["runtime-status"]);
      return { available: true };
    },
  };
}

test("plugin manifest validation is strict and rejects unsafe declarations", () => {
  const valid = validatePluginManifest(manifest());
  assert.equal(valid.id, "test.target");
  assert.equal(Object.isFrozen(valid), true);

  assert.throws(
    () => validatePluginManifest({ ...manifest(), surprise: true }),
    (error) => error.code === "INVALID_PLUGIN_MANIFEST" && error.details.unknown.includes("surprise"),
  );
  assert.throws(
    () => validatePluginManifest(manifest({
      theme: { schemaPath: "../schema.json", registryPath: "registry.json" },
    })),
    (error) => error.code === "INVALID_PLUGIN_MANIFEST",
  );
  assert.throws(
    () => validatePluginManifest(manifest({
      themeTool: { name: "dreamskin_theme", actions: ["inspect", "inspect"] },
    })),
    (error) => error.code === "INVALID_PLUGIN_MANIFEST",
  );
  assert.throws(
    () => validatePluginManifest(manifest({
      capabilities: {
        preview: { supported: false, screenshot: true, restoresPreviousState: false },
        runtime: { supported: false, actions: [] },
      },
    })),
    (error) => error.code === "INVALID_PLUGIN_MANIFEST",
  );
});

test("plugin manager registers, queries, filters, activates, and deactivates plugins", async (t) => {
  const root = await fixtureRoot(t);
  const calls = [];
  const manager = new PluginManager();
  const plugin = testPlugin(manifest(), calls);

  const registered = await manager.register(plugin, { rootPath: root });
  assert.equal(registered.state, "inactive");
  assert.equal(manager.has("test.target"), true);
  assert.equal(manager.query("test.target").manifest.target.id, "test");
  assert.equal(manager.list({ target: "test" }).length, 1);
  assert.equal(manager.list({ state: "active" }).length, 0);

  await assert.rejects(
    manager.runThemeAction("test.target", "inspect"),
    (error) => error.code === "PLUGIN_NOT_ACTIVE",
  );
  await manager.activate("test.target");
  await manager.activate("test.target");
  assert.equal(manager.get("test.target").active, true);
  assert.deepEqual(await manager.runThemeAction("test.target", "read", { id: "paper" }), {
    action: "read",
    input: { id: "paper" },
  });
  assert.deepEqual(await manager.createPreview("test.target", { id: "paper" }), {
    preview: { id: "paper" },
  });
  assert.deepEqual(await manager.runRuntimeAction("test.target", "apply", { id: "paper" }), {
    action: "apply",
    input: { id: "paper" },
  });
  assert.deepEqual(await manager.runtimeStatus("test.target"), { available: true });
  await manager.deactivate("test.target");
  await manager.deactivate("test.target");
  assert.equal(manager.get("test.target").active, false);
  assert.deepEqual(calls.filter((entry) => typeof entry === "string"), ["activate", "deactivate"]);
});

test("plugin manager rejects duplicates, missing resources, and undeclared actions", async (t) => {
  const root = await fixtureRoot(t);
  const manager = new PluginManager();
  const plugin = testPlugin(manifest());
  await manager.register(plugin, { rootPath: root });
  await assert.rejects(
    manager.register(plugin, { rootPath: root }),
    (error) => error.code === "PLUGIN_ALREADY_REGISTERED",
  );
  await manager.activate("test.target");
  await assert.rejects(
    manager.runThemeAction("test.target", "create", { id: "new" }),
    (error) => error.code === "PLUGIN_ACTION_NOT_SUPPORTED",
  );
  await assert.rejects(
    new PluginManager().register(testPlugin(manifest({
      theme: { schemaPath: "missing.json", registryPath: "registry.json" },
    })), { rootPath: root }),
    (error) => error.code === "INVALID_PLUGIN_RESOURCE",
  );
});

test("Trae plugin delegates Tool, preview, and runtime capabilities to the injected service", async () => {
  const calls = [];
  const service = {
    catalogRepository: {
      read: async (id) => ({ theme: { schemaVersion: 1, id, image: "background.png" }, asset: { file: "background.png" } }),
      themePath: (id) => `/catalog/${id}`,
    },
    inspect: async () => { calls.push(["inspect"]); return { product: "test" }; },
    themeList: async () => { calls.push(["list"]); return { themes: [] }; },
    themeRead: async (id) => { calls.push(["read", id]); return { id }; },
    themeWrite: async (input) => { calls.push(["write", input]); return input; },
    themeValidate: async (input) => { calls.push(["validate", input]); return { valid: true }; },
    preview: async (id, options) => { calls.push(["preview", id, options]); return { id }; },
    apply: async (id) => { calls.push(["apply", id]); return { id }; },
    verify: async (input) => { calls.push(["verify", input]); return { pass: true }; },
    restore: async () => { calls.push(["restore"]); return { restored: true }; },
    runtimeStatus: async () => { calls.push(["runtime-status"]); return { available: true }; },
  };
  const plugin = await createTraePlugin({ service });

  await plugin.executeThemeAction("inspect", {});
  await plugin.executeThemeAction("read", { id: "sunlit" });
  const created = await plugin.executeThemeAction("create", { id: "blank", themePatch: { name: "Blank" } });
  const updated = await plugin.executeThemeAction("update", {
    id: "sunlit",
    expectedRevision: "rev-1",
    themePatch: { name: "Updated" },
  });
  await plugin.executeThemeAction("validate", { id: "sunlit" });
  await plugin.createPreview({ id: "sunlit", screenshot: false });
  await plugin.executeRuntimeAction("apply", { id: "sunlit" });
  await plugin.executeRuntimeAction("verify", { screenshot: false });
  await plugin.executeRuntimeAction("restore", {});
  await plugin.runtimeStatus();

  assert.equal(plugin.manifest.target.id, "trae");
  assert.equal(created.expectedRevision, null);
  assert.equal(created.operation, "write");
  assert.equal(created.imagePath, "/catalog/paper-aurora/background.png");
  assert.equal(created.themePatch.id, "blank");
  assert.equal(created.themePatch.name, "Blank");
  assert.equal(created.themePatch.appearance.backgroundOpacity, 0);
  assert.deepEqual(created.provenance, { schemaVersion: 1, origin: "blank" });
  assert.equal(updated.expectedRevision, "rev-1");
  assert.deepEqual(calls.map(([name]) => name), [
    "inspect", "read", "write", "write", "validate", "preview", "apply", "verify", "restore", "runtime-status",
  ]);
});
