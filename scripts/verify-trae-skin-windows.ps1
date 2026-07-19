[CmdletBinding()]
param(
  [string]$ScreenshotPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common-windows.ps1')

$operationLock = $null
$verifyExitCode = 1
try {
  Assert-TraeSkinWindows
  $operationLock = Enter-TraeSkinOperationLock
  $state = Read-TraeSkinState
  if ($null -eq $state) { Fail-TraeSkin 'No active skin state was found.' }
  if ("$($state.session)" -ne 'active') {
    Fail-TraeSkin 'The skin session is still starting; use status or stop it before verification.'
  }
  $port = [int]$state.port
  Assert-TraeSkinPort -Port $port
  $themeDirectory = "$($state.themeDir)"
  $injectorPath = "$($state.injectorPath)"
  if (-not (Test-Path -LiteralPath $injectorPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $themeDirectory 'theme.json') -PathType Leaf)) {
    Fail-TraeSkin 'The injector or theme recorded by the active session is unavailable.'
  }

  $savedTrae = Get-TraeSkinInstallFromState -State $state
  $trae = $savedTrae
  if ($null -eq $trae) { Fail-TraeSkin 'The recorded signed Trae executable is unavailable.' }
  if (-not (Test-TraeSkinApplicationProcessIdentity -Trae $trae -ProcessId ([int]$state.traePid) -StartedAt "$($state.traeStartedAt)")) {
    Fail-TraeSkin 'The recorded Trae PID and start time are no longer active.'
  }
  if (-not (Test-TraeSkinRecordedInjectorIdentity -State $state)) {
    Fail-TraeSkin 'The recorded persistent injector identity is no longer active.'
  }

  $identity = Get-TraeSkinVerifiedCdpIdentity -Port $port -Trae $trae
  if (-not (Test-TraeSkinCdpIdentityMatchesState -Identity $identity -State $state)) {
    Fail-TraeSkin 'The live CDP browser, listener PID, or listener start time does not match the recorded skin session.'
  }

  $runtime = Get-TraeSkinNodeRuntime -Trae $trae
  $arguments = @($runtime.PrefixArguments) + @(
    $injectorPath,
    '--verify',
    '--port', "$port",
    '--theme-dir', $themeDirectory,
    '--browser-id', $identity.BrowserId,
    '--timeout-ms', '30000'
  )
  if ($ScreenshotPath) {
    $fullScreenshotPath = [System.IO.Path]::GetFullPath($ScreenshotPath)
    $arguments += @('--screenshot', $fullScreenshotPath)
  }
  $output = @(Invoke-TraeSkinNode -Trae $trae -NodeArguments $arguments 2>&1)
  $verifyExitCode = $Script:TraeSkinLastNodeExitCode
  Write-TraeSkinUtf8FileAtomically -Path $Script:TraeSkinVerifyPath -Content (($output -join "`r`n") + "`r`n")
  $output | ForEach-Object { Write-Output $_ }

  if ($verifyExitCode -eq 0) {
    $confirmedIdentity = Get-TraeSkinVerifiedCdpIdentity -Port $port -Trae $trae
    if (-not (Test-TraeSkinCdpIdentityMatchesState -Identity $confirmedIdentity -State $state) -or
      -not (Test-TraeSkinRecordedInjectorIdentity -State $state)) {
      Fail-TraeSkin 'The owned Trae or injector identity changed during verification.'
    }
  }
} finally {
  if ($null -ne $operationLock) { Exit-TraeSkinOperationLock -Mutex $operationLock }
}
exit $verifyExitCode
