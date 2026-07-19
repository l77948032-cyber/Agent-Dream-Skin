import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_RESOURCE_MANIFEST_FILE,
  resolveResourcePath,
  validateDesktopResourceManifest,
} from "../src/core/desktop-layout.mjs";
import { ToolError } from "../src/core/errors.mjs";
import { validatePluginManifest } from "../src/core/plugin-api.mjs";
import { loadTheme } from "../src/core/theme-loader.mjs";
import {
  RUNTIME_MANIFEST_FILE,
  VersionedRuntimeInstaller,
} from "../src/core/versioned-runtime-installer.mjs";
import { TRAE_CATALOG_METADATA } from "../plugins/trae/catalog.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECT_ROOT = path.resolve(HERE, "..");
export const DEFAULT_DESKTOP_RESOURCE_DIRECTORY = "build/desktop-resources";
export const TRAE_RUNTIME_NAMESPACE = "dreamskin.trae";

export const DESKTOP_RUNTIME_SCRIPT_PATHS = Object.freeze([
  "scripts/common-macos.sh",
  "scripts/common-windows.ps1",
  "scripts/injector.mjs",
  "scripts/start-trae-skin-macos.sh",
  "scripts/start-trae-skin-windows.ps1",
  "scripts/status-trae-skin-macos.sh",
  "scripts/status-trae-skin-windows.ps1",
  "scripts/stop-trae-skin-macos.sh",
  "scripts/stop-trae-skin-windows.ps1",
  "scripts/verify-trae-skin-macos.sh",
  "scripts/verify-trae-skin-windows.ps1",
]);

const RUNTIME_CORE_PATHS = Object.freeze([
  "src/core/paths.mjs",
  "src/core/theme-loader.mjs",
  "src/core/theme-model.mjs",
]);
const ACP_SOURCE_PATH = "node_modules/@agentclientprotocol/codex-acp/dist/index.js";
const ACP_DESTINATION_PATH = "acp/codex-acp.mjs";
export const DESKTOP_LEGAL_PATHS = Object.freeze([
  ["LICENSE", "legal/DreamSkin-LICENSE"],
  ["NOTICE.md", "legal/DreamSkin-NOTICE.md"],
  ["THIRD_PARTY_NOTICES.md", "legal/THIRD_PARTY_NOTICES.md"],
  ["node_modules/@agentclientprotocol/codex-acp/LICENSE", "legal/codex-acp-LICENSE"],
  ["node_modules/@agentclientprotocol/sdk/LICENSE", "legal/agentclientprotocol-sdk-LICENSE"],
  ["node_modules/@modelcontextprotocol/sdk/LICENSE", "legal/modelcontextprotocol-sdk-LICENSE"],
  ["node_modules/zod/LICENSE", "legal/zod-LICENSE"],
  ["studio/node_modules/react/LICENSE", "legal/react-LICENSE"],
  ["studio/node_modules/react-dom/LICENSE", "legal/react-dom-LICENSE"],
  ["studio/node_modules/lucide-react/LICENSE", "legal/lucide-react-LICENSE"],
  ["studio/node_modules/motion/LICENSE.md", "legal/motion-LICENSE.md"],
]);
const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const MAX_OUTPUT_FILES = 5000;
const THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const THEME_IMAGE_PATTERN = /^[^/\\]+\.(?:png|jpe?g|webp)$/i;
const STUDIO_EXTENSIONS = new Set([
  ".css", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".js", ".json",
  ".png", ".svg", ".ttf", ".webp", ".woff", ".woff2",
]);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function pathStat(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function buildError(code, message, details, cause) {
  return new ToolError(code, message, details, cause ? { cause } : undefined);
}

async function assertSourceRoot(projectRoot) {
  const stat = await pathStat(projectRoot);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw buildError("DESKTOP_BUILD_SOURCE_INVALID", "projectRoot must be a regular source directory.", {
      projectRoot,
    });
  }
}

