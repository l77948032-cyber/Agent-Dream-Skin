import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { BACKUPS_ROOT, PROJECT_ROOT, THEMES_ROOT, TOOL_DATA_ROOT } from "./paths.mjs";
import { ToolError } from "./errors.mjs";
import { loadTheme } from "./theme-loader.mjs";
import {
  COLOR_DEFAULTS,
  STATE_DEFAULTS,
  THEME_ID_PATTERN,
  VISUAL_DEFAULTS,
  normalizeTheme,
} from "./theme-model.mjs";

const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion", "id", "name", "description", "layout", "brandSubtitle", "tagline",
  "statusText", "quote", "image", "colors", "states", "visual", "appearance",
]);
const APPEARANCE_FIELDS = new Set([
  "treatment", "backgroundPosition", "backgroundSize", "backgroundOverlay",
  "backgroundBlendMode", "backgroundOpacity", "surfaceOpacity", "sidebarOpacity",
  "blur", "saturation", "radius", "shadow", "colorScheme",
]);
const COLOR_FIELDS = new Set(Object.keys(COLOR_DEFAULTS));
const STATE_FIELDS = new Set(Object.keys(STATE_DEFAULTS));
const VISUAL_FIELDS = new Set(Object.keys(VISUAL_DEFAULTS));
const TRANSACTION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MANIFEST_STATUSES = new Set(["prepared", "committed", "rollingBack", "rolledBack", "recovered"]);

function assertThemeId(id) {
  if (typeof id !== "string" || !THEME_ID_PATTERN.test(id)) {
    throw new ToolError("INVALID_THEME_ID", "Theme id must use lowercase letters, digits, hyphens, or underscores.");
  }
}

function mergePatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (typeof value === "object" && !Array.isArray(value)) result[key] = mergePatch(result[key], value);
    else result[key] = value;
  }
  return result;
}

function rejectUnknownFields(object, allowed, label) {
  if (object === undefined || object === null) return;
  if (typeof object !== "object" || Array.isArray(object)) {
    throw new ToolError("INVALID_THEME_PATCH", `${label} must be an object.`);
  }
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new ToolError("INVALID_THEME_PATCH", `${label} contains unsupported fields.`, { fields: unknown });
  }
}

function validatePatchShape(patch) {
  rejectUnknownFields(patch, TOP_LEVEL_FIELDS, "themePatch");
  rejectUnknownFields(patch?.colors, COLOR_FIELDS, "themePatch.colors");
  rejectUnknownFields(patch?.states, STATE_FIELDS, "themePatch.states");
  rejectUnknownFields(patch?.visual, VISUAL_FIELDS, "themePatch.visual");
  rejectUnknownFields(patch?.appearance, APPEARANCE_FIELDS, "themePatch.appearance");
}

function findNormalizationChanges(input, normalized, prefix = "theme") {
  const changes = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return changes;
  for (const [key, value] of Object.entries(input)) {
    if (value === null) continue;
    const field = `${prefix}.${key}`;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      changes.push(...findNormalizationChanges(value, normalized?.[key], field));
    } else if (normalized?.[key] !== value) changes.push(field);
  }
  return changes;
}

function normalizeStrict(theme, source) {
  let normalized;
  try {
    normalized = normalizeTheme(theme, source);
  } catch (error) {
    throw new ToolError("THEME_INVALID", error.message);
  }
  const changedFields = findNormalizationChanges(theme, normalized);
  if (changedFields.length) {
    throw new ToolError(
      "THEME_INVALID",
      "Theme values must already satisfy the structured schema; unsafe or out-of-range values are not silently accepted.",
      { fields: changedFields },
    );
  }
  return normalized;
}

