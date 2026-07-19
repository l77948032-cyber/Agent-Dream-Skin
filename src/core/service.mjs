import fs from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./errors.mjs";
import { PlatformRuntime } from "./platform.mjs";
import { REGISTRY_PATH, RUNTIME_MAPPING_PATH, SCHEMA_PATH, TOOL_DATA_ROOT } from "./paths.mjs";
import { ThemeRepository } from "./theme-repository.mjs";

export const AGENT_TOOL_VERSION = "0.2.0";

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function publicRegistry(registry) {
  return {
    ...registry,
    components: registry.components.map(({ selectors, ...component }) => ({
      ...component,
      runtimeMappingCount: selectors.length,
    })),
  };
}

function publicRepository(repository) {
  return {
    count: repository.count,
    themes: repository.themes,
  };
}

export class TraeDreamSkinService {
  constructor({
    repository = new ThemeRepository(),
    runtime = new PlatformRuntime(),
    registryPath = REGISTRY_PATH,
    runtimeMappingPath = RUNTIME_MAPPING_PATH,
    schemaPath = SCHEMA_PATH,
    dataRoot = TOOL_DATA_ROOT,
    catalogRepository,
  } = {}) {
    this.repository = repository;
    this.runtime = runtime;
    this.registryPath = registryPath;
    this.runtimeMappingPath = runtimeMappingPath;
    this.schemaPath = schemaPath;
    this.dataRoot = dataRoot;
    this.catalogRepository = catalogRepository;
    this.runtimeQueue = Promise.resolve();
  }

  runtimeOperation(action) {
    const operation = this.runtimeQueue.then(action, action);
    this.runtimeQueue = operation.catch(() => {});
    return operation;
  }

  repositoryOperation(action) {
    if (typeof this.repository.withLock === "function") return this.repository.withLock(action);
    return action();
  }

  async runtimeStatus() {
    if (!this.runtime.descriptor().supported) return { available: false, session: "unsupported" };
    try {
      return await this.runtime.status();
    } catch (error) {
      return { available: false, error: { code: error.code || "RUNTIME_UNAVAILABLE", message: error.message } };
    }
  }

  async toolInspect() {
    const [registry, runtimeMapping, schema, themes] = await Promise.all([
      readJson(this.registryPath),
      readJson(this.runtimeMappingPath),
      readJson(this.schemaPath),
      this.repository.list(),
    ]);
    return {
      product: "DreamSkin Tool",
      target: { id: "trae", name: "Trae" },
      agentToolVersion: AGENT_TOOL_VERSION,
      protocolVersion: 1,
      repository: publicRepository(themes),
      registry: publicRegistry(registry),
      runtimeMapping,
      themeSchema: schema,
      safety: {
        structuredThemesOnly: true,
        arbitraryCssWrites: false,
        arbitraryPathReads: false,
        runtimeActionsExposedToAgent: false,
      },
    };
  }

  async inspect() {
    const [registry, runtimeMapping, schema, themes] = await Promise.all([
      readJson(this.registryPath),
      readJson(this.runtimeMappingPath),
      readJson(this.schemaPath),
      this.repository.list(),
    ]);
    const status = await this.runtimeStatus();
    return {
      product: "Trae-Dream-Skin",
      agentToolVersion: AGENT_TOOL_VERSION,
      protocolVersion: 1,
      runtime: this.runtime.descriptor(),
      status,
      repository: themes,
      registry: publicRegistry(registry),
      runtimeMapping,
      themeSchema: schema,
      safety: {
        structuredThemesOnly: true,
        arbitraryCssWrites: false,
        loopbackCdpOnly: true,
        modifiesTraeBundle: false,
      },
    };
  }

  themeList() {
    return this.repository.list();
  }

  themeRead(id) {
    return this.repository.read(id);
  }

  themeWrite(input) {
    return this.repository.write(input);
  }

  themeValidate(input) {
    return this.repository.validate(input);
  }

  async apply(id) {
    return this.runtimeOperation(() => this.repositoryOperation(async () => {
      const theme = await this.repository.read(id);
      const applied = await this.runtime.apply(id, { revision: theme.revision });
      const status = await this.runtime.status();
      return { ...applied, revision: theme.revision, status };
    }));
  }

  async verifyUnlocked({ screenshot = false, screenshotPath } = {}) {
    let outputPath = screenshotPath;
    if (screenshot && !outputPath) {
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      outputPath = path.join(this.dataRoot, "previews", `verify-${stamp}.png`);
    }
    const result = await this.runtime.verify({ screenshotPath: outputPath });
    return { ...result, requestedScreenshotPath: outputPath ? path.resolve(outputPath) : null };
  }

  verify(options = {}) {
    return this.runtimeOperation(() => this.verifyUnlocked(options));
  }

  async restore() {
    return this.runtimeOperation(async () => {
      const before = await this.runtime.status().catch(() => ({ session: "unknown" }));
      const restored = await this.runtime.restore();
      const after = await this.runtime.status();
      return { ...restored, before, after };
    });
  }

  async preview(id, { screenshot = true, screenshotPath } = {}) {
    return this.runtimeOperation(() => this.repositoryOperation(async () => {
      const candidate = await this.repository.read(id);
      const before = await this.runtime.status();
      const previousThemeId = before?.session === "active" ? before.themeId : null;
      let previousTheme = null;
      if (previousThemeId) {
        if (typeof before.themeRevision !== "string" || !/^[a-f0-9]{64}$/.test(before.themeRevision)) {
          throw new ToolError(
            "PREVIEW_STATE_UNRESTORABLE",
            "The active theme predates revision tracking. Reapply or restore it before previewing another theme.",
            { themeId: previousThemeId },
          );
        }
        previousTheme = await this.repository.read(previousThemeId);
        if (previousTheme.revision !== before.themeRevision) {
          throw new ToolError(
            "PREVIEW_STATE_UNRESTORABLE",
            "The active theme revision differs from the repository. Reapply or restore it before previewing another theme.",
            {
              themeId: previousThemeId,
              activeRevision: before.themeRevision,
              repositoryRevision: previousTheme.revision,
            },
          );
        }
      }
      let previewResult;
      let restoration;
      try {
        await this.runtime.apply(id, { revision: candidate.revision });
        previewResult = await this.verifyUnlocked({ screenshot, screenshotPath });
      } catch (error) {
        previewResult = { pass: false, error: { code: error.code || "PREVIEW_FAILED", message: error.message } };
      } finally {
        try {
          if (previousTheme) {
            await this.runtime.apply(previousTheme.id, { revision: previousTheme.revision });
            restoration = {
              mode: "theme",
              themeId: previousTheme.id,
              revision: previousTheme.revision,
              status: await this.runtime.status(),
            };
          } else {
            await this.runtime.restore();
            restoration = { mode: "native", status: await this.runtime.status() };
          }
        } catch (error) {
          throw new ToolError("PREVIEW_RESTORE_FAILED", "Preview finished, but the previous Trae state could not be restored.", {
            preview: previewResult,
            restoreError: { code: error.code || "RUNTIME_COMMAND_FAILED", message: error.message },
          });
        }
      }
      if (previewResult?.pass === false) {
        throw new ToolError("PREVIEW_FAILED", "The preview did not pass verification.", {
          preview: previewResult,
          restoration,
        });
      }
      return { id, revision: candidate.revision, preview: previewResult, restoration };
    }));
  }
}
