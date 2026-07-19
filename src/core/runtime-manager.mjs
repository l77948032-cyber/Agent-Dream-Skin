import { ToolError } from "./errors.mjs";

export class HostRuntimeManager {
  constructor({ pluginManager, defaultPluginId = "dreamskin.trae" } = {}) {
    if (!pluginManager || typeof pluginManager.runRuntimeAction !== "function") {
      throw new ToolError("INVALID_RUNTIME_DEPENDENCY", "Host Runtime Manager requires a PluginManager.");
    }
    this.pluginManager = pluginManager;
    this.defaultPluginId = defaultPluginId;
  }

  preview(input, pluginId = this.defaultPluginId) {
    return this.pluginManager.createPreview(pluginId, input);
  }

  async status(pluginId = this.defaultPluginId) {
    return this.pluginManager.runtimeStatus(pluginId);
  }

  apply(themeId, pluginId = this.defaultPluginId) {
    return this.pluginManager.runRuntimeAction(pluginId, "apply", { id: themeId });
  }

  verify(input = {}, pluginId = this.defaultPluginId) {
    return this.pluginManager.runRuntimeAction(pluginId, "verify", input);
  }

  restore(pluginId = this.defaultPluginId) {
    return this.pluginManager.runRuntimeAction(pluginId, "restore", {});
  }
}
