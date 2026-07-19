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

export function createPreloadApi({ invoke }) {
  if (typeof invoke !== "function") throw new TypeError("createPreloadApi requires an invoke function.");

  const call = async (channel, ...args) => {
    const envelope = await invoke(channel, ...args);
    if (envelope?.ok === true) return envelope.result;
    throw desktopError(envelope?.error);
  };
  const studio = (operation, input = {}) => call(IPC_CHANNELS.studioApi, operation, input);

  return freeze({
    getInfo: () => call(IPC_CHANNELS.desktopInfo),
    studio: freeze({
      bootstrap: () => studio("bootstrap"),
      listCatalog: () => studio("catalog.list"),
      listThemes: () => studio("themes.list"),
      createTheme: (input) => studio("themes.create", input),
      duplicateTheme: (themeId) => studio("themes.duplicate", { themeId }),
      deleteTheme: (themeId, input) => studio("themes.delete", { themeId, input }),
      getTheme: (themeId) => studio("themes.read", { themeId }),
      updateTheme: (themeId, input) => studio("themes.update", { themeId, input }),
      applyTheme: (themeId) => studio("themes.apply", { themeId }),
      validateTheme: (themeId) => studio("themes.validate", { themeId }),
      previewTheme: (themeId, input = {}) => studio("themes.preview", { themeId, input }),
      sendThemeMessage: (themeId, input) => studio("themes.message", { themeId, input }),
      listAgents: () => studio("agents.list"),
      connectAgent: (agentId) => studio("agents.connect", { agentId }),
      getSettings: () => studio("settings.read"),
      updateSettings: (input) => studio("settings.update", input),
      verifyRuntime: (input = {}) => studio("runtime.verify", input),
      restoreRuntime: () => studio("runtime.restore"),
    }),
  });
}
