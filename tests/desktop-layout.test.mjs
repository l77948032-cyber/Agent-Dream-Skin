import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DESKTOP_RESOURCE_MANIFEST_FILE,
  DesktopPathLayout,
  validateDesktopResourceManifest,
} from "../src/core/desktop-layout.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-desktop-layout-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    appPath: path.join(root, "app"),
    resourcesPath: path.join(root, "resources"),
    userDataPath: path.join(root, "user-data"),
  };
}

function digest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function writeResourceManifest(resourceRoot, resources, version = "1.0.0") {
  await fs.writeFile(path.join(resourceRoot, DESKTOP_RESOURCE_MANIFEST_FILE), `${JSON.stringify({
    schemaVersion: 1,
    product: "dreamskin",
    version,
    resources,
  }, null, 2)}\n`);
}

test("desktop layout separates packaged read-only resources from namespaced mutable user data", async (t) => {
  const paths = await fixture(t);
  const packagedRoot = path.join(paths.resourcesPath, "dreamskin");
  await fs.mkdir(packagedRoot, { recursive: true });
  await fs.mkdir(paths.appPath, { recursive: true });

  const layout = new DesktopPathLayout({
    isPackaged: true,
    appPath: paths.appPath,
    resourcesPath: paths.resourcesPath,
    userDataPath: paths.userDataPath,
  });
  assert.equal(layout.resourceRoot, packagedRoot);
  assert.equal(layout.dataRoot, path.join(paths.userDataPath, "dreamskin"));
  assert.equal(layout.bundledPluginRoot("dreamskin.trae"), path.join(packagedRoot, "plugins", "dreamskin.trae"));
  assert.equal(
    layout.themePath("dreamskin.trae", "sunlit-spark"),
    path.join(paths.userDataPath, "dreamskin", "themes", "dreamskin.trae", "sunlit-spark"),
  );
  assert.equal(
    layout.runtimeNamespaceRoot("dreamskin.trae"),
    path.join(paths.userDataPath, "dreamskin", "runtime", "dreamskin.trae"),
  );

  const initialized = await layout.ensureMutableRoots("dreamskin.trae");
  assert.equal(initialized.namespace, "dreamskin.trae");
  for (const root of initialized.roots) assert.equal((await fs.stat(root)).isDirectory(), true);
  assert.equal((await fs.stat(packagedRoot)).isDirectory(), true);
  await assert.rejects(fs.access(path.join(packagedRoot, "themes")), (error) => error.code === "ENOENT");

  assert.throws(() => layout.themePath("../escape", "theme"), (error) => error.code === "DESKTOP_NAMESPACE_INVALID");
  assert.throws(() => layout.themePath("dreamskin.trae", "../escape"), (error) => error.code === "DESKTOP_NAMESPACE_INVALID");
});

test("desktop layout resolves development resources from the injected project path", async (t) => {
  const paths = await fixture(t);
  const developmentResourcesPath = path.join(paths.root, "checkout");
  await Promise.all([
    fs.mkdir(paths.appPath, { recursive: true }),
    fs.mkdir(developmentResourcesPath, { recursive: true }),
  ]);
  const layout = new DesktopPathLayout({
    isPackaged: false,
    appPath: paths.appPath,
    developmentResourcesPath,
    userDataPath: paths.userDataPath,
  });
  assert.equal(layout.describe().mode, "development");
  assert.equal(layout.resourceRoot, developmentResourcesPath);
  assert.equal(layout.registryRoot, path.join(developmentResourcesPath, "registry"));
  assert.notEqual(layout.resourceRoot, layout.dataRoot);
});

test("required desktop resource manifest validates types, hashes, sizes, and tampering", async (t) => {
  const paths = await fixture(t);
  const resourceRoot = path.join(paths.root, "bundle");
  const pluginPath = path.join(resourceRoot, "plugins", "dreamskin.trae", "plugin.json");
  const plugin = Buffer.from('{"id":"dreamskin.trae"}\n');
  await fs.mkdir(path.dirname(pluginPath), { recursive: true });
  await fs.mkdir(path.join(resourceRoot, "schemas"), { recursive: true });
  await fs.writeFile(pluginPath, plugin);
  await writeResourceManifest(resourceRoot, [
    { path: "plugins/dreamskin.trae/plugin.json", type: "file", sha256: digest(plugin), bytes: plugin.length },
    { path: "schemas", type: "directory" },
  ]);

  const verified = await validateDesktopResourceManifest({ resourceRoot });
  assert.equal(verified.valid, true);
  assert.equal(verified.resources[0].sha256, digest(plugin));

  await fs.writeFile(pluginPath, '{"id":"tampered"}\n');
  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_INTEGRITY_FAILED"
      && error.details.path === "plugins/dreamskin.trae/plugin.json",
  );
});

