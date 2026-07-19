import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./errors.mjs";

export const DESKTOP_RESOURCE_MANIFEST_FILE = "resource-manifest.v1.json";

const RESOURCE_MANIFEST_FIELDS = new Set(["schemaVersion", "product", "version", "resources"]);
const RESOURCE_ENTRY_FIELDS = new Set(["path", "type", "sha256", "bytes"]);
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/;
const THEME_ID_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknownFields(value, allowed, label, code = "RESOURCE_MANIFEST_INVALID") {
  if (!isPlainObject(value)) throw new ToolError(code, `${label} must be an object.`);
  const unknown = Object.keys(value).filter((field) => !allowed.has(field));
  if (unknown.length) {
    throw new ToolError(code, `${label} contains unsupported fields.`, { fields: unknown });
  }
}

function assertAbsoluteDirectoryInput(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolError("DESKTOP_PATH_INVALID", `${label} must be an absolute path.`);
  }
  if (!path.isAbsolute(value)) {
    throw new ToolError("DESKTOP_PATH_INVALID", `${label} must be an absolute path.`, { path: value });
  }
  return path.resolve(value);
}

function assertIdentifier(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value) || value === "." || value === "..") {
    throw new ToolError("DESKTOP_NAMESPACE_INVALID", `${label} contains unsafe characters.`, { value });
  }
  return value;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveResourcePath(resourceRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\")) {
    throw new ToolError("RESOURCE_PATH_INVALID", "Resource paths must be non-empty POSIX relative paths.", {
      path: relativePath,
    });
  }
  if (path.posix.isAbsolute(relativePath)) {
    throw new ToolError("RESOURCE_PATH_INVALID", "Resource paths cannot be absolute.", { path: relativePath });
  }
  const normalized = path.posix.normalize(relativePath);
  const segments = normalized.split("/");
  if (
    normalized === "."
    || normalized !== relativePath
    || segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new ToolError("RESOURCE_PATH_INVALID", "Resource paths cannot traverse or normalize outside the bundle.", {
      path: relativePath,
    });
  }
  const root = path.resolve(resourceRoot);
  const target = path.resolve(root, ...segments);
  if (!isInside(root, target)) {
    throw new ToolError("RESOURCE_PATH_INVALID", "Resource path escapes the bundle root.", { path: relativePath });
  }
  return target;
}

async function assertNoSymlinkComponents(root, target, relativePath) {
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      throw new ToolError("RESOURCE_SYMLINK_UNSUPPORTED", "Required resources cannot be symbolic links.", {
        path: relativePath,
      });
    }
  }
}

function resourcePathParents(relativePath) {
  const segments = relativePath.split("/");
  const parents = [];
  for (let index = 1; index < segments.length; index += 1) {
    parents.push(segments.slice(0, index).join("/"));
  }
  return parents;
}

function expectedResourceInventory(root, manifestFile, resources) {
  const manifestRelativePath = path.relative(root, manifestFile).split(path.sep).join("/");
  const declared = new Map([[manifestRelativePath, "file"]]);
  for (const resource of resources) {
    if (resource.path === manifestRelativePath) {
      throw new ToolError("RESOURCE_MANIFEST_INVALID", "resource manifest cannot declare itself as a resource.", {
        path: resource.path,
      });
    }
    declared.set(resource.path, resource.type);
  }

  const expected = new Map(declared);
  for (const relativePath of declared.keys()) {
    for (const parent of resourcePathParents(relativePath)) {
      if (declared.get(parent) === "file") {
        throw new ToolError("RESOURCE_MANIFEST_INVALID", "A file resource cannot contain another resource.", {
          path: parent,
          descendant: relativePath,
        });
      }
      if (!expected.has(parent)) expected.set(parent, "directory");
    }
  }
  return expected;
}

