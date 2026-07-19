import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./errors.mjs";
import { resolvePluginResources, validatePluginManifest } from "./plugin-api.mjs";

const REGISTRY_VERSION = 1;
const MAX_PACKAGE_FILES = 4096;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;

function clone(value) {
  return structuredClone(value);
}

function emptyRegistry() {
  return { schemaVersion: REGISTRY_VERSION, active: {}, installed: [] };
}

function validRegistry(input) {
  if (!input || input.schemaVersion !== REGISTRY_VERSION || !Array.isArray(input.installed)) {
    return emptyRegistry();
  }
  return {
    schemaVersion: REGISTRY_VERSION,
    active: input.active && typeof input.active === "object" && !Array.isArray(input.active)
      ? { ...input.active }
      : {},
    installed: input.installed.filter((entry) => (
      entry
      && typeof entry.id === "string"
      && typeof entry.version === "string"
      && typeof entry.digest === "string"
      && /^[a-f0-9]{64}$/.test(entry.digest)
    )),
  };
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function realDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = await fs.lstat(resolved).catch((error) => {
    throw new ToolError("INVALID_PLUGIN_PACKAGE", `${label} does not exist.`, { path: resolved }, { cause: error });
  });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ToolError("INVALID_PLUGIN_PACKAGE", `${label} must be a real directory.`);
  }
  return fs.realpath(resolved);
}

async function packageDigest(rootPath) {
  const root = await realDirectory(rootPath, "Plugin package");
  const files = [];
  let totalBytes = 0;

  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new ToolError("INVALID_PLUGIN_PACKAGE", "Plugin packages cannot contain symbolic links.", {
          path: relative,
        });
      }
      if (stat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!stat.isFile()) {
        throw new ToolError("INVALID_PLUGIN_PACKAGE", "Plugin packages may contain only directories and files.", {
          path: relative,
        });
      }
      files.push({ absolute, relative, bytes: stat.size });
      totalBytes += stat.size;
      if (files.length > MAX_PACKAGE_FILES || totalBytes > MAX_PACKAGE_BYTES) {
        throw new ToolError("PLUGIN_PACKAGE_TOO_LARGE", "Plugin package exceeds the installation limits.", {
          files: files.length,
          bytes: totalBytes,
        });
      }
    }
  }

  await visit(root);
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(await fs.readFile(file.absolute));
    hash.update("\0");
  }
  return { root, digest: hash.digest("hex"), files: files.length, bytes: totalBytes };
}

async function inspectPackage(sourceRoot) {
  const packageInfo = await packageDigest(sourceRoot);
  let manifest;
  try {
    manifest = validatePluginManifest(JSON.parse(await fs.readFile(path.join(packageInfo.root, "plugin.json"), "utf8")));
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError("INVALID_PLUGIN_PACKAGE", "Plugin package has no valid plugin.json.", undefined, { cause: error });
  }
  if (!manifest.entry || !manifest.catalog) {
    throw new ToolError("INVALID_PLUGIN_PACKAGE", "Installable plugins must declare entry and catalog paths.", {
      pluginId: manifest.id,
    });
  }
  const resources = await resolvePluginResources(manifest, packageInfo.root);
  return { ...packageInfo, manifest, resources };
}

export class PluginInstaller {
  constructor({ pluginsRoot, registryPath, trustedBuiltInRoots = [] } = {}) {
    if (typeof pluginsRoot !== "string" || !pluginsRoot) {
      throw new ToolError("INVALID_PLUGIN_DEPENDENCY", "Plugin Installer requires pluginsRoot.");
    }
    this.pluginsRoot = path.resolve(pluginsRoot);
    this.registryPath = path.resolve(registryPath || path.join(this.pluginsRoot, "registry.v1.json"));
    this.trustedBuiltInRoots = new Set(trustedBuiltInRoots.map((entry) => path.resolve(entry)));
    this.queue = Promise.resolve();
  }