test("resource validation accepts only declared entries and their necessary parent directories", async (t) => {
  const paths = await fixture(t);
  const resourceRoot = path.join(paths.root, "bundle");
  const pluginPath = path.join(resourceRoot, "plugins", "dreamskin.trae", "plugin.json");
  const plugin = Buffer.from('{"id":"dreamskin.trae"}\n');
  await fs.mkdir(path.dirname(pluginPath), { recursive: true });
  await fs.writeFile(pluginPath, plugin);
  await writeResourceManifest(resourceRoot, [
    { path: "plugins/dreamskin.trae/plugin.json", type: "file", sha256: digest(plugin), bytes: plugin.length },
  ]);

  assert.equal((await validateDesktopResourceManifest({ resourceRoot })).valid, true);

  await fs.writeFile(path.join(resourceRoot, "undeclared.txt"), "unexpected\n");
  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_INVENTORY_FAILED"
      && error.details.path === "undeclared.txt"
      && error.details.actual === "file",
  );
  await fs.rm(path.join(resourceRoot, "undeclared.txt"));

  await fs.mkdir(path.join(resourceRoot, "undeclared-directory"));
  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_INVENTORY_FAILED"
      && error.details.path === "undeclared-directory"
      && error.details.actual === "directory",
  );
});

test("declared directories do not authorize undeclared descendants", async (t) => {
  const paths = await fixture(t);
  const resourceRoot = path.join(paths.root, "bundle");
  const declaredDirectory = path.join(resourceRoot, "catalog");
  await fs.mkdir(declaredDirectory, { recursive: true });
  await writeResourceManifest(resourceRoot, [
    { path: "catalog", type: "directory" },
  ]);

  assert.equal((await validateDesktopResourceManifest({ resourceRoot })).valid, true);
  await fs.writeFile(path.join(declaredDirectory, "unlisted.json"), "{}\n");
  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_INVENTORY_FAILED"
      && error.details.path === "catalog/unlisted.json",
  );
});

test("resource manifests reject file entries that contain declared descendants", async (t) => {
  const paths = await fixture(t);
  const resourceRoot = path.join(paths.root, "bundle");
  const child = Buffer.from("child\n");
  await fs.mkdir(resourceRoot, { recursive: true });
  await writeResourceManifest(resourceRoot, [
    { path: "catalog", type: "file", sha256: digest(Buffer.alloc(0)), bytes: 0 },
    { path: "catalog/theme.json", type: "file", sha256: digest(child), bytes: child.length },
  ]);

  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_MANIFEST_INVALID"
      && error.details.path === "catalog"
      && error.details.descendant === "catalog/theme.json",
  );

  await writeResourceManifest(resourceRoot, [
    { path: DESKTOP_RESOURCE_MANIFEST_FILE, type: "file", sha256: "0".repeat(64), bytes: 0 },
  ]);
  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_MANIFEST_INVALID"
      && error.details.path === DESKTOP_RESOURCE_MANIFEST_FILE,
  );
});

test("resource validation fails closed on missing manifests, traversal, and symlinks", {
  skip: process.platform === "win32",
}, async (t) => {
  const paths = await fixture(t);
  const resourceRoot = path.join(paths.root, "bundle");
  await fs.mkdir(resourceRoot, { recursive: true });
  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_MANIFEST_MISSING",
  );

  await writeResourceManifest(resourceRoot, [
    { path: "../outside", type: "file", sha256: "0".repeat(64), bytes: 0 },
  ]);
  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_PATH_INVALID",
  );

  const outside = path.join(paths.root, "outside.json");
  const buffer = Buffer.from("outside\n");
  await fs.writeFile(outside, buffer);
  await fs.symlink(outside, path.join(resourceRoot, "linked.json"));
  await writeResourceManifest(resourceRoot, [
    { path: "linked.json", type: "file", sha256: digest(buffer), bytes: buffer.length },
  ]);
  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_SYMLINK_UNSUPPORTED",
  );

  await fs.rm(path.join(resourceRoot, "linked.json"));
  const declared = Buffer.from("declared\n");
  await fs.writeFile(path.join(resourceRoot, "declared.txt"), declared);
  await fs.symlink(outside, path.join(resourceRoot, "undeclared-link"));
  await writeResourceManifest(resourceRoot, [
    { path: "declared.txt", type: "file", sha256: digest(declared), bytes: declared.length },
  ]);
  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot }),
    (error) => error.code === "RESOURCE_SYMLINK_UNSUPPORTED"
      && error.details.path === "undeclared-link",
  );
});
