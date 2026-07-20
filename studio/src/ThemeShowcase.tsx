import runtimeCss from "../../assets/trae-skin.css?raw";
import componentRegistry from "../../registry/components.v1.json";
import runtimeMapping from "../../plugins/trae/resources/theme-runtime.v1.json";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import fixtureCss from "./mcp-preview-fixture.css?raw";
import type { AppearanceMode, PreviewMode, StudioTheme } from "./themes";
import { WorkBuddyScenePreview, type WorkBuddyScene } from "./WorkBuddyPreview";

type PreviewRoute = "home" | "thread" | "components";
export type TraePreviewScene = "work" | "code" | "design" | "thread" | "components";
export type ThemePreviewScene = TraePreviewScene | WorkBuddyScene;
type RuntimeFormat = "raw" | "percent" | "px";

const FRAME_WIDTH = 1200;

const icons = `
<svg class="fixture-symbols" aria-hidden="true">
  <symbol id="i-work" viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11a2 2 0 0 1 2 2v16a2.5 2.5 0 0 0-2.5-2.5H4zM20 5.5A2.5 2.5 0 0 0 17.5 3H13v18a2.5 2.5 0 0 1 2.5-2.5H20z"/></symbol>
  <symbol id="i-code" viewBox="0 0 24 24"><path d="m8 9-4 3 4 3M16 9l4 3-4 3M14 5l-4 14"/></symbol>
  <symbol id="i-design" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><circle cx="8" cy="9" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/><path d="M14 17c0-2 2-2 3-3"/></symbol>
  <symbol id="i-plus" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></symbol>
  <symbol id="i-skill" viewBox="0 0 24 24"><path d="M4 5h6a3 3 0 0 1 3 3v11a3 3 0 0 0-3-3H4zM20 5h-4a3 3 0 0 0-3 3v11a3 3 0 0 1 3-3h4z"/><path d="M17 8h3M17 11h3"/></symbol>
  <symbol id="i-auto" viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3M4.5 6.5 3 5"/></symbol>
  <symbol id="i-folder" viewBox="0 0 24 24"><path d="M3 6.5h6l2 2h10v10.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></symbol>
  <symbol id="i-list" viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/></symbol>
  <symbol id="i-filter" viewBox="0 0 24 24"><path d="M4 6h16M7 12h10M10 18h4"/></symbol>
  <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></symbol>
  <symbol id="i-paperclip" viewBox="0 0 24 24"><path d="m20 12-8 8a6 6 0 0 1-8-8l9-9a4 4 0 0 1 6 6l-9 9a2 2 0 0 1-3-3l8-8"/></symbol>
  <symbol id="i-at" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/></symbol>
  <symbol id="i-spark" viewBox="0 0 24 24"><path d="m12 3 1.3 4.2L17 9l-3.7 1.8L12 15l-1.3-4.2L7 9l3.7-1.8zM5 15l.7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7zM19 3l.7 2.3L22 6l-2.3.7L19 9l-.7-2.3L16 6l2.3-.7z"/></symbol>
  <symbol id="i-mic" viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></symbol>
  <symbol id="i-send" viewBox="0 0 24 24"><path d="m4 12 16-8-5 16-3-6zM12 14l8-10"/></symbol>
  <symbol id="i-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
  <symbol id="i-info" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></symbol>
  <symbol id="i-x" viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></symbol>
  <symbol id="i-chevron" viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></symbol>
</svg>`;

const icon = (name: string) => `<svg class="fixture-icon" aria-hidden="true"><use href="#i-${name}" /></svg>`;

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function cssValue(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", " ");
}

function formatAppearance(value: unknown, format: RuntimeFormat) {
  if (format === "percent") return `${Math.round(Number(value) * 10000) / 100}%`;
  if (format === "px") return `${Number(value)}px`;
  return String(value);
}

