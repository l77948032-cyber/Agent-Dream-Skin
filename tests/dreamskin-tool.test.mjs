import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createApplicationContext,
  createTraeApplicationContext,
} from "../src/core/application-context.mjs";
import { DreamSkinToolCore } from "../src/core/dreamskin-tool.mjs";
import { HostRuntimeManager } from "../src/core/runtime-manager.mjs";

function managers() {
  const calls = [];
  const pluginManager = {
    runThemeAction: async (pluginId, action, input) => {
      calls.push(["theme", pluginId, action, input]);
      return { pluginId, action, input };
    },
    createPreview: async (pluginId, input) => {
      calls.push(["preview", pluginId, input]);
      return { pluginId, input };
    },
    runRuntimeAction: async (pluginId, action, input) => {
      calls.push(["runtime", pluginId, action, input]);
      return { pluginId, action, input };
    },
    runtimeStatus: async (pluginId) => {
      calls.push(["runtime-status", pluginId]);
      return { available: true };
    },
  };
  return { calls, pluginManager };
}

test("DreamSkin Tool exposes one strict action contract over plugins", async () => {
  const { calls, pluginManager } = managers();
  const tool = new DreamSkinToolCore({ pluginManager });
  assert.equal(tool.descriptor().id, "dreamskin_theme");
  await tool.execute({ action: "inspect" });
  await tool.execute({ action: "read", themeId: "sunlit" });
  await tool.execute({
    action: "update",
    themeId: "sunlit",
    expectedRevision: "rev-1",
    themePatch: { name: "Updated" },
  });
  await tool.execute({ action: "validate", themeId: "sunlit" });
  assert.deepEqual(calls, [
    ["theme", "dreamskin.trae", "inspect", {}],
    ["theme", "dreamskin.trae", "read", { id: "sunlit" }],
    ["theme", "dreamskin.trae", "update", { id: "sunlit", expectedRevision: "rev-1", themePatch: { name: "Updated" } }],
    ["theme", "dreamskin.trae", "validate", { id: "sunlit" }],
  ]);
});

test("DreamSkin Tool rejects unsafe or ambiguous inputs before plugin dispatch", async () => {
  const { calls, pluginManager } = managers();
  const tool = new DreamSkinToolCore({ pluginManager });
  assert.throws(() => tool.execute({ action: "update", themeId: "sunlit", themePatch: {} }), /expectedRevision/);
  assert.throws(() => tool.execute({ action: "validate", themeId: "sunlit", theme: {} }), /exactly one/);
  assert.throws(() => tool.execute({ action: "read", themeId: "sunlit", imagePath: "/tmp/a.png" }), /unknown fields/);
  assert.throws(() => tool.execute({ action: "apply", themeId: "sunlit" }), (error) => error.code === "TOOL_ACTION_NOT_SUPPORTED");
  assert.equal(calls.length, 0);
});

test("runtime capabilities stay outside the Agent Tool contract", async () => {
  const { calls, pluginManager } = managers();
  const runtime = new HostRuntimeManager({ pluginManager });
  await runtime.preview({ id: "sunlit", screenshot: false });
  await runtime.status();
  await runtime.apply("sunlit");
  await runtime.verify({ screenshot: false });
  await runtime.restore();
  assert.deepEqual(calls.map(([kind, , action]) => kind === "preview" ? [kind] : [kind, action]), [
    ["preview"],
    ["runtime-status", undefined],
    ["runtime", "apply"],
    ["runtime", "verify"],
    ["runtime", "restore"],
  ]);
});

