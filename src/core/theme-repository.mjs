import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { BACKUPS_ROOT, PROJECT_ROOT, THEMES_ROOT, TOOL_DATA_ROOT } from "./paths.mjs";
import { ToolError } from "./errors.mjs";
import { loadTheme } from "./theme-loader.mjs";
import { COLOR_DEFAULTS, STATE_DEFAULTS, THEME_ID_PATTERN, normalizeTheme } from "./theme-model.mjs";

const TOP_LEVEL_FIELDS = new Set([
  "schemaVersion", "id", "name", "description", "layout", "brandSubtitle", "tagline",
  "statusText", "quote", "image", "colors", "states", "appearance",
]);
const APPEARANCE_FIELDS = new Set([
  "treatment", "backgroundPosition", "backgroundSize", "backgroundOverlay",
  "backgroundBlendMode", "backgroundOpacity", "surfaceOpacity", "sidebarOpacity",
  "blur", "saturation", "radius", "shadow", "colorScheme",
]);
const COLOR_FIELDS = new Set(Object.keys(COLOR_DEFAULTS));
const STATE_FIELDS = new Set(Object.keys(STATE_DEFAULTS));

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

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function digestFile(hash, filePath) {
  const buffer = await fs.readFile(filePath);
  hash.update(path.basename(filePath));
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
  } = {}) {
    this.themesRoot = path.resolve(themesRoot);
    this.dataRoot = path.resolve(dataRoot);
    this.backupsRoot = path.resolve(backupsRoot);
    this.projectRoot = path.resolve(projectRoot);
    this.lockPath = path.join(this.dataRoot, "repository.lock");
  }

  themePath(id) {
    assertThemeId(id);
    return path.join(this.themesRoot, id);
  }

  async ensureRoots() {
    await Promise.all([
      fs.mkdir(this.themesRoot, { recursive: true }),
      fs.mkdir(this.backupsRoot, { recursive: true }),
    ]);
  }

  async withLock(action) {
    await this.ensureRoots();
    const deadline = Date.now() + 5000;
    while (true) {
      try {
        await fs.mkdir(this.lockPath);
        await fs.writeFile(path.join(this.lockPath, "owner.json"), JSON.stringify({
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
      return await action();
    } finally {
      await fs.rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async recoverStaleLock() {
    let stale = false;
    try {
      const owner = JSON.parse(await fs.readFile(path.join(this.lockPath, "owner.json"), "utf8"));
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
        const stat = await fs.stat(this.lockPath);
        stale = Date.now() - stat.mtimeMs > 2000;
      } catch (statError) {
        if (statError.code === "ENOENT") return true;
        throw statError;
      }
    }
    if (!stale) return false;
    await fs.rm(this.lockPath, { recursive: true, force: true });
    return true;
  }

  async revisionForLoaded(loaded) {
    const hash = crypto.createHash("sha256");
    hash.update(JSON.stringify(loaded.theme));
    hash.update("\0");
    const image = await digestFile(hash, loaded.imagePath);
    const customCssPath = path.join(loaded.themeDir, "skin.css");
    const hasLegacySkinCss = await pathExists(customCssPath);
    if (hasLegacySkinCss) await digestFile(hash, customCssPath);
    return { revision: hash.digest("hex"), image, hasLegacySkinCss };
  }

  async read(id) {
    const themeDir = this.themePath(id);
    let loaded;
    try {
      loaded = await loadTheme(themeDir, { projectRoot: this.projectRoot });
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
    const entries = await fs.readdir(this.themesRoot, { withFileTypes: true });
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
          revision: item.revision,
          valid: true,
        });
      } catch (error) {
        themes.push({ id, valid: false, error: { code: error.code || "THEME_INVALID", message: error.message } });
      }
    }
    return { themesRoot: this.themesRoot, count: themes.length, themes };
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

  async writeLocked({ id, themePatch = {}, imagePath, expectedRevision, dryRun = false }) {
    const transactionId = crypto.randomUUID();
    const targetPath = this.themePath(id);
    const targetExists = await pathExists(targetPath);
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
    await fs.rm(stagePath, { recursive: true, force: true });
    if (targetExists) await fs.cp(targetPath, stagePath, { recursive: true, errorOnExist: true });
    else await fs.mkdir(stagePath, { recursive: true });

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
        const stat = await fs.stat(sourceImage);
        if (!stat.isFile()) throw new ToolError("INVALID_IMAGE", "imagePath must point to a file.");
        await fs.copyFile(sourceImage, path.join(stagePath, normalized.image));
      }
      await fs.writeFile(
        path.join(stagePath, "theme.json"),
        `${JSON.stringify(normalized, null, 2)}\n`,
        { mode: 0o600 },
      );
      const staged = await loadTheme(stagePath, { projectRoot: this.projectRoot });
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
      await fs.mkdir(transactionRoot, { recursive: true });
      if (targetExists) await fs.cp(targetPath, backupThemePath, { recursive: true, errorOnExist: true });
      const manifest = {
        schemaVersion: 1,
        transactionId,
        id,
        createdAt: new Date().toISOString(),
        beforeExists: targetExists,
        beforeRevision: before?.revision ?? null,
        afterRevision: afterMetadata.revision,
        status: "committed",
      };
      await fs.writeFile(path.join(transactionRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      if (targetExists) await fs.rename(targetPath, retiredPath);
      try {
        await fs.rename(stagePath, targetPath);
      } catch (error) {
        if (targetExists) await fs.rename(retiredPath, targetPath);
        throw error;
      }
      await fs.rm(retiredPath, { recursive: true, force: true });
      return result;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError("THEME_WRITE_FAILED", error.message, { id, transactionId });
    } finally {
      await fs.rm(stagePath, { recursive: true, force: true });
      await fs.rm(retiredPath, { recursive: true, force: true });
    }
  }

  async rollback(transactionId) {
    if (typeof transactionId !== "string" || !/^[0-9a-f-]{36}$/i.test(transactionId)) {
      throw new ToolError("INVALID_TRANSACTION", "A valid transactionId is required for rollback.");
    }
    return this.withLock(() => this.rollbackLocked(transactionId));
  }

  async rollbackLocked(transactionId) {
    const transactionRoot = path.join(this.backupsRoot, transactionId);
    const manifestPath = path.join(transactionRoot, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
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
    const targetPath = this.themePath(manifest.id);
    const stagePath = path.join(this.themesRoot, `.${manifest.id}.rollback-${transactionId}`);
    const retiredPath = path.join(this.themesRoot, `.${manifest.id}.retired-${transactionId}`);
    await fs.rm(stagePath, { recursive: true, force: true });
    await fs.rm(retiredPath, { recursive: true, force: true });
    try {
      if (manifest.beforeExists) {
        await fs.cp(path.join(transactionRoot, "theme"), stagePath, { recursive: true, errorOnExist: true });
        const restored = await loadTheme(stagePath, { projectRoot: this.projectRoot });
        const restoredMetadata = await this.revisionForLoaded(restored);
        if (restoredMetadata.revision !== manifest.beforeRevision) {
          throw new ToolError("BACKUP_CORRUPT", "The stored theme backup no longer matches its revision.");
        }
      }
      if (await pathExists(targetPath)) await fs.rename(targetPath, retiredPath);
      if (manifest.beforeExists) await fs.rename(stagePath, targetPath);
      await fs.rm(retiredPath, { recursive: true, force: true });
      manifest.status = "rolledBack";
      manifest.rolledBackAt = new Date().toISOString();
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return {
        transactionId,
        id: manifest.id,
        rolledBack: true,
        alreadyRolledBack: false,
        restoredRevision: manifest.beforeRevision,
      };
    } catch (error) {
      if (await pathExists(retiredPath) && !(await pathExists(targetPath))) {
        await fs.rename(retiredPath, targetPath);
      }
      if (error instanceof ToolError) throw error;
      throw new ToolError("ROLLBACK_FAILED", error.message, { transactionId });
    } finally {
      await fs.rm(stagePath, { recursive: true, force: true });
      await fs.rm(retiredPath, { recursive: true, force: true });
    }
  }
}
