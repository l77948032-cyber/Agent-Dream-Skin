import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { TRAE_PLUGIN_ROOT } from "../../plugins/trae/plugin.mjs";

import { createTraeApplicationContext } from "./application-context.mjs";
import { AcpSessionManager } from "./acp-session-manager.mjs";
import { AgentRegistry } from "./agent-registry.mjs";
import { ToolError } from "./errors.mjs";
import {
  PROJECT_ROOT,
  REGISTRY_PATH,
  STUDIO_DATA_ROOT,
  STUDIO_LIBRARY_PATH,
  STUDIO_THEMES_ROOT,
} from "./paths.mjs";
import { StudioLibrary } from "./studio-library.mjs";

function activeThemeId(status) {
  return status?.session === "active" ? status.themeId : null;
}

function changedAreas(before, after) {
  const areas = [
    ["colors", "调色板"],
    ["states", "交互状态"],
    ["visual", "组件视觉"],
    ["appearance", "界面材质"],
    ["layout", "页面布局"],
    ["image", "背景图"],
    ["name", "主题名称"],
    ["description", "主题说明"],
    ["brandSubtitle", "装饰文案"],
    ["tagline", "装饰文案"],
    ["statusText", "装饰文案"],
    ["quote", "装饰文案"],
  ];
  return [...new Set(areas
    .filter(([field]) => JSON.stringify(before?.[field]) !== JSON.stringify(after?.[field]))
    .map(([, label]) => label))];
}

function componentContext(component) {
  if (!component) return "No component is selected. Apply the requested direction consistently across the theme.";
  return [
    `Selected semantic component: ${component.id}`,
    `Description: ${component.description}`,
    `Modes: ${(component.modes || []).join(", ")}`,
    `States: ${(component.states || []).join(", ")}`,
    `Visual slots: ${(component.visualSlots || []).join(", ")}`,
  ].join("\n");
}

export class StudioBackend {
  constructor({
    tool,
    runtimeManager,
    pluginManager,
    library,
    agentRegistry = new AgentRegistry(),
    sessions,
    registryPath = REGISTRY_PATH,
    themesRoot = STUDIO_THEMES_ROOT,
    dataRoot = STUDIO_DATA_ROOT,
  }) {
    this.tool = tool;
    this.runtimeManager = runtimeManager;
    this.pluginManager = pluginManager;
    this.library = library;
    this.agentRegistry = agentRegistry;
    this.sessions = sessions || new AcpSessionManager({ agentRegistry, themesRoot });
    this.registryPath = registryPath;
    this.themesRoot = themesRoot;
    this.previewRoot = path.join(path.resolve(dataRoot), "previews");
    this.registry = null;
    this.themeLifecycleQueue = Promise.resolve();
  }

  screenshotOptions(input, { defaultScreenshot, prefix }) {
    const screenshot = typeof input?.screenshot === "boolean" ? input.screenshot : defaultScreenshot;
    if (!screenshot) return { screenshot: false };
    return {
      screenshot: true,
      screenshotPath: path.join(this.previewRoot, `${prefix}-${Date.now()}-${crypto.randomUUID()}.png`),
    };
  }

  themeLifecycleOperation(action) {
    const operation = this.themeLifecycleQueue.then(action);
    this.themeLifecycleQueue = operation.catch(() => {});
    return operation;
  }

  async runtimeStatus({ failClosed = false } = {}) {
    try {
      const status = await this.runtimeManager.status();
      if (failClosed && (
        !status
        || typeof status !== "object"
        || Array.isArray(status)
        || status.error
      )) {
        throw new ToolError(
          status?.error?.code || "RUNTIME_UNAVAILABLE",
          status?.error?.message || "Runtime status is unavailable.",
          { runtimeError: status?.error || null },
        );
      }
      return status;
    } catch (error) {
      if (failClosed) throw error;
      return {
        available: false,
        error: { code: error.code || "RUNTIME_UNAVAILABLE", message: error.message },
      };
    }
  }

  async components() {
    if (!this.registry) this.registry = JSON.parse(await fs.readFile(this.registryPath, "utf8"));
    return this.registry.components || [];
  }

  async bootstrap() {
    const [inspect, runtime, catalog, agents, settings] = await Promise.all([
      this.tool.inspect(),
      this.runtimeStatus(),
      this.library.catalog(),
      this.sessions.agents(),
      this.library.settings(),
    ]);
    const activeId = activeThemeId(runtime);
    return {
      catalog,
      themes: await this.library.list({ activeThemeId: activeId }),
      agents,
      connection: this.sessions.connectionState(),
      plugins: this.pluginManager.list(),
      activePluginId: this.runtimeManager.defaultPluginId,
      settings: {
        ...settings,
        themesRoot: this.themesRoot,
      },
      inspect,
      runtime,
    };
  }