  enqueue(operation) {
    const queued = this.queue.then(operation, operation);
    this.queue = queued.catch(() => {});
    return queued;
  }

  async readRegistry() {
    try {
      return validRegistry(JSON.parse(await fs.readFile(this.registryPath, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return emptyRegistry();
    }
  }

  async list() {
    return clone(await this.readRegistry());
  }

  install(sourceRoot, { expectedDigest, activate = true } = {}) {
    return this.enqueue(async () => {
      const source = await inspectPackage(sourceRoot);
      const trustedRoots = await Promise.all([...this.trustedBuiltInRoots].map((entry) => (
        fs.realpath(entry).catch(() => entry)
      )));
      const trustedBuiltIn = trustedRoots.includes(source.root);
      if (!trustedBuiltIn && (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest))) {
        throw new ToolError("UNTRUSTED_PLUGIN_PACKAGE", "External plugin installation requires an expected SHA-256 digest.", {
          pluginId: source.manifest.id,
        });
      }
      if (expectedDigest && source.digest !== expectedDigest) {
        throw new ToolError("PLUGIN_DIGEST_MISMATCH", "Plugin package digest does not match the trusted digest.", {
          expectedDigest,
          actualDigest: source.digest,
        });
      }

      const pluginRoot = path.join(this.pluginsRoot, source.manifest.id);
      const target = path.join(pluginRoot, source.manifest.version);
      const stage = path.join(pluginRoot, `.${source.manifest.version}.stage-${crypto.randomUUID()}`);
      await fs.mkdir(pluginRoot, { recursive: true, mode: 0o700 });
      try {
        await fs.cp(source.root, stage, { recursive: true, errorOnExist: true, force: false });
        const staged = await inspectPackage(stage);
        if (staged.digest !== source.digest) {
          throw new ToolError("PLUGIN_DIGEST_MISMATCH", "Plugin package changed during installation.");
        }

        const targetExists = await fs.access(target).then(() => true, () => false);
        const existingDigest = targetExists ? (await inspectPackage(target)).digest : null;
        if (existingDigest && existingDigest !== staged.digest) {
          throw new ToolError("PLUGIN_VERSION_CONFLICT", "The same plugin version is already installed with different contents.", {
            pluginId: source.manifest.id,
            version: source.manifest.version,
          });
        }
        if (!existingDigest) await fs.rename(stage, target);

        const registry = await this.readRegistry();
        const entry = {
          id: source.manifest.id,
          version: source.manifest.version,
          targetId: source.manifest.target.id,
          digest: source.digest,
          trustedBuiltIn,
          installedAt: new Date().toISOString(),
        };
        const index = registry.installed.findIndex((candidate) => (
          candidate.id === entry.id && candidate.version === entry.version
        ));
        if (index >= 0) registry.installed[index] = { ...registry.installed[index], ...entry };
        else registry.installed.push(entry);
        if (activate) registry.active[entry.id] = entry.version;
        await atomicJson(this.registryPath, registry);
        return { ...entry, path: target, active: registry.active[entry.id] === entry.version };
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    });
  }

  activate(id, version) {
    return this.enqueue(async () => {
      const registry = await this.readRegistry();
      const entry = registry.installed.find((candidate) => candidate.id === id && candidate.version === version);
      if (!entry) throw new ToolError("PLUGIN_NOT_INSTALLED", `Plugin '${id}' version '${version}' is not installed.`);
      registry.active[id] = version;
      await atomicJson(this.registryPath, registry);
      return { ...entry, active: true, path: path.join(this.pluginsRoot, id, version) };
    });
  }

  active(id) {
    return this.readRegistry().then((registry) => {
      const version = registry.active[id];
      if (!version) return null;
      const entry = registry.installed.find((candidate) => candidate.id === id && candidate.version === version);
      return entry ? { ...entry, path: path.join(this.pluginsRoot, id, version) } : null;
    });
  }
}

export { inspectPackage as inspectPluginPackage };
