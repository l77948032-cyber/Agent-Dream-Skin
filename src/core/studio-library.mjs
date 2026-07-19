import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./errors.mjs";

const DEFAULT_MANIFEST = Object.freeze({
  schemaVersion: 1,
  settings: {
    autoVerify: true,
    motionEnabled: true,
    selectedAgentId: null,
  },
  entries: [],
});

const UI_ONLY_THEME_FIELDS = new Set(["imageUrl", "builtIn", "experimental"]);

function clone(value) {
  return structuredClone(value);
}

function themeIdSuffix() {
  return crypto.randomBytes(4).toString("hex");
}

function duplicateThemeId(sourceId) {
  const suffix = `-copy-${themeIdSuffix()}`;
  const prefix = sourceId.slice(0, 64 - suffix.length).replace(/[-_]+$/, "") || "theme";
  return `${prefix}${suffix}`;
}

function normalizedRevisionNumber(entry) {
  return Number.isInteger(entry.revisionNumber) && entry.revisionNumber > 0
    ? entry.revisionNumber
    : 0;
}

function storedStatus(entry) {
  return entry.status === "draft" ? "draft" : "verified";
}

function studioTheme(theme, imageUrl, { builtIn, experimental = false } = {}) {
  const { schemaVersion: _schemaVersion, image: _image, ...fields } = theme;
  return {
    ...fields,
    imageUrl: theme.appearance?.backgroundOpacity === 0 ? "" : imageUrl,
    builtIn: Boolean(builtIn),
    experimental: Boolean(experimental),
  };
}

function themePatchFromStudio(input, id) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ToolError("INVALID_THEME_PATCH", "theme must be an object.");
  }
  if (input.id !== undefined && input.id !== id) {
    throw new ToolError("THEME_ID_MISMATCH", "Theme id cannot be changed in Studio.");
  }
  const patch = {};
  for (const [key, value] of Object.entries(input)) {
    if (UI_ONLY_THEME_FIELDS.has(key) || key === "schemaVersion" || key === "image") continue;
    patch[key] = clone(value);
  }
  patch.id = id;
  return patch;
}

function validateManifest(input, defaultPluginId) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.entries)) return clone(DEFAULT_MANIFEST);
  return {
    schemaVersion: 1,
    settings: {
      ...DEFAULT_MANIFEST.settings,
      ...(input.settings && typeof input.settings === "object" ? input.settings : {}),
    },
    entries: input.entries
      .filter((entry) => (
        entry
        && typeof entry.id === "string"
        && /^(?:[a-z0-9][a-z0-9_-]{0,63})$/.test(entry.id)
        && (entry.origin === "template" || entry.origin === "blank")
      ))
      .map((entry) => ({
        ...entry,
        pluginId: typeof entry.pluginId === "string" && entry.pluginId ? entry.pluginId : defaultPluginId,
      })),
  };
}

export class StudioLibrary {
  constructor({
    catalogRepository,
    userRepository,
    tool,
    pluginId,
    catalog,
    manifestPath,
    apiPrefix = "/api/v1",
    now = () => new Date(),
  }) {
    this.catalogRepository = catalogRepository;
    this.userRepository = userRepository;
    if (!tool || typeof tool.createTheme !== "function" || typeof tool.updateTheme !== "function") {
      throw new ToolError("INVALID_STUDIO_DEPENDENCY", "Studio Library requires DreamSkin Tool write access.");
    }
    if (!catalog || typeof catalog !== "object" || !catalog.templates || typeof catalog.hasTemplate !== "function") {
      throw new ToolError("INVALID_STUDIO_DEPENDENCY", "Studio Library requires a plugin catalog.");
    }
    if (typeof pluginId !== "string" || !pluginId) {
      throw new ToolError("INVALID_STUDIO_DEPENDENCY", "Studio Library requires a plugin id.");
    }
    this.tool = tool;
    this.pluginId = pluginId;
    this.catalogDefinition = catalog;
    this.manifestPath = path.resolve(manifestPath);
    this.apiPrefix = apiPrefix.replace(/\/$/, "");
    this.now = now;
    this.manifestQueue = Promise.resolve();
  }

  async ensureManifest() {
    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    try {
      return validateManifest(JSON.parse(await fs.readFile(this.manifestPath, "utf8")), this.pluginId);
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      const manifest = clone(DEFAULT_MANIFEST);
      await this.writeManifest(manifest);
      return manifest;
    }
  }

