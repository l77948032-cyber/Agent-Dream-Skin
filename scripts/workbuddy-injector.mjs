import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CdpIdentityMismatchError,
  CdpSession,
  captureScreenshot,
  listPageTargets,
  resolveBrowserIdentity,
  validatedDebuggerUrl,
} from "./injector.mjs";
import { loadTheme, readSizedFile } from "../src/core/theme-loader.mjs";
import { MAX_CONFIG_BYTES, MAX_CSS_BYTES } from "../src/core/theme-model.mjs";

const filename = fileURLToPath(import.meta.url);
const scriptRoot = path.dirname(filename);
const projectRoot = path.resolve(scriptRoot, "..");

export const WORKBUDDY_SKIN_VERSION = "0.4.1";
export const WORKBUDDY_DEFAULT_PORT = 9432;
export const WORKBUDDY_DEFAULT_THEME_DIR = path.join(
  projectRoot,
  "plugins",
  "workbuddy",
  "catalog",
  "paper-garden",
);
export const WORKBUDDY_DEFAULT_CSS_PATH = path.join(
  projectRoot,
  "plugins",
  "workbuddy",
  "assets",
  "workbuddy-skin.css",
);
export const WORKBUDDY_DEFAULT_TEMPLATE_PATH = path.join(
  projectRoot,
  "assets",
  "workbuddy-renderer-inject.js",
);
export const WORKBUDDY_DEFAULT_REGISTRY_PATH = path.join(
  projectRoot,
  "plugins",
  "workbuddy",
  "resources",
  "components.v1.json",
);

const ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;
const WORKBUDDY_VARIABLES = Object.freeze([
  "--dreamskin-art",
  "--dreamskin-bg",
  "--dreamskin-panel",
  "--dreamskin-panel-alt",
  "--dreamskin-accent",
  "--dreamskin-accent-alt",
  "--dreamskin-secondary",
  "--dreamskin-highlight",
  "--dreamskin-on-accent",
  "--dreamskin-success",
  "--dreamskin-warning",
  "--dreamskin-danger",
  "--dreamskin-info",
  "--dreamskin-disabled",
  "--dreamskin-text",
  "--dreamskin-muted",
  "--dreamskin-line",
  "--dreamskin-selection",
  "--dreamskin-terminal",
  "--dreamskin-hover",
  "--dreamskin-active",
  "--dreamskin-focus",
  "--dreamskin-tooltip-bg",
  "--dreamskin-tooltip-text",
  "--dreamskin-art-position",
  "--dreamskin-art-size",
  "--dreamskin-art-opacity",
  "--dreamskin-art-blend",
  "--dreamskin-overlay",
  "--dreamskin-blur",
  "--dreamskin-radius",
  "--dreamskin-saturation",
  "--dreamskin-surface-opacity",
  "--dreamskin-sidebar-opacity",
  "--dreamskin-color-scheme",
]);
const WORKBUDDY_ATTRIBUTES = Object.freeze([
  "data-workbuddy-dream-skin",
  "data-workbuddy-skin-theme",
  "data-workbuddy-skin-version",
  "data-workbuddy-host-version",
  "data-workbuddy-skin-compat",
  "data-workbuddy-skin-route",
  "data-workbuddy-skin-treatment",
  "data-workbuddy-skin-motif",
  "data-workbuddy-skin-icon-treatment",
  "data-workbuddy-skin-surface-treatment",
  "data-workbuddy-skin-card-treatment",
  "data-workbuddy-skin-ornament",
  "data-workbuddy-skin-accent-placement",
]);

function argumentValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseWorkBuddyArgs(argv) {
  const options = {
    port: WORKBUDDY_DEFAULT_PORT,
    mode: "watch",
    timeoutMs: 30_000,
    screenshot: null,
    themeDir: WORKBUDDY_DEFAULT_THEME_DIR,
    cssPath: WORKBUDDY_DEFAULT_CSS_PATH,
    templatePath: WORKBUDDY_DEFAULT_TEMPLATE_PATH,
    registryPath: WORKBUDDY_DEFAULT_REGISTRY_PATH,
    browserId: null,
    targetId: null,
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
    else if (arg === "--css-path") options.cssPath = path.resolve(argumentValue(argv, index++, arg));
    else if (arg === "--template-path") options.templatePath = path.resolve(argumentValue(argv, index++, arg));
    else if (arg === "--registry-path") options.registryPath = path.resolve(argumentValue(argv, index++, arg));
    else if (arg === "--browser-id") options.browserId = argumentValue(argv, index++, arg);
    else if (arg === "--target-id") options.targetId = argumentValue(argv, index++, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 250 || options.timeoutMs > 120_000) {
    throw new Error(`Invalid timeout: ${options.timeoutMs}`);
  }
  for (const [label, value] of [["browser", options.browserId], ["target", options.targetId]]) {
    if (value !== null && !ID_PATTERN.test(value)) throw new Error(`Invalid ${label} ID: ${value}`);
  }
  return options;
}

export function isPlausibleWorkBuddyRendererTarget(target) {
  if (target?.type !== "page" || typeof target.url !== "string") return false;
  try {
    const url = new URL(target.url);
    const rendererPath = decodeURIComponent(url.pathname);
    return url.protocol === "file:"
      && /\/Contents\/Resources\/app\.asar\/renderer\/index\.html$/i.test(rendererPath)
      && /workbuddy/i.test(`${target.title || ""} ${rendererPath}`);
  } catch {
    return false;
  }
}

const WORKBUDDY_PROBE_EXPRESSION = String.raw`(() => {
  const select = (selector) => {
    try { return document.querySelector(selector); } catch { return null; }
  };
  const selectAll = (selector) => {
    try { return document.querySelectorAll(selector); } catch { return []; }
  };
  const body = document.body;
  const bodyRect = body?.getBoundingClientRect?.();
  const classSamples = [];
  const seen = new Set();
  for (const node of [...selectAll('[class]')].slice(0, 400)) {
    for (const token of String(node.className || '').split(/\s+/)) {
      if (!token || token.length > 100 || seen.has(token)) continue;
      seen.add(token);
      classSamples.push(token);
      if (classSamples.length >= 80) break;
    }
    if (classSamples.length >= 80) break;
  }
  return {
    title: String(document.title || '').slice(0, 200),
    href: String(location.href || '').slice(0, 600),
    userAgent: String(navigator.userAgent || '').slice(0, 400),
    viewport: { width: innerWidth, height: innerHeight },
    markers: {
      body: Boolean(body),
      root: Boolean(select('#root')),
      teamsContainer: Boolean(select('.teams-container')),
      conversationSidebar: Boolean(select('.conversation-sidebar')),
      contentWrapper: Boolean(select('.teams-content-wrapper')),
      mainContent: Boolean(select('.teams-main-content, .main-content')),
      topbar: Boolean(select('.workbuddy-topbar')),
      home: Boolean(select('.wb-home-page')),
      composer: Boolean(select('.wb-home-composer, .wb-input-footer')),
      chat: Boolean(select('.chat-container')),
      detailPanel: Boolean(select('.detail-panel-container')),
      interactiveCount: selectAll('button, input, textarea, select, [contenteditable="true"], [role="button"], [role="textbox"]').length,
      rootChildCount: select('#root')?.childElementCount || 0,
      bodyTextLength: String(body?.innerText || '').length,
      bodyWidth: Math.round(bodyRect?.width || 0),
      bodyHeight: Math.round(bodyRect?.height || 0),
    },
    samples: { classes: classSamples },
  };
})()`;

export function classifyWorkBuddyProbe(rawProbe, target = {}) {
  const raw = rawProbe && typeof rawProbe === "object" ? rawProbe : {};
  const markers = raw.markers && typeof raw.markers === "object" ? raw.markers : {};
  const trustedRendererUrl = isPlausibleWorkBuddyRendererTarget(target);
  const viewportWidth = Number(raw.viewport?.width ?? markers.bodyWidth ?? 0);
  const viewportHeight = Number(raw.viewport?.height ?? markers.bodyHeight ?? 0);
  const largeSurface = viewportWidth >= 500 && viewportHeight >= 320;
  const shellStructure = Boolean(markers.root)
    && Boolean(markers.teamsContainer)
    && Boolean(markers.conversationSidebar)
    && Boolean(markers.contentWrapper)
    && Boolean(markers.mainContent)
    && Number(markers.rootChildCount) >= 1
    && Number(markers.interactiveCount) >= 2
    && largeSurface;
  let score = 0;
  if (trustedRendererUrl) score += 8;
  if (markers.root) score += 2;
  if (markers.teamsContainer) score += 5;
  if (markers.conversationSidebar) score += 3;
  if (markers.contentWrapper) score += 3;
  if (markers.mainContent) score += 2;
  if (markers.topbar) score += 1;
  if (markers.home || markers.composer || markers.chat) score += 2;
  if (largeSurface) score += 1;
  return {
    ...raw,
    matched: trustedRendererUrl && shellStructure,
    kind: shellStructure ? "workbuddy-workspace" : "unknown",
    trustedRendererUrl,
    substantial: largeSurface && Boolean(markers.root) && Boolean(markers.teamsContainer),
    score,
  };
}

export async function probeWorkBuddySession(session, target = {}) {
  return classifyWorkBuddyProbe(await session.evaluate(WORKBUDDY_PROBE_EXPRESSION), target);
}

export async function loadWorkBuddyPayload({
  themeDir = WORKBUDDY_DEFAULT_THEME_DIR,
  cssPath = WORKBUDDY_DEFAULT_CSS_PATH,
  templatePath = WORKBUDDY_DEFAULT_TEMPLATE_PATH,
  registryPath = WORKBUDDY_DEFAULT_REGISTRY_PATH,
} = {}) {
  const [loaded, cssBuffer, templateBuffer, registryBuffer] = await Promise.all([
    loadTheme(themeDir),
    readSizedFile(cssPath, MAX_CSS_BYTES, "WorkBuddy skin CSS"),
    readSizedFile(templatePath, MAX_CSS_BYTES, "WorkBuddy renderer template"),
    readSizedFile(registryPath, MAX_CONFIG_BYTES, "WorkBuddy component registry"),
  ]);
  const css = cssBuffer.toString("utf8");
  const componentRegistry = JSON.parse(registryBuffer.toString("utf8"));
  if (!Array.isArray(componentRegistry?.components) || componentRegistry.components.length === 0) {
    throw new Error("WorkBuddy component registry must declare components");
  }
  const artDataUrl = `data:${loaded.mime};base64,${loaded.image.toString("base64")}`;
  const payload = templateBuffer.toString("utf8")
    .replaceAll("__WORKBUDDY_SKIN_CSS_JSON__", JSON.stringify(css))
    .replaceAll("__WORKBUDDY_SKIN_ART_JSON__", JSON.stringify(artDataUrl))
    .replaceAll("__WORKBUDDY_SKIN_THEME_JSON__", JSON.stringify(loaded.theme))
    .replaceAll("__WORKBUDDY_SKIN_COMPONENT_REGISTRY_JSON__", JSON.stringify(componentRegistry))
    .replaceAll("__WORKBUDDY_SKIN_VERSION_JSON__", JSON.stringify(WORKBUDDY_SKIN_VERSION));
  if (/__WORKBUDDY_SKIN_(?:CSS|ART|THEME|COMPONENT_REGISTRY|VERSION)_JSON__/.test(payload)) {
    throw new Error("WorkBuddy renderer payload contains an unresolved placeholder");
  }
  return {
    payload,
    theme: loaded.theme,
    imageBytes: loaded.image.length,
    cssBytes: cssBuffer.length,
    payloadBytes: Buffer.byteLength(payload),
    cssPath: path.resolve(cssPath),
    templatePath: path.resolve(templatePath),
    registryPath: path.resolve(registryPath),
  };
}

export function applyWorkBuddySession(session, payload) {
  return session.evaluate(payload);
}

export function removeWorkBuddySession(session) {
  return session.evaluate(`(() => {
    window.__WORKBUDDY_DREAM_SKIN_DISABLED__ = true;
    const state = window.__WORKBUDDY_DREAM_SKIN_STATE__;
    if (typeof state?.cleanup === 'function') return state.cleanup();
    const root = document.documentElement;
    root?.classList.remove('workbuddy-dream-skin');
    document.body?.classList.remove('workbuddy-dream-skin-body');
    for (const name of ${JSON.stringify(WORKBUDDY_VARIABLES)}) root?.style.removeProperty(name);
    for (const attribute of ${JSON.stringify(WORKBUDDY_ATTRIBUTES)}) root?.removeAttribute(attribute);
    document.querySelectorAll('[data-workbuddy-skin-component]').forEach((node) =>
      node.removeAttribute('data-workbuddy-skin-component'));
    document.querySelectorAll('[data-workbuddy-skin-runtime-role]').forEach((node) =>
      node.removeAttribute('data-workbuddy-skin-runtime-role'));
    document.getElementById('workbuddy-dream-skin-style')?.remove();
    delete window.__WORKBUDDY_DREAM_SKIN_STATE__;
    return true;
  })()`);
}

export function verifyWorkBuddyRemovedSession(session) {
  return session.evaluate(`(() => {
    const root = document.documentElement;
    return !root?.classList.contains('workbuddy-dream-skin') &&
      !document.body?.classList.contains('workbuddy-dream-skin-body') &&
      ${JSON.stringify(WORKBUDDY_ATTRIBUTES)}.every((name) => !root?.hasAttribute(name)) &&
      ${JSON.stringify(WORKBUDDY_VARIABLES)}.every((name) => !root?.style.getPropertyValue(name)) &&
      !document.querySelector('[data-workbuddy-skin-component]') &&
      !document.querySelector('[data-workbuddy-skin-runtime-role]') &&
      !document.getElementById('workbuddy-dream-skin-style') &&
      !window.__WORKBUDDY_DREAM_SKIN_STATE__;
  })()`);
}

export function verifyWorkBuddySession(session, expectedThemeId = null) {
  return session.evaluate(`(() => {
    const root = document.documentElement;
    const body = document.body;
    const state = window.__WORKBUDDY_DREAM_SKIN_STATE__;
    const style = document.getElementById('workbuddy-dream-skin-style');
    const shell = document.querySelector('.teams-container');
    const sidebar = document.querySelector('.conversation-sidebar');
    const content = document.querySelector('.teams-content-wrapper');
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
    const result = {
      installed: Boolean(root?.classList.contains('workbuddy-dream-skin')),
      bodyInstalled: Boolean(body?.classList.contains('workbuddy-dream-skin-body')),
      version: state?.version ?? null,
      expectedVersion: ${JSON.stringify(WORKBUDDY_SKIN_VERSION)},
      themeId: state?.themeId ?? root?.getAttribute('data-workbuddy-skin-theme') ?? null,
      expectedThemeId: ${JSON.stringify(expectedThemeId)},
      compatibility: root?.getAttribute('data-workbuddy-skin-compat') ?? null,
      hostVersion: state?.hostVersion ?? root?.getAttribute('data-workbuddy-host-version') ?? null,
      route: root?.getAttribute('data-workbuddy-skin-route') ?? null,
      stylePresent: Boolean(style?.textContent?.length),
      artPresent: Boolean(root?.style.getPropertyValue('--dreamskin-art')),
      tokensPresent: ['--dreamskin-bg', '--dreamskin-panel', '--dreamskin-accent', '--dreamskin-text',
        '--dreamskin-focus'].every((name) => Boolean(root?.style.getPropertyValue(name))),
      cleanupAvailable: typeof state?.cleanup === 'function',
      ensureAvailable: typeof state?.ensure === 'function',
      semanticComponentCount: document.querySelectorAll('[data-workbuddy-skin-component]').length,
      interactiveCount: document.querySelectorAll(
        'button, input, textarea, select, [contenteditable="true"], [role="button"], [role="textbox"]'
      ).length,
      viewport: { width: innerWidth, height: innerHeight },
      shell: box(shell),
      sidebar: box(sidebar),
      content: box(content),
    };
    result.pass = result.installed && result.bodyInstalled &&
      result.version === result.expectedVersion &&
      (!result.expectedThemeId || result.themeId === result.expectedThemeId) &&
      result.stylePresent && result.artPresent && result.tokensPresent &&
      result.cleanupAvailable && result.ensureAvailable &&
      result.semanticComponentCount >= 3 && result.interactiveCount >= 2 &&
      result.viewport.width >= 500 && result.viewport.height >= 320 &&
      result.shell?.visible && result.sidebar?.visible && result.content?.visible &&
      result.shell.pointerEvents !== 'none' && result.content.pointerEvents !== 'none';
    return result;
  })()`);
}

class BrowserIdentityAnchor {
  constructor(url, WebSocketCtor = globalThis.WebSocket) {
    if (typeof WebSocketCtor !== "function") throw new Error("This runtime does not expose WebSocket");
    this.ws = new WebSocketCtor(url);
    this.closed = false;
    this.ws.addEventListener("close", () => { this.closed = true; });
    this.ws.addEventListener("error", () => { this.closed = true; });
  }

  async open() {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("CDP identity anchor timed out")), 5000);
      this.ws.addEventListener("open", () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("CDP identity anchor failed"));
      }, { once: true });
    });
    return this;
  }

  close() {
    if (!this.closed) {
      try { this.ws.close(); } catch {}
    }
    this.closed = true;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function openIdentityAnchor(options) {
  const identity = await resolveBrowserIdentity(options.port, options.browserId);
  const anchorUrl = validatedDebuggerUrl({ webSocketDebuggerUrl: identity.webSocketDebuggerUrl }, options.port, "browser");
  return { identity, anchor: await new BrowserIdentityAnchor(anchorUrl).open() };
}

async function connectTarget(target, port) {
  return new CdpSession(target, port).open();
}

export async function connectWorkBuddyTargets(options) {
  const deadline = Date.now() + options.timeoutMs;
  let lastError = new Error("No WorkBuddy page target was available");
  let lastSummary = "no targets";
  while (Date.now() < deadline) {
    const connected = [];
    const rejected = [];
    try {
      const targets = await listPageTargets(options.port, options.targetId);
      for (const target of targets) {
        let session;
        try {
          if (!isPlausibleWorkBuddyRendererTarget(target)) {
            rejected.push(`${target.id}:url`);
            continue;
          }
          session = await connectTarget(target, options.port);
          const probe = await probeWorkBuddySession(session, target);
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
      lastError = new Error("No page matched the WorkBuddy renderer fingerprint");
    } catch (error) {
      lastError = error;
    }
    await sleep(350);
  }
  throw new Error(
    `No verified WorkBuddy renderer on 127.0.0.1:${options.port}: ${lastError.message} (${lastSummary})`,
  );
}

async function waitForVerification(session, timeoutMs, expectedThemeId) {
  const deadline = Date.now() + timeoutMs;
  let result = null;
  while (Date.now() < deadline) {
    result = await verifyWorkBuddySession(session, expectedThemeId);
    if (result?.pass) return result;
    await sleep(200);
  }
  return result;
}

export async function runWorkBuddyProbe(options) {
  const { identity, anchor } = await openIdentityAnchor(options);
  const results = [];
  try {
    for (const target of await listPageTargets(options.port, options.targetId)) {
      let session;
      try {
        session = await connectTarget(target, options.port);
        results.push({
          targetId: target.id,
          title: target.title,
          url: target.url,
          probe: await probeWorkBuddySession(session, target),
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
      pass: results.some((item) => item.probe?.matched),
      targets: results,
    };
    console.log(JSON.stringify(output, null, 2));
    if (!output.pass) process.exitCode = 2;
    return output;
  } finally {
    anchor.close();
  }
}

export async function runWorkBuddyOneShot(options) {
  const loaded = options.mode === "once" || options.mode === "verify"
    ? await loadWorkBuddyPayload(options)
    : null;
  const expectedThemeId = loaded?.theme?.id ?? null;
  const { identity, anchor } = await openIdentityAnchor(options);
  let connected = [];
  const results = [];
  let screenshot = null;
  try {
    connected = await connectWorkBuddyTargets(options);
    for (const { target, session, probe } of connected) {
      try {
        if (anchor.closed) throw new CdpIdentityMismatchError("Original CDP browser identity closed");
        if (options.mode === "remove") await removeWorkBuddySession(session);
        else if (options.mode === "once") await applyWorkBuddySession(session, loaded.payload);
        const result = options.mode === "remove"
          ? await verifyWorkBuddyRemovedSession(session)
          : await waitForVerification(session, options.timeoutMs, expectedThemeId);
        results.push({ targetId: target.id, title: target.title, url: target.url, probe, result });
        if (options.screenshot && !screenshot) {
          await sleep(350);
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
  const pass = workBuddyOneShotPass(results, options.mode);
  const output = {
    mode: options.mode,
    version: WORKBUDDY_SKIN_VERSION,
    pass,
    port: options.port,
    browserId: identity.browserId,
    themeId: expectedThemeId,
    screenshot,
    targets: results,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!pass) process.exitCode = 2;
  return output;
}

export function workBuddyOneShotPass(results, mode) {
  return Array.isArray(results)
    && results.length > 0
    && results.every((item) => mode === "remove" ? item?.result === true : item?.result?.pass === true);
}

export async function runWorkBuddyWatch(options) {
  const loaded = await loadWorkBuddyPayload(options);
  const { identity, anchor } = await openIdentityAnchor(options);
  const sessions = new Map();
  const failures = new Map();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(`[workbuddy-skin] watching browser ${identity.browserId} on 127.0.0.1:${options.port}`);
  try {
    while (!stopping) {
      if (anchor.closed) {
        console.error("[workbuddy-skin] original CDP browser closed; watcher is stopping");
        process.exitCode = 3;
        break;
      }
      let targets = [];
      try {
        targets = await listPageTargets(options.port, options.targetId);
      } catch (error) {
        console.error(`[workbuddy-skin] ${error.message}; retrying`);
        await sleep(1500);
        continue;
      }
      const activeIds = new Set(targets.map((target) => target.id));
      for (const [id, entry] of sessions) {
        if (!activeIds.has(id) || entry.session.closed) {
          entry.session.close();
          sessions.delete(id);
          failures.delete(id);
        }
      }
      for (const target of targets) {
        if (sessions.has(target.id) || !isPlausibleWorkBuddyRendererTarget(target)) continue;
        if ((failures.get(target.id) ?? 0) > Date.now()) continue;
        let session;
        try {
          session = await connectTarget(target, options.port);
          const probe = await probeWorkBuddySession(session, target);
          if (!probe.matched) throw new Error("renderer fingerprint did not match");
          await applyWorkBuddySession(session, loaded.payload);
          const entry = { session, target, probe };
          sessions.set(target.id, entry);
          failures.delete(target.id);
          session.on("Page.loadEventFired", () => {
            setTimeout(async () => {
              try {
                const currentProbe = await probeWorkBuddySession(session, target);
                if (!currentProbe.matched) throw new Error("renderer fingerprint changed");
                await applyWorkBuddySession(session, loaded.payload);
                entry.probe = currentProbe;
              } catch (error) {
                console.error(`[workbuddy-skin] reinject failed for ${target.id}: ${error.message}`);
                session.close();
                sessions.delete(target.id);
              }
            }, 350);
          });
          console.log(`[workbuddy-skin] injected ${target.id} (${target.title || target.url})`);
        } catch (error) {
          session?.close();
          failures.set(target.id, Date.now() + 5000);
          console.error(`[workbuddy-skin] target ${target.id}: ${error.message}`);
        }
      }
      await sleep(900);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await Promise.allSettled([...sessions.values()].map(({ session }) => removeWorkBuddySession(session)));
    for (const { session } of sessions.values()) session.close();
    anchor.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseWorkBuddyArgs(argv);
  if (options.mode === "check") {
    const loaded = await loadWorkBuddyPayload(options);
    const output = {
      pass: true,
      version: WORKBUDDY_SKIN_VERSION,
      themeId: loaded.theme.id,
      themeName: loaded.theme.name,
      imageBytes: loaded.imageBytes,
      cssBytes: loaded.cssBytes,
      payloadBytes: loaded.payloadBytes,
      cssPath: loaded.cssPath,
      templatePath: loaded.templatePath,
      registryPath: loaded.registryPath,
    };
    console.log(JSON.stringify(output, null, 2));
    return output;
  }
  if (options.mode === "probe") return runWorkBuddyProbe(options);
  if (options.mode === "watch") return runWorkBuddyWatch(options);
  return runWorkBuddyOneShot(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === filename) {
  main().catch((error) => {
    console.error(`[workbuddy-skin] ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}
