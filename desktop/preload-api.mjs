import { IPC_CHANNELS } from "./constants.mjs";

function freeze(value) {
  return Object.freeze(value);
}

function desktopError(error = {}) {
  const result = new Error(error.message || "DreamSkin desktop request failed.");
  result.name = "DreamSkinDesktopError";
  result.code = error.code || "DESKTOP_REQUEST_FAILED";
  if (error.details !== undefined) result.details = error.details;
  return result;
}

export function createPreloadApi({ invoke, on = () => {}, removeListener = () => {} }) {
  if (typeof invoke !== "function") throw new TypeError("createPreloadApi requires an invoke function.");
  if (typeof on !== "function" || typeof removeListener !== "function") {
    throw new TypeError("createPreloadApi update events require listener functions.");
  }

  const call = async (channel, ...args) => {
    const envelope = await invoke(channel, ...args);
    if (envelope?.ok === true) return envelope.result;
    throw desktopError(envelope?.error);
  };
  const studio = (operation, input = {}) => call(IPC_CHANNELS.studioApi, operation, input);
  const scoped = (input, pluginId) => pluginId ? { ...input, pluginId } : input;

  return freeze({
    getInfo: () => call(IPC_CHANNELS.desktopInfo),
    updates: freeze({
      getState: () => call(IPC_CHANNELS.softwareUpdateGetState),
      check: () => call(IPC_CHANNELS.softwareUpdateCheck),
      download: () => call(IPC_CHANNELS.softwareUpdateDownload),
      install: () => call(IPC_CHANNELS.softwareUpdateInstall),
      subscribe: (listener) => {
        if (typeof listener !== "function") throw new TypeError("Software update listener must be a function.");
        const handler = (_event, state) => listener(state);
        on(IPC_CHANNELS.softwareUpdateState, handler);
        return () => removeListener(IPC_CHANNELS.softwareUpdateState, handler);
      },
    }),
    studio: freeze({
      bootstrap: () => studio("bootstrap"),
      listCatalog: (pluginId) => studio("catalog.list", scoped({}, pluginId)),
      listThemes: (pluginId) => studio("themes.list", scoped({}, pluginId)),
      createTheme: (input, pluginId) => studio("themes.create", scoped(input, pluginId)),
      duplicateTheme: (themeId, pluginId) => studio("themes.duplicate", scoped({ themeId }, pluginId)),
      deleteTheme: (themeId, input, pluginId) => studio("themes.delete", scoped({ themeId, input }, pluginId)),
      getTheme: (themeId, pluginId) => studio("themes.read", scoped({ themeId }, pluginId)),
      updateTheme: (themeId, input, pluginId) => studio("themes.update", scoped({ themeId, input }, pluginId)),
      applyTheme: (themeId, pluginId) => studio("themes.apply", scoped({ themeId }, pluginId)),
      validateTheme: (themeId, pluginId) => studio("themes.validate", scoped({ themeId }, pluginId)),
      previewTheme: (themeId, input = {}, pluginId) => studio("themes.preview", scoped({ themeId, input }, pluginId)),
      sendThemeMessage: (themeId, input, pluginId) => studio("themes.message", scoped({ themeId, input }, pluginId)),
      listAgents: () => studio("agents.list"),
      connectAgent: (agentId) => studio("agents.connect", { agentId }),
      getSettings: () => studio("settings.read"),
      updateSettings: (input) => studio("settings.update", input),
      verifyRuntime: (input = {}, pluginId) => studio("runtime.verify", scoped(input, pluginId)),
      restoreRuntime: (pluginId) => studio("runtime.restore", scoped({}, pluginId)),
    }),
  });
}