async function assertUnsymLinkedSourcePath(projectRoot, target, relativePath, expectedType) {
  let current = projectRoot;
  for (const segment of path.relative(projectRoot, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await pathStat(current);
    if (!stat) {
      throw buildError("DESKTOP_BUILD_SOURCE_MISSING", "A required desktop resource source is missing.", {
        path: relativePath,
      });
    }
    if (stat.isSymbolicLink()) {
      throw buildError("DESKTOP_BUILD_SYMLINK_UNSUPPORTED", "Desktop resources cannot be built from symbolic links.", {
        path: relativePath,
      });
    }
  }
  const stat = await fs.lstat(target);
  if ((expectedType === "file" && !stat.isFile()) || (expectedType === "directory" && !stat.isDirectory())) {
    throw buildError("DESKTOP_BUILD_SOURCE_INVALID", `Required source must be a ${expectedType}.`, {
      path: relativePath,
    });
  }
  return stat;
}

async function readSourceFile(projectRoot, relativePath) {
  const target = resolveResourcePath(projectRoot, relativePath);
  const stat = await assertUnsymLinkedSourcePath(projectRoot, target, relativePath, "file");
  if (stat.size > MAX_SOURCE_FILE_BYTES) {
    throw buildError("DESKTOP_BUILD_SOURCE_TOO_LARGE", "A desktop resource source exceeds the per-file limit.", {
      path: relativePath,
      bytes: stat.size,
      maximumBytes: MAX_SOURCE_FILE_BYTES,
    });
  }
  return fs.readFile(target);
}

async function readJsonSource(projectRoot, relativePath, label) {
  const buffer = await readSourceFile(projectRoot, relativePath);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    throw buildError("DESKTOP_BUILD_SOURCE_INVALID", `${label} is not valid JSON.`, { path: relativePath }, error);
  }
}

async function readSourceTree(projectRoot, relativeRoot) {
  const sourceRoot = resolveResourcePath(projectRoot, relativeRoot);
  await assertUnsymLinkedSourcePath(projectRoot, sourceRoot, relativeRoot, "directory");
  const files = new Map();

  async function visit(current, relativeDirectory = "") {
    const entries = (await fs.readdir(current, { withFileTypes: true }))
      .sort((left, right) => stableCompare(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw buildError("DESKTOP_BUILD_SYMLINK_UNSUPPORTED", "Desktop resource trees cannot contain symbolic links.", {
          path: `${relativeRoot}/${relative}`,
        });
      }
      if (stat.isDirectory()) await visit(absolute, relative);
      else if (stat.isFile()) {
        if (stat.size > MAX_SOURCE_FILE_BYTES) {
          throw buildError("DESKTOP_BUILD_SOURCE_TOO_LARGE", "A desktop resource source exceeds the per-file limit.", {
            path: `${relativeRoot}/${relative}`,
            bytes: stat.size,
            maximumBytes: MAX_SOURCE_FILE_BYTES,
          });
        }
        files.set(relative, await fs.readFile(absolute));
      } else {
        throw buildError("DESKTOP_BUILD_SOURCE_INVALID", "Desktop resources must contain only files and directories.", {
          path: `${relativeRoot}/${relative}`,
        });
      }
    }
  }

  await visit(sourceRoot);
  return files;
}

class OutputFiles {
  constructor() {
    this.files = new Map();
    this.bytes = 0;
  }

  add(relativePath, contents, mode = 0o644) {
    resolveResourcePath("/desktop-output", relativePath);
    if (this.files.has(relativePath)) {
      throw buildError("DESKTOP_BUILD_COLLISION", "Two desktop resources use the same output path.", {
        path: relativePath,
      });
    }
    const buffer = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    if (this.files.size + 1 > MAX_OUTPUT_FILES || this.bytes + buffer.length > MAX_OUTPUT_BYTES) {
      throw buildError("DESKTOP_BUILD_OUTPUT_TOO_LARGE", "Desktop resources exceed the bounded output size.", {
        files: this.files.size + 1,
        bytes: this.bytes + buffer.length,
      });
    }
    this.files.set(relativePath, { buffer, mode });
    this.bytes += buffer.length;
  }

