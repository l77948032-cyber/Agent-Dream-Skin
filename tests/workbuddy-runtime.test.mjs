import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  classifyWorkBuddyProbe,
  isPlausibleWorkBuddyRendererTarget,
  loadWorkBuddyPayload,
  parseWorkBuddyArgs,
  workBuddyOneShotPass,
  WORKBUDDY_DEFAULT_PORT,
} from "../scripts/workbuddy-injector.mjs";
import {
  normalizeWorkBuddyRuntimeStatus,
  WorkBuddyPlatformRuntime,
} from "../src/core/workbuddy-platform.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REVISION = "b".repeat(64);
const execFile = promisify(execFileCallback);

function rendererTarget(overrides = {}) {
  return {
    id: "WB123",
    type: "page",
    title: "WorkBuddy",
    url: "file:///Applications/WorkBuddy.app/Contents/Resources/app.asar/renderer/index.html",
    webSocketDebuggerUrl: `ws://127.0.0.1:${WORKBUDDY_DEFAULT_PORT}/devtools/page/WB123`,
    ...overrides,
  };
}

test("WorkBuddy injector parses scoped assets and rejects unsafe endpoint values", () => {
  const options = parseWorkBuddyArgs([
    "--once",
    "--port", "19432",
    "--browser-id", "browser-1",
    "--target-id", "page-1",
    "--theme-dir", "./theme",
    "--css-path", "./skin.css",
    "--template-path", "./template.js",
    "--registry-path", "./registry.json",
    "--screenshot", "./shot.png",
    "--timeout-ms", "5000",
  ]);
  assert.equal(options.mode, "once");
  assert.equal(options.port, 19432);
  assert.equal(options.browserId, "browser-1");
  assert.equal(options.targetId, "page-1");
  assert.equal(path.basename(options.cssPath), "skin.css");
  assert.equal(path.basename(options.templatePath), "template.js");
  assert.equal(path.basename(options.registryPath), "registry.json");
  assert.equal(path.basename(options.screenshot), "shot.png");
  assert.equal(parseWorkBuddyArgs(["--remove"]).mode, "remove");
  assert.equal(parseWorkBuddyArgs(["--probe-targets"]).mode, "probe");
  assert.throws(() => parseWorkBuddyArgs(["--port", "80"]), /Invalid port/);
  assert.throws(() => parseWorkBuddyArgs(["--browser-id", "bad/id"]), /Invalid browser ID/);
  assert.throws(() => parseWorkBuddyArgs(["--css-path"]), /requires a value/);
});

test("WorkBuddy renderer detection requires the signed-app page shape and stable shell markers", () => {
  const target = rendererTarget();
  assert.equal(isPlausibleWorkBuddyRendererTarget(target), true);
  assert.equal(isPlausibleWorkBuddyRendererTarget({
    ...target,
    url: "https://workbuddy.example/index.html",
  }), false);
  assert.equal(isPlausibleWorkBuddyRendererTarget({
    ...target,
    title: "Unrelated",
    url: "file:///Applications/Other.app/Contents/Resources/app.asar/renderer/index.html",
  }), false);

  const matched = classifyWorkBuddyProbe({
    viewport: { width: 1280, height: 800 },
    markers: {
      root: true,
      teamsContainer: true,
      conversationSidebar: true,
      contentWrapper: true,
      mainContent: true,
      rootChildCount: 1,
      interactiveCount: 12,
    },
  }, target);
  assert.equal(matched.matched, true);
  assert.equal(matched.kind, "workbuddy-workspace");

  const splash = classifyWorkBuddyProbe({
    viewport: { width: 1280, height: 800 },
    markers: { root: true, rootChildCount: 1, interactiveCount: 1 },
  }, target);
  assert.equal(splash.matched, false);
});

test("WorkBuddy one-shot results expose a truthful top-level pass state", () => {
  assert.equal(workBuddyOneShotPass([{ result: { pass: true } }], "verify"), true);
  assert.equal(workBuddyOneShotPass([
    { result: { pass: true } },
    { result: { pass: false } },
  ], "verify"), false);
  assert.equal(workBuddyOneShotPass([], "verify"), false);
  assert.equal(workBuddyOneShotPass([{ result: true }], "remove"), true);
  assert.equal(workBuddyOneShotPass([{ result: false }], "remove"), false);
});