function runtimeVariables(theme: StudioTheme, appearanceMode: AppearanceMode) {
  const entries: Array<[string, string]> = [["--trae-skin-art", `url("${cssValue(theme.imageUrl)}")`]];

  for (const [key, variable] of Object.entries(runtimeMapping.colors)) {
    entries.push([variable, theme.colors[key as keyof StudioTheme["colors"]]]);
  }
  for (const [key, variable] of Object.entries(runtimeMapping.states)) {
    entries.push([variable, theme.states[key as keyof StudioTheme["states"]]]);
  }
  for (const [key, descriptor] of Object.entries(runtimeMapping.appearance)) {
    const value = theme.appearance[key as keyof StudioTheme["appearance"]];
    entries.push([descriptor.variable, formatAppearance(value, descriptor.format as RuntimeFormat)]);
  }

  const scheme = theme.appearance.colorScheme === "system" ? appearanceMode : theme.appearance.colorScheme;
  const shadow = theme.appearance.shadow === "deep"
    ? "0 15px 36px rgba(17, 6, 8, 0.32)"
    : theme.appearance.shadow === "none"
      ? "none"
      : "0 12px 30px rgba(0, 0, 0, 0.22)";
  entries.push(["--trae-skin-color-scheme", scheme], ["--trae-skin-shadow", shadow]);
  return entries.map(([name, value]) => `${name}:${value}`).join(";");
}

function runtimeVisualAttributes(theme: StudioTheme) {
  return Object.entries(runtimeMapping.visualAttributes)
    .map(([key, attribute]) => `${attribute}="${escapeHtml(theme.visual[key as keyof StudioTheme["visual"]])}"`)
    .join(" ");
}

function annotatePreviewComponents(source: string) {
  if (typeof DOMParser === "undefined") return source;
  const preview = new DOMParser().parseFromString(source, "text/html");
  const assignments = new Map<Element, Set<string>>();

  for (const component of componentRegistry.components) {
    for (const selector of component.selectors) {
      let nodes: NodeListOf<Element>;
      try {
        nodes = preview.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const node of nodes) {
        const ids = assignments.get(node) || new Set<string>();
        ids.add(component.id);
        assignments.set(node, ids);
      }
    }
  }

  for (const [node, ids] of assignments) {
    node.setAttribute("data-trae-skin-component", [...ids].join(" "));
  }
  return `<!doctype html>\n${preview.documentElement.outerHTML}`;
}

function sidebarMarkup(mode: PreviewMode, route: "home" | "thread") {
  const modeTabs = ([
    ["work", "work", "Work"],
    ["code", "code", "Code"],
    ["design", "design", "Design"],
  ] as const).map(([value, iconName, label]) => (
    `<button role="tab" aria-selected="${value === mode}">${icon(iconName)}<span>${label}</span></button>`
  )).join("");
  const newTaskClass = route === "home" ? "taskIconBtn taskIconBtnActive" : "taskIconBtn";
  const selectedTask = route === "thread"
    ? `<button class="taskItemSelected" aria-selected="true"><span>查看飞书文档</span>${icon("list")}</button>`
    : `<button><span>查看飞书文档</span></button>`;

  return `
    <aside class="task-list-panel fixture-sidebar">
      <div class="mode-switcher-btn fixture-mode-switch" role="tablist" aria-label="模式" data-mode="${mode}">
        <span class="fixture-mode-indicator" aria-hidden="true"></span>
        ${modeTabs}
      </div>
      <nav class="fixture-primary-nav">
        <button class="${newTaskClass}" ${route === "home" ? 'aria-current="page"' : ""}>${icon("plus")}<span>新建任务</span></button>
        <button class="taskIconBtn">${icon("skill")}<span>技能</span></button>
        <button class="taskIconBtn">${icon("auto")}<span>自动化</span></button>
      </nav>
      <div class="fixture-task-heading"><span>任务列表</span><div><button class="task-list-heading-action-btn" aria-label="列表">${icon("list")}</button><button class="task-list-heading-action-btn" aria-label="筛选">${icon("filter")}</button></div></div>
      <div class="fixture-project">${icon("folder")}<span>Agent-Dream-Skin</span>${icon("chevron")}</div>
      <div class="fixture-tasks">
        <button>检查日志高频写盘</button>
        ${selectedTask}
        <button>完善 Dream Skin</button>
      </div>
      <div class="fixture-account"><span class="fixture-avatar">A</span><strong>Agent Builder</strong><small>免费</small><button class="taskMoreBtn" aria-label="账号菜单">${icon("more")}</button></div>
    </aside>`;
}

function composerMarkup(placeholder = "描述任务，或粘贴设计与代码需求") {
  return `
    <div class="messageInputContainer fixture-composer-shell">
      <div class="chat-input-v2-container">
        <div class="chat-input-v2-editor-part" data-trae-skin-surface="composer">
          <div class="chat-input-v2-input-box-editable" role="textbox">${escapeHtml(placeholder)}</div>
          <div class="fixture-composer-toolbar">
            <div>
              <button class="messageInputToolbarIconBtn" aria-label="附件">${icon("paperclip")}</button>
              <button class="messageInputToolbarIconBtn" aria-label="引用">${icon("at")}</button>
              <button class="messageInputToolbarIconBtn" aria-label="技能">${icon("spark")}</button>
              <button class="core-model-select-trigger">Auto ${icon("chevron")}</button>
            </div>
            <div><button class="rtcVoicePluginButton" aria-label="语音">${icon("mic")}</button><button class="chat-input-v2-send-button" aria-label="发送">${icon("send")}</button></div>
          </div>
        </div>
      </div>
    </div>`;
}