  get(relativePath) {
    const file = this.files.get(relativePath);
    if (!file) throw buildError("DESKTOP_BUILD_SOURCE_INVALID", "A runtime dependency was not collected.", {
      path: relativePath,
    });
    return file;
  }

  entries() {
    return [...this.files.entries()].sort(([left], [right]) => stableCompare(left, right));
  }
}

function runtimeMode(relativePath) {
  return relativePath.endsWith(".sh") ? 0o755 : 0o644;
}

function validateStudioPath(relativePath) {
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.startsWith(".")) || !STUDIO_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) {
    throw buildError("DESKTOP_BUILD_SOURCE_INVALID", "Studio dist contains a file type that is not allowed in desktop resources.", {
      path: `studio/dist/${relativePath}`,
    });
  }
}

async function catalogThemes(files, catalogRoot, projectRoot) {
  const themes = new Map();
  for (const [relativePath, buffer] of files) {
    const segments = relativePath.split("/");
    if (segments.length !== 2 || !THEME_ID_PATTERN.test(segments[0])) {
      throw buildError("DESKTOP_BUILD_SOURCE_INVALID", "Trae catalog must contain one directory per structured theme.", {
        path: `${catalogRoot}/${relativePath}`,
      });
    }
    const [id, file] = segments;
    if (!themes.has(id)) themes.set(id, new Map());
    themes.get(id).set(file, buffer);
  }

  const catalogDirectory = resolveResourcePath(projectRoot, catalogRoot);
  const catalogEntries = (await fs.readdir(catalogDirectory, { withFileTypes: true }))
    .sort((left, right) => stableCompare(left.name, right.name));
  const invalidEntries = catalogEntries
    .filter((entry) => !entry.isDirectory() || !THEME_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name);
  if (invalidEntries.length) {
    throw buildError("DESKTOP_BUILD_SOURCE_INVALID", "Trae catalog must contain only structured theme directories.", {
      catalogRoot,
      entries: invalidEntries,
    });
  }
  const expectedIds = Object.keys(TRAE_CATALOG_METADATA).sort(stableCompare);
  const actualIds = catalogEntries.map((entry) => entry.name);
  const actualIdSet = new Set(actualIds);
  const missing = expectedIds.filter((id) => !actualIdSet.has(id));
  const extra = actualIds.filter((id) => !Object.hasOwn(TRAE_CATALOG_METADATA, id));
  if (missing.length || extra.length) {
    throw buildError(
      "DESKTOP_BUILD_CATALOG_MISMATCH",
      "Packaged Trae catalog directories must exactly match TRAE_CATALOG_METADATA.",
      { catalogRoot, expected: expectedIds, actual: actualIds, missing, extra },
    );
  }

  for (const id of expectedIds) {
    const themeFiles = themes.get(id);
    const configBuffer = themeFiles?.get("theme.json");
    if (!configBuffer) {
      throw buildError("DESKTOP_BUILD_CATALOG_INVALID", "Catalog theme is missing theme.json.", { id });
    }
    let theme;
    try {
      theme = JSON.parse(configBuffer.toString("utf8"));
    } catch (error) {
      throw buildError("DESKTOP_BUILD_CATALOG_INVALID", "Catalog theme.json is not valid JSON.", { id }, error);
    }
    if (theme.id !== id || typeof theme.image !== "string" || !THEME_IMAGE_PATTERN.test(theme.image)) {
      throw buildError("DESKTOP_BUILD_CATALOG_INVALID", "Catalog theme id or image declaration is invalid.", { id });
    }
    const allowed = new Set(["theme.json", theme.image]);
    const actual = [...themeFiles.keys()].sort(stableCompare);
    if (actual.length !== allowed.size || actual.some((file) => !allowed.has(file))) {
      throw buildError("DESKTOP_BUILD_CATALOG_INVALID", "Catalog themes may contain only theme.json and their declared image.", {
        id,
        files: actual,
      });
    }
    try {
      await loadTheme(path.join(catalogDirectory, id), {
        projectRoot,
        allowedRoot: catalogDirectory,
      });
    } catch (error) {
      throw buildError(
        "DESKTOP_BUILD_CATALOG_INVALID",
        "Catalog metadata must resolve to a readable, valid theme.",
        { id, path: `${catalogRoot}/${id}` },
        error,
      );
    }
  }
  return themes;
}

