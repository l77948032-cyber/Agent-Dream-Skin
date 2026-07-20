import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  browserIdFromVersion,
  captureScreenshot,
  classifyTraeProbe,
  isValidPageTarget,
  isPlausibleTraeRendererTarget,
  loadPayload,
  loadTheme,
  normalizeTheme,
  parseArgs,
  removeFromSession,
  runOneShot,
  validatedDebuggerUrl,
  verifyRemovedSession,
} from "../scripts/injector.mjs";

const PORT = 9342;
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SEMANTIC_COLOR_VARIABLES = Object.freeze({
  onAccent: "--trae-skin-on-accent",
  success: "--trae-skin-success",
  warning: "--trae-skin-warning",
  danger: "--trae-skin-danger",
  info: "--trae-skin-info",
  disabled: "--trae-skin-disabled",
});

function pageTarget(overrides = {}) {
  return {
    id: "ABC123",
    type: "page",
    title: "TRAE Work CN",
    url: "vscode-file://vscode-app/out/vs/code/electron-browser/solo/solo-lite.html",
    webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/ABC123`,
    ...overrides,
  };
}

test("parseArgs accepts the runtime modes and rejects malformed values", () => {
  const options = parseArgs([
    "--once", "--port", "12042", "--timeout-ms", "5000", "--target-id", "ABC-123",
    "--browser-id", "browser-1", "--theme-dir", "./themes/neon-portal", "--reload",
    "--screenshot", "./shot.png", "--owner-token", "0123456789abcdef0123456789abcdef",
  ]);
  assert.equal(options.mode, "once");
  assert.equal(options.port, 12042);
  assert.equal(options.timeoutMs, 5000);
  assert.equal(options.targetId, "ABC-123");
  assert.equal(options.browserId, "browser-1");
  assert.equal(options.ownerToken, "0123456789abcdef0123456789abcdef");
  assert.equal(options.reload, true);
  assert.equal(path.basename(options.screenshot), "shot.png");
  assert.equal(parseArgs(["--probe-targets"]).mode, "probe");
  assert.equal(parseArgs(["--remove"]).mode, "remove");
  assert.throws(() => parseArgs(["--port", "80"]), /Invalid port/);
  assert.throws(() => parseArgs(["--timeout-ms", "200"]), /Invalid timeout/);
  assert.throws(() => parseArgs(["--target-id", "bad/id"]), /Invalid target ID/);
  assert.throws(() => parseArgs(["--owner-token", "short"]), /Invalid owner token/);
  assert.throws(() => parseArgs(["--theme-dir"]), /requires a value/);
  assert.throws(() => parseArgs(["--unknown"]), /Unknown argument/);
});

test("CDP WebSocket validation only accepts the configured loopback endpoint", () => {
  const valid = pageTarget();
  assert.equal(
    validatedDebuggerUrl(valid, PORT, "page"),
    `ws://127.0.0.1:${PORT}/devtools/page/ABC123`,
  );
  assert.equal(isValidPageTarget(valid, PORT), true);
  assert.equal(isValidPageTarget({ ...valid, url: "file:///app/index.html" }, PORT), true);

  const invalidUrls = [
    `ws://example.com:${PORT}/devtools/page/ABC123`,
    `wss://127.0.0.1:${PORT}/devtools/page/ABC123`,
    `ws://127.0.0.1:${PORT + 1}/devtools/page/ABC123`,
    `ws://user@127.0.0.1:${PORT}/devtools/page/ABC123`,
    `ws://127.0.0.1:${PORT}/devtools/page/ABC123?token=x`,
    `ws://127.0.0.1:${PORT}/devtools/page/ABC%20123`,
    `ws://127.0.0.1:${PORT}/unexpected/ABC123`,
  ];
  for (const webSocketDebuggerUrl of invalidUrls) {
    assert.throws(() => validatedDebuggerUrl({ webSocketDebuggerUrl }, PORT, "page"));
  }
  assert.equal(isValidPageTarget({ ...valid, id: "OTHER" }, PORT), false);
  assert.equal(isValidPageTarget({ ...valid, type: "worker" }, PORT), false);
  assert.equal(isValidPageTarget({ ...valid, id: 123 }, PORT), false);
  assert.equal(isValidPageTarget({
    ...valid,
    webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/browser/ABC123`,
  }, PORT), false);
  assert.equal(isPlausibleTraeRendererTarget(valid), true);
  assert.equal(isPlausibleTraeRendererTarget({ ...valid, url: "file:///app/index.html" }), false);
});

test("one-shot failure closes the browser identity anchor", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.closed = false;
      sockets.push(this);
      queueMicrotask(() => this.emit("open", {}));
    }
    addEventListener(name, listener) {
      const listeners = this.listeners.get(name) ?? [];
      listeners.push(listener);
      this.listeners.set(name, listeners);
    }
    emit(name, event) {
      for (const listener of this.listeners.get(name) ?? []) listener(event);
    }
    send() {}
    close() {
      this.closed = true;
      this.emit("close", {});
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url) => ({
    ok: true,
    async text() {
      return String(url).endsWith("/json/version")
        ? JSON.stringify({
          Browser: "Chrome/142",
          webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/browser/test-browser`,
        })
        : "[]";
    },
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  await assert.rejects(() => runOneShot({
    mode: "remove",
    port: PORT,
    timeoutMs: 250,
    screenshot: null,
    reload: false,
    themeDir: path.join(ROOT, "themes", "neon-portal"),
    browserId: "test-browser",
    targetId: null,
  }), /No verified Trae renderer/);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].closed, true);
});

