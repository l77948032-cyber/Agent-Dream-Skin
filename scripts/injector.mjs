import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_CONFIG_BYTES,
  MAX_CSS_BYTES,
  THEME_VARIABLES,
  matchesImageSignature,
} from "../src/core/theme-model.mjs";
import { loadTheme } from "../src/core/theme-loader.mjs";

export { normalizeTheme } from "../src/core/theme-model.mjs";
export { loadTheme } from "../src/core/theme-loader.mjs";

const filename = fileURLToPath(import.meta.url);
const here = path.dirname(filename);
const root = path.resolve(here, "..");
const VISUAL_ATTRIBUTE_NAMES = Object.freeze([
  "data-trae-skin-motif",
  "data-trae-skin-icon-treatment",
  "data-trae-skin-surface-treatment",
  "data-trae-skin-accent-placement",
  "data-trae-skin-card-treatment",
  "data-trae-skin-ornament",
]);

export const SKIN_VERSION = "0.3.0";
export const DEFAULT_PORT = 9342;

const DEFAULT_THEME_DIR = path.join(root, "themes", "neon-portal");
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const CDP_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const OWNER_TOKEN_PATTERN = /^[a-f0-9]{32}$/i;
const MAX_CDP_JSON_BYTES = 2 * 1024 * 1024;

export class CdpIdentityMismatchError extends Error {}

function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    mode: "watch",
    timeoutMs: 30000,
    screenshot: null,
    reload: false,
    themeDir: DEFAULT_THEME_DIR,
    browserId: null,
    targetId: null,
    ownerToken: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--port") options.port = Number(argumentValue(argv, index++, arg));
    else if (arg === "--once") options.mode = "once";
    else if (arg === "--watch") options.mode = "watch";
    else if (arg === "--verify") options.mode = "verify";
    else if (arg === "--remove") options.mode = "remove";
    else if (arg === "--probe-targets") options.mode = "probe";
    else if (arg === "--check-payload") options.mode = "check";
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argumentValue(argv, index++, arg));
    else if (arg === "--screenshot") options.screenshot = path.resolve(argumentValue(argv, index++, arg));
    else if (arg === "--theme-dir") options.themeDir = path.resolve(argumentValue(argv, index++, arg));
    else if (arg === "--browser-id") options.browserId = argumentValue(argv, index++, arg);
    else if (arg === "--target-id") options.targetId = argumentValue(argv, index++, arg);
    else if (arg === "--owner-token") options.ownerToken = argumentValue(argv, index++, arg);
    else if (arg === "--reload") options.reload = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 250 || options.timeoutMs > 120000) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }
  if (options.browserId !== null && !CDP_ID_PATTERN.test(options.browserId)) {
    throw new Error(`Invalid browser ID: ${options.browserId}`);
  }
  if (options.targetId !== null && !CDP_ID_PATTERN.test(options.targetId)) {
    throw new Error(`Invalid target ID: ${options.targetId}`);
  }
  if (options.ownerToken !== null && !OWNER_TOKEN_PATTERN.test(options.ownerToken)) {
    throw new Error("Invalid owner token");
  }
  return options;
}

export function validatedDebuggerUrl(target, port, expectedKind = null) {
  let url;
  try {
    url = new URL(target?.webSocketDebuggerUrl);
  } catch {
    throw new Error("Rejected an invalid CDP WebSocket URL");
  }
  const match = url.pathname.match(/^\/devtools\/(page|browser)\/([A-Za-z0-9._-]{1,200})$/);
  const kindMatches = expectedKind === null || match?.[1] === expectedKind;
  if (
    url.protocol !== "ws:" ||
    !LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ||
    Number(url.port) !== port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    !kindMatches
  ) {
    throw new Error("Rejected a CDP WebSocket URL outside the allowed loopback endpoint shape");
  }
  return url.href;
}

export function browserIdFromVersion(version, port) {
  const url = new URL(validatedDebuggerUrl(version, port, "browser"));
  const browserId = url.pathname.slice("/devtools/browser/".length);
  if (!CDP_ID_PATTERN.test(browserId)) throw new Error("Rejected an invalid CDP browser ID");
  return browserId;
}

export function isValidPageTarget(target, port) {
  if (
    target?.type !== "page" ||
    typeof target.id !== "string" ||
    !CDP_ID_PATTERN.test(target.id) ||
    typeof target.url !== "string" ||
    !target.webSocketDebuggerUrl
  ) return false;

  try {
    const url = new URL(validatedDebuggerUrl(target, port, "page"));
    return url.pathname === `/devtools/page/${target.id}`;
  } catch {
    return false;
  }
}

