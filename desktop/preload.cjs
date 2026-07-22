const { contextBridge, ipcRenderer } = require("electron");

const channels = Object.freeze({
  desktopInfo: "dreamskin:desktop-info",
  studioApi: "dreamskin:studio-api",
  softwareUpdateState: "dreamskin:software-update-state",
  softwareUpdateGetState: "dreamskin:software-update-get-state",
  softwareUpdateCheck: "dreamskin:software-update-check",
  softwareUpdateDownload: "dreamskin:software-update-download",
  softwareUpdateInstall: "dreamskin:software-update-install",
});

function desktopError(error = {}) {
  const result = new Error(error.message || "DreamSkin desktop request failed.");
  result.name = "DreamSkinDesktopError";
  result.code = error.code || "DESKTOP_REQUEST_FAILED";
  if (error.details !== undefined) result.details = error.details;
  return result;
}

async function call(channel, ...args) {
  const envelope = await ipcRenderer.invoke(channel, ...args);
  if (envelope?.ok === true) return envelope.result;
  throw desktopError(envelope?.error);
}

const studio = (operation, input = {}) => call(channels.studioApi, operation, input);
const scoped = (input, pluginId) => pluginId ? { ...input, pluginId } : input;
const api = Object.freeze({
  getInfo: () => call(channels.desktopInfo),
  updates: Object.freeze({
    getState: () => call(channels.softwareUpdateGetState),
    check: () => call(channels.softwareUpdateCheck),
    download: () => call(channels.softwareUpdateDownload),
    install: () => call(channels.softwareUpdateInstall),
    subscribe: (listener) => {
      if (typeof listener !== "function") throw new TypeError("Software update listener must be a function.");
      const handler = (_event, state) => listener(state);
      ipcRenderer.on(channels.softwareUpdateState, handler);
      return () => ipcRenderer.removeListener(channels.softwareUpdateState, handler);
    },
  }),
  studio: Object.freeze({
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
    getSettings: () => studio("settings.read"),
    updateSettings: (input) => studio("settings.update", input),
    getCliStatus: () => studio("cli.status"),
    installCli: () => studio("cli.install"),
    uninstallCli: () => studio("cli.uninstall"),
    getRuntimeStatus: (pluginId) => studio("runtime.status", scoped({}, pluginId)),
    verifyRuntime: (input = {}, pluginId) => studio("runtime.verify", scoped(input, pluginId)),
    restoreRuntime: (pluginId) => studio("runtime.restore", scoped({}, pluginId)),
  }),
});

contextBridge.exposeInMainWorld("dreamskin", api);
