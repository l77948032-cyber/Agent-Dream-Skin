import { useLayoutEffect, useMemo, useRef, useState } from "react";

import canonicalWorkBuddyCss from "../../plugins/workbuddy/assets/workbuddy-skin.css?raw";
import runtimeMapping from "../../plugins/workbuddy/resources/theme-runtime.v1.json";
import workBuddyCss from "./workbuddy-preview-fixture.css?raw";
import type { AppearanceMode, StudioTheme } from "./themes";

export type WorkBuddyScene =
  | "wb-home"
  | "wb-chat"
  | "wb-result"
  | "wb-market"
  | "wb-automation"
  | "wb-project"
  | "wb-settings"
  | "wb-overlays"
  | "wb-components";

const FRAME_WIDTH = 1200;
type RuntimeFormat = "raw" | "percent" | "px";

const symbols = `
<svg class="wb-symbols" aria-hidden="true">
  <symbol id="wb-home" viewBox="0 0 24 24"><path d="m4 10 8-7 8 7v10H4zM9 20v-6h6v6"/></symbol>
  <symbol id="wb-chat" viewBox="0 0 24 24"><path d="M5 5h14v11H9l-4 4z"/></symbol>
  <symbol id="wb-folder" viewBox="0 0 24 24"><path d="M3 7h7l2 2h9v11H3z"/></symbol>
  <symbol id="wb-book" viewBox="0 0 24 24"><path d="M4 5h6a3 3 0 0 1 3 3v12a3 3 0 0 0-3-3H4zM20 5h-4a3 3 0 0 0-3 3v12a3 3 0 0 1 3-3h4z"/></symbol>
  <symbol id="wb-auto" viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6M12 2v3"/></symbol>
  <symbol id="wb-grid" viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><rect x="14" y="14" width="6" height="6"/></symbol>
  <symbol id="wb-spark" viewBox="0 0 24 24"><path d="m12 3 1.4 4.4L18 9l-4.6 1.6L12 15l-1.4-4.4L6 9l4.6-1.6zM5 15l.7 2.3L8 18l-2.3.7L5 21l-.7-2.3L2 18l2.3-.7z"/></symbol>
  <symbol id="wb-code" viewBox="0 0 24 24"><path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 4l-4 16"/></symbol>
  <symbol id="wb-design" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h2a6 6 0 0 0-3-10Z"/><circle cx="7.5" cy="11" r=".8"/><circle cx="9" cy="7" r=".8"/><circle cx="14" cy="7" r=".8"/></symbol>
  <symbol id="wb-search" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></symbol>
  <symbol id="wb-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
  <symbol id="wb-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></symbol>
  <symbol id="wb-check" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></symbol>
  <symbol id="wb-play" viewBox="0 0 24 24"><path d="m8 5 11 7-11 7z"/></symbol>
  <symbol id="wb-send" viewBox="0 0 24 24"><path d="m4 12 16-8-5 16-3-6zM12 14l8-10"/></symbol>
  <symbol id="wb-paperclip" viewBox="0 0 24 24"><path d="m20 12-8 8a6 6 0 0 1-8-8l9-9a4 4 0 0 1 6 6l-9 9a2 2 0 0 1-3-3l8-8"/></symbol>
  <symbol id="wb-chevron" viewBox="0 0 24 24"><path d="m8 10 4 4 4-4"/></symbol>
  <symbol id="wb-file" viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h5"/></symbol>
  <symbol id="wb-bell" viewBox="0 0 24 24"><path d="M6 16V9a6 6 0 0 1 12 0v7l2 2H4zM10 21h4"/></symbol>
  <symbol id="wb-settings" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/></symbol>
  <symbol id="wb-x" viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17"/></symbol>
</svg>`;

const icon = (name: string) => `<svg class="wb-icon" aria-hidden="true"><use href="#wb-${name}" /></svg>`;

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

function readableMix(value: number, factor: number, minimum: number, maximum: number) {
  const percentage = Math.min(maximum, Math.max(minimum, value * factor * 100));
  return `${Math.round(percentage * 100) / 100}%`;
}

function overlayTint(value: string) {
  return value.replaceAll(" ", "").toLowerCase() === "rgba(4,8,18,0.28)" ? "transparent" : value;
}

function backgroundPosition(theme: StudioTheme) {
  const configured = theme.appearance.backgroundPosition;
  if (configured !== "center center") return configured;
  if (/^(?:orchid-night|harbor-focus)(?:-|$)/.test(theme.id)) return "right center";
  if (/^paper-garden(?:-|$)/.test(theme.id)) return "left center";
  return configured;
}