function workHomeMarkup() {
  return `
    <div id="root"><div id="solo-lite-root" class="solo-lite-layout fixture-shell">
      ${sidebarMarkup("work", "home")}
      <main class="initial-chat-panel panel-container fixture-home">
        <div class="initial-chat-panel-content fixture-home-content">
          <div class="welcomeTitleWrapper" data-trae-skin-role="home-title"><span>TRAE SOLO</span><h1>今天想创造什么？</h1></div>
          <div class="initial-chat-panel-input-wrapper" data-trae-skin-role="home-composer">${composerMarkup()}</div>
          <div class="showcase-content-wrapper" data-trae-skin-role="home-showcase">
            <div class="showcaseWrapper fixture-showcase">
              <div class="fixture-chips">
                <button class="chip-primary" data-trae-skin-role="showcase-chip" data-trae-skin-index="0">${icon("spark")} 从想法开始</button>
                <button class="chip-code" data-trae-skin-role="showcase-chip" data-trae-skin-index="1">${icon("code")} 生成应用</button>
                <button class="chip-skill" data-trae-skin-role="showcase-chip" data-trae-skin-index="2">${icon("skill")} 调用技能</button>
              </div>
              <div class="fixture-cards">
                <button class="card-web" data-trae-skin-role="showcase-card" data-trae-skin-index="0"><span class="cardTitle-main">构建 Web 应用</span><span class="cardDescription-main">从需求到可运行项目</span></button>
                <button class="card-research" data-trae-skin-role="showcase-card" data-trae-skin-index="1"><span class="cardTitle-main">研究与总结</span><span class="cardDescription-main">汇总资料并给出结论</span></button>
                <button class="card-workspace" data-trae-skin-role="showcase-card" data-trae-skin-index="2"><span class="cardTitle-main">整理工作空间</span><span class="cardDescription-main">检查并优化当前项目</span></button>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div></div>`;
}

function codeHomeMarkup() {
  return `
    <div id="root"><div id="solo-lite-root" class="solo-lite-layout fixture-shell">
      ${sidebarMarkup("code", "home")}
      <main class="panel-content fixture-mode-home fixture-code-home">
        <div class="fixture-mode-home-content">
          <div class="fixture-mode-home-heading">
            <span class="fixture-mode-mark">${icon("code")}</span>
            <div><span>TRAE CODE</span><h1>今天想构建什么？</h1><p>从需求、仓库或一段代码开始。</p></div>
          </div>
          <div class="fixture-mode-home-composer">${composerMarkup("描述要实现的功能，或粘贴需要修改的代码")}</div>
          <section class="fixture-code-actions" aria-label="Code 快速开始">
            <button class="inputBarButton">${icon("spark")}<span><strong>创建应用</strong><small>从想法生成可运行项目</small></span></button>
            <button class="inputBarButton">${icon("folder")}<span><strong>打开仓库</strong><small>分析并继续现有代码</small></span></button>
            <button class="inputBarButton">${icon("code")}<span><strong>修复问题</strong><small>定位错误并提交修改</small></span></button>
          </section>
          <section class="fixture-code-recent"><header><strong>最近项目</strong><span>全部</span></header><div><span>${icon("folder")} Agent-Dream-Skin</span><small>刚刚</small></div><div><span>${icon("folder")} DreamSkin Studio</span><small>昨天</small></div></section>
        </div>
      </main>
    </div></div>`;
}

