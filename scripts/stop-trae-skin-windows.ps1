[CmdletBinding()]
param(
  [switch]$NoRelaunch
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common-windows.ps1')

$operationLock = $null
try {
  Assert-TraeSkinWindows
  $operationLock = Enter-TraeSkinOperationLock
  $stateFilePresent = Test-Path -LiteralPath $Script:TraeSkinStatePath -PathType Leaf
  $stateUnreadable = $false
  $state = $null
  try { $state = Read-TraeSkinState } catch { $stateUnreadable = $stateFilePresent }
  $currentTrae = $null
  try { $currentTrae = Get-TraeSkinInstall } catch { Write-Warning $_.Exception.Message }
  if ($null -eq $state) {
    try { $orphanScan = Get-TraeSkinOrphanSessionScan } catch {
      Fail-TraeSkin 'Orphan discovery could not complete; no process or state was changed.'
    }
    $orphanSessions = @($orphanScan.Sessions)
    $standaloneWatchers = @($orphanScan.StandaloneWatchers)
    $unverifiedOrphans = @($orphanScan.Unverified)
    if ($unverifiedOrphans.Count -gt 0) {
      Fail-TraeSkin 'A dedicated skin launch marker was found without a unique signed process identity; nothing was stopped.'
    }
    if ($orphanSessions.Count -eq 0 -and $standaloneWatchers.Count -eq 0) {
      if ($stateUnreadable) {
        Fail-TraeSkin 'State is unreadable and no uniquely verified orphan session was found; the state file was preserved.'
      }
      Write-Host 'Trae Dream Skin is already off; no recorded or token-matched CDP session was found.'
      return
    }

    foreach ($orphan in $orphanSessions) {
      Stop-TraeSkinOrphanSession -Session $orphan | Out-Null
    }
    foreach ($standaloneWatcher in $standaloneWatchers) {
      if (-not (Stop-TraeSkinOrphanWatchers -Session $standaloneWatcher)) {
        Fail-TraeSkin 'A uniquely token-matched standalone orphan injector could not be stopped.'
      }
      if (-not (Wait-TraeSkinPortAvailable -Port ([int]$standaloneWatcher.Port) -TimeoutSeconds 2)) {
        Fail-TraeSkin 'A standalone orphan injector port became active during cleanup; no listener was stopped.'
      }
    }
    if ($stateFilePresent) {
      Remove-Item -LiteralPath $Script:TraeSkinStatePath -Force -ErrorAction Stop
    }
    if ($orphanSessions.Count -gt 0 -and -not $NoRelaunch) {
      $relaunchTrae = if ($null -ne $currentTrae) { $currentTrae } else { $orphanSessions[0].Trae }
      Start-TraeSkinNormally -Trae $relaunchTrae
    }
    $orphanCount = $orphanSessions.Count + $standaloneWatchers.Count
    Write-Host "Trae Dream Skin is fully off; recovered and closed $orphanCount token-matched orphan session(s)."
    return
  }

  $savedTrae = Get-TraeSkinInstallFromState -State $state
  $port = [int]$state.port
  Assert-TraeSkinPort -Port $port
  $themeDirectory = "$($state.themeDir)"
  $injectorPath = "$($state.injectorPath)"

  $trae = $savedTrae
  if ($null -eq $trae) {
    if ("$($state.session)" -eq 'starting' -and
      (Test-TraeSkinLaunchToken -Value "$($state.launchToken)")) {
      Fail-TraeSkin 'The signed executable for a recoverable starting intent is unavailable; state was preserved.'
    }
    $savedPidStillActive = $false
    if ([int]$state.traePid -gt 0 -and $state.traeStartedAt) {
      $savedPidStartedAt = Get-TraeSkinProcessStartedAt -ProcessId ([int]$state.traePid)
      $savedPidStillActive = $savedPidStartedAt -eq "$($state.traeStartedAt)"
    }
    if ($savedPidStillActive) {
      Fail-TraeSkin 'The saved publisher identity is unavailable while the recorded Trae PID is still active. State was preserved.'
    }
    if (-not (Test-TraeSkinPortAvailable -Port $port)) {
      Fail-TraeSkin 'The saved signed Trae executable is unavailable while its port is still active. State was preserved.'
    }
    if (-not (Stop-TraeSkinOwnedInjectors -State $state)) {
      Fail-TraeSkin 'A confirmed owned injector is still active. State was preserved.'
    }
    Remove-Item -LiteralPath $Script:TraeSkinStatePath -Force -ErrorAction Stop
    Write-Host 'Removed stale skin state; no owned process or live CDP endpoint remained.'
    return
  }

  $recordedAlive = $false
  if ([int]$state.traePid -gt 0 -and $state.traeStartedAt) {
    $recordedAlive = Test-TraeSkinApplicationProcessIdentity -Trae $trae `
      -ProcessId ([int]$state.traePid) -StartedAt "$($state.traeStartedAt)"
  }
  if (-not $recordedAlive -and "$($state.session)" -eq 'starting' -and
    (Test-TraeSkinLaunchToken -Value "$($state.launchToken)")) {
    $intentProcesses = @(Get-TraeSkinLaunchIntentProcesses -State $state -Trae $trae)
    if ($intentProcesses.Count -gt 1) {
      Fail-TraeSkin 'Multiple signed Trae processes matched the saved launch intent. State was preserved.'
    }
    if ($intentProcesses.Count -eq 1) {
      $state.traePid = [int]$intentProcesses[0].ProcessId
      $state.traeStartedAt = "$($intentProcesses[0].StartedAt)"
      $state | Add-Member -NotePropertyName phase -NotePropertyValue 'stopping' -Force
      $state | Add-Member -NotePropertyName updatedAt `
        -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o') -Force
      Write-TraeSkinState -State $state
      $recordedAlive = $true
    }
  }

  $cdpIdentity = $null
  if (-not (Test-TraeSkinPortAvailable -Port $port)) {
    $cdpIdentity = Get-TraeSkinVerifiedCdpIdentity -Port $port -Trae $trae
    if ($null -ne $cdpIdentity) {
      if (-not $recordedAlive -or
        -not (Test-TraeSkinCdpIdentityMatchesState -Identity $cdpIdentity -State $state)) {
        Fail-TraeSkin 'The live CDP browser or process does not match the recorded skin session. State was preserved.'
      }
    } else {
      $listenerOwner = Get-TraeSkinPortOwnerIdentity -Port $port -Trae $trae
      if (-not $recordedAlive -or $null -eq $listenerOwner -or
        [int]$listenerOwner.ProcessId -ne [int]$state.traePid -or
        "$($listenerOwner.StartedAt)" -ne "$($state.traeStartedAt)") {
        Fail-TraeSkin 'The recorded port is occupied by a process outside the owned Trae session. State was preserved.'
      }
      Write-Warning 'The owned CDP endpoint did not answer verification; closing only its recorded Trae process.'
    }
  }

  $runtime = $null
  if ($null -ne $cdpIdentity) {
    try { $runtime = Get-TraeSkinNodeRuntime -Trae $trae } catch {
      Write-Warning 'The embedded Node runtime is unavailable; closing the recorded process will still clear the skin.'
    }
  }

  if (-not (Stop-TraeSkinOwnedInjectors -State $state)) {
    Write-Warning 'A confirmed owned injector did not stop yet; the exact Trae session will still be closed.'
  }
  if ($null -ne $cdpIdentity -and $null -ne $runtime) {
    $removeArguments = @($runtime.PrefixArguments) + @(
      $injectorPath,
      '--remove',
      '--port', "$port",
      '--theme-dir', $themeDirectory,
      '--browser-id', $cdpIdentity.BrowserId,
      '--timeout-ms', '10000'
    )
    Invoke-TraeSkinNode -Trae $trae -NodeArguments $removeArguments *> $null
    if ($Script:TraeSkinLastNodeExitCode -ne 0) {
      Write-Warning 'Live DOM cleanup failed; closing the recorded Trae process will still clear the injected skin.'
    }
  }

  $wasRunning = $recordedAlive
  if ($recordedAlive) {
    Stop-TraeSkinRecordedApplication -Trae $trae -ProcessId ([int]$state.traePid) `
      -StartedAt "$($state.traeStartedAt)" -AllowForce
  }
  if ([int]$state.traePid -gt 0 -and $state.traeStartedAt -and
    (Test-TraeSkinApplicationProcessIdentity -Trae $trae -ProcessId ([int]$state.traePid) `
      -StartedAt "$($state.traeStartedAt)")) {
    Fail-TraeSkin 'The exact recorded Trae process is still active. State was preserved.'
  }
  if (-not (Wait-TraeSkinPortAvailable -Port $port -TimeoutSeconds 6)) {
    Fail-TraeSkin "Port $port is still listening after the recorded Trae session closed. State was preserved."
  }
  if (-not (Stop-TraeSkinOwnedInjectors -State $state)) {
    Fail-TraeSkin 'A confirmed owned injector remained after Trae closed. State was preserved.'
  }

  Remove-Item -LiteralPath $Script:TraeSkinStatePath -Force -ErrorAction Stop
  if ($wasRunning -and -not $NoRelaunch) {
    $relaunchTrae = if ($null -ne $currentTrae) { $currentTrae } else { $trae }
    Start-TraeSkinNormally -Trae $relaunchTrae
  }
  Write-Host 'Trae Dream Skin is fully off; the exact owned UI and CDP session were removed.'
} finally {
  if ($null -ne $operationLock) { Exit-TraeSkinOperationLock -Mutex $operationLock }
}
