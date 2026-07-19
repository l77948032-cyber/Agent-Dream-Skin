import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const scripts = {
  common: "scripts/common-windows.ps1",
  start: "scripts/start-trae-skin-windows.ps1",
  switch: "scripts/switch-theme-windows.ps1",
  verify: "scripts/verify-trae-skin-windows.ps1",
  stop: "scripts/stop-trae-skin-windows.ps1",
  status: "scripts/status-trae-skin-windows.ps1",
};

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function assertBalancedPowerShell(source, relative) {
  const pairs = new Map([[")", "("], ["]", "["], ["}", "{"]]);
  const stack = [];
  let quote = null;
  let comment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (comment) {
      if (char === "\n") comment = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'" && next === "'") index += 1;
      else if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "`") index += 1;
      else if (char === '"') quote = null;
      continue;
    }
    if (char === "#") {
      comment = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`") {
      index += 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") stack.push(char);
    else if (pairs.has(char)) assert.equal(stack.pop(), pairs.get(char), `${relative}: mismatched ${char}`);
  }
  assert.equal(quote, null, `${relative}: unterminated quote`);
  assert.deepEqual(stack, [], `${relative}: unclosed delimiter`);
}

test("Windows scripts are present, ASCII, and structurally balanced", () => {
  for (const relative of Object.values(scripts)) {
    const source = read(relative);
    assert.ok(source.length > 100, `${relative} is unexpectedly empty`);
    assert.doesNotMatch(source, /[^\x00-\x7f]/, `${relative} contains a BOM/non-ASCII byte`);
    assert.doesNotMatch(source, /Codex|ChatGPT|Get-DreamSkin/);
    assertBalancedPowerShell(source, relative);
  }
});

test("common layer binds runtime, signer, PID, and loopback CDP identity", () => {
  const source = read(scripts.common);
  assert.match(source, /TRAE SOLO CN\.exe/);
  assert.match(source, /ByteDance\.TraeSoloCN/);
  assert.match(source, /Get-AuthenticodeSignature/);
  assert.match(source, /ELECTRON_RUN_AS_NODE/);
  assert.match(source, /Get-NetTCPConnection/);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /injectorStartedAt/);
  assert.match(source, /--browser-id/);
  assert.match(source, /--theme-dir/);
  assert.match(source, /Get-TraeSkinPortOwnerIdentity/);
  assert.match(source, /OwnerProcessId/);
  assert.match(source, /OwnerStartedAt/);
  assert.match(source, /ownsSession/);
  assert.match(source, /traeStartedAt/);
  assert.match(source, /traePublisherThumbprint/);
  assert.match(source, /schemaVersion[^\n]+-ne 2/);
  assert.match(source, /@\('starting', 'active'\)/);
  assert.match(source, /Test-TraeSkinLaunchToken/);
  assert.match(source, /Get-TraeSkinLaunchIntentProcesses/);
  assert.match(source, /--trae-dream-skin-launch-token=/);
  assert.match(source, /--type\(\?:=\|\\s\)/);
  assert.match(source, /State\.injectorPath/);
  assert.match(source, /State\.themeDir/);
  assert.match(source, /Stop-TraeSkinOwnedInjectors/);
  assert.match(source, /Get-TraeSkinOrphanSessionScan/);
  assert.match(source, /Stop-TraeSkinOrphanSession/);
  assert.match(source, /SafeHandle/);
  assert.match(source, /Stop-TraeSkinRecordedApplication/);
  assert.match(source, /Start-Process[^\n]+-PassThru/);
});

test("start and stop implement a reversible owned CDP lifecycle", () => {
  const start = read(scripts.start);
  const stop = read(scripts.stop);
  assert.match(start, /--remote-debugging-address=127\.0\.0\.1/);
  assert.match(start, /--remote-debugging-port=\$Port/);
  assert.match(start, /--owner-token/);
  assert.match(start, /Test-TraeSkinCdpIdentityMatchesState/);
  assert.match(start, /OwnerProcessId[^\n]+sessionTraePid/);
  assert.match(start, /OwnerStartedAt/);
  assert.match(start, /ownsSession = \$true/);
  assert.match(start, /traeStartedAt = \$sessionTraeStartedAt/);
  assert.match(start, /Write-TraeSkinState/);
  assert.match(start, /TraeSkinLastThemePath/);
  assert.match(start, /Read-TraeSkinLastTheme/);
  assert.match(start, /Write-TraeSkinLastTheme/);
  assert.match(start, /--once/);
  assert.match(start, /--verify/);
  assert.match(stop, /--remove/);
  assert.match(stop, /Stop-TraeSkinRecordedApplication/);
  assert.doesNotMatch(stop, /Stop-TraeSkinApplication\s/);
  assert.match(stop, /Test-TraeSkinCdpIdentityMatchesState/);
  assert.match(stop, /state\.traeStartedAt/);
  assert.match(stop, /Wait-TraeSkinPortAvailable/);
  assert.match(stop, /Start-TraeSkinNormally/);
  assert.ok(stop.indexOf("--remove") < stop.indexOf("Stop-TraeSkinRecordedApplication"));
  assert.ok(stop.indexOf("Wait-TraeSkinPortAvailable") < stop.lastIndexOf("Remove-Item -LiteralPath $Script:TraeSkinStatePath"));
  assert.ok(start.indexOf("Get-TraeSkinNodeRuntime") < start.indexOf("$mutationStarted = $true"));
});

test("missing or corrupt state uses the signed token chain instead of reporting off", () => {
  const common = read(scripts.common);
  const start = read(scripts.start);
  const stop = read(scripts.stop);
  const status = read(scripts.status);
  const injector = read("scripts/injector.mjs");

  assert.match(common, /--trae-dream-skin-launch-token=.*a-f0-9.*32/);
  assert.match(common, /ConvertTo-TraeSkinInstall -Executable/);
  assert.match(common, /Get-TraeSkinPortOwnerIdentity/);
  assert.match(common, /duplicate dedicated launch token/);
  assert.match(common, /debugging port belongs to another process/);
  assert.match(common, /Test-TraeSkinOrphanWatcherProcessIdentity/);
  assert.match(common, /Get-TraeSkinStandaloneOrphanWatcherScan/);
  assert.match(common, /duplicate dedicated watcher token/);
  assert.match(common, /\.SafeHandle/);
  assert.match(common, /\.Kill\(\)/);
  const recordedStop = common.slice(
    common.indexOf("function Stop-TraeSkinRecordedApplication"),
    common.indexOf("function Test-TraeSkinBrowserId"),
  );
  assert.ok(recordedStop.indexOf(".SafeHandle") < recordedStop.indexOf(".CloseMainWindow()"));
  assert.ok(recordedStop.indexOf(".CloseMainWindow()") < recordedStop.indexOf(".WaitForExit(15000)"));
  assert.ok(recordedStop.indexOf(".WaitForExit(15000)") < recordedStop.indexOf(".Kill()"));
  assert.match(start, /@\('--owner-token', \$launchToken\)/);
  assert.match(injector, /--owner-token/);
  assert.match(injector, /OWNER_TOKEN_PATTERN/);

  assert.match(stop, /stateUnreadable/);
  assert.match(stop, /Get-TraeSkinOrphanSessionScan/);
  assert.match(stop, /Stop-TraeSkinOrphanSession/);
  assert.match(stop, /standaloneWatchers/);
  assert.match(stop, /unverifiedOrphans\.Count -gt 0/);
  const orphanStop = stop.indexOf("Stop-TraeSkinOrphanSession");
  const corruptStateDelete = stop.indexOf("Remove-Item -LiteralPath $Script:TraeSkinStatePath", orphanStop);
  assert.ok(orphanStop >= 0 && orphanStop < corruptStateDelete);

  assert.match(status, /'orphaned'/);
  assert.match(status, /'orphaned-unverified'/);
  assert.match(status, /'unreadable'/);
  assert.match(status, /standaloneOrphanWatcherCount/);
  assert.ok(status.indexOf("Get-TraeSkinOrphanSessionScan") < status.indexOf("'off'"));
});

test("start publishes a recoverable intent before either child process can escape", () => {
  const start = read(scripts.start);
  const startingState = start.indexOf("session = 'starting'");
  const intentWrite = start.indexOf("Write-TraeSkinState -State $newState", startingState);
  const appSpawn = start.indexOf("$launchedProcess = Start-TraeSkinApplicationProcess", intentWrite);
  assert.ok(startingState >= 0 && startingState < intentWrite && intentWrite < appSpawn);
  assert.match(start, /\[guid\]::NewGuid\(\)\.ToString\('N'\)/);
  assert.match(start, /--trae-dream-skin-launch-token=\$launchToken/);

  const appPid = start.indexOf("$newState.traePid = $sessionTraePid", appSpawn);
  const appPidWrite = start.indexOf("Write-TraeSkinState -State $newState", appPid);
  const cdpWait = start.indexOf("Wait-TraeSkinCdpIdentity", appPid);
  assert.ok(appSpawn < appPid && appPid < appPidWrite && appPidWrite < cdpWait);

  const browserId = start.indexOf("$newState.browserId = $cdpIdentity.BrowserId", cdpWait);
  const browserWrite = start.indexOf("Write-TraeSkinState -State $newState", browserId);
  const watcherSpawn = start.indexOf("$daemon = Start-TraeSkinNodeProcess", browserWrite);
  assert.ok(cdpWait < browserId && browserId < browserWrite && browserWrite < watcherSpawn);

  const watcherPid = start.indexOf("$newState.injectorPid = [int]$daemon.Id", watcherSpawn);
  const watcherWrite = start.indexOf("Write-TraeSkinState -State $newState", watcherPid);
  const verify = start.indexOf("'--verify'", watcherWrite);
  const activeState = start.indexOf("$newState.session = 'active'", verify);
  const activeWrite = start.indexOf("Write-TraeSkinState -State $newState", activeState);
  assert.ok(watcherSpawn < watcherPid && watcherPid < watcherWrite && watcherWrite < verify);
  assert.ok(verify < activeState && activeState < activeWrite);
});

test("stop ignores unconfirmed watcher PID reuse but closes the exact owned Trae", () => {
  const common = read(scripts.common);
  const stop = read(scripts.stop);
  assert.match(common, /processId -eq \$recordedPid[^\n]+\$recordedStartedAt/);
  assert.match(common, /\$startedAt -ne \$recordedStartedAt/);
  assert.match(common, /Test-TraeSkinInjectorProcessIdentity[^\n]+ExpectedStartedAt/);
  assert.match(stop, /Get-TraeSkinLaunchIntentProcesses/);
  assert.match(stop, /\$injectorPath/);
  assert.match(stop, /\$themeDirectory/);
  assert.doesNotMatch(stop, /Stop-TraeSkinRecordedInjector/);

  const exactAppStop = stop.indexOf("Stop-TraeSkinRecordedApplication");
  const watcherStopBefore = stop.indexOf("Stop-TraeSkinOwnedInjectors", stop.indexOf("$runtime = $null"));
  const watcherStopAfter = stop.lastIndexOf("Stop-TraeSkinOwnedInjectors");
  const stateDelete = stop.lastIndexOf("Remove-Item -LiteralPath $Script:TraeSkinStatePath");
  assert.ok(watcherStopBefore < exactAppStop && exactAppStop < watcherStopAfter);
  assert.ok(watcherStopAfter < stateDelete);
});

test("verify and status require the complete recorded ownership chain", () => {
  const verify = read(scripts.verify);
  const status = read(scripts.status);
  for (const source of [verify, status]) {
    assert.match(source, /Test-TraeSkinApplicationProcessIdentity/);
    assert.match(source, /Test-TraeSkinRecordedInjectorIdentity/);
    assert.match(source, /OwnerProcessId|Test-TraeSkinCdpIdentityMatchesState/);
    assert.match(source, /traeStartedAt/);
  }
  assert.match(verify, /session\)" -ne 'active'/);
  assert.match(status, /Get-TraeSkinOwnedInjectorProcesses/);
  assert.match(status, /session\)" -eq 'active'/);
});

test("friendly cmd entry points call every Windows operation", () => {
  const entries = new Map([
    ["windows/Start Trae Dream Skin.cmd", scripts.start],
    ["windows/Switch Trae Skin.cmd", scripts.switch],
    ["windows/Verify Trae Dream Skin.cmd", scripts.verify],
    ["windows/Stop Trae Dream Skin.cmd", scripts.stop],
    ["windows/Trae Dream Skin Status.cmd", scripts.status],
  ]);
  for (const [entry, script] of entries) {
    const source = read(entry);
    assert.match(source, /WindowsPowerShell\\v1\.0\\powershell\.exe/i);
    assert.ok(source.includes(path.basename(script)), `${entry} does not call ${script}`);
    if (!entry.includes("Status")) {
      assert.match(source, /if not "%EXIT_CODE%"=="0" pause/i,
        `${entry} must not pause after a successful operation`);
    }
  }
});

test("Windows and macOS expose the same public theme menu", () => {
  const windowsSwitch = read(scripts.switch);
  const macSwitch = read("scripts/switch-theme-macos.sh");
  const publicThemes = [
    "neon-portal",
    "ember-glass",
    "paper-aurora",
    "sunlit-spark",
    "violet-rift",
  ];
  for (const source of [windowsSwitch, macSwitch]) {
    let previousTheme = -1;
    for (const theme of publicThemes) {
      const location = source.indexOf(theme);
      assert.ok(location > previousTheme, `${theme} is missing or out of menu order`);
      previousTheme = location;
    }
    assert.doesNotMatch(source, /spark-atelier/);
  }
});