test("browser identity parsing rejects page and malformed debugger URLs", () => {
  assert.equal(browserIdFromVersion({
    webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/browser/browser-123`,
  }, PORT), "browser-123");
  assert.throws(() => browserIdFromVersion({
    webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/page/browser-123`,
  }, PORT));
  assert.throws(() => browserIdFromVersion({
    webSocketDebuggerUrl: `ws://127.0.0.1:${PORT}/devtools/browser/bad?id`,
  }, PORT));
});

test("Trae probe recognizes SOLO Lite and VS Code workbench without accepting a splash page", () => {
  const common = {
    markers: { body: true, bodyWidth: 1440, bodyHeight: 900 },
    viewport: { width: 1440, height: 900 },
    brandSignals: { title: true },
  };
  const solo = classifyTraeProbe({
    ...common,
    markers: {
      ...common.markers,
      appRoot: true,
      soloLiteRoot: true,
      soloLayout: true,
      taskListPanel: true,
      chatPanel: true,
      sessionPanel: true,
      messageInput: true,
      chatTextbox: true,
      interactiveCount: 8,
    },
  }, pageTarget());
  assert.equal(solo.matched, true);
  assert.equal(solo.kind, "trae-solo-lite");

  const soloHome = classifyTraeProbe({
    ...common,
    markers: {
      ...common.markers,
      appRoot: true,
      soloLiteRoot: true,
      initialPanel: true,
      messageInput: true,
      chatTextbox: true,
      interactiveCount: 8,
    },
  }, pageTarget());
  assert.equal(soloHome.matched, true);
  assert.equal(soloHome.kind, "trae-solo-lite");

  const workbench = classifyTraeProbe({
    ...common,
    markers: {
      ...common.markers,
      monacoWorkbench: true,
      workbenchPartCount: 5,
      monacoEditorCount: 1,
    },
  }, pageTarget({ title: "TRAE IDE" }));
  assert.equal(workbench.matched, true);
  assert.equal(workbench.kind, "vscode-workbench");

  const splash = classifyTraeProbe({
    ...common,
    markers: { ...common.markers, appRoot: true, rootChildCount: 1, interactiveCount: 0 },
  }, pageTarget({ title: "TRAE" }));
  assert.equal(splash.matched, false);

  const explicit = classifyTraeProbe({
    ...common,
    brandSignals: {},
    markers: {
      ...common.markers,
      appRoot: true,
      rootChildCount: 1,
      interactiveCount: 1,
      bodyTextLength: 50,
    },
  }, pageTarget({ title: "Unknown", url: "file:///app.html" }), true);
  assert.equal(explicit.matched, true);
  assert.equal(explicit.kind, "explicit-trae-renderer");
});