function designHomeMarkup() {
  return `
    <div id="root"><div id="solo-lite-root" class="solo-lite-layout fixture-shell">
      ${sidebarMarkup("design", "home")}
      <main class="panel-content fixture-mode-home fixture-design-home">
        <div class="fixture-mode-home-content fixture-design-content">
          <div class="fixture-mode-home-heading">
            <span class="fixture-mode-mark">${icon("design")}</span>
            <div><span>TRAE DESIGN</span><h1>把想法变成设计</h1><p>选择场景，再描述你希望呈现的视觉结果。</p></div>
          </div>
          <div class="fixture-scene-tabs" role="tablist" aria-label="设计场景">
            <button class="scene-showcase-module__sceneTab___fixture sceneTabActive" data-trae-skin-role="scene-tab" aria-selected="true">${icon("design")} 设计还原</button>
            <button class="scene-showcase-module__sceneTab___fixture" data-trae-skin-role="scene-tab" aria-selected="false">${icon("spark")} 概念成稿</button>
            <button class="scene-showcase-module__sceneTab___fixture" data-trae-skin-role="scene-tab" aria-selected="false">${icon("work")} 规范出图</button>
          </div>
          <section class="scene-showcase-module__casesPanel___fixture fixture-scene-panel" data-trae-skin-role="scene-panel">
            <header><div><strong class="casesPanelTitle-fixture">设计还原</strong><span>从参考图生成高还原度页面</span></div><button class="casesPanelClose-fixture" aria-label="关闭">${icon("x")}</button></header>
            <div class="fixture-scene-cards">
              <article class="scene-showcase-module__caseCard___fixture" data-trae-skin-role="scene-card"><div class="caseCardImage-fixture fixture-case-visual is-layout"><span></span><span></span><span></span></div><strong class="caseCardTitle-fixture">界面复刻</strong><p>上传截图，生成可编辑页面。</p><button class="caseCardAction-fixture">开始设计</button></article>
              <article class="scene-showcase-module__caseCard___fixture" data-trae-skin-role="scene-card"><div class="caseCardImage-fixture fixture-case-visual is-system"><span></span><span></span><span></span></div><strong class="caseCardTitle-fixture">设计系统</strong><p>提取视觉语言与组件规范。</p><button class="caseCardAction-fixture">创建规范</button></article>
              <article class="scene-showcase-module__caseCard___fixture" data-trae-skin-role="scene-card"><div class="caseCardImage-fixture fixture-case-visual is-prototype"><span></span><span></span><span></span></div><strong class="caseCardTitle-fixture">交互原型</strong><p>把流程快速变成可用原型。</p><button class="caseCardAction-fixture">生成原型</button></article>
            </div>
          </section>
        </div>
      </main>
    </div></div>`;
}

function threadMarkup() {
  return `
    <div id="root"><div id="solo-lite-root" class="solo-lite-layout fixture-shell">
      ${sidebarMarkup("work", "thread")}
      <main class="session-panel fixture-thread">
        <header class="fixture-thread-heading"><strong>查看飞书文档</strong><span><i></i> Tool 已连接</span><button class="taskMoreBtn">${icon("more")}</button></header>
        <div class="solo-lite-chat-panel-container fixture-chat">
          <div class="virtualized-message-list-view fixture-message-list">
            <article class="turn__agent-message fixture-agent-message"><span class="fixture-turn-icon">${icon("spark")}</span><div><strong>TRAE</strong><p>我已经读取文档，并整理出当前主题覆盖的界面区域。</p><span class="fixture-tool-result">${icon("check")} 已检查主题结构和组件映射</span></div></article>
            <article class="turn__user-message fixture-user-row"><div class="user-message__text-box" data-trae-skin-role="user-message">把首页、对话页和每一个组件的换肤效果展示出来。</div></article>
            <article class="turn__agent-message fixture-agent-message"><span class="fixture-turn-icon">${icon("work")}</span><div><strong>TRAE</strong><p>预览将直接使用 DreamSkin Tool 的运行时样式，不再维护第二套主题 CSS。</p></div></article>
          </div>
          ${composerMarkup("继续描述需要调整的界面...")}
        </div>
      </main>
    </div></div>`;
}

function componentCell(id: string, title: string, body: string) {
  return `<section class="fixture-component-cell" data-component-id="${id}" data-trae-skin-component="${id}"><header><strong>${title}</strong><code>${id}</code></header><div class="fixture-component-body">${body}</div></section>`;
}

