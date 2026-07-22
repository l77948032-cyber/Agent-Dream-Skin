[CmdletBinding()]
param()

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
  try { $currentTrae = Get-TraeSkinInstall } catch {}
  if ($null -eq $state) {
    $orphanScanFailed = $false
    try { $orphanScan = Get-TraeSkinOrphanSessionScan } catch {
      $orphanScanFailed = $true
      $orphanScan = [pscustomobject]@{ Sessions = @(); StandaloneWatchers = @(); Unverified = @() }
    }
    $orphanSessions = @($orphanScan.Sessions)
    $standaloneWatchers = @($orphanScan.StandaloneWatchers)
    $unverifiedOrphans = @($orphanScan.Unverified)
    $orphan = if ($orphanSessions.Count -gt 0) { $orphanSessions[0] } else { $null }
    $standaloneWatcher = if ($standaloneWatchers.Count -gt 0) { $standaloneWatchers[0] } else { $null }
    $orphanWatcherAlive = $standaloneWatchers.Count -gt 0
    if ($null -ne $orphan) {
      $orphanWatcherAlive = $orphanWatcherAlive -or
        @(Get-TraeSkinOrphanWatcherProcesses -Session $orphan).Count -gt 0
    }
    $sessionStatus = if ($unverifiedOrphans.Count -gt 0) {
      'orphaned-unverified'
    } elseif ($orphanSessions.Count -gt 0 -or $standaloneWatchers.Count -gt 0) {
      'orphaned'
    } elseif ($stateUnreadable) {
      'unreadable'
    } elseif ($orphanScanFailed) {
      'unknown'
    } else {
      'off'
    }
    $normalTraeRunning = $false
    if ($null -ne $currentTrae) {
      $normalTraeRunning = (Get-TraeSkinApplicationProcesses -Trae $currentTrae).Count -gt 0
    }
    $orphanTrae = if ($null -ne $orphan) {
      $orphan.Trae
    } elseif ($null -ne $standaloneWatcher) {
      $standaloneWatcher.Trae
    } else {
      $currentTrae
    }
    $orphanPort = if ($null -ne $orphan) { [int]$orphan.Port } elseif ($null -ne $standaloneWatcher) { [int]$standaloneWatcher.Port } else { $null }
    [ordered]@{
      session = $sessionStatus
      phase = if ($null -ne $orphan -or $null -ne $standaloneWatcher) { 'orphan-recovery' } else { $null }
      installed = $null -ne $currentTrae
      traeRunning = [bool]($orphanSessions.Count -gt 0 -or $normalTraeRunning)
      recordedTraeAlive = $false
      themeId = $null
      port = $orphanPort
      injectorAlive = $orphanWatcherAlive
      endpointVerified = [bool]($null -ne $orphan -and $orphan.PortOwned -and $orphan.BrowserId)
      cdpOk = [bool]($null -ne $orphan -and $orphan.PortOwned)
      browserMatchesState = $false
      ownerMatchesState = $false
      launchIntentMatches = $orphanSessions.Count
      orphanCount = $orphanSessions.Count + $standaloneWatchers.Count
      standaloneOrphanWatcherCount = $standaloneWatchers.Count
      unverifiedOrphanCount = $unverifiedOrphans.Count
      stateUnreadable = $stateUnreadable
      healthy = $false
      traePid = if ($null -ne $orphan) { [int]$orphan.ProcessId } else { $null }
      orphanWatcherPid = if ($null -ne $standaloneWatcher) { [int]$standaloneWatcher.WatcherProcessId } else { $null }
      traeStartedAt = if ($null -ne $orphan) { "$($orphan.StartedAt)" } else { $null }
      traeExe = if ($null -ne $orphanTrae) { $orphanTrae.Executable } else { $null }
      traeVersion = if ($null -ne $orphanTrae) { $orphanTrae.Version } else { $null }
      hostProfile = if ($null -ne $orphanTrae) { $orphanTrae.HostProfile } else { $null }
      traeDisplayName = if ($null -ne $orphanTrae) { $orphanTrae.DisplayName } else { $null }
      publisher = if ($null -ne $orphanTrae) { $orphanTrae.PublisherSubject } else { $null }
    } | ConvertTo-Json -Depth 4
    return
  }
  $savedTrae = Get-TraeSkinInstallFromState -State $state
  $trae = if ($null -ne $state) { $savedTrae } else { $currentTrae }

  $recordedTraeAlive = $false
  $injectorAlive = $false
  $endpointVerified = $false
  $browserMatches = $false
  $ownerMatches = $false
  $cdpOk = $false
  $identity = $null
  $launchIntentMatches = 0
  if ($null -ne $state) {
    $injectorAlive = if ("$($state.session)" -eq 'active') {
      Test-TraeSkinRecordedInjectorIdentity -State $state
    } else {
      @(Get-TraeSkinOwnedInjectorProcesses -State $state).Count -gt 0
    }
    if ($null -ne $trae -and
      (Test-TraeSkinPathEqual -Left $trae.Executable -Right "$($state.traeExe)")) {
      if ([int]$state.traePid -gt 0 -and $state.traeStartedAt) {
        $recordedTraeAlive = Test-TraeSkinApplicationProcessIdentity -Trae $trae `
          -ProcessId ([int]$state.traePid) -StartedAt "$($state.traeStartedAt)"
      }
      if (-not $recordedTraeAlive -and "$($state.session)" -eq 'starting' -and
        (Test-TraeSkinLaunchToken -Value "$($state.launchToken)")) {
        $intentProcesses = @(Get-TraeSkinLaunchIntentProcesses -State $state -Trae $trae)
        $launchIntentMatches = $intentProcesses.Count
        if ($launchIntentMatches -eq 1) {
          $state.traePid = [int]$intentProcesses[0].ProcessId
          $state.traeStartedAt = "$($intentProcesses[0].StartedAt)"
          $recordedTraeAlive = $true
        }
      }
      $identity = Get-TraeSkinVerifiedCdpIdentity -Port ([int]$state.port) -Trae $trae
      $endpointVerified = $null -ne $identity
      if ($endpointVerified) {
        $browserMatches = if ($state.browserId) {
          $identity.BrowserId -ceq "$($state.browserId)"
        } else {
          "$($state.session)" -eq 'starting'
        }
        $ownerMatches = [int]$identity.OwnerProcessId -eq [int]$state.traePid -and
          "$($identity.OwnerStartedAt)" -eq "$($state.traeStartedAt)"
      }
      $cdpOk = $recordedTraeAlive -and
        (Test-TraeSkinCdpIdentityMatchesState -Identity $identity -State $state)
    }
  }

  $appRunning = $recordedTraeAlive
  if ($null -eq $state -and $null -ne $currentTrae) {
    $appRunning = (Get-TraeSkinApplicationProcesses -Trae $currentTrae).Count -gt 0
  }
  $result = [ordered]@{
    session = if ($null -ne $state) { "$($state.session)" } else { 'off' }
    phase = if ($null -ne $state) { "$($state.phase)" } else { $null }
    installed = $null -ne $currentTrae
    traeRunning = $appRunning
    recordedTraeAlive = $recordedTraeAlive
    themeId = if ($null -ne $state) { "$($state.themeId)" } else { $null }
    themeRevision = if ($null -ne $state -and $state.themeRevision) { "$($state.themeRevision)" } else { $null }
    port = if ($null -ne $state) { [int]$state.port } else { $null }
    injectorAlive = $injectorAlive
    endpointVerified = $endpointVerified
    cdpOk = $cdpOk
    browserMatchesState = $browserMatches
    ownerMatchesState = $ownerMatches
    launchIntentMatches = $launchIntentMatches
    orphanCount = 0
    standaloneOrphanWatcherCount = 0
    unverifiedOrphanCount = 0
    stateUnreadable = $false
    healthy = [bool]($null -ne $state -and "$($state.session)" -eq 'active' -and
      $injectorAlive -and $cdpOk)
    traePid = if ($null -ne $state) { [int]$state.traePid } else { $null }
    orphanWatcherPid = $null
    traeStartedAt = if ($null -ne $state) { "$($state.traeStartedAt)" } else { $null }
    traeExe = if ($null -ne $trae) { $trae.Executable } else { $null }
    traeVersion = if ($null -ne $trae) { $trae.Version } else { $null }
    hostProfile = if ($null -ne $trae) { $trae.HostProfile } else { $null }
    traeDisplayName = if ($null -ne $trae) { $trae.DisplayName } else { $null }
    publisher = if ($null -ne $trae) { $trae.PublisherSubject } else { $null }
  }
  $result | ConvertTo-Json -Depth 4
} finally {
  if ($null -ne $operationLock) { Exit-TraeSkinOperationLock -Mutex $operationLock }
}