async function assertMirroredSource(projectRoot, sourcePath, canonicalPath, canonicalBuffer) {
  const source = await readSourceFile(projectRoot, sourcePath);
  if (!source.equals(canonicalBuffer)) {
    throw buildError(
      "DESKTOP_BUILD_SOURCE_MISMATCH",
      "Studio, Tool, and runtime mirror resources must remain byte-for-byte identical.",
      { sourcePath, canonicalPath },
    );
  }
}

async function collectDesktopFiles(projectRoot) {
  const output = new OutputFiles();
  const packageManifest = await readJsonSource(projectRoot, "package.json", "package.json");
  if (typeof packageManifest.version !== "string" || !packageManifest.version) {
    throw buildError("DESKTOP_BUILD_SOURCE_INVALID", "package.json must declare a version.");
  }

  const sourcePluginManifest = validatePluginManifest(
    await readJsonSource(projectRoot, "plugins/trae/plugin.json", "Trae plugin manifest"),
  );
  if (sourcePluginManifest.id !== TRAE_RUNTIME_NAMESPACE || sourcePluginManifest.version !== packageManifest.version) {
    throw buildError("DESKTOP_BUILD_VERSION_MISMATCH", "Product, plugin, and runtime versions must stay aligned.", {
      productVersion: packageManifest.version,
      pluginVersion: sourcePluginManifest.version,
      pluginId: sourcePluginManifest.id,
    });
  }
  if (!sourcePluginManifest.catalog || !sourcePluginManifest.theme.runtimeMappingPath) {
    throw buildError("DESKTOP_BUILD_SOURCE_INVALID", "The Trae plugin must declare catalog and runtime mapping resources.");
  }

  const { entry: _entry, ...packagedPluginManifest } = structuredClone(sourcePluginManifest);
  validatePluginManifest(packagedPluginManifest);
  output.add("plugins/trae/plugin.json", `${JSON.stringify(packagedPluginManifest, null, 2)}\n`);

  const pluginResourceBuffers = new Map();
  for (const relativePath of Object.values(sourcePluginManifest.theme).sort(stableCompare)) {
    const sourcePath = `plugins/trae/${relativePath}`;
    const buffer = await readSourceFile(projectRoot, sourcePath);
    JSON.parse(buffer.toString("utf8"));
    pluginResourceBuffers.set(relativePath, buffer);
    output.add(sourcePath, buffer);
  }

  const pluginCss = await readSourceFile(projectRoot, "plugins/trae/assets/trae-skin.css");
  await Promise.all([
    assertMirroredSource(
      projectRoot,
      "assets/trae-skin.css",
      "plugins/trae/assets/trae-skin.css",
      pluginCss,
    ),
    assertMirroredSource(
      projectRoot,
      "registry/components.v1.json",
      `plugins/trae/${sourcePluginManifest.theme.registryPath}`,
      pluginResourceBuffers.get(sourcePluginManifest.theme.registryPath),
    ),
    assertMirroredSource(
      projectRoot,
      "registry/theme-runtime.v1.json",
      `plugins/trae/${sourcePluginManifest.theme.runtimeMappingPath}`,
      pluginResourceBuffers.get(sourcePluginManifest.theme.runtimeMappingPath),
    ),
    assertMirroredSource(
      projectRoot,
      "schemas/theme-v1.schema.json",
      `plugins/trae/${sourcePluginManifest.theme.schemaPath}`,
      pluginResourceBuffers.get(sourcePluginManifest.theme.schemaPath),
    ),
  ]);
  output.add("plugins/trae/assets/trae-skin.css", pluginCss);
  const catalogSourceRoot = `plugins/trae/${sourcePluginManifest.catalog.root}`;
  const catalogFiles = await readSourceTree(projectRoot, catalogSourceRoot);
  await catalogThemes(catalogFiles, catalogSourceRoot, projectRoot);
  for (const [relativePath, buffer] of [...catalogFiles].sort(([left], [right]) => stableCompare(left, right))) {
    output.add(`${catalogSourceRoot}/${relativePath}`, buffer);
  }

  const studioFiles = await readSourceTree(projectRoot, "studio/dist");
  if (!studioFiles.has("index.html")) {
    throw buildError("DESKTOP_BUILD_SOURCE_MISSING", "Build Studio before building desktop resources.", {
      path: "studio/dist/index.html",
    });
  }
  for (const [relativePath, buffer] of [...studioFiles].sort(([left], [right]) => stableCompare(left, right))) {
    validateStudioPath(relativePath);
    output.add(`studio/dist/${relativePath}`, buffer);
  }

  for (const relativePath of DESKTOP_RUNTIME_SCRIPT_PATHS) {
    output.add(relativePath, await readSourceFile(projectRoot, relativePath), runtimeMode(relativePath));
  }
  for (const relativePath of RUNTIME_CORE_PATHS) {
    output.add(relativePath, await readSourceFile(projectRoot, relativePath));
  }
  output.add("assets/renderer-inject.js", await readSourceFile(projectRoot, "assets/renderer-inject.js"));
  output.add("assets/trae-skin.css", pluginCss);
  output.add("registry/components.v1.json", pluginResourceBuffers.get(sourcePluginManifest.theme.registryPath));
  output.add("registry/theme-runtime.v1.json", pluginResourceBuffers.get(sourcePluginManifest.theme.runtimeMappingPath));
  output.add(ACP_DESTINATION_PATH, await readSourceFile(projectRoot, ACP_SOURCE_PATH), 0o755);
  for (const [sourcePath, destinationPath] of DESKTOP_LEGAL_PATHS) {
    output.add(destinationPath, await readSourceFile(projectRoot, sourcePath));
  }

  const runtimePayloadPaths = [
    ...DESKTOP_RUNTIME_SCRIPT_PATHS,
    ...RUNTIME_CORE_PATHS,
    "assets/renderer-inject.js",
    "assets/trae-skin.css",
    "registry/components.v1.json",
    "registry/theme-runtime.v1.json",
  ].sort(stableCompare);
  const runtimePackageRoot = `runtime/${TRAE_RUNTIME_NAMESPACE}`;
  const runtimeFiles = [];
  for (const relativePath of runtimePayloadPaths) {
    const file = output.get(relativePath);
    output.add(`${runtimePackageRoot}/${relativePath}`, file.buffer, file.mode);
    runtimeFiles.push({
      path: relativePath,
      sha256: sha256(file.buffer),
      bytes: file.buffer.length,
      mode: file.mode,
    });
  }
  const runtimeManifest = {
    schemaVersion: 1,
    namespace: TRAE_RUNTIME_NAMESPACE,
    version: sourcePluginManifest.version,
    files: runtimeFiles,
  };
  output.add(`${runtimePackageRoot}/${RUNTIME_MANIFEST_FILE}`, `${JSON.stringify(runtimeManifest, null, 2)}\n`);

  const resourceManifest = {
    schemaVersion: 1,
    product: "dreamskin",
    version: packageManifest.version,
    resources: output.entries().map(([relativePath, file]) => ({
      path: relativePath,
      type: "file",
      sha256: sha256(file.buffer),
      bytes: file.buffer.length,
    })),
  };
  output.add(DESKTOP_RESOURCE_MANIFEST_FILE, `${JSON.stringify(resourceManifest, null, 2)}\n`);
  return { output, resourceManifest, runtimeManifest };
}

