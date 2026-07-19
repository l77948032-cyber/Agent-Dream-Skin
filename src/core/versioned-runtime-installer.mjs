import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./errors.mjs";
import { resolveResourcePath } from "./desktop-layout.mjs";

export const RUNTIME_MANIFEST_FILE = "runtime-manifest.v1.json";
export const RUNTIME_STATE_FILE = "active-runtime.v1.json";

const MANIFEST_FIELDS = new Set(["schemaVersion", "namespace", "version", "files"]);
const FILE_FIELDS = new Set(["path", "sha256", "bytes", "mode"]);
const STATE_FIELDS = new Set([
  "schemaVersion", "namespace", "activeVersion", "previousVersion", "activatedAt",
]);
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const VERSION_PATTERN = /^[0-9a-z](?:[0-9a-z.+_-]{0,126}[0-9a-z])?$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label, code) {
  if (!isPlainObject(value)) throw new ToolError(code, `${label} must be an object.`);
  const fields = Object.keys(value).filter((field) => !allowed.has(field));
  if (fields.length) throw new ToolError(code, `${label} contains unsupported fields.`, { fields });
}

function assertNamespace(value) {
  if (typeof value !== "string" || !NAMESPACE_PATTERN.test(value) || value === "." || value === "..") {
    throw new ToolError("RUNTIME_NAMESPACE_INVALID", "Runtime namespace contains unsafe characters.", { value });
  }
  return value;
}

function assertVersion(value) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value) || value === "." || value === "..") {
    throw new ToolError("RUNTIME_VERSION_INVALID", "Runtime version contains unsafe characters.", { value });
  }
  return value;
}

function assertAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new ToolError("RUNTIME_PATH_INVALID", `${label} must be an absolute path.`, { path: value });
  }
  return path.resolve(value);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertRegularUnsymLinkedFile(root, target, relativePath, errorCode = "RUNTIME_PACKAGE_INVALID") {
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new ToolError(errorCode, "Runtime package is missing a declared file.", { path: relativePath });
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new ToolError(errorCode, "Runtime packages cannot contain symbolic links.", { path: relativePath });
    }
  }
  const stat = await fs.lstat(target);
  if (!stat.isFile()) {
    throw new ToolError(errorCode, "Runtime manifest entries must reference regular files.", {
      path: relativePath,
    });
  }
}

function parseRuntimeManifest(value, expectedNamespace) {
  rejectUnknownFields(value, MANIFEST_FIELDS, "runtime manifest", "RUNTIME_MANIFEST_INVALID");
  if (value.schemaVersion !== 1) {
    throw new ToolError("RUNTIME_MANIFEST_UNSUPPORTED", "Runtime manifest schemaVersion must be 1.", {
      schemaVersion: value.schemaVersion,
    });
  }
  const namespace = assertNamespace(value.namespace);
  if (namespace !== expectedNamespace) {
    throw new ToolError("RUNTIME_NAMESPACE_MISMATCH", "Runtime package belongs to a different namespace.", {
      expected: expectedNamespace,
      actual: namespace,
    });
  }
  const version = assertVersion(value.version);
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new ToolError("RUNTIME_MANIFEST_INVALID", "Runtime manifest must list at least one file.");
  }
  const seen = new Set();
  const files = value.files.map((file, index) => {
    const label = `files[${index}]`;
    rejectUnknownFields(file, FILE_FIELDS, label, "RUNTIME_MANIFEST_INVALID");
    resolveResourcePath("/runtime-root", file.path);
    if (file.path === RUNTIME_MANIFEST_FILE) {
      throw new ToolError("RUNTIME_MANIFEST_INVALID", `${RUNTIME_MANIFEST_FILE} is reserved for installer metadata.`);
    }
    if (seen.has(file.path)) {
      throw new ToolError("RUNTIME_MANIFEST_INVALID", "Runtime manifest contains duplicate file paths.", {
        path: file.path,
      });
    }
    seen.add(file.path);
    if (typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      throw new ToolError("RUNTIME_MANIFEST_INVALID", `${label}.sha256 must be a lowercase SHA-256 digest.`);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new ToolError("RUNTIME_MANIFEST_INVALID", `${label}.bytes must be a non-negative safe integer.`);
    }
    if (file.mode !== undefined && (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777)) {
      throw new ToolError("RUNTIME_MANIFEST_INVALID", `${label}.mode must be an integer between 0 and 0777.`);
    }
    return { ...file, mode: file.mode ?? 0o644 };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return { schemaVersion: 1, namespace, version, files };
}

async function readJsonFile(filePath, missingCode, invalidCode, label) {
  let text;
  try {
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ToolError(invalidCode, `${label} must be a regular file.`, { path: filePath });
    }
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error.code === "ENOENT") throw new ToolError(missingCode, `${label} is missing.`, { path: filePath });
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ToolError(invalidCode, `${label} is not valid JSON.`, { path: filePath }, { cause: error });
  }
}