function componentsMarkup() {
  const cells = [
    componentCell("shell.workspace", "工作区", `<div class="component-shell-sample"><span></span><span></span><span></span></div>`),
    componentCell("mode.switcher", "模式切换", `<div class="mode-switcher-btn fixture-mode-switch component-mode-switch" role="tablist" data-mode="work"><span class="fixture-mode-indicator"></span><button role="tab" aria-selected="true">${icon("work")} Work</button><button role="tab" aria-selected="false">${icon("code")} Code</button><button role="tab" aria-selected="false">${icon("design")} Design</button></div>`),
    componentCell("sidebar.task", "任务行", `<div class="task-list-panel component-task-sample"><button>默认任务</button><button class="taskItemSelected" aria-selected="true">选中任务</button><button disabled>禁用任务</button></div>`),
    componentCell("sidebar.utility", "侧栏图标", `<div class="component-icon-row"><button class="taskIconBtn">${icon("list")}</button><button class="taskIconBtnActive" aria-pressed="true">${icon("filter")}</button><button class="taskIconBtn" disabled>${icon("more")}</button></div>`),
    componentCell("composer.surface", "输入区", composerMarkup("输入任务内容")),
    componentCell("action.primary", "主要操作", `<div class="component-action-row"><button class="chat-input-v2-send-button" data-trae-skin-role="primary-action">${icon("send")}</button><button class="component-primary-action" data-trae-skin-role="primary-action">确认应用</button><button class="component-primary-action" data-trae-skin-role="primary-action" disabled>不可用</button></div>`),
    componentCell("message.user", "用户消息", `<div class="turn__user-message component-message-sample"><div class="user-message__text-box" data-trae-skin-role="user-message">这是一条用户消息</div></div>`),
    componentCell("tooltip.surface", "提示", `<div role="tooltip" class="component-tooltip"><div class="container-preview">打开任务列表</div><svg class="arrow-preview" viewBox="0 0 10 5"><path d="M0 0h10L5 5z"/></svg></div>`),
    componentCell("menu.surface", "菜单", `<div role="menu" class="component-menu"><button role="menuitem">${icon("plus")} 新建任务</button><button role="menuitem">${icon("folder")} 移动到项目</button></div>`),
    componentCell("menu.item", "菜单项状态", `<div role="menu" class="component-menu"><button role="menuitem">默认</button><button role="menuitem" class="active" aria-selected="true">选中</button><button role="menuitem" disabled>禁用</button></div>`),
    componentCell("dialog.surface", "对话框", `<div class="icd-modal-content component-dialog" role="dialog"><strong>应用当前主题？</strong><p>将在 TRAE 中应用全部换肤区域。</p><div><button>取消</button><button class="chat-input-v2-send-button" data-trae-skin-role="primary-action">应用</button></div></div>`),
    componentCell("home.title", "首页标题", `<div class="welcomeTitleWrapper component-home-title" data-trae-skin-role="home-title"><h2>今天想创造什么？</h2></div>`),
    componentCell("home.showcase", "首页卡片", `<div class="showcaseWrapper component-showcase"><button class="card-preview" data-trae-skin-role="showcase-card"><span class="cardTitle-preview">构建应用</span><span class="cardDescription-preview">从想法开始</span></button></div>`),
    componentCell("home.sceneTab", "设计场景标签", `<div class="fixture-scene-tabs component-scene-tabs" role="tablist"><button class="scene-showcase-module__sceneTab___fixture sceneTabActive" data-trae-skin-role="scene-tab" aria-selected="true">${icon("design")} 还原</button><button class="scene-showcase-module__sceneTab___fixture" data-trae-skin-role="scene-tab">${icon("spark")} 成稿</button></div>`),
    componentCell("home.scenePanel", "设计场景面板", `<section class="fixture-scene-panel component-scene-panel" data-trae-skin-role="scene-panel"><header><div><strong class="casesPanelTitle-fixture">设计还原</strong><span>参考图生成页面</span></div></header><div class="component-scene-lines"><i></i><i></i><i></i></div></section>`),
    componentCell("home.sceneCard", "设计案例卡片", `<article class="component-scene-card" data-trae-skin-role="scene-card"><div class="caseCardImage-fixture fixture-case-visual is-layout"><span></span><span></span><span></span></div><strong class="caseCardTitle-fixture">界面复刻</strong><button class="caseCardAction-fixture" data-trae-skin-role="primary-action">开始设计</button></article>`),
    componentCell("input.field", "输入与校验", `<div class="component-input-stack"><input value="默认输入" aria-label="默认输入"/><input value="格式有误" aria-invalid="true" aria-label="无效输入"/><input value="不可编辑" disabled aria-label="禁用输入"/></div>`),
    componentCell("selection.control", "选择控件", `<div class="component-selection-row"><label class="arco-checkbox arco-checkbox-checked"><span class="arco-checkbox-mask">${icon("check")}</span><span>已选择</span></label><button class="icube-switch icube-switch-checked" role="switch" aria-label="已开启" aria-checked="true"><span></span></button><button class="icube-switch" role="switch" aria-label="未开启" aria-checked="false"><span></span></button><label class="arco-checkbox arco-checkbox-disabled" aria-disabled="true"><span class="arco-checkbox-mask"></span><span>禁用</span></label><button class="icube-switch icube-switch-disabled" role="switch" aria-label="禁用开关" aria-checked="false" disabled><span></span></button></div>`),
    componentCell("status.badge", "状态标记", `<div class="component-status-row"><span class="status-badge--success" data-status="success">成功</span><span class="status-badge--info" data-status="info">信息</span><span class="status-badge--warning" data-status="warning">警告</span><span class="status-badge--error" data-status="error">错误</span></div>`),
    componentCell("toast.surface", "通知", `<div class="component-toast-stack"><div class="toast-module__toast___preview" role="status" data-status="success">${icon("check")}<span><strong>主题已应用</strong><small>所有视觉插槽已同步</small></span><button aria-label="关闭成功通知">${icon("x")}</button></div><div class="toast-module__toast___preview" role="status" data-status="info">${icon("info")}<span><strong>组件已更新</strong><small>预览已载入最新结果</small></span><button aria-label="关闭信息通知">${icon("x")}</button></div><div class="toast-module__toast___preview" role="status" data-status="warning">${icon("info")}<span><strong>仍需验证</strong><small>应用前请检查目标界面</small></span><button aria-label="关闭警告通知">${icon("x")}</button></div><div class="toast-module__toast___preview" role="alert" data-status="error">${icon("x")}<span><strong>应用失败</strong><small>目标运行时暂时不可用</small></span><button aria-label="关闭错误通知">${icon("x")}</button></div></div>`),
  ];

  const registered = new Set(componentRegistry.components.map((component) => component.id));
  const rendered = new Set(cells.map((cell) => /data-component-id="([^"]+)"/.exec(cell)?.[1]));
  if (registered.size !== rendered.size || [...registered].some((id) => !rendered.has(id))) {
    throw new Error("DreamSkin Tool component preview coverage is out of sync with registry/components.v1.json");
  }

  return `
    <div id="root"><main id="solo-lite-root" class="fixture-components-page">
      <div class="fixture-components-grid">${cells.join("")}</div>
    </main></div>`;
}