async function validateExactResourceInventory(root, expected) {
  const actual = new Map();

  async function visit(current) {
    const entries = (await fs.readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      const relativePath = path.relative(root, target).split(path.sep).join("/");
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        throw new ToolError("RESOURCE_SYMLINK_UNSUPPORTED", "Desktop resources cannot contain symbolic links.", {
          path: relativePath,
        });
      }
      const actualType = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : null;
      if (!actualType) {
        throw new ToolError("RESOURCE_INVENTORY_FAILED", "Desktop resources contain an unsupported entry.", {
          path: relativePath,
        });
      }
      const expectedType = expected.get(relativePath);
      if (!expectedType) {
        throw new ToolError("RESOURCE_INVENTORY_FAILED", "Desktop resources contain an undeclared entry.", {
          path: relativePath,
          actual: actualType,
        });
      }
      if (actualType !== expectedType) {
        throw new ToolError("RESOURCE_TYPE_MISMATCH", "A desktop resource has the wrong type.", {
          path: relativePath,
          expected: expectedType,
          actual: actualType,
        });
      }
      actual.set(relativePath, actualType);
      if (actualType === "directory") await visit(target);
    }
  }

  await visit(root);
  const missing = [...expected.keys()].filter((relativePath) => !actual.has(relativePath));
  if (missing.length) {
    throw new ToolError("RESOURCE_INVENTORY_FAILED", "Desktop resources are missing declared entries.", {
      missing,
    });
  }
}

function parseResourceManifest(text, manifestPath, expectedProduct) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    throw new ToolError("RESOURCE_MANIFEST_INVALID", "Desktop resource manifest is not valid JSON.", {
      manifestPath,
    }, { cause: error });
  }
  rejectUnknownFields(manifest, RESOURCE_MANIFEST_FIELDS, "resource manifest");
  if (manifest.schemaVersion !== 1) {
    throw new ToolError("RESOURCE_MANIFEST_UNSUPPORTED", "Desktop resource manifest schemaVersion must be 1.", {
      schemaVersion: manifest.schemaVersion,
    });
  }
  if (manifest.product !== expectedProduct) {
    throw new ToolError("RESOURCE_PRODUCT_MISMATCH", "Desktop resources belong to a different product.", {
      expected: expectedProduct,
      actual: manifest.product,
    });
  }
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new ToolError("RESOURCE_MANIFEST_INVALID", "resource manifest version must be a non-empty string.");
  }
  if (!Array.isArray(manifest.resources) || manifest.resources.length === 0) {
    throw new ToolError("RESOURCE_MANIFEST_INVALID", "resource manifest must declare at least one required resource.");
  }

  const seen = new Set();
  const resources = manifest.resources.map((resource, index) => {
    const label = `resources[${index}]`;
    rejectUnknownFields(resource, RESOURCE_ENTRY_FIELDS, label);
    const absolutePath = resolveResourcePath("/resource-root", resource.path);
    void absolutePath;
    if (seen.has(resource.path)) {
      throw new ToolError("RESOURCE_MANIFEST_INVALID", "resource manifest contains duplicate paths.", {
        path: resource.path,
      });
    }
    seen.add(resource.path);
    if (resource.type !== "file" && resource.type !== "directory") {
      throw new ToolError("RESOURCE_MANIFEST_INVALID", `${label}.type must be file or directory.`);
    }
    if (resource.type === "file" && (typeof resource.sha256 !== "string" || !SHA256_PATTERN.test(resource.sha256))) {
      throw new ToolError("RESOURCE_MANIFEST_INVALID", `${label}.sha256 must be a lowercase SHA-256 digest.`);
    }
    if (resource.type === "directory" && (resource.sha256 !== undefined || resource.bytes !== undefined)) {
      throw new ToolError("RESOURCE_MANIFEST_INVALID", `${label} cannot hash a directory; list required files explicitly.`);
    }
    if (resource.bytes !== undefined && (!Number.isSafeInteger(resource.bytes) || resource.bytes < 0)) {
      throw new ToolError("RESOURCE_MANIFEST_INVALID", `${label}.bytes must be a non-negative safe integer.`);
    }
    return { ...resource };
  });
  return { ...manifest, resources };
}

