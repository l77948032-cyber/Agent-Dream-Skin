((cssText, artDataUrl, themeConfig) => {
  const STATE_KEY = "__TRAE_DREAM_SKIN_STATE__";
  const DISABLED_KEY = "__TRAE_DREAM_SKIN_DISABLED__";
  const STYLE_ID = "trae-dream-skin-style";
  const VERSION = __TRAE_SKIN_VERSION_JSON__;
  const THEME = themeConfig && typeof themeConfig === "object" ? themeConfig : {};
  const THEME_VARIABLES = [
    "--trae-skin-art",
    "--trae-skin-bg",
    "--trae-skin-panel",
    "--trae-skin-panel-alt",
    "--trae-skin-accent",
    "--trae-skin-accent-alt",
    "--trae-skin-secondary",
    "--trae-skin-highlight",
    "--trae-skin-on-accent",
    "--trae-skin-success",
    "--trae-skin-warning",
    "--trae-skin-danger",
    "--trae-skin-info",
    "--trae-skin-disabled",
    "--trae-skin-text",
    "--trae-skin-muted",
    "--trae-skin-line",
    "--trae-skin-selection",
    "--trae-skin-terminal",
    "--trae-skin-focus",
    "--trae-skin-surface-hover",
    "--trae-skin-surface-active",
    "--trae-skin-tooltip-bg",
    "--trae-skin-tooltip-text",
    "--trae-skin-color-scheme",
    "--trae-skin-art-position",
    "--trae-skin-art-size",
    "--trae-skin-art-opacity",
    "--trae-skin-surface-mix",
    "--trae-skin-sidebar-mix",
    "--trae-skin-blur",
    "--trae-skin-saturation",
    "--trae-skin-radius",
    "--trae-skin-shadow",
  ];
  const SURFACES = [
    ["#solo-lite-root, .monaco-workbench", "shell"],
    [".solo-lite-layout", "layout"],
    [".task-list-panel", "tasks"],
    [".solo-lite-chat-panel-container", "chat"],
    [".initial-chat-panel", "home"],
    [".session-panel", "session"],
  ];
  const ROLE_SELECTORS = [
    [".mode-switcher-btn [role=\"tab\"]", "mode-tab", true],
    [".welcomeTitleWrapper", "home-title", false],
    [".initial-chat-panel-input-wrapper", "home-composer", false],
    [".showcase-content-wrapper", "home-showcase", false],
    ["#solo-lite-root .showcaseWrapper [class^=\"chip-\"], #solo-lite-root .showcaseWrapper [class*=\" chip-\"]", "showcase-chip", true],
    ["#solo-lite-root .showcaseWrapper [class^=\"card-\"], #solo-lite-root .showcaseWrapper [class*=\" card-\"]", "showcase-card", true],
    ["[class*=\"scene-showcase-module__sceneTab___\"]", "scene-tab", true],
    ["[class*=\"scene-showcase-module__casesPanel___\"]", "scene-panel", false],
    ["[class*=\"scene-showcase-module__caseCard___\"]", "scene-card", true],
    [".turn__user-message .user-message__text-box", "user-message", false],
  ];

  const previous = window[STATE_KEY];
  if (typeof previous?.cleanup === "function") {
    try { previous.cleanup(); } catch {}
  }
  window[DISABLED_KEY] = false;

  const artUrl = (() => {
    const comma = artDataUrl.indexOf(",");
    const mime = /^data:([^;,]+)/.exec(artDataUrl)?.[1] || "image/png";
    const binary = atob(artDataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  })();

  const setVariable = (root, name, value) => {
    if (value !== undefined && value !== null && String(value).length) {
      root.style.setProperty(name, String(value));
    }
  };

  const detectShellMode = () => {
    const root = document.documentElement;
    const body = document.body;
    const classes = `${root?.className || ""} ${body?.className || ""}`.toLowerCase();
    if (/\b(?:vs-dark|hc-black|dark|theme-dark)\b/.test(classes)) return "dark";
    if (/\b(?:vs|light|theme-light)\b/.test(classes)) return "light";
    const dataTheme = String(
      root?.getAttribute("data-theme") ||
      root?.getAttribute("data-appearance") ||
      body?.getAttribute("data-theme") ||
      "",
    ).toLowerCase();
    if (dataTheme.includes("dark")) return "dark";
    if (dataTheme.includes("light")) return "light";
    try {
      return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch {
      return "dark";
    }
  };

  const detectMode = () => {
    let selected = null;
    try {
      selected = document.querySelector(
        '.mode-switcher-btn [role="tab"][aria-selected="true"], .mode-switcher-btn [role="tab"][data-state="active"]',
      );
    } catch {}
    const label = String(selected?.textContent || selected?.getAttribute?.("aria-label") || "")
      .trim().toLowerCase();
    if (label.includes("work") || label.includes("工作")) return "work";
    if (label.includes("code") || label.includes("代码") || label.includes("编程")) return "code";
    if (label.includes("design") || label.includes("设计")) return "design";
    if (document.querySelector(".monaco-workbench")) return "code";
    if (document.querySelector(".session-panel, .ai-chat.chat-session")) return "work";
    return "unknown";
  };

  const detectView = () => {
    if (document.querySelector(".monaco-workbench")) return "workbench";
    if (document.querySelector("#solo-lite-root")) return "solo";
    return "unknown";
  };

  const detectRoute = () => {
    if (document.querySelector(".monaco-workbench")) return "workbench";
    if (document.querySelector(".initial-chat-panel")) return "home";
    if (document.querySelector(
      ".session-panel .virtualized-message-list-view, .session-panel .turn__user-message, .session-panel .turn__agent-message",
    )) return "thread";
    if (document.querySelector(".session-panel")) return "thread";
    return "unknown";
  };

  const applyTheme = (root) => {
    const colors = THEME.colors || {};
    const states = THEME.states || {};
    const appearance = THEME.appearance || {};
    const colorVariables = {
      "--trae-skin-bg": colors.background,
      "--trae-skin-panel": colors.panel,
      "--trae-skin-panel-alt": colors.panelAlt,
      "--trae-skin-accent": colors.accent,
      "--trae-skin-accent-alt": colors.accentAlt,
      "--trae-skin-secondary": colors.secondary,
      "--trae-skin-highlight": colors.highlight,
      "--trae-skin-on-accent": colors.onAccent,
      "--trae-skin-success": colors.success,
      "--trae-skin-warning": colors.warning,
      "--trae-skin-danger": colors.danger,
      "--trae-skin-info": colors.info,
      "--trae-skin-disabled": colors.disabled,
      "--trae-skin-text": colors.text,
      "--trae-skin-muted": colors.muted,
      "--trae-skin-line": colors.line,
      "--trae-skin-selection": colors.selection,
      "--trae-skin-terminal": colors.terminal,
    };
    for (const [name, value] of Object.entries(colorVariables)) setVariable(root, name, value);
    const stateVariables = {
      "--trae-skin-focus": states.focus,
      "--trae-skin-surface-hover": states.surfaceHover,
      "--trae-skin-surface-active": states.surfaceActive,
      "--trae-skin-tooltip-bg": states.tooltipBackground,
      "--trae-skin-tooltip-text": states.tooltipText,
    };
    for (const [name, value] of Object.entries(stateVariables)) setVariable(root, name, value);

    const shell = appearance.colorScheme === "system" ? detectShellMode() : appearance.colorScheme;
    const shadow = appearance.shadow === "deep"
      ? "0 15px 36px rgba(17, 6, 8, 0.32)"
      : appearance.shadow === "none"
        ? "none"
        : "0 12px 30px rgba(0, 0, 0, 0.22)";
    setVariable(root, "--trae-skin-color-scheme", shell || detectShellMode());
    setVariable(root, "--trae-skin-art-position", appearance.backgroundPosition);
    setVariable(root, "--trae-skin-art-size", appearance.backgroundSize);
    setVariable(root, "--trae-skin-art-opacity", appearance.backgroundOpacity);
    setVariable(root, "--trae-skin-surface-mix", `${Math.round(Number(appearance.surfaceOpacity) * 10000) / 100}%`);
    setVariable(root, "--trae-skin-sidebar-mix", `${Math.round(Number(appearance.sidebarOpacity) * 10000) / 100}%`);
    setVariable(root, "--trae-skin-blur", `${Number(appearance.blur)}px`);
    setVariable(root, "--trae-skin-saturation", appearance.saturation);
    setVariable(root, "--trae-skin-radius", `${Number(appearance.radius)}px`);
    setVariable(root, "--trae-skin-shadow", shadow);
  };

  const markSurfaces = () => {
    const marked = new Set();
    for (const [selector, name] of SURFACES) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch {}
      for (const node of nodes) {
        node.setAttribute("data-trae-skin-surface", name);
        marked.add(node);
      }
    }
    const composer = document.querySelector(".chat-input-v2-editor-part") ||
      document.querySelector(".chat-input-v2-container") ||
      document.querySelector(".messageInputContainer");
    if (composer) {
      composer.setAttribute("data-trae-skin-surface", "composer");
      marked.add(composer);
    }
    for (const node of document.querySelectorAll("[data-trae-skin-surface]")) {
      if (!marked.has(node)) node.removeAttribute("data-trae-skin-surface");
    }
    return marked.size;
  };

  const markRoles = () => {
    const marked = new Set();
    for (const [selector, role, indexed] of ROLE_SELECTORS) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch {}
      nodes.forEach((node, index) => {
        node.setAttribute("data-trae-skin-role", role);
        if (indexed) node.setAttribute("data-trae-skin-index", String(index));
        else node.removeAttribute("data-trae-skin-index");
        marked.add(node);
      });
    }
    for (const node of document.querySelectorAll("[data-trae-skin-role]")) {
      if (!marked.has(node)) {
        node.removeAttribute("data-trae-skin-role");
        node.removeAttribute("data-trae-skin-index");
      }
    }
    return marked.size;
  };

  const ensureChrome = () => {
    let chrome = document.getElementById("trae-dream-skin-chrome");
    if (THEME.layout !== "studio-collage") {
      chrome?.remove();
      return null;
    }
    if (!chrome) {
      chrome = document.createElement("div");
      chrome.id = "trae-dream-skin-chrome";
      chrome.setAttribute("aria-hidden", "true");

      const brand = document.createElement("div");
      brand.classList.add("trae-skin-chrome-brand");
      const kicker = document.createElement("span");
      kicker.id = "trae-skin-chrome-kicker";
      const tagline = document.createElement("strong");
      tagline.id = "trae-skin-chrome-tagline";
      const quote = document.createElement("small");
      quote.id = "trae-skin-chrome-quote";
      brand.appendChild(kicker);
      brand.appendChild(tagline);
      brand.appendChild(quote);

      const status = document.createElement("div");
      status.classList.add("trae-skin-chrome-status");
      const statusLabel = document.createElement("span");
      statusLabel.id = "trae-skin-chrome-status-label";
      const meter = document.createElement("i");
      status.appendChild(statusLabel);
      status.appendChild(meter);

      const doodles = document.createElement("div");
      doodles.classList.add("trae-skin-chrome-doodles");
      for (const name of ["spark", "loop", "tape"]) {
        const item = document.createElement("i");
        item.classList.add(`trae-skin-doodle-${name}`);
        doodles.appendChild(item);
      }

      chrome.appendChild(brand);
      chrome.appendChild(status);
      chrome.appendChild(doodles);
      document.body.appendChild(chrome);
    }
    const values = [
      ["trae-skin-chrome-kicker", THEME.brandSubtitle],
      ["trae-skin-chrome-tagline", THEME.tagline],
      ["trae-skin-chrome-quote", THEME.quote],
      ["trae-skin-chrome-status-label", THEME.statusText],
    ];
    for (const [id, value] of values) {
      const node = document.getElementById(id);
      if (node) node.textContent = String(value || "");
    }
    return chrome;
  };

  const clearSkinDom = () => {
    const root = document.documentElement;
    root?.classList.remove("trae-dream-skin");
    document.body?.classList.remove("trae-dream-skin-body");
    root?.removeAttribute("data-trae-skin-active");
    root?.removeAttribute("data-trae-skin-theme");
    root?.removeAttribute("data-trae-skin-treatment");
    root?.removeAttribute("data-trae-skin-shadow");
    root?.removeAttribute("data-trae-skin-shell");
    root?.removeAttribute("data-trae-skin-mode");
    root?.removeAttribute("data-trae-skin-view");
    root?.removeAttribute("data-trae-skin-route");
    for (const name of THEME_VARIABLES) root?.style.removeProperty(name);
    document.querySelectorAll("[data-trae-skin-surface]").forEach((node) =>
      node.removeAttribute("data-trae-skin-surface"));
    document.querySelectorAll("[data-trae-skin-role]").forEach((node) => {
      node.removeAttribute("data-trae-skin-role");
      node.removeAttribute("data-trae-skin-index");
    });
    document.getElementById(STYLE_ID)?.remove();
    document.getElementById("trae-dream-skin-chrome")?.remove();
  };

  const ensure = () => {
    if (window[DISABLED_KEY]) return { installed: false, surfaceCount: 0 };
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return { installed: false, surfaceCount: 0 };

    root.classList.add("trae-dream-skin");
    body.classList.add("trae-dream-skin-body");
    root.setAttribute("data-trae-skin-active", "true");
    root.setAttribute("data-trae-skin-theme", THEME.id || "custom");
    root.setAttribute("data-trae-skin-treatment", THEME.appearance?.treatment || "midnight-neon");
    root.setAttribute("data-trae-skin-shadow", THEME.appearance?.shadow || "soft");
    root.setAttribute("data-trae-skin-shell", detectShellMode());
    root.setAttribute("data-trae-skin-mode", detectMode());
    root.setAttribute("data-trae-skin-view", detectView());
    root.setAttribute("data-trae-skin-route", detectRoute());
    root.style.setProperty("--trae-skin-art", `url("${artUrl}")`);
    applyTheme(root);

    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || root).appendChild(style);
    }
    if (style.dataset.traeSkinVersion !== VERSION || style.textContent !== cssText) {
      style.textContent = cssText;
      style.dataset.traeSkinVersion = VERSION;
    }
    ensureChrome();
    markRoles();
    return {
      installed: true,
      surfaceCount: markSurfaces(),
      mode: detectMode(),
      view: detectView(),
      route: detectRoute(),
    };
  };

  const cleanup = () => {
    window[DISABLED_KEY] = true;
    const state = window[STATE_KEY];
    state?.observer?.disconnect();
    if (state?.timer) clearInterval(state.timer);
    if (state?.scheduler?.timeout) clearTimeout(state.scheduler.timeout);
    if (state?.resizeHandler) window.removeEventListener("resize", state.resizeHandler);
    if (state?.mediaQuery && state?.mediaHandler) {
      try { state.mediaQuery.removeEventListener("change", state.mediaHandler); } catch {}
    }
    clearSkinDom();
    if (state?.artUrl) URL.revokeObjectURL(state.artUrl);
    else URL.revokeObjectURL(artUrl);
    delete window[STATE_KEY];
    return true;
  };

  const scheduler = { timeout: null };
  const scheduleEnsure = () => {
    if (window[DISABLED_KEY]) return;
    if (scheduler.timeout) clearTimeout(scheduler.timeout);
    scheduler.timeout = setTimeout(() => {
      scheduler.timeout = null;
      ensure();
    }, 160);
  };
  const observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-theme", "data-appearance", "aria-selected", "data-state"],
  });
  const timer = setInterval(ensure, 4000);
  const resizeHandler = scheduleEnsure;
  window.addEventListener("resize", resizeHandler, { passive: true });

  let mediaQuery = null;
  let mediaHandler = null;
  try {
    mediaQuery = matchMedia("(prefers-color-scheme: dark)");
    mediaHandler = scheduleEnsure;
    mediaQuery.addEventListener("change", mediaHandler);
  } catch {}

  window[STATE_KEY] = {
    version: VERSION,
    themeId: THEME.id || "custom",
    ensure,
    cleanup,
    observer,
    timer,
    scheduler,
    resizeHandler,
    mediaQuery,
    mediaHandler,
    artUrl,
    detectShellMode,
  };
  const result = ensure();
  return {
    installed: result.installed,
    version: VERSION,
    themeId: THEME.id || "custom",
    shell: detectShellMode(),
    mode: result.mode,
    view: result.view,
    route: result.route,
    surfaceCount: result.surfaceCount,
  };
})(__TRAE_SKIN_CSS_JSON__, __TRAE_SKIN_ART_JSON__, __TRAE_SKIN_THEME_JSON__)