  async writeManifest(manifest) {
    const temporary = `${this.manifestPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(this.manifestPath), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, this.manifestPath);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  mutateManifest(action) {
    const operation = this.manifestQueue.then(async () => {
      const manifest = await this.ensureManifest();
      const result = await action(manifest);
      await this.writeManifest(manifest);
      return result;
    });
    this.manifestQueue = operation.catch(() => {});
    return operation;
  }

  catalogAssetUrl(id, revision) {
    return `${this.apiPrefix}/catalog/${encodeURIComponent(id)}/asset?revision=${encodeURIComponent(revision)}`;
  }

  themeAssetUrl(id, revision) {
    return `${this.apiPrefix}/themes/${encodeURIComponent(id)}/asset?revision=${encodeURIComponent(revision)}`;
  }

  async catalog() {
    const result = [];
    for (const [id, metadata] of Object.entries(this.catalogDefinition.templates)) {
      const loaded = await this.catalogRepository.read(id);
      result.push({
        pluginId: this.pluginId,
        targetId: this.catalogDefinition.targetId,
        theme: studioTheme(
          loaded.theme,
          this.catalogAssetUrl(id, loaded.revision),
          { builtIn: true, experimental: metadata.experimental },
        ),
        author: metadata.author,
        categories: metadata.categories,
        target: this.catalogDefinition.targetName,
        featured: Boolean(metadata.featured),
        downloads: metadata.downloads,
        version: metadata.version,
      });
    }
    return result;
  }

  async localTheme(entry, activeThemeId = null) {
    const loaded = await this.userRepository.read(entry.id);
    const applied = activeThemeId === entry.id
      && typeof entry.appliedRevisionHash === "string"
      && entry.appliedRevisionHash === loaded.revision;
    return {
      pluginId: this.pluginId,
      targetId: this.catalogDefinition.targetId,
      localId: entry.id,
      ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
      theme: studioTheme(loaded.theme, this.themeAssetUrl(entry.id, loaded.revision), { builtIn: false }),
      origin: entry.origin,
      updatedAt: entry.updatedAt,
      revision: entry.revisionNumber,
      revisionHash: loaded.revision,
      status: applied ? "applied" : storedStatus(entry),
      ...(entry.lastTransactionId ? { lastTransactionId: entry.lastTransactionId } : {}),
    };
  }

  async synchronizeManifest() {
    const operation = this.manifestQueue.then(async () => {
      const [manifest, repository] = await Promise.all([
        this.ensureManifest(),
        this.userRepository.list(),
      ]);
      const available = repository.themes.filter((theme) => theme.valid && theme.revision);
      const availableById = new Map(available.map((theme) => [theme.id, theme]));
      const timestamp = this.now().toISOString();
      const ownEntries = manifest.entries.filter((entry) => entry.pluginId === this.pluginId);
      const foreignEntries = manifest.entries.filter((entry) => entry.pluginId !== this.pluginId);
      const retained = ownEntries.filter((entry) => availableById.has(entry.id));
      let changed = retained.length !== ownEntries.length;
      manifest.entries = [...foreignEntries, ...retained];
      const known = new Map(retained.map((entry) => [entry.id, entry]));

      for (const theme of available) {
        const entry = known.get(theme.id);
        if (!entry) {
          const sourceId = this.catalogDefinition.inferTemplateSource(theme.id);
          const discovered = {
            pluginId: this.pluginId,
            id: theme.id,
            ...(sourceId ? { sourceId } : {}),
            origin: sourceId ? "template" : "blank",
            createdAt: timestamp,
            updatedAt: timestamp,
            revisionNumber: 1,
            revisionHash: theme.revision,
            status: "verified",
          };
          manifest.entries.push(discovered);
          known.set(theme.id, discovered);
          changed = true;
          continue;
        }

        if (entry.revisionHash !== theme.revision) {
          entry.revisionHash = theme.revision;
          entry.revisionNumber = normalizedRevisionNumber(entry) + 1;
          entry.updatedAt = timestamp;
          entry.status = "verified";
          delete entry.lastTransactionId;
          changed = true;
        }
      }

      if (changed) await this.writeManifest(manifest);
      return clone(manifest);
    });
    this.manifestQueue = operation.catch(() => {});
    return operation;
  }

  async list({ activeThemeId = null } = {}) {
    const manifest = await this.synchronizeManifest();
    const entries = [];
    const missing = [];
    for (const entry of manifest.entries.filter((candidate) => candidate.pluginId === this.pluginId)) {
      try {
        entries.push(await this.localTheme(entry, activeThemeId));
      } catch (error) {
        if (error.code !== "THEME_NOT_FOUND") throw error;
        missing.push(entry.id);
      }
    }
    if (missing.length) {
      const missingIds = new Set(missing);
      await this.mutateManifest((latest) => {
        latest.entries = latest.entries.filter((entry) => (
          entry.pluginId !== this.pluginId || !missingIds.has(entry.id)
        ));
      });
    }
    return entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async read(id, { activeThemeId = null } = {}) {
    const manifest = await this.synchronizeManifest();
    const entry = manifest.entries.find((candidate) => candidate.pluginId === this.pluginId && candidate.id === id);
    if (!entry) throw new ToolError("THEME_NOT_FOUND", `Studio theme '${id}' does not exist.`);
    return this.localTheme(entry, activeThemeId);
  }

  async addTemplate(sourceId, { activeThemeId = null } = {}) {
    if (!this.catalogDefinition.hasTemplate(sourceId)) {
      throw new ToolError("TEMPLATE_NOT_FOUND", `Template '${sourceId}' does not exist.`);
    }
    await this.synchronizeManifest();
    return this.mutateManifest(async (manifest) => {
      const existing = manifest.entries.find((entry) => (
        entry.pluginId === this.pluginId && entry.sourceId === sourceId
      ));
      if (existing) return this.localTheme(existing, activeThemeId);

      const source = await this.catalogRepository.read(sourceId);
      const id = `${sourceId}-${themeIdSuffix()}`;
      const result = await this.tool.createTheme({
        themeId: id,
        sourceId,
        themePatch: { ...clone(source.theme), id },
      }, this.pluginId);
      const timestamp = this.now().toISOString();
      const entry = {
        pluginId: this.pluginId,
        id,
        sourceId,
        origin: "template",
        createdAt: timestamp,
        updatedAt: timestamp,
        revisionNumber: 1,
        revisionHash: result.afterRevision,
        status: "verified",
        lastTransactionId: result.transactionId,
      };
      manifest.entries.unshift(entry);
      return this.localTheme(entry, activeThemeId);
    });
  }

  async createBlank({ activeThemeId = null } = {}) {
    const sourceId = this.catalogDefinition.blank.sourceId;
    const source = await this.catalogRepository.read(sourceId);
    const id = `${this.catalogDefinition.blank.idPrefix}-${themeIdSuffix()}`;
    const result = await this.tool.createTheme({
      themeId: id,
      sourceId,
      themePatch: this.catalogDefinition.createBlankTheme({ sourceTheme: source.theme, id }),
    }, this.pluginId);
    const timestamp = this.now().toISOString();
    const entry = {
      pluginId: this.pluginId,
      id,
      origin: "blank",
      createdAt: timestamp,
      updatedAt: timestamp,
      revisionNumber: 1,
      revisionHash: result.afterRevision,
      status: "draft",
      lastTransactionId: result.transactionId,
    };
    await this.mutateManifest((manifest) => {
      const discovered = manifest.entries.find((candidate) => (
        candidate.pluginId === this.pluginId && candidate.id === id
      ));
      if (discovered) Object.assign(discovered, entry);
      else manifest.entries.unshift(entry);
    });
    return this.localTheme(entry, activeThemeId);
  }

  async duplicate(id, { activeThemeId = null } = {}) {
    await this.synchronizeManifest();
    return this.mutateManifest(async (manifest) => {
      const sourceEntry = manifest.entries.find((candidate) => (
        candidate.pluginId === this.pluginId && candidate.id === id
      ));
      if (!sourceEntry) throw new ToolError("THEME_NOT_FOUND", `Studio theme '${id}' does not exist.`);
      const source = await this.userRepository.read(id);
      const duplicateId = duplicateThemeId(id);
      const sourceId = sourceEntry.sourceId && this.catalogDefinition.hasTemplate(sourceEntry.sourceId)
        ? sourceEntry.sourceId
        : this.catalogDefinition.blank.sourceId;
      const result = await this.tool.createTheme({
        themeId: duplicateId,
        sourceId,
        themePatch: {
          ...clone(source.theme),
          id: duplicateId,
          name: `${source.theme.name} 副本`,
        },
      }, this.pluginId);
      const timestamp = this.now().toISOString();
      const entry = {
        pluginId: this.pluginId,
        id: duplicateId,
        origin: sourceEntry.origin,
        createdAt: timestamp,
        updatedAt: timestamp,
        revisionNumber: 1,
        revisionHash: result.afterRevision,
        status: "verified",
        lastTransactionId: result.transactionId,
      };
      manifest.entries.unshift(entry);
      return this.localTheme(entry, activeThemeId);
    });
  }

  async delete(id, { expectedRevision } = {}) {
    await this.synchronizeManifest();
    return this.mutateManifest(async (manifest) => {
      const entryIndex = manifest.entries.findIndex((candidate) => (
        candidate.pluginId === this.pluginId && candidate.id === id
      ));
      if (entryIndex === -1) throw new ToolError("THEME_NOT_FOUND", `Studio theme '${id}' does not exist.`);
      const result = await this.userRepository.delete(id, { expectedRevision });
      manifest.entries.splice(entryIndex, 1);
      return { deleted: true, themeId: id, transactionId: result.transactionId };
    });
  }

  async update(id, { theme, expectedRevision }, { activeThemeId = null } = {}) {
    await this.synchronizeManifest();
    await this.mutateManifest(async (latest) => {
      const entry = latest.entries.find((candidate) => candidate.pluginId === this.pluginId && candidate.id === id);
      if (!entry) throw new ToolError("THEME_NOT_FOUND", `Studio theme '${id}' does not exist.`);
      const result = await this.tool.updateTheme({
        themeId: id,
        expectedRevision,
        themePatch: themePatchFromStudio(theme, id),
      }, this.pluginId);
      entry.updatedAt = this.now().toISOString();
      entry.revisionNumber = (entry.revisionNumber || 0) + 1;
      entry.revisionHash = result.afterRevision;
      entry.status = "verified";
      entry.lastTransactionId = result.transactionId;
    });
    return this.read(id, { activeThemeId });
  }

  async reconcile(id, { activeThemeId = null } = {}) {
    await this.synchronizeManifest();
    const loaded = await this.userRepository.read(id);
    await this.mutateManifest((manifest) => {
      const entry = manifest.entries.find((candidate) => candidate.pluginId === this.pluginId && candidate.id === id);
      if (!entry) throw new ToolError("THEME_NOT_FOUND", `Studio theme '${id}' does not exist.`);
      if (entry.revisionHash !== loaded.revision) {
        entry.revisionHash = loaded.revision;
        entry.revisionNumber = (entry.revisionNumber || 0) + 1;
        entry.updatedAt = this.now().toISOString();
        entry.status = "verified";
      }
    });
    return this.read(id, { activeThemeId });
  }

  async markApplied(id, revisionHash) {
    if (typeof revisionHash !== "string" || !revisionHash) {
      throw new ToolError("INVALID_ARGUMENT", "revisionHash is required when recording an applied theme.");
    }
    await this.synchronizeManifest();
    const loaded = await this.userRepository.read(id);
    if (loaded.revision !== revisionHash) {
      throw new ToolError("REVISION_CONFLICT", "The theme changed before its applied revision could be recorded.", {
        expectedRevision: revisionHash,
        actualRevision: loaded.revision,
      });
    }
    await this.mutateManifest((manifest) => {
      const entry = manifest.entries.find((candidate) => candidate.pluginId === this.pluginId && candidate.id === id);
      if (!entry) throw new ToolError("THEME_NOT_FOUND", `Studio theme '${id}' does not exist.`);
      entry.appliedRevisionHash = revisionHash;
      entry.status = "verified";
    });
    const applied = await this.read(id, { activeThemeId: id });
    if (applied.status !== "applied") {
      throw new ToolError("REVISION_CONFLICT", "The theme changed while its applied revision was being recorded.", {
        expectedRevision: revisionHash,
        actualRevision: applied.revisionHash,
      });
    }
    return applied;
  }

  async settings() {
    return (await this.ensureManifest()).settings;
  }

  async updateSettings(patch) {
    const allowed = new Set(["autoVerify", "motionEnabled", "selectedAgentId"]);
    return this.mutateManifest((manifest) => {
      for (const [key, value] of Object.entries(patch || {})) {
        if (allowed.has(key)) manifest.settings[key] = value;
      }
      return clone(manifest.settings);
    });
  }

  async asset(kind, id) {
    const repository = kind === "catalog" ? this.catalogRepository : this.userRepository;
    if (kind === "catalog" && !this.catalogDefinition.hasTemplate(id)) {
      throw new ToolError("TEMPLATE_NOT_FOUND", `Template '${id}' does not exist.`);
    }
    return repository.readAsset(id);
  }
}