export async function validateDesktopResourceManifest({
  resourceRoot,
  manifestPath,
  expectedProduct = "dreamskin",
} = {}) {
  const root = assertAbsoluteDirectoryInput(resourceRoot, "resourceRoot");
  const manifestFile = assertAbsoluteDirectoryInput(
    manifestPath ?? path.join(root, DESKTOP_RESOURCE_MANIFEST_FILE),
    "manifestPath",
  );
  if (!isInside(root, manifestFile)) {
    throw new ToolError("RESOURCE_MANIFEST_INVALID", "Desktop resource manifest must be inside resourceRoot.", {
      manifestPath: manifestFile,
      resourceRoot: root,
    });
  }

  let text;
  try {
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink()) {
      throw new ToolError("RESOURCE_SYMLINK_UNSUPPORTED", "Desktop resource root cannot be a symbolic link.", {
        path: ".",
      });
    }
    if (!rootStat.isDirectory()) {
      throw new ToolError("RESOURCE_MANIFEST_INVALID", "resourceRoot must be a directory.");
    }
    const manifestRelativePath = path.relative(root, manifestFile).split(path.sep).join("/");
    await assertNoSymlinkComponents(root, manifestFile, manifestRelativePath);
    const stat = await fs.lstat(manifestFile);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ToolError("RESOURCE_MANIFEST_INVALID", "Desktop resource manifest must be a regular file.");
    }
    text = await fs.readFile(manifestFile, "utf8");
  } catch (error) {
    if (error instanceof ToolError) throw error;
    if (error.code === "ENOENT") {
      throw new ToolError("RESOURCE_MANIFEST_MISSING", "Desktop resource manifest is missing.", {
        manifestPath: manifestFile,
      });
    }
    throw error;
  }

  const manifest = parseResourceManifest(text, manifestFile, expectedProduct);
  const expectedInventory = expectedResourceInventory(root, manifestFile, manifest.resources);
  const verified = [];
  for (const resource of manifest.resources) {
    const target = resolveResourcePath(root, resource.path);
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new ToolError("REQUIRED_RESOURCE_MISSING", "A required desktop resource is missing.", {
          path: resource.path,
        });
      }
      throw error;
    }
    await assertNoSymlinkComponents(root, target, resource.path);
    if (resource.type === "file" && !stat.isFile()) {
      throw new ToolError("RESOURCE_TYPE_MISMATCH", "A required resource is not a regular file.", {
        path: resource.path,
        expected: "file",
      });
    }
    if (resource.type === "directory" && !stat.isDirectory()) {
      throw new ToolError("RESOURCE_TYPE_MISMATCH", "A required resource is not a directory.", {
        path: resource.path,
        expected: "directory",
      });
    }
    if (resource.type === "file") {
      const buffer = await fs.readFile(target);
      const actualHash = crypto.createHash("sha256").update(buffer).digest("hex");
      if (actualHash !== resource.sha256 || (resource.bytes !== undefined && buffer.length !== resource.bytes)) {
        throw new ToolError("RESOURCE_INTEGRITY_FAILED", "A required desktop resource failed integrity validation.", {
          path: resource.path,
          expectedSha256: resource.sha256,
          actualSha256: actualHash,
          expectedBytes: resource.bytes,
          actualBytes: buffer.length,
        });
      }
      verified.push({ path: resource.path, type: resource.type, bytes: buffer.length, sha256: actualHash });
    } else {
      verified.push({ path: resource.path, type: resource.type });
    }
  }
  await validateExactResourceInventory(root, expectedInventory);

  return {
    valid: true,
    product: manifest.product,
    version: manifest.version,
    manifestPath: manifestFile,
    resourceRoot: root,
    resources: verified,
  };
}

export class DesktopPathLayout {
  constructor({
    isPackaged = false,
    appPath,
    resourcesPath,
    userDataPath,
    developmentResourcesPath,
    resourceDirectory = "dreamskin",
    mutableDirectory = "dreamskin",
  } = {}) {
    this.isPackaged = Boolean(isPackaged);
    this.appPath = assertAbsoluteDirectoryInput(appPath, "appPath");
    this.userDataPath = assertAbsoluteDirectoryInput(userDataPath, "userDataPath");
    if (typeof resourceDirectory !== "string" || !THEME_ID_PATTERN.test(resourceDirectory)) {
      throw new ToolError("DESKTOP_PATH_INVALID", "resourceDirectory must be a safe directory name.");
    }
    if (typeof mutableDirectory !== "string" || !THEME_ID_PATTERN.test(mutableDirectory)) {
      throw new ToolError("DESKTOP_PATH_INVALID", "mutableDirectory must be a safe directory name.");
    }

    if (this.isPackaged) {
      this.resourcesPath = assertAbsoluteDirectoryInput(resourcesPath, "resourcesPath");
      this.resourceRoot = path.join(this.resourcesPath, resourceDirectory);
    } else {
      this.resourcesPath = resourcesPath ? assertAbsoluteDirectoryInput(resourcesPath, "resourcesPath") : null;
      this.resourceRoot = developmentResourcesPath
        ? assertAbsoluteDirectoryInput(developmentResourcesPath, "developmentResourcesPath")
        : this.appPath;
    }
    this.dataRoot = path.join(this.userDataPath, mutableDirectory);
  }