function variables(theme: StudioTheme, appearanceMode: AppearanceMode) {
  const entries: Array<[string, string]> = [["--dreamskin-art", `url("${cssValue(theme.imageUrl)}")`]];

  for (const [key, variable] of Object.entries(runtimeMapping.colors)) {
    entries.push([variable, theme.colors[key as keyof StudioTheme["colors"]]]);
  }
  for (const [key, variable] of Object.entries(runtimeMapping.states)) {
    entries.push([variable, theme.states[key as keyof StudioTheme["states"]]]);
  }
  for (const [key, descriptor] of Object.entries(runtimeMapping.appearance)) {
    let value = theme.appearance[key as keyof StudioTheme["appearance"]];
    if (key === "backgroundOverlay" && typeof value === "string") value = overlayTint(value);
    if (key === "backgroundPosition") value = backgroundPosition(theme);
    entries.push([descriptor.variable, formatAppearance(value, descriptor.format as RuntimeFormat)]);
  }

  const scheme = theme.appearance.colorScheme === "system" ? appearanceMode : theme.appearance.colorScheme;
  entries.push(
    ["--dreamskin-background", theme.colors.background],
    ["--dreamskin-surface-hover", theme.states.surfaceHover],
    ["--dreamskin-surface-active", theme.states.surfaceActive],
    ["--dreamskin-surface-mix", String(theme.appearance.surfaceOpacity)],
    ["--dreamskin-sidebar-mix", String(theme.appearance.sidebarOpacity)],
    ["--dreamskin-reading-mix", readableMix(theme.appearance.surfaceOpacity, 0.5, 24, 44)],
    ["--dreamskin-composer-mix", readableMix(theme.appearance.surfaceOpacity, 0.82, 64, 76)],
    ["--dreamskin-sidebar-readable-mix", readableMix(theme.appearance.sidebarOpacity, 0.7, 48, 68)],
    ["--dreamskin-overlay-tint", overlayTint(theme.appearance.backgroundOverlay)],
    ["--dreamskin-color-scheme", scheme],
  );
  return entries.map(([name, value]) => `${name}:${value}`).join(";");
}

function runtimeVisualAttributes(theme: StudioTheme) {
  return Object.entries(runtimeMapping.visualAttributes)
    .map(([key, attribute]) => `${attribute}="${escapeHtml(theme.visual[key as keyof StudioTheme["visual"]])}"`)
    .join(" ");
}

function tagged(id: string, body: string, className = "") {
  return `<div class="${className}" data-dreamskin-component="${id}" data-workbuddy-skin-component="${id}">${body}</div>`;
}

function titlebar(title: string, subtitle: string) {
  return tagged("shell.titlebar", `
    <div class="wb-title-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle)}</span></div>
    <label class="wb-global-search">${icon("search")}<span>搜索任务、技能与文件</span><kbd>⌘ K</kbd></label>
    <div class="wb-title-actions"><button aria-label="通知">${icon("bell")}<i></i></button><button aria-label="设置">${icon("settings")}</button><span class="wb-avatar">A</span></div>
  `, "wb-titlebar workbuddy-topbar");
}

function sidebar(active: string) {
  const nav = [
    ["home", "home", "首页"],
    ["chat", "chat", "任务"],
    ["projects", "folder", "项目"],
    ["resources", "book", "资源中心"],
    ["automation", "auto", "自动化"],
  ].map(([id, iconName, label]) => `<button class="${active === id ? "is-active" : ""}" aria-current="${active === id ? "page" : "false"}">${icon(iconName)}<span>${label}</span>${id === "chat" ? "<b>3</b>" : ""}</button>`).join("");
  return `
    <aside class="wb-sidebar conversation-sidebar" data-view-id="sidebar">
      <div class="wb-brand"><span>${icon("spark")}</span><strong>WorkBuddy</strong></div>
      ${tagged("sidebar.navigation", `<nav>${nav}</nav>`, "wb-nav")}
      <div class="wb-side-label"><span>工作空间</span><button aria-label="新建项目">${icon("plus")}</button></div>
      ${tagged("sidebar.project", `
        <button class="is-current"><span class="wb-project-mark is-mint"></span><span>产品发布计划</span><small>8</small></button>
        <button><span class="wb-project-mark is-coral"></span><span>品牌内容</span><small>4</small></button>
        <button><span class="wb-project-mark is-blue"></span><span>Agent Lab</span><small>12</small></button>
      `, "wb-project-list")}
      <div class="wb-side-footer"><span class="wb-avatar">A</span><div><strong>Alvin</strong><small>个人空间</small></div>${icon("more")}</div>
    </aside>`;
}

function shell(active: string, title: string, subtitle: string, content: string) {
  const mainClass = active === "chat" ? " main-content--chat" : "";
  return tagged("shell.workspace", `${sidebar(active)}<section class="wb-main teams-content-wrapper main-content${mainClass}" data-view-id="main-content">${titlebar(title, subtitle)}${content}</section>`, "wb-shell teams-container is-mac");
}

function homeModePill() {
  return `<div class="wb-mode-pill" role="tablist" aria-label="首页场景"><button class="is-active">${icon("grid")}日常办公</button><button>${icon("code")}代码开发</button><button>${icon("design")}设计创意</button></div>`;
}

function homeHero() {
  return tagged("home.hero", `
    <div class="wb-hero-art"></div><div class="wb-hero-scrim"></div>
    <div class="wb-hero-copy"><span>TODAY</span><h1>早上好，今天一起推进重要工作</h1><p>你有 3 个进行中的任务，下一场会议将在 14:30 开始。</p><button>${icon("spark")}开始今日任务</button></div>
    <div class="wb-hero-note"><span>14:30</span><strong>产品周会</strong><small>会议纪要将自动整理</small></div>
  `, "wb-home-hero");
}

function quickAction(iconName: string, title: string, detail: string, accent: string) {
  return tagged("home.quickAction", `<span class="wb-quick-icon ${accent}">${icon(iconName)}</span><div><strong>${title}</strong><small>${detail}</small></div><button aria-label="打开">${icon("chevron")}</button>`, "wb-quick-card quick-actions__item");
}