function chromeMarkup(theme: StudioTheme) {
  if (theme.layout !== "studio-collage") return "";
  return `
    <div id="trae-dream-skin-chrome" aria-hidden="true">
      <div class="trae-skin-chrome-brand">
        <span id="trae-skin-chrome-kicker">${escapeHtml(theme.brandSubtitle)}</span>
        <strong id="trae-skin-chrome-tagline">${escapeHtml(theme.tagline)}</strong>
        <small id="trae-skin-chrome-quote">${escapeHtml(theme.quote)}</small>
      </div>
      <div class="trae-skin-chrome-status">
        <span id="trae-skin-chrome-status-label">${escapeHtml(theme.statusText)}</span><i></i>
      </div>
      <div class="trae-skin-chrome-doodles">
        <i class="trae-skin-doodle-spark"></i><i class="trae-skin-doodle-loop"></i><i class="trae-skin-doodle-tape"></i>
      </div>
    </div>`;
}

function previewDocument(route: PreviewRoute, mode: PreviewMode | "unknown", theme: StudioTheme, appearanceMode: AppearanceMode) {
  const content = route === "home"
    ? mode === "code"
      ? codeHomeMarkup()
      : mode === "design"
        ? designHomeMarkup()
        : workHomeMarkup()
    : route === "thread"
      ? threadMarkup()
      : componentsMarkup();
  const shell = appearanceMode;
  const escapedRuntimeCss = runtimeCss.replaceAll("</style", "<\\/style");
  const escapedFixtureCss = fixtureCss.replaceAll("</style", "<\\/style");
  const source = `<!doctype html>
    <html class="trae-dream-skin platform-mac" data-trae-skin-active="true" data-trae-skin-theme="${escapeHtml(theme.id)}" data-trae-skin-layout="${escapeHtml(theme.layout)}" data-trae-skin-treatment="${escapeHtml(theme.appearance.treatment)}" data-trae-skin-shadow="${theme.appearance.shadow}" data-trae-skin-shell="${shell}" data-trae-skin-mode="${mode}" data-trae-skin-view="solo" data-trae-skin-route="${route}" ${runtimeVisualAttributes(theme)} style="${escapeHtml(runtimeVariables(theme, appearanceMode))}">
      <head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; script-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="color-scheme" content="light dark"><style>${escapedRuntimeCss}</style><style>${escapedFixtureCss}</style></head>
      <body class="platform-mac trae-dream-skin-body theme-${shell}">${icons}${content}${chromeMarkup(theme)}</body>
    </html>`;
  return annotatePreviewComponents(source);
}