async function writeOutputFiles(root, output) {
  await fs.mkdir(root, { recursive: false, mode: 0o755 });
  for (const [relativePath, file] of output.entries()) {
    const target = resolveResourcePath(root, relativePath);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
    const handle = await fs.open(target, "wx", file.mode);
    try {
      await handle.writeFile(file.buffer);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(target, file.mode);
  }
}

async function outputInventory(root, current = root) {
  const entries = (await fs.readdir(current, { withFileTypes: true }))
    .sort((left, right) => stableCompare(left.name, right.name));
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      throw buildError("DESKTOP_BUILD_INTEGRITY_FAILED", "Staged desktop resources contain a symbolic link.", {
        path: relative,
      });
    }
    if (stat.isDirectory()) files.push(...await outputInventory(root, absolute));
    else if (stat.isFile()) files.push(relative);
    else throw buildError("DESKTOP_BUILD_INTEGRITY_FAILED", "Staged desktop resources contain an invalid entry.", {
      path: relative,
    });
  }
  return files.sort(stableCompare);
}

async function verifyStagedOutput(stage, output) {
  await validateDesktopResourceManifest({ resourceRoot: stage });
  const runtimeRoot = path.join(stage, "runtime", TRAE_RUNTIME_NAMESPACE);
  const verifier = new VersionedRuntimeInstaller({
    runtimeRoot: path.join(stage, ".runtime-verifier"),
    namespace: TRAE_RUNTIME_NAMESPACE,
  });
  const runtimePackage = await verifier.loadPackageManifest({ sourceRoot: runtimeRoot });
  await verifier.verifyFiles(runtimePackage.sourceRoot, runtimePackage.manifest, "DESKTOP_RUNTIME_INTEGRITY_FAILED");
  const actual = await outputInventory(stage);
  const expected = output.entries().map(([relativePath]) => relativePath);
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw buildError("DESKTOP_BUILD_INTEGRITY_FAILED", "Staged desktop resources do not match the build inventory.", {
      expected,
      actual,
    });
  }
}