function homeScene() {
  const content = `<div class="wb-page wb-home-page">${homeModePill()}${homeHero()}
    <section class="wb-quick-grid">${quickAction("file", "整理周报", "汇总本周任务与文档", "is-red")}${quickAction("chat", "会议纪要", "从录音提炼结论与待办", "is-teal")}${quickAction("book", "资料研究", "搜索并生成可信摘要", "is-blue")}${quickAction("auto", "流程自动化", "将重复工作交给 WorkBuddy", "is-gold")}</section>
    <div class="wb-dashboard-grid"><section class="wb-agenda"><header><div><strong>今日安排</strong><span>7 月 20 日 · 周一</span></div><button>查看日历</button></header><article><time>10:00</time><i class="is-teal"></i><div><strong>设计评审</strong><span>品牌内容 · 45 分钟</span></div><span class="wb-chip">线上</span></article><article><time>14:30</time><i class="is-red"></i><div><strong>产品周会</strong><span>产品发布计划 · 60 分钟</span></div><span class="wb-chip">会议室 A</span></article></section><section class="wb-progress"><header><strong>本周进度</strong><span>68%</span></header><div class="wb-ring"><b>12</b><span>已完成</span></div><div class="wb-progress-bars"><span><i style="width:82%"></i></span><small>目标 18 项 · 剩余 6 项</small></div></section></div>
  </div>`;
  return shell("home", "工作台", "首页", content);
}

function composer() {
  return tagged("composer.surface", `<div class="wb-composer-editor">继续告诉 WorkBuddy 需要做什么...</div><footer><div>${tagged("composer.tool", `<button aria-label="添加附件">${icon("paperclip")}</button><button>${icon("spark")}深度思考</button><button>Agent Pro ${icon("chevron")}</button>`, "wb-composer-tools")}</div><button class="wb-send" aria-label="发送">${icon("send")}</button></footer>`, "wb-composer wb-input-footer");
}

function threadScene() {
  const content = `<div class="wb-task-shell"><aside class="wb-task-list"><header><div><strong>任务</strong><span>今天</span></div><button>${icon("plus")}</button></header><label>${icon("search")}搜索任务</label><button class="is-selected"><span class="wb-task-type is-blue">${icon("file")}</span><div><strong>整理产品发布资料</strong><small>正在生成发布清单...</small></div><time>刚刚</time></button><button><span class="wb-task-type is-red">${icon("design")}</span><div><strong>生成首页视觉方案</strong><small>已完成 6 张设计稿</small></div><time>12:40</time></button><button><span class="wb-task-type is-teal">${icon("code")}</span><div><strong>检查构建失败</strong><small>已修复类型错误</small></div><time>昨天</time></button></aside>
    <section class="wb-conversation chat-container wb-cb-chat"><header><div><strong>整理产品发布资料</strong><span><i></i>Agent 正在工作</span></div><button>${icon("more")}</button></header>${tagged("chat.timeline", `
      ${tagged("chat.message.user", `<p>读取产品发布计划和会议纪要，整理一份本周发布清单，按负责人归类。</p><time>14:18</time>`, "wb-message is-user")}
      ${tagged("chat.message.agent", `<span class="wb-agent-mark">${icon("spark")}</span><div><strong>WorkBuddy</strong><p>我会先读取项目里的相关资料，再将任务按负责人和截止时间合并。</p></div>`, "wb-message is-agent")}
      ${tagged("chat.toolCall", `<header><span>${icon("folder")}读取项目资料</span><span class="wb-status-success">已完成</span></header><div><span>${icon("file")}发布计划.docx</span><span>${icon("file")}周会纪要.md</span><span>${icon("file")}负责人清单.xlsx</span></div>`, "wb-tool-call")}
      ${tagged("chat.message.agent", `<span class="wb-agent-mark">${icon("check")}</span><div><strong>WorkBuddy</strong><p>发布清单已经整理完成。我标记了 2 个缺少负责人、1 个临近截止时间的事项，并在右侧生成了可编辑表格。</p><div class="wb-inline-actions"><button>查看结果</button><button>继续完善</button></div></div>`, "wb-message is-agent")}
    `, "wb-timeline")}${composer()}</section>
    ${tagged("result.shell", `<header>${tagged("result.tabs", `<button class="is-active">发布清单</button><button>来源</button><button>运行记录</button>`, "wb-result-tabs")}<button>${icon("more")}</button></header>${tagged("result.artifact", `<div class="wb-table"><div><strong>事项</strong><strong>负责人</strong><strong>截止</strong><strong>状态</strong></div><div><span>上线公告</span><span>Lin</span><span>7/22</span><b class="is-progress">进行中</b></div><div><span>应用商店素材</span><span>Mia</span><span>7/21</span><b class="is-warning">待确认</b></div><div><span>版本回归</span><span>Chen</span><span>7/23</span><b class="is-done">已安排</b></div></div>`, "wb-result-preview")}`, "wb-result-side detail-panel-container")}
  </div>`;
  return shell("chat", "任务", "对话与执行", content);
}

