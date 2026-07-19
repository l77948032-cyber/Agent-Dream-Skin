import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectPluginPackage, PluginInstaller } from "../src/core/plugin-installer.mjs";

async function packageFixture(t, { id = "dreamskin.fixture", version = "1.0.0" } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-plugin-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "resources"), { recursive: true });
  await fs.mkdir(path.join(root, "catalog"), { recursive: true });
  await fs.writeFile(path.join(root, "entry.mjs"), "export const plugin = true;\n");
  await fs.writeFile(path.join(root, "resources", "schema.json"), "{}\n");
  await fs.writeFile(path.join(root, "resources", "registry.json"), "{}\n");
  await fs.writeFile(path.join(root, "catalog", "catalog.json"), "{}\n");
  await fs.writeFile(path.join(root, "plugin.json"), `${JSON.stringify({
    schemaVersion: 1,
    id,
    name: "Fixture Plugin",
    version,
    entry: "entry.mjs",
    catalog: { root: "catalog" },
    target: { id: "fixture", name: "Fixture", platforms: ["darwin"] },
    theme: {
      schemaPath: "resources/schema.json",
      registryPath: "resources/registry.json",
    },
    themeTool: {
      name: "dreamskin_theme",
      actions: ["inspect", "read", "update", "validate"],
    },
    capabilities: {
      preview: { supported: false, screenshot: false, restoresPreviousState: false },
      runtime: { supported: false, actions: [] },
    },
  }, null, 2)}\n`);
  return root;
}

async function installerFixture(t, trustedBuiltInRoots = []) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-plugin-installer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    installer: new PluginInstaller({
      pluginsRoot: path.join(root, "plugins"),
      registryPath: path.join(root, "plugins", "registry.v1.json"),
      trustedBuiltInRoots,
    }),
  };
}

test("plugin installer requires a trusted digest for external packages and installs atomically", async (t) => {
  const source = await packageFixture(t);
  const inspected = await inspectPluginPackage(source);
  const { installer } = await installerFixture(t);

  await assert.rejects(
    () => installer.install(source),
    (error) => error.code === "UNTRUSTED_PLUGIN_PACKAGE",
  );
  const installed = await installer.install(source, { expectedDigest: inspected.digest });
  assert.equal(installed.id, "dreamskin.fixture");
  assert.equal(installed.active, true);
  assert.equal((await installer.active("dreamskin.fixture")).version, "1.0.0");
  assert.equal((await installer.list()).installed.length, 1);
  await fs.access(path.join(installed.path, "plugin.json"));

  const repeated = await installer.install(source, { expectedDigest: inspected.digest });
  assert.equal(repeated.digest, installed.digest);
  assert.equal((await installer.list()).installed.length, 1);
});

test("trusted built-in packages can install without an external signature", async (t) => {
  const source = await packageFixture(t, { id: "dreamskin.builtin" });
  const { installer } = await installerFixture(t, [source]);
  const installed = await installer.install(source);
  assert.equal(installed.trustedBuiltIn, true);
});

test("plugin installer rejects digest changes, symlinks, and conflicting immutable versions", async (t) => {
  const source = await packageFixture(t);
  const before = await inspectPluginPackage(source);
  const { installer } = await installerFixture(t);
  await assert.rejects(
    () => installer.install(source, { expectedDigest: "0".repeat(64) }),
    (error) => error.code === "PLUGIN_DIGEST_MISMATCH",
  );
  await installer.install(source, { expectedDigest: before.digest });

  await fs.writeFile(path.join(source, "entry.mjs"), "export const plugin = 'changed';\n");
  const changed = await inspectPluginPackage(source);
  await assert.rejects(
    () => installer.install(source, { expectedDigest: changed.digest }),
    (error) => error.code === "PLUGIN_VERSION_CONFLICT",
  );

  const linked = await packageFixture(t, { id: "dreamskin.linked" });
  await fs.symlink(path.join(linked, "entry.mjs"), path.join(linked, "catalog", "linked.mjs"));
  await assert.rejects(
    () => inspectPluginPackage(linked),
    (error) => error.code === "INVALID_PLUGIN_PACKAGE",
  );
});

test("plugin activation only selects an installed immutable version", async (t) => {
  const source = await packageFixture(t, { version: "2.0.0" });
  const inspected = await inspectPluginPackage(source);
  const { installer } = await installerFixture(t);
  await installer.install(source, { expectedDigest: inspected.digest, activate: false });
  assert.equal(await installer.active("dreamskin.fixture"), null);
  assert.equal((await installer.activate("dreamskin.fixture", "2.0.0")).active, true);
  await assert.rejects(
    () => installer.activate("dreamskin.fixture", "3.0.0"),
    (error) => error.code === "PLUGIN_NOT_INSTALLED",
  );
});