export function isPlausibleTraeRendererTarget(target) {
  try {
    const url = new URL(target?.url);
    if (url.protocol !== "vscode-file:" || url.hostname !== "vscode-app") return false;
    const pathname = decodeURIComponent(url.pathname);
    return /\/out\/vs\/code\/electron-browser\/(?:solo\/solo-lite|workbench\/workbench)\.html$/i
      .test(pathname);
  } catch {
    return false;
  }
}

function requireWebSocket() {
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error(
      "This Node.js runtime does not expose WebSocket. Use Node 22+ or Node 20 with --experimental-websocket.",
    );
  }
  return globalThis.WebSocket;
}

export class CdpSession {
  constructor(target, port, WebSocketCtor = requireWebSocket()) {
    this.target = target;
    this.ws = new WebSocketCtor(validatedDebuggerUrl(target, port, "page"));
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        try { this.ws.close(); } catch {}
        reject(new Error("CDP WebSocket open timed out"));
      }, 5000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP WebSocket open failed"));
      }, { once: true });
    });

    this.ws.addEventListener("message", (event) => this.onMessage(event));
    this.ws.addEventListener("error", () => this.close());
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timeout);
        waiter.reject(new Error("CDP socket closed"));
      }
      this.pending.clear();
    });
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    return this;
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      this.close();
      return;
    }
    if (message.id) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timeout);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(`${message.error.message} (${message.error.code})`));
      else waiter.resolve(message.result);
      return;
    }
    for (const listener of this.listeners.get(message.method) ?? []) {
      try { listener(message.params ?? {}); } catch {}
    }
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP session is closed"));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, 10000);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: false,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`Renderer evaluation failed: ${detail}`);
    }
    return result.result?.value;
  }

  close() {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("CDP session closed"));
    }
    this.pending.clear();
    if (!this.closed) {
      try { this.ws.close(); } catch {}
    }
    this.closed = true;
  }
}