function resultsScene() {
  const content = tagged("result.shell", `<div class="wb-results-page"><header class="wb-results-heading"><div><span>产品发布计划</span><strong>发布站点与交付文件</strong></div><div><button>分享</button><button class="is-primary">${icon("play")}预览</button></div></header>${tagged("result.tabs", `<button class="is-active">概览</button><button>产物</button><button>文件</button><button>代码差异 <b>8</b></button><button>浏览器</button>`, "wb-results-tabs")}
    <div class="wb-results-workspace">${tagged("result.fileTree", `<header><strong>项目文件</strong><button>${icon("more")}</button></header><div><span>${icon("folder")}src</span><span class="is-indent is-active">${icon("file")}App.tsx</span><span class="is-indent">${icon("file")}styles.css</span><span>${icon("folder")}public</span><span>${icon("file")}package.json</span></div>`, "wb-file-tree")}${tagged("result.artifact", `<div class="wb-editor-tabs"><span class="is-active">App.tsx</span><span>styles.css</span></div><div class="wb-editor"><ol><li>import <b>{ useMemo }</b> from <em>&quot;react&quot;</em>;</li><li></li><li><b>export default function</b> ReleasePage() {</li><li>  <b>return</b> (</li><li class="is-added">+   &lt;main className=&quot;release&quot;&gt;</li><li class="is-added">+     &lt;LaunchChecklist /&gt;</li><li class="is-added">+   &lt;/main&gt;</li><li>  );</li><li>}</li></ol></div><footer><span><i></i>开发服务器运行中</span><span>localhost:4173</span></footer>`, "wb-artifact-editor")}<aside class="wb-browser-preview"><header><i></i><i></i><i></i><span>localhost:4173</span></header><div class="wb-browser-art"><span>LAUNCH WEEK</span><strong>Ship work<br/>people remember.</strong><button>View release</button></div></aside></div>
  </div>`, "wb-results-shell");
  return shell("chat", "结果区", "产物、文件与预览", content);
}

function marketCard(kind: string, title: string, text: string, accent: string, installed = false) {
  return tagged("market.card", `<div class="wb-market-visual ${accent}"><span>${icon(kind)}</span><i></i></div><div class="wb-market-copy"><span>${kind === "spark" ? "专家" : kind === "grid" ? "技能" : "连接器"}</span><strong>${title}</strong><p>${text}</p><footer><small><i></i>${installed ? "已添加" : "DreamSkin 精选"}</small><button class="${installed ? "is-installed" : ""}">${installed ? icon("check") + "已添加" : icon("plus") + "添加"}</button></footer></div>`, "wb-market-card");
}

function resourcesScene() {
  const content = `<div class="wb-page wb-market-page"><header class="wb-market-heading"><div><span>WORKBUDDY RESOURCES</span><h1>把专业能力加入工作台</h1><p>专家、技能与连接器可以直接用于每一个任务。</p></div><span class="wb-market-orbit">${icon("spark")}</span></header>${tagged("market.toolbar", `<div role="tablist"><button class="is-active">全部</button><button>专家</button><button>技能</button><button>连接器</button></div><label>${icon("search")}搜索资源</label><button>最受欢迎 ${icon("chevron")}</button>`, "wb-market-toolbar")}
    <section class="wb-market-feature"><div><span>本周推荐</span><strong>产品发布专家</strong><p>从计划、内容到上线验证，帮你协调完整发布流程。</p><button>${icon("plus")}添加到 WorkBuddy</button></div><div class="wb-expert-portrait"><span>${icon("spark")}</span></div></section>
    <section class="wb-market-grid">${marketCard("spark", "研究与洞察", "跨来源检索、验证并生成带引用的洞察报告。", "is-violet")}${marketCard("grid", "表格分析", "清理数据，生成公式、透视和可视化结果。", "is-green", true)}${marketCard("book", "飞书文档", "读取、创建并整理团队空间里的内容。", "is-blue")}${marketCard("code", "代码审查", "检查风险、回归与缺失测试，给出可执行建议。", "is-orange")}${marketCard("auto", "日程助理", "协调日历、会议准备与后续行动。", "is-red")}${marketCard("folder", "本地文件", "在授权工作区中读取和整理项目文件。", "is-cyan", true)}</section>
  </div>`;
  return shell("resources", "资源中心", "专家、技能与连接器", content);
}

function automationScene() {
  const content = `<div class="wb-page wb-automation-page"><header class="wb-page-heading"><div><span>AUTOMATIONS</span><h1>自动化</h1><p>让重复任务在需要时自己开始。</p></div><button class="wb-primary">${icon("plus")}新建自动化</button></header><div class="wb-automation-summary"><article><span class="is-blue">${icon("auto")}</span><div><small>已启用</small><strong>6</strong></div><i>+2 本月</i></article><article><span class="is-green">${icon("check")}</span><div><small>本周运行</small><strong>42</strong></div><i>98% 成功</i></article><article><span class="is-orange">${icon("play")}</span><div><small>节省时间</small><strong>8.4h</strong></div><i>约 1 个工作日</i></article></div>
    <div class="wb-automation-layout"><section><header><div><strong>自动化任务</strong><span>按下次运行排序</span></div><button>筛选</button></header>${tagged("automation.task", `<span class="wb-auto-icon is-blue">${icon("file")}</span><div><strong>每日项目摘要</strong><span>每天 09:00 · 产品发布计划</span></div><b class="wb-status-success">已启用</b><small>明天 09:00</small><button>${icon("more")}</button>`, "wb-automation-task")}${tagged("automation.task", `<span class="wb-auto-icon is-red">${icon("chat")}</span><div><strong>会后行动项</strong><span>会议结束后 · 所有日历</span></div><b class="wb-status-success">已启用</b><small>等待触发</small><button>${icon("more")}</button>`, "wb-automation-task")}${tagged("automation.task", `<span class="wb-auto-icon is-gold">${icon("book")}</span><div><strong>周报归档</strong><span>每周五 18:30 · 团队空间</span></div><b class="wb-status-muted">已暂停</b><small>未安排</small><button>${icon("more")}</button>`, "wb-automation-task")}</section><aside><header><strong>最近运行</strong><button>全部记录</button></header>${tagged("automation.run", `<i class="is-success">${icon("check")}</i><div><strong>每日项目摘要</strong><span>今天 09:00 · 18 秒</span></div><small>成功</small>`, "wb-auto-run")}${tagged("automation.run", `<i class="is-success">${icon("check")}</i><div><strong>会后行动项</strong><span>昨天 16:42 · 31 秒</span></div><small>成功</small>`, "wb-auto-run")}${tagged("automation.run", `<i class="is-warning">!</i><div><strong>竞品新闻追踪</strong><span>昨天 08:00 · 2 分钟</span></div><small>需检查</small>`, "wb-auto-run")}</aside></div>
  </div>`;
  return shell("automation", "自动化", "任务与运行记录", content);
}

