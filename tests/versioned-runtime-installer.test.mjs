import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RUNTIME_MANIFEST_FILE,
  VersionedRuntimeInstaller,
} from "../src/core/versioned-runtime-installer.mjs";

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-runtime-installer-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "user-data", "dreamskin", "runtime");
  return { root, runtimeRoot };
}

async function createPackage(root, {
  namespace = "dreamskin.trae",
  version = "1.0.0",
  files = {
    "bin/launch.sh": { contents: "#!/bin/sh\necho ready\n", mode: 0o755 },
    "config/runtime.json": { contents: '{"transport":"cdp"}\n', mode: 0o644 },
  },
} = {}) {
  const sourceRoot = path.join(root, `package-${namespace}-${version}-${crypto.randomUUID()}`);
  await fs.mkdir(sourceRoot, { recursive: true });
  const entries = [];
  for (const [relativePath, definition] of Object.entries(files)) {
    const buffer = Buffer.from(definition.contents);
    const filePath = path.join(sourceRoot, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, buffer, { mode: definition.mode });
    entries.push({
      path: relativePath,
      sha256: sha256(buffer),
      bytes: buffer.length,
      mode: definition.mode,
    });
  }
  const manifest = { schemaVersion: 1, namespace, version, files: entries };
  await fs.writeFile(path.join(sourceRoot, RUNTIME_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return { sourceRoot, manifest };
}

test("runtime installer stages verified immutable versions and tracks active/previous atomically", async (t) => {
  const paths = await fixture(t);
  let tick = 0;
  const installer = new VersionedRuntimeInstaller({
    runtimeRoot: paths.runtimeRoot,
    namespace: "dreamskin.trae",
    now: () => new Date(Date.UTC(2026, 6, 19, 10, 0, tick++)),
  });
  const one = await createPackage(paths.root, { version: "1.0.0" });
  const two = await createPackage(paths.root, {
    version: "1.1.0",
    files: {
      "bin/launch.sh": { contents: "#!/bin/sh\necho v1.1\n", mode: 0o755 },
      "config/runtime.json": { contents: '{"transport":"native-acp"}\n', mode: 0o644 },
    },
  });

  const first = await installer.install({ sourceRoot: one.sourceRoot });
  assert.equal(first.installed, true);
  assert.equal(first.activeVersion, "1.0.0");
  assert.equal(first.previousVersion, null);
  assert.equal((await fs.stat(path.join(first.root, "bin", "launch.sh"))).mode & 0o777, 0o755);

  await fs.mkdir(path.join(installer.stagingRoot, "interrupted-install"));
  await fs.writeFile(path.join(installer.namespaceRoot, ".active-runtime.v1.json.interrupted.tmp"), "partial");
  const second = await installer.install({ sourceRoot: two.sourceRoot });
  assert.equal(second.activeVersion, "1.1.0");
  assert.equal(second.previousVersion, "1.0.0");
  assert.equal((await installer.resolveActive()).root, installer.versionPath("1.1.0"));

  const rolledBack = await installer.rollback();
  assert.equal(rolledBack.activeVersion, "1.0.0");
  assert.equal(rolledBack.previousVersion, "1.1.0");
  assert.deepEqual((await installer.listInstalled()).versions, ["1.0.0", "1.1.0"]);
  assert.deepEqual(await fs.readdir(installer.stagingRoot), []);
  await assert.rejects(
    fs.access(path.join(installer.namespaceRoot, ".active-runtime.v1.json.interrupted.tmp")),
    (error) => error.code === "ENOENT",
  );
});

test("runtime package hash failure leaves the active install and version directory untouched", async (t) => {
  const paths = await fixture(t);
  const installer = new VersionedRuntimeInstaller({
    runtimeRoot: paths.runtimeRoot,
    namespace: "dreamskin.trae",
  });
  const stable = await createPackage(paths.root, { version: "2.0.0" });
  await installer.install({ sourceRoot: stable.sourceRoot });

  const corrupt = await createPackage(paths.root, { version: "2.1.0" });
  await fs.writeFile(path.join(corrupt.sourceRoot, "bin", "launch.sh"), "tampered\n");
  await assert.rejects(
    installer.install({ sourceRoot: corrupt.sourceRoot }),
    (error) => error.code === "RUNTIME_PACKAGE_INTEGRITY_FAILED"
      && error.details.path === "bin/launch.sh",
  );
  assert.equal((await installer.resolveActive()).activeVersion, "2.0.0");
  await assert.rejects(fs.access(installer.versionPath("2.1.0")), (error) => error.code === "ENOENT");
  assert.deepEqual(await fs.readdir(installer.stagingRoot), []);
});

test("same runtime package is idempotent while an altered immutable version is rejected", async (t) => {
  const paths = await fixture(t);
  const installer = new VersionedRuntimeInstaller({
    runtimeRoot: paths.runtimeRoot,
    namespace: "dreamskin.trae",
  });
  const runtimePackage = await createPackage(paths.root, { version: "3.0.0-beta.1" });
  const first = await installer.install({ sourceRoot: runtimePackage.sourceRoot, activate: false });
  const repeated = await installer.install({ sourceRoot: runtimePackage.sourceRoot, activate: false });
  assert.equal(first.installed, true);
  assert.equal(repeated.installed, false);
  assert.equal((await installer.readState()).activeVersion, null);

  const undeclared = path.join(installer.versionPath("3.0.0-beta.1"), "bin", "undeclared.sh");
  await fs.writeFile(undeclared, "unexpected\n");
  await assert.rejects(
    installer.verifyInstalledVersion("3.0.0-beta.1"),
    (error) => error.code === "RUNTIME_INSTALL_CORRUPT" && error.details.actual.includes("bin/undeclared.sh"),
  );
  await fs.rm(undeclared);
  await fs.writeFile(path.join(installer.versionPath("3.0.0-beta.1"), "bin", "launch.sh"), "changed\n");
  await assert.rejects(
    installer.install({ sourceRoot: runtimePackage.sourceRoot }),
    (error) => error.code === "RUNTIME_VERSION_CONFLICT",
  );
  assert.equal((await installer.readState()).activeVersion, null);
});

test("runtime installer rejects foreign namespaces, traversal, and unavailable rollback", async (t) => {
  const paths = await fixture(t);
  const installer = new VersionedRuntimeInstaller({
    runtimeRoot: paths.runtimeRoot,
    namespace: "dreamskin.trae",
  });
  const foreign = await createPackage(paths.root, { namespace: "dreamskin.other", version: "1.0.0" });
  await assert.rejects(
    installer.install({ sourceRoot: foreign.sourceRoot }),
    (error) => error.code === "RUNTIME_NAMESPACE_MISMATCH",
  );

  const sourceRoot = path.join(paths.root, "traversal-package");
  await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, RUNTIME_MANIFEST_FILE), JSON.stringify({
    schemaVersion: 1,
    namespace: "dreamskin.trae",
    version: "1.0.0",
    files: [{ path: "../escape", sha256: "0".repeat(64), bytes: 0 }],
  }));
  await assert.rejects(
    installer.install({ sourceRoot }),
    (error) => error.code === "RESOURCE_PATH_INVALID",
  );
  await assert.rejects(
    installer.rollback(),
    (error) => error.code === "RUNTIME_ROLLBACK_UNAVAILABLE",
  );
});

test("runtime installer rejects symlinked package files", {
  skip: process.platform === "win32",
}, async (t) => {
  const paths = await fixture(t);
  const installer = new VersionedRuntimeInstaller({
    runtimeRoot: paths.runtimeRoot,
    namespace: "dreamskin.trae",
  });
  const sourceRoot = path.join(paths.root, "linked-package");
  const outside = path.join(paths.root, "outside.sh");
  const buffer = Buffer.from("#!/bin/sh\nexit 0\n");
  await fs.mkdir(path.join(sourceRoot, "bin"), { recursive: true });
  await fs.writeFile(outside, buffer);
  await fs.symlink(outside, path.join(sourceRoot, "bin", "launch.sh"));
  await fs.writeFile(path.join(sourceRoot, RUNTIME_MANIFEST_FILE), JSON.stringify({
    schemaVersion: 1,
    namespace: "dreamskin.trae",
    version: "1.0.0",
    files: [{ path: "bin/launch.sh", sha256: sha256(buffer), bytes: buffer.length, mode: 0o755 }],
  }));
  await assert.rejects(
    installer.install({ sourceRoot }),
    (error) => error.code === "RUNTIME_PACKAGE_INTEGRITY_FAILED",
  );
});