async function writeDurableFile(filePath, buffer, mode) {
  const handle = await fs.open(filePath, "wx", mode);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.chmod(filePath, mode);
}

function canonicalManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runtimeFileInventory(root, current = root) {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw new ToolError("RUNTIME_INSTALL_CORRUPT", "Installed runtime contains a symbolic link.", {
        path: relative,
      });
    }
    if (stat.isDirectory()) files.push(...await runtimeFileInventory(root, absolute));
    else if (stat.isFile()) files.push(relative);
    else {
      throw new ToolError("RUNTIME_INSTALL_CORRUPT", "Installed runtime contains an unsupported filesystem entry.", {
        path: relative,
      });
    }
  }
  return files;
}

export class VersionedRuntimeInstaller {
  constructor({
    runtimeRoot,
    namespace,
    now = () => new Date(),
    lockTimeoutMs = 5000,
    staleLockMs = 300000,
  } = {}) {
    this.runtimeRoot = assertAbsolutePath(runtimeRoot, "runtimeRoot");
    this.namespace = assertNamespace(namespace);
    this.namespaceRoot = path.join(this.runtimeRoot, this.namespace);
    this.versionsRoot = path.join(this.namespaceRoot, "versions");
    this.stagingRoot = path.join(this.namespaceRoot, ".staging");
    this.statePath = path.join(this.namespaceRoot, RUNTIME_STATE_FILE);
    this.lockPath = path.join(this.namespaceRoot, ".install.lock");
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.staleLockMs = staleLockMs;
  }

  versionPath(version) {
    return path.join(this.versionsRoot, assertVersion(version));
  }

  async ensureRoots() {
    await fs.mkdir(this.namespaceRoot, { recursive: true, mode: 0o700 });
    await Promise.all([
      fs.mkdir(this.versionsRoot, { recursive: true, mode: 0o700 }),
      fs.mkdir(this.stagingRoot, { recursive: true, mode: 0o700 }),
    ]);
  }