function projectCard(title: string, detail: string, accent: string, tasks: number, progress: number) {
  return tagged("project.card", `<header><span class="wb-project-tile ${accent}">${icon("folder")}</span><button aria-label="项目菜单">${icon("more")}</button></header><strong>${title}</strong><p>${detail}</p><div class="wb-project-members"><span>A</span><span>M</span><span>L</span><small>+2</small></div><footer><span><i style="width:${progress}%"></i></span><small>${tasks} 个任务 · ${progress}%</small></footer>`, "wb-project-card");
}

function projectScene() {
  const content = `<div class="wb-page wb-project-page"><header class="wb-page-heading"><div><span>PROJECTS</span><h1>项目与空间</h1><p>集中查看项目、成员、活动和交付文件。</p></div>${tagged("action.primary", `<button class="wb-primary">${icon("plus")}新建项目</button>`, "wb-primary-wrap")}</header>
    <section class="wb-project-grid">${projectCard("产品发布计划", "版本准备、商店素材与发布检查", "is-teal", 18, 68)}${projectCard("品牌内容", "季度故事、视觉资产与内容排期", "is-coral", 12, 42)}${projectCard("Agent Lab", "WorkBuddy 自动化和内部实验", "is-blue", 24, 81)}</section>
    <div class="wb-project-lower"><section class="wb-project-activity"><header><div><strong>最近活动</strong><span>所有项目</span></div><button>查看全部</button></header><article><span class="wb-avatar">M</span><div><strong>Mia 更新了发布清单</strong><small>产品发布计划 · 8 分钟前</small></div><b class="is-info">更新</b></article><article><span class="wb-avatar">L</span><div><strong>Lin 上传了 6 个视觉稿</strong><small>品牌内容 · 34 分钟前</small></div><b class="is-success">完成</b></article><article><span class="wb-avatar">A</span><div><strong>自动化生成了测试报告</strong><small>Agent Lab · 1 小时前</small></div><b class="is-warning">检查</b></article></section>
      ${tagged("result.fileTree", `<header><div><strong>最近文件</strong><span>跨项目</span></div><button>${icon("more")}</button></header><div><span class="is-active">${icon("file")}发布清单.xlsx <small>刚刚</small></span><span>${icon("file")}首页视觉.fig <small>12:40</small></span><span>${icon("file")}自动化报告.md <small>昨天</small></span></div>${tagged("empty.state", `<span>${icon("folder")}</span><div><strong>归档区为空</strong><small>归档项目会显示在这里</small></div>`, "wb-project-empty")}`, "wb-project-files")}
    </div>
  </div>`;
  return shell("projects", "项目与空间", "项目、成员与活动", content);
}

function settingsScene() {
  const content = `<div class="wb-page wb-settings-page"><header class="wb-page-heading"><div><span>SETTINGS</span><h1>设置</h1><p>管理 WorkBuddy 的外观、Agent 与自动化偏好。</p></div><span class="wb-settings-saved">${icon("check")}所有更改已保存</span></header>
    <div class="wb-settings-layout"><nav><button class="is-active">${icon("settings")}通用</button><button>${icon("spark")}Agent</button><button>${icon("bell")}通知</button><button>${icon("auto")}自动化</button><button>${icon("folder")}数据与权限</button></nav><main>
      ${tagged("settings.section", `<header><div><strong>个人资料</strong><span>用于协作空间和生成内容署名</span></div></header><div class="wb-profile-row"><span class="wb-avatar">A</span>${tagged("input.field", `<label><span>显示名称</span><input value="Alvin" aria-label="显示名称" /></label><label><span>工作邮箱</span><input value="alvin@example.com" aria-label="工作邮箱" /></label>`, "wb-settings-fields")}</div>`, "wb-settings-section")}
      ${tagged("settings.section", `<header><div><strong>工作偏好</strong><span>控制任务完成后的默认行为</span></div></header>${tagged("selection.control", `<label><div><strong>自动整理结果</strong><small>将产物归档到对应项目</small></div><button class="demo-switch is-on" role="switch" aria-checked="true"><i></i></button></label><label><div><strong>运行前确认</strong><small>执行外部操作前请求确认</small></div><button class="demo-switch is-on" role="switch" aria-checked="true"><i></i></button></label><label><div><strong>精简通知</strong><small>仅提醒需要处理的状态</small></div><button class="demo-switch" role="switch" aria-checked="false"><i></i></button></label>`, "wb-settings-controls")}`, "wb-settings-section")}
      ${tagged("settings.section", `<header><div><strong>默认 Agent</strong><span>新任务将优先使用此 Agent</span></div></header><div class="wb-agent-choice"><span>${icon("spark")}</span><div><strong>WorkBuddy Pro</strong><small>已连接 · 支持本地工具</small></div><button>更换 ${icon("chevron")}</button></div>`, "wb-settings-section")}
      <div class="wb-settings-actions">${tagged("action.primary", `<button class="wb-primary">保存设置</button>`, "wb-primary-wrap")}<button>恢复默认</button></div>
    </main></div>
  </div>`;
  return shell("settings", "设置", "偏好、账号与权限", content);
}