  async themes() {
    const status = await this.runtimeStatus();
    return this.library.list({ activeThemeId: activeThemeId(status) });
  }

  async theme(id) {
    const status = await this.runtimeStatus();
    return this.library.read(id, { activeThemeId: activeThemeId(status) });
  }

  async createTheme(input = {}) {
    const status = await this.runtimeStatus();
    const options = { activeThemeId: activeThemeId(status) };
    if (input.kind === "template") return this.library.addTemplate(input.sourceId, options);
    if (input.kind === "blank") return this.library.createBlank(options);
    throw new ToolError("INVALID_ARGUMENT", "kind must be 'template' or 'blank'.");
  }

  async duplicateTheme(id) {
    const status = await this.runtimeStatus();
    return this.library.duplicate(id, { activeThemeId: activeThemeId(status) });
  }

  async deleteTheme(id, input = {}) {
    if (typeof input.expectedRevision !== "string" || !input.expectedRevision) {
      throw new ToolError("INVALID_ARGUMENT", "expectedRevision is required when deleting a theme.");
    }
    return this.themeLifecycleOperation(async () => {
      const status = await this.runtimeStatus({ failClosed: true });
      if (activeThemeId(status) === id) {
        throw new ToolError("THEME_ACTIVE", "Restore or apply another theme before deleting the active theme.", {
          themeId: id,
        });
      }
      return this.library.delete(id, { expectedRevision: input.expectedRevision });
    });
  }

  async updateTheme(id, input = {}) {
    if (typeof input.expectedRevision !== "string" || !input.expectedRevision) {
      throw new ToolError("INVALID_ARGUMENT", "expectedRevision is required when updating an existing theme.");
    }
    return this.themeLifecycleOperation(async () => {
      const status = await this.runtimeStatus();
      return this.library.update(id, input, { activeThemeId: activeThemeId(status) });
    });
  }

  async applyTheme(id) {
    return this.themeLifecycleOperation(async () => {
      const before = await this.library.read(id);
      await this.tool.validateTheme({ themeId: id });
      const runtime = await this.runtimeManager.apply(id);
      try {
        return {
          theme: await this.library.markApplied(id, before.revisionHash),
          runtime,
        };
      } catch (error) {
        await this.runtimeManager.restore().catch(() => {});
        throw error;
      }
    });
  }

  async validateTheme(id) {
    await this.library.read(id);
    return this.tool.validateTheme({ themeId: id });
  }

  async previewTheme(id, input = {}) {
    return this.themeLifecycleOperation(async () => {
      await this.library.read(id);
      return this.runtimeManager.preview({ id, ...this.screenshotOptions(input, {
        defaultScreenshot: true,
        prefix: "preview",
      }) });
    });
  }

  async agents() {
    return this.sessions.agents();
  }

  async connectAgent(id) {
    await this.sessions.connect(id);
    await this.library.updateSettings({ selectedAgentId: id });
    return {
      agents: await this.sessions.agents(),
      connection: this.sessions.connectionState(),
    };
  }

  message(id, input = {}) {
    return this.themeLifecycleOperation(() => this.messageUnlocked(id, input));
  }

