import { ToolError, asToolError } from "./errors.mjs";
import {
  assertPluginContract,
  resolvePluginResources,
  validatePluginManifest,
} from "./plugin-api.mjs";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export class PluginManager {
  constructor({ context = {} } = {}) {
    this.context = Object.freeze({ ...context });
    this.records = new Map();
  }

  descriptor(record) {
    return {
      id: record.manifest.id,
      state: record.state,
      active: record.state === "active",
      manifest: record.manifest,
    };
  }

  requireRecord(id) {
    const record = this.records.get(id);
    if (!record) throw new ToolError("PLUGIN_NOT_FOUND", `Plugin '${id}' is not registered.`, { pluginId: id });
    return record;
  }

  enqueue(record, operation) {
    const queued = record.queue.then(operation, operation);
    record.queue = queued.catch(() => {});
    return queued;
  }

  async register(plugin, { rootPath = plugin?.rootPath || process.cwd() } = {}) {
    const manifest = validatePluginManifest(plugin?.manifest);
    assertPluginContract(plugin, manifest);
    if (this.records.has(manifest.id)) {
      throw new ToolError("PLUGIN_ALREADY_REGISTERED", `Plugin '${manifest.id}' is already registered.`, {
        pluginId: manifest.id,
      });
    }
    const resources = await resolvePluginResources(manifest, rootPath);
    if (this.records.has(manifest.id)) {
      throw new ToolError("PLUGIN_ALREADY_REGISTERED", `Plugin '${manifest.id}' is already registered.`, {
        pluginId: manifest.id,
      });
    }
    const record = {
      manifest,
      plugin,
      resources,
      rootPath,
      state: "inactive",
      queue: Promise.resolve(),
    };
    this.records.set(manifest.id, record);
    return this.descriptor(record);
  }

  has(id) {
    return this.records.has(id);
  }

  get(id) {
    return this.descriptor(this.requireRecord(id));
  }

  query(id) {
    return this.get(id);
  }

  resources(id) {
    return this.requireRecord(id).resources;
  }

  list({ target, state } = {}) {
    return [...this.records.values()]
      .filter((record) => target === undefined || record.manifest.target.id === target)
      .filter((record) => state === undefined || record.state === state)
      .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id))
      .map((record) => this.descriptor(record));
  }

  activate(id, context = {}) {
    const record = this.requireRecord(id);
    return this.enqueue(record, async () => {
      if (record.state === "active") return this.descriptor(record);
      record.state = "activating";
      try {
        await record.plugin.activate?.(Object.freeze({
          ...this.context,
          ...context,
          pluginId: record.manifest.id,
          target: record.manifest.target,
          resources: record.resources,
        }));
        record.state = "active";
        return this.descriptor(record);
      } catch (error) {
        record.state = "inactive";
        const normalized = asToolError(error, "PLUGIN_ACTIVATION_FAILED");
        throw new ToolError("PLUGIN_ACTIVATION_FAILED", `Plugin '${id}' could not be activated.`, {
          pluginId: id,
          cause: { code: normalized.code, message: normalized.message },
        }, { cause: error });
      }
    });
  }

  deactivate(id, context = {}) {
    const record = this.requireRecord(id);
    return this.enqueue(record, async () => {
      if (record.state === "inactive") return this.descriptor(record);
      if (record.state !== "active") {
        throw new ToolError("INVALID_PLUGIN_STATE", `Plugin '${id}' cannot be deactivated from '${record.state}'.`, {
          pluginId: id,
          state: record.state,
        });
      }
      record.state = "deactivating";
      try {
        await record.plugin.deactivate?.(Object.freeze({
          ...this.context,
          ...context,
          pluginId: record.manifest.id,
          target: record.manifest.target,
          resources: record.resources,
        }));
        record.state = "inactive";
        return this.descriptor(record);
      } catch (error) {
        record.state = "active";
        const normalized = asToolError(error, "PLUGIN_DEACTIVATION_FAILED");
        throw new ToolError("PLUGIN_DEACTIVATION_FAILED", `Plugin '${id}' could not be deactivated.`, {
          pluginId: id,
          cause: { code: normalized.code, message: normalized.message },
        }, { cause: error });
      }
    });
  }

  runThemeAction(id, action, input = {}) {
    const record = this.requireRecord(id);
    return this.enqueue(record, async () => {
      this.assertActive(record);
      if (!record.manifest.themeTool.actions.includes(action)) {
        throw new ToolError("PLUGIN_ACTION_NOT_SUPPORTED", `Theme action '${action}' is not supported by '${id}'.`, {
          pluginId: id,
          action,
        });
      }
      return record.plugin.executeThemeAction(action, clone(input));
    });
  }

  createPreview(id, input = {}) {
    const record = this.requireRecord(id);
    return this.enqueue(record, async () => {
      this.assertActive(record);
      if (!record.manifest.capabilities.preview.supported) {
        throw new ToolError("PLUGIN_CAPABILITY_NOT_SUPPORTED", `Plugin '${id}' does not support previews.`, {
          pluginId: id,
          capability: "preview",
        });
      }
      return record.plugin.createPreview(clone(input));
    });
  }

  runRuntimeAction(id, action, input = {}) {
    const record = this.requireRecord(id);
    return this.enqueue(record, async () => {
      this.assertActive(record);
      if (!record.manifest.capabilities.runtime.supported
        || !record.manifest.capabilities.runtime.actions.includes(action)) {
        throw new ToolError("PLUGIN_ACTION_NOT_SUPPORTED", `Runtime action '${action}' is not supported by '${id}'.`, {
          pluginId: id,
          action,
        });
      }
      return record.plugin.executeRuntimeAction(action, clone(input));
    });
  }

  runtimeStatus(id) {
    const record = this.requireRecord(id);
    return this.enqueue(record, async () => {
      this.assertActive(record);
      if (!record.manifest.capabilities.runtime.supported) {
        throw new ToolError("PLUGIN_CAPABILITY_NOT_SUPPORTED", `Plugin '${id}' does not support runtime status.`, {
          pluginId: id,
          capability: "runtime",
        });
      }
      return record.plugin.runtimeStatus();
    });
  }

  assertActive(record) {
    if (record.state !== "active") {
      throw new ToolError("PLUGIN_NOT_ACTIVE", `Plugin '${record.manifest.id}' is not active.`, {
        pluginId: record.manifest.id,
        state: record.state,
      });
    }
  }
}