function ToolPreviewFrame({
  title,
  srcDoc,
  frameHeight,
  zoom = 1,
  interactive = false,
  onComponentSelect,
}: {
  title: string;
  srcDoc: string;
  frameHeight: number;
  zoom?: number;
  interactive?: boolean;
  onComponentSelect?: (componentId: string) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [fitScale, setFitScale] = useState(1);
  const scale = fitScale * zoom;

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const update = () => setFitScale(Math.min(1, wrapper.clientWidth / FRAME_WIDTH));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="mcp-frame-viewport" ref={wrapperRef} style={{ height: frameHeight * scale }}>
      <div className="mcp-frame-stage" style={{ width: FRAME_WIDTH * scale, height: frameHeight * scale }}>
        <iframe
          ref={frameRef}
          className="mcp-runtime-frame"
          title={title}
          srcDoc={srcDoc}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          style={{ width: FRAME_WIDTH, height: frameHeight, transform: `scale(${scale})` }}
          onLoad={() => {
            if (!interactive) return;
            const document = frameRef.current?.contentDocument;
            if (!document) return;
            document.documentElement.dataset.dreamskinInteractive = "true";
            const selectComponent = (component: HTMLElement) => {
              document.querySelectorAll("[data-dreamskin-selected]").forEach((node) => {
                node.removeAttribute("data-dreamskin-selected");
              });
              const componentCell = component.closest<HTMLElement>("[data-component-id]");
              (componentCell || component).dataset.dreamskinSelected = "true";
              const componentCellId = componentCell?.dataset.componentId;
              onComponentSelect?.(componentCellId || component.dataset.traeSkinComponent?.split(" ")[0] || "");
            };
            document.querySelectorAll<HTMLElement>("[data-trae-skin-component]").forEach((component) => {
              const componentIds = component.dataset.traeSkinComponent?.split(" ").filter(Boolean) || [];
              const ancestorIds = component.parentElement?.closest<HTMLElement>("[data-trae-skin-component]")?.dataset.traeSkinComponent?.split(" ").filter(Boolean) || [];
              if (componentIds.some((id) => ancestorIds.includes(id))) return;
              const nativelyFocusable = component.matches('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]');
              if (!nativelyFocusable) {
                component.tabIndex = 0;
                component.dataset.dreamskinKeyboardSelectable = "true";
                if (!component.hasAttribute("role")) component.setAttribute("role", "button");
              }
              if (!component.hasAttribute("aria-label")) {
                component.setAttribute("aria-label", `选择组件：${componentIds.join("、")}`);
              }
            });
            document.addEventListener("click", (event) => {
              const target = event.target as Element | null;
              if (!target || typeof target.closest !== "function") return;
              const component = target.closest<HTMLElement>("[data-trae-skin-component]");
              if (!component) return;
              event.preventDefault();
              event.stopPropagation();
              selectComponent(component);
            }, true);
            document.addEventListener("keydown", (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              const target = event.target as Element | null;
              if (event.key === " " && target?.matches("input, textarea, [contenteditable=true]")) return;
              const component = target?.closest<HTMLElement>("[data-trae-skin-component]");
              if (!component) return;
              event.preventDefault();
              event.stopPropagation();
              selectComponent(component);
            }, true);
          }}
        />
      </div>
    </div>
  );
}

const sceneTitles: Record<TraePreviewScene, string> = {
  work: "Work 首页",
  code: "Code 首页",
  design: "Design 首页",
  thread: "对话页",
  components: "组件库",
};