test("theme normalization preserves supported values and rejects executable CSS values", () => {
  const theme = normalizeTheme({
    schemaVersion: 1,
    id: "test-theme",
    name: "Test Theme",
    image: "background.png",
    colors: {
      background: "#102030",
      accent: "rgb(10, 20, 30)",
      onAccent: "#fff",
      success: "hsl(170 60% 40%)",
      warning: "#d19a32",
      danger: "rgba(210, 60, 80, 0.9)",
      info: "#4a90d9",
      disabled: "url(file:///secret)",
      selection: "rgba(10, 20, 30, 0.2)",
      terminal: "#010203",
      panel: "url(file:///secret)",
    },
    appearance: {
      treatment: "ember-vignette",
      backgroundPosition: "76% center",
      backgroundSize: "cover",
      backgroundOpacity: 0.48,
      surfaceOpacity: 0.91,
      sidebarOpacity: 0.95,
      blur: "12px",
      saturation: 1.05,
      radius: 5,
      shadow: "deep",
      colorScheme: "dark",
    },
  }, "fixture.json");
  assert.equal(theme.colors.background, "#102030");
  assert.equal(theme.colors.panel, "rgba(17, 24, 39, 0.88)");
  assert.equal(theme.colors.selection, "rgba(10, 20, 30, 0.2)");
  assert.equal(theme.colors.onAccent, "#fff");
  assert.equal(theme.colors.success, "hsl(170 60% 40%)");
  assert.equal(theme.colors.warning, "#d19a32");
  assert.equal(theme.colors.danger, "rgba(210, 60, 80, 0.9)");
  assert.equal(theme.colors.info, "#4a90d9");
  assert.equal(theme.colors.disabled, "#718096");
  assert.equal(theme.appearance.treatment, "ember-vignette");
  assert.equal(theme.appearance.backgroundPosition, "76% center");
  assert.equal(theme.appearance.blur, 12);
  assert.equal(theme.appearance.shadow, "deep");

  const studio = normalizeTheme({
    schemaVersion: 1,
    id: "studio",
    image: "background.png",
    layout: "studio-collage",
    appearance: { treatment: "spark-collage" },
  });
  assert.equal(studio.layout, "studio-collage");
  assert.equal(studio.appearance.treatment, "spark-collage");

  const unsafe = normalizeTheme({
    schemaVersion: 1,
    id: "safe-id",
    image: "background.png",
    appearance: {
      backgroundPosition: "center; color: red",
      shadow: "url(file:///secret)",
      treatment: "custom-script",
    },
  });
  assert.equal(unsafe.appearance.backgroundPosition, "center center");
  assert.equal(unsafe.appearance.shadow, "soft");
  assert.equal(unsafe.appearance.treatment, "midnight-neon");
  assert.throws(() => normalizeTheme({ schemaVersion: 2, id: "x", image: "x.png" }), /schemaVersion/);
  assert.throws(() => normalizeTheme({ schemaVersion: 1, id: "../x", image: "x.png" }), /theme id/);
  assert.throws(() => normalizeTheme({ schemaVersion: 1, id: "x", image: "../x.png" }), /theme directory/);
});

test("all bundled themes build complete renderer payloads", async () => {
  for (const id of [
    "neon-portal",
    "ember-glass",
    "paper-aurora",
    "spark-atelier",
    "sunlit-spark",
    "violet-rift",
  ]) {
    const loaded = await loadPayload(path.join(ROOT, "themes", id));
    const rawTheme = JSON.parse(await fs.readFile(
      path.join(ROOT, "themes", id, "theme.json"), "utf8"));
    assert.equal(loaded.theme.id, id);
    for (const [colorName, variableName] of Object.entries(SEMANTIC_COLOR_VARIABLES)) {
      assert.equal(loaded.theme.colors[colorName], rawTheme.colors[colorName]);
      assert.ok(loaded.payload.includes(variableName));
    }
    assert.ok(loaded.imageBytes > 100);
    assert.ok(loaded.cssBytes > 1000);
    assert.ok(loaded.payloadBytes > loaded.imageBytes);
    assert.doesNotMatch(loaded.payload, /__TRAE_SKIN_(?:CSS|ART|THEME|RUNTIME_MAP|COMPONENT_REGISTRY|VERSION)_JSON__/);
    assert.match(loaded.payload, /__TRAE_DREAM_SKIN_STATE__/);
    assert.match(loaded.payload, new RegExp(`\\"id\\":\\"${id}\\"`));
  }
});

