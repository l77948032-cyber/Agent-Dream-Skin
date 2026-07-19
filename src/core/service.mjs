import fs from "node:fs/promises";
import path from "node:path";

import { ToolError } from "./errors.mjs";
import { PlatformRuntime } from "./platform.mjs";
import { REGISTRY_PATH, SCHEMA_PATH, TOOL_DATA_ROOT } from "./paths.mjs";
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

export class TraeDreamSkinService {
  constructor({
    repository = new ThemeRepository(),
    runtime = new PlatformRuntime(),
    registryPath = REGISTRY_PATH,
    schemaPath = SCHEMA_PATH,
    dataRoot = TOOL_DATA_ROOT,
  } = {}) {
    this.repository = repository;
    this.runtime = runtime;
    this.registryPath = registryPath;
    this.schemaPath = schemaPath;
    this.dataRoot = dataRoot;
  }

  async inspect() {
    const [registry, schema, themes] = await Promise.all([
      readJson(this.registryPath),
      readJson(this.schemaPath),
      this.repository.list(),
    ]);
    let status;
    if (this.runtime.descriptor().supported) {
      try {
        status = await this.runtime.status();
      } catch (error) {
        status = { available: false, error: { code: error.code || "RUNTIME_UNAVAILABLE", message: error.message } };
      }
    } else status = { available: false, session: "unsupported" };
    return {
      product: "Trae-Dream-Skin",
      agentToolVersion: AGENT_TOOL_VERSION,
      protocolVersion: 1,
      runtime: this.runtime.descriptor(),
      status,
      repository: themes,
      registry: publicRegistry(registry),
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
    await this.repository.read(id);
    const applied = await this.runtime.apply(id);
    const status = await this.runtime.status();
    return { ...applied, status };
  }

  async verify({ screenshot = false, screenshotPath } = {}) {
    let outputPath = screenshotPath;
    if (screenshot && !outputPath) {
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
      outputPath = path.join(this.dataRoot, "previews", `verify-${stamp}.png`);
    }
    const result = await this.runtime.verify({ screenshotPath: outputPath });
    return { ...result, requestedScreenshotPath: outputPath ? path.resolve(outputPath) : null };
  }

  async restore() {
    const before = await this.runtime.status().catch(() => ({ session: "unknown" }));
    const restored = await this.runtime.restore();
    const after = await this.runtime.status();
    return { ...restored, before, after };
  }

  async preview(id, { screenshot = true, screenshotPath } = {}) {
    await this.repository.read(id);
    const before = await this.runtime.status();
    const previousThemeId = before?.session === "active" ? before.themeId : null;
    let previewResult;
    let restoration;
    try {
      await this.runtime.apply(id);
      previewResult = await this.verify({ screenshot, screenshotPath });
    } catch (error) {
      previewResult = { pass: false, error: { code: error.code || "PREVIEW_FAILED", message: error.message } };
    } finally {
      try {
        if (previousThemeId) {
          await this.runtime.apply(previousThemeId);
          restoration = { mode: "theme", themeId: previousThemeId, status: await this.runtime.status() };
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
    return { id, preview: previewResult, restoration };
  }
}