class BrowserIdentityAnchor {
  constructor(url, WebSocketCtor = requireWebSocket()) {
    this.ws = new WebSocketCtor(url);
    this.closed = false;
    this.ws.addEventListener("close", () => { this.closed = true; });
    this.ws.addEventListener("error", () => {
      this.closed = true;
      try { this.ws.close(); } catch {}
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.close();
        reject(new Error("CDP browser identity WebSocket open timed out"));
      }, 5000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP browser identity WebSocket open failed"));
      }, { once: true });
      this.ws.addEventListener("close", () => {
        clearTimeout(timeout);
        reject(new Error("CDP browser identity WebSocket closed during startup"));
      }, { once: true });
    });
    if (this.closed) throw new Error("CDP browser identity WebSocket is already closed");
    return this;
  }

  close() {
    if (!this.closed) {
      try { this.ws.close(); } catch {}
    }
    this.closed = true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchCdpJson(port, resource, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not expose fetch");
  if (resource !== "/json/list" && resource !== "/json/version") {
    throw new Error(`Rejected unsupported CDP JSON resource: ${resource}`);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}${resource}`, {
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_CDP_JSON_BYTES) throw new Error("CDP JSON response is too large");
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveBrowserIdentity(port, expectedBrowserId = null, fetchImpl = globalThis.fetch) {
  const version = await fetchCdpJson(port, "/json/version", fetchImpl);
  const browserId = browserIdFromVersion(version, port);
  if (expectedBrowserId && browserId !== expectedBrowserId) {
    throw new CdpIdentityMismatchError(
      `CDP browser identity changed from ${expectedBrowserId} to ${browserId}`,
    );
  }
  return {
    browserId,
    product: typeof version.Browser === "string" ? version.Browser.slice(0, 200) : null,
    webSocketDebuggerUrl: validatedDebuggerUrl(version, port, "browser"),
  };
}

export async function listPageTargets(port, targetId = null, fetchImpl = globalThis.fetch) {
  const targets = await fetchCdpJson(port, "/json/list", fetchImpl);
  if (!Array.isArray(targets)) throw new Error("CDP target list is not an array");
  return targets
    .filter((target) => isValidPageTarget(target, port))
    .filter((target) => !targetId || target.id === targetId);
}

const RAW_PROBE_EXPRESSION = String.raw`(() => {
  const body = document.body;
  const root = document.documentElement;
  const select = (selector) => {
    try { return document.querySelector(selector); } catch { return null; }
  };
  const selectAll = (selector) => {
    try { return document.querySelectorAll(selector); } catch { return []; }
  };
  const appRoot = select('#root, #app, #__next, [data-reactroot]');
  const workbench = select('.monaco-workbench');
  const soloLiteRoot = select('#solo-lite-root');
  const soloLayout = select('.solo-lite-layout');
  const viewport = { width: innerWidth, height: innerHeight };
  const bodyText = String(body?.innerText || '').slice(0, 6000);
  const applicationName = String(
    select('meta[name="application-name"]')?.content ||
    select('meta[name="apple-mobile-web-app-title"]')?.content ||
    ''
  );
  const brandPattern = /(?:^|\b)(?:trae|trae\s+solo|solo\s+cn)(?:\b|$)/i;
  const namedNodes = selectAll(
    '[class*="trae" i], [id*="trae" i], [data-testid*="trae" i], ' +
    '[class*="solo" i], [id*="solo" i], [data-testid*="solo" i]'
  );
  const classSamples = [];
  const seenClasses = new Set();
  for (const node of [...selectAll('[class]')].slice(0, 500)) {
    for (const token of String(node.className || '').split(/\s+/)) {
      if (!token || token.length > 80 || seenClasses.has(token)) continue;
      seenClasses.add(token);
      classSamples.push(token);
      if (classSamples.length >= 60) break;
    }
    if (classSamples.length >= 60) break;
  }
  const idSamples = [...selectAll('[id]')]
    .slice(0, 80)
    .map((node) => String(node.id || '').slice(0, 80))
    .filter(Boolean);
  const bodyRect = body?.getBoundingClientRect?.();
  return {
    title: String(document.title || '').slice(0, 200),
    href: String(location.href || '').slice(0, 500),
    protocol: String(location.protocol || ''),
    applicationName: applicationName.slice(0, 100),
    brandSignals: {
      title: brandPattern.test(String(document.title || '')),
      href: brandPattern.test(String(location.href || '')),
      metadata: brandPattern.test(applicationName),
      dom: namedNodes.length > 0,
      text: brandPattern.test(bodyText),
    },
    markers: {
      body: Boolean(body),
      appRoot: Boolean(appRoot),
      soloLiteRoot: Boolean(soloLiteRoot),
      soloLayout: Boolean(soloLayout),
      taskListPanel: Boolean(select('.task-list-panel')),
      chatPanel: Boolean(select('.solo-lite-chat-panel-container, .solo-lite-chat-panel, .solo-lite-chat-container')),
      initialPanel: Boolean(select('#solo-lite-root .panel-content, .initial-chat-panel, .showcaseWrapper')),
      sessionPanel: Boolean(select('.session-panel, .ai-chat.chat-session')),
      messageList: Boolean(select('.virtualized-message-list-view')),
      messageInput: Boolean(select('.messageInputContainer, .chat-input-v2-container')),
      chatTextbox: Boolean(select('[role="textbox"].chat-input-v2-input-box-editable')),
      sendButton: Boolean(select('.chat-input-v2-send-button')),
      monacoWorkbench: Boolean(workbench),
      workbenchPartCount: selectAll('.monaco-workbench .part, .part.editor, .part.sidebar').length,
      monacoEditorCount: selectAll('.monaco-editor').length,
      main: Boolean(select('main, [role="main"]')),
      navigation: Boolean(select('nav, aside, [role="navigation"], [role="complementary"]')),
      interactiveCount: selectAll('button, input, textarea, select, [contenteditable="true"], [role="button"]').length,
      dataTestIdCount: selectAll('[data-testid]').length,
      traeNamedCount: namedNodes.length,
      rootChildCount: appRoot?.childElementCount || 0,
      bodyTextLength: String(body?.innerText || '').length,
      bodyWidth: Math.round(bodyRect?.width || 0),
      bodyHeight: Math.round(bodyRect?.height || 0),
    },
    viewport,
    samples: { classes: classSamples, ids: idSamples },
  };
})()`;

export function classifyTraeProbe(rawProbe, target = {}, explicitTarget = false) {
  const raw = rawProbe && typeof rawProbe === "object" ? rawProbe : {};
  const markers = raw.markers && typeof raw.markers === "object" ? raw.markers : {};
  const brandSignals = raw.brandSignals && typeof raw.brandSignals === "object" ? raw.brandSignals : {};
  const targetBrand = /(?:^|\b)(?:trae|trae\s+solo|solo\s+cn)(?:\b|$)/i.test(
    `${target.title ?? ""} ${target.url ?? ""}`,
  );
  const trustedRendererUrl = isPlausibleTraeRendererTarget(target);
  const branded = targetBrand || Object.values(brandSignals).some(Boolean);
  const viewportWidth = Number(raw.viewport?.width ?? markers.bodyWidth ?? 0);
  const viewportHeight = Number(raw.viewport?.height ?? markers.bodyHeight ?? 0);
  const largeSurface = viewportWidth >= 400 && viewportHeight >= 280 && markers.body !== false;
  const vscodeStructure = Boolean(markers.monacoWorkbench) && (
    Number(markers.workbenchPartCount) >= 1 || Number(markers.monacoEditorCount) >= 1
  );
  const appStructure = Boolean(markers.appRoot) && largeSurface && (
    Number(markers.interactiveCount) >= 2 ||
    (Boolean(markers.main) && Boolean(markers.navigation)) ||
    (Number(markers.rootChildCount) >= 1 && Number(markers.dataTestIdCount) >= 2)
  );
  const soloPrimarySurface = (
    Boolean(markers.chatPanel) && Boolean(markers.sessionPanel)
  ) || (
    Boolean(markers.initialPanel) && Boolean(markers.messageInput || markers.chatTextbox)
  );
  const soloLiteStructure = Boolean(markers.soloLiteRoot) &&
    Boolean(markers.soloLayout || markers.initialPanel) && soloPrimarySurface && largeSurface;
  const soloStructure = soloLiteStructure || (branded && appStructure);
  const explicitStructure = explicitTarget && largeSurface && Boolean(markers.appRoot) && (
    Number(markers.interactiveCount) >= 1 || Number(markers.bodyTextLength) >= 20
  );

  let score = 0;
  if (targetBrand) score += 4;
  if (branded) score += 3;
  if (markers.monacoWorkbench) score += 5;
  if (markers.soloLiteRoot) score += 5;
  if (markers.soloLayout) score += 4;
  if (markers.chatPanel) score += 2;
  if (markers.initialPanel) score += 2;
  if (markers.sessionPanel) score += 2;
  if (markers.messageInput || markers.chatTextbox) score += 2;
  if (Number(markers.workbenchPartCount) >= 1) score += 2;
  if (Number(markers.monacoEditorCount) >= 1) score += 1;
  if (markers.appRoot) score += 2;
  if (markers.main) score += 1;
  if (markers.navigation) score += 1;
  if (Number(markers.interactiveCount) >= 2) score += 1;
  if (largeSurface) score += 1;

  const kind = soloLiteStructure ? "trae-solo-lite"
    : vscodeStructure ? "vscode-workbench"
      : soloStructure ? "trae-solo"
      : explicitStructure ? "explicit-trae-renderer"
        : "unknown";
  return {
    ...raw,
    matched: (trustedRendererUrl && (vscodeStructure || soloStructure)) || explicitStructure,
    kind,
    score,
    targetBrand,
    trustedRendererUrl,
    substantial: largeSurface && (Boolean(markers.appRoot) || Boolean(markers.monacoWorkbench)),
  };
}

export async function probeSession(session, target = {}, explicitTarget = false) {
  const rawProbe = await session.evaluate(RAW_PROBE_EXPRESSION);
  return classifyTraeProbe(rawProbe, target, explicitTarget);
}

async function readSizedFile(filePath, maximum, label) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
    throw new Error(`${label} must be a non-empty file no larger than ${maximum} bytes`);
  }
  return fs.readFile(filePath);
}

export async function loadPayload(themeDir = DEFAULT_THEME_DIR) {
  const [templateBuffer, runtimeMappingBuffer, componentRegistryBuffer, loaded] = await Promise.all([
    readSizedFile(path.join(root, "assets", "renderer-inject.js"), MAX_CSS_BYTES, "Renderer template"),
    readSizedFile(path.join(root, "registry", "theme-runtime.v1.json"), MAX_CONFIG_BYTES, "Theme runtime mapping"),
    readSizedFile(path.join(root, "registry", "components.v1.json"), MAX_CONFIG_BYTES, "Component registry"),
    loadTheme(themeDir),
  ]);
  const template = templateBuffer.toString("utf8");
  const runtimeMapping = JSON.parse(runtimeMappingBuffer.toString("utf8"));
  const componentRegistry = JSON.parse(componentRegistryBuffer.toString("utf8"));
  const artDataUrl = `data:${loaded.mime};base64,${loaded.image.toString("base64")}`;
  const payload = template
    .replaceAll("__TRAE_SKIN_CSS_JSON__", JSON.stringify(loaded.css))
    .replaceAll("__TRAE_SKIN_ART_JSON__", JSON.stringify(artDataUrl))
    .replaceAll("__TRAE_SKIN_THEME_JSON__", JSON.stringify(loaded.theme))
    .replaceAll("__TRAE_SKIN_RUNTIME_MAP_JSON__", JSON.stringify(runtimeMapping))
    .replaceAll("__TRAE_SKIN_COMPONENT_REGISTRY_JSON__", JSON.stringify(componentRegistry))
    .replaceAll("__TRAE_SKIN_VERSION_JSON__", JSON.stringify(SKIN_VERSION));
  if (/__TRAE_SKIN_(?:CSS|ART|THEME|RUNTIME_MAP|COMPONENT_REGISTRY|VERSION)_JSON__/.test(payload)) {
    throw new Error("Renderer payload contains an unresolved placeholder");
  }
  return {
    payload,
    theme: loaded.theme,
    imageBytes: loaded.image.length,
    cssBytes: Buffer.byteLength(loaded.css),
    payloadBytes: Buffer.byteLength(payload),
    cssPath: loaded.cssPath,
  };
}

export async function applyToSession(session, payload) {
  return session.evaluate(payload);
}

export async function removeFromSession(session) {
  return session.evaluate(`(() => {
    window.__TRAE_DREAM_SKIN_DISABLED__ = true;
    const state = window.__TRAE_DREAM_SKIN_STATE__;
    if (typeof state?.cleanup === 'function') return state.cleanup();
    const root = document.documentElement;
    root?.classList.remove('trae-dream-skin');
    document.body?.classList.remove('trae-dream-skin-body');
    root?.removeAttribute('data-trae-skin-theme');
    root?.removeAttribute('data-trae-skin-shell');
    root?.removeAttribute('data-trae-skin-treatment');
    root?.removeAttribute('data-trae-skin-layout');
    root?.removeAttribute('data-trae-skin-shadow');
    root?.removeAttribute('data-trae-skin-mode');
    root?.removeAttribute('data-trae-skin-view');
    root?.removeAttribute('data-trae-skin-route');
    for (const attribute of ${JSON.stringify(VISUAL_ATTRIBUTE_NAMES)}) root?.removeAttribute(attribute);
    root?.removeAttribute('data-trae-skin-active');
    document.querySelectorAll('[data-trae-skin-surface]').forEach((node) =>
      node.removeAttribute('data-trae-skin-surface'));
    document.querySelectorAll('[data-trae-skin-role]').forEach((node) => {
      node.removeAttribute('data-trae-skin-role');
      node.removeAttribute('data-trae-skin-index');
    });
    document.querySelectorAll('[data-trae-skin-component]').forEach((node) =>
      node.removeAttribute('data-trae-skin-component'));
    for (const name of ${JSON.stringify(THEME_VARIABLES)}) root?.style.removeProperty(name);
    document.getElementById('trae-dream-skin-style')?.remove();
    document.getElementById('trae-dream-skin-chrome')?.remove();
    delete window.__TRAE_DREAM_SKIN_STATE__;
    return true;
  })()`);
}

export async function verifyRemovedSession(session) {
  return session.evaluate(`(() => {
    const root = document.documentElement;
    const themeVariablesRemoved = ${JSON.stringify(THEME_VARIABLES)}.every(
      (name) => !root?.style.getPropertyValue(name));
    return !root?.classList.contains('trae-dream-skin') &&
      !document.body?.classList.contains('trae-dream-skin-body') &&
      !root?.hasAttribute('data-trae-skin-active') &&
      !root?.hasAttribute('data-trae-skin-theme') &&
      !root?.hasAttribute('data-trae-skin-treatment') &&
      !root?.hasAttribute('data-trae-skin-layout') &&
      !root?.hasAttribute('data-trae-skin-shadow') &&
      !root?.hasAttribute('data-trae-skin-mode') &&
      !root?.hasAttribute('data-trae-skin-view') &&
      !root?.hasAttribute('data-trae-skin-route') &&
      ${JSON.stringify(VISUAL_ATTRIBUTE_NAMES)}.every((attribute) => !root?.hasAttribute(attribute)) &&
      themeVariablesRemoved &&
      !document.querySelector('[data-trae-skin-surface]') &&
      !document.querySelector('[data-trae-skin-role]') &&
      !document.querySelector('[data-trae-skin-component]') &&
      !document.getElementById('trae-dream-skin-style') &&
      !document.getElementById('trae-dream-skin-chrome') &&
      !window.__TRAE_DREAM_SKIN_STATE__;
  })()`);
}

export async function verifySession(session, expectedThemeId = null) {
  return session.evaluate(`(() => {
    const root = document.documentElement;
    const body = document.body;
    const style = document.getElementById('trae-dream-skin-style');
    const state = window.__TRAE_DREAM_SKIN_STATE__;
    const box = (node) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const computed = getComputedStyle(node);
      return {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: rect.width > 0 && rect.height > 0 && computed.display !== 'none' &&
          computed.visibility !== 'hidden',
        pointerEvents: computed.pointerEvents,
      };
    };
    const soloRootNode = document.querySelector('#solo-lite-root');
    const soloLayoutNode = document.querySelector('.solo-lite-layout');
    const workbenchNode = document.querySelector('.monaco-workbench');
    const chatPanelNode = document.querySelector(
      '.solo-lite-chat-panel-container, .solo-lite-chat-panel, .solo-lite-chat-container');
    const homePanelNode = document.querySelector(
      '#solo-lite-root .panel-content, .initial-chat-panel, .showcaseWrapper');
    const composerNode = document.querySelector('.messageInputContainer, .chat-input-v2-container');
    const textBoxNode = document.querySelector('[role="textbox"].chat-input-v2-input-box-editable');
    const rootRect = root?.getBoundingClientRect?.();
    const bodyRect = body?.getBoundingClientRect?.();
    const result = {
      installed: Boolean(root?.classList.contains('trae-dream-skin')),
      bodyInstalled: Boolean(body?.classList.contains('trae-dream-skin-body')),
      version: state?.version ?? null,
      expectedVersion: ${JSON.stringify(SKIN_VERSION)},
      themeId: state?.themeId ?? root?.getAttribute('data-trae-skin-theme') ?? null,
      mode: root?.getAttribute('data-trae-skin-mode') ?? null,
      route: root?.getAttribute('data-trae-skin-route') ?? null,
      expectedThemeId: ${JSON.stringify(expectedThemeId)},
      stylePresent: Boolean(style && style.textContent?.length),
      artPresent: Boolean(root?.style.getPropertyValue('--trae-skin-art')),
      interactionStatePresent: [
        '--trae-skin-focus',
        '--trae-skin-surface-hover',
        '--trae-skin-surface-active',
        '--trae-skin-tooltip-bg',
        '--trae-skin-tooltip-text',
      ].every((name) => Boolean(root?.style.getPropertyValue(name))),
      cleanupAvailable: typeof state?.cleanup === 'function',
      ensureAvailable: typeof state?.ensure === 'function',
      viewport: { width: innerWidth, height: innerHeight },
      rootBox: { width: Math.round(rootRect?.width || 0), height: Math.round(rootRect?.height || 0) },
      bodyBox: { width: Math.round(bodyRect?.width || 0), height: Math.round(bodyRect?.height || 0) },
      horizontalOverflow: root ? root.scrollWidth > root.clientWidth + 2 : false,
      surfaceCount: document.querySelectorAll('[data-trae-skin-surface]').length,
      soloRoot: box(soloRootNode),
      soloLayout: box(soloLayoutNode),
      workbench: box(workbenchNode),
      chatPanel: box(chatPanelNode),
      homePanel: box(homePanelNode),
      composer: box(composerNode),
      textBox: box(textBoxNode),
    };
    const soloPass = !soloRootNode || (
      result.soloRoot?.visible && (result.chatPanel?.visible || result.homePanel?.visible) &&
      result.composer?.visible && result.textBox?.visible && result.textBox.pointerEvents !== 'none'
    );
    const shellPass = Boolean(soloRootNode || workbenchNode) &&
      (result.soloRoot?.visible || result.workbench?.visible);
    result.pass = result.installed && result.bodyInstalled &&
      result.version === result.expectedVersion && result.stylePresent && result.artPresent &&
      result.interactionStatePresent &&
      result.cleanupAvailable && result.ensureAvailable &&
      (!result.expectedThemeId || result.themeId === result.expectedThemeId) &&
      result.viewport.width > 0 && result.viewport.height > 0 && result.surfaceCount > 0 &&
      shellPass && soloPass && !result.horizontalOverflow;
    return result;
  })()`);
}

async function waitForVerification(session, timeoutMs, expectedThemeId) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      lastResult = await verifySession(session, expectedThemeId);
      lastError = null;
      if (lastResult?.pass) return lastResult;
    } catch (error) {
      lastError = error;
    }
    await sleep(350);
  }
  if (!lastResult && lastError) throw lastError;
  return lastResult;
}

export async function captureScreenshot(session, outputPath) {
  const result = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  if (typeof result?.data !== "string" || !result.data) {
    throw new Error("CDP did not return screenshot data");
  }
  const data = Buffer.from(result.data, "base64");
  if (data.length < 8 || !matchesImageSignature(data, ".png")) {
    throw new Error("CDP returned an invalid PNG screenshot");
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, data);
  return { path: outputPath, bytes: data.length };
}

async function waitForPaint(session) {
  await session.evaluate(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  })`);
  await sleep(80);
}