async function pathExists(fileSystem, filePath) {
  try {
    await fileSystem.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function digestBuffer(hash, fileName, buffer) {
  hash.update(fileName);
  hash.update("\0");
  hash.update(buffer);
  return { bytes: buffer.length, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
}

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ThemeRepository {
  constructor({
    themesRoot = THEMES_ROOT,
    dataRoot = TOOL_DATA_ROOT,
    backupsRoot = BACKUPS_ROOT,
    projectRoot = PROJECT_ROOT,
    fileSystem = fs,
  } = {}) {
    this.themesRoot = path.resolve(themesRoot);
    this.dataRoot = path.resolve(dataRoot);
    this.backupsRoot = path.resolve(backupsRoot);
    this.projectRoot = path.resolve(projectRoot);
    this.fs = fileSystem;
    this.lockPath = path.join(this.dataRoot, "repository.lock");
    this.recoveryRoot = path.join(this.themesRoot, ".recovery");
  }

  themePath(id) {
    assertThemeId(id);
    return path.join(this.themesRoot, id);
  }

  async ensureRootDirectories() {
    await Promise.all([
      this.fs.mkdir(this.themesRoot, { recursive: true }),
      this.fs.mkdir(this.dataRoot, { recursive: true, mode: 0o700 }),
      this.fs.mkdir(this.backupsRoot, { recursive: true }),
    ]);
  }

  async ensureRoots() {
    await this.withLock(async () => undefined);
  }

  async withLock(action) {
    await this.ensureRootDirectories();
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await this.fs.mkdir(this.lockPath);
        await this.fs.writeFile(path.join(this.lockPath, "owner.json"), JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }));
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (await this.recoverStaleLock()) continue;
        if (Date.now() >= deadline) {
          throw new ToolError("REPOSITORY_BUSY", "Another theme transaction is still running.");
        }
        await sleep(100);
      }
    }
    try {
      await this.recoverInterruptedTransactionsLocked();
      return await action();
    } finally {
      await this.fs.rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async recoverStaleLock() {
    let stale = false;
    try {
      const owner = JSON.parse(await this.fs.readFile(path.join(this.lockPath, "owner.json"), "utf8"));
      if (!Number.isInteger(owner.pid) || owner.pid < 1) stale = true;
      else {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") stale = true;
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      try {
        const stat = await this.fs.stat(this.lockPath);
        stale = Date.now() - stat.mtimeMs > 2000;
      } catch (statError) {
        if (statError.code === "ENOENT") return true;
        throw statError;
      }
    }
    if (!stale) return false;
    await this.fs.rm(this.lockPath, { recursive: true, force: true });
    return true;
  }

  async transactionManifest(transactionId, expectedId) {
    const manifestPath = path.join(this.backupsRoot, transactionId, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await this.fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "An interrupted theme transaction has no readable manifest.", {
        transactionId,
        manifestPath,
      }, { cause: error });
    }
    const valid = manifest
      && manifest.schemaVersion === 1
      && manifest.transactionId === transactionId
      && manifest.id === expectedId
      && typeof manifest.beforeExists === "boolean"
      && (manifest.beforeExists
        ? typeof manifest.beforeRevision === "string"
        : manifest.beforeRevision === null)
      && (manifest.afterRevision === null || typeof manifest.afterRevision === "string")
      && MANIFEST_STATUSES.has(manifest.status);
    if (!valid) {
      throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "An interrupted theme transaction manifest is inconsistent.", {
        transactionId,
        expectedId,
      });
    }
    return { manifest, manifestPath };
  }

  async writeManifest(manifestPath, manifest) {
    await this.fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  async revisionAt(themeDir, allowedRoot = this.themesRoot) {
    const loaded = await loadTheme(themeDir, {
      projectRoot: this.projectRoot,
      allowedRoot,
    });
    return (await this.revisionForLoaded(loaded)).revision;
  }

  async currentRevision(id) {
    try {
      return (await this.read(id)).revision;
    } catch (error) {
      if (error.code === "THEME_NOT_FOUND") return null;
      throw error;
    }
  }

  async isolateArtifact(artifactPath, transactionId) {
    if (!(await pathExists(this.fs, artifactPath))) return null;
    await this.fs.mkdir(this.recoveryRoot, { recursive: true, mode: 0o700 });
    const destination = path.join(
      this.recoveryRoot,
      `${path.basename(artifactPath)}-${transactionId}-${crypto.randomUUID()}`,
    );
    try {
      await this.fs.rename(artifactPath, destination);
      return destination;
    } catch (error) {
      throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "An interrupted transaction artifact could not be isolated safely.", {
        artifactPath,
        destination,
        transactionId,
      }, { cause: error });
    }
  }

  async cleanupArtifact(artifactPath, transactionId) {
    try {
      await this.fs.rm(artifactPath, { recursive: true, force: true });
      return null;
    } catch (cleanupError) {
      if (!(await pathExists(this.fs, artifactPath))) return null;
      try {
        return await this.isolateArtifact(artifactPath, transactionId);
      } catch (recoveryError) {
        throw new ToolError(
          "REPOSITORY_RECOVERY_REQUIRED",
          "A transaction artifact could not be removed or isolated safely.",
          {
            artifactPath,
            transactionId,
            cleanupError: cleanupError.message,
            recoveryError: recoveryError.message,
          },
          { cause: recoveryError },
        );
      }
    }
  }

  async restoreBackup(id, transactionId, manifest) {
    if (!manifest.beforeExists || typeof manifest.beforeRevision !== "string") {
      throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "The interrupted transaction has no prior theme to restore.", {
        id,
        transactionId,
      });
    }
    const backupPath = path.join(this.backupsRoot, transactionId, "theme");
    let backupRevision;
    try {
      backupRevision = await this.revisionAt(backupPath, this.backupsRoot);
    } catch (error) {
      throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "The interrupted transaction backup is unreadable.", {
        id,
        transactionId,
      }, { cause: error });
    }
    if (backupRevision !== manifest.beforeRevision) {
      throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "The interrupted transaction backup does not match its recorded revision.", {
        id,
        transactionId,
        expectedRevision: manifest.beforeRevision,
        actualRevision: backupRevision,
      });
    }
    const recoveryStage = path.join(this.recoveryRoot, `.restore-${id}-${transactionId}-${crypto.randomUUID()}`);
    await this.fs.mkdir(this.recoveryRoot, { recursive: true, mode: 0o700 });
    await this.fs.cp(backupPath, recoveryStage, { recursive: true, errorOnExist: true });
    try {
      if (await pathExists(this.fs, this.themePath(id))) {
        throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "The live theme reappeared while recovery was in progress.", {
          id,
          transactionId,
        });
      }
      await this.fs.rename(recoveryStage, this.themePath(id));
    } catch (error) {
      throw error instanceof ToolError
        ? error
        : new ToolError("REPOSITORY_RECOVERY_REQUIRED", "The prior theme backup could not be restored.", {
          id,
          transactionId,
          recoveryStage,
        }, { cause: error });
    }
  }

  async recordRecovery(manifestPath, manifest, status, details = {}) {
    const updated = {
      ...manifest,
      status,
      recoveredAt: new Date().toISOString(),
      recovery: details,
    };
    await this.writeManifest(manifestPath, updated);
  }

  async recoverArtifactGroup({ id, transactionId, artifacts }) {
    const { manifest, manifestPath } = await this.transactionManifest(transactionId, id);
    const targetPath = this.themePath(id);
    const beforeRevision = manifest.beforeRevision;
    const afterRevision = manifest.afterRevision;
    const operation = manifest.operation || (afterRevision === null ? "delete" : "write");
    let currentRevision = await this.currentRevision(id);
    const knownCurrent = currentRevision !== null
      && (currentRevision === beforeRevision || currentRevision === afterRevision);

    if (currentRevision !== null && !knownCurrent) {
      throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "A live theme changed after an interrupted transaction; recovery is ambiguous.", {
        id,
        transactionId,
        currentRevision,
        beforeRevision,
        afterRevision,
        artifacts: [...artifacts.keys()],
      });
    }

    const artifactRevisions = new Map();
    for (const [kind, artifactPath] of artifacts) {
      try {
        artifactRevisions.set(kind, await this.revisionAt(artifactPath));
      } catch (error) {
        artifactRevisions.set(kind, null);
      }
    }

    const restoreRetired = async (expectedRevision) => {
      const retiredPath = artifacts.get("retired");
      if (!retiredPath || artifactRevisions.get("retired") !== expectedRevision) return false;
      try {
        await this.fs.rename(retiredPath, targetPath);
      } catch (error) {
        throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "The only retired live theme copy could not be restored.", {
          id,
          transactionId,
          retiredPath,
          expectedRevision,
        }, { cause: error });
      }
      artifacts.delete("retired");
      currentRevision = expectedRevision;
      return true;
    };

    const restoreBefore = async () => {
      if (!manifest.beforeExists) return false;
      if (await restoreRetired(beforeRevision)) return true;
      await this.restoreBackup(id, transactionId, manifest);
      currentRevision = beforeRevision;
      return true;
    };

    const failClosed = (message) => {
      throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", message, {
        id,
        transactionId,
        status: manifest.status,
        operation,
        currentRevision,
        beforeRevision,
        afterRevision,
        artifacts: Object.fromEntries(artifactRevisions),
      });
    };

    let recoveredStatus = manifest.status;
    let recoveryAction = "isolated-remnants";

    if (manifest.status === "prepared") {
      if (operation === "write" && currentRevision === afterRevision) {
        recoveredStatus = "committed";
        recoveryAction = "recognized-completed-write";
      } else if (currentRevision === beforeRevision && manifest.beforeExists) {
        recoveredStatus = "recovered";
        recoveryAction = "kept-prior-theme";
      } else if (currentRevision === null) {
        if (manifest.beforeExists) {
          await restoreBefore();
          recoveryAction = "restored-prior-theme";
        } else {
          recoveryAction = "kept-prior-absence";
        }
        recoveredStatus = "recovered";
      } else {
        failClosed("A prepared transaction no longer has a safely recoverable live state.");
      }
    } else if (manifest.status === "committed") {
      if (afterRevision === null && currentRevision === null) {
        recoveredStatus = "committed";
        recoveryAction = "kept-committed-deletion";
      } else if (currentRevision === afterRevision) {
        recoveredStatus = "committed";
        recoveryAction = "kept-committed-theme";
      } else if (currentRevision === beforeRevision && manifest.beforeExists) {
        if (artifactRevisions.get("retired") === afterRevision) {
          recoveredStatus = "rolledBack";
          recoveryAction = "recognized-completed-rollback";
        } else {
          recoveredStatus = "recovered";
          recoveryAction = "kept-prior-theme";
        }
      } else if (currentRevision === null && afterRevision !== null) {
        if (await restoreRetired(afterRevision)) {
          recoveredStatus = "committed";
          recoveryAction = "restored-interrupted-rollback";
        } else if (manifest.beforeExists) {
          await restoreBefore();
          recoveredStatus = "recovered";
          recoveryAction = "restored-prior-theme";
        } else {
          recoveredStatus = "recovered";
          recoveryAction = "kept-prior-absence";
        }
      } else {
        failClosed("A committed transaction no longer has a safely recoverable live state.");
      }
    } else if (manifest.status === "rollingBack") {
      if (manifest.beforeExists && currentRevision === beforeRevision) {
        recoveredStatus = "rolledBack";
        recoveryAction = "recognized-completed-rollback";
      } else if (!manifest.beforeExists && currentRevision === null && artifactRevisions.get("retired") === afterRevision) {
        recoveredStatus = "rolledBack";
        recoveryAction = "recognized-completed-create-rollback";
      } else if (currentRevision === afterRevision && afterRevision !== null) {
        recoveredStatus = "committed";
        recoveryAction = "aborted-interrupted-rollback";
      } else if (currentRevision === null && afterRevision === null) {
        recoveredStatus = "committed";
        recoveryAction = "kept-committed-deletion";
      } else if (currentRevision === null && afterRevision !== null && await restoreRetired(afterRevision)) {
        recoveredStatus = "committed";
        recoveryAction = "restored-interrupted-rollback";
      } else {
        failClosed("An interrupted rollback no longer has a safely recoverable live state.");
      }
    } else if (manifest.status === "rolledBack") {
      if (manifest.beforeExists && currentRevision === beforeRevision) {
        recoveredStatus = "rolledBack";
        recoveryAction = "kept-rolled-back-theme";
      } else if (manifest.beforeExists && currentRevision === null) {
        await restoreBefore();
        recoveredStatus = "rolledBack";
        recoveryAction = "restored-rolled-back-theme";
      } else if (!manifest.beforeExists && currentRevision === null) {
        recoveredStatus = "rolledBack";
        recoveryAction = "kept-rolled-back-absence";
      } else {
        failClosed("A rolled-back transaction conflicts with the live theme.");
      }
    } else if (manifest.status === "recovered") {
      if (currentRevision === null && manifest.beforeExists) {
        failClosed("A previously recovered transaction has lost its live theme.");
      }
      recoveryAction = "retried-artifact-isolation";
    }

    await this.recordRecovery(manifestPath, manifest, recoveredStatus, {
      action: recoveryAction,
      currentRevision,
      artifacts: Object.fromEntries([...artifacts].map(([kind, artifactPath]) => [kind, path.basename(artifactPath)])),
    });

    for (const artifactPath of artifacts.values()) {
      await this.isolateArtifact(artifactPath, transactionId);
    }
  }

  async recoverInterruptedTransactionsLocked() {
    const entries = await this.fs.readdir(this.themesRoot, { withFileTypes: true });
    const artifactPattern = /^\.([a-z0-9][a-z0-9_-]{0,63})\.(stage|rollback|retired)-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
    const groups = new Map();
    for (const entry of entries) {
      const resemblesArtifact = /^\..+\.(?:stage|rollback|retired)-/.test(entry.name);
      const match = entry.name.match(artifactPattern);
      if (!match) {
        if (resemblesArtifact) {
          throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "A malformed transaction artifact requires manual inspection.", {
            artifact: entry.name,
          });
        }
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) {
        throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "A transaction artifact is not a real directory.", {
          artifact: entry.name,
        });
      }
      const [, id, kind, transactionId] = match;
      const key = `${id}:${transactionId}`;
      const group = groups.get(key) || { id, transactionId, artifacts: new Map() };
      if (group.artifacts.has(kind)) {
        throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "A transaction has duplicate recovery artifacts.", {
          id,
          transactionId,
          kind,
        });
      }
      group.artifacts.set(kind, path.join(this.themesRoot, entry.name));
      groups.set(key, group);
    }

    const backupEntries = await this.fs.readdir(this.backupsRoot, { withFileTypes: true });
    for (const entry of backupEntries) {
      if (!entry.isDirectory() || !TRANSACTION_ID_PATTERN.test(entry.name)) continue;
      let manifest;
      try {
        manifest = JSON.parse(await this.fs.readFile(path.join(this.backupsRoot, entry.name, "manifest.json"), "utf8"));
      } catch {
        continue;
      }
      if (manifest.status !== "prepared" && manifest.status !== "rollingBack") continue;
      if (manifest.transactionId !== entry.name || typeof manifest.id !== "string" || !THEME_ID_PATTERN.test(manifest.id)) {
        throw new ToolError("REPOSITORY_RECOVERY_REQUIRED", "An unfinished transaction manifest is inconsistent.", {
          transactionId: entry.name,
        });
      }
      const key = `${manifest.id}:${entry.name}`;
      if (!groups.has(key)) {
        groups.set(key, { id: manifest.id, transactionId: entry.name, artifacts: new Map() });
      }
    }
    for (const group of groups.values()) await this.recoverArtifactGroup(group);
  }

  async revisionForLoaded(loaded) {
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify(loaded.theme));
    hash.update("\0");
    const image = digestBuffer(hash, path.basename(loaded.imagePath), loaded.image);
    const customCssPath = path.join(loaded.themeDir, "skin.css");
    const hasLegacySkinCss = loaded.cssPath === customCssPath;
    if (hasLegacySkinCss) digestBuffer(hash, path.basename(customCssPath), loaded.cssBuffer);
    return { revision: hash.digest("hex"), image, hasLegacySkinCss };
  }

  async read(id) {
    const themeDir = this.themePath(id);
    let loaded;
    try {
      loaded = await loadTheme(themeDir, { projectRoot: this.projectRoot, allowedRoot: this.themesRoot });
    } catch (error) {
      if (error.code === "ENOENT" || /missing theme\.json/.test(error.message)) {
        throw new ToolError("THEME_NOT_FOUND", `Theme '${id}' does not exist.`);
      }
      throw new ToolError("THEME_INVALID", error.message, { id });
    }
    if (loaded.theme.id !== id) {
      throw new ToolError("THEME_ID_MISMATCH", `Theme directory '${id}' contains theme id '${loaded.theme.id}'.`);
    }
    const metadata = await this.revisionForLoaded(loaded);
    return {
      id,
      revision: metadata.revision,
      raw: loaded.raw,
      theme: loaded.theme,
      asset: {
        file: loaded.theme.image,
        mime: loaded.mime,
        bytes: metadata.image.bytes,
        sha256: metadata.image.sha256,
      },
      compatibility: {
        hasLegacySkinCss: metadata.hasLegacySkinCss,
        agentWritableCss: false,
      },
    };
  }

  async list() {
    await this.ensureRoots();
    const entries = await this.fs.readdir(this.themesRoot, { withFileTypes: true });
    const ids = entries
      .filter((entry) => entry.isDirectory() && THEME_ID_PATTERN.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    const themes = [];
    for (const id of ids) {
      try {
        const item = await this.read(id);
        themes.push({
          id,
          name: item.theme.name,
          description: item.theme.description,
          layout: item.theme.layout,
          colorScheme: item.theme.appearance.colorScheme,
          visual: item.theme.visual,
          revision: item.revision,
          valid: true,
        });
      } catch (error) {
        themes.push({ id, valid: false, error: { code: error.code || "THEME_INVALID", message: error.message } });
      }
    }
    return { themesRoot: this.themesRoot, count: themes.length, themes };
  }

  async readAsset(id) {
    let loaded;
    try {
      loaded = await loadTheme(this.themePath(id), {
        projectRoot: this.projectRoot,
        allowedRoot: this.themesRoot,
      });
    } catch (error) {
      if (error.code === "ENOENT" || /missing theme\.json/.test(error.message)) {
        throw new ToolError("THEME_NOT_FOUND", `Theme '${id}' does not exist.`);
      }
      throw new ToolError("THEME_INVALID", error.message, { id });
    }
    if (loaded.theme.id !== id) {
      throw new ToolError("THEME_ID_MISMATCH", `Theme directory '${id}' contains theme id '${loaded.theme.id}'.`);
    }
    const metadata = await this.revisionForLoaded(loaded);
    return {
      buffer: loaded.image,
      mime: loaded.mime,
      bytes: metadata.image.bytes,
      revision: metadata.revision,
    };
  }

  async validate({ id, theme } = {}) {
    if (id) {
      const result = await this.read(id);
      return {
        valid: true,
        id,
        revision: result.revision,
        theme: result.theme,
        warnings: result.compatibility.hasLegacySkinCss
          ? ["Legacy skin.css is preserved for compatibility but cannot be edited through Agent Tool v1."]
          : [],
      };
    }
    validatePatchShape(theme);
    return { valid: true, theme: normalizeStrict(theme, "theme input"), warnings: [] };
  }

  async write(input = {}) {
    if (input.operation === "rollback") return this.rollback(input.transactionId);
    const id = input.id;
    assertThemeId(id);
    validatePatchShape(input.themePatch || {});
    if (input.themePatch?.id && input.themePatch.id !== id) {
      throw new ToolError("THEME_ID_MISMATCH", "themePatch.id must match the requested theme id.");
    }
    return this.withLock(() => this.writeLocked({ ...input, id }));
  }

  async delete(id, { expectedRevision } = {}) {
    assertThemeId(id);
    if (typeof expectedRevision !== "string" || !expectedRevision) {
      throw new ToolError("INVALID_ARGUMENT", "expectedRevision is required when deleting a theme.");
    }
    return this.withLock(async () => {
      const current = await this.read(id);
      if (current.revision !== expectedRevision) {
        throw new ToolError("REVISION_CONFLICT", "The theme changed after it was inspected.", {
          expectedRevision,
          actualRevision: current.revision,
        });
      }

      const transactionId = crypto.randomUUID();
      const transactionRoot = path.join(this.backupsRoot, transactionId);
      const backupThemePath = path.join(transactionRoot, "theme");
      const targetPath = this.themePath(id);
      const retiredPath = path.join(this.themesRoot, `.${id}.retired-${transactionId}`);
      await this.fs.mkdir(transactionRoot, { recursive: true });
      await this.fs.cp(targetPath, backupThemePath, { recursive: true, errorOnExist: true });
      const manifestPath = path.join(transactionRoot, "manifest.json");
      let manifest = {
        schemaVersion: 1,
        transactionId,
        id,
        operation: "delete",
        createdAt: new Date().toISOString(),
        beforeExists: true,
        beforeRevision: current.revision,
        afterRevision: null,
        status: "prepared",
      };
      await this.writeManifest(manifestPath, manifest);

      try {
        await this.fs.rename(targetPath, retiredPath);
      } catch (error) {
        throw new ToolError("THEME_DELETE_FAILED", error.message, { id, transactionId });
      }

      manifest = { ...manifest, status: "committed", committedAt: new Date().toISOString() };
      try {
        await this.writeManifest(manifestPath, manifest);
      } catch (commitError) {
        try {
          await this.fs.rename(retiredPath, targetPath);
        } catch (restoreError) {
          throw new ToolError(
            "THEME_DELETE_RECOVERY_REQUIRED",
            "The delete could not be recorded and the retired theme could not be restored. Its recovery copy was preserved.",
            {
              id,
              transactionId,
              retiredPath,
              commitError: commitError.message,
              restoreError: restoreError.message,
            },
            { cause: restoreError },
          );
        }
        throw new ToolError("THEME_DELETE_FAILED", commitError.message, { id, transactionId }, { cause: commitError });
      }

      await this.cleanupArtifact(retiredPath, transactionId);
      return { deleted: true, id, transactionId, beforeRevision: current.revision };
    });
  }

  async writeLocked({ id, themePatch = {}, imagePath, expectedRevision, dryRun = false }) {
    const transactionId = crypto.randomUUID();
    const targetPath = this.themePath(id);
    const targetExists = await pathExists(this.fs, targetPath);
    let before = null;
    if (targetExists) before = await this.read(id);
    if (expectedRevision !== undefined && expectedRevision !== (before?.revision ?? null)) {
      throw new ToolError("REVISION_CONFLICT", "The theme changed after it was inspected.", {
        expectedRevision,
        actualRevision: before?.revision ?? null,
      });
    }

    const stagePath = path.join(this.themesRoot, `.${id}.stage-${transactionId}`);
    const retiredPath = path.join(this.themesRoot, `.${id}.retired-${transactionId}`);
    let preserveArtifacts = false;
    if (targetExists) await this.fs.cp(targetPath, stagePath, { recursive: true, errorOnExist: true });
    else await this.fs.mkdir(stagePath);

    try {
      const base = before?.theme || {
        schemaVersion: 1,
        id,
        image: imagePath ? path.basename(imagePath) : "background.png",
      };
      const candidate = mergePatch(base, themePatch);
      candidate.schemaVersion = 1;
      candidate.id = id;
      if (imagePath && !themePatch.image) candidate.image = path.basename(imagePath);
      const normalized = normalizeStrict(candidate, "themePatch");
      if (normalized.id !== id) {
        throw new ToolError("THEME_ID_MISMATCH", "Normalized theme id does not match the target directory.");
      }
      if (imagePath) {
        const sourceImage = path.resolve(imagePath);
        const stat = await this.fs.stat(sourceImage);
        if (!stat.isFile()) throw new ToolError("INVALID_IMAGE", "imagePath must point to a file.");
        await this.fs.copyFile(sourceImage, path.join(stagePath, normalized.image));
      }
      await this.fs.writeFile(
        path.join(stagePath, "theme.json"),
        `${JSON.stringify(normalized, null, 2)}\n`,
        { mode: 0o600 },
      );
      const staged = await loadTheme(stagePath, { projectRoot: this.projectRoot, allowedRoot: this.themesRoot });
      const afterMetadata = await this.revisionForLoaded(staged);
      const result = {
        transactionId,
        dryRun: Boolean(dryRun),
        id,
        beforeRevision: before?.revision ?? null,
        afterRevision: afterMetadata.revision,
        theme: staged.theme,
        warnings: afterMetadata.hasLegacySkinCss
          ? ["Legacy skin.css was preserved but was not modified."]
          : [],
      };
      if (dryRun) return result;

      const transactionRoot = path.join(this.backupsRoot, transactionId);
      const backupThemePath = path.join(transactionRoot, "theme");
      await this.fs.mkdir(transactionRoot, { recursive: true });
      if (targetExists) await this.fs.cp(targetPath, backupThemePath, { recursive: true, errorOnExist: true });
      const manifestPath = path.join(transactionRoot, "manifest.json");
      let manifest = {
        schemaVersion: 1,
        transactionId,
        id,
        operation: "write",
        createdAt: new Date().toISOString(),
        beforeExists: targetExists,
        beforeRevision: before?.revision ?? null,
        afterRevision: afterMetadata.revision,
        status: "prepared",
      };
      await this.writeManifest(manifestPath, manifest);

      if (targetExists) await this.fs.rename(targetPath, retiredPath);
      try {
        await this.fs.rename(stagePath, targetPath);
      } catch (installError) {
        if (targetExists) {
          try {
            await this.fs.rename(retiredPath, targetPath);
          } catch (restoreError) {
            preserveArtifacts = true;
            throw new ToolError(
              "THEME_WRITE_RECOVERY_REQUIRED",
              "The staged theme could not be installed and the retired live theme could not be restored. Both copies were preserved.",
              {
                id,
                transactionId,
                stagePath,
                retiredPath,
                installError: installError.message,
                restoreError: restoreError.message,
              },
              { cause: restoreError },
            );
          }
        }
        throw installError;
      }

      manifest = { ...manifest, status: "committed", committedAt: new Date().toISOString() };
      await this.writeManifest(manifestPath, manifest);
      await this.cleanupArtifact(retiredPath, transactionId);
      return result;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("THEME_WRITE_FAILED", error.message, { id, transactionId });
    } finally {
      if (!preserveArtifacts) await this.cleanupArtifact(stagePath, transactionId);
    }
  }

  async rollback(transactionId) {
    if (typeof transactionId !== "string" || !TRANSACTION_ID_PATTERN.test(transactionId)) {
      throw new ToolError("INVALID_TRANSACTION", "A valid transactionId is required for rollback.");
    }
    return this.withLock(() => this.rollbackLocked(transactionId));
  }

  async rollbackLocked(transactionId) {
    const transactionRoot = path.join(this.backupsRoot, transactionId);
    const manifestPath = path.join(transactionRoot, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await this.fs.readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new ToolError("TRANSACTION_NOT_FOUND", `Transaction '${transactionId}' does not exist.`);
      }
      throw new ToolError("INVALID_TRANSACTION", `Could not read transaction '${transactionId}'.`);
    }
    if (manifest.status === "rolledBack") {
      return { transactionId, id: manifest.id, rolledBack: true, alreadyRolledBack: true };
    }
    assertThemeId(manifest.id);
    if (manifest.transactionId !== transactionId
      || manifest.schemaVersion !== 1
      || !MANIFEST_STATUSES.has(manifest.status)) {
      throw new ToolError("INVALID_TRANSACTION", `Transaction '${transactionId}' has an invalid manifest.`);
    }
    if (manifest.status !== "committed") {
      throw new ToolError("TRANSACTION_NOT_COMMITTED", "Only a committed transaction can be rolled back.", {
        transactionId,
        status: manifest.status,
      });
    }

    const targetPath = this.themePath(manifest.id);
    const stagePath = path.join(this.themesRoot, `.${manifest.id}.rollback-${transactionId}`);
    const retiredPath = path.join(this.themesRoot, `.${manifest.id}.retired-${transactionId}`);
    const actualRevision = await this.currentRevision(manifest.id);
    if (actualRevision !== manifest.afterRevision) {
      throw new ToolError("ROLLBACK_CONFLICT", "The live theme no longer matches the transaction result.", {
        transactionId,
        id: manifest.id,
        expectedRevision: manifest.afterRevision,
        actualRevision,
      });
    }

    let preserveArtifacts = false;
    try {
      if (manifest.beforeExists) {
        await this.fs.cp(path.join(transactionRoot, "theme"), stagePath, { recursive: true, errorOnExist: true });
        const restored = await loadTheme(stagePath, { projectRoot: this.projectRoot, allowedRoot: this.themesRoot });
        const restoredMetadata = await this.revisionForLoaded(restored);
        if (restoredMetadata.revision !== manifest.beforeRevision) {
          throw new ToolError("BACKUP_CORRUPT", "The stored theme backup no longer matches its revision.");
        }
      }

      const committedManifest = manifest;
      manifest = { ...manifest, status: "rollingBack", rollbackStartedAt: new Date().toISOString() };
      await this.writeManifest(manifestPath, manifest);

      if (actualRevision !== null) {
        try {
          await this.fs.rename(targetPath, retiredPath);
        } catch (error) {
          try {
            await this.writeManifest(manifestPath, committedManifest);
          } catch {}
          throw error;
        }
      }

      if (manifest.beforeExists) {
        try {
          await this.fs.rename(stagePath, targetPath);
        } catch (installError) {
          if (actualRevision !== null) {
            try {
              await this.fs.rename(retiredPath, targetPath);
            } catch (restoreError) {
              preserveArtifacts = true;
              throw new ToolError(
                "ROLLBACK_RECOVERY_REQUIRED",
                "The rollback copy could not be installed and the retired live theme could not be restored. Both copies were preserved.",
                {
                  transactionId,
                  id: manifest.id,
                  stagePath,
                  retiredPath,
                  installError: installError.message,
                  restoreError: restoreError.message,
                },
                { cause: restoreError },
              );
            }
          }
          try {
            await this.writeManifest(manifestPath, committedManifest);
          } catch {}
          throw installError;
        }
      }

      manifest = { ...manifest, status: "rolledBack", rolledBackAt: new Date().toISOString() };
      try {
        await this.writeManifest(manifestPath, manifest);
      } catch (error) {
        preserveArtifacts = true;
        throw new ToolError(
          "ROLLBACK_RECOVERY_REQUIRED",
          "The rollback was applied but its transaction record could not be finalized. Recovery artifacts were preserved.",
          { transactionId, id: manifest.id, retiredPath },
          { cause: error },
        );
      }

      await this.cleanupArtifact(retiredPath, transactionId);
      return {
        transactionId,
        id: manifest.id,
        rolledBack: true,
        alreadyRolledBack: false,
        restoredRevision: manifest.beforeRevision,
      };
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("ROLLBACK_FAILED", error.message, { transactionId });
    } finally {
      if (!preserveArtifacts) await this.cleanupArtifact(stagePath, transactionId);
    }
  }
}
