import { errorEnvelope, ToolError } from "../src/core/errors.mjs";
import {
  DREAMSKIN_HOST,
  DREAMSKIN_SCHEME,
  IPC_CHANNELS,
  MAX_DESKTOP_PAYLOAD_BYTES,
} from "./constants.mjs";

function assertSafeValue(value, state, depth = 0) {
  if (depth > 12) throw new ToolError("INVALID_IPC_PAYLOAD", "Desktop IPC payload is too deeply nested.");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    state.entries += value.length;
    if (state.entries > 5000) throw new ToolError("INVALID_IPC_PAYLOAD", "Desktop IPC payload has too many values.");
    for (const item of value) assertSafeValue(item, state, depth + 1);
    return;
  }
  if (typeof value !== "object") {
    throw new ToolError("INVALID_IPC_PAYLOAD", "Desktop IPC accepts only JSON-compatible values.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ToolError("INVALID_IPC_PAYLOAD", "Desktop IPC accepts only plain objects.");
  }
  const entries = Object.entries(value);
  state.entries += entries.length;
  if (state.entries > 5000) throw new ToolError("INVALID_IPC_PAYLOAD", "Desktop IPC payload has too many values.");
  for (const [key, item] of entries) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new ToolError("INVALID_IPC_PAYLOAD", "Desktop IPC payload contains an unsafe key.");
    }
    assertSafeValue(item, state, depth + 1);
  }
}

export function assertSafeIpcPayload(payload) {
  assertSafeValue(payload, { entries: 0 });
  let serialized;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    throw new ToolError("INVALID_IPC_PAYLOAD", "Desktop IPC payload is not serializable.");
  }
  if (Buffer.byteLength(serialized || "") > MAX_DESKTOP_PAYLOAD_BYTES) {
    throw new ToolError("INVALID_IPC_PAYLOAD", "Desktop IPC payload is too large.");
  }
}

export function createSenderValidator({ allowedWebContentsIds }) {
  if (typeof allowedWebContentsIds !== "function") {
    throw new ToolError("INVALID_ARGUMENT", "Sender validation requires an allowed webContents id provider.");
  }
  return function assertTrustedSender(event) {
    const sender = event?.sender;
    if (!sender || sender.isDestroyed?.()) {
      throw new ToolError("INVALID_IPC_SENDER", "Desktop IPC sender is unavailable.");
    }
    if (!allowedWebContentsIds().has(sender.id)) {
      throw new ToolError("INVALID_IPC_SENDER", "Desktop IPC sender is not a DreamSkin Studio window.");
    }
    if (!event.senderFrame || !sender.mainFrame || event.senderFrame !== sender.mainFrame) {
      throw new ToolError("INVALID_IPC_SENDER", "Desktop IPC is available only to the main frame.");
    }
    let url;
    try {
      url = new URL(event.senderFrame.url);
    } catch {
      throw new ToolError("INVALID_IPC_SENDER", "Desktop IPC sender URL is invalid.");
    }
    if (url.protocol !== `${DREAMSKIN_SCHEME}:` || url.hostname !== DREAMSKIN_HOST || url.port) {
      throw new ToolError("INVALID_IPC_SENDER", "Desktop IPC accepts only the DreamSkin Studio origin.");
    }
  };
}

function ipcSuccess(result) {
  return { ok: true, result };
}

async function invokeSafely(callback) {
  try {
    return ipcSuccess(await callback());
  } catch (error) {
    return errorEnvelope(error);
  }
}

export function registerDesktopIpc({ ipcMain, router, assertTrustedSender, getDesktopInfo }) {
  if (!ipcMain || !router || typeof assertTrustedSender !== "function" || typeof getDesktopInfo !== "function") {
    throw new ToolError("INVALID_ARGUMENT", "Desktop IPC registration is missing required dependencies.");
  }

  const inFlight = new Set();
  const track = (promise) => {
    inFlight.add(promise);
    void promise.then(
      () => inFlight.delete(promise),
      () => inFlight.delete(promise),
    );
    return promise;
  };

  ipcMain.handle(IPC_CHANNELS.desktopInfo, (event) => track(invokeSafely(async () => {
    assertTrustedSender(event);
    return getDesktopInfo();
  })));

  ipcMain.handle(IPC_CHANNELS.studioApi, (event, operation, input = {}) => track(invokeSafely(async () => {
    assertTrustedSender(event);
    assertSafeIpcPayload({ operation, input });
    return router.invoke(operation, input);
  })));

  return {
    unregister() {
      ipcMain.removeHandler(IPC_CHANNELS.desktopInfo);
      ipcMain.removeHandler(IPC_CHANNELS.studioApi);
    },
    async drain() {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
  };
}