function overlaysScene() {
  const content = `<div class="wb-page wb-overlays-page"><header class="wb-page-heading"><div><span>OVERLAYS &amp; STATES</span><h1>浮层与状态</h1><p>检查菜单、弹窗、提示、通知和全部语义状态。</p></div><span class="wb-overlay-live"><i></i>交互状态预览</span></header>
    <div class="wb-overlay-toolbar">${tagged("input.field", `<label>${icon("search")}<input value="搜索任务" aria-label="搜索任务" /></label>`, "wb-overlay-search")}${tagged("selection.control", `<button class="is-active">默认</button><button>悬停</button><button>聚焦</button><button disabled>禁用</button>`, "wb-overlay-segments")}${tagged("action.primary", `<button class="wb-primary">${icon("plus")}主要操作</button>`, "wb-primary-wrap")}</div>
    <section class="wb-overlay-stage"><div class="wb-overlay-underlay"><span></span><span></span><span></span><div></div></div>
      ${tagged("overlay.menu", `<header>任务操作</header><button class="is-active">${icon("file")}打开结果 <kbd>↵</kbd></button><button>${icon("folder")}移到项目</button><button>${icon("auto")}创建自动化</button><hr/><button class="is-danger">删除任务</button>`, "wb-overlay-menu")}
      ${tagged("overlay.dialog", `<div class="wb-dialog-icon">${icon("spark")}</div><strong>应用当前主题？</strong><p>WorkBuddy 的 8 个界面与全部状态会立即更新。</p><div>${tagged("action.primary", `<button class="is-primary">确认应用</button>`, "wb-dialog-primary")}<button>取消</button></div>`, "wb-overlay-dialog")}
      ${tagged("overlay.tooltip", `打开任务列表 <kbd>⌘ 1</kbd><i></i>`, "wb-overlay-tooltip")}
      ${tagged("status.toast", `<span>${icon("check")}</span><div><strong>主题已通过验证</strong><small>32 个组件状态均可读取。</small></div><button>${icon("x")}</button>`, "wb-overlay-toast")}
    </section>
    <div class="wb-state-strip">${tagged("status.badge", `<span class="is-success">成功</span><span class="is-info">信息</span><span class="is-warning">警告</span><span class="is-error">错误</span><span class="is-muted">禁用</span>`, "demo-badges")}${tagged("loading.skeleton", `<i></i><span></span><span></span><span></span>`, "demo-skeleton")}${tagged("empty.state", `<span>${icon("folder")}</span><div><strong>还没有结果</strong><small>运行任务后会显示在这里</small></div><button>${icon("plus")}新建任务</button>`, "wb-state-empty")}</div>
  </div>`;
  return shell("", "浮层与状态", "菜单、弹窗与反馈", content);
}

function cell(id: string, title: string, body: string, className = "") {
  return `<section class="wb-component-cell ${className}" data-dreamskin-component="${id}" data-workbuddy-skin-component="${id}"><header><strong>${title}</strong><code>${id}</code></header><div class="wb-component-demo">${body}</div></section>`;
}