test("WorkBuddy payload resolves canonical CSS, art, theme, and component registry", async () => {
  const payload = await loadWorkBuddyPayload();
  assert.equal(payload.theme.id, "paper-garden");
  assert.ok(payload.imageBytes > 100_000);
  assert.ok(payload.cssBytes > 1_000);
  assert.ok(payload.payloadBytes > payload.imageBytes);
  assert.match(payload.payload, /workbuddy-dream-skin/);
  assert.match(payload.payload, /data:image\/png;base64,/);
  assert.match(payload.payload, /shell\.workspace/);
  assert.doesNotMatch(payload.payload, /__WORKBUDDY_SKIN_(?:CSS|ART|THEME|COMPONENT_REGISTRY|VERSION)_JSON__/);
});

test("WorkBuddy platform runtime uses target-specific scripts, roots, and revision tracking", async () => {
  const calls = [];
  const runtime = new WorkBuddyPlatformRuntime({
    platform: "darwin",
    scriptsRoot: "/runtime/scripts",
    themesRoot: "/state/themes/workbuddy",
    cssPath: "/runtime/plugins/workbuddy/assets/workbuddy-skin.css",
    templatePath: "/runtime/assets/workbuddy-renderer-inject.js",
    registryPath: "/runtime/plugins/workbuddy/resources/components.v1.json",
    stateRoot: "/state/runtime/workbuddy",
    runner: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: '{"session":"off"}\n', stderr: "" };
    },
  });
  assert.deepEqual(runtime.descriptor(), {
    platform: "darwin",
    supported: true,
    transport: "loopback-cdp",
    host: "workbuddy",
    minimumTestedHostVersion: "5.2.0",
    appBundleModified: false,
  });
  assert.deepEqual(
    runtime.command("apply", { themeId: "harbor-focus", themeRevision: REVISION }).args.slice(-4),
    ["--theme", "harbor-focus", "--revision", REVISION],
  );
  assert.throws(
    () => runtime.command("apply", { themeId: "harbor-focus", themeRevision: "stale" }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  assert.deepEqual(await runtime.status(), { session: "off", diagnostics: undefined });
  assert.equal(calls[0].file, "/bin/bash");
  assert.match(calls[0].args[0], /status-workbuddy-skin-macos\.sh$/);
  assert.equal(calls[0].options.env.WORKBUDDY_DREAM_SKIN_THEMES_ROOT, "/state/themes/workbuddy");
  assert.equal(calls[0].options.env.WORKBUDDY_DREAM_SKIN_HOME, "/state/runtime/workbuddy");
});

test("WorkBuddy runtime never reports a dead persistent session as active", () => {
  assert.deepEqual(normalizeWorkBuddyRuntimeStatus({
    session: "active",
    themeId: "harbor-focus",
    injectorAlive: false,
    workbuddyAlive: true,
    cdpOk: true,
    ownedAppJob: true,
    ownedWatcherJob: true,
  }), {
    session: "degraded",
    themeId: "harbor-focus",
    injectorAlive: false,
    workbuddyAlive: true,
    cdpOk: true,
    ownedAppJob: true,
    ownedWatcherJob: true,
  });
  assert.equal(normalizeWorkBuddyRuntimeStatus({
    session: "active",
    injectorAlive: true,
    workbuddyAlive: true,
    cdpOk: true,
    ownedAppJob: true,
    ownedWatcherJob: true,
  }).session, "active");
});

