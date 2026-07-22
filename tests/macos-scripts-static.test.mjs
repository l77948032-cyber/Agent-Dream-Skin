import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const execFile = promisify(execFileCallback);

async function source(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

test("macOS launchers keep the CDP endpoint loopback-only and bind it to Trae", async () => {
  const common = await source("scripts/common-macos.sh");
  const start = await source("scripts/start-trae-skin-macos.sh");
  const status = await source("scripts/status-trae-skin-macos.sh");

  assert.match(common, /codesign --verify --deep --strict/);
  assert.match(common, /EXPECTED_TRAE_SOLO_CN_TEAM_ID/);
  assert.match(common, /EXPECTED_TRAE_INTERNATIONAL_TEAM_ID/);
  assert.match(common, /com\.trae\.app/);
  assert.match(common, /cn\.trae\.solo\.app/);
  assert.match(common, /is_supported_trae_identity/);
  assert.match(status, /require_trae_runtime identity/);
  assert.doesNotMatch(start, /require_trae_runtime identity/);
  assert.match(common, /state_field\(\)[\s\S]+?plutil -extract "\$key" raw/);
  assert.doesNotMatch(common, /state_field\(\)[\s\S]+?run_node -e[\s\S]+?trae_state_is_trustworthy\(\)/);
  assert.match(common, /cdp_browser_id\(\)[\s\S]+?plutil -extract webSocketDebuggerUrl raw/);
  assert.match(common, /KNOWN_TRAE_0_1_36_BUNDLE_SHA256/);
  assert.match(common, /sha256_bundle_tree/);
  assert.match(common, /pid_is_trae_descendant/);
  assert.match(common, /port_belongs_to_trae/);
  assert.match(common, /trae_main_pid_for_listener/);
  assert.match(common, /port_listens_on_loopback_only/);
  assert.match(common, /cdp_browser_id/);
  assert.match(common, /acquire_operation_lock/);
  assert.match(common, /launchctl bootstrap/);
  assert.match(common, /ELECTRON_RUN_AS_NODE/);
  assert.match(common, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(common, /TRAE_LAUNCH_AGENT_LABEL/);
  assert.match(common, /trae_launch_agent_pid/);
  assert.match(common, /LC_ALL=C \/bin\/ps -p/);
  assert.match(common, /launchctl bootstrap/);
  assert.match(start, /launch_injector_daemon/);
  assert.match(start, /--browser-id/);
  assert.match(start, /--verify/);
  assert.match(start, /write_state/);
  assert.match(start, /existing Trae CDP session not owned/);
  assert.match(start, /process_identity_matches/);
  assert.match(start, /START_TRANSACTION_ACTIVE/);
  assert.match(start, /cleanup_start_exit/);
  assert.match(start, /capture_launched_trae_identity/);
  assert.doesNotMatch(start, /foreground-injector/);
});

test("macOS Trae host profiles require the exact bundle and signing-team pair", async () => {
  const commonPath = path.join(ROOT, "scripts", "common-macos.sh");
  const result = await execFile("/bin/bash", ["-c", [
    'source "$COMMON_PATH"',
    'is_supported_trae_identity "cn.trae.solo.app" "CG2SCM6AV5"',
    'is_supported_trae_identity "com.trae.app" "79M8227NKH"',
    '! is_supported_trae_identity "cn.trae.solo.app" "79M8227NKH"',
    '! is_supported_trae_identity "com.trae.app" "CG2SCM6AV5"',
    '! is_supported_trae_identity "com.example.fake" "79M8227NKH"',
    'printf "%s,%s" "$(trae_variant_for_bundle_id cn.trae.solo.app)" "$(trae_variant_for_bundle_id com.trae.app)"',
  ].join("; ")], {
    env: { ...process.env, COMMON_PATH: commonPath },
  });
  assert.equal(result.stdout, "solo-cn,international");
});

test("macOS Trae discovery accepts explicit CN and international application bundles", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "trae-host-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const commonPath = path.join(ROOT, "scripts", "common-macos.sh");

  for (const profile of [
    { name: "TRAE SOLO CN", bundleId: "cn.trae.solo.app", version: "0.1.38", variant: "solo-cn" },
    { name: "Trae", bundleId: "com.trae.app", version: "3.5.78", variant: "international" },
  ]) {
    const app = path.join(root, `${profile.name}.app`);
    const executable = path.join(app, "Contents", "MacOS", "Electron");
    await fs.mkdir(path.dirname(executable), { recursive: true });
    await fs.writeFile(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${profile.bundleId}</string>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleShortVersionString</key><string>${profile.version}</string>
</dict></plist>\n`);
    await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await fs.chmod(executable, 0o755);
    const result = await execFile("/bin/bash", ["-c", [
      'source "$COMMON_PATH"',
      "discover_trae_app",
      'printf "%s|%s|%s" "$TRAE_VARIANT" "$TRAE_BUNDLE_ID" "$TRAE_VERSION"',
    ].join("; ")], {
      env: {
        ...process.env,
        COMMON_PATH: commonPath,
        TRAE_APP_BUNDLE: app,
        TRAE_DREAM_SKIN_HOME: path.join(root, "state"),
      },
    });
    assert.equal(result.stdout, `${profile.variant}|${profile.bundleId}|${profile.version}`);
  }
});

test("macOS stop performs live cleanup, closes the owned session, and relaunches normally", async () => {
  const stop = await source("scripts/stop-trae-skin-macos.sh");

  assert.match(stop, /stop_recorded_injector/);
  assert.match(stop, /--remove/);
  assert.match(stop, /stop_recorded_trae_process/);
  assert.match(stop, /trae_main_pid_for_listener/);
  assert.match(stop, /stop_launchd_owned_session/);
  assert.match(stop, /state or theme assets could not be used/);
  assert.match(stop, /wait_for_port_available/);
  assert.match(stop, /launch_trae_normally/);
  assert.match(stop, /rm -f "\$STATE_PATH"/);

  const status = await source("scripts/status-trae-skin-macos.sh");
  assert.match(status, /orphaned/);
  assert.match(status, /ownedAppJob/);
  assert.match(status, /SESSION_STATUS="degraded"/);
  assert.match(status, /process_identity_matches "\$TRAE_PID" "\$TRAE_STARTED_AT"/);
  assert.match(status, /"\$LISTENER_TRAE_PID" = "\$TRAE_PID"/);
  assert.match(status, /"\$OWNED_APP_JOB" != "true"/);
  assert.match(status, /"\$OWNED_WATCHER_JOB" != "true"/);
});

test("Trae state validation rejects truncated state before status reads fields", async (t) => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "trae-state-validation-"));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const statePath = path.join(stateRoot, "state.json");
  const commonPath = path.join(ROOT, "scripts", "common-macos.sh");
  const validate = () => execFile("/bin/bash", ["-c", [
    'source "$COMMON_PATH"',
    'run_node() { "$TEST_NODE" "$@"; }',
    'TRAE_BUNDLE="/Applications/Trae.app"',
    'TRAE_EXE="/Applications/Trae.app/Contents/MacOS/Trae"',
    'TRAE_BUNDLE_ID="com.trae.app"',
    'TRAE_VARIANT="international"',
    'TRAE_TEAM_ID="79M8227NKH"',
    "trae_state_is_trustworthy",
  ].join("; ")], {
    env: {
      ...process.env,
      COMMON_PATH: commonPath,
      TEST_NODE: process.execPath,
      TRAE_DREAM_SKIN_HOME: stateRoot,
    },
  });

  await fs.writeFile(statePath, '{"session":"active"');
  await assert.rejects(validate);

  await fs.writeFile(statePath, JSON.stringify({
    schemaVersion: 1,
    session: "active",
    ownsSession: true,
    port: 9342,
    browserId: "browser-1",
    injectorPid: 101,
    injectorStartedAt: "Sun Jul 20 12:00:00 2026",
    traePid: 102,
    traeStartedAt: "Sun Jul 20 12:00:00 2026",
    traeBundle: "/Applications/Trae.app",
    traeExe: "/Applications/Trae.app/Contents/MacOS/Trae",
    traeTeamId: "79M8227NKH",
    themeId: "sunlit-spark",
    themeRevision: "a".repeat(64),
    launchAgentLabel: "local.trae-dream-skin.injector",
    launchAgentPlist: path.join(stateRoot, "injector-launch-agent.plist"),
    appLaunchAgentLabel: "local.trae-dream-skin.trae",
    appLaunchAgentPlist: path.join(stateRoot, "trae-launch-agent.plist"),
  }));
  await validate();

  const status = await source("scripts/status-trae-skin-macos.sh");
  assert.match(status, /if ! trae_state_is_trustworthy; then[\s\S]*SESSION_STATUS="orphaned-unverified"/);
  assert.ok(status.indexOf("trae_state_is_trustworthy") < status.indexOf('PORT="$(state_field port)"'));
});

test("Finder entry points expose start, switch, and stop without patching the app bundle", async () => {
  const files = [
    "Start Trae Dream Skin.command",
    "Switch Trae Skin.command",
    "Stop Trae Dream Skin.command",
  ];
  const contents = await Promise.all(files.map(source));
  assert.match(contents[0], /start-trae-skin-macos\.sh/);
  assert.doesNotMatch(contents[0], /--theme\s+neon-portal/);
  assert.match(contents[1], /switch-theme-macos\.sh/);
  assert.match(contents[2], /stop-trae-skin-macos\.sh/);
  for (const content of contents) {
    assert.match(content, /Library\/Application Support\/TraeDreamSkin\/runtime/);
    assert.match(content, /\/bin\/bash/);
    const pause = content.indexOf("read -r _");
    if (pause >= 0) {
      assert.ok(content.indexOf('if [ "$status" -ne 0 ]') < pause,
        "Finder launcher may pause only after a failed operation");
    }
  }

  const start = await source("scripts/start-trae-skin-macos.sh");
  assert.match(start, /LAST_THEME_PATH="\$STATE_ROOT\/last-theme"/);
  assert.match(start, /THEME_ID="\$\(read_last_theme/);
  assert.match(start, /write_last_theme "\$THEME_ID"/);

  const switchTheme = await source("scripts/switch-theme-macos.sh");
  assert.match(switchTheme, /exec \/bin\/bash/);
  const publicThemes = [
    "neon-portal",
    "ember-glass",
    "paper-aurora",
    "sunlit-spark",
    "violet-rift",
  ];
  let previousTheme = -1;
  for (const theme of publicThemes) {
    const location = switchTheme.indexOf(theme);
    assert.ok(location > previousTheme, `${theme} is missing or out of menu order`);
    previousTheme = location;
  }
  assert.doesNotMatch(switchTheme, /spark-atelier/);

  const install = await source("scripts/install-macos-runtime.sh");
  assert.match(install, /ditto --noextattr --noqtn/);
  assert.match(install, /PROJECT_ROOT\/registry/);
  assert.match(install, /TraeDreamSkin\/runtime/);
  assert.match(install, /PROJECT_ROOT\/src\/core/);

  const allScripts = await Promise.all((await fs.readdir(path.join(ROOT, "scripts")))
    .filter((name) => name.endsWith(".sh"))
    .map((name) => source(path.join("scripts", name))));
  assert.doesNotMatch(allScripts.join("\n"), /app\.asar|asar\s+(?:extract|pack)|codesign\s+--force/);
});

test("host launchers persist and report the exact applied theme revision", async () => {
  const [macStart, macCommon, macStatus, windowsStart, windowsCommon, windowsStatus] = await Promise.all([
    source("scripts/start-trae-skin-macos.sh"),
    source("scripts/common-macos.sh"),
    source("scripts/status-trae-skin-macos.sh"),
    source("scripts/start-trae-skin-windows.ps1"),
    source("scripts/common-windows.ps1"),
    source("scripts/status-trae-skin-windows.ps1"),
  ]);

  assert.match(macStart, /--revision\) THEME_REVISION=/);
  assert.match(macStart, /\^\[0-9a-f\]\{64\}\$/);
  assert.match(macCommon, /themeRevision: themeRevision \|\| null/);
  assert.match(macStatus, /"themeRevision":%s/);

  assert.match(windowsStart, /\[string\]\$Revision/);
  assert.match(windowsStart, /themeRevision = if \(\$Revision\)/);
  assert.match(windowsCommon, /State theme revision is invalid/);
  assert.match(windowsStatus, /themeRevision = if/);
});