function componentsScene() {
  const cells = [
    cell("shell.workspace", "工作台外壳", `<div class="demo-shell"><i></i><span></span><span></span></div>`),
    cell("shell.titlebar", "窗口标题栏", `<div class="demo-titlebar"><b></b><label>${icon("search")}搜索</label><span class="wb-avatar">A</span></div>`),
    cell("sidebar.navigation", "侧栏导航", `<div class="demo-nav"><button>${icon("home")}</button><button class="is-active">${icon("chat")}</button><button disabled>${icon("folder")}</button></div>`),
    cell("sidebar.project", "项目列表", `<div class="demo-list"><span>默认项目</span><span class="is-selected">选中项目</span><span class="is-disabled">不可用</span></div>`),
    cell("home.hero", "首页主视觉", `<div class="demo-hero"><span>TODAY</span><strong>今天一起完成重要工作</strong><button>开始任务</button></div>`, "is-wide"),
    cell("home.quickAction", "快捷操作", `<div class="demo-quick"><span>${icon("spark")}</span><div><strong>整理周报</strong><small>汇总任务与文档</small></div>${icon("chevron")}</div>`),
    cell("chat.timeline", "对话时间线", `<div class="demo-timeline"><i></i><span></span><span></span><span></span></div>`),
    cell("chat.message.user", "用户消息", `<div class="demo-user-message">把资料整理成发布清单。</div>`),
    cell("chat.message.agent", "Agent 消息", `<div class="demo-agent-message"><span>${icon("spark")}</span><p>已经读取资料并完成整理。</p></div>`),
    cell("chat.toolCall", "工具调用", `<div class="demo-tool"><span>${icon("folder")}读取项目文件</span><b>${icon("check")}已完成</b></div>`),
    cell("composer.surface", "任务输入区", `<div class="demo-composer"><span>描述下一步任务...</span><button>${icon("send")}</button></div>`, "is-wide"),
    cell("composer.tool", "输入区工具", `<div class="demo-tools"><button>${icon("paperclip")}</button><button class="is-active">${icon("spark")}深度思考</button><button disabled>不可用</button></div>`),
    cell("action.primary", "主要操作", `<div class="demo-actions"><button class="is-primary">主要操作</button><button>次要操作</button><button class="is-loading"><i></i>处理中</button><button disabled>不可用</button></div>`, "is-wide"),
    cell("result.shell", "结果工作区", `<div class="demo-result-shell"><aside></aside><main><i></i><i></i><i></i></main></div>`),
    cell("result.tabs", "结果标签", `<div class="demo-tabs"><button class="is-active">概览</button><button>文件</button><button disabled>浏览器</button></div>`),
    cell("result.artifact", "结果产物", `<div class="demo-artifact"><span></span><span></span><span></span><b></b></div>`),
    cell("result.fileTree", "文件列表", `<div class="demo-file-tree"><span>${icon("folder")}src</span><span class="is-active">${icon("file")}App.tsx</span><span>${icon("file")}styles.css</span></div>`),
    cell("market.toolbar", "资源筛选", `<div class="demo-market-toolbar"><button class="is-active">全部</button><button>专家</button><label>${icon("search")}搜索</label></div>`),
    cell("market.card", "资源卡片", `<div class="demo-market-card"><span>${icon("spark")}</span><div><strong>研究与洞察</strong><small>专家 · 精选</small></div><button>${icon("plus")}</button></div>`),
    cell("automation.task", "自动化任务", `<div class="demo-auto-task"><span>${icon("auto")}</span><div><strong>每日摘要</strong><small>每天 09:00</small></div><b>已启用</b></div>`),
    cell("automation.run", "运行记录", `<div class="demo-run"><i>${icon("check")}</i><span>运行成功</span><small>18 秒</small></div>`),
    cell("project.card", "项目卡片", `<div class="demo-project"><span class="wb-project-mark is-coral"></span><div><strong>品牌内容</strong><small>4 个任务</small></div>${icon("more")}</div>`),
    cell("settings.section", "设置面板", `<div class="demo-settings"><span><strong>自动验证</strong><small>修改后检查结果</small></span><button class="demo-switch is-on"><i></i></button></div>`),
    cell("input.field", "输入框", `<div class="demo-inputs"><input value="默认输入" aria-label="默认输入"/><input class="is-focus" value="聚焦状态" aria-label="聚焦输入"/><input class="is-error" value="格式有误" aria-invalid="true"/><input value="不可编辑" disabled/></div>`, "is-wide"),
    cell("selection.control", "选择控件", `<div class="demo-selection"><label><input type="checkbox" checked readonly/>已选择</label><label><input type="checkbox"/>未选择</label><button class="demo-switch is-on"><i></i></button><button class="demo-switch"><i></i></button><button class="demo-switch" disabled><i></i></button></div>`),
    cell("overlay.menu", "菜单", `<div class="demo-menu"><button>默认菜单项</button><button class="is-active">当前菜单项</button><button disabled>不可用</button></div>`),
    cell("overlay.dialog", "对话框", `<div class="demo-dialog"><strong>应用当前主题？</strong><p>所有可用界面将立即更新。</p><div><button>取消</button><button class="is-primary">应用</button></div></div>`, "is-wide"),
    cell("overlay.tooltip", "提示", `<div class="demo-tooltip">打开任务列表<i></i></div>`),
    cell("status.badge", "状态标记", `<div class="demo-badges"><span class="is-success">成功</span><span class="is-info">信息</span><span class="is-warning">警告</span><span class="is-error">错误</span><span class="is-muted">禁用</span></div>`),
    cell("status.toast", "通知", `<div class="demo-toasts"><div class="is-success">${icon("check")}<span><strong>任务已完成</strong><small>结果已经保存</small></span>${icon("x")}</div><div class="is-warning">!<span><strong>需要检查</strong><small>一个步骤未确认</small></span>${icon("x")}</div></div>`, "is-wide"),
    cell("loading.skeleton", "加载状态", `<div class="demo-skeleton"><i></i><span></span><span></span><span></span></div>`),
    cell("empty.state", "空状态", `<div class="demo-empty"><span>${icon("folder")}</span><strong>还没有内容</strong><small>创建第一个项目开始工作</small><button>${icon("plus")}新建项目</button></div>`),
  ];
  return `<main class="wb-components-page"><header><div><span>WORKBUDDY UI</span><h1>组件与状态</h1><p>主题运行时覆盖的完整语义组件。</p></div><span>${cells.length} COMPONENTS</span></header><div class="wb-components-grid">${cells.join("")}</div></main>`;
}