async function connectTarget(target, port) {
  return new CdpSession(target, port).open();
}

async function connectTraeTargets(options) {
  const deadline = Date.now() + options.timeoutMs;
  let lastError = null;
  let lastSummary = "no page targets";
  while (Date.now() < deadline) {
    try {
      const targets = await listPageTargets(options.port, options.targetId);
      const connected = [];
      const rejected = [];
      for (const target of targets) {
        let session;
        try {
          session = await connectTarget(target, options.port);
          const probe = await probeSession(session, target, Boolean(options.targetId));
          if (probe.matched) connected.push({ target, session, probe });
          else {
            rejected.push(`${target.id}:${probe.kind}:${probe.score}`);
            session.close();
          }
        } catch (error) {
          session?.close();
          lastError = error;
        }
      }
      if (connected.length) return connected.sort((left, right) => right.probe.score - left.probe.score);
      lastSummary = rejected.length ? rejected.join(", ") : `${targets.length} valid page target(s)`;
      lastError = new Error("No page matched the Trae renderer fingerprint");
    } catch (error) {
      lastError = error;
    }
    await sleep(350);
  }
  throw new Error(
    `No verified Trae renderer on 127.0.0.1:${options.port}: ${lastError?.message ?? "timed out"} (${lastSummary})`,
  );
}