test("theme loader honors a local skin.css and verifies image signatures", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "trae-skin-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.writeFile(path.join(temporary, "theme.json"), JSON.stringify({
    schemaVersion: 1,
    id: "fixture",
    name: "Fixture",
    layout: "studio-collage",
    brandSubtitle: "FIXTURE STUDIO",
    tagline: "MAKE THE IDEA REAL",
    statusText: "FLOW 100%",
    quote: "SPARK / SHAPE / SHIP",
    image: "background.png",
  }));
  await fs.writeFile(path.join(temporary, "background.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await fs.writeFile(path.join(temporary, "skin.css"), ":root.trae-dream-skin { color: red; }");
  const loaded = await loadTheme(temporary);
  assert.equal(path.basename(loaded.cssPath), "skin.css");
  assert.match(loaded.css, /color: red/);

  await fs.writeFile(path.join(temporary, "background.png"), "not a png");
  await assert.rejects(() => loadTheme(temporary), /does not match/);
});

test("screenshot capture validates and writes PNG data", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "trae-screenshot-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const outputPath = path.join(temporary, "nested", "shot.png");
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const result = await captureScreenshot({
    send: async () => ({ data: png.toString("base64") }),
  }, outputPath);
  assert.equal(result.bytes, png.length);
  assert.deepEqual(await fs.readFile(outputPath), png);
});

class FakeStyle {
  values = new Map();
  setProperty(name, value) { this.values.set(name, String(value)); }
  removeProperty(name) { this.values.delete(name); }
  getPropertyValue(name) { return this.values.get(name) ?? ""; }
}

class FakeClassList {
  values = new Set();
  add(...names) { for (const name of names) this.values.add(name); }
  remove(...names) { for (const name of names) this.values.delete(name); }
  contains(name) { return this.values.has(name); }
  toString() { return [...this.values].join(" "); }
}