test("WorkBuddy state validation rejects truncated state before status reads fields", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbuddy-state-validation-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const statePath = path.join(stateRoot, "state.json");
  const commonPath = path.join(ROOT, "scripts", "common-workbuddy-macos.sh");
  const validate = () => execFile("/bin/bash", ["-c", [
    'source "$COMMON_PATH"',
    'run_node() { "$TEST_NODE" "$@"; }',
    "workbuddy_state_is_trustworthy",
  ].join("; ")], {
    env: {
      ...process.env,
      COMMON_PATH: commonPath,
      TEST_NODE: process.execPath,
      WORKBUDDY_DREAM_SKIN_HOME: stateRoot,
    },
  });

  await fs.writeFile(statePath, '{"session":"active"');
  await assert.rejects(validate);

  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    session: "active",
    ownsSession: true,
    port: 9432,
    browserId: "browser-1",
    injectorPid: 101,
    injectorStartedAt: "Sun Jul 20 12:00:00 2026",
    workbuddyPid: 102,
    workbuddyStartedAt: "Sun Jul 20 12:00:00 2026",
    workbuddyBundle: "/Applications/WorkBuddy.app",
    workbuddyExe: "/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy",
    themeId: "harbor-focus",
    themeRevision: REVISION,
    launchAgentLabel: "local.workbuddy-dream-skin.injector",
    launchAgentPlist: path.join(stateRoot, "injector-launch-agent.plist"),
    appLaunchAgentLabel: "local.workbuddy-dream-skin.workbuddy",
    appLaunchAgentPlist: path.join(stateRoot, "workbuddy-launch-agent.plist"),
  }));
  await validate();

  const status = await fs.readFile(path.join(ROOT, "scripts", "status-workbuddy-skin-macos.sh"), "utf8");
  const stop = await fs.readFile(path.join(ROOT, "scripts", "stop-workbuddy-skin-macos.sh"), "utf8");
  assert.match(status, /if ! workbuddy_state_is_trustworthy; then[\s\S]*SESSION_STATUS="orphaned-unverified"/);
  assert.ok(status.indexOf("workbuddy_state_is_trustworthy") < status.indexOf('PORT="$(state_field port)"'));
  assert.match(stop, /if \[ "\$STATE_TRUSTWORTHY" != "true" \]; then[\s\S]*stop_launchd_owned_session true/);
  assert.doesNotMatch(stop.slice(0, stop.indexOf("stop_launchd_owned_session()")), /discover_workbuddy_app|require_workbuddy_runtime/);
  assert.match(stop, /stop_path_owned_workbuddy_launch_agent/);
  assert.match(stop, /stop_path_owned_launch_agent/);
});

test("WorkBuddy macOS runtime is loopback-only, signature-bound, persistent, and reversible", async () => {
  const [common, start, stop] = await Promise.all([
    fs.readFile(path.join(ROOT, "scripts", "common-workbuddy-macos.sh"), "utf8"),
    fs.readFile(path.join(ROOT, "scripts", "start-workbuddy-skin-macos.sh"), "utf8"),
    fs.readFile(path.join(ROOT, "scripts", "stop-workbuddy-skin-macos.sh"), "utf8"),
  ]);
  assert.match(common, /SUPPORTED_WORKBUDDY_BUNDLE_IDS="com\.workbuddy\.workbuddy"/);
  assert.match(common, /EXPECTED_WORKBUDDY_TEAM_ID/);
  assert.match(common, /codesign --verify --deep --strict/);
  assert.match(common, /WORKBUDDY_REMOTE_DEBUGGING_PORT/);
  assert.match(common, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(common, /port_listens_on_loopback_only/);
  assert.match(common, /port_belongs_to_workbuddy/);
  assert.match(common, /launchctl bootstrap/);
  assert.match(common, /ELECTRON_RUN_AS_NODE/);
  assert.match(start, /launch_injector_daemon/);
  assert.match(start, /--css-path/);
  assert.match(start, /write_state/);
  assert.match(common, /recorded_injector_is_alive/);
  assert.match(await fs.readFile(path.join(ROOT, "scripts", "status-workbuddy-skin-macos.sh"), "utf8"), /SESSION_STATUS="degraded"/);
  assert.match(stop, /--remove/);
  assert.match(stop, /stop_owned_workbuddy_launch_agent/);
  assert.match(stop, /launch_workbuddy_normally/);
  assert.doesNotMatch([common, start, stop].join("\n"), /app\.asar\s+(?:extract|pack)|codesign\s+--force/);
});