async function openIdentityAnchor(options) {
  const identity = await resolveBrowserIdentity(options.port, options.browserId);
  const anchor = await new BrowserIdentityAnchor(identity.webSocketDebuggerUrl).open();
  return { identity, anchor };
}

export async function runProbeTargets(options) {
  const { identity, anchor } = await openIdentityAnchor(options);
  const deadline = Date.now() + options.timeoutMs;
  let targets = [];
  try {
    while (Date.now() < deadline && !targets.length && !anchor.closed) {
      targets = await listPageTargets(options.port, options.targetId);
      if (!targets.length) await sleep(250);
    }
    const results = [];
    for (const target of targets) {
      let session;
      try {
        session = await connectTarget(target, options.port);
        const probe = await probeSession(session, target, Boolean(options.targetId));
        results.push({
          targetId: target.id,
          title: target.title,
          url: target.url,
          probe,
        });
      } catch (error) {
        results.push({ targetId: target.id, title: target.title, url: target.url, error: error.message });
      } finally {
        session?.close();
      }
    }
    const output = {
      mode: "probe",
      port: options.port,
      browserId: identity.browserId,
      product: identity.product,
      pass: results.length > 0,
      matchedTargets: results.filter((item) => item.probe?.matched).length,
      targets: results,
    };
    console.log(JSON.stringify(output, null, 2));
    if (!output.pass) process.exitCode = 2;
    return output;
  } finally {
    anchor.close();
  }
}