function assertSafeOutputRoot(projectRoot, outRoot) {
  if (outRoot === path.parse(outRoot).root || outRoot === projectRoot || isInside(outRoot, projectRoot)) {
    throw buildError("DESKTOP_BUILD_OUTPUT_UNSAFE", "Desktop resource output cannot replace projectRoot or its parent.", {
      outRoot,
      projectRoot,
    });
  }
  const protectedSources = [
    "studio/dist", "plugins/trae", "scripts", "assets", "registry", "src/core",
    "node_modules/@agentclientprotocol/codex-acp",
  ].map((relativePath) => path.join(projectRoot, ...relativePath.split("/")));
  if (protectedSources.some((source) => isInside(source, outRoot) || isInside(outRoot, source))) {
    throw buildError("DESKTOP_BUILD_OUTPUT_UNSAFE", "Desktop resource output cannot overlap a required source tree.", {
      outRoot,
    });
  }
}

async function replaceOutput(stage, outRoot) {
  const parent = path.dirname(outRoot);
  const name = path.basename(outRoot);
  const existing = await pathStat(outRoot);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw buildError("DESKTOP_BUILD_OUTPUT_UNSAFE", "Desktop resource output must be a regular directory.", {
      outRoot,
    });
  }
  if (!existing) {
    await fs.rename(stage, outRoot);
    return;
  }

  const backup = path.join(parent, `.${name}.backup-${crypto.randomUUID()}`);
  await fs.rename(outRoot, backup);
  try {
    await fs.rename(stage, outRoot);
  } catch (error) {
    await fs.rename(backup, outRoot).catch((restoreError) => {
      throw new AggregateError([error, restoreError], "Desktop resource replacement and rollback both failed.");
    });
    throw error;
  }
  await fs.rm(backup, { recursive: true, force: true });
}

