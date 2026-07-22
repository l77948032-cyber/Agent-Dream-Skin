[CmdletBinding()]
param(
  [int]$Port = 9342,
  [string]$Theme,
  [string]$Revision,
  [switch]$RestartExisting
)

$ErrorActionPreference = 'Stop'
$PortExplicit = $PSBoundParameters.ContainsKey('Port')
. (Join-Path $PSScriptRoot 'common-windows.ps1')

$Script:TraeSkinLastThemePath = Join-Path $Script:TraeSkinStateRoot 'last-theme'

function Read-TraeSkinLastTheme {
  if (-not (Test-Path -LiteralPath $Script:TraeSkinLastThemePath -PathType Leaf)) { return $null }
  try {
    $savedTheme = [System.IO.File]::ReadAllText(
      $Script:TraeSkinLastThemePath,
      [System.Text.Encoding]::UTF8
    ).Trim()
    if ($savedTheme -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { return $null }
    if (-not (Test-Path -LiteralPath (Join-Path $Script:TraeSkinThemesRoot "$savedTheme\theme.json") `
      -PathType Leaf)) { return $null }
    return $savedTheme
  } catch {
    return $null
  }
}

function Write-TraeSkinLastTheme {
  param([Parameter(Mandatory = $true)][string]$ThemeId)
  if ($ThemeId -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$') { return }
  try {
    Write-TraeSkinUtf8FileAtomically -Path $Script:TraeSkinLastThemePath -Content ($ThemeId + "`r`n")
  } catch {
    Write-Warning 'The last selected theme could not be saved.'
  }
}

$operationLock = $null
try {
  Assert-TraeSkinWindows
  Assert-TraeSkinPort -Port $Port
  if ($Revision -and $Revision -notmatch '^[a-f0-9]{64}$') {
    Fail-TraeSkin 'Invalid theme revision.'
  }
  $operationLock = Enter-TraeSkinOperationLock
  Ensure-TraeSkinStateRoot

  $currentTrae = Get-TraeSkinInstall
  $previousState = Read-TraeSkinState
  if ($PortExplicit -and $null -ne $previousState -and $Port -ne [int]$previousState.port) {
    Fail-TraeSkin 'Stop the active owned skin session before changing its CDP port.'
  }
  if (-not $PortExplicit -and $null -ne $previousState) { $Port = [int]$previousState.port }
  if (-not $Theme -and $null -ne $previousState) { $Theme = "$($previousState.themeId)" }
  if (-not $Theme) { $Theme = Read-TraeSkinLastTheme }
  if (-not $Theme) { $Theme = $Script:TraeSkinDefaultTheme }
  Assert-TraeSkinPort -Port $Port
  $themeInfo = Resolve-TraeSkinTheme -ThemeId $Theme
  $savedTrae = Get-TraeSkinInstallFromState -State $previousState

  $runtime = $null
  $trae = $currentTrae
  $cdpIdentity = $null
  $daemon = $null
  $newState = $null
  $launchedProcess = $null
  $launchToken = $null
  $sessionTraePid = 0
  $sessionTraeStartedAt = $null
  $mutationStarted = $false
  $reusedOwnedSession = $false
  $restartedExisting = $false
  $launchedWithCdp = $false
  $shouldRelaunchOnRollback = $false
  $previousInjectorStopped = $null -eq $previousState
  $existingApplicationStopped = $false

  try {
    if ($null -ne $previousState -and "$($previousState.session)" -eq 'starting' -and
      $null -ne $savedTrae) {
      $previousRecordedAlive = [int]$previousState.traePid -gt 0 -and
        (Test-TraeSkinApplicationProcessIdentity -Trae $savedTrae -ProcessId ([int]$previousState.traePid) `
          -StartedAt "$($previousState.traeStartedAt)")
      if (-not $previousRecordedAlive -and (Test-TraeSkinLaunchToken -Value "$($previousState.launchToken)")) {
        $intentProcesses = @(Get-TraeSkinLaunchIntentProcesses -State $previousState -Trae $savedTrae)
        if ($intentProcesses.Count -gt 1) {
          Fail-TraeSkin 'Multiple signed Trae processes matched the saved launch intent. State was preserved.'
        }
        if ($intentProcesses.Count -eq 1) {
          $previousState.traePid = [int]$intentProcesses[0].ProcessId
          $previousState.traeStartedAt = "$($intentProcesses[0].StartedAt)"
          $previousState | Add-Member -NotePropertyName phase -NotePropertyValue 'recovered' -Force
          $previousState | Add-Member -NotePropertyName updatedAt `
            -NotePropertyValue (Get-Date).ToUniversalTime().ToString('o') -Force
          Write-TraeSkinState -State $previousState
        }
      }
    }

    $savedIdentity = $null
    if ($null -ne $savedTrae) {
      $savedIdentity = Get-TraeSkinVerifiedCdpIdentity -Port $Port -Trae $savedTrae
    }
    $currentIdentity = $null
    if ($null -eq $savedTrae -or
      -not (Test-TraeSkinPathEqual -Left $savedTrae.Executable -Right $currentTrae.Executable)) {
      $currentIdentity = Get-TraeSkinVerifiedCdpIdentity -Port $Port -Trae $currentTrae
    }

    $existingIdentity = if ($null -ne $savedIdentity) { $savedIdentity } else { $currentIdentity }
    $existingTrae = if ($null -ne $savedIdentity) { $savedTrae } else { $currentTrae }
    if ($null -ne $existingIdentity) {
      if ($null -eq $previousState -or
        $null -eq $savedTrae -or
        -not (Test-TraeSkinPathEqual -Left $existingTrae.Executable -Right "$($previousState.traeExe)") -or
        -not (Test-TraeSkinCdpIdentityMatchesState -Identity $existingIdentity -State $previousState)) {
        Fail-TraeSkin "Port $Port is an existing Trae CDP session not owned by Trae Dream Skin."
      }
      $trae = $existingTrae
      $cdpIdentity = $existingIdentity
      $sessionTraePid = [int]$existingIdentity.OwnerProcessId
      $sessionTraeStartedAt = "$($existingIdentity.OwnerStartedAt)"
      $reusedOwnedSession = $true
      $shouldRelaunchOnRollback = $true
    } elseif (-not (Test-TraeSkinPortAvailable -Port $Port)) {
      if ($null -ne $previousState -or $PortExplicit) {
        Fail-TraeSkin "Port $Port is occupied by an unverified listener; existing state was preserved."
      }
      $Port = Select-TraeSkinPort -PreferredPort $Port
    }

    $savedRunning = $false
    if ($null -ne $savedTrae) {
      $savedRunning = (Get-TraeSkinApplicationProcesses -Trae $savedTrae).Count -gt 0
    }
    $currentRunning = (Get-TraeSkinApplicationProcesses -Trae $currentTrae).Count -gt 0
    $installsDiffer = $null -ne $savedTrae -and
      -not (Test-TraeSkinPathEqual -Left $savedTrae.Executable -Right $currentTrae.Executable)
    if ($installsDiffer -and $savedRunning -and $currentRunning) {
      Fail-TraeSkin 'Two signed Trae installations are active. Close both before starting the skin.'
    }

    $runningTrae = $null
    if ($savedRunning) { $runningTrae = $savedTrae }
    if ($currentRunning) { $runningTrae = $currentTrae }
    if (-not $reusedOwnedSession) {
      $trae = $currentTrae
      if ($null -ne $runningTrae -and -not $RestartExisting) {
        Fail-TraeSkin 'Trae is open without the owned skin CDP endpoint. Close it first or rerun with -RestartExisting.'
      }
    }

    # Probe the exact runtime before the first watcher or application mutation.
    $runtime = Get-TraeSkinNodeRuntime -Trae $trae
    $mutationStarted = $true
    Stop-TraeSkinRecordedInjector -State $previousState | Out-Null
    $previousInjectorStopped = $true

    if (-not $reusedOwnedSession) {
      if ($null -ne $runningTrae) {
        Write-Host 'Restarting Trae once to enable the owned loopback skin session...'
        $restartedExisting = $true
        $shouldRelaunchOnRollback = $true
        Stop-TraeSkinApplication -Trae $runningTrae -AllowForce
        $existingApplicationStopped = $true
      }

      $launchToken = [guid]::NewGuid().ToString('N')
    } elseif (Test-TraeSkinLaunchToken -Value "$($previousState.launchToken)") {
      $launchToken = "$($previousState.launchToken)"
    }

    $now = (Get-Date).ToUniversalTime().ToString('o')
    $createdAt = if ($null -ne $previousState -and $previousState.createdAt) {
      "$($previousState.createdAt)"
    } else {
      $now
    }
    $startedCdpHere = if ($reusedOwnedSession -and $previousState.startedCdpHere -is [bool]) {
      [bool]$previousState.startedCdpHere
    } else {
      $true
    }
    $newState = [pscustomobject]@{
      schemaVersion = 2
      platform = 'windows'
      session = 'starting'
      phase = if ($reusedOwnedSession) { 'starting-injector' } else { 'launching' }
      ownsSession = $true
      startedCdpHere = $startedCdpHere
      launchToken = $launchToken
      skinVersion = $Script:TraeSkinVersion
      port = $Port
      browserId = if ($reusedOwnedSession) { $cdpIdentity.BrowserId } else { $null }
      injectorPid = 0
      injectorStartedAt = $null
      injectorPath = $Script:TraeSkinInjector
      runtimePath = $runtime.Path
      nodeVersion = $runtime.Version
      traePid = if ($reusedOwnedSession) { $sessionTraePid } else { 0 }
      traeStartedAt = if ($reusedOwnedSession) { $sessionTraeStartedAt } else { $null }
      traeExe = $trae.Executable
      traeInstallRoot = $trae.InstallRoot
      traeVersion = $trae.Version
      traeProductName = $trae.ProductName
      hostProfile = $trae.HostProfile
      traePublisherSubject = $trae.PublisherSubject
      traePublisherThumbprint = $trae.PublisherThumbprint
      traeAppUserModelId = $trae.AppUserModelId
      projectRoot = $Script:TraeSkinProjectRoot
      themeId = $themeInfo.Id
      themeDir = $themeInfo.Directory
      themeRevision = if ($Revision) { $Revision } else { $null }
      createdAt = $createdAt
      updatedAt = $now
    }
    Write-TraeSkinState -State $newState

    if (-not $reusedOwnedSession) {
      Write-Host "Launching Trae with owned loopback CDP on port $Port..."
      $launchedProcess = Start-TraeSkinApplicationProcess -Trae $trae -Arguments @(
        '--remote-debugging-address=127.0.0.1',
        "--remote-debugging-port=$Port",
        "--trae-dream-skin-launch-token=$launchToken"
      )
      $launchedWithCdp = $true
      $shouldRelaunchOnRollback = $true
      $sessionTraePid = [int]$launchedProcess.Id
      try { $sessionTraeStartedAt = $launchedProcess.StartTime.ToUniversalTime().ToString('o') } catch {
        $sessionTraeStartedAt = Get-TraeSkinProcessStartedAt -ProcessId $sessionTraePid
      }
      if (-not $sessionTraeStartedAt) { Fail-TraeSkin 'The launched Trae PID start time could not be recorded.' }

      $newState.traePid = $sessionTraePid
      $newState.traeStartedAt = $sessionTraeStartedAt
      $newState.phase = 'waiting-for-cdp'
      $newState.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
      Write-TraeSkinState -State $newState

      $cdpIdentity = Wait-TraeSkinCdpIdentity -Port $Port -Trae $trae -TimeoutSeconds 45
      if ($null -eq $cdpIdentity) {
        Fail-TraeSkin "Trae did not expose a signed, process-owned loopback CDP endpoint on port $Port."
      }
      if ([int]$cdpIdentity.OwnerProcessId -ne $sessionTraePid -or
        "$($cdpIdentity.OwnerStartedAt)" -ne $sessionTraeStartedAt) {
        Fail-TraeSkin 'The CDP listener is not owned by the exact Trae process launched for this skin session.'
      }
    }

    $newState.browserId = $cdpIdentity.BrowserId
    $newState.phase = 'starting-injector'
    $newState.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-TraeSkinState -State $newState

    Remove-Item -LiteralPath $Script:TraeSkinStdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $Script:TraeSkinStderrPath -Force -ErrorAction SilentlyContinue
    $watchArguments = @(
      $Script:TraeSkinInjector,
      '--watch',
      '--port', "$Port",
      '--theme-dir', $themeInfo.Directory,
      '--browser-id', $cdpIdentity.BrowserId
    )
    if (Test-TraeSkinLaunchToken -Value $launchToken) {
      $watchArguments += @('--owner-token', $launchToken)
    }
    $daemon = Start-TraeSkinNodeProcess -Trae $trae -Runtime $runtime -NodeArguments $watchArguments `
      -StandardOutput $Script:TraeSkinStdoutPath -StandardError $Script:TraeSkinStderrPath
    $injectorStartedAt = Get-TraeSkinProcessStartedAt -ProcessId $daemon.Id
    if (-not $injectorStartedAt) { Fail-TraeSkin 'The injector PID start time could not be recorded.' }
    $newState.injectorPid = [int]$daemon.Id
    $newState.injectorStartedAt = $injectorStartedAt
    $newState.phase = 'applying'
    $newState.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-TraeSkinState -State $newState
    Start-Sleep -Milliseconds 700
    if ($daemon.HasExited) { Fail-TraeSkin "The injector exited during startup. See $Script:TraeSkinStderrPath" }

    $onceArguments = @($runtime.PrefixArguments) + @(
      $Script:TraeSkinInjector,
      '--once',
      '--port', "$Port",
      '--theme-dir', $themeInfo.Directory,
      '--browser-id', $cdpIdentity.BrowserId,
      '--timeout-ms', '30000'
    )
    Invoke-TraeSkinNode -Trae $trae -NodeArguments $onceArguments *> $null
    if ($Script:TraeSkinLastNodeExitCode -ne 0) { Fail-TraeSkin 'The initial theme injection failed.' }

    $verifyArguments = @($runtime.PrefixArguments) + @(
      $Script:TraeSkinInjector,
      '--verify',
      '--port', "$Port",
      '--theme-dir', $themeInfo.Directory,
      '--browser-id', $cdpIdentity.BrowserId,
      '--timeout-ms', '30000'
    )
    $verifyOutput = @(Invoke-TraeSkinNode -Trae $trae -NodeArguments $verifyArguments 2>&1)
    $verifyExitCode = $Script:TraeSkinLastNodeExitCode
    Write-TraeSkinUtf8FileAtomically -Path $Script:TraeSkinVerifyPath `
      -Content (($verifyOutput -join "`r`n") + "`r`n")
    if ($verifyExitCode -ne 0) { Fail-TraeSkin "Theme verification failed. See $Script:TraeSkinVerifyPath" }

    $confirmedIdentity = Get-TraeSkinVerifiedCdpIdentity -Port $Port -Trae $trae
    if (-not (Test-TraeSkinCdpIdentityMatchesState -Identity $confirmedIdentity -State $newState)) {
      Fail-TraeSkin 'The owned CDP process or browser identity changed during startup.'
    }
    if (-not (Test-TraeSkinRecordedInjectorIdentity -State $newState)) {
      Fail-TraeSkin 'The persistent injector identity changed during startup.'
    }
    $newState.session = 'active'
    $newState.phase = 'active'
    $newState.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-TraeSkinState -State $newState
  } catch {
    $startupError = $_
    if ($mutationStarted) {
      if (-not $previousInjectorStopped) {
        Write-Warning 'The previous injector could not be stopped safely; its owned state was preserved.'
        throw $startupError
      }
      $cleanupComplete = $true
      if ($restartedExisting -and -not $existingApplicationStopped) { $cleanupComplete = $false }
      if ($null -ne $newState) {
        try { Stop-TraeSkinRecordedInjector -State $newState | Out-Null } catch {
          $cleanupComplete = $false
          Write-Warning $_.Exception.Message
        }
      } elseif ($null -ne $daemon -and -not $daemon.HasExited) {
        try { Stop-Process -Id $daemon.Id -Force -ErrorAction Stop } catch {
          $cleanupComplete = $false
          Write-Warning 'The failed injector could not be stopped.'
        }
        if (Get-Process -Id $daemon.Id -ErrorAction SilentlyContinue) { $cleanupComplete = $false }
      }

      if ($sessionTraePid -le 0 -and $null -ne $newState -and
        (Test-TraeSkinLaunchToken -Value "$($newState.launchToken)")) {
        try {
          $rollbackIntentProcesses = @(Get-TraeSkinLaunchIntentProcesses -State $newState -Trae $trae)
          if ($rollbackIntentProcesses.Count -eq 1) {
            $sessionTraePid = [int]$rollbackIntentProcesses[0].ProcessId
            $sessionTraeStartedAt = "$($rollbackIntentProcesses[0].StartedAt)"
          } elseif ($rollbackIntentProcesses.Count -gt 1) {
            $cleanupComplete = $false
            Write-Warning 'Startup rollback found multiple processes matching its launch intent.'
          }
        } catch {
          $cleanupComplete = $false
          Write-Warning 'Startup rollback could not resolve its saved launch intent.'
        }
      }

      if ($sessionTraePid -gt 0 -and $sessionTraeStartedAt) {
        try {
          $rollbackIdentity = Get-TraeSkinVerifiedCdpIdentity -Port $Port -Trae $trae
          if ($null -ne $rollbackIdentity -and
            [int]$rollbackIdentity.OwnerProcessId -eq $sessionTraePid -and
            "$($rollbackIdentity.OwnerStartedAt)" -eq $sessionTraeStartedAt -and
            $null -ne $cdpIdentity -and
            $rollbackIdentity.BrowserId -ceq $cdpIdentity.BrowserId) {
            $removeArguments = @($runtime.PrefixArguments) + @(
              $Script:TraeSkinInjector, '--remove', '--port', "$Port",
              '--theme-dir', $themeInfo.Directory, '--browser-id', $cdpIdentity.BrowserId,
              '--timeout-ms', '5000'
            )
            Invoke-TraeSkinNode -Trae $trae -NodeArguments $removeArguments *> $null
          }
        } catch { Write-Warning 'The partially applied live skin could not be removed before rollback.' }

        try {
          Stop-TraeSkinRecordedApplication -Trae $trae -ProcessId $sessionTraePid `
            -StartedAt $sessionTraeStartedAt -AllowForce
        } catch {
          $cleanupComplete = $false
          Write-Warning $_.Exception.Message
        }
      } elseif ($launchedWithCdp -and $null -ne $launchedProcess -and -not $launchedProcess.HasExited) {
        try { Stop-Process -InputObject $launchedProcess -Force -ErrorAction Stop } catch {
          $cleanupComplete = $false
          Write-Warning 'The launched Trae process could not be stopped during rollback.'
        }
        try { Wait-Process -InputObject $launchedProcess -Timeout 5 -ErrorAction Stop } catch {}
        if (-not $launchedProcess.HasExited) { $cleanupComplete = $false }
      }

      try {
        if (-not (Wait-TraeSkinPortAvailable -Port $Port -TimeoutSeconds 6)) {
          $cleanupComplete = $false
          Write-Warning "Port $Port remained active during startup rollback."
        }
      } catch {
        $cleanupComplete = $false
        Write-Warning "Port $Port could not be verified during startup rollback."
      }
      if ($cleanupComplete) {
        try {
          if (Test-Path -LiteralPath $Script:TraeSkinStatePath -PathType Leaf) {
            Remove-Item -LiteralPath $Script:TraeSkinStatePath -Force -ErrorAction Stop
          }
        } catch {
          $cleanupComplete = $false
          Write-Warning 'The stopped session state could not be removed.'
        }
      }
      if ($cleanupComplete -and $shouldRelaunchOnRollback) {
        try { Start-TraeSkinNormally -Trae $currentTrae } catch {
          Write-Warning 'Startup rollback could not reopen Trae without CDP.'
        }
      } elseif (-not $cleanupComplete) {
        Write-Warning 'Startup rollback was incomplete; ownership state was preserved when available.'
      }
    }
    throw $startupError
  }

  Write-TraeSkinLastTheme -ThemeId $themeInfo.Id
  Write-Host "Trae Dream Skin $Script:TraeSkinVersion is active: theme=$($themeInfo.Id) port=$Port"
} finally {
  if ($null -ne $operationLock) { Exit-TraeSkinOperationLock -Mutex $operationLock }
}