export async function runOneShot(options) {
  const loaded = options.mode === "once" ? await loadPayload(options.themeDir)
    : options.mode === "verify" ? await loadTheme(options.themeDir)
      : null;
  const expectedThemeId = loaded?.theme?.id ?? null;
  const payload = loaded?.payload ?? null;
  const { identity, anchor } = await openIdentityAnchor(options);
  let connected = [];
  const results = [];
  let screenshot = null;

  try {
    connected = await connectTraeTargets(options);
    for (const { target, session, probe } of connected) {
      try {
        if (anchor.closed) throw new CdpIdentityMismatchError("Original CDP browser identity closed");
        if (options.reload) {
          await session.send("Page.reload", { ignoreCache: true });
          await sleep(1200);
        }
        if (options.mode === "remove") await removeFromSession(session);
        else if (options.mode === "once") await applyToSession(session, payload);

        const result = options.mode === "remove"
          ? await verifyRemovedSession(session)
          : await waitForVerification(session, options.timeoutMs, expectedThemeId);
        const item = { targetId: target.id, title: target.title, url: target.url, probe, result };
        results.push(item);
        if (options.screenshot && !screenshot) {
          await waitForPaint(session);
          screenshot = await captureScreenshot(session, options.screenshot);
        }
      } finally {
        session.close();
      }
    }
  } finally {
    for (const { session } of connected) session.close();
    anchor.close();
  }

  const output = {
    mode: options.mode,
    version: SKIN_VERSION,
    port: options.port,
    browserId: identity.browserId,
    themeId: expectedThemeId,
    screenshot,
    targets: results,
  };
  console.log(JSON.stringify(output, null, 2));
  const failed = results.length === 0 || results.some((item) =>
    options.mode === "remove" ? item.result !== true : !item.result?.pass);
  if (failed) process.exitCode = 2;
  return output;
}