  describe() {
    return {
      mode: this.isPackaged ? "packaged" : "development",
      resourceRoot: this.resourceRoot,
      resourceManifestPath: this.resourceManifestPath,
      dataRoot: this.dataRoot,
      readOnly: {
        pluginsRoot: this.bundledPluginsRoot,
        themesRoot: this.bundledThemesRoot,
        runtimeRoot: this.bundledRuntimeRoot,
        registryRoot: this.registryRoot,
        schemasRoot: this.schemasRoot,
      },
      mutable: {
        pluginsRoot: this.pluginsRoot,
        themesRoot: this.themesRoot,
        runtimeRoot: this.runtimeRoot,
        stateRoot: this.stateRoot,
        backupsRoot: this.backupsRoot,
        logsRoot: this.logsRoot,
      },
    };
  }

  get resourceManifestPath() { return path.join(this.resourceRoot, DESKTOP_RESOURCE_MANIFEST_FILE); }
  get bundledPluginsRoot() { return path.join(this.resourceRoot, "plugins"); }
  get bundledThemesRoot() { return path.join(this.resourceRoot, "themes"); }
  get bundledRuntimeRoot() { return path.join(this.resourceRoot, "runtime"); }
  get registryRoot() { return path.join(this.resourceRoot, "registry"); }
  get schemasRoot() { return path.join(this.resourceRoot, "schemas"); }
  get scriptsRoot() { return path.join(this.resourceRoot, "scripts"); }
  get pluginsRoot() { return path.join(this.dataRoot, "plugins"); }
  get themesRoot() { return path.join(this.dataRoot, "themes"); }
  get runtimeRoot() { return path.join(this.dataRoot, "runtime"); }
  get stateRoot() { return path.join(this.dataRoot, "state"); }
  get backupsRoot() { return path.join(this.dataRoot, "backups"); }
  get logsRoot() { return path.join(this.dataRoot, "logs"); }

  namespace(value) {
    return assertIdentifier(value, NAMESPACE_PATTERN, "namespace");
  }

  themeId(value) {
    return assertIdentifier(value, THEME_ID_PATTERN, "theme id");
  }

  bundledPluginRoot(namespace) { return path.join(this.bundledPluginsRoot, this.namespace(namespace)); }
  bundledThemeRoot(namespace) { return path.join(this.bundledThemesRoot, this.namespace(namespace)); }
  bundledRuntimeNamespaceRoot(namespace) { return path.join(this.bundledRuntimeRoot, this.namespace(namespace)); }
  pluginRoot(namespace) { return path.join(this.pluginsRoot, this.namespace(namespace)); }
  themeRoot(namespace) { return path.join(this.themesRoot, this.namespace(namespace)); }
  themePath(namespace, themeId) { return path.join(this.themeRoot(namespace), this.themeId(themeId)); }
  runtimeNamespaceRoot(namespace) { return path.join(this.runtimeRoot, this.namespace(namespace)); }
  namespaceStateRoot(namespace) { return path.join(this.stateRoot, this.namespace(namespace)); }
  namespaceBackupsRoot(namespace) { return path.join(this.backupsRoot, this.namespace(namespace)); }

  async ensureMutableRoots(namespace) {
    const namespacedRoots = [
      this.pluginRoot(namespace),
      this.themeRoot(namespace),
      this.runtimeNamespaceRoot(namespace),
      this.namespaceStateRoot(namespace),
      this.namespaceBackupsRoot(namespace),
      this.logsRoot,
    ];
    await fs.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
    await Promise.all(namespacedRoots.map((root) => fs.mkdir(root, { recursive: true, mode: 0o700 })));
    return { namespace: this.namespace(namespace), roots: namespacedRoots };
  }

  async validateResources(options = {}) {
    return validateDesktopResourceManifest({
      resourceRoot: this.resourceRoot,
      manifestPath: this.resourceManifestPath,
      ...options,
    });
  }
}
