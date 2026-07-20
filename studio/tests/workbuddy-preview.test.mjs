import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const studioRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(file) {
  return fs.readFile(path.join(studioRoot, "src", file), "utf8");
}

function ruleBodiesFor(css, selectorToken) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((match) => match[1].includes(selectorToken))
    .map((match) => match[2])
    .join("\n");
}

const workBuddySceneRegistry = JSON.parse(
  await fs.readFile(path.resolve(studioRoot, "../plugins/workbuddy/resources/studio-scenes.v1.json"), "utf8"),
);
const workBuddyScenes = [
  ...workBuddySceneRegistry.scenes.map((scene) => `wb-${scene.id}`),
  "wb-components",
];

const workBuddyComponents = [
  "shell.workspace",
  "shell.titlebar",
  "sidebar.navigation",
  "sidebar.project",
  "home.hero",
  "home.quickAction",
  "chat.timeline",
  "chat.message.user",
  "chat.message.agent",
  "chat.toolCall",
  "composer.surface",
  "composer.tool",
  "action.primary",
  "result.shell",
  "result.tabs",
  "result.artifact",
  "result.fileTree",
  "market.toolbar",
  "market.card",
  "automation.task",
  "automation.run",
  "project.card",
  "settings.section",
  "input.field",
  "selection.control",
  "overlay.menu",
  "overlay.dialog",
  "overlay.tooltip",
  "status.badge",
  "status.toast",
  "loading.skeleton",
  "empty.state",
];

test("WorkBuddy preview exposes every product scene", async () => {
  const [app, preview] = await Promise.all([source("App.tsx"), source("WorkBuddyPreview.tsx")]);
  for (const scene of workBuddyScenes) {
    assert.match(preview, new RegExp(`"${scene}"`));
  }
  assert.match(app, /workBuddySceneRegistry\.scenes\.map/);
  assert.match(app, /value: `wb-\$\{scene\.id\}`/);
  assert.match(preview, /function homeScene\(\)/);
  assert.match(preview, /function assistantScene\(\)/);
  assert.match(preview, /function threadScene\(\)/);
  assert.match(preview, /function resultsScene\(\)/);
  assert.match(preview, /function resourcesScene\(\)/);
  assert.match(preview, /function automationScene\(\)/);
  assert.match(preview, /function projectScene\(\)/);
  assert.match(preview, /function settingsScene\(\)/);
  assert.match(preview, /function overlaysScene\(\)/);
  assert.match(preview, /function componentsScene\(\)/);
  assert.match(preview, /日常办公/);
  assert.match(preview, /代码开发/);
  assert.match(preview, /设计创意/);
});

test("WorkBuddy preview covers the complete semantic component registry", async () => {
  const [app, preview, registry] = await Promise.all([
    source("App.tsx"),
    source("WorkBuddyPreview.tsx"),
    fs.readFile(path.resolve(studioRoot, "../plugins/workbuddy/resources/components.v1.json"), "utf8").then(JSON.parse),
  ]);
  assert.deepEqual(registry.components.map((component) => component.id), workBuddyComponents);
  for (const component of workBuddyComponents) {
    assert.ok(
      preview.includes(`"${component}"`),
      `${component} must have a visual preview`,
    );
    assert.ok(
      app.includes(`"${component}"`),
      `${component} must have a Studio selection label`,
    );
  }
  assert.match(preview, /默认输入/);
  assert.match(preview, /聚焦状态/);
  assert.match(preview, /格式有误/);
  assert.match(preview, /处理中/);
  assert.match(preview, /不可用/);
  assert.match(preview, /成功/);
  assert.match(preview, /警告/);
  assert.match(preview, /还没有内容/);
});

