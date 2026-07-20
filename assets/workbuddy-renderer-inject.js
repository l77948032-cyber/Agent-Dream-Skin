(() => {
  "use strict";

  const skinCss = __WORKBUDDY_SKIN_CSS_JSON__;
  const artDataUrl = __WORKBUDDY_SKIN_ART_JSON__;
  const theme = __WORKBUDDY_SKIN_THEME_JSON__;
  const componentRegistry = __WORKBUDDY_SKIN_COMPONENT_REGISTRY_JSON__;
  const version = __WORKBUDDY_SKIN_VERSION_JSON__;
  const STYLE_ID = "workbuddy-dream-skin-style";
  const STATE_KEY = "__WORKBUDDY_DREAM_SKIN_STATE__";
  const ROOT_CLASS = "workbuddy-dream-skin";
  const BODY_CLASS = "workbuddy-dream-skin-body";
  const COMPONENT_ATTRIBUTE = "data-workbuddy-skin-component";
  const RUNTIME_ROLE_ATTRIBUTE = "data-workbuddy-skin-runtime-role";
  const ROUTE_ATTRIBUTE = "data-workbuddy-skin-route";
  const artUrl = (() => {
    const comma = artDataUrl.indexOf(",");
    const mime = /^data:([^;,]+)/.exec(artDataUrl)?.[1] || "image/png";
    const binary = atob(artDataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  })();
  const clamp = (minimum, value, maximum) => Math.min(maximum, Math.max(minimum, value));
  const percentage = (value) => `${Math.round(value * 100) / 100}%`;
  const surfacePercent = Number(theme.appearance.surfaceOpacity) * 100;
  const sidebarPercent = Number(theme.appearance.sidebarOpacity) * 100;
  const themeId = String(theme.id || "").trim().toLowerCase();
  const configuredBackgroundPosition = theme.appearance.backgroundPosition;
  const backgroundPosition = configuredBackgroundPosition === "center center"
    ? (/^(?:orchid-night|harbor-focus)(?:-|$)/.test(themeId)
      ? "right center"
      : (/^paper-garden(?:-|$)/.test(themeId) ? "left center" : configuredBackgroundPosition))
    : configuredBackgroundPosition;
  const variables = {
    "--dreamskin-art": `url("${artUrl}")`,
    "--dreamskin-bg": theme.colors.background,
    "--dreamskin-panel": theme.colors.panel,
    "--dreamskin-panel-alt": theme.colors.panelAlt,
    "--dreamskin-accent": theme.colors.accent,
    "--dreamskin-accent-alt": theme.colors.accentAlt,
    "--dreamskin-secondary": theme.colors.secondary,
    "--dreamskin-highlight": theme.colors.highlight,
    "--dreamskin-on-accent": theme.colors.onAccent,
    "--dreamskin-success": theme.colors.success,
    "--dreamskin-warning": theme.colors.warning,
    "--dreamskin-danger": theme.colors.danger,
    "--dreamskin-info": theme.colors.info,
    "--dreamskin-disabled": theme.colors.disabled,
    "--dreamskin-text": theme.colors.text,
    "--dreamskin-muted": theme.colors.muted,
    "--dreamskin-line": theme.colors.line,
    "--dreamskin-selection": theme.colors.selection,
    "--dreamskin-terminal": theme.colors.terminal,
    "--dreamskin-hover": theme.states.surfaceHover,
    "--dreamskin-active": theme.states.surfaceActive,
    "--dreamskin-focus": theme.states.focus,
    "--dreamskin-tooltip-bg": theme.states.tooltipBackground,
    "--dreamskin-tooltip-text": theme.states.tooltipText,
    "--dreamskin-art-position": backgroundPosition,
    "--dreamskin-art-size": theme.appearance.backgroundSize,
    "--dreamskin-art-opacity": String(theme.appearance.backgroundOpacity),
    "--dreamskin-art-blend": theme.appearance.backgroundBlendMode,
    "--dreamskin-overlay": theme.appearance.backgroundOverlay,
    "--dreamskin-blur": `${theme.appearance.blur}px`,
    "--dreamskin-radius": `${theme.appearance.radius}px`,
    "--dreamskin-saturation": String(theme.appearance.saturation),
    "--dreamskin-surface-opacity": String(theme.appearance.surfaceOpacity),
    "--dreamskin-sidebar-opacity": String(theme.appearance.sidebarOpacity),
    "--dreamskin-reading-mix": percentage(clamp(24, surfacePercent * 0.5, 44)),
    "--dreamskin-composer-mix": percentage(clamp(64, surfacePercent * 0.82, 76)),
    "--dreamskin-sidebar-readable-mix": percentage(clamp(48, sidebarPercent * 0.7, 68)),
    "--dreamskin-color-scheme": theme.appearance.colorScheme,
  };

  const componentSelectors = Object.freeze(Object.fromEntries(
    (Array.isArray(componentRegistry?.components) ? componentRegistry.components : [])
      .filter((component) => typeof component?.id === "string" && Array.isArray(component.selectors))
      .map((component) => [component.id, component.selectors.join(", ")])
      .filter(([, selector]) => selector),
  ));

  const query = (selector) => {
    try { return document.querySelector(selector); } catch { return null; }
  };

  const queryAll = (selector) => {
    try { return document.querySelectorAll(selector); } catch { return []; }
  };

  const detectHostVersion = () => {
    const match = String(navigator.userAgent || "").match(/WorkBuddy\/(\d+\.\d+\.\d+)/i);
    return match?.[1] || null;
  };

  const routeDetectors = Object.freeze([
    ["more", ".conversation-list-more-dropdown[role=menu], .conversation-list-tab-button-more[aria-expanded=true]"],
    ["home", ".wb-home-page, .main-content--welcome"],
    ["automation", ".main-content--automation, .automation-main-page, .automation-panel"],
    ["market", ".expert-center-page, .skills-view, .connector-panel, .expert-marketplace, .skills-page, .connector-page"],
    ["project", ".main-content--projects, .main-content--project, .workbuddy-collab, .project-detail-view, .project-page"],
    ["assistant", ".claw-workspace"],
    ["settings", ".settings-page, .settings-view, [data-workbuddy-skin-role=settings-page]"],
    ["chat", ".chat-container:not(.chat-container--welcome)"],
  ]);

  const runtimeComponentSelectors = Object.freeze({
    "project.card": [
      ".project-grid__card",
      ".landing-template-card",
      ".wb-config-card",
      ".project-plan-panel__board-card",
      ".task-item",
      ".project-experts-drawer__card",
      ".project-skills-drawer__card",
    ].join(", "),
    "market.toolbar": ".ec-topbar, .ec-list-tabs-row, .skillhub-filter-bar, .skills-segment-bar",
    "market.card": ".ec-featured-scene-card, .ec-expert-card, .skill-card, .connector-card",
    "automation.task": ".atm-task-card, .atm-template-card, .atm-row",
    "automation.run": ".atm-run-card, .atm-run-item, .atm-run-history-item, .atm-execution-item, .atm-inbox-row",
    "settings.section": ".settings-card, .settings-section, .preference-section",
    "overlay.menu": ".conversation-list-more-dropdown[role=menu]",
    "overlay.dialog": [
      ".atm-modal",
      ".atm-detail-modal",
      ".collab-modal__container",
      ".create-colleague-modal--drawer",
      ".project-plan-panel__detail-dialog",
      ".project-plan-panel__create-dialog",
    ].join(", "),
  });

  const runtimeRoleSelectors = Object.freeze({
    "business.canvas": [
      ".workbuddy-collab",
      ".landing",
      ".project-detail-view",
      ".claw-workspace",
      ".claw-trial-experience-page",
      ".expert-center-page",
      ".ec-main-content",
      ".skills-view",
      ".skills-content",
      ".connector-panel",
      ".connector-panel-content",
      ".automation-main-page",
      ".automation-panel",
      ".settings-page",
      ".settings-view",
    ].join(", "),
    "business.toolbar": [
      ".project-detail-view__top-tabs",
      ".ec-topbar",
      ".skills-view > .workbuddy-topbar",
      ".connector-panel > .workbuddy-topbar",
      ".automation-panel > .workbuddy-topbar",
    ].join(", "),
    "business.card": [
      ".project-grid__card",
      ".landing-template-card",
      ".wb-config-card",
      ".project-plan-panel__board-card",
      ".task-item",
      ".project-experts-drawer__card",
      ".project-skills-drawer__card",
      ".claw-assistant-profile-detail__info-card",
      ".claw-assistant-profile-detail__task-card",
      ".ec-featured-scene-card",
      ".ec-expert-card",
      ".skill-card",
      ".connector-card",
      ".atm-task-card",
      ".atm-template-card",
      ".atm-row",
      ".atm-run-card",
      ".atm-run-item",
      ".atm-run-history-item",
      ".atm-execution-item",
      ".settings-card",
      ".settings-section",
    ].join(", "),
    "business.panel": [
      ".project-detail-view__panel",
      ".claw-secondary-sidebar",
      ".claw-sidebar-drawer",
      ".project-experts-drawer",
      ".project-skills-drawer",
      ".project-instruction-drawer",
    ].join(", "),
  });

  const registryComponentGuards = Object.freeze({
    "market.card": (node) => node.matches(
      '[data-workbuddy-skin-role="market-card"], .market-card, .skill-card',
    ),
    "automation.task": (node) => node.matches(
      '[data-workbuddy-skin-role="automation-task"], .automation-card, .schedule-card',
    ),
    "project.card": (node) => node.matches(
      '[data-workbuddy-skin-role="project-card"], .project-card, .workspace-card',
    ),
  });

  const detectRoute = () => {
    for (const [route, selector] of routeDetectors) {
      if (query(selector)) return route;
    }
    return "workspace";
  };

  const markComponents = () => {
    const componentAssignments = new Map();
    const roleAssignments = new Map();
    const assign = (assignments, node, value) => {
      if (!(node instanceof Element)) return;
      const values = assignments.get(node) || new Set();
      values.add(value);
      assignments.set(node, values);
    };

    for (const node of queryAll(`[${COMPONENT_ATTRIBUTE}]`)) node.removeAttribute(COMPONENT_ATTRIBUTE);
    for (const node of queryAll(`[${RUNTIME_ROLE_ATTRIBUTE}]`)) node.removeAttribute(RUNTIME_ROLE_ATTRIBUTE);

    for (const [component, selector] of Object.entries(componentSelectors)) {
      const guard = registryComponentGuards[component];
      for (const node of queryAll(selector)) {
        if (!guard || guard(node)) assign(componentAssignments, node, component);
      }
    }

    for (const [component, selector] of Object.entries(runtimeComponentSelectors)) {
      for (const node of queryAll(selector)) assign(componentAssignments, node, component);
    }

    for (const [role, selector] of Object.entries(runtimeRoleSelectors)) {
      for (const node of queryAll(selector)) assign(roleAssignments, node, role);
    }

    for (const node of queryAll('[class*="_assistantTextContent_"], [class*="assistantTextContent"]')) {
      assign(componentAssignments, node, "chat.message.agent");
      assign(roleAssignments, node, "assistant.prose");
    }

    for (const editor of queryAll('[data-slate-editor="true"][contenteditable="true"]')) {
      const surface = editor.closest("section");
      if (!surface) continue;
      assign(componentAssignments, surface, "composer.surface");
      assign(roleAssignments, surface, "composer.surface");
    }

    const composer = query(".wb-home-composer__input-slot");
    if (composer) {
      for (const button of composer.querySelectorAll("button[aria-label]")) {
        let node = button.parentElement;
        while (node && node !== composer) {
          const rect = node.getBoundingClientRect();
          const computed = getComputedStyle(node);
          if (rect.width >= 160 && rect.width <= 320 && rect.height >= 80 && rect.height <= 180 &&
            computed.backgroundImage !== "none" && node.children.length >= 2) {
            assign(componentAssignments, node, "status.toast");
            assign(roleAssignments, node, "home.notice");
            break;
          }
          node = node.parentElement;
        }
      }
    }

    for (const [node, values] of componentAssignments) {
      node.setAttribute(COMPONENT_ATTRIBUTE, [...values].join(" "));
    }
    for (const [node, values] of roleAssignments) {
      node.setAttribute(RUNTIME_ROLE_ATTRIBUTE, [...values].join(" "));
    }
  };

  const existing = window[STATE_KEY];
  if (existing && typeof existing.cleanup === "function") existing.cleanup();
  window.__WORKBUDDY_DREAM_SKIN_DISABLED__ = false;

  let scheduled = false;
  let observer = null;
  const ensure = () => {
    if (window.__WORKBUDDY_DREAM_SKIN_DISABLED__) return false;
    const root = document.documentElement;
    const body = document.body;
    if (!root || !body) return false;

    let style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      style.dataset.dreamskinOwner = "workbuddy";
      (document.head || root).append(style);
    }
    if (style.textContent !== skinCss) style.textContent = skinCss;

    root.classList.add(ROOT_CLASS);
    body.classList.add(BODY_CLASS);
    root.setAttribute("data-workbuddy-dream-skin", "active");
    root.setAttribute("data-workbuddy-skin-theme", theme.id);
    root.setAttribute("data-workbuddy-skin-version", version);
    root.setAttribute("data-workbuddy-host-version", detectHostVersion() || "unknown");
    root.setAttribute(
      "data-workbuddy-skin-compat",
      /^5\.2\./.test(detectHostVersion() || "") ? "5.2" : "token-only",
    );
    root.setAttribute(ROUTE_ATTRIBUTE, detectRoute());
    root.setAttribute("data-workbuddy-skin-treatment", theme.appearance.treatment);
    root.setAttribute("data-workbuddy-skin-motif", theme.visual.motif);
    root.setAttribute("data-workbuddy-skin-icon-treatment", theme.visual.iconTreatment);
    root.setAttribute("data-workbuddy-skin-surface-treatment", theme.visual.surfaceTreatment);
    root.setAttribute("data-workbuddy-skin-card-treatment", theme.visual.cardTreatment);
    root.setAttribute("data-workbuddy-skin-ornament", theme.visual.ornament);
    root.setAttribute("data-workbuddy-skin-accent-placement", theme.visual.accentPlacement);
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    markComponents();
    return true;
  };

  const scheduleEnsure = () => {
    if (scheduled || window.__WORKBUDDY_DREAM_SKIN_DISABLED__) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      ensure();
    });
  };

  const cleanup = () => {
    window.__WORKBUDDY_DREAM_SKIN_DISABLED__ = true;
    observer?.disconnect();
    observer = null;
    window.removeEventListener("hashchange", scheduleEnsure);
    window.removeEventListener("popstate", scheduleEnsure);
    const root = document.documentElement;
    root?.classList.remove(ROOT_CLASS);
    document.body?.classList.remove(BODY_CLASS);
    for (const name of Object.keys(variables)) root?.style.removeProperty(name);
    for (const attribute of [
      "data-workbuddy-dream-skin",
      "data-workbuddy-skin-theme",
      "data-workbuddy-skin-version",
      "data-workbuddy-host-version",
      "data-workbuddy-skin-compat",
      ROUTE_ATTRIBUTE,
      "data-workbuddy-skin-treatment",
      "data-workbuddy-skin-motif",
      "data-workbuddy-skin-icon-treatment",
      "data-workbuddy-skin-surface-treatment",
      "data-workbuddy-skin-card-treatment",
      "data-workbuddy-skin-ornament",
      "data-workbuddy-skin-accent-placement",
    ]) root?.removeAttribute(attribute);
    for (const node of queryAll(`[${COMPONENT_ATTRIBUTE}]`)) node.removeAttribute(COMPONENT_ATTRIBUTE);
    for (const node of queryAll(`[${RUNTIME_ROLE_ATTRIBUTE}]`)) node.removeAttribute(RUNTIME_ROLE_ATTRIBUTE);
    document.getElementById(STYLE_ID)?.remove();
    URL.revokeObjectURL(artUrl);
    delete window[STATE_KEY];
    return true;
  };

  ensure();
  observer = new MutationObserver(scheduleEnsure);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", scheduleEnsure);
  window.addEventListener("popstate", scheduleEnsure);
  window[STATE_KEY] = Object.freeze({
    version,
    themeId: theme.id,
    hostVersion: detectHostVersion(),
    ensure,
    cleanup,
  });

  return {
    installed: true,
    version,
    themeId: theme.id,
    hostVersion: detectHostVersion(),
    compatibility: document.documentElement.getAttribute("data-workbuddy-skin-compat"),
    route: detectRoute(),
  };
})()