function selectorMatches(node, selector) {
  let remaining = selector.trim();
  const attributes = [...remaining.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
  remaining = remaining.replace(/\[[^\]]+\]/g, "");
  for (const match of attributes) {
    if (!node.hasAttribute(match[1])) return false;
    if (match[2] !== undefined && node.getAttribute(match[1]) !== match[2]) return false;
  }
  const id = remaining.match(/#([A-Za-z0-9_-]+)/)?.[1];
  if (id && node.id !== id) return false;
  for (const className of [...remaining.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((match) => match[1])) {
    if (!node.classList.contains(className)) return false;
  }
  const tag = remaining.replace(/[#.][A-Za-z0-9_-]+/g, "").trim();
  return !tag || tag.toLowerCase() === node.tagName.toLowerCase();
}

class FakeNode {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.id = "";
    this.classList = new FakeClassList();
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.textContent = "";
    this.scrollWidth = 1200;
    this.clientWidth = 1200;
  }
  get className() { return this.classList.toString(); }
  get childElementCount() { return this.children.length; }
  appendChild(node) {
    node.parentElement = this;
    this.children.push(node);
    if (!this.ownerDocument.nodes.includes(node)) this.ownerDocument.nodes.push(node);
    return node;
  }
  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((node) => node !== this);
    }
    this.parentElement = null;
    this.ownerDocument.nodes = this.ownerDocument.nodes.filter((node) => node !== this);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  getBoundingClientRect() { return { x: 0, y: 0, width: 1200, height: 800 }; }
}

class FakeDocument {
  constructor() {
    this.nodes = [];
    this.documentElement = new FakeNode("html", this);
    this.head = new FakeNode("head", this);
    this.body = new FakeNode("body", this);
    this.nodes.push(this.documentElement, this.head, this.body);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.body.classList.add("solo-lite", "vs-dark", "mac");
  }
  createElement(tagName) { return new FakeNode(tagName, this); }
  getElementById(id) { return this.nodes.find((node) => node.id === id) ?? null; }
  querySelectorAll(selector) {
    const selectors = selector.split(",").map((part) => part.trim()).filter(Boolean);
    return this.nodes.filter((node) => selectors.some((part) => selectorMatches(node, part)));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function addNode(document, parent, { id = "", classes = [], attributes = {} }) {
  const node = document.createElement("div");
  node.id = id;
  node.classList.add(...classes);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  parent.appendChild(node);
  return node;
}

function createRendererContext() {
  const document = new FakeDocument();
  const appRoot = addNode(document, document.body, { id: "root" });
  const soloRoot = addNode(document, appRoot, { id: "solo-lite-root" });
  const layout = addNode(document, soloRoot, { classes: ["solo-lite-layout"] });
  addNode(document, layout, { classes: ["task-list-panel"] });
  const chat = addNode(document, layout, { classes: ["solo-lite-chat-panel-container"] });
  addNode(document, chat, { classes: ["session-panel"] });
  const composerLayout = addNode(document, chat, { classes: ["messageInputContainer"] });
  const composer = addNode(document, composerLayout, { classes: ["chat-input-v2-container"] });
  const composerSurface = addNode(document, composer, { classes: ["chat-input-v2-editor-part"] });
  addNode(document, composerSurface, {
    classes: ["chat-input-v2-input-box-editable"],
    attributes: { role: "textbox" },
  });

  const revoked = [];
  let objectUrl = 0;
  let timerId = 0;
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  const mediaQuery = {
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    document,
    innerWidth: 1200,
    innerHeight: 800,
    MutationObserver: FakeMutationObserver,
    Blob: class FakeBlob {},
    Uint8Array,
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    URL: {
      createObjectURL: () => `blob:fixture-${++objectUrl}`,
      revokeObjectURL: (value) => revoked.push(value),
    },
    matchMedia: () => mediaQuery,
    setInterval: () => ++timerId,
    clearInterval() {},
    setTimeout: () => ++timerId,
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", pointerEvents: "auto" }),
  };
  sandbox.window = sandbox;
  return { context: vm.createContext(sandbox), document, revoked };
}

test("renderer injection is reentrant and remove restores every owned DOM change", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "trae-renderer-test-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  await fs.writeFile(path.join(temporary, "theme.json"), JSON.stringify({
    schemaVersion: 1,
    id: "fixture",
    name: "Fixture",
    layout: "studio-collage",
    brandSubtitle: "FIXTURE STUDIO",
    tagline: "MAKE THE IDEA REAL",
    statusText: "FLOW 100%",
    quote: "SPARK / SHAPE / SHIP",
    image: "background.png",
    colors: {
      onAccent: "#101820",
      success: "#23856d",
      warning: "#b7791f",
      danger: "#c24152",
      info: "#3178b9",
      disabled: "#7b8790",
    },
    appearance: { treatment: "midnight-neon", shadow: "soft" },
  }));
  await fs.writeFile(path.join(temporary, "background.png"),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  await fs.writeFile(path.join(temporary, "skin.css"),
    ":root.trae-dream-skin { background: var(--trae-skin-art); }");
  const { payload } = await loadPayload(temporary);
  const { context, document, revoked } = createRendererContext();

  const first = vm.runInContext(payload, context);
  assert.equal(first.installed, true);
  assert.equal(first.surfaceCount >= 5, true);
  assert.equal(document.documentElement.classList.contains("trae-dream-skin"), true);
  assert.equal(document.documentElement.getAttribute("data-trae-skin-active"), "true");
  assert.equal(document.documentElement.getAttribute("data-trae-skin-mode"), "work");
  assert.equal(document.documentElement.getAttribute("data-trae-skin-view"), "solo");
  assert.equal(document.documentElement.getAttribute("data-trae-skin-route"), "thread");
  assert.equal(document.documentElement.getAttribute("data-trae-skin-motif"), "circuit");
  assert.equal(document.documentElement.getAttribute("data-trae-skin-icon-treatment"), "outline");
  assert.equal(document.documentElement.getAttribute("data-trae-skin-layout"), "studio-collage");
  assert.equal(document.documentElement.style.getPropertyValue("--trae-skin-art-blend"), "normal");
  assert.equal(document.documentElement.style.getPropertyValue("--trae-skin-overlay-tint"), "transparent");
  assert.equal(document.documentElement.style.getPropertyValue("--trae-skin-overlay"), "");
  assert.equal(document.querySelector(".chat-input-v2-editor-part")
    .getAttribute("data-trae-skin-surface"), "composer");
  assert.match(document.querySelector(".messageInputContainer")
    .getAttribute("data-trae-skin-component"), /composer\.surface/);
  assert.equal(document.querySelector(".chat-input-v2-container")
    .getAttribute("data-trae-skin-surface"), null);
  assert.equal(document.querySelector(".messageInputContainer")
    .getAttribute("data-trae-skin-surface"), null);
  assert.equal(document.querySelectorAll("#trae-dream-skin-style").length, 1);
  assert.equal(document.querySelectorAll("#trae-dream-skin-chrome").length, 1);
  assert.ok(document.documentElement.style.getPropertyValue("--trae-skin-art"));
  for (const [colorName, variableName] of Object.entries(SEMANTIC_COLOR_VARIABLES)) {
    assert.equal(document.documentElement.style.getPropertyValue(variableName), {
      onAccent: "#101820",
      success: "#23856d",
      warning: "#b7791f",
      danger: "#c24152",
      info: "#3178b9",
      disabled: "#7b8790",
    }[colorName]);
  }

  const home = addNode(document, document.body, { classes: ["initial-chat-panel"] });
  const homeTitle = addNode(document, home, { classes: ["welcomeTitleWrapper"] });
  vm.runInContext("window.__TRAE_DREAM_SKIN_STATE__.ensure()", context);
  assert.equal(document.documentElement.getAttribute("data-trae-skin-route"), "home");
  assert.equal(home.getAttribute("data-trae-skin-surface"), "home");
  assert.equal(homeTitle.getAttribute("data-trae-skin-role"), "home-title");
  home.remove();
  vm.runInContext("window.__TRAE_DREAM_SKIN_STATE__.ensure()", context);
  assert.equal(document.documentElement.getAttribute("data-trae-skin-route"), "thread");

  const codeDesignHome = addNode(document, document.body, { classes: ["panel-content"] });
  vm.runInContext("window.__TRAE_DREAM_SKIN_STATE__.ensure()", context);
  assert.equal(document.documentElement.getAttribute("data-trae-skin-route"), "home");
  assert.equal(codeDesignHome.getAttribute("data-trae-skin-surface"), "home");
  codeDesignHome.remove();
  vm.runInContext("window.__TRAE_DREAM_SKIN_STATE__.ensure()", context);
  assert.equal(document.documentElement.getAttribute("data-trae-skin-route"), "thread");

  const second = vm.runInContext(payload, context);
  assert.equal(second.installed, true);
  assert.equal(document.querySelectorAll("#trae-dream-skin-style").length, 1);
  assert.equal(document.querySelectorAll("#trae-dream-skin-chrome").length, 1);
  assert.equal(revoked.length, 1);

  const session = { evaluate: async (expression) => vm.runInContext(expression, context) };
  assert.equal(await removeFromSession(session), true);
  assert.equal(await verifyRemovedSession(session), true);
  assert.equal(document.documentElement.classList.contains("trae-dream-skin"), false);
  assert.equal(document.querySelector("[data-trae-skin-surface]"), null);
  assert.equal(document.querySelector("[data-trae-skin-component]"), null);
  assert.equal(document.getElementById("trae-dream-skin-style"), null);
  assert.equal(document.documentElement.getAttribute("data-trae-skin-motif"), null);
  assert.equal(document.documentElement.getAttribute("data-trae-skin-layout"), null);
  assert.equal(document.documentElement.style.getPropertyValue("--trae-skin-art-blend"), "");
  assert.equal(document.documentElement.style.getPropertyValue("--trae-skin-overlay-tint"), "");
  assert.equal(document.documentElement.style.getPropertyValue("--trae-skin-overlay"), "");
  assert.equal(document.getElementById("trae-dream-skin-chrome"), null);
  for (const variableName of Object.values(SEMANTIC_COLOR_VARIABLES)) {
    assert.equal(document.documentElement.style.getPropertyValue(variableName), "");
  }
  assert.equal(revoked.length, 2);
});

test("fallback removal clears the layout marker when renderer state is unavailable", async () => {
  const { context, document } = createRendererContext();
  document.documentElement.classList.add("trae-dream-skin");
  document.documentElement.setAttribute("data-trae-skin-layout", "studio-collage");
  document.documentElement.setAttribute("data-trae-skin-theme", "copied-theme-id");

  const session = { evaluate: async (expression) => vm.runInContext(expression, context) };
  assert.equal(await verifyRemovedSession(session), false);
  assert.equal(await removeFromSession(session), true);
  assert.equal(await verifyRemovedSession(session), true);
  assert.equal(document.documentElement.getAttribute("data-trae-skin-layout"), null);
});