export async function runWatch(options) {
  const loaded = await loadPayload(options.themeDir);
  const { identity, anchor } = await openIdentityAnchor(options);
  const sessions = new Map();
  const failures = new Map();
  let stopping = false;
  let listFailureCount = 0;
  let lastListLogAt = 0;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const rejectTarget = (target, baseDelayMs, error = null) => {
    const previous = failures.get(target.id) ?? { count: 0, lastLogAt: 0 };
    const count = previous.count + 1;
    const delayMs = Math.min(30000, baseDelayMs * (2 ** Math.min(count - 1, 4)));
    const now = Date.now();
    if (error && (count === 1 || now - previous.lastLogAt >= 30000)) {
      console.error(`[trae-skin] target ${target.id}: ${error.message}; retrying in ${delayMs}ms`);
      previous.lastLogAt = now;
    }
    failures.set(target.id, { count, lastLogAt: previous.lastLogAt, until: now + delayMs });
  };

  console.log(`[trae-skin] watching Trae browser ${identity.browserId} on 127.0.0.1:${options.port}`);
  try {
    while (!stopping) {
      if (anchor.closed) {
        console.error("[trae-skin] original CDP browser closed; watcher is stopping");
        process.exitCode = 3;
        break;
      }
      let targets;
      try {
        targets = await listPageTargets(options.port, options.targetId);
        listFailureCount = 0;
      } catch (error) {
        listFailureCount += 1;
        const delayMs = Math.min(10000, 750 * (2 ** Math.min(listFailureCount - 1, 4)));
        if (listFailureCount === 1 || Date.now() - lastListLogAt >= 30000) {
          console.error(`[trae-skin] ${error.message}; retrying in ${delayMs}ms`);
          lastListLogAt = Date.now();
        }
        await sleep(delayMs);
        continue;
      }

      const activeIds = new Set(targets.map((target) => target.id));
      for (const id of failures.keys()) if (!activeIds.has(id)) failures.delete(id);
      for (const [id, entry] of sessions) {
        if (!activeIds.has(id) || entry.session.closed) {
          entry.session.close();
          sessions.delete(id);
          failures.delete(id);
        }
      }

      for (const target of targets) {
        if (anchor.closed || sessions.has(target.id)) continue;
        if ((failures.get(target.id)?.until ?? 0) > Date.now()) continue;
        let session;
        try {
          session = await connectTarget(target, options.port);
          const probe = await probeSession(session, target, Boolean(options.targetId));
          if (!probe.matched) {
            session.close();
            rejectTarget(target, 5000);
            continue;
          }
          if (options.reload) {
            await session.send("Page.reload", { ignoreCache: true });
            await sleep(1200);
          }
          await applyToSession(session, loaded.payload);
          const entry = { session, target, probe, lastReinjectLogAt: 0 };
          sessions.set(target.id, entry);
          failures.delete(target.id);
          session.on("Page.loadEventFired", () => {
            setTimeout(async () => {
              try {
                const currentProbe = await probeSession(session, target, Boolean(options.targetId));
                if (!currentProbe.matched) {
                  await removeFromSession(session).catch(() => {});
                  session.close();
                  sessions.delete(target.id);
                  return;
                }
                await applyToSession(session, loaded.payload);
                entry.probe = currentProbe;
              } catch (error) {
                if (Date.now() - entry.lastReinjectLogAt >= 30000) {
                  console.error(`[trae-skin] reinject failed for ${target.id}: ${error.message}`);
                  entry.lastReinjectLogAt = Date.now();
                }
              }
            }, 350);
          });
          console.log(`[trae-skin] injected ${probe.kind} target ${target.id} (${target.title || target.url})`);
        } catch (error) {
          session?.close();
          if (anchor.closed || error instanceof CdpIdentityMismatchError) break;
          rejectTarget(target, 2000, error);
        }
      }
      await sleep(900);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await Promise.allSettled([...sessions.values()].map(({ session }) => removeFromSession(session)));
    for (const { session } of sessions.values()) session.close();
    anchor.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.mode === "check") {
    const loaded = await loadPayload(options.themeDir);
    const output = {
      pass: true,
      version: SKIN_VERSION,
      themeId: loaded.theme.id,
      themeName: loaded.theme.name,
      imageBytes: loaded.imageBytes,
      cssBytes: loaded.cssBytes,
      payloadBytes: loaded.payloadBytes,
      cssPath: loaded.cssPath,
    };
    console.log(JSON.stringify(output, null, 2));
    return output;
  }
  if (options.mode === "probe") return runProbeTargets(options);
  if (options.mode === "watch") return runWatch(options);
  return runOneShot(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  main().catch((error) => {
    console.error(`[trae-skin] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
