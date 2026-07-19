import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildDesktopResources,
  DESKTOP_LEGAL_PATHS,
  DESKTOP_RUNTIME_SCRIPT_PATHS,
  parseBuildArguments,
  TRAE_RUNTIME_NAMESPACE,
} from "../scripts/build-desktop-resources.mjs";
import { TRAE_CATALOG_METADATA } from "../plugins/trae/catalog.mjs";
import {
  DESKTOP_RESOURCE_MANIFEST_FILE,
  validateDesktopResourceManifest,
} from "../src/core/desktop-layout.mjs";
import {
  RUNTIME_MANIFEST_FILE,
  VersionedRuntimeInstaller,
} from "../src/core/versioned-runtime-installer.mjs";

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_SCRIPT = path.join(REPOSITORY_ROOT, "scripts", "build-desktop-resources.mjs");

async function write(root, relativePath, contents, mode = 0o644) {
  const target = path.join(root, ...relativePath.split("/"));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, { mode });
  await fs.chmod(target, mode);
}

async function sourceFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-desktop-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manifest = {
    schemaVersion: 1,
    id: TRAE_RUNTIME_NAMESPACE,
    name: "Trae DreamSkin",
    version: "0.2.0",
    description: "Fixture",
    entry: "plugin.mjs",
    catalog: { root: "catalog" },
    target: { id: "trae", name: "Trae", platforms: ["darwin", "win32"] },
    theme: {
      schemaPath: "resources/theme-v1.schema.json",
      registryPath: "resources/components.v1.json",
      runtimeMappingPath: "resources/theme-runtime.v1.json",
    },
    themeTool: {
      name: "dreamskin_theme",
      actions: ["inspect", "list", "read", "create", "update", "validate"],
    },
    capabilities: {
      preview: { supported: true, screenshot: true, restoresPreviousState: true },
      runtime: { supported: true, actions: ["apply", "verify", "restore"] },
    },
  };

  await write(root, "package.json", `${JSON.stringify({ name: "fixture", version: "0.2.0" })}\n`);
  await write(root, "plugins/trae/plugin.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await write(root, "plugins/trae/plugin.mjs", "throw new Error('source entry must not be copied');\n");
  await write(root, "plugins/trae/catalog.mjs", "export const secret = 'not packaged';\n");
  await write(root, "plugins/trae/resources/theme-v1.schema.json", "{}\n");
  await write(root, "plugins/trae/resources/components.v1.json", '{"components":[]}\n');
  await write(root, "plugins/trae/resources/theme-runtime.v1.json", "{}\n");
  await write(root, "plugins/trae/assets/trae-skin.css", ":root{--fixture:1}\n");
  await write(root, "schemas/theme-v1.schema.json", "{}\n");
  await write(root, "registry/components.v1.json", '{"components":[]}\n');
  await write(root, "registry/theme-runtime.v1.json", "{}\n");
  for (const id of Object.keys(TRAE_CATALOG_METADATA)) {
    await write(
      root,
      `plugins/trae/catalog/${id}/theme.json`,
      `${JSON.stringify({ schemaVersion: 1, id, name: `Fixture ${id}`, image: "background.png" })}\n`,
    );
    await write(
      root,
      `plugins/trae/catalog/${id}/background.png`,
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  }
  await write(root, "studio/dist/index.html", "<!doctype html><script src=\"/assets/app.js\"></script>\n");
  await write(root, "studio/dist/assets/app.js", "globalThis.fixture=true;\n");
  await write(root, "assets/renderer-inject.js", "globalThis.rendererFixture=true;\n");
  await write(root, "assets/trae-skin.css", ":root{--fixture:1}\n");
  for (const relativePath of DESKTOP_RUNTIME_SCRIPT_PATHS) {
    await write(root, relativePath, `// fixture ${relativePath}\n`, relativePath.endsWith(".sh") ? 0o755 : 0o644);
  }
  await write(root, "src/core/paths.mjs", "export const PROJECT_ROOT='fixture';\n");
  await write(root, "src/core/theme-loader.mjs", "export const loadTheme=()=>{};\n");
  await write(root, "src/core/theme-model.mjs", "export const normalizeTheme=(value)=>value;\n");
  await write(root, "node_modules/@agentclientprotocol/codex-acp/dist/index.js", "#!/usr/bin/env node\nprocess.stdout.write('acp fixture');\n", 0o755);
  for (const [sourcePath] of DESKTOP_LEGAL_PATHS) {
    await write(root, sourcePath, `fixture license for ${sourcePath}\n`);
  }

  await write(root, "scripts/install-macos-runtime.sh", "do-not-package\n", 0o755);
  await write(root, "scripts/studio-dev.mjs", "do-not-package\n");
  await write(root, "node_modules/@openai/codex-darwin-arm64/bin/codex", "large-platform-binary\n", 0o755);
  await write(root, ".env", "TOKEN=must-not-be-packaged\n");
  return root;
}

async function inventory(root, current = root) {
  const entries = (await fs.readdir(current, { withFileTypes: true }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const result = [];
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    const relative = path.relative(root, target).split(path.sep).join("/");
    if (entry.isDirectory()) result.push(...await inventory(root, target));
    else result.push(relative);
  }
  return result.sort();
}

test("desktop resource builder emits only the verified allowlist and an installable Trae runtime package", async (t) => {
  const projectRoot = await sourceFixture(t);
  const outRoot = path.join(projectRoot, "build", "desktop-resources");
  const result = await buildDesktopResources({ projectRoot, outRoot });
  const manifest = JSON.parse(await fs.readFile(result.resourceManifestPath, "utf8"));
  const files = await inventory(outRoot);
  const declared = manifest.resources.map((resource) => resource.path);

  assert.deepEqual(declared, [...declared].sort());
  assert.deepEqual(files, [...declared, DESKTOP_RESOURCE_MANIFEST_FILE].sort());
  assert.equal((await validateDesktopResourceManifest({ resourceRoot: outRoot })).valid, true);
  assert.equal(await fs.readFile(path.join(outRoot, "acp", "codex-acp.mjs"), "utf8"), "#!/usr/bin/env node\nprocess.stdout.write('acp fixture');\n");
  assert.equal(files.some((file) => file.includes("node_modules")), false);
  assert.equal(files.includes("plugins/trae/plugin.mjs"), false);
  assert.equal(files.includes("plugins/trae/catalog.mjs"), false);
  assert.equal(files.includes("scripts/install-macos-runtime.sh"), false);
  assert.equal(files.includes("scripts/studio-dev.mjs"), false);
  assert.equal(files.includes("schemas/theme-v1.schema.json"), false);
  assert.equal(files.includes("plugins/trae/resources/theme-v1.schema.json"), true);
  for (const id of Object.keys(TRAE_CATALOG_METADATA)) {
    assert.equal(files.includes(`plugins/trae/catalog/${id}/theme.json`), true);
    assert.equal(files.includes(`plugins/trae/catalog/${id}/background.png`), true);
  }
  for (const [, destinationPath] of DESKTOP_LEGAL_PATHS) {
    assert.equal(files.includes(destinationPath), true);
  }

  const packagedPlugin = JSON.parse(await fs.readFile(path.join(outRoot, "plugins", "trae", "plugin.json"), "utf8"));
  assert.equal(Object.hasOwn(packagedPlugin, "entry"), false);
  const runtimeSource = path.join(outRoot, "runtime", TRAE_RUNTIME_NAMESPACE);
  const installer = new VersionedRuntimeInstaller({
    runtimeRoot: path.join(projectRoot, "user-data", "runtime"),
    namespace: TRAE_RUNTIME_NAMESPACE,
  });
  const installed = await installer.install({ sourceRoot: runtimeSource, activate: false });
  assert.equal(installed.installed, true);
  assert.equal(installed.version, "0.2.0");
});

test("desktop resource builder rejects catalog metadata whose theme directory is missing", async (t) => {
  const projectRoot = await sourceFixture(t);
  const missingId = Object.keys(TRAE_CATALOG_METADATA)[0];
  await fs.rm(path.join(projectRoot, "plugins", "trae", "catalog", missingId), {
    recursive: true,
  });

  await assert.rejects(
    buildDesktopResources({ projectRoot, outRoot: path.join(projectRoot, "build", "missing-catalog") }),
    (error) => error.code === "DESKTOP_BUILD_CATALOG_MISMATCH"
      && error.details.missing.length === 1
      && error.details.missing[0] === missingId
      && error.details.extra.length === 0,
  );
});

test("desktop resource builder rejects Studio and runtime mirrors that drift from plugin resources", async (t) => {
  const projectRoot = await sourceFixture(t);
  await fs.writeFile(path.join(projectRoot, "registry", "components.v1.json"), '{"components":[{"id":"drift"}]}\n');

  await assert.rejects(
    buildDesktopResources({ projectRoot, outRoot: path.join(projectRoot, "build", "drifted-mirror") }),
    (error) => error.code === "DESKTOP_BUILD_SOURCE_MISMATCH"
      && error.details.sourcePath === "registry/components.v1.json"
      && error.details.canonicalPath === "plugins/trae/resources/components.v1.json",
  );
});

test("desktop resource builder rejects catalog directories absent from static metadata", async (t) => {
  const projectRoot = await sourceFixture(t);
  const extraId = "unlisted-template";
  await fs.mkdir(path.join(projectRoot, "plugins", "trae", "catalog", extraId));

  await assert.rejects(
    buildDesktopResources({ projectRoot, outRoot: path.join(projectRoot, "build", "extra-catalog") }),
    (error) => error.code === "DESKTOP_BUILD_CATALOG_MISMATCH"
      && error.details.missing.length === 0
      && error.details.extra.length === 1
      && error.details.extra[0] === extraId,
  );
});

test("desktop resource builder requires every catalog metadata theme to be readable and valid", async (t) => {
  const projectRoot = await sourceFixture(t);
  const invalidId = Object.keys(TRAE_CATALOG_METADATA)[1];
  await fs.writeFile(
    path.join(projectRoot, "plugins", "trae", "catalog", invalidId, "background.png"),
    "not a png",
  );

  await assert.rejects(
    buildDesktopResources({ projectRoot, outRoot: path.join(projectRoot, "build", "invalid-catalog") }),
    (error) => error.code === "DESKTOP_BUILD_CATALOG_INVALID"
      && error.details.id === invalidId,
  );
});

test("desktop resource manifests are deterministic and a rebuild replaces stale output", async (t) => {
  const projectRoot = await sourceFixture(t);
  const firstRoot = path.join(projectRoot, "build", "one");
  const secondRoot = path.join(projectRoot, "build", "two");
  await buildDesktopResources({ projectRoot, outRoot: firstRoot });
  await buildDesktopResources({ projectRoot, outRoot: secondRoot });
  const firstManifest = await fs.readFile(path.join(firstRoot, DESKTOP_RESOURCE_MANIFEST_FILE), "utf8");
  const secondManifest = await fs.readFile(path.join(secondRoot, DESKTOP_RESOURCE_MANIFEST_FILE), "utf8");
  const firstRuntimeManifest = await fs.readFile(path.join(firstRoot, "runtime", TRAE_RUNTIME_NAMESPACE, RUNTIME_MANIFEST_FILE), "utf8");
  const secondRuntimeManifest = await fs.readFile(path.join(secondRoot, "runtime", TRAE_RUNTIME_NAMESPACE, RUNTIME_MANIFEST_FILE), "utf8");
  assert.equal(firstManifest, secondManifest);
  assert.equal(firstRuntimeManifest, secondRuntimeManifest);

  await fs.writeFile(path.join(firstRoot, "stale-secret.txt"), "stale\n");
  await buildDesktopResources({ projectRoot, outRoot: firstRoot });
  await assert.rejects(fs.access(path.join(firstRoot, "stale-secret.txt")), (error) => error.code === "ENOENT");
  assert.equal(await fs.readFile(path.join(firstRoot, DESKTOP_RESOURCE_MANIFEST_FILE), "utf8"), firstManifest);
  const buildEntries = await fs.readdir(path.dirname(firstRoot));
  assert.equal(buildEntries.some((entry) => entry.startsWith(".one.stage-") || entry.startsWith(".one.backup-")), false);
});

test("desktop and runtime manifests both detect tampered packaged files", async (t) => {
  const projectRoot = await sourceFixture(t);
  const outRoot = path.join(projectRoot, "build", "tamper");
  await buildDesktopResources({ projectRoot, outRoot });
  const runtimeSource = path.join(outRoot, "runtime", TRAE_RUNTIME_NAMESPACE);
  await fs.writeFile(path.join(runtimeSource, "scripts", "injector.mjs"), "tampered\n");

  await assert.rejects(
    validateDesktopResourceManifest({ resourceRoot: outRoot }),
    (error) => error.code === "RESOURCE_INTEGRITY_FAILED"
      && error.details.path === `runtime/${TRAE_RUNTIME_NAMESPACE}/scripts/injector.mjs`,
  );
  const installer = new VersionedRuntimeInstaller({
    runtimeRoot: path.join(projectRoot, "user-data", "runtime"),
    namespace: TRAE_RUNTIME_NAMESPACE,
  });
  await assert.rejects(
    installer.install({ sourceRoot: runtimeSource }),
    (error) => error.code === "RUNTIME_PACKAGE_INTEGRITY_FAILED"
      && error.details.path === "scripts/injector.mjs",
  );
});

test("symlinked input is rejected before atomic replacement changes a valid output", {
  skip: process.platform === "win32",
}, async (t) => {
  const projectRoot = await sourceFixture(t);
  const outRoot = path.join(projectRoot, "build", "atomic");
  await buildDesktopResources({ projectRoot, outRoot });
  const before = await fs.readFile(path.join(outRoot, DESKTOP_RESOURCE_MANIFEST_FILE));
  const indexPath = path.join(projectRoot, "studio", "dist", "index.html");
  const outside = path.join(projectRoot, "outside.html");
  await fs.writeFile(outside, "<!doctype html><title>outside</title>\n");
  await fs.rm(indexPath);
  await fs.symlink(outside, indexPath);

  await assert.rejects(
    buildDesktopResources({ projectRoot, outRoot }),
    (error) => error.code === "DESKTOP_BUILD_SYMLINK_UNSUPPORTED"
      && error.details.path === "studio/dist/index.html",
  );
  assert.deepEqual(await fs.readFile(path.join(outRoot, DESKTOP_RESOURCE_MANIFEST_FILE)), before);
  const buildEntries = await fs.readdir(path.dirname(outRoot));
  assert.equal(buildEntries.some((entry) => entry.startsWith(".atomic.stage-") || entry.startsWith(".atomic.backup-")), false);
});

test("desktop resource CLI accepts explicit project and output paths", async (t) => {
  const projectRoot = await sourceFixture(t);
  const outRoot = path.join(projectRoot, "cli-output");
  const parsed = parseBuildArguments(["--project-root", projectRoot, `--out=${outRoot}`], { cwd: "/" });
  assert.deepEqual(parsed, { projectRoot, outRoot });
  assert.throws(
    () => parseBuildArguments(["--out", outRoot, "--out", outRoot]),
    (error) => error.code === "INVALID_ARGUMENT",
  );

  const { stdout, stderr } = await execFile(process.execPath, [
    BUILD_SCRIPT,
    "--project-root", projectRoot,
    "--out", outRoot,
  ]);
  assert.equal(stderr, "");
  assert.equal(JSON.parse(stdout).outRoot, outRoot);
  assert.equal((await validateDesktopResourceManifest({ resourceRoot: outRoot })).valid, true);
});