test("application context registers multiple targets while preserving Trae as the legacy default", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-multi-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const target = async (id, targetId, targetName) => {
    const pluginRoot = path.join(root, targetId);
    await fs.mkdir(pluginRoot, { recursive: true });
    await fs.writeFile(path.join(pluginRoot, "schema.json"), "{}\n");
    await fs.writeFile(path.join(pluginRoot, "registry.json"), '{"components":[]}\n');
    return {
      rootPath: pluginRoot,
      plugin: {
        rootPath: pluginRoot,
        manifest: {
          schemaVersion: 1,
          id,
          name: `${targetName} Theme`,
          version: "1.0.0",
          target: { id: targetId, name: targetName, platforms: ["darwin"] },
          theme: { schemaPath: "schema.json", registryPath: "registry.json" },
          themeTool: { name: "dreamskin_theme", actions: ["inspect"] },
          capabilities: {
            preview: { supported: false, screenshot: false, restoresPreviousState: false },
            runtime: { supported: true, actions: ["apply", "verify", "restore"] },
          },
        },
        executeThemeAction: async (action, input) => {
          calls.push([id, "theme", action, input]);
          return { pluginId: id, action };
        },
        executeRuntimeAction: async (action, input) => {
          calls.push([id, "runtime", action, input]);
          return { pluginId: id, action };
        },
        runtimeStatus: async () => ({ available: true, pluginId: id }),
      },
      repository: { id: `${id}:repository` },
      themesRoot: path.join(root, "themes", targetId),
    };
  };
  const workBuddy = await target("dreamskin.workbuddy", "workbuddy", "WorkBuddy");
  const trae = await target("dreamskin.trae", "trae", "Trae");
  const context = await createApplicationContext({
    targets: [workBuddy, trae],
    dataRoot: path.join(root, "data"),
    projectRoot: root,
  });
  t.after(() => Promise.allSettled(
    context.pluginManager.list({ state: "active" }).map(({ id }) => context.pluginManager.deactivate(id)),
  ));

  assert.equal(context.defaultPluginId, "dreamskin.trae");
  assert.equal(context.plugin, trae.plugin);
  assert.equal(context.repository, trae.repository);
  assert.equal(context.targets.size, 2);
  assert.equal(context.target("dreamskin.workbuddy").targetName, "WorkBuddy");
  assert.deepEqual(await context.tool.inspect("dreamskin.workbuddy"), {
    pluginId: "dreamskin.workbuddy",
    action: "inspect",
  });
  assert.deepEqual(await context.runtime.apply("same-theme", "dreamskin.workbuddy"), {
    pluginId: "dreamskin.workbuddy",
    action: "apply",
  });
  assert.deepEqual(calls, [
    ["dreamskin.workbuddy", "theme", "inspect", {}],
    ["dreamskin.workbuddy", "runtime", "apply", { id: "same-theme" }],
  ]);
});

test("application context activates Trae as a plugin and keeps legacy adapters thin", async () => {
  const calls = [];
  const service = {
    inspect: async () => ({ product: "Trae-Dream-Skin" }),
    themeList: async () => ({ themes: [] }),
    themeRead: async (id) => ({ id }),
    themeWrite: async (input) => { calls.push(["write", input]); return input; },
    themeValidate: async (input) => ({ valid: true, input }),
    preview: async (id) => ({ id }),
    apply: async (id) => ({ id }),
    verify: async () => ({ pass: true }),
    restore: async () => ({ restored: true }),
  };
  const context = await createTraeApplicationContext({ service });
  assert.equal(context.pluginManager.get("dreamskin.trae").active, true);
  assert.deepEqual(await context.tool.readTheme("paper"), { id: "paper" });
  await context.legacyService.themeWrite({ operation: "rollback", transactionId: "tx-1" });
  assert.deepEqual(calls, [["write", { operation: "rollback", transactionId: "tx-1" }]]);
});

test("real DreamSkin Tool create uses a plugin-owned catalog asset and validates immediately", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-tool-create-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = await createTraeApplicationContext({
    themesRoot: path.join(root, "themes"),
    dataRoot: path.join(root, "data"),
    backupsRoot: path.join(root, "backups"),
  });
  t.after(() => context.pluginManager.deactivate(context.plugin.manifest.id));

  const created = await context.tool.createTheme({
    themeId: "tool-created",
    sourceId: "paper-aurora",
    themePatch: { name: "Tool Created" },
  });
  assert.equal(created.id, "tool-created");
  assert.equal(created.beforeRevision, null);
  assert.match(created.afterRevision, /^[a-f0-9]{64}$/);
  assert.equal((await context.tool.readTheme("tool-created")).theme.name, "Tool Created");
  assert.equal((await context.tool.validateTheme({ themeId: "tool-created" })).valid, true);
  assert.equal(context.targetService.registryPath, context.pluginManager.resources("dreamskin.trae").registryPath);
  assert.equal(context.targetService.schemaPath, context.pluginManager.resources("dreamskin.trae").schemaPath);
});