test("WorkBuddy preview reuses canonical skin CSS and keeps chat surfaces single-layered", async () => {
  const [preview, fixture] = await Promise.all([
    source("WorkBuddyPreview.tsx"),
    source("workbuddy-preview-fixture.css"),
  ]);

  assert.match(
    preview,
    /import canonicalWorkBuddyCss from "\.\.\/\.\.\/plugins\/workbuddy\/assets\/workbuddy-skin\.css\?raw"/,
  );
  assert.match(preview, /<style>\$\{canonicalWorkBuddyCss\.replaceAll/);
  assert.match(preview, /class="workbuddy-dream-skin"/);
  assert.match(preview, /data-workbuddy-skin-compat="5\.2"/);

  const conversationCss = ruleBodiesFor(fixture, ".wb-conversation.chat-container");
  assert.match(conversationCss, /background:\s*transparent\s*!important/);
  assert.match(conversationCss, /box-shadow:\s*none\s*!important/);

  const assistantCss = ruleBodiesFor(
    fixture,
    '.wb-message.is-agent[data-dreamskin-component="chat.message.agent"]',
  );
  assert.match(assistantCss, /background:\s*transparent\s*!important/);
  assert.match(assistantCss, /box-shadow:\s*none\s*!important/);

  const composerCss = ruleBodiesFor(fixture, ".wb-composer.wb-input-footer");
  assert.match(composerCss, /background:\s*color-mix\([^;]*--dreamskin-composer-mix/);
  const editorCss = ruleBodiesFor(fixture, ".wb-composer-editor");
  assert.doesNotMatch(editorCss, /background:\s*(?!transparent)/);
});

test("WorkBuddy business previews mirror native 5.2 page and card contracts", async () => {
  const [preview, fixture] = await Promise.all([
    source("WorkBuddyPreview.tsx"),
    source("workbuddy-preview-fixture.css"),
  ]);

  for (const nativeClass of [
    "claw-workspace",
    "workbuddy-topbar-claw-connected-info",
    "workbuddy-topbar-claw-channel-tag",
    "workbuddy-topbar-claw-settings-icon",
    "workbuddy-collab",
    "landing",
    "project-grid__card",
    "landing-template-card",
    "expert-center-page",
    "ec-main-content",
    "ec-topbar",
    "ec-expert-card",
    "skills-view",
    "skill-card",
    "connector-panel",
    "connector-card",
    "automation-main-page",
    "automation-panel",
    "atm-template-card",
    "atm-row",
    "atm-run-history-item",
  ]) {
    assert.match(preview, new RegExp(nativeClass.replaceAll("-", "\\-")), `${nativeClass} must be represented by the Studio fixture`);
  }

  assert.match(preview, /data-workbuddy-skin-runtime-role="business\.canvas"/);
  assert.match(preview, /data-workbuddy-skin-runtime-role="business\.panel"/);
  assert.match(fixture, /\.wb-project-page\.workbuddy-collab\.landing\s*\{\s*background:\s*transparent/);
  assert.doesNotMatch(ruleBodiesFor(fixture, ".wb-market-feature"), /var\(--dreamskin-art\)/);
});

test("Studio theme identity and API calls are scoped by plugin", async () => {
  const [app, api] = await Promise.all([source("App.tsx"), source("api.ts")]);
  assert.match(app, /return `\$\{item\.pluginId\}::\$\{item\.localId\}`/);
  assert.match(app, /studioApi\.createTheme\([^\n]+entry\.pluginId/);
  assert.match(app, /studioApi\.duplicateTheme\(item\.localId, item\.pluginId\)/);
  assert.match(app, /studioApi\.deleteTheme\(item\.localId,[^\n]+item\.pluginId\)/);
  assert.match(app, /studioApi\.applyTheme\(item\.localId, item\.pluginId\)/);
  assert.match(app, /pluginIds\.map\(\(pluginId\) => studioApi\.listThemes\(pluginId\)\)/);
  assert.match(api, /pluginApiPath\(pluginId, "\/themes"\)/);
  assert.match(api, /pluginApiPath\(pluginId, "\/runtime\/verify"\)/);
  assert.match(api, /pluginApiPath\(pluginId, "\/runtime\/restore"\)/);
});

test("Studio is a local theme library without embedded Agent connection chrome", async () => {
  const [app, api] = await Promise.all([source("App.tsx"), source("api.ts")]);
  assert.match(app, /useState<View>\("library"\)/);
  assert.match(app, /window\.setInterval\(\(\) => void poll\(\), 1500\)/);
  assert.match(app, /<strong>CLI 同步<\/strong>/);
  assert.doesNotMatch(app, /Agent 连接|sendThemeMessage|connectAgent/);
  assert.match(api, /getCliStatus\(\): Promise<CliStatusDto>/);
  assert.match(api, /installCli\(\): Promise<CliStatusDto>/);
  assert.match(api, /uninstallCli\(\): Promise<CliStatusDto>/);
  assert.match(app, /status\.state === "ready" && status\.pathAvailable/);
  assert.match(app, /status\.message \|\| "启动器已安装，但当前终端 PATH 尚未包含它的目录。"/);
  assert.match(app, /toast\("CLI 需要更新"/);
  assert.match(app, /toast\("CLI 不可用"/);
  assert.doesNotMatch(api, /sendThemeMessage|listAgents|connectAgent/);
});

test("WorkBuddy catalog detail uses WorkBuddy interface semantics", async () => {
  const app = await source("App.tsx");
  const coverage = app.match(/function coverageForTarget\(entry: CatalogEntry\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(coverage, "coverageForTarget must exist");
  assert.match(coverage, /workBuddySceneRegistry\.scenes\.map\(\(scene\) => scene\.name\)/);
  assert.doesNotMatch(coverage, /\["日常办公", "代码开发", "设计创意"/);
  assert.deepEqual(workBuddySceneRegistry.scenes.map((scene) => scene.name), ["首页", "助理", "对话", "结果与产物", "专家·技能·连接器", "自动化", "项目", "设置", "浮层与状态"]);
});

test("Trae retains its original five preview scenes", async () => {
  const showcase = await source("ThemeShowcase.tsx");
  assert.match(showcase, /type TraePreviewScene = "work" \| "code" \| "design" \| "thread" \| "components"/);
  assert.match(showcase, /workHomeMarkup\(\)/);
  assert.match(showcase, /codeHomeMarkup\(\)/);
  assert.match(showcase, /designHomeMarkup\(\)/);
  assert.match(showcase, /threadMarkup\(\)/);
  assert.match(showcase, /componentsMarkup\(\)/);
});

test("window new-theme button does not forward the click event as a plugin id", async () => {
  const app = await source("App.tsx");
  assert.match(app, /aria-label="新建空白主题"[\s\S]*?onClick=\{\(\) => onCreateTheme\(\)\}/);
  assert.doesNotMatch(app, /aria-label="新建空白主题"[\s\S]*?onClick=\{onCreateTheme\}/);
});

test("runtime settings distinguish degraded cleanup from active verification", async () => {
  const app = await source("App.tsx");
  assert.match(app, /runtimeSession === "degraded"[\s\S]*?"需要修复"/);
  assert.match(app, /runtimeSession === "orphaned" \|\| runtimeSession === "orphaned-unverified"[\s\S]*?"待清理"/);
  assert.match(app, /const runtimeCanVerify = runtimeSession === "active"/);
  assert.match(app, /const runtimeCanRestore = runtimeSession === "active"[\s\S]*?runtimeSession === "degraded"[\s\S]*?runtimeSession === "orphaned"[\s\S]*?runtimeSession === "orphaned-unverified"/);
  assert.match(app, /disabled=\{!runtimeCanVerify \|\| Boolean\(runtimeBusy\)\}[\s\S]*?runRuntimeAction\("verify"\)/);
  assert.match(app, /disabled=\{!runtimeCanRestore \|\| Boolean\(runtimeBusy\)\}[\s\S]*?runRuntimeAction\("restore"\)/);
});
