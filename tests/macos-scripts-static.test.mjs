import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

async function source(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

test("macOS launchers keep the CDP endpoint loopback-only and bind it to Trae", async () => {
  const common = await source("scripts/common-macos.sh");
  const start = await source("scripts/start-trae-skin-macos.sh");

  assert.match(common, /codesign --verify --deep --strict/);
  assert.match(common, /EXPECTED_TRAE_TEAM_ID/);
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
  assert.match(install, /TraeDreamSkin\/runtime/);
  assert.match(install, /PROJECT_ROOT\/src\/core/);

  const allScripts = await Promise.all((await fs.readdir(path.join(ROOT, "scripts")))
    .filter((name) => name.endsWith(".sh"))
    .map((name) => source(path.join("scripts", name))));
  assert.doesNotMatch(allScripts.join("\n"), /app\.asar|asar\s+(?:extract|pack)|codesign\s+--force/);
});