export async function buildDesktopResources({
  projectRoot = DEFAULT_PROJECT_ROOT,
  outRoot = path.join(projectRoot, ...DEFAULT_DESKTOP_RESOURCE_DIRECTORY.split("/")),
} = {}) {
  const sourceRoot = path.resolve(projectRoot);
  const destination = path.resolve(outRoot);
  await assertSourceRoot(sourceRoot);
  assertSafeOutputRoot(sourceRoot, destination);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  const destinationStat = await pathStat(destination);
  if (destinationStat?.isSymbolicLink()) {
    throw buildError("DESKTOP_BUILD_OUTPUT_UNSAFE", "Desktop resource output cannot be a symbolic link.", {
      outRoot: destination,
    });
  }

  const stage = path.join(path.dirname(destination), `.${path.basename(destination)}.stage-${crypto.randomUUID()}`);
  try {
    const collected = await collectDesktopFiles(sourceRoot);
    await writeOutputFiles(stage, collected.output);
    await verifyStagedOutput(stage, collected.output);
    await replaceOutput(stage, destination);
    return {
      outRoot: destination,
      resourceManifestPath: path.join(destination, DESKTOP_RESOURCE_MANIFEST_FILE),
      runtimePackageRoot: path.join(destination, "runtime", TRAE_RUNTIME_NAMESPACE),
      runtimeManifestPath: path.join(destination, "runtime", TRAE_RUNTIME_NAMESPACE, RUNTIME_MANIFEST_FILE),
      version: collected.resourceManifest.version,
      files: collected.output.files.size,
      bytes: collected.output.bytes,
    };
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export function parseBuildArguments(argv, { cwd = process.cwd(), defaultProjectRoot = DEFAULT_PROJECT_ROOT } = {}) {
  let projectRootArgument;
  let outArgument;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [flag, inlineValue] = argument.includes("=") ? argument.split(/=(.*)/s, 2) : [argument, undefined];
    if (flag !== "--project-root" && flag !== "--out") {
      throw buildError("INVALID_ARGUMENT", `Unknown desktop resource build argument: ${argument}`);
    }
    const value = inlineValue === undefined ? argv[++index] : inlineValue;
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      throw buildError("INVALID_ARGUMENT", `${flag} requires a path value.`);
    }
    if (flag === "--project-root") {
      if (projectRootArgument !== undefined) throw buildError("INVALID_ARGUMENT", "--project-root can be provided once.");
      projectRootArgument = value;
    } else {
      if (outArgument !== undefined) throw buildError("INVALID_ARGUMENT", "--out can be provided once.");
      outArgument = value;
    }
  }
  const projectRoot = path.resolve(cwd, projectRootArgument || defaultProjectRoot);
  const outRoot = outArgument
    ? path.resolve(cwd, outArgument)
    : path.join(projectRoot, ...DEFAULT_DESKTOP_RESOURCE_DIRECTORY.split("/"));
  return { projectRoot, outRoot };
}

export const BUILD_DESKTOP_RESOURCES_USAGE = [
  "Usage: node scripts/build-desktop-resources.mjs [--project-root PATH] [--out PATH]",
  "Builds the minimal verified read-only resource tree consumed by DreamSkin Studio Desktop.",
].join("\n");

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`${BUILD_DESKTOP_RESOURCES_USAGE}\n`);
  } else {
    buildDesktopResources(parseBuildArguments(process.argv.slice(2)))
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