const sceneTitles: Record<WorkBuddyScene, string> = {
  "wb-home": "首页",
  "wb-chat": "对话",
  "wb-result": "结果与产物",
  "wb-market": "专家与技能",
  "wb-automation": "自动化",
  "wb-project": "项目与空间",
  "wb-settings": "设置",
  "wb-overlays": "浮层与状态",
  "wb-components": "组件与状态",
};

function sceneMarkup(scene: WorkBuddyScene) {
  if (scene === "wb-home") return homeScene();
  if (scene === "wb-chat") return threadScene();
  if (scene === "wb-result") return resultsScene();
  if (scene === "wb-market") return resourcesScene();
  if (scene === "wb-automation") return automationScene();
  if (scene === "wb-project") return projectScene();
  if (scene === "wb-settings") return settingsScene();
  if (scene === "wb-overlays") return overlaysScene();
  return componentsScene();
}

function previewDocument(scene: WorkBuddyScene, theme: StudioTheme, appearanceMode: AppearanceMode, interactive: boolean) {
  const visualAttributes = runtimeVisualAttributes(theme);
  const source = `<!doctype html><html class="workbuddy-dream-skin" data-dreamskin-preview="true" data-dreamskin-target="workbuddy" data-dreamskin-theme="${escapeHtml(theme.id)}" data-dreamskin-scene="${scene}" data-dreamskin-shell="${appearanceMode}" data-workbuddy-skin-compat="5.2" data-workbuddy-skin-treatment="${escapeHtml(theme.appearance.treatment)}" ${visualAttributes} style="${escapeHtml(variables(theme, appearanceMode))}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: blob:; script-src 'none'; font-src 'none'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><meta name="color-scheme" content="light dark"><style>${canonicalWorkBuddyCss.replaceAll("</style", "<\\/style")}</style><style>${workBuddyCss.replaceAll("</style", "<\\/style")}</style>${interactive ? `<style>html[data-dreamskin-interactive=true] [data-dreamskin-component]{cursor:pointer}html[data-dreamskin-interactive=true] [data-dreamskin-component]:hover{outline:2px solid color-mix(in srgb,var(--dreamskin-accent) 72%,white);outline-offset:2px}html[data-dreamskin-interactive=true] [data-dreamskin-component]:focus-visible,html[data-dreamskin-interactive=true] [data-dreamskin-selected=true]{outline:3px solid var(--dreamskin-focus)!important;outline-offset:3px!important}</style>` : ""}</head><body class="workbuddy-dream-skin-body">${symbols}${sceneMarkup(scene)}</body></html>`;
  return source;
}

export function WorkBuddyScenePreview({
  theme,
  appearanceMode,
  scene,
  zoom = 1,
  interactive = false,
  onComponentSelect,
}: {
  theme: StudioTheme;
  appearanceMode: AppearanceMode;
  scene: WorkBuddyScene;
  zoom?: number;
  interactive?: boolean;
  onComponentSelect?: (componentId: string) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [fitScale, setFitScale] = useState(1);
  const frameHeight = scene === "wb-components" ? 2220 : 720;
  const scale = fitScale * zoom;
  const srcDoc = useMemo(() => previewDocument(scene, theme, appearanceMode, interactive), [appearanceMode, interactive, scene, theme]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => setFitScale(Math.min(1, viewport.clientWidth / FRAME_WIDTH));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="mcp-frame-viewport" ref={viewportRef} style={{ height: frameHeight * scale }}>
      <div className="mcp-frame-stage" style={{ width: FRAME_WIDTH * scale, height: frameHeight * scale }}>
        <iframe
          ref={frameRef}
          className="mcp-runtime-frame"
          title={`${theme.name} WorkBuddy ${sceneTitles[scene]}`}
          srcDoc={srcDoc}
          sandbox="allow-same-origin"
          referrerPolicy="no-referrer"
          style={{ width: FRAME_WIDTH, height: frameHeight, transform: `scale(${scale})` }}
          onLoad={() => {
            if (!interactive) return;
            const document = frameRef.current?.contentDocument;
            if (!document) return;
            document.documentElement.dataset.dreamskinInteractive = "true";
            const select = (component: HTMLElement) => {
              document.querySelectorAll("[data-dreamskin-selected]").forEach((node) => node.removeAttribute("data-dreamskin-selected"));
              const cell = component.closest<HTMLElement>(".wb-component-cell");
              (cell || component).dataset.dreamskinSelected = "true";
              onComponentSelect?.(component.dataset.dreamskinComponent || cell?.dataset.dreamskinComponent || "");
            };
            document.querySelectorAll<HTMLElement>("[data-dreamskin-component]").forEach((component) => {
              if (!component.matches("button, input, textarea, select, a, [tabindex]")) component.tabIndex = 0;
              if (!component.hasAttribute("aria-label")) component.setAttribute("aria-label", `选择组件：${component.dataset.dreamskinComponent}`);
            });
            document.addEventListener("click", (event) => {
              const component = (event.target as Element | null)?.closest<HTMLElement>("[data-dreamskin-component]");
              if (!component) return;
              event.preventDefault();
              event.stopPropagation();
              select(component);
            }, true);
            document.addEventListener("keydown", (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              const component = (event.target as Element | null)?.closest<HTMLElement>("[data-dreamskin-component]");
              if (!component) return;
              event.preventDefault();
              event.stopPropagation();
              select(component);
            }, true);
          }}
        />
      </div>
    </div>
  );
}