  async messageUnlocked(id, input = {}) {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt) throw new ToolError("INVALID_ARGUMENT", "prompt is required.");
    const before = await this.library.read(id);
    if (typeof input.expectedRevision !== "string" || !input.expectedRevision) {
      throw new ToolError("INVALID_ARGUMENT", "expectedRevision is required when editing a theme by chat.");
    }
    if (input.expectedRevision !== before.revisionHash) {
      throw new ToolError("REVISION_CONFLICT", "The theme changed after it was opened.", {
        expectedRevision: input.expectedRevision,
        actualRevision: before.revisionHash,
      });
    }
    const agentId = input.agentId || this.sessions.selectedAgentId || (await this.library.settings()).selectedAgentId;
    if (!agentId) throw new ToolError("AGENT_NOT_CONNECTED", "Connect a local ACP agent before editing by chat.");
    const component = input.componentId
      ? (await this.components()).find((candidate) => candidate.id === input.componentId)
      : null;
    if (input.componentId && !component) {
      throw new ToolError("COMPONENT_NOT_FOUND", `Component '${input.componentId}' is not registered.`);
    }
    const settings = await this.library.settings();
    const context = [
      "You are editing one structured theme through the DreamSkin Tool provided by Studio.",
      `Target plugin id: ${this.runtimeManager.defaultPluginId}`,
      `Target theme id: ${id}`,
      `Current revision: ${before.revisionHash}`,
      `Exact read arguments: ${JSON.stringify({
        action: "read",
        pluginId: this.runtimeManager.defaultPluginId,
        themeId: id,
      })}`,
      `Exact update argument keys: ${JSON.stringify({
        action: "update",
        pluginId: this.runtimeManager.defaultPluginId,
        themeId: id,
        expectedRevision: before.revisionHash,
        themePatch: { colors: { accent: "#RRGGBB" } },
      })}`,
      "Use only pluginId, themeId, expectedRevision, and themePatch. Never shorten them to plugin, theme, or revision.",
      componentContext(component),
      settings.autoVerify
        ? "Call dreamskin_theme with action inspect/read first, then action update with expectedRevision, then action validate."
        : "Call dreamskin_theme with action inspect/read first, then action update with expectedRevision. Validate only when needed.",
      "Do not edit repository source files, do not write CSS, and do not use shell commands for the theme change.",
      "Keep all unmentioned parts coherent. Finish with a concise Chinese summary of the visible changes.",
    ].join("\n");
    const run = await this.sessions.prompt({
      agentId,
      themeId: id,
      pluginId: this.runtimeManager.defaultPluginId,
      prompt,
      context,
      expectedRevision: before.revisionHash,
    });
    const after = await this.library.reconcile(id);
    this.sessions.acceptRevision?.({
      agentId,
      themeId: id,
      pluginId: this.runtimeManager.defaultPluginId,
      sessionId: run.sessionId,
      revision: after.revisionHash,
    });
    if (settings.autoVerify) await this.tool.validateTheme({ themeId: id });
    const changes = changedAreas(before.theme, after.theme);
    return {
      theme: after,
      message: run.text || (changes.length ? "主题已经通过 DreamSkin Tool 更新。" : "Agent 已完成检查，主题结构没有变化。"),
      changes,
      sessionId: run.sessionId,
      stopReason: run.response.stopReason,
    };
  }

  catalog() {
    return this.library.catalog();
  }

  asset(kind, id) {
    return this.library.asset(kind, id);
  }

  async settings() {
    return {
      ...await this.library.settings(),
      themesRoot: this.themesRoot,
    };
  }

  async updateSettings(input) {
    return {
      ...await this.library.updateSettings(input),
      themesRoot: this.themesRoot,
    };
  }

  verify(input = {}) {
    return this.runtimeManager.verify(this.screenshotOptions(input, {
      defaultScreenshot: false,
      prefix: "verify",
    }));
  }

  restore() {
    return this.themeLifecycleOperation(() => this.runtimeManager.restore());
  }

  async close() {
    await this.sessions.close();
    const active = this.pluginManager.list({ state: "active" });
    await Promise.allSettled(active.map((entry) => this.pluginManager.deactivate(entry.id)));
  }
}

export async function createStudioBackend({
  pluginRoot = TRAE_PLUGIN_ROOT,
  pluginManifestPath,
  catalogThemesRoot,
  registryPath,
  userThemesRoot = STUDIO_THEMES_ROOT,
  dataRoot = STUDIO_DATA_ROOT,
  manifestPath = STUDIO_LIBRARY_PATH,
  projectRoot = PROJECT_ROOT,
  scriptsRoot = path.join(projectRoot, "scripts"),
  agentRegistry,
  agentRegistryOptions = {},
  sessions,
  sessionOptions = {},
} = {}) {
  const context = await createTraeApplicationContext({
    themesRoot: userThemesRoot,
    dataRoot,
    backupsRoot: path.join(dataRoot, "backups"),
    projectRoot,
    pluginRoot,
    pluginManifestPath,
    catalogThemesRoot,
    registryPath,
    scriptsRoot,
  });
  const catalogRepository = context.catalogRepository;
  const library = new StudioLibrary({
    catalogRepository,
    userRepository: context.repository,
    tool: context.tool,
    pluginId: context.plugin.manifest.id,
    catalog: context.plugin.catalog,
    manifestPath,
  });
  const pluginResources = context.pluginManager.resources(context.plugin.manifest.id);
  const targetAgentRegistry = agentRegistry || new AgentRegistry({
    projectRoot,
    ...agentRegistryOptions,
  });
  const targetSessions = sessions || new AcpSessionManager({
    agentRegistry: targetAgentRegistry,
    projectRoot,
    themesRoot: userThemesRoot,
    dataRoot,
    ...sessionOptions,
  });
  return new StudioBackend({
    tool: context.tool,
    runtimeManager: context.runtime,
    pluginManager: context.pluginManager,
    library,
    agentRegistry: targetAgentRegistry,
    sessions: targetSessions,
    registryPath: registryPath || pluginResources.registryPath,
    themesRoot: userThemesRoot,
    dataRoot,
  });
}