function TraeThemeScenePreview({
  theme,
  appearanceMode,
  scene,
  zoom = 1,
  interactive = false,
  onComponentSelect,
}: {
  theme: StudioTheme;
  appearanceMode: AppearanceMode;
  scene: TraePreviewScene;
  zoom?: number;
  interactive?: boolean;
  onComponentSelect?: (componentId: string) => void;
}) {
  const route: PreviewRoute = scene === "thread" ? "thread" : scene === "components" ? "components" : "home";
  const mode: PreviewMode | "unknown" = scene === "thread" ? "work" : scene === "components" ? "unknown" : scene;
  const srcDoc = useMemo(() => {
    const document = previewDocument(route, mode, theme, appearanceMode);
    if (!interactive) return document;
    return document.replace(
      "</head>",
      `<style>
        html[data-dreamskin-interactive="true"] [data-trae-skin-component] { cursor: pointer; }
        html[data-dreamskin-interactive="true"] [data-trae-skin-component]:hover {
          outline: 2px solid color-mix(in srgb, var(--trae-skin-accent) 68%, white);
          outline-offset: 2px;
        }
        html[data-dreamskin-interactive="true"] [data-trae-skin-component]:focus-visible {
          outline: 3px solid var(--trae-skin-focus) !important;
          outline-offset: 3px !important;
        }
        html[data-dreamskin-interactive="true"] [data-dreamskin-selected="true"] {
          outline: 3px solid var(--trae-skin-accent) !important;
          outline-offset: 3px !important;
        }
      </style></head>`,
    );
  }, [appearanceMode, interactive, mode, route, theme]);

  return (
    <ToolPreviewFrame
      title={`${theme.name} ${sceneTitles[scene]}`}
      srcDoc={srcDoc}
      frameHeight={scene === "components" ? 1340 : 720}
      zoom={zoom}
      interactive={interactive}
      onComponentSelect={onComponentSelect}
    />
  );
}

export function ThemeScenePreview({
  theme,
  appearanceMode,
  scene,
  targetId,
  pluginId,
  zoom = 1,
  interactive = false,
  onComponentSelect,
}: {
  theme: StudioTheme;
  appearanceMode: AppearanceMode;
  scene: ThemePreviewScene;
  targetId?: string;
  pluginId?: string;
  zoom?: number;
  interactive?: boolean;
  onComponentSelect?: (componentId: string) => void;
}) {
  const workBuddy = pluginId === "dreamskin.workbuddy" || targetId?.toLowerCase() === "workbuddy" || scene.startsWith("wb-");
  if (workBuddy) {
    const workBuddyScene: WorkBuddyScene = scene.startsWith("wb-") ? scene as WorkBuddyScene : "wb-home";
    return <WorkBuddyScenePreview theme={theme} appearanceMode={appearanceMode} scene={workBuddyScene} zoom={zoom} interactive={interactive} onComponentSelect={onComponentSelect} />;
  }
  return <TraeThemeScenePreview theme={theme} appearanceMode={appearanceMode} scene={scene as TraePreviewScene} zoom={zoom} interactive={interactive} onComponentSelect={onComponentSelect} />;
}

function PreviewSection({ title, meta, children }: { title: string; meta: string; children: React.ReactNode }) {
  return (
    <section className="mcp-preview-section">
      <header><div><strong>{title}</strong><span>{meta}</span></div><span className="mcp-source-badge"><i />DreamSkin Tool</span></header>
      {children}
    </section>
  );
}

export function ThemeShowcase({ theme, appearanceMode, live = false }: { theme: StudioTheme; appearanceMode: AppearanceMode; live?: boolean }) {
  const workHome = useMemo(() => previewDocument("home", "work", theme, appearanceMode), [theme, appearanceMode]);
  const codeHome = useMemo(() => previewDocument("home", "code", theme, appearanceMode), [theme, appearanceMode]);
  const designHome = useMemo(() => previewDocument("home", "design", theme, appearanceMode), [theme, appearanceMode]);
  const thread = useMemo(() => previewDocument("thread", "work", theme, appearanceMode), [theme, appearanceMode]);
  const components = useMemo(() => previewDocument("components", "unknown", theme, appearanceMode), [theme, appearanceMode]);

  return (
    <div className={`mcp-preview-gallery ${live ? "is-live" : ""}`}>
      <PreviewSection title="Work 首页" meta="新建任务与场景推荐">
        <ToolPreviewFrame title={`${theme.name} Work 首页`} srcDoc={workHome} frameHeight={720} />
      </PreviewSection>
      <PreviewSection title="Code 首页" meta="代码任务与最近项目">
        <ToolPreviewFrame title={`${theme.name} Code 首页`} srcDoc={codeHome} frameHeight={720} />
      </PreviewSection>
      <PreviewSection title="Design 首页" meta="设计场景与案例面板">
        <ToolPreviewFrame title={`${theme.name} Design 首页`} srcDoc={designHome} frameHeight={720} />
      </PreviewSection>
      <PreviewSection title="Work 对话页" meta="选中任务、消息与输入区">
        <ToolPreviewFrame title={`${theme.name} Work 对话页`} srcDoc={thread} frameHeight={720} />
      </PreviewSection>
      <PreviewSection title="组件 UI" meta={`${componentRegistry.components.length} 个语义组件`}>
        <ToolPreviewFrame title={`${theme.name} 组件 UI`} srcDoc={components} frameHeight={1340} />
      </PreviewSection>
    </div>
  );
}