  async withLock(action) {
    await this.ensureRoots();
    const deadline = Date.now() + this.lockTimeoutMs;
    while (true) {
      try {
        await fs.mkdir(this.lockPath);
        await fs.writeFile(path.join(this.lockPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          createdAt: this.now().toISOString(),
        }), { mode: 0o600 });
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await this.recoverStaleLock()) {
          await fs.rm(this.lockPath, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new ToolError("RUNTIME_INSTALL_BUSY", "Another runtime installation is still running.");
        }
        await sleep(50);
      }
    }
    try {
      return await action();
    } finally {
      await fs.rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async recoverStaleLock() {
    let owner;
    try {
      owner = JSON.parse(await fs.readFile(path.join(this.lockPath, "owner.json"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) {
        try {
          const stat = await fs.stat(this.lockPath);
          return Date.now() - stat.mtimeMs > this.staleLockMs;
        } catch (statError) {
          if (statError.code === "ENOENT") return true;
          throw statError;
        }
      }
      throw error;
    }
    if (!Number.isInteger(owner.pid) || owner.pid < 1) return true;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      if (error.code === "ESRCH") return true;
      if (error.code === "EPERM") return false;
      throw error;
    }
  }

  async loadPackageManifest({ sourceRoot, manifest, manifestPath } = {}) {
    const source = assertAbsolutePath(sourceRoot, "sourceRoot");
    const sourceStat = await fs.lstat(source).catch((error) => {
      if (error.code === "ENOENT") {
        throw new ToolError("RUNTIME_PACKAGE_MISSING", "Runtime package source does not exist.", { sourceRoot: source });
      }
      throw error;
    });
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
      throw new ToolError("RUNTIME_PACKAGE_INVALID", "Runtime package source must be a regular directory.");
    }
    if (manifest !== undefined && manifestPath !== undefined) {
      throw new ToolError("RUNTIME_MANIFEST_INVALID", "Provide manifest or manifestPath, not both.");
    }
    let value = manifest;
    if (value === undefined) {
      const file = manifestPath === undefined
        ? path.join(source, RUNTIME_MANIFEST_FILE)
        : assertAbsolutePath(manifestPath, "manifestPath");
      if (!isInside(source, file)) {
        throw new ToolError("RUNTIME_MANIFEST_INVALID", "Runtime manifest must be inside sourceRoot.", {
          manifestPath: file,
        });
      }
      await assertRegularUnsymLinkedFile(source, file, path.relative(source, file));
      value = await readJsonFile(
        file,
        "RUNTIME_MANIFEST_MISSING",
        "RUNTIME_MANIFEST_INVALID",
        "Runtime manifest",
      );
    }
    return { sourceRoot: source, manifest: parseRuntimeManifest(value, this.namespace) };
  }

  async cleanInterruptedArtifactsLocked() {
    const stagingEntries = await fs.readdir(this.stagingRoot).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    await Promise.all(stagingEntries.map((entry) => fs.rm(path.join(this.stagingRoot, entry), {
      recursive: true,
      force: true,
    })));
    const namespaceEntries = await fs.readdir(this.namespaceRoot).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const statePrefix = `.${RUNTIME_STATE_FILE}.`;
    await Promise.all(namespaceEntries
      .filter((entry) => entry.startsWith(statePrefix) && entry.endsWith(".tmp"))
      .map((entry) => fs.rm(path.join(this.namespaceRoot, entry), { force: true })));
  }

  async verifyFiles(root, manifest, errorCode = "RUNTIME_INTEGRITY_FAILED") {
    const verified = [];
    for (const file of manifest.files) {
      const target = resolveResourcePath(root, file.path);
      await assertRegularUnsymLinkedFile(root, target, file.path, errorCode);
      const buffer = await fs.readFile(target);
      const actualSha256 = sha256(buffer);
      if (buffer.length !== file.bytes || actualSha256 !== file.sha256) {
        throw new ToolError(errorCode, "Runtime file failed integrity validation.", {
          path: file.path,
          expectedBytes: file.bytes,
          actualBytes: buffer.length,
          expectedSha256: file.sha256,
          actualSha256,
        });
      }
      verified.push({ path: file.path, bytes: buffer.length, sha256: actualSha256 });
    }
    return verified;
  }

  async verifyInstalledVersion(version) {
    const id = assertVersion(version);
    const root = this.versionPath(id);
    let stat;
    try {
      stat = await fs.lstat(root);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new ToolError("RUNTIME_VERSION_NOT_FOUND", `Runtime version '${id}' is not installed.`);
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new ToolError("RUNTIME_INSTALL_CORRUPT", "Installed runtime version is not a regular directory.", {
        version: id,
      });
    }
    const manifestValue = await readJsonFile(
      path.join(root, RUNTIME_MANIFEST_FILE),
      "RUNTIME_INSTALL_CORRUPT",
      "RUNTIME_INSTALL_CORRUPT",
      "Installed runtime manifest",
    );
    const manifest = parseRuntimeManifest(manifestValue, this.namespace);
    if (manifest.version !== id) {
      throw new ToolError("RUNTIME_INSTALL_CORRUPT", "Installed runtime directory does not match its manifest version.", {
        directoryVersion: id,
        manifestVersion: manifest.version,
      });
    }
    const files = await this.verifyFiles(root, manifest, "RUNTIME_INSTALL_CORRUPT");
    const inventory = (await runtimeFileInventory(root)).sort();
    const expectedInventory = [...manifest.files.map((file) => file.path), RUNTIME_MANIFEST_FILE].sort();
    if (
      inventory.length !== expectedInventory.length
      || inventory.some((file, index) => file !== expectedInventory[index])
    ) {
      throw new ToolError("RUNTIME_INSTALL_CORRUPT", "Installed runtime contains undeclared or missing files.", {
        expected: expectedInventory,
        actual: inventory,
      });
    }
    return { valid: true, namespace: this.namespace, version: id, root, manifest, files };
  }

  emptyState() {
    return {
      schemaVersion: 1,
      namespace: this.namespace,
      activeVersion: null,
      previousVersion: null,
      activatedAt: null,
    };
  }

  async readState() {
    if (!(await pathExists(this.statePath))) return this.emptyState();
    const state = await readJsonFile(
      this.statePath,
      "RUNTIME_STATE_INVALID",
      "RUNTIME_STATE_INVALID",
      "Runtime state",
    );
    rejectUnknownFields(state, STATE_FIELDS, "runtime state", "RUNTIME_STATE_INVALID");
    if (state.schemaVersion !== 1 || state.namespace !== this.namespace) {
      throw new ToolError("RUNTIME_STATE_INVALID", "Runtime state schema or namespace is invalid.");
    }
    for (const field of ["activeVersion", "previousVersion"]) {
      if (state[field] !== null) assertVersion(state[field]);
    }
    if (state.activeVersion !== null && state.activeVersion === state.previousVersion) {
      throw new ToolError("RUNTIME_STATE_INVALID", "Runtime state cannot use the same active and previous version.");
    }
    if (state.activatedAt !== null && (typeof state.activatedAt !== "string" || Number.isNaN(Date.parse(state.activatedAt)))) {
      throw new ToolError("RUNTIME_STATE_INVALID", "Runtime state activatedAt must be an ISO timestamp or null.");
    }
    return { ...state };
  }

  async writeStateAtomic(state) {
    const temporary = path.join(this.namespaceRoot, `.${RUNTIME_STATE_FILE}.${crypto.randomUUID()}.tmp`);
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, this.statePath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async activateLocked(version) {
    const id = assertVersion(version);
    await this.verifyInstalledVersion(id);
    const current = await this.readState();
    if (current.activeVersion === id) return { changed: false, ...current };
    const next = {
      schemaVersion: 1,
      namespace: this.namespace,
      activeVersion: id,
      previousVersion: current.activeVersion,
      activatedAt: this.now().toISOString(),
    };
    await this.writeStateAtomic(next);
    return { changed: true, ...next };
  }

  async install({ sourceRoot, manifest, manifestPath, activate = true } = {}) {
    const runtimePackage = await this.loadPackageManifest({ sourceRoot, manifest, manifestPath });
    await this.verifyFiles(runtimePackage.sourceRoot, runtimePackage.manifest, "RUNTIME_PACKAGE_INTEGRITY_FAILED");
    return this.withLock(async () => {
      await this.cleanInterruptedArtifactsLocked();
      const { version } = runtimePackage.manifest;
      const destination = this.versionPath(version);
      const stage = path.join(this.stagingRoot, `${version}-${crypto.randomUUID()}`);
      let installed = false;
      try {
        if (await pathExists(destination)) {
          const existing = await this.verifyInstalledVersion(version).catch((error) => {
            throw new ToolError("RUNTIME_VERSION_CONFLICT", "Runtime version already exists but does not match a valid immutable package.", {
              version,
              cause: error.message,
            });
          });
          const existingManifest = canonicalManifest(existing.manifest);
          const incomingManifest = canonicalManifest(runtimePackage.manifest);
          if (existingManifest !== incomingManifest) {
            throw new ToolError("RUNTIME_VERSION_CONFLICT", "Runtime version already exists with different contents.", {
              version,
            });
          }
        } else {
          await fs.mkdir(stage, { recursive: false, mode: 0o700 });
          for (const file of runtimePackage.manifest.files) {
            const source = resolveResourcePath(runtimePackage.sourceRoot, file.path);
            const target = resolveResourcePath(stage, file.path);
            await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
            await writeDurableFile(target, await fs.readFile(source), file.mode);
          }
          await writeDurableFile(
            path.join(stage, RUNTIME_MANIFEST_FILE),
            Buffer.from(canonicalManifest(runtimePackage.manifest)),
            0o600,
          );
          await this.verifyFiles(stage, runtimePackage.manifest, "RUNTIME_STAGE_INTEGRITY_FAILED");
          await fs.rename(stage, destination);
          installed = true;
        }

        const activation = activate ? await this.activateLocked(version) : null;
        return {
          installed,
          namespace: this.namespace,
          version,
          root: destination,
          activeVersion: activation?.activeVersion ?? (await this.readState()).activeVersion,
          previousVersion: activation?.previousVersion ?? (await this.readState()).previousVersion,
        };
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    });
  }

  async activate(version) {
    return this.withLock(() => this.activateLocked(version));
  }

  async rollback() {
    return this.withLock(async () => {
      const current = await this.readState();
      if (!current.previousVersion) {
        throw new ToolError("RUNTIME_ROLLBACK_UNAVAILABLE", "No previous runtime version is available.");
      }
      await this.verifyInstalledVersion(current.previousVersion);
      const next = {
        schemaVersion: 1,
        namespace: this.namespace,
        activeVersion: current.previousVersion,
        previousVersion: current.activeVersion,
        activatedAt: this.now().toISOString(),
      };
      await this.writeStateAtomic(next);
      return { changed: true, ...next };
    });
  }

  async resolveActive({ verify = true } = {}) {
    const state = await this.readState();
    if (!state.activeVersion) return { ...state, root: null, valid: true };
    const root = this.versionPath(state.activeVersion);
    if (verify) await this.verifyInstalledVersion(state.activeVersion);
    return { ...state, root, valid: true };
  }

  async listInstalled() {
    await this.ensureRoots();
    const entries = await fs.readdir(this.versionsRoot, { withFileTypes: true });
    const versions = entries
      .filter((entry) => entry.isDirectory() && VERSION_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const state = await this.readState();
    return { namespace: this.namespace, versions, ...state };
  }
}
